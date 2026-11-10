// Code bots on a real core, over its socket: a Build pane proposes one as a card, and only the person's press saves
// it; lowering a figure is at once, raising one a card; a bot's token reaches only the bot's own column and is refused
// on Free, once removed or once replaced; a hand edit holds its buys; a plan that ends holds them too; and a code
// bot keeps the core up, as a rules bot does.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { connectTestClient } from "../../test/core-test-client"
import { PROTOCOL_VERSION } from "../shared/rpc"
import type { BotsTopic } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import type { CodeBotProposal } from "./code-bots"
import { startCore } from "./core-main"
import { METHOD_ROLES } from "./server"

const NAME = "momentum-bot"
const FOLDER = "/srv/bots/momentum"
const ASK = { name: NAME, wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 }
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())
const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

async function core(opts: Parameters<typeof startTestCore>[0] = {}, home: Parameters<typeof startTestCore>[1] = {}) {
  const c = await startTestCore(opts, home)
  cores.push(c)
  const view = await c.view()
  const minted = await c.core.tokens.mintBuild("Build pane", "momentum")
  const { client: build, response } = await c.hello(minted.token)
  if (response.error) throw new Error(JSON.stringify(response.error))
  // The agent's wallets are read before a card can say which pays.
  const proposal: CodeBotProposal = { name: "probe", run: { agent: "momentum", ...ASK, mode: "paper" } as CodeBotProposal["run"] }
  await until(() => {
    try {
      c.core.codeBots.check(proposal, "momentum")
      return true
    } catch {
      return false
    }
  })
  return { c, view, build, buildToken: minted }
}

/** Proposes from the Build pane and approves on the view, as the person's press. */
async function made(c: TestCore, view: Awaited<ReturnType<typeof core>>["view"], build: Awaited<ReturnType<typeof core>>["build"], ask: Record<string, unknown> = ASK) {
  const proposed = await build.request("bots.proposeCode", ask)
  if (proposed.error) throw new Error(JSON.stringify(proposed.error))
  const card = c.core.cards.get((proposed.result as { cardId: string }).cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  return card
}

function plan(c: TestCore, tier: "free" | "pro" | "max") {
  for (const agent of ["momentum", "swing"]) {
    const folder = candleConfigDir(c.p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify({ tier }))
  }
}

test("a Build pane proposes a card; nothing is saved before the press; the press saves it to bots.toml as approved", async () => {
  const { c, view, build } = await core()
  const proposed = await build.request("bots.proposeCode", ASK)
  const card = c.core.cards.get((proposed.result as { cardId: string }).cardId)!
  expect(card.kind).toBe("bot")
  expect(card.origin).toMatchObject({ role: "build", source: "build" })
  expect(card.display.title).toBe(`NEW CODE BOT "${NAME}"`)
  expect(card.display.botCard).toMatchObject({ name: NAME, mode: "paper", code: { folder: FOLDER, command: "bun run bot.ts", figures: "$2.00 a trade · $10.00 a day · 3 open at most", holds: "The core holds this bot to these figures. What it trades inside them is its code's." } })
  expect(c.core.codeBots.entries()).toEqual([])

  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  expect(c.core.codeBots.entries()).toEqual([{ kind: "code", name: NAME, agent: "momentum", wallet: "embedded", mode: "paper", state: "on", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 }])
  expect(statSync(c.p.botsFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(c.p.botsFile, "utf8")).toContain('kind = "code"')
  expect(c.core.journal.rows().find((r) => r.type === "bot.saved")).toMatchObject({ kind: "code", name: NAME, by: "card", version: 1 })

  // The topic carries it beside the rules bots.
  await view.request("subscribe", { topics: ["bots"] })
  await until(() => (lastOf<BotsTopic>(view, "bots")?.code?.length ?? 0) === 1)
  expect(lastOf<BotsTopic>(view, "bots")!.code![0]).toMatchObject({ kind: "code", name: NAME, state: "on", buys: true, sells: true, figures: "$2.00 a trade · $10.00 a day · 3 open at most", version: 1 })
})

test("lowering a figure is at once; raising one, going live, another folder or command is a card; a rules bot's name is refused", async () => {
  const { c, view, build } = await core()
  await made(c, view, build)
  const lower = await build.request("bots.proposeCode", { name: NAME, replace: true, perTradeUsd: 1, maxOpen: 2 })
  expect(lower.result).toEqual({ done: true, said: `"${NAME}" is narrowed: a trade's figure $1.00, from $2.00; open at most 2, from 3.` })
  expect(c.core.codeBots.entry(NAME)).toMatchObject({ perTradeUsd: 1, maxOpen: 2 })
  expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval")).toHaveLength(0)

  for (const [ask, changes] of [
    [{ perTradeUsd: 5 }, "a trade's figure $5.00, from $1.00"],
    [{ mode: "live" }, "live, from paper"],
    [{ folder: "/srv/bots/other" }, "the folder /srv/bots/other, from /srv/bots/momentum"],
    [{ command: ["node", "bot.js"] }, "the command node bot.js, from bun run bot.ts"],
  ] as const) {
    const r = await build.request("bots.proposeCode", { name: NAME, replace: true, ...ask })
    const card = c.core.cards.get((r.result as { cardId: string }).cardId)!
    expect([Object.keys(ask)[0], card.display.botCard?.changes]).toEqual([Object.keys(ask)[0], changes])
  }
  // Still as narrowed, until a press.
  expect(c.core.codeBots.entry(NAME)).toMatchObject({ perTradeUsd: 1, mode: "paper", folder: FOLDER })
  // A slippage bound under the route's 1% binds the bot's sells too: a card from the Build pane, amber, never at once.
  const tight = await build.request("bots.proposeCode", { name: NAME, replace: true, maxSlippageBps: 50 })
  expect(c.core.cards.get((tight.result as { cardId: string }).cardId)!.display).toMatchObject({ botCard: { changes: "a slippage bound of 0.5%, from 1%" }, slippage: "its own slippage bound: 0.5%, under the route's 1%: its sells may not fill", slippageLooser: true })
  expect(c.core.codeBots.entry(NAME)!.maxSlippageBps).toBeUndefined()
  expect((await view.request("bots.narrow", { name: NAME, maxSlippageBps: 50 })).error?.data?.code).toBe("WIDER")
  // Under the floor it's refused whoever asks: almost nothing fills there, sells included.
  for (const bps of [0, 9]) expect([bps, (await build.request("bots.proposeCode", { name: NAME, replace: true, maxSlippageBps: bps })).error?.data?.code]).toEqual([bps, "INVALID_SLIPPAGE"])
  expect((await build.request("bots.proposeCode", { ...ASK, name: "zero", maxSlippageBps: 0 })).error?.data?.code).toBe("INVALID_SLIPPAGE")
  expect((await build.request("bots.proposeCode", { name: NAME, replace: true })).error?.data?.code).toBe("NO_CHANGE")
  expect((await build.request("bots.proposeCode", ASK)).error?.data?.code).toBe("NAME_TAKEN")
  expect((await build.request("bots.proposeCode", { ...ASK, name: "rel", folder: "bots/x" })).error?.data?.code).toBe("INVALID_CODE_BOT")
  expect((await build.request("bots.proposeCode", { ...ASK, name: "nowallet", wallet: undefined })).error?.data?.code).toBe("ASK_FIRST")

  // A rules bot's name isn't a code bot's, nor the other way.
  const DEFINITION = { chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { stop_loss_pct: 40 }, sizing: { usd_per_trade: 2, max_concurrent: 4 } }
  expect(() => c.core.bots.check({ name: NAME, definition: DEFINITION, run: { agent: "momentum", wallet: "embedded", mode: "paper" } }, "momentum")).toThrow(`A code bot is named "${NAME}"`)
})

test("a bot's token reaches only its own column; a Build pane's only its own; each refusal is journalled", async () => {
  const { c, view, build } = await core()
  await made(c, view, build)
  const { token } = await c.core.codeBots.issueToken(NAME, "outside")
  const { client: bot, response } = await c.hello(token, { clientName: "pretends to be a view" })
  // It's told what it acts as, and nothing of the core's agents, account or mode.
  expect(response.result).toEqual({ protocol: expect.any(String), coreVersion: expect.any(String), clientId: expect.any(String), role: "bot", agent: "momentum", bot: NAME })
  expect(c.core.server.clients().find((x) => x.role === "bot")).toMatchObject({ clientName: NAME, bot: NAME, agent: "momentum" })

  const self = await bot.request("bot.self", {})
  expect(self.result).toMatchObject({ name: NAME, agent: "momentum", mode: "paper", state: "on", buys: true, sells: true, figures: { perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 } })

  const reached = { bot: [] as string[], build: [] as string[] }
  for (const method of Object.keys(METHOD_ROLES).filter((m) => m !== "core.hello" && m !== "core.stop")) {
    if ((await bot.request(method, {})).error?.data?.code !== "FORBIDDEN_FOR_ROLE") reached.bot.push(method)
    if ((await build.request(method, {})).error?.data?.code !== "FORBIDDEN_FOR_ROLE") reached.build.push(method)
  }
  // Its own trades, reads and what it's told: nothing of another bot's, an agent's or the person's.
  expect(reached).toEqual({ bot: ["bot.buy", "bot.sell", "bot.swap", "bot.request", "bot.positions", "bot.fills", "bot.market", "bot.hacc", "bot.report", "bot.event", "bot.exits", "bot.self", "subscribe", "unsubscribe"].sort((a, b) => Object.keys(METHOD_ROLES).indexOf(a) - Object.keys(METHOD_ROLES).indexOf(b)), build: ["bots.proposeCode", "build.books", "build.logs", "build.journal", "build.test", "build.testEnd"] })
  expect((await bot.request("core.stop", {})).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  // It subscribes to what's told to it and to the tape; never to the person's topics.
  expect((await bot.request("subscribe", { topics: ["bots"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  expect((await bot.request("subscribe", { topics: ["cards"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  expect((await bot.request("subscribe", { topics: ["bot", "signals"] })).result).toMatchObject({ topics: ["bot", "signals"] })
  expect((await build.request("subscribe", { topics: ["bot"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  const forbidden = c.core.journal.rows().filter((r) => r.type === "call.forbidden")
  expect(forbidden.filter((r) => r.role === "bot").map((r) => r.method)).toContain("cards.approve")
  expect(forbidden.filter((r) => r.role === "build").map((r) => r.method)).toContain("cards.approve")
  // No token is written anywhere the core keeps.
  expect(readFileSync(c.p.journal, "utf8")).not.toContain(token)
})

test("issuing again replaces the token and ends its connection; removing the bot revokes it; on Free none connects", async () => {
  let now = Date.now()
  const { c, view, build } = await core({ now: () => now })
  await made(c, view, build)
  const first = await c.core.codeBots.issueToken(NAME, "outside")
  const { client: bot } = await c.hello(first.token)
  const second = await c.core.codeBots.issueToken(NAME, "start")
  await bot.closed
  expect((await c.hello(first.token)).response.error?.data?.code).toBe("UNAUTHENTICATED")
  expect((await c.hello(second.token)).response.result).toMatchObject({ role: "bot" })

  // On Free, the token is refused at hello, and the refusal is journalled.
  plan(c, "free")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => c.core.codeBots.gate().state === "free")
  expect((await c.hello(second.token)).response.error?.data).toMatchObject({ code: "BOTS_NEED_PLAN" })
  expect(c.core.journal.rows().some((r) => r.type === "client.refused" && r.role === "bot" && r.reason === "BOTS_NEED_PLAN")).toBe(true)
  expect(c.core.codeBots.views()[0]).toMatchObject({ buys: false, sells: true, held: { code: "PLAN_FREE" } })
  expect((await build.request("bots.proposeCode", { ...ASK, name: "another" })).error?.data).toMatchObject({ code: "BOTS_NEED_PLAN" })
  await until(() => c.core.journal.rows().some((r) => r.type === "bot.held" && r.kind === "code"))
  plan(c, "pro")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => c.core.codeBots.views()[0]?.buys === true)

  // Removed: its token no longer connects, and its rows say so.
  expect((await view.request("bots.remove", { name: NAME, positions: "leave" })).result).toMatchObject({ said: expect.stringContaining("its token no longer connects") })
  expect((await c.hello(second.token)).response.error?.data?.code).toBe("UNAUTHENTICATED")
  expect(c.core.journal.rows().filter((r) => r.type === "bot.token").map((r) => r.what)).toEqual(["issued", "renewed", "revoked"])
  expect(c.core.codeBots.entries()).toEqual([])
})

test("a hand edit holds its buys, its sells still run; a pause typed into the file takes; only the main view resumes", async () => {
  const { c, view, build } = await core()
  await made(c, view, build)
  const text = readFileSync(c.p.botsFile, "utf8")
  writeFileSync(c.p.botsFile, text.replace("perTradeUsd = 2", "perTradeUsd = 3"), { mode: 0o600 })
  await until(() => c.core.codeBots.views()[0]?.held?.code === "CHANGED_OUTSIDE")
  expect(c.core.codeBots.views()[0]).toMatchObject({ buys: false, sells: true })
  // What it's held to stays what was approved.
  const { token } = await c.core.codeBots.issueToken(NAME, "outside")
  const { client: bot } = await c.hello(token)
  expect((await bot.request("bot.self", {})).result).toMatchObject({ buys: false, figures: { perTradeUsd: 2 } })
  // It isn't narrowed while it waits for its card.
  expect((await view.request("bots.narrow", { name: NAME, perTradeUsd: 1 })).error?.data?.code).toBe("CHANGED_OUTSIDE")

  // Back as approved, then paused by hand: taken.
  writeFileSync(c.p.botsFile, text.replace('state = "on"', 'state = "paused"'), { mode: 0o600 })
  await until(() => c.core.codeBots.views()[0]?.state === "paused")
  expect(c.core.codeBots.views()[0]).toMatchObject({ buys: false, sells: true, stateWords: expect.stringContaining("set in bots.toml") })
  const popped = await c.view("candle-harness view --pane wallets")
  expect((await popped.request("bots.resume", { name: NAME })).error?.data?.code).toBe("MAIN_VIEW_ONLY")
  expect((await build.request("bots.resume", { name: NAME })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  expect((await view.request("bots.resume", { name: NAME })).result).toMatchObject({ state: "on" })
  expect(c.core.codeBots.views()[0]?.buys).toBe(true)
})

test("a code bot keeps the core up, and a restart keeps it as it was, its token included", async () => {
  const { c, view, build } = await core()
  await made(c, view, build)
  const { token } = await c.core.codeBots.issueToken(NAME, "outside")
  const status = async () => (await view.request("core.status", {})).result as { botsOn: number; holds: string[] }
  expect(await status()).toMatchObject({ botsOn: 1, holds: expect.arrayContaining(["1 bot running"]) })
  await view.request("bots.stop", { name: NAME })
  expect((await status()).botsOn).toBe(0)
  await view.request("bots.resume", { name: NAME })

  const p = c.p
  cores.splice(cores.indexOf(c), 1)
  await c.close()
  const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
  try {
    await again.candleReady
    await until(() => again.codeBots.views()[0]?.buys === true)
    expect(again.codeBots.views()[0]).toMatchObject({ name: NAME, state: "on", version: 1, token: { issuedAt: expect.any(String) } })
    const client = await connectTestClient(p.socket)
    const hello = await client.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "test" })
    expect(hello.result).toMatchObject({ role: "bot", bot: NAME })
  } finally {
    await again.stop("test")
  }
})

test("a change approved to a bot the person paused or stopped keeps it so, and its card says it; putting it back on stays the person's", async () => {
  const { c, view, build } = await core()
  await made(c, view, build)
  for (const [act, state] of [
    ["bots.pause", "paused"],
    ["bots.stop", "stopped"],
  ] as const) {
    await view.request(act, { name: NAME })
    await until(() => c.core.codeBots.runState(c.core.codeBots.entry(NAME)!) === state)
    const perDayUsd = state === "paused" ? 12 : 14
    const r = await build.request("bots.proposeCode", { ...ASK, replace: true, perDayUsd })
    const card = c.core.cards.get((r.result as { cardId: string }).cardId)!
    expect(card.display.botCard?.changes).toContain(`it stays ${state}: put it back on from the Bots tab`)
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
    expect(c.core.codeBots.entry(NAME)).toMatchObject({ perDayUsd, state })
    expect(c.core.codeBots.runState(c.core.codeBots.entry(NAME)!)).toBe(state)
    expect(c.core.journal.rows().findLast((r) => r.type === "bot.changed")).toMatchObject({ state })
  }
  await view.request("bots.resume", { name: NAME })
  await until(() => c.core.codeBots.runState(c.core.codeBots.entry(NAME)!) === "on")
  // On, a change keeps it on, and says nothing of staying.
  const r = await build.request("bots.proposeCode", { ...ASK, replace: true, perDayUsd: 16 })
  expect(c.core.cards.get((r.result as { cardId: string }).cardId)!.display.botCard?.changes).toBe("a day's figure $16.00, from $14.00")
})
