// A bridge: SOL or USDC on Solana to ETH or USDG on Hood, or back, between two of the account's own wallets. Read from
// the candle CLI's source at cli-v0.13.20 (packages/cli/src/commands/swap.ts bridgeSwap and swapStatus, bridge.ts
// describeBridgeJob):
//   - between TEE wallets it's `candle swap <from> <to> --wallet <origin> [--to <destination>] --client-trade-id <id>`,
//     through Relay: the destination is the same key's own active TEE wallet on the other chain, Candle charges no
//     fee, and Relay's cost and time come with its quote. Run with `--yes` and no `--wait`, it answers once the
//     deposit is sent, with `bridge` and `quote` beside the job. A rerun under the same id prints what's there and
//     never sends again;
//   - `candle swap status <id> --kind swap --json` adds `bridgeStatus {phase, open?, blockingUntil?, settledOutRaw?}`.
//     The phases are not_broadcast, depositing, filling, filled, failed and uncertain. A failure after the deposit
//     landed is refunded by Relay to the wallet it came from. While a bridge is open (two hours) a sweep of either
//     wallet is refused; after two hours it's a warning;
//   - between the account's two embedded wallets it's Candle's own MCP `candle_swap`, which bridges them through
//     Candle's one-shot route. Candle answers once the deposit has landed, with no status of its own: where it stands
//     is the answer's `payload.settlement` (Candle's lib/fill-measure.ts), measured for three seconds, so usually
//     `pending` while Relay fills. A same-id replay and `candle_get_operation` give back that first answer and never
//     measure again, and the read that does (GET /swap/receipts/:hash) has no MCP or CLI route, so a pending one is
//     followed by the landing wallet's balance against the one read before it went.
// The core follows a TEE bridge itself, every 10 s through the key's budget, since the CLI's own wait runs past the
// time it gives one command.
import { terminalText } from "../shared/terminal-text"
import { type BaseAsset, BASE_ASSETS } from "./assets"
import { sixFigures } from "./fill"
import { portfolioWallets } from "./portfolio-wallets"
import { BRIDGE_NOT_FOLLOWED } from "./trade-log"
import type { CliResult } from "./candle-cli"
import { CORE_CARD_TOOLS } from "./classify"
import { cliError, PRE_BUILD_CODES } from "./cli-trade"
import type { Mapped, OperationError } from "./execute"
import { addressKey, chainName, sameAddress } from "../shared/chains"

export const BRIDGE_TOOL_NAME = "candle_bridge"

/** The assets a bridge moves: one of each pair on Solana, the other on Hood, either way. */
export const BRIDGE_ASSETS = ["SOL", "USDC", "ETH", "USDG"] as const
export type BridgeAsset = (typeof BRIDGE_ASSETS)[number]
export const isBridgeAsset = (value: unknown): value is BridgeAsset => typeof value === "string" && (BRIDGE_ASSETS as readonly string[]).includes(value)

/** The arguments candle_bridge takes; any other is refused by name. */
export const BRIDGE_TOOL_ARGS: readonly string[] = CORE_CARD_TOOLS[BRIDGE_TOOL_NAME]!.args

export const BRIDGE_TOOL = {
  name: BRIDGE_TOOL_NAME,
  description:
    "Move SOL or USDC on Solana to ETH or USDG on Hood, or back, between two of your own wallets: a TEE wallet to the same key's TEE wallet on the other chain (via Relay), or the embedded wallet to the embedded wallet there (via Candle). It isn't sending funds out. It always becomes an approval card, live only; Candle charges no fee. A Hood TEE wallet needs ETH for gas: bridge ETH there first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      from: { type: "string", enum: [...BRIDGE_ASSETS] },
      to: { type: "string", enum: [...BRIDGE_ASSETS], description: "On the other chain." },
      amount: { type: "string", description: 'Decimal, such as "0.5". Or percent.' },
      percent: { type: "number", description: "Of the sending TEE wallet's balance (not the embedded wallet's), 0 to 100." },
      wallet: { type: "string", description: 'The sending wallet: "embedded", or a TEE wallet\'s label or address. Default: yours on that chain.' },
      destination: { type: "string", description: "The TEE wallet it lands in, when you hold more than one on the other chain." },
      reason: { type: "string", description: "Why, shown on the card. At most 500 characters." },
    },
    required: ["from", "to"],
  },
}

/** How often an open bridge is read, and for how long at that pace; then once a minute until the two hours pass. */
export const BRIDGE_POLL_MS = 10_000
export const BRIDGE_FAST_MS = 10 * 60_000
export const BRIDGE_SLOW_POLL_MS = 60_000
/** How long Candle holds a bridge open: past it, nothing more is learnt by waiting. */
export const BRIDGE_OPEN_MS = 2 * 60 * 60_000

/** When to read an open bridge next, from when it started; undefined once its two hours have passed. */
export function nextBridgeReadMs(startedAt: number, now: number): number | undefined {
  const age = now - startedAt
  if (age >= BRIDGE_OPEN_MS) return undefined
  return age < BRIDGE_FAST_MS ? BRIDGE_POLL_MS : BRIDGE_SLOW_POLL_MS
}

/** The words a TEE bridge runs, before `--json` (CandleCli.finalArgs adds it). Never `--wait`: the core follows it. */
export function bridgeArgs(input: { from: BridgeAsset; to: BridgeAsset; sizing: { amount: string } | { percent: number }; wallet: string; destination?: string; opId: string }): string[] {
  const sizing = "amount" in input.sizing ? ["--amount", input.sizing.amount] : ["--percent", String(input.sizing.percent)]
  return ["swap", input.from, input.to, ...sizing, "--wallet", input.wallet, ...(input.destination ? ["--to", input.destination] : []), "--client-trade-id", input.opId, "--yes"]
}

export type BridgePhase = "not_broadcast" | "depositing" | "filling" | "filled" | "failed" | "uncertain"

export interface BridgeStatus {
  phase: BridgePhase
  /** Open inside its two hours, or uncertain after them; absent once it closed. */
  open?: "open" | "uncertain"
  blockingUntil?: number
  settledOutRaw?: string
  /** The deposit landed on the sending chain (every settlement leg confirmed). */
  landed?: boolean
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const PHASES: ReadonlySet<string> = new Set(["not_broadcast", "depositing", "filling", "filled", "failed", "uncertain"])

/** Whether the job's settlement legs all landed: the deposit is on the sending chain. */
function landedOf(job: Record<string, unknown> | undefined): boolean {
  const legs = record(job?.settlement)?.legs
  return Array.isArray(legs) && legs.length > 0 && legs.every((l) => record(l)?.status === "confirmed")
}

/**
 * Where a bridge stands, from the CLI's `bridgeStatus` where it gives one, else from the job as the CLI reads it
 * (describeBridgeJob): the settlement's state first, then the job's own.
 */
export function bridgeStatusOf(body: Record<string, unknown> | undefined): BridgeStatus | undefined {
  if (!body) return undefined
  const job = record(body.job)
  const given = record(body.bridgeStatus)
  const landed = landedOf(job)
  if (given && typeof given.phase === "string" && PHASES.has(given.phase)) {
    return {
      phase: given.phase as BridgePhase,
      ...(given.open === "open" || given.open === "uncertain" ? { open: given.open } : {}),
      ...(typeof given.blockingUntil === "number" ? { blockingUntil: given.blockingUntil } : {}),
      ...(typeof given.settledOutRaw === "string" && /^\d+$/.test(given.settledOutRaw) ? { settledOutRaw: given.settledOutRaw } : {}),
      ...(landed ? { landed } : {}),
    }
  }
  if (!job) return undefined
  const settlement = record(job.settlement)
  const state = settlement?.state
  const out = typeof settlement?.settledOutRaw === "string" && /^\d+$/.test(settlement.settledOutRaw) ? { settledOutRaw: settlement.settledOutRaw } : {}
  const openField = record(job.bridge)
  const open = openField?.state === "open" ? { open: "open" as const, ...(typeof openField.blockingUntil === "number" ? { blockingUntil: openField.blockingUntil } : {}) } : openField?.state === "uncertain" ? { open: "uncertain" as const } : {}
  let phase: BridgePhase
  if (state === "settled") phase = "filled"
  else if (state === "failed") phase = "failed"
  else if (state === "uncertain") phase = "uncertain"
  else if (state === "pending") phase = landed ? "filling" : "depositing"
  else if (job.status === "failed") phase = "failed"
  else if (typeof job.signature === "string" || job.status === "submitted" || job.status === "confirmed") phase = "depositing"
  else phase = "not_broadcast"
  return { phase, ...open, ...out, ...(landed ? { landed } : {}) }
}

/** What a bridge's card names: the asset that arrives, and the wallet it left from, for the words of its end. */
export interface BridgeFacts {
  to: BridgeAsset
  /** The sending wallet as the card names it: where a refund goes. */
  fromName: string
  /** The wallet it lands in, as the card names it. */
  toName: string
}

/** A bridge's facts from its card's params, where the card kept them. */
export function bridgeFactsOf(params: Record<string, unknown>): BridgeFacts | undefined {
  const b = record(params.bridge)
  if (!b || !isBridgeAsset(b.to) || typeof b.fromName !== "string" || typeof b.toName !== "string") return undefined
  return { to: b.to, fromName: b.fromName, toName: b.toName }
}

/** What arrived, in words: "0.0709 ETH". */
export function receivedWords(raw: string, to: BridgeAsset): string {
  // Six figures say it; the exact amount stays in the bridge's settledOutRaw.
  return sixFigures(BigInt(raw), BASE_ASSETS[to as BaseAsset].decimals, to)
}

/**
 * A bridge's state from where it stands. `sent`: the deposit is known to have gone (this core saw the CLI's receipt),
 * so a read that doesn't show it yet is lag, not a build never sent.
 */
export function bridgeMapped(status: BridgeStatus, opts: { result: Record<string, unknown>; facts?: BridgeFacts; sent: boolean; preBuild?: boolean }): Mapped {
  const { facts } = opts
  const result = { ...opts.result, bridgeStatus: status, ...(status.settledOutRaw && facts ? { received: receivedWords(status.settledOutRaw, facts.to) } : {}) }
  const from = facts?.fromName ?? "the wallet it came from"
  switch (status.phase) {
    case "filled":
      return { state: "succeeded", result }
    case "failed":
      return {
        state: "failed",
        result,
        error: {
          code: "BRIDGE_FAILED",
          message: status.landed
            ? `The deposit landed and Relay didn't fill it: Relay refunds it to ${from}. Check that wallet's balance.`
            : "The deposit didn't land on the chain it was sent from, so nothing was bridged.",
          retryable: false,
        },
      }
    case "uncertain":
      return { state: "unknown", result, reason: "uncertain", error: { code: "BRIDGE_UNCERTAIN", message: `Relay reported a result Candle couldn't tie to one fill. Check the balance of ${facts?.toName ?? "the wallet it was going to"}; ctrl-o has the deposit.`, retryable: false } }
    case "not_broadcast":
      if (opts.sent || status.open !== undefined) return { state: "pending", result }
      return { state: "refused", result, error: { code: opts.preBuild ? "BRIDGE_REFUSED" : "BRIDGE_NOT_SENT", message: "Candle built it, and the deposit was never sent: nothing was bridged.", retryable: false } }
    default:
      // depositing or filling: on its way. Past its two hours with no end, it's said, and no longer followed.
      if (status.open === "uncertain") return { state: "unknown", result, reason: "past two hours", error: { code: "BRIDGE_PAST_TWO_HOURS", message: `No result after two hours. Sweeps of either wallet go ahead now; if the fill or a refund lands later, sweep that wallet again. ${facts?.toName ?? "The wallet it was going to"}'s balance says whether it arrived.`, retryable: false } }
      return { state: "pending", result }
  }
}

/** The bridge's own codes the CLI raises before anything is signed, beside a trade's. */
const BRIDGE_ONLY_PRE_BUILD: ReadonlySet<string> = new Set(["BRIDGE_DESTINATION_MISSING", "RELAY_STEP_REFUSED", "TEE_WALLET_INACTIVE"])
/** Whether the CLI raised `code` on a bridge before anything was signed: with nothing under the id, nothing was sent. Read at call time, so no module's load order matters. */
export const bridgePreBuild = (code: string): boolean => PRE_BUILD_CODES.has(code) || BRIDGE_ONLY_PRE_BUILD.has(code)

/** The Candle Harness's words for a bridge's refusals, where the CLI's own are about its flags. */
export function bridgeError(code: string, body: Record<string, unknown>): OperationError {
  const base = cliError(code, body)
  if (code === "BRIDGE_DESTINATION_MISSING") return { ...base, message: `The candle CLI found no active TEE wallet on the other chain for this key to land it in. Nothing was sent. ${terminalText(typeof body.message === "string" ? body.message : "", { maxLength: 300 })}`.trim() }
  if (code === "RELAY_STEP_REFUSED") return { ...base, message: "The candle CLI didn't recognise a step Relay built for this bridge, so it didn't sign it. Nothing was bridged. Ask for it again; if it repeats, the candle CLI needs updating." }
  if (code === "PAIR_UNSUPPORTED") return { ...base, message: "Candle didn't take the bridge: it says cross-chain swaps aren't on for TEE wallets now. Nothing was sent." }
  return base
}

/** A run of the CLI as the mapping reads it. */
type BridgeRun = Pick<CliResult, "exitCode" | "json" | "jsonError"> & { timedOut?: boolean }

const needsRead = (run: BridgeRun) => run.timedOut !== true && (run.exitCode === 1 || run.exitCode === 2) && typeof record(run.json)?.code === "string"

/** A bridge's read under its id: what `candle swap status <id> --kind swap --json` answered. */
export type BridgeRead = { found: true; body: Record<string, unknown>; status: BridgeStatus } | { found: false; detail: string }

/**
 * A TEE bridge's run as an operation state. `read` is the status read under the same id, made when the run answered
 * with an error (exit 1 or 2). Anything this can't place is unknown, and read back.
 */
export function mapCliBridge(run: BridgeRun, facts: BridgeFacts | undefined, read?: BridgeRead): Mapped {
  if (run.timedOut) return { state: "unknown", reason: "the candle CLI didn't finish in time" }
  const body = record(run.json)
  if (!body) return { state: "unknown", reason: run.jsonError ? "the candle CLI's answer couldn't be read" : "the candle CLI stopped without an answer" }
  if (run.exitCode === 0) {
    if (body.status === "cancelled") return { state: "refused", result: body, error: { code: "BRIDGE_CANCELLED", message: "The candle CLI stopped at its own prompt: nothing was sent.", retryable: false } }
    // The receipt: the deposit went, and the core follows it from here.
    if (record(body.bridge)) {
      const status = bridgeStatusOf(body)
      return status && status.phase !== "not_broadcast" && status.phase !== "depositing" ? bridgeMapped(status, { result: body, ...(facts ? { facts } : {}), sent: true }) : { state: "pending", result: body }
    }
    // What was already under the id, printed rather than sent again.
    const status = bridgeStatusOf(body)
    if (status) return bridgeMapped(status, { result: body, ...(facts ? { facts } : {}), sent: false })
    return { state: "unknown", result: body, reason: "the candle CLI's answer didn't say where the bridge stands" }
  }
  const code = typeof body.code === "string" ? body.code : `CLI_EXIT_${run.exitCode}`
  const error = bridgeError(code, body)
  if (run.exitCode === 3) return { state: "unknown", result: body, error, reason: "the candle CLI says it may have been sent (exit 3)" }
  if (!needsRead(run)) return { state: "unknown", result: body, error, reason: `the candle CLI stopped with exit ${run.exitCode}` }
  if (read?.found) {
    const mapped = bridgeMapped(read.status, { result: read.body, ...(facts ? { facts } : {}), sent: false, preBuild: bridgePreBuild(code) })
    return mapped.state === "refused" ? { ...mapped, error } : mapped
  }
  const notFound = read !== undefined && read.detail === "JOB_NOT_FOUND"
  if (notFound && bridgePreBuild(code)) return { state: "refused", result: body, error }
  return { state: "unknown", result: body, error, reason: notFound ? `${code}, and nothing is under the id yet` : `${code}, and the id couldn't be read back` }
}

/** Whether a bridge's unknown is an end the core no longer follows, said in its own words. */
export const bridgeNotFollowed = (code: string | undefined): boolean => code !== undefined && BRIDGE_NOT_FOLLOWED.has(code)

/** Whether Candle has answered an embedded bridge: its answer carries a payload. */
export const bridgeAnswered = (result: unknown): boolean => record(record(result)?.payload) !== undefined

/** Where an embedded bridge stands, from the `settlement` in Candle's answer to its candle_swap; undefined with none. */
export function embeddedBridgeStatus(result: unknown): BridgeStatus | undefined {
  const settlement = record(record(record(result)?.payload)?.settlement)
  if (!settlement) return undefined
  const legs = settlement.legs
  const landed = Array.isArray(legs) && legs.length > 0 && legs.every((l) => record(l)?.status === "confirmed")
  const out = typeof settlement.settledOutRaw === "string" && /^\d+$/.test(settlement.settledOutRaw) ? { settledOutRaw: settlement.settledOutRaw } : {}
  const phase: BridgePhase | undefined =
    settlement.state === "settled" ? "filled" : settlement.state === "failed" ? "failed" : settlement.state === "uncertain" ? "uncertain" : settlement.state === "pending" ? (landed ? "filling" : "depositing") : undefined
  return phase ? { phase, ...out, ...(landed ? { landed } : {}) } : undefined
}

/** What the quote said arrives, in raw units, from Candle's answer to an embedded bridge. */
export function expectedOutOf(result: unknown): bigint | undefined {
  const payload = record(record(result)?.payload)
  const raw = record(payload?.settlement)?.expectedOutRaw ?? payload?.expectedOutRaw
  return typeof raw === "string" && /^\d{1,40}$/.test(raw) ? BigInt(raw) : undefined
}

/** Candle's own slippage bound on a candle_swap that names none: a fill comes in at least this close to its quote. */
export const SWAP_DEFAULT_SLIPPAGE_BPS = 100

/** Whether the landing wallet's balance rose by what the bridge brings, inside the slippage Candle allows it. */
export const landingRose = (before: bigint, now: bigint, expected: bigint): boolean => expected > 0n && now - before >= (expected * BigInt(10_000 - SWAP_DEFAULT_SLIPPAGE_BPS)) / 10_000n

/** An embedded wallet's balance of the asset a bridge brings, from a candle_get_portfolio answer; undefined when it can't be read. */
export function landingBalance(portfolio: unknown, address: string, to: BridgeAsset): bigint | undefined {
  const info = BASE_ASSETS[to as BaseAsset]
  const wallet = portfolioWallets(portfolio).find((w) => w.kind === "embedded" && w.chain === info.chain && sameAddress(w.address, address))
  if (!wallet) return undefined
  if (to === "SOL" || to === "ETH") return wallet.nativeRaw ?? undefined
  if (!wallet.tokens) return undefined
  const mint = info.address ?? info.priceKey
  const held = wallet.tokens.find((t) => mint !== undefined && addressKey(t.mint) === addressKey(mint))
  if (held) return BigInt(held.amountRaw)
  // A row Candle sent without its amount or decimals is a balance not known: as 0, its reading whole later would look like the arrival.
  if (mint !== undefined && wallet.unreadMints?.some((m) => addressKey(m) === addressKey(mint))) return undefined
  return wallet.truncated ? undefined : 0n
}

/** An embedded bridge Candle answered before Relay filled it, when no balance was read before it went: said, and not followed. */
export function unfollowedMapped(result: Record<string, unknown>, facts: BridgeFacts | undefined): Mapped {
  const to = facts?.toName ?? "the wallet it was going to"
  return {
    state: "unknown",
    result,
    reason: "not followed",
    error: { code: "BRIDGE_UNFOLLOWED", message: `Candle answered before Relay filled it, and ${to}'s balance couldn't be read before it went, so the Candle Harness can't tell when it arrives: ${to}'s balance says. If Relay can't fill it, it refunds to ${facts?.fromName ?? "the wallet it came from"}.`, retryable: false },
  }
}

/** An embedded bridge Candle hasn't answered for ten minutes: said, and no longer asked. */
export function noAnswerMapped(facts: BridgeFacts | undefined): Mapped {
  const to = facts?.toName ?? "the wallet it was going to"
  return {
    state: "unknown",
    reason: "no answer in ten minutes",
    error: { code: "BRIDGE_NO_ANSWER", message: `Candle hasn't answered for this bridge in ten minutes, and it's no longer asked. If its deposit went, ${to}'s balance shows it arriving, or Relay refunds ${facts?.fromName ?? "the wallet it came from"}. Re-sending it under its id never sends it twice.`, retryable: false },
  }
}

/** An embedded bridge whose arrival its landing wallet's balance hasn't shown in two hours: said, and no longer followed. */
export function embeddedPastTwoHours(result: Record<string, unknown>, facts: BridgeFacts | undefined): Mapped {
  const to = facts?.toName ?? "the wallet it was going to"
  return {
    state: "unknown",
    result,
    reason: "past two hours",
    error: { code: "BRIDGE_PAST_TWO_HOURS", message: `${to}'s balance hasn't shown it arriving after two hours, and it's no longer followed. If Relay couldn't fill it, it refunds to ${facts?.fromName ?? "the wallet it came from"}: that wallet's balance says.`, retryable: false },
  }
}

/** The route line's chain names: "Solana", "Hood". */
export const bridgeChainName = (asset: BridgeAsset): string => chainName(BASE_ASSETS[asset as BaseAsset].chain)
