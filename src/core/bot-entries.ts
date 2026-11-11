// Rules bots' entries: each bot's definition matched against Hacc's full tape, in the core, view or no view.
//
// - The tape is the full one (`quality=all`), on a stream of the bots' own: Hacc's strategy replays run on it, and
//   the curated tape the views read has about half the new tickers. Read against Hacc's replay of the same hour,
//   this matcher took the same signals (each token's first passing signal, by when it happened, then by id).
// - A signal is a candidate when its pattern and chain are the definition's, it came after the bot last went on,
//   it's at most 2 minutes old when it's decided (a signal read back after a restart or a dropped stream included:
//   an older one is skipped as heard too late, as Hacc's replay enters about a minute after a signal), and the filters its own row carries pass: `groups`, `groups_all`
//   and `wallet_ids` from its wallet, `direction` and `min_usd` from its payload, `hours_et` from its time. A row
//   that fails them isn't one of the bot's candidates, and nothing is said, as Hacc counts none.
// - A candidate is entered once, and only when the bot holds no position in the token (nor is entering one), has a
//   slot free (`max_concurrent`, open positions and entries under way; a candidate still being checked holds none, and
//   takes a slot only once it passes, just before its entry is journalled), Candle has a price for the token, the
//   market-cap band passes on Candle's market cap (unknown fails it, where Hacc's own filter passes it), the age
//   and venue filters pass on Hacc's filtered read of that signal, its sizing gives a stake, and a live wallet holds
//   the stake with Candle's fee. A token Candle can't price yet is read again every 15 s for a minute, as Hacc's
//   replay enters at its first price mark, often a minute after the signal; then it's skipped as unpriceable.
// - What it decided is journalled before anything is proposed (`bot.entering`, with the signal's id), so a core
//   that stops mid-entry never enters that signal again. The buy then takes the trade path everything takes: the
//   bot's own client proposes it with the bot's origin, and its wallet's figures decide: inside them it runs with a
//   receipt; over them, or on a wallet that asks every time, it's a card that waits for the person. The agent's
//   limits, the kill switch and a key Candle holds refuse it as they refuse any card.
// - Skips are journalled with why, in Hacc's skip words where they match theirs (`already_open`, `max_concurrent`,
//   `unpriceable`, `no_budget`, `sizing_skip`, `sizing_zero`) and the Candle Harness's for its own. They're gathered per bot
//   and reason, one row a minute at most: a busy pattern skips hundreds of signals an hour.
import { sameAddress } from "../shared/address-key"
import { randomBytes } from "node:crypto"
import { canonicalJson } from "../shared/canonical-json"
import type { Command } from "../shared/commands"
import { type Definition, type Feature, type Filters, type PatternEntry, type RuleOp, type Sizing, isEntryPattern } from "../shared/definition"
import { dollarWords } from "../shared/trigger-grammar"
import type { BotEntry } from "./bots-file"
import type { ToolOutcome } from "./candle-mcp"
import type { Mode } from "./classify"
import type { HaccAnswer } from "./hacc"
import type { Journal, JournalRow } from "./journal"
import type { SignalRow } from "./signal-stream"
import { botClient } from "./bot-trades"
import type { FaceClient } from "./tool-face"
import { TAPE_FRESH_MS, tapeToken } from "./trigger-watch"
import { short } from "./wallet-names"
import { type ChainSlug, chainName, storedChain } from "../shared/chains"

/** Each bot's cards are its own client's: one bot's open cards never count against another's. */
export { BOT_CLIENT_PREFIX } from "./bot-trades"
/** How long a token Candle can't price yet is waited for, from when its signal was heard. */
export const PRICE_WAIT_MS = 60_000
/** The oldest a signal may be when a bot decides on it, heard live or read back: older, it's skipped as heard too late. */
export const BOT_SIGNAL_FRESH_MS = 2 * 60_000
/** How often it's read again meanwhile. */
export const PRICE_RECHECK_MS = 15_000
/** A market read this fresh is used as it is. */
const MARKET_REUSE_MS = 4_500
/** Skips are gathered and journalled at most this often, per bot. */
export const SKIP_FLUSH_MS = 60_000
/** The signal ids a skip row keeps, for a restart not to decide them again. */
const SKIP_IDS_KEPT = 200
/** Tokens a skip row names. */
const SKIP_MINTS_KEPT = 20

export type SkipReason =
  | "already_open"
  | "max_concurrent"
  | "unpriceable"
  | "not_on_candle"
  | "no_budget"
  | "sizing_skip"
  | "sizing_zero"
  | "market_cap"
  | "tape_filter"
  | "tape_unread"
  | "paused"
  | "pace"
  | "route_failing"
  | "stale_signal"
  | "changed"
  | "wallet_chain"

/** What a bot enters as: its definition and run settings, to tell whether it changed while a candidate was checked. */
const runsAs = (b: BotEntry): string => canonicalJson({ definition: b.definition, agent: b.agent, wallet: b.wallet, mode: b.mode, maxSlippageBps: b.maxSlippageBps ?? null })

export interface Clock {
  now(): number
  schedule(run: () => void, ms: number): () => void
}

type Chain = ChainSlug
type Trade = Extract<Command, { kind: "trade" }>

export interface BotEntriesDeps {
  /** The bots that enter now (bots.ts `live`), and where each last went on. */
  bots: { live(): BotEntry[]; onSince(name: string): string | undefined; setLastSignal(name: string, signal: { id: number; at: string }): void }
  /** The bots' own positions (bot-book.ts). */
  positions: { holds(bot: string, mint: string, mode: "paper" | "live"): boolean; open(bot: string, mode?: "paper" | "live"): readonly unknown[] }
  journal: Pick<Journal, "append">
  clock: Clock
  /**
   * Candle's breaker, kept clear of (breaker.ts): a pair Candle's route breaker refuses, or the key's pace full. With
   * room, it takes the buy's slot. Unset, nothing is held.
   */
  breaker?: { entry(agent: string, mint: string, label: string): { code: "pace" | "route_failing"; words: string } | undefined }
  /** The Candle Harness's mode, for the journal's rows. */
  mode(): Mode
  /** Candle's market read for a token, not counted toward a key's limit; undefined when no key can make it. */
  market(chain: Chain, mint: string): Promise<ToolOutcome | undefined>
  /** A read of Hacc's, with the bot's agent's key. */
  hacc(agent: string, route: string, query: Record<string, string | number | undefined>): Promise<HaccAnswer>
  /**
   * What a live wallet holds, in dollars, of the asset a bot's buy of this token spends, as Candle's market answer
   * settles it (a Candle-launched token's own pair asset; else the configured spend asset on Solana, the native asset
   * elsewhere), from the last portfolio read; undefined where it isn't known.
   */
  spendable(agent: string, wallet: string, chain: Chain, market: { candleLaunched: boolean; quoteMint?: string }): { usd: number; asset: string } | undefined
  /** Candle's fee for the agent's key, in basis points. */
  feeBps(agent: string): number
  /**
   * The payer's words where a live bot's wallet is on another chain than the token (a bot on both chains paying from
   * a TEE wallet, which is on one); undefined where it pays there, or that isn't known yet.
   */
  wrongChain?(agent: string, wallet: string, chain: Chain): string | undefined
  /** The kill switch: its pause holds every bot's entries. */
  paused(): boolean
  /**
   * Sends the bot's buy as its own, in the bot's mode, through its wallet's figures: answers as `cards.propose`
   * does (with `instant` where it ran with no card), or `{ paper }` for a paper trade. A throw is a refusal at
   * proposal (the agent's limits, the pause, a held key), and nothing was sent.
   */
  send(trade: Trade, client: FaceClient, mode: "paper" | "live"): Promise<unknown>
  /** Why a card a bot proposed waits for the person, where its wallet's rule said. */
  card(cardId: string): { display: { cardBecause?: string; walletLabel?: string } } | undefined
  /** A token's name for words, where the core knows one. */
  nameOf(mint: string): string | undefined
  /** The bots' tape is wanted or not any more: the stream opens or closes. */
  needsChanged?(): void
}

/** An entry under way: from its `bot.entering` row until its buy fills, or ends with nothing bought. */
interface Pending {
  entryId: string
  bot: string
  agent: string
  mint: string
  mode: "paper" | "live"
  signalId: number
  usd: number
  wallet: string
  /** The token's chain: what's committed is counted per chain, since one wallet word pays on each. */
  chain: Chain
  cardId?: string
  opId?: string
  approved?: boolean
}

type EndOutcome = "refused" | "rejected" | "withdrawn" | "expired" | "failed" | "lost"

interface SkipGroup {
  agent: string
  count: number
  signals: number[]
  mints: string[]
  words: string
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)
/** A signal's chain as Hacc says it, else its mint's family's. */
const chainOf = (mint: string, said?: unknown): Chain => storedChain(said, mint) ?? "solana"
const iso = (ms: number) => new Date(ms).toISOString()
const cents = (usd: number) => (Math.round(usd * 100) / 100).toFixed(2)
/** Why a signal too old to buy on is skipped. */
const staleWords = (ageMs: number) => `heard too late: the signal was ${Math.max(2, Math.round(ageMs / 60_000))} minutes old`
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
/** Signals by when they happened, then by Hacc's id: the order the replay takes a token's first signal in. */
const byTape = (a: SignalRow, b: SignalRow) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id

const ET_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" })
/** The hour a time falls in, US Eastern. */
export const easternHour = (ms: number): number => Number(ET_HOUR.format(new Date(ms))) % 24

/** The token a tape row is about, and its chain; undefined for a row whose address doesn't fit the chain Hacc says. */
export const rowToken = (row: SignalRow): { mint: string; chain: Chain } | undefined => tapeToken(row)

/**
 * Whether a tape row is one of a definition's candidates: its pattern and chain, and every filter the row itself
 * carries. Filters that need a read (the market-cap band, age, venues) are checked after, on the candidates.
 */
export function rowMatches(d: Definition, row: SignalRow): boolean {
  if (!isEntryPattern(d.entry)) return false
  const entry = d.entry as PatternEntry
  if (row.pattern !== entry.pattern) return false
  const token = rowToken(row)
  if (!token || (d.chain !== "any" && token.chain !== d.chain)) return false
  const f: Filters = entry.filters ?? {}
  const groups = Array.isArray(row.wallet_groups) ? row.wallet_groups.filter((g): g is string => typeof g === "string") : []
  if (f.groups?.length && !f.groups.some((g) => groups.includes(g))) return false
  if (f.groups_all?.length && !f.groups_all.every((g) => groups.includes(g))) return false
  if (f.wallet_ids?.length && !(typeof row.wallet_id === "number" && f.wallet_ids.includes(row.wallet_id))) return false
  const payload = record(row.payload)
  if (f.direction !== undefined && payload?.direction !== f.direction) return false
  if (f.min_usd !== undefined) {
    // Hacc sends the size as a decimal string; a row with none doesn't pass a floor.
    const usd = Number(payload?.usd_value)
    if (payload?.usd_value === null || payload?.usd_value === undefined || !Number.isFinite(usd) || usd < f.min_usd) return false
  }
  if (f.hours_et) {
    const [start, end] = f.hours_et
    // Both ends are hours Hacc takes (0 to 23, start no later than end), so [9, 9] is the hour from 9: the end is in.
    const h = easternHour(Date.parse(row.created_at))
    if (h < start || h > end) return false
  }
  return true
}

const RULE_TEST: Record<RuleOp, (v: number, n: number) => boolean> = { lt: (v, n) => v < n, lte: (v, n) => v <= n, gt: (v, n) => v > n, gte: (v, n) => v >= n }

/**
 * A trade's stake from the definition's sizing, as Hacc's replay pays it: `base_usd` where it's given, else
 * `usd_per_trade`; each rule that holds multiplies the multiple (`mult`), adds to it (`add`) or skips the trade,
 * in order; `max_usd` caps it. A rule on a feature not given doesn't hold (only the market cap at entry runs live).
 */
export function stakeOf(s: Sizing, features: Partial<Record<Feature, number>>): { usd: number; applied: string[] } | { skip: true; rule: string } {
  let multiple = 1
  const applied: string[] = []
  for (const rule of s.rules ?? []) {
    const holds = Object.entries(rule.when).every(([feature, bounds]) => {
      const v = features[feature as Feature]
      return v !== undefined && Object.entries(bounds ?? {}).every(([op, n]) => RULE_TEST[op as RuleOp](v, n as number))
    })
    if (!holds) continue
    const name = Object.entries(rule.when)
      .flatMap(([feature, bounds]) => Object.entries(bounds ?? {}).map(([op, n]) => `${feature} ${op} ${n}`))
      .join(", ")
    if (rule.skip) return { skip: true, rule: name }
    if (rule.mult !== undefined) multiple *= rule.mult
    if (rule.add !== undefined) multiple += rule.add
    applied.push(name)
  }
  const usd = (s.base_usd ?? s.usd_per_trade) * multiple
  return { usd: s.max_usd !== undefined ? Math.min(usd, s.max_usd) : usd, applied }
}

export class BotEntries {
  /** Signals decided, by bot: entered or skipped. Each is decided once, a restart included. */
  private readonly decided = new Map<string, Map<number, number>>()
  private readonly pending = new Map<string, Pending>()
  /** Bot and token being checked now: a second signal on it meanwhile is the same entry's. It holds no slot. */
  private readonly checking = new Set<string>()
  /** Bot and token past every check, taking a slot until its `bot.entering` row makes it an entry under way. */
  private readonly claimed = new Set<string>()
  /** The journal's rows at start are being read: an end they show is already journalled, and isn't again. */
  private rebuilding = false
  /** Ends found while reading the journal at start, journalled after it unless a later row there already ended them. */
  private readonly endsFound = new Map<string, { p: Pending; outcome: EndOutcome; words: string; code?: string }>()
  private readonly markets = new Map<string, { at: number; priceUsd: number | null; marketCap: number | null; candleLaunched: boolean; quoteMint?: string }>()
  private readonly skips = new Map<string, Map<SkipReason, SkipGroup>>()
  private flushTimer: (() => void) | undefined
  private readonly waits = new Set<() => void>()
  private stopped = false
  private wanted = false

  constructor(private readonly deps: BotEntriesDeps) {}

  /**
   * The journal's rows, oldest first, at start: the signals each bot decided (within the 10 minutes a signal
   * stays fresh) and its entries still under way. A `bot.entering` that never reached a card or a paper trade was
   * stopped with the core, and is ended now in words.
   */
  async rebuild(rows: readonly JournalRow[]): Promise<void> {
    const since = this.deps.clock.now() - TAPE_FRESH_MS - PRICE_WAIT_MS
    this.rebuilding = true
    try {
      for (const row of rows) {
        const name = typeof row.name === "string" ? row.name : undefined
        if (row.type === "bot.skipped" && name && Array.isArray(row.signals) && Date.parse(row.at) >= since) {
          for (const id of row.signals) if (typeof id === "number") this.decide(name, id, Date.parse(row.at))
        }
        this.note(row)
      }
    } finally {
      this.rebuilding = false
    }
    // An end the journal shows (a card expired, an operation failed) with no `bot.entry_ended` after it: the core
    // stopped before it said so, and it's said now, once.
    const found = [...this.endsFound.values()]
    this.endsFound.clear()
    for (const f of found) if (this.pending.get(f.p.entryId) === f.p) await this.ended(f.p, f.outcome, f.words, f.code)
    for (const p of [...this.pending.values()]) {
      if (p.cardId || p.opId) continue
      await this.ended(p, "lost", "the core stopped before its buy was sent, so nothing was bought")
    }
  }

  /** Whether any bot that enters now needs the tape: the bots' stream is held open while one does. */
  needsTape(): boolean {
    return this.deps.bots.live().length > 0
  }

  /** The bots changed (saved, paused, held): the stream opens or closes with them. */
  refresh(): void {
    const wanted = this.needsTape()
    if (wanted !== this.wanted) {
      this.wanted = wanted
      this.deps.needsChanged?.()
    }
  }

  stop(): void {
    this.stopped = true
    for (const cancel of this.waits) cancel()
    this.waits.clear()
    this.flushTimer?.()
    this.flushTimer = undefined
  }

  /** Entries under way, for the tests and the topic. */
  under(bot?: string): Pending[] {
    return [...this.pending.values()].filter((p) => bot === undefined || p.bot === bot)
  }

  /**
   * A journal row, as it's appended: a bot's entry links to its card and operation, and ends when its buy fills or
   * can't (a card rejected, withdrawn or expired, an operation that failed or was refused).
   */
  note(row: JournalRow): void {
    if (row.type === "bot.entering" && typeof row.entryId === "string" && typeof row.name === "string" && typeof row.mint === "string" && typeof row.signalId === "number") {
      this.decide(row.name, row.signalId, Date.parse(row.at))
      this.pending.set(row.entryId, {
        entryId: row.entryId,
        bot: row.name,
        agent: String(row.agent ?? ""),
        mint: row.mint,
        mode: row.botMode === "paper" ? "paper" : "live",
        signalId: row.signalId,
        usd: typeof row.usd === "number" ? row.usd : 0,
        wallet: typeof row.wallet === "string" ? row.wallet : "embedded",
        chain: chainOf(row.mint, row.chain),
      })
      return
    }
    if (row.type === "bot.entry_ended" && typeof row.entryId === "string") {
      this.pending.delete(row.entryId)
      this.endsFound.delete(row.entryId)
      return
    }
    if (typeof row.bot !== "string" || row.botAct !== "entry") {
      this.settle(row)
      return
    }
    const p = this.pendingFor(row.bot, row.botSignal)
    if (!p) return
    if (row.type === "card.created") {
      p.cardId = typeof row.cardId === "string" ? row.cardId : undefined
      p.opId = typeof row.opId === "string" ? row.opId : undefined
    } else if (row.type === "card.approved") {
      p.approved = true
    } else if (row.type === "card.rejected" || row.type === "card.withdrawn" || row.type === "card.expired") {
      // An approved card that then expires never happens; one that does has its operation's outcome to come.
      if (!p.approved) void this.ended(p, row.type.slice(5) as "rejected" | "withdrawn" | "expired", this.cardEndWords(row)).catch(() => {})
    } else if (row.type === "paper.call") {
      // A paper buy is done in one call: what it filled is the book's, from this same row.
      this.pending.delete(p.entryId)
    }
  }

  /** An operation's outcome: a bot's entry ends with it, filled or not. */
  private settle(row: JournalRow): void {
    if (!row.type.startsWith("operation.") || typeof row.opId !== "string") return
    const p = [...this.pending.values()].find((x) => x.opId === row.opId)
    if (!p) return
    if (row.type === "operation.succeeded") this.pending.delete(p.entryId)
    else if (row.type === "operation.failed" || row.type === "operation.refused" || row.type === "operation.abandoned") {
      const why = record(row.error)?.message
      void this.ended(p, "failed", `its buy ${row.type === "operation.abandoned" ? "was abandoned" : "didn't go through"}${typeof why === "string" ? `: ${why}` : ""}`).catch(() => {})
    }
  }

  private cardEndWords(row: JournalRow): string {
    if (row.type === "card.expired") return row.reason === "core_restarted" ? "its card was open when the core stopped, so nothing was bought" : "nobody pressed its card in time, so nothing was bought"
    if (row.type === "card.rejected") return "you rejected its card, so nothing was bought"
    if (row.reason === "bot_changed") return "its card was withdrawn when a change to the bot was approved, so nothing was bought"
    return "its card was withdrawn, so nothing was bought"
  }

  private pendingFor(bot: string, signal: unknown): Pending | undefined {
    if (typeof signal !== "number") return undefined
    return [...this.pending.values()].find((p) => p.bot === bot && p.signalId === signal)
  }

  private async ended(p: Pending, outcome: EndOutcome, words: string, code?: string): Promise<void> {
    if (this.rebuilding) {
      // Its `bot.entry_ended` row, if the journal has one, comes later in the rows being read.
      if (this.pending.get(p.entryId) === p) this.endsFound.set(p.entryId, { p, outcome, words, ...(code ? { code } : {}) })
      return
    }
    if (!this.pending.delete(p.entryId)) return
    await this.deps.journal.append({
      type: "bot.entry_ended",
      mode: this.deps.mode(),
      agent: p.agent,
      name: p.bot,
      entryId: p.entryId,
      signalId: p.signalId,
      mint: p.mint,
      botMode: p.mode,
      outcome,
      ...(code ? { code } : {}),
      words: `${this.nameOf(p.mint)}: ${words}`,
    })
  }

  private decide(bot: string, signal: number, at: number): void {
    let m = this.decided.get(bot)
    if (!m) this.decided.set(bot, (m = new Map()))
    m.set(signal, at)
    // A signal older than the freshness window is never acted on, so its id needn't be kept.
    if (m.size > 5_000) {
      const floor = this.deps.clock.now() - TAPE_FRESH_MS - PRICE_WAIT_MS
      for (const [id, when] of m) if (when < floor) m.delete(id)
    }
  }

  private isDecided(bot: string, signal: number): boolean {
    return this.decided.get(bot)?.has(signal) ?? false
  }

  /** New rows from the bots' stream: each bot that enters now checks them, in the tape's order. */
  async onTape(rows: readonly SignalRow[]): Promise<void> {
    if (this.stopped || !rows.length) return
    const bots = this.deps.bots.live()
    if (!bots.length) return
    const now = this.deps.clock.now()
    const sorted = [...rows].sort(byTape)
    const work: Promise<void>[] = []
    for (const bot of bots) {
      const since = Date.parse(this.deps.bots.onSince(bot.name) ?? iso(now))
      for (const row of sorted) {
        const at = Date.parse(row.created_at)
        if (!(at >= since) || now - at > TAPE_FRESH_MS) continue
        if (!rowMatches(bot.definition, row)) continue
        if (this.isDecided(bot.name, row.id)) continue
        const token = rowToken(row)!
        // Decided here, before anything awaits: the same signal heard twice (a reopen's refill) is one.
        this.decide(bot.name, row.id, now)
        this.deps.bots.setLastSignal(bot.name, { id: row.id, at: row.created_at })
        if (now - at > BOT_SIGNAL_FRESH_MS) {
          this.skip(bot, row, token.mint, "stale_signal", staleWords(now - at))
          continue
        }
        if (this.deps.paused()) {
          this.skip(bot, row, token.mint, "paused", "the kill switch holds every bot's entries")
          continue
        }
        // Its wallet pays on one chain: a signal on the other is never a buy it can make. On paper, either chain's.
        const wrong = bot.mode === "live" ? this.deps.wrongChain?.(bot.agent, bot.wallet, token.chain) : undefined
        if (wrong) {
          this.skip(bot, row, token.mint, "wallet_chain", wrong)
          continue
        }
        const reason = this.slotCheck(bot, token.mint)
        if (reason) {
          this.skip(bot, row, token.mint, reason.code, reason.words)
          continue
        }
        const key = `${bot.name}\n${token.mint}`
        this.checking.add(key)
        work.push(
          this.candidate(bot, row, token, now)
            .catch(() => {})
            .finally(() => this.checking.delete(key)),
        )
      }
    }
    await Promise.all(work)
  }

  /**
   * Whether the bot can take another position in the token now: not held, not being entered, a slot free. A slot is
   * taken by an open position, an entry under way, or a candidate that passed and is about to be journalled; one
   * still being checked takes none, so a candidate that then fails its checks never cost another signal its slot.
   * `own` is the candidate's own re-check, before its entry: its own check of the token isn't another's.
   */
  private slotCheck(bot: BotEntry, mint: string, own = false): { code: SkipReason; words: string } | undefined {
    const name = this.nameOf(mint)
    const key = `${bot.name}\n${mint}`
    if (this.deps.positions.holds(bot.name, mint, bot.mode)) return { code: "already_open", words: `it holds ${name} already` }
    if ((!own && this.checking.has(key)) || this.claimed.has(key) || this.under(bot.name).some((p) => sameAddress(p.mint, mint))) return { code: "already_open", words: `an earlier signal on ${name} is being entered` }
    const max = bot.definition.sizing.max_concurrent
    const taken = this.deps.positions.open(bot.name, bot.mode).length + this.under(bot.name).length + [...this.claimed].filter((k) => k.startsWith(`${bot.name}\n`)).length
    if (taken >= max) return { code: "max_concurrent", words: `all ${max} of its slots are taken` }
    return undefined
  }

  /** A candidate past the row's own filters: the reads, the sizing and the balance, then the entry. */
  private async candidate(bot: BotEntry, row: SignalRow, token: { mint: string; chain: Chain }, heardAt: number): Promise<void> {
    const f: Filters = (bot.definition.entry as PatternEntry).filters ?? {}
    const name = () => this.nameOf(token.mint)
    // Candle's price first: no price, no route, and a token Hacc's replay can't enter either.
    let reading = await this.read(token)
    while (!this.stopped && reading?.priceUsd == null && this.deps.clock.now() - heardAt + PRICE_RECHECK_MS <= PRICE_WAIT_MS) {
      await this.wait(PRICE_RECHECK_MS)
      reading = await this.read(token, true)
    }
    if (this.stopped) return
    if (reading?.notListed) return this.skip(bot, row, token.mint, "not_on_candle", `Candle doesn't list ${name()} on ${chainName(token.chain)}, so it can't be bought`)
    if (reading?.priceUsd == null) return this.skip(bot, row, token.mint, "unpriceable", `Candle had no price for ${name()} within a minute of its signal`)
    // Bots may have changed while it waited: a paused or removed bot enters nothing.
    const now = this.deps.bots.live().find((b) => b.name === bot.name)
    if (!now) return
    if (f.min_mcap_usd !== undefined || f.max_mcap_usd !== undefined) {
      const mc = reading.marketCap
      if (mc === null) return this.skip(bot, row, token.mint, "market_cap", `Candle doesn't know ${name()}'s market cap, so its market-cap filter can't pass`)
      if (f.max_mcap_usd !== undefined && !(mc < f.max_mcap_usd)) return this.skip(bot, row, token.mint, "market_cap", `${name()}'s market cap was ${dollarWords(Math.round(mc))}, over its ${dollarWords(f.max_mcap_usd)}`)
      if (f.min_mcap_usd !== undefined && !(mc > f.min_mcap_usd)) return this.skip(bot, row, token.mint, "market_cap", `${name()}'s market cap was ${dollarWords(Math.round(mc))}, under its ${dollarWords(f.min_mcap_usd)}`)
    }
    if (f.min_age_minutes !== undefined || f.max_age_minutes !== undefined || f.venues?.length || f.exclude_venues?.length) {
      const passes = await this.tapeFilter(bot, row, token, f)
      if (passes !== true) return this.skip(bot, row, token.mint, passes === false ? "tape_filter" : "tape_unread", passes === false ? `Hacc's tape says ${name()} is outside its ${this.tapeFilterWords(f)}` : `Hacc's tape couldn't be read for its ${this.tapeFilterWords(f)}: ${passes.why}`)
    }
    const sized = stakeOf(bot.definition.sizing, reading.marketCap !== null ? { mcap_at_entry: reading.marketCap } : {})
    if ("skip" in sized) return this.skip(bot, row, token.mint, "sizing_skip", `a sizing rule skips it (${sized.rule})`)
    const usd = Math.round(sized.usd * 100) / 100
    if (!(usd >= 0.01)) return this.skip(bot, row, token.mint, "sizing_zero", "its sizing gives no stake")
    if (this.deps.paused()) return this.skip(bot, row, token.mint, "paused", "the kill switch holds every bot's entries")
    const age = this.deps.clock.now() - Date.parse(row.created_at)
    if (age > BOT_SIGNAL_FRESH_MS) return this.skip(bot, row, token.mint, "stale_signal", staleWords(age))
    if (bot.mode === "live") {
      // The asset the buy spends, on the token's own chain: ETH from a Hood wallet, never the SOL beside it.
      const held = this.deps.spendable(bot.agent, bot.wallet, token.chain, { candleLaunched: reading.candleLaunched, ...(reading.quoteMint !== undefined ? { quoteMint: reading.quoteMint } : {}) })
      const needed = usd * (1 + this.deps.feeBps(bot.agent) / 10_000)
      // Entries under way from the same wallet on the same chain: the portfolio read may not show what they spend yet.
      const committed = this.under().filter((p) => p.mode === "live" && p.wallet === bot.wallet && p.chain === token.chain).reduce((sum, p) => sum + p.usd, 0)
      if (held !== undefined && held.usd - committed < needed) return this.skip(bot, row, token.mint, "no_budget", `the wallet holds $${cents(Math.max(0, held.usd - committed))} of ${held.asset}${committed ? " not already committed to its entries" : ""}, short of the $${cents(needed)} stake with Candle's fee`)
    }
    // The bot as it is now, with nothing awaited from here to its entry: one paused, stopped or removed while its reads
    // were out enters nothing, and one changed meanwhile isn't entered at the stake, filters or bound it had before.
    const latest = this.deps.bots.live().find((b) => b.name === bot.name)
    if (!latest) return
    if (runsAs(latest) !== runsAs(bot)) return this.skip(bot, row, token.mint, "changed", "the bot changed while this signal was being checked")
    // A slot taken while it waited: checked again, without counting this candidate's own check.
    const key = `${bot.name}\n${token.mint}`
    const again = this.slotCheck(bot, token.mint, true)
    if (again) return this.skip(bot, row, token.mint, again.code, again.words)
    // Candle's breaker last, with nothing awaited before the buy is proposed: the slot it takes is this buy's.
    const breaker = this.deps.breaker?.entry(bot.agent, token.mint, name())
    if (breaker) return this.skip(bot, row, token.mint, breaker.code, breaker.words)
    // Its slot, from here: nothing awaited since the re-check, so no other candidate can take the same one.
    this.claimed.add(key)
    try {
      await this.enter(bot, row, token, usd, sized.applied, () => this.claimed.delete(key))
    } finally {
      this.claimed.delete(key)
    }
  }

  /** Hacc's filtered tape for this one signal: whether it holds it under the age and venue filters. */
  private async tapeFilter(bot: BotEntry, row: SignalRow, token: { mint: string; chain: Chain }, f: Filters): Promise<boolean | { why: string }> {
    const answer = await this.deps.hacc(bot.agent, "/v1/signals", {
      asset: token.mint,
      pattern: String(row.pattern),
      since: iso(Date.parse(row.created_at) - 1),
      limit: 20,
      quality: "all",
      ...(f.min_age_minutes !== undefined ? { min_age_minutes: Math.round(f.min_age_minutes) } : {}),
      ...(f.max_age_minutes !== undefined ? { max_age_minutes: Math.round(f.max_age_minutes) } : {}),
      ...(f.venues?.length ? { venues: f.venues.join(",") } : {}),
      ...(f.exclude_venues?.length ? { exclude_venues: f.exclude_venues.join(",") } : {}),
      ...(token.chain === "hood" ? { chain: "hood" } : {}),
    })
    if (answer.kind !== "ok") return { why: answer.message }
    const signals = record(answer.body)?.signals
    if (!Array.isArray(signals)) return { why: "its answer had no signals" }
    return signals.some((s) => record(s)?.id === row.id)
  }

  private tapeFilterWords(f: Filters): string {
    const age = f.min_age_minutes !== undefined || f.max_age_minutes !== undefined
    const venue = (f.venues?.length ?? 0) > 0 || (f.exclude_venues?.length ?? 0) > 0
    return age && venue ? "age and venue filters" : age ? "age filter" : "venue filter"
  }

  /** Journals the decision, then proposes the buy as the bot's own. */
  private async enter(bot: BotEntry, row: SignalRow, token: { mint: string; chain: Chain }, usd: number, applied: string[], entered: () => void): Promise<void> {
    const entryId = `entry_${randomBytes(9).toString("base64url")}`
    const name = this.nameOf(token.mint)
    const signalAt = Date.parse(row.created_at)
    const entering = await this.deps.journal.append({
      type: "bot.entering",
      mode: this.deps.mode(),
      agent: bot.agent,
      name: bot.name,
      entryId,
      signalId: row.id,
      signalAt: row.created_at,
      pattern: String(row.pattern),
      mint: token.mint,
      chain: token.chain,
      usd,
      wallet: bot.wallet,
      botMode: bot.mode,
      ...(applied.length ? { sizing: applied } : {}),
      words: `buys $${cents(usd)} of ${name} on a ${String(row.pattern).replace(/_/g, " ")} signal at ${hhmm(signalAt)}${bot.mode === "paper" ? ", on paper" : ""}`,
    })
    // The core hands every row to `note` as it's appended; noted here too, for a journal nobody listens to.
    if (!this.pending.has(entryId)) this.note(entering)
    // An entry under way now, which holds the slot itself.
    entered()
    const pending = this.pending.get(entryId)
    const trade: Trade = {
      kind: "trade",
      tool: "candle_trade",
      args: { mint: token.mint, side: "buy", amountUsd: cents(usd), ...(bot.mode === "live" ? { wallet: bot.wallet } : {}), ...(bot.maxSlippageBps !== undefined ? { maxSlippageBps: bot.maxSlippageBps } : {}) },
      echo: `buy $${cents(usd)} ${name}`,
    }
    const client = botClient({ name: bot.name, agent: bot.agent, mode: bot.mode, ...(bot.maxSlippageBps !== undefined ? { slippageBps: bot.maxSlippageBps } : {}) }, { act: "entry", signal: row.id })
    let answer: unknown
    try {
      answer = await this.deps.send(trade, client, bot.mode)
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | undefined
      const code = typeof e?.data?.code === "string" ? e.data.code : typeof e?.code === "string" ? e.code : undefined
      if (pending) await this.ended(pending, "refused", `its buy was refused: ${typeof e?.message === "string" ? e.message : "the core refused it"}`, code)
      return
    }
    const a = record(answer)
    if (a && "paper" in a) {
      // A paper trade's own row ended it when it filled; one Candle refused ends here.
      const result = record(a.paper)
      if (result?.isError === true && pending) {
        // Why, in the refusal's own words: a token Candle doesn't know said only "didn't go through".
        let why: string | undefined
        try {
          const m = record(record(JSON.parse(String(record((result.content as unknown[] | undefined)?.[0])?.text ?? "")))?.error)?.message
          if (typeof m === "string" && m) why = m.replace(/[.\s]+$/, "")
        } catch {}
        await this.ended(pending, "failed", `its paper buy didn't go through${why ? `: ${why}` : ""}`)
      }
      else this.pending.delete(entryId)
      return
    }
    if (typeof a?.cardId === "string" && a.state === "awaiting_approval" && a.instant === undefined && pending) {
      const card = this.deps.card(a.cardId)
      const because = card?.display.cardBecause ?? `${card?.display.walletLabel && card.display.walletLabel !== "embedded" ? card.display.walletLabel : "the embedded wallet"} asks every time`
      await this.deps.journal.append({
        type: "bot.waiting",
        mode: this.deps.mode(),
        agent: bot.agent,
        name: bot.name,
        entryId,
        signalId: row.id,
        mint: token.mint,
        cardId: a.cardId,
        because,
        words: `its buy of $${cents(usd)} of ${name} waits for you: ${because}`,
      })
    }
  }

  /**
   * Candle's market read for a token: price and market cap, or none. A token Candle answers it has no market for
   * (MARKET_NOT_FOUND: not indexed on that chain) is said as not listed, never kept, so a later read can find it.
   */
  private async read(token: { mint: string; chain: Chain }, fresh = false): Promise<{ priceUsd: number | null; marketCap: number | null; candleLaunched: boolean; quoteMint?: string; notListed?: true } | undefined> {
    const held = this.markets.get(token.mint)
    const now = this.deps.clock.now()
    if (held && !fresh && now - held.at < MARKET_REUSE_MS) return held
    const outcome = await this.deps.market(token.chain, token.mint).catch(() => undefined)
    if (outcome?.kind === "error" && outcome.code === "MARKET_NOT_FOUND") return { priceUsd: null, marketCap: null, candleLaunched: false, notListed: true }
    if (outcome?.kind !== "ok") return undefined
    const market = record(record(outcome.result)?.market)
    // An EVM address is one address in any letter case.
    if (!market || typeof market.mint !== "string" || !sameAddress(market.mint, token.mint)) return undefined
    const r = {
      at: this.deps.clock.now(),
      priceUsd: positive(market.priceUsd),
      marketCap: positive(market.marketCap),
      // What its buy spends: a Candle-launched token's own pair asset.
      candleLaunched: market.candleLaunched === true,
      ...(typeof market.quoteMint === "string" ? { quoteMint: market.quoteMint } : {}),
    }
    if (this.markets.size > 2_000) this.markets.clear()
    this.markets.set(token.mint, r)
    return r
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.deps.clock.schedule(() => {
        this.waits.delete(done)
        resolve()
      }, ms)
      const done = () => {
        cancel()
        resolve()
      }
      this.waits.add(done)
    })
  }

  /** A skip, gathered with the bot's others of the same reason and journalled within a minute. */
  private skip(bot: BotEntry, row: SignalRow, mint: string, reason: SkipReason, words: string): void {
    let byReason = this.skips.get(bot.name)
    if (!byReason) this.skips.set(bot.name, (byReason = new Map()))
    const g = byReason.get(reason) ?? { agent: bot.agent, count: 0, signals: [], mints: [], words }
    g.count++
    g.words = words
    if (g.signals.length < SKIP_IDS_KEPT) g.signals.push(row.id)
    if (!g.mints.includes(mint) && g.mints.length < SKIP_MINTS_KEPT) g.mints.push(mint)
    byReason.set(reason, g)
    if (!this.flushTimer && !this.stopped) {
      this.flushTimer = this.deps.clock.schedule(() => {
        this.flushTimer = undefined
        void this.flush().catch(() => {})
      }, SKIP_FLUSH_MS)
    }
  }

  /** Journals the skips gathered: one row per bot and reason. Public for tests, and for the core's stop, before its journal closes. */
  async flush(): Promise<void> {
    const all = [...this.skips]
    this.skips.clear()
    for (const [name, byReason] of all) {
      for (const [reason, g] of byReason) {
        await this.deps.journal.append({
          type: "bot.skipped",
          mode: this.deps.mode(),
          agent: g.agent,
          name,
          reason,
          count: g.count,
          signals: g.signals,
          mints: g.mints,
          words: g.count === 1 ? g.words : `${g.count} signals, the last because ${g.words}`,
        })
      }
    }
  }

  private nameOf(mint: string): string {
    return this.deps.nameOf(mint) ?? short(mint)
  }
}
