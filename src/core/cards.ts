// One-press cards: trades and swaps from the account's embedded wallet and from TEE wallets, the agent
// narrowing a key's wallets, unknown tools (which can only be rejected), and launches, staking, claims,
// profile edits and posts through Candle's own tools, each dry-run or read when proposed. No vault,
// no factor, no windows: approving is one key press, with no network call.
//
// A card is valued when it's proposed, and that value is what's checked at approve: the user
// approves what the card showed. It's bound by a SHA-256 hash over canonical JSON of what runs and
// on whose behalf; the display isn't hashed. It lives 60 s (trades and swaps) whether or not a view
// is attached; approving it late proposes a fresh one at the current price, and the late one never
// runs.
import { tokenLabel } from "../shared/token-label"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { CORE_HOWS } from "../shared/approved-how"
import { canonicalJson } from "../shared/canonical-json"
import { invalidParams, refused } from "../shared/rpc"
import { terminalText } from "../shared/terminal-text"
import { type AgentStatus, FALLBACK_FEE_BPS } from "./agent-status"
import type { PayerResult } from "./agent-wallets"
import { ASK, type WalletSetting } from "./autonomy"
import { amountText, BASE_ASSETS, type BaseAsset, fromRaw, isBaseAsset, notATradeToken, priceText, settlementAsset, toRaw } from "./assets"
import type { ToolOutcome } from "./candle-mcp"
import { type CardKind, type IdKey, type Mode, pausedMessage, pausedStops, unknownArgument } from "./classify"
import type { CliResult } from "./candle-cli"
import { type CliCardRequest, type CliRowParams, planCliRow, type UploadStage } from "./cli-cards"
import { type CliTradeParams, teeSwapArgs } from "./cli-trade"
import type { EmptyState } from "./empty-accounts"
import { PANE_NOTE, type PaneParams, type PaneRequest, paneHeadline, paneSteps, paneTitleLine, planPane } from "./pane-plan"
import type { Journal, JournalRow } from "./journal"
import { capText, type DaySpend, heldMessage, type KeyHolds, type Limits, overAssetCap, overWords, type Side, usd } from "./limits"
import type { MarketInfo, Resolved } from "./markets"
import type { Pricing, Quote } from "./pricing"
import { type SpendAsset, sizeInUsd } from "./sizing"
import { type CardDesk, type CardState, type CardView, type FaceClient, type OperationState, type Source, sourceOf, type BotOrigin, modeFor, botFields, type TriggerOrigin, triggerFields, TURN_ENDED_WORDS } from "./tool-face"
import type { TriggerSpec } from "./triggers-tool"
import type { BotSpec } from "./bots-tool"
import { short, walletName } from "./wallet-names"

export const OPEN_CARD_CAP = 5
/** The core's own client holds every trigger's cards: more at once than one view or harness, still bounded. */
export const TRIGGER_OPEN_CARD_CAP = 20
/** A card's origin fields on its rows: the trigger's firing, or the bot's trade. */
const ORIGIN_FIELDS = new Set(["trigger", "fireId", "part", "bot", "botAct", "botPosition", "botSignal", "botReason", "botOutside", "botKind", "botRequest", "botPartial", "botSellsRaw"])
const MAX_REASON = 500
const MAX_PARAMS_BYTES = 64 * 1024

/** A bot's card words, each cut to what a card can hold and cleaned for the terminal. */
function botSpecShown(spec: BotSpec): BotSpec {
  const t = (v: string, n: number) => terminalText(v, { maxLength: n })
  return {
    ...spec,
    name: t(spec.name, 40),
    words: t(spec.words, 1000),
    definition: t(spec.definition, 16 * 1024),
    runs: { kind: spec.runs.kind, entries: t(spec.runs.entries, 600), exits: t(spec.runs.exits, 300), ...(spec.runs.amber ? { amber: t(spec.runs.amber, 300) } : {}), ...(spec.runs.buys ? { buys: t(spec.runs.buys, 200) } : {}), ...(spec.runs.sells ? { sells: t(spec.runs.sells, 200) } : {}) },
    worst: t(spec.worst, 300),
    ...(spec.backtest ? { backtest: t(spec.backtest, 600) } : {}),
    ...(spec.differs ? { differs: t(spec.differs, 600) } : {}),
    ...(spec.from ? { from: t(spec.from, 300) } : {}),
    ...(spec.changes ? { changes: t(spec.changes, 400) } : {}),
    ...(spec.flatten ? { flatten: t(spec.flatten, 1000) } : {}),
    ...(spec.parts ? { parts: { buys: t(spec.parts.buys, 200), sells: t(spec.parts.sells, 200), worst: t(spec.parts.worst, 200), tested: t(spec.parts.tested, 200) } } : {}),
    ...(spec.code ? { code: { folder: t(spec.code.folder, 1024), command: t(spec.code.command, 1024), figures: t(spec.code.figures, 200), holds: t(spec.code.holds, 200) } } : {}),
  }
}

export function cardLifetimeMs(kind: CardKind): number {
  return kind === "trade" || kind === "swap" ? 60_000 : 10 * 60_000
}

/** A figure on the compact card: an amount of an asset or token, which the view rounds. */
export interface Fig {
  amount: number
  asset: string
}

/** A Hacc change has no paper form: Hacc's follows, rules and strategies are the account's own, in either mode. */
export const HACC_IN_PAPER = "real on Hacc, even in paper mode"

export interface CardDisplay {
  title: string
  /** The compact card's first words: what was asked, in the unit it was asked in. */
  headline?: string
  /** Roughly what comes back: tokens for a buy, the settlement asset for a sell or swap. */
  gets?: Fig
  /** What a percent sell is estimated to sell, read now. */
  sells?: Fig
  /** What a buy spends, when it was sized in dollars. */
  spend?: Fig
  /** The card's value in dollars, when the core could value it. */
  valueUsd?: number
  /**
   * What Candle's dry run or a read said when the card was proposed, in words: a launch's curve and
   * ceilings, a stake's pool wait, a claim's payout, a post's text.
   */
  preview?: string
  /** A public action says so before the press: a launch, a post, a profile edit. */
  publicNote?: string
  /** The limits line, set only when the trade is near a limit, or the core couldn't price it. */
  nearLimit?: string
  /**
   * A slippage bound the agent set that isn't its route's default, in words ("slippage 50%, the default is
   * 1%"): it's in the hash, and a card or a receipt never runs with one unseen.
   */
  slippage?: string
  /** The bound is looser than the default: drawn amber. */
  slippageLooser?: boolean
  /** The bound itself, in basis points, where it's shown. */
  slippageBps?: number
  /** What kind of wallet pays, for the compact card: "embedded", or a TEE wallet's label. */
  walletLabel?: string
  /** The trigger whose firing proposed it, by name: the card and its receipt say "by trigger". */
  trigger?: string
  /** What that firing saw, in words: the card and its receipt say it in place of why. */
  fired?: string
  /** The rules bot whose entry or exit it is, by name: the card and its receipt say "by the bot". */
  bot?: string
  /** The trigger whose wake started the agent's turn that proposed it: the card and its receipt say "woke on". */
  woken?: string
  /** A TEE wallet that pays: "pays from tee-one (TEE · 7xKX…AsU)". */
  paysFrom?: string
  /** What "re-send" does for this card, when an answer is lost: the CLI route's, a launch's, a post's. */
  resendNote?: string
  agent: string
  wallet: string
  /** Other agents allowed on the same wallet: a sell sells the wallet's holding, whoever bought it. */
  sharedWith: string[]
  mint?: string
  mintLabel?: string
  /** What a buy spends, and why that asset. */
  spends?: string
  /** The token's USD price (from Candle's market read when proposed, or worked out from Candle's quote). */
  price?: string
  /** Roughly what comes back: tokens for a buy, the settlement asset for a sell or swap, before fees and slippage. */
  receives?: string
  /** A buy sized in dollars: the figure asked for and the price it was converted at. */
  sizedFromUsd?: string
  /** When the card's figures were priced, and by what (Candle's market read, or Candle's quote). */
  pricedAt?: string
  pricedBy?: string
  /** Token risks Candle's quote listed (Token-2022 hazards), when it was priced by a quote. */
  risks?: string
  /** What the user should read before the press, such as a TEE wallet a revoke would strand. */
  warning?: string
  /** Chips under the warning that put a command on the input line: "rebind to …". */
  fills?: { label: string; line: string }[]
  /** A card that runs in the prompt pane: what the user will be asked there, in order. */
  paneSteps?: string[]
  /** That it runs in a pane the agent can't see. */
  paneNote?: string
  /** What an owner card says besides its steps: who a new key makes, what a rebind moves, what a preset drops. */
  paneNotes?: string[]
  /** Why it can't run on this machine yet, and the chip that types the fix (no vault: `vault init`). It offers no approve. */
  blocked?: { why: string; fill: { label: string; line: string } }
  /** A ceremony's line: what it shows or takes ("Shows your 24 words."), read before the press. */
  paneShows?: string
  /**
   * Funds out to a new address: not one of the user's own wallets or vault keys, in
   * full in groups of four. Drawn amber; Enter doesn't approve it, only a click on "yes, a new address".
   */
  newAddress?: string
  estimate: string
  limits: string
  candleKeyLimit?: string
  why?: string
  mode: Mode
  /** Said in place of the mode where the mode doesn't apply: a Hacc change in paper mode is still real. */
  modeNote?: string
  expiresAt: string
  /** False for a tool the Candle Harness can't run yet: the card offers only reject. */
  supported: boolean
  /** A trade on a wallet that trades inside limits that is a card all the same, and why: "over the embedded wallet's $1.00 a trade without a card". */
  cardBecause?: string
  /** A trigger's card: the exact line it saves, the trigger in words, and whether it runs on its own or asks each time. */
  triggerCard?: TriggerSpec
  /** A bot's card: the bot in words, its definition (or a code bot's settings) exactly, how its trades run, its worst case and its backtest. */
  botCard?: BotSpec
  /**
   * The same name is held in a wallet, or was on an earlier card, for another token: said in amber, with that
   * token's short address, so a copy of a ticker isn't taken for the one the person knows.
   */
  otherMint?: string
  /** A launch's own words and links, by host: what the press publishes besides the name. */
  publishes?: string
  /** A launch's creator fee, staker share, mode, visibility or launch rules set to something other than the default: amber. */
  launchTerms?: string
  /** The card's mode isn't the Candle Harness's (a live bot's buy while it's on paper): said in amber. */
  modeDiffers?: string
  /** Once expired it's asked for again, never re-quoted: what it was made from may have changed since. */
  askAgain?: boolean
}

/**
 * How a card was approved: a view's Enter or click, or the core itself for a typed trade
 * under `cards.typedTrades = "instant"`, or for a line the user typed that runs in the prompt pane
 * ("typed", so every pane goes through the one ticket path). A view that doesn't say is "view".
 */
/**
 * `inside-limits`: the core ran it without a card, inside its wallet's figures. `bot-exit`: the core ran a rules bot's
 * sell without a card, on any wallet, since the person approved its exits with the bot. Only the core says either.
 */
export type ApprovedHow = "enter" | "click" | "instant" | "typed" | "view" | "inside-limits" | "bot-exit"
const VIEW_HOW: readonly string[] = ["enter", "click"]

export interface Card extends CardView {
  params: Record<string, unknown>
  approvedHow?: ApprovedHow
  cardHash: string
  /** Who proposed it: a view's person, an agent's harness, or the core for a trigger, with the trigger's firing. */
  origin: { clientId: string; role: FaceClient["role"]; source: Source; trigger?: TriggerOrigin; bot?: BotOrigin; woken?: { trigger: string; fireId: string } }
  reason?: string
  wallet: string
  account: string
  mode: Mode
  side?: Side
  value: { usd?: number; unvalued: boolean }
  /** An unpriced buy or swap: what it spends, valued once it fills so the day counts it. */
  valueLater?: { asset: BaseAsset; amount: string; feeBps: number; done?: boolean }
  display: CardDisplay
  createdAt: string
  /**
   * "cli": the card runs the user's own `candle`: a TEE wallet's trade or swap through `candle
   * swap`, or one of the CLI's card rows. Its params are then the exact argv.
   */
  route?: "cli" | "pane"
  /** A CLI card row's path, such as "stake add": the kill switch goes by it. */
  row?: string
  /** A CLI card row's request, for a re-quote. */
  cliRequest?: CliCardRequest
  /** A pane card's request, for a fresh card after expiry. */
  paneRequest?: PaneRequest
  /** The card that replaced this one (a wallet re-quote, or the kill switch's fresh price for a sell). */
  replacedBy?: string
  /** It ran without a card: the words the agent and the views are given. */
  withoutCard?: string
  /** A trade on a wallet that trades inside limits that is a card all the same, and why. */
  cardBecause?: string
  /** The asset a trade settles in, as the card worked it out: a fill whose answer names none is read in it. */
  settles?: BaseAsset
}

/**
 * Whether a trade runs at once with no card, and the words for it.
 * It does when its wallet trades inside limits and it's a live buy, sell or swap that's valued (a sell
 * needn't be), at or under the wallet's figure for a trade and, with this one, for today. A sell always
 * fits: sells were never limited. The agent's own limits, the pause and a held key are checked as for any
 * card, at proposal and again at approve, and over them it's refused. Anything else stays a card, and
 * `words` says why where the wallet trades inside limits.
 */
export type WithoutCard =
  | { run: true; words: string; figures?: { perTradeUsd: number; perDayUsd: number; usedUsd: number } }
  | { run: false; words?: string }

/**
 * Whether a looser slippage bound on a rules bot's trade is the one the person approved with the bot: its trades at
 * that bound or tighter run as any trade inside the figures, and each receipt names it. Only the core's own client
 * carries a bot, and its bound comes from the bot's approved version.
 */
export function botBound(card: { origin?: Pick<Card["origin"], "role" | "bot">; display?: Pick<CardDisplay, "slippageBps"> }): number | undefined {
  const bound = card.origin?.role === "core" ? card.origin.bot?.slippageBps : undefined
  const bps = card.display?.slippageBps
  return bound !== undefined && bps !== undefined && bps <= bound ? bps : undefined
}

/** ", at the bot's approved slippage of 5%", on a receipt that ran at a bot's own looser bound. */
const boundWords = (card: Parameters<typeof botBound>[0] & { display?: Pick<CardDisplay, "slippageLooser"> }): string => {
  const bps = card.display?.slippageLooser ? botBound(card) : undefined
  return bps !== undefined ? `, at the bot's approved slippage of ${percentText(bps)}` : ""
}

export function withoutCard(input: {
  card: Pick<Card, "kind" | "mode" | "side" | "row" | "route" | "value"> & { walletName: string; origin?: Pick<Card["origin"], "role" | "bot">; display?: Pick<CardDisplay, "slippage" | "slippageLooser" | "slippageBps"> }
  setting: WalletSetting
  /** Spent today without a card from this wallet, by every agent, before this trade; undefined when it can't be counted. */
  usedUsd: number | undefined
  /** The same trade from the same agent is still in flight, however it was approved: a retry waits for the person. */
  inFlight: boolean
}): WithoutCard {
  const { card, setting } = input
  if (setting.setting !== "inside" || card.mode !== "live") return { run: false }
  if ((card.kind !== "trade" && card.kind !== "swap") || !card.side || card.row !== undefined || card.route === "pane") return { run: false }
  const whose = card.walletName === "embedded" ? "the embedded wallet's" : `${card.walletName}'s`
  if (input.inFlight) return { run: false, words: "the same trade is still in flight, so this one waits for you" }
  // A bound looser than the route's default, sells included: a confused or misled agent could dump into a thin pool.
  if (card.display?.slippageLooser && botBound(card) === undefined) return { run: false, words: `${card.display.slippage}, looser than that, so this one waits for you` }
  if (card.side === "sell") return { run: true, words: `without a card: ${card.walletName === "embedded" ? "the embedded wallet" : card.walletName} trades inside limits, and sells aren't limited${boundWords(card)}` }
  if (input.usedUsd === undefined) return { run: false, words: `the core can't count ${whose} day without a card` }
  const value = card.value.usd
  if (value === undefined) return { run: false, words: `no price, so ${whose} figures can't be checked` }
  const fee = card.side === "buy" ? " with Candle's fee" : ""
  if (value > setting.perTradeUsd) return { run: false, words: `over ${whose} ${usd(setting.perTradeUsd)} a trade without a card: this one is ${overWords([value], setting.perTradeUsd).total}${fee}` }
  if (input.usedUsd + value > setting.perDayUsd) {
    const w = overWords([input.usedUsd, value], setting.perDayUsd)
    return { run: false, words: `over ${whose} ${usd(setting.perDayUsd)} a day without a card: ${w.parts[0]} used today, and this ${w.parts[1]}${fee} would make ${w.total}` }
  }
  return {
    run: true,
    words: `without a card, inside ${whose} limits (${usd(value)} of ${usd(setting.perTradeUsd)} a trade, ${usd(input.usedUsd + value)} of ${usd(setting.perDayUsd)} today)${boundWords(card)}`,
    figures: { perTradeUsd: setting.perTradeUsd, perDayUsd: setting.perDayUsd, usedUsd: input.usedUsd },
  }
}

export type Holding = { amountRaw: bigint; decimals: number } | "none" | "unreadable"

export interface CardBookDeps {
  journal: Journal
  account: string
  now: () => number
  mode: () => Mode
  /** Every configured agent, for who shares a wallet. */
  agents: () => string[]
  keyPrefix: (agent: string) => string | undefined
  status: { get(agent: string): AgentStatus | undefined }
  markets: { resolve(agent: string, mint: string): Promise<Resolved> }
  /** Prices read fresh when a card is proposed, or Candle's quote once its MCP server has the tool. */
  pricing: Pick<Pricing, "asset" | "token" | "quote">
  /** What a buy sized in dollars spends on Solana, for tokens Candle didn't launch (config `trade.spendAsset`). */
  spendAsset: () => SpendAsset
  /** A fresh read of what `wallet` holds of `mint`, through the agent's own portfolio read. */
  holding: (agent: string, wallet: string, mint: string) => Promise<Holding>
  limits: Limits
  spend: DaySpend
  /** What each wallet has spent today without a card (`byWalletWithoutCard`). */
  walletSpend?: DaySpend
  /** Keys Candle refused with KEY_LIMIT_REACHED: their buys and swaps wait until it lifts. */
  holds?: KeyHolds
  /**
   * The amber line on a person's or an agent's sell of a token whose last two sells on this key failed: their sell
   * isn't held, but a third failure stops the key on Candle, sells included.
   */
  sellWarning?(agent: string, mint: string): string | undefined
  /** The other mints this token's name is held or was carded under here, newest first: a card says so. */
  otherMints?(symbol: string, mint: string): string[]
  /** Each wallet's autonomy: a trade on one that trades inside limits may run with no card. */
  autonomy?: { get(wallet: string): WalletSetting }
  /** The kill switch: buys and swaps are refused while it's on. */
  paused: () => boolean
  /** An unpriced buy or swap was valued after it filled: the agent's spend today changed. */
  onValued?: (card: Card) => void
  /** Operations sent and not yet settled, those a restart rebuilt included: a retry of one waits for the person. */
  operations?: () => readonly { opId: string; agent: string; tool: string; params: Record<string, unknown>; state: string }[]
  /** Which wallet pays (AgentWallets.payer). Without it, every card pays from the embedded wallet. */
  wallets?: { payer(agent: string, word?: string, opts?: { chain?: "solana" | "hood" }): PayerResult }
  /**
   * The final words of a CLI card's run: `--json` (unless `json: false`, as for a pane step on the
   * user's terminal), and the configured `--rpc-url` where it takes one (CandleCli.finalArgs).
   */
  cliArgs?: (args: string[], opts?: { rpcUrl?: boolean; json?: boolean }) => string[]
  /** What the CLI's card rows need when they're planned. */
  cliRows?: {
    researchDir: (agent: string) => string
    stage: UploadStage
    /** A dry run through the CLI with the agent's key, when a card is made. */
    dryRun: (agent: string, argv: string[]) => Promise<CliResult>
    /** A TEE wallet's empty token accounts as last counted: a close card's words. */
    emptyOf?: (address: string) => EmptyState | undefined
  }
  /** Sends an approved card: journals `operation.submitting` first, then calls Candle. */
  execute: (card: Card) => Promise<{ state: OperationState; result?: unknown; error?: unknown }>
  /**
   * Opens the prompt pane for an approved pane card: mints its ticket and starts its
   * pending operation. Nothing runs in the core.
   */
  /** Refuses an approved card the kill switch now stops, recording it, or undefined (Operations.refusePaused). */
  refusePaused?: (card: Card) => Promise<{ state: OperationState; error?: unknown } | undefined>
  openPane?: (card: Card, viewClientId: string) => Promise<{ ticket: string; ticketId: string; title: string; operation: { state: OperationState } }>
  /**
   * A dry run or a read on the agent's own MCP child, made while a card is proposed and never on
   * approve: launches, staking and fee claims dry-run first, as Candle's tools ask.
   */
  candle?: (agent: string, tool: string, args: Record<string, unknown>) => Promise<ToolOutcome>
  /** The engine turn a harness token was minted for, and the time since its message. */
  /** `correcting`: the turn is on its second run, asked only to correct its reply. */
  turnOf?: (tokenId: string) => { turnId: string; msSinceStart: number; woken?: { trigger: string; fireId: string }; correcting?: true } | undefined
  /** Whether the turn a harness token was minted for was stopped or is over: what it still asks for makes no card. */
  turnEnded?: (tokenId: string) => boolean
  onChange?: (card: Card) => void
  /** A closed card left the book: whatever was kept by its id can go too. */
  onDropped?: (card: Card) => void
}

export type ApproveResult =
  | { kind: "submitted"; card: Card; operation: { state: OperationState; result?: unknown; error?: unknown } }
  | { kind: "reproposed"; expired: Card; fresh: Card }
  /** A pane card: the ticket goes to the approving view only, which starts the pane with it. */
  | { kind: "pane"; card: Card; ticket: string; ticketId: string; title: string; operation: { state: OperationState } }

/** SHA-256 over canonical JSON of what runs and on whose behalf, lowercase hex. */
export function hashCard(input: {
  kind: CardKind
  tool: string
  params: Record<string, unknown>
  opId: string
  account: string
  agent: string
  wallet: string
  mode: Mode
  /** Set only on the CLI and pane routes, so an MCP card's hash stays as it always was. */
  route?: "cli" | "pane"
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")
}

const isOpen = (card: Card) => card.state === "awaiting_approval"
const decimalAmount = (value: unknown): string | undefined => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value
  return typeof text === "string" && /^\d+(\.\d+)?$/.test(text) && Number(text) > 0 ? text : undefined
}
/** Thousands grouped in the whole part, the fraction left as it is. */
const grouped = (amount: string): string => {
  const [whole, frac] = amount.split(".")
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`
}

interface Planned {
  params: Record<string, unknown>
  side?: Side
  /** What a buy or swap spends, in a base asset: an unpriced one is valued once it fills, so it counts toward the day. */
  spent?: { asset: BaseAsset; amount: string }
  wallet: string
  /** A TEE wallet pays: the card runs `cli` through `candle swap`. */
  tee?: { address: string; label?: string }
  cli?: string[]
  /**
   * Whether `cli` takes candle.rpcUrl, a Solana endpoint: a Hood TEE wallet's trade reads Hood's chain, and given a
   * Solana URL as `--rpc-url` its reads fail (swap.ts hoodSwap), so it runs on the CLI's own Hood endpoint.
   */
  cliRpcUrl?: boolean
  /** One of the CLI's card rows: what runs. */
  cliRow?: { row: string; argv: string[]; rpcUrl: boolean; file?: CliRowParams["file"] }
  /** A row that runs in the prompt pane: what the launcher runs, and what the user will be asked. */
  pane?: { params: PaneParams; steps: string[] }
  usd: number | undefined
  /** The plan's fee in `usd`, on a buy: a limit counts it, and a refusal says so. */
  feeBps?: number
  title: string
  headline: string
  gets?: Fig
  sells?: Fig
  spend?: Fig
  valueUsd?: number
  mint?: string
  mintLabel?: string
  spends?: string
  price?: string
  receives?: string
  sizedFromUsd?: string
  pricedAt?: number
  pricedBy?: string
  /** A buy's quoted expected out, raw: a bot's book caps a read-back buy's own at it plus the slippage bound. */
  quoteOutRaw?: string
  risks?: string
  preview?: string
  publicNote?: string
  resendNote?: string
  /** The token's own name, as Candle's market read gives it, for the other tokens read by it. */
  symbol?: string
  settles?: BaseAsset
  publishes?: string
  launchTerms?: string
}

/** How many closed cards the book keeps: every open one stays, and a card being approved or still in flight. */
export const CLOSED_CARDS_KEPT = 200
/** The cards a snapshot or a list carries: under one attach message's megabyte, with room for its envelope. */
export const CARDS_LIST_BYTES = 768 * 1024

/** The kinds a planner rebuilds from what was asked: any other card is made from its proposer's own words. */
const REPLAYED_KINDS: ReadonlySet<CardKind> = new Set(["trade", "swap", "launch", "stake", "claim", "public"])

/**
 * An expired card that isn't a trade or one of Candle's own tools is never made again from what was asked: its
 * words, its warning and what it runs came from its proposer (a trigger's line, a bot's settings, a wallet's
 * figures), and any of them may have changed since.
 */
const ASK_AGAIN_WORDS = "This card expired, and what it was made from may have changed since: ask for it again. Nothing ran."

/** A bot's buy that waited past its card: skipped, as the bot's card said it would be. */
const botSkippedWords = (name: string) => `The bot "${name}"'s buy waited past its card and was skipped: it buys again on its next signal. Nothing was sent.`

export class CardBook implements CardDesk {
  private readonly cards = new Map<string, Card>()
  private readonly byOpId = new Map<string, Card>()
  /** The agent's turn each card was proposed in, while the card is kept. */
  private readonly turnOfCard = new WeakMap<Card, string>()
  /** Cards being approved: a second press is refused, and a racing twin sees them in flight. */
  private readonly approving = new Set<string>()
  private sweep: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: CardBookDeps) {}

  /** Expires cards on a one-second sweep. */
  start(): void {
    this.sweep = setInterval(() => void this.expireDue(), 1000)
    this.sweep.unref?.()
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep)
  }

  held(opId: string): Card | undefined {
    return this.byOpId.get(opId)
  }

  get(cardId: string): Card | undefined {
    return this.cards.get(cardId)
  }

  list(): Card[] {
    return [...this.cards.values()]
  }

  /**
   * The cards a view or a harness is sent, in the order they were made: every open one, then the newest closed
   * ones while they fit `maxBytes`, so one message never outgrows what the attach interface carries.
   */
  listWithin(maxBytes = CARDS_LIST_BYTES, keep: (card: Card) => boolean = () => true): Card[] {
    const all = [...this.cards.values()].filter(keep)
    const size = (card: Card) => Buffer.byteLength(JSON.stringify(card), "utf8") + 1
    const chosen = new Set<Card>()
    let used = 0
    for (const card of all) {
      if (!this.live(card)) continue
      chosen.add(card)
      used += size(card)
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const card = all[i]!
      if (chosen.has(card)) continue
      const bytes = size(card)
      if (used + bytes > maxBytes) break
      chosen.add(card)
      used += bytes
    }
    return all.filter((card) => chosen.has(card))
  }

  /** Open, being approved, or approved with its operation not yet at an end: never dropped. */
  private live(card: Card): boolean {
    if (isOpen(card) || this.approving.has(card.cardId)) return true
    if (card.state !== "approved") return false
    const state = card.operation?.state
    return state === undefined || UNSETTLED.has(state)
  }

  /**
   * Drops the oldest closed cards past `CLOSED_CARDS_KEPT`: a core that runs for weeks would otherwise hold
   * every card it ever made, and send them all to each view that attaches. `onDropped` hears each one.
   */
  private prune(): void {
    const closed = [...this.cards.values()].filter((card) => !this.live(card))
    for (const card of closed.slice(0, Math.max(0, closed.length - CLOSED_CARDS_KEPT))) {
      this.cards.delete(card.cardId)
      if (this.byOpId.get(card.opId) === card) this.byOpId.delete(card.opId)
      this.deps.onDropped?.(card)
    }
  }

  /** Records what happened to a card's operation (its execution and reconciliation). */
  noteOperation(opId: string, operation: NonNullable<CardView["operation"]>): void {
    const card = this.byOpId.get(opId)
    if (!card) return
    card.operation = operation
    this.deps.onChange?.(card)
    if (operation.state === "succeeded" && card.valueLater && !card.valueLater.done) void this.valueFilled(card).catch(() => {})
  }

  /**
   * An unpriced buy or swap that filled, valued now at what it spent, so the agent's day counts it: an agent
   * could otherwise spend without limit by trading while no price can be read. Its card said it couldn't be
   * checked. Still no price (USDG), and it isn't counted: the card said so, and nothing is made up.
   */
  private async valueFilled(card: Card): Promise<void> {
    const later = card.valueLater!
    later.done = true
    const point = await this.deps.pricing.asset(card.agent, later.asset)
    if (point === undefined) return
    const value = Number(later.amount) * point.usd * (1 + later.feeBps / 10_000)
    if (!Number.isFinite(value) || value <= 0) return
    const now = this.deps.now()
    this.deps.spend.record(card.opId, card.agent, value, now)
    await this.deps.journal.append({ type: "card.valued", mode: card.mode, agent: card.agent, cardId: card.cardId, opId: card.opId, wallet: card.wallet, ...(card.side ? { side: card.side } : {}), usd: value, asset: later.asset })
    this.deps.onValued?.(card)
  }

  /** `replaces`: the open card a wallet re-quote withdraws once this one exists, which doesn't count toward the cap. */
  async propose(input: Parameters<CardDesk["propose"]>[0] & { replaces?: string }): Promise<Card> {
    const { client, agent, tool, kind, idKey } = input
    if (Buffer.byteLength(JSON.stringify(input.params), "utf8") > MAX_PARAMS_BYTES) throw invalidParams("params is over 64 KiB.")
    const asked = structuredClone(input.args)
    const given = structuredClone(input.params)
    // A rules bot's trade goes in the bot's own mode; every other card in the Candle Harness's.
    const mode = modeFor(client, this.deps.mode())

    // The same request from the same proposer while its card is open is that card, unless this one replaces it.
    // An agent's harness clients are one proposer: its MCP connection can reattach mid-turn (where a second,
    // identical call once made a second funds-out card).
    const askedKey = canonicalJson({ tool, agent, asked: withoutId(asked, idKey) })
    // A Build pane's commands each connect afresh, so the Build clients of one agent are one proposer too.
    const sameBuild = (card: Card) => card.origin.role === "build" && client.role === "build" && card.agent === agent
    const sameProposer = (card: Card) => card.origin.clientId === client.clientId || (card.origin.role === "harness" && client.role === "harness") || sameBuild(card)
    for (const card of this.cards.values()) {
      if (isOpen(card) && card.cardId !== input.replaces && sameProposer(card) && canonicalJson({ tool: card.tool, agent: card.agent, asked: withoutId(card.asked, idKey) }) === askedKey) {
        return card
      }
    }
    // A turn's second run, made only to correct its reply, starts with no memory of the first: the same request
    // again is the first run's card, however that card ended, never a second trade or a second card.
    const turn = client.role === "harness" && client.tokenId ? this.deps.turnOf?.(client.tokenId) : undefined
    if (turn?.correcting) {
      for (const card of this.cards.values()) {
        if (this.turnOfCard.get(card) === turn.turnId && canonicalJson({ tool: card.tool, agent: card.agent, asked: withoutId(card.asked, idKey) }) === askedKey) return card
      }
    }
    const openByClient = [...this.cards.values()].filter((c) => isOpen(c) && (c.origin.clientId === client.clientId || sameBuild(c)) && c.cardId !== input.replaces).length
    const cap = client.role === "core" ? TRIGGER_OPEN_CARD_CAP : OPEN_CARD_CAP
    if (openByClient >= cap) {
      const words = client.bot ? `A bot may hold ${cap} open cards at once, and ${cap} of "${client.bot.name}"'s wait for you now.` : client.role === "core" ? `Triggers may hold ${cap} open cards at once, and ${cap} wait for you now.` : `A client may hold ${cap} open cards at once.`
      await this.refuse(client, agent, tool, "TOO_MANY_OPEN_CARDS", words)
    }

    // Paused refuses whatever spends or publishes at once, before anything is read from Candle.
    const row = input.cli?.row ?? input.pane?.row.path
    const words = input.pane?.words
    if (pausedStops({ kind, tool, ...(given.side === "buy" ? { side: "buy" as const } : {}), ...(row ? { row } : {}), ...(words ? { words } : {}) }) && this.deps.paused()) {
      await this.refuse(client, agent, tool, "PAUSED", pausedMessage({ kind }))
    }
    if (input.cli && mode === "paper") await this.refuse(client, agent, tool, "NO_PAPER_FORM", "This is paper mode, and this has no paper form: switch to live to do it.")
    // A key Candle has refused for its cap: its buys and swaps wait; one Candle stopped: every trade waits.
    // Before anything is read.
    if (!input.cli && !input.pane && (kind === "swap" || kind === "trade")) await this.refuseIfHeld(client, agent, tool, kind === "swap" ? "swap" : given.side === "sell" ? "sell" : "buy")

    // An argument the tool's list doesn't name is refused by name: the card shows what it knows how to show.
    const stray = input.cli || input.pane ? undefined : unknownArgument(tool, given)
    if (stray !== undefined) await this.refuse(client, agent, tool, "UNKNOWN_ARGUMENT", `${tool} doesn't take \`${terminalText(stray, { maxLength: 40 })}\` here. Nothing was sent.`)

    // The core mints every id: ids are unique per account, across keys, so the proposer's is ignored.
    const opId = randomUUID()
    const status = this.deps.status.get(agent)
    let planned: Planned
    // A CLI card row first: a TEE wallet's stake or launch keeps its kind, but runs through the CLI.
    if (input.cli) planned = await this.planCli(client, agent, input.cli, opId)
    else if (input.pane) planned = this.planPane(input.pane)
    else if (kind === "trade") planned = await this.planTrade(client, agent, given, status, opId)
    else if (kind === "swap") planned = await this.planSwap(client, agent, given, status, opId)
    else if (kind === "launch") planned = await this.planLaunch(client, agent, tool, given, status, opId)
    else if (kind === "stake") planned = await this.planStake(client, agent, tool, given, status, opId)
    else if (kind === "claim") planned = await this.planClaim(client, agent, tool, given, status)
    else if (kind === "public") planned = await this.planPublic(client, agent, tool, given)
    else if (tool === "candle_set_profile_wallets" && input.title === undefined) planned = await this.planKeyWallets(client, agent, given)
    else {
      const title = input.title !== undefined ? terminalText(input.title, { maxLength: 200 }) : kind === "lessaccess" ? `LESS ACCESS · ${terminalText(tool)}` : `${terminalText(tool)} (not supported yet)`
      planned = { params: withoutId(given, idKey), wallet: "none", usd: undefined, title, headline: title }
    }

    if (pausedStops({ kind, tool, ...(planned.side ? { side: planned.side } : {}), ...(row ? { row } : {}), ...(words ? { words } : {}) }) && this.deps.paused()) await this.refuse(client, agent, tool, "PAUSED", pausedMessage({ kind }))
    if (planned.side) await this.refuseIfHeld(client, agent, tool, planned.side)
    const now = this.deps.now()
    const limit = planned.side ? this.deps.limits.check({ usd: planned.usd, side: planned.side, agent, now, ...(planned.feeBps ? { feeBps: planned.feeBps } : {}) }) : undefined
    if (limit && !limit.ok) await this.refuse(client, agent, tool, limit.code, limit.message, { line: limit.line })
    // The turn that asked was stopped while this was being priced: no card is made, so there's none to press or to
    // run without a press. Nothing is awaited from here until the card is in the book.
    if (client.role === "harness" && client.tokenId !== undefined && this.deps.turnEnded?.(client.tokenId)) await this.refuse(client, agent, tool, "TURN_ENDED", TURN_ENDED_WORDS)

    // A CLI card runs exactly its argv, with the agent's key; the argv carries the id already. A pane
    // card runs exactly its steps, in the launcher.
    const route = planned.pane ? ("pane" as const) : planned.tee || planned.cliRow ? ("cli" as const) : undefined
    const params: Record<string, unknown> = planned.pane
      ? (planned.pane.params as unknown as Record<string, unknown>)
      : planned.cliRow
      ? ({
          argv: this.cliArgs(planned.cliRow.argv, { rpcUrl: planned.cliRow.rpcUrl }),
          identity: "agent",
          agent,
          json: true,
          row: planned.cliRow.row,
          ...(planned.cliRow.file ? { file: planned.cliRow.file } : {}),
        } satisfies CliRowParams)
      : planned.tee
        ? ({ argv: this.cliArgs(planned.cli!, { rpcUrl: planned.cliRpcUrl !== false }), identity: "agent", agent, json: true } satisfies CliTradeParams)
        : idKey === "coreOpId"
          ? planned.params
          : { ...planned.params, [idKey]: opId }
    const teeName = planned.tee ? walletName(undefined, { ...planned.tee, kind: "tee" }) : undefined
    const expiresAt = new Date(now + cardLifetimeMs(kind)).toISOString()
    const reason = input.reason !== undefined ? terminalText(input.reason, { maxLength: MAX_REASON }) : undefined
    const keyLimit = status?.keyLimit
    // The agent's turn that proposed it, read above, and the trigger that woke that turn, if one did.
    const card: Card = {
      cardId: `card_${randomBytes(12).toString("base64url")}`,
      opId,
      idKey,
      kind,
      tool,
      asked,
      agent,
      state: "awaiting_approval",
      expiresAt,
      params,
      cardHash: hashCard({ kind, tool, params, opId, account: this.deps.account, agent, wallet: planned.wallet, mode, ...(route ? { route } : {}) }),
      origin: { clientId: client.clientId, role: client.role, source: sourceOf(client), ...(client.trigger ? { trigger: client.trigger } : {}), ...(client.bot ? { bot: client.bot } : {}), ...(turn?.woken ? { woken: turn.woken } : {}) },
      ...(reason ? { reason } : {}),
      wallet: planned.wallet,
      account: this.deps.account,
      mode,
      ...(planned.side ? { side: planned.side } : {}),
      value: planned.usd === undefined ? { unvalued: true } : { usd: planned.usd, unvalued: false },
      ...(planned.usd === undefined && planned.spent && planned.side !== "sell" ? { valueLater: { ...planned.spent, feeBps: planned.side === "buy" ? (planned.feeBps ?? 0) : 0 } } : {}),
      display: {
        title: planned.title,
        headline: planned.headline,
        ...(planned.wallet !== "none" ? { walletLabel: teeName ?? "embedded" } : {}),
        ...(planned.tee ? { paysFrom: `pays from ${teeName} (TEE · ${short(planned.tee.address)})`, resendNote: "Re-send reads it back; the CLI never sends it twice." } : {}),
        ...(planned.resendNote ? { resendNote: planned.resendNote } : {}),
        ...(planned.preview ? { preview: planned.preview } : {}),
        ...(planned.publicNote ? { publicNote: planned.publicNote } : {}),
        ...(planned.gets ? { gets: planned.gets } : {}),
        ...(planned.sells ? { sells: planned.sells } : {}),
        ...(planned.spend ? { spend: planned.spend } : {}),
        ...(planned.valueUsd !== undefined ? { valueUsd: planned.valueUsd } : {}),
        ...(limit?.ok && (limit.near || (limit.unvalued && planned.side !== "sell")) ? { nearLimit: `Candle Harness limit: ${limit.line}` } : {}),
        ...slippageShown(kind, planned),
        agent,
        wallet: planned.wallet,
        sharedWith: planned.wallet === "none" ? [] : this.sharedWith(agent, planned.wallet),
        ...(planned.mint ? { mint: planned.mint } : {}),
        ...(planned.mintLabel ? { mintLabel: planned.mintLabel } : {}),
        ...(planned.spends ? { spends: planned.spends } : {}),
        ...(planned.price ? { price: planned.price } : {}),
        ...(planned.receives ? { receives: planned.receives } : {}),
        ...(planned.sizedFromUsd ? { sizedFromUsd: planned.sizedFromUsd } : {}),
        ...(planned.pricedAt !== undefined ? { pricedAt: new Date(planned.pricedAt).toISOString() } : {}),
        ...(planned.pricedBy ? { pricedBy: planned.pricedBy } : {}),
        ...(planned.risks ? { risks: planned.risks } : {}),
        ...(planned.publishes ? { publishes: planned.publishes } : {}),
        ...(planned.launchTerms ? { launchTerms: planned.launchTerms } : {}),
        ...(() => {
          // The same name held here, or on an earlier card, for another token: a copy of a ticker reads exactly as the one the person knows.
          const other = planned.mint && planned.symbol ? this.deps.otherMints?.(planned.symbol, planned.mint)[0] : undefined
          return other ? { otherMint: `another ${terminalText(planned.symbol!, { maxLength: 24 })} is in a wallet or on an earlier card here (${short(other)}): this one is ${short(planned.mint!)}` } : {}
        })(),
        ...(() => {
          // Real funds under a paper screen: a live bot's trade, or a live bot proposed, while the Candle Harness is on paper.
          const liveBot = client.bot && mode === "live" ? client.bot.name : input.botCard && !input.botCard.spec.flatten && input.botCard.spec.mode === "live" ? input.botCard.spec.name : undefined
          return liveBot !== undefined && this.deps.mode() === "paper" ? { modeDiffers: `real funds: the bot "${terminalText(liveBot, { maxLength: 40 })}" is live, though the Candle Harness is on paper` } : {}
        })(),
        ...(input.cli || input.pane || REPLAYED_KINDS.has(kind) || (tool === "candle_set_profile_wallets" && input.title === undefined) ? {} : { askAgain: true }),
        ...(() => {
          // A sell of a token two sells of which just failed on this key: one more failure stops the key on Candle.
          const breaker = planned.side === "sell" && planned.mint && client.role !== "core" ? this.deps.sellWarning?.(agent, planned.mint) : undefined
          const warning = [input.warning, breaker].filter((w): w is string => Boolean(w)).join(" ")
          return warning ? { warning: terminalText(warning, { maxLength: 600 }) } : {}
        })(),
        ...(input.triggerCard
          ? {
              triggerCard: {
                ...input.triggerCard.spec,
                line: terminalText(input.triggerCard.spec.line, { maxLength: 1000 }),
                words: terminalText(input.triggerCard.spec.words, { maxLength: 1000 }),
                runs: terminalText(input.triggerCard.spec.runs, { maxLength: 600 }),
              },
              ...(input.triggerCard.paysFrom ? { paysFrom: `pays from ${terminalText(input.triggerCard.paysFrom, { maxLength: 64 })}` } : {}),
            }
          : {}),
        ...(input.botCard
          ? {
              botCard: botSpecShown(input.botCard.spec),
              ...(input.botCard.paysFrom ? { paysFrom: `pays from ${terminalText(input.botCard.paysFrom, { maxLength: 64 })}` } : {}),
              ...(input.botCard.slippage ? { slippage: terminalText(input.botCard.slippage.words, { maxLength: 120 }), slippageLooser: input.botCard.slippage.looser } : {}),
            }
          : {}),
        ...(input.fills?.length ? { fills: input.fills.map((f) => ({ label: terminalText(f.label, { maxLength: 60 }), line: terminalText(f.line, { maxLength: 300 }) })) } : {}),
        ...(planned.pane ? { paneSteps: planned.pane.steps, paneNote: PANE_NOTE } : {}),
        ...(input.pane?.notes?.length ? { paneNotes: input.pane.notes.map((n) => terminalText(n, { maxLength: 300 })) } : {}),
        ...(input.pane?.blocked ? { blocked: input.pane.blocked } : {}),
        ...(input.pane?.shows ? { paneShows: terminalText(input.pane.shows, { maxLength: 200 }) } : {}),
        ...(input.pane?.newAddress ? { newAddress: terminalText(input.pane.newAddress, { maxLength: 120 }) } : {}),
        estimate: planned.usd === undefined ? (planned.side ? "no price" : "") : `≈${usd(planned.usd)}`,
        limits: limit ? `Candle Harness limit: ${limit.line}` : "",
        ...(keyLimit && planned.side ? { candleKeyLimit: `Candle key limit: ${usd(keyLimit.usd)} ${keyLimit.reset}${keyLimit.reset === "daily" ? " (UTC day)" : ""}` } : {}),
        ...(reason ? { why: reason } : {}),
        ...(client.trigger ? { trigger: client.trigger.name } : {}),
        ...(client.bot ? { bot: client.bot.name } : {}),
        ...(client.trigger && input.fired ? { fired: terminalText(input.fired, { maxLength: MAX_REASON }) } : {}),
        ...(turn?.woken ? { woken: turn.woken.trigger } : {}),
        mode,
        ...(kind === "hacc" && mode === "paper" ? { modeNote: HACC_IN_PAPER } : {}),
        // A bot runs in its own mode, whatever the Candle Harness's: the card says the bot's.
        ...(input.botCard && !input.botCard.spec.flatten ? { modeNote: `${input.botCard.spec.mode} bot` } : {}),
        expiresAt,
        supported: kind !== "unknown" && !input.pane?.blocked,
      },
      createdAt: new Date(now).toISOString(),
      ...(route ? { route } : {}),
      ...(input.cli ? { row: input.cli.row, cliRequest: input.cli } : {}),
      ...(input.pane ? { row: input.pane.row.path, paneRequest: input.pane } : {}),
      ...(planned.settles ? { settles: planned.settles } : {}),
    }
    this.cards.set(card.cardId, card)
    this.byOpId.set(opId, card)
    if (turn) this.turnOfCard.set(card, turn.turnId)
    this.prune()
    // The time from a message to its card, read from the journal by the passes. Nothing shows it.
    await this.deps.journal.append({
      type: "card.created",
      mode,
      agent,
      cardId: card.cardId,
      opId,
      clientId: client.clientId,
      role: client.role,
      ...triggerFields(client.trigger),
      ...botFields(client.bot),
      kind,
      tool,
      params,
      cardHash: card.cardHash,
      wallet: card.wallet,
      ...(route === "cli" ? { route, walletLabel: teeName } : route ? { route } : {}),
      ...(row ? { row } : input.pane ? { row: input.pane.row.path } : {}),
      ...(card.side ? { side: card.side } : {}),
      ...(planned.mint ? { mint: planned.mint } : {}),
      ...(planned.quoteOutRaw && card.side === "buy" ? { quoteOutRaw: planned.quoteOutRaw } : {}),
      value: card.value,
      title: card.display.title,
      ...(card.display.headline ? { headline: card.display.headline } : {}),
      expiresAt,
      ...(turn ? { turnId: turn.turnId, msSinceTurnStart: turn.msSinceStart } : {}),
      ...(turn?.woken ? { woken: turn.woken.trigger, wokenFireId: turn.woken.fireId } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      // What a pane card says besides its steps (where funds go, who a key makes): the agent's record reads it.
      ...(card.display.paneNotes ? { notes: card.display.paneNotes } : {}),
    })
    this.deps.onChange?.(card)
    return card
  }

  /**
   * One key press, from a view. In order: the card exists, is awaiting approval, the hash matches
   * (and still matches the mode, agent and wallet it was made for), it hasn't expired, buying isn't
   * paused, and the day limit still holds with the stored value. No network call.
   */
  async approve(viewClientId: string, cardId: unknown, cardHash: unknown, how: unknown = "view"): Promise<ApproveResult> {
    const now = this.deps.now()
    const card = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    if (card === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    if (!isOpen(card) || this.approving.has(card.cardId)) {
      throw refused("CARD_NOT_AWAITING", `This card is ${this.approving.has(card.cardId) ? "being approved" : card.state}.`, { state: card.state })
    }
    if (card.kind === "unknown") throw refused("NOT_SUPPORTED", "The Candle Harness can't run this tool yet. Reject it, or run it yourself with the candle CLI.")
    if (card.display.blocked) throw refused("NO_VAULT", `${card.display.blocked.why} Set one up first: ${card.display.blocked.fill.line}. Nothing was approved.`)
    if (cardHash !== card.cardHash) return this.refuseApproval(card, viewClientId, "CARD_HASH_MISMATCH", "The card changed after it was drawn. Nothing was approved; look at it again.")
    const expected = hashCard({ kind: card.kind, tool: card.tool, params: card.params, opId: card.opId, account: this.deps.account, agent: card.agent, wallet: card.wallet, mode: modeFor(card.origin, this.deps.mode()), ...(card.route ? { route: card.route } : {}) })
    if (expected !== card.cardHash) return this.refuseApproval(card, viewClientId, "CARD_CHANGED", "The mode or the agent changed since this card was made. Nothing was approved.")
    if (now >= Date.parse(card.expiresAt)) return this.repropose(card, viewClientId)
    const spends = card.side === "buy" || card.side === "swap"
    if (pausedStops(card) && this.deps.paused()) return this.refuseApproval(card, viewClientId, "PAUSED", `${pausedMessage(card).split(". ")[0]}. Nothing was sent.`)
    if (card.side) {
      const limit = this.deps.limits.check({ usd: card.value.usd, side: card.side, agent: card.agent, now })
      if (!limit.ok) return this.refuseApproval(card, viewClientId, limit.code, `${limit.message} Nothing was sent.`)
    }
    const hold = card.side && card.mode === "live" ? this.deps.holds?.held(card.agent, now, card.side) : undefined
    if (hold) return this.refuseApproval(card, viewClientId, hold.why === "stopped" ? "RISK_LIMIT_REACHED" : "KEY_LIMIT_REACHED", heldMessage(hold, now))

    // A view can say Enter or click; only the core's own paths say instant, typed or inside-limits.
    const approvedHow: ApprovedHow = typeof how === "string" && (CORE_HOWS.includes(how) || VIEW_HOW.includes(how)) ? (how as ApprovedHow) : "view"
    // Without a card: the wallet's figures are checked here, with nothing awaited before the
    // spend is recorded below, so two agents racing on one wallet can't both pass its day figure.
    const inside = approvedHow === "inside-limits" ? this.insideCheck(card, now) : approvedHow === "bot-exit" ? this.exitCheck(card) : undefined
    if (inside && !inside.run) throw refused("NOT_INSIDE_LIMITS", `This needs a card${inside.words ? `: ${inside.words}` : ""}. Nothing was approved.`)
    // A new address is approved by a click on "yes, a new address", never a key press or the core.
    if (card.display.newAddress && approvedHow !== "click") return this.refuseApproval(card, viewClientId, "NEW_ADDRESS_NEEDS_A_CLICK", "This sends to a new address: check it in full, then click yes, a new address. Nothing was approved.")
    if (card.route === "pane" && !this.deps.openPane) throw refused("METHOD_NOT_AVAILABLE", "The prompt pane isn't in this build of the core.")
    this.approving.add(card.cardId)
    try {
      // The day's spend is recorded before the first await, so a racing approval sees it (the agent's own
      // day limit too: one agent's parallel calls race as two agents do). Settled unspent if the journal fails.
      const counted = spends && card.value.usd !== undefined
      if (counted) this.deps.spend.record(card.opId, card.agent, card.value.usd!, now)
      if (counted && approvedHow === "inside-limits") this.deps.walletSpend?.record(card.opId, card.wallet, card.value.usd!, now)
      try {
        await this.deps.journal.append({
          type: "card.approved",
          mode: card.mode,
          agent: card.agent,
          cardId: card.cardId,
          cardHash: card.cardHash,
          opId: card.opId,
          viewClientId,
          how: approvedHow,
          ...triggerFields(card.origin.trigger),
          ...botFields(card.origin.bot),
          wallet: card.wallet,
          ...(card.side ? { side: card.side } : {}),
          ...(card.value.usd !== undefined ? { usd: card.value.usd } : {}),
          // What a trade with no card was checked against: the wallet's figures and its use today before it.
          ...(inside?.run ? { inside: { words: inside.words, ...(inside.figures ? inside.figures : {}) } } : {}),
        })
      } catch (error) {
        this.deps.spend.settle(card.opId, "failed")
        this.deps.walletSpend?.settle(card.opId, "failed")
        throw error
      }
      card.state = "approved"
      card.approvedHow = approvedHow
      // The kill switch pressed while the approval was written: it skips a card mid-approval, so it's checked again.
      let stopped: Awaited<ReturnType<NonNullable<CardBookDeps["refusePaused"]>>>
      try {
        stopped = await this.deps.refusePaused?.(card)
      } catch (error) {
        // Its write-ahead row couldn't be written (no operation was kept), so nothing was sent: the day's spend goes back.
        if (!this.deps.operations?.().some((op) => op.opId === card.opId)) {
          this.deps.spend.settle(card.opId, "failed")
          this.deps.walletSpend?.settle(card.opId, "failed")
        }
        throw error
      }
      if (stopped) {
        card.operation = stopped
        this.deps.onChange?.(card)
        return { kind: "submitted", card, operation: stopped }
      }
      if (inside?.run) card.withoutCard = inside.words
      this.deps.onChange?.(card)
      // A pane card runs nothing here: the approving view starts the pane with the ticket.
      if (card.route === "pane") {
        const opened = await this.deps.openPane!(card, viewClientId)
        card.operation = opened.operation
        this.deps.onChange?.(card)
        return { kind: "pane", card, ...opened }
      }
      let operation: Awaited<ReturnType<CardBookDeps["execute"]>>
      try {
        operation = await this.deps.execute(card)
      } catch (error) {
        // Its write-ahead row couldn't be written (no operation was kept), so nothing was sent: the day's spend goes back.
        if (!this.deps.operations?.().some((op) => op.opId === card.opId)) {
          this.deps.spend.settle(card.opId, "failed")
          this.deps.walletSpend?.settle(card.opId, "failed")
        }
        throw error
      }
      card.operation = operation
      this.deps.onChange?.(card)
      return { kind: "submitted", card, operation }
    } finally {
      this.approving.delete(card.cardId)
    }
  }

  /**
   * The trade path with no card: a trade card just proposed, by the agent or typed, is
   * approved here by the core as `inside-limits` when its wallet's rule says so (`withoutCard`), in the same
   * call, so nothing else can act on it first. Otherwise it stays a card, saying why where its wallet trades
   * inside limits. `ran` is the approval's result when it ran.
   */
  async runWithoutCard(card: CardView, client: FaceClient): Promise<{ card: Card; ran?: ApproveResult }> {
    const held = this.cards.get(card.cardId)
    if (!held || !isOpen(held) || this.approving.has(held.cardId)) return { card: held ?? (card as Card) }
    // A rules bot's sell goes by its own rule, on any wallet; everything else by its wallet's.
    const how = held.origin.bot?.act === "exit" ? "bot-exit" : "inside-limits"
    const check = how === "bot-exit" ? this.exitCheck(held) : this.insideCheck(held, this.deps.now())
    if (!check.run) {
      if (check.words && held.display.cardBecause !== check.words) {
        held.cardBecause = check.words
        held.display.cardBecause = check.words
        // Why it's a card, kept with its life, so the Journal can say why a trade wasn't hands off.
        await this.deps.journal.append({ type: "card.because", mode: held.mode, agent: held.agent, cardId: held.cardId, opId: held.opId, words: check.words, ...triggerFields(held.origin.trigger), ...botFields(held.origin.bot) })
        this.deps.onChange?.(held)
      }
      return { card: held }
    }
    return { card: held, ran: await this.approve(client.clientId, held.cardId, held.cardHash, how) }
  }

  /**
   * A rules bot's sell runs with no card on any wallet, a wallet that asks every time included: the person approved
   * its exits with the bot, and a stop that waits for a press isn't a stop. Only the core's own proposal of a bot's
   * exit, a live sell; a looser slippage bound or the same sell still in flight waits for the person, as any trade.
   */
  private exitCheck(card: Card): WithoutCard {
    const bot = card.origin.bot
    if (!bot || bot.act !== "exit" || card.origin.role !== "core" || card.mode !== "live" || card.kind !== "trade" || card.side !== "sell" || card.row !== undefined || card.route === "pane") return { run: false }
    if (this.inFlight(card)) return { run: false, words: "the same sell is still in flight, so this one waits for you" }
    if (bot.kind === "code" && bot.position && this.positionSelling(card, bot.name, bot.position)) return { run: false, words: "another sell of this position is still in flight, so this one waits for you" }
    if (card.display.slippageLooser && botBound(card) === undefined) return { run: false, words: `${card.display.slippage}, looser than that, so this one waits for you` }
    // A flatten is the person's own ask (theirs, or the agent's card they approved), not one of its exits.
    if (bot.reason === "flatten") return { run: true, words: `without a card, to flatten the bot "${bot.name}", as you asked${boundWords(card)}` }
    return { run: true, words: `without a card, as the bot "${bot.name}"'s exit: you approved its exits with it${boundWords(card)}` }
  }

  /**
   * Another sell of the same position of a code bot, approved and not yet settled, whatever its size or its request's
   * id: two sells of one position at once would each be sized from the whole of it.
   */
  private positionSelling(card: Card, bot: string, position: string): boolean {
    for (const other of this.cards.values()) {
      if (other === card || (other.state !== "approved" && !this.approving.has(other.cardId))) continue
      const o = other.origin.bot
      if (!o || o.name !== bot || o.act !== "exit" || o.position !== position) continue
      const state = other.operation?.state
      if (state !== undefined && !UNSETTLED.has(state)) continue
      return true
    }
    return false
  }

  /** The rule for this card now: its wallet's setting and use today, and whether the same trade is in flight. */
  /** Cards whose approval is being written now: the kill switch can't withdraw them, and lists them as in flight. */
  approvingNow(): Card[] {
    return [...this.approving].flatMap((id) => (this.cards.get(id) ? [this.cards.get(id)!] : []))
  }

  private insideCheck(card: Card, now: number): WithoutCard {
    const setting = card.wallet === "none" ? ASK : (this.deps.autonomy?.get(card.wallet) ?? ASK)
    if (setting.setting !== "inside") return { run: false }
    return withoutCard({
      card: { ...card, walletName: card.display.walletLabel ?? "embedded" },
      setting,
      usedUsd: this.deps.walletSpend?.spent(card.wallet, now, card.opId),
      inFlight: this.inFlight(card),
    })
  }

  /**
   * Another trade from the same agent with the same request, approved and not yet settled, however it was
   * approved: a press, or the core. A rules bot's trade is only ever its own bot's retry. One a restart left in
   * flight counts too, from the operations, since cards don't survive a restart.
   */
  private inFlight(card: Card): boolean {
    const asked = canonicalJson({ tool: card.tool, asked: withoutId(card.asked, card.idKey) })
    for (const other of this.cards.values()) {
      if (other === card || other.agent !== card.agent || (other.state !== "approved" && !this.approving.has(other.cardId))) continue
      // Two bots buying one token, or a bot and its agent, are two trades, not a retry: a bot never retries another's.
      if ((card.origin.bot || other.origin.bot) && card.origin.bot?.name !== other.origin.bot?.name) continue
      // A code bot's two requests, each with its own id, are two trades: the core never sends one id twice itself.
      if (card.origin.bot?.request && other.origin.bot?.request && card.origin.bot.request !== other.origin.bot.request) continue
      const state = other.operation?.state
      if (state !== undefined && !UNSETTLED.has(state)) continue
      if (canonicalJson({ tool: other.tool, asked: withoutId(other.asked, other.idKey) }) === asked) return true
    }
    const sent = canonicalJson({ tool: card.tool, params: sansIds(card.params) })
    for (const op of this.deps.operations?.() ?? []) {
      if (op.agent !== card.agent || op.opId === card.opId || this.byOpId.has(op.opId) || !UNSETTLED.has(op.state)) continue
      if (canonicalJson({ tool: op.tool, params: sansIds(op.params) }) === sent) return true
    }
    return false
  }

  async reject(viewClientId: string, cardId: unknown): Promise<Card> {
    return this.close(cardId, "rejected", { by: viewClientId })
  }

  /** The proposer takes back its own card. Another client's card answers as missing. */
  async withdraw(clientId: string, cardId: unknown): Promise<Card> {
    const card = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    if (card === undefined || card.origin.clientId !== clientId) throw refused("CARD_NOT_FOUND", "No card with that id.")
    return this.close(cardId, "withdrawn", { by: clientId })
  }

  /** Withdraws every open card that matches, for the kill switch. */
  async withdrawWhere(match: (card: Card) => boolean, reason: string): Promise<Card[]> {
    const withdrawn: Card[] = []
    for (const card of this.cards.values()) {
      if (isOpen(card) && !this.approving.has(card.cardId) && match(card)) withdrawn.push(await this.close(card.cardId, "withdrawn", { reason }))
    }
    return withdrawn
  }

  /**
   * A new card at a fresh price for every open card that matches, the old one withdrawn once the new one
   * exists, for the kill switch's kept sells (a 60 s sell could expire while the report was read).
   * One the core can't re-propose stays as it was.
   */
  async refreshWhere(match: (card: Card) => boolean, reason: string): Promise<{ old: Card; fresh: Card }[]> {
    const out: { old: Card; fresh: Card }[] = []
    for (const card of [...this.cards.values()]) {
      if (!isOpen(card) || this.approving.has(card.cardId) || !match(card)) continue
      let fresh: Card
      const before = new Set(this.cards.keys())
      try {
        fresh = await this.fresh(card, {}, card.cardId)
      } catch {
        continue
      }
      // Approved while the new one was being made: the press was first, so the new card would be the
      // same sell a second time, one Enter away. It goes, and isn't kept.
      if (this.approvedMeanwhile(card)) {
        if (!before.has(fresh.cardId)) await this.close(fresh.cardId, "withdrawn", { reason: "original_approved" }).catch(() => {})
        continue
      }
      if (isOpen(card) && !this.approving.has(card.cardId)) {
        card.replacedBy = fresh.cardId
        await this.close(card.cardId, "withdrawn", { reason, replacedBy: fresh.cardId })
      }
      out.push({ old: card, fresh })
    }
    return out
  }

  async expireDue(): Promise<void> {
    const now = this.deps.now()
    for (const card of this.cards.values()) {
      if (isOpen(card) && !this.approving.has(card.cardId) && Date.parse(card.expiresAt) <= now) {
        await this.close(card.cardId, "expired", { reason: "expiresAt" })
      }
    }
  }

  /** Cards don't survive a restart: each one left open in the journal is expired, and the journal says why. */
  async expireAfterRestart(rows: readonly JournalRow[]): Promise<string[]> {
    const open = new Map<string, JournalRow>()
    for (const row of rows) {
      if (typeof row.cardId !== "string") continue
      if (row.type === "card.created") open.set(row.cardId, row)
      else if (row.type === "card.approved" || row.type === "card.rejected" || row.type === "card.withdrawn" || row.type === "card.expired") open.delete(row.cardId)
    }
    for (const [cardId, row] of open) {
      // A trigger's or a bot's card keeps its origin, so its records still say whose it was.
      const origin = Object.fromEntries(Object.entries(row).filter(([k]) => ORIGIN_FIELDS.has(k)))
      await this.deps.journal.append({ type: "card.expired", mode: row.mode, ...(row.agent ? { agent: row.agent } : {}), cardId, opId: row.opId, ...origin, reason: "core_restarted" })
    }
    return [...open.keys()]
  }

  /**
   * An expired card's "re-quote": a fresh card for the same request, valued now. Nothing runs.
   *
   * With `wallet` (a wallet chip in `ctrl-o` details), a trade or swap card, open or
   * expired, is proposed again paid from that wallet: `embedded`, or a TEE wallet's address. It's a new
   * card with a new hash and a fresh price, checked as any proposal is, and the open card is withdrawn
   * once the new one exists. A refusal leaves the old card as it was.
   */
  async requote(viewClientId: string, cardId: unknown, opts: { wallet?: unknown } = {}): Promise<Card> {
    const card = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    if (card === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    // A bot's buy is the bot's: one that expired was skipped, and it pays from the wallet the bot was approved on.
    // A fresh card would be a buy no bot's book holds.
    const bot = card.origin.bot
    if (bot && opts.wallet === undefined) throw refused("BOT_ENTRY_SKIPPED", botSkippedWords(bot.name))
    if (bot) throw refused("WALLET_FIXED", `The bot "${bot.name}" pays from the wallet it was approved on. Ask the agent to change the bot to pay from another.`)
    if (opts.wallet === undefined) {
      if (card.state !== "expired") throw refused("CARD_NOT_EXPIRED", `This card is ${card.state}; only an expired card is re-quoted.`)
      if (card.display.askAgain) throw refused("ASK_AGAIN", ASK_AGAIN_WORDS)
      return this.fresh(card)
    }
    if (card.tool !== "candle_trade" && card.tool !== "candle_swap") throw refused("WALLET_FIXED", "Only a trade or a swap can be paid from another wallet.")
    if (typeof opts.wallet !== "string" || opts.wallet.trim() === "" || opts.wallet.length > 64) throw invalidParams('wallet names a wallet the agent can pay from: an address or "embedded".')
    const open = isOpen(card) && !this.approving.has(card.cardId)
    if (!open && card.state !== "expired") throw refused("CARD_NOT_AWAITING", `This card is ${card.state}.`, { state: card.state })
    const before = new Set(this.cards.keys())
    const fresh = await this.fresh(card, { wallet: opts.wallet }, open ? card.cardId : undefined)
    // Approved while the new one was being made: the press was first, so the new card would be the same
    // trade a second time, one Enter away. It goes, and the view is told no new card was made.
    if (open && this.approvedMeanwhile(card)) {
      if (!before.has(fresh.cardId)) await this.close(fresh.cardId, "withdrawn", { by: viewClientId, reason: "original_approved" }).catch(() => {})
      throw refused("CARD_ALREADY_APPROVED", "The card was approved before the new one was made, so it runs as it was, and no new card was made.", { state: card.state })
    }
    if (fresh.cardId !== card.cardId && isOpen(card) && !this.approving.has(card.cardId)) {
      card.replacedBy = fresh.cardId
      await this.close(card.cardId, "withdrawn", { by: viewClientId, reason: "paid_from_another_wallet", replacedBy: fresh.cardId })
    }
    return fresh
  }

  /** Pressed while a fresh card for it was being made. */
  private approvedMeanwhile(card: Card): boolean {
    return this.approving.has(card.cardId) || card.state === "approved"
  }

  private async repropose(card: Card, viewClientId: string): Promise<ApproveResult> {
    await this.close(card.cardId, "expired", { reason: "approved_after_expiry", by: viewClientId })
    if (card.origin.bot) throw refused("BOT_ENTRY_SKIPPED", botSkippedWords(card.origin.bot.name))
    if (card.display.askAgain) throw refused("ASK_AGAIN", ASK_AGAIN_WORDS)
    return { kind: "reproposed", expired: card, fresh: await this.fresh(card) }
  }

  /** A new card for an old card's request, at today's prices and limits; `change` replaces some of what was asked. */
  private fresh(card: Card, change: Record<string, unknown> = {}, replaces?: string): Promise<Card> {
    const asked = { ...card.asked, ...change }
    return this.propose({
      client: { clientId: card.origin.clientId, role: card.origin.role, agent: card.agent, ...(card.origin.trigger ? { trigger: card.origin.trigger } : {}) },
      agent: card.agent,
      tool: card.tool,
      args: asked,
      params: asked,
      ...(replaces ? { replaces } : {}),
      kind: card.kind,
      idKey: card.idKey,
      ...(card.reason !== undefined ? { reason: card.reason } : {}),
      ...(card.cliRequest ? { cli: card.cliRequest } : {}),
      ...(card.paneRequest ? { pane: card.paneRequest } : {}),
    })
  }

  private async planTrade(client: FaceClient, agent: string, given: Record<string, unknown>, status: AgentStatus | undefined, opId: string): Promise<Planned> {
    const tool = "candle_trade"
    const invalid = (message: string) => this.refuse(client, agent, tool, "INVALID_TRADE", message)
    // What trades spend isn't a trade's token. Sold as one, it would be a conversion that every limit, the
    // wallet's figures and the kill switch let through as a sell. CNDL trades like any token.
    const spent = notATradeToken(given.mint)
    if (spent !== undefined) return this.refuse(client, agent, tool, "BASE_ASSET", spent)
    const sized = await sizeInUsd(agent, given, { markets: this.deps.markets, pricing: this.deps.pricing, spendAsset: this.deps.spendAsset })
    if (!sized.ok) return this.refuse(client, agent, tool, sized.code, sized.message)
    const args = sized.args
    const mint = args.mint
    const side = args.side
    if (typeof mint !== "string" || mint.length === 0 || mint.length > 64) return invalid("A trade needs the token's mint.")
    if (side !== "buy" && side !== "sell") return invalid('side is "buy" or "sell".')
    const amount = args.amount === undefined ? undefined : decimalAmount(args.amount)
    if (args.amount !== undefined && amount === undefined) return invalid("amount must be a positive decimal, such as \"0.5\".")
    const percent = args.percent
    if ((amount === undefined) === (percent === undefined)) return invalid("Pass exactly one of amount or percent.")
    if (percent !== undefined && (side !== "sell" || !Number.isInteger(percent) || (percent as number) < 1 || (percent as number) > 100)) {
      return invalid("percent is for sells only: a whole number from 1 to 100.")
    }
    const word = walletWord(args.wallet)
    if (word === null) return invalid('wallet names a wallet the agent can pay from: a label, an address or "embedded".')

    const resolved = await this.deps.markets.resolve(agent, mint)
    if (!resolved.ok) return this.refuse(client, agent, tool, resolved.code, resolved.message)
    const market = resolved.market
    const payer = await this.paying(client, agent, tool, status, market.chain, word)
    const wallet = payer.address
    const tee = payer.kind === "tee" ? payer : undefined
    // A name that could pass for another token's carries its short address, as everywhere else it's shown.
    const label = tokenLabel(market.symbol, mint) ?? short(mint)
    const { amount: _a, percent: _p, paper: _paper, wallet: _w, ...rest } = args
    const feeBps = status?.feeBps ?? FALLBACK_FEE_BPS

    const settled = settlementAsset(market, args.quoteAsset)
    if ("invalid" in settled) return invalid(settled.invalid)
    const asset = settled.asset
    const assetName = asset ?? "its pair asset"
    const named = { ...(market.symbol ? { symbol: market.symbol } : {}), ...(asset ? { settles: asset } : {}) }
    // Over the key's Candle cap for the asset a buy spends: Candle would refuse it when it builds the
    // trade, so it's refused here in Candle's words, before any read.
    if (side === "buy" && asset !== undefined && amount !== undefined) {
      const raw = toRaw(amount, BASE_ASSETS[asset].decimals)
      const over = raw === undefined ? undefined : overAssetCap(status?.assetCaps, asset, raw)
      if (over) return this.refuse(client, agent, tool, "SPEND_LIMIT_EXCEEDED", `Over ${agent}'s Candle cap of ${capText(over)} a buy: this buy spends ${grouped(amount)} ${asset}. Nothing was sent; a smaller amount can go.`)
    }
    // A TEE wallet's trade runs through `candle swap`: the argv is what the card binds.
    let via: Pick<Planned, "tee" | "cli" | "cliRpcUrl"> = {}
    if (tee) {
      if (modeFor(client, this.deps.mode()) === "paper") return this.refuse(client, agent, tool, "NO_PAPER_TEE", "TEE wallets have no paper form; switch to live to trade from one.")
      if (asset === undefined) return this.refuse(client, agent, tool, "PAIR_UNKNOWN", `${label} trades against an asset the Candle Harness doesn't know, so it can't be traded from a TEE wallet yet. Nothing was sent.`)
      const slippage = slippageBps(args.maxSlippageBps)
      if (slippage === null) return invalid("maxSlippageBps is a whole number of basis points, from 0 to 10000.")
      const sizing = side === "buy" ? { amount: amount! } : percent !== undefined ? { percent: percent as number } : { amount: amount! }
      const [from, to] = side === "buy" ? [asset, mint] : [mint, asset]
      via = { tee: { address: tee.address, ...(tee.label ? { label: tee.label } : {}) }, cli: teeSwapArgs({ from, to, sizing, wallet: tee.address, opId, ...(slippage !== undefined ? { slippageBps: slippage } : {}) }), cliRpcUrl: market.chain === "solana" }
    }
    // Both prices read now, together: a sized buy's asset read is shared, not repeated.
    const [assetPoint, tokenPoint] = await Promise.all([asset ? this.deps.pricing.asset(agent, asset) : undefined, this.deps.pricing.token(agent, market.chain, mint)])
    const assetPrice = assetPoint?.usd
    const tokenPrice = tokenPoint?.usd
    const priced = (points: (number | undefined)[], by: string) => {
      const at = points.filter((t): t is number => t !== undefined)
      return at.length ? { pricedAt: Math.min(...at), pricedBy: by } : {}
    }
    const marketPriced = priced([assetPoint?.at, tokenPoint?.at], "Candle market read")
    const price = tokenPrice === undefined ? undefined : `${label} ${priceText(tokenPrice)}`
    const worth = (usdValue: number | undefined) => (usdValue === undefined ? "" : ` (≈${usd(usdValue)})`)
    /** Candle's quote for this exact trade, once the agent's MCP server has the tool; refuses a key Candle says can't pay. */
    const quoted = async (side: "buy" | "sell", amountRaw: bigint | undefined) => {
      // Candle's quote is for the embedded payer; a TEE card is valued by the market read.
      if (tee || amountRaw === undefined || amountRaw <= 0n) return undefined
      const q = await this.deps.pricing.quote(agent, { chain: market.chain, mint, side, amountRaw: amountRaw.toString(), ...(asset ? { quoteAsset: asset.toLowerCase() } : {}) })
      if (q?.payerPermitted === false) {
        return this.refuse(client, agent, tool, "EMBEDDED_WALLET_NOT_PERMITTED", "Candle's quote says this key isn't allowed to spend from the embedded wallet. The owner allows it with candle keys update <prefix> --embedded-wallet allow.")
      }
      return q
    }
    const riskText = (q: Quote | undefined) => {
      const kinds = (q?.tokenRisks ?? []).map((r) => (r as { kind?: unknown } | null)?.kind).filter((k): k is string => typeof k === "string")
      return kinds.length ? { risks: kinds.map((k) => terminalText(k, { maxLength: 32 })).join(", ") } : {}
    }

    if (side === "buy") {
      // Candle ignores quoteAsset for a token it launched and spends the token's own pair, so an amount
      // given in another asset would quietly mean something else: refused, with what would work.
      if (market.candleLaunched && args.quoteAsset !== undefined && asset !== undefined && String(args.quoteAsset).toUpperCase() !== asset) {
        return this.refuse(
          client,
          agent,
          tool,
          "PAIR_MISMATCH",
          `${label} trades against ${asset}, not ${String(args.quoteAsset).toUpperCase()}. Buy it with ${asset}, or in dollars (buy $25 ${label}).`,
        )
      }
      const spendUsd = assetPrice === undefined ? undefined : Number(amount) * assetPrice
      const usdValue = spendUsd === undefined ? undefined : spendUsd * (1 + feeBps / 10_000)
      const quote = await quoted("buy", asset ? toRaw(amount!, BASE_ASSETS[asset].decimals) : undefined)
      const tokensOut = quote && market.decimals !== undefined ? Number(quote.amountOutRaw) / 10 ** market.decimals : undefined
      if (tokensOut !== undefined && quote) {
        return {
          params: { ...rest, mint, side, amount: amount! },
          ...via,
          ...named,
          side: "buy",
          ...(asset ? { spent: { asset, amount: amount! } } : {}),
          wallet,
          usd: usdValue,
          feeBps,
          title: `BUY ${grouped(amount!)} ${assetName}${worth(spendUsd)} → ${label}`,
          headline: sized.fromUsd ? `BUY ${usd(sized.fromUsd.usd)} of ${label}` : `BUY ${grouped(amount!)} ${assetName} of ${label}`,
          ...(sized.fromUsd ? { spend: { amount: Number(amount), asset: assetName } } : {}),
          ...(spendUsd !== undefined ? { valueUsd: spendUsd } : {}),
          gets: { amount: tokensOut, asset: label },
          mint,
          mintLabel: label,
          spends: market.candleLaunched ? `${assetName}, this token's own pair asset` : `${assetName}`,
          ...(spendUsd !== undefined && tokensOut > 0 ? { price: `${label} ${priceText(spendUsd / tokensOut)}` } : price ? { price } : {}),
          receives: `≈${amountText(tokensOut)} ${label}, Candle's quote before fees and slippage`,
          ...(sized.fromUsd ? { sizedFromUsd: `${usd(sized.fromUsd.usd)} at ${sized.fromUsd.asset} ${priceText(sized.fromUsd.assetPriceUsd)}` } : {}),
          pricedAt: quote.quotedAt,
          pricedBy: "Candle quote",
          ...(/^\d{1,78}$/.test(String(quote.amountOutRaw)) ? { quoteOutRaw: String(quote.amountOutRaw) } : {}),
          ...riskText(quote),
        }
      }
      return {
        params: { ...rest, mint, side, amount: amount! },
        ...via,
        ...named,
        side: "buy",
        ...(asset ? { spent: { asset, amount: amount! } } : {}),
        wallet,
        usd: usdValue,
        feeBps,
        title: `BUY ${grouped(amount!)} ${assetName}${worth(spendUsd)} → ${label}`,
        headline: sized.fromUsd ? `BUY ${usd(sized.fromUsd.usd)} of ${label}` : `BUY ${grouped(amount!)} ${assetName} of ${label}`,
        ...(sized.fromUsd ? { spend: { amount: Number(amount), asset: assetName } } : {}),
        ...(spendUsd !== undefined ? { valueUsd: spendUsd } : {}),
        ...(spendUsd !== undefined && tokenPrice !== undefined ? { gets: { amount: spendUsd / tokenPrice, asset: label } } : {}),
        mint,
        mintLabel: label,
        spends: market.candleLaunched ? `${assetName}, this token's own pair asset` : `${assetName}`,
        ...(price ? { price } : {}),
        ...(spendUsd !== undefined && tokenPrice !== undefined ? { receives: `≈${amountText(spendUsd / tokenPrice)} ${label}, before fees and slippage` } : {}),
        ...(sized.fromUsd ? { sizedFromUsd: `${usd(sized.fromUsd.usd)} at ${sized.fromUsd.asset} ${priceText(sized.fromUsd.assetPriceUsd)}` } : {}),
        ...marketPriced,
      }
    }

    // A live percent sell goes to Candle as the percent: its MCP server sizes it from the wallet's raw
    // balance when it runs. An amount needs the market's decimals, which Candle reports only for a token
    // it launched (docs.candle.tv/developers/market-state): sent as an amount, a sell of any other token was refused.
    // The card's "≈N" is the core's own read now, an estimate.
    let sellAmount = amount
    let sellRaw: bigint | undefined
    let sold: string
    if (percent !== undefined) {
      const holding = await this.deps.holding(agent, wallet, mint)
      if (holding === "unreadable") return this.refuse(client, agent, tool, "BALANCE_UNREADABLE", "Couldn't read the wallet's balance for a percent sell; try again in a moment. Nothing was sent.")
      if (holding === "none" || holding.amountRaw === 0n) return this.refuse(client, agent, tool, "NOTHING_TO_SELL", `The wallet holds no ${label} to sell.`)
      sellRaw = (holding.amountRaw * BigInt(percent as number)) / 100n
      if (sellRaw === 0n) return this.refuse(client, agent, tool, "NOTHING_TO_SELL", `${percent}% of the wallet's ${label} rounds to nothing.`)
      sellAmount = fromRaw(sellRaw, holding.decimals)
      sold = `${percent}% · ≈${grouped(sellAmount)} ${label}`
    } else if (tee) {
      // `candle swap` reads the token's decimals from the chain (swap.ts:366-384), so an amount sells
      // on this route whatever Candle's market read says.
      sellRaw = market.decimals === undefined ? undefined : toRaw(sellAmount!, market.decimals)
      sold = `${grouped(sellAmount!)} ${label}`
    } else {
      if (market.decimals === undefined) {
        return this.refuse(
          client,
          agent,
          tool,
          "SELL_BY_PERCENT",
          `Candle can't sell an amount of ${label} yet, as it doesn't report this token's decimals. Sell a percent instead, such as: sell 100% ${label}. Nothing was sent.`,
        )
      }
      sellRaw = toRaw(sellAmount!, market.decimals)
      sold = `${grouped(sellAmount!)} ${label}`
    }
    const sizing = percent !== undefined ? { percent: percent as number } : { amount: sellAmount! }
    const headline = percent !== undefined ? `SELL ${percent}% of ${label}` : `SELL ${grouped(sellAmount!)} ${label}`
    const sells = percent !== undefined ? { sells: { amount: Number(sellAmount), asset: label } } : {}
    const quote = await quoted("sell", sellRaw)
    const assetOut = quote && asset ? Number(quote.amountOutRaw) / 10 ** BASE_ASSETS[asset].decimals : undefined
    if (assetOut !== undefined && quote) {
      const quotedUsd = assetPrice === undefined ? undefined : assetOut * assetPrice
      return {
        params: { ...rest, mint, side, ...sizing },
        ...via,
        ...named,
        side: "sell",
        wallet,
        usd: quotedUsd,
        title: `SELL ${sold}${worth(quotedUsd)} → ${assetName}`,
        headline,
        ...sells,
        gets: { amount: assetOut, asset: assetName },
        ...(quotedUsd !== undefined ? { valueUsd: quotedUsd } : {}),
        mint,
        mintLabel: label,
        ...(price ? { price } : {}),
        receives: `≈${amountText(assetOut)} ${assetName}, Candle's quote before fees and slippage`,
        pricedAt: quote.quotedAt,
        pricedBy: "Candle quote",
        ...riskText(quote),
      }
    }
    const usdValue = tokenPrice === undefined ? undefined : Number(sellAmount) * tokenPrice
    return {
      params: { ...rest, mint, side, ...sizing },
      ...via,
      ...named,
      side: "sell",
      wallet,
      usd: usdValue,
      title: `SELL ${sold}${worth(usdValue)} → ${assetName}`,
      headline,
      ...sells,
      ...(usdValue !== undefined && assetPrice !== undefined ? { gets: { amount: usdValue / assetPrice, asset: assetName } } : {}),
      ...(usdValue !== undefined ? { valueUsd: usdValue } : {}),
      mint,
      mintLabel: label,
      ...(price ? { price } : {}),
      ...(usdValue !== undefined && assetPrice !== undefined ? { receives: `≈${amountText(usdValue / assetPrice)} ${assetName}, before fees and slippage` } : {}),
      ...marketPriced,
    }
  }

  private async planSwap(client: FaceClient, agent: string, args: Record<string, unknown>, status: AgentStatus | undefined, opId: string): Promise<Planned> {
    const invalid = (message: string) => this.refuse(client, agent, "candle_swap", "INVALID_SWAP", message)
    const { from, to } = args
    if (!isBaseAsset(from) || !isBaseAsset(to) || from === to) return invalid("A swap is between two different base assets: SOL, USDC, CNDL, ETH or USDG.")
    const amount = args.amount === undefined ? undefined : decimalAmount(args.amount)
    const amountRaw = typeof args.amountRaw === "string" && /^\d+$/.test(args.amountRaw) && BigInt(args.amountRaw) > 0n ? args.amountRaw : undefined
    if ((amount === undefined) === (amountRaw === undefined)) return invalid("Pass exactly one of amount (a decimal) or amountRaw.")
    const word = walletWord(args.wallet)
    if (word === null) return invalid('wallet names a wallet the agent can pay from: a label, an address or "embedded".')
    const payer = await this.paying(client, agent, "candle_swap", status, BASE_ASSETS[from].chain, word)
    const wallet = payer.address
    const decimal = amount ?? fromRaw(BigInt(amountRaw!), BASE_ASSETS[from].decimals)
    let via: Pick<Planned, "tee" | "cli" | "cliRpcUrl"> = {}
    if (payer.kind === "tee") {
      const refuse = (code: string, message: string) => this.refuse(client, agent, "candle_swap", code, message)
      if (modeFor(client, this.deps.mode()) === "paper") return refuse("NO_PAPER_TEE", "TEE wallets have no paper form; switch to live to swap from one.")
      // SOL or USDC to ETH or USDG is a bridge between two TEE wallets in `candle swap`: not yet.
      if (BASE_ASSETS[to].chain !== BASE_ASSETS[from].chain) return refuse("BRIDGE_LATER", `${from} to ${to} is a bridge between chains, which the Candle Harness doesn't run from a TEE wallet yet. Nothing was sent.`)
      const slippage = slippageBps(args.maxSlippageBps)
      if (slippage === null) return invalid("maxSlippageBps is a whole number of basis points, from 0 to 10000.")
      via = { tee: { address: payer.address, ...(payer.label ? { label: payer.label } : {}) }, cli: teeSwapArgs({ from, to, sizing: { amount: decimal }, wallet: payer.address, opId, ...(slippage !== undefined ? { slippageBps: slippage } : {}) }), cliRpcUrl: BASE_ASSETS[from].chain === "solana" }
    }
    const [fromPoint, toPoint] = await Promise.all([this.deps.pricing.asset(agent, from), this.deps.pricing.asset(agent, to)])
    const price = fromPoint?.usd
    const toPrice = toPoint?.usd
    const value = price === undefined ? undefined : Number(decimal) * price
    const at = [fromPoint?.at, toPoint?.at].filter((t): t is number => t !== undefined)
    const { paper: _paper, wallet: _w, ...rest } = args
    // Converting between base assets has no Candle fee (docs.candle.tv/protocol/fees).
    return {
      params: rest,
      ...via,
      side: "swap",
      spent: { asset: from, amount: decimal },
      wallet,
      usd: value,
      title: `SWAP ${grouped(decimal)} ${from}${value === undefined ? "" : ` (≈${usd(value)})`} → ${to}`,
      headline: `SWAP ${grouped(decimal)} ${from} → ${to}`,
      ...(value !== undefined && toPrice !== undefined ? { gets: { amount: value / toPrice, asset: to } } : {}),
      ...(value !== undefined ? { valueUsd: value } : {}),
      ...(value !== undefined && toPrice !== undefined ? { receives: `≈${amountText(value / toPrice)} ${to}, before slippage` } : {}),
      ...(at.length ? { pricedAt: Math.min(...at), pricedBy: "Candle market read" } : {}),
    }
  }

  /**
   * A launch from the embedded wallet: candle_launch_token, or candle_launch_and_seed
   * with a seed. Dry-run first under the card's own id, which writes nothing on Candle's side
   * (docs.candle.tv/developers/headless-launch, "Dry run"); a refusal there makes no card. The image goes by URL
   * only: a dry run naming a file would publish it before the press. A seed is a buy:
   * valued now and held to the Candle Harness limits.
   */
  private async planLaunch(client: FaceClient, agent: string, tool: string, given: Record<string, unknown>, status: AgentStatus | undefined, opId: string): Promise<Planned> {
    const invalid = (message: string) => this.refuse(client, agent, tool, "INVALID_LAUNCH", message)
    if (given.imagePath !== undefined || given.bannerPath !== undefined) {
      return this.refuse(
        client,
        agent,
        tool,
        "IMAGE_BY_URL",
        "The Candle Harness launches with image URLs only, so the dry run can show the card without publishing anything. Upload the file first with candle image upload (its own card: the upload is public and permanent), then pass the URL it returns as imageUrl or bannerUrl. Nothing was sent.",
      )
    }
    const { dryRun: _d, paper: _p, clientLaunchId: _id, ...rest } = given
    const chain = given.chain === "hood" ? "hood" : "solana"
    const wallet = await this.payingWallet(client, agent, tool, status, chain)
    const quote = (typeof given.quoteAsset === "string" ? given.quoteAsset : chain === "hood" ? "eth" : "sol").toUpperCase()
    const asset = isBaseAsset(quote) ? quote : undefined
    // candle_launch_and_seed takes the seed in decimal units, candle_launch_token in raw base units.
    let seed: string | undefined
    if (tool === "candle_launch_and_seed" && given.devBuy !== undefined) {
      seed = decimalAmount(given.devBuy)
      if (seed === undefined) return invalid('devBuy is a positive decimal amount of the quote asset, such as "0.25".')
    } else if (tool === "candle_launch_token" && given.buyAmount !== undefined && String(given.buyAmount) !== "0") {
      const raw = String(given.buyAmount)
      if (!/^\d+$/.test(raw)) return invalid("buyAmount is a whole number of the quote asset's base units.")
      seed = asset ? fromRaw(BigInt(raw), BASE_ASSETS[asset].decimals) : undefined
      if (seed === undefined) return invalid(`The Candle Harness can't value a seed in ${quote}. Launch without one, or seed in SOL, USDC or CNDL.`)
    }
    const params = { ...rest, dryRun: false }
    const [dry, price] = await Promise.all([this.askCandle(client, agent, tool, { ...params, clientLaunchId: opId, dryRun: true }), seed && asset ? this.deps.pricing.asset(agent, asset) : undefined])
    const api = record(dry.api) ?? dry
    const terms = record(api.curveTerms)
    const symbol = terminalText(String(given.symbol ?? "?"), { maxLength: 16 })
    const name = typeof given.name === "string" ? terminalText(given.name, { maxLength: 40 }) : undefined
    const spendUsd = seed !== undefined && price ? Number(seed) * price.usd : undefined
    const seedText = seed !== undefined ? `${grouped(seed)} ${asset ?? quote}` : undefined
    const ceiling = typeof api.devBuyMax === "string" && /^\d+$/.test(api.devBuyMax) && asset ? `dev-buy ceiling ${grouped(fromRaw(BigInt(api.devBuyMax), BASE_ASSETS[asset].decimals))} ${asset}` : undefined
    const supplyPct = record(terms?.firstBuy)?.supplyPct
    const preview = [
      typeof terms?.raise === "number" && typeof terms.symbol === "string" ? `raises ${amountText(terms.raise)} ${terminalText(terms.symbol, { maxLength: 8 })} to graduate` : undefined,
      seed !== undefined && typeof supplyPct === "number" ? `the seed buys ≈${amountText(supplyPct)}% of supply` : undefined,
      ceiling,
      status?.dailyLaunchCap !== undefined ? `${status.dailyLaunchCap} launches a day, shared by every key on the account` : undefined,
    ].filter(Boolean)
    const publishes = launchPublishes(given)
    const setTerms = launchTerms(given)
    return {
      params,
      ...(publishes ? { publishes } : {}),
      ...(setTerms ? { launchTerms: setTerms } : {}),
      ...(seed !== undefined ? { side: "buy" as const } : {}),
      wallet,
      usd: spendUsd,
      title: `LAUNCH ${symbol}${name ? ` (${name})` : ""}${seedText ? ` + seed ${seedText}${spendUsd === undefined ? "" : ` (≈${usd(spendUsd)})`}` : ""}`,
      headline: `LAUNCH ${symbol}${seedText ? ` · seed ${seedText}` : ""}`,
      ...(seed !== undefined && asset ? { spend: { amount: Number(seed), asset } } : {}),
      ...(spendUsd !== undefined ? { valueUsd: spendUsd } : {}),
      ...(seed !== undefined ? { spends: `${asset ?? quote}, the seed (a dev buy) from the embedded wallet` } : {}),
      ...(price ? { pricedAt: price.at, pricedBy: "Candle market read" } : {}),
      ...(preview.length ? { preview: preview.join(" · ") } : {}),
      publicNote: "public: a new token can't be taken back",
      resendNote: "Re-send uses the same clientLaunchId, which Candle replays: it never launches a second token.",
    }
  }

  /**
   * Staking from the embedded wallet: candle_stake, candle_unstake, candle_finish_unstake.
   * `payer` is main: a TEE wallet's build comes back as bytes to sign, which only the CLI can (its card rows),
   * so a linked payer is refused rather than moved. Dry-run first under the card's id, as Candle's own
   * CLI does (cli/src/commands/stake.ts); the staking read beside it gives the decimals and the pool wait.
   * Not limited: the CNDL stays in the wallet as sCNDL (docs.candle.tv/developers/agent-trading, "CNDL staking").
   */
  private async planStake(client: FaceClient, agent: string, tool: string, given: Record<string, unknown>, status: AgentStatus | undefined, opId: string): Promise<Planned> {
    const invalid = (message: string) => this.refuse(client, agent, tool, "INVALID_STAKE", message)
    if ((given.payer !== undefined && given.payer !== "main") || given.linkedWalletId !== undefined) {
      return this.refuse(client, agent, tool, "STAKE_FROM_EMBEDDED", "Candle's staking tools stake from the embedded wallet here. From a TEE wallet, use candle_cli with stake add, remove or finish and --wallet <the TEE wallet>: a one-press card the candle CLI signs. Nothing was sent.")
    }
    const action = tool === "candle_stake" ? "stake" : tool === "candle_unstake" ? "unstake" : "finish"
    if (action === "finish" ? typeof given.withdrawal !== "string" || given.withdrawal.length === 0 || given.withdrawal.length > 64 : typeof given.amountRaw !== "string" || !/^[1-9]\d*$/.test(given.amountRaw)) {
      return invalid(action === "finish" ? "Name the withdrawal to finish, as candle_get_staking lists it." : "amountRaw is a whole number of base units, such as \"1000000\".")
    }
    const wallet = await this.payingWallet(client, agent, tool, status, "solana")
    const params = action === "finish" ? { payer: "main", withdrawal: given.withdrawal, dryRun: false } : { payer: "main", amountRaw: given.amountRaw, dryRun: false }
    const [dry, positions] = await Promise.all([this.askCandle(client, agent, tool, { ...params, clientStakeId: opId, dryRun: true }), this.readCandle(agent, "candle_get_staking")])
    const main = (Array.isArray(positions?.wallets) ? positions.wallets : []).map(record).find((w) => w?.payer === "main" && w.address === wallet)
    const decimalsOf = (part: string) => record(main?.[part])?.decimals
    const amount = (raw: string, decimals: unknown, asset: string) => (typeof decimals === "number" ? `${grouped(fromRaw(BigInt(raw), decimals))} ${asset}` : `${raw} raw ${asset}`)
    let headline: string
    if (action === "stake") headline = `STAKE ${amount(String(params.amountRaw), decimalsOf("cndl") ?? BASE_ASSETS.CNDL.decimals, "CNDL")}`
    else if (action === "unstake") headline = `UNSTAKE ${amount(String(params.amountRaw), decimalsOf("staked"), "sCNDL")}`
    else {
      const active = record(main?.withdrawals)?.active
      const w = (Array.isArray(active) ? active : []).map(record).find((x) => x?.withdrawal === given.withdrawal)
      headline = typeof w?.amountRaw === "string" ? `FINISH UNSTAKE · ${amount(w.amountRaw, decimalsOf("cndl") ?? BASE_ASSETS.CNDL.decimals, "CNDL")}` : "FINISH UNSTAKE"
    }
    const wait = record(positions?.pool)?.withdrawalTimelockSeconds
    const required = record(dry.figures)?.requiredLamports
    const preview = [
      action !== "finish" && typeof wait === "number" ? `pool wait ${duration(wait)}${action === "unstake" ? ", then finish it" : " to unstake later"}` : undefined,
      typeof required === "string" && /^\d+$/.test(required) ? `up to ${fromRaw(BigInt(required), 9)} SOL in network fees and rent` : undefined,
    ].filter(Boolean)
    return {
      params,
      wallet,
      usd: undefined,
      title: `${headline} · embedded wallet`,
      headline,
      ...(preview.length ? { preview: preview.join(" · ") } : {}),
      resendNote: "Re-send replays it under the same clientStakeId: Candle resolves the saved transaction and never sends a second.",
    }
  }

  /**
   * Claims (docs.candle.tv/developers/claims). A fee claim dry-runs first, and one with nothing to
   * claim makes no card; it has no id, so a lost answer is the user's call, after reading the fees. A
   * staking reward claim has no dry run: the card reads the reward from the staking read, and its
   * rewardId is its idempotency key.
   */
  private async planClaim(client: FaceClient, agent: string, tool: string, given: Record<string, unknown>, status: AgentStatus | undefined): Promise<Planned> {
    const invalid = (message: string) => this.refuse(client, agent, tool, "INVALID_CLAIM", message)
    if (tool === "candle_claim_fees") {
      const mint = given.mint
      if (typeof mint !== "string" || mint.length === 0 || mint.length > 64) return invalid("Name the launched token's mint, as candle_get_fees lists it.")
      // Candle signs from the embedded wallet, which pays the network fee; the chain comes from the mint.
      const wallet = await this.payingWallet(client, agent, tool, status, mint.startsWith("0x") ? "hood" : "solana")
      const dry = await this.askCandle(client, agent, tool, { mint, dryRun: true })
      if (dry.claimable === false) {
        const why = typeof dry.reason === "string" ? terminalText(dry.reason, { maxLength: 64 }) : "no reason given"
        return this.refuse(client, agent, tool, "FEE_NOT_CLAIMABLE", `Candle's dry run says there's nothing to claim for this token now (${why}). Nothing was sent.`)
      }
      const paid = (Array.isArray(dry.claimed) ? dry.claimed : []).map(record).flatMap((c) =>
        typeof c?.amountRaw === "string" && /^\d+$/.test(c.amountRaw) && typeof c.decimals === "number" ? [`${grouped(fromRaw(BigInt(c.amountRaw), c.decimals))} ${terminalText(String(c.symbol ?? "?"), { maxLength: 12 })}`] : [],
      )
      const to = typeof dry.recipient === "string" ? ` to ${short(dry.recipient)}, the recipient fixed at launch` : ""
      return {
        params: { mint, dryRun: false },
        wallet,
        usd: undefined,
        title: `CLAIM FEES · ${short(mint)}`,
        headline: `CLAIM FEES · ${short(mint)}`,
        ...(paid.length ? { preview: `pays ≈${paid.join(" + ")}${to}` } : to ? { preview: `pays${to}` } : {}),
        resendNote: "A fee claim has no id: read candle_get_fees before re-sending. A repeat pays only what's still owed.",
      }
    }
    const rewardId = given.rewardId
    if (typeof rewardId !== "string" || rewardId.length === 0 || rewardId.length > 128) return invalid("Name the reward, as candle_get_staking lists it.")
    const positions = await this.readCandle(agent, "candle_get_staking")
    let headline = "CLAIM REWARD"
    if (positions) {
      const rewards = (Array.isArray(positions.wallets) ? positions.wallets : []).flatMap((w) => (Array.isArray(record(w)?.unclaimedRewards) ? (record(w)!.unclaimedRewards as unknown[]) : []))
      const reward = rewards.map(record).find((r) => r?.rewardId === rewardId)
      if (!reward) return this.refuse(client, agent, tool, "REWARD_NOT_FOUND", "candle_get_staking lists no unclaimed reward with that id for the wallets this key may use. Nothing was sent.")
      const symbol = typeof reward.symbol === "string" ? terminalText(reward.symbol, { maxLength: 12 }) : undefined
      if (typeof reward.amountRaw === "string" && /^\d+$/.test(reward.amountRaw) && symbol && isBaseAsset(symbol)) headline = `CLAIM REWARD · ${grouped(fromRaw(BigInt(reward.amountRaw), BASE_ASSETS[symbol].decimals))} ${symbol}`
      else if (symbol) headline = `CLAIM REWARD · ${symbol}`
    }
    return {
      params: { rewardId },
      // Candle's distributor signs and pays; the reward goes to the wallet it was recorded for.
      wallet: "none",
      usd: undefined,
      title: headline,
      headline,
      preview: "paid to the wallet the reward was recorded for; Candle pays the network fee",
      resendNote: "Re-send claims the same rewardId, which never pays twice.",
    }
  }

  /**
   * Narrowing a key's wallets through Candle's own tool: the card says which key, by its prefix, and how many
   * wallets it keeps, rather than the tool's name alone. Nothing is read.
   */
  private async planKeyWallets(client: FaceClient, agent: string, given: Record<string, unknown>): Promise<Planned> {
    const tool = "candle_set_profile_wallets"
    const invalid = (message: string) => this.refuse(client, agent, tool, "INVALID_WALLETS", message)
    if (typeof given.keyPrefix !== "string" || given.keyPrefix.length === 0 || given.keyPrefix.length > 32) return invalid("Name the key by its prefix, as candle_get_profile_wallets lists it.")
    if (!Array.isArray(given.walletIds) || given.walletIds.some((id) => typeof id !== "string")) return invalid("walletIds is the list of wallets the key keeps.")
    const n = given.walletIds.length
    const title = `LESS ACCESS · key ${terminalText(given.keyPrefix, { maxLength: 32 })} keeps ${n === 0 ? "no wallets" : `${n} wallet${n === 1 ? "" : "s"}`}`
    return { params: given, wallet: "none", usd: undefined, title, headline: title }
  }

  /** Profile edits and posts: public, on the agent's own page, and said so on the card. Nothing is read. */
  private async planPublic(client: FaceClient, agent: string, tool: string, given: Record<string, unknown>): Promise<Planned> {
    const invalid = (message: string) => this.refuse(client, agent, tool, "INVALID_POST", message)
    const base = { params: given, wallet: "none", usd: undefined }
    if (tool === "candle_create_post") {
      if (typeof given.text !== "string" || given.text.length === 0 || given.text.length > 500) return invalid("A post's text is 1 to 500 characters.")
      const text = terminalText(given.text, { maxLength: 500 })
      return {
        ...base,
        title: `POST "${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`,
        headline: "POST",
        preview: text,
        publicNote: `public: on ${agent}'s page, in its name, for anyone to read. Deleting it later still counts toward the 30 posts a day.`,
        resendNote: "A re-sent post can post twice: check the agent's page before re-sending.",
      }
    }
    if (tool === "candle_delete_post") {
      if (typeof given.postId !== "string" || given.postId.length === 0 || given.postId.length > 128) return invalid("Name the post, as candle_list_agent_posts lists it.")
      return {
        ...base,
        title: `DELETE POST ${terminalText(given.postId, { maxLength: 40 })}`,
        headline: "DELETE POST",
        preview: `post ${terminalText(given.postId, { maxLength: 40 })}`,
        publicNote: "takes the post off the page at once; it still counts toward the day's 30",
        resendNote: "Re-sending a delete is safe: a post already gone answers RECORD_NOT_FOUND.",
      }
    }
    if (tool === "candle_upload_profile_image") {
      // Server 0.10.25: fetches the image, re-hosts it on uploads.candle.tv and sets it, in one call.
      if (given.kind !== "avatar" && given.kind !== "banner") return invalid("Say which: kind avatar or banner.")
      let url: URL | undefined
      try {
        url = typeof given.imageUrl === "string" ? new URL(given.imageUrl) : undefined
      } catch {}
      if (url?.protocol !== "https:") return invalid("imageUrl is a public https address of the image itself. For a file in your research folder, upload it with candle_cli image upload first, then pass its URL to candle_update_profile.")
      const shown = terminalText(String(given.imageUrl), { maxLength: 120 })
      return {
        ...base,
        title: `PROFILE IMAGE · ${given.kind}`,
        headline: `PROFILE IMAGE · ${given.kind}`,
        preview: shown,
        publicNote: `public: Candle fetches the image and publishes it on uploads.candle.tv as ${agent}'s ${given.kind}, for anyone to see. It uses one of the 20 edits a day, shared by every key, even if the fetch fails`,
        resendNote: "A re-send fetches and sets it again, and uses another of the day's edits.",
      }
    }
    if (tool === "candle_token_edit") return this.planTokenEdit(given, base, invalid)
    const fields = Object.keys(PROFILE_FIELDS).filter((f) => f in given)
    if (fields.length === 0) return invalid(`Name at least one field to change: ${Object.keys(PROFILE_FIELDS).join(", ")}.`)
    const show = (v: unknown) => (v === null ? "cleared" : terminalText(typeof v === "string" ? v : JSON.stringify(v), { maxLength: 120 }))
    return {
      ...base,
      title: `PROFILE EDIT · ${fields.map((f) => PROFILE_FIELDS[f]).join(", ")}`,
      headline: `PROFILE EDIT · ${fields.map((f) => PROFILE_FIELDS[f]).join(", ")}`,
      preview: fields.map((f) => `${PROFILE_FIELDS[f]}: ${show(given[f])}`).join(" · "),
      publicNote: `public: changes ${agent}'s public profile, and uses one of its 20 edits a day, shared by every key`,
      resendNote: "A re-send makes the same edit again, and uses another of the day's edits.",
    }
  }

  /**
   * A creator's edit of a token's description and links (server 0.10.28). Candle checks the account
   * launched it; a re-send of the same values changes nothing and adds no version.
   */
  private async planTokenEdit(given: Record<string, unknown>, base: Pick<Planned, "params" | "wallet" | "usd">, invalid: (message: string) => Promise<never>): Promise<Planned> {
    if (given.chain !== "solana" && given.chain !== "hood") return invalid('Say the chain: "solana" or "hood".')
    if (typeof given.mint !== "string" || given.mint.length === 0) return invalid("Name the token by its mint.")
    const socials = typeof given.socials === "object" && given.socials !== null ? (given.socials as Record<string, unknown>) : {}
    const changes: [string, unknown][] = [
      ...("description" in given ? [["description", given.description] as [string, unknown]] : []),
      ...Object.entries(socials).filter(([k]) => k in TOKEN_LINKS).map(([k, v]) => [TOKEN_LINKS[k]!, v] as [string, unknown]),
    ]
    if (changes.length === 0) return invalid(`Name at least one field to change: description, or socials ${Object.keys(TOKEN_LINKS).join(", ")}.`)
    const show = (v: unknown) => (v === null || v === "" ? "removed" : terminalText(typeof v === "string" ? v : JSON.stringify(v), { maxLength: 120 }))
    return {
      ...base,
      title: `TOKEN EDIT · ${short(terminalText(given.mint, { maxLength: 64 }))} · ${changes.map(([f]) => f).join(", ")}`,
      headline: `TOKEN EDIT · ${changes.map(([f]) => f).join(", ")}`,
      preview: changes.map(([f, v]) => `${f}: ${show(v)}`).join(" · "),
      publicNote: "public: changes the token's page on Candle at once, for anyone to read. Only the account that launched it may edit it; nothing changes on chain",
      resendNote: "Re-sending the same values is safe: it changes nothing and adds no version.",
    }
  }

  /** A dry run on the agent's own MCP child, when a card is proposed: its answer, or a refusal that makes no card. */
  private async askCandle(client: FaceClient, agent: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.deps.candle) return this.refuse(client, agent, tool, "METHOD_NOT_AVAILABLE", "Dry runs aren't in this build of the core.")
    const outcome = await this.deps.candle(agent, tool, args)
    if (outcome.kind === "ok") return record(outcome.result) ?? {}
    if (outcome.kind === "lost") return this.refuse(client, agent, tool, "DRY_RUN_NO_ANSWER", "Candle didn't answer the dry run, so no card was made. Nothing was sent; try again in a moment.")
    const body = record(outcome.body)
    const error = record(record(body?.api)?.error) ?? record(body?.error)
    const said = typeof error?.message === "string" ? terminalText(error.message, { maxLength: 300 }) : typeof outcome.body === "string" ? terminalText(outcome.body, { maxLength: 300 }) : outcome.code
    return this.refuse(client, agent, tool, outcome.code, `Candle's dry run refused it: ${said}. No card was made, and nothing was sent.`)
  }

  /** A read that only fills in a card's figures: undefined when it fails. */
  private async readCandle(agent: string, tool: string): Promise<Record<string, unknown> | undefined> {
    const outcome = await this.deps.candle?.(agent, tool, {})
    return outcome?.kind === "ok" ? record(outcome.result) : undefined
  }

  /**
   * The wallet that pays, or a refusal naming the ones the agent can: a word the agent or the user gave,
   * else the agent's default. The hash binds the address.
   */
  private async paying(client: FaceClient, agent: string, tool: string, status: AgentStatus | undefined, chain: MarketInfo["chain"], word: string | undefined): Promise<{ kind: "embedded" | "tee"; address: string; label?: string }> {
    if (!status) return { kind: "embedded", address: await this.payingWallet(client, agent, tool, status, chain) }
    if (this.deps.wallets) {
      const r = this.deps.wallets.payer(agent, word, { chain })
      if (!r.ok) return this.refuse(client, agent, tool, r.code, r.message, { canPayFrom: r.canPayFrom })
      return r.kind === "tee" ? { kind: "tee", address: r.address, ...(r.label ? { label: r.label } : {}) } : { kind: "embedded", address: r.address }
    }
    if (word !== undefined && word.toLowerCase() !== "embedded") return this.refuse(client, agent, tool, "WALLET_NOT_PAYABLE", `${agent} can pay only from the embedded wallet in this build.`)
    return { kind: "embedded", address: await this.payingWallet(client, agent, tool, status, chain) }
  }

  private cliArgs(args: string[], opts: { rpcUrl?: boolean; json?: boolean } = { rpcUrl: true }): string[] {
    return this.deps.cliArgs ? this.deps.cliArgs(args, opts) : [...args, ...(opts.json === false ? [] : ["--json"])]
  }

  /** A row that runs in the prompt pane: its steps, made final, and the words for the card. */
  private planPane(request: PaneRequest): Planned {
    const params = planPane({ ...request, finalArgs: (args, o) => this.cliArgs(args, { rpcUrl: o.rpcUrl, json: o.json }) })
    return { params: {}, pane: { params, steps: paneSteps(request.row, params) }, wallet: "none", usd: undefined, title: paneTitleLine(params), headline: paneHeadline(params) }
  }

  /**
   * One of the CLI's card rows (cli-cards.ts): the paying wallet by address, the value
   * where it spends, an upload's file checked and staged. Live only.
   */
  private async planCli(client: FaceClient, agent: string, request: CliCardRequest, opId: string): Promise<Planned> {
    const tool = "candle_cli"
    const rows = this.deps.cliRows
    if (!rows) return this.refuse(client, agent, tool, "METHOD_NOT_AVAILABLE", "The CLI's card rows aren't in this build of the core.")
    const plan = await planCliRow(request, {
      agent,
      opId,
      payer: (word) =>
        this.deps.wallets?.payer(agent, word, { chain: "solana" }) ?? { ok: false, code: "WALLET_NOT_PAYABLE", message: `${agent} can pay only from the embedded wallet in this build.`, canPayFrom: [] },
      price: async (assetOrMint) => (isBaseAsset(assetOrMint) ? this.deps.pricing.asset(agent, assetOrMint) : this.deps.pricing.token(agent, "solana", assetOrMint)),
      readStaking: () => this.readCandle(agent, "candle_get_staking"),
      dryRun: (argv) => rows.dryRun(agent, this.cliArgs(argv, { rpcUrl: request.rpcUrl })),
      researchDir: rows.researchDir(agent),
      ...(rows.emptyOf ? { emptyOf: rows.emptyOf } : {}),
      stage: rows.stage,
      refuse: (code, message, details) => this.refuse(client, agent, tool, code, message, details),
    })
    return {
      params: {},
      cliRow: { row: request.row, argv: plan.argv, rpcUrl: plan.rpcUrl, ...(plan.file ? { file: plan.file } : {}) },
      ...(plan.tee ? { tee: plan.tee } : {}),
      ...(plan.side ? { side: plan.side } : {}),
      wallet: plan.wallet,
      usd: plan.usd,
      title: plan.title,
      headline: plan.headline,
      ...(plan.usd !== undefined ? { valueUsd: plan.usd } : {}),
      ...(plan.spends ? { spends: plan.spends } : {}),
      ...(plan.pricedAt !== undefined ? { pricedAt: plan.pricedAt, pricedBy: "Candle market read" } : {}),
      ...(plan.preview ? { preview: plan.preview } : {}),
      ...(plan.publicNote ? { publicNote: plan.publicNote } : {}),
      resendNote: plan.resendNote,
    }
  }

  /** The embedded wallet that pays, or a refusal: the hash needs it, and a denied key can't use it. */
  private async payingWallet(client: FaceClient, agent: string, tool: string, status: AgentStatus | undefined, chain: MarketInfo["chain"]): Promise<string> {
    if (!status) {
      return this.refuse(client, agent, tool, "AGENT_STATUS_UNKNOWN", `Couldn't read ${agent}'s wallet from Candle, so no card was made. Try again in a moment.`)
    }
    if (status.embeddedWallet === "denied") {
      const prefix = this.deps.keyPrefix(agent) ?? "<key prefix>"
      return this.refuse(
        client,
        agent,
        tool,
        "EMBEDDED_WALLET_NOT_PERMITTED",
        `${agent}'s key isn't allowed to trade from the account's embedded wallet. The owner allows it by typing this in the Candle Harness, where it runs in the prompt pane as them: candle keys update ${prefix} --embedded-wallet allow`,
      )
    }
    const wallet = chain === "hood" ? status.wallets.evm : status.wallets.solana
    if (!wallet) return this.refuse(client, agent, tool, "AGENT_WALLET_MISSING", `The account has no embedded ${chain === "hood" ? "Hood" : "Solana"} wallet for ${agent} to trade from.`)
    return wallet
  }

  private sharedWith(agent: string, wallet: string): string[] {
    return this.deps.agents().filter((other) => {
      if (other === agent) return false
      const s = this.deps.status.get(other)
      return s !== undefined && s.embeddedWallet === "allowed" && (s.wallets.solana === wallet || s.wallets.evm === wallet)
    })
  }

  /** A held key's trade, refused in Candle's words with when it lifts. Live only: paper never reaches Candle. */
  private async refuseIfHeld(client: FaceClient, agent: string, tool: string, side: Side): Promise<void> {
    if (modeFor(client, this.deps.mode()) !== "live") return
    const now = this.deps.now()
    const hold = this.deps.holds?.held(agent, now, side)
    if (hold) await this.refuse(client, agent, tool, hold.why === "stopped" ? "RISK_LIMIT_REACHED" : "KEY_LIMIT_REACHED", heldMessage(hold, now), { until: hold.until })
  }

  private async refuse(client: FaceClient, agent: string, tool: string, code: string, message: string, details: Record<string, unknown> = {}): Promise<never> {
    await this.deps.journal.append({ type: "card.refused", mode: modeFor(client, this.deps.mode()), agent, clientId: client.clientId, role: client.role, ...triggerFields(client.trigger), ...botFields(client.bot), tool, code, message })
    throw refused(code, message, details)
  }

  private async refuseApproval(card: Card, viewClientId: string, code: string, message: string): Promise<never> {
    await this.deps.journal.append({ type: "approval.refused", mode: card.mode, agent: card.agent, cardId: card.cardId, viewClientId, code })
    throw refused(code, message)
  }

  private async close(cardId: unknown, state: Exclude<CardState, "awaiting_approval" | "approved">, detail: Record<string, unknown>): Promise<Card> {
    const card = typeof cardId === "string" ? this.cards.get(cardId) : undefined
    if (card === undefined) throw refused("CARD_NOT_FOUND", "No card with that id.")
    if (!isOpen(card) || this.approving.has(card.cardId)) throw refused("CARD_NOT_AWAITING", `This card is ${card.state}.`, { state: card.state })
    card.state = state
    await this.deps.journal.append({ type: `card.${state}`, mode: card.mode, agent: card.agent, cardId: card.cardId, opId: card.opId, ...triggerFields(card.origin.trigger), ...botFields(card.origin.bot), ...detail })
    this.deps.onChange?.(card)
    this.prune()
    return card
  }
}

/** The agent's or the user's `wallet` word: undefined when none was given, null when it isn't one. */
function walletWord(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === "string" && value.trim() !== "" && value.length <= 64 ? value.trim() : null
}

/** The slippage a trade or swap runs with when the agent sets none: Candle's server's, and the CLI's on the TEE route. */
export const CANDLE_SLIPPAGE_BPS = 100
export const CLI_SLIPPAGE_BPS = 50

const percentText = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`

/** The card's slippage line, when the agent set a bound that isn't its route's default. */
export function slippageShown(kind: CardKind, planned: Pick<Planned, "params" | "tee">): Pick<CardDisplay, "slippage" | "slippageLooser" | "slippageBps"> {
  if (kind !== "trade" && kind !== "swap") return {}
  const bps = planned.params.maxSlippageBps
  const fallback = planned.tee ? CLI_SLIPPAGE_BPS : CANDLE_SLIPPAGE_BPS
  if (bps === undefined || bps === fallback) return {}
  // A bound that isn't a whole number of basis points in range fails closed: a card, never a run on a guess.
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) return { slippage: `a slippage bound that isn't a whole number of basis points from 0 to 10000, the default is ${percentText(fallback)}`, slippageLooser: true }
  return { slippage: `slippage ${percentText(bps)}, the default is ${percentText(fallback)}`, slippageBps: bps, ...(bps > fallback ? { slippageLooser: true } : {}) }
}

/** `--slippage-bps` from the agent's maxSlippageBps: undefined leaves the CLI's default (50); null isn't one. */
function slippageBps(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** candle_update_profile's fields, in the words of its description. */
const PROFILE_FIELDS: Record<string, string> = {
  publicThesis: "bio",
  publicStrategy: "strategy",
  publicStrategyNote: "strategy note",
  publicModels: "models",
  publicAvatar: "avatar",
  publicBanner: "banner",
  publicLinks: "links",
}

/** Seconds as days or hours: "7 days", "36 hours". */
function duration(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`
  const hours = Math.round(seconds / 3600)
  return hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.round(seconds / 60)} minutes`
}


/** A token edit's links (socials keys), in the card's words. */
const TOKEN_LINKS: Record<string, string> = { website: "website", twitter: "X", telegram: "telegram", discord: "discord" }

/** An operation's states before it settles. */
const UNSETTLED: ReadonlySet<string> = new Set(["submitting", "pending", "unknown"])
const ID_FIELDS = ["clientTradeId", "clientSwapId", "clientLaunchId", "clientStakeId"]
const ID_FLAGS_SENT = new Set(["--client-trade-id", "--client-stake-id"])

/** What was sent, without the id each send carries (a field, or the CLI's flag and its value): two sends of one request match. */
function sansIds(params: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(params).filter(([k]) => !ID_FIELDS.includes(k)))
  if (Array.isArray(rest.argv)) rest.argv = rest.argv.filter((a, i, all) => !ID_FLAGS_SENT.has(a as string) && !ID_FLAGS_SENT.has(all[i - 1] as string))
  return rest
}

function withoutId(args: Record<string, unknown>, idKey: IdKey): Record<string, unknown> {
  if (idKey === "coreOpId") return args
  const { [idKey]: _id, ...rest } = args
  return rest
}

/** Just the host of a link, cleaned: "x.com", or the text itself, cut, where it isn't an address. */
function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined
  try {
    return terminalText(new URL(value).host, { maxLength: 60 })
  } catch {
    return terminalText(value, { maxLength: 40 })
  }
}

/**
 * What a launch publishes besides its name and ticker, in words: each link by its host, the image's and the
 * banner's hosts, and the start of the description. They're on the token's page for good once it launches.
 */
export function launchPublishes(given: Record<string, unknown>): string | undefined {
  const socials = record(given.socials) ?? {}
  const links = Object.entries(socials).flatMap(([key, value]) => {
    const host = hostOf(value)
    return host ? [`${terminalText(key, { maxLength: 16 })} ${host}`] : []
  })
  const image = hostOf(given.imageUrl)
  const banner = hostOf(given.bannerUrl)
  const description = typeof given.description === "string" && given.description.trim() !== "" ? terminalText(given.description, { maxLength: 120 }) : undefined
  const parts = [
    links.length ? `links: ${links.join(", ")}` : undefined,
    image ? `image from ${image}` : undefined,
    banner ? `banner from ${banner}` : undefined,
    description ? `description: ${description}` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

/**
 * A launch's terms the agent set to something other than Candle's defaults, in words: who earns the fees and
 * who may buy change what the token is, so the card says them before the press.
 */
export function launchTerms(given: Record<string, unknown>): string | undefined {
  const pct = (bps: unknown) => (typeof bps === "number" && Number.isFinite(bps) ? `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%` : terminalText(String(bps), { maxLength: 16 }))
  const word = (v: unknown) => terminalText(typeof v === "string" ? v : JSON.stringify(v), { maxLength: 80 })
  const parts = [
    given.creatorFeeBps !== undefined ? `creator fee ${pct(given.creatorFeeBps)}` : undefined,
    given.stakerAllocationBps !== undefined ? `staker share ${pct(given.stakerAllocationBps)}` : undefined,
    given.mode !== undefined ? `mode ${word(given.mode)}` : undefined,
    given.visibility !== undefined && given.visibility !== "public" ? `visibility ${word(given.visibility)}` : undefined,
    given.launchRules !== undefined ? `launch rules ${word(given.launchRules)}` : undefined,
  ].filter(Boolean)
  return parts.length ? `set by the agent, not Candle's defaults: ${parts.join(" · ")}` : undefined
}
