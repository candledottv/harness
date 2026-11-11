import { expect, test } from "bun:test"
import { AGENT_FIRST, panesOf } from "./layout"
import { DEFAULT_TABS, EMPTY_FILE, layoutsText, parseLayouts } from "./layouts-file"
import { AGENT_THEME_MARK, planView, type ViewToolContext } from "./view-tool"
import { parseTheme } from "./themes"

// Two tabs, as an older layouts.toml lists them: the others are there, ticked off.
const TWO = parseLayouts('tabs = [{ name = "Trade", layout = "Agent-first" }, { name = "Cockpit", layout = "Cockpit" }]\n')
const ctx = (over: Partial<ViewToolContext> = {}): ViewToolContext => ({
  file: TWO,
  choices: {},
  tab: 0,
  previews: {},
  pins: [],
  theme: { current: "Candle dark", names: ["Candle dark", "Candle light", "Terminal", "Mine"], read: (n) => (n === "Mine" ? 'pane = "#101418"\n' : undefined) },
  ...over,
})

test("read says the tabs, each layout's tree, the panes, pins and themes, whose each is", () => {
  const plan = planView({ action: "read" }, ctx({ pins: [{ at: "Trade", symbol: "MOON", mint: "x" }] }))
  expect(plan.kind).toBe("read")
  const text = (plan as { text: string }).text
  expect(text).toContain('1. Trade (on screen): Agent-first, ["row", "agent 60", ["column", 40, "token 4", "positions 3", "wallets 2", "activity 3"]]')
  expect(text).toContain("2. Cockpit: Cockpit")
  expect(text).toContain("Layouts: Agent-first (preset), Cockpit (preset), Trending (preset), Signals (preset), P&L (preset), Research (preset), Journal (preset), Perps (preset), Bots (preset), Build (preset).")
  expect(text).toContain("Pinned token panes: Trade on MOON.")
  expect(text).toContain("Themes: Candle dark (on), Candle light, Terminal, Mine (theirs).")
})

test("tab and layout act at once; an unknown name says what there is", () => {
  expect(planView({ action: "tab", tab: "cockpit" }, ctx())).toMatchObject({ kind: "tab", at: 1, words: "switched to the Cockpit tab" })
  expect(planView({ action: "tab", tab: "2" }, ctx())).toMatchObject({ kind: "tab", at: 1 })
  expect(planView({ action: "tab", tab: "Desk" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_TAB", text: "There's no tab called Desk (the tabs: Trade, Cockpit)." })
  // A tab that already shows it is switched to, unless the tab is named.
  expect(planView({ action: "layout", layout: "cockpit" }, ctx())).toMatchObject({ kind: "tab", at: 1, words: "switched to the Cockpit tab" })
  expect(planView({ action: "layout", layout: "cockpit", tab: "Trade" }, ctx())).toMatchObject({ kind: "show", tab: "Trade", layout: "Cockpit", words: "switched Trade to Cockpit" })
  expect(planView({ action: "layout", layout: "Agent-first" }, ctx({ tab: 1 }))).toMatchObject({ kind: "tab", at: 0 })
  expect(planView({ action: "layout", layout: "Nope" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_LAYOUT" })
})

test("open, close and build are previews, kept on the tab or under the name given; a second change builds on the first", () => {
  const opened = planView({ action: "open", pane: "signals", near: "token" }, ctx())
  expect(opened).toMatchObject({ kind: "preview", tab: "Trade", words: "previewed a layout on Trade: signals opened beside token" })
  if (opened.kind !== "preview") throw new Error()
  expect(panesOf(opened.layout.root)).toEqual(["agent", "token", "signals", "positions", "wallets", "activity"])
  expect(opened.text).toContain("nothing is saved")
  expect(opened.text).toContain("it stays on Trade until they save it by name")
  // On the preview: wallets closed too.
  const closed = planView({ action: "close", pane: "wallets" }, ctx({ previews: { Trade: { agent: "momentum", layout: opened.layout } } }))
  if (closed.kind !== "preview") throw new Error()
  expect(panesOf(closed.layout.root)).toEqual(["agent", "token", "signals", "positions", "activity"])
  expect(planView({ action: "open", pane: "token" }, ctx())).toMatchObject({ kind: "refused", text: "token is already on this layout." })
  expect(planView({ action: "open", pane: "chart" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_PANE" })

  const built = planView({ action: "build", root: ["row", "agent 55", ["column", 45, "token 60", "signals 40"]], name: "Tape" }, ctx())
  if (built.kind !== "preview") throw new Error()
  expect(built.layout.name).toBe("Tape")
  expect(panesOf(built.layout.root)).toEqual(["agent", "token", "signals"])
  // A name of theirs already taken isn't written over: the kept copy gets a free one.
  const mine = parseLayouts(layoutsText({ tabs: EMPTY_FILE.tabs, own: [{ ...AGENT_FIRST, name: "Tape" }] }))
  const again = planView({ action: "build", root: ["row", "agent", "feed"], name: "Tape" }, ctx({ file: mine }))
  expect(again).toMatchObject({ kind: "preview", layout: { name: "Tape 2" } })
  expect(planView({ action: "build", root: ["row", "agent", "agent"] }, ctx())).toMatchObject({ kind: "refused", code: "BAD_TREE", text: 'root: "agent" is in it twice.' })
  expect(planView({ action: "build", root: ["row", "agent"], name: "Cockpit" }, ctx())).toMatchObject({ kind: "refused", code: "BAD_NAME" })
})

test("tabs are added, renamed and removed at once, with the tabs before for an undo; a new tab starts on a saved layout", () => {
  const added = planView({ action: "add_tab", name: "Tape", layout: "Cockpit" }, ctx())
  expect(added).toMatchObject({ kind: "tabs", words: "added the tab Tape (Cockpit)" })
  if (added.kind !== "tabs") throw new Error()
  expect(added.file.tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Tape"])
  expect(added.before.map((t) => t.name)).toEqual(["Trade", "Cockpit"])
  // With a preview on screen, a new tab starts on the layout the tab shows as saved.
  const preview = { Trade: { agent: "momentum", layout: { ...AGENT_FIRST, name: "Draft" } } }
  expect(planView({ action: "add_tab", name: "Two" }, ctx({ previews: preview }))).toMatchObject({ kind: "tabs", words: "added the tab Two (Agent-first)" })
  expect(planView({ action: "add_tab", name: "Trade" }, ctx())).toMatchObject({ kind: "refused", text: "There's a tab called Trade already." })
  expect(planView({ action: "rename_tab", tab: "Cockpit", name: "Desk" }, ctx())).toMatchObject({ kind: "tabs", renamed: { from: "Cockpit", to: "Desk" } })
  expect(planView({ action: "remove_tab", tab: "Cockpit" }, ctx())).toMatchObject({ kind: "tabs", words: "removed the tab Cockpit" })
  const one = parseLayouts('tabs = [{ name = "Only", layout = "Agent-first" }]\n')
  expect(planView({ action: "remove_tab" }, ctx({ file: one }))).toMatchObject({ kind: "refused", text: "The last tab stays: there's always one." })
  // A file with a problem isn't written over, or what the Candle Harness couldn't read would be lost.
  const broken = parseLayouts("tabs = 3\n")
  expect(planView({ action: "add_tab", name: "X" }, ctx({ file: broken }))).toMatchObject({ kind: "refused", code: "LAYOUTS_FILE" })
})

test("a pin needs a token pane on the tab; a theme that exists is switched to by its name", () => {
  expect(planView({ action: "pin", mint: "MoonFake11111111111111111111111111111111111" }, ctx())).toEqual({ kind: "pin", tab: "Trade", pane: "token", mint: "MoonFake11111111111111111111111111111111111" })
  const noToken = { Trade: { agent: "momentum", layout: { ...AGENT_FIRST, root: { dir: "row" as const, weight: 1, children: [{ pane: "agent" as const, weight: 1 }] } } } }
  expect(planView({ action: "pin" }, ctx({ previews: noToken }))).toMatchObject({ kind: "refused", code: "NO_TOKEN_PANE" })
  expect(planView({ action: "theme", name: "candle light" }, ctx())).toEqual({ kind: "theme", name: "Candle light" })
  expect(planView({ action: "theme", name: "Dusk" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_THEME" })
})

test("another token pane is pinned by its id, only where the tab has it; opening one tells the agent to pin it", () => {
  // Trade's layout has one token pane: token:2 isn't there to pin, and a pane that isn't a token pane isn't one.
  expect(planView({ action: "pin", pane: "token:2" }, ctx())).toMatchObject({ kind: "refused", code: "NO_TOKEN_PANE", text: expect.stringContaining("open it first") })
  expect(planView({ action: "pin", pane: "wallets" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_PANE" })
  const opened = planView({ action: "open", pane: "token:2", near: "token" }, ctx())
  expect(opened.kind).toBe("preview")
  expect(opened.kind === "preview" && opened.text).toContain('"pin" with pane "token:2"')
  // With the preview on the tab, token:2 pins, and unpins, by its id.
  if (opened.kind !== "preview") throw new Error("not a preview")
  const two = { Trade: { agent: "momentum", layout: opened.layout } }
  expect(planView({ action: "pin", pane: "token:2", mint: "MoonFake11111111111111111111111111111111111" }, ctx({ previews: two }))).toEqual({ kind: "pin", tab: "Trade", pane: "token:2", mint: "MoonFake11111111111111111111111111111111111" })
  expect(planView({ action: "unpin", pane: "token:2" }, ctx({ previews: two }))).toEqual({ kind: "unpin", tab: "Trade", pane: "token:2" })
  // The screen's read names which token pane each pin is on.
  const read = planView({ action: "read" }, ctx({ pins: [{ at: "Trade", pane: "token:2", mint: "MoonFake11111111111111111111111111111111111", symbol: "MOON" }] }))
  expect(read.kind === "read" && read.text).toContain("Pinned token panes: Trade's token:2 on MOON.")
})

test("make_theme writes a checked theme with the agent's mark; an unreadable one, a bad colour, or a theme of theirs by that name is refused", () => {
  const made = planView({ action: "make_theme", name: "Dusk", colours: { heading: "#d2a8ff", attention: "#ffb000" }, reply: { code: "#9ecbff" } }, ctx())
  expect(made).toMatchObject({ kind: "makeTheme", name: "Dusk", words: "made the theme Dusk" })
  if (made.kind !== "makeTheme") throw new Error()
  expect(made.source.startsWith(`${AGENT_THEME_MARK}\n`)).toBe(true)
  expect(parseTheme(made.source, "themes/Dusk.toml")).toEqual({ base: "Candle dark", set: { head: "#d2a8ff", look: "#ffb000", mdCode: "#9ecbff" }, problems: [] })
  // Used at once by the view, with an undo under the reply: the plan says only that it passed.
  expect(made.text).toContain("passed the readability check")
  expect(made.text).not.toContain("use it")
  // Dim text on the pane colour: under 4:1.
  const faint = planView({ action: "make_theme", name: "Faint", colours: { dim: "#20252b" } }, ctx())
  expect(faint).toMatchObject({ kind: "refused", code: "UNREADABLE" })
  expect((faint as { text: string }).text).toContain("Nothing was written")
  expect(planView({ action: "make_theme", name: "X", colours: { glow: "#ffffff" } }, ctx())).toMatchObject({ kind: "refused", code: "BAD_COLOURS" })
  expect(planView({ action: "make_theme", name: "X", colours: { text: "white" } }, ctx())).toMatchObject({ kind: "refused", code: "BAD_COLOURS" })
  expect(planView({ action: "make_theme", name: "Mine", colours: {} }, ctx())).toMatchObject({ kind: "refused", code: "THEIRS" })
  expect(planView({ action: "make_theme", name: "Terminal" }, ctx())).toMatchObject({ kind: "refused", code: "BAD_NAME" })
  // One the agent made is written again under its name.
  const agents = ctx({ theme: { current: "Candle dark", names: ["Candle dark", "Dusk"], read: (n) => (n === "Dusk" ? made.source : undefined) } })
  expect(planView({ action: "make_theme", name: "Dusk", base: "Candle light" }, agents)).toMatchObject({ kind: "makeTheme", words: "changed the theme Dusk" })
})

// The tabs: every one shown, as a person who ticked them all on has them, and TWO's eight ticked off.
const EVERY = parseLayouts(layoutsText({ tabs: [...DEFAULT_TABS], own: [] }))

test("tab with a pane goes to the tab that has it; a tab ticked off says show_tab ticks it on", () => {
  expect(planView({ action: "tab", pane: "final-stretch" }, ctx({ file: EVERY }))).toMatchObject({ kind: "tab", at: 2, pane: "final-stretch", words: "showed final-stretch on the Trending tab" })
  // The tab on screen first, when it has the pane: Signals on the Cockpit stays there.
  expect(planView({ action: "tab", pane: "signals" }, ctx({ file: EVERY, tab: 1 }))).toMatchObject({ kind: "tab", at: 1, pane: "signals" })
  expect(planView({ action: "tab", pane: "signals", tab: "Signals" }, ctx({ file: EVERY, tab: 1 }))).toMatchObject({ kind: "tab", at: 3 })
  expect(planView({ action: "tab", pane: "journal", tab: "Trade" }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", text: "Trade has no journal pane (Journal has one)." })
  expect(planView({ action: "tab", pane: "chart" }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", code: "UNKNOWN_PANE" })
  expect(planView({ action: "tab", tab: "Perps" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_TAB", text: expect.stringContaining("Perps is ticked off the tab bar. If they asked to see it, show_tab") })
  expect(planView({ action: "tab", pane: "final-stretch" }, ctx())).toMatchObject({ kind: "refused", text: expect.stringContaining("Trending has one but is ticked off: show_tab") })
})

test("show_tab and hide_tab tick a tab on or off as settings does, with what was for an undo", () => {
  const shown = planView({ action: "show_tab", tab: "perps" }, ctx())
  expect(shown).toMatchObject({ kind: "tabs", select: 2, words: "showed the Perps tab" })
  if (shown.kind !== "tabs") throw new Error()
  expect(shown.file.tabs.map((t) => t.name)).toEqual(["Trade", "Cockpit", "Perps"])
  expect(shown.before.map((t) => t.name)).toEqual(["Trade", "Cockpit"])
  expect(shown.hidden?.map((h) => h.tab.name)).toContain("Perps")
  expect(shown.file.hidden.map((h) => h.tab.name)).not.toContain("Perps")
  // On the tab bar already: switched to.
  expect(planView({ action: "show_tab", tab: "Cockpit" }, ctx())).toMatchObject({ kind: "tab", at: 1 })
  const hidden = planView({ action: "hide_tab", tab: "Journal" }, ctx({ file: EVERY }))
  if (hidden.kind !== "tabs") throw new Error()
  expect(hidden.file.tabs.map((t) => t.name)).not.toContain("Journal")
  expect(hidden.file.hidden.map((h) => h.tab.name)).toEqual(["Journal"])
  expect(hidden.select).toBeUndefined()
  expect(planView({ action: "hide_tab", tab: "Perps" }, ctx())).toMatchObject({ kind: "refused", code: "TAB_HIDDEN", text: "Perps is ticked off already." })
  expect(planView({ action: "show_tab", tab: "Desk" }, ctx())).toMatchObject({ kind: "refused", code: "UNKNOWN_TAB" })
  const one = parseLayouts('tabs = [{ name = "Only", layout = "Agent-first" }]\n')
  expect(planView({ action: "hide_tab", tab: "Only" }, ctx({ file: one }))).toMatchObject({ kind: "refused", code: "TAB_REFUSED" })
})

test("signals sets a Signals pane's choice and pause where it is, else on the first tab with one", () => {
  const kol = planView({ action: "signals", tab: "Signals", pattern: "kol_mention" }, ctx({ file: EVERY }))
  expect(kol).toMatchObject({ kind: "signals", tab: "Signals", at: 3, change: { pattern: "kol_mention" }, words: "set Signals on Signals to only mention signals (kol_mention) from Hacc's tape" })
  expect((kol as { text: string }).text).toContain("The screen shows the Signals tab")
  // The tab on screen, the Cockpit, has Signals: no switch. Filters left out stay as they are.
  const choices = [{ at: "Cockpit", pattern: "dormancy", chain: "solana" as const }]
  const chain = planView({ action: "signals", chain: "both" }, ctx({ file: EVERY, tab: 1, signals: choices }))
  expect(chain).toMatchObject({ kind: "signals", tab: "Cockpit", change: { chain: null }, words: "set Signals on Cockpit to only woke up signals (dormancy) from Hacc's tape" })
  expect((chain as { at?: number }).at).toBeUndefined()
  // With wallets on two chains, its chain is the status bar's, for every pane: a chain alone sets that; with another change, it's said to ask apart.
  const both = { current: "hood" as const, chains: ["solana" as const, "hood" as const] }
  expect(planView({ action: "signals", chain: "both" }, ctx({ file: EVERY, tab: 1, chain: both }))).toMatchObject({ kind: "chain", chain: null })
  expect(planView({ action: "signals", chain: "solana", pattern: "deployer" }, ctx({ file: EVERY, chain: both }))).toMatchObject({ kind: "refused", code: "MCP_VALIDATION", text: expect.stringContaining('action "chain"') })
  expect(planView({ action: "signals", paused: "true" }, ctx({ file: EVERY, tab: 3 }))).toMatchObject({ kind: "signals", change: {}, paused: true, words: "paused Signals on Signals" })
  // Off a tab with Signals, the tab named after it, not the Cockpit before it.
  expect(planView({ action: "signals", mine: true }, ctx({ file: EVERY, tab: 2 }))).toMatchObject({ kind: "signals", tab: "Signals", at: 3, words: "set Signals on Signals to your own rules' signals" })
  expect(planView({ action: "signals", pattern: "all", chain: "both" }, ctx({ file: EVERY, tab: 3 }))).toMatchObject({ change: { pattern: null, chain: null }, words: "set Signals on Signals to Hacc's whole tape" })
  expect(planView({ action: "signals", mine: true, pattern: "deployer" }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", code: "MCP_VALIDATION" })
  expect(planView({ action: "signals", pattern: "whales" }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", code: "MCP_VALIDATION" })
  expect(planView({ action: "signals" }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", text: "Say what Signals shows: mine, pattern, chain or paused." })
  expect(planView({ action: "signals", pattern: "deployer" }, ctx({ file: EVERY }))).toMatchObject({ kind: "signals", tab: "Signals", at: 3 })
  const renamed = parseLayouts('tabs = [{ name = "Trade", layout = "Agent-first" }, { name = "Desk", layout = "Cockpit" }, { name = "Tape", layout = "Signals" }]\n')
  expect(planView({ action: "signals", pattern: "deployer" }, ctx({ file: renamed }))).toMatchObject({ kind: "signals", tab: "Desk", at: 1 })
  expect(planView({ action: "signals", pattern: "deployer", tab: "Trade" }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", text: "Trade has no signals pane (Cockpit and Signals have one)." })
})

test("journal puts a search in the Journal, switching to its tab; the agent is told it doesn't see the rows", () => {
  const found = planView({ action: "journal", search: "  JUP   sell " }, ctx({ file: EVERY }))
  expect(found).toMatchObject({ kind: "journal", at: 6, search: { query: "JUP sell" }, words: 'searched the Journal for "JUP sell"' })
  expect((found as { text: string }).text).toContain("You don't see them")
  expect(planView({ action: "journal", search: "JUP", kinds: ["trades"] }, ctx({ file: EVERY, tab: 6 }))).toEqual(expect.objectContaining({ kind: "journal", search: { query: "JUP", kinds: ["trades"] }, words: 'searched the Journal for "JUP", trades only' }))
  expect(planView({ action: "journal", search: "", kinds: ["trades"] }, ctx({ file: EVERY })).kind).toBe("journal")
  expect(planView({ action: "journal", kinds: ["coins"] }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused", code: "MCP_VALIDATION" })
  expect(planView({ action: "journal", search: "x".repeat(101) }, ctx({ file: EVERY }))).toMatchObject({ kind: "refused" })
  expect(planView({ action: "journal", search: "JUP" }, ctx())).toMatchObject({ kind: "refused", text: expect.stringContaining("Journal has one but is ticked off") })
})

test("read says the tabs ticked off, what Signals shows and the Journal's search", () => {
  const text = (planView({ action: "read" }, ctx({ file: EVERY, signals: [{ at: "Signals", pattern: "kol_mention" }], signalsPaused: true, journal: { query: "JUP" } })) as { text: string }).text
  expect(text).toContain("Signals shows: Cockpit, Hacc's whole tape; Signals, only mention signals (kol_mention) from Hacc's tape (paused).")
  expect(text).toContain('The Journal\'s search: "JUP".')
  expect(text).not.toContain("Ticked off")
  expect((planView({ action: "read" }, ctx()) as { text: string }).text).toContain("Ticked off the tab bar (show_tab shows one): Trending, Signals, P&L, Research, Journal, Perps, Bots, Build.")
})

test("while you were away: the agent opens the Away pane as a preview; no tab has it to switch to", () => {
  const opened = planView({ action: "open", pane: "away", near: "agent" }, ctx())
  expect(opened).toMatchObject({ kind: "preview", tab: "Trade", words: "previewed a layout on Trade: away opened beside agent" })
  if (opened.kind !== "preview") throw new Error()
  expect(panesOf(opened.layout.root)).toEqual(["agent", "away", "token", "positions", "wallets", "activity"])
  expect(planView({ action: "tab", pane: "away" }, ctx())).toMatchObject({ kind: "refused", text: expect.stringContaining("open puts one on a tab's layout") })
})

test("chain: every pane shows one chain, or all of them, at once; with one chain in use there's nothing to filter", () => {
  const both = { current: null, chains: ["solana", "hood"] } as const
  expect(planView({ action: "chain", chain: "hood" }, ctx({ chain: both }))).toMatchObject({ kind: "chain", chain: "hood", words: "showed Hood only in every pane" })
  expect(planView({ action: "chain", chain: "all" }, ctx({ chain: { current: "hood", chains: ["solana", "hood"] } }))).toMatchObject({ kind: "chain", chain: null, words: "showed all chains in every pane" })
  expect((planView({ action: "chain", chain: "hood" }, ctx({ chain: both })) as { text: string }).text).toContain("Every pane shows Hood only")
  expect(planView({ action: "chain", chain: "base" }, ctx({ chain: both }))).toMatchObject({ kind: "refused", code: "MCP_VALIDATION" })
  expect(planView({ action: "chain", chain: "hood" }, ctx({ chain: { current: null, chains: ["solana"] } }))).toMatchObject({ kind: "refused", code: "ONE_CHAIN" })
  // The read says what's shown.
  expect((planView({ action: "read" }, ctx({ chain: { current: "hood", chains: ["solana", "hood"] } })) as { text: string }).text).toContain("Every pane shows Hood only.")
})
