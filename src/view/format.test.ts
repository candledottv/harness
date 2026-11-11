// Data honesty, in one formatter: missing is "—", never 0; stale is marked; converted
// figures carry ≈; and text wraps to the pane without losing words.
import { describe, expect, test } from "bun:test"
import { ago, amount, approxUsd, compactUsd, exact, paperRefusal, pct, qty, shortAddress, usd, wrap } from "./format"

test("a missing figure is —, never $0.00", () => {
  expect(usd(null)).toBe("—")
  expect(usd(undefined)).toBe("—")
  expect(usd(0)).toBe("$0.00")
  // A figure that rounds up to a dollar reads as one, as the others in its column do (not "$1" among "$1.00").
  expect(usd(0.9995)).toBe("$1.00")
  expect(usd(-0.9999)).toBe("-$1.00")
  expect(usd(0.999)).toBe("$0.999")
  expect(usd(1234.5)).toBe("$1,234.50")
  expect(usd(0.000123)).toBe("$0.000123")
  expect(approxUsd(null)).toBe("—")
  expect(approxUsd(15.08)).toBe("≈$15.08")
})

test("compact dollars for market figures", () => {
  expect(compactUsd(812_000)).toBe("$812K")
  expect(compactUsd(1_400_000)).toBe("$1.4M")
  expect(compactUsd(2_300_000_000)).toBe("$2.3B")
  expect(compactUsd(950)).toBe("$950")
  expect(compactUsd(null)).toBe("—")
})

test("a change is signed with an arrow, and missing is —", () => {
  expect(pct(0.412)).toBe("▲ 41.2%")
  expect(pct(-0.031)).toBe("▼ 3.1%")
  expect(pct(null)).toBe("—")
})

test("token quantities keep their precision without trailing zeros", () => {
  expect(qty(12345.678901)).toBe("12,345.68")
  expect(qty(2.380952)).toBe("2.381")
  expect(qty(0.000042)).toBe("0.000042")
  expect(qty(2)).toBe("2")
})

test("how old a value is, and whether that's stale", () => {
  expect(ago(1_000, 13_000, 60_000)).toEqual({ text: "12s ago", stale: false })
  expect(ago(1_000, 181_000, 60_000)).toEqual({ text: "3m ago · stale", stale: true })
  expect(ago(null, 5_000, 60_000)).toEqual({ text: "never read", stale: true })
})

test("addresses shorten to both ends", () => {
  expect(shortAddress("MoonFake11111111111111111111111111111111111")).toBe("Moon…1111")
})

test("wrapping keeps words whole, breaks words longer than the line, and keeps blank lines", () => {
  expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"])
  expect(wrap("MoonFake11111111111111111111111111111111111", 20)).toEqual(["MoonFake111111111111", "11111111111111111111", "111"])
  expect(wrap("one\n\ntwo", 10)).toEqual(["one", "", "two"])
  expect(wrap("", 10)).toEqual([""])
})

test("amounts are rounded to what matters: 3 figures below 1, up to 4 below 1,000, whole above", () => {
  expect(amount(0.009971953)).toBe("0.00997")
  expect(amount(0.00294429955)).toBe("0.00294")
  expect(amount(0.000000123456)).toBe("0.000000123")
  expect(amount(0.5)).toBe("0.5")
  expect(amount(18.4219)).toBe("18.42")
  expect(amount(1240.6)).toBe("1,241")
  expect(amount(18_400.2)).toBe("18,400")
  expect(amount(-0.0123456)).toBe("-0.0123")
  expect(amount(0)).toBe("0")
  expect(amount(null)).toBe("—")
})

test("the exact figure keeps every decimal, for details", () => {
  expect(exact(0.009971953)).toBe("0.009971953")
  expect(exact(0.00294429955)).toBe("0.00294429955")
  expect(exact(1240.6)).toBe("1,240.6")
  expect(exact(undefined)).toBe("—")
})

describe("a refused paper trade, in words", () => {
  test("a rate-limited key says so plainly, not as the answer's JSON", () => {
    const answer = JSON.stringify({ clientTradeId: "d4af7418", resolved: { amountDecimal: "0.011226326", decimals: 9 }, api: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests for this key", retryable: true } } })
    expect(paperRefusal(answer)).toBe("Candle is rate-limiting this key. Nothing was sent; try again in a moment.")
  })

  test("a code with no plain message keeps Candle's own words and the code; text that isn't JSON is shown as it came", () => {
    expect(paperRefusal(JSON.stringify({ error: { code: "SOMETHING_NEW", message: "The pool is paused" } }))).toBe("The pool is paused (SOMETHING_NEW)")
    expect(paperRefusal("no route for this token")).toBe("no route for this token")
  })
})

test("dollars under one keep the cents, and every figure past them", () => {
  expect(usd(0.2)).toBe("$0.20")
  expect(usd(0.5)).toBe("$0.50")
  expect(usd(-0.3)).toBe("-$0.30")
  expect(usd(0.595)).toBe("$0.595")
  expect(usd(0.0000841)).toBe("$0.0000841")
  expect(usd(0.05)).toBe("$0.05")
  expect(usd(0.25)).toBe("$0.25")
})
