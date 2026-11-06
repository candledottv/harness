// A buy sized in dollars. `amountUsd` is the Candle Harness's own field on
// candle_trade, offered to the agent and taken by typed commands (`buy $25 MOON`); Candle never sees
// it. When the card is proposed, or a paper trade is sent, the core turns it into an `amount` of the
// asset the buy spends, at that asset's price then, rounded down to the asset's decimals. The card
// shows both, and its hash binds the converted amount, so what runs is exactly what the card showed.
// It isn't exactly the dollar figure if the price moves during the card's 60 s; a late approve
// proposes a fresh card at the new price. The asset's price is read fresh (pricing.ts):
// with no price from the last 10 s, the buy is refused rather than converted at an old one.
//
// The asset it spends: a Candle-launched token's own pair asset; for any other token the trade's
// `quoteAsset`, else the configured `trade.spendAsset` on Solana (SOL unless set), else ETH on Hood.
import type { SpendAsset } from "../config"
import { BASE_ASSETS, type BaseAsset, fromRaw, settlementAsset } from "./assets"
import type { Resolved } from "./markets"
import type { PricePoint } from "./pricing"

export type { SpendAsset }

export interface SizingDeps {
  markets: { resolve(agent: string, mint: string): Promise<Resolved> }
  pricing: { asset(agent: string, asset: BaseAsset): Promise<PricePoint | undefined> }
  spendAsset: () => SpendAsset
}

export type Sized =
  | { ok: true; args: Record<string, unknown>; fromUsd?: { usd: number; asset: BaseAsset; assetPriceUsd: number; pricedAt: number } }
  | { ok: false; code: string; message: string }

const DOLLARS = /^\d+(\.\d{1,2})?$/

export async function sizeInUsd(agent: string, args: Record<string, unknown>, deps: SizingDeps): Promise<Sized> {
  if (args.amountUsd === undefined) return { ok: true, args }
  const { amountUsd, ...rest } = args
  const fail = (message: string, code = "INVALID_TRADE"): Sized => ({ ok: false, code, message })
  const text = typeof amountUsd === "number" && Number.isFinite(amountUsd) ? String(amountUsd) : amountUsd
  if (typeof text !== "string" || !DOLLARS.test(text) || Number(text) <= 0) return fail('amountUsd is a dollar amount, such as "25" or "12.50".')
  if (rest.side !== "buy") return fail("amountUsd sizes buys only. Sell an amount of the token, or a percent.")
  if (rest.amount !== undefined || rest.percent !== undefined) return fail("Pass amountUsd or amount, not both.")
  if (typeof rest.mint !== "string" || rest.mint.length === 0) return fail("A trade needs the token's mint.")

  const resolved = await deps.markets.resolve(agent, rest.mint)
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message }
  const market = resolved.market
  const quoteAsset = rest.quoteAsset ?? (market.chain === "solana" && !market.candleLaunched ? deps.spendAsset().toLowerCase() : undefined)
  const settled = settlementAsset(market, quoteAsset)
  if ("invalid" in settled) return fail(settled.invalid)
  const asset = settled.asset
  if (asset === undefined) return fail("This token trades against an asset the Candle Harness can't price, so a dollar amount can't be converted. Size it in its own pair asset.", "NO_PRICE")
  const point = await deps.pricing.asset(agent, asset)
  if (point === undefined) return fail(`There's no current USD price for ${asset} (none read in the last 10 s), so $${text} can't be converted. Try again, or size it in ${asset}.`, "NO_PRICE")
  const price = point.usd
  const decimals = BASE_ASSETS[asset].decimals
  const raw = BigInt(Math.floor((Number(text) / price) * 10 ** Math.min(decimals, 9))) * 10n ** BigInt(Math.max(decimals - 9, 0))
  if (raw === 0n) return fail(`$${text} is less than the smallest amount of ${asset}.`)
  return {
    ok: true,
    args: { ...rest, amount: fromRaw(raw, decimals), ...(quoteAsset !== undefined && !market.candleLaunched ? { quoteAsset } : {}) },
    fromUsd: { usd: Number(text), asset, assetPriceUsd: price, pricedAt: point.at },
  }
}
