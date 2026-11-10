// The Build pane's choices: the bots folder and the coding harness it opens. The person picks both on the pane's first
// open; they're kept in state/build.json, and config.toml's [build] is only where a fresh install starts. Nothing
// here is a key or a secret: a folder and a harness's id or command.
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { ENGINE_IDS, type EngineId } from "../engine/engine"

/** The bots folder a fresh install offers. */
export const DEFAULT_FOLDER = "~/candle-bots"
/** A harness: one of the engines by its id, or a command of the person's own, as a line. */
export const HARNESS_MAX = 200

export interface BuildPrefs {
  folder: string
  harness?: string
  /** Where each came from: picked in the pane, config.toml, or the default. */
  from: { folder: "saved" | "config" | "default"; harness?: "saved" | "config" }
  /** Whether the pane's first open has run here: the folder was asked for and written once. */
  opened: boolean
}

interface Saved {
  folder?: string
  harness?: string
  opened?: boolean
}

function readSaved(path: string): Saved {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Saved
    const out: Saved = {}
    if (typeof raw.folder === "string" && folderProblem(raw.folder) === undefined) out.folder = raw.folder
    if (typeof raw.harness === "string" && harnessProblem(raw.harness) === undefined) out.harness = raw.harness
    if (raw.opened === true) out.opened = true
    return out
  } catch {
    return {}
  }
}

export function readBuildPrefs(path: string, config: { folder?: string; harness?: string } | undefined): BuildPrefs {
  const saved = readSaved(path)
  const folder = saved.folder ?? config?.folder ?? DEFAULT_FOLDER
  const harness = saved.harness ?? config?.harness
  return {
    folder,
    ...(harness !== undefined ? { harness } : {}),
    from: { folder: saved.folder ? "saved" : config?.folder ? "config" : "default", ...(harness !== undefined ? { harness: saved.harness ? ("saved" as const) : ("config" as const) } : {}) },
    opened: saved.opened === true,
  }
}

export function saveBuildPrefs(path: string, change: { folder?: string; harness?: string; opened?: true }): void {
  const next = { ...readSaved(path), ...change }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Why a folder can't be the bots folder, or nothing: one from / or ~/, in plain text. */
export function folderProblem(folder: string): string | undefined {
  const f = folder.trim()
  if (!f) return "Type a folder for your bots, such as ~/candle-bots."
  if (f.length > 400 || /[\x00-\x1f\x7f]/.test(f)) return "A folder is a plain path, from / or ~/."
  if (!/^(\/|~\/|~$)/.test(f)) return "A folder starts with / or ~/, such as ~/candle-bots."
  return undefined
}

/** Why a harness can't be opened, or nothing: an engine's id, or a command line with no control characters. */
export function harnessProblem(harness: string): string | undefined {
  const h = harness.trim()
  if (!h) return "Pick a harness, or type a command."
  if (h.length > HARNESS_MAX || /[\x00-\x1f\x7f]/.test(h)) return "A command is one plain line."
  return undefined
}

export const isEngineHarness = (harness: string | undefined): harness is EngineId => (ENGINE_IDS as readonly string[]).includes(harness ?? "")

/**
 * A command of the person's own as argv: words split on spaces, with "double" or 'single' quotes keeping spaces in one.
 * No shell runs it, so nothing is expanded.
 */
export function commandArgv(line: string): string[] {
  const out: string[] = []
  let word = ""
  let quote: string | undefined
  let started = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === " " || ch === "\t") {
      if (started) out.push(word)
      word = ""
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (started) out.push(word)
  return out
}
