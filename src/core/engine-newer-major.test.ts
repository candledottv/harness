// A harness updates itself between the Candle Harness's releases. One found on a newer major version than its
// holds were checked on is journalled once for each version; a newer minor or patch never is, and nothing is blocked.
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { scriptedEngine } from "../../test/scripted-engine"
import type { JournalRow } from "./journal"
import { entryWords } from "./journal-query"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => cleanupHomes())

const noted = (c: TestCore) => c.core.journal.rows().filter((r) => r.type === "engine.newer_major")

test("a newer major version is journalled once, with the version and the one checked; checking it again adds nothing", async () => {
  // The scripted engine's holds count as checked on 1.2.3.
  const { engine } = scriptedEngine("codex", [], { check: { ok: true, version: "2.0.1" } })
  const c = await startTestCore({ engine: { engines: [engine] } })
  cores.push(c)
  await until(() => noted(c).length > 0)
  expect(noted(c)).toHaveLength(1)
  expect(noted(c)[0]).toMatchObject({ engine: "codex", label: "Codex", version: "2.0.1", checked: "1.2.3" })
  const view = await c.view()
  await view.request("engine.check", { engine: "codex", again: true })
  await view.request("engine.check", { engine: "codex", again: true })
  await Bun.sleep(50)
  expect(noted(c)).toHaveLength(1)
  // The engine still runs: its check is as good as before.
  expect(((await view.request("engine.check", { engine: "codex" })).result as { check: { ok: boolean } }).check.ok).toBe(true)
  expect(entryWords(noted(c) as JournalRow[], () => undefined).text).toBe("Codex is 2.0.1, a newer major version than the one its holds were checked on (1.2.3)")
})

test("a newer minor or patch, or the checked version itself, is never journalled", async () => {
  const { engine } = scriptedEngine("codex", [], { check: { ok: true, version: "1.99.7" } })
  const c = await startTestCore({ engine: { engines: [engine] } })
  cores.push(c)
  const view = await c.view()
  await view.request("engine.check", { engine: "codex", again: true })
  await Bun.sleep(100)
  expect(noted(c)).toEqual([])
})
