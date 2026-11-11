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
import { terminalText } from "../shared/terminal-text"
import { isTestName, shownBotName } from "../shared/bot-name"
import { ranWithoutCard } from "../shared/approved-how"
import { botVerb, verbPhrase } from "../shared/notify"
import { ENGINE_LABELS, isEngineId } from "../engine/engine"
import { BASE_ASSETS, baseAssetForMint, quoteAssetOf } from "./assets"
import type { JournalRow } from "./journal"
import { memoryWords } from "./memory"
import { tokenLabel } from "../shared/token-label"
import { short } from "./wallet-names"
import { addressKey, type ChainSlug, EVM_ADDRESS_SOURCE, SOLANA_ADDRESS_SOURCE, storedChain } from "../shared/chains"

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
  /** That token's chain: the chain filter and the chain tag follow it. */
  chain?: ChainSlug
  /** A trigger's card that expired with nobody there: its id, for the `run it now` chip. */
  runNow?: string
  /**
   * A trigger's firing, drawn as one line ("⚡ jupf stop  JUPF was $0.3990, under $0.40 → filled …"): the
   * trigger's name and what it saw then what came of it, kept up to date as its card and trade go. `text` stays
   * the row's own words, for the Journal and notices; the firing's other rows are `hidden`.
   */
  firing?: { name: string; said: string; paper?: true; bot?: true }
}

/** One of a bot's entries or exits in its Activity line: what it's doing or did, in words. */
interface BotAct {
  words: string
  tone: ActivityEntry["tone"]
  /** Filled: an entry in, an exit out, a swap. */
  done?: "in" | "out" | "swap"
  /** Sent or proposed, not filled yet. */
  pending?: "buying" | "selling" | "swapping"
  /** A code bot's swap, as it reads: "0.1 SOL to USDC". */
  swap?: string
  paper?: boolean
  mint?: string
  /** An entry's dollars, for its fill's words. */
  usd?: number
  /** An exit's reason, for its fill's words. */
  reason?: string
  /** Which way it trades, kept through a card that waits: a buy's fill is never read as a sale. */
  side?: "in" | "out"
}

/**
 * A bot's line in Activity: its entries, exits and skips while nothing else comes between ("bought BONK, WIF ·
 * took profit on MOON · 4 skipped"). An exit at a stop, a refusal, a failure and a card that waits for the person stand alone.
 */
interface BotFold {
  entry: ActivityEntry
  name: string
  acts: Map<string, BotAct>
  last?: string
  skipped: number
  skipWords?: string
  /** Others of the bot's may join it; a line that stands alone takes only its own act's rows. */
  open: boolean
}

/** A firing's parts so far, by its card (or a paper trade, by its row), for its one line. */
interface Firing {
  entry: ActivityEntry
  saw: string
  at: number
  parts: Map<string, { said: string; tone: ActivityEntry["tone"] }>
  /** The firing's own ending, said after its parts: stopped, held, notified, woke. */
  end?: { said: string; tone: ActivityEntry["tone"] }
}

/** A firing's rows past `trigger.fired`, by type, which its one line says in place of their own. */
const FIRING_ROWS = new Set(["card.created", "card.approved", "card.rejected", "card.withdrawn", "card.expired", "card.refused", "operation.succeeded", "operation.failed", "operation.refused", "operation.unknown", "operation.abandoned", "paper.call", "trigger.waiting", "trigger.notify", "trigger.woke", "trigger.wake_skipped", "trigger.held", "trigger.ran"])

/** "5.0 s", from a firing to its fill. */
const secs = (ms: number): string => (ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)

/** One trade, swap or narrowing that settled, or a paper trade, as the agent is told it. */
export interface SessionTrade {
  at: string
  mode: string
  agent?: string
  /** Who proposed it: the person typed it, the agent asked for it, a trigger fired or a bot traded; "harness" for the Candle Harness's own state, the kill switch. */
  by: "you" | "agent" | "trigger" | "bot" | "harness"
  /** The trigger's name, when a trigger fired it. */
  trigger?: string
  /** The rules bot's name, when it was a bot's trade. */
  bot?: string
  /** The trigger whose wake started the agent's turn that asked for it. */
  woken?: string
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

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/** How a bot's entry or exit that ended with nothing reads: a refusal or failure is bad, a card nobody pressed a warning. */
const endedTone = (outcome: unknown): ActivityEntry["tone"] => (outcome === "refused" || outcome === "failed" || outcome === "lost" ? "bad" : outcome === "expired" ? "warn" : "info")

/** Every address in a line, short: "MoonFake111…1111" as "Moon…1111". */
export const shortAddresses = (text: string): string => text.replace(new RegExp(`\\b(?:${SOLANA_ADDRESS_SOURCE}|${EVM_ADDRESS_SOURCE})\\b`, "g"), short)

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
  candle_bridge: "bridge",
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
  harness_triggers: "trigger",
  harness_bots: "bot",
}
/** How a card's kind says it went through: trades and swaps fill, a launch launches; anything else (a revoke, a claim) is done. */
const DONE_WORDS: Record<string, string> = { trade: "filled", swap: "filled", bridge: "arrived", launch: "launched", upload: "uploaded", trigger: "saved" }
/**
 * A live sell Candle answered by closing the key's paper position, because the live wallet held none of
 * the token: nothing live was sold, so nowhere says "filled".
 */
export const PAPER_CLOSED_WORDS = "not sold live: the wallet held none, so Candle closed this key's paper position instead"

/**
 * A bridge's unknowns the core no longer follows (Relay's result Candle couldn't tie to one fill, two hours with no
 * result, no balance to follow it by, no answer from Candle in ten minutes): its own words say why and where to look.
 */
export const BRIDGE_NOT_FOLLOWED: ReadonlySet<string> = new Set(["BRIDGE_UNCERTAIN", "BRIDGE_PAST_TWO_HOURS", "BRIDGE_UNFOLLOWED", "BRIDGE_NO_ANSWER"])

/** Whether Candle's job behind an operation has ended `failed`: the job itself, or the body around it. */
export function candleJobFailed(result: unknown): boolean {
  const body = record(result)
  return (record(body?.job) ?? body)?.status === "failed"
}

/**
 * Whether an unknown operation is one the core reads no further, its error's words saying why and where to look: a
 * bridge it stopped following, or a trade whose job Candle has ended that may still have filled (a Hood trade whose
 * trade step was sent). Anything else unknown is still being read back.
 */
export function notFollowedFurther(op: { kind?: string | undefined; error?: unknown; result?: unknown }): boolean {
  const error = record(op.error)
  if (typeof error?.code !== "string" || typeof error.message !== "string" || error.message === "") return false
  if (op.kind === "bridge") return BRIDGE_NOT_FOLLOWED.has(error.code)
  return candleJobFailed(op.result)
}

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

/** A token amount as the screen rounds it: 17,479 rather than 17479.380519. The exact figure stays in the row. */
export function tokenFigure(n: number): string {
  const abs = Math.abs(n)
  if (abs === 0) return "0"
  return n.toLocaleString("en-US", abs < 1 ? { maximumSignificantDigits: 3 } : abs < 1000 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 0 })
}

/** A trigger by name, in Activity's words: `trigger "JUP < $0.40"`. */
export const triggerName = (name: unknown): string => `trigger "${String(name ?? "")}"`

/** A rules bot by name, in Activity's words: `the bot "confluence-small"`. */
export const botName = (name: unknown): string => (isTestName(String(name ?? "")) ? shownBotName(String(name)) : `the bot "${String(name ?? "")}"`)
/** A code bot by name: `the code bot "grid"`. */
const codeBotName = (name: unknown): string => (isTestName(String(name ?? "")) ? shownBotName(String(name)) : `the code bot "${String(name ?? "")}"`)

/** How a bot's exit reason reads after what it sold: "sold JUPF at its take profit". */
const EXIT_WORDS: Record<string, string> = { take_profit: "at its take profit", stop_loss: "at its stop", max_hold: "at its max hold", trailing_stop: "at its trailing stop", flatten: "to flatten", bot: "" }
export const exitWords = (reason: unknown): string => EXIT_WORDS[String(reason)] ?? "as its exit"
/** "sold MOON at its stop", or "sold MOON" for a code bot's own sell, which has no exit's why. */
const soldWords = (token: string, reason: unknown): string => [`sold ${token}`, exitWords(reason)].filter(Boolean).join(" ")

/** A bot's rows that are about one of its entries, by its signal; and one of its exits, by its position. */
const BOT_ENTRY_ROWS = new Set(["bot.entering", "bot.waiting", "bot.entry_ended"])
const BOT_EXIT_ROWS = new Set(["bot.exiting", "bot.exit_waiting", "bot.exit_ended", "bot.exit_held", "bot.position_left"])
/** A code bot's rows about one of its own requests, by its id. */
const BOT_REQUEST_ROWS = new Set(["bot.request", "bot.request_waiting", "bot.request_ended"])
/** A code bot's process as Activity says it: a crash, giving up, ending on its own, a warning; a start and a core's own stop are the Journal's. */
const PROCESS_TONES: Readonly<Record<string, ActivityEntry["tone"]>> = { crashed: "warn", gave_up: "bad", warning: "warn", ended: "info", supervisor_failed: "bad" }

/** Why a card was withdrawn, in words, from its `card.withdrawn` row; undefined where it gave none. */
export const withdrawnWhy = (row: JournalRow): string | undefined => WITHDRAWN_WHY[String(row.reason ?? row.by)]

export class TradeLog {
  private readonly lines: ActivityEntry[] = []
  private readonly titles = new Map<string, string>()
  /** Operations the core ran without a card: their fill says so. */
  private readonly noCard = new Set<string>()
  /** Each card's token, for the lines after its proposal (approved, rejected, expired). */
  private readonly mintOfCard = new Map<string, string>()
  /** Each card's chain, as it was made; an old row's, by its token's address. */
  private readonly chainOfCard = new Map<string, ChainSlug>()
  /** Each operation's card. */
  private readonly cardIdOfOp = new Map<string, string>()
  private readonly cardOrigin = new Map<string, { role?: string; agent?: string; trigger?: string; woken?: string; bot?: string }>()
  private readonly cardOfOp = new Map<string, { kind?: string; role?: string; agent?: string; mint?: string; side?: string; title: string; trigger?: string; woken?: string; bot?: string; botAct?: string; botReason?: string; paper?: boolean }>()
  /** Each firing's one line, by its id; and the firing each of its cards and operations belongs to. */
  private readonly firings = new Map<string, Firing>()
  private readonly fireOf = new Map<string, string>()
  private readonly trades: SessionTrade[] = []
  /** Rows dropped from the front of `trades`, so the agent is told its record isn't the whole day. */
  private dropped = 0
  /** Who bought each token, keyed by its address key (an EVM mint lowercased). */
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
    // A fill's time runs from when it was sent, as the agent pane's receipt says it, not from the firing.
    if (row.type === "operation.submitting" && typeof row.opId === "string") {
      this.sentAt.set(row.opId, Date.parse(row.at))
      if (this.sentAt.size > 200) this.sentAt.delete(this.sentAt.keys().next().value!)
    }
    const text = this.read(row)
    if (!text) return
    const hacc = row.type === "hacc.change" ? { ...(typeof row.undoOf === "string" ? { undoes: row.undoOf } : record(row.undo) && typeof row.changeId === "string" ? { undo: row.changeId } : {}) } : {}
    const byCard = row.type === "hacc.change" && row.by === "card"
    const mint = this.mintOf(row)
    const chain = mint ? this.chainOf(row, mint) : undefined
    const runNow = row.type === "card.expired" && typeof row.trigger === "string" && typeof row.cardId === "string" ? { runNow: row.cardId } : {}
    const entry: ActivityEntry = { seq: row.seq, at: row.at, ...(row.agent ? { agent: row.agent } : {}), text: text.text, tone: text.tone, ...hacc, ...(byCard ? { hidden: true as const } : {}), ...(mint ? { mint } : {}), ...(chain ? { chain } : {}), ...runNow }
    const firing = this.firingOf(row, entry, text) ?? this.botFoldOf(row, entry, text)
    if (firing === "part") entry.hidden = true
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
      const trigger = typeof row.trigger === "string" ? row.trigger : ((typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.trigger : undefined) ?? origin?.trigger)
      const woken = typeof row.woken === "string" ? row.woken : ((typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.woken : undefined) ?? origin?.woken)
      const bot = typeof row.bot === "string" ? row.bot : ((typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.bot : undefined) ?? origin?.bot)
      // The note's prefix says whose it was, so a refusal leaves out "your" (to the agent, that's it). These are
      // the Candle Harness's own refusals, before anything reached Candle (the agent once called one Candle's).
      const said = ownRole && row.type !== "paper.call" ? text.text.replace(/^refused (?:your|\S+'s) (.+?): /, "the Candle Harness refused the $1 (nothing reached Candle): ") : text.text
      this.keep({ at: row.at, mode: String(row.mode ?? ""), ...(agent ? { agent } : {}), by: trigger ? "trigger" : bot ? "bot" : role === "view" ? "you" : "agent", ...(trigger ? { trigger } : {}), ...(bot && !trigger ? { bot } : {}), ...(woken && !trigger && !bot ? { woken } : {}), text: said })
    }
    // The kill switch going on and off (untold, the agent said buys were still paused after a resume).
    if (row.type === "kill.on" || row.type === "kill.off") this.keep({ at: row.at, mode: String(row.mode ?? ""), by: "harness", text: text.text })
    // Hacc's changes and replays: the agent learns what the person undid, and how a replay ended.
    if ((row.type === "hacc.change" && !byCard) || row.type === "hacc.replay") this.keep({ at: row.at, mode: String(row.mode ?? ""), ...(row.agent ? { agent: row.agent } : {}), by: row.by === "you" ? "you" : "agent", text: text.text })
    this.deps.onLine?.(entry)
    // The firing's one line, said again with this row's part: the view puts it in its place. A bot's line too,
    // and the line an act that came to stand alone left.
    if (firing === "part" || firing === "start") {
      const f = this.firings.get(this.fireOf.get(this.partKey(row) ?? "") ?? String(row.fireId ?? ""))
      if (f && firing === "part") this.deps.onLine?.(f.entry)
      for (const e of this.botSaid.splice(0)) if (e !== entry) this.deps.onLine?.(e)
    }
  }

  /** A firing's one line as it stands ("JUPF was $0.3990, under $0.40 → … filled in 5.0 s"), and its tone. */
  firingLine(fireId: string): { name: string; said: string; tone: ActivityEntry["tone"] } | undefined {
    const f = this.firings.get(fireId)
    return f?.entry.firing ? { name: f.entry.firing.name, said: f.entry.firing.said, tone: f.entry.tone } : undefined
  }

  /** Where a row's part of a firing is kept: its card, its operation's card, or its own row (a paper trade). */
  private partKey(row: JournalRow): string | undefined {
    if (typeof row.cardId === "string") return `card:${row.cardId}`
    if (typeof row.opId === "string") return this.opCard.get(row.opId) ? `card:${this.opCard.get(row.opId)}` : `op:${row.opId}`
    return undefined
  }
  private readonly opCard = new Map<string, string>()
  private readonly sentAt = new Map<string, number>()
  /** Each trigger's last firing line, for folding a run of notices into it. */
  private readonly folds = new Map<string, { f: Firing; count: number; last: number }>()

  /**
   * A trigger's firing as one Activity line: `trigger.fired` starts it, and each row after it with its firing's
   * id (or its card's or operation's) adds its part, in place of a line of its own. "part" when the row is one.
   */
  private firingOf(row: JournalRow, entry: ActivityEntry, text: { text: string; tone: ActivityEntry["tone"] }): "start" | "part" | undefined {
    if (row.type === "card.created" && typeof row.cardId === "string" && typeof row.opId === "string") this.opCard.set(row.opId, row.cardId)
    if (row.type === "trigger.fired" && typeof row.fireId === "string" && typeof row.name === "string") {
      const saw = typeof row.words === "string" && row.words ? row.words : "its condition was met"
      // A trigger that only notifies, firing again with nothing else said since its last line, joins that line
      // as a count: a busy tape pattern fired 70 times in 20 minutes and buried everything else.
      const fold = this.folds.get(row.name)
      const shown = this.lines.findLast((e) => !e.hidden)
      const at = Date.parse(row.at)
      if (fold && shown === fold.f.entry && fold.f.parts.size === 0 && fold.f.end?.said.startsWith("notified") && at - fold.last < 10 * 60_000) {
        fold.count += 1
        fold.last = at
        fold.f.saw = `${saw} · fired ${fold.count} times since ${new Date(fold.f.at).toTimeString().slice(0, 5)}`
        fold.f.entry.firing = { name: row.name, said: fold.f.saw }
        this.firings.set(row.fireId, fold.f)
        return "part"
      }
      entry.firing = { name: row.name, said: saw }
      const f: Firing = { entry, saw, at, parts: new Map() }
      this.firings.set(row.fireId, f)
      this.folds.set(row.name, { f, count: 1, last: at })
      if (this.folds.size > 200) this.folds.delete(this.folds.keys().next().value!)
      if (this.firings.size > 200) this.firings.delete(this.firings.keys().next().value!)
      return "start"
    }
    if (!FIRING_ROWS.has(row.type)) return undefined
    const key = this.partKey(row)
    const fireId = typeof row.fireId === "string" ? row.fireId : key ? this.fireOf.get(key) : undefined
    const f = fireId ? this.firings.get(fireId) : undefined
    if (!f || !fireId) return undefined
    if (key) this.fireOf.set(key, fireId)
    const title = typeof row.cardId === "string" ? this.titles.get(row.cardId) : typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.title : undefined
    const part = (said: string, tone: ActivityEntry["tone"]) => f.parts.set(key ?? `row:${row.seq}`, { said, tone })
    switch (row.type) {
      case "card.created":
        break
      case "card.approved":
        part(ranWithoutCard(row.how) ? `${title ?? "its trade"} sent without a card` : `you approved ${title ?? "its card"}`, "info")
        break
      case "operation.succeeded":
        part(text.tone === "good" ? `${text.text.replace(/ · by trigger "[^"]*"$/, "").replace(/ · without a card$/, "")} in ${secs(Date.parse(row.at) - (this.sentAt.get(String(row.opId)) ?? f.at))}${this.noCard.has(String(row.opId)) ? ", without a card" : ""}` : text.text, text.tone)
        break
      case "trigger.waiting":
        part(typeof row.words === "string" ? row.words : `${title ?? "its trade"} waits for you`, "warn")
        break
      case "card.expired":
        part(`${title ?? "its card"} expired, nobody pressed it`, "warn")
        if (typeof row.cardId === "string") f.entry.runNow = row.cardId
        break
      case "trigger.notify":
        f.end = { said: typeof row.words === "string" && row.words ? `notified: ${row.words}` : "notified you", tone: "info" }
        break
      case "trigger.woke":
        f.end = { said: row.joined === true ? `joined ${String(row.woke ?? "the agent")}'s woken turn` : `woke ${String(row.woke ?? "the agent")}`, tone: "info" }
        break
      case "trigger.ran":
        if (row.outcome !== "stopped") return "part"
        f.end = { said: `stopped: ${String(row.words ?? "")}`, tone: "bad" }
        break
      case "trigger.held":
      case "trigger.wake_skipped":
        f.end = { said: String(row.words ?? text.text), tone: "warn" }
        break
      default:
        part(text.text.replace(/ · by trigger "[^"]*"$/, ""), text.tone)
    }
    const said = [...[...f.parts.values()].map((p) => p.said), ...(f.end ? [f.end.said] : [])]
    const tones = [...[...f.parts.values()].map((p) => p.tone), ...(f.end ? [f.end.tone] : [])]
    // A paper trade makes no card, so the agent pane has nothing of its own to show it by: it draws this line.
    const paper = f.entry.firing!.paper || row.type === "paper.call"
    f.entry.firing = { name: f.entry.firing!.name, said: said.length ? `${f.saw} → ${said.join("; ")}` : f.saw, ...(paper ? { paper: true as const } : {}) }
    f.entry.tone = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : tones.length && tones.every((t) => t === "good") ? "good" : "info"
    return "part"
  }

  /** Each bot's newest line, its acts' lines by key, and the act each card and operation is part of. */
  private readonly botFolds = new Map<string, BotFold>()
  private readonly actFold = new Map<string, BotFold>()
  private readonly actOf = new Map<string, { name: string; key: string }>()
  /** Bot lines a row changed besides its own, said again after it. */
  private readonly botSaid: ActivityEntry[] = []
  /**
   * Each position's exit try: a sell that ended (a revert, a refusal) and is tried again is a new act, so the
   * try that failed keeps its own line rather than being written over by the next.
   */
  private readonly exitTry = new Map<string, number>()

  private exitKey(position: string): string {
    const n = this.exitTry.get(position) ?? 0
    return n ? `x:${position}#${n}` : `x:${position}`
  }

  /** A row's bot and the act it's part of: an entry by its signal, an exit by its position; a skip has no act. */
  private botRow(row: JournalRow): { name: string; key?: string } | undefined {
    if (row.type.startsWith("bot.")) {
      if (typeof row.name !== "string") return undefined
      if (BOT_REQUEST_ROWS.has(row.type)) return { name: row.name, ...(typeof row.request === "string" ? { key: `r:${row.name}:${row.request}` } : {}) }
      if (BOT_ENTRY_ROWS.has(row.type)) return { name: row.name, ...(typeof row.signalId === "number" ? { key: `e:${row.name}:${row.signalId}` } : {}) }
      if (BOT_EXIT_ROWS.has(row.type)) {
        if (typeof row.position !== "string") return { name: row.name }
        if (row.type === "bot.exiting") {
          // An earlier try that ended: this one is a new act of its own.
          const before = this.actFold.get(this.exitKey(row.position))?.acts.get(this.exitKey(row.position))
          if (before && before.pending === undefined) {
            this.exitTry.set(row.position, (this.exitTry.get(row.position) ?? 0) + 1)
            if (this.exitTry.size > 2_000) this.exitTry.delete(this.exitTry.keys().next().value!)
          }
        }
        return { name: row.name, key: this.exitKey(row.position) }
      }
      return row.type === "bot.skipped" ? { name: row.name } : undefined
    }
    if (typeof row.bot === "string" && (row.botAct === "entry" || row.botAct === "exit")) {
      // A code bot's own request goes by its id; an exit the core held for it, by its position as a rules bot's.
      const key = typeof row.botRequest === "string" ? `r:${row.bot}:${row.botRequest}` : row.botAct === "exit" ? (typeof row.botPosition === "string" ? this.exitKey(row.botPosition) : undefined) : typeof row.botSignal === "number" ? `e:${row.bot}:${row.botSignal}` : undefined
      if (key) {
        if (typeof row.cardId === "string") this.actOf.set(`c:${row.cardId}`, { name: row.bot, key })
        if (typeof row.opId === "string") this.actOf.set(`o:${row.opId}`, { name: row.bot, key })
        if (this.actOf.size > 2_000) this.actOf.delete(this.actOf.keys().next().value!)
      }
      return { name: row.bot, ...(key ? { key } : {}) }
    }
    const of = (typeof row.opId === "string" ? this.actOf.get(`o:${row.opId}`) : undefined) ?? (typeof row.cardId === "string" ? this.actOf.get(`c:${row.cardId}`) : undefined)
    return of
  }

  /**
   * A bot's row in Activity: its entries, exits and skips join the bot's line while nothing else comes between,
   * each act's later rows (its card, its fill) join the line its decision is on, and an act that goes wrong (a
   * refusal, a failure, a card that waits for you, a held sell) or an exit at a stop stands alone. "start" when
   * the row's own line is the bot's line, "part" when it joined one.
   */
  private botFoldOf(row: JournalRow, entry: ActivityEntry, text: { text: string; tone: ActivityEntry["tone"] }): "start" | "part" | undefined {
    const at = this.botRow(row)
    if (!at) return undefined
    const sym = (mint: unknown) => (typeof mint === "string" ? this.symbol(mint) : "a token")
    const paper = row.botMode === "paper" || (row.type === "paper.call" && row.isError !== true) || undefined
    let fold = at.key ? this.actFold.get(at.key) : undefined
    const had = fold?.acts.get(at.key ?? "")
    let act: BotAct | undefined = had ? { ...had } : undefined
    let alone = false
    switch (row.type) {
      case "bot.entering":
        act = { words: `buying $${Number(row.usd ?? 0).toFixed(2)} of ${sym(row.mint)}`, tone: "info", pending: "buying", side: "in", ...(paper ? { paper } : {}), ...(typeof row.mint === "string" ? { mint: row.mint } : {}), ...(typeof row.usd === "number" ? { usd: row.usd } : {}) }
        break
      case "bot.request":
        if (row.side === "swap") {
          const swap = `${String(row.amount ?? "")} ${String(row.from ?? "")} to ${String(row.to ?? "")}`.trim()
          act = { words: `swapping ${swap}`, tone: "info", pending: "swapping", side: "in", swap, ...(paper ? { paper } : {}) }
        } else if (row.side === "sell") act = { words: `selling ${sym(row.mint)}`, tone: "info", pending: "selling", side: "out", reason: "bot", ...(paper ? { paper } : {}), ...(typeof row.mint === "string" ? { mint: row.mint } : {}) }
        else act = { words: `buying $${Number(row.usd ?? 0).toFixed(2)} of ${sym(row.mint)}`, tone: "info", pending: "buying", side: "in", ...(paper ? { paper } : {}), ...(typeof row.mint === "string" ? { mint: row.mint } : {}), ...(typeof row.usd === "number" ? { usd: row.usd } : {}) }
        break
      case "bot.exiting":
        act = { words: [`selling ${sym(row.mint)}`, exitWords(row.reason)].filter(Boolean).join(" "), tone: "info", pending: "selling", side: "out", ...(paper ? { paper } : {}), ...(typeof row.mint === "string" ? { mint: row.mint } : {}), reason: String(row.reason ?? "") }
        alone = row.reason === "stop_loss"
        break
      case "bot.skipped": {
        const target = this.openFold(at.name)
        const n = typeof row.count === "number" ? row.count : 1
        if (target) {
          target.skipped += n
          target.skipWords = String(row.reason ?? "")
          this.sayFold(target)
          return "part"
        }
        const fresh = this.newFold(at.name, entry, true)
        fresh.skipped = n
        fresh.skipWords = String(row.reason ?? "")
        this.sayFold(fresh)
        return "start"
      }
      case "bot.waiting":
      case "bot.request_waiting":
      case "bot.exit_waiting":
      case "bot.exit_held":
      case "bot.position_left":
        act = { ...(act ?? { tone: "warn" }), words: String(row.words ?? text.text), tone: "warn", pending: undefined } as BotAct
        break
      case "bot.entry_ended":
      case "bot.request_ended":
      case "bot.exit_ended": {
        const bad = row.outcome === "refused" || row.outcome === "failed" || row.outcome === "lost"
        act = { ...(act ?? {}), words: String(row.words ?? text.text), tone: bad ? "bad" : row.outcome === "expired" ? "warn" : "info", pending: undefined } as BotAct
        break
      }
      case "operation.succeeded": {
        if (!act) return undefined
        const took = this.sentAt.has(String(row.opId)) ? ` in ${secs(Date.parse(row.at) - this.sentAt.get(String(row.opId))!)}` : ""
        if (row.paper === true) act = { ...act, words: `${sym(act.mint)}: ${PAPER_CLOSED_WORDS}`, tone: "warn", pending: undefined }
        else if (act.swap !== undefined) act = { ...act, words: `swapped ${act.swap}${took}`, tone: "good", done: "swap", pending: undefined }
        else if (act.side === "in" || act.pending === "buying" || act.done === "in") act = { ...act, words: `bought $${(act.usd ?? 0).toFixed(2)} of ${sym(act.mint)}${took}`, tone: "good", done: "in", pending: undefined }
        else act = { ...act, words: `${soldWords(sym(act.mint), act.reason)}${took}`, tone: "good", done: "out", pending: undefined }
        break
      }
      case "operation.failed":
      case "operation.refused":
      case "operation.unknown":
      case "operation.abandoned":
      case "card.refused":
        act = { ...(act ?? {}), words: `${act?.mint ? `${sym(act.mint)}: ` : ""}${text.text}`, tone: text.tone, pending: row.type === "operation.unknown" ? act?.pending : undefined } as BotAct
        break
      case "paper.call": {
        const args = record(row.args)
        const mint = typeof args?.mint === "string" ? args.mint : act?.mint
        if (row.isError === true) act = { ...(act ?? {}), words: `${sym(mint)}: ${text.text}`, tone: "bad", pending: undefined } as BotAct
        else if (row.botAct === "entry") act = { ...(act ?? { usd: 0 }), words: `bought${act?.usd !== undefined ? ` $${act.usd.toFixed(2)} of` : ""} ${sym(mint)} on paper`, tone: "good", done: "in", pending: undefined, paper: true, ...(mint ? { mint } : {}) } as BotAct
        else act = { ...(act ?? {}), words: [`sold ${sym(mint)} on paper`, exitWords(act?.reason ?? row.botReason)].filter(Boolean).join(" "), tone: "good", done: "out", pending: undefined, paper: true, ...(mint ? { mint } : {}) } as BotAct
        break
      }
      default:
        // Its card's own rows (proposed, approved without one, expired): the act's words already say it.
        if (!act || !fold) return undefined
        return "part"
    }
    if (!act || !at.key) return undefined
    const wrong = act.tone === "bad" || act.tone === "warn"
    if (fold && wrong && (fold.acts.size > 1 || fold.skipped > 0)) {
      // It goes wrong inside a line with others: it leaves that line for one of its own.
      fold.acts.delete(at.key)
      if (fold.last === at.key) fold.last = [...fold.acts.keys()].at(-1)
      this.sayFold(fold)
      this.botSaid.push(fold.entry)
      fold = undefined
      alone = true
    }
    let started = false
    if (!fold) {
      const open = !alone && !wrong ? this.openFold(at.name) : undefined
      fold = open ?? this.newFold(at.name, entry, !alone && !wrong)
      started = !open
    }
    if (wrong) fold.open = false
    fold.acts.set(at.key, act)
    fold.last = at.key
    this.actFold.set(at.key, fold)
    if (this.actFold.size > 2_000) this.actFold.delete(this.actFold.keys().next().value!)
    this.sayFold(fold)
    if (!started) this.botSaid.push(fold.entry)
    return started ? "start" : "part"
  }

  /** The bot's line, if others of its acts may still join it: it's the newest line shown. */
  private openFold(name: string): BotFold | undefined {
    const fold = this.botFolds.get(name)
    if (!fold?.open) return undefined
    return this.lines.findLast((e) => !e.hidden) === fold.entry ? fold : undefined
  }

  private newFold(name: string, entry: ActivityEntry, open: boolean): BotFold {
    const fold: BotFold = { entry, name, acts: new Map(), skipped: 0, open }
    this.botFolds.set(name, fold)
    if (this.botFolds.size > 200) this.botFolds.delete(this.botFolds.keys().next().value!)
    return fold
  }

  /**
   * A bot's line in words: its one act as itself, or in its notice's words, what it bought, sold (by why) and is
   * buying or selling, by token, then how many it skipped; and its tone.
   */
  private sayFold(fold: BotFold): void {
    const acts = [...fold.acts.values()]
    const skipped = fold.skipped ? `${fold.skipped} skipped${acts.length === 0 && fold.skipWords ? ` (${fold.skipWords.replace(/_/g, " ")})` : ""}` : ""
    const last = fold.last ? fold.acts.get(fold.last) : undefined
    const token = (a: BotAct) => a.swap ?? (a.mint ? this.symbol(a.mint) : "a token")
    const verbOf = (a: BotAct): string =>
      a.done === "in" ? "bought" : a.done === "swap" ? "swapped" : a.done === "out" ? botVerb("exit", a.reason) : a.pending === "buying" ? "buying" : a.pending === "selling" ? "selling" : a.pending === "swapping" ? "swapping" : ""
    const phrase = verbPhrase(acts.filter((a) => verbOf(a)).map((a) => ({ verb: verbOf(a), token: token(a) })))
    const said = acts.length === 1 && !skipped ? last!.words : [phrase, skipped].filter(Boolean).join(" · ")
    const paper = acts.some((a) => a.paper)
    fold.entry.firing = { name: fold.name, said: `${paper && !said.includes("on paper") ? "on paper · " : ""}${said}`, bot: true, ...(paper ? { paper: true as const } : {}) }
    const tones = acts.map((a) => a.tone)
    fold.entry.tone = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : acts.some((a) => a.done) ? "good" : "info"
    if (last?.mint && !baseAssetForMint(last.mint)) fold.entry.mint = last.mint
  }

  /** The token a line is about, if it's one the token pane follows: a card's, its operation's, or a paper trade's. */
  /** The chain of a line about `mint`: its card's, as the card was made, or its own row's; an old row's by the address. */
  private chainOf(row: JournalRow, mint: string): ChainSlug | undefined {
    const cardId = typeof row.cardId === "string" ? row.cardId : typeof row.opId === "string" ? this.cardIdOfOp.get(row.opId) : undefined
    if (row.type === "card.created") {
      const chain = storedChain(row.chain, mint)
      if (cardId && typeof row.opId === "string") this.cardIdOfOp.set(row.opId, cardId)
      if (cardId && chain) this.chainOfCard.set(cardId, chain)
      return chain
    }
    return (cardId ? this.chainOfCard.get(cardId) : undefined) ?? storedChain(row.chain, mint)
  }

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

  /** Activity's line for the row numbered `seq`, if it said one and still holds it. */
  lineFor(seq: number): ActivityEntry | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]!
      if (line.seq === seq) return line
      if (line.seq < seq) return undefined
    }
    return undefined
  }

  /** The trigger, the trigger that woke the turn, or the rules bot an operation's card came from. */
  originOfOp(opId: string): { trigger?: string; woken?: string; bot?: { name: string; act?: string; reason?: string; token?: string; paper?: boolean } } | undefined {
    const op = this.cardOfOp.get(opId)
    if (!op) return undefined
    // A code bot's swap reads as a swap ("swapped SOL to USDC"), not a buy of no token.
    const swap = op.kind === "swap" ? op.title.replace(/^SWAP\s+/i, "").replace(/\s*→\s*/, " to ") : undefined
    const bot = op.bot ? { name: op.bot, ...(swap ? { act: "swap", token: swap } : op.botAct ? { act: op.botAct } : {}), ...(op.botReason ? { reason: op.botReason } : {}), ...(op.mint && !swap ? { token: this.symbol(op.mint) } : {}), ...(op.paper ? { paper: true } : {}) } : undefined
    return { ...(op.trigger ? { trigger: op.trigger } : {}), ...(op.woken ? { woken: op.woken } : {}), ...(bot ? { bot } : {}) }
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

  /** Who bought into a token, matched by address key: a Hood mint in any case. */
  buyers(mint: string): string[] {
    return [...(this.bought.get(addressKey(mint)) ?? [])]
  }

  private symbol(mint: string): string {
    return tokenLabel(this.deps.symbolOf(mint), mint) ?? short(mint)
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
          this.cardOrigin.set(row.cardId, { ...(typeof row.role === "string" ? { role: row.role } : {}), ...(row.agent ? { agent: row.agent } : {}), ...(typeof row.trigger === "string" ? { trigger: row.trigger } : {}), ...(typeof row.woken === "string" ? { woken: row.woken } : {}), ...(typeof row.bot === "string" ? { bot: row.bot } : {}) })
        }
        if (typeof row.opId === "string") {
          this.cardOfOp.set(row.opId, {
            ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
            ...(typeof row.role === "string" ? { role: row.role } : {}),
            ...(row.agent ? { agent: row.agent } : {}),
            ...(typeof (row.mint ?? params?.mint) === "string" ? { mint: String(row.mint ?? params?.mint) } : {}),
            ...(typeof (row.side ?? params?.side) === "string" ? { side: String(row.side ?? params?.side) } : {}),
            ...(typeof row.trigger === "string" ? { trigger: row.trigger } : {}),
            ...(typeof row.woken === "string" ? { woken: row.woken } : {}),
            ...(typeof row.bot === "string" ? { bot: row.bot, ...(typeof row.botAct === "string" ? { botAct: row.botAct } : {}), ...(typeof row.botReason === "string" ? { botReason: row.botReason } : {}), ...(row.mode === "paper" ? { paper: true } : {}) } : {}),
            title,
          })
        }
        // A card made in place of an open one (the kill switch's kept sells, a pick from another wallet) wasn't
        // proposed again by anyone; the old card's withdrawal, next, says why.
        if (typeof row.replaces === "string") return { text: `re-proposed ${title} at a fresh price`, tone: "info" }
        // A line the user typed that opens the prompt pane is a card only inside: "you
        // ran", then "opened the prompt pane", say it.
        if (row.role === "view" && row.route === "pane") return undefined
        // A trigger's or a bot's: never the person's, and never the agent's.
        if (typeof row.trigger === "string") return { text: `${triggerName(row.trigger)} proposed ${title}`, tone: "info" }
        if (typeof row.bot === "string") return { text: `${botName(row.bot)} proposed ${title}`, tone: "info" }
        // The agent's, in a turn a trigger woke: nobody asked it in words.
        if (typeof row.woken === "string") return { text: `woke on ${triggerName(row.woken)} · ${agent} proposed ${title}`, tone: "info" }
        return { text: `${row.role === "view" ? "you" : agent} proposed ${title}`, tone: "info" }
      }
      case "card.approved": {
        if (row.how === "typed") return undefined
        // Nobody pressed anything: it ran inside its wallet's limits, in the words it was checked with.
        const inside = ranWithoutCard(row.how) ? (row.inside as { words?: unknown } | undefined) : undefined
        if (ranWithoutCard(row.how)) {
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
        // A trigger's card nobody was there to press: `run it now` proposes it again at a fresh price.
        if (typeof row.trigger === "string" || typeof row.bot === "string") return { text: `expired ${titleOf(row.cardId)}: nobody pressed it`, tone: "warn" }
        return { text: `expired ${titleOf(row.cardId)}`, tone: "info" }
      case "card.refused":
      case "tool.refused": {
        // "refused agent-b's candle_trade: OVER_TRADE_LIMIT" had no numbers, named the tool, and put a
        // trade the person typed on the agent. The core's message says what was over, by how much.
        const who = typeof row.trigger === "string" ? `${triggerName(row.trigger)}'s` : typeof row.bot === "string" ? `${botName(row.bot)}'s` : row.role === "view" ? "your" : `${agent}'s`
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
          const list = this.bought.get(addressKey(op.mint)) ?? []
          if (!list.includes(op.agent)) this.bought.set(addressKey(op.mint), [...list, op.agent])
        }
        const kind = typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.kind : undefined
        // How it was approved, where nobody pressed anything: the approval line said the figures.
        const alone = typeof row.opId === "string" && this.noCard.has(row.opId) ? " · without a card" : ""
        const by = op?.trigger ? ` · by ${triggerName(op.trigger)}` : op?.bot ? ` · by ${botName(op.bot)}` : op?.woken ? ` · woke on ${triggerName(op.woken)}` : ""
        if (row.paper === true) return { text: `${opTitle()}: ${PAPER_CLOSED_WORDS}${alone}${by}`, tone: "warn" }
        // A bridge says what arrived, in its own units.
        const received = kind === "bridge" ? record(row.result)?.received : undefined
        return { text: `${doneWord(kind)} ${opTitle()}${typeof received === "string" ? ` · ${terminalText(received, { maxLength: 40 })}` : ""}${alone}${by}`, tone: "good" }
      }
      case "operation.failed":
      case "operation.refused": {
        // Candle's own message says whether anything was sent ("nothing was signed or sent. Retry…").
        const error = record(row.error)
        const said = [error?.code, error?.message].filter((part): part is string => typeof part === "string" && part.length > 0).join(": ")
        // A swap whose first leg landed isn't "failed, nothing moved": what it sent left the wallet.
        const leg1 = record(row.partial)?.leg1
        if (row.type === "operation.failed" && typeof leg1 === "string") return { text: `part done ${opTitle()}: the first leg went (${short(leg1)}), the second failed${said ? `: ${said}` : ""}`, tone: "warn" }
        return { text: `failed ${opTitle()}${said ? `: ${said}` : ""}`, tone: "bad" }
      }
      case "operation.unknown": {
        // One the core reads no further says why and where to look: nothing is reading it back.
        const error = record(row.error)
        const kind = typeof row.opId === "string" ? this.cardOfOp.get(row.opId)?.kind : undefined
        if (notFollowedFurther({ kind, error, result: row.result }) && typeof error?.message === "string") {
          return { text: `${opTitle()}: ${terminalText(error.message, { maxLength: 300 })}`, tone: "warn" }
        }
        return { text: `no answer yet for ${opTitle()}: reading it back`, tone: "warn" }
      }
      case "operation.abandoned":
        return { text: `abandoned ${opTitle()}`, tone: "warn" }
      case "paper.call":
        return this.paperCall(row)
      // A trigger's firing and what came of it, never worded as the person's.
      case "trigger.fired":
        return { text: `${triggerName(row.name)} fired: ${String(row.words ?? "its condition was met")}`, tone: "info" }
      case "trigger.held":
        // The kill switch held one firing's buy or swap; the plan's hold names every trigger (the Journal says it).
        if (typeof row.name === "string") return { text: `${triggerName(row.name)}: ${String(row.words ?? "held")}`, tone: "warn" }
        return undefined
      case "trigger.missed":
        return { text: `${triggerName(row.name)}: ${String(row.words ?? "a run was missed")}`, tone: "warn" }
      case "trigger.skipped":
        return { text: `${triggerName(row.name)} skipped: ${String(row.words ?? "a signal it couldn't check")}`, tone: "warn" }
      case "trigger.waiting":
        return { text: `${triggerName(row.name)}: ${String(row.words ?? "its card waits for you")}`, tone: "warn" }
      case "trigger.notify":
        return { text: `${triggerName(row.name)}: ${String(row.words ?? "fired")}`, tone: "info" }
      case "trigger.ran":
        if (row.outcome === "stopped") return { text: `${triggerName(row.name)} stopped: ${String(row.words ?? "")}`, tone: "bad" }
        return { text: `${triggerName(row.name)}: ${String(row.words ?? "done")}`, tone: "good" }
      case "trigger.woke":
        if (row.joined === true) return { text: `${triggerName(row.name)} joined ${String(row.woke ?? "the agent")}'s woken turn waiting: ${String(row.words ?? "")}`, tone: "info" }
        return { text: `${triggerName(row.name)} woke ${String(row.woke ?? "the agent")}: ${String(row.words ?? "its condition was met")}`, tone: "info" }
      case "trigger.wake_skipped":
        return { text: `${triggerName(row.name)}: ${String(row.words ?? "its wake was skipped")}`, tone: "warn" }
      // An agent's change to a trigger, at once: switched off, or narrowed. The person's own are the Journal's.
      case "trigger.changed":
        if (row.how !== "agent") return undefined
        if (typeof row.hash === "string") return { text: `${String(row.changedBy ?? agent)} narrowed ${triggerName(row.name)}: ${Array.isArray(row.narrowed) ? row.narrowed.map(String).join("; ") : "a smaller change"}`, tone: "info" }
        // One that sold (a stop, a take profit) leaves that sell unwatched: said, since nobody may have been there.
        if (Array.isArray(row.sells) && row.sells.length) return { text: `${String(row.changedBy ?? agent)} switched off ${triggerName(row.name)}: its sell of ${row.sells.map((m) => this.symbol(String(m))).join(", ")} no longer waits`, tone: "warn" }
        return { text: `${String(row.changedBy ?? agent)} switched off ${triggerName(row.name)}`, tone: "info" }
      case "trigger.released":
        // One whose line didn't read (its wallet wasn't read, or couldn't pay) reads again; the plan's return names every trigger (the Journal says it).
        return typeof row.name === "string" ? { text: `${triggerName(row.name)}: ${String(row.words ?? "watching again")}`, tone: "info" } : undefined
      case "trigger.run_now":
        return { text: `you ran ${triggerName(row.name)}'s line again, at a fresh price`, tone: "info" }
      // A bot's entries and exits: what it decided on a signal or a level, before its trade; then why that waits,
      // or ended with nothing. Its skips, gathered a minute at a time. The Journal says them in these words too.
      case "bot.entering":
        return { text: `${botName(row.name)} ${clip(String(row.words ?? "entered"), 200)}`, tone: "info" }
      case "bot.waiting":
        return { text: `${botName(row.name)}: ${clip(String(row.words ?? "its buy waits for you"), 200)}`, tone: "warn" }
      case "bot.entry_ended":
        return { text: `${botName(row.name)} bought nothing: ${clip(String(row.words ?? row.outcome ?? ""), 200)}`, tone: endedTone(row.outcome) }
      case "bot.skipped":
        return { text: `${botName(row.name)} skipped ${row.count === 1 ? `a signal: ${clip(String(row.words ?? row.reason ?? ""), 200)}` : clip(String(row.words ?? `${String(row.count)} signals`), 200)}`, tone: "info" }
      case "bot.exiting":
        return { text: `${botName(row.name)} ${clip(String(row.words ?? "sells"), 200)}`, tone: row.reason === "stop_loss" ? "warn" : "info" }
      case "bot.exit_waiting":
        return { text: `${botName(row.name)}: ${clip(String(row.words ?? "its sell waits for you"), 200)}`, tone: "warn" }
      case "bot.exit_ended":
        return { text: `${botName(row.name)} sold nothing: ${clip(String(row.words ?? row.outcome ?? ""), 200)}`, tone: endedTone(row.outcome) }
      case "bot.exit_held":
        return { text: `${botName(row.name)}'s sell waits: ${clip(String(row.words ?? row.why ?? ""), 200)}`, tone: "warn" }
      case "bot.position_left":
        return { text: `${botName(row.name)} gave up a position: ${clip(String(row.words ?? ""), 200)}`, tone: "warn" }
      // A code bot's own requests, by their ids: what it asked for, a card that waits for you, how one ended.
      case "bot.request":
        return { text: `${codeBotName(row.name)} ${clip(String(row.words ?? row.side ?? "asked for a trade"), 200)}`, tone: "info" }
      case "bot.request_waiting":
        return { text: `${codeBotName(row.name)}: ${clip(String(row.words ?? "its trade waits for you"), 200)}`, tone: "warn" }
      case "bot.request_ended":
        return { text: `${codeBotName(row.name)}: ${clip(String(row.words ?? row.outcome ?? ""), 200)}`, tone: endedTone(row.outcome) }
      // Its process, as the supervisor ran it: a crash and giving up stand alone.
      case "bot.process": {
        const tone = PROCESS_TONES[String(row.what)]
        if (!tone) return undefined
        if (row.what === "supervisor_failed") return { text: `the code bots' supervisor didn't start: ${clip(String(row.words ?? ""), 200)}`, tone }
        return { text: `${codeBotName(row.name)}${row.what === "warning" ? ":" : ""} ${clip(String(row.words ?? row.what), 240)}`, tone }
      }
      // What a code bot says with `bot.event`: its own word and line, which a trigger may wait on.
      case "bot.event":
        return { text: `${codeBotName(row.name)} says "${String(row.word ?? "")}"${typeof row.text === "string" && row.text ? `: ${clip(row.text, 200)}` : ""}`, tone: "info" }
      // An agent's change to a bot, at once, Candle's stop pausing one, and the person's own pause, resume and stop.
      case "bot.changed":
        if (row.how !== "agent") return undefined
        return { text: `${String(row.changedBy ?? agent)} narrowed ${botName(row.name)}: ${Array.isArray(row.narrowed) ? clip(row.narrowed.map(String).join("; "), 200) : clip(String(row.words ?? ""), 200)}`, tone: "info" }
      case "bot.paused":
        if (row.how === "candle") return { text: `${botName(row.name)} is paused: ${clip(String(row.words ?? "Candle stopped its key"), 240)}`, tone: "bad" }
        if (row.how === "agent") return { text: `${String(row.changedBy ?? agent)} paused ${botName(row.name)}: ${row.kind === "code" ? "its buys are refused, its sells still run" : "no new entries, its exits still sell"}`, tone: "info" }
        // The person's own click: said here too, so the pane they clicked in isn't the only place it shows.
        return { text: `${row.how === "build" ? "the Build tab" : "you"} paused ${botName(row.name)}: ${row.kind === "code" ? "its buys are refused, its sells still run" : "no new entries, its exits still sell"}`, tone: "info" }
      case "bot.resumed":
        return { text: `you put ${botName(row.name)} back on, as it was approved`, tone: "info" }
      case "bot.stopped":
        return { text: `you stopped ${botName(row.name)}: ${row.kind === "code" ? "none of its trades run" : "nothing trades"}, and its positions are left to you`, tone: "info" }
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
        // A pin moves a line and changes none: its words say which.
        const moved = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : [])
        if (moved("pinned").length) return { text: `you pinned in ${agent}'s memory: ${moved("pinned").join(" · ")}`, tone: "info" }
        if (moved("unpinned").length) return { text: `you unpinned in ${agent}'s memory: ${moved("unpinned").join(" · ")}`, tone: "info" }
        const gone = [...(Array.isArray(r.removed) ? r.removed : []), ...(Array.isArray(r.deleted) ? r.deleted.map((p) => `memory/${String(p)}`) : [])].map(String)
        return { text: `you deleted from ${agent}'s memory: ${gone.join(" · ") || "a line"}`, tone: "info" }
      }
      // The agent's change to the screen, in the view's own words, and the person's click on it.
      case "view.changed":
        return typeof row.words === "string" ? { text: `${agent} ${row.words}`, tone: "info" } : undefined
      case "view.decided":
        return typeof row.words === "string" ? { text: `you ${row.words}`, tone: "info" } : undefined
      // The person's message from a script or another terminal (`candle-harness ask`): said as it starts, since no input line had it.
      case "agent.turn_started":
        return row.outside === true ? { text: `you asked ${agent} from outside: "${shortAddresses(String(row.user ?? "").replace(/\s+/g, " ")).slice(0, 80)}"`, tone: "info" } : undefined
      // Where a web fetch went, whole: the address is the agent's to compose, so none of it is cut.
      case "agent.fetch":
        return typeof row.url === "string" ? { text: `${agent} fetched ${row.url}`, tone: "info" } : undefined
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
    const agent =
      typeof row.trigger === "string"
        ? `${triggerName(row.trigger)} (as ${row.agent ?? "the agent"})`
        : typeof row.bot === "string"
          ? `${botName(row.bot)} (as ${row.agent ?? "the agent"})`
          : row.role === "view"
          ? `you (as ${row.agent ?? "the agent"})`
          : typeof row.woken === "string"
            ? `${row.agent ?? "the agent"} (woken by ${triggerName(row.woken)})`
            : (row.agent ?? "the agent")
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
      return { text: `paper buy ${this.symbol(mint)} by ${agent}: ≈${tokenFigure(got)} ${this.symbol(mint)} at the quoted price`, tone: "info" }
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
      return { text: `paper sell ${this.symbol(mint)} by ${agent}${sold > 0 ? `: ≈${tokenFigure(sold)} ${this.symbol(mint)}${got} at the quoted price` : ""}`, tone: "info" }
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
/**
 * This machine's time, for the top of every turn: schedules, "today" and the P&L window run on it, and the
 * record below is in UTC, so without it an agent took the journal's last UTC stamp for the clock.
 */
export function clockNote(now: number): string {
  const d = new Date(now)
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value
  const off = -d.getTimezoneOffset()
  const utc = off === 0 ? "UTC" : `UTC${off > 0 ? "+" : "−"}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`
  return `It's ${time} on ${day} on this machine${zone && zone !== utc && !/^GMT/.test(zone) ? ` (${zone}, ${utc})` : ` (${utc})`}. Schedules, "today" and the P&L window use this machine's time; the record's times are UTC.`
}

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
    const who = t.by === "harness" ? undefined : t.by === "you" ? `typed by the person${t.agent ? `, as ${t.agent}` : ""}` : t.by === "trigger" ? `fired by the trigger "${t.trigger ?? ""}"${t.agent ? `, as ${t.agent}` : ""}` : t.by === "bot" ? `traded by the bot "${t.bot ?? ""}"${t.agent ? `, as ${t.agent}` : ""}` : `asked for by ${t.agent ?? "an agent"}${t.woken ? `, woken by the trigger "${t.woken}"` : ""}`
    out.push(`- ${t.at.slice(11, 19)} UTC · ${t.mode} · ${who ? `${who} · ` : ""}${t.text}`)
  }
  if (books.length) {
    out.push("Open paper positions, at the quoted price:")
    // Short mints only: a full address here isn't a tool result, so the address gate would refuse it.
    for (const [agent, book] of books) out.push(`- ${agent}: ${book.map((p) => `${p.symbol ?? short(p.mint)} ${Number(p.tokens.toPrecision(6))}`).join(", ")}`)
  }
  return out.join("\n")
}
