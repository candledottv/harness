// The token pane's chart: braille where there's room and enough samples, a sparkline
// otherwise; a stable scale, not rescaled to each tick; and a caption saying what it plots.
import { expect, test } from "bun:test"
import { brailleChart, candleCells, candlesOf, priceChart, sparkline } from "./chart"

test("sparkline maps low to ▁ and high to █ on the scale it's given", () => {
  expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8, { lo: 1, hi: 8 })).toBe("▁▂▃▄▅▆▇█")
  expect(sparkline([1, 2, 3], 2, { lo: 1, hi: 3 })).toBe("▅█")
})

test("braille chart has the requested size and plots the extremes", () => {
  expect(brailleChart([0, 1], 1, 1, { lo: 0, hi: 1 })).toEqual([String.fromCharCode(0x2800 | 0x40 | 0x08 | 0x10 | 0x20 | 0x80)])
  const big = brailleChart([...Array(100).keys()], 20, 5, { lo: 0, hi: 99 })
  expect(big).toHaveLength(5)
  expect(big.every((r) => [...r].length === 20)).toBe(true)
})

const at = (i: number) => 1_000_000 + i * 15_000
const series = (values: number[]) => values.map((usd, i) => ({ at: at(i), usd }))

test("the scale is the hour's range, so a new sample inside it doesn't move the axis labels", () => {
  const before = priceChart(series([0.6, 0.7, 0.65, 0.62, 0.66, 0.64, 0.63, 0.61, 0.69]), { width: 30, height: 6, symbol: "MOON", now: at(9) })
  const after = priceChart(series([0.6, 0.7, 0.65, 0.62, 0.66, 0.64, 0.63, 0.61, 0.69, 0.65]), { width: 30, height: 6, symbol: "MOON", now: at(10) })
  expect(before.kind).toBe("braille")
  expect(after.top).toBe(before.top)
  expect(after.bottom).toBe(before.bottom)
  expect(after.top).toBe("$0.7")
  expect(after.bottom).toBe("$0.6")
})

test("a flat series still has a span, so it draws as a line in the middle rather than filling the chart", () => {
  const c = priceChart(series(Array(12).fill(0.63)), { width: 20, height: 4, symbol: "MOON", now: at(12) })
  expect(c.top).not.toBe(c.bottom)
})

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

test("says what it plots and since when: the Candle Harness's own samples", () => {
  const c = priceChart(series([0.6, 0.61, 0.62, 0.63, 0.64, 0.65, 0.66, 0.67]), { width: 30, height: 6, symbol: "MOON", now: at(8) })
  expect(c.caption).toBe(`MOON price in USD, samples since ${hhmm(at(0))}`)
  expect(c.note).toBeUndefined()
})

// Hacc's hour at 1m, then the samples, on one time axis.
const MIN = 60_000
const NOW = 1_800_000_000_000
const withHistory = [
  ...Array.from({ length: 50 }, (_, i) => ({ at: NOW - (60 - i) * MIN, usd: 1 })),
  ...Array.from({ length: 120 }, (_, i) => ({ at: NOW - 10 * MIN + (i + 1) * 5_000, usd: 2 })),
]

test("plots by time, not by count: an hour of history keeps its share of the chart beside 120 samples", () => {
  const c = priceChart(withHistory, { width: 33, height: 2, symbol: "MOON", now: NOW, history: { source: "hacc" } })
  expect(c.kind).toBe("sparkline")
  const row = c.rows[0]!
  expect([...row]).toHaveLength(30)
  // 50 of 60 minutes at $1, then 10 at $2: five sixths low, the last sixth high.
  expect(row).toBe(`${"▁".repeat(25)}${"█".repeat(5)}`)
})

test("a gap between points holds the last price, as a market with no trades does", () => {
  const c = priceChart([{ at: NOW - 60 * MIN, usd: 1 }, { at: NOW - 30 * MIN, usd: 2 }, { at: NOW, usd: 2 }], { width: 13, height: 2, symbol: "MOON", now: NOW, history: { source: "hacc" } })
  expect(c.rows[0]).toBe(`${"▁".repeat(5)}${"█".repeat(5)}`)
})

test("with Hacc's history, says so and over what span", () => {
  const c = priceChart(withHistory, { width: 40, height: 6, symbol: "MOON", now: NOW, history: { source: "hacc" } })
  expect(c.kind).toBe("braille")
  expect(c.caption).toBe("MOON price in USD, last 60m: Hacc's history, then samples every 5s")
})

test("history that didn't load falls back to the samples, saying so", () => {
  const c = priceChart(series([0.6, 0.61, 0.62]), { width: 30, height: 6, symbol: "MOON", now: at(3), history: { source: "samples", words: "Hacc didn't answer in 5 s." } })
  expect(c.caption).toBe(`MOON price in USD, samples since ${hhmm(at(0))}`)
  expect(c.note).toBe("No history from Hacc: Hacc didn't answer in 5 s.")
})

test("too few samples, or too little room, is a sparkline; none at all says so", () => {
  expect(priceChart(series([0.6, 0.7]), { width: 30, height: 6, symbol: "MOON", now: at(2) }).kind).toBe("sparkline")
  expect(priceChart(series([0.6, 0.7, 0.65, 0.62, 0.66, 0.64, 0.63, 0.61, 0.69]), { width: 30, height: 2, symbol: "MOON", now: at(9) }).kind).toBe("sparkline")
  const none = priceChart([], { width: 30, height: 6, symbol: "MOON", now: at(0) })
  expect(none).toMatchObject({ kind: "none", rows: [] })
  expect(none.caption).toContain("no price samples yet")
  // One sample draws no axis: its label read as a second price.
  const one = priceChart(series([183]), { width: 30, height: 6, symbol: "ORE", now: at(0) })
  expect(one).toMatchObject({ kind: "none", rows: [], top: "", bottom: "" })
  expect(one.caption).toBe("ORE: one price sample so far; the chart starts with the next, in 5s")
})

// Two-minute candles.
const T = 1_800_000_000_000 - (1_800_000_000_000 % 120_000)
const minute = (i: number, open: number, close: number, high = Math.max(open, close), low = Math.min(open, close)) => ({ at: T - (20 - i) * 60_000, open, high, low, close })

test("candles: two of Hacc's minutes to a candle, ending at the current one; a candle with no trade is the close before it, flat", () => {
  const hacc = [minute(0, 1, 2), minute(1, 2, 3, 4, 1.5), minute(4, 3, 2.5)]
  const c = candlesOf(hacc, [], 24, T + 30_000)!
  expect(c).toHaveLength(12)
  // The 20 minutes before T are candles 1 to 10 of 12; minutes 0 and 1 are one candle.
  const first = c.findIndex((k) => k !== undefined)
  expect(c[first]).toEqual({ c: { at: T - 20 * 60_000, open: 1, high: 4, low: 1, close: 3 }, flat: false })
  expect(c[first + 1]).toMatchObject({ flat: true, c: { close: 3 } })
  expect(c[first + 2]).toMatchObject({ flat: false, c: { open: 3, close: 2.5 } })
  expect(c.slice(0, first).every((k) => k === undefined)).toBe(true)
  // Samples after Hacc's last minute make candles of their own.
  const live = candlesOf(hacc, [{ at: T + 5_000, usd: 2.4 }, { at: T + 25_000, usd: 2.9 }, { at: T + 50_000, usd: 2.7 }], 24, T + 55_000)!
  expect(live.at(-1)).toEqual({ c: { at: T, open: 2.4, high: 2.9, low: 2.4, close: 2.7 }, flat: false })
  expect(candlesOf([], [], 24, T)).toBeUndefined()
})

test("candle cells: a wick from high to low and a body from open to close, to half a row, green up and red down, a dash where nothing traded", () => {
  const rows = candleCells(
    [
      { c: { at: 0, open: 1, high: 4, low: 0, close: 3 }, flat: false },
      { c: { at: 0, open: 3, high: 3, low: 3, close: 3 }, flat: true },
      { c: { at: 0, open: 3, high: 3.5, low: 1, close: 2 }, flat: false },
    ],
    6,
    5,
    { lo: 0, hi: 4 },
  )
  // Ten half-rows over 0 to 4: the third candle's wick starts in the first row's lower half, and its body ends in the third row's upper half.
  expect(rows.map((r) => r.map((c) => c.text).join(""))).toEqual(["│   ╷ ", "┃ ─ ┃ ", "┃   ╿ ", "┃   │ ", "│     "])
  expect(rows[1]![0]!.tone).toBe("good")
  expect(rows[1]![2]!.tone).toBe("flat")
  expect(rows[2]![4]!.tone).toBe("bad")
})

test("the framed chart: candles where Hacc gave them, else the line over its area; three price labels, the last marked, a time axis", () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ at: T - (20 - i) * 60_000 + 60_000, usd: 1 + i * 0.05 }))
  const hacc = Array.from({ length: 20 }, (_, i) => minute(i, 1 + i * 0.05, 1.05 + i * 0.05))
  const c = priceChart(points, { width: 40, height: 8, symbol: "MOON", now: T, history: { source: "hacc" }, candles: hacc })
  expect(c.kind).toBe("candles")
  expect(c.cells).toHaveLength(7)
  expect(c.axis!.filter(Boolean)).toHaveLength(3)
  expect(c.axis!.some((a) => a.startsWith("◂$1.95"))).toBe(true)
  expect(c.time).toMatch(/^−\d+m .* now$/)
  expect(c.caption).toStartWith("MOON in USD · 2m candles")
  const line = priceChart(points, { width: 40, height: 8, symbol: "MOON", now: T, candles: [] })
  expect(line.kind).toBe("braille")
  expect(line.cells!.flat().some((x) => x.tone === "fill")).toBe(true)
  expect(line.cells!.flat().some((x) => x.tone === "good")).toBe(true)
  // From 2 rows, candles, with the time axis from 5 (the Trade tab's default pane is 2 rows, and drew none at all).
  const short = priceChart(points, { width: 40, height: 3, symbol: "MOON", now: T, candles: hacc })
  expect(short.kind).toBe("candles")
  expect(short.cells).toHaveLength(3)
  expect(short.time).toBeUndefined()
  expect(short.caption).toStartWith("MOON in USD · 2m candles")
  expect(priceChart(points, { width: 40, height: 1, symbol: "MOON", now: T, candles: hacc }).cells).toBeUndefined()
})

test("a quiet hour fills the chart: the axis is the candles' own range, with labels told apart (a large-cap's 0.4% hour drew as one flat row)", () => {
  // JUP-like: $0.2585 to $0.2595 over 20 minutes.
  const hacc = Array.from({ length: 20 }, (_, i) => minute(i, 0.2585 + (i % 5) * 0.0002, 0.2587 + (i % 5) * 0.0002, 0.2589 + (i % 5) * 0.0002, 0.2584 + (i % 5) * 0.0002))
  const points = hacc.map((m) => ({ at: m.at, usd: m.close }))
  const c = priceChart(points, { width: 50, height: 8, symbol: "JUP", now: T, history: { source: "hacc" }, candles: hacc })
  expect(c.kind).toBe("candles")
  // Candles reach the top and bottom rows, and more than one row in between.
  const used = c.cells!.map((row) => row.some((x) => x.text.trim() !== "" && x.tone !== "flat"))
  expect(used[0]).toBe(true)
  expect(used.at(-1)).toBe(true)
  expect(c.top).not.toBe(c.bottom)
  expect(Number(c.top.slice(1)) - Number(c.bottom.slice(1))).toBeLessThan(0.002)
})
