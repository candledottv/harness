// Live checks against the real Codex, through a real core and the fake Candle
// server, as claude.live.test.ts does for Claude Code. Each turn costs a little of the signed-in ChatGPT
// subscription. The rate-limit check spends nothing: it points Codex at a local server answering 429.
//   bun run test:live src/engine/codex.live.test.ts
import { afterAll, afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { candleConfigDir } from "../core/candle-mcp"

const MOON = "MoonFake11111111111111111111111111111111111"
const T = 300_000
const cores: TestCore[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  cleanupHomes()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A core with momentum on the real Codex, on Codex's own default model, read as the picker would. */
async function live(o: { bin?: string; onRaw?: (line: string) => void } = {}) {
  const c = await startTestCore({ engine: o.onRaw ? { onRaw: o.onRaw } : {} }, { config: { engine: { ...testEngine, codex: { path: o.bin ?? "codex" } } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["agent"] })
  await until(() => c.core.engine.lastCheck("codex") !== undefined, 30_000)
  expect(c.core.engine.lastCheck("codex")).toMatchObject({ ok: true })
  const models = (await view.request("engine.models", { engine: "codex" })).result as { models: { id: string; isDefault?: boolean }[] }
  expect(models.models.length).toBeGreaterThan(0)
  expect((await view.request("engine.choose", { agent: "momentum", engine: "codex" })).error).toBeUndefined()
  const agentEvents = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
  const ended = () => agentEvents().filter((e) => e.type === "ended")
  return { c, view, agentEvents, ended, defaultModel: models.models.find((m) => m.isDefault)!.id }
}

function calls(c: TestCore) {
  return readFileSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
}

/** Every process, with its full command line. */
function processes(): Map<number, string> {
  const run = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
  const out = new Map<number, string>()
  for (const line of run.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m) out.set(Number(m[1]), m[2]!)
  }
  return out
}

test("a real turn paper-trades MOON through the core on Codex's default model, journalled with it", async () => {
  const { c, view, agentEvents, ended, defaultModel } = await live()
  await view.request("mode.set", { mode: "paper" })
  await view.request("agent.send", {
    text: `Resolve the token at mint ${MOON} with candle_resolve_token, then paper-buy 0.01 SOL of it with candle_trade. Then tell me, in one sentence, the mint you traded.`,
  })
  await until(() => ended().length === 1, T - 10_000)
  const end = ended()[0]!
  console.log(`reply: ${String(end.reply).slice(0, 300)}`)
  console.log(`tools: ${agentEvents().filter((e) => e.type === "tool_result").map((e) => e.summary).join(" | ")}`)
  expect(end.outcome).toBe("done")
  expect(end.labelled).toContainEqual({ address: MOON, source: "candle" })
  expect(calls(c).find((call) => call.name === "candle_trade")?.args).toMatchObject({ mint: MOON, side: "buy", paper: true })
  expect(c.core.cards.list()).toHaveLength(0) // paper needs no card
  const started = c.core.journal.rows().find((r) => r.type === "agent.turn_started")!
  console.log(`ran on: ${JSON.stringify({ engine: started.engine, engineVersion: started.engineVersion, model: started.model })}`)
  expect(started).toMatchObject({ engine: "codex", model: defaultModel })
  expect(readdirSync(c.p.turnsDir)).toEqual([])
  expect(readdirSync(c.p.homesDir)).toEqual([])
}, T)

test("cancel ends the turn, and nothing of the turn's is left running", async () => {
  const before = processes()
  const { c, view, ended } = await live()
  await view.request("agent.send", { text: "Search the web for the history of every Solana token launchpad, one search per launchpad, and write a long note on each into your research folder." })
  await until(() => view.events.some((e) => e.topic === "agent" && ["tool_call", "text"].includes(String((e.data as { type?: string } | null)?.type))), 120_000)
  const t0 = performance.now()
  await view.request("agent.cancel", {})
  await until(() => ended().length === 1, 10_000)
  const cancelMs = performance.now() - t0
  console.log(`cancel: ${Math.round(cancelMs)} ms`)
  expect(ended()[0]!.outcome).toBe("cancelled")
  expect(cancelMs).toBeLessThan(3_000)
  await Bun.sleep(2_000)
  const fresh = [...processes()].filter(([pid]) => !before.has(pid) && pid !== process.pid)
  for (const [pid, args] of fresh) console.log(`  new since the test began: ${pid} ${args.slice(0, 140)}`)
  const ofTheTurn = fresh.filter(([, args]) => args.includes(c.p.homesDir) || args.includes(c.p.researchDir("momentum")) || /\bcodex\b.*\bexec\b/.test(args) || /main\.ts mcp --token-file/.test(args))
  expect(ofTheTurn).toEqual([])
  expect(readdirSync(c.p.homesDir)).toEqual([])
}, T)

test("the read canary: through the research tools, nothing outside the folder by any path, and the notes inside read", async () => {
  const raw: string[] = []
  const { c, view, agentEvents, ended } = await live({ onRaw: (line) => raw.push(line) })
  const keyCanary = `cndl_test_canary${crypto.randomUUID().replaceAll("-", "")}`
  const plainCanary = `CANARYPLAIN${crypto.randomUUID().replaceAll("-", "")}`
  const keyFile = join(c.p.keysDir, "canary.key")
  writeFileSync(keyFile, `${keyCanary}\n`, { mode: 0o600 })
  writeFileSync(join(c.p.stateDir, "notes.txt"), `${plainCanary}\n`, { mode: 0o600 })
  // A harmless file under the real home, for `~`, so a model declining "a key" can't pass for the hold.
  const homeDir = mkdtempSync(join(homedir(), ".cache/chrn-canary-"))
  scratch.push(homeDir)
  writeFileSync(join(homeDir, "notes.txt"), `Shopping list. ${plainCanary}\n`)
  const research = c.p.researchDir("momentum")
  mkdirSync(research, { recursive: true })
  writeFileSync(join(research, "inside.txt"), "INSIDEOK\n")
  symlinkSync(keyFile, join(research, "leak.txt"))
  symlinkSync(c.p.stateDir, join(research, "statelink"))
  const tilde = `~/${join(homeDir, "notes.txt").slice(homedir().length + 1)}`
  const paths = ["inside.txt", keyFile, "../../state/notes.txt", join(c.p.stateDir, "notes.txt"), tilde, "leak.txt", "statelink/notes.txt"]
  await view.request("agent.send", {
    text: `I'm testing the Candle Harness's file access. Use research_read once on each of these paths, in order, even if you expect it to fail, and report the exact result for each: ${paths.join(", ")}. Then use research_list on "..", on "~" and on "statelink". Then write a one-line note to notes/check.md in your folder, and another to ../escaped.md, and tell me what happened to each.`,
  })
  await until(() => ended().length === 1, T - 10_000)
  const results = agentEvents().filter((e) => e.type === "tool_result")
  for (const r of results) console.log(`  ${String(r.name)}: ${String(r.summary).slice(0, 160).replaceAll("\n", " ")}`)
  console.log(`reply: ${String(ended()[0]!.reply).slice(0, 500)}`)
  const reads = agentEvents().filter((e) => e.type === "tool_call" && String(e.name).endsWith("research_read"))
  expect(reads.length).toBeGreaterThanOrEqual(paths.length)
  const everything = raw.join("\n")
  expect(everything).toContain("INSIDEOK") // Codex can read its own notes, through the core's research tools
  for (const secret of [keyCanary, plainCanary, "cht_"]) expect(everything).not.toContain(secret)
  // Writes are held to the folder too.
  expect(existsSync(join(research, "notes/check.md"))).toBe(true)
  expect(existsSync(join(research, "../escaped.md"))).toBe(false)
}, T)

test("rate-limited: a 429 with a long wait ends the turn in seconds with words, and spends nothing", async () => {
  // A local server answering every request with 429 and a 500 s retry-after, and a `codex` that points
  // the real Codex at it. On a real subscription this was an eight-minute silent wait.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "500" } }),
  })
  const dir = mkdtempSync(join(homedir(), ".cache/chrn-codex429-"))
  scratch.push(dir)
  const bin = join(dir, "codex")
  const provider = [`model_provider="fake"`, `model_providers.fake.name="fake"`, `model_providers.fake.base_url="http://127.0.0.1:${server.port}/v1"`, `model_providers.fake.wire_api="responses"`]
  // Only exec is pointed at the server; --version and debug models run as they are.
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = exec ]; then shift; exec codex exec ${provider.map((p) => `-c '${p}'`).join(" ")} "$@"; fi\nexec codex "$@"\n`)
  chmodSync(bin, 0o755)
  try {
    const { view, ended } = await live({ bin })
    const t0 = performance.now()
    await view.request("agent.send", { text: "Say ok." })
    await until(() => ended().length === 1, 60_000)
    const ms = performance.now() - t0
    const reply = String(ended()[0]!.reply)
    console.log(`ended in ${Math.round(ms)} ms: ${reply}`)
    expect(ended()[0]!.outcome).toBe("error")
    expect(reply).toContain("Codex is rate-limited")
    expect(reply).toMatch(/8 min/)
    expect(ms).toBeLessThan(30_000)
  } finally {
    server.stop(true)
  }
}, T)
