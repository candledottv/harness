// The frame: status bar, tab bar, the tab's body (the Trade tab), a message
// line and the input line, drawn from what the core sends, with every key and click through one pure
// step (keys.ts) and its effects run against the core here.
//
// The CLI prompt pane sits outside the step: while one is shown, every key goes to its
// terminal, and the frame takes only ctrl-] (leave it, or come back) and, once it has exited, Enter or
// Esc (close it). A Ctrl-C typed into it is watched for: `candle`'s hidden prompts ignore it,
// so a second later the frame asks the launcher to stop `candle`.
//
// A chain typed on the input line runs here, one part after another: chain.ts says when
// a part has ended, from the core's cards and operations, and the next goes only then. The view holds the
// rest of the chain, so a view that closes sends nothing more.
//
// The agent's harness_view comes here as an ask on `asks`, to the main view the person last
// used (view-tool.ts says what each means). A layout the agent changes is drawn as a preview on its tab,
// kept or discarded with chips under the agent's reply; a tab change, and a theme the agent made (used at
// once), have an undo there. Without the agent pane on the tab, the chips sit on the tab bar.
// The person's click is told to the core, for Activity.
import { runOn } from "../engine/tools"
import type { OnboardingView } from "../setup/onboarding"
import { agentNameOf, codeFrom, fieldTakes, fieldValue, fundWallet, HARNESS_SIGN_INS, keyArgv, type ObAction, type ObContext, type ObLocal, obPaneRect, OnboardingScreen, SCREEN_STEPS, stepRows, stepRect } from "./onboarding"
import { parseFigure } from "./approvals"
import { freshTeeStep } from "../core/owner-rows"
import type { OnboardingOpen } from "./run"
import { memoryRows } from "./panes/memory"
import type { KeyEvent, PasteEvent } from "@opentui/core"
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CoreEventParams } from "../core/client"
import { PRESET_LABELS } from "../engine/preset"
import { ENGINE_LABELS, type EngineId, type EngineModel } from "../engine/engine"
import { type Aliases, NO_ALIASES, parseAliases } from "../shared/aliases"
import { doneWords, judge, requestOf, type RunningChain, startedFrom, stopWords } from "../shared/chain"
import type { Command } from "../shared/commands"
import { PLAN_FIX, PLAN_WORDS } from "../shared/trigger-grammar"
import { APPROVE_AFTER_BEHIND_MS, BUILD_TYPING_MS, type Effect, enterReadyAt, focusedCard, INITIAL_UI, KILL_WINDOW_MS, menuFocus, paletteFound, paletteInput, type PickRow, poppable, readLine, type ScrollReach, type SignalsChange, step, type UiAction, type UiContext, type UiState } from "./keys"
import { type HaccTopic, signalsChoiceOf, signalsFilter, signalsParams } from "./panes/signals"
import type { Here } from "./keymap"
import { allRowCount } from "./palette-rows"
import { activityTape, paneLines, tokenShown } from "./panes/registry"
import { InputLine, MessageLine, messageRows } from "./input-line"
import { AGENT_FIRST, BUILD_ALONE, shownOf, type Gap, gapFor, type Layout, NO_GAP, onScreen as panesOnScreen, type PaneId, type PaneNav, panesOf, paneNav, place, type Rect, roomy } from "./layout"
import { isTokenPane, type TokenPane } from "../shared/panes"
import { type Pin, pinPane } from "../core/view-state"
import { feedBuckets, feedPanesLeftOut } from "./panes/feed"
import { researchParts } from "./panes/research"
import { type PnlSpan, pnlWindowWords } from "./panes/pnl"
import { PNL_PANES, usePnlSeries } from "./pnl-series"
import { closed as closedPane, dragged, type LayoutOp, moved, opened, resized, tabAdded, tabRemoved, tabRenamed, tabShownIn, withoutPanes } from "./layout-edit"
import type { LayoutInfo } from "./layout-menu"
import { allLayouts, allTabs, type HiddenTab, isPreset, layoutNamed, layoutOf as treeLayout, type LayoutsFile, layoutsText, parseLayouts, PRESETS, rootText, type Tab, tabShows, treeOf } from "./layouts-file"
import { newPanes, presetOf, withNewPane } from "./new-panes"
import { type Adjusted, type LayoutStore, memoryStore } from "./layouts-store"
import { type Edge, type PaneEdges, setPanePadding } from "./panes/pane"
import type { PaneSpawner } from "./pane-process"
import type { Popper } from "./popout"
import { CliPrompt, type Prompt, PromptChips, promptInner } from "./panes/cli-prompt"
import { canRun, type ModelsRead, needsModel, pickerRows } from "./panes/engines"
import type { Act } from "./panes/lines"
import { frameMaxScroll, helpMaxScroll, Overlays } from "./overlays"
import type { BuildSpawner } from "./build-process"
import { buildScreenLines, buildTitle, selectionHint, terminalRect, useBuild } from "./build-pane"
import { foldWords } from "./build-view"
import { EmbeddedTerminal } from "./embedded-terminal"
import { BuildCardOverlay, buildCardRows, PaneOverlay } from "./pane-overlay"
import { cardLines } from "./panes/card"
import { journalContext, readJournalRows, useJournal } from "./journal-feed"
import type { JournalKind } from "../core/journal-query"
import { copiedMessage, makeCopier } from "./clipboard"
import { StatusBar, staleCoreVersion } from "./status-bar"
import { VERSION } from "../version"
import { applyEvent, type CoreView, EMPTY_VIEW, lostCore, openCards, paneNext, paneWords, unanswered, type ViewOperation } from "./store"
import { settingsColumn, type TabOffer, Tabs } from "./tabs"
import { type AgentPreview, planView, type ViewPlan } from "./view-tool"
import { C, fit as fitText, money, type TerminalColours } from "./theme"
import { walletWords } from "./approvals"
import { paperRefusal } from "./format"
import { runnableCards, type TriggersAct } from "./triggers-view"
import { type BotLogHeld, botLogLines, parseBotRef } from "./bots-view"

/** The Triggers overlay's chips that act on the picked trigger; any other chip there puts its line on the input line. */
const TRIGGERS_ACTS: ReadonlySet<string> = new Set(["toggle", "remove", "removeYes", "removeNo", "ask", "keepAwake", "list", "planBuy"])
import type { ThemeStore } from "./themes"
import { useTheme } from "./use-theme"
import { TourOverlay } from "./tour"
import { engineChipText } from "./engine-chip"
import { resentWords, type SetUpSummary } from "./panes/agent"
import { homedir } from "node:os"
import { dirname, join as joinPath } from "node:path"
import type { AwaySummary } from "../core/away"
import { AWAY_ASK, awayMaxScroll } from "./panes/away"
import { CardStrip, inlineCards, requotable, stripLines, stripRows, TabBody } from "./trade-tab"
import { liveGaps } from "./live-gaps"
import { MIN_COLS, MIN_ROWS, TooSmall } from "./too-small"
import { useRepaintAfterResize } from "./repaint"
import { guardMouse } from "./mouse-guard"

/** What the frame needs from its connection to the core: ViewSession, or a stand-in in tests. */
export interface Session {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(listener: (event: CoreEventParams) => void): void
  /** Called when the core goes away while this view is open (ViewSession); a stand-in may leave it out. */
  onLost?(listener: () => void): void
  /** The topics wanted now beyond the session's own (the Signals pane's, Candle's lists with their buckets); a stand-in may leave it out. */
  want?(topics: readonly string[], filters?: Record<string, unknown>): void
  /** Every id the core gave this view (ViewSession): the Away note shows only in the view its summary names. */
  clientIds?(): readonly string[]
  /** The attached core's own version (ViewSession): one that kept running through an update is an older one. */
  coreVersion?(): string | undefined
}

export interface AppProps {
  session: Session
  onQuit: () => void
  /** Stops the attached core and starts this binary's (attach.ts): the status bar's chip beside a core still on an older version. */
  restartCore?: () => Promise<void>
  /** The clock, for tests. */
  now?: () => number
  /** How often the frame redraws its countdowns and clears its prompts. */
  tickMs?: number
  /** When config.toml last changed, given when this view attached to a core it didn't start. */
  configChangedAt?: number
  /** config.toml's text, for its [aliases]: read when the view starts and on the palette's reload. Without it, no aliases. */
  configText?: () => string | undefined
  /** Starts the prompt pane's launcher (pane-process.ts); without it, a pane card can't open. */
  spawnPane?: PaneSpawner
  /** Starts the Build pane's harness (build-process.ts); without it, the Build tab can't open one. */
  spawnBuild?: BuildSpawner
  /** Where layouts.toml and each tab's choice are kept; without it, in memory, the presets only. */
  layouts?: LayoutStore
  /** How long after a Ctrl-C typed into a pane the launcher is asked to stop `candle`. */
  stopAfterMs?: number
  /** Moves a pane into a tmux or cmux split of its own (popout.ts); without it, a pane can't pop out. */
  popOut?: Popper
  /** Themes of yours and the choice kept; without it, the built-ins, the choice not kept. */
  themes?: ThemeStore
  /** The terminal's colours, read before the first frame when the view starts on Terminal. */
  terminal?: TerminalColours
  /** Opened for setting up: a fresh machine's `candle-harness`, or `candle-harness setup`. */
  onboarding?: OnboardingOpen
  /** Reads the terminal's colours, when Terminal is picked. Without it, Terminal can't be drawn. */
  readTerminal?: () => Promise<TerminalColours | undefined>
  /** Each paste into the input line as the terminal delivered it, for checking long pastes arrive whole (CANDLE_HARNESS_PASTE_LOG); off unless set. Never the prompt pane's or setup's. */
  onPaste?: (text: string) => void
}

/** The Build pane's terminal: over its pane's frame, which mounts again on a tab switch, and under every overlay. */
const TERMINAL_Z = 5
/** ctrl-] as a raw byte, or as the kitty keyboard protocol sends it. */
const CTRL_BRACKET = /^(\x1d|\x1b\[93;5(:\d+)?u)$/
/** ctrl-x as a terminal sends it: the control byte, or the keyboard protocol's form. */
const CTRL_X = /^(\x18|\x1b\[120;5(:\d+)?u)$/
const ENTER = /^(\r|\n|\x1b\[13u|\x1bOM)$/
const ESC = /^(\x1b|\x1b\[27u)$/
/** How long after a setup pane's launcher ends setup looks at whether it worked, so the core's news has landed. */
const SETUP_PANE_SETTLE_MS = 1_200
/** How often onboarding's engine step asks the core to check again a harness that isn't installed yet. */
const ENGINE_RECHECK_MS = 3_000
/** The same change to the same bot again inside this is the same press, sent once. */
const BOT_REPEAT_MS = 1_000

/** What the core answers when a card that runs in the prompt pane is approved (or typed). */
interface PaneOpened {
  kind: "pane"
  ticket: string
  ticketId: string
  title: string
  card?: { opId?: string }
}

/** The tab body's first row: under the status and tab bars, with a blank row between where the window has room. */
const bodyTopOf = (width: number, height: number): number => (roomy(width, height) ? 3 : 2)
/** The tab body before the first draw: under the status and tab bars, down to the input line, which sits in it under the agent. */
const bodyArea = (width: number, height: number): Rect => ({ x: 0, y: bodyTopOf(width, height), w: width, h: Math.max(1, height - bodyTopOf(width, height)) })
/** The tab the Candle Harness opens on: the one setup's last step picked, while it's shown; else the first. */
function openingTab(store: LayoutStore | undefined): number {
  const name = store?.opensOn()
  if (!store || name === undefined) return 0
  return Math.max(0, parseLayouts(store.read() ?? "", "layouts.toml").tabs.findIndex((t) => t.name === name))
}
/** Where the agent pane is: a prompt pane opens over it. */
const agentRectOf = (layout: Layout, body: Rect, gap: Gap = NO_GAP, foot = 2): Rect => place(layout, body, {}, { gap, foot }).panes.find((p) => p.id === "agent")?.rect ?? body
/**
 * The layouts as the view holds them: layouts.toml as read, each tab's last chosen
 * layout, and each tab's adjustments to it, which stay on the tab until saved or reset.
 */
interface Held {
  file: LayoutsFile
  choices: Record<string, string>
  adjusted: Record<string, Layout>
}

/** The tabs' adjustments as kept: each a tree that still reads, from a layout that's still there. */
function adjustedOf(raw: Record<string, Adjusted>, file: LayoutsFile): Record<string, Layout> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([tab, a]) => {
      const base = layoutNamed(file, a.base)
      const root = treeOf(a.tree, true, new Set())
      return base && typeof root !== "string" ? [[tab, treeLayout(base.name, root, base.collapse.below)]] : []
    }),
  )
}

/** The tabs' adjustments as written: the layout each started from, and its tree in the file's array form. */
const adjustedText = (adjusted: Record<string, Layout>): Record<string, Adjusted> =>
  Object.fromEntries(Object.entries(adjusted).map(([tab, l]) => [tab, { base: l.name, tree: JSON.parse(rootText(l.root)) as unknown }]))

/** The other tabs that show the layout `name`, as saved: an edit to it from `tabName` would change them too. */
/** Said under a setup step while a press waits on the core. A press that opens a pane says so until it opens. */
const OB_WAIT_WORDS: Partial<Record<ObAction["kind"], string>> = {
  welcome: "One moment…",
  useProfile: "Using that account…",
  signIn: "Opening the pane…",
  engine: "Picking it…",
  harness: "Opening the pane…",
  continue: "Going on…",
  stepBack: "Going back…",
  vault: "One moment…",
  securityKey: "Opening the pane…",
  makeKey: "Opening the pane…",
  revoke: "Revoking it…",
  allowEmbedded: "Opening the pane…",
  ownWallet: "Opening the pane…",
  keepLimits: "Keeping the limits…",
  approvals: "Keeping the approvals…",
  later: "Going on…",
  start: "Opening the Candle Harness…",
}

function othersShowing(held: Held, tabName: string, name: string): string[] {
  return held.file.tabs.filter((t) => t.name !== tabName && tabShows(held.file, held.choices, t).layout.name === name).map((t) => t.name)
}

const andList = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)

/**
 * A tab and the layout it shows: its last chosen, else the one layouts.toml starts it on, else
 * Agent-first; as adjusted on the tab, when it's adjustments to that layout.
 */
function tabLayout(held: Held, index: number): { tab: Tab; at: number; layout: Layout; adjusted: boolean } {
  const at = Math.max(0, Math.min(held.file.tabs.length - 1, index))
  const tab = held.file.tabs[at]!
  const layout = tabShows(held.file, held.choices, tab).layout
  const mine = held.adjusted[tab.name]
  return mine && mine.name === layout.name ? { tab, at, layout: mine, adjusted: true } : { tab, at, layout, adjusted: false }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What the tab draws when every pane of its layout is popped out: nothing, and a line saying so. */
const NOTHING: Layout = { name: "", root: { dir: "row", weight: 1, children: [] }, collapse: { below: 0, keep: "agent", weights: [60, 40] } }

/**
 * On Free, the words a typed trigger line is refused with: every plan read is Free. Before a plan is read,
 * nothing is refused here, and the core says why if it must.
 */
export function triggersGated(hacc: HaccTopic | undefined): string | undefined {
  const plans = Object.values(hacc?.agents ?? {}).flatMap((a) => (a.plan ? [a.plan] : []))
  return plans.length > 0 && plans.every((p) => p === "free") ? `${PLAN_WORDS}. This account is on Free, so nothing was sent: ${PLAN_FIX} upgrades it.` : undefined
}

/** What the hint line says Enter and Esc do here: from the line, the card Enter would approve, and the agent at work. */
export function hereOf(ui: UiState, ctx: UiContext, now?: number): Here {
  const enters = ui.input === "" ? focusedCard(ui, ctx) : undefined
  const empty = ui.input.trim() === ""
  const pops = poppable(ui)
  const parsed = empty ? undefined : readLine(ui.input, ctx)
  const sends = parsed === undefined ? undefined : parsed.kind === "agent" ? `to ${ctx.activeAgent ?? "the agent"}` : parsed.kind === "refused" ? "says why" : "runs it"
  return {
    empty: ui.input === "",
    card: enters !== undefined,
    // A card that slid in under another: Enter doesn't take it yet, and the hint says so.
    ...(enters && now !== undefined && ctx.behind?.[enters.cardId] && now < enterReadyAt(enters, ui, ctx, now) ? { cardSoon: true as const } : {}),
    ...(ctx.working && ctx.activeAgent ? { working: ctx.activeAgent } : {}),
    ...(sends ? { sends } : {}),
    ...(pops && !ctx.popped?.includes(pops) ? { pops } : {}),
    ...(ui.focus === "tabs" ? { tabs: true as const } : {}),
    ...(ui.focus === "journal" ? (ui.journal?.editing ? { searching: true } : { journal: true }) : {}),
  }
}

/**
 * A setup pane that ended without its step done: by how its operation ended, since the launcher exits 0 when
 * the CLI refused (a key limit, a mistyped prefix); by the launcher's exit where there's no operation.
 */
export function setupPaneFailed(prompt: Pick<Prompt, "exited">, op: Pick<ViewOperation, "state"> | undefined): boolean {
  if (prompt.exited === undefined) return false
  if (op) return op.state === "failed" || op.state === "refused" || op.state === "unknown" || op.state === "abandoned"
  return prompt.exited !== 0
}

const restarting = new WeakSet<object>()

/**
 * The status bar's notice for a core that kept running through an update, read from the session's last hello on
 * each draw, with its restart chip. The chip acts once: a second click while the first restart runs does nothing.
 */
function staleCoreProps(session: Session, restart: (() => Promise<void>) | undefined): { staleCore?: string; onRestartCore?: () => void } {
  const staleCore = staleCoreVersion(session.coreVersion?.(), VERSION)
  if (!staleCore) return {}
  if (!restart) return { staleCore }
  return {
    staleCore,
    onRestartCore: () => {
      if (restarting.has(session)) return
      restarting.add(session)
      void restart()
        .catch(() => {})
        .finally(() => restarting.delete(session))
    },
  }
}

export function App({ session, onQuit, restartCore, now = Date.now, tickMs = 250, configChangedAt, spawnPane, spawnBuild, stopAfterMs = 1_000, layouts, configText, popOut, themes, terminal, readTerminal, onboarding, onPaste }: AppProps) {
  // The theme goes on before the first frame.
  const theme = useTheme({ store: themes, config: configText, terminal, readTerminal })
  const themeRef = useRef(theme)
  themeRef.current = theme
  const { width, height } = useTerminalDimensions()
  // A cell of air inside each pane's border where the window has room, set before anything measures a pane.
  setPanePadding(roomy(width, height) ? 1 : 0)
  // The size as last drawn, for the step, which runs outside a render.
  const sizeRef = useRef({ width, height })
  sizeRef.current = { width, height }
  const renderer = useRenderer()
  useRepaintAfterResize(renderer, width, height)
  useEffect(() => guardMouse(renderer), [renderer])
  const copier = useMemo(() => makeCopier(renderer), [renderer])
  useEffect(() => () => void copier.dispose(), [copier])
  const [view, setView] = useState<CoreView>(EMPTY_VIEW)
  const [ui, setUi] = useState<UiState>(() => ({ ...INITIAL_UI, tab: openingTab(layouts) }))
  const [clock, setClock] = useState(now())
  // The step always runs on the latest state, whatever React has drawn.
  const viewRef = useRef(view)
  const uiRef = useRef(ui)
  const lastBotCall = useRef<{ key: string; at: number } | undefined>(undefined)
  // The step reads the panes as last drawn (where each is, collapsed or not) from here, never from a stale render.
  const navRef = useRef<PaneNav>(paneNav(place(AGENT_FIRST, bodyArea(width, height))))
  // How far each pane can scroll, filled in by the tab body as it draws.
  const reachRef = useRef<Partial<Record<PaneId, ScrollReach>>>({})
  // Each pane's token rows, filled in by the tab body as it draws: what ↑/↓ highlight.
  const picksRef = useRef<Partial<Record<PaneId, readonly PickRow[]>>>({})
  // The prompt panes, newest last; the shown one (not hidden) is the one keys go to.
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const promptsRef = useRef<Prompt[]>([])
  // A setup owner step asked for and its pane not open yet: a second press waits for it.
  const obPaneBusyRef = useRef(false)
  const setPromptList = (next: Prompt[]) => {
    promptsRef.current = next
    setPrompts(next)
  }
  const shownPrompt = () => promptsRef.current.findLast((x) => !x.hidden)
  // Each engine's models as the core last answered them, for the picker.
  const [lists, setLists] = useState<Partial<Record<EngineId, ModelsRead>>>({})
  const listsRef = useRef<Partial<Record<EngineId, ModelsRead>>>({})
  const setList = (id: EngineId, change: (was: ModelsRead | undefined) => ModelsRead) => {
    listsRef.current = { ...listsRef.current, [id]: change(listsRef.current[id]) }
    setLists(listsRef.current)
  }
  // Where a prompt pane opens: over the agent pane, as last drawn.
  const agentRectRef = useRef(agentRectOf(AGENT_FIRST, bodyArea(width, height)))

  // The tabs and layouts: read once, again from the menu's reload, and written whole on an edit.
  const store = useMemo(() => layouts ?? memoryStore(), [layouts])
  const readHeld = (): Held => {
    const file = parseLayouts(store.read() ?? "", "layouts.toml")
    return { file, choices: store.choices(), adjusted: adjustedOf(store.adjusted(), file) }
  }
  const [held, setHeldState] = useState<Held>(readHeld)
  const heldRef = useRef(held)
  const setHeld = (next: Held) => {
    heldRef.current = next
    setHeldState(next)
  }
  // config.toml's aliases: read once, and again from the palette's reload.
  const readAliases = (): Aliases => {
    try {
      return parseAliases(configText?.(), "config.toml")
    } catch (error) {
      return { map: new Map(), problems: [`config.toml couldn't be read for its aliases: ${message(error)}`] }
    }
  }
  const aliasesRef = useRef<Aliases>(NO_ALIASES)
  const [aliasesRead] = useState(() => {
    aliasesRef.current = readAliases()
    return true
  })
  void aliasesRead
  // The cards with an approval sent and not yet answered: a second press or click meanwhile (a terminal's click
  // reported twice) sends nothing, so the core's "being approved" never shows as a refusal.
  const approvingRef = useRef(new Set<string>())
  // The chain running, if one is, and what it says while it waits.
  const chainRef = useRef<RunningChain | undefined>(undefined)
  const [chainWords, setChainWords] = useState<string | undefined>(undefined)
  const chainCheckRef = useRef<() => void>(() => {})
  const chainWordsRef = useRef<string | undefined>(undefined)
  /** What the chain waits on, said as it changes (the newest message wins), and shown after while nothing newer is. */
  const showChain = (words: string | undefined) => {
    if (words === chainWordsRef.current) return
    chainWordsRef.current = words
    setChainWords(words)
    if (words) dispatch({ type: "message", text: words, level: "info", now: now() })
  }
  // A dragged border's layout, drawn while the drag lasts and written when it ends.
  const [preview, setPreviewState] = useState<Layout | undefined>(undefined)
  const previewRef = useRef<Layout | undefined>(undefined)
  const setPreview = (next: Layout | undefined) => {
    previewRef.current = next
    setPreviewState(next)
  }
  // The agent's layouts drawn as previews, by tab, until the person keeps or discards them.
  const [previews, setPreviewsState] = useState<Record<string, AgentPreview>>({})
  const previewsRef = useRef<Record<string, AgentPreview>>({})
  const setPreviews = (next: Record<string, AgentPreview>) => {
    previewsRef.current = next
    setPreviewsState(next)
  }
  const dropPreview = (tabName: string) => {
    if (!previewsRef.current[tabName]) return
    const { [tabName]: _gone, ...rest } = previewsRef.current
    setPreviews(rest)
  }
  // The agent's last other change waiting on a click: a theme it made, or a change to the tabs.
  type Offer =
    | { kind: "theme"; agent: string; name: string; was: string }
    | { kind: "tabs"; agent: string; words: string; before: Tab[]; hidden?: HiddenTab[]; renamed?: { from: string; to: string } }
    /** Wallets the agent named, or a group it changed, at once: the core undoes it by its change's id. */
    | { kind: "names"; agent: string; words: string; changeId: string; grouped?: true }
    /** A tab the agent switched to: `back` goes to the one the person was on. */
    | { kind: "back"; agent: string; from: string; to: string }
  const [offer, setOfferState] = useState<Offer | undefined>(undefined)
  const offerRef = useRef<Offer | undefined>(undefined)
  const setOffer = (next: Offer | undefined) => {
    offerRef.current = next
    setOfferState(next)
  }
  // A selection sits on the screen's rows, not the text: once a pane scrolls under it, it would cover other
  // lines, so it goes. Each answer's ⧉ copies the whole of it.
  const scrolledAt = useRef(ui.scroll)
  useEffect(() => {
    if (scrolledAt.current === ui.scroll) return
    scrolledAt.current = ui.scroll
    if (renderer.hasSelection) renderer.clearSelection()
  }, [ui.scroll, renderer])
  // The agent's naming, from the wallets topic: offered once, when it's new (a reattach doesn't offer an old one).
  const namedSeen = useRef<string | undefined>(undefined)
  const named = (view.wallets as { named?: { changeId: string; words: string; at: number; agent?: string } } | undefined)?.named
  useEffect(() => {
    if (!named || namedSeen.current === named.changeId) return
    const first = namedSeen.current === undefined && Date.now() - named.at > 60_000
    namedSeen.current = named.changeId
    if (named.agent && !first) setOffer({ kind: "names", agent: named.agent, words: named.words, changeId: named.changeId })
  }, [named?.changeId])
  // The agent's change to a group, offered the same way: its words say what it did.
  const groupedSeen = useRef<string | undefined>(undefined)
  const grouped = view.wallets?.grouped
  useEffect(() => {
    if (!grouped || groupedSeen.current === grouped.changeId) return
    const first = groupedSeen.current === undefined && Date.now() - grouped.at > 60_000
    groupedSeen.current = grouped.changeId
    if (grouped.agent && !first) setOffer({ kind: "names", agent: grouped.agent, words: grouped.words, changeId: grouped.changeId, grouped: true })
  }, [grouped?.changeId])
  // While you were away: the summary whose note was dismissed, by its ✕ or the next message.
  const [awayGone, setAwayGoneState] = useState<string | undefined>(undefined)
  const dismissAway = () => {
    const id = viewRef.current.away?.summary?.id
    if (id !== undefined && id !== awayGone) setAwayGoneState(id)
  }
  /** The address a ⧉ just showed in full, while it shows (as the panes read it), for the Away overlay. */
  const inFullOf = (u: UiState): string | undefined => (u.shownInFull && u.shownInFull.until > now() ? u.shownInFull.text : undefined)
  // The turns there were when the note first showed: any turn after them, from this view, another, a script or a
  // trigger, is the next message, and the note has ended, even where something drew over it meanwhile.
  const turnsAtNote = useRef<{ id: string; turns: Set<string> } | undefined>(undefined)
  /** The note on startup: only in the view whose attach made the summary, only when something happened, until the next turn. */
  const awayNote = (): AwaySummary | undefined => {
    const s = view.away?.summary
    if (!s?.happened || s.forView === undefined || s.id === awayGone) return undefined
    if (!(session.clientIds?.() ?? []).includes(s.forView)) return undefined
    // A turn this view saw start (the attach's own copy of the conversation carries none it saw start).
    const turns = Object.values(view.conversations).flatMap((list) => list.flatMap((e) => (e.seenAt !== undefined ? [e.turnId] : [])))
    if (turnsAtNote.current?.id !== s.id) turnsAtNote.current = { id: s.id, turns: new Set(turns) }
    const seen = turnsAtNote.current.turns
    return turns.some((t) => !seen.has(t)) ? undefined : s
  }
  /** The tab, and what it draws: the agent's preview on it, else its layout. */
  const onScreen = (h: Held = heldRef.current, index: number = uiRef.current.tab) => {
    const t = tabLayout(h, index)
    return { ...t, saved: t.layout, layout: previewsRef.current[t.tab.name]?.layout ?? t.layout }
  }
  const shownSaved = tabLayout(held, ui.tab)
  const shown = { ...shownSaved, layout: previews[shownSaved.tab.name]?.layout ?? shownSaved.layout }
  // The panes popped out into views of their own are left out while they're there, and
  // Final Stretch where Candle's server has it off, beside another of Candle's lists.
  const popped = view.views?.popped ?? []
  const drawnFrom = preview ?? shown.layout
  const tiled = withoutPanes(drawnFrom, [...popped, ...feedPanesLeftOut(panesOf(drawnFrom.root).filter((p) => !popped.includes(p)), view.feeds)])
  const layout = tiled ?? NOTHING
  // Where the tab's body is, as last drawn: an edit sizes by it.
  const bodyRef = useRef<Rect>(bodyArea(width, height))
  // Hacc's tape only while the tab on screen has a Signals pane: the core holds Hacc's stream open while
  // anyone subscribes, and Hacc allows 8 per key. Filtered by the tab's choice.
  const signalsPick = signalsChoiceOf(view.views?.signals, shown.tab.name)
  // Which panes are on screen: collapsed, the one shown.
  const visible = panesOnScreen(place(layout, bodyArea(width, height), {}, { gap: gapFor(width, height) }), ui.recent)
  // Activity before its first line shows the tape too, where no Signals pane does.
  const signalsPane = panesOf(layout.root).includes("signals")
  // Research's list pane on Signals reads the tape as it comes.
  const listsSource = visible.includes("lists") ? (ui.lists ?? "onfire") : undefined
  const signalsTopic = signalsPane ? (signalsPick.mine ? "signals:mine" : "signals") : activityTape(view, visible) || listsSource === "signals" ? "signals" : undefined
  const signalsWant = signalsPane && signalsTopic === "signals" ? signalsFilter(signalsPick) : undefined
  const signalsKey = signalsWant ? JSON.stringify(signalsWant) : undefined
  // Candle's lists only while a pane on screen shows them.
  const buckets = [...new Set([...feedBuckets(visible), ...(listsSource && listsSource !== "signals" ? [listsSource] : [])])].join(",")
  // P&L while a P&L pane is on screen: the core then reads each book every minute, with its fills.
  const pnlOn = visible.some((p) => (PNL_PANES as readonly PaneId[]).includes(p))
  const pnlChartOn = visible.includes("pnl-chart")
  // Research's reads of the linked token while a Research pane is on screen.
  const parts = researchParts(visible).join(",")
  // `asks` too: the agent's changes to the screen come to a main view, never a popped one.
  useEffect(() => {
    const topics = [...(signalsTopic ? [signalsTopic] : []), ...(buckets ? ["feeds"] : []), ...(pnlOn ? ["pnl"] : []), ...(parts ? ["research"] : []), "asks"]
    session.want?.(topics, { ...(buckets ? { feeds: { buckets: buckets.split(",") } } : {}), ...(signalsKey ? { signals: JSON.parse(signalsKey) } : {}), ...(parts ? { research: { parts: parts.split(",") } } : {}) })
  }, [session, signalsTopic, buckets, signalsKey, pnlOn, parts])
  // The chart's points, kept with the core's view so every pane reads one thing.
  usePnlSeries(session, pnlChartOn, ui.pnlSpan ?? "window", view.pnl, now, (pnlSeries) => {
    viewRef.current = { ...viewRef.current, pnlSeries }
    setView(viewRef.current)
  })
  // The Journal's rows while it's on screen: read again when the search changes or Activity says something new.
  const journal = useJournal({
    session,
    on: visible.includes("journal"),
    search: ui.journal,
    newest: view.activity.at(-1)?.seq,
    held: () => viewRef.current.journal,
    got: (held) => {
      viewRef.current = { ...viewRef.current, journal: held }
      setView(viewRef.current)
    },
  })
  const journalRef = useRef(journal)
  journalRef.current = journal

  // The agent's asks run one after another, so two changes in one turn build on each other.
  const asksRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    session.onLost?.(() => {
      viewRef.current = lostCore(viewRef.current)
      setView(viewRef.current)
    })
    session.onEvent((event) => {
      if (event.topic === "asks") {
        const ask = event.data as { id?: unknown; agent?: unknown; args?: unknown } | null
        if (!event.snapshot && ask && typeof ask.id === "string" && typeof ask.agent === "string" && typeof ask.args === "object" && ask.args !== null) {
          const { id, agent, args } = ask as { id: string; agent: string; args: Record<string, unknown> }
          asksRef.current = asksRef.current.then(() => answerAsk(id, agent, args)).then(
            () => {},
            () => {},
          )
        }
        return
      }
      viewRef.current = applyEvent(viewRef.current, event, now())
      setView(viewRef.current)
      chainCheckRef.current()
    })
  }, [session, now])

  // Onboarding: while there's no agent, or for `candle-harness setup`, the steps are read from the
  // core, which reads each back from where it lives, and again whenever a step in the pane ends.
  const inSetup = onboarding !== undefined || view.status?.setup === true
  const panesEnded = Object.values(view.operations).filter((o) => (o.kind === "owner" || o.kind === "ceremony") && o.settledAt !== undefined).length
  useEffect(() => {
    if (!inSetup || !view.connected) return
    void session
      .request<OnboardingView>("onboarding.get", { straightIn: onboarding?.straightIn === true, ...(onboarding?.asked ? { again: true } : {}) })
      .then((got) => {
        viewRef.current = { ...viewRef.current, onboarding: got }
        setView(viewRef.current)
      })
      .catch(() => {})
  }, [session, inSetup, view.connected, panesEnded, onboarding?.straightIn])

  // Onboarding's screen: steps 0 to 2 full screen, with the prompt pane inside the step.
  const [ob, setObState] = useState<ObLocal>({ sel: 0 })
  const obRef = useRef(ob)
  const setOb = (change: (was: ObLocal) => ObLocal) => {
    obRef.current = change(obRef.current)
    setObState(obRef.current)
  }
  const obView = view.onboarding
  const obShown = inSetup && obView !== undefined && SCREEN_STEPS.has(obView.at)
  const obShownRef = useRef(obShown)
  obShownRef.current = obShown
  const obItemsRef = useRef<ObAction[]>([])
  // A held highlight follows its row as the rows change (a signed-in engine's models landing above the test message).
  useEffect(() => {
    if (obRef.current.hold !== "test") return
    const i = obItemsNow().findIndex((a) => a.kind === "test")
    if (i >= 0 && obRef.current.sel !== i) setOb((o) => ({ ...o, sel: i }))
  })
  const setOnboarding = (got: OnboardingView) => {
    viewRef.current = { ...viewRef.current, onboarding: got }
    setView(viewRef.current)
  }
  // A new step starts with its first choice highlighted and nothing said; what was typed on step 3 is kept.
  useEffect(() => setOb((o) => ({ sel: 0, ...(o.models ? { models: o.models } : {}), ...(o.test ? { test: o.test } : {}), ...(o.fields ? { fields: o.fields } : {}) })), [obView?.at])
  // Step 3's reads besides onboarding's own: the agents' limits, each wallet's setting, the wallets' balances.
  const obCtx: ObContext = { ...(view.status?.agents ? { agents: view.status.agents } : {}), ...(view.autonomy ? { autonomy: view.autonomy } : {}), ...(view.portfolio ? { portfolio: view.portfolio } : {}), start: startContext() }
  // The wallet's name, typed on the wallet part, goes on once it's payable and its address is known.
  const payableAt = obView?.facts.wallet.state === "payable" && obView.facts.wallet.kind === "embedded" ? obView.facts.wallet.address : undefined
  const namedRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const name = obRef.current.fields?.walletName?.trim()
    if (!inSetup || !payableAt || !name || namedRef.current === payableAt) return
    namedRef.current = payableAt
    void session
      .request<{ said: string }>("wallets.name", { wallet: payableAt, name })
      .then((r) => setOb((o) => ({ ...o, said: { text: r.said, level: "info" } })))
      .catch((error) => setOb((o) => ({ ...o, said: { text: `Its name wasn't kept: ${message(error)} Name it later from the Wallets pane.`, level: "error" } })))
  }, [session, inSetup, payableAt])
  // A deposit landing while the fund part is open moves it on by itself. A wallet that held SOL already when
  // the part opened shows funded, with Continue: nothing goes past a screen the person hasn't seen.
  const onFund = obView?.at === "fund"
  const funded = onFund && (fundWallet(obView, obCtx)?.sol ?? 0) > 0
  // The balance counts as read once the portfolio holds the wallet: before that, SOL showing up isn't a deposit.
  const fundRead = onFund && obView.facts.wallet.state === "payable" && (view.portfolio?.wallets.some((w) => w.address === (obView.facts.wallet as { address?: string }).address) ?? false)
  const fundOpenedRef = useRef<{ funded: boolean } | undefined>(undefined)
  useEffect(() => {
    if (!onFund) {
      fundOpenedRef.current = undefined
      return
    }
    if (!fundRead) return
    if (fundOpenedRef.current === undefined) {
      fundOpenedRef.current = { funded }
      return
    }
    if (!funded || fundOpenedRef.current.funded || !obShownRef.current) return
    fundOpenedRef.current = { funded: true }
    void session.request<OnboardingView>("onboarding.set", { passed: "fund" }).then(setOnboarding).catch(() => {})
  }, [session, onFund, fundRead, funded])
  // Step 4, the tour: opened over the real screen once, on the first tab with the agent pane.
  // However it ends (past the last stop, Esc, its chip, ctrl-c, the palette, the kill switch), the step is gone past.
  const onTour = inSetup && obView?.at === "tour"
  const tourShown = ui.overlay?.kind === "tour"
  const tourOpenedRef = useRef(false)
  useEffect(() => {
    if (!onTour) {
      tourOpenedRef.current = false
      return
    }
    if (!tourOpenedRef.current) {
      tourOpenedRef.current = true
      if (!tourShown) dispatch({ type: "openTour", now: now() })
      return
    }
    if (tourShown) return
    void session.request<OnboardingView>("onboarding.set", { passed: "tour" }).then(setOnboarding).catch(() => {})
  }, [session, onTour, tourShown])
  // On the engine step, a harness that isn't installed is checked again every few seconds (else one
  // installed in another tab stays "not installed" until the core restarts). The core re-checks only what failed.
  const missingEngines = obShown && obView?.at === "engine" ? (Object.entries(view.engine?.engines ?? {}) as [EngineId, NonNullable<typeof view.engine>["engines"][EngineId]][]).filter(([, info]) => info?.check && !info.check.ok && info.check.version === undefined).map(([id]) => id) : []
  const missingKey = missingEngines.join(",")
  useEffect(() => {
    if (!missingKey) return
    const ids = missingKey.split(",") as EngineId[]
    const timer = setInterval(() => {
      for (const id of ids) void session.request("engine.check", { engine: id }).catch(() => {})
    }, ENGINE_RECHECK_MS)
    return () => clearInterval(timer)
  }, [session, missingKey])
  // The engine picked lists its models, as the picker reads them.
  const chosenEngine = obView?.state.engine
  useEffect(() => {
    if (!obShown || !chosenEngine || obRef.current.models?.engine === chosenEngine) return
    void session
      .request<{ engine: EngineId; models: EngineModel[] }>("engine.models", { engine: chosenEngine })
      .then((r) => setOb((o) => ({ ...o, models: { engine: chosenEngine, list: r.models } })))
      .catch(() => {})
  }, [session, obShown, chosenEngine])

  // The core sends the agent's harness_view to the main view used last: said at most once a second.
  const usedAtRef = useRef(0)
  const used = () => {
    const at = now()
    if (at - usedAtRef.current < 1_000) return
    usedAtRef.current = at
    // After the key's own request: an approve goes out first, with nothing ahead of it.
    setTimeout(() => void session.request("view.active", {}).catch(() => {}), 0)
  }
  const usedRef = useRef(used)
  usedRef.current = used

  const context = (): UiContext => {
    const v = viewRef.current
    const inline = inlineCards(v, v.status?.activeAgent ?? "", now())
    const expired = requotable(inline)
    return {
      panes: navRef.current,
      scrolls: reachRef.current,
      picks: picksRef.current,
      ...(expired ? { requotable: expired } : {}),
      cards: openCards(v),
      seenAt: v.seenAt,
      ...(v.behind ? { behind: v.behind } : {}),
      mode: v.status?.mode,
      agents: v.status?.agents.map((a) => a.name) ?? [],
      activeAgent: v.status?.activeAgent,
      engines: {
        rows: (query, agent) => pickerRows(viewRef.current.engine, listsRef.current, query, agent),
        needsModel: (agent) => needsModel(viewRef.current.engine, agent),
      },
      memory: (agent) => memoryRows(viewRef.current.memory?.agents[agent]),
      tabs: heldRef.current.file.tabs.map((t) => t.name),
      tabTicks: allTabs(heldRef.current.file).map((t) => ({ name: t.tab.name, shown: t.shown })),
      layout: layoutInfo(),
      working: (v.conversations[v.status?.activeAgent ?? ""] ?? []).some((e) => e.streaming || e.queued),
      queuedBehind: (v.conversations[v.status?.activeAgent ?? ""] ?? []).some((e) => e.streaming) && (v.conversations[v.status?.activeAgent ?? ""] ?? []).some((e) => e.queued),
      presets: Object.fromEntries(Object.entries(v.engine?.agents ?? {}).map(([a, e]) => [a, e.preset])),
      ...(v.engine?.runner
        ? { runner: { held: v.engine.runner, on: Object.fromEntries(Object.entries(v.engine.agents).map(([a, e]) => [a, runOn(e.tools?.run) ? e.tools!.run as readonly string[] : undefined])) } }
        : {}),
      ...(v.market?.followed ? { linked: v.market.followed.mint } : {}),
      ...pinOf(v),
      paused: v.status?.paused === true,
      ...(triggersGated(v.hacc) ? { triggersGated: triggersGated(v.hacc) } : {}),
      commands: {
        agents: v.status?.agents.map((a) => a.name) ?? [],
        knownTokens: v.knownTokens,
        ...(v.status ? { activeAgent: v.status.activeAgent, mode: v.status.mode } : {}),
        ...(v.wallets ? { wallets: v.wallets } : {}),
        aliases: aliasesRef.current.map,
      },
      aliasProblems: aliasesRef.current.problems.length,
      helpMax: helpMaxScroll(sizeRef.current.width, sizeRef.current.height),
      popped: v.views?.popped ?? [],
      // Themes of yours are read from their folder only while the palette is open, never on every tick.
      ...(uiRef.current.overlay?.kind === "palette" ? { themes: { names: themeRef.current.names(), current: themeRef.current.name, dir: themes?.dir ?? "themes" } } : {}),
      signals: signalsChoiceOf(v.views?.signals, tabLayout(heldRef.current, uiRef.current.tab).tab.name),
      // The status topic's window first: the `pnl` topic is held only while a P&L pane is on screen, so it can be stale.
      ...(v.status?.pnl?.window ? { pnlWindow: v.status.pnl.window } : v.pnl ? { pnlWindow: v.pnl.window } : {}),
      journal: journalContext(v, sizeRef.current),
      ...(v.wallets?.groups ? { walletGroups: v.wallets.groups } : {}),
      ...(v.skills ? { skillFolders: v.skills.folders } : {}),
      ...(v.status?.keepAwake ? { keepAwake: v.status.keepAwake } : {}),
      ...(v.status?.walletsShown !== undefined ? { walletsShown: v.status.walletsShown } : {}),
      ...(v.portfolio ? { allWallets: v.portfolio.wallets } : {}),
      ...(v.wallets?.names ? { walletNames: v.wallets.names } : {}),
      ...(v.autonomy ? { autonomy: v.autonomy } : {}),
      ...(v.triggers ? { triggers: v.triggers } : {}),
      ...(v.bots ? { bots: v.bots } : {}),
      botsTab: heldRef.current.file.tabs.findIndex((_, i) => panesOf(tabLayout(heldRef.current, i).layout.root).includes("bots")),
      buildTab: heldRef.current.file.tabs.findIndex((_, i) => panesOf(tabLayout(heldRef.current, i).layout.root).includes("build")),
      limits: v.status?.agents ?? [],
      ...(v.away ? { away: v.away } : {}),
      ...(uiRef.current.overlay?.kind === "botLog" ? { botLogMax: frameMaxScroll(botLogLines(v.botLog?.name === uiRef.current.overlay.name ? v.botLog : undefined, uiRef.current.overlay.only), sizeRef.current.width, sizeRef.current.height, 16, v.botLog?.lines?.length ? 1 : 0) } : {}),
      ...(uiRef.current.overlay?.kind === "away" ? { awayMax: awayMaxScroll(v.away, sizeRef.current.width, sizeRef.current.height, now(), inFullOf(uiRef.current)) } : {}),
      tourTab: heldRef.current.file.tabs.findIndex((_, i) => panesOf(tabLayout(heldRef.current, i).layout.root).includes("agent")),
    }
  }

  const dispatch = useCallback((action: UiAction) => {
    // A click the frame turns into an action is a use of this view, as a key is.
    if (action.type !== "tick" && action.type !== "message" && action.type !== "showTab" && action.type !== "key" && action.type !== "paste") usedRef.current()
    const result = step(uiRef.current, action, context())
    uiRef.current = result.state
    setUi(result.state)
    for (const effect of result.effects) void run(effect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const say = (text: string, level: "info" | "error" = "info") => dispatch({ type: "message", text, level, now: now() })

  // The Build pane: the person's own coding harness, held here for as long as the view lives, so a tab switch keeps it.
  const buildRequest = useCallback(<T,>(method: string, params?: Record<string, unknown>) => session.request<T>(method, params), [session])
  const build = useBuild({
    shown: visible.includes("build"),
    agent: view.status?.activeAgent,
    connected: view.connected,
    engine: view.engine,
    request: buildRequest,
    spawn: spawnBuild,
    say,
    now,
    focus: () => dispatch({ type: "clickPane", pane: "build", now: now() }),
  })
  const buildRef = useRef(build)
  buildRef.current = build
  const buildTermRef = useRef<Rect | undefined>(undefined)
  // A code bot's card the Build pane's harness proposed opens whole over the frame, once, with focus on it.
  const buildCardsSeen = useRef(new Set<string>())
  useEffect(() => {
    // One that's no longer waiting (approved in another view, expired) closes: drawn as nothing, it would hold the keys.
    const o = uiRef.current.overlay
    if (o?.kind === "card" && o.build && !openCards(view).some((c) => c.cardId === o.cardId)) dispatch({ type: "closeOverlay", now: now() })
    for (const c of openCards(view)) {
      if (c.origin?.role !== "build" || buildCardsSeen.current.has(c.cardId)) continue
      buildCardsSeen.current.add(c.cardId)
      // Typing in the harness a moment ago: the card opens without the keys, so an Enter meant for the harness isn't an approval.
      dispatch({ type: "openBuildCard", cardId: c.cardId, typing: buildHasKeys() && now() - buildTypedAt.current < BUILD_TYPING_MS, now: now() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  /** When a key last went to the Build pane's terminal. */
  const buildTypedAt = useRef(Number.NEGATIVE_INFINITY)
  /** A Build card that opened while the person was typing in the harness: on screen, the keys still the harness's. */
  const buildCardWaits = () => uiRef.current.overlay?.kind === "card" && uiRef.current.overlay.waiting === true
  /** The Build pane has the keys: focused, its harness running, nothing over it. Every key but ctrl-] and a second ctrl-x is the harness's. */
  const buildHasKeys = () => uiRef.current.focus === "build" && buildRef.current.stage === "running" && (!uiRef.current.overlay || buildCardWaits()) && !obShownRef.current && !shownPrompt()
  /** The window is too small to draw: nothing on screen but its size, so no key may act on what can't be seen. */
  const tooSmall = () => sizeRef.current.width < MIN_COLS || sizeRef.current.height < MIN_ROWS

  /** The tab's token pane, for the palette's pin row: whether it's pinned, and the token it shows; none when the tab has no token pane. */
  function pinOf(v: CoreView): { pin?: { pinned: boolean; symbol?: string } } {
    const { tab, layout: current } = onScreen()
    if (!panesOf(current.root).includes("token")) return {}
    const shown = tokenShown(v, tab.name)
    const symbol = shown?.market.followed?.symbol ?? shown?.market.market?.symbol
    return { pin: { pinned: shown?.how === "pinned", ...(symbol ? { symbol } : shown ? { symbol: "this token" } : {}) } }
  }

  /** What the layout menu shows for the tab on screen. */
  function layoutInfo(): LayoutInfo {
    const h = heldRef.current
    const { tab, layout: current, adjusted } = onScreen(h)
    const { saved } = onScreen(h)
    return {
      tab: tab.name,
      current,
      ...(adjusted ? { adjusted } : {}),
      ...(saved !== current ? { saved: saved.name } : {}),
      names: allLayouts(h.file).map((l) => l.name),
      preset: isPreset(current.name),
      sharedWith: isPreset(current.name) ? [] : othersShowing(h, tab.name, current.name),
      path: store.path,
      problems: h.file.problems,
      // Every tab's name, ticked off ones too: a new or renamed tab can't take one.
      tabNames: allTabs(h.file).map((t) => t.tab.name),
      ...(undoRef.current && undoRef.current.tab === tab.name ? { undo: undoRef.current.words } : {}),
    }
  }

  // The default tabs a layouts.toml that lists tabs doesn't name are there unticked. A message saying so
  // can go by unseen in its 6 s, so the tab bar offers them until settings ▾ is opened, and only that counts.
  const [dismissedPanes, setDismissedPanes] = useState<Record<string, string[]>>(() => store.dismissedPanes())
  const [freshTabs, setFreshTabs] = useState<string[]>(() => {
    const told = store.told()
    return held.file.added.filter((name) => !told.includes(name))
  })
  const toldFresh = () => {
    if (freshTabs.length === 0) return
    try {
      store.saveTold([...store.told(), ...freshTabs])
    } catch {
      // Offered again next time; nothing else is lost.
    }
    setFreshTabs([])
  }
  useEffect(() => {
    if (ui.overlay?.kind === "settings") toldFresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.overlay?.kind])

  // A problem in layouts.toml is said once, when the view starts; the layout menu keeps the list. So is one with the theme, or an alias.
  useEffect(() => {
    const problems = heldRef.current.file.problems
    const themeProblems = themeRef.current.startProblems
    if (problems.length) say(`${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more: the layout menu lists them)` : ""}`, "error")
    else if (themeProblems.length) say(`${themeProblems[0]}${themeProblems.length > 1 ? ` (and ${themeProblems.length - 1} more: the doctor lists them)` : ""}`, "error")
    else sayAliasProblems()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** The layouts, choices and adjustments before the last change on a tab, and what it was: the layout menu's undo. */
  const undoRef = useRef<{ tab: string; words: string; file: LayoutsFile; choices: Record<string, string>; adjusted: Record<string, Layout> } | undefined>(undefined)

  /** The tab's adjustments, or none: kept across a restart in state/layout.json, never in layouts.toml. */
  const adjust = (tabName: string, next: Layout | undefined): boolean => {
    const { [tabName]: _was, ...rest } = heldRef.current.adjusted
    const adjusted = next ? { ...rest, [tabName]: next } : rest
    setHeld({ ...heldRef.current, adjusted })
    try {
      store.saveAdjusted(adjustedText(adjusted))
    } catch (error) {
      say(`The tab's layout couldn't be kept for next time: ${message(error)}`, "error")
    }
    return true
  }

  /** The tab shows `name` from now on, kept across a restart, without the adjustments it had. */
  const choose = (tabName: string, name: string) => {
    const choices = { ...heldRef.current.choices, [tabName]: name }
    setHeld({ ...heldRef.current, choices })
    try {
      store.saveChoices(choices)
    } catch (error) {
      say(`The tab's layout couldn't be kept for next time: ${message(error)}`, "error")
    }
    if (heldRef.current.adjusted[tabName]) adjust(tabName, undefined)
  }

  /** The layout of yours `name` written whole into layouts.toml, added or replaced. A file with problems isn't written, since what couldn't be read would be lost. */
  const writeOwn = (layout: Layout): boolean => {
    const h = heldRef.current
    if (h.file.problems.length) {
      say(`layouts.toml has a problem (${h.file.problems[0]}): fix it and reload from the layout menu before the Candle Harness writes it, or what it couldn't read would be lost.`, "error")
      return false
    }
    // A layout saved into keeps the preset it came from, which an edit's tree doesn't carry.
    const was = h.file.own.find((l) => l.name === layout.name)
    const kept = !layout.from && was?.from ? { ...layout, from: was.from } : layout
    const own = was ? h.file.own.map((l) => (l.name === layout.name ? kept : l)) : [...h.file.own, kept]
    const file = { ...h.file, own }
    try {
      store.write(layoutsText(file))
    } catch (error) {
      say(`layouts.toml couldn't be written: ${message(error)}`, "error")
      return false
    }
    setHeld({ ...h, file })
    return true
  }

  /**
   * An edit to the tab's layout. It stays on the tab, kept across a restart, and layouts.toml is written only
   * by a deliberate save, so adjustments don't pile up as copies of a preset nobody asked for. An edit that puts the layout back as saved drops the adjustments. A layout
   * saved by name (`named`) is written to layouts.toml as named, and the tab shows it.
   */
  const keep = (next: Layout, tabName: string, named = false): boolean => {
    const h = heldRef.current
    if (named) {
      if (!writeOwn(next)) return false
      choose(tabName, next.name)
      return true
    }
    const tab = h.file.tabs.find((t) => t.name === tabName)
    const base = tab ? tabShows(h.file, h.choices, tab).layout : next
    return adjust(tabName, rootText(next.root) === rootText(base.root) ? undefined : { ...next, name: base.name })
  }

  const applyLayout = (op: LayoutOp) => {
    const { tab, layout: current } = onScreen()
    const area = bodyRef.current
    // The person's own edit to the agent's preview keeps it, with their change; showing another layout discards it.
    const agentPreview = previewsRef.current[tab.name]
    const settle = (kept: boolean) => {
      if (!agentPreview) return
      dropPreview(tab.name)
      note(agentPreview.agent, kept ? `kept ${agentPreview.agent}'s layout on ${tab.name}, with a change of yours` : `discarded ${agentPreview.agent}'s layout on ${tab.name}`)
    }
    const words: Partial<Record<LayoutOp["kind"], string>> = { show: `showing ${op.kind === "show" ? op.name : ""}`, open: `opened ${"pane" in op ? op.pane : ""}`, close: `closed ${"pane" in op ? op.pane : ""}`, move: `moved ${"pane" in op ? op.pane : ""}`, resize: `resized ${"pane" in op ? op.pane : ""}`, saveAs: `saved as ${op.kind === "saveAs" ? op.name : ""}`, save: `saved into ${current.name}`, reset: `reset to ${current.name}` }
    const before = { file: heldRef.current.file, choices: heldRef.current.choices, adjusted: heldRef.current.adjusted }
    const remembered = () => {
      if (!words[op.kind]) return
      undoRef.current = { tab: tab.name, words: words[op.kind]!, ...before }
      changed(`${words[op.kind]} on ${tab.name}`)
    }
    switch (op.kind) {
      case "undo": {
        const u = undoRef.current
        if (!u || u.tab !== tab.name) return say("There's nothing to undo on this tab.", "error")
        if (heldRef.current.file.problems.length) return say(`layouts.toml has a problem (${heldRef.current.file.problems[0]}): fix it before the Candle Harness writes it.`, "error")
        try {
          if (u.file !== heldRef.current.file) store.write(layoutsText(u.file))
          store.saveChoices(u.choices)
          store.saveAdjusted(adjustedText(u.adjusted))
        } catch (error) {
          return say(`layouts.toml couldn't be written: ${message(error)}`, "error")
        }
        undoRef.current = undefined
        setHeld({ file: u.file, choices: u.choices, adjusted: u.adjusted })
        changed(`undid ${u.words} on ${tab.name}`)
        return say(`Undone: ${u.words}. ${tab.name} is as it was.`)
      }
      case "show":
        settle(false)
        remembered()
        choose(tab.name, op.name)
        return say(`${tab.name} shows ${op.name}.`)
      case "tabShown": {
        const file = heldRef.current.file
        if (file.problems.length) return say(`layouts.toml has a problem (${file.problems[0]}): fix it and reload from the layout menu before the Candle Harness writes it, or what it couldn't read would be lost.`, "error")
        const next = tabShownIn(file, op.name, op.shown)
        if ("refused" in next) return say(next.refused, "error")
        const problem = writeTabs(next)
        if (problem) return say(problem, "error")
        const at = next.tabs.findIndex((t) => t.name === op.name)
        changed(op.shown ? `ticked ${op.name} on the tab bar` : `ticked ${op.name} off the tab bar`)
        return say(op.shown ? `${op.name} is on the tab bar${at >= 0 && at < 9 ? ` (${at + 1})` : ""}.` : `${op.name} is ticked off the tab bar; its layout is kept. Tick it on in settings ▾ to show it again.`)
      }
      case "addTab":
      case "renameTab":
      case "removeTab": {
        const file = heldRef.current.file
        if (file.problems.length) return say(`layouts.toml has a problem (${file.problems[0]}): fix it and reload from the layout menu before the Candle Harness writes it, or what it couldn't read would be lost.`, "error")
        // A new tab starts on the layout this one shows, as saved (never the agent's preview).
        const next = op.kind === "addTab" ? tabAdded(file, op.name, tabLayout(heldRef.current, uiRef.current.tab).layout.name) : op.kind === "renameTab" ? tabRenamed(file, tab.name, op.name) : tabRemoved(file, tab.name)
        if ("refused" in next) return say(next.refused, "error")
        const renamed = op.kind === "renameTab" ? { from: tab.name, to: op.name.trim() } : undefined
        const problem = writeTabs(next, renamed, op.kind === "removeTab" ? tab.name : undefined, op.kind === "addTab" ? next.tabs.length - 1 : undefined)
        if (problem) return say(problem, "error")
        changed(op.kind === "addTab" ? `added the tab ${op.name.trim()}` : op.kind === "renameTab" ? `renamed the tab ${tab.name} to ${op.name.trim()}` : `removed the tab ${tab.name}`)
        return say(op.kind === "addTab" ? `Added the tab ${op.name.trim()}, showing ${next.tabs.at(-1)!.layout}.` : op.kind === "renameTab" ? `${tab.name} is now ${op.name.trim()}.` : `Removed the tab ${tab.name}; its layout is still in the menu.`)
      }
      case "reload": {
        const file = parseLayouts(store.read() ?? "", "layouts.toml")
        setHeld({ ...heldRef.current, file })
        return file.problems.length
          ? say(`${file.problems[0]}${file.problems.length > 1 ? ` (and ${file.problems.length - 1} more)` : ""}`, "error")
          : say(`Read layouts.toml: ${file.tabs.length} tabs, ${file.own.length} ${file.own.length === 1 ? "layout" : "layouts"} of yours.`)
      }
      case "saveAs": {
        // Saved from a preset, it records which and the preset's panes now, so a pane the preset gains later is offered (new-panes.ts).
        const preset = PRESETS.find((p) => p.name === current.name)
        const from = preset ? { preset: preset.name, panes: panesOf(preset.root) } : heldRef.current.file.own.find((l) => l.name === current.name)?.from
        const saved = treeLayout(op.name, current.root, current.collapse.below)
        if (keep(from ? { ...saved, from } : saved, tab.name, true)) {
          remembered()
          settle(true)
          say(`Saved as "${op.name}" in layouts.toml; ${tab.name} shows it.`)
        }
        return
      }
      case "save": {
        if (isPreset(current.name)) return say(`${current.name} is a preset: save the tab's layout as one of yours, by name.`, "error")
        const others = othersShowing(heldRef.current, tab.name, current.name)
        if (!writeOwn(current)) return
        remembered()
        settle(true)
        adjust(tab.name, undefined)
        return say(`Saved into ${current.name} in layouts.toml${others.length ? `; ${andList(others)} ${others.length === 1 ? "shows" : "show"} it too, so ${others.length === 1 ? "it changes" : "they change"} as well` : ""}.`)
      }
      case "reset": {
        if (!heldRef.current.adjusted[tab.name]) return say(`${tab.name} shows ${current.name} as saved: there's nothing to reset.`)
        remembered()
        settle(false)
        adjust(tab.name, undefined)
        return say(`${tab.name} is back to ${current.name} as saved.`)
      }
    }
    const next =
      op.kind === "open" ? opened(current, op.pane, op.near) : op.kind === "close" ? closedPane(current, op.pane) : op.kind === "move" ? moved(current, op.pane, op.dir, area) : resized(current, op.pane, op.axis, op.cells, area, op.side)
    if ("refused" in next) return say(next.refused, "error")
    if (keep(next, tab.name)) {
      remembered()
      settle(true)
      // Another token pane opens pinned on the token shown, so the first can follow the link to the next one;
      // closed, its pin goes, so it holds none of the three for a pane that isn't there.
      const extra = (op.kind === "open" || op.kind === "close") && isTokenPane(op.pane) && op.pane !== "token" ? op.pane : undefined
      const symbol = viewRef.current.market?.followed?.symbol
      if (extra && op.kind === "open" && viewRef.current.market?.followed) void call("view.pin", { at: tab.name, pane: extra }, () => `${extra} opened on ${tab.name}, pinned on ${symbol ?? "this token"}: pick another token and the first token pane follows it.`)
      if (extra && op.kind === "close" && viewRef.current.views?.pins.some((p) => p.at === tab.name && pinPane(p) === extra)) void session.request("view.unpin", { at: tab.name, pane: extra }).catch(() => {})
    }
  }

  /** The person's own change to the tabs or a layout, for the record. */
  const changed = (words: string) => void session.request("view.set", { words }).catch(() => {})

  /** The person's click on an agent's change, for the record and Activity. */
  const note = (agent: string, words: string) => void session.request("view.note", { agent, words }).catch(() => {})

  /**
   * The tabs written to layouts.toml, the same tab kept on screen: a renamed tab takes its layout choice,
   * preview and pin with it, and a removed one's pin goes. `select` puts a tab on screen instead. Undefined
   * when written, else why not.
   */
  const writeTabs = (file: LayoutsFile, renamed?: { from: string; to: string }, removed?: string, select?: number): string | undefined => {
    try {
      store.write(layoutsText(file))
    } catch (error) {
      return `layouts.toml couldn't be written: ${message(error)}`
    }
    const was = tabLayout(heldRef.current, uiRef.current.tab).tab.name
    let choices = heldRef.current.choices
    if (renamed && Object.hasOwn(choices, renamed.from)) {
      const { [renamed.from]: choice, ...rest } = choices
      choices = { ...rest, [renamed.to]: choice! }
      try {
        store.saveChoices(choices)
      } catch {
        // The tab shows its file's layout next time; nothing else is lost.
      }
    }
    if (renamed && previewsRef.current[renamed.from]) {
      const { [renamed.from]: moving, ...rest } = previewsRef.current
      setPreviews({ ...rest, [renamed.to]: moving! })
    }
    if (removed) dropPreview(removed)
    // A renamed tab keeps its adjustments, and a removed one's go.
    let adjusted = heldRef.current.adjusted
    const gone = renamed?.from ?? removed
    if (gone && adjusted[gone]) {
      const { [gone]: moving, ...rest } = adjusted
      adjusted = renamed ? { ...rest, [renamed.to]: moving! } : rest
      try {
        store.saveAdjusted(adjustedText(adjusted))
      } catch {
        // The tab shows its layout as saved next time; nothing else is lost.
      }
    }
    setHeld({ file, choices, adjusted })
    const want = renamed && was === renamed.from ? renamed.to : was
    const at = select ?? file.tabs.findIndex((t) => t.name === want)
    dispatch({ type: "showTab", tab: at >= 0 ? at : Math.min(uiRef.current.tab, file.tabs.length - 1), now: now() })
    if (renamed) void session.request("view.repin", { from: renamed.from, to: renamed.to }).catch(() => {})
    if (removed && viewRef.current.views?.pins.some((p) => p.at === removed)) void session.request("view.unpin", { at: removed, pane: "all" }).catch(() => {})
    return undefined
  }

  // A border dragged: the layout redrawn as it moves, and kept when it's let go.
  const dragRef = useRef<{ pane: PaneId; axis: "row" | "column"; side: "after" | "before"; from: number; base: Layout } | undefined>(undefined)
  const edges = (pane: PaneId): PaneEdges => ({
    down(edge: Edge, x: number, y: number) {
      const axis = edge === "left" || edge === "right" ? "row" : "column"
      dragRef.current = { pane, axis, side: edge === "right" || edge === "bottom" ? "after" : "before", from: axis === "row" ? x : y, base: onScreen().layout }
    },
    drag(x: number, y: number) {
      const d = dragRef.current
      if (!d) return
      const moved = (d.axis === "row" ? x : y) - d.from
      // Right or down grows the pane by its right or bottom border, and shrinks it by its left or top.
      const cells = d.side === "after" ? moved : -moved
      const next = cells === 0 ? undefined : dragged(d.base, d.pane, d.axis, cells, bodyRef.current, d.side, gapFor(width, height))
      setPreview(next && !("refused" in next) ? next : undefined)
    },
    end() {
      const d = dragRef.current
      dragRef.current = undefined
      const next = previewRef.current
      setPreview(undefined)
      if (!d || !next) return
      const tabName = tabLayout(heldRef.current, uiRef.current.tab).tab.name
      const agentPreview = previewsRef.current[tabName]
      const before = { file: heldRef.current.file, choices: heldRef.current.choices, adjusted: heldRef.current.adjusted }
      const kept = keep(next, tabName)
      if (kept) {
        undoRef.current = { tab: tabName, words: `resized ${d.pane}`, ...before }
        changed(`resized ${d.pane} on ${tabName}, by its border`)
      }
      if (kept && agentPreview) {
        dropPreview(tabName)
        note(agentPreview.agent, `kept ${agentPreview.agent}'s layout on ${tabName}, with a change of yours`)
      }
    },
  })

  /** A request to the core; `restore` is the typed line it came from, put back if the core refuses it. */
  const call = async <T,>(method: string, params: Record<string, unknown>, done?: (result: T) => string | undefined, restore?: string) => {
    try {
      const result = await session.request<T>(method, params)
      const text = done?.(result)
      if (text) say(text)
    } catch (error) {
      dispatch({ type: "message", text: message(error), level: "error", now: now(), ...(restore !== undefined ? { restore } : {}) })
    }
  }

  /** A token pane's pin chip: holds that token pane on its token, or lets it follow the link again. */
  const togglePin = (tabName: string, pane: TokenPane = "token") => {
    const which = pane === "token" ? `${tabName}'s token pane` : `${tabName}'s ${pane}`
    const pinned = viewRef.current.views?.pins.find((p) => p.at === tabName && pinPane(p) === pane)
    if (pinned) return void call("view.unpin", { at: tabName, pane }, () => `${which} follows the link again.`)
    const symbol = viewRef.current.market?.followed?.symbol
    return void call("view.pin", { at: tabName, pane }, () => `${which} stays on ${symbol ?? "this token"} while the link moves on.`)
  }

  /** A tab's Signals choice changed: the core keeps it, so every view of the tab shows the same. */
  const setSignals = (tabName: string, change: SignalsChange) => void call("view.signals", signalsParams(tabName, signalsChoiceOf(viewRef.current.views?.signals, tabName), change))

  /** Re-sends or abandons an operation Candle didn't answer, and says what came of it. */
  const resolve = (op: ViewOperation, action: "resend" | "abandon") =>
    call<{ state: string; paper?: boolean }>("operations.resolve", { opId: op.opId, action }, (r) =>
      action === "abandon" ? "Abandoned: the core stops following it. Check candle.tv for whether it ran." : resentWords(op, r),
    )

  const sayAliasProblems = () => {
    const problems = aliasesRef.current.problems
    if (problems.length) say(`${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more: the doctor lists them)` : ""}`, "error")
    return problems.length > 0
  }
  const reloadAliases = () => {
    aliasesRef.current = readAliases()
    if (sayAliasProblems()) return
    const n = aliasesRef.current.map.size
    say(n === 0 ? "config.toml has no aliases: add an [aliases] table, such as b5 = \"buy $5 of\"." : `Read ${n} ${n === 1 ? "alias" : "aliases"} from config.toml.`)
  }

  /** Draws in another theme and keeps it for next time; one that can't be drawn leaves the screen as it was, and says why. */
  const pickTheme = async (name: string): Promise<{ used: boolean; text: string }> => {
    const was = themeRef.current.name
    const loaded = await themeRef.current.pick(name)
    if (!loaded.used) {
      const text = `${loaded.problems[0]}: ${was} stays.`
      say(text, "error")
      return { used: false, text }
    }
    const left = loaded.problems
    const text = left.length ? `${loaded.name} is on, without what it couldn't read: ${left[0]}${left.length > 1 ? ` (and ${left.length - 1} more)` : ""}` : `${loaded.name} is on, and kept for next time.`
    say(text, left.length ? "error" : "info")
    return { used: true, text }
  }

  /** The agent's harness_view, made here and answered. */
  const answerAsk = async (id: string, agent: string, args: Record<string, unknown>) => {
    const reply = (result: { ok: true; text: string; words?: string } | { ok: false; code: string; text: string }) => session.request("view.answer", { id, result }).catch(() => {})
    const h = heldRef.current
    const plan: ViewPlan = planView(args, {
      file: h.file,
      choices: h.choices,
      tab: uiRef.current.tab,
      previews: previewsRef.current,
      pins: viewRef.current.views?.pins ?? [],
      theme: { current: themeRef.current.name, names: themeRef.current.names(), read: (n) => themes?.read(n) },
      signals: viewRef.current.views?.signals ?? [],
      signalsPaused: uiRef.current.scroll.signals?.paused === true,
      ...(uiRef.current.journal ? { journal: uiRef.current.journal } : {}),
    })
    // A switch the agent made gets a way back, as its other view changes get an undo.
    const leaving = (to: number | undefined) => {
      const from = uiRef.current.tab
      if (to === undefined || to === from) return
      const name = (i: number) => h.file.tabs[i]?.name
      const [was, next] = [name(from), name(to)]
      if (was && next) setOffer({ kind: "back", agent, from: was, to: next })
    }
    switch (plan.kind) {
      case "refused":
        return reply({ ok: false, code: plan.code, text: plan.text })
      case "read":
        return reply({ ok: true, text: plan.text })
      case "tab":
        leaving(plan.at)
        dispatch({ type: "showTab", tab: plan.at, now: now() })
        if (plan.pane) dispatch({ type: "showPane", pane: plan.pane, now: now() })
        return reply({ ok: true, text: plan.text, words: plan.words })
      case "signals": {
        leaving(plan.at)
        if (plan.at !== undefined) dispatch({ type: "showTab", tab: plan.at, now: now() })
        if (Object.keys(plan.change).length) {
          try {
            await session.request("view.signals", signalsParams(plan.tab, signalsChoiceOf(viewRef.current.views?.signals, plan.tab), plan.change))
          } catch (error) {
            return reply({ ok: false, code: "SIGNALS_REFUSED", text: message(error) })
          }
        }
        // A new choice starts again at the newest, as the chips do, unless the agent paused it too.
        if (plan.paused !== undefined || Object.keys(plan.change).length) dispatch({ type: "pauseSignals", on: plan.paused === true, now: now() })
        return reply({ ok: true, text: plan.text, words: plan.words })
      }
      case "journal":
        leaving(plan.at)
        if (plan.at !== undefined) dispatch({ type: "showTab", tab: plan.at, now: now() })
        dispatch({ type: "journalSet", search: plan.search, now: now() })
        return reply({ ok: true, text: plan.text, words: plan.words })
      case "show":
        dropPreview(plan.tab)
        choose(plan.tab, plan.layout)
        return reply({ ok: true, text: plan.text, words: plan.words })
      case "preview":
        setPreviews({ ...previewsRef.current, [plan.tab]: { agent, layout: plan.layout } })
        return reply({ ok: true, text: plan.text, words: plan.words })
      case "tabs": {
        // A tab ticked off keeps its pin and preview, as the settings tick does.
        const removed = plan.hidden ? undefined : h.file.tabs.find((t) => !plan.file.tabs.some((n) => n.name === t.name) && t.name !== plan.renamed?.from)?.name
        const problem = writeTabs(plan.file, plan.renamed, removed, plan.select)
        if (problem) return reply({ ok: false, code: "NOT_WRITTEN", text: problem })
        setOffer({ kind: "tabs", agent, words: plan.words, before: plan.before, ...(plan.hidden ? { hidden: plan.hidden } : {}), ...(plan.renamed ? { renamed: plan.renamed } : {}) })
        return reply({ ok: true, text: plan.text, words: plan.words })
      }
      case "pin":
      case "unpin":
        try {
          const which = plan.pane === "token" ? `${plan.tab}'s token pane` : `${plan.tab}'s ${plan.pane}`
          if (plan.kind === "unpin") {
            await session.request("view.unpin", { at: plan.tab, pane: plan.pane })
            return reply({ ok: true, text: `${which} follows the link again.`, words: `unpinned ${which}` })
          }
          const r = await session.request<{ pins: Pin[] }>("view.pin", { at: plan.tab, pane: plan.pane, ...(plan.mint ? { mint: plan.mint } : {}) })
          const pin = r?.pins?.find((p) => p.at === plan.tab && pinPane(p) === plan.pane)
          const what = pin?.symbol ?? (pin ? `${pin.mint.slice(0, 4)}…` : "its token")
          // The mint in full, so the agent naming it after is naming one a tool showed (else the address gate re-asks its reply).
          return reply({ ok: true, text: `${which} stays on ${what}${pin ? ` (${pin.mint})` : ""} while the link moves on.`, words: `pinned ${which} on ${what}` })
        } catch (error) {
          const e = error as { code?: unknown }
          const code = e.code === "NOT_WATCHED" ? "NOT_WATCHED" : e.code === "TOO_MANY_PINS" ? "TOO_MANY_PINS" : "PIN_REFUSED"
          const text = code === "NOT_WATCHED" ? "The token pane doesn't show that token: pass its mint to pin it, or show it first." : message(error)
          return reply({ ok: false, code, text })
        }
      case "theme": {
        const r = await pickTheme(plan.name)
        return r.used ? reply({ ok: true, text: r.text, words: `switched the theme to ${plan.name}` }) : reply({ ok: false, code: "THEME_REFUSED", text: r.text })
      }
      case "makeTheme": {
        if (!themes?.write) return reply({ ok: false, code: "NOT_WRITTEN", text: "This view has nowhere to write a theme." })
        try {
          themes.write(plan.name, plan.source)
        } catch (error) {
          return reply({ ok: false, code: "NOT_WRITTEN", text: `themes/${plan.name}.toml couldn't be written: ${message(error)}` })
        }
        // Used at once, with an undo under the reply: someone who asks for a theme expects it in use.
        const was = themeRef.current.name
        const used = await pickTheme(plan.name)
        if (!used.used) return reply({ ok: false, code: "THEME_REFUSED", text: `${plan.text} It couldn't be used: ${used.text}` })
        setOffer({ kind: "theme", agent, name: plan.name, was })
        return reply({ ok: true, text: `${plan.text} It's on screen now; an undo under your reply puts ${was} back.`, words: `${plan.words}, and switched to it` })
      }
    }
  }

  /**
   * What the tab bar offers when the agent has nothing waiting there (or it's under the agent's reply):
   * the tab's adjustments to save or reset, else the new tabs to tick on.
   */
  const barOffer = (hasAgent: boolean): TabOffer | undefined => {
    const agents = tabOffer()
    if (agents && !hasAgent) return agents
    const t = tabLayout(heldRef.current, uiRef.current.tab)
    if (t.adjusted) {
      const own = !isPreset(t.layout.name)
      return {
        words: "unsaved changes",
        chips: [
          ...(own ? [{ label: "save", onClick: () => applyLayout({ kind: "save" }) }] : []),
          { label: "save as…", onClick: () => dispatch({ type: "clickSaveLayout", now: now() }) },
          { label: "reset", onClick: () => applyLayout({ kind: "reset" }) },
        ],
      }
    }
    if (freshTabs.length) {
      return {
        words: `${freshTabs.length === 1 ? "A new tab is" : `${freshTabs.length} new tabs are`} ticked off: ${andList(freshTabs)}`,
        chips: [{ label: "show them", onClick: () => dispatch({ type: "clickSettings", now: now() }) }],
      }
    }
    // A pane the layout's preset gained since it was saved (else a layout saved from a preset never gets it).
    const preset = presetOf(t.layout)
    const fresh = preset ? newPanes(t.layout, dismissedPanes[t.layout.name] ?? []) : []
    if (preset && fresh.length) {
      return {
        words: `${preset.name} has ${fresh.length === 1 ? "a new pane" : "new panes"}: ${andList(fresh)}`,
        chips: [
          { label: "add", onClick: () => addNewPanes(t.tab.name, t.layout, preset, fresh) },
          { label: "✕", onClick: () => dismissNewPanes(t.layout.name, fresh) },
        ],
      }
    }
    return undefined
  }

  /** The preset's new panes, put where it has them, as an unsaved change on the tab: save keeps them. */
  const addNewPanes = (tabName: string, layout: Layout, preset: Layout, panes: readonly PaneId[]) => {
    let next: Layout = layout
    for (const pane of panes) {
      const step = withNewPane(next, preset, pane)
      if ("refused" in step) return say(step.refused, "error")
      next = step
    }
    if (!keep(next, tabName)) return
    changed(`added ${andList([...panes])} from ${preset.name} on ${tabName}`)
    say(`Added ${andList([...panes])} to ${tabName}: save keeps ${panes.length === 1 ? "it" : "them"} in ${layout.name}, and reset leaves ${panes.length === 1 ? "it" : "them"} out.`)
  }

  /** Left out: not offered again for this layout. */
  const dismissNewPanes = (name: string, panes: readonly PaneId[]) => {
    const next = { ...dismissedPanes, [name]: [...(dismissedPanes[name] ?? []), ...panes] }
    try {
      store.saveDismissedPanes(next)
    } catch {
      // Offered again next time; nothing else is lost.
    }
    setDismissedPanes(next)
  }

  /** What the tab bar offers for the agent's change: the preview on the tab on screen first, else the last other one. */
  const tabOffer = (): TabOffer | undefined => {
    const tabName = tabLayout(heldRef.current, uiRef.current.tab).tab.name
    const p = previewsRef.current[tabName]
    if (p) {
      return {
        words: `${p.agent}'s layout on ${tabName} is a preview`,
        chips: [
          {
            label: "keep",
            onClick: () => {
              // A layout the agent named at the person's ask is saved by that name; else it stays on the tab.
              const t = heldRef.current.file.tabs.find((x) => x.name === tabName)
              const named = t !== undefined && p.layout.name !== tabShows(heldRef.current.file, heldRef.current.choices, t).layout.name
              if (!keep(p.layout, tabName, named)) return
              dropPreview(tabName)
              say(named ? `Kept ${p.agent}'s layout on ${tabName}, as "${p.layout.name}" in layouts.toml.` : `Kept ${p.agent}'s layout on ${tabName}: save as… on the tab bar names it as a layout of yours.`)
              note(p.agent, `kept ${p.agent}'s layout on ${tabName}${named ? `, as ${p.layout.name}` : ""}`)
            },
          },
          {
            label: "discard",
            onClick: () => {
              dropPreview(tabName)
              say(`${tabName} is back as it was.`)
              note(p.agent, `discarded ${p.agent}'s layout on ${tabName}`)
            },
          },
        ],
      }
    }
    const o = offerRef.current
    if (!o) return undefined
    const dismiss = { label: "✕", onClick: () => setOffer(undefined) }
    if (o.kind === "names") {
      return {
        words: o.grouped ? `${o.agent} ${o.words}` : `${o.agent} named ${o.words}`,
        chips: [
          {
            label: "undo",
            onClick: () => {
              setOffer(undefined)
              void session
                .request("wallets.undo", { changeId: o.changeId })
                .then((r) => say((r as { said?: string }).said ?? "Undone."))
                .catch((error) => say(message(error), "error"))
            },
          },
          dismiss,
        ],
      }
    }
    if (o.kind === "back") {
      return {
        words: `${o.agent} switched to ${o.to}`,
        chips: [
          {
            label: `back to ${o.from}`,
            onClick: () => {
              setOffer(undefined)
              const at = heldRef.current.file.tabs.findIndex((t) => t.name === o.from)
              if (at >= 0) dispatch({ type: "showTab", tab: at, now: now() })
            },
          },
          dismiss,
        ],
      }
    }
    if (o.kind === "theme") {
      return {
        words: `${o.agent}'s theme ${o.name} is on`,
        chips: [
          {
            label: "undo",
            onClick: () => {
              setOffer(undefined)
              void pickTheme(o.was).then((r) => r.used && note(o.agent, `put ${o.was} back over ${o.agent}'s theme ${o.name}`))
            },
          },
          dismiss,
        ],
      }
    }
    return {
      words: `${o.agent} ${o.words}`,
      chips: [
        {
          label: "undo",
          onClick: () => {
            setOffer(undefined)
            const file = heldRef.current.file
            if (file.problems.length) return say(`layouts.toml has a problem (${file.problems[0]}): fix it before the Candle Harness writes it.`, "error")
            // The tabs as they were, each on a layout that's still there.
            const tabs = o.before.map((t) => (layoutNamed(file, t.layout) ? t : { ...t, layout: AGENT_FIRST.name }))
            // A tab shown or ticked off: the ticked-off tabs as they were too.
            const hidden = o.hidden?.map((h) => (layoutNamed(file, h.tab.layout) ? h : { ...h, tab: { ...h.tab, layout: AGENT_FIRST.name } }))
            const back = o.renamed ? { from: o.renamed.to, to: o.renamed.from } : undefined
            const gone = hidden ? undefined : file.tabs.find((t) => !tabs.some((b) => b.name === t.name) && t.name !== back?.from)?.name
            const problem = writeTabs({ ...file, tabs, ...(hidden ? { hidden } : {}) }, back, gone)
            if (problem) return say(problem, "error")
            say(`The tabs are back as they were before ${o.agent} ${o.words}.`)
            note(o.agent, `undid ${o.agent}'s change: ${o.words}`)
          },
        },
        dismiss,
      ],
    }
  }

  /** The chain ends: its words on the message line, and nothing more is sent. */
  const endChain = (text: string, level: "info" | "error", restore?: string) => {
    chainRef.current = undefined
    chainWordsRef.current = undefined
    setChainWords(undefined)
    dispatch({ type: "message", text, level, now: now(), ...(restore !== undefined ? { restore } : {}) })
  }
  /** Sends the chain's current part, as a typed line of it would go. */
  const sendPart = async () => {
    const r = chainRef.current
    if (!r) return
    const part = r.parts[r.at]!
    r.sending = true
    r.wait = undefined
    showChain(`chain: part ${r.at + 1} of ${r.parts.length}, sending ${part.text}`)
    const { method, params } = requestOf(part)
    let answer: unknown
    try {
      answer = await session.request(method, params)
    } catch (error) {
      // Refused by the core (a limit, the kill switch's pause): nothing of this part ran. The first part's line comes back to fix.
      if (chainRef.current !== r) return
      return endChain(stopWords(r, message(error), false), "error", r.at === 0 ? r.line : undefined)
    }
    if (chainRef.current !== r) return
    const a = answer as { kind?: string }
    if (a?.kind === "pane") {
      const said = openPrompt(answer as PaneOpened)
      if (said) return endChain(stopWords(r, said, true), "error")
    }
    r.sending = undefined
    const started = startedFrom(r, answer)
    if (started.kind === "stop") return endChain(stopWords(r, started.why, true), "error")
    if (started.kind === "done") return nextPart(r)
    r.wait = { ...(started.cardId ? { cardId: started.cardId } : {}), ...(started.opId ? { opId: started.opId } : {}) }
    checkChain()
  }
  const nextPart = (r: RunningChain) => {
    if (chainRef.current !== r) return
    if (r.at + 1 >= r.parts.length) return endChain(doneWords(r), "info")
    r.at += 1
    void sendPart()
  }
  /** Whether the part waited on has ended, from the cards and operations as they are now. */
  const checkChain = () => {
    const r = chainRef.current
    if (!r || r.sending || !r.wait) return
    const verdict = judge(r, viewRef.current)
    if (verdict.kind === "wait") return showChain(verdict.words)
    if (verdict.kind === "next") return nextPart(r)
    return endChain(stopWords(r, verdict.why, true), "error")
  }
  chainCheckRef.current = checkChain
  // A view that closes sends nothing more of a chain: the rest lived only here.
  useEffect(
    () => () => {
      chainRef.current = undefined
      chainCheckRef.current = () => {}
    },
    [],
  )
  const startChain = (c: Extract<Command, { kind: "chain" }>, line: string | undefined) => {
    const busy = chainRef.current
    if (busy) {
      return dispatch({ type: "message", text: `A chain is still running (part ${busy.at + 1} of ${busy.parts.length}): it ends when a part fails or you reject its card. This line wasn't sent.`, level: "error", now: now(), ...(line !== undefined ? { restore: line } : {}) })
    }
    chainRef.current = { parts: c.parts, at: 0, line: line ?? c.echo }
    void sendPart()
  }

  const command = (c: Command, line?: string) => {
    switch (c.kind) {
      case "chain":
        return startChain(c, line)
      case "trade":
        return call<{ instant?: { kind: string; operation?: { state: string } }; paper?: { isError?: boolean; content?: { text?: string }[] } }>(
          "cards.propose",
          { tool: c.tool, args: c.args, typed: true, ...(c.agent ? { agent: c.agent } : {}) },
          (r) => {
            // A paper trade refused is an error, as any refused line is: it stays 20 s and the line comes back to fix
            // (said as a passing note, it was gone in 6 s with the line cleared, and read as nothing having happened).
            if (r.paper?.isError) throw new Error(`${c.echo} (paper): refused. ${paperRefusal(r.paper.content?.[0]?.text ?? "")}`)
            if (r.paper) return `${c.echo}: paper trade recorded at the quoted price.`
            return r.instant ? `${c.echo}: ${r.instant.operation?.state ?? r.instant.kind}` : undefined
          },
          line,
        )
      case "cli":
        return call<{ output?: unknown; exitCode?: number; kind?: string; said?: string }>("cli.run", { argv: c.argv, ...(c.agent ? { agent: c.agent } : {}) }, (r) => {
          // A line that asks at the CLI's own prompt opens the pane at once.
          if (r.kind === "pane") return openPrompt(r as unknown as PaneOpened)
          // Funds out to a new address, typed: the amber card, approved by a click.
          // A TEE wallet's stop and a typed close of empty accounts say their own words.
          if (typeof r.said === "string") return r.said
          if (r.kind === "card") return `candle ${c.argv.join(" ")}: that's a new address, so it's a card. Check it in full, then click yes, a new address.`
          const out = typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? r)
          return `candle ${c.argv.join(" ")}: ${out.replace(/\s+/g, " ").slice(0, 200)}`
        }, line)
      case "name":
        // Naming a wallet: the Candle Harness's own names at once; Candle's and the vault's in the pane, at once.
        return call<{ said: string; panes?: PaneOpened[] }>(
          "wallets.name",
          { wallet: c.wallet, name: c.name },
          (r) => {
            const trouble = (r.panes ?? []).map((p) => openPrompt(p)).find((m) => m !== undefined)
            return trouble ?? r.said
          },
          line,
        )
      case "group": {
        // A wallet group: at once, checked by the core's rule; it organises only.
        const op = c.op
        const params = op.op === "add" || op.op === "remove" ? { group: op.group, op: op.op, wallets: op.wallets } : op.op === "prefix" ? { group: op.group, op: "prefix", prefix: op.prefix } : { group: op.group, op: "delete" }
        return call<{ said: string }>("wallets.group", params, (r) => r.said, line)
      }
      case "agent":
        // The next message ends the note on startup.
        dismissAway()
        return call("agent.send", { text: c.text })
      case "resume":
        return call("resume", {}, () => "Resumed: buys are allowed again.")
      case "forgetVault":
        return call<{ said: string }>("vault.forget", {}, (r) => r.said, line)
      case "resolve": {
        // Typed, it acts only when there's one to act on; with several, the click says which.
        const ops = unanswered(viewRef.current)
        if (ops.length === 0) return say("Nothing is waiting on an answer from Candle.")
        if (ops.length > 1) return say(`${ops.length} trades have no answer yet: click re-send or abandon on the one you mean.`, "error")
        return resolve(ops[0]!, c.action)
      }
      default:
        return undefined
    }
  }

  const run = async (effect: Effect) => {
    switch (effect.type) {
      case "command":
        return command(effect.command, effect.line)
      case "approve": {
        const card = viewRef.current.cards.find((c) => c.cardId === effect.cardId)
        if (!card || approvingRef.current.has(card.cardId)) return
        // A chain's card approved after it expired comes back as a fresh one, which the chain then waits on.
        const chain = chainRef.current?.wait?.cardId === card.cardId ? chainRef.current : undefined
        if (chain) chain.approving = card.cardId
        approvingRef.current.add(card.cardId)
        try {
          await call<{ kind: string; fresh?: { cardId?: string; opId?: string } }>("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: effect.how }, (r) => {
            if (chain && chainRef.current === chain && r.kind === "reproposed" && r.fresh?.cardId) chain.wait = { cardId: r.fresh.cardId, ...(r.fresh.opId ? { opId: r.fresh.opId } : {}) }
            if (r.kind === "pane") return openPrompt(r as unknown as PaneOpened)
            return r.kind === "reproposed" ? "That card had expired, so here's a fresh one at the current price." : undefined
          })
        } finally {
          approvingRef.current.delete(card.cardId)
        }
        if (chain) {
          chain.approving = undefined
          checkChain()
        }
        return
      }
      case "reloadAliases":
        return reloadAliases()
      case "theme":
        return pickTheme(effect.name)
      case "reject":
        return call("cards.reject", { cardId: effect.cardId })
      case "build":
        return buildRef.current.act(effect.ref)
      case "kill":
        return call("kill", {}, () => "Kill switch on: buys paused, the agent's turn stopped. Sells still work.")
      case "mode":
        return call<{ said?: string }>("mode.set", { mode: effect.mode }, (r) => `Now in ${effect.mode} mode.${r?.said ? ` ${r.said}` : ""}`)
      case "setAgent":
        return call("agent.setActive", { agent: effect.agent })
      case "requote":
        if (effect.wallet) return call("cards.requote", { cardId: effect.cardId, wallet: effect.wallet.word }, () => `A new card, paid from ${effect.wallet!.name}, at the current price. The old one is withdrawn.`)
        return call("cards.requote", { cardId: effect.cardId }, () => "A fresh card, at the current price.")
      case "resolve": {
        const op = unanswered(viewRef.current).find((o) => o.cardId === effect.cardId)
        return op ? resolve(op, effect.action) : say("That one has its answer now.")
      }
      case "readModels":
        return readModels()
      case "layout":
        return applyLayout(effect.op)
      case "signals":
        return setSignals(tabLayout(heldRef.current, uiRef.current.tab).tab.name, effect.change)
      case "autonomy": {
        const params = { wallet: effect.wallet, setting: effect.setting, ...(effect.setting === "inside" ? { perTradeUsd: effect.perTradeUsd, perDayUsd: effect.perDayUsd } : {}) }
        const whose = walletWords(effect.name)
        return call("autonomy.set", params, () =>
          effect.setting === "inside"
            ? `${whose.charAt(0).toUpperCase()}${whose.slice(1)} trades inside limits now: ${money(effect.perTradeUsd!)} a trade, ${money(effect.perDayUsd!)} a day without a card. Over either, a buy or swap is a card; sells always run.`
            : `${whose.charAt(0).toUpperCase()}${whose.slice(1)} asks every time now: every trade from it is a card.`,
        )
      }
      case "nameWallets":
        // Several at once: the core checks every name, writes the Candle Harness's, and opens the pane for Candle's.
        return call<{ said: string; panes?: PaneOpened[] }>("wallets.name", { names: effect.names }, (r) => {
          const trouble = (r.panes ?? []).map((p) => openPrompt(p)).find((m) => m !== undefined)
          return trouble ?? r.said
        })
      case "walletsShow": {
        // One group, or every group again: the core keeps it as `[wallets] show`.
        const group = typeof effect.show === "string" && effect.show.startsWith("group:") ? effect.show.slice(6) : undefined
        return call("wallets.show", { show: effect.show }, () => (group ? `Showing the group ${group}.` : effect.show === "all" ? "Showing every wallet on the account, grouped." : "Showing the wallets an agent here can pay from, grouped."))
      }
      case "pnlWindow":
        return call("pnl.window", { window: effect.window }, () => `The P&L window is now ${pnlWindowWords(effect.window)}: every P&L figure counts from there.`)
      case "skillsFolder":
        return call("skills.set", { folder: effect.folder, on: effect.on }, () => (effect.on ? `The agents now use the skills in ${effect.folder}, from their next turn.` : `The agents no longer use the skills in ${effect.folder}.`))
      case "triggerSet":
        return call<{ said: string }>("triggers.set", { name: effect.name, on: effect.on }, (r) => r.said)
      case "triggerRemove":
        return call<{ said: string }>("triggers.remove", { name: effect.name }, (r) => r.said)
      case "triggerRunNow":
        return call<{ said: string }>("triggers.runNow", { cardId: effect.cardId }, (r) => r.said)
      case "bot": {
        // One press, one request: the same change to the same bot again within a second is the same press (a
        // terminal's click reported twice), and its second answer ("paused already") would hide the first.
        const key = `${effect.method}:${effect.name}:${effect.positions ?? ""}`
        const last = lastBotCall.current
        if (last && last.key === key && Date.now() - last.at < BOT_REPEAT_MS) return
        lastBotCall.current = { key, at: Date.now() }
        if (effect.method === "pauseFlatten") {
          // Pause first, so its next buy is refused; then flatten. A pause the core refuses leaves the positions as they are.
          return void (async () => {
            try {
              await session.request("bots.pause", { name: effect.name })
            } catch (error) {
              return dispatch({ type: "message", text: message(error), level: "error", now: now() })
            }
            await call<{ said?: string }>("bots.flatten", { name: effect.name }, (r) => `"${effect.name}" is paused. ${r.said ?? "Its open positions are selling."}`)
          })()
        }
        return call<{ said?: string }>(`bots.${effect.method}`, { name: effect.name, ...(effect.positions ? { positions: effect.positions } : {}) }, (r) => r.said ?? `Done: "${effect.name}".`)
      }
      case "botControl":
        return call<{ said?: string }>("bots.control", { name: effect.name, id: effect.id }, (r) => r.said ?? `Done: "${effect.name}".`)
      case "botExitsRemove":
        return call<{ said?: string }>("bots.exits.remove", { name: effect.name, position: effect.position }, (r) => r.said ?? `The core no longer holds exits on that position of "${effect.name}": its code sells it.`)
      case "botLog": {
        const name = effect.name
        const held = (botLog: BotLogHeld) => {
          viewRef.current = { ...viewRef.current, botLog }
          setView(viewRef.current)
        }
        held({ name })
        return void session
          .request<{ lines: string[]; file: string }>("bots.logs", { name, lines: 2000 })
          .then((r) => held({ name, lines: r.lines, file: r.file }))
          .catch((error) => held({ name, error: message(error) }))
      }
      case "keepAwake":
        return call("core.keepAwake", { on: effect.on }, () => (effect.on ? "The Mac is kept awake while a trigger or bot is on. A closed lid still sleeps it on battery." : "Keep-awake is off: the Mac may sleep while triggers or bots are on."))
      case "skillsRead":
        return void session.request("skills.read").catch(() => {})
      case "journalOlder":
        return journalRef.current.older()
      case "journalRows":
        return readJournalRows(session, effect, (journalRows) => {
          viewRef.current = { ...viewRef.current, journalRows }
          setView(viewRef.current)
        })
      case "pin": {
        // The palette's pin row, as the token pane's chip.
        const tabName = tabLayout(heldRef.current, uiRef.current.tab).tab.name
        const pinned = viewRef.current.views?.pins.some((p) => p.at === tabName && pinPane(p) === "token") === true
        return pinned === effect.on ? undefined : togglePin(tabName)
      }
      case "link":
        // The person's pick: a later pick answered first leaves this one superseded, said by nothing.
        return call("view.link", { mint: effect.mint, ...(effect.chain ? { chain: effect.chain } : {}), ...(effect.from ? { from: effect.from } : {}) })
      case "wake": {
        const timer = setTimeout(() => dispatch({ type: "tick", now: now() }), effect.afterMs)
        timer.unref?.()
        return
      }
      case "chooseEngine": {
        const label = viewRef.current.engine?.engines[effect.engine]?.label ?? ENGINE_LABELS[effect.engine]
        return call("engine.choose", { agent: effect.agent, engine: effect.engine, ...(effect.model ? { model: effect.model } : {}) }, () => `${effect.agent} is on ${label}${effect.model ? ` · ${effect.model}` : ", its default model,"} from its next turn.`)
      }
      case "choosePreset": {
        const label = PRESET_LABELS[effect.preset]
        return call("preset.choose", { agent: effect.agent, preset: effect.preset }, () => `${effect.agent} runs as ${label} from its next turn.`)
      }
      case "setRunner":
        return call<{ run: "off" | string[] }>("agent.run", { agent: effect.agent, on: effect.on }, (r) =>
          r.run === "off" ? `${effect.agent}'s code runner is off.` : `${effect.agent}'s code runner is on for ${r.run.join(", ")} from its next turn, held to its research folder with no network.`,
        )
      case "readMemory":
        return call("memory.read", {})
      case "stopTurn":
        return call<{ cancelled: boolean }>("agent.cancel", { agent: effect.agent, keepQueued: true }, (r) => (r.cancelled ? undefined : `${effect.agent} has no turn running.`))
      case "memoryDelete": {
        const { type: _type, agent, ...what } = effect
        return call("memory.delete", { agent, ...what }, () => (what.all ? `Cleared ${agent}'s memory.` : `Deleted from ${agent}'s memory.`))
      }
      case "memoryPin":
        return call("memory.pin", { agent: effect.agent, entry: effect.entry, pinned: effect.pinned }, () => (effect.pinned ? `Pinned in ${effect.agent}'s memory: it stays through the agent's merges.` : `Unpinned in ${effect.agent}'s memory.`))
      case "copy": {
        const what = effect.what ?? (effect.text === viewRef.current.portfolio?.deposit ? "the deposit address" : "the address")
        const m = copiedMessage(await copier.copy(effect.text), what, effect.what === undefined)
        return say(m.text, m.level)
      }
      case "popOut":
        return popOutPane(effect.pane)
      case "quit":
        return onQuit()
    }
  }

  /**
   * A pane into a split of its own. The core's `views` topic then says it's popped, and
   * this view leaves it out until that view goes. With no split to go to, the command to run by hand.
   */
  async function popOutPane(pane: PaneId) {
    if (!popOut) return say(`This view can't pop ${pane} out.`, "error")
    let r
    try {
      r = await popOut(pane)
    } catch (error) {
      return say(`${pane} didn't pop out: ${message(error)}`, "error")
    }
    if (r.kind === "split") return say(`${pane} is in a ${r.where} split of its own. Close it there (ctrl-c twice) and it comes back here.`)
    dispatch({ type: "message", text: `${pane} has no split to pop out to: ${r.why}. Run this in a split or window of any terminal; it attaches to the same core.`, level: "info", now: now(), copy: r.command })
  }

  /**
   * Every engine's models that can run here, as the picker opens: the list the core last read, at once,
   * then a fresh read. A list not yet answered shows "reading…".
   */
  function readModels() {
    const engines = viewRef.current.engine?.engines ?? {}
    for (const [id, info] of Object.entries(engines) as [EngineId, (typeof engines)[EngineId]][]) {
      if (!canRun(info)) continue
      setList(id, (was) => ({ models: was?.models ?? [], notes: was?.notes ?? [], reading: true }))
      const ask = async (fresh: boolean) => {
        try {
          const r = await session.request<{ models: EngineModel[]; notes?: string[]; error?: string }>("engine.models", { engine: id, ...(fresh ? { fresh: true } : {}) })
          setList(id, (was) => ({ models: r.models, notes: r.notes ?? [], reading: fresh ? false : (was?.reading ?? false), ...(r.error ? { error: r.error } : {}) }))
        } catch (error) {
          setList(id, (was) => ({ models: was?.models ?? [], notes: was?.notes ?? [], reading: false, error: message(error) }))
        }
        dispatch({ type: "modelsRead", now: now() })
      }
      void ask(false).then(() => ask(true))
    }
  }

  /**
   * Opens the prompt pane for a card the core just gave this view a ticket for: the launcher in a PTY
   * of its own, the ticket in its environment, then its pid to the core, which takes the ticket only
   * from that process. The ticket isn't kept here.
   */
  function openPrompt(r: PaneOpened, setup: { harness?: EngineId } = {}): string | undefined {
    if (!spawnPane) return "This view can't open the prompt pane. Nothing was run; the card's ticket expires in two minutes."
    const inner = promptInner(obShownRef.current ? obPaneRect(width, height) : agentRectRef.current)
    let proc
    try {
      proc = spawnPane({ ticket: r.ticket, cols: inner.cols, rows: inner.rows })
    } catch (error) {
      return `The prompt pane didn't start: ${message(error)}. Nothing was run.`
    }
    // The setup part the pane was opened from, so its close can tell whether setup went on past it.
    const inSetup = obShownRef.current ? viewRef.current.onboarding?.at : undefined
    // In onboarding, a device code on the pane's screen gets ⧉ chips under it. Read here, in the view, and kept nowhere else.
    if (obShownRef.current) {
      setOb((o) => {
        const { code: _gone, ...rest } = o
        return rest
      })
      const decoder = new TextDecoder()
      let screen = ""
      proc.onData((chunk) => {
        if (screen.length > 20_000) return
        screen += decoder.decode(chunk, { stream: true })
        const found = codeFrom(screen)
        if ((found.code || found.url) && (found.code !== obRef.current.code?.code || found.url !== obRef.current.code?.url)) setOb((o) => ({ ...o, code: found }))
      })
    }
    const prompt: Prompt = { ticketId: r.ticketId, ...(r.card?.opId ? { opId: r.card.opId } : {}), title: r.title, proc, hidden: false }
    // The newest is shown; any other goes behind its chip.
    setPromptList([...promptsRef.current.map((x) => ({ ...x, hidden: true })), prompt])
    // A typed new-address card's "click yes, a new address" has been done: it shouldn't stay its 6 s over the pane.
    dispatch({ type: "paneOpened" })
    void session.request("pane.spawned", { ticketId: r.ticketId, pid: proc.pid }).catch((error) => say(`The prompt pane couldn't start: ${message(error)}`, "error"))
    void proc.exited.then((code) => {
      setPromptList(promptsRef.current.map((x) => (x.ticketId === r.ticketId ? { ...x, exited: code } : x)))
      if (inSetup) setTimeout(() => setupPaneDone(r.ticketId, setup.harness, inSetup), SETUP_PANE_SETTLE_MS)
    })
    return undefined
  }

  /**
   * A setup pane that worked closes by itself, and the highlight goes to what's next with its key named, so it's
   * clear when to press Esc and when Enter. Worked is read from setup, not the launcher's exit (always 0): a
   * harness signed in, or setup gone on past the part the pane was for. One that didn't stays open with its reason.
   */
  function setupPaneDone(ticketId: string, harness: EngineId | undefined, openedAt: string, tries = 0) {
    const shown = promptsRef.current.find((x) => x.ticketId === ticketId)
    if (!obShownRef.current || !shown || shown.hidden) return
    const v = viewRef.current
    const worked = harness ? v.engine?.engines[harness]?.signedIn === true : v.onboarding?.at !== openedAt
    if (!worked) {
      // What the pane did can take Candle's reads a moment longer to show: looked at again before it's left open.
      if (tries < 3) setTimeout(() => setupPaneDone(ticketId, harness, openedAt, tries + 1), SETUP_PANE_SETTLE_MS)
      return
    }
    closePrompt(ticketId)
    if (harness) {
      // Signed in to use it: it's picked, and the highlight goes to its test message.
      const label = v.engine?.engines[harness]?.label ?? harness
      void session
        .request<OnboardingView>("onboarding.set", { engine: harness })
        .then(setOnboarding)
        .catch(() => {})
        .finally(() => setOb((o) => ({ ...o, hold: "test", said: { text: `Signed in to ${label}. ⏎ sends a test message.`, level: "info" } })))
      return
    }
    setOb((o) => ({ ...o, sel: 0, said: { text: "Done in the pane: the highlighted line says where ⏎ goes.", level: "info" } }))
  }

  /** A choice on onboarding's screen, picked by ⏎ or a click. Each answer is said on the screen itself. */
  async function obAct(action: ObAction) {
    // A press while the last one is still with the core is dropped, so nothing acts twice; a copy needs no core.
    if (obRef.current.busy && action.kind !== "copy") return
    const fail = (error: unknown) => setOb((o) => ({ ...o, busy: undefined, said: { text: message(error), level: "error" } }))
    const set = (params: Record<string, unknown>) => session.request<OnboardingView>("onboarding.set", params).then(setOnboarding)
    // What a press waits on is said at once: on a slow machine the core's reads can take seconds, and a screen
    // that doesn't change reads as a press that was lost.
    const word = OB_WAIT_WORDS[action.kind]
    setOb((o) => {
      const { said: _gone, hold: _held, ...rest } = o
      return word ? { ...rest, busy: word } : rest
    })
    try {
      switch (action.kind) {
        case "welcome":
          if (action.straightIn) await set({ straightIn: true })
          return void (await set({ passed: "welcome" }))
        case "useProfile":
          return void (await set({ profile: action.profile }))
        case "reread":
          return setOnboarding(await session.request<OnboardingView>("onboarding.get", {}))
        case "signIn": {
          const r = await session.request<{ opened: Omit<PaneOpened, "kind">; warning?: string }>("onboarding.signIn", {})
          setOb((o) => ({ ...o, paneFor: "candle", ...(r.warning ? { said: { text: r.warning, level: "error" as const } } : {}) }))
          const failed = openPrompt({ kind: "pane", ...r.opened })
          return failed ? fail(failed) : undefined
        }
        case "engine": {
          await set({ engine: action.engine, ...(action.model ? { model: action.model } : {}) })
          // Picking a model would look like it did nothing, so the highlight goes to the test message, which is
          // what moves setup on.
          // Held there: the engine's models land above it a moment later, and would otherwise slide the highlight onto one.
          const at = obItemsNow().findIndex((i) => i.kind === "test")
          if (at >= 0) setOb((o) => ({ ...o, sel: at, hold: "test", said: { text: "⏎ sends one word to test it, then you go on.", level: "info" } }))
          return
        }
        case "harness": {
          // OpenCode's and Pi's say first what to pick there.
          if (HARNESS_SIGN_INS[action.engine].before && obRef.current.before !== action.engine) return setOb((o) => ({ ...o, before: action.engine, sel: 0 }))
          setOb((o) => {
            const { before: _gone, ...rest } = o
            return rest
          })
          const r = await session.request<{ ticket: string; ticketId: string; title: string }>("onboarding.harness", { engine: action.engine })
          setOb((o) => ({ ...o, paneFor: action.engine }))
          const failed = openPrompt({ kind: "pane", ...r }, { harness: action.engine })
          return failed ? fail(failed) : undefined
        }
        case "copy":
          dispatch({ type: "clickCopy", text: action.text, what: action.what, now: now() })
          return setOb((o) => ({ ...o, said: { text: `Copied ${action.what}.`, level: "info" } }))
        case "test": {
          const st = viewRef.current.onboarding?.state
          if (!st?.engine) return
          const engine = st.engine
          const label = viewRef.current.engine?.engines[engine]?.label ?? engine
          setOb((o) => {
            const { test: _gone, ...rest } = o
            return { ...rest, busy: `sending one word to ${label}${st.model ? ` · ${st.model}` : ""}…` }
          })
          const r = await session.request<{ ok: boolean; words?: string; reply?: string; ms?: number; view?: OnboardingView }>("onboarding.test", {})
          if (r.view) setOnboarding(r.view)
          // Answered, the highlight goes to the last choice, Continue.
          return setOb((o) => ({ ...o, busy: undefined, ...(r.ok ? { sel: 999 } : {}), test: r.ok ? { ok: true, engine, ...(st.model ? { model: st.model } : {}), reply: r.reply ?? "", ms: r.ms ?? 0 } : { ok: false, words: r.words ?? "it didn't answer." } }))
        }
        case "continue":
          return void (await set({ passed: action.step ?? "engine" }))
        case "field": {
          // ⏎ on a field goes on to the next choice; after a step's last field, back to its main control, first.
          const count = obItemsRef.current.length
          return setOb((o) => ({ ...o, sel: o.sel + 1 < count ? o.sel + 1 : 0 }))
        }
        case "vault": {
          await set({ vaultChoice: action.now ? "now" : "later" })
          if (!action.now) return
          return runPane(["vault", "init"], { line: "The CLI makes a passphrase or takes your own, then offers your 24 recovery words once.", wait: "answer the CLI in the pane; write the words down" })
        }
        case "securityKey":
          return runPane(["vault", "enroll", "security-key"], { line: "Your factor first, then touch the security key when the CLI asks.", wait: "answer the CLI in the pane" })
        case "makeKey": {
          const st = viewRef.current.onboarding
          if (!st) return
          const name = agentNameOf(st, obRef.current, obCtx)
          const made = keyArgv(name, fieldValue(obRef.current, "cap", "50"))
          if ("problem" in made) return fail(made.problem)
          // The name is asked for first, so a key made under it and not stored is found on the way back.
          await set({ agent: name })
          return runPane(made.argv, { line: `The key goes straight into the Candle Harness as ${name}, never on screen.`, wait: "answer the CLI in the pane" })
        }
        case "revoke": {
          // Narrowing access runs at once in the core, with no pane (a pane would say "didn't open the pane" after
          // the revoke had gone through). What it said is shown, and setup reads the keys again.
          const r = await session.request<{ kind?: string; exitCode?: number; error?: { message?: string } }>("cli.run", { argv: ["keys", "revoke", action.prefix] })
          if (r.kind === "pane") return void openPrompt(r as unknown as PaneOpened)
          await session.request<OnboardingView>("onboarding.get", {}).then(setOnboarding).catch(() => {})
          const failed = r.exitCode !== 0
          return setOb((o) => ({ ...o, said: { text: failed ? `Revoking ${action.prefix} didn't go through${r.error?.message ? `: ${r.error.message}` : ""}. candle keys list says whether it's still live.` : `Revoked ${action.prefix}.`, level: failed ? "error" : "info" } }))
        }
        case "allowEmbedded": {
          const f = viewRef.current.onboarding?.facts
          if (f?.key.state !== "stored") return fail("Make the key first.")
          return runPane(["keys", "update", f.key.prefix, "--embedded-wallet", "allow"], { line: "Candle asks you to type the key's prefix back to allow it.", wait: `type ${f.key.prefix} at the CLI's prompt` })
        }
        case "ownWallet": {
          const st = viewRef.current.onboarding
          if (!st || st.facts.key.state !== "stored" || !st.facts.vaultKey || !st.state.agent) return
          const name = obRef.current.fields?.walletName?.trim()
          // The fresh TEE route the chips take: promoted from the vault key, its name as Candle's label.
          const words = freshTeeStep(1, st.state.agent.name, { prefix: st.facts.key.prefix, vaultKey: st.facts.vaultKey }).line.split(" ").slice(1)
          const argv = name ? words.map((w, i) => (words[i - 1] === "--label" ? name : w)) : words
          if (argv.some((w) => /\s/.test(w))) return fail("A wallet's name for Candle has no spaces in it: leave it empty, or name it without one.")
          return runPane(argv, { line: `A TEE wallet of ${st.state.agent.name}'s own, promoted from your vault key.`, wait: "answer the CLI in the pane" })
        }
        case "keepLimits": {
          const st = viewRef.current.onboarding
          if (!st) return
          const own = viewRef.current.status?.agents.find((a) => a.name === st.state.agent?.name)?.limits
          const t = parseFigure(fieldValue(obRef.current, "perTrade", String(own?.perTradeUsd ?? 10)))
          const d = parseFigure(fieldValue(obRef.current, "perDay", String(own?.perDayUsd ?? 50)))
          if (!t.ok) return fail(`Per trade: ${t.why}`)
          if (!d.ok) return fail(`Per day: ${d.why}`)
          return setOnboarding(await session.request<OnboardingView>("onboarding.limits", { perTradeUsd: t.usd, perDayUsd: d.usd }))
        }
        case "inside":
          return setOb((o) => ({ ...o, inside: action.on }))
        case "approvals": {
          const st = viewRef.current.onboarding
          const agent = st?.state.agent?.name
          const w = viewRef.current.autonomy?.wallets.find((x) => agent !== undefined && x.agents.includes(agent) && !x.gone)
          if (obRef.current.inside && w) {
            const t = parseFigure(fieldValue(obRef.current, "autoTrade", ""))
            const d = parseFigure(fieldValue(obRef.current, "autoDay", ""))
            if (!t.ok) return fail(`Per trade: ${t.why}`)
            if (!d.ok) return fail(`Per day: ${d.why}`)
            // The approvals menu's own call: the person's, from the main view.
            await session.request("autonomy.set", { wallet: w.wallet, setting: "inside", perTradeUsd: t.usd, perDayUsd: d.usd })
          }
          return void (await set({ passed: "approvals" }))
        }
        case "later":
          return setOnboarding(await session.request<OnboardingView>("onboarding.fundLater", {}))
        case "start": {
          // Step 5: the tab kept as the one the Candle Harness opens on, shown now, then setup's end.
          const at = heldRef.current.file.tabs.findIndex((t) => t.name === action.tab)
          try {
            store.saveOpensOn(action.tab)
          } catch {
            // Not kept: the Candle Harness opens on its first tab next time, and this time on the one picked.
          }
          if (at >= 0) dispatch({ type: "showTab", tab: at, now: now() })
          return void (await set({ passed: "start" }))
        }
        case "back":
          return setOb((o) => {
            const { before: _gone, ...rest } = o
            return { ...rest, sel: 0 }
          })
        case "stepBack":
          try {
            await set({ back: true })
            return setOb((o) => ({ ...o, sel: 0 }))
          } catch (error) {
            // Nothing to go back to is said plainly, not as a failure.
            return setOb((o) => ({ ...o, said: { text: message(error), level: "info" } }))
          }
      }
    } catch (error) {
      fail(error)
    } finally {
      if (word)
        setOb((o) => {
          if (o.busy !== word) return o
          const { busy: _done, ...rest } = o
          return rest
        })
    }
  }

  /** Step 5's: the tabs shown, how many there are in all, and the files, as the person would type them. */
  function startContext(): NonNullable<ObContext["start"]> {
    const h = heldRef.current
    const home = homedir()
    const tilde = (p: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
    return { tabs: h.file.tabs.map((t) => t.name), total: allTabs(h.file).length, files: [tilde(joinPath(dirname(store.path), "config.toml")), tilde(store.path)] }
  }

  /**
   * The welcome after setup: what this view's setup made, once its key is stored and while
   * that agent is the one in view. A later view, or another agent, gets the plain welcome.
   */
  function setUpSummary(): SetUpSummary | undefined {
    const ob = view.onboarding
    const agent = ob?.state.agent?.name
    if (!inSetup || !ob || !agent || ob.facts.key.state !== "stored" || view.status?.activeAgent !== agent) return undefined
    // The model by name even when setup kept the engine's default, as the pane's chip names it.
    const chip = engineChipText(view.engine, agent)?.replace(/ ▾$/, "")
    const engine = ob.state.engine ? (chip ?? `${view.engine?.engines[ob.state.engine]?.label ?? ob.state.engine}${ob.state.model ? ` · ${ob.state.model}` : ""}`) : undefined
    const w = view.autonomy?.wallets.find((x) => x.agents.includes(agent) && !x.gone)
    const wallet = w ? `${walletWords(w.name)}, ${w.setting === "inside" && w.perTradeUsd !== undefined && w.perDayUsd !== undefined ? `trading inside ${money(w.perTradeUsd)} a trade and ${money(w.perDayUsd)} a day without a card` : "asking every time"}` : undefined
    const own = view.status?.agents.find((a) => a.name === agent)
    const candle = (own?.limitLines ?? []).filter((l) => l.by === "Candle" && !l.wallet).map((l) => l.words.replace(/^Candle · /, "").replace(/ · \$[\d.,]+ used$/, ""))
    const limits = own?.limits ? [`Harness ${money(own.limits.perTradeUsd)} a trade, ${money(own.limits.perDayUsd)} a day`, ...candle.map((c) => `Candle ${c}`)].join(" · ") : undefined
    return { agent, ...(engine ? { engine } : {}), ...(ob.facts.profile ? { profile: ob.facts.profile } : {}), ...(wallet ? { wallet } : {}), ...(limits ? { limits } : {}), ...(view.status?.mode ? { mode: view.status.mode } : {}) }
  }

  /** An owner step of setup's, typed by the person as the line would be: the pane opens at once. */
  async function runPane(argv: string[], words: { line: string; wait: string }) {
    // One owner step at a time (a second Enter while the first pane opened would make a second key).
    if (obPaneBusyRef.current || promptsRef.current.some((x) => !x.hidden)) return
    obPaneBusyRef.current = true
    let r: { kind?: string; said?: string }
    try {
      r = await session.request<{ kind?: string; said?: string }>("cli.run", { argv })
    } finally {
      obPaneBusyRef.current = false
    }
    if (r.kind !== "pane") throw new Error(r.said ?? `candle ${argv.join(" ")} didn't open the pane.`)
    setOb((o) => {
      const { paneFor: _gone, code: _code, ...rest } = o
      return { ...rest, paneWords: words }
    })
    const failed = openPrompt(r as unknown as PaneOpened)
    if (failed) throw new Error(failed)
  }

  /**
   * Onboarding's choices from the state as it is now, not as last drawn: a burst of keys after a pick (trade inside
   * limits shows two more rows) lands on the rows that pick made.
   */
  function obItemsNow(): ObAction[] {
    const v = viewRef.current
    if (!obShownRef.current || !v.onboarding) return obItemsRef.current
    const ctx: ObContext = { ...(v.status?.agents ? { agents: v.status.agents } : {}), ...(v.autonomy ? { autonomy: v.autonomy } : {}), ...(v.portfolio ? { portfolio: v.portfolio } : {}), start: startContext() }
    // As they'll be once a wait ends: a press is dropped while one is with the core, and a row it shows (the test's) is the one to land on.
    const { busy: _waiting, ...local } = obRef.current
    return stepRows({ view: v.onboarding, ...(v.engine ? { engine: v.engine } : {}), local, width: stepRect(width, height).w - 6, paneOpen: promptsRef.current.some((x) => !x.hidden), ctx }).items.map((i) => i.action)
  }

  /** Typed into the highlighted field, if it is one: its own characters only (fieldTakes). */
  function obType(chars: string, back = false): boolean {
    const now_ = obItemsNow()
    const action = now_[Math.min(obRef.current.sel, now_.length - 1)]
    if (action?.kind !== "field") return false
    const st = viewRef.current.onboarding
    const fallback = st && action.id === "agentName" ? agentNameOf(st, obRef.current, obCtx) : action.id === "cap" ? "50" : ""
    let value = fieldValue(obRef.current, action.id, action.id === "perTrade" || action.id === "perDay" ? currentLimit(action.id) : fallback)
    if (back) value = value.slice(0, -1)
    else for (const ch of chars) value = fieldTakes(action.id, value, ch) ?? value
    setOb((o) => {
      const { said: _gone, ...rest } = o
      return { ...rest, fields: { ...o.fields, [action.id]: value } }
    })
    return true
  }
  const currentLimit = (id: "perTrade" | "perDay") => {
    const own = viewRef.current.status?.agents.find((a) => a.name === viewRef.current.onboarding?.state.agent?.name)?.limits
    return String(id === "perTrade" ? (own?.perTradeUsd ?? 10) : (own?.perDayUsd ?? 50))
  }

  /** Onboarding's keys: ↑/↓ move the highlight, ⏎ picks, ctrl-] shows a pane left behind. ctrl-c still quits. */
  function obKey(key: KeyEvent) {
    // A key pressed: the highlight is the person's again.
    if (obRef.current.hold) setOb((o) => {
      const { hold: _gone, ...rest } = o
      return rest
    })
    if (key.name === "backspace" && obType("", true)) return
    if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f" && obType(key.sequence)) return
    const items = obItemsNow()
    const count = items.length
    if (key.sequence === "\x1d") {
      const last = promptsRef.current.at(-1)
      if (last) showPrompt(last.ticketId)
      return
    }
    // Esc goes back: out of a harness's sign-in screen first, else to the step before.
    if (key.name === "escape") return void obAct(obRef.current.before ? { kind: "back" } : { kind: "stepBack" })
    if (count === 0) return
    if (key.name === "up" || key.name === "down") return setOb((o) => ({ ...o, sel: (Math.min(o.sel, count - 1) + (key.name === "up" ? count - 1 : 1)) % count }))
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
      if (obRef.current.busy) return
      const action = items[Math.min(obRef.current.sel, count - 1)]
      if (obRef.current.sel >= count) setOb((o) => ({ ...o, sel: count - 1 }))
      if (action) void obAct(action)
    }
  }

  /** Closes a pane: hangs it up if it's still running, and drops its screen. */
  function closePrompt(ticketId: string) {
    const prompt = promptsRef.current.find((x) => x.ticketId === ticketId)
    if (!prompt) return
    if (prompt.exited === undefined) prompt.proc.close()
    setPromptList(promptsRef.current.filter((x) => x.ticketId !== ticketId))
  }

  /** Shows a pane (and hides any other), or leaves them all for the Candle Harness. */
  function showPrompt(ticketId: string | undefined) {
    const list = promptsRef.current
    const picked = list.find((x) => x.ticketId === ticketId)
    // The shown one is last, so ctrl-] comes back to it.
    const rest = list.filter((x) => x !== picked).map((x) => ({ ...x, hidden: true }))
    setPromptList(picked ? [...rest, { ...picked, hidden: false }] : rest)
  }

  /** A Ctrl-C typed into a pane: if the launcher is still running a second later, it's asked to stop `candle`. */
  function watchInput(ticketId: string, bytes: Uint8Array) {
    if (!bytes.includes(0x03)) return
    setTimeout(() => {
      const prompt = promptsRef.current.find((x) => x.ticketId === ticketId)
      if (prompt && prompt.exited === undefined) prompt.proc.signal("SIGUSR1")
    }, stopAfterMs)
  }

  // ctrl-], the kill switch's second press and a finished pane's Enter or Esc, before anything else sees them.
  useEffect(() => {
    const handler = (sequence: string): boolean => {
      const shown = shownPrompt()
      // The kill switch works while a terminal pane has the keys too. The first ctrl-x goes on to the pane (an
      // editor's own ctrl-x still works) and arms it; a second within the window pauses, and the pane never sees it.
      if (shown || buildHasKeys()) {
        if (CTRL_X.test(sequence)) {
          const armed = uiRef.current.killArmedAt !== undefined && now() - uiRef.current.killArmedAt <= KILL_WINDOW_MS
          dispatch({ type: "key", key: { name: "x", ctrl: true, sequence: "\x18" }, now: now() })
          return armed
        }
        if (uiRef.current.killArmedAt !== undefined) dispatch({ type: "disarmKill" })
      }
      // Too small to draw: the panes aren't on screen, so ctrl-] moves nothing unseen.
      if (tooSmall()) return false
      if (CTRL_BRACKET.test(sequence)) {
        // A Build card that opened without the keys takes them.
        if (buildCardWaits()) return dispatch({ type: "takeBuildCard", now: now() }), true
        if (shown) showPrompt(undefined)
        else if (promptsRef.current.length > 0) showPrompt(promptsRef.current.at(-1)!.ticketId)
        // The Build pane's harness: out of it to the pane before it, or the tab bar; or back in, where it's on screen.
        else if (buildHasKeys()) {
          const back = uiRef.current.recent.find((p) => p !== "build")
          dispatch(back ? { type: "clickPane", pane: back, now: now() } : { type: "focusTabs", now: now() })
        } else if (buildRef.current.stage === "running" && navRef.current.order.includes("build") && !uiRef.current.overlay) dispatch({ type: "clickPane", pane: "build", now: now() })
        else return false
        return true
      }
      if (shown && shown.exited !== undefined && (ENTER.test(sequence) || ESC.test(sequence))) {
        closePrompt(shown.ticketId)
        return true
      }
      return false
    }
    renderer.prependInputHandler(handler)
    return () => renderer.removeInputHandler(handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer])
  // Every pane is hung up when the view goes.
  useEffect(() => () => {
    for (const x of promptsRef.current) if (x.exited === undefined) x.proc.close()
  }, [])

  // Text selected with the mouse, so the view can be copied from. The Candle Harness takes the
  // mouse, so the terminal's own selection and menu don't reach it: drag to select, then ctrl-c or a
  // right-click copies. With nothing selected, ctrl-c is what it always was.
  const copySelection = async () => {
    const text = renderer.getSelection()?.getSelectedText() ?? ""
    renderer.clearSelection()
    if (!text.trim()) return
    const m = copiedMessage(await copier.copy(text), "the selection", false)
    say(m.text, m.level)
  }
  useEffect(() => {
    const onSelection = (selection: { getSelectedText(): string } | null) => {
      // In the Build pane's harness, ctrl-c is the harness's own (it quits some): only a right-click copies there.
      if (selection?.getSelectedText().trim()) say(selectionHint(buildHasKeys()))
    }
    renderer.on("selection", onSelection)
    return () => {
      renderer.off("selection", onSelection)
    }
  }, [renderer])

  useKeyboard((key: KeyEvent) => {
    used()
    // Too small to draw: only the kill switch and quitting work. Enter mustn't approve a card nobody can see.
    if (tooSmall()) {
      if (key.ctrl && key.name === "c") dispatch({ type: "key", key: { name: "c", ctrl: true, sequence: key.sequence }, now: now() })
      // With a terminal pane holding the keys, the kill chord was taken before this.
      else if (key.ctrl && key.name === "x" && !shownPrompt() && !buildHasKeys()) dispatch({ type: "key", key: { name: "x", ctrl: true, sequence: key.sequence }, now: now() })
      return
    }
    // A shown prompt pane has every key: none reaches the input line or the frame's step.
    if (shownPrompt()) return
    // So does the Build pane's harness, focused: its terminal takes them.
    if (buildHasKeys()) return
    // Onboarding's screen has its own keys; ctrl-c quits as anywhere.
    if (obShownRef.current && !(key.ctrl && key.name === "c")) return obKey(key)
    // The Build pane's own screens, focused and with nothing over them: its form, and ⏎ to start.
    if (uiRef.current.focus === "build" && !uiRef.current.overlay && buildRef.current.key({ name: key.name, ctrl: key.ctrl, meta: key.meta, sequence: key.sequence })) return
    if (key.ctrl && key.name === "c" && renderer.hasSelection) {
      // A plain click leaves an empty selection behind: ctrl-c then clears, closes or quits as ever.
      if ((renderer.getSelection()?.getSelectedText() ?? "").trim()) return void copySelection()
      renderer.clearSelection()
    }
    dispatch({ type: "key", key: { name: key.name, ctrl: key.ctrl, meta: key.meta, shift: key.shift, sequence: key.sequence }, now: now() })
  })
  usePaste((event: PasteEvent) => {
    if (tooSmall()) return
    // The prompt pane and setup take passphrases, keys and secrets, so only the input line's pastes are logged.
    if (shownPrompt()) return
    if (buildHasKeys()) return
    if (obShownRef.current) return void obType(new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, ""))
    // Pasted into the Build pane's form: the folder or the command, one line.
    if (uiRef.current.focus === "build" && buildRef.current.stage === "ask") {
      for (const ch of new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, "")) buildRef.current.key({ name: ch, sequence: ch })
      return
    }
    onPaste?.(new TextDecoder().decode(event.bytes))
    dispatch({ type: "paste", text: new TextDecoder().decode(event.bytes), now: now() })
  })

  // Reopened within the core's 60 s grace, the view attaches to the old core, which hasn't read
  // the config edited in between. Said once, when the core says when it started.
  // The core's own writes (onboarding's profile, agent and limits) are in use already, so only an edit since warns.
  const coreStartedAt = view.status?.startedAt
  const configSeen = view.status?.configSeenMtime
  const warnedConfig = useRef(false)
  useEffect(() => {
    if (warnedConfig.current || configChangedAt === undefined || coreStartedAt === undefined || configChangedAt <= coreStartedAt) return
    if (configSeen !== undefined && configChangedAt <= configSeen) return
    warnedConfig.current = true
    say("config.toml changed after this core started, so it isn't in use yet. Quit; the core reads it when it starts again, 60 s after the last view closes.", "error")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configChangedAt, coreStartedAt, configSeen])

  useEffect(() => {
    if (!tickMs) return
    const timer = setInterval(() => {
      // The screen shows time to the second (ages, countdowns), so the clock it draws from moves once a
      // second; the keys' own windows (Enter's 300 ms, the kill switch's) run on every tick without drawing.
      // Moving it every tick redrew the whole view four times a second: 10% of a core, idle, all night.
      const t = now()
      setClock((was) => (Math.floor(was / 1000) === Math.floor(t / 1000) ? was : t))
      dispatch({ type: "tick", now: t })
    }, tickMs)
    return () => clearInterval(timer)
  }, [tickMs, now, dispatch])

  // Back from a window too small to draw: Enter's wait on each card starts over, so a press made as the
  // window grew doesn't approve a card that had only just come back into view.
  const drawable = width >= MIN_COLS && height >= MIN_ROWS
  const wasDrawable = useRef(drawable)
  useEffect(() => {
    if (drawable && !wasDrawable.current) dispatch({ type: "shown", now: now() })
    wasDrawable.current = drawable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawable])
  // The hint line says when Enter doesn't yet take a card that arrived under another: drawn again once it does.
  const behindCount = Object.keys(view.behind ?? {}).length
  useEffect(() => {
    if (!behindCount) return
    const timer = setTimeout(() => setClock(now()), APPROVE_AFTER_BEHIND_MS + 20)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behindCount])

  if (width < MIN_COLS || height < MIN_ROWS) return <TooSmall width={width} height={height} cards={openCards(view).length} killArmed={ui.killArmedAt !== undefined} paused={view.status?.paused === true} />

  const cards = openCards(view)
  const ctxNow = context()
  const focused = focusedCard(ui, ctxNow)
  const inputTop = height - 1
  const messageTop = inputTop - 1
  const bodyTop = bodyTopOf(width, height)
  const gap = gapFor(width, height)
  // While a chain waits, the message line says on what, unless something newer is being said.
  const messageUi: UiState = !ui.message && chainWords ? { ...ui, message: { text: chainWords, level: "info", at: clock } } : ui
  const status = view.status
  // The Build pane's first open fills the tab: the folder and the harness asked for, then the files written.
  const buildFirst = (build.stage === "ask" || build.stage === "written") && panesOf(layout.root).includes("build")
  const drawn = buildFirst ? BUILD_ALONE : layout
  // A layout without the agent pane: the cards, and the agent at work, in a strip above the input line.
  const activeAgent = status?.activeAgent ?? ""
  const hasAgent = panesOf(drawn.root).includes("agent")
  // The message and input lines sit under the agent pane, where it reaches the bottom (not from the left while
  // the agent is on the right); else across the width.
  const whole: Rect = { x: 0, y: bodyTop, w: width, h: Math.max(1, height - bodyTop) }
  const footAt = hasAgent ? place(drawn, whole, {}, { gap, foot: 2 }).foot! : { x: 0, y: messageTop, w: width, h: 2 }
  const footRows = messageRows(messageUi, footAt.w, true) + 1
  const fullHeight = Math.max(1, height - bodyTop - footRows)
  const agentTab = held.file.tabs.findIndex((_, i) => panesOf(tabLayout(held, i).layout.root).includes("agent"))
  // A terminal pane has the keys: the cards' heading says how to reach them, since ⏎ is the pane's.
  const paneHasKeys = shownPrompt() !== undefined || buildHasKeys()
  const strip = hasAgent
    ? []
    : stripLines({
        cards: inlineCards(view, activeAgent, clock),
        operations: view.operations,
        ...(view.triggers ? { runnable: runnableCards(view.triggers) } : {}),
        focusedCardId: focused?.cardId,
        cardsFocused: ui.focus === "cards",
        ...(paneHasKeys ? { paneHasKeys: true } : {}),
        now: clock,
        width: width - 3,
        ...((view.conversations[activeAgent] ?? []).some((e) => e.streaming || e.queued) ? { answering: activeAgent } : {}),
        ...(agentTab >= 0 ? { agentTab: { index: agentTab, name: held.file.tabs[agentTab]!.name } } : {}),
      })
  const stripHeight = stripRows(strip, fullHeight)
  // With the agent pane, the body runs down to the input line and the lines take the agent's last rows.
  const bodyHeight = hasAgent ? whole.h : Math.max(1, fullHeight - stripHeight)
  const foot = hasAgent ? footRows : 0
  const body: Rect = { x: 0, y: bodyTop, w: width, h: bodyHeight }
  bodyRef.current = body
  const placed = place(drawn, body, {}, { gap, foot })
  const lineAt = placed.foot ?? { x: 0, y: messageTop, w: width, h: footRows }
  const agentRect = placed.panes.find((p) => p.id === "agent")?.rect ?? body
  agentRectRef.current = agentRect
  // Onboarding's choices as drawn now, for ↑/↓ and ⏎ (the screen builds the same rows).
  obItemsRef.current = obShown && obView ? stepRows({ view: obView, ...(view.engine ? { engine: view.engine } : {}), local: ob, width: stepRect(width, height).w - 6, paneOpen: prompts.some((x) => !x.hidden), ctx: obCtx }).items.map((i) => i.action) : []
  navRef.current = paneNav(placed)
  // The Build pane where it's drawn: its own place, or the switched pane showing it.
  const buildRect = placed.panes.find((p) => p.id === "build")?.rect ?? (placed.switched && shownOf(placed.switched.group, ui.recent, placed.switched.first) === "build" ? placed.switched.rect : undefined)
  const buildTerm = buildRect ? terminalRect(buildRect) : undefined
  build.place(buildRect)
  // Off screen, the harness's terminal keeps the size it was last drawn at: a change would resize the harness and lose its screen.
  if (buildTerm) buildTermRef.current = buildTerm
  const termAt = buildTerm ?? buildTermRef.current
  const act = (cardId: string, a: Act) => {
    const at = now()
    if (a === "focus") return dispatch({ type: "clickCard", cardId, now: at })
    if (a === "approve") return dispatch({ type: "clickApprove", cardId, now: at })
    if (a === "reject") return dispatch({ type: "clickReject", cardId, now: at })
    if (a === "details") return dispatch({ type: "clickDetails", cardId, now: at })
    if (a === "resend" || a === "abandon") return dispatch({ type: "clickResolve", cardId, action: a, now: at })
    // Acts that aren't about a card: `cardId` carries the turn for an answer's ⧉, and is empty otherwise.
    if (a === "copyReply") {
      const reply = Object.values(viewRef.current.conversations).flat().find((e) => e.turnId === cardId)?.reply
      return reply ? dispatch({ type: "clickCopy", text: reply, what: "the answer", now: at }) : undefined
    }
    if (a === "stopHelp") return dispatch({ type: "clickStopHelp", now: at })
    // A ⧉ chip's line carries the address it copies.
    if (a === "copy") return dispatch({ type: "clickCopy", text: cardId, now: at })
    // An address under a reply: its line carries it, and the token pane opens on it.
    if (a === "openToken") return dispatch({ type: "clickOpenToken", mint: cardId, now: at })
    // A chip that puts a command on the input line (the kill report's stop, an owner step's next): its line carries it.
    if (a === "fill") return dispatch({ type: "clickFill", text: cardId, now: at })
    // An Activity line's undo of a Hacc change: its line carries the change's id.
    // The card strip's chip to the tab that shows the agent: its line carries the tab.
    if (a === "tab") return dispatch({ type: "clickTab", tab: Number(cardId), now: at })
    // The agent's change to the screen, under its reply: the chip by its label.
    if (a === "offer") return void tabOffer()?.chips.find((c) => c.label === cardId)?.onClick()
    // The note on startup's chips, by label.
    if (a === "away") {
      if (cardId === "show all") return dispatch({ type: "openAway", now: at })
      if (cardId === "ask") return dispatch({ type: "clickFill", text: AWAY_ASK, now: at })
      return dismissAway()
    }
    if (a === "undo") return void call<{ text: string }>("hacc.undo", { changeId: cardId }, (r) => r.text)
    // A trigger's card that expired with nobody there: its line carries the card, proposed again at a fresh price.
    if (a === "runNow") return void call<{ said: string }>("triggers.runNow", { cardId }, (r) => r.said)
    // The Triggers pane's chip: the overlay, where a trigger is switched off, removed or run again.
    if (a === "triggers") return dispatch({ type: "openTriggers", now: at })
    // A bot's chip in its pane: its line carries what it does and to which bot.
    if (a === "bot") return dispatch({ type: "botAct", ref: cardId, now: at })
    // The Build tab's chips: the pane's own screens, the bots folder's and the test run's. Their line carries what each does.
    if (a === "build") return build.act(cardId)
    // Signals' `clear filters`, under a filter that matches nothing.
    if (a === "signals") return dispatch({ type: "clearSignals", now: at })
    // A span chip on the P&L chart: its line carries the span.
    if (a === "pnlSpan") return dispatch({ type: "pnlSpan", span: cardId as PnlSpan, now: at })
    // The Journal's chips: its search, a kind (the chip carries it), the next page.
    if (a === "journalSearch") return dispatch({ type: "journalSearch", now: at })
    if (a === "journalKind") return dispatch({ type: "journalKind", kind: cardId as JournalKind, now: at })
    if (a === "journalOlder") return dispatch({ type: "journalOlder", now: at })
    // The Wallets pane's ⌕ on its search line: the line takes keys again.
    if (a === "walletsFind") return dispatch({ type: "walletsFind", now: at })
    // The Wallets pane's `close` on a TEE wallet's empty accounts: its line carries the address, and
    // it runs as the typed line would, with the key the wallet is bound to. The core approves it as typed, at once.
    if (a === "closeEmpty") {
      const agent = view.wallets?.boundTo[cardId]
      if (!agent) return
      const argv = ["wallets", "close-empty", "--wallet", cardId]
      return void call<{ said?: string }>("cli.run", { argv, agent }, (r) => r.said ?? `candle ${argv.join(" ")}: sent.`)
    }
    // Which wallets the panes show: the core keeps the choice, so every view and the agent see it.
    if (a === "walletsAll" || a === "walletsActive") {
      return void call("wallets.show", { show: a === "walletsAll" ? "all" : "active" }, () => (a === "walletsAll" ? "Showing every wallet on the account." : "Showing the wallets an agent here can pay from."))
    }
    return dispatch({ type: "clickRequote", cardId, now: at })
  }

  return (
    <box
      width={width}
      height={height}
      backgroundColor={C.page}
      onMouseDown={(e: { button: number }) => {
        used()
        if (e.button === 2 && renderer.hasSelection) void copySelection()
      }}
    >
      <StatusBar
        width={width}
        now={clock}
        connected={view.connected}
        lost={view.lost === true}
        status={status}
        cardsWaiting={cards.length}
        killArmed={ui.killArmedAt !== undefined}
        oneAgent={ui.oneAgent}
        onAgent={() => dispatch({ type: "clickAgent", now: now() })}
        onMode={() => dispatch({ type: "clickMode", now: now() })}
        onKill={() => dispatch({ type: "clickKill", now: now() })}
        onResume={() => dispatch({ type: "clickResume", now: now() })}
        onTriggers={() => dispatch({ type: "openTriggers", now: now() })}
        onBots={() => dispatch({ type: "openBots", now: now() })}
        {...staleCoreProps(session, restartCore)}
      />
      <Tabs
        width={width}
        tabs={held.file.tabs.map((t) => t.name)}
        previewed={held.file.tabs.map((t) => previews[t.name] !== undefined)}
        {...(barOffer(hasAgent) ? { offer: barOffer(hasAgent)! } : {})}
        tab={shown.at}
        focused={ui.focus === "tabs"}
        onTab={(tab) => dispatch({ type: "clickTab", tab, now: now() })}
        onSettings={() => dispatch({ type: "clickSettings", now: now() })}
      />
      {/* Under onboarding's full screen the frame isn't drawn: a pane's border chips would show through it. */}
      {obShown ? null : <TabBody
        {...(paneHasKeys ? { paneHasKeys: true } : {})}
        layout={drawn}
        top={bodyTop}
        width={width}
        height={bodyHeight}
        gap={gap}
        foot={foot}
        {...(hasAgent && tabOffer() ? { offer: { words: tabOffer()!.words, chips: tabOffer()!.chips.map((c) => c.label) } } : {})}
        {...(awayNote() ? { away: awayNote()! } : {})}
        {...(setUpSummary() ? { setUp: setUpSummary()! } : {})}
        view={view}
        ui={ui}
        cards={inlineCards(view, status?.activeAgent ?? "", clock)}
        focusedCardId={focused?.cardId}
        now={clock}
        onFocusPane={(pane) => dispatch({ type: "clickPane", pane, now: now() })}
        onScroll={(pane, delta) => dispatch({ type: "scroll", pane, delta, now: now() })}
        reach={reachRef.current}
        picks={picksRef.current}
        tabName={shown.tab.name}
        onPick={(pane, pick) => dispatch({ type: "clickRow", pane, pick, now: now() })}
        onAskRow={(pane, id) => dispatch({ type: "clickAskRow", pane, id, now: now() })}
        onTogglePin={(pane) => togglePin(shown.tab.name, pane)}
        onToggleOneAgent={() => dispatch({ type: "toggleOneAgent", now: now() })}
        onSignalsChip={(which, x, y) => dispatch({ type: "clickSignalsChip", which, x, y, now: now() })}
        onPauseSignals={(on) => dispatch({ type: "pauseSignals", on, now: now() })}
        onPnlWindowChip={(x, y) => dispatch({ type: "clickPnlWindow", x, y, now: now() })}
        onListsChip={(delta) => dispatch({ type: "listsSource", delta, now: now() })}
        onWalletsFind={() => dispatch({ type: "walletsFind", now: now() })}
        onWalletsGroups={(x, y) => dispatch({ type: "clickWalletsGroups", x, y, now: now() })}
        onEngineChip={() => dispatch({ type: "clickEngineChip", now: now() })}
        edges={edges}
        onAct={act}
        onPopOut={(pane) => dispatch({ type: "popOutPane", pane, now: now() })}
        build={{
          title: buildTitle(build.stage, build.prefs, build.ran, build.agent, build.ask.again),
          ...(build.stage === "running" ? {} : { lines: buildScreenLines({ stage: build.stage, ask: build.ask, ...(build.write ? { write: build.write } : {}), ...(build.prefs ? { prefs: build.prefs } : {}), ...(view.engine ? { engine: view.engine } : {}), ...(build.exited !== undefined ? { exited: build.exited } : {}), ...(view.bots?.gate ? { gate: view.bots.gate } : {}), ...(build.ran ? { ran: build.ran } : {}), width: buildRect ? terminalRect(buildRect).w - 1 : width - 6, focused: ui.focus === "build" }) }),
          onAct: build.act,
          ...(build.stage === "running" || build.stage === "ready" || build.stage === "exited" ? { onHarness: () => (build.stage === "running" ? say(`Exit ${buildTitle("running", build.prefs, build.ran).split(" · ")[1]} first, by its own quit; then harness ▾ picks another.`) : build.act("harness")) } : {}),
        }}
        {...(build.folder ? { buildFolder: build.folder } : {})}
        {...(build.daemons.length ? { daemons: build.daemons } : {})}
        {...(foldWords({ folder: build.folder, topic: view.bots, now: clock }) ? { foldWords: foldWords({ folder: build.folder, topic: view.bots, now: clock })! } : {})}
        onOpenFolded={(pane) => dispatch({ type: "openPane", pane, now: now() })}
      />}
      {/* The Build pane's harness: mounted for as long as it runs, so a tab switch keeps its screen and scrollback; shown over its pane. */}
      {build.proc ? (
        <box position="absolute" zIndex={TERMINAL_Z} left={termAt?.x ?? 0} top={termAt?.y ?? 0} width={termAt?.w ?? 80} height={termAt?.h ?? 24} visible={buildTerm !== undefined && build.stage === "running" && !obShown}>
          <EmbeddedTerminal proc={build.proc} width={termAt?.w ?? 80} height={termAt?.h ?? 24} focused={buildHasKeys()} maxScrollback={5000} selectable colours={{ fg: C.ink, bg: C.term }} onInput={() => { buildTypedAt.current = now() }} onClick={() => dispatch({ type: "clickPane", pane: "build", now: now() })} />
        </box>
      ) : null}
      {tiled === undefined && !obShown ? (
        <box position="absolute" left={2} top={bodyTop + 1} height={1}>
          <text fg={C.dim}>{fitText(`Every pane of ${shown.layout.name} is popped out. Close a popped view (ctrl-c twice there) and its pane comes back here.`, width - 4)}</text>
        </box>
      ) : null}
      {stripHeight > 0 ? (
        <CardStrip rect={{ x: 0, y: bodyTop + bodyHeight, w: width, h: stripHeight }} lines={strip} focused={ui.focus === "cards"} onFocus={() => dispatch({ type: "clickStrip", now: now() })} onAct={act} />
      ) : null}
      {obShown && obView ? (
        <OnboardingScreen
          width={width}
          height={height}
          view={obView}
          {...(view.engine ? { engine: view.engine } : {})}
          local={ob.busy ? { ...ob, sel: -1 } : ob.sel >= obItemsRef.current.length && obItemsRef.current.length > 0 ? { ...ob, sel: obItemsRef.current.length - 1 } : ob}
          paneOpen={prompts.some((x) => !x.hidden)}
          ctx={obCtx}
          paneRunning={prompts.some((x) => !x.hidden && x.exited === undefined)}
          onPick={(i) => {
            if (obRef.current.busy) return
            setOb((o) => ({ ...o, sel: i }))
            const action = obItemsRef.current[i]
            if (action) void obAct(action)
          }}
          onAct={(a) => void obAct(a)}
        />
      ) : null}
      {prompts.map((x) => (
        <CliPrompt
          key={x.ticketId}
          prompt={x}
          rect={obShown ? obPaneRect(width, height) : agentRect}
          {...(obShown ? { running: "ctrl-] back to setup · Ctrl-C stops it" } : {})}
          {...(obShown && setupPaneFailed(x, x.opId ? view.operations[x.opId] : undefined) ? { closes: "  ⏎ closes · setup offers the step again" } : {})}
          focused={!x.hidden}
          {...(paneWords(x.opId ? view.operations[x.opId] : undefined) ? { outcome: paneWords(x.opId ? view.operations[x.opId] : undefined)! } : {})}
          next={paneNext(x.opId ? view.operations[x.opId] : undefined)}
          onInput={(bytes) => watchInput(x.ticketId, bytes)}
          onFocus={() => showPrompt(x.ticketId)}
          onFill={(line) => {
            closePrompt(x.ticketId)
            dispatch({ type: "clickFill", text: line, now: now() })
          }}
        />
      ))}
      {obShown ? null : <PromptChips prompts={prompts} rect={agentRect} onShow={showPrompt} />}
      <MessageLine left={lineAt.x} width={lineAt.w} top={messageTop} ui={messageUi} onAsk={() => dispatch({ type: "clickAsk", now: now() })} onCopy={(text) => dispatch({ type: "clickCopy", text, what: "the command", now: now() })} />
      <InputLine left={lineAt.x} width={lineAt.w} top={inputTop} ui={ui} here={{ ...hereOf(ui, ctxNow, now()), ...(ui.focus === "build" && ui.overlay?.kind === "card" && ui.overlay.waiting ? { build: "card" as const } : ui.focus === "build" && !ui.overlay ? (build.stage === "running" ? { build: "running" as const } : build.stage === "loading" || build.stage === "starting" ? {} : { build: "start" as const }) : {}) }} onHelp={() => dispatch({ type: "clickHelp", now: now() })} onPalette={() => dispatch({ type: "clickPalette", now: now() })} />
      {ui.overlay?.kind === "pane" && ui.overlay.pane !== "agent" && !obShown ? (() => {
        const o = ui.overlay
        const drawnPane = paneLines(o.pane as Exclude<PaneId, "agent">, { view, rect: { x: 0, y: 0, w: Math.min(72, width - 4), h: height - 4 }, now: clock, only: undefined, ...(build.folder ? { buildFolder: build.folder } : {}), ...(build.daemons.length ? { daemons: build.daemons } : {}) })
        return <PaneOverlay title={drawnPane.title} lines={[...(drawnPane.head ?? []), ...drawnPane.lines]} scroll={o.scroll ?? 0} width={width} height={height} onAct={act} onScroll={(delta) => dispatch({ type: "scrollAway", delta, now: now() })} />
      })() : null}
      {ui.overlay?.kind === "card" && ui.overlay.build && !obShown ? (() => {
        const card = cards.find((c) => c.cardId === (ui.overlay as { cardId: string }).cardId)
        if (!card) return null
        const w = Math.min(84, Math.max(36, width - 4)) - 4
        // Taller than the window: its middle folds under its headline, keeping its foot, as in a short pane.
        return <BuildCardOverlay lines={cardLines(card, { now: clock, focused: true, width: w, op: view.operations[card.opId], fitRows: buildCardRows(height), ...(ui.overlay.waiting ? { keysElsewhere: true } : {}) })} width={width} height={height} onAct={act} {...(ui.overlay.waiting ? { waiting: true, onTake: () => dispatch({ type: "takeBuildCard", now: now() }) } : {})} />
      })() : null}
      {ui.overlay?.kind === "tour" && !obShown ? (
        <TourOverlay
          step={ui.overlay.step}
          frame={{ width, height, placed, settingsX: settingsColumn(held.file.tabs.map((t) => t.name), shown.at, width, held.file.tabs.map((t) => previews[t.name] !== undefined)), input: { x: lineAt.x, y: inputTop, w: lineAt.w, h: 1 } }}
          agent={status?.activeAgent ?? "your agent"}
          now={clock}
          onNext={() => dispatch({ type: "tourNext", now: now() })}
          onEnd={() => dispatch({ type: "closeOverlay", now: now() })}
        />
      ) : null}
      <Overlays
        {...(ui.overlay?.kind === "confirmLive" ? { liveGaps: liveGaps(view) } : {})}
        overlay={ui.overlay}
        width={width}
        height={height}
        cards={cards}
        agents={status?.agents.map((a) => a.name) ?? []}
        activeAgent={status?.activeAgent}
        onClose={() => dispatch({ type: "closeOverlay", now: now() })}
        onPickAgent={(agent) => dispatch({ type: "pickAgent", agent, now: now() })}
        onPickSettings={(index) => dispatch({ type: "pickSettings", index, now: now() })}
        settingsAt={settingsColumn(held.file.tabs.map((t) => t.name), shown.at, width, held.file.tabs.map((t) => previews[t.name] !== undefined))}
        tabTicks={allTabs(held.file).map((t) => ({ name: t.tab.name, shown: t.shown }))}
        oneAgent={ui.oneAgent}
        onToggleOneAgent={() => dispatch({ type: "toggleOneAgent", now: now() })}
        killReport={view.killReport}
        {...(ui.overlay?.kind === "palette" ? { paletteRows: paletteFound(ui, ctxNow, ui.overlay.query), paletteTotal: allRowCount(paletteInput(ui, ctxNow)) } : {})}
        onPickPalette={(id) => dispatch({ type: "pickPalette", id, now: now() })}
        onScrollPalette={(delta) => dispatch({ type: "scrollPalette", delta, now: now() })}
        onScrollHelp={(delta) => dispatch({ type: "scrollHelp", delta, now: now() })}
        {...(view.wallets ? { wallets: view.wallets } : {})}
        onPayFrom={(cardId, wallet) => dispatch({ type: "clickPayFrom", cardId, wallet, now: now() })}
        engineRows={(query, agent) => pickerRows(view.engine, lists, query, agent)}
        onPickEngine={(engine, model) => dispatch({ type: "pickEngine", engine, ...(model !== undefined ? { model } : {}), now: now() })}
        onPickPreset={(preset) => dispatch({ type: "pickPreset", preset, now: now() })}
        onPickRunner={(on) => dispatch({ type: "pickRunner", on, now: now() })}
        onScrollEngines={(delta) => dispatch({ type: "scrollEngines", delta, now: now() })}
        {...(view.memory ? { memory: view.memory } : {})}
        onDeleteMemory={(row) => dispatch({ type: "deleteMemory", row, now: now() })}
        onPinMemory={(row) => dispatch({ type: "pinMemory", row, now: now() })}
        onClearMemory={() => dispatch({ type: "clickMemoryClear", now: now() })}
        layoutInfo={layoutInfo()}
        {...(menuFocus(ui) ? { layoutFocus: menuFocus(ui)! } : {})}
        onPickLayoutRow={(index) => dispatch({ type: "pickLayoutRow", index, now: now() })}
        onScrollLayoutMenu={(delta) => dispatch({ type: "scrollLayoutMenu", delta })}
        signals={signalsPick}
        onPickSignalsMenu={(index) => dispatch({ type: "pickSignalsMenu", index, now: now() })}
        {...(view.pnl ? { pnlWindow: view.pnl.window } : {})}
        onPickPnlMenu={(index) => dispatch({ type: "pickPnlMenu", index, now: now() })}
        {...(view.wallets?.groups ? { walletGroups: view.wallets.groups } : {})}
        {...(view.status?.walletsShown !== undefined ? { walletsShown: view.status.walletsShown } : {})}
        onPickWalletsMenu={(index) => dispatch({ type: "pickWalletsMenu", index, now: now() })}
        {...(view.portfolio ? { allWallets: view.portfolio.wallets } : {})}
        {...(view.wallets?.names ? { walletNames: view.wallets.names } : {})}
        onEveryWallet={(which, index) => dispatch({ type: "everyWallet", which, ...(index !== undefined ? { index } : {}), now: now() })}
        onCopyWallet={(address) => dispatch({ type: "clickCopy", text: address, now: now() })}
        onFillLine={(text) => {
          dispatch({ type: "closeOverlay", now: now() })
          dispatch({ type: "clickFill", text, now: now() })
        }}
        {...(view.journalRows ? { journalRows: view.journalRows } : {})}
        onCopyJournalRows={(text) => dispatch({ type: "clickCopy", text, what: "the rows", now: now() })}
        onScrollJournalRows={(delta) => dispatch({ type: "scrollJournalRows", delta, now: now() })}
        {...(view.botLog ? { botLog: view.botLog } : {})}
        onCopyBotLog={(text) => dispatch({ type: "clickCopy", text, what: "the log", now: now() })}
        onScrollBotLog={(delta) => dispatch({ type: "scrollBotLog", delta, now: now() })}
        onBotLogOnly={() => dispatch({ type: "botLogOnly", now: now() })}
        {...(view.autonomy ? { autonomy: view.autonomy } : {})}
        limits={status?.agents ?? []}
        onPickApprovalsWallet={(wallet) => dispatch({ type: "pickApprovals", wallet, now: now() })}
        onPickApprovalsRow={(row) => dispatch({ type: "pickApprovals", row, now: now() })}
        {...(view.triggers ? { triggers: view.triggers } : {})}
        {...(status?.keepAwake ? { keepAwake: status.keepAwake } : {})}
        onPickTriggers={(index) => dispatch({ type: "pickTriggers", index, now: now() })}
        onTriggersAct={(ref, a) => dispatch({ type: "pickTriggers", act: a === "runNow" ? "runNow" : TRIGGERS_ACTS.has(ref) ? (ref as TriggersAct) : "fill", ref, now: now() })}
        {...(view.bots ? { bots: view.bots } : {})}
        {...(ui.botConfirm ? { botConfirm: ui.botConfirm } : {})}
        killed={status?.paused === true}
        onPickBots={(index) => dispatch({ type: "pickBots", index, now: now() })}
        onBotsAct={(ref, a) => (ref === "list" ? dispatch({ type: "pickBots", index: -1, side: "list", now: now() }) : parseBotRef(ref) ? dispatch({ type: "botAct", ref, now: now() }) : a === "fill" ? dispatch({ type: "clickFill", text: ref, now: now() }) : undefined)}
        {...(view.away ? { away: view.away } : {})}
        now={clock}
        {...(inFullOf(ui) ? { shownInFull: inFullOf(ui)! } : {})}
        onAct={act}
        onPickAway={(pick) => dispatch({ type: "pickAway", pick, now: now() })}
        onScrollAway={(delta) => dispatch({ type: "scrollAway", delta, now: now() })}
      />
    </box>
  )
}
