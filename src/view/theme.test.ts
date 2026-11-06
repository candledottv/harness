// The look's colours: every text colour readable on what it's drawn on.
import { expect, test } from "bun:test"
import { BUILT_IN, C, CANDLE_DARK, CANDLE_LIGHT, contrast, hexOf, problemsOf, type TerminalColours, terminalColours } from "./theme"

test("contrast is the WCAG ratio", () => {
  expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5)
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5)
  expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5)
})

test("text and meaning colours are at least 4.5:1 on every surface they're drawn on", () => {
  for (const fg of [C.hi, C.ink, C.head, C.look, C.good, C.bad, C.ctl])
    for (const bg of [C.term, C.bar, C.sel]) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
})

test("dim is held to 4:1, the level where secondary text stops reading as ghosted", () => {
  for (const bg of [C.term, C.bar]) expect(contrast(C.dim, bg)).toBeGreaterThanOrEqual(4)
})

test("chips are readable: a control on its tint and on hover, approve's dark text on blue, kill on its red tint", () => {
  expect(contrast(C.ctl, C.ctlBg)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(C.ctl, C.ctlHover)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(C.page, C.ctl)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(C.bad, C.badBg)).toBeGreaterThanOrEqual(4.5)
})

test("the status bar's blocks: LIVE dark on green, PAUSED white on red, PAPER bright on grey", () => {
  expect(contrast(C.page, C.good)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(C.hi, C.paperBg)).toBeGreaterThanOrEqual(4.5)
  // White on #ff5c5c is 3.0:1; PAUSED is bold and short, so it's drawn dark on red instead.
  expect(contrast(C.page, C.bad)).toBeGreaterThanOrEqual(4.5)
})

// Themes: every built-in holds the floors above, and so must any theme.
test("Candle dark is the default look, and every built-in theme passes the check", () => {
  expect(C).toEqual(BUILT_IN[CANDLE_DARK]!)
  expect(Object.keys(BUILT_IN).sort()).toEqual([CANDLE_DARK, CANDLE_LIGHT].sort())
  for (const colours of Object.values(BUILT_IN)) expect(problemsOf(colours)).toEqual([])
})

test("the check names unreadable text and meanings made alike, in words", () => {
  const faint = { ...BUILT_IN[CANDLE_DARK]!, dim: "#33373f" }
  expect(problemsOf(faint)).toContain("dim text on term is 1.5:1, under 4:1")
  // Green the same as red hides what a fill and a refusal mean.
  const alike = { ...BUILT_IN[CANDLE_DARK]!, good: "#ff5c5c" }
  expect(problemsOf(alike)).toContain("good and bad are too alike to tell apart")
  const plain = { ...BUILT_IN[CANDLE_DARK]!, ctl: "#c9cfd9" }
  expect(problemsOf(plain)).toContain("ctl is too like ink text to stand out")
})

/** Some schemes people run, as their terminals answer OSC 4, 10 and 11. */
const SCHEMES: Record<string, TerminalColours> = {
  "Terminal.app Basic": { defaultBackground: "#ffffff", defaultForeground: "#000000", palette: ["#000000", "#990000", "#00a600", "#999900", "#0000b2", "#b200b2", "#00a6b2", "#bfbfbf", "#666666", "#e50000", "#00d900", "#e5e500", "#0000ff", "#e500e5", "#00e5e5", "#e5e5e5"] },
  "Solarized dark": { defaultBackground: "#002b36", defaultForeground: "#839496", palette: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"] },
  "Solarized light": { defaultBackground: "#fdf6e3", defaultForeground: "#657b83", palette: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"] },
  Dracula: { defaultBackground: "#282a36", defaultForeground: "#f8f8f2", palette: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"] },
  "Tomorrow Night": { defaultBackground: "#282c34", defaultForeground: "#ffffff", palette: ["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6", "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea"] },
}

test("Terminal draws from the terminal's own colours, made readable where they're faint, for dark and light schemes", () => {
  for (const [name, scheme] of Object.entries(SCHEMES)) {
    const colours = terminalColours(scheme)!
    expect({ name, problems: problemsOf(colours) }).toEqual({ name, problems: [] })
    // The terminal's own background, and its red still red: the hue kept, only lighter or darker.
    expect(colours.term).toBe(scheme.defaultBackground!)
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(colours.bad.slice(i, i + 2), 16))
    expect(r!).toBeGreaterThan(Math.max(g!, b!))
  }
})

test("Terminal has nothing to draw from when the terminal doesn't say its colours", () => {
  expect(terminalColours({ palette: Array(16).fill(null), defaultForeground: null, defaultBackground: null })).toBeUndefined()
  expect(terminalColours({ ...SCHEMES.Dracula!, palette: Array(16).fill(null) })).toBeUndefined()
})

test("hexOf reads #rrggbb and #rgb, and nothing else", () => {
  expect(hexOf("#ABCDEF")).toBe("#abcdef")
  expect(hexOf("#abc")).toBe("#aabbcc")
  for (const bad of ["red", "#12345", "abcdef", 3, undefined]) expect(hexOf(bad)).toBeUndefined()
})
