import { expect, test } from "bun:test"
import { pnlWords, statusFigures } from "./status-bar"
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
