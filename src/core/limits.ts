// The Candle Harness's own limits, enforced by the core per agent: a per-trade limit on buys and swaps, and a
// per-day limit on what the agent's buys and swaps add up to since local midnight. Sells are never
// limited: getting out is always allowed. Candle's own key limit is separate and checked by Candle
// when a trade is built; it's an approximate guardrail that racing builds can overrun
// (docs.candle.tv/developers/agent-access), which is why the Candle Harness keeps its own.
import type { AssetCap } from "./agent-status"
import { BASE_ASSETS, type BaseAsset, fromRaw } from "./assets"
import type { JournalRow } from "./journal"

export type Side = "buy" | "sell" | "swap"

export type LimitResult =
  /** `near`: within 20% of a limit, so the compact card shows the limits line. */
  | { ok: true; unvalued: boolean; line: string; near?: boolean }
  | { ok: false; code: "OVER_TRADE_LIMIT" | "OVER_DAY_LIMIT"; message: string; line: string }

/** Operation states that sent nothing, or spent nothing beyond a network fee: they don't count. */
const NOT_SPENT = new Set(["refused", "failed"])

export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Amounts said against a limit they go over, so the words add up and show it: to the cent where that does,
 * else to as many places as it takes (rounded to the cent, "$2.00 used today, and this $1.00 would make
 * $3.01" over a $3.00 figure, or "this one is $1.00" over $1.00, Candle's fee being a quarter of a cent,
 * don't add up). The total is the sum of the parts as shown.
 */
export function overWords(parts: readonly number[], limit: number): { parts: string[]; total: string } {
  for (let places = 2; ; places++) {
    const unit = 10 ** places
    const shown = parts.map((p) => Math.round(p * unit))
    const sum = shown.reduce((a, b) => a + b, 0)
    if (sum > Math.round(limit * unit) || places === 6) {
      const say = (n: number) => `$${(n / unit).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: places })}`
      return { parts: shown.map(say), total: say(sum) }
    }
  }
}

/** Which `card.approved` rows a day's spend counts, and under what name: an agent, or a wallet. */
type SpendKeyOf = (row: JournalRow) => string | undefined

const byAgent: SpendKeyOf = (row) => (typeof row.agent === "string" ? row.agent : undefined)

/**
 * What a wallet that trades inside limits has spent today **without a card**, so the figure means
 * "what ran without me today": only `how: "inside-limits"` approvals count, so a card the person
 * approved, or a typed trade under `cards.typedTrades = "instant"`, never uses up the wallet's figure.
 */
export const byWalletWithoutCard: SpendKeyOf = (row) => (row.how === "inside-limits" && typeof row.wallet === "string" ? row.wallet : undefined)

/**
 * What each agent has spent today through the core: approved buys and swaps, executed or in flight.
 * Built with `byWalletWithoutCard`, the same count by wallet, for the trades that ran without a card.
 */
export class DaySpend {
  private readonly ops = new Map<string, { agent: string; usd: number; at: number; counts: boolean }>()

  constructor(private readonly keyOf: SpendKeyOf = byAgent) {}

  /** `agent` is whatever this count is by: the agent, or the paying wallet's address. */
  record(opId: string, agent: string, usdValue: number, at: number): void {
    this.ops.set(opId, { agent, usd: usdValue, at, counts: true })
  }

  settle(opId: string, state: string): void {
    const op = this.ops.get(opId)
    if (op) op.counts = !NOT_SPENT.has(state)
  }

  spent(agent: string, now: number, exceptOpId?: string): number {
    const since = startOfLocalDay(now)
    let total = 0
    for (const [opId, op] of this.ops) {
      if (op.agent === agent && op.counts && op.at >= since && opId !== exceptOpId) total += op.usd
    }
    return total
  }

  /**
   * From the journal, on restart: every `card.approved` it counts that carried a value, and every unpriced
   * one valued once it filled (`card.valued`), less what settled unspent.
   */
  rebuild(rows: readonly JournalRow[]): void {
    for (const row of rows) {
      const key = row.type === "card.approved" || row.type === "card.valued" ? this.keyOf(row) : undefined
      if (key !== undefined && typeof row.opId === "string" && typeof row.usd === "number" && row.side !== "sell") {
        this.record(row.opId, key, row.usd, Date.parse(row.at))
      } else if (typeof row.opId === "string" && row.type.startsWith("operation.")) {
        // A swap that failed at its second leg spent its first: it still counts, as it did while the core ran.
        this.settle(row.opId, row.type === "operation.failed" && row.partial ? "partial" : row.type.slice("operation.".length))
      }
    }
  }
}

/** A trade is near a limit from 80% of it. */
export const NEAR = 0.8

export class Limits {
  constructor(
    private readonly deps: {
      limitsFor: (agent: string) => { perTradeUsd: number; perDayUsd: number } | undefined
      spend: DaySpend
    },
  ) {}

  /** `usd` undefined means the core couldn't value it: ok, marked unvalued, never a silent zero. */
  check(input: { usd: number | undefined; side: Side; agent: string; now: number; exceptOpId?: string; feeBps?: number }): LimitResult {
    const limits = this.deps.limitsFor(input.agent)
    if (!limits) return { ok: false, code: "OVER_TRADE_LIMIT", message: `${input.agent} has no Candle Harness limits set.`, line: "" }
    const spent = this.deps.spend.spent(input.agent, input.now, input.exceptOpId)
    if (input.side === "sell") {
      return { ok: true, unvalued: input.usd === undefined, line: `sells aren't limited · ${usd(spent)} of ${usd(limits.perDayUsd)} today` }
    }
    if (input.usd === undefined) {
      return { ok: true, unvalued: true, line: `no price, so it can't be checked · ${usd(spent)} of ${usd(limits.perDayUsd)} today` }
    }
    const line = `${usd(input.usd)} of ${usd(limits.perTradeUsd)} per trade · ${usd(spent + input.usd)} of ${usd(limits.perDayUsd)} today`
    // A buy's value counts Candle's fee, so `buy $3` reads $3.01: the refusal says why.
    const withFee = input.feeBps ? ` with Candle's ${input.feeBps / 100}% fee` : ""
    if (input.usd > limits.perTradeUsd) {
      return { ok: false, code: "OVER_TRADE_LIMIT", message: `Over ${input.agent}'s Candle Harness limit: ${overWords([input.usd], limits.perTradeUsd).total}${withFee} is more than ${usd(limits.perTradeUsd)} per trade.`, line }
    }
    if (spent + input.usd > limits.perDayUsd) {
      const w = overWords([spent, input.usd], limits.perDayUsd)
      return {
        ok: false,
        code: "OVER_DAY_LIMIT",
        message: `Over ${input.agent}'s Candle Harness limit for today: ${w.parts[0]} spent, and this ${w.parts[1]}${withFee} would make ${w.total} of ${usd(limits.perDayUsd)}.`,
        line,
      }
    }
    const near = input.usd >= NEAR * limits.perTradeUsd || spent + input.usd >= NEAR * limits.perDayUsd
    return { ok: true, unvalued: false, line, ...(near ? { near } : {}) }
  }
}

// --- Candle's key limit and its stop, held ---

/** Candle's `txLimit` window, as its status read names it (docs.candle.tv/developers/agent-access). */
export interface KeyWindow {
  usd: number
  reset: string
}

/** What a `KEY_LIMIT_REACHED` refusal carried (execute.ts `OperationError`). */
export interface KeyLimitError {
  code: string
  resetsAt?: number | null
  reason?: string
  retryAfter?: number
}

export interface KeyHold {
  agent: string
  /** When the hold lifts (epoch ms), or null for a lifetime cap: it lifts when the owner changes the cap. */
  until: number | null
  /** `stopped`: Candle stopped the key for a loss limit or its circuit breaker, and every trade waits, sells included. */
  why: "window" | "lifetime" | "unavailable" | "stopped"
  /** A lifetime hold's cap when it was refused: a different cap, or none, lifts it. */
  capUsd?: number
}

/** The next start of Candle's window after `at`, in UTC: a day, an ISO week (from Monday) or a month. */
export function nextWindowStart(reset: string, at: number): number | null {
  const d = new Date(at)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  if (reset === "daily") return Date.UTC(y, m, day + 1)
  if (reset === "weekly") return Date.UTC(y, m, day + (((8 - d.getUTCDay()) % 7) || 7))
  if (reset === "monthly") return Date.UTC(y, m + 1, 1)
  return null
}

/** A short hold when nothing says when the window resets: the next proposal asks Candle again after it. */
const UNKNOWN_RESET_MS = 60_000
/** Candle's `limit_unavailable` asks for about 30 s (docs.candle.tv/developers/agent-trading, "A main-payer trade"). */
const UNAVAILABLE_MS = 30_000
/**
 * A key Candle stopped (`RISK_LIMIT_REACHED`) is asked again after this. Only a person clears the stop, in
 * the Agent Console, and Candle has no MCP read of it yet, so the core can't see it lift.
 */
export const STOPPED_HOLD_MS = 5 * 60_000

const utcClock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`

/**
 * Keys Candle refused with `KEY_LIMIT_REACHED`, held until the refusal stops being true. A held key's buys
 * and swaps are refused at proposal in Candle's words; its sells still go, since Candle never refuses a
 * token sell for this cap. Without the hold, an agent trading without a card would be refused at Candle
 * again and again.
 *
 * - `limit_unavailable` (Candle couldn't value the trade or read the key's use): held until `retryAfter`.
 * - A window cap: held until `resetsAt`, or, where the refusal didn't carry it (the CLI's route), until
 *   the next start of the key's window from its status read.
 * - A lifetime cap (`resetsAt: null`): held until the key's cap is changed or cleared.
 *
 * Rebuilt from the journal's `operation.*` rows on restart.
 */
export class KeyHolds {
  private readonly holds = new Map<string, KeyHold>()
  /** Keys Candle stopped (RISK_LIMIT_REACHED): every trade waits, sells included, since Candle refuses those too. */
  private readonly stops = new Map<string, KeyHold>()

  constructor(private readonly deps: { window: (agent: string) => KeyWindow | undefined }) {}

  note(agent: string, error: KeyLimitError, at: number): void {
    if (error.code === "RISK_LIMIT_REACHED") {
      this.stops.set(agent, { agent, until: at + STOPPED_HOLD_MS, why: "stopped" })
      return
    }
    if (error.code !== "KEY_LIMIT_REACHED") return
    const window = this.deps.window(agent)
    let hold: KeyHold
    if (error.reason === "limit_unavailable") hold = { agent, until: error.retryAfter ?? at + UNAVAILABLE_MS, why: "unavailable" }
    else if (typeof error.resetsAt === "number") hold = { agent, until: error.resetsAt, why: "window" }
    else if (error.resetsAt === null) hold = { agent, until: null, why: "lifetime", ...(window ? { capUsd: window.usd } : {}) }
    else {
      const next = window ? nextWindowStart(window.reset, at) : undefined
      hold = next === null ? { agent, until: null, why: "lifetime", capUsd: window!.usd } : { agent, until: next ?? at + UNKNOWN_RESET_MS, why: "window" }
    }
    this.holds.set(agent, hold)
  }

  /**
   * The agent's hold now on a trade of `side`, if one still holds; one that lifted is let go. A stopped
   * key holds every side; Candle's cap holds buys and swaps, never a sell. With no side, any hold.
   */
  held(agent: string, now: number, side?: Side): KeyHold | undefined {
    const stop = this.stops.get(agent)
    if (stop && now < stop.until!) return stop
    if (stop) this.stops.delete(agent)
    if (side === "sell") return undefined
    const hold = this.holds.get(agent)
    if (!hold) return undefined
    const lifted = hold.until !== null ? now >= hold.until : this.deps.window(agent)?.usd !== hold.capUsd
    if (lifted) {
      this.holds.delete(agent)
      return undefined
    }
    return hold
  }

  all(now: number): KeyHold[] {
    return [...new Set([...this.stops.keys(), ...this.holds.keys()])].map((agent) => this.held(agent, now)).filter((h): h is KeyHold => h !== undefined)
  }

  rebuild(rows: readonly JournalRow[]): void {
    for (const row of rows) {
      const error = row.error as KeyLimitError | undefined
      if (row.type.startsWith("operation.") && typeof row.agent === "string" && (error?.code === "KEY_LIMIT_REACHED" || error?.code === "RISK_LIMIT_REACHED")) this.note(row.agent, error, Date.parse(row.at))
    }
  }
}

/** Why a held key's buy or swap is refused, in the words of Candle's refusal and when it lifts. */
export function heldMessage(hold: KeyHold, now: number): string {
  if (hold.why === "stopped") {
    return `Candle stopped ${hold.agent}'s key (a loss limit or its circuit breaker), sells included. Waiting won't clear it: the owner resumes it in Candle's Agent Console. The Candle Harness asks Candle again from ${utcClock(hold.until!)}. Nothing was sent.`
  }
  const tail = "Sells still go. Nothing was sent."
  if (hold.why === "unavailable") return `Candle couldn't check ${hold.agent}'s key limit a moment ago (its price or usage read was down), so buys and swaps wait until ${utcClock(hold.until!)}. ${tail}`
  if (hold.why === "lifetime") return `Candle's lifetime limit on ${hold.agent}'s key is used up, so its buys and swaps are held until the owner raises it in Candle's Agent Console. ${tail}`
  const mins = Math.max(1, Math.ceil((hold.until! - now) / 60_000))
  const left = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `Candle's limit on ${hold.agent}'s key is used up until ${utcClock(hold.until!)} (in ${left}), so its buys and swaps are held until then. ${tail}`
}

// --- Candle's per-asset cap ---

/** A cap's asset, as the Candle Harness names it, if the Candle Harness knows it. */
const capAsset = (cap: AssetCap): BaseAsset | undefined => {
  const upper = cap.asset.toUpperCase()
  return Object.hasOwn(BASE_ASSETS, upper) ? (upper as BaseAsset) : undefined
}

export const capText = (cap: AssetCap): string => {
  const asset = capAsset(cap)
  return asset ? `${fromRaw(BigInt(cap.maxPerTxRaw), BASE_ASSETS[asset].decimals)} ${asset}` : `${cap.maxPerTxRaw} raw ${cap.asset}`
}

/**
 * A buy over the key's Candle cap for the asset it spends, which Candle would refuse when it builds the
 * trade (`SPEND_LIMIT_EXCEEDED`). Candle counts the amount plus its fee; the core counts the amount
 * alone, so it never refuses a buy Candle would take, and one just under is Candle's to refuse.
 */
export function overAssetCap(caps: readonly AssetCap[] | undefined, asset: BaseAsset, amountRaw: bigint): AssetCap | undefined {
  return caps?.find((cap) => capAsset(cap) === asset && amountRaw > BigInt(cap.maxPerTxRaw))
}

// --- Every limit, with who enforces it ---

export type Enforcer = "Harness" | "Candle"

export interface LimitLine {
  by: Enforcer
  /** What it bounds: the agent's trade or day, a wallet's trade or day without a card, Candle's volume window or an asset's spend, or that Candle has none. */
  what: "trade" | "day" | "wallet-trade" | "wallet-day" | "volume" | "asset" | "none" | "unread"
  words: string
  wallet?: string
}

/** A wallet's own figures where it trades inside limits. */
export interface WalletFigures {
  wallet: string
  /** How the wallet is named on screen: "embedded", or a TEE wallet's label. */
  name: string
  perTradeUsd: number
  perDayUsd: number
  /** Spent today without a card, by every agent paying from it. */
  usedUsd: number
}

const WINDOW_WORDS: Readonly<Record<string, string>> = { daily: "a UTC day", weekly: "a week (from Monday, UTC)", monthly: "a UTC month", never: "for the key's life" }

/**
 * Every limit on one agent, each naming who enforces it: the Candle Harness's hold for what the core runs;
 * Candle's hold for the key, whatever runs it, but only for what Candle builds. The same lines go to
 * the views, the doctor and the agent, so nothing reads as if it held where it doesn't.
 */
export function limitLines(input: {
  harness: { perTradeUsd: number; perDayUsd: number } | undefined
  spentTodayUsd: number
  wallets: readonly WalletFigures[]
  candle: { read: boolean; keyLimit?: KeyWindow; assetCaps?: readonly AssetCap[] }
}): LimitLine[] {
  const lines: LimitLine[] = []
  if (input.harness) {
    lines.push({ by: "Harness", what: "trade", words: `Harness · ${usd(input.harness.perTradeUsd)} a trade` })
    lines.push({ by: "Harness", what: "day", words: `Harness · ${usd(input.harness.perDayUsd)} a day · ${usd(input.spentTodayUsd)} used` })
  }
  for (const w of input.wallets) {
    lines.push({ by: "Harness", what: "wallet-trade", wallet: w.wallet, words: `Harness · ${w.name} without a card · ${usd(w.perTradeUsd)} a trade` })
    lines.push({ by: "Harness", what: "wallet-day", wallet: w.wallet, words: `Harness · ${w.name} without a card · ${usd(w.perDayUsd)} a day · ${usd(w.usedUsd)} used` })
  }
  const c = input.candle
  if (!c.read) return [...lines, { by: "Candle", what: "unread", words: "Candle · the key's caps aren't read yet" }]
  if (c.keyLimit) lines.push({ by: "Candle", what: "volume", words: `Candle · ${usd(c.keyLimit.usd)} ${WINDOW_WORDS[c.keyLimit.reset] ?? `a ${c.keyLimit.reset} window`}, all volume` })
  for (const cap of c.assetCaps ?? []) lines.push({ by: "Candle", what: "asset", words: `Candle · ${capText(cap)} a buy` })
  if (!c.keyLimit && !c.assetCaps?.length) lines.push({ by: "Candle", what: "none", words: "Candle · no cap on this key" })
  return lines
}
