// Character charts for the token pane: a braille line chart (2×4 dots per cell) and a block sparkline.
// The scale is given: the price chart uses the whole hour's range, padded, so the axis doesn't jump with
// each tick, and it says what it plots. The price chart is drawn on a time axis: Hacc's 1m history and the
// 5 s samples share it, each column holding the last price at its time. Pixel charts (kitty, sixel) come
// later.
//
// The token pane draws a candle every two minutes from Hacc's 1m candles and the samples after them, green
// up and red down, a minute with no trade a dim dash. Where Hacc has no candles, the line has a faint area under it so it reads as a shape. Both
// carry three price labels, the last price marked ◂, and a time axis.

const SPARK = "▁▂▃▄▅▆▇█"
// Braille dot bits by [row][column] within a cell.
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export interface Range {
  lo: number
  hi: number
}

function scale(series: readonly number[], steps: number, range: Range): number[] {
  const span = range.hi - range.lo || 1
  return series.map((v) => Math.max(0, Math.min(steps - 1, Math.round(((v - range.lo) / span) * (steps - 1)))))
}

/** The last `width` values as a sparkline, one character each. */
export function sparkline(series: readonly number[], width: number, range: Range): string {
  const tail = series.slice(-width)
  return scale(tail, SPARK.length, range)
    .map((i) => SPARK[i])
    .join("")
}

/** A line chart of the last `width * 2` values, `height` rows of braille, top row first. Each point is
 *  joined to the previous one, so it reads as a line rather than scattered dots. */
export function brailleChart(series: readonly number[], width: number, height: number, range: Range): string[] {
  const cells = Array.from({ length: height }, () => new Array<number>(width).fill(0))
  const dot = (x: number, dotRow: number) => {
    const row = cells[Math.floor(dotRow / 4)]
    const col = Math.floor(x / 2)
    if (row && col < width) row[col] = (row[col] ?? 0) | (DOTS[dotRow % 4]?.[x % 2] ?? 0)
  }
  const tail = series.slice(-width * 2)
  const rows = scale(tail, height * 4, range).map((y) => height * 4 - 1 - y) // 0 is the top
  rows.forEach((r, x) => {
    const prev = rows[x - 1] ?? r
    for (let y = Math.min(prev, r); y <= Math.max(prev, r); y++) dot(x, y)
  })
  return cells.map((row) => row.map((bits) => String.fromCharCode(0x2800 + bits)).join(""))
}

/** Fewer samples than this draw a sparkline. */
export const BRAILLE_MIN_SAMPLES = 8

/** What a chart cell is: a rising or falling candle or line, the faint area under a line, a minute with no trade. */
export type Tone = "good" | "bad" | "fill" | "flat"
export interface Cell {
  text: string
  tone: Tone
}

/** A candle's prices, as Hacc's 1m candles have them. */
export interface Ohlc {
  at: number
  open: number
  high: number
  low: number
  close: number
}

/** How long a candle is, and so how far back the chart reaches: two cells a candle. */
export const CANDLE_MS = 2 * 60_000
const MINUTE = 60_000

/**
 * The chart's candles: `columns / 2` of them, each `CANDLE_MS` long and ending at the current one, from
 * Hacc's 1m candles and, after them, the samples bucketed by minute. A candle with no trade carries the
 * close before it, flat; one before any price is undefined. Undefined when there's no candle at all.
 */
export function candlesOf(hacc: readonly Ohlc[], samples: readonly { at: number; usd: number }[], columns: number, now: number): ({ c: Ohlc; flat: boolean } | undefined)[] | undefined {
  const n = Math.max(1, Math.floor(columns / 2))
  const after = hacc.length ? hacc.at(-1)!.at + MINUTE : Number.NEGATIVE_INFINITY
  const minutes = new Map<number, Ohlc>()
  for (const c of hacc) minutes.set(c.at, c)
  for (const p of samples) {
    if (p.at < after) continue
    const at = Math.floor(p.at / MINUTE) * MINUTE
    const m = minutes.get(at)
    minutes.set(at, m ? { ...m, high: Math.max(m.high, p.usd), low: Math.min(m.low, p.usd), close: p.usd } : { at, open: p.usd, high: p.usd, low: p.usd, close: p.usd })
  }
  if (minutes.size === 0) return undefined
  const sorted = [...minutes.values()].sort((a, b) => a.at - b.at)
  const end = Math.floor(now / CANDLE_MS) * CANDLE_MS + CANDLE_MS
  const out: ({ c: Ohlc; flat: boolean } | undefined)[] = []
  let prev: number | undefined = sorted.findLast((m) => m.at < end - n * CANDLE_MS)?.close
  let j = sorted.findIndex((m) => m.at >= end - n * CANDLE_MS)
  if (j < 0) j = sorted.length
  for (let i = 0; i < n; i++) {
    const from = end - (n - i) * CANDLE_MS
    const inside: Ohlc[] = []
    while (j < sorted.length && sorted[j]!.at < from + CANDLE_MS) inside.push(sorted[j++]!)
    if (inside.length) {
      const c = { at: from, open: inside[0]!.open, high: Math.max(...inside.map((m) => m.high)), low: Math.min(...inside.map((m) => m.low)), close: inside.at(-1)!.close }
      out.push({ c, flat: false })
      prev = c.close
    } else out.push(prev === undefined ? undefined : { c: { at: from, open: prev, high: prev, low: prev, close: prev }, flat: true })
  }
  return out.some((c) => c && !c.flat) ? out : undefined
}

/**
 * A cell's two halves, top then bottom: 0 empty, 1 wick, 2 body. Each cell holds two steps of price, so a
 * candle shows half a row of movement (at whole rows, a quiet hour's candles were all one cell).
 */
const HALVES: Record<string, string> = { "22": "┃", "20": "╹", "02": "╻", "11": "│", "10": "╵", "01": "╷", "21": "╿", "12": "╽" }

/** The candles in `height` rows, two cells each: a wick │ from high to low, a body ┃ from open to close, to half a row. */
export function candleCells(candles: readonly ({ c: Ohlc; flat: boolean } | undefined)[], width: number, height: number, range: Range): Cell[][] {
  const rows: Cell[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: " ", tone: "flat" as Tone })))
  const span = range.hi - range.lo || 1
  const steps = height * 2
  // The half-row a price sits in, 0 at the top.
  const y = (v: number) => steps - 1 - Math.max(0, Math.min(steps - 1, Math.round(((v - range.lo) / span) * (steps - 1))))
  candles.forEach((k, i) => {
    const x = i * 2
    if (!k || x >= width) return
    const { c, flat } = k
    if (flat) {
      rows[Math.floor(y(c.close) / 2)]![x] = { text: "─", tone: "flat" }
      return
    }
    const tone: Tone = c.close >= c.open ? "good" : "bad"
    const [top, bottom] = [y(c.high), y(c.low)]
    const [bodyTop, bodyBottom] = [y(Math.max(c.open, c.close)), y(Math.min(c.open, c.close))]
    const half = (h: number) => (h >= bodyTop && h <= bodyBottom ? 2 : h >= top && h <= bottom ? 1 : 0)
    for (let r = Math.floor(top / 2); r <= Math.floor(bottom / 2); r++) {
      const text = HALVES[`${half(2 * r)}${half(2 * r + 1)}`]
      if (text) rows[r]![x] = { text, tone }
    }
  })
  return rows
}

/** A braille line with a faint area under it (where there are no candles): the line's cells in its colour, the area's in `fill`. */
export function areaCells(series: readonly number[], width: number, height: number, range: Range, tone: Tone): Cell[][] {
  const line = Array.from({ length: height }, () => new Array<number>(width).fill(0))
  const area = Array.from({ length: height }, () => new Array<number>(width).fill(0))
  const steps = height * 4
  const ys = scale(series.slice(-width * 2), steps, range).map((v) => steps - 1 - v)
  const set = (grid: number[][], x: number, dotRow: number) => {
    const row = grid[Math.floor(dotRow / 4)]
    const col = Math.floor(x / 2)
    if (row && col < width) row[col] = (row[col] ?? 0) | (DOTS[dotRow % 4]?.[x % 2] ?? 0)
  }
  ys.forEach((r, x) => {
    const prev = ys[x - 1] ?? r
    for (let d = Math.min(prev, r); d <= Math.max(prev, r); d++) set(line, x, d)
    for (let d = r + 1; d < steps; d++) set(area, x, d)
  })
  return line.map((row, r) =>
    row.map((bits, c) => {
      const fill = area[r]![c]! & ~bits
      return bits ? { text: String.fromCharCode(0x2800 + (bits | fill)), tone } : fill ? { text: String.fromCharCode(0x2800 + fill), tone: "fill" as Tone } : { text: " ", tone: "flat" as Tone }
    }),
  )
}

export interface PriceChart {
  kind: "candles" | "braille" | "sparkline" | "none"
  rows: string[]
  /** Each row's cells with their tones, where the chart is candles or a line over its area. */
  cells?: Cell[][]
  /** Each row's label on the right: the top, the middle and the bottom price, and the last marked ◂. */
  axis?: string[]
  /** The time axis under the chart: how far back, half way, and now. */
  time?: string
  /** The scale's top and bottom, for the axis. */
  top: string
  bottom: string
  caption: string
  /** Why the chart is the samples alone, when Hacc's history didn't load. */
  note?: string
}

/** HH:MM, local time. */
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

/**
 * `columns` prices spread evenly from the first point's time to `end`, each the last price at or before
 * its time: a stretch with no points holds the last price, as a market with no trades does.
 */
export function onTimeline(points: readonly { at: number; usd: number }[], columns: number, end: number): number[] {
  const start = points[0]!.at
  const span = Math.max(0, end - start)
  const out: number[] = []
  let j = 0
  for (let i = 0; i < columns; i++) {
    const t = columns === 1 ? end : start + (span * i) / (columns - 1)
    while (j + 1 < points.length && points[j + 1]!.at <= t) j++
    out.push(points[j]!.usd)
  }
  return out
}

/** The time axis: how far back at the left, half way in the middle where it fits, and "now" at the right. */
function timeAxis(width: number, left: string, mid: string): string {
  const chars = new Array<string>(width).fill(" ")
  const put = (text: string, at: number) => [...text].forEach((ch, i) => at + i >= 0 && at + i < width && (chars[at + i] = ch))
  put(left, 0)
  if (width >= left.length + mid.length + 9) put(mid, Math.floor((width - mid.length) / 2))
  put("now", width - 3)
  return chars.join("")
}

/** A dollar price to `figures` significant figures. */
const label = (n: number, figures = 3) => `$${Number(n.toPrecision(figures)).toString()}`

/**
 * The fewest figures, from three, that put the axis's top and bottom within a tenth of its span of their
 * prices: a quiet hour of $0.2584 to $0.2597 reads "$0.2597" and "$0.2584", not "$0.26" and "$0.258".
 */
function axisFigures(range: Range): number {
  const near = (range.hi - range.lo) / 10
  const close = (v: number, f: number) => Math.abs(Number(v.toPrecision(f)) - v) <= near
  for (let f = 3; f < 8; f++) if (close(range.hi, f) && close(range.lo, f)) return f
  return 8
}

function niceRange(values: readonly number[]): Range {
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  // The hour's own range, so a quiet large-cap's moves show (at 2% either side, a large-cap's 0.4% hour
  // drew as one flat row). A flat hour still gets a span, 0.15% of the price either side, so a tick of
  // noise isn't drawn as a move.
  const floor = Math.abs((lo + hi) / 2) * 0.0015 || 1e-9
  if (hi - lo < floor) {
    const mid = (lo + hi) / 2
    lo = mid - floor
    hi = mid + floor
  }
  return { lo, hi }
}

/**
 * The token pane's chart of `points` (Hacc's history, if any, then the samples, oldest first). `history`
 * says how Hacc's history read went: "hacc" when the points start with it, "samples" with Hacc's words
 * when it didn't load, absent while it's read.
 */
export function priceChart(
  points: readonly { at: number; usd: number }[],
  opts: { width: number; height: number; symbol: string; now: number; sampleMs?: number; history?: { source: "hacc" } | { source: "samples"; words: string }; candles?: readonly Ohlc[]; samples?: readonly { at: number; usd: number }[] },
): PriceChart {
  const every = Math.round((opts.sampleMs ?? 5_000) / 1000)
  const note = opts.history?.source === "samples" ? { note: `No history from Hacc: ${opts.history.words}` } : {}
  if (points.length === 0) return { kind: "none", rows: [], top: "", bottom: "", caption: `${opts.symbol}: no price samples yet`, ...note }
  // One sample has no range: its axis label read as a second price beside the pane's.
  if (points.length === 1) return { kind: "none", rows: [], top: "", bottom: "", caption: `${opts.symbol}: one price sample so far; the chart starts with the next, in ${every}s`, ...note }
  const range = niceRange(points.map((p) => p.usd))
  const end = Math.max(opts.now, points.at(-1)!.at)
  const minutes = Math.max(0, Math.round((end - points[0]!.at) / 60_000))
  const caption = opts.history?.source === "hacc" ? `${opts.symbol} price in USD, last ${minutes}m: Hacc's history, then samples every ${every}s` : `${opts.symbol} price in USD, samples since ${hhmm(points[0]!.at)}`
  // From 2 rows, a framed chart: candles where Hacc's history gives them, else the line over its area. The time
  // axis takes a row from 5 (the Trade tab's default token pane has 2 rows, and would draw no candles at all).
  if (opts.height >= FRAMED_MIN_ROWS && opts.candles !== undefined) {
    const last = points.at(-1)!.usd
    const timed = opts.height >= TIME_AXIS_MIN_ROWS
    const height = opts.height - (timed ? 1 : 0)
    // The candles' own range sets the axis, and the axis's labels the candles' width: a first look at a
    // typical label's width, then the candles that fit beside the real one.
    const rangeOf = (ks: ReturnType<typeof candlesOf>) => {
      const shown = ks?.flatMap((k) => (k ? [k.c] : []))
      return shown?.length ? niceRange([...shown.map((c) => c.high), ...shown.map((c) => c.low), last]) : range
    }
    const first = opts.candles.length ? candlesOf(opts.candles, opts.samples ?? [], Math.max(4, opts.width - 9), opts.now) : undefined
    const guess = rangeOf(first)
    const guessFigures = axisFigures(guess)
    const axisW = Math.max(label(guess.hi, guessFigures).length, label(guess.lo, guessFigures).length, label(last, guessFigures).length + 1) + 1
    const width = Math.max(4, opts.width - axisW)
    const fitted = first && width !== opts.width - 9 ? candlesOf(opts.candles, opts.samples ?? [], width, opts.now) : first
    const r = rangeOf(fitted)
    const figures = axisFigures(r)
    const marker = `◂${label(last, figures)}`
    const cells = fitted ? candleCells(fitted, width, height, r) : points.length >= BRAILLE_MIN_SAMPLES ? areaCells(onTimeline(points, width * 2, end), width, height, r, last >= points[0]!.usd ? "good" : "bad") : undefined
    if (cells) {
      const span = r.hi - r.lo || 1
      const at = height - 1 - Math.max(0, Math.min(height - 1, Math.round(((last - r.lo) / span) * (height - 1))))
      const axis = cells.map((_, i) => (i === at ? marker : i === 0 ? label(r.hi, figures) : i === height - 1 ? label(r.lo, figures) : i === Math.floor((height - 1) / 2) ? label((r.hi + r.lo) / 2, figures) : ""))
      const back = fitted ? Math.round((fitted.length * CANDLE_MS) / MINUTE) : minutes
      const time = timed ? { time: timeAxis(width, `−${back}m`, `−${Math.round(back / 2)}m`) } : {}
      const candleCaption = `${opts.symbol} in USD · 2m candles, last ${back}m: Hacc's history, then samples every ${every}s`
      return { kind: fitted ? "candles" : "braille", rows: cells.map((row) => row.map((c) => c.text).join("")), cells, axis, ...time, top: label(r.hi, figures), bottom: label(r.lo, figures), caption: fitted ? candleCaption : caption, ...note }
    }
  }
  const figures = axisFigures(range)
  const axis = Math.max(label(range.hi, figures).length, label(range.lo, figures).length) + 1
  const width = Math.max(1, opts.width - axis)
  const braille = points.length >= BRAILLE_MIN_SAMPLES && opts.height >= 3
  const rows = braille ? brailleChart(onTimeline(points, width * 2, end), width, opts.height, range) : [sparkline(onTimeline(points, width, end), width, range)]
  return { kind: braille ? "braille" : "sparkline", rows, top: label(range.hi, figures), bottom: label(range.lo, figures), caption, ...note }
}

/** The framed chart (candles, or the line over its area) from this many rows, and its time axis from this many. */
export const FRAMED_MIN_ROWS = 2
export const TIME_AXIS_MIN_ROWS = 5

/**
 * A line chart of `values`, one per braille dot column, where null is a gap: the Candle Harness
 * wasn't running, so nothing is drawn there and no line joins across it.
 */
export function gappedChart(values: readonly (number | null)[], width: number, height: number, range: Range): string[] {
  const cells = Array.from({ length: height }, () => new Array<number>(width).fill(0))
  const dot = (x: number, dotRow: number) => {
    const row = cells[Math.floor(dotRow / 4)]
    const col = Math.floor(x / 2)
    if (row && col < width) row[col] = (row[col] ?? 0) | (DOTS[dotRow % 4]?.[x % 2] ?? 0)
  }
  const steps = height * 4
  const span = range.hi - range.lo || 1
  const rowOf = (v: number) => steps - 1 - Math.max(0, Math.min(steps - 1, Math.round(((v - range.lo) / span) * (steps - 1))))
  values.slice(-width * 2).forEach((v, x, all) => {
    if (v === null) return
    const r = rowOf(v)
    const before = all[x - 1]
    const prev = before === null || before === undefined ? r : rowOf(before)
    for (let y = Math.min(prev, r); y <= Math.max(prev, r); y++) dot(x, y)
  })
  return cells.map((row) => row.map((bits) => String.fromCharCode(0x2800 + bits)).join(""))
}

/**
 * `columns` values from buckets (`at` the end of each, as `pnl.series` sends them), spread evenly from
 * `start` to `end`: each column the bucket it falls in, null before the first bucket and in a gap.
 */
export function bucketsOnTimeline(points: readonly { at: number; usd: number | null }[], columns: number, start: number, end: number): (number | null)[] {
  const out: (number | null)[] = []
  const span = Math.max(0, end - start)
  const step = points.length > 1 ? points[1]!.at - points[0]!.at : span
  let j = 0
  for (let i = 0; i < columns; i++) {
    const t = columns === 1 ? end : start + (span * i) / (columns - 1)
    while (j < points.length && points[j]!.at < t) j++
    const p = points[j] ?? (t >= end ? points.at(-1) : undefined)
    // Before the first bucket starts, there's nothing.
    out.push(p && t > p.at - step ? p.usd : null)
  }
  return out
}

/** A signed dollar figure for the axis: "+$12.40", "-$3.10", "+$1.2K". */
export function signedAxis(n: number): string {
  const abs = Math.abs(n)
  const text = abs >= 10_000 ? `$${Number((abs / 1000).toPrecision(3)).toString()}K` : `$${abs.toFixed(2)}`
  return `${n < 0 ? "-" : "+"}${text}`
}

/** A range for P&L: its values', padded where flat, so a steady book still draws a line. */
export function pnlRange(values: readonly number[]): Range {
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi - lo < 0.02) {
    const mid = (lo + hi) / 2
    lo = mid - 0.01
    hi = mid + 0.01
  }
  return { lo, hi }
}
