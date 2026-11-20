// Offline Hood holder-exit contracts from an exact clean Candle source checkout: where a holder of one Candle Hood
// curve stands if the launch does not migrate, and the exit itself, as `candle token exit <token>`,
// `candle_holder_exit`, `candle_claim_holder_exit` and the SDK's `getHolderExit()`, `holderExit()` and
// `HolderExitError` read it.
//
// The read's body is Candle's own pure `deriveHolderExit` run on made-up chain facts for each state (none,
// awaiting_migration, recovery_open, recovery, rescue_pending, rescued, a void rescue request, a claimable team
// escrow), put in the route's `{ payload: { curve, token, holderExit } }` envelope. The agent route's answers
// (a dry run, a completed exit, a partial and an indeterminate one, the refusals) are response stubs shaped by the
// SDK's types and the route's refusal table; the API route, the chain read, the builder and the signer are not run.
// Every request is intercepted: nothing is sent, signed or read from a chain, and no key is a real one.
//   bun scripts/read-holder-exit-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-holder-exit-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const CLI_DOC = "apps/docs/src/content/docs/developers/cli.md", MCP_DOC = "apps/docs/src/content/docs/developers/mcp-server.md"
const SDK_DOC = "apps/docs/src/content/docs/developers/sdk.md", SDK_CHANGELOG = "packages/sdk/CHANGELOG.md"
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", "packages/gated-launch-evm", CLI_DOC, MCP_DOC, SDK_DOC)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const deny = (() => { throw new Error("holder-exit recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

/** A made-up instant, as Unix seconds: every time below is days before or after it. */
const NOW_MS = Date.UTC(2027, 0, 12, 14, 0)
const NOW = BigInt(NOW_MS / 1000)
const DAY = 86_400n
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
/** Made-up Hood addresses, each a repeated digit, so none is a real contract or wallet. */
const rep = (digit: string) => `0x${digit.repeat(40)}`
const CURVE = rep("1"), TOKEN = rep("2"), HOLDER = rep("3"), CREATOR = rep("4"), USDG = rep("5"), RESCUE_TO = rep("6"), ESCROW = rep("7"), TEAM = rep("8")
const TX_APPROVE = `0x${"a1".repeat(32)}`, TX_CLAIM = `0x${"b2".repeat(32)}`
const BASE_DECIMALS = 18, QUOTE_DECIMALS = 6
const E18 = 10n ** 18n, E6 = 10n ** 6n

type Raw = Record<string, any>
const raw = (over: Raw): Raw => ({
  blockNumber: 1_000_000n, blockTimestamp: NOW, generation: 2, lifecycle: 0, graduatedAt: 0n, creator: CREATOR, quoteToken: USDG, baseToken: TOKEN,
  baseDecimals: BASE_DECIMALS, quoteDecimals: QUOTE_DECIMALS, recoveryEligibleSupply: 0n, recoveryReserveSnapshot: 0n, recoverySurrendered: 0n,
  creatorFeesAccrued: 0n, teamAllocation: 0n, rescue: null, team: null, ...over,
})
const holder = (balance: bigint, allowance = 0n, address = HOLDER) => ({ address, baseBalance: balance, allowanceToCurve: allowance })
const failedLaunch = { lifecycle: 3, graduatedAt: NOW - 40n * DAY, recoveryEligibleSupply: 2000n * E18, recoveryReserveSnapshot: 1000n * E6 }
const denied = (executableAt: bigint, deniedSince: bigint, quoteDenied = true) => ({ to: RESCUE_TO, executableAt, quoteDenied, deniedSince })
const team = (over: Raw = {}) => ({ escrow: ESCROW, recipient: TEAM, amount: 100n * E18, startTime: NOW - 60n * DAY, cliffTime: NOW - 30n * DAY, vestingDays: 100, claimed: 0n, vested: 0n, claimable: 0n, ...over })

type Read = { id: string; says: string; raw: Raw; account?: string; expect: { state: string; actions: string[] } }
const reads: Read[] = [
  { id: "none", says: "A launch still trading: state none, no window, no recovery, and an empty disclosure.", raw: raw({}), expect: { state: "none", actions: [] } },
  { id: "awaiting-migration", says: "Graduated two days ago: trading is closed, Recovery is not open yet (the creator may from day 7, anyone from day 30).", raw: raw({ lifecycle: 1, graduatedAt: NOW - 2n * DAY }), expect: { state: "awaiting_migration", actions: [] } },
  { id: "recovery-open", says: "Graduated 31 days ago and never migrated: anyone may open Recovery, so the holder's actions name enter_recovery.", raw: raw({ lifecycle: 1, graduatedAt: NOW - 31n * DAY, account: holder(10n * E18) }), account: HOLDER, expect: { state: "recovery_open", actions: ["enter_recovery"] } },
  { id: "recovery", says: "Recovery is open: the fixed rate, what is left, the holder's balance and what Recovery pays it, and claim_recovery as the action.", raw: raw({ ...failedLaunch, account: holder(10n * E18) }), account: HOLDER, expect: { state: "recovery", actions: ["claim_recovery"] } },
  { id: "recovery-no-balance", says: "Recovery is open and this wallet holds none of the token: nothing it can claim.", raw: raw({ ...failedLaunch, account: holder(0n) }), account: HOLDER, expect: { state: "recovery", actions: [] } },
  { id: "rescue-pending", says: "The quote token was denied and a rescue request is valid: state rescue_pending, with where the quote balance will go and when.", raw: raw({ lifecycle: 1, graduatedAt: NOW - 3n * DAY, rescue: denied(NOW + 4n * DAY, NOW - 3n * DAY) }), expect: { state: "rescue_pending", actions: [] } },
  { id: "rescue-void", says: "A rescue request whose quote token was readmitted is void (quote_readmitted): the state falls back to awaiting_migration and the request says valid false.", raw: raw({ lifecycle: 1, graduatedAt: NOW - 3n * DAY, rescue: denied(NOW + 4n * DAY, NOW - 3n * DAY, false) }), expect: { state: "awaiting_migration", actions: [] } },
  { id: "rescued", says: "A failed launch with nothing eligible left: state rescued, no on-chain claim, and no recovery block.", raw: raw({ lifecycle: 3, graduatedAt: NOW - 40n * DAY, recoveryEligibleSupply: 0n, account: holder(10n * E18) }), account: HOLDER, expect: { state: "rescued", actions: [] } },
  { id: "team-claimable", says: "A migrated generation 2 launch with a vesting escrow: the team recipient may claim what has vested, so claim_team is its action.", raw: raw({ lifecycle: 2, graduatedAt: NOW - 30n * DAY, teamAllocation: 100n * E18, team: team({ vested: 30n * E18, claimable: 30n * E18 }), account: holder(5n * E18, 0n, TEAM) }), account: TEAM, expect: { state: "none", actions: ["claim_team"] } },
  { id: "team-stranded", says: "A failed generation 2 launch with a team escrow: its team status is stranded, and the holder's Recovery claim is the only action.", raw: raw({ ...failedLaunch, teamAllocation: 100n * E18, team: team(), account: holder(10n * E18) }), account: HOLDER, expect: { state: "recovery", actions: ["claim_recovery"] } },
]

const deriveFor = (derive: (raw: any, now: bigint) => any, r: Read) => derive(r.raw, r.raw.blockTimestamp)
const envelope = (holderExit: unknown) => ({ payload: { curve: CURVE, token: TOKEN, holderExit } })
const market = { success: true, market: { chain: "hood", mint: TOKEN, curveAddress: CURVE, decimals: BASE_DECIMALS } }

type Call = { kind: string; to: string; status: string; txHash: string | null; recorded?: string }
const calls = (...c: Call[]) => c
const approveCall = (status: string, txHash: string | null): Call => ({ kind: "approve", to: TOKEN, status, txHash, ...(txHash ? { recorded: "not_recorded" } : {}) })
const claimCall = (status: string, txHash: string | null): Call => ({ kind: "claim_recovery", to: CURVE, status, txHash, ...(txHash ? { recorded: status === "confirmed" ? "booked" : "not_recorded" } : {}) })
const build = (amountRaw: string, expectedQuoteOutRaw: string) => ({
  curve: CURVE, account: HOLDER, action: "claim_recovery", generation: 2, blockNumber: "1000000", amountRaw, expectedQuoteOutRaw, quoteToken: USDG, quoteDecimals: QUOTE_DECIMALS,
  calls: [{ kind: "approve", to: TOKEN, value: "0", gas: "60000", gasEstimated: true }, { kind: "claim_recovery", to: CURVE, value: "0", gas: "150000", gasEstimated: true }],
  gasCost: { maxFeePerGas: "1000000000", maxPriorityFeePerGas: "100000000", requiredWei: "210000000000000", balanceWei: "5000000000000000" },
})
const AMOUNT = (10n * E18).toString(), PAYS = (5n * E6).toString()
const success = (extra: Record<string, unknown>) => ({ success: true, curve: CURVE, action: "claim_recovery", wallet: HOLDER, signer: "embedded", ...extra })
const failure = (code: string, message: string, retryable: boolean, stage: string, more: Record<string, unknown> = {}, details?: Record<string, string>) =>
  ({ success: false, error: { code, message, retryable, stage, ...(details ? { details } : {}) }, ...more })

/** The agent route's answers by scenario: its dry run (always), and its real run. The routes themselves are not run. */
type Act = { id: string; read?: string; says: string; action: string; mcp: Record<string, unknown>; sdk: Record<string, unknown>; cli: string[]; dry: { status: number; body: unknown }; real?: { status: number; body: unknown }; prompt?: string; exit: number }
const DRY = success({ dryRun: true, signable: true, build: build(AMOUNT, PAYS), outcome: "not_started", calls: calls({ kind: "approve", to: TOKEN, status: "not_sent", txHash: null }, { kind: "claim_recovery", to: CURVE, status: "not_sent", txHash: null }) })
const acts: Act[] = [
  { id: "dry-run", says: "A dry run of claim_recovery: Candle builds and simulates, signs nothing, and the outcome is not_started. The MCP tool's dryRun defaults to true; the SDK and CLI say so.",
    action: "claim_recovery", mcp: { curve: CURVE, action: "claim_recovery" }, sdk: { curve: CURVE, action: "claim_recovery", dryRun: true }, cli: ["--recover", "--dry-run"], dry: { status: 200, body: DRY }, exit: 0 },
  { id: "complete", says: "A completed claim_recovery: the approval and the claim both confirmed, and the exit recorded.",
    action: "claim_recovery", mcp: { curve: CURVE, action: "claim_recovery", dryRun: false }, sdk: { curve: CURVE, action: "claim_recovery" }, cli: ["--recover", "--yes"], dry: { status: 200, body: DRY },
    real: { status: 200, body: success({ dryRun: false, build: build(AMOUNT, PAYS), outcome: "complete", calls: calls(approveCall("confirmed", TX_APPROVE), claimCall("confirmed", TX_CLAIM)) }) }, exit: 0 },
  { id: "partial", says: "A partial exit: the approval landed and the claim reverted. The SDK throws HolderExitError carrying outcome partial, the calls and the warnings; build again.",
    action: "claim_recovery", mcp: { curve: CURVE, action: "claim_recovery", dryRun: false }, sdk: { curve: CURVE, action: "claim_recovery" }, cli: ["--recover", "--yes"], dry: { status: 200, body: DRY },
    real: { status: 409, body: failure("HOOD_EXIT_FAILED", "The exit did not complete", true, "reverted", { outcome: "partial", calls: calls(approveCall("confirmed", TX_APPROVE), claimCall("reverted", TX_CLAIM)), warnings: [`Transaction ${TX_CLAIM} reverted.`] }) }, exit: 1 },
  { id: "indeterminate", says: "An exit whose last call was sent and not yet known: outcome indeterminate. The CLI exits 3, to be read again before it is run again.",
    action: "claim_recovery", mcp: { curve: CURVE, action: "claim_recovery", dryRun: false }, sdk: { curve: CURVE, action: "claim_recovery" }, cli: ["--recover", "--yes"], dry: { status: 200, body: DRY },
    real: { status: 502, body: failure("HOOD_EXIT_FAILED", "The exit was sent and its result is not known yet", true, "unconfirmed", { outcome: "indeterminate", calls: calls(approveCall("confirmed", TX_APPROVE), claimCall("submitted_unknown", TX_CLAIM)), warnings: ["A call was sent and its result is not known: read before running it again."] }) }, exit: 3 },
  { id: "not-ready", read: "awaiting-migration", says: "enter_recovery before the window: 409 HOOD_RECOVERY_NOT_READY with the two times in details (the dry run is refused first, so nothing is sent).",
    action: "enter_recovery", mcp: { curve: CURVE, action: "enter_recovery" }, sdk: { curve: CURVE, action: "enter_recovery", dryRun: true }, cli: ["--enter-recovery", "--dry-run"],
    dry: { status: 409, body: failure("HOOD_RECOVERY_NOT_READY", "Recovery isn't open for this wallet yet. Check when it opens on the token page.", false, "not_broadcast", {}, { creatorMayEnterAt: String(NOW + 5n * DAY), anyoneMayEnterAt: String(NOW + 28n * DAY) }) }, exit: 1 },
  { id: "declined", says: "A real run the user declines at the confirmation: nothing is sent and the CLI exits 5. Only the dry run reached the route.",
    action: "claim_recovery", mcp: { curve: CURVE, action: "claim_recovery" }, sdk: { curve: CURVE, action: "claim_recovery", dryRun: true }, cli: ["--recover"], dry: { status: 200, body: DRY }, prompt: "n", exit: 5 },
]

type Request = { method: string; path: string; credential: boolean; body?: unknown }
type Row = { id: string; scenario: string; surface: string; says?: string; evidence?: string; args?: Record<string, unknown>; requests?: unknown[]; outcome: any }
const rows: Row[] = []
const lines = (t: string) => t.trimEnd().split("\n").filter((l) => l !== "")
const scrub = (t: string) => t.split(cfg.apiKey).join("<key>")
try {
  const { deriveHolderExit } = await load("packages/gated-launch-evm/src/holder-exit.ts")
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { HolderExitError } = await load("packages/sdk/src/holder-exit.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")

  /** An intercepted API: the stub answers by method and path, and every request is listed. */
  const serve = (requests: Request[], answers: (method: string, path: string, body: any) => { status: number; body: unknown } | undefined) =>
    (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
      assert.ok(String(url).startsWith(`${cfg.apiUrl}/`), `unexpected host: ${url}`)
      const headers = new Headers(init?.headers)
      const method = init?.method ?? "GET"
      const path = String(url).slice(cfg.apiUrl.length)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method, path, credential: headers.has("authorization") || headers.has("x-api-key"), ...(body !== undefined ? { body } : {}) })
      const answer = answers(method, path.split("?")[0]!, body)
      if (!answer) throw new Error(`unexpected request: ${method} ${path}`)
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
  const withMcp = async <T>(fetcher: typeof fetch, key: boolean, fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ body: any; isError: boolean }>) => Promise<T>) => {
    globalThis.fetch = fetcher
    const server = createCandleMcpServer({}, key ? cfg : { apiUrl: cfg.apiUrl })
    const client = new Client({ name: "harness-holder-exit-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b); await client.connect(a)
    try {
      return await fn(async (name, args) => {
        const r: any = await client.callTool({ name, arguments: args })
        const t: string = r.content[0].text
        // A refusal before any request is plain text, not the API's JSON.
        let body: any
        try { body = JSON.parse(t) } catch { body = { text: t } }
        return { body, isError: r.isError === true }
      })
    } finally { await client.close(); await server.close(); globalThis.fetch = deny }
  }
  const sdkOutcome = async (run: () => Promise<unknown>) => {
    try { return { body: await run(), isError: false } }
    catch (e: any) {
      assert.ok(e instanceof HolderExitError, `a refusal is a HolderExitError: ${e}`)
      return { body: { code: e.code, status: e.status, message: e.message, retryable: e.retryable, ...(e.stage ? { stage: e.stage } : {}), ...(e.details ? { details: e.details } : {}), ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.calls ? { calls: e.calls } : {}), ...(e.warnings ? { warnings: e.warnings } : {}) }, isError: true }
    }
  }
  const cliRun = async (args: string[], fetcher: typeof fetch, opts: { key?: boolean; prompt?: string } = {}) => {
    const stdout = createCapture(), stderr = createCapture(), prompts: string[] = []
    const deps = createTestDeps({
      stdout, stderr, now: () => NOW_MS, fetch: fetcher,
      env: { CANDLE_PLAIN: "1", CANDLE_API_URL: cfg.apiUrl, ...(opts.key ? { CANDLE_API_KEY: cfg.apiKey } : {}) },
      isTTY: { stdin: opts.prompt !== undefined, stdout: false, stderr: false },
      promptLine: async (q: string) => { prompts.push(q); return opts.prompt ?? "n" },
    })
    const exitCode = await cli.run(args, deps)
    return { exitCode, stdout: scrub(stdout.text), stderr: scrub(stderr.text), prompts }
  }

  // ── The read, one holder-exit state at a time ────────────────────────────────────────────
  for (const r of reads) {
    const holderExit = JSON.parse(JSON.stringify(deriveFor(deriveHolderExit, r)))
    assert.equal(holderExit.state, r.expect.state, `${r.id} state`)
    assert.deepEqual(holderExit.actions, r.expect.actions, `${r.id} actions`)
    const body = envelope(holderExit)
    const query = r.account ? `?account=${r.account}` : ""
    const path = `/api/v1/hood/curves/${CURVE}/holder-exit${query}`
    rows.push({ id: `${r.id}-api`, scenario: r.id, surface: "api-source", says: r.says,
      evidence: "Candle's own pure deriveHolderExit on made-up chain facts at one block, in the read route's envelope; the route, the chain read and its cache are not run",
      args: { path }, outcome: { status: 200, body } })
    const answers = (method: string, p: string) =>
      method === "GET" && p === `/api/v1/hood/curves/${CURVE}/holder-exit` ? { status: 200, body }
      : method === "GET" && p === `/api/v1/markets/hood/${TOKEN}` ? { status: 200, body: market } : undefined

    {
      const requests: Request[] = []
      await withMcp(serve(requests, answers), true, async (call) => {
        const args = { curve: CURVE, ...(r.account ? { account: r.account } : {}) }
        const o = await call("candle_holder_exit", args)
        assert.equal(o.isError, false)
        assert.deepEqual(o.body, body, `${r.id} mcp relays the answer whole`)
        // Keyless: no credential is sent though one is configured.
        assert.deepEqual(requests, [{ method: "GET", path, credential: false }])
        rows.push({ id: `${r.id}-mcp`, scenario: r.id, surface: "mcp", args, requests, outcome: o })
      })
    }
    {
      const requests: Request[] = []
      const client = new CandleClient({ ...cfg, fetch: serve(requests, answers), maxRetries: 0 })
      const o = await sdkOutcome(() => client.getHolderExit(CURVE, r.account))
      assert.deepEqual(o.body, body.payload, `${r.id} sdk`)
      assert.deepEqual(requests.map((q) => [q.method, q.path]), [["GET", path]])
      rows.push({ id: `${r.id}-sdk`, scenario: r.id, surface: "sdk", args: { curve: CURVE, ...(r.account ? { account: r.account } : {}) }, requests: requests.map(({ method, path }) => ({ method, path })), outcome: o })
    }
    for (const json of [false, true]) {
      const requests: Request[] = []
      const args = ["token", "exit", TOKEN, ...(r.account ? ["--wallet", r.account] : []), ...(json ? ["--json"] : [])]
      const out = await cliRun(args, serve(requests, answers))
      assert.equal(out.exitCode, 0, `${r.id} cli ${out.stdout}${out.stderr}`)
      // A public read: the token's market for its curve, then one read; no key, none being configured.
      assert.deepEqual(requests.map((q) => [q.method, q.path.split("?")[0], q.credential]), [["GET", `/api/v1/markets/hood/${TOKEN}`, false], ["GET", `/api/v1/hood/curves/${CURVE}/holder-exit`, false]])
      if (json) assert.deepEqual(JSON.parse(out.stdout), body, `${r.id} cli --json`)
      else if (holderExit.disclosure) assert.ok(out.stdout.replace(/\s+/g, " ").includes(holderExit.disclosure), `${r.id} cli shows the disclosure verbatim`)
      rows.push({ id: `${r.id}-cli${json ? "-json" : ""}`, scenario: r.id, surface: "cli", args: { command: `candle ${args.join(" ")}` }, requests,
        outcome: json ? { exitCode: out.exitCode, body: JSON.parse(out.stdout) } : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) } })
    }
  }

  // The token form of the MCP read resolves the curve from the token's market first; a token with no curve is NO_HOOD_CURVE.
  {
    const recovery = reads.find((r) => r.id === "recovery")!
    const body = envelope(JSON.parse(JSON.stringify(deriveFor(deriveHolderExit, recovery))))
    for (const [id, curveAddress, says] of [["by-token", CURVE, "candle_holder_exit given a token: its curve is read from the token's market first, then the read."], ["no-curve", null, "A token whose market has no Hood curve: NO_HOOD_CURVE, and no holder-exit read."]] as const) {
      const requests: Request[] = []
      const answers = (method: string, p: string) =>
        method === "GET" && p === `/api/v1/markets/hood/${TOKEN}` ? { status: 200, body: { success: true, market: { chain: "hood", mint: TOKEN, curveAddress, decimals: BASE_DECIMALS } } }
        : method === "GET" && p === `/api/v1/hood/curves/${CURVE}/holder-exit` ? { status: 200, body } : undefined
      await withMcp(serve(requests, answers), false, async (call) => {
        const o = await call("candle_holder_exit", { token: TOKEN, account: HOLDER })
        assert.equal(o.isError, curveAddress === null)
        rows.push({ id: `${id}-mcp`, scenario: id, surface: "mcp", says, args: { token: TOKEN, account: HOLDER }, requests, outcome: o })
      })
      const cliRequests: Request[] = []
      const out = await cliRun(["token", "exit", TOKEN, "--json"], serve(cliRequests, answers))
      assert.equal(out.exitCode, curveAddress === null ? 1 : 0)
      rows.push({ id: `${id}-cli-json`, scenario: id, surface: "cli", args: { command: `candle token exit ${TOKEN} --json` }, requests: cliRequests, outcome: { exitCode: out.exitCode, body: JSON.parse(out.stdout) } })
    }
  }

  // ── The exit, one outcome at a time ──────────────────────────────────────────────────────
  const readBody = (id: string) => envelope(JSON.parse(JSON.stringify(deriveFor(deriveHolderExit, reads.find((r) => r.id === id)!))))
  const agentPath = `/api/v1/agent/hood/holder-exit/${CURVE}`
  for (const a of acts) {
    const answers = (method: string, p: string, body: any) =>
      method === "GET" && p === `/api/v1/markets/hood/${TOKEN}` ? { status: 200, body: market }
      : method === "GET" && p === "/api/v1/agent/wallets/embedded" ? { status: 200, body: { success: true, wallets: { solana: null, evm: { address: HOLDER } } } }
      : method === "GET" && p === `/api/v1/hood/curves/${CURVE}/holder-exit` ? { status: 200, body: readBody(a.read ?? "recovery") }
      : method === "POST" && p === agentPath ? (body?.dryRun === true || !a.real ? a.dry : a.real) : undefined
    rows.push({ id: `${a.id}-api`, scenario: a.id, surface: "api-stub", says: a.says,
      evidence: "A response stub shaped by the SDK's types and the route's refusal table: the agent route, the builder and the signer are not run",
      args: { path: agentPath, action: a.action }, outcome: { dry: a.dry, ...(a.real ? { real: a.real } : {}) } })

    {
      const requests: Request[] = []
      await withMcp(serve(requests, answers), true, async (call) => {
        const o = await call("candle_claim_holder_exit", a.mcp)
        const last = a.mcp.dryRun === false && a.real ? a.real : a.dry
        assert.deepEqual(o.body, last.body, `${a.id} mcp relays the answer whole`)
        assert.equal(o.isError, last.status >= 400)
        // dryRun defaults to true; only an explicit false sends. The request carries the key and nothing else added.
        const sent = requests[0]!.body as Record<string, unknown>
        assert.equal(sent.dryRun, a.mcp.dryRun !== false, `${a.id} mcp dryRun default`)
        assert.deepEqual(requests.map((q) => [q.method, q.path, q.credential]), [["POST", agentPath, true]])
        rows.push({ id: `${a.id}-mcp`, scenario: a.id, surface: "mcp", args: a.mcp, requests, outcome: o })
      })
    }
    {
      const requests: Request[] = []
      const client = new CandleClient({ ...cfg, fetch: serve(requests, answers), maxRetries: 0 })
      const o = await sdkOutcome(() => client.holderExit(a.sdk as never))
      const last = a.sdk.dryRun === true || !a.real ? a.dry : a.real
      assert.equal(o.isError, last.status >= 400, `${a.id} sdk`)
      if (!o.isError) assert.deepEqual(o.body, last.body, `${a.id} sdk`)
      // The SDK sends dryRun false unless asked: a send is never the default there.
      assert.equal((requests[0]!.body as any).dryRun, a.sdk.dryRun === true)
      rows.push({ id: `${a.id}-sdk`, scenario: a.id, surface: "sdk", args: a.sdk, requests: requests.map(({ method, path, body }) => ({ method, path, body })), outcome: o })
    }
    for (const json of [false, true]) {
      if (json && a.prompt !== undefined) continue
      const requests: Request[] = []
      const args = ["token", "exit", TOKEN, ...a.cli, ...(json ? ["--json"] : [])]
      const out = await cliRun(args, serve(requests, answers), { key: true, ...(a.prompt !== undefined ? { prompt: a.prompt } : {}) })
      assert.equal(out.exitCode, a.exit, `${a.id} cli ${out.stdout}${out.stderr}`)
      // Reads need no key; the exit is on the agent route with it, dry run first, and a real run only after it.
      const posts = requests.filter((q) => q.method === "POST").map((q) => (q.body as any).dryRun)
      assert.deepEqual(posts, a.cli.includes("--dry-run") || !a.real || a.prompt !== undefined ? [true] : [true, false], `${a.id} cli runs the dry run first`)
      if (a.prompt !== undefined) assert.equal(out.prompts.length, 1)
      const text = scrub(`${out.stdout}${out.stderr}`).replace(/\s+/g, " ")
      if (!json && a.exit === 1 && a.id !== "partial") assert.ok(text.includes("HOOD_RECOVERY_NOT_READY"), `${a.id} cli names the API's code`)
      rows.push({ id: `${a.id}-cli${json ? "-json" : ""}`, scenario: a.id, surface: "cli", args: { command: `candle ${args.join(" ")}`, ...(a.prompt !== undefined ? { answer: a.prompt } : {}) }, requests: requests.map(({ method, path, body }) => ({ method, path, ...(body !== undefined ? { body } : {}) })),
        outcome: json ? { exitCode: out.exitCode, body: JSON.parse(out.stdout) } : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}), ...(out.prompts.length ? { prompts: out.prompts } : {}) } })
    }
  }

  // An exit has no key-less form: the MCP tool and the SDK refuse before any request.
  {
    const requests: Request[] = []
    await withMcp(serve(requests, () => undefined), false, async (call) => {
      const o = await call("candle_claim_holder_exit", { curve: CURVE, action: "claim_recovery" })
      assert.equal(o.isError, true)
      assert.deepEqual(requests, [])
      rows.push({ id: "no-key-mcp", scenario: "no-key", surface: "mcp", says: "An exit with no key configured is refused before any request.", args: { curve: CURVE, action: "claim_recovery" }, requests, outcome: o })
    })
    const sdkRequests: Request[] = []
    const client = new CandleClient({ apiUrl: cfg.apiUrl, fetch: serve(sdkRequests, () => undefined), maxRetries: 0 })
    let message = ""
    try { await client.holderExit({ curve: CURVE, action: "claim_recovery" }) } catch (e: any) { message = String(e.message) }
    assert.ok(message.length > 0 && sdkRequests.length === 0)
    rows.push({ id: "no-key-sdk", scenario: "no-key", surface: "sdk", says: "holderExit() with no key throws before any request.", args: { curve: CURVE, action: "claim_recovery" }, requests: [], outcome: { isError: true, message } })
  }

  // ── The portfolio's marks, the market read's passthrough and the docs, as the source says them ──
  // `candle portfolio` marks a Hood position whose launch is in recovery, rescue_pending or rescued. The run needs a
  // wallet read, prices and a chain, so what is recorded is the source's own text for it, not a run.
  const portfolio = readFileSync(join(checkout, "packages/cli/src/commands/portfolio.ts"), "utf8")
  const between = (text: string, from: string, to: string) => {
    const start = text.indexOf(from)
    assert.ok(start >= 0, `source text missing: ${from}`)
    const end = text.indexOf(to, start)
    assert.ok(end > start, `source text missing: ${to}`)
    return text.slice(start, end + to.length)
  }
  rows.push({ id: "portfolio-marks-source", scenario: "portfolio", surface: "source-text", args: { file: "packages/cli/src/commands/portfolio.ts" }, outcome: {
    states: between(portfolio, "const OPEN_EXIT_STATES = ", ' as const\n'),
    words: between(portfolio, "const EXIT_STATE_WORDS", "\n}\n").split("\n").slice(1, -2).map((l) => l.trim()),
    limits: [between(portfolio, "const EXIT_MARKS_MAX_TOKENS = ", "\n"), between(portfolio, "const EXIT_MARKS_IN_FLIGHT = ", "\n")].map((l) => l.trim()),
    jsonKeys: ["holderExits", "holderExitsUnread", "holderExit"].map((k) => { assert.ok(portfolio.includes(k), `portfolio.ts names ${k}`); return k }),
  } })
  const docLine = (file: string, starts: string) => {
    const found = readFileSync(join(checkout, file), "utf8").split("\n").filter((line) => line.startsWith(starts))
    assert.equal(found.length, 1, `${file}: one line starting ${starts}`)
    return found[0]!
  }
  rows.push({ id: "docs-cli", scenario: "docs", surface: "docs", args: { files: [CLI_DOC] }, outcome: { text: docLine(CLI_DOC, "| `token exit <token>") } })
  rows.push({ id: "docs-mcp-read", scenario: "docs", surface: "docs", args: { files: [MCP_DOC] }, outcome: { text: docLine(MCP_DOC, "| `candle_holder_exit`") } })
  rows.push({ id: "docs-mcp-claim", scenario: "docs", surface: "docs", args: { files: [MCP_DOC] }, outcome: { text: docLine(MCP_DOC, "| `candle_claim_holder_exit`") } })
  rows.push({ id: "docs-sdk-changelog", scenario: "docs", surface: "docs", args: { files: [SDK_CHANGELOG] }, outcome: { text: docLine(SDK_CHANGELOG, "Release 0.6.28") } })

  let text = JSON.stringify(rows)
  assert.ok(!text.includes(cfg.apiKey), "no key in a recording")
  assert.ok(!/cndl_/.test(text))
  // Every address in a row is one of the made-up repeated-digit ones, and every hash a made-up one.
  const known = new Set([CURVE, TOKEN, HOLDER, CREATOR, USDG, RESCUE_TO, ESCROW, TEAM].map((a) => a.toLowerCase()))
  for (const m of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) assert.ok(known.has(m.toLowerCase()), `an address that is not made up: ${m}`)
  for (const m of text.match(/0x[0-9a-fA-F]{64}/g) ?? []) assert.ok([TX_APPROVE, TX_CLAIM].includes(m), `a hash that is not made up: ${m}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-holder-exit-source.json"), `${JSON.stringify({
    about: "Offline Hood holder-exit contracts from exact merged source. Every address, amount, hash and time is made up; times are days before or after one made-up instant. api-source rows are Candle's own pure deriveHolderExit run on made-up chain facts at one block, in the read route's envelope (the route, the chain read and its cache are not run). api-stub rows are response stubs for the agent route (a dry run, a completed exit, a partial and an indeterminate one, a refusal), shaped by the SDK's types and the route's refusal table; the route, the builder and the signer are not run. mcp, sdk and cli rows read the same answers through the registered tools, the SDK and `candle token exit <token>` over an intercepted fetch: nothing is sent, signed or read from a chain. portfolio-marks-source and docs rows are the source's own text, read as text; `candle portfolio` itself is not run. No deployed behavior is claimed.",
    source, now: new Date(NOW_MS).toISOString(), rows: JSON.parse(text),
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline holder-exit contracts (${reads.length} read states, ${acts.length} exit outcomes) from ${source.commit}.`)
} finally {
  globalThis.fetch = originalFetch
}
