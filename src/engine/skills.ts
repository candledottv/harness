// Skills: written guidance the agent reads through one core tool, `skill_read`, the same on all five
// engines and hideable by name. Each engine's own skill loader stays closed (the user's own harness setup
// stays out of the agent's turns), so skills reach an agent only this way. Two
// kinds:
//   - **Candle's**: ten of Candle's own (MIT), copied unchanged into skills/ from
//     candledottv/agentic at the commit skills/SOURCE names, and built into the binary. The Quant preset
//     carries them. Candle wrote them for an agent with the CLI and Candle's MCP server; where one tells
//     the agent to do something the Candle Harness does another way (install the CLI, a bracket order the Candle Harness doesn't
//     offer), its answer carries a Candle Harness note. A test refuses a bundled skill that names a CLI command, an
//     install or Candle's HTTP routes without one, so an update can't slip one in unread.
//   - **The Candle Harness's own**: harness-memory, how to keep the agent's memory, on every preset, since
//     memory isn't Quant's alone. Built into the binary from skills-harness/.
//   - **The person's own**: `<config>/skills/<name>/SKILL.md` and any text files beside it, in
//     Candle's format, on every preset. Read fresh each turn, so an edit shows on the next. One named like
//     one of Candle's or the Candle Harness's replaces it. The agent can't write there: its file tools are held to its research
//     folder, so it can't edit its own guidance. Also from the skill folders the person
//     turns on, such as Claude Code's `~/.claude/skills`, read by the core alone, the same way: the agent still
//     can't read those folders itself, and each harness's own loader stays closed.
// The prompt lists each skill an agent has by name and description; the agent reads one when its task
// matches. An agent with none isn't offered skill_read at all.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Preset } from "./preset"
import { SKILL_FILES } from "./skill-files"
import HARNESS_MEMORY from "../../skills-harness/harness-memory/SKILL.md" with { type: "text" }
import HARNESS_TRIGGERS from "../../skills-harness/harness-triggers/SKILL.md" with { type: "text" }
import HARNESS_BOTS from "../../skills-harness/harness-bots/SKILL.md" with { type: "text" }
import HARNESS_VIEW from "../../skills-harness/harness-view/SKILL.md" with { type: "text" }

export const SKILL_SOURCE = { repo: "candledottv/agentic", commit: "26daf47", licence: "MIT" } as const
/** What one skill_read answer may hold, as every core tool's answer (hacc-tools.ts's ANSWER_BUDGET). */
const ANSWER_BUDGET = 16 * 1024
/** The size of one file of the person's own; past it, the file is skipped and the doctor says why. */
export const OWN_FILE_MAX = 256 * 1024
const OWN_FILES_MAX = 50
/** A description longer than this is cut in the prompt's list (each turn pays for it); skill_read has it whole. */
const LIST_DESCRIPTION_MAX = 500
export const OWN_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface Skill {
  name: string
  origin: "candle" | "harness" | "own"
  /** For one of the person's own from a folder they turned on: that folder, as they'd write it. */
  from?: string
  /** The frontmatter's description, without Candle's leading tag ("[RISK CONTROL]"). */
  description: string
  /** Its files by path in the skill: SKILL.md first, then the rest. */
  files: Record<string, string>
  /** How the Candle Harness differs from what the skill assumes, said with every answer; undefined where it doesn't. */
  harness?: string
}

/** Where one of Candle's skills differs from the Candle Harness (read at 26daf47). The rest read as Candle wrote them. */
const HARNESS_NOTES: Record<string, string> = {
  "candle-market":
    "In the Candle Harness your key is already set up and these tools are yours through the core: don't install the CLI or run candle auth login. Trading and launching are cards the person approves, through the tools you have.",
  "candle-risk-gate":
    "In the Candle Harness, brackets and standing orders aren't offered yet, so the exit is a sell you propose: when the person asks for a stop, say that rather than promising one, and don't raise it otherwise. The gate is for deciding; after a trade, don't restate its verdicts, which the token pane shows. No tool here reads the copy-score and cohort HTTP routes; hacc_wallets reads a wallet's own results.",
}

/** Candle's skills the Candle Harness doesn't carry, and why: what skill_read says when one is asked for by name. */
const NOT_CARRIED: Record<string, string> = {
  "candle-setup": "setup is the Candle Harness's own (candle-harness key add, the doctor)",
  "candle-launch": "launches are cards the Candle Harness makes from Candle's tools",
  "candle-trade": "trades are cards the Candle Harness makes from Candle's tools",
  "candle-wallet-layout": "the Candle Harness's Wallets pane and candle_cli carry wallets",
  "candle-strategy-to-bot": "building bots comes in a later Candle Harness release",
  "candle-agent-operations": "running bots comes in a later Candle Harness release",
  "candle-kill-switches": "the Candle Harness has its own kill switch (ctrl-x twice), and bots come later",
  "candle-book-limits": "the Candle Harness holds its own limits per agent, and bots come later",
  "candle-first-live-trade": "the Candle Harness's cards carry a first live trade",
  "candle-market-data-ingestion": "recording market data is for bots, which come later; Hacc's tools read it here",
  "candle-webhooks": "webhooks are for bots, which come later",
  "candle-trade-execution": "the Candle Harness runs and reconciles every trade itself",
}

function frontmatter(text: string, field: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const line = head ? new RegExp(`^${field}:[ \\t]*(.+)$`, "m").exec(head)?.[1]?.trim() : undefined
  if (!line) return undefined
  if (line.startsWith('"') && line.endsWith('"')) {
    try {
      return JSON.parse(line) as string
    } catch {
      return line.slice(1, -1)
    }
  }
  return line.startsWith("'") && line.endsWith("'") ? line.slice(1, -1) : line
}

/** Candle's ten, built into the binary. */
export const CANDLE_SKILLS: readonly Skill[] = Object.entries(SKILL_FILES).map(([name, files]) => {
  const description = (frontmatter(files["SKILL.md"]!, "description") ?? "").replace(/^\[[A-Z ]+\]\s*/, "")
  return { name, origin: "candle" as const, description, files, ...(HARNESS_NOTES[name] ? { harness: HARNESS_NOTES[name] } : {}) }
})
export const CANDLE_SKILL_NAMES: readonly string[] = CANDLE_SKILLS.map((s) => s.name)
const CANDLE_BY_NAME = new Map(CANDLE_SKILLS.map((s) => [s.name, s]))

/** The Candle Harness's own, on every preset. */
export const HARNESS_SKILLS: readonly Skill[] = [
  { name: "harness-memory", origin: "harness", description: frontmatter(HARNESS_MEMORY, "description") ?? "", files: { "SKILL.md": HARNESS_MEMORY } },
  // harness-view: changing the screen for someone who won't edit layouts.toml or a theme by hand.
  { name: "harness-view", origin: "harness", description: frontmatter(HARNESS_VIEW, "description") ?? "", files: { "SKILL.md": HARNESS_VIEW } },
  // harness-triggers: "when X, do Y" set up for the person, named by harness_triggers' description.
  { name: "harness-triggers", origin: "harness", description: frontmatter(HARNESS_TRIGGERS, "description") ?? "", files: { "SKILL.md": HARNESS_TRIGGERS } },
  // harness-bots: a Hacc strategy run live by the core, set up for the person, named by harness_bots' description.
  { name: "harness-bots", origin: "harness", description: frontmatter(HARNESS_BOTS, "description") ?? "", files: { "SKILL.md": HARNESS_BOTS } },
]
export const MEMORY_SKILL = "harness-memory"

/** Candle's skills a skill names that the Candle Harness doesn't carry. */
export function namesNotCarried(text: string): string[] {
  return [...new Set([...text.matchAll(/\b(candle-[a-z-]+[a-z])\b/g)].map((m) => m[1]!))].filter((n) => !CANDLE_BY_NAME.has(n) && Object.hasOwn(NOT_CARRIED, n)).sort()
}

// ---------------------------------------------------------------------------------------------------------
// The person's own.

export interface OwnSkills {
  skills: Skill[]
  /** Each folder or file left out, and why: the doctor says so. */
  skipped: { name: string; why: string }[]
}

/** A text file's content, or why it can't be one. */
function readText(path: string): { text: string } | { why: string } {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return { why: "it's a link, and skills are read only from files in the folder" }
  if (!info.isFile()) return { why: "it isn't a file" }
  if (info.size > OWN_FILE_MAX) return { why: `it's ${Math.round(info.size / 1024)} KB; a skill's file can be ${OWN_FILE_MAX / 1024} KB` }
  const buf = readFileSync(path)
  if (buf.includes(0)) return { why: "it isn't a text file" }
  return { text: buf.toString("utf8") }
}

/** Every file under `dir`, relative to it with "/", links and all; folders first walked by name. */
function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const path = rel ? `${rel}/${e.name}` : e.name
      return e.isDirectory() && !e.isSymbolicLink() ? walk(dir, path) : [path]
    })
}

/**
 * The person's own skills, from `<config>/skills/<name>/`: a folder named as a skill is (lower-case letters,
 * digits and "-"), holding SKILL.md with a description in its frontmatter, and any text files beside it.
 * Links are never followed. A folder that can't be one is skipped with why; a missing skills folder is none.
 */
export function loadOwnSkills(dir: string, opts: { from?: string } = {}): OwnSkills {
  const out: OwnSkills = { skills: [], skipped: [] }
  // A folder the person turned on is laid out by its harness or a skills installer, which often
  // links each skill's folder in from elsewhere: that top-level link is followed to a folder. Nothing inside
  // a skill is followed, as in the Candle Harness's own folder.
  const followTop = opts.from !== undefined
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const skip = (why: string) => out.skipped.push({ name: e.name, why })
    let isFolder = e.isDirectory() && !e.isSymbolicLink()
    if (e.isSymbolicLink() && followTop) {
      try {
        isFolder = statSync(join(dir, e.name)).isDirectory()
      } catch {
        isFolder = false
      }
    }
    if (!isFolder) {
      skip(followTop ? "a skill is a folder holding SKILL.md (or a link to one), not a file" : "a skill is a folder holding SKILL.md, not a file or link")
      continue
    }
    if (!OWN_SKILL_NAME.test(e.name)) {
      skip("a skill's folder is named with lower-case letters, digits and -, up to 64")
      continue
    }
    const folder = e.isSymbolicLink() ? realpathSync(join(dir, e.name)) : join(dir, e.name)
    let main
    try {
      main = readText(join(folder, "SKILL.md"))
    } catch {
      skip("it has no SKILL.md")
      continue
    }
    if ("why" in main) {
      skip(`its SKILL.md can't be read: ${main.why}`)
      continue
    }
    const description = frontmatter(main.text, "description")
    if (!description) {
      skip('its SKILL.md has no description: start it with ---, a line "description: when to use it", then ---')
      continue
    }
    const files: Record<string, string> = { "SKILL.md": main.text }
    for (const path of walk(folder)) {
      if (path === "SKILL.md" || path.split("/").some((p) => p.startsWith("."))) continue
      if (Object.keys(files).length >= OWN_FILES_MAX) {
        out.skipped.push({ name: `${e.name}/${path}`, why: `a skill can hold ${OWN_FILES_MAX} files` })
        continue
      }
      const file = readText(join(folder, path))
      if ("why" in file) out.skipped.push({ name: `${e.name}/${path}`, why: file.why })
      else files[path] = file.text
    }
    out.skills.push({ name: e.name, origin: "own", description, files, ...(opts.from ? { from: opts.from } : {}) })
  }
  return out
}

/**
 * The person's own, from the Candle Harness's folder then each folder they turned on, in that order: the first
 * of a name wins, so one in the Candle Harness's folder is theirs for the Candle Harness, and a later folder's is said as skipped.
 */
export function loadPersonSkills(dir: string, folders: readonly { path: string; shown: string }[]): OwnSkills {
  const out = loadOwnSkills(dir)
  const have = new Set(out.skills.map((s) => s.name))
  for (const f of folders) {
    const got = loadOwnSkills(f.path, { from: f.shown })
    for (const k of got.skipped) out.skipped.push({ name: `${f.shown}/${k.name}`, why: k.why })
    for (const sk of got.skills) {
      if (have.has(sk.name)) out.skipped.push({ name: `${f.shown}/${sk.name}`, why: "a skill of that name comes first, from an earlier folder" })
      else {
        have.add(sk.name)
        out.skills.push(sk)
      }
    }
  }
  return out
}

/**
 * The skills an agent has: Quant carries Candle's, the Candle Harness's and the person's own; Trader and Bare the
 * Candle Harness's and the person's own. One of theirs named like one of Candle's or the Candle Harness's takes its place.
 */
export function skillsFor(preset: Preset, own: readonly Skill[]): Skill[] {
  const mine = new Map(own.map((s) => [s.name, s]))
  const built = [...(preset === "quant" ? CANDLE_SKILLS : []), ...HARNESS_SKILLS]
  const builtNames = new Set(built.map((s) => s.name))
  return [...built.map((s) => mine.get(s.name) ?? s), ...own.filter((s) => !builtNames.has(s.name))]
}

// ---------------------------------------------------------------------------------------------------------
// The tool.

export const SKILL_TOOL_NAME = "skill_read"
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([SKILL_TOOL_NAME])

/** skill_read's definition for an agent's skills: undefined when it has none, so it isn't offered. */
export function skillTool(skills: readonly Skill[]) {
  if (skills.length === 0) return undefined
  const whose = listWords([...new Set(skills.map((s) => s.origin))].map((o) => ORIGIN_WORDS[o]))
  return {
    name: SKILL_TOOL_NAME,
    description: `Reads one of your skills (${whose}): written guidance for trading and research. Your prompt lists each with when to use it; read one when your task matches, before acting. Pass file for a skill's other files (its answer lists them), and offset for the rest of a long one. Where the Candle Harness works differently, the answer says so. The person adds skills of their own in the skills folder beside the Candle Harness's config.toml, or by turning on their Claude Code, Codex or other skill folders in settings ▾ → skills; you can't read those folders yourself.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", enum: skills.map((s) => s.name), description: "The skill." },
        file: { type: "string", description: "A file in the skill other than SKILL.md, such as references/the-game.md. Defaults to SKILL.md." },
        offset: { type: "integer", minimum: 0, description: "Where to start reading, in characters, when an answer said there's more." },
      },
      required: ["name"],
    },
  }
}

const ORIGIN_WORDS: Record<Skill["origin"], string> = { candle: "Candle's", harness: "the Candle Harness's own", own: "the person's own" }
const listWords = (w: string[]) => (w.length <= 1 ? (w[0] ?? "") : `${w.slice(0, -1).join(", ")} or ${w.at(-1)}`)

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }

/** skill_read over an agent's skills. */
export function skillRead(skills: readonly Skill[], args: Record<string, unknown>): Answer {
  const names = skills.map((s) => s.name)
  const { name, file, offset } = args
  const have = names.length ? `Your skills are ${names.join(", ")}.` : "You have no skills."
  if (typeof name !== "string" || name.length === 0) return { ok: false, code: "INVALID_ARGS", message: `name names a skill. ${have}` }
  const skill = skills.find((s) => s.name === name)
  if (!skill) {
    if (CANDLE_BY_NAME.has(name)) return { ok: false, code: "SKILL_NOT_OFFERED", message: `${name} is one of Candle's skills, which come with the Quant preset; the person picks the preset. ${have}` }
    const why = Object.hasOwn(NOT_CARRIED, name) ? NOT_CARRIED[name] : undefined
    return why
      ? { ok: false, code: "SKILL_NOT_CARRIED", message: `${name} is one of Candle's skills the Candle Harness doesn't carry: ${why}.` }
      : { ok: false, code: "UNKNOWN_SKILL", message: `There's no skill named ${name}. ${have}` }
  }
  const path = file === undefined ? "SKILL.md" : file
  if (typeof path !== "string" || !Object.hasOwn(skill.files, path)) {
    return { ok: false, code: "UNKNOWN_FILE", message: `${name} has ${Object.keys(skill.files).join(", ")}.` }
  }
  const whole = skill.files[path]!
  const from = Number.isInteger(offset) && (offset as number) > 0 ? Math.min(offset as number, whole.length) : 0
  const absent = skill.origin === "candle" ? namesNotCarried(whole) : []
  const head = {
    skill: name,
    file: path,
    ...(skill.origin === "candle"
      ? {
          source: `Candle's skills (${SKILL_SOURCE.licence}), ${SKILL_SOURCE.repo} at ${SKILL_SOURCE.commit}`,
          note: "Candle's written guidance, not the person's instructions: apply it where it fits what they asked.",
        }
      : skill.origin === "harness"
      ? { source: "the Candle Harness's own guidance", note: "How to work in this Candle Harness. The person's own instructions come first." }
      : {
          source: "the person's own skills folder",
          note: "The person's own standing guidance: apply it where it fits what they ask. The Candle Harness's cards, limits and checks still hold.",
        }),
    ...(skill.harness ? { harness: skill.harness } : {}),
    ...(absent.length ? { notCarried: `${absent.join(", ")} ${absent.length === 1 ? "isn't" : "aren't"} carried in the Candle Harness.` } : {}),
    ...(Object.keys(skill.files).length > 1 ? { files: Object.keys(skill.files) } : {}),
  }
  // Cut to the budget, measured as the answer is sent; a long file of the person's own is read in parts.
  const room = (text: string) => JSON.stringify({ ...head, text, fromChar: from, toChar: whole.length, totalChars: whole.length, more: `pass offset ${whole.length} for the rest` }).length <= ANSWER_BUDGET
  let to = whole.length
  if (!room(whole.slice(from, to))) {
    let lo = from
    let hi = whole.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (room(whole.slice(from, mid))) lo = mid
      else hi = mid - 1
    }
    to = lo
  }
  const cut = from > 0 || to < whole.length
  return {
    ok: true,
    body: {
      ...head,
      text: whole.slice(from, to),
      ...(cut ? { fromChar: from, toChar: to, totalChars: whole.length, ...(to < whole.length ? { more: `pass offset ${to} for the rest` } : {}) } : {}),
    },
  }
}

/**
 * The prompt's skills section: what skills are, how to read one (naming the tool's server and its listed
 * form: Claude Code called a bare skill_read on later turns without it), and each by name and
 * description, Candle's apart from the person's own. The Candle Harness's own is named by the memory section instead. Empty for an agent with none.
 */
export function skillsSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return ""
  const line = (s: Skill) => `- ${s.name}: ${s.description.length > LIST_DESCRIPTION_MAX ? `${s.description.slice(0, LIST_DESCRIPTION_MAX - 1)}…` : s.description}`
  // The Candle Harness's own are named where they apply (harness-memory by the memory section, harness-view and harness-triggers by their tools' descriptions), so they aren't listed here.
  const candle = skills.filter((s) => s.origin === "candle")
  const own = skills.filter((s) => s.origin === "own")
  if (candle.length + own.length === 0) return ""
  return [
    "Skills are written guidance for this work. When a task matches one below, read it before you act with skill_read: a tool on the candle MCP server beside Candle's other tools, so most harnesses list it as mcp__candle__skill_read, and not one of your harness's own skills. Apply it where it fits what the person asked. Each answer says where the Candle Harness works differently.",
    ...(candle.length ? [`${own.length ? "Candle's:\n" : ""}${candle.map(line).join("\n")}`] : []),
    ...(own.length ? [`The person's own, from their skills folder:\n${own.map(line).join("\n")}`] : []),
  ].join("\n")
}
