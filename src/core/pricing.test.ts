// Pricing a card when it's proposed: fresh market reads now, each price with its age and
// none older than 10 s; Candle's quote tool as soon as the agent's MCP server lists it.
import { describe, expect, test } from "bun:test"
import type { ToolOutcome } from "./candle-mcp"
import { MAX_PRICE_AGE_MS, Pricing } from "./pricing"

const MOON = "MoonFake11111111111111111111111111111111111"
const SOL = "So11111111111111111111111111111111111111112"

const USDG_KEY = "hood:0x5fc5360d0400a0fd4f2af552add042d716f1d168"

function rig(opts: { tools?: string[]; source?: "auto" | "market"; answers?: Partial<Record<string, (args: Record<string, unknown>) => ToolOutcome>>; book?: { usd: number; at: number }; refreshed?: { usd: number }; usdg?: { usd: number; at: number } } = {}) {
  let clock = 1_000_000
  const calls: { agent: string; tool: string; args: Record<string, unknown> }[] = []
  const prices: Record<string, number> = { [SOL]: 150, [MOON]: 0.63 }
  const answers: Record<string, (args: Record<string, unknown>) => ToolOutcome> = {
    candle_get_market: (args) =>
      prices[String(args.mint)] !== undefined
        ? { kind: "ok", result: { success: true, market: { chain: "solana", mint: args.mint, priceUsd: prices[String(args.mint)] } } }
        : { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} },
    candle_quote: (args) => ({ kind: "ok", result: { success: true, chain: "solana", mint: args.mint, side: args.side, amountRaw: args.amountRaw, amountOut: "23809523", quoteAsset: "sol", quoteDecimals: 9, quotedAt: clock - 500, tokenRisks: [] } }),
    ...opts.answers,
  }
  const pricing = new Pricing({
    call: async (agent, tool, args) => {
      calls.push({ agent, tool, args })
      return answers[tool]!(args)
    },
    tools: () => opts.tools ?? ["candle_get_market"],
    now: () => clock,
    config: { source: opts.source ?? "auto", quoteTool: "candle_quote" },
    book: {
      point: (key) => (key === "hood:native" ? opts.book : key === USDG_KEY ? opts.usdg : undefined),
      ...(opts.refreshed ? { refresh: async () => void (opts.book = { ...opts.refreshed!, at: clock }) } : {}),
    },
  })
  return { pricing, calls, prices, tick: (ms: number) => (clock += ms) }
}

describe("the market source", () => {
  test("reads the price fresh when a card is proposed, and says when and where it came from", async () => {
    const r = rig()
    expect(await r.pricing.asset("momentum", "SOL")).toEqual({ usd: 150, at: 1_000_000, source: "Candle market read" })
    expect(await r.pricing.token("momentum", "solana", MOON)).toEqual({ usd: 0.63, at: 1_000_000, source: "Candle market read" })
    expect(r.calls.map((c) => c.args.mint)).toEqual([SOL, MOON])
  })

  test("a price read within the last second is shared, so a burst of cards doesn't burst the reads; after that it's read again", async () => {
    const r = rig()
    await Promise.all([r.pricing.token("momentum", "solana", MOON), r.pricing.token("swing", "solana", MOON)])
    expect(r.calls).toHaveLength(1)
    r.tick(1_001)
    r.prices[MOON] = 0.7
    expect((await r.pricing.token("momentum", "solana", MOON))?.usd).toBe(0.7)
    expect(r.calls).toHaveLength(2)
  })

  test("USDG: the portfolio's price while a wallet holds some, else Candle's fixed $1, with no read spent on it", async () => {
    expect(await rig({ usdg: { usd: 1, at: 1_000_000 - 5_000 } }).pricing.asset("momentum", "USDG")).toEqual({ usd: 1, at: 995_000, source: "portfolio" })
    let refreshed = 0
    const none = rig()
    const r = new Pricing({ call: async () => ({ kind: "error", code: "X", retryable: false, body: {} }), tools: () => [], now: () => 1_000_000, config: { source: "market", quoteTool: "candle_quote" }, book: { point: () => undefined, refresh: async () => void refreshed++ } })
    expect(await r.asset("momentum", "USDG")).toEqual({ usd: 1, at: 1_000_000, source: "Candle's fixed price" })
    expect(refreshed).toBe(0)
    expect(await none.pricing.asset("momentum", "USDG")).toMatchObject({ usd: 1 })
    expect(none.calls).toEqual([])
  })

  test("ETH on Hood: the portfolio's price is fresh for a whole refresh; older, the book is read again for the card", async () => {
    // At 15 s, one refresh of the book, the price still holds: it was "no price" a third of the time at 10 s.
    expect(await rig({ book: { usd: 3000, at: 1_000_000 - 15_000 } }).pricing.asset("momentum", "ETH")).toMatchObject({ usd: 3000, source: "portfolio" })
    const stale = rig({ book: { usd: 3000, at: 1_000_000 - MAX_PRICE_AGE_MS - 1 }, refreshed: { usd: 3100 } })
    expect(await stale.pricing.asset("momentum", "ETH")).toEqual({ usd: 3100, at: 1_000_000, source: "portfolio" })
  })

  test("no price is no price: a failed read, or a fallback older than 20 s, is undefined, never an old figure", async () => {
    const r = rig({ answers: { candle_get_market: () => ({ kind: "error", code: "RATE_LIMITED", retryable: true, body: {} }) } })
    expect(await r.pricing.token("momentum", "solana", MOON)).toBeUndefined()
    // ETH on Hood has no mint to read; the portfolio's price is used only while it's fresh.
    expect(await rig({ book: { usd: 3000, at: 1_000_000 - 4_000 } }).pricing.asset("momentum", "ETH")).toEqual({ usd: 3000, at: 996_000, source: "portfolio" })
    expect(await rig({ book: { usd: 3000, at: 1_000_000 - MAX_PRICE_AGE_MS - 1 } }).pricing.asset("momentum", "ETH")).toBeUndefined()
    // USDG isn't an old figure: Candle holds it at $1 (the test above).
  })
})

describe("the quote source, switched on by the MCP server listing it", () => {
  const trade = { chain: "solana" as const, mint: MOON, side: "buy" as const, amountRaw: "100000000", quoteAsset: "sol" }

  test("until the server lists the quote tool, there's no quote and the market source prices the card", async () => {
    const r = rig()
    expect(r.pricing.sourceFor("momentum")).toBe("market")
    expect(await r.pricing.quote("momentum", trade)).toBeUndefined()
    expect(r.calls).toEqual([])
  })

  test("once it's listed, the card gets Candle's quote for the exact trade", async () => {
    const r = rig({ tools: ["candle_get_market", "candle_quote"] })
    expect(r.pricing.sourceFor("momentum")).toBe("quote")
    expect(await r.pricing.quote("momentum", trade)).toEqual({ amountOutRaw: "23809523", quoteAsset: "sol", quotedAt: 999_500, tokenRisks: [] })
    expect(r.calls[0]).toEqual({ agent: "momentum", tool: "candle_quote", args: trade })
  })

  test("pricing.source = market keeps the market source even when the quote tool is there", async () => {
    const r = rig({ tools: ["candle_quote"], source: "market" })
    expect(r.pricing.sourceFor("momentum")).toBe("market")
    expect(await r.pricing.quote("momentum", trade)).toBeUndefined()
  })

  test("a quote that fails, or can't be read, is no quote: the card falls back to the market estimate", async () => {
    const failing = rig({ tools: ["candle_quote"], answers: { candle_quote: () => ({ kind: "error", code: "QUOTE_UNAVAILABLE", retryable: true, body: {} }) } })
    expect(await failing.pricing.quote("momentum", trade)).toBeUndefined()
    const garbled = rig({ tools: ["candle_quote"], answers: { candle_quote: () => ({ kind: "ok", result: { success: true } }) } })
    expect(await garbled.pricing.quote("momentum", trade)).toBeUndefined()
  })

  test("a quote that says the key can't use the embedded wallet carries that through", async () => {
    const r = rig({ tools: ["candle_quote"], answers: { candle_quote: () => ({ kind: "ok", result: { success: true, amountOut: "5", quoteAsset: "sol", quotedAt: 1, payerPermitted: false } }) } })
    expect(await r.pricing.quote("momentum", trade)).toMatchObject({ payerPermitted: false })
  })
})
