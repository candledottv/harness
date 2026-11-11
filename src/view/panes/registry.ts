// The panes a layout can hold: what each draws, whether it fills what it's given or
// asks for the rows its lines need, and what it can do. Layouts name panes by these ids.
import { closeEmptyOn } from "../../core/cli-table"
import { paceWords, type ReadKind } from "../../core/key-budget"
import { shownWallets } from "../../core/wallets-shown"
import type { PortfolioView } from "../../core/portfolio-view"
import { pinnedView, type TokenView } from "../../core/token-watch"
import type { ActivityEntry } from "../../core/trade-log"
import type { PaneId, Rect } from "../layout"
import { isTokenPane, type TokenPane } from "../../shared/panes"
import { pinPane } from "../../core/view-state"
import type { CoreView } from "../store"
import { C, fit } from "../theme"
import { activityLines } from "./activity"
import { FEED_PANES, feedLines, feedTitle, listOf, NAMES as FEED_NAMES } from "./feed"
import { chip, type Line, line } from "./lines"
import { innerCols, innerRows } from "./pane"
import { wrap } from "../format"
import { positionLines } from "./positions"
import { type PnlSpan, pnlChartLines, pnlLines, pnlPositionLines, PNL_POSITIONS_TITLE, pnlTitle, pnlWindowChipText, tradeLines, tradesTitle } from "./pnl"
import { type SignalsChipId, signalLine, signalsChips, signalsLines, type SignalsPick, signalsTitle } from "./signals"
import { journalHead, journalKey, journalLines, type JournalSearch } from "./journal"
import { checkLines, mentionLines, researchTitle, tokenSignalLines, traderLines } from "./research"
import { tokenLines } from "./token"
import { countWords, runnableCards, triggersPaneLines } from "../triggers-view"
import { type BotConfirm, botDetailLines, botNamed, botsListLines, botsTitle, botTitle, everyBot } from "../bots-view"
import { awayLines, awayTitle } from "./away"
import { type BuildFolder, type DaemonView, folderLines, folderTitle, testLines, testTitle } from "../build-view"
import { emptyWallets, type WalletsFind, grouping, hoodOffers, insideWallets, walletLines, walletsFound, walletsHead, walletsTitle } from "./wallets"
import { chainInForce, chainScoped, chainsInUse } from "../chain-filter"

/**
 * How a pane's lines run: a list from its first, scrolled down (Positions, Feed); a tail with its newest
 * at the foot, scrolled up from it (Activity); or newest first at the head, scrolled down to older
 * (Signals). A scrolled tail or head holds its view as lines arrive.
 */
export type Order = "list" | "tail" | "head"

export interface PaneDef {
  id: PaneId
  /** The agent pane draws its own conversation and cards, the Build pane a terminal; the rest draw framed lines. */
  kind: "agent" | "terminal" | "lines"
  /** Whether it fills what it's given (the agent, the token pane's chart) rather than asking for the rows its lines need. `at` is the tab it's on. */
  fills: (view: CoreView, at?: string) => boolean
  /** Whether it scrolls: every pane does. */
  scrolls: boolean
  order: Order
  /** Whether it follows the link: the token the agent last showed or the person picked, unless pinned. */
  follows: boolean
  /** Whether it can move into a split of its own: every pane but the conversation. */
  pops: boolean
  /** Whether its border carries the "all agents ▾" chip that narrows it to the agent in view. */
  scoped: boolean
  /** Whether, when its lines don't fit, it asks again for its compact form (Wallets: one line a wallet). */
  compact: boolean
  /** The narrowest it draws in: what it gets at the too-small screen's width. */
  minWidth: number
}

const lines = (id: PaneId, over: Partial<PaneDef> = {}): PaneDef => ({ id, kind: "lines", fills: () => false, scrolls: true, order: "list", follows: false, pops: true, scoped: true, compact: false, minWidth: 24, ...over })

const tokenPane = (id: TokenPane): PaneDef => lines(id, { fills: (view, at) => !!tokenShown(view, at, id), follows: true, scoped: false })

export const PANES: Readonly<Record<PaneId, PaneDef>> = {
  agent: { id: "agent", kind: "agent", fills: () => true, scrolls: true, order: "tail", follows: false, pops: false, scoped: false, compact: false, minWidth: 36 },
  // A followed token's chart fills what it's given; before a token, Candle's trending list is lines like any other.
  token: tokenPane("token"),
  "token:2": tokenPane("token:2"),
  "token:3": tokenPane("token:3"),
  positions: lines("positions"),
  wallets: lines("wallets", { compact: true }),
  activity: lines("activity", { order: "tail" }),
  // The Cockpit's: Candle's on-fire list, and Hacc's tape with its own all/mine chip. Trending's
  // other three lists are Feed's kind.
  feed: lines("feed", { scoped: false }),
  signals: lines("signals", { order: "head", scoped: false }),
  // The other tabs' panes.
  // Each list's token and its own figures: New and Graduated 28 cells, Final Stretch 28 (feed.tsx), and the border and scroll column.
  new: lines("new", { scoped: false, minWidth: 32 }),
  graduated: lines("graduated", { scoped: false, minWidth: 32 }),
  "final-stretch": lines("final-stretch", { scoped: false, minWidth: 31 }),
  pnl: lines("pnl", { scoped: false }),
  // The chart fills what it's given, as the token pane's does.
  "pnl-chart": lines("pnl-chart", { fills: () => true, scoped: false }),
  "pnl-positions": lines("pnl-positions", { scoped: false }),
  trades: lines("trades", { scoped: false }),
  journal: lines("journal", { order: "head", scoped: false }),
  check: lines("check", { follows: true, scoped: false }),
  traders: lines("traders", { follows: true, scoped: false }),
  "token-signals": lines("token-signals", { order: "head", follows: true, scoped: false }),
  mentions: lines("mentions", { order: "head", follows: true, scoped: false }),
  perps: lines("perps", { scoped: false }),
  // Research's list to pick from: one of Candle's four lists or Hacc's tape, switched by its chips.
  lists: lines("lists", { scoped: false, minWidth: 32 }),
  // While you were away: the last gap's summary, every section.
  away: lines("away", { scoped: false }),
  // The triggers, two lines each, and a chip to the overlay where one is switched off, removed or run again.
  triggers: lines("triggers", { scoped: false }),
  // Rules bots: the list to pick from, and the picked bot in full with its chips.
  bots: lines("bots", { scoped: false, minWidth: 32 }),
  bot: lines("bot", { scoped: false }),
  // The Build tab: the person's own coding harness in a terminal, which fills what it's given and stays in this view,
  // and beside it the bots folder and the paper test running.
  build: { id: "build", kind: "terminal", fills: () => true, scrolls: false, order: "list", follows: false, pops: false, scoped: false, compact: false, minWidth: 40 },
  "build-folder": lines("build-folder", { scoped: false }),
  "build-test": lines("build-test", { scoped: false }),
}

/** What the list pane shows: one of Candle's lists, or Hacc's tape, in this order round its ◂ ▸ chips. */
export const LIST_SOURCES = ["onfire", "new", "graduated", "finalstretch", "signals"] as const
export type ListSource = (typeof LIST_SOURCES)[number]
export const LIST_SOURCE_NAMES: Record<ListSource, string> = { ...FEED_NAMES, signals: "Signals" }
/** The source `delta` round from `from`, the start where there's none. */
export const nextListSource = (from: ListSource | undefined, delta: number): ListSource => LIST_SOURCES[(((LIST_SOURCES.indexOf(from ?? "onfire") + delta) % LIST_SOURCES.length) + LIST_SOURCES.length) % LIST_SOURCES.length]!

/** The questions the Perps stub's chips put on the input line, answered by the agent's perps reads. */
export const PERPS_ASKS = ["show me Hyperliquid's biggest perps markets", "what are my perps positions?"] as const

/**
 * The Perps tab's stub: that perps come in a later update, and that the agent can read them
 * now. Each chip puts its question on the input line, as ctrl-t does, for Enter to send.
 */
export function perpsLines(width: number): Line[] {
  return [
    ...wrap("Perps on Hyperliquid come to the Candle Harness in a later update.", Math.max(10, width)).map((t) => line(t, C.ink)),
    ...wrap("Until then the agent reads them for you: markets, your positions and your account. Ask it, or pick one:", Math.max(10, width)).map((t) => line(t, C.dim)),
    line(""),
    ...PERPS_ASKS.map((q): Line => ({ segs: [chip(q, "fill")], ref: q })),
  ]
}

/**
 * What a token pane on tab `at` shows (its first, unless `pane` names another): the token it's pinned on,
 * else the link, and how it got there; undefined before any token. A pin whose token the core hasn't read
 * yet shows its name.
 */
export function tokenShown(view: CoreView, at: string | undefined, pane: TokenPane = "token"): { market: TokenView; how: "pinned" | "you" | "agent" } | undefined {
  const pin = at === undefined ? undefined : view.views?.pins.find((p) => p.at === at && pinPane(p) === pane)
  if (pin) {
    const base: TokenView = view.market ?? { followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null, trending: null }
    const market = pinnedView(base, pin.mint) ?? { ...base, followed: { mint: pin.mint, chain: pin.chain, ...(pin.symbol ? { symbol: pin.symbol } : {}), since: 0 }, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null }
    return { market, how: "pinned" }
  }
  const f = view.market?.followed
  return f ? { market: view.market!, how: f.by === "you" ? "you" : "agent" } : undefined
}

const TOKEN_HOW = { pinned: "pinned", you: "you picked", agent: "follows the agent" } as const

/** The tape rows Activity shows before its first line. */
const ACTIVITY_TAPE = 30

/**
 * Whether Activity shows Hacc's tape: before its first line, with Hacc on, where no Signals
 * pane on the tab shows the tape already. The view subscribes to the tape while it does.
 */
export const activityTape = (view: CoreView, panes: readonly PaneId[]): boolean => panes.includes("activity") && !panes.includes("signals") && !!view.hacc?.enabled && view.activity.every((e) => e.hidden)

/** The panes whose rows are tokens to pick: where one is on the tab, the token pane before a token says how to pick, rather than repeat a list. */
const LIST_PANES: readonly PaneId[] = ["feed", "new", "graduated", "final-stretch", "signals", "lists"]

/** One agent's share of the portfolio: the wallets it may spend from, its paper book, its read-only note. */
function portfolioFor(p: PortfolioView | undefined, agent: string): PortfolioView | undefined {
  if (!p) return p
  return {
    ...p,
    wallets: p.wallets.filter((w) => w.agents.includes(agent)),
    readOnly: p.readOnly.filter((r) => r.agent === agent),
    paper: Object.fromEntries(Object.entries(p.paper).filter(([a]) => a === agent)),
  }
}

/** One agent's activity, and the account-wide lines (the kill switch, modes) that concern it too. */
const activityFor = (entries: readonly ActivityEntry[], agent: string) => entries.filter((e) => e.agent === undefined || e.agent === agent)

export interface PaneLinesInput {
  view: CoreView
  rect: Rect
  now: number
  /** The agent the scoped panes are narrowed to, if they are. */
  only: string | undefined
  /** An address shown in full after its ⧉ chip. */
  shownInFull?: string
  /** The rows it has, when known: a pane that adapts to them (Wallets) draws for that many; 0 asks for its compact form. */
  rows?: number
  /** What Signals shows here: your rules or Hacc's tape, and its pattern and chain. */
  signals?: SignalsPick
  /** The tab the pane is on, by name: where a token pane's pin is kept. */
  at?: string
  /** What the P&L chart spans: the window, 7 or 30 days, or every sample. */
  pnlSpan?: PnlSpan
  /** The Journal's search: its words, whether it takes keys, and the kinds on. */
  journal?: JournalSearch
  /** The panes on the same tab: an empty pane doesn't repeat what another shows, and says where to look. */
  panes?: readonly PaneId[]
  /** What the list pane shows. */
  lists?: ListSource
  /** The Wallets pane's open group and its search: this view's own. */
  wallets?: { open?: string; find?: WalletsFind }
  /** The bot the Bots list's highlight rests on, by name; the first where none. */
  bot?: string
  /** A flatten or remove asking once, in the picked bot's pane. */
  botConfirm?: BotConfirm
  /** The bots folder as this view read it, for the Build tab; unset before the Build pane's first open. */
  buildFolder?: BuildFolder
  /** The daemons a harness left behind, each with a stop chip in the bots folder's pane. */
  daemons?: readonly DaemonView[]
}

export interface PaneLines {
  title: string
  lines: Line[]
  /** Lines held above the scrolled ones (the Journal's search and kind chips): they never scroll away. */
  head?: Line[]
}

function body(id: Exclude<PaneId, "agent">, p: PaneLinesInput): PaneLines {
  const { rect, now, only, shownInFull, rows } = p
  // Under the chain filter, every listing pane draws only its rows on the chosen chain (the agent's pane isn't drawn here).
  const whole = chainScoped(p.view)
  const width = innerCols(rect) - 1
  const scoped: CoreView = only ? { ...whole, portfolio: portfolioFor(whole.portfolio, only), activity: activityFor(whole.activity, only) } : whole
  // Which wallets show: the core's choice, applied to both panes.
  const choice = whole.status?.walletsShown ?? "all"
  const all = scoped.portfolio?.wallets ?? []
  const { shown, hidden } = shownWallets(all, choice, whole.wallets?.groups ?? [])
  const activeHides = shownWallets(all, "active").hidden > 0
  // Positions counts only hidden wallets with holdings: an empty one leaves nothing out there.
  const hiddenHolding = all.filter((w) => !shown.includes(w) && (w.tokens === null || w.tokens.length > 0)).length
  const view: CoreView = scoped.portfolio ? { ...scoped, portfolio: { ...scoped.portfolio, wallets: shown } } : scoped
  const mode = view.status?.mode ?? "live"
  // A read the key's request budget slowed says how often it now reads, and why.
  const slowed = (kind: ReadKind) => {
    const words = paceWords(whole.status?.budget?.pace[kind])
    return words ? ` · ${words}` : ""
  }
  switch (id) {
    case "token":
    case "token:2":
    case "token:3": {
      const shown = tokenShown(whole, p.at, id)
      const f = shown?.market.followed
      // A pin on the linked token is read as the linked one.
      const read = shown?.how === "pinned" && f?.mint !== whole.market?.followed?.mint ? "pins" : "linked"
      const listOnTab = !f && (p.panes ?? []).some((id) => LIST_PANES.includes(id))
      const seen = [...whole.knownTokens].map(([symbol, mint]) => ({ symbol, mint }))
      const failed = whole.feeds?.onfire?.failed?.words
      return {
        title: f ? `Token · ${f.symbol ?? "?"}${slowed(read)} · ${TOKEN_HOW[shown.how]}` : listOnTab ? "Token" : `Token · trending${slowed("lists")}`,
        lines: tokenLines(shown?.market ?? view.market, { now, width, height: innerRows(rect), ...(shownInFull ? { shownInFull } : {}), listOnTab, seen, ...(failed ? { trendingFailed: failed } : {}) }),
      }
    }
    case "positions": {
      // Candle's trending list once on a tab is enough: Feed, or the token pane before a token where no list is.
      const panes = p.panes ?? []
      const trendingShown = panes.includes("feed") || (panes.includes("token") && !tokenShown(whole, p.at) && !panes.some((id) => LIST_PANES.includes(id)))
      return { title: `${mode === "paper" ? "Positions · paper" : "Positions"}${slowed("prices")}`, lines: positionLines(view.portfolio, { mode, now, width, market: view.market, hidden: hiddenHolding, trendingShown }) }
    }
    case "wallets": {
      // Groups: the open one and the search are this view's; the groups are the core's.
      const g = { groups: whole.wallets?.groups ?? [], ...(p.wallets?.open !== undefined ? { open: p.wallets.open } : {}), ...(p.wallets?.find ? { find: p.wallets.find } : {}) }
      const grouped = view.portfolio?.readAt != null && grouping(g, choice)
      const count = grouped && g.find ? walletsFound(view.portfolio, g) : undefined
      return {
        title: `${walletsTitle(view.portfolio, now, whole.status?.walletsShown)}${slowed("prices")}`,
        ...(count ? { head: walletsHead(g.find, count.found, count.of, width) } : {}),
        lines: walletLines(view.portfolio, { mode, now, width, ...(shownInFull ? { shownInFull } : {}), ...(rows !== undefined ? { rows } : {}), hidden: { count: hidden, choice, activeHides }, inside: insideWallets(whole.autonomy), empty: emptyWallets(whole.wallets), closeOn: closeEmptyOn(), grouping: g, hood: hoodOffers(whole.wallets) }),
      }
    }
    case "activity": {
      // Before Activity's first line, Hacc's tape where no Signals pane on the tab shows it already.
      const tape = !activityTape(whole, p.panes ?? []) ? [] : (whole.signals?.rows ?? []).slice(-ACTIVITY_TAPE).map((r) => signalLine(r, width, now))
      return { title: tape.length && view.activity.every((e) => e.hidden) ? "Activity · Hacc's tape" : "Activity", lines: activityLines(view.activity, width, now, tape, runnableCards(whole.triggers)) }
    }
    case "feed":
    case "new":
    case "graduated":
    case "final-stretch": {
      // Candle's lists, each the core's last read of it.
      const bucket = FEED_PANES[id]
      const list = listOf(bucket, whole.feeds, whole.market)
      // Final Stretch is pump.fun's: on Solana alone, which it says where the account uses more than one chain.
      if (bucket === "finalstretch" && chainsInUse(p.view.portfolio).length > 1) {
        const elsewhere = chainInForce(p.view)
        const title = `${feedTitle(bucket, list, now).replace(/^Final Stretch/, "Final Stretch · Solana's")}${slowed("lists")}`
        if (elsewhere && elsewhere !== "solana") return { title, lines: wrap(`Final Stretch is pump.fun's, on Solana only: it shows with Solana or all chains picked in the status bar.`, Math.max(10, width)).map((t) => line(t, C.dim)) }
        return { title, lines: feedLines(bucket, list, width, now) }
      }
      return { title: `${feedTitle(bucket, list, now)}${slowed("lists")}`, lines: feedLines(bucket, list, width, now) }
    }
    case "signals": {
      const pick = p.signals ?? {}
      return { title: signalsTitle(pick), lines: signalsLines(pick.mine ? whole.signalsMine : whole.signals, { hacc: whole.hacc, pick, width, now }) }
    }
    // Research's list to pick from: its title names what it shows, its ◂ ▸ chips switch it.
    case "lists": {
      const source = p.lists ?? "onfire"
      if (source === "signals") return { title: "Pick from · Signals", lines: signalsLines(whole.signals, { hacc: whole.hacc, pick: {}, width, now }) }
      const list = listOf(source, whole.feeds, whole.market)
      return { title: `Pick from · ${feedTitle(source, list, now).replace(/^Feed · on fire/, "On Fire")}${slowed("lists")}`, lines: feedLines(source, list, width, now) }
    }
    // P&L: the core's `pnl` topic, and the chart's points the frame asked for.
    case "pnl":
      return { title: `${pnlTitle(whole.pnl, now, whole.status?.mode)}${slowed("pnl")}`, lines: pnlLines(whole.pnl, { width, now, ...(whole.status?.mode ? { mode: whole.status.mode } : {}), ...(whole.wallets?.groups?.length ? { groups: whole.wallets.groups } : {}) }) }
    case "pnl-chart":
      return { title: "P&L over time", lines: pnlChartLines(whole.pnl, whole.pnlSeries, { width, height: rows ?? innerRows(rect), now, span: p.pnlSpan ?? "window" }) }
    case "pnl-positions":
      return { title: PNL_POSITIONS_TITLE, lines: pnlPositionLines(whole.pnl, { width, now }) }
    case "trades":
      return { title: tradesTitle(whole.pnl), lines: tradeLines(whole.pnl, { width, now }) }
    case "perps":
      return { title: "Perps · Hyperliquid", lines: perpsLines(width) }
    // The Journal: the rows the view asked the core for, under its search.
    case "journal": {
      const held = whole.journal?.key === journalKey(p.journal) ? whole.journal : undefined
      const n = held?.entries.length ?? 0
      return { title: `Journal${n ? ` · ${n}${held?.more ? "+" : ""} ${(p.journal?.query.trim() ?? "") ? "found" : "rows"}` : ""}`, head: journalHead(p.journal, width), lines: journalLines(held, p.journal, { width, now }) }
    }
    // Research: the linked token in depth, from the core's `research` topic.
    case "check":
      return { title: researchTitle("check", whole.research), lines: checkLines(whole.research, { width, now, ...(shownInFull ? { shownInFull } : {}) }) }
    case "traders":
      return { title: researchTitle("traders", whole.research), lines: traderLines(whole.research, { width, now, ...(shownInFull ? { shownInFull } : {}) }) }
    case "token-signals":
      return { title: researchTitle("token-signals", whole.research), lines: tokenSignalLines(whole.research, { width, now }) }
    case "mentions":
      return { title: researchTitle("mentions", whole.research), lines: mentionLines(whole.research, { width, now }) }
    // While you were away: the core's `away` topic.
    case "away":
      return { title: awayTitle(whole.away, width), lines: awayLines(whole.away, { width, now, ...(shownInFull ? { shownInFull } : {}) }) }
    // The triggers: the core's `triggers` topic.
    case "triggers":
      return { title: whole.triggers?.triggers.length && !whole.triggers.gate ? `Triggers · ${countWords(whole.triggers)}` : "Triggers", lines: triggersPaneLines(whole.triggers, width, now) }
    // Rules bots: the core's `bots` topic, each with its book.
    case "bots":
      return { title: botsTitle(whole.bots, whole.status?.paused === true), lines: botsListLines(whole.bots, width, whole.status?.paused === true) }
    case "bot": {
      const b = botNamed(whole.bots, p.bot) ?? everyBot(whole.bots)[0]
      return { title: botTitle(b), lines: botDetailLines(b, b ? whole.bots?.books?.[b.name] : undefined, { width, now, killed: whole.status?.paused === true, ...(p.botConfirm ? { confirm: p.botConfirm } : {}), ...(whole.bots ? { topic: whole.bots } : {}) }) }
    }
    // The Build tab's side column: the bots folder, and the paper test running.
    case "build-folder":
      return { title: folderTitle(p.buildFolder), lines: folderLines({ folder: p.buildFolder, topic: whole.bots, daemons: p.daemons ?? [], width, now }) }
    case "build-test":
      return { title: testTitle(whole.bots), lines: testLines({ topic: whole.bots, width, now }) }
    // The Build pane is a terminal, drawn by the tab itself; on its own (popped, or the palette's overlay) it says so.
    case "build":
      return { title: "Build", lines: [line("Your coding harness runs in the Build tab.", C.dim)] }
  }
}

export const scopeText = (only: string | undefined) => (only ? `${only} only ▾` : "all agents ▾")

/** A chip on a pane's top border: what it says, and for Signals, which of its chips it is. */
export interface BorderChip {
  text: string
  signals?: SignalsChipId
}

/** The chips on a pane's top border, left to right: Signals' pattern, chain and source, else `borderChip`'s one. */
export function borderChips(id: PaneId, p: Pick<PaneLinesInput, "only" | "signals" | "view" | "at"> & { width?: number }): BorderChip[] {
  if (id === "signals") return signalsChips(p.signals ?? {}, p.width).map((c) => ({ text: c.text, signals: c.id }))
  if (id === "lists") return [{ text: "◂" }, { text: "▸" }]
  const one = borderChip(id, p)
  return one === undefined ? [] : [{ text: one }]
}

/** The chip on a pane's top border, if it has one: whose positions, wallets or activity; which signals; or the token pane's pin. */
export function borderChip(id: PaneId, p: Pick<PaneLinesInput, "only" | "signals" | "view" | "at"> & { width?: number }): string | undefined {
  if (id === "signals") return signalsChips(p.signals ?? {}, p.width).map((c) => c.text).join("    ")
  if (isTokenPane(id)) {
    const shown = tokenShown(p.view, p.at, id)
    return shown ? (shown.how === "pinned" ? "unpin" : "pin") : undefined
  }
  // The P&L window: its chip opens the menu that picks it.
  if (id === "pnl") return pnlWindowChipText(p.view.pnl)
  return PANES[id].scoped ? scopeText(p.only) : undefined
}

/**
 * A lines pane's title and lines, the title made to end before the scope chip (at 80×24 the chip
 * would cover "read 13s ago"). What doesn't fit after the pane's name moves inside, as its first line.
 */
export function paneLines(id: Exclude<PaneId, "agent">, p: PaneLinesInput): PaneLines {
  const drawn = body(id, p)
  // Every chip on the border, as ChipsLabel lays them out (Research's list has two, ◂ and ▸).
  const chips = borderChips(id, { ...p, width: p.rect.w })
  if (chips.length === 0) return drawn
  const cells = chips.reduce((n, c) => n + c.text.length + 2, 0) + (chips.length - 1) * 2
  const room = Math.max(4, p.rect.w - cells - 8)
  const [name, ...more] = drawn.title.split(" · ")
  if (drawn.title.length <= room || more.length === 0) return drawn
  // The token pane drops how it got there rather than give its chart a row: its chip says pin or unpin.
  if (isTokenPane(id)) return { ...drawn, title: fit(drawn.title.length <= room ? drawn.title : [name, more[0]].join(" · "), room) }
  // The moved line takes one of the pane's rows.
  const kept = p.rows === undefined ? drawn.lines : body(id, { ...p, rows: p.rows - 1 }).lines
  return { ...drawn, title: fit(name!, room), lines: [line(more.join(" · "), C.dim), ...kept] }
}
