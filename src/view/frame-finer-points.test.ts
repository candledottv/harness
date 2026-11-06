// The frame's finer points: air between the panes and the input line under the agent, borders that line up,
// the settings menu, the layout menu's pane rows and undo, ctrl-u in the palette, Esc twice on a typed line,
// the aliases read again in place, Activity's days, and big percentages.
import { describe, expect, test } from "bun:test"
import { activityLines, dayWords } from "./panes/activity"
import { textOf } from "./panes/lines"
import type { ActivityEntry } from "../core/trade-log"
import { pct } from "./format"
import { type Effect, INITIAL_UI, type Key, SETTINGS, step, type UiAction, type UiContext, type UiState } from "./keys"
import { AGENT_FIRST, COCKPIT, GAP, gapFor, NO_GAP, place, type Rect, shownOf } from "./layout"
import { dragged } from "./layout-edit"
import { type LayoutInfo, layoutMenuRows } from "./layout-menu"
import { layoutOf } from "./layouts-file"

const area = (w: number, h: number): Rect => ({ x: 0, y: 3, w, h })
const rectOf = (l: ReturnType<typeof place>, id: string) => l.panes.find((p) => p.id === id)!.rect

describe("air between the panes (packed edge to edge, they felt tight)", () => {
  test("a column between panes side by side and a row between stacked ones, only where the window has room", () => {
    expect(gapFor(145, 45)).toEqual(GAP)
    expect(gapFor(99, 45)).toEqual(NO_GAP)
    expect(gapFor(145, 29)).toEqual(NO_GAP)
    const l = place(AGENT_FIRST, area(141, 40), {}, { gap: GAP })
    const agent = rectOf(l, "agent")
    const token = rectOf(l, "token")
    const positions = rectOf(l, "positions")
    expect(token.x).toBe(agent.x + agent.w + 1)
    expect(positions.y).toBe(token.y + token.h + 1)
    // Without the gap, they touch as before.
    const tight = place(AGENT_FIRST, area(141, 40))
    expect(rectOf(tight, "token").x).toBe(rectOf(tight, "agent").w)
  })

  test("the Cockpit's two rows share their weights, so their borders line up", () => {
    const l = place(COCKPIT, area(145, 40), {}, { gap: GAP })
    expect(rectOf(l, "positions").x + rectOf(l, "positions").w).toBe(rectOf(l, "feed").x + rectOf(l, "feed").w)
    expect(rectOf(l, "activity").x).toBe(rectOf(l, "token").x)
  })

  test("collapsed, the switched pane starts on the token, so a narrowed window still shows it (the cmux split)", () => {
    expect(shownOf(["feed", "signals", "token", "positions"], [])).toBe("token")
    expect(shownOf(["feed", "signals", "token"], ["signals"])).toBe("signals")
    expect(shownOf(["feed", "signals"], [])).toBe("feed")
  })
})

describe("the input line under the agent (with the agent pane on the right, a command line starting on the left read apart from it)", () => {
  test("the foot takes the agent's last rows, and the panes beside run to the bottom", () => {
    const l = place(COCKPIT, area(145, 42), {}, { gap: GAP, foot: 2 })
    const agent = rectOf(l, "agent")
    expect(l.foot).toEqual({ x: agent.x, y: 3 + 42 - 2, w: agent.w, h: 2 })
    expect(agent.y + agent.h).toBe(3 + 42 - 2)
    expect(rectOf(l, "activity").y + rectOf(l, "activity").h).toBe(3 + 42)
  })

  test("a layout whose agent doesn't reach the bottom, or has none, puts the foot across the width", () => {
    const stacked = layoutOf("Stacked", { dir: "column", weight: 1, children: [{ pane: "agent", weight: 60 }, { pane: "activity", weight: 40 }] })
    const l = place(stacked, area(120, 30), {}, { foot: 2 })
    expect(l.foot).toEqual({ x: 0, y: 3 + 30 - 2, w: 120, h: 2 })
    expect(rectOf(l, "activity").y + rectOf(l, "activity").h).toBe(3 + 30 - 2)
    const none = layoutOf("None", { dir: "row", weight: 1, children: [{ pane: "feed", weight: 1 }, { pane: "token", weight: 1 }] })
    expect(place(none, area(120, 30), {}, { foot: 3 }).foot).toEqual({ x: 0, y: 3 + 30 - 3, w: 120, h: 3 })
  })
})

describe("a dragged border lines up with one nearby (so it needs no manual correction)", () => {
  test("a border dropped within five cells of another of its kind meets it", () => {
    const mine = layoutOf("Mine", COCKPIT.root, COCKPIT.collapse.below)
    const at = area(145, 40)
    const borderOf = (l: typeof mine, id: string) => {
      const r = rectOf(place(l, at, {}, { gap: GAP }), id)
      return r.x + r.w
    }
    const target = borderOf(mine, "feed")
    // Positions' right border, dragged to a cell short of Feed's: it lands on Feed's.
    const from = borderOf(mine, "positions")
    const near = dragged(mine, "positions", "row", target - from + 8, at, "after", GAP)
    if ("refused" in near) throw new Error(near.refused)
    expect(borderOf(near, "positions")).not.toBe(target)
    const snapped = dragged(near, "positions", "row", -4, at, "after", GAP)
    if ("refused" in snapped) throw new Error(snapped.refused)
    expect(borderOf(snapped, "positions")).toBe(target)
  })
})

const INFO: LayoutInfo = { tab: "Cockpit", current: COCKPIT, names: ["Agent-first", "Cockpit"], preset: true, path: "/h/layouts.toml", problems: [], tabNames: ["Trade", "Cockpit"] }

describe("the layout menu (so building a layout is clear)", () => {
  test("with no pane focused, the panes on the layout come first, each focusing its own rows; nothing is opened by the first row", () => {
    const rows = layoutMenuRows(INFO, undefined)
    expect(rows[0]).toMatchObject({ group: "The panes on Cockpit: the Cockpit preset", label: "feed", hint: "⏎ to move, resize or close it", focus: "feed" })
    expect(rows.findIndex((r) => r.op?.kind === "open")).toBeGreaterThan(rows.findIndex((r) => r.focus === "agent"))
    // A layout of yours says it is, and the preset it came from.
    const mine = layoutMenuRows({ ...INFO, current: { ...COCKPIT, name: "My Cockpit" }, preset: false }, undefined)
    expect(mine[0]!.group).toBe("The panes on Cockpit: My Cockpit, your layout saved from Cockpit")
  })

  test("a pane's row focuses it and shows its rows from the top", () => {
    const c: UiContext = { cards: [], seenAt: {}, mode: "live", agents: ["momentum"], activeAgent: "momentum", commands: { agents: ["momentum"], knownTokens: new Map() }, layout: INFO, tabs: ["Trade", "Cockpit"] }
    const opened: UiState = { ...INITIAL_UI, focus: "tabs", overlay: { kind: "layouts", index: 0 } }
    const r = step(opened, { type: "pickLayoutRow", index: 0, now: 0 }, c)
    expect(r.state).toMatchObject({ focus: "feed", overlay: { kind: "layouts", index: 0 } })
    expect(layoutMenuRows(INFO, "feed")[0]).toMatchObject({ label: "move left" })
  })

  test("the last change's undo sits after the rows that keep the menu open, so it doesn't move the one highlighted", () => {
    const before = layoutMenuRows(INFO, "feed")
    const after = layoutMenuRows({ ...INFO, undo: "resized feed" }, "feed")
    const wider = before.findIndex((r) => r.label === "wider")
    expect(after[wider]!.label).toBe("wider")
    expect(after.find((r) => r.op?.kind === "undo")).toMatchObject({ label: "undo: resized feed" })
  })
})

function ctx(over: Partial<UiContext> = {}): UiContext {
  return { cards: [], seenAt: {}, mode: "live", agents: ["momentum"], activeAgent: "momentum", commands: { agents: ["momentum"], knownTokens: new Map() }, layout: INFO, tabs: ["Trade", "Cockpit"], ...over }
}
function run(actions: UiAction[], start: UiState = INITIAL_UI, c: UiContext = ctx()): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
const key = (name: string, now = 0, extra: Partial<Key> = {}): UiAction => ({ type: "key", key: { name, sequence: name.length === 1 ? name : undefined, ...extra }, now })
const ctrl = (name: string) => key(name, 0, { ctrl: true, sequence: undefined })
const type = (text: string): UiAction[] => [...text].map((ch) => ({ type: "key", key: { name: ch === " " ? "space" : ch, sequence: ch }, now: 0 }))

describe("keys", () => {
  test("ctrl-u clears the palette's search, as it clears the input line (it searched \"presetmemory\")", () => {
    const { state } = run([ctrl("k"), ...type("preset"), ctrl("u"), ...type("memory")])
    expect(state.overlay).toMatchObject({ kind: "palette", query: "memory" })
  })

  test("Esc on a typed line says so once; a second within a second clears it", () => {
    const once = run([...type("buy 1"), key("escape", 100)])
    expect(once.state).toMatchObject({ input: "buy 1", message: { text: "esc again to clear the line" } })
    expect(run([key("escape", 600)], once.state).state.input).toBe("")
    expect(run([key("escape", 1_200)], once.state).state.input).toBe("buy 1")
  })

  test("the settings chip opens its menu; each row opens what it names", () => {
    const menu = run([{ type: "clickSettings", now: 0 }]).state
    expect(menu.overlay).toEqual({ kind: "settings", index: 0 })
    const pick = (id: string) => run([{ type: "pickSettings", index: SETTINGS.findIndex((s) => s.id === id), now: 0 }], menu).state.overlay
    expect(pick("layout")).toMatchObject({ kind: "layouts" })
    expect(pick("theme")).toEqual({ kind: "palette", query: "themes", index: 0 })
    expect(pick("aliases")).toEqual({ kind: "palette", query: "aliases", index: 0 })
    expect(pick("model")).toMatchObject({ kind: "engines", agent: "momentum" })
    expect(pick("memory")).toMatchObject({ kind: "memory", agent: "momentum" })
    // By keys: ↓ then Enter; Esc closes.
    expect(run([key("down"), key("return")], menu).state.overlay).toMatchObject({ kind: "palette", query: "themes" })
    expect(run([key("escape")], menu).state.overlay).toBeUndefined()
  })
})

describe("words", () => {
  test("a percentage past 1,000% is whole, and past 9,999% only says so (\"▲ 1657834.0%\")", () => {
    expect(pct(0.412)).toBe("▲ 41.2%")
    expect(pct(24.391)).toBe("▲ 2439%")
    expect(pct(16578.34)).toBe("▲ >9999%")
    expect(pct(-0.926)).toBe("▼ 92.6%")
  })

  test("Activity names the day where it changes, so yesterday's 15:51 doesn't read as today's", () => {
    const now = new Date(2026, 9, 30, 9, 0).getTime()
    const entry = (seq: number, at: Date, text: string): ActivityEntry => ({ seq, at: at.toISOString(), text, tone: "info" }) as ActivityEntry
    const lines = activityLines([entry(1, new Date(2026, 9, 29, 15, 51), "filled BUY $1.00 of JUP"), entry(2, new Date(2026, 9, 30, 0, 2), "switched to the Trade tab")], 60, now).map(textOf)
    expect(lines[0]).toStartWith("── yesterday ")
    expect(lines[2]).toStartWith("── today ")
    expect(dayWords(new Date(2026, 9, 27, 10).toISOString(), now)).toBe("Tue 27 Oct")
    // One day only: no divider.
    expect(activityLines([entry(3, new Date(2026, 9, 30, 8), "x")], 60, now).map(textOf)[0]).not.toContain("──")
  })
})
