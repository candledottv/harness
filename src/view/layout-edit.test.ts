// Edits to a layout in the Candle Harness: each a pure change to the tree, refused in words when it
// can't be made.
import { describe, expect, test } from "bun:test"
import { AGENT_FIRST, COCKPIT, type Layout, leafOf, panesOf, place, type Rect, SIGNALS } from "./layout"
import { closed, freeName, moved, nameProblem, opened, resized, tabAdded, tabShownIn } from "./layout-edit"
import { layoutOf, parseLayouts } from "./layouts-file"

const AREA: Rect = { x: 0, y: 2, w: 160, h: 40 }
const ok = (r: Layout | { refused: string }): Layout => {
  if ("refused" in r) throw new Error(r.refused)
  return r
}
const mine = (l: Layout) => layoutOf(`My ${l.name}`, l.root, l.collapse.below)
const rectOf = (l: Layout, id: string, area = AREA) => place(l, area).panes.find((p) => p.id === id)!.rect

describe("open and close", () => {
  test("a pane opens after the focused one, in its column, at its neighbours' mean weight", () => {
    const l = ok(opened(mine(AGENT_FIRST), "feed", "positions"))
    expect(panesOf(l.root)).toEqual(["agent", "token", "positions", "feed", "wallets", "activity"])
    expect(l.name).toBe("My Agent-first")
  })

  test("with no pane focused it opens at the end of the root; a pane already there is refused", () => {
    expect(panesOf(ok(opened(mine(AGENT_FIRST), "signals")).root).at(-1)).toBe("signals")
    expect(opened(mine(AGENT_FIRST), "token")).toEqual({ refused: "token is already on this layout." })
  })

  test("closing a pane gives its room to the rest; a column left with one pane becomes that pane", () => {
    const l = ok(closed(mine(COCKPIT), "signals"))
    expect(panesOf(l.root)).toEqual(["feed", "token", "positions", "activity", "agent"])
    // Feed's column held Feed and Signals: now it's Feed alone, at the column's weight.
    expect(rectOf(l, "feed").h).toBe(rectOf(l, "token").h)
  })

  test("the agent can be closed; the last pane can't", () => {
    const noAgent = ok(closed(mine(AGENT_FIRST), "agent"))
    expect(noAgent.collapse.keep).toBe("token")
    let l = layoutOf("One", { dir: "row", weight: 1, children: [{ pane: "token", weight: 1 }] })
    expect(closed(l, "token")).toEqual({ refused: "A layout keeps at least one pane." })
    l = ok(closed(layoutOf("Two", { dir: "row", weight: 1, children: [{ pane: "token", weight: 1 }, { pane: "feed", weight: 1 }] }), "feed"))
    expect(l.root).toEqual({ dir: "row", weight: 1, children: [{ pane: "token", weight: 1 }] })
  })
})

describe("move", () => {
  test("a pane swaps places with the pane beside it, each taking the other's size", () => {
    const before = mine(AGENT_FIRST)
    const l = ok(moved(before, "token", "left", AREA))
    expect(rectOf(l, "token")).toEqual(rectOf(before, "agent"))
    // The agent takes the token's place in the column; the column's spare rows still go to its token pane, wherever that is.
    expect(rectOf(l, "agent")).toMatchObject({ x: rectOf(before, "token").x, y: rectOf(before, "token").y, w: rectOf(before, "token").w })
    expect(moved(before, "activity", "down", AREA)).toEqual({ refused: "Nothing is below activity." })
  })
})

describe("resize", () => {
  test("wider takes columns from the pane beside it, and the weights keep the shape at other sizes", () => {
    const before = mine(AGENT_FIRST)
    const l = ok(resized(before, "agent", "row", 16, AREA))
    expect(rectOf(l, "agent").w).toBe(rectOf(before, "agent").w + 16)
    expect(rectOf(l, "agent", { ...AREA, w: 200 }).w).toBe(140)
  })

  test("taller and shorter move the border within the pane's column; a pane in the column's last place moves the border before it", () => {
    const before = mine(AGENT_FIRST)
    const taller = ok(resized(before, "positions", "column", 2, AREA))
    expect(rectOf(taller, "positions").h).toBe(rectOf(before, "positions").h + 2)
    expect(rectOf(taller, "wallets").h).toBe(rectOf(before, "wallets").h - 2)
    // Wallets keeps its border and a line: asked for 9 more, Positions gets what Wallets can give.
    expect(rectOf(ok(resized(before, "positions", "column", 9, AREA)), "wallets").h).toBe(3)
    const last = ok(resized(before, "activity", "column", 2, AREA))
    expect(rectOf(last, "activity").h).toBe(rectOf(before, "activity").h + 2)
    expect(rectOf(last, "wallets").h).toBe(rectOf(before, "wallets").h - 2)
  })

  test("a pane in a column inside a row grows by the row's border: the column beside it gives", () => {
    const before = mine(COCKPIT)
    const l = ok(resized(before, "signals", "row", 6, AREA))
    expect(rectOf(l, "signals").w).toBe(rectOf(before, "signals").w + 6)
    expect(rectOf(l, "feed").w).toBe(rectOf(l, "signals").w)
    expect(rectOf(l, "token").w).toBe(rectOf(before, "token").w - 6)
  })

  test("never below what a pane needs, and said so when nothing can move", () => {
    const before = mine(AGENT_FIRST)
    const l = ok(resized(before, "agent", "row", 500, AREA))
    expect(rectOf(l, "token").w).toBe(24)
    expect(resized(l, "agent", "row", 4, AREA)).toEqual({ refused: "agent can't be made wider: the pane beside it is as small as its lines allow." })
    const one = layoutOf("One", { dir: "row", weight: 1, children: [{ pane: "agent", weight: 1 }] })
    expect(resized(one, "agent", "column", 2, AREA)).toEqual({ refused: "agent has nothing beside it to make it taller." })
  })
})

describe("names", () => {
  test("a copy's name is free; a name of yours can't be a preset's", () => {
    expect(freeName("My Cockpit", [])).toBe("My Cockpit")
    expect(freeName("My Cockpit", ["My Cockpit", "My Cockpit 2"])).toBe("My Cockpit 3")
    expect(nameProblem("Cockpit")).toBe("Cockpit is a preset's name: presets can't be changed.")
    expect(nameProblem("  ")).toBe("Type a name for the layout.")
    expect(nameProblem('say "hi"')).toBe("A layout's name can't hold quotes or backslashes.")
    expect(nameProblem("Desk")).toBeUndefined()
    for (const hidden of ["Mine\u007f", JSON.parse('"Mine\\ud800"') as string, "Mine\u200b"]) expect(nameProblem(hidden)).toBe("A layout's name is plain text, without quotes or backslashes.")
  })
})

describe("the tab set", () => {
  test("the short agent pane, made taller or dragged, keeps fixed rows: its new height", () => {
    const body: Rect = { x: 0, y: 3, w: 140, h: 37 }
    const taller = resized(SIGNALS, "agent", "column", 2, body, "before")
    if ("refused" in taller) throw new Error(taller.refused)
    expect(leafOf(taller.root, "agent")).toEqual({ pane: "agent", weight: 1, rows: 10 })
    expect(taller.collapse).toMatchObject({ keep: "agent", stack: true })
  })

  test("a tab ticked off keeps its place, comes back there, and one tab always shows", () => {
    const f = parseLayouts("")
    const off = tabShownIn(f, "Signals", false)
    if ("refused" in off) throw new Error(off.refused)
    expect(off.tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Trending", "P&L", "Research", "Journal", "Perps"])
    expect(off.hidden).toEqual([{ tab: { name: "Signals", layout: "Signals" }, at: 3 }])
    const back = tabShownIn(off, "Signals", true)
    if ("refused" in back) throw new Error(back.refused)
    expect(back.tabs).toEqual(f.tabs)
    expect(back.hidden).toEqual([])
    expect(tabShownIn(f, "Nope", false)).toEqual({ refused: "There's no tab called Nope." })
    const one = parseLayouts('tabs = [{ name = "Trade", layout = "Agent-first" }]\n')
    expect(tabShownIn(one, "Trade", false)).toEqual({ refused: "Trade is the only tab shown, and one always is: tick another on first." })
    // A new tab can't take the name of one ticked off.
    expect(tabAdded(off, "Signals", "Cockpit")).toEqual({ refused: "There's a tab called Signals already." })
  })

  test("there's no cap on tabs: the first nine shown get digits, the rest a click or the palette", () => {
    let f = parseLayouts("")
    for (const name of ["A", "B", "C"]) {
      const next = tabAdded(f, name, "Cockpit")
      if ("refused" in next) throw new Error(next.refused)
      f = next
    }
    expect(f.tabs).toHaveLength(11)
  })
})
