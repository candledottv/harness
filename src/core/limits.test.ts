import { describe, expect, test } from "bun:test"
import type { JournalRow } from "./journal"
import { byWalletWithoutCard, DaySpend, heldMessage, KeyHolds, type KeyWindow, limitLines, Limits, nextWindowStart, overAssetCap, overWords, startOfLocalDay } from "./limits"

const NOON = new Date(2026, 9, 26, 12, 0, 0).getTime() // local time
const LIMITS = { perTradeUsd: 10, perDayUsd: 50 }

function setup() {
  const spend = new DaySpend()
  const limits = new Limits({ limitsFor: (agent) => (agent === "momentum" || agent === "swing" ? LIMITS : undefined), spend })
  return { spend, limits }
}

describe("per trade", () => {
  test("a buy over the per-trade limit is refused with the numbers", () => {
    const { limits } = setup()
    const r = limits.check({ usd: 10.01, side: "buy", agent: "momentum", now: NOON })
    expect(r).toMatchObject({ ok: false, code: "OVER_TRADE_LIMIT" })
    expect(r.ok === false && r.message).toContain("$10.01 is more than $10.00 per trade")
    // A buy valued with Candle's fee says so.
    const fee = limits.check({ usd: 10.03, side: "buy", agent: "momentum", now: NOON, feeBps: 25 })
    expect(fee.ok === false && fee.message).toContain("$10.03 with Candle's 0.25% fee is more than $10.00 per trade")
  })

  test("near a limit means from 80% of the per-trade or the daily limit", () => {
    const { limits } = setup()
    expect(limits.check({ usd: 7.99, side: "buy", agent: "momentum", now: NOON })).not.toHaveProperty("near")
    expect(limits.check({ usd: 8, side: "buy", agent: "momentum", now: NOON })).toMatchObject({ ok: true, near: true })
    expect(limits.check({ usd: 2, side: "sell", agent: "momentum", now: NOON })).not.toHaveProperty("near")
    const day = setup()
    day.spend.record("a1", "momentum", 39, NOON)
    expect(day.limits.check({ usd: 1, side: "buy", agent: "momentum", now: NOON })).toMatchObject({ ok: true, near: true })
  })

  test("a buy at the limit runs; the line says where it sits", () => {
    const { limits } = setup()
    expect(limits.check({ usd: 9.2, side: "buy", agent: "momentum", now: NOON })).toEqual({
      ok: true,
      unvalued: false,
      line: "$9.20 of $10.00 per trade · $9.20 of $50.00 today",
      // Within 20% of the per-trade limit, so the compact card shows the line.
      near: true,
    })
    expect(limits.check({ usd: 10, side: "swap", agent: "momentum", now: NOON }).ok).toBe(true)
  })

  test("a swap is limited like a buy", () => {
    const { limits } = setup()
    expect(limits.check({ usd: 11, side: "swap", agent: "momentum", now: NOON })).toMatchObject({ ok: false, code: "OVER_TRADE_LIMIT" })
  })

  test("a sell over the limit runs: getting out is always allowed", () => {
    const { limits } = setup()
    expect(limits.check({ usd: 5000, side: "sell", agent: "momentum", now: NOON }).ok).toBe(true)
  })
})

describe("per day", () => {
  test("a burst of six $9 cards crosses the day's $50 at the sixth", () => {
    const { limits, spend } = setup()
    for (let i = 1; i <= 5; i++) {
      expect(limits.check({ usd: 9, side: "buy", agent: "momentum", now: NOON }).ok).toBe(true)
      spend.record(`op${i}`, "momentum", 9, NOON)
    }
    const sixth = limits.check({ usd: 9, side: "buy", agent: "momentum", now: NOON })
    expect(sixth).toMatchObject({ ok: false, code: "OVER_DAY_LIMIT" })
    expect(sixth.ok === false && sixth.message).toContain("$45.00 spent, and this $9.00 would make $54.00 of $50.00")
  })

  test("each agent's day counts only its own trades", () => {
    const { limits, spend } = setup()
    spend.record("a1", "momentum", 45, NOON)
    expect(limits.check({ usd: 9, side: "buy", agent: "swing", now: NOON }).ok).toBe(true)
    expect(limits.check({ usd: 9, side: "buy", agent: "momentum", now: NOON }).ok).toBe(false)
  })

  test("what settled refused or failed doesn't count; unknown and abandoned still do", () => {
    const { limits, spend } = setup()
    spend.record("refused", "momentum", 45, NOON)
    spend.record("unknown", "momentum", 5, NOON)
    spend.settle("refused", "refused")
    spend.settle("unknown", "unknown")
    expect(spend.spent("momentum", NOON)).toBe(5)
    spend.settle("unknown", "abandoned")
    expect(spend.spent("momentum", NOON)).toBe(5)
    expect(limits.check({ usd: 9, side: "buy", agent: "momentum", now: NOON }).ok).toBe(true)
  })

  test("the day starts at local midnight", () => {
    const { spend } = setup()
    spend.record("yesterday", "momentum", 40, startOfLocalDay(NOON) - 1)
    spend.record("today", "momentum", 3, startOfLocalDay(NOON))
    expect(spend.spent("momentum", NOON)).toBe(3)
  })

  test("re-checking a card leaves its own spend out", () => {
    const { limits, spend } = setup()
    spend.record("other", "momentum", 40, NOON)
    spend.record("op1", "momentum", 9, NOON)
    expect(limits.check({ usd: 9, side: "buy", agent: "momentum", now: NOON, exceptOpId: "op1" }).ok).toBe(true)
    expect(limits.check({ usd: 9, side: "buy", agent: "momentum", now: NOON }).ok).toBe(false)
  })

  test("the day is rebuilt from the journal", () => {
    const at = new Date(NOON).toISOString()
    const row = (type: string, extra: Record<string, unknown>) => ({ seq: 0, at, type, account: "a", mode: "live", ...extra }) as JournalRow
    const spend = new DaySpend()
    spend.rebuild([
      row("card.approved", { opId: "o1", agent: "momentum", usd: 9, side: "buy" }),
      row("card.approved", { opId: "o2", agent: "momentum", usd: 7, side: "swap" }),
      row("card.approved", { opId: "o3", agent: "momentum", usd: 900, side: "sell" }),
      row("card.approved", { opId: "o4", agent: "momentum", usd: 20, side: "buy" }),
      row("operation.refused", { opId: "o4" }),
    ])
    expect(spend.spent("momentum", NOON)).toBe(16)
  })
})

describe("no price", () => {
  test("an unvalued buy is ok, marked unvalued, and says the Candle Harness limit can't be checked: never a silent zero", () => {
    const { limits } = setup()
    const r = limits.check({ usd: undefined, side: "buy", agent: "momentum", now: NOON })
    expect(r).toMatchObject({ ok: true, unvalued: true })
    expect(r.line).toContain("no price, so it can't be checked")
  })
})

// A wallet's own figures, Candle's caps, and every limit with who enforces it.
const at = (ms: number) => new Date(ms).toISOString()
const jrow = (type: string, when: number, extra: Record<string, unknown>) => ({ seq: 0, at: at(when), type, account: "a", mode: "live", ...extra }) as JournalRow

describe("a wallet's spend without a card", () => {
  const EMBEDDED = "EmbeddedFake1111111111111111111111111111111"
  const TEE = "TeeFake111111111111111111111111111111111111"

  test("only trades the core ran without a card count, across every agent on the wallet", () => {
    const spend = new DaySpend(byWalletWithoutCard)
    spend.rebuild([
      // Two agents share the embedded wallet: both count towards its one figure.
      jrow("card.approved", NOON, { opId: "o1", agent: "momentum", wallet: EMBEDDED, usd: 1, side: "buy", how: "inside-limits" }),
      jrow("card.approved", NOON, { opId: "o2", agent: "swing", wallet: EMBEDDED, usd: 0.5, side: "swap", how: "inside-limits" }),
      // A card the person approved, and a typed-instant trade, never use up the figure.
      jrow("card.approved", NOON, { opId: "o3", agent: "momentum", wallet: EMBEDDED, usd: 2, side: "buy", how: "enter" }),
      jrow("card.approved", NOON, { opId: "o4", agent: "momentum", wallet: EMBEDDED, usd: 2, side: "buy", how: "instant" }),
      // A sell is never counted; another wallet is its own.
      jrow("card.approved", NOON, { opId: "o5", agent: "momentum", wallet: EMBEDDED, usd: 9, side: "sell", how: "inside-limits" }),
      jrow("card.approved", NOON, { opId: "o6", agent: "momentum", wallet: TEE, usd: 0.75, side: "buy", how: "inside-limits" }),
      // A failed trade spent nothing.
      jrow("card.approved", NOON, { opId: "o7", agent: "swing", wallet: EMBEDDED, usd: 1, side: "buy", how: "inside-limits" }),
      jrow("operation.failed", NOON, { opId: "o7" }),
      // Yesterday's don't count today.
      jrow("card.approved", NOON - 86_400_000, { opId: "o8", agent: "swing", wallet: EMBEDDED, usd: 1, side: "buy", how: "inside-limits" }),
    ])
    expect(spend.spent(EMBEDDED, NOON)).toBe(1.5)
    expect(spend.spent(TEE, NOON)).toBe(0.75)
  })

  test("the agent's own day still counts every approval, as before", () => {
    const spend = new DaySpend()
    spend.rebuild([
      jrow("card.approved", NOON, { opId: "o1", agent: "momentum", wallet: "w", usd: 1, side: "buy", how: "inside-limits" }),
      jrow("card.approved", NOON, { opId: "o2", agent: "momentum", wallet: "w", usd: 2, side: "buy", how: "enter" }),
    ])
    expect(spend.spent("momentum", NOON)).toBe(3)
  })
})

describe("Candle's window starts (UTC)", () => {
  const T = Date.UTC(2026, 9, 31, 15, 30) // a Saturday
  test("a day, a week from Monday, a month; a lifetime cap has none", () => {
    expect(nextWindowStart("daily", T)).toBe(Date.UTC(2026, 10, 1))
    expect(nextWindowStart("weekly", T)).toBe(Date.UTC(2026, 10, 2))
    expect(nextWindowStart("weekly", Date.UTC(2026, 10, 2, 9))).toBe(Date.UTC(2026, 10, 9)) // a Monday: the next one
    expect(nextWindowStart("weekly", Date.UTC(2026, 10, 1, 9))).toBe(Date.UTC(2026, 10, 2)) // a Sunday
    expect(nextWindowStart("monthly", T)).toBe(Date.UTC(2026, 10, 1))
    expect(nextWindowStart("never", T)).toBeNull()
  })
})

describe("a key Candle refused for its cap is held", () => {
  const T = Date.UTC(2026, 9, 31, 15, 30)
  const setupHolds = (window: KeyWindow | undefined = { usd: 10, reset: "daily" }) => {
    let w: KeyWindow | undefined = window
    const holds = new KeyHolds({ window: () => w })
    return { holds, setWindow: (next: KeyWindow | undefined) => (w = next) }
  }

  test("until Candle's resetsAt, then it lifts", () => {
    const { holds } = setupHolds()
    holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: T + 3_600_000 }, T)
    expect(holds.held("momentum", T + 3_599_999)).toMatchObject({ why: "window", until: T + 3_600_000 })
    expect(holds.held("swing", T)).toBeUndefined()
    expect(holds.held("momentum", T + 3_600_000)).toBeUndefined()
  })

  test("Candle's limit_unavailable holds only until retryAfter, or 30 s", () => {
    const { holds } = setupHolds()
    holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: null, reason: "limit_unavailable", retryAfter: T + 31_000 }, T)
    expect(holds.held("momentum", T + 30_000)).toMatchObject({ why: "unavailable" })
    expect(holds.held("momentum", T + 31_000)).toBeUndefined()
    holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: null, reason: "limit_unavailable" }, T)
    expect(holds.held("momentum", T + 30_000)).toBeUndefined()
  })

  test("a lifetime cap holds until the owner changes it", () => {
    const { holds, setWindow } = setupHolds({ usd: 10, reset: "never" })
    holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: null }, T)
    expect(holds.held("momentum", T + 86_400_000 * 30)).toMatchObject({ why: "lifetime", until: null })
    setWindow({ usd: 25, reset: "never" })
    expect(holds.held("momentum", T)).toBeUndefined()
  })

  test("with no resetsAt (the CLI's route), the key's own window from its status read decides", () => {
    const { holds, setWindow } = setupHolds({ usd: 10, reset: "daily" })
    holds.note("momentum", { code: "KEY_LIMIT_REACHED" }, T)
    expect(holds.held("momentum", T)).toMatchObject({ until: Date.UTC(2026, 10, 1) })
    setWindow(undefined)
    holds.note("momentum", { code: "KEY_LIMIT_REACHED" }, T)
    expect(holds.held("momentum", T + 59_000)).toMatchObject({ until: T + 60_000 })
  })

  test("other refusals hold nothing, and the hold is rebuilt from the journal", () => {
    const { holds } = setupHolds()
    holds.note("momentum", { code: "SPEND_LIMIT_EXCEEDED" }, T)
    expect(holds.held("momentum", T)).toBeUndefined()
    const rebuilt = setupHolds().holds
    rebuilt.rebuild([
      jrow("operation.refused", T, { opId: "o1", agent: "momentum", error: { code: "KEY_LIMIT_REACHED", resetsAt: T + 600_000 } }),
      jrow("operation.refused", T, { opId: "o2", agent: "swing", error: { code: "TIER_REQUIRED" } }),
    ])
    expect(rebuilt.all(T).map((h) => h.agent)).toEqual(["momentum"])
  })

  test("a key Candle stopped (RISK_LIMIT_REACHED) holds every trade, sells included, for 5 minutes, then Candle is asked again", () => {
    const { holds } = setupHolds()
    holds.note("momentum", { code: "RISK_LIMIT_REACHED" }, T)
    for (const side of ["buy", "sell", "swap"] as const) expect(holds.held("momentum", T + 299_999, side)).toMatchObject({ why: "stopped" })
    expect(holds.held("momentum", T + 300_000, "sell")).toBeUndefined()
    // A cap hold under it still holds buys once the stop's time is up, never sells.
    holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: T + 3_600_000 }, T)
    holds.note("momentum", { code: "RISK_LIMIT_REACHED" }, T)
    expect(holds.held("momentum", T + 300_000, "buy")).toMatchObject({ why: "window" })
    expect(holds.held("momentum", T + 300_000, "sell")).toBeUndefined()
    const rebuilt = setupHolds().holds
    rebuilt.rebuild([jrow("operation.refused", T, { opId: "o1", agent: "swing", error: { code: "RISK_LIMIT_REACHED" } })])
    expect(rebuilt.held("swing", T + 60_000, "sell")).toMatchObject({ why: "stopped" })
    expect(heldMessage({ agent: "swing", until: T + 300_000, why: "stopped" }, T)).toBe(
      "Candle stopped swing's key (a loss limit or its circuit breaker), sells included. Waiting won't clear it: the owner resumes it in Candle's Agent Console. The Candle Harness asks Candle again from 15:35 UTC. Nothing was sent.",
    )
  })

  test("its words say when it lifts, in UTC, and that sells still go", () => {
    expect(heldMessage({ agent: "momentum", until: T + 8_100_000, why: "window" }, T)).toBe(
      "Candle's limit on momentum's key is used up until 17:45 UTC (in 2h 15m), so its buys and swaps are held until then. Sells still go. Nothing was sent.",
    )
    expect(heldMessage({ agent: "momentum", until: T + 30_000, why: "unavailable" }, T)).toContain("wait until 15:30 UTC")
    expect(heldMessage({ agent: "momentum", until: null, why: "lifetime" }, T)).toContain("until the owner raises it in Candle's Agent Console")
  })
})

describe("Candle's per-asset caps", () => {
  const caps = [{ asset: "sol", maxPerTxRaw: "40000000" }, { asset: "usdc", maxPerTxRaw: "5000000" }]
  test("a buy over the cap for the asset it spends; at the cap, or another asset, isn't", () => {
    expect(overAssetCap(caps, "SOL", 40_000_001n)).toEqual(caps[0])
    expect(overAssetCap(caps, "SOL", 40_000_000n)).toBeUndefined()
    expect(overAssetCap(caps, "CNDL", 10n ** 18n)).toBeUndefined()
    expect(overAssetCap(undefined, "SOL", 10n ** 18n)).toBeUndefined()
  })
})

describe("every limit names who enforces it", () => {
  test("the Candle Harness's, a wallet's without a card, and Candle's", () => {
    const lines = limitLines({
      harness: { perTradeUsd: 2, perDayUsd: 10 },
      spentTodayUsd: 3,
      wallets: [{ wallet: "w1", name: "embedded", perTradeUsd: 1, perDayUsd: 3, usedUsd: 1 }],
      candle: { read: true, keyLimit: { usd: 10, reset: "daily" }, assetCaps: [{ asset: "sol", maxPerTxRaw: "40000000" }] },
    })
    expect(lines.map((l) => l.words)).toEqual([
      "Harness · $2.00 a trade",
      "Harness · $10.00 a day · $3.00 used",
      "Harness · embedded without a card · $1.00 a trade",
      "Harness · embedded without a card · $3.00 a day · $1.00 used",
      "Candle · $10.00 a UTC day, all volume",
      "Candle · 0.04 SOL a buy",
    ])
    for (const l of lines) expect(l.words.startsWith(`${l.by} · `)).toBe(true)
  })

  test("a key Candle doesn't cap says so, and one not read yet never reads as uncapped", () => {
    const harness = { perTradeUsd: 2, perDayUsd: 10 }
    expect(limitLines({ harness, spentTodayUsd: 0, wallets: [], candle: { read: true } }).at(-1)).toEqual({ by: "Candle", what: "none", words: "Candle · no cap on this key" })
    expect(limitLines({ harness, spentTodayUsd: 0, wallets: [], candle: { read: false } }).at(-1)).toEqual({ by: "Candle", what: "unread", words: "Candle · the key's caps aren't read yet" })
    expect(limitLines({ harness, spentTodayUsd: 0, wallets: [], candle: { read: true, keyLimit: { usd: 50, reset: "weekly" } } }).at(-1)?.words).toBe("Candle · $50.00 a week (from Monday, UTC), all volume")
  })
})

test("amounts over a limit add up and show it: to the cent where that does, else to the places it takes", () => {
  // $2.00499 used and a $1.0025 buy over a $3.00 day read "$2.00 … $1.00 would make $3.01".
  expect(overWords([2.004999989, 1.002499994], 3)).toEqual({ parts: ["$2.005", "$1.002"], total: "$3.007" })
  // A $1 buy with Candle's fee over a $1.00 figure, said as over it.
  expect(overWords([1.002499994], 1)).toEqual({ parts: ["$1.002"], total: "$1.002" })
  // Where cents show it, cents.
  expect(overWords([1.84, 0.95], 2)).toEqual({ parts: ["$1.84", "$0.95"], total: "$2.79" })
  expect(overWords([1.754375], 1.5)).toEqual({ parts: ["$1.75"], total: "$1.75" })
})
