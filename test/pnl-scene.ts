// The P&L tab's data for tests and frames: what the core's `pnl` topic and `pnl.series`
// send, built from the recorded books (agent-a's and agent-b's, sharing the embedded wallet), with their
// times moved to `now`. Variants: a whole tab, a short window (the samples start late), a failed read,
// paper beside live, and a fresh install with nothing read.
import pnlA from "./fixtures/candle-recorded/feeds-pnl/pnl-agent-a.json"
import pnlB from "./fixtures/candle-recorded/feeds-pnl/pnl-agent-b.json"
import tradesA from "./fixtures/candle-recorded/feeds-pnl/trades-agent-a.json"
import tradesB from "./fixtures/candle-recorded/feeds-pnl/trades-agent-b.json"
import { bookFrom, type PnlBookView, type PnlView, sumTotals, tradesFrom, walletsAcross, windowStart } from "../src/core/pnl"

export type PnlVariant = "full" | "short" | "failed" | "paper" | "fresh"

/** When the books were read, about: their newest mark. */
const RECORDED_AT = 1_791_880_000_000

const SYMBOLS: Record<string, string> = {
  TokenFake30zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz: "MOTH",
  "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL": "CNDL",
  TokenFake29zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz: "LUMEN",
  TokenFake28zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz: "QUILL",
}
const symbolOf = (mint: string) => SYMBOLS[mint]
const agentOf = (prefix: string) => ({ FakeKey1: "agent-a", FakeKey2: "agent-b" })[prefix]

/** A book's times moved by `by`. */
function moved(book: PnlBookView, by: number): PnlBookView {
  const at = (t: number | null) => (t === null ? null : t + by)
  return {
    ...book,
    positions: book.positions.map((p) => ({ ...p, markedAt: at(p.markedAt), openedTs: at(p.openedTs) })),
    crossed: book.crossed.map((c) => ({ ...c, closedTs: at(c.closedTs) })),
    oldestMarkAt: at(book.oldestMarkAt),
  }
}

export function pnlScene(now: number, variant: PnlVariant = "full"): PnlView {
  const by = now - RECORDED_AT
  const a = moved(bookFrom((pnlA as { answer: unknown }).answer, "FakeKey1", agentOf, symbolOf)!, by)
  const b = moved(bookFrom((pnlB as { answer: unknown }).answer, "FakeKey2", agentOf, symbolOf)!, by)
  const trades = [...tradesFrom((tradesA as { answer: unknown }).answer, "agent-a", symbolOf)!, ...tradesFrom((tradesB as { answer: unknown }).answer, "agent-b", symbolOf)!]
    .map((t) => ({ ...t, at: t.at + by }))
    .sort((x, y) => y.at - x.at)
    .slice(0, 12)
  if (variant === "fresh") {
    return {
      window: "24h",
      figure: { window: "24h", label: "24h", start: now - 86_400_000, usd: null, from: null, short: false, agents: {} },
      agents: [
        { agent: "agent-a", prefix: "FakeKey1", readAt: null, book: null },
        { agent: "agent-b", prefix: "FakeKey2", readAt: null, book: null },
      ],
      sum: null,
      wallets: [],
      trades: [],
      swaps: [],
      paper: {},
      samplesFrom: null,
    }
  }
  const failed = variant === "failed"
  const books = failed ? [{ agent: "agent-a", book: a }] : [{ agent: "agent-a", book: a }, { agent: "agent-b", book: b }]
  const short = variant === "short"
  const from = short ? now - 3 * 3_600_000 - 14 * 60_000 : now - 86_400_000 + 60_000
  // A failed trade, as Candle answers one, for the Trades pane's words.
  const failedTrade = { agent: "agent-a", at: now - 7 * 60_000, mint: "TokenFake30zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", symbol: "MOTH", side: "buy", status: "failed", usd: null, feeUsd: null, error: "Slippage tolerance exceeded: the price moved 4.1% before it landed" }
  return {
    window: short ? "midnight" : "24h",
    figure: {
      window: short ? "midnight" : "24h",
      label: short ? "since midnight" : "24h",
      start: short ? windowStart("midnight", now, undefined) : now - 86_400_000,
      usd: failed ? -0.12 : 0.31,
      from,
      short,
      agents: { "agent-a": { usd: -0.12, from }, ...(failed ? { "agent-b": { usd: null, from: null } } : { "agent-b": { usd: 0.43, from: from + 120_000 } }) },
    },
    agents: [
      { agent: "agent-a", prefix: "FakeKey1", readAt: now - 40_000, book: a },
      failed
        ? { agent: "agent-b", prefix: "FakeKey2", readAt: null, book: null, failed: { at: now - 30_000, words: "Rate limited: try again in 20 seconds" } }
        : { agent: "agent-b", prefix: "FakeKey2", readAt: now - 35_000, book: b },
    ],
    sum: sumTotals(books.map((x) => x.book)),
    wallets: walletsAcross(books),
    trades: [failedTrade, ...trades],
    swaps: [{ at: now - 25 * 60_000, agent: "agent-a", opId: "op-swap-1", title: "SWAP 0.05 SOL → USDC", usd: 7.5, wallet: "embedded" }],
    paper:
      variant === "paper"
        ? {
            "agent-a": {
              realizedUsd: 0.42,
              unrealizedUsd: -0.18,
              totalUsd: 0.24,
              positions: [{ mint: "TokenFake29zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", symbol: "LUMEN", tokens: 1200, costUsd: 2.4, valueUsd: 2.22, unrealizedUsd: -0.18 }],
              unpriced: 0,
            },
          }
        : {},
    samplesFrom: from,
  }
}

/**
 * The chart's points over a span, as `pnl.series` sends them: `n` buckets from `from` to `now`, the Candle Harness's
 * agents' summed total moving by `change` to end at `end` (the books' total, so the chart agrees with the
 * window's figure), with a gap (null) where the core wasn't running.
 */
export function pnlSeriesScene(now: number, from: number, n = 480, opts: { end?: number; change?: number; gap?: boolean } = {}): { at: number; usd: number | null }[] {
  const end = opts.end ?? -9.86
  const begin = end - (opts.change ?? 0.31)
  const step = Math.max(60_000, Math.ceil((now - from) / n))
  const count = Math.max(1, Math.ceil((now - from) / step))
  const out: { at: number; usd: number | null }[] = []
  for (let i = 1; i <= count; i++) {
    const at = Math.min(now, from + i * step)
    const f = count === 1 ? 1 : (i - 1) / (count - 1)
    const off = (opts.gap ?? true) && f > 0.42 && f < 0.5
    out.push({ at, usd: off ? null : begin + (end - begin) * f + Math.sin(i / 17) * 0.18 * Math.sin(Math.PI * f) })
  }
  return out
}
