// What happens to each of Candle's MCP tools.
// Every tool Candle's server lists is classified here; classify.drift.test.ts keeps the table and the
// recorded tool list equal, and the core checks the real server's list at start.
//
//   read     runs at once on the agent's own MCP child, and so does a dry run, which spends nothing;
//   paper    candle_trade in paper mode: runs at once, sent with paper: true, no card;
//   card     a one-press card: live trades and swaps, narrowing a key's wallets, and launches, staking,
//            claims, profile edits and posts, live only;
//            a tool the table doesn't know is an `unknown` card, which can't be approved yet;
//   refused  not yet, with the reason.
import { rowFor } from "./cli-table"
import { ceremonyStops, FUNDS_OUT_STOPS, OWNER_STOPS } from "./owner-rows"
import type { Side } from "./limits"

export type Mode = "paper" | "live"
/** upload, lp and close are the CLI's card rows; a TEE wallet's stake and launch keep their kinds. */
/**
 * `owner`, `ceremony`, `funds-out` and `read`: cards that run in the prompt pane, by
 * their row's rule. A read only becomes a card there when it asks at the CLI's own prompt (`tee fund`).
 */
export type CardKind = "trade" | "swap" | "lessaccess" | "launch" | "stake" | "claim" | "public" | "upload" | "lp" | "close" | "owner" | "ceremony" | "funds-out" | "hacc" | "autonomy" | "trigger" | "bot" | "read" | "unknown"
/** The id field a tool already has, or `coreOpId` for a tool with none (the core keeps the id). */
export type IdKey = "clientTradeId" | "clientSwapId" | "clientLaunchId" | "clientStakeId" | "coreOpId"

export type ToolClass =
  | { class: "read" }
  | { class: "card"; kind: CardKind; idKey: IdKey }
  /** `listed: false` keeps it off the agent's tool list altogether. */
  | { class: "refused"; code: string; reason: string; listed: boolean }

export type CallClass =
  | { class: "read" }
  | { class: "paper" }
  | { class: "card"; kind: CardKind; idKey: IdKey }
  | { class: "refused"; code: string; reason: string; listed: boolean }

const READ: ToolClass = { class: "read" }
const card = (kind: CardKind, idKey: IdKey = "coreOpId"): ToolClass => ({ class: "card", kind, idKey })
const notYet = (reason: string): ToolClass => ({ class: "refused", code: "NOT_YET_SUPPORTED", reason, listed: false })
const PERPS = notYet("Perps trading isn't in the Candle Harness yet: perps come later. Perps reads work.")
const TRANSFER: ToolClass = {
  class: "refused",
  code: "TRANSFER_USER_ONLY",
  // These need a Withdraw key, and the Candle Harness keeps every agent key at Write: funds go out by the owner's routes.
  reason: "Moving funds out from the embedded wallet needs a Withdraw key, and every agent key in the Candle Harness is Write, which can't move funds. Send from a vault key or a TEE wallet promoted from this machine's vault with candle vault transfer, or sweep a disabled TEE wallet home with candle tee sweep, through candle_cli when the user asks; from the embedded wallet, the user sends on candle.tv.",
  listed: false,
}
const TOKEN_PAGES: ToolClass = {
  class: "refused",
  code: "NEEDS_TOKEN_PAGES_SCOPE",
  // A token page's private reads and every write need token-pages:read or :write, which no access preset has.
  reason: "This needs token-pages access, which no agent key in the Candle Harness has. Run it in your own terminal with a key made for it.",
  listed: false,
}
const LAB: ToolClass = {
  class: "refused",
  code: "USE_HACC_LAB",
  // The same Hacc lab, over the same key: one route, with the plan's limits and replays followed to the end.
  reason: "Use hacc_lab: the Candle Harness's own strategy lab tool, which follows a replay to the end and says how it ended.",
  listed: false,
}
const UNKNOWN: CallClass = { class: "card", kind: "unknown", idKey: "coreOpId" }

export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  // Reads.
  candle_get_market: READ,
  candle_get_feed: READ,
  candle_vamp_candidates: READ,
  candle_token_forensics: READ,
  // Released in server 0.10.25 (CLI 0.13.5, as recorded from it): keyless reads, each off on a deployment
  // until Candle switches it on (TOKEN_CARD_DISABLED, TOKEN_EVENTS_DISABLED), which is the server's answer.
  candle_token_card: READ,
  candle_token_events: READ,
  candle_get_agent_profile: READ,
  // Server 0.10.28 (CLI 0.13.9): keyless reads. A token page's public reads answer that it's off until
  // Candle's deployment switches it on, which is the server's answer.
  candle_get_agent_positions: READ,
  candle_token_clusters: READ,
  candle_token_history: READ,
  candle_token_page_about: READ,
  candle_token_page_burns: READ,
  candle_token_page_history: READ,
  candle_token_page_comments: READ,
  candle_token_page_updates: READ,
  candle_list_agents: READ,
  candle_list_agent_posts: READ,
  candle_get_plans: READ,
  candle_get_wallets: READ,
  candle_get_profile_wallets: READ,
  candle_get_profile_pnl: READ,
  candle_get_profile_trades: READ,
  candle_get_portfolio: READ,
  candle_resolve_token: READ,
  candle_execution_status: READ,
  candle_get_operation: READ,
  candle_get_fees: READ,
  // New in server 0.10.29: a launch with first buys, checked and priced, building and reserving nothing.
  candle_atomic_launch_dry_run: READ,
  // New in server 0.10.30: a token's OHLC bars (keyless), the key's paper book and paper P&L, and the
  // account's P&L across its agent keys. Reads only.
  candle_get_price_history: READ,
  candle_get_paper_inventory: READ,
  candle_get_profile_paper: READ,
  candle_get_account_pnl: READ,
  // New in server 0.10.31 (CLI 0.13.19): a price before a trade, which moves nothing; the key's own TEE wallets
  // with whether each may pay; and each wallet the key may spend from with its balances. Reads only.
  candle_quote: READ,
  candle_get_trading_wallets: READ,
  candle_get_spendable_balances: READ,
  candle_get_staking: READ,
  candle_perps_markets: READ,
  candle_perps_market: READ,
  candle_perps_book: READ,
  candle_perps_candles: READ,
  candle_perps_orders: READ,
  candle_perps_positions: READ,
  candle_perps_fills: READ,
  candle_perps_funding: READ,
  candle_perps_account: READ,
  candle_perps_risk: READ,
  candle_perps_thresholds: READ,
  // Money writes from the embedded main wallet: one-press cards.
  candle_trade: card("trade", "clientTradeId"),
  candle_swap: card("swap", "clientSwapId"),
  // Only narrows from a key (widening is LOOSEN_REQUIRES_SESSION): less access.
  candle_set_profile_wallets: card("lessaccess"),
  // From the embedded wallet, through Candle's own tools. A TEE wallet's staking and
  // launches are the CLI's card rows through candle_cli.
  candle_launch_token: card("launch", "clientLaunchId"),
  candle_launch_and_seed: card("launch", "clientLaunchId"),
  candle_stake: card("stake", "clientStakeId"),
  candle_unstake: card("stake", "clientStakeId"),
  candle_finish_unstake: card("stake", "clientStakeId"),
  candle_claim_fees: card("claim"),
  candle_claim_staking_reward: card("claim"),
  candle_update_profile: card("public"),
  candle_create_post: card("public"),
  candle_delete_post: card("public"),
  // New in server 0.10.25: fetches a public https image, re-hosts it on uploads.candle.tv and sets
  // the avatar or banner in one step. Public, and uses one of the profile's 20 edits a day even if it fails.
  candle_upload_profile_image: card("public"),
  // New in server 0.10.28: the creator's edit of a token's description and links, under launch:write.
  // Re-sending the same values changes nothing.
  candle_token_edit: card("public"),
  // Token pages' private reads and writes (0.10.28).
  candle_token_page_capabilities: TOKEN_PAGES,
  candle_token_page_seen: TOKEN_PAGES,
  candle_token_page_creator_challenge: TOKEN_PAGES,
  candle_token_page_claim: TOKEN_PAGES,
  candle_token_page_section_set: TOKEN_PAGES,
  candle_token_page_section_restore: TOKEN_PAGES,
  candle_token_page_update: TOKEN_PAGES,
  candle_token_page_post_delete: TOKEN_PAGES,
  candle_token_page_comment: TOKEN_PAGES,
  candle_token_page_mark_seen: TOKEN_PAGES,
  candle_token_page_flag: TOKEN_PAGES,
  // The strategy lab over the agent's key (0.10.28, local servers only): hacc_lab is the Candle Harness's route.
  candle_lab_status: LAB,
  candle_lab_replay: LAB,
  candle_lab_replay_result: LAB,
  candle_lab_runners: LAB,
  candle_lab_edges: LAB,
  // Records a transaction the client executed itself (docs.candle.tv/developers/mcp-server, the tool table;
  // docs.candle.tv/developers/agent-access, the Write row). Nothing the Candle Harness runs needs it: the embedded wallet's
  // trades are executed by Candle, and a TEE wallet's are submitted to Candle by `candle swap`, which
  // broadcasts and records them (cli/src/commands/swap.ts:659-667).
  candle_report_activity: {
    class: "refused",
    code: "NOT_NEEDED",
    reason: "Every trade the Candle Harness runs is recorded by Candle already: the embedded wallet's by Candle itself, a TEE wallet's by candle swap, which submits it to Candle.",
    listed: false,
  },
  // New in server 0.10.30: the spend half of a candle_trade built with deferExecution. The Candle Harness's card
  // is already the quote and the spend on one press, so a built trade has nothing to wait for.
  candle_trade_execute: {
    class: "refused",
    code: "NOT_NEEDED",
    reason: "The Candle Harness's card is the quote: the person's press on it spends. Propose the trade with candle_trade, without deferExecution.",
    listed: false,
  },
  // Perps writes.
  candle_perps_setup: PERPS,
  candle_perps_open: PERPS,
  candle_perps_close: PERPS,
  candle_perps_cancel: PERPS,
  candle_perps_leverage: PERPS,
  candle_perps_modify: PERPS,
  candle_perps_margin: PERPS,
  candle_perps_tpsl: PERPS,
  candle_perps_schedule_cancel: PERPS,
  candle_perps_flatten: PERPS,
  candle_perps_reduce_only: PERPS,
  candle_perps_deposit: PERPS,
  candle_perps_set_thresholds: PERPS,
  // Funds out: never offered to the agent.
  candle_transfer: TRANSFER,
  candle_sweep: TRANSFER,
}

/**
 * The arguments each of Candle's card tools takes, as recorded from its server, and the Candle Harness's own beside
 * them. A card is made only from arguments named here: one the table doesn't know is refused by name before a
 * card exists, so a new argument on a known tool can never ride a card unshown. classify.drift.test.ts keeps
 * each list equal to the recorded schema's, so a new argument fails the build as a new tool does.
 */
export const CARD_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  candle_trade: ["mint", "side", "amount", "percent", "quoteAsset", "maxSlippageBps", "clientTradeId", "paper", "deferExecution"],
  candle_swap: ["from", "to", "amount", "amountRaw", "maxSlippageBps", "clientSwapId"],
  candle_set_profile_wallets: ["keyPrefix", "walletIds"],
  candle_launch_token: ["clientLaunchId", "name", "symbol", "imageUrl", "bannerUrl", "description", "chain", "quoteAsset", "mode", "creatorFeeBps", "stakerAllocationBps", "poolOpen", "expPoolShape", "dexVersion", "visibility", "dryRun", "socials", "curve", "poolFee", "launchRules", "buyAmount"],
  candle_launch_and_seed: ["clientLaunchId", "name", "symbol", "imageUrl", "bannerUrl", "description", "chain", "quoteAsset", "mode", "creatorFeeBps", "stakerAllocationBps", "poolOpen", "expPoolShape", "dexVersion", "visibility", "dryRun", "socials", "curve", "poolFee", "launchRules", "devBuy"],
  candle_stake: ["payer", "linkedWalletId", "clientStakeId", "dryRun", "amountRaw"],
  candle_unstake: ["payer", "linkedWalletId", "clientStakeId", "dryRun", "amountRaw"],
  candle_finish_unstake: ["payer", "linkedWalletId", "clientStakeId", "dryRun", "withdrawal"],
  candle_claim_fees: ["mint", "dryRun"],
  candle_claim_staking_reward: ["rewardId"],
  candle_update_profile: ["publicAvatar", "publicBanner", "publicThesis", "publicStrategy", "publicStrategyNote", "publicModels", "publicLinks"],
  candle_create_post: ["text", "token"],
  candle_delete_post: ["postId"],
  candle_upload_profile_image: ["kind", "imageUrl"],
  candle_token_edit: ["chain", "mint", "description", "socials", "idempotencyKey"],
}
/** The Candle Harness's own arguments on Candle's card tools: taken off before Candle sees them. */
export const HARNESS_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  candle_trade: ["amountUsd", "wallet"],
  candle_swap: ["wallet", "paper"],
  candle_launch_token: ["paper", "imagePath", "bannerPath"],
  candle_launch_and_seed: ["paper", "imagePath", "bannerPath"],
}

/** The first argument a card tool doesn't take, or undefined when every one is known (or the tool has no list). */
export function unknownArgument(tool: string, args: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(CARD_TOOL_ARGS, tool)) return undefined
  const known = new Set([...CARD_TOOL_ARGS[tool]!, ...(HARNESS_TOOL_ARGS[tool] ?? [])])
  return Object.keys(args).find((key) => !known.has(key))
}

/** Where a card tool's argument list and Candle's recorded schema differ: empty when they agree. */
export function argumentDrift(tools: readonly { name: string; inputSchema?: { properties?: Record<string, unknown> } }[], table: Readonly<Record<string, readonly string[]>> = CARD_TOOL_ARGS): string[] {
  const problems: string[] = []
  for (const [name, listed] of Object.entries(table)) {
    const recorded = Object.keys(tools.find((t) => t.name === name)?.inputSchema?.properties ?? {})
    for (const arg of recorded) if (!listed.includes(arg)) problems.push(`unlisted argument: ${name}.${arg}`)
    for (const arg of listed) if (!recorded.includes(arg)) problems.push(`not an argument of ${name}: ${arg}`)
  }
  for (const [name, known] of Object.entries(TOOL_CLASSES)) if (known.class === "card" && !Object.hasOwn(table, name)) problems.push(`no argument list: ${name}`)
  return problems
}

/** The values Candle's server reads as `paper: true` (agentic tools.ts, tradeShape's preprocess). */
function truthyPaper(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1"
}

/** The tools with a dry run: `dryRun: true` reads and checks, and sends, signs and records nothing. */
const DRY_RUN_TOOLS = new Set(["candle_launch_token", "candle_launch_and_seed", "candle_stake", "candle_unstake", "candle_finish_unstake", "candle_claim_fees"])
/** The card kinds with no paper form. */
const LIVE_ONLY: ReadonlySet<CardKind> = new Set(["launch", "stake", "claim", "public"])

/** How one call is treated in this mode, decided from the tool and its arguments, never from the caller's say-so. */
export function classify(tool: string, args: Record<string, unknown>, mode: Mode): CallClass {
  if (!Object.hasOwn(TOOL_CLASSES, tool)) return UNKNOWN
  const known = TOOL_CLASSES[tool]!
  // Candle's own descriptions say "dry-run first": a dry run is a read, so it never makes a card. Only
  // boolean true: anything else Candle's schema refuses, or reads as a real call.
  if (DRY_RUN_TOOLS.has(tool) && args.dryRun === true) return READ
  if (known.class === "card" && LIVE_ONLY.has(known.kind) && mode === "paper") {
    return { class: "refused", code: "NO_PAPER_FORM", reason: "This is paper mode, and this has no paper form: switch to live to do it.", listed: true }
  }
  if (tool === "candle_trade") {
    // deferExecution builds and spends nothing until candle_trade_execute: a card pressed on it would
    // read as a filled trade that never ran. The card already quotes, then spends on the press.
    if (truthyPaper(args.deferExecution)) {
      return { class: "refused", code: "DEFER_NOT_USED", reason: "The Candle Harness's card is the quote, and the person's press spends: propose the trade without deferExecution.", listed: true }
    }
    if (mode === "paper") return { class: "paper" }
    if (truthyPaper(args.paper)) {
      return { class: "refused", code: "PAPER_IN_LIVE_MODE", reason: "This is live mode: switch to paper mode for paper trades.", listed: true }
    }
  }
  if (tool === "candle_swap" && mode === "paper") {
    return { class: "refused", code: "NO_PAPER_SWAPS", reason: "This is paper mode, and swaps have no paper mode: switch to live to swap.", listed: true }
  }
  return known
}

/** The arguments as they're sent: in paper mode `paper: true`, a boolean; in live mode no `paper` at all. */
export function normaliseForMode(tool: string, args: Record<string, unknown>, mode: Mode): Record<string, unknown> {
  if (tool !== "candle_trade") return args
  const { paper: _dropped, ...rest } = args
  return mode === "paper" ? { ...rest, paper: true } : rest
}

/** Whether a candle_trade result says it went to paper, as a live sell does when the live wallet is empty. */
export function resultWasPaper(result: unknown): boolean {
  const api = (result as { api?: { data?: { paper?: unknown }; paper?: unknown } } | undefined)?.api
  return api?.data?.paper === true || api?.paper === true
}

/** What's wrong between the table and Candle's tool names: empty when they agree. */
export function classificationDrift(toolNames: readonly string[], table: Readonly<Record<string, ToolClass>> = TOOL_CLASSES): string[] {
  const names = new Set(toolNames)
  const problems: string[] = []
  for (const name of toolNames) if (!Object.hasOwn(table, name)) problems.push(`unclassified: ${name}`)
  for (const name of Object.keys(table)) if (!names.has(name)) problems.push(`not a Candle tool: ${name}`)
  return problems
}

/** The tools a running server lists that the table doesn't know, for the core's start-up log. */
export function unclassifiedTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => !Object.hasOwn(TOOL_CLASSES, name))
}

/**
 * Whether the kill switch withdraws and refuses a card: whatever spends or
 * publishes. It keeps what only takes value out or takes something down: sells, unstakes, claims and
 * post deletes. Less access is never stopped. A CLI card row goes by its row: stake add, LP
 * add, a launch and an image upload stop; unstakes, finishes, LP removes and claims, and closing empty
 * accounts (rent back) are kept.
 */
export function pausedStops(card: { kind: CardKind; tool: string; side?: Side; row?: string; words?: readonly string[]; params?: unknown }): boolean {
  // An owner card that widens access or spends, a ceremony that adds a wallet or sends, by the words
  // proposed or the argv a made card's pane runs; a CLI card row by its own rule.
  if (card.tool === "candle_cli" && card.row !== undefined) {
    if (card.kind === "ceremony") return ceremonyStops(card.row, card.words ?? paneArgv(card.params))
    if (card.kind === "funds-out") return FUNDS_OUT_STOPS.has(card.row)
    return rowFor(card.row)?.card?.stops === true || (card.kind === "owner" && OWNER_STOPS.has(card.row))
  }
  switch (card.kind) {
    case "trade":
      return card.side === "buy"
    case "swap":
    case "launch":
      return true
    case "stake":
      return card.tool === "candle_stake"
    case "public":
      return card.tool !== "candle_delete_post"
    default:
      return false
  }
}

/** The command a pane card's params will run: its last step's argv. */
function paneArgv(params: unknown): string[] | undefined {
  const argv = (params as { pane?: { steps?: { argv?: unknown }[] } } | undefined)?.pane?.steps?.at(-1)?.argv
  return Array.isArray(argv) ? (argv as string[]) : undefined
}

/** What a paused core says about a card it stops, when proposed. */
export function pausedMessage(card: { kind: CardKind }): string {
  switch (card.kind) {
    case "launch":
      return "Launches are paused by the kill switch. Sells, unstakes and claims still work; resume to launch."
    case "stake":
      return "Staking is paused by the kill switch. Unstaking and claims still work; resume to stake."
    case "public":
      return "Posts and profile edits are paused by the kill switch. Deleting a post still works; resume to post."
    case "upload":
      return "Image uploads are paused by the kill switch. Sells, unstakes and claims still work; resume to upload."
    case "lp":
      return "Adding liquidity is paused by the kill switch. Removing it and claiming LP fees still work; resume to add."
    case "owner":
      return "Owner steps that widen access or spend are paused by the kill switch. Narrowing access and sending funds home still work; resume to do it."
    case "ceremony":
      return "Importing a wallet and sending a signed transaction are paused by the kill switch. Sells, and signing without sending, still work; resume to do it."
    default:
      return "Buying is paused by the kill switch. Sells still work; resume to buy."
  }
}
