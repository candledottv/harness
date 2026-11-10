// The layout menu: what the tab shows, panes to open, the focused pane's close, move and
// size, save as, and reload. It opens from the `settings ▾` chip on the tab bar or the palette's "edit this
// layout…" row, which also shows a layout and saves one. Each row is an edit the frame
// makes to the tab's layout (layout-edit.ts). An edit stays on the tab, rather than making a new
// layout for every adjustment, and only a save writes layouts.toml.
import { presetOf } from "./new-panes"
import type { Direction, Layout, PaneId } from "./layout"
import { panesOf } from "./layout"
import { isTokenPane, openable } from "../shared/panes"
import type { LayoutOp } from "./layout-edit"

/** What the menu needs to know: the tab, the layout it shows, every layout, and the file. */
export interface LayoutInfo {
  tab: string
  current: Layout
  /** Every layout's name: the presets first, then yours. */
  names: readonly string[]
  /** The layout the tab shows as saved, when the agent's preview is drawn over it. */
  saved?: string
  /** Whether the current layout is a preset, so it can only be saved as one of yours. */
  preset: boolean
  /** The other tabs that show this layout of yours, which a save into it changes too. */
  sharedWith?: readonly string[]
  /** Whether the tab shows its layout as adjusted on it, not as saved. */
  adjusted?: boolean
  /** Where layouts.toml is, shown in the menu. */
  path: string
  /** Problems found reading it, each with its line. */
  problems: readonly string[]
  /** The tabs' names: a tab can't take another's, and the last one stays. */
  tabNames: readonly string[]
  /** The last change to a layout or the tab's choice, which the menu can undo. */
  undo?: string
}

export interface MenuRow {
  group: string
  label: string
  /** Shown dim after the label: a key, or what the row does. */
  hint?: string
  op?: LayoutOp
  /** The row that asks for a name, and what for: a layout saved, a tab added or this one renamed. */
  naming?: "saveAs" | "addTab" | "renameTab"
  /** Whether the menu stays open after it, for another press (move, resize). */
  stays?: true
  /** A pane to focus, so its own rows (move, size, close) show: with no pane focused. */
  focus?: PaneId
}

const ARROW: Record<Direction, string> = { left: "←", right: "→", up: "↑", down: "↓" }
/** How far a press of wider, narrower, taller or shorter moves a border. */
export const RESIZE_COLS = 6
export const RESIZE_ROWS = 2

/**
 * The focused pane's rows come first, so the row highlighted for its next press doesn't move under it;
 * close is last among them, so the first row never removes anything.
 * With no pane focused, the panes on the layout come first, each focused by its row so its own rows show
 * (with "open wallets" first and nothing else, how to build a layout was unclear). The
 * last change's undo follows them, for a row picked by mistake.
 */
export function layoutMenuRows(info: LayoutInfo, focus: PaneId | undefined): MenuRow[] {
  const rows: MenuRow[] = []
  const on = panesOf(info.current.root)
  const shared = info.sharedWith ?? []
  // An edit changes this tab only, kept until it's saved or reset.
  const copy = " (this tab only, until saved)"
  if (!focus || !on.includes(focus)) {
    // Which layout it is, said: a "My …" layout read as an unexplained tab.
    const from = presetOf(info.current)
    const which = info.preset ? `the ${info.current.name} preset` : `${info.current.name}, your layout${from ? ` saved from ${from.name}` : ""}`
    for (const pane of on) rows.push({ group: `The panes on ${info.tab}: ${which}`, label: pane, hint: "⏎ to move, resize or close it", focus: pane, stays: true })
  }
  if (focus && on.includes(focus)) {
    const group = `The focused pane, ${focus}${copy}`
    for (const dir of ["left", "right", "up", "down"] as const) rows.push({ group, label: `move ${dir}`, hint: ARROW[dir], op: { kind: "move", pane: focus, dir }, stays: true })
    rows.push({ group, label: "wider", hint: `${RESIZE_COLS} columns`, op: { kind: "resize", pane: focus, axis: "row", cells: RESIZE_COLS }, stays: true })
    rows.push({ group, label: "narrower", hint: `${RESIZE_COLS} columns`, op: { kind: "resize", pane: focus, axis: "row", cells: -RESIZE_COLS }, stays: true })
    rows.push({ group, label: "taller", hint: `${RESIZE_ROWS} rows`, op: { kind: "resize", pane: focus, axis: "column", cells: RESIZE_ROWS }, stays: true })
    rows.push({ group, label: "shorter", hint: `${RESIZE_ROWS} rows`, op: { kind: "resize", pane: focus, axis: "column", cells: -RESIZE_ROWS }, stays: true })
    if (on.length > 1) rows.push({ group, label: `close ${focus}`, op: { kind: "close", pane: focus } })
  }
  // After the rows that keep the menu open, so it appearing after an edit doesn't move the one highlighted.
  if (info.undo) rows.push({ group: "Undo", label: `undo: ${info.undo}`, op: { kind: "undo" } })
  for (const pane of openable(on)) {
    rows.push({ group: `Open a pane${focus && on.includes(focus) ? ` beside ${focus}` : ""}${copy}`, label: pane, ...(isTokenPane(pane) && pane !== "token" ? { hint: "another token pane, pinned on the token shown" } : {}), op: { kind: "open", pane, ...(focus && on.includes(focus) ? { near: focus } : {}) } })
  }
  const shows = `${info.tab} shows`
  for (const name of info.names) rows.push({ group: shows, label: name, hint: name === info.current.name ? "✓ showing" : undefined, op: { kind: "show", name } })
  if (info.adjusted && !info.preset) rows.push({ group: "layouts.toml", label: `save into ${info.current.name}`, hint: shared.length ? `${shared.join(", ")} ${shared.length === 1 ? "shows" : "show"} it too` : "your layout, as adjusted", op: { kind: "save" } })
  rows.push({ group: "layouts.toml", label: "save this layout as…", hint: "type a name", naming: "saveAs" })
  if (info.adjusted) rows.push({ group: "layouts.toml", label: `reset to ${info.current.name}`, hint: "drop this tab's changes", op: { kind: "reset" } })
  rows.push({ group: "layouts.toml", label: "reload layouts.toml", hint: "after a hand edit", op: { kind: "reload" } })
  rows.push({ group: "Tabs", label: "add a tab…", hint: `type a name; it starts on ${info.saved ?? info.current.name}`, naming: "addTab" })
  rows.push({ group: "Tabs", label: `rename ${info.tab}…`, hint: "type a name", naming: "renameTab" })
  if (info.tabNames.length > 1) rows.push({ group: "Tabs", label: `remove ${info.tab}`, hint: "its layout stays", op: { kind: "removeTab" } })
  return rows
}
