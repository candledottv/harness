// The engine seam: what the runner needs from any harness, and Claude Code behind it
// with no change in what it runs.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeArgs, claudeEngine, claudeVersion, MIN_CLAUDE_CODE } from "./claude"
import { cmuxStandIn, ENGINE_IDS, engineRegistry, isEngineId, readVersion } from "./engine"
import { sourceOf } from "./events"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function fakeBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chrn-engine-"))
  dirs.push(dir)
  const bin = join(dir, "harness")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const env = { PATH: "/usr/bin:/bin" }

test("the five engines have ids, and anything else isn't one", () => {
  expect([...ENGINE_IDS]).toEqual(["claude-code", "codex", "grok", "opencode", "pi"])
  expect(isEngineId("pi")).toBe(true)
  expect(isEngineId("crush")).toBe(false)
  expect(isEngineId(7)).toBe(false)
})

test("the registry finds an engine by id, and refuses two with one id", () => {
  const claude = claudeEngine("claude")
  const reg = engineRegistry([claude])
  expect(reg.get("claude-code")).toBe(claude)
  expect(reg.get("codex")).toBeUndefined()
  expect(() => engineRegistry([claude, claudeEngine("other")])).toThrow(/twice/)
})

test("Claude Code behind the seam: its id, label, minimum and what it can do", () => {
  const e = claudeEngine("claude")
  expect(e).toMatchObject({ id: "claude-code", label: "Claude Code", minVersion: MIN_CLAUDE_CODE })
  expect(e.capabilities()).toEqual({ webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true })
})

test("Claude Code's models are its aliases: it has no list command", async () => {
  const models = await claudeEngine("claude").models(env)
  expect(models.map((m) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku"])
  expect(models.every((m) => m.label.length > 0)).toBe(true)
})

test("the version check, through the seam: the minimum passes, older says update, missing says install", async () => {
  expect(await claudeEngine(fakeBin(`echo '${MIN_CLAUDE_CODE} (Claude Code)'`)).check(env)).toEqual({ ok: true, version: MIN_CLAUDE_CODE })
  const old = await claudeEngine(fakeBin("echo '2.1.309 (Claude Code)'")).check(env)
  expect(old).toMatchObject({ ok: false, version: "2.1.309", message: expect.stringContaining("Update Claude Code") })
  expect(await claudeEngine(join(tmpdir(), "no-such-claude-here")).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("isn't installed") })
  expect(await claudeEngine(fakeBin("echo nonsense")).check(env)).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't read") })
})

test("readVersion runs `--version` without blocking, and says when the binary is missing", async () => {
  expect(await readVersion(fakeBin("echo 0.165.0"), [], env)).toEqual({ out: "0.165.0\n" })
  expect(await readVersion(join(tmpdir(), "no-such-binary"), [], env)).toEqual({ missing: true, out: "" })
})

test("a version that couldn't be read says what the harness said on stderr", async () => {
  const bin = fakeBin('echo "dyld: Library not loaded: libssl.3.dylib" >&2; echo "  next line" >&2; exit 1')
  expect(await readVersion(bin, [], env)).toEqual({ out: "", said: "dyld: Library not loaded: libssl.3.dylib" })
  expect(await claudeEngine(bin).check(env)).toMatchObject({ ok: false, message: `Couldn't read Claude Code's version from "${bin} --version": it said "dyld: Library not loaded: libssl.3.dylib".` })
})

// A fresh macOS user's cmux terminal has cmux's own `claude`, `codex` and `pi` on its PATH (and
// `grok` in cmux.app), which fail with no harness behind them. The doctor said "Couldn't read Codex's version".
test("cmux's stand-in for a harness that isn't installed is missing; one in front of a real harness isn't", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-engine-"))
  dirs.push(dir)
  const shims = join(dir, ".cmuxterm/cmux-cli-shims/EA8F467B")
  mkdirSync(shims, { recursive: true })
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(shims, name), `#!/bin/sh\necho "${name}: not found on PATH" >&2\nexit 127\n`)
    chmodSync(join(shims, name), 0o755)
  }
  const shimEnv = { PATH: `${shims}:/usr/bin:/bin` }
  expect(cmuxStandIn("codex", shimEnv)).toBe(true)
  expect(cmuxStandIn(join(shims, "codex"), env)).toBe(true)
  expect(cmuxStandIn("/Applications/cmux.app/Contents/Resources/bin/grok", env)).toBe(true)
  expect(cmuxStandIn("sh", shimEnv)).toBe(false)
  expect(await readVersion("codex", [], shimEnv)).toMatchObject({ missing: true })
  expect(claudeVersion("claude", shimEnv)).toMatchObject({ ok: false, message: expect.stringContaining("isn't installed") })
  expect(await claudeEngine("claude").check(shimEnv)).toMatchObject({ ok: false, message: expect.stringContaining("isn't installed") })
  // The stand-in handing on to a real Claude Code: its version is read as ever.
  writeFileSync(join(shims, "claude"), `#!/bin/sh\necho '${MIN_CLAUDE_CODE} (Claude Code)'\n`)
  expect(claudeVersion("claude", shimEnv)).toEqual({ ok: true, version: MIN_CLAUDE_CODE })
  // A broken harness anywhere else still says so.
  expect(claudeVersion(fakeBin("exit 1"), env)).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't read") })
})

test("a turn that ended without a reply is explained in the engine's own words", () => {
  const e = claudeEngine("claude")
  expect(e.explain("claude: Not logged in · Please run /login")).toContain("Claude Code isn't signed in")
  expect(e.explain(undefined)).toBe("Claude Code ended without a reply.")
  expect(e.explain("claude: something else")).toBe("claude: something else")
})

test("the model goes by --model, and no model leaves Claude Code's arguments as they were", () => {
  const base = { bin: "claude", systemPrompt: "p", researchDir: "/r", mcpConfig: "/c.json" }
  const plain = claudeArgs(base)
  expect(plain).not.toContain("--model")
  expect(claudeArgs({ ...base, model: "sonnet" })).toEqual([...plain, "--model", "sonnet"])
})

test("the core's own tools are labelled file for the address gate, and Candle's candle, on every engine's naming", () => {
  for (const name of ["mcp__candle__research_read", "candle_research_list", "mcp__candle__research_list"]) expect(sourceOf(name)).toBe("file")
  // The core's other tools answer from the Candle Harness's own state, past turns and skill files, never Candle's data.
  for (const tool of ["harness_history", "skill_read", "skill_search", "harness_view", "harness_limits", "harness_pnl", "harness_show_wallets", "harness_name_wallets", "harness_group_wallets"]) {
    for (const name of [`mcp__candle__${tool}`, `candle_${tool}`, `candle__${tool}`, `candle.${tool}`, `candle/${tool}`, tool]) expect([name, sourceOf(name)]).toEqual([name, "file"])
  }
  for (const name of ["candle_get_market", "candle_candle_get_market", "candle.candle_get_feed"]) expect([name, sourceOf(name)]).toEqual([name, "candle"])
  expect(sourceOf("mcp__candle__candle_get_market")).toBe("candle")
  // Hacc's reads, by every engine's naming (they were once labelled "from candle"; Pi's bare name fell to "file").
  for (const name of ["mcp__candle__hacc_token", "hacc_signals", "candle__hacc_lab"]) expect(sourceOf(name)).toBe("hacc")
})
