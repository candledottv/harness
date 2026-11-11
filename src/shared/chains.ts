// The chains the Candle Harness trades on, shaped like Candle's shared chain registry
// (candle-monorepo packages/shared/src/chains/registry.json): a slug, a family, a display name, whether it's
// enabled, the native asset, and for an EVM chain its chain id, wrapped native, stablecoins and quote assets.
//
// The chain is never guessed from an address in new code. It comes from Candle's answer, the chain a request
// names, or the row it was stored on. An address's shape decides only its family, and only at a request's edge
// (a typed line, a pasted address, the one-time fill of old rows): `requestChain` then takes the family's
// default chain, as Candle's own request edge does ("an explicit chain is authoritative; a chain-less EVM
// address takes the documented default EVM chain").
//
// Every other file reads chains through here: a check fails on a written-out chain union, a Solana address
// pattern or a `0x` test anywhere else.
import { SHIPPED } from "../version"

/** A chain's slug, as Candle's registry and every chain parameter name it. */
export type ChainSlug = "solana" | "hood"
/** A chain's family: how its addresses look and how it signs. */
export type ChainFamily = "solana" | "evm"

export interface ChainAsset {
  symbol: string
  /** The asset's contract (EVM) or mint (Solana). The native asset of an EVM chain has none. */
  address?: string
  decimals: number
  /** The key the portfolio's prices use for it, where Candle gives it one. */
  priceKey?: string
  /** A price Candle holds fixed for it, in dollars, whatever any read says (USDG's $1). */
  fixedUsd?: number
}

export interface ChainEntry {
  slug: ChainSlug
  family: ChainFamily
  displayName: string
  /** The name the Candle Harness's words use for it (`Solana`, `Hood`). */
  name: string
  /** The short word the screen tags a row with (`sol`, `hood`). */
  tag: string
  enabled: boolean
  native: ChainAsset
  stablecoins: readonly ChainAsset[]
  /** What a token on this chain can trade against, by address (the native asset by its symbol). */
  quoteAssets: readonly ChainAsset[]
  /** EVM only: the chain id, and the id a TEE wallet's signing policy is pinned to. */
  chainId?: number
  teePolicyChainId?: string
  wrappedNative?: ChainAsset
  /** EVM only: the RPC the candle CLI reads the chain over when none is set (its built-in). */
  publicRpcUrl?: string
}

const SOL_MINT = "So11111111111111111111111111111111111111112"
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const CNDL_MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
// Hood's contracts, from Candle's registry entry `hood` and docs.candle.tv/developers/networks-and-contracts.
const HOOD_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
const HOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
// Candle values USDG at a fixed $1 everywhere it prices it (its fee-claims pricing), and prices ETH from Hood's WETH/USDG
// pools, so the portfolio's USDG price, when a wallet holds some, is that same $1.
const USDG: ChainAsset = { symbol: "USDG", address: HOOD_USDG, decimals: 6, priceKey: `hood:${HOOD_USDG}`, fixedUsd: 1 }

const SOLANA: ChainEntry = {
  slug: "solana",
  family: "solana",
  displayName: "Solana",
  name: "Solana",
  tag: "sol",
  enabled: true,
  native: { symbol: "SOL", address: SOL_MINT, decimals: 9, priceKey: SOL_MINT },
  stablecoins: [{ symbol: "USDC", address: USDC_MINT, decimals: 6, priceKey: USDC_MINT }],
  // Candle's trade route on Solana: SOL, USDC or CNDL (docs.candle.tv/developers/agent-trading).
  quoteAssets: [
    { symbol: "SOL", address: SOL_MINT, decimals: 9, priceKey: SOL_MINT },
    { symbol: "USDC", address: USDC_MINT, decimals: 6, priceKey: USDC_MINT },
    { symbol: "CNDL", address: CNDL_MINT, decimals: 6, priceKey: CNDL_MINT },
  ],
}

const HOOD: ChainEntry = {
  slug: "hood",
  family: "evm",
  displayName: "Robinhood Chain",
  name: "Hood",
  tag: "hood",
  enabled: true,
  // The portfolio prices ETH under `hood:native` and an ERC-20 under `hood:<lowercase address>`.
  native: { symbol: "ETH", decimals: 18, priceKey: "hood:native" },
  stablecoins: [USDG],
  quoteAssets: [{ symbol: "ETH", decimals: 18, priceKey: "hood:native" }, USDG],
  chainId: 4663,
  teePolicyChainId: "4663",
  wrappedNative: { symbol: "WETH", address: HOOD_WETH, decimals: 18, priceKey: `hood:${HOOD_WETH.toLowerCase()}` },
  // The candle CLI's built-in Hood RPC (cli/src/evm-lite.ts), used when CANDLE_EVM_RPC_URL isn't set.
  publicRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
}

/**
 * A made-up second EVM chain, for tests only: its own chain id, native and stablecoin, so a test can show that
 * nothing takes an EVM address for Hood. Switched on by `enableTestChain`, never by config.
 */
const TEST_EVM: ChainEntry = {
  slug: "testevm" as ChainSlug,
  family: "evm",
  displayName: "Test EVM",
  name: "Test EVM",
  tag: "tevm",
  enabled: true,
  native: { symbol: "TETH", decimals: 18, priceKey: "testevm:native" },
  stablecoins: [{ symbol: "TUSD", address: "0x00000000000000000000000000000000000a11ce", decimals: 6, priceKey: "testevm:0x00000000000000000000000000000000000a11ce" }],
  quoteAssets: [
    { symbol: "TETH", decimals: 18, priceKey: "testevm:native" },
    { symbol: "TUSD", address: "0x00000000000000000000000000000000000a11ce", decimals: 6, priceKey: "testevm:0x00000000000000000000000000000000000a11ce" },
  ],
  chainId: 900_001,
  teePolicyChainId: "900001",
}

let registry: readonly ChainEntry[] = [SOLANA, HOOD]

/** The test chain's slug, for tests that switch it on. */
export const TEST_CHAIN = TEST_EVM.slug

/** Switches the test-only EVM chain on, for a test; returns what switches it off. Refused in a shipped build. */
export function enableTestChain(): () => void {
  if (SHIPPED) throw new Error("The test chain is for tests only.")
  const before = registry
  registry = [...before.filter((c) => c.slug !== TEST_EVM.slug), TEST_EVM]
  return () => {
    registry = before
  }
}

/** Every chain that's on, Solana first. */
export const enabledChains = (): readonly ChainEntry[] => registry.filter((c) => c.enabled)

/** A slug's entry when it's a chain that's on; undefined otherwise. */
export function maybeChain(slug: unknown): ChainEntry | undefined {
  return typeof slug === "string" ? registry.find((c) => c.slug === slug && c.enabled) : undefined
}

/** Whether a value is the slug of a chain that's on. */
export const isChainSlug = (value: unknown): value is ChainSlug => maybeChain(value) !== undefined

export class ChainRefused extends Error {
  readonly code = "UNKNOWN_CHAIN"
}

/** A slug's entry; an unknown chain, or one that isn't on, is refused with the chains that are. */
export function chainOf(slug: unknown): ChainEntry {
  const entry = maybeChain(slug)
  if (entry) return entry
  throw new ChainRefused(`${typeof slug === "string" && slug ? `"${slug}" isn't a chain the Candle Harness trades on` : "No chain was named"}: ${enabledChains().map((c) => c.slug).join(" or ")}.`)
}

/** The chain an EVM address with no chain named goes to: the first EVM chain that's on (Hood today), as Candle's request edge does. */
export function defaultEvmChain(): ChainEntry | undefined {
  return enabledChains().find((c) => c.family === "evm")
}

/**
 * The address shapes, as pattern sources for a file that builds its own expression (anchored, in text, with
 * look-arounds). Base58 leaves out 0, O, I and l; the loose Solana shape keeps them, for words that only need to
 * look like an address (one mistyped, or captured from the CLI's output) before a strict check says more.
 */
export const SOLANA_ADDRESS_SOURCE = "[1-9A-HJ-NP-Za-km-z]{32,44}"
export const LOOSE_SOLANA_ADDRESS_SOURCE = "[0-9A-Za-z]{32,44}"
export const EVM_ADDRESS_SOURCE = "0x[0-9a-fA-F]{40}"
/** Something starting like an EVM address, with any number of hex digits: one cut short or run on. */
export const LOOSE_EVM_ADDRESS_SOURCE = "0x[0-9a-fA-F]"

const EVM_ADDRESS = new RegExp(`^${EVM_ADDRESS_SOURCE}$`)
const SOLANA_ADDRESS = new RegExp(`^${SOLANA_ADDRESS_SOURCE}$`)

/** Whether a word starts as an EVM address does (`0x`, either case of x being allowed only where said). */
export const startsAsEvm = (word: string): boolean => word.startsWith("0x")

/** An address's family by its shape alone. For a request's edge only: a stored row carries its own chain. */
export function familyOfAddress(address: unknown): ChainFamily | undefined {
  if (typeof address !== "string") return undefined
  if (EVM_ADDRESS.test(address)) return "evm"
  if (SOLANA_ADDRESS.test(address)) return "solana"
  return undefined
}

/** Whether an address is in the shape of an EVM address, `0x` and 40 hex digits, whatever chain it's on. */
export const isEvmAddress = (address: unknown): boolean => familyOfAddress(address) === "evm"

/** Whether an address is in the shape of a Solana address. */
export const isSolanaAddress = (address: unknown): boolean => familyOfAddress(address) === "solana"

/** Whether an address can be one on this chain: its shape is the chain's family's. */
export function isAddressOn(chain: ChainSlug | ChainEntry, address: unknown): boolean {
  const entry = typeof chain === "string" ? maybeChain(chain) : chain
  return entry !== undefined && familyOfAddress(address) === entry.family
}

/**
 * The chain a request goes to: the chain it names wins (and must be one that's on); with none named, a Solana
 * address is Solana's and an EVM address goes to the default EVM chain. Undefined when neither settles it.
 */
export function requestChain(address: unknown, chain?: unknown): ChainSlug | undefined {
  if (chain !== undefined && chain !== null && chain !== "") return chainOf(chain).slug
  const family = familyOfAddress(address)
  if (family === "solana") return "solana"
  if (family === "evm") return defaultEvmChain()?.slug
  return undefined
}

/**
 * Candle's chain markers as a slug. `solana` and a chain's own slug pass as they are. `evm`, the family the key's
 * wallet list names a TEE wallet with, is the EVM chain whose signing policy the wallet is pinned to, or the
 * only EVM chain that's on when no policy chain is given. Undefined for a marker no chain answers to.
 */
export function chainFromCandle(marker: unknown, wallet?: { teePolicyChainId?: unknown; chainId?: unknown }): ChainSlug | undefined {
  if (typeof marker !== "string") return undefined
  const named = maybeChain(marker)
  if (named) return named.slug
  if (marker !== "evm") return undefined
  const evm = enabledChains().filter((c) => c.family === "evm")
  const pinned = wallet?.teePolicyChainId ?? wallet?.chainId
  if (pinned !== undefined && pinned !== null) return evm.find((c) => c.teePolicyChainId === String(pinned) || c.chainId === Number(pinned))?.slug
  return evm.length === 1 ? evm[0]!.slug : undefined
}

/** The key two spellings of one address share: an EVM address is the same in any case (its mixed case is only a checksum); a Solana one is case-sensitive. */
export const addressKey = (address: string): string => (/^0x/i.test(address) ? address.toLowerCase() : address)

/** Whether two addresses are the same one, whatever case an EVM address was written in. */
export const sameAddress = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && addressKey(a) === addressKey(b)

/** An address as the screen shortens it: an EVM one keeps `0x` and four characters each end, a Solana one four each end. */
export function shortAddress(address: string): string {
  const head = /^0x/i.test(address) ? 6 : 4
  return address.length > head + 8 ? `${address.slice(0, head)}…${address.slice(-4)}` : address
}

/** A chain's native asset, stablecoins and quote assets, found by address (case as the chain has it) or the native's symbol. */
export function chainAsset(chain: ChainSlug | ChainEntry, addressOrSymbol: string): ChainAsset | undefined {
  const entry = typeof chain === "string" ? maybeChain(chain) : chain
  if (!entry) return undefined
  const all = [entry.native, ...entry.stablecoins, ...entry.quoteAssets, ...(entry.wrappedNative ? [entry.wrappedNative] : [])]
  const key = addressKey(addressOrSymbol)
  return all.find((a) => (a.address !== undefined && addressKey(a.address) === key) || (a.address === undefined && a.symbol === addressOrSymbol))
}

/**
 * The key the portfolio's `prices` map gives a token: a Solana mint as it is, an EVM token as
 * `<chain>:<lowercase address>` (Candle's hood-portfolio prices, `hood:0x…`).
 */
export function tokenPriceKey(chain: ChainSlug | ChainEntry, address: string): string {
  const entry = typeof chain === "string" ? maybeChain(chain) : chain
  return entry?.family === "evm" ? `${entry.slug}:${address.toLowerCase()}` : address
}

/** The price Candle holds fixed for the asset under a portfolio price key, on a chain that's on; undefined for every other. */
export function fixedUsd(priceKey: string | undefined): number | undefined {
  if (priceKey === undefined) return undefined
  for (const c of enabledChains()) for (const a of [c.native, ...c.stablecoins, ...c.quoteAssets]) if (a.priceKey === priceKey && a.fixedUsd !== undefined) return a.fixedUsd
  return undefined
}

/**
 * What a chain's trades spend that isn't a token to trade, found by address in any case: the chain's quote assets, and its
 * wrapped native (WETH on Hood), which is the native asset in another form. Undefined for any other address.
 */
export function spentAssetAt(chain: ChainSlug | ChainEntry, address: string): ChainAsset | undefined {
  const entry = typeof chain === "string" ? maybeChain(chain) : chain
  if (!entry) return undefined
  const key = addressKey(address)
  return [...entry.quoteAssets, ...(entry.wrappedNative ? [entry.wrappedNative] : [])].find((a) => a.address !== undefined && addressKey(a.address) === key)
}

/**
 * A stored row's chain: the one it was written with, or, for a row from before rows carried one, its address's
 * family's chain. The one place an old row's chain is read from an address's shape; new rows always carry theirs.
 */
export function storedChain(chain: unknown, address: unknown): ChainSlug | undefined {
  return maybeChain(chain)?.slug ?? requestChain(address)
}

/** A chain's name in the Candle Harness's words (`Solana`, `Hood`), or the slug as given when it's no chain that's on. */
export const chainName = (slug: unknown): string => maybeChain(slug)?.name ?? (typeof slug === "string" ? slug : "an unknown chain")

/** `{ chain }` to spread into a row, or nothing when there's no chain. */
export const chainField = (chain: ChainSlug | undefined): { chain?: ChainSlug } => (chain ? { chain } : {})
