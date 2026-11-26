// Hyperliquid spot (HM2, BE-3772, the harness sibling of BE-3771) recorded from the PUBLISHED npm packages
// (`scripts/spot-packages.json`): `@candledottv/agent-sdk` 0.6.39, `@candledottv/mcp` 0.10.45, `@candledottv/cli`
// 0.13.47. The card's own version numbers (SDK 0.6.34 and 0.6.36, CLI 0.13.44, MCP 0.10.43) were never published
// separately; these are the first published versions that carry them.
//   - SDK: `perpsSpotMarkets`, `perpsSpotBalances`, `perpsSpotOrder` (with `hide` and the HIDE_NOT_CONFIRMED echo
//     check) and `perpsSpotCancel` RUN over an intercepted fetch; `getAgentPositions` and `getAgentRecord` run on a
//     made-up body carrying both the chain and the Hyperliquid spot shapes.
//   - CLI and MCP: the shipped `dist/index.js` is read as text, each pin names the symbol it was found at.
// Packages install from the npm registry when no `<dir>` is passed (the only network use); every Candle API call is
// answered in memory. No wallet, key or account value: only made-up fixture ids.
//   bun scripts/run-spot-packages.ts            installs the pins into a temp dir, writes the fixture
//   bun scripts/run-spot-packages.ts <dir>      reuses a dir that already holds the pinned install
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const pins = JSON.parse(readFileSync(join(import.meta.dir, "spot-packages.json"), "utf8")) as Record<string, string>
const workDir = mkdtempSync(join(tmpdir(), "spot-pkgs-"))
const installDir = process.argv[2] ? resolve(process.argv[2]) : join(workDir, "install")

const API = "https://api.fixture.test"
const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
const WALLET = "wallet-fixture"
const CLOID = `0x${"1".repeat(32)}`
const KEY = "fixture-only-not-a-key"

type Row = { id: string; scenario: "sdk-run" | "sdk-read" | "package-text"; surface: "sdk" | "cli" | "mcp"; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []
const record = (id: string, scenario: Row["scenario"], surface: Row["surface"], args: Row["args"], outcome: Row["outcome"]) => rows.push({ id, scenario, surface, args, outcome })

const originalFetch = globalThis.fetch
try {
  if (!process.argv[2]) {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "spot-published", private: true, type: "module" })}\n`)
    const add = Bun.spawnSync([process.execPath, "add", "--exact", "--ignore-scripts", ...Object.entries(pins).map(([n, v]) => `${n}@${v}`)], { cwd: installDir, stderr: "pipe", stdout: "pipe" })
    if (add.exitCode !== 0) throw new Error(`install of the pinned packages failed: ${add.stderr.toString()}`)
  }
  globalThis.fetch = (() => { throw new Error("spot package recording may not access the network") }) as unknown as typeof fetch

  const pkgDir = (name: string) => join(installDir, "node_modules", name)
  const manifest = (name: string) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8"))
  const lockText = existsSync(join(installDir, "bun.lock")) ? readFileSync(join(installDir, "bun.lock"), "utf8") : ""
  const packages = Object.fromEntries(Object.entries(pins).map(([name, version]) => {
    assert.equal(manifest(name).version, version, `${name} must be installed at the pinned ${version}`)
    const integrity = lockText.match(new RegExp(`"${name}@${version.replace(/\./g, "\\.")}", "[^"]*", [^\\n]*?"(sha512-[^"]+)"`))?.[1]
    return [name, { version, ...(integrity ? { integrity } : {}) }]
  }))
  const entry = (name: string, bin?: string) => join(pkgDir(name), bin ? manifest(name).bin[bin] : manifest(name).main)
  const sdk = await import(pathToFileURL(entry("@candledottv/agent-sdk")).href)
  const { CandleClient } = sdk
  assert.equal(typeof CandleClient, "function")
  const text = {
    sdk: readFileSync(entry("@candledottv/agent-sdk"), "utf8"),
    sdkTypes: readFileSync(join(pkgDir("@candledottv/agent-sdk"), "dist/client.d.ts"), "utf8"),
    cli: readFileSync(entry("@candledottv/cli", "candle"), "utf8"),
    mcp: readFileSync(entry("@candledottv/mcp", "candle-mcp"), "utf8"),
  }

  type Call = { method: string; path: string; body: Record<string, unknown> | null }
  const makeClient = (respond: (call: Call) => unknown, calls: Call[]) =>
    new CandleClient({
      apiUrl: API, apiKey: KEY, hyperliquidBuilder: BUILDER, maxRetries: 0,
      fetch: (async (input: unknown, init?: RequestInit) => {
        const call = { method: init?.method ?? "GET", path: String(input).replace(API, ""), body: init?.body ? JSON.parse(String(init.body)) : null }
        calls.push(call)
        return new Response(JSON.stringify(respond(call)), { status: 200, headers: { "content-type": "application/json" } })
      }) as unknown as typeof fetch,
    })
  const refusal = async (f: () => Promise<unknown>) => { try { await f(); return null } catch (e) { return { code: (e as { code?: string }).code ?? null, message: (e as Error).message.slice(0, 160) } } }

  // 1. Spot orders over an intercepted fetch: the build lacks the hide echo.
  const unechoed = { success: true, perpOrderId: "spot-fixture", kind: "spotOrder", network: "mainnet", walletId: WALLET, cloid: CLOID }
  {
    const calls: Call[] = []
    const refused = await refusal(() => makeClient(() => unechoed, calls).perpsSpotOrder({ walletId: WALLET, market: "HYPE/USDC", side: "buy", size: "1", hide: true }))
    assert.equal(calls.length, 1)
    assert.equal(refused?.code, "HIDE_NOT_CONFIRMED")
    record("sdk-spot-order-hide-without-echo-refused", "sdk-run", "sdk", { method: "perpsSpotOrder", market: "HYPE/USDC", hide: true, buildEchoesHide: false },
      { refused, requests: calls.map((c) => ({ method: c.method, path: c.path, sendsHide: c.body?.hide === true })) })
  }
  {
    // By @index too: the SDK passes the market through for the API to resolve.
    const calls: Call[] = []
    const refused = await refusal(() => makeClient(() => unechoed, calls).perpsSpotOrder({ walletId: WALLET, market: "@107", side: "sell", size: "2", price: "30", hide: true }))
    assert.equal(refused?.code, "HIDE_NOT_CONFIRMED")
    record("sdk-spot-order-by-index-hide-without-echo-refused", "sdk-run", "sdk", { method: "perpsSpotOrder", market: "@107", side: "sell", hide: true },
      { refused, requests: calls.map((c) => ({ path: c.path, market: c.body?.market ?? null, sendsHide: c.body?.hide === true })) })
  }
  {
    const calls: Call[] = []
    const client = makeClient(() => ({ success: false }), calls)
    for (const hide of [false, undefined]) await refusal(() => client.perpsSpotOrder({ walletId: WALLET, market: "HYPE/USDC", side: "buy", size: "1", ...(hide === undefined ? {} : { hide }) }))
    record("sdk-spot-order-without-hide-sends-no-hide-key", "sdk-run", "sdk", { hide: "false or omitted" }, { bodiesWithAHideKey: calls.filter((c) => c.body && "hide" in c.body).length, requests: calls.length })
  }
  {
    const calls: Call[] = []
    const c = makeClient(() => ({ success: true }), calls)
    const out = {
      embeddedOrder: await refusal(() => c.perpsSpotOrder({ walletId: "embedded", market: "HYPE/USDC", side: "buy", size: "1" })),
      embeddedBalances: await refusal(() => c.perpsSpotBalances("embedded")),
      badSide: await refusal(() => c.perpsSpotOrder({ walletId: WALLET, market: "HYPE/USDC", side: "hold", size: "1" })),
      badCloid: await refusal(() => c.perpsSpotCancel({ walletId: WALLET, cloid: "0x12" })),
    }
    for (const v of Object.values(out)) assert.ok(v, "expected a refusal")
    record("sdk-spot-refusals-send-nothing", "sdk-run", "sdk", { cases: Object.keys(out) }, { ...out, requests: calls.length })
  }
  {
    const calls: Call[] = []
    const c = makeClient(() => ({ success: true, markets: [] }), calls)
    await c.perpsSpotMarkets({ all: true, limit: 5 })
    await c.perpsSpotMarkets()
    await c.perpsSpotBalances(WALLET)
    record("sdk-spot-reads-paths", "sdk-run", "sdk", { methods: ["perpsSpotMarkets", "perpsSpotBalances"] }, { requests: calls.map((x) => `${x.method} ${x.path}`) })
  }

  // 2. Holdings and realized P&L with the venue tag, over a made-up body that carries both spot shapes.
  {
    const body = {
      success: true,
      positions: [
        { kind: "spot", venue: "solana", chain: "solana", mint: "MintFixture1111111111111111111111111111111", symbol: "FIX", quantity: "10", valueUsd: 12.5 },
        { kind: "spot", venue: "hyperliquid", symbol: "HYPE", quantity: "3", valueUsd: 90 },
      ],
    }
    const calls: Call[] = []
    const got = await makeClient(() => body, calls).getAgentPositions("profile-fixture", { kind: "spot" })
    const hl = got.positions.find((p: { venue?: string }) => p.venue === "hyperliquid")
    assert.ok(hl && !("mint" in hl) && !("chain" in hl))
    record("sdk-positions-carry-venue-tag", "sdk-read", "sdk", { kind: "spot" },
      { path: calls[0]!.path, venues: got.positions.map((p: { venue: string }) => p.venue), hyperliquidRowHasMintOrChain: false, successKeyDropped: !("success" in got) })
  }
  {
    const record0 = { profileId: "profile-fixture", totals: { hyperliquidSpot: { realizedUsd: 4.2, unrealizedUsd: 1.1, feesUsd: 0.3, volumeUsd: 500, trades: 6 } }, hyperliquidSpot: { realizedUsd: 4.2, unrealizedUsd: 1.1, feesUsd: 0.3, volumeUsd: 500, trades: 6 } }
    const got = await makeClient(() => ({ success: true, record: record0 }), []).getAgentRecord("profile-fixture")
    record("sdk-record-carries-hyperliquid-spot-figures", "sdk-read", "sdk", {}, { hyperliquidSpot: got.hyperliquidSpot, totalsHyperliquidSpot: got.totals?.hyperliquidSpot ?? null })
  }

  // 3. Shipped dist text: each pin names the file and symbol it was found at.
  const pin = (id: string, surface: Row["surface"], file: string, symbol: string, found: boolean) => {
    assert.ok(found, `pin ${id} not found in ${file}`)
    record(id, "package-text", surface, { file, symbol }, { found })
  }
  pin("sdk-types-spot-methods-and-hide", "sdk", "@candledottv/agent-sdk dist/client.d.ts", "perpsSpotMarkets / perpsSpotBalances / perpsSpotOrder / perpsSpotCancel",
    ["perpsSpotMarkets", "perpsSpotBalances", "perpsSpotOrder", "perpsSpotCancel"].every((m) => text.sdkTypes.includes(m)) && /HIDE_NOT_CONFIRMED/.test(text.sdkTypes))
  pin("sdk-types-venue-tagged-positions", "sdk", "@candledottv/agent-sdk dist/client.d.ts", "AgentSpotPosition = AgentChainSpotPosition | AgentHyperliquidSpotPosition; AgentHyperliquidSpotFigures",
    /AgentSpotPosition = AgentChainSpotPosition \| AgentHyperliquidSpotPosition/.test(text.sdkTypes) && text.sdkTypes.includes("AgentHyperliquidSpotFigures"))
  pin("cli-usage-spot-buy-sell-with-hide", "cli", "@candledottv/cli dist/index.js", "usage: candle perps spot buy|sell <pair> <size> ... [--hide]",
    text.cli.includes("candle perps spot buy|sell <pair> <size> [--price <px>] [--tif Gtc|Alo|Ioc] [--slippage-bps <n>] [--client-id <0x+32 hex>] [--hide] [--yes]"))
  pin("cli-resolves-at-index", "cli", "@candledottv/cli dist/index.js", "/^@(0|[1-9][0-9]{0,5})$/ market test", text.cli.includes("/^@(0|[1-9][0-9]{0,5})$/.test(market)"))
  pin("cli-spot-fee-and-builder-fee-before-the-order", "cli", "@candledottv/cli dist/index.js", "t.venue === \"hyperliquid-spot\" lines",
    text.cli.includes("Hyperliquid spot fee: taker") && text.cli.includes("Candle's builder fee is separate and charged on sells only.") && text.cli.includes("Candle builder fee: none (Hyperliquid charges no builder fee on spot buys)."))
  pin("cli-delisted-refusal", "cli", "@candledottv/cli dist/index.js", "{ tradeable: false, reason: \"delisted\" }", text.cli.includes('{ tradeable: false, reason: "delisted" }'))
  pin("cli-positions-hyperliquid-spot-row", "cli", "@candledottv/cli dist/index.js", "rowOf: p.kind === \"spot\" && p.venue === \"hyperliquid\"",
    text.cli.includes('if (p.kind === "spot" && p.venue === "hyperliquid")') && text.cli.includes('["Hyperliquid spot", p.symbol'))
  pin("cli-record-hyperliquid-spot-line", "cli", "@candledottv/cli dist/index.js", "Spot P&L includes Hyperliquid spot: realized ...", text.cli.includes("Spot P&L includes Hyperliquid spot: realized"))
  pin("mcp-spot-tools", "mcp", "@candledottv/mcp dist/index.js", "PERPS_SPOT_TOOL_NAMES",
    ["candle_perps_spot_markets", "candle_perps_spot_balances", "candle_perps_spot_order", "candle_perps_spot_cancel"].every((n) => text.mcp.includes(`"${n}"`)))
  pin("mcp-spot-signs-only-from-tee-wallet", "mcp", "@candledottv/mcp dist/index.js", "SPOT_TEE_ONLY", text.mcp.includes("Hyperliquid spot signs only from the key's EVM TEE wallet"))
  pin("mcp-spot-buy-has-no-builder-field", "mcp", "@candledottv/mcp dist/index.js", "pre-sign spot check", text.mcp.includes("a spot buy carries no builder fee on Hyperliquid, so no builder field"))
  pin("mcp-positions-kind-spot-or-perp", "mcp", "@candledottv/mcp dist/index.js", "candle_get_agent_positions kind enum and venue note", text.mcp.includes('.enum(["spot", "perp"]).optional().describe("Only spot tokens or only Hyperliquid perps; omit for both")') && text.mcp.includes('Hyperliquid spot rows carry venue: "hyperliquid"') && text.mcp.includes("Every open position of one published agent, spot tokens and Hyperliquid perps"))

  const serialized = JSON.stringify(rows)
  for (const forbidden of [KEY, "BEGIN", "privateKey"]) assert.ok(!serialized.includes(forbidden), `fixture leaked ${forbidden}`)
  writeFileSync(
    join(import.meta.dir, "../test/fixtures/candle-spot-packages.json"),
    `${JSON.stringify({
      about: "Offline Hyperliquid spot contracts (HM2, BE-3772) recorded from the published npm packages (@candledottv/agent-sdk 0.6.39, @candledottv/mcp 0.10.45, @candledottv/cli 0.13.47), not a monorepo checkout. sdk-run rows run the SDK's spot methods over an intercepted fetch (spot order `hide` without the echo is refused HIDE_NOT_CONFIRMED after the one build request, refusals send nothing); sdk-read rows run the positions and record readers on made-up bodies; package-text rows pin symbols in the shipped dist. Made-up ids only; no wallet address, key or account value; no fetch reached the network.",
      packages,
      rows,
    }, null, 2)}\n`,
  )
  console.log(`Recorded ${rows.length} offline spot package contracts.`)
} finally {
  globalThis.fetch = originalFetch
  rmSync(workDir, { recursive: true, force: true })
}
