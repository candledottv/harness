// The look: one colour per job, three text levels, and every control a chip. Rounded borders and a clear
// focus state.
//
// Themes: `C` holds the theme on screen, by role. Candle dark is the default look; Candle light, a theme of
// your own (themes.ts) and Terminal, drawn from the terminal's own colours, each fill the same roles. A
// theme changes shades, never what a colour means, and one that would make text unreadable or two meanings
// alike is refused with why (`problemsOf`).

/** Every colour the view draws, by its job. */
export interface Colours {
  // Surfaces.
  page: string
  bar: string
  term: string
  edge: string
  sel: string
  /**
   * A focused pane's border, and an overlay's. Orange (a grey was too faint to notice); in Candle dark,
   * Candle's own mint, #32FE9F, since Candle's colours are black and mint. Borders only, never text, so it
   * doesn't stand for good.
   */
  focus: string
  // Text, in three levels: what you act on, content, and labels, times and sources.
  hi: string
  ink: string
  dim: string
  // Meanings, one job each.
  /** Pane headings. */
  head: string
  /** Look at this: a waiting card, a near limit, a flag. */
  look: string
  /** Filled, up. */
  good: string
  /** Refused, down, the kill switch. */
  bad: string
  /** Anything that can be clicked, always drawn as a chip on `ctlBg`. */
  ctl: string
  ctlBg: string
  ctlHover: string
  badBg: string
  /** PAPER's block in the status bar. */
  paperBg: string
  // The agent's reply (markdown.ts), each style its own role so a theme can set it.
  /** A heading in a reply. */
  mdHead: string
  /** Bold and an address. */
  mdBright: string
  /** A table's labels and rules, a list's bullets. */
  mdDim: string
  /** A code span or block. */
  mdCode: string
  /** A quote and its bar. */
  mdQuote: string
}

export type Role = keyof Colours

const DARK: Colours = {
  page: "#0b0d10",
  bar: "#0e1115",
  term: "#111419",
  edge: "#252a33",
  sel: "#1d2430",
  focus: "#32fe9f",
  // Lifted a step on a first run on macOS ("all our white are grey"): ink 14.2:1 on `term`, dim 6.8:1, and dim
  // still a step under ink. Before: ink #c9cfd9, dim #6f7786 (4.1:1); at #4a5160 (2.3:1) dim read as ghosting.
  hi: "#f6f8fb",
  ink: "#dde2ea",
  dim: "#959dab",
  head: "#b392f0",
  look: "#f5a524",
  good: "#3ddc84",
  bad: "#ff5c5c",
  ctl: "#6cb6ff",
  ctlBg: "#16263a",
  ctlHover: "#1f3654",
  badBg: "#3a1619",
  paperBg: "#2a2f3a",
  mdHead: "#b392f0",
  mdBright: "#f6f8fb",
  mdDim: "#959dab",
  // Code in its own colour, as glow draws it, pink rather than glow's red, which means bad here.
  mdCode: "#ff87af",
  mdQuote: "#959dab",
}

/** Candle light: the same jobs on white, each shade dark enough to read there. */
const LIGHT: Colours = {
  page: "#f3f4f7",
  bar: "#eaecf0",
  term: "#ffffff",
  edge: "#cdd3dc",
  sel: "#e4e9f1",
  focus: "#e8590c",
  hi: "#0d1117",
  ink: "#2e3640",
  dim: "#5c6470",
  head: "#6639ba",
  look: "#8a5a00",
  good: "#116329",
  bad: "#c4161c",
  ctl: "#0a5fc4",
  ctlBg: "#e2efff",
  ctlHover: "#cfe3fc",
  badBg: "#ffe9e8",
  paperBg: "#d9dee6",
  mdHead: "#6639ba",
  mdBright: "#0d1117",
  mdDim: "#5c6470",
  mdCode: "#a3215b",
  mdQuote: "#5c6470",
}

/**
 * Overlays (the palette, menus, details) draw above every pane. Without it a pane mounted after the overlay
 * opened (a resize that collapses the layout) drew over it.
 */
export const OVERLAY_Z = 20

export const CANDLE_DARK = "Candle dark"
export const CANDLE_LIGHT = "Candle light"
/** Drawn from the terminal's own colours, read when it's picked. */
export const TERMINAL = "Terminal"
export const BUILT_IN: Readonly<Record<string, Colours>> = { [CANDLE_DARK]: DARK, [CANDLE_LIGHT]: LIGHT }
export const BUILT_IN_NAMES: readonly string[] = [CANDLE_DARK, CANDLE_LIGHT, TERMINAL]

/** The theme on screen. Read at draw time, so a switch shows on the next frame; only `applyColours` changes it. */
export const C: Colours = { ...DARK }

/** Puts a theme on screen: every role at once. The view redraws after. */
export function applyColours(colours: Colours): void {
  Object.assign(C, colours)
}

const HEX = /^#[0-9a-f]{6}$/i

/** `#rrggbb` (or `#rgb`) lower-cased, or undefined when it isn't one. */
export function hexOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const v = value.trim()
  const long = /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v
  return HEX.test(long) ? long.toLowerCase() : undefined
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x! + 0.05) / (y! + 0.05)
}

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

const rgbOf = (hex: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const hexFrom = (rgb: readonly number[]): string => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`

/** `a` moved toward `b` by `t` (0 to 1). */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgbOf(a), rgbOf(b)]
  return hexFrom(x.map((v, i) => v + (y[i]! - v) * t))
}

/** How far apart two colours are, 0 to 441 (straight-line RGB). */
const distance = (a: string, b: string): number => Math.hypot(...rgbOf(a).map((v, i) => v - rgbOf(b)[i]!))

/** The floors: text 4.5:1 on what it's drawn on, the dim level 4:1 (dimmer secondary text read as ghosted). */
export const TEXT_FLOOR = 4.5
export const DIM_FLOOR = 4
/** Two meanings closer than this read as one. */
const APART = 40

/** Each pair a theme must keep readable: what's drawn, on what, the floor, and how to say it. */
const PAIRS: readonly [Role, Role, number, string][] = [
  ...(["hi", "ink", "head", "look", "good", "bad", "ctl"] as const).flatMap((fg) =>
    (["term", "bar", "sel"] as const).map((bg): [Role, Role, number, string] => [fg, bg, TEXT_FLOOR, `${fg} text on ${bg}`]),
  ),
  ...(["hi", "ink"] as const).map((fg): [Role, Role, number, string] => [fg, "page", TEXT_FLOOR, `${fg} text on page (the tab bar)`]),
  ["dim", "term", DIM_FLOOR, "dim text on term"],
  ["dim", "bar", DIM_FLOOR, "dim text on bar"],
  ["dim", "page", DIM_FLOOR, "dim text on page (the tab bar)"],
  ["ctl", "ctlBg", TEXT_FLOOR, "a chip: ctl on ctlBg"],
  ["ctl", "ctlHover", TEXT_FLOOR, "a chip under the pointer: ctl on ctlHover"],
  ["page", "ctl", TEXT_FLOOR, "approve's chip: page on ctl"],
  ["page", "hi", TEXT_FLOOR, "approve's chip under the pointer: page on hi"],
  ["bad", "badBg", TEXT_FLOOR, "the kill chip: bad on badBg"],
  ["page", "good", TEXT_FLOOR, "LIVE in the status bar: page on good"],
  ["page", "bad", TEXT_FLOOR, "PAUSED in the status bar: page on bad"],
  ["hi", "paperBg", TEXT_FLOOR, "PAPER in the status bar: hi on paperBg"],
  ["mdHead", "term", TEXT_FLOOR, "a reply's headings: mdHead on term"],
  ["mdBright", "term", TEXT_FLOOR, "a reply's bold: mdBright on term"],
  ["mdCode", "term", TEXT_FLOOR, "a reply's code: mdCode on term"],
  ["mdDim", "term", DIM_FLOOR, "a reply's labels: mdDim on term"],
  ["mdQuote", "term", DIM_FLOOR, "a reply's quotes: mdQuote on term"],
]

/** The meanings, which must each read as their own: no two alike, and none like plain text. */
const MEANINGS: readonly Role[] = ["look", "good", "bad", "ctl", "head"]

/**
 * What would make a theme unreadable or hide a meaning, each said in words; empty when it holds. The
 * built-ins pass (theme.test.ts); a theme that fails isn't used.
 */
export function problemsOf(c: Colours): string[] {
  const out: string[] = []
  for (const [fg, bg, floor, what] of PAIRS) {
    const ratio = contrast(c[fg], c[bg])
    if (ratio < floor) out.push(`${what} is ${ratio.toFixed(1)}:1, under ${floor}:1`)
  }
  MEANINGS.forEach((a, i) => {
    for (const b of MEANINGS.slice(i + 1)) if (distance(c[a], c[b]) < APART) out.push(`${a} and ${b} are too alike to tell apart`)
    for (const t of ["ink", "hi"] as const) if (distance(c[a], c[t]) < APART) out.push(`${a} is too like ${t} text to stand out`)
  })
  return out
}

/** The terminal's colours as OpenTUI reads them (OSC 4, 10 and 11): each `#rrggbb`, or null where it didn't answer. */
export interface TerminalColours {
  palette: (string | null)[]
  defaultForeground: string | null
  defaultBackground: string | null
}

/** `hex` with its hue and saturation kept, lighter (`up`) or darker step by step until it reads on every surface given. */
function lifted(hex: string, on: readonly string[], floor: number, up: boolean): string {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  const at = (light: number): string => {
    const c = (1 - Math.abs(2 * light - 1)) * s
    const x = c * (1 - Math.abs((h % 2) - 1))
    const [p, q, w] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
    const m = light - c / 2
    return hexFrom([p + m, q + m, w + m].map((v) => v * 255))
  }
  let out = hex
  while (Math.min(...on.map((bg) => contrast(out, bg))) < floor && (up ? l < 1 : l > 0)) {
    l = Math.max(0, Math.min(1, l + (up ? 0.02 : -0.02)))
    out = at(l)
  }
  return out
}

/**
 * Terminal: the roles from the terminal's own background, text and 16 colours, so the
 * Candle Harness matches the person's scheme. Surfaces and tints are mixed from the background; each text colour
 * keeps its hue and is made lighter (on a dark background) or darker until it reads on every surface
 * it's drawn on, since many schemes' own colours fall under the floors. Undefined when the terminal
 * didn't say its colours: then there's nothing to draw from.
 */
export function terminalColours(t: TerminalColours): Colours | undefined {
  const bg = hexOf(t.defaultBackground)
  const fg = hexOf(t.defaultForeground)
  const p = Array.from({ length: 16 }, (_, i) => hexOf(t.palette[i] ?? undefined))
  if (!bg || !fg || p.slice(1, 7).some((x) => !x)) return undefined
  const up = luminance(bg) < luminance(fg)
  const base = { page: bg, bar: mix(bg, fg, 0.03), term: bg, sel: mix(bg, fg, 0.08) }
  const surfaces = [base.page, base.bar, base.term, base.sel]
  // Bright black is the dim level, unless a scheme made it a background shade (Solarized's is its own
  // background): lifted, that comes out a vivid colour, so a grey between the background and text stands in.
  const grey = p[8] && contrast(p[8], bg) >= 2 ? p[8] : mix(bg, fg, 0.65)
  const fromSlots = (slot: (normal: number, bright: number) => string): Colours => {
    const [ctl0, bad0] = [slot(4, 12), slot(1, 9)]
    const tints = { ctlBg: mix(bg, ctl0, 0.12), ctlHover: mix(bg, ctl0, 0.18), badBg: mix(bg, bad0, 0.12) }
    const text = (hex: string, extra: string[] = []) => lifted(hex, [...surfaces, ...extra], TEXT_FLOOR + 0.2, up)
    const ink = text(fg)
    const hi = text(p[up ? 15 : 0] ?? fg)
    const dim = lifted(grey, [base.page, base.bar, base.term], DIM_FLOOR + 0.2, up)
    const head = text(slot(5, 13))
    const look = text(slot(3, 11))
    const good = text(slot(2, 10))
    const bad = text(bad0, [tints.badBg])
    const ctl = text(ctl0, [tints.ctlBg, tints.ctlHover])
    return {
      ...base,
      ...tints,
      edge: mix(bg, fg, 0.22),
      focus: look,
      hi: contrast(hi, bg) >= contrast(ink, bg) ? hi : ink,
      ink,
      dim,
      head,
      look,
      good,
      bad,
      ctl,
      paperBg: mix(bg, fg, 0.18),
      mdHead: head,
      mdBright: hi,
      mdDim: dim,
      mdCode: hi,
      mdQuote: dim,
    }
  }
  // Lifted toward white (or black), two hues can meet: then the meaning's bright colour is tried in its place.
  for (const brights of [[], [13], [12], [12, 13]] as number[][]) {
    const slot = (normal: number, bright: number) => (brights.includes(bright) ? (p[bright] ?? p[normal]!) : (p[normal] ?? p[bright]!))
    const colours = fromSlots(slot)
    if (!problemsOf(colours).length) return colours
  }
  return fromSlots((normal, bright) => p[normal] ?? p[bright]!)
}

/** Cuts text to `width` cells, with an ellipsis when it had to cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ""
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

export const money = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const signedMoney = (n: number): string => `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`

/** "42s", "3m", "2h": how old something is, or how long is left. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
