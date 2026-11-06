// The Trade tab's topics, end to end through a real core and the fake Candle server: `portfolio` (by
// wallet, with paper books), `market` (the token pane) and `activity` (lines from the journal).
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { payableWallets, payerContextFrom, resolvePayer, type WalletsTopic } from "./agent-wallets"
import type { PortfolioView } from "./portfolio-view"
import type { TokenView } from "./token-watch"

const MOON = "MoonFake11111111111111111111111111111111111"
const WALLET = "WalletFake111111111111111111111111111111111"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

async function attached(): Promise<{ c: TestCore; view: TestClient }> {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  const sub = await view.request("subscribe", { topics: ["portfolio", "market", "activity"] })
  expect(sub.error).toBeUndefined()
  return { c, view }
}
const latest = <T,>(view: TestClient, topic: string): T | undefined => view.events.filter((e) => e.topic === topic).at(-1)?.data as T | undefined

test("portfolio: the embedded wallet once, with both agents on it and MOON valued", async () => {
  const { view } = await attached()
  await until(() => (latest<PortfolioView>(view, "portfolio")?.wallets.length ?? 0) > 0)
  // The row carries no symbol, as on the real server; a fresh core reads MOON's market once to name it
  // (without it the input line couldn't take `sell 100% ORE` on a fresh core).
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets[0]?.tokens?.[0]?.symbol === "MOON")
  const p = latest<PortfolioView>(view, "portfolio")!
  expect(p.wallets).toHaveLength(1)
  expect(p.wallets[0]).toMatchObject({ address: WALLET, agents: ["momentum", "swing"], sol: { amount: 2, usd: 300 } })
  expect(p.wallets[0]!.tokens![0]).toMatchObject({ mint: MOON, symbol: "MOON", amount: 12345.678901 })
  expect(p.deposit).toBe(WALLET)
})

test("a harness may not read the portfolio topic", async () => {
  const c = await startTestCore()
  cores.push(c)
  const { client } = await c.harness()
  const sub = await client.request("subscribe", { topics: ["portfolio"] })
  expect(sub.error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
})

test("market: trending before any token, then the token a card was proposed on", async () => {
  const { view } = await attached()
  await until(() => (latest<TokenView>(view, "market")?.trending?.rows.length ?? 0) > 0)
  expect(latest<TokenView>(view, "market")!.trending!.rows[0]).toMatchObject({ mint: MOON, symbol: "MOON" })
  const card = await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })
  expect(card.error).toBeUndefined()
  await until(() => latest<TokenView>(view, "market")?.followed?.mint === MOON)
  const m = latest<TokenView>(view, "market")!
  expect(m.market).toMatchObject({ symbol: "MOON", priceUsd: 0.63, marketCap: 1_000_000 })
  expect(m.check).toMatchObject({ summary: "incomplete", unknown: ["sellability"] })
})

test("market: the token pane follows a token the agent asked Candle about", async () => {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["market"] })
  const { client } = await c.harness(view)
  const r = await client.request("tools.call", { name: "candle_token_forensics", args: { chain: "solana", mint: MOON } })
  expect(r.error).toBeUndefined()
  await until(() => latest<TokenView>(view, "market")?.followed?.mint === MOON)
})

test("market: the pane follows a Solana token the agent read on Hacc, which names it address, and never a Hood one", async () => {
  const { startFakeHacc } = await import("../../test/fake-hacc")
  const { AGENT_KEY } = await import("../../test/core-fixture")
  const hacc = startFakeHacc({ keys: [AGENT_KEY] })
  try {
    const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["market"] })
    const { client } = await c.harness(view, "momentum")
    await until(() => latest<TokenView>(view, "market") !== undefined)
    const hood = await client.request("tools.call", { name: "hacc_token", args: { view: "market", address: MOON, chain: "hood" } })
    expect(hood.error).toBeUndefined()
    await Bun.sleep(300)
    expect(latest<TokenView>(view, "market")?.followed ?? null).toBeNull()
    // A wallet's address on hacc_wallets is never a token.
    await client.request("tools.call", { name: "hacc_wallets", args: { view: "stats", address: WALLET } })
    await Bun.sleep(300)
    expect(latest<TokenView>(view, "market")?.followed ?? null).toBeNull()
    const r = await client.request("tools.call", { name: "hacc_token", args: { view: "top_traders", address: MOON, chain: "solana" } })
    expect(r.error).toBeUndefined()
    await until(() => latest<TokenView>(view, "market")?.followed?.mint === MOON)
  } finally {
    hacc.stop()
  }
})

test("market: the followed token's last hour from Hacc, read once with an agent's own key", async () => {
  const { startFakeHacc } = await import("../../test/fake-hacc")
  const { AGENT_KEY } = await import("../../test/core-fixture")
  const hacc = startFakeHacc({ keys: [AGENT_KEY] })
  try {
    const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["market"] })
    const { client } = await c.harness(view)
    await client.request("tools.call", { name: "candle_token_forensics", args: { chain: "solana", mint: MOON } })
    await until(() => latest<TokenView>(view, "market")?.historyRead != null)
    expect(latest<TokenView>(view, "market")!.historyRead).toMatchObject({ source: "hacc" })
    const reads = hacc.calls.filter((call) => call.path.endsWith("/history"))
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ method: "GET", path: `/v1/market/token/${MOON}/history`, auth: `Bearer ${AGENT_KEY}`, query: { resolution: "1m", include_candles: "true" } })
    // From a whole minute, 65 minutes back: the chart's span.
    const from = Date.parse(reads[0]!.query.from!)
    expect(from % 60_000).toBe(0)
    expect(Date.now() - from).toBeGreaterThanOrEqual(65 * 60_000)
    expect(Date.now() - from).toBeLessThan(67 * 60_000)
  } finally {
    hacc.stop()
  }
})

test("market: a key Hacc refuses passes the history read to the next agent's at once (seen live)", async () => {
  const { startFakeHacc } = await import("../../test/fake-hacc")
  const { AGENT_KEY, SWING_KEY } = await import("../../test/core-fixture")
  const hacc = startFakeHacc({ keys: [SWING_KEY] }) // the active agent's key isn't one Hacc takes
  try {
    const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["market"] })
    const { client } = await c.harness(view)
    await client.request("tools.call", { name: "candle_token_forensics", args: { chain: "solana", mint: MOON } })
    await until(() => latest<TokenView>(view, "market")?.historyRead != null)
    expect(latest<TokenView>(view, "market")!.historyRead).toMatchObject({ source: "hacc" })
    const reads = hacc.calls.filter((call) => call.path.endsWith("/history")).map((call) => call.auth)
    expect(reads).toEqual([`Bearer ${AGENT_KEY}`, `Bearer ${SWING_KEY}`])
  } finally {
    hacc.stop()
  }
})

test("market: with Hacc off, the chart is the core's own samples, and says why", async () => {
  const c = await startTestCore({}, { config: { hacc: { enabled: false } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["market"] })
  const { client } = await c.harness(view)
  await client.request("tools.call", { name: "candle_token_forensics", args: { chain: "solana", mint: MOON } })
  await until(() => latest<TokenView>(view, "market")?.historyRead != null)
  expect(latest<TokenView>(view, "market")!.historyRead).toMatchObject({ source: "samples", words: "Hacc is off in this Candle Harness's config ([hacc] enabled = false)." })
  expect(latest<TokenView>(view, "market")!.samples).toHaveLength(1)
})

test("activity: the snapshot, then a line for each user-facing row, the user's typed card as theirs", async () => {
  const { view } = await attached()
  expect(view.events.find((e) => e.topic === "activity")?.data).toMatchObject({ killReport: null, lines: [] })
  await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })
  await until(() => view.events.some((e) => e.topic === "activity" && (e.data as { kind?: string }).kind === "line"))
  const line = view.events.find((e) => e.topic === "activity" && (e.data as { kind?: string }).kind === "line")!.data as { entry: { text: string; agent: string } }
  expect(line.entry.text).toStartWith("you proposed BUY 0.01 SOL")
  expect(line.entry.agent).toBe("momentum")
})

test("a buy typed in paper mode runs as a paper trade, and lands in that agent's paper book", async () => {
  const { view } = await attached()
  await view.request("mode.set", { mode: "paper" })
  const r = await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true, agent: "swing" })
  expect(r.error).toBeUndefined()
  expect((r.result as { paper?: { isError?: boolean } }).paper?.isError).not.toBe(true)
  await until(() => (latest<PortfolioView>(view, "portfolio")?.paper.swing?.length ?? 0) > 0)
  expect(latest<PortfolioView>(view, "portfolio")!.paper.swing![0]).toMatchObject({ mint: MOON, buys: 1 })
  expect(latest<PortfolioView>(view, "portfolio")!.paper.momentum).toBeUndefined()
})

test("portfolio: a TEE wallet shows once, with the agent whose key it's bound to; that agent alone can pay from it", async () => {
  const tee = { id: "teeid1", address: "TeeFake111111111111111111111111111111111111", label: "bot-wallet", boundKeyPrefix: "Momentum", lamports: "500000000" }
  const script = { teeWallets: [tee] }
  const c = await startTestCore({}, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: script, swing: script } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  await until(() => latest<PortfolioView>(view, "portfolio")?.wallets.some((w) => w.kind === "tee" && w.agents.length > 0) ?? false)
  const wallets = latest<PortfolioView>(view, "portfolio")!.wallets
  expect(wallets.map((w) => [w.kind, w.agents])).toEqual([
    ["embedded", ["momentum", "swing"]],
    ["tee", ["momentum"]],
  ])
  expect(wallets[1]).toMatchObject({ label: "bot-wallet", active: true, sol: { amount: 0.5 } })
  expect(c.core.wallets.payer("momentum", "bot-wallet")).toMatchObject({ ok: true, kind: "tee", address: tee.address })
  expect(c.core.wallets.payer("swing", "bot-wallet")).toMatchObject({ ok: false, message: expect.stringContaining("it's bound to momentum's key") })
})

test("wallets: what each agent can pay from, enough for a view to resolve `from <wallet>` by the core's rule", async () => {
  const tee = { id: "teeid1", address: "TeeFake111111111111111111111111111111111111", label: "bot-wallet", boundKeyPrefix: "Momentum", lamports: "500000000" }
  const script = { teeWallets: [tee] }
  const c = await startTestCore({}, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: script, swing: script } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["wallets"] })
  await until(() => (latest<WalletsTopic>(view, "wallets")?.agents.momentum?.payable.tee.length ?? 0) > 0)
  const topic = latest<WalletsTopic>(view, "wallets")!
  expect(payableWallets(topic.agents.momentum!.payable).map((w) => w.name)).toEqual(["embedded", "bot-wallet"])
  expect(payableWallets(topic.agents.swing!.payable).map((w) => w.name)).toEqual(["embedded"])
  expect(topic.boundTo).toEqual({ [tee.address]: "momentum" })
  // The view's answer is the core's, word for word.
  const fromView = resolvePayer(payerContextFrom(topic, "swing")!, "bot-wallet")
  expect(fromView).toEqual(c.core.wallets.payer("swing", "bot-wallet"))
  // A harness can't subscribe to it.
  const { client } = await c.harness(view)
  expect((await client.request("subscribe", { topics: ["wallets"] })).error).toBeDefined()
})
