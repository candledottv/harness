// Hacc's signal tape, live: one WebSocket per core to `/v1/signals/stream`, fanned out
// to every view and agent through the `signals` topic. Hacc caps open sockets (8, counted per key),
// and the web app and other apps count, so the core never opens one per view or agent. It's opened when
// something needs it (a subscriber to `signals`, or an agent reading the tape) and closed 5 minutes after
// the last need.
//
// What Hacc's live answers showed:
// - frames are `{type:"snapshot", signals:[newest 100, newest first]}`, then `{type:"signal", signal}`,
//   and `{type:"ping"}` every 20 s;
// - `after` and `since` on the REST tape are dates, not ids, so a gap is filled by the last `created_at`
//   heard, ascending, deduplicated by id (Candle's `candle-market-data-ingestion` skill: a stream plus a
//   reconciliation read, gaps recorded as gaps);
// - a refused upgrade is hidden by the WebSocket, so the core asks once over plain HTTP why, as the
//   recorder did: `429 too many subscribers for this key` is the cap, `401` a key Hacc won't take.
//
// A filtered subscription gets the cache's rows that match at once. The cache is the
// newest 500 of every pattern, so a rare pattern could look empty when Hacc has some: each filter is also
// read back from Hacc's REST tape (`pattern`, `chain`), once per filter change and at most once a minute
// (refusals included), and what it finds goes to the subscriptions with that filter alone,
// merged by id. The whole tape's subscribers never get those older rows, so it never looks gapless.
//
// Personal signals (`signals:mine`, Pro and Max) aren't pushed: Hacc's docs say to poll `/v1/me/signals`
// with its `next_after` cursor, every 30 s while anyone is subscribed.
//
// Signal rows are third-party text (wallet labels, summaries): every string is cleaned for the terminal
// as it arrives, so views and tools read the same safe rows.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { terminalText } from "../shared/terminal-text"
import { type HaccClient, haccCursor } from "./hacc"
import type { TopicFilter } from "./events"
import { utf8Bytes } from "./usage"

export type SignalRow = Record<string, unknown> & { id: number; created_at: string }
/** A stretch of the tape that couldn't be read back, kept in place among the rows. */
export interface GapRow {
  kind: "gap"
  id: string
  created_at: string
  from: string
  to: string
  words: string
}
export type StreamRow = SignalRow | GapRow
export const isGap = (row: StreamRow): row is GapRow => (row as GapRow).kind === "gap"

export type StreamState = "off" | "closed" | "opening" | "filling" | "open" | "reconnecting" | "full" | "no-key"
export type MineState = "closed" | "polling" | "needs-plan" | "failing" | "no-key"

export interface Cursor {
  at: string
  id: number
}

export interface Timing {
  /** Waits before each reopen after a drop; the last repeats. */
  backoffMs: number[]
  idleCloseMs: number
  /** How long a full stream (Hacc's cap) or no usable key waits before trying again. */
  holdMs: number
  /** No frame (pings come every 20 s) this long means the socket is dead. */
  silenceMs: number
  minePollMs: number
  /** How long `signals:mine` waits after Hacc says the plan doesn't reach it. */
  minePlanHoldMs: number
  checkMs: number
  saveMs: number
  /** Pages of 200 the gap fill reads before it gives up and records the rest as a gap. */
  maxFillPages: number
}
export const TIMING: Timing = {
  backoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
  idleCloseMs: 5 * 60_000,
  holdMs: 30_000,
  silenceMs: 60_000,
  minePollMs: 30_000,
  minePlanHoldMs: 5 * 60_000,
  checkMs: 5_000,
  saveMs: 2_000,
  maxFillPages: 5,
}

/**
 * A core started within this long of the last one's cursor carries on from it: a reopen reads the gap back
 * from the tape (a trigger watching the tape then sees what came in while the core was down), and personal
 * signals carry on from Hacc's cursor. Older than this, the stream starts from now, as a new core's would.
 */
export const REFILL_WITHIN_MS = 60 * 60_000

export const CACHE_ROWS = 500
/** A filter's read-back, at most once in this long (one a minute for each view, refusals included). */
export const READBACK_MS = 60_000
/** Read-backs kept, so a filter picked again within the minute shows what it found without a read. */
const READBACKS_KEPT = 8
export const MINE_ROWS = 200
/** Rows a new subscriber's snapshot carries; the cache keeps more for the agent's tools. */
export const SNAPSHOT_ROWS = 100
const PAGE = 200
const TEXT_MAX = 500

export const FULL_WORDS = (hacc: string) =>
  `Hacc's stream is full (Hacc: "${hacc}"): it allows 8 open at once, and the web app and other apps count. The core tries again every 30 s; Hacc's reads still answer.`

export interface SignalFilter {
  pattern?: string[]
  chain?: string[]
}

/** `{pattern?, chain?}`, each a name or a list of names. */
export function parseSignalFilter(raw: unknown): SignalFilter | { problem: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problem: "The signals filter is {pattern?, chain?}." }
  const out: SignalFilter = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== "pattern" && k !== "chain") return { problem: `The signals filter takes pattern and chain, not ${terminalText(k).slice(0, 40)}.` }
    const list = typeof v === "string" ? [v] : v
    if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === "string" && /^[a-z0-9_]{1,40}$/.test(x)))
      return { problem: `The signals filter's ${k} is a name or a list of names.` }
    out[k] = list as string[]
  }
  return out
}

/** One key per filter, whatever order its names came in: what a read-back is kept and sent by. */
export const filterKey = (f: SignalFilter): string => JSON.stringify({ pattern: [...(f.pattern ?? [])].sort(), chain: [...(f.chain ?? [])].sort() })

/** What a filter's read-back from Hacc found, as a view is told it: when, whether it answered, and how many rows. */
export interface ReadBackView {
  at: string
  ok: boolean
  rows: number
  words?: string
}

/** What a `signals` event or snapshot carries: rows, and for a filter, its read-back and how far back the core's own rows reach. */
export interface SignalsData {
  rows: StreamRow[]
  /** A read-back's rows, for the subscriptions with this filter key alone. */
  for?: string
  back?: ReadBackView
  /** The oldest signal the core holds from the stream: the span a filter that matches nothing was checked over. */
  since?: string
}

export function matchesFilter(row: StreamRow, filter: SignalFilter | undefined): boolean {
  if (!filter || isGap(row)) return true
  if (filter.pattern && !filter.pattern.includes(String(row.pattern))) return false
  if (filter.chain && !filter.chain.includes(String(row.asset_chain ?? row.wallet_chain))) return false
  return true
}

export const signalsTopicFilter: TopicFilter<SignalFilter> = {
  parse: parseSignalFilter,
  apply(data, filter) {
    const d = data as SignalsData | null
    if (!Array.isArray(d?.rows)) return data
    if (d.for !== undefined && d.for !== filterKey(filter)) return undefined
    const kept = d.rows.filter((r) => matchesFilter(r, filter))
    // A read-back that found nothing still says so: the pane's "no … since" waits on it.
    return kept.length || d.back ? { ...d, rows: kept } : undefined
  },
  // A read-back's older rows aren't the whole tape's.
  unfiltered: (data) => ((data as SignalsData | null)?.for !== undefined ? undefined : data),
}

/** Every string cleaned for the terminal and cut to a sane length; a row needs a numeric id and a date. */
export function cleanRow(raw: unknown): SignalRow | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== "number" || typeof row.created_at !== "string" || Number.isNaN(Date.parse(row.created_at))) return undefined
  return clean(row) as SignalRow
}
function clean(v: unknown): unknown {
  if (typeof v === "string") return terminalText(v, { maxLength: TEXT_MAX })
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [terminalText(k, { maxLength: 80 }), clean(x)]))
  return v
}

const byTime = (a: StreamRow, b: StreamRow) => Date.parse(a.created_at) - Date.parse(b.created_at) || (isGap(a) || isGap(b) ? 0 : a.id - b.id)

/** Personal signals' cursor (Hacc's `next_after`, a whole number as text) from the same file, and when it was kept. */
export function readMineCursor(path: string): { after: string; savedAt?: string } | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as { mineAfter?: unknown; savedAt?: unknown }
    if (typeof c.mineAfter === "string" && /^[\w-]{1,64}$/.test(c.mineAfter)) return { after: c.mineAfter, ...(typeof c.savedAt === "string" ? { savedAt: c.savedAt } : {}) }
  } catch {}
  return undefined
}

export function readCursor(path: string): (Cursor & { savedAt?: string }) | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown; id?: unknown; savedAt?: unknown }
    if (typeof c.at === "string" && !Number.isNaN(Date.parse(c.at)) && typeof c.id === "number") return { at: c.at, id: c.id, ...(typeof c.savedAt === "string" ? { savedAt: c.savedAt } : {}) }
  } catch {}
  return undefined
}

/** The minimal WebSocket the stream uses: Bun's, which takes headers, so the key never goes in the URL. */
export interface SocketLike {
  readyState: number
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number; reason: string }) => void) | null
  onerror: ((e: unknown) => void) | null
  close(code?: number, reason?: string): void
}

export interface SignalStreamDeps {
  hacc: HaccClient
  /** Configured agents and their keys, in config order: the first with a live key Hacc takes holds the socket. */
  agents(): { agent: string; key: string }[]
  enabled(): boolean
  /** Hacc's host (`https://api.hacc.fun`, or the fake's in tests). */
  host: string
  cursorPath: string
  /** Whether anything subscribes to `signals` and `signals:mine`. */
  wanted(): { signals: boolean; mine: boolean }
  /** The filters `signals`' subscriptions hold now: each is read back from Hacc's tape. */
  filters?(): SignalFilter[]
  publish(topic: "signals" | "signals:mine", data: SignalsData): void
  /** The stream's state changed: the core publishes the `hacc` topic. */
  onState(): void
  /** A journal line (no rows, no keys). */
  record?(entry: Record<string, unknown>): void
  /** Each frame's size, for the core's usage totals. */
  onFrame?(bytes: number): void
  now(): number
  timing?: Partial<Timing>
  /** Tests only: open the socket another way. */
  openSocket?(url: string, key: string): SocketLike
  /** Tests only: ask why an upgrade was refused another way. */
  probe?(url: string, key: string): Promise<{ status?: number; words: string }>
  /**
   * "all": Hacc's full tape, on the socket and every read back, where it's left out the curated one. Hacc's
   * strategy replays run on the full tape, so a rules bot reads it (measured: about twice the new tickers).
   */
  quality?: "all"
}

export class SignalStream {
  private readonly t: Timing
  private readonly rows: StreamRow[] = []
  private readonly ids = new Set<number>()
  private readonly mine: SignalRow[] = []
  private readonly mineIds = new Set<number>()
  private mineCursor: string | undefined
  private mineState: MineState = "closed"
  private mineWords: string | undefined
  private mineTimer: ReturnType<typeof setTimeout> | undefined
  private minePolling = false

  private state: StreamState = "closed"
  private words: string | undefined
  private agent: string | undefined
  private ws: SocketLike | undefined
  /** Each reopen's fill; an older fill that returns late is dropped. */
  private fillGen = 0
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private checkTimer: ReturnType<typeof setInterval> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private lastFrameAt = 0
  private lastNeedAt = 0
  private openedAt: number | undefined
  /** The newest signal heard by this core: a reopen fills the tape from here. */
  private heard: Cursor | undefined
  /** While a reopen's gap is filled, what the socket sends waits here. */
  private held: SignalRow[] | undefined
  private stopped = false
  /** Each filter's read-back, by its key: what Hacc's REST tape had for it, and when it was asked. */
  private readonly backs = new Map<string, { askedAt: number; rows: SignalRow[]; view?: ReadBackView }>()
  /** Where the last core left the tape, read at start, for "while you were away". */
  readonly leftOff: (Cursor & { savedAt?: string }) | undefined

  constructor(private readonly deps: SignalStreamDeps) {
    this.t = { ...TIMING, ...deps.timing }
    this.leftOff = readCursor(deps.cursorPath)
    if (!deps.enabled()) this.state = "off"
    const recent = (savedAt: string | undefined) => savedAt !== undefined && deps.now() - Date.parse(savedAt) <= REFILL_WITHIN_MS
    if (this.leftOff && recent(this.leftOff.savedAt)) this.heard = { at: this.leftOff.at, id: this.leftOff.id }
    const mine = readMineCursor(deps.cursorPath)
    if (mine && recent(mine.savedAt)) this.mineCursor = mine.after
  }

  /** What the `hacc` topic shows of the stream. No rows, no key. */
  view() {
    return {
      state: this.state,
      ...(this.words ? { words: this.words } : {}),
      ...(this.agent && this.state !== "closed" && this.state !== "off" ? { agent: this.agent } : {}),
      ...(this.openedAt !== undefined && this.state === "open" ? { openSince: new Date(this.openedAt).toISOString() } : {}),
      rows: this.rows.filter((r) => !isGap(r)).length,
      cursor: this.cursor() ?? null,
      leftOff: this.leftOff ?? null,
      mine: { state: this.mineState, ...(this.mineWords ? { words: this.mineWords } : {}), rows: this.mine.length },
    }
  }

  /**
   * The `signals` topic's snapshot: the newest rows that match, oldest first. Filtered, with what its
   * read-back found merged in by id, the read-back's state, and how far back the core's own rows reach.
   */
  snapshot(filter?: SignalFilter): { state: StreamState; rows: StreamRow[]; back?: ReadBackView; since?: string } {
    if (!filter || !this.readsBack(filter)) return { state: this.state, rows: this.recent(filter, SNAPSHOT_ROWS) }
    const back = this.backs.get(filterKey(filter))
    const rows = this.recent(filter, CACHE_ROWS) as StreamRow[]
    const seen = new Set(rows.filter((r) => !isGap(r)).map((r) => (r as SignalRow).id))
    const merged = [...rows, ...(back?.rows ?? []).filter((r) => !seen.has(r.id) && matchesFilter(r, filter))].sort(byTime).slice(-SNAPSHOT_ROWS)
    const since = this.oldest()
    return { state: this.state, rows: merged, ...(back?.view ? { back: back.view } : {}), ...(since ? { since } : {}) }
  }

  /** The oldest signal the core holds from the stream. */
  private oldest(): string | undefined {
    return this.rows.find((r) => !isGap(r))?.created_at
  }

  /** A filter Hacc's REST tape can take as it is: one pattern and one chain at most, and at least one of them. */
  private readsBack(f: SignalFilter): boolean {
    return (f.pattern?.length ?? 0) <= 1 && (f.chain?.length ?? 0) <= 1 && (!!f.pattern?.length || !!f.chain?.length)
  }

  /**
   * Each filter the subscriptions hold is read back from Hacc's tape: once per filter change, and at most
   * once a minute for each, refusals included. What it finds goes to that filter's subscriptions alone.
   */
  private readBack(filters: readonly SignalFilter[]): void {
    if (this.stopped || !this.deps.enabled()) return
    const now = this.deps.now()
    for (const filter of filters) {
      if (!this.readsBack(filter)) continue
      const key = filterKey(filter)
      const had = this.backs.get(key)
      if (had && now - had.askedAt < READBACK_MS) continue
      const pick = this.pickAgent()
      if (!pick) continue
      this.backs.delete(key)
      this.backs.set(key, { askedAt: now, rows: had?.rows ?? [] })
      while (this.backs.size > READBACKS_KEPT) this.backs.delete(this.backs.keys().next().value!)
      void this.readBackOne(key, filter, pick.agent)
    }
  }

  private async readBackOne(key: string, filter: SignalFilter, agent: string): Promise<void> {
    const answer = await this.deps.hacc.get(agent, "/v1/signals", { pattern: filter.pattern?.[0], chain: filter.chain?.[0], limit: SNAPSHOT_ROWS, quality: this.deps.quality })
    const held = this.backs.get(key)
    if (this.stopped || !held) return
    const at = new Date(this.deps.now()).toISOString()
    if (answer.kind !== "ok") {
      held.view = { at, ok: false, rows: 0, words: terminalText(answer.message).slice(0, 200) }
    } else {
      const raw = (answer.body as { signals?: unknown } | null)?.signals
      held.rows = (Array.isArray(raw) ? raw : []).map(cleanRow).filter((r): r is SignalRow => r !== undefined && matchesFilter(r, filter)).sort(byTime)
      held.view = { at, ok: true, rows: held.rows.length }
    }
    this.deps.record?.({ type: "hacc.stream", event: "read_back", filter: { ...filter }, ok: held.view.ok, rows: held.view.rows })
    const since = this.oldest()
    this.deps.publish("signals", { rows: held.rows, for: key, back: held.view, ...(since ? { since } : {}) })
  }

  mineSnapshot(): { state: MineState; rows: SignalRow[] } {
    return { state: this.mineState, rows: [...this.mine] }
  }

  /** The newest `limit` cached rows that match, oldest first (gaps included where they fall). */
  recent(filter?: SignalFilter, limit = SNAPSHOT_ROWS): StreamRow[] {
    return this.rows.filter((r) => matchesFilter(r, filter)).slice(-limit)
  }

  cursor(): Cursor | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!
      if (!isGap(r)) return { at: r.created_at, id: r.id }
    }
    return undefined
  }

  /** An agent read the tape: the socket opens if it isn't, and stays 5 minutes past this. */
  touch(): void {
    this.lastNeedAt = this.deps.now()
    this.ensure(true)
  }

  /** Subscriptions or config changed: open what's wanted; what isn't closes by the idle rule. */
  poke(): void {
    const want = this.deps.wanted()
    if (want.signals) this.lastNeedAt = this.deps.now()
    this.ensure(want.signals)
    if (want.signals) this.readBack(this.deps.filters?.() ?? [])
    if (want.mine && this.deps.enabled() && !this.minePolling) this.startMine()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.closeSocket()
    this.clearTimers()
    if (this.mineTimer) clearTimeout(this.mineTimer)
    await this.save()
  }

  // --- the socket ---

  private ensure(wanted: boolean): void {
    if (this.stopped) return
    if (!this.deps.enabled()) {
      this.closeSocket()
      this.clearTimers()
      this.setState("off")
      return
    }
    if (this.state === "off") this.setState("closed")
    if (!wanted || this.ws || this.retryTimer) return
    this.connect()
  }

  private connect(): void {
    this.retryTimer = undefined
    if (this.stopped || this.ws) return
    const pick = this.pickAgent()
    if (!pick) {
      const refused = this.deps.agents().find((a) => this.deps.hacc.keyRefused(a.agent))
      this.setState(
        "no-key",
        refused
          ? `Hacc's stream needs a live key Hacc takes; ${this.deps.hacc.keyRefused(refused.agent)}`
          : "Hacc's stream needs an agent with a live production key (cndl_live_); none is configured.",
      )
      this.startChecks()
      this.retryTimer = setTimeout(() => this.connect(), this.t.holdMs)
      this.retryTimer.unref?.()
      return
    }
    this.agent = pick.agent
    const url = new URL("/v1/signals/stream", this.deps.host)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    if (this.deps.quality) url.searchParams.set("quality", this.deps.quality)
    this.setState(this.heard ? "filling" : "opening", this.heard ? "Reopening Hacc's stream; what came in meanwhile is read back first." : undefined)
    const ws = this.deps.openSocket ? this.deps.openSocket(url.toString(), pick.key) : openBunSocket(url.toString(), pick.key)
    this.ws = ws
    this.startChecks()
    let opened = false
    ws.onopen = () => {
      opened = true
      this.openedAt = this.deps.now()
      this.lastFrameAt = this.deps.now()
      this.deps.record?.({ type: "hacc.stream", event: "opened", agent: pick.agent, refill: this.heard !== undefined })
      if (this.heard) void this.fill(this.heard)
    }
    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      this.lastFrameAt = this.deps.now()
      this.deps.onFrame?.(utf8Bytes(String(e.data)))
      let frame: unknown
      try {
        frame = JSON.parse(String(e.data))
      } catch {
        return
      }
      const f = frame as { type?: unknown; signals?: unknown; signal?: unknown }
      const raw = f.type === "snapshot" && Array.isArray(f.signals) ? f.signals : f.type === "signal" ? [f.signal] : []
      if (f.type === "snapshot") this.attempt = 0
      const rows = raw.map(cleanRow).filter((r): r is SignalRow => r !== undefined)
      if (this.held) this.held.push(...rows)
      else {
        if (this.state !== "open") this.setState("open")
        this.take(rows)
      }
    }
    ws.onerror = () => {}
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.held = undefined
      if (this.stopped) return
      if (opened) this.dropped(`Hacc's stream dropped (${e.code}${e.reason ? ` ${terminalText(e.reason).slice(0, 80)}` : ""}).`)
      else void this.refusedOpen(url.toString(), pick)
    }
  }

  private pickAgent(): { agent: string; key: string } | undefined {
    return this.deps.agents().find((a) => a.key.startsWith("cndl_live_") && !this.deps.hacc.keyRefused(a.agent))
  }

  /** A socket that never opened: ask Hacc why, over plain HTTP, since the WebSocket hides the answer. */
  private async refusedOpen(url: string, pick: { agent: string; key: string }): Promise<void> {
    const why = await (this.deps.probe ?? probeUpgrade)(url, pick.key).catch((e) => ({ status: undefined, words: String(e) }))
    if (this.stopped || this.ws) return
    if (why.status === 429) {
      this.deps.record?.({ type: "hacc.stream", event: "full", agent: pick.agent })
      this.hold("full", FULL_WORDS(why.words))
      return
    }
    if (why.status === 401) {
      const words = this.deps.hacc.noteKeyRefused(pick.agent, why.words)
      this.deps.record?.({ type: "hacc.stream", event: "key_refused", agent: pick.agent })
      this.setState("reconnecting", words)
      this.connect() // the next agent with a live key, or "no-key"
      return
    }
    this.dropped(`Hacc's stream didn't open (${why.status ? `HTTP ${why.status}: ` : ""}${terminalText(why.words).slice(0, 200)}).`)
  }

  private hold(state: StreamState, words: string): void {
    this.setState(state, words)
    this.retryTimer = setTimeout(() => this.connect(), this.t.holdMs)
    this.retryTimer.unref?.()
  }

  private dropped(why: string): void {
    const wait = this.t.backoffMs[Math.min(this.attempt, this.t.backoffMs.length - 1)]!
    this.attempt++
    this.deps.record?.({ type: "hacc.stream", event: "dropped", agent: this.agent, retryInMs: wait })
    this.setState("reconnecting", `${why} Reopening in ${Math.max(1, Math.round(wait / 1000))} s; what came in meanwhile will be read back.`)
    this.retryTimer = setTimeout(() => this.connect(), wait)
    this.retryTimer.unref?.()
  }

  /** The tape since the last signal heard, from Hacc's REST read, before anything newer is trusted. */
  private async fill(from: Cursor): Promise<void> {
    this.held = []
    const gen = ++this.fillGen
    const agent = this.agent!
    const filled: SignalRow[] = []
    let since = from.at
    let gap: { from: string; why: string } | undefined
    for (let page = 0; ; page++) {
      if (page >= this.t.maxFillPages) {
        gap = { from: since, why: `more than ${(this.t.maxFillPages * PAGE).toLocaleString("en-US")} came in while the stream was closed` }
        break
      }
      // From a millisecond before: whether Hacc's `since` takes its own instant isn't documented, so rows
      // sharing the last one's time are read again and dropped by id, never skipped.
      const answer = await this.deps.hacc.get(agent, "/v1/signals", { since: new Date(Date.parse(since) - 1).toISOString(), order: "asc", limit: PAGE, quality: this.deps.quality })
      if (this.stopped || !this.held || gen !== this.fillGen) return
      if (answer.kind !== "ok") {
        gap = { from: since, why: answer.message }
        break
      }
      const raw = (answer.body as { signals?: unknown } | null)?.signals
      const rows = (Array.isArray(raw) ? raw : []).map(cleanRow).filter((r): r is SignalRow => r !== undefined)
      filled.push(...rows)
      if (rows.length < PAGE) break
      since = rows.at(-1)!.created_at
    }
    const held = this.held
    this.held = undefined
    const rows: StreamRow[] = [...filled, ...held]
    if (gap) {
      // Up to the oldest row the socket sent since it reopened; with none, up to now.
      const to = held.length ? held.reduce((a, r) => (Date.parse(r.created_at) < Date.parse(a) ? r.created_at : a), held[0]!.created_at) : new Date(this.deps.now()).toISOString()
      if (Date.parse(to) > Date.parse(gap.from)) {
        const words = `Signals from ${gap.from} to ${to} couldn't be read back: ${terminalText(gap.why).slice(0, 200)}`
        rows.push({ kind: "gap", id: `gap:${gap.from}`, created_at: gap.from, from: gap.from, to, words })
        this.deps.record?.({ type: "hacc.stream", event: "gap", from: gap.from, to })
      }
    }
    this.deps.record?.({ type: "hacc.stream", event: "filled", rows: filled.length })
    this.setState("open")
    this.take(rows)
  }

  /** New rows into the cache, deduplicated by id, oldest first; what's new goes out on `signals`. */
  private take(rows: StreamRow[]): void {
    const oldest = this.rows.length >= CACHE_ROWS ? this.rows[0]!.created_at : undefined
    const fresh: StreamRow[] = []
    for (const row of rows.sort(byTime)) {
      if (!isGap(row)) {
        if (this.ids.has(row.id)) continue
        if (oldest && Date.parse(row.created_at) < Date.parse(oldest)) continue
        this.ids.add(row.id)
      }
      fresh.push(row)
    }
    if (!fresh.length) return
    const ordered = this.rows.length === 0 || byTime(this.rows.at(-1)!, fresh[0]!) <= 0
    this.rows.push(...fresh)
    if (!ordered) this.rows.sort(byTime)
    while (this.rows.length > CACHE_ROWS) {
      const gone = this.rows.shift()!
      if (!isGap(gone)) this.ids.delete(gone.id)
    }
    const newest = this.cursor()
    if (newest && (!this.heard || Date.parse(newest.at) >= Date.parse(this.heard.at))) this.heard = newest
    this.deps.publish("signals", { rows: fresh })
    this.scheduleSave()
  }

  private startChecks(): void {
    this.checkTimer ??= setInterval(() => this.check(), this.t.checkMs)
    this.checkTimer.unref?.()
  }

  private check(): void {
    const now = this.deps.now()
    if (this.deps.wanted().signals) this.lastNeedAt = now
    if (now - this.lastNeedAt >= this.t.idleCloseMs) {
      this.closeSocket()
      this.clearTimers()
      if (this.state !== "off") this.setState("closed")
      this.deps.record?.({ type: "hacc.stream", event: "closed", why: "idle" })
      return
    }
    if (this.ws && this.openedAt !== undefined && this.ws.readyState === 1 && now - this.lastFrameAt >= this.t.silenceMs) {
      // No ping in three periods: the socket is dead even if it hasn't said so.
      const ws = this.ws
      this.ws = undefined
      this.held = undefined
      ws.close(4000, "silent")
      this.dropped(`Hacc's stream went silent for ${Math.round(this.t.silenceMs / 1000)} s.`)
    }
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = undefined
    this.held = undefined
    this.openedAt = undefined
    // Every close on purpose clears `ws` first, so its onclose knows it isn't a drop.
    ws?.close(1000, "not needed")
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.retryTimer = undefined
    this.checkTimer = undefined
  }

  private setState(state: StreamState, words?: string): void {
    if (this.state === state && this.words === words) return
    this.state = state
    this.words = words
    this.deps.onState()
  }

  // --- the cursor, kept for "while you were away" ---

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => void this.save(), this.t.saveMs)
    this.saveTimer.unref?.()
  }

  private async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const cursor = this.cursor() ?? this.heard
    if (!cursor && !this.mineCursor) return
    const path = this.deps.cursorPath
    const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
    try {
      await writeFile(temp, `${JSON.stringify({ ...cursor, ...(this.mineCursor ? { mineAfter: this.mineCursor } : {}), savedAt: new Date(this.deps.now()).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
      await chmod(temp, 0o600)
      await rename(temp, path)
    } catch {}
  }

  // --- personal signals, polled ---

  private startMine(): void {
    this.minePolling = true
    void this.pollMine()
  }

  private async pollMine(): Promise<void> {
    this.mineTimer = undefined
    if (this.stopped || !this.deps.enabled() || !this.deps.wanted().mine) {
      this.minePolling = false
      this.setMine("closed")
      return
    }
    let wait = this.t.minePollMs
    const pick = this.pickAgent()
    if (!pick) this.setMine("no-key", "Personal signals need an agent with a live key Hacc takes.")
    else {
      const answer = await this.deps.hacc.get(pick.agent, "/v1/me/signals", { limit: this.mineCursor ? PAGE : 50, after: this.mineCursor })
      if (this.stopped) return
      if (answer.kind === "ok") {
        const body = answer.body as { signals?: unknown; next_after?: unknown } | null
        const rows = (Array.isArray(body?.signals) ? body.signals : []).map(cleanRow).filter((r): r is SignalRow => r !== undefined)
        const fresh = rows.filter((r) => !this.mineIds.has(r.id)).sort(byTime) as SignalRow[]
        for (const r of fresh) this.mineIds.add(r.id)
        this.mine.push(...fresh)
        while (this.mine.length > MINE_ROWS) this.mineIds.delete(this.mine.shift()!.id)
        // Only Hacc's own cursor, a whole number here: Hacc refuses a date for `after` on this route (seen live),
        // so a row's created_at is never sent. With none yet, the next poll reads Hacc's first page again.
        const next = haccCursor(body?.next_after)
        if (next && next !== this.mineCursor) {
          this.mineCursor = next
          this.scheduleSave()
        }
        this.setMine("polling")
        if (fresh.length) this.deps.publish("signals:mine", { rows: fresh })
      } else if (answer.code === "PLAN_REQUIRED") {
        this.setMine("needs-plan", `Personal signals need Pro or Max (${answer.message})`)
        wait = this.t.minePlanHoldMs
      } else this.setMine("failing", answer.message)
    }
    this.mineTimer = setTimeout(() => void this.pollMine(), wait)
    this.mineTimer.unref?.()
  }

  private setMine(state: MineState, words?: string): void {
    if (this.mineState === state && this.mineWords === words) return
    this.mineState = state
    this.mineWords = words
    this.deps.onState()
  }
}

function openBunSocket(url: string, key: string): SocketLike {
  // Bun's WebSocket takes headers (as the recorder used it), so the key goes in the header, never the URL.
  return new WebSocket(url, { headers: { authorization: `Bearer ${key}` } } as unknown as string[]) as unknown as SocketLike
}

/** Hacc's answer to an upgrade, as HTTP: what the WebSocket hid. */
export async function probeUpgrade(wsUrl: string, key: string): Promise<{ status?: number; words: string }> {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http")
  return new Promise((done) => {
    const req = mod.request(url, {
      headers: {
        authorization: `Bearer ${key}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
      timeout: 5_000,
    })
    req.on("upgrade", (res, socket) => {
      socket.destroy()
      done({ status: res.statusCode, words: "the upgrade answered when asked again" })
    })
    req.on("response", (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => {
        let words = body.trim().slice(0, 300)
        try {
          const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
          words = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : words
        } catch {}
        done({ status: res.statusCode, words: terminalText(words.replaceAll(key, "[redacted]")) || `HTTP ${res.statusCode}` })
      })
    })
    req.on("timeout", () => req.destroy(new Error("no answer in 5 s")))
    req.on("error", (e) => done({ words: `Hacc couldn't be reached: ${e.message}` }))
    req.end()
  })
}
