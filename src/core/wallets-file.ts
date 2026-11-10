// wallets.toml: the Candle Harness's own names for wallets Candle and the vault hold
// no label for (the embedded wallet, a destination), by address, beside config.toml. The Candle Harness writes it
// whole when you name a wallet, and you can edit it by hand, as layouts.toml. It's read at start and again
// whenever it changes. A problem is named with its line and what's wrong is left out; a file with a problem
// is never written over (as layouts.toml), so a hand edit is never lost. Groups sit after
// the names, each a prefix, a list of wallets, or both (wallet-groups.ts).
//
//   [names]
//   "<address>" = "main"
//
//   [groups.bots]
//   prefix = "bot-"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { keysIn } from "../config-settings"
import { fileStamp } from "../shared/file-stamp"
import { bareprefix, type GroupDef, groupNameProblem, prefixProblem } from "./wallet-groups"
import { candleLabelProblem, isAddressShaped } from "./wallet-names"
import { terminalText } from "../shared/terminal-text"

export const WALLETS_HEADER =
  "# candle-harness's names for wallets Candle holds no label for (the embedded wallet, a destination), by address.\n" +
  "# The Candle Harness writes this file whole when you name a wallet, so a comment of yours below this header won't survive\n" +
  "# that. A TEE wallet's name is Candle's, and a vault key's the vault's: the Candle Harness renames those where they're kept.\n" +
  "# Groups follow the names: [groups.<name>] with a prefix (every wallet whose name starts with it), wallets, or both.\n"

export interface WalletsFile {
  names: Record<string, string>
  groups: Record<string, GroupDef>
  problems: string[]
}

// What the file and a group hold: config-settings.ts's, so a setting can't be read without words for the docs.
const TOP_KEYS = keysIn("wallets.toml", "")
const GROUP_KEYS = keysIn("wallets.toml", "groups.<group>")

const EMPTY: WalletsFile = { names: {}, groups: {}, problems: [] }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const quote = (v: string) => JSON.stringify(v)

/** The line (from 1) of the first `needle` at or after `from`, else of `from`. */
function lineOf(source: string, needle: string, from = 0): number {
  const at = source.indexOf(needle, from)
  return source.slice(0, at < 0 ? from : at).split("\n").length
}

/** Where a group's table starts: `[groups.name]` or `[groups."name"]`. */
const groupAt = (source: string, name: string): number => {
  const m = new RegExp(`\\[\\s*groups\\s*\\.\\s*("${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*\\]`).exec(source)
  return m ? m.index : Math.max(0, source.indexOf(name))
}

/** Reads wallets.toml. Never throws: every problem is named with its line, and what's wrong is left out. */
export function parseWalletsFile(source: string, file = "wallets.toml"): WalletsFile {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    const words = ((error as Error).message ?? "").replace(/^TOML Parse error: /, "")
    return { names: {}, groups: {}, problems: [`${file} isn't valid TOML (${terminalText(words, { maxLength: 120 })}): no names are read from it.`] }
  }
  const problems: string[] = []
  const at = (line: number, text: string) => problems.push(`${file} line ${line}: ${text}`)
  const top = isRecord(raw) ? raw : {}
  for (const key of Object.keys(top)) if (!TOP_KEYS.includes(key)) at(lineOf(source, key), `${quote(terminalText(key, { maxLength: 40 }))} isn't something this file holds (${TOP_KEYS.join(", ")})`)
  const names: Record<string, string> = {}
  if (top.names !== undefined && !isRecord(top.names)) at(lineOf(source, "names"), "names must be a table: [names], then \"<address>\" = \"<name>\"")
  for (const [address, value] of Object.entries(isRecord(top.names) ? top.names : {})) {
    const line = lineOf(source, address)
    const shown = terminalText(address, { maxLength: 48 })
    if (!isAddressShaped(address)) {
      at(line, `${quote(shown)} isn't an address: each name is "<address>" = "<name>"`)
      continue
    }
    if (typeof value !== "string") {
      at(line, `${shown}'s name must be text in quotes`)
      continue
    }
    const why = candleLabelProblem(value)
    if (why) {
      at(line, `${quote(terminalText(value, { maxLength: 64 }))} can't name a wallet: ${why}`)
      continue
    }
    names[address] = value
  }
  return { names, groups: parseGroups(source, top.groups, at), problems }
}

/** `[groups.<name>]` tables: each a prefix, a list of wallets, or both. What's wrong is named and left out. */
function parseGroups(source: string, raw: unknown, at: (line: number, text: string) => void): Record<string, GroupDef> {
  const groups: Record<string, GroupDef> = {}
  if (raw === undefined) return groups
  if (!isRecord(raw)) {
    at(lineOf(source, "groups"), "groups must be tables: [groups.<name>], then prefix = \"…\" or wallets = […]")
    return groups
  }
  for (const [name, value] of Object.entries(raw)) {
    const start = groupAt(source, name)
    const line = lineOf(source, "[", start)
    const why = groupNameProblem(name)
    if (why) {
      at(line, `${quote(terminalText(name, { maxLength: 40 }))} can't name a group: ${why}`)
      continue
    }
    if (!isRecord(value)) {
      at(line, `${name} must be a table: [groups.${name}]`)
      continue
    }
    const def: GroupDef = {}
    let ok = true
    if (value.prefix !== undefined) {
      const problem = typeof value.prefix !== "string" ? "it must be text in quotes" : prefixProblem(value.prefix)
      if (problem) {
        at(lineOf(source, "prefix", start), `${name}'s prefix ${typeof value.prefix === "string" ? quote(terminalText(value.prefix, { maxLength: 64 })) : ""} can't be used: ${problem}`.replace("prefix  can't", "prefix can't"))
        ok = false
      } else def.prefix = bareprefix(value.prefix as string)
    }
    if (value.wallets !== undefined) {
      if (!Array.isArray(value.wallets)) {
        at(lineOf(source, "wallets", start), `${name}'s wallets must be a list in brackets: wallets = ["<name or address>", …]`)
        ok = false
      } else {
        const good = value.wallets.filter((w): w is string => typeof w === "string" && w.trim() !== "" && w.length <= 64)
        const bad = value.wallets.filter((w) => !good.includes(w as string))
        if (bad.length) at(lineOf(source, "wallets", start), `${name}'s wallets: each is a wallet's name or address in quotes (${bad.map((b) => (typeof b === "string" ? quote(terminalText(b, { maxLength: 20 })) : String(b))).join(" and ")} ${bad.length === 1 ? "is" : "are"} left out)`)
        if (good.length) def.wallets = good
      }
    }
    for (const key of Object.keys(value)) if (!GROUP_KEYS.includes(key)) at(lineOf(source, key, start), `${quote(terminalText(key, { maxLength: 40 }))} isn't something a group holds (${GROUP_KEYS.join(", ")})`)
    if (!ok) continue
    if (def.prefix === undefined && def.wallets === undefined) {
      if (value.wallets === undefined) at(line, `${name} has no prefix and no wallets, so it holds nothing`)
      continue
    }
    groups[name] = def
  }
  return groups
}

const byKey = <T>(rows: [string, T][]) => rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : quote(k))

/** wallets.toml as the Candle Harness writes it: the header, then each name, in address order, then each group, in name order. */
export function serializeWalletsFile(names: Readonly<Record<string, string>>, groups: Readonly<Record<string, GroupDef>> = {}): string {
  const rows = byKey(Object.entries(names))
  const tables = byKey(Object.entries(groups)).map(([g, d]) => `\n[groups.${tomlKey(g)}]\n${d.prefix !== undefined ? `prefix = ${quote(d.prefix)}\n` : ""}${d.wallets?.length ? `wallets = [${d.wallets.map(quote).join(", ")}]\n` : ""}`)
  return `${WALLETS_HEADER}\n[names]\n${rows.map(([a, n]) => `${quote(a)} = ${quote(n)}`).join("\n")}${rows.length ? "\n" : ""}${tables.join("")}`
}

/** The file on disk: read again whenever it changed, and written whole, never over a problem. */
export class WalletsFileStore {
  private held: WalletsFile = EMPTY
  private seen: string | undefined

  constructor(private readonly path: string) {}

  /** The names and problems now, read again when the file changed since the last look. */
  read(): WalletsFile {
    const at = fileStamp(this.path)
    if (!at) {
      this.seen = undefined
      this.held = EMPTY
      return this.held
    }
    if (at.stamp !== this.seen || at.recent) {
      this.seen = at.stamp
      try {
        this.held = parseWalletsFile(readFileSync(this.path, "utf8"))
      } catch (error) {
        this.held = { names: {}, groups: {}, problems: [`wallets.toml couldn't be read: ${terminalText((error as Error).message, { maxLength: 120 })}`] }
      }
    }
    return this.held
  }

  /**
   * Names (or, with undefined, un-names) wallets by address, writing the file whole. Refused, with the file
   * untouched, when it has a problem: the person's hand edit is never written over.
   */
  write(changes: Readonly<Record<string, string | undefined>>): { ok: true } | { ok: false; message: string } {
    return this.writeWhole(changes, {})
  }

  /** Sets (or, with undefined, removes) groups by name, as `write` does names: never over a problem. */
  writeGroups(changes: Readonly<Record<string, GroupDef | undefined>>): { ok: true } | { ok: false; message: string } {
    return this.writeWhole({}, changes)
  }

  private writeWhole(names: Readonly<Record<string, string | undefined>>, groups: Readonly<Record<string, GroupDef | undefined>>): { ok: true } | { ok: false; message: string } {
    const now = this.read()
    if (now.problems.length) return { ok: false, message: `wallets.toml has a problem (${now.problems[0]}): fix it before the Candle Harness writes it.` }
    const next = { ...now.names }
    for (const [address, name] of Object.entries(names)) {
      if (name === undefined) delete next[address]
      else next[address] = name
    }
    const nextGroups = { ...now.groups }
    for (const [name, def] of Object.entries(groups)) {
      if (def === undefined) delete nextGroups[name]
      else nextGroups[name] = def
    }
    // A change the file can't hold (one TOML refuses on reading) would lose every name and block its own undo.
    const text = serializeWalletsFile(next, nextGroups)
    const back = parseWalletsFile(text)
    if (back.problems.length) return { ok: false, message: `That change can't be written to wallets.toml (${back.problems[0]}), so nothing changed.` }
    const temp = `${this.path}.tmp`
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, this.path)
    this.seen = undefined
    this.read()
    return { ok: true }
  }
}
