// Offline perp market contracts from an exact clean Candle source checkout: one Hyperliquid perp market's
// public figures and the published Candle agents long and short in it, as `GET /api/v1/agent/perps-markets/:coin`
// answers, and as `candle perps market <coin> --agents`, `candle_get_perp_market` and the SDK's `getPerpMarket()`
// read it.
//
// The API's own route runs, through Candle's governed market-data reads, against a stand-in Hyperliquid with
// made-up markets, one made-up builder dex and made-up figures. Its agents half is the published perps bundle
// read from the database; here it is Candle's pure `composeMarketAgents` run on three made-up public agents'
// bundles, put in where the route calls `readMarketAgents`. The bundles carry a made-up wallet, account value and
// fill hash that the composer must not pass on; the builder dex's made-up deployer is replaced by its role
// before a row is written. Every other fetch is refused; no key, database, venue or keyed route is used.
//   bun scripts/read-perps-market-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spyOn } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-market-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const API_SOURCES = [
  "apps/api/src/routes/agent-page-reads.ts", "apps/api/src/ledger/perps/market-agents.ts", "apps/api/src/services/hyperliquid.ts",
  "apps/api/src/services/hyperliquid-market-data.ts", "apps/api/src/services/hyperliquid-public-reads.ts", "apps/api/src/lib/perps-gate.ts",
]
/** The public pages that describe the read, and their published copies. */
const DOCS = ["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"]
const CLI_DOC = "apps/docs/src/content/docs/developers/cli.md", MCP_DOC = "apps/docs/src/content/docs/developers/mcp-server.md"
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", ...API_SOURCES, ...DOCS, CLI_DOC, MCP_DOC)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const deny = (() => { throw new Error("perp market recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

const H = 3_600_000, M = 60_000
/** A made-up instant: every time below is minutes before it. */
const NOW = Date.UTC(2027, 0, 12, 14, 0)
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const VENUE = "https://hl.test"
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
/** Inputs to Candle's source only; rows name the deployer by role, and the rest must never reach a row. */
const DEPLOYER = addr(0xd1), WALLET = addr(0xa1), FILL_HASH = `0x${"e".repeat(64)}`
const ROLES: [string, string][] = [[DEPLOYER, "<builder-dex-deployer>"]]

// A stand-in Hyperliquid: the main dex lists BTC, ETH and SOL; one made-up builder dex "xyz" lists xyz:TSLA.
const ctx = (markPx: string, prevDayPx: string, openInterest: string, funding: string, dayNtlVlm: string) =>
  ({ markPx, midPx: markPx, oraclePx: markPx, openInterest, funding, dayNtlVlm, prevDayPx, premium: "0", impactPxs: [markPx, markPx] })
const DEXES = [null, { name: "xyz", fullName: "XYZ Fixture", deployer: DEPLOYER, oracleUpdater: null }]
const UNIVERSES: Record<string, unknown> = {
  "": [
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "SOL", szDecimals: 2, maxLeverage: 20 }] },
    [ctx("63000", "60000", "1000", "0.0000125", "900000000"), ctx("3100", "3200", "20000", "-0.00000625", "400000000"), ctx("150", "150", "500000", "0.00001", "50000000")],
  ],
  xyz: [{ universe: [{ name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10, marginMode: null, deployerFeeScale: "0.5" }], collateralToken: 0 }, [ctx("250", "240", "10000", "0.00002", "5000000")]],
}
/** Three hours of funding on each coin, the newest an hour before now. */
const fundingOf = (coin: string) => [3, 2, 1].map((h) => ({ coin, fundingRate: "0.0000125", premium: "0.0001", time: NOW - h * H }))

type BundlePosition = Record<string, unknown>
type BundleRound = Record<string, unknown>
/** A position as the published bundle stores it, with the fields the market read must leave behind. */
const position = (coin: string, side: "long" | "short", size: string, entryPx: string, markPx: string, leverage: number, type: string): BundlePosition => {
  const s = Number(size), e = Number(entryPx), m = Number(markPx), pnl = (side === "long" ? 1 : -1) * s * (m - e)
  return {
    kind: "perp", coin, side, size, leverage: { value: leverage, type }, entryPx, markPx, positionValueUsd: String(s * m),
    marginUsedUsd: String((s * m) / leverage), unrealizedPnlUsd: String(pnl), returnOnEquity: ((pnl / ((s * e) / leverage))).toFixed(4),
    liquidationPx: null, liquidationDistance: null, fundingNetUsd: "0", level: "ok",
  }
}
const round = (coin: string, side: "long" | "short", pnlUsd: number, closedMinutesAgo: number, extra: Partial<BundleRound> = {}): BundleRound => ({
  kind: "perp_round", coin, side, leverage: { value: 10, type: "cross" }, pnlUsd, liquidated: false,
  openedMs: NOW - closedMinutesAgo * M - 2 * H, closedMs: NOW - closedMinutesAgo * M, hash: FILL_HASH, ...extra,
})
const agent = (n: number, name: string | null, slug: string | null) => ({ profileId: `prof_${String(n).repeat(16)}`, slug, name, avatarUrl: null })
/** Three public agents' published bundles. Each carries a wallet and an account value the composer must not pass on. */
const AGENTS = [
  { agent: agent(1, "Alpha Fixture", "alpha-fixture"), perps: {
    available: true, asOfMs: NOW - 8 * M, wallet: WALLET, accountValueUsd: "12345",
    positions: [position("BTC", "long", "0.5", "60000", "63000", 20, "cross")],
    rounds: [round("BTC", "long", 120, 90, { id: "rnd_0123456789abcdef" }), round("xyz:TSLA", "short", -15, 300, { id: "rnd_1123456789abcdef", liquidated: true }), round("SOL", "long", 3, 600, { id: "rnd_2123456789abcdef" })],
  } },
  { agent: agent(2, "Beta Fixture", "beta-fixture"), perps: {
    available: true, asOfMs: NOW - 8 * M, wallet: WALLET, accountValueUsd: "6789",
    positions: [position("BTC", "long", "0.25", "62000", "63000", 10, "isolated"), position("xyz:TSLA", "short", "2", "260", "250", 5, "isolated")],
    // A round published before round ids existed: no id, so no round page.
    rounds: [round("BTC", "short", 40, 30, { leverage: null })],
  } },
  { agent: agent(3, null, "gamma-fixture"), perps: {
    available: true, asOfMs: NOW - 68 * M, wallet: WALLET, accountValueUsd: "100",
    positions: [position("BTC", "short", "0.1", "64000", "63000", 25, "cross")], rounds: [],
  } },
]
/** The bundles the route's SQL picks for a coin: a position or a round on it. */
const holding = (coin: string) => AGENTS.filter((a) => [...a.perps.positions, ...a.perps.rounds].some((p) => p.coin === coin))

type Scenario = { id: string; coin: string; says: string; agents: "compose" | "throws"; status: number }
const scenarios: Scenario[] = [
  { id: "btc", coin: "BTC", agents: "compose", status: 200, says: "A main-dex market three public agents hold: two long, one short, and two closed rounds (one published before round ids)." },
  { id: "builder-dex", coin: "xyz:TSLA", agents: "compose", status: 200, says: "A builder-dex market (dex:COIN): its dex, deployer and oracle source, one agent short, and a liquidated closed round." },
  { id: "no-agents", coin: "ETH", agents: "compose", status: 200, says: "A market no public Candle agent has traded: the figures, zero long, zero short, no positions and no rounds." },
  { id: "rounds-only", coin: "SOL", agents: "compose", status: 200, says: "A market with a closed round and no open position." },
  { id: "agents-unavailable", coin: "BTC", agents: "throws", status: 200, says: "The agents read fails (the board has no complete build): the figures are still served, agents null and agentsUnavailable true." },
  { id: "not-listed", coin: "NOPE", agents: "compose", status: 404, says: "A coin Hyperliquid does not list: 404 MARKET_NOT_FOUND." },
  { id: "malformed", coin: "xyz:TS-LA", agents: "compose", status: 400, says: "A coin that is not a perp market name: 400 before any read." },
]

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; says?: string; evidence?: string; args?: Record<string, unknown>; requests?: unknown[]; outcome: any }
const rows: Row[] = []
const restores: (() => void)[] = []
try {
  const hl = await load("apps/api/src/services/hyperliquid.ts")
  const { createHyperliquidGovernor } = await load("apps/api/src/services/hyperliquid-governor.ts")
  const marketAgents = await load("apps/api/src/ledger/perps/market-agents.ts")
  const store = await load("apps/api/src/ledger/views/board/store.ts")
  const { default: reads } = await load("apps/api/src/routes/agent-page-reads.ts")
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const limits = { agentsMax: marketAgents.MARKET_AGENTS_MAX, roundsMax: marketAgents.MARKET_ROUNDS_MAX }
  assert.deepEqual(limits, { agentsMax: 500, roundsMax: 20 })

  const now = spyOn(Date, "now").mockReturnValue(NOW)
  restores.push(() => now.mockRestore())
  const board = spyOn(store, "viewsBoard").mockReturnValue("postgres")
  restores.push(() => board.mockRestore())
  const quiet = spyOn(console, "error").mockImplementation(() => {})
  restores.push(() => quiet.mockRestore())

  for (const s of scenarios) {
    // A fresh transport per scenario, so each row lists the venue reads that one page load makes.
    const venue: { type: string; dex?: string; coin?: string }[] = []
    const transport = hl.createHyperliquidTransport({
      network: "mainnet", apiUrl: VENUE, now: () => NOW,
      governor: createHyperliquidGovernor({ now: () => NOW, config: { bootPhantom: 0 } }),
      fetch: (async (url: string, init: { body: string }) => {
        assert.equal(url, `${VENUE}/info`)
        const body = JSON.parse(init.body) as { type: string; dex?: string; coin?: string }
        venue.push({ type: body.type, ...(body.dex !== undefined ? { dex: body.dex } : {}), ...(body.coin !== undefined ? { coin: body.coin } : {}) })
        const answer = body.type === "perpDexs" ? DEXES
          : body.type === "metaAndAssetCtxs" ? UNIVERSES[body.dex ?? ""] ?? null
          : body.type === "fundingHistory" ? fundingOf(String(body.coin))
          : body.type === "predictedFundings" || body.type === "perpsAtOpenInterestCap" ? [] : undefined
        if (answer === undefined) throw new Error(`unexpected venue read: ${init.body}`)
        return { ok: true, status: 200, json: async () => answer }
      }) as never,
    })
    hl.__setHyperliquidTransportForTest(transport)
    const composed: unknown[] = []
    const read = spyOn(marketAgents, "readMarketAgents").mockImplementation((async (coin: string) => {
      if (s.agents === "throws") throw new Error("board has no complete build")
      const answer = marketAgents.composeMarketAgents(coin, holding(coin))
      composed.push(answer)
      return answer
    }) as never)
    let res: Response
    try { res = await reads.request(`/perps-markets/${encodeURIComponent(s.coin)}`) } finally { read.mockRestore(); hl.__setHyperliquidTransportForTest(null) }
    const text = await res.text()
    const body = JSON.parse(text)
    assert.equal(res.status, s.status, `${s.id}: ${text}`)
    if (s.status === 200) assert.equal(body.agentsUnavailable, s.agents === "throws")
    if (s.status === 200 && s.agents === "compose") assert.deepEqual(body.agents, composed[0])
    const path = `/api/v1/agent/perps-markets/${encodeURIComponent(s.coin)}`
    rows.push({ id: `${s.id}-api`, scenario: s.id, surface: "api-source", says: s.says,
      evidence: "Candle's own route and governed market-data reads against a stand-in Hyperliquid; the agents half is the pure composeMarketAgents on made-up public bundles in place of the database read",
      args: { path }, requests: venue,
      outcome: { status: res.status, cacheControl: res.headers.get("cache-control"), body } })

    // The same answer, served to the three clients over an intercepted fetch.
    const serve = (requests: Request[]) => (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
      assert.ok(String(url).startsWith(`${cfg.apiUrl}/`))
      const headers = new Headers(init?.headers)
      requests.push({ method: init?.method ?? "GET", path: String(url).slice(cfg.apiUrl.length), credential: headers.has("authorization") || headers.has("x-api-key") })
      return new Response(text, { status: res.status, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    const ok = s.status === 200
    {
      const requests: Request[] = []
      globalThis.fetch = serve(requests)
      const server = createCandleMcpServer({}, cfg)
      const client = new Client({ name: "harness-perp-market-recorder", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(b); await client.connect(a)
      try {
        const r: any = await client.callTool({ name: "candle_get_perp_market", arguments: { coin: s.coin } })
        const outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
        assert.equal(outcome.isError, !ok, `${s.id} mcp`)
        if (ok) assert.deepEqual(outcome.body, body, `${s.id} mcp relays the answer whole`)
        // Keyless: no credential is sent though one is configured.
        assert.deepEqual(requests, [{ method: "GET", path, credential: false }])
        rows.push({ id: `${s.id}-mcp`, scenario: s.id, surface: "mcp", args: { coin: s.coin }, requests, outcome })
      } finally { await client.close(); await server.close(); globalThis.fetch = deny }
    }
    {
      const requests: Request[] = []
      const client = new CandleClient({ ...cfg, fetch: serve(requests), maxRetries: 0 })
      let outcome: { body: any; isError: boolean }
      try { outcome = { body: await client.getPerpMarket(s.coin), isError: false } }
      catch (e: any) { outcome = { body: { code: e.code, status: e.status, message: e.message }, isError: true } }
      assert.equal(outcome.isError, !ok, `${s.id} sdk`)
      if (ok) { const { success: _s, ...answer } = body; assert.deepEqual(outcome.body, answer, `${s.id} sdk`) }
      assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", path]])
      rows.push({ id: `${s.id}-sdk`, scenario: s.id, surface: "sdk", args: { coin: s.coin }, requests: requests.map(({ method, path }) => ({ method, path })), outcome })
    }
    for (const json of [false, true]) {
      const requests: Request[] = []
      const stdout = createCapture(), stderr = createCapture()
      const deps = createTestDeps({ stdout, stderr, now: () => NOW, env: { CANDLE_API_URL: cfg.apiUrl }, fetch: serve(requests) })
      const args = ["perps", "market", s.coin, "--agents", ...(json ? ["--json"] : [])]
      const exitCode = await cli.run(args, deps)
      assert.equal(exitCode, ok ? 0 : 1, `${s.id} cli ${stdout.text}${stderr.text}`)
      // A public read: one GET, no key, though none is configured either.
      assert.deepEqual(requests, [{ method: "GET", path, credential: false }])
      if (ok && json) assert.deepEqual(JSON.parse(stdout.text), body, `${s.id} cli --json`)
      const lines = (t: string) => t.trimEnd().split("\n").filter((l) => l !== "")
      rows.push({ id: `${s.id}-cli${json ? "-json" : ""}`, scenario: s.id, surface: "cli", args: { command: `candle ${args.join(" ")}` }, requests,
        outcome: json && ok ? { exitCode, body: JSON.parse(stdout.text) } : { exitCode, lines: lines(stdout.text), ...(stderr.text ? { stderr: lines(stderr.text) } : {}) } })
    }
  }

  // What Candle's docs and the SDK's changelog say at this commit. Public text, read as text.
  const docLine = (file: string, starts: string) => {
    const found = readFileSync(join(checkout, file), "utf8").split("\n").filter((line) => line.startsWith(starts))
    assert.equal(found.length, 1, `${file}: one line starting ${starts}`)
    return found[0]!
  }
  const api = DOCS.map((file) => docLine(file, "- `GET /api/v1/agent/perps-markets/{coin}`"))
  assert.ok(api.every((line) => line === api[0]), "the three copies of the page say the same")
  rows.push({ id: "docs-agent-trading", scenario: "docs", surface: "docs", args: { files: DOCS }, outcome: { text: api[0] } })
  rows.push({ id: "docs-cli", scenario: "docs", surface: "docs", args: { files: [CLI_DOC] }, outcome: { text: docLine(CLI_DOC, "| `perps market <coin> --agents") } })
  rows.push({ id: "docs-mcp", scenario: "docs", surface: "docs", args: { files: [MCP_DOC] }, outcome: { text: docLine(MCP_DOC, "| `candle_get_perp_market`") } })
  rows.push({ id: "docs-sdk-changelog", scenario: "docs", surface: "docs", args: { files: ["packages/sdk/CHANGELOG.md"] }, outcome: { text: docLine("packages/sdk/CHANGELOG.md", "Release 0.6.27 (BE-3777)") } })

  let text = JSON.stringify(rows)
  for (const [real, role] of ROLES) text = text.split(real).join(role)
  assert.ok(!text.includes(WALLET) && !/0x[0-9a-f]{40}/i.test(text), "no wallet or deployer address in a recording")
  assert.ok(!text.includes(FILL_HASH) && !/0x[0-9a-f]{64}/i.test(text), "no fill hash in a recording")
  assert.ok(!/"(wallet|address|accountValue|accountValueUsd|marginUsedUsd|withdrawable|oid|cloid|hash)"/i.test(text), "no wallet, account value, margin, order id or hash in a recording")
  assert.ok(!text.includes(cfg.apiKey))
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-market-source.json"), `${JSON.stringify({
    about: "Offline perp market contracts from exact merged source. Every figure, market, dex, agent and time is made up; times are minutes before one made-up instant. api-source rows are Candle's own `GET /api/v1/agent/perps-markets/:coin` route and its governed market-data reads, run against a stand-in Hyperliquid (requests lists each venue read one page load makes); the agents half is Candle's pure composeMarketAgents on three made-up public agents' published bundles, put in where the route reads the database. The bundles carry a made-up wallet, account value and fill hash that no row carries; the builder dex's made-up deployer is named by its role. mcp, sdk and cli rows read the same answer through the registered tool, the SDK and `candle perps market <coin> --agents` over an intercepted fetch. docs rows are the public pages' own lines, read as text. The database, the public gate and the venue are not executed, and no deployed behavior is claimed.",
    source, limits, now: new Date(NOW).toISOString(), rows: JSON.parse(text),
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline perp market contracts (${scenarios.length} scenarios) from ${source.commit}.`)
} finally {
  while (restores.length) restores.pop()!()
  globalThis.fetch = originalFetch
}
