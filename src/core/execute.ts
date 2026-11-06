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
import type { Journal, JournalRow } from "./journal"
import type { Side } from "./limits"
import { nextPollMs, readJob, type TradeRead } from "./reconcile"
import type { OperationState } from "./tool-face"

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

/** Plain messages for the refusals a trader meets, from docs.candle.tv/developers/agent-trading and docs.candle.tv/developers/agent-access. */
export function refusalMessage(code: string, error: Record<string, unknown>): string | undefined {
  switch (code) {
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
    case "TEST_ENVIRONMENT_FORBIDDEN":
      return "A test key can't trade. Nothing was sent; use a live key."
    case "IDEMPOTENCY_CONFLICT":
      return "Candle already holds a different request under this id. Nothing new was sent."
    default:
      return undefined
  }
}

/** A child's outcome for a card's tool call, as an operation state. */
export function outcomeOf(kind: Card["kind"], outcome: ToolOutcome): Mapped {
  if (outcome.kind === "lost") return { state: "unknown", reason: `no answer (${outcome.reason.replace("_", " ")})` }
  const body = record(outcome.kind === "ok" ? outcome.result : outcome.body)
  // candle_trade and candle_launch_and_seed wrap the API body under `api`; the swap and the rest use
  // the envelope itself (docs.candle.tv/developers/mcp-server, "Error shapes").
  const api = (kind === "trade" || kind === "launch") && body && record(body.api) ? record(body.api)! : body

  if (outcome.kind === "ok") {
    const status = typeof api?.status === "string" ? api.status.toLowerCase() : ""
    const paper = kind === "trade" && resultWasPaper(outcome.result)
    if (status === "failed") return { state: "failed", result: outcome.result, error: errorOf("OPERATION_FAILED", record(api?.error) ?? {}) }
    return { state: PENDING.has(status) ? "pending" : "succeeded", result: outcome.result, ...(paper ? { paper } : {}) }
  }

  const raw = record(api?.error) ?? {}
  const code = outcome.code
  const error = errorOf(code, raw)
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
    const sentNothing = code === "IDEMPOTENCY_CONFLICT" ? !outcome.retryable : SENT_NOTHING.has(code) && (!outcome.retryable || RETRYABLE_SENT_NOTHING.has(code))
    if (!sentNothing) return { state: "unknown", result: outcome.body, error, reason: `${code} without a stage, so it may have been sent` }
  }
  if (stage === undefined || NOT_SENT_STAGES.has(stage)) return { state: "refused", result: outcome.body, error }
  if (stage === "unconfirmed") return { state: "unknown", result: outcome.body, error, reason: "it may have reached the chain" }
  if (stage === "executed") return { state: "succeeded", result: outcome.body, error }
  if (stage === "reverted") return { state: "failed", result: outcome.body, error }
  // A stage this code doesn't know: execution began, so nothing can be assumed.
  return { state: "unknown", result: outcome.body, error, reason: `stage ${stage}` }
}

function errorOf(code: string, raw: Record<string, unknown>): OperationError {
  const serverText = typeof raw.message === "string" ? terminalText(raw.message, { maxLength: 500 }) : code
  return {
    code,
    message: refusalMessage(code, raw) ?? serverText,
    retryable: raw.retryable === true,
    ...(typeof raw.stage === "string" ? { stage: raw.stage } : {}),
    ...(code === "KEY_LIMIT_REACHED" ? keyLimitFields(raw) : {}),
  }
}

const SETTLED: ReadonlySet<OperationState> = new Set(["succeeded", "failed", "refused", "abandoned"])
const TEN_MINUTES = 10 * 60_000
export const CALL_TIMEOUT_MS = 60_000

type Child = { call(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ToolOutcome> }

/** A CLI card row with a read-back (cli-table.ts `card.readBack`): what the debug switch may drop. */
function readsBack(op: Operation): boolean {
  const readBack = readBackOf(op)
  return readBack !== undefined && readBack !== "none"
}

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
      /** Runs and reads back a TEE wallet's trade or swap (cli-trade.ts). */
      cliTrades?: { execute(op: Operation): Promise<Mapped>; read(op: Operation): Promise<TradeRead> }
      /** Runs an approved Hacc card, and reads one nobody saw end back from Hacc's state. */
      hacc?: { run(op: Operation): Promise<Mapped>; read(op: Operation): Promise<Mapped | undefined> }
      /** Runs an approved narrowing of a wallet's autonomy in the core, and reads one a restart cut off. */
      autonomy?: { run(op: Operation): Promise<Mapped>; read(op: Operation): Mapped | undefined }
      /** Whether the kill switch is on: what it stops is never sent again by a re-send or a replay while it is. */
      paused?: () => boolean
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

  /** Whether anything is in flight or still being read back: the core stays up for it. */
  busy(): boolean {
    return this.watches.size > 0 || [...this.ops.values()].some((op) => op.state === "submitting")
  }

  stop(): void {
    this.stopped = true
    for (const cancel of this.watches.values()) cancel()
    this.watches.clear()
  }

  /** Write-ahead `operation.submitting`, then the call, then the outcome. The id never changes. */
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
      state: "submitting",
      startedAt: now,
      cardExpiresAt: Date.parse(card.expiresAt),
      ...(card.route === "cli" ? { route: "cli" as const, wallet: card.wallet } : {}),
      ...(card.side ? { side: card.side } : {}),
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
        cardExpiresAt: op.cardExpiresAt,
        ...(op.route ? { route: op.route, wallet: op.wallet } : {}),
        ...(op.side ? { side: op.side } : {}),
      })
    } catch (error) {
      // Nothing was sent: the operation isn't left submitting for ever, and the approval sees the failure.
      this.ops.delete(op.opId)
      throw error
    }
    this.deps.onChange?.(op)
    // The kill switch pressed while this was being written down: the kill can't withdraw a card mid-approval.
    if (await this.refusedByPause(op)) return op
    const mapped = await this.sendMapped(op)
    await this.settle(op, mapped)
    if (op.state === "unknown") this.watch(op, 0)
    else if (op.state === "pending") this.watch(op, 5_000)
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
      state: "submitting",
      startedAt: this.deps.now(),
      cardExpiresAt: Date.parse(card.expiresAt),
      route: "pane",
    }
    this.ops.set(op.opId, op)
    await this.deps.journal.append({ type: "operation.submitting", mode: op.mode, agent: op.agent, opId: op.opId, cardId: op.cardId, kind: op.kind, tool: op.tool, params: op.params, cardExpiresAt: op.cardExpiresAt, route: "pane", ticketId: detail.ticketId })
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
  async resolve(viewClientId: string, opId: unknown, action: "resend" | "abandon"): Promise<Operation> {
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
      await this.deps.journal.append({ type: "operation.resend", mode: op.mode, agent: op.agent, opId: op.opId, by: viewClientId, params: op.params })
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
    else if (op.state === "pending") this.watch(op, 5_000)
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
      state: "submitting",
      startedAt: this.deps.now(),
      cardExpiresAt: Date.parse(card.expiresAt),
      ...(card.route === "cli" ? { route: "cli" as const, wallet: card.wallet } : card.route === "pane" ? { route: "pane" as const } : {}),
      ...(card.side ? { side: card.side } : {}),
    }
    this.ops.set(op.opId, op)
    try {
      await this.deps.journal.append({ type: "operation.submitting", mode: op.mode, agent: op.agent, opId: op.opId, cardId: op.cardId, kind: op.kind, tool: op.tool, params: op.params, cardExpiresAt: op.cardExpiresAt, ...(op.route === "cli" ? { route: op.route, wallet: op.wallet } : op.route ? { route: op.route } : {}), ...(op.side ? { side: op.side } : {}) })
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
   * landed while the core was down), and every unknown one is read again.
   */
  async rebuild(rows: readonly JournalRow[]): Promise<string[]> {
    for (const row of rows) {
      if (typeof row.opId !== "string" || !row.type.startsWith("operation.")) continue
      if (row.type === "operation.submitting") {
        this.ops.set(row.opId, {
          opId: row.opId,
          cardId: String(row.cardId),
          kind: row.kind as Card["kind"],
          tool: String(row.tool),
          // No agent: an owner step taken in setup, before the first agent existed.
          agent: typeof row.agent === "string" ? row.agent : "",
          mode: row.mode,
          params: (row.params as Record<string, unknown>) ?? {},
          state: "submitting",
          startedAt: Date.parse(row.at),
          cardExpiresAt: typeof row.cardExpiresAt === "number" ? row.cardExpiresAt : 0,
          ...(row.route === "cli" ? { route: "cli" as const, ...(typeof row.wallet === "string" ? { wallet: row.wallet } : {}) } : {}),
          ...(row.route === "pane" ? { route: "pane" as const } : {}),
          ...(row.side === "buy" || row.side === "sell" || row.side === "swap" ? { side: row.side } : {}),
        })
        continue
      }
      const op = this.ops.get(row.opId)
      const state = row.type.slice("operation.".length)
      if (op && ["pending", "succeeded", "failed", "refused", "unknown", "abandoned"].includes(state)) op.state = state as OperationState
    }
    const turned: string[] = []
    for (const op of this.ops.values()) {
      if (op.state === "submitting" || op.state === "pending") {
        await this.settle(op, { state: "unknown", reason: "core_restarted" })
        turned.push(op.opId)
      }
      if (op.state === "unknown" && op.route !== "pane") this.watch(op, 0)
    }
    return turned
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
    return outcomeOf(op.kind, await this.send(op))
  }

  private async send(op: Operation): Promise<ToolOutcome> {
    const outcome = await this.deps.pool.for(op.agent).call(op.tool, op.params, { timeoutMs: CALL_TIMEOUT_MS })
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
    })
    if (SETTLED.has(op.state)) {
      op.settledAt = this.deps.now()
      this.cancelWatch(op.opId)
    }
    this.deps.onChange?.(op)
  }

  private watch(op: Operation, delayMs: number): void {
    this.cancelWatch(op.opId)
    // A pane step has no read-back: its card says what to check, and the core reads the state instead.
    if (op.route === "pane") return
    // A stopping core reads nothing back: the next core rebuilds every open operation from the journal.
    if (this.stopped) return
    const run = async () => {
      this.watches.delete(op.opId)
      if (op.state !== "unknown" && op.state !== "pending") return
      // A CLI card row reads back by its own rule; less access has none.
      if (op.tool === "candle_cli") await this.readRowOnce(op)
      // The CLI route has no replay: a TEE swap is read by `candle swap status`, a trade as the embedded wallet's are.
      else if (op.route === "cli") await this.readCliOnce(op)
      else if (op.kind === "hacc") await this.readHaccOnce(op)
      else if (op.kind === "autonomy") await this.readAutonomyOnce(op)
      else if (op.kind === "trade" || op.kind === "launch") await this.readJobOnce(op, op.kind)
      else if (REPLAYS.has(op.tool)) await this.replayOnce(op)
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
      await this.settle(op, { state: read.state, result: read.job })
      return
    }
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
      await this.settle(op, { state: read.state, result: read.job })
      return
    }
    this.scheduleNext(op, nextPollMs(op.startedAt, this.deps.now()))
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
    // After the card's lifetime, a request that never reached Candle would run now: that's the user's call.
    if (this.deps.now() >= op.cardExpiresAt) return
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
    const outcome = await this.deps.pool.for(op.agent).call(op.tool, op.params, { timeoutMs: CALL_TIMEOUT_MS })
    const running = outcome.kind === "error" && ((outcome.code === "IDEMPOTENCY_CONFLICT" && outcome.retryable) || STILL_RUNNING.has(outcome.code))
    const mapped = running ? undefined : outcomeOf(op.kind, outcome)
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
    if (mapped && mapped.state !== "unknown" && !aboutReplay) {
      // An earlier replay's refusal was about that replay: this answer replaces its words.
      if (!mapped.error) delete op.error
      await this.settle(op, mapped)
      if (op.state === "pending") this.retryReplay(op)
      return
    }
    // Still unknown, but Candle answered: the person sees its words, not "no answer".
    if (aboutReplay && mapped.error) {
      op.error = mapped.error
      this.deps.onChange?.(op)
    }
    this.retryReplay(op)
  }

  private retryReplay(op: Operation): void {
    if (this.deps.now() + 5_000 < op.cardExpiresAt) this.watch(op, 5_000)
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
            ? `read back: ${String(row.state ?? row.outcome ?? "?")}`
            : `read back: not found (${String(row.detail ?? "?")})`
          : typeof error?.code === "string"
            ? `${step}: ${error.code}`
            : step
  return `${row.at.slice(11, 19)} ${row.agent ?? "-"}${typeof row.kind === "string" ? ` ${row.kind}` : ""} ${row.opId.slice(0, 8)} ${detail}`
}
