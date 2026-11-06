// Grok's time to its first Candle tool call, with Candle's tools alone and with Hacc's seven added. Grok
// searches its tool list every turn, so each tool added costs it most. Five live turns on each list,
// alternated so a change in Grok's own speed falls on both alike, through a real core, the real shim, the
// fake Candle and, for the longer list, the fake Hacc on Max (all seven Hacc tools). Each turn costs a
// little of the signed-in Grok subscription.
//   bun run test:live src/engine/grok-tools-time.live.test.ts
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { startFakeHacc } from "../../test/fake-hacc"

const MOON = "MoonFake11111111111111111111111111111111111"
const RUNS = 5
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(cleanupHomes)

async function core(hacc: boolean, haccHost: string) {
  mkdirSync(join(homedir(), ".cache"), { recursive: true })
  const c = await startTestCore(
    { haccHost },
    { prefix: join(homedir(), ".cache/chrn-h-"), config: { engine: { ...testEngine, grok: { path: "grok" } }, hacc: { enabled: hacc } }, candle: { momentum: { tier: "max" } } },
  )
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["agent"] })
  await until(() => c.core.engine.lastCheck("grok") !== undefined, 30_000)
  expect((await view.request("engine.choose", { agent: "momentum", engine: "grok" })).error).toBeUndefined()
  const events = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
  return { c, view, events }
}

test(
  "Grok's time to its first Candle call, Candle's tools alone against Candle's and Hacc's",
  async () => {
    const hacc = startFakeHacc({ keys: [AGENT_KEY] })
    const times: Record<"candle" | "candleHacc", number[]> = { candle: [], candleHacc: [] }
    const counts: Record<string, number> = {}
    const searches: Record<"candle" | "candleHacc", number[]> = { candle: [], candleHacc: [] }
    try {
      for (let i = 0; i < RUNS; i++) {
        for (const list of ["candle", "candleHacc"] as const) {
          const { c, view, events } = await core(list === "candleHacc", hacc.url)
          const harness = await c.harness(view, "momentum")
          counts[list] = ((await harness.client.request("tools.list", {})).result as { tools: unknown[] }).tools.length
          const sent = performance.now()
          await view.request("agent.send", { text: `Read the market for mint ${MOON} with candle_get_market, then tell me its price in one sentence.` })
          // Grok's first call is its own search_tool over the list: the time to the Candle call takes it in.
          const isMarket = (e: Record<string, unknown>) => e.type === "tool_call" && String(e.name).includes("candle_get_market")
          await until(() => events().some((e) => isMarket(e) || e.type === "ended"), 180_000)
          const first = performance.now() - sent
          await until(() => events().some((e) => e.type === "ended"), 180_000)
          expect(events().some(isMarket)).toBe(true)
          searches[list].push(events().filter((e) => e.type === "tool_call" && String(e.name).includes("search_tool")).length)
          times[list].push(Math.round(first))
          console.log(`${list} run ${i + 1}: candle_get_market after ${Math.round(first)} ms, ${searches[list].at(-1)} search_tool calls (${counts[list]} tools)`)
          await c.close()
          cores.splice(cores.indexOf(c), 1)
        }
      }
    } finally {
      hacc.stop()
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    console.log(JSON.stringify({ counts, times, searches, median: { candle: median(times.candle), candleHacc: median(times.candleHacc) }, addedMs: median(times.candleHacc) - median(times.candle) }))
  },
  RUNS * 2 * 200_000,
)
