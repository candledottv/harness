// The activity pane: the journal's user-facing rows in words, newest last
// (cards, fills, refusals, the kill switch, CLI runs, leftover processes), from the core's `activity`
// topic. The time dim; the outcome word in its colour (filled green, refused red, something to look at
// amber); the rest in the content colour.
import type { ActivityEntry } from "../../core/trade-log"
import { cellWidth, firingMark, wrap } from "../format"
import { C } from "../theme"
import { askAbout } from "../ask"
import { chip, type Line, line } from "./lines"

/** A line's colour by its tone, from the theme on screen. */
const tone = (t: "info" | "good" | "bad" | "warn"): string => ({ info: C.ink, good: C.good, bad: C.bad, warn: C.look })[t]

/** HH:MM, local time. */
export const clock = (iso: string): string => new Date(iso).toTimeString().slice(0, 5)

/** A local day, for the divider: "today", "yesterday", else the weekday and date. */
export function dayWords(iso: string, now: number): string {
  const day = (t: number) => new Date(t).toDateString()
  const at = new Date(iso).getTime()
  if (day(at) === day(now)) return "today"
  if (day(at) === day(now - 86_400_000)) return "yesterday"
  return new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
}

/**
 * Activity's lines. Where the day changes, a dim divider names the day the lines under it are from, so
 * yesterday's 15:51 doesn't read as today's (the times carried no date).
 */
export function activityLines(entries: readonly ActivityEntry[], width: number, now = Date.now(), tape: readonly Line[] = [], runnable?: ReadonlySet<string>): Line[] {
  const shown = entries.filter((e) => !e.hidden)
  if (shown.length === 0) {
    const quiet = wrap("Nothing yet. Cards, fills, refusals and the kill switch show here.", Math.max(10, width)).map((t) => line(t, C.dim))
    if (tape.length === 0) return quiet
    // Before the first line: Hacc's tape, dim, newest at the foot as Activity's
    // own lines will be, its label under it so it's always on screen. Its rows still pick their tokens.
    const dim = tape.map((l): Line => ({ ...l, segs: l.segs.map((seg) => ({ ...seg, fg: C.dim })) }))
    return [...dim, ...wrap("↑ Hacc's tape, until your first card", Math.max(10, width)).map((t) => line(t, C.ink))]
  }
  // A Hacc change the person can undo ends in an undo chip, until a later line undid it.
  const undone = new Set(entries.flatMap((e) => (e.undoes ? [e.undoes] : [])))
  const undoChip = chip("undo", "undo")
  // A trigger's card that expired with nobody there: proposed again at a fresh price, by the person's click.
  const runNowChip = chip("run it now", "runNow")
  const days = new Set(shown.map((e) => new Date(e.at).toDateString()))
  let lastDay: string | undefined
  return shown.flatMap((e) => {
    const day = new Date(e.at).toDateString()
    const divider = days.size > 1 && day !== lastDay ? [line(`── ${dayWords(e.at, now)} ${"─".repeat(Math.max(0, width - dayWords(e.at, now).length - 5))}`, C.dim)] : []
    lastDay = day
    const undo = e.undo && !undone.has(e.undo) ? e.undo : undefined
    const end = undo ? { chip: undoChip, ref: undo } : e.runNow && (!runnable || runnable.has(e.runNow)) ? { chip: runNowChip, ref: e.runNow } : undefined
    // A trigger's firing is one line: its name after ⚡ in the heading colour, what it saw, then what came of it.
    // A rules bot's is too, its entries, exits and skips folded. ⚡ takes two cells, one more than its length.
    const mark = e.firing ? firingMark(e.firing) : ""
    const parts = wrap(e.firing ? `${mark} ${e.firing.said}` : e.text, Math.max(10, width - 7 - (end ? end.chip.text.length + 1 : 0) - (cellWidth(mark) - mark.length)))
    return [...divider, ...parts.map((part, i): Line => {
      const tail = end && i === parts.length - 1 ? [{ text: " ", fg: C.ink }, end.chip] : []
      // Every line of an entry about a token picks it, as one row.
      const ref = { key: String(e.seq), ...(tail.length ? { ref: end!.ref } : {}), ...(e.mint ? { pick: { id: String(e.seq), mint: e.mint, ask: askAbout(undefined, e.mint, `From Activity, ${clock(e.at)}.`) } } : {}) }
      if (i > 0) return { segs: [{ text: `       ${part}`, fg: e.firing ? tone(e.tone) : C.ink }, ...tail], ...ref }
      if (e.firing) {
        const name = part.slice(0, Math.min(part.length, mark.length))
        return { segs: [{ text: `${clock(e.at)}  `, fg: C.dim }, { text: name, fg: C.head }, { text: part.slice(name.length), fg: tone(e.tone) }, ...tail], ...ref }
      }
      const word = e.tone === "info" ? "" : (/^\S+/.exec(part)?.[0] ?? "")
      return { segs: [{ text: `${clock(e.at)}  `, fg: C.dim }, ...(word ? [{ text: word, fg: tone(e.tone) }] : []), { text: part.slice(word.length), fg: C.ink }, ...tail], ...ref }
    })]
  })
}
