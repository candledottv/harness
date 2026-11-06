// harness_history: the asking agent's own past turns, cards and paper trades, with filters
// by date, token and words, newest first within the 16 KB budget, and never another agent's rows.
import { describe, expect, test } from "bun:test"
import { replayNote } from "./hacc-changes"
import { historyCall, historyItems } from "./history-tool"
import type { JournalRow } from "./journal"

const MINT = "So11111111111111111111111111111111111111112"
let seq = 0
const row = (at: string, type: string, extra: Record<string, unknown>): JournalRow => ({ seq: ++seq, at, type, mode: "live", ...extra }) as unknown as JournalRow

const rows: JournalRow[] = [
  row("2026-10-20T10:00:00.000Z", "agent.turn", { agent: "momentum", turnId: "t1", user: "what's moving?", reply: "Three tokens on the tape.", tools: ["hacc_signals {} → ok"], outcome: "done", engine: "claude-code" }),
  row("2026-10-20T10:01:00.000Z", "card.created", { agent: "momentum", cardId: "c1", opId: "o1", role: "harness", tool: "candle_trade", title: "Buy 0.1 SOL of MOON", mint: MINT, side: "buy", wallet: "embedded" }),
  row("2026-10-20T10:01:05.000Z", "card.approved", { agent: "momentum", cardId: "c1", opId: "o1" }),
  row("2026-10-20T10:01:09.000Z", "operation.succeeded", { agent: "momentum", opId: "o1" }),
  row("2026-10-21T09:00:00.000Z", "paper.call", { agent: "momentum", mode: "paper", role: "view", tool: "candle_trade", args: { mint: MINT, side: "sell", percent: 50 }, isError: false, answer: '{"ok":true}' }),
  row("2026-10-21T09:05:00.000Z", "card.created", { agent: "momentum", cardId: "c2", opId: "o2", role: "harness", tool: "candle_swap", title: "Swap 5 USDC for SOL" }),
  row("2026-10-21T09:06:00.000Z", "card.rejected", { agent: "momentum", cardId: "c2", opId: "o2" }),
  row("2026-10-21T11:00:00.000Z", "agent.turn", { agent: "swing", turnId: "t2", user: "swing's private question", reply: "swing's answer", tools: [], outcome: "done" }),
  row("2026-10-22T12:00:00.000Z", "agent.turn", { agent: "momentum", turnId: "t3", user: "sell half of MOON", reply: "I've proposed the sell.", tools: [], outcome: "cancelled" }),
]

const call = (args: Record<string, unknown>, agent = "momentum") => {
  const r = historyCall(rows, agent, args)
  if (!r.ok) throw new Error(r.message)
  return r.body as { items: Record<string, unknown>[]; leftOut?: number; more?: string; found?: string }
}

describe("harness_history", () => {
  test("the agent's own turns, cards with how they ended, and paper trades, newest first", () => {
    const items = call({}).items
    expect(items.map((i) => i.kind)).toEqual(["turn", "card", "paper", "card", "turn"])
    expect(items[0]).toMatchObject({ person: "sell half of MOON", you: "I've proposed the sell.", ended: "cancelled" })
    expect(items[1]).toMatchObject({ title: "Swap 5 USDC for SOL", state: "rejected", by: "you" })
    expect(items[2]).toMatchObject({ kind: "paper", by: "the person, typed", side: "sell", percent: 50, state: "filled on paper" })
    expect(items[3]).toMatchObject({ title: "Buy 0.1 SOL of MOON", mint: MINT, state: "succeeded" })
    expect(items[4]).toMatchObject({ tools: ["hacc_signals {} → ok"], engine: "claude-code" })
  })

  test("never another agent's rows", () => {
    expect(JSON.stringify(call({}))).not.toContain("swing")
    const swing = call({}, "swing")
    expect(swing.items).toHaveLength(1)
    expect(JSON.stringify(swing)).not.toContain("MOON")
  })

  test("by date, a day or a range; by token, mint or symbol; by words; and further back with before", () => {
    const day = (iso: string) => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    }
    expect(call({ date: day("2026-10-20T10:00:00.000Z") }).items.map((i) => i.kind)).toEqual(["card", "turn"])
    expect(call({ date: `${day("2026-10-20T10:00:00.000Z")}..${day("2026-10-21T09:06:00.000Z")}` }).items).toHaveLength(4)
    expect(call({ token: "moon" }).items.map((i) => i.kind)).toEqual(["turn", "card"])
    expect(call({ token: MINT }).items.map((i) => i.kind)).toEqual(["paper", "card"])
    expect(call({ text: "TAPE three" }).items).toHaveLength(1)
    expect(call({ text: "nothing like this" })).toMatchObject({ items: [], found: "Nothing matched." })
    const newest = call({ limit: 2 })
    expect(newest.items).toHaveLength(2)
    const older = call({ before: newest.items[1]!.seq as number })
    expect(older.items.map((i) => i.kind)).toEqual(["paper", "card", "turn"])
    for (const date of ["yesterday", "2026-10", "2026-10-20..soon", 5]) expect(historyCall(rows, "momentum", { date })).toMatchObject({ ok: false, code: "INVALID_ARGS" })
    expect(historyCall(rows, "momentum", { token: "  " })).toMatchObject({ ok: false, code: "INVALID_ARGS" })
  })

  test("cut to the 16 KB budget, newest kept, saying what was left out and how to read on", () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`2026-10-23T10:${String(i).padStart(2, "0")}:00.000Z`, "agent.turn", { agent: "momentum", turnId: `m${i}`, user: "q".repeat(600), reply: "r".repeat(1500), tools: [], outcome: "done" }))
    const r = historyCall(many, "momentum", { limit: 100 })
    expect(r.ok).toBe(true)
    const body = (r as unknown as { body: { items: { seq: number }[]; leftOut: number; more: string } }).body
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(16 * 1024)
    expect(body.items[0]!.seq).toBe(many.at(-1)!.seq)
    expect(body.leftOut).toBe(60 - body.items.length)
    expect(body.more).toContain(`pass before ${body.items.at(-1)!.seq}`)
    // Long words are clipped, not dropped.
    expect(historyItems(many, "momentum")[0]!.you).toHaveLength(1500)
  })
})

// Since the last session: "what happened while I was away?" from the main view's last
// close, the kill switch in every agent's history, and a trade that ran without a card said so.
describe("harness_history since the last session", () => {
  const closed = Date.parse("2026-10-30T22:00:00.000Z")
  const now = Date.parse("2026-10-31T08:00:00.000Z")
  const away: JournalRow[] = [
    row("2026-10-30T21:00:00.000Z", "agent.turn", { agent: "momentum", turnId: "a1", user: "watch MOON overnight", reply: "Watching.", tools: [], outcome: "done" }),
    row("2026-10-30T23:00:00.000Z", "card.created", { agent: "momentum", cardId: "n1", opId: "p1", role: "harness", tool: "candle_trade", title: "Buy $1.00 of MOON", mint: MINT, side: "buy", wallet: "embedded" }),
    row("2026-10-30T23:00:00.100Z", "card.approved", { agent: "momentum", cardId: "n1", opId: "p1", how: "inside-limits" }),
    row("2026-10-30T23:00:04.000Z", "operation.succeeded", { agent: "momentum", opId: "p1" }),
    row("2026-10-31T01:00:00.000Z", "card.created", { agent: "momentum", cardId: "n2", opId: "p2", role: "harness", tool: "candle_trade", title: "Buy $3.00 of MOON", mint: MINT, side: "buy" }),
    row("2026-10-31T01:05:00.000Z", "card.expired", { agent: "momentum", cardId: "n2", opId: "p2" }),
    row("2026-10-31T02:00:00.000Z", "kill.on", { by: "view" }),
    row("2026-10-31T02:00:01.000Z", "card.created", { agent: "swing", cardId: "n3", opId: "p3", role: "harness", tool: "candle_trade", title: "swing's buy" }),
  ]
  const ctx = (end: number | undefined) => ({ now: () => now, sessionEnd: () => end })
  const read = (args: Record<string, unknown>, end: { at?: number } = { at: closed }) => {
    const r = historyCall(away, "momentum", args, ctx(end.at))
    if (!r.ok) throw new Error(r.message)
    return r.body as { items: Record<string, unknown>[]; since?: string }
  }

  test('"last session" reads from the main view\'s last close, and says from when', () => {
    for (const since of ["last session", "session", "Last Session"]) {
      const body = read({ since })
      expect(body.items.map((i) => i.kind)).toEqual(["kill", "card", "card"])
      expect(body.since).toBe("Since the person last closed the Candle Harness, at 2026-10-30T22:00:00.000Z (10h 0m ago).")
    }
    expect(JSON.stringify(read({ since: "last session" }))).not.toContain("swing")
  })

  test("a trade that ran without a card says so; one that went to a card says how it ended", () => {
    const [kill, expired, ran] = read({ since: "last session" }).items
    expect(kill).toMatchObject({ kind: "kill", what: "the kill switch went on: buys and swaps stopped" })
    expect(expired).toMatchObject({ title: "Buy $3.00 of MOON", state: "expired" })
    expect(expired!.ran).toBeUndefined()
    expect(ran).toMatchObject({ title: "Buy $1.00 of MOON", state: "succeeded", ran: "without a card, inside its wallet's limits" })
  })

  test("no close known: everything, said so; the pnl window's other forms work too; a wrong one is refused", () => {
    const all = read({ since: "last session" }, {})
    expect(all.items).toHaveLength(4)
    expect(all.since).toContain("hasn't been closed and opened again")
    expect(read({ since: "7h" }).items.map((i) => i.kind)).toEqual(["kill", "card"])
    for (const since of ["yesterday", 5, "x".repeat(41)]) expect(historyCall(away, "momentum", { since }, ctx(closed))).toMatchObject({ ok: false, code: "INVALID_ARGS" })
  })
})

describe("replays in harness_history and the next turn's note", () => {
  const definition = { chain: "solana", entry: { source: "pattern", pattern: "kol_mention" }, exit: { stop_loss_pct: 20 } }
  const replayRows: JournalRow[] = [
    row("2026-11-03T13:00:00.000Z", "agent.turn", { agent: "momentum", turnId: "t9", user: "backtest it", reply: "Started replays 211 and 212.", tools: [], outcome: "done" }),
    row("2026-11-03T12:59:00.000Z", "hacc.change", { agent: "momentum", by: "agent", tool: "hacc_lab", view: "run_replay", changeId: "x1", words: "started a replay (job 211)", jobId: 211, definition, from: "2026-10-20", to: "2026-11-03" }),
    row("2026-11-03T13:44:00.000Z", "hacc.replay", { agent: "momentum", jobId: 211, status: "failed", error: "hard timeout after 600s" }),
    row("2026-11-03T13:45:00.000Z", "hacc.change", { agent: "momentum", by: "agent", tool: "hacc_lab", view: "run_replay", changeId: "x2", words: "started a replay (job 212)", jobId: 212, definition, from: "2026-10-20", to: "2026-10-27" }),
    row("2026-11-03T13:50:00.000Z", "hacc.replay", { agent: "momentum", jobId: 212, status: "done", verdict: "fail", trades: 173, pnlUsd: -39.8, drawdownPct: 41.25 }),
    row("2026-11-03T13:51:00.000Z", "hacc.change", { agent: "momentum", by: "agent", tool: "hacc_lab", view: "run_replay", changeId: "x3", words: "started a replay (job 213)", jobId: 213, definition, from: "2026-10-20", to: "2026-10-27" }),
  ]

  test("each replay with its definition, window and how it ended", () => {
    const r = historyCall(replayRows, "momentum", {})
    if (!r.ok) throw new Error(r.message)
    const items = (r.body as { items: Record<string, unknown>[] }).items.filter((i) => i.kind === "replay")
    expect(items.map((i) => i.jobId)).toEqual([213, 212, 211])
    expect(items[1]).toMatchObject({ definition, from: "2026-10-20", to: "2026-10-27", state: "done", verdict: "fail", trades: 173 })
    expect(items[2]).toMatchObject({ state: "failed", error: "hard timeout after 600s" })
    expect(items[0]).toMatchObject({ state: "running" })
  })

  test("the next turn is told what ended since the last, and what's still running", () => {
    const note = replayNote(replayRows, "momentum", Date.parse("2026-11-03T13:55:00.000Z"))!
    expect(note).toContain("- Replay 211 failed at 13:44 UTC: hard timeout after 600s.")
    expect(note).toContain("- Replay 212 finished at 13:50 UTC: fail, 173 trades, P&L -$39.80, drawdown 41.3%. Read it with hacc_lab, view replay, id 212.")
    expect(note).toContain("- Replay 213 is still running on Hacc (started 13:51 UTC).")
    expect(replayNote(replayRows, "swing", Date.parse("2026-11-03T13:55:00.000Z"))).toBeUndefined()
    // Once a turn has ended after them, they aren't said again; a replay long past Hacc's stop isn't running.
    const after = [...replayRows, row("2026-11-03T14:00:00.000Z", "agent.turn", { agent: "momentum", turnId: "t10", user: "ok", reply: "ok", tools: [], outcome: "done" })]
    expect(replayNote(after, "momentum", Date.parse("2026-11-03T15:00:00.000Z"))).toBeUndefined()
  })
})
