// Notifications: what notifies, which kind to send, how to send an OS one safely, and how to
// clean the text, which can carry a token's name (anyone can name a token anything).
//
// - The core and the view share these. The view sends through its terminal while it isn't focused; with no
//   main view open, the core sends an OS notification when the machine is local (core/notifier.ts).
// - Every notice is in Activity's words, with no address and no key: an address shows short, and the
//   redactor runs over the words. The same words are Quant's headline, sent nowhere until Candle has a route.
import { isTestName, shownBotName } from "./bot-name"
import { existsSync } from "node:fs"
import { short } from "../core/wallet-names"
import { Redactor } from "./redact"

export type NotifyMode = "auto" | "native" | "osc" | "bell" | "off"
export type Notifier = "native" | "osc" | "bell"

export const NOTIFY_MODES: readonly NotifyMode[] = ["auto", "native", "osc", "bell", "off"]

/**
 * What notifies, each switched on or off in `[notify] on`:
 * - `cards`: a card waits for you that you didn't make (the agent's, a woken turn's, a trigger's);
 * - `triggers`: a trigger fired and did something, or missed, or its card expired with nobody there;
 * - `bots`: a rules bot bought or sold, or its trade waits for you, was refused or failed, or its sell is held;
 * - `wakes`: a wake skipped at its agent's cap;
 * - `kill`: the kill switch went on;
 * - `keys`: Candle held a key (its cap, a loss limit or the circuit breaker);
 * - `core`: the core stopped when nobody asked it to.
 */
export const NOTIFY_KINDS = ["cards", "triggers", "bots", "wakes", "kill", "keys", "core"] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]

export interface NotifySettings {
  mode: NotifyMode
  on: readonly NotifyKind[]
}

export const DEFAULT_NOTIFY: NotifySettings = { mode: "auto", on: NOTIFY_KINDS }

/** Each kind as a notification's title says it, after "Candle Harness · ". */
export const KIND_TITLES: Record<NotifyKind, string> = {
  cards: "a card waits for you",
  triggers: "trigger",
  bots: "bot",
  wakes: "wake skipped",
  kill: "kill switch",
  keys: "Candle held a key",
  core: "the core stopped",
}

/** One notification: a title and a line, in Activity's words, already cleaned. */
export interface Notice {
  kinds: NotifyKind[]
  title: string
  body: string
}

/** What a bot's exit did, by its reason, as its notice and its Activity line say it: "stopped out of MOON". */
export const BOT_EXIT_VERBS: Readonly<Record<string, string>> = { stop_loss: "stopped out of", take_profit: "took profit on", max_hold: "sold {} at its max hold", trailing_stop: "sold {} at its trailing stop", flatten: "flattened" }
/** A bot's trade's verb: "bought", or its exit's by its reason. */
export const botVerb = (act: unknown, reason: unknown): string => (act === "exit" ? (BOT_EXIT_VERBS[String(reason)] ?? "sold") : act === "swap" ? "swapped" : "bought")

/**
 * Verbs and their tokens, in the order they came, as one phrase: "bought BONK, WIF · stopped out of MOON". A token
 * said twice under one verb is said once.
 */
export function verbPhrase(parts: readonly { verb: string; token: string }[]): string {
  const verbs = new Map<string, string[]>()
  for (const p of parts) {
    const tokens = verbs.get(p.verb) ?? []
    if (!tokens.includes(p.token)) tokens.push(p.token)
    verbs.set(p.verb, tokens)
  }
  // A verb with `{}` takes its tokens there ("sold Jose at its max hold"), the rest after it ("took profit on APU").
  return [...verbs].map(([v, t]) => (v.includes("{}") ? v.replace("{}", t.join(", ")) : `${v} ${t.join(", ")}`)).join(" · ")
}

/** A bot's trade, for joining a bot's notices into one line: the bot, what it did ("bought", "stopped out of"), the token, paper. */
export interface BotPart {
  bot: string
  verb: string
  token: string
  paper?: boolean
}

/**
 * A bot's trades that came together, as one line a bot: "conf · bought BONK, WIF · stopped out of MOON", and
 * "(paper)" after a paper bot's name. In the order they came.
 */
export function botLines(parts: readonly BotPart[]): string[] {
  const bots = new Map<string, BotPart[]>()
  for (const p of parts) bots.set(p.bot, [...(bots.get(p.bot) ?? []), p])
  return [...bots].map(([bot, ps]) => {
    const phrase = verbPhrase(ps.map((p) => ({ verb: `${p.verb}${p.paper && !ps.every((x) => x.paper) ? " (paper)" : ""}`, token: p.token })))
    return `${shownBotName(bot)}${ps.every((x) => x.paper) && !isTestName(bot) ? " (paper)" : ""} · ${phrase}`
  })
}

const MAX_CODE_POINTS = 200

/**
 * Newlines and tabs become spaces; C0 and C1 controls and DEL go (so a name can't carry ESC or BEL,
 * or the 8-bit string terminator, and close the OSC sequence it rides in early); Unicode direction
 * controls go (so a name can't display reversed). Capped at 200 code points, never splitting a
 * surrogate pair. Words aren't filtered: a name is shown as it is, never judged.
 */
export function cleanNotificationText(s: string): string {
  const cleaned = s
    .replace(/\r\n|[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
  return Array.from(cleaned).slice(0, MAX_CODE_POINTS).join("")
}

const ADDRESS = /(?<![A-Za-z0-9])(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})(?![A-Za-z0-9])/g
const redactor = new Redactor()

/** A notification's words: keys redacted, every address short ("7xKX…3fQa"), then cleaned. */
export function noticeText(s: string): string {
  const shortened = redactor.text(s).replace(ADDRESS, short)
  return cleanNotificationText(shortened)
}

/** A notice of one kind, its title and line cleaned. */
export function noticeOf(kind: NotifyKind, body: string): Notice {
  return { kinds: [kind], title: noticeText(`Candle Harness · ${KIND_TITLES[kind]}`), body: noticeText(body) }
}

/**
 * Several notices that came together as one: a chain's parts, a firing and its fill. One is sent as it is;
 * more say how many, then each line in turn, as far as 200 characters reach.
 */
export function joinNotices(notices: readonly Notice[]): Notice | undefined {
  if (notices.length <= 1) return notices[0]
  const kinds = [...new Set(notices.flatMap((n) => n.kinds))]
  const title = kinds.length === 1 ? `${notices[0]!.title} · ${notices.length} updates` : `Candle Harness · ${notices.length} updates`
  return { kinds, title: noticeText(title), body: noticeText(notices.map((n) => n.body).join(" · ")) }
}

/**
 * Quant's headline for a notice: the same words, on one line. Built and tested, and sent nowhere
 * until Candle publishes a route for the Candle Harness to message the account's Quant chat.
 */
export function quantHeadline(n: Notice): string {
  return noticeText(`${n.title}: ${n.body}`)
}

/**
 * The argv for an OS notification, run with no shell. On macOS the text reaches the script as
 * `argv` items, never spliced into its source, so quotes and backslashes in a name are just text.
 */
export function osNotifyCommand(platform: "darwin" | "linux", title: string, body: string): string[] {
  const t = cleanNotificationText(title)
  const b = cleanNotificationText(body)
  if (platform === "darwin") {
    return ["osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t, b]
  }
  // "--": a title that starts with "-" is the title, never an option of notify-send's.
  return ["notify-send", "--", t, b]
}

/**
 * Remote: over SSH, or inside a container or sandbox VM, where a native notification would appear
 * on a machine nobody is looking at. The Docker Sandboxes microVM has no /.dockerenv and no
 * systemd-detect-virt; it sets SANDBOX_VM_ID (from PID 1, so every process inherits it).
 */
export function isRemote(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true
  if (env.SANDBOX_VM_ID) return true
  return exists("/.dockerenv") || exists("/run/.containerenv")
}

/**
 * Whether this process can put a notification on the screen in front of the person: on macOS, any local
 * process (a LaunchAgent runs in the person's session); on Linux, one with a desktop session to reach
 * (a display or a session bus). A VPS has neither, and nothing is sent.
 */
export function canNotifyNative(platform: string, env: Record<string, string | undefined>, exists?: (path: string) => boolean): boolean {
  if (isRemote(env, exists)) return false
  if (platform === "darwin") return true
  if (platform === "linux") return !!(env.DISPLAY || env.WAYLAND_DISPLAY || env.DBUS_SESSION_BUS_ADDRESS)
  return false
}

/**
 * Which kind to send. Never while the user is looking at the app (`focused: true`); when the
 * terminal can't say (`focused: null`), send. `auto` is native locally and OSC when remote.
 */
export function pickNotifier(mode: NotifyMode, ctx: { remote: boolean; focused: boolean | null }): Notifier | null {
  if (mode === "off" || ctx.focused === true) return null
  if (mode === "auto") return ctx.remote ? "osc" : "native"
  return mode
}

/** What to try after `first` fails, in order: the OS, then the terminal's sequence, then the bell. */
export function fallbacks(first: Notifier): Notifier[] {
  if (first === "native") return ["native", "osc", "bell"]
  if (first === "osc") return ["osc", "bell"]
  return ["bell"]
}
