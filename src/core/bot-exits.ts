// Bots' exits: each open position checked against its exits after every heartbeat, in the core, view or no view,
// and sold as the bot's own. A rules bot's exits are its definition's; a code bot's are those it asked the core to
// hold on a position (held-exits.ts), which run while the bot is paused, crashed or not connected, and through the
// kill switch.
//
// - Prices are Candle's market read, the price a sell fills against, read by the triggers' watcher with each bot's
//   open positions as sells' tokens (trigger-watch.ts): about every 5 s, at most 20 tokens a heartbeat, sells first.
// - Each exit as Hacc's replays read: a take profit at its threshold over the entry, a stop at its threshold under
//   it, a max hold from the entry's fill, and a trailing stop armed once the price has reached `arm_multiple` × the
//   entry, then selling on a fall of `drop_pct` from the highest since. The entry is what the position cost per
//   token, Candle's fee in it; where its buy's answer didn't say what it received (a buy read back by its id), it's
//   Candle's first price after the fill, said so. Several at once say the stop first, then the take profit, the
//   trailing stop, the hold.
// - What it decided is journalled before anything is proposed (`bot.exiting`, with why), so a core that stops mid-exit
//   knows the sell may have been sent: one that reached Candle is read back by its operation, never sold again; one
//   that never reached a card is ended in words, and checked again.
// - The sell is the bot's own (bot-book.ts `sellPlan`): never more than its book holds, by amount where the route
//   takes one, else the whole percent of the wallet its own is. It runs with no card on any wallet, a wallet that
//   asks every time included: the person approved its exits with the bot (cards.ts `exitCheck`).
// - A price is only one Candle read after the position's fill: a read from before it (the entry's own check of the
//   token) is the price before the bot's own buy moved it. A position Candle has had no price for in a minute is
//   said once, with its exits that need a price unjudged until one comes back; its max hold still sells.
// - A sell that failed or was refused is tried again with a fresh id: the exit it decided holds until it sells, even
//   if the price moves back meanwhile, as a stop order does. After two failed sells of a token in a row on the key,
//   anyone's, the next waits and says why (failed-sells.ts): a third would stop the key on Candle, sells included.
// - After a sleep, or as the core starts, every position is checked at once against a fresh read: a stop crossed or a
//   hold run out meanwhile sells now, and says so.
import { randomBytes } from "node:crypto"
import type { Command } from "../shared/commands"
import type { Definition, Exit } from "../shared/definition"
import { durationWords } from "../shared/trigger-grammar"
import type { BotPosition, BotPositions } from "./bot-book"
import type { BotEntry } from "./bots-file"
import type { Holding } from "./cards"
import type { Mode } from "./classify"
import type { FailedSells } from "./failed-sells"
import type { Journal, JournalRow } from "./journal"
import type { FaceClient } from "./tool-face"
import { botClient } from "./bot-trades"
import { priceWords, type Reading } from "./trigger-watch"
import { short } from "./wallet-names"
import { type ChainSlug, storedChain } from "../shared/chains"

/** Why a position's exit is sent again after a sell that didn't go through. */
const SELLS_AGAIN = "; its last sell didn't go through, so it sells again"

/** A reading older than this isn't a price to exit on. */
export const READING_FRESH_MS = 30_000
/**
 * A reading this soon after the position's fill isn't one of its prices: a read under way as the buy filled answers
 * with the price before it, which the bot's own buy moved.
 */
export const READ_AFTER_FILL_MS = 1_000
/** With no price from Candle this long after the fill or its last price, the position's exits are said to wait for one. */
export const UNPRICED_SAY_MS = 60_000
/** After a sell the core refused before it reached Candle (a held key, the agent's limits), it's tried again this much later. */
export const REFUSED_RETRY_MS = 60_000
/** A wallet that reads as holding none of a position is read again this much later before the position is given up. */
export const EMPTY_RECHECK_MS = 60_000

export type ExitCode = "stop_loss" | "take_profit" | "trailing_stop" | "max_hold" | "flatten"
/** Each exit's why, short, as a trigger on the bot says it: "sold MOON (at its stop)". */
export const EXIT_WORDS: Readonly<Record<string, string>> = { stop_loss: "at its stop", take_profit: "at its take profit", trailing_stop: "on its trailing stop", max_hold: "at the end of its hold", flatten: "flattened" }
export interface ExitReason {
  code: ExitCode
  words: string
}

type Trade = Extract<Command, { kind: "trade" }>
type Chain = ChainSlug

/** Why a position exits now, or undefined: Hacc's order of the stop, the take profit, the trailing stop, the hold. */
export function exitReason(x: Exit | undefined, s: { label: string; entryUsd?: number; entryIsMark?: boolean; peakUsd?: number; priceUsd?: number | null; entryAt: number; now: number }): ExitReason | undefined {
  if (!x) return undefined
  const { entryUsd: entry, priceUsd: price, label } = s
  const its = () => (s.entryIsMark ? `Candle's ${priceWords(entry!)} price when it entered` : `its ${priceWords(entry!)} entry`)
  const priced = entry !== undefined && entry > 0 && typeof price === "number" && price > 0
  const pct = (v: number) => pctWords(Math.abs(v / entry! - 1) * 100)
  if (priced && x.stop_loss_pct !== undefined && price <= entry * (1 - x.stop_loss_pct / 100)) {
    return { code: "stop_loss", words: `a stop at -${x.stop_loss_pct}%: ${label} was ${priceWords(price)}, ${pct(price)}% under ${its()}` }
  }
  if (priced && x.take_profit_pct !== undefined && price >= entry * (1 + x.take_profit_pct / 100)) {
    return { code: "take_profit", words: `a take profit at +${x.take_profit_pct}%: ${label} was ${priceWords(price)}, ${pct(price)}% over ${its()}` }
  }
  if (priced && x.trailing) {
    const peak = Math.max(s.peakUsd ?? 0, price)
    if (peak >= entry * x.trailing.arm_multiple && price <= peak * (1 - x.trailing.drop_pct / 100)) {
      const multiple = Math.round((peak / entry) * 10) / 10
      return { code: "trailing_stop", words: `a trailing stop: ${label} rose to ${priceWords(peak)}, ${multiple}× its entry, then fell ${pctWords((1 - price / peak) * 100)}% to ${priceWords(price)}` }
    }
  }
  if (x.max_hold_hours !== undefined && s.now - s.entryAt >= x.max_hold_hours * 3_600_000) {
    const h = x.max_hold_hours
    return { code: "max_hold", words: Number.isInteger(h) ? `its ${h}-hour hold ran out` : `its max hold of ${durationWords(h * 3_600_000)} ran out` }
  }
  return undefined
}

/** A position's price now: a fresh reading, read at least a moment after its fill. Else null: no price to exit on. */
export function positionPrice(reading: Reading | undefined, filledAt: number, now: number): number | null {
  if (!reading || reading.priceUsd === null) return null
  if (now - reading.at > READING_FRESH_MS || reading.at < filledAt + READ_AFTER_FILL_MS) return null
  return reading.priceUsd
}

/** Whether an exit needs a price: all but a max hold do. */
const needsPrice = (x: Exit): boolean => x.stop_loss_pct !== undefined || x.take_profit_pct !== undefined || x.trailing !== undefined

const hm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** Why a position's exits that need a price wait: Candle has given none since then. */
const unpricedWords = (x: Exit, since: number): string =>
  `no price on Candle since ${hm(since)}, so its ${[x.stop_loss_pct !== undefined ? "stop" : "", x.take_profit_pct !== undefined ? "take profit" : "", x.trailing ? "trailing stop" : ""].filter(Boolean).join(" and ").replace(/ and (?=.* and )/, ", ")} can't be judged until one comes back${x.max_hold_hours !== undefined ? "; its max hold still sells" : ""}`

/** A percent in words: one decimal under 10, so +0.53% reads 0.5, not 1; whole above. */
export const pctWords = (v: number): string => {
  const a = Math.abs(v)
  return a < 10 ? String(Math.round(a * 10) / 10) : String(Math.round(a))
}

/**
 * Said after an exit found on waking or as the core started. Nobody watched the price meanwhile, so all the core
 * knows is what its first read after says, never when the price crossed.
 */
const meanwhile = (code: ExitCode, while_: "slept" | "started"): string => {
  if (code === "flatten") return ""
  if (code === "max_hold") return while_ === "slept" ? " while this machine slept" : " while the core wasn't running"
  const exit = code === "stop_loss" ? "stop" : code === "take_profit" ? "take profit" : "trailing stop"
  return while_ === "slept" ? ` (found on the core's first read after this machine woke, past its ${exit})` : ` (found on the core's first read after it started, past its ${exit})`
}

export interface BotExitsDeps {
  /** The rules bots whose exits sell now (bots.ts `runs().exits`), each with the definition it was approved as. */
  bots: {
    exiting(): { bot: BotEntry; definition: Definition }[]
    /** The slippage bound each bot was approved with: its sells go at it. */
    slippage?(name: string): number | undefined
  }
  /** Code bots whose sells run now, and the exits the core holds on each of their positions. Unset: none. */
  held?: {
    exiting(): { name: string }[]
    exitOf(position: string): Exit | undefined
    /** The slippage bound its card approved. */
    slippage(name: string): number | undefined
    /** A sell the bot itself asked for is under way on the position: its held exits wait for it. */
    busy(position: string): boolean
  }
  positions: Pick<BotPositions, "open" | "get" | "entryPriceUsd" | "notePrice" | "noteDecimals" | "sellPlan" | "awaitingMark">
  journal: Pick<Journal, "append">
  clock: { now(): number }
  /** The Candle Harness's mode. */
  mode(): Mode
  /** The newest market reading of a token (the triggers' watcher's). */
  reading(mint: string): Reading | undefined
  /** A fresh read of what a live wallet holds of a token, on the position's chain: "embedded" is that chain's embedded wallet. */
  holding(agent: string, wallet: string, mint: string, chain: Chain): Promise<Holding>
  /** A token's decimals from the core's last portfolio read, where it holds the token: no read of its own. */
  decimalsOf?(mint: string): number | undefined
  failed: Pick<FailedSells, "held" | "release" | "words">
  /**
   * Candle's breaker, kept clear of (breaker.ts): a sell Candle's route breaker refuses, or the key's pace full, waits
   * until the time given. With room, it takes the sell's slot. Unset, nothing waits.
   */
  breaker?: { exit(agent: string, mint: string, label: string): { why: "pace" | "route"; until: number; words: string } | undefined }
  /**
   * Sends the bot's sell as its own, in the bot's mode: answers as `cards.propose` does (with `instant` where it ran
   * with no card), or `{ paper }` for a paper trade. A throw is a refusal before anything reached Candle.
   */
  send(trade: Trade, client: FaceClient, mode: "paper" | "live", reason: string): Promise<unknown>
  card(cardId: string): { display: { cardBecause?: string } } | undefined
  nameOf(mint: string): string | undefined
}

/** A bot whose exits the core runs: a rules bot, or a code bot (`kind: "code"`). */
export interface ExitBot {
  name: string
  kind?: "code"
  /** The slippage bound its sells go at, read when the sell was decided: a bot removed after a flatten keeps it. */
  slippageBps?: number
}

/** An exit under way: from its `bot.exiting` row until its sell fills, or ends with nothing sold. */
interface Exiting {
  exitId: string
  bot: string
  kind?: "code"
  agent: string
  position: string
  mint: string
  mode: "paper" | "live"
  cardId?: string
  opId?: string
  approved?: boolean
  /** Its send is under way: a card the core withdraws on a refusal is ended by the refusal's words. */
  sending?: boolean
}

export type HeldWhy = "failed_sells" | "unread" | "decimals" | "pace" | "route" | "unpriced"

type EndOutcome = "refused" | "rejected" | "withdrawn" | "expired" | "failed" | "lost"

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
/** A position's chain as stored, else (a position from before positions carried one) its mint's family's. */
const chainOf = (mint: string, stored?: unknown): Chain => storedChain(stored, mint) ?? "solana"

export class BotExits {
  /** Exits under way, by position. */
  private readonly exiting = new Map<string, Exiting>()
  /** A position not to be tried before then: a refusal before Candle, or a wallet read as empty once. */
  private readonly retryAt = new Map<string, number>()
  /** A position the wallet read as holding none of, once: a second read the same is given up. */
  private readonly emptyOnce = new Set<string>()
  /**
   * An exit that held but waits for room under Candle's breaker: it sells once there's room, as a stop order does once
   * the price passes it, even if the price has moved back meanwhile. Kept in memory: after a restart it's checked afresh.
   */
  private readonly due = new Map<string, { reason: ExitReason; at: number; why: "breaker" | "retry" }>()
  /** The exit each position's newest sell was for: a sell that fails holds it, to be sold again. */
  private readonly decided = new Map<string, ExitReason>()
  /** Why a position's exit waits, said once until it changes. */
  private readonly heldSaid = new Map<string, { why: HeldWhy; words: string; since?: number }>()
  /**
   * Positions an exit is being planned for, from before anything is awaited until its `bot.exiting` row puts it in
   * `exiting`: the reservation a code bot's own sell checks (`selling`, the desk's `exitUnderWay`), as the exit checks
   * the bot's (`held.busy`), so one position never has two sells planned from the same balance read.
   */
  private readonly reserved = new Set<string>()
  /** A check under way: a heartbeat doesn't start another. */
  private checking: Promise<void> | undefined
  /** The journal's rows at start are being read: an end they show is already journalled, and isn't again. */
  private rebuilding = false
  /** Ends found while reading the journal at start, journalled after it unless a later row there already ended them. */
  private readonly endsFound = new Map<string, { e: Exiting; outcome: EndOutcome; words: string; code?: string }>()

  constructor(private readonly deps: BotExitsDeps) {}

  /** The journal's bot rows at start, oldest first: exits under way. One that never reached a card or paper was stopped with the core, and is ended. */
  async rebuild(rows: readonly JournalRow[]): Promise<void> {
    this.rebuilding = true
    try {
      for (const row of rows) this.note(row)
    } finally {
      this.rebuilding = false
    }
    // An end the journal shows with no `bot.exit_ended` after it: the core stopped before it said so, and it's said now, once.
    const found = [...this.endsFound.values()]
    this.endsFound.clear()
    for (const f of found) if (this.exiting.get(f.e.position) === f.e) await this.ended(f.e, f.outcome, f.words, f.code)
    for (const e of [...this.exiting.values()]) {
      if (e.cardId || e.opId) continue
      await this.ended(e, "lost", "the core stopped before its sell was sent, so nothing was sold; it's checked again now")
    }
  }

  /** Each bot whose exits run now, with the exits of each of its positions. */
  private watched(): { bot: ExitBot; exitOf(p: BotPosition): Exit | undefined }[] {
    const out: { bot: ExitBot; exitOf(p: BotPosition): Exit | undefined }[] = this.deps.bots.exiting().map(({ bot, definition }) => ({ bot, exitOf: () => definition.exit }))
    const held = this.deps.held
    if (held) for (const b of held.exiting()) out.push({ bot: { name: b.name, kind: "code" }, exitOf: (p) => held.exitOf(p.id) })
    return out
  }

  /** The tokens bots hold open positions in that have exits, for the watcher to read as sells. */
  tokens(): string[] {
    const mints = new Set<string>()
    for (const { bot, exitOf } of this.watched()) for (const p of this.deps.positions.open(bot.name)) if (exitOf(p)) mints.add(p.mint)
    // A buy read back by its id is sized from the first price near it, whatever its exits: read its token until then.
    for (const p of this.deps.positions.awaitingMark()) mints.add(p.mint)
    return [...mints]
  }

  /**
   * How many of a bot's open positions these exits would sell on the next check, that its exits now don't: what a
   * change to its exits would sell at once. Judged on each token's last price, fresh or not, so a change made
   * between readings is still caught.
   */
  wouldSell(bot: string, now: Exit | undefined, next: Exit | undefined): number {
    const at = this.deps.clock.now()
    let n = 0
    for (const p of this.deps.positions.open(bot)) {
      if (this.exiting.has(p.id)) continue
      const reading = this.deps.reading(p.mint)
      const filledAt = Date.parse(p.entryAt)
      const own = this.deps.positions.entryPriceUsd(p)
      const s = { label: this.nameOf(p.mint), entryUsd: own ?? p.markUsd, entryIsMark: own === undefined, peakUsd: p.peakUsd, priceUsd: positionPrice(reading, filledAt, at) ?? reading?.priceUsd ?? null, entryAt: filledAt, now: at }
      if (exitReason(next, s) && !exitReason(now, s)) n++
    }
    return n
  }

  /** Whether an exit is selling a position now. */
  selling(position: string): boolean {
    return this.exiting.has(position) || this.reserved.has(position)
  }

  /** Exits under way, for the tests and the topic. */
  under(bot?: string): Exiting[] {
    return [...this.exiting.values()].filter((e) => bot === undefined || e.bot === bot)
  }

  /**
   * Every open position of each bot whose exits sell, against the newest reading: each exit that holds is sold.
   * `slept` and `first` say a position may have crossed while nobody watched.
   */
  check(beat: { slept?: boolean; first?: boolean } = {}): Promise<void> {
    if (this.checking) return this.checking
    this.checking = this.checkOnce(beat).finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  private async checkOnce(beat: { slept?: boolean; first?: boolean }): Promise<void> {
    const now = this.deps.clock.now()
    const work: Promise<void>[] = []
    // A buy read back by its id takes the first fresh price near it, exits or none: a code bot's own sell needs it too.
    for (const p of this.deps.positions.awaitingMark()) {
      const reading = this.deps.reading(p.mint)
      if (reading?.decimals !== undefined) this.deps.positions.noteDecimals(p.mint, reading.decimals)
      const fresh = positionPrice(reading, Date.parse(p.entryAt), now)
      if (fresh) this.deps.positions.notePrice(p.mint, fresh)
    }
    for (const { bot, exitOf } of this.watched()) {
      for (const p of this.deps.positions.open(bot.name)) {
        if (this.selling(p.id) || (this.retryAt.get(p.id) ?? 0) > now) continue
        const exit = exitOf(p)
        // A code bot's position with no exits held is its own code's to sell; one it's selling itself is left to that sell.
        if (bot.kind === "code" && (!exit || this.deps.held?.busy(p.id))) continue
        const reading = this.deps.reading(p.mint)
        const decimals = reading?.decimals ?? (p.decimals === undefined ? this.deps.decimalsOf?.(p.mint) : undefined)
        if (decimals !== undefined) this.deps.positions.noteDecimals(p.mint, decimals)
        const filledAt = Date.parse(p.entryAt)
        const fresh = positionPrice(reading, filledAt, now)
        if (fresh) this.deps.positions.notePrice(p.mint, fresh)
        const label = this.nameOf(p.mint)
        const own = this.deps.positions.entryPriceUsd(p)
        const reason = exitReason(exit, { label, entryUsd: own ?? p.markUsd, entryIsMark: own === undefined, peakUsd: p.peakUsd, priceUsd: fresh, entryAt: filledAt, now }) ?? this.dueReason(p.id, now)
        if (!reason) {
          const since = Math.max(filledAt, reading?.priceUsd != null ? reading.at : filledAt)
          if (fresh === null && exit && needsPrice(exit) && now - since >= UNPRICED_SAY_MS) {
            // Said once until a price comes back: a stop or target can't be judged on no price, nor on an old one.
            work.push(this.held(bot, p, "unpriced", unpricedWords(exit, since), since).catch(() => {}))
            continue
          }
          // The exit no longer holds: whatever held its sell is no longer said.
          this.heldSaid.delete(p.id)
          continue
        }
        const while_ = beat.slept ? ("slept" as const) : beat.first ? ("started" as const) : undefined
        work.push(this.exit(bot, p, while_ ? { ...reason, words: `${reason.words}${meanwhile(reason.code, while_)}` } : reason).catch(() => {}))
      }
    }
    await Promise.all(work)
  }

  /**
   * Sells every open position of a bot now, at market, through the same rules as its exits: a stopped bot's too.
   * What each sell does is in the journal as it goes.
   */
  flatten(bot: ExitBot & { agent: string }, by: { how: "view" | "agent"; agent?: string }): { said: string; positions: number } {
    const all = this.deps.positions.open(bot.name).filter((p) => !this.selling(p.id))
    // A code bot's own sell under way on a position is left to finish: never two sells of one position at once.
    const itself = bot.kind === "code" ? all.filter((p) => this.deps.held?.busy(p.id)) : []
    const open = all.filter((p) => !itself.includes(p))
    const words = by.how === "agent" ? `${by.agent ?? bot.agent} flattened it, on a card you approved` : "you flattened it"
    // Its bound now: a flatten before a removal still sells at what its card approved.
    const slippageBps = bot.slippageBps ?? (bot.kind === "code" ? this.deps.held?.slippage(bot.name) : this.deps.bots.slippage?.(bot.name))
    const selling = { name: bot.name, ...(bot.kind ? { kind: bot.kind } : {}), ...(slippageBps !== undefined ? { slippageBps } : {}) }
    for (const p of open) {
      this.retryAt.delete(p.id)
      void this.exit(selling, p, { code: "flatten", words }).catch(() => {})
    }
    const already = this.under(bot.name).length - open.length + itself.length
    const own = itself.length ? ` ${itself.length === 1 ? "One position is" : `${itself.length} positions are`} being sold by the bot itself already, so ${itself.length === 1 ? "that sell is" : "those sells are"} left to finish.` : ""
    if (!open.length) return { said: already > 0 ? `"${bot.name}" is already selling what it holds.${own}` : `"${bot.name}" holds no open positions, so nothing was sold.`, positions: 0 }
    return { said: `Selling ${open.length === 1 ? "its open position" : `its ${open.length} open positions`} of "${bot.name}" now, as its exits sell. Activity says how each ends.${own}`, positions: open.length }
  }

  /** The exit a position passed while it waited for room under Candle's breaker, said with how long it waited. */
  private dueReason(position: string, now: number): ExitReason | undefined {
    const d = this.due.get(position)
    if (!d) return undefined
    // Said once: a sell that fails again carries the words its last try was sent with.
    if (d.why === "retry") return { code: d.reason.code, words: d.reason.words.endsWith(SELLS_AGAIN) ? d.reason.words : `${d.reason.words}${SELLS_AGAIN}` }
    const s = Math.max(1, Math.round((now - d.at) / 1000))
    return { code: d.reason.code, words: `${d.reason.words}; it waited ${s} s for room under Candle's breaker and sells once passed, as a stop order does` }
  }

  /** The sells a bot's exits hold now, each with why in words: for the topic, the retry chip and the doctor. */
  heldSells(name: string): { mint: string; why: HeldWhy; words: string }[] {
    const out: { mint: string; why: HeldWhy; words: string }[] = []
    for (const p of this.deps.positions.open(name)) {
      const h = this.heldSaid.get(p.id)
      if (h && !this.exiting.has(p.id)) out.push({ mint: p.mint, why: h.why, words: h.words })
    }
    return out
  }

  /** Since when a position has had no price from Candle to judge its exits on, where that's been said. */
  unpricedSince(position: string): number | undefined {
    const h = this.heldSaid.get(position)
    return h?.why === "unpriced" ? h.since : undefined
  }

  /** The person's retry: a bot's exits held by two failed sells go once more. How many tokens it released. */
  retry(name: string): number {
    let released = 0
    for (const p of this.deps.positions.open(name)) {
      if (this.deps.failed.release(p.agent, p.mint)) released++
      if (this.heldSaid.get(p.id)?.why === "failed_sells") this.heldSaid.delete(p.id)
      this.retryAt.delete(p.id)
    }
    return released
  }

  /** A journal row, as it's appended: an exit links to its card and operation, and ends when its sell fills or can't. */
  note(row: JournalRow): void {
    if (row.type === "bot.exiting" && typeof row.exitId === "string" && typeof row.position === "string" && typeof row.name === "string" && typeof row.mint === "string") {
      this.exiting.set(row.position, {
        exitId: row.exitId,
        bot: row.name,
        ...(row.kind === "code" ? { kind: "code" as const } : {}),
        agent: String(row.agent ?? ""),
        position: row.position,
        mint: row.mint,
        mode: row.botMode === "paper" ? "paper" : "live",
      })
      return
    }
    if (row.type === "bot.exit_ended" && typeof row.position === "string") {
      if (this.exiting.get(row.position)?.exitId === row.exitId) this.exiting.delete(row.position)
      if (this.endsFound.get(row.position)?.e.exitId === row.exitId) this.endsFound.delete(row.position)
      return
    }
    if (row.type === "bot.position_left" && typeof row.position === "string") {
      this.exiting.delete(row.position)
      this.due.delete(row.position)
      this.decided.delete(row.position)
      return
    }
    if (typeof row.bot !== "string" || row.botAct !== "exit") {
      this.settle(row)
      return
    }
    const e = typeof row.botPosition === "string" ? this.exiting.get(row.botPosition) : undefined
    if (!e) return
    if (row.type === "card.created") {
      e.cardId = typeof row.cardId === "string" ? row.cardId : undefined
      e.opId = typeof row.opId === "string" ? row.opId : undefined
    } else if (row.type === "card.approved") {
      e.approved = true
    } else if ((row.type === "card.rejected" || row.type === "card.withdrawn" || row.type === "card.expired") && !e.approved && !e.sending) {
      const words = row.type === "card.expired" ? (row.reason === "core_restarted" ? "its card was open when the core stopped, so nothing was sold" : "nobody pressed its card in time, so nothing was sold") : row.type === "card.rejected" ? "you rejected its card, so nothing was sold" : "its card was withdrawn, so nothing was sold"
      void this.ended(e, row.type.slice(5) as "rejected" | "withdrawn" | "expired", words).catch(() => {})
    } else if (row.type === "paper.call") {
      // A paper sell is done in one call: the book closes the position from this same row.
      if (row.isError === true) void this.ended(e, "failed", "its paper sell didn't go through; it's tried again").catch(() => {})
      else this.exiting.delete(e.position)
    }
  }

  /** An operation's outcome: an exit ends with it, sold or not. One whose outcome isn't known stays under way until it's read back. */
  private settle(row: JournalRow): void {
    if (!row.type.startsWith("operation.") || typeof row.opId !== "string") return
    const e = [...this.exiting.values()].find((x) => x.opId === row.opId)
    if (!e) return
    if (row.type === "operation.succeeded") this.exiting.delete(e.position)
    else if (row.type === "operation.failed" || row.type === "operation.refused" || row.type === "operation.abandoned") {
      const why = record(row.error)?.message
      void this.ended(e, "failed", `its sell ${row.type === "operation.abandoned" ? "was abandoned" : "didn't go through"}${typeof why === "string" ? `: ${why.replace(/[.\s]+$/, "")}` : ""}; it's tried again`).catch(() => {})
    }
  }

  private async ended(e: Exiting, outcome: EndOutcome, words: string, code?: string): Promise<void> {
    if (this.exiting.get(e.position) !== e) return
    if (this.rebuilding) {
      // Its `bot.exit_ended` row, if the journal has one, comes later in the rows being read.
      this.endsFound.set(e.position, { e, outcome, words, ...(code ? { code } : {}) })
      return
    }
    this.exiting.delete(e.position)
    // Its bot was removed while this sell was under way (removed with its positions sold): nothing sells it again,
    // so the row says where the tokens are, not that it's tried again.
    const gone = (outcome === "failed" || outcome === "refused") && this.deps.positions.get(e.position)?.removed === true
    if (gone) {
      this.decided.delete(e.position)
      words = words.replace(/; it's tried again( in a minute)?$/, "; its bot is removed, so it isn't tried again: the tokens are left in the wallet, yours to sell")
    } else if (outcome === "failed" || outcome === "refused") {
      // Its exit holds until a sell goes through: the next is sent with a fresh id, as a stop order would be.
      const reason = this.decided.get(e.position)
      if (reason && !this.due.has(e.position)) this.due.set(e.position, { reason, at: this.deps.clock.now(), why: "retry" })
      // The failed sell's own row reaches the two-failed-sells count after this one is noted: read it then.
      await Promise.resolve()
      if (this.deps.failed.held(e.agent, e.mint)) words = words.replace(/; it's tried again( in a minute)?$/, `; it waits: ${this.deps.failed.words(e.agent, this.nameOf(e.mint))}. Say retry on the bot to try once more`)
    }
    await this.deps.journal.append({
      type: "bot.exit_ended",
      mode: this.deps.mode(),
      ...(e.kind ? { kind: e.kind } : {}),
      agent: e.agent,
      name: e.bot,
      exitId: e.exitId,
      position: e.position,
      mint: e.mint,
      botMode: e.mode,
      outcome,
      ...(code ? { code } : {}),
      words: `${this.nameOf(e.mint)}: ${words}`,
    })
  }

  /** Says once why a position's exit waits, until the reason changes. */
  private async held(bot: ExitBot, p: BotPosition, why: HeldWhy, words: string, since?: number): Promise<void> {
    if (this.heldSaid.get(p.id)?.why === why) return
    this.heldSaid.set(p.id, { why, words: `${this.nameOf(p.mint)}: ${words}`, ...(since !== undefined ? { since } : {}) })
    await this.deps.journal.append({ type: "bot.exit_held", mode: this.deps.mode(), ...(bot.kind ? { kind: bot.kind } : {}), agent: p.agent, name: bot.name, position: p.id, mint: p.mint, botMode: p.mode, why, words: `${this.nameOf(p.mint)}: ${words}` })
  }

  /**
   * Journals the exit, then sells the bot's own as its own. The position is reserved before anything is awaited: a
   * code bot's own sell arriving while the wallet is read is refused, and one already under way holds the exit.
   */
  private async exit(bot: ExitBot, p: BotPosition, reason: ExitReason): Promise<void> {
    if (this.selling(p.id) || (bot.kind === "code" && this.deps.held?.busy(p.id))) return
    this.reserved.add(p.id)
    try {
      await this.exitReserved(bot, p, reason)
    } finally {
      this.reserved.delete(p.id)
    }
  }

  private async exitReserved(bot: ExitBot, p: BotPosition, reason: ExitReason): Promise<void> {
    const label = this.nameOf(p.mint)
    if (this.deps.failed.held(p.agent, p.mint)) return this.held(bot, p, "failed_sells", `its exit (${reason.words}) waits: ${this.deps.failed.words(p.agent, label)}. Say retry on the bot to try once more.`)
    // What the wallet holds now, for the bot's own share of it. Paper's book is the key's own, sold by amount.
    let holding: bigint | undefined
    let decimals = p.decimals ?? this.deps.reading(p.mint)?.decimals
    if (p.mode === "live") {
      const h = await this.deps.holding(p.agent, p.wallet, p.mint, chainOf(p.mint, p.chain)).catch(() => "unreadable" as const)
      if (h === "unreadable") {
        this.retryAt.set(p.id, this.deps.clock.now() + REFUSED_RETRY_MS)
        return this.held(bot, p, "unread", `its exit (${reason.words}) waits: the wallet's balance couldn't be read, so it's read again in a minute`)
      }
      holding = h === "none" ? 0n : h.amountRaw
      if (h !== "none") {
        this.deps.positions.noteDecimals(p.mint, h.decimals)
        decimals ??= h.decimals
      }
      // Read again after the await: a sell the bot asked for that began meanwhile (with no desk to see the
      // reservation) is left to finish, and this exit is checked again after it.
      if (bot.kind === "code" && this.deps.held?.busy(p.id)) return
      if (holding === 0n && !this.emptyOnce.has(p.id)) {
        // A portfolio read can lag a fill: read again before the position is given up.
        this.emptyOnce.add(p.id)
        this.retryAt.set(p.id, this.deps.clock.now() + EMPTY_RECHECK_MS)
        return
      }
    }
    this.emptyOnce.delete(p.id)
    // A TEE wallet's sell takes an amount; so does the embedded wallet's of a token Candle gives decimals for.
    const byAmount = p.mode === "paper" || p.wallet !== "embedded" || this.deps.reading(p.mint)?.decimals !== undefined
    const plan = this.deps.positions.sellPlan(this.deps.positions.get(p.id) ?? p, { ...(holding !== undefined ? { holding } : {}), byAmount, ...(decimals !== undefined ? { decimals } : {}), label })
    if (plan.by === "none") {
      if (p.mode === "paper") return this.held(bot, p, "decimals", plan.words)
      // Its own can't be sized yet (a buy whose answer never said what it received, with no price since): it waits.
      if (plan.wait) {
        this.retryAt.set(p.id, this.deps.clock.now() + REFUSED_RETRY_MS)
        return this.held(bot, p, "decimals", `its exit (${reason.words}) waits: ${plan.words}`)
      }
      // Nothing of its own left to sell: the position is given up, said with why.
      await this.deps.journal.append({
        type: "bot.position_left",
        mode: this.deps.mode(),
        ...(bot.kind ? { kind: bot.kind } : {}),
        agent: p.agent,
        name: bot.name,
        position: p.id,
        mint: p.mint,
        botMode: p.mode,
        ...(plan.outsideRaw !== undefined ? { outsideRaw: String(plan.outsideRaw) } : {}),
        words: `${label}: ${plan.words}`,
      })
      return
    }
    // Candle's breaker last, with nothing awaited before the sell is proposed: the slot it takes is this sell's.
    const breaker = this.deps.breaker?.exit(p.agent, p.mint, label)
    if (breaker) {
      if (this.due.get(p.id)?.why !== "breaker") this.due.set(p.id, { reason, at: this.deps.clock.now(), why: "breaker" })
      this.retryAt.set(p.id, breaker.until)
      return this.held(bot, p, breaker.why, `its exit (${reason.words}) waits: ${breaker.words}`)
    }
    this.heldSaid.delete(p.id)
    this.due.delete(p.id)
    this.decided.set(p.id, reason)
    const exitId = `exit_${randomBytes(9).toString("base64url")}`
    const slippageBps = bot.slippageBps ?? (bot.kind === "code" ? this.deps.held?.slippage(bot.name) : this.deps.bots.slippage?.(bot.name))
    const sells = plan.by === "amount" ? `${plan.amount ?? "its"} ${label}` : `${plan.percent}% of the wallet's ${label}${plan.percent < 100 ? ", ≈ its own" : ""}`
    const exiting = await this.deps.journal.append({
      type: "bot.exiting",
      mode: this.deps.mode(),
      ...(bot.kind ? { kind: bot.kind } : {}),
      agent: p.agent,
      name: bot.name,
      exitId,
      position: p.id,
      mint: p.mint,
      chain: chainOf(p.mint, p.chain),
      reason: reason.code,
      wallet: p.wallet,
      botMode: p.mode,
      sell: plan.by === "amount" ? { by: "amount", amountRaw: String(plan.amountRaw), ...(plan.amount ? { amount: plan.amount } : {}) } : { by: "percent", percent: plan.percent, ownRaw: String(plan.ownRaw) },
      ...(plan.outsideRaw !== undefined ? { outsideRaw: String(plan.outsideRaw) } : {}),
      ...(plan.words ? { note: plan.words } : {}),
      words: `sells ${sells}${p.mode === "paper" ? ", on paper" : ""}: ${reason.words}`,
    })
    // The core hands every row to `note` as it's appended; noted here too, for a journal nobody listens to.
    if (!this.exiting.has(p.id)) this.note(exiting)
    const e = this.exiting.get(p.id)
    const trade: Trade = {
      kind: "trade",
      tool: "candle_trade",
      args: { mint: p.mint, side: "sell", ...(plan.by === "amount" ? { amount: plan.amount! } : { percent: plan.percent }), ...(p.mode === "live" ? { wallet: p.wallet } : {}), ...(slippageBps !== undefined ? { maxSlippageBps: slippageBps } : {}) },
      echo: `sell ${plan.by === "amount" ? plan.amount : `${plan.percent}%`} ${label}`,
    }
    const client = botClient(
      { ...(bot.kind ? { kind: bot.kind } : {}), name: bot.name, agent: p.agent, mode: p.mode, ...(slippageBps !== undefined ? { slippageBps } : {}) },
      { act: "exit", position: p.id, reason: reason.code, ...(plan.outsideRaw !== undefined ? { outside: String(plan.outsideRaw) } : {}) },
    )
    if (e) e.sending = true
    let answer: unknown
    try {
      answer = await this.deps.send(trade, client, p.mode, `the bot "${bot.name}" sells: ${reason.words}`)
    } catch (error) {
      const err = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | undefined
      const code = typeof err?.data?.code === "string" ? err.data.code : typeof err?.code === "string" ? err.code : undefined
      this.retryAt.set(p.id, this.deps.clock.now() + REFUSED_RETRY_MS)
      if (e) {
        e.sending = false
        await this.ended(e, "refused", `its sell was refused before it reached Candle: ${typeof err?.message === "string" ? err.message : "the core refused it"}; it's tried again in a minute`, code)
      }
      return
    }
    if (e) e.sending = false
    const a = record(answer)
    if (a && "paper" in a) {
      const result = record(a.paper)
      if (result?.isError === true && e) await this.ended(e, "failed", "its paper sell didn't go through; it's tried again")
      else if (e) this.exiting.delete(p.id)
      return
    }
    // A sell that waits for the person: its slippage bound, or the same sell still in flight.
    if (typeof a?.cardId === "string" && a.state === "awaiting_approval" && a.instant === undefined && e) {
      const because = this.deps.card(a.cardId)?.display.cardBecause ?? "it needs your press"
      await this.deps.journal.append({ type: "bot.exit_waiting", mode: this.deps.mode(), ...(bot.kind ? { kind: bot.kind } : {}), agent: p.agent, name: bot.name, exitId, position: p.id, mint: p.mint, cardId: a.cardId, because, words: `its sell of ${label} waits for you: ${because}` })
    }
  }

  private nameOf(mint: string): string {
    return this.deps.nameOf(mint) ?? short(mint)
  }
}
