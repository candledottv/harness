// A rules bot's own mode and its controls through a real core: a paper bot trades on paper while the Candle Harness is live and a
// live bot live while it's on paper, sharing the key's paper book with the agent's own paper trades and selling only its
// own; the kill switch names each bot and what its exits still guard, and leaves each as it was; Candle's stop on a key
// pauses that key's bots; the pace keeps ten bots firing together clear of Candle's breaker, which a fake stops a key at,
// and the person's trades never wait; two failed sells of a token hold a trigger's sell and put an amber line on the
// person's; a failing route waits; and a bot's own slippage, approved on its card, runs inside the figures, named.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { AutonomyTopic } from "./autonomy"
import { PACE_TRADES, SELL_ROOM } from "./breaker"
import type { BotProposal, BotsTopic } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import { entryWords } from "./journal-query"
import type { KillReport } from "./kill"
import type { SignalRow } from "./signal-stream"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 200 }
const definition = (o: { max?: number } = {}) => ({ chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { take_profit_pct: 100, stop_loss_pct: 40 }, sizing: { usd_per_trade: 1.5, max_concurrent: o.max ?? 4 } })
const proposal = (o: { name?: string; agent?: string; mode?: "paper" | "live"; slippage?: number; max?: number } = {}): BotProposal => ({
  name: o.name ?? "conf",
  definition: definition(o),
  run: { agent: o.agent ?? "momentum", wallet: "embedded", mode: o.mode ?? "live", ...(o.slippage !== undefined ? { maxSlippageBps: o.slippage } : {}) },
})
const BIG_LIMITS = { perTradeUsd: 10, perDayUsd: 1000 }

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const calls = (p: TestCore["p"], agent = "momentum") => {
  const file = join(candleConfigDir(p.stateDir, agent), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown>; at: number })
    : []
}
const trades = (p: TestCore["p"], agent = "momentum") => calls(p, agent).filter((x) => x.name === "candle_trade")
const rows = (c: TestCore, type: string) => c.core.journal.rows().filter((r) => r.type === type)

/** A key's fake script, changed while the core runs: it's read on every call. */
function script(p: TestCore["p"], change: Record<string, unknown>, agent = "momentum") {
  const file = join(candleConfigDir(p.stateDir, agent), "fake-candle.json")
  const was = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
  writeFileSync(file, JSON.stringify({ ...was, ...change }))
}

let skew = 0
const clock = {
  now: () => Date.now() + skew,
  schedule: (run: () => void, ms: number) => {
    const t = setTimeout(run, ms)
    return () => clearTimeout(t)
  },
}
const beat = async (c: TestCore) => {
  skew += 5_000
  await c.core.watchBeat()
}
const moonAt = (p: TestCore["p"], usd: number) => {
  for (const agent of ["momentum", "swing"]) script(p, { markets: [{ mint: MOON, symbol: "MOON", priceUsd: usd }] }, agent)
}

type Home = NonNullable<Parameters<typeof startTestCore>[1]>
async function core(o: { config?: Home["config"]; candle?: Home["candle"]; inside?: boolean } = {}) {
  const c = await startTestCore({ env: process.env, triggerClock: clock }, { ...(o.config ? { config: o.config } : {}), ...(o.candle ? { candle: o.candle } : {}) })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "activity", "bots"] })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)) && ["pro", "max"].includes(String(c.core.plans.planFor("swing").plan)))
  if (o.inside !== false) await view.request("autonomy.set", INSIDE)
  return { c, view }
}

async function save(c: TestCore, p = proposal()) {
  await until(() => {
    try {
      c.core.bots.check(p, p.run.agent)
      return true
    } catch {
      return false
    }
  })
  await c.core.bots.save(p, p.run.agent, { hash: c.core.bots.check(p, p.run.agent).hash })
}

let nextId = 20_000
const signal = (mint = MOON): SignalRow => ({ id: nextId++, pattern: "confluence", created_at: new Date().toISOString(), asset_address: mint, asset_chain: "solana", wallet_groups: [], payload: {} }) as SignalRow

describe("a bot's own mode", () => {
  test("a paper bot trades on paper while the Candle Harness is live, its buy and its sell, with no card", async () => {
    const { c } = await core()
    await save(c, proposal({ mode: "paper" }))
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c, "paper.call").some((r) => r.bot === "conf"))
    expect(rows(c, "paper.call").find((r) => r.bot === "conf")).toMatchObject({ mode: "paper", role: "core", botAct: "entry", args: { paper: true, side: "buy" } })
    expect(rows(c, "card.created").filter((r) => r.bot === "conf")).toHaveLength(0)
    expect(trades(c.p)[0]!.args).toMatchObject({ paper: true, mint: MOON })
    // The Candle Harness stayed live.
    expect((await (await c.view()).request("core.status", {})).result).toMatchObject({ mode: "live" })
    await until(() => c.core.botExits.tokens().includes(MOON))
    moonAt(c.p, 0.01)
    await beat(c)
    await until(() => rows(c, "paper.call").some((r) => r.bot === "conf" && r.botAct === "exit"))
    expect(rows(c, "paper.call").find((r) => r.botAct === "exit")).toMatchObject({ mode: "paper", args: { paper: true, side: "sell" } })
    expect(trades(c.p).filter((t) => t.args.paper !== true)).toHaveLength(0)
  })

  test("a live bot trades live while the Candle Harness is on paper, through the wallet's figures; the status counts it as live", async () => {
    const { c, view } = await core()
    await view.request("mode.set", { mode: "paper" })
    await until(() => c.core.journal.rows().some((r) => r.type === "mode.changed" && r.mode === "paper"))
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => trades(c.p).length === 1)
    expect(trades(c.p)[0]!.args.paper).toBeUndefined()
    expect(rows(c, "card.created").find((r) => r.bot === "conf")).toMatchObject({ mode: "live" })
    expect(rows(c, "card.approved").find((r) => r.bot === "conf")).toMatchObject({ how: "inside-limits", mode: "live" })
    expect(((await view.request("core.status", {})).result as { botsLive?: number }).botsLive).toBe(1)
    // The person's own trade in the same moment is the Candle Harness's mode: paper.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })
    await until(() => rows(c, "paper.call").some((r) => r.role === "view"))
    expect(trades(c.p).at(-1)!.args.paper).toBe(true)
  })

  test("on paper, the bot and the agent's own paper trades share the key's paper book; the bot sells only its own", async () => {
    const { c, view } = await core()
    await view.request("mode.set", { mode: "paper" })
    await until(() => c.core.journal.rows().some((r) => r.type === "mode.changed" && r.mode === "paper"))
    // The person's paper buy of MOON first, on the same key.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.05" }, typed: true })
    await until(() => rows(c, "paper.call").length === 1)
    await save(c, proposal({ mode: "paper" }))
    await c.core.botEntries.onTape([signal()])
    await until(() => c.core.botExits.tokens().includes(MOON))
    const own = rows(c, "paper.call").find((r) => r.bot === "conf")!.fill as { tokensRaw: string }
    moonAt(c.p, 0.01)
    await beat(c)
    await until(() => rows(c, "paper.call").some((r) => r.botAct === "exit"))
    const exiting = rows(c, "bot.exiting")[0]!
    expect(exiting).toMatchObject({ botMode: "paper", sell: { by: "amount", amountRaw: own.tokensRaw } })
  })
})

describe("the kill switch and a bot", () => {
  test("the report names each bot it holds and what its exits still guard; resuming leaves each bot as it was", async () => {
    const { c, view } = await core()
    await save(c)
    await save(c, proposal({ name: "slow" }))
    await view.request("bots.pause", { name: "slow" })
    await c.core.botEntries.onTape([signal()])
    await until(() => c.core.botExits.tokens().includes(MOON))
    const report = ((await view.request("kill", {})).result as { report: KillReport }).report
    expect(report.botsHeld).toEqual([{ name: "conf", agent: "momentum", mode: "live", open: ["MOON"], words: "its entries are held until you resume; its exits still sell, guarding its MOON position" }])
    // Its exits go on under the pause.
    moonAt(c.p, 0.01)
    await beat(c)
    await until(() => trades(c.p).some((t) => t.args.side === "sell"))
    await view.request("resume", {})
    await until(() => rows(c, "kill.off").length === 1)
    const bots = lastOf<BotsTopic>(view, "bots")!.bots
    expect(bots.find((b) => b.name === "conf")!.state).toBe("on")
    expect(bots.find((b) => b.name === "slow")!.state).toBe("paused")
  })
})

describe("Candle's stop on a key pauses its bots", () => {
  test("RISK_LIMIT_REACHED on momentum's key: momentum's bots are paused, said with the Agent Console step; swing's run on", async () => {
    const { c, view } = await core({ candle: { momentum: { tools: { candle_trade: { refuse: "RISK_LIMIT_REACHED" } } } } })
    await save(c)
    await save(c, proposal({ name: "other", agent: "swing" }))
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c, "bot.paused").length === 1)
    expect(rows(c, "bot.paused")[0]).toMatchObject({ name: "conf", how: "candle", reason: "RISK_LIMIT_REACHED" })
    expect(entryWords([rows(c, "bot.paused")[0]!], () => undefined).text).toMatch(/^the bot "conf" is paused: Candle stopped momentum's key .*Agent Console/)
    await until(() => lastOf<BotsTopic>(view, "bots")?.bots.find((b) => b.name === "conf")?.state === "paused")
    const conf = lastOf<BotsTopic>(view, "bots")!.bots.find((b) => b.name === "conf")!
    expect(conf.stateWords).toMatch(/Candle stopped momentum's key at \d\d:\d\d .*resume the key in Candle's Agent Console, then put the bot back on here/)
    expect(lastOf<BotsTopic>(view, "bots")!.bots.find((b) => b.name === "other")!.state).toBe("on")
  })
})

describe("Candle's breaker: the pace", () => {
  test("ten bots firing together never trip it, keep 5 slots for sells, and the person's own trades never wait", async () => {
    const config = { agents: { momentum: { name: "momentum", limits: BIG_LIMITS }, swing: { name: "swing", limits: BIG_LIMITS } } }
    const mints = Array.from({ length: 4 }, (_, i) => `Pace${"ABCD"[i]}Fake${"1".repeat(34)}`)
    const markets = mints.map((mint, i) => ({ mint, symbol: `PACE${i}`, priceUsd: 0.5 }))
    const { c, view } = await core({ config, candle: { momentum: { breaker: {}, markets }, swing: { markets } } })
    for (let i = 0; i < 10; i++) await save(c, proposal({ name: `b${i}` }))
    // Three of the person's own trades first: they count.
    for (let i = 0; i < 3; i++) await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.001" }, typed: true })
    for (const card of c.core.cards.list().filter((x) => x.state === "awaiting_approval")) await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    await until(() => trades(c.p).length === 3)
    // Forty candidates at once: ten bots, four tokens.
    await c.core.botEntries.onTape(mints.map((m) => signal(m)))
    await until(() => trades(c.p).length === PACE_TRADES - SELL_ROOM)
    await c.core.botEntries.flush()
    await Bun.sleep(300)
    expect(trades(c.p)).toHaveLength(PACE_TRADES - SELL_ROOM)
    const skipped = rows(c, "bot.skipped").filter((r) => r.reason === "pace")
    expect(skipped.reduce((n, r) => n + Number(r.count), 0)).toBe(40 - (PACE_TRADES - SELL_ROOM - 3))
    expect(String(skipped[0]!.words)).toContain("momentum's key made 15 trades in the last 75 s, and Candle's breaker stops a key at 30 in a minute: bots and triggers keep to 20 in 75 s, the last 5 for sells")
    // The five kept for sells are there.
    for (let i = 0; i < SELL_ROOM; i++) expect(c.core.tradePace.take("momentum", Date.now(), "sell").ok).toBe(true)
    expect(c.core.tradePace.take("momentum", Date.now(), "sell").ok).toBe(false)
    // The person's trade now, with the pace full: it isn't held, and goes at once.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.001" }, typed: true })
    await until(() => trades(c.p).length === PACE_TRADES - SELL_ROOM + 1)
    expect(calls(c.p).filter((x) => x.name === "breaker")).toHaveLength(0)
    expect(c.core.journal.rows().some((r) => (r.error as { code?: string } | undefined)?.code === "RISK_LIMIT_REACHED")).toBe(false)
  })

  test("a bot's stop sells while its entries have filled the buys' slots", async () => {
    const { c } = await core({ candle: { momentum: { breaker: {} } } })
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => c.core.botExits.tokens().includes(MOON))
    // Buys fill their 15, as a burst of entries leaves the pace.
    let taken = 0
    while (c.core.tradePace.take("momentum", Date.now(), "buy").ok) taken++
    expect(taken).toBe(PACE_TRADES - SELL_ROOM - 1)
    moonAt(c.p, 0.01)
    await beat(c)
    await until(() => trades(c.p).some((t) => t.args.side === "sell"))
    expect(rows(c, "bot.exit_held")).toHaveLength(0)
  })

  test("a bot's exit past the pace waits for the next slot, said, then sells", async () => {
    const { c } = await core({ candle: { momentum: { breaker: {} } } })
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => c.core.botExits.tokens().includes(MOON))
    // The pace full, as a burst of the core's own trades leaves it.
    let taken = 0
    while (c.core.tradePace.take("momentum", Date.now()).ok) taken++
    expect(taken).toBe(PACE_TRADES - 1)
    moonAt(c.p, 0.01)
    await beat(c)
    await until(() => rows(c, "bot.exit_held").length === 1)
    expect(rows(c, "bot.exit_held")[0]).toMatchObject({ why: "pace" })
    expect(trades(c.p).filter((t) => t.args.side === "sell")).toHaveLength(0)
  })
})

describe("Candle's breaker: failed sells", () => {
  test("after two failed sells of MOON: a trigger's sell is held and said, and the person's card carries the amber line", async () => {
    const { c, view } = await core({ candle: { momentum: { breaker: { failSells: [MOON] } } }, inside: false })
    for (let i = 0; i < 2; i++) {
      await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 10 }, typed: true })
      const card = c.core.cards.list().find((x) => x.state === "awaiting_approval")!
      await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
      await until(() => c.core.failedSells.count("momentum", MOON) === i + 1)
    }
    // The person's third: not held, with the amber line.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 10 }, typed: true })
    const third = c.core.cards.list().find((x) => x.state === "awaiting_approval")!
    expect(third.display.warning).toBe("Two sells of MOON in a row failed on momentum's key: if this one fails too, Candle stops the key, sells included, until you resume it in the Agent Console.")
    await view.request("cards.reject", { cardId: third.cardId })
    // A trigger's sell of MOON: held, said, nothing sent.
    const line = `on call sell 10% of ${MOON} as "out"`
    const name = (await c.core.triggers.save(line, "momentum", { expansion: c.core.triggers.check(line, "momentum").trigger.expansion })).name
    const sent = trades(c.p).length
    const { run } = await c.core.triggers.fire(name, { clientId: "test" })
    await run
    expect(trades(c.p)).toHaveLength(sent)
    expect(rows(c, "trigger.held").at(-1)).toMatchObject({ name: "out", reason: "FAILED_SELLS" })
    expect(String(rows(c, "trigger.held").at(-1)!.words)).toMatch(/^Its sell waits: two sells of MOON in a row failed on momentum's key, and one more would stop the key on Candle/)
    expect(calls(c.p).filter((x) => x.name === "breaker")).toHaveLength(0)
  })
})

describe("Candle's route breaker", () => {
  test("SWAP_ROUTE_FAILING on MOON's buys: the bot's next MOON entry waits it out, said; PEPE enters", async () => {
    const { c, view } = await core({ candle: { momentum: { tools: { candle_trade: { refuse: "SWAP_ROUTE_FAILING", status: 429, retryable: true, extra: { mint: MOON, failureCount: 5, retry_after_seconds: 120 } } } } } })
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.001" }, typed: true })
    await until(() => c.core.routeWaits.held("momentum", MOON, "buy", Date.now()) !== undefined)
    const card = c.core.cards.list().find((x) => x.params.mint === MOON)!
    expect(c.core.operations.get(card.opId)).toMatchObject({ state: "refused", error: { code: "SWAP_ROUTE_FAILING", retryAfterSeconds: 120 } })
    script(c.p, { tools: {} })
    await save(c)
    await c.core.botEntries.onTape([signal(MOON), signal(PEPE)])
    await until(() => trades(c.p).some((t) => t.args.mint === PEPE))
    await c.core.botEntries.flush()
    expect(trades(c.p).filter((t) => t.args.mint === MOON)).toHaveLength(1)
    const skip = rows(c, "bot.skipped").find((r) => r.reason === "route_failing")!
    expect(String(skip.words)).toMatch(/^Candle is refusing buys of MOON from momentum's key for (1\d\d s|2 minutes) more, after five failed swaps of it in a row$/)
  })
})

describe("a bot's own slippage", () => {
  test("approved on its card, a looser bound runs inside the figures, named on the receipt; the person's same bound is a card", async () => {
    const { c, view } = await core()
    await save(c, proposal({ slippage: 500 }))
    await c.core.botEntries.onTape([signal()])
    await until(() => trades(c.p).length === 1)
    expect(trades(c.p)[0]!.args).toMatchObject({ maxSlippageBps: 500 })
    const approved = rows(c, "card.approved").find((r) => r.bot === "conf")!
    expect(approved).toMatchObject({ how: "inside-limits" })
    expect(String((approved.inside as { words: string }).words)).toMatch(/, at the bot's approved slippage of 5%$/)
    // The person's buy at the same bound on the same wallet: looser than the default, so a card that says so.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.001", maxSlippageBps: 500 } })
    const mine = c.core.cards.list().find((x) => x.state === "awaiting_approval")!
    expect(mine.display.slippageLooser).toBe(true)
    const alone = await c.core.cards.runWithoutCard(mine, { clientId: "x", role: "view", agent: "momentum" })
    expect(alone.ran).toBeFalsy()
    expect(String(c.core.cards.get(mine.cardId)!.display.cardBecause)).toBe("slippage 5%, the default is 1%, looser than that, so this one waits for you")
  })

  test("a bot's trade looser than the bound it was approved with is a card", async () => {
    const { c } = await core()
    await save(c, proposal({ slippage: 300 }))
    const client = { clientId: "core:bot:conf", role: "core" as const, agent: "momentum", bot: { name: "conf", act: "entry" as const, mode: "live" as const, slippageBps: 300 } }
    const card = await c.core.cards.propose({ client, agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: 1.5, maxSlippageBps: 500 }, params: { mint: MOON, side: "buy", amountUsd: 1.5, maxSlippageBps: 500 }, kind: "trade", idKey: "clientTradeId" })
    const alone = await c.core.cards.runWithoutCard(card, client)
    expect(alone.ran).toBeFalsy()
    expect(String(c.core.cards.get(card.cardId)!.display.cardBecause)).toMatch(/slippage 5%, the default is 1%, looser than that/)
  })
})


test("a change approved to a rules bot the person paused keeps it paused, and its check says so for the card", async () => {
  const { c, view } = await core()
  await save(c)
  await view.request("bots.pause", { name: "conf" })
  await until(() => c.core.bots.runState(c.core.bots.entry("conf")!) === "paused")
  const wider = proposal({ max: 6 })
  const check = c.core.bots.check(wider, "momentum")
  expect(check.stays).toBe("paused")
  await c.core.bots.save(wider, "momentum", { hash: check.hash, replace: true })
  expect(c.core.bots.entry("conf")).toMatchObject({ state: "paused" })
  expect(c.core.bots.runState(c.core.bots.entry("conf")!)).toBe("paused")
  expect(rows(c, "bot.changed").at(-1)).toMatchObject({ state: "paused" })
})
