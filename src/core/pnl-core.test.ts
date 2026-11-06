// P&L end to end through a real core and the fake Candle in Candle's recorded shapes: each
// agent's book read with its own key, the `pnl` topic, the status bar's figure, the window setting,
// harness_pnl, the samples across a restart, and the main view's close for "since last session".
import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import pnlA from "../../test/fixtures/candle-recorded/feeds-pnl/pnl-agent-a.json"
import pnlB from "../../test/fixtures/candle-recorded/feeds-pnl/pnl-agent-b.json"
import tradesB from "../../test/fixtures/candle-recorded/feeds-pnl/trades-agent-b.json"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, type TestHomeOptions, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { PnlView } from "./pnl"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

/** momentum holds agent-a's book (FakeKey1), swing agent-b's (FakeKey2), each answered by its own child. */
const BOOKS: TestHomeOptions = {
  keys: { momentum: prefixedKey("FakeKey1"), swing: prefixedKey("FakeKey2") },
  candle: {
    momentum: { pnl: { FakeKey1: pnlA.answer } },
    swing: { pnl: { FakeKey2: pnlB.answer }, trades: { FakeKey2: tradesB.answer.trades } },
  },
}

async function core(home: TestHomeOptions = BOOKS): Promise<TestCore> {
  const c = await startTestCore({}, home)
  cores.push(c)
  return c
}
const latest = <T,>(view: TestClient, topic: string): T | undefined => view.events.filter((e) => e.topic === topic).at(-1)?.data as T | undefined
const textOf = (r: { result?: unknown }) => JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
const status = async (view: TestClient) => (await view.request("core.status", {})).result as { pnl: { window: string; usd: number | null; label: string; from: number | null; short: boolean } }

test("each agent's book is read with its own key as the core starts, and the status bar's figure names its window", async () => {
  const c = await core()
  await until(() => c.core.pnl.agentsView().every((a) => a.book !== null))
  const view = await c.view()
  const s = await status(view)
  // One read in the window: no change yet, and it runs from that read.
  expect(s.pnl).toMatchObject({ usd: 0, label: "24h", short: true })
  const books = c.core.pnl.agentsView()
  expect(books.find((a) => a.agent === "momentum")!.book!.totals.totalUsd).toBeCloseTo(-1.353941, 6)
  expect(books.find((a) => a.agent === "swing")!.book!.positions).toHaveLength(2)
  // Each read went through the agent's own key's budget.
  const use = (await view.request("core.status", {})).result as { budget: { keys: { agent: string; background: number }[] } }
  expect(use.budget.keys.every((k) => k.background >= 1)).toBe(true)
  // A sample each, in the state folder, 0600.
  await c.core.pnl.view()
  await until(() => readFileSync(c.p.pnlSamples, "utf8").trim().split("\n").length === 2)
  expect(statSync(c.p.pnlSamples).mode & 0o777).toBe(0o600)
})

test("the pnl topic: the books, the wallets summed, the fills while subscribed, and each source apart", async () => {
  const c = await core()
  const view = await c.view()
  await view.request("subscribe", { topics: ["pnl"] })
  await until(() => (latest<PnlView>(view, "pnl")?.trades.length ?? 0) > 0)
  const v = latest<PnlView>(view, "pnl")!
  expect(v.agents.map((a) => a.agent).sort()).toEqual(["momentum", "swing"])
  expect(v.sum!.totalUsd).toBeCloseTo(-1.353941 - 8.5067403, 5)
  // The shared embedded wallet: both agents' books on one row.
  expect(v.wallets.find((w) => w.agents.length === 2)).toBeDefined()
  // swing's book holds rounds momentum opened: named by agent.
  expect(v.agents.find((a) => a.agent === "swing")!.book!.crossed[0]!.openedBy).toBe("momentum")
  expect(v.trades.every((t) => t.agent === "swing")).toBe(true)
  expect(v.window).toBe("24h")
  // A harness can't subscribe to it: it's the person's screen.
  const { client } = await c.harness()
  expect((await client.request("subscribe", { topics: ["pnl"] })).error).toBeDefined()
})

test("the P&L window: set by a view, kept across a restart, journalled; refused to a harness; config is where a fresh install starts", async () => {
  const c = await core({ ...BOOKS, config: { pnl: { window: "midnight" } } })
  const view = await c.view()
  expect((await status(view)).pnl.label).toBe("since midnight")
  expect((await view.request("pnl.window", { window: "yesterday" })).error).toBeDefined()
  expect((await view.request("pnl.window", { window: "18:00" })).result).toEqual({ window: "18:00" })
  // The window itself too: a view off the P&L tab holds no `pnl` topic.
  expect((await status(view)).pnl).toMatchObject({ window: "18:00", label: "since 18:00" })
  expect(c.core.journal.rows().some((r) => r.type === "pnl.window" && r.window === "18:00")).toBe(true)
  expect(JSON.parse(readFileSync(c.p.pnlWindow, "utf8")).window).toBe("18:00")
  expect(statSync(c.p.pnlWindow).mode & 0o777).toBe(0o600)
  const { client } = await c.harness()
  expect((await client.request("pnl.window", { window: "24h" })).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })

  // A restart on a home that has a pick keeps it.
  const again = await core({ ...BOOKS, config: { pnl: { window: "midnight" } }, before: (p) => writeFileSync(p.pnlWindow, readFileSync(c.p.pnlWindow), { mode: 0o600 }) })
  expect((await status(await again.view())).pnl.label).toBe("since 18:00")
})

test("samples from before a restart are the window's start, and the figure says the change since", async () => {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const c = await core({
    ...BOOKS,
    before: (p) =>
      writeFileSync(
        p.pnlSamples,
        `${JSON.stringify({ at: hourAgo, agent: "momentum", prefix: "FakeKey1", totalUsd: -2.353941, realizedNetUsd: -2.35, unrealizedUsd: 0 })}\n${JSON.stringify({ at: hourAgo, agent: "swing", prefix: "FakeKey2", totalUsd: -8.5067403, realizedNetUsd: -0.37, unrealizedUsd: -8.13 })}\n`,
        { mode: 0o600 },
      ),
  })
  await until(() => c.core.pnl.agentsView().every((a) => a.book !== null))
  const s = await status(await c.view())
  // momentum's book is a dollar up on its sample an hour ago, swing's unchanged.
  expect(s.pnl.usd).toBeCloseTo(1, 6)
  expect(s.pnl.from).toBe(Date.parse(hourAgo))
  expect(s.pnl.short).toBe(true) // the samples start an hour ago, not 24
})

test("harness_pnl answers from the status bar's figure, names the window, and takes the agent's own since", async () => {
  const c = await core()
  await until(() => c.core.pnl.agentsView().every((a) => a.book !== null))
  const { client } = await c.harness()
  const tools = (await client.request("tools.list", {})).result as { tools: { name: string; description: string }[] }
  const tool = tools.tools.find((t) => t.name === "harness_pnl")!
  expect(tool.description).toMatch(/person's P&L window setting/)
  const plain = textOf(await client.request("tools.call", { name: "harness_pnl", args: {} }))
  expect(plain).toMatchObject({ success: true, changeUsd: 0, setting: "the person's P&L window, 24h" })
  expect(String(plain.window)).toMatch(/where the Candle Harness's samples start/)
  expect((plain.agents as { agent: string; nowTotalUsd: number }[]).find((a) => a.agent === "swing")!.nowTotalUsd).toBeCloseTo(-8.51, 2)
  const since = textOf(await client.request("tools.call", { name: "harness_pnl", args: { since: "7d" } }))
  expect(since.setting).toBeUndefined()
  const bad = await client.request("tools.call", { name: "harness_pnl", args: { since: "tuesday" } })
  expect(JSON.stringify(bad.result)).toMatch(/isn't a window the Candle Harness reads/)
})

test("a fill reads every agent's book again within seconds", async () => {
  const c = await core()
  await until(() => c.core.pnl.agentsView().every((a) => a.book !== null))
  await c.core.journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_fake" })
  const slots = (c.core.pnl as unknown as { slots: Map<string, { retryAt?: number }> }).slots
  for (const agent of ["momentum", "swing"]) expect(slots.get(agent)!.retryAt! - Date.now()).toBeLessThanOrEqual(5_000)
})

test("since last session runs from the main view's close, kept in the state file; a popped view's close isn't one", async () => {
  const c = await core()
  const popped = await c.connect()
  const token = readFileSync(c.p.viewToken, "utf8").trim()
  await popped.request("core.hello", { protocol: 1, token, clientName: "candle-harness view --pane signals" }).catch(() => undefined)
  popped.close()
  await Bun.sleep(100)
  expect(() => readFileSync(c.p.pnlWindow, "utf8")).toThrow()
  const main = await c.view()
  const closedAt = Date.now()
  main.close()
  await until(() => {
    try {
      return JSON.parse(readFileSync(c.p.pnlWindow, "utf8")).sessionEnd !== undefined
    } catch {
      return false
    }
  })
  const state = JSON.parse(readFileSync(c.p.pnlWindow, "utf8"))
  expect(Date.parse(state.sessionEnd)).toBeGreaterThanOrEqual(closedAt - 1000)
  // No window was picked, so none is kept: config.toml still decides it.
  expect(state.window).toBeUndefined()
  const view = await c.view()
  await view.request("pnl.window", { window: "session" })
  expect((await status(view)).pnl.label).toBe("since last session")
})

test("each agent's tools carry its own key prefix, so its own trades read back", async () => {
  const c = await core()
  type Tool = { name: string; inputSchema: { properties?: Record<string, { description?: string }> } }
  const prefixOf = async (agent: string) => {
    const { client } = await c.harness(undefined, agent)
    const tools = ((await client.request("tools.list", {})).result as { tools: Tool[] }).tools
    return { client, words: (name: string) => tools.find((t) => t.name === name)!.inputSchema.properties!.keyPrefix!.description! }
  }
  const momentum = await prefixOf("momentum")
  for (const name of ["candle_get_profile_trades", "candle_get_profile_pnl", "candle_get_profile_wallets"]) {
    expect(momentum.words(name)).toEndWith("Your own key's prefix is FakeKey1. Candle answers a prefix it doesn't know with an empty result, so never guess one.")
  }
  const swing = await prefixOf("swing")
  expect(swing.words("candle_get_profile_trades")).toContain("FakeKey2")
  expect(swing.words("candle_get_profile_trades")).not.toContain("FakeKey1")
  const trades = textOf(await swing.client.request("tools.call", { name: "candle_get_profile_trades", args: { keyPrefix: "FakeKey2" } })) as { trades: unknown[] }
  expect(trades.trades.length).toBeGreaterThan(0)
})
