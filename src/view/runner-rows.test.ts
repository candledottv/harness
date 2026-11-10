// The code runner's rows: in the model picker under its own heading, and in the palette, for the active agent.
// Off, a pick turns it on; on, a pick turns it off; where the system can't hold it, the row says why and picks nothing.
import { expect, test } from "bun:test"
import { type PaletteInput, paletteRows } from "./palette-rows"
import { type EngineTopic, pickable, pickerRows } from "./panes/engines"

const BASE: PaletteInput = { tabs: ["Trade"], tab: 0, agents: ["momentum"], activeAgent: "momentum", presets: {}, tokens: new Map(), paused: false, card: false, requotable: false, working: false, ask: false, aliases: new Map(), aliasProblems: 0, popped: [] }
const row = (runner?: PaletteInput["runner"]) => paletteRows({ ...BASE, ...(runner ? { runner } : {}) }, "code runner").find((r) => r.id === "runner")

test("the palette's row: off picks on, on picks off, unheld says why; none until the core says", () => {
  expect(row()).toBeUndefined()
  expect(row({ held: { ok: true }, on: {} })).toMatchObject({ label: "turn on momentum's code runner", run: { kind: "runner", agent: "momentum", on: true } })
  expect(row({ held: { ok: true }, on: { momentum: ["python3"] } })).toMatchObject({ label: "turn off momentum's code runner", run: { kind: "runner", agent: "momentum", on: false } })
  const unheld = row({ held: { ok: false, why: "this kernel's Landlock is ABI 4, and holding signals needs 6", fix: "Linux 6.12" }, on: {} })
  expect(unheld?.run).toBeUndefined()
  expect(unheld?.why).toBe("it can't be held here: this kernel's Landlock is ABI 4, and holding signals needs 6")
})

const topic = (runner: EngineTopic["runner"], run?: readonly string[]): EngineTopic => ({
  agents: { momentum: { engine: "claude-code", from: "config", ...(run ? { tools: { shell: "off", deny: [], run } } : {}) } },
  engines: {},
  ...(runner ? { runner } : {}),
})

test("the picker's rows: under its own heading after the presets; Enter turns it on or off; unheld, a line with what it needs", () => {
  const off = pickerRows(topic({ ok: true, how: "Landlock (ABI 8) and seccomp" }), {}, "", "momentum")
  const heading = off.findIndex((r) => r.kind === "presets" && r.text === "code runner")
  expect(heading).toBeGreaterThan(0)
  expect(off[heading + 1]).toMatchObject({ kind: "runner", on: true, current: false })
  expect((off[heading + 1] as { text: string }).text).toBe("off · ⏎ turns it on for python3, bun, node: held to the research folder, no network, 60 s a run")
  expect(pickable(off).some((r) => r.kind === "runner")).toBe(true)
  const on = pickerRows(topic({ ok: true, how: "Seatbelt" }, ["python3", "node"]), {}, "", "momentum")
  expect(on.find((r) => r.kind === "runner")).toMatchObject({ on: false, current: true, text: "on for python3, node: held to the research folder, no network, 60 s a run · ⏎ turns it off" })
  const unheld = pickerRows(topic({ ok: false, why: "this kernel has no Landlock, or it's turned off", fix: "a Linux 6.12 kernel or later" }), {}, "", "momentum")
  expect(unheld.find((r) => r.kind === "runner")).toBeUndefined()
  expect(unheld.find((r) => r.kind === "runnerInfo")).toMatchObject({ text: "can't be held here: this kernel has no Landlock, or it's turned off. It needs a Linux 6.12 kernel or later." })
  // A search finds it by its words, and leaves it out otherwise.
  expect(pickerRows(topic({ ok: true, how: "x" }), {}, "python", "momentum").some((r) => r.kind === "runner")).toBe(true)
  expect(pickerRows(topic({ ok: true, how: "x" }), {}, "opus", "momentum").some((r) => r.kind === "runner")).toBe(false)
})
