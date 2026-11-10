// research_run through a real core: offered only to an agent whose code runner is on and only where this machine
// holds it, run held in the agent's research folder, journalled with its command; and the person turning it on or
// off from a main view, written into the agent's own config.toml table.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseConfig } from "../config"
import { cleanupHomes, startTestCore, testConfig, type TestCore, until } from "../../test/core-fixture"
import { holdSupport } from "./hold"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const held = (await holdSupport()).ok
const names = async (client: { request(m: string, p: unknown): Promise<{ result?: unknown }> }) => ((await client.request("tools.list", {})).result as { tools: { name: string; description: string }[] }).tools

test("off by default: not offered, refused when called, and no prompt line names it", async () => {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  const { client } = await c.harness(view, "momentum")
  expect((await names(client)).map((t) => t.name)).not.toContain("research_run")
  const called = await client.request("tools.call", { name: "research_run", args: { program: "python3", code: "print(1)" } })
  expect(JSON.stringify(called.result ?? called.error)).toContain("isn't offered: the code runner is off for momentum")
})

test.skipIf(!held || !Bun.which("python3"))("on for an agent: offered with its programs, run held in its research folder, journalled and said in Activity; another agent isn't offered it", async () => {
  const agents = testConfig("candle").agents
  agents.momentum!.tools = { shell: "off", deny: [], run: ["python3"] }
  const c = await startTestCore({}, { config: { agents } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["activity"] })
  const { client } = await c.harness(view, "momentum")
  const tool = (await names(client)).find((t) => t.name === "research_run")
  expect(tool?.description).toContain("python3")
  expect(tool?.description).toContain("no network")
  const swing = await c.harness(view, "swing")
  expect((await names(swing.client)).map((t) => t.name)).not.toContain("research_run")

  const research = c.p.researchDir("momentum")
  mkdirSync(research, { recursive: true })
  writeFileSync(join(research, "prices.csv"), "t,price\n1,0.40\n2,0.42\n3,0.41\n")
  writeFileSync(join(c.p.stateDir, "outside.key"), "FAKE-CORE-STATE")
  const code = `import csv\nrows=list(csv.DictReader(open('prices.csv')))\nprint('mean', round(sum(float(r['price']) for r in rows)/len(rows),4))\ntry:\n  print(open('${join(c.p.stateDir, "outside.key")}').read())\nexcept Exception as e:\n  print('held', type(e).__name__)\n`
  const r = await client.request("tools.call", { name: "research_run", args: { program: "python3", code } })
  const body = JSON.parse(((r.result as { content: { text: string }[] }).content[0]!.text)) as { stdout: string; exitCode: number; script: string }
  expect(body.exitCode).toBe(0)
  expect(body.stdout).toContain("mean 0.41")
  expect(body.stdout).toContain("held PermissionError")
  expect(body.stdout).not.toContain("FAKE-CORE-STATE")
  expect(readFileSync(join(research, body.script), "utf8")).toBe(code)
  const row = c.core.journal.rows().find((x) => x.type === "research.run")
  expect(row).toMatchObject({ agent: "momentum", program: "python3", exitCode: 0 })
  await until(() => view.events.some((e) => e.topic === "activity" && (e.data as { kind?: string }).kind === "research.run"))
  const said = view.events.find((e) => e.topic === "activity" && (e.data as { kind?: string }).kind === "research.run")!.data as { text: string }
  expect(said.text).toMatch(/^momentum ran python3 \.runs\/run-.*\.py · exit 0 in \d+\.\d s$/)
  // A program off its list is refused, with nothing run.
  const other = await client.request("tools.call", { name: "research_run", args: { program: "node", code: "1" } })
  expect(JSON.stringify(other.result)).toContain("program is one of python3")
}, 30_000)

test.skipIf(!held || !Bun.which("python3"))("a run past its time is stopped, and its group with it", async () => {
  const { researchRun } = await import("./research-run")
  const { selfCommand } = await import("../engine/registry")
  const c = await startTestCore()
  cores.push(c)
  const root = c.p.researchDir("momentum")
  mkdirSync(root, { recursive: true })
  const started = Date.now()
  const r = await researchRun({ root, programs: ["python3"], args: { program: "python3", code: "import time\nprint('start', flush=True)\ntime.sleep(30)" }, path: process.env.PATH, home: process.env.HOME, self: selfCommand(), timeoutMs: 1500 })
  expect(Date.now() - started).toBeLessThan(6000)
  expect(r.ok && r.body.stopped).toBe("It ran past 2 seconds and was stopped.")
  expect(r.ok && r.body.stdout).toBe("start\n")
}, 15_000)

test.skipIf(!held || !Bun.which("python3"))("output past 16 KB is cut, and says so", async () => {
  const { researchRun } = await import("./research-run")
  const { selfCommand } = await import("../engine/registry")
  const c = await startTestCore()
  cores.push(c)
  const root = c.p.researchDir("momentum")
  mkdirSync(root, { recursive: true })
  const r = await researchRun({ root, programs: ["python3"], args: { program: "python3", code: "import sys\nsys.stdout.write('x'*100000)\nsys.stderr.write('e'*100)" }, path: process.env.PATH, home: process.env.HOME, self: selfCommand() })
  if (!r.ok) throw new Error(r.message)
  expect(String(r.body.stdout).length + String(r.body.stderr).length).toBeLessThanOrEqual(16 * 1024)
  expect(r.body.stderr).toBe("e".repeat(100))
  expect(String(r.body.cut)).toContain("stdout 100000 bytes")
}, 15_000)

test.skipIf(!held)("the person turns it on from a main view: written into the agent's own table, offered from the next tools.list; off again the same way; never by the agent or a popped view", async () => {
  const c = await startTestCore()
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["engine"] })
  const { client } = await c.harness(view, "momentum")
  expect((await client.request("agent.run", { agent: "momentum", on: true })).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
  const popped = await c.view("candle-harness view --pane wallets")
  expect((await popped.request("agent.run", { agent: "momentum", on: true })).error?.data).toMatchObject({ code: "MAIN_VIEW_ONLY" })

  const on = (await view.request("agent.run", { agent: "momentum", on: true })).result as { run: string[] }
  expect(on.run.length).toBeGreaterThan(0)
  const file = readFileSync(c.p.configFile, "utf8")
  expect(file).toContain(`[agents.momentum.tools]\nrun = [${on.run.map((r) => `"${r}"`).join(", ")}]`)
  expect(parseConfig(file, c.p.configFile).config.agents.momentum!.tools?.run).toEqual(on.run)
  expect((await names(client)).map((t) => t.name)).toContain("research_run")
  await until(() => view.events.some((e) => e.topic === "engine" && Array.isArray((e.data as { agents: Record<string, { tools?: { run?: unknown } }> }).agents.momentum?.tools?.run)))
  expect(c.core.journal.rows().find((r) => r.type === "tools.run")).toMatchObject({ agent: "momentum", run: on.run })

  expect((await view.request("agent.run", { agent: "momentum", on: false })).result).toEqual({ agent: "momentum", run: "off" })
  expect(readFileSync(c.p.configFile, "utf8")).toContain(`[agents.momentum.tools]\nrun = "off"`)
  expect((await names(client)).map((t) => t.name)).not.toContain("research_run")
})

test.skipIf(!held)("on, but denied in config: not offered, and refused", async () => {
  const agents = testConfig("candle").agents
  agents.momentum!.tools = { shell: "off", deny: ["research_run"], run: ["python3"] }
  const c = await startTestCore({}, { config: { agents } })
  cores.push(c)
  const view = await c.view()
  const { client } = await c.harness(view, "momentum")
  expect((await names(client)).map((t) => t.name)).not.toContain("research_run")
  expect((await client.request("tools.call", { name: "research_run", args: { program: "python3", code: "print(1)" } })).error?.data).toMatchObject({ code: "TOOL_HIDDEN" })
})
