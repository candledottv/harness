// Each rules bot's book as the Bots tab shows it: its open positions with their exits as prices against the price
// now (the stop, the take profit, the trailing level once armed, when its hold ends), what it realized in all and
// today, its exits by why, its skips over the last day, its newest fills, and the backtest of its exact definition.
// The Candle Harness's count from the bot's own fills, apart from Candle's books. Pure: the core hands it what it holds.
import type { Exit } from "../shared/definition"
import type { BotPosition, BotPositions } from "./bot-book"
import type { Backtest } from "./bots-tool"

export interface BotPositionView {
  /** Its entry's operation id, or `paper:<seq>`. */
  id: string
  mint: string
  token: string
  since: string
  costUsd?: number
  /** Per token, with Candle's fee in it; Candle's first price after the entry where its own can't be said. */
  entryUsd?: number
  entryIsMark?: true
  nowUsd?: number
  /** Candle has had no price for it since then: its figure now and its exits that need a price wait for one. */
  noPriceSince?: string
  /** The highest price since its entry, the price now included. */
  peakUsd?: number
  unrealizedUsd?: number
  /** Its exits, as prices: each where the definition has it. */
  stopUsd?: number
  targetUsd?: number
  /** A trailing exit: armed once the price reached `armUsd`; then it sells under `sellsUnderUsd`. */
  trail?: { armUsd: number; dropPct: number; armed: boolean; sellsUnderUsd?: number }
  /** When its hold runs out. */
  holdUntil?: string
}

/** One of its newest fills: a buy in or a sell out, its token, and for a sell, why and what it made. */
export interface BotFillView {
  at: string
  act: "in" | "out"
  token: string
  usd?: number
  reason?: string
  realizedUsd?: number
}

export interface BotBookView {
  open: BotPositionView[]
  closed: number
  realizedUsd: number
  /** What its exits realized since local midnight. */
  todayUsd: number
  /** Its open positions' worth now less their cost, where each could be valued. */
  unrealizedUsd?: number
  /** Every closed position's figures were valued. */
  valued: boolean
  /** Its exits by why, most first: "take_profit", "stop_loss", "trailing_stop", "max_hold", "flatten". */
  exitsBy: { reason: string; count: number }[]
  /** Its skips over the last day, by why, most first. */
  skips?: { total: number; by: { why: string; count: number }[] }
  /** Its newest fills, newest first. */
  recent: BotFillView[]
  /** The newest backtest of its exact definition; else whether its plan reaches the lab, for why there's none. */
  backtest?: Backtest
  lab: boolean
}

const RECENT = 4
const sig = (n: number) => Number(n.toPrecision(6))
const cents = (n: number) => Number(n.toFixed(2))

/** Its exits as prices from its entry: each the definition has, and the trailing level once the peak armed it. */
export function exitLevels(x: Exit | undefined, entry: number | undefined, peak: number | undefined, entryAt: string): Pick<BotPositionView, "stopUsd" | "targetUsd" | "trail" | "holdUntil"> {
  const out: Pick<BotPositionView, "stopUsd" | "targetUsd" | "trail" | "holdUntil"> = {}
  if (!x) return out
  if (entry !== undefined && entry > 0) {
    if (x.stop_loss_pct !== undefined) out.stopUsd = sig(entry * (1 - x.stop_loss_pct / 100))
    if (x.take_profit_pct !== undefined) out.targetUsd = sig(entry * (1 + x.take_profit_pct / 100))
    if (x.trailing) {
      const armUsd = sig(entry * x.trailing.arm_multiple)
      const armed = peak !== undefined && peak >= entry * x.trailing.arm_multiple
      out.trail = { armUsd, dropPct: x.trailing.drop_pct, armed, ...(armed ? { sellsUnderUsd: sig(peak! * (1 - x.trailing.drop_pct / 100)) } : {}) }
    }
  }
  if (x.max_hold_hours !== undefined) out.holdUntil = new Date(Date.parse(entryAt) + x.max_hold_hours * 3_600_000).toISOString()
  return out
}

export interface BotBookInput {
  name: string
  mode: "paper" | "live"
  exit: Exit | undefined
  /** A position's own exits, where each has its own (a code bot's, held by the core): over `exit`. */
  exitOf?(p: BotPosition): Exit | undefined
  positions: BotPositions
  /** Candle's newest price for a token, where the core holds one. */
  priceOf(mint: string): number | undefined
  /** A position's price now, where the core says which reading is one of its (fresh, and after its fill): over `priceOf`. */
  priceFor?(p: BotPosition): number | undefined
  /** Since when a position has had no price from Candle, where its exits said so. */
  unpricedSince?(position: string): number | undefined
  symbolOf(mint: string): string
  skips?: BotBookView["skips"]
  backtest?: Backtest
  lab: boolean
  now: number
}

/** A bot's book, from its own positions, at the prices the core holds now. */
export function botBook(i: BotBookInput): BotBookView {
  const all = i.positions.of(i.name, i.mode)
  const totals = i.positions.totals(i.name, i.mode)
  const midnight = new Date(i.now).setHours(0, 0, 0, 0)
  const today = i.positions.realizedBetween(i.name, midnight, i.now, i.mode)
  let unrealized: number | undefined
  const open = all
    .filter((p) => !p.closedAt)
    .map((p): BotPositionView => {
      const now = i.priceFor ? i.priceFor(p) : i.priceOf(p.mint)
      const unpriced = now === undefined ? i.unpricedSince?.(p.id) : undefined
      const own = i.positions.entryPriceUsd(p)
      const entry = own ?? p.markUsd
      const peak = Math.max(p.peakUsd ?? 0, now ?? 0) || undefined
      const up = now !== undefined ? i.positions.unrealizedUsd(p, now) : undefined
      if (up !== undefined) unrealized = (unrealized ?? 0) + up
      return {
        id: p.id,
        mint: p.mint,
        token: i.symbolOf(p.mint),
        since: p.entryAt,
        ...(p.costUsd !== undefined ? { costUsd: cents(p.costUsd) } : {}),
        ...(entry !== undefined ? { entryUsd: sig(entry) } : {}),
        ...(own === undefined && entry !== undefined ? { entryIsMark: true as const } : {}),
        ...(now !== undefined ? { nowUsd: sig(now) } : {}),
        ...(unpriced !== undefined ? { noPriceSince: new Date(unpriced).toISOString() } : {}),
        ...(peak !== undefined ? { peakUsd: sig(peak) } : {}),
        ...(up !== undefined ? { unrealizedUsd: cents(up) } : {}),
        ...exitLevels(i.exitOf ? i.exitOf(p) : i.exit, entry, peak, p.entryAt),
      }
    })
    .sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
  const by = new Map<string, number>()
  for (const p of all) if (p.closedAt) for (const e of p.exits.slice(-1)) by.set(e.reason ?? "sold", (by.get(e.reason ?? "sold") ?? 0) + 1)
  return {
    open,
    closed: totals.closed,
    realizedUsd: cents(totals.realizedUsd),
    todayUsd: cents(today.usd),
    ...(unrealized !== undefined ? { unrealizedUsd: cents(unrealized) } : {}),
    valued: totals.valued && today.valued,
    exitsBy: [...by].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    ...(i.skips?.total ? { skips: i.skips } : {}),
    recent: recentFills(all, i.positions, i.symbolOf),
    ...(i.backtest ? { backtest: i.backtest } : {}),
    lab: i.lab,
  }
}

/** Its newest fills, from its positions: each entry, and each exit with what it realized. */
function recentFills(all: readonly BotPosition[], positions: BotPositions, symbolOf: (mint: string) => string): BotFillView[] {
  const fills: BotFillView[] = []
  for (const p of all) {
    const token = symbolOf(p.mint)
    fills.push({ at: p.entryAt, act: "in", token, ...(p.costUsd !== undefined ? { usd: cents(p.costUsd) } : {}) })
    for (const e of p.exits) {
      const tokens = p.tokensRaw === undefined ? undefined : BigInt(p.tokensRaw)
      const share = e.tokensRaw !== undefined && tokens !== undefined && tokens > 0n ? Math.min(1, Number(BigInt(e.tokensRaw)) / Number(tokens)) : p.exits.length === 1 && p.closedAt ? 1 : undefined
      const made = e.proceedsUsd !== undefined && p.costUsd !== undefined && share !== undefined ? cents(e.proceedsUsd - p.costUsd * share) : undefined
      fills.push({ at: e.at, act: "out", token, ...(e.reason ? { reason: e.reason } : {}), ...(e.proceedsUsd !== undefined ? { usd: cents(e.proceedsUsd) } : {}), ...(made !== undefined ? { realizedUsd: made } : {}) })
    }
  }
  return fills.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, RECENT)
}
