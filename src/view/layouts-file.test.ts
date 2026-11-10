// layouts.toml: read with every problem named by its line, written whole,
// and read back as written. A bad file never stops the Candle Harness: the presets stand in.
import { describe, expect, test } from "bun:test"
import { AGENT_FIRST, COCKPIT, panesOf } from "./layout"
import { allTabs, DEFAULT_TABS, EMPTY_FILE, HEADER, layoutNamed, layoutOf, layoutsText, neededWidth, parseLayouts, treeOf } from "./layouts-file"
import { isTokenPane, openable } from "../shared/panes"

const DESK = `tabs = [
  { name = "Trade", layout = "Agent-first" },
  { name = "Desk", layout = "My desk" },
]

[layouts."My desk"]
collapse = 140
root = ["row",
  ["column", 62, "feed 40", "token 60"],
  "agent 38"]
`

describe("reading", () => {
  test("no file, or an empty one: five tabs shown, each on its preset, and the other five a tick away", () => {
    const f = parseLayouts("")
    expect(f).toEqual(EMPTY_FILE)
    expect(f.tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Research", "Bots", "Build"])
    expect(allTabs(f).map((t) => `${t.shown ? "+" : "-"}${t.tab.name}`)).toEqual(["+Trade", "+Cockpit", "-Trending", "-Signals", "-P&L", "+Research", "-Journal", "-Perps", "+Bots", "+Build"])
    expect(DEFAULT_TABS).toEqual([
      { name: "Trade", layout: "Agent-first" },
      { name: "Cockpit", layout: "Cockpit" },
      { name: "Trending", layout: "Trending" },
      { name: "Signals", layout: "Signals" },
      { name: "P&L", layout: "P&L" },
      { name: "Research", layout: "Research" },
      { name: "Journal", layout: "Journal" },
      { name: "Perps", layout: "Perps" },
      { name: "Bots", layout: "Bots" },
      { name: "Build", layout: "Build" },
    ])
    // Written, a fresh install's file reads back as it was, nothing added.
    const again = parseLayouts(layoutsText(f))
    expect(again.added).toEqual([])
    expect(allTabs(again)).toEqual(allTabs(f))
  })

  test("tabs and a layout of your own, as a tree of rows, columns and weighted panes", () => {
    const f = parseLayouts(DESK)
    expect(f.problems).toEqual([])
    expect(f.tabs).toEqual([
      { name: "Trade", layout: "Agent-first" },
      { name: "Desk", layout: "My desk" },
    ])
    const desk = layoutNamed(f, "My desk")!
    expect(desk.root).toEqual({
      dir: "row",
      weight: 1,
      children: [
        { dir: "column", weight: 62, children: [{ pane: "feed", weight: 40 }, { pane: "token", weight: 60 }] },
        { pane: "agent", weight: 38 },
      ],
    })
    expect(desk.collapse).toEqual({ below: 140, keep: "agent", weights: [60, 40] })
    // The presets are always there, unchanged.
    expect(layoutNamed(f, "Cockpit")).toBe(COCKPIT)
  })

  test("a layout without the agent collapses around its first pane; a weight left out is 1", () => {
    const f = parseLayouts(`[layouts.Watch]\nroot = ["column", "feed", "signals 2"]\n`)
    expect(f.problems).toEqual([])
    expect(layoutNamed(f, "Watch")!.collapse.keep).toBe("feed")
    expect(panesOf(layoutNamed(f, "Watch")!.root)).toEqual(["feed", "signals"])
  })

  test("a file that isn't TOML: named with its line, and the presets used", () => {
    const f = parseLayouts(`tabs = [\n  { name = "Trade", layout = Agent-first },\n]\n`)
    expect(f.tabs).toEqual(EMPTY_FILE.tabs)
    expect(f.hidden).toEqual(EMPTY_FILE.hidden)
    expect(f.own).toEqual([])
    expect(f.problems).toHaveLength(1)
    expect(f.problems[0]).toMatch(/^layouts\.toml line 2 isn't valid TOML .*: the presets are used\.$/)
  })

  test("a layout that doesn't hold together is named by its line and left out; the rest still reads", () => {
    const f = parseLayouts(`[layouts.Good]
root = ["row", "agent 60", "token 40"]

[layouts.Typo]
root = ["row",
  "agent 60",
  "fed 40"]

[layouts.Twice]
root = ["row", "agent", ["column", 50, "token", "agent"]]

[layouts.Cockpit]
root = ["row", "agent"]

[layouts.Bare]
root = ["row", ["column", "token"]]
`)
    expect(f.own.map((l) => l.name)).toEqual(["Good"])
    expect(f.problems).toEqual([
      `layouts.toml line 7: layout "Typo": there's no pane called "fed"; the nearest is "feed". It's left out.`,
      `layouts.toml line 10: layout "Twice": "agent" is in it twice. It's left out.`,
      `layouts.toml line 12: "Cockpit" is a preset's name, and a preset can't be changed: name yours another way, such as "My Cockpit"`,
      `layouts.toml line 16: layout "Bare": a column inside another needs its weight after "column", such as ["column", 40, …]. It's left out.`,
    ])
  })

  test("a layout narrower than its panes allow collapses where they fit, and says so", () => {
    const f = parseLayouts(`[layouts.Wide]\ncollapse = 80\nroot = ["row", "agent", "token", "positions", "activity", "feed"]\n`)
    const wide = layoutNamed(f, "Wide")!
    // Five equal panes, each at least 24 and the agent 36, with a column between each and the rounding: 180.
    expect(wide.collapse.below).toBe(180)
    expect(f.problems).toEqual([`layouts.toml line 2: layout "Wide": its panes need 180 columns, so it collapses below that, not 80`])
  })

  test("tabs: an unknown layout shows Agent-first and a repeated name is left out, each named; there's no cap", () => {
    const tabs = Array.from({ length: 10 }, (_, i) => `  { name = "T${i}", layout = "Cockpit" },`).join("\n")
    const f = parseLayouts(`tabs = [\n  { name = "Mine", layout = "Nope" },\n  { name = "Mine", layout = "Cockpit" },\n${tabs}\n]\n`)
    expect(f.tabs[0]).toEqual({ name: "Mine", layout: "Agent-first" })
    expect(f.tabs).toHaveLength(11)
    expect(f.problems).toEqual([
      `layouts.toml line 2: tab "Mine" names a layout there isn't, "Nope": it shows Agent-first`,
      `layouts.toml line 2: two tabs are called "Mine": the second is left out`,
    ])
  })

  test("tabs are a setting: one ticked off is kept with shown = false, and a file that lists tabs has the defaults it doesn't name unticked", () => {
    const f = parseLayouts(`tabs = [\n  { name = "Trade", layout = "Agent-first" },\n  { name = "Tape", layout = "Cockpit", shown = false },\n  { name = "Watch", layout = "Signals" },\n]\n`)
    expect(f.problems).toEqual([])
    expect(f.tabs.map((t) => t.name)).toEqual(["Trade", "Watch"])
    // Tape keeps its place, after Trade. Cockpit's layout is Tape's, and Signals' is Watch's, so neither is added.
    expect(f.hidden).toEqual([
      { tab: { name: "Tape", layout: "Cockpit" }, at: 1 },
      ...["Trending", "P&L", "Research", "Journal", "Perps", "Bots", "Build"].map((name) => ({ tab: DEFAULT_TABS.find((d) => d.name === name)!, at: 2 })),
    ])
    expect(f.added).toEqual(["Trending", "P&L", "Research", "Journal", "Perps", "Bots", "Build"])
    expect(allTabs(f).map((t) => `${t.shown ? "+" : "-"}${t.tab.name}`)).toEqual(["+Trade", "-Tape", "+Watch", "-Trending", "-P&L", "-Research", "-Journal", "-Perps", "-Bots", "-Build"])
    // Written, every tab is listed, the ticked off with shown = false, so nothing is added the next time.
    const text = layoutsText(f)
    expect(text).toContain(`{ name = "Tape", layout = "Cockpit", shown = false },\n  { name = "Watch", layout = "Signals" },\n  { name = "Trending", layout = "Trending", shown = false },`)
    const again = parseLayouts(text)
    expect(again.added).toEqual([])
    expect(allTabs(again)).toEqual(allTabs(f))
  })

  test("one tab always shows; shown takes true or false", () => {
    const f = parseLayouts(`tabs = [\n  { name = "Trade", layout = "Agent-first", shown = false },\n  { name = "Tape", layout = "Cockpit", shown = "no" },\n]\n`)
    expect(f.tabs.map((t) => t.name)).toEqual(["Tape"])
    expect(f.problems).toEqual([`layouts.toml line 3: tab "Tape": shown is true or false, not "no": it's shown`])
    const none = parseLayouts(`tabs = [{ name = "Trade", layout = "Agent-first", shown = false }]\n`)
    expect(none.tabs.map((t) => t.name)).toEqual(["Trade"])
    expect(none.problems).toEqual(["layouts.toml line 1: every tab is ticked off (shown = false): the first is shown, since one always is"])
  })

  test("a pane at fixed rows in a column, as the short agent pane is; it collapses stacked", () => {
    const f = parseLayouts(`[layouts.Low]\nroot = ["column", "signals 2", "agent 8 rows"]\n\n[layouts.Bad]\nroot = ["row", "signals", "agent 8 rows"]\n\n[layouts.Tiny]\nroot = ["column", "signals", "agent 2 rows"]\n`)
    const low = layoutNamed(f, "Low")!
    expect(low.root).toEqual({ dir: "column", weight: 1, children: [{ pane: "signals", weight: 2 }, { pane: "agent", weight: 1, rows: 8 }] })
    expect(low.collapse).toMatchObject({ keep: "agent", stack: true })
    expect(f.problems).toEqual([
      `layouts.toml line 5: layout "Bad": "agent 8 rows": a pane has fixed rows only in a column. It's left out.`,
      `layouts.toml line 8: layout "Tiny": "agent 2 rows": fixed rows are a whole number from 3 to 60. It's left out.`,
    ])
    expect(layoutsText({ tabs: [], own: [low] })).toContain(`root = ["column", "signals 2", "agent 8 rows"]`)
  })
})

describe("writing", () => {
  test("the file says first that the Candle Harness writes it whole; what it writes reads back the same", () => {
    const f = parseLayouts(DESK)
    const text = layoutsText(f)
    expect(text.startsWith(HEADER)).toBe(true)
    expect(text.split("\n")[0]).toContain("The Candle Harness writes this file whole")
    // The default tabs the file didn't name are written, ticked off, so they're no longer new.
    expect(parseLayouts(text)).toEqual({ ...f, added: [] })
  })

  test("a deep tree, copied from a preset, reads back as the preset's tree", () => {
    const mine = layoutOf("My Cockpit", COCKPIT.root, COCKPIT.collapse.below)
    const text = layoutsText({ tabs: [{ name: "Cockpit", layout: "My Cockpit" }], own: [mine] })
    expect(text).toContain(`root = ["row",\n  ["column", 62,\n    ["row", 62,\n      ["column", 42, "feed 55", "signals 45"],\n      "token 58"],\n    ["row", 38, "positions 42", "activity 58"]],\n  "agent 38"]`)
    const back = parseLayouts(text)
    expect(back.problems).toEqual([])
    expect(layoutNamed(back, "My Cockpit")).toEqual(mine)
    expect(mine.collapse).toEqual(COCKPIT.collapse)
  })

  test("the presets need no more than they collapse at", () => {
    expect(neededWidth(AGENT_FIRST.root)).toBeLessThanOrEqual(AGENT_FIRST.collapse.below)
    expect(neededWidth(COCKPIT.root)).toBeLessThanOrEqual(COCKPIT.collapse.below)
  })
})

test("a layout holds up to three token panes, by token, token:2 and token:3; the menu offers only the next", () => {
  const two = treeOf(["row", "agent 40", "token 30", "token:2 30"], true, new Set())
  expect(typeof two === "string" ? two : panesOf(two)).toEqual(["agent", "token", "token:2"])
  expect(treeOf(["row", "token", "token:4"], true, new Set())).toContain("there's no pane called")
  expect(treeOf(["row", "token:2", "token:2"], true, new Set())).toBe('"token:2" is in it twice')
  expect(openable(["agent"]).filter(isTokenPane)).toEqual(["token"])
  expect(openable(["agent", "token"]).filter(isTokenPane)).toEqual(["token:2"])
  expect(openable(["agent", "token", "token:2"]).filter(isTokenPane)).toEqual(["token:3"])
  expect(openable(["token", "token:2", "token:3"]).filter(isTokenPane)).toEqual([])
})
