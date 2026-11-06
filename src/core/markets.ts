// Mint resolution for cards: a trade is only ever proposed on a mint Candle knows, read through
// candle_resolve_token (GET /api/v1/markets/:chain/:mint, docs.candle.tv/developers/market-state). The answer is
// kept for the session; one that can't trade now isn't, so a later card checks again.
import { terminalText } from "../shared/terminal-text"
import type { ToolOutcome } from "./candle-mcp"

export interface MarketInfo {
  chain: "solana" | "hood"
  mint: string
  symbol?: string
  candleLaunched: boolean
  quoteMint?: string
  decimals?: number
  quoteDecimals?: number
}

/** How long a market read's USD price is used before it's read again. */
export const MARKET_PRICE_MS = 15_000

export type Resolved = { ok: true; market: MarketInfo } | { ok: false; code: string; message: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export class Markets {
  private readonly known = new Map<string, MarketInfo>()
  private readonly prices = new Map<string, { usd: number; at: number }>()

  constructor(
    private readonly deps: {
      pool: { for(agent: string): { call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> } }
      now?: () => number
      /** A symbol Candle's token check gave: kept across restarts. */
      learned?: (mint: string, symbol: string) => void
    },
  ) {}

  /**
   * The token's USD price from Candle's market read (`market.priceUsd`), at most 15 s old, for a card
   * on a token the portfolio doesn't price (it prices only what the wallet holds). The field is in
   * the real server's answer (as recorded) but not listed in docs.candle.tv/developers/market-state, so
   * a card says when its price came from here. Read when a card is proposed, never on approve.
   */
  async priceUsd(agent: string, mint: string): Promise<number | undefined> {
    const now = (this.deps.now ?? Date.now)()
    const held = this.prices.get(mint)
    if (held && now - held.at < MARKET_PRICE_MS) return held.usd
    const info = this.known.get(mint)
    if (!info) return undefined
    const outcome = await this.deps.pool.for(agent).call("candle_get_market", { chain: info.chain, mint })
    const price = outcome.kind === "ok" ? usablePrice(record(record(outcome.result)?.market)?.priceUsd) : undefined
    if (price === undefined) return undefined
    this.prices.set(mint, { usd: price, at: now })
    return price
  }

  get(mint: string): MarketInfo | undefined {
    return this.known.get(mint)
  }

  async resolve(agent: string, mint: string): Promise<Resolved> {
    const cached = this.known.get(mint)
    if (cached) return { ok: true, market: cached }
    const outcome = await this.deps.pool.for(agent).call("candle_resolve_token", { mint })
    if (outcome.kind === "lost") return { ok: false, code: "TOKEN_CHECK_FAILED", message: "Couldn't check this token with Candle; try again." }
    if (outcome.kind === "error") {
      if (outcome.code === "MARKET_NOT_FOUND") return { ok: false, code: "TOKEN_UNKNOWN", message: "Candle doesn't know this token." }
      // QUOTE_UNAVAILABLE is a dependency failure (503, retryable): never "unknown" (docs.candle.tv/developers/agent-trading).
      return { ok: false, code: "TOKEN_CHECK_FAILED", message: `Couldn't check this token with Candle (${outcome.code}); try again.` }
    }
    const market = record(record(outcome.result)?.market)
    if (!market || market.mint !== mint || (market.chain !== "solana" && market.chain !== "hood")) {
      return { ok: false, code: "TOKEN_CHECK_FAILED", message: "Candle's answer about this token couldn't be read; try again." }
    }
    // `trade.routable` is stored eligibility, not a quote (docs.candle.tv/developers/market-state).
    if (record(market.trade)?.routable === false) {
      return { ok: false, code: "TOKEN_NOT_TRADABLE", message: "This token isn't tradable on Candle right now." }
    }
    const symbol = record(market.metadata)?.symbol
    const info: MarketInfo = {
      chain: market.chain,
      mint,
      ...(typeof symbol === "string" && symbol.length > 0 ? { symbol: terminalText(symbol, { maxLength: 16 }) } : {}),
      candleLaunched: market.candleLaunched === true,
      ...(typeof market.quoteMint === "string" ? { quoteMint: market.quoteMint } : {}),
      ...(typeof market.decimals === "number" ? { decimals: market.decimals } : {}),
      ...(typeof market.quoteDecimals === "number" ? { quoteDecimals: market.quoteDecimals } : {}),
    }
    this.known.set(mint, info)
    if (info.symbol) this.deps.learned?.(mint, info.symbol)
    const price = usablePrice(market.priceUsd)
    if (price !== undefined) this.prices.set(mint, { usd: price, at: (this.deps.now ?? Date.now)() })
    return { ok: true, market: info }
  }
}

const usablePrice = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)
