// The figure gate live: real Claude Code,
// and Pi on an OpenRouter model, asked for a token's figures and a dollar conversion through a real core,
// the real shim and the fake Candle. Read figures should pass and the conversion go unchecked, so a
// right answer carries no `?`. What a model writes is its own, so the marks are logged for a person to read, and only what
// holds whatever it writes is asserted: the reply is never held back or re-asked over a figure, and
// every figure it states is counted in the journal, with each mark sitting on its figure.
// Each turn costs a little of your Claude subscription or the OpenRouter key.
//   bun run test:live src/engine/figures.live.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import type { EngineId } from "./engine"

const MOON = "MoonFake11111111111111111111111111111111111"
const T = 300_000
const KEY_FILE = join(homedir(), ".config/candle-harness-engines/openrouter-key")
const PI_MODEL = process.env.PI_LIVE_MODEL ?? "openrouter/anthropic/claude-haiku-5.5"

const cores: TestCore[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  cleanupHomes()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const engines: EngineId[] = ["claude-code", ...(existsSync(KEY_FILE) ? (["pi"] as const) : [])]

describe.each(engines)("the figure gate on %s", (engine) => {
  test(
    "a token's figures read from Candle pass, a worked-out conversion isn't checked, and nothing is held back",
    async () => {
      mkdirSync(join(homedir(), ".cache"), { recursive: true })
      let env: Record<string, string | undefined> = process.env
      if (engine === "pi") {
        const dir = mkdtempSync(join(homedir(), ".cache/chrn-pidir-"))
        scratch.push(dir)
        writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: readFileSync(KEY_FILE, "utf8").trim() } }), { mode: 0o600 })
        env = { ...process.env, PI_CODING_AGENT_DIR: dir }
      }
      const c = await startTestCore({ env }, { prefix: join(homedir(), ".cache/chrn-h-"), config: { mode: "paper", engine: { ...testEngine, pi: { path: "pi" } } } })
      cores.push(c)
      const view = await c.view()
      await view.request("subscribe", { topics: ["agent"] })
      await until(() => c.core.engine.lastCheck(engine) !== undefined, 30_000)
      if (engine === "pi") expect((await view.request("engine.choose", { agent: "momentum", engine: "pi", model: PI_MODEL })).error).toBeUndefined()
      const events = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
      await view.request("agent.send", { text: `Read the market for ${MOON} with candle_get_market. What are its price, market cap and liquidity? And roughly how many dollars is 0.37 SOL at today's SOL price, worked out by you?` })
      await until(() => events().some((e) => e.type === "ended"), T)
      const ended = events().find((e) => e.type === "ended")!
      const reply = String(ended.reply)
      const marked = ended.marked as { at: number; text: string }[]
      const row = c.core.journal.rows().find((r) => r.type === "agent.turn")!
      console.log(`${engine}: ${row.figures} figures, marked ${JSON.stringify(marked.map((m) => m.text))}\n${reply}`)
      expect(ended.outcome).toBe("done")
      expect(events().some((e) => e.type === "reask")).toBe(false)
      expect(Number(row.figures)).toBeGreaterThan(0)
      for (const m of marked) expect(reply.slice(m.at, m.at + m.text.length)).toBe(m.text)
    },
    T + 60_000,
  )
})
