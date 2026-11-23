// Offline wait:"sent" contracts (BE-3929) from an exact clean Candle source checkout: a linked Solana trade's
// `POST /api/v1/trade/agent/submit` with `wait: "sent"` answers HTTP 202 once the RPC acknowledges the send, and
// Candle confirms and books the trade in the background, or its worker does. Recorded by running Candle's own
// source against stand-ins.
//   1. broadcast: the real trade broadcaster with `onSent`, on a stand-in RPC and a stand-in clock, driven the way
//                 the route drives it (its race between the acknowledgement and the confirmation): when the 202
//                 goes out, when the booking runs, and what a refused, lost, reverted or unconfirmed send answers
//                 instead; the default `wait: "confirmed"` beside it, answering only after the confirmation;
//   2. confirm:   the real confirm loop with the sent caller's `resend: false`: no resend, whatever the wait;
//   3. wire:      Candle's own Solana wire checks (sign-hash.ts) on real signed and tampered bytes: a borrowed
//                 signature whose message still matches a stamped build is caught before either pre-send write;
//   4. fence:     Candle's own pre-send record rules (the patch a reservation and a default submit write, the held
//                 signature, the broadcast evidence a reservation checks) run on made-up rows: of two competing
//                 submits one sends, and the other sends nothing;
//   5. worker:    the real `trading-background-booking` pass (runResolvePass) and the real worker confirm
//                 (routeResolveConfirm) against a stand-in database: booked, a bound revert, an unseen
//                 transaction kept with its signature and hold, a refusal, an unavailable confirm, a trade the
//                 request booked first, and the ordinary resolve pass that leaves sent trades to this one;
//   6. booking:   the real `confirmSolanaTrade` run concurrently as both the API's background booking (holding the
//                 submitted wire) and the worker's recovery (holding only the row's signature) against an in-memory
//                 ledger stand-in: one booking, full stamped fee, usage/webhook/accrual once, unseen first read,
//                 bound `TRADE_REVERTED`, and unbound `SWAP_FAILED` retry;
//   7. route:     the submit route's checks, their order and their answers, pinned as source text (the handler
//                 sits behind auth, Convex and the database), with each answer's code;
//   8. openapi:   the agent API description's request field and 202 answer, read from the source's own object;
//   9. sdk:       `submit()`, `trade()` and `waitForTrade()` against a stand-in API;
//  10. cli:       `candle swap --wait-sent` through the CLI's own `run()`, its refusals, and `candle swap status`;
//  11. docs:      the agent-trading section on returning at broadcast, as source text.
// Every fetch is intercepted: nothing reaches a network or a database, nothing is signed with a real key, and no
// address, key, signature or figure is real.
//   bun scripts/read-wait-sent-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-wait-sent-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "apps/api/src", "packages/cli", "packages/sdk", "packages/db", "packages/shared", "docs/agent-trading.md")
const FILES = [
  "apps/api/src/routes/trade-agent.ts",
  "apps/api/src/routes/trade-agent-confirm.ts",
  "apps/api/src/lib/sign-hash.ts",
  "apps/api/src/services/candle/trade-broadcast.ts",
  "apps/api/src/services/candle/launch-confirm.ts",
  "apps/api/src/ledger/trading/trades/outcomes.ts",
  "apps/api/src/ledger/trading/trades/passes.ts",
  "apps/api/src/ledger/trading/trades/resolve-confirm.ts",
  "apps/api/src/ledger/trading/trades/projection.ts",
  "apps/api/src/ledger/trading/trades/sign-claims.ts",
  "packages/db/convex/lib/agentTradeExecutePolicy.ts",
  "apps/api/src/openapi/agent-api.ts",
  "packages/sdk/src/client.ts",
  "packages/cli/src/commands/swap.ts",
  "docs/agent-trading.md",
]
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(text(`packages/${p}/package.json`)).version])),
  files: FILES,
}
for (const f of FILES) text(f)
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({ name: "wait-sent-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
  // Route confirmSolanaTrade's moved-table calls through Candle's own in-memory route-test double (fake-convex.test) instead of Postgres.
  build.onLoad({ filter: /apps\/api\/src\/services\/trading-store\.ts$/ }, () => ({
    contents: 'import { tradingStoreFixture } from "../testing/trading-store-fixture"; export const { buildTrade, dispatchMoved, keyAccessFeed, recordBoundRefusal, recordReconciledTrade, recordWebsiteConfirm, refreshRisk, riskForKey, stampArm, sweepTransferHoldsOnPostgres, usageForKey, websiteConfirmRecordedNow, withRebindClaims } = tradingStoreFixture;',
    loader: "ts",
  }))
} })

// Nothing here may reach a network or a database: a fetch is refused and counted, and the variables that would
// name a database, an RPC or Convex are dropped before the source loads.
let fetches = 0
const fetched: string[] = []
const originalFetch = globalThis.fetch
const refuseFetch = (async (input: unknown) => {
  fetches++
  fetched.push(new URL(String(input instanceof Request ? input.url : input)).host)
  throw new Error("wait-sent recording may not access the network")
}) as unknown as typeof fetch
globalThis.fetch = refuseFetch
for (const name of Object.keys(process.env)) if (/RPC|HELIUS|LEDGER|CONVEX|DATABASE|POSTGRES|TRADING_STORE/i.test(name)) delete process.env[name]
const quiet = { warn: console.warn, error: console.error, log: console.log }
console.warn = () => {}
console.error = () => {}

type Row = { id: string; scenario: string; evidence?: string; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []
const record = (id: string, scenario: string, args: Record<string, unknown>, outcome: Record<string, unknown>, evidence?: string) =>
  rows.push({ id, scenario, ...(evidence ? { evidence } : {}), args, outcome })
const dirs: string[] = []
const dir = (label: string) => { const d = mkdtempSync(join(tmpdir(), `candle-wait-sent-${label}-`)); dirs.push(d); return d }
const API = "https://api.test"
const RPC = "https://rpc.private.test/v2/fixture-path-not-a-key"
const KEY = "fixture-only-not-a-key"
const INTERNAL = "fixture-internal-not-a-key"

// The stand-in clock, installed before the confirm loop loads: it keeps its own copy of setTimeout for its budget
// race, so that copy has to be this one. Time moves only when nothing else can run. Restored after section 2.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
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
globalThis.clearTimeout = ((t?: Timer) => { if (t && typeof t === "object") t.live = false }) as unknown as typeof clearTimeout
const flush = () => new Promise<void>((r) => realImmediate(r))
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

const { confirmBroadcastTx } = await load("apps/api/src/services/candle/launch-confirm.ts")
const broadcastMod = await load("apps/api/src/services/candle/trade-broadcast.ts")
const { __setSwapBroadcastInternalsForTest, broadcastSignedSolanaTx, isSolanaSendRefusal, TradeRevertedError, TRADE_UNCONFIRMED_MESSAGE } = broadcastMod
const web3 = await import(Bun.resolveSync("@solana/web3.js", join(checkout, "apps/api/src/services/candle")))
const bs58 = (await import(Bun.resolveSync("bs58", join(checkout, "apps/api/src/services/candle")))).default
const { Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction } = web3

// A signed transfer from a made-up wallet on a made-up blockhash: real bytes, so the broadcaster derives its own
// signature and the loop reads its own hash. Generated per run; rows never carry them.
const payer = Keypair.generate()
const otherPayer = Keypair.generate()
const OWN_HASH = Keypair.generate().publicKey.toBase58()
const signedTx = () => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: OWN_HASH,
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message()
  const unsigned = new VersionedTransaction(message)
  const unsignedB64 = Buffer.from(unsigned.serialize()).toString("base64")
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  const raw = tx.serialize() as Uint8Array
  return { raw, unsignedB64, b64: Buffer.from(raw).toString("base64"), sig: bs58.encode(tx.signatures[0]) as string, sigBytes: tx.signatures[0] as Uint8Array }
}
const TX = signedTx()
const OTHER = signedTx()
const secrets: string[] = [TX.sig, TX.b64, TX.unsignedB64, OTHER.sig, OTHER.b64, OTHER.unsignedB64, OWN_HASH, payer.publicKey.toBase58(), otherPayer.publicKey.toBase58()]
const sigLabel = (s: unknown) => (s === TX.sig ? "<signature>" : s === OTHER.sig ? "<other signature>" : s === undefined ? null : "<unexpected>")

try {
  // 1. The broadcaster with onSent, driven as the route drives it.
  type Status = null | "confirmed" | { err: true } | "throw"
  type Plan = { status: Status[]; valid?: boolean[]; send?: "ok" | "refused" | "lost" | "other-signature" }
  const rpc = (plan: Plan) => {
    const calls: Array<{ t: number; rpc: string; preflight?: boolean }> = []
    let statusN = 0
    let validN = 0
    let sends = 0
    const pick = <A>(list: A[], n: number) => list[Math.min(n - 1, list.length - 1)]!
    const conn = {
      getSignatureStatus: async () => {
        calls.push({ t: clock, rpc: "getSignatureStatus" })
        const a = pick(plan.status, ++statusN)
        if (a === "throw") throw new Error("stand-in RPC refused the read")
        if (a === null) return { context: { slot: 900 }, value: null }
        return { context: { slot: 900 }, value: { slot: 901, confirmations: null, err: a === "confirmed" ? null : { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" } }
      },
      isBlockhashValid: async () => {
        calls.push({ t: clock, rpc: "isBlockhashValid" })
        return { context: { slot: 900 }, value: pick(plan.valid ?? [true], ++validN) }
      },
      sendRawTransaction: async (_raw: Uint8Array, opts?: { skipPreflight?: boolean }) => {
        calls.push({ t: clock, rpc: "sendRawTransaction", preflight: opts?.skipPreflight !== true })
        sends++
        if (sends === 1 && plan.send === "refused") throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Blockhash not found" })
        if (sends === 1 && plan.send === "lost") throw new Error("socket hang up")
        return sends === 1 && plan.send === "other-signature" ? OTHER.sig : TX.sig
      },
    }
    return { conn, calls, at: (name: string) => calls.filter((c) => c.rpc === name).map((c) => c.t) }
  }
  type Event = { atMs: number; event: string; signature?: string | null }
  /** The route's wait:"sent" body after its reservation (trade-agent.ts submitSolanaUntilSent), on the real broadcaster. */
  const sentRoute = async () => {
    const events: Event[] = []
    const sent = Promise.withResolvers<string>()
    const confirmation: Promise<string> = broadcastSignedSolanaTx(TX.b64, {
      onSent: (s: string) => { events.push({ atMs: clock, event: "onSent", signature: sigLabel(s) }); sent.resolve(s) },
      onBroadcast: (s: string) => { events.push({ atMs: clock, event: "onBroadcast", signature: sigLabel(s) }) },
    })
    confirmation.catch(() => {})
    let answer: Record<string, unknown>
    try {
      const accepted = await Promise.race([sent.promise, confirmation])
      answer = { httpStatus: 202, atMs: clock, body: { success: true, status: "broadcast", chain: "solana", clientTradeId: "<id>", signature: sigLabel(accepted) } }
    } catch (err) {
      answer = {
        atMs: clock, code: "SWAP_FAILED", retryable: false, stage: "unconfirmed", signature: "<signature>",
        message: isSolanaSendRefusal(err) ? "rpc-refused" : (err as Error).message === TRADE_UNCONFIRMED_MESSAGE ? "unconfirmed" : "other",
        thrown: (err as Error).name,
      }
    }
    let background: Record<string, unknown>
    try {
      const s = await confirmation
      background = { atMs: clock, landed: sigLabel(s), booking: "request" }
    } catch (err) {
      const errSig = (err as any).signature
      background = err instanceof TradeRevertedError
        ? { atMs: clock, thrown: "TradeRevertedError", signature: sigLabel(errSig), booking: "request" }
        : { atMs: clock, thrown: (err as Error).name, ...(typeof errSig === "string" && errSig.length > 0 ? { signature: sigLabel(errSig) } : {}), booking: "worker" }
    }
    return { answer, background, events }
  }
  const defaultRoute = async () => {
    const events: Event[] = []
    try {
      const s: string = await broadcastSignedSolanaTx(TX.b64, { onBroadcast: (x: string) => { events.push({ atMs: clock, event: "onBroadcast", signature: sigLabel(x) }) } })
      return { answer: { atMs: clock, after: "confirmation", landed: sigLabel(s), booking: "inline, before the answer" }, events }
    } catch (err) {
      return { answer: { atMs: clock, after: "confirmation", thrown: (err as Error).name }, events }
    }
  }
  const sendShape = (c: ReturnType<typeof rpc>) => ({
    sendsAtMs: c.at("sendRawTransaction"),
    firstSendPreflight: c.calls.find((x) => x.rpc === "sendRawTransaction")?.preflight ?? null,
    statusReads: c.at("getSignatureStatus").length,
    firstStatusReadAtMs: c.at("getSignatureStatus")[0] ?? null,
  })
  const viaRoute = async (id: string, wait: "sent" | "confirmed", args: Record<string, unknown>, plan: Plan, evidence?: string) => {
    const c = rpc(plan)
    __setSwapBroadcastInternalsForTest({ connection: c.conn })
    const r = await drive<Record<string, unknown>>(() => (wait === "sent" ? sentRoute() : defaultRoute()))
    __setSwapBroadcastInternalsForTest(null)
    assert.ok(r.ok, `${id}: the route stand-in threw`)
    const outcome = { ...r.value, ...sendShape(c) }
    record(id, "broadcast", { wait, ...args }, outcome, evidence)
    return outcome as any
  }
  const landsAt = (n: number, last: Status = "confirmed"): Status[] => [...Array.from({ length: n - 1 }, () => null), last]
  let o = await viaRoute("sent-answers-at-the-acknowledgement", "sent", { landsOnRead: 2 }, { status: landsAt(2) },
    "the 202 goes out when the RPC acknowledges the send, before the first status read; the booking runs once the confirm loop reads it landed")
  assert.deepEqual([o.answer.httpStatus, o.answer.atMs, o.firstStatusReadAtMs, o.background.atMs, o.background.booking], [202, 0, 250, 500, "request"])
  o = await viaRoute("confirmed-answers-after-the-confirmation", "confirmed", { landsOnRead: 2 }, { status: landsAt(2) },
    "the default waits for the confirm loop and books before it answers")
  assert.deepEqual([o.answer.atMs, o.answer.landed], [500, "<signature>"])
  o = await viaRoute("sent-no-resend-while-it-waits", "sent", { landsOnRead: 20 }, { status: landsAt(20) },
    "a sent caller's confirm never resends: the request has already answered and the worker holds the recorded signature")
  assert.deepEqual([o.sendsAtMs, o.background.atMs], [[0], 5000])
  o = await viaRoute("confirmed-resends-while-it-waits", "confirmed", { landsOnRead: 20 }, { status: landsAt(20) })
  assert.deepEqual(o.sendsAtMs, [0, 3250])
  o = await viaRoute("sent-landed-revert", "sent", { revertsOnRead: 2 }, { status: landsAt(2, { err: true }) },
    "acknowledged, then reverted on chain: the 202 already went out; the request's background booking fails the row TRADE_REVERTED with the signature")
  assert.deepEqual([o.answer.httpStatus, o.background.thrown, o.background.booking], [202, "TradeRevertedError", "request"])
  o = await viaRoute("sent-unconfirmed-left-to-the-worker", "sent", { hash: "dead at the first check" }, { status: [null], valid: [false] },
    "acknowledged, then unconfirmed: the 202 already went out; the request stops and the worker confirms the recorded signature")
  assert.deepEqual([o.answer.httpStatus, o.background.thrown, o.background.booking], [202, "TradeUnconfirmedError", "worker"])
  o = await viaRoute("sent-rpc-refused-the-send", "sent", { send: "refused" }, { status: [null], send: "refused" },
    "the RPC refused the bytes: no acknowledgement, no 202; SWAP_FAILED at stage unconfirmed keeps the reserved signature until the worker has chain proof")
  assert.deepEqual([o.answer.code, o.answer.stage, o.answer.message, o.events.length, o.statusReads], ["SWAP_FAILED", "unconfirmed", "rpc-refused", 0, 0])
  o = await viaRoute("sent-reply-lost", "sent", { send: "lost" }, { status: [null], send: "lost" },
    "the send threw after the bytes may have reached the node: no acknowledgement, SWAP_FAILED at stage unconfirmed")
  assert.deepEqual([o.answer.code, o.answer.message, o.background.booking], ["SWAP_FAILED", "unconfirmed", "worker"])
  o = await viaRoute("sent-rpc-named-another-signature", "sent", { send: "other-signature" }, { status: [null], send: "other-signature" },
    "the RPC answered a signature that is not the signed bytes' own: no acknowledgement, the bytes' own signature is recorded and the answer is unconfirmed")
  assert.deepEqual([o.answer.code, o.answer.message, o.events.map((e: Event) => e.event)], ["SWAP_FAILED", "unconfirmed", ["onBroadcast"]])

  // 2. The confirm loop with resend: false.
  {
    const loop = async (id: string, args: Record<string, unknown>, plan: Plan, opts: Record<string, unknown>) => {
      const c = rpc(plan)
      const r = await drive(() => confirmBroadcastTx(c.conn, TX.raw, TX.sig, undefined, opts))
      const outcome = { resendsAtMs: c.at("sendRawTransaction"), statusReads: c.at("getSignatureStatus").length, endedAtMs: r.at, result: r.ok ? "returned" : (r.error?.name ?? "Error") }
      record(id, "confirm", { ...args, options: opts }, outcome)
      return outcome
    }
    let l = await loop("confirm-resend-false-lands", { landsOnRead: 30 }, { status: landsAt(30) }, { fast: true, resend: false })
    assert.deepEqual([l.resendsAtMs, l.result], [[], "returned"])
    l = await loop("confirm-resend-false-budget", { lands: "never" }, { status: [null] }, { fast: true, resend: false })
    assert.deepEqual([l.resendsAtMs, l.endedAtMs, l.result], [[], 60_000, "LaunchConfirmationTimeoutError"])
    l = await loop("confirm-default-resends", { landsOnRead: 30 }, { status: landsAt(30) }, { fast: true })
    assert.deepEqual(l.resendsAtMs, [3250, 6500])
  }
  Date.now = realNow
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout

  // 3. The Solana wire checks (sign-hash.ts), run on real signed and tampered bytes.
  {
    const { solanaSignHash, solanaWireMatchesSignature, solanaUnsignedSignHash, solanaWireSignatureVerifies } = await load("apps/api/src/lib/sign-hash.ts")
    const stamped = solanaSignHash(TX.unsignedB64)
    secrets.push(stamped)
    const payerAddr = payer.publicKey.toBase58()
    const otherAddr = otherPayer.publicKey.toBase58()
    const okWire = {
      verifies: solanaWireSignatureVerifies(TX.raw, payerAddr),
      matchesSignature: solanaWireMatchesSignature(TX.raw, TX.sig),
      unsignedHashMatchesBuild: solanaUnsignedSignHash(TX.raw) === stamped,
    }
    assert.deepEqual(okWire, { verifies: true, matchesSignature: true, unsignedHashMatchesBuild: true })
    record("wire-signed-by-payer", "wire", { wire: "signed by linked payer" }, okWire,
      "a genuine signature by the linked payer verifies, matches the first slot, and hashes back to the stamped unsigned build")
    // Paste another transaction's signature into the first 64-byte slot of TX's message.
    const borrowed = Buffer.from(TX.raw)
    borrowed.set(OTHER.sigBytes, 1)
    const borrowedOutcome = {
      verifies: solanaWireSignatureVerifies(borrowed, payerAddr),
      matchesSlotSignature: solanaWireMatchesSignature(borrowed, OTHER.sig),
      unsignedHashMatchesBuild: solanaUnsignedSignHash(borrowed) === stamped,
      routeCode: "SIGNATURE_MISMATCH",
    }
    assert.deepEqual(borrowedOutcome, { verifies: false, matchesSlotSignature: true, unsignedHashMatchesBuild: true, routeCode: "SIGNATURE_MISMATCH" })
    record("wire-borrowed-signature", "wire", { wire: "another signature pasted onto the build's message" }, borrowedOutcome,
      "the unsigned hash still matches the build and the slot matches the pasted signature, so only ed25519 verification catches it before a pre-send write")
    const wrongPayer = { verifies: solanaWireSignatureVerifies(TX.raw, otherAddr), routeCode: "SIGNATURE_MISMATCH" }
    assert.equal(wrongPayer.verifies, false)
    record("wire-other-payer", "wire", { wire: "checked against another wallet" }, wrongPayer)
    const malformed = new Uint8Array([1, 2, 3])
    const badWire = { verifies: solanaWireSignatureVerifies(malformed, payerAddr), unsignedHash: solanaUnsignedSignHash(malformed) }
    assert.deepEqual(badWire, { verifies: false, unsignedHash: null })
    record("wire-malformed", "wire", { wire: "truncated bytes" }, badWire)
  }

  // 4. The pre-send fence, on Candle's own record rules.
  const policy = await load("packages/db/convex/lib/agentTradeExecutePolicy.ts")
  {
    const { hasBroadcastEvidence, recordBroadcastPatch, judgeSolanaSignature } = policy
    const { projectedDoc } = await load("apps/api/src/ledger/trading/trades/projection.ts")
    const built = { status: "built", chain: "solana", payerType: "linked", linkedWalletId: "<linked-wallet-id>", keyPrefix: "FIXTURE1", builtAt: 1_000 }
    const label = (p: any) => (p === null ? null : Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === "signature" ? sigLabel(v) : typeof v === "number" ? "<now>" : v])))
    /** reserveBackgroundBooking's own refusals before its binding check (outcomes.ts, pinned in section 7). */
    const reserveSees = (row: any) => (row.status !== "built" || row.chain !== "solana" || row.payerType !== "linked" || typeof row.linkedWalletId !== "string" || !row.keyPrefix || hasBroadcastEvidence(row) ? "in_flight" : "binding check next")
    const fence = (id: string, steps: Array<{ who: "sent" | "default"; signature: string }>, evidence: string) => {
      let row: any = { ...built }
      const out: any[] = []
      for (const s of steps) {
        if (s.who === "sent") {
          const seen = reserveSees(row)
          const patch = seen === "in_flight" ? null : recordBroadcastPatch(row, { signature: s.signature }, 2_000)
          out.push({ who: "wait:sent", signature: sigLabel(s.signature), reservation: patch ? "reserved" : "in_flight", patch: label(patch), sends: patch !== null })
          if (patch) row = { ...row, ...patch }
        } else {
          const patch = recordBroadcastPatch(row, { signature: s.signature }, 3_000)
          const stamped = patch !== null && patch.broadcastAt !== undefined
          out.push({ who: "wait:confirmed", signature: sigLabel(s.signature), presendStamped: stamped, patch: label(patch), sends: stamped })
          if (patch) row = { ...row, ...patch }
        }
      }
      const senders = out.filter((x) => x.sends).length
      assert.equal(senders, 1, `${id}: exactly one submit sends`)
      record(id, "fence", { steps: steps.map((s) => ({ who: s.who === "sent" ? "wait:sent" : "wait:confirmed", signature: sigLabel(s.signature) })) },
        { steps: out, senders, rowSignature: sigLabel(row.signature), otherBytesHeld: judgeSolanaSignature(row, OTHER.sig).ok === false }, evidence)
    }
    fence("fence-sent-then-default-same-bytes", [{ who: "sent", signature: TX.sig }, { who: "default", signature: TX.sig }], "the reservation stamped the signature and broadcastAt: the default submit of the same bytes stamps nothing and answers in flight")
    fence("fence-sent-then-default-other-bytes", [{ who: "sent", signature: TX.sig }, { who: "default", signature: OTHER.sig }], "other signed bytes for the same trade: the held signature refuses them, nothing is stamped or sent")
    fence("fence-default-then-sent", [{ who: "default", signature: TX.sig }, { who: "sent", signature: TX.sig }], "the default submit fenced first: the reservation sees broadcast evidence and answers in flight")
    fence("fence-sent-then-sent", [{ who: "sent", signature: TX.sig }, { who: "sent", signature: TX.sig }], "two sent submits: the second sees the first's evidence")
    for (const [id, change] of [
      ["reserve-refuses-main-payer", { payerType: "main" }],
      ["reserve-refuses-hood", { chain: "hood" }],
      ["reserve-refuses-settled-row", { status: "confirmed" }],
      ["reserve-refuses-no-linked-wallet", { linkedWalletId: null }],
    ] as const) record(id, "fence", { row: change }, { reservation: reserveSees({ ...built, ...change }) })
    const doc = { ...built, signature: TX.sig, broadcastAt: 2_000, backgroundBooking: true, deferredPlan: "x", _id: "id", _creationTime: 1 }
    const projected = projectedDoc(doc)
    record("projection-drops-background-booking", "fence", { fields: Object.keys(doc).sort() }, { projected: Object.keys(projected).sort(), keepsSignature: projected.signature === TX.sig },
      "the marker stays in Postgres: the compatibility projection to Convex never carries it")
  }

  // 5. The worker, against a stand-in database.
  {
    process.env.CONVEX_INTERNAL_KEY = INTERNAL
    const { runResolvePass, BACKGROUND_BOOKING_AFTER_MS, RESOLVE_AFTER_MS } = await load("apps/api/src/ledger/trading/trades/passes.ts")
    assert.equal(BACKGROUND_BOOKING_AFTER_MS, 15_000)
    assert.equal(RESOLVE_AFTER_MS, 30 * 60_000)
    const STARTED = new Date(EPOCH)
    type Trade = Record<string, unknown> & { id: string; state: string }
    /** A stand-in for the ledger's Postgres: the queries the pass makes, answered from `table`. */
    const standInSql = (table: Trade[]) => {
      const seen: { page?: unknown[]; docsWhere?: string; sync?: { name: string; detail: any }; other: string[] } = { other: [] }
      const tag = (strings: TemplateStringsArray | Record<string, unknown>, ...values: unknown[]): any => {
        if (!Array.isArray(strings)) return { __helper: strings }
        const q = (strings as unknown as string[]).join("?")
        if (/clock_timestamp\(\) as at/.test(q)) return Promise.resolve([{ at: STARTED }])
        if (/from worker_leases/.test(q)) return Promise.resolve([{ held: 1 }])
        if (/from trading\.intents t/.test(q) && /state = 'built'/.test(q)) {
          seen.page = values
          return Promise.resolve(table.map((t) => ({ id: t.id, at: new Date(Number(t.updatedAt)).toISOString() })))
        }
        if (/insert into sync_status/.test(q)) {
          const h = values.find((v: any) => v?.__helper) as any
          seen.sync = { name: h.__helper.name, detail: h.__helper.detail }
          return Promise.resolve([])
        }
        seen.other.push(q.replace(/\s+/g, " ").trim().slice(0, 60))
        if (/returning/.test(q)) return Promise.resolve([{ id: "1" }])
        return Promise.resolve([])
      }
      const sql: any = Object.assign(tag, {
        begin: async (cb: (tx: unknown) => unknown) => cb(sql),
        json: (v: unknown) => v,
        unsafe: async (statement: string, params: unknown[]) => {
          if (!/from trading\.intents t/.test(statement)) { seen.other.push(statement.replace(/\s+/g, " ").trim().slice(0, 60)); return [] }
          seen.docsWhere = /t\.state = 'built'/.test(statement) ? "state built" : "any state"
          return table.filter((t) => params.includes(t.id) && (seen.docsWhere === "any state" || t.state === "built"))
            .map((t) => ({ __id: t.id, __legacy: null, __extra: JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k]) => k !== "id" && k !== "state"))) }))
        },
      })
      return { sql, seen }
    }
    const trade = (id: string, ageMs: number, extra: Record<string, unknown> = {}): Trade => ({
      id, state: "built", status: "built", chain: "solana", payerType: "linked", linkedWalletId: "<linked-wallet-id>", keyPrefix: "FIXTURE1",
      userAddress: "<account>", clientTradeId: `wait-sent-${id}`, payerWallet: "<linked-wallet>", signature: TX.sig, broadcastAt: EPOCH - ageMs,
      backgroundBooking: true, createdAt: EPOCH - ageMs - 1_000, updatedAt: EPOCH - ageMs, builtAt: EPOCH - ageMs - 1_000, mint: "<mint>", side: "buy", ...extra,
    })
    const pass = async (id: string, args: Record<string, unknown>, table: Trade[], confirm: (t: any) => Promise<string>, verdict: (t: any) => any, background: boolean, evidence?: string) => {
      const { sql, seen } = standInSql(table)
      const confirmed: string[] = []
      const verdicts: string[] = []
      const counts = await runResolvePass({
        sql, env: { TRADING_STORE: "postgres" }, cursors: {}, lease: { name: "ledger-worker", holder: "fixture" }, stamp: { env: "fixture", written_by: "fixture" },
        pool: {}, log: { warn: () => {} },
        ledger: { verdict: async (t: any) => { verdicts.push(t.clientTradeId); return verdict(t) } },
        confirm: async (t: any) => { confirmed.push(t.clientTradeId); assert.equal(t.signature, TX.sig, "the worker confirms the recorded signature"); return confirm(t) },
        ...(background ? { backgroundBooking: true } : {}),
      })
      const outcome = {
        query: { backgroundBooking: seen.page?.[0], olderThanMs: seen.page?.[1] }, docsRecheck: seen.docsWhere ?? null,
        confirmCalls: confirmed.length, verdictReads: verdicts.length, counts, sync: seen.sync ? { name: seen.sync.name, leftByReason: seen.sync.detail.left_by_reason } : null,
      }
      record(id, "worker", { pass: background ? "trading-background-booking" : "trading-resolve", ...args }, outcome, evidence)
      return outcome
    }
    const unknown = () => ({ kind: "unknown", why: "payer_not_settled" })
    let w = await pass("worker-books-a-sent-trade", { confirm: "confirmed", ageMs: 20_000 }, [trade("1", 20_000)], async () => "confirmed", unknown, true,
      "the request never booked it (its process ended after the 202): the worker confirms the recorded signature and books it once")
    assert.deepEqual([w.query, w.counts.confirmed, w.verdictReads, w.sync?.name], [{ backgroundBooking: "true", olderThanMs: 15_000 }, 1, 0, "trading-background-booking"])
    w = await pass("worker-bound-revert", { confirm: "failed", ageMs: 20_000 }, [trade("2", 20_000)], async () => "failed", unknown, true,
      "the confirm bound a landed revert and failed the row TRADE_REVERTED with its signature")
    assert.equal(w.counts.failed, 1)
    w = await pass("worker-unseen-keeps-the-hold", { confirm: "unseen", ageMs: 20_000 }, [trade("3", 20_000)], async () => "unseen", unknown, true,
      "the RPC has not seen the transaction: left built with its signature and hold, never released on a missing read alone")
    assert.deepEqual([w.counts.left, w.sync?.leftByReason, w.verdictReads], [1, { unseen: 1 }, 0])
    w = await pass("worker-unseen-past-the-window-reads-the-ledger", { confirm: "unseen", ageMs: 31 * 60_000, verdict: "payer not settled" }, [trade("4", 31 * 60_000)], async () => "unseen", unknown, true,
      "past the 30-minute window an unseen trade falls to the ledger's own finality proof; unproven, it is still left")
    assert.deepEqual([w.verdictReads, w.sync?.leftByReason], [1, { payer_not_settled: 1 }])
    w = await pass("worker-unseen-but-finalized", { confirm: "unseen", ageMs: 31 * 60_000, verdict: "finalized" }, [trade("5", 31 * 60_000)], async () => "unseen", () => ({ kind: "finalized", success: true }), true)
    assert.deepEqual(w.sync?.leftByReason, { finalized_unseen: 1 })
    w = await pass("worker-confirm-refused", { confirm: "refused", ageMs: 20_000 }, [trade("6", 20_000)], async () => "refused", unknown, true)
    assert.deepEqual(w.sync?.leftByReason, { confirm_refused: 1 })
    w = await pass("worker-confirm-unavailable", { confirm: "throws (HTTP 5xx)", ageMs: 20_000 }, [trade("7", 20_000)], async () => { throw new Error("trade confirmation unavailable (HTTP 500)") }, unknown, true,
      "an unavailable confirm is an error for this run: the trade stays built for the next one")
    assert.deepEqual([w.counts.errors, w.counts.confirmed, w.counts.failed], [1, 0, 0])
    w = await pass("worker-skips-a-trade-the-request-booked", { requestBookedBetweenPageAndRead: true }, [{ ...trade("8", 20_000), state: "confirmed", status: "confirmed" }], async () => "confirmed", unknown, true,
      "the request booked it after the page was read: the document read re-checks state built, so the worker confirms nothing and books nothing twice")
    assert.deepEqual([w.docsRecheck, w.counts.candidates, w.confirmCalls], ["state built", 0, 0])
    w = await pass("resolve-pass-leaves-sent-trades", { ageMs: 31 * 60_000 }, [trade("9", 31 * 60_000, { backgroundBooking: undefined })], async () => "confirmed", () => ({ kind: "finalized", success: true }), false,
      "the ordinary pass asks only for rows without the marker, after 30 minutes, and reads the ledger before it confirms")
    assert.deepEqual([w.query, w.verdictReads, w.sync?.name], [{ backgroundBooking: "false", olderThanMs: 30 * 60_000 }, 1, "trading-resolve"])

    // The worker's confirm: the real routeResolveConfirm, its chain read a stand-in.
    process.env.SOLANA_RPC_URL = RPC
    const { routeResolveConfirm } = await load("apps/api/src/ledger/trading/trades/resolve-confirm.ts")
    const { __setFetchSolanaConfirmTxForTest, __setFetchSolanaRawTxForTest } = await load("apps/api/src/routes/trade-agent-confirm.ts")
    let reads = 0
    let wireReads = 0
    __setFetchSolanaConfirmTxForTest(async () => { reads++; return null })
    __setFetchSolanaRawTxForTest(async () => { wireReads++; return null })
    const resolveConfirm = routeResolveConfirm(standInSql([]).sql)
    for (const [id, t, evidence] of [
      ["resolve-confirm-unseen", trade("10", 20_000), "the chain read found no transaction: unseen, so the pass keeps the signature and the hold; a recovery reads nothing else before it finds one"],
      ["resolve-confirm-unseen-without-marker", trade("11", 31 * 60_000, { backgroundBooking: undefined }), "without the marker the same read is a plain refusal, left built"],
      ["resolve-confirm-hood", trade("12", 20_000, { chain: "hood" }), "only a linked Solana trade is confirmed here"],
      ["resolve-confirm-main-payer", trade("13", 20_000, { payerType: "main" }), undefined],
      ["resolve-confirm-no-signature", trade("14", 20_000, { signature: undefined }), undefined],
    ] as const) {
      const before = reads
      const wireBefore = wireReads
      const answer = await resolveConfirm(JSON.parse(JSON.stringify(t)))
      record(id, "worker-confirm", { chain: t.chain, payerType: t.payerType, backgroundBooking: t.backgroundBooking === true, signature: sigLabel(t.signature) }, { answer, chainReads: reads - before, wireReads: wireReads - wireBefore }, evidence)
    }
    __setFetchSolanaConfirmTxForTest(null)
    __setFetchSolanaRawTxForTest(null)
    delete process.env.SOLANA_RPC_URL
  }

  // 6. Concurrent background booking and worker recovery through the real confirmSolanaTrade.
  {
    const { failPatch, judgeSolanaCompleteSignatures, judgeSolanaSignature, recordBroadcastPatch } = policy
    const { solanaSignHash } = await load("apps/api/src/lib/sign-hash.ts")
    const { Hono } = await import(Bun.resolveSync("hono", join(checkout, "apps/api")))
    const TREASURY = Keypair.generate().publicKey.toBase58()
    const MINT = Keypair.generate().publicKey.toBase58()
    const PAYER_ADDR = payer.publicKey.toBase58()
    secrets.push(TREASURY, MINT)
    process.env.CONVEX_URL = "https://fake-convex.test"
    process.env.CONVEX_INTERNAL_KEY = INTERNAL
    process.env.SOLANA_RPC_URL = RPC
    process.env.AGENT_FEE_TREASURY_SOLANA = TREASURY
    const { confirmSolanaTrade, __setFetchSolanaConfirmTxForTest, __setFetchSolanaRawTxForTest } = await load("apps/api/src/routes/trade-agent-confirm.ts")
    const { __setAccrualDepsForTest } = await load("apps/api/src/services/referral/accrual.ts")
    const { __setKeyUsageDepsForTest } = await load("apps/api/src/services/agent-key-usage.ts")
    const { vendorNotFound } = await load("apps/api/src/testing/vendor-not-found.ts")

    const state = {
      row: null as any,
      claims: [] as Array<{ hash: string; refId: string }>,
      calls: [] as Array<{ path: string; args: Record<string, unknown> }>,
      bookings: [] as Array<{ clientTradeId: string; feeRaw?: string }>,
      usage: 0,
      accruals: [] as string[],
    }
    __setKeyUsageDepsForTest({ record: async () => { state.usage++ }, value: async () => 1_000_000 })
    __setAccrualDepsForTest({ record: async (args: any) => { state.accruals.push(String(args.rawAmountRaw)); return undefined }, value: async () => 1_000_000 })
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === RPC) return Response.json({ jsonrpc: "2.0", id: 1, result: null })
      if (!url.startsWith("https://fake-convex.test")) {
        const known = await vendorNotFound(url, init)
        if (known) return known
        return refuseFetch(input as never, init as never)
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; args?: Record<string, unknown>[] }
      const args = body.args?.[0] ?? {}
      const path = String(body.path)
      state.calls.push({ path, args })
      const ok = (value: unknown) => Response.json({ status: "success", value: value ?? null, logLines: [] })
      const r = state.row
      switch (path) {
        case "tokens:getByMint":
          return ok({ chain: "solana", decimals: 6, symbol: "TKN" })
        case "agentTrades:getByClientId":
          return ok(r)
        case "agentSignClaims:tradeBuildBinds":
          return ok(state.claims.some((c) => c.hash === args.hash && c.refId === args.clientTradeId))
        case "agentTrades:claimTradeFeeSignature": {
          const verdict = judgeSolanaSignature(r, args.feeTxHash as string)
          if (!verdict.ok) return ok({ ok: false, reason: verdict.reason, signature: verdict.held })
          r.feeSignature = args.feeTxHash
          return ok({ ok: true })
        }
        case "agentTrades:complete": {
          const verdict = judgeSolanaCompleteSignatures(r, { signature: args.signature as string, feeSignature: args.feeSignature as string | undefined })
          if (!verdict.ok) return ok({ ok: false, reason: "signature_held", signature: verdict.held })
          if (r.status === "failed") return ok({ ok: false, reason: "row_failed" })
          if (r.status === "confirmed") return ok({ ok: true, applied: false })
          state.bookings.push({ clientTradeId: r.clientTradeId, feeRaw: args.feeRaw as string | undefined })
          r.status = "confirmed"
          r.signature = args.signature
          if (args.feeSignature !== undefined) r.feeSignature = args.feeSignature
          if (args.feeRaw !== undefined && args.feeRaw !== r.feeRaw) r.feeCollectedRaw = args.feeRaw
          delete r.errorCode
          return ok({ ok: true })
        }
        case "agentTrades:recordBroadcast": {
          const patch = recordBroadcastPatch(r, { signature: args.signature as string | undefined, errorCode: args.errorCode as string | undefined }, EPOCH)
          if (patch) Object.assign(r, patch)
          return ok({ ok: true, recorded: args.signature !== undefined && r.signature === args.signature, signature: r.signature, stamped: patch?.broadcastAt !== undefined })
        }
        case "agentTrades:fail": {
          if (r.status === "confirmed") return ok({ recorded: false })
          if (args.signature !== undefined && !judgeSolanaSignature(r, args.signature as string).ok) return ok({ recorded: false })
          Object.assign(r, failPatch({ errorCode: args.errorCode as string, signature: args.signature as string | undefined }, EPOCH))
          return ok({ recorded: args.signature !== undefined && r.signature === args.signature })
        }
        default:
          return ok(null)
      }
    }) as unknown as typeof fetch

    const stampedTxHash = solanaSignHash(TX.unsignedB64)
    const stampedOtherHash = solanaSignHash(OTHER.unsignedB64)
    secrets.push(stampedOtherHash)
    const reset = (claimHashes = [stampedTxHash]) => {
      state.row = {
        userAddress: "fixture-account", clientTradeId: "race-1", requestHash: "req-1", chain: "solana", side: "buy",
        mint: MINT, quoteAsset: "sol", venue: "curve", amountRaw: "1000000", expectedOutRaw: "2000000", minOutRaw: "1900000",
        feeRaw: "10000", feeBps: 100, payerType: "linked", linkedWalletId: "linked-1", payerWallet: PAYER_ADDR,
        status: "built", signature: TX.sig, broadcastAt: EPOCH, keyPrefix: "FIXTURE1", builtAt: EPOCH, createdAt: EPOCH, updatedAt: EPOCH,
      }
      state.claims = claimHashes.map((hash) => ({ hash, refId: "race-1" }))
      state.calls = []
      state.bookings = []
      state.usage = 0
      state.accruals = []
    }
    const parsed = (opts: { err?: unknown; feeRaw?: number } = {}) => ({
      meta: {
        err: opts.err ?? null, fee: 5000,
        preBalances: [10_000_000, 0, 1_000_000], postBalances: [8_000_000, 0, 1_000_000 + (opts.feeRaw ?? 10_000)],
        preTokenBalances: [{ owner: PAYER_ADDR, mint: MINT, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ owner: PAYER_ADDR, mint: MINT, uiTokenAmount: { amount: "2500000" } }],
      },
      transaction: {
        message: {
          accountKeys: [{ pubkey: PAYER_ADDR, signer: true }, { pubkey: MINT, signer: false }, { pubkey: TREASURY, signer: false }],
          instructions: [{ program: "system", parsed: { type: "transfer", info: { source: PAYER_ADDR, destination: TREASURY, lamports: opts.feeRaw ?? 10_000 } } }],
        },
      },
    })
    const confirmAs = async (caller: "api" | "worker", snapshot: any, onUnseen: () => void = () => {}) => {
      const app = new Hono()
      app.post("/", (c: any) => confirmSolanaTrade(c, {
        agentCtx: { userAddress: "fixture-account", keyPrefix: "FIXTURE1" }, internalKey: INTERNAL,
        clientTradeId: snapshot.clientTradeId, signature: TX.sig, row: { ...snapshot }, payerWallet: PAYER_ADDR,
        ...(caller === "api" ? { submittedWire: TX.raw, backgroundBooking: {} } : { backgroundBooking: { onUnseen } }),
      }))
      const res = await app.request("/", { method: "POST" })
      return { status: res.status, body: (await res.json()) as Record<string, any> }
    }
    const settleEffects = async () => {
      await new Promise((r) => realSetTimeout(r, 15))
      return {
        usage: state.usage,
        webhooks: state.calls.filter((c) => c.path === "webhooks:enqueue" && c.args.event === "trade.executed").length,
        accruals: state.accruals.length,
        accrualFeeRaw: state.accruals[0] ?? null,
      }
    }

    for (const first of ["api", "worker"] as const) {
      const second = first === "api" ? "worker" : "api"
      reset()
      const snapshot = { ...state.row }
      const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      let n = 0
      __setFetchSolanaConfirmTxForTest(async () => {
        const i = n++
        entered[i]?.resolve()
        await gates[i]?.promise
        return parsed()
      })
      __setFetchSolanaRawTxForTest(async () => TX.raw)
      const p1 = confirmAs(first, snapshot)
      await entered[0]!.promise
      const p2 = confirmAs(second, snapshot)
      await entered[1]!.promise
      gates[0]!.resolve()
      const winner = await p1
      gates[1]!.resolve()
      const loser = await p2
      const effects = await settleEffects()
      const completes = state.calls.filter((c) => c.path === "agentTrades:complete").length
      const outcome = {
        winnerStatus: winner.status,
        loserStatus: loser.status,
        loserBodyStatus: loser.body.status,
        completeCalls: completes,
        bookings: state.bookings,
        zeroDoubleBooking: state.bookings.length === 1,
        zeroLostFees: state.bookings[0]?.feeRaw === "10000" && state.row.feeCollectedRaw === undefined,
        rowStatus: state.row.status,
        feeSignatureHeld: state.row.feeSignature === TX.sig,
        effects,
      }
      assert.deepEqual([outcome.winnerStatus, outcome.loserStatus, outcome.completeCalls, outcome.zeroDoubleBooking, outcome.zeroLostFees], [200, 200, 2, true, true])
      assert.deepEqual(effects, { usage: 1, webhooks: 1, accruals: 1, accrualFeeRaw: "10000" })
      record(`booking-race-${first}-then-${second}`, "booking", { first, second, feeRaw: "10000" }, outcome,
        `both callers read the landed transaction before either booked; ${first} booked first, ${second} saw applied false, and the trade and its fee were booked once`)
    }

    // Unseen on the worker's first look, then booked by the API, then retried by a stale worker snapshot.
    {
      reset()
      const stale = { ...state.row }
      __setFetchSolanaConfirmTxForTest(async () => null)
      __setFetchSolanaRawTxForTest(async () => TX.raw)
      let unseen = 0
      const early = await confirmAs("worker", stale, () => { unseen++ })
      const earlyRowStatus = state.row.status
      __setFetchSolanaConfirmTxForTest(async () => parsed())
      const booked = await confirmAs("api", stale)
      const retry = await confirmAs("worker", stale, () => { unseen++ })
      const effects = await settleEffects()
      const outcome = {
        early: { status: early.status, code: early.body.error?.code, retryable: early.body.error?.retryable, unseen, rowStatus: earlyRowStatus },
        apiStatus: booked.status,
        staleWorkerRetryStatus: retry.status,
        bookings: state.bookings,
        effects,
      }
      assert.deepEqual([early.status, early.body.error?.code, unseen, booked.status, retry.status, state.bookings.length], [400, "VALIDATION_FAILED", 1, 200, 200, 1])
      record("booking-unseen-then-api-then-stale-worker", "booking", { sequence: ["worker unseen", "api books", "stale worker retries"] }, outcome,
        "an unseen read leaves the reservation untouched; after the API books, a stale worker snapshot adds no second booking or side effect")
    }

    // Bound landed revert: failed once as TRADE_REVERTED with its signature, zero bookings.
    {
      reset()
      const snapshot = { ...state.row }
      __setFetchSolanaConfirmTxForTest(async () => parsed({ err: { InstructionError: [0, { Custom: 1 }] }, feeRaw: 0 }))
      __setFetchSolanaRawTxForTest(async () => TX.raw)
      const apiRes = await confirmAs("api", snapshot)
      const workerRes = await confirmAs("worker", { ...state.row })
      const effects = await settleEffects()
      const outcome = {
        api: { status: apiRes.status, code: apiRes.body.error?.code, stage: apiRes.body.error?.stage, recorded: apiRes.body.error?.recorded === true },
        workerAfterFailStatus: workerRes.status,
        row: { status: state.row.status, errorCode: state.row.errorCode, signatureKept: state.row.signature === TX.sig },
        bookings: state.bookings.length,
        effects,
      }
      assert.deepEqual([state.row.status, state.row.errorCode, state.bookings.length, effects.usage], ["failed", "TRADE_REVERTED", 0, 0])
      record("booking-bound-revert", "booking", { landed: "InstructionError" }, outcome,
        "a bound landed revert settles the row as failed with TRADE_REVERTED and its signature, with zero bookings")
    }

    // Unbound submitted wire on background confirm: 500 SWAP_FAILED retryable, nothing booked.
    {
      reset([stampedOtherHash])
      __setFetchSolanaConfirmTxForTest(async () => parsed())
      __setFetchSolanaRawTxForTest(async () => TX.raw)
      const res = await confirmAs("api", { ...state.row })
      const effects = await settleEffects()
      const outcome = {
        status: res.status,
        code: res.body.error?.code,
        retryable: res.body.error?.retryable,
        rowStatus: state.row.status,
        bookings: state.bookings.length,
        effects,
      }
      assert.deepEqual([res.status, res.body.error?.code, res.body.error?.retryable, state.row.status, state.bookings.length], [500, "SWAP_FAILED", true, "built", 0])
      record("booking-unbound-wire-retries", "booking", { wire: "does not match the row's stamped claim" }, outcome,
        "a background confirm whose binding proof cannot be matched answers 500 SWAP_FAILED retryable and books nothing")
    }

    await new Promise((r) => realSetTimeout(r, 30))
    __setFetchSolanaConfirmTxForTest(null)
    __setFetchSolanaRawTxForTest(null)
    __setKeyUsageDepsForTest(null)
    __setAccrualDepsForTest(null)
    delete process.env.CONVEX_URL
    delete process.env.SOLANA_RPC_URL
    delete process.env.AGENT_FEE_TREASURY_SOLANA
    globalThis.fetch = refuseFetch
  }

  // 7. The submit route, pinned as source text.
  const route = text("apps/api/src/routes/trade-agent.ts")
  const pin = (id: string, file: string, pattern: RegExp, outcome: Record<string, unknown> = {}, evidence?: string) => {
    const found = pattern.test(text(file))
    assert.ok(found, `${id} (${file})`)
    record(id, "route", { file }, { found, ...outcome }, evidence)
  }
  /** The code, retryable and stage an answer helper returns (trade-agent.ts errorResponse). */
  const helper = (name: string) => {
    const m = new RegExp(`function ${name}\\([^)]*\\)[^\\n]*\\{\\s*return errorResponse\\(\\s*"([A-Z_]+)",[\\s\\S]{0,400}?,\\s*(true|false),\\s*\\{\\s*stage: "([a-z_]+)"(?:,\\s*reason: "([a-z_]+)")?`).exec(route)
    assert.ok(m, `${name} moved`)
    return { code: m[1], retryable: m[2] === "true", stage: m[3], ...(m[4] ? { reason: m[4] } : {}) }
  }
  pin("route-wait-values", FILES[0]!, /if \(wait !== undefined && wait !== "confirmed" && wait !== "sent"\) \{\s*return fail\(c, "VALIDATION_FAILED", 'wait must be "confirmed" or "sent"', \{ field: "wait" \}\)/,
    { code: "VALIDATION_FAILED", field: "wait", values: ["confirmed", "sent"], default: "confirmed" }, "any other wait value is refused before the row is read")
  pin("route-sent-refuses-a-sequenced-hood-leg", FILES[0]!, /if \(body\.operationId !== undefined \|\| body\.signedTransaction !== undefined\) \{\s*if \(wait === "sent"\) return sentOnlySolana\(c\)/,
    { code: "VALIDATION_FAILED", field: "wait" })
  pin("route-sent-refuses-a-non-linked-or-hood-row", FILES[0]!, /if \(waitForSend && \(row\.chain !== "solana" \|\| row\.payerType !== "linked"\)\) \{\s*return \{ ok: false, response: sentOnlySolana\(c\) \}/,
    { code: "VALIDATION_FAILED", field: "wait", message: 'wait: "sent" requires a linked Solana trade' }, "an embedded (main) payer or a Hood trade: refused at the gate, nothing sent")
  assert.ok(/function sentOnlySolana\(c[^)]*\) \{\s*return fail\(c, "VALIDATION_FAILED", 'wait: "sent" requires a linked Solana trade', \{ field: "wait" \}\)/.test(route), "sentOnlySolana moved")
  {
    const at = (s: string, from = 0) => { const i = route.indexOf(s, from); assert.ok(i >= 0, `missing ${s}`); return i }
    // Inside submitSignedTrade's Solana branch, in this order: the wire check, the sent branch, the default fence, the default send.
    const body = at("export async function submitSignedTrade(")
    const signatureCheck = at("if (!solanaWireSignatureVerifies(submittedWire, payerWallet)) {", body)
    const sentBranch = at("return submitSolanaUntilSent(", body)
    const defaultPresend = at("const recorded = await recordSolanaBeforeSend(ledger, presendSignature, clientTradeId)", body)
    const defaultSend = at("signature = await broadcastSignedSolanaTx(signedTransaction, {", body)
    assert.ok(signatureCheck < sentBranch && sentBranch < defaultPresend && defaultPresend < defaultSend, "the wire check runs before either pre-send write")
    const fn = route.slice(at("async function submitSolanaUntilSent("))
    const inner = { reserve: fn.indexOf("reservation = await reserveBackgroundBooking("), send: fn.indexOf("const confirmation = broadcastSignedSolanaTx(signedTransaction, {") }
    assert.ok(inner.reserve > 0 && inner.reserve < inner.send, "the reservation precedes the send")
    assert.ok(/"SIGNATURE_MISMATCH",[\s\S]{0,400}?\{ retryable: false, field: "signedTransactions" \}/.test(route), "the wire check's answer moved")
    record("route-order", "route", { file: FILES[0] }, {
      found: true, order: ["SIGNATURE_MISMATCH check", "wait:sent: reserveBackgroundBooking, then the send", "wait:confirmed: recordSolanaBeforeSend, then the send"],
      signatureMismatch: { code: "SIGNATURE_MISMATCH", retryable: false, field: "signedTransactions" },
    }, "a borrowed signature is refused before either pre-send write, so it is never stamped on the row and never sent")
  }
  const inFlight = helper("tradeAlreadyInFlight")
  const unavailable = helper("tradeRecordUnavailable")
  pin("route-reservation-answers", FILES[0]!, /\} catch \(err\) \{\s*logErrorRedacted\(`\[TradeAgent\] could not reserve booking[\s\S]{0,80}?const result = tradeRecordUnavailable\(\)[\s\S]{0,120}?if \(reservation === "unbound"\) \{\s*return fail\(c, "UNRECOGNIZED_TRANSACTION", "The signed transaction does not match this trade build"\)\s*\}\s*if \(reservation !== "reserved"\) \{\s*const result = tradeAlreadyInFlight\(\)/,
    { failed: unavailable, unbound: { code: "UNRECOGNIZED_TRANSACTION" }, in_flight: inFlight }, "the reservation could not be written: nothing sent; the bytes are not this build's: nothing sent; another attempt holds the row: nothing sent")
  pin("route-default-fence", FILES[0]!, /if \(!recorded\.send\) return c\.json[\s\S]{0,120}?if \(!recorded\.record\) \{[\s\S]{0,160}?const result = tradeAlreadyInFlight\(\)/,
    { in_flight: inFlight }, "the default submit's own pre-send record: one that stamps nothing answers in flight and sends nothing")
  pin("route-sent-answer", FILES[0]!, /const accepted = await Promise\.race\(\[sent\.promise, confirmation\]\)[\s\S]{0,900}?return c\.json\(\{ success: true, status: "broadcast", chain: "solana", clientTradeId, signature: accepted \}, 202\)/,
    { httpStatus: 202, body: ["success", "status", "chain", "clientTradeId", "signature"] }, "the same race section 1 drives")
  pin("route-sent-background-booking", FILES[0]!, /if \(!\(err instanceof TradeRevertedError\)\) \{\s*logErrorRedacted\(`\[TradeAgent\] confirmation deferred to worker[\s\S]{0,80}?return\s*\}\s*\}\s*if \(tradingStore\(\) === "postgres"\) \{\s*await confirmSolanaTrade\(c, \{ \.\.\.args, signature: accepted, submittedWire, backgroundBooking: \{\} \}\)/,
    { books: ["landed", "TradeRevertedError"], defersToWorker: "any other confirm error", store: "postgres" })
  pin("route-sent-failure-answer", FILES[0]!, /"SWAP_FAILED",\s*isSolanaSendRefusal\(err\)\s*\?\s*"The RPC refused this submit\. Candle will reconcile the recorded signature; check the trade job before retrying\."\s*:\s*TRADE_UNCONFIRMED_MESSAGE,\s*false,\s*\{ stage: "unconfirmed", signature \},/,
    { code: "SWAP_FAILED", stage: "unconfirmed", retryable: false, carries: "signature" }, "even a refused send keeps the reserved signature: another caller may hold the same bytes")
  pin("broadcast-acknowledges-before-the-confirm", "apps/api/src/services/candle/trade-broadcast.ts", /opts\?\.onSent\?\.\(sig\)\s*return confirmSent\(sig, opts\?\.onSent \? \{ resend: false \} : undefined\)/)
  pin("confirm-resend-false", "apps/api/src/services/candle/launch-confirm.ts", /if \(opts\.resend !== false && Date\.now\(\) - lastResend > 3000\) \{/)
  pin("reserve-checks", "apps/api/src/ledger/trading/trades/outcomes.ts", /trade\.doc\.status !== "built" \|\|\s*trade\.doc\.chain !== "solana" \|\|\s*trade\.doc\.payerType !== "linked" \|\|\s*typeof trade\.doc\.linkedWalletId !== "string" \|\|\s*!trade\.doc\.keyPrefix \|\|\s*trade\.doc\.builtAt !== args\.builtAt \|\|\s*hasBroadcastEvidence\(trade\.doc\)\s*\)\s*return "in_flight"\s*if \(!\(await tradeBuildBinds\(tx\.sql, \{ \.\.\.args, linkedWalletId: trade\.doc\.linkedWalletId \}\)\)\) return "unbound"\s*const result = await recordBroadcastInTx\(tx, trade, \{ signature: args\.signature, backgroundBooking: true \}\)\s*return result\.recorded && result\.stamped \? "reserved" : "in_flight"/,
    { answers: ["reserved", "in_flight", "unbound"] }, "one row lock: the build the route checked, no broadcast evidence, the signed bytes bound to this build's sign claim, then the signature and broadcastAt stamped with the marker")
  pin("binding-names-the-build", "apps/api/src/ledger/trading/trades/sign-claims.ts", /\(args\.builtAt === undefined \|\| doc\.builtAt === args\.builtAt\)/)
  pin("worker-confirm-binds-or-retries", "apps/api/src/routes/trade-agent-confirm.ts", /if \(backgroundBooking && binding !== "bound"\) \{\s*return fail\(c, "SWAP_FAILED", "Could not verify the submitted trade's build binding", \{ retryable: true \}\)/,
    { code: "SWAP_FAILED", retryable: true }, "a background booking that cannot read its binding proof retries; it never books unbound bytes")
  pin("worker-confirm-unseen", "apps/api/src/routes/trade-agent-confirm.ts", /if \(!tx\) \{\s*backgroundBooking\?\.onUnseen\?\.\(\)\s*return fail\(c, "VALIDATION_FAILED", "Transaction not found; it may not have confirmed yet", \{ retryable: true \}\)/,
    { code: "VALIDATION_FAILED", retryable: true })
  pin("worker-not-landed-needs-the-ledger", "apps/api/src/ledger/trading/trades/passes.ts", /if \(verdict\.kind === "not_landed" && trade\.signature\) \{\s*const \{ failed \} = await failNotLanded\(/,
    {}, "only the ledger's not-landed proof (payer watched and settled past the window) fails a signed trade and releases its hold")
  pin("worker-interval", "apps/api/src/ledger/trading/trades/passes.ts", /const BACKGROUND_BOOKING_EVERY_MS = 15_000\s*const BACKGROUND_BOOKING_SYNC_NAME = "trading-background-booking"/, { everyMs: 15_000, syncName: "trading-background-booking" })

  // 8. The agent API description.
  {
    const { AGENT_OPENAPI } = await load("apps/api/src/openapi/agent-api.ts")
    const submit = AGENT_OPENAPI.paths["/api/v1/trade/agent/submit"].post
    const schemas = AGENT_OPENAPI.components.schemas
    record("openapi-submit", "openapi", { path: "/api/v1/trade/agent/submit" }, {
      responses: Object.keys(submit.responses).filter((k) => /^\d+$/.test(k)).sort(),
      accepted: { description: submit.responses[202].description, schema: submit.responses[202].content["application/json"].schema.$ref },
      wait: schemas.TradeSubmitRequest.properties.wait,
      broadcast: { required: schemas.TradeBroadcast.required, properties: Object.fromEntries(Object.entries(schemas.TradeBroadcast.properties as Record<string, any>).map(([k, v]) => [k, v.const ?? v.type])) },
    })
  }

  // 9. The SDK.
  {
    const { CandleClient, SDK_VERSION } = await load("packages/sdk/src/client.ts")
    const { InMemorySecretStore } = await load("packages/sdk/src/secret-store.ts")
    const { generateSignerKeypair } = await load("packages/sdk/src/wallet-import.ts")
    assert.equal(SDK_VERSION, source.versions.sdk)
    type Call = { method: string; path: string; body?: Record<string, unknown> }
    const server = (answer: (c: Call, n: number) => Response) => {
      const calls: Call[] = []
      const impl = (async (input: unknown, init?: RequestInit) => {
        const u = new URL(String(input))
        const c: Call = { method: init?.method ?? "GET", path: u.pathname, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) }
        calls.push(c)
        return answer(c, calls.length)
      }) as unknown as typeof fetch
      return { calls, impl }
    }
    const json = (status: number, body: unknown) => Response.json(body, { status })
    const BROADCAST = { success: true, status: "broadcast", chain: "solana", clientTradeId: "sdk-sent-1", signature: "<signature>" }
    const shown = (calls: Call[]) => calls.map((c) => ({ method: c.method, path: c.path, ...(c.body ? { body: Object.fromEntries(Object.entries(c.body).map(([k, v]) => [k, k === "signedTransactions" ? ["<signed>"] : k === "authorizationSignature" ? "<authorization-signature>" : v])) } : {}) }))
    const run = async (id: string, args: Record<string, unknown>, s: ReturnType<typeof server>, call: () => Promise<unknown>, evidence?: string) => {
      let outcome: Record<string, unknown>
      try { outcome = { returned: await call() } } catch (e) { outcome = { threw: (e as Error).name, message: (e as Error).message, ...((e as any).code ? { code: (e as any).code } : {}) } }
      record(id, "sdk", args, { ...outcome, requests: shown(s.calls) }, evidence)
      return { ...outcome, calls: s.calls } as any
    }
    {
      const s = server(() => json(202, BROADCAST))
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl })
      const r = await run("sdk-submit-sent", { method: "submit", wait: "sent" }, s, () => c.submit({ clientTradeId: "sdk-sent-1", signedTransactions: ["<signed>"], wait: "sent" }), "HTTP 202 is the BroadcastTradeResult, signature and trade id included")
      assert.deepEqual(r.returned, BROADCAST)
    }
    {
      const s = server(() => json(200, { success: true, status: "executed", clientTradeId: "sdk-default-1", chain: "solana", signature: "<signature>" }))
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl })
      const r = await run("sdk-submit-default", { method: "submit" }, s, () => c.submit({ clientTradeId: "sdk-default-1", signedTransactions: ["<signed>"] }), "no wait field is sent: the API's default, confirmed")
      assert.equal(r.calls[0].body.wait, undefined)
    }
    {
      const s = server(() => json(400, { success: false, error: { code: "VALIDATION_FAILED", message: 'wait: "sent" requires a linked Solana trade', retryable: false, field: "wait" } }))
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl })
      const r = await run("sdk-submit-sent-refused", { method: "submit", wait: "sent", api: "VALIDATION_FAILED on field wait" }, s, () => c.submit({ clientTradeId: "sdk-sent-2", signedTransactions: ["<signed>"], wait: "sent" }), "the API's refusal of a main payer or Hood row reaches the caller as a CandleApiError with its code")
      assert.equal(r.code, "VALIDATION_FAILED")
    }
    for (const [id, call] of [
      ["sdk-submit-invalid-wait", (c: any) => c.submit({ clientTradeId: "x", signedTransactions: ["<signed>"], wait: "landed" })],
      ["sdk-trade-invalid-wait", (c: any) => c.trade({ mint: "<mint>", side: "buy", amountRaw: "1", from: { linkedWalletId: "w", privyWalletId: "p" }, wait: "soon" })],
      ["sdk-trade-sent-main-payer", (c: any) => c.trade({ mint: "<mint>", side: "buy", amountRaw: "1", from: "main", wait: "sent" })],
      ["sdk-trade-sent-hood-token", (c: any) => c.trade({ mint: "0xabc", side: "buy", amountRaw: "1", from: { linkedWalletId: "w", privyWalletId: "p" }, wait: "sent" })],
    ] as const) {
      const s = server(() => { throw new Error("no request expected") })
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl })
      const r = await run(id, { method: id.includes("submit") ? "submit" : "trade" }, s, () => call(c), "thrown before any request")
      assert.ok(r.threw && r.calls.length === 0, `${id}: ${JSON.stringify(r)}`)
    }
    {
      const store = new InMemorySecretStore()
      const { privateKeyPem } = await generateSignerKeypair()
      await store.set("wallet-1", privateKeyPem)
      const s = server((c) => {
        if (c.path.endsWith("/trade/agent/build")) return json(200, { success: true, status: "built", clientTradeId: String(c.body?.clientTradeId), chain: "solana", walletAddress: "<linked-wallet>", artifacts: { venue: "curve", transactionBase64: "AQADunsigned", quoteAsset: "sol", quoteDecimals: 9 }, fee: { bps: 100, feeRaw: "2000", treasury: "<treasury>" }, expectedOutRaw: "500000", minOutRaw: "495000", expiresAt: 1692345678000 })
        if (c.path.endsWith("/sign")) return json(200, { success: true, signedTransaction: "c2lnbmVk", encoding: "base64" })
        if (c.path.endsWith("/trade/agent/submit")) return json(202, { ...BROADCAST, clientTradeId: "sdk-trade-sent" })
        throw new Error(`unrouted ${c.path}`)
      })
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl, secretStore: store, privyAppId: "app-fixture", solanaRpcUrl: RPC })
      const r = await run("sdk-trade-sent-linked", { method: "trade", wait: "sent", from: "linked Solana wallet" }, s,
        () => c.trade({ mint: "<mint>", side: "buy", amountRaw: "500000", from: { linkedWalletId: "wallet-1", privyWalletId: "privy-1" }, wait: "sent", clientTradeId: "sdk-trade-sent" }),
        "build, the relay's sign, then submit with wait sent: the broadcast result comes back as it is")
      assert.equal(r.returned?.status, "broadcast", JSON.stringify(r))
      assert.equal(r.calls.at(-1).body.wait, "sent")
    }
    for (const [id, final] of [["sdk-wait-for-trade-confirmed", "confirmed"], ["sdk-wait-for-trade-failed", "failed"]] as const) {
      const job = (status: string) => ({ clientTradeId: "sdk-sent-1", status, chain: "solana", signature: "<signature>", ...(status === "failed" ? { errorCode: "TRADE_REVERTED" } : {}) })
      const s = server((_c, n) => json(200, { success: true, job: job(n < 3 ? "built" : final) }))
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl })
      const r = await run(id, { method: "waitForTrade", pollMs: 1 }, s, () => c.waitForTrade("sdk-sent-1", { pollMs: 1 }), "polls the trade job, reads only, until it is confirmed (booked) or failed")
      assert.equal(r.returned.status, final)
      assert.ok(r.calls.every((x: Call) => x.method === "GET"))
    }
    {
      const s = server(() => json(200, { success: true, job: { clientTradeId: "sdk-sent-1", status: "built", chain: "solana", signature: "<signature>" } }))
      const c = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: s.impl })
      const r = await run("sdk-wait-for-trade-timeout", { method: "waitForTrade", timeoutMs: 5, pollMs: 1 }, s, () => c.waitForTrade("sdk-sent-1", { timeoutMs: 5, pollMs: 1 }), "a timeout throws and leaves the trade running on the server")
      assert.ok(r.threw)
      // How many reads fit in 5 ms is the machine's: the row keeps the first.
      const last = rows.at(-1)!
      last.outcome.requests = (last.outcome.requests as unknown[]).slice(0, 1)
      last.outcome.message = String(last.outcome.message).replace(/\(last status: \w+\)/, "(last status: built)")
    }
  }

  // 10. The CLI.
  {
    const { run } = await load("packages/cli/src/index.ts")
    const { CLI_VERSION } = await load("packages/cli/src/version.ts")
    const { createCapture, createTestDeps, createFakeStore } = await load("packages/cli/src/test-support.ts")
    const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")
    const { swapScenario, scenarioRpcResult } = await load("packages/cli/src/solana-verify.fixtures.ts")
    const { BASES } = await load("packages/cli/src/trading.ts")
    assert.equal(CLI_VERSION, source.versions.cli)
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const MINT = Keypair.generate().publicKey.toBase58()
    const TEE = Keypair.generate().publicKey.toBase58()
    const EMBEDDED = Keypair.generate().publicKey.toBase58()
    secrets.push(MINT, TEE, EMBEDDED)
    const SIGNATURE = TX.sig
    const asset = (a: string) => (a === "SOL" ? "SOL" : (BASES[a]?.mint ?? a))
    const runCli = async (argv: string[], opts: { job?: Record<string, unknown> } = {}) => {
      const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
      const state = { built: false, scenario: undefined as any }
      const fetcher = async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        const path = url.pathname
        if (!body?.method) requests.push({ method: init?.method ?? "GET", path: path.replace(/\/jobs\/[^/]+$/, "/jobs/<id>"), ...(path.endsWith("/submit") ? { body: { ...body, signedTransactions: ["<signed>"] } } : {}) })
        const ok = (value: unknown, status = 200) => Response.json(value, { status })
        if (path.includes("/trade/agent/jobs/") && opts.job) return ok({ success: true, job: opts.job })
        if (path.includes("/jobs/")) return state.built ? ok({ success: true, job: { status: "built" } }) : ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
        if (path === "/api/v1/agent/wallets/trading") return ok({ scopes: ["swap:write"], privyAppId: "app", page: [{ id: "wallet", address: TEE, label: "tee", chain: "solana", active: true, allowLaunch: true, privyWalletId: "privy" }], isDone: true })
        if (path === "/api/v1/agent/wallets/embedded") return ok({ success: true, wallets: { solana: { address: EMBEDDED }, evm: null }, embeddedWalletPermission: "allowed" })
        if (path === "/api/v1/agent/keys/self/limits") return ok({ success: true, keyLimits: null })
        if (path === "/api/v1/trade/agent/execute") return state.built ? ok({ success: true, status: "executed", signature: SIGNATURE }) : ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
        if (path.endsWith("/build")) {
          state.built = true
          const main = body?.payer?.type === "main"
          const quote: Record<string, unknown> = { status: "built", swapId: "server-swap", recipient: main ? EMBEDDED : TEE, minOutRaw: "123456", fee: { bps: 50, feeRaw: "5000" }, expiresAt: 10000, venue: "jupiter", priceImpactPct: "0.1", tokenRisks: [], transactionsBase64: ["unsigned"] }
          if (!main) {
            state.scenario = swapScenario({ wallet: TEE, spend: asset(String(body.from ?? "SOL")), spendRaw: BigInt(body.amountRaw), receive: asset(String(body.to ?? MINT)), receiveRaw: BigInt(String(quote.minOutRaw)) })
            quote.transactionsBase64 = [state.scenario.transaction]
          }
          return path.includes("trade/agent")
            ? ok({ ...quote, chain: "solana", walletAddress: main ? EMBEDDED : TEE, artifacts: { ...quote, quoteAsset: body.quoteAsset, transactionBase64: (quote.transactionsBase64 as string[])[0] } })
            : ok({ success: true, payload: quote })
        }
        if (path.endsWith("/sign")) return ok({ signedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 5), Buffer.alloc(40)]).toString("base64"), encoding: "base64" })
        if (path === "/api/v1/trade/agent/submit" && body?.wait === "sent") return ok({ success: true, status: "broadcast", chain: "solana", clientTradeId: body.clientTradeId, signature: SIGNATURE }, 202)
        if (path.endsWith("/submit") || path.endsWith("/confirm")) return ok({ success: true, status: "executed", signature: SIGNATURE })
        if (url.host.startsWith("rpc.")) {
          const read = state.scenario && scenarioRpcResult(state.scenario, body.method, body.params)
          if (read !== undefined) return ok({ jsonrpc: "2.0", id: 1, result: read })
          const result = body.method === "getTokenSupply" ? { value: { decimals: 6 } }
            : body.method === "getTokenAccountsByOwner" ? { value: [{ pubkey: "ata", account: { owner: body.params[1].programId, data: { parsed: { info: { mint: MINT, tokenAmount: { amount: "1000000", decimals: 6 }, state: "initialized" } } } } }] }
            : body.method === "getBalance" ? { value: 2_000_000_000 } : SIGNATURE
          return ok({ jsonrpc: "2.0", id: 1, result })
        }
        throw new Error(`unexpected request ${url.host}${path}`)
      }
      const stdout = createCapture(), stderr = createCapture()
      const deps = createTestDeps({
        fetch: fetcher, stdout, stderr, promptLine: async () => "y",
        env: { CANDLE_CONFIG_DIR: dir("cli"), CANDLE_API_KEY: KEY, CANDLE_API_URL: API, CANDLE_SOLANA_RPC_URL: RPC },
        store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
      })
      const exitCode: number = await run(argv, deps)
      let out: any
      try { out = JSON.parse(stdout.text) } catch { out = undefined }
      return { exitCode, requests, out, shown: stdout.text + stderr.text }
    }
    const HOOD_TOKEN = "0x1111111111111111111111111111111111111111"
    const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).replaceAll(SIGNATURE, "<signature>").replaceAll(MINT, "<mint>").replaceAll(TEE, "<tee>").replaceAll(EMBEDDED, "<embedded>").replaceAll(HOOD_TOKEN, "<hood-token>"))
    const cli = async (id: string, argv: readonly string[], evidence: string, opts: { job?: Record<string, unknown> } = {}) => {
      const r = await runCli(argv.map((a) => (a === "<mint>" ? MINT : a === "<embedded>" ? EMBEDDED : a === "<hood-token>" ? HOOD_TOKEN : a)), opts)
      const submits = r.requests.filter((q) => q.path.endsWith("/submit"))
      const outcome = {
        exitCode: r.exitCode,
        json: clean(r.out),
        apiRequests: r.requests.map((q) => `${q.method} ${q.path}`),
        submitBodies: submits.map((q) => clean(q.body)),
      }
      record(id, "cli", { argv: [...argv] }, outcome, evidence)
      return { ...outcome, shown: r.shown } as any
    }
    const SWAP = ["swap", "SOL", "<mint>", "--amount", "1", "--wallet", "tee", "--yes", "--json"]
    let c = await cli("cli-wait-sent", [...SWAP, "--client-trade-id", "cli-sent-1", "--wait-sent"], "a Solana TEE token trade: the submit carries wait sent, and the command exits 0 at broadcast with the signature and the trade id")
    assert.deepEqual([c.exitCode, c.json?.status, c.json?.clientTradeId, c.submitBodies[0]?.wait], [0, "broadcast", "cli-sent-1", "sent"], c.shown)
    c = await cli("cli-default-submit", [...SWAP, "--client-trade-id", "cli-default-1"], "without the flag the submit carries no wait and the command answers once booked")
    assert.deepEqual([c.exitCode, c.json?.status, c.submitBodies[0]?.wait], [0, "executed", undefined], c.shown)
    for (const [id, argv, evidence] of [
      ["cli-wait-sent-with-wait", [...SWAP, "--client-trade-id", "cli-sent-2", "--wait-sent", "--wait"], "the two waits are exclusive"],
      ["cli-wait-sent-base-to-base", ["swap", "SOL", "USDC", "--amount", "1", "--wallet", "tee", "--yes", "--json", "--wait-sent"], "a base-to-base swap is not a token trade"],
      ["cli-wait-sent-bridge", ["swap", "SOL", "ETH", "--amount", "1", "--wallet", "tee", "--yes", "--json", "--wait-sent"], "a bridge is not a Solana token trade"],
      ["cli-wait-sent-hood", ["swap", "ETH", "<hood-token>", "--amount", "1", "--wallet", "tee", "--yes", "--json", "--wait-sent"], "a Hood swap is refused"],
      ["cli-wait-sent-embedded", ["swap", "SOL", "<mint>", "--amount", "1", "--wallet", "<embedded>", "--yes", "--json", "--client-trade-id", "cli-sent-3", "--wait-sent"], "an embedded payer is refused once the payer is read, before any build"],
    ] as const) {
      c = await cli(id, argv, evidence)
      assert.equal(c.exitCode, 2, `${id}: ${c.shown}`)
      assert.equal(c.json?.code, "USAGE", `${id}: ${c.shown}`)
      assert.equal(c.submitBodies.length, 0)
      assert.ok(!c.apiRequests.some((p: string) => p.endsWith("/build")), `${id}: nothing built`)
    }
    for (const [id, job] of [
      ["cli-status-after-broadcast", { clientTradeId: "cli-sent-1", status: "built", chain: "solana", signature: SIGNATURE }],
      ["cli-status-booked", { clientTradeId: "cli-sent-1", status: "confirmed", chain: "solana", signature: SIGNATURE }],
      ["cli-status-reverted", { clientTradeId: "cli-sent-1", status: "failed", chain: "solana", signature: SIGNATURE, errorCode: "TRADE_REVERTED" }],
    ] as const) {
      c = await cli(id, ["swap", "status", "cli-sent-1", "--json"], "candle swap status <client-trade-id> follows the booking; it reads and sends nothing", { job })
      assert.equal(c.exitCode, 0, `${id}: ${c.shown}`)
      assert.equal(c.submitBodies.length, 0)
    }
  }

  // 11. Docs text: the section the agent reads, as source text, plus the SDK's changelog note.
  {
    const docs = text("docs/agent-trading.md")
    const section = /### Return at broadcast for a linked Solana trade\n([\s\S]*?)\n### /.exec(docs)?.[1] ?? ""
    const phrases = ["HTTP 202 acknowledges broadcast", "TRADE_REVERTED", "candle swap status <client-trade-id>", "client.waitForTrade(clientTradeId)", "--wait-sent"]
    for (const phrase of phrases) assert.ok(section.includes(phrase), `docs: ${phrase}`)
    const sdkChangelog = text("packages/sdk/CHANGELOG.md")
    const releasePrefix = `Release ${source.versions.sdk} (BE-3929), with CLI ${source.versions.cli}`
    const releaseEntry = sdkChangelog.split("\n").find((l) => l.startsWith(releasePrefix)) ?? ""
    assert.ok(releaseEntry.length > 0, `sdk changelog missing ${releasePrefix}`)
    record("docs-return-at-broadcast", "docs", { files: ["docs/agent-trading.md", "packages/sdk/CHANGELOG.md"] }, { found: true, phrases, releasePrefix })
    void PublicKey
  }

  // Every code an answer here carries.
  {
    const codes = new Set<string>()
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if ((k === "code" || k === "errorCode" || k === "routeCode") && typeof x === "string") codes.add(x); walk(x) }
    }
    for (const r of rows) walk(r.outcome)
    record("codes", "codes", { from: "every row" }, { codes: [...codes].sort() })
  }

  console.warn = quiet.warn
  console.error = quiet.error
  assert.equal(fetches, 0, `a recording reached for the network: ${fetched.join(", ")}`)
  const out = JSON.stringify(rows)
  for (const secret of [...secrets, KEY, INTERNAL, "fixture-path-not-a-key", "fixture-account", "BEGIN"]) assert.ok(!out.includes(secret), `a fixture carries ${secret.slice(0, 8)}: ${rows.filter((r) => JSON.stringify(r).includes(secret)).map((r) => r.id)}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-wait-sent-source.json"), `${JSON.stringify({
    about: `Offline wait:"sent" contracts (BE-3929): a linked Solana trade's POST /api/v1/trade/agent/submit with wait "sent" answers HTTP 202 (status broadcast, signature, clientTradeId) once the RPC acknowledges the send, and Candle books it in the background; the trading-background-booking worker books any the request did not, once, with zero double-booking and zero lost fees. Recorded by running Candle's own broadcaster, confirm loop, Solana wire checks, pre-send record rules, confirmSolanaTrade booking races, worker pass and worker confirm against stand-ins, with the route's checks pinned as source text, and the SDK and CLI through their own code, from the source commit named below (CLI ${source.versions.cli}, MCP ${source.versions.mcp}, SDK ${source.versions.sdk}); every fetch is intercepted and no database is used.`,
    source, rows,
  }, null, 2)}\n`)
  quiet.log(`Recorded ${rows.length} offline wait-sent contracts from ${source.commit}.`)
} finally {
  globalThis.fetch = originalFetch
  Date.now = realNow
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  console.warn = quiet.warn
  console.error = quiet.error
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}
