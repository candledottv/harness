// Codex's engine on the seam. The parser against the recorded streams, the arguments, the private home and
// its hand-back, the rate-limit line, the version check and the model list, all on a fake `codex`
// (test/fake-codex.ts).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { fakeCodex } from "../../test/fake-codex"
import { CODEX_RETRY_LOG, codexArgs, codexEngine, codexModels, codexParser, codexStderr, MIN_CODEX } from "./codex"
import type { EngineTurn } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { checkAddresses, type SeenValue, seenFrom } from "./gate"

const MOON = "MoonFake11111111111111111111111111111111111"
const FIXTURES = join(import.meta.dir, "../../test/fixtures/engine")
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function parse(name: string): EngineEvent[] {
  const p = codexParser()
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).flatMap((l) => p(l))
}

async function drain(turn: Turn): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of turn.events) out.push(e)
  return out
}

/** A throwaway world: the user's real Codex home with a sign-in, the core's homes folder, and a research folder. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chrn-codex-")))
  roots.push(root)
  const realHome = join(root, "user/.codex")
  mkdirSync(realHome, { recursive: true })
  const auth = join(realHome, "auth.json")
  writeFileSync(auth, '{"tokens":"old"}')
  const past = new Date(Date.now() - 60_000)
  utimesSync(auth, past, past)
  const homesDir = join(root, "state/homes")
  const researchDir = join(root, "research/momentum")
  mkdirSync(researchDir, { recursive: true })
  const workDir = join(homesDir, "t_test1")
  mkdirSync(workDir, { recursive: true })
  const turn = (over: Partial<EngineTurn> = {}): EngineTurn => ({
    prompt: "the transcript and the message",
    systemPrompt: "You are momentum, a trading agent.",
    researchDir,
    mcpConfig: join(root, "state/turns/t_test1.json"),
    mcp: { command: "/opt/candle-harness", args: ["mcp", "--token-file", join(root, "state/turns/t_test1/token")], env: { CANDLE_HARNESS_HOME: join(root, "config") } },
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "user"), CANDLE_HARNESS_TURN: "t_test1" },
    workDir,
    ...over,
  })
  return { root, realHome, auth, homesDir, researchDir, workDir, turn }
}

// --- The parser, against the recorded streams ---

test("the recorded turn: a Candle tool call, its result labelled candle, and one done", () => {
  const events = parse("codex")
  const call = events.find((e) => e.type === "tool_call" && e.name === "mcp__candle__get_trending") as { id: string } | undefined
  expect(call).toBeDefined()
  const result = events.find((e) => e.type === "tool_result" && e.id === call!.id)
  expect(result).toMatchObject({ source: "candle" })
  expect((result as { output: string }).output).toContain("MoonFake")
  expect(events.filter((e) => e.type === "done")).toHaveLength(1)
  expect(events.at(-1)!.type).toBe("done")
  expect(events.some((e) => e.type === "error")).toBe(false)
})

test("the final reply is the last message, and passes the address gate with MOON labelled candle", () => {
  const events = parse("codex")
  const seen: SeenValue[] = events.flatMap((e) => (e.type === "tool_result" ? seenFrom(e.output, e.source) : []))
  const done = events.find((e) => e.type === "done") as { text: string }
  expect(done.text).toStartWith("Proposed a **0.1 SOL buy of MOON**")
  const gate = checkAddresses(done.text, seen)
  expect(gate.ok).toBe(true)
  expect(gate.labelled).toContainEqual({ address: MOON, source: "candle" })
})

test("each message streams as text, and a web search is labelled web", () => {
  const events = parse("codex")
  expect(events.filter((e) => e.type === "text").length).toBe(3)
  const search = events.find((e) => e.type === "tool_result" && e.name === "web_search")
  expect(search).toMatchObject({ source: "web" })
})

test("the core's research tools come through Candle's server and are labelled file", () => {
  const p = codexParser()
  const line = (type: string, extra: object = {}) =>
    JSON.stringify({ type, item: { id: "item_9", type: "mcp_tool_call", server: "candle", tool: "research_read", arguments: { path: "moon.md" }, ...extra } })
  expect(p(line("item.started"))).toEqual([{ type: "tool_call", id: "item_9", name: "mcp__candle__research_read", input: { path: "moon.md" } }])
  expect(p(line("item.completed", { result: { content: [{ type: "text", text: "MOON notes" }] } }))).toEqual([
    { type: "tool_result", id: "item_9", name: "mcp__candle__research_read", output: "MOON notes", source: "file" },
  ])
})

test("a garbage line yields nothing and doesn't throw", () => {
  const p = codexParser()
  for (const junk of ["", "not json", "{", "[1,2]", "null", '{"type":42}', '{"type":"item.completed","item":null}']) expect(p(junk)).toEqual([])
})

test("signed out: the first 401 ends the turn saying Codex isn't signed in, rather than ten retries later", () => {
  const p = codexParser()
  const lines = readFileSync(join(FIXTURES, "codex-signedout.jsonl"), "utf8").split("\n").filter(Boolean)
  const first401 = lines.findIndex((l) => l.includes("401"))
  const before = lines.slice(0, first401).flatMap((l) => p(l))
  expect(before.some((e) => e.type === "error")).toBe(false)
  const ended = p(lines[first401]!)
  expect(ended).toHaveLength(1)
  const message = (ended[0] as { type: string; message: string }).message
  expect(ended[0]!.type).toBe("error")
  expect(message).toContain("Codex isn't signed in")
  expect(message).toContain("codex login")
})

test("other error lines are retry notices, and turn.failed is the failure", () => {
  const p = codexParser()
  expect(p(JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion)" }))).toEqual([])
  expect(p(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }))).toEqual([{ type: "error", message: "codex: You've hit your usage limit." }])
})

// --- The rate-limit line ---

test("a retry wait over 30 s ends the turn with how long Codex would wait, and the picker's key", () => {
  const watch = codexStderr()
  const line = readFileSync(join(FIXTURES, "codex-ratelimit.stderr"), "utf8").trim()
  const events = watch(line)
  expect(events).toHaveLength(1)
  const message = (events[0] as { message: string }).message
  expect(message).toContain("Codex is rate-limited")
  expect(message).toContain("8 min")
  expect(message).toContain("ctrl-g")
  expect(watch(line)).toEqual([]) // said once
})

test("a short retry wait says nothing, and the wait is read in any unit", () => {
  const at = (wait: string, tail = "") => codexStderr()(`2026-10-28T16:06:52Z  WARN codex_core::responses_retry: stream disconnected - retrying sampling request (2/5 in ${wait})...${tail}`)
  expect(at("1.2s")).toEqual([])
  expect(at("850ms")).toEqual([])
  expect(at("29.9s")).toEqual([])
  const lost = at("45s", " sampling_error=stream disconnected before completion")
  expect((lost[0] as { message: string }).message).toContain("Codex lost its connection")
  expect((lost[0] as { message: string }).message).toContain("45 s")
  expect(codexStderr()("2026-10-28T16:06:32Z  INFO codex_core::shell_snapshot: done")).toEqual([])
})

// --- The arguments ---

test("the arguments: exec with JSON, sandboxed to the research folder, the user's setup and the shell off, the prompt on stdin", () => {
  const w = world()
  const t = w.turn()
  const args = codexArgs({ bin: "codex", systemPrompt: t.systemPrompt, researchDir: t.researchDir, mcp: t.mcp })
  expect(args.slice(0, 2)).toEqual(["codex", "exec"])
  for (const flag of ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral"]) expect(args).toContain(flag)
  expect(args[args.indexOf("-s") + 1]).toBe("workspace-write")
  expect(args[args.indexOf("-C") + 1]).toBe(t.researchDir)
  expect(args.at(-1)).toBe("-") // the prompt is read from stdin, never the command line
  expect(args.join(" ")).not.toContain(t.prompt)
  const disabled = args.flatMap((a, i) => (a === "--disable" ? [args[i + 1]!] : []))
  for (const f of ["shell_tool", "unified_exec", "plugins", "hooks", "apps", "multi_agent", "skill_search", "view_image"]) expect(disabled).toContain(f)
  const config = args.flatMap((a, i) => (a === "-c" ? [args[i + 1]!] : []))
  expect(config).toContain('approval_policy="never"')
  expect(config).toContain("sandbox_workspace_write.exclude_slash_tmp=true")
  expect(config).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true")
  // The user's own instructions and skills, wherever Codex would look: no AGENTS.md, no walk up to a
  // project root, no skills list.
  expect(config).toContain("project_doc_max_bytes=0")
  expect(config).toContain("project_root_markers=[]")
  expect(config).toContain("skills.include_instructions=false")
  expect(config).toContain(`developer_instructions=${JSON.stringify(t.systemPrompt)}`)
  // Our MCP server only, pre-approved, reaching this core.
  expect(config).toContain('mcp_servers.candle.command="/opt/candle-harness"')
  expect(config).toContain(`mcp_servers.candle.args=["mcp", "--token-file", ${JSON.stringify(t.mcp.args[2])}]`)
  expect(config).toContain(`mcp_servers.candle.env.CANDLE_HARNESS_HOME=${JSON.stringify(t.mcp.env.CANDLE_HARNESS_HOME)}`)
  expect(config).toContain('mcp_servers.candle.default_tools_approval_mode="approve"')
  expect(args).not.toContain("-m")
})

test("the model always goes by -m when there is one", () => {
  const w = world()
  const t = w.turn()
  const args = codexArgs({ bin: "codex", systemPrompt: "p", researchDir: t.researchDir, mcp: t.mcp, model: "gpt-6-astra" })
  expect(args[args.indexOf("-m") + 1]).toBe("gpt-6-astra")
  expect(args.at(-1)).toBe("-")
})

test("a quote or newline in the trader prompt stays one TOML string", () => {
  const args = codexArgs({ bin: "codex", systemPrompt: 'Say "hi".\nThen \\ stop.', researchDir: "/r", mcp: { command: "c", args: [], env: {} } })
  const value = args.find((a) => a.startsWith("developer_instructions="))!
  expect(JSON.parse(value.slice("developer_instructions=".length))).toBe('Say "hi".\nThen \\ stop.')
})

// --- What Codex can do, and its words ---

test("Codex's id, minimum and capabilities: no file reads of its own, so the core's research tools; no shell list", () => {
  const e = codexEngine("codex", { homesDir: "/nowhere" })
  expect(e).toMatchObject({ id: "codex", label: "Codex", minVersion: MIN_CODEX })
  expect(MIN_CODEX).toBe("0.165.0")
  expect(e.capabilities()).toEqual({ webSearch: true, webFetch: false, files: "write", shellList: false, deltas: false })
})

test("explain: signed out and anything else", () => {
  const e = codexEngine("codex", { homesDir: "/nowhere" })
  expect(e.explain("codex: unexpected status 401 Unauthorized")).toContain("Codex isn't signed in")
  expect(e.explain(undefined)).toBe("Codex ended without a reply.")
  expect(e.explain("codex: something else")).toBe("codex: something else")
})

// --- The version check ---

test("the version check: the minimum passes, older says update, missing says install, nonsense says so", async () => {
  const w = world()
  const env = { PATH: "/usr/bin:/bin", HOME: join(w.root, "user") }
  expect(await codexEngine(fakeCodex().bin, { homesDir: w.homesDir }).check(env)).toEqual({ ok: true, version: "0.165.0" })
  const old = await codexEngine(fakeCodex({ version: "codex-cli 0.164.0" }).bin, { homesDir: w.homesDir }).check(env)
  expect(old).toMatchObject({ ok: false, version: "0.164.0", message: expect.stringContaining("Update Codex") })
  expect(await codexEngine(join(w.root, "no-such-codex"), { homesDir: w.homesDir }).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("Codex isn't installed") })
  expect(await codexEngine(fakeCodex({ version: "nonsense" }).bin, { homesDir: w.homesDir }).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't read") })
})

test("the version is read under a private, empty CODEX_HOME, never the user's, and the folder is removed", async () => {
  const w = world()
  const fake = fakeCodex()
  await codexEngine(fake.bin, { homesDir: w.homesDir }).check({ PATH: "/usr/bin:/bin", HOME: join(w.root, "user") })
  const run = fake.runs()[0]!
  expect(run.argv).toEqual(["--version"])
  expect(run.env.CODEX_HOME?.startsWith(`${w.homesDir}/`)).toBe(true)
  expect(run.home).toEqual([])
  expect(existsSync(run.env.CODEX_HOME!)).toBe(false)
  expect(readdirSync(w.homesDir).filter((n) => n !== "t_test1")).toEqual([])
})

// --- The model list ---

test("the model list is what Codex lists for the picker, in its order, the first its default", () => {
  const models = codexModels(readFileSync(join(FIXTURES, "codex-models.json"), "utf8"))
  expect(models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
  expect(models[0]).toEqual({ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", isDefault: true })
  expect(models.filter((m) => m.isDefault)).toHaveLength(1)
  expect(codexModels("not json")).toEqual([])
})

test("models are read in a private home holding only the sign-in, and the default is remembered for turns", async () => {
  const w = world()
  const fake = fakeCodex()
  const e = codexEngine(fake.bin, { homesDir: w.homesDir })
  expect(e.defaultModel!()).toBeUndefined()
  const models = await e.models({ PATH: "/usr/bin:/bin", HOME: join(w.root, "user") })
  expect(models[0]!.id).toBe("gpt-6.1-sol")
  expect(e.defaultModel!()).toBe("gpt-6.1-sol")
  const run = fake.runs()[0]!
  expect(run.argv).toEqual(["debug", "models"])
  expect(run.home).toEqual([{ name: "auth.json", link: w.auth }])
  expect(existsSync(run.env.CODEX_HOME!)).toBe(false)
})

test("the user's own CODEX_HOME is where the sign-in comes from, when they set one", async () => {
  const w = world()
  const theirs = join(w.root, "elsewhere")
  mkdirSync(theirs)
  writeFileSync(join(theirs, "auth.json"), "{}")
  const fake = fakeCodex()
  await codexEngine(fake.bin, { homesDir: w.homesDir, codexHome: theirs }).models({ PATH: "/usr/bin:/bin", HOME: join(w.root, "user") })
  expect(fake.runs()[0]!.home).toEqual([{ name: "auth.json", link: join(theirs, "auth.json") }])
})

// --- A turn, on the fake ---

test("a turn: the prompt on stdin, a private home beside the turn's folder holding only a link to the sign-in, and the retry log on", async () => {
  const w = world()
  const fake = fakeCodex()
  const events = await drain(codexEngine(fake.bin, { homesDir: w.homesDir }).start(w.turn({ model: "gpt-6-astra" })))
  expect(events.at(-1)).toMatchObject({ type: "done" })
  const run = fake.runs()[0]!
  expect(run.stdin).toBe("the transcript and the message")
  expect(run.argv[0]).toBe("exec")
  expect(run.argv[run.argv.indexOf("-m") + 1]).toBe("gpt-6-astra")
  expect(run.env.CODEX_HOME).toBe(join(w.homesDir, "t_test1-codex"))
  expect(run.env.RUST_LOG).toBe(CODEX_RETRY_LOG)
  expect(run.env.CANDLE_HARNESS_TURN).toBe("t_test1")
  expect(run.home).toEqual([{ name: "auth.json", link: w.auth }])
  // Handed back and gone: no home, no record.
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
  expect(readFileSync(w.auth, "utf8")).toBe('{"tokens":"old"}')
})

test("a sign-in Codex rotated during the turn is handed back over the real one", async () => {
  const w = world()
  const fake = fakeCodex({ rotateAuth: '{"tokens":"rotated"}' })
  const events = await drain(codexEngine(fake.bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events.at(-1)).toMatchObject({ type: "done" })
  expect(readFileSync(w.auth, "utf8")).toBe('{"tokens":"rotated"}')
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("rate-limited: the turn ends in seconds with words, not eight minutes later, and Codex is stopped", async () => {
  const w = world()
  const fake = fakeCodex({ fixture: "codex-ratelimit", stderr: "codex-ratelimit.stderr", after: "hang" })
  const t0 = performance.now()
  const events = await drain(codexEngine(fake.bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(performance.now() - t0).toBeLessThan(4_000)
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect((events.at(-1) as { message: string }).message).toContain("Codex is rate-limited")
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("signed out: the turn ends at the first 401, and Codex is stopped rather than left retrying", async () => {
  const w = world()
  const fake = fakeCodex({ fixture: "codex-signedout", delayMs: 50, after: "hang" })
  const t0 = performance.now()
  const events = await drain(codexEngine(fake.bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(performance.now() - t0).toBeLessThan(3_000)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Codex isn't signed in") })
})

test("missing from PATH: one error saying Codex isn't installed, and no home left behind", async () => {
  const w = world()
  const events = await drain(codexEngine(join(w.root, "no-such-codex"), { homesDir: w.homesDir }).start(w.turn()))
  expect(events).toHaveLength(1)
  expect((events[0] as { message: string }).message).toContain("Codex isn't installed")
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("dying mid-turn: what came before arrives, then one error and no done", async () => {
  const w = world()
  const events = await drain(codexEngine(fakeCodex({ fixture: "codex-cancel", after: "die" }).bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events.some((e) => e.type === "tool_result")).toBe(true)
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect(events.some((e) => e.type === "done")).toBe(false)
})

test("cancel ends a turn at once", async () => {
  const w = world()
  const turn = codexEngine(fakeCodex({ fixture: "codex-cancel", after: "hang" }).bin, { homesDir: w.homesDir }).start(w.turn())
  const events: EngineEvent[] = []
  const drained = (async () => {
    for await (const e of turn.events) events.push(e)
  })()
  while (!events.some((e) => e.type === "tool_result")) await Bun.sleep(10)
  const t0 = performance.now()
  await turn.cancel()
  await drained
  expect(performance.now() - t0).toBeLessThan(2_000)
  expect(events.at(-1)).toMatchObject({ type: "error", message: "Codex turn cancelled" })
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("a home that can't be made ends the turn with words, rather than throwing", async () => {
  const w = world()
  mkdirSync(join(w.homesDir, "t_test1-codex"))
  const events = await drain(codexEngine(fakeCodex().bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Codex couldn't start") })
})

// --- Through a core ---

describe("Codex through a core", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  afterAll(cleanupHomes)

  async function codexCore(bin: string) {
    const c = await startTestCore({ shim: ["/opt/candle-harness"], engine: { processes: () => [], leftoverDelayMs: 10 } }, { config: { engine: { ...testEngine, codex: { path: bin } } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["agent", "engine"] })
    const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").map((e) => e.data as Record<string, unknown>)
    return { c, view, ended }
  }

  test("an agent switched to Codex with no model runs on Codex's default by name, journalled with the version", async () => {
    const fake = fakeCodex()
    const { c, view, ended } = await codexCore(fake.bin)
    await until(() => c.core.engine.lastCheck("codex")?.ok === true)
    expect((await view.request("engine.choose", { agent: "momentum", engine: "codex" })).result).toEqual({ agent: "momentum", engine: "codex" })
    // The default is read in the background once Codex is chosen, never on the turn's path.
    await until(() => fake.runs().some((r) => r.argv[0] === "debug"))
    await Bun.sleep(100)
    await view.request("agent.send", { text: "what's trending?" })
    await until(() => ended().length === 1)
    expect(ended()[0]).toMatchObject({ outcome: "done", labelled: [{ address: MOON, source: "candle" }] })
    expect(String(ended()[0]!.reply)).toStartWith("Proposed a **0.1 SOL buy of MOON**")
    const exec = fake.runs().find((r) => r.argv[0] === "exec")!
    expect(exec.argv[exec.argv.indexOf("-m") + 1]).toBe("gpt-6.1-sol")
    expect(exec.stdin).toContain("what's trending?")
    expect(exec.env.CODEX_HOME?.startsWith(`${c.p.homesDir}/`)).toBe(true)
    // The trader prompt says how Codex reads its notes.
    const instructions = exec.argv.find((a) => a.startsWith("developer_instructions="))!
    expect(instructions).toContain("research_read")
    const started = c.core.journal.rows().find((r) => r.type === "agent.turn_started")!
    expect(started).toMatchObject({ engine: "codex", engineVersion: "0.165.0", model: "gpt-6.1-sol" })
    expect(started).not.toHaveProperty("claudeVersion")
    expect(c.core.journal.rows().find((r) => r.type === "agent.turn")).toMatchObject({ engine: "codex", model: "gpt-6.1-sol" })
  })

  test("a model picked goes to Codex as it is, and the engine topic shows Codex's check and capabilities", async () => {
    const fake = fakeCodex()
    const { c, view, ended } = await codexCore(fake.bin)
    await until(() => c.core.engine.lastCheck("codex")?.ok === true)
    await view.request("engine.choose", { agent: "momentum", engine: "codex", model: "gpt-6-luna" })
    await view.request("agent.send", { text: "hi" })
    await until(() => ended().length === 1)
    const exec = fake.runs().find((r) => r.argv[0] === "exec")!
    expect(exec.argv[exec.argv.indexOf("-m") + 1]).toBe("gpt-6-luna")
    // Its list is read once, in the background as the core starts, never for the turn.
    expect(fake.runs().filter((r) => r.argv[0] === "debug").length).toBeLessThanOrEqual(1)
    const topic = view.events.filter((e) => e.topic === "engine").at(-1)!.data as { engines: Record<string, { check: unknown; capabilities: unknown }> }
    expect(topic.engines.codex).toMatchObject({ check: { ok: true, version: "0.165.0" }, capabilities: { files: "write", shellList: false } })
  })

  test("a rate-limited Codex turn ends in seconds, with words in the agent pane", async () => {
    const { c, view, ended } = await codexCore(fakeCodex({ fixture: "codex-ratelimit", stderr: "codex-ratelimit.stderr", after: "hang" }).bin)
    await until(() => c.core.engine.lastCheck("codex")?.ok === true)
    await view.request("engine.choose", { agent: "momentum", engine: "codex", model: "gpt-6-luna" })
    await view.request("agent.send", { text: "hi" })
    await until(() => ended().length === 1, 5_000)
    expect(ended()[0]).toMatchObject({ outcome: "error", reply: expect.stringContaining("Codex is rate-limited") })
    await until(() => !c.core.engine.busy())
    expect(readdirSync(c.p.homesDir)).toEqual([])
  })
})

test("the agent's tools: the shell on only for everything, a hidden web search off, and a hidden write a read-only sandbox", () => {
  const w = world()
  const t = w.turn()
  const run = (tools: Parameters<typeof codexArgs>[0]["tools"]) => {
    const args = codexArgs({ bin: "codex", systemPrompt: t.systemPrompt, researchDir: t.researchDir, mcp: t.mcp, ...(tools ? { tools } : {}) })
    return {
      sandbox: args[args.indexOf("-s") + 1],
      disabled: args.flatMap((a, i) => (a === "--disable" ? [args[i + 1]!] : [])),
      config: args.flatMap((a, i) => (a === "-c" ? [args[i + 1]!] : [])),
    }
  }
  // A list means off: Codex can't hold one.
  expect(run({ shell: ["ls"], deny: [] }).disabled).toEqual(expect.arrayContaining(["shell_tool", "unified_exec"]))
  const everything = run({ shell: "everything", deny: [] })
  expect(everything.disabled).not.toContain("shell_tool")
  expect(everything.disabled).not.toContain("unified_exec")
  expect(everything.disabled).toContain("view_image")
  expect(everything.sandbox).toBe("workspace-write")
  expect(everything.config).toContain('web_search="live"')
  const hidden = run({ shell: "off", deny: ["web_search", "write"] })
  expect(hidden.config).toContain('web_search="disabled"')
  expect(hidden.sandbox).toBe("read-only")
})
