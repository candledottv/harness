// Memory live, across engines: in one conversation through a real
// core, the real shim, the fake Candle and the fake Hacc, real Claude Code writes a memory with its own
// file tools, with a pointer to a skill and one to its history; then real Codex, Pi, Grok and OpenCode, on
// the next turns, use it unprompted: the index is in their prompt, and the pointers open with skill_read and
// harness_history. Asserted: the index is written and read on each engine, and each later engine answers by it.
// Which pointer tools a model opens is its choice, so it's logged.
// Each turn costs a little of your Claude, ChatGPT and Grok subscriptions and the OpenRouter key.
//   bun run test:live src/engine/memory.live.test.ts
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { type FakeHacc, startFakeHacc } from "../../test/fake-hacc"

const MOON = "MoonFake11111111111111111111111111111111111"
const T = 300_000
const KEY_FILE = join(homedir(), ".config/candle-harness-engines/openrouter-key")
const PI_MODEL = process.env.PI_LIVE_MODEL ?? "openrouter/anthropic/claude-haiku-5.5"
const OPENCODE_MODEL = process.env.OPENCODE_LIVE_MODEL ?? "openrouter/anthropic/claude-haiku-5.5"

const cores: TestCore[] = []
const scratch: string[] = []
let hacc: FakeHacc | undefined
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
  hacc?.stop()
})
afterAll(() => {
  cleanupHomes()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

test.skipIf(!existsSync(KEY_FILE))(
  "written on Claude Code, used unprompted on Codex, Pi, Grok and OpenCode in the same conversation",
  async () => {
    hacc = startFakeHacc({ keys: [AGENT_KEY] })
    mkdirSync(join(homedir(), ".cache"), { recursive: true })
    const piDir = mkdtempSync(join(homedir(), ".cache/chrn-pidir-"))
    scratch.push(piDir)
    writeFileSync(join(piDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: readFileSync(KEY_FILE, "utf8").trim() } }), { mode: 0o600 })
    // OpenCode's sign-in for these turns: a throwaway data home holding only the OpenRouter key.
    const ocData = mkdtempSync(join(homedir(), ".cache/chrn-ocdata-"))
    scratch.push(ocData)
    mkdirSync(join(ocData, "opencode"), { mode: 0o700 })
    writeFileSync(join(ocData, "opencode/auth.json"), JSON.stringify({ openrouter: { type: "api", key: readFileSync(KEY_FILE, "utf8").trim() } }), { mode: 0o600 })
    const c = await startTestCore(
      { env: { ...process.env, PI_CODING_AGENT_DIR: piDir, XDG_DATA_HOME: ocData }, haccHost: hacc.url },
      { prefix: join(homedir(), ".cache/chrn-h-"), config: { mode: "paper", engine: { ...testEngine, codex: { path: "codex" }, pi: { path: "pi" }, grok: { path: "grok" }, opencode: { path: "opencode" } }, hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } },
    )
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["agent", "activity"] })
    const events = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
    const ask = async (text: string) => {
      const before = events().filter((e) => e.type === "ended").length
      const from = events().length
      await view.request("agent.send", { text })
      await until(() => events().filter((e) => e.type === "ended").length > before, T)
      const turn = events().slice(from)
      const tools = turn.filter((e) => e.type === "tool_call").map((e) => `${String(e.name)} ${String(e.summary ?? "")}`)
      return { tools, reply: String(turn.find((e) => e.type === "ended")!.reply), outcome: turn.find((e) => e.type === "ended")!.outcome }
    }
    const index = join(c.p.researchDir("momentum"), "memory", "index.md")

    // Claude Code: a paper buy, so history has one, then the memory.
    await until(() => c.core.engine.lastCheck("claude-code") !== undefined, 30_000)
    const buy = await ask(`Paper-buy $5 of ${MOON} for me now (it's the mint, already confirmed).`)
    console.log(`claude-code buy: ${JSON.stringify(buy.tools)}\n${buy.reply}`)
    const wrote = await ask(
      "Remember these for later turns, in your memory: (1) I size a dip buy at a quarter of my usual buy; (2) before a first buy of any token, read Candle's risk gate skill first; (3) the MOON paper buy we just made, as a pointer to your history for today. Keep it light, as your memory skill says.",
    )
    console.log(`claude-code memory: ${JSON.stringify(wrote.tools)}\n${wrote.reply}`)
    expect(existsSync(index)).toBe(true)
    const written = readFileSync(index, "utf8")
    console.log(`index.md:\n${written}`)
    expect(written.toLowerCase()).toContain("quarter")
    expect(written).toContain("candle-risk-gate")
    expect(written).toContain("history:")
    // Journalled as the turn closes, just after its `ended`.
    await until(() => c.core.journal.rows().some((r) => r.type === "memory.change" && r.by === "agent"), 10_000)

    // Codex, next turn: the dip size from memory, unprompted.
    expect((await view.request("engine.choose", { agent: "momentum", engine: "codex" })).error).toBeUndefined()
    await until(() => c.core.engine.lastCheck("codex") !== undefined, 30_000)
    const codex = await ask("My usual buy is $40. How much should a dip buy of PEPE be? Just the number and why, no trade.")
    console.log(`codex: ${JSON.stringify(codex.tools)}\n${codex.reply}`)
    expect(codex.outcome).toBe("done")
    expect(codex.reply).toMatch(/\$?10\b/)

    // Pi, next turn: a first buy of a new token, which the memory says to gate, and what was bought before.
    expect((await view.request("engine.choose", { agent: "momentum", engine: "pi", model: PI_MODEL })).error).toBeUndefined()
    await until(() => c.core.engine.lastCheck("pi") !== undefined, 30_000)
    const pi = await ask("Thinking about a first buy of PEPE. Don't buy anything: just tell me what you'd check first, and what I bought with you earlier today.")
    console.log(`pi: ${JSON.stringify(pi.tools)}\n${pi.reply}`)
    expect(pi.outcome).toBe("done")
    expect(pi.reply).toContain("MOON")
    // Grok, next turn: the dip size again, from the memory in its prompt file.
    expect((await view.request("engine.choose", { agent: "momentum", engine: "grok" })).error).toBeUndefined()
    await until(() => c.core.engine.lastCheck("grok") !== undefined, 30_000)
    const grok = await ask("My usual buy is $80. How much should a dip buy of WIF be? Just the number and why, no trade.")
    console.log(`grok: ${JSON.stringify(grok.tools)}\n${grok.reply}`)
    expect(grok.outcome).toBe("done")
    expect(grok.reply).toMatch(/\$?20\b/)
    // OpenCode, next turn: what was bought earlier, from the memory's pointer to history.
    expect((await view.request("engine.choose", { agent: "momentum", engine: "opencode", model: OPENCODE_MODEL })).error).toBeUndefined()
    await until(() => c.core.engine.lastCheck("opencode") !== undefined, 30_000)
    const opencode = await ask("Don't buy anything. What did I buy with you earlier today, and how would you size a dip buy if my usual is $20?")
    console.log(`opencode: ${JSON.stringify(opencode.tools)}\n${opencode.reply}`)
    expect(opencode.outcome).toBe("done")
    expect(opencode.reply).toContain("MOON")
    expect(opencode.reply).toMatch(/\$?5\b/)
    // The pointers a later engine opened, the skill or the history, logged only: the turn's record of what went
    // through the Candle Harness already names today's paper buy, so a model answers without opening either.
    const opened = [...codex.tools, ...pi.tools, ...grok.tools, ...opencode.tools].filter((t) => /skill_read|harness_history/.test(t))
    console.log(`pointers opened: ${JSON.stringify(opened)}`)
    // Nothing was proposed or traded after the buy.
    expect(c.core.journal.rows().filter((r) => r.type === "paper.call")).toHaveLength(1)
  },
  6 * T,
)
