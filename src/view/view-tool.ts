// The agent's harness_view, as a view answers it.
// The core asks the main view the person last used (core/view-asks.ts); this works out what the ask means
// for this view's tabs, layouts and themes, and the frame (app.tsx) makes the change and says so.
//
// - At once: switching the tab on screen, showing a layout that exists on a tab, pinning and unpinning a
//   token pane, switching to a theme that exists. None of them writes layouts.toml or a theme.
// - A preview, kept on the person's click: "open", "close" and "build". The tab draws the agent's
//   layout, and keep and discard show under the agent's reply. Nothing is written until keep, so a restart shows the
//   layout as it was. A second change on the same tab builds on the preview.
// - At once, with an undo: adding, renaming and removing a tab, written to layouts.toml as the
//   layout menu writes it.
// - Written, then used at once with an undo: a theme the agent makes. It's checked as every theme
//   is (theme.ts, problemsOf) before anything is written; one that fails is refused with why. It's only
//   ever written over while it's the agent's own, its first line the Candle Harness's mark.
// - Tabs: showing a tab ticked off the tab bar, or ticking one off, as the
//   settings tick does, at once with an undo. A `pane` on `tab` goes to the tab that has it and shows that
//   pane where the layout is collapsed ("what's in final stretch"). Signals' choice (the tape or your rules,
//   a pattern, a chain) and its pause, and a search in the Journal, are set at once, on the tab on screen
//   if it has the pane, else the first tab that does, switched to. The agent never reads a Journal row here.
//
// It never moves focus, pops a pane out, writes config.toml, or saves a layout the person didn't keep.
import { JOURNAL_KINDS, type JournalKind, KIND_WORDS } from "../core/journal-query"
import type { SignalsChoice } from "../core/view-state"
import { type Layout, PANE_IDS, type PaneId, panesOf } from "./layout"
import { isTokenPane, TOKEN_PANES, type TokenPane } from "../shared/panes"
import { placeWords } from "../core/view-state"
import { closed, freeName, nameProblem, opened, type Refused, tabAdded, tabRemoved, tabRenamed, tabShownIn } from "./layout-edit"
import { allLayouts, allTabs, type HiddenTab, isPreset, layoutNamed, layoutOf, type LayoutsFile, rootText, type Tab, treeOf } from "./layouts-file"
import type { SignalsChange } from "./keys"
import type { JournalSearch } from "./panes/journal"
import { CHAIN_NAMES, PATTERN_WORDS, SIGNAL_PATTERNS, signalsChoiceOf, type SignalsPick } from "./panes/signals"
import { BUILT_IN, BUILT_IN_NAMES, CANDLE_DARK, CANDLE_LIGHT, type Colours, hexOf, problemsOf } from "./theme"
import { FILE_NAME, KEYS, parseTheme, REPLY_KEYS } from "./themes"

/** A layout the agent drew on a tab, waiting for the person's keep or discard. */
export interface AgentPreview {
  agent: string
  layout: Layout
}

/** What the view holds that the agent's ask reads. */
export interface ViewToolContext {
  file: LayoutsFile
  /** Each tab's last chosen layout, by tab name. */
  choices: Record<string, string>
  /** The tab on screen, by index. */
  tab: number
  previews: Readonly<Record<string, AgentPreview>>
  pins: readonly { at: string; pane?: Exclude<TokenPane, "token">; symbol?: string; mint: string }[]
  theme: { current: string; names: readonly string[]; read: (name: string) => string | undefined }
  /** Each tab's Signals choice (the core's `views` topic), and whether the Signals pane is paused. */
  signals?: readonly SignalsChoice[]
  signalsPaused?: boolean
  /** The Journal's search, this view's. */
  journal?: JournalSearch
}

/** The first line of a theme the agent made: while it's there, the agent may write the file again. */
export const AGENT_THEME_MARK = "# Made by the agent in the Candle Harness (harness_view). It may write over this file while this line is here; delete the line to keep the file as yours alone."

/** What the frame does for the ask: each carries the agent's answer, and the words for Activity where something changed. */
export type ViewPlan =
  | { kind: "refused"; code: string; text: string }
  | { kind: "read"; text: string }
  | { kind: "tab"; at: number; text: string; words: string; pane?: PaneId }
  | { kind: "show"; tab: string; layout: string; text: string; words: string }
  | { kind: "preview"; tab: string; layout: Layout; text: string; words: string }
  | { kind: "tabs"; file: LayoutsFile; before: Tab[]; hidden?: HiddenTab[]; select?: number; renamed?: { from: string; to: string }; text: string; words: string }
  | { kind: "signals"; tab: string; at?: number; change: SignalsChange; paused?: boolean; text: string; words: string }
  | { kind: "journal"; at?: number; search: JournalSearch; text: string; words: string }
  | { kind: "pin"; tab: string; pane: TokenPane; mint?: string }
  | { kind: "unpin"; tab: string; pane: TokenPane }
  | { kind: "theme"; name: string }
  | { kind: "makeTheme"; name: string; source: string; text: string; words: string }

const refused = (text: string, code = "VIEW_REFUSED"): ViewPlan => ({ kind: "refused", code, text })
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined)
const isRefused = (v: unknown): v is Refused => typeof v === "object" && v !== null && "refused" in v
const KEEP_WORDS = "The person keeps it or discards it with a click under your reply; until they keep it, nothing is saved."
/** A yes or no, as an engine may send one: Claude Code has sent "true" for a boolean. */
const yesNo = (v: unknown): boolean | undefined => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined)

/** A tab by name or number (1 to 9), else the tab on screen. */
function tabOf(ctx: ViewToolContext, named: unknown): { tab: Tab; at: number } | string {
  const raw = str(named)
  if (raw === undefined) {
    const at = Math.max(0, Math.min(ctx.file.tabs.length - 1, ctx.tab))
    return { tab: ctx.file.tabs[at]!, at }
  }
  const byNumber = /^[1-9]$/.test(raw) ? Number(raw) - 1 : -1
  const at = byNumber >= 0 && byNumber < ctx.file.tabs.length ? byNumber : ctx.file.tabs.findIndex((t) => t.name.toLowerCase() === raw.toLowerCase())
  if (at < 0) {
    const off = ctx.file.hidden.find((h) => h.tab.name.toLowerCase() === raw.toLowerCase())
    if (off) return `${off.tab.name} is ticked off the tab bar. If they asked to see it, show_tab ticks it on and switches to it, with an undo for them.`
    return `There's no tab called ${raw} (the tabs: ${ctx.file.tabs.map((t) => t.name).join(", ")}).`
  }
  return { tab: ctx.file.tabs[at]!, at }
}

/**
 * The tab a pane's change goes to: the one named, else the tab on screen if it has the pane, else a tab
 * named after the pane (the Signals tab for "only KOL mentions on Signals", where the Cockpit comes first),
 * else the first tab that has it, switched to. A tab ticked off that has it is named, for show_tab.
 */
function tabWith(ctx: ViewToolContext, pane: PaneId, named: unknown): { tab: Tab; at: number; switched: boolean } | string {
  const on = Math.max(0, Math.min(ctx.file.tabs.length - 1, ctx.tab))
  const has = (t: Tab) => panesOf(drawn(ctx, t).root).includes(pane)
  if (str(named) !== undefined) {
    const t = tabOf(ctx, named)
    if (typeof t === "string") return t
    if (!has(t.tab)) return `${t.tab.name} has no ${pane} pane${tabsWith(ctx, pane)}.`
    return { ...t, switched: t.at !== on }
  }
  if (has(ctx.file.tabs[on]!)) return { tab: ctx.file.tabs[on]!, at: on, switched: false }
  const home = ctx.file.tabs.findIndex((t) => has(t) && t.name.toLowerCase() === pane.replace(/-/g, " "))
  const at = home >= 0 ? home : ctx.file.tabs.findIndex(has)
  if (at >= 0) return { tab: ctx.file.tabs[at]!, at, switched: true }
  const off = ctx.file.hidden.find((h) => panesOf((layoutNamed(ctx.file, h.tab.layout) ?? allLayouts(ctx.file)[0]!).root).includes(pane))
  if (off) return `No tab on the tab bar has a ${pane} pane. ${off.tab.name} has one but is ticked off: show_tab ticks it on, with an undo for them.`
  return `No tab has a ${pane} pane: open puts one on a tab's layout, as a preview.`
}

/** ", only X and Y have one", for a refusal. */
function tabsWith(ctx: ViewToolContext, pane: PaneId): string {
  const names = ctx.file.tabs.filter((t) => panesOf(drawn(ctx, t).root).includes(pane)).map((t) => t.name)
  return names.length ? ` (${names.join(" and ")} ${names.length === 1 ? "has" : "have"} one)` : ""
}

/** A Signals choice in words: "Hacc's tape", "only mention signals on Solana", "your own rules' signals". */
function pickWords(pick: SignalsPick): string {
  if (pick.mine) return "your own rules' signals"
  if (!pick.pattern && !pick.chain) return "Hacc's whole tape"
  const pattern = pick.pattern ? `${PATTERN_WORDS[pick.pattern as keyof typeof PATTERN_WORDS]?.label ?? pick.pattern} signals (${pick.pattern})` : "signals"
  return `only ${pattern}${pick.chain ? ` on ${CHAIN_NAMES[pick.chain]}` : ""} from Hacc's tape`
}

/** A Journal search in words. */
const searchWords = (s: JournalSearch): string =>
  `${s.query ? `"${s.query}"` : "everything"}${s.kinds ? `, ${s.kinds.map((k) => KIND_WORDS[k]).join(" and ")} only` : ""}`

/** The layout a tab shows now: its last chosen, else the one it starts on, else Agent-first. */
function savedLayout(ctx: ViewToolContext, tab: Tab): Layout {
  const chosen = ctx.choices[tab.name]
  return (chosen !== undefined ? layoutNamed(ctx.file, chosen) : undefined) ?? layoutNamed(ctx.file, tab.layout) ?? allLayouts(ctx.file)[0]!
}

/** What the tab draws: the agent's preview on it, else what it shows. */
const drawn = (ctx: ViewToolContext, tab: Tab): Layout => ctx.previews[tab.name]?.layout ?? savedLayout(ctx, tab)

const paneId = (v: unknown): PaneId | undefined => (typeof v === "string" && (PANE_IDS as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as PaneId) : undefined)
const layoutByName = (file: LayoutsFile, v: unknown): Layout | undefined => {
  const name = str(v)
  return name === undefined ? undefined : allLayouts(file).find((l) => l.name.toLowerCase() === name.toLowerCase())
}

/** The screen as the agent reads it: tabs, each layout's tree, the panes, pins and themes. */
function readText(ctx: ViewToolContext): string {
  const on = Math.max(0, Math.min(ctx.file.tabs.length - 1, ctx.tab))
  const tabs = ctx.file.tabs.map((t, i) => {
    const l = drawn(ctx, t)
    const preview = ctx.previews[t.name] ? ` (a preview of ${ctx.previews[t.name]!.agent}'s change, waiting for the person's keep or discard)` : ""
    return `${i + 1}. ${t.name}${i === on ? " (on screen)" : ""}: ${l.name}${preview}, ${rootText(l.root)}`
  })
  const layouts = allLayouts(ctx.file).map((l) => `${l.name}${isPreset(l.name) ? " (preset)" : " (theirs)"}`)
  const off = ctx.file.hidden.map((h) => h.tab.name)
  const signals = ctx.file.tabs.filter((t) => panesOf(drawn(ctx, t).root).includes("signals")).map((t) => `${t.name}, ${pickWords(signalsChoiceOf(ctx.signals, t.name))}`)
  const pins = ctx.pins.map((p) => `${placeWords(p)} on ${p.symbol ?? p.mint}`)
  const themes = ctx.theme.names.map((n) => `${n}${n === ctx.theme.current ? " (on)" : ""}${BUILT_IN_NAMES.includes(n) ? "" : ctx.theme.read(n)?.startsWith(AGENT_THEME_MARK) ? " (made by an agent)" : " (theirs)"}`)
  return [
    "Tabs, each with the layout it shows and its tree:",
    ...tabs,
    off.length ? `Ticked off the tab bar (show_tab shows one): ${off.join(", ")}.` : undefined,
    `Layouts: ${layouts.join(", ")}.`,
    `Panes: ${PANE_IDS.join(", ")}.`,
    `Pinned token panes: ${pins.length ? pins.join(", ") : "none"}.`,
    signals.length ? `Signals shows: ${signals.join("; ")}${ctx.signalsPaused ? " (paused)" : ""}.` : undefined,
    ctx.journal?.query || ctx.journal?.kinds ? `The Journal's search: ${searchWords(ctx.journal)}.` : undefined,
    `Themes: ${themes.join(", ")}.`,
    ctx.file.problems.length ? `layouts.toml has a problem the person must fix by hand before the Candle Harness writes it: ${ctx.file.problems[0]}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

/** A preview of `next` on `tab`, kept as `keepAs` if the person keeps it. */
function preview(ctx: ViewToolContext, tab: Tab, next: Layout, said: string, keepAs?: string): ViewPlan {
  const taken = allLayouts(ctx.file).map((l) => l.name)
  const base = drawn(ctx, tab)
  // Kept as the name asked, unless another layout has it. Unnamed, a kept change stays on the tab until the
  // person saves it by name, so it never makes a layout they didn't ask for.
  const name = keepAs === undefined ? base.name : keepAs === base.name && !isPreset(base.name) ? keepAs : freeName(keepAs, taken)
  const layout = layoutOf(name, next.root, next.collapse.below)
  const kept = keepAs === undefined ? `it stays on ${tab.name} until they save it by name` : `it's saved as "${name}"${taken.includes(name) ? ", replacing theirs" : ""}`
  return { kind: "preview", tab: tab.name, layout, text: `${tab.name} shows the change as a preview: ${said}. ${KEEP_WORDS} Kept, ${kept}.`, words: `previewed a layout on ${tab.name}: ${said}` }
}

/** The ask's plan, from its arguments. Never throws. */
export function planView(args: Record<string, unknown>, ctx: ViewToolContext): ViewPlan {
  const action = str(args.action)
  switch (action) {
    case "read":
      return { kind: "read", text: readText(ctx) }
    case "tab": {
      if (args.pane !== undefined) {
        // A pane to show: "what's in final stretch" is Trending's Final Stretch, shown even where the tab is collapsed.
        const pane = paneId(args.pane)
        if (!pane) return refused(`pane is one of ${PANE_IDS.join(", ")}.`, "UNKNOWN_PANE")
        const t = tabWith(ctx, pane, args.tab)
        if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
        return { kind: "tab", at: t.at, pane, text: `The screen shows the ${t.tab.name} tab, with its ${pane} pane. Say so in a sentence: they can see it, so don't describe it.`, words: `showed ${pane} on the ${t.tab.name} tab` }
      }
      const t = tabOf(ctx, args.tab)
      if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
      return { kind: "tab", at: t.at, text: `The screen shows the ${t.tab.name} tab. Say so in a sentence: they can see it, so don't describe it.`, words: `switched to the ${t.tab.name} tab` }
    }
    case "show_tab":
    case "hide_tab": {
      if (ctx.file.problems.length) return refused(`layouts.toml has a problem the person must fix by hand first, or what the Candle Harness couldn't read would be lost: ${ctx.file.problems[0]}`, "LAYOUTS_FILE")
      const raw = str(args.tab)
      if (!raw) return refused("tab names the tab to show or tick off.", "UNKNOWN_TAB")
      const every = allTabs(ctx.file)
      const found = every.find((t) => t.tab.name.toLowerCase() === raw.toLowerCase())
      if (!found) return refused(`There's no tab called ${raw} (the tabs: ${every.map((t) => t.tab.name).join(", ")}).`, "UNKNOWN_TAB")
      const name = found.tab.name
      const before = ctx.file.tabs.map((x) => ({ ...x }))
      const hidden = ctx.file.hidden.map((h) => ({ ...h, tab: { ...h.tab } }))
      if (action === "show_tab") {
        // Shown already: switched to, as "tab" would.
        if (found.shown) {
          const at = ctx.file.tabs.findIndex((t) => t.name === name)
          return { kind: "tab", at, text: `${name} was on the tab bar already; the screen shows it.`, words: `switched to the ${name} tab` }
        }
        const next = tabShownIn(ctx.file, name, true)
        if (isRefused(next)) return refused(next.refused, "TAB_REFUSED")
        const at = next.tabs.findIndex((t) => t.name === name)
        return { kind: "tabs", file: next, before, hidden, select: at, text: `${name} is on the tab bar${at < 9 ? ` (${at + 1})` : ""} and on screen. The person can undo it under your reply.`, words: `showed the ${name} tab` }
      }
      const next = tabShownIn(ctx.file, name, false)
      if (isRefused(next)) return refused(next.refused, found.shown ? "TAB_REFUSED" : "TAB_HIDDEN")
      return { kind: "tabs", file: next, before, hidden, text: `${name} is ticked off the tab bar; its layout is kept, and settings ▾ ticks it back on. The person can undo it under your reply.`, words: `ticked the ${name} tab off` }
    }
    case "signals":
      return signalsPlan(args, ctx)
    case "journal":
      return journalPlan(args, ctx)
    case "layout": {
      const t = tabOf(ctx, args.tab)
      if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
      const l = layoutByName(ctx.file, args.layout)
      if (!l) return refused(`There's no layout called ${str(args.layout) ?? "that"} (the layouts: ${allLayouts(ctx.file).map((x) => x.name).join(", ")}).`, "UNKNOWN_LAYOUT")
      // "Show me the cockpit" with a Cockpit tab means that tab, not the one on screen made into it.
      // Only when no tab is named: naming the tab on screen puts the layout there.
      if (args.tab === undefined && drawn(ctx, t.tab).name !== l.name) {
        const other = ctx.file.tabs.findIndex((x, i) => i !== t.at && !ctx.previews[x.name] && savedLayout(ctx, x).name === l.name)
        if (other >= 0) {
          const name = ctx.file.tabs[other]!.name
          return { kind: "tab", at: other, text: `The ${name} tab already shows ${l.name}, so the screen switched to it. To put ${l.name} on ${t.tab.name} itself, call layout again with tab "${t.tab.name}".`, words: `switched to the ${name} tab` }
        }
      }
      return { kind: "show", tab: t.tab.name, layout: l.name, text: `${t.tab.name} shows ${l.name}.`, words: `switched ${t.tab.name} to ${l.name}` }
    }
    case "open":
    case "close": {
      const t = tabOf(ctx, args.tab)
      if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
      const pane = paneId(args.pane)
      if (!pane) return refused(`pane is one of ${PANE_IDS.join(", ")}.`, "UNKNOWN_PANE")
      const base = drawn(ctx, t.tab)
      const near = args.near === undefined ? undefined : paneId(args.near)
      if (args.near !== undefined && (!near || !panesOf(base.root).includes(near))) return refused(`near names a pane on ${t.tab.name}'s layout: ${panesOf(base.root).join(", ")}.`, "UNKNOWN_PANE")
      const next = action === "open" ? opened(base, pane, near) : closed(base, pane)
      if (isRefused(next)) return refused(next.refused, "LAYOUT_REFUSED")
      const planned = preview(ctx, t.tab, next, action === "open" ? `${pane} opened${near ? ` beside ${near}` : ""}` : `${pane} closed`)
      // Another token pane shows the link until it's pinned: comparing tokens means pinning it on one.
      return action === "open" && isTokenPane(pane) && pane !== "token" && planned.kind === "preview" ? { ...planned, text: `${planned.text} It shows the linked token until you pin it on one: "pin" with pane "${pane}" and the token's mint.` } : planned
    }
    case "build": {
      const t = tabOf(ctx, args.tab)
      if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
      const tree = treeOf(args.root, true, new Set())
      if (typeof tree === "string") return refused(`root: ${tree}.`, "BAD_TREE")
      if ("pane" in tree) return refused('root is a row or column, such as ["row", "agent 60", "token 40"].', "BAD_TREE")
      const keepAs = str(args.name)
      if (keepAs !== undefined) {
        const problem = nameProblem(keepAs)
        if (problem) return refused(`name: ${problem}`, "BAD_NAME")
      }
      return preview(ctx, t.tab, layoutOf(keepAs ?? drawn(ctx, t.tab).name, tree), `a new layout of ${panesOf(tree).join(", ")}`, keepAs)
    }
    case "add_tab":
    case "rename_tab":
    case "remove_tab": {
      if (ctx.file.problems.length) return refused(`layouts.toml has a problem the person must fix by hand first, or what the Candle Harness couldn't read would be lost: ${ctx.file.problems[0]}`, "LAYOUTS_FILE")
      const before = ctx.file.tabs.map((x) => ({ ...x }))
      if (action === "add_tab") {
        const name = str(args.name)
        if (!name) return refused("name is the new tab's name, 1 to 20 characters.", "BAD_NAME")
        const l = args.layout === undefined ? undefined : layoutByName(ctx.file, args.layout)
        if (args.layout !== undefined && !l) return refused(`There's no layout called ${str(args.layout) ?? "that"} (the layouts: ${allLayouts(ctx.file).map((x) => x.name).join(", ")}).`, "UNKNOWN_LAYOUT")
        // A new tab starts on a saved layout: the one named, else the one the tab on screen shows (never a preview).
        const layout = l?.name ?? savedLayout(ctx, (tabOf(ctx, undefined) as { tab: Tab }).tab).name
        const next = tabAdded(ctx.file, name, layout)
        if (isRefused(next)) return refused(next.refused, "TAB_REFUSED")
        return { kind: "tabs", file: next, before, text: `Added the tab ${name.trim()}, number ${next.tabs.length}, showing ${layout}. The person can undo it under your reply.`, words: `added the tab ${name.trim()} (${layout})` }
      }
      const t = tabOf(ctx, args.tab)
      if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
      if (action === "rename_tab") {
        const name = str(args.name)
        if (!name) return refused("name is the tab's new name, 1 to 20 characters.", "BAD_NAME")
        const next = tabRenamed(ctx.file, t.tab.name, name)
        if (isRefused(next)) return refused(next.refused, "TAB_REFUSED")
        return { kind: "tabs", file: next, before, renamed: { from: t.tab.name, to: name.trim() }, text: `Renamed ${t.tab.name} to ${name.trim()}. The person can undo it under your reply.`, words: `renamed the tab ${t.tab.name} to ${name.trim()}` }
      }
      const next = tabRemoved(ctx.file, t.tab.name)
      if (isRefused(next)) return refused(next.refused, "TAB_REFUSED")
      return { kind: "tabs", file: next, before, text: `Removed the tab ${t.tab.name}; its layout is still there. The person can undo it under your reply.`, words: `removed the tab ${t.tab.name}` }
    }
    case "pin":
    case "unpin": {
      const t = tabOf(ctx, args.tab)
      if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
      const on = panesOf(drawn(ctx, t.tab).root)
      if (!on.includes("token")) return refused(`${t.tab.name} has no token pane to pin: open one first.`, "NO_TOKEN_PANE")
      const pane = args.pane === undefined ? "token" : paneId(args.pane)
      if (!isTokenPane(pane)) return refused(`pane is one of ${TOKEN_PANES.join(", ")}: which of ${t.tab.name}'s token panes.`, "UNKNOWN_PANE")
      if (!on.includes(pane)) return refused(`${t.tab.name} has no ${pane}: open it first (its token panes: ${on.filter(isTokenPane).join(", ")}).`, "NO_TOKEN_PANE")
      const mint = str(args.mint)
      return action === "pin" ? { kind: "pin", tab: t.tab.name, pane, ...(mint ? { mint } : {}) } : { kind: "unpin", tab: t.tab.name, pane }
    }
    case "theme": {
      const name = str(args.name)
      const found = name === undefined ? undefined : ctx.theme.names.find((n) => n.toLowerCase() === name.toLowerCase())
      if (!found) return refused(`There's no theme called ${name ?? "that"} (the themes: ${ctx.theme.names.join(", ")}). make_theme writes a new one.`, "UNKNOWN_THEME")
      return { kind: "theme", name: found }
    }
    case "make_theme":
      return makeTheme(args, ctx)
    default:
      return refused("action is one of read, tab, layout, open, close, build, add_tab, rename_tab, remove_tab, show_tab, hide_tab, pin, unpin, signals, journal, theme, make_theme.", "MCP_VALIDATION")
  }
}

/** Signals' choice and pause, on the tab on screen if it has a Signals pane, else the first tab that does. */
function signalsPlan(args: Record<string, unknown>, ctx: ViewToolContext): ViewPlan {
  const change: SignalsChange = {}
  if (args.mine !== undefined) {
    const mine = yesNo(args.mine)
    if (mine === undefined) return refused("mine is true for the person's own rules' signals, false for Hacc's tape.", "MCP_VALIDATION")
    change.mine = mine
  }
  if (args.pattern !== undefined) {
    const p = typeof args.pattern === "string" ? args.pattern.trim().toLowerCase() : args.pattern
    if (p === null || p === "" || p === "all") change.pattern = null
    else if (typeof p === "string" && SIGNAL_PATTERNS.includes(p)) change.pattern = p
    else return refused(`pattern is one of ${SIGNAL_PATTERNS.join(", ")}, or "all".`, "MCP_VALIDATION")
  }
  if (args.chain !== undefined) {
    const c = typeof args.chain === "string" ? args.chain.trim().toLowerCase() : args.chain
    if (c === null || c === "" || c === "both") change.chain = null
    else if (c === "solana" || c === "hood") change.chain = c
    else return refused('chain is "solana", "hood" or "both".', "MCP_VALIDATION")
  }
  const paused = args.paused === undefined ? undefined : yesNo(args.paused)
  if (args.paused !== undefined && paused === undefined) return refused("paused is true to hold the tape where it is, false to resume at the newest.", "MCP_VALIDATION")
  if (!Object.keys(change).length && paused === undefined) return refused("Say what Signals shows: mine, pattern, chain or paused.", "MCP_VALIDATION")
  const t = tabWith(ctx, "signals", args.tab)
  if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
  const was = signalsChoiceOf(ctx.signals, t.tab.name)
  const mine = change.mine ?? !!was.mine
  if (mine && (change.pattern || change.chain)) return refused("pattern and chain filter Hacc's tape, not the person's own rules' signals: leave mine out, or false.", "MCP_VALIDATION")
  const pattern = change.pattern === undefined ? was.pattern : (change.pattern ?? undefined)
  const chain = change.chain === undefined ? was.chain : (change.chain ?? undefined)
  const now: SignalsPick = { ...(mine ? { mine: true } : {}), ...(pattern ? { pattern } : {}), ...(chain ? { chain } : {}) }
  const shows = pickWords(now)
  const pause = paused === true ? ", paused where it is: it counts what arrives, and they resume it with a click" : ""
  const where = t.switched ? `The screen shows the ${t.tab.name} tab: its` : `${t.tab.name}'s`
  const back = !now.mine && (now.pattern || now.chain) ? " A filter also reads Hacc's recent tape back, so older matches show." : ""
  const changed = Object.keys(change).length > 0
  const words = changed ? `set Signals on ${t.tab.name} to ${shows}${paused === true ? ", paused" : ""}` : paused ? `paused Signals on ${t.tab.name}` : `resumed Signals on ${t.tab.name}`
  return {
    kind: "signals",
    tab: t.tab.name,
    ...(t.switched ? { at: t.at } : {}),
    change,
    ...(paused !== undefined ? { paused } : {}),
    text: `${where} Signals pane shows ${shows}${pause}.${changed ? back : ""} Say so in a sentence; the rows are on their screen.`,
    words,
  }
}

/** A search in the Journal, on the tab on screen if it has the Journal, else the first tab that does. Nothing is read back to the agent. */
function journalPlan(args: Record<string, unknown>, ctx: ViewToolContext): ViewPlan {
  if (args.search !== undefined && typeof args.search !== "string") return refused("search is the words to look for, such as \"JUP sell\"; \"\" shows everything.", "MCP_VALIDATION")
  const query = (typeof args.search === "string" ? args.search : "").replace(/\s+/g, " ").trim()
  if (query.length > 100) return refused("search is at most 100 characters.", "MCP_VALIDATION")
  let kinds: JournalKind[] | undefined
  if (args.kinds !== undefined) {
    const list = Array.isArray(args.kinds) ? args.kinds : typeof args.kinds === "string" ? [args.kinds] : undefined
    if (!list?.length || list.some((k) => !(JOURNAL_KINDS as readonly unknown[]).includes(k))) return refused(`kinds are any of ${JOURNAL_KINDS.join(", ")}.`, "MCP_VALIDATION")
    kinds = JOURNAL_KINDS.filter((k) => list.includes(k))
  }
  const t = tabWith(ctx, "journal", args.tab)
  if (typeof t === "string") return refused(t, "UNKNOWN_TAB")
  const search: JournalSearch = { query, ...(kinds ? { kinds } : {}) }
  const where = t.switched ? `The screen shows the ${t.tab.name} tab: the Journal` : `The Journal on ${t.tab.name}`
  return {
    kind: "journal",
    ...(t.switched ? { at: t.at } : {}),
    search,
    // The rows are the person's to read: the agent's own past is harness_history's.
    text: `${where} shows the rows matching ${searchWords(search)}, newest first; a row matches when it holds every word. You don't see them: say in a sentence that they're on screen. Your own turns, cards and paper trades are harness_history's to read.`,
    words: `searched the Journal for ${searchWords(search)}`,
  }
}

/** A theme of the person's own from the agent's colours: its file's text, checked as the view would check it. */
function makeTheme(args: Record<string, unknown>, ctx: ViewToolContext): ViewPlan {
  const name = str(args.name)
  if (!name || !FILE_NAME.test(name)) return refused("name is the theme's name: 1 to 32 letters, digits, spaces, - or _, starting with a letter or digit.", "BAD_NAME")
  if (BUILT_IN_NAMES.some((n) => n.toLowerCase() === name.toLowerCase())) return refused(`${name} is a built-in theme's name: pick another.`, "BAD_NAME")
  const existing = ctx.theme.read(name)
  if (existing !== undefined && !existing.startsWith(AGENT_THEME_MARK)) return refused(`The person has a theme of their own called ${name}, and the Candle Harness never writes over it: pick another name.`, "THEIRS")
  const base = args.base === undefined ? CANDLE_DARK : args.base === CANDLE_DARK || args.base === CANDLE_LIGHT ? args.base : undefined
  if (!base) return refused(`base is "${CANDLE_DARK}" or "${CANDLE_LIGHT}".`, "BAD_BASE")
  const lines: string[] = [AGENT_THEME_MARK, `base = ${JSON.stringify(base)}`]
  const faults: string[] = []
  const table = (raw: unknown, keys: Readonly<Record<string, unknown>>, where: string): string[] => {
    if (raw === undefined) return []
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      faults.push(`${where} is a table of colours by name`)
      return []
    }
    const out: string[] = []
    for (const [k, v] of Object.entries(raw)) {
      if (!Object.hasOwn(keys, k)) faults.push(`${where}.${k} isn't a colour's name (${Object.keys(keys).join(", ")})`)
      else if (!hexOf(v)) faults.push(`${where}.${k} is ${JSON.stringify(v)}; a colour is "#rrggbb"`)
      else out.push(`${k} = ${JSON.stringify(hexOf(v))}`)
    }
    return out
  }
  lines.push(...table(args.colours, KEYS, "colours"))
  const reply = table(args.reply, REPLY_KEYS, "reply")
  if (faults.length) return refused(`${faults.join("; ")}. Nothing was written.`, "BAD_COLOURS")
  if (reply.length) lines.push("", "[reply]", ...reply)
  const source = `${lines.join("\n")}\n`
  const read = parseTheme(source, `themes/${name}.toml`)
  if (read.problems.length) return refused(`${read.problems[0]}. Nothing was written.`, "BAD_COLOURS")
  const colours: Colours = { ...BUILT_IN[read.base]!, ...read.set }
  const problems = problemsOf(colours)
  if (problems.length) return refused(`It wouldn't read: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ""}. Nothing was written; change those colours and make it again.`, "UNREADABLE")
  const again = existing !== undefined
  return {
    kind: "makeTheme",
    name,
    source,
    text: `${again ? "Wrote" : "Made"} themes/${name}.toml, which passed the readability check.`,
    words: `${again ? "changed" : "made"} the theme ${name}`,
  }
}
