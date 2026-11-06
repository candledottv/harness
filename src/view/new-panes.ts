// A preset's new panes, offered to a layout of yours saved from it. A layout saved unasked from a resize,
// before Research gained its list pane, showed Research without the list. A layout saved from a preset now
// records which and the panes it had then (layouts.toml's `from` and `from_panes`); a pane the preset has
// gained since, and the layout lacks, is offered once on the tab bar: `add` puts it where the preset has it,
// as an unsaved change on the tab, and `✕` leaves it, remembered. A layout saved before this has no record,
// and is matched to a preset by its name ("My Research", "My Cockpit 2"): it's offered only the panes the
// preset gained since its first version, once.
import { type Layout, type LayoutNode, type PaneId, panesOf } from "./layout"
import { opened, type Refused } from "./layout-edit"
import { PRESETS } from "./layouts-file"

/** The preset a layout of yours was saved from: its record, else its name. Undefined for a preset itself. */
export function presetOf(layout: Layout): Layout | undefined {
  if (PRESETS.some((p) => p.name === layout.name)) return undefined
  const named = layout.from?.preset ?? /^My (.+?)(?: \d+)?$/.exec(layout.name)?.[1]
  return PRESETS.find((p) => p.name === named)
}

/**
 * The panes each preset gained after its first version, for a layout saved with no record of what the
 * preset had: only these are offered to it. A pane the preset always had and the layout lacks was taken out
 * on purpose (the agent, taken off a watch tab, was offered back).
 */
export const GAINED: Readonly<Record<string, readonly PaneId[]>> = { Research: ["lists"] }

/** The panes the preset has that the layout lacks and wasn't saved without, less those the person dismissed. */
export function newPanes(layout: Layout, dismissed: readonly string[]): PaneId[] {
  const preset = presetOf(layout)
  if (!preset) return []
  const had = new Set<string>([...(layout.from?.panes ?? []), ...panesOf(layout.root), ...dismissed])
  const offered = layout.from?.panes ? panesOf(preset.root) : panesOf(preset.root).filter((p) => GAINED[preset.name]?.includes(p))
  return offered.filter((p) => !had.has(p))
}

/** The pane's siblings in the preset, in order, in the row or column that holds it. */
function siblings(node: LayoutNode, pane: PaneId): PaneId[] | undefined {
  if ("pane" in node) return undefined
  if (node.children.some((c) => "pane" in c && c.pane === pane)) return node.children.flatMap((c) => ("pane" in c ? [c.pane] : []))
  for (const c of node.children) {
    const found = siblings(c, pane)
    if (found) return found
  }
  return undefined
}

/** The layout with `pane` where the preset has it: after the sibling before it, else before the one after it, else at the end. */
export function withNewPane(layout: Layout, preset: Layout, pane: PaneId): Layout | Refused {
  const on = panesOf(layout.root)
  const row = siblings(preset.root, pane) ?? []
  const at = row.indexOf(pane)
  const before = row.slice(0, at).reverse().find((p) => on.includes(p))
  if (before) return opened(layout, pane, before)
  const after = row.slice(at + 1).find((p) => on.includes(p))
  return after ? opened(layout, pane, after, true) : opened(layout, pane)
}
