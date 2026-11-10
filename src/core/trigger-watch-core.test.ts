// Triggers' watchers on a real core: a tape trigger holds Hacc's stream open with no view subscribed and fires on a
// new row, and a level reads Candle's market read for its token with no view open.
import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { type FakeHacc, startFakeHacc } from "../../test/fake-hacc"
import { candleConfigDir } from "./candle-mcp"
import type { FireCause } from "./triggers"

const MOON = "MoonFake11111111111111111111111111111111111"
const cores: TestCore[] = []
const haccs: FakeHacc[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
  for (const h of haccs.splice(0)) h.stop()
})
afterAll(() => cleanupHomes())

async function save(c: TestCore, line: string) {
  const check = c.core.triggers.check(line, "momentum")
  return c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })
}

test("a tape trigger holds Hacc's stream open with no view subscribed, and a new row fires it; switched off, it lets the stream go", async () => {
  const hacc = startFakeHacc({ keys: [AGENT_KEY] })
  haccs.push(hacc)
  const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } } })
  cores.push(c)
  const fired: FireCause[] = []
  c.core.triggers.setFirer(async (_t, cause) => {
    fired.push(cause)
  })
  await until(() => c.core.plans.planFor("momentum").plan === "pro" || c.core.plans.planFor("momentum").plan === "max")
  expect(c.core.signals.view().state).toBe("closed")
  const { name } = await save(c, "when confluence notify")
  await until(() => c.core.signals.view().state === "open")
  expect(c.core.server.events.subscriberCount("signals")).toBe(0)
  const row = hacc.push({ pattern: "confluence", asset_address: MOON, asset_chain: "solana" })
  await until(() => fired.length === 1)
  expect(fired[0]).toMatchObject({ by: "tape", mint: MOON, signalId: row.id })
  expect(c.core.journal.rows().find((r) => r.type === "trigger.fired")).toMatchObject({ name, class: "tape", token: MOON })
  // A row from the stream's opening snapshot, older than the trigger, never fired it.
  expect(fired).toHaveLength(1)
  await c.core.triggers.set(name, false, { clientId: "test", main: true })
  // The stream is no longer wanted: it closes on its own idle rule, as for a view that unsubscribes.
  expect((c.core.signals as unknown as { deps: { wanted(): { signals: boolean } } }).deps.wanted().signals).toBe(false)
})

test("a level reads Candle's market read for its token with no view open, and says its reading", async () => {
  const c = await startTestCore()
  cores.push(c)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  await save(c, `when ${MOON} > $1000 notify`)
  const reads = () =>
    readFileSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { name: string; args: { mint?: string } })
      .filter((x) => x.name === "candle_get_market" && x.args.mint === MOON)
  // No view is attached, so no other reader reads MOON: each of these is the level's.
  // A core with no view knows no token names, so the token goes by its short address.
  await until(() => reads().length >= 2, 15_000)
  expect(c.core.triggers.view().triggers[0]!.watching).toMatch(/^(checking|checked about every 5 s) · Moon…1111 \$0\.63$/)
}, 30_000)
