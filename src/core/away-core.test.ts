// While you were away, through a real core and the fake Candle: a past session left in the
// journal, the main view opening on it, `away.get` and the `away` topic, Candle's fills matched to the Candle Harness's
// own by id, a second view and a restart showing the same summary, and a harness refused it.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, type TestHomeOptions, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { AwayView } from "./away"
import type { Paths } from "../paths"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const ACCOUNT = "acct_awaycoretest0001"
const MOON = "MoonFake11111111111111111111111111111111111"
const NOW = Date.now()
const MIN = 60_000
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString()

/** The last session: opened 3 hours ago, closed 2 hours ago; then a turn ran on and traded without a card; the core idled out. */
function pastSession(p: Paths): void {
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(p.stateDir, "account"), `${ACCOUNT}\n`, { mode: 0o600 })
  const rows: Record<string, unknown>[] = [
    { at: iso(180), type: "core.started", mode: "live", agents: ["momentum"] },
    { at: iso(180), type: "client.attached", mode: "live", role: "view", clientId: "old-view", clientName: "view" },
    { at: iso(121), type: "agent.turn_started", mode: "live", agent: "momentum", turnId: "t1", engine: "claude-code" },
    { at: iso(120), type: "client.detached", mode: "live", role: "view", clientId: "old-view" },
    { at: iso(119), type: "card.created", mode: "live", agent: "momentum", cardId: "card_1", opId: "op-away-1", kind: "trade", tool: "candle_trade", mint: MOON, side: "buy", role: "harness", title: "a trade", headline: "BUY $1.00 of MOON", value: { usd: 1 }, wallet: "embedded" },
    { at: iso(119), type: "card.approved", mode: "live", agent: "momentum", cardId: "card_1", opId: "op-away-1", how: "inside-limits" },
    { at: iso(119), type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-away-1", tool: "candle_trade" },
    { at: iso(118.9), type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op-away-1", result: { job: { signature: "sig-harness" } } },
    { at: iso(118), type: "agent.turn", mode: "live", agent: "momentum", turnId: "t1", outcome: "done", user: "buy a dollar of MOON", reply: "Bought, without a card.", tools: ["candle_trade"] },
    { at: iso(113), type: "core.stopped", mode: "live", reason: "idle" },
  ]
  writeFileSync(p.journal, rows.map((r, i) => `${JSON.stringify({ seq: i + 1, account: ACCOUNT, ...r })}\n`).join(""), { mode: 0o600 })
  // The last P&L sample before the close, two minutes ahead of it: the book was $0.10 down then, and is flat now
  // (the fake's empty book), so the gap, with the core stopped for most of it, made $0.10.
  writeFileSync(p.pnlSamples, `${JSON.stringify({ at: iso(122), agent: "momentum", prefix: "FakeKey1", totalUsd: -0.1, realizedNetUsd: -0.1, unrealizedUsd: 0 })}\n`, { mode: 0o600 })
}

const fill = (minutesAgo: number, o: Record<string, unknown>) => ({ mint: MOON, side: "buy", status: "confirmed", usdValue: 1, feeUsd: 0.01, chain: "solana", createdAt: NOW - minutesAgo * MIN, payerWallet: "WalletFake811111111111111111111111111111111", ...o })
const HOME: TestHomeOptions = {
  keys: { momentum: prefixedKey("FakeKey1") },
  candle: {
    momentum: {
      trades: {
        FakeKey1: [
          // Made from the CLI an hour ago, outside the Candle Harness.
          fill(60, { side: "sell", usdValue: 0.9, signature: "sig-cli", clientTradeId: "c11a0000-0000-4000-8000-000000000001" }),
          // The Candle Harness's own, by the id the core sent it under.
          fill(118.95, { signature: "sig-harness", clientTradeId: "op-away-1" }),
          // Before the last session closed.
          fill(150, { signature: "sig-old", clientTradeId: "c11a0000-0000-4000-8000-000000000002" }),
        ],
      },
    },
  },
  before: pastSession,
}

const latest = (view: TestClient) => view.events.filter((e) => e.topic === "away").at(-1)?.data as AwayView | undefined
const settled = (v: AwayView | undefined) => !!v?.summary && v.summary.outside.state !== "reading" && v.summary.pnl.state !== "reading" && v.summary.signals.state !== "reading"

test("the main view opens on a past session's gap: the turn that ran on, the trade without a card, and the CLI's fill outside the Candle Harness", async () => {
  const c = await startTestCore({}, HOME)
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["away"] })
  await until(() => settled(latest(view)))
  const s = latest(view)!.summary!
  expect(s.from).toBe(Date.parse(iso(120)))
  expect(s.forView).toBeDefined()
  expect(s.coreDown).toHaveLength(1)
  expect(s.coreDown[0]!.from).toBe(Date.parse(iso(113)))
  expect(s.turns).toHaveLength(1)
  expect(s.trades).toEqual([expect.objectContaining({ outcome: "filled", withoutCard: true, agent: "momentum", usd: 1 })])
  // The CLI's sell is outside; the Candle Harness's buy, with its id, isn't; the one before the close isn't the gap's.
  expect(s.outside.agents).toEqual([expect.objectContaining({ agent: "momentum", state: "read", claimed: 0, maybe: [] })])
  expect(s.outside.agents[0]!.fills.map((f) => f.signature)).toEqual(["sig-cli"])
  expect(s.pnl.state).toBe("read")
  // P&L runs from the close's own sample, across the hours the core was stopped, not from the restart.
  expect(s.pnl).toMatchObject({ label: "since last session", from: Date.parse(iso(122)), short: false })
  expect(s.pnl.usd).toBeCloseTo(0.1, 9)
  expect(s.happened).toBe(true)
  // away.get is the same, and the file is 0600.
  const got = (await view.request("away.get", {})).result as AwayView
  expect(got.summary!.id).toBe(s.id)
  await until(() => {
    try {
      return JSON.parse(readFileSync(c.p.awayState, "utf8")).summary.outside.state === "read"
    } catch {
      return false
    }
  })
  expect(statSync(c.p.awayState).mode & 0o777).toBe(0o600)

  // A second view, while the first is open, shows the same one: no new gap.
  const second = await c.view()
  expect(((await second.request("away.get", {})).result as AwayView).summary!.id).toBe(s.id)
  // The agent reads its own history with harness_history; the Away summary is the person's.
  const { client } = await c.harness()
  expect((await client.request("away.get", {})).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
  expect((await client.request("subscribe", { topics: ["away"] })).error).toBeDefined()
})

test("a restart shows the same summary; a reopen within 10 minutes leaves it", async () => {
  const c = await startTestCore({}, HOME)
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["away"] })
  await until(() => settled(latest(view)))
  const first = latest(view)!.summary!
  // Closed and opened again at once: under 10 minutes, so the same summary.
  view.close()
  await until(() => c.core.server.viewCount() === 0)
  const again = await c.view()
  await Bun.sleep(100)
  expect(((await again.request("away.get", {})).result as AwayView).summary!.id).toBe(first.id)
  await c.close()
  cores.splice(cores.indexOf(c), 1)

  // The same home, a new core: the state file holds it.
  const next = await startTestCore({}, {
    ...HOME,
    before: (p) => {
      mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
      for (const file of [join(c.p.stateDir, "account"), c.p.journal, c.p.awayState]) writeFileSync(file.replace(c.p.stateDir, p.stateDir), readFileSync(file), { mode: 0o600 })
    },
  })
  cores.push(next)
  const v = await next.view()
  // This core's own gap (since the last close, seconds ago) is short, so the kept one shows.
  await Bun.sleep(100)
  const kept = ((await v.request("away.get", {})).result as AwayView).summary
  expect(kept?.id).toBe(first.id)
})
