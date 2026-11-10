// The bot protocol on a real core, over its socket, with a code bot's token: its buys, sells and swaps, each with its
// own request id, as the core's own proposal with its card's run settings; its figures; its wallet by side; selling
// only its own; nothing sent twice for one id across a lost answer or a restart; the kill switch; what it's told;
// and its reads, never another's.
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { type FakeHacc, startFakeHacc } from "../../test/fake-hacc"
import { connectTestClient, type TestClient } from "../../test/core-test-client"
import { PROTOCOL_VERSION } from "../shared/rpc"
import type { AutonomyTopic } from "./autonomy"
import type { BotsTopic } from "./bots"
import { botClient } from "./bot-trades"
import { normaliseForMode } from "./classify"
import { candleConfigDir } from "./candle-mcp"
import type { CodeBotProposal } from "./code-bots"
import { startCore } from "./core-main"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
/** A token the embedded wallet holds only what's bought of it (the fake's anyMint): the bot's own is the whole balance. */
const FRESH = "CodeFake11111111111111111111111111111111111"
const ANY = { momentum: { anyMint: { priceUsd: 0.01 } }, swing: { anyMint: { priceUsd: 0.01 } } }
const FOLDER = "/srv/bots/momentum"
const PAPER = { name: "paper-bot", wallet: "embedded", mode: "paper", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 }
const LIVE = { name: "live-bot", wallet: "embedded", mode: "live", folder: FOLDER, command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 5, maxOpen: 2, maxSlippageBps: 150 }

const cores: TestCore[] = []
const haccs: FakeHacc[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
  for (const h of haccs.splice(0)) h.stop()
})
afterAll(() => cleanupHomes())

let n = 0
const rid = () => `req_test_${String(++n).padStart(6, "0")}`
const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const told = (client: TestClient) => client.events.filter((e) => e.topic === "bot").map((e) => e.data as Record<string, unknown>)
function calls(p: TestCore["p"]) {
  const file = join(candleConfigDir(p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
    : []
}
const trades = (p: TestCore["p"]) => calls(p).filter((x) => x.name === "candle_trade" || x.name === "candle_swap")

async function core(opts: Parameters<typeof startTestCore>[0] = {}, home: Parameters<typeof startTestCore>[1] = {}) {
  const c = await startTestCore({ env: process.env, ...opts }, home)
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "bots"] })
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

const result = <T = Record<string, unknown>>(a: Awaited<ReturnType<TestClient["request"]>>) => {
  if (a.error) throw new Error(JSON.stringify(a.error))
  return a.result as T
}

test("a paper buy fills as the bot's own, once for its id; its book is the core's count; a part sold keeps the rest; over what it holds sells what it holds", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  const id = rid()
  const bought = result(await client.request("bot.buy", { request: id, mint: MOON, amountUsd: 1.5 }))
  expect(bought).toMatchObject({ request: id, side: "buy", state: "filled", mint: MOON, usd: 1.5 })
  // Asked again under the same id: what became of it, and nothing sent again.
  expect(result(await client.request("bot.buy", { request: id, mint: MOON, amountUsd: 1.5 }))).toMatchObject({ request: id, state: "filled" })
  expect(result(await client.request("bot.request", { request: id }))).toMatchObject({ state: "filled" })
  expect(trades(c.p)).toHaveLength(1)
  expect(trades(c.p)[0]!.args).toMatchObject({ mint: MOON, side: "buy", paper: true })
  // Recorded before it was proposed, and its rows say whose it was.
  const rows = c.core.journal.rows()
  const recorded = rows.findIndex((r) => r.type === "bot.request" && r.request === id)
  const paper = rows.findIndex((r) => r.type === "paper.call" && r.botRequest === id)
  expect(recorded).toBeGreaterThanOrEqual(0)
  expect(paper).toBeGreaterThan(recorded)
  expect(rows[paper]).toMatchObject({ bot: "paper-bot", botKind: "code", botAct: "entry" })

  const { positions } = result<{ positions: { id: string; tokens: string; tokensLeft: string }[] }>(await client.request("bot.positions", {}))
  expect(positions).toHaveLength(1)
  const pos = positions[0]!
  expect(result<{ fills: unknown[] }>(await client.request("bot.fills", {})).fills).toEqual([expect.objectContaining({ side: "buy", request: id, mint: MOON })])

  // Half of it: the position stays open with the rest.
  const half = result(await client.request("bot.sell", { request: rid(), position: pos.id, percent: 50 }))
  expect(half).toMatchObject({ side: "sell", state: "filled", position: pos.id })
  const after = result<{ positions: { id: string; tokensLeft: string }[] }>(await client.request("bot.positions", {})).positions
  expect(after).toHaveLength(1)
  expect(Number(after[0]!.tokensLeft)).toBeCloseTo(Number(pos.tokens) / 2, 4)
  // More than it holds: it sells what it holds, and says so.
  const all = result(await client.request("bot.sell", { request: rid(), mint: MOON, amount: "999999" }))
  expect(all).toMatchObject({ state: "filled", words: expect.stringContaining("so it sells that") })
  expect(result<{ positions: unknown[] }>(await client.request("bot.positions", {})).positions).toHaveLength(0)
  expect((await client.request("bot.sell", { request: rid(), mint: MOON })).error?.data?.code).toBe("NOTHING_TO_SELL")
})

test("its figures: a trade's, a day's and open at most, each refused with which one, nothing sent, the id left free", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  const over = await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 2.5 })
  expect(over.error?.data?.code).toBe("FIGURE_TRADE")
  expect(over.error?.message).toContain("over its $2.00 a trade")
  expect(trades(c.p)).toHaveLength(0)
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 2 }))
  result(await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 2 }))
  // Two open, its two at most.
  expect((await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 0.5 })).error?.data?.code).toBe("FIGURE_OPEN")
  result(await client.request("bot.sell", { request: rid(), mint: PEPE }))
  // $4 of $5 today: $1.50 more is over the day.
  const day = await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 1.5 })
  expect(day.error?.data?.code).toBe("FIGURE_DAY")
  expect(day.error?.message).toContain("$5.50, over its $5.00 a day")
  expect(trades(c.p)).toHaveLength(3)
  // A refused id is free: nothing was recorded for it.
  const free = rid()
  expect((await client.request("bot.buy", { request: free, mint: PEPE, amountUsd: 9 })).error?.data?.code).toBe("FIGURE_TRADE")
  expect(result(await client.request("bot.request", { request: free }))).toMatchObject({ state: "unknown" })
  expect(result(await client.request("bot.buy", { request: free, mint: PEPE, amountUsd: 1 }))).toMatchObject({ state: "filled" })
  // Each refusal journalled, once a minute per kind.
  expect(c.core.journal.rows().filter((r) => r.type === "bot.refused").map((r) => r.code)).toEqual(["FIGURE_TRADE", "FIGURE_OPEN", "FIGURE_DAY"])
})

test("a request can't name its mode, wallet, slippage or agent: they're its card's, on every trade", async () => {
  const { c, view, build } = await core()
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client } = await bot(c, view, build, LIVE)
  for (const field of ["mode", "paper", "wallet", "maxSlippageBps", "slippageBps", "agent", "clientTradeId"]) {
    const value = field === "maxSlippageBps" || field === "slippageBps" ? 5000 : field === "paper" ? true : field === "mode" ? "paper" : "swing"
    const a = await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1, [field]: value })
    expect(`${field}: ${a.error?.data?.code}`).toBe(`${field}: RUN_SETTINGS_FIXED`)
  }
  expect(trades(c.p)).toHaveLength(0)
  // The trade it asks for runs with its card's: live, its wallet, its slippage, its agent's key.
  const id = rid()
  expect(result(await client.request("bot.buy", { request: id, mint: MOON, amountUsd: 1 }))).toMatchObject({ state: expect.stringMatching(/sent|filled/) })
  const card = c.core.cards.list().find((x) => x.origin.bot?.request === id)!
  expect(card).toMatchObject({ agent: "momentum", mode: "live", origin: { role: "core", bot: { name: "live-bot", kind: "code", act: "entry", mode: "live", slippageBps: 150, request: id } } })
  expect(card.wallet).toBe(FAKE_WALLET)
  expect(card.params).toMatchObject({ maxSlippageBps: 150 })
  expect(trades(c.p).at(-1)!.args).toMatchObject({ side: "buy", maxSlippageBps: 150 })
  expect(trades(c.p).at(-1)!.args.paper).toBeUndefined()
  expect(c.core.journal.rows().find((r) => r.type === "card.approved" && r.cardId === card.cardId)).toMatchObject({ how: "inside-limits" })
})

test("on a wallet that asks, a buy waits for the person and the bot hears how it ended; its sell of its own runs with no card", async () => {
  const { c, view, build } = await core({}, { candle: ANY })
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client } = await bot(c, view, build, LIVE)
  const first = rid()
  await client.request("bot.buy", { request: first, mint: FRESH, amountUsd: 1 })
  await until(() => told(client).some((t) => t.kind === "request" && t.request === first && t.state === "filled"))
  // Now the wallet asks every time.
  await view.request("autonomy.set", { wallet: "embedded", setting: "ask" })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "ask")
  const second = rid()
  const waiting = result(await client.request("bot.buy", { request: second, mint: PEPE, amountUsd: 1 }))
  // Read before a matcher: Bun's toMatchObject writes its matchers into the object it reads.
  const cardId = String(waiting.cardId)
  expect(cardId).toStartWith("card_")
  expect(waiting).toMatchObject({ state: "waiting", words: expect.stringContaining("asks every time") })
  await view.request("cards.reject", { cardId })
  await until(() => told(client).some((t) => t.kind === "request" && t.request === second && t.state === "rejected"))
  expect(result(await client.request("bot.request", { request: second }))).toMatchObject({ state: "rejected", words: expect.stringContaining("rejected its card, so nothing was sent") })

  // Its sell of its own: no card on a wallet that asks, approved as its exit.
  const sell = rid()
  await client.request("bot.sell", { request: sell, mint: FRESH })
  await until(() => told(client).some((t) => t.kind === "request" && t.request === sell && t.state === "filled"))
  const card = c.core.cards.list().find((x) => x.origin.bot?.request === sell)!
  expect(c.core.journal.rows().find((r) => r.type === "card.approved" && r.cardId === card.cardId)).toMatchObject({ how: "bot-exit" })
  expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval")).toHaveLength(0)
  // The wallet held only what the bot bought: all of it is its own.
  const sold = trades(c.p).filter((x) => x.args.side === "sell")
  expect(sold).toHaveLength(1)
  expect(sold[0]!.args).toMatchObject({ mint: FRESH, percent: 100 })
})

test("on a wallet others trade from, it sells only its own share; under 1% of a wallet that sells by percent, it sells nothing and says why", async () => {
  const { c, view, build } = await core()
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client } = await bot(c, view, build, LIVE)
  const buy = rid()
  await client.request("bot.buy", { request: buy, mint: MOON, amountUsd: 1 })
  await until(() => told(client).some((t) => t.kind === "request" && t.request === buy && t.state === "filled"))
  // The wallet holds 12,345 MOON of the person's: the bot's $1 is under 1% of it.
  const sell = await client.request("bot.sell", { request: rid(), mint: MOON })
  expect(sell.error?.data?.code).toBe("NOTHING_TO_SELL")
  expect(sell.error?.message).toContain("under 1% of what the wallet holds")
  expect(trades(c.p).filter((x) => x.args.side === "sell")).toHaveLength(0)
})



test("the kill switch holds its buys and swaps, lets its sell through, and tells it; a pause tells it too", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  await view.request("kill", {})
  await until(() => told(client).some((t) => t.kind === "kill" && t.paused === true))
  expect((await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 1 })).error?.data?.code).toBe("PAUSED")
  expect(result(await client.request("bot.sell", { request: rid(), mint: MOON }))).toMatchObject({ state: "filled" })
  await view.request("resume", {})
  await until(() => told(client).some((t) => t.kind === "kill" && t.paused === false))

  await view.request("bots.pause", { name: PAPER.name })
  await until(() => told(client).some((t) => t.kind === "state" && t.state === "paused"))
  expect((await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 1 })).error?.data?.code).toBe("BUYS_HELD")
  await view.request("bots.resume", { name: PAPER.name })
  await until(() => told(client).some((t) => t.kind === "state" && t.state === "on"))
})

test("a lost answer asked again under its id is one trade; a request recorded but never sent is lost after a restart; a filled one stays filled", async () => {
  const { c, view, build } = await core()
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client, token } = await bot(c, view, build, LIVE)
  // The connection drops before the answer: asked again, under the same id, on a new connection.
  const id = rid()
  client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 999, method: "bot.buy", params: { request: id, mint: MOON, amountUsd: 1 } })}\n`)
  client.close()
  const { client: again } = await c.hello(token)
  await until(() => c.core.journal.rows().some((r) => r.type === "bot.request" && r.request === id))
  const answer = result(await again.request("bot.buy", { request: id, mint: MOON, amountUsd: 1 }))
  expect(answer.request).toBe(id)
  await until(() => c.core.journal.rows().some((r) => r.type === "operation.succeeded" && c.core.cards.list().some((x) => x.opId === r.opId && x.origin.bot?.request === id)))
  expect(trades(c.p).filter((x) => x.args.side === "buy")).toHaveLength(1)

  // A request the core recorded, then stopped before it was sent.
  const lost = rid()
  await c.core.journal.append({ type: "bot.request", mode: "live", kind: "code", agent: "momentum", name: LIVE.name, request: lost, side: "buy", mint: PEPE, usd: 1, botMode: "live", wallet: "embedded", words: "buys $1.00 of PEPE" })
  const p = c.p
  cores.splice(cores.indexOf(c), 1)
  await c.close()
  const restarted = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
  try {
    await restarted.candleReady
    const client2 = await connectTestClient(p.socket)
    expect((await client2.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "test" })).result).toMatchObject({ role: "bot" })
    expect(result(await client2.request("bot.request", { request: lost }))).toMatchObject({ state: "lost", words: expect.stringContaining("nothing was sent") })
    expect(result(await client2.request("bot.buy", { request: lost, mint: PEPE, amountUsd: 1 }))).toMatchObject({ state: "lost" })
    expect(result(await client2.request("bot.request", { request: id }))).toMatchObject({ state: "filled" })
    expect(result(await client2.request("bot.buy", { request: id, mint: MOON, amountUsd: 1 }))).toMatchObject({ state: "filled" })
    expect(trades(p).filter((x) => x.args.side === "buy")).toHaveLength(1)
    expect(restarted.journal.rows().filter((r) => r.type === "bot.request_ended" && r.request === lost)).toHaveLength(1)
    client2.close()
  } finally {
    await restarted.stop("test")
  }
})

test("it sells only its own: another bot's position is refused; a swap is valued and held to its figures; paper has no swaps", async () => {
  const { c, view, build } = await core()
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client: paper } = await bot(c, view, build, PAPER)
  const { client: live } = await bot(c, view, build, LIVE)
  result(await paper.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  const theirs = result<{ positions: { id: string }[] }>(await paper.request("bot.positions", {})).positions[0]!.id
  expect((await live.request("bot.sell", { request: rid(), position: theirs })).error?.data?.code).toBe("NOT_ITS_POSITION")
  expect((await live.request("bot.sell", { request: rid(), mint: MOON })).error?.data?.code).toBe("NOTHING_TO_SELL")
  expect(result<{ positions: unknown[] }>(await live.request("bot.positions", {})).positions).toEqual([])

  expect((await paper.request("bot.swap", { request: rid(), from: "SOL", to: "USDC", amount: "0.01" })).error?.data?.code).toBe("NO_PAPER_SWAPS")
  // 0.05 SOL at $150 is $7.50: inside the agent's own $10, over the bot's $2 a trade, withdrawn before it ran.
  const big = result(await live.request("bot.swap", { request: rid(), from: "SOL", to: "USDC", amount: "0.05" }))
  expect(big).toMatchObject({ state: "refused", code: "FIGURE_TRADE" })
  expect(trades(c.p).filter((x) => x.name === "candle_swap")).toHaveLength(0)
  const small = result(await live.request("bot.swap", { request: rid(), from: "SOL", to: "USDC", amount: "0.01" }))
  expect(small).toMatchObject({ state: expect.stringMatching(/sent|filled/), usd: 1.5 })
  await until(() => trades(c.p).some((x) => x.name === "candle_swap"))
})

test("its reads: Candle's market read reused under 4.5 s; Hacc's reads its plan offers, never a change; the Bots tab says whether it's connected", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  const before = calls(c.p).filter((x) => x.name === "candle_get_market" && x.args.mint === PEPE).length
  const m = result<{ market: { mint: string } }>(await client.request("bot.market", { mint: PEPE }))
  expect(m.market.mint).toBe(PEPE)
  await client.request("bot.market", { mint: PEPE })
  expect(calls(c.p).filter((x) => x.name === "candle_get_market" && x.args.mint === PEPE).length - before).toBe(1)
  // Hacc off in this config: said so.
  expect((await client.request("bot.hacc", { tool: "hacc_signals", view: "tape" })).error?.data?.code).toBe("HACC_OFF")

  await until(() => lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === PAPER.name)?.connected === true)
  client.close()
  await until(() => lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === PAPER.name)?.connected === false)
})

test("no answer to a bot carries a key; its connection is told the core is stopping", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  await client.request("bot.positions", {})
  await client.request("bot.fills", {})
  await client.request("bot.market", { mint: MOON })
  const keys = readFileSync(c.p.keyFile("momentum"), "utf8").trim()
  expect(client.frames.join("\n")).not.toContain(keys)
  expect(client.frames.join("\n")).not.toMatch(/cndl_(live|test)_/)
  cores.splice(cores.indexOf(c), 1)
  const stopping = c.core.stop("test")
  await until(() => told(client).some((t) => t.kind === "stopping"))
  await stopping
})

test("Hacc: its agent's plan's reads with its agent's key, never a change or a read the plan doesn't offer; the tape as it arrives", async () => {
  const hacc = startFakeHacc({ keys: [AGENT_KEY], plan: "pro" })
  haccs.push(hacc)
  const { c, view, build } = await core({ haccHost: hacc.url }, { config: { hacc: { enabled: true } } })
  const { client } = await bot(c, view, build, PAPER)
  const tape = result<Record<string, unknown>>(await client.request("bot.hacc", { tool: "hacc_signals", view: "tape", limit: 5 }))
  expect(tape).toMatchObject({ success: true })
  // A change is the person's or the agent's, never a bot's.
  expect((await client.request("bot.hacc", { tool: "hacc_follows", view: "follow", address: FAKE_WALLET })).error?.data?.code).toBe("READS_ONLY")
  expect(hacc.calls.filter((x) => x.method !== "GET")).toEqual([])
  // Pro doesn't offer the strategy lab.
  expect((await client.request("bot.hacc", { tool: "hacc_lab", view: "strategies" })).error?.data?.code).toBe("NOT_OFFERED")
  // Subscribed to the tape, a new row reaches it.
  await client.request("subscribe", { topics: ["signals"] })
  await until(() => client.events.some((e) => e.topic === "signals"))
  hacc.push({ pattern: "confluence", asset_address: MOON, asset_chain: "solana" })
  await until(() => client.events.some((e) => e.topic === "signals" && JSON.stringify(e.data).includes(MOON)))
})

test("Candle's breaker: past the pace its buy is refused with when to ask again, and nothing sent; its sell still has room", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  // Other bots' and triggers' buys fill the pace's room for buys on this key.
  while (c.core.tradePace.take("momentum", Date.now(), "buy").ok) {}
  const sent = trades(c.p).length
  const held = await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 1 })
  expect(held.error?.data).toMatchObject({ code: "BREAKER_PACE", retryAt: expect.any(String) })
  expect(trades(c.p)).toHaveLength(sent)
  expect(result(await client.request("bot.sell", { request: rid(), mint: MOON }))).toMatchObject({ state: "filled" })
})

test("a plan that ends holds a connected bot's buys, its sells still run, and it's told", async () => {
  let now = Date.now()
  const { c, view, build } = await core({ now: () => now })
  const { client } = await bot(c, view, build, PAPER)
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  for (const agent of ["momentum", "swing"]) {
    const file = join(candleConfigDir(c.p.stateDir, agent), "fake-candle.json")
    const was = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
    await Bun.write(file, JSON.stringify({ ...was, tier: "free" }))
  }
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => told(client).some((t) => t.kind === "state" && t.buys === false && (t.held as { code?: string } | undefined)?.code === "PLAN_FREE"))
  expect((await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 1 })).error?.data?.code).toBe("BUYS_HELD")
  // The Bots tab still shows it and what it holds, under the plan's words: what it bought is still its own.
  const free = result<BotsTopic>(await view.request("bots.list", {}))
  expect(free.gate?.plan).toBe("free")
  expect(free.code?.map((b) => b.name)).toEqual([PAPER.name])
  expect(free.books?.[PAPER.name]?.open).toHaveLength(1)
  expect(result(await client.request("bot.sell", { request: rid(), mint: MOON }))).toMatchObject({ state: "filled" })
})

test("its own report: kept beside the core's count and shown as what the bot says; never its figures; only its own", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  const { client: other } = await bot(c, view, build, { ...PAPER, name: "other-bot" })
  result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1.5 }))
  const kept = result<{ events: number }>(
    await client.request("bot.report", {
      status: "watching 14 tokens",
      health: "warn",
      alerts: [{ code: "quotes", text: "quotes failing on 2 tokens" }],
      rules: ["Buys $1.50 on a fresh launch under $300K"],
      counts: { watching: 14 },
      events: [{ id: "e1", kind: "entered", text: "MOON: fresh launch, $210K", mint: MOON }],
    }),
  )
  expect(kept.events).toBe(1)
  // On the Bots topic, as what it says, beside the core's own count.
  await until(() => lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === PAPER.name)?.says !== undefined)
  const shown = lastOf<BotsTopic>(view, "bots")!.code!
  expect(shown.find((b) => b.name === PAPER.name)!.says).toMatchObject({ status: "watching 14 tokens", health: "warn", events: [{ id: "e1", kind: "entered", mint: MOON }] })
  expect(shown.find((b) => b.name === "other-bot")!.says).toBeUndefined()
  // Its figures are the core's: a report naming them is refused, and nothing of it kept.
  expect((await client.request("bot.report", { status: "up 40%", pnl: 4.2 })).error?.data?.code).toBe("REPORT_FIGURES")
  expect((await client.request("bot.report", { positions: [{ mint: MOON, value: 100 }] })).error?.data?.code).toBe("REPORT_FIGURES")
  expect(c.core.codeBots.views().length).toBe(2)
  await Bun.sleep(1_100)
  expect(lastOf<BotsTopic>(view, "bots")!.code!.find((b) => b.name === PAPER.name)!.says!.status).toBe("watching 14 tokens")
  // Another bot reports only for itself, and a view or the agent can't report at all.
  result(await other.request("bot.report", { status: "idle" }))
  await until(() => lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === "other-bot")?.says?.status === "idle")
  expect(lastOf<BotsTopic>(view, "bots")!.code!.find((b) => b.name === PAPER.name)!.says!.status).toBe("watching 14 tokens")
  expect((await view.request("bot.report", { status: "x" })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  // What it said isn't journalled: its trades are, as the core's own rows.
  expect(c.core.journal.rows().some((r) => JSON.stringify(r).includes("watching 14 tokens"))).toBe(false)
})

test("a change approved withdraws a buy the bot asked for under the version before, still waiting for the person; the bot hears why, and the change's row says what changed", async () => {
  const { c, view, build } = await core({}, { candle: ANY })
  const { client } = await bot(c, view, build, LIVE)
  const asked = rid()
  const waiting = result(await client.request("bot.buy", { request: asked, mint: PEPE, amountUsd: 1 }))
  const cardId = String(waiting.cardId)
  expect(c.core.cards.get(cardId)?.state).toBe("awaiting_approval")

  const proposed = result<{ cardId: string }>(await build.request("bots.proposeCode", { name: LIVE.name, replace: true, mode: "paper" }))
  const card = c.core.cards.get(proposed.cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  await until(() => c.core.cards.get(cardId)?.state === "withdrawn")
  await until(() => told(client).some((t) => t.kind === "request" && t.request === asked && t.state === "withdrawn"))
  const r = result<{ state: string; words: string }>(await client.request("bot.request", { request: asked }))
  expect(r.words).toContain("when a change to the bot was approved")
  expect(trades(c.p).filter((x) => x.args.mint === PEPE)).toHaveLength(0)
  const changed = c.core.journal.rows().find((row) => row.type === "bot.changed" && row.name === LIVE.name)!
  expect(changed.changed).toEqual(["paper, from live"])
  expect(String(changed.words)).toStartWith("Changed: paper, from live. ")
})

test("a bot moved from live to paper starts a paper day of its own: its live buys don't count against its paper figure", async () => {
  const { c, view, build } = await core({}, { candle: ANY })
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client } = await bot(c, view, build, LIVE)
  for (const mint of [FRESH, PEPE]) {
    const id = rid()
    await client.request("bot.buy", { request: id, mint, amountUsd: 2 })
    await until(() => told(client).some((t) => t.kind === "request" && t.request === id && t.state === "filled"))
  }
  await until(() => lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === LIVE.name)?.usedTodayUsd === 4)
  const proposed = result<{ cardId: string }>(await build.request("bots.proposeCode", { name: LIVE.name, replace: true, mode: "paper" }))
  const card = c.core.cards.get(proposed.cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  await until(() => lastOf<BotsTopic>(view, "bots")?.code?.find((b) => b.name === LIVE.name)?.usedTodayUsd === 0)
  const paper = rid()
  expect(result(await client.request("bot.buy", { request: paper, mint: MOON, amountUsd: 2 }))).toMatchObject({ state: "filled" })
})

test("a paper buy the core refuses before Candle trades it (a token Candle doesn't know) ends at once, told to the bot, and holds no open slot", async () => {
  const UNKNOWN = "UnknFake11111111111111111111111111111111111"
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, { ...PAPER, maxOpen: 1 })
  const id = rid()
  const asked = result(await client.request("bot.buy", { request: id, mint: UNKNOWN, amountUsd: 1 }))
  // It ended in the call: refused, in Candle's words, never "pending".
  expect(asked).toMatchObject({ request: id, side: "buy", state: "refused", code: "TOKEN_UNKNOWN", words: expect.stringContaining("Candle doesn't know this token") })
  expect(result(await client.request("bot.request", { request: id }))).toMatchObject({ state: "refused" })
  expect(trades(c.p)).toHaveLength(0)
  await until(() => told(client).some((t) => t.kind === "request" && t.request === id && t.state === "refused"))
  // Its rows: the refusal (whose it was), and the request's end.
  const rows = c.core.journal.rows()
  expect(rows.find((r) => r.type === "tool.refused" && r.botRequest === id)).toMatchObject({ bot: "paper-bot", code: "TOKEN_UNKNOWN", tool: "candle_trade" })
  expect(rows.find((r) => r.type === "bot.request_ended" && r.request === id)).toMatchObject({ outcome: "refused", code: "TOKEN_UNKNOWN" })
  // Its one open slot is free: the next buy goes.
  const next = result(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  expect(next).toMatchObject({ state: "filled" })
})

test("a filled buy names the position it opened, the id positions() and sell() take", async () => {
  const { c, view, build } = await core()
  const { client } = await bot(c, view, build, PAPER)
  const bought = result<{ position?: string }>(await client.request("bot.buy", { request: rid(), mint: MOON, amountUsd: 1 }))
  const { positions } = result<{ positions: { id: string }[] }>(await client.request("bot.positions", {}))
  expect(positions).toHaveLength(1)
  expect(bought.position).toBe(positions[0]!.id)
  expect(result(await client.request("bot.sell", { request: rid(), position: bought.position }))).toMatchObject({ state: "filled", position: bought.position })
  expect(trades(c.p)).toHaveLength(2)
})

/** A live bot on the embedded wallet set to trade inside limits, holding one $1 position in a token only it holds. */
async function liveHolding() {
  const { c, view, build } = await core({}, { candle: ANY })
  await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 10 })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
  const { client } = await bot(c, view, build, LIVE)
  const first = rid()
  await client.request("bot.buy", { request: first, mint: FRESH, amountUsd: 1 })
  await until(() => told(client).some((t) => t.kind === "request" && t.request === first && t.state === "filled"))
  return { c, view, client }
}
const sells = (p: TestCore["p"]) => trades(p).filter((x) => x.args.side === "sell")
const filled = (client: TestClient, id: string) => told(client).some((t) => t.kind === "request" && t.request === id && t.state === "filled")
const stateOf = async (client: TestClient, id: string) => result<{ state: string }>(await client.request("bot.request", { request: id })).state

test("sells of one live position asked at once, each a different part under its own id: one is sent, the rest are refused as under way", async () => {
  const { c, client } = await liveHolding()
  const ids = [rid(), rid(), rid(), rid(), rid()]
  const answers = await Promise.all(ids.map((id, k) => client.request("bot.sell", { request: id, mint: FRESH, percent: 100 - k })))
  expect(answers.filter((a) => !a.error).length).toBe(1)
  expect(answers.filter((a) => a.error).map((a) => a.error!.data?.code)).toEqual(["SELL_UNDER_WAY", "SELL_UNDER_WAY", "SELL_UNDER_WAY", "SELL_UNDER_WAY"])
  await until(() => filled(client, ids[0]!))
  expect(sells(c.p).length).toBe(1)
  expect(c.core.journal.rows().filter((r) => r.type === "card.approved" && r.how === "bot-exit").length).toBe(1)
  // A refused id stays free, and was never recorded.
  expect(await stateOf(client, ids[1]!)).toBe("unknown")
}, 30_000)

test("one id asked twice at once with two different parts is one sell: the second gets the first's answer", async () => {
  const { c, client } = await liveHolding()
  const id = rid()
  const [a, b] = await Promise.all([client.request("bot.sell", { request: id, mint: FRESH, percent: 50 }), client.request("bot.sell", { request: id, mint: FRESH, percent: 49 })])
  expect(a.error).toBeUndefined()
  expect(b.error).toBeUndefined()
  expect(result<{ request: string }>(b).request).toBe(id)
  await until(() => filled(client, id))
  await Bun.sleep(300)
  expect(sells(c.p).map((s) => s.args.percent)).toEqual([50])
}, 30_000)

test("the same part sold at once under three ids is one sell, none is left waiting, and the position sells again after", async () => {
  const { c, client } = await liveHolding()
  const ids = [rid(), rid(), rid()]
  const answers = await Promise.all(ids.map((id) => client.request("bot.sell", { request: id, mint: FRESH, percent: 50 })))
  expect(answers.filter((a) => !a.error).length).toBe(1)
  await until(() => filled(client, ids[0]!))
  expect(sells(c.p).length).toBe(1)
  for (const id of ids.slice(1)) expect(["unknown", "refused"]).toContain(await stateOf(client, id))
  // Nothing of the three holds the position: the held exits and a later sell aren't kept waiting.
  const position = result<{ positions: { id: string }[] }>(await client.request("bot.positions", {})).positions[0]!.id
  expect(position).toBeTruthy()
  const more = rid()
  expect((await client.request("bot.sell", { request: more, mint: FRESH })).error).toBeUndefined()
  await until(() => filled(client, more))
  expect(sells(c.p).length).toBe(2)
}, 30_000)

test("a buy asked again under a new id while the same buy's card waits lands on that card: the new id ends, refused, and holds no slot or day", async () => {
  const { c, view, build } = await core({}, { candle: ANY })
  const { client } = await bot(c, view, build, LIVE)
  const [one, two] = [rid(), rid()]
  expect(result<{ state: string }>(await client.request("bot.buy", { request: one, mint: FRESH, amountUsd: 1 })).state).toBe("waiting")
  const second = result<{ state: string; code?: string; words: string }>(await client.request("bot.buy", { request: two, mint: FRESH, amountUsd: 1 }))
  expect(second.state).toBe("refused")
  expect(second.code).toBe("SAME_TRADE_UNDER_WAY")
  expect(second.words).toContain("under another id")
  expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval" && x.side === "buy").length).toBe(1)
  // Ended, it holds none of the bot's two open slots: a buy of another token still has one.
  expect((await client.request("bot.buy", { request: rid(), mint: PEPE, amountUsd: 1 })).error).toBeUndefined()
  // The first's card pressed fills the first alone; the second stays ended.
  const card = c.core.cards.list().find((x) => x.state === "awaiting_approval" && x.side === "buy" && x.origin.bot?.request === one)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => filled(client, one))
  expect(await stateOf(client, two)).toBe("refused")
  expect(trades(c.p).filter((x) => x.args.side === "buy" && x.args.mint === FRESH).length).toBe(1)
}, 30_000)

test("the card desk itself holds a second sell of a code bot's position while one is in flight, whatever its size or id: it waits for the person", async () => {
  const { c, client } = await liveHolding()
  const position = result<{ positions: { id: string }[] }>(await client.request("bot.positions", {})).positions[0]!.id
  const cards = c.core.cards
  const ask = (request: string, percent: number) => {
    const by = botClient({ kind: "code", name: "live-bot", agent: "momentum", mode: "live", slippageBps: 150 }, { act: "exit", position, request, reason: "bot" })
    const args = { mint: FRESH, side: "sell", percent, wallet: "embedded", maxSlippageBps: 150 }
    return cards.propose({ client: by, agent: "momentum", tool: "candle_trade", args, params: normaliseForMode("candle_trade", args, "live"), kind: "trade", idKey: "clientTradeId", reason: "test" }).then((card) => ({ card, by }))
  }
  const one = await ask(rid(), 60)
  const two = await ask(rid(), 50)
  const [first, second] = await Promise.all([cards.runWithoutCard(one.card, one.by), cards.runWithoutCard(two.card, two.by)])
  expect(first.ran).toBeDefined()
  expect(second.ran).toBeUndefined()
  expect(cards.get(two.card.cardId)!.state).toBe("awaiting_approval")
  expect(cards.get(two.card.cardId)!.display.cardBecause).toContain("another sell of this position is still in flight")
  await until(() => c.core.operations.get(one.card.opId)?.state === "succeeded")
  expect(sells(c.p).map((s) => s.args.percent)).toEqual([60])
}, 30_000)
