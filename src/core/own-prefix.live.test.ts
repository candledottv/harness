// The agent's own key prefix, live: real Claude Code through a real core and the fake
// Candle, with Candle's recorded trades under the agent's own prefix. Asked what it traded on Candle, it reads
// candle_get_profile_trades with its own prefix, never a guess. Before, it guessed and Candle answered an
// empty book. A turn costs a little of your Claude subscription.
//   bun run test:live src/core/own-prefix.live.test.ts
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import tradesB from "../../test/fixtures/candle-recorded/feeds-pnl/trades-agent-b.json"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { candleConfigDir } from "./candle-mcp"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(cleanupHomes)

test(
  "asked what it traded, it reads its own trades with its own prefix",
  async () => {
    mkdirSync(join(homedir(), ".cache"), { recursive: true })
    const c = await startTestCore({}, { prefix: join(homedir(), ".cache/chrn-h-"), keys: { momentum: prefixedKey("FakeKey1") }, candle: { momentum: { trades: { FakeKey1: tradesB.answer.trades } } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["agent"] })
    const events = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
    await view.request("agent.send", { text: "What were my last few trades on Candle, according to Candle's own record of my key? Use Candle's profile trades read." })
    await until(() => events().some((e) => e.type === "ended"), 300_000)
    // What reached Candle, from the fake's own call log.
    const log = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl")
    const calls = (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []).map((l) => JSON.parse(l) as { name: string; args: { keyPrefix?: string } }).filter((k) => k.name === "candle_get_profile_trades")
    console.log(JSON.stringify(calls.map((k) => k.args)), "\n", String(events().find((e) => e.type === "ended")!.reply))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((k) => k.args.keyPrefix === "FakeKey1")).toBe(true)
  },
  360_000,
)
