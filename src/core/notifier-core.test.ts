// Notifications through a real core: with no main view open, the core shows a trigger's notice on the machine;
// with one open and listening, it goes to that view alone (the one last used, never a popped view), and the
// core shows nothing; a trigger's trade with no card is one notification with its fill; the kill switch, a
// card waiting on a wallet that asks, `[notify] on`, and a planned stop said to every view.
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import type { NotifyKind } from "../shared/notify"
import type { AutonomyTopic } from "./autonomy"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const lastOf = <T>(client: TestClient, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const noticesOf = (client: TestClient) => client.events.filter((e) => e.topic === "notices" && (e.data as { notice?: unknown }).notice).map((e) => (e.data as { notice: { title: string; body: string } }).notice)

async function core(o: { on?: NotifyKind[]; inside?: boolean } = {}) {
  const spawned: string[][] = []
  const c = await startTestCore(
    { env: process.env, notify: { native: true, quietMs: 30, spawn: async (argv) => (spawned.push(argv), { exitCode: 0, stderr: "" }) } },
    o.on ? { config: { notify: { mode: "auto", on: o.on } } } : {},
  )
  cores.push(c)
  // The setup view, which never listens on `notices`: the core treats it as no main view.
  const setup = await c.view()
  await setup.request("subscribe", { topics: ["autonomy"] })
  await until(() => lastOf<AutonomyTopic>(setup, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  if (o.inside) await setup.request("autonomy.set", INSIDE)
  return { c, setup, spawned }
}

async function save(c: TestCore, line: string) {
  const check = c.core.triggers.check(line, "momentum")
  return (await c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })).name
}

test("no main view open: the core shows a trigger's notice on the machine, and journals it", async () => {
  const { c, spawned } = await core()
  const name = await save(c, `on call notify "MOON is moving" as "watch"`)
  await c.core.triggers.fire(name, { clientId: "test" })
  await until(() => spawned.length === 1)
  expect(spawned[0]!.slice(-2)).toEqual(["Candle Harness · trigger", 'trigger "watch": MOON is moving'])
  await until(() => c.core.journal.rows().some((r) => r.type === "notify.sent"))
  expect(c.core.journal.rows().find((r) => r.type === "notify.sent")).toMatchObject({ by: "core", kinds: ["triggers"] })
})

test("a main view listening: the notice goes to the one last used alone, never a popped view, and the core shows nothing", async () => {
  const { c, spawned } = await core()
  const first = await c.view()
  await first.request("subscribe", { topics: ["notices"] })
  const second = await c.view()
  await second.request("subscribe", { topics: ["notices"] })
  const popped = await c.view("candle-harness view --pane wallets")
  await popped.request("subscribe", { topics: ["notices"] })
  // The snapshot carries the settings the view sends by.
  expect(lastOf<{ settings: unknown }>(first, "notices")).toEqual({ settings: { mode: "auto", on: ["cards", "triggers", "bots", "wakes", "kill", "keys", "core"] } })
  await first.request("view.active", {})
  const name = await save(c, `on call notify "MOON is moving" as "watch"`)
  await c.core.triggers.fire(name, { clientId: "test" })
  await until(() => noticesOf(first).length === 1)
  await Bun.sleep(80)
  expect(noticesOf(first)).toEqual([{ kinds: ["triggers"], title: "Candle Harness · trigger", body: 'trigger "watch": MOON is moving' } as never])
  expect(noticesOf(second)).toEqual([])
  expect(noticesOf(popped)).toEqual([])
  expect(spawned).toEqual([])
})

test("a trigger's trade with no card is one notification with its fill, saying it was the trigger's", async () => {
  const { c, spawned } = await core({ inside: true })
  const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
  await c.core.triggers.fire(name, { clientId: "test" })
  await until(() => spawned.length === 1, 5_000)
  await Bun.sleep(100)
  expect(spawned).toHaveLength(1)
  const body = spawned[0]!.at(-1)!
  expect(body).toMatch(/^filled BUY .* · without a card · by trigger "dip"$/)
  expect(body).not.toContain(MOON)
})

test("a wallet that asks: the trigger's card waiting is told, once", async () => {
  const { c, spawned } = await core()
  const name = await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
  await c.core.triggers.fire(name, { clientId: "test" })
  await until(() => spawned.length === 1, 5_000)
  await Bun.sleep(100)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]![spawned[0]!.length - 2]).toBe("Candle Harness · a card waits for you")
  expect(spawned[0]!.at(-1)).toMatch(/^trigger "dip": .* waits for you: the embedded wallet asks every time$/)
})

test("the kill switch is told; [notify] on without it isn't", async () => {
  const told = await core()
  await told.setup.request("kill", {})
  await until(() => told.spawned.length === 1)
  expect(told.spawned[0]!.slice(-2)).toEqual(["Candle Harness · kill switch", "kill switch on: buys paused"])
  const quiet = await core({ on: ["cards"] })
  await quiet.setup.request("kill", {})
  await Bun.sleep(150)
  expect(quiet.spawned).toEqual([])
})

test("a planned stop is said to every view first, so none says the core stopped unexpectedly", async () => {
  const { c } = await core()
  const view = await c.view()
  await view.request("subscribe", { topics: ["notices"] })
  await c.core.stop("candle-harness stop")
  await until(() => view.events.some((e) => e.topic === "notices" && (e.data as { stopping?: unknown }).stopping === "candle-harness stop"))
})
