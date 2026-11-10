// Trades and swaps from a TEE wallet, run through the user's own `candle swap` with
// the agent's key. The CLI signs with the key's own signer from its own store (docs.candle.tv/developers/cli-custody);
// the Candle Harness never holds one. Read from the CLI's source at agentic 8737c8e (cli/src/commands/swap.ts,
// cli/src/trading.ts) and docs.candle.tv/developers/cli:
//   - `candle swap` looks the id up on Candle first and prints what it finds instead of trading
//     (swap.ts:492-493), then claims the id in a local file (trading.ts:1186). A rerun under the same id
//     is a read, or OPERATION_ALREADY_STARTED: it never sends twice. So "re-send" runs the same argv;
//   - without `--yes` it builds and stops at its prompt, leaving a built job under the id, so the core
//     never runs a card's id without it;
//   - exit 0 isn't always a fill (a job it found is printed as it is), exit 1 isn't always "nothing
//     happened" (REQUEST_FAILED on the submit, after signing, is exit 1: cli/src/client.ts:384-401), and
//     exit 3 is "may have landed" (trading.ts:330-370). The body decides, read back where it doesn't.
import type { Redactor } from "../shared/redact"
import { terminalText } from "../shared/terminal-text"
import type { CandleCli, CliResult } from "./candle-cli"
import type { Mapped, Operation, OperationError } from "./execute"
import { keyLimitFields, refusalMessage, routeWaitFields } from "./execute"
import type { Journal } from "./journal"
import { type JobState, jobState, type TradeRead } from "./reconcile"

/** What a TEE card runs: `candle <argv>` with the agent's key. The card's hash covers all of it. */
export interface CliTradeParams {
  argv: string[]
  identity: "agent"
  agent: string
  json: true
}

/**
 * Codes the CLI raises before it built anything, or that Candle's build route answers with before a
 * signature exists (trading.ts tradingPayer, decimalsFor, rawAmount, tradingRead; Candle's server for
 * the limits, the tier and the token). Only these, with no job found under the id, are `refused`.
 */
export const PRE_BUILD_CODES: ReadonlySet<string> = new Set([
  "TEE_WALLET_REQUIRED",
  "TEE_WALLET_INACTIVE",
  "PAYER_REQUIRED",
  "SCOPE_MISSING",
  "SIGNER_UNAVAILABLE",
  "API_KEY_REQUIRED",
  "EMBEDDED_WALLET_NOT_PERMITTED",
  "CHAIN_MISMATCH",
  "PAIR_UNSUPPORTED",
  "INVALID_AMOUNT",
  "RPC_RATE_LIMITED",
  "RPC_FAILED",
  "TIER_REQUIRED",
  "KEY_LIMIT_REACHED",
  "SPEND_LIMIT_EXCEEDED",
  "QUOTE_EXPIRED",
  "TOKEN_NOT_TRADABLE",
  "USAGE",
])

/** The words a TEE trade runs, before `--json` and `--rpc-url` (CandleCli.finalArgs adds those). */
export function teeSwapArgs(input: {
  from: string
  to: string
  sizing: { amount: string } | { percent: number }
  wallet: string
  opId: string
  slippageBps?: number
}): string[] {
  const sizing = "amount" in input.sizing ? ["--amount", input.sizing.amount] : ["--percent", String(input.sizing.percent)]
  return [
    "swap",
    input.from,
    input.to,
    ...sizing,
    "--wallet",
    input.wallet,
    "--client-trade-id",
    input.opId,
    ...(input.slippageBps !== undefined ? ["--slippage-bps", String(input.slippageBps)] : []),
    "--yes",
  ]
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** A swap job's state (`candle swap status --kind swap`), by `settlement.state` first (sdk/src/client.ts, SwapSettlement). */
export function swapJobState(job: Record<string, unknown>): JobState {
  const settlement = record(job.settlement)?.state
  if (settlement === "settled") return "succeeded"
  if (settlement === "failed") return "failed"
  if (settlement === "pending" || settlement === "uncertain") return "pending"
  const hashes = Array.isArray(job.hashes) && job.hashes.length > 0
  const sent = typeof job.signature === "string" || hashes || job.stage === "unconfirmed"
  switch (job.status) {
    case "confirmed":
    case "settled":
      return "succeeded"
    case "failed":
      // `not_broadcast` on a terminal job: "Nothing was sent" (swap.ts, describeSwapEvidence).
      return sent && job.stage !== "not_broadcast" ? "failed" : "refused"
    case "built":
      return sent ? "unknown" : "pending"
    default:
      return "unknown"
  }
}

const stateOf = (kind: Operation["kind"], job: Record<string, unknown>): JobState => (kind === "swap" ? swapJobState(job) : jobState(job))

/** The Candle Harness's own words for the CLI's refusals, where Candle's would mislead. */
function cliMessage(code: string, body: Record<string, unknown>): string {
  // The CLI appends "use candle swap status <id> before another attempt", which can't work from the
  // user's own terminal: the swap was placed with the agent's key, and a refused attempt isn't stored.
  if (code === "TEE_WALLET_REQUIRED") return "The candle CLI says this key can't pay from that TEE wallet (it isn't bound to this agent's key, or no longer is). Nothing was sent. The Wallets pane lists what each agent can pay from."
  if (code === "SIGNER_UNAVAILABLE") return "This machine doesn't hold the TEE wallet's signer, so the candle CLI couldn't sign. Nothing was sent. candle-harness doctor shows which wallets have one."
  if (code === "USAGE") return "The Candle Harness built a command the candle CLI didn't accept. Nothing was sent. This is a bug in the Candle Harness."
  const plain = refusalMessage(code, body)
  if (plain) return plain
  const message = typeof body.message === "string" ? body.message.replace(/ Operation \S+; use candle swap status \S+ before another attempt\.$/, "") : code
  return terminalText(message, { maxLength: 500 })
}

function errorOf(code: string, body: Record<string, unknown>): OperationError {
  // A held key needs when Candle's window resets, where the CLI passes it on.
  return { code, message: cliMessage(code, body), retryable: body.retryable === true, ...(code === "KEY_LIMIT_REACHED" ? keyLimitFields(body) : {}), ...(code === "SWAP_ROUTE_FAILING" ? routeWaitFields(body) : {}) }
}

/**
 * A `SWAP_FAILED` with nothing from a submit in it. The CLI keeps `details` (a stage, a signature,
 * the legs) only from the calls that sign and send, so an answer without them came from the build,
 * before anything was signed; with nothing stored under the id either, nothing was sent. Candle's
 * own simulation refusing a built trade answers this way.
 */
function refusedAtBuild(code: string, body: Record<string, unknown>): boolean {
  return code === "SWAP_FAILED" && body.details === undefined && body.stage === undefined && body.signature === undefined
}

/** Jupiter's 6001, slippage exceeded, as Candle's simulation reports it: the price moved between quote and build. */
const SLIPPAGE_EXCEEDED = /"Custom":\s*6001\b|custom program error: 0x1771\b/

const builtRefusalMessage = (candle: string): string =>
  `Candle refused it before anything was signed, so nothing was sent.${SLIPPAGE_EXCEEDED.test(candle) ? " The price moved more than the trade's slippage allows (Jupiter's code 6001; 0.5% unless a wider maxSlippageBps was set), so asking again quotes it fresh." : ""} Candle said: ${candle}`

/** Whether a run needs a read under its id before it can be mapped: exit 1 or 2 with an answer. */
export function needsReadBack(run: Pick<CliResult, "exitCode" | "timedOut" | "json">): boolean {
  return run.timedOut !== true && (run.exitCode === 1 || run.exitCode === 2) && typeof record(run.json)?.code === "string"
}

/**
 * A TEE trade's run as an operation state. `read` is the read-back under the same id, made when
 * `needsReadBack` says so. Anything this can't place is `unknown`, and read back.
 */
export function mapCliTrade(kind: Operation["kind"], run: Pick<CliResult, "exitCode" | "timedOut" | "json" | "jsonError">, read?: TradeRead): Mapped {
  if (run.timedOut) return { state: "unknown", reason: "the candle CLI didn't finish in time" }
  const body = record(run.json)
  if (!body) return { state: "unknown", reason: run.jsonError ? "the candle CLI's answer couldn't be read" : "the candle CLI stopped without an answer" }

  if (run.exitCode === 0) {
    const job = record(body.job)
    if (job) {
      const state = stateOf(kind, job)
      // A job the CLI found under the id, built and never signed: only the CLI signs a TEE wallet's
      // transaction, and it printed the job rather than trading, so nothing will send it. Left pending,
      // it would sit with nothing to read and nothing to press.
      if (state === "pending" && job.status === "built" && record(job.settlement)?.state === undefined) {
        return { state: "refused", result: body, error: { code: "BUILT_NOT_SENT", message: "Candle built it, and it was never signed or sent: nothing was sent.", retryable: false } }
      }
      return state === "unknown" ? { state, result: body, reason: `Candle's job says ${String(job.status)}` } : { state, result: body }
    }
    if (kind === "trade" && body.status === "executed" && typeof body.signature === "string") return { state: "succeeded", result: body }
    const settled = record(body.settlement)?.state ?? record(record(body.payload)?.settlement)?.state
    if (kind === "swap" && settled === "settled") return { state: "succeeded", result: body }
    if (kind === "swap" && settled === "failed") return { state: "failed", result: body }
    return { state: "unknown", result: body, reason: "the candle CLI's answer didn't say it filled" }
  }

  const code = typeof body.code === "string" ? body.code : `CLI_EXIT_${run.exitCode}`
  const error = errorOf(code, body)
  if (run.exitCode === 3) return { state: "unknown", result: body, error, reason: "the candle CLI says it may have landed (exit 3)" }
  if (run.exitCode !== 1 && run.exitCode !== 2) return { state: "unknown", result: body, error, reason: `the candle CLI stopped with exit ${run.exitCode}` }

  // Exit 1 or 2: what's under the id decides, never the code alone.
  if (read?.found) {
    const state = stateOf(kind, read.job)
    // A job built and never sent, after a refusal raised before the submit: only the CLI could send a
    // TEE wallet's transaction, and it has stopped, so nothing will be.
    if (state === "pending" && PRE_BUILD_CODES.has(code)) return { state: "refused", result: read.job, error }
    if (state === "unknown" || state === "pending") return { state, result: read.job, error, reason: `${code}, and Candle's job says ${String(read.job.status)}` }
    return { state, result: read.job, ...(state === "refused" || state === "failed" ? { error } : {}) }
  }
  const notFound = read !== undefined && read.detail === "JOB_NOT_FOUND"
  if (notFound && PRE_BUILD_CODES.has(code)) return { state: "refused", result: body, error }
  if (notFound && refusedAtBuild(code, body)) return { state: "refused", result: body, error: { ...error, message: builtRefusalMessage(error.message) } }
  return { state: "unknown", result: body, error, reason: notFound ? `${code}, and nothing is under the id yet` : `${code}, and the id couldn't be read back` }
}

export class CliTrades {
  constructor(
    private readonly deps: {
      cli: Pick<CandleCli, "runExact">
      redactor: Redactor
      journal: Journal
      /** A trade, through the agent's own MCP child (candle_get_operation, kind trade): any key on the account reads it. */
      readTrade: (agent: string, opId: string) => Promise<TradeRead>
    },
  ) {}

  /** Runs an approved TEE card's argv, exactly, and maps its answer (reading back under the id where needed). */
  async execute(op: Operation): Promise<Mapped> {
    const p = op.params as unknown as CliTradeParams
    const run = await this.deps.cli.runExact({ agent: p.agent, argv: p.argv, json: true })
    const clean = { ...run, ...(run.json !== undefined ? { json: this.deps.redactor.value(run.json) } : {}) }
    if (record(clean.json)?.code === "USAGE") {
      await this.deps.journal.append({ type: "core.bug", mode: op.mode, agent: op.agent, opId: op.opId, what: "candle swap refused the Candle Harness's argv as USAGE", argv: p.argv })
    }
    const read = needsReadBack(clean) ? await this.read(op) : undefined
    return mapCliTrade(op.kind, clean, read)
  }

  /** One read of an operation by its id: a trade through Candle's MCP tool, a swap through `candle swap status`. */
  read(op: Pick<Operation, "kind" | "agent" | "opId">): Promise<TradeRead> {
    return op.kind === "swap" ? this.readSwap(op.agent, op.opId) : this.deps.readTrade(op.agent, op.opId).catch(() => ({ found: false, detail: "unreadable" }))
  }

  /** `candle swap status <id> --kind swap --json` with the key that placed it: only that key reads a swap job. */
  async readSwap(agent: string, opId: string): Promise<TradeRead> {
    const run = await this.deps.cli.runExact({ agent, argv: ["swap", "status", opId, "--kind", "swap", "--json"], json: true }).catch(() => undefined)
    if (!run) return { found: false, detail: "unreadable" }
    if (run.timedOut) return { found: false, detail: "no answer (timeout)" }
    const body = record(run.json === undefined ? undefined : this.deps.redactor.value(run.json))
    const job = record(body?.job)
    if (run.exitCode === 0 && job) return { found: true, state: swapJobState(job), job }
    if (typeof body?.code === "string") return { found: false, detail: body.code }
    return { found: false, detail: "unreadable" }
  }
}
