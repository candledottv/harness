// A fill read from each shape Candle answers a trade in: the embedded wallet's `api.amounts`, a TEE wallet's
// `amounts` at the top, a paper trade's quote, and a read-back that says only what was sent. The shapes are the
// recorded passes', with their ids made up.
import { describe, expect, test } from "bun:test"
import { fillOfRow, netAssetRaw, readFill } from "./fill"

const MINT = "MoonFake11111111111111111111111111111111111"
const TEE = "TeeWa11etFake1111111111111111111111111111111"

const embedded = (amounts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  clientTradeId: "op-1",
  resolved: { amountRaw: amounts.amountRaw },
  api: { success: true, status: "executed", chain: "solana", signature: "sig", fee: { bps: 25, feeRaw: "24930" }, amounts: { quoteAsset: "sol", ...amounts }, ...extra },
})

describe("readFill", () => {
  test("an embedded buy: the tokens are what the chain says it received, the spend and the fee in SOL", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "9971953", expectedOutRaw: "554327460", minOutRaw: "548784186", actualOutRaw: "554300000", slippageBps: 0 }) })
    expect(fill).toEqual({ side: "buy", mint: MINT, wallet: "embedded", asset: "SOL", tokensRaw: "554300000", assetRaw: "9971953", feeRaw: "24930", measured: "chain" })
    // A buy's outflow is the spend plus the fee, on top.
    expect(netAssetRaw(fill!)).toBe(9971953n + 24930n)
  })

  test("an embedded sell: the tokens are what it sold; the proceeds are the swap's, less the fee withheld", () => {
    const fill = readFill({ side: "sell", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "560726141", expectedOutRaw: "9413308", actualOutRaw: "7948460", slippageBps: 1556 }, { fee: { bps: 25, feeRaw: "23592" } }) })
    expect(fill).toMatchObject({ side: "sell", tokensRaw: "560726141", assetRaw: "7948460", feeRaw: "23592", measured: "chain" })
    expect(netAssetRaw(fill!)).toBe(7948460n - 23592n)
  })

  test("a fill Candle couldn't read off the chain stands on the quote, and says so", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1000", expectedOutRaw: "5000" }) })
    expect(fill).toMatchObject({ tokensRaw: "5000", measured: "quote" })
  })

  test("a TEE wallet's answer has its amounts at the top, and the card gives the side and the mint", () => {
    const result = { success: true, status: "executed", chain: "solana", signature: "sig", fee: { bps: 25, feeRaw: "24818" }, amounts: { amountRaw: "9927091", expectedOutRaw: "597746265", actualOutRaw: "597746265", quoteAsset: "sol" }, kind: "trade", wallet: TEE }
    expect(readFill({ side: "buy", mint: MINT, wallet: TEE, result })).toMatchObject({ wallet: TEE, tokensRaw: "597746265", assetRaw: "9927091", feeRaw: "24818", measured: "chain" })
  })

  test("a paper buy and sell are Candle's quote, with the token's decimals", () => {
    const buy = { clientTradeId: "p1", api: { success: true, paper: true, side: "buy", mint: MINT, quoteAsset: "sol", amountRaw: "9992840", expectedOutRaw: "557678983", feeRaw: "24983", tokenDecimals: 11, tokenAmount: 0.00557678983 } }
    expect(readFill({ wallet: "embedded", result: buy, paper: true })).toEqual({
      side: "buy",
      mint: MINT,
      wallet: "paper",
      asset: "SOL",
      tokensRaw: "557678983",
      assetRaw: "9992840",
      feeRaw: "24983",
      measured: "quote",
      tokenDecimals: 11,
      paper: true,
    })
    const sell = { api: { success: true, paper: true, side: "sell", mint: MINT, quoteAsset: "sol", amountRaw: "557678983", expectedOutRaw: "9658687", feeRaw: "24207", tokenDecimals: 11 } }
    expect(readFill({ wallet: "paper", result: sell })).toMatchObject({ side: "sell", tokensRaw: "557678983", assetRaw: "9658687", paper: true })
  })

  test("a buy read back by its id says what was sent, not what it received", () => {
    const job = { clientTradeId: "op-1", chain: "solana", side: "buy", mint: MINT, quoteAsset: "sol", amountRaw: "9961543", status: "confirmed", signature: "sig" }
    const fill = readFill({ wallet: "embedded", result: job })
    expect(fill).toEqual({ side: "buy", mint: MINT, wallet: "embedded", asset: "SOL", assetRaw: "9961543", measured: "none" })
    expect(readFill({ wallet: "embedded", result: { ...job, side: "sell" } })).toMatchObject({ side: "sell", tokensRaw: "9961543", measured: "none" })
  })

  test("an answer that names no pair asset is read in the card's own, or ETH for a 0x mint: never SOL for a Hood trade", () => {
    const HOOD = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
    const result = { api: { success: true, status: "executed", chain: "hood", fee: { feeRaw: "2500000000000" }, amounts: { amountRaw: "1000000000000000", actualOutRaw: "42000000" } } }
    expect(readFill({ side: "buy", mint: HOOD, wallet: "embedded", result })).toMatchObject({ asset: "ETH", assetRaw: "1000000000000000", tokensRaw: "42000000" })
    expect(readFill({ side: "buy", mint: HOOD, wallet: "embedded", result, fallbackAsset: "USDG" })).toMatchObject({ asset: "USDG" })
    // A Solana trade that settles in USDC, with the asset left off the answer: the card's, not SOL.
    const sol = { api: { success: true, amounts: { amountRaw: "5000000", actualOutRaw: "1" } } }
    expect(readFill({ side: "buy", mint: MINT, wallet: "embedded", result: sol, fallbackAsset: "USDC" })).toMatchObject({ asset: "USDC" })
    expect(readFill({ side: "buy", mint: MINT, wallet: "embedded", result: sol })).toMatchObject({ asset: "SOL" })
  })

  test("not a trade's answer, or no side or mint anywhere: no fill", () => {
    expect(readFill({ wallet: "embedded", result: { success: true, imageUrl: "https://example.com/a.png" } })).toBeUndefined()
    expect(readFill({ wallet: "embedded", result: "text" })).toBeUndefined()
    expect(readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1", quoteAsset: "doge" }) })).toBeUndefined()
  })

  test("a fill on a row reads back only when it has its shape", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1", actualOutRaw: "2" }) })!
    expect(fillOfRow({ fill })).toEqual(fill)
    expect(fillOfRow({ fill: { side: "buy" } })).toBeUndefined()
    expect(fillOfRow({})).toBeUndefined()
  })
})
