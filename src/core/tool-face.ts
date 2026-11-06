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
import { BASE_ASSETS, type BaseAsset, isBaseAsset } from "./assets"
import type { ToolOutcome } from "./candle-mcp"
import type { CliCardRequest } from "./cli-cards"
import type { PaneRequest } from "./pane-plan"
import { type CardKind, classify, type IdKey, type Mode, normaliseForMode, TOOL_CLASSES } from "./classify"
import { cutToBudget, HACC_TOOL_NAMES, PATTERNS } from "./hacc-tools"
import { HISTORY_TOOL_NAME } from "./history-tool"
import { JOURNAL_KINDS } from "./journal-query"
import { LIMITS_TOOL_NAME, narrowingArgs, narrows } from "./limits-tool"
import { PNL_TOOL_NAME } from "./pnl-tool"
import type { Journal } from "./journal"
import { RESEARCH_TOOL_NAMES } from "./research-tools"
import { PAPER_CLOSED_WORDS } from "./trade-log"
import { type SizingDeps, sizeInUsd } from "./sizing"

export interface ToolResult {
  content: { type: "text"; text: string }[]
  isError?: boolean
}

/** A harness reads only its own agent's cards; a view, the person's, reads any. */
const ownCard = (client: FaceClient, card: { agent: string }): boolean => client.role !== "harness" || card.agent === client.agent

export interface FaceClient {
  clientId: string
  role: "view" | "harness"
  /** The agent this client acts as: a harness acts as the active agent of its turn. */
  agent: string
  /** A harness's token, which names the turn it was minted for. */
  tokenId?: string
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
  state: CardState
  expiresAt: string
  /** `paper`: a live sell Candle answered by closing the key's paper position, the live wallet holding none. */
  operation?: { state: OperationState; result?: unknown; error?: unknown; paper?: boolean }
  /** It ran without a card, inside its wallet's limits, in words. */
  withoutCard?: string
  /** A trade on a wallet that trades inside limits that is a card all the same, and why. */
  cardBecause?: string
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
  }): Promise<CardView>
  /** A trade card just proposed, run at once by the core when its wallet's rule says so. */
  runWithoutCard?(card: CardView, client: FaceClient): Promise<{ card: CardView }>
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

const NEXT_PENDING = (kind: string, idKey: string) =>
  `The user approves this in the Candle Harness with one key press. Read the outcome with candle_get_operation using this id (kind: ${kind}). Never send it again under a new id; to retry, send the same request with the same ${idKey}.`
const NEXT_FINAL = "Final. Don't propose this again unless the user asks."
const NEXT_UNKNOWN = "Don't propose this again; the user is resolving it in the Candle Harness."

/** The answer for a card and its operation, in whatever state they are. */
export function cardAnswer(card: CardView): ToolResult {
  // How it was approved, when the core ran it without a card: the person didn't press anything.
  const ids = { cardId: card.cardId, [card.idKey]: card.opId, opId: card.opId, kind: card.kind, agent: card.agent, ...(card.withoutCard ? { approved: card.withoutCard } : {}) }
  const op = card.operation
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
    return text({ success: false, error: { code: "OPERATION_PENDING", message: "Approved and running." }, ...ids, state: op.state, next: `Read it again with candle_get_operation (kind: ${card.kind}).` })
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

function relay(outcome: ToolOutcome): ToolResult {
  if (outcome.kind === "ok") return text(candleFits(outcome.result))
  if (outcome.kind === "error") return text(outcome.body ?? { success: false, error: { code: outcome.code } }, true)
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
const REASON_TOOLS = new Set(Object.entries(TOOL_CLASSES).filter(([, c]) => c.class === "card").map(([name]) => name))
const REASON_PROPERTY = { type: "string", description: "Why, in a sentence or two. It's shown to the user on the approval card. At most 500 characters." }

const WALLET_PROPERTY = {
  type: "string",
  description:
    'Which wallet pays: "embedded" (the account\'s embedded wallet), or a TEE wallet bound to your key, by its label or address. Left out, your default applies. A TEE wallet\'s trade runs through the user\'s candle CLI on the same one-press card. Live only: TEE wallets have no paper form.',
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
      return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, kind: { ...kind, enum: [...OPERATION_KINDS] } } } }
    }
    if (!REASON_TOOLS.has(tool.name)) return tool
    const properties = { ...tool.inputSchema.properties }
    properties.reason ??= REASON_PROPERTY
    if (tool.name === "candle_trade") properties.amountUsd ??= AMOUNT_USD_PROPERTY
    if (tool.name === "candle_trade" || tool.name === "candle_swap") properties.wallet ??= WALLET_PROPERTY
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } }
  })
}

/**
 * The kinds `candle_get_operation` takes on this face: Candle's two, plus the cards the core holds of
 * every other kind, the CLI's card rows included (without them the agent couldn't read an upload's
 * URL or a less-access result). Only a trade or a launch the core doesn't hold is read from Candle.
 */
const OPERATION_KINDS = ["trade", "launch", "swap", "stake", "claim", "public", "upload", "lessaccess", "lp", "close", "hacc", "autonomy"]
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
      action: { type: "string", enum: ["read", "tab", "layout", "open", "close", "build", "add_tab", "rename_tab", "remove_tab", "show_tab", "hide_tab", "pin", "unpin", "signals", "journal", "theme", "make_theme"] },
      tab: { type: "string", description: "The tab's name; left out, the tab on screen (for \"signals\" and \"journal\", else the tab named after the pane, else the first with it). For \"tab\", the tab to switch to (or its number, 1 to 9)." },
      layout: { type: "string", description: "\"layout\" and \"add_tab\": a layout's name, such as \"Cockpit\"." },
      pane: { type: "string", description: `"open" and "close": a pane's id (${PANE_IDS.join(", ")}). "tab": a pane to show, on the tab named or the first tab that has it.` },
      near: { type: "string", description: "\"open\": the pane to open it beside; left out, at the end." },
      root: { type: "array", description: "\"build\": the tree, as layouts.toml writes one: [\"row\", [\"column\", 62, \"feed 40\", \"token 60\"], \"agent 38\"]. Each pane once." },
      name: { type: "string", description: "\"build\": the name the layout is kept as, if kept. \"add_tab\" and \"rename_tab\": the tab's new name (1 to 20 characters). \"theme\" and \"make_theme\": the theme's name." },
      mint: { type: "string", description: "\"pin\": the token to pin; left out, the token the tab's token pane shows." },
      mine: { type: "boolean", description: "\"signals\": true for the person's own rules' signals, false for Hacc's tape." },
      pattern: { type: "string", enum: [...PATTERNS, "all"], description: "\"signals\": only this pattern on Hacc's tape (kol_mention: a KOL posting about a token, with a buy); \"all\" clears it." },
      chain: { type: "string", enum: ["solana", "hood", "both"], description: "\"signals\": only this chain's tokens; \"both\" clears it." },
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
    },
  ) {}

  /** Throws for a malformed call at once; everything else is an answer. */
  call(client: FaceClient, name: unknown, args: unknown, reason?: string): Promise<ToolResult> {
    if (typeof name !== "string" || name.length === 0 || name.length > 64) throw invalidParams("name must name a tool.")
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw invalidParams("args must be an object.")
    let callArgs = args as Record<string, unknown>
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

  private async answer(client: FaceClient, name: string, given: Record<string, unknown>, reason?: string): Promise<ToolResult> {
    const mode = this.deps.mode()
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
      if (wallet !== undefined && !embedded) {
        await this.deps.journal.append({ type: "tool.refused", mode, agent: client.agent, clientId: client.clientId, role: client.role, tool: name, code: "NO_PAPER_TEE", message: "TEE wallets have no paper form." })
        return refusal("NO_PAPER_TEE", "TEE wallets have no paper form; switch to live to trade from one. Nothing was sent.")
      }
      args = unwalleted
      let paperArgs = args
      if (name === "candle_trade" && args.amountUsd !== undefined) {
        if (!this.deps.sizing) return refusal("METHOD_NOT_AVAILABLE", "amountUsd isn't in this build of the core.")
        const sized = await sizeInUsd(client.agent, args, this.deps.sizing)
        if (!sized.ok) return refusal(sized.code, sized.message)
        paperArgs = sized.args
      }
      const sent = normaliseForMode(name, paperArgs, "paper")
      const outcome = await child().call(name, sent)
      const result = relay(outcome)
      await this.deps.journal.append({
        type: "paper.call",
        mode: "paper",
        agent: client.agent,
        clientId: client.clientId,
        role: client.role,
        tool: name,
        args: sent,
        ...(typeof wallet === "string" ? { walletNamed: wallet } : {}),
        isError: result.isError === true,
        answer: result.content[0]?.text.slice(0, 2000) ?? null,
      })
      if (result.isError) return result
      // Every quote carries dollars: a paper fill is Candle's own answer, in the pair asset alone.
      const usd = name === "candle_trade" && this.deps.sizing ? await paperDollars(client.agent, result.content[0]?.text, this.deps.sizing.pricing) : undefined
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
