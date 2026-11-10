// A code bot's exits the core holds, on a real core: set on its buy, journalled before anything is proposed; watched
// by the triggers' watcher and sold with no card on a wallet that asks, as the bot's exit, while the bot isn't
// connected, is paused, or the kill switch is on; the bot told each one fire and how it ended; set, changed and
// cleared by the bot, removed by the person; held across a restart and sold once; and never two sells of one
// position at once, the bot's own and a held exit's.
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { AutonomyTopic } from "./autonomy"
import { candleConfigDir } from "./candle-mcp"
import type { BotsTopic } from "./bots"
import type { CodeBotProposal } from "./code-bots"
import { startCore } from "./core-main"

const MOON = "MoonFake11111111111111111111111111111111111"
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const FOLDER = "/srv/bots/momentum"
const PAPER = { name: "paper-bot", wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 }
const LIVE = { name: "live-bot", wallet: "embedded", mode: "live", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 }

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
  skew = 0
})
afterAll(() => cleanupHomes())

let n = 0
const rid = () => `req_held_${String(++n).padStart(6, "0")}`
const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const told = (client: TestClient) => client.events.filter((e) => e.topic === "bot").map((e) => e.data as Record<string, unknown>)
const calls = (p: TestCore["p"]) => {
  const file = join(candleConfigDir(p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
    : []
}
const sells = (p: TestCore["p"]) => calls(p).filter((x) => x.name === "candle_trade" && x.args.side === "sell")

/** A key's fake script, changed while the core runs: it's read on every call. */
function script(p: TestCore["p"], change: Record<string, unknown>, agent = "momentum") {
  const file = join(candleConfigDir(p.stateDir, agent), "fake-candle.json")
  const was = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
  writeFileSync(file, JSON.stringify({ ...was, ...change }))
}
const moonAt = (p: TestCore["p"], usd: number) => {
  for (const agent of ["momentum", "swing"]) script(p, { markets: [{ mint: MOON, symbol: "MOON", priceUsd: usd }] }, agent)
}

/** The watcher's clock, ahead of the wall's: moved on past a market read's 5 s so each heartbeat reads afresh. */
let skew = 0
const clock = {
  now: () => Date.now() + skew,
  schedule: (run: () => void, ms: number) => {
    const t = setTimeout(run, ms)
    return () => clearTimeout(t)
  },
}
const beat = async (c: { watchBeat(): Promise<void> }, ms = 5_000) => {
  skew += ms
  await c.watchBeat()
}

const result = <T = Record<string, unknown>>(a: Awaited<ReturnType<TestClient["request"]>>) => {
  if (a.error) throw new Error(JSON.stringify(a.error))
  return a.result as T
}

async function core(o: { inside?: boolean } = {}) {
  const c = await startTestCore({ env: process.env, triggerClock: clock })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "bots"] })
  if (o.inside) {
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
    await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  }
  const minted = await c.core.tokens.mintBuild("Build pane", "momentum")
  const { client: build } = await c.hello(minted.token)
  const probe: CodeBotProposal = { name: "probe", run: { agent: "momentum", ...PAPER, mode: "paper" } as CodeBotProposal["run"] }
  await until(() => {
    try {
      c.core.codeBots.check(probe, "momentum")
      return true
    } catch {
      return false
    }
  })
  return { c, view, build }
}

/** Proposed from the Build pane, approved by the person, then connected with its token. */
async function bot(c: TestCore, view: TestClient, build: TestClient, ask: Record<string, unknown>) {
  const proposed = await build.request("bots.proposeCode", ask)
  if (proposed.error) throw new Error(JSON.stringify(proposed.error))
  const card = c.core.cards.get((proposed.result as { cardId: string }).cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  const { token } = await c.core.codeBots.issueToken(String(ask.name), "outside")
  const { client } = await c.hello(token)
  await client.request("subscribe", { topics: ["bot"] })
  return { client, token }
}

/** A live buy of MOON with a stop the core holds, filled inside the wallet's figures; then the wallet asks every time. */
async function liveHolding(exits: Record<string, unknown> | undefined = { stop_loss_pct: 40 }) {
  const { c, view, build } = await core({ inside: true })
  const { client } = await bot(c, view, build, LIVE)
  const buy = rid()
  await client.request("bot.buy", { request: buy, mint: MOON, amountUsd: 1, ...(exits ? { exits } : {}) })
  await until(() => told(client).some((t) => t.kind === "request" && t.request === buy && t.state === "filled"))
  if (exits) await until(() => c.core.botExits.tokens().length === 1)
  await view.request("autonomy.set", { wallet: "embedded", setting: "ask" })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "ask")
  const { positions } = result<{ positions: { id: string; exits: unknown }[] }>(await client.request("bot.positions", {}))
  return { c, view, client, buy, position: positions[0]! }
}

test("a live buy carrying a stop: recorded with it before anything's proposed; on a wallet that asks, the core sells with no card as the bot's exit, and the bot hears it fire and fill", async () => {
  const { c, client, buy, position } = await liveHolding()
  const rows = c.core.journal.rows()
  const recorded = rows.findIndex((r) => r.type === "bot.request" && r.request === buy)
  expect(rows[recorded]).toMatchObject({ exits: { stop_loss_pct: 40 }, words: expect.stringContaining("the core holds its exits: sells at -40%") })
  expect(rows.findIndex((r) => r.type === "card.created" && r.botRequest === buy)).toBeGreaterThan(recorded)
  expect(position.exits).toEqual({ stop_loss_pct: 40, by: "buy" })

  moonAt(c.p, 0.0001)
  await beat(c.core)
  await until(() => sells(c.p).length === 1)
  const all = c.core.journal.rows()
  const exiting = all.findIndex((r) => r.type === "bot.exiting")
  expect(all[exiting]).toMatchObject({ kind: "code", name: "live-bot", position: position.id, reason: "stop_loss" })
  expect(all.findIndex((r) => r.type === "card.created" && r.botAct === "exit")).toBeGreaterThan(exiting)
  expect(all.find((r) => r.type === "card.approved" && r.botAct === "exit")).toMatchObject({ how: "bot-exit", botKind: "code" })
  expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval")).toHaveLength(0)
  await until(() => told(client).some((t) => t.kind === "exit" && t.state === "sold"))
  const heard = told(client).filter((t) => t.kind === "exit")
  expect(heard.map((t) => t.state)).toEqual(["selling", "sold"])
  expect(heard[1]).toMatchObject({ position: position.id, mint: MOON, reason: "stop_loss", words: expect.stringContaining("sold at its stop, by the exits the core held") })
  expect(result<{ fills: Record<string, unknown>[] }>(await client.request("bot.fills", {})).fills.find((f) => f.side === "sell")).toMatchObject({ position: position.id, exit: "stop_loss" })
  expect(result<{ positions: unknown[] }>(await client.request("bot.positions", {})).positions).toHaveLength(0)
  // Sold once: the next heartbeats sell nothing more.
  await beat(c.core)
  await Bun.sleep(200)
  expect(sells(c.p)).toHaveLength(1)
})

test("not connected, paused and with the kill switch on, a held max hold still sells, on paper", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  const bought = result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1, exits: { max_hold_hours: 1 } }))
  expect(bought).toMatchObject({ state: "filled" })
  client.close()
  await view.request("bots.pause", { name: PAPER.name })
  await view.request("kill", {})
  await until(() => c.core.botExits.tokens().length === 1)
  await beat(c.core)
  await Bun.sleep(200)
  expect(sells(c.p)).toHaveLength(0)
  await beat(c.core, 3_600_000)
  await until(() => sells(c.p).length === 1)
  expect(sells(c.p)[0]!.args).toMatchObject({ mint: MOON, side: "sell", paper: true })
  expect(c.core.journal.rows().find((r) => r.type === "bot.exiting")).toMatchObject({ kind: "code", name: PAPER.name, reason: "max_hold", botMode: "paper" })
  await until(() => c.core.botExits.tokens().length === 0)
})

test("the bot sets, changes and clears them on a position it holds; what it can't set is refused, and a buy with a bad one sends nothing", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  // A bad one on a buy: refused before anything's recorded, so its id is free.
  const id = rid()
  const bad = await client.request("bot.buy", { request: id, mint: MOON, amountUsd: 1, exits: { stop_loss_pct: 20, exit_on_signal: true } })
  expect(bad.error?.data?.code).toBe("INVALID_PARAMS")
  expect(bad.error?.message).toContain("exit_on_signal isn't held by the core")
  expect(calls(c.p).filter((x) => x.name === "candle_trade")).toHaveLength(0)
  result(await client.request("bot.buy", { request: id, mint: MOON, amountUsd: 1 }))
  const { positions } = result<{ positions: { id: string; exits: unknown }[] }>(await client.request("bot.positions", {}))
  expect(positions[0]!.exits).toBeNull()
  const position = positions[0]!.id

  expect(result(await client.request("bot.exits", { position, exits: { stop_loss_pct: 20 } }))).toMatchObject({ position, exits: { stop_loss_pct: 20 }, words: "MOON: the core holds its exits: sells at -20%." })
  expect(result(await client.request("bot.exits", { mint: MOON, exits: { take_profit_pct: 50, max_hold_hours: 2 } }))).toMatchObject({ exits: { take_profit_pct: 50, max_hold_hours: 2 } })
  expect(result<{ positions: { exits: unknown }[] }>(await client.request("bot.positions", {})).positions[0]!.exits).toEqual({ take_profit_pct: 50, max_hold_hours: 2, by: "bot" })
  expect(c.core.botExits.tokens()).toEqual([MOON])

  expect((await client.request("bot.exits", { position, exits: { ladder: { sell_aggregate: 1 } } })).error?.data?.code).toBe("INVALID_PARAMS")
  expect((await client.request("bot.exits", { position, exits: { stop_loss_pct: 20 }, wallet: FAKE_WALLET })).error?.data?.code).toBe("RUN_SETTINGS_FIXED")
  expect((await client.request("bot.exits", { position: "op_not_its_own", exits: { stop_loss_pct: 20 } })).error?.data?.code).toBe("NOT_ITS_POSITION")
  expect((await client.request("bot.exits", { position })).error?.data?.code).toBe("INVALID_PARAMS")

  expect(result(await client.request("bot.exits", { position, exits: null }))).toMatchObject({ exits: null, words: expect.stringContaining("its own code sells it") })
  expect(c.core.botExits.tokens()).toEqual([])
  expect(result(await client.request("bot.exits", { position, exits: null }))).toMatchObject({ words: expect.stringContaining("nothing to clear") })
  // Its max hold, cleared, sells nothing.
  await beat(c.core, 3 * 3_600_000)
  await Bun.sleep(200)
  expect(sells(c.p)).toHaveLength(0)
})

test("the person removes them from the main window and the bot hears it; the stop sells nothing then; removing the bot says its held exits end", async () => {
  const { c, view, client, position } = await liveHolding()
  const removed = result(await view.request("bots.exits.remove", { name: LIVE.name, position: position.id }))
  expect(removed).toMatchObject({ said: expect.stringContaining("its own code sells it from now on") })
  await until(() => told(client).some((t) => t.kind === "exits" && t.by === "person"))
  expect(c.core.journal.rows().find((r) => r.type === "bot.exits_set")).toMatchObject({ by: "person", exits: null, name: LIVE.name })
  moonAt(c.p, 0.0001)
  await beat(c.core)
  await Bun.sleep(300)
  expect(sells(c.p)).toHaveLength(0)
  // Set again by the bot, then the bot removed: its held exits end with it, and nothing sells.
  result(await client.request("bot.exits", { position: position.id, exits: { stop_loss_pct: 99 } }))
  const gone = result(await view.request("bots.remove", { name: LIVE.name, positions: "leave" }))
  expect(gone).toMatchObject({ said: expect.stringContaining("The exits the core held on it end with the bot.") })
  await beat(c.core)
  await Bun.sleep(300)
  expect(sells(c.p)).toHaveLength(0)
})

test("never two sells of one position at once: a held exit selling refuses the bot's own sell, and the bot's own under way holds the exit", async () => {
  const { c, client, position } = await liveHolding()
  script(c.p, { tools: { candle_trade: "hang" } })
  moonAt(c.p, 0.0001)
  await beat(c.core)
  await until(() => sells(c.p).length === 1)
  const own = await client.request("bot.sell", { request: rid(), position: position.id })
  expect(own.error?.data?.code).toBe("SELL_UNDER_WAY")
  expect(own.error?.message).toContain("An exit the core holds is selling")
  expect(result<{ positions: { exiting?: boolean }[] }>(await client.request("bot.positions", {})).positions[0]!.exiting).toBe(true)
  await beat(c.core)
  await Bun.sleep(200)
  expect(sells(c.p)).toHaveLength(1)
})

test("the bot's own sell under way: its held exit waits for it", async () => {
  const { c, client, position } = await liveHolding({ take_profit_pct: 100 })
  // A reading first, far under its take profit: the token's decimals, so the wallet sells the bot's own by amount.
  moonAt(c.p, 0.0001)
  await beat(c.core)
  script(c.p, { tools: { candle_trade: "hang" } })
  // A part, so the position stays open while its sell hangs.
  void client.request("bot.sell", { request: rid(), position: position.id, percent: 50 })
  await until(() => sells(c.p).length === 1)
  moonAt(c.p, 1_000)
  await beat(c.core)
  await beat(c.core)
  await Bun.sleep(300)
  expect(sells(c.p)).toHaveLength(1)
  expect(c.core.journal.rows().filter((r) => r.type === "bot.exiting")).toHaveLength(0)
})

test("a restart: a buy's exits hold from the journal, with no bot connected, and sell once", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1, exits: { max_hold_hours: 1 } }))
  const p = c.p
  cores.splice(cores.indexOf(c), 1)
  await c.close()
  const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true, triggerClock: clock })
  try {
    await again.candleReady
    await until(() => ["pro", "max"].includes(String(again.plans.planFor("momentum").plan)))
    expect(again.botExits.tokens()).toEqual([MOON])
    await beat(again, 3_600_000)
    await until(() => sells(p).length === 1)
    await beat(again)
    await Bun.sleep(300)
    expect(sells(p)).toHaveLength(1)
  } finally {
    await again.stop("test")
  }
})

test("the Bots tab's book: a position the core holds exits on carries them as prices, one its code sells carries none; today's use beside the day figure", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  moonAt(c.p, 0.01)
  const held = rid()
  result(await client.request("bot.buy", { request: held, mint: MOON, amountUsd: 1, exits: { stop_loss_pct: 40, take_profit_pct: 50, max_hold_hours: 24 } }))
  await until(() => told(client).some((t) => t.kind === "request" && t.request === held && t.state === "filled"))
  const plain = rid()
  result(await client.request("bot.buy", { request: plain, mint: MOON, amountUsd: 1.5 }))
  await until(() => told(client).some((t) => t.kind === "request" && t.request === plain && t.state === "filled"))
  const topic = result<BotsTopic>(await view.request("bots.list", {}))
  const me = topic.code!.find((b) => b.name === "paper-bot")!
  expect(me.usedTodayUsd).toBe(2.5)
  expect(me.heldExits).toHaveLength(1)
  const open = topic.books!["paper-bot"]!.open
  expect(open).toHaveLength(2)
  const guarded = open.find((p) => p.id === me.heldExits![0]!.position)!
  const own = open.find((p) => p.id !== guarded.id)!
  expect(guarded.holdUntil).toBeDefined()
  expect(guarded.entryUsd).toBeGreaterThan(0)
  expect(guarded.stopUsd! / guarded.entryUsd!).toBeCloseTo(0.6, 4)
  expect(guarded.targetUsd! / guarded.entryUsd!).toBeCloseTo(1.5, 4)
  expect(own.stopUsd).toBeUndefined()
  expect(own.targetUsd).toBeUndefined()
  expect(own.holdUntil).toBeUndefined()
})

test("the Bots tab's price for a code bot's position follows each heartbeat, with nothing else changing", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  moonAt(c.p, 0.01)
  const held = rid()
  result(await client.request("bot.buy", { request: held, mint: MOON, amountUsd: 1, exits: { stop_loss_pct: 40 } }))
  await until(() => told(client).some((t) => t.kind === "request" && t.request === held && t.state === "filled"))
  await beat(c.core)
  await until(() => lastOf<BotsTopic>(view, "bots")?.books?.["paper-bot"]?.open[0]?.nowUsd === 0.01)
  // Only the price moves: no bot row, no report. The next heartbeat's read reaches the view.
  moonAt(c.p, 0.012)
  await beat(c.core)
  await until(() => lastOf<BotsTopic>(view, "bots")?.books?.["paper-bot"]?.open[0]?.nowUsd === 0.012, 3_000)
})

test("a held exit's sell that fills is off the Bots topic at once: no position left saying an exit is selling it", async () => {
  const { c, view } = await liveHolding()
  script(c.p, { sellDelayMs: 800 })
  moonAt(c.p, 0.0001)
  await beat(c.core)
  await until(() => c.core.journal.rows().some((r) => r.type === "operation.succeeded" && c.core.cards.held(String(r.opId))?.origin.bot?.act === "exit"))
  const filledAt = Date.now()
  await until(() => (lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === "live-bot")?.heldExits ?? []).length === 0, 1_000)
  expect(Date.now() - filledAt).toBeLessThan(1_000)
}, 20_000)
