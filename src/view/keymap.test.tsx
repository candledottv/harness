// One keymap table: the reducer's chords, help, the palette's key column and the hint
// line all read keymap.ts. These tests press every ctrl-letter and named key in a few states and fail on
// one that acts without a row in the table, or a row whose keys never act.
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import { App, hereOf, type Session } from "./app"
import { hintParts } from "./input-line"
import { helpLines, INITIAL_UI, type Key, paletteFound, poppable, step, type UiContext, type UiState } from "./keys"
import { chordOf, hintsHere, KEYMAP, pressed } from "./keymap"
import type { ViewCard } from "./store"

const card = { cardId: "c1", display: {} } as unknown as ViewCard
const ctx: UiContext = {
  cards: [card],
  seenAt: { c1: -10_000 },
  mode: "live",
  agents: ["momentum", "scout"],
  activeAgent: "momentum",
  commands: { agents: ["momentum", "scout"], knownTokens: new Map() },
  requotable: "c1",
  working: true,
}

/** The states a key is pressed in: the line empty, text on it, the tab bar focused, a refusal offering to ask the agent. */
const STATES: Record<string, UiState> = {
  empty: INITIAL_UI,
  typed: { ...INITIAL_UI, input: "buy", cursor: 3 },
  start: { ...INITIAL_UI, input: "buy", cursor: 0 },
  scrolled: { ...INITIAL_UI, scroll: { agent: { rows: 20 } } },
  tabs: { ...INITIAL_UI, focus: "tabs" },
  refused: { ...INITIAL_UI, input: "buy $1 ZZZ", cursor: 10, message: { text: "Not a trade yet", level: "error", at: 0, ask: "buy $1 ZZZ" } },
}

const NAMED = ["return", "enter", "kpenter", "escape", "tab", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "backspace", "delete", "insert", "f1", "f5"]
const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"]
const KEYS: Key[] = [...NAMED.map((name) => ({ name })), ...LETTERS.map((name) => ({ name, ctrl: true }))]
const label = (k: Key) => `${k.ctrl ? "ctrl-" : ""}${k.name}`

/** Whether a key does anything in a state: changes it, or asks the frame to. */
function acts(state: UiState, k: Key): boolean {
  const r = step(state, { type: "key", key: k, now: 1_000 }, ctx)
  return r.effects.length > 0 || JSON.stringify(r.state) !== JSON.stringify(state)
}

const inTable = (k: Key) => KEYMAP.some((d) => pressed(k.name === "kpenter" ? { ...k, name: "return" } : k, d.id))

describe("the table and the reducer", () => {
  test("every ctrl-letter and named key that acts, in any state, has a row", () => {
    const loose = KEYS.filter((k) => Object.values(STATES).some((s) => acts(s, k)) && !inTable(k)).map(label)
    expect(loose).toEqual([])
  })

  test("every row's keys act somewhere: a row can't name a chord the reducer ignores", () => {
    const idle = KEYMAP.flatMap((d) => d.keys.filter((c) => !Object.values(STATES).some((s) => acts(s, { name: c.name ?? c.sequence!, sequence: c.sequence ?? (c.name?.length === 1 && !c.ctrl ? c.name : undefined), ...(c.ctrl ? { ctrl: true } : {}) }))).map((c) => `${d.id}: ${c.ctrl ? "ctrl-" : ""}${c.name ?? c.sequence}`))
    expect(idle).toEqual([])
    // `c` types on the line, so it acts anywhere; in help it opens the palette at Candle's commands.
    expect(step({ ...INITIAL_UI, overlay: { kind: "help" } }, { type: "key", key: { name: "c", sequence: "c" }, now: 0 }, ctx).state.overlay).toMatchObject({ kind: "palette" })
  })

  test("the reducer matches chords only through the table", () => {
    const source = readFileSync(join(import.meta.dir, "keys.ts"), "utf8")
    expect(source.match(/key\.ctrl && key\.name ===/g) ?? []).toEqual([])
    for (const d of KEYMAP.filter((d) => d.keys.some((c) => c.ctrl))) expect(`${d.id}: ${source.includes(`pressed(key, "${d.id}")`)}`).toBe(`${d.id}: true`)
  })

  test("the kill switch and Enter's rule are as they were", () => {
    expect(chordOf("kill")).toBe("ctrl-x twice")
    const armed = step(INITIAL_UI, { type: "key", key: { name: "x", ctrl: true }, now: 0 }, ctx)
    expect(armed.effects).toEqual([])
    expect(step(armed.state, { type: "key", key: { name: "x", ctrl: true }, now: 500 }, ctx).effects).toEqual([{ type: "kill" }])
    expect(step(INITIAL_UI, { type: "key", key: { name: "return" }, now: 0 }, ctx).effects).toEqual([{ type: "approve", cardId: "c1", how: "enter" }])
    expect(step(INITIAL_UI, { type: "key", key: { name: "return" }, now: 0 }, { ...ctx, seenAt: { c1: -100 } }).effects).toEqual([])
  })
})

describe("what reads the table", () => {
  test("help lists every row", () => {
    const lines = helpLines()
    for (const d of KEYMAP) expect(`${d.id}: ${lines.some((l) => l.startsWith(d.chord) && l.includes(d.words))}`).toBe(`${d.id}: true`)
  })

  test("the palette's action rows carry the table's chord and words", () => {
    const rows = paletteFound(INITIAL_UI, ctx, "").filter((r) => r.section === "Actions" && r.id.startsWith("key:"))
    // The table's order, but for the two a pick never does, last.
    const keyed = KEYMAP.filter((d) => d.palette)
    expect(rows.map((r) => r.id)).toEqual([...keyed.filter((d) => !d.palette!.why), ...keyed.filter((d) => d.palette!.why)].map((d) => `key:${d.id}`))
    expect(rows.slice(-2).map((r) => r.id)).toEqual(["key:approve", "key:quit"])
    for (const r of rows) {
      const d = KEYMAP.find((x) => `key:${x.id}` === r.id)!
      expect(r).toMatchObject({ key: d.chord, words: d.words })
    }
  })

  test("ctrl-p's hint and pop are for a pane on the tab drawn now: focus left on a hidden tab's pane offers neither", () => {
    const nav = (order: string[]) => ({ order, group: [], rects: {} }) as unknown as UiContext["panes"]
    const onNew = { ...INITIAL_UI, focus: "new" } as UiState
    expect(poppable(onNew, { panes: nav(["agent", "new", "graduated"]) })).toBe("new")
    expect(poppable(onNew, { panes: nav(["agent", "research"]) })).toBeUndefined()
    expect(hereOf(onNew, { ...ctx, panes: nav(["agent", "research"]) }).pops).toBeUndefined()
  })

  test("the hint line says what Enter and Esc do here", () => {
    const empty = hereOf(INITIAL_UI, ctx)
    expect(hintsHere(empty).map((h) => `${h.chord} ${h.words}`)).toEqual(["⏎ approve", "esc stop momentum's turn", "ctrl-k palette"])
    expect(hintsHere(hereOf({ ...INITIAL_UI, input: "what's moving?" }, ctx)).map((h) => `${h.chord} ${h.words}`)).toEqual(["⏎ to momentum", "ctrl-k palette"])
    expect(hintsHere(hereOf({ ...INITIAL_UI, input: "paper" }, ctx)).map((h) => h.words)).toEqual(["runs it", "palette"])
    expect(hintsHere(hereOf({ ...INITIAL_UI, input: "buy $1 ZZZ" }, ctx)).map((h) => h.words)).toEqual(["says why", "palette"])
    expect(hintsHere(hereOf(INITIAL_UI, { ...ctx, cards: [], working: false })).map((h) => h.words)).toEqual(["palette"])
  })

  test("with the tab bar focused the hint line says a digit picks a tab there; anywhere else a digit types, and it says nothing of digits", () => {
    const quiet = { ...ctx, cards: [], working: false }
    expect(hintsHere(hereOf({ ...INITIAL_UI, focus: "tabs" }, quiet)).map((h) => `${h.chord} ${h.words}`)).toEqual(["ctrl-k palette", "1-9 a tab"])
    expect(hintsHere(hereOf(INITIAL_UI, quiet)).map((h) => h.chord)).not.toContain("1-9")
    // Help's row says how to get there.
    expect(KEYMAP.find((d) => d.id === "tabDigit")!.words).toContain("press tab until the tab bar has the keys")
  })

  test("a card that slid in under another: the hint line says Enter takes it in a moment, then that it approves", () => {
    const late = { ...ctx, seenAt: { c1: 1_000 }, behind: { c1: true as const } }
    expect(hintsHere(hereOf(INITIAL_UI, late, 1_400))[0]).toMatchObject({ chord: "⏎", words: "approves in a moment" })
    expect(hintsHere(hereOf(INITIAL_UI, late, 2_500))[0]).toMatchObject({ chord: "⏎", words: "approve" })
  })

  test("short of room, the hint line keeps what Enter does, then the palette, then Esc, then help", () => {
    const here = hereOf(INITIAL_UI, ctx)
    const ids = (room: number) => hintParts(here, room, { palette: true, help: true }).map((p) => p.id)
    expect(ids(200)).toEqual(["approve", "stop", "palette", "help"])
    expect(ids(40)).toEqual(["approve", "palette", "help"])
    expect(ids(30)).toEqual(["approve", "palette"])
    expect(ids(12)).toEqual(["approve"])
    expect(ids(5)).toEqual([])
  })
})

class FakeSession implements Session {
  private listeners: ((e: CoreEventParams) => void)[] = []
  async request<T>(): Promise<T> {
    return {} as T
  }
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topic: string, data: unknown): void {
    for (const l of this.listeners) l({ topic, seq: 1, data, snapshot: true })
  }
}

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})
async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
  })
  await setup!.renderOnce()
}
const frame = () => setup!.captureCharFrame()

async function opened(width: number, height: number) {
  const session = new FakeSession()
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => 1_000} tickMs={0} />, { width, height, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() =>
    session.push("status", {
      agents: [{ name: "momentum", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } }],
      activeAgent: "momentum",
      mode: "live",
      paused: false,
      exposureUsd: null,
      pnl: null,
      pricesAgeMs: null,
    }),
  )
}

describe("on screen", () => {
  test("help scrolls at 80×24 where it doesn't fit, and says what's out of view", async () => {
    await opened(80, 24)
    await input(() => setup!.mockInput.pressKey("?"))
    expect(frame()).toContain("more · ↑/↓ scroll")
    expect(frame()).not.toContain("ctrl-c twice")
    for (let i = 0; i < 6; i++) await input(() => setup!.mockInput.pressArrow("down"))
    for (let i = 0; i < 8; i++) await input(() => setup!.mockInput.pressKey("\x1b[6~"))
    expect(frame()).toContain("ctrl-c twice")
    expect(frame()).toContain("above")
    // Any other key still closes it.
    await input(() => setup!.mockInput.pressKey("x"))
    expect(frame()).not.toContain("─ help ─")
  })

  test("the palette's chip on the hint line opens it, and help's chip opens help", async () => {
    await opened(120, 30)
    const bottom = () => frame().split("\n").at(-2)!
    expect(bottom()).toContain("ctrl-k palette")
    expect(bottom()).toContain("? help")
    await input(() => setup!.mockMouse.click(bottom().indexOf("ctrl-k palette") + 2, 29))
    expect(frame()).toContain("─ palette ─")
    await input(() => setup!.mockMouse.click(bottom().indexOf("ctrl-k palette") + 2, 29))
    expect(frame()).not.toContain("─ palette ─")
    await input(() => setup!.mockMouse.click(bottom().indexOf("? help") + 2, 29))
    expect(frame()).toContain("─ help ─")
  })

  test("ctrl-k opens the palette over the screen, at 80×24 too", async () => {
    await opened(80, 24)
    await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
    expect(frame()).toContain("─ palette ─")
    expect(frame()).toContain("── Actions ─")
    await input(async () => {
      await setup!.mockInput.typeText("preset")
    })
    expect(frame()).toContain("── Presets ─")
    expect(frame()).toContain("Quant for momentum")
  })
})
