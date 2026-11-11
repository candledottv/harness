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
import { BASE_ASSETS, type BaseAsset, fromRaw, isBaseAsset, quoteAssetOf } from "./assets"
import { type ChainSlug, chainField, maybeChain, sameAddress, storedChain } from "../shared/chains"

/**
 * A chain's native asset (ETH on Hood, SOL on Solana), as a base asset: SOL with no chain at all, and none for a
 * chain whose native asset isn't one, so its amounts are never read with another asset's decimals.
 */
const nativeAsset = (chain: ChainSlug | undefined) => {
  if (chain === undefined) return "SOL"
  const symbol = maybeChain(chain)?.native.symbol
  return isBaseAsset(symbol) ? symbol : undefined
}

export interface Fill {
  side: "buy" | "sell"
  mint: string
  /** The chain it filled on: the operation's, else Candle's answer's; an old row's by its mint's family. */
  chain?: ChainSlug
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
export function readFill(input: { side?: "buy" | "sell"; mint?: string; chain?: ChainSlug; wallet: string; result: unknown; paper?: boolean; fallbackAsset?: string }): Fill | undefined {
  const top = record(input.result)
  if (!top) return undefined
  // The embedded wallet's and paper's answers sit under `api`; the TEE route's and a read-back's at the top.
  const body = record(top.api) ?? top
  const side = input.side ?? (body.side === "buy" || body.side === "sell" ? body.side : undefined)
  const mint = input.mint ?? (typeof body.mint === "string" ? body.mint : undefined)
  if (!side || !mint) return undefined
  const chain = input.chain ?? storedChain(body.chain, mint)
  const amounts = record(body.amounts)
  // An answer that names no pair asset is read in the one its card settled in, else the chain's own: ETH on
  // Hood, SOL on Solana. Never SOL for a Hood trade: wei read with SOL's nine decimals is a billion times too much.
  const named = amounts?.quoteAsset ?? body.quoteAsset
  const asset = named !== undefined ? quoteAssetOf(named) : isBaseAsset(input.fallbackAsset) ? input.fallbackAsset : nativeAsset(chain)
  if (!asset) return undefined
  const feeRaw = raw(record(body.fee)?.feeRaw ?? body.feeRaw)
  const paper = input.paper === true || body.paper === true
  const decimals = typeof body.tokenDecimals === "number" && Number.isInteger(body.tokenDecimals) && body.tokenDecimals >= 0 ? body.tokenDecimals : undefined
  const base = { side, mint, ...chainField(chain), wallet: paper ? "paper" : input.wallet, asset, ...(feeRaw ? { feeRaw } : {}), ...(decimals !== undefined ? { tokenDecimals: decimals } : {}), ...(paper ? { paper: true as const } : {}) }

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
  // A row from before fills carried a chain gets its mint's family's, as it's read.
  const chain = storedChain(f.chain, f.mint)
  return { ...(f as unknown as Fill), ...chainField(chain) }
}

/** A raw amount in six figures, with its symbol: the exact amount stays in Candle's answer. */
export function sixFigures(raw: bigint, decimals: number, symbol: string): string {
  const exact = fromRaw(raw, decimals)
  const n = Number(exact)
  return `${Number.isFinite(n) && n > 0 && n < 1e15 ? Number(n.toPrecision(6)).toLocaleString("en-US", { maximumSignificantDigits: 6, useGrouping: false }) : exact} ${symbol}`
}

/**
 * What a sell brought in, as its card's done line says it: the proceeds less Candle's fee, in the pair asset, with "≈"
 * when it's the quote, not read off the chain. None for a buy (its card names the tokens) or where the answer doesn't say.
 */
export function receivedOf(fill: Fill): string | undefined {
  if (fill.side !== "sell" || fill.measured === "none" || !isBaseAsset(fill.asset)) return undefined
  const net = netAssetRaw(fill)
  if (net === undefined) return undefined
  return `${fill.measured === "quote" ? "≈" : ""}${sixFigures(net, BASE_ASSETS[fill.asset as BaseAsset].decimals, fill.asset)}`
}

/**
 * What a swap between base assets brought in, from Candle's answer: the amount measured off the transaction, else its
 * quote's (with "≈"), in the asset swapped to. None where the answer says neither.
 */
export function swapReceived(result: unknown, to: unknown): string | undefined {
  if (!isBaseAsset(to)) return undefined
  const payload = record(record(result)?.payload)
  if (!payload) return undefined
  const settled = raw(record(payload.settlement)?.settledOutRaw)
  const expected = raw(payload.expectedOutRaw)
  const decimals = typeof payload.outDecimals === "number" && Number.isInteger(payload.outDecimals) ? payload.outDecimals : BASE_ASSETS[to].decimals
  if (settled) return sixFigures(BigInt(settled), decimals, to)
  return expected ? `≈${sixFigures(BigInt(expected), decimals, to)}` : undefined
}

/** How far back a wallet's own fills stand for what Candle's portfolio hasn't caught up with yet. */
export const OWN_FILLS_MS = 2 * 60_000

/**
 * The least a wallet holds of a token by this core's own live fills: its buys' tokens since its last sell of it, over
 * the last two minutes. Candle's portfolio can read a Hood wallet before a fill a few seconds old, so a sell's card
 * sizes from the larger of that read and this. `wallet` is "embedded" or the TEE wallet's address, as fills record it.
 */
export function ownHeldFloor(rows: readonly object[], o: { wallet: string; mint: string; now: number }): bigint | undefined {
  let held = 0n
  for (const row of rows) {
    const r = row as { type?: unknown; at?: unknown }
    if (r.type !== "operation.succeeded" || typeof r.at !== "string" || o.now - Date.parse(r.at) > OWN_FILLS_MS) continue
    const fill = fillOfRow(row)
    if (!fill || fill.paper || !sameWallet(fill.wallet, o.wallet) || !sameAddress(fill.mint, o.mint)) continue
    // After a sell, what's left isn't the sum: the floor starts again from its next buy.
    if (fill.side === "sell") held = 0n
    else if (fill.tokensRaw !== undefined) held += BigInt(fill.tokensRaw)
  }
  return held > 0n ? held : undefined
}

const sameWallet = (a: string, b: string) => (a === "embedded" || b === "embedded" ? a === b : sameAddress(a, b))
