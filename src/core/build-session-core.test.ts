// Build panes on a real core, over its socket: the main view opens a pane's token for an agent and closes it; the
// pane reads the books and its agent's record, and tests a bot's code on paper with a test token of its own that's
// never in bots.toml, never supervised and never live, and ends with the pane, with the view that opened it, or when
// its time is up. A popped view, the doctor and a harness can't open one.
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { BotsTopic } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import type { CodeBotProposal } from "./code-bots"

const MOON = "MoonFake11111111111111111111111111111111111"
const FOLDER = "/srv/bots/momentum"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())

let n = 0
const rid = () => `req_build_${String(++n).padStart(6, "0")}`
const result = <T = Record<string, unknown>>(a: Awaited<ReturnType<TestClient["request"]>>) => {
  if (a.error) throw new Error(JSON.stringify(a.error))
  return a.result as T
}
const codeOf = (a: Awaited<ReturnType<TestClient["request"]>>) => (a.error?.data as { code?: string } | undefined)?.code

function trades(p: TestCore["p"]) {
  const file = join(candleConfigDir(p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
    .filter((x) => x.name === "candle_trade")
}

async function core(opts: Parameters<typeof startTestCore>[0] = {}) {
  const c = await startTestCore({ env: process.env, ...opts })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["bots"] })
  // The plan is read before bots are open.
  const probe: CodeBotProposal = { name: "probe", run: { agent: "momentum", wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 } }
  await until(() => {
    try {
      c.core.codeBots.check(probe, "momentum")
      return true
    } catch {
      return false
    }
  })
  return { c, view }
}

async function opened(c: TestCore, view: TestClient) {
  const o = result<{ token: string; tokenId: string; agent: string; socketPath: string }>(await view.request("build.open", { agent: "momentum", harness: "Claude Code" }))
  const { client: build, response } = await c.hello(o.token)
  if (response.error) throw new Error(JSON.stringify(response.error))
  return { ...o, build }
}

test("the main view opens a Build pane's token for an agent; the pane reads the books and its agent's own record, and nothing else", async () => {
  const { c, view } = await core()
  const { build, socketPath, agent, token } = await opened(c, view)
  expect(agent).toBe("momentum")
  expect(socketPath).toBe(c.p.socket)
  expect(token.startsWith("chd_")).toBe(true)
  expect(c.core.journal.rows().find((r) => r.type === "build.session")).toMatchObject({ agent: "momentum", what: "opened", harness: "Claude Code" })
  expect(JSON.stringify(c.core.journal.rows())).not.toContain(token)

  const books = result<BotsTopic>(await build.request("build.books", {}))
  expect(books.bots).toEqual([])
  const journal = result<{ agent: string; items: unknown[] }>(await build.request("build.journal", { limit: 5 }))
  expect(journal.agent).toBe("momentum")
  // A Build pane approves, trades and changes nothing itself.
  for (const method of ["cards.approve", "tools.call", "bots.pause", "autonomy.set", "triggers.set", "build.open", "core.status"]) {
    expect(codeOf(await build.request(method, {}))).toBe("FORBIDDEN_FOR_ROLE")
  }
})

test("only the main view opens one, for an agent with a key", async () => {
  const { c, view } = await core()
  expect(codeOf(await view.request("build.open", { agent: "nobody" }))).toBe("UNKNOWN_AGENT")
  const popped = await c.view("candle-harness view --pane bots")
  expect(codeOf(await popped.request("build.open", { agent: "momentum" }))).toBe("MAIN_VIEW_ONLY")
  const doctor = await c.view("candle-harness doctor")
  expect(codeOf(await doctor.request("build.open", { agent: "momentum" }))).toBe("OBSERVER")
})

test("a paper test run: its own token, on paper while the core is live, never in bots.toml or supervised; the pane's close ends it and revokes both tokens", async () => {
  const { c, view } = await core()
  const { build, tokenId } = await opened(c, view)
  const started = result<{ name: string; token: string; endsAt: string; figures: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2 }))
  expect(started.name).toBe("test:momentum")
  expect(started.figures).toBe("$2.00 a trade · $25.00 a day · 3 open at most")
  expect(c.core.codeBots.entries()).toEqual([])
  expect(existsSync(c.p.botsFile) ? readFileSync(c.p.botsFile, "utf8") : "").not.toContain("test:")
  await until(() => (lastOf<BotsTopic>(view, "bots")?.tests ?? []).some((t) => t.name === "test:momentum"))

  const { client: bot, response } = await c.hello(started.token)
  expect(response.error).toBeUndefined()
  const bought = result(await bot.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1.5 }))
  expect(bought).toMatchObject({ state: "filled", usd: 1.5 })
  expect(trades(c.p).at(-1)!.args).toMatchObject({ mint: MOON, side: "buy", paper: true })
  // Held to its test's figures, as any code bot is to its card's.
  expect(codeOf(await bot.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 3 }))).toBe("FIGURE_TRADE")

  expect(result(await view.request("build.close", { tokenId }))).toEqual({ closed: true })
  // It leaves the list before its row is written, so a second end can't run: wait for the row.
  await until(() => c.core.journal.rows().some((r) => r.type === "bot.test" && r.what === "ended"))
  expect(c.core.codeBots.isTest("test:momentum")).toBe(false)
  expect((await c.hello(started.token)).response.error).toBeDefined()
  expect(c.core.journal.rows().filter((r) => r.type === "bot.test").map((r) => [r.what, r.why])).toEqual([["started", undefined], ["ended", "pane_closed"]])
  expect(c.core.journal.rows().find((r) => r.type === "build.session" && r.what === "closed")).toBeDefined()
})

test("a test run ends on its own when its time is up, and when the view that opened its pane goes", async () => {
  const { c, view } = await core({ buildTestMs: 300 })
  const { build } = await opened(c, view)
  const started = result<{ name: string; token: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))
  await until(() => c.core.journal.rows().some((r) => r.type === "bot.test" && r.what === "ended"))
  expect(c.core.codeBots.isTest(started.name)).toBe(false)
  expect(c.core.journal.rows().find((r) => r.type === "bot.test" && r.what === "ended")).toMatchObject({ why: "timed_out" })
  expect((await c.hello(started.token)).response.error).toBeDefined()

  const other = await c.view()
  const o = result<{ token: string }>(await other.request("build.open", { agent: "momentum" }))
  other.close()
  await until(() => c.core.journal.rows().filter((r) => r.type === "build.session" && r.what === "closed").length === 1)
  expect((await c.hello(o.token)).response.error).toBeDefined()
})

test("a test is the pane's own: another pane can't end it, read its log or start one of the same folder; the agent's command ending ends it", async () => {
  const { c, view } = await core()
  const a = await opened(c, view)
  const b = await opened(c, view)
  const started = result<{ name: string }>(await a.build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))
  expect(codeOf(await b.build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))).toBe("TEST_RUNNING")
  expect(result(await b.build.request("build.testEnd", { name: started.name }))).toEqual({ ended: false })
  expect(codeOf(await b.build.request("build.logs", { bot: started.name }))).toBe("UNKNOWN_BOT")
  const ended = result<{ ended: boolean; said: string }>(await a.build.request("build.testEnd", { name: started.name }))
  expect(ended).toMatchObject({ ended: true })
  expect(ended.said).toContain("its command ended")
  // Its folder or command checked as a code bot's is.
  expect(codeOf(await a.build.request("build.test", { folder: "bots/x", command: ["bun"] }))).toBe("BAD_FOLDER")
})

test("on Free, no test runs", async () => {
  let now = Date.now()
  const { c, view } = await core({ now: () => now })
  for (const agent of ["momentum", "swing"]) {
    const folder = candleConfigDir(c.p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify({ tier: "free" }))
  }
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => c.core.codeBots.gate("momentum").state === "free")
  const { build } = await opened(c, view)
  expect(codeOf(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))).toBe("BOTS_NEED_PLAN")
})

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

test("the Build pane's folder and harness: the defaults, config.toml's [build], then the pane's own pick, kept; only the main view sets them", async () => {
  const { c, view } = await core()
  const first = result<{ folder: string; harness?: string; opened: boolean; bins: Record<string, string> }>(await view.request("build.prefs", {}))
  expect(first).toMatchObject({ folder: "~/candle-bots", opened: false, from: { folder: "default" } })
  expect(first.harness).toBeUndefined()
  expect(first.bins["claude-code"]).toBeDefined()
  const set = result<{ folder: string; harness: string; opened: boolean }>(await view.request("build.prefs", { set: { folder: "~/code/bots", harness: "codex", opened: true } }))
  expect(set).toMatchObject({ folder: "~/code/bots", harness: "codex", opened: true, from: { folder: "saved", harness: "saved" } })
  expect(JSON.parse(readFileSync(c.p.buildPrefs, "utf8"))).toEqual({ folder: "~/code/bots", harness: "codex", opened: true })
  // A folder that isn't one, and a harness with a control character, are refused; nothing changes.
  expect(codeOf(await view.request("build.prefs", { set: { folder: "bots" } }))).toBe("INVALID_PARAMS")
  expect(codeOf(await view.request("build.prefs", { set: { harness: "aider\n--yes" } }))).toBe("INVALID_PARAMS")
  expect(result<{ folder: string }>(await view.request("build.prefs", {})).folder).toBe("~/code/bots")
  const popped = await c.view("candle-harness view --pane build-folder")
  expect(result<{ folder: string }>(await popped.request("build.prefs", {})).folder).toBe("~/code/bots")
  expect(codeOf(await popped.request("build.prefs", { set: { harness: "pi" } }))).toBe("MAIN_VIEW_ONLY")
})

test("a bots folder or code bot folder that is /, the home or above it, or the Candle Harness's own folders (research included) is refused, by real path, at proposal, approval, start and open", async () => {
  const { c, view } = await core()
  const home = process.env.HOME ?? homedir()
  const research = c.p.researchDir("momentum")
  // A link that leads into the config folder is judged by where it leads.
  const link = join(c.p.stateDir, "..", `s3-link-${process.pid}`)
  symlinkSync(c.p.configDir, link)
  try {
    for (const folder of ["/", home, dirname(home), c.p.configDir, research, join(research, "quant"), c.p.stateDir, join(link, "bots")]) {
      expect(codeOf(await view.request("build.prefs", { set: { folder } }))).toBe("INVALID_PARAMS")
      const p: CodeBotProposal = { name: "s3", run: { agent: "momentum", wallet: "embedded", mode: "paper", folder, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 } }
      expect(() => c.core.codeBots.check(p, "momentum")).toThrow(/Candle Harness's own folder|home folder|the whole disk/)
    }
    // A folder of its own inside the home is fine.
    expect(codeOf(await view.request("build.prefs", { set: { folder: "~/code/bots" } }))).toBeUndefined()
    // One saved before (by hand, or an older version) is asked for again, and a pane isn't opened on it.
    writeFileSync(c.p.buildPrefs, JSON.stringify({ folder: c.p.configDir, harness: "codex", opened: true }))
    expect(result<{ opened: boolean; folderRefused?: string }>(await view.request("build.prefs", {}))).toMatchObject({ opened: false, folderRefused: expect.stringContaining("own folder") })
    expect(codeOf(await view.request("build.open", { agent: "momentum" }))).toBe("BAD_FOLDER")
  } finally {
    rmSync(link, { force: true })
  }
})

test("stop test: the view whose pane started a paper test ends it; another view can't", async () => {
  const { c, view } = await core()
  const { build } = await opened(c, view)
  const started = result<{ name: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))
  const other = await c.view("candle-harness view --pane bots")
  expect(codeOf(await other.request("build.endTest", { name: started.name }))).toBe("NOT_YOURS")
  expect(result<{ ended: boolean }>(await view.request("build.endTest", { name: started.name }))).toMatchObject({ ended: true })
  expect(result<{ ended: boolean }>(await view.request("build.endTest", { name: started.name }))).toEqual({ ended: false })
})

test("a paper test's held exits sell while it runs; what it holds when it ends stays open in its agent's paper book, the test's and no bot's", async () => {
  let skew = 0
  const clock = {
    now: () => Date.now() + skew,
    schedule: (run: () => void, ms: number) => {
      const t = setTimeout(run, ms)
      return () => clearTimeout(t)
    },
  }
  const { c, view } = await core({ triggerClock: clock })
  const moonAt = (usd: number) => {
    const file = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle.json")
    const was = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
    writeFileSync(file, JSON.stringify({ ...was, markets: [{ mint: MOON, symbol: "MOON", priceUsd: usd }] }))
  }
  const beat = async () => {
    skew += 5_000
    await c.core.watchBeat()
  }
  const { build } = await opened(c, view)
  const started = result<{ name: string; token: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))
  await until(() => (lastOf<BotsTopic>(view, "bots")?.tests ?? []).some((t) => t.afterEnd.includes("momentum's paper book")))
  const { client: bot } = await c.hello(started.token)
  moonAt(1)
  result(await bot.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1, exits: { stop_loss_pct: 40 } }))
  await until(() => c.core.botExits.tokens().includes(MOON))
  moonAt(0.0001)
  await beat()
  await until(() => trades(c.p).filter((t) => t.args.side === "sell").length === 1)
  expect(c.core.journal.rows().find((r) => r.type === "bot.exiting")).toMatchObject({ name: started.name, reason: "stop_loss", botMode: "paper" })

  // A second buy, held when the test ends: left open, said so, and kept apart from any bot's own.
  moonAt(1)
  result(await bot.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  const ended = result<{ ended: boolean; said: string }>(await build.request("build.testEnd", { name: started.name }))
  expect(ended.said).toContain("Its paper position stays open in momentum's paper book: the test's, not counted as any bot's.")
  expect(trades(c.p).filter((t) => t.args.side === "sell")).toHaveLength(1)
  await until(() => (lastOf<BotsTopic>(view, "bots")?.testsEnded ?? []).some((t) => t.name === started.name && t.open === 1))
  const { client: harness } = await c.harness(view)
  const r = await harness.request("tools.call", { name: "harness_bots", args: { action: "read" } })
  const read = JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as { testsLeftOpen?: { note: string; positions: { test: string; agent: string; token: string }[] } }
  expect(read.testsLeftOpen?.positions).toEqual([expect.objectContaining({ test: started.name, agent: "momentum", token: "MOON" })])
  expect(read.testsLeftOpen?.note).toContain("not any bot's")
})

test("a code bot's card waiting for the person is on the bots topic by its folder, and leaves it once pressed", async () => {
  const { c, view } = await core()
  const { build } = await opened(c, view)
  const proposed = result<{ cardId: string }>(await build.request("bots.proposeCode", { name: "momentum-bot", wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 }))
  await until(() => (lastOf<BotsTopic>(view, "bots")?.codeCards ?? []).some((x) => x.cardId === proposed.cardId && x.folder === FOLDER && x.name === "momentum-bot" && !x.change))
  const card = c.core.cards.get(proposed.cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  await until(() => (lastOf<BotsTopic>(view, "bots")?.codeCards ?? []).length === 0 && (lastOf<BotsTopic>(view, "bots")?.code ?? []).some((b) => b.name === "momentum-bot"))
})

test("a test run that ends with a request Candle never answered says so, and lets it go: the next test's open figure is its own", async () => {
  const { c, view } = await core()
  const { build } = await opened(c, view)
  const scriptFile = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle.json")
  const was = existsSync(scriptFile) ? (JSON.parse(readFileSync(scriptFile, "utf8")) as Record<string, unknown>) : {}
  writeFileSync(scriptFile, JSON.stringify({ ...was, tools: { candle_trade: "hang" } }))
  const first = result<{ name: string; token: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"], maxOpen: 1 }))
  const { client: bot } = await c.hello(first.token)
  const hung = rid()
  // Candle never answers it: the call is left waiting, as a paper buy did on a Mac.
  void bot.request("bot.buy", { request: hung, mint: MOON, amountUsd: 1 }).catch(() => {})
  await until(() => c.core.journal.rows().some((r) => r.type === "bot.request" && r.request === hung))
  const ended = result<{ said: string }>(await build.request("build.testEnd", { name: first.name }))
  expect(ended.said).toContain("Its buy of MOON had no answer yet: let go, so it holds nothing open.")
  expect(c.core.journal.rows().find((r) => r.type === "bot.request_ended" && r.request === hung)).toMatchObject({ outcome: "lost" })

  // The next test of the same folder: its one open slot is free.
  writeFileSync(scriptFile, JSON.stringify({ ...was, tools: {} }))
  const second = result<{ token: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"], maxOpen: 1 }))
  const { client: again } = await c.hello(second.token)
  expect(result(await again.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))).toMatchObject({ state: "filled" })
})

test("a new test of a folder counts its figures from its own start: what the last test left open, and spent, isn't this run's", async () => {
  const { c, view } = await core()
  const { build } = await opened(c, view)
  const ask = { folder: FOLDER, command: ["bun", "run", "bot.ts"], maxOpen: 1, perTradeUsd: 1, perDayUsd: 1 }
  const first = result<{ name: string; token: string }>(await build.request("build.test", ask))
  const { client: bot } = await c.hello(first.token)
  expect(result(await bot.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))).toMatchObject({ state: "filled" })
  // Within the run, its figures hold as ever.
  expect(codeOf(await bot.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))).toBe("FIGURE_DAY")
  const ended = result<{ said: string }>(await build.request("build.testEnd", { name: first.name }))
  expect(ended.said).toContain("Its paper position stays open")
  await Bun.sleep(5)

  const second = result<{ token: string }>(await build.request("build.test", ask))
  const { client: again } = await c.hello(second.token)
  // The earlier run's position is still open under the test's name, and still its to sell.
  expect(result<{ positions: unknown[] }>(await again.request("bot.positions", {})).positions).toHaveLength(1)
  expect(result(await again.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))).toMatchObject({ state: "filled" })
  // And this run's own figures hold from there.
  expect(codeOf(await again.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))).toBe("FIGURE_DAY")
})

test("a paper test's token is never written to the token file, and still connects while the test runs", async () => {
  const { c, view } = await core()
  const { build } = await opened(c, view)
  const started = result<{ name: string; token: string }>(await build.request("build.test", { folder: FOLDER, command: ["bun", "run", "bot.ts"] }))
  const { response } = await c.hello(started.token)
  expect(response.error).toBeUndefined()
  const file = JSON.parse(readFileSync(c.p.tokens, "utf8")) as { bot: { bot: string }[] }
  expect(file.bot.filter((r) => r.bot.startsWith("test:"))).toEqual([])
  expect(readFileSync(c.p.tokens, "utf8")).not.toContain("test:")
})

test("a Build pane reads the log of its own agent's bots only", async () => {
  const { c, view } = await core()
  const { build } = await opened(c, view)
  const proposed = result<{ cardId: string }>(await build.request("bots.proposeCode", { name: "grid", wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 }))
  const card = c.core.cards.get(proposed.cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  // Its own agent's pane is answered.
  expect((await build.request("build.logs", { bot: "grid" })).error).toBeUndefined()
  // Another agent's pane is refused, in the words a proposal for another agent's bot gets.
  const other = result<{ token: string }>(await view.request("build.open", { agent: "swing", harness: "Claude Code" }))
  const { client: theirs } = await c.hello(other.token)
  const refusal = await theirs.request("build.logs", { bot: "grid" })
  expect(codeOf(refusal)).toBe("NOT_ITS_AGENT")
  expect(refusal.error!.message).toContain("momentum's bot")
})

test("a Build pane's commands, each on a connection of its own, are one proposer: five open cards at most, and one for a bot's name", async () => {
  const { c, view } = await core()
  const o = await opened(c, view)
  const settings = { wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 }
  const fresh = async () => (await c.hello(o.token)).client
  const open = () => c.core.cards.list().filter((x) => x.state === "awaiting_approval")
  // The same name proposed again with other figures takes the place of its card; the same settings again are that card.
  const a = result<{ cardId: string }>(await (await fresh()).request("bots.proposeCode", { name: "bot-0", ...settings }))
  const same = result<{ cardId: string }>(await (await fresh()).request("bots.proposeCode", { name: "bot-0", ...settings }))
  expect(same.cardId).toBe(a.cardId)
  const b = result<{ cardId: string }>(await (await fresh()).request("bots.proposeCode", { name: "bot-0", ...settings, perTradeUsd: 3 }))
  expect(b.cardId).not.toBe(a.cardId)
  expect(open().map((x) => x.cardId)).toEqual([b.cardId])
  expect(c.core.cards.get(a.cardId)!.state).toBe("withdrawn")
  // Five open from one agent's panes, however many connections asked.
  for (let i = 1; i < 5; i++) result(await (await fresh()).request("bots.proposeCode", { name: `bot-${i}`, ...settings }))
  expect(open()).toHaveLength(5)
  expect(codeOf(await (await fresh()).request("bots.proposeCode", { name: "bot-5", ...settings }))).toBe("TOO_MANY_OPEN_CARDS")
  expect(open()).toHaveLength(5)
})
