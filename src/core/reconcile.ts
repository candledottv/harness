// Reading an interrupted operation back.
//
// A missing record doesn't prove the write didn't run, so it leaves an operation `unknown`, never
// `failed`; and an operation is never re-sent under a new id (agentic tools.ts,
// OPERATION_NOT_FOUND_RULE). What can be read:
//   - trades: `candle_get_operation {clientId, kind: "trade"}`, which relays
//     GET /api/v1/trade/agent/jobs/:clientTradeId as `{ success, job }`;
//   - swaps: nothing reads a `clientSwapId`. Replaying the exact same candle_swap call returns the
//     stored result and never broadcasts twice; while it still runs, the replay is
//     IDEMPOTENCY_CONFLICT with `retryable: true` (docs.candle.tv/developers/agent-trading, "The base-asset swap
//     rail is free"). execute.ts does that, only within the card's lifetime.
//   - a TEE wallet's trades and swaps: a trade as above, any key on the account reads
//     it; a swap by `candle swap status <id> --kind swap` with the key that placed it (cli-trade.ts);
//   - launches: `candle_get_operation {clientId, kind: "launch"}`, which relays
//     GET /api/v1/launch/headless/jobs/:clientLaunchId. Staking and a staking reward claim are replayed
//     with the same id and body, as swaps are (execute.ts); fee claims, posts and profile edits have no
//     read, and wait for the user.
import type { ToolOutcome } from "./candle-mcp"

/** Every 5 seconds, every 30 after two minutes, for ten minutes at most. */
export function nextPollMs(startedAt: number, now: number): number | undefined {
  const elapsed = now - startedAt
  if (elapsed >= 10 * 60_000) return undefined
  return elapsed < 2 * 60_000 ? 5_000 : 30_000
}

export type JobState = "succeeded" | "failed" | "refused" | "unknown" | "pending"

export type TradeRead =
  | { found: false; detail: string }
  | { found: true; state: JobState; job: Record<string, unknown> }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * A trade job's state, as docs.candle.tv/developers/agent-trading ("Did it reach the chain?") reads the ledger:
 * `confirmed` executed; `failed` with a `signature` landed and reverted; `failed` with neither a
 * signature nor `broadcastAt` was never broadcast; `built` with either may have landed. `built` with
 * neither is still being built: read again.
 */
export function jobState(job: Record<string, unknown>): JobState {
  const sent = typeof job.signature === "string" || job.broadcastAt !== undefined
  switch (job.status) {
    case "confirmed":
      return "succeeded"
    case "failed": {
      // A Hood TEE wallet's trade runs as legs, each signed once the one before it landed, and Candle has recorded a leg
      // that landed as failed. So a failed job's legs say what may have gone out: an attempted trade leg leaves it
      // unknown; an attempted approval alone traded nothing, but spent its gas.
      const legs = sequencedLegs(job)
      if (legs) {
        const tried = legs.filter((l) => l.status !== "planned")
        if (tried.some((l) => l.kind === "trade")) return "unknown"
        if (tried.length > 0) return "failed"
      }
      return sent ? "failed" : "refused"
    }
    case "built":
      return sent ? "unknown" : "pending"
    default:
      return "unknown"
  }
}

/** A Hood TEE wallet's operation legs on a trade job (`job.operation.legs`), each with its kind and status; undefined on any other job. */
export function sequencedLegs(job: Record<string, unknown>): { kind: string; status: string }[] | undefined {
  const legs = record(job.operation)?.legs
  if (!Array.isArray(legs)) return undefined
  return legs.flatMap((l) => {
    const leg = record(l)
    return typeof leg?.kind === "string" && typeof leg.status === "string" ? [{ kind: leg.kind, status: leg.status }] : []
  })
}

/** A failed Hood job's error from its legs, for a read-back that finds it later; undefined for any other job. */
export function sequencedFailure(job: Record<string, unknown>): { code: string; message: string; retryable: false } | undefined {
  const legs = sequencedLegs(job)
  if (!legs || job.status !== "failed") return undefined
  const tried = legs.filter((l) => l.status !== "planned")
  const code = typeof job.errorCode === "string" ? job.errorCode : "SWAP_FAILED"
  if (tried.some((l) => l.kind === "trade")) {
    return { code, message: "Candle says this Hood trade failed after its trade step was sent, and it may have filled: what the wallet holds says. It isn't sent again.", retryable: false }
  }
  if (tried.length > 0) {
    return { code, message: "Nothing was traded. Candle stopped this Hood trade at its approval step, which may have landed and spent its gas (Candle has recorded a landed step as failed). Asking again builds it fresh, and skips an approval already in place.", retryable: false }
  }
  return undefined
}

/**
 * A launch job's state (docs.candle.tv/developers/headless-launch, "Async launches and jobs"): `submitted` and
 * `confirming` are still in flight, a row left `submitted` after a confirmation timeout included;
 * `confirmed` minted; `failed` (with `errorCode`) minted nothing, and a same-id retry starts over.
 */
export function launchJobState(job: Record<string, unknown>): JobState {
  switch (job.status) {
    case "confirmed":
      return "succeeded"
    case "failed":
      return "failed"
    case "submitted":
    case "confirming":
      return "pending"
    default:
      return "unknown"
  }
}

type Reader = { call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> }

/** One read of a trade or a launch by its id. Any failure of the read says nothing about the write. */
export async function readJob(child: Reader, clientId: string, kind: "trade" | "launch"): Promise<TradeRead> {
  const outcome = await child.call("candle_get_operation", { clientId, kind })
  if (outcome.kind === "lost") return { found: false, detail: `no answer (${outcome.reason})` }
  if (outcome.kind === "error") return { found: false, detail: outcome.code }
  const job = record(record(outcome.result)?.job)
  if (!job) return { found: false, detail: "unreadable" }
  return { found: true, state: kind === "launch" ? launchJobState(job) : jobState(job), job }
}

/** One read of a trade by its id. */
export function readTrade(child: Reader, clientTradeId: string): Promise<TradeRead> {
  return readJob(child, clientTradeId, "trade")
}
