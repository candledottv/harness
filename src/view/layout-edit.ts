// Edits to a layout in the Candle Harness: open a pane beside the focused one, close one, move one
// by swapping it with the pane beside it, make one wider, narrower, taller or shorter (the menu, or a
// border dragged), and save the tab's layout under a name. Each is a pure change to the tree; the frame
// writes the result to layouts.toml. A preset is never changed: the frame copies it first ("My Cockpit").
import { beside, type Direction, type Gap, type Layout, type LayoutNode, NO_GAP, paneNav, panesOf, place, type PaneId, type Rect, type Split } from "./layout"
import { allLayouts, allTabs, layoutNamed, layoutOf, type LayoutsFile, PRESETS, type Tab } from "./layouts-file"
import { terminalText } from "../shared/terminal-text"
import { PANES } from "./panes/registry"

/** What the layout menu or a dragged border asks of the tab's layout. */
export type LayoutOp =
  /** The tab shows this layout from now on (a preset, or one of yours). */
  | { kind: "show"; name: string }
  | { kind: "open"; pane: PaneId; near?: PaneId }
  | { kind: "close"; pane: PaneId }
  | { kind: "move"; pane: PaneId; dir: Direction }
  /** `cells` wider (a row) or taller (a column), negative for narrower or shorter; `side` picks which border, else the one after. */
  | { kind: "resize"; pane: PaneId; axis: Split["dir"]; cells: number; side?: "after" | "before" }
  | { kind: "saveAs"; name: string }
  /** The tab's adjustments written into the layout of yours it started from, or dropped for it as it was. */
  | { kind: "save" }
  | { kind: "reset" }
  | { kind: "reload" }
  /** The layouts and the tab's choice put back as they were before the last change (a change had no undo). */
  | { kind: "undo" }
  /** Tabs: a new one at the end, showing the tab's layout; this tab renamed; this tab removed. */
  | { kind: "addTab"; name: string }
  | { kind: "renameTab"; name: string }
  | { kind: "removeTab" }
  /** A tab ticked on or off: `settings ▾`'s ticks and the palette's rows. */
  | { kind: "tabShown"; name: string; shown: boolean }

/** A change that couldn't be made, in words. */
export type Refused = { refused: string }
const refuse = (refused: string): Refused => ({ refused })

/** The node with `pane` swapped for what `change` returns, or removed when it returns undefined. */
function mapPane(node: LayoutNode, pane: PaneId, change: (leaf: Extract<LayoutNode, { pane: PaneId }>) => LayoutNode | LayoutNode[] | undefined): LayoutNode | undefined {
  if ("pane" in node) {
    if (node.pane !== pane) return node
    const out = change(node)
    return Array.isArray(out) ? { dir: "row", weight: node.weight, children: out } : out
  }
  const children: LayoutNode[] = []
  for (const c of node.children) {
    if ("pane" in c && c.pane === pane) {
      const out = change(c)
      if (Array.isArray(out)) children.push(...out)
      else if (out) children.push(out)
      continue
    }
    const next = mapPane(c, pane, change)
    if (next) children.push(next)
  }
  if (children.length === 0) return undefined
  // A row or column left with one child is that child, at its weight.
  if (children.length === 1 && children[0]) return { ...children[0], weight: node.weight }
  return { ...node, children }
}

const rebuilt = (layout: Layout, root: LayoutNode): Layout => {
  // The root is always a row or column, so a layout keeps a place for a second pane.
  const tree: LayoutNode = "pane" in root ? { dir: "row", weight: 1, children: [root] } : { ...root, weight: 1 }
  const next = layoutOf(layout.name, tree, layout.collapse.below)
  return layout.from ? { ...next, from: layout.from } : next
}

/** Opens `pane` after `near` (before it, `before`) in the row or column that holds it, at its siblings' mean weight; without `near`, at the end of the root. */
export function opened(layout: Layout, pane: PaneId, near?: PaneId, before = false): Layout | Refused {
  const panes = panesOf(layout.root)
  if (panes.includes(pane)) return refuse(`${pane} is already on this layout.`)
  const anchor = near && panes.includes(near) ? near : undefined
  if (!anchor) {
    const root = layout.root as Split
    const mean = root.children.reduce((n, c) => n + c.weight, 0) / root.children.length
    return rebuilt(layout, { ...root, children: [...root.children, { pane, weight: Math.round(mean) || 1 }] })
  }
  const insert = (node: LayoutNode): LayoutNode => {
    if ("pane" in node) return node
    const i = node.children.findIndex((c) => "pane" in c && c.pane === anchor)
    if (i < 0) return { ...node, children: node.children.map(insert) }
    const mean = node.children.reduce((n, c) => n + c.weight, 0) / node.children.length
    const at = before ? i : i + 1
    return { ...node, children: [...node.children.slice(0, at), { pane, weight: Math.round(mean) || 1 }, ...node.children.slice(at)] }
  }
  return rebuilt(layout, insert(layout.root))
}

/**
 * The layout as a tiled view draws it while `popped` panes are out in views of their own: each
 * left out, the panes beside it taking its place, as a close would. Never written to
 * layouts.toml: the pane comes back when its view closes. Undefined when no pane is left.
 */
export function withoutPanes(layout: Layout, popped: readonly PaneId[]): Layout | undefined {
  const out = popped.filter((p) => panesOf(layout.root).includes(p))
  if (out.length === 0) return layout
  let root: LayoutNode | undefined = layout.root
  for (const pane of out) root = root && mapPane(root, pane, () => undefined)
  return root ? rebuilt(layout, root) : undefined
}

/** Closes `pane`; a row or column left with one child becomes it. The last pane stays. */
export function closed(layout: Layout, pane: PaneId): Layout | Refused {
  const panes = panesOf(layout.root)
  if (!panes.includes(pane)) return refuse(`${pane} isn't on this layout.`)
  if (panes.length === 1) return refuse("A layout keeps at least one pane.")
  return rebuilt(layout, mapPane(layout.root, pane, () => undefined)!)
}

/** Swaps `pane` with the pane beside it in `dir`, as drawn in `area`: each takes the other's place and size. */
export function moved(layout: Layout, pane: PaneId, dir: Direction, area: Rect): Layout | Refused {
  const wide = { ...area, w: Math.max(area.w, layout.collapse.below) }
  const nav = paneNav(place(layout, wide))
  const other = beside(nav, pane, dir)[0]
  if (!other) return refuse(`Nothing is ${dir === "left" || dir === "right" ? `to the ${dir} of` : dir === "up" ? "above" : "below"} ${pane}.`)
  const swap = (node: LayoutNode): LayoutNode => ("pane" in node ? (node.pane === pane ? { ...node, pane: other } : node.pane === other ? { ...node, pane } : node) : { ...node, children: node.children.map(swap) })
  return rebuilt(layout, swap(layout.root))
}

/** The fewest cells a subtree takes along an axis: a pane's narrowest width, or 3 rows (its border and a line). */
function least(node: LayoutNode, axis: Split["dir"]): number {
  if ("pane" in node) return axis === "row" ? PANES[node.pane].minWidth : 3
  const each = node.children.map((c) => least(c, axis))
  return node.dir === axis ? each.reduce((a, b) => a + b, 0) : Math.max(...each)
}

/**
 * Moves the border after (or before) `pane`'s place in the nearest row (wider, narrower) or column
 * (taller, shorter) where there is one, by `cells`, as drawn in `area`. The weights become the cells each
 * child has, so the layout keeps its shape at other sizes. Neither side goes below what its panes need.
 */
export function resized(layout: Layout, pane: PaneId, axis: Split["dir"], cells: number, area: Rect, side?: "after" | "before", gap: Gap = NO_GAP): Layout | Refused {
  const wide = { ...area, w: Math.max(area.w, layout.collapse.below) }
  const rects = new Map(place(layout, wide, {}, { gap }).panes.map((p) => [p.id, p.rect]))
  const extent = (node: LayoutNode): number => {
    const rs = panesOf(node).map((id) => rects.get(id)!)
    return axis === "row" ? Math.max(...rs.map((r) => r.x + r.w)) - Math.min(...rs.map((r) => r.x)) : Math.max(...rs.map((r) => r.y + r.h)) - Math.min(...rs.map((r) => r.y))
  }
  // The splits from the root down to the pane, with the index of the child that holds it.
  const path: { split: Split; i: number }[] = []
  const walk = (node: LayoutNode): boolean => {
    if ("pane" in node) return node.pane === pane
    for (let i = 0; i < node.children.length; i++) {
      path.push({ split: node, i })
      if (walk(node.children[i]!)) return true
      path.pop()
    }
    return false
  }
  if (!walk(layout.root)) return refuse(`${pane} isn't on this layout.`)
  const sides: ("after" | "before")[] = side ? [side] : ["after", "before"]
  let found: { split: Split; i: number; j: number } | undefined
  for (const s of sides) {
    for (let k = path.length - 1; k >= 0 && !found; k--) {
      const { split, i } = path[k]!
      const j = s === "after" ? i + 1 : i - 1
      if (split.dir === axis && j >= 0 && j < split.children.length) found = { split, i, j }
    }
    if (found) break
  }
  const word = axis === "row" ? (cells > 0 ? "wider" : "narrower") : cells > 0 ? "taller" : "shorter"
  if (!found) return refuse(`${pane} has nothing beside it to make it ${word}.`)
  const { split, i, j } = found
  const sizes = split.children.map(extent)
  const room = cells > 0 ? sizes[j]! - least(split.children[j]!, axis) : sizes[i]! - least(split.children[i]!, axis)
  const by = Math.sign(cells) * Math.min(Math.abs(cells), Math.max(0, room))
  if (by === 0) return refuse(`${pane} can't be made ${word}: ${cells > 0 ? "the pane beside it" : "it"} is as small as its lines allow.`)
  sizes[i]! += by
  sizes[j]! -= by
  const target = split
  // A pane at fixed rows (the short agent pane) keeps fixed rows: its new height.
  const sized = (c: LayoutNode, n: number): LayoutNode => ("pane" in c && c.rows !== undefined && split.dir === "column" ? { ...c, rows: Math.max(3, sizes[n]!) } : { ...reweigh(c), weight: sizes[n]! })
  const reweigh = (node: LayoutNode): LayoutNode => {
    if ("pane" in node) return node
    if (node === target) return { ...node, children: node.children.map(sized) }
    return { ...node, children: node.children.map(reweigh) }
  }
  return rebuilt(layout, reweigh(layout.root))
}

/** How near, in cells, a dragged border comes to another before it lines up with it. */
export const SNAP_CELLS = 5

/**
 * A border dragged, as `resized`, then lined up with a border of another pane within SNAP_CELLS of where
 * it lands, so panes line up without correcting them by hand. Only borders on the same side are matched, so a right border meets a right border.
 */
export function dragged(layout: Layout, pane: PaneId, axis: Split["dir"], cells: number, area: Rect, side: "after" | "before", gap: Gap = NO_GAP): Layout | Refused {
  const first = resized(layout, pane, axis, cells, area, side, gap)
  if ("refused" in first) return first
  const wide = { ...area, w: Math.max(area.w, first.collapse.below) }
  const rects = place(first, wide, {}, { gap }).panes
  const edge = (r: Rect) => (axis === "row" ? (side === "after" ? r.x + r.w : r.x) : side === "after" ? r.y + r.h : r.y)
  const mine = rects.find((p) => p.id === pane)
  if (!mine) return first
  const at = edge(mine.rect)
  const near = rects
    .filter((p) => p.id !== pane)
    .map((p) => edge(p.rect) - at)
    .filter((d) => d !== 0 && Math.abs(d) <= SNAP_CELLS)
    .sort((a, b) => Math.abs(a) - Math.abs(b))[0]
  if (near === undefined) return first
  const snapped = resized(layout, pane, axis, cells + (side === "after" ? near : -near), area, side, gap)
  return "refused" in snapped ? first : snapped
}

/** A name for a copy that no layout has: "My Cockpit", then "My Cockpit 2". */
export function freeName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`
}

/** Whether a name can be saved as yours: 1 to 32 characters, not a preset's. */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "Type a name for the layout."
  if (trimmed.length > 32) return "A layout's name is at most 32 characters."
  if (PRESETS.some((p) => p.name === trimmed)) return `${trimmed} is a preset's name: presets can't be changed.`
  if (/["\\\n]/.test(trimmed)) return "A layout's name can't hold quotes or backslashes."
  // A character the screen doesn't draw would look like another name, and some (DEL, a lone surrogate) TOML won't read back.
  if (terminalText(trimmed) !== trimmed) return "A layout's name is plain text, without quotes or backslashes."
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// Tabs: added, renamed and removed from the layout menu or by the agent, written to
// layouts.toml as an edit to a layout is. Each tab's own choice of layout and its pin are kept by name, so a
// rename moves them; a removed tab's choice is left, so an undo brings the tab back as it was.

/** Whether a tab can be called this: 1 to 20 characters, plain text, not another tab's name. */
export function tabNameProblem(name: string, tabs: readonly (Tab | string)[], except?: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "Type a name for the tab."
  if (trimmed.length > 20) return "A tab's name is at most 20 characters."
  if (/["\\]/.test(trimmed) || terminalText(trimmed) !== trimmed) return "A tab's name is plain text, without quotes or backslashes."
  if (tabs.map((t) => (typeof t === "string" ? t : t.name)).some((t) => t === trimmed && t !== except)) return `There's a tab called ${trimmed} already.`
  return undefined
}

/** Every tab's name, shown or ticked off: no two tabs share one. */
const everyName = (file: LayoutsFile): Tab[] => allTabs(file).map((t) => t.tab)

/** The tabs with a new one at the end, starting on `layout`. There's no cap: the first nine shown get digits. */
export function tabAdded(file: LayoutsFile, name: string, layout: string): LayoutsFile | Refused {
  const problem = tabNameProblem(name, everyName(file))
  if (problem) return refuse(problem)
  if (!layoutNamed(file, layout)) return refuse(`There's no layout called ${layout} (the layouts: ${allLayouts(file).map((l) => l.name).join(", ")}).`)
  return { ...file, tabs: [...file.tabs, { name: name.trim(), layout }] }
}

export function tabRenamed(file: LayoutsFile, from: string, to: string): LayoutsFile | Refused {
  if (!file.tabs.some((t) => t.name === from)) return refuse(`There's no tab called ${from}.`)
  const problem = tabNameProblem(to, everyName(file), from)
  if (problem) return refuse(problem)
  return { ...file, tabs: file.tabs.map((t) => (t.name === from ? { ...t, name: to.trim() } : t)) }
}

export function tabRemoved(file: LayoutsFile, name: string): LayoutsFile | Refused {
  const i = file.tabs.findIndex((t) => t.name === name)
  if (i < 0) return refuse(`There's no tab called ${name}.`)
  if (file.tabs.length === 1) return refuse("The last tab stays: there's always one.")
  return { ...file, tabs: file.tabs.filter((t) => t.name !== name), hidden: file.hidden.map((h) => (h.at > i ? { ...h, at: h.at - 1 } : h)) }
}

/**
 * A tab ticked on or off: tabs are a setting, so people pick which ones show. Ticked off, it's kept where it was, so ticking it on puts it back there with its layout. One
 * tab always shows.
 */
export function tabShownIn(file: LayoutsFile, name: string, shown: boolean): LayoutsFile | Refused {
  const every = allTabs(file)
  const at = every.findIndex((t) => t.tab.name === name)
  if (at < 0) return refuse(`There's no tab called ${name}.`)
  if (every[at]!.shown === shown) return refuse(`${name} is ${shown ? "shown" : "ticked off"} already.`)
  if (!shown && file.tabs.length === 1) return refuse(`${name} is the only tab shown, and one always is: tick another on first.`)
  const next = every.map((t, i) => (i === at ? { ...t, shown } : t))
  const tabs = next.filter((t) => t.shown).map((t) => t.tab)
  const hidden: LayoutsFile["hidden"] = []
  let before = 0
  for (const t of next) {
    if (t.shown) before++
    else hidden.push({ tab: t.tab, at: before })
  }
  return { ...file, tabs, hidden, added: file.added.filter((n) => n !== name) }
}
