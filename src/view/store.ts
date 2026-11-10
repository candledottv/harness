// What a view knows about the core, built only from the events it subscribes to (docs.candle.tv/harness/developers/attach-protocol):
// `status`, `cards`, `operations`, `agent`, `activity`, `portfolio`, `market`, `wallets`, `autonomy`, `away`, `engine` and `views`. A pure reducer, so the frame and its tests
// see the same thing. The view's own clock stamps when each card first appeared, for the 300 ms rule: a card
// can't be approved by an Enter pressed as it arrives.
import type { SkillsTopic } from "../core/skill-folders"
import type { OnboardingView } from "../setup/onboarding"
import type { KeyUse, Pace, ReadKind } from "../core/key-budget"
import type { WalletsShown } from "../core/wallets-shown"
import type { WalletsTopic } from "../core/agent-wallets"
import type { TriggersTopic } from "../core/triggers"
import type { BotsTopic } from "../core/bots"
import type { AutonomyTopic } from "../core/autonomy"
import type { AwayView } from "../core/away"
import type { LimitLine } from "../core/limits"
import type { CoreEventParams } from "../core/client"
import type { KillReport } from "../core/kill"
import type { PortfolioView } from "../core/portfolio-view"
import type { FeedsView } from "../core/feeds"
import type { ResearchView } from "../core/research-reads"
import type { PnlView, PnlWindow } from "../core/pnl"
import type { PnlSeries } from "./panes/pnl"
import type { BotLogHeld } from "./bots-view"
import type { JournalHeld, JournalRowsHeld } from "./panes/journal"
import type { TokenView } from "../core/token-watch"
import type { ViewsTopic } from "../core/view-state"
import type { ActivityEntry } from "../core/trade-log"
import type { EngineTopic } from "./panes/engines"
import type { MemoryTopic } from "./panes/memory"
import { type HaccTopic, heldSignals, type SignalsHeld } from "./panes/signals"

export interface AgentStatusView {
  name: string
  candle: string
  embeddedWallet?: "allowed" | "denied"
  wallet?: string
  spentTodayUsd?: number
  limits?: { perTradeUsd: number; perDayUsd: number }
  /** Every limit on the agent, each naming who holds it. */
  limitLines?: LimitLine[]
}

/** The P&L window's figure as the status topic sends it (core/pnl.ts). */
export interface PnlFigure {
  /** The window as the core keeps it: "24h", "midnight", "session" or a time of day. */
  window?: PnlWindow
  /** null ("—") before any sample in the window, never 0. */
  usd: number | null
  /** The window's name: "24h", "since midnight", "since 18:00", "since last session". */
  label: string
  /** Where the figure runs from. */
  from: number | null
  /** The Candle Harness's samples start later than the window, so the figure runs from `from`. */
  short: boolean
  /** Positions Candle can't price now, where that changed over the window: the figure is partly that. */
  unpriced?: number
}

export interface StatusView {
  agents: AgentStatusView[]
  activeAgent: string
  /** No agent yet: the core is in setup, so nothing reads Candle or trades. */
  setup?: boolean
  mode: "paper" | "live"
  paused: boolean
  typedTrades?: "card" | "instant"
  exposureUsd?: number | null
  /** The P&L window's figure: Candle's, from the Candle Harness's samples, naming its window; null before a core sends one. */
  pnl?: PnlFigure | null
  pricesAgeMs?: number | null
  headless?: boolean
  /** The triggers that keep the core running: the status bar's "3 triggers on", and what quitting says. */
  triggersOn?: number
  /** The bots that keep the core running: each that enters, or whose exits still sell. */
  botsOn?: number
  /** Of them, how many trade live: a bot's mode is its own, apart from the Candle Harness's. */
  botsLive?: number
  /** Keep-awake (macOS): the setting, whether this machine has it, and whether it's keeping the Mac awake now. */
  keepAwake?: { on: boolean; available: boolean; active: boolean; failed?: string }
  /** When the core started, for whether config.toml changed under it. */
  startedAt?: number
  /** config.toml's modified time after the core's own last write or read of it: in use already. */
  configSeenMtime?: number
  /** The debug switch that drops the next trade's or swap's answer is still armed. */
  debugLoseNextReply?: boolean
  /** Which wallets the panes show (wallets-shown.ts); a core from before it means "all". */
  walletsShown?: WalletsShown
  /** Each key's Candle limit and use, and the background reads slowed to fit; a core from before it sends none. */
  budget?: { keys: KeyUse[]; pace: Partial<Record<ReadKind, Pace>> }
}

export interface CardDisplayView {
  title: string
  /** The trigger whose firing proposed it, by name. */
  trigger?: string
  /** What that firing saw, in words: said in place of why. */
  fired?: string
  /** The trigger whose wake started the agent's turn that proposed it. */
  woken?: string
  /** The rules bot whose entry or exit it is, by name. */
  bot?: string
  /** A trigger's card: the exact line it saves, the trigger in words, how it runs, and whose it is when not the proposer's. */
  triggerCard?: { line: string; words: string; runs: string; kind?: "own" | "asks" | "notifies" | "wakes" | "unknown"; agent?: string; replaces?: true }
  /** A rules bot's card: the bot in words, its definition, how its trades run, its worst case and its backtest; or what a flatten sells. */
  botCard?: {
    name: string
    words: string
    definition: string
    mode: "paper" | "live"
    runs: { kind: "paper" | "own" | "asks" | "unknown"; entries: string; exits: string; amber?: string }
    worst: string
    /** The card's labelled lines, short: how its buys and sells run, its worst case, its backtest. */
    parts?: { buys: string; sells: string; worst: string; tested: string }
    backtest?: string
    differs?: string
    from?: string
    replaces?: true
    /** A change to a saved bot: what it changes. */
    changes?: string
    live?: true
    flatten?: string
    /** A code bot's card: its folder, command and figures, and what the core holds it to; `definition` is what it binds. */
    code?: { folder: string; command: string; figures: string; holds: string }
  }
  /** The compact card's parts; a core older than 2b sends only `title`. */
  headline?: string
  gets?: { amount: number; asset: string }
  sells?: { amount: number; asset: string }
  spend?: { amount: number; asset: string }
  valueUsd?: number
  nearLimit?: string
  slippage?: string
  slippageLooser?: boolean
  walletLabel?: string
  /** A TEE wallet that pays: "pays from tee-one (TEE · 7xKX…AsU)". */
  paysFrom?: string
  agent: string
  wallet: string
  sharedWith?: string[]
  mint?: string
  mintLabel?: string
  spends?: string
  price?: string
  receives?: string
  sizedFromUsd?: string
  pricedAt?: string
  pricedBy?: string
  risks?: string
  /** A line to read before the press, such as a TEE wallet a revoke would strand. */
  warning?: string
  /** A card that runs in the prompt pane: what the user will be asked there, and that the agent can't see it. */
  paneSteps?: string[]
  paneNote?: string
  /** An owner card's own words. */
  paneNotes?: string[]
  /** A ceremony's line: what it shows or takes. */
  paneShows?: string
  /** Funds out to a new address, in groups of four: amber, and only a click approves it. */
  newAddress?: string
  /** Why it can't run here yet, and the chip that types the fix; it offers no approve. */
  blocked?: { why: string; fill: { label: string; line: string } }
  /** Chips under the warning that put a command on the input line. */
  fills?: { label: string; line: string }[]
  /** What the dry run or a read said when proposed: a launch's curve, a stake's pool wait, a post's text. */
  preview?: string
  /** A public action says so: a launch, a post, a profile edit. */
  publicNote?: string
  /** On a wallet that trades inside limits, why this one is a card all the same: "over the embedded wallet's $1.00 a trade without a card". */
  cardBecause?: string
  /** What re-send does for this card when an answer is lost. */
  resendNote?: string
  estimate?: string
  limits?: string
  candleKeyLimit?: string
  why?: string
  mode: "paper" | "live"
  /** Said in place of the mode where it doesn't apply: a Hacc change is real in paper mode too. */
  modeNote?: string
  expiresAt: string
  supported?: boolean
  /** The same name was read here for another token: amber, with both short addresses. */
  otherMint?: string
  /** A launch's links by host, its image's host and the start of its description. */
  publishes?: string
  /** A launch's creator fee, staker share, mode, visibility or rules, set to other than Candle's defaults: amber. */
  launchTerms?: string
  /** The card's mode isn't the Candle Harness's (a live bot's trade while it's on paper): amber. */
  modeDiffers?: string
  /** Once expired it's asked for again, never re-quoted. */
  askAgain?: boolean
}

export interface ViewCard {
  cardId: string
  opId: string
  cardHash: string
  kind: string
  tool: string
  agent: string
  state: string
  expiresAt: string
  side?: "buy" | "sell" | "swap"
  params?: Record<string, unknown>
  display: CardDisplayView
  /** `paper`: a live sell Candle answered by closing the key's paper position, the wallet holding none. */
  operation?: { state: string; paper?: boolean; partial?: { leg1: string } }
  /** How it was approved: enter, click, instant, or view when an older view didn't say. */
  approvedHow?: string
  /** Ran without a card: what it was checked against, "without a card, inside the embedded wallet's limits ($1.00 of $1.50 a trade, …)". */
  withoutCard?: string
  /** "cli" or "pane" (a card that runs in the prompt pane). */
  route?: string
  /** The card that replaced it: a wallet re-quote, or the kill switch's fresh price for a sell. */
  replacedBy?: string
  /** Who proposed it, by role: `build` for a code bot the Build pane's harness proposed. */
  origin?: { role?: string }
}

export interface ViewOperation {
  opId: string
  cardId: string
  agent: string
  state: string
  kind?: string
  tool?: string
  params?: Record<string, unknown>
  startedAt?: number
  /** When it reached an end; an older core doesn't send it. */
  settledAt?: number
  error?: { code: string; message: string }
  /** "pane": run in the prompt pane, never re-sent, its outcome in `result.pane`. */
  route?: string
  result?: unknown
  reason?: string
  /** A re-send of it is in flight: no second one is offered. */
  resending?: boolean
  /** A live sell Candle answered by closing the key's paper position: nothing live was sold. */
  paper?: boolean
  /** A swap whose first leg landed, with its hash, and whose second failed. */
  partial?: { leg1: string }
}

/** A pane step's outcome in words, once it has one. */
export function paneWords(op: ViewOperation | undefined): string | undefined {
  const words = (op?.result as { pane?: { words?: unknown } } | undefined)?.pane?.words
  return typeof words === "string" ? words : undefined
}

/** A pane step's next steps: chips that put a command on the input line. */
export function paneNext(op: ViewOperation | undefined): { label: string; line: string }[] {
  const next = (op?.result as { pane?: { next?: unknown } } | undefined)?.pane?.next
  return Array.isArray(next) ? next.filter((n): n is { label: string; line: string } => typeof n?.label === "string" && typeof n?.line === "string") : []
}

/** Operations Candle hasn't answered for, oldest first: the user can re-send or abandon each. */
export function unanswered(view: Pick<CoreView, "operations">): ViewOperation[] {
  // A pane step is never re-sent: its card says what to check, so it offers no re-send.
  return Object.values(view.operations)
    .filter((op) => op.state === "unknown" && op.route !== "pane")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}

export interface Exchange {
  turnId: string
  user: string
  reply: string
  /** True while the reply streams; the `ended` event replaces it with the gated text. */
  streaming: boolean
  outcome?: string
  tools: string[]
  queued?: boolean
  /** Each address in the final reply, and the most trusted source that showed it. */
  labelled?: { address: string; source: string }[]
  /** The figures in the final reply no tool showed (the figure gate): where each starts, and as written. */
  marked?: { at: number; text: string }[]
  /** When this view first saw it, for which closed cards still belong under the conversation. */
  seenAt?: number
  /** When it ended, for one from before the core started: the pane draws a divider under the last. */
  earlier?: string
  /** The triggers that woke it, for a turn no person sent: the pane marks it as theirs. */
  woken?: string[]
  /** The person sent it from a script or another terminal (`candle-harness ask`): the pane says so. */
  outside?: boolean
}

export interface CoreView {
  connected: boolean
  /** The core this view was attached to went away; the session tries to attach again until one answers. */
  lost?: true
  status?: StatusView
  cards: ViewCard[]
  /** When this view first saw each card, by its own clock. */
  seenAt: Record<string, number>
  /** Cards that arrived while another was already waiting: Enter takes longer to reach each. */
  behind?: Record<string, true>
  operations: Record<string, ViewOperation>
  conversations: Record<string, Exchange[]>
  killReport: KillReport | null
  /** The activity pane's lines, oldest first. */
  activity: ActivityEntry[]
  portfolio?: PortfolioView
  market?: TokenView
  /** Each wallet's autonomy: the approvals menu and the Wallets pane. */
  autonomy?: AutonomyTopic
  /** The triggers, on the `triggers` topic: the Triggers overlay and pane. */
  triggers?: TriggersTopic
  /** Rules bots and each one's book, on the `bots` topic: the Bots tab, its panes and overlay. */
  bots?: BotsTopic
  /** While you were away: the last gap's summary, for the note on startup and the Away pane. */
  away?: AwayView
  /** What each agent can pay from: `from <wallet>` and the wallet chips in a card's details. */
  wallets?: WalletsTopic
  /** Token names seen this session (upper-cased) to their mints: the only names a typed trade resolves. */
  knownTokens: Map<string, string>
  /** Each agent's engine and model, and each engine's check: the chip and the picker. */
  engine?: EngineTopic
  /** Each agent's memory: the chip's count and the memory overlay. */
  memory?: MemoryTopic
  /** The person's skill folders. */
  skills?: SkillsTopic
  /** Hacc: on or off, whether it takes each agent's key, the stream's state, for the Signals pane's words. */
  hacc?: HaccTopic
  /** Candle's lists while a layout on screen shows them: each the last one read, kept when the tab goes. */
  feeds?: FeedsView
  /** Hacc's tape and the account's own rules' signals, while a layout on screen shows Signals. */
  signals?: SignalsHeld
  signalsMine?: SignalsHeld
  /** P&L: each agent's book, the window's figure, fills, swaps and paper, while a P&L pane is on screen. */
  pnl?: PnlView
  /** The chart's points, as the view last asked the core for them (`pnl.series`): the frame keeps them, not an event. */
  pnlSeries?: PnlSeries
  /** The Journal's rows for its search, as the view asked `journal.query` for them, pages appended. */
  journal?: JournalHeld
  /** A Journal row's rows as recorded (ctrl-o), from `journal.rows`. */
  journalRows?: JournalRowsHeld
  /** A code bot's log, as the view last read it for its overlay (`bots.logs`). */
  botLog?: BotLogHeld
  /** The linked token, who moved it, and the pins: the same in every view. */
  views?: ViewsTopic
  /** Research's reads of the linked token, while a Research pane is on screen: the core sends the whole view each time. */
  research?: ResearchView
  /** Onboarding's steps, each read back from where it lives: while there's no agent, or `candle-harness setup`. */
  onboarding?: OnboardingView
}

export const EMPTY_VIEW: CoreView = { connected: false, cards: [], seenAt: {}, operations: {}, conversations: {}, killReport: null, activity: [], knownTokens: new Map() }

const MAX_ACTIVITY = 200

function learnToken(known: Map<string, string>, symbol: string | undefined, mint: string | undefined): Map<string, string> {
  if (!symbol || !mint || known.get(symbol.toUpperCase()) === mint) return known
  return new Map(known).set(symbol.toUpperCase(), mint)
}

/** `together`: one of a snapshot's cards, which all show at once, so none slid in under another. */
function withCard(view: CoreView, card: ViewCard, now: number, together = false): CoreView {
  const cards = view.cards.some((c) => c.cardId === card.cardId) ? view.cards.map((c) => (c.cardId === card.cardId ? card : c)) : [...view.cards, card]
  return {
    ...view,
    cards,
    seenAt: card.cardId in view.seenAt ? view.seenAt : { ...view.seenAt, [card.cardId]: now },
    // New, with another card already waiting: the person may be reading that one.
    ...(!together && !(card.cardId in view.seenAt) && card.state === "awaiting_approval" && view.cards.some((c) => c.cardId !== card.cardId && c.state === "awaiting_approval")
      ? { behind: { ...view.behind, [card.cardId]: true as const } }
      : {}),
    knownTokens: learnToken(view.knownTokens, card.display?.mintLabel, card.display?.mint),
  }
}

function updateExchange(view: CoreView, agent: string, turnId: string, change: (e: Exchange) => Exchange, create?: Exchange): CoreView {
  const list = view.conversations[agent] ?? []
  const found = list.some((e) => e.turnId === turnId)
  const next = found ? list.map((e) => (e.turnId === turnId ? change(e) : e)) : create ? [...list, change(create)] : list
  return { ...view, conversations: { ...view.conversations, [agent]: next } }
}

function applyAgent(view: CoreView, data: Record<string, unknown>, now: number): CoreView {
  const agent = String(data.agent ?? "")
  const turnId = String(data.turnId ?? "")
  const woken = Array.isArray(data.woken) ? data.woken.map(String) : undefined
  const blank: Exchange = { turnId, user: String(data.user ?? ""), reply: "", streaming: false, tools: [], seenAt: now, ...(woken ? { woken } : {}), ...(data.outside === true ? { outside: true } : {}) }
  // A woken turn waiting may grow, as more wakes join it: its words and triggers come again.
  const grown = (e: Exchange): Exchange => (woken ? { ...e, user: String(data.user ?? e.user), woken } : e)
  switch (data.type) {
    case "queued":
      return updateExchange(view, agent, turnId, (e) => ({ ...grown(e), queued: true }), blank)
    case "started":
      return updateExchange(view, agent, turnId, (e) => ({ ...grown(e), queued: false, streaming: true }), blank)
    case "text":
      return updateExchange(view, agent, turnId, (e) => ({ ...e, reply: e.reply + String(data.delta ?? "") }))
    case "tool_result":
      return updateExchange(view, agent, turnId, (e) => ({ ...e, tools: [...e.tools, String(data.summary ?? data.name ?? "")] }))
    case "reask":
      // What streamed is void: the engine is answering again.
      return updateExchange(view, agent, turnId, (e) => ({ ...e, reply: "" }))
    case "ended":
      return updateExchange(
        view,
        agent,
        turnId,
        (e) => ({ ...e, streaming: false, queued: false, reply: String(data.reply ?? ""), outcome: String(data.outcome ?? ""), labelled: Array.isArray(data.labelled) ? (data.labelled as Exchange["labelled"]) : [], marked: Array.isArray(data.marked) ? (data.marked as Exchange["marked"]) : [] }),
        blank,
      )
    default:
      return view
  }
}

/** The core went away: what's on screen is as it last stood, and says so until a core answers again. */
export const lostCore = (view: CoreView): CoreView => ({ ...view, connected: false, lost: true })

/** Folds one core event into the view. */
export function applyEvent(view: CoreView, event: CoreEventParams, now: number): CoreView {
  const data = event.data as Record<string, unknown> | null
  switch (event.topic) {
    case "status": {
      const status = data as unknown as StatusView
      const { lost: _back, ...was } = view
      return { ...was, connected: true, status, killReport: status.paused ? view.killReport : null }
    }
    case "cards": {
      if (event.snapshot) {
        let next: CoreView = { ...view, cards: [] }
        for (const card of (data as unknown as ViewCard[]) ?? []) next = withCard(next, card, view.seenAt[card.cardId] ?? now, true)
        return next
      }
      return withCard(view, data as unknown as ViewCard, now)
    }
    case "operations": {
      const ops = event.snapshot ? ((data as unknown as ViewOperation[]) ?? []) : [data as unknown as ViewOperation]
      const operations = event.snapshot ? {} : { ...view.operations }
      for (const op of ops) operations[op.opId] = op
      return { ...view, operations }
    }
    case "agent": {
      if (event.snapshot) {
        const agents = ((data as { agents?: Record<string, { exchanges?: { turnId: string; user: string; reply: string; tools?: string[]; outcome?: string; marked?: Exchange["marked"]; earlier?: string; woken?: string[]; outside?: boolean }[] }> } | null)?.agents ?? {})
        const conversations: Record<string, Exchange[]> = {}
        for (const [agent, a] of Object.entries(agents)) {
          conversations[agent] = (a.exchanges ?? []).map((e) => ({ turnId: e.turnId, user: e.user, reply: e.reply, streaming: false, outcome: e.outcome, tools: e.tools ?? [], ...(e.marked ? { marked: e.marked } : {}), ...(typeof e.earlier === "string" ? { earlier: e.earlier } : {}), ...(Array.isArray(e.woken) && e.woken.length ? { woken: e.woken } : {}), ...(e.outside === true ? { outside: true } : {}) }))
        }
        return { ...view, conversations }
      }
      return data ? applyAgent(view, data, now) : view
    }
    case "activity": {
      if (event.snapshot) {
        const snap = data as { killReport?: KillReport | null; lines?: ActivityEntry[] } | null
        return { ...view, killReport: snap?.killReport ?? null, activity: snap?.lines ?? [] }
      }
      if (data?.kind === "kill.report") return { ...view, killReport: data.report as KillReport }
      // Leftover processes arrive as a journal line too; the engine's own event is for other clients.
      if (data?.kind !== "line") return view
      // A trigger's firing comes again as its card and trade go: it's put in its place, not added twice.
      const entry = data.entry as ActivityEntry
      const at = entry.firing ? view.activity.findIndex((e) => e.seq === entry.seq) : -1
      if (at >= 0) return { ...view, activity: view.activity.map((e, i) => (i === at ? entry : e)) }
      return { ...view, activity: [...view.activity, entry].slice(-MAX_ACTIVITY) }
    }
    case "portfolio": {
      const portfolio = data as unknown as PortfolioView
      let known = view.knownTokens
      for (const w of portfolio?.wallets ?? []) for (const t of w.tokens ?? []) known = learnToken(known, t.symbol, t.mint)
      for (const book of Object.values(portfolio?.paper ?? {})) for (const p of book) known = learnToken(known, p.symbol, p.mint)
      return { ...view, portfolio, knownTokens: known }
    }
    case "market": {
      const market = data as unknown as TokenView
      let known = view.knownTokens
      if (market?.followed) known = learnToken(known, market.followed.symbol, market.followed.mint)
      for (const row of market?.trending?.rows ?? []) known = learnToken(known, row.symbol, row.mint)
      for (const p of market?.pinned ?? []) known = learnToken(known, p.symbol, p.mint)
      return { ...view, market, knownTokens: known }
    }
    case "views":
      return { ...view, views: data as unknown as ViewsTopic }
    case "wallets":
      return { ...view, wallets: data as unknown as WalletsTopic }
    case "autonomy":
      return data ? { ...view, autonomy: data as unknown as AutonomyTopic } : view
    case "triggers":
      return data ? { ...view, triggers: data as unknown as TriggersTopic } : view
    case "bots":
      return data ? { ...view, bots: data as unknown as BotsTopic } : view
    case "away":
      return data ? { ...view, away: data as unknown as AwayView } : view
    case "onboarding":
      return data ? { ...view, onboarding: data as unknown as OnboardingView } : view
    case "engine":
      return { ...view, engine: data as unknown as EngineTopic }
    case "memory":
      return { ...view, memory: data as unknown as MemoryTopic }
    case "skills":
      return { ...view, skills: data as unknown as SkillsTopic }
    case "hacc":
      return { ...view, hacc: data as unknown as HaccTopic }
    case "feeds":
      // Each event carries the lists this view subscribed to; one let go keeps its last list, with its age.
      // Their names aren't learned for typed trades, as On Fire's are: New is full of minutes-old copies of
      // known tickers. A picked row is followed, which makes its name known.
      return { ...view, feeds: { ...view.feeds, ...((data ?? {}) as FeedsView) } }
    case "signals":
      return { ...view, signals: heldSignals(view.signals, data, !!event.snapshot) }
    case "signals:mine":
      return { ...view, signalsMine: heldSignals(view.signalsMine, data, !!event.snapshot) }
    case "pnl":
      return data ? { ...view, pnl: data as unknown as PnlView } : view
    case "research":
      return data ? { ...view, research: data as unknown as ResearchView } : view
    default:
      return view
  }
}

/** Cards waiting for a press, oldest first. */
export function openCards(view: CoreView): ViewCard[] {
  return view.cards.filter((c) => c.state === "awaiting_approval")
}
