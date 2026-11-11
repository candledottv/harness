// The token pane's data, sent on the `market` topic. The pane follows the last token
// a Candle tool showed the agent (or a card was proposed on): its market read (developers/
// docs.candle.tv/developers/market-state; `priceUsd`, `marketCap` and `liquidityUsd` are in the real answer though the page
// doesn't list them), and its token check (candle_token_forensics: `forensics.safety.summary`
// is flagged, clear, incomplete or not_applicable, and each flag has a status; developers/
// docs.candle.tv/developers/agent-trading, "Token forensics"; recorded from Candle's real server). Before any token, it shows
// Candle's on-fire list, which the core's feeds read (feeds.ts) and this view carries.
//
// The followed token is the link: it moves when the agent shows a token,
// as above, or the person picks one in a pane (`view.link`), and every view follows it. A token pane can
// be pinned on its token while the link moves on; the core watches up to three pinned tokens beside the
// linked one, each read as it is. Which panes are pinned is the core's view state (view-state.ts).
//
// The chart plots this core's own samples of the market price, one every 5 s while a view is attached
// (Candle caches the market read about 5 s, so faster gains nothing), over the last hour.
// Candle's MCP tools carry no price history, so when the pane follows a token the core also reads its
// last hour at 1m from Hacc, once, and the samples go on top: the
// chart and the 1h change show at once rather than after an hour. A history read Hacc refuses leaves
// the samples alone, and the pane says so. A rate-limited market read backs off, doubling up to a
// minute, and the pane shows the last read's age.
//
// Each read says what it's for, so the key's request budget (key-budget.ts) can pace it:
// the linked token's samples and the pins', each stretched when the key's limit can't fit them all, and the
// first reads of a token someone just asked for, which never wait.
import { terminalText } from "../shared/terminal-text"
import { baseAssetForMint, followable } from "./assets"
import type { ToolOutcome } from "./candle-mcp"
import type { ReadKind } from "./key-budget"
import { type ChainSlug, maybeChain } from "../shared/chains"
import { haccCheckWords, haccSafety } from "./hacc-safety"

export const SAMPLE_MS = 5_000
const MAX_BACKOFF_MS = 60_000
/** How long samples are kept: the chart's span, plus room for the 1h change's reference. */
export const SAMPLE_SPAN_MS = 65 * 60_000
const HOUR_MS = 60 * 60_000
/** How far from exactly an hour ago the 1h change's reference sample may be. */
const HOUR_SLACK_MS = 2 * 60_000
/** SOL and USDC: named in passing in nearly every reply, rarely what it's about. */
const inPassing = (mint: string) => ["SOL", "USDC"].includes(baseAssetForMint(mint) ?? "")

/** A token's history is read at most once a minute, whatever the pane follows meanwhile. */
export const HISTORY_REUSE_MS = 60_000
const MINUTE_MS = 60_000

/** Hacc's route and query for a token's 1m history from `from`, with its candles (they come only with include_candles). */
export function historyRequest(chain: ChainSlug, mint: string, from: string): { route: string; query: Record<string, string | boolean> } {
  return { route: `/v1/market/token/${encodeURIComponent(mint)}/history`, query: { resolution: "1m", from, include_candles: true, ...(chain === "hood" ? { chain } : {}) } }
}

export interface TrendingRow {
  mint: string
  symbol?: string
  name?: string
  marketCap: number | null
  priceUsd?: number | null
  change1h?: number | null
  /** Where it was launched, short (feeds.ts's whereOf). */
  where?: string
}

/** Hacc's answer to a history read, or its refusal in words (the core's client says them). */
export type HistoryAnswer = { kind: "ok"; body: unknown } | { kind: "refused"; words: string }

export interface TokenView {
  /** The linked token: the one the agent last showed, or the person picked. `by` says which; an older core sends none. */
  followed: { mint: string; chain: ChainSlug; symbol?: string; since: number; by?: "you" | "agent" } | null
  market: { name?: string; symbol?: string; priceUsd: number | null; marketCap: number | null; liquidityUsd: number | null; at: number } | null
  check: { summary: string; flagged: string[]; unknown: string[]; at: number; note?: string } | null
  /**
   * Hacc's own safety check, for a token on an EVM chain (Candle's forensics doesn't read Hacc there), in words as Hacc's;
   * `amber` where a field warrants a look. Absent on Solana, and from an older core.
   */
  hacc?: { words: string; amber: boolean; at: number } | null
  /** The core's own price samples, every 5 s while a view is attached. */
  samples: { at: number; usd: number }[]
  /** Hacc's 1m history before the first sample: the first candle's open, then each close at its minute's end. */
  history: { at: number; usd: number }[]
  /** How the history read went: null while it's read (or nothing is followed). */
  historyRead: { source: "hacc"; at: number } | { source: "samples"; at: number; words: string } | null
  /** Hacc's 1m candles whole, for the token pane's candles; an older core sends none. */
  candles?: Candle[]
  change1h: number | null
  /** Candle's on-fire list: the token pane's and Positions' empty state, read by the core's feeds. `change1h` is a fraction, as the pane's own. */
  trending: { bucket: string; at: number; rows: TrendingRow[] } | null
  /** The tokens token panes are pinned on, each read as the linked one is; an older core sends none. */
  pinned?: PinnedToken[]
}

/** One of Hacc's 1m candles: its minute's start (epoch ms) and its prices. */
export interface Candle {
  at: number
  open: number
  high: number
  low: number
  close: number
}

/** A pinned token's data: what the linked one's is, beside it. */
export interface PinnedToken {
  mint: string
  chain: ChainSlug
  symbol?: string
  since: number
  market: TokenView["market"]
  check: TokenView["check"]
  samples: TokenView["samples"]
  history: TokenView["history"]
  historyRead: TokenView["historyRead"]
  candles?: Candle[]
  change1h: number | null
}

/** The token pane's view of a pinned token: the same shape as the linked one's, so it draws the same. */
export function pinnedView(view: TokenView, mint: string): TokenView | undefined {
  const p = view.pinned?.find((t) => t.mint === mint)
  if (!p) return undefined
  return { ...view, followed: { mint: p.mint, chain: p.chain, ...(p.symbol ? { symbol: p.symbol } : {}), since: p.since }, market: p.market, check: p.check, samples: p.samples, history: p.history, historyRead: p.historyRead, candles: p.candles ?? [], change1h: p.change1h }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 ? terminalText(value, { maxLength: max }) : undefined)

/**
 * Hacc's 1m candles (`{candles: [{at, open, close, …}]}`, as Hacc answers) as chart points: the first
 * candle's open at its start, then each close at its minute's end, no later than `readAt`. Anything that
 * doesn't read as a time and a positive price is left out.
 */
export function historyPoints(body: unknown, readAt: number): TokenView["history"] {
  const rows = record(body)?.candles
  if (!Array.isArray(rows)) return []
  const candles = rows
    .map((row) => {
      const c = record(row)
      const at = typeof c?.at === "string" ? Date.parse(c.at) : Number.NaN
      const close = num(c?.close)
      return Number.isFinite(at) && close !== null && close > 0 && at <= readAt ? { at, open: num(c?.open), close } : undefined
    })
    .filter((c) => c !== undefined)
    .sort((a, b) => a.at - b.at)
  const first = candles[0]
  if (!first) return []
  return [...(first.open !== null && first.open > 0 ? [{ at: first.at, usd: first.open }] : []), ...candles.map((c) => ({ at: Math.min(c.at + MINUTE_MS, readAt), usd: c.close }))]
}

/** Hacc's 1m candles whole, for the pane's candles: a missing open, high or low takes the close, so a candle always draws. */
export function historyCandles(body: unknown, readAt: number): Candle[] {
  const rows = record(body)?.candles
  if (!Array.isArray(rows)) return []
  return rows
    .flatMap((row) => {
      const c = record(row)
      const at = typeof c?.at === "string" ? Date.parse(c.at) : Number.NaN
      const close = num(c?.close)
      if (!Number.isFinite(at) || close === null || close <= 0 || at > readAt) return []
      const price = (v: unknown) => (num(v) ?? 0) > 0 ? num(v)! : close
      const open = price(c?.open)
      return [{ at, open, high: Math.max(price(c?.high), open, close), low: Math.min(price(c?.low), open, close), close }]
    })
    .sort((a, b) => a.at - b.at)
}

type Chain = ChainSlug

/** One token the core watches: the linked one, or one a token pane is pinned on. */
interface Slot {
  mint: string
  chain: Chain
  symbol?: string
  since: number
  /** Whether its first reads (market, check, history) have run: a pin kept across a restart reads them on the first sample. */
  loaded: boolean
  market: TokenView["market"]
  check: TokenView["check"]
  samples: TokenView["samples"]
  history: TokenView["history"]
  historyRead: TokenView["historyRead"]
  candles?: Candle[]
  /** When its market was last sampled (or tried), for its pace. */
  sampledAt?: number
  /** Hacc's check, on an EVM chain. */
  hacc?: NonNullable<TokenView["hacc"]>
}

/** What a read is for: a planned background read of the key's budget, or one someone just asked for. */
export type WatchRead = Extract<ReadKind, "linked" | "pins"> | "asked"

const slotKey = (chain: Chain, mint: string) => `${chain}:${mint}`

/** Why a token isn't followed: a base asset, no market on Candle, or another asked for after it (a run of picks). */
export type FollowOutcome = "ok" | "base" | "no-market" | "superseded"

/** How long Hacc's check of a token is kept before it's read again. */
export const HACC_CHECK_MS = 60_000

export class TokenWatch {
  /** Every token watched, by chain and mint: the linked one and the pinned ones, each read once however many want it. */
  private readonly slots = new Map<string, Slot>()
  private linked: string | null = null
  /** Who moved the link there: the person's pick, or the agent showing it. */
  private by: "you" | "agent" = "agent"
  private pinned: string[] = []
  /** Each follow asked for, counted: an answer for one asked before the latest is dropped (a burst of keys answers out of order). */
  private asked = 0
  /** Each token's last history read, by chain and mint, reused for a minute. */
  private readonly historyReads = new Map<string, { at: number; points: TokenView["history"]; candles: Candle[]; words?: string }>()
  /** Each watched token's last check as Candle answered it, whole: Research's Check pane draws it. */
  private readonly checks = new Map<string, { at: number; outcome: ToolOutcome }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private intervalMs: number | undefined

  constructor(
    private readonly deps: {
      call: (tool: string, args: Record<string, unknown>, read: WatchRead) => Promise<ToolOutcome>
      /** Hacc's 1m history of a token from `from` (an ISO date), with its candles. Absent, there's none. */
      history?: (chain: ChainSlug, mint: string, from: string) => Promise<HistoryAnswer>
      now: () => number
      publish: (view: TokenView) => void
      sampleMs?: number
      /** How many times its own interval each kind waits, from the key's budget; 1 when it fits. */
      stretch?: (kind: Exclude<WatchRead, "asked">) => number
      /** Candle's on-fire list, from the core's feeds (feeds.ts); absent, none. */
      trending?: () => TokenView["trending"]
      /** Hacc's market read of an EVM token, for its safety fields; absent, no Hacc check is read. */
      haccMarket?: (chain: ChainSlug, address: string) => Promise<HistoryAnswer>
    },
  ) {}

  /** Reads a minute at each kind's own pace, for the key's budget; none while no view is attached. */
  demand(): { linked: number; pins: number; pinCount: number } {
    if (!this.running) return { linked: 0, pins: 0, pinCount: 0 }
    const perToken = 60_000 / this.sampleMs()
    const pinCount = this.pinned.filter((key) => key !== this.linked).length
    return { linked: this.linked ? perToken : 0, pins: pinCount * perToken, pinCount }
  }

  view(): TokenView {
    const s = this.linked ? this.slots.get(this.linked) : undefined
    return {
      followed: s ? { mint: s.mint, chain: s.chain, ...(s.symbol ? { symbol: s.symbol } : {}), since: s.since, by: this.by } : null,
      market: s?.market ?? null,
      check: s?.check ?? null,
      ...(s && maybeChain(s.chain)?.family === "evm" ? { hacc: s.hacc ?? null } : {}),
      samples: [...(s?.samples ?? [])],
      history: [...(s?.history ?? [])],
      historyRead: s?.historyRead ?? null,
      candles: [...(s?.candles ?? [])],
      change1h: s ? this.change1h(s) : null,
      trending: this.deps.trending?.() ?? null,
      pinned: this.pinned.flatMap((key) => {
        const p = this.slots.get(key)
        if (!p) return []
        return [
          {
            mint: p.mint,
            chain: p.chain,
            ...(p.symbol ? { symbol: p.symbol } : {}),
            since: p.since,
            market: p.market,
            check: p.check,
            samples: [...p.samples],
            history: [...p.history],
            historyRead: p.historyRead,
            candles: [...(p.candles ?? [])],
            change1h: this.change1h(p),
          },
        ]
      }),
    }
  }

  /** Follows `mint` if Candle has a market for it; true when the pane now shows it. */
  async follow(mint: string, chain: Chain = "solana", by: "you" | "agent" = "agent"): Promise<boolean> {
    return (await this.link(mint, chain, by)) === "ok"
  }

  /**
   * Moves the link to `mint` if Candle has a market for it. The latest asked for wins: a pick or a tool
   * call answered after a later one is dropped, so a run of arrows ends on the last row.
   */
  async link(mint: string, chain: Chain = "solana", by: "you" | "agent" = "agent"): Promise<FollowOutcome> {
    if (!followable(mint)) return "base"
    const key = slotKey(chain, mint)
    const asked = ++this.asked
    if (this.linked === key) {
      // The agent showing the token the person picked leaves it the person's pick.
      if (by === "you" && this.by !== "you") {
        this.by = "you"
        this.publish()
      }
      return "ok"
    }
    let slot = this.slots.get(key)
    const fresh = slot === undefined
    if (!slot) {
      const market = await this.readMarket(chain, mint, "asked")
      if (!market) return "no-market"
      if (asked !== this.asked) return "superseded"
      const at = this.deps.now()
      slot = { mint, chain, ...(market.symbol ? { symbol: market.symbol } : {}), since: at, loaded: true, market, check: null, samples: market.priceUsd === null ? [] : [{ at, usd: market.priceUsd }], history: [], historyRead: null }
      this.slots.set(key, slot)
    }
    this.linked = key
    this.by = by
    this.dropUnused()
    if (!fresh) {
      this.publish()
      return "ok"
    }
    slot.check = await this.readCheck(chain, mint, "asked")
    if (this.linked === key) this.publish()
    await this.readHacc(slot)
    await this.readHistory(slot)
    return "ok"
  }

  /** Hacc's safety check of an EVM token, kept a minute; a refusal (Free has no Hacc) is said in its words. */
  private async readHacc(slot: Slot): Promise<void> {
    if (!this.deps.haccMarket || maybeChain(slot.chain)?.family !== "evm") return
    if (slot.hacc && this.deps.now() - slot.hacc.at < HACC_CHECK_MS) return
    const at = this.deps.now()
    const answer = await this.deps.haccMarket(slot.chain, slot.mint).catch(() => ({ kind: "refused" as const, words: "Hacc didn't answer" }))
    if (answer.kind === "refused") {
      slot.hacc = { words: `Hacc's check didn't load (${terminalText(answer.words, { maxLength: 120 })}): not checked, not clean`, amber: false, at }
    } else {
      const check = haccSafety(answer.body, at)
      slot.hacc = check ? { words: terminalText(haccCheckWords(check), { maxLength: 400 }), amber: check.amber.length > 0, at } : { words: "Hacc's answer had no safety check: not checked, not clean", amber: false, at }
    }
    if (this.slots.get(slotKey(slot.chain, slot.mint)) === slot) this.publish()
  }

  /** The tokens the token panes are pinned on: each watched beside the linked one, at the same 5 s. */
  setPinned(pins: readonly { mint: string; chain: Chain; symbol?: string }[]): void {
    this.pinned = []
    for (const p of pins) {
      if (!followable(p.mint)) continue
      const key = slotKey(p.chain, p.mint)
      if (!this.slots.has(key)) {
        // Not watched yet (a pin kept across a restart): its first sample reads it in full.
        this.slots.set(key, { mint: p.mint, chain: p.chain, ...(p.symbol ? { symbol: p.symbol } : {}), since: this.deps.now(), loaded: false, market: null, check: null, samples: [], history: [], historyRead: null })
      }
      if (!this.pinned.includes(key)) this.pinned.push(key)
    }
    this.dropUnused()
    this.publish()
  }

  /** A slot neither linked nor pinned is let go. */
  private dropUnused(): void {
    for (const key of this.slots.keys()) if (key !== this.linked && !this.pinned.includes(key)) this.slots.delete(key)
    for (const key of this.checks.keys()) if (!this.slots.has(key)) this.checks.delete(key)
  }

  /** The linked token's last check as Candle answered it, and when. */
  checkRead(): { at: number; outcome: ToolOutcome } | null {
    return this.linked ? (this.checks.get(this.linked) ?? null) : null
  }

  /** Reads the linked token's check again, as part of its own reads in the key's budget, and shows it. */
  async recheck(): Promise<void> {
    const key = this.linked
    const slot = key ? this.slots.get(key) : undefined
    if (!key || !slot?.loaded) return
    const check = await this.readCheck(slot.chain, slot.mint, "linked")
    // A read that waited for room in the key's budget keeps the check it had.
    if (this.slots.get(key) !== slot || check?.note === "BUDGET_WAIT") return
    slot.check = check
    this.publish()
    await this.readHacc(slot)
  }

  /** A token's last hour from Hacc, once; a minute-old read of the same token is reused. */
  private async readHistory(slot: Slot): Promise<void> {
    if (!this.deps.history) return
    const { chain, mint } = slot
    const key = slotKey(chain, mint)
    let read = this.historyReads.get(key)
    if (!read || this.deps.now() - read.at >= HISTORY_REUSE_MS) {
      const at = this.deps.now()
      // From a whole minute, so the read is the same for the whole minute; a few minutes past the hour,
      // so the 1h change has a price to start from.
      const from = new Date(Math.floor((at - SAMPLE_SPAN_MS) / MINUTE_MS) * MINUTE_MS).toISOString()
      const answer = await this.deps.history(chain, mint, from).catch((e): HistoryAnswer => ({ kind: "refused", words: e instanceof Error ? e.message : String(e) }))
      const points = answer.kind === "ok" ? historyPoints(answer.body, this.deps.now()) : []
      const candles = answer.kind === "ok" ? historyCandles(answer.body, this.deps.now()) : []
      const words = answer.kind === "refused" ? terminalText(answer.words, { maxLength: 200 }) : points.length === 0 ? "Hacc has no trades for it in the last hour." : undefined
      read = { at, points, candles, ...(words ? { words } : {}) }
      for (const [k, r] of this.historyReads) if (this.deps.now() - r.at >= HISTORY_REUSE_MS) this.historyReads.delete(k)
      this.historyReads.set(key, read)
    }
    // A slot let go meanwhile (the link moved on) keeps nothing: the late answer is dropped.
    if (this.slots.get(key) !== slot) return
    const first = slot.samples[0]?.at ?? Number.POSITIVE_INFINITY
    slot.history = read.points.filter((p) => p.at < first)
    slot.candles = read.candles
    slot.historyRead = read.words === undefined ? { source: "hacc", at: read.at } : { source: "samples", at: read.at, words: read.words }
    this.prune(slot)
    this.publish()
  }

  /**
   * After a reply: the one token it names that a Candle or Hacc read showed, if it names only one besides
   * SOL and USDC. A reply comparing several leaves the pane on the last token a tool read (following a
   * reply's names, it followed a copy the agent only mentioned in passing). An address only the web showed
   * isn't followed until a read shows it too.
   */
  async followReply(labelled: readonly { address: string; source: string }[]): Promise<void> {
    const named = [...new Set(labelled.filter((l) => (l.source === "candle" || l.source === "hacc") && !inPassing(l.address)).map((l) => l.address))]
    if (named.length === 1) await this.follow(named[0]!)
  }

  /**
   * One step: a market sample for each token watched (the linked one and the pins). A pin kept across a
   * restart gets its first reads in full. The on-fire list is the core's feeds' (feeds.ts).
   */
  async sample(): Promise<void> {
    if (this.slots.size === 0) return
    for (const [key, slot] of [...this.slots]) {
      const read = key === this.linked ? "linked" : "pins"
      if (!this.due(slot, read)) continue
      slot.sampledAt = this.deps.now()
      if (!slot.loaded) {
        await this.load(slot)
        continue
      }
      const market = await this.readMarket(slot.chain, slot.mint, read)
      if (this.slots.get(key) !== slot) continue // let go meanwhile
      if (market) {
        slot.market = market
        if (market.priceUsd !== null) slot.samples.push({ at: market.at, usd: market.priceUsd })
      }
      this.prune(slot)
    }
    this.publish()
  }

  /** A pinned token's first reads: its market, its check and its history, as a link's are. */
  private async load(slot: Slot): Promise<void> {
    const market = await this.readMarket(slot.chain, slot.mint, "pins")
    if (!market) return // tried again at the next sample
    slot.loaded = true
    slot.market = market
    if (market.symbol) slot.symbol = market.symbol
    slot.since = market.at
    if (market.priceUsd !== null) slot.samples.push({ at: market.at, usd: market.priceUsd })
    slot.check = await this.readCheck(slot.chain, slot.mint, "pins")
    this.publish()
    await this.readHistory(slot)
  }

  private sampleMs(): number {
    return this.deps.sampleMs ?? SAMPLE_MS
  }

  private stretchOf(kind: Exclude<WatchRead, "asked">): number {
    return Math.max(1, this.deps.stretch?.(kind) ?? 1)
  }

  /** Whether a token's next sample is due: at every sample, or less often when the key's budget stretches its pace. */
  private due(slot: Slot, read: "linked" | "pins"): boolean {
    const stretch = this.stretchOf(read)
    if (stretch <= 1 || slot.sampledAt === undefined) return true
    // A tenth of a sample's slack, so a timer that fires a little early still counts.
    return this.deps.now() - slot.sampledAt >= this.sampleMs() * stretch - this.sampleMs() / 10
  }

  /**
   * Drops what's older than the chart's span. History's last point before it stays while the 1h change
   * still needs it: a minute with no trades has no candle, so an hour ago's price can be an older close.
   */
  private prune(slot: Slot): void {
    const now = this.deps.now()
    const oldest = now - SAMPLE_SPAN_MS
    slot.samples = slot.samples.filter((s) => s.at >= oldest)
    const samplesReachAnHour = slot.samples[0] !== undefined && slot.samples[0].at <= now - HOUR_MS + HOUR_SLACK_MS
    const anchor = samplesReachAnHour ? undefined : slot.history.findLast((p) => p.at < oldest)
    slot.history = slot.history.filter((p) => p.at >= oldest || p === anchor)
    if (slot.candles) slot.candles = slot.candles.filter((c) => c.at >= oldest - MINUTE_MS)
  }

  /** Samples while a view is attached. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.timer)
  }

  private async tick(): Promise<void> {
    await this.sample().catch(() => {})
    if (!this.running) return
    this.timer = setTimeout(() => void this.tick(), this.nextSampleMs())
    this.timer.unref?.()
  }

  /** The next sample's wait: doubled after a rate-limited read, back to normal after a good one. */
  private paced(outcome: ToolOutcome): void {
    const base = this.sampleMs()
    if (outcome.kind === "error" && outcome.code === "RATE_LIMITED") this.intervalMs = Math.min((this.intervalMs ?? base) * 2, MAX_BACKOFF_MS)
    else if (outcome.kind === "ok") this.intervalMs = undefined
  }

  /**
   * How long until the next sample: 5 s, doubled after a rate-limited read; sooner when a slowed token
   * comes due between two, so a stretched pace is kept to the second its pane states.
   */
  nextSampleMs(): number {
    if (this.intervalMs !== undefined) return this.intervalMs
    const base = this.sampleMs()
    const now = this.deps.now()
    const dues = [...this.slots].flatMap(([key, slot]) => {
      const read = key === this.linked ? "linked" : "pins"
      const stretch = this.stretchOf(read)
      return stretch > 1 && slot.sampledAt !== undefined ? [slot.sampledAt + base * stretch] : []
    })
    const soonest = Math.min(...dues.map((d) => d - now))
    return Number.isFinite(soonest) && soonest < base ? Math.max(1_000, Math.ceil(soonest)) : base
  }

  private publish(): void {
    this.deps.publish(this.view())
  }

  /**
   * From the sample nearest an hour ago, or, before the samples reach that far, Hacc's last price at or
   * before it: its candles cover every trade, so a minute with none kept the last close.
   */
  private change1h(slot: Slot): number | null {
    const latest = slot.samples.at(-1) ?? slot.history.at(-1)
    if (!latest) return null
    const target = latest.at - HOUR_MS
    let best: { at: number; usd: number } | undefined
    for (const s of slot.samples) if (!best || Math.abs(s.at - target) < Math.abs(best.at - target)) best = s
    if (!best || Math.abs(best.at - target) > HOUR_SLACK_MS) best = slot.history.findLast((p) => p.at <= target)
    if (!best || best.usd <= 0) return null
    return latest.usd / best.usd - 1
  }

  private async readMarket(chain: string, mint: string, read: WatchRead): Promise<TokenView["market"]> {
    const outcome = await this.deps.call("candle_get_market", { chain, mint }, read)
    this.paced(outcome)
    const market = outcome.kind === "ok" ? record(record(outcome.result)?.market) : undefined
    if (!market || market.mint !== mint) return null
    const meta = record(market.metadata)
    const name = text(meta?.name, 40)
    const symbol = text(meta?.symbol, 16)
    const price = num(market.priceUsd)
    return {
      ...(name ? { name } : {}),
      ...(symbol ? { symbol } : {}),
      priceUsd: price !== null && price > 0 ? price : null,
      marketCap: num(market.marketCap),
      liquidityUsd: num(market.liquidityUsd),
      at: this.deps.now(),
    }
  }

  private async readCheck(chain: string, mint: string, read: WatchRead): Promise<TokenView["check"]> {
    const outcome = await this.deps.call("candle_token_forensics", { chain, mint }, read)
    const at = this.deps.now()
    const key = slotKey(chain as Chain, mint)
    if (this.slots.has(key) && !(outcome.kind === "error" && outcome.code === "BUDGET_WAIT")) this.checks.set(key, { at, outcome })
    if (outcome.kind !== "ok") return { summary: "unavailable", flagged: [], unknown: [], at, note: outcome.kind === "error" ? outcome.code : "no answer" }
    // The real answer is `{ success, forensics: { …, safety } }` (recorded from Candle's real server: the
    // pane had guessed the top, `data` and `api`, and said "didn't load" for a flagged token).
    const safety = record(record(record(outcome.result)?.forensics)?.safety)
    const summary = typeof safety?.summary === "string" ? terminalText(safety.summary, { maxLength: 20 }) : "unavailable"
    const flags = Object.entries(record(safety?.flags) ?? {})
    const named = (status: string) => flags.filter(([, f]) => record(f)?.status === status).map(([name]) => terminalText(name, { maxLength: 24 }))
    return { summary, flagged: named("flagged"), unknown: named("unknown"), at }
  }
}
