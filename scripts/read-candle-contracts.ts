// Records MCP/SDK behavior against local response stubs. No real credentials, hosts or writes.
// Complements tools/list from read-mcp-source.ts; every unexpected request fails closed.
//   bun scripts/read-candle-contracts.ts <candle-monorepo checkout>
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-candle-contracts.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/mcp", "packages/sdk", "apps/api/src/lib/perps-gate.ts")
const commit = git("rev-parse", "HEAD")
const load = (path: string) => import(pathToFileURL(join(checkout, "packages", path)).href)
const originalFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error("contract recording may not access the network") }) as unknown as typeof fetch
try {
  const { launchCheck, launchExecutionArgs } = await load("mcp/src/launch-check.ts")
  const { executeSignalRecordTool } = await load("mcp/src/signal-record-tools.ts")
  const { executePerps } = await load("mcp/src/perps.ts")
  const { CandleClient } = await load("sdk/src/client.ts")
  const { launchBody } = await load("sdk/src/launch-input.ts")
  const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
  const preflight = {
    success: true,
    key: { keyPrefix: "FakeKey1", scopes: ["launch:write"], tier: "pro", selfLaunch: false, embeddedWalletPermission: "allowed" },
    switches: { headlessLaunch: true, agentTrading: true, teeLaunchBuys: false },
    embedded: { solana: { address: "WalletFake111111111111111111111111111111111", delegated: true } },
    wallets: [],
  }
  const rows: Record<string, unknown>[] = []
  for (const state of ["available", "paused", "split", "old-server"] as const) {
    const args = state === "available" ? { check: true } : { check: true, quote: "ACME" }
    const answer = state === "available" || state === "old-server" ? preflight : {
      ...preflight,
      quote: { requested: "ACME", ok: false, executionEnabled: false, disclosure: "Issuer may pause transfers.", checks: [{ check: state, status: "refuse", code: state === "paused" ? "QUOTE_PAUSED" : "QUOTE_SPLIT", message: state === "paused" ? "Quote token is paused." : "Quote token is in a split hold." }] },
    }
    for (const surface of ["mcp", "sdk"] as const) {
      const requests: { method: string; path: string }[] = []
      const fetcher = async (url: string, init?: RequestInit) => {
        assert.equal(init?.method, "GET")
        const path = url.replace(cfg.apiUrl, "")
        assert.equal(path, args.quote ? "/api/v1/launch/preflight?quote=ACME" : "/api/v1/launch/preflight")
        requests.push({ method: "GET", path })
        return new Response(JSON.stringify(answer), { status: 200 })
      }
      let outcome
      if (surface === "mcp") {
        const r = await launchCheck(args, cfg, fetcher)
        outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
      } else {
        const client = new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0 })
        try { outcome = { body: await client.launch(args), isError: false } }
        catch (e: any) { outcome = { body: { error: { code: e.code } }, isError: true } }
      }
      assert.equal(requests.length, 1)
      if (state === "available") assert.equal(outcome.body.works, true)
      else if (state === "old-server") assert.equal(outcome.body.error.code, "QUOTE_CHECK_UNAVAILABLE")
      else { assert.equal(outcome.body.works, false); assert.equal(outcome.body.quote.executionEnabled, false) }
      rows.push({ id: `${surface}-launch-${state}`, surface, tool: "candle_launch_token", args, requests, outcome })
    }
  }
  for (const surface of ["mcp", "sdk"]) {
    const args = { check: true, dryRun: true }
    const requests: unknown[] = []
    const neverFetch = async () => { requests.push("unexpected"); throw new Error("conflicting controls must not request anything") }
    let outcome
    if (surface === "mcp") {
      const r = await launchCheck(args, cfg, neverFetch)
      outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
    } else {
      const client = new CandleClient({ ...cfg, fetch: neverFetch, maxRetries: 0 })
      try { outcome = { body: await client.launch(args), isError: false } }
      catch (e: any) { outcome = { body: { error: { code: e.code } }, isError: true } }
    }
    assert.equal(outcome.body.error.code, "VALIDATION_FAILED")
    assert.deepEqual(requests, [])
    rows.push({ id: `${surface}-launch-conflict`, surface, tool: "candle_launch_token", args, requests, outcome })
  }
  for (const [tool, args] of [
    ["candle_signal_scorecard", {}],
    ["candle_signal_records", { source: "pattern", before: 12, limit: 5 }],
    ["candle_signal_record", { source: "pattern", source_id: "fake-signal" }],
  ] as const) {
    const requests: { method: string; path: string }[] = []
    const r = await executeSignalRecordTool(tool, args, { ...cfg, apiKey: ["cndl", "live", "fixture-only"].join("_") }, { CANDLE_HACC_URL: "https://hacc.test" }, async (url: string, init?: RequestInit) => {
      assert.equal(init?.method, "GET")
      assert.ok(url.startsWith("https://hacc.test/v1/public/"))
      requests.push({ method: "GET", path: url.replace("https://hacc.test", "") })
      // The upstream client must add its mandatory measured-record disclosure to this stub.
      return new Response(JSON.stringify({ records: [], next_before: null }), { status: 200 })
    })
    const outcome = { body: JSON.parse(r.text), isError: r.isError }
    assert.equal(outcome.body.measure, "Measured record, not a forecast.")
    assert.equal(requests.length, 1)
    rows.push({ id: tool, surface: "mcp", tool, args, requests, outcome })
  }
  for (const input of [{ quote: "USDC" }, { quote: "ETH" }, { quote: "ACME" }, { quote: "USDC", chain: "hood" }, { quote: "SOL", quoteAsset: "sol" }]) {
    const normalized = (fn: (args: unknown) => unknown) => {
      try { return { ok: true, args: fn(input) } } catch (e: any) { return { ok: false, code: e.code } }
    }
    const mcp = normalized(launchExecutionArgs)
    const sdk = normalized(launchBody)
    assert.deepEqual(mcp, sdk)
    rows.push({ id: `fixed-${rows.length}`, surface: "mcp+sdk", input, outcome: mcp })
  }
  const tee = { id: "tee-one", address: "0x00000000000000000000000000000000000e7ee1", chain: "evm", privyWalletId: "fake-privy", label: "perps" }
  for (const which of ["tee-no-pem", "unknown-wallet", "embedded-no-pem", "embedded-denied"] as const) {
    const requests: { method: string; path: string }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      assert.ok(url.startsWith(cfg.apiUrl))
      const path = url.slice(cfg.apiUrl.length)
      requests.push({ method: init?.method ?? "GET", path })
      if (path === "/api/v1/agent/wallets/trading") return new Response(JSON.stringify({ scopes: ["perps:write"], page: [tee], isDone: true, privyAppId: "fake-app" }))
      if (path === "/api/v1/agent/wallets/embedded") return new Response(JSON.stringify({ embeddedWalletPermission: which === "embedded-denied" ? "denied" : "allowed", wallets: { evm: { address: "0x00000000000000000000000000000000000e3b01" } } }))
      if (path === "/api/v1/agent/perps/cancel" && init?.method === "POST") return new Response(JSON.stringify({ success: false, error: { code: "FIXTURE_BUILD_STOP", message: "Local stub stops before any build or sign." } }), { status: 400 })
      throw new Error(`unexpected local request: ${path}`)
    }
    const args = { wallet: which.startsWith("embedded") ? "embedded" : which === "unknown-wallet" ? "missing" : "perps", cloid: `0x${"a".repeat(32)}` }
    const r = await executePerps("candle_perps_cancel", args, cfg, {}, fetcher)
    const outcome = { body: JSON.parse(r.text), isError: r.isError === true }
    const codes = { "tee-no-pem": "SIGNER_UNAVAILABLE", "unknown-wallet": "TEE_WALLET_REQUIRED", "embedded-no-pem": "FIXTURE_BUILD_STOP", "embedded-denied": "AGENT_WALLET_MISSING" }
    assert.equal(outcome.body.error.code, codes[which])
    rows.push({ id: `perps-${which}`, surface: "mcp", tool: "candle_perps_cancel", args, requests, outcome })
  }
  // Per-order hide (BE-3675, #3871): the echo check and the refusal paths, MCP and SDK. A body without
  // `hide` is public, so a request that asked for hide must see the API's `hide: true` echo.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
  const { createCandleMcpServer } = await load("mcp/src/server.ts")
  type Stub = (path: string, body: Record<string, unknown>) => unknown
  const hideStub = (echo: { dry: boolean; live: boolean }): Stub => (path, body) => {
    if (path === "/api/v1/launch/headless/dry-run") return { success: true, works: true, ...(echo.dry ? { hide: true } : {}) }
    if (path === "/api/v1/launch/headless") return { success: true, mint: "FakeMint1111", ...(echo.live ? { hide: true } : {}) }
    if (path === "/api/v1/agent/swap") return { success: true, payload: { hashes: ["fakehash"], expectedOutRaw: "1", outDecimals: 6 }, ...(echo.live ? { hide: true } : {}) }
    throw new Error(`unexpected local request: ${path} ${JSON.stringify(body)}`)
  }
  const seen = (requests: { method: string; path: string; body: Record<string, unknown> }[]) =>
    requests.map((r) => ({ method: r.method, path: r.path, hide: r.body.hide ?? null }))
  const swapArgs = { from: "SOL", to: "USDC", amount: "0.5", clientSwapId: "fixture-swap-1" }
  const swapSdk = { from: "SOL", to: "USDC", amountRaw: "500000000", clientSwapId: "fixture-swap-1" }
  const launchArgs = { name: "Fixture Token", symbol: "FIXT", chain: "solana", imageUrl: "https://example.test/fixture.png", clientLaunchId: "fixture-launch-1" }
  const hideCases: { id: string; tool: string; args: Record<string, unknown>; echo: { dry: boolean; live: boolean } }[] = [
    { id: "swap-public", tool: "candle_swap", args: swapArgs, echo: { dry: false, live: false } },
    { id: "swap-hide-echoed", tool: "candle_swap", args: { ...swapArgs, hide: true }, echo: { dry: false, live: true } },
    { id: "swap-hide-unconfirmed", tool: "candle_swap", args: { ...swapArgs, hide: true }, echo: { dry: false, live: false } },
    { id: "launch-public", tool: "candle_launch_token", args: launchArgs, echo: { dry: false, live: false } },
    { id: "launch-hide-echoed", tool: "candle_launch_token", args: { ...launchArgs, hide: true }, echo: { dry: true, live: true } },
    { id: "launch-hide-dry-run-no-echo", tool: "candle_launch_token", args: { ...launchArgs, hide: true }, echo: { dry: false, live: true } },
    { id: "launch-hide-live-no-echo", tool: "candle_launch_token", args: { ...launchArgs, hide: true }, echo: { dry: true, live: false } },
    { id: "launch-dry-run-hide-echoed", tool: "candle_launch_token", args: { ...launchArgs, hide: true, dryRun: true }, echo: { dry: true, live: false } },
  ]
  for (const c of hideCases) {
    for (const surface of ["mcp", "sdk"] as const) {
      const requests: { method: string; path: string; body: Record<string, unknown> }[] = []
      const stub = hideStub(c.echo)
      const fetcher = async (url: string, init?: RequestInit) => {
        assert.ok(String(url).startsWith(cfg.apiUrl))
        const path = String(url).slice(cfg.apiUrl.length)
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        requests.push({ method: init?.method ?? "GET", path, body })
        return new Response(JSON.stringify(stub(path, body)), { status: 200 })
      }
      let outcome: { body: any; isError: boolean }
      if (surface === "mcp") {
        globalThis.fetch = fetcher as unknown as typeof fetch
        const server = createCandleMcpServer({}, cfg)
        const client = new Client({ name: "harness-source-recorder", version: "1" })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(b)
        await client.connect(a)
        try {
          const r: any = await client.callTool({ name: c.tool, arguments: c.args })
          outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
        } finally {
          globalThis.fetch = (() => { throw new Error("contract recording may not access the network") }) as unknown as typeof fetch
          await client.close()
          await server.close()
        }
      } else {
        const client = new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0 })
        try {
          const { amount: _amount, ...sdkArgs } = c.args
          const body = c.tool === "candle_swap"
            ? await client.swap({ ...swapSdk, ...(c.args.hide ? { hide: true } : {}) } as never)
            : c.args.dryRun ? await client.dryRunLaunch(sdkArgs as never) : await client.launch(sdkArgs as never)
          outcome = { body, isError: false }
        } catch (e: any) { outcome = { body: { error: { code: e.code } }, isError: true } }
      }
      const asked = c.args.hide === true
      const refused = outcome.isError
      const expectRefusal = asked && (c.id === "swap-hide-unconfirmed" || c.id === "launch-hide-live-no-echo" || c.id === "launch-hide-dry-run-no-echo")
      assert.equal(refused, expectRefusal, `${surface}-${c.id}`)
      if (expectRefusal) assert.ok(JSON.stringify(outcome.body).includes("HIDE_NOT_CONFIRMED"), `${surface}-${c.id} names HIDE_NOT_CONFIRMED`)
      // A public order never sends the field; a dry run that did not echo stops a live launch before it is sent.
      if (!asked) assert.ok(requests.every((r) => r.body.hide === undefined))
      if (c.id === "launch-hide-dry-run-no-echo") assert.deepEqual(requests.map((r) => r.path), ["/api/v1/launch/headless/dry-run"])
      rows.push({ id: `hide-${surface}-${c.id}`, surface, tool: c.tool, args: c.args, requests: seen(requests), outcome })
    }
  }
  {
    // hide:"maybe" is refused before any request, and hide with paper is refused in MCP.
    const requests: unknown[] = []
    const never = async () => { requests.push("unexpected"); throw new Error("a refusal must not request anything") }
    const client = new CandleClient({ ...cfg, fetch: never, maxRetries: 0 })
    let sdkOutcome
    try { sdkOutcome = { body: await client.swap({ ...swapSdk, hide: "maybe" } as never), isError: false } }
    catch (e: any) { sdkOutcome = { body: { error: { code: e.code } }, isError: true } }
    assert.equal(sdkOutcome.isError, true)
    assert.deepEqual(requests, [])
    rows.push({ id: "hide-sdk-swap-unreadable", surface: "sdk", tool: "candle_swap", args: { ...swapSdk, hide: "maybe" }, requests, outcome: sdkOutcome })
    globalThis.fetch = never as unknown as typeof fetch
    const server = createCandleMcpServer({}, cfg)
    const mcp = new Client({ name: "harness-source-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await mcp.connect(a)
    const args = { mint: "FakeMint1111", side: "buy", amount: "0.1", paper: true, hide: true, clientTradeId: "fixture-trade-1" }
    let r: any
    try { r = await mcp.callTool({ name: "candle_trade", arguments: args }) } finally {
      globalThis.fetch = (() => { throw new Error("contract recording may not access the network") }) as unknown as typeof fetch
      await mcp.close(); await server.close()
    }
    const outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
    assert.equal(outcome.isError, true)
    assert.deepEqual(requests, [])
    rows.push({ id: "hide-mcp-trade-paper", surface: "mcp", tool: "candle_trade", args, requests, outcome })
  }
  // Builder-deployed (HIP-3) perps markets (BE-3755, #3924): dex:COIN names, per-dex universes and the terms shown
  // before an order, through the MCP market tools and the SDK, against a synthetic Hyperliquid and Candle config.
  // Made-up dexes, addresses and figures. Dex 1 "xyz" is USDC-collateralised; dex 2 "usdt" is not; dex 3 "halt" is on
  // Candle's per-dex kill switch. No order, signature or venue write.
  {
    const { createPerpsMarketExecutor } = await load("mcp/src/perps-markets.ts")
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
    const dexes = [
      null,
      { name: "xyz", fullName: "XYZ Fixture", deployer: addr(0xd1), oracleUpdater: null, subDeployers: [["setOracle", [addr(0x0a1)]]] },
      { name: "usdt", fullName: "USDT Fixture", deployer: addr(0xd2), oracleUpdater: addr(0x0a2) },
      { name: "halt", fullName: "Halted Fixture", deployer: addr(0xd3), oracleUpdater: null },
    ]
    const ctx = (markPx: string, openInterest: string) => ({ markPx, midPx: markPx, oraclePx: markPx, openInterest, funding: "0.0000125", dayNtlVlm: "5000000", prevDayPx: markPx, premium: "0", impactPxs: [markPx, markPx] })
    const universes: Record<string, unknown> = {
      "": [{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [ctx("60000", "100")]],
      xyz: [
        { universe: [
          { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10, marginMode: null, deployerFeeScale: "0.5" },
          { name: "xyz:GOLD", szDecimals: 4, maxLeverage: 20, marginMode: "strictIsolated", deployerFeeScale: "1.5" },
          { name: "xyz:OLD", szDecimals: 2, maxLeverage: 5, isDelisted: true },
        ], collateralToken: 0 },
        [ctx("250", "10000"), ctx("2500", "1000"), ctx("1", "0")],
      ],
      usdt: [{ universe: [{ name: "usdt:SPX", szDecimals: 2, maxLeverage: 25 }], collateralToken: 268 }, [ctx("6000", "1000")]],
      halt: [{ universe: [{ name: "halt:OIL", szDecimals: 2, maxLeverage: 10 }], collateralToken: 0 }, [ctx("80", "100000")]],
    }
    const venue = (requests: { method: string; path: string; body?: unknown }[]) => async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u === `${cfg.apiUrl}/api/v1/agent/perps/config`) {
        requests.push({ method: init?.method ?? "GET", path: "/api/v1/agent/perps/config" })
        return new Response(JSON.stringify({ network: "mainnet", limits: { minOpenInterestUsd: 1_000_000, dexOpensRefused: ["halt"] } }))
      }
      assert.equal(u, "https://api.hyperliquid.xyz/info")
      assert.equal(init?.method, "POST")
      const body = JSON.parse(String(init?.body)) as { type: string; dex?: string }
      requests.push({ method: "POST", path: "hyperliquid:/info", body })
      if (body.type === "perpDexs") return new Response(JSON.stringify(dexes))
      if (body.type === "metaAndAssetCtxs") return new Response(JSON.stringify(universes[body.dex ?? ""] ?? null))
      if (body.type === "predictedFundings" || body.type === "perpsAtOpenInterestCap") return new Response("[]")
      throw new Error(`unexpected local venue request: ${JSON.stringify(body)}`)
    }
    const cases: { id: string; tool: "candle_perps_markets" | "candle_perps_market"; args: Record<string, unknown> }[] = [
      { id: "markets-main", tool: "candle_perps_markets", args: { all: true } },
      { id: "markets-xyz", tool: "candle_perps_markets", args: { dex: "xyz", all: true } },
      { id: "markets-all", tool: "candle_perps_markets", args: { dex: "all", all: true } },
      { id: "markets-all-tradeable", tool: "candle_perps_markets", args: { dex: "all" } },
      { id: "markets-bad-dex", tool: "candle_perps_markets", args: { dex: "x-y" } },
      { id: "market-tsla", tool: "candle_perps_market", args: { coin: "xyz:TSLA" } },
      { id: "market-gold", tool: "candle_perps_market", args: { coin: "xyz:GOLD" } },
      { id: "market-delisted", tool: "candle_perps_market", args: { coin: "xyz:OLD" } },
      { id: "market-usdt", tool: "candle_perps_market", args: { coin: "usdt:SPX" } },
      { id: "market-halted", tool: "candle_perps_market", args: { coin: "halt:OIL" } },
      { id: "market-unknown-dex", tool: "candle_perps_market", args: { coin: "nope:TSLA" } },
      { id: "market-malformed", tool: "candle_perps_market", args: { coin: "xyz:TS-LA" } },
      { id: "market-main", tool: "candle_perps_market", args: { coin: "BTC" } },
    ]
    for (const c of cases) {
      for (const surface of ["mcp", "sdk"] as const) {
        const requests: { method: string; path: string; body?: unknown }[] = []
        const fetcher = venue(requests)
        let outcome: { body: any; isError: boolean }
        if (surface === "mcp") {
          const execute = createPerpsMarketExecutor(() => cfg, {}, fetcher, () => 1_700_000_000_000)
          const r = await execute(c.tool, c.args)
          outcome = { body: JSON.parse(r.text), isError: r.isError === true }
        } else {
          const client = new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0 })
          try {
            const body = c.tool === "candle_perps_markets" ? await client.perpsMarkets(c.args as never) : await client.perpsMarket(c.args.coin as string)
            outcome = { body, isError: false }
          } catch (e: any) { outcome = { body: { success: false, error: { code: e.code, message: e.message } }, isError: true } }
        }
        // Read times are the local clock's: kept out so a re-record is byte-stable.
        if (outcome.body && typeof outcome.body === "object") delete outcome.body.readAt
        rows.push({ id: `hip3-${surface}-${c.id}`, surface, tool: c.tool, args: c.args, requests, outcome })
      }
    }
    // The API's own gate source (apps/api/src/lib/perps-gate.ts), run on the same synthetic universes: the kill
    // switch refuses opens on a named dex, the closing config never reads it, and the other refusals hold on both.
    const gate = await import(pathToFileURL(join(checkout, "apps/api/src/lib/perps-gate.ts")).href)
    const { parsePerpDexs } = await load("sdk/src/hyperliquid-markets.ts")
    const parsed = parsePerpDexs(dexes) as { name: string }[]
    const marketsOf = (dex: string) => {
      const [meta, ctxs] = universes[dex] as [{ universe: unknown[]; collateralToken?: number }, unknown[]]
      return { universe: meta.universe, ctxs, ...(dex ? { dex: parsed.find((d) => d.name === dex), collateralToken: meta.collateralToken ?? 0 } : {}) }
    }
    const open = gate.perpsGateConfig({ HYPERLIQUID_DEX_OPENS_REFUSED: "halt" })
    const closing = gate.closingGateConfig(open)
    for (const [dex, coin] of [["halt", "halt:OIL"], ["xyz", "xyz:TSLA"], ["xyz", "xyz:GOLD"], ["xyz", "xyz:OLD"], ["usdt", "usdt:SPX"], ["xyz", "xyz:TS-LA"], ["", "xyz:TSLA"], ["", "BTC"]] as const) {
      for (const [which, config] of [["open", open], ["closing", closing]] as const) {
        const r = gate.resolvePerpsMarket(marketsOf(dex), coin, config)
        const outcome = r.ok
          ? { ok: true, market: { asset: r.market.asset, coin: r.market.coin, dex: r.market.dex, maxLeverage: r.market.maxLeverage, onlyIsolated: r.market.onlyIsolated, terms: r.market.terms } }
          : { ok: false, code: r.code, limit: r.limit, message: r.message, status: r.status }
        rows.push({ id: `hip3-gate-${which}-${dex || "main"}-${coin}`, surface: "api-gate", universe: dex || "main", coin, config: which, outcome })
      }
    }
  }
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-source-contracts.json"), `${JSON.stringify({ about: "Synthetic response stubs exercised through the actual MCP/SDK source, with network disabled. No deployed behavior is claimed. Embedded perps stops at a local refusal before build/sign/send. Builder-dex (HIP-3) rows read a synthetic Hyperliquid with made-up dexes and addresses; api-gate rows run the API gate source on the same universes.", source: { repo: "candledottv/candle-monorepo", commit }, rows }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline MCP/SDK scenarios from ${commit}.`)
} finally { globalThis.fetch = originalFetch }
