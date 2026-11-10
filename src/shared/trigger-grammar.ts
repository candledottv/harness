// A trigger's line: "when X, do Y", in one exact grammar that the agent writes, the trigger's card shows,
// triggers.toml keeps, and the core checks when it's saved and again when it fires. Shared, so the card and
// the core read a line by one rule.
//
//   when <condition> [then] <action>      a level, Hacc's tape, or your personal signals
//   every <schedule> [then] <action>      in this machine's local time
//   at <HH:MM> [then] <action>            once, at the next HH:MM on this machine's clock, then switches off
//   on <event> [then] <action>            a fill, a card expiring, a replay ending, a bot's entry, exit or pause,
//                                         a code bot's own word (on bot "grid" says "needs-a-look"), or a call from outside
//
// then, at the end, in any order: `again` (a level re-arms each time it's crossed back), `cooldown 2h`, and
// `as "<name>"`.
//
// Conditions: `JUP < $0.40`, `JUP > $1`, `JUP mcap < 500k`, `JUP down 20%` and `JUP up 50%` (from the entry),
// `pnl today < -$20` (your P&L over a window of its own: `24h`, `today`, `session` or a time of day such as `18:00`;
// with none, the window showing when it's proposed), a Hacc pattern with filters (`confluence mcap < 500k age < 60m`,
// `kol_mention group smart_money chain solana`), `mine` or `mine "<rule>"`.
// Schedules: `day 09:00`, `weekday 09:00`, `monday 09:00`, `4h`, `30m`. Events: `fill`, `fill of JUP`,
// `card expired`, `replay ended`, `call`.
// Actions: a trade, sell or swap, or a chain or alias of them, as the input line reads it; `notify` or
// `notify "<words>"`; `wake <agent>` or `wake <agent> "<what to look at>"`. In a tape trigger or one on your
// personal signals, `it` is the token that fired: `when new_ticker mcap < 200k buy $2 of it`.
//
// A line is read in two steps. `parseTriggerShape` needs nothing but the line: what kind of trigger it is and
// where its action starts, with token words as written. `resolveTrigger` reads it against the input line's
// context: token names to mints, the action through the input line's own parser (aliases and chains
// included), and the agent it trades as. Its `expansion` is the line with aliases expanded and names resolved,
// which means at firing what it meant when saved: it reads again with no names and no aliases.
import { PATTERNS } from "../core/hacc-tools"
import { short } from "../core/wallet-names"
import { type Command, type CommandContext, parseCommand, tokenOf } from "./commands"

/** What every place a trigger shows says on Free, and the command that upgrades the plan. */
export const PLAN_WORDS = "Triggers need a Pro or Max plan"
export const PLAN_FIX = "candle plan buy"

export const TRIGGER_LEADS = ["when", "every", "at", "on"] as const
export type TriggerLead = (typeof TRIGGER_LEADS)[number]

/** Between two firings of the same trigger (and token), unless the line says otherwise. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000
export const MIN_COOLDOWN_MS = 60_000
export const MAX_COOLDOWN_MS = 30 * 24 * 3_600_000
/** The shortest `every` interval: the cooldown's floor. */
export const MIN_INTERVAL_MS = 60_000
export const MAX_NAME = 40
const MAX_WORDS = 200

/**
 * What `it` stands for while a line is read: an address-shaped word the input line's parser takes as a mint.
 * It never leaves this module: an expansion says `it`, and the firing names the token.
 */
export const IT_MINT = "ittokenThatFiredTheTrigger11111111111111111"

export type Op = "<" | ">"

export interface TapeFilters {
  minMcapUsd?: number
  maxMcapUsd?: number
  minAgeMinutes?: number
  maxAgeMinutes?: number
  group?: string
  chain?: "solana" | "hood"
}

/**
 * The window a P&L trigger's figure runs over, as the P&L window names it: the last 24 hours, since midnight, since
 * the Candle Harness was last closed, or since a time of day ("18:00"). Kept in the trigger's own line, so what the
 * P&L tab shows never changes what the trigger waits for.
 */
export type PnlWindowName = string

/** A window as a trigger's line writes it (`24h`, `today`, `session`, `18:00`), by the P&L window's own name. */
export function pnlWindowOf(word: string | undefined): PnlWindowName | undefined {
  const w = word?.toLowerCase()
  if (w === "24h" || w === "session") return w
  if (w === "today" || w === "midnight") return "midnight"
  const m = /^(\d{1,2}):(\d{2})$/.exec(w ?? "")
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]!.padStart(2, "0")}:${m[2]}` : undefined
}

/** The window as the line writes it. */
const pnlWindowText = (window: PnlWindowName): string => (window === "midnight" ? "today" : window)

/** The window in words, after "your P&L". */
export function pnlWindowWords(window: PnlWindowName): string {
  if (window === "24h") return "over the last 24 hours"
  if (window === "midnight") return "since midnight"
  if (window === "session") return "since the Candle Harness was last closed"
  return `since ${window}`
}

/** What a trigger waits for. A token is a mint once resolved; in a shape, the word as written. */
export type TriggerWhen =
  | { kind: "price"; token: string; op: Op; usd: number; figure: string }
  | { kind: "mcap"; token: string; op: Op; usd: number; figure: string }
  | { kind: "entry"; token: string; dir: "down" | "up"; percent: number }
  | { kind: "pnl"; op: Op; usd: number; figure: string; window?: PnlWindowName }
  | { kind: "tape"; pattern: string; filters: TapeFilters }
  | { kind: "mine"; rule?: string }
  | { kind: "schedule"; every: { kind: "days"; days: number[]; at: string; words: string } | { kind: "interval"; ms: number; text: string } | { kind: "once"; at: string } }
  | { kind: "event"; event: "fill" | "card-expired" | "replay-ended" | "call"; token?: string }
  | { kind: "event"; event: "bot"; bot: string; what: BotEvent; word?: string }

/**
 * What a bot did that a trigger waits on: a position's buy filled, its sell filled, or it was paused; or a code bot
 * said its own word (`bot.event`), kept as `word`.
 */
export const BOT_EVENTS = ["entered", "exited", "paused", "says"] as const
/** A code bot's own word: lowercase letters, digits and dashes, up to 24, starting with a letter or digit. */
export const BOT_WORD = /^[a-z0-9][a-z0-9-]{0,23}$/
/** Unquoted after `says`, these start the action, not a bot's word: `on bot "grid" says notify` names no word. */
const ACTION_WORDS: ReadonlySet<string> = new Set(["notify", "wake", "then"])
export type BotEvent = (typeof BOT_EVENTS)[number]

export type TriggerDo = { kind: "command"; text: string } | { kind: "notify"; words?: string } | { kind: "wake"; agent: string; words?: string }

/** Levels fire once (or `again`), the tape and personal signals once per token per cooldown, the rest each time. */
export type TriggerClass = "level" | "tape" | "mine" | "schedule" | "event"

export interface TriggerShape {
  lead: TriggerLead
  when: TriggerWhen
  do: TriggerDo
  again: boolean
  cooldownMs?: number
  name?: string
  /** The line less its `again`, `cooldown` and `as "<name>"`: triggers.toml's `line`. */
  body: string
  /** The condition as written, after `when` (with `every` or `on` kept): the name when the line gives none. */
  conditionText: string
}

export type Read<T> = { ok: true; value: T } | { ok: false; message: string }

const no = (message: string): { ok: false; message: string } => ({ ok: false, message })

/** A schedule that runs once, at its time, then switches off. */
export const isOnce = (when: TriggerWhen): boolean => when.kind === "schedule" && when.every.kind === "once"

export function classOf(when: TriggerWhen): TriggerClass {
  switch (when.kind) {
    case "price":
    case "mcap":
    case "entry":
    case "pnl":
      return "level"
    case "tape":
      return "tape"
    case "mine":
      return "mine"
    case "schedule":
      return "schedule"
    case "event":
      return "event"
  }
}

/** Whether a line starts the way a trigger does: `when`, `every` or `on`, then more. */
export function startsLikeTrigger(line: string): boolean {
  const words = line.trim().split(/\s+/)
  return words.length > 1 && (TRIGGER_LEADS as readonly string[]).includes(words[0]!.toLowerCase())
}

interface Token {
  text: string
  quoted: boolean
}

/** The line's words, a double-quoted run as one. */
function tokenize(line: string): Read<Token[]> {
  const out: Token[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (const m of line.matchAll(re)) {
    if (m[1] !== undefined) out.push({ text: m[1], quoted: true })
    else if (m[2]!.includes('"')) return no(`A quote isn't closed: words in quotes start and end with ".`)
    else out.push({ text: m[2]!, quoted: false })
  }
  return { ok: true, value: out }
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 }

/** `$0.40`, `500k`, `$2m`, `-$20`: a dollar figure. `$` is needed where `dollar` says so. */
function figure(word: string, opts: { dollar: boolean; negative?: boolean }): number | undefined {
  const m = /^(-)?(\$)?(-)?(\d+(?:\.\d+)?|\.\d+)([kmb])?$/i.exec(word)
  if (!m) return undefined
  if (opts.dollar && !m[2]) return undefined
  const negative = Boolean(m[1] || m[3])
  if (negative && !opts.negative) return undefined
  const n = Number(m[4]) * (m[5] ? SUFFIX[m[5].toLowerCase()]! : 1)
  return Number.isFinite(n) ? (negative ? -n : n) : undefined
}

const DURATION = /^(\d+)(m|min|mins|h|d)$/i
/** `30m`, `2h`, `1d`, in ms. */
function duration(word: string): number | undefined {
  const m = DURATION.exec(word)
  if (!m) return undefined
  const unit = m[2]!.toLowerCase()
  return Number(m[1]) * (unit.startsWith("m") ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000)
}

/** A duration in words: "30 minutes", "2 hours", "1 day". */
export function durationWords(ms: number): string {
  const unit = ms % 86_400_000 === 0 ? ["day", 86_400_000] : ms % 3_600_000 === 0 ? ["hour", 3_600_000] : ["minute", 60_000]
  const n = Math.round(ms / (unit[1] as number))
  return `${n} ${unit[0]}${n === 1 ? "" : "s"}`
}

/** A duration as the grammar writes it: `30m`, `2h`, `1d`. */
export function durationText(ms: number): string {
  return ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
/** monday, mon, mondays. */
function dayOf(word: string): number | undefined {
  const w = word.toLowerCase().replace(/s$/, "")
  const i = DAYS.findIndex((d) => d === w || (w.length >= 3 && d.startsWith(w) && w.length <= 3))
  return i < 0 ? undefined : i
}
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

const OPS = new Set(["<", ">"])
const opOf = (word: string | undefined): Op | undefined => (word && OPS.has(word) ? (word as Op) : undefined)
const opWords = (op: Op) => (op === "<" ? "falls below" : "rises above")

const LEVEL_SHAPES = "JUP < $0.40, JUP > $1, JUP mcap < 500k, JUP down 20% or JUP up 50%"

/** Compact dollars: $500K, $1.5M, $0.40, -$20. */
export function dollarWords(n: number): string {
  const sign = n < 0 ? "-" : ""
  const a = Math.abs(n)
  if (a >= 1e9) return `${sign}$${trim(a / 1e9)}B`
  if (a >= 1e6) return `${sign}$${trim(a / 1e6)}M`
  if (a >= 1e4) return `${sign}$${trim(a / 1e3)}K`
  return `${sign}$${a >= 1 ? a.toFixed(a % 1 === 0 ? 0 : 2) : cents(a)}`
}
/** Under a dollar: at least two decimals, and as many more as the figure has (0.40, 0.0042). */
function cents(a: number): string {
  const s = a.toFixed(8).replace(/0+$/, "")
  const [whole, frac = ""] = s.split(".")
  return `${whole}.${frac.padEnd(2, "0")}`
}
const trim = (n: number) => String(Number(n.toFixed(2)))

/**
 * Reads a trigger's line for its shape, with nothing but the line: what it waits for, what it does, and its
 * `again`, cooldown and name. Token words stay as written; `resolveTrigger` reads them.
 */
export function parseTriggerShape(input: string): Read<TriggerShape> {
  const line = input.trim().replace(/\s+/g, " ")
  const tokens = tokenize(line)
  if (!tokens.ok) return tokens
  const t = tokens.value
  const lead = t[0]?.text.toLowerCase()
  if (!lead || t[0]!.quoted || !(TRIGGER_LEADS as readonly string[]).includes(lead)) return no("A trigger starts with when, every, at or on.")

  // The tail, in any order: as "<name>", again, cooldown <duration>.
  let end = t.length
  let name: string | undefined
  let again = false
  let cooldownMs: number | undefined
  for (let i = 0; i < 3 && end > 2; i++) {
    const last = t[end - 1]!
    const before = t[end - 2]!
    if (last.quoted && !before.quoted && before.text.toLowerCase() === "as" && name === undefined) {
      const why = triggerNameProblem(last.text)
      if (why) return no(`"${last.text}" can't name a trigger: ${why}`)
      name = last.text
      end -= 2
    } else if (!last.quoted && last.text.toLowerCase() === "again" && !again) {
      again = true
      end -= 1
    } else if (!before.quoted && before.text.toLowerCase() === "cooldown" && cooldownMs === undefined) {
      const ms = duration(last.text)
      if (ms === undefined) return no(`A cooldown is minutes, hours or days: cooldown 30m, cooldown 2h, cooldown 1d.`)
      if (ms < MIN_COOLDOWN_MS || ms > MAX_COOLDOWN_MS) return no(`A cooldown is from a minute to 30 days.`)
      cooldownMs = ms
      end -= 2
    } else break
  }
  const body = t.slice(1, end)
  const when = condition(lead as TriggerLead, body)
  if (!when.ok) return when
  let at = when.value.used
  if (body[at] && !body[at]!.quoted && body[at]!.text.toLowerCase() === "then") at++
  const action = actionOf(body.slice(at))
  if (!action.ok) return action
  const w = when.value.when
  const cls = classOf(w)
  if (again && cls !== "level") return no(`again is for a level, which otherwise fires once: ${cls === "schedule" ? "a schedule runs at each of its times" : "this one fires each time already, with its cooldown"}.`)
  if (cooldownMs !== undefined && cls === "schedule") return no("A schedule runs at each of its times, so a cooldown has nothing to space. Leave it out.")
  if (cooldownMs !== undefined && cls === "level" && !again) return no("A level fires once and switches off, so a cooldown has nothing to space. Add again to re-arm it each time it's crossed back.")
  const words = (from: number, to: number) => t.slice(from, to).map((x) => (x.quoted ? `"${x.text}"` : x.text)).join(" ")
  const conditionText = lead === "when" ? words(1, 1 + when.value.used) : words(0, 1 + when.value.used)
  return {
    ok: true,
    value: {
      lead: lead as TriggerLead,
      when: w,
      do: action.value,
      again,
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
      ...(name !== undefined ? { name } : {}),
      body: words(0, end),
      conditionText,
    },
  }
}

/** Why a name can't name a trigger, or undefined. */
export function triggerNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "it's empty"
  if (name !== name.trim()) return "it has a space at one end"
  if (name.length > MAX_NAME) return `it's longer than ${MAX_NAME} characters`
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is what's refused
  if (/["\\\u0000-\u001f\u007f]/.test(name)) return "it holds a quote, a backslash or a control character"
  return undefined
}

function condition(lead: TriggerLead, t: Token[]): Read<{ when: TriggerWhen; used: number }> {
  const w = (i: number) => (t[i] && !t[i]!.quoted ? t[i]!.text : undefined)
  const lw = (i: number) => w(i)?.toLowerCase()
  if (t.length === 0) return no(`Say what it ${lead === "every" ? "runs on" : "waits for"}, then what it does.`)

  if (lead === "at") {
    const time = w(0)
    const m = time ? TIME.exec(time) : null
    if (!m) return no("Give the time as hours and minutes, on a 24-hour clock: at 09:00. It runs once, at the next 09:00 on this machine's clock.")
    return { ok: true, value: { when: { kind: "schedule", every: { kind: "once", at: `${m[1]!.padStart(2, "0")}:${m[2]}` } }, used: 1 } }
  }

  if (lead === "every") {
    const first = lw(0)
    const interval = first ? duration(first) : undefined
    if (interval !== undefined) {
      if (interval < MIN_INTERVAL_MS) return no("A schedule runs at most once a minute.")
      return { ok: true, value: { when: { kind: "schedule", every: { kind: "interval", ms: interval, text: durationText(interval) } }, used: 1 } }
    }
    let days: number[] | undefined
    let words = ""
    if (first === "day") {
      days = [0, 1, 2, 3, 4, 5, 6]
      words = "every day"
    } else if (first === "weekday") {
      days = [1, 2, 3, 4, 5]
      words = "every weekday"
    } else if (first !== undefined && dayOf(first) !== undefined) {
      days = [dayOf(first)!]
      words = `every ${DAY_NAMES[days[0]!]}`
    }
    if (!days) return no("A schedule is day, weekday or a day's name with a time (every day 09:00, every monday 09:00), or an interval (every 4h, every 30m).")
    let i = 1
    if (lw(i) === "at") i++
    const time = w(i)
    const m = time ? TIME.exec(time) : null
    if (!m) return no(`Give the time as hours and minutes, on a 24-hour clock: every ${first} 09:00.`)
    const at = `${m[1]!.padStart(2, "0")}:${m[2]}`
    return { ok: true, value: { when: { kind: "schedule", every: { kind: "days", days, at, words } }, used: i + 1 } }
  }

  if (lead === "on") {
    const first = lw(0)
    if (first === "fill") {
      if (lw(1) === "of") {
        const token = w(2)
        if (!token) return no("on fill of names a token: on fill of JUP.")
        return { ok: true, value: { when: { kind: "event", event: "fill", token: token.replace(/^\$/, "") }, used: 3 } }
      }
      return { ok: true, value: { when: { kind: "event", event: "fill" }, used: 1 } }
    }
    if (first === "card" && lw(1) === "expired") return { ok: true, value: { when: { kind: "event", event: "card-expired" }, used: 2 } }
    if (first === "replay" && lw(1) === "ended") return { ok: true, value: { when: { kind: "event", event: "replay-ended" }, used: 2 } }
    if (first === "call") return { ok: true, value: { when: { kind: "event", event: "call" }, used: 1 } }
    if (first === "bot") {
      const name = t[1]?.quoted ? t[1].text : undefined
      if (name === undefined || name.trim() === "" || name.length > 40) return no('on bot names a rules bot in quotes, then entered, exited or paused: on bot "momentum" exited.')
      const what = lw(2)
      if (!what || !(BOT_EVENTS as readonly string[]).includes(what)) return no(`on bot "${name}" then entered (a position bought), exited (a position sold), paused, or says "<word>" (a code bot's own word).`)
      if (what === "says") {
        const said = t[3]?.quoted ? t[3].text : w(3)
        if (said === undefined || said === "" || (!t[3]?.quoted && ACTION_WORDS.has(said.toLowerCase()))) return no(`says names the code bot's word in quotes: on bot "${name}" says "needs-a-look".`)
        const word = said.toLowerCase()
        if (!BOT_WORD.test(word)) return no(`"${said}" isn't a bot's word: one lowercase word of letters, digits and dashes, up to 24, as the bot sends it.`)
        return { ok: true, value: { when: { kind: "event", event: "bot", bot: name, what: "says", word }, used: 4 } }
      }
      return { ok: true, value: { when: { kind: "event", event: "bot", bot: name, what: what as BotEvent }, used: 3 } }
    }
    return no('An event is fill, fill of a token, card expired, replay ended, a bot\'s entry, exit or pause, a code bot\'s word, or call: on fill of JUP, on bot "momentum" exited, on bot "grid" says "needs-a-look", on call.')
  }

  // when …
  const first = w(0)
  if (!first) return no("Say what it waits for: a level, a Hacc pattern, or mine.")
  const lower = first.toLowerCase()
  if (lower === "mine") {
    if (t[1]?.quoted) {
      if (t[1].text.trim() === "" || t[1].text.length > 64) return no("A rule's name in quotes, up to 64 characters: mine \"whales\".")
      return { ok: true, value: { when: { kind: "mine", rule: t[1].text }, used: 2 } }
    }
    return { ok: true, value: { when: { kind: "mine" }, used: 1 } }
  }
  if ((PATTERNS as readonly string[]).includes(lower)) return tape(lower, t)
  if (lower === "pnl") {
    // Its own window, where the line names one: the figure it waits on is then the same whatever the P&L tab shows.
    const window = opOf(w(1)) ? undefined : pnlWindowOf(w(1))
    const at = window !== undefined ? 2 : 1
    const op = opOf(w(at))
    const fig = w(at + 1)
    const usd = fig ? figure(fig, { dollar: true, negative: true }) : undefined
    if (!op || usd === undefined) return no("P&L is pnl < -$20 or pnl > $50, in dollars, with its window before the level where you name one: pnl today < -$20 (24h, today, session, or a time of day such as 18:00).")
    return { ok: true, value: { when: { kind: "pnl", op, usd, figure: fig!, ...(window !== undefined ? { window } : {}) }, used: at + 2 } }
  }
  const token = first.replace(/^\$/, "")
  const second = lw(1)
  if (second === "mcap") {
    const op = opOf(w(2))
    const fig = w(3)
    const usd = fig ? figure(fig, { dollar: false }) : undefined
    if (!op || usd === undefined || usd <= 0) return no(`A market cap is ${token} mcap < 500k or ${token} mcap > 2m.`)
    return { ok: true, value: { when: { kind: "mcap", token, op, usd, figure: fig! }, used: 4 } }
  }
  if (second === "down" || second === "up") {
    const m = /^(\d+(?:\.\d+)?)%$/.exec(w(2) ?? "")
    const percent = m ? Number(m[1]) : NaN
    if (!(percent > 0) || (second === "down" && percent >= 100) || percent > 10_000) return no(`From the entry is ${token} down 20% (under 100%) or ${token} up 50%.`)
    return { ok: true, value: { when: { kind: "entry", token, dir: second, percent }, used: 3 } }
  }
  const op = opOf(w(1))
  if (op) {
    const fig = w(2)
    const usd = fig ? figure(fig, { dollar: true }) : undefined
    if (usd === undefined || usd <= 0) return no(`A price is in dollars: ${token} ${op} $0.40.`)
    return { ok: true, value: { when: { kind: "price", token, op, usd, figure: fig! }, used: 3 } }
  }
  if (second === "<=" || second === ">=" || second === "below" || second === "above") return no(`Use < or >: ${token} < $0.40.`)
  return no(`A level is ${LEVEL_SHAPES}; a Hacc pattern is one of ${PATTERNS.join(", ")}; or mine, for your personal signals.`)
}

function tape(pattern: string, t: Token[]): Read<{ when: TriggerWhen; used: number }> {
  const filters: TapeFilters = {}
  let i = 1
  const w = (k: number) => (t[k] && !t[k]!.quoted ? t[k]!.text : undefined)
  for (;;) {
    const key = w(i)?.toLowerCase()
    if (key === "mcap" || key === "age") {
      const op = opOf(w(i + 1))
      const v = w(i + 2)
      if (!op || !v) return no(`A filter is mcap < 500k, mcap > 50k, age < 60m or age > 10m.`)
      if (key === "mcap") {
        const usd = figure(v, { dollar: false })
        if (usd === undefined || usd <= 0) return no(`A market cap filter is mcap < 500k or mcap > 50k.`)
        const slot = op === "<" ? "maxMcapUsd" : "minMcapUsd"
        if (filters[slot] !== undefined) return no(`mcap ${op} is given twice.`)
        filters[slot] = usd
      } else {
        const ms = duration(v)
        if (ms === undefined) return no(`An age filter is minutes, hours or days: age < 60m.`)
        const slot = op === "<" ? "maxAgeMinutes" : "minAgeMinutes"
        if (filters[slot] !== undefined) return no(`age ${op} is given twice.`)
        filters[slot] = ms / 60_000
      }
      i += 3
    } else if (key === "group") {
      const g = w(i + 1)
      if (!g || filters.group !== undefined) return no("A group filter names one Hacc group: group smart_money.")
      filters.group = g
      i += 2
    } else if (key === "chain") {
      const c = w(i + 1)?.toLowerCase()
      if ((c !== "solana" && c !== "hood") || filters.chain !== undefined) return no("A chain filter is chain solana or chain hood.")
      filters.chain = c
      i += 2
    } else break
  }
  if (filters.minMcapUsd !== undefined && filters.maxMcapUsd !== undefined && filters.minMcapUsd >= filters.maxMcapUsd) return no("The market cap filters leave nothing between them.")
  if (filters.minAgeMinutes !== undefined && filters.maxAgeMinutes !== undefined && filters.minAgeMinutes >= filters.maxAgeMinutes) return no("The age filters leave nothing between them.")
  return { ok: true, value: { when: { kind: "tape", pattern, filters }, used: i } }
}

function actionOf(t: Token[]): Read<TriggerDo> {
  if (t.length === 0) return no("Say what it does: a trade, notify, or wake <agent>.")
  const first = t[0]!.quoted ? undefined : t[0]!.text.toLowerCase()
  if (first === "notify") {
    if (t.length === 1) return { ok: true, value: { kind: "notify" } }
    if (t.length === 2 && t[1]!.quoted) return wordsOk(t[1]!.text) ?? { ok: true, value: { kind: "notify", words: t[1]!.text } }
    return no('notify takes its words in quotes: notify "JUP is under 40 cents".')
  }
  if (first === "wake") {
    const agent = t[1] && !t[1].quoted ? t[1].text : undefined
    if (!agent) return no("wake names the agent to wake, by its name: wake <agent>.")
    if (t.length === 2) return { ok: true, value: { kind: "wake", agent } }
    if (t.length === 3 && t[2]!.quoted) return wordsOk(t[2]!.text) ?? { ok: true, value: { kind: "wake", agent, words: t[2]!.text } }
    return no(`wake takes what to look at in quotes: wake ${agent} "check the new ticker".`)
  }
  if (t.some((x) => x.quoted)) return no("A trade's words aren't in quotes. Quotes are for notify's words, wake's words and the trigger's name.")
  return { ok: true, value: { kind: "command", text: t.map((x) => x.text).join(" ") } }
}

function wordsOk(words: string): { ok: false; message: string } | undefined {
  if (words.trim() === "") return no("The words in quotes are empty.")
  if (words.length > MAX_WORDS) return no(`The words in quotes are longer than ${MAX_WORDS} characters.`)
  return undefined
}

// --- Reading a line against the input line's context ---

export interface ResolvedTrigger {
  shape: TriggerShape
  name: string
  /** The agent whose key trades and whose limits hold: the line's `as <agent>`, else the one proposing it. */
  agent: string
  /** The body, aliases expanded and names resolved: what triggers.toml keeps as `expansion`. */
  expansion: string
  /** What it waits for, with mints. */
  when: TriggerWhen
  /** A command's parsed form (a trade, or a chain of them; `it` as IT_MINT), notify or wake. */
  action: { kind: "command"; command: Extract<Command, { kind: "trade" } | { kind: "chain" }> } | { kind: "notify"; words?: string } | { kind: "wake"; agent: string; words?: string }
  class: TriggerClass
  again: boolean
  /** The cooldown in force: the line's, else the default where one applies. */
  cooldownMs?: number
  /** The trigger in words: "When JUP's price falls below $0.40, sell 50% of JUP. Fires once, then switches off." */
  words: string
}

export interface TriggerContext extends CommandContext {
  /** The agent proposing it: whose trigger it is unless the line names another with `as <agent>`. */
  proposer: string
  /** The window a P&L trigger takes when its line names none: the one showing now, written into its expansion. */
  pnlWindow?: PnlWindowName
}

/** Reads a whole trigger line against the context: its shape, its tokens, and its action as the input line reads it. */
export function resolveTrigger(line: string, ctx: TriggerContext): Read<ResolvedTrigger> {
  const shaped = parseTriggerShape(line)
  if (!shaped.ok) return shaped
  const shape = shaped.value
  const cls = classOf(shape.when)
  const none = ctx.knownTokens.size === 0 ? " The core knows no token names yet: it learns them from what a view shows, so name the token by its mint." : ""
  const mintOf = (word: string): Read<string> => {
    if (word.toLowerCase() === "it") return no("it means the token that fired, so it's for an action, in a tape trigger or one on your personal signals.")
    const r = tokenOf(word, ctx)
    return "mint" in r ? { ok: true, value: r.mint } : no(`${r.refused}${none}`)
  }
  let when = shape.when
  if ("token" in when && when.token !== undefined) {
    const m = mintOf(when.token)
    if (!m.ok) return m
    when = { ...when, token: m.value }
  }
  // A P&L level with no window of its own takes the one showing now, for good: it's in the expansion from here on.
  if (when.kind === "pnl" && when.window === undefined && ctx.pnlWindow !== undefined) when = { ...when, window: ctx.pnlWindow }
  if (!ctx.agents.includes(ctx.proposer)) return no(`No agent named ${ctx.proposer}. Agents: ${ctx.agents.join(", ")}.`)

  let action: ResolvedTrigger["action"]
  let agent = ctx.proposer
  let actionText: string
  const d = shape.do
  if (d.kind === "notify") {
    action = d
    actionText = d.words !== undefined ? `notify "${d.words}"` : "notify"
  } else if (d.kind === "wake") {
    if (!ctx.agents.includes(d.agent)) return no(`No agent named ${d.agent} to wake. Agents: ${ctx.agents.join(", ")}.`)
    action = d
    actionText = d.words !== undefined ? `wake ${d.agent} "${d.words}"` : `wake ${d.agent}`
  } else {
    const usesIt = d.text.split(/[\s;]+/).some((x) => x.toLowerCase() === "it")
    if (usesIt && cls !== "tape" && cls !== "mine") return no("it means the token that fired, so it's only for a tape trigger or one on your personal signals. Name the token here.")
    const text = usesIt ? d.text.replace(/(^|[\s;])it(?=$|[\s;])/gi, `$1${IT_MINT}`) : d.text
    const command = parseCommand(text, { ...ctx, activeAgent: ctx.proposer })
    const said = commandProblem(command, d.text)
    if (said) return no(`${said}${/isn't a token this session has shown/.test(said) ? none : ""}`)
    const c = command as Extract<Command, { kind: "trade" } | { kind: "chain" }>
    const agents = new Set((c.kind === "chain" ? c.parts.map((p) => p.command.agent) : [c.agent]).map((a) => a ?? ctx.proposer))
    if (agents.size > 1) return no(`A trigger trades with one agent's key, and this line names ${[...agents].join(" and ")}.`)
    agent = [...agents][0]!
    action = { kind: "command", command: c }
    actionText = renderCommand(c)
  }
  const cooldownMs = shape.cooldownMs ?? (cls === "schedule" || (cls === "level" && !shape.again) ? undefined : DEFAULT_COOLDOWN_MS)
  const expansion = `${shape.lead} ${conditionLine(when)} ${actionText}`
  const name = shape.name ?? defaultName(shape.conditionText)
  return {
    ok: true,
    value: {
      shape,
      name,
      agent,
      expansion,
      when,
      action,
      class: cls,
      again: shape.again,
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
      words: triggerWords(wordsShape(shape, when, nameFrom(ctx)), cooldownMs, action.kind === "command" ? renderCommand(action.command, nameFrom(ctx)) : undefined),
    },
  }
}

/** The shape for its words: a token written as a mint goes by its name, where the context knows one. */
function wordsShape(shape: TriggerShape, resolved: TriggerWhen, nameOf: (mint: string) => string): TriggerShape {
  // A P&L level says the window it took, whether or not the line wrote one.
  if (resolved.kind === "pnl") return { ...shape, when: resolved }
  if (!("token" in shape.when) || shape.when.token === undefined || !("token" in resolved) || resolved.token === undefined) return shape
  if (shape.when.token !== resolved.token) return shape
  return { ...shape, when: { ...shape.when, token: nameOf(resolved.token) } as TriggerWhen }
}

/** A mint's name where the context knows one by exactly that mint, else its first and last four, for words. */
function nameFrom(ctx: CommandContext): (mint: string) => string {
  const names = new Map<string, string>()
  for (const [name, mint] of ctx.knownTokens) if (!names.has(mint)) names.set(mint, name)
  for (const w of ctx.wallets?.names ?? []) if (w.name && !names.has(w.address)) names.set(w.address, w.name)
  return (mint) => names.get(mint) ?? (mint.length > 20 ? short(mint) : mint)
}

/** Why a command can't be a trigger's action, or undefined when it can. */
function commandProblem(command: Command | undefined, typed: string): string | undefined {
  if (!command) return "Say what it does: a trade, notify, or wake <agent>."
  if (command.kind === "refused") return `The action: ${command.message.replace(/^Not a trade yet: /, "")}`
  if (command.kind === "trade") return undefined
  if (command.kind === "chain") {
    const cli = command.parts.findIndex((p) => p.command.kind !== "trade")
    return cli < 0 ? undefined : `Part ${cli + 1} of the chain runs a candle command: ${ACTION_KINDS}`
  }
  if (command.kind === "cli") return `${ACTION_KINDS} candle commands, owner steps and funds out aren't.`
  if (command.kind === "agent") return `"${typed}" isn't a trade the Candle Harness can run. ${ACTION_KINDS}`
  return `"${typed}" runs on its own, not from a trigger. ${ACTION_KINDS}`
}
const ACTION_KINDS = "A trigger's action is a trade, a sell or a swap, a chain or alias of them, notify, or wake <agent>;"

/** The condition as the grammar writes it, with mints. */
function conditionLine(w: TriggerWhen): string {
  switch (w.kind) {
    case "price":
      return `${w.token} ${w.op} ${w.figure}`
    case "mcap":
      return `${w.token} mcap ${w.op} ${w.figure}`
    case "entry":
      return `${w.token} ${w.dir} ${w.percent}%`
    case "pnl":
      return `pnl ${w.window !== undefined ? `${pnlWindowText(w.window)} ` : ""}${w.op} ${w.figure}`
    case "tape": {
      const f = w.filters
      const parts = [w.pattern]
      if (f.maxMcapUsd !== undefined) parts.push(`mcap < ${compact(f.maxMcapUsd)}`)
      if (f.minMcapUsd !== undefined) parts.push(`mcap > ${compact(f.minMcapUsd)}`)
      if (f.maxAgeMinutes !== undefined) parts.push(`age < ${f.maxAgeMinutes}m`)
      if (f.minAgeMinutes !== undefined) parts.push(`age > ${f.minAgeMinutes}m`)
      if (f.group !== undefined) parts.push(`group ${f.group}`)
      if (f.chain !== undefined) parts.push(`chain ${f.chain}`)
      return parts.join(" ")
    }
    case "mine":
      return w.rule !== undefined ? `mine "${w.rule}"` : "mine"
    case "schedule":
      return w.every.kind === "interval" ? w.every.text : w.every.kind === "once" ? w.every.at : `${w.every.words.replace(/^every /, "").toLowerCase()} ${w.every.at}`
    case "event":
      if (w.event === "bot") return `bot "${w.bot}" ${w.what}${w.what === "says" ? ` "${w.word ?? ""}"` : ""}`
      return w.event === "fill" ? (w.token ? `fill of ${w.token}` : "fill") : w.event === "card-expired" ? "card expired" : w.event === "replay-ended" ? "replay ended" : "call"
  }
}

/** 500000 as 500k, 2500000 as 2.5m: a figure the grammar reads back the same. */
const compact = (n: number): string => (n >= 1e9 && n % 1e7 === 0 ? `${n / 1e9}b` : n >= 1e6 && n % 1e4 === 0 ? `${n / 1e6}m` : n >= 1e3 && n % 10 === 0 ? `${n / 1e3}k` : String(n))

/** A trade or chain as a line the input line reads the same with no names and no aliases: mints, `it` for the token that fired. */
export function renderCommand(c: Extract<Command, { kind: "trade" } | { kind: "chain" }>, nameOf: (mint: string) => string = (m) => m): string {
  if (c.kind === "chain") return c.parts.map((p) => renderCommand(p.command as Extract<Command, { kind: "trade" }>, nameOf)).join("; ")
  const a = c.args
  const mint = typeof a.mint === "string" ? (a.mint === IT_MINT ? "it" : nameOf(a.mint)) : ""
  let text: string
  if (c.tool === "candle_swap") text = `swap ${String(a.amount)} ${String(a.from)} ${String(a.to)}`
  else if (a.side === "buy") text = a.amountUsd !== undefined ? `buy $${String(a.amountUsd)} of ${mint}` : `buy ${String(a.amount)} ${String(a.quoteAsset)} of ${mint}`
  else text = a.percent !== undefined ? `sell ${String(a.percent)}% of ${mint}` : `sell ${String(a.amount)} of ${mint}`
  if (c.agent) text += ` as ${c.agent}`
  if (typeof a.wallet === "string") text += ` from ${a.wallet === "embedded" ? "embedded" : nameOf(a.wallet)}`
  return text
}

/** The name a line without `as "<name>"` goes by: its condition's words, cut at a word to fit. */
export function defaultName(conditionText: string): string {
  // A mint goes by its first and last four, so the name stays readable: "Moon…1111 < $0.40". A rule's name loses
  // its quotes (`mine whales`), since a trigger's name can't hold one.
  conditionText = conditionText.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\b0x[0-9a-fA-F]{40}\b/g, short).replace(/["\\]/g, "")
  if (conditionText.length <= MAX_NAME) return conditionText
  const cut = conditionText.slice(0, MAX_NAME + 1)
  const at = cut.lastIndexOf(" ")
  return (at > 10 ? cut.slice(0, at) : conditionText.slice(0, MAX_NAME)).trim()
}

/** What the trigger waits for, in words, with the token words as written. */
export function whenWords(w: TriggerWhen): string {
  const tok = (t: string) => (t.length > 20 ? short(t) : t)
  switch (w.kind) {
    case "price":
      return `${tok(w.token)}'s price ${opWords(w.op)} ${dollarWords(w.usd)}`
    case "mcap":
      return `${tok(w.token)}'s market cap ${opWords(w.op)} ${dollarWords(w.usd)}`
    case "entry":
      return `${tok(w.token)} is ${w.dir} ${w.percent}% from what you paid`
    case "pnl":
      return w.window !== undefined ? `your P&L ${pnlWindowWords(w.window)} ${opWords(w.op)} ${dollarWords(w.usd)}` : `the P&L window's figure ${opWords(w.op)} ${dollarWords(w.usd)}`
    case "tape": {
      const f = w.filters
      const bits: string[] = []
      if (f.maxMcapUsd !== undefined) bits.push(`market cap under ${dollarWords(f.maxMcapUsd)}`)
      if (f.minMcapUsd !== undefined) bits.push(`market cap over ${dollarWords(f.minMcapUsd)}`)
      if (f.maxAgeMinutes !== undefined) bits.push(`under ${durationWords(f.maxAgeMinutes * 60_000)} old`)
      if (f.minAgeMinutes !== undefined) bits.push(`over ${durationWords(f.minAgeMinutes * 60_000)} old`)
      if (f.group !== undefined) bits.push(`from the group ${f.group}`)
      if (f.chain !== undefined) bits.push(`on ${f.chain === "hood" ? "Hood" : "Solana"}`)
      return `Hacc's tape shows a ${w.pattern} signal${bits.length ? ` (${bits.join(", ")})` : ""}`
    }
    case "mine":
      return w.rule !== undefined ? `your rule "${w.rule}" fires` : "one of your personal signals fires"
    case "schedule":
      return w.every.kind === "interval" ? `every ${durationWords(w.every.ms)}` : w.every.kind === "once" ? `at ${w.every.at}, this machine's time` : `${w.every.words} at ${w.every.at}, this machine's time`
    case "event":
      if (w.event === "bot") return w.what === "says" ? `the code bot "${w.bot}" says "${w.word ?? ""}"` : `the bot "${w.bot}" ${w.what === "entered" ? "buys into a position" : w.what === "exited" ? "sells out of a position" : "is paused"}`
      return w.event === "fill" ? (w.token ? `a trade of ${tok(w.token)} fills` : "a trade fills") : w.event === "card-expired" ? "a card expires" : w.event === "replay-ended" ? "a replay ends" : "it's called from outside"
  }
}

function doWords(d: TriggerDo, command?: string): string {
  if (command !== undefined) return command.replace(/\bit\b/g, "the token that fired")
  if (d.kind === "notify") return d.words !== undefined ? `notify you: "${d.words}"` : "notify you"
  if (d.kind === "wake") return d.words !== undefined ? `wake ${d.agent} to look at "${d.words}"` : `wake ${d.agent}`
  return d.text.replace(/\bit\b/gi, "the token that fired")
}

/** How often it fires, in words. */
export function firesWords(cls: TriggerClass, again: boolean, cooldownMs: number | undefined, once = false): string {
  // "every minute", not "every 1 minute".
  const cool = durationWords(cooldownMs ?? DEFAULT_COOLDOWN_MS).replace(/^1 /, "")
  if (cls === "level") return again ? `Fires each time it's crossed back, at most every ${cool}.` : "Fires once, then switches off."
  if (cls === "tape" || cls === "mine") return `Fires each time, once per token every ${cool}.`
  if (cls === "schedule") return once ? "Runs once, then switches off." : "Runs each time."
  return `Fires each time, at most every ${cool}.`
}

/** The whole trigger in words. */
export function triggerWords(shape: TriggerShape, cooldownMs?: number, command?: string): string {
  // A trigger fired from outside says how, by its name, where the line gives one.
  const called = shape.when.kind === "event" && shape.when.event === "call" && shape.name !== undefined
  const lead = shape.lead === "every" || shape.lead === "at" ? whenWords(shape.when).replace(/^(every|at)/, (x) => x[0]!.toUpperCase() + x.slice(1)) : called ? `When \`candle-harness trigger "${shape.name}"\` calls it` : `When ${whenWords(shape.when)}`
  return `${lead}, ${doWords(shape.do, command)}. ${firesWords(classOf(shape.when), shape.again, cooldownMs, isOnce(shape.when))}${shape.when.kind === "pnl" && shape.when.window !== undefined ? ` ${pnlMovesWords(shape.when.window)}` : ""}`
}

/** How a P&L window's figure moves with no trade of yours: said with the trigger, so a firing at the window's edge isn't a surprise. */
function pnlMovesWords(window: PnlWindowName): string {
  if (window === "24h") return "The figure covers the last 24 hours, so it also moves as older results pass out of them."
  if (window === "session") return "The figure starts again each time you close the Candle Harness."
  return `The figure starts again at ${window === "midnight" ? "midnight" : window} each day.`
}

/** The whole line as it's shown on a card: the body, then again, cooldown and the name. */
export function fullLine(t: { body: string; again: boolean; cooldownMs?: number; name: string; defaultName?: string }): string {
  return [t.body, t.again ? "again" : "", t.cooldownMs !== undefined && t.cooldownMs !== DEFAULT_COOLDOWN_MS ? `cooldown ${durationText(t.cooldownMs)}` : "", t.name !== t.defaultName ? `as "${t.name}"` : ""].filter(Boolean).join(" ")
}

/** The tokens a line's action trades, from its expansion: each part's mint, `it` left out. */
export function actionMints(command: Extract<Command, { kind: "trade" } | { kind: "chain" }>): string[] {
  const trades = command.kind === "chain" ? command.parts.map((p) => p.command as Extract<Command, { kind: "trade" }>) : [command]
  return [...new Set(trades.flatMap((c) => (typeof c.args.mint === "string" && c.args.mint !== IT_MINT ? [c.args.mint] : [])))]
}

/** A chain's or one trade's parts. */
export const partsOfAction = (command: Extract<Command, { kind: "trade" } | { kind: "chain" }>): Extract<Command, { kind: "trade" }>[] =>
  command.kind === "chain" ? command.parts.map((p) => p.command as Extract<Command, { kind: "trade" }>) : [command]
