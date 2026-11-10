// What the Build tab's side column draws, from the core's `bots` topic and the bots folder as this view reads it:
// each bot folder and where it stands (a code bot, a paper test, or not proposed yet), and the paper test running,
// with the core's count from its paper fills and what the bot says about itself, never as figures. Pure, so a test
// can read them; the panes draw them.
import { join } from "node:path"
import type { BotBookView } from "../core/bot-books"
import type { BotsTopic } from "../core/bots"
import type { CodeBotView, CodeTestView } from "../core/code-bots"
import { usd, wrap } from "./format"
import { blank, chip, type Line, line, type Seg } from "./panes/lines"
import { C } from "./theme"

/** The bots folder as the view read it: where it is, `~` for the home, and the folders in it. */
export interface BuildFolder {
  path: string
  shown: string
  /** Its folders, by name, sorted: each a bot's own. */
  subs: readonly string[]
}

/** What a folder in the bots folder is now. */
export type FolderState =
  | { kind: "test"; test: CodeTestView }
  | { kind: "bot"; bot: CodeBotView }
  | { kind: "card"; change: boolean }
  | { kind: "none" }

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000))
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A folder's state: its test running first, else the code bot that runs from it, else none. */
export function folderState(folder: string, topic: BotsTopic | undefined): FolderState {
  const test = topic?.tests?.find((t) => t.folder === folder)
  if (test) return { kind: "test", test }
  const bot = topic?.code?.find((c) => c.folder === folder)
  if (bot) return { kind: "bot", bot }
  const card = topic?.codeCards?.find((c) => c.folder === folder)
  return card ? { kind: "card", change: card.change } : { kind: "none" }
}

/** A test's buys and what's open, from the core's count. */
function testCount(book: BotBookView | undefined): string {
  if (!book) return "no fills yet"
  const buys = book.recent.filter((f) => f.act === "in").length + book.closed
  const parts = [buys ? plural(Math.max(buys, book.open.length), "buy") : "no buys yet"]
  if (book.open.length) parts.push(`${book.open.length} open`)
  return parts.join(" · ")
}

function botState(b: CodeBotView): string {
  if (b.state === "stopped") return "stopped"
  if (b.state === "paused") return `${b.mode} · paused`
  if (b.held) return `${b.mode} · held`
  return b.mode
}

/** A process a harness left running after it exited, with a stop chip: never stopped unasked. */
export interface DaemonView {
  pid: number
  what: string
}

/** Each folder on two lines, then `open the folder`, and each daemon a harness left with its `stop`. */
export function folderLines(input: { folder: BuildFolder | undefined; topic: BotsTopic | undefined; daemons: readonly DaemonView[]; width: number; now: number }): Line[] {
  const { folder, topic, width, now } = input
  const w = Math.max(10, width)
  if (!folder) return wrap("Not set up yet: the Build pane asks where your bots go, then writes the folder.", w).map((t) => line(t, C.dim))
  const out: Line[] = []
  if (folder.subs.length === 0) out.push(...wrap(`No bot folders in ${folder.shown} yet. Ask your harness to write one: each bot gets a folder of its own.`, w).map((t) => line(t, C.dim)))
  const nameW = Math.min(14, Math.max(...folder.subs.map((s) => s.length), 4))
  for (const sub of folder.subs) {
    const s = folderState(join(folder.path, sub), topic)
    const name = sub.length > nameW ? `${sub.slice(0, nameW - 1)}…` : sub.padEnd(nameW)
    if (s.kind === "test") {
      const ran = minutes(now - Date.parse(s.test.startedAt))
      out.push({ segs: [{ text: "● ", fg: C.good }, { text: `${name} `, fg: C.ink }, { text: `paper test · ${ran}m`, fg: C.ink }] })
      out.push(line(`  ${testCount(topic?.books?.[s.test.name])}`, C.dim))
    } else if (s.kind === "bot") {
      const book = topic?.books?.[s.bot.name]
      const on = s.bot.state === "on" && !s.bot.held
      out.push({ segs: [{ text: on ? "● " : "○ ", fg: on ? C.good : C.dim }, { text: `${name} `, fg: C.ink }, { text: botState(s.bot), fg: on ? C.ink : C.dim }] })
      const today = book ? `${book.todayUsd >= 0 ? "+" : "-"}${usd(Math.abs(book.todayUsd))} today` : "no fills yet"
      out.push(line(`  ${today}${book?.open.length ? ` · ${book.open.length} open` : ""}`, C.dim))
    } else if (s.kind === "card") {
      out.push({ segs: [{ text: "○ ", fg: C.look }, { text: `${name} `, fg: C.ink }, { text: s.change ? "its change card waits" : "its card waits", fg: C.look }] })
      out.push(line("  for your press in the main window", C.dim))
    } else {
      out.push({ segs: [{ text: "○ ", fg: C.dim }, { text: `${name} `, fg: C.ink }, { text: "not proposed yet", fg: C.dim }] })
      out.push(line("  no card made", C.dim))
    }
    out.push(blank())
  }
  out.push({ segs: [{ text: " ", fg: C.ink }, { ...chip("open the folder", "build"), ref: "openFolder" }] })
  if (input.daemons.length) {
    out.push(blank(), ...wrap("Left running by your harness after it exited:", w).map((t) => line(t, C.ink)))
    for (const d of input.daemons) out.push({ segs: [{ text: " ", fg: C.ink }, { ...chip("stop", "build"), ref: `daemon:${d.pid}` }, { text: ` ${d.what} · pid ${d.pid}`, fg: C.dim }] })
  }
  return out
}

export function folderTitle(folder: BuildFolder | undefined): string {
  return folder ? `Bots folder · ${folder.subs.length}` : "Bots folder"
}

/** The newest test, the one the box shows: one runs at a time per folder, and a pane rarely has two. */
export const shownTest = (topic: BotsTopic | undefined): CodeTestView | undefined => topic?.tests?.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]

const clock = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/**
 * The paper test running: its time left, the core's count from its paper fills, what it says, then its newest fills
 * and its own events together, newest last. No log: its output is in the terminal that ran it.
 */
export function testLines(input: { topic: BotsTopic | undefined; width: number; now: number }): Line[] {
  const { topic, width, now } = input
  const w = Math.max(10, width)
  const t = shownTest(topic)
  if (topic?.gate) return wrap(`${topic.gate.words}. A paper test of a code bot needs one too; the harness and the folder still work.`, w).map((l) => line(l, C.dim))
  if (!t) {
    const idle = wrap("No test running. Ask your harness to test a bot on paper: candle-harness build test <folder> runs it for 30 minutes at most.", w).map((l) => line(l, C.dim))
    // The test that ended last: what it said as it ended, and what it left open in the paper book.
    const ended = topic?.testsEnded?.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    if (!ended) return idle
    return [...wrap(`${clock(ended.at)} ${ended.said}`, w).map((l) => line(l, C.ink)), blank(), ...idle]
  }
  const left = minutes(Date.parse(t.endsAt) - now)
  const book = topic?.books?.[t.name]
  const out: Line[] = [
    { segs: [{ text: `paper · ${left}m left`, fg: C.ink }, { text: t.connected ? " · connected" : " · not connected", fg: t.connected ? C.dim : C.look }] },
    { segs: [{ ...chip("stop test", "build"), ref: `stopTest:${t.name}` }] },
    blank(),
    line("the core's count · from its paper fills", C.head),
  ]
  for (const p of book?.open ?? []) {
    const change = p.entryUsd && p.nowUsd ? ((p.nowUsd - p.entryUsd) / p.entryUsd) * 100 : undefined
    const segs: Seg[] = [{ text: `${p.token.slice(0, 8).padEnd(8)} `, fg: C.ink }]
    if (change !== undefined) segs.push({ text: `${change >= 0 ? "+" : ""}${change.toFixed(1)}% `, fg: change >= 0 ? C.good : C.bad })
    segs.push({ text: `bought ${p.costUsd !== undefined ? usd(p.costUsd) : ""} at ${clock(p.since)}`.replace("  ", " "), fg: C.dim })
    out.push({ segs })
  }
  out.push(line(`${testCount(book)} · ${t.figures}`, C.dim))
  if (book?.open.length) out.push(...wrap(t.afterEnd, w).map((l) => line(l, C.dim)))
  if (t.says) {
    const ago = Math.max(0, Math.round((now - Date.parse(t.says.at)) / 1000))
    out.push(blank(), line(`the bot says · ${ago < 60 ? `${ago}s` : `${minutes(ago * 1000)}m`} ago`, C.head))
    if (t.says.status) out.push(...wrap(`status ${t.says.health ? `${t.says.health} · ` : ""}${t.says.status}`, w).map((l) => line(l, C.ink)))
    for (const r of t.says.rules.slice(0, 3)) out.push(...wrap(`rules  ${r}`, w).map((l) => line(l, C.ink)))
    for (const a of t.says.alerts.slice(0, 2)) out.push(...wrap(a.text, w).map((l) => line(l, C.look)))
  }
  // Its fills and its own events, by time: the newest at the foot.
  const rows: { at: string; text: string; fg: string }[] = [
    ...(book?.recent ?? []).map((f) => ({ at: f.at, text: `${f.act === "in" ? "bought" : "sold"} ${f.token}${f.usd !== undefined ? ` ${usd(f.usd)}` : ""}${f.reason ? ` · ${f.reason.replace(/_/g, " ")}` : ""}`, fg: C.ink })),
    ...(t.says?.events ?? []).map((e) => ({ at: e.at, text: `says ${e.text}`, fg: C.dim })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (rows.length) {
    out.push(blank())
    for (const r of rows.slice(-8)) out.push(...wrap(`${clock(r.at)} ${r.text}`, w).map((l, i) => line(i ? `      ${l}` : l, r.fg)))
  }
  return out
}

export function testTitle(topic: BotsTopic | undefined): string {
  const t = shownTest(topic)
  if (!t) return "Test run"
  const folder = t.folderShown.split("/").filter(Boolean).at(-1) ?? t.name
  return `Test run · ${folder}`
}

/** The folded strip's own words, before its chips: the test running, else the folder's count. */
export function foldWords(input: { folder: BuildFolder | undefined; topic: BotsTopic | undefined; now: number }): { text: string; fg: string } | undefined {
  const t = shownTest(input.topic)
  if (t) {
    const folder = t.folderShown.split("/").filter(Boolean).at(-1) ?? t.name
    return { text: `● ${folder} paper test · ${minutes(input.now - Date.parse(t.startedAt))}m · ${testCount(input.topic?.books?.[t.name])}`, fg: C.ink }
  }
  if (!input.folder) return undefined
  return { text: `${input.folder.shown} · ${plural(input.folder.subs.length, "bot folder")}`, fg: C.dim }
}
