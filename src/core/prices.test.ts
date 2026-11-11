import { describe, expect, test } from "bun:test"
import { BASE_ASSETS } from "./assets"
import { AgentStatusBook, parseExecutionStatus } from "./agent-status"
import type { ToolOutcome } from "./candle-mcp"
import { LatestPrices, PriceBook } from "./prices"

const SOL = BASE_ASSETS.SOL.priceKey!
const MOON = "MoonFake11111111111111111111111111111111111"
const portfolio = (prices: Record<string, unknown>): ToolOutcome => ({ kind: "ok", result: { success: true, embedded: [], prices } })

describe("PriceBook", () => {
  test("reads the portfolio's price map by mint; null, zero and missing prices are no price", async () => {
    const book = new PriceBook({ read: async () => portfolio({ [SOL]: { priceUsd: 150 }, [MOON]: { priceUsd: null }, x: { priceUsd: 0 } }), now: () => 1000 })
    expect(book.usd(SOL)).toBeUndefined()
    await book.refresh()
    expect(book.usd(SOL)).toBe(150)
    expect(book.usd(MOON)).toBeUndefined()
    expect(book.usd("x")).toBeUndefined()
    expect(book.usd(undefined)).toBeUndefined()
  })

  test("a failed read keeps the last good prices and their age", async () => {
    let now = 1000
    let answer: ToolOutcome = portfolio({ [SOL]: { priceUsd: 150 } })
    const book = new PriceBook({ read: async () => answer, now: () => now })
    await book.refresh()
    now = 31_000
    answer = { kind: "lost", reason: "timeout" }
    await book.refresh()
    expect(book.usd(SOL)).toBe(150)
    expect(book.ageMs()).toBe(30_000)
  })

  test("a failed read says why, once, until a read answers; one that never reached Candle says nothing", async () => {
    let answer: ToolOutcome = { kind: "error", code: "UPSTREAM", retryable: true, body: { error: { message: "upstream busy" } } }
    let told = 0
    const book = new PriceBook({ read: async () => answer, now: () => 0, onRead: () => told++ })
    await book.refresh()
    expect(book.lastFailure()).toBe("upstream busy")
    expect(told).toBe(1)
    await book.refresh()
    expect(told).toBe(1) // the same words aren't sent twice
    answer = { kind: "lost", reason: "timeout" }
    await book.refresh()
    expect(book.lastFailure()).toBe("Candle didn't answer")
    answer = portfolio({ [SOL]: { priceUsd: 150 } })
    await book.refresh()
    expect(book.lastFailure()).toBeUndefined()
    // The budget held it, or no agent: not Candle's failure.
    const held = new PriceBook({ read: async () => ({ kind: "error", code: "BUDGET_WAIT", retryable: true, body: {} }), now: () => 0 })
    await held.refresh()
    expect(held.lastFailure()).toBeUndefined()
  })

  test("the key's budget stretches the 15 s; a read that waited keeps the last prices", async () => {
    let stretch = 1
    let answer: ToolOutcome = portfolio({ [SOL]: { priceUsd: 150 } })
    const book = new PriceBook({ read: async () => answer, now: () => 0, stretch: () => stretch })
    expect(book.demandPerMin()).toBe(0) // no view attached
    await book.refresh()
    expect(book.nextReadMs()).toBe(15_000)
    stretch = 2.5
    expect(book.nextReadMs()).toBe(37_500)
    answer = { kind: "error", code: "BUDGET_WAIT", retryable: true, body: {} }
    await book.refresh()
    expect(book.usd(SOL)).toBe(150)
    expect(book.nextReadMs()).toBe(37_500) // a wait isn't Candle's RATE_LIMITED: no doubling
  })

  test("RATE_LIMITED backs off, and a good read resets the interval", async () => {
    let answer: ToolOutcome = { kind: "error", code: "RATE_LIMITED", retryable: true, body: {} }
    const book = new PriceBook({ read: async () => answer, now: () => 0, intervalMs: 15_000 })
    await book.refresh()
    expect((book as unknown as { intervalMs: number }).intervalMs).toBe(30_000)
    await book.refresh()
    expect((book as unknown as { intervalMs: number }).intervalMs).toBe(60_000)
    answer = portfolio({ [SOL]: { priceUsd: 150 } })
    await book.refresh()
    expect((book as unknown as { intervalMs: number }).intervalMs).toBe(15_000)
  })

  test("concurrent refreshes share one read", async () => {
    let reads = 0
    const book = new PriceBook({
      read: async () => {
        reads++
        await Bun.sleep(10)
        return portfolio({ [SOL]: { priceUsd: 150 } })
      },
      now: () => 0,
    })
    await Promise.all([book.refresh(), book.refresh(), book.refresh()])
    expect(reads).toBe(1)
  })
})

describe("agent status", () => {
  const status = {
    success: true,
    ready: true,
    wallets: { wallets: { solana: { address: "WalletFake111111111111111111111111111111111" }, evm: null }, embeddedWalletPermission: "allowed" },
    tier: { tier: "pro", feeBps: 50 },
    limits: { txLimit: { usdMicros: 100_000_000, reset: "daily" } },
  }

  test("reads the wallet, the permission, the plan and its fee, and Candle's key limit", () => {
    expect(parseExecutionStatus(status, 5)).toEqual({
      readAt: 5,
      wallets: { solana: "WalletFake111111111111111111111111111111111" },
      embeddedWallet: "allowed",
      tier: "pro",
      feeBps: 50,
      keyLimit: { usd: 100, reset: "daily" },
      unreadable: [],
    })
  })

  test("no permission value means allowed; denied is denied; no txLimit is unlimited", () => {
    const { embeddedWalletPermission: _p, ...noPermission } = status.wallets
    expect(parseExecutionStatus({ ...status, wallets: noPermission }, 0)!.embeddedWallet).toBe("allowed")
    expect(parseExecutionStatus({ ...status, wallets: { ...status.wallets, embeddedWalletPermission: "denied" } }, 0)!.embeddedWallet).toBe("denied")
    expect(parseExecutionStatus({ ...status, limits: { spendLimits: [] } }, 0)!.keyLimit).toBeUndefined()
  })

  test("the book keeps the last good read; a failed one is named", async () => {
    let answer: ToolOutcome = { kind: "ok", result: status }
    const book = new AgentStatusBook({ pool: { for: () => ({ call: async () => answer }) }, now: () => 0 })
    await book.refresh("momentum")
    answer = { kind: "lost", reason: "timeout" }
    await book.refresh("momentum")
    expect(book.get("momentum")!.feeBps).toBe(50)
    expect(book.error("momentum")).toBe("no answer (timeout)")
  })
})

describe("LatestPrices", () => {
  const MINT = "OreFake111111111111111111111111111111111111"
  const market = (usd: unknown, mint = MINT): ToolOutcome => ({ kind: "ok", result: { success: true, market: { chain: "solana", mint, priceUsd: usd } } })
  const book = (usd: number | undefined, readAt: number | undefined) => ({ usd: () => usd, lastPortfolio: () => (readAt === undefined ? undefined : { readAt }) })

  test("a market read newer than the portfolio's wins; an older one doesn't", () => {
    const latest = new LatestPrices(book(109, 1_000))
    expect(latest.usd(MINT)).toBe(109)
    latest.noteMarket(market(180), 900)
    expect(latest.usd(MINT)).toBe(109)
    latest.noteMarket(market(180.3), 1_500)
    expect(latest.usd(MINT)).toBe(180.3)
  })

  test("a market read prices what the portfolio doesn't; a read without a usable price is ignored", () => {
    const latest = new LatestPrices(book(undefined, 1_000))
    for (const bad of [null, 0, -1, "180", Number.NaN]) latest.noteMarket(market(bad), 2_000)
    latest.noteMarket({ kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} }, 2_000)
    expect(latest.usd(MINT)).toBeUndefined()
    latest.noteMarket(market(0.5), 500)
    expect(latest.usd(MINT)).toBe(0.5)
    expect(latest.usd(undefined)).toBeUndefined()
  })

  test("a Hood token's market read meets the portfolio's key for it, hood:<lowercase>, and its mint in any case", () => {
    const TOKEN = "0x00000000000000000000000000000000000B0B01"
    const latest = new LatestPrices(book(undefined, 1_000))
    latest.noteMarket({ kind: "ok", result: { success: true, market: { chain: "hood", mint: TOKEN, priceUsd: 0.01 } } }, 2_000)
    expect(latest.usd("hood:0x00000000000000000000000000000000000b0b01")).toBe(0.01)
    expect(latest.usd(TOKEN)).toBe(0.01)
    expect(latest.usd(TOKEN.toLowerCase())).toBe(0.01)
    // A Solana mint stays case-sensitive.
    latest.noteMarket(market(2), 2_000)
    expect(latest.usd(MINT)).toBe(2)
    expect(latest.usd(MINT.toLowerCase())).toBeUndefined()
  })

  test("USDG is Candle's fixed $1 with no portfolio price for it; the portfolio's figure when there is one", () => {
    const KEY = "hood:0x5fc5360d0400a0fd4f2af552add042d716f1d168"
    expect(new LatestPrices(book(undefined, undefined)).usd(KEY)).toBe(1)
    expect(new LatestPrices(book(0.9998, 1_000)).usd(KEY)).toBe(0.9998)
    expect(new LatestPrices(book(undefined, undefined)).usd("hood:native")).toBeUndefined()
  })

  test("an older read never replaces a newer one", () => {
    const latest = new LatestPrices(book(undefined, undefined))
    latest.noteMarket(market(2), 2_000)
    latest.noteMarket(market(1), 1_000)
    expect(latest.usd(MINT)).toBe(2)
  })
})
