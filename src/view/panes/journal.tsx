// The Journal pane: everything the core recorded, in words, newest first,
// from `journal.query` a page at a time. Above the rows, held while they scroll: the search line, which
// takes keys while it's focused (↑ from the first row, or its chip) and gives them back on Esc, and a chip
// for each kind, the core's own off by default. Each card's life is one row; ctrl-o on a row shows its
// rows as recorded, with ⧉. A row about a token picks it, as in every list.
import { DEFAULT_KINDS, JOURNAL_KINDS, type JournalEntry, type JournalKind, KIND_WORDS } from "../../core/journal-query"
import { askAbout } from "../ask"
import { wrap } from "../format"
import { C, fit } from "../theme"
import { clock, dayWords } from "./activity"
import { chip, type Line, line } from "./lines"
import { mixesChains, TAG_CELLS, withChainTag } from "./chain-tag"

/** What the Journal's search is, this view's own: the words typed, whether the line takes keys, and the kinds on. */
export interface JournalSearch {
  query: string
  editing?: true
  /** Unset, the default: every kind but the core's. */
  kinds?: readonly JournalKind[]
}

/** The rows this view holds for a search, as the core sent them, pages appended. */
export interface JournalHeld {
  /** The search they're for (journalKey). */
  key: string
  entries: JournalEntry[]
  /** Where the next page starts, while there is one. */
  more?: string
  /** Reading the first page, or the next. */
  loading?: "first" | "older"
  failed?: string
  /** How far back the last page read. */
  oldest?: string
}

/** A row's details, as `journal.rows` sent them (ctrl-o). */
export interface JournalRowsHeld {
  id: string
  rows?: Record<string, unknown>[]
  cut?: true
  failed?: string
}

export const kindsOf = (s: JournalSearch | undefined): readonly JournalKind[] => s?.kinds ?? DEFAULT_KINDS

/** A search as the core is asked it, and the key its rows are held by. */
export function journalFilter(s: JournalSearch | undefined): { text?: string; kinds: JournalKind[] } {
  const text = s?.query.trim() ?? ""
  return { ...(text ? { text } : {}), kinds: [...kindsOf(s)] }
}
export const journalKey = (s: JournalSearch | undefined): string => JSON.stringify(journalFilter(s))

/** A kind switched on or off; the last one on stays on, so the pane is never asked for nothing. */
export function toggleKind(s: JournalSearch | undefined, kind: JournalKind): JournalSearch {
  const on = kindsOf(s)
  const next = on.includes(kind) ? on.filter((k) => k !== kind) : JOURNAL_KINDS.filter((k) => k === kind || on.includes(k))
  return { query: s?.query ?? "", ...(s?.editing ? { editing: true as const } : {}), ...(next.length ? { kinds: next } : { kinds: on }) }
}

const tone = (t: JournalEntry["tone"]): string => ({ info: C.ink, good: C.good, bad: C.bad, warn: C.look })[t]

const SEARCH_CHIP = "search"
const PLACEHOLDER = "↑ or a click to search everything recorded: words, a token, an agent"

/**
 * The lines held above the rows: the search line, then the kind chips, wrapped to the width. Typing, the
 * line shows a cursor and is shaded, and says how to give the keys back.
 */
export function journalHead(s: JournalSearch | undefined, width: number): Line[] {
  const query = s?.query ?? ""
  const editing = s?.editing === true
  const lead = chip(SEARCH_CHIP, "journalSearch")
  const room = Math.max(0, width - lead.text.length - 1)
  // What's typed keeps its end in view; the hint shows where there's room after it.
  const typed = query.length + 1 > room ? `…${query.slice(query.length + 2 - room)}` : query
  const hint = "   ⏎ done · esc back to the line"
  const search: Line = {
    segs: [
      lead,
      { text: " ", fg: C.ink },
      ...(query || editing ? [{ text: typed, fg: C.hi }, ...(editing ? [{ text: "▏", fg: C.focus }] : [])] : [{ text: fit(PLACEHOLDER, room), fg: C.dim }]),
      ...(editing && typed.length + 1 + hint.length <= room ? [{ text: hint, fg: C.dim }] : []),
    ],
    ...(editing ? { bg: C.sel } : {}),
  }
  const on = kindsOf(s)
  // Where every chip won't fit on one row, the kill switch's says "kill", then the ticks lose their space (80 columns).
  const label = (k: JournalKind, tier: number) => `${on.includes(k) ? (tier > 1 ? "✓" : "✓ ") : ""}${tier > 0 && k === "kill" ? "kill" : KIND_WORDS[k]}`
  const cellsAt = (tier: number) => JOURNAL_KINDS.reduce((n, k) => n + label(k, tier).length + 3, -1)
  const tier = [0, 1, 2].find((t) => cellsAt(t) <= width) ?? 2
  const rows: Line[] = [{ segs: [] }]
  let used = 0
  for (const k of JOURNAL_KINDS) {
    const c = chip(label(k, tier), "journalKind")
    // A space between chips; the row's last needs none after it.
    if (used > 0 && used + 1 + c.text.length > width) {
      rows.push({ segs: [] })
      used = 0
    }
    if (used > 0) rows.at(-1)!.segs.push({ text: " ", fg: C.ink })
    rows.at(-1)!.segs.push({ ...c, ref: k })
    used += (used > 0 ? 1 : 0) + c.text.length
  }
  return [search, ...rows]
}

/** The rows, newest first, a divider where the day changes; then older's chip, or what the search reached. */
export function journalLines(held: JournalHeld | undefined, s: JournalSearch | undefined, opts: { width: number; now: number }): Line[] {
  const width = Math.max(10, opts.width)
  const searching = (s?.query.trim() ?? "") !== ""
  if (!held || (held.loading === "first" && held.entries.length === 0)) return [line(searching ? "Searching the journal…" : "Reading the journal…", C.dim)]
  if (held.failed && held.entries.length === 0) return wrap(`The journal didn't answer: ${held.failed}`, width).map((t) => line(t, C.bad))
  if (held.entries.length === 0) {
    const since = held.oldest ? ` back to ${dayWords(held.oldest, opts.now)} ${clock(held.oldest)}` : ""
    const words = searching || s?.kinds ? `Nothing matched, searching everything recorded${since}.` : "Nothing recorded yet. Cards, trades, the agent's turns and the kill switch show here as they happen."
    return wrap(words, width).map((t) => line(t, C.dim))
  }
  const out: Line[] = []
  let lastDay: string | undefined
  // On more than one chain, each entry's first line ends with its chain.
  const tagged = mixesChains(held.entries.map((e) => e.chain))
  for (const e of held.entries) {
    const day = new Date(e.at).toDateString()
    if (day !== lastDay) {
      const words = dayWords(e.at, opts.now)
      out.push(line(`── ${words} ${"─".repeat(Math.max(0, width - words.length - 4))}`, C.dim))
      lastDay = day
    }
    const paper = e.mode === "paper" ? "paper · " : ""
    const parts = wrap(`${paper}${e.text}`, Math.max(10, width - 7 - (tagged ? TAG_CELLS : 0)))
    // Every line of an entry is its row: ↑/↓ and a click pick it, and ctrl-o shows its rows. Only one about a token moves the link.
    const pick = { id: e.id, mint: e.mint ?? "", ...(e.mint ? { ask: askAbout(e.symbol, e.mint, `From the Journal, ${dayWords(e.at, opts.now)} ${clock(e.at)}: ${clipped(e.text)}`) } : {}) }
    parts.forEach((part, i) => {
      if (i > 0) return out.push({ segs: [{ text: `       ${part}`, fg: C.ink }], key: e.id, pick })
      // The first word in its tone, as in Activity: an agent's name, "you", "kill", "refused".
      const rest = part.slice(paper.length)
      const word = e.tone === "info" ? "" : (/^\S+/.exec(rest)?.[0] ?? "")
      const segs = [{ text: `${clock(e.at)}  `, fg: C.dim }, ...(paper ? [{ text: paper, fg: C.dim }] : []), ...(word ? [{ text: word, fg: tone(e.tone) }] : []), { text: rest.slice(word.length), fg: C.ink }]
      out.push({ segs: tagged ? withChainTag(segs, e.chain, width) : segs, key: e.id, pick })
    })
    // Why a search matched a row whose words don't show it, dim under it.
    if (searching && e.matched) for (const part of wrap(`matched in ${e.matched}`, Math.max(10, width - 7))) out.push({ segs: [{ text: `       ${part}`, fg: C.dim }], key: e.id, pick })
  }
  if (held.loading === "older") out.push(line("Reading older…", C.dim))
  else if (held.failed) out.push(...wrap(`The next page didn't answer: ${held.failed}`, width).map((t) => line(t, C.bad)))
  else if (held.more) out.push({ segs: [chip("↓ older", "journalOlder")] })
  else out.push(line(held.entries.length === 1 ? "The journal's start: 1 row." : `The journal's start: ${held.entries.length} rows${searching || s?.kinds ? " matched" : ""}.`, C.dim))
  return out
}

const clipped = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text)

/** The details' lines: each row as recorded, one JSON line a row, a blank line between. */
export function journalRowsLines(held: JournalRowsHeld | undefined): string[] {
  if (!held || (!held.rows && !held.failed)) return ["Reading its rows…"]
  if (held.failed) return [`The journal didn't answer: ${held.failed}`]
  const rows = held.rows ?? []
  return [...rows.flatMap((r, i) => [...(i ? [""] : []), JSON.stringify(r)]), ...(held.cut ? ["", "(cut: its rows are over 128 KB; the rest are in journal.jsonl)"] : [])]
}

/** What ⧉ copies: the rows as recorded, one JSON line each. */
export const journalRowsText = (held: JournalRowsHeld | undefined): string => (held?.rows ?? []).map((r) => JSON.stringify(r)).join("\n")
