// The Bots tab, pane and overlay, as lines: each rules bot and code bot on the left (on, paused or stopped, paper
// or live, its P&L and what's open), the picked one on the right in full. A rules bot: its words, how it stands, each
// open position on a line from its stop to its target, its book, backtest and skips, its newest fills, and its
// chips. A code bot: what it runs, its process, its figures and today's use, its positions (on that line where the
// core holds its exits), what the bot says about itself, labelled as its own words, and below, the core's count. Its
// log is an overlay. Pure, so a test reads what's drawn; the keys are keys.ts's, the drawing panes/bots.tsx's and the
// registry's.
import { sharedWithWords } from "../shared/bot-name"
import type { BotBookView, BotPositionView } from "../core/bot-books"
import type { BotsTopic, BotView } from "../core/bots"
import type { CodeBotView, CodeHeldExitView } from "../core/code-bots"
import { askAbout } from "./ask"
import { usd, wrap } from "./format"
import { blank, chip, type Line, line, type Seg } from "./panes/lines"
import { C, fit, signedMoney } from "./theme"

export interface BotsState {
  kind: "bots"
  /** The picked bot. */
  index: number
  /** Below the wide width, the list or the picked bot. */
  side: "list" | "detail"
}

/** Below this the list takes the width, and → opens one bot, as the Triggers overlay does. */
export const BOTS_WIDE = 100
/** The list's width, wide. */
export const BOTS_LIST_W = 41

/**
 * What a bot's chips do. The confirm acts end a question flatten, remove or a held exit's removal asked. A code bot
 * adds its log, starting its process again, a control its own report offers, and removing the exits the core holds on
 * one of its positions: the last two name what after a `/` (a bot's name never holds one).
 */
export type BotAction = "pause" | "resume" | "stop" | "flatten" | "flattenYes" | "pauseFlatten" | "remove" | "removeFlatten" | "removeLeave" | "removeYes" | "keep" | "retry" | "ask" | "goLive" | "replay" | "planBuy" | "log" | "start" | "control" | "dropExits" | "dropExitsYes"
const ACTIONS: readonly BotAction[] = ["pause", "resume", "stop", "flatten", "flattenYes", "pauseFlatten", "remove", "removeFlatten", "removeLeave", "removeYes", "keep", "retry", "ask", "goLive", "replay", "planBuy", "log", "start", "control", "dropExits", "dropExitsYes"]

/** A rules bot or a code bot: the Bots tab lists both, rules bots first. */
export type AnyBot = BotView | CodeBotView
/** Every bot the tab lists: rules bots, then code bots; none on Free. */
export const everyBot = (topic: BotsTopic | undefined): AnyBot[] => (!topic ? [] : [...topic.bots, ...(topic.code ?? [])])

/** A chip's ref: what it does, and to which bot. */
export const botRef = (action: BotAction, name: string): string => `${action}:${name}`
export function parseBotRef(ref: string): { action: BotAction; name: string } | undefined {
  const i = ref.indexOf(":")
  const action = ref.slice(0, i) as BotAction
  return i > 0 && ACTIONS.includes(action) ? { action, name: ref.slice(i + 1) } : undefined
}

/** A bot's row id in the list: ↑/↓ highlight it, and the picked bot's pane shows it. */
export const botRowId = (name: string): string => `bot:${name}`
export const botOfRow = (id: string | undefined): string | undefined => (id?.startsWith("bot:") ? id.slice(4) : undefined)

/** A flatten, a remove, or removing a code bot's held exits asks once before it goes. */
export interface BotConfirm {
  name: string
  what: "flatten" | "remove" | "exits"
  /** The position whose held exits would go, for `exits`. */
  position?: string
  /** When it asked: an answer needs a press of its own, never the one that opened it reported twice. */
  at?: number
}

/** The words each fill chip puts on the input line, for the agent: nothing is sent before Enter. */
export const askToChangeBot = (name: string): string => `change the bot "${name}": `
export const goLiveWords = (name: string): string => `take the bot "${name}" live`
export const replayWords = (name: string, since: string | undefined): string =>
  `replay the bot "${name}"'s definition over its live days${since ? `, since ${dayWords(since)},` : ""} and show it beside its live run`

export const pickedBot = (topic: BotsTopic | undefined, index: number): AnyBot | undefined => {
  const all = everyBot(topic)
  return all[Math.max(0, Math.min(index, all.length - 1))]
}
export const botNamed = (topic: BotsTopic | undefined, name: string | undefined): AnyBot | undefined => (name === undefined ? undefined : everyBot(topic).find((b) => b.name === name))

/** "3 on · 1 live": how many enter on signals now, and how many trade live. */
export function botsCountWords(topic: BotsTopic | undefined, killed = false): string {
  const all = everyBot(topic)
  const on = all.filter((b) => b.state === "on").length
  const live = all.filter((b) => b.mode === "live" && b.state !== "stopped").length
  // With none on, the count says what they are instead: "0 on" over a paused bot whose process runs read as a contradiction.
  const paused = all.filter((b) => b.state === "paused").length
  const stopped = all.filter((b) => b.state === "stopped").length
  const idle = on === 0 ? [...(paused ? [`${paused} paused`] : []), ...(stopped ? [`${stopped} stopped`] : [])] : []
  // Under the kill switch a bot that's on takes no entries: it's held, not on.
  return [...(idle.length ? idle : [killed && on ? `${on} held` : `${on} on`]), ...(live ? [`${live} live`] : [])].join(" · ")
}

const dayWords = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5)
const heldWords = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`
}
const pctOf = (now: number, entry: number) => (now / entry - 1) * 100
const signedPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`
const tone = (n: number | undefined) => (n === undefined ? C.dim : n > 0 ? C.good : n < 0 ? C.bad : C.ink)

/** A bot's P&L, its realized and its open together; "—" before it has traded. Paper's is ≈. */
export function botPnl(b: Pick<AnyBot, "mode">, book: BotBookView | undefined): { text: string; fg: string } {
  if (!book || (book.closed === 0 && book.open.length === 0)) return { text: "—", fg: C.dim }
  const n = book.realizedUsd + (book.unrealizedUsd ?? 0)
  return { text: `${b.mode === "paper" ? "≈" : ""}${signedMoney(n)}`, fg: tone(n) }
}

/** How a bot stands, short, and the colour it's said in: on is plain, paused amber, stopped dim. */
/** What the kill switch does to a bot that's on, in the list and on its own pane. */
export const KILL_HELD_WORDS = "held by the kill switch: no new entries; its exits still sell"

function stateNote(b: AnyBot, killed = false): { text: string; fg: string } {
  if (b.held) return { text: b.held.words, fg: C.look }
  if (killed && b.state === "on") return { text: KILL_HELD_WORDS, fg: C.look }
  const sells = b.kind === "code" ? b.sells : b.exits
  if (b.state === "paused") return { text: `${b.stateWords ?? "paused"}${sells ? (b.kind === "code" ? " · sells run" : " · exits sell") : ""}`, fg: C.look }
  if (b.state === "stopped") return { text: `${b.stateWords ?? "stopped"}${b.kind === "rules" && b.open ? ` · ${b.open} left to you` : ""}`, fg: C.dim }
  // A code bot whose process is in trouble, or that isn't connected, says so in its list row: its trades wait on it.
  if (b.kind === "code") {
    const p = b.process
    if (p?.state === "gave_up") return { text: "crashed, not started again", fg: C.bad }
    if (p?.state === "restarting") return { text: "crashed, starting again", fg: C.look }
    if (p?.state === "down") return { text: "its process is stopped", fg: C.look }
    if (p?.state === "ended" || p?.state === "waits") return { text: "not running", fg: C.look }
    if (p?.state === "outside" && !b.connected) return { text: "runs outside · not connected", fg: C.look }
  }
  return { text: `${b.agent} · ${b.paysFrom ?? (b.wallet === "embedded" ? "embedded" : b.wallet)}${b.kind === "code" ? " · code" : ""}`, fg: C.dim }
}

/** One bot in the list: two lines, the dot, name, mode, P&L and open count, then its agent and wallet or how it stands. */
/** The list's name column: as wide as its longest name, at most 24. */
export const botNameWidth = (bots: readonly { name: string }[]) => Math.min(24, Math.max(4, ...bots.map((b) => b.name.length)))

export function botListLines(b: AnyBot, book: BotBookView | undefined, width: number, nameWidth = 16, killed = false): Line[] {
  const pick = { id: botRowId(b.name), mint: "", ask: askToChangeBot(b.name) }
  const dot: Seg = b.state === "on" ? { text: "● ", fg: killed ? C.look : C.good } : b.state === "paused" ? { text: "● ", fg: C.look } : { text: "○ ", fg: C.dim }
  const pnl = botPnl(b, book)
  const open = book?.open.length ? `${book.open.length} open` : ""
  // A space after the name, so a name as long as its column never runs into the mode.
  const nameW = Math.max(4, Math.min(nameWidth, width - 2 - 1 - 7 - 9 - 8))
  const note = stateNote(b, killed)
  return [
    { segs: [dot, { text: `${fit(b.name, nameW).padEnd(nameW)} `, fg: b.state === "stopped" ? C.dim : C.hi }, { text: b.mode.padEnd(7), fg: b.mode === "live" ? C.good : C.dim }, { text: pnl.text.padStart(9), fg: pnl.fg }, { text: open ? `  ${open.padStart(6)}` : "        ", fg: C.dim }], pick },
    { segs: [{ text: `  ${fit(note.text, Math.max(4, width - 2))}`, fg: note.fg }], pick },
  ]
}

/** The list, each bot with a blank line after it; on Free or before a read, why there's none. */
export function botsListLines(topic: BotsTopic | undefined, width: number, killed = false): Line[] {
  const all = everyBot(topic)
  if (!topic || all.length === 0) return emptyBotLines(topic, width)
  const out: Line[] = []
  // Held by the plan: the bots stay listed, since what they bought is still theirs and their sells still run.
  if (topic.gate) {
    for (const l of wrap(`${topic.gate.words}: their buys are held, and their sells of their own still run.`, Math.max(10, width))) out.push(line(l, C.look))
    if (topic.gate.fix) out.push({ segs: [{ ...chip(topic.gate.fix, "fill"), ref: topic.gate.fix }, { text: "  goes on the input line", fg: C.dim }] })
    out.push(blank())
  }
  for (const b of all) out.push(...botListLines(b, topic.books?.[b.name], width, botNameWidth(all), killed), blank())
  for (const p of topic.problems) for (const l of wrap(p, Math.max(10, width))) out.push(line(l, C.look))
  return out
}

/** What the tab, the pane and the overlay say with no bot to show: on Free, before a read, or none yet. */
export function emptyBotLines(topic: BotsTopic | undefined, width: number): Line[] {
  const w = Math.max(10, width)
  if (topic?.gate) {
    const out = [line(`${topic.gate.words}.`, C.hi), ...wrap("A rules bot runs a Hacc strategy for you: it buys on Hacc's tape when its pattern fires, and sells at its own exits. A code bot runs code of your own, written in the Build tab.", w).map((l) => line(l, C.ink))]
    if (topic.gate.fix) out.push(blank(), { segs: [{ ...chip(topic.gate.fix, "fill"), ref: topic.gate.fix }, { text: "  goes on the input line", fg: C.dim }] })
    return out
  }
  if (!topic) return [line("Reading the bots…", C.dim)]
  return [
    ...wrap('No bots yet. Ask the agent: "run a confluence bot under $500K, $2 a trade, on paper", or "make my tape trigger a bot".', w).map((l) => line(l, C.dim)),
    blank(),
    ...wrap("Or write one in code: the Build tab opens your own coding harness in your bots folder, and a bot it proposes is a card for you.", w).map((l) => line(l, C.dim)),
  ]
}

/** A gauge end's percent: whole from 10% out, one decimal inside it, where rounding turned ±0.5% into −1% and +0%. */
const gaugePct = (v: number): string => (Math.abs(v) >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(1))))

/**
 * A position on a line from its stop (├) to its target (┤): its entry ┼, the trailing level once armed ╎ (amber), and
 * the price now ●. Where the definition has no stop or no target, the line's end is the furthest the price went.
 */
export function gauge(p: BotPositionView, width: number): Seg[] | undefined {
  if (p.entryUsd === undefined || p.nowUsd === undefined) return undefined
  const lo = p.stopUsd !== undefined ? pctOf(p.stopUsd, p.entryUsd) : Math.min(-50, pctOf(p.nowUsd, p.entryUsd))
  const hi = p.targetUsd !== undefined ? pctOf(p.targetUsd, p.entryUsd) : Math.max(100, pctOf(p.peakUsd ?? p.nowUsd, p.entryUsd))
  const loText = `${gaugePct(lo)}%`
  const hiText = `+${gaugePct(hi)}%`
  const bar = Math.max(8, width - loText.length - hiText.length - 2)
  const at = (v: number) => Math.max(0, Math.min(bar - 1, Math.round(((v - lo) / (hi - lo)) * (bar - 1))))
  const marks: string[] = Array.from({ length: bar }, () => "─")
  marks[0] = "├"
  marks[bar - 1] = "┤"
  marks[at(0)] = "┼"
  if (p.trail?.armed && p.trail.sellsUnderUsd !== undefined) marks[at(pctOf(p.trail.sellsUnderUsd, p.entryUsd))] = "╎"
  const now = pctOf(p.nowUsd, p.entryUsd)
  const nowAt = at(now)
  const segs: Seg[] = [{ text: `${loText} `, fg: C.dim }]
  marks.forEach((m, i) => segs.push(i === nowAt ? { text: "●", fg: now >= 0 ? C.good : C.bad } : { text: m, fg: m === "╎" ? C.look : m === "┼" ? C.ink : C.edge }))
  segs.push({ text: ` ${hiText}`, fg: C.dim })
  return segs
}

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

const TOKEN_W = 7
const PCT_W = 8

/** One open position: its token, its change since entry and the gauge, then its P&L on what it cost and how long it's held. */
export function positionLines(p: BotPositionView, width: number, now: number, bot?: string): Line[] {
  // A position's lines pick its token, as a row in the away overlay does.
  const pick = { id: `bot-position:${p.id}`, mint: p.mint, ask: askAbout(p.token, p.mint, bot ? `The bot "${bot}" holds it.` : "A bot holds it.") }
  const head: Seg = { text: fit(p.token, TOKEN_W - 1).padEnd(TOKEN_W), fg: C.hi }
  const change = p.entryUsd !== undefined && p.nowUsd !== undefined ? pctOf(p.nowUsd, p.entryUsd) : undefined
  const g = gauge(p, width - TOKEN_W - PCT_W)
  const first: Line = g
    ? { segs: [head, { text: signedPct(change!).padStart(PCT_W - 1).padEnd(PCT_W), fg: tone(change) }, ...g], pick }
    : { segs: [head, { text: p.noPriceSince !== undefined ? `no price on Candle since ${hhmm(p.noPriceSince)}` : p.nowUsd === undefined ? "waiting for its first price after the fill" : "waiting for its entry price from the fill", fg: p.noPriceSince !== undefined ? C.look : C.dim }], pick }
  const held = now - Date.parse(p.since)
  const hold = p.holdUntil ? ` of ${heldWords(Date.parse(p.holdUntil) - Date.parse(p.since))}` : ""
  const bits = [p.unrealizedUsd !== undefined && p.costUsd !== undefined ? `${signedMoney(p.unrealizedUsd)} on ${usd(p.costUsd)}` : p.costUsd !== undefined ? `${usd(p.costUsd)} in` : undefined, `${heldWords(held)}${hold}`]
  const sub = bits.filter(Boolean).join(" · ")
  return [first, ...wrap(sub, Math.max(10, width - TOKEN_W)).map((l): Line => ({ segs: [{ text: " ".repeat(TOKEN_W) + l, fg: C.dim }], pick }))]
}

/** Why each exit sold, as the book counts them. */
const EXIT_SHORT: Readonly<Record<string, string>> = { take_profit: "at target", stop_loss: "at stop", trailing_stop: "trailing", max_hold: "at hold's end", flatten: "flattened", sold: "sold" }
const EXIT_FILL: Readonly<Record<string, string>> = { take_profit: "at its target", stop_loss: "at its stop", trailing_stop: "on its trailing stop", max_hold: "at its hold's end", flatten: "flattened" }

const LABEL = 10

type RecentFill = BotBookView["recent"][number]
/**
 * An exit filled on the wrong side of what fired it: the core decides on Candle's market price and the sell fills at
 * Candle's quote, which on a thin token can be well apart. Said rather than left to read as a target that lost.
 */
const againstItsExit = (f: RecentFill): boolean =>
  f.act !== "in" && f.realizedUsd !== undefined && (((f.reason === "take_profit" || f.reason === "trailing_stop") && f.realizedUsd < 0) || (f.reason === "stop_loss" && f.realizedUsd > 0))
/** "bought FAIR for $2.00", "sold FAIR at its target", or "sold FAIR at its target, filled under it". */
function fillWords(f: RecentFill): string {
  if (f.act === "in") return `bought ${f.token}${f.usd !== undefined ? ` for ${usd(f.usd)}` : ""}`
  const sold = `sold ${f.token} ${EXIT_FILL[f.reason ?? ""] ?? ""}`.trimEnd()
  return againstItsExit(f) ? `${sold}, filled ${f.realizedUsd! < 0 ? "under" : "over"} it` : sold
}
/** The line under a bot's last fills when one filled on the wrong side of its exit. */
const AGAINST_NOTE = "An exit fires on Candle's market price and fills at Candle's quote: on a thin token they can be far apart."

/** A backtest's figures, short: "pass · 41 trades · +$9.12 · drawdown 18.4% · Oct 29 to Nov 5"; or why there's none. */
export function backtestLine(book: BotBookView | undefined): string {
  const b = book?.backtest
  if (!b) return book?.lab ? "none of this exact definition yet" : "backtests need Max"
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  return [b.verdict, b.trades !== undefined ? `${b.trades} trade${b.trades === 1 ? "" : "s"}` : undefined, b.pnlUsd !== undefined ? signedMoney(b.pnlUsd) : undefined, b.drawdownPct !== undefined ? `drawdown ${b.drawdownPct.toFixed(1)}%` : undefined, b.from && b.to ? `${day(b.from)} to ${day(b.to)}` : undefined]
    .filter(Boolean)
    .join(" · ")
}

/** The chips a bot's state allows: what changes it at once, what asks once, and what goes to the agent. */
export function botChips(b: AnyBot, book: BotBookView | undefined, width: number): BotAction[] {
  if (b.kind === "code") return codeBotChips(b, book)
  const open = (book?.open.length ?? b.open ?? 0) > 0
  return [
    ...(b.state === "on" ? (["pause", "stop"] as const) : b.state === "paused" ? (["resume", "stop"] as const) : (["resume"] as const)),
    ...(open ? (["flatten"] as const) : []),
    ...(b.sellsHeld?.some((h) => h.why === "failed_sells") ? (["retry"] as const) : []),
    ...(b.mode === "paper" ? (["goLive"] as const) : []),
    ...(b.mode === "live" && book?.lab && b.onSince ? (["replay"] as const) : []),
    "ask" as const,
    "remove" as const,
  ].filter((a) => a !== "replay" || width >= 40)
}

const CHIP_WORDS: Readonly<Record<BotAction, string>> = {
  pause: "pause",
  resume: "resume",
  stop: "stop",
  flatten: "flatten",
  flattenYes: "flatten it",
  pauseFlatten: "pause, then flatten",
  remove: "remove",
  removeFlatten: "flatten, then remove",
  removeLeave: "leave them, remove",
  removeYes: "remove it",
  keep: "keep it",
  retry: "retry its sells",
  ask: "ask the agent to change it",
  goLive: "go live",
  replay: "replay its live days",
  planBuy: "candle plan buy",
  log: "log",
  start: "start it",
  control: "",
  dropExits: "remove its exits",
  dropExitsYes: "remove them",
}

/**
 * Flatten sells; pausing is the bot's own step. So the question says whether the bot keeps buying afterwards, and
 * where it's on, offers both steps in turn beside flatten alone.
 */
const flattenStays = (state: string, buyer: string): string => (state === "on" ? `The bot stays on, so ${buyer} may buy again at once.` : `The bot stays ${state}.`)
const flattenChoices = (state: string): BotAction[] => (state === "on" ? ["flattenYes", "pauseFlatten", "keep"] : ["flattenYes", "keep"])

/** Chips, as many to a row as fit `width`. */
function chipRows(acts: readonly BotAction[], name: string, width: number, refOf: (a: BotAction) => string = (a) => botRef(a, name), askShort = false): Line[] {
  const rows: Line[] = []
  let row: Seg[] = []
  let used = 0
  for (const a of acts) {
    const words = a === "ask" && (askShort || width < 50) ? "ask the agent" : CHIP_WORDS[a]
    const c = { ...chip(words, "bot", a === "flattenYes" || a === "pauseFlatten" || a === "removeFlatten" || a === "removeYes" || a === "dropExitsYes" ? "primary" : "control"), ref: refOf(a) }
    if (used && used + 2 + c.text.length > width) {
      rows.push({ segs: row })
      row = []
      used = 0
    }
    if (used) row.push({ text: "  ", fg: C.ink })
    row.push(c)
    used += (used ? 2 : 0) + c.text.length
  }
  if (row.length) rows.push({ segs: row })
  return rows
}

/**
 * The picked bot in full: its words, how it stands, each open position on its gauge, its book, its backtest, its
 * skips over the last day and its newest fills, then its chips; or, while flatten or remove asks, its question.
 * `head` puts its name and whose it is first (the overlay; the tab's pane says them in its title).
 */
export function botDetailLines(b: AnyBot | undefined, book: BotBookView | undefined, input: { width: number; now: number; confirm?: BotConfirm; head?: boolean; topic?: BotsTopic; killed?: boolean }): Line[] {
  const width = Math.max(20, input.width)
  if (!b) return emptyBotLines(input.topic, width)
  if (b.kind === "code") return codeBotDetailLines(b, book, { ...input, width })
  const out: Line[] = []
  if (input.head) out.push({ segs: [{ text: fit(b.name, width), fg: C.hi, bold: true }, { text: fit(` · ${b.agent}'s`, Math.max(0, width - b.name.length)), fg: C.dim }] }, blank())
  for (const l of wrap(b.words, width)) out.push(line(l, C.ink))
  const pays = b.paysFrom ?? (b.wallet === "embedded" ? "embedded" : b.wallet)
  const state = b.state === "on" ? `on${b.onSince ? ` since ${dayWords(b.onSince)}` : ""}` : (b.stateWords ?? b.state)
  out.push({ segs: [{ text: b.mode, fg: b.mode === "live" ? C.good : C.dim }, { text: fit(` · ${state} · pays from ${pays}`, width - b.mode.length), fg: b.state === "paused" ? C.look : C.dim }] })
  if (b.held) for (const l of wrap(b.held.words, width)) out.push(line(l, C.look))
  else if (input.killed && b.state === "on") for (const l of wrap(KILL_HELD_WORDS, width)) out.push(line(l, C.look))
  for (const h of b.sellsHeld ?? []) for (const l of wrap(h.words, width)) out.push(line(l, C.look))
  if (b.slippageLooser && b.maxSlippageBps !== undefined) out.push(line(fit(`its own slippage bound, ${b.maxSlippageBps / 100}%: looser than the route's`, width), C.look))
  for (const m of b.refused ?? []) for (const l of wrap(`can't run live: ${m.why}`, width)) out.push(line(l, C.look))
  // Its chips, or the question flatten or remove asks, under how it stands: in reach before its figures.
  out.push(blank())
  const c = input.confirm?.name === b.name ? input.confirm : undefined
  if (c?.what === "flatten") {
    for (const l of wrap(`Flatten "${b.name}"? It sells every open position now, at market, as its exits sell: no card. ${flattenStays(b.state, "its next signal")}`, width)) out.push(line(l, C.look))
    out.push(...chipRows(flattenChoices(b.state), b.name, width))
  } else if (c?.what === "remove") {
    const open = book?.open.length ?? b.open ?? 0
    for (const l of wrap(open ? `Remove "${b.name}"? It holds ${open} open position${open === 1 ? "" : "s"}: flatten them first, or leave them in the wallet with no exits.` : `Remove "${b.name}"? It's taken out of bots.toml; its record stays in the journal.`, width)) out.push(line(l, C.look))
    out.push(...chipRows(open ? ["removeFlatten", "removeLeave", "keep"] : ["removeYes", "keep"], b.name, width))
  } else {
    out.push(...chipRows(botChips(b, book, width), b.name, width))
    // The way to a wallet of its own, as its card offered it, for after it's approved: the same chip, the same steps.
    if (b.ownWallet?.length) {
      const why = b.sharedWith?.length ? `Its wallet is shared with ${sharedWithWords(b.sharedWith, ", ")}.` : "Its wallet asks every time, so each buy waits for you."
      out.push(blank())
      for (const l of wrap(`${why} A wallet of its own is the better way: it can lose only what that wallet holds.`, width)) out.push(line(l, C.look))
      for (const f of b.ownWallet) out.push({ segs: [{ ...chip(fit(f.label, Math.max(4, width - 2)), "fill"), ref: f.line }] })
    }
  }
  out.push(blank())
  const slots = b.definition.sizing.max_concurrent
  out.push(line(`open ${book?.open.length ?? 0} of ${slots}`, C.head))
  if (!book?.open.length) out.push(line(b.state === "stopped" ? "Nothing open." : "Nothing open: it buys when its pattern fires.", C.dim))
  for (const p of book?.open ?? []) out.push(...positionLines(p, width, input.now, b.name))
  if (book?.open.some((p) => p.entryUsd !== undefined && p.nowUsd !== undefined)) out.push(line(fit(width >= 56 ? "├ stop  ┼ entry  ● now  ╎ trailing, once armed  ┤ target" : "├ stop ┼ entry ● now ╎ trail ┤ target", width), C.dim))
  out.push(blank())
  const labelled = (label: string, segs: Seg[]) => out.push({ segs: [{ text: label.padEnd(LABEL), fg: C.head }, ...segs] })
  if (book) {
    const approx = b.mode === "paper" ? "≈" : ""
    // Realized in all, then the part of it since midnight here, then what's open: each says which it is, since today's
    // can be more than the whole when it lost before midnight.
    labelled("book", [
      { text: "realized ", fg: C.dim },
      { text: `${approx}${signedMoney(book.realizedUsd)}`, fg: tone(book.realizedUsd) },
      { text: " in all · ", fg: C.dim },
      { text: `${approx}${signedMoney(book.todayUsd)}`, fg: tone(book.todayUsd) },
      { text: " since midnight", fg: C.dim },
    ])
    if (book.unrealizedUsd !== undefined) labelled("", [{ text: "open ", fg: C.dim }, { text: `${approx}${signedMoney(book.unrealizedUsd)}`, fg: tone(book.unrealizedUsd) }, { text: " on what it holds now", fg: C.dim }])
    if (book.closed) {
      const by = book.exitsBy.map((e) => `${e.count} ${EXIT_SHORT[e.reason] ?? e.reason}`).join(", ")
      for (const [i, l] of wrap(`${book.closed} closed${by ? `: ${by}` : ""}${book.valued ? "" : "; some not valued"}`, width - LABEL).entries()) out.push({ segs: [{ text: "".padEnd(LABEL), fg: C.dim }, { text: l, fg: i === 0 ? C.dim : C.dim }] })
    }
  }
  for (const [i, l] of wrap(backtestLine(book), width - LABEL).entries()) out.push({ segs: [{ text: (i === 0 ? "backtest" : "").padEnd(LABEL), fg: C.head }, { text: l, fg: C.dim }] })
  if (book?.skips) {
    const by = book.skips.by.map((s) => `${s.count} ${s.why}`).join(", ")
    for (const [i, l] of wrap(`${book.skips.total} in the last day: ${by}`, width - LABEL).entries()) out.push({ segs: [{ text: (i === 0 ? "skipped" : "").padEnd(LABEL), fg: C.head }, { text: l, fg: C.dim }] })
  }
  for (const [i, f] of (book?.recent ?? []).slice(0, 3).entries()) {
    const words = fillWords(f)
    out.push({ segs: [{ text: (i === 0 ? "last" : "").padEnd(LABEL), fg: C.head }, { text: fit(`${clock(f.at)}  ${words}`, width - LABEL - (f.realizedUsd !== undefined ? 9 : 0)), fg: C.ink }, ...(f.realizedUsd !== undefined ? [{ text: `  ${signedMoney(f.realizedUsd)}`, fg: tone(f.realizedUsd) }] : [])] })
  }
  if ((book?.recent ?? []).slice(0, 3).some(againstItsExit)) out.push(...wrap(AGAINST_NOTE, width).map((l) => line(l, C.dim)))
  if (b.mode === "paper") out.push(blank(), line(fit("On paper: its figures are at quoted prices, ≈.", width), C.dim))
  return out
}

/** The hint under the overlay, by where the keys are. */
export function botsHint(o: BotsState, wide: boolean, confirm: boolean): string {
  if (confirm) return "a chip answers it · esc keeps it"
  if (!wide && o.side === "list") return "↑/↓ a bot · → its bot · esc closes"
  return "↑/↓ a bot · ⏎ pause or resume · ctrl-t ask the agent · esc closes"
}

/** The Bots pane's title: its count, or plain on Free and before any. */
export const botsTitle = (topic: BotsTopic | undefined, killed = false): string => (everyBot(topic).length ? `Bots · ${botsCountWords(topic, killed)}` : "Bots")
/** The picked bot's pane title: its name and whose. */
export const botTitle = (b: AnyBot | undefined): string => (b ? `${b.name} · ${b.agent}'s${b.kind === "code" ? " · code bot" : ""}` : "Bot")

/** A chip's ref that names something of a bot's after a `/`: a control's id, or a position. */
export const botPartRef = (action: "control" | "dropExits" | "dropExitsYes", name: string, part: string): string => `${action}:${name}/${part}`
/** A ref's bot and what of its it names: a bot's name never holds a `/`. */
export function botPart(name: string): { bot: string; part: string } | undefined {
  const i = name.indexOf("/")
  return i > 0 && i < name.length - 1 ? { bot: name.slice(0, i), part: name.slice(i + 1) } : undefined
}

/** The ask a held exit's removal makes, for the confirm and its test. */
export const dropExitsWords = (token: string) => `Remove the exits the core holds on ${token}? Its code sells it from then on, and nothing does while the bot is stopped or down.`

/**
 * A code bot's chips: pause or back on and stop as a rules bot's; flatten while it holds anything; its process
 * started again where it isn't running here; its log where the Candle Harness keeps one; then the agent, and remove.
 * It has no go live or replay: a wider change is a card its Build pane proposes, and its code isn't a definition.
 */
function codeBotChips(b: CodeBotView, book: BotBookView | undefined): BotAction[] {
  const open = (book?.open.length ?? 0) > 0
  const p = b.process
  const startable = p !== undefined && p.runs === "harness" && (p.state === "gave_up" || p.state === "down" || p.state === "ended" || p.state === "waits")
  return [
    ...(b.state === "on" ? (["pause", "stop"] as const) : b.state === "paused" ? (["resume", "stop"] as const) : (["resume"] as const)),
    ...(open ? (["flatten"] as const) : []),
    ...(b.heldExits?.some((h) => h.waits) ? (["retry"] as const) : []),
    ...(startable && b.state !== "stopped" ? (["start"] as const) : []),
    ...(p?.runs === "harness" ? (["log"] as const) : []),
    "ask" as const,
    "remove" as const,
  ]
}

const pct1 = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)))

/** Its process, on one line with a dot: running here and for how long, its restarts, memory and CPU (together, once CPU has its first sample, so the line doesn't change shape twice); or what's wrong. */
function processLines(b: CodeBotView, now: number, width: number): Line[] {
  const p = b.process
  const dot = (fg: string): Seg => ({ text: "● ", fg })
  const one = (fg: string, text: string, dotFg = fg): Line[] => {
    const [first, ...rest] = wrap(text, Math.max(10, width - 2))
    return [{ segs: [dot(dotFg), { text: first ?? "", fg }] }, ...rest.map((l) => line(`  ${l}`, fg))]
  }
  const out: Line[] = []
  if (!p) out.push(...one(b.connected ? C.ink : C.look, b.connected ? "connected" : "not connected", b.connected ? C.good : C.look))
  else if (p.state === "running") {
    const up = p.since ? `up ${heldWords(now - Date.parse(p.since))}` : "running"
    // Paused or stopped, its process stays up by design (its sells and held exits still run): said so, without
    // the green dot, so a running process doesn't read as a bot that's buying.
    const idle = b.state === "paused" || b.state === "stopped"
    const bits = [idle ? `its process is up · takes no buys while ${b.state}` : "running here", up, p.crashes ? `${p.crashes} crash${p.crashes === 1 ? "" : "es"} in 10 min` : "no restarts", ...(p.memoryMb !== undefined && p.cpuPct !== undefined ? [`${Math.round(p.memoryMb)} MB`, `${pct1(p.cpuPct)}% CPU`] : []), ...(b.connected ? [] : ["not connected yet"])]
    out.push(...one(C.ink, bits.join(" · "), idle ? C.dim : C.good))
  } else if (p.state === "outside") {
    const bits = ["runs outside the Candle Harness", b.connected ? "connected" : "not connected", ...(b.token ? [] : [`no token yet: candle-harness bots token ${b.name}`])]
    out.push(...one(b.connected ? C.ink : C.look, bits.join(" · "), b.connected ? C.good : C.look))
  } else if (p.state === "starting") out.push(...one(C.dim, "starting"))
  else out.push(...one(p.state === "gave_up" ? C.bad : C.look, p.words))
  if (p?.warning) for (const l of wrap(p.warning, width)) out.push(line(l, C.look))
  return out
}

/** One position a code bot holds: on its gauge with "exits held by the core", or "no exits held: its code sells". */
function codePositionLines(b: CodeBotView, p: BotPositionView, held: CodeHeldExitView | undefined, width: number, now: number, confirm: BotConfirm | undefined): Line[] {
  const all = positionLines(p, width, now, b.name)
  const pick = all[0]?.pick
  const out: Line[] = []
  if (held) {
    out.push(...all)
    const last = out[out.length - 1]!
    const add = " · exits held by the core"
    const used = last.segs.reduce((n, s) => n + s.text.length, 0)
    if (used + add.length <= width) out[out.length - 1] = { ...last, segs: [...last.segs, { text: add, fg: C.dim }] }
    else out.push({ segs: [{ text: `${" ".repeat(TOKEN_W)}exits held by the core`, fg: C.dim }], ...(pick ? { pick } : {}) })
    if (held.selling) out.push(line(fit(`${" ".repeat(TOKEN_W)}an exit is selling it now`, width), C.look))
    if (held.waits) for (const l of wrap(held.waits, Math.max(10, width - TOKEN_W))) out.push(line(`${" ".repeat(TOKEN_W)}${l}`, C.look))
    if (confirm?.what === "exits" && confirm.position === p.id) {
      for (const l of wrap(dropExitsWords(p.token), Math.max(10, width - TOKEN_W))) out.push(line(`${" ".repeat(TOKEN_W)}${l}`, C.look))
      const yes = { ...chip(CHIP_WORDS.dropExitsYes, "bot", "primary"), ref: botPartRef("dropExitsYes", b.name, p.id) }
      const keep = { ...chip(CHIP_WORDS.keep, "bot"), ref: botRef("keep", b.name) }
      out.push({ segs: [{ text: " ".repeat(TOKEN_W), fg: C.ink }, yes, { text: "  ", fg: C.ink }, keep] })
    } else if (!held.selling) out.push({ segs: [{ text: " ".repeat(TOKEN_W), fg: C.ink }, { ...chip(CHIP_WORDS.dropExits, "bot"), ref: botPartRef("dropExits", b.name, p.id) }] })
    return out
  }
  const change = p.entryUsd !== undefined && p.nowUsd !== undefined ? pctOf(p.nowUsd, p.entryUsd) : undefined
  const head: Seg = { text: fit(p.token, TOKEN_W - 1).padEnd(TOKEN_W), fg: C.hi }
  const segs: Seg[] = [head]
  if (change !== undefined) segs.push({ text: signedPct(change).padStart(PCT_W - 1).padEnd(PCT_W), fg: tone(change) })
  else if (p.noPriceSince !== undefined) segs.push({ text: `no price on Candle since ${hhmm(p.noPriceSince)} · `, fg: C.look })
  segs.push({ text: fit("no exits held: its code sells", Math.max(4, width - TOKEN_W - (change !== undefined ? PCT_W : 0))), fg: C.dim })
  out.push({ segs, ...(pick ? { pick } : {}) }, ...all.slice(1))
  return out
}

const SAYS_LABEL = 8

/** What the bot says about itself, headed as its own words: its status, alerts, rules, counts, newest events, and the controls it offers. */
function saysLines(b: CodeBotView, width: number, now: number): Line[] {
  const r = b.says
  if (!r) return wrap("The bot says nothing about itself yet: what it reports shows here, beside the core's count.", width).map((l) => line(l, C.dim))
  const secs = Math.max(0, Math.round((now - Date.parse(r.at)) / 1000))
  const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.round(secs / 60)}m` : heldWords(secs * 1000)
  const out: Line[] = [{ segs: [{ text: "the bot says", fg: C.head }, { text: fit(` · ${ago} ago · its own words, not the core's count`, Math.max(0, width - 12)), fg: C.dim }] }]
  const labelled = (label: string, text: string, fg: string) => {
    for (const [i, l] of wrap(text, Math.max(10, width - SAYS_LABEL)).entries()) out.push({ segs: [{ text: (i === 0 ? label : "").padEnd(SAYS_LABEL), fg: C.head }, { text: l, fg }] })
  }
  if (r.status || r.health) labelled("status", [r.health, r.status].filter(Boolean).join(" · "), r.health === "error" ? C.bad : r.health === "warn" ? C.look : C.ink)
  for (const a of r.alerts.slice(0, 3)) labelled("alert", a.text, C.look)
  for (const rule of r.rules.slice(0, 3)) labelled("rules", rule, C.ink)
  if (r.counts.length) labelled("counts", r.counts.map((c) => `${c.name} ${c.value}`).join(" · "), C.ink)
  for (const e of r.events.slice(0, 3)) labelled("event", `${hhmm(e.at)} ${e.text}`, C.ink)
  for (const [i, c] of (b.controls ?? []).entries()) {
    const how = c.how === "same" ? "runs so already" : c.how === "card" ? "a card for you" : "at once"
    out.push({ segs: [{ text: (i === 0 ? "offers" : "").padEnd(SAYS_LABEL), fg: C.head }, { ...chip(fit(c.label, Math.max(4, width - SAYS_LABEL - 20)), "bot"), ref: botPartRef("control", b.name, c.id) }, { text: `  ${how}`, fg: C.dim }] })
  }
  return out
}

/**
 * A code bot in full: what it runs and where, its process, its mode, wallet and today's use of its
 * figures, its chips (or the question flatten or remove asks), then its open positions (each on its gauge where the
 * core holds its exits, else "its code sells"), what the bot says about itself, and below, the core's count.
 */
function codeBotDetailLines(b: CodeBotView, book: BotBookView | undefined, input: { width: number; now: number; confirm?: BotConfirm; head?: boolean; killed?: boolean }): Line[] {
  const { width, now } = input
  const out: Line[] = []
  if (input.head) out.push({ segs: [{ text: fit(b.name, width), fg: C.hi, bold: true }, { text: fit(` · ${b.agent}'s · code bot`, Math.max(0, width - b.name.length)), fg: C.dim }] }, blank())
  for (const [i, l] of wrap(`${b.commandShown} in ${b.folderShown}`, Math.max(10, width - 5)).entries()) out.push({ segs: [{ text: i === 0 ? "Runs " : "     ", fg: C.dim }, { text: l, fg: C.ink }] })
  out.push(...processLines(b, now, width))
  const pays = b.paysFrom ?? (b.wallet === "embedded" ? "embedded" : b.wallet)
  const open = book?.open.length ?? 0
  const today = b.usedTodayUsd !== undefined ? `${usd(b.usedTodayUsd)} of ${usd(b.perDayUsd)} today` : `${usd(b.perDayUsd)} a day`
  const state = b.state === "on" ? "" : ` · ${b.stateWords ?? b.state}`
  for (const [i, l] of wrap(`${b.mode} · pays from ${pays}${state} · ${usd(b.perTradeUsd)} a trade · ${today}`, width).entries()) {
    if (i === 0 && l.startsWith(b.mode)) out.push({ segs: [{ text: b.mode, fg: b.mode === "live" ? C.good : C.dim }, { text: l.slice(b.mode.length), fg: b.state === "paused" ? C.look : C.dim }] })
    else out.push(line(l, b.state === "paused" ? C.look : C.dim))
  }
  if (b.held) for (const l of wrap(b.held.words, width)) out.push(line(l, C.look))
  else if (input.killed && b.state === "on") for (const l of wrap("held by the kill switch: its buys wait; its sells of its own and the exits the core holds still sell", width)) out.push(line(l, C.look))
  if (b.slippageLooser && b.maxSlippageBps !== undefined) out.push(line(fit(`its own slippage bound, ${b.maxSlippageBps / 100}%: looser than the route's`, width), C.look))
  out.push(blank())
  const c = input.confirm?.name === b.name ? input.confirm : undefined
  if (c?.what === "flatten") {
    for (const l of wrap(`Flatten "${b.name}"? The core sells every open position of its own now, at market: no card. A sell its code has under way finishes. ${flattenStays(b.state, "its code")}`, width)) out.push(line(l, C.look))
    out.push(...chipRows(flattenChoices(b.state), b.name, width))
  } else if (c?.what === "remove") {
    for (const l of wrap(open ? `Remove "${b.name}"? It holds ${open} open position${open === 1 ? "" : "s"}: flatten them first, or leave them in the wallet with no exits. Its process stops and its token is revoked.` : `Remove "${b.name}"? It's taken out of bots.toml, its process stops and its token is revoked; its record stays in the journal.`, width)) out.push(line(l, C.look))
    out.push(...chipRows(open ? ["removeFlatten", "removeLeave", "keep"] : ["removeYes", "keep"], b.name, width))
  } else out.push(...chipRows(botChips(b, book, width), b.name, width, undefined, true))
  out.push(blank())
  out.push({ segs: [{ text: `open ${open} of ${b.maxOpen}`, fg: C.head }, { text: fit(" · the core's count from its fills", Math.max(0, width - 12)), fg: C.dim }] })
  if (!open) out.push(line("Nothing open.", C.dim))
  for (const p of book?.open ?? []) out.push(...codePositionLines(b, p, b.heldExits?.find((h) => h.position === p.id), width, now, c))
  if (book?.open.some((p) => b.heldExits?.some((h) => h.position === p.id) && p.entryUsd !== undefined && p.nowUsd !== undefined)) out.push(line(fit(width >= 56 ? "├ stop  ┼ entry  ● now  ╎ trailing, once armed  ┤ target" : "├ stop ┼ entry ● now ╎ trail ┤ target", width), C.dim))
  out.push(blank(), ...saysLines(b, width, now), blank())
  // Below: the core's count from its fills, never what the bot says.
  out.push(line(fit("the core's count · from its fills", width), C.head))
  const approx = b.mode === "paper" ? "≈" : ""
  const labelled = (label: string, segs: Seg[]) => out.push({ segs: [{ text: label.padEnd(LABEL), fg: C.head }, ...segs] })
  if (!book || (book.closed === 0 && book.open.length === 0 && book.recent.length === 0)) out.push(line("No fills yet.", C.dim))
  else {
    labelled("today", [
      { text: "realized ", fg: C.dim },
      { text: `${approx}${signedMoney(book.todayUsd)}`, fg: tone(book.todayUsd) },
      ...(book.unrealizedUsd !== undefined ? [{ text: " · open ", fg: C.dim }, { text: `${approx}${signedMoney(book.unrealizedUsd)}`, fg: tone(book.unrealizedUsd) }] : []),
    ])
    const by = book.exitsBy.map((e) => `${e.count} ${EXIT_SHORT[e.reason] ?? e.reason}`).join(", ")
    const all = `${book.closed} closed${by ? `: ${by}` : ""}${book.valued ? "" : "; some not valued"}`
    labelled("in all", [{ text: "realized ", fg: C.dim }, { text: `${approx}${signedMoney(book.realizedUsd)}`, fg: tone(book.realizedUsd) }, { text: fit(` · ${all}`, Math.max(0, width - LABEL - 18)), fg: C.dim }])
    for (const [i, f] of book.recent.slice(0, 3).entries()) {
      const words = fillWords(f)
      out.push({ segs: [{ text: (i === 0 ? "last" : "").padEnd(LABEL), fg: C.head }, { text: fit(`${clock(f.at)}  ${words}`, width - LABEL - (f.realizedUsd !== undefined ? 9 : 0)), fg: C.ink }, ...(f.realizedUsd !== undefined ? [{ text: `  ${signedMoney(f.realizedUsd)}`, fg: tone(f.realizedUsd) }] : [])] })
    }
  }
  if ((book?.recent ?? []).slice(0, 3).some(againstItsExit)) out.push(...wrap(AGAINST_NOTE, width).map((l) => line(l, C.dim)))
  if (b.mode === "paper") out.push(blank(), line(fit("On paper: its figures are at quoted prices, ≈.", width), C.dim))
  return out
}

/** A log line as the supervisor keeps it: its time, then `out`, `err` or `---` (the Candle Harness's own), then the text. */
export interface BotLogLine {
  at?: string
  from: "out" | "err" | "core"
  text: string
}

export function readBotLogLine(raw: string): BotLogLine {
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (out|err|---)  ?(.*)$/.exec(raw)
  if (!m) return { from: "out", text: raw }
  return { at: m[1]!, from: m[2] === "err" ? "err" : m[2] === "---" ? "core" : "out", text: m[3]! }
}

/** What the log overlay holds: the bot's newest lines as read, or why it couldn't be read. */
export interface BotLogHeld {
  name: string
  lines?: string[]
  file?: string
  error?: string
}

/** The log as the overlay draws it: each line its local time, where it came from, and the text; stderr only on ask. */
export function botLogLines(held: BotLogHeld | undefined, only?: "err"): string[] {
  if (!held) return ["Reading its log…"]
  if (held.error) return [held.error]
  const read = (held.lines ?? []).map(readBotLogLine).filter((l) => !only || l.from === "err")
  if (!read.length) return [only ? "Nothing on stderr in what's kept." : "Its log is empty: the bot hasn't written anything yet."]
  const time = (iso?: string) => {
    if (!iso) return "        "
    const d = new Date(iso)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
  }
  return read.map((l) => `${time(l.at)} ${(l.from === "err" ? "stderr" : l.from === "core" ? "core" : "").padEnd(6)} ${l.text}`)
}
