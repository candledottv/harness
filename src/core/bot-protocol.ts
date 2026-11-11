// The bot protocol: what a code bot asks the core for, over the core's socket, with its bot token. A bot trades only
// through here, and every trade is the core's own proposal with the bot's approved run settings (bot-trades.ts).
//
// - **Its own request ids.** Each buy, sell or swap carries the bot's own id (`request`). The core records it before
//   anything is proposed (`bot.request`), and the same id asked again answers what became of it: nothing is sent
//   twice for one id, whether the bot lost the answer, its connection dropped, or the core restarted. A request the
//   core recorded but never sent before it stopped ends as lost, said in words.
// - **Its figures.** A buy is over none of its card's figures: a trade's, a day's (its buys and swaps since local
//   midnight, counted as soon as each is recorded, so two at once can't pass the figure together) and open at most
//   (its open positions and buys under way). A swap is valued as its card is, and held to the same two dollar figures.
//   Its mode, wallet, slippage and agent are its card's: a request naming any of them is refused.
// - **Its wallet, by side.** A buy or swap follows its wallet: inside the wallet's figures it runs with a receipt; over
//   them, or on a wallet that asks every time, it's a card that waits for the person, and the bot hears how it ended.
//   Its sells of its own positions run with no card on any wallet, approved as `bot-exit`.
// - **Sells only its own.** A sell names one of its open positions, or a token it holds (its oldest position in it),
//   and a part of it by percent or amount. Over what it holds, it sells what it holds and says so. On a wallet others
//   trade from, it sells its own share (bot-book.ts `sellPlan`).
// - **The rules every bot keeps:** the kill switch holds its buys and swaps; Candle's breaker is kept clear of (the
//   pace, failing routes, two failed sells of a token holding the third); a paused bot buys nothing.
// - **Exits the core holds.** A buy may carry exits (a take profit, a stop, a max hold, a trailing stop), and
//   `bot.exits` sets, changes or clears them on a position it holds. The core watches them with the rules bots' exit
//   machinery (bot-exits.ts, held-exits.ts) while the bot is paused, crashed or not connected, and through the kill
//   switch, and tells the bot when one fires and how its sell ended.
// - **Reads:** its own book from the core's count, Candle's market read (not counted toward a key's limit, reused for
//   4.5 s), and Hacc's reads its agent's plan offers, with its agent's key. Never another bot's or agent's.
// - **Told what happens to it:** each request's outcome, its state (paused, resumed, held), the kill switch, and the
//   core stopping, on the `bot` topic, to its own connection only.
import { sameAddress } from "../shared/address-key"
import { BASE_ASSETS, fromRaw, isBaseAsset, spentSymbol, toRaw } from "./assets"
import { type Exit, readHeldExit } from "../shared/definition"
import { exitWords } from "../shared/definition-words"
import { refused } from "../shared/rpc"
import type { BotPosition, BotPositions } from "./bot-book"
import { EXIT_WORDS } from "./bot-exits"
import { botClient, type BotRun } from "./bot-trades"
import type { Card, Holding } from "./cards"
import type { ToolOutcome } from "./candle-mcp"
import type { CodeBotBook, CodeRunSettings } from "./code-bots"
import { type Fill, fillOfRow } from "./fill"
import type { Journal, JournalRow } from "./journal"
import { startOfLocalDay, usd } from "./limits"
import type { HeldBy } from "./held-exits"
import type { FaceClient } from "./tool-face"
import { short } from "./wallet-names"
import { addressKey, type ChainSlug, enabledChains, familyOfAddress, isAddressOn, maybeChain, requestChain, storedChain } from "../shared/chains"

/** A request id: the bot's own, 8 to 64 letters, digits, `_` or `-`. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/
/** A market read this fresh is used as it is. */
export const BOT_MARKET_REUSE_MS = 4_500
/** The same refusal of one bot is journalled at most this often: a bot in a loop can't fill the journal. */
const REFUSED_ROW_MS = 60_000
/** Requests kept per bot in memory once ended, newest last: older ones are read back from the journal at start only. */
const ENDED_KEPT = 500
/** The run settings a request may never name: they're its card's. */
const FIXED = ["mode", "paper", "wallet", "maxSlippageBps", "slippageBps", "agent", "clientTradeId", "clientSwapId"] as const

export type RequestState = "pending" | "waiting" | "sent" | "filled" | "refused" | "rejected" | "withdrawn" | "expired" | "failed" | "lost"
const ENDED: ReadonlySet<RequestState> = new Set(["filled", "refused", "rejected", "withdrawn", "expired", "failed", "lost"])

interface BotRequest {
  request: string
  bot: string
  agent: string
  side: "buy" | "sell" | "swap"
  mode: "paper" | "live"
  at: number
  mint?: string
  /** What its buy or swap spends, in dollars: a buy's stake, a swap's value once its card has one. */
  usd?: number
  position?: string
  state: RequestState
  words: string
  code?: string
  cardId?: string
  opId?: string
  /** A paper trade's row, `paper:<seq>`. */
  paperId?: string
  approved?: boolean
  fill?: FillShort
  /** Said with its outcome: it asked for more than it holds, or the wallet held less than its own. */
  note?: string
  /** Its card was withdrawn because it was over a figure: it ends as refused, with why. */
  refusedBy?: { code: string; words: string }
}

/** What a fill was, for the bot: what it spent or received, in the token and the pair asset. */
export interface FillShort {
  side: "buy" | "sell" | "swap"
  mint?: string
  /** Tokens it bought or sold, as a decimal, where Candle said. */
  tokens?: string
  asset?: string
  /** The pair asset it spent or received, as a decimal, where Candle said. */
  assetAmount?: string
  usd?: number
  at: string
}

/** A request's outcome, as the bot reads it. */
export interface RequestAnswer {
  request: string
  side: "buy" | "sell" | "swap"
  state: RequestState
  words: string
  code?: string
  mint?: string
  usd?: number
  position?: string
  cardId?: string
  fill?: FillShort
}

/** How an exit the core holds for a bot went: deciding to sell, waiting, sold, or ended with nothing sold. */
export type ExitState = "selling" | "waiting" | "held" | "sold" | "failed" | "refused" | "rejected" | "withdrawn" | "expired" | "lost" | "left"

/** An exit the core held, told to its bot. */
export interface ExitTold {
  position: string
  mint: string
  state: ExitState
  /** Which exit: stop_loss, take_profit, trailing_stop or max_hold. */
  reason?: string
  words: string
  fill?: FillShort
}

/** What the core tells a bot, on the `bot` topic. */
export type BotTold =
  | ({ kind: "request" } & RequestAnswer)
  | ({ kind: "exit" } & ExitTold)
  | { kind: "exits"; position: string; mint: string; exits: null; by: "person"; words: string }
  | { kind: "state"; state: "on" | "paused" | "stopped"; buys: boolean; sells: boolean; words?: string; held?: { code: string; words: string } }
  | { kind: "kill"; paused: boolean; words: string }
  | { kind: "stopping"; words: string }

export interface CodeBotDeskDeps {
  codeBots: Pick<CodeBotBook, "entry" | "runs" | "approvedVersion" | "heldBy" | "viewOf"> & Partial<Pick<CodeBotBook, "testSince">>
  positions: Pick<BotPositions, "open" | "of" | "get" | "sellPlan" | "noteDecimals" | "remainingRaw" | "entryPriceUsd" | "totals" | "realizedUsd">
  journal: Pick<Journal, "append">
  now(): number
  /** The kill switch: its pause holds every bot's buys and swaps. */
  paused(): boolean
  /** Candle's breaker for a bot's trade on a key now (bot-trades.ts `room`): what holds it, or room with its slot taken. */
  room(agent: string, mint: string | undefined, side: "buy" | "sell" | "swap", label: string): { why: "pace" | "route"; until: number; words: string } | undefined
  /** Two failed sells of a token on a key hold the third. */
  failed: { held(agent: string, mint: string): boolean; words(agent: string, label: string): string }
  /** The bot's trade, as its own (bot-trades.ts `send`). */
  send(trade: { tool: string; args: Record<string, unknown> }, client: FaceClient, mode: "paper" | "live", reason: string, check?: (card: Card) => { code: string; words: string } | undefined): Promise<unknown>
  /** What a live wallet holds of a token now, on the position's chain: "embedded" is that chain's embedded wallet. */
  holding(agent: string, wallet: string, mint: string, chain: ChainSlug): Promise<Holding>
  /**
   * The payer's words where a live bot's wallet is on another chain than the token (a TEE wallet is on one); undefined
   * where it pays there, or that isn't known yet.
   */
  wrongChain?(agent: string, wallet: string, chain: ChainSlug): string | undefined
  /** A token's decimals where the core knows them. */
  decimalsOf(mint: string): number | undefined
  /** Whether a sell of the token from this wallet goes by an exact amount (a TEE wallet, a token Candle gives decimals for). */
  byAmount(wallet: string, mint: string): boolean
  /** Candle's market read, not counted toward a key's limit; undefined when no key can make it. */
  market(chain: ChainSlug, mint: string): Promise<ToolOutcome | undefined>
  /** A card, as it is now. */
  card(cardId: string): Card | undefined
  /** A token's name for words, where the core knows one. */
  nameOf(mint: string): string | undefined
  /** Tells a bot something, on its own connection. */
  tell(bot: string, told: BotTold): void
  /** The exits the core holds on a position, and who set them. Unset: none are held. */
  heldExits?(position: string): { exit: Exit; by: HeldBy } | undefined
  /** One of the core's held exits is selling the position now. */
  exitUnderWay?(position: string): boolean
  /** How many ended requests a bot keeps in memory: a few hundred. Tests lower it. */
  endedKept?: number
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const cents = (n: number) => Math.round(n * 100) / 100
const errorOf = (e: unknown): { code?: string; message: string } => {
  const x = e as { code?: unknown; message?: unknown; data?: { code?: unknown } } | undefined
  const code = typeof x?.data?.code === "string" ? x.data.code : typeof x?.code === "string" ? x.code : undefined
  return { ...(code ? { code } : {}), message: typeof x?.message === "string" ? x.message : "the core refused it" }
}

export class CodeBotDesk {
  private readonly requests = new Map<string, BotRequest>()
  private readonly markets = new Map<string, { at: number; outcome: ToolOutcome }>()
  private readonly refusedAt = new Map<string, number>()
  private readonly told = new Map<string, string>()
  /** Each held exit under way, by position: its token and which exit, from its `bot.exiting` row. */
  private readonly exitsUnder = new Map<string, { mint: string; reason?: string }>()
  /** Sells of held exits sent to Candle, by operation id: the bot and position each sells for. */
  private readonly exitOps = new Map<string, { bot: string; position: string }>()
  /** Fills of held exits, newest last, per bot: listed with its own fills. */
  private readonly exitFills = new Map<string, (FillShort & { position: string; exit?: string })[]>()
  private rebuilding = false
  /** Positions a sell is being planned for: taken before the wallet's balance is read, so a second sell at once is refused. */
  private readonly selling = new Set<string>()
  /** Sells being planned, by request: the same id asked again meanwhile gets the first one's answer. */
  private readonly asking = new Map<string, Promise<RequestAnswer>>()
  /** Ids of ended requests let go from memory, per bot: each traded or ended once, so it's never free again. */
  private readonly spent = new Map<string, Set<string>>()
  /** When a bot of each name was last removed: a bot saved under the name afterwards counts none of its day. */
  private readonly removedAt = new Map<string, number>()

  constructor(private readonly deps: CodeBotDeskDeps) {}

  /**
   * A test run ended: each of its requests still waiting on Candle's first answer is ended as lost, so none holds the
   * next test's open figure. A paper fill that comes after still books its position, and says so to nobody: the test
   * has ended. Answers each one let go, as "buy of JUP".
   */
  async letGo(bot: string): Promise<string[]> {
    const gone: string[] = []
    for (const r of [...this.requests.values()]) {
      if (r.bot !== bot || r.state !== "pending" || r.cardId || r.opId) continue
      gone.push(`${r.side}${r.mint ? ` of ${this.label(r.mint)}` : ""}`)
      await this.ended(r, "lost", "its test ended before Candle answered it, so it was let go")
    }
    return gone
  }

  /** The journal's rows at start, oldest first: each request and what became of it. One recorded but never sent is lost. */
  async rebuild(rows: readonly JournalRow[]): Promise<void> {
    this.rebuilding = true
    try {
      for (const row of rows) this.note(row)
    } finally {
      this.rebuilding = false
    }
    for (const r of [...this.requests.values()]) {
      if (r.state !== "pending" || r.cardId || r.opId || r.paperId) continue
      await this.ended(r, "lost", "the core stopped before it was sent, so nothing was sent")
    }
  }

  /** A journal row, as it's appended: a request recorded, its card and operation, its fill or its end. */
  note(row: JournalRow): void {
    if (this.exitRow(row)) return
    if (row.type === "bot.request" && row.kind === "code" && typeof row.name === "string" && typeof row.request === "string") {
      const key = keyOf(row.name, row.request)
      if (this.requests.has(key)) return
      this.requests.set(key, {
        request: row.request,
        bot: row.name,
        agent: String(row.agent ?? ""),
        side: row.side === "sell" ? "sell" : row.side === "swap" ? "swap" : "buy",
        mode: row.botMode === "paper" ? "paper" : "live",
        at: Date.parse(row.at),
        ...(typeof row.mint === "string" ? { mint: row.mint } : {}),
        ...(typeof row.usd === "number" ? { usd: row.usd } : {}),
        ...(typeof row.position === "string" ? { position: row.position } : {}),
        ...(typeof row.note === "string" ? { note: row.note } : {}),
        state: "pending",
        words: typeof row.words === "string" ? row.words : "",
      })
      return
    }
    // A removed bot's requests are its own: a bot saved under its name later starts its day at zero, and its ids are
    // new ones. One still on its way keeps its place until it ends.
    if (row.type === "bot.removed" && typeof row.name === "string") {
      this.removedAt.set(row.name, Date.parse(row.at))
      for (const [key, r] of [...this.requests]) if (r.bot === row.name && ENDED.has(r.state)) this.requests.delete(key)
      this.spent.delete(row.name)
      this.exitFills.delete(row.name)
      return
    }
    if (row.type === "bot.request_ended" && typeof row.name === "string" && typeof row.request === "string") {
      const r = this.requests.get(keyOf(row.name, row.request))
      if (!r || ENDED.has(r.state)) return
      r.state = (typeof row.outcome === "string" ? row.outcome : "failed") as RequestState
      r.words = typeof row.words === "string" ? row.words : r.words
      if (typeof row.code === "string") r.code = row.code
      return
    }
    if (typeof row.bot === "string" && typeof row.botRequest === "string") {
      const r = this.requests.get(keyOf(row.bot, row.botRequest))
      if (!r) return
      if (row.type === "card.created") {
        if (typeof row.cardId === "string") r.cardId = row.cardId
        if (typeof row.opId === "string") r.opId = row.opId
      } else if (row.type === "card.approved") {
        r.approved = true
        if (typeof row.usd === "number" && r.usd === undefined) r.usd = row.usd
        if (r.state === "pending" || r.state === "waiting") this.set(r, "sent", `${this.what(r)} was sent to Candle`)
      } else if (row.type === "card.withdrawn" && r.refusedBy) {
        void this.ended(r, "refused", r.refusedBy.words.replace(/[.\s]+$/, ""), r.refusedBy.code).catch(() => {})
      } else if ((row.type === "card.rejected" || row.type === "card.withdrawn" || row.type === "card.expired") && !r.approved) {
        const words = row.type === "card.expired" ? (row.reason === "core_restarted" ? "its card was open when the core stopped, so nothing was sent" : "nobody pressed its card in time, so nothing was sent") : row.type === "card.rejected" ? "the person rejected its card, so nothing was sent" : row.reason === "bot_changed" ? "its card was withdrawn when a change to the bot was approved, so nothing was sent; ask again under the new settings" : "its card was withdrawn, so nothing was sent"
        void this.ended(r, row.type.slice(5) as RequestState, words).catch(() => {})
      } else if (row.type === "paper.call") {
        r.paperId = `paper:${row.seq}`
        if (row.isError === true) void this.ended(r, "failed", `its paper ${r.side} didn't go through${paperWhy(row)}`).catch(() => {})
        else this.filled(r, row)
      } else if (row.type === "tool.refused" && !ENDED.has(r.state)) {
        // Refused by the core before Candle traded it (a token Candle doesn't know, a dollar amount it couldn't size):
        // no paper.call or card follows, so this row ends it.
        const why = typeof row.message === "string" && row.message ? row.message : String(row.code ?? "the core refused it")
        void this.ended(r, "refused", `${this.what(r)} was refused: ${why.replace(/[.\s]+$/, "")}`, typeof row.code === "string" ? row.code : undefined).catch(() => {})
      }
      return
    }
    if (row.type.startsWith("operation.") && typeof row.opId === "string") {
      const r = this.byOp(row.opId)
      if (!r || ENDED.has(r.state)) return
      if (row.type === "operation.succeeded") this.filled(r, row)
      else if (row.type === "operation.failed" || row.type === "operation.refused" || row.type === "operation.abandoned") {
        const why = record(row.error)?.message
        void this.ended(r, "failed", `${this.what(r)} ${row.type === "operation.abandoned" ? "was abandoned" : "didn't go through"}${typeof why === "string" ? `: ${why.replace(/[.\s]+$/, "")}` : ""}`, typeof record(row.error)?.code === "string" ? String(record(row.error)!.code) : undefined).catch(() => {})
      }
    }
  }

  /** A row of an exit the core held for a code bot: told to the bot as it goes. True when it was one. */
  private exitRow(row: JournalRow): boolean {
    const t = row.type
    if ((t === "bot.exiting" || t === "bot.exit_ended" || t === "bot.exit_held" || t === "bot.exit_waiting" || t === "bot.position_left") && row.kind === "code") {
      if (typeof row.name !== "string" || typeof row.position !== "string" || typeof row.mint !== "string") return true
      if (t === "bot.exiting") this.exitsUnder.set(row.position, { mint: row.mint, ...(typeof row.reason === "string" ? { reason: row.reason } : {}) })
      const reason = this.exitsUnder.get(row.position)?.reason
      const state: ExitState = t === "bot.exiting" ? "selling" : t === "bot.exit_held" ? "held" : t === "bot.exit_waiting" ? "waiting" : t === "bot.position_left" ? "left" : ((typeof row.outcome === "string" ? row.outcome : "failed") as ExitState)
      if (t === "bot.exit_ended" || t === "bot.position_left") this.exitsUnder.delete(row.position)
      const words = typeof row.words === "string" ? row.words : ""
      this.tellExit(row.name, { position: row.position, mint: row.mint, state, ...(reason ? { reason } : {}), words: t === "bot.exiting" ? `${this.label(row.mint)}: ${words}` : words })
      return true
    }
    if (typeof row.bot === "string" && row.botKind === "code" && row.botAct === "exit" && typeof row.botRequest !== "string") {
      const position = typeof row.botPosition === "string" ? row.botPosition : undefined
      if (!position) return true
      if (row.type === "card.created" && typeof row.opId === "string") this.exitOps.set(row.opId, { bot: row.bot, position })
      else if (row.type === "paper.call" && row.isError !== true) this.exitFilled(row.bot, position, row)
      return true
    }
    if (row.type.startsWith("operation.") && typeof row.opId === "string" && this.exitOps.has(row.opId)) {
      const x = this.exitOps.get(row.opId)!
      if (row.type === "operation.succeeded") this.exitFilled(x.bot, x.position, row)
      // A failed sell's end is the exits' own row (`bot.exit_ended`), told from there.
      if (row.type === "operation.succeeded" || row.type === "operation.failed" || row.type === "operation.refused" || row.type === "operation.abandoned") this.exitOps.delete(row.opId)
      return true
    }
    return false
  }

  /** A held exit's sell filled: listed with the bot's fills, and told. */
  private exitFilled(bot: string, position: string, row: JournalRow): void {
    const under = this.exitsUnder.get(position)
    this.exitsUnder.delete(position)
    const f = fillOfRow(row)
    const mint = f?.mint ?? under?.mint ?? this.deps.positions.get(position)?.mint ?? ""
    const fill: FillShort = f ? fillShort(f, "sell", row.at) : { side: "sell", ...(mint ? { mint } : {}), at: row.at }
    const list = this.exitFills.get(bot) ?? []
    list.push({ ...fill, position, ...(under?.reason ? { exit: under.reason } : {}) })
    if (list.length > ENDED_KEPT) list.splice(0, list.length - ENDED_KEPT)
    this.exitFills.set(bot, list)
    const why = under?.reason ? EXIT_WORDS[under.reason] : undefined
    this.tellExit(bot, { position, mint, state: "sold", ...(under?.reason ? { reason: under.reason } : {}), words: `${this.label(mint)}: sold${why ? ` ${why}` : ""}, by the exits the core held`, fill })
  }

  private tellExit(bot: string, told: ExitTold): void {
    if (!this.rebuilding) this.deps.tell(bot, { kind: "exit", ...told })
  }

  /**
   * Sets, changes or clears the exits the core holds on one of its open positions: what's sent replaces what was
   * held. Cleared with `exits: null`. Journalled, so they hold across a restart.
   */
  async setExits(bot: string, params: Record<string, unknown>): Promise<{ position: string; exits: Exit | null; words: string }> {
    onlyKeys(params, ["position", "mint", "exits"])
    const { b } = this.settings(bot)
    if (!("exits" in params)) throw refused("INVALID_PARAMS", "exits is what the core holds on the position (take_profit_pct, stop_loss_pct, max_hold_hours, trailing), or null to clear them.")
    const p = this.position(bot, params)
    const label = this.label(p.mint)
    let exit: Exit | null = null
    if (params.exits !== null) {
      const read = readHeldExit(params.exits)
      if (!read.ok) throw refused("INVALID_PARAMS", read.message)
      exit = read.exit
    }
    const was = this.deps.heldExits?.(p.id)
    if (!exit && !was) return { position: p.id, exits: null, words: `${label}: the core holds no exits on this position, so there was nothing to clear.` }
    const selling = this.deps.exitUnderWay?.(p.id) ? " A sell of it is under way already, and goes on." : ""
    const words = exit ? `${label}: the core holds its exits: ${exitWords(exit).replace(/^Sells /, "sells ")}${selling}` : `${label}: the core no longer holds exits on it; its own code sells it.${selling}`
    await this.deps.journal.append({ type: "bot.exits_set", mode: p.mode, kind: "code", agent: b.agent, name: bot, position: p.id, mint: p.mint, exits: exit, by: "bot", words })
    return { position: p.id, exits: exit, words }
  }

  /** The person removes the exits the core holds on a position of a code bot's: told to the bot. */
  async removeExits(bot: string, position: string, by: string): Promise<{ name: string; position: string; said: string }> {
    const p = this.deps.positions.get(position)
    if (!p || p.bot !== bot) throw refused("NOT_ITS_POSITION", `That isn't one of "${bot}"'s positions.`)
    const label = this.label(p.mint)
    if (!this.deps.heldExits?.(p.id)) return { name: bot, position, said: `The core holds no exits on "${bot}"'s ${label} position.` }
    const b = this.deps.codeBots.entry(bot)
    const words = `${label}: you removed the exits the core held on it; its own code sells it from now on${this.deps.exitUnderWay?.(p.id) ? ". A sell of it already under way goes on" : ""}`
    await this.deps.journal.append({ type: "bot.exits_set", mode: p.mode, kind: "code", agent: b?.agent ?? p.agent, name: bot, position: p.id, mint: p.mint, exits: null, by: "person", client: by, words })
    this.deps.tell(bot, { kind: "exits", position: p.id, mint: p.mint, exits: null, by: "person", words })
    return { name: bot, position, said: `The core no longer holds exits on "${bot}"'s ${label} position: its own code sells it from now on.` }
  }

  /** Whether a sell the bot asked for is under way on a position: the held exits wait for it. */
  sellUnderWay(position: string): boolean {
    if (this.selling.has(position)) return true
    for (const r of this.requests.values()) if (r.position === position && r.side === "sell" && !ENDED.has(r.state)) return true
    return false
  }

  /**
   * What became of a request, by the bot's own id: unknown when the core never recorded it, so nothing was sent. One
   * that ended long enough ago to be let go from memory is said as ended, never as unknown: it may have filled.
   */
  status(bot: string, params: Record<string, unknown>): RequestAnswer | { request: string; state: "unknown" | "ended"; words: string } {
    const request = requestOf(params)
    const r = this.requests.get(keyOf(bot, request))
    if (r) return this.answer(r)
    if (this.spent.get(bot)?.has(request)) return { request, state: "ended", words: SPENT_WORDS }
    return { request, state: "unknown", words: "The core has no request by that id from this bot, so nothing was sent for it." }
  }

  /** An id of a request that ended and was let go from memory is never taken for a new trade. */
  private unspent(bot: string, request: string): void {
    if (this.spent.get(bot)?.has(request)) throw refused("REQUEST_SPENT", `${SPENT_WORDS} Nothing was sent; a new trade takes a new id.`)
  }

  /** A buy of a token, in dollars, held to the bot's figures and its wallet's. */
  async buy(bot: string, params: Record<string, unknown>): Promise<RequestAnswer> {
    const request = requestOf(params)
    const seen = this.requests.get(keyOf(bot, request))
    if (seen) return this.answer(seen)
    this.unspent(bot, request)
    onlyKeys(params, ["request", "mint", "amountUsd", "exits", "chain"])
    const { b, run } = this.settings(bot)
    const mint = mintOf(params.mint)
    const chain = chainOfRequest(mint, params.chain)
    const amount = params.amountUsd
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw refused("INVALID_PARAMS", "amountUsd is what the buy spends, in dollars, more than 0.")
    // Exits the core holds on the position this buy opens: read before anything is recorded, so a bad one sends nothing.
    let exit: Exit | undefined
    if (params.exits !== undefined && params.exits !== null) {
      const read = readHeldExit(params.exits)
      if (!read.ok) throw refused("INVALID_PARAMS", read.message)
      exit = read.exit
    }
    const stake = cents(amount)
    if (stake < 0.01) throw refused("INVALID_PARAMS", "amountUsd is at least $0.01.")
    // Its wallet pays on one chain: a token on another is refused before anything is recorded. On paper, either chain's.
    const wrong = run.mode === "live" ? this.deps.wrongChain?.(b.agent, run.wallet, chain) : undefined
    if (wrong) return this.refuse(bot, b.agent, "WALLET_CHAIN", `${wrong} Nothing was sent.`)
    const label = this.label(mint)
    this.buysRun(bot, b.agent, "buy")
    if (stake > run.perTradeUsd) return this.refuse(bot, b.agent, "FIGURE_TRADE", `A buy of ${usd(stake)} is over its ${usd(run.perTradeUsd)} a trade, so nothing was sent.`)
    const spent = this.spentToday(bot, run.mode)
    if (spent + stake > run.perDayUsd + 1e-9) return this.refuse(bot, b.agent, "FIGURE_DAY", `A buy of ${usd(stake)} would take today's buys to ${usd(spent + stake)}, over its ${usd(run.perDayUsd)} a day, so nothing was sent.`)
    // A paper test's figures count from its own start: what an earlier test of the folder left open isn't this run's.
    const since = this.deps.codeBots.testSince?.(bot)
    const open = this.deps.positions.open(bot, run.mode).filter((p) => since === undefined || Date.parse(p.entryAt) >= since).length + this.under(bot, "buy").length
    if (open >= run.maxOpen) return this.refuse(bot, b.agent, "FIGURE_OPEN", `It has ${open} open${open === 1 ? "" : " (buys under way included)"}, its ${run.maxOpen} at most, so nothing was sent.`)
    this.room(bot, b.agent, mint, "buy", label)
    const held = exit ? `; the core holds its exits: ${exitWords(exit).replace(/^Sells /, "sells ").replace(/\.$/, "")}` : ""
    const r = this.record(bot, b.agent, request, { side: "buy", mode: run.mode, mint, usd: stake, words: `buys ${usd(stake)} of ${label}${run.mode === "paper" ? ", on paper" : ""}${held}` })
    await this.deps.journal.append({ type: "bot.request", mode: run.mode, kind: "code", agent: b.agent, name: bot, request, side: "buy", mint, chain, usd: stake, botMode: run.mode, wallet: run.wallet, ...(exit ? { exits: exit } : {}), words: r.words })
    const trade = { tool: "candle_trade", args: { mint, side: "buy", amountUsd: stake, ...(run.mode === "live" ? { wallet: run.wallet } : {}), ...(run.maxSlippageBps !== undefined ? { maxSlippageBps: run.maxSlippageBps } : {}) } }
    return this.dispatch(r, trade, this.client(bot, b.agent, run, run.mode, { act: "entry", request }), `the code bot "${bot}" buys`)
  }

  /** A swap between two base assets, valued as its card is and held to its dollar figures. */
  async swap(bot: string, params: Record<string, unknown>): Promise<RequestAnswer> {
    const request = requestOf(params)
    const seen = this.requests.get(keyOf(bot, request))
    if (seen) return this.answer(seen)
    this.unspent(bot, request)
    onlyKeys(params, ["request", "from", "to", "amount"])
    const { b, run } = this.settings(bot)
    const from = typeof params.from === "string" ? params.from.toUpperCase() : ""
    const to = typeof params.to === "string" ? params.to.toUpperCase() : ""
    if (!isBaseAsset(from) || !isBaseAsset(to) || from === to) throw refused("INVALID_PARAMS", `A swap is between two of ${Object.keys(BASE_ASSETS).join(", ")}.`)
    const amount = typeof params.amount === "string" ? params.amount.trim() : typeof params.amount === "number" ? String(params.amount) : ""
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw refused("INVALID_PARAMS", "amount is how much of `from` it swaps, as a decimal, more than 0.")
    if (run.mode === "paper") throw refused("NO_PAPER_SWAPS", "Swaps have no paper mode, and this bot runs on paper, so nothing was sent.")
    this.buysRun(bot, b.agent, "swap")
    this.room(bot, b.agent, undefined, "swap", `${from} to ${to}`)
    const r = this.record(bot, b.agent, request, { side: "swap", mode: run.mode, words: `swaps ${amount} ${from} to ${to}` })
    await this.deps.journal.append({ type: "bot.request", mode: run.mode, kind: "code", agent: b.agent, name: bot, request, side: "swap", from, to, amount, botMode: run.mode, wallet: run.wallet, words: r.words })
    // Valued as its card is, then held to its figures before it can run: the value is counted at once.
    const check = (card: Card) => {
      const value = card.value.usd
      const spent = this.spentToday(bot, run.mode, r)
      const no =
        value === undefined
          ? { code: "UNVALUED", words: "The core couldn't value this swap, so it can't hold it to the bot's figures, and nothing was sent." }
          : value > run.perTradeUsd + 1e-9
            ? { code: "FIGURE_TRADE", words: `A swap worth ${usd(value)} is over its ${usd(run.perTradeUsd)} a trade, so nothing was sent.` }
            : spent + value > run.perDayUsd + 1e-9
              ? { code: "FIGURE_DAY", words: `A swap worth ${usd(value)} would take today's buys and swaps to ${usd(spent + value)}, over its ${usd(run.perDayUsd)} a day, so nothing was sent.` }
              : undefined
      if (no) r.refusedBy = no
      else r.usd = cents(value!)
      return no
    }
    const trade = { tool: "candle_swap", args: { from, to, amount, ...(run.mode === "live" ? { wallet: run.wallet } : {}), ...(run.maxSlippageBps !== undefined ? { maxSlippageBps: run.maxSlippageBps } : {}) } }
    return this.dispatch(r, trade, this.client(bot, b.agent, run, run.mode, { act: "entry", request }), `the code bot "${bot}" swaps`, check)
  }

  /** A sell of its own: one open position, or its oldest in a token, whole or a part. Never more than it holds. */
  async sell(bot: string, params: Record<string, unknown>): Promise<RequestAnswer> {
    const request = requestOf(params)
    const key = keyOf(bot, request)
    const seen = this.requests.get(key)
    if (seen) return this.answer(seen)
    // One id, one trade: the same id asked again while the first is still being planned waits for the first's answer.
    const first = this.asking.get(key)
    if (first) return first
    this.unspent(bot, request)
    const asked = this.sellOnce(bot, request, params)
    this.asking.set(key, asked)
    try {
      return await asked
    } finally {
      this.asking.delete(key)
    }
  }

  private async sellOnce(bot: string, request: string, params: Record<string, unknown>): Promise<RequestAnswer> {
    onlyKeys(params, ["request", "position", "mint", "percent", "amount"])
    const { b, run } = this.settings(bot)
    const runs = this.deps.codeBots.runs(b)
    if (!runs.sells) return this.refuse(bot, b.agent, "SELLS_HELD", `Its sells don't run now: ${this.heldWords(bot)}. Nothing was sent.`)
    const p = this.position(bot, params)
    const label = this.label(p.mint)
    if (this.under(bot, "sell").some((x) => x.position === p.id)) return this.refuse(bot, b.agent, "SELL_UNDER_WAY", `A sell of this ${label} position is under way already, so nothing more was sent.`)
    if (this.deps.exitUnderWay?.(p.id)) return this.refuse(bot, b.agent, "SELL_UNDER_WAY", `An exit the core holds is selling this ${label} position now, so nothing more was sent. It hears how that sell ends.`)
    // The position is this sell's from here, before anything is awaited: reading the wallet's balance takes a moment,
    // and a second sell arriving in it would be planned from the same holding.
    if (this.selling.has(p.id)) return this.refuse(bot, b.agent, "SELL_UNDER_WAY", `A sell of this ${label} position is under way already, so nothing more was sent.`)
    this.selling.add(p.id)
    try {
      return await this.sellHeld(bot, request, params, b, run, p, label)
    } finally {
      // Its request is in the map by now where one was recorded, and holds the position until it ends.
      this.selling.delete(p.id)
    }
  }

  private async sellHeld(bot: string, request: string, params: Record<string, unknown>, b: NonNullable<ReturnType<CodeBotDeskDeps["codeBots"]["entry"]>>, run: CodeRunSettings, p: BotPosition, label: string): Promise<RequestAnswer> {
    if (params.percent !== undefined && params.amount !== undefined) throw refused("INVALID_PARAMS", "Give percent or amount, not both.")
    // The part it sells: all of it, a percent of its position, or an amount of tokens, never more than it holds.
    let percent = 100
    let partRaw: bigint | undefined
    let over: string | undefined
    if (params.percent !== undefined) {
      if (typeof params.percent !== "number" || !Number.isInteger(params.percent) || params.percent < 1) throw refused("INVALID_PARAMS", "percent is a whole number of its position, from 1 to 100.")
      if (params.percent > 100) over = `it asked to sell ${params.percent}% of its position, so it sells all of it`
      percent = Math.min(100, params.percent)
    }
    const decimals = p.decimals ?? this.deps.decimalsOf(p.mint)
    const left = this.deps.positions.remainingRaw(p)
    if (params.amount !== undefined) {
      const amount = typeof params.amount === "string" ? params.amount.trim() : typeof params.amount === "number" ? String(params.amount) : ""
      const asked = decimals === undefined || !/^\d+(\.\d+)?$/.test(amount) ? undefined : toRaw(amount, decimals)
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw refused("INVALID_PARAMS", "amount is how many tokens it sells, as a decimal, more than 0.")
      if (asked === undefined || left === undefined || left === 0n || decimals === undefined) throw refused("AMOUNT_UNKNOWN", `What this ${label} position holds isn't known by amount, so sell it by percent.`)
      if (asked >= left) {
        if (asked > left) over = `it asked to sell ${amount} ${label}, and its position holds ${fromRaw(left, decimals)}, so it sells that`
      } else {
        partRaw = asked
        percent = Math.max(1, Number((asked * 100n) / left))
      }
    }
    if (this.deps.failed.held(b.agent, p.mint)) return this.refuse(bot, b.agent, "FAILED_SELLS", `Its sell waits: ${this.deps.failed.words(b.agent, label)}. Nothing was sent.`)
    let holding: bigint | undefined
    let dec = decimals
    if (p.mode === "live") {
      const h = await this.deps.holding(b.agent, p.wallet, p.mint, positionChain(p)).catch(() => "unreadable" as const)
      if (h === "unreadable") return this.refuse(bot, b.agent, "HOLDING_UNREAD", `The wallet's balance of ${label} couldn't be read, so nothing was sent. Ask again in a moment.`)
      holding = h === "none" ? 0n : h.amountRaw
      if (h !== "none") {
        this.deps.positions.noteDecimals(p.mint, h.decimals)
        dec ??= h.decimals
      }
    }
    const plan = this.deps.positions.sellPlan(p, { ...(holding !== undefined ? { holding } : {}), byAmount: p.mode === "paper" || this.deps.byAmount(p.wallet, p.mint), ...(dec !== undefined ? { decimals: dec } : {}), label })
    if (plan.by === "none") return this.refuse(bot, b.agent, "NOTHING_TO_SELL", `${plan.words} Nothing was sent.`)
    let sellArgs: Record<string, unknown>
    let says: string
    let sellsRaw: string | undefined
    if (plan.by === "amount") {
      const raw = partRaw !== undefined ? (partRaw < plan.amountRaw ? partRaw : plan.amountRaw) : percent === 100 ? plan.amountRaw : (plan.amountRaw * BigInt(percent)) / 100n
      if (raw === 0n || dec === undefined) return this.refuse(bot, b.agent, "TOO_SMALL", `${percent}% of this ${label} position is too little to sell, so nothing was sent.`)
      const amount = fromRaw(raw, dec)
      sellArgs = { amount }
      sellsRaw = String(raw)
      says = `${amount} ${label}`
    } else {
      const pct = percent === 100 ? plan.percent : Math.floor((plan.percent * percent) / 100)
      if (pct < 1) return this.refuse(bot, b.agent, "TOO_SMALL", `${percent}% of this bot's ${label} is under 1% of what the wallet holds, and this wallet sells by whole percent, so nothing was sent. A wallet of its own keeps its book exact.`)
      sellArgs = { percent: pct }
      says = `${pct}% of the wallet's ${label}${pct < 100 ? ", ≈ its own" : ""}`
    }
    this.room(bot, b.agent, p.mint, "sell", label)
    const note = [over, plan.words].filter(Boolean).join(". ")
    const r = this.record(bot, b.agent, request, { side: "sell", mode: p.mode, mint: p.mint, position: p.id, ...(note ? { note } : {}), words: `sells ${says}${p.mode === "paper" ? ", on paper" : ""}${note ? `: ${note}` : ""}` })
    await this.deps.journal.append({ type: "bot.request", mode: p.mode, kind: "code", agent: b.agent, name: bot, request, side: "sell", mint: p.mint, position: p.id, botMode: p.mode, wallet: p.wallet, sell: sellArgs, ...(note ? { note } : {}), ...(plan.outsideRaw !== undefined ? { outsideRaw: String(plan.outsideRaw) } : {}), words: r.words })
    const trade = { tool: "candle_trade", args: { mint: p.mint, side: "sell", ...sellArgs, ...(p.mode === "live" ? { wallet: p.wallet } : {}), ...(run.maxSlippageBps !== undefined ? { maxSlippageBps: run.maxSlippageBps } : {}) } }
    const partial = percent < 100 || partRaw !== undefined
    return this.dispatch(r, trade, this.client(bot, b.agent, run, p.mode, { act: "exit", position: p.id, request, reason: "bot", ...(partial ? { partial: true } : {}), ...(sellsRaw ? { sellsRaw } : {}), ...(plan.outsideRaw !== undefined ? { outside: String(plan.outsideRaw) } : {}) }), `the code bot "${bot}" sells`)
  }

  /** Its open positions, from its own fills: the core's count, never what the bot says. */
  positions(bot: string): { positions: ReturnType<CodeBotDesk["positionView"]>[]; totals: { paper: ReturnType<BotPositions["totals"]>; live: ReturnType<BotPositions["totals"]> } } {
    this.settings(bot)
    return { positions: this.deps.positions.open(bot).map((p) => this.positionView(p)), totals: { paper: this.deps.positions.totals(bot, "paper"), live: this.deps.positions.totals(bot, "live") } }
  }

  /** Its fills, newest first: each buy, sell and swap that filled, by its request id where it had one. */
  fills(bot: string, params: Record<string, unknown>): { fills: (FillShort & { request?: string; position?: string; exit?: string })[] } {
    this.settings(bot)
    const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0 ? Math.min(200, params.limit) : 50
    const out: (FillShort & { request?: string; position?: string; exit?: string })[] = []
    for (const r of this.requests.values()) if (r.bot === bot && r.state === "filled" && r.fill) out.push({ ...r.fill, request: r.request, ...(r.position ? { position: r.position } : {}) })
    for (const f of this.exitFills.get(bot) ?? []) out.push(f)
    return { fills: out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit) }
  }

  /** Candle's market read for a token: not counted toward a key's limit, reused for 4.5 s. */
  async market(bot: string, params: Record<string, unknown>): Promise<unknown> {
    this.settings(bot)
    onlyKeys(params, ["mint", "chain"])
    const mint = mintOf(params.mint)
    const chain = chainOfRequest(mint, params.chain)
    // Kept per chain and address: one address on two EVM chains is two tokens.
    const key = `${chain}:${addressKey(mint)}`
    const held = this.markets.get(key)
    const now = this.deps.now()
    let outcome = held && now - held.at < BOT_MARKET_REUSE_MS ? held.outcome : undefined
    if (!outcome) {
      outcome = await this.deps.market(chain, mint)
      if (!outcome) throw refused("NO_KEY", "No key can read Candle's market now. Try again in a moment.")
      if (this.markets.size > 2_000) this.markets.clear()
      this.markets.set(key, { at: this.deps.now(), outcome })
    }
    if (outcome.kind === "error") throw refused(outcome.code, typeof record(outcome.body)?.message === "string" ? String(record(outcome.body)!.message) : "Candle refused the market read.")
    if (outcome.kind !== "ok") {
      this.markets.delete(key)
      throw refused("MARKET_UNREAD", "Candle's market read didn't answer. Try again in a moment.")
    }
    const market = record(record(outcome.result)?.market)
    if (!market) throw refused("NO_MARKET", "Candle has no market for that token.")
    return { market }
  }

  /** Every request of a bot's that's under way, of a side. */
  private under(bot: string, side: BotRequest["side"]): BotRequest[] {
    return [...this.requests.values()].filter((r) => r.bot === bot && r.side === side && !ENDED.has(r.state))
  }

  /** What a bot's buys and swaps spent today, or may, in the mode it runs in now: its day figure's use, for the Bots tab. */
  usedToday(bot: string): number {
    const mode = this.deps.codeBots.approvedVersion(bot)?.run.mode ?? this.deps.codeBots.entry(bot)?.mode ?? "live"
    return Math.round(this.spentToday(bot, mode) * 100) / 100
  }

  /**
   * Its buys and swaps since local midnight that spent or may, filled or under way, in one mode: a bot moved from
   * live to paper starts a paper day of its own, and its live buys never count against its paper figure, or back.
   */
  private spentToday(bot: string, mode: "paper" | "live", except?: BotRequest): number {
    const since = Math.max(startOfLocalDay(this.deps.now()), this.deps.codeBots.testSince?.(bot) ?? 0, this.removedAt.get(bot) ?? 0)
    let n = 0
    for (const r of this.requests.values()) {
      if (r === except || r.bot !== bot || r.side === "sell" || r.at < since || r.mode !== mode) continue
      if (ENDED.has(r.state) && r.state !== "filled") continue
      n += r.usd ?? 0
    }
    return n
  }

  /** The bot as saved, and the run settings it was approved as: what every trade of its takes. */
  private settings(bot: string): { b: NonNullable<ReturnType<CodeBotDeskDeps["codeBots"]["entry"]>>; run: CodeRunSettings } {
    const b = this.deps.codeBots.entry(bot)
    const run = b ? this.deps.codeBots.approvedVersion(bot)?.run : undefined
    if (!b || !run) throw refused("UNKNOWN_BOT", "This bot isn't approved in bots.toml now, so it doesn't trade.")
    return { b, run }
  }

  private buysRun(bot: string, agent: string, side: "buy" | "swap"): void {
    const b = this.deps.codeBots.entry(bot)!
    if (!this.deps.codeBots.runs(b).buys) this.refuse(bot, agent, "BUYS_HELD", `Its ${side}s don't run now: ${this.heldWords(bot)}. Nothing was sent.`)
    if (this.deps.paused()) this.refuse(bot, agent, "PAUSED", `The kill switch is on: its ${side}s are held until the person resumes, and its sells still go. Nothing was sent.`)
  }

  private heldWords(bot: string): string {
    const b = this.deps.codeBots.entry(bot)!
    const held = this.deps.codeBots.heldBy(b)
    const v = this.deps.codeBots.viewOf(b)
    return (v.stateWords ?? held?.words ?? "it's held").replace(/[.\s]+$/, "")
  }

  /** Candle's breaker: the pace or a failing route, refused with when to ask again. With room, the slot is the trade's. */
  private room(bot: string, agent: string, mint: string | undefined, side: "buy" | "sell" | "swap", label: string): void {
    const held = this.deps.room(agent, mint, side, label)
    if (!held) return
    const words = `${held.words[0]!.toUpperCase()}${held.words.slice(1)}. Nothing was sent; ask again after ${new Date(held.until).toISOString()}.`
    this.journalRefusal(bot, agent, held.why === "route" ? "ROUTE_FAILING" : "BREAKER_PACE", words)
    throw refused(held.why === "route" ? "ROUTE_FAILING" : "BREAKER_PACE", words, { retryAt: new Date(held.until).toISOString() })
  }

  /** A refusal before anything was recorded: the id stays free, and the refusal is journalled at most once a minute. */
  private refuse(bot: string, agent: string, code: string, words: string): never {
    this.journalRefusal(bot, agent, code, words)
    throw refused(code, words)
  }

  private journalRefusal(bot: string, agent: string, code: string, words: string): void {
    const key = `${bot}\u0000${code}`
    const now = this.deps.now()
    if ((this.refusedAt.get(key) ?? -Infinity) > now - REFUSED_ROW_MS) return
    this.refusedAt.set(key, now)
    const botMode = this.deps.codeBots.approvedVersion(bot)?.run.mode ?? "live"
    void this.deps.journal.append({ type: "bot.refused", mode: botMode, kind: "code", agent, name: bot, code, botMode, words }).catch(() => {})
  }

  /** The position a sell names: one of the bot's own, open; or its oldest open in a token. */
  private position(bot: string, params: Record<string, unknown>): BotPosition {
    if (params.position !== undefined) {
      const p = typeof params.position === "string" ? this.deps.positions.get(params.position) : undefined
      if (!p || p.bot !== bot) throw refused("NOT_ITS_POSITION", "That isn't one of this bot's positions: it sells only its own.")
      if (p.closedAt) throw refused("POSITION_CLOSED", `This position in ${this.label(p.mint)} is closed: there's nothing of it left to sell.`)
      return p
    }
    if (params.mint === undefined) throw refused("INVALID_PARAMS", "A sell names position (one of its own, from bot.positions) or mint (its oldest open position in it).")
    const mint = mintOf(params.mint)
    const p = this.deps.positions.open(bot).find((o) => sameAddress(o.mint, mint))
    if (!p) throw refused("NOTHING_TO_SELL", `This bot holds no ${this.label(mint)} of its own, so there's nothing to sell.`)
    return p
  }

  private record(bot: string, agent: string, request: string, r: Pick<BotRequest, "side" | "mode" | "words"> & Partial<BotRequest>): BotRequest {
    const req: BotRequest = { request, bot, agent, at: this.deps.now(), state: "pending", ...r }
    // In the map before anything is awaited, so a second request at once sees it.
    this.requests.set(keyOf(bot, request), req)
    return req
  }

  private client(bot: string, agent: string, run: CodeRunSettings, mode: "paper" | "live", act: Parameters<typeof botClient>[1]): FaceClient {
    const r: BotRun = { kind: "code", name: bot, agent, mode, ...(run.maxSlippageBps !== undefined ? { slippageBps: run.maxSlippageBps } : {}) }
    return botClient(r, act)
  }

  private async dispatch(r: BotRequest, trade: { tool: string; args: Record<string, unknown> }, client: FaceClient, reason: string, check?: (card: Card) => { code: string; words: string } | undefined): Promise<RequestAnswer> {
    let answer: unknown
    try {
      answer = await this.deps.send(trade, client, r.mode, reason, check)
    } catch (error) {
      const e = errorOf(error)
      await this.ended(r, "refused", `${this.what(r)} was refused: ${e.message.replace(/[.\s]+$/, "")}`, e.code)
      return this.answer(r)
    }
    const a = record(answer)
    if (a && "paper" in a) {
      // Its paper.call row filled or failed it already, or its tool.refused row ended it. A refusal that left neither
      // ends it here: a request is never left waiting on a row that won't come.
      const paper = record(a.paper)
      if (paper?.isError === true && !ENDED.has(r.state)) {
        const e = refusalOf(paper)
        await this.ended(r, "refused", `${this.what(r)} was refused${e.message ? `: ${e.message.replace(/[.\s]+$/, "")}` : ""}`, e.code)
      }
      return this.answer(r)
    }
    if (typeof a?.cardId === "string") {
      // The answer is another request's card: the same trade asked at once under two ids is one trade, so this id
      // ends here with nothing sent for it, rather than waiting on a card that isn't its own.
      const owner = this.deps.card(a.cardId)?.origin.bot?.request
      const others = owner !== undefined ? owner !== r.request : [...this.requests.values()].some((x) => x !== r && x.bot === r.bot && x.cardId === a.cardId)
      if (others) {
        await this.ended(r, "refused", `the same ${r.side} is already under way under another id, so nothing more was sent for this one`, "SAME_TRADE_UNDER_WAY")
        return this.answer(r)
      }
      r.cardId ??= a.cardId
      if (typeof a.opId === "string") r.opId ??= a.opId
      if (a.state === "awaiting_approval" && a.instant === undefined && !ENDED.has(r.state)) {
        const card = this.deps.card(a.cardId)
        const because = card?.display.cardBecause ?? `${card?.display.walletLabel && card.display.walletLabel !== "embedded" ? card.display.walletLabel : "the embedded wallet"} asks every time`
        this.set(r, "waiting", `${this.what(r)} waits for the person's press: ${because}`)
        await this.deps.journal.append({ type: "bot.request_waiting", mode: r.mode, kind: "code", agent: r.agent, name: r.bot, request: r.request, cardId: a.cardId, because, words: `${this.what(r)} waits for you: ${because}` })
      }
    }
    return this.answer(r)
  }

  private filled(r: BotRequest, row: JournalRow): void {
    const fill = fillOfRow(row)
    // A buy's answer names the position it opened, by the book's own id: its paper trade's row, or its operation. The
    // book opens one only from a fill it can read.
    if (r.side === "buy" && !r.position && fill) {
      const id = row.type === "paper.call" ? `paper:${row.seq}` : typeof row.opId === "string" ? row.opId : undefined
      if (id) r.position = id
    }
    if (fill) r.fill = fillShort(fill, r.side, row.at)
    else r.fill = { side: r.side, ...(r.mint ? { mint: r.mint } : {}), at: row.at }
    if (r.usd !== undefined && r.fill.usd === undefined) r.fill.usd = r.usd
    this.set(r, "filled", `${this.what(r)} filled${r.note ? `: ${r.note}` : ""}`)
  }

  private async ended(r: BotRequest, outcome: RequestState, words: string, code?: string): Promise<void> {
    if (ENDED.has(r.state)) return
    r.state = outcome
    r.words = `${this.labelOf(r)}: ${words}`
    if (code) r.code = code
    if (!this.rebuilding) {
      await this.deps.journal.append({ type: "bot.request_ended", mode: r.mode, kind: "code", agent: r.agent, name: r.bot, request: r.request, side: r.side, ...(r.mint ? { mint: r.mint } : {}), outcome, ...(code ? { code } : {}), words: r.words })
      this.deps.tell(r.bot, { kind: "request", ...this.answer(r) })
    }
    this.trim(r.bot)
  }

  private set(r: BotRequest, state: RequestState, words: string): void {
    if (r.state === state) return
    r.state = state
    r.words = `${this.labelOf(r)}: ${words}`
    if (!this.rebuilding) this.deps.tell(r.bot, { kind: "request", ...this.answer(r) })
    if (ENDED.has(state)) this.trim(r.bot)
  }

  /** Ended requests past the newest few hundred of a bot are let go: their ids stay in the journal. */
  private trim(bot: string): void {
    const ended = [...this.requests.entries()].filter(([, r]) => r.bot === bot && ENDED.has(r.state))
    const kept = this.deps.endedKept ?? ENDED_KEPT
    if (ended.length <= kept) return
    const since = startOfLocalDay(this.deps.now())
    for (const [key, r] of ended.slice(0, ended.length - kept)) {
      if (r.at >= since) continue
      this.requests.delete(key)
      // Its id is kept, alone: asked about again, it's never said as unknown, and it's never taken for a new trade.
      let ids = this.spent.get(bot)
      if (!ids) this.spent.set(bot, (ids = new Set()))
      ids.add(r.request)
    }
  }

  private byOp(opId: string): BotRequest | undefined {
    for (const r of this.requests.values()) if (r.opId === opId) return r
    return undefined
  }

  private answer(r: BotRequest): RequestAnswer {
    return {
      request: r.request,
      side: r.side,
      state: r.state,
      words: r.words,
      ...(r.code ? { code: r.code } : {}),
      ...(r.mint ? { mint: r.mint } : {}),
      ...(r.usd !== undefined ? { usd: r.usd } : {}),
      ...(r.position ? { position: r.position } : {}),
      ...(r.cardId ? { cardId: r.cardId } : {}),
      ...(r.fill ? { fill: r.fill } : {}),
    }
  }

  private what(r: BotRequest): string {
    return `its ${r.side}`
  }

  private labelOf(r: BotRequest): string {
    return r.mint ? this.label(r.mint) : "swap"
  }

  private label(mint: string): string {
    return this.deps.nameOf(mint) ?? short(mint)
  }

  private positionView(p: BotPosition) {
    const left = this.deps.positions.remainingRaw(p)
    const decimals = p.decimals ?? this.deps.decimalsOf(p.mint)
    const entry = this.deps.positions.entryPriceUsd(p)
    const held = this.deps.heldExits?.(p.id)
    return {
      id: p.id,
      mint: p.mint,
      chain: positionChain(p),
      ...(this.deps.nameOf(p.mint) ? { symbol: this.deps.nameOf(p.mint)! } : {}),
      mode: p.mode,
      wallet: p.wallet,
      ...(p.tokensRaw !== undefined && decimals !== undefined ? { tokens: fromRaw(BigInt(p.tokensRaw), decimals) } : {}),
      ...(left !== undefined && decimals !== undefined ? { tokensLeft: fromRaw(left, decimals) } : {}),
      ...(p.costUsd !== undefined ? { costUsd: cents(p.costUsd) } : {}),
      ...(entry !== undefined ? { entryPriceUsd: entry } : {}),
      entryAt: p.entryAt,
      sells: p.exits.length,
      // What the core holds on it, whoever set it: null when its own code sells it.
      exits: held ? { ...held.exit, by: held.by } : null,
      ...(this.deps.exitUnderWay?.(p.id) ? { exiting: true } : {}),
    }
  }

  /** Tells a connected bot its state when it changed since it was last told. */
  stateChanged(bot: string): void {
    const b = this.deps.codeBots.entry(bot)
    if (!b) return
    const v = this.deps.codeBots.viewOf(b)
    const told: BotTold = { kind: "state", state: v.state, buys: v.buys, sells: v.sells, ...(v.stateWords ? { words: v.stateWords } : {}), ...(v.held ? { held: v.held } : {}) }
    const sig = JSON.stringify(told)
    if (this.told.get(bot) === sig) return
    this.told.set(bot, sig)
    this.deps.tell(bot, told)
  }

  /** What it's told on connecting: its state now, said whatever it was told before. */
  stateNow(bot: string): BotTold | undefined {
    const b = this.deps.codeBots.entry(bot)
    if (!b) return undefined
    const v = this.deps.codeBots.viewOf(b)
    const told: BotTold = { kind: "state", state: v.state, buys: v.buys, sells: v.sells, ...(v.stateWords ? { words: v.stateWords } : {}), ...(v.held ? { held: v.held } : {}) }
    this.told.set(bot, JSON.stringify(told))
    return told
  }

  /** Requests of a bot that are under way: what it's told again on connecting. */
  open(bot: string): RequestAnswer[] {
    return [...this.requests.values()].filter((r) => r.bot === bot && !ENDED.has(r.state)).map((r) => this.answer(r))
  }
}

const keyOf = (bot: string, request: string) => `${bot}\u0000${request}`
const SPENT_WORDS = "A request by that id ended before today, and its detail is no longer kept in memory: the Journal has what became of it."

function requestOf(params: Record<string, unknown>): string {
  const r = params.request
  if (typeof r !== "string" || !REQUEST_ID.test(r)) throw refused("INVALID_PARAMS", "request is the bot's own id for this trade: 8 to 64 letters, digits, _ or -, new for each trade, and the same when it asks again.")
  return r
}

/** A request may name only what it may choose: never its mode, wallet, slippage or agent, which are its card's. */
function onlyKeys(params: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of FIXED) {
    if (params[key] !== undefined) throw refused("RUN_SETTINGS_FIXED", `A bot's ${key === "paper" ? "mode" : key} is its card's, never its request's: the person approved it with the bot. Nothing was sent.`)
  }
  for (const key of Object.keys(params)) if (!allowed.includes(key) && params[key] !== undefined) throw refused("INVALID_PARAMS", `${key} isn't something this takes: it takes ${allowed.join(", ")}.`)
}

/** A position's chain as stored, else (one from before positions carried one) its mint's family's. */
const positionChain = (p: BotPosition): ChainSlug => storedChain(p.chain, p.mint) ?? "solana"

/**
 * The chain a request names, checked against the token's address; with none named, the address's family's chain that's
 * on, as Candle's request edge takes it. Refused, nothing sent, for a chain that isn't on or an address it can't hold.
 */
function chainOfRequest(mint: string, given: unknown): ChainSlug {
  if (given === undefined || given === null) return requestChain(mint) ?? "solana"
  const entry = maybeChain(given)
  if (!entry) throw refused("INVALID_PARAMS", `chain is ${enabledChains().map((c) => `"${c.slug}"`).join(" or ")}, or left out for the address's own.`)
  if (!isAddressOn(entry, mint)) throw refused("INVALID_PARAMS", `${short(mint)} isn't an address on ${entry.name}, so nothing was sent.`)
  return entry.slug
}

function mintOf(v: unknown): string {
  if (typeof v !== "string" || familyOfAddress(v) === undefined) throw refused("INVALID_PARAMS", "mint is a token's address.")
  if (spentSymbol(v)) throw refused("BASE_ASSET", "That's what trades spend: swap it, don't buy it.")
  return v
}

/** A tool result's refusal: Candle's `{ error: { code, message } }` in its first text, as far as it reads. */
function refusalOf(result: Record<string, unknown>): { code?: string; message?: string } {
  const text = record((result.content as unknown[] | undefined)?.[0])?.text
  try {
    const e = record(record(JSON.parse(typeof text === "string" ? text : ""))?.error)
    return { ...(typeof e?.code === "string" ? { code: e.code } : {}), ...(typeof e?.message === "string" ? { message: e.message } : {}) }
  } catch {
    return typeof text === "string" && text ? { message: text.slice(0, 200) } : {}
  }
}

function paperWhy(row: JournalRow): string {
  const text = typeof row.answer === "string" ? row.answer : ""
  try {
    const m = record(record(JSON.parse(text))?.error)?.message
    return typeof m === "string" ? `: ${m.replace(/[.\s]+$/, "")}` : ""
  } catch {
    return ""
  }
}

function fillShort(fill: Fill, side: BotRequest["side"], at: string): FillShort {
  return {
    side,
    mint: fill.mint,
    ...(fill.tokensRaw !== undefined && fill.tokenDecimals !== undefined ? { tokens: fromRaw(BigInt(fill.tokensRaw), fill.tokenDecimals) } : {}),
    asset: fill.asset,
    ...(fill.assetRaw !== undefined && isBaseAsset(fill.asset) ? { assetAmount: fromRaw(BigInt(fill.assetRaw), BASE_ASSETS[fill.asset].decimals) } : {}),
    at,
  }
}
