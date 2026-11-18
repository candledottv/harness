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
git("diff", "--exit-code", "HEAD", "--", "packages/mcp", "packages/sdk")
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
  // Perp position pages (BE-3756, candle-monorepo #3922): a round's fills, funding and fees, the agent's open orders
  // and a coin's cached candles, MCP and SDK. Public keyless reads: one GET each, no credential, no wallet, order id or
  // cloid in anything the stub answers or the Harness records. Fixture values only; no real agent, wallet or hash.
  {
    const fakeHash = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`
    const round = (id: string, coin: string, dex: string | null) => ({
      success: true, seq: 7,
      round: {
        id, coin, dex, side: "long", outcome: "won", leverage: { value: 20, type: "cross" },
        openedMs: 1_760_000_000_000, closedMs: 1_760_003_600_000, durationMs: 3_600_000,
        size: { peak: "0.5", current: "0" }, entryAvgPx: "100.0", exitAvgPx: "110.0", markPx: null, liquidationPx: "95.5",
        initialMarginUsd: 2.5, returnOnMargin: 0.4, realizedUsd: 5, unrealizedUsd: null, fundingUsd: -0.01,
        hyperliquidFeesUsd: 0.02, builderFeesUsd: 0.005, pnlUsd: 4.965,
        fills: [
          { time: 1_760_000_000_000, side: "buy", role: "open", dir: "Open Long", px: "100.0", sz: "0.5", positionAfter: "0.5", feeUsd: 0.01, closedPnlUsd: 0, liquidated: false, hash: fakeHash(1) },
          { time: 1_760_003_600_000, side: "sell", role: "close", dir: "Close Long", px: "110.0", sz: "0.5", positionAfter: "0", feeUsd: 0.01, closedPnlUsd: 5, liquidated: false, hash: fakeHash(2) },
        ],
        funding: [{ time: 1_760_001_800_000, usd: -0.01, rate: "0.0000125", hash: fakeHash(3) }],
        complete: true, asOfMs: 1_760_003_700_000,
      },
    })
    const orders = (list: unknown[]) => ({ success: true, orders: list, readAt: 1_760_003_700_000, stale: false, dexes: list.length ? ["xyz"] : [], seq: 7 })
    const order = (kind: string, side: string, limitPx: string | null, triggerPx: string | null, condition: string | null) => ({
      coin: "xyz:TSLA", dex: "xyz", kind, side, limitPx, triggerPx, triggerCondition: condition, size: "0.5", originalSize: "0.5",
      reduceOnly: kind !== "limit", isPositionTpsl: kind !== "limit", orderType: kind === "limit" ? "Limit" : kind === "take_profit" ? "Take Profit Market" : "Stop Market", placedAtMs: 1_760_000_100_000,
    })
    const candles = (coin: string, interval: string) => ({ success: true, coin, interval, readAt: 1_760_003_700_000, stale: false, candles: [{ t: 1_760_000_000_000, o: "100.0", h: "101.5", l: "99.5", c: "101.0", v: "12.5" }, { t: 1_760_003_600_000, o: "101.0", h: "111.0", l: "100.5", c: "110.0", v: "30.1" }] })
    type PerpCase = { id: string; tool: string; args: Record<string, unknown>; path: string; answer: unknown; sdk: (c: any) => Promise<any> }
    const cases: PerpCase[] = [
      { id: "round-closed", tool: "candle_get_agent_perp_round", args: { profileId: "fixture-agent", roundId: "rnd_0123456789abcdef" }, path: "/api/v1/agent/records/fixture-agent/perps/rounds/rnd_0123456789abcdef", answer: round("rnd_0123456789abcdef", "BTC", null), sdk: (c) => c.getAgentPerpRound("fixture-agent", "rnd_0123456789abcdef") },
      { id: "round-open-builder-dex", tool: "candle_get_agent_perp_round", args: { profileId: "fixture-agent", roundId: "open:xyz:TSLA" }, path: "/api/v1/agent/records/fixture-agent/perps/rounds/open%3Axyz%3ATSLA", answer: round("open:xyz:TSLA", "xyz:TSLA", "xyz"), sdk: (c) => c.getAgentPerpRound("fixture-agent", "open:xyz:TSLA") },
      { id: "open-orders", tool: "candle_get_agent_open_orders", args: { profileId: "fixture-agent" }, path: "/api/v1/agent/records/fixture-agent/open-orders", answer: orders([order("limit", "buy", "90.0", null, null), order("take_profit", "sell", null, "120.0", "Price above 120"), order("stop_loss", "sell", null, "95.0", "Price below 95")]), sdk: (c) => c.getAgentOpenOrders("fixture-agent") },
      { id: "open-orders-none", tool: "candle_get_agent_open_orders", args: { profileId: "fixture-agent" }, path: "/api/v1/agent/records/fixture-agent/open-orders", answer: orders([]), sdk: (c) => c.getAgentOpenOrders("fixture-agent") },
      { id: "candles-default", tool: "candle_get_perp_candles", args: { coin: "BTC" }, path: "/api/v1/agent/perps-candles/BTC", answer: candles("BTC", "1h"), sdk: (c) => c.getPerpCandles("BTC") },
      { id: "candles-builder-dex", tool: "candle_get_perp_candles", args: { coin: "xyz:TSLA", interval: "15m", count: 2, end: 1_760_003_600_000 }, path: "/api/v1/agent/perps-candles/xyz%3ATSLA?interval=15m&count=2&end=1760003600000", answer: candles("xyz:TSLA", "15m"), sdk: (c) => c.getPerpCandles("xyz:TSLA", { interval: "15m", count: 2, end: 1_760_003_600_000 }) },
    ]
    const bodyOf = (r: any) => JSON.parse(r.content[0].text)
    for (const c of cases) {
      for (const surface of ["mcp", "sdk"] as const) {
        const requests: { method: string; path: string; credential: boolean }[] = []
        const fetcher = async (url: string, init?: RequestInit) => {
          assert.ok(String(url).startsWith(cfg.apiUrl))
          const headers = new Headers(init?.headers)
          requests.push({ method: init?.method ?? "GET", path: String(url).slice(cfg.apiUrl.length), credential: headers.has("authorization") || headers.has("x-api-key") })
          return new Response(JSON.stringify(c.answer), { status: 200 })
        }
        let outcome: { body: any; isError: boolean }
        if (surface === "mcp") {
          globalThis.fetch = fetcher as unknown as typeof fetch
          const server = createCandleMcpServer({}, cfg)
          const client = new Client({ name: "harness-source-recorder", version: "1" })
          const [a, b] = InMemoryTransport.createLinkedPair()
          await server.connect(b)
          await client.connect(a)
          try { const r: any = await client.callTool({ name: c.tool, arguments: c.args }); outcome = { body: bodyOf(r), isError: r.isError === true } }
          finally {
            globalThis.fetch = (() => { throw new Error("contract recording may not access the network") }) as unknown as typeof fetch
            await client.close(); await server.close()
          }
        } else {
          const client = new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0 })
          outcome = { body: await c.sdk(client), isError: false }
        }
        assert.equal(outcome.isError, false, `${surface}-${c.id}`)
        assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", c.path]], `${surface}-${c.id} one GET`)
        // The MCP tool sends no credential even when one is configured; the SDK client attaches its own key as it does everywhere.
        if (surface === "mcp") assert.ok(requests.every((r) => !r.credential), `${surface}-${c.id} is keyless`)
        assert.ok(!/"(wallet|address|oid|cloid)"/i.test(JSON.stringify(outcome.body)), `${surface}-${c.id} carries no wallet, order id or cloid`)
        rows.push({ id: `perp-pages-${surface}-${c.id}`, surface, tool: c.tool, args: c.args, requests, outcome })
      }
    }
  }
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-source-contracts.json"), `${JSON.stringify({ about: "Synthetic response stubs exercised through the actual MCP/SDK source, with network disabled. No deployed behavior is claimed. Embedded perps stops at a local refusal before build/sign/send.", source: { repo: "candledottv/candle-monorepo", commit }, rows }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline MCP/SDK scenarios from ${commit}.`)
} finally { globalThis.fetch = originalFetch }
