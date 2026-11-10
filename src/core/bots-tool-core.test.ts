// harness_bots on a real core: offered on Pro and Max, never on Free; a bot the agent proposes is a card that saves
// nothing until the person's press, whose hash binds the definition and run settings; "stop all my bots" pauses
// them at once; and a trigger on a bot fires when it buys, sells or is paused.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { AutonomyTopic } from "./autonomy"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const DEFINITION = { chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000 } }, exit: { take_profit_pct: 100, stop_loss_pct: 40 }, sizing: { usd_per_trade: 2, max_concurrent: 4 } }
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

type Answer = Record<string, any>
const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

async function core(tier: "pro" | "free" = "pro") {
  const c = await startTestCore({}, tier === "free" ? { candle: { momentum: { tier: "free" }, swing: { tier: "free" } } } : {})
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["cards", "autonomy", "activity"] })
  await until(() => c.core.plans.planFor("momentum").plan !== undefined)
  if (tier === "pro") await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  const { client: harness } = await c.harness(view)
  const call = async (args: Record<string, unknown>, name = "harness_bots"): Promise<Answer> => {
    const r = await harness.request("tools.call", { name, args })
    return JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as Answer
  }
  const tools = async () => ((await harness.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)
  return { c, view, call, tools }
}

describe("harness_bots through a real core", () => {
  test("0.2's name, tui_bots: never listed, still taken on a call as harness_bots", async () => {
    const { call, tools } = await core()
    expect(await tools()).toContain("harness_bots")
    expect(await tools()).not.toContain("tui_bots")
    expect(await call({ action: "read" }, "tui_bots")).toMatchObject({ success: true })
    expect(await call({ action: "read" }, "tui_bots")).toEqual(await call({ action: "read" }))
  })

  test("offered on Pro; not on Free, where a call anyway is refused in the gate's words", async () => {
    const pro = await core()
    expect(await pro.tools()).toContain("harness_bots")
    const free = await core("free")
    await until(() => free.c.core.plans.planFor("momentum").plan === "free")
    expect(await free.tools()).not.toContain("harness_bots")
    expect(await free.call({ action: "propose", name: "conf", definition: DEFINITION, wallet: "embedded", mode: "paper" })).toMatchObject({ success: false, error: { code: "BOTS_NEED_PLAN" } })
  })

  test("a proposal is a card: nothing saved until the person's press, which saves exactly what it bound; another card's hash approves nothing", async () => {
    const { c, view, call } = await core()
    const a = await call({ action: "propose", name: "conf", definition: DEFINITION, wallet: "embedded", mode: "paper", reason: "your confluence idea" })
    expect(a).toMatchObject({ success: false, error: { code: "APPROVAL_REQUIRED" }, kind: "bot", bot: { name: "conf", mode: "paper", runs: expect.stringContaining("On paper"), worst: expect.stringContaining("$8.00 at risk") } })
    expect(a.tell).toContain("paper or live")
    const b = await call({ action: "propose", name: "other", definition: DEFINITION, wallet: "embedded", mode: "live" })
    expect(c.core.bots.entries()).toEqual([])
    const cardA = c.core.cards.get(a.cardId)!
    const cardB = c.core.cards.get(b.cardId)!
    expect(cardA.display).toMatchObject({ title: 'NEW BOT "conf"', modeNote: "paper bot", botCard: { name: "conf", words: expect.stringContaining("Buys $2 when several tracked wallets"), runs: { kind: "paper" } }, why: "your confluence idea" })
    // A live bot on the embedded wallet leads with a wallet of its own.
    expect(cardB.display).toMatchObject({ modeNote: "live bot", warning: expect.stringContaining("A wallet of its own is the better way") })
    expect(cardA.cardHash).not.toBe(cardB.cardHash)

    expect((await view.request("cards.approve", { cardId: cardA.cardId, cardHash: cardB.cardHash })).error?.data?.code).toBe("CARD_HASH_MISMATCH")
    expect(c.core.bots.entries()).toEqual([])
    await view.request("cards.approve", { cardId: cardA.cardId, cardHash: cardA.cardHash, how: "enter" })
    await until(() => c.core.operations.get(cardA.opId)?.state === "succeeded")
    expect(c.core.bots.entries().map((x) => [x.name, x.agent, x.mode, x.state])).toEqual([["conf", "momentum", "paper", "on"]])
    expect(await call({ action: "read" })).toMatchObject({ success: true, bots: [{ name: "conf", state: "on", mode: "paper", positions: [] }] })
  })

  test("a live bot on young tokens with no slippage bound has the agent ask about one; a wallet of its own is the person's chip, never tee new", async () => {
    const { c, view, call } = await core()
    const live = await call({ action: "propose", name: "young", definition: DEFINITION, wallet: "embedded", mode: "live" })
    expect(live.note).toContain("no slippage bound of its own")
    expect(live.note).toContain("set it only if they agree")
    expect(live.note).toContain("never propose `candle tee new`, `tee enable` or a rebind")
    // With a bound, or on paper, or on tokens over $5M, there's nothing to ask.
    expect((await call({ action: "propose", name: "bound", definition: DEFINITION, wallet: "embedded", mode: "live", maxSlippageBps: 800 })).note ?? "").not.toContain("slippage")
    expect((await call({ action: "propose", name: "paper", definition: DEFINITION, wallet: "embedded", mode: "paper" })).note).toBeUndefined()
    const big = { ...DEFINITION, entry: { ...DEFINITION.entry, filters: { min_mcap_usd: 10_000_000 } } }
    expect((await call({ action: "propose", name: "big", definition: big, wallet: "embedded", mode: "live" })).note ?? "").not.toContain("slippage")
    // Once it runs on a wallet that's shared, its read says how a wallet of its own is made.
    const card = c.core.cards.get(live.cardId)!
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
    const read = await call({ action: "read" })
    expect(read.bots.find((b: Answer) => b.name === "young").ownWallet).toContain("new TEE wallet for <agent>")
  })

  test("stop all my bots pauses them at once; a trigger on a bot fires on its pause and on its entry's fill", async () => {
    const { c, view, call } = await core()
    const a = await call({ action: "propose", name: "conf", definition: DEFINITION, wallet: "embedded", mode: "paper" })
    const card = c.core.cards.get(a.cardId)!
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
    await until(() => c.core.bots.entries().length === 1)
    for (const line of ['on bot "conf" paused notify as "conf-paused"', 'on bot "conf" entered notify as "conf-in"']) {
      const check = c.core.triggers.check(line, "momentum")
      await c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })
    }
    // A bot's paper entry, as its own row says it filled.
    await c.core.journal.append({ type: "paper.call", mode: "paper", agent: "momentum", clientId: "core:bot:conf", role: "core", bot: "conf", botAct: "entry", botSignal: 1, tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "2", paper: true }, isError: false, answer: "{}" })
    await until(() => c.core.journal.rows().some((r) => r.type === "trigger.fired" && r.name === "conf-in"))

    expect(await call({ action: "pause", all: true })).toMatchObject({ success: true, done: expect.stringContaining('"conf" is paused') })
    expect(c.core.bots.runState(c.core.bots.entry("conf")!)).toBe("paused")
    await until(() => c.core.journal.rows().some((r) => r.type === "trigger.fired" && r.name === "conf-paused"))
    const fired = c.core.journal.rows().filter((r) => r.type === "trigger.fired").map((r) => [r.name, r.cause && (r.cause as { event?: string; what?: string }).what])
    expect(fired).toEqual([
      ["conf-in", "entered"],
      ["conf-paused", "paused"],
    ])
  })
})
