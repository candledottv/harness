// Execution and reconciliation: a lost answer is never re-sent under a new id.
// It becomes `unknown` and is read back by the same id (trades through candle_get_operation, swaps by
// replaying the same call within the card's lifetime); a re-send reuses the id and the body, and a
// refused re-send settles nothing.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { type ToolOutcome, toOutcome } from "./candle-mcp"
import type { Card } from "./cards"
import { Journal } from "./journal"
import { type Mapped, type Operation, operationLogLine, Operations, outcomeOf, refusalMessage } from "./execute"
import { mapCliTrade } from "./cli-trade"
import { jobState, type TradeRead } from "./reconcile"

const MOON = "MoonFake11111111111111111111111111111111111"
const T0 = Date.parse("2026-10-26T12:00:00Z")
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const trade = (api: Record<string, unknown>, isOk = true): ToolOutcome =>
  isOk ? { kind: "ok", result: { clientTradeId: "x", resolved: {}, api } } : { kind: "error", code: String((api.error as { code: string }).code), retryable: (api.error as { retryable?: boolean }).retryable === true, body: { clientTradeId: "x", resolved: {}, api } }
const tradeError = (error: Record<string, unknown>) => trade({ success: false, error }, false)
const swapError = (error: Record<string, unknown>): ToolOutcome => ({ kind: "error", code: String(error.code), retryable: error.retryable === true, body: { clientSwapId: "s", success: false, error } })
const job = (j: Record<string, unknown>): ToolOutcome => ({ kind: "ok", result: { success: true, job: { clientTradeId: "x", ...j } } })
const notFound: ToolOutcome = { kind: "error", code: "JOB_NOT_FOUND", retryable: false, body: { outcome: "unknown" } }
const lost: ToolOutcome = { kind: "lost", reason: "timeout" }

test("KEY_LIMIT_REACHED says Candle counts all volume, that sells still go, and the reset in UTC", () => {
  const text = refusalMessage("KEY_LIMIT_REACHED", { resetsAt: Date.parse("2026-10-28T00:00:00Z") })!
  expect(text).toContain("buys, sells and swaps")
  expect(text).toContain("Selling a token still works.")
  expect(text).toContain("It resets at 00:00 UTC on 2026-10-28.")
  expect(refusalMessage("KEY_LIMIT_REACHED", { resetsAt: null })).toContain("doesn't reset")
  expect(text).toContain("which counts buys and swaps")
})

test("KEY_LIMIT_REACHED reads its reset under details too, and claims no lifetime cap when none is given", () => {
  const nested = refusalMessage("KEY_LIMIT_REACHED", { details: { resetsAt: Date.parse("2026-11-05T00:00:00Z") } })!
  expect(nested).toContain("It resets at 00:00 UTC on 2026-11-05.")
  expect(nested).not.toContain("doesn't reset")
  const silent = refusalMessage("KEY_LIMIT_REACHED", {})!
  expect(silent).not.toContain("doesn't reset")
  expect(silent).toContain("Nothing was sent.")
})

describe("outcome rules", () => {
  test("ok: an executed trade succeeded; a pending status is pending; a paper result is marked paper", () => {
    expect(outcomeOf("trade", trade({ success: true, status: "executed", signature: "S" }))).toMatchObject({ state: "succeeded" })
    expect(outcomeOf("trade", trade({ success: true, status: "pending" }))).toMatchObject({ state: "pending" })
    expect(outcomeOf("trade", trade({ success: true, paper: true }))).toMatchObject({ state: "succeeded", paper: true })
    expect(outcomeOf("swap", { kind: "ok", result: { clientSwapId: "s", success: true, payload: { hashes: ["H"] } } })).toMatchObject({ state: "succeeded" })
  })

  test("an error is decided by its stage, not by retryable", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ code: "SPEND_POLICY_DENIED", retryable: false }, "refused"],
      [{ code: "SWAP_FAILED", stage: "not_broadcast", retryable: true }, "refused"],
      [{ code: "DELEGATION_REVOKED", stage: "presign_refused" }, "refused"],
      [{ code: "SWAP_FAILED", stage: "unconfirmed", retryable: false, signature: "S" }, "unknown"],
      [{ code: "SWAP_FAILED", stage: "executed", signature: "S" }, "succeeded"],
      [{ code: "TRADE_REVERTED", stage: "reverted", signature: "S" }, "failed"],
    ]
    for (const [error, state] of cases) {
      expect(`${error.code}/${error.stage}: ${outcomeOf("trade", tradeError(error)).state}`).toBe(`${error.code}/${error.stage}: ${state}`)
    }
  })

  test("KEY_LIMIT_REACHED with retryable and no stage is refused, and says when it resets", () => {
    const resetsAt = Date.parse("2026-10-27T00:00:00Z")
    const out = outcomeOf("trade", tradeError({ code: "KEY_LIMIT_REACHED", retryable: true, resetsAt }))
    expect(out).toMatchObject({ state: "refused", error: { code: "KEY_LIMIT_REACHED", retryable: true, resetsAt } })
    expect(out.error!.message).toContain("Candle key limit")
    expect(out.error!.message).toContain("resets")
  })

  test("KEY_LIMIT_REACHED's limit_unavailable is Candle's outage, not a spent cap, and carries when to ask again", () => {
    const retryAfter = Date.parse("2026-10-31T15:30:30Z")
    const out = outcomeOf("trade", tradeError({ code: "KEY_LIMIT_REACHED", retryable: true, resetsAt: null, reason: "limit_unavailable", retryAfter }))
    expect(out).toMatchObject({ state: "refused", error: { code: "KEY_LIMIT_REACHED", resetsAt: null, reason: "limit_unavailable", retryAfter } })
    expect(out.error!.message).toContain("couldn't check this agent's key limit just now")
    expect(out.error!.message).not.toContain("doesn't reset")
  })

  test("a swap error in the { success: false, error } shape is read the same way", () => {
    expect(outcomeOf("swap", swapError({ code: "SWAP_FAILED", stage: "unconfirmed" })).state).toBe("unknown")
    expect(outcomeOf("swap", swapError({ code: "RATE_LIMITED", retryable: true })).state).toBe("refused")
  })

  test("a second leg that failed is shown as part done, with the first leg's hash", () => {
    const out = outcomeOf("swap", { kind: "error", code: "LEG2_FAILED", retryable: false, body: { clientSwapId: "s", success: false, error: { code: "LEG2_FAILED", retryable: false }, payload: { leg1: "LEG1HASH" } } })
    expect(out).toMatchObject({ state: "failed", partial: { leg1: "LEG1HASH" } })
  })

  test("lost answers are unknown; nothing sent is refused", () => {
    for (const reason of ["child_exited", "timeout", "transport", "unparseable"] as const) {
      expect(outcomeOf("trade", { kind: "lost", reason }).state).toBe("unknown")
    }
    expect(outcomeOf("trade", { kind: "error", code: "MCP_VALIDATION", retryable: false, body: "MCP error -32602: ..." }).state).toBe("refused")
    expect(outcomeOf("trade", { kind: "error", code: "CANDLE_MCP_DOWN", retryable: true, body: {} }).state).toBe("refused")
  })

  test("a listed pre-send code that comes back retryable with no stage is read back by its id, bar a rate or key limit", () => {
    // Candle answers VALIDATION_FAILED, retryable, for a generic server error in some routes: the code alone doesn't prove nothing went out.
    expect(outcomeOf("trade", tradeError({ code: "VALIDATION_FAILED", retryable: true }))).toMatchObject({ state: "unknown", reason: "VALIDATION_FAILED without a stage, so it may have been sent" })
    expect(outcomeOf("swap", swapError({ code: "VALIDATION_FAILED", retryable: true })).state).toBe("unknown")
    expect(outcomeOf("trade", tradeError({ code: "MARKET_NOT_FOUND", retryable: true })).state).toBe("unknown")
    // The same codes, not retryable, are still refused; so are a rate limit and a key limit, which are retryable by design.
    expect(outcomeOf("trade", tradeError({ code: "VALIDATION_FAILED", retryable: false })).state).toBe("refused")
    expect(outcomeOf("trade", tradeError({ code: "RATE_LIMITED", retryable: true })).state).toBe("refused")
    expect(outcomeOf("swap", swapError({ code: "KEY_LIMIT_REACHED", retryable: true })).state).toBe("refused")
    // Candle's route breaker refusing a pair with its own wait refuses before any swap is built; a bare one is read back.
    expect(outcomeOf("trade", tradeError({ code: "SWAP_ROUTE_FAILING", retryable: true, retry_after_seconds: 120 })).state).toBe("refused")
    expect(outcomeOf("swap", swapError({ code: "SWAP_ROUTE_FAILING", retryable: true, details: { retry_after_seconds: 60 } })).state).toBe("refused")
    expect(outcomeOf("trade", tradeError({ code: "SWAP_ROUTE_FAILING", retryable: true })).state).toBe("unknown")
  })

  test("a trade or swap error with no stage is read back by its id unless Candle documents it as before anything was sent", () => {
    // candle mcp's own code for a body it couldn't read (a 5xx page, say), and a bare SWAP_FAILED, may have been sent.
    expect(outcomeOf("trade", { kind: "error", code: "UNKNOWN_ERROR", retryable: false, body: { error: "Bad Gateway" } })).toMatchObject({ state: "unknown", reason: "UNKNOWN_ERROR without a stage, so it may have been sent" })
    expect(outcomeOf("trade", tradeError({ code: "UNKNOWN_ERROR" })).state).toBe("unknown")
    expect(outcomeOf("trade", tradeError({ code: "SWAP_FAILED", retryable: false })).state).toBe("unknown")
    expect(outcomeOf("swap", swapError({ code: "SWAP_FAILED" })).state).toBe("unknown")
    expect(outcomeOf("swap", swapError({ code: "SOMETHING_NEW" })).state).toBe("unknown")
    // The same id still running is unknown; a different body under it sent nothing new.
    expect(outcomeOf("trade", tradeError({ code: "IDEMPOTENCY_CONFLICT", retryable: true })).state).toBe("unknown")
    expect(outcomeOf("trade", tradeError({ code: "IDEMPOTENCY_CONFLICT", retryable: false })).state).toBe("refused")
    for (const code of ["RATE_LIMITED", "KEY_LIMIT_REACHED", "SPEND_LIMIT_EXCEEDED", "TIER_REQUIRED", "VALIDATION_FAILED", "MARKET_NOT_FOUND", "WALLET_BUSY", "SWAP_ROUTE_FAILING"]) {
      expect(`${code}: ${outcomeOf("trade", tradeError({ code })).state}`).toBe(`${code}: refused`)
      expect(`${code}: ${outcomeOf("swap", swapError({ code })).state}`).toBe(`${code}: refused`)
    }
    // A body nobody could parse never reached an error code at all: lost, so unknown.
    expect(outcomeOf("trade", toOutcome({ content: [{ type: "text", text: "<html>502</html>" }], isError: true })).state).toBe("unknown")
  })

  test("each known refusal gets a plain message", () => {
    const codes = [
      "EMBEDDED_WALLET_NOT_PERMITTED",
      "DELEGATION_REVOKED",
      "PROFILE_PAUSED",
      "RISK_LIMIT_REACHED",
      "KEY_EXPIRED",
      "KEY_LIMIT_REACHED",
      "SPEND_LIMIT_EXCEEDED",
      "TIER_REQUIRED",
      "RATE_LIMITED",
      "TEST_ENVIRONMENT_FORBIDDEN",
      "IDEMPOTENCY_CONFLICT",
    ]
    for (const code of codes) {
      const message = outcomeOf("trade", tradeError({ code, message: "raw server text" })).error!.message
      expect(`${code}: ${message === "raw server text"}`).toBe(`${code}: false`)
    }
    expect(outcomeOf("trade", tradeError({ code: "RISK_LIMIT_REACHED" })).error!.message).toContain("sells included")
    // An unknown code keeps the server's words, made safe to draw.
    expect(outcomeOf("trade", tradeError({ code: "NEW_CODE", message: "odd\u001b[2J" })).error!.message).toBe("odd[2J")
  })
})

// A scripted pool and a hand-driven clock and timer queue.
async function setup(opts: { script?: Record<string, ToolOutcome[]>; loseNextReply?: boolean; paused?: () => boolean; resendHold?: (op: Operation) => string | undefined; cli?: (op: Operation) => Promise<Mapped>; cliRead?: (op: Operation) => Promise<{ mapped: Mapped; detail: string } | undefined>; cliTrades?: { execute(op: Operation): Promise<Mapped>; read(op: Operation): Promise<TradeRead> } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "chrn-exec-"))
  dirs.push(dir)
  let now = T0
  const journalPath = join(dir, "journal.jsonl")
  const journal = await Journal.open({ path: journalPath, redactor: new Redactor(), account: "acct_fake", now: () => now })
  journals.push(journal)
  const calls: { agent: string; name: string; args: Record<string, unknown> }[] = []
  const script = opts.script ?? {}
  const pool = {
    for: (agent: string) => ({
      call: async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
        calls.push({ agent, name, args: structuredClone(args) })
        const queue = script[name] ?? []
        return queue.length > 1 ? queue.shift()! : (queue[0] ?? { kind: "ok", result: {} })
      },
    }),
  }
  const timers: { at: number; run: () => Promise<void> | void; cancelled: boolean }[] = []
  const settled: Operation[] = []
  const make = (j: Journal) =>
    new Operations({
      journal: j,
      pool,
      now: () => now,
      schedule: (run, ms) => {
        const timer = { at: now + ms, run, cancelled: false }
        timers.push(timer)
        return () => (timer.cancelled = true)
      },
      onChange: (op) => settled.push(structuredClone(op)),
      ...(opts.loseNextReply ? { loseNextReply: true } : {}),
      ...(opts.paused ? { paused: opts.paused } : {}),
      ...(opts.resendHold ? { resendHold: opts.resendHold } : {}),
      ...(opts.cli ? { cli: opts.cli } : {}),
      ...(opts.cliRead ? { cliRead: opts.cliRead } : {}),
      ...(opts.cliTrades ? { cliTrades: opts.cliTrades } : {}),
    })
  const ops = make(journal)
  /** Moves the clock on, running every timer that falls due, in order. */
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cancelled = true
      now = due.at
      await due.run()
    }
    now = until
  }
  return { ops, journal, journalPath, calls, script, timers, settled, advance, make, now: () => now }
}

function card(kind: "trade" | "swap", extra: Partial<Card> = {}): Card {
  const opId = extra.opId ?? `op-${kind}`
  const params = kind === "trade" ? { mint: MOON, side: "buy", amount: "0.05", clientTradeId: opId } : { from: "SOL", to: "USDC", amount: "0.04", clientSwapId: opId }
  return {
    cardId: `card-${opId}`,
    opId,
    idKey: kind === "trade" ? "clientTradeId" : "clientSwapId",
    kind,
    tool: kind === "trade" ? "candle_trade" : "candle_swap",
    asked: {},
    agent: "momentum",
    state: "approved",
    expiresAt: new Date(T0 + 60_000).toISOString(),
    params,
    cardHash: "h",
    origin: { clientId: "h1", role: "harness", source: "agent" },
    wallet: "W",
    account: "acct_fake",
    mode: "live",
    side: kind === "trade" ? "buy" : "swap",
    value: { usd: 7, unvalued: false },
    display: {} as Card["display"],
    createdAt: new Date(T0).toISOString(),
    ...extra,
  }
}

describe("execute", () => {
  test("operation.submitting is on disk before the call, then the outcome; the call goes through the card's own agent", async () => {
    const s = await setup({ script: { candle_trade: [trade({ success: true, status: "executed", signature: "S" })] } })
    let rowsAtCall: string[] = []
    const originalFor = s.ops["deps"].pool.for
    s.ops["deps"].pool.for = (agent: string) => {
      const child = originalFor(agent)
      return {
        call: async (name: string, args: Record<string, unknown>) => {
          rowsAtCall = (await Bun.file(s.journalPath).text()).trim().split("\n").map((l) => JSON.parse(l).type)
          return child.call(name, args)
        },
      }
    }
    const op = await s.ops.execute(card("trade", { agent: "swing" }))
    expect(rowsAtCall).toEqual(["operation.submitting"])
    expect(op.state).toBe("succeeded")
    expect(s.calls).toEqual([{ agent: "swing", name: "candle_trade", args: card("trade").params }])
    expect(s.journal.rows().map((r) => r.type)).toEqual(["operation.submitting", "operation.succeeded"])
    expect(s.journal.rows()[0]).toMatchObject({ opId: "op-trade", agent: "swing", tool: "candle_trade", params: card("trade").params })
  })

  test("a write-ahead row that can't be written: nothing sent, no operation left submitting, and the error goes to the approval", async () => {
    const s = await setup({ script: { candle_trade: [trade({ success: true, status: "executed", signature: "S" })] } })
    const append = s.journal.append.bind(s.journal)
    s.journal.append = (async (row: Parameters<typeof append>[0]) => {
      if (row.type === "operation.submitting") throw new Error("disk full")
      return append(row)
    }) as typeof s.journal.append
    await expect(s.ops.execute(card("trade"))).rejects.toThrow("disk full")
    expect(s.calls).toEqual([])
    expect(s.ops.get("op-trade")).toBeUndefined()
    expect(s.ops.list()).toEqual([])
  })

  test("a live sell that came back as paper is recorded as paper", async () => {
    const s = await setup({ script: { candle_trade: [trade({ success: true, paper: true })] } })
    const op = await s.ops.execute(card("trade", { side: "sell", params: { mint: MOON, side: "sell", amount: "10", clientTradeId: "op-trade" } }))
    expect(op).toMatchObject({ state: "succeeded", paper: true })
    expect(s.journal.rows().at(-1)).toMatchObject({ type: "operation.succeeded", paper: true })
    expect(String(s.journal.rows().at(-1)!.note)).toContain("live wallet had nothing to sell")
  })

  test("the child dying mid-call is unknown, read back at once by the same id, and settled", async () => {
    const s = await setup({ script: { candle_trade: [{ kind: "lost", reason: "child_exited" }], candle_get_operation: [job({ status: "confirmed", signature: "S" })] } })
    const op = await s.ops.execute(card("trade"))
    expect(op.state).toBe("unknown")
    await s.advance(0)
    expect(s.calls.map((c) => c.name)).toEqual(["candle_trade", "candle_get_operation"])
    expect(s.calls[1]!.args).toEqual({ clientId: "op-trade", kind: "trade" })
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
  })

  test("an UNKNOWN_ERROR on a trade is unknown and read back by the same id, never settled as nothing sent", async () => {
    const s = await setup({ script: { candle_trade: [{ kind: "error", code: "UNKNOWN_ERROR", retryable: false, body: { error: "Bad Gateway" } }], candle_get_operation: [job({ status: "confirmed", signature: "S" })] } })
    const op = await s.ops.execute(card("trade"))
    expect(op.state).toBe("unknown")
    expect(s.journal.rows().map((r) => r.type)).not.toContain("operation.refused")
    await s.advance(0)
    expect(s.calls.map((c) => c.name)).toEqual(["candle_trade", "candle_get_operation"])
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
  })

  test("the poll timing: 0 ms after a lost answer, every 5 s, every 30 s after 2 minutes, stopping at 10 minutes", async () => {
    const s = await setup({ script: { candle_trade: [lost], candle_get_operation: [notFound] } })
    await s.ops.execute(card("trade"))
    const readsAt: number[] = []
    const base = s.now()
    const original = s.ops["deps"].pool.for
    s.ops["deps"].pool.for = (agent: string) => ({
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === "candle_get_operation") readsAt.push(s.now() - base)
        return original(agent).call(name, args)
      },
    })
    await s.advance(11 * 60_000)
    expect(readsAt[0]).toBe(0)
    expect(readsAt[1]).toBe(5_000)
    expect(readsAt.filter((t) => t < 120_000)).toHaveLength(24) // 0, 5, ..., 115 s
    const after = readsAt.filter((t) => t >= 120_000)
    expect(after.every((t, i) => i === 0 || t - after[i - 1]! === 30_000)).toBe(true)
    expect(Math.max(...readsAt)).toBeLessThan(600_000)
    expect(s.ops.get("op-trade")!.state).toBe("unknown") // a JOB_NOT_FOUND stays unknown
  })

  test("a pending answer is first read 5 s later", async () => {
    const s = await setup({ script: { candle_trade: [trade({ success: true, status: "pending" })], candle_get_operation: [job({ status: "confirmed", signature: "S" })] } })
    await s.ops.execute(card("trade"))
    await s.advance(4_999)
    expect(s.calls.filter((c) => c.name === "candle_get_operation")).toHaveLength(0)
    await s.advance(1)
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
  })

  test("trade job states map as the docs say", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ status: "confirmed", signature: "S" }, "succeeded"],
      [{ status: "built", signature: "S" }, "unknown"],
      [{ status: "built", broadcastAt: 1 }, "unknown"],
      [{ status: "failed", signature: "S", errorCode: "TRADE_REVERTED" }, "failed"],
      [{ status: "failed" }, "refused"],
    ]
    for (const [j, state] of cases) {
      const s = await setup({ script: { candle_trade: [lost], candle_get_operation: [job(j)] } })
      await s.ops.execute(card("trade"))
      await s.advance(0)
      expect(`${JSON.stringify(j)}: ${s.ops.get("op-trade")!.state}`).toBe(`${JSON.stringify(j)}: ${state}`)
    }
  })

  test("a kill between submitting and the reply, then a restart: unknown, read back, settled", async () => {
    const s = await setup({ script: { candle_get_operation: [job({ status: "confirmed", signature: "S" })] } })
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-trade", cardId: "card-op-trade", kind: "trade", tool: "candle_trade", params: card("trade").params, cardExpiresAt: T0 + 60_000 })
    // A new core, on the same journal.
    const restarted = s.make(s.journal)
    const turned = await restarted.rebuild(s.journal.rows())
    restarted.readBack()
    expect(turned).toEqual(["op-trade"])
    expect(s.journal.rows().at(-1)).toMatchObject({ type: "operation.unknown", opId: "op-trade", reason: "core_restarted" })
    await s.advance(0)
    expect(restarted.get("op-trade")!.state).toBe("succeeded")
    expect(s.calls.map((c) => c.name)).toEqual(["candle_get_operation"]) // never re-sent
  })

  test("the debug switch: the call is sent once, the answer is dropped, and the read-back settles it", async () => {
    const s = await setup({
      loseNextReply: true,
      script: { candle_trade: [trade({ success: true, status: "executed", signature: "S" })], candle_get_operation: [job({ status: "confirmed", signature: "S" })] },
    })
    expect(s.ops.losingNextReply()).toBe(true)
    const op = await s.ops.execute(card("trade"))
    expect(op.state).toBe("unknown")
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    // Used up: the status bar's DEBUG segment goes with it.
    expect(s.ops.losingNextReply()).toBe(false)
    await s.advance(0)
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
    // Only the next reply: the one after that is read as normal.
    expect((await s.ops.execute(card("trade", { opId: "op-2" }))).state).toBe("succeeded")
  })
})

describe("swaps", () => {
  test("a lost swap is read back by replaying the same call: running is waited out, and it never runs twice", async () => {
    const s = await setup({
      script: {
        candle_swap: [
          lost,
          swapError({ code: "IDEMPOTENCY_CONFLICT", retryable: true }),
          { kind: "ok", result: { clientSwapId: "op-swap", success: true, payload: { hashes: ["H"] } } },
        ],
      },
    })
    await s.ops.execute(card("swap"))
    await s.advance(0)
    expect(s.ops.get("op-swap")!.state).toBe("unknown")
    await s.advance(5_000)
    expect(s.ops.get("op-swap")!.state).toBe("succeeded")
    const swaps = s.calls.filter((c) => c.name === "candle_swap")
    expect(swaps).toHaveLength(3)
    expect(new Set(swaps.map((c) => JSON.stringify(c.args))).size).toBe(1) // the same id and body every time
  })

  test("no automatic replay after the card's 60 s: it waits for the user", async () => {
    const s = await setup({ script: { candle_swap: [lost, swapError({ code: "IDEMPOTENCY_CONFLICT", retryable: true })] } })
    await s.ops.execute(card("swap", { expiresAt: new Date(T0 + 7_000).toISOString() }))
    await s.advance(60_000)
    // Replayed at 0 and 5 s; nothing at 10 s or later.
    expect(s.calls.filter((c) => c.name === "candle_swap")).toHaveLength(3)
    expect(s.ops.get("op-swap")!.state).toBe("unknown")
  })
})

describe("a refused replay is an answer about the replay", () => {
  const filled: ToolOutcome = { kind: "ok", result: { clientSwapId: "op-swap", success: true, payload: { hashes: ["H"] } } }
  for (const refusal of <ToolOutcome[]>[
    swapError({ code: "RATE_LIMITED", retryable: true }),
    swapError({ code: "KEY_LIMIT_REACHED", retryable: false }),
    swapError({ code: "IDEMPOTENCY_CONFLICT", retryable: false }),
    { kind: "error", code: "CANDLE_MCP_DOWN", retryable: true, body: undefined },
  ]) {
    const code = (refusal as { code: string }).code
    test(`a lost swap whose replay is refused with ${code} stays unknown, frees nothing, and settles on the next replay`, async () => {
      const s = await setup({ script: { candle_swap: [lost, refusal, filled] } })
      await s.ops.execute(card("swap"))
      await s.advance(0)
      expect(s.ops.get("op-swap")!.state).toBe("unknown")
      expect(s.settled.some((o) => o.state === "refused")).toBe(false)
      expect(s.journal.rows().some((r) => r.type === "operation.check" && r.refusedReplay === code)).toBe(true)
      await s.advance(5_000)
      expect(s.ops.get("op-swap")!.state).toBe("succeeded")
    })
  }

  test("a replay Candle refuses keeps it unknown with Candle's own words, which go once it's read", async () => {
    const refusal = swapError({ code: "SPEND_LIMIT_EXCEEDED", retryable: false, message: "over this key's spend limit" })
    const s = await setup({ script: { candle_swap: [lost, refusal, filled] } })
    await s.ops.execute(card("swap"))
    await s.advance(0)
    expect(s.ops.get("op-swap")!.state).toBe("unknown")
    expect(s.ops.get("op-swap")!.error?.code).toBe("SPEND_LIMIT_EXCEEDED")
    expect(s.ops.get("op-swap")!.error?.message).toContain("spend cap")
    expect(s.settled.at(-1)!.error?.code).toBe("SPEND_LIMIT_EXCEEDED")
    await s.advance(5_000)
    expect(s.ops.get("op-swap")!.state).toBe("succeeded")
    expect(s.ops.get("op-swap")!.error).toBeUndefined()
  })

  test("a replay refused at a stage that says nothing was sent does settle it refused", async () => {
    const s = await setup({ script: { candle_swap: [lost, swapError({ code: "SWAP_FAILED", stage: "not_broadcast" })] } })
    await s.ops.execute(card("swap"))
    await s.advance(0)
    expect(s.ops.get("op-swap")!.state).toBe("refused")
  })

  test("a restarted core whose Candle child isn't up yet keeps the swap unknown, then reads it", async () => {
    const s = await setup({ script: { candle_swap: [{ kind: "error", code: "CANDLE_MCP_DOWN", retryable: true, body: undefined }, filled] } })
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-swap", cardId: "card-op-swap", kind: "swap", tool: "candle_swap", params: card("swap").params, cardExpiresAt: T0 + 30_000 })
    const restarted = s.make(s.journal)
    await restarted.rebuild(s.journal.rows())
    restarted.readBack()
    await s.advance(0)
    expect(restarted.get("op-swap")!.state).toBe("unknown")
    await s.advance(5_000)
    expect(restarted.get("op-swap")!.state).toBe("succeeded")
  })
})

describe("swaps after a restart", () => {
  test("an unknown swap whose card has expired is never replayed by the core on its own", async () => {
    const s = await setup()
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-swap", cardId: "card-op-swap", kind: "swap", tool: "candle_swap", params: card("swap").params, cardExpiresAt: T0 - 1 })
    const restarted = s.make(s.journal)
    expect(await restarted.rebuild(s.journal.rows())).toEqual(["op-swap"])
    restarted.readBack()
    await s.advance(60_000)
    expect(s.calls).toEqual([])
    expect(restarted.get("op-swap")!.state).toBe("unknown")
  })

  test("within the card's lifetime, a restarted core replays it", async () => {
    const s = await setup({ script: { candle_swap: [{ kind: "ok", result: { clientSwapId: "op-swap", success: true, payload: { hashes: ["H"] } } }] } })
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-swap", cardId: "card-op-swap", kind: "swap", tool: "candle_swap", params: card("swap").params, cardExpiresAt: T0 + 30_000 })
    const restarted = s.make(s.journal)
    await restarted.rebuild(s.journal.rows())
    restarted.readBack()
    await s.advance(0)
    expect(restarted.get("op-swap")!.state).toBe("succeeded")
    expect(s.calls.map((c) => c.args)).toEqual([card("swap").params])
  })
})

// Candle's MCP card tools: each kind's outcome rules and how a lost answer is read.
function mcpCard(tool: string, params: Record<string, unknown>, extra: Partial<Card> = {}): Card {
  const kind = tool.includes("launch") ? "launch" : tool.includes("stake") ? "stake" : tool.includes("claim") ? "claim" : "public"
  return card("trade", { opId: `op-${kind}`, cardId: `card-op-${kind}`, kind, tool, idKey: kind === "launch" ? "clientLaunchId" : kind === "stake" ? "clientStakeId" : "coreOpId", params, side: undefined, expiresAt: new Date(T0 + 10 * 60_000).toISOString(), ...extra })
}
const envelope = (error: Record<string, unknown>, extra: Record<string, unknown> = {}): ToolOutcome => ({ kind: "error", code: String(error.code), retryable: error.retryable === true, body: { ...extra, success: false, error } })
const launchJob = (j: Record<string, unknown>): ToolOutcome => ({ kind: "ok", result: { success: true, job: { clientLaunchId: "op-launch", chain: "solana", ...j } } })

describe("outcome rules for Candle's MCP card tools", () => {
  test("a launch: confirmed is done; a failure that may have minted is unknown; in flight is pending; a refusal before anything ran is refused", () => {
    expect(outcomeOf("launch", { kind: "ok", result: { success: true, chain: "solana", mint: "MintFake", signature: "S" } }).state).toBe("succeeded")
    expect(outcomeOf("launch", { kind: "ok", result: { clientLaunchId: "x", launch: { mint: "MintFake" }, market: null } }).state).toBe("succeeded")
    // docs.candle.tv/developers/headless-launch, "Errors": LAUNCH_FAILED includes a confirmation timeout.
    expect(outcomeOf("launch", envelope({ code: "LAUNCH_FAILED", retryable: true })).state).toBe("unknown")
    expect(outcomeOf("launch", envelope({ code: "IDEMPOTENCY_CONFLICT", retryable: true })).state).toBe("pending")
    expect(outcomeOf("launch", envelope({ code: "IDEMPOTENCY_CONFLICT", retryable: false, reason: "request_mismatch" })).state).toBe("refused")
    expect(outcomeOf("launch", envelope({ code: "DAILY_CAP_REACHED", retryable: true })).state).toBe("refused")
    // candle_launch_and_seed's API body rides under `api`; an atomic bundle that timed out may still land.
    const atomic = (status: string): ToolOutcome => ({ kind: "error", code: "UNKNOWN_ERROR", retryable: false, body: { clientLaunchId: "x", bundleId: "B", api: { status } } })
    expect(outcomeOf("launch", atomic("timeout")).state).toBe("unknown")
    expect(outcomeOf("launch", atomic("failed")).state).toBe("failed")
    expect(outcomeOf("launch", { kind: "error", code: "INSUFFICIENT_OWNER_BALANCE", retryable: true, body: { clientLaunchId: "x", api: { success: false, error: { code: "INSUFFICIENT_OWNER_BALANCE" } } } }).state).toBe("refused")
  })

  test("staking and claims: still running is pending; a reward claim that failed after its checks is unknown; the stage rule otherwise", () => {
    expect(outcomeOf("stake", { kind: "ok", result: { success: true, dryRun: false, status: "confirmed", signature: "S" } }).state).toBe("succeeded")
    expect(outcomeOf("stake", envelope({ code: "STAKING_TRANSACTION_PENDING", retryable: true })).state).toBe("pending")
    expect(outcomeOf("claim", envelope({ code: "REWARD_CLAIM_PENDING", retryable: true })).state).toBe("pending")
    expect(outcomeOf("claim", envelope({ code: "STAKING_REWARD_CLAIM_FAILED", retryable: true })).state).toBe("unknown")
    expect(outcomeOf("claim", envelope({ code: "FEE_NOT_CLAIMABLE" })).state).toBe("refused")
    expect(outcomeOf("claim", envelope({ code: "FEE_CLAIM_FAILED", stage: "unconfirmed" })).state).toBe("unknown")
    expect(outcomeOf("public", envelope({ code: "RATE_LIMITED", retryable: true })).state).toBe("refused")
  })
})

describe("reading back Candle's MCP card tools", () => {
  test("a lost launch is read back by its clientLaunchId, kind launch, and never sent again on the core's own", async () => {
    const s = await setup({ script: { candle_launch_token: [lost], candle_get_operation: [notFound, launchJob({ status: "submitted" }), launchJob({ status: "confirmed", mint: "MintFake", signature: "S" })] } })
    await s.ops.execute(mcpCard("candle_launch_token", { name: "Fake", symbol: "FAKE", imageUrl: "https://x", clientLaunchId: "op-launch", dryRun: false }))
    await s.advance(0)
    expect(s.ops.get("op-launch")!.state).toBe("unknown")
    await s.advance(5_000)
    expect(s.ops.get("op-launch")!.state).toBe("pending")
    await s.advance(5_000)
    expect(s.ops.get("op-launch")!.state).toBe("succeeded")
    expect(s.calls.filter((c) => c.name === "candle_launch_token")).toHaveLength(1)
    expect(s.calls.filter((c) => c.name === "candle_get_operation").map((c) => c.args)).toEqual(Array(3).fill({ clientId: "op-launch", kind: "launch" }))
  })

  test("a launch job that failed is failed: no token", async () => {
    const s = await setup({ script: { candle_launch_and_seed: [lost], candle_get_operation: [launchJob({ status: "failed", errorCode: "LAUNCH_FAILED" })] } })
    await s.ops.execute(mcpCard("candle_launch_and_seed", { name: "Fake", symbol: "FAKE", imageUrl: "https://x", clientLaunchId: "op-launch", dryRun: false }))
    await s.advance(0)
    expect(s.ops.get("op-launch")!.state).toBe("failed")
  })

  test("a lost stake is replayed with the same id and body within the card's lifetime, and waits for the user after it", async () => {
    const params = { payer: "main", amountRaw: "100", clientStakeId: "op-stake", dryRun: false }
    const s = await setup({ script: { candle_stake: [lost, envelope({ code: "STAKING_TRANSACTION_PENDING", retryable: true }), { kind: "ok", result: { success: true, dryRun: false, status: "confirmed", signature: "S" } }] } })
    await s.ops.execute(mcpCard("candle_stake", params))
    await s.advance(0)
    expect(s.ops.get("op-stake")!.state).toBe("unknown")
    await s.advance(5_000)
    expect(s.ops.get("op-stake")!.state).toBe("succeeded")
    const sends = s.calls.filter((c) => c.name === "candle_stake")
    expect(sends).toHaveLength(3)
    expect(new Set(sends.map((c) => JSON.stringify(c.args)))).toEqual(new Set([JSON.stringify(params)]))

    const late = await setup({ script: { candle_unstake: [lost] } })
    await late.ops.execute(mcpCard("candle_unstake", params, { expiresAt: new Date(T0 - 1).toISOString() }))
    await late.advance(60_000)
    expect(late.calls.filter((c) => c.name === "candle_unstake")).toHaveLength(1)
    expect(late.ops.get("op-stake")!.state).toBe("unknown")
  })

  test("a lost staking reward claim is replayed by its rewardId, which never pays twice (docs.candle.tv/developers/claims)", async () => {
    const s = await setup({ script: { candle_claim_staking_reward: [lost, { kind: "ok", result: { success: true, rewardId: "rw1", signature: "S" } }] } })
    await s.ops.execute(mcpCard("candle_claim_staking_reward", { rewardId: "rw1" }))
    await s.advance(0)
    expect(s.ops.get("op-claim")!.state).toBe("succeeded")
    expect(s.calls.filter((c) => c.name === "candle_claim_staking_reward").map((c) => c.args)).toEqual([{ rewardId: "rw1" }, { rewardId: "rw1" }])
  })

  test("a lost fee claim, post or profile edit waits for the user: nothing reads or re-sends it", async () => {
    for (const [tool, params] of [
      ["candle_claim_fees", { mint: MOON, dryRun: false }],
      ["candle_create_post", { text: "gm" }],
      ["candle_update_profile", { publicThesis: "x" }],
      ["candle_upload_profile_image", { kind: "avatar", imageUrl: "https://example.com/a.png" }],
    ] as const) {
      const s = await setup({ script: { [tool]: [lost] } })
      await s.ops.execute(mcpCard(tool, params))
      await s.advance(10 * 60_000)
      expect(`${tool}: ${s.calls.length}`).toBe(`${tool}: 1`)
      expect(s.timers.filter((t) => !t.cancelled)).toEqual([])
    }
  })
})

describe("a retryable pre-send code", () => {
  test("a retryable VALIDATION_FAILED with no stage holds the trade and reads it back by its id", async () => {
    const s = await setup({ script: { candle_trade: [tradeError({ code: "VALIDATION_FAILED", retryable: true })], candle_get_operation: [job({ status: "confirmed", signature: "S" })] } })
    const op = await s.ops.execute(card("trade"))
    expect(op.state).toBe("unknown")
    await s.advance(0)
    expect(s.calls.map((c) => c.name)).toEqual(["candle_trade", "candle_get_operation"])
    expect(s.calls[1]!.args).toEqual({ clientId: "op-trade", kind: "trade" })
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
  })
})

describe("the user settles an unknown operation", () => {
  test("re-send keeps the id and the body", async () => {
    const s = await setup({ script: { candle_trade: [lost, trade({ success: true, status: "executed", signature: "S" })], candle_get_operation: [notFound] } })
    await s.ops.execute(card("trade"))
    const op = await s.ops.resolve("v1", "op-trade", "resend")
    expect(op.state).toBe("succeeded")
    const sends = s.calls.filter((c) => c.name === "candle_trade")
    expect(sends).toHaveLength(2)
    expect(sends[1]!.args).toEqual(sends[0]!.args)
    expect(s.journal.rows().map((r) => r.type)).toContain("operation.resend")
  })

  test("a refused re-send settles nothing: the operation stays unknown and is read again", async () => {
    const s = await setup({
      script: {
        candle_trade: [lost, tradeError({ code: "KEY_LIMIT_REACHED", retryable: true })],
        candle_get_operation: [notFound, notFound, job({ status: "confirmed", signature: "S" })],
      },
    })
    await s.ops.execute(card("trade"))
    await s.advance(0)
    const op = await s.ops.resolve("v1", "op-trade", "resend")
    expect(op.state).toBe("unknown")
    expect(s.journal.rows().some((r) => r.type === "operation.resend_refused" && r.code === "KEY_LIMIT_REACHED")).toBe(true)
    await s.advance(0)
    await s.advance(5_000)
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
  })

  test("abandon stops the reads; only an unknown or pending operation can be abandoned or re-sent", async () => {
    const s = await setup({ script: { candle_trade: [lost], candle_get_operation: [notFound] } })
    await s.ops.execute(card("trade"))
    expect((await s.ops.resolve("v1", "op-trade", "abandon")).state).toBe("abandoned")
    const before = s.calls.length
    await s.advance(60_000)
    expect(s.calls.length).toBe(before)
    await expect(s.ops.resolve("v1", "op-trade", "resend")).rejects.toThrow(/abandoned/)
  })
})

describe("one re-send at a time", () => {
  test("a second re-send while the first is out is refused, so a post with no id goes once more, not twice more", async () => {
    const s = await setup({ script: { candle_create_post: [lost, { kind: "ok", result: { success: true } }] } })
    await s.ops.execute(mcpCard("candle_create_post", { text: "gm" }))
    expect(s.ops.get("op-public")!.state).toBe("unknown")
    const first = s.ops.resolve("v1", "op-public", "resend")
    await expect(s.ops.resolve("v2", "op-public", "resend")).rejects.toThrow(/being re-sent/)
    await expect(s.ops.resolve("v2", "op-public", "abandon")).rejects.toThrow(/being re-sent/)
    expect((await first).state).toBe("succeeded")
    expect(s.calls.filter((c) => c.name === "candle_create_post")).toHaveLength(2)
  })

  test("the views are told a re-send is out, and told again when it ends", async () => {
    const s = await setup({ script: { candle_trade: [lost, tradeError({ code: "RATE_LIMITED", retryable: true })], candle_get_operation: [notFound] } })
    await s.ops.execute(card("trade"))
    await s.ops.resolve("v1", "op-trade", "resend")
    const marks = s.settled.filter((o) => o.opId === "op-trade").map((o) => o.resending === true)
    expect(marks).toEqual([false, false, true, false])
    expect(s.ops.get("op-trade")!.resending).toBeUndefined()
    // Over now: another re-send can go.
    await s.ops.resolve("v1", "op-trade", "resend")
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(3)
  })
})

describe("the kill switch and an operation Candle didn't answer", () => {
  test("a re-send of a lost buy is refused while paused, nothing sent; abandon still works", async () => {
    // Sent before the kill, so the kill finds it lost.
    let paused = false
    const s = await setup({ script: { candle_trade: [lost, trade({ success: true, status: "executed", signature: "S" })], candle_get_operation: [notFound] }, paused: () => paused })
    await s.ops.execute(card("trade"))
    paused = true
    await expect(s.ops.resolve("v1", "op-trade", "resend")).rejects.toThrow(/paused by the kill switch.*Nothing was sent/)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    paused = false
    expect((await s.ops.resolve("v1", "op-trade", "resend")).state).toBe("succeeded")
    let paused2 = false
    const s2 = await setup({ script: { candle_trade: [lost], candle_get_operation: [notFound] }, paused: () => paused2 })
    await s2.ops.execute(card("trade"))
    paused2 = true
    expect((await s2.ops.resolve("v1", "op-trade", "abandon")).state).toBe("abandoned")
  })

  test("a lost sell is still re-sent while paused: getting out stays open", async () => {
    const sell = card("trade", { side: "sell", params: { mint: MOON, side: "sell", percent: 50, clientTradeId: "op-trade" } })
    const s = await setup({ script: { candle_trade: [lost, trade({ success: true, status: "executed", signature: "S" })], candle_get_operation: [notFound] }, paused: () => true })
    await s.ops.execute(sell)
    expect((await s.ops.resolve("v1", "op-trade", "resend")).state).toBe("succeeded")
  })

  test("a buy whose side is known only from the journal is still stopped after a restart", async () => {
    const s = await setup({ paused: () => true })
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-tee", cardId: "card-op-tee", kind: "trade", tool: "candle_trade", params: { argv: ["swap"] }, cardExpiresAt: T0 + 60_000, route: "cli", wallet: "W", side: "buy" })
    const restarted = s.make(s.journal)
    await restarted.rebuild(s.journal.rows())
    restarted.readBack()
    await expect(restarted.resolve("v1", "op-tee", "resend")).rejects.toThrow(/PAUSED|paused/)
  })

  test("a lost swap isn't replayed while paused, and is after a resume inside the card's lifetime", async () => {
    let paused = false
    const s = await setup({ script: { candle_swap: [lost, { kind: "ok", result: { clientSwapId: "op-swap", success: true, payload: { hashes: ["H"] } } }] }, paused: () => paused })
    await s.ops.execute(card("swap"))
    paused = true
    await s.advance(10_000)
    expect(s.calls.filter((c) => c.name === "candle_swap")).toHaveLength(1)
    expect(s.ops.get("op-swap")!.state).toBe("unknown")
    // The views are told its read-back is held, so the kill report can say why it stays unanswered.
    expect(s.settled.at(-1)).toMatchObject({ opId: "op-swap", state: "unknown", held: true })
    paused = false
    await s.advance(5_000)
    expect(s.ops.get("op-swap")!.state).toBe("succeeded")
    expect(s.ops.get("op-swap")!.held).toBeUndefined()
    expect(s.calls.filter((c) => c.name === "candle_swap")).toHaveLength(2)
  })

  test("a kill while a buy's write-ahead row is written: refused, PAUSED, nothing sent; a sell still goes", async () => {
    let paused = false
    const s = await setup({ paused: () => paused, script: { candle_trade: [trade({ success: true, status: "executed", signature: "S" })] } })
    const append = s.journal.append.bind(s.journal)
    s.journal.append = (async (row: Parameters<typeof append>[0]) => {
      if (row.type === "operation.submitting") paused = true
      return append(row)
    }) as typeof s.journal.append
    const op = await s.ops.execute(card("trade"))
    expect(op).toMatchObject({ state: "refused", error: { code: "PAUSED" } })
    expect(op.error!.message).toContain("nothing was sent")
    expect(s.calls).toEqual([])
    const sold = await s.ops.execute(card("trade", { opId: "op-sell", side: "sell", params: { mint: MOON, side: "sell", amount: "1", clientTradeId: "op-sell" } }))
    expect(sold.state).toBe("succeeded")
  })

  test("a kill pressed while a re-send is written down: refused, PAUSED, nothing sent, and still read back", async () => {
    let paused = false
    const s = await setup({ script: { candle_trade: [lost, trade({ success: true, status: "executed", signature: "S" })], candle_get_operation: [notFound] }, paused: () => paused })
    await s.ops.execute(card("trade"))
    const append = s.journal.append.bind(s.journal)
    s.journal.append = (async (row: Parameters<typeof append>[0]) => {
      if (row.type === "operation.resend") paused = true
      return append(row)
    }) as typeof s.journal.append
    await expect(s.ops.resolve("v1", "op-trade", "resend")).rejects.toThrow(/went on as it was re-sent.*Nothing was sent/)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    expect(s.journal.rows().some((r) => r.type === "operation.resend_refused" && r.code === "PAUSED")).toBe(true)
    const op = s.ops.get("op-trade")!
    expect(op.state).toBe("unknown")
    expect(op.resending).toBeUndefined()
    // A read sends nothing: it goes on while paused.
    await s.advance(0)
    expect(s.calls.at(-1)!.name).toBe("candle_get_operation")
  })

  test("a stake card row read back by rerunning isn't rerun while paused, and is after a resume inside the card's lifetime", async () => {
    let paused = false
    const runs: string[] = []
    const cliRead = async (op: Operation) => (runs.push(op.opId), { mapped: { state: "succeeded" } as Mapped, detail: "rerun" })
    const cli = async (): Promise<Mapped> => ({ state: "unknown", reason: "the candle CLI stopped without an answer" })
    const s = await setup({ paused: () => paused, cli, cliRead })
    const stake = card("trade", { opId: "op-stake", kind: "stake", tool: "candle_cli", side: undefined, route: "cli", params: { argv: ["stake", "add", "10"], identity: "agent", agent: "momentum", json: true, row: "stake add" } } as Partial<Card>)
    expect((await s.ops.execute(stake)).state).toBe("unknown")
    paused = true
    await s.advance(10_000)
    expect(runs).toEqual([])
    expect(s.ops.get("op-stake")).toMatchObject({ state: "unknown", held: true })
    paused = false
    await s.advance(5_000)
    expect(runs).toEqual(["op-stake"])
    expect(s.ops.get("op-stake")!.state).toBe("succeeded")
    expect(s.ops.get("op-stake")!.held).toBeUndefined()
  })

  test("a paused refusal whose write-ahead row can't be written: no operation left submitting, and the error goes to the approval", async () => {
    const s = await setup({ paused: () => true })
    const append = s.journal.append.bind(s.journal)
    s.journal.append = (async (row: Parameters<typeof append>[0]) => {
      if (row.type === "operation.submitting") throw new Error("disk full")
      return append(row)
    }) as typeof s.journal.append
    await expect(s.ops.refusePaused(card("trade"))).rejects.toThrow("disk full")
    expect(s.calls).toEqual([])
    expect(s.ops.get("op-trade")).toBeUndefined()
    expect(s.ops.list()).toEqual([])
  })

  test("a lost trade is still read back while paused: a read sends nothing", async () => {
    let paused = false
    const s = await setup({ script: { candle_trade: [lost], candle_get_operation: [job({ status: "confirmed", signature: "S" })] }, paused: () => paused })
    await s.ops.execute(card("trade"))
    paused = true
    await s.advance(0)
    expect(s.ops.get("op-trade")!.state).toBe("succeeded")
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
  })
})

test("the core's log has a line per operation step, and none for anything else", () => {
  const at = "2026-10-26T22:08:43.926Z"
  const op = { at, agent: "agent-a", opId: "2c2a03da-3c30-40dd-af74-a1cd40fed3dd" }
  expect(operationLogLine({ ...op, type: "operation.submitting", kind: "trade" })).toBe("22:08:43 agent-a trade 2c2a03da sent")
  expect(operationLogLine({ ...op, type: "operation.unknown", reason: "no answer (transport)" })).toBe("22:08:43 agent-a 2c2a03da no answer (transport)")
  expect(operationLogLine({ ...op, type: "operation.check", found: true, state: "succeeded" })).toBe("22:08:43 agent-a 2c2a03da read back: succeeded")
  expect(operationLogLine({ ...op, type: "operation.check", replay: true, outcome: "SWAP_FAILED" })).toBe("22:08:43 agent-a 2c2a03da read back: SWAP_FAILED")
  // A bridge's read-back carries where it stands as its phase.
  expect(operationLogLine({ ...op, type: "operation.check", found: true, phase: "filled" })).toBe("22:08:43 agent-a 2c2a03da read back: filled")
  expect(operationLogLine({ ...op, type: "operation.refused", error: { code: "MCP_VALIDATION" } })).toBe("22:08:43 agent-a 2c2a03da refused: MCP_VALIDATION")
  expect(operationLogLine({ ...op, type: "operation.succeeded" })).toBe("22:08:43 agent-a 2c2a03da succeeded")
  expect(operationLogLine({ ...op, type: "card.approved" })).toBeUndefined()
})

describe("a bot's exit a restart cut off", () => {
  const exitCard = (extra: Partial<Card> = {}) =>
    card("trade", {
      side: "sell",
      params: { mint: MOON, side: "sell", amount: "10", clientTradeId: "op-trade" },
      origin: { clientId: "core", role: "core", source: "agent", bot: { name: "conf", act: "exit", position: "p1", reason: "stop" } } as Card["origin"],
      ...extra,
    })
  const filled = trade({ success: true, status: "executed", signature: "S" })
  const cutOff = async (s: Awaited<ReturnType<typeof setup>>, botExit = true) => {
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-trade", cardId: "card-op-trade", kind: "trade", tool: "candle_trade", params: exitCard().params, cardExpiresAt: T0 + 60_000, side: "sell", ...(botExit ? { botExit: true } : {}) })
    const restarted = s.make(s.journal)
    await restarted.rebuild(s.journal.rows())
    restarted.readBack()
    return restarted
  }

  test("its write-ahead row says it's a bot's exit", async () => {
    const s = await setup({ script: { candle_trade: [filled] } })
    await s.ops.execute(exitCard())
    expect(s.journal.rows()[0]).toMatchObject({ type: "operation.submitting", botExit: true })
    await s.ops.execute(card("trade", { opId: "op-2" }))
    expect(s.journal.rows().find((r) => r.opId === "op-2")!.botExit).toBeUndefined()
  })

  test("with no record on Candle, the core sends it once more under the same id, and it settles", async () => {
    const s = await setup({ script: { candle_get_operation: [notFound], candle_trade: [filled] } })
    const restarted = await cutOff(s)
    await s.advance(0)
    expect(s.calls.map((c) => c.name)).toEqual(["candle_get_operation", "candle_trade"])
    expect(s.calls[1]!.args).toEqual(exitCard().params)
    expect(restarted.get("op-trade")!.state).toBe("succeeded")
    expect(s.journal.rows().find((r) => r.type === "operation.resend")).toMatchObject({ by: "core", opId: "op-trade" })
  })

  test("only once: a re-send that's lost too is read back, never sent a third time, across another restart too", async () => {
    const s = await setup({ script: { candle_get_operation: [notFound], candle_trade: [lost] } })
    const restarted = await cutOff(s)
    await s.advance(11 * 60_000)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    expect(restarted.get("op-trade")!.state).toBe("unknown")
    // The person's re-send still works.
    expect((await restarted.resolve("v1", "op-trade", "resend")).opId).toBe("op-trade")
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(2)
    const again = s.make(s.journal)
    await again.rebuild(s.journal.rows())
    again.readBack()
    await s.advance(11 * 60_000)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(2)
  })

  test("a re-send Candle refuses (rate-limited) is read again, and never re-sent by the core a second time", async () => {
    const s = await setup({ script: { candle_get_operation: [notFound], candle_trade: [tradeError({ code: "RATE_LIMITED", retryable: true })] } })
    const restarted = await cutOff(s)
    await s.advance(11 * 60_000)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    expect(s.journal.rows().some((r) => r.type === "operation.resend_refused")).toBe(true)
    expect(restarted.get("op-trade")!.state).toBe("unknown")
  })

  test("a read that isn't Candle's no-record (its child not up) spends nothing: the next read decides", async () => {
    const s = await setup({ script: { candle_get_operation: [{ kind: "error", code: "CANDLE_MCP_DOWN", retryable: true, body: undefined }, notFound], candle_trade: [filled] } })
    const restarted = await cutOff(s)
    await s.advance(0)
    expect(s.calls.map((c) => c.name)).toEqual(["candle_get_operation"])
    await s.advance(5_000)
    expect(s.calls.map((c) => c.name)).toEqual(["candle_get_operation", "candle_get_operation", "candle_trade"])
    expect(restarted.get("op-trade")!.state).toBe("succeeded")
  })

  test("any other trade Candle has no record of after a restart waits for the person", async () => {
    const s = await setup({ script: { candle_get_operation: [notFound], candle_trade: [filled] } })
    const restarted = await cutOff(s, false)
    await s.advance(11 * 60_000)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(0)
    expect(restarted.get("op-trade")!.state).toBe("unknown")
  })

  test("held as the core's other sells are (failed sells, one in flight, the pace): not re-sent while held, re-sent at the next read once it lifts", async () => {
    let hold: string | undefined = "two sells of MOON in a row failed on momentum's key"
    const asked: string[] = []
    const s = await setup({
      script: { candle_get_operation: [notFound], candle_trade: [filled] },
      resendHold: (op) => {
        asked.push(op.opId)
        return hold
      },
    })
    const restarted = await cutOff(s)
    await s.advance(0)
    expect(asked).toEqual(["op-trade"])
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(0)
    expect(restarted.get("op-trade")!.state).toBe("unknown")
    hold = undefined
    await s.advance(11 * 60_000)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    expect(restarted.get("op-trade")!.state).toBe("succeeded")
    expect(s.journal.rows().find((r) => r.type === "operation.resend")).toMatchObject({ by: "core", opId: "op-trade" })
  })

  test("the person's own re-send is never held by what holds the core's", async () => {
    const s = await setup({ script: { candle_get_operation: [notFound], candle_trade: [filled] }, resendHold: () => "held" })
    const restarted = await cutOff(s)
    await s.advance(0)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(0)
    await restarted.resolve("v1", "op-trade", "resend")
    expect(restarted.get("op-trade")!.state).toBe("succeeded")
  })

  test("a bot's exit whose answer was lost with no restart waits for the person too", async () => {
    const s = await setup({ script: { candle_trade: [lost], candle_get_operation: [notFound] } })
    await s.ops.execute(exitCard())
    await s.advance(11 * 60_000)
    expect(s.calls.filter((c) => c.name === "candle_trade")).toHaveLength(1)
    expect(s.ops.get("op-trade")!.state).toBe("unknown")
  })
})

describe("one operation at a time on a Hood TEE wallet", () => {
  const HOOD_W = "0x00000000000000000000000000000000000E7e01"
  const OTHER_W = "0x00000000000000000000000000000000000E7e02"
  const hoodCard = (opId: string, extra: Partial<Card> = {}) =>
    card("trade", { opId, route: "cli", wallet: HOOD_W, chain: "hood", params: { argv: ["swap", "ETH", "0x" + "4d".repeat(20), "--amount", "0.0005", "--wallet", HOOD_W, "--client-trade-id", opId, "--yes", "--json"], identity: "agent", agent: "momentum", json: true }, ...extra })
  /** A CLI route whose runs answer when the test says, each by its op id. */
  function cliRoute() {
    const runs: string[] = []
    const answers = new Map<string, (m: Mapped) => void>()
    return {
      runs,
      answer: (opId: string, mapped: Mapped) => answers.get(opId)!(mapped),
      cliTrades: {
        execute: (op: Operation) => {
          runs.push(op.opId)
          return new Promise<Mapped>((resolve) => answers.set(op.opId, resolve))
        },
        read: async (): Promise<TradeRead> => ({ found: false, detail: "JOB_NOT_FOUND" }),
      },
    }
  }
  // The journal writes to a file: a few milliseconds lets each write land.
  const settle = () => Bun.sleep(25)
  const filled: Mapped = { state: "succeeded", result: { success: true, status: "executed", signature: "0x01" } }

  test("a second trade on a busy Hood TEE wallet waits, written down, and is sent once the first settles; nothing is sent twice", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    const first = s.ops.execute(hoodCard("op-1"))
    await settle()
    const second = await s.ops.execute(hoodCard("op-2"))
    expect(second).toMatchObject({ opId: "op-2", state: "submitting", waitingFor: "op-1" })
    expect(cli.runs).toEqual(["op-1"])
    const types = () => s.journal.rows().filter((r) => r.opId === "op-2").map((r) => r.type)
    expect(types()).toEqual(["operation.waiting"])
    expect(s.journal.rows().find((r) => r.type === "operation.waiting")).toMatchObject({ opId: "op-2", behind: "op-1", route: "cli", wallet: HOOD_W, chain: "hood" })
    // A third queues behind the second.
    expect((await s.ops.execute(hoodCard("op-3"))).waitingFor).toBe("op-2")
    cli.answer("op-1", filled)
    await first
    await settle()
    expect(cli.runs).toEqual(["op-1", "op-2"])
    expect(s.ops.get("op-2")!.waitingFor).toBeUndefined()
    expect(types()).toEqual(["operation.waiting", "operation.submitting"])
    cli.answer("op-2", filled)
    await settle()
    expect(cli.runs).toEqual(["op-1", "op-2", "op-3"])
    cli.answer("op-3", filled)
    await settle()
    expect(["op-1", "op-2", "op-3"].map((id) => s.ops.get(id)!.state)).toEqual(["succeeded", "succeeded", "succeeded"])
  })

  test("another wallet, and a Solana TEE wallet, never wait for it", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    void s.ops.execute(hoodCard("op-2", { wallet: OTHER_W }))
    void s.ops.execute(card("trade", { opId: "op-3", route: "cli", wallet: "TeeFake111111111111111111111111111111111111", chain: "solana" }))
    void s.ops.execute(card("trade", { opId: "op-4", route: "cli", wallet: "TeeFake111111111111111111111111111111111111", chain: "solana" }))
    await settle()
    expect(cli.runs).toEqual(["op-1", "op-2", "op-3", "op-4"])
  })

  test("an unknown first trade holds the wallet, as Candle does; one that failed frees it", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    cli.answer("op-1", { state: "unknown", reason: "no answer" })
    await settle()
    expect(cli.runs).toEqual(["op-1"])
    expect(s.ops.get("op-2")!.waitingFor).toBe("op-1")
    await s.ops.resolve("v1", "op-1", "abandon")
    await settle()
    expect(cli.runs).toEqual(["op-1", "op-2"])
  })

  test("the kill switch refuses a waiting buy with nothing sent, and nothing runs when the wallet frees", async () => {
    const cli = cliRoute()
    let paused = false
    const s = await setup({ cliTrades: cli.cliTrades, paused: () => paused })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    paused = true
    expect((await s.ops.refuseWaiting()).map((o) => o.opId)).toEqual(["op-2"])
    expect(s.ops.get("op-2")).toMatchObject({ state: "refused", error: { code: "PAUSED" } })
    expect(s.ops.get("op-2")!.error!.message).toContain("while it waited for the wallet's last trade, so nothing was sent")
    cli.answer("op-1", filled)
    await settle()
    expect(cli.runs).toEqual(["op-1"])
  })

  test("a waiting buy whose card ran past its 60 s isn't sent at an old price", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    await s.advance(61_000)
    cli.answer("op-1", filled)
    await settle()
    expect(cli.runs).toEqual(["op-1"])
    expect(s.ops.get("op-2")).toMatchObject({ state: "refused", error: { code: "WAITED_TOO_LONG" } })
  })

  test("a restart while one waits: the running one is read back as unknown, the waiting one is refused as never sent, and nothing runs", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    const again = s.make(s.journal)
    const turned = await again.rebuild(s.journal.rows())
    expect(turned).toEqual(["op-1"])
    expect(again.get("op-1")!.state).toBe("unknown")
    expect(again.get("op-2")).toMatchObject({ state: "refused", error: { code: "NOT_SENT_RESTART" } })
    await settle()
    expect(cli.runs).toEqual(["op-1"])
  })

  // A Hood trade whose trade leg was sent and reverted: Candle's job is failed, which ends Candle's own hold on the wallet.
  const failedJob = { clientTradeId: "op-1", status: "failed", errorCode: "SWAP_FAILED", operation: { legs: [{ kind: "approve", status: "confirmed" }, { kind: "trade", status: "failed" }] } }
  const failedRun = (): Mapped => mapCliTrade("trade", { exitCode: 1, timedOut: false, json: { code: "SWAP_FAILED", message: "The trade leg failed" } }, { found: true, state: jobState(failedJob), job: failedJob })

  test("a trade whose job Candle failed after its trade step frees the wallet; it stays unknown, saying it may have filled", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    cli.answer("op-1", failedRun())
    await settle()
    expect(s.ops.get("op-1")).toMatchObject({ state: "unknown", error: { message: expect.stringContaining("may have filled") } })
    expect(cli.runs).toEqual(["op-1", "op-2"])
    // A later trade on the wallet doesn't wait for it either.
    cli.answer("op-2", filled)
    await settle()
    void s.ops.execute(hoodCard("op-3"))
    await settle()
    expect(cli.runs).toEqual(["op-1", "op-2", "op-3"])
  })

  test("a read that finds the job failed frees the wallet for the trade waiting behind it", async () => {
    let job: TradeRead = { found: false, detail: "JOB_NOT_FOUND" }
    const cli = cliRoute()
    const s = await setup({ cliTrades: { ...cli.cliTrades, read: async () => job } })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    cli.answer("op-1", { state: "unknown", reason: "the candle CLI didn't finish in time" })
    await settle()
    expect(cli.runs).toEqual(["op-1"])
    job = { found: true, state: jobState(failedJob), job: failedJob }
    await s.advance(5_000)
    await settle()
    expect(s.ops.get("op-1")!.state).toBe("unknown")
    expect(cli.runs).toEqual(["op-1", "op-2"])
  })

  test("a read that finds the job ended writes down what its error says and reads no further, across a restart too", async () => {
    let job: TradeRead = { found: false, detail: "JOB_NOT_FOUND" }
    let reads = 0
    const cli = cliRoute()
    const s = await setup({ cliTrades: { ...cli.cliTrades, read: async () => (reads++, job) } })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    cli.answer("op-1", { state: "unknown", reason: "the candle CLI didn't finish in time" })
    await settle()
    job = { found: true, state: jobState(failedJob), job: failedJob }
    await s.advance(5_000)
    await settle()
    const said = s.journal.rows().filter((r) => r.opId === "op-1" && r.type === "operation.unknown").at(-1)
    expect(said?.result).toEqual(failedJob)
    expect(String((said?.error as { message?: unknown } | undefined)?.message)).toContain("may have filled")
    const after = reads
    await s.advance(60_000)
    await settle()
    expect(reads).toBe(after)
    // A restart knows it ended: its words stay, and it isn't read again.
    const again = s.make(s.journal)
    await again.rebuild(s.journal.rows())
    again.readBack()
    await settle()
    await s.advance(60_000)
    await settle()
    expect(again.get("op-1")!.state).toBe("unknown")
    expect(again.get("op-1")!.error?.message).toContain("may have filled")
    expect(reads).toBe(after)
  })

  test("an operation that never resolves holds its wallet for 30 minutes at most, as Candle's lock does, across a restart too", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    cli.answer("op-1", { state: "unknown", reason: "the candle CLI says it may have landed (exit 3)" })
    await settle()
    await s.advance(28 * 60_000)
    expect((await s.ops.execute(hoodCard("op-2", { expiresAt: new Date(s.now() + 60_000).toISOString() }))).waitingFor).toBe("op-1")
    await s.advance(60_000)
    expect(s.ops.get("op-2")).toMatchObject({ state: "refused", error: { code: "WAITED_TOO_LONG" } })
    await s.advance(61_000)
    void s.ops.execute(hoodCard("op-3", { expiresAt: new Date(s.now() + 60_000).toISOString() }))
    await settle()
    expect(cli.runs).toEqual(["op-1", "op-3"])
    expect(s.ops.get("op-1")!.state).toBe("unknown")
    cli.answer("op-3", filled)
    await settle()
    // After a restart the first is still unknown, read back, and holds nothing.
    const again = s.make(s.journal)
    await again.rebuild(s.journal.rows())
    void again.execute(hoodCard("op-4", { expiresAt: new Date(s.now() + 60_000).toISOString() }))
    await settle()
    expect(again.get("op-4")!.waitingFor).toBeUndefined()
    expect(cli.runs).toEqual(["op-1", "op-3", "op-4"])
  })

  test("a trade waiting behind one still running is refused in words when its card's 60 s run out, with nothing sent", async () => {
    const cli = cliRoute()
    const s = await setup({ cliTrades: cli.cliTrades })
    void s.ops.execute(hoodCard("op-1"))
    await settle()
    await s.ops.execute(hoodCard("op-2"))
    await s.advance(60_001)
    expect(s.ops.get("op-2")).toMatchObject({ state: "refused", error: { code: "WAITED_TOO_LONG", message: expect.stringContaining("Nothing was sent") } })
    expect(cli.runs).toEqual(["op-1"])
    cli.answer("op-1", filled)
    await settle()
    expect(cli.runs).toEqual(["op-1"])
  })
})
