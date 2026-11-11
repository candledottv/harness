// Sending an approved card, and following what happened to it. `operation.submitting` is fsynced
// before the call, so a core that dies mid-call finds it on the next start. The outcome rules are
// written for an MCP client, which can't see HTTP status: an error is decided by its `stage`
// (docs.candle.tv/developers/agent-trading, "Errors" and "Did it reach the chain?"), and anything nobody can
// read is `unknown`, read back by the same id and never re-sent under a new one.
import { terminalText } from "../shared/terminal-text"
import { refused } from "../shared/rpc"
import type { ToolOutcome } from "./candle-mcp"
import type { Card } from "./cards"
import { pausedMessage, pausedStops, resultWasPaper } from "./classify"
import { rowFor } from "./cli-table"
import { type Fill, readFill, receivedOf, swapReceived } from "./fill"
import type { Journal, JournalRow } from "./journal"
import type { Side } from "./limits"
import { nextPollMs, readJob, sequencedFailure, type TradeRead } from "./reconcile"
import { candleJobFailed, notFollowedFurther } from "./trade-log"
import type { OperationState } from "./tool-face"
import { type ChainSlug, chainField, maybeChain, sameAddress, storedChain } from "../shared/chains"
import {
  BRIDGE_FAST_MS,
  BRIDGE_POLL_MS,
  BRIDGE_SLOW_POLL_MS,
  bridgeAnswered,
  bridgeFactsOf,
  bridgeMapped,
  bridgeNotFollowed,
  type BridgeRead,
  embeddedBridgeStatus,
  embeddedPastTwoHours,
  expectedOutOf,
  landingRose,
  nextBridgeReadMs,
  noAnswerMapped,
  unfollowedMapped,
} from "./bridge"
import { requestsOf } from "./key-budget"

/**
 * A debug switch for checking reconciliation: the next trade or swap goes to Candle, and its
 * answer is dropped. It covers the CLI's card rows with a read-back too (a TEE stake, an LP
 * row), and never narrowing access or an owner step, which have none.
 */
export const DEBUG_LOSE_NEXT_REPLY = "CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY"
export const losesNextReply = (env: Record<string, string | undefined>): boolean => env[DEBUG_LOSE_NEXT_REPLY] === "1"
/** What the core, the doctor and the status bar say while it's on. */
export const LOSE_NEXT_REPLY_NOTE = `${DEBUG_LOSE_NEXT_REPLY}=1: the answer to the next live trade, swap or CLI card row is dropped, once, to test reconciliation`

export interface OperationError {
  code: string
  message: string
  retryable: boolean
  stage?: string
  /** KEY_LIMIT_REACHED: when the key's window resets (epoch ms), or null for a lifetime cap. */
  resetsAt?: number | null
  /** KEY_LIMIT_REACHED's `limit_unavailable`: Candle couldn't value the trade or read the key's use. */
  reason?: string
  /** With `limit_unavailable`: when to ask again (epoch ms), about 30 s out. */
  retryAfter?: number
  /** SWAP_ROUTE_FAILING: how long Candle refuses the pair from this key. */
  retryAfterSeconds?: number
}

/** SWAP_ROUTE_FAILING's wait, wherever Candle or the CLI put it. */
export function routeWaitFields(raw: Record<string, unknown>): Pick<OperationError, "retryAfterSeconds"> {
  const details = typeof raw.details === "object" && raw.details !== null ? (raw.details as Record<string, unknown>) : {}
  const seconds = "retry_after_seconds" in raw ? raw.retry_after_seconds : details.retry_after_seconds
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}
}

/** The fields a held key needs from Candle's error body, wherever Candle or the CLI put them. */
export function keyLimitFields(raw: Record<string, unknown>): Pick<OperationError, "resetsAt" | "reason" | "retryAfter"> {
  const details = typeof raw.details === "object" && raw.details !== null ? (raw.details as Record<string, unknown>) : {}
  const pick = (name: string) => (name in raw ? raw[name] : details[name])
  const resetsAt = pick("resetsAt")
  const reason = pick("reason")
  const retryAfter = pick("retryAfter")
  return {
    ...(typeof resetsAt === "number" || resetsAt === null ? { resetsAt: resetsAt as number | null } : {}),
    ...(typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason) ? { reason } : {}),
    ...(typeof retryAfter === "number" ? { retryAfter } : {}),
  }
}

export interface Operation {
  opId: string
  cardId: string
  kind: Card["kind"]
  tool: string
  agent: string
  mode: Card["mode"]
  params: Record<string, unknown>
  /** The chain it acts on, as its card had it. */
  chain?: ChainSlug
  state: OperationState
  startedAt: number
  /** When it reached an end (succeeded, failed, refused, abandoned): the receipt's "filled in 4.2 s". */
  settledAt?: number
  /** The card's expiry: a swap is replayed on the core's own only before it. */
  cardExpiresAt: number
  result?: unknown
  error?: OperationError
  /** Candle ran it as paper: a live sell of a mint the live wallet didn't hold. */
  paper?: boolean
  /** A swap whose second leg failed: the first leg landed, with this hash. */
  partial?: { leg1: string }
  /** Why it's unknown: no answer, a restart, a stage that may have landed. */
  reason?: string
  /**
   * "cli": a TEE wallet's trade or swap, run through `candle swap`. "pane": run by the
   * prompt pane's launcher, settled by its report and never re-sent. Unset is
   * Candle's MCP child.
   */
  route?: "cli" | "pane"
  /** The wallet that pays, by address, on the CLI route. */
  wallet?: string
  /** The card's side: whether the kill switch stops a re-send of it. */
  side?: Side
  /** A re-send of it is in flight: the views offer no second one. */
  resending?: boolean
  /** Its read-back is a replay or a rerun, which re-sends it under its id: held while the kill switch stops its kind. */
  held?: boolean
  /** A rules bot's exit, sold without a card: one a restart cut off is re-sent once by the core (resendLostExit). */
  botExit?: boolean
  /** The core has re-sent it once by itself: it never does again; anything more is the person's. */
  autoResent?: boolean
  /** The asset its card worked out it settles in: its fill is read in it when Candle's answer names none. */
  settles?: string
  /**
   * A Hood TEE wallet's trade waiting for the wallet's last one: Candle runs one operation at a time on it (WALLET_BUSY),
   * so it's sent when the one it's behind settles. Nothing has been sent while this is set.
   */
  waitingFor?: string
  /** An embedded bridge: the landing wallet's balance of what it brings, read before it was sent, in raw units. */
  landingBefore?: string
}

/** Whether an operation runs through a wallet Candle lets run one operation at a time: an EVM chain's TEE wallet. */
const oneAtATime = (op: Pick<Operation, "route" | "wallet" | "chain">): boolean => op.route === "cli" && op.wallet !== undefined && maybeChain(op.chain)?.family === "evm"

/** The longest Candle holds a Hood TEE wallet for one operation: its lock goes on completion, failure, or after 30 minutes. */
export const WALLET_HOLD_MS = 30 * 60_000

/** A job's status where an answer carries one: the job itself, or the body around it. */
function jobStatusOf(result: unknown): unknown {
  const body = typeof result === "object" && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined
  const job = typeof body?.job === "object" && body.job !== null ? (body.job as Record<string, unknown>) : body
  return job?.status
}

/**
 * Whether Candle has let an operation's wallet go, whatever state the core gives it: its job ended (`failed`, which
 * may still have filled, or `confirmed`), or a bridge's deposit landed (Relay fills from its own wallet), or Candle
 * can't say more of a bridge (uncertain, or past its two hours).
 */
function candleLetGo(op: Pick<Operation, "kind" | "result" | "error">): boolean {
  const status = jobStatusOf(op.result)
  if (status === "failed" || status === "confirmed") return true
  if (op.kind !== "bridge") return false
  if (op.error?.code === "BRIDGE_UNCERTAIN" || op.error?.code === "BRIDGE_PAST_TWO_HOURS") return true
  const stands = (op.result as { bridgeStatus?: { phase?: unknown; landed?: unknown } } | undefined)?.bridgeStatus
  return stands?.landed === true || stands?.phase === "filling" || stands?.phase === "filled"
}

/** What one read of an open bridge asks of its key: a TEE bridge's status read, or an embedded one's portfolio read (its balance), or its replay. */
export function bridgeReadRequests(op: Pick<Operation, "route" | "result">): number {
  return op.route !== "cli" && bridgeAnswered(op.result) ? requestsOf("candle_get_portfolio") : 1
}

export interface Mapped {
  state: OperationState
  result?: unknown
  error?: OperationError
  paper?: boolean
  partial?: { leg1: string }
  reason?: string
}

const PENDING = new Set(["pending", "running", "built", "submitted", "confirming", "processing", "queued", "building", "broadcasting"])
const NOT_SENT_STAGES = new Set(["not_broadcast", "presign_refused"])
/** Refused by this side before anything went to Candle. */
const LOCAL_REFUSALS = new Set(["MCP_VALIDATION", "CANDLE_MCP_DOWN"])
/** The kinds that run through Candle's own card tools, whose errors have rules of their own below. */
const MCP_CARD_KINDS: ReadonlySet<Card["kind"]> = new Set(["launch", "stake", "claim", "public"])
/**
 * Answers that say the same id is still running: read it again, never under a new id
 * (docs.candle.tv/developers/agent-trading, "CNDL staking"; docs.candle.tv/developers/claims, "CNDL staking rewards").
 */
const STILL_RUNNING = new Set(["STAKING_TRANSACTION_PENDING", "REWARD_CLAIM_PENDING"])
/**
 * Failures after the checks, which may have run. LAUNCH_FAILED includes a confirmation timeout
 * (docs.candle.tv/developers/headless-launch, "Errors"); a reward claim's failure "still pays at most once"
 * (docs.candle.tv/developers/claims); an error nobody could read says nothing.
 */
const MAY_HAVE_RUN = new Set(["LAUNCH_FAILED", "SWAP_FAILED", "STAKING_REWARD_CLAIM_FAILED", "UNKNOWN_ERROR"])
/**
 * A trade or swap error with no stage is taken as "nothing was sent" only for these: answers Candle
 * documents as given before a transaction is planned, signed or sent (docs.candle.tv/developers/agent-trading,
 * "Errors" and "How each execution outcome is reported"). Any other
 * code with no stage, `candle mcp`'s own UNKNOWN_ERROR for a body it couldn't read and a bare SWAP_FAILED
 * among them, may have been sent: it's read back by its id, never released for the same trade to go again.
 */
/**
 * Of SENT_NOTHING, the codes whose `retryable: true` Candle documents as "ask again later, nothing was sent":
 * a rate limit, and a key limit with its reset. Any other listed code that comes back retryable with no stage is
 * read back by its id, since Candle uses some of them (VALIDATION_FAILED among them) for a generic retryable
 * server error too, and a code alone doesn't prove nothing went out.
 */
const RETRYABLE_SENT_NOTHING: ReadonlySet<string> = new Set(["RATE_LIMITED", "KEY_LIMIT_REACHED"])

/**
 * Retryable with no stage, and still nothing sent: the codes above, and Candle's route breaker refusing a pair with
 * its own wait (SWAP_ROUTE_FAILING carrying `retry_after_seconds`, docs.candle.tv's route breaker), which refuses
 * before any swap is built. A bare SWAP_ROUTE_FAILING with no wait is read back like any other.
 */
function retryableSentNothing(code: string, raw: Record<string, unknown>): boolean {
  return RETRYABLE_SENT_NOTHING.has(code) || (code === "SWAP_ROUTE_FAILING" && routeWaitFields(raw).retryAfterSeconds !== undefined)
}

const SENT_NOTHING: ReadonlySet<string> = new Set([
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "SCOPE_MISSING",
  "KEY_EXPIRED",
  "TEST_ENVIRONMENT_FORBIDDEN",
  "TIER_REQUIRED",
  "MARKET_NOT_FOUND",
  "MARKET_NOT_TRADABLE",
  "TOKEN_NOT_FOUND",
  "TOKEN_NOT_LIVE",
  "TOKEN_NOT_TRADABLE",
  "NO_ROUTES_FOUND",
  "COULD_NOT_FIND_ANY_ROUTE",
  "CIRCULAR_ARBITRAGE_IS_DISABLED",
  "QUOTE_UNAVAILABLE",
  "QUOTE_PAIR_UNKNOWN",
  "KEY_LIMIT_REACHED",
  "SPEND_LIMIT_EXCEEDED",
  "SPEND_POLICY_DENIED",
  "RISK_LIMIT_REACHED",
  "PROFILE_PAUSED",
  "RATE_LIMITED",
  "WALLET_BUSY",
  "SWAP_ROUTE_FAILING",
  "EMBEDDED_WALLET_NOT_PERMITTED",
  "DELEGATION_REVOKED",
  "AGENT_WALLET_MISSING",
  "INSUFFICIENT_OWNER_BALANCE",
])
/** The tools whose same id and body replay the stored result, never running twice: read back by replaying. */
const REPLAYS = new Set(["candle_swap", "candle_stake", "candle_unstake", "candle_finish_unstake", "candle_claim_staking_reward"])

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Plain messages for the refusals a trader meets, from docs.candle.tv/developers/agent-trading and docs.candle.tv/developers/agent-access.
 * `chain` is the operation's own, where a message names the chain's asset; none is Solana, as a stored row reads.
 */
export function refusalMessage(code: string, error: Record<string, unknown>, chain?: ChainSlug): string | undefined {
  switch (code) {
    case "INSUFFICIENT_OWNER_BALANCE": {
      // Candle's own text names the wallet's address at most; it never says that funding it fixes this.
      const asset = maybeChain(chain)?.native.symbol ?? "SOL"
      return `The wallet paying doesn't hold enough ${asset} for this trade and its fees. Nothing was sent. Send ${asset} to it (its address is in the Wallets pane, ⧉), or trade less.`
    }
    case "EMBEDDED_WALLET_NOT_PERMITTED":
      return "This agent's key isn't allowed to trade from the account's embedded wallet. The owner allows it with candle keys update <prefix> --embedded-wallet allow."
    case "DELEGATION_REVOKED":
      return "Candle can no longer sign for the embedded wallet: its delegation was revoked. Nothing was sent. Reconnect the wallet in the Candle app."
    case "PROFILE_PAUSED":
      return "Candle has this agent paused. Nothing was sent. The owner resumes it."
    case "RISK_LIMIT_REACHED":
      // A loss limit or the circuit breaker (docs.candle.tv/developers/agent-trading, "RISK_LIMIT_REACHED"): no window clears it.
      return "Candle stopped this agent's key (a loss limit or its circuit breaker), sells included, until the owner resumes it in Candle's Agent Console. Nothing was sent."
    case "KEY_EXPIRED":
      return "This agent's key has expired. Only a new key fixes that."
    case "KEY_LIMIT_REACHED": {
      // Not a spent cap: Candle couldn't value the trade or read the key's use, and asks again in about
      // 30 s (docs.candle.tv/developers/agent-trading, "A main-payer trade holds txLimit as a hard cap").
      if (keyLimitFields(error).reason === "limit_unavailable") return "Candle couldn't check this agent's key limit just now (its price or usage read was down). Nothing was sent. Try again in about 30 seconds."
      // Candle's cap counts USD volume, buys, sells and swaps alike, and never refuses a token sell
      // (docs.candle.tv/developers/agent-access, "Transaction limits"), so the refusal says so, rather than showing the Candle Harness's own
      // buys-only figure, and gives the reset in UTC, named.
      // The reset may be under `details` (the CLI route), or not given at all: only null is a lifetime cap.
      const resetsAt = keyLimitFields(error).resetsAt
      const at = typeof resetsAt === "number" ? new Date(resetsAt).toISOString() : undefined
      const when = at ? ` It resets at ${at.slice(11, 16)} UTC on ${at.slice(0, 10)}.` : resetsAt === null ? " It has no window, so it doesn't reset." : ""
      return `This agent's Candle key limit is used up: Candle counts buys, sells and swaps against it, so it can be reached before the Candle Harness's own day limit, which counts buys and swaps. Selling a token still works.${when} Nothing was sent.`
    }
    case "SPEND_LIMIT_EXCEEDED":
      return "Over this key's per-trade spend cap on Candle. Nothing was sent; a smaller amount can go."
    case "TIER_REQUIRED":
      return "Buying a token Candle didn't launch needs Pro or Max. Nothing was sent."
    case "RATE_LIMITED":
      return "Candle is rate-limiting this key. Nothing was sent; try again in a moment."
    case "SWAP_ROUTE_FAILING": {
      // Candle's route breaker: five failed swaps in a row of one token and side, from this key.
      const s = routeWaitFields(error).retryAfterSeconds
      return `Candle is refusing this token on this side from this key for now: its last five swaps of it failed. Nothing was sent.${s ? ` It can be tried again in ${s < 120 ? `${Math.ceil(s)} s` : `${Math.ceil(s / 60)} minutes`}.` : ""} Other tokens aren't affected.`
    }
    case "TEST_ENVIRONMENT_FORBIDDEN":
      return "A test key can't trade. Nothing was sent; use a live key."
    case "IDEMPOTENCY_CONFLICT":
      return "Candle already holds a different request under this id. Nothing new was sent."
    default:
      return undefined
  }
}

/** A child's outcome for a card's tool call, as an operation state. */
export function outcomeOf(kind: Card["kind"], outcome: ToolOutcome, chain?: ChainSlug): Mapped {
  if (outcome.kind === "lost") return { state: "unknown", reason: `no answer (${outcome.reason.replace("_", " ")})` }
  const body = record(outcome.kind === "ok" ? outcome.result : outcome.body)
  // candle_trade and candle_launch_and_seed wrap the API body under `api`; the swap and the rest use
  // the envelope itself (docs.candle.tv/developers/mcp-server, "Error shapes").
  const api = (kind === "trade" || kind === "launch") && body && record(body.api) ? record(body.api)! : body

  if (outcome.kind === "ok") {
    const status = typeof api?.status === "string" ? api.status.toLowerCase() : ""
    const paper = kind === "trade" && resultWasPaper(outcome.result)
    if (status === "failed") return { state: "failed", result: outcome.result, error: errorOf("OPERATION_FAILED", record(api?.error) ?? {}, chain) }
    return { state: PENDING.has(status) ? "pending" : "succeeded", result: outcome.result, ...(paper ? { paper } : {}) }
  }

  const raw = record(api?.error) ?? {}
  const code = outcome.code
  const error = errorOf(code, raw, chain)
  if (LOCAL_REFUSALS.has(code)) return { state: "refused", error }
  if (MCP_CARD_KINDS.has(kind)) {
    if ((code === "IDEMPOTENCY_CONFLICT" && outcome.retryable) || STILL_RUNNING.has(code)) return { state: "pending", result: outcome.body, error }
    // An atomic launch's bundle (candle_launch_and_seed with a seed): `failed` landed neither leg,
    // `timeout` may still land (agentic orchestrate.ts, launchAndSeedAtomic).
    if (kind === "launch" && typeof body?.bundleId === "string") {
      if (api?.status === "failed") return { state: "failed", result: outcome.body, error }
      if (api?.status === "timeout") return { state: "unknown", result: outcome.body, error, reason: "the bundle may still land" }
    }
    if (MAY_HAVE_RUN.has(code) && raw.stage === undefined) return { state: "unknown", result: outcome.body, error, reason: "it may have run" }
  }
  if (code === "LEG2_FAILED") {
    const leg1 = record(body?.payload)?.leg1 ?? raw.leg1
    return { state: "failed", result: outcome.body, error, ...(typeof leg1 === "string" ? { partial: { leg1 } } : {}) }
  }
  const stage = typeof raw.stage === "string" ? raw.stage : undefined
  if (stage === undefined && (kind === "trade" || kind === "swap")) {
    // A retryable conflict says the same id is still running; one that isn't says a different body, nothing new sent.
    const sentNothing = code === "IDEMPOTENCY_CONFLICT" ? !outcome.retryable : SENT_NOTHING.has(code) && (!outcome.retryable || retryableSentNothing(code, raw))
    if (!sentNothing) return { state: "unknown", result: outcome.body, error, reason: `${code} without a stage, so it may have been sent` }
  }
  if (stage === undefined || NOT_SENT_STAGES.has(stage)) return { state: "refused", result: outcome.body, error }
  if (stage === "unconfirmed") return { state: "unknown", result: outcome.body, error, reason: "it may have reached the chain" }
  if (stage === "executed") return { state: "succeeded", result: outcome.body, error }
  if (stage === "reverted") return { state: "failed", result: outcome.body, error }
  // A stage this code doesn't know: execution began, so nothing can be assumed.
  return { state: "unknown", result: outcome.body, error, reason: `stage ${stage}` }
}

function errorOf(code: string, raw: Record<string, unknown>, chain?: ChainSlug): OperationError {
  const serverText = typeof raw.message === "string" ? terminalText(raw.message, { maxLength: 500 }) : code
  return {
    code,
    message: refusalMessage(code, raw, chain) ?? serverText,
    retryable: raw.retryable === true,
    ...(typeof raw.stage === "string" ? { stage: raw.stage } : {}),
    ...(code === "KEY_LIMIT_REACHED" ? keyLimitFields(raw) : {}),
    ...(code === "SWAP_ROUTE_FAILING" ? routeWaitFields(raw) : {}),
  }
}

const SETTLED: ReadonlySet<OperationState> = new Set(["succeeded", "failed", "refused", "abandoned"])
/** A trade that waited for its wallet past its card's time: refused, never sent at a price nobody saw. */
const WAITED_TOO_LONG: OperationError = { code: "WAITED_TOO_LONG", message: "It waited for the wallet's last trade past its card's 60 s, so it wasn't sent at the price the card showed. Nothing was sent; ask for it again.", retryable: false }
/** The operations one snapshot or list carries: under an attach message's megabyte, with room for its envelope. */
export const OPERATIONS_LIST_BYTES = 768 * 1024
const TEN_MINUTES = 10 * 60_000
export const CALL_TIMEOUT_MS = 60_000

type Child = { call(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ToolOutcome> }

/** The tool Candle's server runs an operation as: an embedded bridge is Candle's candle_swap between the account's two embedded wallets. */
const mcpTool = (op: Pick<Operation, "kind" | "tool">): string => (op.kind === "bridge" ? "candle_swap" : op.tool)
/** What's sent to Candle: a bridge's own words for its end (`bridge`) stay with the card. */
function mcpParams(op: Pick<Operation, "kind" | "params">): Record<string, unknown> {
  if (op.kind !== "bridge") return op.params
  const { bridge: _facts, ...rest } = op.params
  return rest
}
/** How Candle's answer is read: an embedded bridge's is candle_swap's. */
const mcpKind = (op: Pick<Operation, "kind">): Card["kind"] => (op.kind === "bridge" ? "swap" : op.kind)

/** A CLI card row with a read-back (cli-table.ts `card.readBack`): what the debug switch may drop. */
function readsBack(op: Operation): boolean {
  const readBack = readBackOf(op)
  return readBack !== undefined && readBack !== "none"
}

/** Candle's answer for an id it has no record of; any other miss (no answer, its child not up) says nothing about the trade. */
const NO_RECORD = "JOB_NOT_FOUND"

/** Who re-sent it, on the `operation.resend` row, when the core did by itself. */
export const CORE_RESEND = "core"

/** A CLI card row's read-back rule (cli-table.ts `card.readBack`), or undefined for anything else. */
function readBackOf(op: Operation): string | undefined {
  const row = (op.params as { row?: unknown }).row
  return typeof row === "string" ? rowFor(row)?.card?.readBack : undefined
}

export class Operations {
  private stopped = false
  private readonly ops = new Map<string, Operation>()
  private readonly watches = new Map<string, () => void>()
  /** Operations a person's re-send or abandon is working on: a second click waits for the first. */
  private readonly resolving = new Set<string>()
  private loseNext: boolean

  constructor(
    private readonly deps: {
      journal: Journal
      pool: { for(agent: string): Child }
      now: () => number
      /** Timer seam; tests drive it by hand. */
      schedule?: (run: () => Promise<void> | void, ms: number) => () => void
      onChange?: (op: Operation) => void
      /** CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: the next trade or swap goes to Candle, and its answer is dropped. */
      loseNextReply?: boolean
      /** Runs an approved candle_cli card (cli-tool.ts): narrowing access, or one of the CLI's card rows. */
      cli?: (op: Operation) => Promise<Mapped>
      /** Reads a CLI card row back by its rule (cli-cards.ts), or undefined when there's none to make now. */
      cliRead?: (op: Operation) => Promise<{ mapped: Mapped; detail: string } | undefined>
      /** Runs and reads back a TEE wallet's trade, swap or bridge (cli-trade.ts). */
      cliTrades?: { execute(op: Operation): Promise<Mapped>; read(op: Operation): Promise<TradeRead>; readBridge?(op: Operation): Promise<BridgeRead> }
      /** Whether the key's budget has room for one read of an open bridge now (`requests` of Candle's); with none, it's read at its next turn. */
      bridgeBudget?: (agent: string, requests?: number) => boolean
      /** An embedded bridge's landing wallet's balance of what it brings, in raw units; undefined when it can't be read. */
      bridgeLanding?: (op: Operation) => Promise<bigint | undefined>
      /** Runs an approved Hacc card, and reads one nobody saw end back from Hacc's state. */
      hacc?: { run(op: Operation): Promise<Mapped>; read(op: Operation): Promise<Mapped | undefined> }
      /** Runs an approved narrowing of a wallet's autonomy in the core, and reads one a restart cut off. */
      autonomy?: { run(op: Operation): Promise<Mapped>; read(op: Operation): Mapped | undefined }
      /** Saves an approved trigger's card, checked whole again, and reads one a restart cut off from triggers.toml. */
      triggers?: { run(op: Operation): Promise<Mapped>; read(op: Operation): Mapped | undefined }
      /** A rules bot's card, approved: saved, or flattened, in the core. */
      bots?: { run(op: Operation): Promise<Mapped>; read(op: Operation): Mapped | undefined }
      /** Whether the kill switch is on: what it stops is never sent again by a re-send or a replay while it is. */
      paused?: () => boolean
      /**
       * What holds the core's own re-send of a bot's exit now, in words, as any other sell of the core's is held: two
       * failed sells of its token on the key, another sell of it in flight, or the key's pace. Undefined is room.
       */
      resendHold?: (op: Operation) => string | undefined
      /** A pair asset's USD price from the prices the core already holds (no read), stamped on a trade's fill. */
      assetUsd?: (asset: string) => number | undefined
    },
  ) {
    this.loseNext = deps.loseNextReply === true
  }

  /** Whether the debug switch will still drop an answer: the status bar says so until it has. */
  losingNextReply(): boolean {
    return this.loseNext
  }

  get(opId: string): Operation | undefined {
    return this.ops.get(opId)
  }

  list(): Operation[] {
    return [...this.ops.values()]
  }

  /**
   * The operations a view or a harness is sent, in order: every one not yet at an end, then the newest ended
   * ones while they fit `maxBytes`, so one message never outgrows what the attach interface carries.
   */
  listWithin(maxBytes = OPERATIONS_LIST_BYTES, keep: (op: Operation) => boolean = () => true): Operation[] {
    const all = [...this.ops.values()].filter(keep)
    const size = (op: Operation) => Buffer.byteLength(JSON.stringify(op), "utf8") + 1
    const chosen = new Set<Operation>()
    let used = 0
    for (const op of all) {
      if (SETTLED.has(op.state)) continue
      chosen.add(op)
      used += size(op)
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const op = all[i]!
      if (chosen.has(op)) continue
      const bytes = size(op)
      if (used + bytes > maxBytes) break
      chosen.add(op)
      used += bytes
    }
    return all.filter((op) => chosen.has(op))
  }

  /** The bridges being followed now: sent, and not yet ended or left in their own words. */
  openBridges(): Operation[] {
    return [...this.ops.values()].filter((op) => op.kind === "bridge" && op.route !== "pane" && (op.state === "pending" || op.state === "unknown") && !bridgeNotFollowed(op.error?.code))
  }

  /** Whether anything is in flight or still being read back: the core stays up for it. */
  busy(): boolean {
    return this.watches.size > 0 || [...this.ops.values()].some((op) => op.state === "submitting")
  }

  /** Set while a restart rebuilds from the journal: an operation settled then wakes nothing waiting behind it. */
  private rebuilding = false

  stop(): void {
    this.stopped = true
    for (const cancel of this.watches.values()) cancel()
    this.watches.clear()
  }

  /**
   * Write-ahead `operation.submitting`, then the call, then the outcome. The id never changes. A Hood TEE wallet's trade
   * whose wallet is running another first waits, written down as `operation.waiting`, and returns at once; it's sent
   * when that one settles (`wake`).
   */
  async execute(card: Card): Promise<Operation> {
    const now = this.deps.now()
    const op: Operation = {
      opId: card.opId,
      cardId: card.cardId,
      kind: card.kind,
      tool: card.tool,
      agent: card.agent,
      mode: card.mode,
      params: card.params,
      ...(card.chain ? { chain: card.chain } : {}),
      state: "submitting",
      startedAt: now,
      cardExpiresAt: Date.parse(card.expiresAt),
      ...(card.route === "cli" ? { route: "cli" as const, wallet: card.wallet } : {}),
      ...(card.side ? { side: card.side } : {}),
      ...(card.origin?.role === "core" && card.origin.bot?.act === "exit" ? { botExit: true } : {}),
      ...(card.settles ? { settles: card.settles } : {}),
    }
    const behind = oneAtATime(op) ? this.lastOnWallet(op) : undefined
    if (behind) {
      op.waitingFor = behind.opId
      this.ops.set(op.opId, op)
      try {
        await this.deps.journal.append({ type: "operation.waiting", mode: op.mode, ...this.writeAhead(op), behind: behind.opId })
      } catch (error) {
        this.ops.delete(op.opId)
        throw error
      }
      this.deps.onChange?.(op)
      this.waitTimer(op)
      return op
    }
    return this.submit(op)
  }

  /** The operation's write-ahead fields, as `operation.submitting` and `operation.waiting` carry them for a restart to rebuild. */
  private writeAhead(op: Operation): Record<string, unknown> {
    return {
      mode: op.mode,
      agent: op.agent,
      opId: op.opId,
      cardId: op.cardId,
      kind: op.kind,
      tool: op.tool,
      params: op.params,
      ...(op.chain ? { chain: op.chain } : {}),
      cardExpiresAt: op.cardExpiresAt,
      ...(op.route ? { route: op.route, wallet: op.wallet } : {}),
      ...(op.side ? { side: op.side } : {}),
      ...(op.botExit ? { botExit: true } : {}),
      ...(op.settles ? { settles: op.settles } : {}),
    }
  }

  /**
   * Whether a sent operation still holds its one-at-a-time wallet, as Candle's own lock does: until it has an end, or
   * Candle has let the wallet go (candleLetGo), or 30 minutes have passed since it was sent. Its own state stays as it
   * is ("may have filled" included); only the queue behind it moves.
   */
  private holds(op: Operation): boolean {
    if (SETTLED.has(op.state) || op.waitingFor !== undefined) return false
    if (this.deps.now() - op.startedAt >= WALLET_HOLD_MS) return false
    return !candleLetGo(op)
  }

  /** The newest operation on the same one-at-a-time wallet that holds it or waits for it, or none. */
  private lastOnWallet(op: Operation): Operation | undefined {
    let last: Operation | undefined
    for (const other of this.ops.values()) {
      if (other.opId === op.opId || !oneAtATime(other) || !sameAddress(other.wallet, op.wallet) || SETTLED.has(other.state)) continue
      if (other.waitingFor === undefined && !this.holds(other)) continue
      if (!last || other.startedAt >= last.startedAt) last = other
    }
    return last
  }

  /**
   * A waiting trade's own timer: at its card's end it's refused in words, never left waiting; before that, when what
   * holds its wallet reaches its 30 minutes, the wallet is woken.
   */
  private waitTimer(op: Operation): void {
    if (this.stopped) return
    const now = this.deps.now()
    const holders = [...this.ops.values()].filter((o) => o.opId !== op.opId && oneAtATime(o) && sameAddress(o.wallet, op.wallet) && this.holds(o))
    const freed = Math.min(...holders.map((o) => o.startedAt + WALLET_HOLD_MS))
    const due = Math.min(op.cardExpiresAt, freed)
    const run = async () => {
      this.watches.delete(op.opId)
      if (op.waitingFor === undefined || SETTLED.has(op.state)) return
      if (this.deps.now() >= op.cardExpiresAt) {
        delete op.waitingFor
        await this.settle(op, { state: "refused", error: WAITED_TOO_LONG })
        return
      }
      await this.wake(op.wallet!)
      if (op.waitingFor !== undefined && !SETTLED.has(op.state)) this.waitTimer(op)
    }
    this.watches.set(op.opId, this.schedule(run, Math.max(0, due - now)))
  }

  /**
   * The next trade waiting on a wallet that's now free: the oldest, once nothing else on the wallet is running. The kill
   * switch refuses a waiting buy, as it refuses one mid-approval; a card past its 60 s waited too long to run at its price.
   */
  private async wake(wallet: string): Promise<void> {
    const onWallet = [...this.ops.values()].filter((o) => oneAtATime(o) && sameAddress(o.wallet, wallet) && !SETTLED.has(o.state))
    if (onWallet.some((o) => o.waitingFor === undefined && this.holds(o))) return
    const next = onWallet.filter((o) => o.waitingFor !== undefined).sort((a, b) => a.startedAt - b.startedAt)[0]
    if (!next) return
    delete next.waitingFor
    this.cancelWatch(next.opId)
    if (this.stoppedByPause(next)) {
      await this.settle(next, { state: "refused", error: { code: "PAUSED", message: `${pausedMessage(next).split(". ")[0]}. The kill switch went on while it waited for the wallet's last trade, so nothing was sent.`, retryable: false } })
      return
    }
    if (this.deps.now() > next.cardExpiresAt) {
      await this.settle(next, { state: "refused", error: WAITED_TOO_LONG })
      return
    }
    await this.submit(next, { waited: true })
  }

  /** Every trade waiting for its wallet, refused with nothing sent: the kill switch's, for each it stops. */
  async refuseWaiting(): Promise<Operation[]> {
    const out: Operation[] = []
    for (const op of [...this.ops.values()]) {
      if (op.waitingFor === undefined || SETTLED.has(op.state) || !this.stoppedByPause(op)) continue
      delete op.waitingFor
      await this.settle(op, { state: "refused", error: { code: "PAUSED", message: `${pausedMessage(op).split(". ")[0]}. The kill switch went on while it waited for the wallet's last trade, so nothing was sent.`, retryable: false } })
      out.push(op)
    }
    return out
  }

  /** The write-ahead row, the call, and the outcome. */
  private async submit(op: Operation, opts: { waited?: boolean } = {}): Promise<Operation> {
    if (opts.waited) op.startedAt = this.deps.now()
    // An embedded bridge's landing wallet, read before it goes: Candle's answer comes before Relay's fill, and its rise is how the fill is seen.
    if (op.kind === "bridge" && op.route === undefined && op.landingBefore === undefined && this.deps.bridgeLanding) {
      const before = await this.deps.bridgeLanding(op).catch(() => undefined)
      if (before !== undefined) op.landingBefore = before.toString()
    }
    this.ops.set(op.opId, op)
    try {
      await this.deps.journal.append({
        type: "operation.submitting",
        mode: op.mode,
        agent: op.agent,
        opId: op.opId,
        cardId: op.cardId,
        kind: op.kind,
        tool: op.tool,
        params: op.params,
        ...(op.chain ? { chain: op.chain } : {}),
        cardExpiresAt: op.cardExpiresAt,
        ...(op.route ? { route: op.route, wallet: op.wallet } : {}),
        ...(op.side ? { side: op.side } : {}),
        ...(op.botExit ? { botExit: true } : {}),
        ...(op.settles ? { settles: op.settles } : {}),
        ...(op.landingBefore !== undefined ? { landingBefore: op.landingBefore } : {}),
      })
    } catch (error) {
      // Nothing was sent: the operation isn't left submitting for ever, and the approval sees the failure.
      this.ops.delete(op.opId)
      if (opts.waited) {
        // One that waited has no approval to see it: it's refused in words, and the next one behind it may go.
        await this.settle(op, { state: "refused", error: { code: "JOURNAL_FAILED", message: "The core couldn't write it down before sending it, so nothing was sent.", retryable: false } }).catch(() => {})
        return op
      }
      throw error
    }
    this.deps.onChange?.(op)
    // The kill switch pressed while this was being written down: the kill can't withdraw a card mid-approval.
    if (await this.refusedByPause(op)) return op
    const mapped = await this.sendMapped(op)
    await this.settle(op, mapped)
    // A bridge's end said in its own words is read no further.
    if (op.state === "unknown" && !bridgeNotFollowed(op.error?.code)) this.watch(op, 0)
    // A bridge's deposit is out: it's followed every 10 s, as the CLI's own wait reads a TEE bridge.
    else if (op.state === "pending") this.watch(op, op.kind === "bridge" ? BRIDGE_POLL_MS : 5_000)
    return op
  }

  /**
   * A card that runs in the prompt pane: nothing is sent here. The write-ahead row,
   * then pending while the pane is open; its report settles it (settlePane). Nothing re-runs it.
   */
  async beginPane(card: Card, detail: { ticketId: string }): Promise<Operation> {
    const op: Operation = {
      opId: card.opId,
      cardId: card.cardId,
      kind: card.kind,
      tool: card.tool,
      agent: card.agent,
      mode: card.mode,
      params: card.params,
      ...chainField(card.chain),
      state: "submitting",
      startedAt: this.deps.now(),
      cardExpiresAt: Date.parse(card.expiresAt),
      route: "pane",
    }
    this.ops.set(op.opId, op)
    await this.deps.journal.append({ type: "operation.submitting", mode: op.mode, agent: op.agent, opId: op.opId, cardId: op.cardId, kind: op.kind, tool: op.tool, params: op.params, ...(op.chain ? { chain: op.chain } : {}), cardExpiresAt: op.cardExpiresAt, route: "pane", ticketId: detail.ticketId })
    await this.settle(op, { state: "pending", reason: "in the prompt pane" })
    return op
  }

  /** The pane's outcome: the only way a pane operation settles. A second report is refused. */
  async settlePane(opId: string, mapped: Mapped): Promise<Operation> {
    const op = this.ops.get(opId)
    if (!op || op.route !== "pane") throw refused("OPERATION_NOT_FOUND", "No pane operation with that id.")
    if (op.state !== "pending") throw refused("OPERATION_SETTLED", `This operation is ${op.state}.`, { state: op.state })
    await this.settle(op, mapped)
    return op
  }

  /** The user's call on an unknown operation: the same request under the same id, or stop following it. */
  async resolve(viewClientId: string, opId: unknown, action: "resend" | "abandon", why?: string): Promise<Operation> {
    const op = typeof opId === "string" ? this.ops.get(opId) : undefined
    if (!op) throw refused("OPERATION_NOT_FOUND", "No operation with that id.")
    if (op.state !== "unknown" && op.state !== "pending") throw refused("OPERATION_SETTLED", `This operation is ${op.state}.`, { state: op.state })
    // A pane step is the user's to run again, in the pane, never the core's.
    if (action === "resend" && op.route === "pane") throw refused("NO_RESEND", "A step run in the prompt pane is never re-sent by the Candle Harness. Check what it changed, then ask for it again if it's needed.")
    if (op.state === "pending" && op.route === "pane") throw refused("PANE_OPEN", "This step's pane is still open: its outcome comes from the pane.")
    // A Hacc change is read back from Hacc's state, never sent again: a second rule would be a second rule.
    if (action === "resend" && op.kind === "hacc") throw refused("NO_RESEND", "A Hacc change is read back from Hacc, never sent again. Abandon it, then ask for it again if it didn't happen.")
    // A second click, a second view or a typed `resend` while one is still out would send it again.
    if (this.resolving.has(op.opId)) throw refused("OPERATION_BUSY", "It's being re-sent: its answer settles it here.")
    // A re-send of a request that never reached Candle is its first send: the kill switch stops it, as it stops approving.
    if (action === "resend" && this.stoppedByPause(op)) throw refused("PAUSED", `${pausedMessage(op).split(". ")[0]}. Resume to re-send it, or abandon it. Nothing was sent.`)
    this.cancelWatch(op.opId)
    if (action === "abandon") {
      await this.settle(op, { state: "abandoned", reason: `abandoned by ${viewClientId}` })
      return op
    }
    this.resolving.add(op.opId)
    op.resending = true
    this.deps.onChange?.(op)
    try {
      await this.deps.journal.append({ type: "operation.resend", mode: op.mode, agent: op.agent, opId: op.opId, by: viewClientId, params: op.params, ...(why ? { why } : {}) })
      // The kill switch pressed while the re-send was being written down: checked again, so nothing goes out.
      if (this.stoppedByPause(op)) {
        await this.deps.journal.append({ type: "operation.resend_refused", mode: op.mode, agent: op.agent, opId: op.opId, code: "PAUSED" })
        this.watch(op, 0)
        throw refused("PAUSED", `${pausedMessage(op).split(". ")[0]}. The kill switch went on as it was re-sent: resume to re-send it, or abandon it. Nothing was sent.`)
      }
      const mapped = await this.sendMapped(op)
      delete op.resending
      if (mapped.state === "refused") {
        // A refusal of the re-send is an answer about the re-send, not about the write: read it again.
        await this.deps.journal.append({ type: "operation.resend_refused", mode: op.mode, agent: op.agent, opId: op.opId, code: mapped.error?.code ?? "REFUSED" })
        this.deps.onChange?.(op)
        this.watch(op, 0)
        return op
      }
      await this.settle(op, mapped)
    } finally {
      this.resolving.delete(op.opId)
      if (op.resending) {
        delete op.resending
        this.deps.onChange?.(op)
      }
    }
    if (op.state === "unknown") this.watch(op, 0)
    else if (op.state === "pending") this.watch(op, op.kind === "bridge" ? BRIDGE_POLL_MS : 5_000)
    return op
  }

  /**
   * A card the kill switch caught after its approval was checked and before anything ran: the write-ahead
   * row, then refused, PAUSED, with nothing sent. Undefined when the kill switch doesn't stop it.
   */
  async refusePaused(card: Card): Promise<Operation | undefined> {
    if (!pausedStops(card) || !this.deps.paused?.()) return undefined
    const op: Operation = {
      opId: card.opId,
      cardId: card.cardId,
      kind: card.kind,
      tool: card.tool,
      agent: card.agent,
      mode: card.mode,
      params: card.params,
      ...chainField(card.chain),
      state: "submitting",
      startedAt: this.deps.now(),
      cardExpiresAt: Date.parse(card.expiresAt),
      ...(card.route === "cli" ? { route: "cli" as const, wallet: card.wallet } : card.route === "pane" ? { route: "pane" as const } : {}),
      ...(card.side ? { side: card.side } : {}),
    }
    this.ops.set(op.opId, op)
    try {
      await this.deps.journal.append({ type: "operation.submitting", mode: op.mode, agent: op.agent, opId: op.opId, cardId: op.cardId, kind: op.kind, tool: op.tool, params: op.params, ...(op.chain ? { chain: op.chain } : {}), cardExpiresAt: op.cardExpiresAt, ...(op.route === "cli" ? { route: op.route, wallet: op.wallet } : op.route ? { route: op.route } : {}), ...(op.side ? { side: op.side } : {}) })
    } catch (error) {
      // Nothing was sent, as in execute: the operation isn't left submitting for ever, and the approval sees the failure.
      this.ops.delete(op.opId)
      throw error
    }
    await this.refusedByPause(op, true)
    return op
  }

  private async refusedByPause(op: Operation, known = false): Promise<boolean> {
    if (!known && !this.stoppedByPause(op)) return false
    const message = `${pausedMessage(op).split(". ")[0]}. The kill switch went on as it was approved, so nothing was sent.`
    await this.settle(op, { state: "refused", error: { code: "PAUSED", message, retryable: false } })
    return true
  }

  /** Whether the kill switch is on and stops this operation's kind (classify.ts, pausedStops). */
  private stoppedByPause(op: Operation): boolean {
    if (!this.deps.paused?.()) return false
    const side = op.side ?? (op.params.side === "buy" ? "buy" : undefined)
    const row = typeof op.params.row === "string" ? op.params.row : undefined
    return pausedStops({ kind: op.kind, tool: op.tool, ...(side ? { side } : {}), ...(row ? { row } : {}), params: op.params })
  }

  /**
   * After a restart, from the journal: what was submitting or pending is unknown now (it may have
   * landed while the core was down). `readBack` reads every unknown one again, once Candle is up.
   */
  async rebuild(rows: readonly JournalRow[]): Promise<string[]> {
    const waited = new Set<string>()
    this.rebuilding = true
    for (const row of rows) {
      if (typeof row.opId !== "string" || !row.type.startsWith("operation.")) continue
      if (row.type === "operation.waiting") waited.add(row.opId)
      if (row.type === "operation.submitting") waited.delete(row.opId)
      if (row.type === "operation.submitting" || row.type === "operation.waiting") {
        this.ops.set(row.opId, {
          opId: row.opId,
          cardId: String(row.cardId),
          kind: row.kind as Card["kind"],
          tool: String(row.tool),
          // No agent: an owner step taken in setup, before the first agent existed.
          agent: typeof row.agent === "string" ? row.agent : "",
          mode: row.mode,
          params: (row.params as Record<string, unknown>) ?? {},
          ...chainField(storedChain(row.chain, (row.params as Record<string, unknown> | undefined)?.mint)),
          state: "submitting",
          startedAt: Date.parse(row.at),
          cardExpiresAt: typeof row.cardExpiresAt === "number" ? row.cardExpiresAt : 0,
          ...(row.route === "cli" ? { route: "cli" as const, ...(typeof row.wallet === "string" ? { wallet: row.wallet } : {}) } : {}),
          ...(row.route === "pane" ? { route: "pane" as const } : {}),
          ...(row.side === "buy" || row.side === "sell" || row.side === "swap" ? { side: row.side } : {}),
          ...(row.botExit === true ? { botExit: true } : {}),
          ...(typeof row.settles === "string" ? { settles: row.settles } : {}),
          ...(typeof row.landingBefore === "string" && /^\d+$/.test(row.landingBefore) ? { landingBefore: row.landingBefore } : {}),
        })
        continue
      }
      const op = this.ops.get(row.opId)
      // Once is once across restarts too.
      if (op && row.type === "operation.resend" && row.by === CORE_RESEND) op.autoResent = true
      const state = row.type.slice("operation.".length)
      if (op && ["pending", "succeeded", "failed", "refused", "unknown", "abandoned"].includes(state)) {
        op.state = state as OperationState
        // A bridge is followed from where its last answer left it: its deposit, its quote, and an end said in its own
        // words. A job Candle ended keeps the words it ended with.
        if (op.kind === "bridge" || (state === "unknown" && candleJobFailed(row.result))) {
          if (row.result !== undefined) op.result = row.result
          const error = row.error as OperationError | undefined
          if (error && typeof error.code === "string") op.error = error
          else delete op.error
        }
      }
    }
    const turned: string[] = []
    for (const op of this.ops.values()) {
      // Written down as waiting for its wallet, never as submitting: nothing was sent, and nothing sends it now.
      if (op.state === "submitting" && waited.has(op.opId)) {
        await this.settle(op, { state: "refused", error: { code: "NOT_SENT_RESTART", message: "The core restarted while this waited for its wallet's last trade, so it was never sent. Ask for it again if it's still wanted.", retryable: false } })
        continue
      }
      if (op.state === "submitting" || op.state === "pending") {
        await this.settle(op, { state: "unknown", reason: "core_restarted" })
        turned.push(op.opId)
      }
    }
    this.rebuilding = false
    return turned
  }

  /** Every unknown operation read back: after `rebuild`, once Candle's children have started (a read before then has none to ask). */
  readBack(): void {
    for (const op of this.ops.values()) if (op.state === "unknown" && op.route !== "pane") this.watch(op, 0)
  }

  private async sendMapped(op: Operation): Promise<Mapped> {
    if (op.kind === "hacc") {
      if (!this.deps.hacc) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "Hacc's changes aren't in this build of the core.", retryable: false } }
      return this.deps.hacc.run(op)
    }
    if (op.kind === "autonomy") {
      if (!this.deps.autonomy) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "Autonomy per wallet isn't in this build of the core.", retryable: false } }
      return this.deps.autonomy.run(op)
    }
    if (op.kind === "trigger") {
      if (!this.deps.triggers) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "Triggers aren't in this build of the core.", retryable: false } }
      return this.deps.triggers.run(op)
    }
    if (op.kind === "bot") {
      if (!this.deps.bots) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "Rules bots aren't in this build of the core.", retryable: false } }
      return this.deps.bots.run(op)
    }
    // candle_cli first: a CLI card row runs on the CLI route too, through its own rules.
    if (op.tool === "candle_cli") {
      if (!this.deps.cli) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "candle_cli isn't in this build of the core.", retryable: false } }
      const mapped = await this.deps.cli(op)
      // The debug switch: a card row that reads back ran, and its answer is dropped.
      if (this.loseNext && readsBack(op)) {
        this.loseNext = false
        return { state: "unknown", reason: "no answer (transport)" }
      }
      return mapped
    }
    if (op.route === "cli") {
      if (!this.deps.cliTrades) return { state: "refused", error: { code: "METHOD_NOT_AVAILABLE", message: "TEE wallet trades aren't in this build of the core.", retryable: false } }
      const mapped = await this.deps.cliTrades.execute(op)
      // The debug switch covers this route too: the CLI ran, and its answer is dropped.
      if (this.loseNext) {
        this.loseNext = false
        return { state: "unknown", reason: "no answer (transport)" }
      }
      return mapped
    }
    return this.mcpMapped(op, await this.send(op))
  }

  /**
   * Candle's MCP answer as an operation state. An embedded bridge's ok answer has no status of its own: where it stands
   * is its `settlement`, and one on its way is followed by its landing wallet's balance, when one was read before it went.
   */
  private mcpMapped(op: Operation, outcome: ToolOutcome): Mapped {
    const mapped = outcomeOf(mcpKind(op), outcome, op.chain)
    if (op.kind !== "bridge" || outcome.kind !== "ok") return mapped
    const facts = bridgeFactsOf(op.params)
    const result = (record(outcome.result) ?? {}) as Record<string, unknown>
    const bridged = bridgeMapped(embeddedBridgeStatus(result) ?? { phase: "depositing" }, { result, ...(facts ? { facts } : {}), sent: true })
    if (bridged.state === "pending" && (op.landingBefore === undefined || expectedOutOf(result) === undefined)) return unfollowedMapped(bridged.result as Record<string, unknown>, facts)
    return bridged
  }

  private async send(op: Operation): Promise<ToolOutcome> {
    const outcome = await this.deps.pool.for(op.agent).call(mcpTool(op), mcpParams(op), { timeoutMs: CALL_TIMEOUT_MS })
    if (this.loseNext && (op.kind === "trade" || op.kind === "swap")) {
      this.loseNext = false
      return { kind: "lost", reason: "transport" }
    }
    return outcome
  }

  private async settle(op: Operation, mapped: Mapped): Promise<void> {
    op.state = mapped.state
    if (mapped.result !== undefined) op.result = mapped.result
    if (mapped.error) op.error = mapped.error
    if (mapped.paper) op.paper = true
    if (mapped.partial) op.partial = mapped.partial
    if (mapped.reason) op.reason = mapped.reason
    const fill = op.state === "succeeded" ? this.fillOf(op, mapped) : undefined
    // What it brought in, from Candle's answer, for its card's done line: never the card's own estimate again.
    const received = op.state === "succeeded" && !mapped.paper ? (fill ? receivedOf(fill) : op.kind === "swap" ? swapReceived(mapped.result, op.params.to) : undefined) : undefined
    if (received !== undefined && typeof mapped.result === "object" && mapped.result !== null && !Array.isArray(mapped.result) && (mapped.result as { received?: unknown }).received === undefined) {
      mapped.result = { ...(mapped.result as Record<string, unknown>), received }
      op.result = mapped.result
    }
    await this.deps.journal.append({
      type: `operation.${op.state}`,
      mode: op.mode,
      agent: op.agent,
      opId: op.opId,
      cardId: op.cardId,
      ...(mapped.result !== undefined ? { result: mapped.result } : {}),
      ...(mapped.error ? { error: mapped.error } : {}),
      ...(mapped.paper ? { paper: true, note: "The live wallet had nothing to sell, so Candle closed the paper position instead." } : {}),
      ...(mapped.partial ? { partial: mapped.partial } : {}),
      ...(mapped.reason ? { reason: mapped.reason } : {}),
      ...(fill ? { fill } : {}),
    })
    if (SETTLED.has(op.state)) {
      op.settledAt = this.deps.now()
      this.cancelWatch(op.opId)
    }
    this.deps.onChange?.(op)
    // The wallet is free once this has an end, or Candle has let it go: the next trade waiting on it goes. Unknown or
    // pending holds it otherwise, as Candle does, for 30 minutes at most.
    if (oneAtATime(op) && !this.holds(op) && !this.stopped && !this.rebuilding) void this.wake(op.wallet!).catch(() => {})
  }

  /** A trade's fill from its answer: the card gives the side and the mint, which the TEE route's answer doesn't name. */
  private fillOf(op: Operation, mapped: Mapped): Fill | undefined {
    if (op.kind !== "trade" || mapped.result === undefined) return undefined
    const sideOf = (v: unknown) => (v === "buy" || v === "sell" ? v : undefined)
    const side = sideOf(op.side) ?? sideOf(op.params.side)
    // `candle swap <from> <to>`: a buy's mint is what it swaps to, a sell's what it swaps from.
    const argv = Array.isArray(op.params.argv) ? op.params.argv : undefined
    const fromArgv = argv && side ? argv[side === "buy" ? 2 : 1] : undefined
    const mint = typeof op.params.mint === "string" ? op.params.mint : typeof fromArgv === "string" ? fromArgv : undefined
    const fill = readFill({ ...(side ? { side } : {}), ...(mint ? { mint } : {}), ...chainField(op.chain), ...(op.settles ? { fallbackAsset: op.settles } : {}), wallet: op.route === "cli" && op.wallet ? op.wallet : "embedded", result: mapped.result, ...(mapped.paper ? { paper: true } : {}) })
    if (!fill) return undefined
    const usd = this.deps.assetUsd?.(fill.asset)
    return usd !== undefined && Number.isFinite(usd) && usd > 0 ? { ...fill, assetUsd: usd } : fill
  }

  private watch(op: Operation, delayMs: number): void {
    this.cancelWatch(op.opId)
    // A pane step has no read-back: its card says what to check, and the core reads the state instead.
    if (op.route === "pane") return
    // A stopping core reads nothing back: the next core rebuilds every open operation from the journal.
    if (this.stopped) return
    // One whose words say why it's read no further isn't read again.
    if (op.state === "unknown" && notFollowedFurther(op)) return
    const run = async () => {
      this.watches.delete(op.opId)
      if (op.state !== "unknown" && op.state !== "pending") return
      // A CLI card row reads back by its own rule; less access has none.
      if (op.tool === "candle_cli") await this.readRowOnce(op)
      // A TEE bridge is read by its id until it ends or its two hours pass.
      else if (op.route === "cli" && op.kind === "bridge") await this.readBridgeOnce(op)
      // The CLI route has no replay: a TEE swap is read by `candle swap status`, a trade as the embedded wallet's are.
      else if (op.route === "cli") await this.readCliOnce(op)
      else if (op.kind === "hacc") await this.readHaccOnce(op)
      else if (op.kind === "autonomy") await this.readAutonomyOnce(op)
      else if (op.kind === "trigger") await this.readTriggerOnce(op)
      else if (op.kind === "bot") await this.readBotOnce(op)
      else if (op.kind === "trade" || op.kind === "launch") await this.readJobOnce(op, op.kind)
      // An embedded bridge is replayed until Candle answers, then followed by its landing wallet's balance.
      else if (op.kind === "bridge") await this.readEmbeddedBridgeOnce(op)
      else if (REPLAYS.has(mcpTool(op))) await this.replayOnce(op)
      // Fee claims, posts and profile edits have no read: they wait for the user.
    }
    this.watches.set(op.opId, this.schedule(run, delayMs))
  }

  private scheduleNext(op: Operation, delayMs: number | undefined): void {
    const now = this.deps.now()
    if (delayMs === undefined || now + delayMs - op.startedAt >= TEN_MINUTES) return
    this.watch(op, delayMs)
  }

  /** A trade or a launch, read by its id; a launch is never sent again under a new one, which would be a second token. */
  private async readJobOnce(op: Operation, kind: "trade" | "launch"): Promise<void> {
    const read = await readJob(this.deps.pool.for(op.agent), op.opId, kind)
    await this.deps.journal.append({
      type: "operation.check",
      mode: op.mode,
      agent: op.agent,
      opId: op.opId,
      found: read.found,
      ...(read.found ? { state: read.state, job: read.job } : { detail: read.detail }),
    })
    if (read.found && (read.state === "succeeded" || read.state === "failed" || read.state === "refused")) {
      // A failed Hood job says from its legs what may have gone out, never "nothing was sent" alone.
      const error = read.state === "failed" ? sequencedFailure(read.job) : undefined
      await this.settle(op, { state: read.state, result: read.job, ...(error ? { error } : {}) })
      return
    }
    if (read.found && (await this.endedUnknown(op, read.job))) return
    if (!read.found && read.detail === NO_RECORD && (await this.resendLostExit(op))) return
    // A launch found submitted or confirming is in flight on Candle's side: pending, and read again.
    if (read.found && kind === "launch" && read.state === "pending" && op.state !== "pending") await this.settle(op, { state: "pending", result: read.job })
    this.scheduleNext(op, nextPollMs(op.startedAt, this.deps.now()))
  }

  /** A Hacc card nobody saw end, read back from Hacc's state until it's clear. */
  private async readHaccOnce(op: Operation): Promise<void> {
    const read = await this.deps.hacc?.read(op).catch(() => undefined)
    await this.deps.journal.append({ type: "operation.check", mode: op.mode, agent: op.agent, opId: op.opId, outcome: read ? read.state : "unclear" })
    if (read) return this.settle(op, read)
    this.scheduleNext(op, 5_000)
  }

  /** A narrowing a restart cut off, read from the core's own setting: it took, or it didn't and nothing changed. */
  private async readAutonomyOnce(op: Operation): Promise<void> {
    const read = this.deps.autonomy?.read(op)
    await this.deps.journal.append({ type: "operation.check", mode: op.mode, agent: op.agent, opId: op.opId, outcome: read ? read.state : "unclear" })
    if (read) await this.settle(op, read)
  }

  /** A trigger's card a restart cut off, read from triggers.toml and the core's state: saved as the card said, or not. */
  private async readTriggerOnce(op: Operation): Promise<void> {
    const read = this.deps.triggers?.read(op)
    await this.deps.journal.append({ type: "operation.check", mode: op.mode, agent: op.agent, opId: op.opId, outcome: read ? read.state : "unclear" })
    if (read) await this.settle(op, read)
  }

  /** A bot's card a restart cut off, read from the core's state and the journal: saved or flattened as the card said, or not. */
  private async readBotOnce(op: Operation): Promise<void> {
    const read = this.deps.bots?.read(op)
    await this.deps.journal.append({ type: "operation.check", mode: op.mode, agent: op.agent, opId: op.opId, outcome: read ? read.state : "unclear" })
    if (read) await this.settle(op, read)
  }

  /**
   * A read that finds Candle's job ended `failed` while the core can't call it failed (a Hood trade whose trade step was
   * sent may have filled): it stays unknown, written down with the job and its words, and nothing reads it again.
   */
  private async endedUnknown(op: Operation, job: Record<string, unknown>): Promise<boolean> {
    if (op.kind === "bridge" || !candleJobFailed(job)) return false
    const words = sequencedFailure(job)
    if (!words) return false
    if (!candleJobFailed(op.result) || op.error?.message !== words.message) await this.settle(op, { state: "unknown", result: job, error: words })
    return true
  }

  private async readCliOnce(op: Operation): Promise<void> {
    if (!this.deps.cliTrades) return
    const read = await this.deps.cliTrades.read(op)
    await this.deps.journal.append({
      type: "operation.check",
      mode: op.mode,
      agent: op.agent,
      opId: op.opId,
      route: "cli",
      found: read.found,
      ...(read.found ? { state: read.state, job: read.job } : { detail: read.detail }),
    })
    if (read.found && (read.state === "succeeded" || read.state === "failed" || read.state === "refused")) {
      // A failed Hood job says from its legs what may have gone out, never "nothing was sent" alone.
      const error = read.state === "failed" ? sequencedFailure(read.job) : undefined
      await this.settle(op, { state: read.state, result: read.job, ...(error ? { error } : {}) })
      return
    }
    // A job Candle has ended that may still have filled: it stays unknown, in words that say so, its wallet is free,
    // and it's read no further.
    if (read.found && (await this.endedUnknown(op, read.job))) return
    if (!read.found && read.detail === NO_RECORD && (await this.resendLostExit(op))) return
    this.scheduleNext(op, nextPollMs(op.startedAt, this.deps.now()))
  }

  /**
   * A rules bot's live exit that a restart cut off, read back and found nowhere on Candle: the core sends it
   * once more by itself, under the same id, which Candle never runs twice. A stop nobody presses is the riskier
   * outcome. Only once, and only this: every other trade Candle has no record of waits for the person's re-send.
   * It waits behind what holds the core's other sells, never past them; the person's own re-send doesn't.
   */
  private async resendLostExit(op: Operation): Promise<boolean> {
    if (!op.botExit || op.autoResent || op.mode !== "live" || op.reason !== "core_restarted") return false
    if (this.stopped || this.resolving.has(op.opId)) return false
    // Held as the core's other sells are (failed sells in a row, one in flight, the pace): the next read tries again.
    if (this.deps.resendHold?.(op) !== undefined) return false
    op.autoResent = true
    try {
      await this.resolve(CORE_RESEND, op.opId, "resend", "a bot's exit the core's restart cut off, with no record on Candle")
      return true
    } catch {
      // Refused before anything was sent (the kill switch, say): the person's re-send stays.
      return false
    }
  }

  /** A CLI card row's read-back (cli-cards.ts): a rerun within the card's lifetime, a launch's job read, or none. */
  private async readRowOnce(op: Operation): Promise<void> {
    // A rerun of a request that never reached Candle would be its first send: none while the kill switch
    // stops its kind, as with a replay. It's tried again after a resume, inside the card's lifetime.
    if (readBackOf(op) === "rerun" && this.deps.now() < op.cardExpiresAt) {
      if (this.stoppedByPause(op)) {
        if (!op.held) {
          op.held = true
          this.deps.onChange?.(op)
        }
        return this.retryReplay(op)
      }
      if (op.held) {
        delete op.held
        this.deps.onChange?.(op)
      }
    }
    const read = await this.deps.cliRead?.(op)
    if (!read) return
    await this.deps.journal.append({ type: "operation.check", mode: op.mode, agent: op.agent, opId: op.opId, route: "cli", found: read.mapped.state !== "unknown", state: read.mapped.state, detail: read.detail })
    const { state } = read.mapped
    if (state === "succeeded" || state === "failed" || state === "refused") {
      await this.settle(op, read.mapped)
      return
    }
    // A rerun that was refused is an answer about the rerun: what happened to the first is the user's call.
    if (read.detail === "rerun refused") return
    this.scheduleNext(op, nextPollMs(op.startedAt, this.deps.now()))
  }

  /**
   * The same call again, for a tool whose same id and body replay the stored result and never run
   * twice: a swap, staking, a staking reward claim.
   */
  private async replayOnce(op: Operation): Promise<void> {
    // After the card's lifetime, a request that never reached Candle would run now: that's the user's call. A bridge
    // between the account's own wallets goes on being asked, inside its ten minutes (retryReplay).
    if (op.kind !== "bridge" && this.deps.now() >= op.cardExpiresAt) return
    // A replay of a request that never reached Candle would be its first send: none while the kill switch
    // stops its kind. It's tried again after a resume, inside the card's lifetime, and after that it's the user's call.
    if (this.stoppedByPause(op)) {
      if (!op.held) {
        op.held = true
        this.deps.onChange?.(op)
      }
      return this.retryReplay(op)
    }
    if (op.held) {
      delete op.held
      this.deps.onChange?.(op)
    }
    // A bridge's replay is one of its follow's reads, through the key's budget; with no room, it's asked at its next turn.
    if (op.kind === "bridge" && this.deps.bridgeBudget && !this.deps.bridgeBudget(op.agent, 1)) return this.retryReplay(op)
    const outcome = await this.deps.pool.for(op.agent).call(mcpTool(op), mcpParams(op), { timeoutMs: CALL_TIMEOUT_MS })
    const running = outcome.kind === "error" && ((outcome.code === "IDEMPOTENCY_CONFLICT" && outcome.retryable) || STILL_RUNNING.has(outcome.code))
    const mapped = running ? undefined : this.mcpMapped(op, outcome)
    // A refusal of the replay itself (rate-limited, the child not up yet, a cap the first one may have used)
    // is an answer about the replay, not about the write: only a stage that says nothing was sent settles it.
    const aboutReplay = mapped?.state === "refused" && !NOT_SENT_STAGES.has(mapped.error?.stage ?? "")
    await this.deps.journal.append({
      type: "operation.check",
      mode: op.mode,
      agent: op.agent,
      opId: op.opId,
      replay: true,
      outcome: outcome.kind === "error" ? outcome.code : outcome.kind,
      ...(aboutReplay ? { refusedReplay: mapped.error?.code ?? "REFUSED" } : {}),
    })
    if (mapped && !aboutReplay && (mapped.state !== "unknown" || bridgeNotFollowed(mapped.error?.code))) {
      // An earlier replay's refusal was about that replay: this answer replaces its words.
      if (!mapped.error) delete op.error
      await this.settle(op, mapped)
      // A bridge on its way is followed by its landing wallet's balance from here; anything else is replayed again.
      if (op.state === "pending") return op.kind === "bridge" ? this.watch(op, BRIDGE_POLL_MS) : this.retryReplay(op)
      return
    }
    // Still unknown, but Candle answered: the person sees its words, not "no answer".
    if (aboutReplay && mapped.error) {
      op.error = mapped.error
      this.deps.onChange?.(op)
    }
    await this.retryReplay(op)
  }

  private async retryReplay(op: Operation): Promise<void> {
    if (op.kind === "bridge") {
      // An embedded bridge goes on being asked past its card's 60 s, every 10 s for ten minutes: replaying it under its
      // id sends nothing new. Then it's said, and no longer asked.
      if (this.deps.now() + BRIDGE_POLL_MS < op.startedAt + BRIDGE_FAST_MS) return this.watch(op, BRIDGE_POLL_MS)
      if (op.state === "unknown") await this.settle(op, noAnswerMapped(bridgeFactsOf(op.params)))
      return
    }
    if (this.deps.now() + 5_000 < op.cardExpiresAt) this.watch(op, 5_000)
  }

  /**
   * An embedded bridge: replayed under its id until Candle answers; once it has, and it's on its way, its landing
   * wallet's balance is read through the key's budget, every 10 s and then each minute, until it has risen by what the
   * bridge brings or two hours pass. An end said in its own words is read no further.
   */
  private async readEmbeddedBridgeOnce(op: Operation): Promise<void> {
    if (bridgeNotFollowed(op.error?.code)) return
    if (!bridgeAnswered(op.result)) return this.replayOnce(op)
    const prior = (record(op.result) ?? {}) as Record<string, unknown>
    const facts = bridgeFactsOf(op.params)
    const before = op.landingBefore !== undefined ? BigInt(op.landingBefore) : undefined
    const expected = expectedOutOf(prior)
    if (before === undefined || expected === undefined || !this.deps.bridgeLanding) return this.settle(op, unfollowedMapped(prior, facts))
    if (this.deps.bridgeBudget && !this.deps.bridgeBudget(op.agent, bridgeReadRequests(op))) return this.nextBridgeRead(op, false)
    const now = await this.deps.bridgeLanding(op).catch(() => undefined)
    const rose = now !== undefined && landingRose(before, now, expected)
    await this.deps.journal.append({ type: "operation.check", mode: op.mode, agent: op.agent, opId: op.opId, found: now !== undefined, ...(now !== undefined ? { landing: now.toString(), state: rose ? "arrived" : "on its way" } : { detail: "the landing wallet's balance couldn't be read" }) })
    if (now === undefined) return this.nextBridgeRead(op, false)
    if (rose) {
      const was = (record(prior.bridgeStatus) ?? {}) as Record<string, unknown>
      await this.settle(op, { state: "succeeded", result: { ...prior, bridgeStatus: { ...was, phase: "filled", landed: true } } })
      return
    }
    return this.nextBridgeRead(op, true)
  }

  /**
   * A TEE bridge read by its id: where it stands, said when it moves on, and read again until it ends. Each read goes
   * through the key's budget, and waits for its next turn without room. A deposit the core saw sent and Candle doesn't
   * show yet is lag, never a bridge that wasn't sent.
   */
  private async readBridgeOnce(op: Operation): Promise<void> {
    if (!this.deps.cliTrades?.readBridge) return
    if (this.deps.bridgeBudget && !this.deps.bridgeBudget(op.agent, bridgeReadRequests(op))) return this.nextBridgeRead(op, false)
    const read = await this.deps.cliTrades.readBridge(op)
    await this.deps.journal.append({
      type: "operation.check",
      mode: op.mode,
      agent: op.agent,
      opId: op.opId,
      route: "cli",
      found: read.found,
      ...(read.found ? { phase: read.status.phase, ...(read.status.open ? { open: read.status.open } : {}) } : { detail: read.detail }),
    })
    if (!read.found) return this.nextBridgeRead(op, false)
    const prior = (typeof op.result === "object" && op.result !== null ? op.result : {}) as Record<string, unknown>
    const facts = bridgeFactsOf(op.params)
    const mapped = bridgeMapped(read.status, { result: { ...prior, ...read.body }, ...(facts ? { facts } : {}), sent: typeof prior.bridge === "object" && prior.bridge !== null })
    if (mapped.state === "pending") {
      // Written down when it moves on (depositing, then filling), not at every read.
      const was = (prior.bridgeStatus as { phase?: unknown } | undefined)?.phase
      if (op.state !== "pending" || was !== read.status.phase) await this.settle(op, mapped)
      else {
        op.result = mapped.result
        this.deps.onChange?.(op)
      }
      return this.nextBridgeRead(op, true)
    }
    await this.settle(op, mapped)
  }

  /**
   * The next read of an open bridge. Past its two hours it's said, and followed no further, but only after a read that
   * answered: one that couldn't be made (no room, no answer) says nothing of where it stands, so it's tried each minute.
   */
  private async nextBridgeRead(op: Operation, readOk: boolean): Promise<void> {
    const next = nextBridgeReadMs(op.startedAt, this.deps.now())
    if (next !== undefined) return this.watch(op, next)
    if (!readOk) return this.watch(op, BRIDGE_SLOW_POLL_MS)
    const facts = bridgeFactsOf(op.params)
    const prior = (typeof op.result === "object" && op.result !== null ? op.result : {}) as Record<string, unknown>
    if (op.route !== "cli") return this.settle(op, embeddedPastTwoHours(prior, facts))
    await this.settle(op, bridgeMapped({ phase: "depositing", open: "uncertain" }, { result: prior, ...(facts ? { facts } : {}), sent: true }))
  }

  private cancelWatch(opId: string): void {
    this.watches.get(opId)?.()
    this.watches.delete(opId)
  }

  private schedule(run: () => Promise<void> | void, ms: number): () => void {
    if (this.deps.schedule) return this.deps.schedule(run, ms)
    // A read that fails (the core stopping under it, say) leaves the operation as it was, for the next read or core.
    const timer = setTimeout(() => void Promise.resolve(run()).catch(() => {}), ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

/**
 * A journal row about an operation as one line for the core's own log, or undefined for any other
 * row: `22:08:43 agent-a trade 2c2a03da no answer (transport)`. Ids, states and codes only.
 */
export function operationLogLine(row: { type: string; at: string; agent?: string; opId?: unknown; kind?: unknown; [k: string]: unknown }): string | undefined {
  if (!row.type.startsWith("operation.") || typeof row.opId !== "string") return undefined
  const step = row.type.slice("operation.".length)
  const error = row.error as { code?: unknown } | undefined
  const detail =
    step === "submitting"
      ? "sent"
      : step === "unknown"
        ? String(row.reason ?? "no answer")
        : step === "check"
          ? row.found === true || row.replay === true
            ? `read back: ${String(row.state ?? row.outcome ?? row.phase ?? "?")}`
            : `read back: not found (${String(row.detail ?? "?")})`
          : typeof error?.code === "string"
            ? `${step}: ${error.code}`
            : step
  return `${row.at.slice(11, 19)} ${row.agent ?? "-"}${typeof row.kind === "string" ? ` ${row.kind}` : ""} ${row.opId.slice(0, 8)} ${detail}`
}
