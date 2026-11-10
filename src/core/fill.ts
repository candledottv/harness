// What a trade filled, read from Candle's answer: the tokens bought or sold, the pair asset spent or received,
// and Candle's fee. Journalled on every trade's `operation.succeeded` and every paper trade's `paper.call`, so a
// rules bot's book (bot-book.ts) is rebuilt from the journal alone and the P&L tab can list fills.
//
// Where Candle puts it (docs.candle.tv/developers/agent-trading, "What the trade actually cost" and "Fee model"):
//   - the embedded wallet (`candle_trade`): `api.amounts` and `api.fee`;
//   - a TEE wallet (`candle swap --json`): `amounts` and `fee` at the top;
//   - a paper trade: `api.amountRaw`, `api.expectedOutRaw`, `api.feeRaw` and the token's `tokenDecimals`;
//   - a trade read back by its id (`candle_get_operation`): `amountRaw` alone, what was sent. A read-back buy
//     says nothing of what it received.
// `actualOutRaw` is read off the confirmed transaction; it's omitted, never zeroed, when nothing could be read,
// and then the quote's `expectedOutRaw` stands in. The fee is in the pair asset: on top of a buy's spend
// (its outflow is `amountRaw + feeRaw`), and withheld from a sell's proceeds.
import { isBaseAsset, quoteAssetOf } from "./assets"

export interface Fill {
  side: "buy" | "sell"
  mint: string
  /** The wallet that paid: "embedded", a TEE wallet's address, or "paper". */
  wallet: string
  /** The pair asset, upper case: SOL, USDC, CNDL. */
  asset: string
  /** Tokens received (a buy) or sold (a sell), raw. Unset when the answer doesn't say: a buy read back by its id. */
  tokensRaw?: string
  /** The pair asset the swap spent (a buy, before the fee) or delivered (a sell, before the fee), raw. */
  assetRaw?: string
  /** Candle's fee, raw, in the pair asset. */
  feeRaw?: string
  /** How the figures were read: off the chain, from the quote (paper, or a fill Candle couldn't read), or not said. */
  measured: "chain" | "quote" | "none"
  /** The token's decimals, where the answer gives them (a paper trade does). */
  tokenDecimals?: number
  /** The pair asset's USD price when it settled, from the prices the core already held: never a read on the trade path. */
  assetUsd?: number
  paper?: true
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const raw = (value: unknown): string | undefined => (typeof value === "string" && /^\d{1,78}$/.test(value) ? value : undefined)

/**
 * A trade's fill from Candle's answer, or undefined where the answer isn't a trade's. `side` and `mint` come
 * from the card, since the TEE route's answer names neither; a read-back's own are used where the card's are missing.
 * `fallbackAsset` is the asset the card settled in, for an answer that names none.
 */
export function readFill(input: { side?: "buy" | "sell"; mint?: string; wallet: string; result: unknown; paper?: boolean; fallbackAsset?: string }): Fill | undefined {
  const top = record(input.result)
  if (!top) return undefined
  // The embedded wallet's and paper's answers sit under `api`; the TEE route's and a read-back's at the top.
  const body = record(top.api) ?? top
  const side = input.side ?? (body.side === "buy" || body.side === "sell" ? body.side : undefined)
  const mint = input.mint ?? (typeof body.mint === "string" ? body.mint : undefined)
  if (!side || !mint) return undefined
  const amounts = record(body.amounts)
  // An answer that names no pair asset is read in the one its card settled in, else the chain's own: ETH for a
  // 0x mint, SOL otherwise. Never SOL for a Hood trade: wei read with SOL's nine decimals is a billion times too much.
  const named = amounts?.quoteAsset ?? body.quoteAsset
  const asset = named !== undefined ? quoteAssetOf(named) : isBaseAsset(input.fallbackAsset) ? input.fallbackAsset : mint.startsWith("0x") ? "ETH" : "SOL"
  if (!asset) return undefined
  const feeRaw = raw(record(body.fee)?.feeRaw ?? body.feeRaw)
  const paper = input.paper === true || body.paper === true
  const decimals = typeof body.tokenDecimals === "number" && Number.isInteger(body.tokenDecimals) && body.tokenDecimals >= 0 ? body.tokenDecimals : undefined
  const base = { side, mint, wallet: paper ? "paper" : input.wallet, asset, ...(feeRaw ? { feeRaw } : {}), ...(decimals !== undefined ? { tokenDecimals: decimals } : {}), ...(paper ? { paper: true as const } : {}) }

  if (amounts) {
    const sent = raw(amounts.amountRaw)
    const actual = raw(amounts.actualOutRaw)
    const out = actual ?? raw(amounts.expectedOutRaw)
    const measured = actual ? "chain" : out ? "quote" : "none"
    if (side === "buy") return { ...base, ...(out ? { tokensRaw: out } : {}), ...(sent ? { assetRaw: sent } : {}), measured }
    return { ...base, ...(sent ? { tokensRaw: sent } : {}), ...(out ? { assetRaw: out } : {}), measured }
  }
  const sent = raw(body.amountRaw)
  const expected = raw(body.expectedOutRaw)
  // A paper fill is Candle's quote; a read-back has only what was sent.
  if (side === "buy") return { ...base, ...(expected ? { tokensRaw: expected } : {}), ...(sent ? { assetRaw: sent } : {}), measured: expected ? "quote" : "none" }
  return { ...base, ...(sent ? { tokensRaw: sent } : {}), ...(expected ? { assetRaw: expected } : {}), measured: expected ? "quote" : "none" }
}

/** What a fill cost (a buy: the spend and the fee) or brought in (a sell: the proceeds less the fee), raw in its pair asset. */
export function netAssetRaw(fill: Fill): bigint | undefined {
  if (fill.assetRaw === undefined) return undefined
  const fee = BigInt(fill.feeRaw ?? "0")
  const amount = BigInt(fill.assetRaw)
  if (fill.side === "buy") return amount + fee
  return amount > fee ? amount - fee : 0n
}

/** A fill on a journal row, if the row carries one that reads. */
export function fillOfRow(row: object): Fill | undefined {
  const f = record((row as { fill?: unknown }).fill)
  if (!f || (f.side !== "buy" && f.side !== "sell") || typeof f.mint !== "string" || typeof f.wallet !== "string" || typeof f.asset !== "string") return undefined
  if (f.measured !== "chain" && f.measured !== "quote" && f.measured !== "none") return undefined
  return f as unknown as Fill
}
