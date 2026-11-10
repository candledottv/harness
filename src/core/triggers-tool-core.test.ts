// harness_triggers on a real core: offered on Pro and Max, never on Free; a trigger the agent proposes is a card that
// saves nothing until the person's press, whose hash binds the exact line; a narrowing changes it at once and a
// widening is a card; and "stop all my triggers" switches every one off at once.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"

const MOON = "MoonFake11111111111111111111111111111111111"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

type Answer = Record<string, any>
async function core(tier: "pro" | "free" = "pro") {
  const c = await startTestCore({}, tier === "free" ? { candle: { momentum: { tier: "free" }, swing: { tier: "free" } } } : {})
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["cards"] })
  await until(() => c.core.plans.planFor("momentum").plan !== undefined)
  const { client: harness } = await c.harness(view)
  const call = async (args: Record<string, unknown>, name = "harness_triggers"): Promise<Answer> => {
    const r = await harness.request("tools.call", { name, args })
    return JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as Answer
  }
  const tools = async () => ((await harness.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)
  return { c, view, call, tools }
}

describe("harness_triggers through a real core", () => {
  test("0.2's name, tui_triggers: never listed, still taken on a call as harness_triggers", async () => {
    const { call, tools } = await core()
    expect(await tools()).toContain("harness_triggers")
    expect(await tools()).not.toContain("tui_triggers")
    expect(await call({ action: "read" }, "tui_triggers")).toMatchObject({ success: true })
    expect(await call({ action: "read" }, "tui_triggers")).toEqual(await call({ action: "read" }))
  })

  test("offered on Pro; not on Free, where a call anyway is refused in the gate's words", async () => {
    const pro = await core()
    expect(await pro.tools()).toContain("harness_triggers")
    const free = await core("free")
    await until(() => free.c.core.plans.planFor("momentum").plan === "free")
    expect(await free.tools()).not.toContain("harness_triggers")
    expect(await free.call({ action: "propose", line: `when ${MOON} < $0.40 sell 50% of ${MOON}` })).toMatchObject({ success: false, error: { code: "TRIGGERS_NEED_PLAN" } })
  })

  test("a proposal is a card: nothing saved until the person's press, which saves exactly its line; another card's hash approves nothing", async () => {
    const { c, view, call } = await core()
    const a = await call({ action: "propose", line: `when ${MOON} < $0.40 sell 50% of ${MOON} as "stop"`, reason: "your stop" })
    expect(a).toMatchObject({ success: false, error: { code: "APPROVAL_REQUIRED" }, kind: "trigger" })
    // The agent is told how it will run, as the card says it.
    expect(a.trigger).toMatchObject({ line: `when ${MOON} < $0.40 sell 50% of ${MOON} as "stop"`, runs: expect.stringMatching(/^(Asks you each time|Runs on its own|The wallet that pays)/) })
    expect(a.tell).toContain("Tell the person how it will run")
    const b = await call({ action: "propose", line: `when ${MOON} < $0.30 sell 50% of ${MOON} as "deeper"` })
    expect(c.core.triggers.entries()).toEqual([])
    const cardA = c.core.cards.get(a.cardId)!
    const cardB = c.core.cards.get(b.cardId)!
    expect(cardA.display).toMatchObject({ title: 'NEW TRIGGER "stop"', triggerCard: { line: `when ${MOON} < $0.40 sell 50% of ${MOON} as "stop"`, words: expect.stringContaining("falls below $0.40") }, why: "your stop" })
    expect(cardA.params).toMatchObject({ line: `when ${MOON} < $0.40 sell 50% of ${MOON} as "stop"`, expansion: `when ${MOON} < $0.40 sell 50% of ${MOON}` })
    expect(cardA.cardHash).not.toBe(cardB.cardHash)

    expect((await view.request("cards.approve", { cardId: cardA.cardId, cardHash: cardB.cardHash })).error?.data?.code).toBe("CARD_HASH_MISMATCH")
    expect(c.core.triggers.entries()).toEqual([])
    await view.request("cards.approve", { cardId: cardA.cardId, cardHash: cardA.cardHash, how: "enter" })
    await until(() => c.core.operations.get(cardA.opId)?.state === "succeeded")
    expect(c.core.triggers.entries().map((t) => [t.name, t.agent, t.line, t.on])).toEqual([["stop", "momentum", `when ${MOON} < $0.40 sell 50% of ${MOON}`, true]])
    expect(await call({ action: "read" })).toMatchObject({ success: true, triggers: [{ name: "stop", on: true }] })
  })

  test("a narrowing is changed at once and said in Activity; a widening is a card; stop all switches every one off", async () => {
    const { c, view, call } = await core()
    await view.request("subscribe", { topics: ["activity"] })
    for (const line of [`when ${MOON} < $0.40 buy $5 of ${MOON}`, `every day 09:00 buy $1 of ${MOON} as "morning"`]) {
      const check = c.core.triggers.check(line, "momentum")
      await c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })
    }
    const stop = c.core.triggers.entries().find((t) => t.name !== "morning")!.name
    expect(await call({ action: "propose", line: `when ${MOON} < $0.35 buy $2 of ${MOON}`, replace: true, name: stop })).toMatchObject({ success: true, done: expect.stringContaining("only narrows it") })
    expect(c.core.triggers.entry(stop)!.line).toBe(`when ${MOON} < $0.35 buy $2 of ${MOON}`)
    expect(c.core.triggers.live().map((t) => t.name).sort()).toEqual(["morning", stop].sort())
    await until(() => view.events.some((e) => e.topic === "activity" && JSON.stringify(e.data).includes(`momentum narrowed trigger \\"${stop}\\"`)))

    expect(await call({ action: "propose", line: `every day 09:00 buy $5 of ${MOON}`, replace: true, name: "morning" })).toMatchObject({ error: { code: "APPROVAL_REQUIRED" }, kind: "trigger" })
    expect(c.core.triggers.entry("morning")!.line).toBe(`every day 09:00 buy $1 of ${MOON}`)

    expect(await call({ action: "off", all: true })).toMatchObject({ success: true })
    expect(c.core.triggers.live()).toEqual([])
    expect(c.core.journal.rows().filter((r) => r.type === "trigger.changed" && r.on === false).map((r) => [r.name, r.how, r.changedBy])).toEqual([
      [stop, "agent", "momentum"],
      ["morning", "agent", "momentum"],
    ])
  })
})
