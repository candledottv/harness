// Every key and click goes through one pure step (handlers that close over React state see
// stale values when keys arrive faster than renders). It returns the next state and the effects to
// run; the frame runs them against the core. The rules that keep a stray key from trading:
//   - Enter approves the focused card only with the input line empty, and only once that card has
//     been on screen for 300 ms. With text on the line, Enter sends the line.
//   - ctrl-x pressed twice within a second is the kill switch; any other key between
//     the two cancels it. Typing `kill`, or clicking the status bar's kill, is one action.
//   - ctrl-c clears a line with text on it; on an empty line, twice within a second quits.
//   - Switching to live asks once; switching to paper doesn't.
//   - Every chord is matched through keymap.ts's table, which help, the palette and the hint line read too.
//     ctrl-k, from anywhere, opens the palette: every action, tab,
//     layout, pane, agent, preset, token and Candle command. Picking a row does what its key or click
//     does; a Candle command only puts a request on the input line (`?` then `c` opens the palette there),
//     and no row approves a card.
//   - ctrl-f, from anywhere, narrows positions, wallets and activity to the active agent and back;
//     so do the agent menu's last row and the panes' border labels. Never a bare letter:
//     typing always goes to the input line.
//   - ctrl-t, or the chip on the refusal, sends a line refused for an unknown token name to the agent
//     as typed, to find the token. Otherwise, on a highlighted token row, ctrl-t
//     or the row's `ask` chip picks it at once, as a click does, and puts a question about it on the input
//     line in the row's own words, for Enter to send. Nothing is sent by the key.
//   - A card's other actions are chords from anywhere, each also a click on the card:
//     ctrl-n rejects the highlighted card, ctrl-o opens its details, ctrl-r re-quotes the newest
//     expired one. A bare `r` would type into the line and become an agent turn.
//   - ctrl-g, from anywhere, or the agent pane's chip, opens the model picker for the agent in view;
//     Enter or a click picks from its next turn, and Esc leaves it as it was. A message
//     to an agent whose engine can't run until a model is picked opens the picker and stays on the line.
//   - ↑/↓ in a pane with token rows (Positions, Feed, Signals, Activity, the trending list) move its
//     highlight, and the highlighted row's token is the link once the highlight has rested 300 ms (each
//     link reads the market, the check and Hacc's history). A click on a row picks at once,
//     and so does a click on a card. Enter never picks: with the line empty it approves the card.
//   - The Journal's search line takes keys only while it's focused: ↑ from the Journal's
//     first row, or its chip. Then typing searches, ⏎ keeps the search and gives ↑/↓ back to the rows, and
//     Esc gives the keys back to the input line. Enter there never approves. ↓ past the last row reads the
//     next page; ctrl-o on a row shows its rows as recorded.
import type { MemoryRow } from "./panes/memory"
import type { EngineId } from "../engine/engine"
import { type Command, type CommandContext, parseCommand } from "./commands"
import { type KeyId, keyLines, pressed } from "./keymap"
import { AGENT_FIRST, beside, type Direction, type PaneId, type PaneNav, paneNav, panesOf, place, shownOf } from "./layout"
import { type LayoutOp, nameProblem, tabNameProblem } from "./layout-edit"
import { type LayoutInfo, layoutMenuRows } from "./layout-menu"
import { DEFAULT_TABS } from "./layouts-file"
import { type PickableRow, type PickerRow, pickable, startIndex } from "./panes/engines"
import type { Preset } from "../engine/preset"
import { type PaletteInput, type PaletteRow, paletteRows } from "./palette-rows"
import type { AwayView } from "../core/away"
import type { RowPick } from "./panes/lines"
import { type ListSource, nextListSource, PANES } from "./panes/registry"
import { type SignalsChipId, signalsMenuRows, type SignalsPick } from "./panes/signals"
import { type PnlSpan, pnlWindowRows, pnlWindowWords } from "./panes/pnl"
import { parseWindow } from "../core/pnl"
import { type JournalSearch, toggleKind } from "./panes/journal"
import { type WalletsFind, walletsMenuRows } from "./panes/wallets"
import { groupOfRow } from "./wallet-list"
import { type EveryWalletState, everyRows, namingAsks, namingRows, sharedStart, togglePick } from "./every-wallet"
import type { PortfolioView } from "../core/portfolio-view"
import { viewName } from "../core/portfolio-view"
import type { WalletNameEntry } from "../core/wallet-names"
import type { WalletGroup } from "../core/wallet-groups"
import type { WalletsShown } from "../core/wallets-shown"
import type { JournalKind } from "../core/journal-query"
import type { SkillFolder } from "../core/skill-folders"
import type { PnlWindow } from "../core/pnl"
import { CATALOGUE } from "../core/cli-catalogue"
import { HELP_LINES } from "./commands"
import type { ViewCard } from "./store"
import type { AutonomyTopic } from "../core/autonomy"
import { type AgentLimits, type ApprovalsRow, type ApprovalsState, approvalsEntries, detailRows, parseFigure, pickedWallet, walletWords } from "./approvals"
import { money } from "./theme"
import { TOUR_STOPS } from "./tour-stops"

export const KILL_WINDOW_MS = 1_000
export const QUIT_WINDOW_MS = 1_000
export const APPROVE_AFTER_MS = 300
/** How long a row's highlight rests before its token is the link. */
export const LINK_SETTLE_MS = 300
export const MESSAGE_MS = 6_000
/** An error stays longer: an over-limit refusal was gone before it was read. */
export const ERROR_MESSAGE_MS = 20_000

/** Where keys go: the tab bar, the cards waiting (inline in the agent pane), or a pane of the layout by its id. */
export type Focus = "tabs" | "cards" | PaneId
export type Overlay =
  /** Help, scrolled `scroll` lines down: at 80×24 it doesn't fit. */
  | { kind: "help"; scroll?: number }
  | { kind: "card"; cardId: string }
  | { kind: "confirmLive" }
  | { kind: "agents"; index: number }
  /** The palette: the search typed so far, and the highlighted row among what it found. */
  | { kind: "palette"; query: string; index: number }
  /** The kill report's longer text: how to stop what the kill switch can't reach. */
  | { kind: "stopHelp" }
  /** The model picker for `agent`: the search typed so far, and the highlighted model among what it found. */
  | { kind: "engines"; agent: string; query: string; index: number; moved?: true }
  /** An agent's memory: its lines and files, each deletable; `confirm` while "clear all" asks. */
  | { kind: "memory"; agent: string; index: number; confirm?: true }
  /** The layout menu: the highlighted row, and the name typed while "save as" asks for one. */
  | { kind: "layouts"; index: number; naming?: string }
  /** The tab bar's settings menu: what's set up once and rarely changed, each opening its own; then each tab's tick. */
  | { kind: "settings"; index: number }
  /** Signals' pattern or chain menu, under its chip at column `x` and row `y` (unset from the palette). */
  | { kind: "signalsMenu"; which: "pattern" | "chain"; index: number; x?: number; y?: number }
  /** The P&L window's menu, under the P&L pane's chip at column `x` and row `y` (unset from settings or the palette). */
  /** `typing`: the time typed on its last row, "since another time…" (filling the input line put it out of sight). */
  | { kind: "pnlMenu"; index: number; x?: number; y?: number; typing?: string }
  /** A Journal row's rows as recorded (ctrl-o on it), scrolled `scroll` lines down. */
  | { kind: "journalRows"; id: string; scroll?: number }
  /** While you were away: the last gap's every section, over the frame, scrolled `scroll` lines down. */
  | { kind: "away"; scroll?: number }
  /** The approvals menu: which wallets trade inside limits, their figures, and every limit with who holds it. */
  | ApprovalsState
  /** The Wallets pane's `all groups ▾` menu, under its chip at column `x` and row `y` (unset from the palette). */
  | { kind: "walletsMenu"; index: number; x?: number; y?: number }
  /** Every wallet, to pick several and name them at once. */
  | EveryWalletState
  /** The tour: the stop lit now, of tour.tsx's six. Onboarding's step 4, or the palette's row again. */
  | { kind: "tour"; step: number }

/** The settings menu's rows: one button, with a submenu for each setting not commonly changed. */
export const SETTINGS = [
  { id: "layout", label: "layout", words: "this tab's panes: open, close, move, resize; and the tabs" },
  { id: "theme", label: "theme", words: "the colours" },
  { id: "model", label: "model", words: "the agent's engine, model and preset" },
  { id: "memory", label: "memory", words: "what the agent remembers" },
  // The person's own skill folders, Claude Code's among them, read by the core when turned on.
  { id: "skills", label: "skills", words: "use your own skills from Claude Code, Codex and others" },
  { id: "aliases", label: "aliases", words: "short names for what you type" },
  { id: "pnl", label: "P&L window", words: "what P&L counts from: 24h, midnight, a time, your last session" },
  { id: "approvals", label: "approvals", words: "which wallets trade inside limits without a card, and every limit" },
  // Onboarding's "set one up later from settings ▾": the vault's commands, each in the pane.
  { id: "vault", label: "vault", words: "set one up: candle vault init goes on the line, and runs in the pane" },
] as const

export interface UiState {
  tab: number
  focus: Focus
  input: string
  cursor: number
  /** The card the user moved to; the newest open card when unset or no longer open. */
  focusedCardId?: string
  /** The panes focused, the latest first: a collapsed group shows the one last focused, and an arrow into several panes goes to it. */
  recent: readonly PaneId[]
  /** How far each pane is scrolled, by its id; absent, at its newest or its first row. */
  scroll: Partial<Record<PaneId, PaneScroll>>
  /** Each pane's highlighted token row: `at` when it moved there, `sent` once its token went to the core as the link. */
  highlight?: Partial<Record<PaneId, Highlight>>
  /** Positions, wallets and activity show every agent, or only the active one (ctrl-f, the agent menu, a pane's label). */
  oneAgent: boolean
  killArmedAt?: number
  quitArmedAt?: number
  /** When Esc was pressed on a typed line: a second within QUIT_WINDOW_MS clears it, as in Claude Code. */
  escArmedAt?: number
  overlay?: Overlay
  /** `ask`: a refused line ctrl-t or the message's chip sends to the agent as typed (an unknown token name). */
  /** `copy`: a command the message offers to copy, with a chip under it (a pop-out with no split to go to). */
  message?: { text: string; level: "info" | "error"; at: number; ask?: string; askLine?: string; copy?: string }
  /** An address shows in full until then, after its ⧉ chip, to select by hand where a copy can't land. */
  shownInFull?: { text: string; until: number }
  /** What the P&L chart spans: this view's, not kept; unset, the P&L window. */
  pnlSpan?: PnlSpan
  /** What Research's list pane shows. */
  lists?: ListSource
  /** The Journal's search: this view's, not kept. */
  journal?: JournalSearch
  /** The Wallets pane's open group, where its highlight last rested, and its search: this view's, not kept. */
  wallets?: { open?: string; find?: WalletsFind }
}

/** How long an address shows in full after its ⧉ chip. */
export const SHOWN_IN_FULL_MS = 20_000

/**
 * How far a pane is scrolled: rows up from its newest, for the conversation and a tail pane (Activity), or
 * down from its first, for a list. `anchor` is a tail pane's newest line when it was scrolled, so lines
 * arriving after it don't move what's in view (a burst of fills under an older line being read).
 */
export interface PaneScroll {
  rows: number
  anchor?: string
  /** Signals' pause: the view holds at its anchor, at the newest or not, until resumed. */
  paused?: true
}

/** What a pane's scroll can reach, as last drawn: the rows past what shows, and a tail pane's newest line and the lines since its anchor. */
export interface ScrollReach {
  max: number
  newest?: string
  since?: number
  /** The window as drawn: its first line, how many it shows, and how many there are (a highlight is kept in view). */
  start?: number
  rows?: number
  total?: number
}

export interface Highlight extends RowPick {
  at: number
  sent?: true
}

/** A pane's token row as last drawn: its pick, and its first line among the pane's lines. */
export interface PickRow extends RowPick {
  line: number
}

export const INITIAL_UI: UiState = { tab: 0, focus: "agent", input: "", cursor: 0, recent: [], scroll: {}, oneAgent: false }

/** Rows a pane is scrolled (up from its newest, or down from its first). */
export const scrollOf = (state: UiState, pane: PaneId): number => state.scroll[pane]?.rows ?? 0

export interface Key {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

export type UiAction =
  | { type: "key"; key: Key; now: number }
  | { type: "paste"; text: string; now: number }
  | { type: "tick"; now: number }
  | { type: "clickTab"; tab: number; now: number }
  /** The tour: opened on onboarding's step 4, on `tab`; its box's chips go on or end it. */
  | { type: "openTour"; tab?: number; now: number }
  | { type: "tourNext"; now: number }
  /** The agent's harness_view switched the tab on screen: focus stays where the person left it. */
  | { type: "showTab"; tab: number; now: number }
  /**
   * The agent's harness_view showed a pane ("what's in final stretch"): where the layout is
   * collapsed, the switched pane shows it, as if last focused; the focus stays where the person left it.
   */
  | { type: "showPane"; pane: PaneId; now: number }
  /** The agent's harness_view put a search in the Journal: the search line doesn't take keys, and the focus stays. */
  | { type: "journalSet"; search: JournalSearch; now: number }
  | { type: "clickCard"; cardId: string; now: number }
  | { type: "clickApprove"; cardId: string; now: number }
  | { type: "clickReject"; cardId: string; now: number }
  | { type: "clickDetails"; cardId: string; now: number }
  | { type: "closeOverlay"; now: number }
  | { type: "clickAgent"; now: number }
  | { type: "pickAgent"; agent: string; now: number }
  | { type: "clickMode"; now: number }
  | { type: "clickKill"; now: number }
  | { type: "clickResume"; now: number }
  | { type: "clickStopHelp"; now: number }
  | { type: "clickCopy"; text: string; now: number; what?: string }
  | { type: "clickOpenToken"; mint: string; now: number }
  /** A chip that puts a line on the input line for the user to send (the kill report's tee disable). */
  | { type: "clickFill"; text: string; now: number }
  | { type: "clickHelp"; now: number }
  /** The refusal's "ask the agent" chip. */
  | { type: "clickAsk"; now: number }
  /** A pane's ⇱ chip: it pops out, as ctrl-p does on it. */
  | { type: "popOutPane"; pane: PaneId; now: number }
  /** A palette row clicked, by its id; the palette's chip on the hint line. */
  | { type: "pickPalette"; id: string; now: number }
  | { type: "clickPalette"; now: number }
  /** A click on a pane, or on a collapsed group's arrows. */
  | { type: "clickPane"; pane: PaneId; now: number }
  /** A click on a token row: it's picked at once. */
  | { type: "clickRow"; pane: PaneId; pick: RowPick; now: number }
  /** A highlighted row's `ask` chip: as ctrl-t on it. */
  | { type: "clickAskRow"; pane: PaneId; id: string; now: number }
  | { type: "clickRequote"; cardId: string; now: number }
  /** A wallet chip in a card's details: the same trade, proposed again paid from that wallet. */
  | { type: "clickPayFrom"; cardId: string; wallet: { word: string; name: string }; now: number }
  | { type: "clickResolve"; cardId: string; action: "resend" | "abandon"; now: number }
  /** The wheel or PgUp/PgDn on a pane: `delta` rows towards its top (older) when positive. */
  | { type: "scroll"; pane: PaneId; delta: number; now: number }
  | { type: "toggleOneAgent"; now: number }
  /** The Signals pane's chips: `source` switches Hacc's tape and your rules; `pattern` and `chain` open their menu under the chip. */
  | { type: "clickSignalsChip"; which: SignalsChipId; x?: number; y?: number; now: number }
  /** A row of Signals' pattern or chain menu, clicked. */
  | { type: "pickSignalsMenu"; index: number; now: number }
  /** Signals' pause chip, and resume. */
  | { type: "pauseSignals"; on: boolean; now: number }
  /** The empty filter's `clear filters` chip. */
  | { type: "clearSignals"; now: number }
  /** The P&L pane's window chip: its menu under the chip; a row of it picked by a click. */
  | { type: "clickPnlWindow"; x?: number; y?: number; now: number }
  | { type: "pickPnlMenu"; index: number; now: number }
  /** The Wallets pane's `⌕ find` chip, and its `all groups ▾` chip with a row of its menu. */
  | { type: "walletsFind"; now: number }
  | { type: "clickWalletsGroups"; x?: number; y?: number; now: number }
  | { type: "pickWalletsMenu"; index: number; now: number }
  /** The overlay of every wallet: a row clicked picks it; its chips name the picked, clear them, preview, or go back. */
  | { type: "everyWallet"; which: "pick" | "name" | "clear" | "preview" | "back"; index?: number; now: number }
  /** The approvals menu: a wallet clicked in its list, or one of the picked wallet's rows. */
  | { type: "pickApprovals"; wallet?: number; row?: ApprovalsRow; now: number }
  /** A span chip on the P&L chart. */
  | { type: "pnlSpan"; span: PnlSpan; now: number }
  /** The list pane's ◂ ▸ chips, and the palette's rows. */
  | { type: "listsSource"; delta?: number; source?: ListSource; now: number }
  /** The Journal's chips: its search line takes keys; a kind on or off; the next page. */
  | { type: "journalSearch"; now: number }
  | { type: "journalKind"; kind: JournalKind; now: number }
  | { type: "journalOlder"; now: number }
  | { type: "scrollJournalRows"; delta: number; now: number }
  /** The layout menu, from the tab bar's chip; a row picked in it by a click. */
  | { type: "clickLayoutMenu"; now: number }
  /** The tab bar's settings chip, and a row of its menu picked by a click. */
  | { type: "clickSettings"; now: number }
  /** The tab bar's `save as…` chip on a tab with adjustments. */
  | { type: "clickSaveLayout"; now: number }
  | { type: "pickSettings"; index: number; now: number }
  | { type: "pickLayoutRow"; index: number; now: number }
  | { type: "scrollLayoutMenu"; delta: number }
  /** A click on the card strip, on a layout without the agent pane: its cards take focus. */
  | { type: "clickStrip"; now: number }
  | { type: "scrollPalette"; delta: number; now: number }
  | { type: "scrollHelp"; delta: number; now: number }
  /** While you were away: the note's show all opens it, the wheel scrolls it, a token's row picks. */
  | { type: "openAway"; now: number }
  | { type: "scrollAway"; delta: number; now: number }
  | { type: "pickAway"; pick: RowPick; now: number }
  /** The agent pane's engine chip. */
  | { type: "clickEngineChip"; now: number }
  /** A model clicked in the picker; `model` undefined is the harness's own default. */
  | { type: "pickEngine"; engine: EngineId; model?: string; now: number }
  | { type: "pickPreset"; preset: Preset; now: number }
  /** A memory row's ✕ chip. */
  | { type: "deleteMemory"; row: MemoryRow; now: number }
  /** The memory overlay's "clear all": the first asks, the second clears. */
  | { type: "clickMemoryClear"; now: number }
  | { type: "scrollEngines"; delta: number; now: number }
  /** A model list answered: an untouched picker moves to the agent's choice, now that it's listed. */
  | { type: "modelsRead"; now: number }
  /** `restore`: a typed line the core refused, put back to fix while the line is still empty. */
  | { type: "message"; text: string; level: "info" | "error"; now: number; restore?: string; copy?: string }
  /** The prompt pane opened: an info message about the step it runs is done with, so it goes. */
  | { type: "paneOpened" }

export type Effect =
  /** `line`: what was typed, for a CLI command or a trade, which the core may refuse and the line then gets back. */
  | { type: "command"; command: Command; line?: string }
  | { type: "approve"; cardId: string; how: "enter" | "click" }
  | { type: "reject"; cardId: string }
  | { type: "kill" }
  | { type: "quit" }
  | { type: "mode"; mode: "paper" | "live" }
  | { type: "setAgent"; agent: string }
  /** A fresh card for the same request; with `wallet`, paid from that wallet, and the open one withdrawn. */
  | { type: "requote"; cardId: string; wallet?: { word: string; name: string } }
  /** Re-send or abandon the unanswered operation of this card. */
  | { type: "resolve"; cardId: string; action: "resend" | "abandon" }
  /** Copy an address to the clipboard, or `what` else it is (a pop-out's command). */
  | { type: "copy"; text: string; what?: string }
  /** Ask the core for every engine's models: the list last read, then a fresh read (the picker opened). */
  | { type: "readModels" }
  /** The agent's engine and model from its next turn; `model` undefined is the harness's own default. */
  | { type: "chooseEngine"; agent: string; engine: EngineId; model?: string }
  | { type: "choosePreset"; agent: string; preset: Preset }
  /** The memory overlay opened: the core reads every agent's memory fresh. */
  | { type: "readMemory" }
  /** A delete from an agent's memory, the person's. */
  | { type: "memoryDelete"; agent: string; entry?: string; file?: string; all?: true }
  /** Stop the agent's turn, and the messages waiting behind it (a turn must always be stoppable). */
  | { type: "stopTurn"; agent: string }
  /** A change to the tab's layout, or which it shows: the frame makes it and writes layouts.toml. */
  | { type: "layout"; op: LayoutOp }
  /** The link moves to the person's pick. */
  | { type: "link"; mint: string; chain?: "solana" | "hood"; from?: string }
  /** A step to come back to: a highlight settling (the frame sends a tick then). */
  | { type: "wake"; afterMs: number }
  /** Pin the tab's token pane on its token, or let it follow the link again (the palette's row, as its chip). */
  | { type: "pin"; on: boolean }
  /** Read config.toml's [aliases] again. */
  | { type: "reloadAliases" }
  /** Draw in another theme, kept for next time. */
  | { type: "theme"; name: string }
  /** Move a pane into a split of its own: the frame runs tmux or cmux. */
  | { type: "popOut"; pane: PaneId }
  /** What this tab's Signals pane shows: the core keeps it by the tab; null clears a filter. */
  | { type: "signals"; change: SignalsChange }
  /** The P&L window: the core keeps it, and every figure names it. */
  | { type: "pnlWindow"; window: PnlWindow }
  /** A skill folder of the person's own turned on or off, and the folders read fresh as their rows open. */
  | { type: "skillsFolder"; folder: string; on: boolean }
  | { type: "skillsRead" }
  /** The Journal's next page, and a row's rows as recorded for its details. */
  | { type: "journalOlder" }
  | { type: "journalRows"; id: string; seqs: number[] }
  /** Several wallets named at once: the core checks every name, then writes the Candle Harness's and opens the pane for Candle's. */
  | { type: "nameWallets"; names: { wallet: string; name: string }[] }
  /** Which wallets the panes show (one group, from the Wallets pane's menu): the core keeps it. */
  | { type: "walletsShow"; show: WalletsShown }
  /** A wallet's setting, the person's from the approvals menu: the core keeps it. */
  | { type: "autonomy"; wallet: string; name: string; setting: "ask" | "inside"; perTradeUsd?: number; perDayUsd?: number }

export interface UiContext {
  /** Open cards, oldest first. */
  cards: readonly ViewCard[]
  seenAt: Readonly<Record<string, number>>
  mode: "paper" | "live" | undefined
  agents: readonly string[]
  activeAgent: string | undefined
  commands: CommandContext
  /** The tab's panes as drawn: where each is, and which show one at a time (collapsed). Unset, Agent-first at full width. */
  panes?: PaneNav
  /** The tabs' names, from layouts.toml: those shown. Unset, the eight defaults. */
  tabs?: readonly string[]
  /** Every tab, shown or ticked off, in order: the settings menu's ticks and the palette's. */
  tabTicks?: readonly TabTick[]
  /** The tab's layout, for the layout menu. */
  layout?: LayoutInfo
  /** How far each pane can scroll, as last drawn. Unset, a pane scrolls without a limit. */
  scrolls?: Partial<Record<PaneId, ScrollReach>>
  /** The newest expired card on screen, which ctrl-r re-quotes. */
  requotable?: string
  /** The model picker's rows for an agent and a search, and whether the agent's next turn needs a model picked first. */
  engines?: { rows(query: string, agent: string): readonly PickerRow[]; needsModel(agent: string): boolean }
  /** The memory overlay's rows for an agent. */
  memory?: (agent: string) => readonly MemoryRow[]
  /** Whether the active agent has a turn running or waiting: Esc on an empty line stops it. */
  working?: boolean
  /** Whether a message waits behind the running turn, to run once it stops. */
  queuedBehind?: boolean
  /** Each pane's token rows, as last drawn: what ↑/↓ highlight. */
  picks?: Partial<Record<PaneId, readonly PickRow[]>>
  /** For the palette: each agent's preset, the linked token, the tab's token pane and its pin, and the kill switch's pause. */
  presets?: Readonly<Record<string, Preset | undefined>>
  linked?: string
  pin?: { pinned: boolean; symbol?: string }
  paused?: boolean
  /** How far help scrolls at the screen's size, its rows wrapped as drawn. Unset, a source line each. */
  helpMax?: number
  /** Aliases config.toml sets that were left out: the palette says so. */
  aliasProblems?: number
  /** The panes popped out into views of their own, which this view leaves out. */
  popped?: readonly PaneId[]
  /** The themes for the palette: read only while it's open. */
  themes?: { names: readonly string[]; current: string; dir: string }
  /** This tab's Signals choice, the core's; unset, the whole tape. */
  signals?: SignalsPick
  /** The P&L window the core keeps, once it has said; unset, its default. */
  pnlWindow?: PnlWindow
  /** The Journal's rows as held: whether there's an older page to read, each row's seqs, and how far its details scroll. */
  journal?: { more: boolean; seqsOf(id: string): number[] | undefined; rowsMax?: number }
  /** The wallet groups and which wallets the panes show, for the Wallets pane's menu and the approvals menu. */
  walletGroups?: readonly WalletGroup[]
  /** The person's skill folders and whether each is used, from the core's skills topic. */
  skillFolders?: readonly SkillFolder[]
  walletsShown?: WalletsShown
  /** Every wallet on the account and what each is called, for the overlay of every wallet. */
  allWallets?: PortfolioView["wallets"]
  walletNames?: readonly WalletNameEntry[]
  /** Each wallet's setting and each agent's limits, for the approvals menu. */
  autonomy?: AutonomyTopic
  limits?: readonly AgentLimits[]
  /** While you were away: the last gap's summary, for the palette's row, and how far its overlay scrolls. */
  away?: AwayView
  awayMax?: number
  /** The first tab with the agent pane: where the palette's tour runs, as onboarding's does. */
  tourTab?: number
}

/** A change to a tab's Signals choice: your rules or Hacc's tape, a pattern and a chain, each null to clear. */
export interface SignalsChange {
  mine?: boolean
  pattern?: string | null
  chain?: "solana" | "hood" | null
}

/** A tab's tick in the settings menu: its name, and whether it's on the tab bar. */
export interface TabTick {
  name: string
  shown: boolean
}

type Step = { state: UiState; effects: Effect[] }
const done = (state: UiState, ...effects: Effect[]): Step => ({ state, effects })
const say = (state: UiState, text: string, now: number, level: "info" | "error" = "info", copy?: string): UiState => ({ ...state, message: { text, level, at: now, ...(copy !== undefined ? { copy } : {}) } })

/** The card Enter would approve: the one the user moved to while it's open, else the newest. */
export function focusedCard(state: UiState, ctx: UiContext): ViewCard | undefined {
  return ctx.cards.find((c) => c.cardId === state.focusedCardId) ?? ctx.cards.at(-1)
}

function approve(state: UiState, card: ViewCard | undefined, ctx: UiContext, now: number, how: "enter" | "click"): Step {
  if (!card) return done(state)
  // Funds out to a new address: a click on "yes, a new address", never Enter.
  if (card.display.newAddress && how === "enter") return done(say(state, "This sends to a new address: check it in full on the card, then click yes, a new address.", now, "error"))
  // A card that's only just appeared can't be approved by a key meant for something else.
  if (now - (ctx.seenAt[card.cardId] ?? now) < APPROVE_AFTER_MS) return done(state)
  return done(state, { type: "approve", cardId: card.cardId, how })
}

function switchMode(state: UiState, mode: "paper" | "live", ctx: UiContext, now: number): Step {
  if (ctx.mode === mode) return done(say(state, `Already in ${mode} mode.`, now))
  if (mode === "live") return done({ ...state, overlay: { kind: "confirmLive" } })
  return done(state, { type: "mode", mode })
}

function submit(state: UiState, ctx: UiContext, now: number): Step {
  const line = state.input
  const cleared: UiState = { ...state, input: "", cursor: 0 }
  const command = parseCommand(line, ctx.commands)
  if (!command) return done(cleared)
  switch (command.kind) {
    case "help":
      return done({ ...cleared, overlay: { kind: "help" } })
    case "mode":
      return switchMode(cleared, command.mode, ctx, now)
    case "kill":
      return done(cleared, { type: "kill" })
    case "refused": {
      // A typed trade that can't run stays on the line, to paste the mint into.
      const said = say(command.keepLine ? state : cleared, command.message, now, "error")
      return done(command.ask ? { ...said, message: { ...said.message!, ask: command.askText ?? line, ...(command.askText ? { askLine: line } : {}) } } : said)
    }
    case "setAgent":
      return done(cleared, { type: "setAgent", agent: command.agent })
    case "pnlWindow":
      return setPnlWindow(cleared, command.window, ctx, now)
    case "agent": {
      // A turn that can't run until a model is picked: the picker opens, and the message waits on the line.
      const agent = ctx.activeAgent
      if (agent && ctx.engines?.needsModel(agent)) {
        const opened = openPicker(state, ctx, now)
        return done(say(opened.state, `Pick a model for ${agent} first: its engine has several and none is your default. Your message stays on the line.`, now), ...opened.effects)
      }
      // What you just sent shows at once: a pane left scrolled up would hide it until the reply ended.
      return done(unscrolled(cleared, "agent"), { type: "command", command })
    }
    default:
      return done(cleared, { type: "command", command, ...(command.kind === "cli" || command.kind === "trade" || command.kind === "chain" ? { line: line.trim() } : {}) })
  }
}

/** The focused pane's highlighted row, when it carries a question for ctrl-t. */
export function rowAsk(state: UiState, ctx: UiContext): { pane: PaneId; row: PickRow } | undefined {
  const pane = state.focus === "tabs" || state.focus === "cards" ? undefined : state.focus
  const id = pane ? state.highlight?.[pane]?.id : undefined
  const row = pane && id !== undefined ? ctx.picks?.[pane]?.find((r) => r.id === id) : undefined
  return pane && row?.ask ? { pane, row } : undefined
}

/**
 * ctrl-t on a highlighted row, or its `ask` chip: the row is picked at once, as a
 * click picks it (the agent is told the mint, not just "JUP"), and its question goes on the
 * input line, the cursor at its end, for Enter to send or the person to add to. Nothing is sent.
 */
function askRow(state: UiState, ctx: UiContext, now: number, at?: { pane: PaneId; id: string }): Step {
  const found = at ? { pane: at.pane, row: ctx.picks?.[at.pane]?.find((r) => r.id === at.id) } : rowAsk(state, ctx)
  if (!found?.row?.ask) {
    const pane = state.focus === "tabs" || state.focus === "cards" ? undefined : state.focus
    return pane && (ctx.picks?.[pane]?.length ?? 0) > 0 ? done(say(state, "↑/↓ to a row first: ctrl-t then puts a question about it on the line.", now)) : done(state)
  }
  const { pane, row } = found as { pane: PaneId; row: PickRow }
  const was = state.highlight?.[pane]
  const linked = was?.sent === true && was.id === row.id
  const picked = highlighted(focusPane(state, pane), pane, row, now, ctx, true)
  const question = row.ask!
  return done({ ...picked, input: question, cursor: question.length }, ...(linked || !row.mint ? [] : [{ type: "link" as const, mint: row.mint, ...(row.chain ? { chain: row.chain } : {}), from: `${pane}, by ctrl-t` }]))
}

/** Sends a refused line to the agent as typed, when the refusal offered it; the line is cleared if it's still that line. */
function askAgent(state: UiState): Step {
  const ask = state.message?.ask
  if (ask === undefined) return done(state)
  // The line is cleared if it's still the one refused (an alias's, whose words `ask` holds, included).
  const next: UiState = { ...state, message: undefined, ...(state.input === (state.message?.askLine ?? ask) ? { input: "", cursor: 0 } : {}) }
  return done(next, { type: "command", command: { kind: "agent", text: ask } })
}

function insert(state: UiState, text: string): UiState {
  const input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor)
  return { ...state, input, cursor: state.cursor + text.length }
}

const WIDE = paneNav(place(AGENT_FIRST, { x: 0, y: 2, w: 140, h: 36 }))
const navOf = (ctx: UiContext): PaneNav => ctx.panes ?? WIDE

/** Focus on a pane, which becomes the latest focused. */
const focusPane = (state: UiState, pane: PaneId): UiState => ({ ...state, focus: pane, recent: [pane, ...state.recent.filter((p) => p !== pane)] })

/** Focus back on the agent pane, where the layout has one; else it stays where it is. */
const toAgent = (state: UiState, ctx: UiContext): UiState => (navOf(ctx).order.includes("agent") ? focusPane(state, "agent") : state)

/** Tab's stops: the tab bar, then the layout's panes, the cards right after the agent's when any wait, and a collapsed group as one. */
function stops(state: UiState, ctx: UiContext): Focus[] {
  const nav = navOf(ctx)
  const shown = shownOf(nav.group, state.recent, nav.first)
  const panes = nav.order.filter((p) => !nav.group.includes(p) || p === shown)
  const cards = ctx.cards.length > 0 || ctx.requotable
  // Without the agent pane, the cards wait in the strip above the input line: Tab reaches them last.
  if (!panes.includes("agent")) return ["tabs", ...panes, ...(ctx.cards.length > 0 ? (["cards"] as Focus[]) : [])]
  return ["tabs", ...panes.flatMap((p): Focus[] => (p === "agent" && cards ? ["agent", "cards"] : [p]))]
}

/** The pane an arrow moves to from `from`: of those beside it, the one last focused, else the first. */
function arrowTo(state: UiState, ctx: UiContext, from: PaneId, dir: Direction): PaneId | undefined {
  const found = beside(navOf(ctx), from, dir)
  return state.recent.find((p) => found.includes(p)) ?? found[0]
}

const SCROLL_PAGE = 10
const unscrolled = (state: UiState, pane: PaneId): UiState => {
  const { [pane]: _gone, ...rest } = state.scroll
  return { ...state, scroll: rest }
}

/**
 * Scrolls a pane `delta` rows towards its top, never past what it holds as last drawn. A tail pane counts
 * from its newest, taking in the lines that arrived since its anchor, and anchors on the newest again.
 */
function scrolled(state: UiState, pane: PaneId, delta: number, ctx: UiContext): UiState {
  const reach = ctx.scrolls?.[pane]
  const max = reach?.max ?? Number.POSITIVE_INFINITY
  const order = PANES[pane].order
  const fromNewest = order === "tail"
  // A tail or head pane holds its view as lines arrive: it counts the ones since its anchor, and anchors again.
  const anchored = order !== "list"
  const now = scrollOf(state, pane) + (anchored ? (reach?.since ?? 0) : 0)
  const rows = Math.max(0, Math.min(max, now + (fromNewest ? delta : -delta)))
  // Paused, it stays paused at the top: the newest shown, and counting what arrives after.
  const paused = state.scroll[pane]?.paused
  if (rows === 0 && !paused) return unscrolled(state, pane)
  return { ...state, scroll: { ...state.scroll, [pane]: { rows, ...(anchored && reach?.newest !== undefined ? { anchor: reach.newest } : {}), ...(paused ? { paused } : {}) } } }
}

function moveCard(state: UiState, ctx: UiContext, delta: number): UiState {
  const current = focusedCard(state, ctx)
  const i = current ? ctx.cards.indexOf(current) : -1
  const next = ctx.cards[Math.max(0, Math.min(ctx.cards.length - 1, i + delta))]
  return next ? { ...state, focusedCardId: next.cardId } : state
}

/**
 * Scrolls a pane so its line `line` is in view, from the window as last drawn. A tail or head pane anchors
 * on its newest line again, so the count is from it.
 */
function revealed(state: UiState, pane: PaneId, line: number, ctx: UiContext): UiState {
  const reach = ctx.scrolls?.[pane]
  if (!reach || reach.start === undefined || reach.rows === undefined || reach.total === undefined || reach.rows <= 0) return state
  if (line >= reach.start && line < reach.start + reach.rows) return state
  const start = line < reach.start ? line : line - reach.rows + 1
  const order = PANES[pane].order
  const rows = Math.max(0, Math.min(reach.max, order === "tail" ? reach.total - (start + reach.rows) : start))
  const paused = state.scroll[pane]?.paused
  if (rows === 0 && !paused) return unscrolled(state, pane)
  return { ...state, scroll: { ...state.scroll, [pane]: { rows, ...(order !== "list" && reach.newest !== undefined ? { anchor: reach.newest } : {}), ...(paused ? { paused } : {}) } } }
}

/** A row highlighted in a pane, kept in view; it becomes the link once it has rested (or at once, `sent`, for a click). */
function highlighted(state: UiState, pane: PaneId, row: PickRow | RowPick, now: number, ctx: UiContext, sent = false): UiState {
  const { id, mint, chain } = row
  const next: UiState = { ...state, highlight: { ...state.highlight, [pane]: { id, mint, ...(chain ? { chain } : {}), at: now, ...(sent ? { sent: true as const } : {}) } } }
  return held("line" in row ? revealed(next, pane, row.line, ctx) : next, pane, ctx)
}

/**
 * A head pane (Signals) with a row highlighted holds its view, as a scrolled one does:
 * new rows arriving at its head don't push the highlighted one down and away.
 */
function held(state: UiState, pane: PaneId, ctx: UiContext): UiState {
  const newest = ctx.scrolls?.[pane]?.newest
  if (PANES[pane].order !== "head" || state.scroll[pane] || newest === undefined) return state
  return { ...state, scroll: { ...state.scroll, [pane]: { rows: 0, anchor: newest } } }
}

/** Signals paused, or resumed at the newest. Paused, its view holds where it is, scrolled or not. */
function pauseSignals(state: UiState, on: boolean, ctx: UiContext): UiState {
  if (!on) return unscrolled(state, "signals")
  const reach = ctx.scrolls?.signals
  const was = state.scroll.signals
  const rows = (was?.rows ?? 0) + (reach?.since ?? 0)
  return { ...state, scroll: { ...state.scroll, signals: { rows, ...(reach?.newest !== undefined ? { anchor: reach.newest } : {}), paused: true } } }
}

/** A change to the tab's Signals choice goes to the core, and the pane starts again at its newest. */
const changeSignals = (state: UiState, change: SignalsChange): Step => done(unscrolled(state, "signals"), { type: "signals", change })

/** A row of Signals' pattern or chain menu picked: the menu closes, and the choice changes. */
function pickSignalsMenu(state: UiState, which: "pattern" | "chain", index: number, ctx: UiContext): Step {
  const row = signalsMenuRows(which, ctx.signals ?? {})[index]
  const closed: UiState = { ...state, overlay: undefined }
  if (!row) return done(closed)
  return changeSignals(closed, which === "pattern" ? { pattern: row.value } : { chain: row.value as "solana" | "hood" | null })
}

/** The P&L window's menu, opened on the window that's on. */
function openPnlMenu(state: UiState, ctx: UiContext, at: { x?: number; y?: number } = {}): Step {
  const index = Math.max(0, pnlWindowRows(ctx.pnlWindow).findIndex((r) => r.on))
  return done({ ...state, overlay: { kind: "pnlMenu", index, ...(at.x !== undefined ? { x: at.x } : {}), ...(at.y !== undefined ? { y: at.y } : {}) } })
}

/** A window picked: it goes to the core, which keeps it. "Since another time" puts `pnl since ` on the input line to finish. */
function pickPnlMenu(state: UiState, index: number, ctx: UiContext, now: number): Step {
  const row = pnlWindowRows(ctx.pnlWindow)[index]
  const closed: UiState = { ...state, overlay: undefined }
  if (!row) return done(closed)
  // The time is typed on the row itself: filling the input line at the foot and closing looked like
  // nothing happened.
  if (!row.value) return state.overlay?.kind === "pnlMenu" ? done({ ...state, overlay: { ...state.overlay, index, typing: state.overlay.typing ?? "" } }) : done(closed)
  return setPnlWindow(closed, row.value, ctx, now)
}

function setPnlWindow(state: UiState, window: PnlWindow, ctx: UiContext, now: number): Step {
  if (window === (ctx.pnlWindow ?? "24h")) return done(say(state, `The P&L window is already ${pnlWindowWords(window)}.`, now))
  return done(state, { type: "pnlWindow", window })
}

/** Signals' pattern or chain menu, opened on the row that's on. */
function openSignalsMenu(state: UiState, which: "pattern" | "chain", ctx: UiContext, at: { x?: number; y?: number } = {}): Step {
  const index = Math.max(0, signalsMenuRows(which, ctx.signals ?? {}).findIndex((r) => r.on))
  return done({ ...state, overlay: { kind: "signalsMenu", which, index, ...(at.x !== undefined ? { x: at.x } : {}), ...(at.y !== undefined ? { y: at.y } : {}) } })
}

/**
 * ↑/↓ in a pane with token rows: the highlight moves a row. With none yet, either arrow highlights the
 * first row in view (a tail pane's newest, at its foot). Past its first or last row, undefined: the
 * arrow moves to the pane beside, as in a pane without rows.
 */
function moveHighlight(state: UiState, pane: PaneId, delta: number, ctx: UiContext, now: number): Step | undefined {
  const rows = ctx.picks?.[pane] ?? []
  if (rows.length === 0) return undefined
  const at = state.highlight?.[pane]
  const i = at ? rows.findIndex((r) => r.id === at.id) : -1
  let to: PickRow | undefined
  if (i < 0) {
    const reach = ctx.scrolls?.[pane]
    const inView = rows.filter((r) => reach?.start === undefined || reach.rows === undefined || (r.line >= reach.start && r.line < reach.start + reach.rows))
    to = PANES[pane].order === "tail" ? (inView.at(-1) ?? rows.at(-1)) : (inView[0] ?? rows[0])
  } else to = rows[i + delta]
  if (!to) return undefined
  return done(highlighted(state, pane, to, now, ctx), { type: "wake", afterMs: LINK_SETTLE_MS })
}

/** Highlights that have rested long enough become the link: the latest only, so a run of arrows sends one. */
function settle(state: UiState, now: number): Step {
  const waiting = Object.entries(state.highlight ?? {}).filter(([, h]) => h && !h.sent && now - h.at >= LINK_SETTLE_MS) as [PaneId, Highlight][]
  if (waiting.length === 0) return done(state)
  const latest = waiting.reduce((a, b) => (b[1].at > a[1].at ? b : a))
  const highlight = { ...state.highlight }
  for (const [pane, h] of waiting) highlight[pane] = { ...h, sent: true }
  const h = latest[1]
  // The Wallets pane opens the group its highlight rested in, and folds the one before.
  const lit = waiting.find(([pane]) => pane === "wallets")?.[1]
  const open = lit ? groupOfRow(lit.id) : undefined
  const opened: UiState = open !== undefined && open !== state.wallets?.open ? { ...state, highlight, wallets: { ...state.wallets, open } } : { ...state, highlight }
  // A row with no token (a Journal row, a wallet) is highlighted, never the link.
  if (!h.mint) return done(opened)
  return done(opened, { type: "link", mint: h.mint, ...(h.chain ? { chain: h.chain } : {}), from: `${latest[0]}, by the arrows` })
}

/** Opens the model picker for the agent in view, on its choice now, and asks the core for the lists. */
function openPicker(state: UiState, ctx: UiContext, now: number): Step {
  const agent = ctx.activeAgent
  if (!agent) return done(say({ ...state, overlay: undefined }, "No agent yet: the core hasn't said which.", now))
  const rows = ctx.engines?.rows("", agent) ?? []
  return done({ ...state, overlay: { kind: "engines", agent, query: "", index: startIndex(rows) } }, { type: "readModels" })
}

/** Opens the memory overlay for the agent in view, or the one named (the palette's rows). */
function openMemory(state: UiState, ctx: UiContext, now: number, agent = ctx.activeAgent): Step {
  if (!agent) return done(say({ ...state, overlay: undefined }, "No agent yet: the core hasn't said which.", now))
  return done({ ...state, overlay: { kind: "memory", agent, index: 0 } }, { type: "readMemory" })
}

/** A row's delete: a line of the index by its id, a file by its path, or "clear all" once it has asked. */
function deleteMemory(state: UiState, overlay: Extract<Overlay, { kind: "memory" }>, row: MemoryRow | undefined): Step {
  if (!row) return done(state)
  if (row.kind === "clear") {
    if (!overlay.confirm) return done({ ...state, overlay: { ...overlay, confirm: true } })
  }
  const { confirm: _confirm, ...rest } = overlay
  if (row.kind === "clear") return done({ ...state, overlay: { ...rest, index: 0 } }, { type: "memoryDelete", agent: overlay.agent, all: true })
  return done({ ...state, overlay: rest }, row.kind === "entry" ? { type: "memoryDelete", agent: overlay.agent, entry: row.id } : { type: "memoryDelete", agent: overlay.agent, file: row.path })
}

function onMemoryKey(state: UiState, overlay: Extract<Overlay, { kind: "memory" }>, key: Key, ctx: UiContext): Step {
  const rows = ctx.memory?.(overlay.agent) ?? []
  const index = Math.min(overlay.index, Math.max(0, rows.length - 1))
  const { confirm: _confirm, ...calm } = overlay
  const move = (delta: number) => done({ ...state, overlay: { ...calm, index: Math.max(0, Math.min(rows.length - 1, index + delta)) } })
  switch (key.name) {
    case "up":
      return move(-1)
    case "down":
      return move(1)
    case "pageup":
      return move(-10)
    case "pagedown":
      return move(10)
    case "escape":
      return done({ ...state, overlay: overlay.confirm ? calm : undefined })
    case "return":
    case "enter":
      // Enter acts only on "clear all", which asks first; a line or file goes with ⌫ or its ✕.
      return rows[index]?.kind === "clear" ? deleteMemory(state, { ...overlay, index }, rows[index]) : done(state)
    case "backspace":
    case "delete":
      return rows[index]?.kind === "clear" ? done(state) : deleteMemory(state, { ...overlay, index }, rows[index])
  }
  return done(state)
}

/** A model or preset picked: from the agent's next turn, and the picker closes. */
function pickEngine(state: UiState, agent: string, row: PickableRow | undefined): Step {
  const closed: UiState = { ...state, overlay: undefined }
  if (!row) return done(closed)
  if (row.kind === "preset") return done(closed, { type: "choosePreset", agent, preset: row.preset })
  return done(closed, { type: "chooseEngine", agent, engine: row.engine, ...(row.model !== undefined ? { model: row.model } : {}) })
}

function onEnginesKey(state: UiState, overlay: Extract<Overlay, { kind: "engines" }>, key: Key, ctx: UiContext): Step {
  const models = pickable(ctx.engines?.rows(overlay.query, overlay.agent) ?? [])
  const move = (delta: number) => done({ ...state, overlay: { ...overlay, index: Math.max(0, Math.min(models.length - 1, overlay.index + delta)), moved: true } })
  const search = (query: string) => done({ ...state, overlay: { ...overlay, query, index: 0, moved: true } })
  switch (key.name) {
    case "up":
      return move(-1)
    case "down":
      return move(1)
    case "pageup":
      return move(-10)
    case "pagedown":
      return move(10)
    case "return":
    case "enter":
      return pickEngine(state, overlay.agent, models[Math.min(overlay.index, models.length - 1)])
    case "escape":
      return done({ ...state, overlay: undefined })
    case "backspace":
      return search(overlay.query.slice(0, -1))
  }
  // ctrl-u clears the search here too, as in the palette.
  if (pressed(key, "clearLine")) return search("")
  const ch = key.sequence ?? ""
  if (key.ctrl || key.meta || ch.length !== 1 || ch < " " || ch === "\u007f") return done(state)
  return search(overlay.query + ch)
}

/** What the palette's rows need, from the state and the context. */
export function paletteInput(state: UiState, ctx: UiContext): PaletteInput {
  const focus = menuFocus(state)
  return {
    tabs: ctx.tabs ?? DEFAULT_TABS.map((t) => t.name),
    tab: state.tab,
    ...(ctx.tabTicks ? { tabTicks: ctx.tabTicks } : {}),
    ...(ctx.layout ? { layout: ctx.layout } : {}),
    ...(focus ? { focus } : {}),
    agents: ctx.agents,
    ...(ctx.activeAgent ? { activeAgent: ctx.activeAgent } : {}),
    presets: ctx.presets ?? {},
    tokens: ctx.commands.knownTokens,
    ...(ctx.linked ? { linked: ctx.linked } : {}),
    ...(ctx.pin ? { pin: ctx.pin } : {}),
    ...(ctx.mode ? { mode: ctx.mode } : {}),
    paused: ctx.paused === true,
    card: focusedCard(state, ctx) !== undefined,
    requotable: ctx.requotable !== undefined,
    working: ctx.working === true,
    ask: state.message?.ask !== undefined || rowAsk(state, ctx) !== undefined,
    aliases: ctx.commands.aliases ?? new Map(),
    aliasProblems: ctx.aliasProblems ?? 0,
    popped: ctx.popped ?? [],
    ...(ctx.themes ? { themes: ctx.themes } : {}),
    signals: { ...ctx.signals, paused: state.scroll.signals?.paused === true },
    ...(ctx.pnlWindow ? { pnlWindow: ctx.pnlWindow } : {}),
    ...(ctx.panes?.order.includes("lists") || ctx.panes?.group.includes("lists") ? { lists: state.lists ?? "onfire" } : {}),
    ...(ctx.away ? { away: ctx.away } : {}),
    ...(ctx.walletGroups?.length ? { walletGroups: ctx.walletGroups.map((g) => g.name) } : {}),
    ...(ctx.skillFolders ? { skillFolders: ctx.skillFolders } : {}),
    walletsOnTab: navOf(ctx).order.includes("wallets") || navOf(ctx).group.includes("wallets"),
  }
}

/** The palette's rows for its search, as drawn. */
export const paletteFound = (state: UiState, ctx: UiContext, query: string): PaletteRow[] => paletteRows(paletteInput(state, ctx), query)

/** Opens the palette, at its first row or (`?` then `c`) at Candle's commands. */
export function openPalette(state: UiState, ctx: UiContext, at?: "cli"): Step {
  const rows = at === "cli" ? paletteFound(state, ctx, "") : []
  return done({ ...state, overlay: { kind: "palette", query: "", index: at === "cli" ? Math.max(0, rows.findIndex((r) => r.cli)) : 0 } })
}

/** A palette row picked: what its key or click does, from the state the palette opened over. */
/** The layout menu straight at "save as": its naming row, asking for the name (the palette's row, and the tab bar's chip). */
function openSaveAs(state: UiState, ctx: UiContext, now: number): Step {
  const opened = openLayoutMenu(state, ctx, now)
  if (opened.state.overlay?.kind !== "layouts") return opened
  const rows = ctx.layout ? layoutMenuRows(ctx.layout, menuFocus(state)) : []
  return done({ ...opened.state, overlay: { kind: "layouts", index: Math.max(0, rows.findIndex((r) => r.naming === "saveAs")), naming: "" } })
}

function runPalette(state: UiState, row: PaletteRow | undefined, ctx: UiContext, now: number): Step {
  const closed: UiState = { ...state, overlay: undefined }
  if (!row) return done(closed)
  const run = row.run
  if (!run) return done(say(closed, `${row.cli ? `candle ${row.label}` : row.label}: ${row.why ?? "nothing to do here"}`, now))
  switch (run.kind) {
    case "key":
      return runKey(closed, run.id, ctx, now)
    case "mode":
      return switchMode(closed, run.mode, ctx, now)
    case "resume":
      return done(closed, { type: "command", command: { kind: "resume" } })
    case "tab":
      return done({ ...closed, tab: Math.max(0, Math.min(tabCount(ctx) - 1, run.tab)) })
    case "layout":
      return done(closed, { type: "layout", op: run.op })
    case "layoutMenu":
      return run.naming ? openSaveAs(closed, ctx, now) : openLayoutMenu(closed, ctx, now)
    case "focus":
      return done(focusPane(closed, run.pane))
    case "pin":
      return done(closed, { type: "pin", on: run.on })
    case "agent":
      return done(closed, { type: "setAgent", agent: run.agent })
    case "preset":
      return done(closed, { type: "choosePreset", agent: run.agent, preset: run.preset })
    case "picker":
      return openPicker(closed, ctx, now)
    case "memory":
      return openMemory(closed, ctx, now, run.agent)
    case "link":
      return done(closed, { type: "link", mint: run.mint, ...(run.chain ? { chain: run.chain } : {}), from: "the palette" })
    case "fill":
      // An alias: its name goes on the input line, for the rest to be typed after it.
      return done({ ...closed, input: run.text, cursor: run.text.length })
    case "reloadAliases":
      // The palette stays open on the aliases, read again, so the one just added shows (closing hid it).
      return done({ ...state, overlay: { kind: "palette", query: "aliases", index: 0 } }, { type: "reloadAliases" })
    case "theme":
      return done(closed, { type: "theme", name: run.name })
    case "popOut":
      return popOut(closed, ctx, now, run.pane)
    case "signalsMenu":
      return openSignalsMenu(closed, run.which, ctx)
    case "signals":
      return changeSignals(closed, run.change)
    case "pnlWindow":
      return setPnlWindow(closed, run.window, ctx, now)
    case "skillsFolder":
      // The palette stays open on its row, which shows the folder's new state when the core answers.
      return done(state, { type: "skillsFolder", folder: run.folder, on: run.on })
    case "lists":
      return done({ ...closed, lists: run.source })
    case "pnlMenu":
      return openPnlMenu(closed, ctx)
    case "approvals":
      return openApprovals(closed)
    case "everyWallet":
      return openEveryWallet(closed)
    case "walletsFind":
      return done(walletsSearching(focusPane(closed, "wallets"), true))
    case "walletsMenu":
      return openWalletsMenu(closed, ctx, now)
    // While you were away: as the note's show all.
    case "away":
      return done({ ...closed, overlay: { kind: "away" } })
    case "tour":
      return openTour(closed, ctx)
    case "journalSearch": {
      // On the tab on screen if it shows the Journal, else on the Journal's own tab.
      if (navOf(ctx).order.includes("journal")) return done(searching(focusPane(closed, "journal"), true))
      const tab = (ctx.tabs ?? DEFAULT_TABS.map((t) => t.name)).indexOf("Journal")
      if (tab < 0) return done(say(closed, "No tab shows the Journal: tick it in settings ▾, or open its pane with the layout menu.", now))
      return done(searching(focusPane({ ...closed, tab }, "journal"), true))
    }
    case "pauseSignals":
      return done(pauseSignals(closed, run.on, ctx))
    case "cli": {
      // Its request goes on the input line for the user to finish and send; nothing runs.
      const request = CATALOGUE.find((e) => e.path === run.path)?.request
      return request ? done({ ...closed, input: request, cursor: request.length }) : done(closed)
    }
  }
}

/** A key's action, from its chord or its palette row. */
function runKey(state: UiState, id: KeyId, ctx: UiContext, now: number): Step {
  const card = focusedCard(state, ctx)
  switch (id) {
    case "reject":
      return card ? done(state, { type: "reject", cardId: card.cardId }) : done(state)
    case "details": {
      // On a highlighted Journal row, its rows as recorded; else the card's details.
      const row = state.focus === "journal" ? state.highlight?.journal : undefined
      const seqs = row ? ctx.journal?.seqsOf(row.id) : undefined
      if (row && seqs) return done({ ...state, overlay: { kind: "journalRows", id: row.id } }, { type: "journalRows", id: row.id, seqs })
      return done(card ? { ...state, overlay: { kind: "card", cardId: card.cardId } } : state)
    }
    case "requote":
      return ctx.requotable ? done(state, { type: "requote", cardId: ctx.requotable }) : done(state)
    case "ask":
      // A refused line keeps ctrl-t's meaning; elsewhere it asks about the highlighted row.
      return state.message?.ask !== undefined ? askAgent(state) : askRow(state, ctx, now)
    case "stop":
      return ctx.working && ctx.activeAgent ? done(say(toAgent(state, ctx), `Stopping ${ctx.activeAgent}'s turn${ctx.queuedBehind ? "; the message waiting behind it runs next" : ""}.`, now), { type: "stopTurn", agent: ctx.activeAgent }) : done(state)
    case "kill":
      return done({ ...state, killArmedAt: undefined }, { type: "kill" })
    case "help":
      return done({ ...state, overlay: { kind: "help" } })
    case "oneAgent":
      return done({ ...state, oneAgent: !state.oneAgent })
    case "picker":
      return openPicker(state, ctx, now)
    case "palette":
      return openPalette(state, ctx)
    case "popOut":
      return popOut(state, ctx, now)
    default:
      return done(state)
  }
}

/** The focused pane, when it can pop out. */
export const poppable = (state: UiState): PaneId | undefined => (state.focus !== "tabs" && state.focus !== "cards" && PANES[state.focus].pops ? state.focus : undefined)

/**
 * ctrl-p: the focused pane moves into a split of its own, and focus goes to the agent
 * pane, or the tab bar where the layout has none. The agent's conversation stays.
 */
function popOut(state: UiState, ctx: UiContext, now: number, pane = poppable(state)): Step {
  if (!pane) {
    const why = state.focus === "agent" || state.focus === "cards" ? "The agent's conversation and its cards stay here, with the input line." : "Nothing is focused to pop out."
    return done(say(state, `${why} Focus a pane (tab, the arrows or a click), then ctrl-p moves it into a split of its own.`, now))
  }
  if (ctx.popped?.includes(pane)) return done(say(state, `${pane} is popped out already: close its view to bring it back.`, now))
  const left = state.focus === pane ? (navOf(ctx).order.includes("agent") ? focusPane(state, "agent") : { ...state, focus: "tabs" as const }) : state
  return done(say(left, `Popping out ${pane}…`, now), { type: "popOut", pane })
}

/** The settings menu's rows: its own, then a tick for each tab. */
export const settingsCount = (ctx: UiContext): number => SETTINGS.length + (ctx.tabTicks?.length ?? 0)

/** A settings row picked: the menu closes, and what the row names opens. A tab's tick flips it, and the menu stays for another. */
function runSettings(state: UiState, index: number, ctx: UiContext, now: number): Step {
  const closed: UiState = { ...state, overlay: undefined }
  const tick = index >= SETTINGS.length ? ctx.tabTicks?.[index - SETTINGS.length] : undefined
  if (tick) return done({ ...state, overlay: { kind: "settings", index } }, { type: "layout", op: { kind: "tabShown", name: tick.name, shown: !tick.shown } })
  switch (SETTINGS[index]?.id) {
    case "layout":
      return openLayoutMenu(closed, ctx, now)
    case "theme":
      return done({ ...closed, overlay: { kind: "palette", query: "themes", index: 0 } })
    case "aliases":
      return done({ ...closed, overlay: { kind: "palette", query: "aliases", index: 0 } })
    case "model":
      return openPicker(closed, ctx, now)
    case "memory":
      return openMemory(closed, ctx, now)
    case "skills":
      return done({ ...closed, overlay: { kind: "palette", query: "skills", index: 0 } }, { type: "skillsRead" })
    case "pnl":
      return openPnlMenu(closed, ctx)
    case "approvals":
      return openApprovals(closed)
    case "vault": {
      // The person's own owner step, typed: Enter opens the pane at once. The rest of the vault's commands are in the palette.
      const line = "candle vault init"
      return done(say({ ...closed, input: line, cursor: line.length }, "⏎ runs it in the pane. The vault's other commands (backup, a security key) are in ctrl-k's palette: type vault.", now))
    }
    default:
      return done(closed)
  }
}

/** The approvals menu, on the wallet list's first wallet. */
const openApprovals = (state: UiState): Step => done({ ...state, overlay: { kind: "approvals", wallet: 0, side: "wallets", row: 0 } })

/** The approvals menu as it was, with `patch`; a patch can unset `typing` and `draft`. */
function approvalsTo(state: UiState, o: ApprovalsState, patch: Partial<ApprovalsState>): UiState {
  const next: ApprovalsState = { ...o, ...patch }
  if ("typing" in patch && patch.typing === undefined) delete next.typing
  if ("draft" in patch && patch.draft === undefined) delete next.draft
  if ("find" in patch && patch.find === undefined) delete next.find
  return { ...state, overlay: next }
}

/**
 * A row of the picked wallet acted on, by ⏎ or a click. Switching back to asking is at once: it's less
 * access. Turning a wallet on takes its figures, typed on their rows, then the turn-on chip; nothing goes
 * to the core before it. A figure of a wallet that already trades inside limits is typed on its row and
 * goes when ⏎ is pressed on it.
 */
function actApprovals(state: UiState, o: ApprovalsState, row: ApprovalsRow, ctx: UiContext, now: number): Step {
  const w = pickedWallet(ctx.autonomy, ctx.walletGroups ?? [], o)
  if (!w) return done(state)
  const at = detailRows(w, o.draft).indexOf(row)
  const here = approvalsTo(state, o, { side: "detail", row: Math.max(0, at) })
  switch (row) {
    case "ask":
      return done(approvalsTo(here, o, { side: "detail", row: 0 }), { type: "autonomy", wallet: w.wallet, name: w.name, setting: "ask" })
    case "turnOn":
      return done(approvalsTo(state, o, { side: "detail", row: 0, draft: {}, typing: "" }))
    case "perTrade":
    case "perDay":
      return done(approvalsTo(state, o, { side: "detail", row: Math.max(0, at), typing: "" }))
    case "cancel":
      return done(approvalsTo(state, o, { side: "detail", row: 0, draft: undefined, typing: undefined }))
    case "confirm": {
      const d = o.draft ?? {}
      if (d.perTrade === undefined) return done(say(approvalsTo(state, o, { side: "detail", row: 0, typing: "" }), "Type the figure a trade may be without a card first.", now, "error"))
      if (d.perDay === undefined) return done(say(approvalsTo(state, o, { side: "detail", row: 1, typing: "" }), "Type the figure a day may be without a card first.", now, "error"))
      return done(approvalsTo(state, o, { side: "detail", row: 0, draft: undefined, typing: undefined }), { type: "autonomy", wallet: w.wallet, name: w.name, setting: "inside", perTradeUsd: d.perTrade, perDayUsd: d.perDay })
    }
  }
}

/** ⏎ on a figure being typed: a draft takes it and moves on; a wallet that trades inside limits sends it. */
function commitFigure(state: UiState, o: ApprovalsState, ctx: UiContext, now: number): Step {
  const w = pickedWallet(ctx.autonomy, ctx.walletGroups ?? [], o)
  const rows = detailRows(w, o.draft)
  const field = rows[o.row]
  if (!w || (field !== "perTrade" && field !== "perDay")) return done(approvalsTo(state, o, { typing: undefined }))
  const parsed = parseFigure(o.typing ?? "")
  if (!parsed.ok) return done(say(state, parsed.why, now, "error"))
  if (o.draft) {
    const draft = { ...o.draft, [field]: parsed.usd }
    const trade = draft.perTrade
    const day = draft.perDay
    if (trade !== undefined && day !== undefined && day < trade) return done(say(state, `A day without a card can't be less than a trade: ${money(day)} is under ${money(trade)}.`, now, "error"))
    // The trade's figure, then the day's, then the turn-on chip.
    if (field === "perTrade" && draft.perDay === undefined) return done(approvalsTo(state, o, { draft, row: rows.indexOf("perDay"), typing: "" }))
    return done(approvalsTo(state, o, { draft, row: rows.indexOf("confirm"), typing: undefined }))
  }
  const trade = field === "perTrade" ? parsed.usd : w.perTradeUsd!
  const day = field === "perDay" ? parsed.usd : w.perDayUsd!
  if (day < trade) return done(say(state, `A day without a card can't be less than a trade: ${money(day)} is under ${money(trade)}.`, now, "error"))
  return done(approvalsTo(state, o, { typing: undefined }), { type: "autonomy", wallet: w.wallet, name: w.name, setting: "inside", perTradeUsd: trade, perDayUsd: day })
}

/**
 * Keys in the approvals menu. ↑/↓ move through the wallets, or the picked wallet's rows once → or ⏎ went
 * into them; ← goes back. A figure's row takes digits as it's typed. Esc stops typing, then leaves a wallet
 * being turned on as it was, then closes. Nothing else closes it: figures are typed here.
 */
function onApprovalsKey(state: UiState, o: ApprovalsState, key: Key, ctx: UiContext, now: number): Step {
  const wallets = approvalsEntries(ctx.autonomy, ctx.walletGroups ?? [], o.find).map((e) => e.wallet)
  const rows = detailRows(wallets[o.wallet], o.draft)
  if (o.typing !== undefined) {
    if (key.name === "escape") return done(approvalsTo(state, o, { typing: undefined }))
    if (key.name === "backspace") return done(approvalsTo(state, o, { typing: o.typing.slice(0, -1) }))
    if (key.name === "return" || key.name === "enter") return commitFigure(state, o, ctx, now)
    if (key.name === "up" || key.name === "down") return onApprovalsKey(approvalsTo(state, o, { typing: undefined }), { ...o, typing: undefined } as ApprovalsState, key, ctx, now)
    const ch = key.sequence ?? ""
    if (key.ctrl || key.meta || !/^[0-9.,$]$/.test(ch) || o.typing.length >= 12) return done(state)
    return done(approvalsTo(state, o, { typing: o.typing + ch }))
  }
  switch (key.name) {
    case "escape":
      if (o.draft) return done(say(approvalsTo(state, o, { draft: undefined, row: 0 }), `Left ${walletWords(wallets[o.wallet]?.name ?? "")} as it was.`, now))
      // A search on the list ends first, on the wallet it had picked.
      if (o.find !== undefined) return done(approvalsFound(state, o, undefined, ctx))
      return done({ ...state, overlay: undefined })
    case "backspace":
      if (o.side === "wallets" && o.find !== undefined) return done(approvalsFound(state, o, o.find.slice(0, -1) || undefined, ctx))
      return done(state)
    case "up":
    case "down": {
      const by = key.name === "up" ? -1 : 1
      if (o.side === "wallets") return done(approvalsTo(state, o, { wallet: Math.max(0, Math.min(wallets.length - 1, o.wallet + by)), row: 0, draft: undefined }))
      return done(approvalsTo(state, o, { row: Math.max(0, Math.min(rows.length - 1, o.row + by)) }))
    }
    case "left":
      return done(approvalsTo(state, o, { side: "wallets", row: 0, draft: undefined }))
    case "right":
      return done(rows.length ? approvalsTo(state, o, { side: "detail" }) : state)
    case "return":
    case "enter": {
      if (o.side === "wallets") return done(rows.length ? approvalsTo(state, o, { side: "detail", row: 0 }) : state)
      const row = rows[o.row]
      return row ? actApprovals(state, o, row, ctx, now) : done(state)
    }
  }
  // A digit on a figure's row starts typing it.
  const ch = key.sequence ?? ""
  const row = rows[o.row]
  if (o.side === "detail" && (row === "perTrade" || row === "perDay") && !key.ctrl && !key.meta && /^[0-9$]$/.test(ch)) return done(approvalsTo(state, o, { typing: ch === "$" ? "" : ch }))
  // Typing on the list finds a wallet.
  if (o.side === "wallets" && !key.ctrl && !key.meta && ch.length === 1 && ch > " " && ch !== "\u007f" && (o.find ?? "").length < 64) return done(approvalsFound(state, o, (o.find ?? "") + ch, ctx))
  return done(state)
}

/** What's typed on the list changed: the pick stays on its wallet where the search still finds it, else the first found. */
function approvalsFound(state: UiState, o: ApprovalsState, find: string | undefined, ctx: UiContext): UiState {
  const groups = ctx.walletGroups ?? []
  const was = approvalsEntries(ctx.autonomy, groups, o.find)[o.wallet]
  const next = approvalsEntries(ctx.autonomy, groups, find)
  const at = was ? next.findIndex((e) => e.wallet.wallet === was.wallet.wallet && e.group === was.group) : -1
  return approvalsTo(state, o, { find, wallet: Math.max(0, at), row: 0, draft: undefined, typing: undefined })
}

function onPaletteKey(state: UiState, overlay: Extract<Overlay, { kind: "palette" }>, key: Key, ctx: UiContext, now: number): Step {
  const found = paletteFound(state, ctx, overlay.query)
  const index = Math.min(overlay.index, Math.max(0, found.length - 1))
  const move = (delta: number) => done({ ...state, overlay: { ...overlay, index: Math.max(0, Math.min(found.length - 1, index + delta)) } })
  const search = (query: string) => done({ ...state, overlay: { kind: "palette", query, index: 0 } })
  switch (key.name) {
    case "up":
      return move(-1)
    case "down":
      return move(1)
    case "pageup":
      return move(-10)
    case "pagedown":
      return move(10)
    case "return":
    case "enter":
      return runPalette(state, found[index], ctx, now)
    case "escape":
      return done({ ...state, overlay: undefined })
    case "backspace":
      return search(overlay.query.slice(0, -1))
  }
  // ctrl-u clears the search, as it clears the input line (else a second search runs on into the first, as "presetmemory").
  if (pressed(key, "clearLine")) return search("")
  const ch = key.sequence ?? ""
  if (key.ctrl || key.meta || ch.length !== 1 || ch < " " || ch === "\u007f") return done(state)
  return search(overlay.query + ch)
}

/** The Journal's search line taking keys, or giving them back; its highlight goes while it types. */
function searching(state: UiState, on: boolean): UiState {
  const { editing: _was, ...rest } = state.journal ?? { query: "" }
  if (!on) return { ...state, journal: rest }
  const { journal: _lit, ...highlight } = state.highlight ?? {}
  return { ...unscrolled(state, "journal"), highlight, journal: { ...rest, editing: true } }
}

/** A new search: the rows start again at the newest. */
const journalTyped = (state: UiState, query: string): UiState => ({ ...unscrolled(state, "journal"), journal: { ...(state.journal ?? { query: "" }), query } })

/**
 * A key while the Journal's search line takes keys. Typing searches as it goes; ⏎ keeps
 * the search and gives ↑/↓ back to the rows, never approving; Esc gives the keys back to the input line;
 * ↓ goes to the first row; ↑ to the tab bar. Anything else (ctrl-k, ctrl-n…) gives the keys back and acts as usual.
 */
function onJournalKey(state: UiState, s: JournalSearch, key: Key, ctx: UiContext, now: number): Step | undefined {
  switch (key.name) {
    case "return":
    case "enter":
      return done(searching(state, false))
    case "escape":
      return done(toAgent(searching(state, false), ctx))
    case "backspace":
      return done(journalTyped(state, s.query.slice(0, -1)))
    case "down":
      return moveHighlight(searching(state, false), "journal", 1, ctx, now) ?? done(searching(state, false))
    case "up":
      return done({ ...searching(state, false), focus: "tabs" })
  }
  if (pressed(key, "clearLine")) return done(journalTyped(state, ""))
  const ch = key.sequence ?? ""
  if (!key.ctrl && !key.meta && ch.length === 1 && ch >= " " && ch !== "\u007f") return done(journalTyped(state, s.query + ch))
  // Not the search's: the keys go back, and the key does what it does.
  const left = searching(state, false)
  return key.name === "tab" || key.ctrl || key.meta ? onKey(left, key, ctx, now) : done(left)
}

/**
 * A click on a Wallets row: a group's line opens it at once, or folds it when it's the open
 * one; a wallet's opens its group. The row is highlighted either way.
 */
function walletsClicked(state: UiState, id: string): UiState {
  const group = groupOfRow(id)
  if (group === undefined) return state
  const open = id.startsWith("g:") && state.wallets?.open === group ? undefined : group
  const { open: _was, ...rest } = state.wallets ?? {}
  return { ...state, wallets: { ...rest, ...(open !== undefined ? { open } : {}) } }
}

/** The Wallets pane's search line taking keys, or giving them back; it starts empty, and its highlight goes while it types. */
function walletsSearching(state: UiState, on: boolean): UiState {
  const find = state.wallets?.find ?? { query: "" }
  const { editing: _was, ...rest } = find
  // Given back with nothing typed, there's no search.
  if (!on) return rest.query.trim() ? { ...state, wallets: { ...state.wallets, find: rest } } : walletsUnsearched(state)
  const { wallets: _lit, ...highlight } = state.highlight ?? {}
  return { ...unscrolled(state, "wallets"), highlight, wallets: { ...state.wallets, find: { ...rest, editing: true } } }
}

/** The search ended: the pane is its groups again. */
function walletsUnsearched(state: UiState): UiState {
  const { find: _gone, ...rest } = state.wallets ?? {}
  return { ...unscrolled(state, "wallets"), wallets: rest }
}

const walletsTyped = (state: UiState, query: string): UiState => ({ ...unscrolled(state, "wallets"), wallets: { ...state.wallets, find: { query, editing: true } } })

/**
 * A key while the Wallets pane's search takes keys, as the Journal's: typing finds as it
 * goes; ⏎ keeps what it found and gives ↑/↓ back to the rows, never approving; Esc ends the search; ↓ goes to
 * the first row found; ↑ to the tab bar. Anything else gives the keys back and acts as usual.
 */
function onWalletsFindKey(state: UiState, f: WalletsFind, key: Key, ctx: UiContext, now: number): Step | undefined {
  switch (key.name) {
    case "return":
    case "enter":
      return done(f.query.trim() ? walletsSearching(state, false) : walletsUnsearched(state))
    case "escape":
      return done(walletsUnsearched(state))
    case "backspace":
      return done(walletsTyped(state, f.query.slice(0, -1)))
    case "down":
      return moveHighlight(walletsSearching(state, false), "wallets", 1, ctx, now) ?? done(walletsSearching(state, false))
    case "up":
      return done({ ...walletsSearching(state, false), focus: "tabs" })
  }
  if (pressed(key, "clearLine")) return done(walletsTyped(state, ""))
  const ch = key.sequence ?? ""
  if (!key.ctrl && !key.meta && ch.length === 1 && ch >= " " && ch !== "\u007f") return done(walletsTyped(state, f.query + ch))
  const left = walletsSearching(state, false)
  return key.name === "tab" || key.ctrl || key.meta ? onKey(left, key, ctx, now) : done(left)
}

/** The Wallets pane's `all groups ▾` menu, opened on the choice that's on. */
function openWalletsMenu(state: UiState, ctx: UiContext, now: number, at: { x?: number; y?: number } = {}): Step {
  const rows = walletsMenuRows(ctx.walletGroups ?? [], ctx.walletsShown)
  if (!(ctx.walletGroups ?? []).length) return done(say(state, "You have no wallet groups yet: group <name> add <wallet>, or group <name> prefix bot- for every wallet whose name starts bot-.", now))
  const index = Math.max(0, rows.findIndex((r) => r.on))
  return done({ ...state, overlay: { kind: "walletsMenu", index, ...(at.x !== undefined ? { x: at.x } : {}), ...(at.y !== undefined ? { y: at.y } : {}) } })
}

/** A row of the menu picked: the panes show it, kept by the core as `[wallets] show`. */
function pickWalletsMenu(state: UiState, index: number, ctx: UiContext, now: number): Step {
  const row = walletsMenuRows(ctx.walletGroups ?? [], ctx.walletsShown)[index]
  const closed: UiState = { ...state, overlay: undefined }
  if (!row) return done(closed)
  if (row.on) return done(say(closed, `The panes show ${row.label} already.`, now))
  return done(unscrolled(closed, "wallets"), { type: "walletsShow", show: row.value })
}

/** The overlay of every wallet, from the palette. */
export const openEveryWallet = (state: UiState): Step => done({ ...state, overlay: { kind: "everyWallet", query: "", index: 0, picked: [] } })

/** `name N…`: the start the picked share goes in "from", for the new start to be typed in "to". */
function openNaming(state: UiState, o: EveryWalletState, ctx: UiContext, now: number): Step {
  const names = o.picked.map((a) => (ctx.allWallets ?? []).find((w) => w.address === a)).filter((w) => w !== undefined).map((w) => viewName(w!))
  if (names.length === 0) return done(say(state, "Pick the wallets to name first: ⏎ on a wallet, or on a group for all of it.", now))
  const from = sharedStart(names)
  return done({ ...state, overlay: { ...o, naming: { from, to: from, each: {}, field: from ? 1 : 2 } } })
}

/** ⏎ in the naming step: every new name checked here first, then the lot to the core as one. */
function previewNames(state: UiState, o: EveryWalletState, ctx: UiContext, now: number): Step {
  if (!o.naming) return openNaming(state, o, ctx, now)
  const rows = namingRows(ctx.allWallets ?? [], o.picked, o.naming, ctx.walletNames ?? [], ctx.walletGroups ?? [])
  const bad = rows.find((r) => r.problem)
  if (bad) return done(say(state, `${bad.now} → ${bad.next || "(blank)"}: ${bad.problem}. Nothing was sent.`, now, "error"))
  const asks = namingAsks(rows)
  if (asks.length === 0) return done(say(state, "No name changes yet: type the new start, or a name of its own on its row.", now))
  return done({ ...state, overlay: undefined }, { type: "nameWallets", names: asks })
}

/**
 * Keys in the overlay of every wallet. On the list: typing finds; ↑/↓ a row; ⏎ picks a wallet, or a group's
 * all; → or the `name N…` chip opens the naming step; Esc clears the search, then closes. In the naming step:
 * ↑/↓ or tab move between the new start and each name, typing edits it, ⏎ previews, Esc goes back.
 */
function onEveryWalletKey(state: UiState, o: EveryWalletState, key: Key, ctx: UiContext, now: number): Step {
  const ch = key.sequence ?? ""
  const typed = !key.ctrl && !key.meta && ch.length === 1 && ch >= " " && ch !== "\u007f"
  if (o.naming) {
    const n = o.naming
    const rows = namingRows(ctx.allWallets ?? [], o.picked, n, ctx.walletNames ?? [], ctx.walletGroups ?? [])
    const fields = 2 + rows.length
    const set = (next: Partial<typeof n>) => done({ ...state, overlay: { ...o, naming: { ...n, ...next } } })
    const edit = (f: (text: string) => string) => {
      if (n.field === 0) return set({ from: f(n.from) })
      if (n.field === 1) return set({ to: f(n.to) })
      const row = rows[n.field - 2]
      return row ? set({ each: { ...n.each, [row.address]: f(n.each[row.address] ?? row.next) } }) : done(state)
    }
    switch (key.name) {
      case "escape":
        return done({ ...state, overlay: { kind: "everyWallet", query: o.query, index: o.index, picked: o.picked } })
      case "return":
      case "enter":
        return previewNames(state, o, ctx, now)
      case "up":
        return set({ field: Math.max(0, n.field - 1) })
      case "down":
      case "tab":
        return set({ field: Math.min(fields - 1, n.field + (key.shift ? -1 : 1)) })
      case "backspace":
        return edit((t) => t.slice(0, -1))
    }
    if (pressed(key, "clearLine")) return edit(() => "")
    return typed ? edit((t) => (t.length < 64 ? t + ch : t)) : done(state)
  }
  const rows = everyRows(ctx.allWallets ?? [], ctx.walletGroups ?? [], o.query)
  const move = (by: number) => done({ ...state, overlay: { ...o, index: Math.max(0, Math.min(rows.length - 1, o.index + by)) } })
  const find = (query: string) => done({ ...state, overlay: { ...o, query, index: 0 } })
  switch (key.name) {
    case "escape":
      return o.query ? find("") : done({ ...state, overlay: undefined })
    case "up":
      return move(-1)
    case "down":
      return move(1)
    case "pageup":
      return move(-10)
    case "pagedown":
      return move(10)
    case "return":
    case "enter":
      return done({ ...state, overlay: { ...o, picked: togglePick(o.picked, rows[o.index]) } })
    case "right":
      return openNaming(state, o, ctx, now)
    case "backspace":
      return find(o.query.slice(0, -1))
  }
  if (pressed(key, "clearLine")) return find("")
  return typed && o.query.length < 64 ? find(o.query + ch) : done(state)
}

/** Help's lines: the commands you can type, then every key from the table. */
export const helpLines = (): string[] => [...HELP_LINES, "", ...keyLines()]

const tabCount = (ctx: UiContext): number => ctx.tabs?.length ?? DEFAULT_TABS.length

/** The pane the layout menu acts on: the focused one, when a pane has focus. */
export const menuFocus = (state: UiState): PaneId | undefined => (state.focus === "tabs" || state.focus === "cards" ? undefined : state.focus)

export function openLayoutMenu(state: UiState, ctx: UiContext, now: number): Step {
  if (!ctx.layout) return done(say({ ...state, overlay: undefined }, "The layouts haven't been read yet.", now))
  return done({ ...state, overlay: { kind: "layouts", index: 0 } })
}

/** A menu row picked: its edit goes to the frame; move and resize keep the menu open for another press. */
function pickLayoutRow(state: UiState, overlay: Extract<Overlay, { kind: "layouts" }>, index: number, ctx: UiContext, now: number): Step {
  const rows = ctx.layout ? layoutMenuRows(ctx.layout, menuFocus(state)) : []
  const row = rows[index]
  if (!row) return done(state)
  if (row.naming) return done({ ...state, overlay: { kind: "layouts", index, naming: "" } })
  // A pane's row with none focused: it takes focus, and the menu shows its rows from the top.
  if (row.focus) return done({ ...focusPane(state, row.focus), overlay: { kind: "layouts", index: 0 } })
  if (!row.op) return done(state)
  const next: UiState = row.stays ? { ...state, overlay: { ...overlay, index } } : { ...state, overlay: undefined }
  if (row.op.kind !== "close") return done(next, { type: "layout", op: row.op })
  // The closed pane had focus: it goes to the agent, or to the tab bar when the agent's gone too.
  const agentStays = row.op.pane !== "agent" && !!ctx.layout && panesOf(ctx.layout.current.root).includes("agent")
  return done({ ...next, focus: agentStays ? "agent" : "tabs" }, { type: "layout", op: row.op })
}

function onLayoutsKey(state: UiState, overlay: Extract<Overlay, { kind: "layouts" }>, key: Key, ctx: UiContext, now: number): Step {
  const rows = ctx.layout ? layoutMenuRows(ctx.layout, menuFocus(state)) : []
  if (overlay.naming !== undefined) {
    // Typing a name for "save as", a new tab or this tab's rename: Enter makes it, Esc goes back to the rows.
    const purpose = rows[overlay.index]?.naming ?? "saveAs"
    const naming = (text: string) => done({ ...state, overlay: { ...overlay, naming: text } })
    if (key.name === "escape") return done({ ...state, overlay: { kind: "layouts", index: overlay.index } })
    if (key.name === "backspace") return naming(overlay.naming.slice(0, -1))
    if (key.name === "return" || key.name === "enter") {
      const problem = purpose === "saveAs" ? nameProblem(overlay.naming) : tabNameProblem(overlay.naming, ctx.layout?.tabNames ?? [], purpose === "renameTab" ? ctx.layout?.tab : undefined)
      if (problem) return done(say(state, problem, now, "error"))
      const name = overlay.naming.trim()
      return done({ ...state, overlay: undefined }, { type: "layout", op: purpose === "addTab" ? { kind: "addTab", name } : purpose === "renameTab" ? { kind: "renameTab", name } : { kind: "saveAs", name } })
    }
    const ch = key.sequence ?? ""
    if (key.ctrl || key.meta || ch.length !== 1 || ch < " " || ch === "\u007f") return done(state)
    return naming(overlay.naming + ch)
  }
  const move = (delta: number) => done({ ...state, overlay: { ...overlay, index: Math.max(0, Math.min(rows.length - 1, overlay.index + delta)) } })
  switch (key.name) {
    case "up":
      return move(-1)
    case "down":
      return move(1)
    case "pageup":
      return move(-10)
    case "pagedown":
      return move(10)
    case "return":
    case "enter":
      return pickLayoutRow(state, overlay, Math.min(overlay.index, rows.length - 1), ctx, now)
  }
  return done({ ...state, overlay: undefined })
}

function onOverlayKey(state: UiState, key: Key, ctx: UiContext, now: number): Step {
  const overlay = state.overlay!
  const closed: UiState = { ...state, overlay: undefined }
  if (overlay.kind === "palette") return onPaletteKey(state, overlay, key, ctx, now)
  if (overlay.kind === "layouts") return onLayoutsKey(state, overlay, key, ctx, now)
  if (overlay.kind === "engines") return onEnginesKey(state, overlay, key, ctx)
  if (overlay.kind === "memory") return onMemoryKey(state, overlay, key, ctx)
  if (overlay.kind === "approvals") return onApprovalsKey(state, overlay, key, ctx, now)
  if (overlay.kind === "help") {
    if (pressed(key, "commands")) return openPalette(state, ctx, "cli")
    // Help scrolls where it doesn't fit; any other key closes it.
    const by = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -10 : key.name === "pagedown" ? 10 : 0
    if (by !== 0) return done({ ...state, overlay: { kind: "help", scroll: helpScrolled(overlay.scroll, by, ctx.helpMax) } })
    return done(closed)
  }
  if (overlay.kind === "journalRows") {
    // Its rows scroll where they don't fit; any other key closes them.
    const by = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -10 : key.name === "pagedown" ? 10 : 0
    if (by !== 0) return done({ ...state, overlay: { ...overlay, scroll: Math.max(0, Math.min(ctx.journal?.rowsMax ?? 0, (overlay.scroll ?? 0) + by)) } })
    return done(closed)
  }
  if (overlay.kind === "away") {
    // As a Journal row's details: its lines scroll where they don't fit; any other key closes them.
    const by = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -10 : key.name === "pagedown" ? 10 : 0
    if (by !== 0) return done({ ...state, overlay: { kind: "away", scroll: awayScrolled(overlay.scroll, by, ctx.awayMax) } })
    return done(closed)
  }
  if (overlay.kind === "confirmLive") {
    if (key.name === "y") return done(closed, { type: "mode", mode: "live" })
    return done(say(closed, "Staying in paper mode.", now))
  }
  if (overlay.kind === "everyWallet") return onEveryWalletKey(state, overlay, key, ctx, now)
  if (overlay.kind === "tour") {
    // → or ⏎ goes on (past the last, it ends), ← goes back, Esc ends it; any other key does nothing, so a stray letter never ends it.
    if (key.name === "right" || key.name === "return" || key.name === "enter" || key.name === "space") return tourTo(state, overlay.step + 1)
    if (key.name === "left") return tourTo(state, Math.max(0, overlay.step - 1))
    if (key.name === "escape") return done(closed)
    return done(state)
  }
  if (overlay.kind === "walletsMenu") {
    const n = walletsMenuRows(ctx.walletGroups ?? [], ctx.walletsShown).length
    if (key.name === "up") return done({ ...state, overlay: { ...overlay, index: Math.max(0, overlay.index - 1) } })
    if (key.name === "down") return done({ ...state, overlay: { ...overlay, index: Math.min(n - 1, overlay.index + 1) } })
    if (key.name === "return" || key.name === "enter") return pickWalletsMenu(state, overlay.index, ctx, now)
    return done(closed)
  }
  if (overlay.kind === "signalsMenu") {
    const n = signalsMenuRows(overlay.which, ctx.signals ?? {}).length
    if (key.name === "up") return done({ ...state, overlay: { ...overlay, index: Math.max(0, overlay.index - 1) } })
    if (key.name === "down") return done({ ...state, overlay: { ...overlay, index: Math.min(n - 1, overlay.index + 1) } })
    if (key.name === "return" || key.name === "enter") return pickSignalsMenu(state, overlay.which, overlay.index, ctx)
    return done(closed)
  }
  if (overlay.kind === "pnlMenu" && overlay.typing !== undefined) {
    const typing = (text: string) => done({ ...state, overlay: { ...overlay, typing: text } })
    if (key.name === "escape") return done({ ...state, overlay: { kind: "pnlMenu", index: overlay.index, ...(overlay.x !== undefined ? { x: overlay.x } : {}), ...(overlay.y !== undefined ? { y: overlay.y } : {}) } })
    if (key.name === "backspace") return typing(overlay.typing.slice(0, -1))
    if (key.name === "return" || key.name === "enter") {
      const parsed = parseWindow(overlay.typing)
      if (!parsed.ok) return done(say(state, `${overlay.typing ? `"${overlay.typing}" isn't a time of day` : "Type a time of day"}: such as 07:30, then ⏎.`, now, "error"))
      return setPnlWindow(closed, parsed.window, ctx, now)
    }
    const ch = key.sequence ?? ""
    if (key.ctrl || key.meta || !/^[0-9:]$/.test(ch) || overlay.typing.length >= 5) return done(state)
    return typing(overlay.typing + ch)
  }
  if (overlay.kind === "pnlMenu") {
    const n = pnlWindowRows(ctx.pnlWindow).length
    if (key.name === "up") return done({ ...state, overlay: { ...overlay, index: Math.max(0, overlay.index - 1) } })
    if (key.name === "down") return done({ ...state, overlay: { ...overlay, index: Math.min(n - 1, overlay.index + 1) } })
    if (key.name === "return" || key.name === "enter") return pickPnlMenu(state, overlay.index, ctx, now)
    return done(closed)
  }
  if (overlay.kind === "settings") {
    if (key.name === "up") return done({ ...state, overlay: { kind: "settings", index: Math.max(0, overlay.index - 1) } })
    if (key.name === "down") return done({ ...state, overlay: { kind: "settings", index: Math.min(settingsCount(ctx) - 1, overlay.index + 1) } })
    if (key.name === "return" || key.name === "enter") return runSettings(state, overlay.index, ctx, now)
    return done(closed)
  }
  if (overlay.kind === "agents") {
    // The agents, then one more row: only the active agent in positions, wallets and activity.
    if (key.name === "up") return done({ ...state, overlay: { kind: "agents", index: Math.max(0, overlay.index - 1) } })
    if (key.name === "down") return done({ ...state, overlay: { kind: "agents", index: Math.min(ctx.agents.length, overlay.index + 1) } })
    if (key.name === "return") {
      if (overlay.index === ctx.agents.length) return done({ ...closed, oneAgent: !state.oneAgent })
      const agent = ctx.agents[overlay.index]
      return agent ? done(closed, { type: "setAgent", agent }) : done(closed)
    }
    return done(closed)
  }
  // Help (but for `c`) and card details: any key closes them.
  return done(closed)
}

/**
 * The tour, on the tab named or the first with the agent pane, so every stop is on screen. Only
 * the tab changes: no pane opens or closes (memory `clicks-never-add-panes`), and the focus stays.
 */
function openTour(state: UiState, ctx: UiContext, tab = ctx.tourTab): Step {
  const at = tab !== undefined && tab >= 0 ? Math.min(tabCount(ctx) - 1, tab) : state.tab
  return done({ ...state, tab: at, overlay: { kind: "tour", step: 0 } })
}
/** The tour at stop `step`; past the last, it ends. */
const tourTo = (state: UiState, step: number): Step => done({ ...state, overlay: step >= TOUR_STOPS.length ? undefined : { kind: "tour", step } })

/** Help scrolled `by` lines, within its lines (the frame shows as many as fit). */
/** Help's scroll, held to its rows as drawn (wrapped) when the frame says how many; a source line each otherwise. */
const helpScrolled = (scroll: number | undefined, by: number, max = helpLines().length - 1): number => Math.max(0, Math.min(max, (scroll ?? 0) + by))
const awayScrolled = (scroll: number | undefined, by: number, max = 0): number => Math.max(0, Math.min(max, (scroll ?? 0) + by))

function onKey(state: UiState, key: Key, ctx: UiContext, now: number): Step {
  // The kill switch works from anywhere, overlays included.
  if (pressed(key, "kill")) {
    if (state.killArmedAt !== undefined && now - state.killArmedAt <= KILL_WINDOW_MS) {
      return done({ ...state, killArmedAt: undefined, overlay: undefined, message: undefined }, { type: "kill" })
    }
    return done({ ...state, killArmedAt: now, quitArmedAt: undefined, message: { text: "ctrl-x again to kill", level: "error", at: now } })
  }
  // Any other key cancels an armed kill.
  const s: UiState = state.killArmedAt !== undefined ? { ...state, killArmedAt: undefined, message: undefined } : state

  if (pressed(key, "quit")) {
    if (s.overlay) return done({ ...s, overlay: undefined })
    if (s.input !== "") return done({ ...s, input: "", cursor: 0, quitArmedAt: undefined })
    if (s.quitArmedAt !== undefined && now - s.quitArmedAt <= QUIT_WINDOW_MS) return done(s, { type: "quit" })
    return done({ ...s, quitArmedAt: now, message: { text: "ctrl-c again to quit", level: "info", at: now } })
  }
  const t: UiState = s.quitArmedAt !== undefined ? { ...s, quitArmedAt: undefined, message: undefined } : s

  if (pressed(key, "oneAgent")) return runKey(t, "oneAgent", ctx, now)
  if (pressed(key, "ask")) return runKey(t, "ask", ctx, now)
  if (pressed(key, "picker")) return t.overlay?.kind === "engines" ? done({ ...t, overlay: undefined }) : openPicker(t, ctx, now)
  // The palette, from anywhere: over another overlay it takes its place; over itself it closes.
  if (pressed(key, "palette")) return t.overlay?.kind === "palette" ? done({ ...t, overlay: undefined }) : openPalette({ ...t, overlay: undefined }, ctx)

  if (t.overlay) return onOverlayKey(t, key, ctx, now)
  if (t.focus === "journal" && t.journal?.editing) {
    const typed = onJournalKey(t, t.journal, key, ctx, now)
    if (typed) return typed
  }
  if (t.focus === "wallets" && t.wallets?.find?.editing) {
    const typed = onWalletsFindKey(t, t.wallets.find, key, ctx, now)
    if (typed) return typed
  }
  if (pressed(key, "popOut")) return runKey(t, "popOut", ctx, now)

  const empty = t.input === ""
  const card = focusedCard(t, ctx)
  switch (key.name) {
    case "return":
    case "enter":
      return empty ? approve(t, card, ctx, now, "enter") : submit(t, ctx, now)
    case "backspace":
      return t.cursor === 0 ? done(t) : done({ ...t, input: t.input.slice(0, t.cursor - 1) + t.input.slice(t.cursor), cursor: t.cursor - 1 })
    case "delete":
      return done({ ...t, input: t.input.slice(0, t.cursor) + t.input.slice(t.cursor + 1) })
    case "home":
      return done({ ...t, cursor: 0 })
    case "end":
      return done({ ...t, cursor: t.input.length })
    case "escape":
      // A search in the Wallets pane ends first, as its last line says.
      if (empty && t.focus === "wallets" && t.wallets?.find) return done(walletsUnsearched(t))
      // Esc stops the agent's turn, as in the harnesses themselves; only with nothing typed, so it never eats a line.
      if (empty && ctx.working && ctx.activeAgent) return runKey(t, "stop", ctx, now)
      // On a typed line, a second Esc clears it, as people expect.
      if (!empty && t.escArmedAt !== undefined && now - t.escArmedAt <= QUIT_WINDOW_MS) return done({ ...toAgent(t, ctx), input: "", cursor: 0, escArmedAt: undefined, message: undefined })
      if (!empty) return done({ ...toAgent(t, ctx), escArmedAt: now, message: { text: "esc again to clear the line", level: "info", at: now } })
      return done(toAgent(t, ctx))
    case "tab": {
      const order = stops(t, ctx)
      const i = order.indexOf(t.focus)
      const next = order[(i + (key.shift ? order.length - 1 : 1)) % order.length]!
      return done(next === "tabs" || next === "cards" ? { ...t, focus: next } : focusPane(t, next))
    }
    case "left":
    case "right": {
      const delta = key.name === "left" ? -1 : 1
      // With text on the line, the arrows edit it.
      if (!empty) return done({ ...t, cursor: Math.max(0, Math.min(t.input.length, t.cursor + delta)) })
      if (t.focus === "tabs") return done({ ...t, tab: (t.tab + tabCount(ctx) + delta) % tabCount(ctx) })
      const group = navOf(ctx).group
      const from: PaneId = t.focus === "cards" ? "agent" : t.focus
      // A collapsed group: ←/→ switch its pane (← from the first goes back to the pane beside it).
      const at = group.indexOf(from)
      if (at >= 0 && !(delta < 0 && at === 0)) return done(focusPane(t, group[(at + group.length + delta) % group.length]!))
      const to = arrowTo(t, ctx, from, key.name as Direction)
      // ← from the cards is the agent pane they sit in.
      if (to) return done(focusPane(t, to))
      return done(t.focus === "cards" && delta < 0 ? toAgent(t, ctx) : t)
    }
    case "pageup":
    case "pagedown": {
      const delta = key.name === "pageup" ? SCROLL_PAGE : -SCROLL_PAGE
      // Every pane scrolls; the cards don't.
      return done(t.focus === "tabs" || t.focus === "cards" ? t : scrolled(t, t.focus, delta, ctx))
    }
    case "up":
    case "down": {
      const delta = key.name === "up" ? -1 : 1
      // Down from the tab bar is the agent pane, or the layout's first without one.
      if (t.focus === "tabs") return done(delta > 0 ? focusPane(t, navOf(ctx).order.includes("agent") ? "agent" : navOf(ctx).order[0] ?? "agent") : t)
      if (t.focus === "cards") {
        const first = card !== undefined && ctx.cards.indexOf(card) === 0
        if (delta < 0 && first) return done(toAgent(t, ctx))
        return done(moveCard(t, ctx, delta))
      }
      // The agent pane: down into its cards.
      if (t.focus === "agent" && delta > 0 && ctx.cards.length > 0) return done({ ...t, focus: "cards" })
      // The Journal with no row highlighted: ↑ is its search line, just above.
      if (t.focus === "journal" && delta < 0 && !t.highlight?.journal) return done(searching(t, true))
      // A pane with token rows: ↑/↓ move its highlight; past its first or last row, as below.
      const row = moveHighlight(t, t.focus, delta, ctx, now)
      if (row) return row
      // The Journal: ↑ from its first row is its search line; ↓ from its last reads the next page.
      if (t.focus === "journal" && delta < 0) return done(searching(t, true))
      // The Wallets pane's search, while it's on: ↑ from its first row takes keys again.
      if (t.focus === "wallets" && delta < 0 && t.wallets?.find) return done(walletsSearching(t, true))
      if (t.focus === "journal" && delta > 0 && ctx.journal?.more) return done(t, { type: "journalOlder" })
      // ↑/↓ step to the pane above or below; up from the top is the tab bar.
      const to = arrowTo(t, ctx, t.focus, key.name as Direction)
      if (to) return done(focusPane(t, to))
      return done(delta < 0 ? { ...t, focus: "tabs" } : t)
    }
  }

  if (pressed(key, "reject")) return runKey(t, "reject", ctx, now)
  if (pressed(key, "details")) return runKey(t, "details", ctx, now)
  if (pressed(key, "requote")) return runKey(t, "requote", ctx, now)
  if (pressed(key, "clearLine")) return done({ ...t, input: "", cursor: 0 })
  if (pressed(key, "lineEnds")) return done({ ...t, cursor: key.name === "a" ? 0 : t.input.length })

  const ch = key.sequence ?? ""
  if (key.ctrl || key.meta || ch.length !== 1 || ch < " " || ch === "\u007f") return done(t)

  if (empty) {
    if (pressed(key, "help")) return runKey(t, "help", ctx, now)
    // A digit picks a tab only from the tab bar: on the line it types, as every bare key does (with
    // a second tab, "2 SOL of…" would have switched tabs).
    if (t.focus === "tabs" && /^[1-9]$/.test(ch) && Number(ch) <= tabCount(ctx)) return done({ ...t, tab: Number(ch) - 1 })
  }
  return done(insert(t, ch))
}

const BASE58 = "[1-9A-HJ-NP-Za-km-z]"
// Terminal.app sends a pasted line break as a bare \r; tmux and most others as \n.
const WRAPPED = new RegExp(`(${BASE58}+)[ \\t]*(?:\\r\\n?|\\n)[ \\t]*(${BASE58}+)`, "g")

/** A line break between two runs of address characters that together are an address's length (32 to 44) is taken out. */
export function joinWrappedAddresses(text: string): string {
  return text.replace(WRAPPED, (all, left: string, right: string) => (left.length + right.length >= 32 && left.length + right.length <= 44 ? left + right : all))
}

export function step(state: UiState, action: UiAction, ctx: UiContext): Step {
  const next = stepOnce(state, action, ctx)
  // The Journal's search takes keys only while the Journal has focus: a click or a key elsewhere gives them back.
  if (next.state.journal?.editing && next.state.focus !== "journal") return { ...next, state: searching(next.state, false) }
  if (next.state.wallets?.find?.editing && next.state.focus !== "wallets") return { ...next, state: walletsSearching(next.state, false) }
  return next
}

function stepOnce(state: UiState, action: UiAction, ctx: UiContext): Step {
  switch (action.type) {
    case "key":
      // The numpad's Enter: kitty and Ghostty report it as its own key (kitty keyboard protocol,
      // 57414), Terminal.app as Enter. Unmapped, it did nothing in kitty and Ghostty.
      return onKey(state, action.key.name === "kpenter" ? { ...action.key, name: "return" } : action.key, ctx, action.now)
    case "paste": {
      // A paste is text on the line, never a sent command: newlines become spaces, control characters go.
      // A break inside an address (copied across a terminal's wrap) joins with no space.
      const text = joinWrappedAddresses(action.text).replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")
      // Into the palette's search while it's open, and the Journal's while it takes keys.
      if (state.overlay?.kind === "palette") return done({ ...state, overlay: { kind: "palette", query: state.overlay.query + text, index: 0 } })
      if (state.focus === "journal" && state.journal?.editing) return done(journalTyped(state, state.journal.query + text))
      return done(insert({ ...state, killArmedAt: undefined }, text))
    }
    case "tick": {
      let s = state
      if (s.killArmedAt !== undefined && action.now - s.killArmedAt > KILL_WINDOW_MS) s = { ...s, killArmedAt: undefined, message: undefined }
      if (s.quitArmedAt !== undefined && action.now - s.quitArmedAt > QUIT_WINDOW_MS) s = { ...s, quitArmedAt: undefined, message: undefined }
      // An error, or a command offered to copy, stays long enough to read and act on.
      if (s.message && action.now - s.message.at > (s.message.level === "error" || s.message.copy !== undefined ? ERROR_MESSAGE_MS : MESSAGE_MS)) s = { ...s, message: undefined }
      return settle(s, action.now)
    }
    case "clickTab":
      return done({ ...state, tab: Math.max(0, Math.min(tabCount(ctx) - 1, action.tab)), focus: "tabs" })
    case "showTab":
      return done({ ...state, tab: Math.max(0, Math.min(tabCount(ctx) - 1, action.tab)) })
    case "openTour":
      return openTour(state, ctx, action.tab)
    case "tourNext":
      return state.overlay?.kind === "tour" ? tourTo(state, state.overlay.step + 1) : done(state)
    case "showPane":
      return done({ ...state, recent: [action.pane, ...state.recent.filter((p) => p !== action.pane)] })
    case "journalSet": {
      // A new search starts at the newest, with no row lit; a search the person was typing in keeps taking keys.
      const { journal: _lit, ...highlight } = state.highlight ?? {}
      const journal: JournalSearch = { ...action.search, ...(state.journal?.editing ? { editing: true as const } : {}) }
      return done({ ...unscrolled(state, "journal"), highlight, journal })
    }
    case "clickCard": {
      // A click on a card picks its token too.
      const mint = ctx.cards.find((c) => c.cardId === action.cardId)?.display.mint
      return done({ ...state, focus: "cards", focusedCardId: action.cardId }, ...(mint ? [{ type: "link" as const, mint, from: "a card" }] : []))
    }
    case "clickApprove":
      return approve({ ...state, focusedCardId: action.cardId }, ctx.cards.find((c) => c.cardId === action.cardId), ctx, action.now, "click")
    case "clickReject":
      return done(state, { type: "reject", cardId: action.cardId })
    case "clickDetails":
      return done({ ...state, focus: "cards", focusedCardId: action.cardId, overlay: { kind: "card", cardId: action.cardId } })
    case "closeOverlay":
      return done({ ...state, overlay: undefined })
    case "clickAgent":
      return done({ ...state, overlay: { kind: "agents", index: Math.max(0, ctx.agents.indexOf(ctx.activeAgent ?? "")) } })
    case "pickAgent":
      return done({ ...state, overlay: undefined }, { type: "setAgent", agent: action.agent })
    case "clickMode":
      return switchMode(state, ctx.mode === "live" ? "paper" : "live", ctx, action.now)
    case "clickKill":
      return done({ ...state, killArmedAt: undefined }, { type: "kill" })
    case "clickResume":
      return done(state, { type: "command", command: { kind: "resume" } })
    case "clickStopHelp":
      return done({ ...state, overlay: { kind: "stopHelp" } })
    case "clickCopy":
      if (action.what !== undefined) return done(state, { type: "copy", text: action.text, what: action.what })
      return done({ ...state, shownInFull: { text: action.text, until: action.now + SHOWN_IN_FULL_MS } }, { type: "copy", text: action.text })
    case "clickOpenToken":
      // Opens it only: the link moves to a token Candle has a market for, and nothing trades.
      return done(state, { type: "link", mint: action.mint, ...(action.mint.startsWith("0x") ? { chain: "hood" as const } : {}), from: "the agent's reply, by a click" })
    case "clickFill":
      return done({ ...state, input: action.text, cursor: action.text.length })
    case "clickAsk":
      return askAgent(state)
    case "popOutPane":
      return popOut(state, ctx, action.now, action.pane)
    case "clickHelp":
      return done({ ...state, overlay: { kind: "help" } })
    case "clickPane":
      return done(focusPane(state, action.pane))
    case "clickRow": {
      const was = state.highlight?.[action.pane]
      if (action.pane === "wallets") return done(walletsClicked(highlighted(focusPane(state, "wallets"), "wallets", action.pick, action.now, ctx, true), action.pick.id))
      const picked = highlighted(focusPane(state, action.pane), action.pane, action.pick, action.now, ctx, true)
      // A second click on the row that's already the link picks nothing new (not one pick and two journal rows).
      if (!action.pick.mint || (was?.sent === true && was.id === action.pick.id && was.mint === action.pick.mint)) return done(picked)
      return done(picked, { type: "link", mint: action.pick.mint, ...(action.pick.chain ? { chain: action.pick.chain } : {}), from: `${action.pane}, by a click` })
    }
    case "clickAskRow":
      return askRow(state, ctx, action.now, { pane: action.pane, id: action.id })
    case "clickRequote":
      return done(state, { type: "requote", cardId: action.cardId })
    case "clickPayFrom":
      return done({ ...state, overlay: undefined }, { type: "requote", cardId: action.cardId, wallet: action.wallet })
    case "clickResolve":
      return done(state, { type: "resolve", cardId: action.cardId, action: action.action })
    case "scroll":
      return done(scrolled(state, action.pane, action.delta, ctx))
    case "toggleOneAgent":
      return done({ ...state, oneAgent: !state.oneAgent, ...(state.overlay?.kind === "agents" ? { overlay: undefined } : {}) })
    case "clickLayoutMenu":
      return state.overlay?.kind === "layouts" ? done({ ...state, overlay: undefined }) : openLayoutMenu(state, ctx, action.now)
    case "clickSettings":
      return done({ ...state, overlay: state.overlay?.kind === "settings" ? undefined : { kind: "settings", index: 0 } })
    case "clickSaveLayout":
      return openSaveAs({ ...state, overlay: undefined }, ctx, action.now)
    case "pickSettings":
      return runSettings(state, action.index, ctx, action.now)
    case "walletsFind":
      return done(walletsSearching(focusPane({ ...state, overlay: undefined }, "wallets"), true))
    case "clickWalletsGroups":
      return state.overlay?.kind === "walletsMenu" ? done({ ...state, overlay: undefined }) : openWalletsMenu(state, ctx, action.now, action)
    case "pickWalletsMenu":
      return pickWalletsMenu(state, action.index, ctx, action.now)
    case "everyWallet": {
      const o = state.overlay?.kind === "everyWallet" ? state.overlay : undefined
      if (!o) return done(state)
      if (action.which === "pick") return done({ ...state, overlay: { ...o, index: action.index ?? o.index, picked: togglePick(o.picked, everyRows(ctx.allWallets ?? [], ctx.walletGroups ?? [], o.query)[action.index ?? o.index]) } })
      if (action.which === "clear") return done({ ...state, overlay: { ...o, picked: [] } })
      if (action.which === "name") return openNaming(state, o, ctx, action.now)
      if (action.which === "back") return done({ ...state, overlay: { kind: "everyWallet", query: o.query, index: o.index, picked: o.picked } })
      return previewNames(state, o, ctx, action.now)
    }
    case "pickApprovals": {
      const o = state.overlay?.kind === "approvals" ? state.overlay : undefined
      if (!o) return done(state)
      if (action.wallet !== undefined) return done(approvalsTo(state, o, { wallet: action.wallet, side: "wallets", row: 0, draft: undefined, typing: undefined }))
      return action.row ? actApprovals(state, o, action.row, ctx, action.now) : done(state)
    }
    case "clickStrip":
      return done({ ...state, focus: "cards" })
    case "scrollLayoutMenu": {
      const o = state.overlay
      if (o?.kind !== "layouts" || o.naming !== undefined || !ctx.layout) return done(state)
      const n = layoutMenuRows(ctx.layout, menuFocus(state)).length
      return done({ ...state, overlay: { ...o, index: Math.max(0, Math.min(n - 1, o.index + action.delta)) } })
    }
    case "pickLayoutRow":
      return state.overlay?.kind === "layouts" ? pickLayoutRow(state, state.overlay, action.index, ctx, action.now) : done(state)
    case "clickSignalsChip":
      // Your rules or Hacc's tape: other rows, so the view starts again at the newest.
      if (action.which === "source") return changeSignals(state, { mine: !ctx.signals?.mine })
      return state.overlay?.kind === "signalsMenu" && state.overlay.which === action.which ? done({ ...state, overlay: undefined }) : openSignalsMenu({ ...state, overlay: undefined }, action.which, ctx, { ...(action.x !== undefined ? { x: action.x } : {}), ...(action.y !== undefined ? { y: action.y } : {}) })
    case "pickSignalsMenu":
      return state.overlay?.kind === "signalsMenu" ? pickSignalsMenu(state, state.overlay.which, action.index, ctx) : done(state)
    case "pauseSignals":
      return done(pauseSignals(state, action.on, ctx))
    case "clearSignals":
      return changeSignals(state, { pattern: null, chain: null })
    case "clickPnlWindow":
      return state.overlay?.kind === "pnlMenu" ? done({ ...state, overlay: undefined }) : openPnlMenu({ ...state, overlay: undefined }, ctx, { ...(action.x !== undefined ? { x: action.x } : {}), ...(action.y !== undefined ? { y: action.y } : {}) })
    case "pickPnlMenu":
      return state.overlay?.kind === "pnlMenu" ? pickPnlMenu(state, action.index, ctx, action.now) : done(state)
    case "pnlSpan":
      return done({ ...state, pnlSpan: action.span })
    case "listsSource":
      return done({ ...state, lists: action.source ?? nextListSource(state.lists, action.delta ?? 1) })
    case "journalSearch":
      return done(searching(focusPane(state, "journal"), true))
    case "journalKind":
      return done({ ...unscrolled(state, "journal"), journal: toggleKind(state.journal, action.kind) })
    case "journalOlder":
      return done(state, { type: "journalOlder" })
    case "scrollJournalRows": {
      const o = state.overlay
      return o?.kind === "journalRows" ? done({ ...state, overlay: { ...o, scroll: Math.max(0, Math.min(ctx.journal?.rowsMax ?? 0, (o.scroll ?? 0) + action.delta)) } }) : done(state)
    }
    case "pickPalette": {
      const o = state.overlay
      return o?.kind === "palette" ? runPalette(state, paletteFound(state, ctx, o.query).find((r) => r.id === action.id), ctx, action.now) : done(state)
    }
    case "clickPalette":
      return state.overlay?.kind === "palette" ? done({ ...state, overlay: undefined }) : openPalette({ ...state, overlay: undefined }, ctx)
    case "scrollPalette": {
      const o = state.overlay
      if (o?.kind !== "palette") return done(state)
      const last = paletteFound(state, ctx, o.query).length - 1
      return done({ ...state, overlay: { ...o, index: Math.max(0, Math.min(last, o.index + action.delta)) } })
    }
    case "scrollHelp": {
      const o = state.overlay
      return o?.kind === "help" ? done({ ...state, overlay: { kind: "help", scroll: helpScrolled(o.scroll, action.delta, ctx.helpMax) } }) : done(state)
    }
    case "openAway":
      return done({ ...state, overlay: { kind: "away" } })
    case "scrollAway": {
      const o = state.overlay
      return o?.kind === "away" ? done({ ...state, overlay: { kind: "away", scroll: awayScrolled(o.scroll, action.delta, ctx.awayMax) } }) : done(state)
    }
    case "pickAway":
      // A token's row moves the link and closes the overlay, so the token pane shows it.
      return action.pick.mint ? done({ ...state, overlay: undefined }, { type: "link", mint: action.pick.mint, ...(action.pick.chain ? { chain: action.pick.chain } : {}), from: "while you were away, by a click" }) : done(state)
    case "clickEngineChip":
      return openPicker(state, ctx, action.now)
    case "pickEngine": {
      const o = state.overlay
      if (o?.kind !== "engines") return done(state)
      return pickEngine(state, o.agent, { kind: "model", engine: action.engine, ...(action.model !== undefined ? { model: action.model } : {}), text: "", current: false })
    }
    case "pickPreset": {
      const o = state.overlay
      if (o?.kind !== "engines") return done(state)
      return pickEngine(state, o.agent, { kind: "preset", preset: action.preset, text: "", current: false })
    }
    case "deleteMemory": {
      const o = state.overlay
      return o?.kind === "memory" ? deleteMemory(state, o, action.row) : done(state)
    }
    case "clickMemoryClear": {
      const o = state.overlay
      return o?.kind === "memory" ? deleteMemory(state, o, { kind: "clear" }) : done(state)
    }
    case "scrollEngines": {
      const o = state.overlay
      if (o?.kind !== "engines") return done(state)
      const last = pickable(ctx.engines?.rows(o.query, o.agent) ?? []).length - 1
      return done({ ...state, overlay: { ...o, index: Math.max(0, Math.min(last, o.index + action.delta)), moved: true } })
    }
    case "modelsRead": {
      const o = state.overlay
      if (o?.kind !== "engines" || o.moved) return done(state)
      return done({ ...state, overlay: { ...o, index: startIndex(ctx.engines?.rows(o.query, o.agent) ?? []) } })
    }
    case "message": {
      const said = say(state, action.text, action.now, action.level, action.copy)
      return done(action.restore !== undefined && state.input === "" ? { ...said, input: action.restore, cursor: action.restore.length } : said)
    }
    case "paneOpened":
      return done(state.message?.level === "info" ? { ...state, message: undefined } : state)
  }
}
