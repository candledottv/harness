// One Hyperliquid perp market's public figures and the published Candle agents long and short in it, as Candle's
// API answers `GET /api/v1/agent/perps-markets/:coin` and as `candle perps market <coin> --agents`,
// `candle_get_perp_market` and the SDK's `getPerpMarket()` read it. Recorded offline from one exact commit
// (scripts/read-perps-market-source.ts): Candle's own route and governed market-data reads run against a stand-in
// Hyperliquid, and its agents half is Candle's pure composer on made-up public agents' published bundles.
import { describe, expect, test } from "bun:test"
import market from "../../test/fixtures/candle-perps-market-source.json"
import perps from "../../test/fixtures/candle-perps-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { toOutcome } from "./candle-mcp"
import { classify, TOOL_CLASSES } from "./classify"
import { rowFor, SOURCE } from "./cli-table"
import { resolveCall } from "./cli-tool"

type Row = { id: string; scenario: string; surface: string; says?: string; evidence?: string; args?: Record<string, any>; requests?: any[]; outcome: any }
const rows = market.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const SCENARIOS = ["btc", "builder-dex", "no-agents", "rounds-only", "agents-unavailable", "not-listed", "malformed"] as const
type Scenario = (typeof SCENARIOS)[number]
const OK: Scenario[] = ["btc", "builder-dex", "no-agents", "rounds-only", "agents-unavailable"]
const api = (id: Scenario) => row(`${id}-api`).outcome as { status: number; cacheControl: string | null; body: any }
const body = (id: Scenario) => api(id).body
const venue = (id: Scenario) => (row(`${id}-api`).requests as { type: string; dex?: string }[]).map((r) => (r.dex ? `${r.type}:${r.dex}` : r.type))
const cli = (id: Scenario) => row(`${id}-cli`).outcome.lines as string[]
const NOW = Date.parse(market.now)
const M = 60_000
const path = (coin: string) => `/api/v1/agent/perps-markets/${encodeURIComponent(coin)}`
const COPY = "Measured record, not a forecast. Past results do not predict future results."

test("the recording names the exact merged source, the same commit as the CLI table, tools/list and the other perps fixtures", () => {
  expect(market.source).toEqual({ repo: "candledottv/candle-monorepo", commit: "31e075fe6ab401b03a562a2caba090f398b13fcd", versions: { cli: "0.13.34", mcp: "0.10.39", sdk: "0.6.28" } })
  expect(market.source.commit).toBe(SOURCE.source.commit)
  expect(market.source.commit).toBe(tools.source.commit)
  expect(market.source.commit).toBe(perps.source.commit)
  // Read from the source's constants: at most 500 agents gated per market, the 20 newest closed rounds.
  expect(market.limits).toEqual({ agentsMax: 500, roundsMax: 20 })
  expect(rows).toHaveLength(SCENARIOS.length * 5 + 4)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  for (const id of SCENARIOS) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(["api-source", "cli", "cli", "mcp", "sdk"])
  for (const id of SCENARIOS) expect(row(`${id}-api`).evidence).toContain("in place of the database read")
})

test("no wallet or deployer address, fill hash, account value, margin or key is in any recording", () => {
  const text = JSON.stringify(market)
  expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/)
  expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/)
  expect(text).not.toMatch(/"(wallet|address|accountValue|accountValueUsd|marginUsedUsd|withdrawable|oid|cloid|hash)"/i)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key/)
  // The builder dex's deployer is public on the venue; the recording names it by its role all the same.
  expect(body("builder-dex").market.deployer).toBe("<builder-dex-deployer>")
})

describe("the market figures", () => {
  test("a main-dex market: mark, 24 h change, funding now and its last hours, open interest and 24 h volume, each with a read time", () => {
    expect(api("btc")).toMatchObject({ status: 200, cacheControl: "public, s-maxage=15, stale-while-revalidate=60" })
    expect(body("btc")).toMatchObject({
      success: true, network: "mainnet", readAt: NOW, stale: false, agentsUnavailable: false,
      market: { coin: "BTC", dex: null, dexName: null, deployer: null, oracleSource: "validators", markPx: "63000", change24hPct: "5.0", fundingRate: "0.0000125", fundingAprPct: "10.95", openInterestUsd: "63000000.00", dayNotionalVolumeUsd: "900000000", maxLeverage: 40 },
    })
    expect(body("btc").funding).toMatchObject({ readAt: NOW, stale: false })
    expect(body("btc").funding.points.map((p: { time: number }) => (NOW - p.time) / M)).toEqual([180, 120, 60])
  })

  test("a builder-dex market (dex:COIN) names its dex, deployer and oracle source", () => {
    expect(body("builder-dex").market).toMatchObject({ coin: "xyz:TSLA", dex: "xyz", dexName: "XYZ Fixture", deployer: "<builder-dex-deployer>", oracleSource: "deployer", maxLeverage: 10 })
    expect(row("builder-dex-api").args).toEqual({ path: "/api/v1/agent/perps-markets/xyz%3ATSLA" })
    expect(cli("builder-dex")[0]).toStartWith("xyz:TSLA (builder dex xyz, deployer <builder-dex-deployer>, oracle set by the deployer): mark $250.00")
  })

  test("one page load is one governed read of each kind; a builder dex adds the dex list and its own universe, and a bad coin reads nothing", () => {
    expect(venue("btc").sort()).toEqual(["fundingHistory", "metaAndAssetCtxs", "perpsAtOpenInterestCap", "predictedFundings"])
    expect(venue("builder-dex").sort()).toEqual(["fundingHistory", "metaAndAssetCtxs:xyz", "perpDexs", "perpsAtOpenInterestCap", "predictedFundings"])
    expect(venue("not-listed")).not.toContain("fundingHistory")
    expect(venue("malformed")).toEqual([])
  })

  test("a coin Hyperliquid doesn't list is 404 and not cached; a name that isn't a perp market is 400", () => {
    expect(api("not-listed")).toMatchObject({ status: 404, cacheControl: "no-store", body: { success: false, error: { code: "MARKET_NOT_FOUND" } } })
    expect(api("malformed")).toMatchObject({ status: 400, body: { success: false, error: { code: "VALIDATION_FAILED", field: "coin" } } })
  })
})

describe("the Candle agents in the market", () => {
  test("long and short counts, net size and value, and each open position labelled as Long BTC 20x, largest first", () => {
    const a = body("btc").agents
    expect(a).toMatchObject({ coin: "BTC", long: 2, short: 1, netSize: "0.65", netValueUsd: "40950", truncated: false })
    expect(a.positions.map((p: any) => [p.agent.slug, p.label, p.size, p.entryPx, p.markPx, p.unrealizedPnlUsd])).toEqual([
      ["alpha-fixture", "Long BTC 20x", "0.5", "60000", "63000", "1500"],
      ["beta-fixture", "Long BTC 10x", "0.25", "62000", "63000", "250"],
      ["gamma-fixture", "Short BTC 25x", "0.1", "64000", "63000", "100"],
    ])
    // Each position carries its agent's own perps time; the block's is the oldest of the agents shown.
    expect(a.positions.map((p: any) => (NOW - p.asOfMs) / M)).toEqual([8, 8, 68])
    expect((NOW - a.asOfMs) / M).toBe(68)
    // An agent is its public profile: id, slug, name and picture, and nothing else.
    for (const p of a.positions) expect(Object.keys(p.agent).sort()).toEqual(["avatarUrl", "name", "profileId", "slug"])
  })

  test("recent closed rounds, newest first, link to their round page by id; a round published before ids has none", () => {
    expect(body("btc").agents.rounds.map((r: any) => [r.agent.slug, r.side, r.pnlUsd, r.roundId, (NOW - r.closedMs) / M])).toEqual([
      ["beta-fixture", "short", 40, null, 30],
      ["alpha-fixture", "long", 120, "rnd_0123456789abcdef", 90],
    ])
    expect(body("builder-dex").agents.rounds).toMatchObject([{ coin: "xyz:TSLA", side: "short", pnlUsd: -15, liquidated: true, roundId: "rnd_1123456789abcdef" }])
  })

  test("a market no public agent has traded: zero long, zero short, nothing listed, and no time", () => {
    expect(body("no-agents").agents).toEqual({ coin: "ETH", long: 0, short: 0, netSize: "0", netValueUsd: "0", positions: [], rounds: [], asOfMs: null, truncated: false })
    expect(body("rounds-only").agents).toMatchObject({ coin: "SOL", long: 0, short: 0, positions: [], rounds: [{ roundId: "rnd_2123456789abcdef", pnlUsd: 3 }] })
  })

  test("when the agents read fails, the figures are still served, with agents null and agentsUnavailable", () => {
    expect(api("agents-unavailable").status).toBe(200)
    expect(body("agents-unavailable")).toMatchObject({ agents: null, agentsUnavailable: true })
    expect(body("agents-unavailable").market).toEqual(body("btc").market)
  })
})

describe("the CLI, the MCP tool and the SDK read the same answer", () => {
  test("each is one keyless GET of the route; the MCP tool relays it whole, the SDK without success, the CLI's --json as is", () => {
    for (const id of SCENARIOS) {
      const coin = row(`${id}-mcp`).args!.coin as string
      const one = [{ method: "GET", path: path(coin), credential: false }]
      expect(row(`${id}-mcp`).requests).toEqual(one)
      expect(row(`${id}-cli`).requests).toEqual(one)
      expect(row(`${id}-cli-json`).requests).toEqual(one)
      expect(row(`${id}-sdk`).requests).toEqual([{ method: "GET", path: path(coin) }])
    }
    for (const id of OK) {
      expect(row(`${id}-mcp`).outcome).toEqual({ body: body(id), isError: false })
      const { success: _success, ...answer } = body(id)
      expect(row(`${id}-sdk`).outcome).toEqual({ body: answer, isError: false })
      expect(row(`${id}-cli-json`).outcome).toEqual({ exitCode: 0, body: body(id) })
    }
    expect(row("not-listed-mcp").outcome).toEqual({ body: body("not-listed"), isError: true })
    expect(row("not-listed-sdk").outcome).toEqual({ body: { code: "MARKET_NOT_FOUND", status: 404, message: "No such perp market" }, isError: true })
    expect(row("not-listed-cli-json").outcome.exitCode).toBe(1)
    expect(row("malformed-sdk").outcome.body).toMatchObject({ code: "VALIDATION_FAILED", status: 400 })
  })

  test("`candle perps market BTC --agents` prints the figures, the counts, the positions, the closed rounds and the copy line", () => {
    expect(cli("btc")).toEqual([
      "BTC: mark $63,000.00, 24h +5.0%, funding/h 0.0013%, open interest $63.00M, 24h volume $900.00M; as of Jan 12 14:00Z",
      "Candle agents in BTC: 2 long, 1 short, net size 0.65",
      "Agent          Position       Size  Entry  Mark   P&L (ROE)             As of",
      "-------------  -------------  ----  -----  -----  --------------------  -------------",
      "Alpha Fixture  Long BTC 20x   0.5   60000  63000  +$1,500.00 (+100.0%)  Jan 12 13:52Z",
      "Beta Fixture   Long BTC 10x   0.25  62000  63000  +$250.00 (+16.1%)     Jan 12 13:52Z",
      "gamma-fixture  Short BTC 25x  0.1   64000  63000  +$100.00 (+39.1%)     Jan 12 12:52Z",
      "Recent closed rounds",
      "Agent          Side   P&L       Closed         Round",
      "-------------  -----  --------  -------------  --------------------",
      "Beta Fixture   short  +$40.00   Jan 12 13:30Z  -",
      "Alpha Fixture  long   +$120.00  Jan 12 12:30Z  rnd_0123456789abcdef",
      COPY,
    ])
  })

  test("with no agent in the market the CLI says so; with the agents unavailable it says that, and never none", () => {
    expect(cli("no-agents").slice(1)).toEqual(["Candle agents in ETH: 0 long, 0 short, net size 0", "No public Candle agent holds an open position in this market.", COPY])
    expect(cli("rounds-only")).toContain("Recent closed rounds")
    expect(cli("agents-unavailable").slice(1)).toEqual(["Candle agents: unavailable right now (the board has no complete build)."])
    expect(row("not-listed-cli").outcome).toEqual({ exitCode: 1, lines: [], stderr: ["No such perp market"] })
  })

  test("Candle's pages and the SDK changelog describe the same read", () => {
    expect(row("docs-agent-trading").outcome.text).toContain("`agents` is `null` with `agentsUnavailable: true` while the board has no complete build")
    expect(row("docs-cli").outcome.text).toContain("No wallet address")
    expect(row("docs-mcp").outcome.text).toStartWith("| `candle_get_perp_market` | `GET /api/v1/agent/perps-markets/:coin`")
    expect(row("docs-sdk-changelog").outcome.text).toMatch(/^Release 0\.6\.27 \(BE-3777\), with CLI 0\.13\.33 and MCP 0\.10\.38\. `getPerpMarket\(coin\)`/)
  })
})

describe("in the Candle Harness", () => {
  test("candle_get_perp_market is in the source tools/list and classified as a read in live and paper", () => {
    const tool = tools.tools.find((t) => t.name === "candle_get_perp_market")
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(["coin"])
    expect(TOOL_CLASSES.candle_get_perp_market).toEqual({ class: "read" })
    for (const mode of ["live", "paper"] as const) expect(classify("candle_get_perp_market", { coin: "BTC" }, mode)).toEqual({ class: "read" })
  })

  test("the agent reads the tool's answer whole, unavailable agents included", () => {
    for (const id of OK) {
      const { outcome } = row(`${id}-mcp`)
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: outcome.isError })).toEqual({ kind: "ok", result: body(id) })
    }
  })

  test("`candle perps market <coin> --agents` through candle_cli points at candle_get_perp_market", () => {
    expect(SOURCE.commands.find((c) => c.command === "perps" && c.subcommand === "market")).toMatchObject({ identity: "agent", flags: { boolean: ["--agents", "--all"] } })
    expect(rowFor("perps market")).toMatchObject({ rule: "mcp", route: "cli", identity: "agent", mcpTool: "candle_perps_market" })
    const routed = resolveCall({ command: "perps", subcommand: "market", args: ["xyz:TSLA", "--agents"] }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
    expect(routed.ok && routed.call.rule).toBe("mcp")
    expect(routed.ok && routed.call.row.note).toContain("candle_get_perp_market (--agents)")
  })
})
