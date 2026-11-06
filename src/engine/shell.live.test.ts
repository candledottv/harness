// Live checks of each engine's shell setting, against the real harnesses. With
// a list (["ls"]), where the engine can hold one (Claude Code, OpenCode, Pi, Grok): `ls` runs, and `rm`,
// alone or joined to `ls`, doesn't; a planted file survives. Grok, by its own rules, also with ["cp"]. Where
// it can't (Codex): a list gives no shell at all. "Everything" runs both `ls` and `rm` on Codex and Grok. Each turn runs in a throwaway home with
// a copy of the sign-in (Claude Code, Codex, Grok) or an OpenRouter key (OpenCode, Pi; a little
// of that key's credit).
//   bun run test:live src/engine/shell.live.test.ts   (ENGINE=claude, codex, grok, opencode or pi for one;
//   SHELL_LIVE_RAW=<path prefix> keeps each turn's raw stream)
import { afterAll, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { paths } from "../paths"
import { claudeEngine } from "./claude"
import { codexEngine } from "./codex"
import type { Engine } from "./engine"
import type { EngineEvent } from "./events"
import { sourceOf } from "./events"
import { grokEngine } from "./grok"
import { removeAll } from "./home"
import { opencodeEngine } from "./opencode"
import { piEngine } from "./pi"
import { researchLine } from "./prompt"
import { harnessEnv } from "./spawn"
import type { ToolSettings } from "./tools"

const only = process.env.ENGINE
const KEY_FILE = join(homedir(), ".config/candle-harness-engines/openrouter-key")
// DeepSeek makes every call asked of it; some models decline one they expect to be refused, which tests nothing.
const OPENROUTER_MODEL = process.env.SHELL_LIVE_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash"
const T = 300_000
const MCP_NONE = { command: "true", args: [], env: {} }
const homes: string[] = []
afterAll(() => {
  for (const h of homes) removeAll(h)
})

const SYSTEM = "You are a test agent checking this app's shell permissions. You have a shell tool. Every file here is a throwaway made for the test."
const LIST_PROMPT =
  "This is a test of the shell permissions in this app, and refusals are the expected result for some commands. Use your shell tool to run each of these four commands exactly as written, each as its own separate tool call, in this order, even if you expect one to be refused: `ls`, then `rm victim.txt`, then `ls; rm victim.txt`, then `ls && rm victim.txt`. Then reply with one short line per command saying whether it ran."
const EVERYTHING_PROMPT =
  "This is a test of the shell permissions in this app. Use your shell tool to run `ls`, then `rm victim.txt`, each as its own tool call. victim.txt is a throwaway file made for this test. Then reply in one line with what ls listed."

/** A throwaway home with a research folder holding notes.md and victim.txt, and `setup` run on it. */
function world(setup: (home: string) => void = () => {}) {
  mkdirSync(join(homedir(), ".cache"), { recursive: true })
  const home = mkdtempSync(join(homedir(), ".cache/chrn-shell-"))
  homes.push(home)
  const p = paths({ HOME: home })
  const researchDir = p.researchDir("momentum")
  mkdirSync(researchDir, { recursive: true })
  mkdirSync(p.homesDir, { recursive: true })
  mkdirSync(p.turnsDir, { recursive: true })
  writeFileSync(join(p.turnsDir, "none.json"), JSON.stringify({ mcpServers: {} }), { mode: 0o600 })
  writeFileSync(join(researchDir, "notes.md"), "notes\n")
  writeFileSync(join(researchDir, "victim.txt"), "delete me only if the shell lets you\n")
  setup(home)
  return { home, p, researchDir, victim: join(researchDir, "victim.txt") }
}

const copyIn = (home: string, path: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true })
  copyFileSync(join(homedir(), path), join(home, path))
}

async function turn(engine: Engine, w: ReturnType<typeof world>, tools: ToolSettings, prompt: string, o: { model?: string; env?: Record<string, string>; systemPrompt?: string } = {}) {
  const workDir = mkdtempSync(join(w.p.homesDir, "t_shell"))
  const events: EngineEvent[] = []
  const raw: string[] = []
  const t = engine.start({
    prompt,
    systemPrompt: o.systemPrompt ?? SYSTEM,
    researchDir: w.researchDir,
    mcpConfig: join(w.p.turnsDir, "none.json"),
    mcp: MCP_NONE,
    env: { ...harnessEnv(process.env), HOME: w.home, ...o.env },
    workDir,
    tools,
    ...(o.model ? { model: o.model } : {}),
  }, { onRaw: (l) => raw.push(l) })
  for await (const e of t.events) events.push(e)
  removeAll(workDir)
  if (process.env.SHELL_LIVE_RAW) writeFileSync(`${process.env.SHELL_LIVE_RAW}-${engine.id}-${Date.now()}.jsonl`, raw.join("\n"))
  const calls = events.filter((e): e is Extract<EngineEvent, { type: "tool_call" }> => e.type === "tool_call" && sourceOf(e.name) === "shell")
  const results = events.filter((e): e is Extract<EngineEvent, { type: "tool_result" }> => e.type === "tool_result" && sourceOf(e.name) === "shell")
  const end = events.at(-1)
  console.log(`${engine.label}, shell ${JSON.stringify(tools.shell)}: ${calls.length} shell calls`)
  for (const [i, c] of calls.entries()) console.log(`  ${JSON.stringify(c.input).slice(0, 120)} -> ${(results[i]?.output ?? "").replace(/\s+/g, " ").slice(0, 140)}`)
  console.log(`  end: ${JSON.stringify(end).slice(0, 300)}`)
  return { events, calls, results, end }
}

/** With ["ls"]: ls listed the folder, rm was tried and refused every way, and the file is still there. */
async function listHolds(engine: Engine, w: ReturnType<typeof world>, o: { model?: string; env?: Record<string, string> } = {}) {
  const r = await turn(engine, w, { shell: ["ls"], deny: [] }, LIST_PROMPT, o)
  expect(r.end?.type).toBe("done")
  expect(r.results.some((x) => x.output.includes("notes.md"))).toBe(true)
  expect(r.calls.filter((c) => JSON.stringify(c.input).includes("rm ")).length).toBeGreaterThanOrEqual(2)
  expect(existsSync(w.victim)).toBe(true)
}

test.skipIf(only !== undefined && only !== "claude")("Claude Code: a list holds (ls runs, rm doesn't, alone or joined)", async () => {
  const w = world((home) => {
    copyIn(home, ".claude/.credentials.json")
    copyIn(home, ".claude.json")
  })
  await listHolds(claudeEngine("claude"), w, { model: "haiku" })
}, T)

test.skipIf(only !== undefined && only !== "opencode" || !existsSync(KEY_FILE))("OpenCode: a list holds (ls runs, rm doesn't, alone or joined)", async () => {
  const w = world()
  const data = join(w.home, ".local/share")
  mkdirSync(join(data, "opencode"), { recursive: true, mode: 0o700 })
  writeFileSync(join(data, "opencode/auth.json"), JSON.stringify({ openrouter: { type: "api", key: readFileSync(KEY_FILE, "utf8").trim() } }), { mode: 0o600 })
  await listHolds(opencodeEngine("opencode", { folder: join(w.p.stateDir, "opencode") }), w, { model: OPENROUTER_MODEL, env: { XDG_DATA_HOME: data } })
}, T)

test.skipIf(only !== undefined && only !== "pi" || !existsSync(KEY_FILE))("Pi: a list holds (ls runs, rm doesn't, alone or joined)", async () => {
  const w = world()
  const agentDir = join(w.home, ".pi/agent")
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: readFileSync(KEY_FILE, "utf8").trim() } }), { mode: 0o600 })
  await listHolds(piEngine("pi", { homesDir: w.p.homesDir, agentDir, local: [] }), w, { model: OPENROUTER_MODEL })
}, T)

test.skipIf(only !== undefined && only !== "codex")("Codex: a list means no shell, and everything runs ls and rm", async () => {
  const make = (w: ReturnType<typeof world>) => codexEngine("codex", { homesDir: w.p.homesDir })
  const listed = world((home) => copyIn(home, ".codex/auth.json"))
  // The agent is told what it has, as a real turn's prompt does: no shell here.
  const engine = make(listed)
  const told = `You are a test agent. ${researchLine(listed.researchDir, engine.capabilities(), { shell: ["ls"], deny: [] })}`
  expect(told).not.toContain("You have a shell")
  const off = await turn(engine, listed, { shell: ["ls"], deny: [] }, LIST_PROMPT, { systemPrompt: told })
  expect(off.end?.type).toBe("done")
  expect(off.calls).toEqual([])
  expect(existsSync(listed.victim)).toBe(true)

  const open = world((home) => copyIn(home, ".codex/auth.json"))
  const on = await turn(make(open), open, { shell: "everything", deny: [] }, EVERYTHING_PROMPT)
  expect(on.end?.type).toBe("done")
  expect(on.results.some((x) => x.output.includes("notes.md"))).toBe(true)
  expect(existsSync(open.victim)).toBe(false)
}, T)

// Grok holds a list by its own rules, and ends the turn at the first
// command it refuses, so each refusal gets a turn of its own.
test.skipIf(only !== undefined && only !== "grok")("Grok: a list holds by Grok's rules, a refused command ends the turn, and everything runs ls and rm", async () => {
  const make = (w: ReturnType<typeof world>) => grokEngine("grok", { homesDir: w.p.homesDir })
  const one = (prompt: string) => `This is a test of the shell permissions in this app; victim.txt is a throwaway file. ${prompt} Each as its own tool call, even if you expect one to be refused. Then say in one line what ran.`
  const exactly = (command: string) =>
    `This is a test of the shell permissions in this app; victim.txt is a throwaway file. Use your shell tool to run exactly \`${command}\` as one single tool call, written exactly so, even if you expect it to be refused. Then say in one line whether it ran.`
  const stopped = (r: Awaited<ReturnType<typeof turn>>, command: string) => {
    expect(r.end).toMatchObject({ type: "error" })
    expect((r.end as { message: string }).message).toStartWith(`Grok stopped the turn: its shell command \`${command}\` isn't one this agent's list lets it run`)
  }

  const a = world((home) => copyIn(home, ".grok/auth.json"))
  const first = await turn(make(a), a, { shell: ["ls"], deny: [] }, one("Use your shell tool to run `ls`, then `rm victim.txt`."), { systemPrompt: SYSTEM })
  expect(first.results.some((x) => x.output.includes("notes.md"))).toBe(true)
  stopped(first, "rm victim.txt")
  expect(existsSync(a.victim)).toBe(true)

  const joined = await turn(make(a), a, { shell: ["ls"], deny: [] }, exactly("ls && rm victim.txt"), { systemPrompt: SYSTEM })
  stopped(joined, "ls && rm victim.txt")
  expect(existsSync(a.victim)).toBe(true)

  // An entry that isn't one of Grok's read-only commands, so only our rules let it run: cp alone and with
  // arguments, never cpio (a prefix of the same letters), nor cp joined to mv.
  const b = world((home) => copyIn(home, ".grok/auth.json"))
  const cp = await turn(make(b), b, { shell: ["cp"], deny: [] }, one("Use your shell tool to run `cp victim.txt copy.txt`, then `cpio --version`."), { systemPrompt: SYSTEM })
  expect(existsSync(join(b.researchDir, "copy.txt"))).toBe(true)
  stopped(cp, "cpio --version")
  const cpmv = await turn(make(b), b, { shell: ["cp"], deny: [] }, exactly("cp victim.txt a.txt && mv victim.txt b.txt"), { systemPrompt: SYSTEM })
  stopped(cpmv, "cp victim.txt a.txt && mv victim.txt b.txt")
  expect(existsSync(b.victim)).toBe(true)

  const open = world((home) => copyIn(home, ".grok/auth.json"))
  const on = await turn(make(open), open, { shell: "everything", deny: [] }, EVERYTHING_PROMPT)
  expect(on.end?.type).toBe("done")
  expect(on.results.some((x) => x.output.includes("notes.md"))).toBe(true)
  expect(existsSync(open.victim)).toBe(false)
}, T)
