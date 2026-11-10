// A trigger's firing through a real core: its command proposed as the trigger's own and run through the
// wallet's figures, one test per condition, each of which a test here fails without. Inside the figures it runs
// with a receipt; on a wallet that asks, over the per-trade or the day figure, it's a card that waits and says
// why; over the agent's own limit, paused (buys held, sells run) or on a key Candle holds, it's refused; a
// chain's second part goes once the first filled; a restart after `trigger.fired` never fires it again; a lost
// answer is read back once; `cards.typedTrades = "instant"` never applies; `run it now` proposes an expired
// card's line again, once.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { startCore } from "./core-main"
import type { AutonomyTopic } from "./autonomy"
import { candleConfigDir } from "./candle-mcp"
import type { JournalRow } from "./journal"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
// 0.01 SOL at the fake's $150, with Candle's fee: about $1.51, under a $2.00 figure; 0.02 SOL is over it.
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }
const LIMITS = { perTradeUsd: 10, perDayUsd: 50 }

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const callsOf = (c: TestCore, name: string, agent = "momentum") => {
  const file = join(candleConfigDir(c.p.stateDir, agent), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
        .filter((x) => x.name === name)
    : []
}
const trades = (c: TestCore) => callsOf(c, "candle_trade")
const rows = (c: TestCore, type: string): JournalRow[] => c.core.journal.rows().filter((r) => r.type === type)

type Home = NonNullable<Parameters<typeof startTestCore>[1]>
async function core(o: { config?: Home["config"]; env?: Record<string, string>; candle?: Home["candle"]; inside?: typeof INSIDE | false; home?: Partial<Home> } = {}) {
  const c = await startTestCore({ env: { ...process.env, ...(o.env ?? {}) } }, { ...(o.config ? { config: o.config } : {}), ...(o.candle ? { candle: o.candle } : {}), ...(o.home ?? {}) })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "activity"] })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  if (o.inside !== false) await view.request("autonomy.set", o.inside ?? INSIDE)
  return { c, view }
}

/** Saves a trigger as its card's press would, and answers its name. */
async function save(c: TestCore, line: string, proposer = "momentum") {
  const check = c.core.triggers.check(line, proposer)
  return (await c.core.triggers.save(line, proposer, { expansion: check.trigger.expansion })).name
}

/** Fires an `on call` trigger and waits for what its firing runs. */
async function fire(c: TestCore, name: string) {
  const { run } = await c.core.triggers.fire(name, { clientId: "test" })
  return (await run) as { kind: string; end?: { kind: string; words: string; sent: number }; words?: string }
}

describe("a trigger's command, through the wallet's figures", () => {
  test("inside them: run with no card as the trigger's own, by the core's client, journalled after the firing; never worded as the person's", async () => {
    const { c } = await core()
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    const ran = await fire(c, name)
    expect(ran).toMatchObject({ kind: "ran", end: { kind: "done", sent: 1 } })
    expect(trades(c)).toHaveLength(1)
    const all = c.core.journal.rows()
    const fired = all.findIndex((r) => r.type === "trigger.fired" && r.name === "dip")
    const created = all.findIndex((r) => r.type === "card.created" && r.trigger === "dip")
    expect(fired).toBeGreaterThanOrEqual(0)
    expect(created).toBeGreaterThan(fired)
    expect(all[created]).toMatchObject({ role: "core", clientId: "core:triggers", fireId: all[fired]!.fireId, part: 0 })
    expect(all.find((r) => r.type === "card.approved" && r.trigger === "dip")).toMatchObject({ how: "inside-limits" })
    const card = c.core.cards.list().find((x) => x.origin.trigger?.name === "dip")!
    expect(card.origin).toMatchObject({ role: "core", source: "trigger", trigger: { name: "dip", part: 0 } })
    expect(card.display.trigger).toBe("dip")
    // The trigger's own fill never fires an `on fill` trigger of the same name: it carries the name.
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  })

  test("a wallet that asks every time: a card that waits for the person, saying so; nothing sent", async () => {
    const { c } = await core({ inside: false })
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    await c.core.triggers.fire(name, { clientId: "test" })
    await until(() => rows(c, "trigger.waiting").length === 1)
    expect(rows(c, "trigger.waiting")[0]).toMatchObject({ name: "dip", because: "the embedded wallet asks every time" })
    const waiting = c.core.cards.list().find((x) => x.origin.trigger?.name === "dip")
    expect(waiting?.state).toBe("awaiting_approval")
    // The card says what the firing saw, in place of why; and the Triggers overlay says each firing asks.
    expect(waiting?.display.fired).toBe(rows(c, "trigger.fired")[0]!.words as string)
    expect(c.core.triggers.view().triggers[0]).toMatchObject({ name: "dip", paysFrom: "embedded", runs: { runs: "asks" } })
    expect(trades(c)).toHaveLength(0)
  })

  test("over the per-trade figure: a card, saying which figure", async () => {
    const { c } = await core()
    const name = await save(c, `on call buy 0.02 sol of ${MOON} as "big"`)
    await c.core.triggers.fire(name, { clientId: "test" })
    await until(() => rows(c, "trigger.waiting").length === 1)
    expect(String(rows(c, "trigger.waiting")[0]!.because)).toMatch(/^over the embedded wallet's \$2\.00 a trade without a card/)
    expect(trades(c)).toHaveLength(0)
  })

  test("over the day figure: the first runs, the second is a card", async () => {
    const { c } = await core({ inside: { ...INSIDE, perDayUsd: 2 } })
    const a = await save(c, `on call buy 0.01 sol of ${MOON} as "one"`)
    const b = await save(c, `on call buy 0.01 sol of ${MOON} as "two"`)
    await fire(c, a)
    expect(trades(c)).toHaveLength(1)
    await c.core.triggers.fire(b, { clientId: "test" })
    await until(() => rows(c, "trigger.waiting").length === 1)
    expect(String(rows(c, "trigger.waiting")[0]!.because)).toMatch(/^over the embedded wallet's \$2\.00 a day without a card/)
    expect(trades(c)).toHaveLength(1)
  })

  test("over the agent's own limit: refused at proposal, said, and nothing sent", async () => {
    const { c } = await core({ config: { agents: { momentum: { name: "momentum", limits: { perTradeUsd: 1, perDayUsd: 50 } }, swing: { name: "swing", limits: LIMITS } } } })
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    const ran = await fire(c, name)
    expect(ran).toMatchObject({ kind: "ran", end: { kind: "stopped", sent: 0 } })
    expect(rows(c, "card.refused").at(-1)).toMatchObject({ trigger: "dip", role: "core" })
    expect(rows(c, "trigger.ran").at(-1)).toMatchObject({ name: "dip", outcome: "stopped", sent: 0 })
    expect(trades(c)).toHaveLength(0)
  })

  test("the kill switch: a trigger's buy is held and said, its sell still runs; the report names the triggers it holds", async () => {
    const { c, view } = await core()
    const buy = await save(c, `on call buy 0.01 sol of ${MOON} as "buyer"`)
    const sell = await save(c, `on call sell 50% of ${MOON} as "seller"`)
    const killed = (await view.request("kill", {})).result as { report: { triggersHeld?: { name: string; agent: string; words: string }[] } }
    expect(killed.report.triggersHeld).toEqual([{ name: "buyer", agent: "momentum", words: "its buys and swaps are held until you resume" }])
    expect(await fire(c, buy)).toMatchObject({ kind: "ran", end: { kind: "stopped", sent: 0 } })
    expect(rows(c, "trigger.held").at(-1)).toMatchObject({ name: "buyer", reason: "paused", part: 0 })
    expect(trades(c)).toHaveLength(0)
    expect(await fire(c, sell)).toMatchObject({ kind: "ran", end: { kind: "done", sent: 1 } })
    expect(trades(c)).toHaveLength(1)
    expect(trades(c)[0]!.args.side).toBe("sell")
  })

  test("a key Candle held for its cap: the trigger's buy is refused before anything is sent", async () => {
    const { c, view } = await core({ candle: { momentum: { tools: { candle_trade: { refuse: "KEY_LIMIT_REACHED", retryable: true, extra: { resetsAt: new Date(Date.now() + 3_600_000).toISOString() } } } } } })
    // The person's trade meets Candle's cap, and the key is held.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })
    await until(() => trades(c).length === 1 && c.core.operations.list().some((op) => op.error?.code === "KEY_LIMIT_REACHED"))
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    expect(await fire(c, name)).toMatchObject({ kind: "ran", end: { kind: "stopped", sent: 0 } })
    expect(rows(c, "card.refused").at(-1)).toMatchObject({ trigger: "dip", code: "KEY_LIMIT_REACHED" })
    expect(trades(c)).toHaveLength(1)
  })

  test("a chain: its second part is sent only once the first filled", async () => {
    const { c } = await core()
    const name = await save(c, `on call buy 0.01 sol of ${MOON}; sell 100% of ${MOON} as "round"`)
    const ran = await fire(c, name)
    expect(ran).toMatchObject({ kind: "ran", end: { kind: "done", sent: 2 } })
    expect(trades(c).map((t) => t.args.side)).toEqual(["buy", "sell"])
    const all = c.core.journal.rows()
    const buyFilled = all.findIndex((r) => r.type === "operation.succeeded" && c.core.cards.held(String(r.opId))?.origin.trigger?.part === 0)
    const sellMade = all.findIndex((r) => r.type === "card.created" && r.trigger === "round" && r.part === 1)
    expect(buyFilled).toBeGreaterThanOrEqual(0)
    expect(sellMade).toBeGreaterThan(buyFilled)
    expect(rows(c, "trigger.ran").at(-1)).toMatchObject({ name: "round", outcome: "done", sent: 2, parts: 2 })
  })

  test("typedTrades = instant never applies: over the figures it's still a card", async () => {
    const { c } = await core({ config: { cards: { typedTrades: "instant" } } })
    const name = await save(c, `on call buy 0.02 sol of ${MOON} as "big"`)
    await c.core.triggers.fire(name, { clientId: "test" })
    await until(() => rows(c, "trigger.waiting").length === 1)
    expect(rows(c, "card.approved").filter((r) => r.trigger === "big")).toHaveLength(0)
    expect(trades(c)).toHaveLength(0)
  })

  test("a lost answer: read back under the same id, never sent twice", async () => {
    const { c } = await core({ env: { CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1" } })
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    await fire(c, name)
    const card = c.core.cards.list().find((x) => x.origin.trigger?.name === "dip")!
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded", 10_000)
    expect(trades(c)).toHaveLength(1)
    // A single trade's lost answer isn't a stop: its card's rows say it, and it's read back on its own.
    expect(rows(c, "trigger.ran")).toHaveLength(0)
  })

  test("notify: journalled with its words, and nothing trades", async () => {
    const { c } = await core()
    const name = await save(c, `on call notify "look at the tape" as "ping"`)
    expect(await fire(c, name)).toEqual({ kind: "notified" })
    expect(rows(c, "trigger.notify").at(-1)).toMatchObject({ name: "ping", words: "look at the tape" })
    expect(trades(c)).toHaveLength(0)
  })

  test("paper mode: the trigger's trade runs as its agent's paper trade, marked as the trigger's", async () => {
    const { c, view } = await core()
    await view.request("mode.set", { mode: "paper" })
    await until(() => c.core.journal.rows().some((r) => r.type === "mode.changed" && r.mode === "paper"))
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    expect(await fire(c, name)).toMatchObject({ kind: "ran", end: { kind: "done" } })
    expect(rows(c, "paper.call").at(-1)).toMatchObject({ trigger: "dip", role: "core", agent: "momentum" })
    expect(rows(c, "card.created").filter((r) => r.trigger === "dip")).toHaveLength(0)
  })

  test("a trigger approved live trades live after the person switches to paper: nothing of it goes on paper, and the switch says so", async () => {
    const { c, view } = await core()
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    const switched = (await view.request("mode.set", { mode: "paper" })).result
    expect(switched).toEqual({ mode: "paper", said: "1 live trigger stays as approved: its trades are still real." })
    expect(c.core.triggers.view().triggers[0]).toMatchObject({ mode: "live", live: true })
    expect(await fire(c, name)).toMatchObject({ kind: "ran", end: { kind: "done", sent: 1 } })
    expect(rows(c, "paper.call")).toHaveLength(0)
    expect(rows(c, "card.approved").find((r) => r.trigger === "dip")).toMatchObject({ how: "inside-limits", mode: "live" })
    expect(trades(c)).toHaveLength(1)
    expect(trades(c)[0]!.args.paper).not.toBe(true)
  })

  test("a trigger approved on paper stays on paper after the person goes live: no card, nothing sent for real", async () => {
    const { c, view } = await core()
    await view.request("mode.set", { mode: "paper" })
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    expect((await view.request("mode.set", { mode: "live" })).result).toEqual({ mode: "live", said: "1 paper trigger stays as approved: its trades are still on paper." })
    expect(await fire(c, name)).toMatchObject({ kind: "ran", end: { kind: "done" } })
    expect(rows(c, "paper.call").at(-1)).toMatchObject({ trigger: "dip", role: "core", agent: "momentum", mode: "paper" })
    expect(rows(c, "card.created").filter((r) => r.trigger === "dip")).toHaveLength(0)
    expect(trades(c).every((t) => t.args.paper === true)).toBe(true)
  })
})

describe("nothing fires twice", () => {
  test("a restart between `trigger.fired` and its proposal: the next core doesn't fire it again", async () => {
    const { c } = await core()
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    // The firing path never reaches its proposal, as a core that died there.
    c.core.triggers.setFirer(() => new Promise(() => {}))
    await c.core.triggers.fire(name, { clientId: "test" })
    expect(rows(c, "trigger.fired")).toHaveLength(1)
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      await until(() => ["pro", "max"].includes(String(again.plans.planFor("momentum").plan)))
      await Bun.sleep(300)
      expect(again.journal.rows().filter((r) => r.type === "card.created" && r.trigger === "dip")).toHaveLength(0)
      expect(callsOf({ p } as TestCore, "candle_trade")).toHaveLength(0)
      // Its cooldown was kept with the firing: called again at once, it's refused.
      await expect(again.triggers.fire(name, { clientId: "test" })).rejects.toMatchObject({ code: "COOLDOWN" })
    } finally {
      await again.stop("test")
    }
  })
})

describe("a core that died mid-trade", () => {
  test("a trigger's trade in flight when the core died: the next core reads it back by its id once Candle is up, and never sends it again", async () => {
    const { c } = await core()
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    expect(await fire(c, name)).toMatchObject({ kind: "ran", end: { kind: "done", sent: 1 } })
    const opId = rows(c, "operation.submitting").find((r) => r.tool === "candle_trade")!.opId as string
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    // As a core killed before Candle's answer reached it: the journal ends at its submitting.
    const kept = readFileSync(p.journal, "utf8")
      .split("\n")
      .filter((l) => l && !(l.includes('"type":"operation.succeeded"') && l.includes(opId)))
    writeFileSync(p.journal, `${kept.join("\n")}\n`)
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      await until(() => again.journal.rows().some((r) => r.type === "operation.succeeded" && r.opId === opId), 10_000)
      expect(again.journal.rows().find((r) => r.type === "operation.check" && r.opId === opId)).toMatchObject({ found: true })
      expect(callsOf({ p } as TestCore, "candle_trade")).toHaveLength(1)
      expect(again.journal.rows().filter((r) => r.type === "trigger.fired")).toHaveLength(1)
    } finally {
      await again.stop("test")
    }
  }, 30_000)
})

describe("run it now", () => {
  test("a trigger's card that expired with nobody there: its line again at a fresh price, from the main view, once", async () => {
    const { c, view } = await core({ inside: false })
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    await c.core.triggers.fire(name, { clientId: "test" })
    await until(() => rows(c, "trigger.waiting").length === 1)
    const card = c.core.cards.list().find((x) => x.origin.trigger?.name === "dip")!
    card.expiresAt = new Date(0).toISOString()
    await c.core.cards.expireDue()
    expect(card.state).toBe("expired")
    expect(rows(c, "card.expired").at(-1)).toMatchObject({ trigger: "dip", cardId: card.cardId })
    // The Triggers overlay offers it again, until it's run.
    expect(c.core.triggers.view().triggers[0]?.expired?.cardId).toBe(card.cardId)
    const ran = (await view.request("triggers.runNow", { cardId: card.cardId })).result as { said: string }
    expect(ran.said).toBe('"dip": its trade proposed again at a fresh price.')
    await until(() => c.core.cards.list().filter((x) => x.origin.trigger?.name === "dip" && x.state === "awaiting_approval").length === 1)
    expect(rows(c, "trigger.run_now").at(-1)).toMatchObject({ name: "dip", cardId: card.cardId, from: card.origin.trigger!.fireId })
    // Not a firing: no second `trigger.fired`.
    expect(rows(c, "trigger.fired")).toHaveLength(1)
    expect(c.core.triggers.view().triggers[0]?.expired).toBeUndefined()
    const twice = await view.request("triggers.runNow", { cardId: card.cardId })
    expect(twice.error?.data).toMatchObject({ code: "ALREADY_RUN" })
    // A popped view can't.
    const popped = await c.view("candle-harness view --pane token")
    expect((await popped.request("triggers.runNow", { cardId: card.cardId })).error?.data).toMatchObject({ code: "MAIN_VIEW_ONLY" })
  })

  test("a restart with a trigger's expired card in the journal: the core starts, and still offers it again", async () => {
    const { c } = await core({ inside: false })
    const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    await c.core.triggers.fire(name, { clientId: "test" })
    await until(() => rows(c, "trigger.waiting").length === 1)
    const card = c.core.cards.list().find((x) => x.origin.trigger?.name === "dip")!
    card.expiresAt = new Date(0).toISOString()
    await c.core.cards.expireDue()
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    // The kept rows are read before everything a trigger's line reads against exists.
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      expect(again.triggers.view().triggers[0]?.expired?.cardId).toBe(card.cardId)
    } finally {
      await again.stop("test")
    }
  })

  test("a card that isn't a trigger's is refused, naming re-quote", async () => {
    const { c, view } = await core({ inside: false })
    const made = (await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })).result as { cardId: string }
    const card = c.core.cards.get(made.cardId)!
    card.expiresAt = new Date(0).toISOString()
    await c.core.cards.expireDue()
    expect((await view.request("triggers.runNow", { cardId: made.cardId })).error?.data).toMatchObject({ code: "NOT_A_TRIGGER_CARD" })
  })
})
