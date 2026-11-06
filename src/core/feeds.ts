// Candle's four curated lists, sent on the `feeds` topic: New, Graduated,
// On Fire and Final Stretch, each one `candle_get_feed` read by its `bucket` (docs, "Feed";
// docs.candle.tv/developers/market-state). A view's subscription names the buckets its panes show (a filter, as
// `signals` takes one), and each bucket is read only while someone wants it:
//   - every 15 s while a Trending list is on screen, all wanted lists together;
//   - On Fire alone (the Cockpit's Feed pane, and the token pane's and Positions' empty states, which read
//     `market.trending` from here) every 60 s while any view is attached;
//   - each stretched by the key's request budget (key-budget.ts) when it can't fit them all.
// Each list is read whole at `limit` 20 every time, with only the fields its pane draws (on Candle's real
// server a delta read came back `reset` within 20 s, so `since_seq` saves nothing). A failed read keeps the
// last list and says when it was read. A read that never reached Candle (its server not up yet, or a wait for
// room in the key's budget) isn't a try: it's asked again in a few seconds.
//
// Final Stretch tells the truth about itself: off where Candle's server doesn't have it
// (`VALIDATION_FAILED` on the bucket, as an unknown bucket is), asked again every 10 minutes; empty only
// while `feed.ok`, `exact.ok` and `!stale` hold (the docs: only then does an empty list mean nothing
// qualifies); behind otherwise, with how far.
import { terminalText } from "../shared/terminal-text"
import type { ToolOutcome } from "./candle-mcp"
import type { TokenView } from "./token-watch"

export const BUCKETS = ["new", "graduated", "onfire", "finalstretch"] as const
export type Bucket = (typeof BUCKETS)[number]
export const isBucket = (value: unknown): value is Bucket => typeof value === "string" && (BUCKETS as readonly string[]).includes(value)

/** A wanted list's pace while a Trending list is on screen. */
export const FEED_MS = 15_000
/** On Fire's pace on its own: the Feed pane and the empty states. */
export const ONFIRE_MS = 60_000
/** Final Stretch where Candle's server has it off: asked again this often, in case it's switched on. */
export const OFF_RETRY_MS = 10 * 60_000
/** A read that never reached Candle is asked again this soon. */
export const RETRY_SOON_MS = 5_000
export const FEED_LIMIT = 20

/**
 * The fields each list's pane draws (`fields` refuses `_creationTime` by name, so a token's age is
 * `createdAt`). `chain`, `address` and `symbol` always come back. On Fire's are what the Feed pane draws.
 * `launchpad` and `isCandle` say where a token was launched, the column that took the price's place (the
 * per-unit price told a trader almost nothing).
 */
export const FEED_FIELDS: Readonly<Record<Bucket, string>> = {
  new: "name,priceUsd,marketCap,change1h,createdAt,launchpad,isCandle",
  graduated: "name,priceUsd,marketCap,change1h,graduatedAt,launchpad,isCandle",
  onfire: "name,marketCap,priceUsd,change1h,launchpad,isCandle",
  finalstretch: "name,priceUsd,marketCap,progress,lastTradeAt,launchpad,isCandle",
}

export interface FeedRow {
  mint: string
  symbol: string
  name?: string
  /** Missing shows as missing, never zero: Final Stretch's rows often have neither. */
  marketCap: number | null
  priceUsd: number | null
  /** The hour's change as a fraction (Candle sends a percent). */
  change1h: number | null
  /** New: when the token was made (epoch ms). */
  createdAt?: number
  /** Graduated: when it graduated (epoch ms). */
  graduatedAt?: number
  /** Final Stretch: how far along the bonding curve, 0 to 1. */
  progress?: number
  /** Final Stretch: its last trade (epoch ms). */
  lastTradeAt?: number
  /** Where it was launched, short: "pump", "bonk", "candle"; on Hood, "hood". */
  where?: string
}

/**
 * A row's launch, in six cells: Candle's own launches as "candle", else the launchpad's first word
 * ("pump.fun" is "pump", "letsbonk.fun" "bonk"); on Hood, "hood", the chain saying more than the pad. The
 * lists are read for Solana, so Solana goes unsaid.
 */
export function whereOf(t: Record<string, unknown>): string | undefined {
  const pad = typeof t.launchpad === "string" ? t.launchpad.toLowerCase().replace(/^https?:\/\//, "").replace(/^(www\.|lets)/, "").split(/[.\s/]/)[0]!.replace(/[^a-z0-9-]/g, "").slice(0, 6) : ""
  if (t.chain === "hood") return "hood"
  if (t.isCandle === true) return "candle"
  if (pad) return pad
  // Candle names no launchpad for most Final Stretch rows yet. pump.fun's mints end in "pump", and in
  // Candle's recorded lists every one Candle named was pump.fun's, so the address says it.
  const address = typeof t.address === "string" ? t.address : typeof t.mint === "string" ? t.mint : ""
  return address.endsWith("pump") ? "pump" : undefined
}

export interface FeedList {
  bucket: Bucket
  /** When the list shown was read; null before any answer. */
  at: number | null
  rows: FeedRow[]
  /** How many tokens the list holds in all, of which `rows` are the top. */
  matched?: number
  /** The last read failed: the rows are the last good list's, and this says why. */
  failed?: { at: number; words: string }
  /** Final Stretch only: off on Candle's server, or its source behind (`behindS` seconds, when Candle says). */
  state?: "off" | "behind"
  behindS?: number
}

export type FeedsView = Partial<Record<Bucket, FeedList>>

/** A `feeds` subscription's filter: the buckets its panes show. None given means all four. */
export interface FeedsFilter {
  buckets: Bucket[]
}

/** The `feeds` topic's filter: a subscription names its buckets, and gets only theirs. */
export const feedsTopicFilter = {
  parse(raw: unknown): FeedsFilter | { problem: string } {
    const buckets = (raw as { buckets?: unknown } | null)?.buckets
    if (!Array.isArray(buckets) || buckets.length === 0) return { problem: `feeds takes {buckets: [...]}, from ${BUCKETS.join(", ")}.` }
    const bad = buckets.find((b) => !isBucket(b))
    if (bad !== undefined) return { problem: `No list called ${terminalText(String(bad), { maxLength: 40 })}: the lists are ${BUCKETS.join(", ")}.` }
    return { buckets: [...new Set(buckets as Bucket[])] }
  },
  apply(data: unknown, filter: FeedsFilter): unknown | undefined {
    const view = (data ?? {}) as FeedsView
    const cut: FeedsView = {}
    for (const b of filter.buckets) if (view[b]) cut[b] = view[b]
    return Object.keys(cut).length ? cut : undefined
  },
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 ? terminalText(value, { maxLength: max }) : undefined)
/** A time Candle sends as epoch ms or an ISO date. */
const time = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

/** A list's rows from Candle's answer: those that name a token, its figures read as they are. */
export function feedRows(result: unknown): FeedRow[] | undefined {
  const body = record(result)
  const tokens = body?.tokens ?? record(body?.data)?.tokens
  if (!Array.isArray(tokens)) return undefined
  return tokens
    .map((t) => record(t))
    .filter((t): t is Record<string, unknown> => typeof t?.address === "string" && t.address.length > 0 && typeof t.symbol === "string" && t.symbol.length > 0)
    .map((t) => {
      const name = text(t.name, 40)
      const price = num(t.priceUsd)
      const change = num(t.change1h)
      const progress = num(t.progress)
      const createdAt = time(t.createdAt)
      const graduatedAt = time(t.graduatedAt)
      const lastTradeAt = time(t.lastTradeAt)
      const where = whereOf(t)
      return {
        mint: String(t.address),
        symbol: text(t.symbol, 16)!,
        ...(name ? { name } : {}),
        marketCap: num(t.marketCap),
        priceUsd: price !== null && price > 0 ? price : null,
        change1h: change === null ? null : change / 100,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(graduatedAt !== undefined ? { graduatedAt } : {}),
        ...(progress !== null ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
        ...(lastTradeAt !== undefined ? { lastTradeAt } : {}),
        ...(where ? { where } : {}),
      }
    })
}

/** Final Stretch's own words on its source: behind unless `feed.ok`, `exact.ok` and `!stale` all hold. */
function stretchState(result: unknown): Pick<FeedList, "state" | "behindS"> {
  const body = record(result)
  const feed = record(body?.feed)
  const exact = record(body?.exact)
  const trusted = feed?.ok === true && exact?.ok === true && body?.stale !== true
  if (trusted) return {}
  const age = num(feed?.ageS)
  return { state: "behind", ...(age !== null && age >= 0 ? { behindS: Math.round(age) } : {}) }
}

/** Candle's refusal in its own words, or the code. */
export function refusalWords(outcome: Exclude<ToolOutcome, { kind: "ok" }>): string {
  if (outcome.kind === "lost") return "Candle didn't answer"
  const message = record(record(outcome.body)?.error)?.message ?? record(outcome.body)?.message
  return typeof message === "string" && message.length > 0 ? terminalText(message, { maxLength: 120 }) : outcome.code
}

/** Whether Candle refused the bucket itself: Final Stretch off on its server reads as an unknown bucket. */
const bucketRefused = (outcome: ToolOutcome) => outcome.kind === "error" && outcome.code === "VALIDATION_FAILED" && record(record(outcome.body)?.error)?.field === "bucket"

/**
 * Final Stretch from one read (the doctor's): on, behind (with how far, when Candle says), off on
 * Candle's server, or the read's failure in words.
 */
export function stretchFrom(outcome: ToolOutcome): { state: "on" | "behind" | "off"; behindS?: number } | { state: "failed"; words: string } {
  if (outcome.kind === "ok") {
    const s = stretchState(outcome.result)
    return s.state === "behind" ? { state: "behind", ...(s.behindS !== undefined ? { behindS: s.behindS } : {}) } : { state: "on" }
  }
  if (bucketRefused(outcome)) return { state: "off" }
  return { state: "failed", words: refusalWords(outcome) }
}

/** Not a try: the call never reached Candle, so it's asked again soon rather than at its next turn. */
const notATry = (outcome: ToolOutcome) => outcome.kind === "error" && ["CANDLE_MCP_DOWN", "BUDGET_WAIT", "NO_AGENT"].includes(outcome.code)

interface Slot {
  list: FeedList
  /** When it was last tried, for its pace. */
  triedAt?: number
  /** A read that never reached Candle: tried again at this time. */
  retryAt?: number
  reading: boolean
}

export class Feeds {
  private readonly slots = new Map<Bucket, Slot>()
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly deps: {
      call: (tool: string, args: Record<string, unknown>) => Promise<ToolOutcome>
      now: () => number
      /** The buckets the views' subscriptions name now. */
      wanted: () => ReadonlySet<Bucket>
      publish: (view: FeedsView, changed: Bucket) => void
      /** How many times its own pace the lists now wait, from the key's budget; 1 when they fit. */
      stretch?: () => number
    },
  ) {}

  view(): FeedsView {
    const out: FeedsView = {}
    for (const [b, s] of this.slots) out[b] = s.list
    return out
  }

  /** On Fire as the token pane's empty state and Positions' read it (`market.trending`), the same list Feed shows. */
  trending(): TokenView["trending"] {
    const list = this.slots.get("onfire")?.list
    if (!list || list.at === null) return null
    return { bucket: "onfire", at: list.at, rows: list.rows.map((r) => ({ mint: r.mint, symbol: r.symbol, ...(r.name ? { name: r.name } : {}), marketCap: r.marketCap, priceUsd: r.priceUsd, change1h: r.change1h, ...(r.where ? { where: r.where } : {}) })) }
  }

  /** The lists read now: those wanted, and On Fire while any view is attached. */
  active(): Bucket[] {
    if (!this.running) return []
    const wanted = this.deps.wanted()
    return BUCKETS.filter((b) => b === "onfire" || wanted.has(b))
  }

  /** On Fire keeps the lists' 15 s only while another list is on screen beside it. */
  private fast(): boolean {
    const wanted = this.deps.wanted()
    return BUCKETS.some((b) => b !== "onfire" && wanted.has(b))
  }

  /** A bucket's own pace, before the budget stretches it. */
  naturalMs(bucket: Bucket): number {
    if (bucket === "finalstretch" && this.slots.get(bucket)?.list.state === "off") return OFF_RETRY_MS
    if (bucket === "onfire" && !this.fast()) return ONFIRE_MS
    return FEED_MS
  }

  /** The lists' pace, for the pane that says it's slowed: the fastest wanted's. */
  paceMs(): number {
    return this.fast() ? FEED_MS : ONFIRE_MS
  }

  /** Reads a minute at each list's own pace (for the key's budget), and one a minute per list first. */
  demand(): { perMin: number; lists: number } {
    const active = this.active()
    return { perMin: active.reduce((n, b) => n + 60_000 / this.naturalMs(b), 0), lists: active.length }
  }

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

  /** The subscriptions changed: read what's newly wanted now, and plan the next turn again. */
  poke(): void {
    if (!this.running) return
    clearTimeout(this.timer)
    this.timer = undefined
    void this.tick()
  }

  /** One turn: every active list that's due, read together. */
  async step(): Promise<void> {
    const now = this.deps.now()
    await Promise.all(this.active().filter((b) => this.due(b, now)).map((b) => this.read(b)))
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

  private stretch(): number {
    return Math.max(1, this.deps.stretch?.() ?? 1)
  }

  private dueAt(bucket: Bucket): number {
    const s = this.slots.get(bucket)
    if (!s || s.triedAt === undefined) return s?.retryAt ?? Number.NEGATIVE_INFINITY
    return s.retryAt ?? s.triedAt + this.naturalMs(bucket) * this.stretch()
  }

  private due(bucket: Bucket, now: number): boolean {
    if (this.slots.get(bucket)?.reading) return false
    // A little slack, so a timer that fires a little early still counts.
    return this.dueAt(bucket) <= now + 250
  }

  /** Until the next list is due, at least a second. */
  nextMs(): number {
    const now = this.deps.now()
    const soonest = Math.min(...this.active().map((b) => this.dueAt(b) - now))
    return Number.isFinite(soonest) ? Math.max(1_000, Math.ceil(soonest)) : FEED_MS
  }

  private slot(bucket: Bucket): Slot {
    let s = this.slots.get(bucket)
    if (!s) {
      s = { list: { bucket, at: null, rows: [] }, reading: false }
      this.slots.set(bucket, s)
    }
    return s
  }

  private async read(bucket: Bucket): Promise<void> {
    const s = this.slot(bucket)
    s.reading = true
    const at = this.deps.now()
    let outcome: ToolOutcome
    try {
      outcome = await this.deps.call("candle_get_feed", { bucket, chain: "solana", fields: FEED_FIELDS[bucket], limit: FEED_LIMIT })
    } catch (e) {
      outcome = { kind: "error", code: "UNKNOWN_ERROR", retryable: true, body: { message: e instanceof Error ? e.message : String(e) } }
    } finally {
      s.reading = false
    }
    if (notATry(outcome)) {
      s.retryAt = this.deps.now() + RETRY_SOON_MS
      return
    }
    s.triedAt = at
    delete s.retryAt
    const now = this.deps.now()
    if (outcome.kind === "ok") {
      const rows = feedRows(outcome.result)
      if (rows) {
        const matched = num(record(outcome.result)?.matched)
        s.list = { bucket, at: now, rows, ...(matched !== null ? { matched } : {}), ...(bucket === "finalstretch" ? stretchState(outcome.result) : {}) }
      } else s.list = { ...s.list, failed: { at: now, words: "Candle's answer had no list" } }
    } else if (bucket === "finalstretch" && bucketRefused(outcome)) {
      s.list = { bucket, at: now, rows: [], state: "off" }
    } else {
      s.list = { ...s.list, failed: { at: now, words: refusalWords(outcome) } }
    }
    this.deps.publish(this.view(), bucket)
  }
}
