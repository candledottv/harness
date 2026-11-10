// Keep-awake's palette row: only where the machine has it (macOS), saying what it does now, and picking it
// switches it the other way.
import { expect, test } from "bun:test"
import { type PaletteInput, paletteRows } from "./palette-rows"

const BASE: PaletteInput = { tabs: ["Trade"], tab: 0, agents: ["momentum"], activeAgent: "momentum", presets: {}, tokens: new Map(), paused: false, card: false, requotable: false, working: false, ask: false, aliases: new Map(), aliasProblems: 0, popped: [] }
const row = (keepAwake?: PaletteInput["keepAwake"]) => paletteRows({ ...BASE, ...(keepAwake ? { keepAwake } : {}) }, "keep awake").find((r) => r.id === "keepAwake")

test("keep-awake's row: macOS only, its state in words, and a pick that switches it", () => {
  expect(row()).toBeUndefined()
  expect(row({ on: true, available: false, active: false })).toBeUndefined()
  expect(row({ on: false, available: true, active: false })).toMatchObject({ section: "Triggers", label: "keep the Mac awake while triggers or bots are on", run: { kind: "keepAwake", on: true } })
  expect(row({ on: true, available: true, active: true })).toMatchObject({ current: true, words: "on: keeping the Mac awake now, for the triggers and bots that are on; ⏎ turns it off", run: { kind: "keepAwake", on: false } })
  expect(row({ on: true, available: true, active: false, failed: "caffeinate ended as it started (exit 1)" })!.words).toBe("on, but caffeinate ended as it started (exit 1); ⏎ turns it off")
  expect(paletteRows({ ...BASE, keepAwake: { on: false, available: true, active: false } }, "triggers").slice(0, 2).map((r) => r.id)).toEqual(["triggers", "keepAwake"])
})
