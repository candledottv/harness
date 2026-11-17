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
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-source-contracts.json"), `${JSON.stringify({ about: "Synthetic response stubs exercised through the actual MCP/SDK source, with network disabled. No deployed behavior is claimed. Embedded perps stops at a local refusal before build/sign/send.", source: { repo: "candledottv/candle-monorepo", commit }, rows }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline MCP/SDK scenarios from ${commit}.`)
} finally { globalThis.fetch = originalFetch }
