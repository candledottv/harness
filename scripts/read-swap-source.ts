// Offline CLI swap fast-path contracts (BE-3923) from an exact clean Candle source checkout: what `candle swap`
// does around its first requests, recorded by running the CLI's own source against stand-ins.
//   1. parallel reads: the job lookup, the wallet read and the mint-decimals read are all on the wire before any
//      of them is answered (the recorder holds each until the three have arrived, and fails if one never does),
//      and the build comes after;
//   2. the order of outcomes is the serial order: a job already stored under the id wins over a wallet or RPC
//      failure, and a wallet failure wins over a decimals failure;
//   3. the embedded wallet's execute probe is cached per API URL for 24 hours: a pass is cached, a deployment that
//      cannot hold a trade back is never cached, another API URL probes again, and the cache expires;
//   4. the local simulation of a TEE swap reads from the configured RPC (flag, env, or profile) and from nothing
//      else, and only that RPC's host is ever shown.
// Every fetch is intercepted: the API, the relay and the RPC are answered by this script, nothing is signed with a
// real key, and no address, key or figure is real.
//   bun scripts/read-swap-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-swap-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/sdk", "packages/shared")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: ["packages/cli/src/commands/swap.ts", "packages/cli/src/trading.ts"],
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({ name: "swap-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
} })
const originalFetch = globalThis.fetch
const originalNow = Date.now
globalThis.fetch = (() => { throw new Error("swap recording may not access the network") }) as unknown as typeof fetch

const API = "https://api.test"
const OTHER_API = "https://other-api.test"
const PRIVATE_RPC = "https://rpc.private.test/v2/fixture-path-not-a-key"
const PROFILE_RPC = "https://rpc.profile.test/v2/fixture-path-not-a-key"
const PUBLIC_RPC_HOST = "api.mainnet-beta.solana.com"
const KEY = "fixture-only-not-a-key"
const H = 3_600_000
const T0 = 1_790_000_000_000
const dirs: string[] = []
const dir = (label: string) => { const d = mkdtempSync(join(tmpdir(), `candle-swap-source-${label}-`)); dirs.push(d); return d }

const { run } = await load("packages/cli/src/index.ts")
const { createCapture, createFakeConfigStore, createFakeStore, createTestDeps } = await load("packages/cli/src/test-support.ts")
const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")
const { swapScenario, scenarioRpcResult } = await load("packages/cli/src/solana-verify.fixtures.ts")
const { BASES } = await load("packages/cli/src/trading.ts")
const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
// Made-up, valid-looking base58 addresses; they go into the CLI only, and the rows name them <tee>, <embedded>, <mint>.
const MINT = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const TEE = MINT
const EMBEDDED = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const SIGNATURE = Buffer.alloc(64, 5).toString("base64")
const asset = (a: string) => (a === "SOL" ? "SOL" : (BASES[a]?.mint ?? a))

type Request = { n: number; host: string; path: string; rpc?: string }
type Row = { id: string; scenario: string; evidence?: string; args: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []

type World = {
  /** A job already stored under the id (a replay): the job route answers it. */
  job?: Record<string, unknown>
  walletsFail?: boolean
  decimalsFail?: boolean
  jobFail?: boolean
  noExecuteRoute?: boolean
  /** Every request named here must be on the wire before any of them is answered. */
  gate?: (r: Request) => string | null
}
/** One CLI run against a stand-in world; the config dir (and with it the probe cache) can outlive a run. */
async function runCli(argv: string[], opts: { world?: World; config?: string; env?: Record<string, string>; profileRpc?: string; answer?: string; noRpcEnv?: boolean } = {}) {
  const world = opts.world ?? {}
  const requests: Request[] = []
  const state = { built: false, scenario: undefined as any }
  const gate = world.gate
  const waiting = new Map<string, () => void>()
  const arrived = new Set<string>()
  let release!: () => void
  const released = new Promise<void>((r) => { release = r })
  const gated = gate ? new Set<string>() : null
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    const request: Request = { n: requests.length + 1, host: url.host, path: body?.method ? "<rpc>" : url.pathname, ...(body?.method ? { rpc: body.method } : {}) }
    requests.push(request)
    const hold = gate?.(request) ?? null
    if (hold && gated) {
      arrived.add(hold)
      if (arrived.size === 3) release()
      await Promise.race([released, new Promise((_, reject) => setTimeout(() => reject(new Error(`swap reads were not all started together: only ${[...arrived].join(", ")} arrived`)), 1500))])
    }
    const path = url.pathname
    const ok = (value: unknown, status = 200) => Response.json(value, { status })
    const notFound = () => ok({ error: { code: "JOB_NOT_FOUND", message: "not found" } }, 404)
    if (path.includes("/jobs/")) {
      if (world.jobFail) return ok({ error: { code: "SCOPE_MISSING", message: "job lookup refused" } }, 403)
      if (world.job) return path.includes("/agent/swap/jobs/") ? ok({ success: true, job: world.job }) : notFound()
      return state.built ? ok({ success: true, job: { status: "built" } }) : notFound()
    }
    if (path === "/api/v1/agent/wallets/trading") {
      if (world.walletsFail) return ok({ error: { code: "TIER_REQUIRED", message: "wallet read refused" } }, 403)
      return ok({ scopes: ["swap:write"], privyAppId: "app", page: [{ id: "wallet", address: TEE, label: "tee", chain: "solana", active: true, allowLaunch: true, privyWalletId: "privy" }], isDone: true })
    }
    if (path === "/api/v1/agent/wallets/embedded") return ok({ success: true, wallets: { solana: { address: EMBEDDED }, evm: null }, embeddedWalletPermission: "allowed" })
    if (path === "/api/v1/agent/keys/self/limits") return ok({ success: true, keyLimits: null })
    if (path === "/api/v1/trade/agent/execute") {
      if (world.noExecuteRoute) return new Response("404 Not Found", { status: 404 })
      return state.built ? ok({ success: true, status: "executed", signature: SIGNATURE }) : notFound()
    }
    if (path.endsWith("/build")) {
      state.built = true
      const main = body?.payer?.type === "main"
      const quote: Record<string, unknown> = { status: "built", swapId: "server-swap", recipient: main ? EMBEDDED : TEE, minOutRaw: "123456", fee: { bps: 50, feeRaw: "5000" }, expiresAt: 10000, venue: "jupiter", priceImpactPct: "0.1", tokenRisks: [], transactionsBase64: ["unsigned"] }
      if (!main) {
        const spend = asset(String(body.from ?? "SOL")), receive = asset(String(body.to ?? MINT))
        state.scenario = swapScenario({ wallet: TEE, spend, spendRaw: BigInt(body.amountRaw), receive, receiveRaw: BigInt(String(quote.minOutRaw)) })
        quote.transactionsBase64 = [state.scenario.transaction]
      }
      return path.includes("trade/agent")
        ? ok({ ...quote, chain: "solana", walletAddress: main ? EMBEDDED : TEE, artifacts: { ...quote, quoteAsset: body.quoteAsset, transactionBase64: (quote.transactionsBase64 as string[])[0] } })
        : ok({ success: true, payload: quote })
    }
    if (path.endsWith("/sign")) return ok({ signedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 5), Buffer.alloc(40)]).toString("base64"), encoding: "base64" })
    if (path.endsWith("/submit") || path.endsWith("/confirm")) return ok({ success: true, status: "executed", signature: SIGNATURE })
    if (url.host.startsWith("rpc.") || url.host === PUBLIC_RPC_HOST) {
      if (world.decimalsFail && body.method === "getTokenSupply") return new Response("rate limited", { status: 429 })
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
    fetch: fetcher, stdout, stderr, promptLine: async () => opts.answer ?? "y",
    env: { CANDLE_CONFIG_DIR: opts.config ?? dir("run"), CANDLE_API_KEY: KEY, CANDLE_API_URL: API, ...(opts.noRpcEnv ? {} : { CANDLE_SOLANA_RPC_URL: PRIVATE_RPC }), ...(opts.env ?? {}) },
    store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(pem) }),
    ...(opts.profileRpc ? createFakeConfigStore({ profiles: { work: { rpcUrl: opts.profileRpc } }, activeProfile: "work" }) : {}),
  })
  const exitCode: number = await run(argv, deps)
  let body: any
  try { body = JSON.parse(stdout.text) } catch { body = undefined }
  return { exitCode, requests, stdout: stdout.text, stderr: stderr.text, body }
}
const lines = (text: string) => text.split("\n")
const name = (a: string) => (a === TEE ? "<tee>" : a === EMBEDDED ? "<embedded>" : a === MINT ? "<mint>" : a)
const rpcHosts = (requests: Request[]) => [...new Set(requests.filter((q) => q.rpc).map((q) => q.host))]
const rpcMethods = (requests: Request[]) => [...new Set(requests.filter((q) => q.rpc).map((q) => q.rpc))]
const probes = (requests: Request[]) => requests.filter((q) => q.path === "/api/v1/trade/agent/execute").length
const built = (requests: Request[]) => requests.some((q) => q.path.endsWith("/build"))
const SWAP = ["swap", "SOL", MINT, "--amount", "1", "--yes", "--json"]
const TEE_SWAP = [...SWAP, "--wallet", "tee"]
const EMBEDDED_SWAP = (id: string) => [...SWAP, "--wallet", EMBEDDED, "--client-trade-id", id]
const record = (id: string, scenario: string, argv: string[], requests: Request[], outcome: Record<string, unknown>, evidence?: string) =>
  rows.push({ id, scenario, ...(evidence ? { evidence } : {}), args: { argv: argv.map(name) }, requests, outcome })

try {
  // 1. Parallel reads. The three reads are held until all three are on the wire; a serial CLI times out here.
  {
    const which = (q: Request) => q.path.includes("/jobs/") ? "job" : q.path === "/api/v1/agent/wallets/trading" ? "wallets" : q.rpc === "getTokenSupply" ? "decimals" : null
    const gate = (q: Request) => which(q)
    const argv = [...TEE_SWAP, "--rpc-url", PRIVATE_RPC, "--client-trade-id", "fast-1"]
    const r = await runCli(argv, { world: { gate } })
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const firstBuild = r.requests.findIndex((q) => q.path.endsWith("/build"))
    const reads = r.requests.slice(0, firstBuild).filter((q) => which(q))
    assert.deepEqual(reads.map(which).sort(), ["decimals", "job", "wallets"])
    record("parallel-reads-tee-swap", "parallel-reads", argv.map((a) => (a === PRIVATE_RPC ? "<private-rpc>" : a)), r.requests, {
      exitCode: r.exitCode, readsStartedTogether: ["job", "wallets", "decimals"], readsBeforeBuild: reads.length, builtAfterReads: firstBuild >= reads.length, status: r.body?.status,
    }, "stand-in: each read is held until all three are on the wire; the recorder fails if one never arrives")
  }

  // 2. The order of outcomes is the serial order.
  {
    const job = { status: "confirmed", signature: SIGNATURE, hashes: [SIGNATURE] }
    // Both assets are bases, so this is a swap job (a token is a trade, on another job route); no decimals read is needed.
    const argv = ["swap", "SOL", "USDC", "--amount", "1", "--yes", "--json", "--wallet", "tee", "--client-trade-id", "order-1"]
    const r = await runCli(argv, { world: { job, walletsFail: true } })
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    assert.ok(!built(r.requests))
    record("prior-job-wins-over-failed-reads", "order", argv, r.requests, { exitCode: r.exitCode, replayed: true, builtAnything: false, status: r.body?.status, signaturesShown: r.body?.signatures?.length ?? null },
      "A job already stored under the id is printed as it is, even when the wallet read failed alongside it.")
    const fail = async (id: string, world: World) => {
      const a = [...TEE_SWAP, "--client-trade-id", id]
      const f = await runCli(a, { world })
      assert.notEqual(f.exitCode, 0)
      assert.ok(!built(f.requests), `${id} must not build`)
      record(id, "order", a, f.requests, { exitCode: f.exitCode, code: f.body?.code, builtAnything: false })
      return f.body?.code as string
    }
    const jobCode = await fail("job-read-failure-first", { jobFail: true, walletsFail: true, decimalsFail: true })
    const walletCode = await fail("wallet-failure-over-decimals-failure", { walletsFail: true, decimalsFail: true })
    const decimalsCode = await fail("decimals-failure-alone", { decimalsFail: true })
    // Each read fails with its own mapped code, so the order is readable from the code alone.
    assert.deepEqual([jobCode, walletCode, decimalsCode], ["SCOPE_MISSING", "TIER_REQUIRED", "RPC_RATE_LIMITED"])
  }

  // 3. The execute probe, per API URL, for 24 hours.
  {
    const config = dir("probe")
    Date.now = () => T0
    const first = await runCli(EMBEDDED_SWAP("probe-1"), { config })
    const second = await runCli(EMBEDDED_SWAP("probe-2"), { config })
    assert.equal(first.exitCode, 0, first.stdout + first.stderr)
    assert.equal(second.exitCode, 0, second.stdout + second.stderr)
    assert.equal(probes(first.requests), 2)
    assert.equal(probes(second.requests), 1)
    record("probe-first-trade", "execute-probe", EMBEDDED_SWAP("probe-1"), first.requests, { exitCode: first.exitCode, executeCalls: probes(first.requests), probed: true, status: first.body?.status })
    record("probe-cached-second-trade", "execute-probe", EMBEDDED_SWAP("probe-2"), second.requests, { exitCode: second.exitCode, executeCalls: probes(second.requests), probed: false, status: second.body?.status },
      "The probe is the first /execute call, before the build; with the cache only the execution after the quote remains.")
    Date.now = () => T0 + 23 * H
    const within = await runCli(EMBEDDED_SWAP("probe-3"), { config })
    assert.equal(probes(within.requests), 1)
    record("probe-cached-after-23-hours", "execute-probe", EMBEDDED_SWAP("probe-3"), within.requests, { exitCode: within.exitCode, executeCalls: probes(within.requests), probed: false })
    Date.now = () => T0 + 25 * H
    const expired = await runCli(EMBEDDED_SWAP("probe-4"), { config })
    assert.equal(probes(expired.requests), 2)
    record("probe-asks-again-after-25-hours", "execute-probe", EMBEDDED_SWAP("probe-4"), expired.requests, { exitCode: expired.exitCode, executeCalls: probes(expired.requests), probed: true })
    // Another API URL has its own answer: the first one's pass does not carry over.
    Date.now = () => T0 + 25 * H + 1000
    const other = await runCli(EMBEDDED_SWAP("probe-5"), { config, env: { CANDLE_API_URL: OTHER_API } })
    assert.equal(probes(other.requests), 2)
    record("probe-per-api-url", "execute-probe", EMBEDDED_SWAP("probe-5"), other.requests, { exitCode: other.exitCode, executeCalls: probes(other.requests), probed: true },
      "Run against another API URL on the same machine and config: it probes again.")
    // A deployment that cannot hold a trade back is refused before any build, and never cached as supported.
    Date.now = () => T0
    const noRoute = dir("probe-refused")
    const a = await runCli(EMBEDDED_SWAP("probe-6"), { config: noRoute, world: { noExecuteRoute: true } })
    const b = await runCli(EMBEDDED_SWAP("probe-7"), { config: noRoute, world: { noExecuteRoute: true } })
    for (const x of [a, b]) { assert.equal(x.exitCode, 1); assert.ok(!built(x.requests)); assert.equal(probes(x.requests), 1) }
    // The code is not recorded: EMBEDDED_PAYER_UNSUPPORTED is the CLI's own and the Candle Harness runs TEE swaps only, so it has no row for it.
    record("probe-failure-never-cached", "execute-probe", EMBEDDED_SWAP("probe-6"), a.requests, { exitCode: a.exitCode, executeCalls: probes(a.requests), builtAnything: false })
    record("probe-failure-asks-again", "execute-probe", EMBEDDED_SWAP("probe-7"), b.requests, { exitCode: b.exitCode, executeCalls: probes(b.requests), builtAnything: false, probedAgain: true })
    // Declining the quote still leaves the probe cached: it passed.
    const declineConfig = dir("probe-decline")
    const declined = await runCli(["swap", "SOL", MINT, "--amount", "1", "--wallet", EMBEDDED, "--json", "--client-trade-id", "probe-8"], { config: declineConfig, answer: "n" })
    const after = await runCli(EMBEDDED_SWAP("probe-9"), { config: declineConfig })
    assert.equal(probes(declined.requests), 1)
    assert.equal(probes(after.requests), 1)
    record("probe-passed-then-quote-declined", "execute-probe", ["swap", "SOL", MINT, "--amount", "1", "--wallet", EMBEDDED, "--json", "--client-trade-id", "probe-8"], declined.requests, { exitCode: declined.exitCode, executeCalls: probes(declined.requests), executedAfterDecline: false, status: declined.body?.status })
    record("probe-cached-after-a-declined-quote", "execute-probe", EMBEDDED_SWAP("probe-9"), after.requests, { exitCode: after.exitCode, executeCalls: probes(after.requests), probed: false })
    Date.now = originalNow
  }

  // 4. The private RPC: the local simulation reads from the configured RPC and from nothing else, and only its host is shown.
  {
    const cases: [string, string[], Parameters<typeof runCli>[1], string][] = [
      ["flag", [...TEE_SWAP, "--rpc-url", PRIVATE_RPC, "--client-trade-id", "rpc-1"], {}, "rpc.private.test"],
      ["env", [...TEE_SWAP, "--client-trade-id", "rpc-2"], { env: { CANDLE_SOLANA_RPC_URL: PRIVATE_RPC } }, "rpc.private.test"],
      ["profile", [...TEE_SWAP, "--client-trade-id", "rpc-3"], { env: { CANDLE_PROFILE: "work" }, profileRpc: PROFILE_RPC, noRpcEnv: true }, "rpc.profile.test"],
      ["flag-over-env", [...TEE_SWAP, "--rpc-url", PRIVATE_RPC, "--client-trade-id", "rpc-4"], { env: { CANDLE_SOLANA_RPC_URL: PROFILE_RPC } }, "rpc.private.test"],
      ["default-is-the-public-endpoint", [...TEE_SWAP, "--client-trade-id", "rpc-5"], { noRpcEnv: true }, PUBLIC_RPC_HOST],
    ]
    for (const [id, argv, opts, host] of cases) {
      const r = await runCli(argv, opts)
      assert.equal(r.exitCode, 0, `${id}: ${r.stdout}${r.stderr}`)
      assert.deepEqual(rpcHosts(r.requests), [host], id)
      assert.ok(rpcMethods(r.requests).includes("simulateTransaction"), `${id} simulates locally before it signs`)
      const shown = r.stdout + r.stderr
      assert.ok(!shown.includes("fixture-path-not-a-key"), `${id}: the RPC's path is never shown`)
      assert.ok(shown.includes(host), `${id}: its host is shown`)
      assert.ok(!r.requests.filter((q) => q.rpc).some((q) => q.host === new URL(API).host), "the Candle API is never a Solana endpoint")
      record(`private-rpc-${id}`, "private-rpc", argv.map((a) => (a === PRIVATE_RPC ? "<private-rpc>" : a)), r.requests, { exitCode: r.exitCode, rpcHosts: rpcHosts(r.requests), simulatedLocally: true, hostShown: true, pathShown: false })
    }
    for (const [id, url] of [["plain-http", "http://rpc.private.test/v2/fixture-path-not-a-key"], ["not-a-url", "not a url"]] as const) {
      const argv = [...TEE_SWAP, "--rpc-url", url, "--client-trade-id", "rpc-6"]
      const r = await runCli(argv)
      assert.equal(r.exitCode, 2)
      assert.equal(r.requests.length === 0 || !built(r.requests), true)
      assert.ok(!(r.stdout + r.stderr).includes("fixture-path-not-a-key"), "a refused URL is never echoed")
      record(`private-rpc-refused-${id}`, "private-rpc", [...TEE_SWAP, "--rpc-url", `<${id}>`, "--client-trade-id", "rpc-6"], r.requests, { exitCode: r.exitCode, code: r.body?.code, builtAnything: false })
    }
  }

  // Mapped codes only: every code a row carries is one the Candle Harness's trade path knows before any build.
  const { PRE_BUILD_CODES } = await import("../src/core/cli-trade")
  for (const row of rows) { const code = row.outcome.code; if (code !== undefined) assert.ok(PRE_BUILD_CODES.has(code), `${row.id}: ${code} is not a mapped code`) }
  const text = JSON.stringify(rows)
  for (const secret of [KEY, MINT, EMBEDDED, "fixture-path-not-a-key", "BEGIN"]) assert.ok(!text.includes(secret), `a fixture carries ${secret}: ${rows.filter((r) => JSON.stringify(r).includes(secret)).map((r) => r.id)}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-swap-source.json"), `${JSON.stringify({
    about: "Offline `candle swap` fast-path contracts (BE-3923): the job, wallet and decimals reads on the wire together; the order of outcomes unchanged; the embedded wallet's execute probe cached per API URL for 24 hours (a pass only); the local simulation read from the configured RPC and nothing else. Recorded by running the CLI's source against stand-ins from an exact staging commit; every fetch is intercepted. The commit is a staging build: the published CLI predates it.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline swap contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; for (const d of dirs) rmSync(d, { recursive: true, force: true }) }
