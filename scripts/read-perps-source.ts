// Additional offline builder-dex refusal and disclosure contracts from an exact clean Candle source checkout.
// All venue data is synthetic. Every fetch is intercepted; no real key, balance or live order.
//   bun scripts/read-perps-source.ts <candle-monorepo checkout>
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", "apps/api/src/lib/perps-gate.ts")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
// Resolve workspace imports back to this checkout, even when dependencies are shared locally.
Bun.plugin({ name: "perps-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candledottv\/mcp\/src\// }, ({ path }) => ({ path: join(checkout, "packages/mcp/src", path.split("/src/")[1]! + ".ts") }))
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
} })
const originalFetch = globalThis.fetch
const originalNow = Date.now
const NOW = 1_790_000_000_000
const deny = (() => { throw new Error("perps recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny
Date.now = () => NOW
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const fakeAddress = (n: string) => `0x${n.padStart(40, "0")}`
const dexes = [null, ...["xyz", "alt", "usdh"].map((name, i) => ({ name, fullName: name.toUpperCase(), deployer: fakeAddress(String(i + 1)), oracleUpdater: fakeAddress(String(i + 4)) }))]
const meta = (name: string, extra: Record<string, unknown> = {}) => ({ name, szDecimals: 3, maxLeverage: 10, ...extra })
const universes: Record<string, { collateralToken: number; universe: Record<string, unknown>[] }> = {
  "": { collateralToken: 0, universe: [meta("BTC", { maxLeverage: 40 }), meta("TSLA")] },
  xyz: { collateralToken: 0, universe: [meta("xyz:COIN", { deployerFeeScale: "1" }), meta("xyz:TSLA", { marginMode: "strictIsolated", deployerFeeScale: "1.5" }), meta("xyz:DELIST", { isDelisted: true })] },
  alt: { collateralToken: 0, universe: [meta("alt:TSLA", { maxLeverage: 20 })] },
  usdh: { collateralToken: 360, universe: [meta("usdh:COIN")] },
}
const context = { markPx: "100", midPx: "100", oraclePx: "100", openInterest: "20000", dayNtlVlm: "5000", prevDayPx: "100", funding: "0.00001" }
type Request = { method: string; path: string; body?: Record<string, unknown> }
type Row = { id: string; evidence?: string; surface: string; args: Record<string, unknown>; requests: Request[]; outcome: any }
const rows: Row[] = []
try {
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cliWrites = await load("packages/cli/src/commands/perps.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const { resolvePerpsMarket, closingGateConfig } = await load("apps/api/src/lib/perps-gate.ts")
  const { parsePerpDexs } = await load("packages/sdk/src/hyperliquid-markets.ts")
  const xyz = { ...universes.xyz, ctxs: universes.xyz!.universe.map(() => context), dex: parsePerpDexs(dexes)[0] }
  const config = { minOpenInterestUsd: 1_000_000, dexOpensRefused: [] }
  const halted = { ...config, dexOpensRefused: ["xyz"] }
  const close = resolvePerpsMarket(xyz, "xyz:TSLA", closingGateConfig(halted))
  assert.equal(close.ok, true)
  assert.equal(close.market.asset, 110001)
  // Exercise the actual CLI confirmation path with an ephemeral in-memory authorization key.
  // Stop at decline or at the intercepted relay request. No key or relay payload is recorded.
  const { createFakeStore } = await load("packages/cli/src/test-support.ts")
  const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")
  const { hyperliquidActionHash, hyperliquidL1TypedData } = await load("packages/cli/src/hyperliquid.ts")
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  for (const yes of [false, true]) {
    const builder = fakeAddress("7"), address = fakeAddress("9")
    const action = { type: "order", orders: [{ a: 110001, b: true, p: "101", s: "0.1", r: false, t: { limit: { tif: "Ioc" } }, c: `0x${"1".repeat(32)}` }], grouping: "na", builder: { b: builder, f: 100 } }
    const build = { success: true, network: "mainnet", walletId: "wallet", address, nonce: NOW, action,
      typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NOW), "mainnet"), perpOrderId: "fixture-perp", claimHash: "fixture-claim",
      preview: { coin: "xyz:TSLA", side: "long", size: "0.1", limitPx: "101", tif: "Ioc", midPx: "100", terms: close.market.terms, builderFeeTenthsBps: 100 } }
    const requests: Request[] = []
    const stdout = createCapture(), stderr = createCapture()
    let shown = "", stop = ""
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url))
      requests.push({ method: init?.method ?? "GET", path: u.pathname })
      if (u.pathname.endsWith("/sign")) { shown = stdout.text; stop = "before-relay"; throw new Error("offline recorder stops before signing") }
      if (u.pathname === "/api/v1/agent/wallets/trading") return Response.json({ scopes: ["perps:write"], privyAppId: "fixture-app", page: [{ id: "wallet", address, label: "perps", chain: "evm", active: true, allowLaunch: false, privyWalletId: "fixture-privy" }], isDone: true })
      if (u.pathname === "/api/v1/agent/perps/open") return Response.json(build)
      assert.equal(u.href, "https://api.hyperliquid.xyz/info")
      const b = JSON.parse(String(init?.body))
      if (b.type === "perpDexs") return Response.json(dexes)
      assert.equal(b.type, "metaAndAssetCtxs")
      assert.equal(b.dex, "xyz")
      return Response.json([universes.xyz, universes.xyz!.universe.map(() => context)])
    }
    const deps = createTestDeps({ stdout, stderr, now: () => NOW, fetch: fetcher,
      env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_HYPERLIQUID_BUILDER: builder },
      store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(ephemeral) }),
      promptLine: async () => { shown = stdout.text; stop = "before-prompt"; return "n" },
    })
    const exitCode = await cliWrites.perpsOpen(["xyz:TSLA", "long", "0.1", "--wallet", "perps", ...(yes ? ["--yes"] : [])], { deps, apiUrl: cfg.apiUrl, json: false })
    assert.equal(stop, yes ? "before-relay" : "before-prompt", stdout.text + stderr.text)
    assert.equal(exitCode, yes ? 1 : 5)
    assert.ok(shown.includes("Hyperliquid venue fee"))
    // Keep only public market disclosure lines; the account and authorization never enter a fixture.
    const disclosure = shown.slice(shown.indexOf("Market xyz:TSLA"))
    rows.push({ id: `cli-order-${yes ? "yes" : "prompt"}`, surface: "cli", args: { coin: "xyz:TSLA", yes }, requests, outcome: { stop, exitCode, disclosure } })
  }
  const { tpslTermsFixture } = await load("packages/mcp/src/tpsl-terms.fixture.ts")
  for (const surface of ["mcp", "sdk"]) for (const leg of ["tp", "sl"]) for (const replace of [false, true]) {
    const builder = fakeAddress("7")
    const f = tpslTermsFixture({ walletId: "wallet", address: fakeAddress("9"), builder, signature: "unused", leg, replace })
    const requests: Request[] = []
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
      assert.ok(u.startsWith(cfg.apiUrl + "/") || u === "https://api.hyperliquid.xyz/info")
      assert.ok(!/\/sign$|\/exchange$/.test(u), "a dry run must never sign or submit")
      requests.push({ method: init?.method ?? "GET", path: new URL(u).pathname,
        ...(body ? { body: Object.fromEntries(Object.entries(body).filter(([k]) => ["coin", "type", "dex", "operation"].includes(k))) } : {}) })
      return Response.json(f.route(u, body))
    }
    const args = { coin: "xyz:TSLA", [leg === "tp" ? "takeProfit" : "stopLoss"]: f.triggerPx, submit: false }
    let result: any
    if (surface === "sdk") {
      const client = new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0, hyperliquidBuilder: builder })
      result = await client.perpsTpsl({ ...args, walletId: "wallet", privyWalletId: "fixture-privy" })
    } else {
      globalThis.fetch = fetcher as typeof fetch
      const server = createCandleMcpServer({ CANDLE_HYPERLIQUID_BUILDER: builder }, cfg)
      const client = new Client({ name: "harness-perps-recorder", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(b); await client.connect(a)
      try {
        const r: any = await client.callTool({ name: "candle_perps_tpsl", arguments: { ...args, wallet: "wallet" } })
        assert.equal(r.isError === true, false, JSON.stringify(r))
        result = JSON.parse(r.content[0].text)
      } finally { await client.close(); await server.close(); globalThis.fetch = deny }
    }
    assert.equal(result.complete, false)
    assert.equal(f.events.some((e: string) => e === "sign" || e === "exchange"), false)
    rows.push({ id: `${surface}-tpsl-${leg}-${replace ? "replace" : "attach"}`, surface, args, requests,
      outcome: { complete: result.complete, steps: result.steps.map((s: any) => ({ status: s.status, ...(s.preview ? { preview: s.preview } : {}) })), warnings: result.warnings } })
  }
  const refusalCases = [
    { id: "isolated-cross", method: "leverage", args: { coin: "xyz:TSLA", leverage: 5, mode: "cross" }, refusal: { ok: false, code: "VALIDATION_FAILED", limit: "mode", message: "xyz:TSLA trades isolated margin only", status: 400 } },
    { id: "above-max", method: "leverage", args: { coin: "xyz:TSLA", leverage: 11, mode: "isolated" }, refusal: { ok: false, code: "PERPS_LIMIT_EXCEEDED", limit: "marketMaxLeverage", message: "xyz:TSLA allows at most 10x", status: 403 } },
    { id: "delisted", method: "open", args: { coin: "xyz:DELIST", side: "long", size: "0.1" }, refusal: resolvePerpsMarket(xyz, "xyz:DELIST", config) },
    { id: "collateral", method: "open", args: { coin: "usdh:COIN", side: "long", size: "0.1" }, refusal: resolvePerpsMarket({ ...universes.usdh, ctxs: [context], dex: parsePerpDexs(dexes)[2] }, "usdh:COIN", config) },
    { id: "halted-open", method: "open", args: { coin: "xyz:TSLA", side: "long", size: "0.1" }, refusal: resolvePerpsMarket(xyz, "xyz:TSLA", halted) },
  ]
  // The two leverage responses mirror agent-perps.ts /leverage's inline guards. The remaining
  // refusals, and the close admission above, come from the actual merged pure API gate.
  for (const c of refusalCases) {
    assert.equal(c.refusal.ok, false)
    for (const surface of ["cli", "mcp", "sdk"] as const) {
      const requests: Request[] = []
      const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(cfg.apiUrl, "")
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ method: init?.method ?? "GET", path, ...(body ? { body } : {}) })
        if (path === "/api/v1/agent/wallets/embedded") return Response.json({ embeddedWalletPermission: "allowed", wallets: { evm: { address: fakeAddress("9") } } })
        assert.equal(path, `/api/v1/agent/perps/${c.method}`)
        assert.equal(init?.method, "POST")
        assert.equal(body.coin, c.args.coin)
        return Response.json({ success: false, error: { code: c.refusal.code, message: c.refusal.message, limit: c.refusal.limit } }, { status: c.refusal.status })
      }
      let outcome: any
      if (surface === "mcp") {
        globalThis.fetch = fetcher as typeof fetch
        const server = createCandleMcpServer({}, cfg)
        const client = new Client({ name: "harness-perps-recorder", version: "1" })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(b); await client.connect(a)
        try {
          const r: any = await client.callTool({ name: `candle_perps_${c.method}`, arguments: { ...c.args, wallet: "embedded", submit: false, ...(c.method === "open" ? { clientId: `0x${"1".repeat(32)}` } : {}) } })
          outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
        } finally { await client.close(); await server.close(); globalThis.fetch = deny }
      } else if (surface === "sdk") {
        const client = new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0 })
        try { await client[c.method === "open" ? "perpsOpen" : "perpsLeverage"]({ ...c.args, walletId: "embedded", submit: false, ...(c.method === "open" ? { clientId: `0x${"1".repeat(32)}` } : {}) }); throw new Error("expected refusal") }
        catch (e: any) { outcome = { isError: true, body: { error: { code: e.code, message: e.message } } } }
      } else {
        const stdout = createCapture(), stderr = createCapture()
        const deps = createTestDeps({ stdout, stderr, now: () => NOW, env: { CANDLE_API_KEY: cfg.apiKey }, fetch: fetcher })
        const args = c.method === "leverage" ? [c.args.coin, String(c.args.leverage), ...(c.args.mode === "isolated" ? ["--isolated"] : [])] : [c.args.coin, "long", "0.1", "--client-id", `0x${"1".repeat(32)}`]
        const exitCode = await cliWrites[c.method === "open" ? "perpsOpen" : "perpsLeverage"]([...args, "--wallet", "embedded", "--yes"], { deps, apiUrl: cfg.apiUrl, json: true })
        outcome = { exitCode, body: JSON.parse(stdout.text), isError: exitCode !== 0 }
      }
      assert.equal(outcome.isError, true, `${surface}-${c.id}`)
      assert.ok(JSON.stringify(outcome.body).includes(c.refusal.code), `${surface}-${c.id} preserves refusal code`)
      assert.equal(requests.filter((r) => r.method === "POST").length, 1)
      rows.push({ id: `${surface}-${c.id}`, evidence: c.method === "leverage" ? "response-stub: inline leverage guard mirrored; keyed API route not executed" : "response-stub: generated by pure perps gate; keyed API route not executed", surface, args: c.args, requests, outcome })
    }
  }
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-source.json"), `${JSON.stringify({
    about: "Offline CLI, registered MCP and SDK builder-dex follow-up contracts from exact merged source. All venue data is synthetic. CLI confirmation uses an ephemeral in-memory key, declines or intercepts the relay before signing, and records no authorization. MCP/SDK TP/SL are dry runs. Build refusals are response stubs: delisted, collateral and halted-open are generated by the pure API gate; cross-margin and market leverage-cap responses mirror inline guards. The keyed API route is not executed. No funded account, transaction signing, submission or deployed behavior is claimed.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline perps contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch; Date.now = originalNow }
