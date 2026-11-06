// While you were away, on a clock: the gap's records from journal rows
// built here, Candle's fills matched to the Candle Harness's own, the wallets then and now, and the desk that keeps the
// summary, with each read at start answered by a stand-in.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { AWAY_MIN_GAP_MS, type AwayDeps, AwayDesk, awayRecords, coreDown, type HoldingsSnapshot, holdingChanges, outsideFills } from "./away"
import type { ToolOutcome } from "./candle-mcp"
import type { HaccAnswer } from "./hacc"
import type { JournalRow } from "./journal"
import { lastSessionEnd, type WindowFigure } from "./pnl"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const T0 = Date.parse("2026-10-31T09:00:00.000Z")
const MIN = 60_000
const HOUR = 60 * MIN
const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const symbolOf = (mint: string) => (mint === MOON ? "MOON" : mint === PEPE ? "PEPE" : undefined)

/** Rows in order, each `[minutes after T0, type, fields]`. */
function journal(...specs: [number, string, Record<string, unknown>?][]): JournalRow[] {
  return specs.map(([min, type, extra], i) => ({ seq: i + 1, at: new Date(T0 + min * MIN).toISOString(), type, account: "acct_test", mode: "live", ...extra }) as JournalRow)
}
const view = (id: string) => ({ role: "view", clientId: id, clientName: "view" })

/** A live trade card's life: proposed, approved how, sent, and how it ended. */
function trade(at: number, opId: string, o: { agent?: string; mint?: string; side?: string; how?: string; end?: string; signature?: string; usd?: number }): [number, string, Record<string, unknown>][] {
  const agent = o.agent ?? "agent-a"
  const card = `card_${opId}`
  const rows: [number, string, Record<string, unknown>][] = [
    [at, "card.created", { agent, cardId: card, opId, kind: "trade", tool: "candle_trade", mint: o.mint ?? MOON, side: o.side ?? "buy", role: "harness", title: "a trade", headline: `${(o.side ?? "buy").toUpperCase()} $1 of MOON`, value: { usd: o.usd ?? 1 }, wallet: "embedded" }],
  ]
  if (o.end === "expired") return [...rows, [at + 1, "card.expired", { agent, cardId: card, opId }]]
  rows.push([at + 0.01, "card.approved", { agent, cardId: card, opId, how: o.how ?? "enter" }])
  rows.push([at + 0.02, "operation.submitting", { agent, opId, tool: "candle_trade" }])
  if (o.end === "unknown") rows.push([at + 0.5, "operation.unknown", { agent, opId }])
  else rows.push([at + 0.1, "operation.succeeded", { agent, opId, result: { job: { signature: o.signature ?? `sig-${opId}` } } }])
  return rows
}

test("the core wasn't running: from its stop to the next start, or from a dead core's last row", () => {
  // Closed at 10:00, idle-stopped at 10:05, started again by the attach at 13:00.
  const idle = journal([0, "core.started"], [0, "client.attached", view("v1")], [60, "client.detached", { clientId: "v1" }], [65, "core.stopped", { reason: "idle" }], [240, "core.started"])
  expect(coreDown(idle, T0 + HOUR, T0 + 4 * HOUR)).toEqual([{ from: T0 + 65 * MIN, to: T0 + 240 * MIN }])

  // Killed with the view open at 10:00 (no close, no stop row): the mark is its last row, and it was gone
  // the whole gap.
  const killed = journal([0, "core.started"], [0, "client.attached", view("v1")], [60, "agent.turn", { agent: "agent-a", turnId: "t1", outcome: "done" }], [180, "core.started"])
  const mark = lastSessionEnd(killed.slice(0, 3), { runEnded: true })!
  expect(mark).toBe(T0 + 60 * MIN)
  const r = awayRecords(killed, mark, T0 + 180 * MIN, symbolOf)
  expect(r.coreDown).toEqual([{ from: mark, to: T0 + 180 * MIN }])
  expect(r.coreGoneThroughout).toBe(true)
  // The turn that ended at the mark was before the gap, not in it.
  expect(r.turns).toEqual([])

  // A restart mid-gap: two stretches, each said.
  const restarts = journal([0, "client.detached", { clientId: "v1" }], [10, "core.stopped", { reason: "idle" }], [40, "core.started", { headless: true }], [50, "core.stopped", { reason: "idle" }], [120, "core.started"])
  expect(coreDown(restarts, T0, T0 + 2 * HOUR)).toEqual([
    { from: T0 + 10 * MIN, to: T0 + 40 * MIN },
    { from: T0 + 50 * MIN, to: T0 + 120 * MIN },
  ])
  // A headless core that ran through the gap: nothing down.
  const headless = journal([0, "client.detached", { clientId: "v1" }], [30, "hacc.stream", { event: "dropped" }], [90, "hacc.stream", { event: "filled" }])
  expect(coreDown(headless, T0, T0 + 2 * HOUR)).toEqual([])
  // A quick restart isn't a stretch worth saying.
  expect(coreDown(journal([5, "core.stopped"], [5.5, "core.started"]), T0, T0 + HOUR)).toEqual([])
})

test("a live sell Candle closed as the key's paper position isn't filled, and its words say nothing live sold", () => {
  const rows = journal([0, "client.detached", { clientId: "v1" }], ...trade(1, "op-paper", { side: "sell" }))
  const end = rows.find((r) => r.type === "operation.succeeded")!
  end.paper = true
  const r = awayRecords(rows, T0, T0 + HOUR, symbolOf)
  expect(r.trades).toHaveLength(1)
  expect(r.trades[0]).toMatchObject({ outcome: "not-sold", side: "sell" })
  // A paper-mode trade is something else: this one was live.
  expect(r.trades[0]!.paper).toBeUndefined()
  expect(r.trades[0]!.text).toContain("not sold live")
})

test("a turn that ran on after the close and traded without a card, and a card that waited and expired", () => {
  const rows = journal(
    [0, "client.detached", { clientId: "v1" }],
    // Started before the close, ended after it.
    [-1, "agent.turn_started", { agent: "agent-a", turnId: "t1", engine: "claude-code" }],
    ...trade(1, "op-inside", { how: "inside-limits", usd: 1 }),
    [2, "agent.turn", { agent: "agent-a", turnId: "t1", outcome: "done", user: "buy $1 of MOON then wait", reply: "Bought.", tools: ["candle_trade"] }],
    // Proposed before the close, expired after it.
    ...trade(-0.5, "op-expired", { agent: "agent-b", end: "expired" }),
    // Filled before the close: not the gap's.
    ...trade(-5, "op-before", {}),
    [3, "kill.on", { by: "v2" }],
    [4, "card.refused", { agent: "agent-b", tool: "candle_trade", code: "OVER_LIMIT", message: "over agent-b's $2 a trade" }],
    [5, "hacc.change", { agent: "agent-a", action: "follow", words: "followed a wallet" }],
    [6, "paper.call", { agent: "agent-b", tool: "candle_trade", args: { mint: PEPE, side: "buy", amount: "0.1" } }],
  )
  // The rows are as the desk reads them: from before the close.
  const r = awayRecords(
    [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((row, i) => ({ ...row, seq: i + 1 })),
    T0,
    T0 + HOUR,
    symbolOf,
  )
  expect(r.turns).toHaveLength(1)
  expect(r.turns[0]!.text).toContain('you asked agent-a: "buy $1 of MOON then wait"')
  const inside = r.trades.find((t) => t.withoutCard)!
  expect(inside).toMatchObject({ outcome: "filled", agent: "agent-a", side: "buy", usd: 1, mode: "live" })
  expect(inside.text).toContain("without a card, inside its wallet's limits")
  expect(r.trades.find((t) => t.outcome === "expired")).toMatchObject({ agent: "agent-b" })
  expect(r.trades.find((t) => t.paper)).toMatchObject({ agent: "agent-b", outcome: "filled", side: "buy" })
  expect(r.trades.some((t) => t.seqs.length && t.text.includes("op-before"))).toBe(false)
  expect(r.trades).toHaveLength(3)
  expect(r.stopped.map((s) => s.text)).toEqual([expect.stringContaining("refused"), expect.stringContaining("kill switch")])
  expect(r.changes).toHaveLength(1)
  // Newest first.
  expect(Date.parse(r.trades[0]!.at)).toBeGreaterThanOrEqual(Date.parse(r.trades.at(-1)!.at))
  // Every live trade the rows hold goes to the fill matcher, with its signature.
  expect(r.harness.map((t) => t.opId).sort()).toEqual(["op-before", "op-expired", "op-inside"])
  expect(r.harness.find((t) => t.opId === "op-inside")).toMatchObject({ signature: "sig-op-inside", unknown: false })
})

test("Candle's fills since the mark that the Candle Harness didn't send: by id, by signature, and a lost trade claiming its fill", () => {
  const rows = journal(...trade(10, "op-lost", { end: "unknown" }), ...trade(20, "op-known", { signature: "sig-known" }), ...trade(30, "op-both", { mint: PEPE, end: "unknown" }))
  const harness = awayRecords(rows, T0, T0 + HOUR, symbolOf).harness
  expect(harness.find((t) => t.opId === "op-lost")).toMatchObject({ unknown: true, sentAt: T0 + 10.02 * MIN })
  const fill = (min: number, o: Record<string, unknown>) => ({ mint: MOON, side: "buy", status: "confirmed", usdValue: 1, createdAt: T0 + min * MIN, ...o })
  const answer = {
    trades: [
      fill(55, { signature: "s-cli", clientTradeId: "a-uuid-the-cli-made" }), // the CLI's: outside
      fill(40, { mint: PEPE, signature: "s-p1" }), // could be op-both's...
      fill(41, { mint: PEPE, signature: "s-p2" }), // ...or this: each may be the Candle Harness's
      fill(20.1, { signature: "sig-known" }), // the Candle Harness's by signature (no id)
      fill(10.4, { signature: "s-lost" }), // no id, op-lost's token and side, after it was sent: claimed
      fill(10.3, { signature: "s-lost-id", clientTradeId: "op-lost" }), // the Candle Harness's by id, though its outcome is unknown
      fill(12, { signature: "s-failed", status: "failed", error: { message: "slippage" } }), // moved nothing
      fill(-30, { signature: "s-old", clientTradeId: "x" }), // before the mark
    ],
  }
  const out = outsideFills(answer, "agent-a", T0, harness, symbolOf)!
  expect(out.fills.map((f) => f.signature)).toEqual(["s-cli"])
  expect(out.fills[0]).toMatchObject({ agent: "agent-a", symbol: "MOON", side: "buy", usd: 1 })
  expect(out.maybe.map((f) => f.signature).sort()).toEqual(["s-p1", "s-p2"])
  expect(out.claimed).toBe(1)
  expect(out.reachesBack).toBeUndefined()
  // A fill another agent's lost trade could have made isn't this agent's to claim.
  expect(outsideFills({ trades: [fill(15, { signature: "s-x" })] }, "agent-b", T0, harness)!.fills).toHaveLength(1)
  // Candle's newest 200 not reaching back to the mark says how far they reach.
  const many = Array.from({ length: 200 }, (_, i) => fill(59 - i * 0.01, { signature: `s${i}`, clientTradeId: `id${i}` }))
  expect(outsideFills({ trades: many }, "agent-a", T0, [])!.reachesBack).toBe(Math.round(T0 + (59 - 199 * 0.01) * MIN))
  expect(outsideFills({ nope: true }, "agent-a", T0, [])).toBeUndefined()
})

test("what the wallets hold now against then", () => {
  const then: HoldingsSnapshot = { at: T0, readAt: T0, wallets: [{ address: "W1", name: "embedded", sol: 1, tokens: [{ mint: MOON, symbol: "MOON", amount: 100 }] }] }
  const now: HoldingsSnapshot = { at: T0 + HOUR, readAt: T0 + HOUR, wallets: [{ address: "W1", name: "embedded", sol: 0.9, tokens: [{ mint: PEPE, symbol: "PEPE", amount: 5 }, { mint: MOON, symbol: "MOON", amount: 100 }] }, { address: "W2", name: "tee-1", sol: 2, tokens: [] }] }
  expect(holdingChanges(then, now)).toEqual([
    { wallet: "W1", name: "embedded", asset: "SOL", symbol: "SOL", then: 1, now: 0.9 },
    { wallet: "W1", name: "embedded", asset: PEPE, symbol: "PEPE", then: 0, now: 5 },
  ])
})

/** A desk with each read at start answered by a stand-in, on a clock. */
function desk(rows: JournalRow[], o: Partial<AwayDeps> & { clock: { t: number }; dir?: string }) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "chrn-away-"))
  dirs.push(dir)
  const published: unknown[] = []
  const figure: WindowFigure = { window: "since", label: "since last session", start: T0, usd: 2.5, from: T0 + 5 * MIN, short: false, agents: { "agent-a": { usd: 2.5, from: T0 + 5 * MIN } } }
  const d = new AwayDesk({
    statePath: join(dir, "away.json"),
    now: () => o.clock.t,
    redactor: new Redactor(),
    rowsSince: async (from) => ({ rows: rows.filter((r) => Date.parse(r.at) >= from) }),
    memoryRows: () => rows,
    symbolOf,
    waitingCards: () => 0,
    ready: async () => {},
    agents: () => [{ agent: "agent-a", prefix: "FakeKey1" }],
    readPnl: async () => {},
    pnlFigure: () => figure,
    pnlFailed: () => undefined,
    fills: async () => ({ kind: "ok", result: { trades: [] } }),
    mine: async () => ({ kind: "ok", status: 200, body: { signals: [], next_after: null }, ms: 1, cached: false }),
    holdings: () => undefined,
    publish: (v) => published.push(v),
    holdingsWaitMs: 50,
    ...o,
  })
  return { d, dir, published }
}

test("the desk: no summary under 10 minutes or before any close; one past it, kept in state/away.json 0600 across a restart", async () => {
  const clock = { t: T0 + 5 * MIN }
  const rows = journal([0, "client.detached", { clientId: "v1" }], ...trade(2, "op-1", { how: "inside-limits" }))
  const { d, dir } = desk(rows, { clock })
  expect(d.view()).toEqual({ summary: null, firstRun: true })
  expect(await d.opened("v2", undefined)).toBeUndefined()
  expect(await d.opened("v2", T0)).toBeUndefined() // 5 minutes
  clock.t = T0 + AWAY_MIN_GAP_MS
  const s = (await d.opened("v2", T0))!
  expect(s).toMatchObject({ from: T0, to: T0 + AWAY_MIN_GAP_MS, forView: "v2", happened: true, coreDown: [], coreGoneThroughout: false })
  expect(s.counts).toMatchObject({ trades: 1, withoutCard: 1 })
  expect(s.pnl).toMatchObject({ state: "read", usd: 2.5, label: "since last session", from: T0 + 5 * MIN })
  expect(s.outside).toMatchObject({ state: "read", agents: [{ agent: "agent-a", state: "read", fills: [] }] })
  expect(s.signals).toMatchObject({ state: "read", count: 0 })
  await d.flush()
  expect(statSync(join(dir, "away.json")).mode & 0o777).toBe(0o600)
  // A restart, or a second view, shows the same one.
  const again = desk([], { clock, dir })
  expect(again.d.view().summary?.id).toBe(s.id)
  expect(again.d.view().firstRun).toBeUndefined()
  // A short gap later leaves it as it was.
  clock.t += 2 * MIN
  expect(await again.d.opened("v3", clock.t - MIN)).toBeUndefined()
  expect(again.d.view().summary?.id).toBe(s.id)
})

test("a quiet gap says nothing happened; a gap with the core gone says so, and only Candle's and Hacc's side fills it", async () => {
  const clock = { t: T0 + 3 * HOUR }
  const quiet = desk(journal([0, "client.detached", { clientId: "v1" }], [5, "core.stopped", { reason: "idle" }], [180, "core.started"]), { clock })
  const s = (await quiet.d.opened("v2", T0))!
  expect(s.happened).toBe(false)
  expect(s.coreDown).toEqual([{ from: T0 + 5 * MIN, to: T0 + 3 * HOUR }])

  const gone = desk(journal([0, "agent.turn", { agent: "agent-a", turnId: "t0", outcome: "done" }], [180, "core.started"]), {
    clock,
    fills: async () => ({ kind: "ok", result: { trades: [{ mint: MOON, side: "sell", status: "confirmed", usdValue: 3, createdAt: T0 + HOUR, signature: "s-web", clientTradeId: "web-1" }] } }),
    mine: async () => ({ kind: "ok", status: 200, body: { signals: [{ id: 7, created_at: new Date(T0 + 2 * HOUR).toISOString(), pattern: "kol_buy" }], next_after: null }, ms: 1, cached: false }),
  })
  const g = (await gone.d.opened("v2", T0))!
  expect(g.coreGoneThroughout).toBe(true)
  expect(g).toMatchObject({ turns: [], trades: [], happened: true })
  expect(g.counts).toMatchObject({ outside: 1, signals: 1 })
  expect(g.outside.agents[0]!.fills[0]).toMatchObject({ side: "sell", symbol: "MOON", usd: 3 })
  expect(g.signals.newest[0]).toMatchObject({ id: 7 })
})

test("personal signals page on Hacc's own cursor, a whole number, never a date of ours, and are kept by their date (Hacc refuses a date there)", async () => {
  const clock = { t: T0 + 3 * HOUR }
  const asked: (string | undefined)[] = []
  const sig = (id: number, at: number) => ({ id, created_at: new Date(at).toISOString(), pattern: "new_ticker" })
  const page = (rows: unknown[], next: number) => ({ kind: "ok" as const, status: 200, body: { signals: rows, next_after: next }, ms: 1, cached: false })
  const full = (from: number, at: number) => Array.from({ length: 100 }, (_, i) => sig(from + i, at))
  const { d } = desk(journal([0, "client.detached", { clientId: "v1" }]), {
    clock,
    mine: async (after: string | undefined) => {
      asked.push(after)
      // Two full pages from before the mark, then the gap's two.
      return after === undefined ? page(full(1, T0 - HOUR), 100) : after === "100" ? page(full(101, T0 - HOUR), 200) : page([sig(201, T0 + HOUR), sig(202, T0 + 2 * HOUR)], 202)
    },
  })
  const s = (await d.opened("v2", T0))!
  await Bun.sleep(5)
  expect(asked).toEqual([undefined, "100", "200"])
  expect(d.view().summary?.signals).toMatchObject({ state: "read", count: 2 })
  expect(d.view().summary?.signals.newest.map((r) => r.id)).toEqual([202, 201])
  expect(s.id).toBeDefined()
})

test("each read at start that fails says so in its place, never as nothing", async () => {
  const clock = { t: T0 + HOUR }
  const lost: ToolOutcome = { kind: "error", code: "RATE_LIMITED", retryable: true, body: { message: "Rate limit exceeded for this key." } }
  const plan: HaccAnswer = { kind: "refused", code: "PLAN_REQUIRED", message: "requires Pro or Max", ms: 1 }
  const { d } = desk(journal([0, "client.detached", { clientId: "v1" }]), {
    clock,
    fills: async () => lost,
    mine: async () => plan,
    pnlFigure: () => ({ window: "since", label: "since last session", start: T0, usd: null, from: null, short: false, agents: {} }),
    pnlFailed: () => "Candle didn't answer",
  })
  const s = (await d.opened("v2", T0))!
  expect(s.outside).toMatchObject({ state: "failed", agents: [{ state: "failed", words: "RATE_LIMITED: Rate limit exceeded for this key." }] })
  expect(s.signals).toMatchObject({ state: "needs-plan", words: "Personal signals need Pro or Max (requires Pro or Max)" })
  expect(s.pnl).toMatchObject({ state: "failed", usd: null, words: "Candle's P&L didn't answer for agent-a: Candle didn't answer" })
  // The portfolio wasn't read after the attach: the holdings say so.
  await Bun.sleep(80)
  expect(d.view().summary!.holdings).toMatchObject({ state: "failed", words: expect.stringContaining("wasn't read") })
  // Hacc off: said, never asked.
  const off = desk(journal([0, "client.detached", { clientId: "v1" }]), { clock, mine: undefined })
  expect((await off.d.opened("v2", T0))!.signals).toMatchObject({ state: "off" })
})

test("the wallets then and now: compared once the attach's portfolio read lands; unknown after a core that died with the view open", async () => {
  const clock = { t: T0 }
  let snap: HoldingsSnapshot | undefined = { at: T0, readAt: T0 - 5_000, wallets: [{ address: "W1", name: "embedded", sol: 1, tokens: [{ mint: MOON, amount: 10 }] }] }
  const { d } = desk(journal([0, "client.detached", { clientId: "v1" }]), { clock, holdings: () => snap, holdingsWaitMs: 5_000 })
  d.closed()
  clock.t = T0 + HOUR
  const pending = d.opened("v2", T0)
  // The last read is from before the attach: not "now" yet.
  await pending
  expect(d.view().summary!.holdings.state).toBe("reading")
  snap = { at: T0 + HOUR, readAt: T0 + HOUR + 1_000, wallets: [{ address: "W1", name: "embedded", sol: 1, tokens: [{ mint: MOON, amount: 4 }] }] }
  d.portfolioRead()
  const s = d.view().summary!
  expect(s.holdings).toMatchObject({ state: "read", then: T0 - 5_000, changes: [{ asset: MOON, symbol: "MOON", then: 10, now: 4 }] })
  expect(s.counts.holdings).toBe(1)
  expect(s.happened).toBe(true)
  d.stop()

  // No close: the snapshot is from an earlier session, so there's nothing to compare against.
  const old = desk(journal([0, "agent.turn", { agent: "agent-a", turnId: "t", outcome: "done" }], [60, "core.started"]), { clock, holdings: () => ({ ...snap!, at: T0 - 5 * HOUR, readAt: T0 + 2 * HOUR + 1_000 }) })
  old.d.closed()
  clock.t = T0 + 2 * HOUR
  await old.d.opened("v2", T0)
  old.d.portfolioRead()
  expect(old.d.view().summary!.holdings).toMatchObject({ state: "unknown", words: expect.stringContaining("didn't see") })
  old.d.stop()

  // No record at all, as after an older build that kept none: said so, not blamed on the core.
  let none: HoldingsSnapshot | undefined
  const bare = desk(journal([0, "client.detached", { clientId: "v1" }]), { clock, holdings: () => none })
  bare.d.closed()
  clock.t = T0 + 3 * HOUR
  await bare.d.opened("v2", T0)
  none = { at: clock.t, readAt: clock.t + 1_000, wallets: [] }
  bare.d.portfolioRead()
  expect(bare.d.view().summary!.holdings).toMatchObject({ state: "unknown", words: "The Candle Harness has no record of what the wallets held when it last closed, so there's nothing to compare against." })
  bare.d.stop()
})

test("a Candle Harness trade whose outcome is unknown is never called outside, through the desk", async () => {
  const clock = { t: T0 + HOUR }
  const rows = journal([0, "client.detached", { clientId: "v1" }], ...trade(5, "op-lost", { how: "inside-limits", end: "unknown" }))
  const { d, dir } = desk(rows, {
    clock,
    fills: async () => ({ kind: "ok", result: { trades: [{ mint: MOON, side: "buy", status: "confirmed", usdValue: 1, createdAt: T0 + 5.1 * MIN, signature: "s1" }] } }),
  })
  const s = (await d.opened("v2", T0))!
  expect(s.outside.agents[0]).toMatchObject({ fills: [], maybe: [], claimed: 1 })
  expect(s.trades[0]).toMatchObject({ outcome: "unknown", withoutCard: true })
  await d.flush()
  expect(JSON.parse(readFileSync(join(dir, "away.json"), "utf8")).summary.id).toBe(s.id)
})
