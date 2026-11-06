// While you were away, for the frames: two gaps, each built from journal rows by the core's
// own awayRecords, so every entry is in the Journal's words.
//
// - "realistic": 3h 12m with the core running headless: a turn that ran on after the close and bought and
//   sold without a card, agent-b's card that waited and expired, a refusal, P&L over the gap, six of the
//   person's signals on Hacc, a trade on agent-a's key outside the Candle Harness, and the wallets then and now.
// - "gone": 9h 40m with the core not running at all: only Candle's and Hacc's side, a fill from the CLI.
import type { AwayCard, AwaySummary, AwayView } from "../src/core/away"
import { awayRecords } from "../src/core/away"
import type { JournalRow } from "../src/core/journal"
import type { SignalRow } from "../src/core/signal-stream"
import { CLOCK, EMBEDDED, MINT, SIGNAL_ROWS } from "./frame-scenes"

const MIN = 60_000
const symbolOf = (mint: string) => (mint === MINT ? "JUPF" : undefined)

function rowsFrom(start: number, ...specs: [number, string, Record<string, unknown>?][]): JournalRow[] {
  return specs
    .map(([min, type, extra]) => ({ at: new Date(start + min * MIN).toISOString(), type, account: "acct_test", mode: "live", ...extra }) as unknown as JournalRow)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((row, i) => ({ ...row, seq: i + 1 }))
}

/** A live trade card's life, as the core journals it. */
function trade(at: number, opId: string, o: { agent?: string; side?: "buy" | "sell"; how?: string; end?: "expired"; usd?: number; headline: string }): [number, string, Record<string, unknown>][] {
  const agent = o.agent ?? "agent-a"
  const cardId = `card_${opId}`
  const side = o.side ?? "buy"
  const rows: [number, string, Record<string, unknown>][] = [
    [at, "card.created", { agent, cardId, opId, kind: "trade", tool: "candle_trade", mint: MINT, side, role: "harness", title: o.headline, headline: o.headline, value: { usd: o.usd ?? 1 }, wallet: "embedded" }],
  ]
  if (o.end === "expired") return [...rows, [at + 1, "card.expired", { agent, cardId, opId }]]
  return [
    ...rows,
    [at + 0.01, "card.approved", { agent, cardId, opId, how: o.how ?? "enter" }],
    [at + 0.02, "operation.submitting", { agent, opId, tool: "candle_trade" }],
    [at + 0.09, "operation.succeeded", { agent, opId, result: { job: { signature: `sig-${opId}` } } }],
  ]
}

const COUNTS = { turns: 0, trades: 0, withoutCard: 0, cards: 0, expired: 0, changes: 0, stopped: 0, outside: 0, maybe: 0, signals: 0, holdings: 0 }

function summary(from: number, to: number, rows: JournalRow[], rest: Partial<AwaySummary>): AwaySummary {
  const r = awayRecords(rows, from, to, symbolOf)
  const s: AwaySummary = {
    id: `${from}-${to}-scene`,
    from,
    to,
    madeAt: to,
    forView: "v1",
    coreDown: r.coreDown,
    coreGoneThroughout: r.coreGoneThroughout,
    turns: r.turns,
    trades: r.trades,
    cards: r.cards,
    changes: r.changes,
    stopped: r.stopped,
    waitingNow: 0,
    pnl: { state: "read", label: "since last session", usd: null, from: null, short: false, agents: {} },
    outside: { state: "read", agents: [] },
    signals: { state: "read", count: 0, newest: [] },
    holdings: { state: "read", changes: [] },
    counts: { ...COUNTS },
    happened: false,
    ...rest,
  }
  const c = s.counts
  Object.assign(c, {
    turns: s.turns.length,
    trades: s.trades.length,
    withoutCard: s.trades.filter((t: AwayCard) => t.withoutCard).length,
    cards: s.cards.length,
    expired: [...s.trades, ...s.cards].filter((t) => t.outcome === "expired").length,
    changes: s.changes.length,
    stopped: s.stopped.length,
    outside: s.outside.agents.reduce((n, a) => n + a.fills.length, 0),
    maybe: s.outside.agents.reduce((n, a) => n + a.maybe.length, 0),
    signals: s.signals.count,
    holdings: s.holdings.changes.length,
  })
  s.happened = Object.values(c).some((n) => n > 0)
  return s
}

const mine = (n: number): SignalRow[] => (SIGNAL_ROWS as unknown as SignalRow[]).slice(0, n)

/** The realistic gap: 3h 12m, ended half a minute before the scene's clock. */
export function realisticAway(): AwayView {
  const to = CLOCK - 30_000
  const from = to - 192 * MIN
  const rows = rowsFrom(
    from,
    [0, "client.detached", { clientId: "v0" }],
    // agent-a's turn, asked just before the close, ran on: it bought and later sold without a card.
    [-1, "agent.turn_started", { agent: "agent-a", turnId: "t9", engine: "claude-code" }],
    ...trade(2, "op-buy", { how: "inside-limits", usd: 1, headline: "BUY $1.00 of JUPF" }),
    ...trade(3.5, "op-sell", { how: "inside-limits", side: "sell", usd: 1.04, headline: "SELL 100% JUPF (≈$1.04)" }),
    [4, "agent.turn", { agent: "agent-a", turnId: "t9", outcome: "done", user: "buy $1 of JUPF, sell it if it's up 3%", reply: "Bought $1.00 of JUPF, then sold it at +4%.", tools: ["candle_trade", "candle_trade"] }],
    // agent-b's card, proposed before the close, waited and expired.
    ...trade(-0.5, "op-late", { agent: "agent-b", usd: 2, headline: "BUY $2.00 of JUPF" }).slice(0, 1),
    [0.5, "card.expired", { agent: "agent-b", cardId: "card_op-late", opId: "op-late" }],
    [61, "card.refused", { agent: "agent-b", tool: "candle_trade", code: "OVER_LIMIT", message: "over agent-b's $2.00 a trade" }],
  )
  return {
    summary: summary(from, to, rows, {
      pnl: { state: "read", label: "since last session", usd: 0.42, from, short: false, agents: { "agent-a": { usd: 0.53, from }, "agent-b": { usd: -0.11, from } } },
      outside: {
        state: "read",
        agents: [
          { agent: "agent-a", state: "read", fills: [{ at: from + 130 * MIN, agent: "agent-a", mint: MINT, symbol: "JUPF", side: "sell", usd: 4.2, wallet: EMBEDDED, signature: "sig-cli" }], maybe: [], claimed: 0 },
          { agent: "agent-b", state: "read", fills: [], maybe: [], claimed: 0 },
        ],
      },
      signals: { state: "read", count: 6, newest: mine(6) },
      holdings: { state: "read", then: from - 2 * MIN, changes: [{ wallet: EMBEDDED, name: "embedded", asset: MINT, symbol: "JUPF", then: 11.6, now: 0 }] },
    }),
  }
}

/** The core gone throughout: 9h 40m overnight, the core started by this attach. Only Candle's and Hacc's side. */
export function goneAway(): AwayView {
  const to = CLOCK - 30_000
  const from = to - 580 * MIN
  const rows = rowsFrom(from, [0, "client.detached", { clientId: "v0" }], [0, "core.stopped", { reason: "idle" }], [580, "core.started", {}])
  return {
    summary: summary(from, to, rows, {
      pnl: { state: "read", label: "since last session", usd: -1.1, from, short: false, agents: { "agent-a": { usd: -1.1, from } } },
      outside: {
        state: "read",
        agents: [
          { agent: "agent-a", state: "read", fills: [], maybe: [], claimed: 0 },
          { agent: "agent-b", state: "read", fills: [{ at: from + 300 * MIN, agent: "agent-b", mint: MINT, symbol: "JUPF", side: "buy", usd: 2, wallet: EMBEDDED, signature: "sig-cli-2" }], maybe: [], claimed: 0 },
        ],
      },
      signals: { state: "read", count: 3, newest: mine(3) },
      holdings: { state: "read", then: from - MIN, changes: [{ wallet: EMBEDDED, name: "embedded", asset: MINT, symbol: "JUPF", then: 0, now: 4.71 }] },
    }),
  }
}
