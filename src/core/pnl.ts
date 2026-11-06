// P&L. Candle is the book of record: each agent's P&L is
// `candle_get_profile_pnl` for its own key's prefix, read with its own key. The Candle Harness adds only what Candle
// can't give yet, each kept apart and never summed with Candle's figures:
//   - time: each read's totals are kept as a sample (`state/pnl.jsonl`, 0600, a minute apart at most per
//     agent, thinned past 30 days to one an hour), since Candle's P&L has no window yet. A gap is a gap;
//   - the P&L window's figure: for each agent, its total now less its first sample in the window, summed
//     over the Candle Harness's agents (Candle's books add up across a shared wallet, each round booked whole to one
//     key, so the sum is right though one agent's own figure can jump when another sells what it opened).
//     The window is the last 24 hours, since midnight, since a time of day, or since the main view was
//     last closed; where the samples start later than the window, the figure says from when. Since the
//     last session alone, the agent's last sample at or before the mark is the start, when it's within the
//     samples' pace of it: the core was running at the mark, so that sample is the mark's, and a gap with
//     the core stopped after it is counted whole;
//   - swaps: Candle's book counts a swap into a token, but its trades read lists none yet, so the
//     journal's filled swaps are listed beside the fills, never added to anything;
//   - paper: no Candle tool reads a key's paper book yet, so the paper trades this core journalled are
//     costed at their quotes and valued at the price book's prices, marked ≈. Never summed with live.
//
// Reads: each agent's book every 5 minutes, every 60 s while a view subscribes to `pnl` (with its recent
// fills, `candle_get_profile_trades`), and a few seconds after each fill. All inside the key's request
// budget (key-budget.ts, kind "pnl"): what doesn't fit is read less often. A read that fails keeps the
// last book, with its age and why.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { appendFile, chmod, rename, writeFile } from "node:fs/promises"
import { terminalText } from "../shared/terminal-text"
import { BASE_ASSETS, quoteAssetOf } from "./assets"
import type { ToolOutcome } from "./candle-mcp"
import type { JournalRow } from "./journal"
import type { PaperPosition } from "./trade-log"

/** Each agent's book while a P&L pane is on screen. */
export const PNL_ON_SCREEN_MS = 60_000
/** Each agent's book otherwise: the status bar's figure always shows. */
export const PNL_BACKGROUND_MS = 5 * 60_000
/** After a fill, each agent's book is read again this soon, as prices are. */
export const PNL_AFTER_FILL_MS = 5_000
/**
 * And the filling agent's again at these times after the fill, until its book shows it: Candle can take more
 * than 5 s to book a fill, and with the next read a minute later, P&L positions lagged about 65 s.
 */
export const PNL_FOLLOW_UP_MS: readonly number[] = [20_000, 45_000]
/** A read that never reached Candle is asked again this soon. */
export const PNL_RETRY_SOON_MS = 5_000
/** At most one sample a minute per agent is kept. */
export const SAMPLE_EVERY_MS = 60_000
/** Past this age, samples are thinned to one an hour. */
export const THIN_AFTER_MS = 30 * 24 * 3_600_000
const HOUR_MS = 3_600_000
/**
 * Samples further apart than this have a gap between them: the core wasn't running, or wasn't reading.
 * Twice the background pace, and some.
 */
export const GAP_MS = 12 * 60_000
/** The recent fills a P&L pane lists, per agent. */
export const TRADES_LIMIT = 50
/** The swaps and crossed rounds listed, at most. */
const LISTED = 50

export type PnlWindow = "24h" | "midnight" | "session" | `${number}:${number}`
export const DEFAULT_WINDOW: PnlWindow = "24h"

/** A window as config.toml, the state file and `pnl.window` name it, or why not. */
export function parseWindow(value: unknown): { ok: true; window: PnlWindow } | { ok: false; message: string } {
  if (value === "24h" || value === "midnight" || value === "session") return { ok: true, window: value }
  if (typeof value === "string") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { ok: true, window: `${m[1]!.padStart(2, "0")}:${m[2]}` as PnlWindow }
  }
  return { ok: false, message: 'use "24h", "midnight", "session" (since the Candle Harness was last closed) or a time of day, such as "18:00"' }
}

/** A window's name where a figure shows: "24h", "since midnight", "since 18:00", "since last session". */
export function windowLabel(window: PnlWindow): string {
  if (window === "24h") return "24h"
  if (window === "midnight") return "since midnight"
  if (window === "session") return "since last session"
  return `since ${window}`
}

/**
 * When a window starts, at `now`, in this machine's time. "session" starts when the main view was last
 * closed; with no such mark, it's null, and the figure runs from the first sample.
 */
export function windowStart(window: PnlWindow, now: number, sessionEnd: number | undefined): number | null {
  if (window === "24h") return now - 24 * HOUR_MS
  if (window === "session") return sessionEnd ?? null
  const d = new Date(now)
  if (window === "midnight") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const [h, m] = window.split(":").map(Number) as [number, number]
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime()
  // The time's last occurrence: at 17:00, "since 18:00" is yesterday's.
  return today <= now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m).getTime()
}

/**
 * A `since` the agent passes to harness_pnl: one of the windows, a span back ("48h", "7d"), or a date or time
 * (YYYY-MM-DD or YYYY-MM-DDTHH:MM, this machine's time unless it names a zone). Undefined if it isn't one.
 */
export function sinceStart(since: string, now: number, sessionEnd: number | undefined): { start: number | null; label: string; mark?: true } | undefined {
  const window = parseWindow(since)
  if (window.ok) return { start: windowStart(window.window, now, sessionEnd), label: windowLabel(window.window), ...(window.window === "session" ? { mark: true as const } : {}) }
  const span = /^(\d{1,4})([hd])$/.exec(since.trim())
  if (span) {
    const n = Number(span[1])
    if (n <= 0) return undefined
    return { start: now - n * (span[2] === "h" ? HOUR_MS : 24 * HOUR_MS), label: `${n}${span[2]}` }
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since.trim())
  if (date) {
    const t = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime()
    return Number.isFinite(t) && t <= now ? { start: t, label: `since ${since.trim()}` } : undefined
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(since.trim())) {
    const t = Date.parse(since.trim())
    return Number.isFinite(t) && t <= now ? { start: t, label: `since ${since.trim()}` } : undefined
  }
  return undefined
}

// --- Candle's book ---------------------------------------------------------------------------------

export interface PnlTotals {
  realizedGrossUsd: number
  realizedNetUsd: number
  unrealizedUsd: number
  /** Candle's total: realised net plus unrealised, with perps when `perpsInTotal`. */
  totalUsd: number
  feesUsd: number
}

export interface PnlPosition {
  mint: string
  symbol?: string
  chain: string
  wallet: string
  quantity: number
  costBasisUsd: number
  /** Missing shows as missing, never zero: a position Candle couldn't mark. */
  markPriceUsd: number | null
  markedAt: number | null
  marketValueUsd: number | null
  unrealizedUsd: number | null
  openedTs: number | null
}

export interface PnlWalletRow {
  wallet: string
  /** "main" (the embedded wallet) or "linked" (a TEE wallet). */
  payerType: string
  label?: string
  realizedNetUsd: number
  unrealizedUsd: number
  totalUsd: number
  feesUsd: number
  openPositions: number
}

/** A round Candle booked to this agent that another agent opened, labelled "opened by". */
export interface CrossedRound {
  mint: string
  symbol?: string
  /** The agent that opened it, or its key prefix when no agent here holds that key. */
  openedBy: string
  closedTs: number | null
  realizedNetUsd: number
}

export interface PnlBookView {
  totals: PnlTotals
  positions: PnlPosition[]
  wallets: PnlWalletRow[]
  closedRounds: number
  crossed: CrossedRound[]
  /** The oldest mark among the open positions: "marked 46m ago" where it matters. */
  oldestMarkAt: number | null
  unmarked: number
  /** Positions Candle couldn't value at all: like `unmarked`, left out of the total. */
  unvalued: number
  /** Candle looks back at most `lookback` trades; past that, the oldest drop out of the book. */
  truncated: boolean
  hyperliquid: { read: boolean; netUsd: number | null; unrealizedUsd: number | null; inTotal: boolean; why?: string }
}

export interface PnlTrade {
  agent: string
  at: number
  mint: string
  symbol?: string
  side: string
  status: string
  usd: number | null
  feeUsd: number | null
  wallet?: string
  signature?: string
  /** The id the trade was sent under: the core's opId for the Candle Harness's own. */
  clientTradeId?: string
  error?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  // Hyperliquid's figures come as strings.
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return null
}
const zero = (value: unknown): number => num(value) ?? 0
const str = (value: unknown, max = 64): string | undefined => (typeof value === "string" && value.length > 0 ? terminalText(value, { maxLength: max }) : undefined)

/**
 * One agent's book from Candle's answer, in its recorded shape. `agentOf` names the agent holding a key prefix,
 * for rounds another agent opened. Undefined when the answer isn't a book.
 */
export function bookFrom(result: unknown, ownPrefix: string, agentOf: (prefix: string) => string | undefined, symbolOf?: (mint: string) => string | undefined): PnlBookView | undefined {
  const body = record(result)
  const pnl = record(body?.pnl)
  if (!pnl || body?.success === false || num(pnl.totalUsd) === null) return undefined
  const named = (mint: string) => {
    const symbol = symbolOf?.(mint)
    return symbol ? { symbol } : {}
  }
  const positions: PnlPosition[] = (Array.isArray(pnl.openPositions) ? pnl.openPositions : [])
    .map(record)
    .filter((p): p is Record<string, unknown> => typeof p?.mint === "string")
    .map((p) => ({
      mint: String(p.mint),
      ...named(String(p.mint)),
      chain: str(p.chain, 16) ?? "solana",
      wallet: str(p.wallet) ?? "",
      quantity: zero(p.quantity),
      costBasisUsd: zero(p.costBasisUsd),
      markPriceUsd: num(p.markPriceUsd),
      markedAt: num(p.markedAt),
      marketValueUsd: num(p.marketValueUsd),
      unrealizedUsd: num(p.unrealizedUsd),
      openedTs: num(p.openedTs),
    }))
  const wallets: PnlWalletRow[] = (Array.isArray(pnl.byWallet) ? pnl.byWallet : [])
    .map(record)
    .filter((w): w is Record<string, unknown> => typeof w?.wallet === "string")
    .map((w) => {
      const label = str(w.label, 40)
      return {
        wallet: String(w.wallet),
        payerType: str(w.payerType, 16) ?? "main",
        ...(label ? { label } : {}),
        realizedNetUsd: zero(w.realizedNetUsd),
        unrealizedUsd: zero(w.unrealizedUsd),
        totalUsd: zero(w.totalUsd),
        feesUsd: zero(w.feesUsd),
        openPositions: Array.isArray(w.openPositions) ? w.openPositions.length : zero(w.openPositions),
      }
    })
  const crossed: CrossedRound[] = (Array.isArray(pnl.closedPositions) ? pnl.closedPositions : [])
    .map(record)
    .filter((c): c is Record<string, unknown> => typeof c?.mint === "string" && typeof c.openedBy === "string" && c.openedBy !== ownPrefix)
    .map((c) => ({ mint: String(c.mint), ...named(String(c.mint)), openedBy: agentOf(String(c.openedBy)) ?? String(c.openedBy), closedTs: num(c.closedTs), realizedNetUsd: zero(c.realizedNetUsd) }))
    .slice(0, LISTED)
  const hl = record(body?.hyperliquid)
  const hlWhy = hl?.read === false ? (str(hl.reason, 120) ?? str(hl.code, 40)) : undefined
  return {
    totals: {
      realizedGrossUsd: zero(pnl.realizedGrossUsd),
      realizedNetUsd: zero(pnl.realizedNetUsd),
      unrealizedUsd: zero(pnl.unrealizedUsd),
      totalUsd: zero(pnl.totalUsd),
      feesUsd: zero(pnl.feesUsd),
    },
    positions,
    wallets,
    closedRounds: zero(pnl.closedRounds),
    crossed,
    oldestMarkAt: num(pnl.oldestMarkAt),
    unmarked: zero(pnl.unmarkedPositions),
    unvalued: zero(pnl.unvalued),
    truncated: pnl.truncated === true,
    hyperliquid: { read: hl?.read === true, netUsd: num(hl?.netUsd), unrealizedUsd: num(hl?.unrealizedUsd), inTotal: body?.perpsInTotal === true, ...(hlWhy ? { why: hlWhy } : {}) },
  }
}

/** An agent's recent fills from `candle_get_profile_trades`, newest first. A failed trade keeps its error. */
export function tradesFrom(result: unknown, agent: string, symbolOf?: (mint: string) => string | undefined): PnlTrade[] | undefined {
  const rows = record(result)?.trades
  if (!Array.isArray(rows)) return undefined
  return rows
    .map(record)
    .filter((t): t is Record<string, unknown> => typeof t?.mint === "string" && num(t.createdAt) !== null)
    .map((t) => {
      const symbol = symbolOf?.(String(t.mint))
      const wallet = str(t.payerWallet)
      const signature = str(t.signature, 100)
      const clientTradeId = str(t.clientTradeId, 100)
      const error = str(record(t.error)?.message ?? t.error ?? t.errorMessage, 160)
      return {
        agent,
        at: num(t.createdAt)!,
        mint: String(t.mint),
        ...(symbol ? { symbol } : {}),
        side: str(t.side, 8) ?? "?",
        status: str(t.status, 16) ?? "?",
        usd: num(t.usdValue),
        feeUsd: num(t.feeUsd),
        ...(wallet ? { wallet } : {}),
        ...(signature ? { signature } : {}),
        ...(clientTradeId ? { clientTradeId } : {}),
        ...(error ? { error } : {}),
      }
    })
    .sort((a, b) => b.at - a.at)
}

/** The wallets' rows across agents: a wallet's total is the sum of its agents' books (they add up). */
export function walletsAcross(books: { agent: string; book: PnlBookView }[]): (PnlWalletRow & { agents: string[] })[] {
  const out = new Map<string, PnlWalletRow & { agents: string[] }>()
  for (const { agent, book } of books) {
    for (const w of book.wallets) {
      const held = out.get(w.wallet)
      if (!held) {
        out.set(w.wallet, { ...w, agents: [agent] })
        continue
      }
      held.realizedNetUsd += w.realizedNetUsd
      held.unrealizedUsd += w.unrealizedUsd
      held.totalUsd += w.totalUsd
      held.feesUsd += w.feesUsd
      held.openPositions += w.openPositions
      if (!held.agents.includes(agent)) held.agents.push(agent)
      if (!held.label && w.label) held.label = w.label
    }
  }
  return [...out.values()]
}

/** The Candle Harness's agents' books summed: theirs, not the whole account's (other keys on it aren't read). */
export function sumTotals(books: PnlBookView[]): PnlTotals | null {
  if (books.length === 0) return null
  const out: PnlTotals = { realizedGrossUsd: 0, realizedNetUsd: 0, unrealizedUsd: 0, totalUsd: 0, feesUsd: 0 }
  for (const b of books) for (const k of Object.keys(out) as (keyof PnlTotals)[]) out[k] += b.totals[k]
  return out
}

// --- Samples -----------------------------------------------------------------------------------------

export interface PnlSample {
  at: number
  agent: string
  /** The key's prefix: a sample from another key's book isn't this agent's start. */
  prefix: string
  totalUsd: number
  realizedNetUsd: number
  unrealizedUsd: number
  /** Positions Candle had no price for, or couldn't value: left out of `totalUsd` (unset on older samples). */
  unpriced?: number
}

function sampleFrom(line: string): PnlSample | undefined {
  try {
    const s = JSON.parse(line) as Record<string, unknown>
    const at = typeof s.at === "string" ? Date.parse(s.at) : Number.NaN
    if (!Number.isFinite(at) || typeof s.agent !== "string" || typeof s.prefix !== "string" || num(s.totalUsd) === null) return undefined
    const unpriced = num(s.unpriced)
    return { at, agent: s.agent, prefix: s.prefix, totalUsd: num(s.totalUsd)!, realizedNetUsd: zero(s.realizedNetUsd), unrealizedUsd: zero(s.unrealizedUsd), ...(unpriced !== null ? { unpriced } : {}) }
  } catch {
    return undefined
  }
}

const sampleLine = (s: PnlSample) =>
  `${JSON.stringify({ at: new Date(s.at).toISOString(), agent: s.agent, prefix: s.prefix, totalUsd: s.totalUsd, realizedNetUsd: s.realizedNetUsd, unrealizedUsd: s.unrealizedUsd, ...(s.unpriced !== undefined ? { unpriced: s.unpriced } : {}) })}\n`

/** Past 30 days, one sample an hour per agent (the first in each hour); newer ones kept. */
export function thinned(samples: readonly PnlSample[], now: number): PnlSample[] {
  const out: PnlSample[] = []
  const seen = new Set<string>()
  for (const s of samples) {
    if (now - s.at <= THIN_AFTER_MS) {
      out.push(s)
      continue
    }
    const hour = `${s.agent}:${Math.floor(s.at / HOUR_MS)}`
    if (seen.has(hour)) continue
    seen.add(hour)
    out.push(s)
  }
  return out
}

/** The samples file's samples, oldest first, a bad line skipped; none when there's no file. */
export function readSamples(path: string): PnlSample[] {
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map(sampleFrom)
    .filter((s): s is PnlSample => s !== undefined)
    .sort((a, b) => a.at - b.at)
}

/** The samples file: read back on a restart, appended to, thinned once a day. Each agent's samples oldest first. */
export class SampleStore {
  private readonly byAgent = new Map<string, PnlSample[]>()
  private writing: Promise<void> = Promise.resolve()
  private thinnedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly path: string,
    private readonly now: () => number,
  ) {}

  /** Reads the file back, a bad line skipped; thins it if it holds old samples. */
  load(): void {
    for (const s of readSamples(this.path)) this.list(s.agent).push(s)
    this.thin()
  }

  of(agent: string): readonly PnlSample[] {
    return this.byAgent.get(agent) ?? []
  }

  agents(): string[] {
    return [...this.byAgent.keys()]
  }

  /** Each agent's last sample. */
  last(agent: string): PnlSample | undefined {
    return this.byAgent.get(agent)?.at(-1)
  }

  /** Keeps a sample if the agent's last is a minute old or more. True when kept. */
  add(sample: PnlSample): boolean {
    const last = this.last(sample.agent)
    if (last && sample.at - last.at < SAMPLE_EVERY_MS) return false
    this.list(sample.agent).push(sample)
    this.writing = this.writing.then(() => appendFile(this.path, sampleLine(sample), { mode: 0o600 })).catch(() => {})
    if (this.now() - this.thinnedAt > 24 * HOUR_MS) this.thin()
    return true
  }

  /** Waits for the writes so far. */
  flush(): Promise<void> {
    return this.writing
  }

  /** The agent's first sample at or after `from` from its key `prefix`. */
  firstFrom(agent: string, prefix: string, from: number): PnlSample | undefined {
    const list = this.of(agent)
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.at < from) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < list.length; i++) if (list[i]!.prefix === prefix) return list[i]
    return undefined
  }

  /** The agent's last sample at or before `at` from its key `prefix`. */
  lastAtOrBefore(agent: string, prefix: string, at: number): PnlSample | undefined {
    const list = this.of(agent)
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.at <= at) lo = mid + 1
      else hi = mid
    }
    for (let i = lo - 1; i >= 0; i--) if (list[i]!.prefix === prefix) return list[i]
    return undefined
  }

  /** Thins samples past 30 days to one an hour, rewriting the file whole (0600) only when something goes. */
  private thin(): void {
    const now = this.now()
    this.thinnedAt = now
    let dropped = false
    for (const [agent, list] of this.byAgent) {
      const kept = thinned(list, now)
      if (kept.length !== list.length) {
        this.byAgent.set(agent, kept)
        dropped = true
      }
    }
    if (!dropped) return
    const all = [...this.byAgent.values()].flat().sort((a, b) => a.at - b.at)
    this.writing = this.writing
      .then(async () => {
        const temp = `${this.path}.tmp-${randomBytes(6).toString("base64url")}`
        await writeFile(temp, all.map(sampleLine).join(""), { mode: 0o600, flag: "wx" })
        await chmod(temp, 0o600)
        await rename(temp, this.path)
      })
      .catch(() => {})
  }

  private list(agent: string): PnlSample[] {
    let list = this.byAgent.get(agent)
    if (!list) {
      list = []
      this.byAgent.set(agent, list)
    }
    return list
  }
}

// --- The window's figure -----------------------------------------------------------------------------

export interface AgentFigure {
  /** The agent's change over the window, or null before any sample in it. */
  usd: number | null
  /** Where its change runs from: its first sample in the window, or the mark's own sample. */
  from: number | null
  /** Candle priced a different number of its positions at the two ends: the change partly reflects that, not trading. */
  partial?: true
}

export interface WindowFigure {
  window: PnlWindow | "since"
  label: string
  /** When the window starts; null for "since last session" before the main view has ever closed. */
  start: number | null
  /** The sum of each agent's own change (the Candle Harness's agents, not the whole account); null before any sample in the window. */
  usd: number | null
  /** The earliest agent's first sample in the window. */
  from: number | null
  /** The samples start later than the window: the figure says "since 09:14" rather than the window's name. */
  short: boolean
  /**
   * Positions Candle has no price for now, where an agent's count differs from its start: a total leaves
   * them out, so the change swings when one gains or loses its price, with nothing traded.
   */
  unpriced?: number
  agents: Record<string, AgentFigure>
}

/**
 * The window's figure: for each agent, its total now less its first sample
 * in the window from the same key, so an agent added at noon adds only its change since noon. The read
 * now counts as a sample where the agent has none in the window yet.
 *
 * `mark`: the start is the last session's mark, when the core was running. The agent's last sample at or
 * before it, within GAP_MS, is then the start, so a gap where the core stopped after the mark (and what
 * Candle booked meanwhile) is in the figure, not only what came after the restart.
 */
export function windowFigure(input: {
  window: PnlWindow | "since"
  label: string
  start: number | null
  now: { agent: string; prefix: string; at: number; totalUsd: number; unpriced?: number }[]
  samples: Pick<SampleStore, "firstFrom" | "lastAtOrBefore">
  mark?: boolean
}): WindowFigure {
  const agents: Record<string, AgentFigure> = {}
  let usd: number | null = null
  let from: number | null = null
  let unpriced: number | undefined
  for (const read of input.now) {
    const start = input.start
    const atMark = input.mark && start !== null ? input.samples.lastAtOrBefore(read.agent, read.prefix, start) : undefined
    const first = atMark && start! - atMark.at <= GAP_MS ? atMark : input.samples.firstFrom(read.agent, read.prefix, start ?? Number.NEGATIVE_INFINITY)
    const base: { at: number; totalUsd: number; unpriced?: number } | undefined = first && first.at <= read.at ? first : input.start === null || read.at >= input.start ? read : undefined
    if (!base) {
      agents[read.agent] = { usd: null, from: null }
      continue
    }
    const change = read.totalUsd - base.totalUsd
    // Marked alike at both ends, or a sample from before the count was kept: the change is the trading.
    const partial = read.unpriced !== undefined && base.unpriced !== undefined && read.unpriced !== base.unpriced
    if (partial) unpriced = (unpriced ?? 0) + read.unpriced!
    agents[read.agent] = { usd: change, from: base.at, ...(partial ? { partial: true as const } : {}) }
    usd = (usd ?? 0) + change
    from = from === null ? base.at : Math.min(from, base.at)
  }
  const short = from !== null && (input.start === null || from - input.start > GAP_MS)
  return { window: input.window, label: input.label, start: input.start, usd, from, short, ...(unpriced !== undefined ? { unpriced } : {}), agents }
}

// --- What Candle leaves out --------------------------------------------------------------------------

export interface JournalSwap {
  at: number
  agent: string
  opId: string
  title: string
  /** The card's value when proposed, ≈. */
  usd: number | null
  wallet?: string
  /** It ran without a card, inside its wallet's limits. */
  withoutCard?: true
}

/** The journal's filled live swaps since `from`, newest first: listed beside the fills, never added. */
export function journalSwaps(rows: readonly JournalRow[], from: number | null): JournalSwap[] {
  const cards = new Map<string, JournalRow>()
  const inside = new Set<string>()
  const out: JournalSwap[] = []
  for (const row of rows) {
    if (row.type === "card.created" && row.kind === "swap" && row.mode === "live" && typeof row.opId === "string") cards.set(row.opId, row)
    else if (row.type === "card.approved" && row.how === "inside-limits" && typeof row.opId === "string") inside.add(row.opId)
    else if (row.type === "operation.succeeded" && typeof row.opId === "string" && cards.has(row.opId)) {
      const at = Date.parse(row.at)
      if (from !== null && at < from) continue
      const card = cards.get(row.opId)!
      const value = record(card.value)
      const title = typeof card.headline === "string" ? card.headline : typeof card.title === "string" ? card.title : "a swap"
      const wallet = card.route === "cli" && typeof card.walletLabel === "string" ? card.walletLabel : typeof card.wallet === "string" && card.wallet !== "none" ? "embedded" : undefined
      out.push({ at, agent: card.agent ?? row.agent ?? "?", opId: row.opId, title, usd: num(value?.usd), ...(wallet ? { wallet } : {}), ...(inside.has(row.opId) ? { withoutCard: true as const } : {}) })
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, LISTED)
}

/** The transaction signature in an operation's result: Candle's MCP answer carries it on its job, the CLI's at its top. */
export function signatureOf(result: unknown, depth = 0): string | undefined {
  const r = record(result)
  if (!r || depth > 2) return undefined
  if (typeof r.signature === "string" && r.signature) return r.signature
  for (const v of Object.values(r)) {
    const found = typeof v === "object" ? signatureOf(v, depth + 1) : undefined
    if (found) return found
  }
  return undefined
}

/**
 * The signatures of live trades the core ran without a card, from the journal: the P&L
 * tab's Trades matches Candle's fills to them, so a fill says how it was approved.
 */
export function withoutCardSignatures(rows: readonly JournalRow[]): string[] {
  const inside = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    if (row.type === "card.approved" && row.how === "inside-limits" && row.mode === "live" && typeof row.opId === "string") inside.add(row.opId)
    else if (row.type === "operation.succeeded" && typeof row.opId === "string" && inside.has(row.opId)) {
      const sig = signatureOf(row.result)
      if (sig) out.push(sig)
    }
  }
  return out.slice(-200)
}

export interface PaperPnlPosition {
  mint: string
  symbol?: string
  tokens: number
  /** What the tokens still held cost, at the quotes, in dollars at today's price of what paid: ≈. */
  costUsd: number | null
  valueUsd: number | null
  unrealizedUsd: number | null
}

export interface PaperPnl {
  /** Sells' quoted proceeds less what the sold tokens cost, ≈; null when a sell's quote had no proceeds. */
  realizedUsd: number | null
  unrealizedUsd: number | null
  totalUsd: number | null
  positions: PaperPnlPosition[]
  /** Positions with no price to value them at. */
  unpriced: number
}

/** A sum of quote-asset amounts in dollars at the price book's prices, or null if one isn't priced. */
function inUsd(amounts: Record<string, number> | undefined, priceOf: (mint: string) => number | undefined): number | null {
  let usd = 0
  for (const [asset, amount] of Object.entries(amounts ?? {})) {
    if (amount === 0) continue
    const key = BASE_ASSETS[quoteAssetOf(asset) ?? "SOL"]?.priceKey
    const price = key ? priceOf(key) : undefined
    if (price === undefined) return null
    usd += amount * price
  }
  return usd
}

/**
 * An agent's paper P&L: the paper book's quoted costs and proceeds, and its tokens valued
 * at the price book's prices. Every figure is ≈ ("paper, at quoted prices"), and none is ever summed with
 * Candle's live figures.
 */
export function paperPnl(book: readonly PaperPosition[], priceOf: (mint: string) => number | undefined): PaperPnl {
  let realized: number | null = 0
  let unrealized: number | null = 0
  let unpriced = 0
  const positions: PaperPnlPosition[] = []
  for (const p of book) {
    const r = p.realizedUnknown ? null : inUsd(p.realized, priceOf)
    realized = realized === null || r === null ? null : realized + r
    if (p.tokens <= 0) continue
    const cost = inUsd(p.cost, priceOf)
    const price = priceOf(p.mint)
    const value = price === undefined ? null : p.tokens * price
    const u = cost === null || value === null ? null : value - cost
    if (value === null) unpriced++
    unrealized = unrealized === null || u === null ? null : unrealized + u
    positions.push({ mint: p.mint, ...(p.symbol ? { symbol: p.symbol } : {}), tokens: p.tokens, costUsd: cost, valueUsd: value, unrealizedUsd: u })
  }
  return { realizedUsd: realized, unrealizedUsd: unrealized, totalUsd: realized === null || unrealized === null ? null : realized + unrealized, positions, unpriced }
}

// --- The book, read on its pace ----------------------------------------------------------------------

/** Not a try: the call never reached Candle, so it's asked again soon. */
const notATry = (outcome: ToolOutcome) => outcome.kind === "error" && ["CANDLE_MCP_DOWN", "BUDGET_WAIT", "NO_AGENT"].includes(outcome.code)

/** Candle's refusal in its own words, or the code. */
function refusalWords(outcome: Exclude<ToolOutcome, { kind: "ok" }>): string {
  if (outcome.kind === "lost") return "Candle didn't answer"
  const message = record(record(outcome.body)?.error)?.message ?? record(outcome.body)?.message
  return typeof message === "string" && message.length > 0 ? terminalText(message, { maxLength: 120 }) : outcome.code
}

interface Slot {
  prefix: string
  book?: PnlBookView
  /** When `book` was read. */
  readAt?: number
  /** The last read failed: the book is the last good one, and this says why. */
  failed?: { at: number; words: string }
  trades?: PnlTrade[]
  tradesAt?: number
  tradesTriedAt?: number
  triedAt?: number
  retryAt?: number
  /** The follow-up reads after a fill, until the book shows it, and what the book was when it filled. */
  followUps?: number[]
  atFill?: string
  reading: boolean
  /** The read under way, which a read someone asked for waits on rather than starting a second. */
  inflight?: Promise<void>
}

/** What a fill changes in a book: its positions' amounts and the closed rounds. */
function bookPrint(book: PnlBookView | undefined): string {
  if (!book) return ""
  return `${book.closedRounds}|${book.positions.map((p) => `${p.wallet}:${p.mint}:${p.quantity}`).sort().join(",")}`
}

export interface AgentPnl {
  agent: string
  prefix: string
  /** When the book shown was read; null before any answer. */
  readAt: number | null
  book: PnlBookView | null
  failed?: { at: number; words: string }
}

export interface PnlView {
  window: PnlWindow
  figure: WindowFigure
  agents: AgentPnl[]
  /** The Candle Harness's agents' books summed: theirs, not the whole account's. Null before any book. */
  sum: PnlTotals | null
  wallets: (PnlWalletRow & { agents: string[] })[]
  /** Recent fills, newest first: read while a P&L pane is on screen. */
  trades: PnlTrade[]
  /** The journal's filled swaps in the window, which Candle's trades read leaves out. */
  swaps: JournalSwap[]
  /** Signatures of the live trades the core ran without a card, which Trades marks. */
  withoutCard?: string[]
  /** Each agent's paper P&L, ≈, at quoted prices: never summed with live. */
  paper: Record<string, PaperPnl>
  /** The first sample the Candle Harness has, of any agent: where the chart can start. */
  samplesFrom: number | null
}

export interface PnlDeps {
  /** A read through `agent`'s own key, inside its request budget (BUDGET_WAIT when it must wait); `asked`, one someone asked for, never waits. */
  call: (agent: string, tool: string, args: Record<string, unknown>, asked?: boolean) => Promise<ToolOutcome>
  /** The agents with a key, and its prefix. */
  agents: () => { agent: string; prefix: string }[]
  now: () => number
  samples: SampleStore
  /** Whether a view subscribes to `pnl`: each book every 60 s, with its fills. */
  wanted: () => boolean
  /** When the main view was last closed, for "since last session". */
  sessionEnd: () => number | undefined
  window: () => PnlWindow
  /** The journal rows in memory, for the swaps. */
  rows: () => readonly JournalRow[]
  paper: () => Record<string, PaperPosition[]>
  priceOf: (mint: string) => number | undefined
  symbolOf?: (mint: string) => string | undefined
  /** How many times its own pace P&L now waits, from the key's budget; 1 when it fits. */
  stretch?: () => number
  /** After every read that changed something. */
  publish: () => void
}

export class PnlBook {
  private readonly slots = new Map<string, Slot>()
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: PnlDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.poke()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Something changed what's wanted (a subscription, an agent added): plan the next turn again. */
  poke(): void {
    if (!this.running) return
    clearTimeout(this.timer)
    this.timer = undefined
    void this.tick()
  }

  /**
   * A fill: every agent's book is read again in a few seconds, since a sell can move a round between books.
   * The agent that filled (when known) is read again at PNL_FOLLOW_UP_MS until its book has changed and,
   * with a P&L pane on screen, its fills carry their amounts.
   */
  afterFill(filledBy?: string): void {
    const now = this.deps.now()
    const at = now + PNL_AFTER_FILL_MS
    for (const { agent } of this.deps.agents()) {
      const s = this.slot(agent)
      s.retryAt = Math.min(s.retryAt ?? Number.POSITIVE_INFINITY, at)
      if (agent !== filledBy) continue
      if (s.followUps === undefined) s.atFill = bookPrint(s.book)
      s.followUps = [...new Set([...(s.followUps ?? []), ...PNL_FOLLOW_UP_MS.map((ms) => now + ms)])].sort((x, y) => x - y)
    }
    this.poke()
  }

  /** Each agent's book's own pace, before the budget stretches it. */
  paceMs(): number {
    return this.deps.wanted() ? PNL_ON_SCREEN_MS : PNL_BACKGROUND_MS
  }

  /** Reads a minute at its own pace (its fills too while on screen), and one a minute per agent first. */
  demand(): { perMin: number; agents: number } {
    if (!this.running) return { perMin: 0, agents: 0 }
    const n = this.deps.agents().length
    return { perMin: (n * 60_000 * (this.deps.wanted() ? 2 : 1)) / this.paceMs(), agents: n }
  }

  /** One turn: every agent that's due, read together. */
  async step(): Promise<void> {
    const now = this.deps.now()
    await Promise.all(
      this.deps
        .agents()
        .filter(({ agent }) => this.due(agent, now))
        .map(({ agent, prefix }) => this.read(agent, prefix)),
    )
  }

  /**
   * Every agent's book read now, as a read someone asked for (the Away summary's "now"),
   * never waiting on the key's budget. An agent whose read is already under way isn't read twice.
   */
  async readNow(): Promise<void> {
    const asked = this.deps.now()
    await Promise.all(
      this.deps.agents().map(async ({ agent, prefix }) => {
        const s = this.slots.get(agent)
        if (!s?.reading) return this.read(agent, prefix, true)
        // A fresh core's own first read is usually under way when the Away summary asks (without waiting, a gap
        // with the core gone said "No P&L sample in the gap yet."). Wait for it, and read again if it brought
        // no book, as when the key's budget put it off.
        await s.inflight
        const now = this.slots.get(agent)
        if (now?.prefix === prefix && (now.readAt === undefined || now.readAt < asked) && !now.reading) await this.read(agent, prefix, true)
      }),
    )
  }

  /** Why an agent's last read failed, until one answers. */
  failedWords(agent: string): string | undefined {
    return this.slots.get(agent)?.failed?.words
  }

  /** The window's figure now: the person's window, or a `since` start the agent passed. */
  figure(override?: { start: number | null; label: string; mark?: boolean }): WindowFigure {
    const window = this.deps.window()
    const now = this.deps.now()
    const reads = this.deps
      .agents()
      .flatMap(({ agent, prefix }) => {
        const s = this.slots.get(agent)
        return s?.book && s.readAt !== undefined && s.prefix === prefix ? [{ agent, prefix, at: s.readAt, totalUsd: s.book.totals.totalUsd, unpriced: s.book.unmarked + s.book.unvalued }] : []
      })
    return windowFigure({
      window: override ? "since" : window,
      label: override?.label ?? windowLabel(window),
      start: override ? override.start : windowStart(window, now, this.deps.sessionEnd()),
      now: reads,
      samples: this.deps.samples,
      mark: override ? override.mark === true : window === "session",
    })
  }

  agentsView(): AgentPnl[] {
    return this.deps.agents().map(({ agent, prefix }) => {
      const s = this.slots.get(agent)
      const own = s?.prefix === prefix ? s : undefined
      return { agent, prefix, readAt: own?.readAt ?? null, book: own?.book ?? null, ...(own?.failed ? { failed: own.failed } : {}) }
    })
  }

  view(): PnlView {
    const figure = this.figure()
    const agents = this.agentsView()
    const books = agents.flatMap((a) => (a.book ? [{ agent: a.agent, book: a.book }] : []))
    const trades = agents.flatMap((a) => this.slots.get(a.agent)?.trades ?? []).sort((x, y) => y.at - x.at)
    const paper: Record<string, PaperPnl> = {}
    // The Candle Harness's agents only: the journal can hold paper rows of an agent since taken out of config.
    const own = new Set(this.deps.agents().map((a) => a.agent))
    for (const [agent, book] of Object.entries(this.deps.paper())) if (own.has(agent)) paper[agent] = paperPnl(book, this.deps.priceOf)
    const firsts = this.deps.samples.agents().map((a) => this.deps.samples.of(a)[0]?.at ?? Number.POSITIVE_INFINITY)
    const samplesFrom = Math.min(...firsts)
    return {
      window: this.deps.window(),
      figure,
      agents,
      sum: sumTotals(books.map((b) => b.book)),
      wallets: walletsAcross(books),
      trades,
      swaps: journalSwaps(this.deps.rows(), figure.start),
      withoutCard: withoutCardSignatures(this.deps.rows()),
      paper,
      samplesFrom: Number.isFinite(samplesFrom) ? samplesFrom : null,
    }
  }

  /**
   * The Candle Harness's agents' total over time from the samples, for the chart: one point a bucket, the sum of each
   * agent's last sample in it, with null where every agent's samples have a gap. Only buckets from `from`.
   */
  series(from: number, points = 120): { at: number; usd: number | null }[] {
    const now = this.deps.now()
    const start = Math.max(from, Math.min(...this.deps.samples.agents().map((a) => this.deps.samples.of(a)[0]?.at ?? now), now))
    const step = Math.max(SAMPLE_EVERY_MS, Math.ceil((now - start) / Math.max(1, points)))
    const out: { at: number; usd: number | null }[] = []
    for (let at = start + step; at <= now + step - 1; at += step) {
      let sum: number | null = null
      for (const agent of this.deps.samples.agents()) {
        const last = lastAtOrBefore(this.deps.samples.of(agent), Math.min(at, now))
        // A sample further back than a gap isn't the agent's figure at this point.
        if (last && Math.min(at, now) - last.at <= Math.max(GAP_MS, step)) sum = (sum ?? 0) + last.totalUsd
      }
      out.push({ at: Math.min(at, now), usd: sum })
    }
    return out
  }

  private async tick(): Promise<void> {
    await this.step().catch(() => {})
    if (!this.running || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, this.nextMs())
    this.timer.unref?.()
  }

  private dueAt(agent: string): number {
    const s = this.slots.get(agent)
    if (!s || s.triedAt === undefined) return s?.retryAt ?? Number.NEGATIVE_INFINITY
    // A P&L pane just opened: its fills haven't been read yet, so now.
    if (this.deps.wanted() && s.tradesTriedAt === undefined) return s.retryAt ?? s.triedAt
    const paced = s.triedAt + this.paceMs() * Math.max(1, this.deps.stretch?.() ?? 1)
    return Math.min(s.retryAt ?? paced, s.followUps?.[0] ?? paced, paced)
  }

  private due(agent: string, now: number): boolean {
    if (this.slots.get(agent)?.reading) return false
    return this.dueAt(agent) <= now + 250
  }

  /** Until the next agent is due, at least a second. */
  nextMs(): number {
    const now = this.deps.now()
    const soonest = Math.min(...this.deps.agents().map(({ agent }) => this.dueAt(agent) - now))
    return Number.isFinite(soonest) ? Math.max(1_000, Math.ceil(soonest)) : PNL_BACKGROUND_MS
  }

  private slot(agent: string, prefix?: string): Slot {
    let s = this.slots.get(agent)
    // Another key under the agent's name: its book starts again.
    if (!s || (prefix !== undefined && s.prefix !== prefix)) {
      s = { prefix: prefix ?? s?.prefix ?? "", reading: false, ...(s?.retryAt !== undefined ? { retryAt: s.retryAt } : {}) }
      this.slots.set(agent, s)
    }
    return s
  }

  private async call(agent: string, tool: string, args: Record<string, unknown>, asked?: boolean): Promise<ToolOutcome> {
    try {
      return await this.deps.call(agent, tool, args, asked)
    } catch (e) {
      return { kind: "error", code: "UNKNOWN_ERROR", retryable: true, body: { message: e instanceof Error ? e.message : String(e) } }
    }
  }

  private read(agent: string, prefix: string, asked = false): Promise<void> {
    const s = this.slot(agent, prefix)
    const p = this.readOnce(s, agent, prefix, asked)
    s.inflight = p
    return p
  }

  private async readOnce(s: Slot, agent: string, prefix: string, asked: boolean): Promise<void> {
    s.reading = true
    const at = this.deps.now()
    const agentOf = (p: string) => this.deps.agents().find((a) => a.prefix === p)?.agent
    let changed = false
    try {
      const outcome = await this.call(agent, "candle_get_profile_pnl", { keyPrefix: prefix }, asked)
      if (notATry(outcome)) {
        s.retryAt = this.deps.now() + PNL_RETRY_SOON_MS
        return
      }
      s.triedAt = at
      delete s.retryAt
      const now = this.deps.now()
      const book = outcome.kind === "ok" ? bookFrom(outcome.result, prefix, agentOf, this.deps.symbolOf) : undefined
      if (book) {
        s.book = book
        s.readAt = now
        delete s.failed
        this.deps.samples.add({ at: now, agent, prefix, totalUsd: book.totals.totalUsd, realizedNetUsd: book.totals.realizedNetUsd, unrealizedUsd: book.totals.unrealizedUsd, unpriced: book.unmarked + book.unvalued })
      } else s.failed = { at: now, words: outcome.kind === "ok" ? "Candle's answer had no P&L" : refusalWords(outcome) }
      changed = true
      // The fills, only while a P&L pane is on screen.
      if (this.deps.wanted()) {
        s.tradesTriedAt = this.deps.now()
        const read = await this.call(agent, "candle_get_profile_trades", { keyPrefix: prefix, limit: TRADES_LIMIT })
        const trades = read.kind === "ok" ? tradesFrom(read.result, agent, this.deps.symbolOf) : undefined
        if (trades) {
          s.trades = trades
          s.tradesAt = this.deps.now()
        }
      }
      if (s.followUps) {
        const left = s.followUps.filter((t) => t > at + 250)
        // Booked: the book moved, and no fill on screen still waits for its amount.
        const booked = bookPrint(s.book) !== s.atFill && !(this.deps.wanted() && (s.trades ?? []).some((t) => t.usd === null && !t.error))
        if (booked || left.length === 0) {
          delete s.followUps
          delete s.atFill
        } else s.followUps = left
      }
    } finally {
      s.reading = false
      if (changed) this.deps.publish()
    }
  }
}

function lastAtOrBefore(list: readonly PnlSample[], at: number): PnlSample | undefined {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]!.at <= at) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? list[lo - 1] : undefined
}

// --- The window's pick, and the last session's end -----------------------------------------------------

export interface WindowState {
  window?: PnlWindow
  /** When the main view was last closed (epoch ms). */
  sessionEnd?: number
}

export function readWindowState(path: string): WindowState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const window = parseWindow(raw.window)
    const end = typeof raw.sessionEnd === "string" ? Date.parse(raw.sessionEnd) : Number.NaN
    return { ...(window.ok ? { window: window.window } : {}), ...(Number.isFinite(end) ? { sessionEnd: end } : {}) }
  } catch {
    return {}
  }
}

export async function saveWindowState(path: string, state: WindowState, now: number): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  const body = { ...(state.window ? { window: state.window } : {}), ...(state.sessionEnd !== undefined ? { sessionEnd: new Date(state.sessionEnd).toISOString() } : {}), at: new Date(now).toISOString() }
  await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

/**
 * When the main view was last closed, from the journal's rows: the newest `client.detached` of a view
 * that attached as the main view (not a popped pane's, `candle-harness view --pane …`). A core that died with
 * the main view attached (a power cut, a kill) leaves no close, so that session ended at the journal's last
 * row before the next `core.started`, when that's later. Otherwise
 * "since last session" would replay the whole last session. `runEnded`: the rows end with a core that has
 * stopped, as at a core's start before its own `core.started`, so a view still open at the end died with it.
 */
export function lastSessionEnd(rows: readonly JournalRow[], opts: { runEnded?: boolean } = {}): number | undefined {
  const open = new Set<string>()
  let end: number | undefined
  let previous: JournalRow | undefined
  const later = (iso: string) => {
    const at = Date.parse(iso)
    if (Number.isFinite(at) && (end === undefined || at > end)) end = at
  }
  for (const row of rows) {
    if (row.type === "core.started") {
      if (open.size > 0 && previous) later(previous.at)
      open.clear()
    } else if (row.type === "client.attached" && row.role === "view" && typeof row.clientId === "string" && !(typeof row.clientName === "string" && row.clientName.includes("--pane"))) open.add(row.clientId)
    else if (row.type === "client.detached" && typeof row.clientId === "string" && open.delete(row.clientId)) later(row.at)
    previous = row
  }
  if (opts.runEnded && open.size > 0 && previous) later(previous.at)
  return end
}
