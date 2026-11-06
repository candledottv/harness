// Pricing a card when it's proposed. Two sources, one seam:
//
//   market (now): each price is read fresh from Candle's market read (`market.priceUsd`, recorded
//     from Candle's real server; Candle caches it about 5 s server-side, docs.candle.tv/developers/market-state) at the moment the
//     card is proposed, never on approve. Every price carries when it was read and where from. A price
//     older than 10 s is no price: the card then says it's unvalued, never shows an old figure.
//   quote (when Candle ships it): Candle's quote for the exact trade, `POST /api/v1/trade/agent/
//     quote` (docs.candle.tv/developers/agent-trading, "Pricing before you trade"), through an MCP tool Candle
//     doesn't have yet. It switches on per agent as soon as that agent's MCP server lists the tool named
//     in `pricing.quoteTool`, with no Candle Harness release; `pricing.source = "market"` turns it off. A quote
//     that fails falls back to the market source.
//
// Neither sets the price a trade fills at: Candle fills at its own price when the trade runs, within
// its slippage limit. These figures value the card, check the limits and size a dollar buy.
import { BASE_ASSETS, type BaseAsset } from "./assets"
import type { ToolOutcome } from "./candle-mcp"

/**
 * How old the portfolio's price for an asset with no mint (ETH on Hood) may be: one refresh of the book and
 * some slack. At 10 s against a 15 s refresh it was "no price" a third of the time, so Hood buys and ETH
 * swaps went unpriced. Older than this, the book is read again for the card.
 */
export const MAX_PRICE_AGE_MS = 20_000
/** A read this recent is shared, so a burst of proposals doesn't burst the reads. */
const SHARE_MS = 1_000

export interface PricePoint {
  usd: number
  /** When it was read. */
  at: number
  source: string
}

export interface Quote {
  amountOutRaw: string
  quoteAsset?: string
  quotedAt: number
  payerPermitted?: false
  tokenRisks?: unknown[]
}

export interface PricingConfig {
  source: "auto" | "market"
  /** The MCP tool that carries Candle's quote; `auto` uses it once the server lists it. */
  quoteTool: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

export class Pricing {
  private readonly recent = new Map<string, { at: number; read: Promise<PricePoint | undefined> }>()

  constructor(
    private readonly deps: {
      call: (agent: string, tool: string, args: Record<string, unknown>) => Promise<ToolOutcome>
      /** The tools an agent's MCP server lists. */
      tools: (agent: string) => readonly string[]
      now: () => number
      config: PricingConfig
      /** The portfolio's prices, for assets with no mint to read (ETH on Hood); read again when stale. */
      book: { point(key: string): { usd: number; at: number } | undefined; refresh?: () => Promise<void> }
    },
  ) {}

  sourceFor(agent: string): "market" | "quote" {
    return this.deps.config.source === "auto" && this.deps.tools(agent).includes(this.deps.config.quoteTool) ? "quote" : "market"
  }

  /** A base asset's USD price now. */
  async asset(agent: string, asset: BaseAsset): Promise<PricePoint | undefined> {
    const { chain, priceKey } = BASE_ASSETS[asset]
    if (priceKey === undefined) return undefined
    if (chain === "solana") return this.token(agent, chain, priceKey)
    const fresh = () => {
      const point = this.deps.book.point(priceKey)
      return point && this.deps.now() - point.at <= MAX_PRICE_AGE_MS ? { ...point, source: "portfolio" } : undefined
    }
    // Stale (no view attached, or the refresh slowed by the key's budget): the book is read once now.
    if (fresh() === undefined && this.deps.book.refresh) await this.deps.book.refresh().catch(() => {})
    return fresh()
  }

  /** A token's USD price now, from a fresh market read. */
  token(agent: string, chain: "solana" | "hood", mint: string): Promise<PricePoint | undefined> {
    const now = this.deps.now()
    const key = `${chain}:${mint}`
    const shared = this.recent.get(key)
    if (shared && now - shared.at <= SHARE_MS) return shared.read
    const read = this.deps.call(agent, "candle_get_market", { chain, mint }).then((outcome) => {
      const usd = outcome.kind === "ok" ? positive(record(record(outcome.result)?.market)?.priceUsd) : undefined
      return usd === undefined ? undefined : { usd, at: now, source: "Candle market read" }
    })
    this.recent.set(key, { at: now, read })
    return read
  }

  /** Candle's quote for the exact trade, when the agent's server has the tool; else undefined. */
  async quote(agent: string, trade: { chain: "solana" | "hood"; mint: string; side: "buy" | "sell"; amountRaw: string; quoteAsset?: string }): Promise<Quote | undefined> {
    if (this.sourceFor(agent) !== "quote") return undefined
    const outcome = await this.deps.call(agent, this.deps.config.quoteTool, { ...trade })
    if (outcome.kind !== "ok") return undefined
    const top = record(outcome.result)
    // The REST answer, as the tool relays it: at the top, or under `api` or `data` as other tools do.
    const body = top?.amountOut !== undefined ? top : (record(top?.api) ?? record(top?.data))
    const out = body?.amountOut
    if (typeof out !== "string" || !/^\d+$/.test(out)) return undefined
    return {
      amountOutRaw: out,
      ...(typeof body?.quoteAsset === "string" ? { quoteAsset: body.quoteAsset } : {}),
      quotedAt: typeof body?.quotedAt === "number" ? body.quotedAt : this.deps.now(),
      ...(body?.payerPermitted === false ? { payerPermitted: false as const } : {}),
      ...(Array.isArray(body?.tokenRisks) ? { tokenRisks: body.tokenRisks } : {}),
    }
  }
}
