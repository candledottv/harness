// Layouts and tabs in a file: `layouts.toml` beside `config.toml`, the
// Candle Harness's own file. The presets (Agent-first, the Cockpit) aren't in it and can't be changed; a layout of
// your own is a table there, started as a copy of one. The tabs are a list there too, each naming the
// layout it starts on. Edits in the Candle Harness write the file whole, and its first line says so; a hand edit is
// read when the view starts or from the layout menu's "reload". The file is never needed: without it,
// the tabs are the five a fresh install shows, each on its preset, and the other five ticked off. A file that doesn't parse, or a
// layout or tab that doesn't hold together, is named with its line, and the presets stand in: it never
// stops the Candle Harness opening.
//
// Tabs are a setting: `settings ▾` ticks each on or off, and a tab ticked off is
// kept with `shown = false`, so its layout comes back with it. A file that lists tabs keeps its choice: the
// default tabs it doesn't name are there unticked, and the view says so once. There's no cap: the first
// nine shown get digits.
//
//   tabs = [
//     { name = "Trade", layout = "Agent-first" },
//     { name = "Desk", layout = "My desk" },
//     { name = "Perps", layout = "Perps", shown = false },
//   ]
//
//   [layouts."My desk"]
//   collapse = 130
//   root = ["row",
//     ["column", 62, "feed 40", "token 60"],
//     "agent 38"]
//
// A tree is a row or column, its weight (left out at the root), then its children: a pane's id with its
// weight ("token 60", or "token" for 1), a pane in a column at fixed rows ("agent 8 rows"), or another row
// or column.
//
// A layout saved from a preset carries `from` and `from_panes`, the preset and its panes then (so a
// pane added to a preset later reaches a layout saved from it). When the preset
// gains a pane, the tab bar offers it once.
import { keysIn } from "../config-settings"
import { AGENT_FIRST, BOTS, BUILD, COCKPIT, GAP, JOURNAL, type Layout, type LayoutNode, leafOf, PANE_IDS, type PaneId, panesOf, PERPS, place, PNL, RESEARCH, SIGNALS, type Split, stackedWith, TRENDING } from "./layout"
import { PANES } from "./panes/registry"
import { MIN_COLS } from "./too-small"

export const PRESETS: readonly Layout[] = [AGENT_FIRST, COCKPIT, TRENDING, SIGNALS, PNL, RESEARCH, JOURNAL, PERPS, BOTS, BUILD]
export const isPreset = (name: string): boolean => PRESETS.some((p) => p.name === name)

/** A layout of yours' settings in layouts.toml. */
// What the file and each of its tables hold: config-settings.ts's, so a setting can't be read without words for the docs.
const TOP_KEYS = keysIn("layouts.toml", "")
const LAYOUT_KEYS = keysIn("layouts.toml", "layouts.<name>")
const TAB_KEYS = keysIn("layouts.toml", "tabs[]")

export interface Tab {
  name: string
  /** The layout it starts on: a preset's name or one of your own. */
  layout: string
}

/**
 * Every tab the Candle Harness knows, in order, each named for its preset, and whether a fresh install shows it. Five
 * show: Trade, Cockpit, Research, Bots and Build. The rest are a tick away in `settings ▾`: ten tabs at 80 columns
 * shrank every other to a digit, and P&L is on every tab's status bar already.
 */
export const KNOWN_TABS: readonly { tab: Tab; shown: boolean }[] = [
  { tab: { name: "Trade", layout: AGENT_FIRST.name }, shown: true },
  { tab: { name: "Cockpit", layout: COCKPIT.name }, shown: true },
  { tab: { name: "Trending", layout: TRENDING.name }, shown: false },
  { tab: { name: "Signals", layout: SIGNALS.name }, shown: false },
  { tab: { name: "P&L", layout: PNL.name }, shown: false },
  { tab: { name: "Research", layout: RESEARCH.name }, shown: true },
  { tab: { name: "Journal", layout: JOURNAL.name }, shown: false },
  { tab: { name: "Perps", layout: PERPS.name }, shown: false },
  { tab: { name: "Bots", layout: BOTS.name }, shown: true },
  { tab: { name: "Build", layout: BUILD.name }, shown: true },
]

/** Every tab the Candle Harness knows, shown or not: the ones a file that lists tabs gets unticked when it doesn't name them. */
export const DEFAULT_TABS: readonly Tab[] = KNOWN_TABS.map((k) => k.tab)

/** A fresh install's tabs on the tab bar: the five shown. */
export const FRESH_TABS: readonly Tab[] = KNOWN_TABS.filter((k) => k.shown).map((k) => k.tab)

/** A fresh install's tabs ticked off, each going back where it sits among the known tabs. */
const FRESH_HIDDEN: readonly HiddenTab[] = KNOWN_TABS.flatMap((k, i) => (k.shown ? [] : [{ tab: k.tab, at: KNOWN_TABS.slice(0, i).filter((x) => x.shown).length }]))

/** A tab ticked off, and where it goes back: after `at` of the tabs shown. */
export interface HiddenTab {
  tab: Tab
  at: number
}

/**
 * What the file holds, read: the tabs shown, in order (the tab bar's, and every index the view keeps), the
 * tabs ticked off, your own layouts, and every problem found, each with its line. `added` names the
 * default tabs a file that lists tabs doesn't, shown unticked: the view says so once.
 */
export interface LayoutsFile {
  tabs: Tab[]
  hidden: HiddenTab[]
  added: string[]
  own: Layout[]
  problems: string[]
}

export const EMPTY_FILE: LayoutsFile = { tabs: [...FRESH_TABS], hidden: FRESH_HIDDEN.map((h) => ({ ...h, tab: { ...h.tab } })), added: [], own: [], problems: [] }

/** Every tab in order, shown or ticked off: the settings menu's ticks, and the file as written. */
export function allTabs(file: Pick<LayoutsFile, "tabs" | "hidden">): { tab: Tab; shown: boolean }[] {
  const out: { tab: Tab; shown: boolean }[] = file.tabs.map((tab) => ({ tab, shown: true }))
  const sorted = file.hidden.map((h, i) => ({ ...h, i })).sort((a, b) => a.at - b.at || a.i - b.i)
  for (const h of sorted) {
    // After the first `at` tabs shown, and after any tab ticked off already put there.
    let at = 0
    let shown = 0
    while (at < out.length && (shown < h.at || !out[at]!.shown)) {
      if (out[at]!.shown) shown++
      at++
    }
    out.splice(at, 0, { tab: h.tab, shown: false })
  }
  return out
}

const NAME_MAX = 32
/** A collapse below 100 would put Agent-first's own rule under a layout's; a layout can't collapse narrower. */
const MIN_COLLAPSE = 100
const WIDEST = 400

export const HEADER =
  "# candle-harness's layouts: your tabs, and layouts of your own. The Candle Harness writes this file whole when you change a layout in it,\n" +
  "# so a comment of yours below this header won't survive that. A hand edit is read when the view starts, or from the\n" +
  "# layout menu's \"reload layouts.toml\". The presets, Agent-first and Cockpit, aren't here and can't be changed.\n"

/** Every layout by name: the presets, then your own. */
export function allLayouts(file: LayoutsFile): Layout[] {
  return [...PRESETS, ...file.own]
}

export function layoutNamed(file: LayoutsFile, name: string): Layout | undefined {
  return allLayouts(file).find((l) => l.name === name)
}

/** The layout a tab shows: its last chosen (state/layout.json), else the one layouts.toml starts it on, else Agent-first. The doctor says the same. */
export function tabShows(file: LayoutsFile, choices: Record<string, string>, tab: Tab): { layout: Layout; from: "chosen" | "file" | "fallback" } {
  const chosen = choices[tab.name]
  const picked = chosen !== undefined ? layoutNamed(file, chosen) : undefined
  if (picked) return { layout: picked, from: "chosen" }
  const started = layoutNamed(file, tab.layout)
  return started ? { layout: started, from: "file" } : { layout: AGENT_FIRST, from: "fallback" }
}

/**
 * The narrowest width at which every pane gets at least its own narrowest, and every width above it
 * does too; the layout collapses below it. At least 100, so no layout collapses narrower than Agent-first.
 */
export function neededWidth(root: LayoutNode): number {
  const fits = (w: number) => place({ name: "", root, collapse: { below: 0, keep: "agent", weights: [60, 40] } }, { x: 0, y: 0, w, h: 40 }, {}, { gap: GAP }).panes.every((p) => p.rect.w >= PANES[p.id].minWidth)
  let need = MIN_COLLAPSE
  for (let w = WIDEST; w >= MIN_COLLAPSE; w--) {
    if (!fits(w)) {
      need = w + 1
      break
    }
  }
  return need
}

/** A layout from a tree: the agent kept when it collapses, else its first pane, and the collapse at least what its panes need. */
export function layoutOf(name: string, root: LayoutNode, collapse?: number): Layout {
  const panes = panesOf(root)
  const keep = panes.includes("agent") ? "agent" : panes.includes("build") ? "build" : panes[0]!
  const below = Math.max(collapse ?? 0, neededWidth(root))
  // The Build pane, kept, keeps its width and height, and the others fold into a strip under it, as Build's own tab does.
  if (keep === "build") return { name, root, collapse: { below, keep, weights: [70, 30], fold: true } }
  // A kept pane at fixed rows (the short agent pane) stays across the foot when the layout collapses, with
  // the token pane over it when there are panes enough to switch (Trending, and a copy of it).
  const stack = leafOf(root, keep)?.rows !== undefined
  const also = stack ? stackedWith(root, keep) : undefined
  return { name, root, collapse: { below, keep, weights: also ? [55, 45] : [60, 40], ...(stack ? { stack: true as const } : {}), ...(also ? { with: also } : {}) } }
}

// ---------------------------------------------------------------------------------------------------------
// Reading.

/** The line (from 1) of the first `needle` at or after `from`, else `from`'s. */
function lineOf(source: string, needle: string, from = 0): number {
  const at = source.indexOf(needle, from)
  return source.slice(0, at >= 0 ? at : from).split("\n").length
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const quote = (v: unknown) => JSON.stringify(v)

/** The pane id within two edits of `word`, if one is (a typo's: "agnet", "signal"). */
function nearestPane(word: string): PaneId | undefined {
  const distance = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      const row = [i]
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = row
    }
    return prev[b.length]!
  }
  const ranked = PANE_IDS.map((id) => ({ id, d: distance(word, id) })).sort((x, y) => x.d - y.d)
  return ranked[0] && ranked[0].d <= 2 ? ranked[0].id : undefined
}

/** The most rows a fixed pane can be set to. */
const ROWS_MAX = 60

/** A tree from the file's arrays, or the first problem with it: the file's own, and the agent's `build`. `parent`: the split it's in. */
export function treeOf(raw: unknown, root: boolean, seen: Set<PaneId>, parent?: Split["dir"]): LayoutNode | string {
  if (typeof raw === "string") {
    const m = /^\s*([a-z][a-z-]*(?::\d+)?)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(rows))?\s*$/.exec(raw)
    if (!m) return `${quote(raw)} isn't a pane: write its id and weight, such as "token 60", or its rows in a column, such as "agent 8 rows"`
    const id = m[1] as PaneId
    if (!(PANE_IDS as readonly string[]).includes(id)) {
      // With twenty panes the whole list was too long to read on the message line: a typo gets the pane it's nearest.
      const near = nearestPane(id)
      return near ? `there's no pane called ${quote(m[1])}; the nearest is ${quote(near)}` : `there's no pane called ${quote(m[1])} (the panes: ${PANE_IDS.join(", ")})`
    }
    if (seen.has(id)) return `${quote(id)} is in it twice`
    seen.add(id)
    if (m[3] !== undefined) {
      const rows = Number(m[2])
      if (parent !== "column") return `${quote(raw)}: a pane has fixed rows only in a column`
      if (!Number.isInteger(rows) || rows < 3 || rows > ROWS_MAX) return `${quote(raw)}: fixed rows are a whole number from 3 to ${ROWS_MAX}`
      return { pane: id, weight: 1, rows }
    }
    const weight = m[2] === undefined ? 1 : Number(m[2])
    if (!(weight > 0)) return `${quote(raw)} needs a weight above 0`
    return { pane: id, weight }
  }
  if (!Array.isArray(raw) || (raw[0] !== "row" && raw[0] !== "column")) return `${quote(raw)} isn't a pane or a row or column: a row is ["row", weight, …children]`
  const dir = raw[0] as Split["dir"]
  const hasWeight = typeof raw[1] === "number"
  const weight = hasWeight ? (raw[1] as number) : 1
  if (!root && !hasWeight) return `a ${dir} inside another needs its weight after ${quote(dir)}, such as ["${dir}", 40, …]`
  if (!(weight > 0)) return `a ${dir}'s weight must be above 0`
  const rest = raw.slice(hasWeight ? 2 : 1)
  if (rest.length === 0) return `a ${dir} with nothing in it`
  const children: LayoutNode[] = []
  for (const c of rest) {
    const child = treeOf(c, false, seen, dir)
    if (typeof child === "string") return child
    children.push(child)
  }
  return { dir, weight, children }
}

/** Reads `layouts.toml`. Never throws: every problem is named with its line, and what's wrong is left out. */
export function parseLayouts(source: string, file = "layouts.toml"): LayoutsFile {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    // Bun's error carries no line of the TOML (its line is the caller's), but its message quotes what it
    // tripped on: the line is where that first appears.
    const words = ((error as Error).message ?? "").replace(/^TOML Parse error: /, "")
    const token = /"([^"]+)"/.exec(words)?.[1]
    const line = token && source.includes(token) ? ` line ${lineOf(source, token)}` : ""
    return { ...EMPTY_FILE, problems: [`${file}${line} isn't valid TOML (${words}): the presets are used.`] }
  }
  const problems: string[] = []
  const at = (line: number, text: string) => problems.push(`${file} line ${line}: ${text}`)
  const top = isRecord(raw) ? raw : {}
  for (const key of Object.keys(top)) if (!TOP_KEYS.includes(key)) at(lineOf(source, key), `${quote(key)} isn't something this file holds (${TOP_KEYS.join(", ")})`)

  // Your own layouts.
  const own: Layout[] = []
  const layouts = isRecord(top.layouts) ? top.layouts : {}
  if (top.layouts !== undefined && !isRecord(top.layouts)) at(lineOf(source, "layouts"), "layouts must be tables, such as [layouts.\"My desk\"]")
  for (const [name, value] of Object.entries(layouts)) {
    const start = Math.max(source.indexOf(`[layouts.${quote(name)}]`), source.indexOf(`[layouts.${name}]`))
    const line = lineOf(source, "", Math.max(0, start))
    const lineIn = (needle: string) => lineOf(source, needle, Math.max(0, start))
    if (!name.trim() || name.length > NAME_MAX) {
      at(line, `a layout's name is 1 to ${NAME_MAX} characters: ${quote(name)} is left out`)
      continue
    }
    if (isPreset(name)) {
      at(line, `${quote(name)} is a preset's name, and a preset can't be changed: name yours another way, such as "My ${name}"`)
      continue
    }
    if (!isRecord(value)) {
      at(line, `layout ${quote(name)} must be a table with a root`)
      continue
    }
    for (const key of Object.keys(value)) if (!LAYOUT_KEYS.includes(key)) at(lineIn(key), `layout ${quote(name)}: ${quote(key)} isn't a layout's setting (${LAYOUT_KEYS.join(", ")})`)
    const tree = treeOf(value.root, true, new Set())
    if (typeof tree === "string") {
      // Point at the pane or word the problem names, where it can.
      const word = /"([a-z][a-z-]*)/.exec(tree)?.[1]
      at(word ? lineIn(word) : lineIn("root"), `layout ${quote(name)}: ${tree}. It's left out.`)
      continue
    }
    if ("pane" in tree) continue // unreachable: the root is always a row or column
    let collapse: number | undefined
    if (value.collapse !== undefined) {
      if (typeof value.collapse !== "number" || !Number.isInteger(value.collapse) || value.collapse < MIN_COLS) at(lineIn("collapse"), `layout ${quote(name)}: collapse is ${quote(value.collapse)}; it's the width in columns below which the layout collapses, a whole number from ${MIN_COLS}`)
      else collapse = value.collapse
    }
    const layout = layoutOf(name, tree, collapse)
    if (collapse !== undefined && collapse < layout.collapse.below) at(lineIn("collapse"), `layout ${quote(name)}: its panes need ${layout.collapse.below} columns, so it collapses below that, not ${collapse}`)
    // Which preset it was saved from, and that preset's panes then: a mistake here only loses the offer of a new pane.
    let from: Layout["from"]
    if (value.from !== undefined || value.from_panes !== undefined) {
      const panes = Array.isArray(value.from_panes) ? value.from_panes : undefined
      if (typeof value.from !== "string" || !isPreset(value.from)) at(lineIn("from"), `layout ${quote(name)}: from is ${quote(value.from)}; it names the preset it was saved from (${PRESETS.map((p) => p.name).join(", ")})`)
      else if (!panes || !panes.every((x): x is PaneId => typeof x === "string" && (PANE_IDS as readonly string[]).includes(x))) at(lineIn("from_panes"), `layout ${quote(name)}: from_panes lists the panes ${value.from} had when it was saved, such as ["token", "check"]`)
      else from = { preset: value.from, panes }
    }
    own.push(from ? { ...layout, from } : layout)
  }

  // The tabs.
  let tabs: Tab[] = [...FRESH_TABS]
  let hidden: HiddenTab[] = EMPTY_FILE.hidden.map((h) => ({ ...h }))
  let added: string[] = []
  if (top.tabs !== undefined) {
    const line = lineOf(source, "tabs")
    if (!Array.isArray(top.tabs) || top.tabs.length === 0) at(line, "tabs must be a list such as [{ name = \"Trade\", layout = \"Agent-first\" }]: the default tabs are used")
    else {
      const read: { tab: Tab; shown: boolean }[] = []
      for (const t of top.tabs) {
        const tl = isRecord(t) && typeof t.name === "string" ? lineOf(source, quote(t.name)) : line
        if (!isRecord(t) || typeof t.name !== "string" || typeof t.layout !== "string") {
          at(tl, `${quote(t)} isn't a tab: a tab is { name = "Trade", layout = "Agent-first" }`)
          continue
        }
        if (!t.name.trim() || t.name.length > 20) {
          at(tl, `a tab's name is 1 to 20 characters: ${quote(t.name)} is left out`)
          continue
        }
        if (read.some((r) => r.tab.name === t.name)) {
          at(tl, `two tabs are called ${quote(t.name)}: the second is left out`)
          continue
        }
        for (const key of Object.keys(t)) if (!TAB_KEYS.includes(key)) at(tl, `tab ${quote(t.name)}: ${quote(key)} isn't a tab's setting (${TAB_KEYS.join(", ")})`)
        if (t.shown !== undefined && typeof t.shown !== "boolean") at(tl, `tab ${quote(t.name)}: shown is true or false, not ${quote(t.shown)}: it's shown`)
        const known = PRESETS.some((p) => p.name === t.layout) || own.some((o) => o.name === t.layout)
        if (!known) at(tl, `tab ${quote(t.name)} names a layout there isn't, ${quote(t.layout)}: it shows Agent-first`)
        read.push({ tab: { name: t.name, layout: known ? t.layout : AGENT_FIRST.name }, shown: t.shown !== false })
      }
      if (read.length && !read.some((r) => r.shown)) {
        at(line, "every tab is ticked off (shown = false): the first is shown, since one always is")
        read[0]!.shown = true
      }
      if (read.length) {
        tabs = read.filter((r) => r.shown).map((r) => r.tab)
        hidden = []
        let before = 0
        for (const r of read) {
          if (r.shown) before++
          else hidden.push({ tab: r.tab, at: before })
        }
        // The default tabs the file doesn't name, by name or by layout: there, unticked.
        const named = (d: Tab) => read.some((r) => r.tab.name === d.name || r.tab.layout === d.layout)
        const missing = DEFAULT_TABS.filter((d) => !named(d))
        hidden = [...hidden, ...missing.map((tab) => ({ tab: { ...tab }, at: tabs.length }))]
        added = missing.map((d) => d.name)
      }
    }
  }
  return { tabs, hidden, added, own, problems }
}

// ---------------------------------------------------------------------------------------------------------
// Writing.

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))))

function treeText(node: LayoutNode, depth: number, root: boolean): string {
  if ("pane" in node) return quote(node.rows !== undefined ? `${node.pane} ${node.rows} rows` : `${node.pane} ${num(node.weight)}`)
  const head = root ? quote(node.dir) : `${quote(node.dir)}, ${num(node.weight)}`
  const pad = "  ".repeat(depth + 1)
  // A split of panes alone fits one line; one holding others breaks a line per child.
  if (node.children.every((c) => "pane" in c)) return `[${head}, ${node.children.map((c) => treeText(c, depth + 1, false)).join(", ")}]`
  return `[${head},\n${node.children.map((c) => `${pad}${treeText(c, depth + 1, false)}`).join(",\n")}]`
}

/** A layout's tree as the file writes it: what the agent reads before it changes one. */
export const rootText = (root: LayoutNode): string => treeText(root, 0, true).replace(/\n\s*/g, " ")

/** The file whole: the header, the tabs (each ticked off with `shown = false`), then each layout of your own. Reads back as it was written. */
export function layoutsText(file: Pick<LayoutsFile, "tabs" | "own"> & { hidden?: readonly HiddenTab[] }): string {
  const every = allTabs({ tabs: file.tabs, hidden: [...(file.hidden ?? [])] })
  const tabs = `tabs = [\n${every.map(({ tab: t, shown }) => `  { name = ${quote(t.name)}, layout = ${quote(t.layout)}${shown ? "" : ", shown = false"} },`).join("\n")}\n]\n`
  const from = (l: Layout) => (l.from ? `from = ${quote(l.from.preset)}\nfrom_panes = [${l.from.panes.map(quote).join(", ")}]\n` : "")
  const layouts = file.own.map((l) => `\n[layouts.${quote(l.name)}]\ncollapse = ${l.collapse.below}\n${from(l)}root = ${treeText(l.root, 0, true)}\n`)
  return `${HEADER}\n${tabs}${layouts.join("")}`
}
