// The surface table keeps up with the code: a socket method, a core tool, an engine's tool or a place that
// starts a process, added without its row (or a row left for one that's gone), fails here.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HACC_TOOLS } from "../src/core/hacc-tools"
import { HISTORY_TOOL } from "../src/core/history-tool"
import { LIMITS_TOOL } from "../src/core/limits-tool"
import { PNL_TOOL } from "../src/core/pnl-tool"
import { RESEARCH_TOOLS } from "../src/core/research-tools"
import { METHOD_ROLES } from "../src/core/server"
import { TRIGGERS_TOOL } from "../src/core/triggers-tool"
import { BOTS_TOOL } from "../src/core/bots-tool"
import { BRIDGE_TOOL } from "../src/core/bridge"
import { GROUP_WALLETS_TOOL, NAME_WALLETS_TOOL, SHOW_WALLETS_TOOL, VIEW_TOOL } from "../src/core/tool-face"
import { CLAUDE_TOOLS } from "../src/engine/claude"
import { GROK_TOOLS } from "../src/engine/grok"
import { OPENCODE_TOOLS } from "../src/engine/opencode"
import { FILE_TOOLS, WEB_FETCH } from "../src/engine/pi-gate"
import { SKILL_TOOL_NAME } from "../src/engine/skills"
import { CORE_TOOLS, ENGINE_TOOLS, METHODS, SPAWN_CALL, SPAWNS } from "./audit-surface"
import { repoFiles } from "./repo-files"

const ROOT = join(import.meta.dir, "..")
const sorted = (xs: Iterable<string>) => [...xs].sort()
/** The app's own source, tests left out. */
const sourceFiles = () =>
  repoFiles("src").filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))

describe("the audit's surface table", () => {
  test("every socket method has a row, and every row a method", () => {
    expect(sorted(Object.keys(METHODS))).toEqual(sorted(Object.keys(METHOD_ROLES)))
  })

  test("every tool the core serves an agent besides Candle's has a row", () => {
    const served = [
      "candle_cli",
      BRIDGE_TOOL.name,
      SHOW_WALLETS_TOOL.name,
      NAME_WALLETS_TOOL.name,
      GROUP_WALLETS_TOOL.name,
      VIEW_TOOL.name,
      ...RESEARCH_TOOLS.map((t) => t.name),
      "research_run",
      HISTORY_TOOL.name,
      PNL_TOOL.name,
      LIMITS_TOOL.name,
      TRIGGERS_TOOL.name,
      BOTS_TOOL.name,
      SKILL_TOOL_NAME,
      ...HACC_TOOLS.map((t) => t.name),
    ]
    expect(sorted(Object.keys(CORE_TOOLS))).toEqual(sorted(served))
    // And the offer itself lists no source of tools the table doesn't know: a new one here needs a row above.
    const core = readFileSync(join(ROOT, "src/core/core-main.ts"), "utf8")
    const offer = core.slice(core.indexOf('s.handle("tools.list"'), core.indexOf('s.handle("tools.call"'))
    const sources = offer.slice(offer.indexOf("const all = ["), offer.indexOf("]\n      return")).split("\n").slice(1).map((l) => l.trim()).filter(Boolean)
    expect(sources).toEqual([
      "...withOwnPrefix(withReason(offeredTools(pool.for(call.agent).tools())), apiKeyPrefix(keys.get(call.agent) ?? \"\")),",
      "cliTool.definition(),",
      "BRIDGE_TOOL,",
      "SHOW_WALLETS_TOOL,",
      "NAME_WALLETS_TOOL,",
      "GROUP_WALLETS_TOOL,",
      "VIEW_TOOL,",
      "...RESEARCH_TOOLS,",
      "...[runPrograms(call.agent)].flatMap((p) => (p ? [runTool(p)] : [])),",
      "HISTORY_TOOL,",
      "PNL_TOOL,",
      "LIMITS_TOOL,",
      "...(triggers.gate(call.agent).state === \"ok\" ? [TRIGGERS_TOOL] : []),",
      "...(bots.gate(call.agent).state === \"ok\" ? [BOTS_TOOL] : []),",
      "...[skillTool(skillsOf(call.agent))].filter((t) => t !== undefined),",
      "...(haccOffered(call.agent) ? haccOffer(call.agent) : []),",
    ])
  })

  test("each engine's own tools are the table's", () => {
    expect(ENGINE_TOOLS).toEqual({ claude: CLAUDE_TOOLS, grok: GROK_TOOLS, opencode: OPENCODE_TOOLS, pi: [...FILE_TOOLS, WEB_FETCH] })
  })

  test("every place the app starts a process has a row, file by file", () => {
    const found: Record<string, number> = {}
    for (const file of sourceFiles()) {
      for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
        const code = line.trimStart()
        if (code.startsWith("//") || code.startsWith("*")) continue
        if (SPAWN_CALL.test(line)) found[file] = (found[file] ?? 0) + 1
      }
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(SPAWNS).map(([file, rows]) => [file, rows.length])))
  })
})
