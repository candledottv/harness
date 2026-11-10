// OpenCode's engine on the seam, driven over its server. The parser against the recorded streams, the config
// and the isolation it runs under, the read gate (unit-tested apart from OpenCode, then loaded by the fake as
// OpenCode loads it), the model list and its filter of subscriptions held back, and whole turns on a fake
// `opencode` (test/fake-opencode.ts).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { fakeOpenCode } from "../../test/fake-opencode"
import type { EngineTurn } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { checkAddresses, type SeenValue, seenFrom } from "./gate"
import { CandleGate } from "./opencode-gate"
import { SHELL_CASES } from "../../test/shell-cases"
import type { ToolSettings } from "./tools"
import {
  filterModels,
  gateEnv,
  isolation,
  MIN_OPENCODE,
  OPENCODE_TOOLS,
  opencodeConfig,
  opencodeEngine,
  opencodeParser,
  parseAuthList,
  parseModels,
  splitModel,
  userProviders,
} from "./opencode"

const MOON = "MoonFake11111111111111111111111111111111111"
const RECORDED = { providerID: "openai", modelID: "gpt-5.6-terra-fast" }
const FIXTURES = join(import.meta.dir, "../../test/fixtures/engine")
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function parse(name: string, o: Parameters<typeof opencodeParser>[0] = {}): EngineEvent[] {
  const p = opencodeParser(o)
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).flatMap((l) => p(l))
}

async function drain(turn: Turn): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of turn.events) out.push(e)
  return out
}

const alive = (pid: string | undefined) => {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

/** A throwaway world: the user's home with an OpenCode config, the core's state, a research folder, and a turn's folder. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chrn-opencode-")))
  roots.push(root)
  const home = join(root, "user")
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  const configDir = join(root, "config")
  const stateDir = join(configDir, "state")
  mkdirSync(join(stateDir, "keys"), { recursive: true })
  writeFileSync(join(stateDir, "keys/momentum.key"), "KEYCANARY\n")
  const homesDir = join(stateDir, "homes")
  const folder = join(stateDir, "opencode")
  const researchDir = join(configDir, "research/momentum")
  mkdirSync(researchDir, { recursive: true })
  const workDir = join(homesDir, "t_test1")
  mkdirSync(workDir, { recursive: true })
  const turn = (over: Partial<EngineTurn> = {}): EngineTurn => ({
    prompt: "the transcript and the message",
    systemPrompt: "You are momentum, a trading agent.",
    researchDir,
    mcpConfig: join(stateDir, "turns/t_test1.json"),
    mcp: { command: "/opt/candle-harness", args: ["mcp", "--token-file", join(stateDir, "turns/t_test1/token")], env: { CANDLE_HARNESS_HOME: configDir } },
    env: { PATH: "/usr/bin:/bin", HOME: home, CANDLE_HARNESS_TURN: "t_test1" },
    workDir,
    model: "openai/gpt-5.6-terra-fast",
    ...over,
  })
  return { root, home, configDir, stateDir, homesDir, folder, researchDir, workDir, turn }
}

// --- The parser, against the recorded streams ---

test("the recorded turn: Candle's tools labelled candle, text as deltas, and one done whose reply passes the address gate", () => {
  const events = parse("opencode", { sessionID: "ses_fixture", model: RECORDED })
  const call = events.find((e) => e.type === "tool_call" && e.name === "mcp__candle__get_trending") as { id: string } | undefined
  expect(call).toBeDefined()
  const result = events.find((e) => e.type === "tool_result" && e.id === call!.id) as { output: string; source: string }
  expect(result.source).toBe("candle")
  expect(result.output).toContain("MoonFake")
  expect(events.filter((e) => e.type === "done")).toHaveLength(1)
  expect(events.at(-1)!.type).toBe("done")
  expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(20)
  const seen: SeenValue[] = events.flatMap((e) => (e.type === "tool_result" ? seenFrom(e.output, e.source) : []))
  const gate = checkAddresses((events.at(-1) as { text: string }).text, seen)
  expect(gate.ok).toBe(true)
  expect(gate.labelled).toContainEqual({ address: MOON, source: "candle" })
})

test("another session's events are ignored", () => {
  expect(parse("opencode", { sessionID: "ses_other" })).toEqual([])
})

test("an answer on a model other than the one picked ends the turn before anything else counts: the signed-out fallback to OpenCode's free models", () => {
  const events = parse("opencode-signedout", { sessionID: "ses_fixture", model: RECORDED })
  // The model that answered is named first, so the journal records it.
  expect(events).toHaveLength(2)
  expect(events[0]).toEqual({ type: "model", model: "opencode/big-pickle" })
  expect(events[1]).toMatchObject({ type: "error", message: expect.stringContaining("OpenCode answered on opencode/big-pickle, not openai/gpt-5.6-terra-fast") })
})

test("an approval OpenCode asks for is refused and ends the turn with words, since nobody can answer it headless", () => {
  const asked: string[] = []
  const p = opencodeParser({ onPermission: (id) => asked.push(id) })
  const events = p(JSON.stringify({ type: "permission.asked", properties: { id: "per_1", sessionID: "s", permission: "external_directory", patterns: ["/x"] } }))
  expect(asked).toEqual(["per_1"])
  expect(events).toEqual([{ type: "error", message: expect.stringContaining("OpenCode stopped the turn: its external_directory call needed an approval") }])
  expect(p(JSON.stringify({ type: "session.idle", properties: { sessionID: "s" } }))).toEqual([]) // already ended
})

test("a provider sign-in error says so, with how to sign in; an abort says cancelled; any other error is passed on", () => {
  const err = (error: unknown) => opencodeParser()(JSON.stringify({ type: "session.error", properties: { sessionID: "s", error } }))
  expect(err({ name: "ProviderAuthError", data: { providerID: "openrouter", message: "no key" } })[0]).toMatchObject({ message: expect.stringContaining("OpenCode isn't signed in to openrouter. Run opencode auth login") })
  expect(err({ name: "MessageAbortedError", data: { message: "Aborted" } })[0]).toMatchObject({ message: "OpenCode turn cancelled" })
  expect(err({ name: "APIError", data: { message: "Forbidden" } })[0]).toMatchObject({ message: "opencode: Forbidden" })
})

test("a garbage line yields nothing and doesn't throw", () => {
  const p = opencodeParser()
  for (const junk of ["", "not json", "{", "[1,2]", "null", '{"type":42}', '{"type":"message.updated","properties":null}']) expect(p(junk)).toEqual([])
})

// --- Models, and subscriptions held back to their own harness ---

test("a model is provider/model, the model's own id may hold slashes, and anything else isn't one", () => {
  expect(splitModel("openrouter/anthropic/claude-x")).toEqual({ providerID: "openrouter", modelID: "anthropic/claude-x" })
  for (const bad of ["gpt-5", "/x", "x/", ""]) expect(splitModel(bad)).toBeUndefined()
})

test("the list holds back a ChatGPT sign-in's models with a line naming Codex, lists the free ones but never makes one the default", () => {
  const ids = parseModels(readFileSync(join(FIXTURES, "opencode-models.txt"), "utf8"))
  const auth = parseAuthList(readFileSync(join(FIXTURES, "opencode-auth-list.txt"), "utf8"))
  expect(auth).toEqual([{ name: "OpenAI", kind: "oauth" }])
  const r = filterModels(ids, auth)
  expect(r.models.some((m) => m.id.startsWith("openai/"))).toBe(false)
  expect(r.models.length).toBeGreaterThan(0)
  expect(r.models.every((m) => m.id.startsWith("opencode/"))).toBe(true)
  expect(r.models.some((m) => m.isDefault)).toBe(false)
  expect(r.hidden).toEqual(["Your ChatGPT sign-in in OpenCode isn't offered here: subscriptions run through their own engine. Pick Codex for it."])
  expect([...r.held.keys()]).toEqual(["openai"])
})

test("an API key is listed, Claude and Grok sign-ins are held too, and the user's own model choice is the default when it's listed", () => {
  const ids = ["anthropic/claude-x", "openai/gpt-x", "xai/grok-x", "openrouter/vendor/model-a", "openrouter/vendor/model-b", "opencode/free-1"]
  const r = filterModels(ids, [{ name: "Anthropic", kind: "oauth" }, { name: "xAI", kind: "oauth" }, { name: "OpenAI", kind: "api" }, { name: "OpenRouter", kind: "api" }], "openrouter/vendor/model-b")
  expect(r.models.map((m) => m.id)).toEqual(["openai/gpt-x", "openrouter/vendor/model-a", "openrouter/vendor/model-b", "opencode/free-1"])
  expect(r.models.find((m) => m.isDefault)?.id).toBe("openrouter/vendor/model-b")
  expect(r.hidden.join(" ")).toContain("Pick Claude Code")
  expect(r.hidden.join(" ")).toContain("Pick Grok")
  expect(filterModels(ids.slice(1, 2), []).models[0]).toMatchObject({ id: "openai/gpt-x", isDefault: true })
})

test("auth list is read without ANSI codes, and an empty one lists nothing", () => {
  expect(parseAuthList("\u001b[0m\n┌  Credentials \u001b[90m~/x\n│\n●  GitHub Copilot \u001b[90moauth\n│\n└  1 credentials\n")).toEqual([{ name: "GitHub Copilot", kind: "oauth" }])
  expect(parseAuthList("└  0 credentials")).toEqual([])
})

// --- The config and the isolation ---

test("the config: our MCP server and gate only, the research set of tools, nothing that asks, and only the research folder let through", () => {
  const w = world()
  const c = opencodeConfig({ mcp: w.turn().mcp, gateFile: "/state/homes/t/candle-gate.ts", researchDir: w.researchDir }) as any
  expect(c.mcp).toEqual({ candle: { type: "local", command: ["/opt/candle-harness", "mcp", "--token-file", join(w.stateDir, "turns/t_test1/token")], environment: { CANDLE_HARNESS_HOME: w.configDir }, enabled: true } })
  expect(c.plugin).toEqual(["file:///state/homes/t/candle-gate.ts"])
  expect(c.tools["*"]).toBe(false)
  expect(c.tools["candle_*"]).toBe(true)
  for (const t of OPENCODE_TOOLS) expect(c.tools[t]).toBe(true)
  expect(c.tools.bash).toBeUndefined()
  expect(c.permission).toMatchObject({ bash: "deny", task: "deny", skill: "deny", doom_loop: "deny", question: "deny" })
  expect(JSON.stringify(c.permission)).not.toContain('"ask"')
  expect(c.permission.external_directory).toEqual({ "*": "deny", [w.researchDir]: "allow", [`${w.researchDir}/*`]: "allow" })
  expect(c).toMatchObject({ autoupdate: false, share: "disabled", snapshot: false })
})

test("the user's providers and model choice are carried over, and nothing else of their config", () => {
  const w = world()
  writeFileSync(join(w.home, ".config/opencode/config.json"), JSON.stringify({ model: "a/old", provider: { a: { name: "A" } } }))
  writeFileSync(
    join(w.home, ".config/opencode/opencode.jsonc"),
    `{\n  // mine\n  "model": "ollama/llama", "provider": { "ollama": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://localhost:11434/v1" } } },\n  "disabled_providers": ["x"],\n  "mcp": { "theirs": {} }, "plugin": ["theirs"], "instructions": ["AGENTS.md"], "permission": { "bash": "allow" },\n}`,
  )
  const u = userProviders(join(w.home, ".config"))
  expect(u).toEqual({ model: "ollama/llama", provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1" } } }, disabled_providers: ["x"] })
  const c = opencodeConfig({ mcp: w.turn().mcp, gateFile: "/g.ts", researchDir: w.researchDir, user: u }) as any
  expect(Object.keys(c.mcp)).toEqual(["candle"])
  expect(c.plugin).toEqual(["file:///g.ts"])
  expect(c.instructions).toBeUndefined()
  expect(c.permission.bash).toBe("deny")
  writeFileSync(join(w.home, ".config/opencode/opencode.jsonc"), "{ not json")
  expect(userProviders(join(w.home, ".config"))).toEqual({ model: "a/old", provider: { a: { name: "A" } } })
})

test("the isolation: a private HOME, an empty config home that's also the working folder, the user's data, cache and state homes, and their project, Claude Code and external skills off", () => {
  const w = world()
  const iso = isolation({ PATH: "/bin", HOME: w.home }, w.folder, { x: 1 })
  expect(iso.cwd).toBe(join(w.folder, "config/opencode"))
  expect(iso.env).toMatchObject({
    HOME: join(w.folder, "home"),
    XDG_CONFIG_HOME: join(w.folder, "config"),
    OPENCODE_CONFIG_DIR: join(w.folder, "config/opencode"),
    XDG_DATA_HOME: join(w.home, ".local/share"),
    XDG_CACHE_HOME: join(w.home, ".cache"),
    XDG_STATE_HOME: join(w.home, ".local/state"),
    OPENCODE_CONFIG_CONTENT: '{"x":1}',
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  })
  expect(existsSync(iso.cwd) && existsSync(iso.env.HOME!)).toBe(true)
  expect(isolation({ HOME: w.home, XDG_DATA_HOME: "/elsewhere/data" }, w.folder, {}).env.XDG_DATA_HOME).toBe("/elsewhere/data")
})

// --- The gate, apart from OpenCode ---

describe("the read gate", () => {
  let w: ReturnType<typeof world>
  let before: (input: { tool: string }, output: { args?: Record<string, unknown> }) => Promise<void>
  const env = { ...process.env }
  beforeEach(async () => {
    w = world()
    writeFileSync(join(w.researchDir, "inside.txt"), "ok")
    symlinkSync(join(w.stateDir, "keys/momentum.key"), join(w.researchDir, "leak.txt"))
    symlinkSync(join(w.stateDir, "keys"), join(w.researchDir, "keylink"))
    process.env.CANDLE_HARNESS_RESEARCH_DIR = w.researchDir
    process.env.HOME = w.home
    process.env.CANDLE_GATE_MARKER = join(w.workDir, "gate-loaded")
    before = ((await CandleGate()) as { "tool.execute.before": typeof before })["tool.execute.before"]
  })
  afterEach(() => {
    for (const k of ["CANDLE_HARNESS_RESEARCH_DIR", "HOME", "CANDLE_GATE_MARKER"]) if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  })
  const run = async (tool: string, args: Record<string, unknown>) => {
    const output = { args: { ...args } }
    await before({ tool }, output)
    return output.args
  }

  test("it says it loaded", () => {
    expect(readFileSync(join(w.workDir, "gate-loaded"), "utf8")).toBe("loaded\n")
  })

  test("a path inside goes on as its real path in the research folder, relative or not, and a new file inside is allowed", async () => {
    expect(await run("read", { filePath: "inside.txt" })).toEqual({ filePath: join(w.researchDir, "inside.txt") })
    expect(await run("read", { filePath: join(w.researchDir, "inside.txt") })).toEqual({ filePath: join(w.researchDir, "inside.txt") })
    expect(await run("write", { filePath: "notes/new.md", content: "x" })).toEqual({ filePath: join(w.researchDir, "notes/new.md"), content: "x" })
  })

  test("every route out is refused: absolute, ../, ~, a file link, a folder link, /proc, and writes through them", async () => {
    for (const filePath of [join(w.stateDir, "keys/momentum.key"), "../../state/keys/momentum.key", "~/.local/share/opencode/auth.json", "~", "leak.txt", "keylink/momentum.key", "keylink", "/proc/self/environ", ".."]) {
      await expect(run("read", { filePath })).rejects.toThrow("is outside your research folder")
    }
    await expect(run("write", { filePath: "keylink/planted", content: "x" })).rejects.toThrow("is outside your research folder")
    await expect(run("edit", { filePath: "leak.txt", oldString: "a", newString: "b" })).rejects.toThrow("is outside your research folder")
  })

  test("a link whose target is missing is judged by where a write through it lands: outside refused, inside passed on as the target, a loop refused", async () => {
    symlinkSync(join(w.home, "autostart.desktop"), join(w.researchDir, "dangling.md"))
    symlinkSync(join(w.researchDir, "later.md"), join(w.researchDir, "soon.md"))
    symlinkSync(join(w.researchDir, "loop-b"), join(w.researchDir, "loop-a"))
    symlinkSync(join(w.researchDir, "loop-a"), join(w.researchDir, "loop-b"))
    await expect(run("write", { filePath: "dangling.md", content: "x" })).rejects.toThrow("is outside your research folder")
    await expect(run("apply_patch", { patchText: "*** Begin Patch\n*** Add File: dangling.md\n+x\n*** End Patch" })).rejects.toThrow("is outside your research folder")
    expect(await run("write", { filePath: "soon.md", content: "x" })).toEqual({ filePath: join(w.researchDir, "later.md"), content: "x" })
    await expect(run("write", { filePath: "loop-a", content: "x" })).rejects.toThrow()
  })

  test("searches default to the research folder, and refuse a folder or glob outside it; a grep pattern is a regex, not a path", async () => {
    expect(await run("glob", { pattern: "**/*.md" })).toEqual({ pattern: "**/*.md", path: w.researchDir })
    expect(await run("grep", { pattern: "../x", include: "*.md" })).toEqual({ pattern: "../x", include: "*.md", path: w.researchDir })
    for (const args of [{ pattern: "../**" }, { pattern: "/etc/*" }, { pattern: "~/*" }, { pattern: "*", path: ".." }, { pattern: "*", path: "keylink" }]) {
      await expect(run("glob", args)).rejects.toThrow("is outside your research folder")
    }
    await expect(run("grep", { pattern: "KEY", include: "../*" })).rejects.toThrow("is outside your research folder")
  })

  test("an apply_patch's files are held and made the research folder's", async () => {
    const patch = "*** Begin Patch\n*** Add File: notes/a.md\n+hi\n*** End Patch"
    expect((await run("apply_patch", { patchText: patch })).patchText).toBe(`*** Begin Patch\n*** Add File: ${join(w.researchDir, "notes/a.md")}\n+hi\n*** End Patch`)
    await expect(run("apply_patch", { patchText: "*** Begin Patch\n*** Update File: leak.txt\n*** End Patch" })).rejects.toThrow("is outside your research folder")
    await expect(run("apply_patch", { patchText: "*** Begin Patch\n*** Update File: inside.txt\n*** Move to: ../out.txt\n*** End Patch" })).rejects.toThrow("is outside your research folder")
  })

  test("only the research set and Candle's tools run: the shell, sub-agents and anything else are refused", async () => {
    for (const tool of OPENCODE_TOOLS) await run(tool, {})
    await run("candle_trade", { mint: MOON })
    for (const tool of ["bash", "task", "skill", "websearch", "lsp", "codesearch", "mcp_other_tool"]) await expect(run(tool, {})).rejects.toThrow("isn't available to a Candle agent")
  })
})

// --- A turn, on the fake ---

test("a turn: OpenCode isolated in the engine's folder, our gate written and loaded before the prompt, the model and system prompt sent, the session deleted and the server stopped", async () => {
  const w = world()
  const fake = fakeOpenCode()
  const events = await drain(opencodeEngine(fake.bin, { folder: w.folder }).start(w.turn()))
  expect(events.at(-1)).toMatchObject({ type: "done" })
  expect(events.some((e) => e.type === "tool_call" && e.name === "mcp__candle__get_trending")).toBe(true)
  const run = fake.runs().find((r) => r.argv[0] === "serve")!
  expect(run.argv).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"])
  expect(run.cwd).toBe(join(w.folder, "turns/config/opencode"))
  expect(run.env).toMatchObject({
    HOME: join(w.folder, "turns/home"),
    XDG_CONFIG_HOME: join(w.folder, "turns/config"),
    XDG_DATA_HOME: join(w.home, ".local/share"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    CANDLE_HARNESS_RESEARCH_DIR: w.researchDir,
    CANDLE_GATE_MARKER: join(w.workDir, "gate-loaded"),
    CANDLE_HARNESS_TURN: "t_test1",
  })
  expect(run.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
  expect(run.env.OPENCODE_PURE).toBeUndefined()
  // The gate written into the turn's folder is the gate's own source, carried as text.
  const gateFile = join(w.workDir, "candle-gate.ts")
  expect(run.config.plugin).toEqual([`file://${gateFile}`])
  expect(readFileSync(gateFile, "utf8")).toBe(readFileSync(join(import.meta.dir, "opencode-gate.ts"), "utf8"))
  const paths = run.requests.map((r) => `${r.method} ${r.path}`)
  expect(paths).toEqual(["GET /event", "POST /session", "POST /session/ses_fake1/prompt_async", "DELETE /session/ses_fake1"])
  expect(run.requests[2]!.body).toEqual({ parts: [{ type: "text", text: "the transcript and the message" }], model: RECORDED, system: "You are momentum, a trading agent." })
  expect(alive(run.env.PID)).toBe(false)
})

test("a gate that didn't load stops the turn before the prompt is sent", async () => {
  const w = world()
  const fake = fakeOpenCode({ plugins: "skip" })
  const t0 = performance.now()
  const events = await drain(opencodeEngine(fake.bin, { folder: w.folder }).start(w.turn()))
  expect(performance.now() - t0).toBeLessThan(9_000)
  expect(events).toEqual([{ type: "error", message: expect.stringContaining("OpenCode's read gate didn't load") }])
  const run = fake.runs().find((r) => r.argv[0] === "serve")!
  expect(run.requests.some((r) => r.path.endsWith("/prompt_async"))).toBe(false)
  expect(alive(run.env.PID)).toBe(false)
}, 15_000)

test("an answer on another model stops the turn: OpenCode signed out and fell back to its free models", async () => {
  const w = world()
  const events = await drain(opencodeEngine(fakeOpenCode({ fixture: "opencode-signedout" }).bin, { folder: w.folder }).start(w.turn()))
  expect(events).toEqual([{ type: "model", model: "opencode/big-pickle" }, { type: "error", message: expect.stringContaining("OpenCode answered on opencode/big-pickle, not openai/gpt-5.6-terra-fast") }])
})

test("no model picked and none to default to, or one that isn't provider/model, ends the turn with words and starts nothing", async () => {
  const w = world()
  const fake = fakeOpenCode()
  const e = opencodeEngine(fake.bin, { folder: w.folder })
  expect((await drain(e.start(w.turn({ model: undefined }))))[0]).toMatchObject({ message: expect.stringContaining("OpenCode has no model to run here") })
  expect((await drain(e.start(w.turn({ model: "gpt-5" }))))[0]).toMatchObject({ message: expect.stringContaining('"gpt-5" isn\'t one') })
  expect(fake.runs()).toEqual([])
})

test("a model the list held back is refused in a turn too, with the line naming its harness", async () => {
  const w = world()
  const fake = fakeOpenCode()
  const e = opencodeEngine(fake.bin, { folder: w.folder })
  await e.models({ PATH: "/usr/bin:/bin", HOME: w.home })
  expect(e.modelNotes!()).toEqual(["Your ChatGPT sign-in in OpenCode isn't offered here: subscriptions run through their own engine. Pick Codex for it."])
  expect(e.defaultModel!()).toBeUndefined() // only free models are left, and none is picked for you
  const events = await drain(e.start(w.turn()))
  expect(events).toEqual([{ type: "error", message: expect.stringContaining("Pick Codex for it") }])
  expect(fake.runs().some((r) => r.argv[0] === "serve")).toBe(false)
})

test("the models read runs in a folder of its own, isolated as a turn is, and passes the user's providers", async () => {
  const w = world()
  writeFileSync(join(w.home, ".config/opencode/opencode.json"), JSON.stringify({ provider: { mine: { name: "Mine" } }, plugin: ["theirs"] }))
  const fake = fakeOpenCode({ authList: "└  0 credentials" })
  const e = opencodeEngine(fake.bin, { folder: w.folder })
  const models = await e.models({ PATH: "/usr/bin:/bin", HOME: w.home })
  expect(models.find((m) => m.isDefault)?.id).toBe("openai/gpt-5.3-codex-spark")
  expect(e.defaultModel!()).toBe("openai/gpt-5.3-codex-spark")
  const runs = fake.runs()
  expect(runs.map((r) => r.argv.join(" "))).toEqual(["models", "auth list"])
  for (const r of runs) {
    expect(r.cwd).toBe(join(w.folder, "models/config/opencode"))
    expect(r.env.HOME).toBe(join(w.folder, "models/home"))
    expect(r.config).toEqual({ provider: { mine: { name: "Mine" } }, autoupdate: false, share: "disabled" })
  }
})

test("a prompt OpenCode refuses ends the turn with its words, and the server is stopped", async () => {
  const w = world()
  const fake = fakeOpenCode({ promptStatus: 400 })
  const events = await drain(opencodeEngine(fake.bin, { folder: w.folder }).start(w.turn()))
  expect(events).toEqual([{ type: "error", message: expect.stringContaining("the prompt was refused: HTTP 400 model not found") }])
  expect(alive(fake.runs().find((r) => r.argv[0] === "serve")!.env.PID)).toBe(false)
})

test("missing: one error saying OpenCode isn't installed", async () => {
  const w = world()
  const events = await drain(opencodeEngine(join(w.root, "no-such-opencode"), { folder: w.folder }).start(w.turn()))
  expect(events).toHaveLength(1)
  expect((events[0] as { message: string }).message).toContain("OpenCode isn't installed")
})

test("dying mid-turn: what came before arrives, then one error and no done", async () => {
  const w = world()
  const events = await drain(opencodeEngine(fakeOpenCode({ fixture: "opencode-cancel", after: "die" }).bin, { folder: w.folder }).start(w.turn()))
  expect(events.some((e) => e.type === "text")).toBe(true)
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("OpenCode's server stopped mid-turn") })
  expect(events.some((e) => e.type === "done")).toBe(false)
})

test("cancel aborts the session, ends the turn at once and stops the server", async () => {
  const w = world()
  const fake = fakeOpenCode({ fixture: "opencode-cancel", after: "hang", delayMs: 5 })
  const turn = opencodeEngine(fake.bin, { folder: w.folder }).start(w.turn())
  const events: EngineEvent[] = []
  const drained = (async () => {
    for await (const e of turn.events) events.push(e)
  })()
  while (!events.some((e) => e.type === "text")) await Bun.sleep(10)
  const t0 = performance.now()
  await turn.cancel()
  await drained
  expect(performance.now() - t0).toBeLessThan(2_000)
  expect(events.at(-1)).toMatchObject({ type: "error", message: "OpenCode turn cancelled" })
  const run = fake.runs().find((r) => r.argv[0] === "serve")!
  expect(run.requests.map((r) => `${r.method} ${r.path}`)).toContain("POST /session/ses_fake1/abort")
  expect(alive(run.env.PID)).toBe(false)
})

test("the version check: the minimum passes, older says how to update, and missing says how to install", async () => {
  const w = world()
  const env = { PATH: "/usr/bin:/bin", HOME: w.home }
  expect(await opencodeEngine(fakeOpenCode().bin, { folder: w.folder }).check(env)).toEqual({ ok: true, version: MIN_OPENCODE })
  expect(await opencodeEngine(fakeOpenCode({ version: "1.19.4" }).bin, { folder: w.folder }).check(env)).toMatchObject({ ok: false, version: "1.19.4", message: expect.stringContaining("Run opencode upgrade") })
  expect(await opencodeEngine(join(w.root, "nope"), { folder: w.folder }).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("OpenCode isn't installed") })
})

// --- Through a core ---

describe("OpenCode through a core", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  afterAll(cleanupHomes)

  async function opencodeCore(fake: ReturnType<typeof fakeOpenCode>) {
    const c = await startTestCore({ shim: ["/opt/candle-harness"], engine: { processes: () => [], leftoverDelayMs: 10 } }, { config: { engine: { ...testEngine, opencode: { path: fake.bin } } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["agent", "engine"] })
    await until(() => c.core.engine.lastCheck("opencode")?.ok === true)
    const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").map((e) => e.data as Record<string, unknown>)
    return { c, view, ended }
  }

  test("an agent switched to OpenCode runs on the model picked, journalled with OpenCode's version, the shim its only server", async () => {
    const fake = fakeOpenCode({ authList: "└  0 credentials" })
    const { c, view, ended } = await opencodeCore(fake)
    expect((await view.request("engine.choose", { agent: "momentum", engine: "opencode", model: "openai/gpt-5.6-terra-fast" })).error).toBeUndefined()
    await view.request("agent.send", { text: "what's trending?" })
    await until(() => ended().length === 1, 10_000)
    expect(ended()[0]).toMatchObject({ outcome: "done", labelled: [{ address: MOON, source: "candle" }] })
    const serve = fake.runs().find((r) => r.argv[0] === "serve")!
    expect(serve.config.mcp.candle.command[0]).toBe("/opt/candle-harness")
    expect(serve.config.mcp.candle.command).toContain("--token-file")
    expect(serve.cwd).toBe(join(c.p.stateDir, "opencode/turns/config/opencode"))
    const prompt = serve.requests.find((r) => r.path.endsWith("/prompt_async"))!.body
    expect(prompt.parts[0].text).toContain("what's trending?")
    expect(prompt.system).toContain("read and write notes there")
    expect(prompt.system).toContain("There's no web search here.")
    const started = c.core.journal.rows().find((r) => r.type === "agent.turn_started")!
    expect(started).toMatchObject({ engine: "opencode", engineVersion: "1.19.5", model: "openai/gpt-5.6-terra-fast" })
    await until(() => !c.core.engine.busy())
    expect(readdirSync(c.p.homesDir)).toEqual([])
  })

  test("engine.models carries the line for a subscription held back, and a turn typed onto it is refused", async () => {
    const fake = fakeOpenCode()
    const { view, ended } = await opencodeCore(fake)
    const listed = (await view.request("engine.models", { engine: "opencode" })).result as { models: { id: string }[]; notes?: string[] }
    expect(listed.notes).toEqual(["Your ChatGPT sign-in in OpenCode isn't offered here: subscriptions run through their own engine. Pick Codex for it."])
    expect(listed.models.some((m) => m.id.startsWith("openai/"))).toBe(false)
    expect((await view.request("engine.choose", { agent: "momentum", engine: "opencode", model: "openai/gpt-5.6-terra-fast" })).error).toBeUndefined()
    await view.request("agent.send", { text: "what's trending?" })
    await until(() => ended().length === 1, 10_000)
    expect(String(ended()[0]!.reply)).toContain("Pick Codex for it")
    expect(fake.runs().some((r) => r.argv[0] === "serve")).toBe(false)
  })
})

test("the agent's tools: hidden research tools off, and the shell on as OpenCode's own rule and the gate's", () => {
  const w = world()
  const config = (tools: ToolSettings) => opencodeConfig({ mcp: w.turn().mcp, gateFile: "/g.ts", researchDir: w.researchDir, tools }) as any
  const list = config({ shell: ["ls", "git log"], deny: ["web_fetch"] })
  expect(list.tools.bash).toBe(true)
  expect(list.tools.webfetch).toBeUndefined()
  expect(list.tools.read).toBe(true)
  expect(list.permission.bash).toEqual({ "*": "deny", ls: "allow", "ls *": "allow", "git log": "allow", "git log *": "allow" })
  expect(config({ shell: "everything", deny: [] }).permission.bash).toBe("allow")
  const none = config({ shell: "off", allow: ["candle_*"], deny: [] })
  expect(Object.entries(none.tools).filter(([, on]) => on).map(([t]) => t)).toEqual(["candle_*", "todowrite", "todoread", "invalid"])
  expect(none.permission.bash).toBe("deny")
  expect(gateEnv()).toEqual({})
  expect(gateEnv({ shell: ["ls"], deny: ["write"] })).toEqual({ CANDLE_GATE_SHELL: '["ls"]', CANDLE_GATE_TOOLS: "read,list,glob,grep,webfetch,todowrite,todoread,invalid" })
})

describe("the gate with the shell on", () => {
  const research = realpathSync(mkdtempSync(join(tmpdir(), "chrn-ocgate-shell-")))
  afterAll(() => rmSync(research, { recursive: true, force: true }))
  /** The gate's hook under these settings, as OpenCode would load it. */
  async function gateWith(env: Record<string, string>) {
    const saved = Object.fromEntries(["CANDLE_HARNESS_RESEARCH_DIR", "CANDLE_GATE_MARKER", "CANDLE_GATE_SHELL", "CANDLE_GATE_TOOLS"].map((k) => [k, process.env[k]]))
    try {
      delete process.env.CANDLE_GATE_MARKER
      delete process.env.CANDLE_GATE_SHELL
      delete process.env.CANDLE_GATE_TOOLS
      Object.assign(process.env, { CANDLE_HARNESS_RESEARCH_DIR: research, ...env })
      const hook = ((await CandleGate()) as any)["tool.execute.before"] as (i: { tool: string }, o: { args: Record<string, unknown> }) => Promise<void>
      return async (tool: string, args: Record<string, unknown>) => {
        const output = { args: { ...args } }
        await hook({ tool }, output)
        return output.args
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }

  test("a listed plain command runs in the research folder, by the same rule as Pi's (test/shell-cases.ts)", async () => {
    const gates = new Map<string, Awaited<ReturnType<typeof gateWith>>>()
    for (const [setting, command, want] of SHELL_CASES) {
      const key = setting === "off" ? "off" : setting === "everything" ? "everything" : JSON.stringify(setting)
      if (!gates.has(key)) gates.set(key, await gateWith(key === "off" ? {} : { CANDLE_GATE_SHELL: key }))
      const ran = await gates.get(key)!("bash", { command }).then(
        () => true,
        () => false,
      )
      expect([setting, command, ran]).toEqual([setting, command, want])
    }
    const ls = await gateWith({ CANDLE_GATE_SHELL: '["ls"]' })
    expect(await ls("bash", { command: "ls" })).toEqual({ command: "ls", workdir: research })
    await expect(ls("bash", { command: "ls", workdir: "/" })).rejects.toThrow("outside your research folder")
  })

  test("narrowed research tools are refused, Candle's still pass", async () => {
    const run = await gateWith({ CANDLE_GATE_TOOLS: "read,list,glob,grep" })
    await expect(run("write", { filePath: "x.md" })).rejects.toThrow("write isn't available to a Candle agent")
    await expect(run("webfetch", { url: "https://example.com" })).rejects.toThrow("webfetch isn't available")
    await expect(run("bash", { command: "ls" })).rejects.toThrow("bash isn't available")
    expect(await run("candle_get_market", { mint: "x" })).toEqual({ mint: "x" })
  })
})
