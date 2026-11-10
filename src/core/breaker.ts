// Candle's circuit breaker, kept clear of by what the core trades on its own. Every profile carries one that nobody can
// turn off: 30 or more trades inside a rolling minute, or three failed sells of one token in a row, stop the key,
// sells included, until its owner resumes it in the Agent Console (docs.candle.tv/developers/agent-trading,
// "RISK_LIMIT_REACHED"). A rules bot and a trigger trade with their agent's key, so either could stop the agent too.
//
// - The pace: bots' and triggers' trades on one key keep to 20 in a rolling 75 seconds, two-thirds of the breaker's 30
//   in a minute. Candle counts a trade when it reaches it, which can be seconds after the core sends it (a TEE wallet's
//   trade starts the user's CLI first), so a slot is held 15 s past the minute: a burst that reaches Candle late can't
//   share Candle's minute with the next.
//   Everyone's trades on the key count (the person's, the agent's, a paper trade's), but only the core's own wait for
//   room: a person's or an agent's trade is never held. A slot is taken when the core's trade is proposed, before
//   anything is awaited, so ten bots firing together can't pass it together. Buys and swaps take at most 15 of the 20:
//   the last 5 are kept for sells. And while a sell on the key waits for room, no buy or swap takes a slot that frees:
//   sells go first, so a stop never waits behind a stream of new entries.
// - A failing route: with Candle's route breaker on, five failed swaps in a row of one token and side refuse that pair
//   from the key until `retry_after_seconds` (SWAP_ROUTE_FAILING). The core's own trades of that pair wait it out; a
//   confirmed swap of the pair ends the wait. Other tokens and sides aren't affected.
// - Failed sells are counted in failed-sells.ts.
import type { JournalRow } from "./journal"
import type { Side } from "./limits"

/** Candle stops a key at this many trades inside a rolling minute. */
export const BREAKER_TRADES = 30
/** The core's own trades keep to this many on a key inside a rolling `PACE_WINDOW_MS`. */
export const PACE_TRADES = 20
/** Of those, slots only a sell may take: a stop or take profit never waits behind a burst of new buys. */
export const SELL_ROOM = 5
/** Candle's minute, plus 15 s for a trade that reaches Candle after the core sent it. */
export const PACE_WINDOW_MS = 75_000
/** A waiting sell holds buys back until it's due, plus this, for the heartbeat that tries it again. */
const SELL_FIRST_GRACE_MS = 10_000
/** A failing route with no wait in Candle's answer: asked again after a minute. */
const ROUTE_WAIT_MS = 60_000

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const TRADE_KINDS = new Set(["trade", "swap"])

const sellFirstWords = (agent: string) => `a sell on ${agent}'s key is waiting for room under Candle's breaker, and sells go first`

export const paceWords = (agent: string, side: Side = "sell") =>
  side === "sell"
    ? `${agent}'s key made ${PACE_TRADES} trades in the last ${PACE_WINDOW_MS / 1000} s, and Candle's breaker stops a key at ${BREAKER_TRADES} in a minute: bots and triggers keep to ${PACE_TRADES} in ${PACE_WINDOW_MS / 1000} s`
    : `${agent}'s key made ${PACE_TRADES - SELL_ROOM} trades in the last ${PACE_WINDOW_MS / 1000} s, and Candle's breaker stops a key at ${BREAKER_TRADES} in a minute: bots and triggers keep to ${PACE_TRADES} in ${PACE_WINDOW_MS / 1000} s, the last ${SELL_ROOM} for sells`

export class TradePace {
  /** Each key's trades in the last 75 s, by agent: when each was sent, or a core trade's slot taken. */
  private readonly stamps = new Map<string, number[]>()
  /** Trades the core proposed itself, by operation id: counted when their slot was taken, not again when sent. */
  private readonly core = new Set<string>()
  /** Each key with a sell waiting for room: until when buys and swaps are held back for it. */
  private readonly sellWaiting = new Map<string, number>()

  /**
   * From the journal's rows, as after a restart. The core's own trades count here too: their slots were taken in the
   * memory of the core that sent them, so the rows are all that's left to say the key made them.
   */
  constructor(rows: readonly JournalRow[] = []) {
    for (const row of rows) this.note(row, true)
  }

  /**
   * A journal row, as it's appended: a trade sent on a key by anyone but the core's own slots, which `take` counted.
   * `rebuilding` is the constructor's read of old rows, where nothing was taken and the core's own count as well.
   */
  note(row: JournalRow, rebuilding = false): void {
    if (row.type === "card.created" && row.role === "core" && typeof row.opId === "string") {
      this.core.add(row.opId)
      return
    }
    const agent = typeof row.agent === "string" ? row.agent : undefined
    if (!agent) return
    const at = Date.parse(row.at)
    if (!Number.isFinite(at)) return
    if (row.type === "operation.submitting" && TRADE_KINDS.has(String(row.kind)) && typeof row.opId === "string") {
      if (this.core.delete(row.opId) && !rebuilding) return
      this.stamp(agent, at)
    } else if (row.type === "paper.call" && row.tool === "candle_trade" && (rebuilding || row.role !== "core")) {
      this.stamp(agent, at)
    }
  }

  /** Trades on an agent's key inside the 75 s to `now`. */
  used(agent: string, now: number): number {
    return this.live(agent, now).length
  }

  /**
   * A slot for the core's own trade on this key now: taken when there's room, or when the next slot frees. Taken here,
   * with nothing awaited, so two callers can't both take the last one. A buy or swap leaves the last `SELL_ROOM` for sells,
   * and takes nothing while a sell on the key waits for room.
   */
  take(agent: string, now: number, side: Side = "sell"): { ok: true } | { ok: false; until: number; words: string } {
    const times = this.live(agent, now)
    const sell = side === "sell"
    if (!sell) {
      const held = this.sellWaiting.get(agent)
      if (held !== undefined && held > now) return { ok: false, until: held, words: sellFirstWords(agent) }
      this.sellWaiting.delete(agent)
    }
    const cap = sell ? PACE_TRADES : PACE_TRADES - SELL_ROOM
    if (times.length >= cap) {
      const until = times[times.length - cap]! + PACE_WINDOW_MS
      if (sell) this.sellWaiting.set(agent, until + SELL_FIRST_GRACE_MS)
      return { ok: false, until, words: paceWords(agent, side) }
    }
    if (sell) this.sellWaiting.delete(agent)
    times.push(now)
    return { ok: true }
  }

  private stamp(agent: string, at: number): void {
    const times = this.stamps.get(agent) ?? []
    times.push(at)
    times.sort((a, b) => a - b)
    this.stamps.set(agent, times)
  }

  private live(agent: string, now: number): number[] {
    const times = (this.stamps.get(agent) ?? []).filter((t) => t > now - PACE_WINDOW_MS)
    this.stamps.set(agent, times)
    return times
  }
}

const routeKey = (agent: string, mint: string, side: Side) => `${agent}\n${mint}\n${side}`

/** The pairs Candle's route breaker refuses on a key now, from the journal. */
export class RouteWaits {
  /** Each trade's agent, token and side, by its operation id, from its card. */
  private readonly trades = new Map<string, { agent: string; mint: string; side: Side }>()
  private readonly until = new Map<string, number>()

  constructor(rows: readonly JournalRow[] = []) {
    for (const row of rows) this.note(row)
  }

  note(row: JournalRow): void {
    if (row.type === "card.created" && typeof row.opId === "string" && typeof row.agent === "string" && typeof row.mint === "string" && (row.side === "buy" || row.side === "sell")) {
      this.trades.set(row.opId, { agent: row.agent, mint: row.mint, side: row.side })
      return
    }
    const trade = typeof row.opId === "string" ? this.trades.get(row.opId) : undefined
    if (!trade) return
    const key = routeKey(trade.agent, trade.mint, trade.side)
    if (row.type === "operation.succeeded") {
      this.until.delete(key)
      return
    }
    const error = record(row.error)
    if ((row.type === "operation.refused" || row.type === "operation.failed") && error?.code === "SWAP_ROUTE_FAILING") {
      const seconds = typeof error.retryAfterSeconds === "number" && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : undefined
      const at = Date.parse(row.at)
      if (Number.isFinite(at)) this.until.set(key, at + (seconds !== undefined ? seconds * 1000 : ROUTE_WAIT_MS))
    }
  }

  /** When the pair may be tried again, while Candle refuses it. */
  held(agent: string, mint: string, side: Side, now: number): number | undefined {
    const key = routeKey(agent, mint, side)
    const until = this.until.get(key)
    if (until === undefined) return undefined
    if (now >= until) {
      this.until.delete(key)
      return undefined
    }
    return until
  }

  words(agent: string, label: string, side: Side, until: number, now: number): string {
    const s = Math.max(1, Math.ceil((until - now) / 1000))
    return `Candle is refusing ${side === "sell" ? "sells" : "buys"} of ${label} from ${agent}'s key for ${s < 120 ? `${s} s` : `${Math.ceil(s / 60)} minutes`} more, after five failed swaps of it in a row`
  }
}
