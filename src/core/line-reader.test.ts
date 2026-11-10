// A line read by the core means what it means to the view: every typed command's example and every
// typed line in the docs map, read both ways, and config.toml's aliases read again when the file changes.
import { afterAll, afterEach, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadMap, TYPED_CONTEXT } from "../../scripts/docs-map"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { parseCommand, TYPED_ROWS } from "../shared/commands"
import { AliasFile, LineReader } from "./line-reader"
import { TokenNames } from "./token-names"

const dir = mkdtempSync("/tmp/chrn-lines-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterAll(cleanupHomes)
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
let n = 0
const configFile = (text: string | undefined) => {
  const file = join(dir, `config-${++n}.toml`)
  if (text !== undefined) writeFileSync(file, text)
  return file
}

const MOON = "MoonMint1111111111111111111111111111111111"

/** The core as the docs' context has it: the same agents, mode and alias, and MOON from a card it published. */
function coreLike(mode: "paper" | "live") {
  const names = new TokenNames()
  names.learnFrom("cards", { display: { mintLabel: "MOON", mint: MOON } })
  return new LineReader({
    aliases: new AliasFile(configFile(`[agents.agent-a]\n\n[aliases]\nb5 = "buy $5 of"\n`)),
    names,
    agents: () => ["agent-a", "agent-b"],
    wallets: () => undefined,
    mode: () => mode,
  })
}

const lines = [...TYPED_ROWS.map((r) => r.example), ...loadMap().features.flatMap((f) => f.typed ?? [])]

for (const mode of ["paper", "live"] as const) {
  test(`every typed example and every typed line in the docs map reads the same in the core as in the view (${mode})`, () => {
    expect(lines.length).toBeGreaterThan(TYPED_ROWS.length)
    const core = coreLike(mode)
    const view = { ...TYPED_CONTEXT, knownTokens: new Map([["MOON", MOON]]), mode }
    for (const line of lines) expect({ line, command: core.read(line, "agent-a") }).toEqual({ line, command: parseCommand(line, view) })
  })
}

test("lines the view refuses or sends to the agent are refused or sent the same way", () => {
  const core = coreLike("live")
  const view = { ...TYPED_CONTEXT, knownTokens: new Map([["MOON", MOON]]), mode: "live" as const }
  for (const line of ["sell 100% ORE", "buy $1 of nothing", "b5 MOON; sell 100% of MOON", "b5 MOON; what now?", "buy $2.505 MOON", "what's moving?", "sell 50% of MOON as agent-c"]) {
    expect({ line, command: core.read(line, "agent-a") }).toEqual({ line, command: parseCommand(line, view) })
  }
})

test("a name the core has read for two tokens is refused, naming both", () => {
  const moon = "MoonFake11111111111111111111111111111111111"
  const copy = "MoonCopy11111111111111111111111111111111111"
  const names = new TokenNames()
  names.learn("MOON", moon)
  names.learn("MOON", copy)
  const core = new LineReader({ aliases: new AliasFile(configFile(undefined)), names, agents: () => ["agent-a"], wallets: () => undefined, mode: () => "live" })
  const command = core.read("sell 50% of MOON", "agent-a")
  expect(command).toEqual({ kind: "refused", message: `Not a trade yet: MOON is the name of 2 tokens: ${copy}, ${moon}. Name the one you mean by its mint.`, keepLine: true, ask: true })
  // Its mint still reads.
  expect(core.read(`sell 50% of ${moon}`, "agent-a")).toMatchObject({ kind: "trade", args: { mint: moon, side: "sell", percent: 50 } })
})

test("config.toml's aliases are read again when the file changes, with the view's rules and lines", () => {
  const file = configFile(`[aliases]\nb5 = "buy $5 of"\n`)
  const aliases = new AliasFile(file)
  const names = new TokenNames()
  names.learn("MOON", MOON)
  const core = new LineReader({ aliases, names, agents: () => ["agent-a"], wallets: () => undefined, mode: () => "live" })
  expect(core.read("b5 MOON", "agent-a")).toMatchObject({ kind: "trade", args: { mint: MOON, amountUsd: "5" } })
  expect(core.aliasProblems()).toEqual([])

  writeFileSync(file, `[aliases]\nb10 = "buy $10 of"\nbuy = "sell 100% of"\n`)
  expect(core.read("b10 MOON", "agent-a")).toMatchObject({ kind: "trade", args: { amountUsd: "10" } })
  expect(core.read("b5 MOON", "agent-a")).toMatchObject({ kind: "agent" })
  expect(core.aliasProblems()).toEqual(['config.toml line 3: alias "buy" is left out: buy is a command already, and an alias can\'t change what it does'])

  rmSync(file)
  expect(core.read("b10 MOON", "agent-a")).toMatchObject({ kind: "agent" })
  expect(core.aliasProblems()).toEqual([])
})

test("config.toml that isn't TOML leaves out every alias and says so", () => {
  const core = new LineReader({ aliases: new AliasFile(configFile("[aliases\n")), names: new TokenNames(), agents: () => ["agent-a"], wallets: () => undefined, mode: () => "live" })
  expect(core.aliasProblems()[0]).toStartWith("config.toml isn't valid TOML")
  expect(core.read("b5 MOON", "agent-a")).toMatchObject({ kind: "agent" })
})

test("a real core reads a line by the tokens it showed its view and the aliases in its own config.toml", async () => {
  const c = await startTestCore()
  cores.push(c)
  const agent = "momentum"
  expect(c.core.lines.read("sell 50% of MOON", agent)).toMatchObject({ kind: "refused" })
  const view = await c.view()
  await view.request("subscribe", { topics: ["portfolio"] })
  await until(() => c.core.lines.read("sell 50% of MOON", agent)?.kind === "trade")
  expect(c.core.lines.read("sell 50% of MOON", agent)).toMatchObject({ kind: "trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "sell", percent: 50 } })
  appendFileSync(c.p.configFile, `\n[aliases]\nsellhalf = "sell 50% of"\n`)
  expect(c.core.lines.read("sellhalf MOON", agent)).toMatchObject({ kind: "trade", args: { percent: 50 } })
})
