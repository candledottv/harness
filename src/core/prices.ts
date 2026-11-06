// USD prices for valuing a card when it's proposed. One candle_get_portfolio read per account (its
// `prices` map is account-wide: a Solana mint under its own address, Hood ETH under `hood:native`;
// an unpriced entry is `priceUsd: null`, never zero), refreshed every 15 s in the background while a
// view is attached, and backing off on RATE_LIMITED (a Free key has 30 requests a minute). The key's
// request budget (key-budget.ts) plans prices first among the background reads, and
// stretches the 15 s when even they don't fit. Reading a price never waits on the network, so it never
// holds up an approve.
//
// There's no other fallback: market state carries no price (docs.candle.tv/developers/market-state). A buy is
// valued from the asset it spends, which the portfolio prices; anything unpriced is "no price".
// (The real market read does carry `priceUsd`, as recorded from Candle's server; `LatestPrices` below uses it for
// what the panes show.)
import type { ToolOutcome } from "./candle-mcp"
import { refusalWords } from "./feeds"

export const PRICE_REFRESH_MS = 15_000
const MAX_BACKOFF_MS = 120_000

export class PriceBook {
  private prices = new Map<string, number>()
  private readAt: number | undefined
  private portfolio: unknown
  private timer: ReturnType<typeof setTimeout> | undefined
  private intervalMs: number
  private running = false
  private inFlight: Promise<void> | undefined
  /** The last read's failure in Candle's words, until a read answers (Positions and Wallets say why). */
  private failure: string | undefined

  constructor(
    private readonly deps: {
      /** One portfolio read, through any agent's child: the prices are the account's. */
      read: () => Promise<ToolOutcome>
      now: () => number
      intervalMs?: number
      /** After each good read, for the status bar's exposure; and after a failed one, so the panes can say why. */
      onRead?: () => void
      /** How many times its interval the key's budget has it wait; 1 when it fits. */
      stretch?: () => number
    },
  ) {
    this.intervalMs = deps.intervalMs ?? PRICE_REFRESH_MS
  }

  /** The USD price under a portfolio price key (a mint, or `hood:native`), or undefined. */
  usd(key: string | undefined): number | undefined {
    return key === undefined ? undefined : this.prices.get(key)
  }

  /** A price with when it was read, for the pricing seam's fallback (an asset with no mint to read). */
  point(key: string): { usd: number; at: number } | undefined {
    const usd = this.prices.get(key)
    return usd === undefined || this.readAt === undefined ? undefined : { usd, at: this.readAt }
  }

  /** The last good portfolio read as Candle answered it, for the kill report's "where you stand" (no network call). */
  lastPortfolio(): { result: unknown; readAt: number } | undefined {
    return this.readAt === undefined ? undefined : { result: this.portfolio, readAt: this.readAt }
  }

  /** Why the last read failed, in Candle's words; undefined once one answers. */
  lastFailure(): string | undefined {
    return this.failure
  }

  /** Milliseconds since the last good read, or undefined if there's never been one. */
  ageMs(): number | undefined {
    return this.readAt === undefined ? undefined : this.deps.now() - this.readAt
  }

  /** Reads once now; concurrent callers share the one read. */
  refresh(): Promise<void> {
    this.inFlight ??= this.readOnce().finally(() => (this.inFlight = undefined))
    return this.inFlight
  }

  /** Keeps prices fresh while a view is attached. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.timer)
  }

  /** Reads a minute at its own pace, for the key's budget: none while no view is attached. */
  demandPerMin(): number {
    return this.running ? 60_000 / (this.deps.intervalMs ?? PRICE_REFRESH_MS) : 0
  }

  /** How long until the next read: its interval, doubled after RATE_LIMITED, stretched by the budget. */
  nextReadMs(): number {
    return Math.round(this.intervalMs * Math.max(1, this.deps.stretch?.() ?? 1))
  }

  private async tick(): Promise<void> {
    await this.refresh()
    if (!this.running) return
    this.timer = setTimeout(() => void this.tick(), this.nextReadMs())
    this.timer.unref?.()
  }

  private async readOnce(): Promise<void> {
    const outcome = await this.deps.read()
    // A read the budget held, or with no agent to read with, never reached Candle: nothing to say.
    if (outcome.kind !== "ok" && !(outcome.kind === "error" && ["BUDGET_WAIT", "NO_AGENT"].includes(outcome.code))) {
      const words = refusalWords(outcome)
      if (words !== this.failure) {
        this.failure = words
        this.deps.onRead?.()
      }
    }
    if (outcome.kind === "error" && outcome.code === "RATE_LIMITED") {
      this.intervalMs = Math.min(this.intervalMs * 2, MAX_BACKOFF_MS)
      return
    }
    if (outcome.kind !== "ok") return
    const map = (outcome.result as { prices?: unknown } | undefined)?.prices
    if (typeof map !== "object" || map === null) return
    const next = new Map<string, number>()
    for (const [key, entry] of Object.entries(map as Record<string, unknown>)) {
      const price = (entry as { priceUsd?: unknown } | null)?.priceUsd
      if (typeof price === "number" && Number.isFinite(price) && price > 0) next.set(key, price)
    }
    this.prices = next
    this.portfolio = outcome.result
    this.readAt = this.deps.now()
    this.failure = undefined
    this.intervalMs = this.deps.intervalMs ?? PRICE_REFRESH_MS
    this.deps.onRead?.()
  }
}

/**
 * The newest USD price per token for Positions, exposure and the kill report: the portfolio's price
 * map, or a market read (a card's, the token pane's, a token check's) when that's newer. Otherwise
 * Positions can value a fresh fill about 40% low, and a collapsing token at twice the card's figure,
 * from a portfolio price older than the market read beside it.
 */
export class LatestPrices {
  private readonly market = new Map<string, { usd: number; at: number }>()

  constructor(private readonly book: { usd(key: string | undefined): number | undefined; lastPortfolio(): { readAt: number } | undefined }) {}

  /** Notes the price in a candle_get_market answer, if it carries one. */
  noteMarket(outcome: ToolOutcome, at: number): void {
    if (outcome.kind !== "ok") return
    const market = (outcome.result as { market?: { mint?: unknown; priceUsd?: unknown } } | undefined)?.market
    const usd = market?.priceUsd
    if (typeof market?.mint !== "string" || typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return
    const held = this.market.get(market.mint)
    if (!held || held.at <= at) this.market.set(market.mint, { usd, at })
  }

  usd(key: string | undefined): number | undefined {
    if (key === undefined) return undefined
    const read = this.market.get(key)
    const fromBook = this.book.usd(key)
    const bookAt = this.book.lastPortfolio()?.readAt
    if (read && (fromBook === undefined || bookAt === undefined || read.at > bookAt)) return read.usd
    return fromBook
  }
}
