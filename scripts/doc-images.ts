// The docs' pictures: kept frames (test/fixtures/frames/) drawn as SVG, in Candle dark and
// Candle light, inside a plain window. The light picture is the dark frame with each colour swapped for the one
// Candle light gives its role, so one kept frame makes both, and a screen that changes changes its pictures.
// Box-drawing, block and braille characters are drawn as shapes, so borders join and charts read whatever font
// the reader has; everything else is text, held to the grid. The moving picture is a story kept as frames too
// (src/view/demo-frames.test.tsx), drawn as one animated SVG.
//
//   bun scripts/doc-images.ts --write <dir>   writes every picture into <dir>, the docs site's public/harness/ folder
//   bun scripts/doc-images.ts <dir>           checks them against the frames, and exits 1 if any differs
//   --shade dark                              only the dark pictures: docs.candle.tv is dark only, so it takes no light ones
//   bun scripts/doc-images.ts [--write] --readme   the README's moving picture, both shades, in .github/readme/
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BUILT_IN, CANDLE_DARK, CANDLE_LIGHT, type Colours } from "../src/view/theme"

export interface Picture {
  /** Its files are <name>-dark.svg and <name>-light.svg. */
  name: string
  /** The kept frame it's drawn from, less `.txt`. */
  frame: string
  /** What it shows, for a reader who can't see it. */
  alt: string
}

export const FRAMES_DIR = join(import.meta.dir, "../test/fixtures/frames")

export const PICTURES: readonly Picture[] = [
  { name: "trade", frame: "followed-140x40-start", alt: "The Trade tab: the agent's conversation on the left, with the token, positions, wallets and activity beside it" },
  { name: "cockpit", frame: "cockpit-followed-140x40-start", alt: "The Cockpit tab: Feed over Signals, the token beside them, positions and activity along the bottom, and the agent on the right" },
  { name: "trending", frame: "trending-tab-followed-140x40-stretch-on", alt: "The Trending tab: Candle's New, Graduated, On Fire and Final Stretch lists side by side" },
  { name: "signals", frame: "signals-tab-followed-140x40", alt: "The Signals tab: Hacc's signals at full width, with the pattern and chain filters" },
  { name: "pnl", frame: "pnl-full-160x45", alt: "The P&L tab: the window's figure and each agent's book, the chart over time, positions and trades" },
  { name: "research", frame: "research-jup-140x40", alt: "The Research tab: one token's check, its top traders, its own signals and posts about it" },
  { name: "journal", frame: "journal-140x40", alt: "The Journal tab: everything the Candle Harness recorded, newest first, with a search line and kind filters" },
  { name: "perps", frame: "perps-trending-140x40-start", alt: "The Perps tab: what works for perps today, with questions to ask the agent" },
  { name: "card", frame: "demo-140x40-11", alt: "A trade card waiting in the agent's pane, approved with one key press" },
  { name: "kill-switch", frame: "theme-candle-dark-140x40-kill", alt: "The kill switch's report: buys paused, the agent stopped, and each open sell kept on a fresh card" },
  { name: "approvals", frame: "hands-off-160x45-menu", alt: "The approvals menu: each wallet asking every time or trading inside its limits, and who holds each limit" },
  { name: "receipt", frame: "hands-off-160x45-receipt", alt: "A trade that ran without a card, shown as a receipt with what it was checked against" },
  { name: "away", frame: "away-160x45-note", alt: "The note on opening the Candle Harness after time away: trades, refusals and P&L since the last session" },
  { name: "wallets", frame: "wallet-groups-160x45-pane-open", alt: "The Wallets pane with wallets in groups, one group open" },
  { name: "setup", frame: "onboarding-120x30-welcome", alt: "Setup's first screen: what setup covers, with its steps listed on the left" },
  { name: "setup-engine", frame: "onboarding-120x30-engine", alt: "Setup's engine step: each engine the Candle Harness found, with its version and its sign-in, and the picked one's models" },
  { name: "setup-start", frame: "onboarding-120x30-start", alt: "Setup's last step: start on the Trade tab or the Cockpit" },
  { name: "welcome", frame: "welcome-120x30-after-setup", alt: "The welcome after setup: what was set up, and what to try first" },
]

/** One cell of a frame: its character, colours as six hex digits, and attributes. */
export interface Cell {
  ch: string
  fg: string
  bg: string
  attr: number
}

/** A kept frame read back: rows of cells. */
export function parseFrame(text: string): Cell[][] {
  const [chars, colours] = text.split("\n--- colours ---\n")
  if (chars === undefined || colours === undefined) throw new Error("not a kept frame: no colours section")
  const rows = chars.split("\n").map((r) => [...r])
  return colours
    .trim()
    .split("\n")
    .map((line) => {
      const y = Number(line.slice(0, line.indexOf(":")))
      const cells: Cell[] = []
      for (const run of line.slice(line.indexOf(":") + 2).split(" ")) {
        const [look, n] = run.split("×")
        const [colour, attr] = look!.split("+")
        const [fg, bg] = colour!.split("/")
        for (let i = 0; i < Number(n); i++) cells.push({ ch: rows[y]?.[cells.length] ?? " ", fg: fg!, bg: bg!, attr: Number(attr ?? 0) })
      }
      return cells
    })
}

const hexes = (c: Colours) => Object.entries(c).map(([role, hex]) => [role, hex.slice(1).toLowerCase()] as const)
const DARK = BUILT_IN[CANDLE_DARK]!
const LIGHT = BUILT_IN[CANDLE_LIGHT]!
/** Candle dark's colours to Candle light's, by role. Roles that share a dark colour share a light one (a test holds it). */
export const TO_LIGHT: ReadonlyMap<string, string> = new Map([
  ...hexes(DARK).map(([role, hex]) => [hex, LIGHT[role as keyof Colours].slice(1).toLowerCase()] as const),
  // The terminal's own: an empty cell's foreground, and the prompt pane's black.
  ["ffffff", "ffffff"],
  ["000000", "000000"],
])

export type Shade = "dark" | "light"

/** A cell's colour in `shade`, or why it can't be drawn. */
function shaded(hex: string, shade: Shade): string {
  if (shade === "dark") return hex
  const light = TO_LIGHT.get(hex)
  if (!light) throw new Error(`#${hex} isn't one of Candle dark's colours, so it has no light shade`)
  return light
}

// The grid: a cell is 9 by 18, text 15 px, which a monospace font fills at about 0.6 em.
const CW = 9
const CH = 18
const FONT = 15
const PAD = 14
const BAR = 28
const WINDOW: Record<Shade, { frame: string; edge: string; dots: string }> = {
  dark: { frame: "#1a1e24", edge: "#2c323c", dots: "#3a414c" },
  light: { frame: "#e7e9ed", edge: "#cfd4db", dots: "#b9bfc8" },
}

/** A box-drawing character as strokes from the cell's centre: each side's weight, 1 light or 3 heavy, and a corner's arc. */
const BOX: Record<string, { u?: number; d?: number; l?: number; r?: number; arc?: "dr" | "dl" | "ur" | "ul" }> = {
  "─": { l: 1, r: 1 },
  "━": { l: 3, r: 3 },
  "│": { u: 1, d: 1 },
  "┃": { u: 3, d: 3 },
  "┌": { d: 1, r: 1 },
  "┐": { d: 1, l: 1 },
  "└": { u: 1, r: 1 },
  "┘": { u: 1, l: 1 },
  "├": { u: 1, d: 1, r: 1 },
  "┤": { u: 1, d: 1, l: 1 },
  "┬": { l: 1, r: 1, d: 1 },
  "┴": { l: 1, r: 1, u: 1 },
  "┼": { u: 1, d: 1, l: 1, r: 1 },
  "╭": { arc: "dr" },
  "╮": { arc: "dl" },
  "╰": { arc: "ur" },
  "╯": { arc: "ul" },
  "╵": { u: 1 },
  "╷": { d: 1 },
  "╹": { u: 3 },
  "╻": { d: 3 },
  "╴": { l: 1 },
  "╶": { r: 1 },
  "╿": { u: 3, d: 1 },
  "╽": { u: 1, d: 3 },
}

/** A block character as a rect, in eighths of the cell: x, y, width, height. */
const BLOCK: Record<string, [number, number, number, number]> = {
  "▁": [0, 7, 8, 1],
  "▂": [0, 6, 8, 2],
  "▃": [0, 5, 8, 3],
  "▄": [0, 4, 8, 4],
  "▅": [0, 3, 8, 5],
  "▆": [0, 2, 8, 6],
  "▇": [0, 1, 8, 7],
  "█": [0, 0, 8, 8],
  "▀": [0, 0, 8, 4],
  "▌": [0, 0, 4, 8],
  "▐": [4, 0, 4, 8],
}

/** Braille's dots by bit: column and row in the 2-by-4 grid. */
const BRAILLE_DOTS: [number, number][] = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [0, 3],
  [1, 3],
]

const n = (v: number) => String(Math.round(v * 100) / 100)
const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** The shape a cell's character is drawn as, at its top-left corner (x, y), or undefined for text. */
function shape(ch: string, x: number, y: number): string | undefined {
  const box = BOX[ch]
  if (box) {
    const cx = x + CW / 2
    const cy = y + CH / 2
    if (box.arc) {
      const r = CW / 2
      const [vy, hx] = [box.arc[0] === "d" ? y + CH : y, box.arc[1] === "r" ? x + CW : x]
      const sy = box.arc[0] === "d" ? 1 : -1
      const sx = box.arc[1] === "r" ? 1 : -1
      return `<path d="M${n(cx)} ${n(vy)}V${n(cy + sy * r)}Q${n(cx)} ${n(cy)} ${n(cx + sx * r)} ${n(cy)}H${n(hx)}" fill="none" stroke="currentColor" stroke-width="1"/>`
    }
    const lines: string[] = []
    const stroke = (w: number, d: string) => lines.push(`<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="square"/>`)
    if (box.u) stroke(box.u, `M${n(cx)} ${n(y)}V${n(cy)}`)
    if (box.d) stroke(box.d, `M${n(cx)} ${n(cy)}V${n(y + CH)}`)
    if (box.l) stroke(box.l, `M${n(x)} ${n(cy)}H${n(cx)}`)
    if (box.r) stroke(box.r, `M${n(cx)} ${n(cy)}H${n(x + CW)}`)
    return lines.join("")
  }
  const block = BLOCK[ch]
  if (block) {
    const [bx, by, bw, bh] = block
    return `<rect x="${n(x + (bx * CW) / 8)}" y="${n(y + (by * CH) / 8)}" width="${n((bw * CW) / 8)}" height="${n((bh * CH) / 8)}" fill="currentColor"/>`
  }
  // The copy chip: few fonts have a glyph for it.
  if (ch === "⧉") {
    const box = (bx: number, by: number) => `<rect x="${n(bx)}" y="${n(by)}" width="5" height="6" fill="none" stroke="currentColor" stroke-width="1"/>`
    return box(x + 1.5, y + 4.5) + box(x + 3.5, y + 7.5)
  }
  const code = ch.codePointAt(0)!
  if (code >= 0x2800 && code <= 0x28ff) {
    const bits = code - 0x2800
    return BRAILLE_DOTS.filter((_, i) => bits & (1 << i))
      .map(([c, r]) => `<circle cx="${n(x + CW * (0.3 + 0.4 * c))}" cy="${n(y + CH * (0.14 + 0.24 * r))}" r="1.1" fill="currentColor"/>`)
      .join("")
  }
  return undefined
}

type Classes = (hex: string) => string

/** One class per colour keeps the file small: the classes, and the style that defines them. */
function classes(): { cls: Classes; style: () => string } {
  const map = new Map<string, string>()
  return {
    cls: (hex) => {
      let c = map.get(hex)
      if (!c) map.set(hex, (c = `c${map.size}`))
      return c
    },
    style: () => [...map].map(([hex, c]) => `.${c}{fill:#${hex};color:#${hex}}`).join(""),
  }
}

/**
 * Some rows of a frame: backgrounds, then shapes, then text in runs of one colour and look, each held to its
 * cells' width. `cover` lays the page's colour over each row first, for a step drawn over the one before.
 */
function drawRows(frame: Cell[][], rows: readonly number[], shade: Shade, cls: Classes, page: string, cover: boolean): string[] {
  const backs: string[] = []
  const marks: string[] = []
  const texts: string[] = []
  const cols = Math.max(...frame.map((r) => r.length))
  for (const y of rows) {
    const row = frame[y]!
    const top = BAR + y * CH
    if (cover) backs.push(`<rect class="${cls(page)}" x="${PAD}" y="${top}" width="${cols * CW}" height="${CH}"/>`)
    for (let x = 0; x < row.length; ) {
      const bg = shaded(row[x]!.bg, shade)
      let end = x + 1
      while (end < row.length && shaded(row[end]!.bg, shade) === bg) end++
      if (bg !== page) backs.push(`<rect class="${cls(bg)}" x="${PAD + x * CW}" y="${top}" width="${(end - x) * CW}" height="${CH}"/>`)
      x = end
    }
    for (let x = 0; x < row.length; ) {
      const cell = row[x]!
      const left = PAD + x * CW
      const drawn = cell.ch === " " ? "" : shape(cell.ch, left, top)
      if (drawn !== undefined) {
        if (drawn) marks.push(`<g class="${cls(shaded(cell.fg, shade))}">${drawn}</g>`)
        x++
        continue
      }
      const fg = shaded(cell.fg, shade)
      let end = x + 1
      while (end < row.length && row[end]!.ch !== " " && shape(row[end]!.ch, 0, 0) === undefined && shaded(row[end]!.fg, shade) === fg && row[end]!.attr === cell.attr) end++
      const text = row.slice(x, end).map((c) => c.ch).join("")
      const look = `${cell.attr & 1 ? ' font-weight="700"' : ""}${cell.attr & 8 ? ' text-decoration="underline"' : ""}`
      texts.push(`<text class="${cls(fg)}" x="${left}" y="${n(top + CH * 0.72)}" textLength="${(end - x) * CW}"${look}>${escape(text)}</text>`)
      x = end
    }
  }
  return [...backs, ...marks, `<g xml:space="preserve">`, ...texts, `</g>`]
}

/** The window round a frame of `cols` by `lines`, with what's drawn inside it. */
function windowSvg(cols: number, lines: number, shade: Shade, alt: string, source: string, style: string, page: string, body: string[]): string {
  const width = cols * CW + PAD * 2
  const height = lines * CH + PAD + BAR
  const win = WINDOW[shade]
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(alt)}">`,
    `<!-- Drawn by scripts/doc-images.ts in candledottv/harness from ${source}, in Candle ${shade}: don't edit it here, run that again. -->`,
    `<title>${escape(alt)}</title>`,
    `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:${FONT}px;white-space:pre}${style}</style>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${win.frame}" stroke="${win.edge}"/>`,
    ...[0, 1, 2].map((i) => `<circle cx="${PAD + 6 + i * 18}" cy="${BAR / 2}" r="5.5" fill="${win.dots}"/>`),
    `<rect x="${PAD}" y="${BAR}" width="${cols * CW}" height="${lines * CH}" fill="#${page}"/>`,
    ...body,
    `</svg>`,
    "",
  ].join("\n")
}

const pageOf = (frame: Cell[][], shade: Shade) => shaded(frame[0]?.[0]?.bg ?? "0b0d10", shade)
const allRows = (frame: Cell[][]) => frame.map((_, y) => y)

/** A frame as an SVG picture in `shade`, inside a plain window. */
export function renderSvg(frame: Cell[][], shade: Shade, picture: Pick<Picture, "frame" | "alt">): string {
  const { cls, style } = classes()
  const page = pageOf(frame, shade)
  const body = drawRows(frame, allRows(frame), shade, cls, page, false)
  return windowSvg(Math.max(...frame.map((r) => r.length)), frame.length, shade, picture.alt, `test/fixtures/frames/${picture.frame}.txt`, style(), page, body)
}

/** The moving picture: its size, and each step's kept frame and how long it shows. */
export const DEMO_SIZE = [140, 40] as const
export interface DemoStep {
  frame: string
  ms: number
}
const demo = (i: number, ms: number): DemoStep => ({ frame: `demo-${DEMO_SIZE[0]}x${DEMO_SIZE[1]}-${String(i).padStart(2, "0")}`, ms })
export const DEMO_STEPS: readonly DemoStep[] = [
  demo(0, 1600), // the Trade tab
  demo(1, 140), // the question, typed
  demo(2, 140),
  demo(3, 140),
  demo(4, 140),
  demo(5, 600),
  demo(6, 700), // sent
  demo(7, 800), // the token pane follows
  demo(8, 600), // the answer streams in
  demo(9, 600),
  demo(10, 700),
  demo(11, 2400), // a card
  demo(12, 700), // approved
  demo(13, 2600), // filled
  demo(14, 3200), // the Cockpit
]
export const DEMO_ALT = "The Candle Harness at work: you ask about a token, the token pane follows it, the agent answers and proposes a buy as a card, one key press approves it, it fills, and the Cockpit shows"

/**
 * Steps of one size as one animated SVG: the first drawn whole, each after it only the rows it changed, laid
 * over the one before and shown from its time to the end of the loop. Where animation doesn't run, the last
 * step shows.
 */
export function renderAnimation(frames: Cell[][][], steps: readonly DemoStep[], shade: Shade, alt: string): string {
  const { cls, style } = classes()
  const first = frames[0]!
  const page = pageOf(first, shade)
  const total = steps.reduce((sum, st) => sum + st.ms, 0)
  const body = drawRows(first, allRows(first), shade, cls, page, false)
  const keyframes: string[] = []
  let at = steps[0]!.ms
  for (let k = 1; k < frames.length; k++) {
    const before = frames[k - 1]!
    const now = frames[k]!
    const changed = allRows(now).filter((y) => JSON.stringify(now[y]) !== JSON.stringify(before[y]))
    const pct = n((at / total) * 100)
    keyframes.push(`.s${k}{animation:s${k} ${total}ms step-end infinite}@keyframes s${k}{0%{opacity:0}${pct}%{opacity:1}}`)
    body.push(`<g class="s${k}">`, ...drawRows(now, changed, shade, cls, page, true), `</g>`)
    at += steps[k]!.ms
  }
  const source = `test/fixtures/frames/${steps[0]!.frame}.txt to ${steps.at(-1)!.frame}.txt`
  return windowSvg(Math.max(...first.map((r) => r.length)), first.length, shade, alt, source, style() + keyframes.join(""), page, body)
}

export const SHADES = ["dark", "light"] as const

/** Every picture in each shade asked for (both by default): its file name, and its SVG. */
export function renderPictures(pictures: readonly Picture[] = PICTURES, dir = FRAMES_DIR, shades: readonly Shade[] = SHADES): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pictures) {
    const frame = parseFrame(readFileSync(join(dir, `${p.frame}.txt`), "utf8"))
    for (const shade of shades) out[`${p.name}-${shade}.svg`] = renderSvg(frame, shade, p)
  }
  const steps = DEMO_STEPS.map((st) => parseFrame(readFileSync(join(dir, `${st.frame}.txt`), "utf8")))
  for (const shade of shades) out[`demo-${shade}.svg`] = renderAnimation(steps, DEMO_STEPS, shade, DEMO_ALT)
  return out
}

/** The README shows the moving picture alone, choosing its shade by the reader's own. */
export const README_DIR = join(import.meta.dir, "../.github/readme")
export const README_PICTURES = ["demo-dark.svg", "demo-light.svg"] as const

function picked(shades: readonly Shade[], only?: readonly string[]): [string, string][] {
  return Object.entries(renderPictures(only ? [] : PICTURES, FRAMES_DIR, shades)).filter(([file]) => !only || only.includes(file))
}

export function writePictures(dir: string, shades: readonly Shade[] = SHADES, only?: readonly string[]): string[] {
  mkdirSync(dir, { recursive: true })
  return picked(shades, only).map(([file, svg]) => {
    writeFileSync(join(dir, file), svg)
    return file
  })
}

/** Each picture in `dir` that's missing or no longer what its frame draws. */
export function pictureProblems(dir: string, shades: readonly Shade[] = SHADES, only?: readonly string[]): string[] {
  const problems: string[] = []
  for (const [file, svg] of picked(shades, only)) {
    const path = join(dir, file)
    if (!existsSync(path)) problems.push(`${file} is missing`)
    else if (readFileSync(path, "utf8") !== svg) problems.push(`${file} isn't what its frame draws now: run bun scripts/doc-images.ts --write`)
  }
  return problems
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf("--shade")
  const shade = at >= 0 ? args[at + 1] : undefined
  const readme = args.includes("--readme")
  const dir = readme ? README_DIR : args.find((a, i) => !a.startsWith("--") && !(at >= 0 && i === at + 1))
  if (!dir || (at >= 0 && shade !== "dark" && shade !== "light")) {
    console.error("usage: bun scripts/doc-images.ts [--write] [--shade dark|light] <the docs site's public/harness/ folder>, or [--write] --readme")
    process.exit(2)
  }
  const shades: readonly Shade[] = shade === "dark" || shade === "light" ? [shade] : SHADES
  const only = readme ? README_PICTURES : undefined
  if (args.includes("--write")) for (const file of writePictures(dir, shades, only)) console.log(`wrote ${file}`)
  const problems = pictureProblems(dir, shades, only)
  for (const p of problems) console.error(p)
  if (problems.length) process.exit(1)
}
