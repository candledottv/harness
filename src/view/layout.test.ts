// Layouts as trees, and Agent-first on one. The numbers are the hard-coded layout's, unchanged.
import { describe, expect, test } from "bun:test"
import { AGENT_FIRST, beside, COCKPIT, fixedRows, GAP, JOURNAL, type Layout, type Need, paneNav, panesOf, PERPS, place, PNL, type Rect, RESEARCH, shownOf, SIGNALS, split, stackedWith, TRENDING } from "./layout"
import { PANES } from "./panes/registry"
import { layoutOf } from "./layouts-file"
import { MIN_COLS } from "./too-small"

const SIDE = ["token", "positions", "wallets", "activity"] as const
const area = (w: number, top: number, h: number): Rect => ({ x: 0, y: top, w, h })
const rectOf = (l: ReturnType<typeof place>, id: string) => l.panes.find((p) => p.id === id)!.rect
const heights = (w: number, h: number, need: Need = {}) => SIDE.map((id) => rectOf(place(AGENT_FIRST, area(w, 2, h), need), id).h)
const needOf = (n: readonly (number | undefined)[]): Need => Object.fromEntries(SIDE.flatMap((id, i) => (n[i] === undefined ? [] : [[id, n[i]]])))

test("split: floors, then what's left to the largest remainders, or all of it to one", () => {
  // 60/40 rounds as the agent's share always did: 102 × 0.6 = 61.2.
  expect(split(102, [60, 40])).toEqual([61, 41])
  expect(split(101, [60, 40])).toEqual([61, 40])
  expect(split(46, [4, 3, 2, 3], 0)).toEqual([17, 11, 7, 11])
  expect(split(10, [0, 0])).toEqual([0, 0])
})

test("wide: the agent takes 60%, and the right column stacks token, positions, wallets and activity", () => {
  const l = place(AGENT_FIRST, area(200, 2, 46))
  expect(l.switched).toBeUndefined()
  expect(rectOf(l, "agent")).toEqual({ x: 0, y: 2, w: 120, h: 46 })
  expect(l.panes.map((p) => p.id)).toEqual(["agent", ...SIDE])
  const side = l.panes.slice(1)
  expect(side.every((p) => p.rect.x === 120 && p.rect.w === 80)).toBe(true)
  // The token pane gets the most room, for its chart; the column fills the body exactly.
  expect(side[0]!.rect.h).toBeGreaterThan(side[1]!.rect.h)
  expect(side.reduce((h, p) => h + p.rect.h, 0)).toBe(46)
  expect(side.at(-1)!.rect.y + side.at(-1)!.rect.h).toBe(48)
})

test("below 100 columns the right column is one pane, switched in place", () => {
  const l = place(AGENT_FIRST, area(80, 2, 20))
  expect(l.panes).toEqual([{ id: "agent", rect: { x: 0, y: 2, w: 48, h: 20 } }])
  expect(l.switched).toEqual({ rect: { x: 48, y: 2, w: 32, h: 20 }, group: [...SIDE] })
  expect(place(AGENT_FIRST, area(99, 2, 20)).switched).toBeDefined()
  expect(place(AGENT_FIRST, area(100, 2, 20)).switched).toBeUndefined()
})

test("a pane whose lines don't fit takes rows another has spare, never the token pane's, never below 2", () => {
  // A 27-row column: 11, 6, 4 and 6 by weight, so the Wallets pane has 2 rows inside for 5 lines.
  expect(heights(120, 27)).toEqual([11, 6, 4, 6])
  // Positions (2 lines) lends two rows and Activity (1) one, each keeping 2: Wallets fits its 5, the token pane lends none.
  const l = place(AGENT_FIRST, area(120, 2, 27), needOf([undefined, 2, 5, 1]))
  expect(SIDE.map((id) => rectOf(l, id).h)).toEqual([11, 4, 7, 5])
  expect(SIDE.map((id) => rectOf(l, id).y)).toEqual([2, 13, 17, 24])
  // Nothing spare, and a chart in the token pane: Wallets takes from Activity (to 2) and Positions (to 3);
  // what's still cut says so (fitSide).
  expect(heights(120, 27, needOf([undefined, 9, 9, 9]))).toEqual([11, 5, 7, 4])
})

test("every pane short, with a trending list: Wallets, then Positions, take rows from the trending list first", () => {
  // At 120×30 with Candle's real trending list (a 26-row column): 10, 6, 4 and 6. Trending 13 lines, Positions 11, Wallets 4, Activity 20.
  expect(heights(120, 26)).toEqual([10, 6, 4, 6])
  // Both wallets (4 lines) fit; Positions gets the trending list's last spare row; the list keeps its heading and three tokens.
  expect(heights(120, 26, needOf([13, 11, 4, 20]))).toEqual([7, 7, 6, 6])
  // A followed token's chart gives nothing: Wallets takes from Activity instead.
  expect(heights(120, 26, needOf([undefined, 11, 4, 20]))).toEqual([10, 6, 6, 4])
})

test("a tree of rows and columns: weights across, then down, nested", () => {
  const grid: Layout = {
    name: "grid",
    root: {
      dir: "column",
      weight: 1,
      children: [
        { dir: "row", weight: 2, children: [{ pane: "token", weight: 1 }, { pane: "agent", weight: 1 }] },
        { dir: "row", weight: 1, children: [{ pane: "positions", weight: 1 }, { pane: "activity", weight: 2 }] },
      ],
    },
    collapse: { below: 60, keep: "agent", weights: [1, 1] },
  }
  const l = place(grid, area(90, 0, 30))
  expect(l.panes).toEqual([
    { id: "token", rect: { x: 0, y: 0, w: 45, h: 20 } },
    { id: "agent", rect: { x: 45, y: 0, w: 45, h: 20 } },
    { id: "positions", rect: { x: 0, y: 20, w: 30, h: 10 } },
    { id: "activity", rect: { x: 30, y: 20, w: 60, h: 10 } },
  ])
  // Collapsed, the kept pane goes first and the rest switch beside it, in the tree's order.
  expect(place(grid, area(50, 0, 30)).switched!.group).toEqual(["token", "positions", "activity"])
  // Beside: right of the token pane is the agent; below it, Positions and Activity both touch it, left first.
  const nav = paneNav(l)
  expect(beside(nav, "token", "right")).toEqual(["agent"])
  expect(beside(nav, "token", "down")).toEqual(["positions", "activity"])
  expect(beside(nav, "activity", "up")).toEqual(["token", "agent"])
  expect(beside(nav, "agent", "right")).toEqual([])
})

test("Agent-first's arrows: right of the agent is the whole column, top first; up and down step one pane", () => {
  const nav = paneNav(place(AGENT_FIRST, area(140, 2, 36)))
  expect(nav.order).toEqual(["agent", ...SIDE])
  expect(beside(nav, "agent", "right")).toEqual([...SIDE])
  expect(beside(nav, "wallets", "left")).toEqual(["agent"])
  expect(beside(nav, "activity", "up")).toEqual(["wallets"])
  expect(beside(nav, "token", "up")).toEqual([])
  expect(beside(nav, "positions", "down")).toEqual(["wallets"])
  // Collapsed, the column's panes share the switched rect: one stop, whichever shows.
  const narrow = paneNav(place(AGENT_FIRST, area(80, 2, 18)))
  expect(narrow.group).toEqual([...SIDE])
  expect(beside(narrow, "agent", "right")).toEqual([...SIDE])
  expect(beside(narrow, "wallets", "up")).toEqual([])
  expect(shownOf(narrow.group, [])).toBe("token")
  expect(shownOf(narrow.group, ["agent", "wallets", "token"])).toBe("wallets")
})

test("every pane Agent-first draws is at least its narrowest, from the too-small screen's width up", () => {
  for (const cols of [MIN_COLS, 80, 99, 100, 101, 140, 240]) {
    const l = place(AGENT_FIRST, area(cols, 2, 30))
    for (const { id, rect } of l.panes) expect(rect.w).toBeGreaterThanOrEqual(PANES[id].minWidth)
    for (const id of l.switched?.group ?? []) expect(l.switched!.rect.w).toBeGreaterThanOrEqual(PANES[id].minWidth)
  }
})

// The Cockpit: Feed over Signals, the token beside them, Positions and
// Activity under both, and the agent down the right at its full height.
test("the Cockpit at 160 columns: the agent at full height on the right, the bottom row under the rest", () => {
  const l = place(COCKPIT, area(160, 2, 41))
  expect(l.switched).toBeUndefined()
  expect(l.panes.map((p) => p.id)).toEqual(["feed", "signals", "token", "positions", "activity", "agent"])
  const r = (id: string) => rectOf(l, id)
  expect(r("agent")).toEqual({ x: 99, y: 2, w: 61, h: 41 })
  // Feed and Signals share a column left of the token; the bottom row spans both and stops at the agent.
  expect(r("feed").x).toBe(0)
  expect(r("signals")).toMatchObject({ x: 0, w: r("feed").w, y: r("feed").y + r("feed").h })
  expect(r("token")).toMatchObject({ x: r("feed").w, y: 2, h: r("feed").h + r("signals").h })
  expect(r("positions")).toMatchObject({ x: 0, y: r("token").y + r("token").h })
  expect(r("activity").x + r("activity").w).toBe(99)
  expect(r("activity").y + r("activity").h).toBe(43)
})

test("a row's split within 2 cells of one in a row above it, in the same column, lines up with it", () => {
  // A layout of yours saved before drags snapped: Feed and Signals | token at 42:58, Positions | Activity at 61:84.
  const mine = layoutOf("My Cockpit 2", {
    dir: "column",
    weight: 1,
    children: [
      { dir: "row", weight: 62, children: [{ dir: "column", weight: 42, children: [{ pane: "feed", weight: 55 }, { pane: "signals", weight: 45 }] }, { pane: "token", weight: 58 }] },
      { dir: "row", weight: 38, children: [{ pane: "positions", weight: 61 }, { pane: "activity", weight: 84 }] },
      { pane: "pnl", weight: 50 },
    ],
  }, 143)
  // Rounded apart, they missed by a cell at 145, 152, 164, 171 … columns.
  for (let cols = 143; cols <= 260; cols++) {
    const l = place(mine, area(cols, 2, 41), {}, { gap: GAP })
    expect(rectOf(l, "activity").x).toBe(rectOf(l, "token").x)
    expect(rectOf(l, "positions").w).toBe(rectOf(l, "feed").w)
  }
  // Splits further apart are left as drawn.
  const apart = layoutOf("apart", {
    dir: "column",
    weight: 1,
    children: [
      { dir: "row", weight: 1, children: [{ pane: "feed", weight: 30 }, { pane: "token", weight: 70 }] },
      { dir: "row", weight: 1, children: [{ pane: "positions", weight: 50 }, { pane: "activity", weight: 50 }] },
    ],
  }, 100)
  const a = place(apart, area(160, 2, 41), {}, { gap: GAP })
  expect(rectOf(a, "activity").x).not.toBe(rectOf(a, "token").x)
})

test("the Cockpit's left column: Signals takes the rows Feed's list leaves, and never Feed's own", () => {
  const at = (need: Need) => {
    const l = place(COCKPIT, area(160, 2, 41), need)
    return [rectOf(l, "feed").h, rectOf(l, "signals").h]
  }
  const even = at({})
  // A short list lends its spare rows to a busy tape.
  const short = at({ feed: 4, signals: 100 })
  expect(short[0]).toBe(6)
  expect(short[0]! + short[1]!).toBe(even[0]! + even[1]!)
  // A long list keeps its share however busy the tape is.
  expect(at({ feed: 20, signals: 100 })).toEqual(even)
})

test("below 130 columns the Cockpit is the agent and one switched pane, in its order", () => {
  const l = place(COCKPIT, area(129, 2, 26))
  expect(l.panes.map((p) => p.id)).toEqual(["agent"])
  expect(l.switched?.group).toEqual(["feed", "signals", "token", "positions", "activity"])
  expect(place(COCKPIT, area(130, 2, 26)).switched).toBeUndefined()
  expect(panesOf(COCKPIT.root)).not.toContain("wallets")
})

test("the Cockpit's arrows: left of the agent is the token, then Feed; down from Feed is Signals; up from Activity the token", () => {
  const nav = paneNav(place(COCKPIT, area(160, 2, 41)))
  expect(beside(nav, "agent", "left")).toEqual(["token", "activity"])
  expect(beside(nav, "token", "left")).toEqual(["feed", "signals"])
  expect(beside(nav, "feed", "down")).toEqual(["signals"])
  expect(beside(nav, "activity", "up")).toEqual(["token"])
  // Positions sits under Feed and Signals exactly, now the rows share weights (the borders didn't line up).
  expect(beside(nav, "positions", "up")).toEqual(["signals"])
})

test("every pane the Cockpit draws is at least its narrowest, from the too-small screen's width up", () => {
  for (const cols of [MIN_COLS, 80, 129, 130, 131, 160, 240]) {
    const l = place(COCKPIT, area(cols, 2, 30))
    for (const { id, rect } of l.panes) expect(rect.w).toBeGreaterThanOrEqual(PANES[id].minWidth)
    for (const id of l.switched?.group ?? []) expect(l.switched!.rect.w).toBeGreaterThanOrEqual(PANES[id].minWidth)
  }
})

describe("the short agent pane across the foot", () => {
  const SHORT = [SIGNALS, TRENDING, PNL, JOURNAL, PERPS]
  test("full width at its fixed rows, 8 where the body is 26 rows or more and 6 below, and the input lines under it", () => {
    for (const layout of SHORT) {
      // 140×40: the body under the status and tab bars, and a blank row.
      const tall = place(layout, area(140, 3, 37), {}, { foot: 2, gap: GAP })
      expect(rectOf(tall, "agent")).toEqual({ x: 0, y: 3 + 37 - 2 - 8, w: 140, h: 8 })
      expect(tall.foot).toEqual({ x: 0, y: 38, w: 140, h: 2 })
      // 80×24: no blank row; the body is 22 rows.
      const low = place(layout, area(80, 2, 22), {}, { foot: 2 })
      expect(rectOf(low, "agent")).toMatchObject({ x: 0, w: 80, h: 6 })
      expect(rectOf(low, "agent").y + 6).toBe(22)
    }
    expect(fixedRows(8, 26)).toBe(8)
    expect(fixedRows(8, 25)).toBe(6)
  })

  test("nothing above it moves while a message line wraps a row more, or a reply streams: only the foot's rows change it", () => {
    const at = (foot: number) => place(SIGNALS, area(140, 3, 37), {}, { foot, gap: GAP })
    expect(rectOf(at(2), "agent").h).toBe(8)
    expect(rectOf(at(3), "agent").h).toBe(8)
    // Need from a streaming reply's lines can't reach the agent: it fills what it's given.
    expect(rectOf(place(SIGNALS, area(140, 3, 37), { signals: 400 }, { foot: 2, gap: GAP }), "agent")).toEqual(rectOf(at(2), "agent"))
  })

  test("collapsed, the other panes switch above it, and the switched pane keeps at least five rows", () => {
    const l = place(SIGNALS, area(80, 2, 22), {}, { foot: 2 })
    expect(l.switched).toEqual({ rect: { x: 0, y: 2, w: 80, h: 14 }, group: ["signals", "token"], first: "signals" })
    expect(rectOf(l, "agent")).toEqual({ x: 0, y: 16, w: 80, h: 6 })
    const squeezed = place({ ...SIGNALS, root: { ...SIGNALS.root, children: [{ pane: "signals", weight: 1 }, { pane: "agent", weight: 1, rows: 30 }] } as typeof SIGNALS.root }, area(80, 2, 22), {}, { foot: 2 })
    expect(squeezed.switched!.rect.h).toBe(5)
  })

  test("a column's fixed pane takes its rows first; the others share what's left by weight", () => {
    const l = place(JOURNAL, area(160, 3, 40))
    expect(rectOf(l, "agent").h).toBe(8)
    expect(rectOf(l, "journal").h + rectOf(l, "token").h).toBe(32)
    expect(rectOf(l, "journal").h).toBeGreaterThan(rectOf(l, "token").h)
  })

  test("Trending collapsed: one list at a time over the token, the short agent pane kept; short of rows, the token switches too", () => {
    expect(TRENDING.collapse.below).toBe(130)
    const l = place(TRENDING, area(120, 3, 27), {}, { foot: 2, gap: GAP })
    expect(l.switched?.group).toEqual(["new", "graduated", "feed", "final-stretch"])
    expect(l.panes.map((p) => p.id)).toEqual(["token", "agent"])
    const token = rectOf(l, "token")
    expect(token.y).toBe(l.switched!.rect.y + l.switched!.rect.h + 1)
    expect(token.h).toBeGreaterThanOrEqual(5)
    expect(l.switched!.rect.h).toBeGreaterThanOrEqual(5)
    expect(rectOf(l, "agent").h).toBe(8)
    // 80×24: still both, five rows or more each.
    const low = place(TRENDING, area(80, 2, 22), {}, { foot: 2 })
    expect(low.panes.map((p) => p.id)).toEqual(["token", "agent"])
    expect(low.switched!.rect.h).toBeGreaterThanOrEqual(5)
    expect(rectOf(low, "token").h).toBeGreaterThanOrEqual(5)
    // Too few rows for both: the token joins the switched lists.
    const tiny = place(TRENDING, area(80, 2, 16), {}, { foot: 2 })
    expect(tiny.panes.map((p) => p.id)).toEqual(["agent"])
    expect(tiny.switched!.group).toContain("token")
  })

  test("the token stays shown only where there are panes enough to switch: Trending and a copy of it, not Signals or the Journal", () => {
    expect(stackedWith(TRENDING.root, "agent")).toBe("token")
    expect(stackedWith(SIGNALS.root, "agent")).toBeUndefined()
    expect(stackedWith(JOURNAL.root, "agent")).toBeUndefined()
    expect(stackedWith(PNL.root, "agent")).toBeUndefined()
    // A copy made from the tree (an edit, or layouts.toml) keeps it, at Trending's own 130.
    const copy = layoutOf("My Trending", TRENDING.root, 130)
    expect(copy.collapse).toMatchObject({ below: 130, keep: "agent", stack: true, with: "token", weights: [55, 45] })
    expect(layoutOf("My Signals", SIGNALS.root).collapse.with).toBeUndefined()
  })

  test("every pane each new preset draws is at least its narrowest, from where it stops collapsing", () => {
    for (const layout of [TRENDING, SIGNALS, PNL, RESEARCH, JOURNAL]) {
      for (let w = Math.max(MIN_COLS, layout.collapse.below); w <= 220; w++) {
        for (const p of place(layout, area(w, 3, 37), {}, { gap: GAP }).panes) expect({ layout: layout.name, w, id: p.id, ok: p.rect.w >= PANES[p.id].minWidth }).toMatchObject({ ok: true })
      }
    }
  })
})
