// Aliases: config.toml's [aliases], read by the view when it starts and
// from the palette's "reload aliases", and by the core whenever the file changes (core/line-reader.ts), by
// the same rules, so a line means the same to both. Neither writes them. An alias replaces a line's first word and
// keeps the rest (`b5 = "buy $5 of"`, so `b5 JUP` is `buy $5 of JUP`), and may hold a chain. What an alias
// becomes is parsed as if typed, so it can't send what a typed line couldn't.
//
// Left out, each named with its line: a built-in command's name (so `buy` always means buy), a name that
// isn't one word, a value with control characters, an alias that calls itself or another in a loop, and one
// that expands to more parts than a chain runs. The rest are used; a bad alias never stops the view or the core.

/** The words the input line already means something by: an alias can't take them. */
export const BUILT_INS: readonly string[] = ["buy", "sell", "swap", "kill", "paper", "live", "resume", "resend", "abandon", "help", "agent", "candle"]
/** At most this many parts in a chain, aliases expanded. */
export const MAX_PARTS = 5

const NAME = /^[a-z][a-z0-9_-]{0,23}$/
const VALUE_MAX = 300
const CONTROL = /[\u0000-\u001f\u007f]/

export interface Aliases {
  /** By name, lower-cased, to what it becomes. */
  map: ReadonlyMap<string, string>
  /** Each alias left out, with its line. */
  problems: string[]
}

export const NO_ALIASES: Aliases = { map: new Map(), problems: [] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** A line's parts: split on `;`, trimmed, empty ones dropped. */
export const partsOf = (line: string): string[] =>
  line
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "")

/** The first word, lower-cased, and what follows it as typed. */
function firstWord(part: string): { word: string; rest: string } {
  const m = /^(\S+)(.*)$/s.exec(part)
  return m ? { word: m[1]!.toLowerCase(), rest: m[2]! } : { word: "", rest: "" }
}

/**
 * A part with its first word expanded, and the alias's own first words in turn: one or more parts. Only
 * called on a checked map, which has no loops; the depth stops a hand-built one.
 */
export function expandPart(part: string, map: ReadonlyMap<string, string>, depth = 0): string[] {
  const { word, rest } = firstWord(part)
  const value = map.get(word)
  if (value === undefined || depth > map.size) return [part]
  const parts = partsOf(`${value}${rest}`)
  return parts.flatMap((p) => expandPart(p, map, depth + 1))
}

/** The line (from 1) where `name` is set inside [aliases], else the table's own line. */
function lineOf(source: string, name: string): number {
  const lines = source.split("\n")
  const table = lines.findIndex((l) => /^\s*\[\s*aliases\s*\]/.test(l))
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const key = new RegExp(`^\\s*(?:"${esc}"|'${esc}'|${esc})\\s*=`)
  for (let i = Math.max(0, table + 1); i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) break
    if (key.test(lines[i]!)) return i + 1
  }
  return Math.max(1, table + 1)
}

/** Reads config.toml's [aliases]. Never throws: every problem is named with its line, and that alias left out. */
export function parseAliases(source: string | undefined, file = "config.toml"): Aliases {
  if (source === undefined) return NO_ALIASES
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    return { map: new Map(), problems: [`${file} isn't valid TOML (${(error as Error).message}): no aliases are used.`] }
  }
  const table = isRecord(raw) ? raw.aliases : undefined
  if (table === undefined) return NO_ALIASES
  const problems: string[] = []
  const at = (name: string, text: string) => problems.push(`${file} line ${lineOf(source, name)}: ${text}`)
  if (!isRecord(table)) return { map: new Map(), problems: [`${file} line ${lineOf(source, "")}: aliases must be a table, such as [aliases] then b5 = "buy $5 of": no aliases are used.`] }

  const given = new Map<string, string>()
  for (const [name, value] of Object.entries(table)) {
    const lower = name.toLowerCase()
    const shown = JSON.stringify(name)
    if (!NAME.test(lower)) at(name, `alias ${shown} is left out: a name is one word of up to 24 letters, digits, "-" or "_", starting with a letter`)
    else if (BUILT_INS.includes(lower)) at(name, `alias ${shown} is left out: ${lower} is a command already, and an alias can't change what it does`)
    else if (given.has(lower)) at(name, `alias ${shown} is left out: it's set twice (names ignore case)`)
    else if (typeof value !== "string" || value.trim() === "") at(name, `alias ${shown} is left out: its value is the words it stands for, such as "buy $5 of"`)
    else if (CONTROL.test(value)) at(name, `alias ${shown} is left out: it holds a control character`)
    else if (value.length > VALUE_MAX) at(name, `alias ${shown} is left out: it's over ${VALUE_MAX} characters`)
    else given.set(lower, value.trim())
  }

  // An alias that leads back to itself, through any part's first word, is left out with each it loops through.
  const looping = new Set<string>()
  const visit = (name: string, path: string[]): void => {
    if (path.includes(name)) {
      for (const n of path.slice(path.indexOf(name))) looping.add(n)
      return
    }
    for (const part of partsOf(given.get(name)!)) {
      const next = firstWord(part).word
      if (given.has(next)) visit(next, [...path, name])
    }
  }
  for (const name of given.keys()) visit(name, [])
  for (const name of looping) at(name, `alias "${name}" is left out: it calls itself, through ${[...looping].join(" → ")}`)
  const map = new Map([...given].filter(([n]) => !looping.has(n)))

  // Too many parts once expanded: no line it starts could run.
  for (const [name, value] of [...map]) {
    const n = partsOf(value).flatMap((p) => expandPart(p, map)).length
    if (n > MAX_PARTS) {
      at(name, `alias "${name}" is left out: it runs ${n} parts, and a chain runs at most ${MAX_PARTS}`)
      map.delete(name)
    }
  }
  return { map, problems }
}
