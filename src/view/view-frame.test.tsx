// The agent's harness_view on screen: a layout it changes drawn as a preview, kept or discarded; tabs changed,
// and a theme it made used, at once with an undo. The chips sit under the agent's reply. Drawn with the
// scenes' realistic data.
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { drawScene, everyTab, status } from "../../test/frame-scenes"
import { layoutNamed, parseLayouts, treeOf } from "./layouts-file"
import { panesOf } from "./layout"
import { memoryStore } from "./layouts-store"
import { memoryThemes } from "./themes"

process.env.TZ = "UTC"

type Drawn = Awaited<ReturnType<typeof drawScene>>
let drawn: Drawn | undefined
afterEach(async () => {
  const d = drawn
  drawn = undefined
  if (d) await act(async () => d.setup.renderer.destroy())
})

const frame = () => drawn!.setup.captureCharFrame()
const settle = async (fn: () => void | Promise<void>) => {
  await act(async () => {
    await fn()
  })
  await drawn!.setup.renderOnce()
}
const find = (text: string): { x: number; y: number } => {
  const rows = frame().split("\n")
  const y = rows.findIndex((r) => r.includes(text))
  if (y < 0) throw new Error(`${text} isn't on screen:\n${frame()}`)
  return { x: rows[y]!.indexOf(text), y }
}
const click = (text: string) =>
  settle(() => {
    const at = find(text)
    return drawn!.setup.mockMouse.click(at.x + 1, at.y)
  })
let asked = 0
/** The core's ask, as it comes on `asks`, and the view's answer to it. */
async function ask(args: Record<string, unknown>): Promise<{ ok: boolean; text: string; words?: string; code?: string }> {
  const id = `ask-${++asked}`
  await settle(() => drawn!.session.push("asks", { id, agent: "agent-a", args }))
  for (let i = 0; i < 50; i++) {
    const answer = drawn!.session.requests.find((r) => r.method === "view.answer" && r.params.id === id)
    if (answer) return answer.params.result as { ok: boolean; text: string; words?: string }
    await settle(() => Bun.sleep(5))
  }
  throw new Error(`no answer to ${JSON.stringify(args)}`)
}
/** The layout menu, from the tab bar's settings chip. */
const openLayoutMenu = async () => {
  await click("settings ▾")
  await click("this tab's panes")
}
/** The row of the agent pane's offer, under its reply: on the left, not the tab bar. */
const offerRow = (words: string) => frame().split("\n").find((r) => r.includes(words))
const notes = () => drawn!.session.requests.filter((r) => r.method === "view.note").map((r) => r.params.words)

test("a layout the agent builds is a preview: drawn at once, nothing written, kept under its reply as the tab's own changes", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  const answer = await ask({ action: "build", root: ["row", "agent 55", ["column", 45, "token 60", "signals 40"]] })
  expect(answer).toMatchObject({ ok: true, words: "previewed a layout on Trade: a new layout of agent, token, signals" })
  expect(frame()).toContain("Signals · Hacc's tape")
  expect(frame()).not.toContain("╭─ Wallets")
  expect(offerRow("agent-a's layout on Trade is a preview")).toContain("agent-a's layout on Trade is a preview   keep   discard")
  expect(frame().split("\n")[1]).not.toContain("keep")
  expect(store.written).toEqual([])
  // Kept: on the tab, with save as… on the tab bar to name it; layouts.toml untouched.
  await click(" keep ")
  expect(frame()).not.toContain("is a preview")
  expect(frame()).toContain("Kept agent-a's layout on Trade: save as… on the tab bar")
  expect(store.written).toEqual([])
  expect(store.adjusted().Trade?.base).toBe("Agent-first")
  expect(store.choices()).toEqual({})
  expect(notes()).toEqual(["kept agent-a's layout on Trade"])
  expect(frame()).toContain("Signals · Hacc's tape")
  expect(frame().split("\n")[1]).toContain("unsaved changes")
})

test("a preview discarded leaves the tab as it was; the agent can switch the tab on screen", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  await ask({ action: "close", pane: "wallets" })
  expect(frame()).not.toContain("╭─ Wallets")
  await click(" discard ")
  expect(frame()).toContain("╭─ Wallets")
  expect(frame()).not.toContain("is a preview")
  expect(store.written).toEqual([])
  expect(notes()).toEqual(["discarded agent-a's layout on Trade"])
  // Focus stays where the person left it (keys.test.ts).
  expect(await ask({ action: "tab", tab: "Cockpit" })).toMatchObject({ ok: true, words: "switched to the Cockpit tab" })
  expect(frame()).toContain("Feed · on fire")
})

test("the person's own edit on the agent's preview keeps it, with their change", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  await ask({ action: "close", pane: "wallets" })
  await openLayoutMenu()
  // The menu edits what's drawn: wallets is off, so it's offered to open.
  await settle(() => {
    const at = find("│   feed ")
    return drawn!.setup.mockMouse.click(at.x + 5, at.y)
  })
  const root = treeOf(store.adjusted().Trade!.tree, true, new Set())
  expect(typeof root !== "string" && panesOf(root)).toEqual(["agent", "feed", "token", "positions", "activity"])
  expect(store.written).toEqual([])
  expect(frame()).not.toContain("is a preview")
  expect(notes()).toEqual(["kept agent-a's layout on Trade, with a change of yours"])
})

// An older layouts.toml, listing two tabs: the others are there, ticked off.
const TWO_TABS = 'tabs = [{ name = "Trade", layout = "Agent-first" }, { name = "Cockpit", layout = "Cockpit" }]\n'

test("a tab added at once, with an undo under the reply that puts the tabs back", async () => {
  const store = memoryStore(TWO_TABS)
  drawn = await drawScene("followed", 140, 40, "trade", store)
  const answer = await ask({ action: "add_tab", name: "Tape", layout: "Cockpit" })
  expect(answer).toMatchObject({ ok: true, words: "added the tab Tape (Cockpit)" })
  expect(frame()).toContain("1 Trade  2 Cockpit  3 Tape")
  expect(parseLayouts(store.written.at(-1)!).tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Tape"])
  expect(offerRow("agent-a added the tab Tape (Cockpit)")).toContain("agent-a added the tab Tape (Cockpit)   undo   ✕")
  // The offer's undo, not a Hacc change's on an Activity line.
  await click("undo   ✕")
  expect(frame()).not.toContain("3 Tape")
  expect(parseLayouts(store.written.at(-1)!).tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit"])
  expect(notes()).toEqual(["undid agent-a's change: added the tab Tape (Cockpit)"])
})

test("a theme the agent makes is written, checked and used at once, with an undo under the reply", async () => {
  const themes = memoryThemes()
  drawn = await drawScene("followed", 140, 40, "trade", undefined, { themes })
  const answer = await ask({ action: "make_theme", name: "Dusk", base: "Candle light" })
  expect(answer).toMatchObject({ ok: true, words: "made the theme Dusk, and switched to it" })
  expect(answer.text).toContain("on screen now")
  expect(themes.own()).toEqual(["Dusk"])
  expect(themes.saved.at(-1)).toMatchObject({ name: "Dusk" })
  expect(offerRow("agent-a's theme Dusk is on")).toContain("agent-a's theme Dusk is on   undo   ✕")
  // Undo puts the theme before it back.
  await click("undo   ✕")
  await settle(() => Bun.sleep(5))
  expect(themes.saved.at(-1)).toMatchObject({ name: "Candle dark" })
  expect(notes()).toEqual(["put Candle dark back over agent-a's theme Dusk"])
  // One that wouldn't read is refused, and nothing's written.
  expect(await ask({ action: "make_theme", name: "Faint", colours: { dim: "#20252b" } })).toMatchObject({ ok: false, code: "UNREADABLE" })
  expect(themes.own()).toEqual(["Dusk"])
})

test("the layout menu adds, renames and removes tabs too, so the person can without the agent", async () => {
  const store = memoryStore(TWO_TABS)
  // Tall enough for the menu's every row: the newer tabs' panes make it long.
  drawn = await drawScene("followed", 140, 66, "trade", store)
  const typed = async (row: string, name: string) => {
    await openLayoutMenu()
    await click(row)
    for (const ch of name) await settle(() => drawn!.setup.mockInput.typeText(ch))
    await settle(() => drawn!.setup.mockInput.pressEnter())
  }
  await typed("add a tab…", "Desk")
  expect(frame()).toContain("Added the tab Desk, showing Agent-first.")
  // The new tab is on screen.
  expect(frame()).toContain("1 Trade  2 Cockpit  3 Desk")
  await typed("rename Desk…", "Tape")
  expect(frame()).toContain("1 Trade  2 Cockpit  3 Tape")
  expect(parseLayouts(store.written.at(-1)!).tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Tape"])
  // A name another tab has is refused, and nothing's written.
  const writes = store.written.length
  await typed("rename Tape…", "Trade")
  expect(frame()).toContain("There's a tab called Trade already.")
  // Esc waits out the terminal's escape-sequence timeout before it counts as a key.
  for (let i = 0; i < 2; i++) await settle(async () => {
    drawn!.setup.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  expect(store.written.length).toBe(writes)
  await openLayoutMenu()
  await click("remove Tape")
  expect(frame()).toContain("1 Trade  2 Cockpit")
  expect(frame()).not.toContain("3 Tape")
  expect(parseLayouts(store.written.at(-1)!).tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit"])
})

// The newer tabs: a pane shown where the tab is narrow, a tab ticked on, Signals and the Journal set.
test("tab with a pane shows it in a narrow tab's switched pane; show_tab ticks a tab on, with an undo", async () => {
  const store = memoryStore(TWO_TABS)
  drawn = await drawScene("followed", 120, 30, "trade", store)
  expect(await ask({ action: "tab", pane: "final-stretch" })).toMatchObject({ ok: false, code: "UNKNOWN_TAB" })
  const shown = await ask({ action: "show_tab", tab: "Trending" })
  expect(shown).toMatchObject({ ok: true, words: "showed the Trending tab" })
  expect(parseLayouts(store.written.at(-1)!).tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Trending"])
  expect(frame()).toContain("New")
  expect(await ask({ action: "tab", pane: "final-stretch" })).toMatchObject({ ok: true, words: "showed final-stretch on the Trending tab" })
  expect(frame()).toContain("Final Stretch")
  // The tab bar changes under the mouse, so its hover lands in the render: drawn inside act.
  const undo = find(" undo ")
  await act(async () => {
    await drawn!.setup.mockMouse.click(undo.x + 1, undo.y)
    await drawn!.setup.renderOnce()
  })
  expect(parseLayouts(store.written.at(-1)!).tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit"])
  expect(notes()).toEqual(["undid agent-a's change: showed the Trending tab"])
})

test("signals and journal set the pane where it is, switching to its tab, and leave focus alone", async () => {
  // Every tab on, as a person who ticked Signals and the Journal on has them.
  drawn = await drawScene("followed", 140, 40, "trade", everyTab())
  const kol = await ask({ action: "signals", tab: "Signals", pattern: "kol_mention" })
  expect(kol).toMatchObject({ ok: true, words: "set Signals on Signals to only mention signals (kol_mention) from Hacc's tape" })
  expect(drawn.session.requests.find((r) => r.method === "view.signals")?.params).toEqual({ at: "Signals", mine: false, pattern: "kol_mention", chain: null })
  // The Journal's first page is read as its tab comes on screen: answered inside act.
  let found: Awaited<ReturnType<typeof ask>> | undefined
  await act(async () => {
    found = await ask({ action: "journal", search: "JUP sell" })
    await Bun.sleep(20)
  })
  expect(found).toMatchObject({ ok: true, words: 'searched the Journal for "JUP sell"' })
  await settle(() => Bun.sleep(20))
  expect(frame()).toContain("JUP sell")
  expect(drawn.session.requests.filter((r) => r.method === "journal.query").at(-1)?.params).toMatchObject({ text: "JUP sell" })
})

test("a typed pnl 24h off the P&L tab reads the window from the status, not a stale pnl topic", async () => {
  drawn = await drawScene("followed", 140, 40, "trade")
  await settle(() => drawn!.session.push("status", { ...status, pnl: { window: "18:00", usd: 0, label: "since 18:00", from: 0, short: false } }, true))
  for (const ch of "pnl 24h") await settle(() => drawn!.setup.mockInput.typeText(ch))
  await settle(() => drawn!.setup.mockInput.pressEnter())
  expect(drawn.session.requests.filter((r) => r.method === "pnl.window").map((r) => r.params)).toEqual([{ window: "24h" }])
})
