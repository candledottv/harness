// The agent's replies as the pane draws them (plain text read as a wall of text and contract addresses).
// The agent writes Markdown, and the pane renders it for a terminal: headings in the heading colour, bold
// bright, code in the code style, bullets with hanging indents (nested ones indented), quotes in the quote
// style and rules dim (each style a theme's role), and tables as aligned columns, or as one block per row
// when they're wider than the pane. Every address shows short (4…4), bright; the line under the reply
// lists each in full with its source and a ⧉ chip. Pure, so a test can read it.
import { addressSpellings } from "../engine/gate"
import { shortAddress } from "./format"

export type Style = "ink" | "hi" | "bold" | "head" | "dim" | "code" | "quote"

/** A heading, dim or quoted stretch keeps its own style for the bold and code inside it. */
const keeps = (base: Style): boolean => base === "head" || base === "dim" || base === "quote"
export interface Run {
  text: string
  style: Style
}
export type Row = Run[]

/** The figure gate's mark (agent.tsx): one private-use character where the `?` will stand. */
export const MARK = ""

// **bold** and __bold__; `__` inside a word isn't emphasis (candle__candle_trade).
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu
// *em* and _em_ have no italic here: the markers go, the words stay.
const EM = /(?<![\p{L}\p{N}*\\])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu
const LINK = /\[([^\]\n]+)\]\((\S+?)\)/g

/** A run's text with each address in it short, and bright. */
function shortened(run: Run): Run[] {
  // Every spelling, so an EVM address written in two cases is short in both.
  const addresses = addressSpellings(run.text)
  if (!addresses.length) return [run]
  const out: Run[] = []
  let rest = run.text
  while (rest) {
    let at = -1
    let found = ""
    for (const a of addresses) {
      const i = rest.indexOf(a)
      if (i >= 0 && (at < 0 || i < at)) [at, found] = [i, a]
    }
    if (at < 0) {
      out.push({ text: rest, style: run.style })
      break
    }
    if (at > 0) out.push({ text: rest.slice(0, at), style: run.style })
    out.push({ text: shortAddress(found), style: run.style === "head" || run.style === "bold" ? run.style : "hi" })
    rest = rest.slice(at + found.length)
  }
  return out
}

/** Emphasis in a stretch with no code in it. */
function emphasis(text: string, base: Style): Run[] {
  const out: Run[] = []
  const strong: Style = keeps(base) ? base : "bold"
  let last = 0
  const plain = (t: string, style: Style) => {
    // A stray marker with no partner isn't text either.
    const words = t.replace(EM, (_m, a, b) => a ?? b).replace(/\*\*/g, "")
    if (words) out.push({ text: words, style })
  }
  for (const m of text.matchAll(BOLD)) {
    plain(text.slice(last, m.index), base)
    plain(m[1] ?? m[2] ?? "", strong)
    last = m.index + m[0].length
  }
  plain(text.slice(last), base)
  return out
}

/** One line's inline Markdown as runs: code spans, emphasis, links, and addresses made short. */
export function inline(text: string, base: Style = "ink"): Run[] {
  const runs: Run[] = []
  text
    .replace(LINK, "$1 ($2)")
    .split(/(`[^`\n]*`)/)
    .forEach((part, i) => {
      if (i % 2) {
        if (part.length > 2) runs.push({ text: part.slice(1, -1), style: keeps(base) ? base : "code" })
      } else runs.push(...emphasis(part.replace(/`/g, ""), base))
    })
  return runs.flatMap(shortened)
}

const width_ = (row: readonly Run[]) => row.reduce((n, r) => n + r.text.length, 0)

/** Adjacent runs of one style as one. */
function merged(row: Run[]): Row {
  const out: Row = []
  for (const r of row) {
    const prev = out.at(-1)
    if (prev && prev.style === r.style) prev.text += r.text
    else if (r.text) out.push({ ...r })
  }
  return out
}

/**
 * Runs wrapped to `width`: whole words where they fit, a long one broken. `first` starts the first row
 * (a bullet), `rest` every row after it (the hanging indent).
 */
export function wrapRuns(runs: readonly Run[], width: number, first: readonly Run[] = [], rest: readonly Run[] = []): Row[] {
  const w = Math.max(4, width)
  // Words, each perhaps in several styles ("(" then a code span), and the spaces between them.
  const words: { parts: Run[]; space?: Style }[] = []
  let word: Run[] = []
  let space: Style | undefined
  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) {
        if (word.length) words.push({ parts: word, ...(space ? { space } : {}) })
        word = []
        space = words.length || word.length ? run.style : undefined
        continue
      }
      word.push({ text: piece, style: run.style })
    }
  }
  if (word.length) words.push({ parts: word, ...(space ? { space } : {}) })

  const rows: Run[][] = []
  let row: Run[] = [...first]
  let start = width_(row)
  let len = start
  const newRow = () => {
    rows.push(row)
    row = [...rest]
    start = len = width_(rest)
  }
  for (const { parts, space: gap } of words) {
    const size = width_(parts)
    if (len > start && len + 1 + size > w) newRow()
    if (len > start && gap) {
      row.push({ text: " ", style: gap })
      len += 1
    }
    for (const part of parts) {
      let text = part.text
      // A word longer than the row is broken where the row ends.
      while (len + text.length > w) {
        const room = Math.max(1, w - len)
        row.push({ text: text.slice(0, room), style: part.style })
        text = text.slice(room)
        newRow()
      }
      if (text) {
        row.push({ text, style: part.style })
        len += text.length
      }
    }
  }
  if (len > start || rows.length === 0) rows.push(row)
  return rows.map(merged)
}

const plainOf = (runs: readonly Run[]) => runs.map((r) => r.text).join("")
const restyle = (runs: readonly Run[], style: Style): Run[] => runs.map((r) => ({ ...r, style: r.style === "ink" ? style : r.style }))
// A cell that reads as a number, for right-aligning its column: "$4.2M", "0.02", "−12.5%", "27".
const NUMERIC = /^[~≈<>+\-−]?\s?\$?[\d.,]+\s?(?:[KMBkmb%x]|bps)?$/

/** A Markdown table: aligned columns when it fits, else a block per row, its first cell as the heading. */
export function tableRows(cells: readonly string[][], hasHeader: boolean, width: number): Row[] {
  const runs = cells.map((r) => r.map((c) => inline(c)))
  const header = hasHeader ? runs[0]! : []
  const body = hasHeader ? runs.slice(1) : runs
  const cols = Math.max(...runs.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...runs.map((r) => plainOf(r[i] ?? []).length)))
  if (widths.reduce((sum, w) => sum + w, 0) + 2 * (cols - 1) <= width) {
    const right = widths.map((_, i) => body.length > 0 && body.every((r) => NUMERIC.test(plainOf(r[i] ?? []).replace(MARK, "").trim() || "0")))
    const line = (r: readonly Run[][], style?: Style) =>
      merged(
        widths.flatMap((w, i) => {
          const cell = style ? restyle(r[i] ?? [], style) : (r[i] ?? [])
          const pad = { text: " ".repeat(w - plainOf(cell).length), style: "ink" as Style }
          const gap = i < cols - 1 ? [{ text: "  ", style: "ink" as Style }] : []
          return [...(right[i] ? [pad, ...cell] : [...cell, pad]), ...gap]
        }),
      )
    return [...(hasHeader ? [line(header, "dim")] : []), ...body.map((r) => line(r))].map(trimmedEnd)
  }
  const indent: Run[] = [{ text: "  ", style: "ink" }]
  const label = (i: number) => plainOf(header[i] ?? []).trim()
  const blocks = body.map((r) => {
    const block: Row[] = []
    block.push(...wrapRuns(restyle(r[0] ?? [], "bold"), width))
    const short: Run[] = []
    const long: Row[] = []
    for (let i = 1; i < r.length; i++) {
      const cell = r[i]!
      const text = plainOf(cell).trim()
      if (!text) continue
      // "Label: value" in both forms, so a table whose cells mix short and long reads one way.
      const named: Run[] = label(i) ? [{ text: `${label(i)}: `, style: "dim" }] : []
      if (text.length <= 24) {
        if (short.length) short.push({ text: " · ", style: "dim" })
        short.push(...named, ...cell)
      } else long.push(...wrapRuns([...named, ...cell], width, indent, indent))
    }
    if (short.length) block.push(...wrapRuns(short, width, indent, indent))
    block.push(...long)
    return block
  })
  // Blocks of more than a heading and a line read apart only with a blank line between them.
  const spaced = blocks.some((b) => b.length > 2)
  return blocks.flatMap((b, i) => (spaced && i > 0 ? [[], ...b] : b))
}

/** A row without the spaces padding its end. */
function trimmedEnd(row: Row): Row {
  const out = row.map((r) => ({ ...r }))
  while (out.length) {
    const last = out.at(-1)!
    last.text = last.text.replace(/\s+$/, "")
    if (last.text) break
    out.pop()
  }
  return out
}

const TABLE_ROW = (row: string) => row.length > 1 && row.startsWith("|") && row.endsWith("|")
const SEPARATOR = /^\|[\s:|-]+\|$/

/** A reply's Markdown as rows for a pane `width` wide. */
export function markdownRows(text: string, width: number): Row[] {
  const w = Math.max(10, width)
  const out: Row[] = []
  let table: string[][] = []
  let hasHeader = false
  let fence = false
  const push = (...rows: Row[]) => out.push(...rows)
  const blank = () => {
    if (out.length && out.at(-1)!.length) out.push([])
  }
  const flushTable = () => {
    if (table.length) push(...tableRows(table, hasHeader, w))
    table = []
    hasHeader = false
  }
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      flushTable()
      fence = !fence
      continue
    }
    if (fence) {
      // Code keeps its spacing; only an address in it is made short.
      push(...wrapRuns(shortened({ text: raw.replace(/\s+$/, "") || " ", style: "code" }), w).map((r) => (plainOf(r).trim() ? r : [])))
      continue
    }
    const row = raw.trim()
    if (TABLE_ROW(row)) {
      // The |---|:--:| row only marks the row above it as the header.
      if (SEPARATOR.test(row)) hasHeader = table.length === 1
      else table.push(row.slice(1, -1).split("|").map((c) => c.trim()))
      continue
    }
    flushTable()
    if (!row) {
      blank()
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(row)
    if (heading) {
      if (out.length) blank()
      push(...wrapRuns(inline(heading[2]!, "head"), w))
      continue
    }
    if (/^([-*_])(\s*\1){2,}$/.test(row)) {
      push([{ text: "─".repeat(Math.min(w, 24)), style: "dim" }])
      continue
    }
    const quote = /^>\s?(.*)$/.exec(row)
    if (quote) {
      const bar: Run[] = [{ text: "│ ", style: "quote" }]
      push(...wrapRuns(inline(quote[1]!, "quote"), w, bar, bar))
      continue
    }
    const item = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(raw)
    if (item) {
      const level = Math.min(3, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2))
      const marker = /\d/.test(item[2]!) ? item[2]! : level ? "◦" : "•"
      const lead = `${"  ".repeat(level)}${marker} `
      push(...wrapRuns(inline(item[3]!), w, [{ text: lead, style: "dim" }], [{ text: " ".repeat(lead.length), style: "ink" }]))
      continue
    }
    push(...wrapRuns(inline(row), w))
  }
  flushTable()
  while (out.length && !out.at(-1)!.length) out.pop()
  return out
}
