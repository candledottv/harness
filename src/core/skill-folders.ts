// Skill folders of the person's own, so someone who already keeps Claude Code skills can use them here. The
// core reads the skills in each folder the person turns on, the same way as the Candle Harness's own skills folder
// (engine/skills.ts), and serves them through skill_read. The
// agent still can't read the folders itself, and each harness's own loader stays closed, so nothing else
// of the person's harness setup (hooks, MCP servers, CLAUDE.md) reaches a turn. Off until turned on: a skill is
// instructions, and these run beside trading tools.
//
// config.toml's [skills] from is where a fresh install starts; the choice last made (settings ▾ → skills) is
// kept in state/skills.json.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadOwnSkills } from "../engine/skills"

/** The folders the Candle Harness offers, where each harness or the shared skills installers keep a person's skills. */
export const KNOWN_SKILL_FOLDERS: readonly { shown: string; label: string }[] = [
  { shown: "~/.claude/skills", label: "Claude Code's skills" },
  { shown: "~/.codex/skills", label: "Codex's skills" },
  { shown: "~/.agents/skills", label: "shared agent skills" },
  { shown: "~/.config/opencode/skills", label: "OpenCode's skills" },
  { shown: "~/.pi/agent/skills", label: "Pi's skills" },
]

export interface SkillFolder {
  /** As the person writes it, with ~ for the home folder. */
  shown: string
  label: string
  on: boolean
  /** Whether the folder is there on this machine. */
  exists: boolean
  /** Skills in it the Candle Harness can read, and how many of its entries it left out. */
  count: number
  skipped: number
}

export interface SkillsTopic {
  folders: SkillFolder[]
}

/** A folder as written to the path the core reads: a leading ~ is the home folder. */
export const expandFolder = (shown: string, home = homedir()): string => (shown === "~" ? home : shown.startsWith("~/") ? join(home, shown.slice(2)) : shown)

export class SkillFolders {
  private from: string[]

  constructor(
    private readonly file: string,
    initial: readonly string[],
    private readonly home = homedir(),
  ) {
    this.from = [...initial]
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { from?: unknown }
      if (Array.isArray(raw.from)) this.from = raw.from.filter((f): f is string => typeof f === "string" && (f.startsWith("/") || f.startsWith("~/")))
    } catch {
      // No choice kept yet: config.toml's.
    }
  }

  /** The folders turned on, in order, for the skill reader. */
  on(): { path: string; shown: string }[] {
    return this.from.map((shown) => ({ path: expandFolder(shown, this.home), shown }))
  }

  /** Turns a folder on or off; kept for the next start. */
  set(shown: string, on: boolean): void {
    const rest = this.from.filter((f) => f !== shown)
    this.from = on ? [...rest, shown] : rest
    writeFileSync(this.file, `${JSON.stringify({ from: this.from }, null, 2)}\n`, { mode: 0o600 })
  }

  /** What settings ▾ → skills shows: the known folders and any other turned on, each read now. */
  topic(): SkillsTopic {
    const shownAll = [...KNOWN_SKILL_FOLDERS.map((k) => k.shown), ...this.from.filter((f) => !KNOWN_SKILL_FOLDERS.some((k) => k.shown === f))]
    return {
      folders: shownAll.map((shown) => {
        const path = expandFolder(shown, this.home)
        let exists = false
        try {
          exists = existsSync(path) && statSync(path).isDirectory()
        } catch {
          exists = false
        }
        const read = exists ? loadOwnSkills(path, { from: shown }) : { skills: [], skipped: [] }
        return { shown, label: KNOWN_SKILL_FOLDERS.find((k) => k.shown === shown)?.label ?? "skills", on: this.from.includes(shown), exists, count: read.skills.length, skipped: read.skipped.length }
      }),
    }
  }
}
