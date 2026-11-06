// While you were away, on screen: the core's summary of the gap (away.ts) in the Candle Harness's own words, never a
// model's.
//
// - The note on startup sits at the top of the agent pane, as the Candle Harness's row and not the agent's: "While you
//   were away · 3h 12m", its chips, then three to five lines in order of weight (the core not running,
//   anything stopped or refused, trades, P&L, signals, then the rest). Only in the view whose attach made the
//   summary, only when something happened, until the next message or its ✕. It never covers a waiting card:
//   it gets the rows the cards leave (agent.tsx).
// - Every section: each row that names a token is a pick, and each address has its ⧉. The note's show all
//   and the palette's row open it over the frame (AwayOverlay); the Away pane draws the same lines on a layout
//   of your own. It keeps the last gap's summary until the next one.
import { type AgentFills, type AwayCard, type AwayEntry, type AwaySummary, type AwayView, gapLength, type HoldingChange, type OutsideFill } from "../../core/away"
import { askAbout } from "../ask"
import { amount, shortAddress, wrap } from "../format"
import { C, fit, money, OVERLAY_Z, signedMoney } from "../theme"
import { clock as isoClock, dayWords } from "./activity"
import { type Act, blank, chip, type Line, Lines, line, type RowPick, type Seg } from "./lines"
import { signalLine } from "./signals"

type Tone = AwayEntry["tone"]
const toneFg = (t: Tone): string => ({ info: C.ink, good: C.good, bad: C.bad, warn: C.look })[t]

/** What `ask` puts on the input line: the agent answers from harness_history's "since last session". */
export const AWAY_ASK = "What happened while I was away?"

/** The note's chips, left to right; a click is the `away` act, by its label. */
export const AWAY_CHIPS = ["show all", "ask", "✕"] as const
export type AwayChip = (typeof AWAY_CHIPS)[number]

export { gapLength }


const clock = (ms: number): string => isoClock(new Date(ms).toISOString())
/** A time in the gap, with its day where it isn't today. */
const when = (ms: number, now: number): string => {
  const day = dayWords(new Date(ms).toISOString(), now)
  return day === "today" ? clock(ms) : `${day} ${clock(ms)}`
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const andList = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)
const agentsOf = (entries: readonly { agent?: string }[]) => [...new Set(entries.flatMap((e) => (e.agent ? [e.agent] : [])))]

const OUTCOME_WORDS: Readonly<Record<AwayCard["outcome"], string>> = {
  filled: "filled",
  "not-sold": "not sold live (Candle closed a paper position)",
  failed: "failed",
  refused: "refused",
  unknown: "with no answer yet",
  sent: "sent, not settled",
  abandoned: "abandoned",
  rejected: "rejected",
  withdrawn: "withdrawn",
  expired: "expired",
  waiting: "still waiting",
  approved: "approved",
}
const BAD_OUTCOMES = new Set<AwayCard["outcome"]>(["failed", "refused", "unknown"])

/** "2 filled (1 without a card), 1 expired": a list of cards by how each ended, in the order they're named above. */
function byOutcome(cards: readonly AwayCard[]): string {
  const parts: string[] = []
  for (const outcome of Object.keys(OUTCOME_WORDS) as AwayCard["outcome"][]) {
    const these = cards.filter((c) => c.outcome === outcome)
    if (!these.length) continue
    const without = outcome === "filled" ? these.filter((c) => c.withoutCard).length : 0
    parts.push(`${these.length} ${OUTCOME_WORDS[outcome]}${without ? ` (${without} without a card)` : ""}`)
  }
  const paper = cards.filter((c) => c.paper).length
  return `${parts.join(", ")}${paper ? `; ${paper} in paper` : ""}`
}

/** A fill outside the Candle Harness, in words: "SELL JUP $4.20 on agent-a's key". */
function fillWords(f: OutsideFill): string {
  const what = f.symbol ?? shortAddress(f.mint)
  return `${f.side.toUpperCase()} ${what}${f.usd === null ? "" : ` ${money(f.usd)}`} on ${f.agent}'s key`
}

function holdingWords(c: HoldingChange): string {
  const what = c.asset === "SOL" ? "SOL" : (c.symbol ?? shortAddress(c.asset))
  return `${c.name === "embedded" ? "embedded wallet" : c.name}: ${what} ${amount(c.then)} → ${amount(c.now)}`
}

/** The P&L over the gap, as harness_pnl's "since last session" reads it; undefined while it's read. */
function pnlWords(s: AwaySummary, now: number): { text: string; tone: Tone } | undefined {
  const p = s.pnl
  if (p.state === "reading") return undefined
  if (p.usd === null) return p.words ? { text: `P&L: ${p.words}`, tone: p.state === "failed" ? "bad" : "info" } : undefined
  const window = p.short && p.from !== null ? `since ${when(p.from, now)}` : p.label
  return { text: `P&L ${window} ${signedMoney(p.usd)}`, tone: p.usd > 0 ? "good" : p.usd < 0 ? "bad" : "info" }
}

/** When the core wasn't running in the gap, if it wasn't: nothing ran in the Candle Harness then. */
function downWords(s: AwaySummary, now: number, note = false): string | undefined {
  const down = s.coreDown
  if (!down.length) return undefined
  if (s.coreGoneThroughout && note) return "The core wasn't running: nothing ran in the Candle Harness."
  if (s.coreGoneThroughout) return "The core wasn't running the whole time: nothing ran in the Candle Harness, so what's here is Candle's and Hacc's side."
  if (down.length === 1) return `The core wasn't running from ${when(down[0]!.from, now)} to ${when(down[0]!.to, now)}: nothing ran in the Candle Harness then.`
  const total = down.reduce((n, d) => n + d.to - d.from, 0)
  return `The core wasn't running ${down.length} times, ${gapLength(total)} in all: nothing ran in the Candle Harness then.`
}

/**
 * The note's lines in order of weight, each one line's worth: the core not running, anything stopped or
 * refused, trades, trades outside the Candle Harness, P&L, your signals, then turns, other cards, the wallets and changes.
 */
export function awayNoteItems(s: AwaySummary, now: number): { text: string; tone: Tone }[] {
  const items: { text: string; tone: Tone }[] = []
  const c = s.counts
  const down = downWords(s, now, true)
  if (down) items.push({ text: down, tone: "warn" })
  if (c.stopped) {
    const newest = s.stopped[0]
    items.push({ text: newest ? `${newest.text}${c.stopped > 1 ? ` (and ${c.stopped - 1} more stopped or refused)` : ""}` : plural(c.stopped, "thing stopped or refused", "things stopped or refused"), tone: "bad" })
  }
  if (c.trades) {
    const one = c.trades === 1 ? s.trades[0] : undefined
    items.push({ text: one ? `${one.agent && !one.text.startsWith(one.agent) ? `${one.agent}: ` : ""}${one.text}` : `${plural(c.trades, "trade")}: ${byOutcome(s.trades)}`, tone: s.trades.some((t) => BAD_OUTCOMES.has(t.outcome)) ? "bad" : "info" })
  }
  if (c.outside || c.maybe) {
    const fills = s.outside.agents.flatMap((a) => a.fills)
    const sure = c.outside === 1 && fills[0] ? `1 trade outside the Candle Harness: ${fillWords(fills[0])}` : c.outside ? `${plural(c.outside, "trade")} outside the Candle Harness on ${andList(agentsOf(fills).map((a) => `${a}'s key`))}` : ""
    const maybe = c.maybe ? `${plural(c.maybe, "fill")} that may be the Candle Harness's` : ""
    items.push({ text: [sure, maybe].filter(Boolean).join("; "), tone: "warn" })
  }
  const pnl = pnlWords(s, now)
  if (pnl) items.push(pnl)
  if (c.signals) items.push({ text: `${c.signals}${s.signals.more ? "+" : ""} of your signals on Hacc`, tone: "info" })
  if (c.turns) {
    const one = c.turns === 1 ? s.turns[0] : undefined
    items.push({ text: one ? one.text : `${plural(c.turns, "turn")} ended after you left (${andList(agentsOf(s.turns))})`, tone: "info" })
  }
  if (c.cards) items.push({ text: c.cards === 1 && s.cards[0] ? s.cards[0].text : `${plural(c.cards, "other card")}: ${byOutcome(s.cards)}`, tone: "info" })
  if (c.holdings) {
    const one = c.holdings === 1 ? s.holdings.changes[0] : undefined
    items.push({ text: one ? holdingWords(one) : `The wallets changed: ${plural(c.holdings, "holding")} moved`, tone: "info" })
  }
  if (c.changes) items.push({ text: c.changes === 1 && s.changes[0] ? s.changes[0].text : `${plural(c.changes, "change")} on Hacc and in memory`, tone: "info" })
  return items
}

/** The most lines under the note's head (three to five). */
export const NOTE_ITEMS = 5

/** The note's head: its name, the gap's length, and its chips where they fit on the row, else on the next. */
function noteHead(s: AwaySummary, width: number): Line[] {
  const name: Seg = { text: "While you were away", fg: C.head, bold: true }
  const length: Seg = { text: ` · ${gapLength(s.to - s.from)}`, fg: C.dim }
  const chips = AWAY_CHIPS.flatMap((label, i): Seg[] => [...(i ? [{ text: " ", fg: C.dim }] : []), { ...chip(label, "away"), ref: label }])
  const cells = (segs: readonly Seg[]) => segs.reduce((n, seg) => n + seg.text.length, 0)
  const words = cells([name, length])
  if (words + 2 + cells(chips) <= width) return [{ segs: [name, length, { text: " ".repeat(width - words - cells(chips)), fg: C.dim }, ...chips] }]
  return [{ segs: [name, length] }, { segs: chips }]
}

/** A line inside the note's box: its border, a cell of air, the line padded to the box, and the border. */
function boxed(l: Line, inner: number): Line {
  const used = l.segs.reduce((n, seg) => n + seg.text.length, 0)
  return { ...l, segs: [{ text: "│ ", fg: C.head }, ...l.segs, { text: `${" ".repeat(Math.max(0, inner - used))} │`, fg: C.head }] }
}

/**
 * The note at the top of the agent pane, in at most `maxRows` lines: a box round its head and chips and the
 * lines in order of weight (each cut to a row), then a blank row, so the conversation under it never reads as
 * part of it (a faint rule blended into it). Lines go first where it doesn't fit, then the blank row; with no
 * room for the box, the head and its chips stay unboxed while there's a row.
 */
export function awayNoteLines(s: AwaySummary, width: number, maxRows: number, now: number): Line[] {
  if (maxRows < 1) return []
  const inner = Math.max(1, width - 4)
  const head = noteHead(s, inner)
  if (head.length + 2 > maxRows) return noteHead(s, width).slice(0, maxRows)
  const items = awayNoteItems(s, now).slice(0, NOTE_ITEMS)
  const room = maxRows - head.length - 2
  const shown = items.slice(0, Math.max(0, room)).map(({ text, tone }) => line(`  ${fit(text, Math.max(1, inner - 2))}`, toneFg(tone)))
  const edge = (left: string, right: string): Line => line(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`, C.head)
  const after = maxRows > head.length + shown.length + 2 ? [blank()] : []
  return [edge("╭", "╮"), ...[...head, ...shown].map((l) => boxed(l, inner)), edge("╰", "╯"), ...after]
}

// --- The Away pane --------------------------------------------------------------------------------------

/** The pane's title: its name and the gap's length; "Away" where the pane is narrow, so the length still shows. */
export const awayTitle = (v: AwayView | undefined, width = Number.POSITIVE_INFINITY): string => {
  const s = v?.summary
  const name = width < 44 ? "Away" : "While you were away"
  return s ? `${name} · ${gapLength(s.to - s.from)}` : name
}

const heading = (text: string): Line => line(text, C.head)

/** An entry from the journal, with its time and, where it names a token, the pick and ctrl-t's question. */
function entryLines(e: AwayEntry, width: number, now: number, extra = ""): Line[] {
  const pick = { id: `away:${e.seqs[0] ?? e.at}`, mint: e.mint ?? "", ...(e.mint ? { ask: askAbout(e.symbol, e.mint, `From while you were away, ${dayWords(e.at, now)} ${isoClock(e.at)}.`) } : {}) }
  const paper = e.mode === "paper" ? "paper · " : ""
  const parts = wrap(`${paper}${e.text}${extra}`, Math.max(10, width - 7))
  return parts.map((part, i): Line => ({ segs: [{ text: i === 0 ? `${isoClock(e.at)}  ` : "       ", fg: C.dim }, { text: part, fg: i === 0 ? toneFg(e.tone) : C.ink }], pick }))
}

/** A list section: its heading with its count, its entries, and how many more the summary counted than it lists. */
function section(name: string, count: number, entries: readonly AwayEntry[], width: number, now: number, extra?: (e: AwayEntry) => string): Line[] {
  if (!count) return []
  const out = [heading(`${name} · ${count}`), ...entries.flatMap((e) => entryLines(e, width, now, extra?.(e) ?? ""))]
  if (count > entries.length) out.push(line(`  and ${count - entries.length} older: the Journal has every one`, C.dim))
  return [...out, blank()]
}

/** An address, short, with its ⧉ chip; in full once copied. */
const addressSegs = (address: string, shownInFull: string | undefined): Seg[] => [{ text: `${address === shownInFull ? address : shortAddress(address)} `, fg: C.dim }, { ...chip("⧉", "copy"), ref: address }]

/** A fill outside the Candle Harness: its time and words, then the wallet it moved, short with its ⧉, on the row under it. */
function fillLines(f: OutsideFill, now: number, shownInFull: string | undefined, maybe: boolean): Line[] {
  const pick = { id: `away:fill:${f.signature ?? `${f.agent}:${f.at}:${f.mint}`}`, mint: f.mint, ask: askAbout(f.symbol, f.mint, `A trade on ${f.agent}'s key outside the Candle Harness, ${dayWords(new Date(f.at).toISOString(), now)} ${clock(f.at)}.`) }
  const first: Line = { segs: [{ text: `${clock(f.at)}  `, fg: C.dim }, { text: fillWords(f), fg: maybe ? C.dim : C.look }, ...(maybe ? [{ text: " · may be the Candle Harness's", fg: C.dim }] : [])], pick }
  return f.wallet ? [first, { segs: [{ text: "       wallet ", fg: C.dim }, ...addressSegs(f.wallet, shownInFull)], pick }] : [first]
}

function outsideLines(s: AwaySummary, width: number, now: number, shownInFull: string | undefined): Line[] {
  const o = s.outside
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width - 2)).map((t) => line(`  ${t}`, fg))
  if (o.state === "reading") return [heading("Outside the Candle Harness"), ...say("Reading each agent key's fills from Candle…"), blank()]
  const any = s.counts.outside + s.counts.maybe
  const failed = o.agents.filter((a) => a.state === "failed")
  const short = o.agents.filter((a): a is AgentFills & { reachesBack: number } => a.reachesBack !== undefined)
  if (!any && !failed.length && !short.length) return []
  const out = [heading(`Outside the Candle Harness${any ? ` · ${s.counts.outside}` : ""}`), ...say("Trades the agents' keys made that the Candle Harness didn't send: the CLI, a script, the web app.")]
  for (const a of o.agents) for (const f of a.fills) out.push(...fillLines(f, now, shownInFull, false))
  for (const a of o.agents) for (const f of a.maybe) out.push(...fillLines(f, now, shownInFull, true))
  for (const a of failed) out.push(...say(`${a.agent}'s fills weren't read: ${a.words ?? "Candle didn't answer"}`, C.bad))
  for (const a of short) out.push(...say(`${a.agent}: Candle's newest fills reach back to ${when(a.reachesBack, now)}, not the whole gap.`))
  return [...out, blank()]
}

function pnlSection(s: AwaySummary, width: number, now: number): Line[] {
  const p = s.pnl
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width - 2)).map((t) => line(`  ${t}`, fg))
  if (p.state === "reading") return [heading("P&L"), ...say("Reading each agent's book from Candle…"), blank()]
  const figure = pnlWords(s, now)
  const out = [heading("P&L"), ...(figure ? say(figure.text, toneFg(figure.tone)) : [])]
  if (p.usd !== null && p.words) out.push(...say(p.words))
  const agents = Object.entries(p.agents).filter(([, v]) => v.usd !== null)
  if (agents.length > 1) for (const [agent, v] of agents) out.push(...say(`${agent} ${signedMoney(v.usd!)}`, C.ink))
  return [...out, blank()]
}

function signalsSection(s: AwaySummary, width: number, now: number): Line[] {
  const g = s.signals
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width - 2)).map((t) => line(`  ${t}`, fg))
  if (g.state === "reading") return [heading("Your signals on Hacc"), ...say("Reading your rules' and follows' signals from Hacc…"), blank()]
  if (g.state !== "read") return g.words ? [heading("Your signals on Hacc"), ...say(g.words, g.state === "failed" ? C.bad : C.dim), blank()] : []
  if (!g.count) return []
  const rows = g.newest.map((r) => signalLine(r, width, now))
  const more = g.count - g.newest.length
  return [heading(`Your signals on Hacc · ${g.count}${g.more ? "+" : ""}`), ...rows, ...(more > 0 ? say(`and ${more}${g.more ? "+" : ""} older: Signals' mine chip shows them`) : []), blank()]
}

function holdingsSection(s: AwaySummary, width: number, now: number): Line[] {
  const h = s.holdings
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width - 2)).map((t) => line(`  ${t}`, fg))
  if (h.state === "reading") return [heading("Wallets"), ...say("Waiting for Candle's portfolio, to compare with when you left…"), blank()]
  if (h.state !== "read") return h.words ? [heading("Wallets"), ...say(h.words), blank()] : []
  if (!h.changes.length) return []
  const since = h.then !== undefined ? ` since ${when(h.then, now)}` : ""
  return [
    heading(`Wallets${since}`),
    ...h.changes.map((c): Line => ({ segs: [{ text: `  ${holdingWords(c)}`, fg: C.ink }], ...(c.asset !== "SOL" ? { pick: { id: `away:holding:${c.wallet}:${c.asset}`, mint: c.asset, ask: askAbout(c.symbol, c.asset, "It moved in the wallets while I was away.") } } : {}) })),
    blank(),
  ]
}

/** The Away pane's lines: every section of the last summary, or why there's none. */
export function awayLines(v: AwayView | undefined, opts: { width: number; now: number; shownInFull?: string }): Line[] {
  const width = Math.max(10, opts.width)
  const { now, shownInFull } = opts
  const say = (text: string, fg: string = C.dim) => wrap(text, width).map((t) => line(t, fg))
  if (!v) return say("Reading what happened while you were away…")
  const s = v.summary
  if (!s) return v.firstRun ? say("This fills once the Candle Harness has been closed for 10 minutes or more and opened again: what each agent did, what filled, P&L over the gap, cards that waited, and anything stopped or refused.") : say("Nothing to show: the last gap was too short to make a summary.")
  const span = `From ${when(s.from, now)} to ${when(s.to, now)}.`
  const cut = s.cut ? ` The gap held more than the summary reads: it covers from ${when(Date.parse(s.cut.from), now)}.` : ""
  const head = [...say(`${span}${cut}`)]
  const down = downWords(s, now)
  const reading = [s.pnl, s.outside, s.signals, s.holdings].some((r) => r.state === "reading")
  if (!s.happened) {
    const pnl = pnlWords(s, now)
    // A read that failed says so, never as nothing: a quiet gap is only as quiet as what was read.
    const notRead = [
      ...(s.pnl.state === "failed" && s.pnl.words ? [`P&L: ${s.pnl.words}`] : []),
      ...s.outside.agents.filter((a) => a.state === "failed").map((a) => `${a.agent}'s fills weren't read, so a trade outside the Candle Harness wouldn't show: ${a.words ?? "Candle didn't answer"}`),
      ...((s.signals.state === "failed" || s.signals.state === "no-key") && s.signals.words ? [`Your signals on Hacc weren't read: ${s.signals.words}`] : []),
      ...(s.holdings.state === "failed" && s.holdings.words ? [s.holdings.words] : []),
    ]
    return [
      line(`Nothing happened while you were away · ${gapLength(s.to - s.from)}`, C.ink),
      ...head,
      ...(down ? say(down, C.look) : []),
      ...(pnl && s.pnl.usd !== null ? [blank(), ...say(`${pnl.text}: what open positions moved.`, toneFg(pnl.tone))] : []),
      ...notRead.flatMap((t) => [blank(), ...say(t, C.bad)]),
      ...(reading ? [blank(), ...say("Still reading Candle's fills, P&L and your signals…")] : []),
    ]
  }
  return [
    ...head,
    ...(down ? say(down, C.look) : []),
    blank(),
    ...section("Stopped or refused", s.counts.stopped, s.stopped, width, now),
    ...section("Trades", s.counts.trades, s.trades, width, now, (e) => {
      const t = e as AwayCard
      return t.withoutCard && !/without a card/.test(t.text) ? " · without a card" : ""
    }),
    ...outsideLines(s, width, now, shownInFull),
    ...pnlSection(s, width, now),
    ...signalsSection(s, width, now),
    ...section("Turns that ended", s.counts.turns, s.turns, width, now),
    ...section("Other cards", s.counts.cards, s.cards, width, now),
    ...holdingsSection(s, width, now),
    ...section("Changes on Hacc and in memory", s.counts.changes, s.changes, width, now),
    ...(s.waitingNow ? say(`${plural(s.waitingNow, "card")} waiting for you now, in the agent pane.`, C.look) : []),
  ]
}

/** The overlay's width and rows at a screen's size: its lines, and how many show under its border and above its footer. */
function overlayFit(v: AwayView | undefined, width: number, height: number, now: number, shownInFull: string | undefined) {
  const w = Math.min(width - 4, 100)
  const lines = awayLines(v, { width: w - 4, now, ...(shownInFull ? { shownInFull } : {}) })
  const h = Math.max(4, Math.min(height - 4, lines.length + 3))
  return { w, h, lines, fits: h - 3 }
}

/** How far the overlay scrolls at this size: its lines past what fits. */
export function awayMaxScroll(v: AwayView | undefined, width: number, height: number, now: number, shownInFull?: string): number {
  const { lines, fits } = overlayFit(v, width, height, now, shownInFull)
  return Math.max(0, lines.length - fits)
}

/**
 * The note's show all and the palette's row (a click never adds a pane): every section over
 * the frame, as a card's details are. ↑/↓ and the wheel scroll it, ⧉ copies, a token's row picks it and
 * closes, and any other key closes it. The Away pane stays in the registry for a layout of your own.
 */
export function AwayOverlay(props: {
  view: AwayView | undefined
  scroll: number
  width: number
  height: number
  now: number
  shownInFull?: string
  onAct: (ref: string, act: Act) => void
  onPick: (pick: RowPick) => void
  onScroll: (delta: number) => void
}) {
  const { w, h, lines, fits } = overlayFit(props.view, props.width, props.height, props.now, props.shownInFull)
  const from = Math.max(0, Math.min(lines.length - fits, props.scroll))
  const below = Math.max(0, lines.length - from - fits)
  const marks = [from ? `↑ ${from} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean).join(" · ")
  const footer = `${marks ? `${marks} · ↑/↓ scroll · ` : ""}a token's row picks it · esc closes`
  return (
    <box
      position="absolute" zIndex={OVERLAY_Z}
      left={Math.floor((props.width - w) / 2)}
      top={Math.floor((props.height - h) / 2)}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` ${awayTitle(props.view, w - 4)} `}
      flexDirection="column"
      paddingLeft={1}
      onMouseScroll={(e: { scroll?: { direction?: string } }) => props.onScroll(e.scroll?.direction === "up" ? -1 : 1)}
    >
      <Lines lines={lines.slice(from, from + fits)} width={w - 4} onAct={props.onAct} onPick={props.onPick} />
      <text fg={C.dim}>{fit(footer, w - 4)}</text>
    </box>
  )
}
