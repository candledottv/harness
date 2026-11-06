// Shell access and tool permissions, set per agent in
// config's `[agents.<name>.tools]`:
//   - `shell`: "off" (the default), "everything", or a list of commands. A list entry is a command and,
//     optionally, its first arguments ("ls", "git log"); a command runs when its words start with an
//     entry's. Codex can't hold a list (its shell is all or off), so there a list means off; Grok holds
//     one by its own rules, which differ (docs.candle.tv/harness/engines);
//   - `allow` and `deny`: tool names, in the shape the Crush coding agent uses. Crush runs a tool not in its allowed list only
//     after asking; a headless turn has nobody to ask, so here a tool not allowed (when `allow` is set) is
//     hidden, as a denied one is. Neither can add a tool beyond the research set and Candle's: they only
//     narrow. A name is one of the research tools below or a tool Candle's server serves (`candle_trade`),
//     or the core's own (`harness_show_wallets`, Hacc's `hacc_signals` and the rest), and `*` matches any run
//     of characters (`candle_get_*`, `hacc_*`).
//
// What hides what: Candle's tools and the core's research_read and research_list are hidden by the core
// itself (tools.list and tools.call refuse them for that agent), whatever the engine; the engine's own
// research tools by each adapter's tool list.
//
// With the shell on, reads aren't held to the research folder on any engine, since a shell can read
// anything the user can, and cards and core-enforced limits don't cover what it runs. The picker, the
// doctor and the docs say so.
import type { EngineCapabilities } from "./engine"

/** The engine-neutral names of the research tools: each engine maps them onto its own. */
export const RESEARCH_NAMES = ["web_search", "web_fetch", "read", "write"] as const
export type ResearchName = (typeof RESEARCH_NAMES)[number]

export type ShellSetting = "off" | "everything" | readonly string[]

export interface ToolSettings {
  shell: ShellSetting
  /** When set, only these are offered. */
  allow?: readonly string[]
  deny: readonly string[]
}

export const DEFAULT_TOOLS: ToolSettings = { shell: "off", deny: [] }

/** A shell list entry: a command and its first arguments, plain words only. */
const ENTRY = /^[A-Za-z0-9_./+-]+( [A-Za-z0-9_./=:,@%+-]+)*$/
/** A tool name or pattern: a research name, or Candle's. */
const NAME = /^[a-z0-9_*]{1,64}$/

/** Why `entry` can't be a shell list entry, or undefined when it can. */
export function shellEntryFault(entry: unknown): string | undefined {
  if (typeof entry !== "string" || !ENTRY.test(entry)) return `${JSON.stringify(entry)} isn't a command: use a command and its first arguments, such as "ls" or "git log", with no quotes or shell operators`
  return undefined
}

/** 0.2's prefix for the core's own tools, now `harness_`: deprecated, accepted for 0.3.x, never listed. */
export const DEPRECATED_TOOL_PREFIX = "tui_"

/** A tool name, or an allow or deny pattern, in its 0.3 form: `tui_history` is `harness_history`. */
export function canonicalToolName<T>(name: T): T {
  return (typeof name === "string" && name.startsWith(DEPRECATED_TOOL_PREFIX) ? `harness_${name.slice(DEPRECATED_TOOL_PREFIX.length)}` : name) as T
}

/** Why `name` can't be an allow or deny entry, or undefined when it can. */
export function toolNameFault(name: unknown): string | undefined {
  if (name === "shell" || name === "bash") return `the shell is set by tools.shell ("off", "everything" or a list of commands), not by allow or deny`
  if (typeof name !== "string" || !NAME.test(name)) return `${JSON.stringify(name)} isn't a tool name: use ${RESEARCH_NAMES.join(", ")}, or one of Candle's tools such as candle_trade, with * for any characters`
  // Candle's, and the core's own: research_read, research_list, harness_show_wallets, Hacc's (hacc_signals…) and skill_read.
  if ((RESEARCH_NAMES as readonly string[]).includes(name) || name.startsWith("candle_") || name.startsWith("research_") || name.startsWith("harness_") || name.startsWith(DEPRECATED_TOOL_PREFIX) || name.startsWith("hacc_") || name.startsWith("skill_") || name === "*") return undefined
  // A pattern can match a research name: "web_*".
  if (name.includes("*") && RESEARCH_NAMES.some((r) => matches(name, r))) return undefined
  return `${JSON.stringify(name)} names no tool: use ${RESEARCH_NAMES.join(", ")}, or one of Candle's tools such as candle_trade, with * for any characters`
}

function matches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
  return re.test(name)
}

/**
 * Whether the agent is offered `name`: a research name, or a tool as the core serves it. The core's
 * research_read and research_list are reading notes, so they go with `read`.
 */
export function toolAllowed(t: ToolSettings, name: string): boolean {
  const own = canonicalToolName(name)
  const as = own === "research_read" || own === "research_list" ? ["read", own] : [own]
  // A 0.2 entry (`tui_*`, `tui_history`) still names the same tools.
  const fits = (p: string, n: string) => matches(canonicalToolName(p), n)
  if (t.allow && !as.some((n) => t.allow!.some((p) => fits(p, n)))) return false
  return !as.some((n) => t.deny.some((p) => fits(p, n)))
}

/** The shell a turn on an engine gets: a list where the engine can't hold one is off. */
export function shellFor(t: ToolSettings, caps: Pick<EngineCapabilities, "shellList">): ShellSetting {
  if (Array.isArray(t.shell) && !caps.shellList) return "off"
  return t.shell
}

export const shellOn = (s: ShellSetting): boolean => s !== "off"

/** Characters that join, redirect or substitute commands: a listed command must have none. */
const OPERATORS = /[;&|<>`$(){}\n\r\\]/

/**
 * Whether `command` may run under the shell setting: everything, or a single plain command whose words
 * start with a listed entry's. With a list, anything that could run a second command (`;`, `&&`, `|`,
 * `$(…)`, a backquote, a newline) or redirect is refused, and a quoted first word matches no entry: Pi's and OpenCode's gates hold
 * the list with this rule (each carries its own copy, since they load as single files; tools.test.ts
 * keeps the three the same).
 */
export function shellAllows(s: ShellSetting, command: string): boolean {
  if (s === "everything") return true
  if (s === "off" || typeof command !== "string") return false
  if (OPERATORS.test(command)) return false
  const words = command.trim().split(/[ \t]+/)
  if (words[0] === "") return false
  return s.some((entry) => {
    const want = entry.split(" ")
    return want.length <= words.length && want.every((w, i) => words[i] === w)
  })
}

/** What a turn can research with, after the agent's settings: what the prompt and the picker say. */
export interface ResearchCan {
  webSearch: boolean
  webFetch: boolean
  /** `own`: the engine's file tools; `core`: research_read and research_list; false: none. */
  read: "own" | "core" | false
  write: boolean
  shell: ShellSetting
}

export function researchCan(caps: Pick<EngineCapabilities, "webSearch" | "webFetch" | "files" | "shellList">, t: ToolSettings = DEFAULT_TOOLS): ResearchCan {
  const ok = (n: ResearchName) => toolAllowed(t, n)
  return {
    webSearch: caps.webSearch && ok("web_search"),
    webFetch: caps.webFetch && ok("web_fetch"),
    read: ok("read") ? (caps.files === "own" ? "own" : "core") : false,
    write: caps.files !== "none" && ok("write"),
    shell: shellFor(t, caps),
  }
}

/** The setting in words: "off", "everything", or "ls, cat". */
export const shellWords = (s: ShellSetting): string => (s === "off" || s === "everything" ? s : s.join(", "))

/** What the picker and the doctor say when the shell is on. */
export const SHELL_ON_NOTE = "reads aren't held to the research folder, and cards and limits don't cover what the shell runs"
