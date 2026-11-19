// Offline fast-confirm contracts (BE-3927) from an exact clean Candle source checkout: how a Solana trade's
// confirmation waits after its send, recorded by running the API's and the web app's own source against a stand-in
// RPC on a stand-in clock.
//   1. the confirm loop (apps/api/src/services/candle/launch-confirm.ts): the trade rail's fast loop reads the status
//      every 250 ms from the send, checks the transaction's own blockhash every 8 reads and stops once the chain says
//      it is dead, takes one last status read first, and keeps a 60 s budget that covers every RPC wait; the default
//      loop (launches) still sleeps 1 s between reads and never checks the hash;
//   2. the trade broadcaster (trade-broadcast.ts): the confirm a trade runs is the fast one, and a dead hash or the
//      budget ends it as unconfirmed with its signature, never as failed;
//   3. a swap's execution (swap-execution.ts): the evidence an unconfirmed, landed or reverted swap leaves, and the
//      SWAP_FAILED answer the swap routes build from it (the route's own rule is pinned as source text);
//   4. the web app: `confirmSignature` (apps/frontend/src/utils/solana.ts) reads every 250 ms by default and stops at
//      the block height bound; the swap watch (solana-swap-outcome.ts) runs a round every 250 ms and ends on the
//      chain's expiry proof.
// The callers that must keep the default loop are pinned as source text, from the same commit.
// Every RPC is a stand-in and every fetch is refused; no address, key, hash or signature is real.
//   bun scripts/read-fast-confirm-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-fast-confirm-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "apps/api/src", "apps/frontend/src/utils", "packages")
const FILES = [
  "apps/api/src/services/candle/launch-confirm.ts",
  "apps/api/src/services/candle/trade-broadcast.ts",
  "apps/api/src/services/candle/swap-execution.ts",
  "apps/api/src/routes/agent.ts",
  "apps/api/src/services/candle/launch-helpers.ts",
  "apps/api/src/services/candle/solana-headless.ts",
  "apps/frontend/src/utils/solana.ts",
  "apps/frontend/src/utils/solana-swap-outcome.ts",
]
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: FILES,
}
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)

// Nothing here may reach a network: a fetch is refused and counted.
let fetches = 0
globalThis.fetch = (async () => {
  fetches++
  throw new Error("fast-confirm recording may not access the network")
}) as unknown as typeof fetch
for (const name of Object.keys(process.env)) if (/RPC|HELIUS|LEDGER|CONVEX|DATABASE|POSTGRES/i.test(name)) delete process.env[name]
const quiet = { warn: console.warn, error: console.error, log: console.log }
console.warn = () => {}
console.error = () => {}

// The stand-in clock. Installed before the source loads: the confirm loop keeps its own copy of setTimeout for the
// budget race, so that copy has to be this one too. Every sleep, RPC delay and deadline is a timer here, and time only
// moves when nothing else can run.
const realImmediate = globalThis.setImmediate
const realNow = Date.now
const EPOCH = 1_790_000_000_000
let clock = 0
type Timer = { at: number; seq: number; fn: () => void; live: boolean }
let timers: Timer[] = []
let seq = 0
Date.now = () => EPOCH + clock
globalThis.setTimeout = ((fn: () => void, ms = 0) => {
  const t: Timer = { at: clock + Math.max(0, Number(ms) || 0), seq: seq++, fn, live: true }
  timers.push(t)
  return t
}) as unknown as typeof setTimeout
globalThis.clearTimeout = ((t?: Timer) => {
  if (t && typeof t === "object") t.live = false
}) as unknown as typeof clearTimeout
const flush = () => new Promise<void>((r) => realImmediate(r))
/** Run `p` to the end on the stand-in clock, from t = 0. */
async function drive<T>(start: () => Promise<T>): Promise<{ ok: true; value: T; at: number } | { ok: false; error: any; at: number }> {
  clock = 0
  timers = []
  let settled = false
  const p = start()
  p.then(() => { settled = true }, () => { settled = true })
  for (let steps = 0; ; steps++) {
    for (let k = 0; k < 8 && !settled; k++) await flush()
    if (settled) break
    const live = timers.filter((t) => t.live).sort((a, b) => a.at - b.at || a.seq - b.seq)
    const next = live[0]
    if (!next) throw new Error("stuck: nothing pending and nothing settled")
    if (steps > 200_000 || next.at > 600_000) throw new Error("ran past ten minutes of stand-in time")
    next.live = false
    timers = timers.filter((t) => t !== next)
    clock = Math.max(clock, next.at)
    next.fn()
  }
  const at = clock
  return p.then((value) => ({ ok: true as const, value, at }), (error) => ({ ok: false as const, error, at }))
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const confirmMod = await load(FILES[0]!)
const { confirmBroadcastTx, FAST_CONFIRM_POLL_MS, FAST_CONFIRM_DEADLINE_MS } = confirmMod
const broadcastMod = await load(FILES[1]!)
const { __setSwapBroadcastInternalsForTest, broadcastSignedSolanaTx, TRADE_UNCONFIRMED_MESSAGE } = broadcastMod
const { executeSolanaSwap, SWAP_UNCONFIRMED_MESSAGE } = await load(FILES[2]!)
const { confirmSignature } = await load(FILES[6]!)
const { watchSwap, SWAP_SETTLE_WINDOW_MS, EXPIRY_RECHECK_MS } = await load(FILES[7]!)
assert.equal(FAST_CONFIRM_POLL_MS, 250)
assert.equal(FAST_CONFIRM_DEADLINE_MS, 60_000)

// A signed transfer from a made-up wallet on a made-up blockhash: real bytes, so the loop can read its own hash and the
// broadcaster its own signature. Generated per run; rows never carry them.
const web3 = await import(Bun.resolveSync("@solana/web3.js", join(checkout, dirname(FILES[0]!))))
const bs58 = (await import(Bun.resolveSync("bs58", join(checkout, dirname(FILES[1]!))))).default
const { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } = web3
const payer = Keypair.generate()
const OWN_HASH = Keypair.generate().publicKey.toBase58()
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: OWN_HASH,
  instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
}).compileToV0Message()
const signed = new VersionedTransaction(message)
signed.sign([payer])
const RAW = signed.serialize() as Uint8Array
const SIG = bs58.encode(signed.signatures[0]) as string
const SIGNED_B64 = Buffer.from(RAW).toString("base64")
const GARBAGE = new Uint8Array([1, 2, 3, 4])

type Status = null | "processed" | "confirmed" | "finalized" | { at: "processed" | "confirmed" | "finalized"; err: true } | "throw" | "never"
type Plan = {
  /** The answer to the nth status read (1-based); past the end, the last answer repeats. */
  status: Status[]
  /** The answer to the nth blockhash validity read; past the end, the last repeats. Default: valid. */
  valid?: Array<boolean | "throw">
  /** Every read takes this long on the stand-in clock. */
  readMs?: number
  /** Resends: "throw" refuses each one. */
  resend?: "ok" | "throw"
}
/** An RPC that answers only what a confirm reads, and writes down when each read reached it. */
function rpc(plan: Plan) {
  const calls: Array<{ t: number; rpc: string; ownHash?: boolean; commitment?: string; preflight?: boolean; maxRetries?: number }> = []
  let statusN = 0
  let validN = 0
  const pick = <A>(list: A[], n: number) => list[Math.min(n - 1, list.length - 1)]!
  const status = (s: Status) => {
    if (s === null) return { context: { slot: 900 }, value: null }
    if (typeof s === "string") return { context: { slot: 900 }, value: { slot: 901, confirmations: null, err: null, confirmationStatus: s } }
    return { context: { slot: 900 }, value: { slot: 901, confirmations: null, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: s.at } }
  }
  const wait = async () => { if (plan.readMs) await sleep(plan.readMs) }
  const conn = {
    getSignatureStatus: async (sig: string) => {
      calls.push({ t: clock, rpc: "getSignatureStatus" })
      assert.equal(sig, SIG)
      const answer = pick(plan.status, ++statusN)
      if (answer === "never") return new Promise(() => {})
      await wait()
      if (answer === "throw") throw new Error("stand-in RPC refused the read")
      return status(answer)
    },
    isBlockhashValid: async (hash: string, cfg?: { commitment?: string }) => {
      calls.push({ t: clock, rpc: "isBlockhashValid", ownHash: hash === OWN_HASH, ...(cfg?.commitment ? { commitment: cfg.commitment } : {}) })
      const answer = pick(plan.valid ?? [true], ++validN)
      await wait()
      if (answer === "throw") throw new Error("stand-in RPC refused the read")
      return { context: { slot: 900 }, value: answer }
    },
    sendRawTransaction: async (_raw: Uint8Array, opts?: { skipPreflight?: boolean; maxRetries?: number }) => {
      calls.push({ t: clock, rpc: "sendRawTransaction", preflight: opts?.skipPreflight !== true, ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}) })
      await wait()
      // A resend is the loop's own send, made without preflight; the trade's first send keeps it.
      if (opts?.skipPreflight === true && plan.resend === "throw") throw new Error("stand-in RPC refused the send")
      return SIG
    },
  }
  const at = (name: string) => calls.filter((c) => c.rpc === name).map((c) => c.t)
  return { conn, calls, at }
}

type Row = { id: string; scenario: string; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []
const ended = (r: { ok: boolean; error?: any; value?: unknown }): { result: string; message?: string; signature?: string; signatureKept?: boolean } =>
  r.ok ? { result: "returned", ...(r.value === SIG ? { signature: "the send's own" } : {}) } : {
    result: r.error?.name ?? "Error",
    message: r.error?.message,
    ...(r.error?.signature !== undefined ? { signatureKept: r.error.signature === SIG } : {}),
  }
/** The first reads' times, the count, and how the loop ended. Long runs keep only their first and last reads. */
function shape(c: ReturnType<typeof rpc>, r: Awaited<ReturnType<typeof drive>>) {
  const reads = c.at("getSignatureStatus")
  const validity = c.calls.filter((x) => x.rpc === "isBlockhashValid")
  return {
    statusReads: reads.length,
    statusAtMs: reads.length <= 12 ? reads : [...reads.slice(0, 6), "...", ...reads.slice(-2)],
    validityAtMs: validity.length <= 12 ? validity.map((v) => v.t) : [...validity.slice(0, 6).map((v) => v.t), "...", ...validity.slice(-2).map((v) => v.t)],
    validityReads: validity.length,
    ...(validity.length ? { validityOnOwnHash: validity.every((v) => v.ownHash), validityCommitment: [...new Set(validity.map((v) => v.commitment))] } : {}),
    resendsAtMs: c.at("sendRawTransaction"),
    endedAtMs: r.at,
    ...ended(r),
  }
}

// 1. The confirm loop itself.
{
  const loop = async (id: string, args: Record<string, unknown>, plan: Plan, fast: boolean, raw: Uint8Array = RAW) => {
    const c = rpc(plan)
    let observed: { sends: number; slot: number | null } | null = null
    const r = await drive(() => confirmBroadcastTx(c.conn, raw, SIG, (seen: { sends: number; slot: number | null }) => { observed = { sends: seen.sends, slot: seen.slot } }, fast ? { fast: true } : {}))
    const outcome = { ...shape(c, r), ...(observed ? { observed } : {}) }
    rows.push({ id, scenario: fast ? "fast-loop" : "default-loop", args: { ...args, fast }, outcome })
    return outcome
  }
  const landsAt = (n: number, final: Status = "confirmed"): Status[] => [...Array.from({ length: n - 1 }, () => null), final]

  // Cadence.
  let o = await loop("fast-first-read-at-250ms", { landsOnRead: 1 }, { status: landsAt(1) }, true)
  assert.deepEqual([o.statusAtMs, o.endedAtMs, o.result], [[250], 250, "returned"])
  o = await loop("default-first-read-at-1s", { landsOnRead: 1 }, { status: landsAt(1) }, false)
  assert.deepEqual([o.statusAtMs, o.endedAtMs], [[1000], 1000])
  o = await loop("fast-reads-every-250ms", { landsOnRead: 6 }, { status: landsAt(6) }, true)
  assert.deepEqual(o.statusAtMs, [250, 500, 750, 1000, 1250, 1500])
  o = await loop("default-reads-every-1s", { landsOnRead: 3 }, { status: landsAt(3) }, false)
  assert.deepEqual(o.statusAtMs, [1000, 2000, 3000])

  // The blockhash bound.
  o = await loop("fast-checks-its-own-hash-every-8-reads", { landsOnRead: 20, hash: "valid" }, { status: landsAt(20) }, true)
  assert.deepEqual(o.validityAtMs, [2000, 4000])
  o = await loop("fast-stops-once-the-hash-is-dead", { hash: "dead at the first check" }, { status: [null], valid: [false] }, true)
  assert.deepEqual([o.statusReads, o.endedAtMs, o.result], [9, 2000, "LaunchConfirmationTimeoutError"])
  o = await loop("fast-dead-hash-later-check", { hash: "dead at the third check" }, { status: [null], valid: [true, true, false] }, true)
  assert.deepEqual([o.statusReads, o.endedAtMs], [25, 6000])
  o = await loop("fast-dead-hash-landed-in-the-last-read-wins", { hash: "dead", lastRead: "confirmed" }, { status: [...landsAt(9)], valid: [false] }, true)
  assert.equal(o.result, "returned")
  o = await loop("fast-dead-hash-finalized-in-the-last-read-wins", { hash: "dead", lastRead: "finalized" }, { status: [...landsAt(9, "finalized")], valid: [false] }, true)
  assert.equal(o.result, "returned")
  o = await loop("fast-dead-hash-reverted-in-the-last-read", { hash: "dead", lastRead: "confirmed with an error" }, { status: [...landsAt(9, { at: "confirmed", err: true })], valid: [false] }, true)
  assert.equal(o.result, "OnChainRevertError")
  o = await loop("fast-dead-hash-processed-is-not-landed", { hash: "dead", lastRead: "processed" }, { status: [...landsAt(9, "processed")], valid: [false] }, true)
  assert.equal(o.result, "LaunchConfirmationTimeoutError")
  o = await loop("fast-dead-hash-processed-error-is-not-final", { hash: "dead", lastRead: "processed with an error" }, { status: [...landsAt(9, { at: "processed", err: true })], valid: [false] }, true)
  assert.equal(o.result, "LaunchConfirmationTimeoutError")
  o = await loop("fast-dead-hash-last-read-fails", { hash: "dead", lastRead: "rpc failure" }, { status: [...landsAt(9, "throw")], valid: [false] }, true)
  assert.equal(o.result, "LaunchConfirmationTimeoutError")
  o = await loop("fast-failed-validity-read-decides-nothing", { landsOnRead: 12, firstCheck: "rpc failure" }, { status: landsAt(12), valid: ["throw", true] }, true)
  assert.equal(o.result, "returned")
  o = await loop("fast-undecodable-bytes-never-check-a-hash", { landsOnRead: 20, bytes: "undecodable" }, { status: landsAt(20) }, true, GARBAGE)
  assert.equal(o.validityReads, 0)
  o = await loop("default-never-checks-the-hash", { landsOnRead: 20, hash: "dead" }, { status: landsAt(20), valid: [false] }, false)
  assert.deepEqual([o.validityReads, o.result], [0, "returned"])

  // Reads that fail, and what landed before the hash died.
  o = await loop("fast-status-read-failure-is-indeterminate", { failsOnRead: 3 }, { status: [null, null, "throw"] }, true)
  assert.deepEqual([o.result, o.endedAtMs], ["IndeterminateLaunchOutcomeError", 750])
  o = await loop("fast-reverted-status-is-final", { revertsOnRead: 2 }, { status: [null, { at: "confirmed", err: true }] }, true)
  assert.deepEqual([o.result, o.endedAtMs], ["OnChainRevertError", 500])
  o = await loop("fast-processed-error-keeps-polling", { reads: "processed with an error, then confirmed" }, { status: [{ at: "processed", err: true }, { at: "processed", err: true }, "confirmed"] }, true)
  assert.deepEqual([o.result, o.statusReads], ["returned", 3])

  // Resends: every 3 s from the send, as before.
  o = await loop("fast-resends-every-3s", { landsOnRead: 30 }, { status: landsAt(30) }, true)
  assert.deepEqual(o.resendsAtMs, [3250, 6500])
  o = await loop("default-resends-every-3s", { landsOnRead: 9 }, { status: landsAt(9) }, false)
  assert.deepEqual(o.resendsAtMs, [4000, 8000])
  // A refused resend leaves the last send's time where it was, so the next read tries again.
  o = await loop("fast-refused-resend-is-tried-each-read-and-keeps-polling", { landsOnRead: 16, resends: "refused" }, { status: landsAt(16), resend: "throw" }, true)
  assert.deepEqual([o.result, o.resendsAtMs, (o as { observed?: { sends: number } }).observed?.sends], ["returned", [3250, 3500, 3750], 1])

  // The 60 s budget.
  o = await loop("fast-60s-cap-while-the-hash-stays-valid", { lands: "never", hash: "valid" }, { status: [null] }, true)
  assert.deepEqual([o.statusReads, o.endedAtMs, o.result], [240, 60_000, "LaunchConfirmationTimeoutError"])
  o = await loop("default-60s-cap", { lands: "never" }, { status: [null] }, false)
  assert.deepEqual([o.statusReads, o.endedAtMs, o.validityReads], [60, 60_000, 0])
  o = await loop("fast-slow-reads-stay-inside-the-budget", { lands: "never", eachReadMs: 5_000 }, { status: [null], readMs: 5_000 }, true)
  assert.ok((o.endedAtMs as number) <= 60_000)
  o = await loop("fast-a-read-that-never-answers-is-cut-at-the-budget", { firstRead: "never answers" }, { status: ["never"] }, true)
  assert.deepEqual([o.endedAtMs, o.result], [60_000, "LaunchConfirmationTimeoutError"])
}

// 2. The trade broadcaster, with its real confirm.
{
  const trade = async (id: string, args: Record<string, unknown>, plan: Plan) => {
    const c = rpc(plan)
    __setSwapBroadcastInternalsForTest({ connection: c.conn })
    const r = await drive(() => broadcastSignedSolanaTx(SIGNED_B64))
    __setSwapBroadcastInternalsForTest(null)
    const sends = c.calls.filter((x) => x.rpc === "sendRawTransaction")
    const outcome = {
      ...shape(c, r),
      firstSend: { preflight: sends[0]?.preflight, maxRetries: sends[0]?.maxRetries },
      resends: sends.slice(1).map((s) => ({ preflight: s.preflight, maxRetries: s.maxRetries })),
      ...(r.ok ? {} : { unconfirmedMessage: r.error?.message === TRADE_UNCONFIRMED_MESSAGE }),
    }
    // The broadcaster's first send is a read of the clock too; the resends' times count from t = 0 like the reads.
    outcome.resendsAtMs = sends.slice(1).map((s) => s.t)
    rows.push({ id, scenario: "trade-broadcast", args, outcome })
    return outcome
  }
  let o = await trade("trade-confirm-is-the-fast-loop", { landsOnRead: 2 }, { status: [null, "confirmed"] })
  assert.deepEqual([o.statusAtMs, o.result], [[250, 500], "returned"])
  o = await trade("trade-dead-hash-is-unconfirmed", { hash: "dead at the first check" }, { status: [null], valid: [false] })
  assert.deepEqual([o.result, o.endedAtMs, o.signatureKept, o.unconfirmedMessage], ["TradeUnconfirmedError", 2000, true, true])
  o = await trade("trade-60s-cap-is-unconfirmed", { lands: "never", hash: "valid" }, { status: [null] })
  assert.deepEqual([o.result, o.endedAtMs], ["TradeUnconfirmedError", 60_000])
  o = await trade("trade-never-answering-read-is-unconfirmed", { firstRead: "never answers" }, { status: ["never"] })
  assert.deepEqual([o.result, o.endedAtMs], ["TradeUnconfirmedError", 60_000])
  o = await trade("trade-status-read-failure-is-unconfirmed", { failsOnRead: 2 }, { status: [null, "throw"] })
  assert.equal(o.result, "TradeUnconfirmedError")
  o = await trade("trade-revert-is-reverted", { revertsOnRead: 3 }, { status: [null, null, { at: "confirmed", err: true }] })
  assert.equal(o.result, "TradeRevertedError")
  o = await trade("trade-landed-in-the-last-read-after-the-hash-died", { hash: "dead", lastRead: "confirmed" }, { status: [null, null, null, null, null, null, null, null, "confirmed"], valid: [false] })
  assert.equal(o.result, "returned")
}

// 3. A swap's execution and the SWAP_FAILED answer built from it.
{
  const agentText = text(FILES[3]!)
  /** The swap routes' answer for a swap that did not confirm (agent.ts, swapExecutionFailure), applied to the evidence. */
  const routeAnswer = (result: { evidence: { stage: string; message?: string }; evidenceStored: boolean }) => {
    const stage = result.evidenceStored ? result.evidence.stage : "unconfirmed"
    return {
      code: "SWAP_FAILED",
      stage: stage === "confirmed" ? "unconfirmed" : stage,
      retryable: result.evidenceStored && stage === "not_broadcast",
      message: result.evidenceStored ? (result.evidence.message ?? SWAP_UNCONFIRMED_MESSAGE) : `Could not persist execution evidence. ${SWAP_UNCONFIRMED_MESSAGE}`,
    }
  }
  assert.ok(/function swapExecutionFailure\([\s\S]{0,200}?const stage = evidenceStored \? evidence\.stage : "unconfirmed"[\s\S]{0,120}?"SWAP_FAILED",[\s\S]{0,400}?stage: stage === "confirmed" \? "unconfirmed" : stage,\s*retryable: evidenceStored && stage === "not_broadcast",/.test(agentText), "swapExecutionFailure moved")
  const swap = async (id: string, args: Record<string, unknown>, plan: Plan) => {
    const c = rpc(plan)
    __setSwapBroadcastInternalsForTest({ connection: c.conn })
    const stored: string[] = []
    const persistence = {
      record: async (e: { stage: string }) => { stored.push(e.stage); return true },
      fail: async () => true,
    }
    const r = await drive(() => executeSolanaSwap([SIGNED_B64], persistence, async () => null))
    __setSwapBroadcastInternalsForTest(null)
    assert.ok(r.ok, `${id}: executeSolanaSwap threw`)
    const result = r.value as { confirmed: boolean; evidenceStored: boolean; signature?: string; evidence: { stage: string; code?: string; message?: string; retryable: boolean; legs: Array<{ outcome: string; sent?: boolean }> } }
    const outcome: Record<string, unknown> = {
      confirmed: result.confirmed,
      endedAtMs: r.at,
      evidence: { stage: result.evidence.stage, ...(result.evidence.code ? { code: result.evidence.code } : {}), retryable: result.evidence.retryable, legs: result.evidence.legs.map((l) => ({ outcome: l.outcome, sent: l.sent === true })) },
      storedStages: stored,
      signature: result.signature === SIG ? "the send's own" : result.signature === undefined ? "none" : "other",
      ...(result.confirmed ? {} : { answer: routeAnswer(result) }),
    }
    rows.push({ id, scenario: "swap-execution", args, outcome })
    return outcome
  }
  let o = await swap("swap-landed-is-confirmed", { landsOnRead: 2 }, { status: [null, "confirmed"] })
  assert.equal(o.confirmed, true)
  o = await swap("swap-dead-hash-answers-unconfirmed", { hash: "dead at the first check" }, { status: [null], valid: [false] })
  assert.deepEqual([o.confirmed, (o.answer as { stage: string }).stage, o.endedAtMs], [false, "unconfirmed", 2000])
  o = await swap("swap-60s-cap-answers-unconfirmed", { lands: "never" }, { status: [null] })
  assert.deepEqual([(o.answer as { stage: string }).stage, o.endedAtMs], ["unconfirmed", 60_000])
  o = await swap("swap-revert-answers-reverted", { revertsOnRead: 2 }, { status: [null, { at: "confirmed", err: true }] })
  assert.equal((o.answer as { stage: string }).stage, "reverted")
}

// 4. The web app.
{
  type WebPlan = { status: Array<null | "confirmed" | "processed" | "throw" | { err: true }>; heights?: number[] }
  const web = (plan: WebPlan) => {
    const reads: Array<{ t: number; rpc: string }> = []
    let n = 0
    let h = 0
    const conn = {
      getSignatureStatuses: async (sigs: string[]) => {
        reads.push({ t: clock, rpc: "getSignatureStatuses" })
        assert.equal(sigs[0], SIG)
        const a = plan.status[Math.min(n++, plan.status.length - 1)]!
        if (a === "throw") throw new Error("stand-in RPC refused the read")
        const value = a === null ? null : typeof a === "string" ? { slot: 901, confirmations: null, err: null, confirmationStatus: a } : { slot: 901, confirmations: null, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" }
        return { context: { slot: 900 }, value: [value] }
      },
      getBlockHeight: async () => {
        reads.push({ t: clock, rpc: "getBlockHeight" })
        return plan.heights![Math.min(h++, plan.heights!.length - 1)]!
      },
    }
    return { conn, reads, at: (rpc: string) => reads.filter((r) => r.rpc === rpc).map((r) => r.t) }
  }
  const confirm = async (id: string, args: Record<string, unknown>, plan: WebPlan, opts: Record<string, unknown> = {}) => {
    const c = web(plan)
    const r = await drive(() => confirmSignature(c.conn, SIG, opts))
    const reads = c.at("getSignatureStatuses")
    const outcome = {
      statusReads: reads.length,
      statusAtMs: reads.length <= 12 ? reads : [...reads.slice(0, 6), "...", ...reads.slice(-2)],
      heightReads: c.at("getBlockHeight").length,
      endedAtMs: r.at,
      result: r.ok ? "returned" : (r.error?.name ?? "Error"),
    }
    rows.push({ id, scenario: "web-confirm", args, outcome })
    return outcome
  }
  const LVBH = 1_000
  let o = await confirm("web-confirm-reads-every-250ms", { landsOnRead: 4 }, { status: [null, null, null, "confirmed"] })
  assert.deepEqual(o.statusAtMs, [0, 250, 500, 750])
  o = await confirm("web-confirm-stops-past-the-height-bound", { lastValidBlockHeight: LVBH, heightPassesOnRead: 3 }, { status: [null], heights: [LVBH - 1, LVBH, LVBH + 1] }, { lastValidBlockHeight: LVBH })
  assert.deepEqual([o.result, o.endedAtMs, o.statusReads], ["TransactionExpiredError", 500, 3])
  o = await confirm("web-confirm-failed-read-keeps-polling", { reads: "rpc failure, then confirmed" }, { status: ["throw", "confirmed"] })
  assert.deepEqual([o.result, o.statusAtMs], ["returned", [0, 250]])
  o = await confirm("web-confirm-on-chain-error-is-failed", { erroredOnRead: 2 }, { status: [null, { err: true }] })
  assert.equal(o.result, "TransactionFailedError")
  o = await confirm("web-confirm-caller-interval-kept", { intervalMs: 1_000, landsOnRead: 3 }, { status: [null, null, "confirmed"] }, { intervalMs: 1_000 })
  assert.deepEqual(o.statusAtMs, [0, 1000, 2000])
  o = await confirm("web-confirm-60s-cap-without-a-bound", { lands: "never" }, { status: [null] })
  assert.equal(o.result, "ConfirmationTimeoutError")

  // The swap watch: the effects are injected, so it runs on the same stand-in clock.
  type WatchPlan = { status: Array<null | "confirmed" | { err: true }>; finalizedHeight?: number; historySlot?: number }
  const watch = async (id: string, args: Record<string, unknown>, plan: WatchPlan) => {
    const reads: Array<{ t: number; rpc: string }> = []
    let n = 0
    const FINAL_SLOT = 5_000
    const BOUND = 2_000
    const fx = {
      now: () => clock,
      sleep,
      rpc: {
        getSignatureStatuses: async (sigs: string[], cfg?: { searchTransactionHistory?: boolean }) => {
          reads.push({ t: clock, rpc: cfg?.searchTransactionHistory ? "history" : "getSignatureStatuses" })
          assert.equal(sigs[0], SIG)
          if (cfg?.searchTransactionHistory) return { context: { slot: plan.historySlot ?? FINAL_SLOT }, value: [null] }
          const a = plan.status[Math.min(n++, plan.status.length - 1)]!
          const value = a === null ? null : a === "confirmed" ? { slot: 901, confirmations: null, err: null, confirmationStatus: "confirmed" } : { slot: 901, confirmations: null, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" }
          return { context: { slot: 900 }, value: [value] }
        },
        getLatestBlockhashAndContext: async () => {
          reads.push({ t: clock, rpc: "finalized" })
          // The finalized height is the reply's lastValidBlockHeight less one blockhash lifetime (150 blocks).
          return { context: { slot: FINAL_SLOT }, value: { blockhash: OWN_HASH, lastValidBlockHeight: (plan.finalizedHeight ?? BOUND - 10) + 150 } }
        },
        getLatestBlockhash: async () => ({ blockhash: OWN_HASH, lastValidBlockHeight: BOUND - 150 }),
        sendRawTransaction: async () => SIG,
        getAccountInfo: async () => null,
      },
    }
    let windowEndedAt: number | null = null
    const entry = { signature: SIG, wallet: "stand-in", inputMint: "stand-in", outputMint: "stand-in", side: "buy" as const, expiryHeight: BOUND }
    const r = await drive(() => watchSwap(fx, entry, RAW, { onWindowEnd: () => { windowEndedAt = clock } }))
    assert.ok(r.ok, `${id}: the watch rejected`)
    const status = reads.filter((x) => x.rpc === "getSignatureStatuses").map((x) => x.t)
    const outcome = {
      rounds: status.length,
      roundsAtMs: status.length <= 12 ? status : [...status.slice(0, 6), "...", ...status.slice(-2)],
      endedAtMs: r.at,
      kind: (r.value as { kind: string }).kind,
      ...(windowEndedAt !== null ? { windowEndedAtMs: windowEndedAt } : {}),
    }
    rows.push({ id, scenario: "web-swap-watch", args, outcome })
    return outcome
  }
  let w = await watch("web-watch-round-every-250ms", { landsOnRound: 4 }, { status: [null, null, null, "confirmed"] })
  assert.deepEqual([w.roundsAtMs, w.kind], [[0, 250, 500, 750], "landed"])
  w = await watch("web-watch-ends-on-the-expiry-proof", { finalized: "past the bound", history: "none" }, { status: [null], finalizedHeight: 2_001 })
  assert.deepEqual([w.kind, w.endedAtMs], ["expired", EXPIRY_RECHECK_MS])
  w = await watch("web-watch-on-chain-error-is-failed", { erroredOnRound: 2 }, { status: [null, { err: true }] })
  assert.deepEqual([w.kind, w.endedAtMs], ["failed", 250])
  w = await watch("web-watch-has-no-deadline", { landsOnRound: 300 }, { status: [...Array.from({ length: 299 }, () => null), "confirmed"] })
  assert.equal(w.kind, "landed")
  assert.ok((w.endedAtMs as number) > SWAP_SETTLE_WINDOW_MS)
}

// 5. Source facts at the pinned commit.
const confirmText = text(FILES[0]!)
const tradeText = text(FILES[1]!)
const helpersText = text(FILES[4]!)
const headlessText = text(FILES[5]!)
const webText = text(FILES[6]!)
const watchText = text(FILES[7]!)
const pin = (id: string, file: string, found: boolean) => {
  assert.ok(found, `${id} (${file})`)
  rows.push({ id, scenario: "source-pin", args: { file }, outcome: { found } })
}
pin("fast-poll-is-250ms", FILES[0]!, /export const FAST_CONFIRM_POLL_MS = 250\b/.test(confirmText))
pin("fast-hash-check-every-8-polls", FILES[0]!, /const FAST_CONFIRM_EXPIRY_EVERY = 8\b/.test(confirmText))
pin("fast-budget-is-60s", FILES[0]!, /export const FAST_CONFIRM_DEADLINE_MS = 60_000\b/.test(confirmText))
pin("fast-hash-read-at-confirmed", FILES[0]!, /isBlockhashValid\(blockhash, \{ commitment: "confirmed" \}\)/.test(confirmText))
pin("trade-confirm-asks-for-fast", FILES[1]!, /await confirmImpl\(\s*connection,\s*raw,\s*sig,[\s\S]{0,120}?\{ fast: true \},\s*\)/.test(tradeText))
pin("trade-indeterminate-is-unconfirmed", FILES[1]!, /if \(isIndeterminateSwapError\(error\)\) \{[\s\S]{0,200}?throw new TradeUnconfirmedError\(TRADE_UNCONFIRMED_MESSAGE, \{ signature: sig \}\)/.test(tradeText))
pin("launch-confirm-keeps-the-default-loop", FILES[4]!, /return confirmBroadcastTx\(connection, raw, sig\)\n/.test(helpersText))
pin("headless-confirm-keeps-the-default-loop", FILES[5]!, /return confirmImpl\(connection, raw, sig\)\n/.test(headlessText) && !/fast: true/.test(headlessText))
pin("web-confirm-default-interval-250ms", FILES[6]!, /intervalMs = 250 \} = opts/.test(webText))
pin("web-swap-watch-round-250ms", FILES[7]!, /const POLL_INTERVAL_MS = 250\b/.test(watchText))

// The codes a trade's confirm can end in, as the swap routes answer them.
{
  const answers = rows.filter((r) => r.scenario === "swap-execution" && r.outcome.answer).map((r) => r.outcome.answer as { code: string; stage: string; retryable: boolean })
  rows.push({ id: "confirm-codes", scenario: "codes", args: { from: "swap-execution" }, outcome: { codes: [...new Set(answers.map((a) => a.code))], stages: [...new Set(answers.map((a) => a.stage))], retryable: [...new Set(answers.map((a) => a.retryable))] } })
}

Date.now = realNow
console.warn = quiet.warn
console.error = quiet.error
assert.equal(fetches, 0, "a recording reached for the network")
const textOut = JSON.stringify(rows)
for (const secret of [SIG, OWN_HASH, payer.publicKey.toBase58(), SIGNED_B64, "BEGIN"]) assert.ok(!textOut.includes(secret), `a fixture carries ${secret.slice(0, 8)}`)
writeFileSync(join(import.meta.dir, "../test/fixtures/candle-fast-confirm-source.json"), `${JSON.stringify({
  about: "Offline fast-confirm contracts (BE-3927): the trade rail's confirm reads the status every 250 ms from the send, checks the transaction's own blockhash every 8 reads and stops once the chain says it is dead (after one last status read), and keeps a 60 s budget that covers every RPC wait; launches keep the 1 s loop. A dead hash or the budget ends a trade as unconfirmed with its signature, and a swap answers SWAP_FAILED at stage unconfirmed. The web app's confirm reads every 250 ms and stops past the height bound; its swap watch runs a round every 250 ms and ends on the chain's expiry proof. Recorded by running the source against a stand-in RPC on a stand-in clock from an exact staging commit; every fetch is refused. The commit changes no CLI, MCP or SDK file: their published versions are the ones named in the source block.",
  source, rows,
}, null, 2)}\n`)
quiet.log(`Recorded ${rows.length} offline fast-confirm contracts from ${source.commit}.`)
