// Triggers' watchers: what each live trigger waits for, checked in the core whether or not a view is open,
// and handed to the trigger book as a firing when it comes. The book records each firing before anything it
// does is proposed (triggers.ts `fired`); this file decides when.
//
// - Levels (a price, a market cap, from the entry) read Candle's market read for their token, about every
//   5 s: the price the sell fills against, with `marketCap` beside it. Candle doesn't count that read toward
//   a key's limit (measured), so it costs the key's budget nothing; at most 20 tokens are read a heartbeat, a
//   sell's first, and past that each is read less often. A read any other reader just made (the token pane's
//   samples) is used as it is. An answer with no price is no reading, never a price.
// - From the entry is Candle's cost book: the Candle Harness's agents' open positions in that token on the wallet the
//   trigger trades from (a shared wallet's position sits in one agent's book). No position, no level: it waits.
// - P&L levels check the P&L window's figure, which moves only when Candle's P&L is read.
// - Hacc's tape: each stream row, by pattern, chain and group. A row from before the trigger was switched on
//   is never acted on (the stream's opening snapshot included), nor one heard more than 10 minutes after it
//   happened (a core catching up after a gap). Market-cap filters check Candle's market cap for the token,
//   never Hacc's filter alone, which passes a token whose market cap it doesn't know. A trigger that only notifies
//   or wakes an agent, on a token Candle has no market cap for (one Candle doesn't list, as most new Hood tokens on
//   Hacc's tape), takes Hacc's market read's figure instead and says so when it fires; one that trades keeps to
//   Candle's, as Candle couldn't trade a token it doesn't list. A signal whose market cap neither knows is skipped,
//   and skips are journalled with why, gathered per trigger and reason, one row a minute at most (`trigger.skipped`),
//   so a trigger that never fires says why. Age filters ask Hacc's filtered tape whether it holds the row.
// - Personal signals: each polled row, by the rule's name. The rows carry Hacc's asset id, not the token's
//   address, so a trigger that acts on `it` reads the token from Hacc's asset read.
// - Fills, cards expiring and replays ending, from the journal.
// - Schedules, in this machine's local time. A heartbeat that comes over a minute after the last is a sleep
//   (or a core that wasn't running): on waking, levels and P&L check at once, and a schedule it slept through
//   runs once late inside its window (an hour, or its own interval if shorter), else is said as missed.
// - Cooldowns: the tape and personal signals once per token per cooldown; the rest once per cooldown. A level
//   fires once and switches off, or with `again` re-arms when it's crossed back.
// - Rules bots' open positions are read here too, as sells, so a bot's exits and the triggers' levels share the 20
//   reads a heartbeat; after each heartbeat the bots' exits check their positions against what was read.
//
// Nothing fires while the firing path isn't wired (the book says so), and nothing is said as missed then either.
// Every wait goes through an injected clock, so a day of schedules runs in a test in a moment.
import { type BotEvent, IT_MINT, partsOfAction, type ResolvedTrigger, type TriggerWhen, dollarWords, durationWords, pnlWindowWords } from "../shared/trigger-grammar"
import type { ToolOutcome } from "./candle-mcp"
import type { HaccAnswer } from "./hacc"
import type { JournalRow } from "./journal"
import type { SignalRow } from "./signal-stream"
import { cooldownOf, cooledUntil, type FireCause, type TokenOn, type TriggerBook, type WatchInfo } from "./triggers"
import type { TriggerEntry } from "./triggers-file"
import { short } from "./wallet-names"
import { type ChainSlug, isAddressOn, maybeChain, requestChain, sameAddress, storedChain } from "../shared/chains"

export const HEARTBEAT_MS = 5_000
/** How often an armed level's token is read, at its own pace. */
export const LEVEL_MS = 5_000
/** The most tokens read in one heartbeat: 240 a minute. */
export const LEVEL_READS_PER_BEAT = 20
/** A market read this fresh, from any reader, is used as it is. */
const SHARED_MARKET_MS = 4_500
/** How fresh a market cap must be for a tape trigger's filter. */
const FILTER_MARKET_MS = 15_000
/** A heartbeat this long after the last means the machine slept, or the core wasn't running. */
export const SLEEP_GAP_MS = 60_000
/** A tape or personal signal heard this long after it happened isn't acted on. */
export const TAPE_FRESH_MS = 10 * 60_000
/** How late a schedule may still run once, after a sleep. */
export const LATE_WINDOW_MS = 60 * 60_000
/** A schedule run this late is on time: a heartbeat or two. */
const ON_TIME_MS = 2 * HEARTBEAT_MS
const RULES_REUSE_MS = 5 * 60_000
const ASSETS_KEPT = 2_000
/** Readings kept per token for its measured pace. */
const PACE_KEPT = 6
/** A trigger's skipped signals are gathered and journalled at most this often, per trigger and reason. */
export const TRIGGER_SKIP_FLUSH_MS = 60_000
/** The signal ids and tokens a skip row keeps. */
const SKIP_IDS_KEPT = 200
const SKIP_MINTS_KEPT = 20
/** Candle's answers that mean it doesn't list the token at all. */
const NOT_LISTED = new Set(["MARKET_NOT_FOUND"])

/** Why a tape signal a trigger watched for didn't fire it: its market cap was unknown to every source it may use. */
export type TriggerSkipReason = "not_on_candle" | "no_market_cap"

/** Skips gathered for one trigger and reason, before they're journalled. */
interface SkipGroup {
  t: TriggerEntry
  count: number
  signals: number[]
  mints: string[]
  words: string
}

export interface Clock {
  now(): number
  schedule(run: () => void, ms: number): () => void
}

type Book = Pick<TriggerBook, "live" | "resolved" | "stateOf" | "fired" | "missed" | "setArmed" | "setNextRun" | "canFire"> & Partial<Pick<TriggerBook, "noteUnread" | "skipped">>
type Chain = ChainSlug

export interface TriggerWatchDeps {
  book: Book
  clock: Clock
  /** Candle's market read for a token, through a key that can make it now; undefined when none can. */
  market(chain: Chain, mint: string): Promise<ToolOutcome | undefined>
  /** The Candle Harness's agents' open positions, from Candle's P&L book. */
  positions(): { mint: string; wallet: string; quantity: number; costBasisUsd: number }[]
  /** The address a trigger's trade pays from: the wallet it names, else its agent's default. */
  walletOf(agent: string, wallet: string | undefined, mint: string): string | undefined
  /**
   * The P&L figure over `window` (a trigger's own, kept in its line), or null before any sample in it. With none,
   * for a trigger saved before its line kept one, the P&L window's figure as it shows now.
   */
  pnlUsd(window?: string): number | null
  /** After a sleep: Candle's P&L read again now. */
  pnlNow(): void
  /** A read of Hacc's with the trigger's agent's key. */
  hacc(agent: string, route: string, query: Record<string, string | number | undefined>): Promise<HaccAnswer>
  /** A token's name for words, else its short address. */
  nameOf(mint: string): string | undefined
  /** What the watchers need of Hacc's stream and personal signals changed. */
  needsChanged(): void
  /** What a trigger's watcher shows changed (a reading, its pace): at most once a heartbeat. */
  onChange(): void
  /** The tokens rules bots hold open positions in: read as a sell's token is, each heartbeat. */
  exitTokens?(): string[]
  /** After each heartbeat's reads: the bots' exits check their positions. `first` is the core's first heartbeat. */
  afterBeat?(beat: { slept: boolean; first: boolean }): Promise<void>
}

export interface Reading {
  priceUsd: number | null
  marketCap: number | null
  /** The token's decimals, where Candle's answer gives them (a token it launched). */
  decimals?: number
  at: number
}

interface Live {
  t: TriggerEntry
  r: ResolvedTrigger
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)
const chainOf = (mint: string): Chain => requestChain(mint) ?? "solana"

/** The chain a level's token is read on: the one stored with its trigger, else (one saved before triggers kept it) its address's family's. */
export const levelChain = (t: Pick<TriggerEntry, "chain">, mint: string): Chain => t.chain ?? storedChain(undefined, mint) ?? "solana"

/**
 * The token a tape row is about, and its chain: the chain Hacc says, taken only where the address fits it; with none
 * said, the address's family's. A row whose address doesn't fit the chain it names, or that names a chain that isn't
 * on, is unreadable: undefined, as for a row with no address.
 */
export function tapeToken(row: Record<string, unknown>): { mint: string; chain: Chain } | undefined {
  const mint = typeof row.asset_address === "string" && row.asset_address.length > 0 ? row.asset_address : undefined
  if (!mint) return undefined
  const said: unknown = row.asset_chain
  if (said === undefined || said === null || said === "") return { mint, chain: storedChain(undefined, mint) ?? "solana" }
  const chain = maybeChain(said)?.slug
  return chain !== undefined && isAddressOn(chain, mint) ? { mint, chain } : undefined
}

const iso = (ms: number) => new Date(ms).toISOString()

/** A reading from Candle's market answer for `mint`, or undefined when it carries neither a price nor a market cap. */
export function readingOf(outcome: ToolOutcome | undefined, mint: string | undefined, at: number): (Reading & { mint: string }) | undefined {
  if (outcome?.kind !== "ok") return undefined
  const market = record(record(outcome.result)?.market)
  if (!market || typeof market.mint !== "string" || (mint !== undefined && market.mint !== mint)) return undefined
  const priceUsd = positive(market.priceUsd)
  const marketCap = positive(market.marketCap)
  if (priceUsd === null && marketCap === null) return undefined
  const decimals = typeof market.decimals === "number" && Number.isInteger(market.decimals) && market.decimals >= 0 ? market.decimals : undefined
  return { mint: market.mint, priceUsd, marketCap, ...(decimals !== undefined ? { decimals } : {}), at }
}

/** A reading's price in words: four figures, "$0.3981", "$1.204", "$12,340". */
export function priceWords(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`
  return `$${Number(n.toPrecision(4))}`
}

/** The next time a schedule of days runs after `from`: its time of day, in this machine's local time. */
export function nextOnDays(days: readonly number[], at: string, from: number): number {
  const [h, m] = at.split(":").map(Number) as [number, number]
  for (let d = 0; d <= 8; d++) {
    const date = new Date(from)
    date.setDate(date.getDate() + d)
    date.setHours(h, m, 0, 0)
    if (days.includes(date.getDay()) && date.getTime() > from) return date.getTime()
  }
  return from + 7 * 86_400_000
}

type Schedule = Extract<TriggerWhen, { kind: "schedule" }>["every"]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
/** A schedule's first run after it's switched on: `at` once, its next HH:MM. */
const firstRun = (every: Schedule, from: number) => (every.kind === "interval" ? from + every.ms : nextOnDays(every.kind === "once" ? ALL_DAYS : every.days, every.at, from))
/** The run after `now`, from the one that was due: an interval keeps its cadence. A run once has none. */
const runAfter = (every: Schedule, due: number, now: number) =>
  every.kind === "interval" ? due + every.ms * (Math.floor(Math.max(0, now - due) / every.ms) + 1) : every.kind === "once" ? undefined : nextOnDays(every.days, every.at, now)
/** How late a missed run may still run once. */
const lateWindow = (every: Schedule) => (every.kind === "interval" ? Math.min(LATE_WINDOW_MS, every.ms) : LATE_WINDOW_MS)

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** When a run is, in words: "14:20", "09:00 tomorrow", "09:00 on Monday". */
export function runWords(at: number, now: number): string {
  const day = (ms: number) => new Date(ms).toDateString()
  if (day(at) === day(now)) return hhmm(at)
  if (day(at) === day(now + 86_400_000)) return `${hhmm(at)} tomorrow`
  return `${hhmm(at)} on ${new Date(at).toLocaleDateString("en-GB", { weekday: "long" })}`
}

/** A rules bot's entry or exit filled, or its pause, as a journal row shows it. */
export interface BotEventSeen {
  bot: string
  what: BotEvent
  agent?: string
  mint?: string
  /** An exit's why, or a pause's: "stop_loss", "Candle stopped its key". */
  reason?: string
  paper?: true
  /** A code bot's own word and line (`bot.event`): the line is its own, cleaned, and fenced as data where an agent reads it. */
  word?: string
  text?: string
}

export class TriggerWatch {
  private running = false
  private cancel: (() => void) | undefined
  private lastBeat: number | undefined
  private beating: Promise<void> | undefined
  private readonly market = new Map<string, Reading>()
  /** When each token's readings came, for its measured pace. */
  private readonly readAts = new Map<string, number[]>()
  /** Tokens whose market read is under way. */
  private readonly reading = new Set<string>()
  /** When each token was last picked for a read, in order: past 20 a heartbeat, they take turns. */
  private readonly picked = new Map<string, number>()
  private pickSeq = 0
  /** Firings under way, by trigger and token: one at a time. */
  private readonly firing = new Set<string>()
  /** The tokens the levels and tape filters want readings of. */
  private watched = new Set<string>()
  private needsPrint = ""
  /** A reading or pace changed since the topic was last told: told once a heartbeat, however many levels read. */
  private dirty = false
  private readonly rules = new Map<string, { at: number; byName: Map<string, Set<number>> }>()
  private readonly assets = new Map<number, { mint: string; chain: Chain }>()
  /** Skipped signals not journalled yet, by trigger and reason. */
  private readonly skips = new Map<string, Map<TriggerSkipReason, SkipGroup>>()
  private cancelSkipFlush: (() => void) | undefined

  constructor(private readonly deps: TriggerWatchDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.refresh()
    void this.beat()
  }

  stop(): void {
    this.running = false
    this.cancel?.()
    this.cancel = undefined
    this.cancelSkipFlush?.()
    this.cancelSkipFlush = undefined
  }

  /** The triggers changed (saved, switched, held): what's watched is worked out again, and checked soon. */
  refresh(): void {
    const live = this.live()
    this.watched = new Set([...live.flatMap(({ r }) => (r.class === "level" && "token" in r.when && r.when.token ? [r.when.token] : [])), ...(this.deps.exitTokens?.() ?? [])])
    const needs = this.needs(live)
    const print = JSON.stringify(needs)
    if (print !== this.needsPrint) {
      this.needsPrint = print
      this.deps.needsChanged()
    }
  }

  /** Whether a live trigger watches Hacc's tape or personal signals: each holds its stream or poll open. */
  needs(live = this.live()): { tape: boolean; mine: boolean } {
    return { tape: live.some(({ r }) => r.class === "tape"), mine: live.some(({ r }) => r.class === "mine") }
  }

  /** Another reader's market answer: kept for a level on that token, so it isn't read again within 5 s. */
  noteMarket(outcome: ToolOutcome): void {
    const r = readingOf(outcome, undefined, this.deps.clock.now())
    if (r && this.watched.has(r.mint)) this.keep(r.mint, r)
  }

  /** One heartbeat: schedules, then levels, then P&L. Public for tests; the core runs it every 5 s. */
  async beat(): Promise<void> {
    if (this.beating) return this.beating
    this.beating = this.beatOnce()
      .catch(() => {})
      .finally(() => {
        this.beating = undefined
        if (!this.running) return
        this.cancel?.()
        this.cancel = this.deps.clock.schedule(() => void this.beat(), HEARTBEAT_MS)
      })
    return this.beating
  }

  private async beatOnce(): Promise<void> {
    const now = this.deps.clock.now()
    const slept = this.lastBeat !== undefined && now - this.lastBeat > SLEEP_GAP_MS
    const first = this.lastBeat === undefined
    this.lastBeat = now
    // Waking: what was read before the sleep says nothing about now.
    if (slept) {
      this.market.clear()
      this.deps.pnlNow()
    }
    this.refresh()
    // A live trigger whose line doesn't read (the wallet it pays from isn't read yet, or can't pay) is said, not dropped in silence.
    await this.deps.book.noteUnread?.().catch(() => {})
    const live = this.live()
    if (this.deps.book.canFire()) await this.schedules(live, now)
    await this.levels(live)
    this.pnl(live)
    await this.deps.afterBeat?.({ slept, first }).catch(() => {})
    if (this.dirty) {
      this.dirty = false
      this.deps.onChange()
    }
  }

  /** The live triggers whose expansion reads. */
  private live(): Live[] {
    return this.deps.book.live().flatMap((t) => {
      const r = this.deps.book.resolved(t)
      return r ? [{ t, r }] : []
    })
  }

  // --- schedules ---

  private async schedules(live: Live[], now: number): Promise<void> {
    for (const { t, r } of live) {
      if (r.when.kind !== "schedule") continue
      const every = r.when.every
      const s = this.deps.book.stateOf(t.name)
      if (!s) continue
      let due = s.nextRun !== undefined ? Date.parse(s.nextRun) : Number.NaN
      if (!Number.isFinite(due)) {
        // With no next run kept (a state rebuilt from the journal), from its last run where it's had one.
        due = firstRun(every, Math.max(Date.parse(s.onSince ?? s.savedAt), s.lastFired ? Date.parse(s.lastFired) : Number.NEGATIVE_INFINITY))
        this.deps.book.setNextRun(t.name, due)
      }
      if (now < due) continue
      // An interval that slept through several runs: the latest is the one that may still run late, and the
      // ones before it are said as missed (one 6 minutes late was dropped, unsaid, for an older one).
      const skipped = every.kind === "interval" ? Math.floor((now - due) / every.ms) : 0
      if (skipped > 0) {
        const first = due
        due += skipped * (every as { ms: number }).ms
        await this.deps.book.missed(t, `Missed ${skipped === 1 ? `its ${runWords(first, now)} run` : `${skipped} runs from ${runWords(first, now)}`}: this machine slept or the core wasn't running.`, { class: "schedule", due: iso(first) })
      }
      const late = now - due
      // The next run is kept before this one fires: a core that stops mid-firing never runs it twice.
      this.deps.book.setNextRun(t.name, runAfter(every, due, now))
      const when = runWords(due, now)
      if (late <= ON_TIME_MS) await this.fire(t, { by: "schedule", due: iso(due) }, `its ${when} run`)
      else if (late <= lateWindow(every)) await this.fire(t, { by: "schedule", due: iso(due), late: true }, `its ${when} run, ${durationWords(Math.max(60_000, Math.round(late / 60_000) * 60_000))} late: this machine slept or the core wasn't running`)
      else {
        const once = every.kind === "once"
        await this.deps.book.missed(t, `Missed its ${when} run: this machine slept or the core wasn't running, and a run over ${durationWords(lateWindow(every))} late doesn't run.${once ? " It was to run once, so it's switched off." : ""}`, { class: "schedule", due: iso(due) }, { switchOff: once })
      }
    }
  }

  // --- levels ---

  private async levels(live: Live[]): Promise<void> {
    const levels = live.filter(({ r }) => r.class === "level" && r.when.kind !== "pnl")
    const exits = this.deps.exitTokens?.() ?? []
    if (!levels.length && !exits.length) return
    // Each token once, however many levels watch it; a sell's token first, then the one picked longest ago.
    // A bot's open position is a sell's token: its stop must be read before a buy's level.
    const tokens = new Map<string, { sell: boolean; chain: Chain }>(exits.map((mint) => [mint, { sell: true, chain: chainOf(mint) }]))
    for (const { t, r } of levels) {
      const mint = (r.when as { token: string }).token
      if (r.when.kind === "entry" && this.entryOf(t, r, mint) === undefined) continue
      const sell = r.action.kind === "command" && partsOfAction(r.action.command).some((p) => p.args.side === "sell")
      tokens.set(mint, { sell: (tokens.get(mint)?.sell ?? false) || sell, chain: levelChain(t, mint) })
    }
    const now = this.deps.clock.now()
    const due = [...tokens]
      .filter(([mint]) => !this.reading.has(mint) && now - (this.market.get(mint)?.at ?? Number.NEGATIVE_INFINITY) >= SHARED_MARKET_MS)
      .sort(([a, x], [b, y]) => Number(y.sell) - Number(x.sell) || (this.picked.get(a) ?? 0) - (this.picked.get(b) ?? 0))
      .slice(0, LEVEL_READS_PER_BEAT)
    for (const [mint] of due) this.picked.set(mint, ++this.pickSeq)
    for (const mint of this.picked.keys()) if (!tokens.has(mint)) this.picked.delete(mint)
    await Promise.all(due.map(([mint, { chain }]) => this.read(mint, chain)))
    for (const { t, r } of levels) await this.level(t, r)
  }

  private async read(mint: string, chain: Chain): Promise<Reading | undefined> {
    return (await this.readWith(mint, chain)).reading
  }

  /** A market read, with Candle's answer beside it: a filter tells a token Candle doesn't list from one it can't price. */
  private async readWith(mint: string, chain: Chain): Promise<{ reading?: Reading; outcome?: ToolOutcome }> {
    this.reading.add(mint)
    try {
      // Stamped when it was asked: an answer can't be of a price after that, so a fill since isn't in it.
      const asked = this.deps.clock.now()
      const outcome = await this.deps.market(chain, mint).catch(() => undefined)
      const r = readingOf(outcome, mint, asked)
      if (r) this.keep(mint, r)
      return { ...(r ? { reading: r } : {}), ...(outcome ? { outcome } : {}) }
    } finally {
      this.reading.delete(mint)
    }
  }

  /** Hacc's market cap for a token, from its market read on the token's chain; null where it gives none. */
  private async haccMarketCap(agent: string, mint: string, chain: Chain): Promise<number | null> {
    const answer = await this.deps.hacc(agent, `/v1/market/token/${mint}`, chain === "hood" ? { chain } : {}).catch(() => undefined)
    if (answer?.kind !== "ok") return null
    const market = record(record(answer.body)?.market)
    if (typeof market?.address === "string" && !sameAddress(market.address, mint)) return null
    return positive(market?.market_cap)
  }

  /** The newest reading of a token's market, from this heartbeat's reads or any reader's. */
  latest(mint: string): Reading | undefined {
    return this.market.get(mint)
  }

  private keep(mint: string, r: Reading): void {
    const held = this.market.get(mint)
    if (held && held.at >= r.at) return
    this.market.set(mint, { priceUsd: r.priceUsd, marketCap: r.marketCap, ...(r.decimals !== undefined ? { decimals: r.decimals } : {}), at: r.at })
    // Two answers within a second are one check, for the pace.
    const ats = this.readAts.get(mint) ?? []
    if (ats.length === 0 || r.at - ats.at(-1)! >= 1_000) this.readAts.set(mint, [...ats, r.at].slice(-PACE_KEPT))
    this.dirty = true
  }

  /** How often a token's readings come: the median gap of its last few. */
  private paceOf(mint: string): number | undefined {
    const ats = this.readAts.get(mint) ?? []
    if (ats.length < 3) return undefined
    const gaps = ats.slice(1).map((at, i) => at - ats[i]!).sort((a, b) => a - b)
    return gaps[Math.floor(gaps.length / 2)]
  }

  /** The entry for a level from it: the cost book's positions in the token, on the wallet the trigger trades from. */
  private entryOf(t: TriggerEntry, r: ResolvedTrigger, mint: string): number | undefined {
    const parts = r.action.kind === "command" ? partsOfAction(r.action.command) : []
    const part = parts.find((p) => p.args.mint === mint) ?? parts[0]
    const wallet = this.deps.walletOf(t.agent, typeof part?.args.wallet === "string" ? part.args.wallet : undefined, mint)
    let quantity = 0
    let cost = 0
    for (const p of this.deps.positions()) {
      if (p.mint !== mint || p.quantity <= 0 || (wallet !== undefined && p.wallet !== wallet)) continue
      quantity += p.quantity
      cost += p.costBasisUsd
    }
    return quantity > 0 && cost > 0 ? cost / quantity : undefined
  }

  private async level(t: TriggerEntry, r: ResolvedTrigger): Promise<void> {
    const w = r.when
    if (w.kind !== "price" && w.kind !== "mcap" && w.kind !== "entry") return
    const reading = this.market.get(w.token)
    if (!reading) return
    const name = this.nameOf(w.token)
    if (w.kind === "entry") {
      const entry = this.entryOf(t, r, w.token)
      if (entry === undefined || reading.priceUsd === null) return
      const level = entry * (w.dir === "down" ? 1 - w.percent / 100 : 1 + w.percent / 100)
      const cond = w.dir === "down" ? reading.priceUsd < level : reading.priceUsd > level
      return this.crossed(t, r, cond, { by: "level", what: "entry", mint: w.token, chain: levelChain(t, w.token), reading: reading.priceUsd, level, entryUsd: entry, readAt: iso(reading.at) }, `${name} was ${priceWords(reading.priceUsd)}, ${w.dir} ${w.percent}% from your ${priceWords(entry)} entry (${priceWords(level)})`)
    }
    const value = w.kind === "price" ? reading.priceUsd : reading.marketCap
    if (value === null) return
    const cond = w.op === "<" ? value < w.usd : value > w.usd
    const shown = w.kind === "price" ? `${name} was ${priceWords(value)}` : `${name}'s market cap was ${dollarWords(Math.round(value))}`
    return this.crossed(t, r, cond, { by: "level", what: w.kind, mint: w.token, chain: levelChain(t, w.token), reading: value, level: w.usd, readAt: iso(reading.at) }, `${shown}, ${w.op === "<" ? "under" : "over"} ${dollarWords(w.usd)}`)
  }

  private pnl(live: Live[]): void {
    for (const { t, r } of live) {
      const w = r.when
      if (w.kind !== "pnl") continue
      // Its own window's figure, whatever the P&L tab shows: changing what's on screen never fires a trigger.
      const usd = this.deps.pnlUsd(w.window)
      if (usd === null) continue
      const cond = w.op === "<" ? usd < w.usd : usd > w.usd
      const figure = w.window !== undefined ? `your P&L ${pnlWindowWords(w.window)}` : "the P&L window's figure"
      void this.crossed(t, r, cond, { by: "level", what: "pnl", reading: usd, level: w.usd, readAt: iso(this.deps.clock.now()) }, `${figure} was ${dollarWords(usd)}, ${w.op === "<" ? "under" : "over"} ${dollarWords(w.usd)}`)
    }
  }

  /** After each of Candle's P&L reads: the P&L levels check the new figure. */
  pnlRead(): void {
    this.pnl(this.live())
  }

  /**
   * A level's condition, read: armed and met, it fires (with `again`, once its cooldown since the last firing
   * is over); disarmed, with `again`, it re-arms once the condition no longer holds (crossed back).
   */
  private async crossed(t: TriggerEntry, r: ResolvedTrigger, cond: boolean, cause: FireCause, words: string): Promise<void> {
    const s = this.deps.book.stateOf(t.name)
    if (!s) return
    if (!s.armed) {
      if (t.again && !cond) this.deps.book.setArmed(t.name, true)
      return
    }
    if (!cond || !this.deps.book.canFire()) return
    const until = t.again ? cooledUntil(s, "*", cooldownOf(t, r.class)) : undefined
    if (until !== undefined && this.deps.clock.now() < until) return
    await this.fire(t, cause, words)
  }

  // --- Hacc's tape and personal signals ---

  /** New rows from Hacc's stream (not a filter's read-back): each tape trigger checks them. */
  async onTape(rows: readonly SignalRow[]): Promise<void> {
    if (!this.deps.book.canFire() || !rows.length) return
    const now = this.deps.clock.now()
    const work: Promise<void>[] = []
    for (const { t, r } of this.live()) {
      const w = r.when
      if (w.kind !== "tape") continue
      const since = this.onSince(t)
      let stale = 0
      for (const row of rows) {
        if (row.pattern !== w.pattern) continue
        const token = tapeToken(row)
        if (!token) continue
        const { mint, chain } = token
        if (w.filters.chain && chain !== w.filters.chain) continue
        if (w.filters.group && !(Array.isArray(row.wallet_groups) && row.wallet_groups.includes(w.filters.group))) continue
        const at = Date.parse(row.created_at)
        if (!(at >= since)) continue
        if (now - at > TAPE_FRESH_MS) {
          stale++
          continue
        }
        if (this.cooling(t, r, mint, at)) continue
        work.push(this.once(`${t.name}\n${mint}`, () => this.tapeRow(t, r, row, mint, chain)))
      }
      if (stale) work.push(this.deps.book.missed(t, `${stale} ${w.pattern} signal${stale === 1 ? "" : "s"} reached the core more than ${durationWords(TAPE_FRESH_MS)} after ${stale === 1 ? "it" : "they"} happened (catching up after a gap), so ${stale === 1 ? "it wasn't" : "they weren't"} acted on.`, { class: "tape", signals: stale }))
    }
    await Promise.all(work)
  }

  private async tapeRow(t: TriggerEntry, r: ResolvedTrigger, row: SignalRow, mint: string, chain: Chain): Promise<void> {
    const w = r.when as Extract<TriggerWhen, { kind: "tape" }>
    const f = w.filters
    let fromHacc: { usd: number; why: string } | undefined
    if (f.minMcapUsd !== undefined || f.maxMcapUsd !== undefined) {
      const held = this.market.get(mint)
      const got = held && this.deps.clock.now() - held.at <= FILTER_MARKET_MS ? { reading: held } : await this.readWith(mint, chain)
      let mc = got.reading?.marketCap ?? null
      const notListed = got.outcome?.kind === "error" && NOT_LISTED.has(got.outcome.code)
      const trades = r.action.kind === "command"
      // Only a trigger that notifies or wakes takes Hacc's figure: one that trades keeps to Candle's.
      if (mc === null && !trades) {
        const hacc = await this.haccMarketCap(t.agent, mint, chain)
        if (hacc !== null) {
          mc = hacc
          fromHacc = { usd: hacc, why: notListed ? "Candle doesn't list it" : "Candle has no market cap for it" }
        }
      }
      if (mc === null) {
        const name = this.nameOf(mint)
        const why = notListed ? `Candle doesn't list ${name}` : `Candle doesn't know ${name}'s market cap`
        const words = trades ? `${why}, and a trigger that trades goes by Candle's market cap only, so its market-cap filter can't pass` : `${why} and Hacc gave none for it, so its market-cap filter can't pass`
        this.skip(t, row, mint, notListed ? "not_on_candle" : "no_market_cap", words)
        return
      }
      if ((f.maxMcapUsd !== undefined && !(mc < f.maxMcapUsd)) || (f.minMcapUsd !== undefined && !(mc > f.minMcapUsd))) return
    }
    if (f.minAgeMinutes !== undefined || f.maxAgeMinutes !== undefined) {
      const answer = await this.deps.hacc(t.agent, "/v1/signals", {
        asset: mint,
        pattern: w.pattern,
        since: iso(Date.parse(row.created_at) - 1),
        limit: 20,
        ...(f.minAgeMinutes !== undefined ? { min_age_minutes: Math.round(f.minAgeMinutes) } : {}),
        ...(f.maxAgeMinutes !== undefined ? { max_age_minutes: Math.round(f.maxAgeMinutes) } : {}),
        ...(chain === "hood" ? { chain } : {}),
      })
      const signals = answer.kind === "ok" ? record(answer.body)?.signals : undefined
      if (!Array.isArray(signals) || !signals.some((s) => record(s)?.id === row.id)) return
    }
    if (this.cooling(t, r, mint, Date.parse(row.created_at))) return
    const said = fromHacc ? ` (market cap ${dollarWords(Math.round(fromHacc.usd))} from Hacc: ${fromHacc.why})` : ""
    await this.fire(
      t,
      { by: "tape", mint, chain, signalId: row.id, pattern: w.pattern, signalAt: row.created_at, ...(fromHacc ? { marketCap: { usd: fromHacc.usd, from: "hacc" as const } } : {}) },
      `a ${w.pattern} signal on ${this.nameOf(mint)} at ${hhmm(Date.parse(row.created_at))}${said}`,
    )
  }

  /** A signal a trigger watched for and didn't act on, gathered: journalled with the others for its reason, a minute later at most. */
  private skip(t: TriggerEntry, row: SignalRow, mint: string, reason: TriggerSkipReason, words: string): void {
    let byReason = this.skips.get(t.name)
    if (!byReason) this.skips.set(t.name, (byReason = new Map()))
    const g = byReason.get(reason) ?? { t, count: 0, signals: [], mints: [], words }
    g.t = t
    g.count++
    g.words = words
    if (g.signals.length < SKIP_IDS_KEPT) g.signals.push(row.id)
    if (!g.mints.includes(mint) && g.mints.length < SKIP_MINTS_KEPT) g.mints.push(mint)
    byReason.set(reason, g)
    if (!this.cancelSkipFlush && this.running) {
      this.cancelSkipFlush = this.deps.clock.schedule(() => {
        this.cancelSkipFlush = undefined
        void this.flushSkips().catch(() => {})
      }, TRIGGER_SKIP_FLUSH_MS)
    }
  }

  /** Journals the skips gathered: one row per trigger and reason. Public for tests, and for the core's stop, before its journal closes. */
  async flushSkips(): Promise<void> {
    const all = [...this.skips]
    this.skips.clear()
    for (const [, byReason] of all) {
      for (const [reason, g] of byReason) {
        await this.deps.book.skipped?.(g.t, { reason, count: g.count, signals: g.signals, mints: g.mints, words: g.count === 1 ? g.words : `${g.count} signals, the last because ${g.words}` })
      }
    }
  }

  /** New rows from personal signals' poll: each personal-signals trigger checks them. */
  async onMine(rows: readonly SignalRow[]): Promise<void> {
    if (!this.deps.book.canFire() || !rows.length) return
    const now = this.deps.clock.now()
    const work: Promise<void>[] = []
    for (const { t, r } of this.live()) {
      const w = r.when
      if (w.kind !== "mine") continue
      const rule = w.rule !== undefined ? await this.ruleIds(t.agent, w.rule) : undefined
      const since = this.onSince(t)
      let stale = 0
      for (const row of rows) {
        if (rule && !rule.has(Number(row.rule_id))) continue
        const at = Date.parse(row.created_at)
        if (!(at >= since)) continue
        if (now - at > TAPE_FRESH_MS) {
          stale++
          continue
        }
        const assetId = typeof row.asset_id === "number" ? row.asset_id : undefined
        const key = this.assets.get(assetId ?? -1)?.mint ?? (assetId !== undefined ? `asset:${assetId}` : `signal:${row.id}`)
        if (this.cooling(t, r, key, at)) continue
        work.push(this.once(`${t.name}\n${key}`, () => this.mineRow(t, r, row, assetId)))
      }
      if (stale) work.push(this.deps.book.missed(t, `${stale} personal signal${stale === 1 ? "" : "s"} reached the core more than ${durationWords(TAPE_FRESH_MS)} after ${stale === 1 ? "it" : "they"} happened, so ${stale === 1 ? "it wasn't" : "they weren't"} acted on.`, { class: "mine", signals: stale }))
    }
    await Promise.all(work)
  }

  private async mineRow(t: TriggerEntry, r: ResolvedTrigger, row: SignalRow, assetId: number | undefined): Promise<void> {
    const w = r.when as Extract<TriggerWhen, { kind: "mine" }>
    const usesIt = r.action.kind === "command" && partsOfAction(r.action.command).some((p) => p.args.mint === IT_MINT)
    const asset = assetId !== undefined ? await this.asset(t.agent, assetId, usesIt) : undefined
    if (usesIt && !asset) {
      await this.deps.book.missed(t, `Hacc's asset read didn't say which token personal signal ${row.id} was about, so it didn't run.`, { class: "mine", signalId: row.id })
      return
    }
    const key = asset?.mint ?? (assetId !== undefined ? `asset:${assetId}` : undefined)
    if (key && this.cooling(t, r, key, Date.parse(row.created_at))) return
    const pattern = typeof row.pattern === "string" ? row.pattern : "signal"
    const on = asset ? ` on ${this.nameOf(asset.mint)}` : ""
    const token: TokenOn = asset ? { mint: asset.mint, chain: asset.chain } : {}
    await this.fire(
      t,
      { by: "mine", ...token, ...(assetId !== undefined ? { assetId } : {}), signalId: row.id, pattern, ...(w.rule !== undefined ? { rule: w.rule } : {}), signalAt: row.created_at },
      `your personal signal (${pattern})${on} at ${hhmm(Date.parse(row.created_at))}`,
    )
  }

  /** The ids of the account's rules with a name, read from Hacc every 5 minutes at most. */
  private async ruleIds(agent: string, name: string): Promise<Set<number>> {
    const held = this.rules.get(agent)
    if (!held || this.deps.clock.now() - held.at >= RULES_REUSE_MS) {
      const answer = await this.deps.hacc(agent, "/v1/me/rules", {})
      const rows = answer.kind === "ok" ? record(answer.body)?.rules : undefined
      if (Array.isArray(rows)) {
        const byName = new Map<string, Set<number>>()
        for (const row of rows) {
          const r = record(row)
          if (typeof r?.name !== "string" || typeof r.id !== "number") continue
          byName.set(r.name, (byName.get(r.name) ?? new Set()).add(r.id))
        }
        this.rules.set(agent, { at: this.deps.clock.now(), byName })
      }
    }
    return this.rules.get(agent)?.byName.get(name) ?? new Set()
  }

  /** The token Hacc's asset id is, from its asset read, kept: an asset's address never changes. */
  private async asset(agent: string, id: number, read: boolean): Promise<{ mint: string; chain: Chain } | undefined> {
    const held = this.assets.get(id)
    if (held || !read) return held
    const answer = await this.deps.hacc(agent, `/v1/assets/${id}`, {})
    const a = answer.kind === "ok" ? record(record(answer.body)?.asset) : undefined
    if (typeof a?.address !== "string" || a.address.length === 0) return undefined
    const found = { mint: a.address, chain: a.chain === "hood" ? ("hood" as const) : ("solana" as const) }
    if (this.assets.size >= ASSETS_KEPT) this.assets.clear()
    this.assets.set(id, found)
    return found
  }

  // --- the person's state, from the journal ---

  /**
   * A journal row: a fill, a card expiring or a replay ending fires the triggers waiting on it. `fill` says
   * what an `operation.succeeded` row filled: its agent and tokens, or undefined for anything not a trade or swap.
   * A trigger's own firing never fires it again (its rows carry its name).
   */
  async onJournal(row: JournalRow, fill?: (row: JournalRow) => { agent?: string; mints: string[] } | undefined, botEvent?: (row: JournalRow) => BotEventSeen | undefined): Promise<void> {
    if (!this.deps.book.canFire()) return
    // One row can be a fill and a bot's entry or exit both: each fires the triggers waiting on it.
    const event = row.type === "operation.succeeded" ? "fill" : row.type === "card.expired" ? "card-expired" : row.type === "hacc.replay" ? "replay-ended" : undefined
    const bot = botEvent?.(row)
    if (bot) await this.onBot(row, bot)
    if (!event) return
    const filled = event === "fill" ? fill?.(row) : undefined
    if (event === "fill" && !filled) return
    const agent = typeof row.agent === "string" ? row.agent : undefined
    const now = this.deps.clock.now()
    for (const { t, r } of this.live()) {
      const w = r.when
      if (w.kind !== "event" || w.event !== event || row.trigger === t.name || row.woken === t.name) continue
      if (event === "fill" && w.token !== undefined && !filled!.mints.includes(w.token)) continue
      if (this.cooling(t, r, "*", now)) continue
      const mint = event === "fill" ? (w.token ?? filled!.mints[0]) : undefined
      const cause: FireCause = {
        by: "event",
        event,
        ...(agent ? { agent } : {}),
        ...(typeof row.opId === "string" ? { opId: row.opId } : {}),
        ...(typeof row.cardId === "string" ? { cardId: row.cardId } : {}),
        ...(typeof row.jobId === "number" ? { jobId: row.jobId } : {}),
        ...(mint ? { mint } : {}),
      }
      const words =
        event === "fill" ? `a fill${mint ? ` of ${this.nameOf(mint)}` : ""}${agent ? ` (${agent})` : ""}` : event === "card-expired" ? `a card${agent ? ` of ${agent}'s` : ""} expired` : `a replay${typeof row.jobId === "number" ? ` (job ${row.jobId})` : ""} ended`
      await this.fire(t, cause, words)
    }
  }

  /** A rules bot bought into a position, sold out of one, or was paused: the triggers on that bot and event fire. */
  private async onBot(row: JournalRow, seen: BotEventSeen): Promise<void> {
    const now = this.deps.clock.now()
    for (const { t, r } of this.live()) {
      const w = r.when
      if (w.kind !== "event" || w.event !== "bot" || w.bot !== seen.bot || w.what !== seen.what || row.trigger === t.name || row.woken === t.name) continue
      if (w.what === "says" && w.word !== seen.word) continue
      if (this.cooling(t, r, "*", now)) continue
      const cause: FireCause = {
        by: "event",
        event: "bot",
        bot: seen.bot,
        what: seen.what,
        ...(seen.agent ? { agent: seen.agent } : {}),
        ...(typeof row.opId === "string" ? { opId: row.opId } : {}),
        ...(seen.mint ? { mint: seen.mint } : {}),
        ...(seen.paper ? { paper: true as const } : {}),
        ...(seen.word ? { word: seen.word } : {}),
      }
      const token = seen.mint ? ` ${this.nameOf(seen.mint)}` : ""
      const words =
        seen.what === "says"
          ? `the code bot "${seen.bot}" said "${seen.word ?? ""}"${seen.text ? `, in its own words: «${seen.text}»` : ""}`
          : seen.what === "entered"
          ? `the bot "${seen.bot}" bought${token}${seen.paper ? " on paper" : ""}`
          : seen.what === "exited"
            ? `the bot "${seen.bot}" sold${token}${seen.reason ? ` (${seen.reason})` : ""}${seen.paper ? " on paper" : ""}`
            : `the bot "${seen.bot}" was paused${seen.reason ? `: ${seen.reason}` : ""}`
      await this.fire(t, cause, words)
    }
  }

  // --- firing ---

  private onSince(t: TriggerEntry): number {
    const s = this.deps.book.stateOf(t.name)
    return Date.parse(s?.onSince ?? s?.savedAt ?? iso(this.deps.clock.now()))
  }

  /**
   * Whether `at` falls inside the trigger's cooldown for `key`. A signal goes by when it happened, so one from inside
   * the cooldown, heard only after it (the tape read back after a restart), never fires.
   */
  private cooling(t: TriggerEntry, r: ResolvedTrigger, key: string, at: number): boolean {
    const until = cooledUntil(this.deps.book.stateOf(t.name), key, cooldownOf(t, r.class))
    return until !== undefined && at < until
  }

  /** Runs `work` unless the same trigger and token is already being checked or fired. */
  private async once(key: string, work: () => Promise<void>): Promise<void> {
    if (this.firing.has(key)) return
    this.firing.add(key)
    try {
      await work()
    } catch {
      // A read that failed leaves the row unacted on; the next row or heartbeat tries again.
    } finally {
      this.firing.delete(key)
    }
  }

  private async fire(t: TriggerEntry, cause: FireCause, words: string): Promise<void> {
    if (this.firing.has(t.name)) return
    this.firing.add(t.name)
    try {
      await this.deps.book.fired(t, cause, words)
    } finally {
      this.firing.delete(t.name)
    }
  }

  private nameOf(mint: string): string {
    return this.deps.nameOf(mint) ?? short(mint)
  }

  // --- what the topic shows ---

  /** What a trigger's watcher sees, in words, with a level's measured pace. */
  info(name: string): WatchInfo | undefined {
    const live = this.live().find((x) => x.t.name === name)
    if (!live) return undefined
    const { t, r } = live
    const w = r.when
    const now = this.deps.clock.now()
    if (w.kind === "price" || w.kind === "mcap" || w.kind === "entry") {
      const nm = this.nameOf(w.token)
      if (w.kind === "entry" && this.entryOf(t, r, w.token) === undefined) return { watching: `No position in ${nm} on its wallet yet, so it waits for one.` }
      const reading = this.market.get(w.token)
      const pace = this.paceOf(w.token)
      const paced = pace !== undefined ? `checked about every ${Math.max(1, Math.round(pace / 1000))} s` : "checking"
      if (!reading) return { watching: `${paced}: no price from Candle yet` }
      const value = w.kind === "mcap" ? (reading.marketCap !== null ? `market cap ${dollarWords(Math.round(reading.marketCap))}` : "no market cap from Candle") : reading.priceUsd !== null ? priceWords(reading.priceUsd) : "no price from Candle"
      let level = ""
      if (w.kind === "entry") {
        const entry = this.entryOf(t, r, w.token)!
        level = ` · ${w.dir} ${w.percent}% from ${priceWords(entry)} is ${priceWords(entry * (w.dir === "down" ? 1 - w.percent / 100 : 1 + w.percent / 100))}`
      }
      return { watching: `${paced} · ${nm} ${value}${level}`, ...(pace !== undefined ? { paceMs: pace } : {}) }
    }
    if (w.kind === "pnl") {
      const usd = this.deps.pnlUsd(w.window)
      // One saved before its line kept a window follows the one showing: said, since changing it can fire the trigger.
      return { watching: `checked after each P&L read · now ${usd === null ? "—" : dollarWords(usd)}${w.window === undefined ? " · it follows the P&L window showing, so changing the window can fire it: ask the agent to propose it again to fix its window" : ""}` }
    }
    if (w.kind === "tape") return { watching: `watches Hacc's tape for ${w.pattern}` }
    if (w.kind === "mine") return { watching: w.rule !== undefined ? `watches your personal signals for "${w.rule}"` : "watches your personal signals" }
    if (w.kind === "schedule") {
      const next = this.deps.book.stateOf(name)?.nextRun
      return next ? { watching: `next run ${runWords(Date.parse(next), now)}` } : { watching: "next run being worked out" }
    }
    return undefined
  }
}
