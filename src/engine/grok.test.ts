// Grok's engine on the seam. The parser against the recorded streams, the private home's files (config, MCP
// allowlist, sandbox profile), the arguments, the sign-in's copy and hand-back, the sandbox log's read-back,
// the version check and the model list, all on a fake `grok` (test/fake-grok.ts).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { fakeGrok } from "../../test/fake-grok"
import type { EngineTurn } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { checkAddresses, type SeenValue, seenFrom } from "./gate"
import { enforcedParser, GROK_PROFILE, GROK_TOOLS, grokArgs, grokConfig, grokDenies, grokEngine, grokManaged, grokModels, grokParser, grokReads, grokSandbox, MIN_GROK, sandboxEnforced, tempDenies } from "./grok"

const MOON = "MoonFake11111111111111111111111111111111111"
const FIXTURES = join(import.meta.dir, "../../test/fixtures/engine")
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function parse(name: string): EngineEvent[] {
  const p = grokParser()
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).flatMap((l) => p(l))
}

async function drain(turn: Turn): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of turn.events) out.push(e)
  return out
}

/** A throwaway world: the user's Grok home with a sign-in, the core's config and state (keys, token folder), and a research folder. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chrn-grok-")))
  roots.push(root)
  const realHome = join(root, "user/.grok")
  mkdirSync(realHome, { recursive: true })
  const auth = join(realHome, "auth.json")
  writeFileSync(auth, '{"tokens":"old"}')
  const past = new Date(Date.now() - 60_000)
  utimesSync(auth, past, past)
  const configDir = join(root, "config")
  const stateDir = join(configDir, "state")
  mkdirSync(join(stateDir, "keys"), { recursive: true })
  writeFileSync(join(stateDir, "keys/momentum.key"), "a key\n")
  writeFileSync(join(stateDir, "view.token"), "a view token\n")
  const homesDir = join(stateDir, "homes")
  const researchDir = join(configDir, "research/momentum")
  mkdirSync(researchDir, { recursive: true })
  const workDir = join(homesDir, "t_test1")
  mkdirSync(workDir, { recursive: true })
  const tokenFile = join(stateDir, "turns/t_test1/token")
  mkdirSync(join(stateDir, "turns/t_test1"), { recursive: true })
  writeFileSync(tokenFile, "cht_test\n")
  const shimDir = join(root, "bin")
  mkdirSync(shimDir)
  const shim = join(shimDir, "candle-harness")
  writeFileSync(shim, "")
  const turn = (over: Partial<EngineTurn> = {}): EngineTurn => ({
    prompt: "the transcript and the message",
    systemPrompt: "You are momentum, a trading agent.",
    researchDir,
    mcpConfig: join(stateDir, "turns/t_test1.json"),
    mcp: { command: shim, args: ["mcp", "--token-file", tokenFile], env: { CANDLE_HARNESS_HOME: configDir } },
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "user"), CANDLE_HARNESS_TURN: "t_test1" },
    workDir,
    ...over,
  })
  return { root, realHome, auth, configDir, stateDir, homesDir, researchDir, workDir, tokenFile, shim, shimDir, turn }
}

// --- The parser, against the recorded streams ---

test("the recorded turn: Candle's tools through use_tool, reported as the tools that ran and labelled candle, and one done", () => {
  const events = parse("grok")
  const call = events.find((e) => e.type === "tool_call" && e.name === "mcp__candle__get_trending") as { id: string } | undefined
  expect(call).toBeDefined()
  const result = events.find((e) => e.type === "tool_result" && e.id === call!.id)
  expect(result).toMatchObject({ source: "candle" })
  expect((result as { output: string }).output).toContain("MoonFake")
  expect(events.filter((e) => e.type === "done")).toHaveLength(1)
  expect(events.at(-1)!.type).toBe("done")
  expect(events.some((e) => e.type === "error")).toBe(false)
})

test("the final reply passes the address gate with MOON labelled candle, and text streams as deltas", () => {
  const events = parse("grok")
  const seen: SeenValue[] = events.flatMap((e) => (e.type === "tool_result" ? seenFrom(e.output, e.source) : []))
  const done = events.find((e) => e.type === "done") as { text: string }
  expect(done.text).toStartWith("**MOON** is the pick")
  const gate = checkAddresses(done.text, seen)
  expect(gate.ok).toBe(true)
  expect(gate.labelled).toContainEqual({ address: MOON, source: "candle" })
  expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(20)
})

test("an MCP call's input is the tool's own, and the tool search is labelled file, not web", () => {
  const p = grokParser()
  const call = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "use_tool", input: { tool_name: "candle__research_read", tool_input: { path: "moon.md" } } }] } })
  const result = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "MOON notes" }] } })
  expect(p(call)).toEqual([{ type: "tool_call", id: "c1", name: "mcp__candle__research_read", input: { path: "moon.md" } }])
  expect(p(result)).toEqual([{ type: "tool_result", id: "c1", name: "mcp__candle__research_read", output: "MOON notes", source: "file" }])
  for (const e of parse("grok").filter((e) => e.type === "tool_result" && e.name === "search_tool")) expect(e).toMatchObject({ source: "file" })
})

test("a garbage line yields nothing and doesn't throw", () => {
  const p = grokParser()
  for (const junk of ["", "not json", "{", "[1,2]", "null", '{"type":42}', '{"type":"assistant","message":null}']) expect(p(junk)).toEqual([])
})

test("signed out: one error saying Grok isn't signed in, and how to sign in", () => {
  const events = parse("grok-signedout")
  expect(events).toHaveLength(1)
  const ended = events[0] as { type: string; message: string }
  expect(ended.type).toBe("error")
  expect(ended.message).toContain("Grok isn't signed in")
  expect(ended.message).toContain("grok login")
})

test("a failed result is the failure, in Grok's words", () => {
  const p = grokParser()
  expect(p(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["the model is overloaded"] }))).toEqual([{ type: "error", message: "grok: the model is overloaded" }])
})

test("a turn Grok cancels at a file call it couldn't get approved says so, not that someone cancelled it", () => {
  const p = grokParser()
  p(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "read_file", input: { target_file: "leak.txt" } }] } }))
  p(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "content", content: { type: "text", text: "User cancelled the execution for tool `read_file`" } }] }] } }))
  const ended = p(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "cancelled", errors: ["cancelled"] }))
  expect(ended).toHaveLength(1)
  expect((ended[0] as { message: string }).message).toStartWith("Grok stopped the turn: its read_file call needed an approval it can't ask for here, for a file outside the research folder")
  // A tool it isn't given isn't a file; a shell it looked for while its shell is off is said so (seen live).
  const unapprovedUse = (tool_name: string) => {
    const q = grokParser()
    q(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c2", name: "use_tool", input: { tool_name, tool_input: { command: "ls" } } }] } }))
    q(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c2", content: [{ type: "content", content: { type: "text", text: "User cancelled the execution for tool `use_tool`" } }] }] } }))
    return (q(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "cancelled", errors: ["cancelled"] }))[0] as { message: string }).message
  }
  expect(unapprovedUse("image_gen")).toBe("Grok stopped the turn: its use_tool call needed an approval it can't ask for here, for a tool it isn't given. Ask again.")
  expect(unapprovedUse("shell")).toStartWith("Grok stopped the turn: it looked for a shell, and the shell is off for this agent")
  // A shell command off the list ends Grok's turn (seen live): the words name it.
  const r = grokParser()
  r(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c3", name: "run_terminal_command", input: { command: "rm victim.txt" } }] } }))
  r(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c3", content: [{ type: "content", content: { type: "text", text: "User cancelled the execution for tool `run_terminal_command`" } }] }] } }))
  expect(r(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "cancelled", errors: ["cancelled"] }))).toEqual([
    { type: "error", message: "Grok stopped the turn: its shell command `rm victim.txt` isn't one this agent's list lets it run, and Grok ends a turn at a command it can't run rather than carrying on. Ask again without it." },
  ])
  // A cancel with no such call is still Grok's own word.
  expect(grokParser()(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "cancelled", errors: ["cancelled"] }))).toEqual([{ type: "error", message: "grok: cancelled" }])
})

// --- The private home's files ---

test("the config: every compat cell, memory, workflows and subagents off, and our MCP server the only one", () => {
  const w = world()
  const config = grokConfig(w.turn().mcp)
  for (const section of ["[compat.claude]", "[compat.cursor]", "[compat.codex]"]) expect(config).toContain(section)
  for (const cell of ["skills", "rules", "agents", "mcps", "hooks"]) expect(config.match(new RegExp(`^${cell} = false$`, "gm"))?.length).toBeGreaterThanOrEqual(2)
  expect(config).toContain("[memory]\nenabled = false")
  expect(config).toContain("[memory_v2]\nenabled = false")
  expect(config).toContain("[workflows]\nenabled = false")
  expect(config).toContain("[subagents]\nenabled = false")
  expect(config).toContain("auto_update = false")
  expect(config.match(/^\[mcp_servers\./gm)).toEqual(["[mcp_servers."])
  expect(config).toContain(`command = ${JSON.stringify(w.shim)}`)
  expect(config).toContain(`args = ["mcp", "--token-file", ${JSON.stringify(w.tokenFile)}]`)
  expect(config).toContain(`env = { "CANDLE_HARNESS_HOME" = ${JSON.stringify(w.configDir)} }`)
})

test("the MCP allowlist: our server's exact command only, project servers dropped, managed hooks only", () => {
  const w = world()
  const managed = grokManaged(w.turn().mcp)
  expect(managed).toContain("allow_managed_mcp_servers_only = true")
  expect(managed).toContain("enable_all_project_mcp_servers = false")
  expect(managed).toContain("allow_managed_hooks_only = true")
  expect(managed).toContain(`server_command = [${JSON.stringify(w.shim)}, "mcp", "--token-file", ${JSON.stringify(w.tokenFile)}]`)
  expect(managed.match(/\[\[allowed_mcp_servers\]\]/g)).toHaveLength(1)
})

test("the grants: the shim's folder and the turn's token folder, never the core's state or config folder", () => {
  const w = world()
  const reads = grokReads(w.turn().mcp)
  expect(reads.sort()).toEqual([w.shimDir, join(w.stateDir, "turns/t_test1")].sort())
  for (const r of reads) {
    expect(r).not.toBe(w.stateDir)
    expect(r).not.toBe(w.configDir)
    expect(w.stateDir.startsWith(`${r}/`)).toBe(false)
  }
})

test("the grants in development: Bun's folder, and the package a script sits in, since Bun reads its package.json", () => {
  const w = world()
  const pkg = join(w.root, "app")
  mkdirSync(join(pkg, "src"), { recursive: true })
  writeFileSync(join(pkg, "package.json"), "{}")
  writeFileSync(join(pkg, "src/main.ts"), "")
  const reads = grokReads({ command: w.shim, args: [join(pkg, "src/main.ts"), "mcp", "--token-file", w.tokenFile], env: {} })
  expect(reads).toContain(pkg)
  expect(reads).toContain(w.shimDir)
})

test("the file tools are denied the shared temporary folders and TMPDIR, as given and resolved, but never one holding the research folder", () => {
  expect(tempDenies("/srv/candle-harness/research/a", "/var/folders/x/T/")).toEqual(expect.arrayContaining(["/tmp", "/var/tmp", "/dev/shm", "/var/folders/x/T", realpathSync("/tmp")]))
  // A research folder inside a temporary folder: that folder is left out, since a deny wins over the research folder's own allow.
  const research = realpathSync(world().researchDir)
  const left = tempDenies(research, undefined)
  for (const d of left) expect(research.startsWith(`${d}/`)).toBe(false)
  expect(left.length).toBeGreaterThan(0)
  expect(tempDenies("/r", "/")).not.toContain("/")
})

test("the profile: strict, child network on for the socket, the grants read-only, and a deny list", () => {
  const sandbox = grokSandbox({ reads: ["/opt/bin", "/s/turns/t1"], deny: ["/s/keys", "/h/deny-sentinel"] })
  expect(sandbox).toStartWith(`[profiles.${GROK_PROFILE}]\nextends = "strict"\n`)
  expect(sandbox).toContain("restrict_network = false")
  expect(sandbox).toContain('read_only = ["/opt/bin", "/s/turns/t1"]')
  expect(sandbox).toContain("read_write = []")
  expect(sandbox).toContain('deny = ["/s/keys", "/h/deny-sentinel"]')
})

// --- The arguments ---

test("the arguments: the prompt from a file and sent as written, strict profile on the research folder, the research set, no shell, no subagents", () => {
  const w = world()
  const args = grokArgs({ bin: "grok", promptFile: "/h/prompt.md", systemPrompt: "TRADER", researchDir: w.researchDir })
  expect(args[0]).toBe("grok")
  expect(args[args.indexOf("--prompt-file") + 1]).toBe("/h/prompt.md")
  expect(args).toContain("--verbatim")
  expect(args).not.toContain("-p")
  expect(args.join(" ")).not.toContain("the transcript")
  expect(args[args.indexOf("--rules") + 1]).toBe("TRADER")
  expect(args[args.indexOf("--output-format") + 1]).toBe("streaming-messages-json")
  expect(args[args.indexOf("--cwd") + 1]).toBe(w.researchDir)
  expect(args[args.indexOf("--sandbox") + 1]).toBe(GROK_PROFILE)
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
  for (const flag of ["--no-auto-update", "--no-subagents", "--include-partial-messages"]) expect(args).toContain(flag)
  expect(args[args.indexOf("--tools") + 1]).toBe(GROK_TOOLS.join(","))
  expect(GROK_TOOLS).not.toContain("run_terminal_cmd")
  expect(args[args.indexOf("--disallowed-tools") + 1]).toBe("Agent,run_terminal_cmd")
  const allowed = args.flatMap((a, i) => (a === "--allow" ? [args[i + 1]!] : []))
  expect(allowed).toEqual(["MCPTool(candle__*)", `Write(${w.researchDir}/**)`, `Edit(${w.researchDir}/**)`, "Read", "WebFetch"])
  expect(args).not.toContain("-m")
  // What the kernel lets the process read but not the model: each folder itself and everything below, for reads and writes.
  const withDenies = grokArgs({ bin: "grok", promptFile: "/h/prompt.md", systemPrompt: "", researchDir: w.researchDir, denyReads: ["/h", "/proc"] })
  expect(withDenies.flatMap((a, i) => (a === "--deny" ? [withDenies[i + 1]!] : []))).toEqual(["Read(/h)", "Read(/h/**)", "Edit(/h)", "Edit(/h/**)", "Read(/proc)", "Read(/proc/**)", "Edit(/proc)", "Edit(/proc/**)"])
  expect(grokDenies([])).toEqual([])
  expect(grokArgs({ bin: "grok", promptFile: "/p", systemPrompt: "", researchDir: "/r", model: "grok-4.6" }).slice(-2)).toEqual(["-m", "grok-4.6"])
})

// --- The sandbox log's read-back ---

test("the sandbox log: our profile enforced on the research folder passes; unenforced, missing, another profile or another folder doesn't", () => {
  const w = world()
  const home = join(w.root, "h")
  const log = (events: object[]) => {
    mkdirSync(join(home, "sessions"), { recursive: true })
    writeFileSync(join(home, "sessions/sandbox-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"))
  }
  expect(sandboxEnforced(home, w.researchDir)).toContain("Grok's sandbox wasn't confirmed")
  const applied = { event_type: "ProfileApplied", profile: GROK_PROFILE, workspace: w.researchDir, enforced: true }
  log([applied])
  expect(sandboxEnforced(home, w.researchDir)).toBeUndefined()
  log([{ ...applied, enforced: false }])
  expect(sandboxEnforced(home, w.researchDir)).toBeDefined()
  log([{ ...applied, profile: "strict" }])
  expect(sandboxEnforced(home, w.researchDir)).toBeDefined()
  log([{ ...applied, workspace: w.root }])
  expect(sandboxEnforced(home, w.researchDir)).toBeDefined()
})

test("behind the gate, nothing counts until the log is read, and an unconfirmed sandbox is the only event", () => {
  const lines = readFileSync(join(FIXTURES, "grok.jsonl"), "utf8").split("\n").filter(Boolean)
  let reads = 0
  const good = enforcedParser(grokParser(), () => (reads++, undefined))
  expect(lines.flatMap((l) => good(l)).filter((e) => e.type === "done")).toHaveLength(1)
  expect(reads).toBe(1)
  const bad = enforcedParser(grokParser(), () => "not confirmed")
  expect(bad("not json")).toEqual([])
  expect(bad(lines[0]!)).toEqual([{ type: "error", message: "not confirmed" }])
})

// --- What Grok can do, and its words ---

test("Grok's id, minimum and capabilities: its own file tools, web search and fetch, deltas, no shell list", () => {
  const e = grokEngine("grok", { homesDir: "/nowhere" })
  expect(e).toMatchObject({ id: "grok", label: "Grok", minVersion: MIN_GROK })
  expect(MIN_GROK).toBe("1.0.70")
  expect(e.capabilities()).toEqual({ webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true })
})

test("explain: signed out and anything else", () => {
  const e = grokEngine("grok", { homesDir: "/nowhere" })
  expect(e.explain("grok: Not signed in. To authenticate…")).toContain("Grok isn't signed in")
  expect(e.explain(undefined)).toBe("Grok ended without a reply.")
  expect(e.explain("grok: something else")).toBe("grok: something else")
})

// --- The version check ---

test("the version check: the minimum passes, older says update, missing says install, nonsense says so", async () => {
  const w = world()
  const env = { PATH: "/usr/bin:/bin", HOME: join(w.root, "user") }
  expect(await grokEngine(fakeGrok().bin, { homesDir: w.homesDir }).check(env)).toEqual({ ok: true, version: "1.0.70" })
  const old = await grokEngine(fakeGrok({ version: "grok 1.0.69 (abc)" }).bin, { homesDir: w.homesDir }).check(env)
  expect(old).toMatchObject({ ok: false, version: "1.0.69", message: expect.stringContaining("Update Grok") })
  expect(await grokEngine(join(w.root, "no-such-grok"), { homesDir: w.homesDir }).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("Grok isn't installed") })
  expect(await grokEngine(fakeGrok({ version: "nonsense" }).bin, { homesDir: w.homesDir }).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't read") })
})

test("the version is read under a private, empty home, never the user's, and the folder is removed", async () => {
  const w = world()
  const fake = fakeGrok()
  await grokEngine(fake.bin, { homesDir: w.homesDir }).check({ PATH: "/usr/bin:/bin", HOME: join(w.root, "user") })
  const run = fake.runs()[0]!
  expect(run.argv).toEqual(["--version"])
  expect(run.env.GROK_HOME?.startsWith(`${w.homesDir}/`)).toBe(true)
  expect(run.env.HOME).toBe(run.env.GROK_HOME)
  expect(run.env.GROK_DISABLE_AUTOUPDATER).toBe("1")
  expect(run.home).toEqual([])
  expect(existsSync(run.env.GROK_HOME!)).toBe(false)
})

// --- The model list ---

test("the model list is what grok models lists, in its order, with its default marked", () => {
  const models = grokModels(readFileSync(join(FIXTURES, "grok-models.txt"), "utf8"))
  expect(models.map((m) => m.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"])
  expect(models[0]).toEqual({ id: "grok-4.7", label: "grok-4.7", isDefault: true })
  expect(models.filter((m) => m.isDefault)).toHaveLength(1)
  expect(grokModels("You are not logged in.")).toEqual([])
})

test("models are read in a private home holding a copy of the sign-in, and the default is remembered for turns", async () => {
  const w = world()
  const fake = fakeGrok()
  const e = grokEngine(fake.bin, { homesDir: w.homesDir })
  expect(e.defaultModel!()).toBeUndefined()
  const models = await e.models({ PATH: "/usr/bin:/bin", HOME: join(w.root, "user") })
  expect(models[0]!.id).toBe("grok-4.7")
  expect(e.defaultModel!()).toBe("grok-4.7")
  const run = fake.runs()[0]!
  expect(run.argv).toEqual(["models"])
  expect(run.home).toEqual([{ name: "auth.json", file: true }])
  expect(run.files.auth).toBe('{"tokens":"old"}')
  expect(existsSync(run.env.GROK_HOME!)).toBe(false)
})

test("the user's own GROK_HOME is where the sign-in comes from, when they set one", async () => {
  const w = world()
  const theirs = join(w.root, "elsewhere")
  mkdirSync(theirs)
  writeFileSync(join(theirs, "auth.json"), '{"theirs":1}')
  const fake = fakeGrok()
  await grokEngine(fake.bin, { homesDir: w.homesDir, grokHome: theirs }).models({ PATH: "/usr/bin:/bin", HOME: join(w.root, "user") })
  expect(fake.runs()[0]!.files.auth).toBe('{"theirs":1}')
})

// --- A turn, on the fake ---

test("a turn: a private home beside the turn's folder as HOME and GROK_HOME, holding a copy of the sign-in and our own files, and the prompt in a file", async () => {
  const w = world()
  const fake = fakeGrok()
  const events = await drain(grokEngine(fake.bin, { homesDir: w.homesDir }).start(w.turn({ model: "grok-4.6" })))
  expect(events.at(-1)).toMatchObject({ type: "done" })
  const run = fake.runs()[0]!
  const home = join(w.homesDir, "t_test1-grok")
  expect(run.env).toMatchObject({ HOME: home, GROK_HOME: home, GROK_MEMORY: "0", GROK_WORKFLOWS: "0", CANDLE_HARNESS_TURN: "t_test1" })
  expect(run.prompt).toBe("the transcript and the message")
  expect(run.argv[run.argv.indexOf("-m") + 1]).toBe("grok-4.6")
  expect(run.home.map((e) => e.name).sort()).toEqual(["auth.json", "config.toml", "deny-sentinel", "managed_config.toml", "prompt.md", "sandbox.toml"])
  expect(run.home.find((e) => e.name === "auth.json")).toEqual({ name: "auth.json", file: true }) // a copy: strict won't follow a link out
  expect(run.files.auth).toBe('{"tokens":"old"}')
  expect(run.files.managed).toContain(`server_command = [${JSON.stringify(w.shim)}`)
  // The keys, the view token and an empty folder of the home's own are denied; the state folder is never granted.
  const sandbox = run.files.sandbox!
  expect(sandbox).toContain(JSON.stringify(join(w.stateDir, "keys")))
  expect(sandbox).toContain(JSON.stringify(join(w.stateDir, "view.token")))
  expect(sandbox).toContain(JSON.stringify(join(home, "deny-sentinel")))
  expect(sandbox).not.toContain(`${JSON.stringify(w.stateDir)}`)
  expect(sandbox).not.toContain(JSON.stringify(join(w.stateDir, "tokens.json"))) // it doesn't exist here, and Grok would make a file there
  // The file tools are denied Grok's home (the sign-in), the shim's grants (its token) and /proc.
  const denies = run.argv.flatMap((a, i) => (a === "--deny" ? [run.argv[i + 1]!] : []))
  for (const folder of [home, w.shimDir, join(w.stateDir, "turns/t_test1"), "/proc"]) for (const rule of [`Read(${folder})`, `Read(${folder}/**)`, `Edit(${folder}/**)`]) expect(denies).toContain(rule)
  expect(denies.some((d) => d.includes(w.researchDir))).toBe(false)
  // The shared temporary folders too, but one that holds the research folder (this test's), since a deny wins.
  for (const d of ["/tmp", "/var/tmp", "/dev/shm"].filter((d) => !realpathSync(w.researchDir).startsWith(`${existsSync(d) ? realpathSync(d) : d}/`))) expect(denies).toContain(`Read(${d}/**)`)
  // Handed back and gone: no home, no record, no prompt.
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
  expect(readFileSync(w.auth, "utf8")).toBe('{"tokens":"old"}')
})

test("a sign-in Grok refreshed during the turn is handed back over the real one", async () => {
  const w = world()
  const events = await drain(grokEngine(fakeGrok({ rotateAuth: '{"tokens":"refreshed"}' }).bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events.at(-1)).toMatchObject({ type: "done" })
  expect(readFileSync(w.auth, "utf8")).toBe('{"tokens":"refreshed"}')
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("a sandbox Grok's log doesn't confirm ends the turn before anything it said counts, and Grok is stopped", async () => {
  for (const sandbox of ["unenforced", "none"] as const) {
    const w = world()
    const t0 = performance.now()
    const events = await drain(grokEngine(fakeGrok({ sandbox, delayMs: 20, after: "hang" }).bin, { homesDir: w.homesDir }).start(w.turn()))
    expect(performance.now() - t0).toBeLessThan(4_000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Grok's sandbox wasn't confirmed") })
    expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
  }
})

test("signed out: one error saying Grok isn't signed in", async () => {
  const w = world()
  const events = await drain(grokEngine(fakeGrok({ fixture: "grok-signedout" }).bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Grok isn't signed in") })
})

test("missing from PATH: one error saying Grok isn't installed, and no home left behind", async () => {
  const w = world()
  const events = await drain(grokEngine(join(w.root, "no-such-grok"), { homesDir: w.homesDir }).start(w.turn()))
  expect(events).toHaveLength(1)
  expect((events[0] as { message: string }).message).toContain("Grok isn't installed")
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("dying mid-turn: what came before arrives, then one error and no done", async () => {
  const w = world()
  const events = await drain(grokEngine(fakeGrok({ fixture: "grok-cancel", after: "die" }).bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events.some((e) => e.type === "text")).toBe(true)
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect(events.some((e) => e.type === "done")).toBe(false)
})

test("cancel ends a turn at once, and the home is handed back", async () => {
  const w = world()
  const turn = grokEngine(fakeGrok({ fixture: "grok-cancel", after: "hang" }).bin, { homesDir: w.homesDir }).start(w.turn())
  const events: EngineEvent[] = []
  const drained = (async () => {
    for await (const e of turn.events) events.push(e)
  })()
  while (!events.some((e) => e.type === "text")) await Bun.sleep(10)
  const t0 = performance.now()
  await turn.cancel()
  await drained
  expect(performance.now() - t0).toBeLessThan(2_000)
  expect(events.at(-1)).toMatchObject({ type: "error", message: "Grok turn cancelled" })
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("a binary in a folder holding the research folder or the Candle Harness's home is refused, since its grant would open it all", async () => {
  const w = world()
  const shim = join(w.root, "candle-harness") // the root holds config/ and the research folder
  writeFileSync(shim, "")
  const fake = fakeGrok()
  const events = await drain(grokEngine(fake.bin, { homesDir: w.homesDir }).start(w.turn({ mcp: { command: shim, args: ["mcp", "--token-file", w.tokenFile], env: { CANDLE_HARNESS_HOME: w.configDir } } })))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Grok can't run with the Candle Harness's binary in") })
  expect(fake.runs()).toEqual([])
  expect(readdirSync(w.homesDir).sort()).toEqual(["t_test1"])
})

test("a home that can't be made ends the turn with words, rather than throwing", async () => {
  const w = world()
  mkdirSync(join(w.homesDir, "t_test1-grok"))
  const events = await drain(grokEngine(fakeGrok().bin, { homesDir: w.homesDir }).start(w.turn()))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Grok couldn't start") })
})

// --- Through a core ---

describe("Grok through a core", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  afterAll(cleanupHomes)

  async function grokCore(bin: string) {
    const c = await startTestCore({ shim: ["/opt/candle-harness"], engine: { processes: () => [], leftoverDelayMs: 10 } }, { config: { engine: { ...testEngine, grok: { path: bin } } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["agent", "engine"] })
    const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").map((e) => e.data as Record<string, unknown>)
    return { c, view, ended }
  }

  test("an agent switched to Grok with no model runs on Grok's default by name, journalled with the version, the shim the only server", async () => {
    const fake = fakeGrok()
    const { c, view, ended } = await grokCore(fake.bin)
    await until(() => c.core.engine.lastCheck("grok")?.ok === true)
    expect((await view.request("engine.choose", { agent: "momentum", engine: "grok" })).result).toEqual({ agent: "momentum", engine: "grok" })
    await until(() => fake.runs().some((r) => r.argv[0] === "models"))
    await Bun.sleep(100)
    await view.request("agent.send", { text: "what's trending?" })
    await until(() => ended().length === 1)
    expect(ended()[0]).toMatchObject({ outcome: "done", labelled: [{ address: MOON, source: "candle" }] })
    const turn = fake.runs().find((r) => r.argv.includes("--prompt-file"))!
    expect(turn.argv[turn.argv.indexOf("-m") + 1]).toBe("grok-4.7")
    expect(turn.prompt).toContain("what's trending?")
    expect(turn.env.GROK_HOME?.startsWith(`${c.p.homesDir}/`)).toBe(true)
    expect(turn.files.config).toContain('command = "/opt/candle-harness"')
    expect(turn.files.config).toContain('"--token-file"')
    // The turn's token folder is granted; the core's state folder, which holds it, never is.
    const tokenDir = /--token-file", "([^"]+)\/token"/.exec(turn.files.config!)![1]!
    expect(turn.files.sandbox).toContain(JSON.stringify(tokenDir))
    expect(turn.files.sandbox).not.toContain(`${JSON.stringify(c.p.stateDir)},`)
    expect(turn.files.sandbox).toContain(JSON.stringify(c.p.keysDir))
    expect(turn.argv[turn.argv.indexOf("--rules") + 1]).toContain("read and write notes there")
    const started = c.core.journal.rows().find((r) => r.type === "agent.turn_started")!
    expect(started).toMatchObject({ engine: "grok", engineVersion: "1.0.70", model: "grok-4.7" })
    await until(() => !c.core.engine.busy())
    expect(readdirSync(c.p.homesDir)).toEqual([])
  })

  test("the engine topic shows Grok's check and capabilities", async () => {
    const { c, view } = await grokCore(fakeGrok().bin)
    await until(() => c.core.engine.lastCheck("grok")?.ok === true)
    await until(() => view.events.some((e) => e.topic === "engine" && (e.data as { engines: Record<string, { check: unknown }> }).engines.grok?.check !== null))
    const topic = view.events.filter((e) => e.topic === "engine").at(-1)!.data as { engines: Record<string, { check: unknown; capabilities: unknown }> }
    expect(topic.engines.grok).toMatchObject({ check: { ok: true, version: "1.0.70" }, capabilities: { files: "own", shellList: true, webFetch: true } })
  })
})

test("the agent's tools: hidden research tools left out and not allowed, and the shell on only for everything", () => {
  const w = world()
  const run = (tools: Parameters<typeof grokArgs>[0]["tools"]) => {
    const args = grokArgs({ bin: "grok", promptFile: "/p", systemPrompt: "", researchDir: w.researchDir, ...(tools ? { tools } : {}) })
    return {
      tools: args[args.indexOf("--tools") + 1],
      allowed: args.flatMap((a, i) => (a === "--allow" ? [args[i + 1]!] : [])),
      disallowed: args[args.indexOf("--disallowed-tools") + 1],
      mode: args[args.indexOf("--permission-mode") + 1],
    }
  }
  // A list is Grok's own allow rules under dontAsk: each entry
  // alone, as a glob only ([l]s, so lsof doesn't match), and with arguments.
  expect(run({ shell: ["ls", "git log"], deny: [] })).toEqual({
    tools: `${GROK_TOOLS.join(",")},run_terminal_cmd`,
    allowed: ["MCPTool(candle__*)", `Write(${w.researchDir}/**)`, `Edit(${w.researchDir}/**)`, "Read", "WebFetch", "Bash([l]s)", "Bash(ls *)", "Bash([g]it log)", "Bash(git log *)"],
    disallowed: "Agent",
    mode: "dontAsk",
  })
  expect(run(undefined)).toMatchObject({ tools: GROK_TOOLS.join(","), disallowed: "Agent,run_terminal_cmd", mode: "dontAsk" })
  expect(run({ shell: "everything", deny: [] })).toEqual({
    tools: `${GROK_TOOLS.join(",")},run_terminal_cmd`,
    allowed: ["MCPTool(candle__*)", `Write(${w.researchDir}/**)`, `Edit(${w.researchDir}/**)`, "Read", "WebFetch"],
    disallowed: "Agent",
    mode: "bypassPermissions",
  })
  expect(run({ shell: "off", deny: ["read", "web_fetch"] })).toEqual({
    tools: "write,search_replace,todo_write,web_search",
    allowed: ["MCPTool(candle__*)", `Write(${w.researchDir}/**)`, `Edit(${w.researchDir}/**)`],
    disallowed: "Agent,run_terminal_cmd",
    mode: "dontAsk",
  })
})

test("Grok counts as signed in only with its sign-in file there: a lock file left beside a removed one isn't a sign-in", async () => {
  const home = mkdtempSync(join(tmpdir(), "chrn-grok-signed-"))
  try {
    const e = grokEngine("grok", { homesDir: "/nowhere", grokHome: home })
    writeFileSync(join(home, "auth.json.lock"), "")
    expect(await e.signedIn!({ HOME: home })).toBe(false)
    writeFileSync(join(home, "auth.json"), "{}")
    expect(await e.signedIn!({ HOME: home })).toBe(true)
    // Grok removes it when its sign-in is refused: read again, it's gone.
    rmSync(join(home, "auth.json"))
    expect(await e.signedIn!({ HOME: home })).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
