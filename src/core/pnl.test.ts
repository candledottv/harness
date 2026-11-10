import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pnlA from "../../test/fixtures/candle-recorded/feeds-pnl/pnl-agent-a.json"
import pnlB from "../../test/fixtures/candle-recorded/feeds-pnl/pnl-agent-b.json"
import pnlUnknown from "../../test/fixtures/candle-recorded/feeds-pnl/pnl-unknown-prefix.json"
import tradesB from "../../test/fixtures/candle-recorded/feeds-pnl/trades-agent-b.json"
import type { ToolOutcome } from "./candle-mcp"
import type { JournalRow } from "./journal"
import { pnlCall } from "./pnl-tool"
import {
  bookFrom,
  botSignatures,
  GAP_MS,
  journalSwaps,
  lastSessionEnd,
  paperPnl,
  parseWindow,
  PNL_AFTER_FILL_MS,
  PNL_FOLLOW_UP_MS,
  PNL_BACKGROUND_MS,
  PNL_ON_SCREEN_MS,
  PnlBook,
  type PnlDeps,
  type PnlWindow,
  readWindowState,
  SampleStore,
  saveWindowState,
  sinceStart,
  sumTotals,
  THIN_AFTER_MS,
  thinned,
  tradesFrom,
  walletsAcross,
  windowFigure,
  windowLabel,
  windowStart,
} from "./pnl"

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "chrn-pnl-"))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}
const MIN = 60_000
const HOUR = 3_600_000
/** A local time, so windows on midnight and a time of day read as the person's clock does. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const prefixes = { FakeKey1: "agent-a", FakeKey2: "agent-b" } as Record<string, string>
const agentOf = (p: string) => prefixes[p]

test("windows: what config and the pick name, and a wrong one says what to use", () => {
  for (const w of ["24h", "midnight", "session", "18:00"]) expect(parseWindow(w)).toEqual({ ok: true, window: w as PnlWindow })
  expect(parseWindow("7:05")).toEqual({ ok: true, window: "07:05" })
  for (const bad of ["today", "24:00", "18:60", 5, null]) expect(parseWindow(bad).ok).toBe(false)
  expect(windowLabel("24h")).toBe("24h")
  expect(windowLabel("midnight")).toBe("since midnight")
  expect(windowLabel("18:00")).toBe("since 18:00")
  expect(windowLabel("session")).toBe("since last session")
})

test("each window's start, in this machine's time: a time of day not yet reached is yesterday's", () => {
  const now = local(2026, 10, 30, 17, 0)
  expect(windowStart("24h", now, undefined)).toBe(now - 24 * HOUR)
  expect(windowStart("midnight", now, undefined)).toBe(local(2026, 10, 30))
  expect(windowStart("09:00", now, undefined)).toBe(local(2026, 10, 30, 9))
  expect(windowStart("18:00", now, undefined)).toBe(local(2026, 10, 29, 18))
  expect(windowStart("17:00", now, undefined)).toBe(now)
  // Since last session: the main view's last close, and none known yet is none.
  expect(windowStart("session", now, local(2026, 10, 30, 12))).toBe(local(2026, 10, 30, 12))
  expect(windowStart("session", now, undefined)).toBeNull()
})

test("harness_pnl's since: a window, a span back, a date or a time; anything else isn't one", () => {
  const now = local(2026, 10, 30, 17)
  expect(sinceStart("midnight", now, undefined)).toEqual({ start: local(2026, 10, 30), label: "since midnight" })
  expect(sinceStart("7d", now, undefined)).toEqual({ start: now - 7 * 24 * HOUR, label: "7d" })
  expect(sinceStart("48h", now, undefined)?.start).toBe(now - 48 * HOUR)
  expect(sinceStart("2026-10-27", now, undefined)).toEqual({ start: local(2026, 10, 27), label: "since 2026-10-27" })
  expect(sinceStart("2026-10-29T18:00", now, undefined)?.start).toBe(local(2026, 10, 29, 18))
  for (const bad of ["tuesday", "0d", "2026-11-02", ""]) expect(sinceStart(bad, now, undefined)).toBeUndefined()
  // "session" starts at the mark, and says so, so the figure starts from the mark's own sample.
  expect(sinceStart("session", now, local(2026, 10, 30, 14))).toEqual({ start: local(2026, 10, 30, 14), label: "since last session", mark: true })
})

test("Candle's book in its recorded shape: totals, open positions with their cost, wallets, and rounds another agent opened", () => {
  const b = bookFrom(pnlB.answer, "FakeKey2", agentOf, (m) => (m.endsWith("CNDL") ? "CNDL" : undefined))!
  expect(b.totals.totalUsd).toBeCloseTo(-8.5067403, 6)
  expect(b.totals.realizedNetUsd + b.totals.unrealizedUsd).toBeCloseTo(b.totals.totalUsd, 5)
  expect(b.positions).toHaveLength(2)
  expect(b.positions[1]).toMatchObject({ symbol: "CNDL", costBasisUsd: expect.any(Number), markPriceUsd: expect.any(Number), unrealizedUsd: expect.any(Number) })
  expect(b.oldestMarkAt).toBe(1791877253372)
  expect(b.wallets).toEqual([expect.objectContaining({ wallet: "WalletFake611111111111111111111111111111111", payerType: "main", openPositions: 2 })])
  // agent-b's book holds rounds agent-a opened (the closer gets the whole round): named by agent.
  expect(b.crossed.length).toBeGreaterThan(0)
  expect(b.crossed.every((c) => c.openedBy === "agent-a")).toBe(true)
  // Hyperliquid's figures come as strings.
  expect(b.hyperliquid).toMatchObject({ read: true, netUsd: 0, inTotal: true })
  const a = bookFrom(pnlA.answer, "FakeKey1", agentOf)!
  expect(a.crossed).toEqual([])
  expect(a.wallets.map((w) => w.payerType)).toContain("linked")
  // An unknown prefix is an empty book, not an error; perps say why they weren't read.
  const empty = bookFrom(pnlUnknown.answer, "zzzzzzzz", agentOf)!
  expect(empty.totals.totalUsd).toBe(0)
  expect(empty.hyperliquid.read).toBe(false)
  expect(empty.hyperliquid.why).toBeDefined()
  expect(bookFrom({ success: false }, "x", agentOf)).toBeUndefined()
  expect(bookFrom({ pnl: {} }, "x", agentOf)).toBeUndefined()
})

test("the shared wallet: each wallet's total is its agents' books summed, and the Candle Harness's sum is the books'", () => {
  const a = bookFrom(pnlA.answer, "FakeKey1", agentOf)!
  const b = bookFrom(pnlB.answer, "FakeKey2", agentOf)!
  const rows = walletsAcross([
    { agent: "agent-a", book: a },
    { agent: "agent-b", book: b },
  ])
  const embedded = rows.find((w) => w.wallet === "WalletFake611111111111111111111111111111111")!
  expect(embedded.agents).toEqual(["agent-a", "agent-b"])
  const parts = [a, b].map((x) => x.wallets.find((w) => w.wallet === embedded.wallet)?.totalUsd ?? 0)
  expect(embedded.totalUsd).toBeCloseTo(parts[0]! + parts[1]!, 9)
  expect(sumTotals([a, b])!.totalUsd).toBeCloseTo(a.totals.totalUsd + b.totals.totalUsd, 9)
  expect(sumTotals([])).toBeNull()
})

test("recent fills from the trades read, newest first, by agent", () => {
  const rows = tradesFrom(tradesB.answer, "agent-b")!
  expect(rows.length).toBe(tradesB.answer.trades.length)
  expect(rows[0]).toMatchObject({ agent: "agent-b", side: expect.any(String), status: "confirmed", usd: expect.any(Number), signature: expect.any(String) })
  for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.at).toBeGreaterThanOrEqual(rows[i]!.at)
  const failed = tradesFrom({ trades: [{ mint: "M", createdAt: 1, side: "buy", status: "failed", error: { message: "slippage" } }] }, "agent-a")!
  expect(failed[0]).toMatchObject({ status: "failed", error: "slippage", usd: null })
  expect(tradesFrom({}, "agent-a")).toBeUndefined()
})

/** A sample store on a temp file, with these samples kept. */
function store(samples: [string, number, number][] = [], now = () => Date.now(), prefix = (a: string) => `P-${a}`): SampleStore {
  const s = new SampleStore(join(dir(), "pnl.jsonl"), now)
  for (const [agent, at, totalUsd] of samples) s.add({ at, agent, prefix: prefix(agent), totalUsd, realizedNetUsd: 0, unrealizedUsd: totalUsd })
  return s
}
const read = (agent: string, at: number, totalUsd: number) => ({ agent, prefix: `P-${agent}`, at, totalUsd })

test("the window's figure: each agent's total now less its first sample in the window", () => {
  const now = local(2026, 10, 30, 15)
  const s = store([
    ["agent-a", local(2026, 10, 30, 7), -2], // in midnight's window, before 09:00's
    ["agent-a", local(2026, 10, 30, 9, 5), -1],
    ["agent-a", local(2026, 10, 30, 14), 1.5],
  ])
  const f = windowFigure({ window: "09:00", label: "since 09:00", start: local(2026, 10, 30, 9), now: [read("agent-a", now, 2)], samples: s })
  expect(f.usd).toBeCloseTo(3, 9) // 2 − (−1)
  expect(f.from).toBe(local(2026, 10, 30, 9, 5))
  expect(f.short).toBe(false) // 5 minutes after the start is within the samples' pace
  const day = windowFigure({ window: "midnight", label: "since midnight", start: local(2026, 10, 30), now: [read("agent-a", now, 2)], samples: s })
  expect(day.usd).toBeCloseTo(4, 9)
  // The samples start at 07:00, later than midnight: the figure says from when.
  expect(day.short).toBe(true)
  expect(day.from).toBe(local(2026, 10, 30, 7))
})

test("a figure whose ends Candle priced differently is marked partial, with how many positions it can't price now", () => {
  const now = local(2026, 10, 30, 15)
  const s = new SampleStore(join(dir(), "pnl.jsonl"), () => now)
  // At the start every position had a price, and a holding was up $300; now one has none, so the total drops by it.
  s.add({ at: local(2026, 10, 30, 9), agent: "agent-a", prefix: "P-agent-a", totalUsd: 300, realizedNetUsd: 0, unrealizedUsd: 300, unpriced: 0 })
  const f = windowFigure({ window: "09:00", label: "since 09:00", start: local(2026, 10, 30, 9), now: [{ ...read("agent-a", now, 0), unpriced: 1 }], samples: s })
  expect(f.usd).toBeCloseTo(-300, 9)
  expect(f.unpriced).toBe(1)
  expect(f.agents["agent-a"]!.partial).toBe(true)
  // Priced alike at both ends: the change is the trading, unmarked.
  const alike = windowFigure({ window: "09:00", label: "since 09:00", start: local(2026, 10, 30, 9), now: [{ ...read("agent-a", now, 310), unpriced: 0 }], samples: s })
  expect(alike.unpriced).toBeUndefined()
  expect(alike.agents["agent-a"]!.partial).toBeUndefined()
})

test("a sample's count of unpriced positions is read back from its file", async () => {
  const path = join(dir(), "pnl.jsonl")
  const s = new SampleStore(path, () => Date.now())
  s.add({ at: Date.now(), agent: "agent-a", prefix: "P", totalUsd: 1, realizedNetUsd: 0, unrealizedUsd: 1, unpriced: 2 })
  await s.flush()
  const again = new SampleStore(path, () => Date.now())
  again.load()
  expect(again.of("agent-a")[0]!.unpriced).toBe(2)
})

test("harness_pnl says a partial figure is partial", () => {
  const figure = { window: "24h" as const, label: "24h", start: 0, usd: -300, from: 0, short: false, unpriced: 1, agents: { "agent-a": { usd: -300, from: 0, partial: true as const } } }
  const book = { figure: () => figure, view: () => ({ figure, window: "24h", agents: [{ agent: "agent-a", prefix: "P", readAt: 1, book: { totals: { totalUsd: 0, realizedNetUsd: 0, unrealizedUsd: 0, feesUsd: 0 }, positions: [], crossed: [], truncated: false } }], swaps: [], paper: {} }) }
  const answer = pnlCall(book as never, {}, { now: () => 1, sessionEnd: () => undefined, mode: () => "live" })
  const body = (answer as { ok: true; body: { partial: string; agents: { partial: string }[] } }).body
  expect(body.partial).toContain("no price for 1 position")
  expect(body.agents[0]!.partial).toContain("different number")
})

test("across the window's start: a sample just before it isn't the start, the first after is", () => {
  const start = local(2026, 10, 30)
  const s = store([
    ["agent-a", start - 2 * MIN, 10],
    ["agent-a", start + 2 * MIN, 11],
  ])
  const f = windowFigure({ window: "midnight", label: "since midnight", start, now: [read("agent-a", start + HOUR, 12.5)], samples: s })
  expect(f.usd).toBeCloseTo(1.5, 9)
  expect(f.from).toBe(start + 2 * MIN)
  expect(f.short).toBe(false)
})

test("before any sample in the window, the figure is missing, never zero; the read now counts as one once in it", () => {
  const start = local(2026, 10, 30, 18)
  const s = store([["agent-a", start - 30 * MIN, 5]])
  expect(windowFigure({ window: "18:00", label: "since 18:00", start, now: [], samples: s }).usd).toBeNull()
  // The read before the start: nothing in the window yet.
  const before = windowFigure({ window: "18:00", label: "since 18:00", start, now: [read("agent-a", start - MIN, 5)], samples: s })
  expect(before.usd).toBeNull()
  expect(before.agents["agent-a"]).toEqual({ usd: null, from: null })
  // A read in the window that wasn't kept as a sample (a minute since the last): it's the start.
  const after = windowFigure({ window: "18:00", label: "since 18:00", start, now: [read("agent-a", start + 20_000, 5.2)], samples: s })
  expect(after.usd).toBe(0)
  expect(after.from).toBe(start + 20_000)
})

test("an agent added mid-window adds only its own change since its first sample, so the total doesn't jump", () => {
  const start = local(2026, 10, 30)
  const s = store([
    ["agent-a", start + 5 * MIN, -1],
    // agent-c, a key with a book of its own, added at noon.
    ["agent-c", local(2026, 10, 30, 12), 40],
  ])
  const f = windowFigure({ window: "midnight", label: "since midnight", start, now: [read("agent-a", local(2026, 10, 30, 15), 0), read("agent-c", local(2026, 10, 30, 15), 41)], samples: s })
  expect(f.agents["agent-a"]).toEqual({ usd: 1, from: start + 5 * MIN })
  expect(f.agents["agent-c"]).toEqual({ usd: 1, from: local(2026, 10, 30, 12) })
  expect(f.usd).toBe(2)
  expect(f.from).toBe(start + 5 * MIN)
})

test("a gap: with the core off at the window's start, the figure runs from the first sample after, and says so", () => {
  const now = local(2026, 10, 30, 15)
  const s = store([
    ["agent-a", now - 30 * HOUR, 1],
    ["agent-a", now - 26 * HOUR, 2],
    // The core was off from then until this morning.
    ["agent-a", now - 6 * HOUR, 4],
  ])
  const f = windowFigure({ window: "24h", label: "24h", start: now - 24 * HOUR, now: [read("agent-a", now, 5)], samples: s })
  expect(f.usd).toBe(1)
  expect(f.from).toBe(now - 6 * HOUR)
  expect(f.short).toBe(true)
})

test("another key under the agent's name: its old key's samples aren't its start", () => {
  const start = local(2026, 10, 30)
  const s = new SampleStore(join(dir(), "pnl.jsonl"), Date.now)
  s.add({ at: start + MIN, agent: "agent-a", prefix: "OLDKEY", totalUsd: -50, realizedNetUsd: 0, unrealizedUsd: 0 })
  s.add({ at: start + HOUR, agent: "agent-a", prefix: "NEWKEY", totalUsd: 0, realizedNetUsd: 0, unrealizedUsd: 0 })
  const f = windowFigure({ window: "midnight", label: "since midnight", start, now: [{ agent: "agent-a", prefix: "NEWKEY", at: start + 2 * HOUR, totalUsd: 1 }], samples: s })
  expect(f.usd).toBe(1)
})

test("since last session with no close known: from the first sample, said so", () => {
  const s = store([["agent-a", local(2026, 10, 30, 9, 14), 1]])
  const f = windowFigure({ window: "session", label: "since last session", start: null, now: [read("agent-a", local(2026, 10, 30, 15), 3)], samples: s })
  expect(f).toMatchObject({ usd: 2, from: local(2026, 10, 30, 9, 14), short: true })
})

test("since last session: the mark's own sample is the start, so a gap with the core stopped after it is counted whole", () => {
  const mark = local(2026, 10, 30, 14)
  const s = store([
    ["agent-a", mark - 3 * MIN, 10],
    // The core stopped after the mark; a fill outside the Candle Harness moved the book while it was gone.
    ["agent-a", mark + HOUR, 14],
  ])
  const now = [read("agent-a", mark + HOUR + 5 * MIN, 14.5)]
  const marked = windowFigure({ window: "since", label: "since last session", start: mark, now, samples: s, mark: true })
  expect(marked).toMatchObject({ usd: 4.5, from: mark - 3 * MIN, short: false })
  expect(marked.agents["agent-a"]).toEqual({ usd: 4.5, from: mark - 3 * MIN })
  // Any other window keeps its own rule: from the first sample after its start, said so.
  expect(windowFigure({ window: "since", label: "since 14:00", start: mark, now, samples: s })).toMatchObject({ usd: 0.5, from: mark + HOUR, short: true })
})

test("since last session: a sample further back than the samples' pace, or another key's, isn't the mark's", () => {
  const mark = local(2026, 10, 30, 14)
  const now = [read("agent-a", mark + HOUR + 5 * MIN, 14.5)]
  const stale = store([
    ["agent-a", mark - GAP_MS - MIN, 10],
    ["agent-a", mark + HOUR, 14],
  ])
  expect(windowFigure({ window: "since", label: "since last session", start: mark, now, samples: stale, mark: true })).toMatchObject({ usd: 0.5, from: mark + HOUR, short: true })
  const other = new SampleStore(join(dir(), "pnl.jsonl"), Date.now)
  other.add({ at: mark - MIN, agent: "agent-a", prefix: "OLDKEY", totalUsd: -50, realizedNetUsd: 0, unrealizedUsd: 0 })
  other.add({ at: mark + HOUR, agent: "agent-a", prefix: "P-agent-a", totalUsd: 14, realizedNetUsd: 0, unrealizedUsd: 0 })
  expect(windowFigure({ window: "since", label: "since last session", start: mark, now, samples: other, mark: true }).usd).toBeCloseTo(0.5, 9)
})

test("the last session's end, from the journal's detach rows: the main view's, never a popped pane's", () => {
  const rows = [
    { seq: 1, at: "2026-10-30T08:00:00.000Z", type: "client.attached", role: "view", clientId: "v1", clientName: "candle-harness view" },
    { seq: 2, at: "2026-10-30T08:05:00.000Z", type: "client.attached", role: "view", clientId: "p1", clientName: "candle-harness view --pane signals" },
    { seq: 3, at: "2026-10-30T09:00:00.000Z", type: "client.detached", role: "view", clientId: "v1" },
    { seq: 4, at: "2026-10-30T10:00:00.000Z", type: "client.attached", role: "harness", clientId: "h1", clientName: "claude" },
    { seq: 5, at: "2026-10-30T10:05:00.000Z", type: "client.detached", role: "harness", clientId: "h1" },
    { seq: 6, at: "2026-10-30T11:00:00.000Z", type: "client.detached", role: "view", clientId: "p1" },
  ] as unknown as JournalRow[]
  expect(lastSessionEnd(rows)).toBe(Date.parse("2026-10-30T09:00:00.000Z"))
  expect(lastSessionEnd(rows.slice(0, 2))).toBeUndefined()
})

test("samples: a minute apart at most per agent, read back on a restart (0600), a bad line skipped", async () => {
  const d = dir()
  const path = join(d, "pnl.jsonl")
  const t0 = local(2026, 10, 30, 9)
  const s = new SampleStore(path, () => t0)
  const sample = (at: number, totalUsd: number) => ({ at, agent: "agent-a", prefix: "P", totalUsd, realizedNetUsd: 0, unrealizedUsd: 0 })
  expect(s.add(sample(t0, 1))).toBe(true)
  expect(s.add(sample(t0 + 30_000, 2))).toBe(false)
  expect(s.add(sample(t0 + MIN, 3))).toBe(true)
  await s.flush()
  expect(statSync(path).mode & 0o777).toBe(0o600)
  writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"at":"x"}\n`)
  const again = new SampleStore(path, () => t0 + 2 * MIN)
  again.load()
  expect(again.of("agent-a").map((x) => x.totalUsd)).toEqual([1, 3])
})

test("samples past 30 days are thinned to one an hour, the file rewritten", async () => {
  const now = local(2026, 10, 30, 12)
  const old = now - THIN_AFTER_MS - 5 * HOUR
  const samples = Array.from({ length: 120 }, (_, i) => ({ at: old + i * MIN, agent: "agent-a", prefix: "P", totalUsd: i, realizedNetUsd: 0, unrealizedUsd: 0 }))
  const recent = Array.from({ length: 5 }, (_, i) => ({ at: now - i * MIN, agent: "agent-a", prefix: "P", totalUsd: i, realizedNetUsd: 0, unrealizedUsd: 0 })).reverse()
  const kept = thinned([...samples, ...recent], now)
  // Two hours' worth of minutes past 30 days (maybe three hours touched), and every recent one.
  expect(kept.length).toBeLessThanOrEqual(3 + 5)
  expect(kept.slice(-5)).toEqual(recent)
  const path = join(dir(), "pnl.jsonl")
  writeFileSync(path, [...samples, ...recent].map((s) => JSON.stringify({ ...s, at: new Date(s.at).toISOString() })).join("\n") + "\n", { mode: 0o600 })
  const st = new SampleStore(path, () => now)
  st.load()
  await st.flush()
  expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(kept.length)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("the window's pick and the last session's end are kept (0600); a bad file is no pick", async () => {
  const path = join(dir(), "pnl-window.json")
  expect(readWindowState(path)).toEqual({})
  await saveWindowState(path, { window: "18:00", sessionEnd: 1_791_000_000_000 }, Date.now())
  expect(readWindowState(path)).toEqual({ window: "18:00", sessionEnd: 1_791_000_000_000 })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  writeFileSync(path, '{"window":"later"}')
  expect(readWindowState(path)).toEqual({})
})

const SOL = "So11111111111111111111111111111111111111112"

test("paper P&L: the quotes' costs and proceeds, the tokens at the price book's prices, all ≈", () => {
  const prices: Record<string, number> = { [SOL]: 200, MOON: 0.5 }
  const p = paperPnl(
    [
      // 0.05 SOL ($10 at today's SOL) bought 30 MOON, now worth $15.
      { mint: "MOON", symbol: "MOON", tokens: 30, buys: 1, sells: 0, cost: { sol: 0.05 } },
      // Sold all of JUP: 0.02 SOL in for 0.03 SOL back.
      { mint: "JUP", tokens: 0, buys: 1, sells: 1, cost: { sol: 0 }, realized: { sol: 0.01 } },
    ],
    (m) => prices[m],
  )
  expect(p.positions).toEqual([{ mint: "MOON", symbol: "MOON", tokens: 30, costUsd: 10, valueUsd: 15, unrealizedUsd: 5 }])
  expect(p.realizedUsd).toBeCloseTo(2, 9)
  expect(p.unrealizedUsd).toBe(5)
  expect(p.totalUsd).toBeCloseTo(7, 9)
  // A token with no price: missing, never zero, and counted.
  const unpriced = paperPnl([{ mint: "NEW", tokens: 3, buys: 1, sells: 0, cost: { sol: 0.01 } }], (m) => prices[m])
  expect(unpriced).toMatchObject({ unrealizedUsd: null, totalUsd: null, unpriced: 1 })
  // A sell whose quote had no proceeds: what was realised isn't known.
  expect(paperPnl([{ mint: "X", tokens: 0, buys: 1, sells: 1, realizedUnknown: true }], (m) => prices[m]).realizedUsd).toBeNull()
})

test("the journal's filled live swaps in the window, newest first; paper and unfilled swaps aren't", () => {
  const card = (seq: number, opId: string, mode: string, kind = "swap") => ({ seq, at: "2026-10-30T09:00:00.000Z", type: "card.created", mode, agent: "agent-b", opId, kind, headline: `swap ${opId}`, value: { usd: 3, unvalued: false }, wallet: "W" })
  const done = (seq: number, opId: string, at: string) => ({ seq, at, type: "operation.succeeded", mode: "live", agent: "agent-b", opId })
  const rows = [
    card(1, "o1", "live"),
    card(2, "o2", "live"),
    card(3, "o3", "paper"),
    card(4, "o4", "live", "trade"),
    card(5, "o5", "live"),
    done(6, "o1", "2026-10-30T09:01:00.000Z"),
    done(7, "o2", "2026-10-30T12:00:00.000Z"),
    done(8, "o3", "2026-10-30T12:00:00.000Z"),
    done(9, "o4", "2026-10-30T12:00:00.000Z"),
  ] as unknown as JournalRow[]
  expect(journalSwaps(rows, null).map((s) => s.opId)).toEqual(["o2", "o1"])
  expect(journalSwaps(rows, Date.parse("2026-10-30T10:00:00.000Z"))).toEqual([{ at: Date.parse("2026-10-30T12:00:00.000Z"), agent: "agent-b", opId: "o2", title: "swap o2", usd: 3, wallet: "embedded" }])
})

/** A P&L book on a clock, against a scripted Candle. */
function book(opts: { wanted?: boolean; answers?: Record<string, unknown>; fail?: string; wait?: boolean; sessionEnd?: number } = {}) {
  let now = local(2026, 10, 30, 9)
  const calls: { agent: string; tool: string; at: number }[] = []
  let published = 0
  const samples = new SampleStore(join(dir(), "pnl.jsonl"), () => now)
  let window: PnlWindow = "24h"
  const answers = opts.answers ?? { FakeKey1: pnlA.answer, FakeKey2: pnlB.answer }
  const deps: PnlDeps = {
    call: async (agent, tool, args): Promise<ToolOutcome> => {
      calls.push({ agent, tool, at: now })
      if (opts.wait) return { kind: "error", code: "BUDGET_WAIT", retryable: true, body: {} }
      if (opts.fail) return { kind: "error", code: "UPSTREAM", retryable: true, body: { error: { message: opts.fail } } }
      if (tool === "candle_get_profile_trades") return { kind: "ok", result: args.keyPrefix === "FakeKey2" ? tradesB.answer : { trades: [] } }
      return { kind: "ok", result: answers[String(args.keyPrefix)] }
    },
    agents: () => [
      { agent: "agent-a", prefix: "FakeKey1" },
      { agent: "agent-b", prefix: "FakeKey2" },
    ],
    now: () => now,
    samples,
    wanted: () => opts.wanted ?? false,
    sessionEnd: () => opts.sessionEnd,
    window: () => window,
    rows: () => [],
    paper: () => ({}),
    priceOf: () => undefined,
    publish: () => published++,
  }
  const b = new PnlBook(deps)
  return {
    b,
    calls,
    samples,
    published: () => published,
    tick: (ms: number) => (now += ms),
    now: () => now,
    setWindow: (w: PnlWindow) => (window = w),
    setFail: (f: string | undefined) => (opts.fail = f),
    setWait: (w: boolean) => (opts.wait = w),
  }
}

test("each agent's own book is read every 5 minutes in the background, every minute with its fills while a P&L pane is on screen", async () => {
  const t = book()
  ;(t.b as unknown as { running: boolean }).running = true
  await t.b.step()
  expect(t.calls.map((c) => `${c.agent}:${c.tool}`)).toEqual(["agent-a:candle_get_profile_pnl", "agent-b:candle_get_profile_pnl"])
  t.tick(PNL_ON_SCREEN_MS)
  await t.b.step()
  expect(t.calls).toHaveLength(2)
  t.tick(PNL_BACKGROUND_MS - PNL_ON_SCREEN_MS)
  await t.b.step()
  expect(t.calls).toHaveLength(4)
  expect(t.b.demand()).toEqual({ perMin: 2 / 5, agents: 2 })

  const on = book({ wanted: true })
  ;(on.b as unknown as { running: boolean }).running = true
  await on.b.step()
  expect(on.calls.map((c) => c.tool).filter((x) => x === "candle_get_profile_trades")).toHaveLength(2)
  on.tick(PNL_ON_SCREEN_MS)
  await on.b.step()
  expect(on.calls).toHaveLength(8)
  expect(on.b.demand()).toEqual({ perMin: 4, agents: 2 })
  expect(on.b.view().trades.length).toBe(tradesB.answer.trades.length)
})

test("a fill: every agent's book is read again a few seconds after, not at its next turn", async () => {
  const t = book()
  ;(t.b as unknown as { running: boolean }).running = true
  await t.b.step()
  t.tick(MIN)
  t.b.afterFill()
  await t.b.step()
  expect(t.calls).toHaveLength(2)
  t.tick(PNL_AFTER_FILL_MS)
  await t.b.step()
  expect(t.calls).toHaveLength(4)
})

test("a fill Candle hasn't booked yet: the filling agent's book is read again at 20 s and 45 s, and no more once it shows", async () => {
  const unbooked = book()
  ;(unbooked.b as unknown as { running: boolean }).running = true
  await unbooked.b.step()
  unbooked.tick(MIN)
  unbooked.b.afterFill("agent-b")
  const filledAt = unbooked.now()
  unbooked.tick(PNL_AFTER_FILL_MS)
  await unbooked.b.step()
  expect(unbooked.calls).toHaveLength(4)
  for (const ms of PNL_FOLLOW_UP_MS) {
    unbooked.tick(filledAt + ms - unbooked.now())
    await unbooked.b.step()
  }
  // The same answer each time, so never booked: agent-b alone, twice more, then its own pace.
  expect(unbooked.calls.slice(4).map((c) => c.agent)).toEqual(["agent-b", "agent-b"])
  unbooked.tick(MIN)
  await unbooked.b.step()
  expect(unbooked.calls).toHaveLength(6)

  // Booked at the first read after the fill: the follow-ups stop.
  const answers: Record<string, unknown> = { FakeKey1: pnlA.answer, FakeKey2: pnlB.answer }
  const booked = book({ answers })
  ;(booked.b as unknown as { running: boolean }).running = true
  await booked.b.step()
  booked.tick(MIN)
  booked.b.afterFill("agent-b")
  answers.FakeKey2 = pnlA.answer
  booked.tick(PNL_AFTER_FILL_MS)
  await booked.b.step()
  booked.tick(PNL_FOLLOW_UP_MS.at(-1)!)
  await booked.b.step()
  expect(booked.calls).toHaveLength(4)
})

test("a failed read keeps the last book, with its age and Candle's words; a wait for the budget isn't a try", async () => {
  const t = book()
  ;(t.b as unknown as { running: boolean }).running = true
  await t.b.step()
  const readAt = t.now()
  t.tick(PNL_BACKGROUND_MS)
  t.setFail("upstream is down")
  await t.b.step()
  const a = t.b.view().agents.find((x) => x.agent === "agent-a")!
  expect(a.readAt).toBe(readAt)
  expect(a.book?.totals.totalUsd).toBeCloseTo(-1.353941, 6)
  expect(a.failed).toEqual({ at: t.now(), words: "upstream is down" })

  const w = book({ wait: true })
  ;(w.b as unknown as { running: boolean }).running = true
  await w.b.step()
  expect(w.calls).toHaveLength(2)
  w.tick(4_000)
  await w.b.step()
  expect(w.calls).toHaveLength(2)
  w.tick(1_000)
  w.setWait(false)
  await w.b.step()
  expect(w.calls).toHaveLength(4)
  expect(w.b.view().agents.every((x) => x.book !== null)).toBe(true)
})

test("the view: each source kept apart, and the window's figure moving with the books", async () => {
  const t = book()
  ;(t.b as unknown as { running: boolean }).running = true
  await t.b.step()
  const first = t.b.view()
  expect(first.figure).toMatchObject({ window: "24h", label: "24h", usd: 0 })
  expect(first.sum!.totalUsd).toBeCloseTo(-1.353941 - 8.5067403, 6)
  expect(first.samplesFrom).toBe(t.now())
  // A sell of agent-b's: its book moves up a dollar.
  const later = structuredClone(pnlB.answer)
  later.pnl.totalUsd += 1
  t.tick(PNL_BACKGROUND_MS)
  ;(t.b as unknown as { deps: PnlDeps }).deps.call = async (agent, tool, args) => ({ kind: "ok", result: args.keyPrefix === "FakeKey2" ? later : pnlA.answer })
  await t.b.step()
  const v = t.b.view()
  expect(v.figure.usd).toBeCloseTo(1, 9)
  expect(v.figure.agents["agent-b"]!.usd).toBeCloseTo(1, 9)
  expect(v.figure.agents["agent-a"]!.usd).toBe(0)
  // The window changed: a time of day after the first sample.
  t.setWindow("09:03")
  expect(t.b.view().figure).toMatchObject({ label: "since 09:03", usd: 0 })
})

test("the book's figure since last session, as the window, harness_pnl and the away note ask it, starts from the mark's own sample", async () => {
  const mark = local(2026, 10, 30, 8, 58)
  const t = book({ sessionEnd: mark })
  t.samples.add({ at: mark - 2 * MIN, agent: "agent-b", prefix: "FakeKey2", totalUsd: pnlB.answer.pnl.totalUsd - 3, realizedNetUsd: 0, unrealizedUsd: 0 })
  ;(t.b as unknown as { running: boolean }).running = true
  await t.b.step()
  t.setWindow("session")
  expect(t.b.view().figure).toMatchObject({ label: "since last session", short: false })
  expect(t.b.view().figure.agents["agent-b"]!.usd).toBeCloseTo(3, 9)
  expect(t.b.figure({ start: mark, label: "since last session", mark: true }).agents["agent-b"]!.usd).toBeCloseTo(3, 9)
  // The same start passed as a time is an ordinary window: agent-b's change runs from its first sample after it.
  expect(t.b.figure({ start: mark, label: "since 08:58" }).agents["agent-b"]!.usd).toBe(0)
})

test("a read someone asks for while the core's own first read is under way waits for it, and reads again if it brought no book", async () => {
  const mark = local(2026, 10, 30, 8, 58)
  const t = book({ sessionEnd: mark })
  t.samples.add({ at: mark - 2 * MIN, agent: "agent-b", prefix: "FakeKey2", totalUsd: pnlB.answer.pnl.totalUsd - 3, realizedNetUsd: 0, unrealizedUsd: 0 })
  const deps = (t.b as unknown as { deps: PnlDeps }).deps
  const plain = deps.call
  const held: (() => void)[] = []
  // A fresh core's background read, answered only once released.
  deps.call = (agent, tool, args, asked) => new Promise((done) => held.push(() => done(plain(agent, tool, args, asked))))
  ;(t.b as unknown as { running: boolean }).running = true
  const background = t.b.step()
  deps.call = plain
  let asked = false
  const now = t.b.readNow().then(() => (asked = true))
  await Promise.resolve()
  expect(asked).toBe(false)
  for (const go of held) go()
  await background
  await now
  expect(t.b.figure({ start: mark, label: "since last session", mark: true }).agents["agent-b"]!.usd).toBeCloseTo(3, 9)

  // The budget put the background read off: no book, so the asked read goes to Candle itself.
  const w = book({ wait: true })
  ;(w.b as unknown as { running: boolean }).running = true
  const put = w.b.step()
  w.setWait(false)
  await w.b.readNow()
  await put
  expect(w.b.view().agents.every((x) => x.book !== null)).toBe(true)
})

test("the chart's series: the agents' samples summed per bucket, with a gap where the core wasn't running", () => {
  const t0 = local(2026, 10, 30, 6)
  let now = t0
  const samples = store(
    [
      ["agent-a", t0, 1],
      ["agent-b", t0, 10],
      ["agent-a", t0 + 5 * MIN, 2],
      ["agent-b", t0 + 5 * MIN, 11],
      // Off for two hours.
      ["agent-a", t0 + 2 * HOUR, 3],
      ["agent-b", t0 + 2 * HOUR, 12],
    ],
    () => now,
  )
  now = t0 + 2 * HOUR + MIN
  const b = new PnlBook({
    call: async () => ({ kind: "ok", result: {} }),
    agents: () => [],
    now: () => now,
    samples,
    wanted: () => false,
    sessionEnd: () => undefined,
    window: () => "24h",
    rows: () => [],
    paper: () => ({}),
    priceOf: () => undefined,
    publish: () => {},
  })
  const points = b.series(t0, 25)
  expect(points[0]!.usd).toBe(11)
  expect(points.find((p) => p.at >= t0 + 5 * MIN && p.at < t0 + 10 * MIN)?.usd).toBe(13)
  expect(points.some((p) => p.usd === null)).toBe(true)
  expect(points.at(-1)).toEqual({ at: now, usd: 15 })
  // Gaps are wider than the samples' pace.
  expect(points.filter((p) => p.usd === null).length).toBeGreaterThan(points.length / 2)
  expect(GAP_MS).toBeGreaterThan(2 * 5 * MIN)
})

test("no figure sums Candle's with the Candle Harness's: swaps are listed beside the books, paper apart, and neither moves the total", async () => {
  const t = book()
  ;(t.b as unknown as { running: boolean }).running = true
  const deps = (t.b as unknown as { deps: PnlDeps }).deps
  await t.b.step()
  const plain = t.b.view()
  deps.rows = () =>
    [
      { seq: 1, at: new Date(t.now()).toISOString(), type: "card.created", mode: "live", agent: "agent-b", opId: "o1", kind: "swap", headline: "swap 1 SOL → CNDL", value: { usd: 200, unvalued: false }, wallet: "W" },
      { seq: 2, at: new Date(t.now()).toISOString(), type: "operation.succeeded", mode: "live", agent: "agent-b", opId: "o1" },
    ] as unknown as JournalRow[]
  deps.paper = () => ({ "agent-a": [{ mint: "MOON", tokens: 10, buys: 1, sells: 0, cost: { sol: 1 } }] })
  deps.priceOf = (m) => (m === SOL ? 200 : m === "MOON" ? 100 : undefined)
  const v = t.b.view()
  expect(v.swaps).toHaveLength(1)
  expect(v.paper["agent-a"]!.totalUsd).toBe(800)
  expect(v.sum).toEqual(plain.sum)
  expect(v.figure).toEqual(plain.figure)
  expect(v.wallets).toEqual(plain.wallets)
  // An agent the journal holds paper rows of, since taken out of config, isn't the Candle Harness's.
  deps.paper = () => ({ "agent-a": [{ mint: "MOON", tokens: 10, buys: 1, sells: 0, cost: { sol: 1 } }], gone: [{ mint: "MOON", tokens: 5, buys: 1, sells: 0, cost: { sol: 1 } }] })
  expect(Object.keys(t.b.view().paper)).toEqual(["agent-a"])
})

test("the last session's end after a core that died with the main view attached: its last row, when later than the last close", () => {
  const rows = [
    { seq: 1, at: "2026-10-30T08:00:00.000Z", type: "core.started" },
    { seq: 2, at: "2026-10-30T08:00:01.000Z", type: "client.attached", role: "view", clientId: "v1", clientName: "candle-harness view" },
    { seq: 3, at: "2026-10-30T09:00:00.000Z", type: "client.detached", role: "view", clientId: "v1" },
    { seq: 4, at: "2026-10-30T10:00:00.000Z", type: "client.attached", role: "view", clientId: "v2", clientName: "candle-harness view" },
    { seq: 5, at: "2026-10-30T11:30:00.000Z", type: "agent.turn", agent: "a" },
    // Killed here: no detach. The next core starts later.
    { seq: 6, at: "2026-10-30T15:00:00.000Z", type: "core.started" },
    { seq: 7, at: "2026-10-30T15:00:02.000Z", type: "client.attached", role: "view", clientId: "v3", clientName: "candle-harness view" },
  ] as unknown as JournalRow[]
  expect(lastSessionEnd(rows)).toBe(Date.parse("2026-10-30T11:30:00.000Z"))
  // At a core's start, before its own core.started: the run before it ended with the view attached.
  expect(lastSessionEnd(rows.slice(0, 5), { runEnded: true })).toBe(Date.parse("2026-10-30T11:30:00.000Z"))
  expect(lastSessionEnd(rows.slice(0, 5))).toBe(Date.parse("2026-10-30T09:00:00.000Z"))
  // A core that stopped after the view closed: the close stands, whatever ran on after it.
  const ranOn = [...rows.slice(0, 3), { seq: 4, at: "2026-10-30T12:00:00.000Z", type: "agent.turn" }, { seq: 5, at: "2026-10-30T15:00:00.000Z", type: "core.started" }] as unknown as JournalRow[]
  expect(lastSessionEnd(ranOn)).toBe(Date.parse("2026-10-30T09:00:00.000Z"))
  expect(lastSessionEnd(ranOn.slice(0, 4), { runEnded: true })).toBe(Date.parse("2026-10-30T09:00:00.000Z"))
})

test("a bot's live fills by signature, for Trades' by bot; a paper or unbot fill isn't one", () => {
  const r = (seq: number, type: string, extra: Record<string, unknown>) => ({ seq, at: "2026-11-06T09:00:00.000Z", type, mode: "live", ...extra }) as unknown as JournalRow
  const rows = [
    r(1, "card.created", { opId: "a", bot: "conf" }),
    r(2, "operation.succeeded", { opId: "a", result: { job: { signature: "sigA" } } }),
    r(3, "card.created", { opId: "b" }),
    r(4, "operation.succeeded", { opId: "b", result: { job: { signature: "sigB" } } }),
    r(5, "card.created", { opId: "c", bot: "conf", mode: "paper" }),
    r(6, "operation.succeeded", { opId: "c", result: { job: { signature: "sigC" } } }),
  ]
  expect(botSignatures(rows)).toEqual({ sigA: "conf" })
})
