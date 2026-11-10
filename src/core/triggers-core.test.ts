// Triggers on a real core: the methods and the topic are a view's, never a harness's; switching one back on is
// the main view's; a Free plan shows the gate and a plan that ends holds every trigger, read in the core's own
// five-minute refresh; and a restart keeps each trigger as it was.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { connectTestClient } from "../../test/core-test-client"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { candleConfigDir } from "./candle-mcp"
import { DOCTOR_CLIENT } from "./client"
import { startCore } from "./core-main"
import { readViewToken } from "./tokens"
import type { TriggersTopic } from "./triggers"

const MOON = "MoonFake11111111111111111111111111111111111"
const STOP = `when ${MOON} < $0.40 sell 50% of ${MOON}`
/** Its name: the condition, with the mint by its first and last four. */
const NAME = "Moon…1111 < $0.40"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())
const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

async function save(c: TestCore, line: string) {
  const check = c.core.triggers.check(line, "momentum")
  return c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })
}

/** Sets the fake Candle's plan for every agent: read at the next status read. */
function plan(c: TestCore, tier: "free" | "pro" | "max") {
  for (const agent of ["momentum", "swing"]) {
    const folder = candleConfigDir(c.p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify({ tier }))
  }
}

test("a view's: a harness is refused every method and the topic; a popped view switches one off, never back on", async () => {
  const c = await startTestCore()
  cores.push(c)
  await save(c, STOP)
  const main = await c.view()
  const popped = await c.view("candle-harness view --pane wallets")
  const { client: harness } = await c.harness(main)
  for (const [method, params] of [
    ["triggers.list", {}],
    ["triggers.set", { name: "x", on: false }],
    ["triggers.remove", { name: "x" }],
    ["triggers.fire", { name: "x" }],
  ] as const) {
    expect([method, (await harness.request(method, params)).error?.data?.code]).toEqual([method, "FORBIDDEN_FOR_ROLE"])
  }
  expect((await harness.request("subscribe", { topics: ["triggers"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")

  await main.request("subscribe", { topics: ["triggers"] })
  await until(() => lastOf<TriggersTopic>(main, "triggers")?.triggers.length === 1)
  expect(lastOf<TriggersTopic>(main, "triggers")).toMatchObject({ triggers: [{ name: NAME, agent: "momentum", on: true, live: true }], problems: [] })
  expect(lastOf<TriggersTopic>(main, "triggers")!.gate).toBeUndefined()

  const name = NAME
  expect((await popped.request("triggers.set", { name, on: false })).result).toMatchObject({ on: false })
  expect((await popped.request("triggers.set", { name, on: true })).error?.data?.code).toBe("MAIN_VIEW_ONLY")
  expect((await main.request("triggers.set", { name, on: true })).result).toMatchObject({ on: true })
  expect((await main.request("triggers.set", { name })).error?.data?.code).toBe("INVALID_PARAMS")
  const doctor = await c.view(DOCTOR_CLIENT)
  expect((await doctor.request("triggers.fire", { name })).error?.data?.code).toBe("OBSERVER")
  await until(() => lastOf<TriggersTopic>(main, "triggers")?.triggers[0]?.on === true)
  expect(c.core.journal.rows().filter((r) => r.type.startsWith("trigger.")).map((r) => [r.type, r.on])).toEqual([
    ["trigger.saved", true],
    ["trigger.changed", false],
    ["trigger.changed", true],
  ])
})

test("Free: the topic says triggers need Pro or Max, and nothing is proposed; a plan that ends holds them, and one that returns puts them back", async () => {
  let now = Date.now()
  const c = await startTestCore({ now: () => now }, { candle: { momentum: { tier: "free" }, swing: { tier: "free" } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["triggers"] })
  await until(() => lastOf<TriggersTopic>(view, "triggers")?.gate?.plan === "free")
  expect(lastOf<TriggersTopic>(view, "triggers")!.gate).toEqual({ plan: "free", words: "Triggers need a Pro or Max plan", fix: "candle plan buy" })
  expect(() => c.core.triggers.check(STOP, "momentum")).toThrow("Triggers need a Pro or Max plan")
  expect((await view.request("triggers.fire", { name: "x" })).error?.data?.code).toBe("TRIGGERS_NEED_PLAN")

  // Pro, read at the next five-minute refresh: proposed and saved.
  plan(c, "pro")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => lastOf<TriggersTopic>(view, "triggers")?.gate === undefined)
  await save(c, STOP)
  expect(c.core.triggers.liveCount()).toBe(1)

  // The plan ends: held, kept as it is, and journalled once.
  plan(c, "free")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => lastOf<TriggersTopic>(view, "triggers")?.triggers[0]?.held?.code === "PLAN_FREE")
  expect(c.core.triggers.liveCount()).toBe(0)
  expect(lastOf<TriggersTopic>(view, "triggers")!.triggers[0]).toMatchObject({ on: true, live: false })

  plan(c, "max")
  now += 5 * 60_000
  await c.core.plans.refresh()
  await until(() => c.core.triggers.liveCount() === 1)
  await until(() => c.core.journal.rows().some((r) => r.type === "trigger.released"))
  expect(c.core.journal.rows().filter((r) => r.type === "trigger.held" || r.type === "trigger.released").map((r) => r.type)).toEqual(["trigger.held", "trigger.released"])
})

test("a restart keeps every trigger as it was, and the file 0600 beside config.toml", async () => {
  const c = await startTestCore()
  cores.push(c)
  await save(c, STOP)
  await save(c, `every day 09:00 buy $1 of ${MOON}`)
  const main = await c.view()
  await main.request("triggers.set", { name: "every day 09:00", on: false })
  const before = c.core.triggers.view()
  const p = c.p
  cores.splice(0)
  await c.close()
  const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
  try {
    await again.candleReady
    const client = await connectTestClient(p.socket)
    await client.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
    const listed = (await client.request("triggers.list", {})).result as TriggersTopic
    // Its words name tokens by what this core has shown a view, which a fresh core hasn't yet; what its watcher has read is this core's own.
    const unworded = (t: TriggersTopic) => ({ ...t, triggers: t.triggers.map(({ watching: _w, paceMs: _p, ...x }) => ({ ...x, words: "" })) })
    expect(unworded(listed)).toEqual(unworded(before))
    expect(listed.triggers.map((t) => [t.name, t.on])).toEqual([
      [NAME, true],
      ["every day 09:00", false],
    ])
    client.close()
  } finally {
    await again.stop("test")
  }
})
