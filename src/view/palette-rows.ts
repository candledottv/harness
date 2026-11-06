// The palette's rows: the Candle Harness's own actions with their keys, the tabs, the layouts, the panes, the agents, each
// agent's preset and memory, the model picker, the tokens seen this session, the aliases, the themes, then every
// Candle CLI command as the commands pane listed them. Typing searches them all together; a section whose name a
// word starts ("pre", "mem", "tok") comes first, so the preset and the memory are one step. A row that can't run
// here says why.
//
// Picking a row does what its key or click does; a Candle command only puts its request on the input
// line, as the commands pane did, and approving a card is never a row's to do (keymap.ts).
import { type CatalogueEntry, searchCatalogue } from "../core/cli-catalogue"
import { type Preset, PRESET_DESCRIPTIONS, PRESET_LABELS, PRESETS } from "../engine/preset"
import { chordOf, KEYMAP, type KeyId } from "./keymap"
import { PANES } from "./panes/registry"
import { panesOf, PANE_IDS, type PaneId } from "./layout"
import type { SkillFolder } from "../core/skill-folders"
import type { LayoutOp } from "./layout-edit"
import type { LayoutInfo } from "./layout-menu"
import { BUILT_IN_NAMES, CANDLE_DARK, CANDLE_LIGHT, TERMINAL } from "./theme"
import type { PnlWindow } from "../core/pnl"
import { pnlWindowRows } from "./panes/pnl"
import { LIST_SOURCE_NAMES, LIST_SOURCES, type ListSource } from "./panes/registry"
import type { AwayView } from "../core/away"
import { gapLength } from "./panes/away"
import { shortAddress } from "./format"

/** What picking a row does. */
export type PaletteRun =
  | { kind: "key"; id: KeyId }
  | { kind: "mode"; mode: "paper" | "live" }
  | { kind: "resume" }
  | { kind: "tab"; tab: number }
  | { kind: "layout"; op: LayoutOp }
  /** The layout menu, or straight to its "save as" name. */
  | { kind: "layoutMenu"; naming?: true }
  | { kind: "focus"; pane: PaneId }
  | { kind: "pin"; on: boolean }
  | { kind: "agent"; agent: string }
  | { kind: "preset"; agent: string; preset: Preset }
  | { kind: "picker" }
  | { kind: "memory"; agent: string }
  /** A skill folder of the person's own, turned on or off. */
  | { kind: "skillsFolder"; folder: string; on: boolean }
  | { kind: "link"; mint: string; chain?: "solana" | "hood" }
  | { kind: "cli"; path: string }
  /** An alias's name on the input line. */
  | { kind: "fill"; text: string }
  | { kind: "reloadAliases" }
  /** Move a pane into a split of its own. */
  | { kind: "popOut"; pane: PaneId }
  /** Draw in another theme, kept for next time. */
  | { kind: "theme"; name: string }
  /** Signals: its pattern or chain menu, a change to its choice, or its pause. */
  | { kind: "signalsMenu"; which: "pattern" | "chain" }
  | { kind: "signals"; change: { mine?: boolean; pattern?: null; chain?: null } }
  | { kind: "pauseSignals"; on: boolean }
  /** The P&L window: one picked, or its menu. */
  | { kind: "pnlWindow"; window: PnlWindow }
  | { kind: "pnlMenu" }
  /** The Journal's search line, taking keys. */
  | { kind: "journalSearch" }
  /** What Research's list pane shows: its ◂ ▸ chips' choice, by keys. */
  | { kind: "lists"; source: ListSource }
  /** The approvals menu: which wallets trade inside limits. */
  | { kind: "approvals" }
  /** While you were away: over the frame, as the note's show all. */
  | { kind: "away" }
  /** Wallet groups: the overlay of every wallet to name several, the Wallets pane's search, and its group menu. */
  | { kind: "everyWallet" }
  | { kind: "walletsFind" }
  | { kind: "walletsMenu" }
  /** The tour: onboarding's step 4, again. */
  | { kind: "tour" }

export interface PaletteRow {
  /** Stable across redraws: what a click names. */
  id: string
  section: string
  label: string
  /** What it does, dim after the label. */
  words: string
  /** Its key, from the keymap table, or how else it's reached. */
  key?: string
  /** It's what's on now: the tab shown, the active agent, the agent's preset, the linked token. */
  current?: true
  run?: PaletteRun
  /** Why it can't run here; such a row says so and does nothing. */
  why?: string
  /** A Candle command, drawn with its rule and when. */
  cli?: CatalogueEntry
  /** More words a search finds it by. */
  search?: string
}

/** What the rows need from the view: built by the reducer from its state and context. */
export interface PaletteInput {
  tabs: readonly string[]
  tab: number
  /** Every tab, shown or ticked off: a row to show or hide each. */
  tabTicks?: readonly { name: string; shown: boolean }[]
  layout?: LayoutInfo
  /** The pane focused before the palette opened: where a pane opens beside. */
  focus?: PaneId
  agents: readonly string[]
  activeAgent?: string
  /** Each agent's preset, as the core says. */
  presets: Readonly<Record<string, Preset | undefined>>
  /** Token names seen this session, upper-cased, to their mints. */
  tokens: ReadonlyMap<string, string>
  /** The linked token's mint. */
  linked?: string
  /** The tab's token pane and whether it's pinned; undefined when the tab has none. */
  pin?: { pinned: boolean; symbol?: string }
  mode?: "paper" | "live"
  paused: boolean
  /** A card Enter would approve, ctrl-n reject and ctrl-o open. */
  card: boolean
  requotable: boolean
  /** The active agent has a turn running or waiting. */
  working: boolean
  /** A refusal offers to ask the agent. */
  ask: boolean
  /** config.toml's aliases, checked, and how many it sets that were left out. */
  aliases: ReadonlyMap<string, string>
  aliasProblems: number
  /** The panes popped out into views of their own. */
  popped: readonly PaneId[]
  /** Every theme by name, the one on screen, and where yours go. */
  themes?: { names: readonly string[]; current: string; dir: string }
  /** This tab's Signals choice, and whether its pane is paused. */
  signals?: { mine?: boolean; pattern?: string; chain?: string; paused: boolean }
  /** The P&L window the core keeps; unset, its default. */
  pnlWindow?: PnlWindow
  /** What the list pane shows, where one is on the tab. */
  lists?: ListSource
  /** While you were away: the last gap's summary, for its row's words. */
  away?: AwayView
  /** The wallet groups by name, and whether the tab shows the Wallets pane. */
  walletGroups?: readonly string[]
  walletsOnTab?: boolean
  /** The person's skill folders, as the core read them. */
  skillFolders?: readonly SkillFolder[]
}

/** Base assets: a swap's, never a link (the core refuses them, BASE_ASSET). */
const BASE = new Set(["SOL", "USDC", "CNDL", "ETH", "USDG"])

/** The sections in order, and the words that bring each to the top when a search word starts one. */
export const SECTIONS = [
  { name: "Actions", words: ["actions", "keys"] },
  { name: "Tabs", words: ["tabs"] },
  { name: "Layouts", words: ["layouts"] },
  { name: "Panes", words: ["panes"] },
  { name: "Agents", words: ["agents"] },
  { name: "Presets", words: ["presets", "prompts"] },
  { name: "Model", words: ["model", "engines"] },
  { name: "Memory", words: ["memory"] },
  { name: "Skills", words: ["skills"] },
  { name: "P&L", words: ["p&l", "pnl", "profit"] },
  { name: "Journal", words: ["journal", "history"] },
  { name: "Tokens", words: ["tokens", "link"] },
  { name: "Aliases", words: ["aliases", "chains"] },
  { name: "Themes", words: ["themes", "colours", "colors"] },
] as const

/** What each built-in theme is, after its name. */
const THEME_WORDS: Readonly<Record<string, string>> = {
  [CANDLE_DARK]: "the look as designed: dark panes, a mint focus border",
  [CANDLE_LIGHT]: "the same colours for the same jobs, on white",
  [TERMINAL]: "your terminal's own background and colours, made readable where they're faint",
}

/** A Candle command's section: its CLI help group. */
export const cliSection = (group: string) => `candle · ${group}`

const keyRow = (id: KeyId, extra: Partial<PaletteRow>): PaletteRow => {
  const def = KEYMAP.find((d) => d.id === id)!
  return { id: `key:${id}`, section: "Actions", label: def.palette!.label, words: def.words, key: def.chord, ...(def.palette!.why ? { why: def.palette!.why } : { run: { kind: "key", id } }), ...extra }
}

/** Why an action's key does nothing here, if it doesn't. */
function actionWhy(id: KeyId, p: PaletteInput): string | undefined {
  if ((id === "reject" || id === "details") && !p.card) return "no card is waiting"
  if (id === "requote" && !p.requotable) return "no card has expired"
  if (id === "stop" && !p.working) return `${p.activeAgent ?? "the agent"} has no turn running`
  if (id === "ask" && !p.ask) return "on a highlighted row (↑/↓ in a list), or after a typed trade is refused for a token nobody has shown"
  return undefined
}

function harnessRows(p: PaletteInput): PaletteRow[] {
  const rows: PaletteRow[] = []
  const agent = p.activeAgent

  // Actions: the table's rows, in its order, then the modes and resume, which are typed words. The two a
  // pick can never do (approve, quit) go last, so the palette doesn't open on a row that says "can't".
  const keyed = KEYMAP.filter((d) => d.palette)
  for (const def of [...keyed.filter((d) => !d.palette!.why), ...keyed.filter((d) => d.palette!.why)]) {
    const why = def.palette!.why ? undefined : actionWhy(def.id, p)
    rows.push(keyRow(def.id, why ? { why, run: undefined } : {}))
  }
  rows.push({ id: "tour", section: "Actions", label: "the tour", words: "a minute on this screen: your agent, positions, a card, the kill switch, settings ▾ and the palette", key: "setup's step 4", run: { kind: "tour" }, search: "tour help start new onboarding walkthrough guide learn" })
  rows.push({ id: "mode:paper", section: "Actions", label: "paper mode", words: "trades are recorded at the quoted price, never sent", key: "type paper", ...(p.mode === "paper" ? { current: true, why: "already in paper mode" } : { run: { kind: "mode", mode: "paper" } }) })
  rows.push({ id: "mode:live", section: "Actions", label: "live mode", words: "trades move real funds, through one-press cards; it asks first", key: "type live", ...(p.mode === "live" ? { current: true, why: "already in live mode" } : { run: { kind: "mode", mode: "live" } }) })
  rows.push({ id: "resume", section: "Actions", label: "resume buys", words: "after the kill switch", key: "type resume", ...(p.paused ? { run: { kind: "resume" } } : { why: "the kill switch is off" }) })

  p.tabs.forEach((name, i) => {
    rows.push({ id: `tab:${i}`, section: "Tabs", label: name, words: i === p.tab ? "showing" : "show this tab", key: i < 9 ? `${i + 1} on the tab bar` : undefined, ...(i === p.tab ? { current: true } : {}), run: { kind: "tab", tab: i } })
  })
  // Tabs are a setting: each ticked on or off, as in settings ▾.
  for (const t of p.tabTicks ?? []) {
    rows.push({
      id: `tick:${t.name}`,
      section: "Tabs",
      label: t.shown ? `hide the ${t.name} tab` : `show the ${t.name} tab`,
      words: t.shown ? "off the tab bar; its layout is kept for when it's back" : "back on the tab bar, with its layout",
      key: "settings ▾",
      run: { kind: "layout", op: { kind: "tabShown", name: t.name, shown: !t.shown } },
      search: "tabs tick show hide setting",
    })
  }

  if (p.layout) {
    const info = p.layout
    for (const name of info.names) {
      const on = name === info.current.name
      rows.push({ id: `layout:${name}`, section: "Layouts", label: name, words: on ? `${info.tab} shows it` : `show it on ${info.tab}`, ...(on ? { current: true } : {}), run: { kind: "layout", op: { kind: "show", name } } })
    }
    rows.push({ id: "layout:menu", section: "Layouts", label: "edit this layout…", words: "move, resize, open or close a pane", key: "the tab bar's settings ▾", run: { kind: "layoutMenu" }, search: "move resize wider narrower taller shorter close" })
    rows.push({ id: "layout:saveAs", section: "Layouts", label: "save this layout as…", words: "a layout of yours, in layouts.toml", run: { kind: "layoutMenu", naming: true } })
    rows.push({ id: "layout:reload", section: "Layouts", label: "reload layouts.toml", words: "after a hand edit", run: { kind: "layout", op: { kind: "reload" } } })

    const all = panesOf(info.current.root)
    const on = all.filter((x) => !p.popped.includes(x))
    for (const pane of on) rows.push({ id: `focus:${pane}`, section: "Panes", label: `focus ${pane}`, words: "keys go to it", key: "tab · arrows · a click", run: { kind: "focus", pane } })
    // Pop-out: each pane here that can move into a split of its own, and each that has.
    for (const pane of on.filter((x) => PANES[x].pops)) {
      rows.push({ id: `pop:${pane}`, section: "Panes", label: `pop out ${pane}`, words: "into a tmux or cmux split of its own; back when you close it there", key: p.focus === pane ? chordOf("popOut") : `${chordOf("popOut")} on it · its ⇱`, run: { kind: "popOut", pane }, search: "popout split window detach move" })
    }
    for (const pane of p.popped) rows.push({ id: `pop:${pane}`, section: "Panes", label: `${pane} is popped out`, words: "in a view of its own", why: "close that view (ctrl-c twice there) and it comes back here", search: "popout split window" })
    const near = p.focus && on.includes(p.focus) ? p.focus : undefined
    for (const pane of PANE_IDS.filter((x) => !all.includes(x))) {
      rows.push({ id: `open:${pane}`, section: "Panes", label: `open ${pane}`, words: near ? `beside ${near}, on ${info.tab}` : `on ${info.tab}`, run: { kind: "layout", op: { kind: "open", pane, ...(near ? { near } : {}) } } })
    }
    // Signals: its chips' and its pause's rows, so a pane too narrow for its chips (the Cockpit's) reaches them too.
    if (on.includes("signals")) {
      const sg = p.signals ?? { paused: false }
      const search = "signals tape filter pattern chain hacc"
      rows.push(
        sg.paused
          ? { id: "signals:resume", section: "Panes", label: "resume Signals", words: "back to the newest, as it arrives", key: "its resume chip", run: { kind: "pauseSignals", on: false }, search }
          : { id: "signals:pause", section: "Panes", label: "pause Signals", words: "hold the tape where it is, counting what arrives", key: "its pause chip", run: { kind: "pauseSignals", on: true }, search },
      )
      rows.push({ id: "signals:source", section: "Panes", label: sg.mine ? "Signals: Hacc's tape" : "Signals: your rules' signals", words: sg.mine ? "every tracked wallet's signals" : "only what your own rules on Hacc fired", key: "its all ▾ chip", run: { kind: "signals", change: { mine: !sg.mine } }, search })
      if (!sg.mine) {
        rows.push({ id: "signals:pattern", section: "Panes", label: "filter Signals by pattern…", words: sg.pattern ? `now ${sg.pattern.replace(/_/g, " ")}` : "one pattern, such as a wallet waking", key: "its pattern ▾ chip", run: { kind: "signalsMenu", which: "pattern" }, search })
        rows.push({ id: "signals:chain", section: "Panes", label: "filter Signals by chain…", words: sg.chain ? `now ${sg.chain === "hood" ? "Hood" : "Solana"}` : "Solana or Hood", key: "its chain ▾ chip", run: { kind: "signalsMenu", which: "chain" }, search })
        if (sg.pattern || sg.chain) rows.push({ id: "signals:clear", section: "Panes", label: "clear Signals' filters", words: "the whole tape again", run: { kind: "signals", change: { pattern: null, chain: null } }, search })
      }
    }
    if (!on.includes("token")) rows.push({ id: "pin", section: "Panes", label: "pin the token pane", words: "hold it on its token while the link moves on", why: `${info.tab} has no token pane` })
  }
  if (p.pin) {
    const what = p.pin.symbol ?? "its token"
    rows.push(
      p.pin.pinned
        ? { id: "pin", section: "Panes", label: "unpin the token pane", words: "it follows the link again", key: "its unpin chip", run: { kind: "pin", on: false } }
        : { id: "pin", section: "Panes", label: "pin the token pane", words: `hold it on ${what} while the link moves on`, key: "its pin chip", ...(p.pin.symbol ? { run: { kind: "pin", on: true } } : { why: "it shows no token yet" }) },
    )
  }

  // Agents, the active one first.
  const agents = agent && p.agents.includes(agent) ? [agent, ...p.agents.filter((a) => a !== agent)] : [...p.agents]
  for (const a of agents) rows.push({ id: `agent:${a}`, section: "Agents", label: a, words: a === agent ? "the active agent" : "make it the active agent", key: "the status bar's agent ▾", ...(a === agent ? { current: true } : { run: { kind: "agent", agent: a } }) })
  for (const a of agents) {
    for (const preset of PRESETS) {
      const on = p.presets[a] === preset
      rows.push({ id: `preset:${a}:${preset}`, section: "Presets", label: `${PRESET_LABELS[preset]} for ${a}`, words: PRESET_DESCRIPTIONS[preset], key: chordOf("picker"), ...(on ? { current: true, why: `${a} runs as ${PRESET_LABELS[preset]}` } : { run: { kind: "preset", agent: a, preset } }), search: "preset prompt" })
    }
  }
  // Naming a wallet: the line to finish, as the Wallets pane's name chip types it.
  rows.push({ id: "wallets:name", section: "Agents", label: "name a wallet", words: "name <wallet> <new name>: the Candle Harness's own names at once; a TEE wallet's on Candle and a vault key's in the vault, in the pane", key: "the Wallets pane's name chip", run: { kind: "fill", text: "name " }, search: "rename label wallet tee vault embedded call" })
  // Wallet groups: naming several, the Wallets pane's search and group menu, and making one.
  rows.push({ id: "wallets:several", section: "Agents", label: "name several wallets", words: "pick several wallets and name them as a batch, by a new start or each typed", run: { kind: "everyWallet" }, search: "rename batch many wallets every all group tee label" })
  rows.push({ id: "wallets:group", section: "Agents", label: "make a wallet group", words: "group <name> add <wallet>, or group <name> prefix bot- for every wallet whose name starts bot-", key: "group …", run: { kind: "fill", text: "group " }, search: "group groups wallets prefix organise bots" })
  rows.push({ id: "wallets:find", section: "Panes", label: "find a wallet", words: "a search line over the Wallets pane, across every group", key: "its ⌕ find chip", ...(p.walletsOnTab ? { run: { kind: "walletsFind" } } : { why: "this tab has no Wallets pane" }), search: "search wallet wallets find group" })
  if (p.walletGroups?.length) rows.push({ id: "wallets:groups", section: "Panes", label: "show one wallet group…", words: `the Wallets pane shows one of ${p.walletGroups.join(", ")}, or every group`, key: "its all groups ▾ chip", run: { kind: "walletsMenu" }, search: "group groups wallets show filter" })
  rows.push({ id: "approvals", section: "Agents", label: "approvals: trading inside limits", words: "which wallets trade inside limits without a card, and every limit with who holds it", key: "settings ▾ · approvals", run: { kind: "approvals" }, search: "autonomy hands off limits without a card wallet figure caps candle" })
  rows.push({ id: "model", section: "Model", label: agent ? `${agent}'s engine and model` : "the agent's engine and model", words: "Claude Code, Codex, Grok, OpenCode or Pi, from its next turn", key: `${chordOf("picker")} · its chip`, ...(agent ? { run: { kind: "picker" } } : { why: "the core hasn't said which agent is active" }), search: "engine harness switch claude codex grok opencode pi openrouter ollama" })
  // The P&L window: each choice, the one on marked; a time of your own goes through the menu.
  for (const r of pnlWindowRows(p.pnlWindow)) {
    const search = "pnl profit loss window today since midnight session"
    if (!r.value) rows.push({ id: "pnl:menu", section: "P&L", label: "P&L window: since another time…", words: r.words, key: "the P&L pane's 24h ▾ · settings ▾", run: { kind: "pnlMenu" }, search })
    else rows.push({ id: `pnl:${r.value}`, section: "P&L", label: `P&L window: ${r.label}`, words: r.words, ...(r.on ? { current: true, why: "it's the window now" } : { run: { kind: "pnlWindow", window: r.value } }), search })
  }
  // Research's list pane: each source, by keys, where one is on the tab.
  if (p.lists) for (const s of LIST_SOURCES) rows.push({ id: `lists:${s}`, section: "Lists", label: `pick from ${LIST_SOURCE_NAMES[s]}`, words: s === "signals" ? "Hacc's tape, in the list pane" : "Candle's list, in the list pane", key: "the list pane's ◂ ▸", ...(p.lists === s ? { current: true, why: "the list pane shows it" } : { run: { kind: "lists", source: s } }), search: "list research pick trending new graduated final stretch on fire signals" })
  // While you were away: every section over the frame, as the note's show all.
  const s = p.away?.summary
  const awayWords = s ? (s.happened ? `the last gap, ${gapLength(s.to - s.from)}: what ran, filled, waited and was stopped` : `nothing happened in the last gap, ${gapLength(s.to - s.from)}`) : p.away?.firstRun ? "fills once the Candle Harness has been closed and opened again" : "the last gap's summary"
  rows.push({ id: "away", section: "Journal", label: "while you were away", words: awayWords, key: "the note's show all", run: { kind: "away" }, search: "away gap since last session missed happened summary closed" })
  rows.push({ id: "journal:search", section: "Journal", label: "search the journal", words: "everything recorded, in words: type into its search line", key: "↑ in the Journal · its search chip", run: { kind: "journalSearch" }, search: "journal history log record search find what happened" })
  // Each skill folder of the person's own, read by the core alone when it's on.
  for (const f of p.skillFolders ?? []) {
    const n = `${f.count} skill${f.count === 1 ? "" : "s"}`
    const words = f.on ? `on: the agents read its ${n}; ⏎ turns it off` : f.exists ? `off: ${n} there; ⏎ turns it on, for every agent` : "not on this machine"
    rows.push({ id: `skills:${f.shown}`, section: "Skills", label: `${f.label} · ${f.shown}`, words, ...(f.on ? { current: true as const } : {}), ...(f.exists || f.on ? { run: { kind: "skillsFolder" as const, folder: f.shown, on: !f.on } } : { why: `there's no ${f.shown} here` }), search: "skills claude code codex agents opencode pi own" })
  }
  for (const a of agents) rows.push({ id: `memory:${a}`, section: "Memory", label: `${a}'s memory`, words: "its index and the files beside it; delete any of it", key: a === agent ? "settings ▾ · memory" : undefined, run: { kind: "memory", agent: a }, search: "remember notes forget index lessons clear" })

  for (const [name, mint] of p.tokens) {
    if (BASE.has(name)) continue
    const on = mint === p.linked
    rows.push({ id: `token:${mint}`, section: "Tokens", label: name, words: on ? "linked: the token pane follows it" : "link it: the token pane follows it", key: "a click on its row", ...(on ? { current: true } : {}), run: { kind: "link", mint, ...(mint.startsWith("0x") ? { chain: "hood" as const } : {}) } })
  }

  // Aliases: each puts its name on the input line, for the rest to be typed after it.
  for (const [name, value] of p.aliases) rows.push({ id: `alias:${name}`, section: "Aliases", label: name, words: `→ ${value}`, key: "type it", run: { kind: "fill", text: `${name} ` }, search: "alias chain" })
  if (p.aliases.size === 0) rows.push({ id: "alias:none", section: "Aliases", label: "no aliases yet", words: "add an [aliases] table to config.toml, such as b5 = \"buy $5 of\"", why: "config.toml sets none", search: "alias chain" })
  const left = p.aliasProblems > 0 ? `; ${p.aliasProblems} left out (the doctor says why)` : ""
  // Its label leaves "alias" out, so a search for it leads with the aliases themselves.
  rows.push({ id: "alias:reload", section: "Aliases", label: "read config.toml again", words: `for its aliases, after an edit${left}`, run: { kind: "reloadAliases" }, search: "reload alias chain" })

  // Themes: each draws at once and is kept for next time. Yours is read from its file each time it's picked.
  if (p.themes) {
    const { names, current, dir } = p.themes
    for (const name of names) {
      const own = !BUILT_IN_NAMES.includes(name)
      const on = name === current
      const words = own ? (on ? "on screen; pick it again to read its file after an edit" : `yours, in themes/${name}.toml`) : THEME_WORDS[name]!
      rows.push({ id: `theme:${name}`, section: "Themes", label: name, words, ...(on ? { current: true } : {}), ...(on && !own ? { why: "it's on screen" } : { run: { kind: "theme", name } }), search: "theme colours colors dark light" })
    }
    if (names.every((n) => BUILT_IN_NAMES.includes(n))) rows.push({ id: "theme:none", section: "Themes", label: "a theme of your own", words: `a .toml file in ${dir}, naming the colours it changes (docs.candle.tv/harness/make-it-yours)`, why: "there's none yet", search: "theme colours colors" })
  }
  return rows
}

const cliRow = (e: CatalogueEntry): PaletteRow => ({
  id: `cli:${e.path}`,
  section: cliSection(e.group),
  label: e.path,
  words: e.description,
  cli: e,
  ...(e.request ? { run: { kind: "cli", path: e.path } } : { why: e.note ?? "not something the agent runs" }),
})

const SECTION_ORDER: readonly string[] = SECTIONS.map((s) => s.name)

/** A Solana mint, or a Robinhood Chain (EVM) token address. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * A pasted address: the one row, opening it in the token pane. The core links it only where Candle has a
 * market for it, and says so otherwise; nothing trades.
 */
function addressRow(query: string, p: PaletteInput): PaletteRow | undefined {
  const mint = query.trim()
  const hood = EVM_ADDRESS.test(mint)
  if (!hood && !SOLANA_ADDRESS.test(mint)) return undefined
  const name = [...p.tokens].find(([, m]) => m === mint)?.[0]
  const on = mint === p.linked
  return {
    id: `open:${mint}`,
    section: "Tokens",
    label: `open ${name ? `${name} · ` : ""}${shortAddress(mint)}`,
    words: on ? "linked: the token pane follows it" : "in the token pane, if Candle has a market for it",
    ...(on ? { current: true as const } : {}),
    run: { kind: "link", mint, ...(hood ? { chain: "hood" as const } : {}) },
  }
}

/**
 * The rows for a search, in sections: the Candle Harness's own (a section whose name a word starts first), then
 * Candle's commands as the catalogue finds them.
 */
export function paletteRows(p: PaletteInput, query: string): PaletteRow[] {
  const pasted = addressRow(query, p)
  if (pasted) return [pasted]
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const found = harnessRows(p).filter((r) => words.every((w) => `${r.section} ${r.label} ${r.words} ${r.key ?? ""} ${r.search ?? ""}`.toLowerCase().includes(w)))
  const named = (section: string) => {
    const s = SECTIONS.find((x) => x.name === section)
    return !!s && words.some((w) => s.words.some((x) => x.startsWith(w)))
  }
  // Within that, a row whose label holds every word comes first, and so does its section: "trader for
  // momentum" is Trader's row, not Quant's, whose words say "as well as a trader".
  const inLabel = (r: PaletteRow) => words.length > 0 && words.every((w) => r.label.toLowerCase().includes(w))
  const hit = new Set(found.filter(inLabel).map((r) => r.section))
  const rank = (section: string) => (named(section) ? 0 : hit.has(section) ? 1 : 2) * SECTION_ORDER.length + SECTION_ORDER.indexOf(section)
  const own = [...found].sort((a, b) => rank(a.section) - rank(b.section) || Number(inLabel(b)) - Number(inLabel(a)))
  return [...own, ...searchCatalogue(query).map(cliRow)]
}

/** Every row there is, for the count beside the search. */
export const allRowCount = (p: PaletteInput): number => paletteRows(p, "").length
