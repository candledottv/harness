import { expect, test } from "bun:test"
import { enableTestChain, TEST_CHAIN } from "../shared/chains"
import { amountText, BASE_ASSETS, baseAssetForMint, followable, notATradeToken, priceText, settlementAsset } from "./assets"

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"

const solana = { chain: "solana" as const, candleLaunched: false }
const hood = { chain: "hood" as const, candleLaunched: false }

test("a Candle-launched token settles in its own pair asset, whatever quoteAsset says", () => {
  expect(settlementAsset({ chain: "solana", candleLaunched: true, quoteMint: BASE_ASSETS.USDC.priceKey }, "sol")).toEqual({ asset: "USDC" })
  // A pair the Candle Harness doesn't know: no asset, so no price, but not a refusal: Candle knows its own pair.
  expect(settlementAsset({ chain: "solana", candleLaunched: true, quoteMint: "PairFake11111111111111111111111111111111111" }, undefined)).toEqual({ asset: undefined })
})

test("any other token settles in quoteAsset, routed by Candle: SOL by default on Solana, ETH on Hood", () => {
  expect(settlementAsset(solana, undefined)).toEqual({ asset: "SOL" })
  expect(settlementAsset(solana, "usdc")).toEqual({ asset: "USDC" })
  expect(settlementAsset(solana, "CNDL")).toEqual({ asset: "CNDL" })
  expect(settlementAsset(hood, undefined)).toEqual({ asset: "ETH" })
  expect(settlementAsset(hood, "usdg")).toEqual({ asset: "USDG" })
})

test("a quoteAsset that isn't one of the chain's is invalid", () => {
  expect(settlementAsset(solana, "eth")).toEqual({ invalid: 'quoteAsset is "sol", "usdc" or "cndl" for a token on Solana.' })
  expect(settlementAsset(hood, "sol")).toEqual({ invalid: 'quoteAsset is "eth" or "usdg" for a token on Hood.' })
  expect("invalid" in settlementAsset(solana, "usdt")).toBe(true)
})

test("prices and estimates read as people write them", () => {
  expect(priceText(150)).toBe("$150.00")
  expect(priceText(2316.2855)).toBe("$2,316.29")
  expect(priceText(0.63)).toBe("$0.63")
  expect(priceText(0.0000123456)).toBe("$0.00001235")
  expect(amountText(121951.2)).toBe("121,951")
  expect(amountText(25.9259)).toBe("25.93")
  expect(amountText(0.123456)).toBe("0.1235")
})

test("USDG's price key is the portfolio's, lowercased, and its contract names it in any case", () => {
  expect(BASE_ASSETS.USDG.priceKey).toBe("hood:0x5fc5360d0400a0fd4f2af552add042d716f1d168")
  for (const spelling of [USDG, USDG.toLowerCase(), USDG.toUpperCase().replace("0X", "0x"), BASE_ASSETS.USDG.priceKey]) expect(baseAssetForMint(spelling)).toBe("USDG")
  expect(baseAssetForMint("hood:native")).toBe("ETH")
  expect(baseAssetForMint(WETH)).toBeUndefined()
})

test("what trades spend is refused as a trade's token by address: SOL and USDC as before, USDG and WETH in any case", () => {
  expect(notATradeToken(BASE_ASSETS.SOL.priceKey)).toBe("SOL is what trades spend, not a token to buy or sell: convert it with a swap (candle_swap). Nothing was sent.")
  expect(notATradeToken(BASE_ASSETS.USDC.priceKey)).toContain("USDC is what trades spend")
  expect(notATradeToken(USDG.toLowerCase())).toBe("USDG is what trades spend, not a token to buy or sell: convert it with a swap (candle_swap). Nothing was sent.")
  expect(notATradeToken(USDG, "hood")).toContain("USDG is what trades spend")
  for (const spelling of [WETH, WETH.toLowerCase()]) {
    expect(notATradeToken(spelling)).toBe("WETH is wrapped ETH, which trades on Hood spend as ETH: it isn't a token to buy or sell. Nothing was sent.")
    expect(followable(spelling)).toBe(false)
  }
  expect(followable(USDG)).toBe(false)
  // CNDL trades like any token, and any other token is one.
  expect(notATradeToken(BASE_ASSETS.CNDL.priceKey)).toBeUndefined()
  expect(followable(BASE_ASSETS.CNDL.priceKey)).toBe(true)
  expect(notATradeToken("0x00000000000000000000000000000000000b0b01")).toBeUndefined()
  expect(notATradeToken(undefined)).toBeUndefined()
})

test("the same address on another EVM chain is that chain's token: a request naming its chain isn't refused as Hood's USDG", () => {
  const off = enableTestChain()
  try {
    expect(notATradeToken(USDG, TEST_CHAIN)).toBeUndefined()
    expect(notATradeToken(WETH, TEST_CHAIN)).toBeUndefined()
    expect(notATradeToken(USDG, "hood")).toBeDefined()
  } finally {
    off()
  }
})
