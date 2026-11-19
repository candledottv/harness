// Offline client-surface and swap-landing contracts (BE-3919) from an exact clean Candle source checkout: the
// `X-Candle-Client` label each Candle client puts on its API requests, how the API reads it, and the per-swap timing
// row the API keeps for each Solana swap it broadcasts. Recorded by running Candle's own source against stand-ins.
//   1. cli:        `candle swap` (TEE and embedded wallet) run through the CLI's own `run()`: every request to the
//                  API carries `cli/<CLI version>`, no RPC request does; the quant key client's wrapper keeps the
//                  shape of the headers it is given and a label already set;
//   2. sdk:        `CandleClient` methods: every request to the API carries `sdk/<SDK version>`; another origin
//                  (Hyperliquid), a `Request` object and a label already set are left as they were;
//   3. mcp:        a registered MCP tool: its request to the API carries `mcp/<server version>`; another origin
//                  carries none, and the API URL is read per request;
//   4. mcp-hosted: the hosted connector stamps `mcp-hosted/<server version>` on the very request object it dispatches;
//   5. web:        the browser wrapper labels only Candle API requests the browser already preflights, as
//                  `web/<12-char build sha>` (or `web/dev`); a simple GET is left alone;
//   6. api-label:  how the API reads the header (strict shape, else a Candle web Origin, else the raw-caller label);
//   7. landing:    the real Solana broadcaster inside a swap route with its connection and confirm loop swapped for
//                  stand-ins: one row per broadcast (send time, send ms, outcome, landing slot, confirm time, winning
//                  path, sends, route, wallet type, client), none for a refused send, outside a swap route, or with no
//                  writer; each surface's own header replayed into the route lands as that surface's label;
//   8. confirm:    the real confirm loop against a stand-in connection: the slot and the send count it reports;
//   9. source:     the four route mounts in app.ts and the table's checks in the migration, pinned as source text.
// Every fetch is intercepted: nothing reaches a network, nothing is signed with a real key, and no address, key,
// signature or figure is real.
//   bun scripts/read-client-surface-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-client-surface-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/sdk", "packages/mcp", "packages/shared", "apps/api/src", "apps/frontend/src")
const FILES = [
  "packages/cli/src/client.ts",
  "packages/sdk/src/client-surface.ts",
  "packages/mcp/src/client.ts",
  "apps/api/src/mcp/hosted.ts",
  "apps/frontend/src/lib/client-surface.ts",
  "apps/api/src/lib/client-surface.ts",
  "apps/api/src/ledger/trading/swap-landings.ts",
  "apps/api/src/services/candle/trade-broadcast.ts",
  "apps/api/src/services/candle/launch-confirm.ts",
  "apps/api/src/app.ts",
  "apps/api/src/ledger/migrations/20270209000000_ops_swap_landings.sql",
]
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(text(`packages/${p}/package.json`)).version])),
  files: FILES,
}
for (const f of FILES) text(f)
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({ name: "client-surface-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
  // The web app's `@/` alias (apps/frontend/tsconfig.json).
  build.onResolve({ filter: /^@\// }, (args) => ({ path: join(checkout, "apps/frontend/src", `${args.path.slice(2)}.ts`) }))
} })
const originalFetch = globalThis.fetch
const originalNow = Date.now
globalThis.fetch = (() => { throw new Error("client-surface recording may not access the network") }) as unknown as typeof fetch

const API = "https://api.test"
const HYPERLIQUID = "https://api.hyperliquid.xyz"
const RPC = "https://rpc.private.test/v2/fixture-path-not-a-key"
const KEY = "fixture-only-not-a-key"
const HEADER = "x-candle-client"
const dirs: string[] = []
const dir = (label: string) => { const d = mkdtempSync(join(tmpdir(), `candle-client-surface-${label}-`)); dirs.push(d); return d }

type Request = { n: number; host: string; path: string; rpc?: string; client: string | null }
type Row = { id: string; scenario: string; evidence?: string; args: Record<string, unknown>; requests?: Request[]; outcome: Record<string, unknown> }
const rows: Row[] = []
const record = (id: string, scenario: string, args: Record<string, unknown>, outcome: Record<string, unknown>, requests?: Request[], evidence?: string) =>
  rows.push({ id, scenario, ...(evidence ? { evidence } : {}), args, ...(requests ? { requests } : {}), outcome })
type HeadersLike = ConstructorParameters<typeof Headers>[0]
const headerOf = (init?: RequestInit) => new Headers(init?.headers as HeadersLike | undefined).get(HEADER)
const shape = (h: unknown) => (h === undefined ? "none" : h instanceof Headers ? "Headers" : Array.isArray(h) ? "array" : "record")
/** A header value as it reaches the API, or the shape that carried it. */
const headersAs = (h: unknown): unknown => (h instanceof Headers ? Object.fromEntries(h.entries()) : h)

/** The columns of an `ops.swap_landings` row as the writer builds it (sections 7 and 9). */
const FIELDS = ["signature", "route", "wallet_type", "client", "key_prefix", "sent_at", "send_ms", "outcome", "landed_slot", "confirmed_at", "winning_path", "sends"]
/** Each surface's header, as its own source sent it; replayed into the swap route in section 7. */
const sent: Record<string, string> = {}

try {
  // 1. The CLI. A TEE swap and an embedded-wallet swap through the CLI's own `run()`.
  {
    const { run } = await load("packages/cli/src/index.ts")
    const { CLI_VERSION } = await load("packages/cli/src/version.ts")
    const { withCliClientSurface, CLI_CLIENT_SURFACE } = await load("packages/cli/src/client.ts")
    const { createCapture, createTestDeps, createFakeStore } = await load("packages/cli/src/test-support.ts")
    const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")
    const { swapScenario, scenarioRpcResult } = await load("packages/cli/src/solana-verify.fixtures.ts")
    const { BASES } = await load("packages/cli/src/trading.ts")
    assert.equal(CLI_CLIENT_SURFACE, `cli/${CLI_VERSION}`)
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    // Made-up base58 addresses; they go into the CLI only and never into a row.
    const MINT = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
    const TEE = MINT
    const EMBEDDED = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
    const SIGNATURE = Buffer.alloc(64, 5).toString("base64")
    const asset = (a: string) => (a === "SOL" ? "SOL" : (BASES[a]?.mint ?? a))
    const runCli = async (argv: string[]) => {
      const requests: Request[] = []
      const state = { built: false, scenario: undefined as any }
      const fetcher = async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        requests.push({ n: requests.length + 1, host: url.host, path: body?.method ? "<rpc>" : url.pathname, ...(body?.method ? { rpc: body.method } : {}), client: headerOf(init) })
        const path = url.pathname
        const ok = (value: unknown, status = 200) => Response.json(value, { status })
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
      let body: any
      try { body = JSON.parse(stdout.text) } catch { body = undefined }
      return { exitCode, requests, body, shown: stdout.text + stderr.text }
    }
    const SWAP = ["swap", "SOL", "<mint>", "--amount", "1", "--yes", "--json"]
    const cases: [string, string[], string][] = [
      ["cli-tee-swap", [...SWAP, "--wallet", "tee", "--client-trade-id", "surface-1"], "TEE wallet: job, wallets, decimals, build, relay sign, submit; the local simulation on the RPC"],
      ["cli-embedded-swap", [...SWAP, "--wallet", "<embedded>", "--client-trade-id", "surface-2"], "embedded (main) wallet: execute probe, build, execute"],
    ]
    for (const [id, argv, evidence] of cases) {
      const r = await runCli(argv.map((a) => (a === "<mint>" ? MINT : a === "<embedded>" ? EMBEDDED : a)))
      assert.equal(r.exitCode, 0, `${id}: ${r.shown}`)
      const api = r.requests.filter((q) => q.host === "api.test")
      const rpc = r.requests.filter((q) => q.host !== "api.test")
      assert.ok(api.length >= 3, `${id}: the swap reached the API`)
      assert.ok(api.every((q) => q.client === CLI_CLIENT_SURFACE), `${id}: every API request names the CLI`)
      assert.ok(rpc.every((q) => q.client === null), `${id}: no RPC request carries the label`)
      if (id === "cli-tee-swap") assert.ok(rpc.length > 0, "the TEE swap simulates on the RPC")
      sent.cli = CLI_CLIENT_SURFACE
      record(id, "cli", { argv }, {
        exitCode: r.exitCode, status: r.body?.status, apiRequests: api.length, apiLabelled: api.length, rpcRequests: rpc.length, rpcLabelled: 0,
        label: CLI_CLIENT_SURFACE,
      }, r.requests, evidence)
    }
    // The quant key client is built outside apiRequest; its wrapper labels whatever it is handed.
    for (const [id, headers] of [
      ["cli-quant-record-headers", { "x-api-key": "<key>" }],
      ["cli-quant-array-headers", [["accept", "*/*"]]],
      ["cli-quant-Headers-object", new Headers({ accept: "application/json" })],
      ["cli-quant-no-headers", undefined],
      ["cli-quant-label-already-set", { "X-Candle-Client": "cli/other" }],
    ] as const) {
      let seen: unknown
      const labelled = withCliClientSurface((async (_i: unknown, init?: RequestInit) => { seen = init?.headers; return new Response("{}") }) as typeof fetch)
      await labelled(`${API}/api/v1/agent/quant/turns`, headers === undefined ? {} : { headers: headers as HeadersLike })
      record(id, "cli", { wrapper: "withCliClientSurface", headersIn: shape(headers) }, { headersOut: headersAs(seen), shapeOut: shape(seen), label: headerOf({ headers: seen as HeadersLike }) })
    }
  }

  // 2. The SDK.
  {
    const { CandleClient, SDK_VERSION } = await load("packages/sdk/src/client.ts")
    const { withClientSurface } = await load("packages/sdk/src/client-surface.ts")
    const requests: Request[] = []
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ n: requests.length + 1, host: url.host, path: url.pathname, client: headerOf(init) })
      return Response.json({ success: true, data: [], dryRun: true })
    }) as unknown as typeof fetch
    const client = new CandleClient({ apiUrl: API, apiKey: KEY, fetch: impl })
    await client.getPresets().catch(() => {})
    await client.getSpendLimits?.().catch(() => {})
    await client.getPortfolio?.().catch(() => {})
    assert.ok(requests.length >= 2, "the SDK made API requests")
    assert.ok(requests.every((q) => q.client === `sdk/${SDK_VERSION}`), "every SDK request to the API names the SDK")
    sent.sdk = `sdk/${SDK_VERSION}`
    record("sdk-client-methods", "sdk", { methods: ["getPresets", "getSpendLimits", "getPortfolio"] }, { apiRequests: requests.length, apiLabelled: requests.length, label: `sdk/${SDK_VERSION}` }, requests)
    const cases: [string, string | URL | globalThis.Request, RequestInit | undefined][] = [
      ["sdk-api-string-url", `${API}/api/v1/markets/feed`, undefined],
      ["sdk-api-url-object", new URL(`${API}/api/v1/status`), { headers: new Headers({ accept: "application/json" }) }],
      ["sdk-hyperliquid-origin", `${HYPERLIQUID}/info`, { method: "POST", headers: { "content-type": "application/json" } }],
      ["sdk-request-object", new globalThis.Request(`${API}/api/v1/status`), undefined],
      ["sdk-label-already-set", `${API}/api/v1/markets/feed`, { headers: { "X-Candle-Client": "sdk/custom" } }],
    ]
    for (const [id, input, init] of cases) {
      let label: string | null = null
      const wrapped = withClientSurface((async (i: unknown, ini?: RequestInit) => { label = i instanceof globalThis.Request ? i.headers.get(HEADER) : headerOf(ini); return new Response("{}") }) as typeof fetch, API, `sdk/${SDK_VERSION}`)
      await wrapped(input as never, init)
      const host = new URL(input instanceof globalThis.Request ? input.url : String(input)).host
      record(id, "sdk", { input: input instanceof globalThis.Request ? "Request" : input instanceof URL ? "URL" : "string", host }, { label })
    }
  }

  // 3. The local MCP server.
  {
    const { registerToolSubset } = await load("packages/mcp/src/tools.ts")
    const { withClientSurface, MCP_CLIENT_SURFACE } = await load("packages/mcp/src/client.ts")
    const { SERVER_VERSION } = await load("packages/mcp/src/version.ts")
    assert.equal(MCP_CLIENT_SURFACE, `mcp/${SERVER_VERSION}`)
    const tools = new Map<string, any>()
    const server = {
      registerTool: (name: string, _config: unknown, handler: unknown) => { tools.set(name, { handler }); return { enabled: true, enable() {}, disable() {}, remove() {}, update() {} } },
      tool: (name: string, ...rest: unknown[]) => { tools.set(name, { handler: rest.at(-1) }); return { enabled: true, enable() {}, disable() {}, remove() {}, update() {} } },
    }
    const requests: Request[] = []
    registerToolSubset(server, {
      tools: ["candle_report_activity"],
      getConfig: () => ({ apiUrl: API, apiKey: KEY }),
      fetch: async (url: string, init?: RequestInit) => {
        const u = new URL(url)
        requests.push({ n: requests.length + 1, host: u.host, path: u.pathname, client: headerOf(init) })
        return Response.json({ success: true })
      },
    })
    await tools.get("candle_report_activity").handler({ chain: "solana", signature: "fixture-signature" })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.client, MCP_CLIENT_SURFACE)
    sent.mcp = MCP_CLIENT_SURFACE
    record("mcp-tool-request", "mcp", { tool: "candle_report_activity" }, { apiRequests: 1, apiLabelled: 1, label: MCP_CLIENT_SURFACE }, requests)
    let apiUrl = API
    const cases: [string, string, RequestInit | undefined, string][] = [
      ["mcp-hyperliquid-origin", `${HYPERLIQUID}/info`, { method: "POST" }, API],
      ["mcp-api-array-headers", `${API}/api/v1/markets/feed`, { headers: [["accept", "*/*"]] }, API],
      ["mcp-label-already-set", `${API}/api/v1/markets/feed`, { headers: { "X-Candle-Client": "mcp-hosted/1" } }, API],
      // The configured API is read per request: after a switch, the old origin is just another origin.
      ["mcp-api-url-switched-old-origin", `${API}/api/v1/markets/feed`, undefined, "https://other-api.test"],
      ["mcp-api-url-switched-new-origin", "https://other-api.test/api/v1/markets/feed", undefined, "https://other-api.test"],
    ]
    for (const [id, url, init, configured] of cases) {
      let label: string | null = null
      apiUrl = configured
      const wrapped = withClientSurface(async (_u: string, ini?: RequestInit) => { label = headerOf(ini); return Response.json({}) }, () => apiUrl)
      await wrapped(url, init)
      record(id, "mcp", { host: new URL(url).host, configuredApiHost: new URL(configured).host }, { label })
    }
  }

  // 4. The hosted MCP connector.
  {
    const { stampHostedClient, HOSTED_CLIENT_SURFACE } = await load("apps/api/src/mcp/hosted.ts")
    const { SERVER_VERSION } = await load("packages/mcp/src/version.ts")
    assert.equal(HOSTED_CLIENT_SURFACE, `mcp-hosted/${SERVER_VERSION}`)
    const request = new globalThis.Request(`${API}/api/v1/agent/swap`, { method: "POST", headers: { [HEADER]: "mcp/0.0.1" } })
    let dispatched: globalThis.Request | null = null
    await stampHostedClient((r: globalThis.Request) => { dispatched = r; return new Response("{}") })(request)
    assert.equal(dispatched, request, "the same request object is dispatched")
    sent["mcp-hosted"] = HOSTED_CLIENT_SURFACE
    record("mcp-hosted-stamp", "mcp-hosted", { incomingLabel: "mcp/0.0.1" }, { sameRequestObject: dispatched === request, label: request.headers.get(HEADER) },
      undefined, "the hosted connector replaces any label on the request it dispatches; a bound credential is keyed by that object")
    // A request whose headers refuse a write (an immutable guard): dispatched as it is, unlabelled.
    const frozen = { url: `${API}/api/v1/agent/swap`, headers: { set: () => { throw new TypeError("immutable headers") }, get: () => null } }
    let frozenDispatched = false
    await stampHostedClient((r: unknown) => { frozenDispatched = r === frozen; return new Response("{}") })(frozen as unknown as globalThis.Request)
    record("mcp-hosted-immutable-headers", "mcp-hosted", { headers: "a write throws" }, { dispatched: frozenDispatched, label: frozen.headers.get() }, undefined, "the label is measurement only: a request it cannot be set on is still dispatched")
  }

  // 5. The web app.
  {
    const { webClientSurface, labelledInit, alreadyPreflighted } = await load("apps/frontend/src/lib/client-surface.ts")
    const SHA = "0123456789abcdef0123456789abcdef01234567"
    const label = webClientSurface(SHA)
    assert.equal(label, "web/0123456789ab")
    record("web-label-build-sha", "web", { buildSha: "<40-char sha>" }, { label })
    record("web-label-no-sha", "web", { buildSha: null }, { label: webClientSurface("") })
    const origins = new Set([API])
    const cases: [string, string, RequestInit | undefined][] = [
      ["web-json-post-swap", `${API}/api/v1/jupiter/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ["web-json-post-confirm", `${API}/api/v1/jupiter/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ["web-keyed-get", `${API}/api/v1/agent/wallets/trading`, { headers: { "x-api-key": "<key>" } }],
      ["web-simple-get-quote", `${API}/api/v1/jupiter/quote`, undefined],
      ["web-simple-get-accept-header", `${API}/api/v1/markets/feed`, { headers: { accept: "application/json" } }],
      ["web-form-post", `${API}/api/v1/upload`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }],
      ["web-other-origin-post", "https://auth.privy.test/api/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ["web-label-already-set", `${API}/api/v1/jupiter/swap`, { method: "POST", headers: { "content-type": "application/json", "X-Candle-Client": "web/abc" }, body: "{}" }],
    ]
    for (const [id, url, init] of cases) {
      const next = labelledInit(url, init, origins, label)
      if (id === "web-json-post-swap") sent.web = headerOf(next) as string
      record(id, "web", { method: init?.method ?? "GET", host: new URL(url).host, path: new URL(url).pathname, headerNames: Object.keys((init?.headers ?? {}) as Record<string, string>) },
        { preflighted: alreadyPreflighted(init), labelled: next !== null, label: next ? headerOf(next) : null })
    }
    const req = new globalThis.Request(`${API}/api/v1/jupiter/swap`, { method: "POST" })
    record("web-request-object", "web", { input: "Request" }, { labelled: labelledInit(req, undefined, origins, label) !== null, label: null })
  }

  // 6. How the API reads the header.
  const { clientSurfaceOf, clientSurfaceLabel } = await load("apps/api/src/lib/client-surface.ts")
  const apiLabel = (h: Record<string, string>) => clientSurfaceLabel(clientSurfaceOf({ get: (n: string) => h[n.toLowerCase()] ?? null }))
  {
    const LONG = `cli/${"1".repeat(41)}`
    const cases: [string, Record<string, string>][] = [
      ["api-reads-cli", { [HEADER]: sent.cli as string }],
      ["api-reads-sdk", { [HEADER]: sent.sdk as string }],
      ["api-reads-mcp", { [HEADER]: sent.mcp as string }],
      ["api-reads-mcp-hosted", { [HEADER]: sent["mcp-hosted"] as string }],
      ["api-reads-web", { [HEADER]: sent.web as string }],
      ["api-trims-spaces", { [HEADER]: `  ${sent.cli}  ` }],
      ["api-surface-is-case-sensitive", { [HEADER]: "CLI/0.13.31" }],
      ["api-unknown-surface", { [HEADER]: "curl/8.0.1" }],
      ["api-empty-version", { [HEADER]: "cli/" }],
      ["api-version-too-long", { [HEADER]: LONG }],
      ["api-version-with-space", { [HEADER]: "sdk/1 2" }],
      ["api-version-with-separator", { [HEADER]: "sdk/1;x=2" }],
      ["api-no-header", {}],
      ["api-web-origin-no-header", { origin: "https://alpha.candle.tv" }],
      ["api-web-preview-origin", { origin: "https://preview-1.candle.run" }],
      ["api-web-origin-plain-http", { origin: "http://alpha.candle.tv" }],
      ["api-lookalike-origin", { origin: "https://evilcandle.tv" }],
      ["api-header-wins-over-origin", { [HEADER]: sent.sdk as string, origin: "https://alpha.candle.tv" }],
      ["api-bad-header-falls-to-origin", { [HEADER]: "nope", origin: "https://staging.candle.tv" }],
    ]
    const RAW = "unknown"
    for (const [id, h] of cases) {
      const label = apiLabel(h)
      const sentValue = h[HEADER]
      // A value outside the shape is never echoed: the label is a surface/version the shape allows, `web`, or the raw-caller label.
      assert.ok(label === RAW || label === "web" || /^(cli|sdk|mcp|mcp-hosted|web)\/[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(label), `${id}: ${label}`)
      record(id, "api-label", { header: sentValue === LONG ? "cli/<41 digits>" : (sentValue ?? null), origin: h.origin ?? null },
        { label, rawCaller: label === RAW, echoedInput: sentValue !== undefined && label !== RAW && label !== "web" && label !== sentValue.trim() ? true : false })
    }
  }

  // 7. The per-swap landing row, through the real broadcaster inside a swap route.
  {
    // The API's own dependencies, resolved from the API package as it resolves them.
    const fromApi = (name: string) => import(Bun.resolveSync(name, join(checkout, "apps/api")))
    const web3 = await fromApi("@solana/web3.js")
    const { Hono } = await fromApi("hono")
    const bs58 = (await fromApi("bs58")).default
    const { Keypair, PublicKey, SendTransactionError, TransactionInstruction, TransactionMessage, VersionedTransaction } = web3
    const { setKeyAttribution } = await load("apps/api/src/lib/key-attribution.ts")
    const { OnChainRevertError } = await load("apps/api/src/services/candle/launch-confirm.ts")
    const { __setSwapBroadcastInternalsForTest, broadcastSignedSolanaTx } = await load("apps/api/src/services/candle/trade-broadcast.ts")
    const { __setSwapLandingsRecordingForTest, processSwapLandings, swapLandingScope } = await load("apps/api/src/ledger/trading/swap-landings.ts")
    const signedTx = () => {
      const payer = Keypair.generate()
      const message = new TransactionMessage({
        payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [new TransactionInstruction({ programId: new PublicKey(Keypair.generate().publicKey), keys: [], data: Buffer.from([1]) })],
      }).compileToV0Message()
      const tx = new VersionedTransaction(message)
      tx.sign([payer])
      return { base64: Buffer.from(tx.serialize()).toString("base64"), signature: bs58.encode(tx.signatures[0]) as string }
    }
    // A clock that moves only when the broadcaster reads it, so send_ms and the times are exact.
    const T0 = 1_790_000_000_000
    let clock = T0
    const tick = (ms: number) => { clock += ms }
    Date.now = () => clock
    type Arm = { send: () => Promise<string> | string; confirm?: (sig: string, observe?: (s: { slot: number | null; sends: number; at: number }) => void) => Promise<string> }
    const arm = (a: Arm) => __setSwapBroadcastInternalsForTest({
      connection: { sendRawTransaction: async () => a.send(), getSignatureStatus: async () => { throw new Error("the confirm seam replaces the loop") } },
      confirm: async (_c: unknown, _raw: unknown, sig: string, observe?: any) => (a.confirm ? a.confirm(sig, observe) : sig),
    })
    const MOUNTS = { build: "main", execute: "main", submit: "linked", swap: "main" } as const
    const pathOf = (route: keyof typeof MOUNTS) => (route === "swap" ? "/api/v1/agent/swap" : `/api/v1/trade/agent/${route}`)
    const viaRoute = async (base64: string, headers: Record<string, string>, route: keyof typeof MOUNTS | null) => {
      const path = route ? pathOf(route) : "/api/v1/agent/transfer"
      const app = new Hono()
      if (route) app.use(path, swapLandingScope(route, MOUNTS[route]))
      app.post(path, async (c: any) => {
        setKeyAttribution(c, { keyPrefix: "FIXTURE1", userAddress: "fixture-account" })
        try { return c.json({ ok: true, signature: await broadcastSignedSolanaTx(base64) }) } catch (error) { return c.json({ thrown: error instanceof SendTransactionError ? "SendTransactionError" : (error as Error).name }, 500) }
      })
      const res = await app.request(path, { method: "POST", headers })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const take = (): any[] => processSwapLandings.take()
    const toRow = (r: any, sig: string, sentAt: number) => {
      assert.equal(r.signature, sig, "the row names the broadcast's own signature")
      assert.equal(r.sent_at, new Date(sentAt).toISOString(), "sent_at is the time just before the first send")
      return {
        signature: "<signature>", route: r.route, wallet_type: r.wallet_type, client: r.client, key_prefix: r.key_prefix,
        sent_at: "<t0>", send_ms: r.send_ms, outcome: r.outcome, landed_slot: r.landed_slot,
        confirmed_after_ms: r.confirmed_at === null ? null : Date.parse(r.confirmed_at) - sentAt, winning_path: r.winning_path, sends: r.sends,
      }
    }
    const landing = async (id: string, args: { route: keyof typeof MOUNTS | null; headers?: Record<string, string>; recording?: boolean }, behave: (sig: string) => Arm, evidence?: string) => {
      processSwapLandings.take()
      __setSwapLandingsRecordingForTest(args.recording ?? true)
      const tx = signedTx()
      clock = T0
      arm(behave(tx.signature))
      const res = await viaRoute(tx.base64, args.headers ?? {}, args.route)
      const got = take()
      for (const r of got) assert.deepEqual(Object.keys(r).sort(), [...FIELDS].sort(), "a row holds exactly the documented fields")
      record(id, "landing", { route: args.route ? pathOf(args.route) : "/api/v1/agent/transfer (no swap scope)", headers: args.headers ?? {}, writerRunning: args.recording ?? true },
        { httpStatus: res.status, tradeSaw: res.body.ok ? "signature" : res.body.thrown, rows: got.map((r) => toRow(r, tx.signature, T0)) }, undefined, evidence)
      return got
    }
    const landed = (slot: number, sends: number, sendMs = 40, confirmMs = 900) => (sig: string): Arm => ({
      send: () => { tick(sendMs); return sig },
      confirm: async (s, observe) => { tick(confirmMs); observe?.({ slot, sends, at: Date.now() }); return s },
    })
    // Each route mounted as app.ts mounts it, with the CLI's own label.
    const SLOTS = { build: 391_000_001, execute: 391_000_002, submit: 391_000_003, swap: 391_000_004 } as const
    for (const route of ["build", "execute", "submit", "swap"] as const) {
      const got = await landing(`landing-${route}-landed`, { route, headers: { "X-Candle-Client": sent.cli as string } }, landed(SLOTS[route], 1))
      assert.equal(got.length, 1)
      assert.equal(got[0].wallet_type, MOUNTS[route])
    }
    // Each surface's own header, replayed into /submit: the row names that surface.
    for (const surface of ["sdk", "mcp", "mcp-hosted", "web"] as const) {
      const got = await landing(`landing-client-${surface}`, { route: "submit", headers: { "X-Candle-Client": sent[surface] as string } }, landed(12, 1))
      assert.equal(got[0].client, sent[surface])
    }
    {
      const got = await landing("landing-client-web-origin-only", { route: "swap", headers: { Origin: "https://alpha.candle.tv" } }, landed(13, 1),
        "a simple web GET carries no header; a Candle Origin reads as web with no version")
      assert.equal(got[0].client, "web")
      const raw = await landing("landing-client-raw-caller", { route: "execute" }, landed(14, 1))
      assert.equal(raw[0].client, "unknown")
    }
    await landing("landing-landed-after-resends", { route: "submit", headers: { "X-Candle-Client": sent.sdk as string } }, landed(391_000_777, 3, 120, 7_400),
      "two resends before the confirmed status: sends counts the first send and each accepted resend")
    await landing("landing-reverted", { route: "submit", headers: { "X-Candle-Client": sent.cli as string } }, (sig) => ({
      send: () => { tick(35); return sig },
      confirm: async (s, observe) => { tick(1_100); observe?.({ slot: 55, sends: 1, at: Date.now() }); throw new OnChainRevertError(s, { InstructionError: [0, { Custom: 1 }] }) },
    }), "a confirmed status with an error landed and reverted: the slot is kept, the trade still sees the revert")
    await landing("landing-unconfirmed-send-answer-lost", { route: "swap", headers: { "X-Candle-Client": sent.mcp as string } }, () => ({
      send: () => { tick(30_000); throw new Error("socket hang up") },
    }), "the send threw after the bytes may have reached the node: unconfirmed, no slot, no path")
    {
      const LaunchHelpers = await load("apps/api/src/services/candle/launch-helpers.ts")
      await landing("landing-unconfirmed-confirm-timed-out", { route: "build", headers: { "X-Candle-Client": sent.cli as string } }, (sig) => ({
        send: () => { tick(50); return sig },
        confirm: async (s) => { tick(60_000); throw new LaunchHelpers.LaunchConfirmationTimeoutError(s) },
      }), "the confirm loop gave up: unconfirmed, no slot, no path")
    }
    const refused = await landing("landing-refused-send", { route: "submit", headers: { "X-Candle-Client": sent.cli as string } }, () => ({
      send: () => { throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Blockhash not found" }) },
    }), "the RPC refused the send: nothing reached the chain, so no landing")
    assert.equal(refused.length, 0)
    assert.equal((await landing("landing-outside-swap-scope", { route: null, headers: { "X-Candle-Client": sent.cli as string } }, landed(1, 1),
      "a broadcast outside the four swap routes (transfers, staking, LP, fees, launches) is not recorded")).length, 0)
    assert.equal((await landing("landing-no-writer", { route: "submit", headers: { "X-Candle-Client": sent.cli as string }, recording: false }, landed(1, 1),
      "without a database writer (no API_DATABASE_URL) nothing is kept")).length, 0)
    await landing("landing-observer-reports-no-slot", { route: "submit" }, (sig) => ({
      send: () => { tick(20); return sig },
      confirm: async (s, observe) => { tick(800); observe?.({ slot: null, sends: 1, at: Date.now() }); return s },
    }), "the RPC gave no slot with the confirmed status: landed, slot null")
    __setSwapBroadcastInternalsForTest(null)
    __setSwapLandingsRecordingForTest(false)
    Date.now = originalNow
  }

  // 8. The real confirm loop's observation, against a stand-in connection (it polls once a second).
  {
    const { confirmBroadcastTx, OnChainRevertError } = await load("apps/api/src/services/candle/launch-confirm.ts")
    const cases: [string, (poll: number) => any, number][] = [
      ["confirm-first-poll", () => ({ value: { confirmationStatus: "confirmed", err: null, slot: 400_000_001 } }), 1],
      ["confirm-after-a-resend", (poll) => (poll < 5 ? { value: null } : { value: { confirmationStatus: "finalized", err: null, slot: 400_000_002 } }), 5],
      ["confirm-reverted", () => ({ value: { confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] }, slot: 400_000_003 } }), 1],
      ["confirm-processed-is-not-landed", (poll) => (poll < 2 ? { value: { confirmationStatus: "processed", err: null, slot: 399_999_999 } } : { value: { confirmationStatus: "confirmed", err: null, slot: 400_000_004 } }), 2],
    ]
    for (const [id, status] of cases) {
      let polls = 0, resends = 0
      const seen: any[] = []
      const connection = {
        getSignatureStatus: async () => status(++polls),
        sendRawTransaction: async () => { resends++; return "fixture-signature" },
      }
      let outcome: string
      try { await confirmBroadcastTx(connection, new Uint8Array([1]), "fixture-signature", (s: any) => seen.push(s)); outcome = "returned" } catch (e) { outcome = e instanceof OnChainRevertError ? "OnChainRevertError" : (e as Error).name }
      assert.equal(seen.length, 1, `${id}: observed once`)
      assert.equal(seen[0].sends, 1 + resends, `${id}: sends is the first send plus each accepted resend`)
      record(id, "confirm", { pollsUntilConfirmed: polls }, { outcome, observedOnce: seen.length === 1, slot: seen[0].slot, sends: seen[0].sends, resends })
    }
  }

  // 9. Source text: the four mounts, and the migration's checks.
  {
    const app = text("apps/api/src/app.ts")
    const mounts = [...app.matchAll(/app\.use\("([^"]+)", swapLandingScope\("(\w+)", "(\w+)"\)\)/g)].map((m) => ({ path: m[1], route: m[2], wallet: m[3] }))
    assert.deepEqual(mounts, [
      { path: "/api/v1/trade/agent/build", route: "build", wallet: "main" },
      { path: "/api/v1/trade/agent/execute", route: "execute", wallet: "main" },
      { path: "/api/v1/trade/agent/submit", route: "submit", wallet: "linked" },
      { path: "/api/v1/agent/swap", route: "swap", wallet: "main" },
    ])
    record("source-swap-scope-mounts", "source", { file: "apps/api/src/app.ts" }, { mounts }, undefined, "pinned as source text: app.ts is the whole API and is not run here")
    const sql = text("apps/api/src/ledger/migrations/20270209000000_ops_swap_landings.sql")
    const check = (col: string) => {
      const m = new RegExp(`check \\((?:${col} is null or )?${col} in \\(([^)]*)\\)\\)`, "i").exec(sql)
      return m ? [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1]) : null
    }
    const columns = [...sql.matchAll(/^\s+([a-z_]+)\s+(text|bigint|integer|timestamptz|smallint)\b/gm)].map((m) => m[1])
    const checks = { route: check("route"), wallet_type: check("wallet_type"), outcome: check("outcome"), winning_path: check("winning_path"), winningPathNullable: /check \(winning_path is null or /.test(sql) }
    assert.deepEqual(checks.wallet_type, ["main", "linked"])
    assert.deepEqual(checks.winning_path, ["rpc"])
    assert.deepEqual(checks.route, ["build", "execute", "submit", "swap"])
    assert.deepEqual(checks.outcome, ["landed", "reverted", "unconfirmed"])
    for (const f of FIELDS) assert.ok(columns.includes(f), `the table has ${f}`)
    for (const forbidden of ["wallet_address", "mint", "amount", "account"]) assert.ok(!columns.includes(forbidden), `the table holds no ${forbidden}`)
    record("source-swap-landings-table", "source", { file: "apps/api/src/ledger/migrations/20270209000000_ops_swap_landings.sql" }, { columns, checks }, undefined, "pinned as source text: the migration is not run here")
  }

  // Mapped outcomes only: what the trade saw is a signature or one of the broadcaster's known errors.
  const SEEN = new Set(["signature", "TradeRevertedError", "TradeUnconfirmedError", "SendTransactionError"])
  for (const row of rows) if (row.scenario === "landing") assert.ok(SEEN.has(String(row.outcome.tradeSaw)), `${row.id}: ${row.outcome.tradeSaw}`)
  const out = JSON.stringify(rows)
  for (const secret of [KEY, "fixture-path-not-a-key", "BEGIN", "7ZL9Fvkp", "9dXSV8VW", "fixture-account"]) assert.ok(!out.includes(secret), `a fixture carries ${secret}: ${rows.filter((r) => JSON.stringify(r).includes(secret)).map((r) => r.id)}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-client-surface-source.json"), `${JSON.stringify({
    about: "Offline client-surface and swap-landing contracts (BE-3919): the X-Candle-Client label the CLI, SDK, local MCP, hosted MCP and web put on their Candle API requests, how the API reads it, and the per-swap row (send time, landing slot, winning path, wallet type, client) the API keeps for each Solana swap it broadcasts. Recorded by running Candle's own source against stand-ins from an exact staging commit; every fetch is intercepted. The commit is a staging build: the published CLI, MCP and SDK predate it.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline client-surface contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; for (const d of dirs) rmSync(d, { recursive: true, force: true }) }
