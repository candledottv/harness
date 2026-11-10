// The supervisor on a real core, with a bot written against the real client: approved on its card, it's started
// once the socket listens, connects with the token it was handed, and trades; it ends with the core and starts again
// with the next one, asking its request again under the same id, so nothing is sent twice; after a `kill -9` of the
// core the next core ends the bot it left running before starting it again; a crash loop stops, said and told; and
// `candle-harness bots` lists, stops, starts, restarts, hands out a token file and prints the log.
import { afterAll, afterEach, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { loadConfig } from "../config"
import { botsCommand } from "../setup/bots"
import { EXIT } from "../setup/ask"
import { pidIsAlive } from "../shared/lock"
import type { BotsTopic } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import type { CodeBotProposal } from "./code-bots"
import { type RunningCore, startCore } from "./core-main"
import type { JournalRow } from "./journal"

const MOON = "MoonFake11111111111111111111111111111111111"
const TUNING = { backoffMs: [100, 200, 400], stopGraceMs: 2_000 }

const cores: TestCore[] = []
const extra: RunningCore[] = []
const procs: { kill(signal?: number | NodeJS.Signals): void; pid: number }[] = []
const dirs: string[] = []
/** Bots a core started that a test saw: a test that fails midway mustn't leave one running after a killed core. */
const botPids: number[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
  for (const c of extra.splice(0)) await c.stop("test").catch(() => {})
  for (const p of procs.splice(0)) p.kill("SIGKILL")
  for (const pid of botPids.splice(0))
    if (pidIsAlive(pid))
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
})
afterAll(() => {
  cleanupHomes()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A bot's folder: the client beside a bot that connects, says it's up, and buys once under a fixed id at every start. */
function botFolder(body = "buy"): string {
  const d = mkdtempSync("/tmp/chrn-bot-")
  dirs.push(d)
  copyFileSync(join(import.meta.dir, "../../client/harness-client.ts"), join(d, "harness-client.ts"))
  const crash = `console.error("crashing on purpose"); process.exit(1)`
  const buy = `
import { HarnessClient } from "./harness-client"
const h = await HarnessClient.connect()
console.log("connected as " + process.env.CANDLE_HARNESS_BOT)
const a = await h.buy({ request: "req_boot_000001", mint: "${MOON}", amountUsd: 1.5 })
console.log("bought " + a.state)
setInterval(() => {}, 1000)
`
  writeFileSync(join(d, "bot.ts"), body === "crash" ? crash : buy)
  return d
}

const ask = (folder: string) => ({ name: "sup-bot", wallet: "embedded", mode: "paper", folder, command: [process.execPath, "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 })

async function made(c: TestCore, view: TestClient, folder: string) {
  const minted = await c.core.tokens.mintBuild("Build pane", "momentum")
  const { client: build } = await c.hello(minted.token)
  const probe: CodeBotProposal = { name: "probe", run: { agent: "momentum", ...ask(folder), mode: "paper" } as CodeBotProposal["run"] }
  await until(() => {
    try {
      c.core.codeBots.check(probe, "momentum")
      return true
    } catch {
      return false
    }
  })
  const proposed = await build.request("bots.proposeCode", ask(folder))
  if (proposed.error) throw new Error(JSON.stringify(proposed.error))
  const card = c.core.cards.get((proposed.result as { cardId: string }).cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
}

const fileRows = (c: TestCore): JournalRow[] =>
  readFileSync(c.p.journal, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as JournalRow)
const processRows = (c: TestCore, what: string) => fileRows(c).filter((r) => r.type === "bot.process" && r.what === what)
const trades = (c: TestCore) => {
  const file = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string })
        .filter((x) => x.name === "candle_trade")
    : []
}
const runningPid = (c: TestCore): number | undefined => {
  try {
    return (JSON.parse(readFileSync(c.p.supervisorState, "utf8")) as { bots: Record<string, { running?: { pid: number } }> }).bots["sup-bot"]?.running?.pid
  } catch {
    return undefined
  }
}
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out: () => out.join(""), err: () => err.join(""), io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } }
}

test("a code bot runs once approved, ends with its core, starts again with the next, and after a kill -9 of the core is ended and started again: its buy sent once", async () => {
  const c = await startTestCore({ supervise: TUNING })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["bots"] })
  const folder = botFolder()
  await made(c, view, folder)
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  await until(() => trades(c).length === 1, 10_000)
  const first = runningPid(c)!
  expect(pidIsAlive(first)).toBe(true)
  const topic = [...view.events].reverse().find((e) => e.topic === "bots" && (e.data as BotsTopic).code?.[0]?.process?.state === "running")?.data as BotsTopic
  expect(topic.code![0]!.process).toMatchObject({ runs: "harness", state: "running", pid: first })
  expect(processRows(c, "started")[0]).toMatchObject({ name: "sup-bot", by: "core" })
  // The trade reaches the fake before the bot hears it filled and says so.
  await until(() => readFileSync(join(c.p.botLogsDir, "sup-bot.log"), "utf8").includes("bought filled"), 10_000)

  // The core stops: the bot's process goes with it.
  await c.core.stop("test")
  cores.splice(cores.indexOf(c), 1)
  expect(pidIsAlive(first)).toBe(false)
  expect(processRows(c, "stopped").at(-1)).toMatchObject({ why: "core" })

  // The next core starts it again; its buy is asked again under the same id, and answered, never sent again.
  const second = await startCore({ paths: c.p, config: loadConfig(c.p).config, env: process.env, headless: true, supervise: TUNING })
  extra.push(second)
  await until(() => processRows(c, "started").length === 2, 10_000)
  await until(() => readFileSync(join(c.p.botLogsDir, "sup-bot.log"), "utf8").split("bought filled").length === 3, 10_000)
  expect(trades(c).length).toBe(1)
  await second.stop("test")
  extra.splice(0)

  // A core run on its own is killed with kill -9: the bot it started is left running, and the next core ends it.
  const main = join(import.meta.dir, "../main.ts")
  const env = { ...process.env, CANDLE_HARNESS_HOME: c.p.configDir }
  const third = Bun.spawn([process.execPath, main, "core"], { env, stdout: "ignore", stderr: "ignore" })
  procs.push(third)
  await until(() => runningPid(c) !== undefined, 15_000)
  const orphan = runningPid(c)!
  botPids.push(orphan)
  await until(() => readFileSync(join(c.p.botLogsDir, "sup-bot.log"), "utf8").split("bought filled").length === 4, 15_000)
  third.kill("SIGKILL")
  await third.exited
  expect(pidIsAlive(orphan)).toBe(true)
  const fourth = Bun.spawn([process.execPath, main, "core"], { env, stdout: "ignore", stderr: "ignore" })
  procs.push(fourth)
  await until(() => !pidIsAlive(orphan), 15_000)
  await until(() => runningPid(c) !== undefined && runningPid(c) !== orphan, 15_000)
  expect(processRows(c, "stopped").find((r) => r.why === "leftover")).toMatchObject({ name: "sup-bot", pid: orphan })
  await until(() => readFileSync(join(c.p.botLogsDir, "sup-bot.log"), "utf8").split("bought filled").length === 5, 15_000)
  expect(trades(c).length).toBe(1)
  const last = runningPid(c)!
  botPids.push(last)
  fourth.kill("SIGTERM")
  await fourth.exited
  await until(() => !pidIsAlive(last), 10_000)
}, 90_000)

test("a crash loop stops after five in ten minutes, said, told, and shown; `bots start` runs it again", async () => {
  const c = await startTestCore({ supervise: { backoffMs: [50, 50, 50, 50], stopGraceMs: 2_000 }, notify: { native: false, quietMs: 0 } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["bots"] })
  await made(c, view, botFolder("crash"))
  await until(() => processRows(c, "gave_up").length === 1, 15_000)
  expect(processRows(c, "crashed").length).toBe(4)
  expect(processRows(c, "gave_up")[0]).toMatchObject({ name: "sup-bot", crashes: 5 })
  const shown = c.core.codeBots.views()[0]!
  expect(shown.connected).toBe(false)
  const lastBots = () => [...view.events].reverse().find((e) => e.topic === "bots")!.data as BotsTopic
  await until(() => lastBots().code?.[0]?.process?.state === "gave_up")
  const last = lastBots()
  expect(last.code![0]!.process!.words).toBe("crashed 5 times in 10 min, so it isn't started again: `candle-harness bots start sup-bot` runs it again")
  // The Journal says it in words.
  const page = (await view.request("journal.query", { kinds: ["bots"], limit: 50 })).result as { entries: { text: string }[] }
  expect(page.entries.some((r) => /^the code bot "sup-bot" crashed \(exit 1\) at \d\d:\d\d: 5 crashes in 10 min, so it isn't started again until you start it$/.test(r.text))).toBe(true)

  const t = io()
  expect(await botsCommand(["start", "sup-bot"], t.io, { env: { ...process.env, CANDLE_HARNESS_HOME: c.p.configDir } })).toBe(EXIT.done)
  await until(() => processRows(c, "started").length === 6, 10_000)
})

test("`candle-harness bots`: list, stop leaves the bot on, start, restart, a token file for running it elsewhere, and its log", async () => {
  const c = await startTestCore({ supervise: TUNING })
  cores.push(c)
  const view = await c.view()
  const folder = botFolder()
  await made(c, view, folder)
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  const env = { env: { ...process.env, CANDLE_HARNESS_HOME: c.p.configDir } }

  let t = io()
  expect(await botsCommand(["list"], t.io, env)).toBe(EXIT.done)
  expect(t.out()).toContain("sup-bot  code · momentum · paper · on · connected")
  expect(t.out()).toMatch(/running since \d\d:\d\d \(pid \d+\)/)

  const pid = runningPid(c)!
  t = io()
  expect(await botsCommand(["stop", "sup-bot"], t.io, env)).toBe(EXIT.done)
  expect(t.out()).toContain("The bot stays on")
  expect(pidIsAlive(pid)).toBe(false)
  expect(c.core.codeBots.views()[0]!.state).toBe("on")
  await until(() => c.core.codeBots.views()[0]?.connected === false)

  t = io()
  expect(await botsCommand(["start", "sup-bot"], t.io, env)).toBe(EXIT.done)
  expect(t.out()).toMatch(/"sup-bot" is running \(pid \d+\)/)
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)

  t = io()
  expect(await botsCommand(["restart", "sup-bot"], t.io, env)).toBe(EXIT.done)
  expect(t.out()).toMatch(/"sup-bot" started again \(pid \d+\)/)

  // A token for running it elsewhere: never printed, in a 0600 file the client reads from its folder.
  t = io()
  expect(await botsCommand(["token", "sup-bot"], t.io, env)).toBe(EXIT.done)
  const file = join(folder, ".harness-bot.json")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const saved = JSON.parse(readFileSync(file, "utf8")) as { token: string; socket: string }
  expect(t.out()).not.toContain(saved.token)
  expect(saved.socket).toBe(c.p.socket)
  expect(c.core.codeBots.views()[0]?.connected).toBe(false)
  const elsewhere = Bun.spawn([process.execPath, "bot.ts"], { cwd: folder, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" })
  procs.push(elsewhere)
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  t = io()
  await botsCommand(["list"], t.io, env)
  expect(t.out()).toContain("runs outside the Candle Harness: no restarts or logs here")

  t = io()
  expect(await botsCommand(["logs", "sup-bot", "-n", "50"], t.io, env)).toBe(EXIT.done)
  expect(t.out()).toContain("connected as sup-bot")
  expect(t.out()).not.toMatch(/chb_[A-Za-z0-9]{12}_/)

  t = io()
  expect(await botsCommand(["stop", "nobody"], t.io, env)).toBe(EXIT.refused)
  expect(t.err()).toContain('No code bot named "nobody". Code bots: "sup-bot".')
  t = io()
  expect(await botsCommand(["frobnicate"], t.io, env)).toBe(EXIT.usage)
}, 60_000)

test("the Bots tab's stop ends the bot's process with its trades, and putting it back on runs it again", async () => {
  const c = await startTestCore({ supervise: TUNING })
  cores.push(c)
  const view = await c.view()
  await made(c, view, botFolder())
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  const pid = runningPid(c)!
  await view.request("bots.stop", { name: "sup-bot" })
  await until(() => !pidIsAlive(pid), 10_000)
  expect(processRows(c, "stopped").at(-1)).toMatchObject({ why: "stopped" })
  await view.request("bots.resume", { name: "sup-bot" })
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  // The supervisor's state names the new process once it has written it: until then it can still name the stopped one.
  await until(() => {
    const p = runningPid(c)
    return p !== undefined && p !== pid && pidIsAlive(p)
  }, 10_000)
  // Paused, it runs on: its sells of its own still run.
  const again = runningPid(c)!
  await view.request("bots.pause", { name: "sup-bot" })
  await Bun.sleep(200)
  expect(pidIsAlive(again)).toBe(true)
}, 30_000)

test("stopping a bot's process ends its token: a copy of it still connected is cut off, and can't connect again; starting it gives a new one", async () => {
  const c = await startTestCore({ supervise: TUNING })
  cores.push(c)
  const view = await c.view()
  const folder = botFolder()
  // The bot leaves its token where the test can read it, as a child it started outside its group would hold it.
  writeFileSync(join(folder, "bot.ts"), `import { writeFileSync } from "node:fs"\nwriteFileSync("held-token.txt", process.env.CANDLE_HARNESS_BOT_TOKEN ?? "")\n${readFileSync(join(folder, "bot.ts"), "utf8")}`)
  await made(c, view, folder)
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  const token = readFileSync(join(folder, "held-token.txt"), "utf8")
  const { client: copy, response } = await c.hello(token)
  expect(response.error).toBeUndefined()
  expect((await copy.request("bot.self", {})).error).toBeUndefined()

  expect((await view.request("bots.process.stop", { name: "sup-bot" })).error).toBeUndefined()
  expect(c.core.tokens.botToken("sup-bot")).toBeUndefined()
  await until(() => c.core.codeBots.views()[0]?.connected === false)
  expect((await copy.request("bot.buy", { request: "req_copy_000001", mint: MOON, amountUsd: 1 })).error).toBeDefined()
  expect((await c.hello(token)).response.error).toBeDefined()
  expect(fileRows(c).find((r) => r.type === "bot.token" && r.what === "revoked")).toMatchObject({ name: "sup-bot", why: "process_stopped" })
  // The bot stays on, and the Bots tab no longer shows a token for it.
  expect(c.core.codeBots.views()[0]).toMatchObject({ state: "on" })
  expect(c.core.codeBots.views()[0]!.token).toBeUndefined()

  expect((await view.request("bots.process.start", { name: "sup-bot" })).error).toBeUndefined()
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  expect(readFileSync(join(folder, "held-token.txt"), "utf8")).not.toBe(token)
  expect((await c.hello(token)).response.error).toBeDefined()
}, 60_000)

test("a bot run outside keeps its token through a change of figures; a new folder or command approved withdraws it, said", async () => {
  const c = await startTestCore({ supervise: TUNING })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["bots"] })
  const folder = botFolder()
  await made(c, view, folder)
  await until(() => c.core.codeBots.views()[0]?.connected === true, 10_000)
  expect((await view.request("bots.token", { name: "sup-bot" })).error).toBeUndefined()
  const token = (JSON.parse(readFileSync(join(folder, ".harness-bot.json"), "utf8")) as { token: string }).token
  expect((await c.hello(token)).response.error).toBeUndefined()

  const minted = await c.core.tokens.mintBuild("Build pane", "momentum")
  const { client: build } = await c.hello(minted.token)
  const change = async (ask: Record<string, unknown>) => {
    const proposed = await build.request("bots.proposeCode", { name: "sup-bot", replace: true, ...ask })
    if (proposed.error) throw new Error(JSON.stringify(proposed.error))
    const card = c.core.cards.get((proposed.result as { cardId: string }).cardId)!
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
    return c.core.operations.get(card.opId)!.result as { said?: string }
  }
  // Wider figures: the same program, under the figures the core holds it to. Its token stays.
  expect((await change({ perTradeUsd: 3 })).said).toBeUndefined()
  expect((await c.hello(token)).response.error).toBeUndefined()

  // Another folder: what runs elsewhere under the old token isn't what the card showed.
  const moved = botFolder()
  const said = (await change({ folder: moved })).said
  expect(said).toContain("its token is withdrawn")
  expect(said).toContain("candle-harness bots token sup-bot")
  expect((await c.hello(token)).response.error).toBeDefined()
  expect(fileRows(c).find((r) => r.type === "bot.token" && r.what === "revoked")).toMatchObject({ name: "sup-bot", why: "new_version" })
  const lastBots = () => [...view.events].reverse().find((e) => e.topic === "bots")?.data as BotsTopic | undefined
  await until(() => /its token is withdrawn/.test(String((lastBots()?.code ?? []).find((b) => b.name === "sup-bot")?.process?.words)))
  // It isn't started here by the change: it still runs outside, until the person says otherwise.
  expect(c.core.codeBots.views()[0]).toMatchObject({ state: "on", folder: moved })
  expect(runningPid(c)).toBeUndefined()
  // A new token is written in the new folder.
  expect((await view.request("bots.token", { name: "sup-bot" })).error).toBeUndefined()
  const next = (JSON.parse(readFileSync(join(moved, ".harness-bot.json"), "utf8")) as { token: string }).token
  expect((await c.hello(next)).response.error).toBeUndefined()
}, 60_000)
