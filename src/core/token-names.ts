// The token names the core can read a line by: a symbol to the mints the core has read it for, from what
// it publishes to its views (cards, the portfolio, the token pane's market, Candle's lists). A trigger's line
// is read here with no view, so its names can't come from a view's store.
//
// The view's rule holds: a name nobody has shown is refused, never guessed. The core is stricter than the
// view where a name is several tokens: a copy of a ticker is common, so a symbol read for two mints
// is refused naming both, rather than taking the newest as the view does. A trigger may fire hours after
// it was saved, with nobody there to notice the wrong token.
//
// Hacc's tape names no tokens (its rows carry an address and no symbol), so it adds nothing here. These
// are this session's names, as the view's are; state/symbols.json (symbols.ts) is the other way round,
// each mint's symbol for display, kept across restarts.
//
// The base assets' names (SOL, USDC, ETH, USDG, CNDL) are reserved: they're learned only for their real mints, so a
// token that calls itself "USDC" is never what a typed USDC reads as. Anyone can launch one with that symbol.
import { addressKey } from "../shared/address-key"
import { baseAssetForMint, isBaseAsset } from "./assets"

/** At most this many symbol and mint pairs are kept; past it, the one seen longest ago goes. */
export const MAX_PAIRS = 10_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export class TokenNames {
  /** Upper-cased symbol to its mints, each with when it was last seen (a sequence, not a clock). */
  private readonly bySymbol = new Map<string, Map<string, number>>()
  private seq = 0
  private pairs = 0

  constructor(private readonly maxPairs = MAX_PAIRS) {}

  /** A symbol read for a mint. */
  learn(symbol: string | undefined, mint: string | undefined): void {
    const s = str(symbol)?.replace(/^\$/, "").toUpperCase()
    const m = str(mint)
    if (!s || !m) return
    // A base asset's name is only ever its real mint's (assets.ts): a look-alike is never learned under it.
    if (isBaseAsset(s) && baseAssetForMint(m) !== s) return
    let mints = this.bySymbol.get(s)
    if (!mints) this.bySymbol.set(s, (mints = new Map()))
    // An EVM address is one token whatever its case: the spelling first read for it is kept.
    const held = [...mints.keys()].find((x) => addressKey(x) === addressKey(m)) ?? m
    if (!mints.has(held)) this.pairs += 1
    mints.set(held, ++this.seq)
    if (this.pairs > this.maxPairs) this.dropOldest()
  }

  /** What a published topic names, read as the view's store reads it, plus Candle's lists. */
  learnFrom(topic: string, data: unknown): void {
    if (!isRecord(data)) return
    if (topic === "cards") {
      const display = isRecord(data.display) ? data.display : {}
      this.learn(str(display.mintLabel), str(display.mint))
    } else if (topic === "portfolio") {
      for (const w of list(data.wallets)) for (const t of list(isRecord(w) ? w.tokens : undefined)) if (isRecord(t)) this.learn(str(t.symbol), str(t.mint))
      const paper = isRecord(data.paper) ? data.paper : {}
      for (const book of Object.values(paper)) for (const p of list(book)) if (isRecord(p)) this.learn(str(p.symbol), str(p.mint))
    } else if (topic === "market") {
      if (isRecord(data.followed)) this.learn(str(data.followed.symbol), str(data.followed.mint))
      for (const row of list(isRecord(data.trending) ? data.trending.rows : undefined)) if (isRecord(row)) this.learn(str(row.symbol), str(row.mint))
      for (const p of list(data.pinned)) if (isRecord(p)) this.learn(str(p.symbol), str(p.mint))
    } else if (topic === "feeds") {
      for (const feed of Object.values(data)) for (const row of list(isRecord(feed) ? feed.rows : undefined)) if (isRecord(row)) this.learn(str(row.symbol), str(row.mint))
    }
  }

  /** Each name read for exactly one mint: the map a line's names resolve by. */
  known(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [symbol, mints] of this.bySymbol) if (mints.size === 1) out.set(symbol, mints.keys().next().value!)
    return out
  }

  /** Every mint a name has been read for, newest first: a card for one of them says there's another. */
  mintsOf(symbol: string | undefined): string[] {
    const mints = this.bySymbol.get(str(symbol)?.replace(/^\$/, "").toUpperCase() ?? "")
    return mints ? [...mints].sort((x, y) => y[1] - x[1]).map(([mint]) => mint) : []
  }

  /** Each name read for several mints, newest first: refused, naming them. */
  several(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const [symbol, mints] of this.bySymbol) {
      if (mints.size > 1) out.set(symbol, [...mints].sort((a, b) => b[1] - a[1]).map(([mint]) => mint))
    }
    return out
  }

  private dropOldest(): void {
    let oldest: { symbol: string; mint: string; at: number } | undefined
    for (const [symbol, mints] of this.bySymbol) {
      for (const [mint, at] of mints) if (!oldest || at < oldest.at) oldest = { symbol, mint, at }
    }
    if (!oldest) return
    const mints = this.bySymbol.get(oldest.symbol)!
    mints.delete(oldest.mint)
    if (mints.size === 0) this.bySymbol.delete(oldest.symbol)
    this.pairs -= 1
  }
}
