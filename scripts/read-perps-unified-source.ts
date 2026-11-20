// Offline Hyperliquid unified-account contracts (BE-3860 / BE-3863) from an exact clean Candle source checkout:
// setup in unified mode with the server switch on (and refused when off or on an older API), risk, account,
// positions and watch displays across main and builder dexes (spot collateral, per-dex positions, unified ratio,
// warn and no-equity levels), standard-mode wallets unchanged whether the switch is on or off, and unsupported
// modes still refused.
//
// Runs Candle's own CLI (`candle perps setup|risk|account|positions|watch`), registered MCP tools
// (`candle_perps_setup|risk|account|positions`) and SDK (`CandleClient.perpsSetup|perpsRisk|perpsAccount|getPerpsRisk|watchPerpsRisk`)
// against intercepted API and Hyperliquid `/info` stand-ins. Every fetch outside those stand-ins is refused.
// No real key, wallet, signer, submission or live venue is used; all addresses and figures are made up.
//   bun scripts/read-perps-unified-source.ts <candle-monorepo checkout>
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { BUILDER, NOW as STUB_NOW, PRIVY_ID, WALLET_ID, ADDRESS, STANDARD_VENUE, UNIFIED_NO_EQUITY_VENUE, UNIFIED_OK_VENUE, UNIFIED_WARN_RATIO_VENUE, cfg, makeFetcher, type Req, type VenuePreset } from "./perps-unified-stub"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-unified-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const ENGINE_FILES = [
  "packages/sdk/src/hyperliquid-risk.ts",
  "packages/mcp/src/hyperliquid-risk.ts",
  "packages/cli/src/hyperliquid-risk.ts",
] as const
const DOC_FILE = "docs/agent-trading.md"
const HELP_FILE = "packages/cli/src/help.ts"
const AGENT_ROUTE = "apps/api/src/routes/agent.ts"
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", AGENT_ROUTE, DOC_FILE)

const engineHashes = ENGINE_FILES.map((file) => createHash("sha256").update(readFileSync(join(checkout, file))).digest("hex"))
assert.equal(new Set(engineHashes).size, 1, "packages/{sdk,mcp,cli}/src/hyperliquid-risk.ts must be byte-identical")

const source = {
  repo: "candledottv/candle-monorepo",
  commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  riskEngine: { files: [...ENGINE_FILES], sha256: engineHashes[0]! },
}

const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({
  name: "perps-unified-source-workspaces",
  setup(build) {
    build.onResolve({ filter: /^@candledottv\/mcp\/src\// }, ({ path }) => ({ path: join(checkout, "packages/mcp/src", path.split("/src/")[1]! + ".ts") }))
    build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
  },
})

const originalFetch = globalThis.fetch
const originalNow = Date.now
const NOW = STUB_NOW
const deny = (() => { throw new Error("unified-account recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny
Date.now = () => NOW

type Row = { id: string; scenario: string; surface: string; says?: string; evidence?: string; args?: Record<string, unknown>; requests?: Req[]; outcome: any }
const rows: Row[] = []
const lines = (t: string) => t.trimEnd().split("\n").filter((l) => l !== "")
const scrub = (t: string) => t.split(cfg.apiKey).join("<key>")

try {
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createFakeStore, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")

  const ephemeral = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()

  const runCli = async (args: string[], fetcher: typeof fetch, extraDeps: Record<string, unknown> = {}) => {
    const stdout = createCapture(), stderr = createCapture()
    const deps = createTestDeps({
      stdout,
      stderr,
      now: () => NOW,
      fetch: fetcher,
      env: { CANDLE_PLAIN: "1", CANDLE_API_URL: cfg.apiUrl, CANDLE_API_KEY: cfg.apiKey, CANDLE_HYPERLIQUID_BUILDER: BUILDER },
      store: createFakeStore({ [`wallet_signer_${WALLET_ID}`]: pemToStoredSigner(ephemeral) }),
      ...extraDeps,
    })
    const exitCode = await cli.run(args, deps)
    return { exitCode, stdout: scrub(stdout.text), stderr: scrub(stderr.text) }
  }

  const callMcp = async (fetcher: typeof fetch, name: string, args: Record<string, unknown>) => {
    globalThis.fetch = fetcher
    const server = createCandleMcpServer({ CANDLE_HYPERLIQUID_BUILDER: BUILDER }, cfg)
    const client = new Client({ name: "harness-perps-unified-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const r: any = await client.callTool({ name, arguments: args })
      const text: string = r.content[0].text
      let body: any
      try { body = JSON.parse(text) } catch { body = { text } }
      return { body, isError: r.isError === true }
    } finally {
      await client.close()
      await server.close()
      globalThis.fetch = deny
    }
  }

  // ── 1. Setup scenarios (CLI, MCP, SDK) ─────────────────────────────────────────────────────
  const setupCases: { id: string; says: string; venue: VenuePreset; unifiedAccounts: boolean | "omit"; setupReady: boolean; expectOk: boolean }[] = [
    {
      id: "setup-unified-on",
      says: "A unifiedAccount wallet with the server switch ON continues through setup, verifies the unified ready answer pinned to the venue's mode, and signs nothing.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: true,
      setupReady: true,
      expectOk: true,
    },
    {
      id: "setup-unified-off",
      says: "A unifiedAccount wallet while the server switch is OFF is refused with PERPS_ACCOUNT_MODE and unified-specific wording before POST /perps/setup.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: false,
      setupReady: false,
      expectOk: false,
    },
    {
      id: "setup-unified-older-api",
      says: "Against an older API that omits unifiedAccounts on /keys/self/limits, a unifiedAccount wallet is refused with PERPS_ACCOUNT_MODE before POST /perps/setup.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: "omit",
      setupReady: false,
      expectOk: false,
    },
    {
      id: "setup-standard-with-switch-on",
      says: "A standard-mode wallet (default) with the switch ON proceeds directly to POST /perps/setup without consulting /keys/self/limits, unchanged.",
      venue: STANDARD_VENUE,
      unifiedAccounts: true,
      setupReady: true,
      expectOk: true,
    },
    {
      id: "setup-unsupported-mode",
      says: "An unsupported mode (portfolioMargin) is still refused with PERPS_ACCOUNT_MODE before POST /perps/setup even when unified accounts are ON.",
      venue: { ...STANDARD_VENUE, mode: "portfolioMargin" },
      unifiedAccounts: true,
      setupReady: false,
      expectOk: false,
    },
  ]

  for (const c of setupCases) {
    // CLI (text and --json)
    for (const json of [false, true]) {
      const requests: Req[] = []
      const args = ["perps", "setup", "--wallet", "perps", ...(json ? ["--json"] : [])]
      const out = await runCli(args, makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts, setupReady: c.setupReady }))
      assert.equal(out.exitCode === 0, c.expectOk, `${c.id} cli${json ? "-json" : ""}: ${out.stdout}${out.stderr}`)
      assert.equal(requests.some((r) => r.path === "/api/v1/agent/perps/setup"), c.setupReady)
      rows.push({
        id: `${c.id}-cli${json ? "-json" : ""}`,
        scenario: c.id,
        surface: "cli",
        ...(json ? {} : { says: c.says }),
        args: { command: `candle ${args.join(" ")}` },
        requests,
        outcome: json
          ? { exitCode: out.exitCode, body: JSON.parse(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) }
          : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) },
      })
    }
    // MCP
    {
      const requests: Req[] = []
      const o = await callMcp(makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts, setupReady: c.setupReady }), "candle_perps_setup", { wallet: WALLET_ID, submit: false })
      assert.equal(!o.isError, c.expectOk, `${c.id} mcp: ${JSON.stringify(o)}`)
      assert.equal(requests.some((r) => r.path === "/api/v1/agent/perps/setup"), c.setupReady)
      rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID, submit: false }, requests, outcome: o })
    }
    // SDK
    {
      const requests: Req[] = []
      const client = new CandleClient({ ...cfg, fetch: makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts, setupReady: c.setupReady }), maxRetries: 0, hyperliquidBuilder: BUILDER })
      let outcome: any
      try {
        const res = await client.perpsSetup({ walletId: WALLET_ID, privyWalletId: PRIVY_ID, submit: false })
        outcome = { isError: false, body: res }
      } catch (e: any) {
        outcome = { isError: true, error: { ...(e.code ? { code: e.code } : {}), message: String(e.message) } }
      }
      assert.equal(!outcome.isError, c.expectOk, `${c.id} sdk: ${JSON.stringify(outcome)}`)
      assert.equal(requests.some((r) => r.path === "/api/v1/agent/perps/setup"), c.setupReady)
      rows.push({ id: `${c.id}-sdk`, scenario: c.id, surface: "sdk", args: { walletId: WALLET_ID, privyWalletId: PRIVY_ID, submit: false }, requests, outcome })
    }
  }

  // ── 2. Risk scenarios (CLI human + --json, MCP, SDK) ───────────────────────────────────────
  const riskCases: { id: string; says: string; venue: VenuePreset; unifiedAccounts: boolean | "omit"; expectExit: number; expectLevel: string }[] = [
    {
      id: "risk-unified-ok",
      says: "Unified wallet with switch ON: spot USDC backs accountValue/freeMargin/withdrawable, positions come from main + xyz dexes (empty alt dex skips marks), unified ratio is 50/900.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: true,
      expectExit: 0,
      expectLevel: "ok",
    },
    {
      id: "risk-unified-warn-ratio",
      says: "Unified wallet whose unified account ratio crosses warn (600/900 = 0.6667 > 0.60): level warn, CLI exits 10, margin driver names the ratio.",
      venue: UNIFIED_WARN_RATIO_VENUE,
      unifiedAccounts: true,
      expectExit: 10,
      expectLevel: "warn",
    },
    {
      id: "risk-unified-no-equity",
      says: "Unified wallet with cross maintenance margin > 0 and no available collateral (spot 80 - isolated 100 <= 0): E2 critical no equity, ratio null, CLI exits 11.",
      venue: UNIFIED_NO_EQUITY_VENUE,
      unifiedAccounts: true,
      expectExit: 11,
      expectLevel: "critical",
    },
    {
      id: "risk-unified-switch-off",
      says: "Unified wallet while switch is OFF: unknown with PERPS_ACCOUNT_MODE, CLI exits 1 with unified wording, MCP isError true, zero spot or builder-dex venue calls.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: false,
      expectExit: 1,
      expectLevel: "unknown",
    },
    {
      id: "risk-unified-older-api",
      says: "Unified wallet against an older API omitting unifiedAccounts: same unknown PERPS_ACCOUNT_MODE refusal, zero spot or builder-dex venue calls.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: "omit",
      expectExit: 1,
      expectLevel: "unknown",
    },
    {
      id: "risk-standard-switch-on",
      says: "Standard-mode wallet with switch ON: reads only clearinghouseState + metaAndAssetCtxs + userAbstraction, no unified block, standard balances unchanged.",
      venue: STANDARD_VENUE,
      unifiedAccounts: true,
      expectExit: 0,
      expectLevel: "ok",
    },
    {
      id: "risk-standard-switch-off",
      says: "Standard-mode wallet with switch OFF: byte-for-byte identical report and display to switch ON.",
      venue: STANDARD_VENUE,
      unifiedAccounts: false,
      expectExit: 0,
      expectLevel: "ok",
    },
  ]

  for (const c of riskCases) {
    for (const json of [false, true]) {
      const requests: Req[] = []
      const args = ["perps", "risk", "--wallet", "perps", ...(json ? ["--json"] : [])]
      const out = await runCli(args, makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts }))
      assert.equal(out.exitCode, c.expectExit, `${c.id} cli${json ? "-json" : ""}: ${out.stdout}${out.stderr}`)
      rows.push({
        id: `${c.id}-cli${json ? "-json" : ""}`,
        scenario: c.id,
        surface: "cli",
        ...(json ? {} : { says: c.says }),
        args: { command: `candle ${args.join(" ")}` },
        requests,
        outcome: json
          ? { exitCode: out.exitCode, body: JSON.parse(out.stdout) }
          : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) },
      })
    }
    {
      const requests: Req[] = []
      const o = await callMcp(makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts }), "candle_perps_risk", { wallet: WALLET_ID })
      assert.equal(o.isError, c.expectLevel === "unknown", `${c.id} mcp`)
      rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID }, requests, outcome: o })
    }
    {
      const requests: Req[] = []
      const client = new CandleClient({ ...cfg, fetch: makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts }), maxRetries: 0 })
      const report = await client.perpsRisk({ walletId: WALLET_ID })
      assert.equal(report.level, c.expectLevel, `${c.id} sdk`)
      rows.push({ id: `${c.id}-sdk`, scenario: c.id, surface: "sdk", args: { walletId: WALLET_ID }, requests, outcome: { isError: false, body: report } })
    }
  }

  // SDK `getPerpsRisk()` reports the server's `unifiedAccounts` flag alongside the effective thresholds.
  for (const [id, unifiedAccounts] of [["limits-switch-on", true], ["limits-switch-off", false], ["limits-older-api", "omit"]] as const) {
    const requests: Req[] = []
    const client = new CandleClient({ ...cfg, fetch: makeFetcher(requests, { venue: UNIFIED_OK_VENUE, unifiedAccounts }), maxRetries: 0 })
    const res = await client.getPerpsRisk()
    assert.equal(res.unifiedAccounts, unifiedAccounts === true)
    rows.push({ id: `${id}-sdk`, scenario: id, surface: "sdk", says: `getPerpsRisk() reports unifiedAccounts=${unifiedAccounts === true} when /keys/self/limits has ${String(unifiedAccounts)}.`, args: {}, requests, outcome: { isError: false, body: res } })
  }

  // ── 3. Account scenarios (CLI human + --json, MCP, SDK) ────────────────────────────────────
  const accountCases: { id: string; says: string; venue: VenuePreset; unifiedAccounts: boolean }[] = [
    {
      id: "account-unified-on",
      says: "Unified wallet account display with switch ON: spot USDC balances, Unified ratio and Unified dexes rows, recent main-perp fills and funding.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: true,
    },
    {
      id: "account-unified-off",
      says: "Unified wallet account display with switch OFF: no account figures (PERPS_ACCOUNT_MODE), no unified block, no spot/dex calls.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: false,
    },
    {
      id: "account-standard-on",
      says: "Standard-mode wallet account display with switch ON: standard clearinghouseState balances, no unified block, no spot/dex calls.",
      venue: STANDARD_VENUE,
      unifiedAccounts: true,
    },
  ]

  for (const c of accountCases) {
    for (const json of [false, true]) {
      const requests: Req[] = []
      const args = ["perps", "account", "--wallet", "perps", "--since", "24h", ...(json ? ["--json"] : [])]
      const out = await runCli(args, makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts }))
      assert.equal(out.exitCode, 0, `${c.id} cli${json ? "-json" : ""}: ${out.stdout}${out.stderr}`)
      rows.push({
        id: `${c.id}-cli${json ? "-json" : ""}`,
        scenario: c.id,
        surface: "cli",
        ...(json ? {} : { says: c.says }),
        args: { command: `candle ${args.join(" ")}` },
        requests,
        outcome: json
          ? { exitCode: out.exitCode, body: JSON.parse(out.stdout) }
          : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) },
      })
    }
    {
      const requests: Req[] = []
      const o = await callMcp(makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts }), "candle_perps_account", { wallet: WALLET_ID, since: "24h" })
      assert.equal(o.isError, false, `${c.id} mcp`)
      rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID, since: "24h" }, requests, outcome: o })
    }
    {
      const requests: Req[] = []
      const client = new CandleClient({ ...cfg, fetch: makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts }), maxRetries: 0 })
      const account = await client.perpsAccount({ walletId: WALLET_ID, since: NOW - 24 * 3_600_000 })
      rows.push({ id: `${c.id}-sdk`, scenario: c.id, surface: "sdk", args: { walletId: WALLET_ID, since: NOW - 24 * 3_600_000 }, requests, outcome: { isError: false, body: account } })
    }
  }

  // ── 4. Positions scenarios (CLI human + --json, MCP) ───────────────────────────────────────
  const positionsCases: { id: string; says: string; venue: VenuePreset; unifiedAccounts: boolean; withdrawable: string }[] = [
    {
      id: "positions-unified-on",
      says: "candle perps positions and candle_perps_positions on a unified wallet with switch ON: shows main + xyz:TSLA positions, spot balances, Unified ratio and Unified dexes.",
      venue: UNIFIED_OK_VENUE,
      unifiedAccounts: true,
      withdrawable: "900",
    },
    {
      id: "positions-standard-on",
      says: "candle perps positions and candle_perps_positions on a standard wallet with switch ON: standard account line, no unified block, no spot/dex reads.",
      venue: STANDARD_VENUE,
      unifiedAccounts: true,
      withdrawable: "1050",
    },
  ]

  for (const c of positionsCases) {
    const positionsBody = {
      success: true,
      walletId: WALLET_ID,
      address: ADDRESS,
      network: "mainnet",
      mode: c.venue.mode,
      withdrawable: c.withdrawable,
      positions: [],
      openWithdrawals: [],
    }
    for (const json of [false, true]) {
      const requests: Req[] = []
      const args = ["perps", "positions", "--wallet", "perps", ...(json ? ["--json"] : [])]
      const out = await runCli(args, makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts, positionsBody }))
      assert.equal(out.exitCode, 0, `${c.id} cli${json ? "-json" : ""}: ${out.stdout}${out.stderr}`)
      rows.push({
        id: `${c.id}-cli${json ? "-json" : ""}`,
        scenario: c.id,
        surface: "cli",
        ...(json ? {} : { says: c.says }),
        args: { command: `candle ${args.join(" ")}` },
        requests,
        outcome: json
          ? { exitCode: out.exitCode, body: JSON.parse(out.stdout) }
          : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) },
      })
    }
    {
      const requests: Req[] = []
      const o = await callMcp(makeFetcher(requests, { venue: c.venue, unifiedAccounts: c.unifiedAccounts, positionsBody }), "candle_perps_positions", { wallet: WALLET_ID })
      assert.equal(o.isError, false, `${c.id} mcp`)
      rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID }, requests, outcome: o })
    }
  }

  // ── 5. Watch scenario (static switch on first poll, CLI + SDK) ─────────────────────────────
  {
    const requests: Req[] = []
    let stop: (() => void) | undefined
    const out = await runCli(
      ["perps", "watch", "--wallet", "perps", "--interval", "10", "--heartbeat", "0"],
      makeFetcher(requests, { venue: UNIFIED_WARN_RATIO_VENUE, unifiedAccounts: true }),
      {
        onTerminate: (fn: () => void) => { stop = fn; return () => {} },
        sleep: async () => { stop?.() },
      },
    )
    assert.equal(out.exitCode, 10, `watch cli: ${out.stdout}${out.stderr}`)
    const events = lines(out.stdout).map((l) => JSON.parse(l))
    rows.push({
      id: "watch-unified-on-cli",
      scenario: "watch-unified-on",
      surface: "cli",
      says: "candle perps watch reads the switch once on start, polls the unified path and emits the start event with the unified block, exiting 10 on warn.",
      args: { command: "candle perps watch --wallet perps --interval 10 --heartbeat 0" },
      requests,
      outcome: { exitCode: out.exitCode, events },
    })
  }
  {
    const requests: Req[] = []
    const controller = new AbortController()
    const events: any[] = []
    const client = new CandleClient({ ...cfg, fetch: makeFetcher(requests, { venue: UNIFIED_WARN_RATIO_VENUE, unifiedAccounts: true }), maxRetries: 0 })
    const res = await client.watchPerpsRisk({
      walletId: WALLET_ID,
      intervalMs: 10_000,
      heartbeatMs: 0,
      signal: controller.signal,
      onEvent: (ev: any) => { events.push(ev); if (ev.event === "level") controller.abort() },
    })
    assert.equal(res.level, "warn")
    rows.push({
      id: "watch-unified-on-sdk",
      scenario: "watch-unified-on",
      surface: "sdk",
      args: { walletId: WALLET_ID, intervalMs: 10_000, heartbeatMs: 0 },
      requests,
      outcome: { level: res.level, events },
    })
  }

  // ── 6. Help, docs and API limits route (source text) ───────────────────────────────────────
  const docText = readFileSync(join(checkout, DOC_FILE), "utf8")
  const helpText = readFileSync(join(checkout, HELP_FILE), "utf8")
  const routeText = readFileSync(join(checkout, AGENT_ROUTE), "utf8")
  const docModeRow = docText.split("\n").find((l) => l.startsWith("| `PERPS_ACCOUNT_MODE`"))
  assert.ok(docModeRow && docModeRow.includes("HYPERLIQUID_UNIFIED_ACCOUNTS"), "docs PERPS_ACCOUNT_MODE row missing")
  const docUnifiedStart = docText.indexOf("A wallet Hyperliquid reports as `unifiedAccount` is read through the unified path")
  assert.ok(docUnifiedStart >= 0, "docs unified paragraph missing")
  const docUnifiedEnd = docText.indexOf("\n\n", docUnifiedStart)
  const docUnifiedParagraph = docText.slice(docUnifiedStart, docUnifiedEnd).replace(/\s+/g, " ")
  assert.ok(helpText.includes("unifiedAccount") && helpText.includes("unifiedAccounts"), "CLI perps help missing unified wording")
  const helpUnifiedStart = helpText.indexOf("A wallet Hyperliquid reports as unifiedAccount is read through the unified path")
  assert.ok(helpUnifiedStart >= 0, "CLI perps help unified sentence missing")
  const helpUnifiedEnd = helpText.indexOf("modify, margin, tpsl", helpUnifiedStart)
  const helpUnifiedText = helpText.slice(helpUnifiedStart, helpUnifiedEnd).trim()
  assert.ok(routeText.includes("unifiedAccounts: perpsUnifiedAccountsEnabled()"), "API /keys/self/limits route missing unifiedAccounts")
  rows.push({
    id: "source-docs-and-help",
    scenario: "docs",
    surface: "source-text",
    args: { files: [DOC_FILE, HELP_FILE, AGENT_ROUTE] },
    outcome: {
      docModeRow,
      docUnifiedParagraph,
      helpUnifiedText,
      limitsRouteLine: "unifiedAccounts: perpsUnifiedAccountsEnabled()",
    },
  })

  const text = JSON.stringify(rows)
  assert.ok(!text.includes(cfg.apiKey), "no key in a recording")
  assert.ok(!/cndl_/.test(text), "no cndl_ key in a recording")
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), "no private key in a recording")
  for (const hex of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) {
    assert.ok(/^0x0{39}[0-9]$/.test(hex), `unexpected non-synthetic address: ${hex}`)
  }

  writeFileSync(
    join(import.meta.dir, "../test/fixtures/candle-perps-unified-source.json"),
    `${JSON.stringify(
      {
        about:
          "Offline Hyperliquid unified-account contracts from exact published source (CLI, MCP and SDK). Every address, balance, position and fill is made up and time is fixed. All API and Hyperliquid /info requests are answered by in-memory stand-ins; nothing is signed, submitted or sent over the network, and no deployed behavior is claimed.",
        source,
        now: new Date(NOW).toISOString(),
        rows: JSON.parse(text),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Recorded ${rows.length} offline unified-account contracts from ${source.commit}.`)
} finally {
  globalThis.fetch = originalFetch
  Date.now = originalNow
}
