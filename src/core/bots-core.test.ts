// Rules bots on a real core: the methods and the topic are a view's, never a harness's; stopping, resuming,
// flattening and removing are the main view's; the doctor changes nothing; a Free plan shows the gate and a
// plan that ends holds every bot's entries, read in the core's own five-minute refresh; a bot keeps the core
// up and says so; and a restart keeps each bot as it was.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { connectTestClient } from "../../test/core-test-client"
import { PROTOCOL_VERSION } from "../shared/rpc"
import type { BotProposal, BotsTopic } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import { DOCTOR_CLIENT } from "./client"
import { startCore } from "./core-main"
import { readViewToken } from "./tokens"
import { botChecks } from "../setup/doctor"

const DEFINITION = {
  chain: "solana",
  entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000 } },
  exit: { take_profit_pct: 100, stop_loss_pct: 40 },
  sizing: { usd_per_trade: 2, max_concurrent: 4 },
}
const NAME = "confluence-small"
const PROPOSAL: BotProposal = { name: NAME, definition: DEFINITION, run: { agent: "momentum", wallet: "embedded", mode: "paper" } }
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())
const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

/** Saved as an approved card saves it, once the agent's wallets are read. */
async function save(c: TestCore, p: BotProposal = PROPOSAL) {
  await until(() => {
    try {
      c.core.bots.check(p, p.run.agent)
      return true
    } catch {
      return false
    }
  })
  return c.core.bots.save(p, p.run.agent, { hash: c.core.bots.check(p, p.run.agent).hash })
}

function plan(c: TestCore, tier: "free" | "pro" | "max") {
  for (const agent of ["momentum", "swing"]) {
    const folder = candleConfigDir(c.p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify({ tier }))
  }
}

test("a view's: a harness is refused every method and the topic; a popped view pauses and narrows, the main view does the rest; the doctor changes nothing", async () => {
  const c = await startTestCore()
  cores.push(c)
  await save(c)
  const main = await c.view()
  const popped = await c.view("candle-harness view --pane wallets")
  const { client: harness } = await c.harness(main)
  for (const method of ["bots.list", "bots.pause", "bots.narrow", "bots.stop", "bots.resume", "bots.flatten", "bots.retry", "bots.remove"]) {
    expect([method, (await harness.request(method, { name: NAME })).error?.data?.code]).toEqual([method, "FORBIDDEN_FOR_ROLE"])
  }
  expect((await harness.request("subscribe", { topics: ["bots"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")

  await main.request("subscribe", { topics: ["bots"] })
  await until(() => lastOf<BotsTopic>(main, "bots")?.bots.length === 1)
  expect(lastOf<BotsTopic>(main, "bots")).toMatchObject({ bots: [{ kind: "rules", name: NAME, agent: "momentum", mode: "paper", state: "on", entries: true, exits: true }], problems: [] })
  expect(lastOf<BotsTopic>(main, "bots")!.gate).toBeUndefined()

  const doctor = await c.view(DOCTOR_CLIENT)
  expect((await doctor.request("bots.pause", { name: NAME })).error?.data?.code).toBe("OBSERVER")
  expect((await popped.request("bots.pause", { name: NAME })).result).toMatchObject({ state: "paused" })
  const narrower = { ...DEFINITION, sizing: { usd_per_trade: 1, max_concurrent: 4 } }
  expect((await popped.request("bots.narrow", { name: NAME, definition: narrower })).result).toMatchObject({ version: 2, narrowed: ["a stake of $1, from $2"] })
  for (const [method, params] of [
    ["bots.resume", { name: NAME }],
    ["bots.stop", { name: NAME }],
    ["bots.flatten", { name: NAME }],
    ["bots.retry", { name: NAME }],
    ["bots.remove", { name: NAME, positions: "leave" }],
  ] as const) {
    expect([method, (await popped.request(method, params)).error?.data?.code]).toEqual([method, "MAIN_VIEW_ONLY"])
  }
  expect((await main.request("bots.narrow", { name: NAME, definition: DEFINITION })).error?.data?.code).toBe("WIDER")
  expect((await main.request("bots.remove", { name: NAME })).error?.data?.code).toBe("INVALID_PARAMS")
  expect((await main.request("bots.resume", { name: NAME })).result).toMatchObject({ state: "on" })
  await until(() => lastOf<BotsTopic>(main, "bots")?.bots[0]?.version === 2 && lastOf<BotsTopic>(main, "bots")?.bots[0]?.state === "on")
  expect(c.core.journal.rows().filter((r) => r.type.startsWith("bot.")).map((r) => r.type)).toEqual(["bot.saved", "bot.paused", "bot.changed", "bot.resumed"])
})

test("Free: the topic says bots need Pro or Max, and nothing is proposed; a plan that ends holds their entries, and one that returns puts them back", async () => {
  let now = Date.now()
  const c = await startTestCore({ now: () => now }, { candle: { momentum: { tier: "free" }, swing: { tier: "free" } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["bots"] })
  await until(() => lastOf<BotsTopic>(view, "bots")?.gate?.plan === "free")
  expect(lastOf<BotsTopic>(view, "bots")!.gate).toEqual({ plan: "free", words: "Bots need a Pro or Max plan", fix: "candle plan buy" })
  expect(() => c.core.bots.check(PROPOSAL, "momentum")).toThrow("Bots need a Pro or Max plan")

  // Pro, read at the next five-minute refresh: proposed and saved.
  plan(c, "pro")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => lastOf<BotsTopic>(view, "bots")?.gate === undefined)
  await save(c)
  expect(c.core.bots.live()).toHaveLength(1)

  // Max to Free: entries held, its exits still sell, and journalled once.
  plan(c, "max")
  now += 5 * 60_000
  await c.core.plans.refresh()
  plan(c, "free")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => lastOf<BotsTopic>(view, "bots")?.bots[0]?.held?.code === "PLAN_FREE")
  expect(lastOf<BotsTopic>(view, "bots")!.bots[0]).toMatchObject({ state: "on", entries: false, exits: true })
  // Held with nothing open, it has nothing to sell, so it doesn't keep the core up.
  expect(c.core.bots.keepingUp()).toHaveLength(0)

  plan(c, "pro")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => c.core.bots.live().length === 1)
  await until(() => c.core.journal.rows().some((r) => r.type === "bot.released"))
  expect(c.core.journal.rows().filter((r) => r.type === "bot.held" || r.type === "bot.released").map((r) => r.type)).toEqual(["bot.held", "bot.released"])
})

test("a bot keeps the core up: the status counts it, what holds the core names it, and a stopped one doesn't", async () => {
  const c = await startTestCore()
  cores.push(c)
  await save(c)
  const main = await c.view()
  const status = async () => (await main.request("core.status", {})).result as { botsOn: number; holds: string[] }
  expect(await status()).toMatchObject({ botsOn: 1, holds: expect.arrayContaining(["1 bot running"]) })
  await main.request("bots.stop", { name: NAME })
  const after = await status()
  expect(after.botsOn).toBe(0)
  expect(after.holds).not.toContain("1 bot running")
})

test("a restart keeps every bot as it was, and the file 0600 beside config.toml", async () => {
  const c = await startTestCore()
  cores.push(c)
  await save(c)
  await save(c, { ...PROPOSAL, name: "swing-tickers", definition: { ...DEFINITION, entry: { source: "pattern", pattern: "new_ticker" } }, run: { agent: "swing", wallet: "embedded", mode: "live", maxSlippageBps: 300 } })
  const main = await c.view()
  await main.request("bots.pause", { name: "swing-tickers" })
  const before = c.core.bots.view()
  expect(statSync(c.p.botsFile).mode & 0o777).toBe(0o600)
  const p = c.p
  cores.splice(0)
  await c.close()
  const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
  try {
    await again.candleReady
    const client = await connectTestClient(p.socket)
    await client.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
    // Which wallet it pays from is named once the fresh core has read the agents' wallets.
    const unnamed = ({ books: _b, ...t }: BotsTopic) => ({ ...t, bots: t.bots.map(({ paysFrom: _p, sharedWith: _s, ownWallet: _o, ...b }) => b) })
    const listed = (await client.request("bots.list", {})).result as BotsTopic
    expect(unnamed(listed)).toEqual(unnamed(before))
    // A live bot on the embedded wallet shares it; the topic says with whom, for the doctor's note.
    expect(listed.bots.find((b) => b.name === "swing-tickers")?.sharedWith?.[0]).toBe("you and every agent")
    // And the way to a wallet of its own, as its card offered it (here, with no vault, the vault first); a paper bot has none.
    expect(listed.bots.find((b) => b.name === "swing-tickers")?.ownWallet?.length).toBeGreaterThan(0)
    expect(listed.bots.find((b) => b.name === NAME)?.ownWallet).toBeUndefined()
    // Each bot's book comes with it, the Bots tab's: nothing traded yet.
    expect(Object.keys(listed.books ?? {})).toEqual([NAME, "swing-tickers"])
    expect(listed.books?.[NAME]).toMatchObject({ open: [], closed: 0, realizedUsd: 0 })
    expect(listed.bots.map((b) => [b.name, b.state, b.mode])).toEqual([
      [NAME, "on", "paper"],
      ["swing-tickers", "paused", "live"],
    ])
    client.close()
  } finally {
    await again.stop("test")
  }
})

test("the doctor reads a running core's bots: each one's mode, state and wallet, the core kept up, Candle's stop with its step, and a live bot's shared wallet as a note", async () => {
  const c = await startTestCore()
  cores.push(c)
  await save(c)
  await save(c, { ...PROPOSAL, name: "swing-tickers", definition: { ...DEFINITION, entry: { source: "pattern", pattern: "new_ticker" } }, run: { agent: "swing", wallet: "embedded", mode: "live" } })
  await c.core.bots.pauseByCandle("swing")
  const checks = (await botChecks(c.p, true)).map((x) => `${x.state} ${x.area}: ${x.text}`)
  expect(checks[0]).toBe("ok bot: 1 bot keeps the core running after the view quits; `candle-harness stop` ends it")
  expect(checks[1]).toMatch(/^ok bot: bot "confluence-small": paper · enters and sells · momentum, pays from embedded$/)
  expect(checks[2]).toMatch(/^warn bot: bot "swing-tickers": live · paused: no new entries, its exits still sell\. Candle stopped swing's key at \d\d:\d\d/)
  expect(checks[3]).toBe('ok bot: bot "swing-tickers" trades live from embedded, shared with you and every agent and the bot "confluence-small": its book is the Candle Harness\'s count from its own fills, and a wallet of its own would fence what it can lose')
  expect(checks).toHaveLength(4)
  // Offline, the same file: the one still on is named as trading nothing without a core.
  await c.close()
  cores.splice(0)
  const offline = (await botChecks(c.p, false)).map((x) => `${x.state} ${x.area}: ${x.text}`)
  expect(offline).toEqual(["warn bot: 1 bot on in bots.toml, and no core is running, so none enters, and their exits don't sell what they hold"])
})

test("a rules bot on Hood pays from a Hood TEE wallet of its agent's key; a Solana bot on that wallet is refused when it's made", async () => {
  const HOOD_TEE = "0x00000000000000000000000000000000000E7e01"
  const tee = { id: "teeH", address: HOOD_TEE, label: "hood-tee", boundKeyPrefix: "Momentum", chain: "hood" as const, wei: "2500000000000000" }
  const c = await startTestCore({}, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: { teeWallets: [tee] }, swing: { teeWallets: [tee] } } })
  cores.push(c)
  const hood: BotProposal = { name: "hood-small", definition: { ...DEFINITION, chain: "hood" }, run: { agent: "momentum", wallet: HOOD_TEE, mode: "live" } }
  const saved = await save(c, hood)
  expect(saved).toMatchObject({ name: "hood-small" })
  expect(c.core.bots.view().bots[0]).toMatchObject({ name: "hood-small", wallet: HOOD_TEE, paysFrom: "hood-tee" })
  let message = ""
  try {
    c.core.bots.check({ ...hood, name: "solana-small", definition: DEFINITION }, "momentum")
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain("is a Hood wallet, and this trade is on Solana")
  expect(message).toEndWith("Nothing was proposed.")
}, 30_000)
