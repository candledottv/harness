// Themes on screen: the palette switches at once and the choice is kept;
// a view starts on config.toml's [theme] name or the last choice; a theme that can't be drawn says why and
// leaves the screen as it was; Terminal draws from the terminal's colours; a popped view follows.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import { App, type Session } from "./app"
import { PoppedApp } from "./popped"
import type { StatusView } from "./store"
import { BUILT_IN, C, CANDLE_DARK, CANDLE_LIGHT, type TerminalColours } from "./theme"
import { memoryThemes } from "./themes"

class FakeSession implements Session {
  private listeners: ((e: CoreEventParams) => void)[] = []
  private seq = 0
  async request<T>(): Promise<T> {
    return {} as T
  }
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topic: string, data: unknown): void {
    for (const l of this.listeners) l({ topic, seq: ++this.seq, data, snapshot: true })
  }
}

const status: StatusView = {
  agents: [{ name: "momentum", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } }],
  activeAgent: "momentum",
  mode: "live",
  paused: false,
  exposureUsd: 0,
  pnl: null,
  pricesAgeMs: 1_000,
}
const DRACULA: TerminalColours = { defaultBackground: "#282a36", defaultForeground: "#f8f8f2", palette: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"] }

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
  // Unmounting puts Candle dark back for the next test's frames.
  expect(C).toEqual(BUILT_IN[CANDLE_DARK]!)
})

async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
  })
  await setup!.renderOnce()
}
const frame = () => setup!.captureCharFrame()
/** The background of the cell at a place, as #rrggbb. */
const bgAt = (y: number, x: number): string => {
  let col = 0
  for (const span of setup!.captureSpans().lines[y]!.spans) {
    if (x < col + span.width) return `#${[span.bg.r, span.bg.g, span.bg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`
    col += span.width
  }
  return ""
}
/** Inside the agent pane, under its title. */
const paneBg = () => bgAt(4, 3)

async function main(props: Partial<Parameters<typeof App>[0]> = {}) {
  const session = new FakeSession()
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => 1_000_000} tickMs={0} {...props} />, { width: 120, height: 32, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status))
  return session
}

/** The palette, searched, and the first row picked. */
async function pick(query: string) {
  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  for (const ch of query) await input(() => setup!.mockInput.pressKey(ch))
  await input(() => setup!.mockInput.pressEnter())
  // The pick reads a file or the terminal: let it land.
  await input(async () => new Promise((r) => setTimeout(r, 5)))
}

test("the palette lists the themes, the one on screen marked, and how to make one of your own", async () => {
  await main({ themes: memoryThemes() })
  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  for (const ch of "themes") await input(() => setup!.mockInput.pressKey(ch))
  const f = frame()
  expect(f).toContain("Candle dark")
  expect(f).toMatch(/Candle dark\s+✓ the look as designed/)
  expect(f).toContain("Candle light")
  expect(f).toContain("Terminal")
  expect(f).toContain("a theme of your own")
})

test("a theme picked in the palette draws at once and is kept for next time", async () => {
  const themes = memoryThemes()
  await main({ themes })
  expect(paneBg()).toBe(BUILT_IN[CANDLE_DARK]!.term)
  await pick("candle light")
  expect(paneBg()).toBe(BUILT_IN[CANDLE_LIGHT]!.term)
  expect(frame()).toContain("Candle light is on, and kept for next time.")
  expect(themes.saved).toEqual([{ name: CANDLE_LIGHT }])
})

test("a view starts on config.toml's [theme] name, or the last choice while config.toml says the same", async () => {
  await main({ themes: memoryThemes(), configText: () => '[theme]\nname = "Candle light"\n' })
  expect(paneBg()).toBe(BUILT_IN[CANDLE_LIGHT]!.term)
  await act(async () => setup!.dispose())
  setup = undefined
  await main({ themes: memoryThemes({ Paper: 'base = "Candle light"\npane = "#fbfbf8"\n' }, { name: "Paper", config: CANDLE_LIGHT }), configText: () => '[theme]\nname = "Candle light"\n' })
  expect(paneBg()).toBe("#fbfbf8")
})

test("a theme of yours that can't be drawn: picked, the screen stays as it was; at start, Candle dark, and why", async () => {
  const files = { Faint: 'dim = "#2a2e36"\n' }
  await main({ themes: memoryThemes(files, { name: CANDLE_LIGHT }) })
  expect(paneBg()).toBe(BUILT_IN[CANDLE_LIGHT]!.term)
  await pick("faint")
  expect(paneBg()).toBe(BUILT_IN[CANDLE_LIGHT]!.term)
  expect(frame()).toContain("themes/Faint.toml can't be used, since dim text on term")
  expect(frame()).toContain("Candle light stays.")
  await act(async () => setup!.dispose())
  setup = undefined
  await main({ themes: memoryThemes(files), configText: () => '[theme]\nname = "Faint"\n' })
  expect(paneBg()).toBe(BUILT_IN[CANDLE_DARK]!.term)
  expect(frame()).toContain("themes/Faint.toml can't be used")
})

test("Terminal draws from the terminal's own colours; when the terminal won't say them, the screen stays", async () => {
  await main({ themes: memoryThemes(), readTerminal: async () => DRACULA })
  await pick("terminal")
  expect(paneBg()).toBe("#282a36")
  await act(async () => setup!.dispose())
  setup = undefined
  await main({ themes: memoryThemes(), readTerminal: async () => undefined })
  await pick("terminal")
  expect(paneBg()).toBe(BUILT_IN[CANDLE_DARK]!.term)
  // Wrapped under the agent pane, so read in pieces.
  expect(frame()).toContain("Terminal draws from the terminal's own colours, and this terminal")
  expect(frame()).toContain("didn't say what they are: Candle dark stays.")
})

test("a popped view draws in the theme kept, and follows when the main view switches", async () => {
  const themes = memoryThemes({}, { name: CANDLE_LIGHT })
  const session = new FakeSession()
  setup = await testRender(<PoppedApp session={session} pane="positions" onQuit={() => {}} now={() => 1_000_000} tickMs={0} themes={themes} />, { width: 80, height: 20, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status))
  expect(bgAt(2, 2)).toBe(BUILT_IN[CANDLE_LIGHT]!.term)
  await input(() => themes.change({ name: CANDLE_DARK }))
  await input(async () => new Promise((r) => setTimeout(r, 5)))
  expect(bgAt(2, 2)).toBe(BUILT_IN[CANDLE_DARK]!.term)
})
