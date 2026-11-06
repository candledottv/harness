// The docs' feature map (scripts/docs-map.json): every user-facing feature once, with the docs page that
// covers it and what it's reached by: keys, typed commands, settings, panes, tabs, the agent's tools, palette
// rows, the doctor's areas, candle-harness's own commands and Candle's CLI rows. mapProblems checks each of those
// against the code, so the map can't name what doesn't exist; and it checks the other way for every list the
// code holds whole (each key, pane, tab, tool, palette row, doctor area, command, kind of typed line, and setting
// in src/config-settings.ts), so a feature added to the code without a place in the docs fails too. The pages are checked against the map
// before they ship.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SETTINGS } from "../src/config-settings"
import { rowFor } from "../src/core/cli-table"
import { HACC_TOOLS } from "../src/core/hacc-tools"
import { HISTORY_TOOL_NAME } from "../src/core/history-tool"
import { LIMITS_TOOL_NAME } from "../src/core/limits-tool"
import { PNL_TOOL_NAME } from "../src/core/pnl-tool"
import { RESEARCH_TOOLS } from "../src/core/research-tools"
import { GROUP_WALLETS_TOOL, NAME_WALLETS_TOOL, SHOW_WALLETS_TOOL, VIEW_TOOL } from "../src/core/tool-face"
import { SKILL_TOOL_NAME } from "../src/engine/skills"
import { main } from "../src/main"
import { PANE_IDS } from "../src/shared/panes"
import { parseAliases } from "../src/view/aliases"
import { type Command, type CommandContext, parseCommand } from "../src/view/commands"
import { KEYMAP } from "../src/view/keymap"
import { DEFAULT_TABS } from "../src/view/layouts-file"

export const MAP_PATH = "scripts/docs-map.json"

export interface Feature {
  id: string
  name: string
  /** The page that covers it: a key of `pages`. */
  page: string
  /** What it does, in the guide's words: what the page must say. */
  what: string
  keys?: string[]
  /** Lines typed on the input line, each run as the Candle Harness reads it. */
  typed?: string[]
  /** Settings by their file and key, as src/config-settings.ts lists them: "config.toml mode", "layouts.toml tabs[].shown". */
  settings?: string[]
  panes?: string[]
  tabs?: string[]
  tools?: string[]
  palette?: string[]
  doctor?: string[]
  subcommands?: string[]
  cli?: string[]
}

export interface DocsMap {
  /** Each page by its path under the site's harness/ folder, to its title. */
  pages: Record<string, string>
  features: Feature[]
}

const ROOT = join(import.meta.dir, "..")

export const loadMap = (): DocsMap => JSON.parse(readFileSync(join(ROOT, MAP_PATH), "utf8")) as DocsMap

/** What the code holds, for the map to be checked against. */
export interface Sources {
  keys: readonly string[]
  panes: readonly string[]
  tabs: readonly string[]
  tools: readonly string[]
  /** The palette's rows that are always there by one id. */
  palette: readonly string[]
  doctor: readonly string[]
  subcommands: readonly string[]
  /** Every kind of command a typed line can be, less a refusal. */
  kinds: readonly string[]
  /** Every setting in config-settings.ts, as "<file> <key>". */
  settings: readonly string[]
}

/** Each kind a typed line parses to. A kind added to Command fails typecheck here until it's listed. */
export const KINDS: Record<Exclude<Command["kind"], "refused">, true> = {
  trade: true,
  mode: true,
  kill: true,
  resume: true,
  resolve: true,
  help: true,
  setAgent: true,
  pnlWindow: true,
  cli: true,
  name: true,
  group: true,
  forgetVault: true,
  agent: true,
  chain: true,
}

/** candle-harness's own commands, as its usage lists them: the first column, `(none), view` read as `view`. */
async function subcommands(): Promise<string[]> {
  let usage = ""
  await main(["help"], { out: (t) => (usage += t), err: () => {} })
  return usage
    .split("\n")
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim().split(/\s{2,}/)[0]!.replace(/^\(none\), /, "").replace(/ <\w+>$/, ""))
}

export async function sources(): Promise<Sources> {
  const text = (path: string) => readFileSync(join(ROOT, path), "utf8")
  const literals = (path: string, re: RegExp) => [...new Set([...text(path).matchAll(re)].map((m) => m[1]!))]
  return {
    keys: KEYMAP.map((k) => k.id),
    panes: PANE_IDS,
    tabs: DEFAULT_TABS.map((t) => t.name),
    tools: [
      "candle_cli",
      SHOW_WALLETS_TOOL.name,
      NAME_WALLETS_TOOL.name,
      GROUP_WALLETS_TOOL.name,
      VIEW_TOOL.name,
      ...RESEARCH_TOOLS.map((t) => t.name),
      HISTORY_TOOL_NAME,
      PNL_TOOL_NAME,
      LIMITS_TOOL_NAME,
      SKILL_TOOL_NAME,
      ...HACC_TOOLS.map((t) => t.name),
    ],
    palette: literals("src/view/palette-rows.ts", /\bid: "([a-z][\w:-]*)"/g),
    doctor: literals("src/setup/doctor.ts", /\barea: "([a-z]+)"/g),
    subcommands: await subcommands(),
    kinds: Object.keys(KINDS),
    settings: SETTINGS.map((s) => `${s.file} ${s.key}`),
  }
}

/** The context typed lines are read in: two agents, a token shown this session, paper mode, and one alias. */
export const TYPED_CONTEXT: CommandContext = {
  agents: ["agent-a", "agent-b"],
  activeAgent: "agent-a",
  knownTokens: new Map([["MOON", "MoonMint1111111111111111111111111111111111"]]),
  mode: "paper",
  aliases: parseAliases(`[aliases]\nb5 = "buy $5 of"\n`).map,
}

/**
 * Words that belong to how the Candle Harness was built, not to what it does: the build's stages, plans and tasks, its test passes
 * and review lists, the numbers of its decisions and of its requests to Candle, a person's name, its experiments, a
 * section of its design or a mockup, the names of a test account's wallets, and the paths of workfiles that never ship
 * with the repo. A research note such as `notes/moon.md` is the agent's, so the
 * paths are the workfiles' own shapes.
 */
export const BUILD_WORDS =
  /\b[Mm]ilestones?\b|\b[Pp]lan \d|\bDecisions? \d|[Bb]uilder's call|[Ss]witched on once|\bMatt\b|\b[Ss]essions? \d|\bR\d{1,2}\b|\bM\d[abc]?\b|\bTasks? [A-Z]?\d|\b[Ss]pikes?\b|\b[Aa]s built\b|\bdesign §|\b[BCEFHQST]\d{1,2}[ab]?'s\b|\bnotes\/(?:\d{4}-|mi[l]estones|sp[i]kes|candle-requests|build-progress|review-package)|\b(?:plans|specs)\/\d{4}-|\bbuild-env\/|design\/mockups|[Ss]econd pass\b|[Rr]eview [Ff]ocus|\bT-\d+\b|\b[Aa] tester's|\bv0\.\d+\.\d+ run|§\s?\d|\b[Tt]he mockup\b|[Pp]arity (?:map|rule)|[Hh]elper Claude|\bfirst TUI\b|candle-tui-dat[a]|tui-te[e]|tui-col[d]/

/** Each way the map and the code disagree; none, they agree. */
export function mapProblems(map: DocsMap, src: Sources): string[] {
  const problems: string[] = []
  const say = (f: Feature | undefined, text: string) => problems.push(f ? `${f.id}: ${text}` : text)

  // Each item of a kind is claimed by one feature at most, and for the lists the code holds whole, by one at least.
  const claims = (kind: string, items: (f: Feature) => readonly string[] | undefined, known: readonly string[] | undefined, whole: boolean) => {
    const owner = new Map<string, string>()
    for (const f of map.features) {
      for (const item of items(f) ?? []) {
        if (known && !known.includes(item)) say(f, `names ${kind} "${item}", and there's no such ${kind}`)
        const before = owner.get(item)
        if (before) say(f, `names ${kind} "${item}", which ${before} already names`)
        else owner.set(item, f.id)
      }
    }
    if (whole && known) for (const item of known) if (!owner.has(item)) say(undefined, `${kind} "${item}" is in no feature`)
  }

  const ids = new Set<string>()
  for (const f of map.features) {
    if (ids.has(f.id)) say(f, "is listed twice")
    ids.add(f.id)
    if (!(f.page in map.pages)) say(f, `names page "${f.page}", which isn't in pages`)
    if (!f.name?.trim() || !f.what?.trim()) say(f, "needs a name and what it does")
    for (const words of [f.name, f.what]) {
      const hit = BUILD_WORDS.exec(words ?? "")
      if (hit) say(f, `says "${hit[0]}", which belongs to how it was built, not what it does`)
    }
  }
  for (const page of Object.keys(map.pages)) {
    if (page.startsWith("reference/") || page === "glossary") continue
    if (!map.features.some((f) => f.page === page)) say(undefined, `page "${page}" covers no feature`)
  }

  claims("key", (f) => f.keys, src.keys, true)
  claims("pane", (f) => f.panes, src.panes, true)
  claims("tab", (f) => f.tabs, src.tabs, true)
  claims("tool", (f) => f.tools, src.tools, true)
  claims("palette row", (f) => f.palette, src.palette, true)
  claims("doctor area", (f) => f.doctor, src.doctor, true)
  claims("command", (f) => f.subcommands, src.subcommands, true)
  claims("typed line", (f) => f.typed, undefined, false)
  claims("CLI row", (f) => f.cli, undefined, false)
  claims("setting", (f) => f.settings, src.settings, true)

  for (const f of map.features) for (const path of f.cli ?? []) if (!rowFor(path)) say(f, `names CLI row "${path}", and Candle's CLI has no such command`)

  // Each typed line is run as the input line runs it: it must be a command (or, once, a message to the agent), never refused.
  const kinds = new Map<string, string>()
  for (const f of map.features) {
    for (const line of f.typed ?? []) {
      const command = parseCommand(line, TYPED_CONTEXT)
      if (!command) say(f, `typed "${line}" is an empty line`)
      else if (command.kind === "refused") say(f, `typed "${line}" is refused: ${command.message}`)
      else if (!kinds.has(command.kind)) kinds.set(command.kind, line)
    }
  }
  for (const kind of src.kinds) if (!kinds.has(kind)) say(undefined, `no typed line in the map is a ${kind} command`)

  return problems
}
