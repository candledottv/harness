import { expect, test } from "bun:test"
import { fitSegments, pnlWords, quitNote, statusFigures, triggersOnWords } from "./status-bar"
import type { StatusView } from "./store"

const NOW = new Date(2026, 9, 30, 15, 0).getTime()

test("the P&L figure names its window, and from when where the Candle Harness's samples start later", () => {
  expect(pnlWords({ usd: 1.2, label: "24h", from: NOW - 20 * 3_600_000, short: false }, "live", NOW)).toBe("P&L 24h +$1.20")
  expect(pnlWords({ usd: -0.4, label: "since 18:00", from: NOW - 21 * 3_600_000, short: false }, "live", NOW)).toBe("P&L since 18:00 -$0.40")
  expect(pnlWords({ usd: 2, label: "24h", from: new Date(2026, 9, 30, 9, 14).getTime(), short: true }, "live", NOW)).toBe("P&L since 09:14 +$2.00")
  expect(pnlWords({ usd: 2, label: "24h", from: new Date(2026, 9, 29, 20, 5).getTime(), short: true }, "live", NOW)).toBe("P&L since Oct 29 20:05 +$2.00")
  // Before any sample in the window, and before a core sends one: missing, never zero.
  expect(pnlWords({ usd: null, label: "since midnight", from: null, short: false }, "live", NOW)).toBe("P&L since midnight —")
  expect(pnlWords(null, "live", NOW)).toBe("P&L —")
  // Candle priced a different number of positions at the window's two ends: ≈, and how many it can't price.
  expect(pnlWords({ usd: -300, label: "24h", from: NOW - 20 * 3_600_000, short: false, unpriced: 1 }, "live", NOW)).toBe("P&L 24h ≈-$300.00 (1 unpriced)")
})

test("in paper mode the figure says it's the live books', as exposure does", () => {
  expect(pnlWords({ usd: 1, label: "24h", from: NOW, short: false }, "paper", NOW)).toBe("live P&L 24h +$1.00")
  const status = { agents: [], activeAgent: "a", mode: "paper", paused: false, pnl: { usd: null, label: "24h", from: null, short: false } } as StatusView
  expect(statusFigures(status).pnl).toBe("live P&L 24h —")
})

test("triggers on: how many, while keep-awake holds the Mac awake; quitting says they keep running and how to stop them", () => {
  expect(triggersOnWords(1)).toBe("1 trigger on")
  expect(triggersOnWords(3, true)).toBe("3 triggers on · Mac kept awake")
  expect(quitNote({ triggersOn: 3 })).toBe("3 triggers keep running in the background · `candle-harness stop` to end them")
  expect(quitNote({ triggersOn: 1 })).toBe("1 trigger keeps running in the background · `candle-harness stop` to end it")
  expect(quitNote({ triggersOn: 0 })).toBeUndefined()
  expect(quitNote({ triggersOn: 3, botsOn: 2 })).toBe("2 bots and 3 triggers keep running in the background · `candle-harness stop` to end them")
  expect(quitNote({ botsOn: 1 })).toBe("1 bot keeps running in the background · `candle-harness stop` to end it")
  expect(quitNote(undefined)).toBeUndefined()
})

test("the longest agent name at 80 columns: the name gives up its end, so the waiting count and the kill switch both stay", () => {
  const name = `${"m".repeat(28)}-bot`
  const bar = [
    { key: "brand", text: "▲ candle", priority: 5 },
    { key: "agent", text: `${name} · only ▾`, priority: 0, shrink: true },
    { key: "chain", text: "all chains ▾", priority: 2, gap: true },
    { key: "mode", text: "LIVE", priority: 0 },
    { key: "cards", text: "● 12 cards waiting", priority: 0 },
    { key: "spacer", text: "", priority: 0, spacer: true },
    { key: "kill", text: "ctrl-x again to kill", priority: 0 },
  ]
  const kept = fitSegments(bar, 80)
  expect(kept.map((s) => s.key)).toEqual(["agent", "mode", "cards", "spacer", "kill"])
  expect(kept.reduce((n, s) => n + (s.spacer ? 0 : [...s.text].length + 2), 0)).toBeLessThanOrEqual(80)
  expect(kept[0]!.text).toMatch(/^m+… ▾$/)
  // A name that fits is left whole.
  expect(fitSegments(bar, 120).find((s) => s.key === "agent")!.text).toBe(`${name} · only ▾`)
})
