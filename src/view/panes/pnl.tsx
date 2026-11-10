// The P&L tab's panes, drawn from the core's `pnl` topic (core/pnl.ts):
//   - `pnl`: the P&L window's figure, then Candle's books for the Candle Harness's agents, each agent and each wallet,
//     with fees and the swaps Candle's fills leave out on a dim line, each rules bot from its own fills, and
//     paper apart, ≈;
//   - `pnl-chart`: the Candle Harness's agents' total over time from the Candle Harness's own samples (`pnl.series`), gaps as gaps;
//   - `pnl-positions`: each open position as Candle books it, which can differ from what the wallets hold;
//   - `trades`: Candle's recent fills, newest first, with the Candle Harness's own swaps marked "from the Candle Harness" and a bot's
//     fills "by bot".
// Every figure says whose it is: Candle's, the Candle Harness's samples, a bot's own fills, or paper at quoted prices, never summed.
import type { JournalSwap, PnlPosition, PnlTrade, PnlView, PnlWindow } from "../../core/pnl"
import { windowLabel } from "../../core/pnl"
import { askAbout } from "../ask"
import { bucketsOnTimeline, gappedChart, pnlRange, signedAxis } from "../chart"
import { ago, amount, shortAddress, usd, wrap } from "../format"
import type { WalletGroup } from "../../core/wallet-groups"
import { groupedWallets } from "../wallet-list"
import { C, fit, money, signedMoney } from "../theme"
import { chip, type Line, line, type Seg } from "./lines"

/** A book older than this is marked stale: the core reads each every minute while the tab shows. */
const STALE_MS = 12 * 60_000
/** A position's mark older than this is said under the positions. */
const OLD_MARK_MS = 15 * 60_000
/** Rounds another agent opened, listed under an agent's row, at most. */
const CROSSED_SHOWN = 2

/** What the chart spans: the P&L window, or the last 7 or 30 days, or every sample. */
export type PnlSpan = "window" | "7d" | "30d" | "all"
export const PNL_SPANS: readonly PnlSpan[] = ["window", "7d", "30d", "all"]

/** The chart's points, as the view last asked the core for them (`pnl.series`). */
export interface PnlSeries {
  span: PnlSpan
  /** Where the span starts. */
  from: number
  /** When it was read. */
  at: number
  points: { at: number; usd: number | null }[]
  /** The core couldn't answer: an older core, or an error, in words. */
  failed?: string
}

/** The buckets asked for: more than the widest chart's dot columns, so the view only spreads them. */
export const SERIES_POINTS = 480

/** Where a span starts, at `now`: the window's start (or the first sample, where it has none), 7 or 30 days back, or the first sample. */
export function spanFrom(span: PnlSpan, pnl: PnlView | undefined, now: number): number {
  if (span === "7d") return now - 7 * 86_400_000
  if (span === "30d") return now - 30 * 86_400_000
  if (span === "all") return 0
  return pnl?.figure.start ?? pnl?.samplesFrom ?? now - 86_400_000
}

/** A window as its chip says it: "24h", "today", "session", "18:00". */
export function windowChip(window: PnlWindow | undefined): string {
  if (window === undefined || window === "24h") return "24h"
  if (window === "midnight") return "today"
  if (window === "session") return "session"
  return window
}

/** A window in a sentence: "the last 24 hours", "since 18:00". */
export const pnlWindowWords = (window: PnlWindow): string => (window === "24h" ? "the last 24 hours" : windowLabel(window))

const signed = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : signedMoney(n))
const tone = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? C.dim : n > 0 ? C.good : n < 0 ? C.bad : C.ink)
const approx = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "not known" : `≈${signedMoney(n)}`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "14:18" today, "Oct 29 14:18" another day. */
export function clockWords(at: number, now: number): string {
  const d = new Date(at)
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  return new Date(now).toDateString() === d.toDateString() ? clock : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${clock}`
}

/** A wallet as the other panes name it: its label, "embedded" for the main one, else its short address. */
export function walletName(wallet: string, pnl: PnlView | undefined): string {
  const row = pnl?.wallets.find((w) => w.wallet === wallet)
  if (row?.label) return row.label
  if (row?.payerType === "main") return "embedded"
  return wallet ? shortAddress(wallet) : "—"
}

// --- `pnl` -----------------------------------------------------------------------------------------

/** The `pnl` pane's title: whose figures and how old, the oldest book shown. */
export function pnlTitle(pnl: PnlView | undefined, now: number, mode?: "paper" | "live"): string {
  const read = (pnl?.agents ?? []).flatMap((a) => (a.readAt !== null ? [a.readAt] : []))
  const live = mode === "paper" ? "live, " : ""
  if (read.length === 0) return `P&L · ${live}Candle's books`
  return `P&L · ${live}Candle's books, read ${ago(Math.min(...read), now, STALE_MS).text}`
}

/** The chip on the `pnl` pane's border: the window, which it opens a menu to pick. */
export const pnlWindowChipText = (pnl: PnlView | undefined): string => `${windowChip(pnl?.window)} ▾`

interface Cols {
  name: number
  /** Which figure columns fit, after the name: the window's change, total, realised, unrealised. */
  figures: number
  /** Each figure column's width: FIGURE, and up to three cells more where the pane has room. */
  fig: number
}

const FIGURE = 11

/** Cells kept after the figures for the wallets' agents, before the columns spread into the rest. */
const AGENTS_COLUMN = 16

/**
 * The columns at a width: the name's, and as many figures as fit, the window's change and total first.
 * Where all four fit with room to spare, the columns spread into it, up to three cells each (packed, the
 * tables had sat in the pane's left half).
 */
function colsAt(width: number): Cols {
  const name = Math.max(8, Math.min(14, width - 2 * FIGURE))
  const figures = Math.max(1, Math.min(4, Math.floor((width - name) / FIGURE)))
  const spare = figures === 4 ? width - name - 4 * FIGURE - AGENTS_COLUMN : 0
  const grow = Math.max(0, Math.min(3, Math.floor(spare / 4)))
  return { name: name + Math.min(2, grow), figures, fig: FIGURE + grow }
}

function tableRow(name: string, figures: (number | null | undefined)[], cols: Cols, opts: { nameFg?: string; skipFirst?: boolean } = {}): Line {
  const segs: Seg[] = [{ text: fit(name, cols.name - 1).padEnd(cols.name), fg: opts.nameFg ?? C.ink }]
  figures.slice(0, cols.figures).forEach((n, i) => {
    if (i === 0 && opts.skipFirst) segs.push({ text: "".padStart(cols.fig), fg: C.dim })
    else segs.push({ text: signed(n).padStart(cols.fig), fg: tone(n) })
  })
  return { segs }
}

function tableHead(first: string, window: string, cols: Cols): Line {
  const heads = [window, "total", "realised", "unrealised"].slice(0, cols.figures)
  return { segs: [{ text: first.padEnd(cols.name), fg: C.dim }, ...heads.map((h) => ({ text: fit(h, cols.fig - 1).padStart(cols.fig), fg: C.dim }))] }
}

/**
 * The `pnl` pane: the window's figure; the Candle Harness's agents' books, summed and each (Candle's books add up
 * across a shared wallet, each round booked whole to one key, "opened by" where agents crossed); fees and
 * the swaps Candle's fills leave out; the wallets across agents; Hyperliquid; and paper, apart and ≈.
 */
export function pnlLines(pnl: PnlView | undefined, opts: { width: number; now: number; mode?: "paper" | "live"; groups?: readonly WalletGroup[] }): Line[] {
  const w = Math.max(10, opts.width)
  const say = (text: string, fg: string = C.dim) => wrap(text, w).map((t) => line(t, fg))
  // Before Candle's first answer: what's coming, and when.
  const reading = () => [...say("Reading each agent's P&L from Candle: its figures show here within a minute."), ...say("Your P&L starts with your first fill.")]
  if (!pnl) return reading()
  if (pnl.agents.length === 0) return say("No agent has a Candle key yet, so there's no P&L to read. Add one with: candle-harness key add --agent <name>")
  const booked = pnl.agents.filter((a) => a.book !== null)
  if (booked.length === 0) {
    const failed = pnl.agents.filter((a) => a.failed)
    if (failed.length === 0) return reading()
    return [...failed.flatMap((a) => say(`${a.agent}: couldn't read its P&L (${a.failed!.words}). Trying again shortly.`, C.look)), ...paperBlock(pnl, w)]
  }
  const out: Line[] = []
  const f = pnl.figure
  const label = windowLabel(pnl.window)
  // The window's figure, named as the status bar names it: from the first sample, where that's later than
  // the window's start ("since midnight" over a figure from 21:01 had been explained only in grey).
  const from = f.short && f.from !== null ? `since ${clockWords(f.from, opts.now)}` : undefined
  out.push({ segs: [{ text: `${from ?? (label === "24h" ? "last 24h" : label)}  `, fg: C.ink }, { text: signed(f.usd), fg: tone(f.usd), bold: true }] })
  // Books read with nothing in them: a fresh account.
  const untraded = booked.every((a) => a.book!.positions.length === 0 && a.book!.closedRounds === 0) && pnl.trades.length === 0 && pnl.swaps.length === 0
  if (untraded) out.push(...say("Your P&L starts with your first fill. Candle's books for the Candle Harness's agents are empty so far."))
  else if (f.usd === null) out.push(...say("No sample in the window yet: the figure starts with the next read."))
  else if (from) out.push(...say(`The window is ${label === "24h" ? "the last 24h" : label}; the samples in it start at ${clockWords(f.from!, opts.now)}.`))
  else out.push(...say("The change in Candle's totals, from the Candle Harness's samples."))
  // In paper mode, paper comes first: it's what's being traded, and it's still never added to live.
  if (opts.mode === "paper") out.push(...paperBlock(pnl, w))
  out.push(line(""))

  const cols = colsAt(w)
  const head = label === "24h" ? "24h" : windowChip(pnl.window)
  out.push(tableHead(booked.length > 1 ? "agents" : "agent", head, cols))
  if (booked.length > 1 && pnl.sum) {
    // The Candle Harness's agents', not the whole account's: other keys on it aren't read.
    out.push(tableRow("together", [f.usd, pnl.sum.totalUsd, pnl.sum.realizedNetUsd, pnl.sum.unrealizedUsd], cols, { nameFg: C.hi }))
  }
  for (const a of pnl.agents) {
    if (!a.book) {
      out.push({ segs: [{ text: fit(a.agent, cols.name - 1).padEnd(cols.name), fg: C.ink }, { text: a.failed ? fit(`couldn't read: ${a.failed.words}`, w - cols.name) : "reading…", fg: a.failed ? C.look : C.dim }] })
      continue
    }
    const t = a.book.totals
    out.push(tableRow(a.agent, [f.agents[a.agent]?.usd ?? null, t.totalUsd, t.realizedNetUsd, t.unrealizedUsd], cols, { nameFg: booked.length > 1 ? C.ink : C.hi }))
    // Rounds another agent opened that Candle booked to this one.
    const crossed = a.book.crossed
    for (const c of crossed.slice(0, CROSSED_SHOWN)) out.push(line(fit(`  incl. ${c.symbol ?? shortAddress(c.mint)} opened by ${c.openedBy}, ${signed(c.realizedNetUsd)}`, w), C.dim))
    if (crossed.length > CROSSED_SHOWN) out.push(line(`  and ${plural(crossed.length - CROSSED_SHOWN, "more round")} another agent opened`, C.dim))
  }

  // Fees and what Candle's fills leave out, dim, never added (Candle's fills list no swaps).
  const fees = booked.reduce((n, a) => n + a.book!.totals.feesUsd, 0)
  const notes = [`fees ${money(fees)}, taken from realised`]
  // A blank row between the table and its notes, where the pane has room for one.
  if (w >= 60) out.push(line(""))
  if (pnl.swaps.length) notes.push(`${plural(pnl.swaps.length, "swap")} not in Candle's fills, in Trades`)
  out.push(...say(notes.join(" · ")))
  for (const a of booked) {
    const b = a.book!
    if (a.failed) out.push(...say(`${a.agent}: the last read failed (${a.failed.words}); this is its book from ${ago(a.readAt, opts.now, Number.POSITIVE_INFINITY).text}.`, C.look))
    if (b.unmarked > 0) out.push(...say(`${a.agent}: ${plural(b.unmarked, "position")} Candle couldn't price, left out of unrealised.`))
    if (b.truncated) out.push(...say(`${a.agent}: Candle's book looks back only so far, so its oldest trades aren't in it.`))
  }

  // The wallets across agents: a shared wallet's figures are its agents' books added.
  if (pnl.wallets.length) {
    out.push(line(""))
    out.push(tableHead("wallets", "", { ...cols, figures: cols.figures }))
    const walletRow = (wr: PnlView["wallets"][number], indent: string) => {
      const row = tableRow(`${indent}${walletName(wr.wallet, pnl)}`, [null, wr.totalUsd, wr.realizedNetUsd, wr.unrealizedUsd], cols, { skipFirst: true })
      if (pnl.agents.length > 1) {
        const used = row.segs.reduce((n, s) => n + s.text.length, 0)
        if (w - used > 6) row.segs.push({ text: fit(`  ${wr.agents.join(", ")}`, w - used), fg: C.dim })
      }
      return row
    }
    // Where there are groups: each group's wallets added up, then its wallets under it.
    const grouped = groupedWallets(pnl.wallets, opts.groups ?? [], (wr) => ({ address: wr.wallet, kind: wr.payerType === "main" ? "embedded" : "tee", name: walletName(wr.wallet, pnl) }))
    if ((opts.groups ?? []).length === 0) for (const wr of pnl.wallets) out.push(walletRow(wr, ""))
    else {
      for (const wr of grouped.top) out.push(walletRow(wr, ""))
      for (const g of grouped.groups) {
        const sum = (pick: (wr: PnlView["wallets"][number]) => number) => g.wallets.reduce((n, wr) => n + pick(wr), 0)
        out.push(tableRow(g.name, [null, sum((wr) => wr.totalUsd), sum((wr) => wr.realizedNetUsd), sum((wr) => wr.unrealizedUsd)], cols, { skipFirst: true, nameFg: C.head }))
        for (const wr of g.wallets) out.push(walletRow(wr, "  "))
      }
    }
  }

  out.push(...botsBlock(pnl, cols, w))

  // Hyperliquid, where Candle read it: the account's perps, in or out of the total.
  const hl = booked.map((a) => a.book!.hyperliquid).find((h) => h.read && h.netUsd !== null)
  if (hl && (hl.netUsd !== 0 || (hl.unrealizedUsd ?? 0) !== 0)) out.push(...say(`Hyperliquid perps: ${signed(hl.netUsd)} net, ${signed(hl.unrealizedUsd)} unrealised; ${hl.inTotal ? "in" : "not in"} the totals above.`))
  if (opts.mode !== "paper") out.push(...paperBlock(pnl, w))
  return out
}

/**
 * Each bot's figures, rules and code, its own block: the Candle Harness's count from the bot's own fills, which a shared wallet's
 * Candle books mix with everyone's; a paper bot's at quoted prices. Never added to Candle's figures.
 */
function botsBlock(pnl: PnlView, cols: Cols, w: number): Line[] {
  const bots = pnl.bots ?? []
  if (bots.length === 0) return []
  const out: Line[] = [line(""), tableHead("bots", "", cols), line(fit("counted here from each bot's own fills, apart from Candle's books", w), C.dim)]
  for (const b of bots) {
    const total = b.unrealizedUsd === null ? b.realizedUsd : b.realizedUsd + b.unrealizedUsd
    out.push(tableRow(`${b.name}${b.mode === "paper" ? " ≈" : ""}`, [null, total, b.realizedUsd, b.unrealizedUsd], cols, { skipFirst: true }))
    const notes = [
      b.kind === "code" ? "code bot" : "",
      b.mode === "paper" ? "paper, at quoted prices" : "",
      `${plural(b.open, "open position")}, ${b.closed} closed`,
      b.unpriced ? `${b.unpriced} unpriced` : "",
      b.unvalued ? "some closed ones couldn't be valued" : "",
      pnl.agents.length > 1 ? b.agent : "",
    ].filter(Boolean)
    out.push(line(fit(`  ${notes.join(" · ")}`, w), C.dim))
  }
  return out
}

/** Paper P&L, its own block: at quoted prices, ≈, never added to Candle's figures. */
function paperBlock(pnl: PnlView, w: number): Line[] {
  const books = Object.entries(pnl.paper).filter(([, p]) => p.positions.length > 0 || (p.realizedUsd ?? 1) !== 0)
  if (books.length === 0) return []
  const out: Line[] = [line(""), line(fit("paper, at quoted prices · never added to live", w), C.dim)]
  for (const [agent, p] of books) {
    out.push({ segs: [{ text: fit(agent, 13).padEnd(14), fg: C.ink }, { text: approx(p.totalUsd), fg: tone(p.totalUsd) }] })
    out.push(line(fit(`  realised ${approx(p.realizedUsd)} · unrealised ${approx(p.unrealizedUsd)}${p.unpriced ? ` · ${plural(p.unpriced, "position")} unpriced` : ""}`, w), C.dim))
  }
  return out
}

// --- The window's menu ---------------------------------------------------------------------------------

export interface PnlWindowRow {
  /** The window it picks; undefined for the row a time of your own is typed on. */
  value?: PnlWindow
  label: string
  words: string
  on: boolean
}


/** The window menu's rows: the last 24 hours, since midnight, since 18:00, since last session, and a time of your own, typed on its row. */
export function pnlWindowRows(current: PnlWindow | undefined, typing?: string): PnlWindowRow[] {
  const on = current ?? "24h"
  const rows: PnlWindowRow[] = [
    { value: "24h", label: "last 24 hours", words: "the default", on: on === "24h" },
    { value: "midnight", label: "since midnight", words: "today, by this machine's clock", on: on === "midnight" },
    { value: "18:00", label: "since 18:00", words: "since last night", on: on === "18:00" },
    { value: "session", label: "since last session", words: "since you last closed the Candle Harness", on: on === "session" },
  ]
  if (/^\d{2}:\d{2}$/.test(on) && on !== "18:00") rows.splice(3, 0, { value: on, label: `since ${on}`, words: "your time of day", on: true })
  rows.push(typing === undefined ? { label: "since another time…", words: "type a time of day", on: false } : { label: `since ${typing}▏`, words: "such as 07:30 · ⏎ · esc", on: false })
  return rows
}

// --- `pnl-chart` -----------------------------------------------------------------------------------------

const SPAN_WORDS: Record<Exclude<PnlSpan, "window">, string> = { "7d": "7d", "30d": "30d", all: "all" }

/** The span chips' line: the one shown in bright text, the others chips. */
function spanLine(span: PnlSpan, window: PnlWindow | undefined): Line {
  const segs: Seg[] = []
  for (const s of PNL_SPANS) {
    const text = s === "window" ? windowChip(window) : SPAN_WORDS[s]
    if (segs.length) segs.push({ text: " ", fg: C.ink })
    segs.push(s === span ? { text: ` ${text} `, fg: C.hi, bold: true } : { ...chip(text, "pnlSpan"), ref: s })
  }
  return { segs }
}

/**
 * The `pnl-chart` pane, `height` rows: the span's chips, the Candle Harness's agents' summed total over time from the
 * Candle Harness's own samples on a scale from the span's own values, blank where the Candle Harness wasn't running, and what
 * it plots. The samples are the Candle Harness's, of Candle's totals; Candle's P&L has no window of its own.
 */
export function pnlChartLines(pnl: PnlView | undefined, series: PnlSeries | undefined, opts: { width: number; height: number; now: number; span: PnlSpan }): Line[] {
  const w = Math.max(10, opts.width)
  const head = spanLine(opts.span, pnl?.window)
  const say = (text: string) => wrap(text, w).map((t) => line(t, C.dim))
  if (!series || series.span !== opts.span) return [head, ...say("Reading the Candle Harness's samples…")]
  if (series.failed) return [head, ...say(`Couldn't read the Candle Harness's samples: ${series.failed}.`)]
  const values = series.points.flatMap((p) => (p.usd === null ? [] : [p.usd]))
  if (values.length === 0) {
    if (pnl?.samplesFrom === null || pnl?.samplesFrom === undefined) return [head, ...say("No samples yet. The Candle Harness keeps one each time it reads Candle's P&L: every minute while this tab shows, every 5 minutes otherwise.")]
    return [head, ...say(`No samples in this span. The first is from ${clockWords(pnl.samplesFrom, opts.now)}: pick all.`)]
  }
  if (values.length === 1) return [head, ...say("One sample so far: the chart starts with the next read.")]
  const range = pnlRange(values)
  const top = signedAxis(range.hi)
  const bottom = signedAxis(range.lo)
  const axis = Math.max(top.length, bottom.length) + 1
  const cols = Math.max(4, w - axis)
  const rows = Math.max(1, opts.height - 2)
  const first = series.points.find((p) => p.usd !== null)!
  const start = Math.max(series.from, first.at - (series.points.length > 1 ? series.points[1]!.at - series.points[0]!.at : 0))
  const drawn = gappedChart(bucketsOnTimeline(series.points, cols * 2, start, opts.now), cols, rows, range)
  // As the token pane draws its price: the line, then its scale on the right.
  const chart = drawn.map((r, i): Line => ({ segs: [{ text: r, fg: C.ink }, { text: ` ${i === 0 ? top : i === drawn.length - 1 ? bottom : ""}`, fg: C.dim }] }))
  const gap = series.points.some((p, i) => p.usd === null && i > series.points.indexOf(first))
  const change = `${signed(values.at(-1)! - values[0]!)} since ${clockWords(start, opts.now)}`
  // The gap's words before anything else: a blank stretch must never read as a flat one.
  const captions = gap ? [`${change} · blank where the app wasn't running`, `${change} · blank: app off`] : [`${change}, from the Candle Harness's samples`, change]
  return [head, ...chart, line(fit(captions.find((c) => c.length <= w) ?? captions.at(-1)!, w), C.dim)]
}

// --- `pnl-positions` -----------------------------------------------------------------------------------

/** The pane's title: Candle's cost book, which can differ from what the wallets hold (Positions). */
export const PNL_POSITIONS_TITLE = "P&L positions · Candle's cost book"

/**
 * Each open position as Candle books it: its cost, its value at Candle's mark, and the difference, with
 * its wallet and agent. Each row picks its token, and ctrl-t asks about it. A position Candle couldn't
 * mark shows "—", never zero.
 */
export function pnlPositionLines(pnl: PnlView | undefined, opts: { width: number; now: number }): Line[] {
  const w = Math.max(10, opts.width)
  const say = (text: string, fg: string = C.dim) => wrap(text, w).map((t) => line(t, fg))
  if (!pnl || pnl.agents.every((a) => a.book === null)) {
    // Every read failed: why, never "reading" for good.
    const failed = pnl?.agents.find((a) => a.failed)?.failed
    if (failed && pnl!.agents.every((a) => a.failed)) return say(`Couldn't read Candle's books: ${failed.words}. Trying again shortly.`, C.look)
    return say(pnl?.agents.length === 0 ? "No agent has a Candle key yet." : "Reading Candle's books…")
  }
  const held = pnl.agents.flatMap((a) => (a.book?.positions ?? []).map((p) => ({ agent: a.agent, p })))
  if (held.length === 0) return [...say("No open positions in Candle's books."), ...say("Positions shows what the wallets hold, which can differ: a token sent in, or bought outside the Candle Harness's keys.")]
  held.sort((x, y) => (y.p.marketValueUsd ?? -1) - (x.p.marketValueUsd ?? -1))
  const withMore = w >= 54
  // Spread where there's room past the wallet column, up to three cells a column.
  const grow = withMore ? Math.max(0, Math.min(3, Math.floor((w - 39 - 28) / 4))) : 0
  const out: Line[] = [{ segs: [{ text: "token   ".padEnd(8 + grow), fg: C.dim }, { text: "cost".padStart(10 + grow), fg: C.dim }, { text: "value".padStart(10 + grow), fg: C.dim }, { text: "unrealised".padStart(11 + grow), fg: C.dim }, ...(withMore ? [{ text: `${" ".repeat(2 + grow)}wallet · agent`, fg: C.dim }] : [])] }]
  for (const { agent, p } of held) out.push(positionRow(agent, p, pnl, w, withMore, grow))
  const marks = held.flatMap(({ p }) => (p.markedAt !== null ? [p.markedAt] : []))
  const oldest = marks.length ? Math.min(...marks) : null
  if (oldest !== null && opts.now - oldest > OLD_MARK_MS) out.push(...say(`Candle's marks are up to ${ago(oldest, opts.now, Number.POSITIVE_INFINITY).text.replace(" ago", " old")}.`))
  return out
}

function positionRow(agent: string, p: PnlPosition, pnl: PnlView, w: number, withMore: boolean, grow = 0): Line {
  const symbol = p.symbol ?? shortAddress(p.mint)
  const segs: Seg[] = [
    { text: fit(symbol, 7).padEnd(8 + grow), fg: C.hi },
    { text: usd(p.costBasisUsd).padStart(10 + grow), fg: C.ink },
    { text: usd(p.marketValueUsd).padStart(10 + grow), fg: p.marketValueUsd === null ? C.dim : C.hi },
    { text: signed(p.unrealizedUsd).padStart(11 + grow), fg: tone(p.unrealizedUsd) },
  ]
  if (withMore) {
    const used = segs.reduce((n, s) => n + s.text.length, 0)
    segs.push({ text: fit(`${" ".repeat(2 + grow)}${walletName(p.wallet, pnl)} · ${agent}`, Math.max(0, w - used)), fg: C.dim })
  }
  const now = p.marketValueUsd === null ? "Candle couldn't price it now" : `worth ${usd(p.marketValueUsd)} now (${signed(p.unrealizedUsd)})`
  return { segs, pick: { id: `${agent}:${p.wallet}:${p.mint}`, mint: p.mint, ask: askAbout(p.symbol, p.mint, `Candle books ${amount(p.quantity)} of it at a cost of ${usd(p.costBasisUsd)}, ${now}.`) } }
}

// --- `trades` --------------------------------------------------------------------------------------------

/** The `trades` pane's title: Candle's live fills, and the Candle Harness's swaps where it has any, so live and paper aren't confused. */
export const tradesTitle = (pnl: PnlView | undefined): string => (pnl?.swaps.length ? "Trades · live: Candle's fills and the Candle Harness's swaps" : "Trades · live: Candle's fills, newest first")

const OK = new Set(["confirmed", "filled", "landed", "success", "succeeded"])
const FAILED = new Set(["failed", "error", "reverted", "rejected", "expired"])

/** A row's segments cut to `width`, the last cut with "…", as Lines would draw them. */
function clipped(segs: Seg[], width: number): Seg[] {
  let room = width
  return segs.flatMap((seg) => {
    if (room <= 0) return []
    const text = seg.text.length > room ? `${seg.text.slice(0, Math.max(0, room - 1))}…` : seg.text
    room -= text.length
    return [{ ...seg, text }]
  })
}

/** When: "14:02" today, "Oct 29 14:02" before, in a column as wide as the rows need. */
const when = (at: number, now: number, width: number) => clockWords(at, now).padEnd(width)

type Entry = { kind: "fill"; at: number; t: PnlTrade } | { kind: "swap"; at: number; s: JournalSwap }

/**
 * Recent fills from Candle, newest first, with the Candle Harness's own swaps merged in and marked (Candle's fills read
 * lists none). A failed trade says its error in words under it. A fill's row picks its token.
 */
export function tradeLines(pnl: PnlView | undefined, opts: { width: number; now: number }): Line[] {
  const w = Math.max(10, opts.width)
  const say = (text: string, fg: string = C.dim) => wrap(text, w).map((t) => line(t, fg))
  if (!pnl || (pnl.agents.length > 0 && pnl.agents.every((a) => a.readAt === null && !a.failed))) return say("Reading the recent fills from Candle…")
  const entries: Entry[] = [...pnl.trades.map((t): Entry => ({ kind: "fill", at: t.at, t })), ...pnl.swaps.map((s): Entry => ({ kind: "swap", at: s.at, s }))].sort((a, b) => b.at - a.at)
  const failed = pnl.agents.find((a) => a.failed)?.failed
  if (entries.length === 0 && failed && pnl.agents.every((a) => a.failed)) return say(`Couldn't read the fills from Candle: ${failed.words}. Trying again shortly.`, C.look)
  if (entries.length === 0) return say(pnl.agents.length === 0 ? "No agent has a Candle key yet." : "No recent fills on Candle for the Candle Harness's agents. Your fills show here as they land.")
  const many = pnl.agents.length > 1
  const noCard = new Set(pnl.withoutCard ?? [])
  const today = new Date(opts.now).toDateString()
  const timeW = entries.every((e) => new Date(e.at).toDateString() === today) ? 6 : 13
  const out: Line[] = []
  for (const e of entries) {
    if (e.kind === "swap") {
      const segs: Seg[] = [{ text: when(e.at, opts.now, timeW), fg: C.dim }, { text: "swap ", fg: C.ink }]
      const tail = `${e.s.usd === null ? "" : `  ≈${usd(e.s.usd)}`}  from the Candle Harness${e.s.withoutCard ? ", without a card" : ""}${many ? ` · ${e.s.agent}` : ""}`
      const room = Math.max(4, w - timeW - 5 - tail.length)
      // The card's headline says SWAP already: the column says it once.
      segs.push({ text: fit(e.s.title.replace(/^swap\s+/i, ""), room), fg: C.hi }, { text: tail, fg: C.dim })
      out.push({ segs: clipped(segs, w) })
      continue
    }
    const t = e.t
    const failed = FAILED.has(t.status.toLowerCase()) || t.error !== undefined
    const status = failed ? "failed" : OK.has(t.status.toLowerCase()) ? "" : t.status
    const segs: Seg[] = [
      { text: when(t.at, opts.now, timeW), fg: C.dim },
      { text: t.side.toLowerCase().padEnd(5), fg: t.side.toLowerCase() === "buy" ? C.good : t.side.toLowerCase() === "sell" ? C.bad : C.ink },
      { text: fit(t.symbol ?? shortAddress(t.mint), 9).padEnd(10), fg: C.hi },
      { text: (failed ? "failed" : usd(t.usd)).padStart(9), fg: failed ? C.look : C.ink },
    ]
    // How it was approved, where the core ran it without a card, and a bot's: matched by its signature.
    const alone = t.signature !== undefined && noCard.has(t.signature) ? "without a card" : ""
    const bot = t.signature !== undefined ? pnl.byBot?.[t.signature] : undefined
    const rest = [status && !failed ? status : "", bot ? `by bot ${bot}` : "", alone, many ? t.agent : ""].filter(Boolean).join(" · ")
    if (rest) segs.push({ text: `  ${rest}`, fg: C.dim })
    const ask = failed ? `My ${t.side.toLowerCase()} of it failed on ${clockWords(t.at, opts.now)}.` : `I ${t.side.toLowerCase() === "sell" ? "sold" : "bought"} ${usd(t.usd)} of it on ${clockWords(t.at, opts.now)}.`
    out.push({ segs: clipped(segs, w), pick: { id: `${t.agent}:${t.signature ?? `${t.at}:${t.mint}`}`, mint: t.mint, ask: askAbout(t.symbol, t.mint, ask) } })
    if (failed) out.push(...wrap(t.error ?? "Candle gave no reason.", Math.max(6, w - 2)).map((x) => line(`  ${x}`, C.look)))
  }
  // Paper never reaches Candle's fills: said where there's paper to look for.
  if (Object.values(pnl.paper).some((p) => p.positions.length > 0 || (p.realizedUsd ?? 0) !== 0)) out.push(...say("Paper trades aren't here: they're in P&L's paper lines and the Journal."))
  return out
}
