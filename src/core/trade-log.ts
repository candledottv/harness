// What the Trade tab reads from the journal, fed one row at a time: the rows already
// in memory when the core starts, then each row as it's appended.
//   - activity: the user-facing rows in words (cards, fills, refusals, the kill switch, CLI runs,
//     leftover processes), the newest kept;
//   - the paper book per agent: the portfolio never shows paper and no MCP tool or CLI command reads
//     a key's paper book, so it's built from the `paper.call` answers
//     this core journalled, at the quoted price (docs.candle.tv/developers/agent-trading, "Paper mode");
//   - who bought into a holding: agents whose live buys of a mint filled, since several agents can
//     share one wallet;
//   - what went through the Candle Harness, for the agent's own context (without it the agent couldn't see typed trades
//     or swaps, miscounted paper trades and put a swap on the wrong key).
import { ENGINE_LABELS, isEngineId } from "../engine/engine"
import { BASE_ASSETS, baseAssetForMint, quoteAssetOf } from "./assets"
import type { JournalRow } from "./journal"
import { memoryWords } from "./memory"
import { short } from "./wallet-names"

export interface ActivityEntry {
  seq: number
  at: string
  agent?: string
  text: string
  tone: "info" | "good" | "bad" | "warn"
  /** A Hacc change the person can undo with a click: its id. */
  undo?: string
  /** The Hacc change this line undid, so its undo chip goes. */
  undoes?: string
  /** Not drawn: a card did a change's undo, and its own line already says so; this only takes the chip away. */
  hidden?: true
  /** The token the line is about (a card's, its operation's, a paper trade's), which picking the line links. */
  mint?: string
}

/** One trade, swap or narrowing that settled, or a paper trade, as the agent is told it. */
export interface SessionTrade {
  at: string
  mode: string
  agent?: string
  /** Who proposed it: the person typed it, or the agent asked for it; "harness" for the Candle Harness's own state, the kill switch. */
  by: "you" | "agent" | "harness"
  text: string
}

/** How many rows the agent is told about. A busy session outgrew 20 in 45 minutes, and the agent lost the start of its day. */
const SESSION_KEPT = 60
const SETTLED_ROWS = new Set(["operation.succeeded", "operation.failed", "operation.refused", "operation.abandoned", "paper.call"])
/** How a card ended without running, and refusals: the agent is told these too (untold, it called
 * a withdrawn card and a rejected one "most likely expired", and left out every refusal). */
const ENDED_ROWS = new Set(["card.rejected", "card.withdrawn", "card.expired", "card.refused", "tool.refused", "cli.refused"])

/** Why a card was withdrawn, in words. */
const WITHDRAWN_WHY: Record<string, string> = { kill_switch: "kill switch", paid_from_another_wallet: "replaced by a card paid from another wallet", kill_switch_fresh: "the kill switch replaced it with a card at a fresh price" }

export interface PaperPosition {
  mint: string
  symbol?: string
  /** Tokens held, at the quotes' figures. */
  tokens: number
  buys: number
  sells: number
  /** What the tokens still held cost at the quotes, by the asset that paid ("sol", "usdc"…), in its units. */
  cost?: Record<string, number>
  /** Sells' quoted proceeds less what the sold tokens cost, by asset, in its units. */
  realized?: Record<string, number>
  /** A sell's quote carried no proceeds, so what was realised isn't known. */
  realizedUnknown?: true
}

export const ACTIVITY_KEPT = 200

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** A pane card's plan, from its `card.created` row. */
const params0 = (row: JournalRow) => record(record(row.params)?.pane)

/** A pane step's outcome in words, from its operation row's result. */
export function paneResult(row: JournalRow): string | undefined {
  if (!row.type.startsWith("operation.")) return undefined
  const words = record(record(row.result)?.pane)?.words
  return typeof words === "string" ? words : undefined
}

/** What a card's tool is, in activity's words. */
const TOOL_WORDS: Record<string, string> = {
  candle_trade: "trade",
  candle_swap: "swap",
  candle_cli: "command",
  candle_launch_token: "launch",
  candle_launch_and_seed: "launch",
  candle_stake: "stake",
  candle_unstake: "unstake",
  candle_finish_unstake: "unstake",
  candle_claim_fees: "fee claim",
  candle_claim_staking_reward: "reward claim",
  candle_update_profile: "profile edit",
  candle_upload_profile_image: "profile image",
  candle_create_post: "post",
  candle_delete_post: "post delete",
  candle_token_edit: "token edit",
}
/** How a card's kind says it went through: trades and swaps fill, a launch launches; anything else (a revoke, a claim) is done. */
const DONE_WORDS: Record<string, string> = { trade: "filled", swap: "filled", launch: "launched", upload: "uploaded" }
/**
 * A live sell Candle answered by closing the key's paper position, because the live wallet held none of
 * the token: nothing live was sold, so nowhere says "filled".
 */
export const PAPER_CLOSED_WORDS = "not sold live: the wallet held none, so Candle closed this key's paper position instead"

export const doneWord = (kind: string | undefined): string => (kind === undefined ? "filled" : (DONE_WORDS[kind] ?? "done"))

/**
 * A card's name in Activity's words, from its `card.created` row: its compact headline, else its
 * title, and the wallet that pays. Shared with the Journal.
 */
export function cardTitle(row: JournalRow): string {
  // Funds out says where in words (an address alone, the agent couldn't tie it to a wallet): its card's own line.
  const sends = record(params0(row))?.rule === "funds-out" && Array.isArray(row.notes) && typeof row.notes[0] === "string" ? `FUNDS OUT · ${row.notes[0].replace(/\.$/, "")}` : undefined
  const named = sends ?? (typeof row.headline === "string" ? row.headline : typeof row.title === "string" ? row.title : `${String(row.tool)} card`)
  // A card names the wallet that pays, here and in the agent's session block: a TEE wallet by its
  // label, the embedded wallet as "embedded" (without it the agent guessed).
  const payer = row.route === "cli" && typeof row.walletLabel === "string" ? row.walletLabel : row.route !== "cli" && typeof row.wallet === "string" && row.wallet !== "none" ? "embedded" : undefined
  return payer ? `${named} from ${payer}` : named
}

/** Why a card was withdrawn, in words, from its `card.withdrawn` row; undefined where it gave none. */
export const withdrawnWhy = (row: JournalRow): string | undefined => WITHDRAWN_WHY[String(row.reason ?? row.by)]

export class TradeLog {
  private readonly lines: ActivityEntry[] = []
  private readonly titles = new Map<string, string>()
  /** Operations the core ran without a card: their fill says so. */
  private readonly noCard = new Set<string>()
  /** Each card's token, for the lines after its proposal (approved, rejected, expired). */
  private readonly mintOfCard = new Map<string, string>()
  private readonly cardOrigin = new Map<string, { role?: string; agent?: string }>()
  private readonly cardOfOp = new Map<string, { kind?: string; role?: string; agent?: string; mint?: string; side?: string; title: string }>()
  private readonly trades: SessionTrade[] = []
  /** Rows dropped from the front of `trades`, so the agent is told its record isn't the whole day. */
  private dropped = 0
  private readonly bought = new Map<string, string[]>()
  private readonly books = new Map<string, Map<string, PaperPosition>>()

  constructor(
    private readonly deps: {
      /** A token's symbol, when the core has resolved it. */
      symbolOf: (mint: string) => string | undefined
      keep?: number
      onLine?: (entry: ActivityEntry) => void
    },
  ) {}

  add(row: JournalRow): void {
    const text = this.read(row)
    if (!text) return
    const hacc = row.type === "hacc.change" ? { ...(typeof row.undoOf === "string" ? { undoes: row.undoOf } : record(row.undo) && typeof row.changeId === "string" ? { undo: row.changeId } : {}) } : {}
    const byCard = row.type === "hacc.change" && row.by === "card"
    const mint = this.mintOf(row)
    const entry: ActivityEntry = { seq: row.seq, at: row.at, ...(row.agent ? { agent: row.agent } : {}), text: text.text, tone: text.tone, ...hacc, ...(byCard ? { hidden: true as const } : {}), ...(mint ? { mint } : {}) }
    this.lines.push(entry)
    const keep = this.deps.keep ?? ACTIVITY_KEPT
    if (this.lines.length > keep) this.lines.splice(0, this.lines.length - keep)
    // A step run in the prompt pane that ended unclear is the user's to check, and the agent is told so
    // nothing reads it back.
    const paneEnd = row.type === "operation.unknown" && paneResult(row) !== undefined
    if (SETTLED_ROWS.has(row.type) || ENDED_ROWS.has(row.type) || paneEnd) {
      const origin = typeof row.cardId === "string" ? this.cardOrigin.get(row.cardId) : undefined
      const ownRole = row.type === "paper.call" || row.type === "card.refused" || row.type === "tool.refused" || row.type === "cli.refused"
      const role = ownRole ? row.role : row.type.startsWith("operation.") && typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.role : origin?.role
      const agent = row.agent ?? origin?.agent ?? (typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.agent : undefined)
      // The note's prefix says whose it was, so a refusal leaves out "your" (to the agent, that's it). These are
      // the Candle Harness's own refusals, before anything reached Candle (the agent once called one Candle's).
      const said = ownRole && row.type !== "paper.call" ? text.text.replace(/^refused (?:your|\S+'s) (.+?): /, "the Candle Harness refused the $1 (nothing reached Candle): ") : text.text
      this.keep({ at: row.at, mode: String(row.mode ?? ""), ...(agent ? { agent } : {}), by: role === "view" ? "you" : "agent", text: said })
    }
    // The kill switch going on and off (untold, the agent said buys were still paused after a resume).
    if (row.type === "kill.on" || row.type === "kill.off") this.keep({ at: row.at, mode: String(row.mode ?? ""), by: "harness", text: text.text })
    // Hacc's changes and replays: the agent learns what the person undid, and how a replay ended.
    if ((row.type === "hacc.change" && !byCard) || row.type === "hacc.replay") this.keep({ at: row.at, mode: String(row.mode ?? ""), ...(row.agent ? { agent: row.agent } : {}), by: row.by === "you" ? "you" : "agent", text: text.text })
    this.deps.onLine?.(entry)
  }

  /** The token a line is about, if it's one the token pane follows: a card's, its operation's, or a paper trade's. */
  private mintOf(row: JournalRow): string | undefined {
    const params = record(row.params)
    const args = record(row.args)
    const named = row.type === "card.created" ? (row.mint ?? params?.mint) : row.type === "paper.call" ? args?.mint : undefined
    const mint =
      typeof named === "string"
        ? named
        : ((typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.mint : undefined) ?? (typeof row.cardId === "string" ? this.mintOfCard.get(row.cardId) : undefined))
    if (row.type === "card.created" && typeof row.cardId === "string" && typeof mint === "string") this.mintOfCard.set(row.cardId, mint)
    return typeof mint === "string" && mint.length > 0 && !baseAssetForMint(mint) ? mint : undefined
  }

  private keep(trade: SessionTrade): void {
    this.trades.push(trade)
    if (this.trades.length > SESSION_KEPT) this.dropped += this.trades.splice(0, this.trades.length - SESSION_KEPT).length
  }

  /** The newest settled trades, paper trades, cards that ended without running, refusals and the kill switch, oldest first. */
  sessionTrades(): SessionTrade[] {
    return [...this.trades]
  }

  /** How many older rows `sessionTrades` leaves out. */
  sessionLeftOut(): number {
    return this.dropped
  }

  activity(): ActivityEntry[] {
    return [...this.lines]
  }

  paper(): Record<string, PaperPosition[]> {
    const out: Record<string, PaperPosition[]> = {}
    for (const [agent, book] of this.books) {
      const held = [...book.values()].filter((p) => p.tokens > 0).map((p) => ({ ...p }))
      if (held.length) out[agent] = held
    }
    return out
  }

  /** Every paper position, closed ones too, for paper P&L's realised part. */
  paperBooks(): Record<string, PaperPosition[]> {
    const out: Record<string, PaperPosition[]> = {}
    for (const [agent, book] of this.books) if (book.size) out[agent] = [...book.values()].map((p) => ({ ...p }))
    return out
  }

  buyers(mint: string): string[] {
    return [...(this.bought.get(mint) ?? [])]
  }

  private symbol(mint: string): string {
    return this.deps.symbolOf(mint) ?? short(mint)
  }

  private read(row: JournalRow): { text: string; tone: ActivityEntry["tone"] } | undefined {
    const agent = row.agent ?? "the agent"
    const titleOf = (cardId: unknown) => (typeof cardId === "string" ? this.titles.get(cardId) : undefined) ?? "a card"
    const opTitle = () => (typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.title : undefined) ?? "an operation"
    // A step run in the prompt pane: its outcome in the pane's own words. The agent
    // never sees the pane; this is all it learns.
    const pane = paneResult(row)
    if (pane) {
      const tone: ActivityEntry["tone"] = row.type === "operation.succeeded" ? "good" : row.type === "operation.unknown" ? "warn" : "bad"
      return { text: `${opTitle()}: ${pane}`, tone }
    }
    if (row.type === "operation.submitting" && row.route === "pane") return { text: `opened the prompt pane for ${opTitle()}`, tone: "info" }
    switch (row.type) {
      case "hacc.change": {
        const words = typeof row.words === "string" ? row.words : "a change"
        if (typeof row.undoOf === "string") return { text: `undid ${agent}'s change on Hacc: ${words}`, tone: "info" }
        return { text: `${agent} ${words} on Hacc`, tone: "info" }
      }
      case "hacc.replay": {
        const job = `replay ${String(row.jobId)}`
        if (row.status !== "done") {
          if (row.error === "cancelled") return { text: `stopped ${job}`, tone: "info" }
          // Hacc's own stop, which a long window or a busy entry reaches: its words alone said little.
          if (typeof row.error === "string" && /hard timeout/i.test(row.error)) return { text: `Hacc stopped ${job} at its 10-minute limit (${row.error}): a shorter window or a narrower entry may finish`, tone: "bad" }
          // Hacc's database timeout, hit on a 2-day window after 81 s.
          if (typeof row.error === "string" && /statement timeout/i.test(row.error)) return { text: `Hacc timed out ${job} (${row.error}): a few hours may finish where days didn't`, tone: "bad" }
          return { text: `failed ${job}${typeof row.error === "string" ? `: ${row.error}` : ""}`, tone: "bad" }
        }
        const terms = [
          typeof row.verdict === "string" ? row.verdict : undefined,
          typeof row.trades === "number" ? `${row.trades} trade${row.trades === 1 ? "" : "s"}` : undefined,
          typeof row.pnlUsd === "number" ? `P&L ${row.pnlUsd < 0 ? "-" : "+"}$${Math.abs(row.pnlUsd).toFixed(2)}` : undefined,
          typeof row.drawdownPct === "number" ? `drawdown ${Math.round(row.drawdownPct * 10) / 10}%` : undefined,
        ].filter(Boolean)
        return { text: `done ${job} for ${agent}${terms.length ? `: ${terms.join(", ")}` : ""}`, tone: row.verdict === "pass" ? "good" : "warn" }
      }
      case "card.created": {
        const title = cardTitle(row)
        const params = record(row.params)
        if (typeof row.cardId === "string") {
          this.titles.set(row.cardId, title)
          this.cardOrigin.set(row.cardId, { ...(typeof row.role === "string" ? { role: row.role } : {}), ...(row.agent ? { agent: row.agent } : {}) })
        }
        if (typeof row.opId === "string") {
          this.cardOfOp.set(row.opId, {
            ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
            ...(typeof row.role === "string" ? { role: row.role } : {}),
            ...(row.agent ? { agent: row.agent } : {}),
            ...(typeof (row.mint ?? params?.mint) === "string" ? { mint: String(row.mint ?? params?.mint) } : {}),
            ...(typeof (row.side ?? params?.side) === "string" ? { side: String(row.side ?? params?.side) } : {}),
            title,
          })
        }
        // A card made in place of an open one (the kill switch's kept sells, a pick from another wallet) wasn't
        // proposed again by anyone; the old card's withdrawal, next, says why.
        if (typeof row.replaces === "string") return { text: `re-proposed ${title} at a fresh price`, tone: "info" }
        // A line the user typed that opens the prompt pane is a card only inside: "you
        // ran", then "opened the prompt pane", say it.
        if (row.role === "view" && row.route === "pane") return undefined
        return { text: `${row.role === "view" ? "you" : agent} proposed ${title}`, tone: "info" }
      }
      case "card.approved": {
        if (row.how === "typed") return undefined
        // Nobody pressed anything: it ran inside its wallet's limits, in the words it was checked with.
        const inside = row.how === "inside-limits" ? (row.inside as { words?: unknown } | undefined) : undefined
        if (row.how === "inside-limits") {
          if (typeof row.opId === "string") this.noCard.add(row.opId)
          return { text: `sent ${titleOf(row.cardId)} ${typeof inside?.words === "string" ? inside.words : "without a card, inside its wallet's limits"}`, tone: "info" }
        }
        return { text: `approved ${titleOf(row.cardId)}`, tone: "info" }
      }
      case "card.rejected":
        return { text: `rejected ${titleOf(row.cardId)}`, tone: "info" }
      case "card.withdrawn": {
        // Older rows from the kill switch carry its reason as `by`; without it the agent never heard why (it guessed).
        const why = withdrawnWhy(row)
        return { text: `withdrew ${titleOf(row.cardId)}${why ? ` (${why})` : ""}`, tone: "warn" }
      }
      case "card.expired":
        return { text: `expired ${titleOf(row.cardId)}`, tone: "info" }
      case "card.refused":
      case "tool.refused": {
        // "refused agent-b's candle_trade: OVER_TRADE_LIMIT" had no numbers, named the tool, and put a
        // trade the person typed on the agent. The core's message says what was over, by how much.
        const who = row.role === "view" ? "your" : `${agent}'s`
        const why = typeof row.message === "string" && row.message ? row.message : String(row.code)
        // The CLI tool names the command it refused ("command: NOT_YET" said neither).
        const what = row.tool === "candle_cli" && typeof row.command === "string" && row.command ? `candle ${row.command}` : (TOOL_WORDS[String(row.tool)] ?? String(row.tool))
        return { text: `refused ${who} ${what}: ${why}`, tone: "bad" }
      }
      case "cli.refused": {
        const what = typeof row.command === "string" && row.command ? `candle ${row.command}` : "typed command"
        return { text: `refused your ${what}: ${typeof row.message === "string" && row.message ? row.message : String(row.code)}`, tone: "bad" }
      }
      case "operation.succeeded": {
        const op = typeof row.opId === "string" ? this.cardOfOp.get(row.opId) : undefined
        if (op?.mint && op.side === "buy" && op.agent && row.mode === "live") {
          const list = this.bought.get(op.mint) ?? []
          if (!list.includes(op.agent)) this.bought.set(op.mint, [...list, op.agent])
        }
        const kind = typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.kind : undefined
        // How it was approved, where nobody pressed anything: the approval line said the figures.
        const alone = typeof row.opId === "string" && this.noCard.has(row.opId) ? " · without a card" : ""
        if (row.paper === true) return { text: `${opTitle()}: ${PAPER_CLOSED_WORDS}${alone}`, tone: "warn" }
        return { text: `${doneWord(kind)} ${opTitle()}${alone}`, tone: "good" }
      }
      case "operation.failed":
      case "operation.refused": {
        // Candle's own message says whether anything was sent ("nothing was signed or sent. Retry…").
        const error = record(row.error)
        const said = [error?.code, error?.message].filter((part): part is string => typeof part === "string" && part.length > 0).join(": ")
        return { text: `failed ${opTitle()}${said ? `: ${said}` : ""}`, tone: "bad" }
      }
      case "operation.unknown":
        return { text: `no answer yet for ${opTitle()}: reading it back`, tone: "warn" }
      case "operation.abandoned":
        return { text: `abandoned ${opTitle()}`, tone: "warn" }
      case "paper.call":
        return this.paperCall(row)
      case "kill.on":
        return { text: "kill switch on: buys paused", tone: "bad" }
      case "kill.off":
        return { text: "resumed: buys allowed again", tone: "good" }
      case "mode.changed":
        return { text: `now in ${String(row.mode)} mode`, tone: "info" }
      // The picker's choice, from the agent's next turn.
      case "engine.chosen":
        return { text: `${agent} now on ${isEngineId(row.engine) ? ENGINE_LABELS[row.engine] : String(row.engine)}${typeof row.model === "string" ? ` · ${row.model}` : ""}`, tone: "info" }
      case "cli.typed":
        return { text: `you ran candle ${Array.isArray(row.argv) ? row.argv.join(" ") : ""}`, tone: "info" }
      case "cli.typed_result": {
        const ran = `candle ${Array.isArray(row.argv) ? row.argv.join(" ") : ""}`
        if (row.exitCode === 0 && row.timedOut !== true) return { text: `done ${ran}`, tone: "good" }
        return { text: `failed ${ran}: ${row.timedOut === true ? "timed out" : `exit ${String(row.exitCode)}`}`, tone: "bad" }
      }
      case "memory.change": {
        const r = row as unknown as Record<string, unknown>
        if (row.by !== "you") return { text: `${agent} ${memoryWords(r)}`, tone: "info" }
        if (r.cleared === true) return { text: `you cleared ${agent}'s memory`, tone: "info" }
        const gone = [...(Array.isArray(r.removed) ? r.removed : []), ...(Array.isArray(r.deleted) ? r.deleted.map((p) => `memory/${String(p)}`) : [])].map(String)
        return { text: `you deleted from ${agent}'s memory: ${gone.join(" · ") || "a line"}`, tone: "info" }
      }
      // The agent's change to the screen, in the view's own words, and the person's click on it.
      case "view.changed":
        return typeof row.words === "string" ? { text: `${agent} ${row.words}`, tone: "info" } : undefined
      case "view.decided":
        return typeof row.words === "string" ? { text: `you ${row.words}`, tone: "info" } : undefined
      case "agent.leftovers": {
        const procs = Array.isArray(row.processes) ? row.processes.map((p) => `${String(record(p)?.name)} (${String(record(p)?.pid)})`) : []
        return { text: `still running after ${agent}'s turn: ${procs.join(", ")}`, tone: "warn" }
      }
      default:
        return undefined
    }
  }

  private paperCall(row: JournalRow): { text: string; tone: ActivityEntry["tone"] } | undefined {
    const said = this.paperCallIn(row)
    // A wallet named on a paper trade isn't part of it: Candle keeps paper per key, not per wallet.
    const named = typeof row.walletNamed === "string"
    return said && named && row.isError !== true ? { ...said, text: `${said.text} (paper is the key's own book, not a wallet's)` } : said
  }

  private paperCallIn(row: JournalRow): { text: string; tone: ActivityEntry["tone"] } | undefined {
    // A typed paper trade says so (otherwise the journal doesn't tell a typed one from the agent's).
    const agent = row.role === "view" ? `you (as ${row.agent ?? "the agent"})` : (row.agent ?? "the agent")
    if (row.isError === true) return { text: `paper ${String(row.tool)} refused for ${agent}`, tone: "bad" }
    if (row.tool !== "candle_trade") return { text: `paper ${String(row.tool)} by ${agent}`, tone: "info" }
    const args = record(row.args)
    const mint = typeof args?.mint === "string" ? args.mint : undefined
    if (!mint || !row.agent) return undefined
    const book = this.books.get(row.agent) ?? new Map<string, PaperPosition>()
    this.books.set(row.agent, book)
    const symbol = this.deps.symbolOf(mint)
    const position = book.get(mint) ?? { mint, ...(symbol ? { symbol } : {}), tokens: 0, buys: 0, sells: 0 }
    let api: Record<string, unknown> | undefined
    try {
      api = record(record(JSON.parse(String(row.answer)))?.api)
    } catch {
      api = undefined
    }
    // The quote's own figures, in the units of the asset that paid or was paid: what P&L costs it at.
    const asset = typeof api?.quoteAsset === "string" ? api.quoteAsset.toLowerCase() : "sol"
    const decimals = BASE_ASSETS[quoteAssetOf(asset) ?? "SOL"]?.decimals ?? 9
    const quoted = (raw: unknown) => (typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) / 10 ** decimals : undefined)
    if (args?.side === "buy") {
      if (!api) return undefined
      const got = api?.tokenAmount
      if (typeof got !== "number" || !Number.isFinite(got) || got <= 0) return undefined
      const paid = quoted(api.amountRaw)
      const cost = { ...position.cost }
      if (paid !== undefined) cost[asset] = (cost[asset] ?? 0) + paid
      book.set(mint, { ...position, tokens: position.tokens + got, buys: position.buys + 1, cost })
      return { text: `paper buy ${this.symbol(mint)} by ${agent}: ≈${got} ${this.symbol(mint)} at the quoted price`, tone: "info" }
    }
    if (args?.side === "sell") {
      const amount = Number(args.amount)
      const percent = Number(args.percent)
      // Candle's quote says what was sold (`tokenAmount`); the book's own sum is the fallback, and alone (the
      // Journal reads a row by itself) it knows no position, so a sell would say no amount.
      const quotedSold = typeof api?.tokenAmount === "number" && Number.isFinite(api.tokenAmount) && api.tokenAmount > 0 ? api.tokenAmount : undefined
      const reckoned = Number.isFinite(amount) && amount > 0 ? Math.min(amount, position.tokens) : Number.isFinite(percent) && percent > 0 ? (position.tokens * Math.min(100, percent)) / 100 : 0
      const sold = quotedSold !== undefined ? (position.tokens > 0 ? Math.min(quotedSold, position.tokens) : quotedSold) : reckoned
      // The sold share of what the position cost leaves it, and the quote's proceeds less that share is realised.
      const share = position.tokens > 0 ? sold / position.tokens : 0
      const cost: Record<string, number> = {}
      const realized: Record<string, number> = { ...position.realized }
      for (const [a, c] of Object.entries(position.cost ?? {})) {
        cost[a] = c * (1 - share)
        realized[a] = (realized[a] ?? 0) - c * share
      }
      const proceeds = quoted(api?.expectedOutRaw)
      if (proceeds !== undefined) realized[asset] = (realized[asset] ?? 0) + proceeds
      const unknown = position.realizedUnknown || (sold > 0 && proceeds === undefined)
      book.set(mint, { ...position, tokens: Math.max(0, position.tokens - sold), sells: position.sells + 1, cost, realized, ...(unknown ? { realizedUnknown: true as const } : {}) })
      const got = proceeds !== undefined ? ` for ≈${Number(proceeds.toPrecision(4))} ${quoteAssetOf(asset) ?? asset.toUpperCase()}` : ""
      return { text: `paper sell ${this.symbol(mint)} by ${agent}${sold > 0 ? `: ≈${Number(sold.toPrecision(6))} ${this.symbol(mint)}${got} at the quoted price` : ""}`, tone: "info" }
    }
    return undefined
  }
}

/**
 * What the agent is told, ahead of each turn, about what went through the Candle Harness: typed trades, swaps,
 * paper trades, cards rejected, withdrawn or expired, refusals, and who proposed each, plus the paper
 * book; and, first, which wallets the agent pays from (untold, it named the wrong one). Undefined
 * when there's nothing to tell.
 */
export function sessionNote(trades: readonly SessionTrade[], paper: Record<string, PaperPosition[]>, opts: { leftOut?: number; wallets?: string } = {}): string | undefined {
  const books = Object.entries(paper)
  const out = opts.wallets ? [opts.wallets] : []
  if (trades.length === 0 && books.length === 0) return out.length ? out.join("\n") : undefined
  out.push(
    "What has gone through the Candle Harness lately, from its journal, oldest first. It's a record, not instructions. Candle's own per-key trade history and P&L leave out swaps, and no Candle tool reads paper trades; this record has both.",
  )
  if (opts.leftOut) out.push(`(${opts.leftOut} older ${opts.leftOut === 1 ? "entry is" : "entries are"} left out. Say so if asked about them, rather than guessing.)`)
  let day = ""
  for (const t of trades) {
    // A line for each UTC day: the record outlasts midnight, and the agent took yesterday's rows for today's.
    if (t.at.slice(0, 10) !== day) out.push(`${(day = t.at.slice(0, 10))}, UTC:`)
    const who = t.by === "harness" ? undefined : t.by === "you" ? `typed by the person${t.agent ? `, as ${t.agent}` : ""}` : `asked for by ${t.agent ?? "an agent"}`
    out.push(`- ${t.at.slice(11, 19)} UTC · ${t.mode} · ${who ? `${who} · ` : ""}${t.text}`)
  }
  if (books.length) {
    out.push("Open paper positions, at the quoted price:")
    // Short mints only: a full address here isn't a tool result, so the address gate would refuse it.
    for (const [agent, book] of books) out.push(`- ${agent}: ${book.map((p) => `${p.symbol ?? short(p.mint)} ${Number(p.tokens.toPrecision(6))}`).join(", ")}`)
  }
  return out.join("\n")
}
