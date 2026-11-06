import { expect, test } from "bun:test"
import { amountText, BASE_ASSETS, priceText, settlementAsset } from "./assets"

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
