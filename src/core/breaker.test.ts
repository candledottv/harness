// The pace the core's own trades keep to on a key, and the pairs Candle's route breaker refuses, from the journal.
import { describe, expect, test } from "bun:test"
import { BREAKER_TRADES, PACE_TRADES, RouteWaits, SELL_ROOM, TradePace } from "./breaker"
import { refusalMessage, routeWaitFields } from "./execute"
import type { JournalRow } from "./journal"

const T0 = Date.parse("2026-11-06T12:00:00Z")
const MOON = "MoonFake11111111111111111111111111111111111"
let seq = 0
const row = (type: string, at: number, fields: Record<string, unknown> = {}): JournalRow => ({ seq: ++seq, at: new Date(at).toISOString(), account: "acct", mode: "live", type, ...fields }) as JournalRow

describe("the pace", () => {
  test("the core's slots keep to 20 in 75 s on a key, two-thirds of Candle's 30 a minute; the next frees as the oldest turns 75 s", () => {
    expect(PACE_TRADES).toBeLessThan(BREAKER_TRADES)
    const pace = new TradePace()
    for (let i = 0; i < PACE_TRADES; i++) expect(pace.take("momentum", T0 + i * 1000).ok).toBe(true)
    const full = pace.take("momentum", T0 + 30_000)
    expect(full).toEqual({ ok: false, until: T0 + 75_000, words: "momentum's key made 20 trades in the last 75 s, and Candle's breaker stops a key at 30 in a minute: bots and triggers keep to 20 in 75 s" })
    // Another key isn't affected.
    expect(pace.take("swing", T0 + 30_000).ok).toBe(true)
    // A minute on isn't enough: the first slot is held until 75 s, so a burst that reached Candle late can't share its minute.
    expect(pace.take("momentum", T0 + 60_001).ok).toBe(false)
    expect(pace.take("momentum", T0 + 75_001).ok).toBe(true)
  })

  test("buys and swaps take at most 15 of the 20: the last 5 are a sell's, so a stop never waits behind a burst of entries", () => {
    const pace = new TradePace()
    for (let i = 0; i < PACE_TRADES - SELL_ROOM; i++) expect(pace.take("momentum", T0 + i * 1000, i % 2 ? "swap" : "buy").ok).toBe(true)
    const buy = pace.take("momentum", T0 + 20_000, "buy")
    expect(buy).toEqual({ ok: false, until: T0 + 75_000, words: "momentum's key made 15 trades in the last 75 s, and Candle's breaker stops a key at 30 in a minute: bots and triggers keep to 20 in 75 s, the last 5 for sells" })
    expect(pace.take("momentum", T0 + 20_000, "swap").ok).toBe(false)
    for (let i = 0; i < SELL_ROOM; i++) expect(pace.take("momentum", T0 + 21_000 + i, "sell").ok).toBe(true)
    expect(pace.take("momentum", T0 + 22_000, "sell").ok).toBe(false)
    // Every trade counts toward the 15: a buy goes again only once fewer than 15 are inside the 75 s.
    expect(pace.take("momentum", T0 + 79_001, "buy").ok).toBe(false) // 10 buys and 5 sells left
    expect(pace.take("momentum", T0 + 80_001, "sell").ok).toBe(true) // 9 buys and 5 sells: a sell takes the freed slot
    expect(pace.take("momentum", T0 + 80_002, "buy").ok).toBe(false) // 9 buys and 6 sells
    expect(pace.take("momentum", T0 + 81_001, "buy").ok).toBe(true) // 8 buys and 6 sells
  })

  test("while a sell waits for room, buys and swaps take no slot that frees: sells go first", () => {
    const pace = new TradePace()
    for (let i = 0; i < PACE_TRADES - SELL_ROOM; i++) expect(pace.take("momentum", T0 + i * 1000, "buy").ok).toBe(true)
    for (let i = 0; i < SELL_ROOM; i++) expect(pace.take("momentum", T0 + 15_000 + i * 1000, "sell").ok).toBe(true)
    const stop = pace.take("momentum", T0 + 30_000, "sell")
    expect(stop).toMatchObject({ ok: false, until: T0 + 75_000 })
    // Seven slots have freed by 81 s, so a buy had room under the 15; the waiting stop goes first.
    expect(pace.take("momentum", T0 + 81_000, "buy")).toEqual({ ok: false, until: T0 + 85_000, words: "a sell on momentum's key is waiting for room under Candle's breaker, and sells go first" })
    expect(pace.take("momentum", T0 + 81_000, "swap").ok).toBe(false)
    expect(pace.take("swing", T0 + 81_000, "buy").ok).toBe(true) // another key isn't held
    expect(pace.take("momentum", T0 + 82_000, "sell").ok).toBe(true)
    expect(pace.take("momentum", T0 + 82_001, "buy").ok).toBe(true)
  })

  test("a waiting sell that's never tried again holds buys only until it was due, plus a heartbeat's grace", () => {
    const pace = new TradePace()
    for (let i = 0; i < PACE_TRADES; i++) expect(pace.take("momentum", T0 + i * 1000, "sell").ok).toBe(true)
    expect(pace.take("momentum", T0 + 30_000, "sell").ok).toBe(false) // due at 75 s
    expect(pace.take("momentum", T0 + 84_999, "buy").ok).toBe(false)
    expect(pace.take("momentum", T0 + 85_000, "buy").ok).toBe(true)
  })

  test("two bursts of 20, each reaching Candle up to 15 s after it was sent, never put 30 inside one of Candle's minutes", () => {
    const pace = new TradePace()
    const sent: number[] = []
    for (let t = T0; t < T0 + 10 * 60_000; t += 250) if (pace.take("momentum", t).ok) sent.push(t)
    // The worst case at Candle: every trade of one burst delayed 15 s, the next on time.
    for (let i = 0; i < sent.length; i++) {
      const arrived = sent.map((t, j) => (j <= i ? t + 15_000 : t)).sort((a, b) => a - b)
      for (let a = 0, b = 0; b < arrived.length; b++) {
        while (arrived[b]! - arrived[a]! >= 60_000) a++
        expect(b - a + 1).toBeLessThan(BREAKER_TRADES)
      }
    }
  })

  test("the person's and the agent's trades count, live and paper; a core trade isn't counted twice when it's sent", () => {
    const pace = new TradePace([
      row("operation.submitting", T0, { agent: "momentum", kind: "trade", opId: "op-1" }),
      row("operation.submitting", T0, { agent: "momentum", kind: "swap", opId: "op-2" }),
      row("paper.call", T0, { agent: "momentum", tool: "candle_trade", role: "harness" }),
      // Not trades: a launch, a read.
      row("operation.submitting", T0, { agent: "momentum", kind: "launch", opId: "op-3" }),
      row("paper.call", T0, { agent: "momentum", tool: "candle_get_market", role: "view" }),
    ])
    expect(pace.used("momentum", T0 + 1)).toBe(3)
    // The core's own: its slot is taken when proposed, so its card and its submission add nothing.
    expect(pace.take("momentum", T0 + 2).ok).toBe(true)
    pace.note(row("card.created", T0 + 2, { agent: "momentum", role: "core", opId: "op-core" }))
    pace.note(row("operation.submitting", T0 + 3, { agent: "momentum", kind: "trade", opId: "op-core" }))
    pace.note(row("paper.call", T0 + 3, { agent: "momentum", tool: "candle_trade", role: "core" }))
    expect(pace.used("momentum", T0 + 4)).toBe(4)
    expect(pace.used("momentum", T0 + 75_001)).toBe(1)
  })
})

describe("the pace after a restart", () => {
  const coreTrades = (n: number, at: number) =>
    Array.from({ length: n }, (_, i) => [
      row("card.created", at, { agent: "momentum", role: "core", opId: `op-${i}` }),
      row("operation.submitting", at, { agent: "momentum", kind: "trade", opId: `op-${i}` }),
    ]).flat()

  test("the core's own trades count when the pace is read back from the journal, as they did in the core that sent them", () => {
    const sent = T0 - 10_000
    const running = new TradePace()
    for (let i = 0; i < 18; i++) expect(running.take("momentum", sent).ok).toBe(true)
    const rows = coreTrades(18, sent)
    for (const r of rows) running.note(r)
    expect(running.used("momentum", T0)).toBe(18)
    const rebuilt = new TradePace(rows)
    expect(rebuilt.used("momentum", T0)).toBe(18)
    // Two more sells take the pace to its 20; the next waits for the first slot to free.
    expect(rebuilt.take("momentum", T0).ok).toBe(true)
    expect(rebuilt.take("momentum", T0).ok).toBe(true)
    expect(rebuilt.take("momentum", T0)).toMatchObject({ ok: false, until: sent + 75_000 })
  })

  test("the core's own paper trades count in the read-back too, once each", () => {
    const rebuilt = new TradePace([
      row("paper.call", T0, { agent: "momentum", tool: "candle_trade", role: "core" }),
      row("paper.call", T0, { agent: "momentum", tool: "candle_trade", role: "core" }),
    ])
    expect(rebuilt.used("momentum", T0 + 1)).toBe(2)
  })
})

describe("a failing route", () => {
  const card = (opId: string, side = "buy", mint = MOON) => row("card.created", T0, { agent: "momentum", opId, mint, side })
  const refusedRow = (opId: string, at: number, error: Record<string, unknown>) => row("operation.refused", at, { agent: "momentum", opId, error })

  test("SWAP_ROUTE_FAILING holds that token and side on that key for Candle's retry_after_seconds, and no other", () => {
    const waits = new RouteWaits([card("op-1"), refusedRow("op-1", T0, { code: "SWAP_ROUTE_FAILING", retryAfterSeconds: 120 })])
    expect(waits.held("momentum", MOON, "buy", T0 + 1000)).toBe(T0 + 120_000)
    expect(waits.held("momentum", MOON, "sell", T0 + 1000)).toBeUndefined()
    expect(waits.held("swing", MOON, "buy", T0 + 1000)).toBeUndefined()
    expect(waits.words("momentum", "MOON", "buy", T0 + 120_000, T0 + 1000)).toBe("Candle is refusing buys of MOON from momentum's key for 119 s more, after five failed swaps of it in a row")
    expect(waits.held("momentum", MOON, "buy", T0 + 120_000)).toBeUndefined()
  })

  test("with no wait in Candle's answer, a minute; a confirmed swap of the pair ends it", () => {
    const waits = new RouteWaits([card("op-1"), refusedRow("op-1", T0, { code: "SWAP_ROUTE_FAILING" })])
    expect(waits.held("momentum", MOON, "buy", T0)).toBe(T0 + 60_000)
    waits.note(card("op-2"))
    waits.note(row("operation.succeeded", T0 + 5000, { agent: "momentum", opId: "op-2" }))
    expect(waits.held("momentum", MOON, "buy", T0 + 6000)).toBeUndefined()
  })

  test("Candle's wait is read from the error or its details, and said in words", () => {
    expect(routeWaitFields({ retry_after_seconds: 90 })).toEqual({ retryAfterSeconds: 90 })
    expect(routeWaitFields({ details: { retry_after_seconds: 300 } })).toEqual({ retryAfterSeconds: 300 })
    expect(routeWaitFields({ retry_after_seconds: "soon" })).toEqual({})
    expect(refusalMessage("SWAP_ROUTE_FAILING", { retry_after_seconds: 90 })).toBe("Candle is refusing this token on this side from this key for now: its last five swaps of it failed. Nothing was sent. It can be tried again in 90 s. Other tokens aren't affected.")
  })
})
