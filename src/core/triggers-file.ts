// triggers.toml: each trigger beside config.toml, as the person can read it. The Candle Harness writes it whole when a
// trigger's card is approved, or one is switched or removed; nothing else writes it. Each entry keeps the line
// as written and approved, and its expansion (aliases expanded, names as mints), which is what fires.
//
//   [triggers."JUP < $0.40"]
//   agent = "agent-a"
//   line = "when JUP < $0.40 sell 50% of JUP"
//   expansion = "when <mint> < $0.40 sell 50% of <mint>"
//   on = true
//   again = false
//   cooldown = "30m"
//   mode = "live"
//
// A problem is named with its line and that entry is left out; a file with a problem is never written over
// (as wallets.toml), so a hand edit is never lost. A hand edit that reads isn't trusted for that: the core
// keeps the hash each trigger was approved as (triggers.ts), and one changed here is held until it's
// approved again. Switching one off here (on = false) is always taken.
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { keysIn } from "../config-settings"
import { fileStamp } from "../shared/file-stamp"
import { terminalText } from "../shared/terminal-text"
import { type ChainSlug, chainName, enabledChains, isAddressOn, maybeChain } from "../shared/chains"
import { classOf, durationText, MAX_COOLDOWN_MS, MIN_COOLDOWN_MS, parseTriggerShape, triggerNameProblem } from "../shared/trigger-grammar"

export const TRIGGERS_HEADER =
  "# candle-harness's triggers: \"when X, do Y\". The Candle Harness writes this file whole when you approve a trigger's card, or\n" +
  "# switch or remove one, so a comment of yours below this header won't survive that. Set on = false to switch\n" +
  "# one off. Any other change holds that trigger until its card is approved again: ask the agent.\n"

export interface TriggerEntry {
  name: string
  agent: string
  /** As written and approved, with its token names and aliases. */
  line: string
  /** What fires: aliases expanded, names as mints. */
  expansion: string
  on: boolean
  again: boolean
  cooldownMs?: number
  /**
   * Paper or live, as its card was approved: its trades go so whatever mode the Candle Harness is in when it fires.
   * Absent on one saved before triggers kept a mode; the core then takes the mode its approval was recorded in.
   */
  mode?: "paper" | "live"
  /** The chain of the token it watches, where that isn't Solana: set when its card is approved. */
  chain?: ChainSlug
}

export interface TriggersFile {
  triggers: TriggerEntry[]
  problems: string[]
}

const TOP_KEYS = keysIn("triggers.toml", "")
const ENTRY_KEYS = keysIn("triggers.toml", "triggers.<name>")
const EMPTY: TriggersFile = { triggers: [], problems: [] }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const quote = (v: string) => JSON.stringify(v)
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** The line of `key = …` inside the table that starts at `from`, else the table's own line. */
function keyLine(source: string, key: string, from: number): number {
  const m = new RegExp(`^[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*=`, "m").exec(source.slice(from))
  return source.slice(0, m ? from + m.index : from).split("\n").length
}

function lineOf(source: string, needle: string, from = 0): number {
  const at = source.indexOf(needle, from)
  return source.slice(0, at < 0 ? from : at).split("\n").length
}

/** Where a trigger's table starts: `[triggers."name"]` or `[triggers.name]`. */
function tableAt(source: string, name: string): number {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`\\[\\s*triggers\\s*\\.\\s*(${esc(quote(name))}|${esc(name)})\\s*\\]`).exec(source)
  return m ? m.index : Math.max(0, source.indexOf(name))
}

/** `30m`, `2h`, `1d` in ms, or undefined. */
function cooldownOf(text: string): number | undefined {
  const m = /^(\d+)(m|h|d)$/.exec(text)
  if (!m) return undefined
  const ms = Number(m[1]) * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000)
  return ms >= MIN_COOLDOWN_MS && ms <= MAX_COOLDOWN_MS ? ms : undefined
}

/** Reads triggers.toml. Never throws: every problem is named with its line, and that entry is left out. */
export function parseTriggersFile(source: string, file = "triggers.toml"): TriggersFile {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    const words = ((error as Error).message ?? "").replace(/^TOML Parse error: /, "")
    return { triggers: [], problems: [`${file} isn't valid TOML (${terminalText(words, { maxLength: 120 })}): no triggers are read from it.`] }
  }
  const problems: string[] = []
  const at = (line: number, text: string) => problems.push(`${file} line ${line}: ${text}`)
  const top = isRecord(raw) ? raw : {}
  for (const key of Object.keys(top)) if (!TOP_KEYS.includes(key)) at(lineOf(source, key), `${quote(terminalText(key, { maxLength: 40 }))} isn't something this file holds (${TOP_KEYS.join(", ")})`)
  const triggers: TriggerEntry[] = []
  if (top.triggers === undefined) return { triggers, problems }
  if (!isRecord(top.triggers)) {
    at(lineOf(source, "triggers"), 'triggers must be tables: [triggers."<name>"], then agent, line, expansion, on and again')
    return { triggers, problems }
  }
  for (const [name, value] of Object.entries(top.triggers)) {
    const start = tableAt(source, name)
    const line = lineOf(source, "[", start)
    const shown = quote(terminalText(name, { maxLength: 40 }))
    const why = triggerNameProblem(name)
    if (why) {
      at(line, `${shown} can't name a trigger: ${why}`)
      continue
    }
    if (!isRecord(value)) {
      at(line, `${shown} must be a table: [triggers.${quote(name)}]`)
      continue
    }
    const bad: string[] = []
    for (const key of Object.keys(value)) if (!ENTRY_KEYS.includes(key)) at(keyLine(source, key, start), `${quote(terminalText(key, { maxLength: 40 }))} isn't something a trigger holds (${ENTRY_KEYS.join(", ")})`)
    const text = (key: string) => (typeof value[key] === "string" && (value[key] as string).length <= 2000 ? (value[key] as string) : undefined)
    const agent = text("agent")
    if (agent === undefined || !AGENT_NAME.test(agent)) bad.push("agent names the agent it belongs to")
    const typed = text("line")
    const expansion = text("expansion")
    if (typed === undefined || expansion === undefined) bad.push("line and expansion are its line as written and as expanded")
    if (typeof value.on !== "boolean") bad.push("on is true or false")
    if (value.again !== undefined && typeof value.again !== "boolean") bad.push("again is true or false")
    let cooldownMs: number | undefined
    if (value.cooldown !== undefined) {
      cooldownMs = typeof value.cooldown === "string" ? cooldownOf(value.cooldown) : undefined
      if (cooldownMs === undefined) bad.push('cooldown is from "1m" to "30d", such as "30m" or "2h"')
    }
    if (value.mode !== undefined && value.mode !== "paper" && value.mode !== "live") bad.push('mode is "paper" or "live"')
    const chain = value.chain === undefined ? undefined : maybeChain(value.chain)
    if (value.chain !== undefined && !chain) bad.push(`chain is ${enabledChains().map((c) => `"${c.slug}"`).join(" or ")}`)
    if (bad.length) {
      at(line, `${shown} is left out: ${bad.join("; ")}`)
      continue
    }
    const again = value.again === true
    const shapes = [parseTriggerShape(typed!), parseTriggerShape(expansion!)]
    const unread = shapes.find((s) => !s.ok)
    if (unread && !unread.ok) {
      at(line, `${shown} is left out: its ${unread === shapes[0] ? "line" : "expansion"} doesn't read (${terminalText(unread.message, { maxLength: 120 })})`)
      continue
    }
    const [one, two] = shapes.map((s) => (s.ok ? s.value : undefined))
    if (one!.again || two!.again || one!.cooldownMs !== undefined || two!.cooldownMs !== undefined || one!.name !== undefined || two!.name !== undefined) {
      at(line, `${shown} is left out: again, cooldown and the name are keys of their own, not part of its line`)
      continue
    }
    const cls = classOf(two!.when)
    if (cls !== classOf(one!.when)) {
      at(line, `${shown} is left out: its line and its expansion wait for different things`)
      continue
    }
    if (again && cls !== "level") {
      at(keyLine(source, "again", start), `${shown} is left out: again is for a level`)
      continue
    }
    if (cooldownMs !== undefined && (cls === "schedule" || (cls === "level" && !again))) {
      at(keyLine(source, "cooldown", start), `${shown} is left out: ${cls === "schedule" ? "a schedule runs at its times" : "a level without again fires once"}, so a cooldown has nothing to space`)
      continue
    }
    if (chain) {
      const when = two!.when
      const token = "token" in when ? when.token : undefined
      if (token === undefined) {
        at(keyLine(source, "chain", start), `${shown} is left out: chain is for a trigger on a token`)
        continue
      }
      if (!isAddressOn(chain, token)) {
        at(keyLine(source, "chain", start), `${shown} is left out: its token's address can't be on ${chainName(chain.slug)}`)
        continue
      }
    }
    triggers.push({ name, agent: agent!, line: typed!, expansion: expansion!, on: value.on as boolean, again, ...(cooldownMs !== undefined ? { cooldownMs } : {}), ...(value.mode !== undefined ? { mode: value.mode as "paper" | "live" } : {}), ...(chain ? { chain: chain.slug } : {}) })
  }
  return { triggers, problems }
}

/** triggers.toml as the Candle Harness writes it: the header, then each trigger, in name order. */
export function serializeTriggersFile(triggers: readonly TriggerEntry[]): string {
  const sorted = [...triggers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const tables = sorted.map(
    (t) =>
      `\n[triggers.${quote(t.name)}]\nagent = ${quote(t.agent)}\nline = ${quote(t.line)}\nexpansion = ${quote(t.expansion)}\non = ${t.on}\nagain = ${t.again}\n${t.cooldownMs !== undefined ? `cooldown = ${quote(durationText(t.cooldownMs))}\n` : ""}${t.mode !== undefined ? `mode = ${quote(t.mode)}\n` : ""}${t.chain !== undefined ? `chain = ${quote(t.chain)}\n` : ""}`,
  )
  return `${TRIGGERS_HEADER}${tables.join("")}`
}

/** The file on disk: read again whenever it changed, and written whole, never over a problem. */
export class TriggersFileStore {
  private held: TriggersFile = EMPTY
  private seen: string | undefined

  constructor(private readonly path: string) {}

  read(): TriggersFile {
    const at = fileStamp(this.path)
    if (!at) {
      this.seen = undefined
      this.held = EMPTY
      return this.held
    }
    if (at.stamp !== this.seen || at.recent) {
      this.seen = at.stamp
      try {
        this.held = parseTriggersFile(readFileSync(this.path, "utf8"))
      } catch (error) {
        this.held = { triggers: [], problems: [`triggers.toml couldn't be read: ${terminalText((error as Error).message, { maxLength: 120 })}`] }
      }
    }
    return this.held
  }

  /**
   * Sets (or, with undefined, removes) triggers by name, writing the file whole. Refused, with the file
   * untouched, when it has a problem: the person's hand edit is never written over.
   */
  write(changes: Readonly<Record<string, TriggerEntry | undefined>>): { ok: true } | { ok: false; message: string } {
    const now = this.read()
    if (now.problems.length) return { ok: false, message: `triggers.toml has a problem (${now.problems[0]}): fix it before the Candle Harness writes it.` }
    const next = new Map(now.triggers.map((t) => [t.name, t]))
    for (const [name, entry] of Object.entries(changes)) {
      if (entry === undefined) next.delete(name)
      else next.set(name, entry)
    }
    const text = serializeTriggersFile([...next.values()])
    const back = parseTriggersFile(text)
    if (back.problems.length) return { ok: false, message: `That change can't be written to triggers.toml (${back.problems[0]}), so nothing changed.` }
    const temp = `${this.path}.tmp`
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, this.path)
    this.seen = undefined
    this.read()
    return { ok: true }
  }
}
