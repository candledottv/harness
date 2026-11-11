// A rules bot's own book: its positions from its own fills, paper and live kept apart, rebuilt from the journal.
//
// - A bot's trade is found by the `bot` on its card (`card.created`) or its paper trade (`paper.call`); its fill
//   is the `fill` on that operation's `operation.succeeded` or on the paper trade's row (fill.ts). Each fill is
//   applied once, by the operation's id or the paper row's seq, however often the journal is read.
// - A position is what its entry received, less what its exits sold. Its cost is the pair asset it spent with
//   Candle's fee, in dollars at the pair asset's price when it filled.
// - A bot sells only its own (`sellPlan`): never more than its book holds. Where a buy's answer never said what it
//   received, its own is worked out from what it spent and Candle's first price after, never the wallet's whole
//   holding. That price counts only when it came within MARK_WINDOW_MS of the buy being sent (a later one, after a
//   restart say, can be far from the fill), and the estimate is never more than the quote's expected out plus the
//   card's slippage bound. On a wallet the person or other bots
//   also trade from, it sells its own amount where the route sells by amount (a TEE wallet, a token Candle
//   launched, paper), else the whole percent of the wallet's balance its own is, rounded down, and 100% when it
//   holds the whole balance. A wallet holding less than the bots' own shares what's left between them, and the
//   rest is said as sold outside the bot.
// - A removed bot's open positions end with it (`bot.removed`): what they held is the person's from then on, so a
//   new bot of the same name starts with none of them, all its slots, and nothing for its exits to sell. Its closed
//   positions leave the name's book too: a new bot's history and realized P&L start empty, and the old one's are
//   in the Journal. A sell of one already under way as the bot was removed still lands on its position when it fills.
// - Each open position's highest price since its entry (for a trailing exit) is kept in its own small state file,
//   since a price isn't a journal row.
import { sameAddress } from "../shared/address-key"
import { randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { BASE_ASSETS, fromRaw, isBaseAsset } from "./assets"
import { type Fill, fillOfRow, netAssetRaw } from "./fill"
import type { JournalRow } from "./journal"
import { chainField, type ChainSlug } from "../shared/chains"

export interface BotExit {
  /** The exit's operation id, or `paper:<seq>`. */
  id: string
  at: string
  reason?: string
  /** Tokens it sold, raw. */
  tokensRaw?: string
  /** The pair asset it brought in, less Candle's fee, raw. */
  proceedsRaw?: string
  proceedsUsd?: number
}

export interface BotPosition {
  /** Its entry's operation id, or `paper:<seq>` for a paper entry. */
  id: string
  bot: string
  agent: string
  /** "embedded", a TEE wallet's address, or "paper". */
  wallet: string
  mode: "paper" | "live"
  mint: string
  /** The chain it was bought on, from its fill. */
  chain?: ChainSlug
  /** The pair asset it bought with. */
  asset: string
  /** Tokens it received, raw; unset when Candle's answer didn't say (a buy read back by its id). */
  tokensRaw?: string
  decimals?: number
  /** The pair asset it spent, with Candle's fee, raw. */
  costRaw?: string
  costUsd?: number
  entryAt: string
  /** The signal it entered on, by Hacc's id. */
  signal?: number
  /** The token's highest USD price seen since its entry. */
  peakUsd?: number
  /**
   * Candle's first price for the token after its entry, kept where the entry's own price can't be said (a buy read
   * back by its id says nothing of what it received): the exits' entry until it can.
   */
  markUsd?: number
  /** When its buy was sent (the first `operation.submitting`), else when it filled: a mark counts only near it. */
  sentAt?: string
  /** The most a read-back buy can have received: the quote's expected out plus the card's slippage bound, raw. */
  capRaw?: string
  /** Tokens its exits sold, raw. */
  soldRaw: string
  exits: BotExit[]
  /** When an exit closed it. */
  closedAt?: string
  /** Tokens the wallet no longer held when it sold: sold outside the bot. */
  outsideRaw?: string
  /** Closed with nothing of its own left to sell (`bot.position_left`), not by an exit's fill. */
  left?: boolean
  /** Closed because its bot was removed while it was open: whatever it still held stays in the wallet, the person's. */
  removed?: boolean
  /**
   * A removed bot's: open or long closed when its bot went. A bot saved later under the same name starts with an
   * empty book, so its history and realized P&L aren't the earlier bot's; the earlier one's stay in the Journal.
   */
  past?: boolean
}

/** How a bot's exit sells its own, or why it can't. */
export type SellPlan =
  | { by: "amount"; amountRaw: bigint; amount?: string; outsideRaw?: bigint; words?: string }
  | { by: "percent"; percent: number; ownRaw: bigint; outsideRaw?: bigint; words?: string }
  | { by: "none"; outsideRaw?: bigint; words: string; /** Nothing to give up: its own can't be sized yet, and is tried again. */ wait?: true }

export interface BotTotals {
  open: number
  closed: number
  realizedUsd: number
  /** Closed positions whose figures were all valued. */
  valued: boolean
}

interface PeaksFile {
  peaks: Record<string, number>
  marks?: Record<string, number>
  /** When each mark was taken (ms): a mark with no time, or one taken too long after its buy, isn't used. */
  marksAt?: Record<string, number>
}

const PEAKS_WRITE_MS = 10_000
/** How long after a buy is sent Candle's price still sizes a read-back buy's own: a later price can be far from its fill. */
export const MARK_WINDOW_MS = 60_000
/** The slippage a buy ran with when its card set none: Candle's server's on the embedded route, the CLI's on a TEE wallet's. */
const DEFAULT_BUY_SLIPPAGE_BPS = { embedded: 100, cli: 50 }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Raw units of a base asset in dollars, at a price. */
const assetDollars = (asset: string, raw: bigint | undefined, usd: number | undefined): number | undefined => {
  if (raw === undefined || usd === undefined || !isBaseAsset(asset)) return undefined
  return (Number(raw) / 10 ** BASE_ASSETS[asset].decimals) * usd
}

/** Who a bot's trade was, from its card or paper trade's row. */
interface BotTrade {
  bot: string
  act: "entry" | "exit"
  agent: string
  position?: string
  signal?: number
  reason?: string
  outsideRaw?: string
  /** The card's own value, where the fill's pair asset had no price when it settled. */
  usd?: number
  /** A code bot's sell of part of its position: what's left stays open. */
  partial?: boolean
  /** What a code bot's sell by amount sells, raw: counted where the fill doesn't say. */
  sellsRaw?: string
  /** Its bot was removed before this buy filled, and when: what it buys is left in the wallet. */
  removedAt?: string
  /** When the trade was first sent (`operation.submitting`). */
  sentAt?: string
  /** A buy's quoted expected out plus its slippage bound, raw: the most it can have received. */
  capRaw?: string
}

/** A buy card's ceiling on what it received: Candle's quoted expected out times (1 + its slippage bound). */
const capOf = (row: JournalRow): string | undefined => {
  if (row.side !== "buy" || typeof row.quoteOutRaw !== "string" || !/^\d{1,78}$/.test(row.quoteOutRaw)) return undefined
  const given = record(row.params)?.maxSlippageBps
  const bps = typeof given === "number" && Number.isInteger(given) && given >= 0 && given <= 10_000 ? given : row.route === "cli" ? DEFAULT_BUY_SLIPPAGE_BPS.cli : DEFAULT_BUY_SLIPPAGE_BPS.embedded
  return String((BigInt(row.quoteOutRaw) * BigInt(10_000 + bps)) / 10_000n)
}

const botTradeOf = (row: JournalRow): BotTrade | undefined => {
  if (typeof row.bot !== "string" || (row.botAct !== "entry" && row.botAct !== "exit") || typeof row.agent !== "string") return undefined
  return {
    bot: row.bot,
    act: row.botAct,
    agent: row.agent,
    ...(typeof row.botPosition === "string" ? { position: row.botPosition } : {}),
    ...(typeof row.botSignal === "number" ? { signal: row.botSignal } : {}),
    ...(typeof row.botReason === "string" ? { reason: row.botReason } : {}),
    ...(typeof row.botOutside === "string" && /^\d+$/.test(row.botOutside) ? { outsideRaw: row.botOutside } : {}),
    ...(row.botPartial === true ? { partial: true } : {}),
    ...(typeof row.botSellsRaw === "string" && /^\d+$/.test(row.botSellsRaw) ? { sellsRaw: row.botSellsRaw } : {}),
    ...(capOf(row) ? { capRaw: capOf(row) } : {}),
  }
}

export class BotPositions {
  private readonly positions = new Map<string, BotPosition>()
  /** Each bot trade's card, by its operation id. */
  private readonly trades = new Map<string, BotTrade>()
  /** Fills already applied, by operation id or `paper:<seq>`. */
  private readonly applied = new Set<string>()
  private peaksDirty = false
  private peaksTimer: (() => void) | undefined
  /** When each position's mark was taken, ms. */
  private readonly markAt = new Map<string, number>()

  constructor(
    private readonly deps: {
      /** The journal's rows a bot's book is rebuilt from (`Journal.botRows`). */
      rows: readonly JournalRow[]
      /** Where each open position's peak is kept; unset keeps peaks in memory only. */
      statePath?: string
      /** Timer seam; tests drive it by hand. */
      schedule?: (run: () => void, ms: number) => () => void
      onChange?: () => void
      /** The clock a price is noted at; a read-back buy's mark counts only within MARK_WINDOW_MS of its send. */
      now?: () => number
    },
  ) {
    for (const row of deps.rows) this.apply(row)
    if (deps.statePath) {
      try {
        const saved = JSON.parse(readFileSync(deps.statePath, "utf8")) as Partial<PeaksFile>
        for (const [id, usd] of Object.entries(record(saved.peaks) ?? {})) {
          const p = this.positions.get(id)
          if (p && !p.closedAt && typeof usd === "number" && Number.isFinite(usd) && usd > 0) p.peakUsd = Math.max(p.peakUsd ?? 0, usd)
        }
        const marksAt = record(saved.marksAt) ?? {}
        for (const [id, usd] of Object.entries(record(saved.marks) ?? {})) {
          const p = this.positions.get(id)
          const at = marksAt[id]
          // A mark saved with no time (an older file), or taken too long after its buy, can't size the buy's own.
          if (p && !p.closedAt && typeof usd === "number" && Number.isFinite(usd) && usd > 0 && typeof at === "number" && this.inMarkWindow(p, at)) {
            p.markUsd = usd
            this.markAt.set(id, at)
          }
        }
      } catch {}
    }
  }

  /** A journal row as it's appended: a bot's card, its fill, or its paper trade. */
  note(row: JournalRow): void {
    if (this.apply(row)) this.deps.onChange?.()
  }

  /** Every position of the bot that holds the name now, oldest first: never a removed bot's of the same name. */
  of(bot: string, mode?: "paper" | "live"): BotPosition[] {
    return [...this.positions.values()].filter((p) => p.bot === bot && !p.past && (mode === undefined || p.mode === mode))
  }

  /** A bot's open positions, oldest first. */
  open(bot: string, mode?: "paper" | "live"): BotPosition[] {
    return this.of(bot, mode).filter((p) => !p.closedAt)
  }

  get(id: string): BotPosition | undefined {
    return this.positions.get(id)
  }

  /** Open positions whose bot's name passes `which`: a Build pane's tests, kept apart from the bots they test. */
  openWhere(which: (bot: string) => boolean): BotPosition[] {
    return [...this.positions.values()].filter((p) => !p.closedAt && which(p.bot))
  }

  /** Whether a bot holds an open position in a token, paper or live: a second signal on it isn't entered. */
  holds(bot: string, mint: string, mode: "paper" | "live"): boolean {
    return this.open(bot, mode).some((p) => sameAddress(p.mint, mint))
  }

  /** What's left of a position, raw, where its entry said what it received. */
  remainingRaw(p: BotPosition): bigint | undefined {
    if (p.tokensRaw === undefined) return undefined
    const left = BigInt(p.tokensRaw) - BigInt(p.soldRaw)
    return left > 0n ? left : 0n
  }

  /** A bot's figures, paper and live apart: its open and closed positions, and what its exits realized. */
  totals(bot: string, mode: "paper" | "live"): BotTotals {
    const all = this.of(bot, mode)
    const closed = all.filter((p) => p.closedAt)
    let realizedUsd = 0
    let valued = true
    for (const p of closed) {
      const r = this.realizedUsd(p)
      if (r === undefined) valued = false
      else realizedUsd += r
    }
    return { open: all.length - closed.length, closed: closed.length, realizedUsd, valued }
  }

  /** What a position's exits brought in, less what it cost (in the part they sold), or undefined where either wasn't valued. */
  realizedUsd(p: BotPosition): number | undefined {
    if (p.exits.length === 0 || p.costUsd === undefined) return undefined
    let proceeds = 0
    for (const e of p.exits) {
      if (e.proceedsUsd === undefined) return undefined
      proceeds += e.proceedsUsd
    }
    // A closed position's whole cost counts; an exit that sold part of one, its share.
    const tokens = p.tokensRaw === undefined ? undefined : BigInt(p.tokensRaw)
    const share = p.closedAt || tokens === undefined || tokens === 0n ? 1 : Math.min(1, Number(BigInt(p.soldRaw)) / Number(tokens))
    return proceeds - p.costUsd * share
  }

  /**
   * What a bot's exits realized between two times (ms), by when each filled: its proceeds less its share of the
   * position's cost. `valued` is false where an exit, or its position's cost or share, couldn't be valued.
   */
  realizedBetween(bot: string, from: number, to: number, mode?: "paper" | "live"): { usd: number; exits: number; valued: boolean } {
    let usd = 0
    let exits = 0
    let valued = true
    for (const p of this.of(bot, mode)) {
      for (const e of p.exits) {
        const at = Date.parse(e.at)
        if (!(at > from && at <= to)) continue
        exits++
        const tokens = p.tokensRaw === undefined ? undefined : BigInt(p.tokensRaw)
        const share = e.tokensRaw !== undefined && tokens !== undefined && tokens > 0n ? Math.min(1, Number(BigInt(e.tokensRaw)) / Number(tokens)) : p.exits.length === 1 && p.closedAt ? 1 : undefined
        if (e.proceedsUsd === undefined || p.costUsd === undefined || share === undefined) {
          valued = false
          continue
        }
        usd += e.proceedsUsd - p.costUsd * share
      }
    }
    return { usd, exits, valued }
  }

  /** What a position's tokens are worth at a price, less what they cost, or undefined where it can't be said. */
  unrealizedUsd(p: BotPosition, priceUsd: number): number | undefined {
    const left = this.remainingRaw(p)
    if (p.closedAt || left === undefined || p.decimals === undefined || p.costUsd === undefined || p.tokensRaw === undefined || BigInt(p.tokensRaw) === 0n) return undefined
    const share = Number(left) / Number(BigInt(p.tokensRaw))
    return (Number(left) / 10 ** p.decimals) * priceUsd - p.costUsd * share
  }

  /** The price a position entered at, per token, with Candle's fee in it; undefined where it can't be said. */
  entryPriceUsd(p: BotPosition): number | undefined {
    if (p.costUsd === undefined || p.tokensRaw === undefined || p.decimals === undefined) return undefined
    const tokens = Number(BigInt(p.tokensRaw)) / 10 ** p.decimals
    return tokens > 0 ? p.costUsd / tokens : undefined
  }

  /** The token's decimals, from a market or holdings read, for the positions that don't know them yet. */
  noteDecimals(mint: string, decimals: number): void {
    if (!Number.isInteger(decimals) || decimals < 0) return
    let changed = false
    for (const p of this.positions.values()) {
      if (p.mint === mint && p.decimals === undefined) {
        p.decimals = decimals
        changed = true
      }
    }
    if (changed) this.deps.onChange?.()
  }

  /**
   * A token's price now: each open position in it keeps its highest since entry, and its first where its entry can't
   * be said, as long as that first price comes within MARK_WINDOW_MS of the buy being sent.
   */
  notePrice(mint: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return
    const now = (this.deps.now ?? Date.now)()
    for (const p of this.positions.values()) {
      if (p.mint !== mint || p.closedAt) continue
      if (p.markUsd === undefined && this.entryPriceUsd(p) === undefined && this.inMarkWindow(p, now)) {
        p.markUsd = usd
        this.markAt.set(p.id, now)
        this.peaksDirty = true
      }
      if (p.peakUsd !== undefined && p.peakUsd >= usd) continue
      p.peakUsd = usd
      this.peaksDirty = true
    }
    if (this.peaksDirty) this.schedulePeaks()
  }

  /**
   * Live positions whose buy was read back by its id, still waiting for the first price that sizes them, while that
   * price can still come: their token is read whatever their exits, since a code bot's own sell needs it too.
   */
  awaitingMark(): BotPosition[] {
    const now = (this.deps.now ?? Date.now)()
    return [...this.positions.values()].filter((p) => !p.closedAt && p.mode === "live" && p.tokensRaw === undefined && p.markUsd === undefined && this.inMarkWindow(p, now))
  }

  /**
   * How a bot's exit sells its own position, and the words when the wallet holds less than its own. `holding` is
   * a fresh read of what the wallet holds of the token (unused for paper, whose book is the key's own); `byAmount`
   * says whether the route sells an exact amount (a TEE wallet, a token Candle launched, paper); `decimals` turns
   * a raw amount into the decimal amount Candle's tools take.
   */
  sellPlan(p: BotPosition, input: { holding?: bigint; byAmount: boolean; decimals?: number; label?: string }): SellPlan {
    const label = input.label ?? "this token"
    const decimals = input.decimals ?? p.decimals
    const amountOf = (raw: bigint) => (decimals === undefined ? undefined : fromRaw(raw, decimals))
    const left = this.remainingRaw(p)
    if (p.mode === "paper") {
      if (left === undefined || left === 0n) return { by: "none", words: `This bot's paper position in ${label} holds nothing to sell.` }
      const amount = amountOf(left)
      // Paper's book is the key's own, shared with the agent's paper trades: only an amount keeps to the bot's.
      if (amount === undefined) return { by: "none", words: `The token's decimals aren't known yet, so this bot's paper position in ${label} can't be sold by its own amount.` }
      return { by: "amount", amountRaw: left, amount }
    }
    const holding = input.holding ?? 0n
    // The other bots' own of the same token on the same wallet, where their entries said what they received.
    let othersRaw = 0n
    for (const o of this.positions.values()) {
      if (o.id === p.id || o.closedAt || o.mode !== "live" || o.wallet !== p.wallet || o.mint !== p.mint) continue
      othersRaw += this.remainingRaw(o) ?? 0n
    }
    let own = left ?? 0n
    let unreadWords = ""
    if (left === undefined) {
      // Candle's answer didn't say what this buy received (it was read back by its id). What else the wallet holds of
      // the token is the person's, so the bot's own is worked out from what it spent and Candle's first price after
      // its fill, and never more than the wallet holds less other bots' own.
      const said = `Candle's answer didn't say what this bot's buy received`
      // No price came near its buy, and none can now: its own can never be worked out, so the bot sells none of it.
      if (p.markUsd === undefined && !this.inMarkWindow(p, (this.deps.now ?? Date.now)())) {
        return { by: "none", words: `${said}, and Candle gave no price for ${label} within a minute of it, so what's its own of the wallet's ${label} can't be worked out. This bot sells none of it: the wallet's ${label} is yours to sell.` }
      }
      if (p.costUsd === undefined || p.markUsd === undefined || !(p.markUsd > 0) || decimals === undefined) {
        const missing = decimals === undefined ? "the token's decimals aren't known" : p.costUsd === undefined ? "what it spent has no dollar value" : `Candle has given no price for ${label} since`
        return { by: "none", wait: true, words: `${said}, and ${missing}, so what's its own of the wallet's ${label} can't be worked out yet. Nothing is sold until it can: the rest of the wallet's ${label} may be yours.` }
      }
      const priced = BigInt(Math.floor((p.costUsd / p.markUsd) * 10 ** decimals))
      // Never more than the quote's expected out plus the slippage bound: no fill can have received more.
      const estimate = p.capRaw !== undefined && BigInt(p.capRaw) < priced ? BigInt(p.capRaw) : priced
      const room = holding > othersRaw ? holding - othersRaw : 0n
      own = estimate < room ? estimate : room
      unreadWords = `${said}, so it sells about what its $${p.costUsd.toFixed(2)} bought at Candle's first price after it. `
    }
    if (own === 0n) return { by: "none", words: `${unreadWords}This bot holds no ${label} to sell.`.trim() }
    if (holding === 0n) {
      return { by: "none", outsideRaw: own, words: `${unreadWords}The wallet holds no ${label} now: this bot's position, ${this.tokens(own, decimals, label)}, was sold outside the bot.`.trim() }
    }
    // A wallet holding less than the bots' own: what's there is shared in proportion, and the rest was sold outside.
    const claimed = own + othersRaw
    const available = holding >= claimed ? own : othersRaw === 0n ? holding : (holding * own) / claimed
    const outsideRaw = own > available ? own - available : undefined
    const outsideWords = outsideRaw ? `The wallet held less than this bot's position: ${this.tokens(outsideRaw, decimals, label)} sold outside the bot. ` : ""
    const words = `${unreadWords}${outsideWords}`.trim() || undefined
    if (available === 0n) return { by: "none", ...(outsideRaw ? { outsideRaw } : {}), words: words ?? `This bot holds no ${label} to sell.` }
    const amount = amountOf(available)
    if (input.byAmount && amount !== undefined) return { by: "amount", amountRaw: available, amount, ...(outsideRaw ? { outsideRaw } : {}), ...(words ? { words } : {}) }
    // By percent of the wallet's balance, rounded down so it never sells more than its own; all of it when it holds all.
    const percent = available >= holding ? 100 : Number((available * 100n) / holding)
    if (percent === 0) {
      return {
        by: "none",
        ...(outsideRaw ? { outsideRaw } : {}),
        words: `${words ? `${words} ` : ""}This bot's ${label} is under 1% of what the wallet holds, and this wallet sells by whole percent, so selling it would sell other holdings too. A wallet of its own keeps this bot's book exact.`,
      }
    }
    return { by: "percent", percent, ownRaw: available, ...(outsideRaw ? { outsideRaw } : {}), ...(words ? { words } : {}) }
  }

  /** Whether a price taken at `at` (ms) is near enough the position's buy to size what that buy received. */
  private inMarkWindow(p: BotPosition, at: number): boolean {
    const sent = Date.parse(p.sentAt ?? p.entryAt)
    return Number.isFinite(sent) && at >= sent && at - sent <= MARK_WINDOW_MS
  }

  /** Writes the peaks now, as the core stops. */
  flush(): void {
    this.peaksTimer?.()
    this.peaksTimer = undefined
    if (this.peaksDirty) this.writePeaks()
  }

  private tokens(raw: bigint, decimals: number | undefined, label: string): string {
    return decimals === undefined ? `${raw} raw units of ${label}` : `${fromRaw(raw, decimals)} ${label}`
  }

  /** Applies a row; whether it changed the book. */
  private apply(row: JournalRow): boolean {
    if (row.type === "card.created" && typeof row.opId === "string") {
      const trade = botTradeOf(row)
      if (trade) this.trades.set(row.opId, trade)
      return false
    }
    // When the trade was first sent: a read-back buy's mark is taken near it.
    if (row.type === "operation.submitting" && typeof row.opId === "string") {
      const trade = this.trades.get(row.opId)
      if (trade && trade.sentAt === undefined) trade.sentAt = row.at
      return false
    }
    // The card's value, for a fill whose pair asset had no price when it settled.
    if (row.type === "card.approved" && typeof row.opId === "string" && typeof row.usd === "number") {
      const trade = this.trades.get(row.opId)
      if (trade) trade.usd = row.usd
      return false
    }
    if (row.type === "operation.succeeded" && typeof row.opId === "string") {
      const trade = this.trades.get(row.opId)
      const fill = fillOfRow(row)
      if (!trade || this.applied.has(row.opId)) return false
      // An exit that sold with an answer the book can't read still closed its position: it's never sold again.
      if (!fill) return trade.act === "exit" ? this.closeUnread(row.opId, row.at, trade) : false
      this.applied.add(row.opId)
      return this.fill(row.opId, row.at, trade, fill, fill.paper ? "paper" : "live")
    }
    // An exit that found nothing of the bot's own left to sell: the position is given up, with what was sold outside it.
    if (row.type === "bot.position_left" && typeof row.position === "string") {
      const p = this.positions.get(row.position)
      if (!p || p.closedAt) return false
      p.closedAt = row.at
      p.left = true
      if (typeof row.outsideRaw === "string" && /^\d+$/.test(row.outsideRaw)) p.outsideRaw = String(BigInt(p.outsideRaw ?? "0") + BigInt(row.outsideRaw))
      return true
    }
    // Its bot was removed: every position still open under the name ends here, sold or left, and every one it ever
    // had leaves the name's book, so nothing passes to a bot saved under that name later.
    if (row.type === "bot.removed" && typeof row.name === "string") {
      let changed = false
      for (const p of this.positions.values()) {
        if (p.bot !== row.name || p.past) continue
        p.past = true
        changed = true
        if (p.closedAt) continue
        p.closedAt = row.at
        p.left = true
        p.removed = true
      }
      // A buy of its still on its way fills into the wallet after it: left there too, never a later bot's.
      for (const [opId, trade] of this.trades) if (trade.bot === row.name && trade.act === "entry" && !this.applied.has(opId)) trade.removedAt = row.at
      return changed
    }
    if (row.type === "paper.call") {
      const trade = botTradeOf(row)
      const fill = fillOfRow(row)
      const id = `paper:${row.seq}`
      if (!trade || !fill || row.isError === true || this.applied.has(id)) return false
      this.applied.add(id)
      return this.fill(id, row.at, trade, fill, "paper")
    }
    return false
  }

  /** Whether a sell's fill still lands on a position: an open one, or one closed by its bot's removal with the sell under way. */
  private takesExit(p: BotPosition | undefined): p is BotPosition {
    return p !== undefined && (!p.closedAt || p.removed === true)
  }

  private closeUnread(id: string, at: string, trade: BotTrade): boolean {
    const p = trade.position ? this.positions.get(trade.position) : undefined
    if (!this.takesExit(p)) return false
    this.applied.add(id)
    p.exits.push({ id, at, ...(trade.reason ? { reason: trade.reason } : {}) })
    p.closedAt ??= at
    return true
  }

  private fill(id: string, at: string, trade: BotTrade, fill: Fill, mode: "paper" | "live"): boolean {
    const net = netAssetRaw(fill)
    const usd = assetDollars(fill.asset, net, fill.assetUsd)
    if (trade.act === "entry") {
      if (fill.side !== "buy" || this.positions.has(id)) return false
      this.positions.set(id, {
        id,
        bot: trade.bot,
        agent: trade.agent,
        wallet: fill.wallet,
        mode,
        mint: fill.mint,
        ...chainField(fill.chain),
        asset: fill.asset,
        ...(fill.tokensRaw !== undefined ? { tokensRaw: fill.tokensRaw } : {}),
        ...(fill.tokenDecimals !== undefined ? { decimals: fill.tokenDecimals } : {}),
        ...(net !== undefined ? { costRaw: String(net) } : {}),
        ...((usd ?? trade.usd) !== undefined ? { costUsd: usd ?? trade.usd } : {}),
        entryAt: at,
        ...(trade.sentAt ? { sentAt: trade.sentAt } : {}),
        ...(trade.capRaw ? { capRaw: trade.capRaw } : {}),
        ...(trade.signal !== undefined ? { signal: trade.signal } : {}),
        soldRaw: "0",
        exits: [],
        ...(trade.removedAt ? { closedAt: at, left: true, removed: true, past: true } : {}),
      })
      // Its entry price is where its peak starts.
      const p = this.positions.get(id)!
      const entry = this.entryPriceUsd(p)
      if (entry !== undefined) p.peakUsd = entry
      return true
    }
    if (fill.side !== "sell") return false
    // An exit names its position; one that doesn't sells the bot's oldest open position in the token.
    const p =
      (trade.position ? this.positions.get(trade.position) : undefined) ??
      this.open(trade.bot, mode).find((o) => sameAddress(o.mint, fill.mint) && o.wallet === fill.wallet)
    if (!this.takesExit(p)) return false
    p.exits.push({
      id,
      at,
      ...(trade.reason ? { reason: trade.reason } : {}),
      ...(fill.tokensRaw !== undefined ? { tokensRaw: fill.tokensRaw } : {}),
      ...(net !== undefined ? { proceedsRaw: String(net) } : {}),
      ...((usd ?? trade.usd) !== undefined ? { proceedsUsd: usd ?? trade.usd } : {}),
    })
    p.soldRaw = String(BigInt(p.soldRaw) + BigInt(fill.tokensRaw ?? trade.sellsRaw ?? "0"))
    if (trade.outsideRaw) p.outsideRaw = String(BigInt(p.outsideRaw ?? "0") + BigInt(trade.outsideRaw))
    if (fill.tokenDecimals !== undefined && p.decimals === undefined) p.decimals = fill.tokenDecimals
    // A bot's exit sells its whole position: what a percent sell rounded down stays in the wallet, unclaimed. A code
    // bot's sell of part of one leaves it open while it holds anything, as far as its entry said what it received.
    if (trade.partial && p.tokensRaw !== undefined && BigInt(p.soldRaw) < BigInt(p.tokensRaw)) return true
    p.closedAt ??= at
    return true
  }

  private schedulePeaks(): void {
    if (!this.deps.statePath || this.peaksTimer) return
    const schedule =
      this.deps.schedule ??
      ((run: () => void, ms: number) => {
        const t = setTimeout(run, ms)
        t.unref?.()
        return () => clearTimeout(t)
      })
    this.peaksTimer = schedule(() => {
      this.peaksTimer = undefined
      this.writePeaks()
    }, PEAKS_WRITE_MS)
  }

  private writePeaks(): void {
    if (!this.deps.statePath) return
    this.peaksDirty = false
    const peaks: Record<string, number> = {}
    const marks: Record<string, number> = {}
    const marksAt: Record<string, number> = {}
    for (const p of this.positions.values()) {
      if (p.closedAt) continue
      if (p.peakUsd !== undefined) peaks[p.id] = p.peakUsd
      const at = this.markAt.get(p.id)
      if (p.markUsd !== undefined && at !== undefined) {
        marks[p.id] = p.markUsd
        marksAt[p.id] = at
      }
    }
    try {
      const temp = `${this.deps.statePath}.tmp-${randomBytes(6).toString("base64url")}`
      writeFileSync(temp, `${JSON.stringify({ peaks, ...(Object.keys(marks).length ? { marks, marksAt } : {}) } satisfies PeaksFile)}\n`, { mode: 0o600, flag: "wx" })
      renameSync(temp, this.deps.statePath)
    } catch {
      this.peaksDirty = true
    }
  }
}
