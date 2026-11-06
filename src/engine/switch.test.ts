// Switching engines: one conversation on Claude Code, then Pi, then Codex, with a card proposed on one
// engine, approved, and reported to the next. The model shown is the model that ran, read from each
// harness's recorded stream. And the core's side of
// the picker: model lists read in the background, sign-ins, defaults, and what each agent last ran on.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, type TestHomeOptions, testEngine, until } from "../../test/core-fixture"
import { type Script, scriptedEngine } from "../../test/scripted-engine"
import { claudeParser } from "./claude"
import { codexParser } from "./codex"
import type { EngineId, EngineModel } from "./engine"
import type { EngineEvent } from "./events"
import { grokParser } from "./grok"
import { opencodeParser } from "./opencode"
import { piParser } from "./pi"
import { EngineRunner, type RunnerDeps } from "./runner"

const MOON = "MoonFake11111111111111111111111111111111111"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(cleanupHomes)

const reply = (text: string): Script => async (_t, push) => push({ type: "done", text })

async function seamCore(engines: ReturnType<typeof scriptedEngine>[], home: TestHomeOptions = {}, extra: { modelsEveryMs?: number } = {}, without: EngineId[] = []) {
  const c = await startTestCore({ shim: ["/opt/candle-harness"], ...extra, engine: { engines: engines.map((e) => e.engine), without, processes: () => [], leftoverDelayMs: 10 } }, home)
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["agent", "activity", "engine", "cards"] })
  const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").map((e) => e.data as Record<string, unknown>)
  const engineTopic = () => view.events.filter((e) => e.topic === "engine").at(-1)?.data as { agents: Record<string, Record<string, unknown>>; engines: Record<string, Record<string, unknown>> } | undefined
  return { c, view, ended, engineTopic }
}

describe("one conversation across engines", () => {
  test("Claude Code proposes a card, it's approved, and Pi then Codex each get the whole conversation and the card's outcome", async () => {
    let cardId: string | undefined
    let core!: TestCore
    // Claude Code's turn proposes a live buy through the core, as its MCP shim would, with the turn's own token.
    const proposes: Script = async (t, push) => {
      const token = readFileSync(t.mcp.args.at(-1)!, "utf8").trim()
      const { client } = await core.hello(token, { harnessKind: "claude-code" })
      push({ type: "model", model: "claude-opus-5-5" })
      push({ type: "tool_call", id: "c1", name: "mcp__candle__candle_trade", input: { mint: MOON, side: "buy", amount: "0.01" } })
      const answer = await client.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
      const text = (answer.result as { content: { text: string }[] }).content[0]!.text
      cardId = JSON.parse(text).cardId
      push({ type: "tool_result", id: "c1", name: "mcp__candle__candle_trade", output: text, source: "candle" })
      push({ type: "done", text: "Proposed a 0.01 SOL buy of MOON as a card." })
      client.close()
    }
    const claude = scriptedEngine("claude-code", [proposes])
    const pi = scriptedEngine("pi", [async (_t, push) => (push({ type: "model", model: "openrouter/deepseek/deepseek-v4.1-flash" }), push({ type: "done", text: "It filled." }))])
    const codex = scriptedEngine("codex", [reply("Holding.")])
    const { c, view, ended, engineTopic } = await seamCore([claude, pi, codex])
    core = c

    await view.request("agent.send", { text: "buy 0.01 SOL of MOON" })
    await until(() => ended().length === 1)
    expect(cardId).toBeDefined()
    const card = c.core.cards.get(cardId!)!
    expect((await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).error).toBeUndefined()
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")

    await view.request("engine.choose", { agent: "momentum", engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash" })
    await view.request("agent.send", { text: "did it go through?" })
    await until(() => ended().length === 2)
    await view.request("engine.choose", { agent: "momentum", engine: "codex" })
    await view.request("agent.send", { text: "and now?" })
    await until(() => ended().length === 3)

    // Each engine got the whole conversation so far, the user's message last.
    const piPrompt = pi.runs[0]!.prompt
    expect(piPrompt).toContain("buy 0.01 SOL of MOON")
    expect(piPrompt).toContain("Proposed a 0.01 SOL buy of MOON as a card.")
    expect(piPrompt).toEndWith("did it go through?")
    const codexPrompt = codex.runs[0]!.prompt
    expect(codexPrompt).toContain("Proposed a 0.01 SOL buy of MOON as a card.")
    expect(codexPrompt).toContain("It filled.")
    expect(codexPrompt).toEndWith("and now?")
    // The card proposed on Claude Code is reported to Pi and to Codex: the Candle Harness's record names the approved buy.
    for (const prompt of [piPrompt, codexPrompt]) {
      expect(prompt).toContain("What has gone through the Candle Harness lately")
      expect(prompt).toMatch(/asked for by momentum · .*BUY/i)
    }

    // What each turn ran on, journalled and sent with its end.
    const turns = c.core.journal.rows().filter((r) => r.type === "agent.turn")
    expect(turns.map((r) => [r.engine, r.model, r.answeredModel])).toEqual([
      ["claude-code", null, "claude-opus-5-5"],
      ["pi", "openrouter/deepseek/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4.1-flash"],
      ["codex", null, null],
    ])
    expect(ended().map((e) => [e.engine, e.answeredModel])).toEqual([
      ["claude-code", "claude-opus-5-5"],
      ["pi", "openrouter/deepseek/deepseek-v4.1-flash"],
      ["codex", null],
    ])
    // The chip's source: the agent's choice now, and what its last turn ran on.
    await until(() => (engineTopic()?.agents.momentum?.last as { engine?: string } | undefined)?.engine === "codex")
    expect(engineTopic()!.agents.momentum).toMatchObject({ engine: "codex", from: "saved", last: { engine: "codex", model: null, answeredModel: null } })
  })

  test("a turn's start names the engine and model it runs on", async () => {
    const pi = scriptedEngine("pi", [reply("ok")])
    const { view, ended } = await seamCore([scriptedEngine("claude-code", []), pi])
    await view.request("engine.choose", { agent: "momentum", engine: "pi", model: "openrouter/a" })
    await view.request("agent.send", { text: "hi" })
    await until(() => ended().length === 1)
    const started = view.events.find((e) => e.topic === "agent" && (e.data as { type?: string }).type === "started")!.data
    expect(started).toMatchObject({ engine: "pi", model: "openrouter/a" })
  })

  test("a turn that never reached its engine isn't a run: no answering model, and no last run", async () => {
    const { c, view, ended, engineTopic } = await seamCore([scriptedEngine("claude-code", [])], { config: { engine: { ...testEngine, default: "pi" } } }, {}, ["pi"])
    await view.request("agent.send", { text: "hi" })
    await until(() => ended().length === 1)
    expect(ended()[0]).toMatchObject({ outcome: "error" })
    expect(ended()[0]).not.toHaveProperty("engine")
    expect(c.core.journal.rows().find((r) => r.type === "agent.turn")).not.toHaveProperty("answeredModel")
    expect(engineTopic()!.agents.momentum).not.toHaveProperty("last")
  })

  test("the last run survives a restart: the runner reads it back from the journal's turns", () => {
    const rows = [
      { type: "agent.turn", agent: "momentum", engine: "codex", model: "gpt-5.6", answeredModel: null },
      { type: "agent.turn", agent: "momentum", engine: "claude-code", model: "sonnet", answeredModel: "claude-sonnet-5-5" },
      // An older row names no engine, and a turn that never reached one has no answer: neither is a run.
      { type: "agent.turn", agent: "swing", claudeVersion: "2.1.310" },
    ]
    const runner = new EngineRunner({ journal: { rows: () => rows }, agents: () => new Set(["momentum", "swing"]) } as unknown as RunnerDeps)
    expect(runner.lastRan("momentum")).toEqual({ engine: "claude-code", model: "sonnet", answeredModel: "claude-sonnet-5-5" })
    expect(runner.lastRan("swing")).toBeUndefined()
  })
})

describe("the model that answered, from each harness's recorded stream", () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dir, "../../test/fixtures/engine", `${name}.jsonl`), "utf8").split("\n").filter(Boolean)
  const answered = (lines: string[], parse: (l: string) => EngineEvent[]) => lines.flatMap(parse).filter((e) => e.type === "model")

  test("Claude Code, Grok, OpenCode and Pi name it once; Codex never does", () => {
    expect(answered(fixture("claude"), claudeParser())).toEqual([{ type: "model", model: "claude-opus-5-5" }])
    expect(answered(fixture("grok"), grokParser())).toEqual([{ type: "model", model: "grok-4.7" }])
    expect(answered(fixture("opencode"), opencodeParser({ sessionID: "ses_fixture" }))).toEqual([{ type: "model", model: "openai/gpt-5.6-terra-fast" }])
    expect(answered(fixture("pi"), piParser())).toEqual([{ type: "model", model: "fake/fake-1" }])
    expect(answered(fixture("codex"), codexParser())).toEqual([])
  })

  test("a harness's stand-in for no model is never shown as one", () => {
    expect(answered(fixture("claude-signedout"), claudeParser()).map((e) => (e as { model: string }).model)).not.toContain("<synthetic>")
    expect(answered(fixture("grok-signedout"), grokParser())).toEqual([])
  })

  test("OpenCode signed out answers on its free model: that's the model shown, and the turn stops", () => {
    const events = fixture("opencode-signedout").flatMap(opencodeParser({ sessionID: "ses_fixture", model: { providerID: "openai", modelID: "gpt-5.6-terra-fast" } }))
    expect(events[0]).toEqual({ type: "model", model: "opencode/big-pickle" })
    expect(events.at(-1)!.type).toBe("error")
  })
})

describe("the picker's side of the core", () => {
  const LIST: EngineModel[] = [
    { id: "openrouter/a", label: "openrouter/a", isDefault: true },
    { id: "openrouter/b", label: "openrouter/b" },
  ]

  test("lists are read as the core starts; engine.models answers the last read at once, and `fresh` reads again", async () => {
    let reads = 0
    const pi = scriptedEngine("pi", [])
    pi.engine.models = async () => {
      reads += 1
      return reads === 1 ? LIST : [...LIST, { id: "openrouter/c", label: "openrouter/c" }]
    }
    pi.engine.modelNotes = () => ["Your ChatGPT sign-in in Pi isn't offered here: pick Codex for it."]
    const { view, engineTopic } = await seamCore([scriptedEngine("claude-code", []), pi])
    await until(() => typeof engineTopic()?.engines.pi?.modelsReadAt === "number")
    expect(reads).toBe(1)
    const cached = (await view.request("engine.models", { engine: "pi" })).result as Record<string, unknown>
    expect(cached).toMatchObject({ engine: "pi", models: LIST, notes: ["Your ChatGPT sign-in in Pi isn't offered here: pick Codex for it."] })
    expect(typeof cached.readAt).toBe("number")
    expect(reads).toBe(1)
    // Within 30 s of the last read, a fresh ask answers what was just read.
    expect(((await view.request("engine.models", { engine: "pi", fresh: true })).result as { models: unknown[] }).models).toHaveLength(2)
    expect(reads).toBe(1)
  })

  test("reads in flight are shared, and lists are read again on the timer", async () => {
    let reads = 0
    let release!: () => void
    const pi = scriptedEngine("pi", [])
    pi.engine.models = async () => {
      reads += 1
      if (reads === 2) await new Promise<void>((r) => (release = r))
      return LIST
    }
    const { engineTopic } = await seamCore([scriptedEngine("claude-code", []), pi], {}, { modelsEveryMs: 40 })
    await until(() => reads >= 2)
    await Bun.sleep(150)
    expect(reads).toBe(2) // the timer fired again while the second read was out, and joined it
    release()
    await until(() => reads >= 3)
    expect(engineTopic()!.engines.pi!.modelsReadAt).toBeNumber()
  })

  test("the engine topic says each engine's sign-in, how to sign in, and its default by name", async () => {
    const claude = scriptedEngine("claude-code", [])
    claude.engine.signedIn = async () => false
    claude.engine.signIn = "run claude, then /login"
    const pi = scriptedEngine("pi", [], { models: [] })
    pi.engine.signIn = "run pi, then /login"
    const codex = scriptedEngine("codex", [], { models: [{ id: "gpt-5.6", label: "gpt-5.6", isDefault: true }] })
    codex.engine.signedIn = async () => true
    let def: string | undefined
    const realModels = codex.engine.models
    codex.engine.models = async (env) => {
      const list = await realModels(env)
      def = list.find((m) => m.isDefault)?.id
      return list
    }
    codex.engine.defaultModel = () => def
    const { engineTopic } = await seamCore([claude, pi, codex])
    await until(() => [engineTopic()?.engines["claude-code"], engineTopic()?.engines.pi, engineTopic()?.engines.codex].every((e) => typeof e?.modelsReadAt === "number"))
    await until(() => engineTopic()!.engines["claude-code"]!.signedIn === false)
    const t = engineTopic()!
    expect(t.engines["claude-code"]).toMatchObject({ signedIn: false, signIn: "run claude, then /login" })
    // Without a sign-in check of its own, an engine listing no model isn't ready.
    expect(t.engines.pi).toMatchObject({ signedIn: false, signIn: "run pi, then /login" })
    expect(t.engines.codex).toMatchObject({ signedIn: true, defaultModel: "gpt-5.6" })
    // Engines in the build pointing nowhere can't be checked, so they're never read.
    expect(t.engines.grok).toMatchObject({ signedIn: null, modelsReadAt: null })
  })

  test("a list that fails to read keeps the last good one, with the error", async () => {
    let reads = 0
    const pi = scriptedEngine("pi", [])
    pi.engine.models = async () => {
      reads += 1
      if (reads > 1) throw new Error("pi --list-models timed out")
      return LIST
    }
    const { view, engineTopic } = await seamCore([scriptedEngine("claude-code", []), pi], {}, { modelsEveryMs: 30 })
    await until(() => reads >= 2)
    await until(() => typeof engineTopic()?.engines.pi?.modelsReadAt === "number")
    const r = (await view.request("engine.models", { engine: "pi" })).result as Record<string, unknown>
    expect(r.models).toEqual(LIST)
    expect(String(r.error ?? "")).toContain("timed out")
  })

  test("the agent can't switch: a harness is refused engine.models and engine.choose", async () => {
    const { c } = await seamCore([scriptedEngine("claude-code", [])])
    const { client } = await c.harness()
    expect((await client.request("engine.models", { engine: "claude-code" })).error).toMatchObject({ data: { code: "FORBIDDEN_FOR_ROLE" } })
    expect((await client.request("engine.choose", { engine: "claude-code" })).error).toMatchObject({ data: { code: "FORBIDDEN_FOR_ROLE" } })
  })

  test("a Pi with several models and no default of the user's: the turn says to pick one, and nothing is guessed", async () => {
    const pi = scriptedEngine("pi", [reply("unreached")], { models: LIST.map(({ isDefault: _d, ...m }) => m) })
    pi.engine.defaultModel = () => undefined
    const { engineTopic } = await seamCore([scriptedEngine("claude-code", []), pi], { config: { engine: { ...testEngine, default: "pi" } } })
    await until(() => typeof engineTopic()?.engines.pi?.modelsReadAt === "number")
    expect(engineTopic()!.engines.pi).not.toHaveProperty("defaultModel")
    expect(engineTopic()!.agents.momentum).toEqual({ engine: "pi", from: "config", preset: "quant", presetFrom: "config" })
  })
})
