// A bot's book as the Bots tab shows it: its exits as prices from its entry, the trailing level once armed, its
// open positions at the prices the core holds, what it realized in all and today, its exits by why and its fills.
import { describe, expect, test } from "bun:test"
import type { BotPosition, BotPositions } from "./bot-book"
import { botBook, exitLevels } from "./bot-books"

const T0 = Date.parse("2026-11-06T14:30:00")
const WIF = "WifzFake111111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"

const position = (over: Partial<BotPosition>): BotPosition => ({ id: "op-1", bot: "conf", agent: "agent-a", wallet: "embedded", mode: "live", mint: WIF, asset: "SOL", entryAt: new Date(T0 - 7_800_000).toISOString(), soldRaw: "0", exits: [], ...over })

/** Just what botBook reads: each position's figures as set here. */
function positionsOf(all: BotPosition[], figures: { entry?: Record<string, number>; unrealized?: Record<string, number>; realized: number; today: number }): BotPositions {
  return {
    of: (bot: string, mode?: string) => all.filter((p) => p.bot === bot && (!mode || p.mode === mode)),
    totals: () => ({ open: all.filter((p) => !p.closedAt).length, closed: all.filter((p) => p.closedAt).length, realizedUsd: figures.realized, valued: true }),
    realizedBetween: () => ({ usd: figures.today, exits: 1, valued: true }),
    entryPriceUsd: (p: BotPosition) => figures.entry?.[p.id],
    unrealizedUsd: (p: BotPosition) => figures.unrealized?.[p.id],
  } as unknown as BotPositions
}

describe("exitLevels", () => {
  test("the stop, the target and the hold's end as prices and a time; the trailing level once the peak armed it", () => {
    const x = { stop_loss_pct: 40, take_profit_pct: 100, max_hold_hours: 24, trailing: { arm_multiple: 1.5, drop_pct: 20 } }
    const at = "2026-11-06T12:00:00.000Z"
    expect(exitLevels(x, 0.001204, 0.001806, at)).toEqual({ stopUsd: 0.0007224, targetUsd: 0.002408, trail: { armUsd: 0.001806, dropPct: 20, armed: true, sellsUnderUsd: 0.0014448 }, holdUntil: "2026-11-07T12:00:00.000Z" })
    // Not armed: no level to sell under yet.
    expect(exitLevels(x, 0.001204, 0.0013, at).trail).toEqual({ armUsd: 0.001806, dropPct: 20, armed: false })
    // With no entry price, only the hold, which needs none.
    expect(exitLevels(x, undefined, undefined, at)).toEqual({ holdUntil: "2026-11-07T12:00:00.000Z" })
    expect(exitLevels(undefined, 1, 1, at)).toEqual({})
  })
})

describe("botBook", () => {
  test("its open positions at the prices held, newest first, with their exits; its totals, exits by why and fills", () => {
    const closed = position({ id: "op-0", mint: MOON, entryAt: new Date(T0 - 9_000_000).toISOString(), closedAt: new Date(T0 - 3_000_000).toISOString(), costUsd: 2.01, exits: [{ id: "op-0x", at: new Date(T0 - 3_000_000).toISOString(), reason: "take_profit", proceedsUsd: 4.02 }] })
    const wif = position({ id: "op-1", costUsd: 2.01, peakUsd: 0.001806 })
    const bonk = position({ id: "op-2", mint: MOON, entryAt: new Date(T0 - 1_500_000).toISOString(), costUsd: 2 })
    const book = botBook({
      name: "conf",
      mode: "live",
      exit: { stop_loss_pct: 40, take_profit_pct: 100, trailing: { arm_multiple: 1.5, drop_pct: 20 } },
      positions: positionsOf([closed, wif, bonk], { entry: { "op-1": 0.001204 }, unrealized: { "op-1": 0.65 }, realized: 2.01, today: 2.01 }),
      priceOf: (mint) => (mint === WIF ? 0.001595 : undefined),
      symbolOf: (mint) => (mint === WIF ? "WIFZ" : "MOONQ"),
      skips: { total: 31, by: [{ why: "its market cap", count: 18 }] },
      lab: true,
      now: T0,
    })
    expect(book.open.map((p) => p.token)).toEqual(["MOONQ", "WIFZ"])
    expect(book.open[1]).toMatchObject({ entryUsd: 0.001204, nowUsd: 0.001595, peakUsd: 0.001806, unrealizedUsd: 0.65, costUsd: 2.01, stopUsd: 0.0007224, targetUsd: 0.002408, trail: { armed: true } })
    // No price on Candle yet: no figure is made up.
    expect(book.open[0]).not.toHaveProperty("nowUsd")
    expect(book.open[0]).not.toHaveProperty("stopUsd")
    expect(book).toMatchObject({ closed: 1, realizedUsd: 2.01, todayUsd: 2.01, unrealizedUsd: 0.65, valued: true, exitsBy: [{ reason: "take_profit", count: 1 }], skips: { total: 31 }, lab: true })
    expect(book.recent[0]).toEqual({ at: bonk.entryAt, act: "in", token: "MOONQ", usd: 2 })
    expect(book.recent.find((f) => f.act === "out")).toEqual({ at: closed.exits[0]!.at, act: "out", token: "MOONQ", reason: "take_profit", usd: 4.02, realizedUsd: 2.01 })
  })

  test("a price the core holds that isn't one of the position's is no figure: Candle has had none since, said with when", () => {
    const wif = position({ id: "op-1", costUsd: 2.01 })
    const since = T0 - 3_600_000
    const book = botBook({
      name: "conf",
      mode: "live",
      exit: { stop_loss_pct: 40, take_profit_pct: 100 },
      positions: positionsOf([wif], { entry: { "op-1": 0.001204 }, unrealized: { "op-1": 0.2 }, realized: 0, today: 0 }),
      // The last price held is an hour old: kept by the core, not the position's now.
      priceOf: () => 0.0013244,
      priceFor: () => undefined,
      unpricedSince: (id) => (id === "op-1" ? since : undefined),
      symbolOf: () => "TAOLF",
      lab: false,
      now: T0,
    })
    expect(book.open[0]).not.toHaveProperty("nowUsd")
    expect(book.open[0]).not.toHaveProperty("unrealizedUsd")
    expect(book.open[0]!.noPriceSince).toBe(new Date(since).toISOString())
    expect(book).not.toHaveProperty("unrealizedUsd")
  })

  test("before any trade: nothing open, nothing realized, and no skips said", () => {
    const book = botBook({ name: "conf", mode: "paper", exit: undefined, positions: positionsOf([], { realized: 0, today: 0 }), priceOf: () => undefined, symbolOf: () => "?", skips: { total: 0, by: [] }, lab: false, now: T0 })
    expect(book).toEqual({ open: [], closed: 0, realizedUsd: 0, todayUsd: 0, valued: true, exitsBy: [], recent: [], lab: false })
  })
})
