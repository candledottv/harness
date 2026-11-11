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
import { type ChainSlug, maybeChain } from "../shared/chains"

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
 * `createdAt`, or `firstSeenAt` where Candle sends no creation time, as for most new Hood tokens). `chain`, `address` and `symbol` always come back. On Fire's are what the Feed pane draws.
 * `launchpad` and `isCandle` say where a token was launched, the column that took the price's place (the
 * per-unit price told a trader almost nothing).
 */
export const FEED_FIELDS: Readonly<Record<Bucket, string>> = {
  new: "name,priceUsd,marketCap,change1h,createdAt,firstSeenAt,launchpad,isCandle",
  graduated: "name,priceUsd,marketCap,change1h,graduatedAt,launchpad,isCandle",
  onfire: "name,marketCap,priceUsd,change1h,launchpad,isCandle",
  finalstretch: "name,priceUsd,marketCap,progress,lastTradeAt,launchpad,isCandle",
}

export interface FeedRow {
  mint: string
  /** Its chain, as Candle's answer names it, else the chain the list was read for. */
  chain?: ChainSlug
  symbol: string
  name?: string
  /** Missing shows as missing, never zero: Final Stretch's rows often have neither. */
  marketCap: number | null
  priceUsd: number | null
  /** The hour's change as a fraction (Candle sends a percent). */
  change1h: number | null
  /** New: when the token was made (epoch ms), or Candle first saw it where it sends no creation time. */
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

/** A list's rows from Candle's answer, read for `asked`: those that name a token, its figures read as they are. */
export function feedRows(result: unknown, asked: ChainSlug = "solana"): FeedRow[] | undefined {
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
      const createdAt = time(t.createdAt) ?? time(t.firstSeenAt)
      const graduatedAt = time(t.graduatedAt)
      const lastTradeAt = time(t.lastTradeAt)
      const where = whereOf(t)
      return {
        mint: String(t.address),
        chain: maybeChain(t.chain)?.slug ?? asked,
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

/** A chain whose lists are read, and whether at half the pace (another chain beside it, so both fit the key's budget). */
export interface FeedChain {
  chain: ChainSlug
  slow?: boolean
}

/** One list on one chain. */
interface Read {
  bucket: Bucket
  chain: ChainSlug
  slow: boolean
}

const slotKey = (chain: ChainSlug, bucket: Bucket) => `${chain}:${bucket}`

/** Each list's rows across the chains read, in the list's own order: New by when made, Graduated by when, the others rank by rank. */
function mergeRows(bucket: Bucket, lists: readonly FeedRow[][]): FeedRow[] {
  if (lists.length === 1) return lists[0]!
  if (bucket === "new" || bucket === "graduated") {
    const at = (r: FeedRow) => (bucket === "new" ? r.createdAt : r.graduatedAt) ?? Number.NEGATIVE_INFINITY
    return lists.flat().sort((a, b) => at(b) - at(a))
  }
  const out: FeedRow[] = []
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i]) out.push(l[i]!)
  return out
}

export class Feeds {
  private readonly slots = new Map<string, Slot>()
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
      /** The chains read now (the account's, under the chain filter); Solana's alone without it. */
      chains?: () => readonly FeedChain[]
    },
  ) {}

  private chains(): readonly FeedChain[] {
    return this.deps.chains?.() ?? [{ chain: "solana" }]
  }

  /** Each list as the views draw it: its rows on every chain read now, each with its chain. */
  view(): FeedsView {
    const out: FeedsView = {}
    for (const bucket of BUCKETS) {
      const lists = this.chains()
        .map((c) => this.slots.get(slotKey(c.chain, bucket))?.list)
        .filter((l): l is FeedList => l !== undefined)
      if (!lists.length) continue
      const read = lists.filter((l) => l.at !== null)
      const failed = lists.find((l) => l.failed)?.failed
      const matched = lists.every((l) => l.matched !== undefined) ? lists.reduce((n, l) => n + l.matched!, 0) : undefined
      const solana = lists.find((l) => l.rows.every((r) => r.chain !== "hood")) ?? lists[0]!
      out[bucket] = {
        bucket,
        at: read.length ? Math.min(...read.map((l) => l.at!)) : null,
        rows: mergeRows(bucket, lists.map((l) => l.rows)),
        ...(matched !== undefined ? { matched } : {}),
        ...(failed ? { failed } : {}),
        ...(solana.state ? { state: solana.state } : {}),
        ...(solana.behindS !== undefined ? { behindS: solana.behindS } : {}),
      }
    }
    return out
  }

  /** On Fire as the token pane's empty state and Positions' read it (`market.trending`), the same list Feed shows. */
  trending(): TokenView["trending"] {
    const list = this.view().onfire
    if (!list || list.at === null) return null
    return { bucket: "onfire", at: list.at, rows: list.rows.map((r) => ({ mint: r.mint, symbol: r.symbol, ...(r.name ? { name: r.name } : {}), marketCap: r.marketCap, priceUsd: r.priceUsd, change1h: r.change1h, ...(r.where ? { where: r.where } : {}) })) }
  }

  /**
   * The lists read now: those wanted, and On Fire while any view is attached, on each chain read. A chain read at
   * half the pace reads only the lists on screen, and Final Stretch, pump.fun's, is read on Solana alone.
   */
  private reads(): Read[] {
    if (!this.running) return []
    const wanted = this.deps.wanted()
    return this.chains().flatMap((c) =>
      BUCKETS.filter((b) => (b !== "finalstretch" || c.chain === "solana") && (c.slow ? wanted.has(b) : b === "onfire" || wanted.has(b))).map((bucket) => ({ bucket, chain: c.chain, slow: c.slow === true })),
    )
  }

  /** The lists read now, by name (each once, whatever its chains). */
  active(): Bucket[] {
    return [...new Set(this.reads().map((r) => r.bucket))]
  }

  /** On Fire keeps the lists' 15 s only while another list is on screen beside it. */
  private fast(): boolean {
    const wanted = this.deps.wanted()
    return BUCKETS.some((b) => b !== "onfire" && wanted.has(b))
  }

  /** A bucket's own pace on a chain, before the budget stretches it: twice as long on a chain read slowly. */
  naturalMs(bucket: Bucket, chain: ChainSlug = "solana"): number {
    const slow = this.chains().find((c) => c.chain === chain)?.slow === true ? 2 : 1
    if (bucket === "finalstretch" && this.slots.get(slotKey(chain, bucket))?.list.state === "off") return OFF_RETRY_MS
    if (bucket === "onfire" && !this.fast()) return ONFIRE_MS * slow
    return FEED_MS * slow
  }

  /** The lists' pace, for the pane that says it's slowed: the fastest wanted's. */
  paceMs(): number {
    return this.fast() ? FEED_MS : ONFIRE_MS
  }

  /** Reads a minute at each list's own pace (for the key's budget), and one a minute per list first. */
  demand(): { perMin: number; lists: number } {
    const reads = this.reads()
    return { perMin: reads.reduce((n, r) => n + 60_000 / this.naturalMs(r.bucket, r.chain), 0), lists: reads.length }
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

  /** The subscriptions or the chains changed: read what's newly wanted now, and plan the next turn again. */
  poke(): void {
    if (!this.running) return
    clearTimeout(this.timer)
    this.timer = undefined
    void this.tick()
  }

  /** One turn: every list that's due, on each chain, read together. */
  async step(): Promise<void> {
    const now = this.deps.now()
    await Promise.all(this.reads().filter((r) => this.due(r, now)).map((r) => this.read(r)))
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

  private dueAt(r: Read): number {
    const s = this.slots.get(slotKey(r.chain, r.bucket))
    if (!s || s.triedAt === undefined) return s?.retryAt ?? Number.NEGATIVE_INFINITY
    return s.retryAt ?? s.triedAt + this.naturalMs(r.bucket, r.chain) * this.stretch()
  }

  private due(r: Read, now: number): boolean {
    if (this.slots.get(slotKey(r.chain, r.bucket))?.reading) return false
    // A little slack, so a timer that fires a little early still counts.
    return this.dueAt(r) <= now + 250
  }

  /** Until the next list is due, at least a second. */
  nextMs(): number {
    const now = this.deps.now()
    const soonest = Math.min(...this.reads().map((r) => this.dueAt(r) - now))
    return Number.isFinite(soonest) ? Math.max(1_000, Math.ceil(soonest)) : FEED_MS
  }

  private slot(chain: ChainSlug, bucket: Bucket): Slot {
    let s = this.slots.get(slotKey(chain, bucket))
    if (!s) {
      s = { list: { bucket, at: null, rows: [] }, reading: false }
      this.slots.set(slotKey(chain, bucket), s)
    }
    return s
  }

  private async read(r: Read): Promise<void> {
    const { bucket, chain } = r
    const s = this.slot(chain, bucket)
    s.reading = true
    const at = this.deps.now()
    let outcome: ToolOutcome
    try {
      outcome = await this.deps.call("candle_get_feed", { bucket, chain, fields: FEED_FIELDS[bucket], limit: FEED_LIMIT })
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
      const rows = feedRows(outcome.result, chain)
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
