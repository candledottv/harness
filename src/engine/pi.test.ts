// Pi's engine on the seam. The parser against streams recorded from the real Pi 1.4.0, the private agent
// folder, the read gate (unit-tested apart from Pi, then loaded by the fake as Pi loads it), web_fetch, the
// model list and its filter of subscriptions held back, local servers, and whole turns on a fake `pi`
// (test/fake-pi.ts).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { fakePi } from "../../test/fake-pi"
import type { EngineTurn } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { checkAddresses, type SeenValue, seenFrom } from "./gate"
import { filterModels, findLocal, MIN_PI, PI_TOOLS, parseModels, piArgs, piEngine, piGateEnv, piParser, privateAgentDir, splitModel, userDefault } from "./pi"
import candleGate, { type Checked, checkPath, checkUrl, fetchText, gateShell, MAX_CHARS, pageText, piPath, privateAddress, refuseUrl } from "./pi-gate"

const MOON = "MoonFake11111111111111111111111111111111111"
const FIXTURES = join(import.meta.dir, "../../test/fixtures/engine")
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function parse(name: string, o: Parameters<typeof piParser>[0] = {}): EngineEvent[] {
  const p = piParser(o)
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

/** A throwaway world: the user's home with a Pi setup, the core's state, a research folder, and a turn's folder. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chrn-pi-")))
  roots.push(root)
  const home = join(root, "user")
  const userDir = join(home, ".pi/agent")
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "SIGNINCANARY" } }), { mode: 0o600 })
  writeFileSync(join(userDir, "models.json"), JSON.stringify({ providers: { mine: { name: "Mine", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "x", models: [{ id: "m1" }] } } }))
  writeFileSync(join(userDir, "models-store.json"), "{}")
  // The user's own setup, none of which may reach a turn's folder.
  for (const f of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md", "extensions/theirs.ts", "skills/s/SKILL.md", "prompts/p.md"]) {
    mkdirSync(join(userDir, f, ".."), { recursive: true })
    writeFileSync(join(userDir, f), "USERSETUPCANARY")
  }
  writeFileSync(join(userDir, "mcp.json"), JSON.stringify({ mcpServers: { theirs: { command: "theirs" } } }))
  writeFileSync(join(userDir, "settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: "~anthropic/claude-haiku-latest", extensions: ["theirs"] }))
  const configDir = join(root, "config")
  const stateDir = join(configDir, "state")
  mkdirSync(join(stateDir, "keys"), { recursive: true })
  writeFileSync(join(stateDir, "keys/momentum.key"), "KEYCANARY\n")
  const homesDir = join(stateDir, "homes")
  const researchDir = join(configDir, "research/momentum")
  mkdirSync(researchDir, { recursive: true })
  const workDir = join(homesDir, "t_test1")
  mkdirSync(workDir, { recursive: true })
  const env = { PATH: "/usr/bin:/bin", HOME: home, CANDLE_HARNESS_TURN: "t_test1" }
  const turn = (over: Partial<EngineTurn> = {}): EngineTurn => ({
    prompt: "the transcript and the message",
    systemPrompt: "You are momentum, a trading agent.",
    researchDir,
    mcpConfig: join(stateDir, "turns/t_test1.json"),
    mcp: { command: "/opt/candle-harness", args: ["mcp", "--token-file", join(stateDir, "turns/t_test1/token")], env: { CANDLE_HARNESS_HOME: configDir } },
    env,
    workDir,
    model: "openrouter/~anthropic/claude-haiku-latest",
    ...over,
  })
  return { root, home, userDir, configDir, stateDir, homesDir, researchDir, workDir, env, turn }
}

// --- The parser, against the recorded streams ---

test("the recorded turn: Candle's tool labelled candle, text as deltas, and one done whose reply passes the address gate", () => {
  const events = parse("pi", { model: "fake/fake-1" })
  const call = events.find((e) => e.type === "tool_call" && e.name === "mcp__candle__get_trending") as { id: string } | undefined
  expect(call).toBeDefined()
  const result = events.find((e) => e.type === "tool_result" && e.id === call!.id) as { output: string; source: string }
  expect(result.source).toBe("candle")
  expect(result.output).toContain("MoonFake")
  expect(events.filter((e) => e.type === "done")).toHaveLength(1)
  expect(events.at(-1)!.type).toBe("done")
  expect(events.some((e) => e.type === "text")).toBe(true)
  const seen: SeenValue[] = events.flatMap((e) => (e.type === "tool_result" ? seenFrom(e.output, e.source) : []))
  const gate = checkAddresses((events.at(-1) as { text: string }).text, seen)
  expect(gate.ok).toBe(true)
  expect(gate.labelled).toContainEqual({ address: MOON, source: "candle" })
})

test("a read the gate refused arrives as an error result in the gate's words, labelled file, and the turn goes on", () => {
  const events = parse("pi-refused", { model: "fake/fake-1" })
  expect(events.find((e) => e.type === "tool_result")).toMatchObject({ name: "read", output: "error: leak.txt is outside your research folder", source: "file" })
  expect(events.at(-1)!.type).toBe("done")
})

test("a provider refusing the key is one error, and the engine's words say where to fix it", () => {
  const events = parse("pi-fail")
  expect(events).toEqual([{ type: "model", model: "fake/fake-1" }, { type: "error", message: expect.stringMatching(/^pi: 401: .*Incorrect API key/) }])
  const e = piEngine("pi", { homesDir: "/nonexistent" })
  expect(e.explain((events[1] as { message: string }).message)).toContain("Pi's key for that provider was refused: check it with pi then /login")
})

test("a turn cut off mid-stream yields its text and no ending: the runner ends it", () => {
  const events = parse("pi-cancel")
  expect(events.some((e) => e.type === "text")).toBe(true)
  expect(events.some((e) => e.type === "done" || e.type === "error")).toBe(false)
})

test("an answer on a model other than the one picked ends the turn before anything else counts", () => {
  const events = parse("pi", { model: "openrouter/anthropic/claude-haiku-5.5" })
  expect(events).toEqual([{ type: "model", model: "fake/fake-1" }, { type: "error", message: expect.stringContaining("Pi answered on fake/fake-1, not openrouter/anthropic/claude-haiku-5.5") }])
})

test("an aborted run says cancelled; a call another tool made isn't the model's; garbage yields nothing", () => {
  expect(piParser()(JSON.stringify({ type: "agent_settled", aborted: true }))).toEqual([{ type: "error", message: "Pi turn cancelled" }])
  const p = piParser()
  expect(p(JSON.stringify({ type: "tool_execution_start", toolCallId: "a/1", parentToolCallId: "a", toolName: "read", args: {} }))).toEqual([])
  expect(p(JSON.stringify({ type: "tool_execution_end", toolCallId: "a/1", parentToolCallId: "a", toolName: "read", result: { content: [] } }))).toEqual([])
  for (const junk of ["", "not json", "{", "[1,2]", "null", '{"type":42}', '{"type":"message_end","message":null}']) expect(p(junk)).toEqual([])
})

// --- Models, and subscriptions held back to their own harness ---

test("the model list is the table's provider and model, with the model's own slashes and ~ kept", () => {
  const ids = parseModels(readFileSync(join(FIXTURES, "pi-models.txt"), "utf8"))
  expect(ids).toHaveLength(11)
  expect(ids[0]).toBe("openrouter/~anthropic/claude-fable-latest")
  expect(parseModels("")).toEqual([])
  // Pi 1.4.0 with no models: a sentence and two paths, never a model (it once showed as "No/models").
  expect(parseModels("No models available. Use /login to log into a provider via OAuth or API key. See:\n  /usr/lib/pi/docs/providers.md\n  /usr/lib/pi/docs/models.md\n")).toEqual([])
  expect(splitModel("openrouter/~anthropic/claude-x")).toEqual({ provider: "openrouter", model: "~anthropic/claude-x" })
  for (const bad of ["gpt-5", "/x", "x/", ""]) expect(splitModel(bad)).toBeUndefined()
})

test("Claude, ChatGPT and Grok sign-ins are held back with a line naming their harness; API keys and other sign-ins are listed", () => {
  const ids = ["anthropic/claude-x", "openai/gpt-x", "openai-codex/gpt-y", "xai/grok-x", "openrouter/a", "github-copilot/b", "ollama/llama"]
  const r = filterModels(ids, { anthropic: "oauth", openai: "api_key", "openai-codex": "oauth", xai: "oauth" })
  expect(r.models.map((m) => m.id)).toEqual(["openai/gpt-x", "openrouter/a", "github-copilot/b", "ollama/llama"])
  expect(r.hidden).toEqual([
    "Your Claude sign-in in Pi isn't offered here: subscriptions run through their own harness. Pick Claude Code for it.",
    "Your ChatGPT sign-in in Pi isn't offered here: subscriptions run through their own harness. Pick Codex for it.",
    "Your SuperGrok sign-in in Pi isn't offered here: subscriptions run through their own harness. Pick Grok for it.",
  ])
})

test("the default is the user's own Pi default when listed, else the only model; with several and none set, nothing is picked", () => {
  expect(filterModels(["openrouter/a", "openrouter/b"], {}, "openrouter/b").models.find((m) => m.isDefault)?.id).toBe("openrouter/b")
  expect(filterModels(["ollama/llama"], {}).models[0]!.isDefault).toBe(true)
  expect(filterModels(["openrouter/a", "openrouter/b"], {}).models.some((m) => m.isDefault)).toBe(false)
  expect(filterModels(["anthropic/c", "openrouter/a", "openrouter/b"], { anthropic: "oauth" }, "anthropic/c").models.some((m) => m.isDefault)).toBe(false)
  const w = world()
  expect(userDefault(w.userDir)).toBe("openrouter/~anthropic/claude-haiku-latest")
  expect(userDefault(join(w.root, "none"))).toBeUndefined()
})

test("a local server answering on its port is offered unless the user's models.json names it; one not running isn't", async () => {
  const w = world()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (new URL(req.url).pathname === "/v1/models" ? Response.json({ data: [{ id: "llama3.3" }, { id: "qwen3" }] }) : new Response("no", { status: 404 })) })
  try {
    const base = `http://127.0.0.1:${server.port}/v1`
    const found = await findLocal([{ id: "ollama", name: "Ollama", baseUrl: base }, { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:9/v1" }], w.userDir)
    expect(found).toEqual({ ollama: { name: "Ollama (running here)", baseUrl: base, api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.3", name: "llama3.3" }, { id: "qwen3", name: "qwen3" }] } })
    writeFileSync(join(w.userDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://localhost:${server.port}/v1` } } }))
    expect(await findLocal([{ id: "ollama", name: "Ollama", baseUrl: base }], w.userDir)).toEqual({})
  } finally {
    server.stop(true)
  }
})

// --- The private agent folder and the command line ---

test("the private folder: the sign-in linked, models copied with any local server added, our MCP server alone, trust never, and nothing else of theirs", () => {
  const w = world()
  const dir = join(w.workDir, "pi")
  const extra = { ollama: { name: "Ollama (running here)", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.3", name: "llama3.3" }] } }
  privateAgentDir({ userDir: w.userDir, dir, mcp: w.turn().mcp, extra })
  expect(readdirSync(dir).sort()).toEqual(["auth.json", "mcp.json", "models-store.json", "models.json", "settings.json"])
  expect(realpathSync(join(dir, "auth.json"))).toBe(join(w.userDir, "auth.json"))
  expect(Object.keys(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers).sort()).toEqual(["mine", "ollama"])
  expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
    autoEnableCodemode: false,
    mcpServers: { candle: { command: "/opt/candle-harness", args: ["mcp", "--token-file", join(w.stateDir, "turns/t_test1/token")], env: { CANDLE_HARNESS_HOME: w.configDir }, exposure: "direct" } },
  })
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ defaultProjectTrust: "never" })
  // A sign-in Pi refreshes is written through the link, so it lands in the user's own file.
  writeFileSync(join(dir, "auth.json"), "REFRESHED")
  expect(readFileSync(join(w.userDir, "auth.json"), "utf8")).toBe("REFRESHED")
  // The address gate's re-ask runs Pi again in the same turn folder: the link is made again, and the user's own file is untouched.
  privateAgentDir({ userDir: w.userDir, dir, mcp: w.turn().mcp, extra })
  expect(realpathSync(join(dir, "auth.json"))).toBe(join(w.userDir, "auth.json"))
  expect(readFileSync(join(w.userDir, "auth.json"), "utf8")).toBe("REFRESHED")
})

test("the command line: json print mode, no session, discovery off, MCP and our gate back on alone, the model, the research set, and our system prompt; never the prompt", () => {
  expect(piArgs({ bin: "pi", gateFile: "/w/candle-gate.ts", model: "openrouter/x", systemPrompt: "SYS" })).toEqual([
    "pi", "--mode", "json", "-p", "--no-session",
    "--no-extensions", "-e", "builtin:mcp", "-e", "/w/candle-gate.ts",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--model", "openrouter/x",
    "--tools", "read,write,edit,ls,web_fetch,mcp__candle__*",
    "--system-prompt", "SYS",
  ])
  expect(PI_TOOLS).not.toContain("bash")
})

// --- The read gate, apart from Pi ---

describe("the read gate", () => {
  const w = world()
  const research = w.researchDir
  writeFileSync(join(research, "inside.md"), "INSIDE")
  writeFileSync(join(w.home, "outside.txt"), "OUTSIDE")
  symlinkSync(join(w.stateDir, "keys/momentum.key"), join(research, "leak.txt"))
  symlinkSync(w.stateDir, join(research, "statelink"))
  // Names Pi would rewrite on the way to a different file: a Unicode space, and a curly apostrophe.
  symlinkSync(w.stateDir, join(research, "state link"))
  symlinkSync(w.stateDir, join(research, "it\u2019s"))
  const check = (tool: string, raw: unknown) => checkPath(tool, raw, research, w.home)

  test("a path inside goes on as its real path, relative or not, and a new file in a new folder inside is allowed", () => {
    expect(check("read", "inside.md")).toEqual({ ok: true, path: join(research, "inside.md") })
    expect(check("read", join(research, "inside.md"))).toEqual({ ok: true, path: join(research, "inside.md") })
    expect(check("read", "@inside.md")).toEqual({ ok: true, path: join(research, "inside.md") })
    expect(check("write", "notes/new/today.md")).toEqual({ ok: true, path: join(research, "notes/new/today.md") })
    expect(check("ls", undefined)).toEqual({ ok: true, path: research })
    expect(check("edit", `file://${join(research, "inside.md")}`)).toEqual({ ok: true, path: join(research, "inside.md") })
  })

  test("every route out is refused: absolute, ../, ~, @, a file URL, a file link, a folder link, /proc, and writes through them", () => {
    for (const raw of [join(w.home, "outside.txt"), "../../../user/outside.txt", "~/outside.txt", "~", "@../../../user/outside.txt", `file://${join(w.home, "outside.txt")}`, "leak.txt", "statelink/keys/momentum.key", "/proc/self/environ", ".."]) {
      expect(check("read", raw)).toEqual({ ok: false, reason: `${raw} is outside your research folder` })
    }
    for (const raw of ["statelink/new.txt", "../escape.md", join(w.home, "new.txt")]) expect(check("write", raw)).toMatchObject({ ok: false })
    expect(check("ls", w.home)).toMatchObject({ ok: false })
  })

  test("a link whose target is missing is judged by where a write through it lands: outside refused, inside passed on as the target, a loop refused", () => {
    symlinkSync(join(w.home, "autostart.desktop"), join(research, "dangling.md"))
    symlinkSync(join(research, "later.md"), join(research, "soon.md"))
    symlinkSync(join(research, "loop-b"), join(research, "loop-a"))
    symlinkSync(join(research, "loop-a"), join(research, "loop-b"))
    expect(check("write", "dangling.md")).toEqual({ ok: false, reason: "dangling.md is outside your research folder" })
    expect(check("edit", "dangling.md")).toMatchObject({ ok: false })
    expect(check("write", "soon.md")).toEqual({ ok: true, path: join(research, "later.md") })
    expect(check("write", "loop-a")).toMatchObject({ ok: false })
  })

  test("a name Pi would rewrite is checked as Pi rewrites it, and a read of a missing file is refused, since Pi then tries look-alike names", () => {
    expect(check("read", "state\u00A0link/keys/momentum.key")).toMatchObject({ ok: false, reason: expect.stringContaining("outside your research folder") })
    expect(check("read", "it's/keys/momentum.key")).toEqual({ ok: false, reason: "it's/keys/momentum.key doesn't exist in your research folder" })
    expect(check("read", "missing.md")).toEqual({ ok: false, reason: "missing.md doesn't exist in your research folder" })
    expect(check("read", "")).toMatchObject({ ok: false })
    expect(check("read", 42)).toMatchObject({ ok: false })
  })

  test("Pi's own path rules: @, ~, a file URL and Unicode spaces", () => {
    expect(piPath("@a", "/r", "/h")).toBe("/r/a")
    expect(piPath("~/a", "/r", "/h")).toBe("/h/a")
    expect(piPath("file:///x/y", "/r", "/h")).toBe("/x/y")
    expect(piPath("a\u202Fb", "/r", "/h")).toBe("/r/a b")
  })

  test("the extension: Candle's tools and web_fetch pass, the file tools get the checked path, and every other tool is refused", async () => {
    const handlers: ((e: unknown) => Promise<unknown>)[] = []
    const tools: string[] = []
    const before = process.env.CANDLE_HARNESS_RESEARCH_DIR
    process.env.CANDLE_HARNESS_RESEARCH_DIR = research
    try {
      candleGate({ on: (_e: string, h: (e: unknown) => Promise<unknown>) => handlers.push(h), registerTool: (t: { name: string }) => tools.push(t.name) })
    } finally {
      process.env.CANDLE_HARNESS_RESEARCH_DIR = before
    }
    expect(tools).toEqual(["web_fetch"])
    const run = (toolName: string, input: Record<string, unknown> = {}) => {
      const event = { toolName, input }
      return handlers[0]!(event).then((r) => ({ r, input: event.input }))
    }
    expect((await run("mcp__candle__get_trending")).r).toBeUndefined()
    expect((await run("web_fetch", { url: "https://example.com" })).r).toBeUndefined()
    const read = await run("read", { path: "@inside.md" })
    expect(read).toEqual({ r: undefined, input: { path: join(research, "inside.md") } })
    expect((await run("read", { path: "leak.txt" })).r).toEqual({ block: true, reason: "leak.txt is outside your research folder" })
    for (const tool of ["bash", "grep", "find", "codemode", "tool_search", "mcp__theirs__x"]) expect((await run(tool, { path: "inside.md" })).r).toEqual({ block: true, reason: `${tool} isn't available to the Candle agent` })
  })

  test("without its research folder the extension throws as it loads, which stops Pi", () => {
    const before = process.env.CANDLE_HARNESS_RESEARCH_DIR
    try {
      delete process.env.CANDLE_HARNESS_RESEARCH_DIR
      expect(() => candleGate({ on() {}, registerTool() {} })).toThrow("needs CANDLE_HARNESS_RESEARCH_DIR")
      process.env.CANDLE_HARNESS_RESEARCH_DIR = join(w.root, "gone")
      expect(() => candleGate({ on() {}, registerTool() {} })).toThrow()
    } finally {
      process.env.CANDLE_HARNESS_RESEARCH_DIR = before
    }
  })

  test("it uses node's built-ins only, since Pi loads it from a folder with no packages", () => {
    const imports = [...readFileSync(join(import.meta.dir, "pi-gate.ts"), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const i of imports) expect(i).toStartWith("node:")
  })
})

// --- web_fetch ---

describe("web_fetch", () => {
  test("public pages only: loopback, private, link-local, shared, multicast and local names are refused, and so is any scheme but http(s)", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(privateAddress(ip)).toBe(true) // scrub-ok: private and reserved ranges
    for (const ip of ["1.1.1.1", "93.184.216.34", "2606:4700::1111"]) expect(privateAddress(ip)).toBe(false) // scrub-ok: public addresses
    for (const url of ["http://127.0.0.1:8080/", "http://[::1]/", "http://localhost:3000/", "http://host.docker.internal/", "http://printer.local/", "file:///etc/passwd", "ftp://example.com/"]) {
      expect(await refuseUrl(new URL(url), {})).toBeString()
    }
    expect(await refuseUrl(new URL("https://1.1.1.1/"), {})).toBeUndefined() // scrub-ok: a public address
  })

  test("an IPv6 address carrying a private IPv4 one is refused in every spelling, and so is a redirect to one", async () => {
    // Loopback, link-local and private addresses written as IPv6, each refused.
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:127.0.0.1", "::7f00:1", "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::", "2002:c0a8:101::1", "0:0:0:0:0:0:0:1", "fec0::1", "fe80::1%eth0"]) expect([ip, privateAddress(ip)]).toEqual([ip, true])
    // Public IPv4 addresses written as IPv6, each allowed.
    for (const ip of ["::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) expect([ip, privateAddress(ip)]).toEqual([ip, false])
    for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:7f00:1]:11434/", "http://[64:ff9b::a9fe:a9fe]/", "http://[::7f00:1]/"]) { // scrub-ok: the cloud metadata address, refused
      expect([url, await refuseUrl(new URL(url), {})]).toEqual([url, expect.stringContaining("public pages only")])
    }
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect("http://[::ffff:169.254.169.254]/latest/meta-data/", 302) }) // scrub-ok: the cloud metadata address, refused
    const local = async (u: URL): Promise<Checked> => (u.hostname === "127.0.0.1" ? { address: "127.0.0.1" } : checkUrl(u, {}))
    try {
      await expect(fetchText(`http://127.0.0.1:${server.port}/`, { check: local })).rejects.toThrow("public pages only")
    } finally {
      server.stop(true)
    }
  })

  test("a page's text: scripts and styles out, blocks on their own lines, entities decoded", () => {
    expect(pageText("<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>MOON &amp; co</h1><p>Up&nbsp;38%</p><div>a&#39;b &#x41;</div></body></html>")).toBe("MOON & co\nUp 38%\na'b A")
  })

  test("it follows a redirect only to an address that passes, and caps what it returns", async () => {
    let port = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/go") return Response.redirect(`http://127.0.0.1:${port}/page`, 302)
        if (path === "/away") return Response.redirect("http://10.0.0.1/admin", 302) // scrub-ok: a private address, refused
        if (path === "/big") return new Response("x".repeat(MAX_CHARS + 10), { headers: { "content-type": "text/plain" } })
        if (path === "/bin") return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/octet-stream" } })
        return new Response("<p>hello</p>", { headers: { "content-type": "text/html" } })
      },
    })
    port = server.port!
    const local = async (u: URL): Promise<Checked> => (u.hostname === "127.0.0.1" ? { address: "127.0.0.1" } : checkUrl(u, {}))
    try {
      expect(await fetchText(`http://127.0.0.1:${port}/go`, { check: local })).toBe("hello")
      expect(fetchText(`http://127.0.0.1:${port}/away`, { check: local })).rejects.toThrow("public pages only")
      expect(await fetchText(`http://127.0.0.1:${port}/big`, { check: local })).toEndWith(`[cut at ${MAX_CHARS} characters]`)
      expect(fetchText(`http://127.0.0.1:${port}/bin`, { check: local })).rejects.toThrow("isn't a text page")
      expect(fetchText(`http://127.0.0.1:${port}/`)).rejects.toThrow("public pages only")
      expect(fetchText("not a url")).rejects.toThrow("isn't a URL")
    } finally {
      server.stop(true)
    }
  })

  test("it connects to the address it checked, with the name as Host: a second lookup can't move it (DNS rebinding)", async () => {
    const hosts: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        hosts.push(req.headers.get("host") ?? "")
        return new Response("pinned", { headers: { "content-type": "text/plain" } })
      },
    })
    // The name can't be looked up at all here: the page arriving shows the connection used the checked address.
    let checks = 0
    const pinned = async (): Promise<Checked> => (checks++, { address: "127.0.0.1" })
    try {
      expect(await fetchText(`http://page.invalid:${server.port}/x`, { check: pinned })).toBe("pinned")
      expect(hosts).toEqual([`page.invalid:${server.port}`])
      expect(checks).toBe(1)
    } finally {
      server.stop(true)
    }
    // A public address gives itself, proxy variables or not.
    expect(await checkUrl(new URL("https://1.1.1.1/"), {})).toEqual({ address: "1.1.1.1" }) // scrub-ok: a public address
    expect(await checkUrl(new URL("https://1.1.1.1/"), { HTTPS_PROXY: "http://proxy.test:3128" })).toEqual({ address: "1.1.1.1" }) // scrub-ok: a public address
  })

  test("with proxy variables set, a name looked up here is still pinned to its checked address; only a name that can't be looked up goes to the proxy", async () => {
    const proxy = { HTTPS_PROXY: "http://proxy.test:3128", http_proxy: "http://proxy.test:3128" }
    const answers = (address: string) => async () => [{ address }]
    const fails = async (): Promise<{ address: string }[]> => {
      throw new Error("ENOTFOUND")
    }
    for (const env of [{}, proxy]) {
      expect(await checkUrl(new URL("https://page.test/"), env, answers("93.184.216.34"))).toEqual({ address: "93.184.216.34" }) // scrub-ok: a public address
      expect(await checkUrl(new URL("http://page.test/"), env, answers("10.0.0.1"))).toEqual({ why: expect.stringContaining("public pages only") }) // scrub-ok: a private address, refused
    }
    // A name with no answer here: refused with no proxy, handed to the proxy with one.
    expect(await checkUrl(new URL("https://page.test/"), {}, fails)).toEqual({ why: expect.stringContaining("couldn't be found") })
    expect(await checkUrl(new URL("https://page.test/"), proxy, fails)).toEqual({})
    expect(await checkUrl(new URL("https://page.test/"), proxy, async () => [])).toEqual({})
  })
})

// --- Whole turns on the fake ---

test("a turn: Pi in the research folder with a private agent folder, our gate written and loaded, the prompt on stdin, offline, and nothing left behind", async () => {
  const w = world()
  const fake = fakePi({ call: { tool: "read", input: { path: "../../state/keys/momentum.key" } } })
  const events = await drain(piEngine(fake.bin, { homesDir: w.homesDir, local: [] }).start(w.turn()))
  expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("Pi answered on fake/fake-1") }) // the recording's model, not the one picked
  const run = fake.runs().find((r) => r.argv.includes("--mode"))!
  const gateFile = join(w.workDir, "candle-gate.ts")
  expect(run.argv).toEqual(piArgs({ bin: "x", gateFile, model: "openrouter/~anthropic/claude-haiku-latest", systemPrompt: "You are momentum, a trading agent." }).slice(1))
  expect(run.argv.join(" ")).not.toContain("the transcript and the message")
  expect(run.stdin).toBe("the transcript and the message")
  expect(run.cwd).toBe(w.researchDir)
  expect(run.env).toMatchObject({ HOME: w.home, PI_CODING_AGENT_DIR: join(w.workDir, "pi"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", CANDLE_HARNESS_RESEARCH_DIR: w.researchDir, CANDLE_HARNESS_TURN: "t_test1" })
  expect(Object.keys(run.agentDir!).sort()).toEqual(["auth.json", "mcp.json", "models-store.json", "models.json", "settings.json"])
  expect(run.agentDir!["auth.json"]).toEqual({ link: join(w.userDir, "auth.json") })
  // The gate written into the turn's folder is the gate's own source, carried as text, and Pi loaded it.
  expect(readFileSync(gateFile, "utf8")).toBe(readFileSync(join(import.meta.dir, "pi-gate.ts"), "utf8"))
  expect(run.tools).toEqual(["web_fetch"])
  expect(run.gate).toEqual({ block: true, reason: "../../state/keys/momentum.key is outside your research folder" })
  expect(alive(run.env.PID)).toBe(false)
})

test("the recorded turn on the model it ran on ends done, with Candle's tool and the reply", async () => {
  const w = world()
  const events = await drain(piEngine(fakePi().bin, { homesDir: w.homesDir, local: [] }).start(w.turn({ model: "fake/fake-1" })))
  expect(events.some((e) => e.type === "tool_result" && e.source === "candle")).toBe(true)
  expect(events.at(-1)).toMatchObject({ type: "done", text: expect.stringContaining("MoonFake") })
})

test("no model picked and no default, or one that isn't provider/model, ends the turn with words and starts nothing", async () => {
  const w = world()
  const fake = fakePi()
  const e = piEngine(fake.bin, { homesDir: w.homesDir, local: [] })
  expect((await drain(e.start(w.turn({ model: undefined }))))[0]).toMatchObject({ message: "Pi has no model picked, and no default of yours to run. Pick one with ctrl-g." })
  expect((await drain(e.start(w.turn({ model: "gpt-5" }))))[0]).toMatchObject({ message: expect.stringContaining('"gpt-5" isn\'t one') })
  expect(fake.runs()).toEqual([])
})

test("the models read: in a private folder like a turn's, offline, asking only about providers that can be a subscription, then removed", async () => {
  const w = world()
  const models = ["provider  model", "anthropic  claude-x", "openrouter  ~anthropic/claude-haiku-latest", "openrouter  deepseek/v4", "mine  m1"].join("\n")
  const fake = fakePi({ models, kinds: { anthropic: "oauth" } })
  const e = piEngine(fake.bin, { homesDir: w.homesDir, local: [] })
  const listed = await e.models(w.env)
  expect(listed.map((m) => m.id)).toEqual(["openrouter/~anthropic/claude-haiku-latest", "openrouter/deepseek/v4", "mine/m1"])
  expect(e.defaultModel!()).toBe("openrouter/~anthropic/claude-haiku-latest") // the user's own Pi default
  expect(e.modelNotes!()).toEqual(["Your Claude sign-in in Pi isn't offered here: subscriptions run through their own harness. Pick Claude Code for it."])
  const runs = fake.runs()
  expect(runs.map((r) => r.argv.join(" "))).toEqual(["--list-models", "auth check --provider anthropic --json --no-refresh"])
  for (const r of runs) {
    expect(r.env.PI_CODING_AGENT_DIR).toStartWith(join(w.homesDir, "models-pi-"))
    expect(r.env.PI_OFFLINE).toBe("1")
    expect(r.agentDir!["auth.json"]).toEqual({ link: join(w.userDir, "auth.json") })
  }
  expect(readdirSync(w.homesDir)).toEqual(["t_test1"])
  // A held-back subscription is refused in a turn too, for a model typed rather than picked.
  expect(await drain(e.start(w.turn({ model: "anthropic/claude-x" })))).toEqual([{ type: "error", message: expect.stringContaining("Pick Claude Code for it") }])
  expect(fake.runs().some((r) => r.argv.includes("--mode"))).toBe(false)
})

test("a local server found running is in the list and in the turn's models.json copy, never the user's", async () => {
  const w = world()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [{ id: "llama3.3" }] }) })
  try {
    const fake = fakePi({ models: "provider model\nollama llama3.3\n" })
    const e = piEngine(fake.bin, { homesDir: w.homesDir, local: [{ id: "ollama", name: "Ollama", baseUrl: `http://127.0.0.1:${server.port}/v1` }] })
    expect(await e.models(w.env)).toEqual([{ id: "ollama/llama3.3", label: "ollama/llama3.3", isDefault: true }])
    await drain(e.start(w.turn({ model: "ollama/llama3.3" })))
    const turn = fake.runs().find((r) => r.argv.includes("--mode"))!
    expect(Object.keys(JSON.parse((turn.agentDir!["models.json"] as { text: string }).text).providers).sort()).toEqual(["mine", "ollama"])
    expect(Object.keys(JSON.parse(readFileSync(join(w.userDir, "models.json"), "utf8")).providers)).toEqual(["mine"])
  } finally {
    server.stop(true)
  }
})

test("missing: one error saying Pi isn't installed", async () => {
  const w = world()
  const events = await drain(piEngine(join(w.root, "no-such-pi"), { homesDir: w.homesDir }).start(w.turn()))
  expect(events).toEqual([{ type: "error", message: expect.stringContaining("Pi isn't installed") }])
})

test("dying mid-turn: what came before arrives, then one error and no done", async () => {
  const w = world()
  const events = await drain(piEngine(fakePi({ fixture: "pi-cancel", after: "die" }).bin, { homesDir: w.homesDir, local: [] }).start(w.turn({ model: "fake/fake-1" })))
  expect(events.some((e) => e.type === "text")).toBe(true)
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("Pi ended without finishing the turn") })
})

test("cancel ends the turn at once, and Pi with it", async () => {
  const w = world()
  const fake = fakePi({ fixture: "pi-cancel", after: "hang", delayMs: 5 })
  const turn = piEngine(fake.bin, { homesDir: w.homesDir, local: [] }).start(w.turn({ model: "fake/fake-1" }))
  const events: EngineEvent[] = []
  const drained = (async () => {
    for await (const e of turn.events) events.push(e)
  })()
  while (!events.some((e) => e.type === "text")) await Bun.sleep(10)
  const t0 = performance.now()
  await turn.cancel()
  await drained
  expect(performance.now() - t0).toBeLessThan(2_000)
  expect(events.at(-1)).toMatchObject({ type: "error", message: "Pi turn cancelled" })
  expect(alive(fake.runs().find((r) => r.argv.includes("--mode"))!.env.PID)).toBe(false)
})

test("the version check: the minimum passes, older says how to update, and missing says how to install", async () => {
  const w = world()
  expect(await piEngine(fakePi().bin, { homesDir: w.homesDir }).check(w.env)).toEqual({ ok: true, version: MIN_PI })
  expect(await piEngine(fakePi({ version: "1.3.9" }).bin, { homesDir: w.homesDir }).check(w.env)).toMatchObject({ ok: false, version: "1.3.9", message: expect.stringContaining("npm install -g @earendil-works/pi-coding-agent") })
  expect(await piEngine(join(w.root, "nope"), { homesDir: w.homesDir }).check(w.env)).toMatchObject({ ok: false, message: expect.stringContaining("Pi isn't installed") })
})

// --- Through a core ---

describe("Pi through a core", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  afterAll(cleanupHomes)

  async function piCore(fake: ReturnType<typeof fakePi>) {
    const c = await startTestCore({ shim: ["/opt/candle-harness"], engine: { processes: () => [], leftoverDelayMs: 10 } }, { config: { engine: { ...testEngine, pi: { path: fake.bin } } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["agent", "engine"] })
    await until(() => c.core.engine.lastCheck("pi")?.ok === true)
    const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").map((e) => e.data as Record<string, unknown>)
    return { c, view, ended }
  }

  test("an agent switched to Pi runs on the model picked, journalled with Pi's version, the shim its only server", async () => {
    const fake = fakePi({ models: "provider model\nfake fake-1\n" })
    const { c, view, ended } = await piCore(fake)
    expect((await view.request("engine.choose", { agent: "momentum", engine: "pi", model: "fake/fake-1" })).error).toBeUndefined()
    await view.request("agent.send", { text: "what's trending?" })
    await until(() => ended().length === 1, 10_000)
    expect(ended()[0]).toMatchObject({ outcome: "done", labelled: [{ address: MOON, source: "candle" }] })
    const run = fake.runs().find((r) => r.argv.includes("--mode"))!
    const mcp = JSON.parse((run.agentDir!["mcp.json"] as { text: string }).text)
    expect(Object.keys(mcp.mcpServers)).toEqual(["candle"])
    expect(mcp.mcpServers.candle.command).toBe("/opt/candle-harness")
    expect(mcp.mcpServers.candle.args).toContain("--token-file")
    expect(run.cwd).toBe(c.p.researchDir("momentum"))
    expect(run.stdin).toContain("what's trending?")
    const system = run.argv[run.argv.indexOf("--system-prompt") + 1]!
    expect(system).toContain("read and write notes there")
    expect(system).toContain("There's no web search here.")
    const started = c.core.journal.rows().find((r) => r.type === "agent.turn_started")!
    expect(started).toMatchObject({ engine: "pi", engineVersion: "1.4.0", model: "fake/fake-1" })
    await until(() => !c.core.engine.busy())
    expect(readdirSync(c.p.homesDir)).toEqual([])
  })

  test("engine.models carries the line for a subscription held back, and a turn typed onto it is refused", async () => {
    const fake = fakePi({ models: "provider model\nanthropic claude-x\nfake fake-1\n", kinds: { anthropic: "oauth" } })
    const { view, ended } = await piCore(fake)
    const listed = (await view.request("engine.models", { engine: "pi" })).result as { models: { id: string }[]; notes?: string[] }
    expect(listed.notes).toEqual(["Your Claude sign-in in Pi isn't offered here: subscriptions run through their own harness. Pick Claude Code for it."])
    expect(listed.models.map((m) => m.id)).toEqual(["fake/fake-1"])
    expect((await view.request("engine.choose", { agent: "momentum", engine: "pi", model: "anthropic/claude-x" })).error).toBeUndefined()
    await view.request("agent.send", { text: "what's trending?" })
    await until(() => ended().length === 1, 10_000)
    expect(String(ended()[0]!.reply)).toContain("Pick Claude Code for it")
    expect(fake.runs().some((r) => r.argv.includes("--mode"))).toBe(false)
  })
})

test("the private folder holds nothing that isn't there to run the turn", () => {
  const w = world()
  privateAgentDir({ userDir: w.userDir, dir: join(w.workDir, "bare") })
  expect(JSON.parse(readFileSync(join(w.workDir, "bare/mcp.json"), "utf8"))).toEqual({ autoEnableCodemode: false, mcpServers: {} })
  expect(existsSync(join(w.workDir, "bare/extensions"))).toBe(false)
})

test("the agent's tools: hidden research tools left out, bash offered when the shell is on, and the gate told both", () => {
  const tools = (t: Parameters<typeof piArgs>[0]["tools"]) => {
    const a = piArgs({ bin: "pi", gateFile: "/g", model: "m/x", systemPrompt: "S", ...(t ? { tools: t } : {}) })
    return a[a.indexOf("--tools") + 1]
  }
  expect(tools({ shell: ["ls"], deny: ["write"] })).toBe("read,ls,web_fetch,bash,mcp__candle__*")
  expect(tools({ shell: "everything", allow: ["candle_*"], deny: [] })).toBe("bash,mcp__candle__*")
  expect(piGateEnv()).toEqual({})
  expect(piGateEnv({ shell: ["ls", "git log"], deny: ["web_fetch"] })).toEqual({ CANDLE_GATE_SHELL: '["ls","git log"]', CANDLE_GATE_TOOLS: "read,write,edit,ls" })
  expect(piGateEnv({ shell: "everything", deny: [] })).toEqual({ CANDLE_GATE_SHELL: "everything" })
  expect(gateShell(undefined)).toBe("off")
  expect(gateShell("[]")).toBe("off")
  expect(gateShell("nonsense")).toBe("off")
  expect(gateShell('["ls"]')).toEqual(["ls"])
})

test("the gate with the shell on: a listed plain command runs, anything else is refused with why, and narrowed research tools are refused", async () => {
  const research = realpathSync(mkdtempSync(join(tmpdir(), "chrn-pigate-shell-")))
  const saved = { dir: process.env.CANDLE_HARNESS_RESEARCH_DIR, shell: process.env.CANDLE_GATE_SHELL, tools: process.env.CANDLE_GATE_TOOLS }
  const handlers: ((e: unknown) => Promise<unknown>)[] = []
  try {
    process.env.CANDLE_HARNESS_RESEARCH_DIR = research
    process.env.CANDLE_GATE_SHELL = '["ls"]'
    process.env.CANDLE_GATE_TOOLS = "read,ls"
    candleGate({ on: (_e: string, h: (e: unknown) => Promise<unknown>) => handlers.push(h), registerTool() {} })
  } finally {
    for (const [k, v] of [["CANDLE_HARNESS_RESEARCH_DIR", saved.dir], ["CANDLE_GATE_SHELL", saved.shell], ["CANDLE_GATE_TOOLS", saved.tools]] as const) if (v === undefined) delete process.env[k]
    else process.env[k] = v
    rmSync(research, { recursive: true, force: true })
  }
  const run = (toolName: string, input: Record<string, unknown> = {}) => handlers[0]!({ toolName, input })
  expect(await run("bash", { command: "ls -la" })).toBeUndefined()
  const why = "Your shell runs only ls, one plain command at a time: no ;, &&, |, redirects or $(…)"
  expect(await run("bash", { command: "rm -rf notes" })).toEqual({ block: true, reason: why })
  expect(await run("bash", { command: "ls; rm -rf notes" })).toEqual({ block: true, reason: why })
  expect(await run("bash", {})).toEqual({ block: true, reason: why })
  expect(await run("write", { path: "x.md" })).toEqual({ block: true, reason: "write isn't available to the Candle agent" })
  expect(await run("web_fetch", { url: "https://example.com" })).toEqual({ block: true, reason: "web_fetch isn't available to the Candle agent" })
  expect(await run("mcp__candle__get_trending")).toBeUndefined()
})
