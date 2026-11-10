// Layouts and tabs on screen: the tabs from layouts.toml, the layout menu's edits kept on the tab until saved,
// the card strip on a layout without the agent pane, a dragged border, a file with a problem, and save as.
// Drawn with the scenes' realistic data.
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { CLOCK, drawScene } from "../../test/frame-scenes"
import { SETTINGS_CHIP } from "./tabs"
import { layoutNamed, parseLayouts, treeOf } from "./layouts-file"
import { panesOf } from "./layout"
import { memoryStore } from "./layouts-store"

process.env.TZ = "UTC"

type Drawn = Awaited<ReturnType<typeof drawScene>>
let drawn: Drawn | undefined
afterEach(async () => {
  const d = drawn
  drawn = undefined
  if (d) await act(async () => d.setup.renderer.destroy())
})

const frame = () => drawn!.setup.captureCharFrame()
/** A tab's adjusted tree as kept in state/layout.json, read back. */
const kept = (store: ReturnType<typeof memoryStore>, tab: string) => {
  const a = store.adjusted()[tab]
  if (!a) throw new Error(`${tab} has no adjustments`)
  const root = treeOf(a.tree, true, new Set())
  if (typeof root === "string") throw new Error(root)
  return { base: a.base, root }
}
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
const click = (text: string) => settle(() => {
  const at = find(text)
  return drawn!.setup.mockMouse.click(at.x + 1, at.y)
})
const press = (name: string) => settle(() => (name === "return" ? drawn!.setup.mockInput.pressEnter() : drawn!.setup.mockInput.pressKey(name)))
const arrow = (dir: "up" | "down" | "left" | "right") => settle(() => drawn!.setup.mockInput.pressArrow(dir))
/** The layout menu, from the tab bar's settings chip and its layout row. */
const openLayoutMenu = async () => {
  await click(SETTINGS_CHIP)
  await click("this tab's panes")
}

const WATCH = `tabs = [
  { name = "Trade", layout = "Agent-first" },
  { name = "Watch", layout = "Watch" },
]

[layouts.Watch]
root = ["row", ["column", 50, "feed", "signals"], "token 50"]
`

test("the tabs come from layouts.toml, and a layout of yours shows on its tab", async () => {
  const store = memoryStore(WATCH)
  drawn = await drawScene("trending", 140, 40, "trade", store)
  expect(frame()).toContain("1 Trade  2 Watch   settings ▾")
  // The default tabs it doesn't name are there unticked, offered on the tab bar until settings ▾ is opened
  // (a 6 s message went by unseen, and counted as told).
  expect(frame()).toContain("9 new tabs are ticked off")
  expect(frame()).toContain("show them")
  expect(store.told()).toEqual([])
  for (const a of ["up", "right", "down"] as const) await arrow(a)
  expect(frame()).toContain("Feed · on fire")
  expect(frame()).toContain("Signals · Hacc's tape")
  expect(frame()).not.toContain("╭─ agent-a")
  await click("show them")
  expect(frame()).toContain("tabs: tick the ones to show")
  expect(store.told()).toEqual(["Cockpit", "Trending", "Signals", "P&L", "Research", "Journal", "Perps", "Bots", "Build"])
  await press("escape")
  expect(frame()).not.toContain("show them")
})

test("the layout menu closes a pane: the change stays on the tab, layouts.toml untouched, with save as… and reset on the tab bar", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  // Focus Wallets, then the menu from the tab bar's chip.
  // Tab round to Wallets: the agent, its card, the token, positions (↓ in Positions moves its rows).
  for (let i = 0; i < 4; i++) await settle(() => drawn!.setup.mockInput.pressTab())
  await openLayoutMenu()
  expect(frame()).toContain("layout · Trade")
  expect(frame()).toContain("The focused pane, wallets (this tab only, until saved)")
  await click("close wallets")
  expect(frame()).not.toContain("╭─ Wallets")
  // A new layout for every adjustment would pile up copies nobody asked for. Nothing written, nothing chosen.
  expect(store.written).toEqual([])
  expect(store.choices()).toEqual({})
  expect(kept(store, "Trade").base).toBe("Agent-first")
  expect(panesOf(kept(store, "Trade").root)).toEqual(["agent", "token", "positions", "activity"])
  expect(frame()).toContain("unsaved changes")
  // A preset can't take a save into it: save as… and reset only.
  expect(frame()).not.toContain(" save  ")
  await click("reset")
  expect(frame()).toContain("╭─ Wallets")
  expect(frame()).toContain("Trade is back to Agent-first as saved.")
  expect(store.adjusted()).toEqual({})
  expect(frame()).not.toContain("unsaved changes")
  // Showing another layout drops the tab's changes too: one row each.
  for (let i = 0; i < 4; i++) await settle(() => drawn!.setup.mockInput.pressTab())
  await openLayoutMenu()
  await click("close wallets")
  await openLayoutMenu()
  for (let i = 0; i < 60 && !frame().includes("▸ Cockpit"); i++) await arrow("down")
  await press("return")
  expect(store.choices()).toEqual({ Trade: "Cockpit" })
  expect(store.adjusted()).toEqual({})
})

test("an edit to a layout of yours another tab shows stays on its tab, so that tab keeps its panes; save writes it into the layout", async () => {
  const both = `tabs = [
  { name = "Trade", layout = "Desk" },
  { name = "Watch", layout = "Desk" },
]

[layouts.Desk]
root = ["row", "agent 60", "token 40"]
`
  const store = memoryStore(both, { Watch: "Desk" })
  drawn = await drawScene("followed", 140, 40, "trade", store)
  await click("2 Watch")
  await click("you › how's JUPF")
  await openLayoutMenu()
  expect(frame()).toContain("The focused pane, agent (this tab only, until saved)")
  await click("close agent")
  expect(store.written).toEqual([])
  expect(Object.keys(store.adjusted())).toEqual(["Watch"])
  expect(panesOf(kept(store, "Watch").root)).toEqual(["token"])
  await click("1 Trade")
  expect(frame()).toContain("╭─ agent-a")
  expect(frame()).not.toContain("unsaved changes")
  // Saved into Desk, deliberately: the menu and the message say Trade changes too.
  await click("2 Watch")
  expect(frame()).toContain("unsaved changes")
  await click("save ")
  expect(frame()).toContain("Saved into Desk in layouts.toml; Trade shows it too, so it changes as well.")
  expect(panesOf(layoutNamed(parseLayouts(store.written.at(-1)!), "Desk")!.root)).toEqual(["token"])
  expect(store.adjusted()).toEqual({})
})

test("the menu's keys: ↓ to a row, Enter; move and resize keep it open for another press; save as asks a name", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  await openLayoutMenu()
  const rows = frame()
  expect(rows).toContain("wider")
  // From the agent pane: wider twice, by keys.
  while (!frame().includes("▸ wider")) await arrow("down")
  await press("return")
  await press("return")
  expect(frame()).toContain("layout · Trade")
  expect(store.written).toEqual([])
  expect(kept(store, "Trade").root).toMatchObject({ children: [{ pane: "agent", weight: 96 }, { weight: 44 }] })
  while (!frame().includes("▸ save this layout as…")) await arrow("down")
  await press("return")
  for (const ch of "Desk") await settle(() => drawn!.setup.mockInput.typeText(ch))
  expect(frame()).toContain("name: Desk")
  await press("return")
  expect(frame()).toContain(`Saved as "Desk" in layouts.toml; Trade shows it.`)
  expect(layoutNamed(parseLayouts(store.written.at(-1)!), "Desk")).toBeDefined()
  expect(store.choices()).toEqual({ Trade: "Desk" })
  expect(store.adjusted()).toEqual({})
})

test("the tab bar's save as… names the tab's changes, and they're kept across a restart until then", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  for (let i = 0; i < 4; i++) await settle(() => drawn!.setup.mockInput.pressTab())
  await openLayoutMenu()
  await click("close wallets")
  await settle(() => drawn!.setup.renderer.destroy())
  // A new view on the same state: the tab still shows its changes, offered to save.
  drawn = await drawScene("followed", 140, 40, "trade", store)
  expect(frame()).not.toContain("╭─ Wallets")
  expect(frame()).toContain("unsaved changes")
  await click("save as…")
  expect(frame()).toContain("name:")
  for (const ch of "Calm") await settle(() => drawn!.setup.mockInput.typeText(ch))
  await press("return")
  expect(frame()).toContain(`Saved as "Calm" in layouts.toml; Trade shows it.`)
  expect(panesOf(layoutNamed(parseLayouts(store.written.at(-1)!), "Calm")!.root)).toEqual(["agent", "token", "positions", "activity"])
  expect(store.adjusted()).toEqual({})
  expect(frame()).not.toContain("unsaved changes")
})

test("the commands pane's layout row opens the menu", async () => {
  drawn = await drawScene("followed", 140, 40)
  await press("?")
  await press("c")
  for (const ch of "layout") await settle(() => drawn!.setup.mockInput.typeText(ch))
  await press("return")
  expect(frame()).toContain("layout · Trade")
})

test("a layout without the agent pane: the cards wait in a strip above the input line, which says the agent is answering, with a chip to its tab", async () => {
  drawn = await drawScene("followed", 140, 40, "trade", memoryStore(WATCH))
  await settle(() => drawn!.session.push("agent", { agent: "agent-a", turnId: "t2", type: "started", user: "anything new?" }))
  for (const a of ["up", "right", "down"] as const) await arrow(a)
  expect(frame()).toContain("╭─ cards")
  expect(frame()).toContain("agent-a is answering")
  expect(frame()).toContain("1 card waiting · ⏎ approves the highlighted one")
  expect(frame()).toContain("BUY 0.1 SOL of JUPF")
  expect(frame()).toContain("⏎ approve")
  // The strip sits right above the message and input lines.
  const rows = frame().split("\n")
  expect(rows.findLastIndex((r) => r.startsWith("╰")) ).toBeGreaterThan(rows.findIndex((r) => r.includes("╭─ cards")))
  await click("see it on Trade")
  expect(frame()).toContain("╭─ agent-a")
  expect(frame()).not.toContain("╭─ cards")
})

test("a border dragged resizes: the layout follows the pointer, and is kept when it's let go", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  // The agent pane's right border, between it and the column, on a row of the conversation.
  const y = find("you › how's JUPF looking?").y
  // A column apart from the pane beside it: its own border is the one before the gap.
  const x = frame().split("\n")[y]!.indexOf("│ │")
  await settle(() => drawn!.setup.mockMouse.drag(x, y, x + 10, y))
  expect(store.written).toEqual([])
  expect(kept(store, "Trade").root).toMatchObject({ children: [{ pane: "agent", weight: 93 }, { weight: 46 }] })
  expect(frame().split("\n")[y]!.indexOf("│ │")).toBe(x + 10)
})

test("a layouts.toml with a problem: named with its line at the start, listed in the menu, and never written over, though the tab still takes an edit", async () => {
  const store = memoryStore(`tabs = [\n  { name = "Trade", layout = "Agent-first" },\n]\n\n[layouts.Typo]\nroot = ["row", "agnet"]\n`)
  drawn = await drawScene("followed", 140, 40, "trade", store)
  expect(frame()).toContain(`layouts.toml line 6: layout "Typo": there's no pane called "agnet"`)
  // Tab round to Wallets: the agent, its card, the token, positions (↓ in Positions moves its rows).
  for (let i = 0; i < 4; i++) await settle(() => drawn!.setup.mockInput.pressTab())
  await openLayoutMenu()
  expect(frame()).toContain(`layouts.toml line 6: layout "Typo"`)
  await click("close wallets")
  // The edit stays on the tab, so nothing of the file is touched; a save would be refused.
  expect(store.written).toEqual([])
  expect(frame()).not.toContain("╭─ Wallets")
  await click("save as…")
  for (const ch of "Calm") await settle(() => drawn!.setup.mockInput.typeText(ch))
  await press("return")
  expect(store.written).toEqual([])
  // Wrapped under the agent pane, so read in pieces.
  expect(frame()).toContain("fix it and reload from")
  expect(frame()).toContain("before the Candle Harness writes it")
})

test("CLOCK is the scenes' clock", () => expect(CLOCK).toBeGreaterThan(0))

test("reload reads a hand edit: a new tab and its layout, without a restart", async () => {
  const store = memoryStore()
  // Tall enough for the menu's every row: the newer panes make it long.
  drawn = await drawScene("followed", 140, 60, "trade", store)
  store.write(WATCH)
  await openLayoutMenu()
  await click("reload layouts.toml")
  expect(frame()).toContain("Read layouts.toml: 2 tabs, 1 layout of yours.")
  expect(frame()).toContain("1 Trade  2 Watch")
})

test("on a layout without the agent pane, Esc and ↑ from the cards leave focus where it is, and Tab reaches the cards last", async () => {
  drawn = await drawScene("followed", 140, 40, "trade", memoryStore(WATCH))
  for (const a of ["up", "right", "down"] as const) await arrow(a)
  // Tab round: Feed, Signals, Token, then the cards.
  for (let i = 0; i < 3; i++) await settle(() => drawn!.setup.mockInput.pressTab())
  await settle(() => drawn!.setup.mockInput.pressTab())
  expect(frame()).toContain("1 card waiting · ⏎ approves the highlighted one")
  await press("escape")
  await arrow("up")
  // Still on the Watch tab, with no agent pane drawn.
  expect(frame()).toContain("╭─ cards")
  expect(frame()).not.toContain("╭─ agent-a")
})

test("tabs are a setting: settings ▾ ticks each off and on, written to layouts.toml with shown = false", async () => {
  const store = memoryStore()
  drawn = await drawScene("followed", 140, 40, "trade", store)
  await click(SETTINGS_CHIP)
  expect(frame()).toContain("tabs: tick the ones to show")
  await click("[x] Research")
  expect(frame()).toContain("Research is ticked off the tab bar; its layout is kept.")
  expect(frame()).toContain("1 Trade  2 Cockpit  3 Bots  4 Build   settings ▾")
  expect(store.written.at(-1)).toContain(`{ name = "Research", layout = "Research", shown = false },`)
  // The menu stays open for another tick; ticked back on, it's in its place again.
  await click("[ ] Research")
  expect(frame()).toContain("1 Trade  2 Cockpit  3 Research  4 Bots  5 Build")
  // One a fresh install has off comes on where it sits among the tabs.
  await click("[ ] Signals")
  expect(frame()).toContain("1 Trade  2 Cockpit  3 Signals  4 Research  5 Bots  6 Build")
  expect(parseLayouts(store.written.at(-1)!).hidden.map((h) => h.tab.name)).toEqual(["Trending", "P&L", "Journal", "Perps"])
})

test("ctrl-t on a highlighted Feed row picks its token at once and puts a question about it on the line", async () => {
  drawn = await drawScene("trending", 160, 45, "cockpit")
  const asks = (kind: string) => drawn!.session.requests.filter((r) => r.method === kind)
  await click("╭─ Feed")
  await arrow("down")
  // The highlighted row carries its ask chip.
  expect(frame().split("\n").find((r) => r.includes("Orbit") || r.includes("ORBIT"))).toContain(" ask ")
  await settle(() => drawn!.setup.mockInput.pressKey("t", { ctrl: true }))
  // The line shows its end, where the cursor is.
  expect(frame()).toContain("From On Fire: +10.2% in the hour, $4.2M market cap.")
  expect(asks("view.link")).toHaveLength(1)
  expect(asks("view.link")[0]!.params).toMatchObject({ from: "feed, by ctrl-t" })
  // Nothing went to the agent: Enter sends it.
  expect(drawn.session.requests.some((r) => r.method === "agent.send" || r.method === "agent.message")).toBe(false)
})

test("the Trending tab's lists pick like Feed: ctrl-t on a Final Stretch or New row asks about it in the Candle Harness's words, a click on Graduated picks", async () => {
  drawn = await drawScene("trending", 160, 45, "trending")
  const links = () => drawn!.session.requests.filter((r) => r.method === "view.link").map((r) => r.params)
  await click("╭─ Final Stretch")
  await arrow("down")
  await settle(() => drawn!.setup.mockInput.pressKey("t", { ctrl: true }))
  expect(frame()).toContain("From Final Stretch: 99% along its bonding curve, last traded 4s ago.")
  expect(links().at(-1)).toMatchObject({ from: "final-stretch, by ctrl-t" })
  // A new question replaces the line's: cleared first, as a person would.
  await settle(() => drawn!.setup.mockInput.pressKey("u", { ctrl: true }))
  await click("╭─ New")
  await arrow("down")
  await settle(() => drawn!.setup.mockInput.pressKey("t", { ctrl: true }))
  expect(frame()).toContain("From New: made 12s ago, $3.9K market cap.")
  expect(links().at(-1)).toMatchObject({ from: "new, by ctrl-t" })
  await click("SUMMIT")
  expect(links().at(-1)).toMatchObject({ from: "graduated, by a click" })
  expect(drawn.session.requests.some((r) => r.method === "agent.send" || r.method === "agent.message")).toBe(false)
})

test("Trending collapsed: the switcher's ▸ shows the next list, and the subscription moves with it to the one on screen", async () => {
  drawn = await drawScene("trending", 80, 24, "trending")
  const buckets = () => (drawn!.session.filters.at(-1)?.feeds as { buckets?: string[] } | undefined)?.buckets
  expect(frame()).toContain("◂  new  ▸")
  expect(buckets()).toEqual(["new"])
  await click("▸")
  expect(frame()).toContain("◂  graduated  ▸")
  expect(frame()).toContain("╭─ Graduated")
  expect(buckets()).toEqual(["graduated"])
})

// A layouts.toml from an older version: Research shows a layout saved unasked from a resize, before Research
// gained its list pane, so the list never appeared.
const OLD_RESEARCH = `tabs = [
  { name = "Trade", layout = "Agent-first" },
  { name = "Cockpit", layout = "Cockpit" },
  { name = "Trending", layout = "Trending" },
  { name = "Signals", layout = "Signals" },
  { name = "P&L", layout = "P&L" },
  { name = "Research", layout = "My Research" },
  { name = "Journal", layout = "Journal" },
  { name = "Perps", layout = "Perps" },
  { name = "Bots", layout = "Bots" },
  { name = "Build", layout = "Build" },
]

[layouts."My Research"]
collapse = 130
root = ["row",
  ["row", 62,
    ["column", 55, "token 16", "check 20"],
    ["column", 45, "traders 34", "token-signals 33", "mentions 33"]],
  "agent 38"]
`

test("a preset's new pane is offered to a layout of yours saved from it: add puts it where the preset has it, unsaved until saved", async () => {
  const store = memoryStore(OLD_RESEARCH)
  drawn = await drawScene("followed", 160, 45, "research", store)
  expect(frame()).toContain("Research has a new pane: lists")
  await click("add")
  expect(frame()).toContain("unsaved changes")
  expect(store.written).toEqual([])
  const a = kept(store, "Research")
  expect(a.base).toBe("My Research")
  // Heading its column, as in the preset.
  expect(panesOf(a.root)).toEqual(["token", "check", "lists", "traders", "token-signals", "mentions", "agent"])
  // Saved into the layout, it's in layouts.toml, and nothing more is offered.
  await click(" save ")
  expect(layoutNamed(parseLayouts(store.written.at(-1)!), "My Research")!.root).toMatchObject({ dir: "row" })
  expect(panesOf(layoutNamed(parseLayouts(store.written.at(-1)!), "My Research")!.root)).toContain("lists")
  expect(frame()).not.toContain("has a new pane")
})

test("✕ leaves a preset's new pane out of that layout for good; a layout saved from a preset records it, and isn't offered its own panes", async () => {
  const store = memoryStore(OLD_RESEARCH)
  drawn = await drawScene("followed", 160, 45, "research", store)
  await click("✕")
  expect(frame()).not.toContain("has a new pane")
  expect(store.dismissedPanes()).toEqual({ "My Research": ["lists"] })
})

// A layouts.toml as an upgrade from an older version left it: a tab of its own, and each tab on a layout saved
// unasked, chosen in state. Research's list pane is offered; the Cockpit copy without the agent isn't offered it.
const UPGRADED = `tabs = [
  { name = "Trade", layout = "Agent-first" },
  { name = "Cockpit", layout = "Cockpit" },
  { name = "watch", layout = "My Cockpit" },
  { name = "Trending", layout = "Trending" },
  { name = "Signals", layout = "Signals" },
  { name = "P&L", layout = "P&L" },
  { name = "Research", layout = "Research" },
  { name = "Journal", layout = "Journal" },
  { name = "Perps", layout = "Perps" },
  { name = "Bots", layout = "Bots" },
  { name = "Build", layout = "Build" },
]

[layouts."My Cockpit"]
collapse = 143
root = ["row", ["column", 60, ["row", 62, ["column", 42, "feed 55", "signals 45"], "token 58"], ["row", 38, "positions 42", "activity 48"]], "agent 36"]

[layouts."My Cockpit 2"]
collapse = 143
root = ["column", ["row", 14, ["column", 42, "feed 55", "signals 45"], "token 58"], ["row", 3, "positions 61", "activity 84"], "pnl 16"]
${OLD_RESEARCH.slice(OLD_RESEARCH.indexOf("[layouts."))}`

test("upgraded with tabs on layouts chosen in state: Research is offered its list pane, and a copy with the agent taken out isn't offered it back", async () => {
  const store = memoryStore(UPGRADED, { Cockpit: "My Cockpit", watch: "My Cockpit 2", Research: "My Research" })
  drawn = await drawScene("followed", 160, 40, "research", store)
  expect(frame().split("\n")[1]).toContain("Research has a new pane: lists")
  drawn.setup.renderer.destroy()
  // The third tab, watch, on the Cockpit's copy with the agent taken out.
  drawn = await drawScene("followed", 160, 40, "trade", store)
  for (const a of ["up", "right", "right", "down"] as const) await arrow(a)
  expect(frame().split("\n")[1]).toContain("3 watch")
  expect(frame().split("\n")[1]).not.toContain("new pane")
})
