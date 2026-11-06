// Reconciliation, cut to trades: the cadence, and reading a job.
import { describe, expect, test } from "bun:test"
import type { ToolOutcome } from "./candle-mcp"
import { jobState, launchJobState, nextPollMs, readJob, readTrade } from "./reconcile"

describe("nextPollMs", () => {
  test("every 5 s for two minutes, every 30 s to ten, then nothing", () => {
    expect(nextPollMs(0, 0)).toBe(5_000)
    expect(nextPollMs(0, 119_999)).toBe(5_000)
    expect(nextPollMs(0, 120_000)).toBe(30_000)
    expect(nextPollMs(0, 599_999)).toBe(30_000)
    expect(nextPollMs(0, 600_000)).toBeUndefined()
  })
})

describe("jobState", () => {
  test("the ledger as docs.candle.tv/developers/agent-trading reads it", () => {
    expect(jobState({ status: "confirmed", signature: "S" })).toBe("succeeded")
    expect(jobState({ status: "failed", signature: "S", errorCode: "TRADE_REVERTED" })).toBe("failed")
    expect(jobState({ status: "failed" })).toBe("refused")
    expect(jobState({ status: "failed", broadcastAt: 1 })).toBe("failed")
    expect(jobState({ status: "built", signature: "S" })).toBe("unknown")
    expect(jobState({ status: "built", broadcastAt: 1 })).toBe("unknown")
    expect(jobState({ status: "built" })).toBe("pending")
    expect(jobState({ status: "something-new" })).toBe("unknown")
  })
})

describe("readTrade", () => {
  const child = (outcome: ToolOutcome) => {
    const calls: unknown[] = []
    return { calls, call: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), outcome) }
  }

  test("reads by the same id, kind trade", async () => {
    const c = child({ kind: "ok", result: { success: true, job: { status: "confirmed", signature: "S" } } })
    expect(await readTrade(c, "op-1")).toMatchObject({ found: true, state: "succeeded" })
    expect(c.calls).toEqual([{ name: "candle_get_operation", args: { clientId: "op-1", kind: "trade" } }])
  })

  test("a JOB_NOT_FOUND, a lost read or an unreadable one is not found, never an outcome", async () => {
    expect(await readTrade(child({ kind: "error", code: "JOB_NOT_FOUND", retryable: false, body: {} }), "x")).toEqual({ found: false, detail: "JOB_NOT_FOUND" })
    expect(await readTrade(child({ kind: "lost", reason: "timeout" }), "x")).toEqual({ found: false, detail: "no answer (timeout)" })
    expect(await readTrade(child({ kind: "ok", result: { success: true } }), "x")).toEqual({ found: false, detail: "unreadable" })
  })
})

describe("launches", () => {
  test("a launch job's states, as docs.candle.tv/developers/headless-launch lists them", () => {
    expect(launchJobState({ status: "confirmed", mint: "M", signature: "S" })).toBe("succeeded")
    expect(launchJobState({ status: "failed", errorCode: "LAUNCH_FAILED" })).toBe("failed")
    expect(launchJobState({ status: "submitted" })).toBe("pending")
    expect(launchJobState({ status: "confirming" })).toBe("pending")
    expect(launchJobState({ status: "something-new" })).toBe("unknown")
  })

  test("a launch is read with kind launch; a missing one is not found, which says nothing about the write", async () => {
    const asked: Record<string, unknown>[] = []
    const answers: ToolOutcome[] = [
      { kind: "ok", result: { success: true, job: { clientLaunchId: "L1", status: "confirmed" } } },
      { kind: "error", code: "JOB_NOT_FOUND", retryable: false, body: {} },
    ]
    const child = { call: async (_name: string, args: Record<string, unknown>) => (asked.push(args), answers.shift()!) }
    expect(await readJob(child, "L1", "launch")).toMatchObject({ found: true, state: "succeeded" })
    expect(await readJob(child, "L1", "launch")).toEqual({ found: false, detail: "JOB_NOT_FOUND" })
    expect(asked).toEqual([{ clientId: "L1", kind: "launch" }, { clientId: "L1", kind: "launch" }])
  })
})
