// Themes, picked and of your own: Candle dark (the default),
// Candle light, Terminal (the terminal's own colours, theme.ts) and any `themes/<name>.toml` beside
// config.toml. config.toml's `[theme] name` is where a fresh install starts; the palette switches at once,
// and the choice is kept in state/theme.json so a restart keeps it, until [theme] name is changed by hand.
// Every view watches that file, so a popped view follows the main one. The core reads none of it.
//
// A theme of yours names any roles it changes; the rest come from its base, Candle dark unless it says
// `base = "Candle light"`:
//
//   base = "Candle dark"
//   pane = "#101418"
//   attention = "#ffb000"
//
//   [reply]
//   code = "#9ecbff"
//
// A colour that isn't `#rrggbb`, or a key that isn't a role, is named with its line and left out. A theme
// that would make text unreadable, or two meanings alike (theme.ts, `problemsOf`), isn't used: it's named
// with why, and the view starts on Candle dark, or keeps the theme it has when one is picked. Nothing here
// ever stops the view opening.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs"
import { join } from "node:path"
import { keysIn } from "../config-settings"
import type { Paths } from "../paths"
import { BUILT_IN, BUILT_IN_NAMES, CANDLE_DARK, CANDLE_LIGHT, type Colours, hexOf, problemsOf, type Role, TERMINAL, type TerminalColours, terminalColours } from "./theme"

/** A theme file's keys, in words a person would use, to the roles they set. */
export const KEYS: Readonly<Record<string, Role>> = {
  page: "page",
  bar: "bar",
  pane: "term",
  border: "edge",
  selected: "sel",
  focus: "focus",
  bright: "hi",
  text: "ink",
  dim: "dim",
  heading: "head",
  attention: "look",
  good: "good",
  bad: "bad",
  control: "ctl",
  control_bg: "ctlBg",
  control_hover: "ctlHover",
  bad_bg: "badBg",
  paper_bg: "paperBg",
}
/** `[reply]`'s keys: the agent's rendered reply. */
export const REPLY_KEYS: Readonly<Record<string, Role>> = { heading: "mdHead", bright: "mdBright", dim: "mdDim", code: "mdCode", quote: "mdQuote" }

/** config.toml's [theme] table: config-settings.ts's. */
const THEME_TABLE = keysIn("config.toml", "theme")

/** A theme file's name: its file's, without `.toml`. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const quote = (v: unknown) => JSON.stringify(v)
const builtIn = (name: string): string | undefined => BUILT_IN_NAMES.find((n) => n.toLowerCase() === name.trim().toLowerCase())

/** The line (from 1) where `key` is set, inside `[table]` when one's given, else the table's own line or 1. */
function lineOf(source: string, key: string, table?: string): number {
  const lines = source.split("\n")
  const start = table ? lines.findIndex((l) => new RegExp(`^\\s*\\[\\s*${table}\\s*\\]`).test(l)) : -1
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const at = new RegExp(`^\\s*(?:"${esc}"|'${esc}'|${esc})\\s*=`)
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      if (!table) break
      continue
    }
    if (at.test(lines[i]!)) return i + 1
  }
  return Math.max(1, start + 1)
}

/** A theme file, read: the base it starts from, the roles it sets, and each problem with its line. */
export interface ThemeFile {
  base: string
  set: Partial<Colours>
  problems: string[]
}

/** Reads a theme of yours. Never throws: a bad leaf is named with its line and left out. */
export function parseTheme(source: string, file: string): ThemeFile {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    return { base: CANDLE_DARK, set: {}, problems: [`${file} isn't valid TOML (${((error as Error).message ?? "").replace(/^TOML Parse error: /, "")})`] }
  }
  const top = isRecord(raw) ? raw : {}
  const problems: string[] = []
  const at = (line: number, text: string) => problems.push(`${file} line ${line}: ${text}`)
  const set: Partial<Colours> = {}
  let base = CANDLE_DARK
  if (top.base !== undefined) {
    const named = typeof top.base === "string" ? builtIn(top.base) : undefined
    if (named && BUILT_IN[named]) base = named
    else at(lineOf(source, "base"), `base is ${quote(top.base)}; a theme starts from "${CANDLE_DARK}" or "${CANDLE_LIGHT}", so it's ${CANDLE_DARK}`)
  }
  const colour = (key: string, value: unknown, role: Role, table?: string) => {
    const hex = hexOf(value)
    if (hex) set[role] = hex
    else at(lineOf(source, key, table), `${table ? `${table}.` : ""}${key} is ${quote(value)}; a colour is written "#rrggbb", such as "#6cb6ff". It's left out.`)
  }
  for (const [key, value] of Object.entries(top)) {
    if (key === "base") continue
    if (key === "reply") {
      if (!isRecord(value)) {
        at(lineOf(source, "reply"), "reply must be a table, such as [reply] then code = \"#9ecbff\"")
        continue
      }
      for (const [k, v] of Object.entries(value)) {
        const role = REPLY_KEYS[k]
        if (role) colour(k, v, role, "reply")
        else at(lineOf(source, k, "reply"), `${quote(k)} isn't one of a reply's colours (${Object.keys(REPLY_KEYS).join(", ")}). It's left out.`)
      }
      continue
    }
    const role = KEYS[key]
    if (role) colour(key, value, role)
    else at(lineOf(source, key), `${quote(key)} isn't one of a theme's colours (${Object.keys(KEYS).join(", ")}, and [reply]). It's left out.`)
  }
  return { base, set, problems }
}

/** A theme read to go on screen: what was asked for, whether it can be, its colours, and its problems. */
export interface Loaded {
  name: string
  /** False when it can't be drawn: `problems[0]` says why, and `colours` are Candle dark's. */
  used: boolean
  colours: Colours
  /** Each problem in words: a left-out leaf of a theme that's used, or why one isn't. */
  problems: string[]
}

/** Where themes come from and where the choice is kept. */
export interface ThemeStore {
  /** Where themes of yours go, to show. */
  dir: string
  /** The themes of yours there, by name. */
  own(): string[]
  /** A theme of yours's text, or undefined when there's no such file. */
  read(name: string): string | undefined
  /** Writes a theme of yours whole (such as one the agent made); throws when it can't. */
  write?(name: string, text: string): void
  chosen(): Chosen | undefined
  saveChosen(chosen: Chosen): void
  /** Calls `onChange` when the choice is changed, by this view or another. Returns how to stop. */
  watch(onChange: () => void): () => void
}

/** The theme last chosen, and config.toml's [theme] name when it was: a later hand edit there wins. */
export interface Chosen {
  name: string
  config?: string
}

/** Every theme by name: the built-ins, then yours. */
export const themeNames = (store: ThemeStore | undefined): string[] => [...BUILT_IN_NAMES, ...(store?.own() ?? [])]

/**
 * Loads a theme by name. Terminal needs the terminal's colours, read when it's picked (`terminal`); a
 * theme of yours is read from its file each time, so picking it again picks up an edit.
 */
export function loadTheme(asked: string, store: ThemeStore | undefined, terminal?: TerminalColours): Loaded {
  const dark = (problems: string[]): Loaded => ({ name: asked, used: false, colours: { ...BUILT_IN[CANDLE_DARK]! }, problems })
  const named = builtIn(asked)
  if (named === TERMINAL) {
    const colours = terminal ? terminalColours(terminal) : undefined
    if (!colours) return dark([`${TERMINAL} draws from the terminal's own colours, and this terminal didn't say what they are`])
    const faults = problemsOf(colours)
    if (faults.length) return dark([`${TERMINAL} can't be drawn readably from this terminal's colours (${faults[0]}${faults.length > 1 ? `, and ${faults.length - 1} more` : ""})`])
    return { name: TERMINAL, used: true, colours, problems: [] }
  }
  if (named) return { name: named, used: true, colours: { ...BUILT_IN[named]! }, problems: [] }
  const file = `themes/${asked}.toml`
  const source = store && FILE_NAME.test(asked) ? store.read(asked) : undefined
  if (source === undefined) return dark([`There's no theme called ${quote(asked)} (the themes: ${themeNames(store).join(", ")})`])
  const read = parseTheme(source, file)
  const colours = { ...BUILT_IN[read.base]!, ...read.set }
  const faults = problemsOf(colours)
  if (faults.length) return dark([`${file} can't be used, since ${faults[0]}${faults.length > 1 ? ` (and ${faults.length - 1} more)` : ""}`, ...read.problems])
  return { name: asked, used: true, colours, problems: read.problems }
}

/** config.toml's `[theme] name`, and a problem with it if there is one. Never throws. */
export function configTheme(source: string | undefined): { name?: string; problem?: string } {
  if (source === undefined) return {}
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch {
    return {}
  }
  const table = isRecord(raw) ? raw.theme : undefined
  if (table === undefined) return {}
  if (!isRecord(table)) return { problem: `config.toml line ${lineOf(source, "theme")}: theme must be a table, such as [theme] then name = "${CANDLE_LIGHT}"` }
  for (const key of Object.keys(table)) if (!THEME_TABLE.includes(key)) return { problem: `config.toml line ${lineOf(source, key, "theme")}: theme.${key} isn't a setting (${THEME_TABLE.join(", ")})` }
  if (table.name === undefined) return {}
  if (typeof table.name !== "string" || !table.name.trim()) return { problem: `config.toml line ${lineOf(source, "name", "theme")}: theme.name is ${quote(table.name)}; it's a theme's name, such as "${CANDLE_LIGHT}"` }
  return { name: builtIn(table.name) ?? table.name.trim() }
}

/** The theme a view starts on: the last chosen, unless config.toml's [theme] name has been changed since; then that; else Candle dark. */
export function startingTheme(store: ThemeStore | undefined, config: string | undefined): string {
  const chosen = store?.chosen()
  if (chosen && chosen.config === config) return chosen.name
  return config ?? CANDLE_DARK
}

function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function fileThemes(p: Pick<Paths, "themesDir" | "themeChoice">): ThemeStore {
  return {
    dir: p.themesDir,
    own() {
      try {
        return readdirSync(p.themesDir)
          .filter((f) => f.endsWith(".toml"))
          .map((f) => f.slice(0, -".toml".length))
          .filter((n) => FILE_NAME.test(n) && !builtIn(n))
          .sort((a, b) => a.localeCompare(b))
      } catch {
        return []
      }
    },
    read(name) {
      try {
        return readFileSync(join(p.themesDir, `${name}.toml`), "utf8")
      } catch {
        return undefined
      }
    },
    write(name, text) {
      mkdirSync(p.themesDir, { recursive: true, mode: 0o700 })
      writeWhole(join(p.themesDir, `${name}.toml`), text)
    },
    chosen() {
      try {
        const raw = JSON.parse(readFileSync(p.themeChoice, "utf8")) as Record<string, unknown>
        if (typeof raw.name !== "string") return undefined
        return { name: raw.name, ...(typeof raw.config === "string" ? { config: raw.config } : {}) }
      } catch {
        return undefined
      }
    },
    saveChosen: (chosen) => writeWhole(p.themeChoice, `${JSON.stringify(chosen, null, 2)}\n`),
    watch(onChange) {
      // Polled, since a rename (how it's written) ends a native watch on some systems; once a second is plenty.
      const listener = (now: { mtimeMs: number }, was: { mtimeMs: number }) => {
        if (now.mtimeMs !== was.mtimeMs) onChange()
      }
      watchFile(p.themeChoice, { interval: 1000, persistent: false }, listener)
      return () => unwatchFile(p.themeChoice, listener)
    },
  }
}

/** A store held in memory: for tests, and a view with nowhere to write. */
export function memoryThemes(files: Record<string, string> = {}, chosen?: Chosen): ThemeStore & { saved: Chosen[]; change(c: Chosen): void } {
  let current = chosen
  const saved: Chosen[] = []
  const listeners = new Set<() => void>()
  return {
    dir: "themes",
    saved,
    own: () => Object.keys(files).sort((a, b) => a.localeCompare(b)),
    read: (name) => files[name],
    write(name, text) {
      files[name] = text
    },
    chosen: () => current,
    saveChosen(c) {
      current = c
      saved.push(c)
      for (const l of listeners) l()
    },
    watch(onChange) {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    /** Another view's choice, as the file watch would see it. */
    change(c) {
      current = c
      for (const l of listeners) l()
    },
  }
}
