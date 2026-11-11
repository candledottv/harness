// The base assets, by their real mints (docs.candle.tv/developers/networks-and-contracts) and the price keys the
// portfolio uses for Hood (agentic tools.ts, candle_get_portfolio). A price or a quote asset is only
// ever looked up by mint: anyone can launch a token whose symbol is "USDC".
import { addressKey, type ChainSlug, chainOf, enabledChains, maybeChain, spentAssetAt } from "../shared/chains"

export type BaseAsset = "SOL" | "USDC" | "CNDL" | "ETH" | "USDG"

// USDG's contract, price key and Candle's fixed $1 are the chain registry's (docs.candle.tv/developers/networks-and-contracts).
const usdg = chainOf("hood").stablecoins.find((a) => a.symbol === "USDG")!

export const BASE_ASSETS: Readonly<Record<BaseAsset, { chain: ChainSlug; priceKey: string | undefined; decimals: number; address?: string }>> = {
  SOL: { chain: "solana", priceKey: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { chain: "solana", priceKey: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  CNDL: { chain: "solana", priceKey: "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL", decimals: 6 },
  ETH: { chain: "hood", priceKey: "hood:native", decimals: 18 },
  USDG: { chain: "hood", priceKey: usdg.priceKey, decimals: usdg.decimals, address: usdg.address },
}

export function isBaseAsset(value: unknown): value is BaseAsset {
  return typeof value === "string" && Object.hasOwn(BASE_ASSETS, value)
}

/** The base asset a quote mint names, if it's one of them: by its mint or price key, or an EVM contract's address in any case. */
export function baseAssetForMint(mint: unknown): BaseAsset | undefined {
  if (typeof mint !== "string") return undefined
  for (const [asset, info] of Object.entries(BASE_ASSETS)) {
    if (info.priceKey === mint || (info.address !== undefined && addressKey(info.address) === addressKey(mint))) return asset as BaseAsset
  }
  return undefined
}

/**
 * What trades spend, by a mint: SOL, USDC, ETH and USDG, and a chain's wrapped native (WETH on Hood), whose trades spend
 * it as the native asset. CNDL is a quote asset too, but people trade it like any token (a CNDL row that followed
 * nothing did nothing). With a chain, only that chain's: the same contract address on another EVM chain is another token.
 */
export function spentSymbol(mint: unknown, chain?: ChainSlug): string | undefined {
  if (typeof mint !== "string") return undefined
  const on = (slug: ChainSlug) => chain === undefined || chain === slug
  const base = baseAssetForMint(mint)
  if (base !== undefined && base !== "CNDL" && on(BASE_ASSETS[base].chain)) return base
  for (const c of chain === undefined ? enabledChains() : [maybeChain(chain)].flatMap((c) => (c ? [c] : []))) {
    const asset = spentAssetAt(c, mint)
    if (asset && asset.symbol !== "CNDL" && !isBaseAsset(asset.symbol)) return asset.symbol
  }
  return undefined
}

/** Whether the token pane follows a mint: every token but what trades spend (`spentSymbol`). */
export function followable(mint: unknown): boolean {
  return spentSymbol(mint) === undefined
}

/**
 * Why a mint can't be a trade's token, or undefined where it can: what trades spend (SOL, USDC, ETH, USDG) is
 * converted with a swap, and a wrapped native is the native asset in another form. The same words on the live path and
 * the paper one. `chain`, when the request names one, keeps another EVM chain's token at the same address tradeable.
 */
export function notATradeToken(mint: unknown, chain?: ChainSlug): string | undefined {
  const spent = spentSymbol(mint, chain)
  if (spent === undefined) return undefined
  if (!isBaseAsset(spent)) {
    const entry = enabledChains().find((c) => c.wrappedNative?.symbol === spent)
    return `${spent} is wrapped ${entry?.native.symbol ?? "native"}, which trades on ${entry?.name ?? "its chain"} spend as ${entry?.native.symbol ?? "the native asset"}: it isn't a token to buy or sell. Nothing was sent.`
  }
  return `${spent} is what trades spend, not a token to buy or sell: convert it with a swap (candle_swap). Nothing was sent.`
}

/** A trade's `quoteAsset` ("sol", "usdc", "cndl", "eth", "usdg") as a base asset; SOL when unset. */
export function quoteAssetOf(value: unknown): BaseAsset | undefined {
  if (value === undefined) return "SOL"
  const upper = typeof value === "string" ? value.toUpperCase() : ""
  return isBaseAsset(upper) ? upper : undefined
}

/** A decimal string in base units, exactly: "1.5" with 9 decimals is 1500000000n. Undefined if it isn't one. */
export function toRaw(amount: string, decimals: number): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim())
  if (!match) return undefined
  const [, whole, frac = ""] = match
  if (frac.length > decimals) return undefined
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")
}

/** Base units as a decimal string, trailing zeros trimmed. */
export function fromRaw(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const whole = raw / scale
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : `${whole}`
}

/**
 * The asset a trade spends (a buy) or pays out (a sell). Candle trades a token against one of the
 * chain's base assets and routes to it itself (Jupiter or DFlow on Solana, the DEX race on Hood), so
 * the token's own pool pair, which for a new token can be almost anything, never limits it
 * (docs.candle.tv/developers/agent-trading, "Tier gating"):
 *   - a Candle-launched token's pair is fixed, its own quote mint, and `quoteAsset` is ignored;
 *   - any other token settles in the trade's `quoteAsset`: SOL, USDC or CNDL on Solana (SOL when
 *     unset), ETH or USDG on Hood (ETH when unset).
 * `asset` is undefined for a Candle pair the Candle Harness doesn't know; `invalid` names a quoteAsset that
 * isn't one of the chain's.
 */
export function settlementAsset(
  market: { chain: ChainSlug; candleLaunched: boolean; quoteMint?: string },
  quoteAsset: unknown,
): { asset: BaseAsset | undefined } | { invalid: string } {
  if (market.candleLaunched) return { asset: baseAssetForMint(market.quoteMint) }
  const chainAssets = (Object.keys(BASE_ASSETS) as BaseAsset[]).filter((a) => BASE_ASSETS[a].chain === market.chain)
  if (quoteAsset === undefined) return { asset: market.chain === "hood" ? "ETH" : "SOL" }
  const asset = typeof quoteAsset === "string" ? quoteAsset.toUpperCase() : ""
  if (isBaseAsset(asset) && BASE_ASSETS[asset].chain === market.chain) return { asset }
  return { invalid: `quoteAsset is ${chainAssets.map((a) => `"${a.toLowerCase()}"`).join(", ").replace(/, ([^,]*)$/, " or $1")} for a token on ${market.chain === "hood" ? "Hood" : "Solana"}.` }
}

/** A USD price as people read one: cents above $1, four significant figures below. */
export function priceText(usd: number): string {
  if (usd >= 1) return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${Number(usd.toPrecision(4))}`
}

/** An estimated amount, rounded for reading: whole from 1,000 up, four significant figures below. */
export function amountText(n: number): string {
  if (n >= 1000) return Math.round(n).toLocaleString("en-US")
  return String(Number(n.toPrecision(4)))
}
