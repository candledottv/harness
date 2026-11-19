// Fast confirm (BE-3927), as Candle runs it after a Solana trade's send: the API's trade rail reads the status every
// 250 ms, checks the transaction's own blockhash every 8 reads and stops once the chain says it is dead, inside a 60 s
// budget that covers every RPC wait; launches keep the 1 s loop. The web app's confirm and its swap watch read every
// 250 ms. Recorded offline from one exact commit (scripts/read-fast-confirm-source.ts) on a stand-in RPC and clock.
// The commit is a staging build that changes no CLI, MCP or SDK file.
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-fast-confirm-source.json"
import { outcomeOf } from "./execute"

type Row = { id: string; scenario: string; args: Record<string, unknown>; outcome: Record<string, any> }
const rows = fixture.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const EXPIRED = "Transaction expired before it confirmed."
const TIMED_OUT = "Transaction timed out. Verify the mint on-chain before retrying."

test("the recording names the exact staging build, the files, and that no CLI, MCP or SDK file moved", () => {
  expect(fixture.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "5833f956012617e38771cedf0a71f91950bee306",
    versions: { cli: "0.13.32", mcp: "0.10.37", sdk: "0.6.26" },
    files: [
      "apps/api/src/services/candle/launch-confirm.ts",
      "apps/api/src/services/candle/trade-broadcast.ts",
      "apps/api/src/services/candle/swap-execution.ts",
      "apps/api/src/routes/agent.ts",
      "apps/api/src/services/candle/launch-helpers.ts",
      "apps/api/src/services/candle/solana-headless.ts",
      "apps/frontend/src/utils/solana.ts",
      "apps/frontend/src/utils/solana-swap-outcome.ts",
    ],
  })
  expect(rows).toHaveLength(58)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(
    new Set(["fast-loop", "default-loop", "trade-broadcast", "swap-execution", "web-confirm", "web-swap-watch", "source-pin", "codes"]),
  )
})

test("nothing in the recording is a key, a hash, a signature or the bytes of a transaction", () => {
  const text = JSON.stringify(fixture)
  expect(text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []).toEqual([])
  expect(text).not.toContain("BEGIN")
})

test("the fast loop reads the status 250 ms after the send and every 250 ms after; the default loop still waits 1 s", () => {
  expect(row("fast-first-read-at-250ms").outcome).toMatchObject({ statusAtMs: [250], endedAtMs: 250, result: "returned", signature: "the send's own" })
  expect(row("fast-reads-every-250ms").outcome.statusAtMs).toEqual([250, 500, 750, 1000, 1250, 1500])
  expect(row("default-first-read-at-1s").outcome).toMatchObject({ statusAtMs: [1000], endedAtMs: 1000 })
  expect(row("default-reads-every-1s").outcome.statusAtMs).toEqual([1000, 2000, 3000])
})

test("the fast loop checks the transaction's own blockhash every 8 reads, at confirmed", () => {
  const r = row("fast-checks-its-own-hash-every-8-reads").outcome
  expect(r).toMatchObject({ validityAtMs: [2000, 4000], validityOnOwnHash: true, validityCommitment: ["confirmed"], result: "returned" })
  // No hash to check when the bytes don't decode, and the default loop never checks one, even a dead one.
  expect(row("fast-undecodable-bytes-never-check-a-hash").outcome).toMatchObject({ validityReads: 0, result: "returned" })
  expect(row("default-never-checks-the-hash").outcome).toMatchObject({ validityReads: 0, result: "returned", endedAtMs: 20_000 })
})

test("a dead blockhash ends the fast loop after one last status read, unconfirmed and with the signature", () => {
  const r = row("fast-stops-once-the-hash-is-dead").outcome
  expect(r).toMatchObject({ statusReads: 9, validityAtMs: [2000], endedAtMs: 2000, result: "LaunchConfirmationTimeoutError", message: EXPIRED, signatureKept: true })
  // The last status read is the one right after the validity read, at the same moment.
  expect(r.statusAtMs.slice(-2)).toEqual([2000, 2000])
  expect(row("fast-dead-hash-later-check").outcome).toMatchObject({ statusReads: 25, validityReads: 3, endedAtMs: 6000, message: EXPIRED })
})

test("what the last status read sees after the hash died decides the end, and only a confirmed status settles it", () => {
  expect(row("fast-dead-hash-landed-in-the-last-read-wins").outcome).toMatchObject({ result: "returned", signature: "the send's own" })
  expect(row("fast-dead-hash-finalized-in-the-last-read-wins").outcome.result).toBe("returned")
  expect(row("fast-dead-hash-reverted-in-the-last-read").outcome).toMatchObject({ result: "OnChainRevertError", signatureKept: true })
  for (const id of ["fast-dead-hash-processed-is-not-landed", "fast-dead-hash-processed-error-is-not-final", "fast-dead-hash-last-read-fails"]) {
    expect(row(id).outcome, id).toMatchObject({ result: "LaunchConfirmationTimeoutError", message: EXPIRED, signatureKept: true })
  }
})

test("a failed validity read decides nothing, and a failed status read stays indeterminate as before", () => {
  expect(row("fast-failed-validity-read-decides-nothing").outcome).toMatchObject({ validityReads: 1, statusReads: 12, result: "returned" })
  expect(row("fast-status-read-failure-is-indeterminate").outcome).toMatchObject({ endedAtMs: 750, result: "IndeterminateLaunchOutcomeError", signatureKept: true })
  expect(row("fast-reverted-status-is-final").outcome).toMatchObject({ endedAtMs: 500, result: "OnChainRevertError" })
  expect(row("fast-processed-error-keeps-polling").outcome).toMatchObject({ statusReads: 3, result: "returned" })
})

test("resends still go every 3 s from the last accepted send, in both loops", () => {
  expect(row("fast-resends-every-3s").outcome).toMatchObject({ resendsAtMs: [3250, 6500], observed: { sends: 3 } })
  expect(row("default-resends-every-3s").outcome).toMatchObject({ resendsAtMs: [4000, 8000], observed: { sends: 3 } })
  // A refused resend doesn't move the last send's time, so the next read tries again; polling carries on.
  expect(row("fast-refused-resend-is-tried-each-read-and-keeps-polling").outcome).toMatchObject({ resendsAtMs: [3250, 3500, 3750], observed: { sends: 1 }, result: "returned" })
})

test("the fast loop keeps a 60 s budget that covers slow and silent reads, and the default loop keeps its 60 reads", () => {
  const cap = row("fast-60s-cap-while-the-hash-stays-valid").outcome
  expect(cap).toMatchObject({ statusReads: 240, validityReads: 30, endedAtMs: 60_000, result: "LaunchConfirmationTimeoutError", message: TIMED_OUT, signatureKept: true })
  expect(row("default-60s-cap").outcome).toMatchObject({ statusReads: 60, validityReads: 0, endedAtMs: 60_000, message: TIMED_OUT })
  const slow = row("fast-slow-reads-stay-inside-the-budget").outcome
  expect(slow.endedAtMs).toBeLessThanOrEqual(60_000)
  expect(slow).toMatchObject({ result: "LaunchConfirmationTimeoutError", signatureKept: true })
  expect(row("fast-a-read-that-never-answers-is-cut-at-the-budget").outcome).toMatchObject({ statusReads: 1, endedAtMs: 60_000, result: "LaunchConfirmationTimeoutError", signatureKept: true })
})

test("a trade's confirm is the fast loop, and a dead hash, the budget or a failed read ends it unconfirmed, never failed", () => {
  const landed = row("trade-confirm-is-the-fast-loop").outcome
  expect(landed).toMatchObject({ statusAtMs: [250, 500], result: "returned", firstSend: { preflight: true, maxRetries: 5 } })
  expect(row("trade-dead-hash-is-unconfirmed").outcome).toMatchObject({ endedAtMs: 2000, result: "TradeUnconfirmedError", unconfirmedMessage: true, signatureKept: true })
  for (const id of ["trade-60s-cap-is-unconfirmed", "trade-never-answering-read-is-unconfirmed", "trade-status-read-failure-is-unconfirmed"]) {
    expect(row(id).outcome, id).toMatchObject({ result: "TradeUnconfirmedError", unconfirmedMessage: true, signatureKept: true })
  }
  expect(row("trade-60s-cap-is-unconfirmed").outcome.endedAtMs).toBe(60_000)
  expect(row("trade-revert-is-reverted").outcome).toMatchObject({ result: "TradeRevertedError", signatureKept: true })
  expect(row("trade-landed-in-the-last-read-after-the-hash-died").outcome.result).toBe("returned")
  // Every resend the broadcaster's confirm made skipped preflight and asked for no retries of its own.
  for (const r of scenario("trade-broadcast")) for (const s of r.outcome.resends) expect(s).toEqual({ preflight: false, maxRetries: 0 })
})

test("a swap that didn't confirm leaves sent, unknown evidence and answers SWAP_FAILED at stage unconfirmed", () => {
  expect(row("swap-landed-is-confirmed").outcome).toMatchObject({ confirmed: true, evidence: { stage: "confirmed", legs: [{ outcome: "confirmed", sent: true }] } })
  for (const id of ["swap-dead-hash-answers-unconfirmed", "swap-60s-cap-answers-unconfirmed"]) {
    expect(row(id).outcome, id).toMatchObject({
      confirmed: false,
      signature: "the send's own",
      evidence: { stage: "unconfirmed", code: "SWAP_FAILED", retryable: false, legs: [{ outcome: "unknown", sent: true }] },
      answer: { code: "SWAP_FAILED", stage: "unconfirmed", retryable: false },
    })
  }
  expect(row("swap-dead-hash-answers-unconfirmed").outcome.endedAtMs).toBe(2000)
  expect(row("swap-revert-answers-reverted").outcome).toMatchObject({ answer: { code: "SWAP_FAILED", stage: "reverted", retryable: false } })
})

test("every answer the confirm can end in is a code the harness maps, by its stage", () => {
  expect(row("confirm-codes").outcome).toEqual({ codes: ["SWAP_FAILED"], stages: ["unconfirmed", "reverted"], retryable: [false] })
  const expected: Record<string, string> = { unconfirmed: "unknown", reverted: "failed" }
  const answers = scenario("swap-execution").filter((r) => r.outcome.answer)
  expect(answers).toHaveLength(3)
  for (const r of answers) {
    const answer = r.outcome.answer as { code: string; stage: string; retryable: boolean; message: string }
    const mapped = outcomeOf("swap", { kind: "error", code: answer.code, retryable: answer.retryable, body: { error: answer } })
    expect(mapped.state as string, r.id).toBe(expected[answer.stage]!)
    expect(mapped.error?.stage).toBe(answer.stage)
  }
})

test("the web app's confirm reads every 250 ms by default and stops past the height bound", () => {
  expect(row("web-confirm-reads-every-250ms").outcome).toMatchObject({ statusAtMs: [0, 250, 500, 750], result: "returned" })
  expect(row("web-confirm-stops-past-the-height-bound").outcome).toMatchObject({ statusReads: 3, heightReads: 3, endedAtMs: 500, result: "TransactionExpiredError" })
  expect(row("web-confirm-failed-read-keeps-polling").outcome).toMatchObject({ statusAtMs: [0, 250], result: "returned" })
  expect(row("web-confirm-on-chain-error-is-failed").outcome.result).toBe("TransactionFailedError")
  expect(row("web-confirm-caller-interval-kept").outcome.statusAtMs).toEqual([0, 1000, 2000])
  expect(row("web-confirm-60s-cap-without-a-bound").outcome).toMatchObject({ result: "ConfirmationTimeoutError", endedAtMs: 60_250 })
})

test("the web swap watch runs a round every 250 ms, ends on the chain's expiry proof, and has no deadline", () => {
  expect(row("web-watch-round-every-250ms").outcome).toMatchObject({ roundsAtMs: [0, 250, 500, 750], kind: "landed" })
  // "Not landed" needs the proof twice, 5 s apart.
  expect(row("web-watch-ends-on-the-expiry-proof").outcome).toMatchObject({ rounds: 21, endedAtMs: 5000, kind: "expired" })
  expect(row("web-watch-on-chain-error-is-failed").outcome).toMatchObject({ endedAtMs: 250, kind: "failed" })
  expect(row("web-watch-has-no-deadline").outcome).toMatchObject({ rounds: 300, kind: "landed", windowEndedAtMs: 60_000 })
})

test("the constants, the trade's fast flag and the callers that keep the default loop hold, as source", () => {
  const pins = scenario("source-pin")
  expect(pins.map((p) => p.id)).toEqual([
    "fast-poll-is-250ms", "fast-hash-check-every-8-polls", "fast-budget-is-60s", "fast-hash-read-at-confirmed",
    "trade-confirm-asks-for-fast", "trade-indeterminate-is-unconfirmed",
    "launch-confirm-keeps-the-default-loop", "headless-confirm-keeps-the-default-loop",
    "web-confirm-default-interval-250ms", "web-swap-watch-round-250ms",
  ])
  for (const p of pins) expect(p.outcome.found, p.id).toBe(true)
})
