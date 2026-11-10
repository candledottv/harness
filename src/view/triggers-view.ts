// The Triggers overlay and pane, as lines: each trigger on the left (on or off, and how it runs), the picked one
// on the right in full (its line, its words, how it runs and why, what it checks, when it fired), and its chips.
// Pure, so a test reads what's drawn; the keys are keys.ts's, the drawing panes/triggers.tsx's.
import type { TriggersTopic, TriggerView } from "../core/triggers"
import { wrap } from "./format"
import { blank, chip, type Line, line, type Seg } from "./panes/lines"
import { C, fit } from "./theme"

export interface TriggersState {
  kind: "triggers"
  /** The picked trigger, among those found. */
  index: number
  /** Below the wide width, the list or the picked trigger. */
  side: "list" | "detail"
  /** What's typed to find a trigger by its name, line or agent. */
  find?: string
  /** "remove" asks once before it removes the picked trigger. */
  confirm?: true
}

/** Below this the list takes the width, and → opens one trigger, as the approvals menu does. */
export const TRIGGERS_WIDE = 100
/** The list's width, wide. */
export const TRIGGERS_LIST_W = 41
/** What the chips and keys say, for each act a click or key makes. */
export type TriggersAct = "toggle" | "remove" | "removeYes" | "removeNo" | "ask" | "runNow" | "keepAwake" | "fill" | "list" | "planBuy"

/** The words "change the trigger …" puts on the input line, for the agent to propose the change as a card. */
export const askToChange = (t: Pick<TriggerView, "name">): string => `change the trigger "${t.name}": `

/**
 * The trigger cards that expired with nobody there and can still run again, by card: once one is run again (or
 * a later firing's card expires), its run it now chip goes. Undefined before the topic arrives: every chip shows,
 * and the core refuses one already run.
 */
export const runnableCards = (topic: TriggersTopic | undefined): ReadonlySet<string> | undefined =>
  topic ? new Set(topic.triggers.flatMap((t) => (t.expired ? [t.expired.cardId] : []))) : undefined

/** The triggers found by what's typed, in the file's order. */
export function triggersFound(topic: TriggersTopic | undefined, find: string | undefined): TriggerView[] {
  const all = topic?.triggers ?? []
  const q = find?.trim().toLowerCase()
  if (!q) return all
  return all.filter((t) => `${t.name} ${t.line} ${t.agent}`.toLowerCase().includes(q))
}

export const pickedTrigger = (topic: TriggersTopic | undefined, o: Pick<TriggersState, "index" | "find">): TriggerView | undefined => triggersFound(topic, o.find)[o.index]

/** "4 on · 1 off". */
export function countWords(topic: TriggersTopic | undefined): string {
  const all = topic?.triggers ?? []
  const on = all.filter((t) => t.on).length
  const off = all.length - on
  return [`${on} on`, ...(off ? [`${off} off`] : [])].join(" · ")
}

/** How it runs, short, for its row in the list: and the colour it's said in. */
export function kindShort(t: TriggerView): { text: string; fg: string } {
  if (t.held && t.on) return { text: "held", fg: C.look }
  if (!t.on) return { text: "off", fg: C.dim }
  if (t.expired) return { text: "◷ card expired", fg: C.look }
  switch (t.runs?.runs) {
    case "asks":
      return { text: "asks you", fg: C.look }
    case "own":
      return { text: "on its own", fg: C.ink }
    case "notifies":
      return { text: "notifies", fg: C.ink }
    case "wakes":
      return { text: "wakes", fg: C.ink }
    default:
      return { text: "", fg: C.dim }
  }
}

/** HH:MM today, else the weekday and the time, local. */
export function whenWords(iso: string, now: number): string {
  const d = new Date(iso)
  const clock = d.toTimeString().slice(0, 5)
  if (d.toDateString() === new Date(now).toDateString()) return clock
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return `yesterday ${clock}`
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${clock}`
}

const minutes = (ms: number): string => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`)

/** The kind as a title, then the rest: "asks you each time" and its why, from how it runs in words. */
export function runsParts(t: TriggerView): { title: string; body: string } | undefined {
  if (!t.runs) return undefined
  const split = /^([^:]{3,40}): (.+)$/s.exec(t.runs.words)
  if (!split) return { title: t.runs.runs === "own" ? "runs on its own" : "how it runs", body: t.runs.words }
  return { title: `${split[1]![0]!.toLowerCase()}${split[1]!.slice(1)}`, body: `${split[2]![0]!.toUpperCase()}${split[2]!.slice(1)}` }
}

const LABEL = 10

/**
 * The picked trigger in full: its name and whose it is, its exact line and its words, how it runs (in amber where
 * each firing waits for you, with a wallet of its own as chips), what it checks, when it fired, whether it fires
 * again, and its chips. `confirm` asks once before remove.
 */
export function triggerDetail(t: TriggerView | undefined, input: { width: number; now: number; confirm?: boolean; topic?: TriggersTopic }): Line[] {
  const width = Math.max(20, input.width)
  if (!t) return [blank(), ...wrap(emptyWords(input.topic), width).map((l) => line(l, C.dim))]
  const out: Line[] = [blank()]
  const pays = t.paysFrom ? ` · pays from ${t.paysFrom}` : ""
  out.push({ segs: [{ text: fit(t.name, width), fg: C.hi, bold: true }, { text: fit(` · ${t.agent}'s${pays}`, Math.max(0, width - t.name.length)), fg: C.dim }] })
  out.push(blank())
  for (const l of wrap(t.line, width)) out.push(line(l, t.on ? C.hi : C.dim))
  for (const l of wrap(t.words, width)) out.push(line(l, C.ink))
  if (t.held) for (const l of wrap(t.held.words, width)) out.push(line(l, C.look))
  if (t.readsNow) for (const l of wrap(t.readsNow, width)) out.push(line(l, C.dim))
  out.push(blank())
  const labelled = (label: string, text: string, fg: string = C.ink, rest: string = C.ink) => {
    wrap(text, width - LABEL).forEach((l, i) => out.push({ segs: [{ text: (i === 0 ? label : "").padEnd(LABEL), fg: C.dim }, { text: l, fg: i === 0 ? fg : rest }] }))
  }
  const parts = runsParts(t)
  if (parts) {
    const asks = t.runs?.runs === "asks"
    labelled("runs", parts.title, asks ? C.look : C.ink)
    labelled("", parts.body)
    if (asks) for (const f of t.fills ?? []) out.push({ segs: [{ text: "".padEnd(LABEL), fg: C.dim }, { ...chip(fit(f.label, width - LABEL - 2), "fill"), ref: f.line }] })
    out.push(blank())
  }
  if (t.watching) labelled("checks", t.watching.replace(/^checked /, ""))
  else if (t.nextRun) labelled("next", whenWords(t.nextRun, input.now))
  labelled("fired", t.lastFired ? whenWords(t.lastFired, input.now) : "never")
  if (t.expired) out.push({ segs: [{ text: "".padEnd(LABEL), fg: C.dim }, { text: `its card expired ${whenWords(t.expired.at, input.now)}, nobody pressed it  `, fg: C.look }, { ...chip("run it now", "runNow"), ref: t.expired.cardId }] })
  if (t.class === "level") labelled("again", t.again ? `yes, each time it crosses back${t.cooldownMs ? `, ${minutes(t.cooldownMs)} apart` : ""}` : "no: fires once, then switches off")
  else if (t.cooldownMs) labelled("cooldown", minutes(t.cooldownMs))
  out.push(blank())
  if (input.confirm) {
    for (const l of wrap(`Remove "${t.name}"? It's taken out of triggers.toml; the agent can propose it again.`, width)) out.push(line(l, C.look))
    out.push({ segs: [{ ...chip("remove it", "fill", "primary"), ref: "removeYes" }, { text: "  ", fg: C.ink }, { ...chip("keep it", "fill"), ref: "removeNo" }] })
  } else {
    const chips: Seg[] = [
      { ...chip(t.on ? "switch off" : "switch on", "fill"), ref: "toggle" },
      { ...chip("remove", "fill"), ref: "remove" },
      { ...chip(width >= 50 ? "ask the agent to change it" : "ask the agent", "fill"), ref: "ask" },
    ]
    const row: Seg[] = []
    let used = 0
    for (const c of chips) {
      if (used && used + 2 + c.text.length > width) {
        out.push({ segs: [...row] })
        row.length = 0
        used = 0
      }
      if (used) row.push({ text: "  ", fg: C.ink })
      row.push(c)
      used += (used ? 2 : 0) + c.text.length
    }
    out.push({ segs: row })
  }
  if (t.class === "level") {
    out.push(blank())
    for (const l of wrap("A level checks Candle's price about every 5 s, so a fast move can pass through it before the trade is sent.", width)) out.push(line(l, C.dim))
  }
  return out
}

/** What the overlay and the pane say before a trigger is saved, or on Free. */
export function emptyWords(topic: TriggersTopic | undefined): string {
  if (topic?.gate) return `${topic.gate.words}.`
  if (!topic) return "Reading the triggers…"
  return 'No triggers yet. Ask the agent: "sell half my JUPF if it drops below $0.40", or "every weekday at 09:00 buy $1 of JUP".'
}

/** On Free: the plan's words, and the chip that puts `candle plan buy` on the input line. */
export function gateLines(topic: TriggersTopic, width: number): Line[] {
  const gate = topic.gate!
  const out: Line[] = [blank(), line(`${gate.words}.`, C.hi), blank()]
  for (const l of wrap("A trigger watches a price, a schedule or Hacc's tape, and acts for you: a trade, a notification, or a word to your agent.", width)) out.push(line(l, C.ink))
  if (gate.fix) out.push(blank(), { segs: [{ ...chip(gate.fix, "fill"), ref: "planBuy" }, { text: "  goes on the input line", fg: C.dim }] })
  return out
}

/** One row of the list: ● on or ○ off, the name, and how it runs on the right. */
export function listRow(t: TriggerView, width: number): { left: Seg[]; right: Seg } {
  const k = kindShort(t)
  return { left: [{ text: t.on ? "● " : "○ ", fg: t.on ? C.good : C.dim }, { text: fit(t.name, Math.max(4, width - 2 - k.text.length - 2)), fg: t.on ? C.hi : C.dim }], right: { text: k.text, fg: k.fg } }
}

/** The hint under the overlay, by where the keys are. */
export function triggersHint(o: TriggersState, wide: boolean, t: TriggerView | undefined): string {
  if (o.confirm) return "⏎ removes it · esc keeps it"
  const run = t?.expired ? " · ctrl-r run it now" : ""
  if (o.find !== undefined) return `↑/↓ a trigger found · ⏎ on or off · esc ends the search`
  if (!wide && o.side === "list") return `↑/↓ a trigger · type to find · → its trigger · esc closes`
  return `↑/↓ a trigger · ⏎ on or off${run} · ctrl-t ask the agent · esc closes`
}

/**
 * The Triggers pane, for a layout of your own: two lines each, how it runs and what it checks, then a chip to the
 * overlay, where a trigger is switched off, removed or run again. The pane itself never changes one.
 */
export function triggersPaneLines(topic: TriggersTopic | undefined, width: number, now: number): Line[] {
  if (!topic || topic.gate || topic.triggers.length === 0) {
    const out = wrap(emptyWords(topic), Math.max(10, width)).map((l) => line(l, C.dim))
    if (topic?.gate?.fix) out.push({ segs: [{ ...chip(topic.gate.fix, "fill"), ref: topic.gate.fix }] })
    return out
  }
  const out: Line[] = []
  for (const t of topic.triggers) {
    const { left, right } = listRow(t, width)
    const used = left.reduce((n, s) => n + s.text.length, 0)
    out.push({ segs: [...left, { text: " ".repeat(Math.max(1, width - used - right.text.length)), fg: C.ink }, right], ref: t.name })
    const sub = t.expired ? `card expired ${whenWords(t.expired.at, now)}` : t.watching ? t.watching.replace(/^checked /, "") : t.nextRun ? `next ${whenWords(t.nextRun, now)}` : t.lastFired ? `fired ${whenWords(t.lastFired, now)}` : "never fired"
    out.push(line(`  ${fit(sub, Math.max(4, width - 2))}`, t.expired ? C.look : C.dim, { ref: t.name }))
  }
  for (const p of topic.problems) for (const l of wrap(p, Math.max(10, width))) out.push(line(l, C.look))
  // Changing one is the overlay's: switch off, remove, run it now, or ask the agent.
  out.push(blank(), { segs: [chip("all triggers", "triggers")] })
  return out
}
