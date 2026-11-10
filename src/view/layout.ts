// Layouts as trees: a row or column of children with weights, each a pane from the registry
// (panes/registry.ts) or another row or column. A column can share its rows by content, as the Trade tab's
// right column does. Below a layout's narrowest width, one pane keeps its place and the rest show one at a
// time in a switched pane beside it (Agent-first's right column below 100 columns, switched with ←/→).
//
// A pane in a column can be fixed at a number of rows: the short agent pane across the foot of the newer
// tabs is 8 rows from 30 tall and 6 at 24, so nothing above it moves while a reply streams. It keeps its
// rows when the layout collapses too: the other panes switch above it.

import type { PaneId } from "../shared/panes"

export { PANE_IDS, type PaneId } from "../shared/panes"

export type Rect = { x: number; y: number; w: number; h: number }

/** A pane at its weight, or in a column at a fixed number of rows, border included (`rows`; the weight is then unused). */
export type LayoutNode = { pane: PaneId; weight: number; rows?: number } | Split

export interface Split {
  dir: "row" | "column"
  weight: number
  children: readonly LayoutNode[]
}

/**
 * How a column's panes share rows: one rule for every column of every layout, by pane id, so a layout of
 * your own (layouts.toml) needs only its rows, columns, panes and weights. Rows move first from a pane with
 * rows spare beyond its own lines to one whose lines don't fit, in `ask` order (at 120×30 the Wallets pane
 * had cut the TEE wallet while Positions and Activity sat half empty). When none has any spare, each
 * `borrow` pane takes rows from its `from` panes in order, down to their `keep` (with a real trending list
 * every pane was short, and Wallets showed one wallet of two while the trending list kept seven rows). Feed
 * never borrows, so a busy tape doesn't squeeze it, and Activity keeps its rows for Positions. A pane that
 * fills what it's given (a chart) neither lends nor borrows. A column's leftover rows go to its token pane,
 * for the chart.
 */
interface Share {
  ask: readonly PaneId[]
  keep?: Partial<Record<PaneId, number>>
  borrow?: readonly { pane: PaneId; from: readonly PaneId[] }[]
}

// What you hold beats what's trending: Wallets, then Positions, ask first. The trending list keeps its
// heading and three tokens; Positions three holdings.
const SHARE: Share = {
  ask: ["wallets", "positions", "activity", "token", "token:2", "token:3", "check", "traders", "token-signals", "mentions", "pnl", "pnl-positions", "trades", "signals", "journal", "away", "feed", "new", "graduated", "final-stretch", "perps", "bot", "bots"],
  keep: { token: 5, "token:2": 5, "token:3": 5, positions: 3 },
  borrow: [
    { pane: "wallets", from: ["token", "activity", "positions"] },
    { pane: "positions", from: ["token"] },
  ],
}

export interface Layout {
  name: string
  root: LayoutNode
  /**
   * Below `below` columns, `keep` and a switched pane share the width by `weights`; or, `stack`ed, the
   * switched pane sits over `keep` at its fixed rows (the short agent pane). A stacked layout may keep one
   * more pane shown, `with`, under the switched one, the two sharing their rows by `weights` (Trending: one
   * list at a time over the token). `first` is the pane the switched one opens on before any is focused
   * (Signals' own tab opens on Signals); unset, the token pane. `fold`ed, `keep` takes every row but one, and that
   * row is a strip with a chip for each other pane, which opens it over the frame (the Build tab: the harness keeps
   * its width and height, and the bots folder and the test run are a click away).
   */
  collapse: { below: number; keep: PaneId; weights: readonly [number, number]; stack?: true; with?: PaneId; first?: PaneId; fold?: true }
  /** A layout of yours saved from a preset: which, and the panes it had then, so a pane it gains later is offered. */
  from?: LayoutFrom
}

export interface LayoutFrom {
  preset: string
  panes: readonly PaneId[]
}

export interface Placed {
  /** Every pane drawn, in the tree's order. */
  panes: { id: PaneId; rect: Rect }[]
  /** Collapsed: the rect the other panes show in, one at a time, and which they are. */
  switched?: { rect: Rect; group: PaneId[]; first?: PaneId }
  /** Asked for a foot: where the message and input lines go, under the agent pane or across the width. */
  foot?: Rect
  /** Folded: the strip under the kept pane, and the panes its chips open over the frame. */
  folded?: { rect: Rect; group: PaneId[] }
}

/**
 * The air between panes (packed edge to edge, they felt tight): `x` columns between panes side by
 * side and `y` rows between stacked ones. Only where the window has room for it; a short or narrow
 * window keeps every cell for the panes.
 */
export interface Gap {
  x: number
  y: number
}
export const NO_GAP: Gap = { x: 0, y: 0 }
export const GAP: Gap = { x: 1, y: 1 }
/** The window sizes that get the gaps, and a blank row under the tab bar. */
export const roomy = (cols: number, rows: number): boolean => cols >= 100 && rows >= 30
export const gapFor = (cols: number, rows: number): Gap => (roomy(cols, rows) ? GAP : NO_GAP)

export interface PlaceOpts {
  gap?: Gap
  /**
   * Rows for the message and input lines (the input line had sat on the left while the agent was on the
   * right). They go under the agent pane when it reaches the bottom, taken from its rows, and
   * the other panes run to the bottom; otherwise across the whole width, under every pane.
   */
  foot?: number
}

/** Each pane's line count, for the panes that ask for the rows their lines need; absent, a pane fills what it gets. */
export type Need = Partial<Record<PaneId, number>>

/** The fewest rows a pane keeps inside its border when it lends rows to another (two of Activity's newest lines). */
const LEND_FLOOR = 2

/** Below this many rows of body (a window under about 28 tall), a fixed pane has two rows fewer: 8 from 30 tall, 6 at 24. */
export const SHORT_BODY = 26
/** The rows each pane beside a fixed one keeps, at least: a fixed pane gives up its own first (at 80×24 the switched pane keeps five). */
const FLEX_KEEP = 5

/** A fixed pane's rows in a body `bodyH` rows tall. */
export const fixedRows = (rows: number, bodyH: number): number => (bodyH >= SHORT_BODY ? rows : Math.max(3, rows - 2))

/** The rows of the short agent pane across the foot of the newer tabs. */
export const SHORT_AGENT_ROWS = 8

/** The leaf for `pane` in a tree, if it's there. */
export function leafOf(node: LayoutNode, pane: PaneId): Extract<LayoutNode, { pane: PaneId }> | undefined {
  if ("pane" in node) return node.pane === pane ? node : undefined
  for (const c of node.children) {
    const found = leafOf(c, pane)
    if (found) return found
  }
  return undefined
}

/**
 * Agent-first, the default: the agent at 60% of the width beside a column of
 * token, positions, wallets and activity, which follow what the agent is discussing. The token pane gets
 * the most rows and whatever the weights leave over, for its chart.
 */
export const AGENT_FIRST: Layout = {
  name: "Agent-first",
  root: {
    dir: "row",
    weight: 1,
    children: [
      { pane: "agent", weight: 60 },
      {
        dir: "column",
        weight: 40,
        children: [
          { pane: "token", weight: 4 },
          { pane: "positions", weight: 3 },
          { pane: "wallets", weight: 2 },
          { pane: "activity", weight: 3 },
        ],
      },
    ],
  },
  collapse: { below: 100, keep: "agent", weights: [60, 40] },
}

/**
 * The Cockpit: Feed over Signals on the left, the
 * token in the middle, Positions and Activity along the bottom under them, and the agent down the right
 * at its full height, so a conversation and its cards read as in Agent-first. In the left column, Signals
 * takes the rows Feed's list leaves; Feed keeps its share however busy the tape is. Below 130 columns it's
 * the agent and one switched pane: at 120 the agent would get 46 columns and Feed 31.
 */
export const COCKPIT: Layout = {
  name: "Cockpit",
  root: {
    dir: "row",
    weight: 1,
    children: [
      {
        dir: "column",
        weight: 62,
        children: [
          {
            dir: "row",
            weight: 62,
            children: [
              { dir: "column", weight: 42, children: [{ pane: "feed", weight: 55 }, { pane: "signals", weight: 45 }] },
              { pane: "token", weight: 58 },
            ],
          },
          // The same weights as the row above, so the borders line up.
          { dir: "row", weight: 38, children: [{ pane: "positions", weight: 42 }, { pane: "activity", weight: 58 }] },
        ],
      },
      { pane: "agent", weight: 38 },
    ],
  },
  collapse: { below: 130, keep: "agent", weights: [60, 40] },
}

/** The short agent pane across a tab's foot: the agent pane itself, full width, at its fixed rows. */
const SHORT_AGENT: LayoutNode = { pane: "agent", weight: 1, rows: SHORT_AGENT_ROWS }
/** Collapsed, the other panes switch above it. */
const STACKED = (below: number): Layout["collapse"] => ({ below, keep: "agent", weights: [60, 40], stack: true })

/**
 * Which pane a stacked layout keeps shown beside its short agent pane, collapsed: the token pane, when the
 * layout has it and at least two others to switch between (Trending's four lists over the token). With
 * only one other, nothing is switched, and the layout reads as before.
 */
export function stackedWith(root: LayoutNode, keep: PaneId): PaneId | undefined {
  const rest = panesOf(root).filter((p) => p !== keep)
  return rest.includes("token") && rest.length >= 3 ? "token" : undefined
}

/**
 * Trending: Candle's four lists side by side, New, Graduated, On Fire (the
 * Feed pane) and Final Stretch, over the token pane, about 60:40, with the short agent pane across the
 * foot. Each list needs 30 columns for its token and figures (New: the token, its age, the hour's change
 * and the market cap), so below 130 it's one list at a time over the token, the short agent pane kept.
 * Where Candle's server has Final Stretch off, it's left out and the other three take its width.
 */
export const TRENDING: Layout = {
  name: "Trending",
  root: {
    dir: "column",
    weight: 1,
    children: [
      { dir: "row", weight: 60, children: [{ pane: "new", weight: 1 }, { pane: "graduated", weight: 1 }, { pane: "feed", weight: 1 }, { pane: "final-stretch", weight: 1 }] },
      { pane: "token", weight: 40 },
      SHORT_AGENT,
    ],
  },
  collapse: { ...STACKED(130), weights: [55, 45], with: "token" },
}

/** Signals: Hacc's tape full width over the token pane, about 65:35, and the short agent pane. */
export const SIGNALS: Layout = {
  name: "Signals",
  root: { dir: "column", weight: 1, children: [{ pane: "signals", weight: 65 }, { pane: "token", weight: 35 }, SHORT_AGENT] },
  // Collapsed, its own tab opens on Signals, not the token.
  collapse: { ...STACKED(100), first: "signals" },
}

/** P&L: the figures beside the chart, over the positions Candle books beside the fills, and the short agent pane. */
export const PNL: Layout = {
  name: "P&L",
  root: {
    dir: "column",
    weight: 1,
    children: [
      { dir: "row", weight: 50, children: [{ pane: "pnl", weight: 50 }, { pane: "pnl-chart", weight: 50 }] },
      { dir: "row", weight: 50, children: [{ pane: "pnl-positions", weight: 50 }, { pane: "trades", weight: 50 }] },
      SHORT_AGENT,
    ],
  },
  collapse: STACKED(120),
}

/**
 * Research: one token in depth. The token pane over its whole check on the
 * left, its top traders, its signals and its mentions beside them, and the agent down the right as in the
 * Cockpit. Stacked in one column, Check had four rows; side by side it has the token's height. Below 130
 * it's the agent and one switched pane, opening on Check: the tab's own pane, so collapsed it doesn't read as
 * the Cockpit, which opens on the token. A list to pick from
 * heads the middle column, switched between Candle's lists and Hacc's tape, so there's always something
 * to research without going in and out.
 */
export const RESEARCH: Layout = {
  name: "Research",
  root: {
    dir: "row",
    weight: 1,
    children: [
      {
        dir: "row",
        weight: 62,
        children: [
          { dir: "column", weight: 55, children: [{ pane: "token", weight: 55 }, { pane: "check", weight: 45 }] },
          { dir: "column", weight: 45, children: [{ pane: "lists", weight: 34 }, { pane: "traders", weight: 22 }, { pane: "token-signals", weight: 22 }, { pane: "mentions", weight: 22 }] },
        ],
      },
      { pane: "agent", weight: 38 },
    ],
  },
  collapse: { below: 130, keep: "agent", weights: [60, 40], first: "check" },
}

/** The Journal: everything the core recorded, full width over the token pane, about 70:30, and the short agent pane. */
export const JOURNAL: Layout = {
  name: "Journal",
  root: { dir: "column", weight: 1, children: [{ pane: "journal", weight: 70 }, { pane: "token", weight: 30 }, SHORT_AGENT] },
  // Collapsed, its own tab opens on the Journal, not the token, as Signals' does.
  collapse: { ...STACKED(100), first: "journal" },
}

/** Perps: the stub over the short agent pane, so its chips' questions are answered on the tab. It never collapses. */
export const PERPS: Layout = {
  name: "Perps",
  root: { dir: "column", weight: 1, children: [{ pane: "perps", weight: 1 }, SHORT_AGENT] },
  collapse: STACKED(0),
}

/**
 * Bots: the bots to pick from beside the picked one in full, as the Triggers overlay and the approvals menu sit,
 * and the short agent pane, where a bot is asked for and changed. Collapsed, it opens on the list, and → goes to
 * the picked bot.
 */
export const BOTS: Layout = {
  name: "Bots",
  root: { dir: "column", weight: 1, children: [{ dir: "row", weight: 1, children: [{ pane: "bots", weight: 35 }, { pane: "bot", weight: 65 }] }, SHORT_AGENT] },
  collapse: { ...STACKED(100), first: "bots" },
}

/**
 * Build: the person's own coding harness at most of the width, and beside it the bots folder over the paper test
 * running. Below 100 columns the harness keeps the width and every row but one, and the side column folds into that
 * row: a chip for each, opening it over the frame. No agent pane: a card the harness proposes opens over the frame,
 * and waits in the strip above the input line.
 */
export const BUILD: Layout = {
  name: "Build",
  root: { dir: "row", weight: 1, children: [{ pane: "build", weight: 70 }, { dir: "column", weight: 30, children: [{ pane: "build-folder", weight: 45 }, { pane: "build-test", weight: 55 }] }] },
  collapse: { below: 100, keep: "build", weights: [70, 30], fold: true },
}

/** The Build pane alone, across the tab: its first open, before the side column has anything to show. */
export const BUILD_ALONE: Layout = { name: "Build", root: { pane: "build", weight: 1 }, collapse: { below: 0, keep: "build", weights: [100, 0] } }

/** Every pane in a tree, in its order. */
export function panesOf(node: LayoutNode): PaneId[] {
  return "pane" in node ? [node.pane] : node.children.flatMap(panesOf)
}

export const isCollapsed = (layout: Layout, cols: number): boolean => cols < layout.collapse.below

/** `total` cut by `weights`: each its floor, and what's left to `extraTo`, else one each to the largest remainders (earlier first on a tie). */
export function split(total: number, weights: readonly number[], extraTo?: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (total * w) / sum)
  const sizes = exact.map(Math.floor)
  let left = total - sizes.reduce((a, b) => a + b, 0)
  if (extraTo !== undefined) {
    sizes[extraTo]! += left
    return sizes
  }
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    sizes[i]! += 1
    left -= 1
  }
  return sizes
}

/** Where each pane goes in `area`. */
export function place(layout: Layout, area: Rect, need: Need = {}, opts: PlaceOpts = {}): Placed {
  const gap = opts.gap ?? NO_GAP
  const foot = opts.foot ?? 0
  const placed = placeIn(layout, area, need, gap, area.h)
  if (foot <= 0) return placed
  const bottom = area.y + area.h
  const agent = placed.panes.find((p) => p.id === "agent")
  if (agent && agent.rect.y + agent.rect.h === bottom && leafOf(layout.root, "agent")?.rows !== undefined) {
    // A fixed agent pane keeps its rows, and the lines go under it: the panes above give up theirs.
    const above = placeIn(layout, { ...area, h: Math.max(1, area.h - foot) }, need, gap, area.h)
    const a = above.panes.find((p) => p.id === "agent")
    if (a) return { ...above, foot: { x: a.rect.x, y: bottom - foot, w: a.rect.w, h: foot } }
  }
  if (agent && agent.rect.y + agent.rect.h === bottom && agent.rect.h - foot >= 3) {
    // The agent's own column: the lines go under it, and every other pane keeps its rows.
    agent.rect = { ...agent.rect, h: agent.rect.h - foot }
    return { ...placed, foot: { x: agent.rect.x, y: bottom - foot, w: agent.rect.w, h: foot } }
  }
  const above = placeIn(layout, { ...area, h: Math.max(1, area.h - foot) }, need, gap, area.h)
  return { ...above, foot: { x: area.x, y: bottom - foot, w: area.w, h: foot } }
}

/** `bodyH`: the body's rows, the message and input lines included, which a fixed pane's rows go by. */
function placeIn(layout: Layout, area: Rect, need: Need, gap: Gap, bodyH: number): Placed {
  if (isCollapsed(layout, area.w)) {
    const keep = layout.collapse.keep
    const first = layout.collapse.first ? { first: layout.collapse.first } : {}
    if (layout.collapse.fold) {
      const strip = area.h >= 4 ? 1 : 0
      const h = Math.max(1, area.h - strip)
      const group = panesOf(layout.root).filter((p) => p !== keep)
      return { panes: [{ id: keep, rect: { x: area.x, y: area.y, w: area.w, h } }], ...(strip ? { folded: { rect: { x: area.x, y: area.y + h, w: area.w, h: strip }, group } } : {}) }
    }
    if (layout.collapse.stack) {
      const rows = Math.max(3, Math.min(fixedRows(leafOf(layout.root, keep)?.rows ?? SHORT_AGENT_ROWS, bodyH), area.h - gap.y - FLEX_KEEP))
      const above = Math.max(1, area.h - gap.y - rows)
      const kept = { id: keep, rect: { x: area.x, y: area.y + above + gap.y, w: area.w, h: area.h - above - gap.y } }
      // The pane kept with it shows under the switched one while both keep their FLEX_KEEP rows; else it switches too.
      const also = layout.collapse.with
      if (also && also !== keep && panesOf(layout.root).includes(also) && above - gap.y >= 2 * FLEX_KEEP) {
        const [top, under] = split(above - gap.y, layout.collapse.weights)
        const switchedH = Math.max(FLEX_KEEP, Math.min(top!, above - gap.y - FLEX_KEEP))
        return {
          panes: [{ id: also, rect: { x: area.x, y: area.y + switchedH + gap.y, w: area.w, h: above - switchedH - gap.y } }, kept],
          switched: { rect: { x: area.x, y: area.y, w: area.w, h: switchedH }, group: panesOf(layout.root).filter((p) => p !== keep && p !== also), ...first },
        }
      }
      return { panes: [kept], switched: { rect: { x: area.x, y: area.y, w: area.w, h: above }, group: panesOf(layout.root).filter((p) => p !== keep), ...first } }
    }
    const [keepW, restW] = split(area.w - gap.x, layout.collapse.weights)
    return {
      panes: [{ id: keep, rect: { x: area.x, y: area.y, w: keepW!, h: area.h } }],
      switched: { rect: { x: area.x + keepW! + gap.x, y: area.y, w: restW!, h: area.h }, group: panesOf(layout.root).filter((p) => p !== keep), ...first },
    }
  }
  const panes: Placed["panes"] = []
  placeNode(layout.root, area, need, panes, gap, bodyH)
  return { panes }
}

/** A row's split this close to one in a row above it, in the same column, lines up with it. */
export const ALIGN_CELLS = 5

/**
 * `guides`: where the borders of rows placed above in the same column fall. A row's own border within
 * ALIGN_CELLS of one moves onto it, so stacked rows read as one grid (a layout saved before drags snapped
 * split its rows a column apart, and the panes didn't line up).
 */
function placeNode(node: LayoutNode, rect: Rect, need: Need, out: Placed["panes"], gap: Gap, bodyH: number, guides?: number[]): void {
  if ("pane" in node) {
    out.push({ id: node.pane, rect })
    return
  }
  const across = node.dir === "row"
  const between = across ? gap.x : gap.y
  const total = (across ? rect.w : rect.h) - between * (node.children.length - 1)
  // A column's fixed panes take their rows first, leaving each of the others FLEX_KEEP; the rest share what's left.
  const wanted = node.children.map((c) => (!across && "pane" in c && c.rows !== undefined ? fixedRows(c.rows, bodyH) : undefined))
  const flex = node.children.map((_, i) => i).filter((i) => wanted[i] === undefined)
  let rest = total
  const fixed = wanted.map((f) => {
    if (f === undefined) return undefined
    const rows = Math.max(Math.min(3, Math.max(0, rest)), Math.min(f, rest - FLEX_KEEP * flex.length))
    rest -= rows
    return rows
  })
  const token = across ? -1 : flex.findIndex((i) => { const c = node.children[i]!; return "pane" in c && c.pane === "token" })
  const flexSizes = split(Math.max(0, rest), flex.map((i) => node.children[i]!.weight), token >= 0 ? token : undefined)
  const sizes = node.children.map((_, i) => fixed[i] ?? flexSizes[flex.indexOf(i)]!)
  if (flex.length === 0 && sizes.length) sizes[sizes.length - 1]! += Math.max(0, rest)
  if (!across) shareRows(sizes, node.children, SHARE, need, fixed)
  if (across && guides) {
    // Each border (where the next child starts) onto a guide within ALIGN_CELLS, keeping every pane wider than 2.
    let edge = rect.x
    for (let i = 0; i < sizes.length - 1; i++) {
      edge += sizes[i]! + between
      const near = guides.filter((g) => g !== edge && Math.abs(g - edge) <= ALIGN_CELLS).sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge))[0]
      if (near === undefined) continue
      const move = near - edge
      if (sizes[i]! + move < 3 || sizes[i + 1]! - move < 3) continue
      sizes[i]! += move
      sizes[i + 1]! -= move
      edge = near
    }
  }
  const mine: number[] | undefined = across ? undefined : []
  let at = across ? rect.x : rect.y
  node.children.forEach((child, i) => {
    const size = sizes[i]!
    const placed = out.length
    placeNode(child, across ? { x: at, y: rect.y, w: size, h: rect.h } : { x: rect.x, y: at, w: rect.w, h: size }, need, out, gap, bodyH, mine)
    at += size + between
    // A column's rows: where each row's panes start, as placed, guides the rows under it.
    if (mine && !("pane" in child) && child.dir === "row") for (const p of out.slice(placed)) if (p.rect.x > rect.x) mine.push(p.rect.x)
  })
}

/** `fixed`: the column's fixed panes, which neither lend rows nor borrow them. */
function shareRows(heights: number[], children: readonly LayoutNode[], share: Share, need: Need, fixed: readonly (number | undefined)[] = []): void {
  const want = children.map((c, i) => ("pane" in c && fixed[i] === undefined ? need[c.pane] : undefined))
  const index = (id: PaneId) => children.findIndex((c) => "pane" in c && c.pane === id)
  const keep = (i: number) => {
    const c = children[i]!
    return ("pane" in c ? share.keep?.[c.pane] : undefined) ?? LEND_FLOOR
  }
  const inner = (i: number) => heights[i]! - 2
  const short = (i: number) => (want[i] === undefined ? 0 : want[i]! - inner(i))
  const move = (from: number, to: number, rows: number) => {
    heights[from]! -= rows
    heights[to]! += rows
  }
  // Rows spare beyond a pane's own lines, the most-spare lender first.
  for (const i of share.ask.map(index).filter((i) => i >= 0)) {
    while (short(i) > 0) {
      let lender = -1
      let spare = 0
      for (let j = 0; j < heights.length; j++) {
        if (j === i || want[j] === undefined) continue
        const s = inner(j) - Math.max(want[j]!, LEND_FLOOR)
        if (s > spare) [lender, spare] = [j, s]
      }
      if (lender < 0) break
      move(lender, i, Math.min(short(i), spare))
    }
  }
  // Then rows a pane needs itself, taken by the panes that matter most. A pane that fills never gives.
  for (const { pane, from } of share.borrow ?? []) {
    const i = index(pane)
    if (i < 0) continue
    for (const j of from.map(index)) {
      if (short(i) <= 0) break
      if (j < 0 || want[j] === undefined) continue
      const give = inner(j) - keep(j)
      if (give > 0) move(j, i, Math.min(short(i), give))
    }
  }
}

/** What the arrows and Tab move between: each pane's rect (a collapsed group's panes share the switched one), and the Tab order. */
export interface PaneNav {
  /** The layout's panes in Tab order; a collapsed group's are one stop, whichever shows. */
  order: readonly PaneId[]
  /** The panes that show one at a time, collapsed; empty when every pane shows. */
  group: readonly PaneId[]
  /** The one the group opens on before any is focused, where the layout names it. */
  first?: PaneId
  rects: Partial<Record<PaneId, Rect>>
}

export function paneNav(placed: Placed): PaneNav {
  const rects: PaneNav["rects"] = {}
  for (const { id, rect } of placed.panes) rects[id] = rect
  const group = placed.switched?.group ?? []
  for (const id of group) rects[id] = placed.switched!.rect
  return { order: [...placed.panes.map((p) => p.id), ...group], group, ...(placed.switched?.first ? { first: placed.switched.first } : {}), rects }
}

export type Direction = "left" | "right" | "up" | "down"

/**
 * The panes beside `from` in a direction: of those across the gap that overlap it along it, the nearest,
 * top or left first. Several when they sit side by side (the right column, from the agent pane).
 */
export function beside(nav: PaneNav, from: PaneId, dir: Direction): PaneId[] {
  const a = nav.rects[from]
  if (!a) return []
  const found: { id: PaneId; gap: number; along: number }[] = []
  for (const id of nav.order) {
    const b = nav.rects[id]
    if (!b || id === from || b === a) continue
    const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
    const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0
    if (dir === "right" && b.x >= a.x + a.w && overlapY) found.push({ id, gap: b.x - (a.x + a.w), along: b.y })
    if (dir === "left" && b.x + b.w <= a.x && overlapY) found.push({ id, gap: a.x - (b.x + b.w), along: b.y })
    if (dir === "down" && b.y >= a.y + a.h && overlapX) found.push({ id, gap: b.y - (a.y + a.h), along: b.x })
    if (dir === "up" && b.y + b.h <= a.y && overlapX) found.push({ id, gap: a.y - (b.y + b.h), along: b.x })
  }
  const nearest = Math.min(...found.map((f) => f.gap))
  return found.filter((f) => f.gap === nearest).sort((p, q) => p.along - q.along).map((f) => f.id)
}

/** The panes on screen: every pane drawn, and of a collapsed group, only the one it shows. */
export function onScreen(placed: Placed, recent: readonly PaneId[]): PaneId[] {
  const shown = placed.switched ? shownOf(placed.switched.group, recent, placed.switched.first) : undefined
  return [...placed.panes.map((p) => p.id), ...(shown ? [shown] : [])]
}

/**
 * The pane a collapsed group shows: the one last focused, else the layout's `first`, else the token pane,
 * else its first. A popped Signals split halved the window, and the Cockpit had collapsed onto Feed with
 * the token out of sight.
 */
export function shownOf(group: readonly PaneId[], recent: readonly PaneId[], first?: PaneId): PaneId | undefined {
  return recent.find((id) => group.includes(id)) ?? (first && group.includes(first) ? first : undefined) ?? (group.includes("token") ? "token" : group[0])
}
