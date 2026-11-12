// The core's tool face: `tools.list` and `tools.call`, which `candle-harness mcp` relays to an engine.
// No read key or vault, one MCP child per agent. Every call is
// classified (classify.ts) before anything runs:
//   - a read goes straight to the agent's own MCP child, and its answer is relayed as it is;
//   - a paper trade runs at once with `paper: true` and no card, journalled as `paper.call`;
//   - a card-class call becomes a card and answers APPROVAL_REQUIRED at once, never executing, unless
//     it's a trade its wallet runs without a card, when it answers with the operation;
//   - a refused call answers with its reason, and transfers are never listed.
// A write naming an operation id the core holds is a read of that card, and
// `candle_get_operation` answers from the card first.
import { type Skill, SKILL_TOOL_NAMES, skillRead } from "../engine/skills"
import { canonicalJson } from "../shared/canonical-json"
import { PANE_IDS } from "../shared/panes"
import { invalidParams } from "../shared/rpc"
import { cleanData } from "../shared/terminal-text"
import { BASE_ASSETS, type BaseAsset, isBaseAsset, notATradeToken } from "./assets"
import type { ToolOutcome } from "./candle-mcp"
import type { CliCardRequest } from "./cli-cards"
import type { PaneRequest } from "./pane-plan"
import { type CardKind, classify, CORE_CARD_TOOLS, type IdKey, type Mode, normaliseForMode, TOOL_CLASSES } from "./classify"
import { type Fill, readFill } from "./fill"
import { cutToBudget, HACC_TOOL_NAMES, PATTERNS } from "./hacc-tools"
import { HISTORY_TOOL_NAME } from "./history-tool"
import { JOURNAL_KINDS } from "./journal-query"
import { LIMITS_TOOL_NAME, narrowingArgs, narrows } from "./limits-tool"
import { PNL_TOOL_NAME } from "./pnl-tool"
import { TRIGGERS_TOOL_NAME, type TriggerSpec, type TriggersOutcome } from "./triggers-tool"
import { BOTS_TOOL_NAME, type BotSpec, type BotsOutcome } from "./bots-tool"
import type { Journal } from "./journal"
import { RESEARCH_TOOL_NAMES } from "./research-tools"
import { PAPER_CLOSED_WORDS } from "./trade-log"
import { type SizingDeps, sizeInUsd } from "./sizing"
import { type ChainSlug, maybeChain } from "../shared/chains"

export interface ToolResult {
  content: { type: "text"; text: string }[]
  isError?: boolean
}

/** A harness reads only its own agent's cards; a view, the person's, reads any. */
const ownCard = (client: FaceClient, card: { agent: string }): boolean => client.role !== "harness" || card.agent === client.agent

export interface FaceClient {
  clientId: string
  /**
   * "core": the core's own client, proposing a trigger's command when it fires, or a bot's trade. "build": a Build
   * pane's harness, proposing a code bot's card.
   */
  role: "view" | "harness" | "core" | "build"
  /** The agent this client acts as: a harness acts as the active agent of its turn. */
  agent: string
  /** A harness's token, which names the turn it was minted for. */
  tokenId?: string
  /** The trigger whose firing this is, on the core's own client. */
  trigger?: TriggerOrigin
  /** The rules bot whose trade this is, on the core's own client. */
  bot?: BotOrigin
}

/** A trigger's firing, carried on each card, row and paper trade it causes. */
export interface TriggerOrigin {
  name: string
  /** The firing, by its `trigger.fired` row's id. */
  fireId: string
  /** Which part of its line: 0 for a single trade. */
  part: number
  /** The trigger's own mode, approved on its card: its trades go as paper or live whatever the Candle Harness's mode is. */
  mode?: Mode
}

/**
 * A bot's trade, carried on the card and the paper trade it causes, so its own book (bot-book.ts) finds its fills in
 * the journal. Only the core sets it (bot-trades.ts `botClient`).
 */
export interface BotOrigin {
  name: string
  /** A rules bot or a code bot. Absent on a rules bot's, as every row before code bots: read as a rules bot. */
  kind?: "rules" | "code"
  /** A code bot's own id for the trade it asked for: read back by it, never sent twice. */
  request?: string
  /** An entry, or an exit from one of its positions. */
  act: "entry" | "exit"
  /** An exit's position, by its entry's id. */
  position?: string
  /** An entry's signal, by Hacc's id. */
  signal?: number
  /** An exit's reason: take profit, stop, max hold, trailing, flatten. */
  reason?: string
  /** An exit's tokens the wallet no longer held, raw: sold outside the bot. */
  outside?: string
  /** The bot's own mode, approved on its card: its trades go as paper or live whatever the Candle Harness's mode is. */
  mode?: Mode
  /** The slippage bound the bot was approved with, where it has one: inside the wallet's figures its trades run at it with no card. */
  slippageBps?: number
  /** A code bot's sell of part of a position: the position stays open with what's left. */
  partial?: true
  /** What a code bot's sell sells of its position, raw, where it sells by amount: a paper fill doesn't say. */
  sellsRaw?: string
}

/**
 * The mode a call goes in: a bot's or a trigger's own, set on its card, for the core's own client proposing its
 * trade; the Candle Harness's for everything else. Only the core sets a client's bot or trigger, so no harness or
 * view can pick a mode this way.
 */
export const modeFor = (client: Pick<FaceClient, "role" | "bot"> & { trigger?: Pick<TriggerOrigin, "mode"> }, harnessMode: Mode): Mode =>
  client.role === "core" ? (client.bot?.mode ?? client.trigger?.mode ?? harnessMode) : harnessMode

/** A bot's trade on the rows it causes. */
export const botFields = (b: BotOrigin | undefined): Record<string, unknown> =>
  b
    ? {
        bot: b.name,
        botAct: b.act,
        ...(b.position ? { botPosition: b.position } : {}),
        ...(b.signal !== undefined ? { botSignal: b.signal } : {}),
        ...(b.reason ? { botReason: b.reason } : {}),
        ...(b.outside ? { botOutside: b.outside } : {}),
        // A rules bot's rows read as they always have: only a code bot's say its kind.
        ...(b.kind === "code" ? { botKind: "code" } : {}),
        ...(b.request ? { botRequest: b.request } : {}),
        ...(b.partial ? { botPartial: true } : {}),
        ...(b.sellsRaw ? { botSellsRaw: b.sellsRaw } : {}),
      }
    : {}

/** Who a card or a row is from: the person in a view, an agent's harness, a trigger, or a bot. */
export type Source = "person" | "agent" | "trigger" | "bot" | "build"
export const sourceOf = (client: Pick<FaceClient, "role" | "trigger" | "bot">): Source => (client.trigger ? "trigger" : client.bot ? "bot" : client.role === "view" ? "person" : client.role === "build" ? "build" : "agent")

/**
 * A trigger's firing on the rows it causes: its name as `trigger` (so an `on fill` or `on card expired`
 * trigger never fires on its own rows), the firing and the part.
 */
export const triggerFields = (t: TriggerOrigin | undefined): Record<string, unknown> => (t ? { trigger: t.name, fireId: t.fireId, part: t.part } : {})

/** A harness's row in a turn a trigger woke: that trigger's name, as `woken`. */
const wokenField = (client: FaceClient, wokenBy: ((tokenId: string) => string | undefined) | undefined): Record<string, unknown> => {
  const name = client.role === "harness" && client.tokenId ? wokenBy?.(client.tokenId) : undefined
  return name ? { woken: name } : {}
}

export type CardState = "awaiting_approval" | "approved" | "rejected" | "withdrawn" | "expired"
export type OperationState = "submitting" | "pending" | "succeeded" | "failed" | "refused" | "unknown" | "abandoned"

/** What the face needs to know of a card (cards.ts holds the rest). */
export interface CardView {
  cardId: string
  opId: string
  idKey: IdKey
  kind: CardKind
  tool: string
  /** The arguments as the proposer gave them, before the core normalised them and minted the id. */
  asked: Record<string, unknown>
  agent: string
  /** The chain it acts on: a trade's, a swap's, a launch's; none for a card about no chain. */
  chain?: ChainSlug
  state: CardState
  expiresAt: string
  /**
   * `paper`: a live sell Candle answered by closing the key's paper position, the live wallet holding none.
   * `partial`: a swap whose first leg landed, with its hash, and whose second failed.
   */
  operation?: { state: OperationState; result?: unknown; error?: unknown; paper?: boolean; partial?: { leg1: string } }
  /** It ran without a card, inside its wallet's limits, in words. */
  withoutCard?: string
  /** A trade on a wallet that trades inside limits that is a card all the same, and why. */
  cardBecause?: string
  /** Paper or live, as the card was made: said in its answer, so the agent knows which it asked for. */
  mode?: Mode
}

export interface CardDesk {
  held(opId: string): CardView | undefined
  /** Proposes a card; throws an RpcError refusal (limits, an unresolved mint, too many cards). */
  propose(input: {
    client: FaceClient
    agent: string
    tool: string
    args: Record<string, unknown>
    params: Record<string, unknown>
    kind: CardKind
    idKey: IdKey
    reason?: string
    /** For a trigger's card: what its firing saw, in words ("JUPF was $0.3990, under $0.40"). */
    fired?: string
    /** The card's title, for kinds the card book doesn't title itself. */
    title?: string
    /** A line the user should read before the press, such as a TEE wallet a revoke would strand. */
    warning?: string
    /** Chips that put a command on the input line, such as rebinding a wallet a revoke would strand. */
    fills?: { label: string; line: string }[]
    /** One of the CLI's card rows, which the card book plans itself. */
    cli?: CliCardRequest
    /** A row that runs in the prompt pane, which the card book plans itself. */
    pane?: PaneRequest
    /** A trigger's card: its exact line, its words, how it runs, and the wallet that pays. */
    triggerCard?: { spec: TriggerSpec; paysFrom?: string }
    /** A rules bot's card: the bot in words, its definition, how it runs, the wallet that pays and its own slippage. */
    botCard?: { spec: BotSpec; paysFrom?: string; slippage?: { words: string; looser: boolean } }
  }): Promise<CardView>
  /** A trade card just proposed, run at once by the core when its wallet's rule says so. */
  runWithoutCard?(card: CardView, client: FaceClient): Promise<{ card: CardView }>
  /** Withdraws an open card of this client's. */
  withdraw?(clientId: string, cardId: string): Promise<unknown>
}

export interface AgentChildren {
  for(agent: string): { call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> }
}

const text = (body: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
})

const refusal = (code: string, message: string, extra: Record<string, unknown> = {}): ToolResult =>
  text({ success: false, error: { code, message }, ...extra }, true)

/** Said to a call of a turn that was stopped, wherever it's caught. */
export const TURN_ENDED_WORDS = "This turn was stopped, so nothing more of it runs. Nothing was sent."

const PAPER_NOTE = { type: "text" as const, text: JSON.stringify({ mode: "paper", note: "Paper trade: nothing was broadcast and no funds moved." }) }
const paperNote = (usd: string) => ({ type: "text" as const, text: JSON.stringify({ mode: "paper", valueUsd: usd, note: `Paper trade: nothing was broadcast and no funds moved. The pair asset's side is worth about $${usd} at its current price; say it in dollars.` }) })

/**
 * A paper fill's pair-asset side in dollars, from Candle's answer (a buy spends `amountRaw`, a sell gets
 * `expectedOutRaw`, both in `quoteAsset`) and the asset's current price; undefined where any of it is missing.
 */
export async function paperDollars(agent: string, text: string | undefined, pricing: { asset(agent: string, asset: BaseAsset): Promise<{ usd: number } | undefined> }): Promise<string | undefined> {
  let api: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(text ?? "") as { api?: Record<string, unknown> }
    api = parsed.api
  } catch {
    return undefined
  }
  if (!api || api.paper !== true) return undefined
  const asset = typeof api.quoteAsset === "string" ? api.quoteAsset.toUpperCase() : undefined
  if (!isBaseAsset(asset)) return undefined
  const raw = api.side === "buy" ? api.amountRaw : api.side === "sell" ? api.expectedOutRaw : undefined
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined
  const point = await pricing.asset(agent, asset).catch(() => undefined)
  if (!point || !Number.isFinite(point.usd) || point.usd <= 0) return undefined
  const usd = (Number(raw) / 10 ** BASE_ASSETS[asset].decimals) * point.usd
  return usd >= 0.01 ? usd.toFixed(2) : usd.toPrecision(2)
}

/** A paper trade's fill from Candle's answer text, or undefined where it doesn't read. */
function paperFill(text: string | undefined): Fill | undefined {
  try {
    return readFill({ wallet: "paper", result: JSON.parse(text ?? ""), paper: true })
  } catch {
    return undefined
  }
}

// One rule wherever a waiting card is spoken of: no turn sees the press, so the turn ends on the proposal.
// An agent told to "read the outcome" reads it again and again inside the turn, and nothing changes there.
const NEXT_PENDING = (kind: string, idKey: string) =>
  `The user approves this in the Candle Harness with one key press, which no turn of yours sees. Say what you proposed and end your turn now: don't wait, and don't read it again to see. Read candle_get_operation with this id (kind: ${kind}) only when a later message asks how it went. Never send it again under a new id; to retry, send the same request with the same ${idKey}.`
const NEXT_FINAL = "Final. Don't propose this again unless the user asks."
const NEXT_UNKNOWN = "Don't propose this again; the user is resolving it in the Candle Harness."

/** The answer for a card and its operation, in whatever state they are. */
export function cardAnswer(card: CardView): ToolResult {
  // How it was approved, when the core ran it without a card: the person didn't press anything.
  const ids = { cardId: card.cardId, [card.idKey]: card.opId, opId: card.opId, kind: card.kind, agent: card.agent, ...(card.mode ? { mode: card.mode } : {}), ...(card.withoutCard ? { approved: card.withoutCard } : {}) }
  // Candle's own result and error carry text anyone can write (a token's name): cleaned as drawn text is.
  const op = card.operation ? { ...card.operation, result: cleanData(card.operation.result), error: cleanData(card.operation.error) as NonNullable<CardView["operation"]>["error"] } : undefined
  if (op === undefined) {
    if (card.state === "awaiting_approval") {
      return text({
        success: false,
        error: { code: "APPROVAL_REQUIRED", message: "A card awaits the user's approval. This isn't a refusal and isn't a failure." },
        ...ids,
        state: card.state,
        expiresAt: card.expiresAt,
        // Why a trade on a wallet that trades inside limits is a card all the same.
        ...(card.cardBecause ? { why: card.cardBecause } : {}),
        next: NEXT_PENDING(card.kind, card.idKey),
      })
    }
    return text({ success: false, error: { code: `CARD_${card.state.toUpperCase()}`, message: `The card was ${card.state}.` }, ...ids, state: card.state, next: NEXT_FINAL })
  }
  if (op.state === "succeeded" && op.paper) return text({ success: true, ...ids, state: op.state, paperClosed: true, note: `Nothing live was sold: ${PAPER_CLOSED_WORDS}. The live tokens, if any are held elsewhere, are still held.`, result: op.result ?? null })
  if (op.state === "succeeded") return text({ success: true, ...ids, state: op.state, result: op.result ?? null })
  if (op.state === "submitting" || op.state === "pending") {
    return text({ success: false, error: { code: "OPERATION_PENDING", message: "Approved and running." }, ...ids, state: op.state, next: `It settles in seconds. Read it once more with candle_get_operation (kind: ${card.kind}); if it's still running then, say so and end your turn.` })
  }
  if (op.state === "failed" || op.state === "refused") {
    return text({ success: false, error: op.error ?? { code: op.state.toUpperCase(), message: op.state }, ...ids, state: op.state, result: op.result ?? null, next: NEXT_FINAL }, true)
  }
  return text({
    success: false,
    error: { code: "OUTCOME_UNKNOWN", message: "Candle couldn't confirm this. It isn't proof that nothing moved." },
    ...ids,
    state: op.state,
    next: op.state === "unknown" ? NEXT_UNKNOWN : NEXT_FINAL,
  })
}

/** A child's outcome as the face's answer. */
/**
 * How much of a Candle answer reaches the agent. Candle's reads come whole, and a harness refuses one too big
 * to read (a token's events did): past this, rows are cut from the end, and the answer says how many it kept.
 * It's above every answer recorded from Candle, so a usual read is never cut.
 */
export const CANDLE_ANSWER_BUDGET = 48 * 1024

/** A Candle answer cut to the budget, its rows first: in `data`, where Candle puts them, else at the top. */
export function candleFits(result: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(result ?? null)) <= CANDLE_ANSWER_BUDGET) return result
  const top = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined
  const inner = top?.data && typeof top.data === "object" && !Array.isArray(top.data) ? top.data : undefined
  const more = () => "For more, ask again with the tool's own limit or a narrower filter, where it takes one."
  if (top && inner) return cutToBudget((d, cut) => ({ ...top, data: d, ...(cut ? { cut } : {}) }), inner, undefined, CANDLE_ANSWER_BUDGET, more)
  return cutToBudget((d, cut) => (cut ? { cut, data: d } : (d as Record<string, unknown>)), result, undefined, CANDLE_ANSWER_BUDGET, more)
}

// Candle's answers reach an agent cleaned as drawn text is: a token's name or description is anyone's to
// write, and an invisible or direction character in one would be read by the agent and never seen by the person.
function relay(outcome: ToolOutcome): ToolResult {
  if (outcome.kind === "ok") return text(cleanData(candleFits(outcome.result)))
  if (outcome.kind === "error") return text(cleanData(outcome.body ?? { success: false, error: { code: outcome.code } }), true)
  return refusal("CANDLE_NO_ANSWER", `Candle didn't answer (${outcome.reason.replace("_", " ")}). Read it again before assuming anything.`)
}

/**
 * A number the model sent as text ("15") made a number where Candle's schema asks for one. Some harnesses
 * (OpenCode) pass the model's text through as it came, and Candle's server refuses a string for a number.
 */
export function numbersFromText(args: Record<string, unknown>, schema: { properties?: Record<string, unknown> } | undefined): Record<string, unknown> {
  const props = schema?.properties
  if (!props) return args
  let out: Record<string, unknown> | undefined
  for (const [k, v] of Object.entries(args)) {
    const type = (props[k] as { type?: unknown } | undefined)?.type
    const wantsNumber = type === "integer" || type === "number"
    if (!wantsNumber || typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v.trim())) continue
    const n = Number(v.trim())
    if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) continue
    out ??= { ...args }
    out[k] = n
  }
  return out ?? args
}

/** What the agent is offered: the child's tools, with Candle's own schemas, less what the core refuses. */
export function offeredTools<T extends { name: string }>(childTools: readonly T[]): T[] {
  return childTools.filter((tool) => {
    const known = Object.hasOwn(TOOL_CLASSES, tool.name) ? TOOL_CLASSES[tool.name] : undefined
    return known === undefined || known.class !== "refused"
  })
}

/**
 * What's on the person's screen, said on the tool the agent reaches for when asked to see
 * it, so the screen follows too: Pi on Haiku 5.5 read Final Stretch and stayed on Trade, and found a sell
 * with harness_history without showing the Journal, though harness_view's own description says so. Only where
 * harness_view is offered.
 */
const SCREEN_NOTES: Readonly<Record<string, string>> = {
  candle_get_feed:
    ' The person\'s Trending tab shows these four lists live. When they ask to see one, also switch the screen to it with harness_view (action "tab", pane "new", "graduated", "feed" for On Fire, or "final-stretch"), and keep your answer short: it\'s on their screen.',
  harness_history:
    ' When the person asks to find something in their journal, also put the search on their screen with harness_view (action "journal", search): their Journal holds every agent\'s rows and live trades too.',
}
export function withScreenNotes<T extends { name: string; description?: string }>(tools: readonly T[], viewOffered: boolean): T[] {
  if (!viewOffered) return [...tools]
  return tools.map((t) => (Object.hasOwn(SCREEN_NOTES, t.name) ? { ...t, description: `${t.description ?? ""}${SCREEN_NOTES[t.name]}` } : t))
}

/**
 * The agent's own key prefix, on every Candle tool that takes one: the agent may know it.
 * Live, Claude Code guessed its prefix for candle_get_profile_trades and Candle answered an empty book, as it
 * does for any prefix it doesn't know.
 */
export function withOwnPrefix<T extends { inputSchema: { type: "object"; properties?: Record<string, unknown> } }>(tools: readonly T[], prefix: string | undefined): T[] {
  if (!prefix) return [...tools]
  return tools.map((tool) => {
    const property = tool.inputSchema.properties?.keyPrefix
    if (property === null || typeof property !== "object") return tool
    const said = (property as { description?: unknown }).description
    const description = `${typeof said === "string" ? `${said}. ` : ""}Your own key's prefix is ${prefix}. Candle answers a prefix it doesn't know with an empty result, so never guess one.`
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, keyPrefix: { ...property, description } } } }
  })
}

/** The tools whose calls can become a card: offered with an optional `reason`, shown on the card. */
// The core's own card tools (candle_bridge) take a reason the same way.
const REASON_TOOLS = new Set([...Object.entries(TOOL_CLASSES).filter(([, c]) => c.class === "card").map(([name]) => name), ...Object.keys(CORE_CARD_TOOLS)])
const REASON_PROPERTY = { type: "string", description: "Why, in a sentence or two. It's shown to the user on the approval card. At most 500 characters." }

const WALLET_PROPERTY = {
  type: "string",
  description:
    'Which wallet pays: "embedded" (the account\'s embedded wallet), or a TEE wallet bound to your key, by its label or address, on the token\'s chain. Left out, your default for that chain applies. A TEE wallet\'s trade runs through the user\'s candle CLI on the same one-press card. Live only: TEE wallets have no paper form.',
}

const AMOUNT_USD_PROPERTY = {
  type: "string",
  description:
    'Buys only, instead of amount: how many US dollars to spend, such as "25". The Candle Harness converts it at the current price into the asset the buy spends (the token\'s own pair asset for a Candle-launched token, else quoteAsset, else the user\'s chosen spend asset), and the card shows both.',
}

/**
 * Adds the Candle Harness's own fields to the card tools' schemas: an optional `reason` on each, `amountUsd` on
 * candle_trade (sizing.ts), and `wallet` on candle_trade and candle_swap. Candle never
 * sees any of them: the face and the card book take them off. candle_get_operation is offered with
 * every kind the face reads.
 */
export function withReason<T extends { name: string; inputSchema: { type: "object"; properties?: Record<string, unknown> } }>(tools: readonly T[]): T[] {
  return tools.map((tool) => {
    if (tool.name === "candle_get_operation") {
      const kind = tool.inputSchema.properties?.kind
      if (kind === null || typeof kind !== "object") return tool
      return { ...tool, description: GET_OPERATION_DESCRIPTION, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, kind: { ...kind, enum: [...OPERATION_KINDS] } } } }
    }
    if (!REASON_TOOLS.has(tool.name)) return tool
    const properties = { ...tool.inputSchema.properties }
    properties.reason ??= REASON_PROPERTY
    if (tool.name === "candle_trade") properties.amountUsd ??= AMOUNT_USD_PROPERTY
    if (tool.name === "candle_trade" || tool.name === "candle_swap") properties.wallet ??= WALLET_PROPERTY
    // What the Candle Harness sets or refuses itself is never offered: the mode decides paper, and a card is the quote.
    for (const dropped of NOT_OFFERED[tool.name] ?? []) delete properties[dropped]
    const said = (tool as { description?: unknown }).description
    const note = HARNESS_NOTES[tool.name]
    return { ...tool, ...(note ? { description: `${typeof said === "string" ? `${said}\n\n` : ""}${note}` } : {}), inputSchema: { ...tool.inputSchema, properties } }
  })
}

/** Arguments of Candle's the agent isn't offered here: the Candle Harness's mode decides paper, and it never builds a trade to spend later. */
const NOT_OFFERED: Readonly<Record<string, readonly string[]>> = { candle_trade: ["paper", "deferExecution"] }

/**
 * Candle's own descriptions are written for a client that calls its server directly. Where the Candle Harness
 * answers another way, the agent is told so on the tool itself: these go after Candle's words, and say which
 * of them don't hold here.
 */
const HARNESS_NOTES: Readonly<Record<string, string>> = {
  candle_trade:
    'In the Candle Harness, where this differs from the above: a live trade answers APPROVAL_REQUIRED with a card for the user to approve (or runs at once where the paying wallet trades inside its limits, and says so), so read its outcome with candle_get_operation. The wallet that pays is the agent\'s default, or the one `wallet` names, which may be a TEE wallet. A sell names `percent` (1 to 100) or `amount`: leaving both out is refused, never the whole position. Paper or live is the Candle Harness\'s mode, set by the user: there is no `paper` argument, and don\'t suggest a paper rehearsal unless the user asks for one.',
  candle_swap:
    'In the Candle Harness, where this differs from the above: a swap answers APPROVAL_REQUIRED with a card for the user to approve (or runs at once where the paying wallet trades inside its limits, and says so), so read its outcome with candle_get_operation (kind: swap) rather than sending it again. The wallet that pays is the agent\'s default, or the one `wallet` names, which may be a TEE wallet. A pair spanning both chains (a bridge) is refused here: use candle_bridge, from any wallet.',
}

/**
 * candle_get_operation as this face answers it. Candle's own description names its server's states
 * (`confirmed`, `built`, a swap's `job.outcome`), none of which an agent sees here for a card the core holds.
 */
export const GET_OPERATION_DESCRIPTION = `Look up what became of a trade, swap, launch or any other card by the id its call answered with. Reads only; moves nothing.

In the Candle Harness a write becomes an approval card first, so the answers are the Candle Harness's own. The next move for each:
- error.code APPROVAL_REQUIRED, state awaiting_approval: the card waits for the user's key press. Not a failure. Read again later; never send the write again.
- error.code OPERATION_PENDING, state submitting or pending: approved and running. Read again.
- success true, state succeeded: done. \`result\` is Candle's answer.
- state failed or refused: final. \`error\` says why.
- error.code CARD_REJECTED, CARD_EXPIRED or CARD_WITHDRAWN: the card ended without running. Final: don't propose it again unless the user asks.
- error.code OUTCOME_UNKNOWN: Candle couldn't confirm it, which isn't proof that nothing moved. The user resolves it in the Candle Harness: don't propose it again.

Pass \`clientId\`, the id the write's answer gave, and \`kind\`, the kind that answer gave. Every card the Candle Harness holds is read here, a swap included. A trade or a launch it doesn't hold is read from Candle. A swap it doesn't hold can't be read by its id (OPERATION_NOT_HELD). Never send a write under a new id to find out what happened: a new id is a second trade, swap or launch.`

/**
 * The words of Candle's own descriptions that the notes above answer. A recorded description that stops saying
 * one of them means Candle changed its story, and the note beside it is due a fresh read.
 */
export const DESCRIPTION_BASIS: Readonly<Record<string, readonly string[]>> = {
  candle_get_operation: ["`confirmed`/`failed`", "`built`/`submitted`", "job.outcome", "Do NOT re-send the write"],
  candle_trade: ["the payer is the account's embedded (main) wallet", "Omitting the amount on a sell sells the whole position", "Pass `paper: true` to rehearse"],
  candle_swap: ["This tool spends the embedded wallets", "send the SAME request with that id", "A pair spanning both is a BRIDGE"],
}

/**
 * The kinds `candle_get_operation` takes on this face: Candle's two, plus the cards the core holds of
 * every other kind, the CLI's card rows included (without them the agent couldn't read an upload's
 * URL or a less-access result). Only a trade or a launch the core doesn't hold is read from Candle.
 */
const OPERATION_KINDS = ["trade", "launch", "swap", "bridge", "stake", "claim", "public", "upload", "lessaccess", "lp", "close", "perps", "hacc", "autonomy", "trigger", "bot"]
const CANDLE_READS = new Set(["trade", "launch"])

/**
 * The Candle Harness's own tool for what the Wallets and Positions panes show. It changes
 * the view only, so it's no card and spends nothing; the core checks the names and journals the change.
 */
export const SHOW_WALLETS_TOOL = {
  name: "harness_show_wallets",
  description:
    'Changes which wallets the person\'s Wallets and Positions panes show, when they ask. "active": wallets a Candle Harness agent can pay from that Candle hasn\'t stopped (the default). "all": every wallet on the account. "group:<name>": the wallets in one of the person\'s groups. Or a list naming wallets by "embedded", a TEE wallet\'s label, or an address. It only changes what is shown: paying, limits and every other tool are unchanged, and a hidden wallet still pays.',
  inputSchema: {
    type: "object" as const,
    properties: {
      show: {
        description: '"active", "all", "group:<name>", or a list of wallets by "embedded", label or address.',
        anyOf: [{ type: "string", enum: ["active", "all"] }, { type: "string", pattern: "^group:[A-Za-z0-9][A-Za-z0-9._-]{0,31}$" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }],
      },
    },
    required: ["show"],
  },
}

/**
 * Naming wallets, when the person asks. A name the Candle Harness keeps changes at once,
 * with an undo under the reply (as for tabs); one Candle or the vault keeps is a card for the pane.
 */
export const NAME_WALLETS_TOOL = {
  name: "harness_name_wallets",
  description:
    "Names wallets when the person asks: the embedded wallet, a TEE wallet, an imported wallet, a vault key or a destination, each given by its address or its current name. A name follows Candle's rule (at most 64 characters, no space at either end, no leading \"-\") and must be unique; it's never \"embedded\", an agent's name, or shaped like an address. A name the Candle Harness keeps (the embedded wallet, a destination) changes at once, and the person can undo it under your reply. A TEE or imported wallet's name is Candle's, and a vault key's is the vault's: renaming one is a card the person approves and then confirms in a pane you can't see. Several at once go as one step. A name never changes which wallet pays.",
  inputSchema: {
    type: "object" as const,
    properties: {
      names: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: {
          type: "object",
          properties: { wallet: { type: "string", description: "The wallet: its address, or its name now." }, name: { type: "string", description: "Its new name, exactly as it should read." } },
          required: ["wallet", "name"],
        },
      },
    },
    required: ["names"],
  },
}

/**
 * Wallet groups, when the person asks: a group organises the panes and
 * never pays or sets anything, so a change is made at once, with an undo under the reply.
 */
export const GROUP_WALLETS_TOOL = {
  name: "harness_group_wallets",
  description:
    "Groups wallets when the person asks, to organise the Wallets pane and the approvals menu. A group is one word (letters, digits, '.', '_', '-'), never a wallet's or an agent's name. Give exactly one of: add or remove (wallets by name or address), prefix (every wallet whose name starts with it, now and later, as Candle's bot-*; null drops it), or delete: true. It's made at once, and the person can undo it under your reply. A group never pays and never sets a wallet's approvals: a trade still names one wallet.",
  inputSchema: {
    type: "object" as const,
    properties: {
      group: { type: "string", description: "The group's name." },
      add: { type: "array", minItems: 1, maxItems: 256, items: { type: "string" }, description: "Wallets to put in it, by name or address. A new group is made." },
      remove: { type: "array", minItems: 1, maxItems: 256, items: { type: "string" }, description: "Wallets to take out of it." },
      prefix: { type: ["string", "null"], description: "The start of the names it takes in, such as bot-; null drops it." },
      delete: { type: "boolean", description: "true removes the group (its wallets are untouched)." },
    },
    required: ["group"],
  },
}

/**
 * The Candle Harness's own tool for the screen: which tab and layout show, a layout
 * changed or built for the person, tabs added, renamed or removed, a token pane pinned, a theme picked or
 * made. A view makes the change (core/view-asks.ts) and says what it did. It touches only the screen: it
 * never moves focus, pops a pane out, trades or spends. A changed layout is a preview the person keeps or
 * discards with a click, and a theme it makes is used at once with an undo.
 */
export const VIEW_TOOL = {
  name: "harness_view",
  // Rarely used (set up once and forgotten), so it's said here and in the harness-view skill, never in the prompt.
  description:
    'Changes what the person\'s Candle Harness shows (tabs, layouts, pinned token panes, Signals\' filters, the Journal\'s search, the theme), only when they ask; it touches nothing but the screen. ' +
    'The tabs: Trade and Cockpit (you and the token), Trending (Candle\'s New, Graduated, On Fire and Final Stretch lists), Signals (Hacc\'s tape, filtered), P&L, Research (one token in depth), Journal (everything recorded, searched) and Perps; "read" gives theirs. ' +
    'Before building a layout or making a theme, read the harness-view skill with skill_read, then "read" the screen. ' +
    'Switching to a tab (or the tab with a pane: "tab" with pane "final-stretch"), layout or theme that exists, pins, "signals" and "journal" happen at once; prefer switching to a tab that already shows what they ask for. ' +
    'When they ask to see something a tab shows ("show me final stretch", "my P&L", "the journal"), switch to it, then answer in a line or two rather than repeat the list. ' +
    'Asked for an answer in your reply (a table, a list, a summary of what\'s on fire), give it there and leave the screen as it is. ' +
    '"open", "close" and "build" change a layout as a preview: the person keeps it with a click, so say so, and never that it\'s saved. ' +
    'Tab changes (show_tab and hide_tab tick a tab on or off the tab bar) and a theme you make happen at once, with an undo for them under your reply.',
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["read", "tab", "layout", "open", "close", "build", "add_tab", "rename_tab", "remove_tab", "show_tab", "hide_tab", "pin", "unpin", "signals", "chain", "journal", "theme", "make_theme"] },
      tab: { type: "string", description: "The tab's name; left out, the tab on screen (for \"signals\" and \"journal\", else the tab named after the pane, else the first with it). For \"tab\", the tab to switch to (or its number, 1 to 9)." },
      layout: { type: "string", description: "\"layout\" and \"add_tab\": a layout's name, such as \"Cockpit\"." },
      pane: { type: "string", description: `"open" and "close": a pane's id (${PANE_IDS.join(", ")}; token:2 and token:3 are more token panes, to compare tokens side by side). "tab": a pane to show, on the tab named or the first tab that has it. "pin" and "unpin": which token pane; left out, the first.` },
      near: { type: "string", description: "\"open\": the pane to open it beside; left out, at the end." },
      root: { type: "array", description: "\"build\": the tree, as layouts.toml writes one: [\"row\", [\"column\", 62, \"feed 40\", \"token 60\"], \"agent 38\"]. Each pane once." },
      name: { type: "string", description: "\"build\": the name the layout is kept as, if kept. \"add_tab\" and \"rename_tab\": the tab's new name (1 to 20 characters). \"theme\" and \"make_theme\": the theme's name." },
      mint: { type: "string", description: "\"pin\": the token to pin; left out, the token the tab's token pane shows." },
      mine: { type: "boolean", description: "\"signals\": true for the person's own rules' signals, false for Hacc's tape." },
      pattern: { type: "string", enum: [...PATTERNS, "all"], description: "\"signals\": only this pattern on Hacc's tape (kol_mention: a KOL posting about a token, with a buy); \"all\" clears it." },
      chain: { type: "string", enum: ["solana", "hood", "all", "both"], description: "\"chain\": the chain every pane shows, or \"all\" (wallets on two chains). \"signals\" (one chain): only its tokens; \"both\" clears it." },
      paused: { type: "boolean", description: "\"signals\": true holds the tape where it is, false resumes at the newest." },
      search: { type: "string", description: "\"journal\": the words a row must all hold, such as \"JUP sell\" or an agent's name; \"\" shows everything." },
      kinds: { type: "array", items: { type: "string", enum: [...JOURNAL_KINDS] }, description: "\"journal\": only rows of these kinds; left out, every kind but the core's." },
      base: { type: "string", enum: ["Candle dark", "Candle light"], description: "\"make_theme\": the theme it starts from." },
      colours: { type: "object", additionalProperties: { type: "string" }, description: "\"make_theme\": the colours it changes, by name, each \"#rrggbb\" (see the harness-view skill)." },
      reply: { type: "object", additionalProperties: { type: "string" }, description: "\"make_theme\": the reply's colours (heading, bright, dim, code, quote)." },
    },
    required: ["action"],
  },
}
const VIEW_ACTIONS = new Set(VIEW_TOOL.inputSchema.properties.action.enum)
/** An ask the view is sent is small: a tree or a theme's colours, never more. */
const VIEW_ARGS_MAX = 8 * 1024

export class ToolFace {
  constructor(
    private readonly deps: {
      pool: AgentChildren
      /** Candle's own schema for a tool, as its server lists it to this agent; numbers sent as text are made numbers by it. */
      schemaOf?: (agent: string, tool: string) => { properties?: Record<string, unknown> } | undefined
      cards: CardDesk
      journal: Journal
      mode: () => Mode
      /** For a paper buy sized in dollars: converted here, since paper trades never become cards. */
      sizing?: SizingDeps
      /** The trigger that woke the agent's turn a harness token was minted for, if one did: a paper trade in it says so. */
      wokenBy?: (tokenId: string) => string | undefined
      /**
       * Where the turn a harness token was minted for stands: stopped or over, and the mode it began in. Undefined
       * for a harness with no turn (one registered on its own), which is never held to either.
       */
      turn?: (tokenId: string) => { ended: boolean; mode?: Mode } | undefined
      /** candle_cli, answered by the core rather than Candle's MCP server. */
      cli?: { call(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<ToolResult> }
      /** Whether a wallet word names the account's embedded wallet for this agent ("embedded", or its own name). */
      isEmbedded?: (agent: string, word: string) => boolean
      /** harness_name_wallets: names written at once, or cards for the pane. */
      nameWallets?: (client: FaceClient, asks: { wallet: string; name: string }[], reason?: string) => Promise<ToolResult>
      /** harness_group_wallets: a group changed at once, with an undo for the person. */
      groupWallets?: (client: FaceClient, args: Record<string, unknown>) => Promise<ToolResult>
      /** harness_show_wallets: what the panes show, set by the agent when asked. An error message, or what's now shown. */
      showWallets?: (client: FaceClient, show: unknown) => Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }>
      /** harness_view: the screen, changed by the view the person last used. */
      view?: (client: FaceClient, args: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }>
      /** research_read and research_list, held to the client's agent's research folder. */
      research?: (client: FaceClient, name: string, args: Record<string, unknown>) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }>
      /** research_run: one program held to the client's agent's research folder. */
      run?: (client: FaceClient, args: Record<string, unknown>) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }>
      /** The skills the client's agent has: its preset's, and the person's own. */
      skills?: (client: FaceClient) => readonly Skill[]
      /** harness_history: the client's agent's own past turns, cards and paper trades. */
      history?: (client: FaceClient, args: Record<string, unknown>) => { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }
      /** harness_pnl: the P&L window's figure, the status bar's, for every engine. */
      pnl?: (client: FaceClient, args: Record<string, unknown>) => { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }
      /** harness_limits: what the agent may do without asking, and its narrowing card. */
      limits?: { read(client: FaceClient): Record<string, unknown>; propose(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<CardView> }
      /** Hacc's reads, answered by the core with the client's agent's own key. */
      hacc?: (client: FaceClient, name: string, args: Record<string, unknown>) => Promise<ToolResult>
      /** harness_triggers: read, propose as a card, narrow or switch off at once. */
      triggers?: { call(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<TriggersOutcome> }
      /** harness_bots: read, propose as a card, narrow or pause at once, flatten as a card. */
      bots?: { call(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<BotsOutcome> }
    },
  ) {}

  /** Throws for a malformed call at once; everything else is an answer. */
  call(client: FaceClient, name: unknown, args: unknown, reason?: string): Promise<ToolResult> {
    if (typeof name !== "string" || name.length === 0 || name.length > 64) throw invalidParams("name must name a tool.")
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw invalidParams("args must be an object.")
    let callArgs = args as Record<string, unknown>
    // The person stopped this turn (or it's over): nothing its harness still asks for acts, a call already on its way in included.
    if (this.turnEnded(client)) return this.refuseEnded(client, name)
    if (name === SHOW_WALLETS_TOOL.name) {
      if (!this.deps.showWallets) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", "harness_show_wallets isn't in this build of the core."))
      return this.deps.showWallets(client, callArgs.show).then((r) => (r.ok ? text({ success: true, shown: r.text }) : refusal(r.code, r.message)))
    }
    if (name === NAME_WALLETS_TOOL.name) {
      if (!this.deps.nameWallets) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", "harness_name_wallets isn't in this build of the core."))
      const asks = Array.isArray(callArgs.names) ? callArgs.names : undefined
      const ok = asks !== undefined && asks.length > 0 && asks.length <= 256 && asks.every((a) => typeof a === "object" && a !== null && typeof (a as { wallet?: unknown }).wallet === "string" && typeof (a as { name?: unknown }).name === "string")
      if (!ok || JSON.stringify(callArgs).length > 64 * 1024) return Promise.resolve(refusal("MCP_VALIDATION", "names is a list of 1 to 256 { wallet, name }, each a string."))
      return this.deps.nameWallets(client, (asks as { wallet: string; name: string }[]).map((a) => ({ wallet: a.wallet, name: a.name })), reason ?? (typeof callArgs.reason === "string" ? callArgs.reason : undefined))
    }
    if (name === GROUP_WALLETS_TOOL.name) {
      if (!this.deps.groupWallets) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", "harness_group_wallets isn't in this build of the core."))
      if (JSON.stringify(callArgs).length > 64 * 1024) return Promise.resolve(refusal("MCP_VALIDATION", "That's too much for one change to a group."))
      return this.deps.groupWallets(client, callArgs)
    }
    if (name === VIEW_TOOL.name) {
      if (!this.deps.view) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", "harness_view isn't in this build of the core."))
      if (typeof callArgs.action !== "string" || !VIEW_ACTIONS.has(callArgs.action)) return Promise.resolve(refusal("MCP_VALIDATION", `action is one of ${[...VIEW_ACTIONS].join(", ")}.`))
      if (JSON.stringify(callArgs).length > VIEW_ARGS_MAX) return Promise.resolve(refusal("MCP_VALIDATION", "That's too much for one change to the screen."))
      return this.deps.view(client, callArgs).then((r) => (r.ok ? text({ success: true, done: r.text }) : refusal(r.code, r.message)))
    }
    if (name === "research_run") {
      if (!this.deps.run) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      return this.deps.run(client, callArgs).then((r) => (r.ok ? text(r.body) : refusal(r.code, r.message)))
    }
    if (RESEARCH_TOOL_NAMES.has(name)) {
      if (!this.deps.research) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      return this.deps.research(client, name, callArgs).then((r) => (r.ok ? text(r.body) : refusal(r.code, r.message)))
    }
    // Skills: Candle's built in, the person's read from their folder; nothing to journal.
    if (SKILL_TOOL_NAMES.has(name)) {
      const r = skillRead(this.deps.skills?.(client) ?? [], callArgs)
      return Promise.resolve(r.ok ? text(r.body) : refusal(r.code, r.message))
    }
    if (name === HISTORY_TOOL_NAME) {
      if (!this.deps.history) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      const r = this.deps.history(client, callArgs)
      return Promise.resolve(r.ok ? text(r.body) : refusal(r.code, r.message))
    }
    if (name === PNL_TOOL_NAME) {
      if (!this.deps.pnl) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      const r = this.deps.pnl(client, callArgs)
      return Promise.resolve(r.ok ? text(r.body) : refusal(r.code, r.message))
    }
    if (name === LIMITS_TOOL_NAME) {
      if (!this.deps.limits) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      return this.limits(client, callArgs, reason ?? (typeof callArgs.reason === "string" ? callArgs.reason : undefined))
    }
    if (name === TRIGGERS_TOOL_NAME) {
      if (!this.deps.triggers) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      return this.triggers(client, callArgs, reason ?? (typeof callArgs.reason === "string" ? callArgs.reason : undefined))
    }
    if (name === BOTS_TOOL_NAME) {
      if (!this.deps.bots) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      if (JSON.stringify(callArgs).length > 32 * 1024) return Promise.resolve(refusal("MCP_VALIDATION", "That's too much for one bot."))
      return this.bots(client, callArgs, reason ?? (typeof callArgs.reason === "string" ? callArgs.reason : undefined))
    }
    if (HACC_TOOL_NAMES.has(name)) {
      if (!this.deps.hacc) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", `${name} isn't in this build of the core.`))
      return this.deps.hacc(client, name, callArgs)
    }
    if (name === "candle_cli") {
      const { reason: given, ...rest } = callArgs
      if (!this.deps.cli) return Promise.resolve(refusal("METHOD_NOT_AVAILABLE", "candle_cli isn't in this build of the core."))
      return this.deps.cli.call(client, rest, reason ?? (typeof given === "string" ? given : undefined))
    }
    // The agent's reason rides in the arguments of the card tools; Candle never sees it.
    if (REASON_TOOLS.has(name) && "reason" in callArgs) {
      const { reason: given, ...rest } = callArgs
      callArgs = rest
      if (reason === undefined && typeof given === "string") reason = given
    }
    return this.answer(client, name, callArgs, reason)
  }

  /** Whether the turn this harness's token was minted for was stopped or is over. A harness with no turn never is. */
  private turnEnded(client: FaceClient): boolean {
    return client.role === "harness" && client.tokenId !== undefined && this.deps.turn?.(client.tokenId)?.ended === true
  }

  private async refuseEnded(client: FaceClient, tool: string): Promise<ToolResult> {
    const message = TURN_ENDED_WORDS
    await this.deps.journal.append({ type: "tool.refused", mode: this.deps.mode(), agent: client.agent, clientId: client.clientId, role: client.role, ...wokenField(client, this.deps.wokenBy), tool, code: "TURN_ENDED", message })
    return refusal("TURN_ENDED", message)
  }

  /**
   * The turn began on paper, and was told so, and the Candle Harness is live now: what it asks for next would be
   * real where it expects paper. Refused, with why, so the agent says so and the person decides. The other way
   * round needs nothing: the trade is a paper one, and its answer says so.
   */
  private wentLive(client: FaceClient): boolean {
    return client.role === "harness" && client.tokenId !== undefined && this.deps.turn?.(client.tokenId)?.mode === "paper" && this.deps.mode() === "live"
  }

  private async refuseWentLive(client: FaceClient, tool: string): Promise<ToolResult> {
    const message = "The person switched the Candle Harness from paper to live during this turn, which began on paper. Nothing was sent. Say that the mode changed, and ask before doing this for real."
    await this.deps.journal.append({ type: "tool.refused", mode: this.deps.mode(), agent: client.agent, clientId: client.clientId, role: client.role, ...wokenField(client, this.deps.wokenBy), tool, code: "MODE_CHANGED", message })
    return refusal("MODE_CHANGED", message)
  }

  private async answer(client: FaceClient, name: string, given: Record<string, unknown>, reason?: string): Promise<ToolResult> {
    const mode = modeFor(client, this.deps.mode())
    const child = () => this.deps.pool.for(client.agent)
    let args = numbersFromText(given, this.deps.schemaOf?.(client.agent, name))
    const verdict = classify(name, args, mode)

    if (verdict.class === "refused") {
      await this.deps.journal.append({ type: "tool.refused", mode, agent: client.agent, clientId: client.clientId, role: client.role, tool: name, code: verdict.code, message: verdict.reason })
      return refusal(verdict.code, verdict.reason)
    }

    if (name === "candle_get_operation") return this.getOperation(client, args, child)

    if (verdict.class === "read") return relay(await child().call(name, args))

    if (verdict.class === "paper") {
      // A paper trade is the key's own paper book, with no wallet behind it; naming a TEE wallet asks for one.
      const { wallet, ...unwalleted } = args
      const embedded = typeof wallet === "string" && (wallet.trim().toLowerCase() === "embedded" || this.deps.isEmbedded?.(client.agent, wallet) === true)
      // A paper trade refused before Candle trades it leaves a row, with whose it was, as every refusal does: with no
      // `paper.call` row, nothing else would record it (a bot's request waited on one for good).
      const refusedHere = async (code: string, message: string, said = message): Promise<ToolResult> => {
        await this.deps.journal.append({ type: "tool.refused", mode, agent: client.agent, clientId: client.clientId, role: client.role, ...triggerFields(client.trigger), ...botFields(client.bot), ...wokenField(client, this.deps.wokenBy), tool: name, code, message })
        return refusal(code, said)
      }
      if (wallet !== undefined && !embedded) return refusedHere("NO_PAPER_TEE", "TEE wallets have no paper form.", "TEE wallets have no paper form; switch to live to trade from one. Nothing was sent.")
      args = unwalleted
      // What trades spend isn't a trade's token on paper either: the paper book would hold a position no live trade can make.
      const spent = name === "candle_trade" ? notATradeToken(args.mint, maybeChain(args.chain)?.slug) : undefined
      if (spent !== undefined) return refusedHere("BASE_ASSET", spent)
      let paperArgs = args
      if (name === "candle_trade" && args.amountUsd !== undefined) {
        if (!this.deps.sizing) return refusedHere("METHOD_NOT_AVAILABLE", "amountUsd isn't in this build of the core.")
        const sized = await sizeInUsd(client.agent, args, this.deps.sizing)
        if (!sized.ok) return refusedHere(sized.code, sized.message)
        paperArgs = sized.args
      }
      const sent = normaliseForMode(name, paperArgs, "paper")
      const outcome = await child().call(name, sent)
      const result = relay(outcome)
      const answer = result.content[0]?.text
      // What it filled, with its pair asset's price now, so a bot's paper book is rebuilt from this row alone.
      const fill = name === "candle_trade" && !result.isError ? paperFill(answer) : undefined
      const assetPoint = fill && this.deps.sizing && isBaseAsset(fill.asset) ? await this.deps.sizing.pricing.asset(client.agent, fill.asset).catch(() => undefined) : undefined
      const assetUsd = assetPoint && Number.isFinite(assetPoint.usd) && assetPoint.usd > 0 ? assetPoint.usd : undefined
      await this.deps.journal.append({
        type: "paper.call",
        mode: "paper",
        agent: client.agent,
        clientId: client.clientId,
        role: client.role,
        ...triggerFields(client.trigger),
        ...botFields(client.bot),
        ...wokenField(client, this.deps.wokenBy),
        tool: name,
        args: sent,
        ...(typeof wallet === "string" ? { walletNamed: wallet } : {}),
        isError: result.isError === true,
        answer: answer?.slice(0, 2000) ?? null,
        ...(fill ? { fill: assetUsd !== undefined ? { ...fill, assetUsd } : fill } : {}),
      })
      if (result.isError) return result
      // Every quote carries dollars: a paper fill is Candle's own answer, in the pair asset alone.
      const usd = name === "candle_trade" && this.deps.sizing ? await paperDollars(client.agent, answer, this.deps.sizing.pricing) : undefined
      return { ...result, content: [...result.content, usd ? paperNote(usd) : PAPER_NOTE] }
    }

    // A write naming an id the core holds is a read of that card, answered before anything that
    // could refuse a new card.
    const heldId = verdict.idKey === "coreOpId" ? undefined : args[verdict.idKey]
    const held = typeof heldId === "string" ? this.deps.cards.held(heldId) : undefined
    if (held !== undefined) {
      // Another agent's card is never its to read: the id is refused, as one held for a different request is.
      if (!ownCard(client, held)) {
        await this.deps.journal.append({ type: "tool.refused", mode, agent: client.agent, clientId: client.clientId, tool: name, code: "OP_ID_CONFLICT" })
        return refusal("OP_ID_CONFLICT", "That operation id is held for a different request. Never reuse an id for new parameters.", { opId: heldId })
      }
      const without = (a: Record<string, unknown>) => {
        const { [verdict.idKey]: _id, paper: _paper, dryRun: _dryRun, ...rest } = a
        return rest
      }
      if (held.tool !== name || canonicalJson(without(held.asked)) !== canonicalJson(without(args))) {
        await this.deps.journal.append({ type: "tool.refused", mode, agent: client.agent, clientId: client.clientId, tool: name, code: "OP_ID_CONFLICT" })
        return refusal("OP_ID_CONFLICT", "That operation id is held for a different request. Never reuse an id for new parameters.", { opId: heldId })
      }
      return cardAnswer(held)
    }

    if (this.wentLive(client)) return this.refuseWentLive(client, name)

    try {
      const card = await this.deps.cards.propose({
        client,
        agent: client.agent,
        tool: name,
        args,
        params: normaliseForMode(name, args, mode),
        kind: verdict.kind,
        idKey: verdict.idKey,
        ...(reason !== undefined ? { reason } : {}),
      })
      // The turn was stopped while this was being priced: the card is taken back and nothing runs, with or without a press.
      if (this.turnEnded(client)) {
        await this.deps.cards.withdraw?.(client.clientId, card.cardId).catch(() => {})
        return this.refuseEnded(client, name)
      }
      // A trade its wallet runs without a card goes now; anything else stays a card.
      if (verdict.kind !== "trade" && verdict.kind !== "swap") return cardAnswer(card)
      return cardAnswer((await this.deps.cards.runWithoutCard?.(card, client))?.card ?? card)
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown; details?: unknown }
      if (typeof e.code !== "string") throw error
      return refusal(e.code, String(e.message), (e.details as Record<string, unknown>) ?? {})
    }
  }

  /**
   * harness_limits: a read with no setting or figure; otherwise the narrowing card, which refuses anything
   * that would widen. A resend naming a card's coreOpId reads that card, as every card tool does.
   */
  private async limits(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<ToolResult> {
    const limits = this.deps.limits!
    if (!narrows(args)) return text(limits.read(client))
    const held = typeof args.coreOpId === "string" ? this.deps.cards.held(args.coreOpId) : undefined
    if (held !== undefined) return held.tool === LIMITS_TOOL_NAME && held.agent === client.agent ? cardAnswer(held) : refusal("OP_ID_CONFLICT", "That operation id is held for a different request. Never reuse an id for new parameters.")
    const { coreOpId: _id, ...rest } = args
    try {
      return cardAnswer(await limits.propose(client, narrowingArgs(rest), reason))
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown }
      if (typeof e.code !== "string") throw error
      await this.deps.journal.append({ type: "tool.refused", mode: this.deps.mode(), agent: client.agent, clientId: client.clientId, role: client.role, tool: LIMITS_TOOL_NAME, code: e.code, message: String(e.message) })
      return refusal(e.code, String(e.message))
    }
  }

  /** harness_triggers: an answer, a card answered as every card is, or a refusal, journalled. */
  private async triggers(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<ToolResult> {
    // A trigger takes the mode it's proposed in, for good: one asked for in a turn told "paper" isn't made a live one.
    if (args.action === "propose" && this.wentLive(client)) return this.refuseWentLive(client, TRIGGERS_TOOL_NAME)
    const out = await this.deps.triggers!.call(client, args, reason)
    if ("card" in out) {
      const card = this.deps.cards.held(out.card)
      if (!card) return refusal("CARD_NOT_FOUND", "The card was made and then gone; read the triggers again.")
      // The card's own words reach the agent too: how the trigger will run, and the wallet of its own where it asks.
      const answer = cardAnswer(card)
      const d = (card as CardView & { display?: { triggerCard?: TriggerSpec; warning?: string } }).display
      if (!d?.triggerCard || card.state !== "awaiting_approval") return answer
      const body = JSON.parse(answer.content[0]!.text) as Record<string, unknown>
      return text({ ...body, trigger: { line: d.triggerCard.line, words: d.triggerCard.words, runs: d.triggerCard.runs }, ...(d.warning ? { warning: d.warning } : {}), tell: "Tell the person how it will run, in a line, as the card says it: on its own, or asking them each time (and, for one that asks, the wallet of its own it suggests)." })
    }
    if (out.ok) return text(out.body)
    await this.deps.journal.append({ type: "tool.refused", mode: this.deps.mode(), agent: client.agent, clientId: client.clientId, role: client.role, tool: TRIGGERS_TOOL_NAME, code: out.code, message: out.message })
    return refusal(out.code, out.message)
  }

  /** harness_bots: an answer, a card answered as every card is (with the card's own words), or a refusal, journalled. */
  private async bots(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<ToolResult> {
    const out = await this.deps.bots!.call(client, args, reason)
    if ("card" in out) {
      const card = this.deps.cards.held(out.card)
      if (!card) return refusal("CARD_NOT_FOUND", "The card was made and then gone; read the bots again.")
      const answer = cardAnswer(card)
      const d = (card as CardView & { display?: { botCard?: BotSpec; warning?: string } }).display
      if (!d?.botCard || card.state !== "awaiting_approval") return answer
      const b = d.botCard
      const body = JSON.parse(answer.content[0]!.text) as Record<string, unknown>
      const bot = b.flatten ? { name: b.name, flatten: b.flatten } : { name: b.name, words: b.words, mode: b.mode, runs: [b.runs.entries, b.runs.exits].filter(Boolean).join(" "), worst: b.worst, ...(b.backtest ? { backtest: b.backtest } : {}), ...(b.from ? { from: b.from } : {}) }
      const tell = b.flatten
        ? "Tell the person the card sells every open position of the bot once they press it, and that the bot stays as it is."
        : "Tell the person, in a line or two, as the card says it: paper or live, how its buys and its exits run, and its worst case. Where a warning suggests a wallet of its own, offer it."
      return text({ ...body, bot, ...(d.warning ? { warning: d.warning } : {}), ...("note" in out && out.note ? { note: out.note } : {}), tell })
    }
    if (out.ok) return text(out.body)
    await this.deps.journal.append({ type: "tool.refused", mode: this.deps.mode(), agent: client.agent, clientId: client.clientId, role: client.role, tool: BOTS_TOOL_NAME, code: out.code, message: out.message })
    return refusal(out.code, out.message)
  }

  private async getOperation(client: FaceClient, args: Record<string, unknown>, child: () => ReturnType<AgentChildren["for"]>): Promise<ToolResult> {
    const { clientId, kind } = args
    if (typeof clientId !== "string" || clientId.length === 0) return refusal("MCP_VALIDATION", "clientId must be a string.")
    if (typeof kind !== "string" || !OPERATION_KINDS.includes(kind)) return refusal("MCP_VALIDATION", `kind is one of ${OPERATION_KINDS.join(", ")}.`)
    const held = this.deps.cards.held(clientId)
    // Another agent's card isn't read here, nor relayed to Candle, which answers for the whole account.
    if (held !== undefined && !ownCard(client, held)) return refusal("OPERATION_NOT_HELD", `The core holds no ${kind} card of this agent's under this id.`)
    if (held !== undefined) return cardAnswer(held)
    if (kind === "swap") {
      return refusal("OPERATION_NOT_HELD", "The core issued no swap under this id. A swap is read by replaying it with the same clientSwapId and body.")
    }
    if (!CANDLE_READS.has(kind)) return refusal("OPERATION_NOT_HELD", `The core holds no ${kind} card under this id.`)
    return relay(await child().call("candle_get_operation", { clientId, kind }))
  }
}
