// bots.toml: each bot beside config.toml, as the person can read it. The Candle Harness writes it whole when a bot's
// card is approved, or one is narrowed, paused, stopped, resumed or removed; nothing else writes it.
//
// A rules bot keeps its run settings and its definition, as tables in Hacc's own JSON field names:
//
//   [bots.confluence-small]
//   agent = "agent-a"
//   wallet = "embedded"
//   mode = "paper"
//   state = "on"
//
//   [bots.confluence-small.definition]
//   chain = "solana"
//
//   [bots.confluence-small.definition.entry]
//   source = "pattern"
//   pattern = "confluence"
//   …
//
// A code bot (`kind = "code"`) is the person's own program: its folder and command, and the figures the core holds
// it to whatever its code does (per trade, per day, open at most). Its code isn't in the file: the core starts it.
//
//   [bots.momentum]
//   kind = "code"
//   agent = "agent-a"
//   wallet = "embedded"
//   mode = "paper"
//   state = "on"
//   folder = "/home/you/candle-bots/momentum"
//   command = ["bun", "run", "bot.ts"]
//   perTradeUsd = 2
//   perDayUsd = 10
//   maxOpen = 3
//
// A name is one bot's, of either kind. A problem is named with its line and that bot is left out; a file with a problem is never written over (as
// triggers.toml), so a hand edit is never lost. A hand edit that reads isn't trusted for that: the core keeps
// the hash each bot was approved as (bots.ts), and one changed here holds its entries until it's approved
// again. Pausing or stopping one here is always taken.
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { keysIn } from "../config-settings"
import { canonicalJson } from "../shared/canonical-json"
import { type Definition, readDefinition } from "../shared/definition"
import { terminalText } from "../shared/terminal-text"

export const BOTS_HEADER =
  "# candle-harness's bots: Hacc strategy definitions the Candle Harness runs, and programs of yours it holds to their figures. It writes this file whole when you approve\n" +
  "# a bot's card, or narrow, pause, stop, resume or remove one, so a comment of yours below this header won't survive\n" +
  '# that. Set state = "paused" (no new entries; its exits still sell) or "stopped" (nothing trades). Any other change\n' +
  "# holds that bot's buys until its card is approved again.\n"

/** What a bot does now: on, paused (no entries, its exits run) or stopped (nothing trades). */
export const BOT_STATES = ["on", "paused", "stopped"] as const
export type BotRunState = (typeof BOT_STATES)[number]

export interface BotEntry {
  name: string
  agent: string
  /** The paying wallet's address, or `embedded`. */
  wallet: string
  mode: "paper" | "live"
  state: BotRunState
  /** Its own slippage bound; the route's default where it has none. */
  maxSlippageBps?: number
  definition: Definition
}

/** A code bot: the person's own program, run in its folder by its command, held by the core to its figures. */
export interface CodeBotEntry {
  kind: "code"
  name: string
  agent: string
  /** The paying wallet's address, or `embedded`. */
  wallet: string
  mode: "paper" | "live"
  state: BotRunState
  /** Its folder, absolute. */
  folder: string
  /** Its command, word by word: run in its folder, with no shell. */
  command: string[]
  /** The most one buy or swap may spend, in USD. */
  perTradeUsd: number
  /** The most its buys and swaps may spend in a day, in USD. */
  perDayUsd: number
  /** The most positions it may hold open at once. */
  maxOpen: number
  maxSlippageBps?: number
}

export interface BotsFile {
  /** Rules bots. */
  bots: BotEntry[]
  /** Code bots. */
  code: CodeBotEntry[]
  problems: string[]
}

const TOP_KEYS = keysIn("bots.toml", "")
const ALL_ENTRY_KEYS = keysIn("bots.toml", "bots.<name>")
/** The keys only a code bot holds, and only a rules bot holds. */
export const CODE_ONLY_KEYS = ["kind", "folder", "command", "perTradeUsd", "perDayUsd", "maxOpen"] as const
const RULES_KEYS = ALL_ENTRY_KEYS.filter((k) => !(CODE_ONLY_KEYS as readonly string[]).includes(k))
const CODE_KEYS = ALL_ENTRY_KEYS.filter((k) => k !== "definition")
const EMPTY: BotsFile = { bots: [], code: [], problems: [] }
/** A code bot's figures: what its card can approve. */
export const MAX_FIGURE_USD = 1_000_000
export const MAX_OPEN = 100
const MAX_COMMAND_WORDS = 32
const MAX_WORD = 512

/** Why a folder can't be a code bot's, or undefined when it can: absolute, with no `..` and nothing a terminal would act on. */
export function folderProblem(folder: unknown): string | undefined {
  if (typeof folder !== "string" || folder.length === 0) return "folder is the bot's folder, as an absolute path"
  if (folder.length > 1024) return "folder is at most 1024 characters"
  if (!folder.startsWith("/")) return "folder is an absolute path, starting with /"
  if (folder.split("/").some((part) => part === ".." || part === ".")) return "folder has no . or .. in it"
  if (terminalText(folder) !== folder) return "folder has no control or invisible characters"
  return undefined
}

/** The folders a code bot's folder or the Build pane's bots folder may never be, hold or sit inside. */
export interface GuardedFolders {
  /** The person's home: a folder may sit inside it, but never be it or hold it. */
  home?: string
  /** The Candle Harness's own folders (config, state, keys, the research folders): never, holding or inside. */
  own: string[]
}

/** A path with its links resolved: where it doesn't exist yet, its nearest existing parent's real path and the rest. */
export function realPathOf(path: string): string {
  let at = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync(at)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      const up = dirname(at)
      if (up === at) return resolve(path)
      rest.push(basename(at))
      at = up
    }
  }
}

const within = (child: string, parent: string) => child !== parent && child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)

/**
 * Why a folder can't be a code bot's or the bots folder, by where it really is (links resolved): never `/`, never
 * the home or a folder holding it, and never one of the Candle Harness's own folders, one inside them or one that
 * holds them. Code there would come from the untrusted research agent's files, or reach the keys. Undefined when it can.
 */
export function folderPlaceProblem(folder: string, guarded: GuardedFolders): string | undefined {
  const real = realPathOf(folder)
  if (real === "/") return "folder can't be /, the whole disk"
  if (guarded.home) {
    const home = realPathOf(guarded.home)
    if (real === home) return "folder can't be your home folder: give the bot a folder of its own inside it"
    if (within(home, real)) return "folder can't hold your home folder: give the bot a folder of its own inside it"
  }
  for (const own of guarded.own) {
    const o = realPathOf(own)
    if (real === o || within(real, o) || within(o, real)) return `folder can't be, sit inside or hold the Candle Harness's own folder ${own}, where its settings, keys and the research agent's files are`
  }
  return undefined
}

/** Why a command can't be a code bot's, or undefined when it can: a list of words, run with no shell. */
export function commandProblem(command: unknown): string | undefined {
  const shape = 'command is a list of words, run in its folder with no shell: ["bun", "run", "bot.ts"]'
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_COMMAND_WORDS) return `${shape}, 1 to ${MAX_COMMAND_WORDS} of them`
  for (const word of command) {
    if (typeof word !== "string" || word.length === 0 || word.length > MAX_WORD) return `${shape}, each 1 to ${MAX_WORD} characters`
    if (terminalText(word) !== word) return "command has no control or invisible characters"
  }
  return undefined
}

/** Why a code bot's figures can't be approved, or undefined when they can. */
export function figuresProblem(f: { perTradeUsd: unknown; perDayUsd: unknown; maxOpen: unknown }): string | undefined {
  const usd = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_FIGURE_USD
  if (!usd(f.perTradeUsd)) return `perTradeUsd is the most one buy may spend, in USD, above 0 and at most ${MAX_FIGURE_USD}`
  if (!usd(f.perDayUsd)) return `perDayUsd is the most its buys may spend in a day, in USD, above 0 and at most ${MAX_FIGURE_USD}`
  if ((f.perDayUsd as number) < (f.perTradeUsd as number)) return "perDayUsd is at least perTradeUsd: a day holds at least one trade"
  if (!(typeof f.maxOpen === "number" && Number.isInteger(f.maxOpen) && f.maxOpen >= 1 && f.maxOpen <= MAX_OPEN)) return `maxOpen is how many positions it may hold at once, a whole number from 1 to ${MAX_OPEN}`
  return undefined
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const quote = (v: string) => JSON.stringify(v)
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
const WALLET = /^(embedded|[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/

/** Why a name can't name a bot, or undefined when it can: a trigger names a bot in quotes, and a view shows it in a row. */
export function botNameProblem(name: string): string | undefined {
  if (name.length === 0) return "a bot needs a name"
  if (name.length > 40) return "a bot's name is at most 40 characters"
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) return "a bot's name starts with a letter or digit, then letters, digits, spaces, dots, dashes and underscores"
  if (name.endsWith(" ")) return "a bot's name doesn't end with a space"
  return undefined
}

function lineOf(source: string, needle: string, from = 0): number {
  const at = source.indexOf(needle, from)
  return source.slice(0, at < 0 ? from : at).split("\n").length
}

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Where a bot's own table starts: `[bots."name"]` or `[bots.name]`. */
function tableAt(source: string, name: string): number {
  const m = new RegExp(`\\[\\s*bots\\s*\\.\\s*(${esc(quote(name))}|${esc(name)})\\s*\\]`).exec(source)
  return m ? m.index : Math.max(0, source.indexOf(name))
}

/** The line of `key = …` inside the table that starts at `from`, else the table's own line. */
function keyLine(source: string, key: string, from: number): number {
  const m = new RegExp(`^[ \\t]*${esc(key)}[ \\t]*=`, "m").exec(source.slice(from))
  return source.slice(0, m ? from + m.index : from).split("\n").length
}

/** Reads bots.toml. Never throws: every problem is named with its line, and that bot is left out. */
export function parseBotsFile(source: string, file = "bots.toml"): BotsFile {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    const words = ((error as Error).message ?? "").replace(/^TOML Parse error: /, "")
    return { bots: [], code: [], problems: [`${file} isn't valid TOML (${terminalText(words, { maxLength: 120 })}): no bots are read from it.`] }
  }
  const problems: string[] = []
  const at = (line: number, text: string) => problems.push(`${file} line ${line}: ${text}`)
  const top = isRecord(raw) ? raw : {}
  for (const key of Object.keys(top)) if (!TOP_KEYS.includes(key)) at(lineOf(source, key), `${quote(terminalText(key, { maxLength: 40 }))} isn't something this file holds (${TOP_KEYS.join(", ")})`)
  const bots: BotEntry[] = []
  const code: CodeBotEntry[] = []
  if (top.bots === undefined) return { bots, code, problems }
  if (!isRecord(top.bots)) {
    at(lineOf(source, "bots"), 'bots must be tables: [bots."<name>"], then agent, wallet, mode, state and its definition, or kind = "code" and its folder, command and figures')
    return { bots, code, problems }
  }
  for (const [name, value] of Object.entries(top.bots)) {
    const start = tableAt(source, name)
    const line = lineOf(source, "[", start)
    const shown = quote(terminalText(name, { maxLength: 40 }))
    const why = botNameProblem(name)
    if (why) {
      at(line, `${shown} can't name a bot: ${why}`)
      continue
    }
    if (!isRecord(value)) {
      at(line, `${shown} must be a table: [bots.${quote(name)}]`)
      continue
    }
    if (value.kind !== undefined && value.kind !== "code") {
      at(keyLine(source, "kind", start), `${shown} is left out: kind is "code" for a program of yours, or left out for a rules bot`)
      continue
    }
    const isCode = value.kind === "code"
    const known = isCode ? CODE_KEYS : RULES_KEYS
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue
      const word = quote(terminalText(key, { maxLength: 40 }))
      if (!isCode && (CODE_ONLY_KEYS as readonly string[]).includes(key)) at(keyLine(source, key, start), `${word} is a code bot's (kind = "code"), not a rules bot's`)
      else if (isCode && key === "definition") at(keyLine(source, key, start), `${word} is a rules bot's, not a code bot's (kind = "code")`)
      else at(keyLine(source, key, start), `${word} isn't something a bot holds (${known.join(", ")})`)
    }
    const bad: string[] = []
    if (typeof value.agent !== "string" || !AGENT_NAME.test(value.agent)) bad.push("agent names the agent it belongs to")
    if (typeof value.wallet !== "string" || !WALLET.test(value.wallet)) bad.push('wallet is "embedded" or the address of the wallet it pays from')
    if (value.mode !== "paper" && value.mode !== "live") bad.push('mode is "paper" or "live"')
    if (!(BOT_STATES as readonly unknown[]).includes(value.state)) bad.push('state is "on", "paused" or "stopped"')
    const bps = value.maxSlippageBps
    if (bps !== undefined && !(typeof bps === "number" && Number.isInteger(bps) && bps >= 0 && bps <= 10_000)) bad.push("maxSlippageBps is a whole number of basis points, from 0 to 10000")
    if (isCode) {
      for (const why of [folderProblem(value.folder), commandProblem(value.command), figuresProblem({ perTradeUsd: value.perTradeUsd, perDayUsd: value.perDayUsd, maxOpen: value.maxOpen })]) if (why) bad.push(why)
      if (bad.length) {
        at(line, `${shown} is left out: ${bad.join("; ")}`)
        continue
      }
      code.push({
        kind: "code",
        name,
        agent: value.agent as string,
        wallet: value.wallet as string,
        mode: value.mode as "paper" | "live",
        state: value.state as BotRunState,
        folder: value.folder as string,
        command: [...(value.command as string[])],
        perTradeUsd: value.perTradeUsd as number,
        perDayUsd: value.perDayUsd as number,
        maxOpen: value.maxOpen as number,
        ...(bps !== undefined ? { maxSlippageBps: bps as number } : {}),
      })
      continue
    }
    if (bad.length) {
      at(line, `${shown} is left out: ${bad.join("; ")}`)
      continue
    }
    if (value.definition === undefined) {
      at(line, `${shown} is left out: it has no definition ([bots.${quote(name)}.definition])`)
      continue
    }
    const read = readDefinition(value.definition)
    if (!read.ok) {
      at(lineOf(source, "definition", start), `${shown} is left out: its definition doesn't read (${terminalText(read.message, { maxLength: 160 })})`)
      continue
    }
    bots.push({
      name,
      agent: value.agent as string,
      wallet: value.wallet as string,
      mode: value.mode as "paper" | "live",
      state: value.state as BotRunState,
      ...(bps !== undefined ? { maxSlippageBps: bps as number } : {}),
      definition: read.definition,
    })
  }
  return { bots, code, problems }
}

// ---- Writing ----

const bareKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : quote(k))

class Unwritable extends Error {}

/** One value as TOML, inline: a table inside a list, or a list, is written on its line. */
function inline(v: unknown): string {
  if (typeof v === "string") return quote(v)
  if (typeof v === "boolean") return String(v)
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Unwritable(`${v} isn't a number TOML holds`)
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`
  if (isRecord(v)) {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${bareKey(k)} = ${inline(x)}`)
    return parts.length ? `{ ${parts.join(", ")} }` : "{}"
  }
  throw new Unwritable(`${v === null ? "null" : typeof v} isn't something TOML holds`)
}

/** A table and the tables inside it: its own values first, then each table inside, under its own heading. */
function tables(path: string, value: Record<string, unknown>): string {
  const own: string[] = []
  const inner: string[] = []
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue
    if (isRecord(v)) inner.push(tables(`${path}.${bareKey(k)}`, v))
    else own.push(`${bareKey(k)} = ${inline(v)}\n`)
  }
  return `\n[${path}]\n${own.join("")}${inner.join("")}`
}

/** Either kind of bot, as the file holds it. */
export type AnyBotEntry = BotEntry | CodeBotEntry
export const isCodeEntry = (b: AnyBotEntry): b is CodeBotEntry => (b as CodeBotEntry).kind === "code"

/** bots.toml as the Candle Harness writes it: the header, then each bot, in name order. */
export function serializeBotsFile(bots: readonly AnyBotEntry[]): string {
  const sorted = [...bots].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const out = sorted.map((b) => {
    const head = `bots.${bareKey(b.name)}`
    if (isCodeEntry(b)) {
      return (
        `\n[${head}]\nkind = "code"\nagent = ${quote(b.agent)}\nwallet = ${quote(b.wallet)}\nmode = ${quote(b.mode)}\nstate = ${quote(b.state)}\n` +
        `folder = ${quote(b.folder)}\ncommand = ${inline(b.command)}\nperTradeUsd = ${inline(b.perTradeUsd)}\nperDayUsd = ${inline(b.perDayUsd)}\nmaxOpen = ${inline(b.maxOpen)}\n` +
        `${b.maxSlippageBps !== undefined ? `maxSlippageBps = ${b.maxSlippageBps}\n` : ""}`
      )
    }
    const own = `\n[${head}]\nagent = ${quote(b.agent)}\nwallet = ${quote(b.wallet)}\nmode = ${quote(b.mode)}\nstate = ${quote(b.state)}\n${b.maxSlippageBps !== undefined ? `maxSlippageBps = ${b.maxSlippageBps}\n` : ""}`
    return own + tables(`${head}.definition`, b.definition as unknown as Record<string, unknown>)
  })
  return `${BOTS_HEADER}${out.join("")}`
}

/** The file on disk: read again whenever it changed, and written whole, never over a problem. */
export class BotsFileStore {
  private held: BotsFile = EMPTY
  private seen: string | undefined

  constructor(private readonly path: string) {}

  read(): BotsFile {
    let stamp: string
    try {
      const s = statSync(this.path)
      stamp = `${s.mtimeMs}:${s.size}:${s.ino}`
    } catch {
      this.seen = undefined
      this.held = EMPTY
      return this.held
    }
    if (stamp !== this.seen) {
      this.seen = stamp
      try {
        this.held = parseBotsFile(readFileSync(this.path, "utf8"))
      } catch (error) {
        this.held = { bots: [], code: [], problems: [`bots.toml couldn't be read: ${terminalText((error as Error).message, { maxLength: 120 })}`] }
      }
    }
    return this.held
  }

  /**
   * Sets (or, with undefined, removes) bots by name, writing the file whole. Refused, with the file untouched,
   * when it has a problem, or when a bot wouldn't read back exactly as it was given.
   */
  write(changes: Readonly<Record<string, AnyBotEntry | undefined>>): { ok: true } | { ok: false; message: string } {
    const now = this.read()
    if (now.problems.length) return { ok: false, message: `bots.toml has a problem (${now.problems[0]}): fix it before the Candle Harness writes it.` }
    const next = new Map<string, AnyBotEntry>([...now.bots, ...now.code].map((b) => [b.name, b]))
    for (const [name, entry] of Object.entries(changes)) {
      const was = next.get(name)
      // A name is one bot's: a rules bot never writes over a code bot of that name, or the other way.
      if (was && entry && isCodeEntry(was) !== isCodeEntry(entry)) return { ok: false, message: `A ${isCodeEntry(was) ? "code" : "rules"} bot is already named "${name}", so nothing changed.` }
      if (entry === undefined) next.delete(name)
      else next.set(name, entry)
    }
    let text: string
    try {
      text = serializeBotsFile([...next.values()])
    } catch (error) {
      if (error instanceof Unwritable) return { ok: false, message: `That bot can't be written to bots.toml (${error.message}), so nothing changed.` }
      throw error
    }
    const back = parseBotsFile(text)
    if (back.problems.length) return { ok: false, message: `That change can't be written to bots.toml (${back.problems[0]}), so nothing changed.` }
    for (const [name, entry] of Object.entries(changes)) {
      if (!entry) continue
      const got = (isCodeEntry(entry) ? back.code : back.bots).find((b) => b.name === name)
      if (!got || canonicalJson(got) !== canonicalJson(entry)) return { ok: false, message: `"${name}" wouldn't read back from bots.toml as it was given, so nothing changed.` }
    }
    const temp = `${this.path}.tmp`
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, this.path)
    this.seen = undefined
    this.read()
    return { ok: true }
  }
}
