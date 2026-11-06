// The person's view of an agent's memory: the chip on the agent pane's border, the
// commands pane's `memory` row, the overlay's rows, and its deletes: ⌫ or ✕ for a line or file, "clear
// all" asking once. No new key opens it.
import { describe, expect, test } from "bun:test"
import type { MemoryView } from "../core/memory"
import { borderChip } from "./engine-chip"
import { type Effect, INITIAL_UI, type Key, step, type UiAction, type UiContext, type UiState } from "./keys"
import { memoryRows } from "./panes/memory"

const view: MemoryView = {
  dir: "/r/momentum/memory",
  entries: [
    { id: "a1", text: "- sizing: a quarter → memory/sizing.md" },
    { id: "b2", text: "- risk: skill:candle-risk-gate first" },
  ],
  files: [{ path: "sizing.md", bytes: 2048 }],
  chars: 80,
  long: false,
}
const ctx = (v: MemoryView | undefined = view): UiContext => ({ cards: [], seenAt: {}, mode: "live", agents: ["momentum"], activeAgent: "momentum", commands: { agents: ["momentum"], knownTokens: new Map() }, memory: () => memoryRows(v) })
function run(actions: UiAction[], c: UiContext = ctx(), start: UiState = INITIAL_UI): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
/** The effects after opening, which reads the memory fresh. */
function after(actions: UiAction[], c: UiContext = ctx()): { state: UiState; effects: Effect[] } {
  const r = run(actions, c)
  return { ...r, effects: r.effects.filter((e) => e.type !== "readMemory") }
}
const key = (name: string, extra: Partial<Key> = {}): UiAction => ({ type: "key", key: { name, ...extra }, now: 0 })
/** The palette's row for the agent's memory. */
const open: UiAction[] = [{ type: "key", key: { name: "k", ctrl: true }, now: 0 }, { type: "pickPalette", id: "memory:momentum", now: 0 }]

test("the engine chip on the border: the model's name is trimmed when short of room", () => {
  expect(borderChip(140, " momentum ", "Claude Code · claude-opus-5-5 ▾")).toBe("Claude Code · claude-opus-5-5 ▾")
  expect(borderChip(46, " momentum ", "Claude Code · claude-opus-5-5 ▾")).toBe("Claude Code · claude-… ▾")
  expect(borderChip(20, " momentum ", "Claude Code · claude-opus-5-5 ▾")).toBeUndefined()
})

describe("the memory overlay", () => {
  test("opens from the chip or the palette's memory row", () => {
    expect(run([...open])).toMatchObject({ state: { overlay: { kind: "memory", agent: "momentum", index: 0 } }, effects: [{ type: "readMemory" }] })
  })

  test("rows: the index's lines, the files, then clear all", () => {
    expect(memoryRows(view).map((r) => r.kind)).toEqual(["entry", "entry", "file", "clear"])
    expect(memoryRows({ ...view, entries: [], files: [] })).toEqual([])
  })

  test("⌫ deletes the highlighted line or file; a ✕ deletes its row; Enter does nothing on a line", () => {
    expect(after([...open, key("backspace")]).effects).toEqual([{ type: "memoryDelete", agent: "momentum", entry: "a1" }])
    expect(after([...open, key("down"), key("down"), key("delete")]).effects).toEqual([{ type: "memoryDelete", agent: "momentum", file: "sizing.md" }])
    expect(after([...open, key("return")]).effects).toEqual([])
    expect(after([...open, { type: "deleteMemory", row: { kind: "entry", id: "b2", text: "x" }, now: 0 }]).effects).toEqual([{ type: "memoryDelete", agent: "momentum", entry: "b2" }])
  })

  test("clear all asks once: Enter or a click asks, the second clears, Esc only takes the question back", () => {
    const atClear = [...open, key("down"), key("down"), key("down")]
    const asked = after([...atClear, key("return")])
    expect(asked.effects).toEqual([])
    expect(asked.state.overlay).toMatchObject({ kind: "memory", confirm: true })
    expect(after([...atClear, key("return"), key("return")]).effects).toEqual([{ type: "memoryDelete", agent: "momentum", all: true }])
    const back = after([...atClear, key("return"), key("escape")])
    expect(back.state.overlay).toEqual({ kind: "memory", agent: "momentum", index: 3 })
    expect(after([...atClear, key("return"), key("escape"), key("escape")]).state.overlay).toBeUndefined()
    expect(after([...open, { type: "clickMemoryClear", now: 0 }, { type: "clickMemoryClear", now: 0 }]).effects).toEqual([{ type: "memoryDelete", agent: "momentum", all: true }])
    // ⌫ on clear all deletes nothing.
    expect(after([...atClear, key("backspace")]).effects).toEqual([])
  })

  test("letters type nothing and close nothing; Esc closes", () => {
    const r = run([...open, { type: "key", key: { name: "x", sequence: "x" }, now: 0 }])
    expect(r.state.overlay).toMatchObject({ kind: "memory" })
    expect(r.state.input).toBe("")
    expect(run([...open, key("escape")]).state.overlay).toBeUndefined()
  })
})
