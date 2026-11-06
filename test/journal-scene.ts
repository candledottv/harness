// The Journal's scene: two days of a trader's journal as the core writes its rows (card
// lives, turns, paper, the kill switch, Hacc, memory, picks, the core's own), answered by the core's own
// query, so the frames show exactly the words the core sends.
import type { JournalRow } from "../src/core/journal"
import { type JournalPage, queryJournal } from "../src/core/journal-query"
import { Redactor } from "../src/shared/redact"

const pad = (s: string) => s.padEnd(43, "1")
const MINT = pad("JupFake")
const MOON = pad("MoonFake")
const symbolOf = (m: string) => (m === MINT ? "JUPF" : m === MOON ? "MOON" : undefined)

/** The rows, oldest first: a block of a trader's hour, repeated back over two days. */
export function journalSceneRows(clock: number): JournalRow[] {
  const rows: JournalRow[] = []
  let seq = 0
  const add = (at: number, type: string, fields: Record<string, unknown> = {}) => rows.push({ seq: ++seq, at: new Date(at).toISOString(), type, account: "acct_scene", mode: "live", ...fields } as JournalRow)
  const life = (at: number, n: string, o: { agent?: string; mint?: string; headline: string; side?: string; route?: string; walletLabel?: string; end: "filled" | "failed" | "rejected" | "withdrawn" | "unknown"; how?: string; fill?: number; mode?: "paper" | "live" }) => {
    const agent = o.agent ?? "agent-a"
    const mode = o.mode ?? "live"
    add(at, "card.created", { mode, agent, cardId: `c_${n}`, opId: `o_${n}`, role: "harness", kind: "trade", tool: "candle_trade", params: { mint: o.mint ?? MINT, side: o.side ?? "buy" }, mint: o.mint ?? MINT, side: o.side ?? "buy", wallet: "EmbFake111", ...(o.route ? { route: o.route, walletLabel: o.walletLabel } : {}), headline: o.headline, title: o.headline })
    if (o.end === "rejected") return add(at + 9_000, "card.rejected", { mode, agent, cardId: `c_${n}`, opId: `o_${n}` })
    if (o.end === "withdrawn") return add(at + 20_001, "card.withdrawn", { mode, agent, cardId: `c_${n}`, opId: `o_${n}`, reason: "kill_switch" })
    add(at + 1_400, "card.approved", { mode, agent, cardId: `c_${n}`, opId: `o_${n}`, how: o.how ?? "enter" })
    add(at + 1_402, "operation.submitting", { mode, agent, opId: `o_${n}`, cardId: `c_${n}`, kind: "trade", tool: "candle_trade" })
    const done = at + 1_400 + (o.fill ?? 4_300)
    if (o.end === "filled") add(done, "operation.succeeded", { mode, agent, opId: `o_${n}` })
    else if (o.end === "failed") add(done, "operation.failed", { mode, agent, opId: `o_${n}`, error: { code: "SLIPPAGE", message: "The price moved past your slippage; nothing was signed or sent." } })
    else add(done, "operation.unknown", { mode, agent, opId: `o_${n}` })
  }
  for (let h = 30; h >= 0; h -= 3) {
    const t = clock - h * 3_600_000 - 50 * 60_000
    const n = String(h)
    add(t, "core.started", { coreVersion: "0.0.0", agents: ["agent-a", "agent-b"] })
    add(t + 2_000, "client.attached", { clientId: `v${n}`, role: "view", clientName: "view" })
    add(t + 60_000, "agent.turn_started", { agent: "agent-a", turnId: `t_${n}`, engine: "claude-code" })
    add(t + 68_200, "agent.turn", { agent: "agent-a", turnId: `t_${n}`, user: "how's JUPF looking? anything worth a small buy?", reply: "Steady on the hour; three wallets bought.", tools: ["candle_get_token", "hacc_token"], outcome: "done" })
    life(t + 70_000, `${n}a`, { headline: "BUY 0.1 SOL (≈$15.00) → JUPF", end: "filled" })
    add(t + 90_000, "view.picked", { mint: MOON, symbol: "MOON", from: "feed, by a click" })
    add(t + 95_000, "paper.call", { mode: "paper", agent: "agent-b", tool: "candle_trade", role: "harness", args: { mint: MOON, side: "buy", amount: "0.05" }, answer: JSON.stringify({ api: { tokenAmount: 1240, amountRaw: "50000000", quoteAsset: "SOL" } }) })
    life(t + 120_000, `${n}b`, { headline: "SELL 50% JUPF (≈$7.40)", side: "sell", route: "cli", walletLabel: "tee-one", end: h % 2 ? "failed" : "filled", how: "click", fill: 8_100 })
    add(t + 150_000, "tool.refused", { agent: "agent-b", role: "harness", tool: "candle_trade", code: "OVER_TRADE_LIMIT", message: "Over agent-b's per-trade limit of $10: this is $40.00." })
    life(t + 200_000, `${n}c`, { agent: "agent-b", mint: MOON, headline: "BUY 0.2 SOL (≈$30.00) → MOON", end: "rejected" })
    life(t + 230_000, `${n}d`, { headline: "BUY 0.05 SOL (≈$7.50) → JUPF", end: "withdrawn" })
    add(t + 250_000, "kill.on", {})
    add(t + 300_000, "kill.off", {})
    add(t + 320_000, "hacc.change", { agent: "agent-a", by: "agent", changeId: `chg_${n}`, words: "followed a wallet, Smart Money 3" })
    add(t + 330_000, "engine.chosen", { agent: "agent-a", engine: "codex", model: "gpt-5.5" })
    add(t + 340_000, "cli.typed", { argv: ["keys", "list"] })
    if (h === 0) life(t + 400_000, `${n}e`, { headline: "BUY 0.1 SOL (≈$15.00) → JUPF", end: "unknown" })
  }
  return rows
}

/** The core's answer to `journal.query` over the scene's rows. */
export function journalScenePage(clock: number, params: Record<string, unknown>, empty = false): Promise<JournalPage> {
  const rows = empty ? [] : journalSceneRows(clock)
  return queryJournal(params, { memory: () => rows, tail: { seq: 1, offset: 0 }, path: "/nonexistent/journal.jsonl", redactor: new Redactor(), symbolOf })
}
