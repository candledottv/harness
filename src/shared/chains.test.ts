// The chains: their entries as Candle's registry has them, the request-edge rule, Candle's two names for one
// Hood wallet, addresses compared and shortened, and a made-up second EVM chain that nothing takes for Hood.
import { afterEach, expect, test } from "bun:test"
import { addressKey, chainAsset, chainFromCandle, chainOf, ChainRefused, defaultEvmChain, enabledChains, enableTestChain, familyOfAddress, isAddressOn, isChainSlug, maybeChain, requestChain, sameAddress, shortAddress, TEST_CHAIN } from "./chains"

const SOL_ADDR = "So11111111111111111111111111111111111111112"
const EVM_ADDR = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"

let off: (() => void) | undefined
afterEach(() => {
  off?.()
  off = undefined
})

test("two chains ship, Solana first, with the facts of Candle's registry", () => {
  expect(enabledChains().map((c) => c.slug)).toEqual(["solana", "hood"])
  const hood = chainOf("hood")
  expect(hood).toMatchObject({ family: "evm", displayName: "Robinhood Chain", chainId: 4663, teePolicyChainId: "4663" })
  expect(hood.native).toMatchObject({ symbol: "ETH", decimals: 18 })
  expect(hood.wrappedNative?.address).toBe(EVM_ADDR)
  expect(hood.stablecoins.map((s) => [s.symbol, s.address, s.decimals])).toEqual([["USDG", USDG, 6]])
  expect(hood.quoteAssets.map((q) => q.symbol)).toEqual(["ETH", "USDG"])
  expect(chainOf("solana").quoteAssets.map((q) => q.symbol)).toEqual(["SOL", "USDC", "CNDL"])
})

test("an unknown chain, or none, is refused with the chains that are on", () => {
  expect(() => chainOf("base")).toThrow(ChainRefused)
  expect(() => chainOf("base")).toThrow('"base" isn\'t a chain the Candle Harness trades on: solana or hood.')
  expect(() => chainOf(undefined)).toThrow("No chain was named")
  expect(maybeChain("evm")).toBeUndefined()
  expect(isChainSlug("hood")).toBe(true)
  expect(isChainSlug("Hood")).toBe(false)
})

test("an address's family by its shape; a malformed one has none", () => {
  expect(familyOfAddress(SOL_ADDR)).toBe("solana")
  expect(familyOfAddress(EVM_ADDR)).toBe("evm")
  expect(familyOfAddress(EVM_ADDR.toLowerCase())).toBe("evm")
  for (const bad of ["0x1234", "0xZZd7D308f8E1639FAb988df18A8011f41EAcAD73", "O0Il", "", undefined, 42]) expect(familyOfAddress(bad)).toBeUndefined()
  expect(isAddressOn("hood", EVM_ADDR)).toBe(true)
  expect(isAddressOn("hood", SOL_ADDR)).toBe(false)
  expect(isAddressOn("solana", EVM_ADDR)).toBe(false)
})

test("the request edge: a named chain wins and must be on; with none named, the address's family takes its default", () => {
  expect(requestChain(EVM_ADDR)).toBe("hood")
  expect(requestChain(SOL_ADDR)).toBe("solana")
  expect(requestChain(EVM_ADDR, "hood")).toBe("hood")
  expect(requestChain("not an address")).toBeUndefined()
  expect(() => requestChain(EVM_ADDR, "base")).toThrow(ChainRefused)
})

test("Candle's two names for one Hood TEE wallet: the key's wallet list says evm, the portfolio says hood", () => {
  // As candle_get_trading_wallets and candle_get_portfolio answer for the same wallet.
  const fromWalletList = { address: EVM_ADDR, chain: "evm", teePolicyChainId: "4663" }
  const fromPortfolio = { address: EVM_ADDR, chain: "hood" }
  expect(chainFromCandle(fromWalletList.chain, fromWalletList)).toBe("hood")
  expect(chainFromCandle(fromPortfolio.chain)).toBe("hood")
  expect(chainFromCandle("evm")).toBe("hood")
  expect(chainFromCandle("solana")).toBe("solana")
  expect(chainFromCandle("evm", { teePolicyChainId: "1" })).toBeUndefined()
  expect(chainFromCandle("base")).toBeUndefined()
  expect(chainFromCandle(undefined)).toBeUndefined()
})

test("addresses: an EVM address is one in any case, a Solana one isn't; shortened as the screen shows them", () => {
  expect(addressKey(EVM_ADDR)).toBe(EVM_ADDR.toLowerCase())
  expect(sameAddress(EVM_ADDR, EVM_ADDR.toLowerCase())).toBe(true)
  expect(sameAddress(SOL_ADDR, SOL_ADDR.toLowerCase())).toBe(false)
  expect(shortAddress(EVM_ADDR)).toBe("0x0Bd7…AD73")
  expect(shortAddress(SOL_ADDR)).toBe("So11…1112")
  expect(shortAddress("short")).toBe("short")
})

test("a chain's assets by address, whatever its case, or the native by symbol", () => {
  expect(chainAsset("hood", USDG.toUpperCase().replace("0X", "0x"))?.symbol).toBe("USDG")
  expect(chainAsset("hood", "ETH")?.decimals).toBe(18)
  expect(chainAsset("hood", EVM_ADDR)?.symbol).toBe("WETH")
  expect(chainAsset("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.symbol).toBe("USDC")
  expect(chainAsset("solana", USDG)).toBeUndefined()
})

test("a second EVM chain, switched on by a test: an EVM wallet pinned to it is never taken for Hood, and Hood stays the default", () => {
  off = enableTestChain()
  expect(enabledChains().map((c) => c.slug)).toEqual(["solana", "hood", TEST_CHAIN])
  expect(chainFromCandle("evm", { teePolicyChainId: "900001" })).toBe(TEST_CHAIN)
  expect(chainFromCandle("evm", { teePolicyChainId: "4663" })).toBe("hood")
  // Two EVM chains on: a wallet list row with no pinned chain says nothing either way.
  expect(chainFromCandle("evm")).toBeUndefined()
  expect(requestChain(EVM_ADDR)).toBe("hood")
  expect(requestChain(EVM_ADDR, TEST_CHAIN)).toBe(TEST_CHAIN)
  expect(defaultEvmChain()?.slug).toBe("hood")
  off()
  off = undefined
  expect(maybeChain(TEST_CHAIN)).toBeUndefined()
})
