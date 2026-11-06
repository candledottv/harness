// OpenCode's read gate. OpenCode's `external_directory: deny`
// checks a tool's path as written, so a symlink inside the research folder that points out was read
// through (a read check leaked a planted key twice that way). This plugin resolves every path a tool
// names, symlinks and `~` included, and refuses any that ends outside the research folder, passing each
// on as the real path it checked (relative ones made the research folder's). It also
// refuses every tool not on the research set, as Pi's gate does: OpenCode runs anything it offers.
// The shell: `bash` is refused unless CANDLE_GATE_SHELL turns it on, as
// "everything" or a JSON list of commands; with a list, only a single plain command whose words start
// with an entry's runs (the same rule as tools.ts's and Pi's gate), behind OpenCode's own permission rules.
// It runs in the research folder unless the call names another. CANDLE_GATE_TOOLS, when set, narrows the
// research set to those it names (the agent's allow and deny lists).
//
// It's written into the turn's own folder from the binary (opencode.ts imports it as text) and named in
// our config's `plugin`, so it's never read from the user's folders. It must stay dependency-free:
// OpenCode's own runtime loads it. As it loads it writes CANDLE_GATE_MARKER, and the engine won't send
// the prompt until that file is there, so a gate that didn't load fails the turn closed.
//
// OpenCode calls every function this module exports as a plugin, so CandleGate is its only export; the
// tests reach the rest through it.
import { existsSync, lstatSync, readlinkSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

/** The research set: OpenCode's file tools, web fetch and its to-do list (opencode.ts's OPENCODE_TOOLS). Candle's tools are `candle_*`. */
const GATE_TOOLS = ["read", "write", "edit", "multiedit", "apply_patch", "patch", "list", "glob", "grep", "webfetch", "todowrite", "todoread", "invalid"]

/** The arguments OpenCode's tools name a path by. */
const PATH_ARGS = ["filePath", "path", "file", "directory", "dir"]
/** The arguments that are globs, relative to the tool's folder: held by their shape, since a glob can't be resolved. */
const GLOB_ARGS = ["pattern", "include"]

/** How many links a path may go through, as the kernel allows, before it's refused. */
const MAX_LINKS = 40

/** Where a link points, or undefined for anything that isn't a link. */
function linkTarget(p: string): string | undefined {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : undefined
  } catch {
    return undefined
  }
}

/**
 * The real path, following every link; for a path that doesn't exist yet, its nearest existing parent's.
 * A link whose target is missing is followed to what it names, since a write through it lands there.
 */
function real(p: string, links = 0): string {
  let at = p
  const rest: string[] = []
  while (!existsSync(at)) {
    const target = linkTarget(at)
    if (target !== undefined) {
      if (links >= MAX_LINKS) throw new Error(`${p} goes through too many links`)
      return real(join(resolve(dirname(at), target), ...rest), links + 1)
    }
    rest.unshift(at.slice(dirname(at).length + 1))
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return join(realpathSync(at), ...rest)
}

/** An apply_patch's text with each file it adds, updates, deletes or moves to passed through `to`. */
function mapPatch(patch: string, to: (path: string) => string): string {
  return patch
    .split("\n")
    .map((line) => {
      const m = /^(\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*)(.+?)\s*$/.exec(line)
      return m ? `${m[1]}${to(m[2]!)}` : line
    })
    .join("\n")
}

/** Characters that join, redirect or substitute commands: a listed command must have none (tools.ts). */
const SHELL_OPERATORS = /[;&|<>`$(){}\n\r\\]/

/** Whether `command` may run: everything, or a single plain command whose words start with a listed entry's. Kept the same as tools.ts's by opencode.test.ts. */
function shellAllows(s: "off" | "everything" | readonly string[], command: string): boolean {
  if (s === "everything") return true
  if (s === "off" || typeof command !== "string") return false
  if (SHELL_OPERATORS.test(command)) return false
  const words = command.trim().split(/[ \t]+/)
  if (words[0] === "") return false
  return s.some((entry) => {
    const want = entry.split(" ")
    return want.length <= words.length && want.every((w, i) => words[i] === w)
  })
}

/** CANDLE_GATE_SHELL: unset or "off", "everything", or a JSON list of commands; anything else is off. */
function gateShell(raw: string | undefined): "off" | "everything" | string[] {
  if (raw === "everything") return "everything"
  try {
    const list = JSON.parse(raw ?? "")
    if (Array.isArray(list) && list.length && list.every((e) => typeof e === "string")) return list
  } catch {
    // Off.
  }
  return "off"
}

/** The tools that search a folder, which is OpenCode's working folder (not the research folder) when none is named. */
const SEARCHES = ["glob", "grep", "list"]

function gate(research: string, home: string | undefined, shell: "off" | "everything" | string[], offered: string[] | undefined) {
  const root = realpathSync(research)
  const inside = (p: string) => p === root || p.startsWith(root + sep)
  const refuse = (tool: string, what: string): never => {
    throw new Error(`${tool}: ${what} is outside your research folder`)
  }
  // OpenCode's working folder is the turn's own empty config folder (opencode.ts), so a relative path is
  // made the research folder's here. Each path goes on as its real one, the one checked.
  const held = (tool: string, v: string): string => {
    const expanded = v === "~" || v.startsWith("~/") ? join(home ?? "/nonexistent", v.slice(1)) : v
    const abs = real(isAbsolute(expanded) ? expanded : resolve(root, expanded))
    return inside(abs) ? abs : refuse(tool, v)
  }
  return async (input: { tool: string }, output: { args?: Record<string, unknown> }) => {
    const tool = input.tool
    const args = (output.args ??= {})
    if (tool === "bash" && shell !== "off") {
      if (!shellAllows(shell, args.command as string)) throw new Error(`Your shell runs only ${(shell as string[]).join(", ")}, one plain command at a time: no ;, &&, |, redirects or $(…)`)
      args.workdir = typeof args.workdir === "string" && args.workdir !== "" ? held(tool, args.workdir) : root
      return
    }
    if (!tool.startsWith("candle_") && (!GATE_TOOLS.includes(tool) || (offered && !offered.includes(tool)))) throw new Error(`${tool} isn't available to a Candle agent`)
    for (const key of PATH_ARGS) {
      const v = args[key]
      if (typeof v === "string" && v !== "") args[key] = held(tool, v)
    }
    if (SEARCHES.includes(tool) && (typeof args.path !== "string" || args.path === "")) args.path = root
    if (typeof args.patchText === "string") args.patchText = mapPatch(args.patchText, (p) => held(tool, p))
    // A glob reaches no further than its folder unless it climbs or starts elsewhere; a link inside the
    // folder is a path (checked above when named, and refused when read).
    for (const key of GLOB_ARGS) {
      const v = args[key]
      if (tool === "grep" && key === "pattern") continue // a regex, not a path
      if (typeof v === "string" && (isAbsolute(v) || v.startsWith("~") || v.split(/[\\/]/).includes(".."))) refuse(tool, v)
    }
  }
}

export const CandleGate = async () => {
  const offered = process.env.CANDLE_GATE_TOOLS === undefined ? undefined : process.env.CANDLE_GATE_TOOLS.split(",")
  const before = gate(process.env.CANDLE_HARNESS_RESEARCH_DIR ?? "/nonexistent", process.env.HOME, gateShell(process.env.CANDLE_GATE_SHELL), offered)
  if (process.env.CANDLE_GATE_MARKER) writeFileSync(process.env.CANDLE_GATE_MARKER, "loaded\n")
  return { "tool.execute.before": before }
}
