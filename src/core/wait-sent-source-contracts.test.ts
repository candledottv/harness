// The wait:"sent" submit (BE-3929), as Candle's source runs it: a linked Solana trade's POST /api/v1/trade/agent/submit
// with `wait: "sent"` answers HTTP 202 (status broadcast, signature, clientTradeId) once the RPC acknowledges the send,
// before booking, and Candle books it in the background; the trading-background-booking worker books any the request
// did not, once, with zero double-booking and zero lost fees, and never releases a signed trade's hold on a missing
// read alone. The default, `wait: "confirmed"`, still answers after booking. Recorded offline
// (scripts/read-wait-sent-source.ts) from the source commit and versions pinned below. The Candle Harness never asks
// for wait:"sent", and every answer recorded here maps to a state it knows.
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-wait-sent-source.json"
import { sourceFor } from "./cli-table"
import { resolveCall } from "./cli-tool"
import { mapCliTrade, teeSwapArgs } from "./cli-trade"
import { outcomeOf } from "./execute"
import { jobState } from "./reconcile"

type Row = { id: string; scenario: string; evidence?: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = fixture.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const SOURCE_COMMIT = "ead243bdc14b9076c248191aef9be97297ae1cdb"
const VERSIONS = { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" }

test("the recording names the exact source commit, its CLI and SDK versions, and the files the submit lives in", () => {
  expect(fixture.source).toMatchObject({ repo: "candledottv/candle-monorepo", commit: SOURCE_COMMIT, versions: VERSIONS })
  for (const f of ["apps/api/src/routes/trade-agent.ts", "apps/api/src/routes/trade-agent-confirm.ts", "apps/api/src/lib/sign-hash.ts", "apps/api/src/ledger/trading/trades/passes.ts", "apps/api/src/services/candle/trade-broadcast.ts", "apps/api/src/services/solana/send-paths.ts", "packages/sdk/src/client.ts", "packages/cli/src/commands/swap.ts"]) {
    expect(fixture.source.files).toContain(f)
  }
  expect(fixture.about).toContain(`CLI ${VERSIONS.cli}, MCP ${VERSIONS.mcp}, SDK ${VERSIONS.sdk}`)
  expect(rows).toHaveLength(86)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["broadcast", "confirm", "wire", "fence", "worker", "worker-confirm", "booking", "route", "openapi", "sdk", "cli", "docs", "codes"]))
})

test("nothing in the recording is a key, an address, a signature, an RPC's path or a database", () => {
  const text = JSON.stringify(fixture)
  for (const secret of ["fixture-only-not-a-key", "fixture-internal-not-a-key", "fixture-path-not-a-key", "fixture-account", "BEGIN", "postgres://", "cndl_"]) expect(text).not.toContain(secret)
  // No Solana address, signature or hash: every one is a placeholder.
  expect(text.match(/[1-9A-HJ-NP-Za-km-z]{32,88}/g) ?? []).toEqual([])
  expect(text).not.toContain("<unexpected>")
  expect(text).not.toContain("\u2014")
})

test("wait sent answers 202 at the RPC's acknowledgement, before the first status read; the default answers after booking", () => {
  const sent = row("sent-answers-at-the-acknowledgement").outcome
  expect(sent.answer).toEqual({ httpStatus: 202, atMs: 0, body: { success: true, status: "broadcast", chain: "solana", clientTradeId: "<id>", signature: "<signature>" } })
  expect(sent.firstStatusReadAtMs).toBe(250)
  expect(sent.background).toEqual({ atMs: 500, landed: "<signature>", booking: "request" })
  // The signature is recorded (onBroadcast) before the acknowledgement releases the answer (onSent).
  expect(sent.events.map((e: { event: string }) => e.event)).toEqual(["onBroadcast", "onSent"])
  expect(sent.firstSendPreflight).toBe(true)
  const confirmed = row("confirmed-answers-after-the-confirmation").outcome
  expect(confirmed.answer).toEqual({ atMs: 500, after: "confirmation", landed: "<signature>", booking: "inline, before the answer" })
})

test("a sent submit's confirm never resends; the default's still does", () => {
  expect(row("sent-no-resend-while-it-waits").outcome).toMatchObject({ sendsAtMs: [0], background: { atMs: 5000, booking: "request" } })
  expect(row("confirmed-resends-while-it-waits").outcome.sendsAtMs).toEqual([0, 3250])
  expect(row("confirm-resend-false-lands").outcome).toEqual({ resendsAtMs: [], statusReads: 30, endedAtMs: 7500, result: "returned" })
  expect(row("confirm-resend-false-budget").outcome).toMatchObject({ resendsAtMs: [], endedAtMs: 60_000, result: "LaunchConfirmationTimeoutError" })
  expect(row("confirm-default-resends").outcome.resendsAtMs).toEqual([3250, 6500])
  expect(row("confirm-resend-false").outcome.found).toBe(true)
})

test("an extra RPC can acknowledge wait sent after a lost primary reply only with the reserved signature", () => {
  const accepted = row("sent-extra-rpc-acknowledges").outcome
  expect(accepted).toMatchObject({
    answer: { httpStatus: 202, atMs: 0, body: { status: "broadcast", signature: "<signature>" } },
    firstStatusReadAtMs: 250,
    background: { atMs: 5000, landed: "<signature>", booking: "request" },
    sendsAtMs: [0],
    extraSends: [{ atMs: 0, preflight: true }],
  })
  expect(accepted.events.map((event: { event: string }) => event.event)).toEqual(["onBroadcast", "onSent"])

  const mismatch = row("sent-extra-rpc-names-another-signature").outcome
  expect(mismatch.answer).toEqual({
    atMs: 0, code: "SWAP_FAILED", retryable: false, stage: "unconfirmed", signature: "<signature>",
    message: "unconfirmed", thrown: "TradeUnconfirmedError",
  })
  expect(mismatch).toMatchObject({
    events: [{ atMs: 0, event: "onBroadcast", signature: "<signature>" }],
    statusReads: 0,
    background: { booking: "worker", signature: "<signature>" },
    sendsAtMs: [0],
    extraSends: [{ atMs: 0, preflight: true }],
  })
})

test("after the 202, a revert is booked TRADE_REVERTED by the request and anything unconfirmed is left to the worker", () => {
  expect(row("sent-landed-revert").outcome).toMatchObject({ answer: { httpStatus: 202 }, background: { thrown: "TradeRevertedError", signature: "<signature>", booking: "request" } })
  expect(row("sent-unconfirmed-left-to-the-worker").outcome).toMatchObject({ answer: { httpStatus: 202 }, background: { thrown: "TradeUnconfirmedError", signature: "<signature>", booking: "worker" } })
  expect(row("route-sent-background-booking").outcome).toMatchObject({ found: true, books: ["landed", "TradeRevertedError"], defersToWorker: "any other confirm error", store: "postgres" })
})

test("with no acknowledgement there is no 202: SWAP_FAILED at stage unconfirmed, the reserved signature kept", () => {
  const refused = row("sent-rpc-refused-the-send").outcome
  expect(refused.answer).toMatchObject({ code: "SWAP_FAILED", retryable: false, stage: "unconfirmed", signature: "<signature>", message: "rpc-refused" })
  expect([refused.events, refused.statusReads, refused.background.booking]).toEqual([[], 0, "worker"])
  expect(row("sent-reply-lost").outcome.answer).toMatchObject({ code: "SWAP_FAILED", stage: "unconfirmed", message: "unconfirmed" })
  const other = row("sent-rpc-named-another-signature").outcome
  expect(other.answer).toMatchObject({ code: "SWAP_FAILED", stage: "unconfirmed", message: "unconfirmed" })
  // The bytes' own signature is what gets recorded, never the one the RPC named.
  expect(other.events).toEqual([{ atMs: 0, event: "onBroadcast", signature: "<signature>" }])
  expect(row("route-sent-failure-answer").outcome).toEqual({ found: true, code: "SWAP_FAILED", stage: "unconfirmed", retryable: false, carries: "signature" })
})

test("the Solana wire check catches a borrowed signature whose message still hashes to a stamped build, before either pre-send write", () => {
  expect(row("wire-signed-by-payer").outcome).toEqual({ verifies: true, matchesSignature: true, unsignedHashMatchesBuild: true })
  expect(row("wire-borrowed-signature").outcome).toEqual({ verifies: false, matchesSlotSignature: true, unsignedHashMatchesBuild: true, routeCode: "SIGNATURE_MISMATCH" })
  expect(row("wire-other-payer").outcome).toEqual({ verifies: false, routeCode: "SIGNATURE_MISMATCH" })
  expect(row("wire-malformed").outcome).toEqual({ verifies: false, unsignedHash: null })
})

test("of two competing submits for one trade, exactly one sends: the reservation and the default's pre-send record fence each other", () => {
  for (const id of ["fence-sent-then-default-same-bytes", "fence-sent-then-default-other-bytes", "fence-default-then-sent", "fence-sent-then-sent"]) {
    const o = row(id).outcome
    expect(o.senders, id).toBe(1)
    expect(o.steps[0].sends, id).toBe(true)
    expect(o.steps[1].sends, id).toBe(false)
    expect(o.steps[1].patch, id).toBeNull()
    expect(o.rowSignature, id).toBe("<signature>")
  }
  expect(row("fence-sent-then-default-same-bytes").outcome.steps[0]).toMatchObject({ who: "wait:sent", reservation: "reserved", patch: { signature: "<signature>", broadcastAt: "<now>" } })
  expect(row("fence-default-then-sent").outcome.steps[1]).toMatchObject({ who: "wait:sent", reservation: "in_flight" })
  expect(row("fence-sent-then-default-other-bytes").outcome.otherBytesHeld).toBe(true)
  for (const id of ["reserve-refuses-main-payer", "reserve-refuses-hood", "reserve-refuses-settled-row", "reserve-refuses-no-linked-wallet"]) expect(row(id).outcome.reservation, id).toBe("in_flight")
  expect(row("reserve-checks").outcome).toMatchObject({ found: true, answers: ["reserved", "in_flight", "unbound"] })
  expect(row("binding-names-the-build").outcome.found).toBe(true)
  expect(row("projection-drops-background-booking").outcome).toEqual({ projected: ["broadcastAt", "builtAt", "chain", "keyPrefix", "linkedWalletId", "payerType", "signature", "status"], keepsSignature: true })
})

test("concurrent background booking and worker recovery book once, keep the full fee, and fire each side effect once", () => {
  for (const id of ["booking-race-api-then-worker", "booking-race-worker-then-api"]) {
    const o = row(id).outcome
    expect(o, id).toEqual({
      winnerStatus: 200,
      loserStatus: 200,
      loserBodyStatus: "executed",
      completeCalls: 2,
      bookings: [{ clientTradeId: "race-1", feeRaw: "10000" }],
      zeroDoubleBooking: true,
      zeroLostFees: true,
      rowStatus: "confirmed",
      feeSignatureHeld: true,
      effects: { usage: 1, webhooks: 1, accruals: 1, accrualFeeRaw: "10000" },
    })
  }
  expect(row("booking-unseen-then-api-then-stale-worker").outcome).toEqual({
    early: { status: 400, code: "VALIDATION_FAILED", retryable: true, unseen: 1, rowStatus: "built" },
    apiStatus: 200,
    staleWorkerRetryStatus: 200,
    bookings: [{ clientTradeId: "race-1", feeRaw: "10000" }],
    effects: { usage: 1, webhooks: 1, accruals: 1, accrualFeeRaw: "10000" },
  })
  expect(row("booking-bound-revert").outcome).toMatchObject({
    api: { code: "VALIDATION_FAILED", stage: "reverted", recorded: true },
    row: { status: "failed", errorCode: "TRADE_REVERTED", signatureKept: true },
    bookings: 0,
    effects: { usage: 0, webhooks: 0, accruals: 0 },
  })
  expect(row("booking-unbound-wire-retries").outcome).toEqual({
    status: 500,
    code: "SWAP_FAILED",
    retryable: true,
    rowStatus: "built",
    bookings: 0,
    effects: { usage: 0, webhooks: 0, accruals: 0, accrualFeeRaw: null },
  })
})

test("the wire check runs before either pre-send write, and each reservation answer sends nothing", () => {
  expect(row("route-order").outcome).toMatchObject({
    found: true,
    order: ["SIGNATURE_MISMATCH check", "wait:sent: reserveBackgroundBooking, then the send", "wait:confirmed: recordSolanaBeforeSend, then the send"],
    signatureMismatch: { code: "SIGNATURE_MISMATCH", retryable: false, field: "signedTransactions" },
  })
  expect(row("route-reservation-answers").outcome).toEqual({
    found: true,
    failed: { code: "SWAP_FAILED", retryable: true, stage: "not_broadcast", reason: "record_unavailable" },
    unbound: { code: "UNRECOGNIZED_TRANSACTION" },
    in_flight: { code: "IDEMPOTENCY_CONFLICT", retryable: false, stage: "not_broadcast" },
  })
  expect(row("route-default-fence").outcome.in_flight).toEqual({ code: "IDEMPOTENCY_CONFLICT", retryable: false, stage: "not_broadcast" })
})

test("wait takes confirmed or sent, and sent only on a linked Solana trade: VALIDATION_FAILED on field wait otherwise", () => {
  expect(row("route-wait-values").outcome).toEqual({ found: true, code: "VALIDATION_FAILED", field: "wait", values: ["confirmed", "sent"], default: "confirmed" })
  expect(row("route-sent-refuses-a-sequenced-hood-leg").outcome).toEqual({ found: true, code: "VALIDATION_FAILED", field: "wait" })
  expect(row("route-sent-refuses-a-non-linked-or-hood-row").outcome).toMatchObject({ found: true, code: "VALIDATION_FAILED", field: "wait" })
  expect(row("route-sent-answer").outcome).toMatchObject({ found: true, httpStatus: 202 })
  const api = row("openapi-submit").outcome
  expect(api.responses).toContain("202")
  expect(api.wait).toMatchObject({ enum: ["confirmed", "sent"], default: "confirmed" })
  expect(api.broadcast).toEqual({ required: ["success", "status", "chain", "clientTradeId", "signature"], properties: { success: true, status: "broadcast", chain: "solana", clientTradeId: "string", signature: "string" } })
})

test("the worker books a sent trade the request did not, once, and keeps the signature and hold of one it can't see", () => {
  const booked = row("worker-books-a-sent-trade").outcome
  expect(booked).toMatchObject({ query: { backgroundBooking: "true", olderThanMs: 15_000 }, docsRecheck: "state built", confirmCalls: 1, verdictReads: 0, counts: { candidates: 1, confirmed: 1, failed: 0, left: 0, errors: 0 } })
  expect(booked.sync.name).toBe("trading-background-booking")
  expect(row("worker-bound-revert").outcome.counts).toMatchObject({ failed: 1, confirmed: 0 })
  expect(row("worker-unseen-keeps-the-hold").outcome).toMatchObject({ counts: { left: 1, notLanded: 0 }, sync: { leftByReason: { unseen: 1 } }, verdictReads: 0 })
  expect(row("worker-unseen-past-the-window-reads-the-ledger").outcome).toMatchObject({ verdictReads: 1, counts: { notLanded: 0 }, sync: { leftByReason: { payer_not_settled: 1 } } })
  expect(row("worker-unseen-but-finalized").outcome.sync.leftByReason).toEqual({ finalized_unseen: 1 })
  expect(row("worker-confirm-refused").outcome.sync.leftByReason).toEqual({ confirm_refused: 1 })
  expect(row("worker-confirm-unavailable").outcome.counts).toMatchObject({ errors: 1, confirmed: 0, failed: 0 })
  // Zero double booking: a trade the request booked after the page was read is re-checked and never confirmed again.
  expect(row("worker-skips-a-trade-the-request-booked").outcome).toMatchObject({ docsRecheck: "state built", confirmCalls: 0, counts: { candidates: 0, confirmed: 0 } })
  // The ordinary pass leaves marked trades to this one, and reads the ledger first.
  expect(row("resolve-pass-leaves-sent-trades").outcome).toMatchObject({ query: { backgroundBooking: "false", olderThanMs: 1_800_000 }, verdictReads: 1, sync: { name: "trading-resolve" } })
  expect(row("worker-interval").outcome).toMatchObject({ found: true, everyMs: 15_000, syncName: "trading-background-booking" })
  expect(row("worker-not-landed-needs-the-ledger").outcome.found).toBe(true)
  for (const r of scenario("worker")) expect(r.outcome.counts.notLanded, r.id).toBe(0)
})

test("the worker's confirm answers unseen only for a marked trade, and confirms only a linked Solana trade with a signature", () => {
  expect(row("resolve-confirm-unseen").outcome).toEqual({ answer: "unseen", chainReads: 1, wireReads: 0 })
  expect(row("resolve-confirm-unseen-without-marker").outcome).toEqual({ answer: "refused", chainReads: 1, wireReads: 1 })
  for (const id of ["resolve-confirm-hood", "resolve-confirm-main-payer", "resolve-confirm-no-signature"]) expect(row(id).outcome, id).toEqual({ answer: "refused", chainReads: 0, wireReads: 0 })
  expect(row("worker-confirm-binds-or-retries").outcome).toMatchObject({ found: true, code: "SWAP_FAILED", retryable: true })
  expect(row("worker-confirm-unseen").outcome).toMatchObject({ found: true, code: "VALIDATION_FAILED", retryable: true })
})

test("the SDK: submit() and trade() forward wait sent and return the broadcast result; waitForTrade() follows the job", () => {
  const broadcast = { success: true, status: "broadcast", chain: "solana", clientTradeId: "sdk-sent-1", signature: "<signature>" }
  expect(row("sdk-submit-sent").outcome).toEqual({ returned: broadcast, requests: [{ method: "POST", path: "/api/v1/trade/agent/submit", body: { clientTradeId: "sdk-sent-1", signedTransactions: ["<signed>"], wait: "sent" } }] })
  expect(row("sdk-submit-default").outcome.requests[0].body).toEqual({ clientTradeId: "sdk-default-1", signedTransactions: ["<signed>"] })
  expect(row("sdk-submit-sent-refused").outcome).toMatchObject({ code: "VALIDATION_FAILED" })
  const linked = row("sdk-trade-sent-linked").outcome
  expect(linked.returned).toEqual({ ...broadcast, clientTradeId: "sdk-trade-sent" })
  expect(linked.requests.map((q: { path: string }) => q.path).at(-1)).toBe("/api/v1/trade/agent/submit")
  expect(linked.requests.at(-1).body.wait).toBe("sent")
  for (const id of ["sdk-submit-invalid-wait", "sdk-trade-invalid-wait", "sdk-trade-sent-main-payer", "sdk-trade-sent-hood-token"]) {
    expect(row(id).outcome.threw, id).toBe("Error")
    expect(row(id).outcome.requests, id).toEqual([])
  }
  expect(row("sdk-trade-sent-main-payer").outcome.message).toBe('trade({ wait: "sent" }) requires a linked Solana trade')
  expect(row("sdk-wait-for-trade-confirmed").outcome.returned).toMatchObject({ status: "confirmed", signature: "<signature>" })
  expect(row("sdk-wait-for-trade-failed").outcome.returned).toMatchObject({ status: "failed", errorCode: "TRADE_REVERTED" })
  for (const id of ["sdk-wait-for-trade-confirmed", "sdk-wait-for-trade-failed"]) expect(row(id).outcome.requests.every((q: { method: string }) => q.method === "GET"), id).toBe(true)
  expect(row("sdk-wait-for-trade-timeout").outcome).toMatchObject({ threw: "Error" })
})

test("the CLI: swap --wait-sent exits 0 at broadcast; it refuses anything but a Solana TEE token trade, and --wait beside it", () => {
  const sent = row("cli-wait-sent").outcome
  expect(sent.exitCode).toBe(0)
  expect(sent.json).toMatchObject({ kind: "trade", status: "broadcast", clientTradeId: "cli-sent-1", signature: "<signature>", signatures: ["<signature>"] })
  expect(sent.submitBodies).toEqual([{ clientTradeId: "cli-sent-1", signedTransactions: ["<signed>"], wait: "sent" }])
  expect(row("cli-default-submit").outcome).toMatchObject({ exitCode: 0, json: { status: "executed" }, submitBodies: [{ clientTradeId: "cli-default-1", signedTransactions: ["<signed>"] }] })
  for (const id of ["cli-wait-sent-with-wait", "cli-wait-sent-base-to-base", "cli-wait-sent-bridge", "cli-wait-sent-hood"]) {
    expect(row(id).outcome, id).toEqual({ exitCode: 2, json: { ok: false, code: "USAGE", message: "--wait-sent requires a Solana TEE token trade and cannot be combined with --wait." }, apiRequests: [], submitBodies: [] })
  }
  const embedded = row("cli-wait-sent-embedded").outcome
  expect(embedded).toMatchObject({ exitCode: 2, json: { code: "USAGE", message: "--wait-sent requires a Solana TEE wallet." }, submitBodies: [] })
  expect(embedded.apiRequests.some((p: string) => p.endsWith("/build"))).toBe(false)
  for (const [id, status] of [["cli-status-after-broadcast", "built"], ["cli-status-booked", "confirmed"], ["cli-status-reverted", "failed"]] as const) {
    expect(row(id).outcome, id).toMatchObject({ exitCode: 0, json: { kind: "trade", status, clientTradeId: "cli-sent-1" }, submitBodies: [] })
    expect(row(id).outcome.apiRequests.every((p: string) => p.startsWith("GET ")), id).toBe(true)
  }
  expect(row("docs-return-at-broadcast").outcome).toMatchObject({ found: true, releasePrefix: "Release 0.6.39 (BE-3929), with CLI 0.13.47" })
})

/** What the Candle Harness makes of each code these answers carry, and the answer it maps. */
const MAPPED: Record<string, string> = {
  VALIDATION_FAILED: "refused, failed at stage reverted, or unknown when retryable",
  SIGNATURE_MISMATCH: "unknown",
  IDEMPOTENCY_CONFLICT: "refused",
  UNRECOGNIZED_TRANSACTION: "unknown",
  SWAP_FAILED: "refused or unknown, by stage",
  TRADE_REVERTED: "failed",
  USAGE: "refused",
}

test("mapped codes only: every code an answer here carries is one the Candle Harness maps, and none reads as a fill", () => {
  expect(row("codes").outcome.codes).toEqual(Object.keys(MAPPED).sort())
  const api = (code: string, error: Record<string, unknown>) => outcomeOf("trade", { kind: "error", code, retryable: error.retryable === true, body: { api: { error: { code, ...error } } } })
  // Refused before anything was sent: a bad wait, a reservation another attempt holds, a record that couldn't be written.
  expect(api("VALIDATION_FAILED", { retryable: false, field: "wait" }).state).toBe("refused")
  expect(api("IDEMPOTENCY_CONFLICT", row("route-reservation-answers").outcome.in_flight).state).toBe("refused")
  expect(api("SWAP_FAILED", row("route-reservation-answers").outcome.failed).state).toBe("refused")
  // No stage on a code Candle doesn't document as pre-send: read back by its id, never released for a second send.
  expect(api("SIGNATURE_MISMATCH", row("route-order").outcome.signatureMismatch).state).toBe("unknown")
  expect(api("UNRECOGNIZED_TRANSACTION", { retryable: false }).state).toBe("unknown")
  // An answer at stage unconfirmed may have reached the chain; a landed revert at stage reverted failed.
  const unconfirmed = row("sent-rpc-refused-the-send").outcome.answer
  expect(api("SWAP_FAILED", { retryable: unconfirmed.retryable, stage: unconfirmed.stage })).toMatchObject({ state: "unknown", reason: "it may have reached the chain" })
  expect(api("VALIDATION_FAILED", { retryable: false, stage: "reverted" }).state).toBe("failed")
  // The worker's own retryable answers, were one ever relayed: read back, never released.
  expect(api("VALIDATION_FAILED", { retryable: true }).state).toBe("unknown")
  expect(api("SWAP_FAILED", { retryable: true }).state).toBe("unknown")
  // A job failed TRADE_REVERTED with its signature is a settled failure.
  expect(jobState({ status: "failed", signature: "<signature>", errorCode: "TRADE_REVERTED" })).toBe("failed")
  // The CLI's refusals are USAGE before any build: refused once nothing is found under the id.
  for (const id of ["cli-wait-sent-with-wait", "cli-wait-sent-base-to-base", "cli-wait-sent-bridge", "cli-wait-sent-hood", "cli-wait-sent-embedded"]) {
    const o = row(id).outcome
    expect(mapCliTrade("trade", { exitCode: o.exitCode, timedOut: false, json: o.json }, { found: false, detail: "JOB_NOT_FOUND" }).state, id).toBe("refused")
  }
})

test("a broadcast answer is never a fill to the Candle Harness: it is read back, and the job decides", () => {
  const sent = row("cli-wait-sent").outcome
  expect(mapCliTrade("trade", { exitCode: 0, timedOut: false, json: sent.json })).toMatchObject({ state: "unknown", reason: "the candle CLI's answer didn't say it filled" })
  expect(mapCliTrade("trade", { exitCode: 0, timedOut: false, json: row("cli-status-after-broadcast").outcome.json }).state).toBe("unknown")
  expect(mapCliTrade("trade", { exitCode: 0, timedOut: false, json: row("cli-status-booked").outcome.json }).state).toBe("succeeded")
  expect(mapCliTrade("trade", { exitCode: 0, timedOut: false, json: row("cli-status-reverted").outcome.json }).state).toBe("failed")
  expect(jobState({ status: "built", signature: "<signature>" })).toBe("unknown")
})

test("the Candle Harness never asks for wait sent: its TEE card's argv has no --wait-sent, and candle_cli refuses the flag", () => {
  const argv = teeSwapArgs({ from: "SOL", to: "<mint>", sizing: { amount: "1" }, wallet: "tee", opId: "op-1" })
  expect(argv).not.toContain("--wait-sent")
  expect(argv).not.toContain("--wait")
  // The CLI table is read at its own pinned commit, which has no --wait-sent on swap.
  expect(sourceFor("swap", null)?.flags?.boolean ?? []).not.toContain("--wait-sent")
  const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }
  expect(resolveCall({ command: "swap", args: ["SOL", "<mint>", "--amount", "1", "--wallet", "tee", "--wait-sent"] }, ctx)).toEqual({ ok: false, code: "FLAG_NOT_ALLOWED", message: "candle swap has no --wait-sent flag." })
  // Following a booking is a read the agent may run.
  const status = resolveCall({ command: "swap", subcommand: "status", args: ["cli-sent-1"] }, ctx)
  expect(status.ok && status.call.rule).toBe("read")
})
