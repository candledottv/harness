// recordAgentRun: the code runner's line in the agent's own [agents.<name>.tools] table, and nothing else in the file.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseConfig } from "../config"
import { paths } from "../paths"
import { recordAgentRun } from "./key-add"

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})
const home = (text: string) => {
  const h = mkdtempSync("/tmp/chrn-run-")
  homes.push(h)
  const p = paths({ CANDLE_HARNESS_HOME: h })
  writeFileSync(p.configFile, text)
  return p
}
const LIMITS = (a: string) => `[agents.${a}.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`

test("no tools table: one is added after the agent's own tables, before the next agent's", async () => {
  const p = home(`mode = "paper"\n${LIMITS("agent-a")}\n${LIMITS("agent-b")}`)
  expect(await recordAgentRun(p, "agent-a", ["python3", "bun"])).toEqual({ ok: true, wrote: true })
  expect(readFileSync(p.configFile, "utf8")).toBe(`mode = "paper"\n${LIMITS("agent-a")}\n[agents.agent-a.tools]\nrun = ["python3", "bun"]\n\n${LIMITS("agent-b")}`)
})

test("a tools table: its run line set, a list over several lines replaced whole, its other settings kept", async () => {
  const p = home(`${LIMITS("agent-a")}[agents.agent-a.tools]\nshell = ["ls"]\nrun = [\n  "python3",\n  "node",\n]\ndeny = ["candle_launch*"]\n`)
  expect(await recordAgentRun(p, "agent-a", "off")).toEqual({ ok: true, wrote: true })
  const text = readFileSync(p.configFile, "utf8")
  expect(text).toBe(`${LIMITS("agent-a")}[agents.agent-a.tools]\nshell = ["ls"]\nrun = "off"\ndeny = ["candle_launch*"]\n`)
  expect(parseConfig(text, p.configFile).config.agents["agent-a"]!.tools).toEqual({ shell: ["ls"], deny: ["candle_launch*"] })
  expect(await recordAgentRun(p, "agent-a", "off")).toEqual({ ok: true, wrote: false })
})

test("an agent with no table, or a name that can't be one, writes nothing", async () => {
  const p = home(LIMITS("agent-a"))
  expect(await recordAgentRun(p, "agent-z", ["python3"])).toEqual({ ok: false, why: "config.toml has no table for agent-z" })
  expect(readFileSync(p.configFile, "utf8")).toBe(LIMITS("agent-a"))
})

test("config reads run: off, a list, or a problem named by its line", () => {
  const read = (line: string) => parseConfig(`${LIMITS("a")}[agents.a.tools]\n${line}\n`, join("/x", "config.toml"))
  expect(read(`run = ["python3", "/opt/py/bin/python3"]`).config.agents.a!.tools?.run).toEqual(["python3", "/opt/py/bin/python3"])
  expect(read(`run = "off"`).config.agents.a!.tools?.run).toBeUndefined()
  expect(() => read(`run = ["python3; rm -rf ~"]`)).toThrow(`agents.a.tools.run: "python3; rm -rf ~" isn't a program`)
  expect(() => read(`run = []`)).toThrow(`agents.a.tools.run is an empty list`)
  expect(() => read(`run = "everything"`)).toThrow(`agents.a.tools.run is "everything"`)
})
