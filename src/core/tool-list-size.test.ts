// What the tool list costs every turn. Each engine hands the model every tool's description and schema, so
// the Candle Harness's own tools are kept short: this holds their size, tool by tool, so a description
// can't grow back unnoticed. Candle's own are Candle's to size.
import { afterAll, afterEach, expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-tools.json"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { startFakeHacc } from "../../test/fake-hacc"

const cores: TestCore[] = []
const stops: (() => void)[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
  for (const stop of stops.splice(0)) stop()
})
afterAll(cleanupHomes)

type Tool = { name: string; description?: string }
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

test("the Candle Harness's own tools, on Max with Hacc on, stay inside their size", async () => {
  const hacc = startFakeHacc({ keys: [AGENT_KEY] })
  stops.push(() => hacc.stop())
  const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
  cores.push(c)
  const view = await c.view()
  await until(() => c.core.plans.planFor("momentum").plan === "max")
  const { client } = await c.harness(view)
  const tools = ((await client.request("tools.list", {})).result as { tools: Tool[] }).tools
  const candles = new Set((fixture as { tools: Tool[] }).tools.map((t) => t.name))
  const own = tools.filter((t) => !candles.has(t.name))
  const sizes = Object.fromEntries(own.map((t) => [t.name, bytes(t)]).sort((a, b) => Number(b[1]) - Number(a[1])))
  if (process.env.TOOL_SIZES) console.log(JSON.stringify({ all: bytes(tools), count: tools.length, own: bytes(own), ownCount: own.length, sizes }, null, 1))
  // Every own tool is still offered: the list was made shorter by cutting words, never tools.
  expect(own.map((t) => t.name).sort()).toEqual(
    ["candle_bridge", "candle_cli", "hacc_follows", "hacc_lab", "hacc_market", "hacc_signals", "hacc_social", "hacc_token", "hacc_wallets", "harness_bots", "harness_group_wallets", "harness_history", "harness_limits", "harness_name_wallets", "harness_pnl", "harness_show_wallets", "harness_triggers", "harness_view", "research_list", "research_read", "skill_read"],
  )
  // Room to add a sentence a live failure calls for, not to drift back: they were 51,889 bytes, candle_cli 11,190.
  // candle_bridge, a tool of its own, raised the cap by its size (1,216 bytes), and its own size is held too.
  expect(bytes(own)).toBeLessThanOrEqual(50_250)
  expect(sizes.candle_bridge).toBeLessThanOrEqual(1_250)
  expect(sizes.candle_cli).toBeLessThanOrEqual(9_400)
})
