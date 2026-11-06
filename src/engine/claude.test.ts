// Claude Code's adapter: the recorded fixtures' checks, the prompt on stdin, the turn's MCP config file, the
// research folder as the working folder, and the version check.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAUDE_TOOLS, claudeArgs, claudeParser, claudeVersion, MIN_CLAUDE_CODE, mcpConfigFor, startClaude } from "./claude"
import type { EngineEvent, Turn } from "./events"
import { checkAddresses, type SeenValue, seenFrom } from "./gate"
import { runLines } from "./spawn"

const MOON = "MoonFake11111111111111111111111111111111111"
const fixture = (name: string) => join(import.meta.dir, "../../test/fixtures/engine", `${name}.jsonl`)
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "chcl-"))
  dirs.push(dir)
  return dir
}

function parse(name: string): EngineEvent[] {
  const parser = claudeParser()
  return readFileSync(fixture(name), "utf8").split("\n").filter(Boolean).flatMap((l) => parser(l))
}

async function drain(turn: Turn): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of turn.events) out.push(e)
  return out
}

/** A folder holding one fake executable, `claude`, that runs `script` (sh). */
function fakeClaude(script: string): string {
  const dir = tempDir()
  writeFileSync(join(dir, "claude"), `#!/bin/sh\n${script}\n`)
  chmodSync(join(dir, "claude"), 0o755)
  return join(dir, "claude")
}

const turn = (over: Partial<Parameters<typeof startClaude>[0]> = {}) => ({
  bin: "claude",
  prompt: "hello",
  systemPrompt: "You are a test.",
  researchDir: "/home/you/.config/candle/harness/research/momentum",
  mcpConfig: "/home/you/.config/candle/harness/state/turns/t_1.json",
  env: { PATH: "/usr/bin:/bin" },
  ...over,
})

test("the recorded turn: a Candle tool call, its result labelled candle, and one done", () => {
  const events = parse("claude")
  const call = events.find((e) => e.type === "tool_call" && e.name.endsWith("get_trending")) as { id: string } | undefined
  expect(call).toBeDefined()
  const result = events.find((e) => e.type === "tool_result" && e.id === call!.id)
  expect(result).toMatchObject({ source: "candle" })
  expect(events.filter((e) => e.type === "done")).toHaveLength(1)
  expect(events.at(-1)!.type).toBe("done")
})

test("the recorded reply passes the address gate, its mint labelled candle", () => {
  const events = parse("claude")
  const seen: SeenValue[] = events.flatMap((e) => (e.type === "tool_result" ? seenFrom(e.output, e.source) : []))
  const done = events.find((e) => e.type === "done") as { text: string }
  expect(checkAddresses(done.text, seen).labelled).toContainEqual({ address: MOON, source: "candle" })
})

test("a garbage line yields nothing and doesn't throw", () => {
  const p = claudeParser()
  for (const junk of ["", "not json", "{", "[1,2]", "null", '{"type":42}', '{"type":"assistant","message":null}']) expect(p(junk)).toEqual([])
})

test("signed out: one error saying so, and no done", () => {
  const events = parse("claude-signedout")
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect((events.find((e) => e.type === "error") as { message: string }).message).toMatch(/Not logged in/)
  expect(events.some((e) => e.type === "done")).toBe(false)
})

test("missing from PATH: one error saying it isn't installed", async () => {
  const events = await drain(startClaude(turn({ bin: "claude-not-here", researchDir: tmpdir() })))
  expect(events).toEqual([{ type: "error", message: expect.stringContaining("Claude Code isn't installed") }])
})

test("dying mid-turn: what came before arrives, then one error and no done", async () => {
  const bin = fakeClaude(`cat '${fixture("claude-cancel")}'; kill -9 $$`)
  const events = await drain(runLines("Claude Code", [bin], { cwd: tmpdir(), parse: claudeParser(), env: { PATH: "/usr/bin:/bin" } }))
  expect(events.filter((e) => e.type === "error")).toHaveLength(1)
  expect(events.at(-1)!.type).toBe("error")
  expect(events.some((e) => e.type === "tool_result")).toBe(true)
})

test("the arguments: isolated, research tools only, the turn's config file, and no prompt or token", () => {
  const args = claudeArgs(turn())
  expect(args[0]).toBe("claude")
  for (const flag of ["-p", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(args).toContain(flag)
  expect(args[args.indexOf("--mcp-config") + 1]).toBe("/home/you/.config/candle/harness/state/turns/t_1.json")
  expect(args[args.indexOf("--tools") + 1]).toBe(CLAUDE_TOOLS.join(","))
  expect(args[args.indexOf("--tools") + 1]).not.toMatch(/Bash/)
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
  expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are a test.")
  // Writes and edits only in the research folder.
  expect(args).toContain("Write(//home/you/.config/candle/harness/research/momentum/**)")
  expect(args).toContain("Edit(//home/you/.config/candle/harness/research/momentum/**)")
  expect(args.filter((a) => a.startsWith("Write(") || a.startsWith("Edit("))).toHaveLength(2)
  expect(args).not.toContain("hello")
  expect(args.join(" ")).not.toContain("cht_")
})

test("the prompt goes on stdin, and the working folder is the research folder", async () => {
  const dir = tempDir()
  const seen = join(dir, "seen")
  const bin = fakeClaude(`cat > '${seen}'; echo >> '${seen}'; pwd >> '${seen}'; echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`)
  const events = await drain(startClaude(turn({ bin, researchDir: dir, prompt: "the person's message" })))
  expect(events).toEqual([{ type: "done", text: "ok" }])
  const [stdin, cwd] = readFileSync(seen, "utf8").split("\n")
  expect(stdin).toBe("the person's message")
  expect(cwd).toBe(dir)
})

test("the turn's MCP config runs only the shim, with the token file and this core's folder, never the token", () => {
  const config = JSON.parse(mcpConfigFor(["/opt/candle-harness"], "/c/state/turns/t_1.token", "/c"))
  expect(config).toEqual({
    mcpServers: { candle: { command: "/opt/candle-harness", args: ["mcp", "--token-file", "/c/state/turns/t_1.token"], env: { CANDLE_HARNESS_HOME: "/c" } } },
  })
  expect(JSON.parse(mcpConfigFor(["/usr/bin/bun", "/src/main.ts"], "/t", "/c")).mcpServers.candle.args).toEqual(["/src/main.ts", "mcp", "--token-file", "/t"])
})

test("the version check: the minimum passes, older is refused with why, and missing says install", () => {
  const env = { PATH: "/usr/bin:/bin" }
  expect(claudeVersion(fakeClaude(`echo '${MIN_CLAUDE_CODE} (Claude Code)'`), env)).toEqual({ ok: true, version: MIN_CLAUDE_CODE })
  expect(claudeVersion(fakeClaude(`echo '2.2.0 (Claude Code)'`), env)).toEqual({ ok: true, version: "2.2.0" })
  const old = claudeVersion(fakeClaude(`echo '2.1.309 (Claude Code)'`), env)
  expect(old).toMatchObject({ ok: false, version: "2.1.309" })
  expect((old as { message: string }).message).toContain("Update Claude Code")
  expect((old as { message: string }).message).toContain("--restricted")
  expect(claudeVersion(join(tempDir(), "absent"), env)).toMatchObject({ ok: false, message: expect.stringContaining("isn't installed") })
  expect(claudeVersion(fakeClaude("echo nonsense"), env)).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't read") })
})

test("the agent's tools: hidden ones left out, and the shell as Bash for everything or Bash(<entry>:*) per list entry", () => {
  const args = (tools: Parameters<typeof claudeArgs>[0]["tools"]) => {
    const a = claudeArgs(turn({ tools }))
    const allowed: string[] = []
    for (let i = a.indexOf("--allowedTools") + 1; i < a.length && !a[i]!.startsWith("--"); i++) allowed.push(a[i]!)
    return { tools: a[a.indexOf("--tools") + 1], allowed }
  }
  expect(args({ shell: ["ls", "git log"], deny: [] })).toEqual({
    tools: "WebSearch,WebFetch,Read,Write,Edit,Bash",
    allowed: ["mcp__candle", "WebSearch", "WebFetch", "Read", "Write(//home/you/.config/candle/harness/research/momentum/**)", "Edit(//home/you/.config/candle/harness/research/momentum/**)", "Bash(ls:*)", "Bash(git log:*)"],
  })
  expect(args({ shell: "everything", deny: ["web_search", "write"] })).toEqual({ tools: "WebFetch,Read,Bash", allowed: ["mcp__candle", "WebFetch", "Read", "Bash"] })
  expect(args({ shell: "off", allow: ["candle_*"], deny: [] })).toEqual({ tools: "", allowed: ["mcp__candle"] })
})
