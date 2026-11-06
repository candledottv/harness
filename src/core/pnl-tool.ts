// harness_pnl: the agent answers "how am I doing?" from the same figure the
// status bar shows. The person's P&L window by default, or a `since` the agent passes when the person
// names one ("since Tuesday"). Each agent's change over the window, the sum over the Candle Harness's agents, the
// window and where the Candle Harness's samples start, each figure's source, and, kept apart, the swaps Candle's
// trades read leaves out and paper P&L. Described in the tool only, with no prompt line (no prompt
// lines for what's set up once). Cut to the 16 KB every core tool's answer fits.
import type { PaperPnl, PnlBook } from "./pnl"
import { sinceStart, windowLabel } from "./pnl"

export const PNL_TOOL_NAME = "harness_pnl"
const ANSWER_BUDGET = 16 * 1024
const POSITIONS_LISTED = 10
const SWAPS_LISTED = 10

export const PNL_TOOL = {
  name: PNL_TOOL_NAME,
  description:
    "Your P&L in this Candle Harness, from Candle's book for each agent's key: each agent's change over a window, their sum, realised and unrealised, open positions, and paper P&L kept apart. A question with no window (\"how am I doing today?\") uses the person's P&L window setting: leave since out, and name the window the answer gives in your reply (\"over the last 24 hours\"). When the person names one, pass since. Where the Candle Harness's samples start later than the window, say from when.",
  inputSchema: {
    type: "object" as const,
    properties: {
      since: {
        type: "string",
        description:
          'Only when the person names a window: "24h", "midnight", "session" (since the Candle Harness was last closed), a time of day such as "18:00" (its last occurrence), a span back such as "48h" or "7d", or a date or time, YYYY-MM-DD or YYYY-MM-DDTHH:MM, in this machine\'s time.',
      },
    },
  },
}

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }

const usd = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100) / 100)
const iso = (t: number | null | undefined) => (t === null || t === undefined ? null : new Date(t).toISOString())
const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** The answer to a harness_pnl call. */
export function pnlCall(book: Pick<PnlBook, "figure" | "view">, args: Record<string, unknown>, ctx: { now: () => number; sessionEnd: () => number | undefined; mode: () => string }): Answer {
  const since = args.since
  let override: { start: number | null; label: string; mark?: true } | undefined
  if (since !== undefined) {
    if (typeof since !== "string" || since.length > 40) return { ok: false, code: "MCP_VALIDATION", message: "since is a window, a span or a date, as the tool's description lists." }
    override = sinceStart(since, ctx.now(), ctx.sessionEnd())
    if (!override) return { ok: false, code: "MCP_VALIDATION", message: `since ${JSON.stringify(since)} isn't a window the Candle Harness reads: use "24h", "midnight", "session", a time like "18:00", a span like "7d", or a date, YYYY-MM-DD.` }
  }
  const view = book.view()
  const figure = override ? book.figure(override) : view.figure
  const agents = view.agents.map((a) => {
    const f = figure.agents[a.agent]
    if (!a.book) return { agent: a.agent, read: false, ...(a.failed ? { why: a.failed.words } : { why: "Candle's P&L hasn't been read for this key yet." }) }
    const t = a.book.totals
    return {
      agent: a.agent,
      changeUsd: usd(f?.usd),
      ...(f?.partial ? { partial: "Candle priced a different number of this agent's positions at the window's start and now; the change partly reflects that, not trading." } : {}),
      from: iso(f?.from),
      nowTotalUsd: usd(t.totalUsd),
      realizedNetUsd: usd(t.realizedNetUsd),
      unrealizedUsd: usd(t.unrealizedUsd),
      feesUsd: usd(t.feesUsd),
      readAt: iso(a.readAt),
      ...(a.failed ? { lastReadFailed: a.failed.words } : {}),
      openPositions: a.book.positions.slice(0, POSITIONS_LISTED).map((p) => ({ token: p.symbol ?? p.mint, costUsd: usd(p.costBasisUsd), valueUsd: usd(p.marketValueUsd), unrealizedUsd: usd(p.unrealizedUsd) })),
      ...(a.book.positions.length > POSITIONS_LISTED ? { morePositions: a.book.positions.length - POSITIONS_LISTED } : {}),
      ...(a.book.crossed.length ? { roundsOpenedByAnotherAgent: a.book.crossed.length } : {}),
      ...(a.book.truncated ? { note: "Candle's book looks back only so far, and the oldest trades have dropped out of it." } : {}),
    }
  })
  const windowWords =
    figure.usd === null
      ? `no figure yet over ${figure.label}: the Candle Harness has no sample of Candle's P&L in it`
      : figure.short
        ? `since ${clock(figure.from!)}, where the Candle Harness's samples start (the window asked for, ${figure.label}, reaches back further)`
        : figure.label === "24h"
          ? "the last 24 hours"
          : figure.label
  const paper = Object.entries(view.paper).map(([agent, p]: [string, PaperPnl]) => ({
    agent,
    totalUsd: usd(p.totalUsd),
    realizedUsd: usd(p.realizedUsd),
    unrealizedUsd: usd(p.unrealizedUsd),
    ...(p.unpriced ? { unpricedPositions: p.unpriced } : {}),
  }))
  const body: Record<string, unknown> = {
    success: true,
    window: windowWords,
    ...(override ? {} : { setting: `the person's P&L window, ${windowLabel(view.window)}` }),
    from: iso(figure.from),
    changeUsd: usd(figure.usd),
    ...(figure.unpriced !== undefined ? { partial: `≈: Candle has no price for ${figure.unpriced} position${figure.unpriced === 1 ? "" : "s"} now, and priced a different number at the window's start, so the change is partly that, not trading. Say so with the figure.` } : {}),
    changeIs: "the sum of each agent's own change over the window: the Candle Harness's agents, not every key on the account",
    source: "Candle's P&L for each agent's key; the window's start is the Candle Harness's own sample of it, since Candle's P&L has no window",
    agents,
    ...(view.swaps.length
      ? { swaps: { note: "Filled swaps from the Candle Harness's journal: Candle's book counts them, its trades read doesn't list them. Listed, not added.", rows: view.swaps.slice(0, SWAPS_LISTED).map((s) => ({ at: iso(s.at), agent: s.agent, swap: s.title, valueUsdWhenProposed: usd(s.usd) })) } }
      : {}),
    ...(paper.length ? { paper: { note: "Paper trades at their quoted prices, valued at today's prices: estimates, never added to the live figures.", agents: paper } } : {}),
    mode: ctx.mode(),
  }
  let text = JSON.stringify(body)
  while (text.length > ANSWER_BUDGET && agents.some((a) => Array.isArray((a as { openPositions?: unknown[] }).openPositions) && (a as { openPositions: unknown[] }).openPositions.length > 0)) {
    for (const a of agents as { openPositions?: unknown[]; morePositions?: number }[]) {
      if (a.openPositions?.length) {
        a.openPositions.pop()
        a.morePositions = (a.morePositions ?? 0) + 1
      }
    }
    text = JSON.stringify(body)
  }
  return { ok: true, body }
}
