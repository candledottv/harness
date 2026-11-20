// Offline agent perps summary contracts from an exact clean Candle source checkout (BE-3775): one published
// agent's Hyperliquid perps summary for a window, as `candle agent <profile-id|slug> --perps [--window]`,
// `candle_get_agent_perps_summary` (the local server) and the SDK's `getAgentPerpsSummary()` give it. Per window
// (all, 24h, 7d, 30d): net and its parts (realized, unrealized, funding, fees), volume (px x sz per fill, builder-dex
// fills included) and fees to volume, rounds closed, win rate, largest win and loss, highest and average leverage
// ("leverage not recorded" left out), liquidations and max drawdown in dollars.
//
// Each answer is built by Candle's own pure source (`perpsProfileBundle`, `perpsProfileHourly`, `boardPerpsOf`,
// `publishBoardPerps`, `perpsSummaryOf`) from one made-up wallet's stored facts over forty made-up days, then read
// through every agent surface. The route's envelope (`publishedBuildId`, `seq`), the slug read and the refusals
// are stand-ins; the refusals carry the route's own codes and words, which this script checks are in its source.
// The chart's All / Spot / Perps split is run as the pure function it is (`composeChartAnswer`) over a stand-in
// spot chart, since no agent surface reads the chart at this commit (checked below). The wallet's address goes
// into Candle's source only and never into the fixture. Every fetch is intercepted; no key, database, venue or
// keyed API route is used.
//   bun scripts/read-perps-summary-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { canonicalJson } from "../src/shared/canonical-json"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-summary-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const API_SOURCES = [
  "apps/api/src/ledger/perps/profile.ts", "apps/api/src/ledger/views/board/perps.ts", "apps/api/src/ledger/views/board/perps-summary.ts",
  "apps/api/src/mcp/hosted.ts", "apps/api/src/routes/agent-page-reads.ts",
]
/** The route answer Candle's own CLI, MCP, SDK and web tests share. */
const ROUTE_FIXTURE = "packages/shared/src/agent-perps-summary.fixture.json"
/** The public page that gives each formula, and its two published copies. */
const DOCS = ["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"]
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", "packages/db", ROUTE_FIXTURE, ...API_SOURCES, ...DOCS)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const originalNow = Date.now
const deny = (() => { throw new Error("perps summary recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

const D = 86_400_000, H = 3_600_000, M = 60_000
/** Forty-one made-up days; every time below is a day (0 to 40), an hour and a minute of them, in UTC. */
const DAY = Date.UTC(2027, 0, 1)
const t = (day: number, h: number, m = 0) => DAY + day * D + h * H + m * M
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`
const PROFILE = "prof_0123456789abcdef"
const SLUG = "summary-fixture"
/** Input to Candle's pure source only: it is hashed there, and no row below may carry it. */
const WALLET = `0x${"5ca1e".repeat(8)}`
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const usd = (n: number) => BigInt(Math.round(n * 1_000_000))
/** The build every summary below is read at: day 40 12:30, the 12:02 hour certified. */
const BUILD = t(40, 12, 30)

type Position = Record<string, unknown>
type Fill = { coin: string; tid: string; hash: string; time: number; side: "A" | "B"; startPosition: string; sz: string; px?: string; closedPnlUsdMicros: bigint; feeUsdMicros: bigint; liquidated: boolean }
type Facts = {
  wallet: string
  ingest: { coverageFromMs: number; historyPartial: boolean; completeThroughMs: number | null }
  hours: { hourMs: number; cutoffMs: number | null; readOk: boolean; positions: Position[] | null }[]
  decisions: { hourMs: number; outcome: "certified" | "abandoned"; cutoffMs: number; fillsThroughMs: number | null; fundingThroughMs: number | null }[]
  fills: Fill[]; funding: { coin: string; time: number; usdcUsdMicros: bigint }[]; gaps: never[]
  leverageOrders: { coin: string; atMs: number; leverage: number; isCross: boolean }[]
}
let tid = 1
/** One stored fill: `delta` is signed (a buy is positive), `closedPnl` and `fee` are the exchange's own figures. */
const fill = (coin: string, time: number, start: number, delta: number, px: number, closedPnl = 0, fee = 0, liquidated = false): Fill => ({
  coin, tid: String(tid++), hash: `0x${time.toString(16).padStart(64, "0")}`, time, side: delta > 0 ? "B" : "A",
  startPosition: String(start), sz: String(Math.abs(delta)), px: String(px), closedPnlUsdMicros: usd(closedPnl), feeUsdMicros: usd(fee), liquidated,
})
/** One open position as a certified hour saw it. */
const position = (coin: string, side: "long" | "short", size: number, entryPx: number, unrealized: number, leverage: number): Position => {
  const markPx = entryPx + (side === "long" ? 1 : -1) * unrealized / size
  return {
    coin, side, size: String(size), entryPx: String(entryPx), markPx: String(markPx), unrealizedPnlUsd: String(unrealized),
    returnOnEquity: (unrealized / (size * entryPx / leverage)).toFixed(4), leverage: { value: leverage, type: "cross" }, liquidationPx: null, liquidationDistance: null,
    fundingSinceOpenUsd: "0", marginUsedUsd: String(size * markPx / leverage), positionValueUsd: String(size * markPx), level: "ok",
  }
}

// The made-up wallet's stored history: one closed round in each window's own span, two in the last day, one
// position open at the build and one builder-dex buy. A round's P&L is closed P&L - fees + funding while it was open.
/** R1, ALL only: BTC long, 5x by a Candle leverage action, 0.2 at 60000 out at 61500: +300 - 4.8 - 4.92 = +290.28. */
const R1 = [fill("BTC", t(3, 10), 0, 0.2, 60000, 0, 4.8), fill("BTC", t(3, 14), 0.2, -0.2, 61500, 300, 4.92)]
/** R2, 30D: ETH short, no leverage action, the 11:02 hour saw it at 4x; 4 at 2500 bought back at 2450, +2.5 funding received: +200 - 4 - 3.92 + 2.5 = +194.58. */
const R2 = [fill("ETH", t(15, 10), 0, -4, 2500, 0, 4), fill("ETH", t(15, 12), -4, 4, 2450, 200, 3.92)]
/** R3, 7D: SOL long opened and closed between two certified hours with no leverage action, 20 at 150 out at 140: -200 - 1.2 - 1.12 = -202.32. */
const R3 = [fill("SOL", t(36, 8), 0, 20, 150, 0, 1.2), fill("SOL", t(36, 9), 20, -20, 140, -200, 1.12)]
/** R4, 24H: DOGE long, 25x by a leverage action, liquidated: 5000 at 0.30, closed by the exchange at 0.27: -150 - 0.6 - 0.54 = -151.14. */
const R4 = [fill("DOGE", t(40, 1), 0, 5000, 0.3, 0, 0.6), fill("DOGE", t(40, 3), 5000, -5000, 0.27, -150, 0.54, true)]
/** R5, 24H: ETH long, 10x by a leverage action, 1 at 2600 out at 2680: +80 - 1.04 - 1.07 = +77.89. */
const R5 = [fill("ETH", t(40, 5), 0, 1, 2600, 0, 1.04), fill("ETH", t(40, 7), 1, -1, 2680, 80, 1.07)]
/** Open at the build: 0.1 BTC long at 62000, 3x; the 12:02 hour sees +50 unrealized. */
const OPEN = fill("BTC", t(40, 9), 0, 0.1, 62000, 0, 2.48)
/** A builder-dex buy: 2 xyz:GOLD at 2400. Its fee is charged in the dex's own token and is not in the record's fees. */
const DEX = fill("xyz:GOLD", t(40, 10), 0, 2, 2400, 0, 1)
const LEVERAGE_ORDERS = [
  { coin: "BTC", atMs: t(3, 9, 55), leverage: 5, isCross: true },
  { coin: "DOGE", atMs: t(40, 0, 55), leverage: 25, isCross: true },
  { coin: "ETH", atMs: t(40, 4, 55), leverage: 10, isCross: false },
  { coin: "BTC", atMs: t(40, 8, 55), leverage: 3, isCross: true },
]
/** Stored coverage starts at the first made-up midnight. */
const COVERAGE_FROM = t(0, 0)
function history(): Facts {
  const f: Facts = { wallet: WALLET, ingest: { coverageFromMs: COVERAGE_FROM, historyPartial: false, completeThroughMs: null }, hours: [], decisions: [], fills: [], funding: [], gaps: [], leverageOrders: [...LEVERAGE_ORDERS] }
  f.fills.push(...R1, ...R2, ...R3, ...R4, ...R5, OPEN, DEX)
  f.funding.push({ coin: "ETH", time: t(15, 10, 30), usdcUsdMicros: usd(2.5) })
  const certify = (hourMs: number, positions: Position[]) => {
    const cutoffMs = hourMs + 2 * M
    f.hours.push({ hourMs, cutoffMs, readOk: true, positions })
    f.decisions.push({ hourMs, outcome: "certified", cutoffMs, fillsThroughMs: cutoffMs, fundingThroughMs: cutoffMs })
    f.ingest.completeThroughMs = Math.max(f.ingest.completeThroughMs ?? 0, cutoffMs)
  }
  // Certified hours: after R1, at each window's start hour, around R2 and after each later round, and the build's.
  certify(t(3, 15), [])
  certify(t(10, 12), []) // the 30D start
  certify(t(15, 11), [position("ETH", "short", 4, 2500, -40, 4)])
  certify(t(15, 13), [])
  certify(t(33, 12), []) // the 7D start
  certify(t(36, 10), [])
  certify(t(39, 12), []) // the 24H start
  certify(t(40, 4), [])
  certify(t(40, 8), [])
  certify(t(40, 12), [position("BTC", "long", 0.1, 62000, 50, 3)]) // the end observation
  return f
}
/** The builder-dex buy stored before fill prices were kept: no price, so no notional. */
function unpricedFacts(): Facts {
  const f = history()
  f.fills = f.fills.map((x) => (x.coin === "xyz:GOLD" ? (({ px: _px, ...rest }) => rest)(x) : x)) as Fill[]
  return f
}
/** Two daily points a prior build published: day 4 (after R1) and day 8, the all-time peak. */
const PRIOR_DAYS = [
  { dayMs: t(4, 0), realizedNetUsd: 290.28, unrealizedUsd: 0, netUsd: 290.28, partial: false },
  { dayMs: t(8, 0), realizedNetUsd: 520, unrealizedUsd: 0, netUsd: 520, partial: false },
]

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; window?: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []
try {
  const { perpsProfileBundle, perpsProfileHourly, floorPerpsHour, PERPS_WINDOW_MS, PERPS_STALE_MS, PERPS_UNAVAILABLE_MS } = await load("apps/api/src/ledger/perps/profile.ts")
  const { boardPerpsOf, publishBoardPerps, composeChartAnswer, perpsPnlSeries, maxDrawdownUsd } = await load("apps/api/src/ledger/views/board/perps.ts")
  const { perpsSummaryOf } = await load("apps/api/src/ledger/views/board/perps-summary.ts")
  const { createHostedMcpRoute, HOSTED_TOOL_NAMES } = await load("apps/api/src/mcp/hosted.ts")
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { CandleApiError } = await load("packages/sdk/src/errors.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const rules = { staleMs: PERPS_STALE_MS, unavailableMs: PERPS_UNAVAILABLE_MS, windowsMs: PERPS_WINDOW_MS }
  assert.deepEqual(rules, { staleMs: 2 * H, unavailableMs: 3 * H, windowsMs: { "24h": D, "7d": 7 * D, "30d": 30 * D } })
  assert.ok(!HOSTED_TOOL_NAMES.includes("candle_get_agent_perps_summary"), "the summary tool is local-only at this commit")

  const SUMMARY_PATH = `/api/v1/agent/records/${PROFILE}/perps`
  const pathFor = (window?: string) => (window === undefined ? SUMMARY_PATH : `${SUMMARY_PATH}?window=${window}`)
  type Answer = { status: number; body: unknown }
  /** A stand-in for the API: each path answers what the table says, and every request is noted. */
  const serve = (table: Record<string, Answer>, requests: Request[]) => (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const request = input instanceof globalThis.Request ? input : null
    const url = String(request ? request.url : input)
    assert.ok(url.startsWith(`${cfg.apiUrl}/`), `unexpected host: ${url}`)
    const path = url.slice(cfg.apiUrl.length)
    const headers = new Headers(request ? request.headers : init?.headers)
    const method = request ? request.method : (init?.method ?? "GET")
    requests.push({ method, path, credential: headers.has("authorization") || headers.has("x-api-key") })
    assert.equal(method, "GET")
    const answer = table[path]
    if (!answer) throw new Error(`unexpected local request: ${path}`)
    return Response.json(answer.body, { status: answer.status })
  }) as unknown as typeof fetch
  const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
  const lines = (text: string) => text.trimEnd().split("\n").filter((line, i, all) => line !== "" || all.length > 1)
  /** The CLI's clock (its human view prints a year only when it differs from now's): five minutes after the build. */
  const CLI_NOW = BUILD + 5 * M

  /**
   * One read of a summary through each agent surface. `window` undefined is the default: the MCP tool and the SDK
   * send no window, and the CLI, given no --window, asks for all. `relays` names the api row that keeps the answer.
   */
  async function surfaces(base: { scenario: string; window?: string; buildAt?: string }, table: Record<string, Answer>, relays: string, window?: string, as: { slug?: boolean } = {}) {
    const answer = table[pathFor(window)] ?? table[pathFor("all")]!
    const ok = answer.status === 200
    const kept = (body: unknown) => (ok ? { relays, sha256: sha256(body) } : { body })
    const args = { profileId: PROFILE, ...(window === undefined ? {} : { window }) }
    const one = [{ method: "GET", path: pathFor(window), credential: false }]
    const suffix = window === undefined ? "-default" : ""
    if (!as.slug) {
      {
        const requests: Request[] = []
        globalThis.fetch = serve(table, requests)
        const server = createCandleMcpServer({}, cfg)
        const client = new Client({ name: "harness-perps-summary-recorder", version: "1" })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(b); await client.connect(a)
        try {
          const r: any = await client.callTool({ name: "candle_get_agent_perps_summary", arguments: args })
          const outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
          // The tool relays the route's answer whole, a refusal as an error, and sends no credential though one is configured.
          assert.deepEqual(outcome, { body: answer.body, isError: !ok }, `${base.scenario}${suffix} mcp`)
          assert.deepEqual(requests, one)
          rows.push({ id: `${base.scenario}${suffix}-mcp`, ...base, surface: "mcp", args, requests, outcome: { ...kept(outcome.body), isError: outcome.isError } })
        } finally { await client.close(); await server.close(); globalThis.fetch = deny }
      }
      {
        const requests: Request[] = []
        const client = new CandleClient({ ...cfg, fetch: serve(table, requests), maxRetries: 0 })
        let outcome: Record<string, unknown>
        try {
          const body = await client.getAgentPerpsSummary(PROFILE, window === undefined ? {} : { window })
          assert.ok(ok, `${base.scenario}${suffix} sdk answered a refusal`)
          // The SDK gives the answer without `success`.
          const { success: _success, ...rest } = answer.body as Record<string, unknown>
          assert.deepEqual(body, rest, `${base.scenario}${suffix} sdk`)
          outcome = { relays, part: "answer without success", sha256: sha256(body), isError: false }
        } catch (err) {
          if (ok || !(err instanceof CandleApiError)) throw err
          outcome = { isError: true, error: { status: (err as { status: number }).status, code: (err as { code: string }).code, message: (err as Error).message } }
        }
        assert.deepEqual(requests, one, `${base.scenario}${suffix} sdk sent no credential`)
        rows.push({ id: `${base.scenario}${suffix}-sdk`, ...base, surface: "sdk", args, requests, outcome })
      }
    }
    for (const json of [false, true]) {
      const requests: Request[] = []
      const stdout = createCapture(), stderr = createCapture()
      const deps = createTestDeps({ stdout, stderr, env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_API_URL: cfg.apiUrl }, fetch: serve(table, requests) })
      const named = as.slug ? SLUG : PROFILE
      const argv = ["agent", named, "--perps", ...(window === undefined ? [] : ["--window", window]), ...(json ? ["--json"] : [])]
      Date.now = () => CLI_NOW
      let exitCode: number
      try { exitCode = await cli.run(argv, deps) } finally { Date.now = originalNow }
      assert.equal(exitCode, ok ? 0 : 1, `${base.scenario}${suffix} cli ${stdout.text}${stderr.text}`)
      // A public read: no key is sent though one is in the environment. The CLI always names the window.
      const expected = [...(as.slug ? [{ method: "GET", path: `/api/v1/agent/slug/${SLUG}`, credential: false }] : []), { method: "GET", path: pathFor(window ?? "all"), credential: false }]
      assert.deepEqual(requests, expected)
      let outcome: Record<string, unknown>
      if (json) {
        const printed = JSON.parse(ok ? stdout.text : (stdout.text || stderr.text))
        if (ok) assert.deepEqual(printed, answer.body, `${base.scenario}${suffix} cli --json`)
        outcome = { exitCode, ...kept(printed) }
      } else outcome = ok ? { exitCode, lines: lines(stdout.text) } : { exitCode, stdout: lines(stdout.text), stderr: lines(stderr.text) }
      if (ok) assert.equal(stderr.text, "")
      rows.push({ id: `${base.scenario}${suffix}-cli${json ? "-json" : ""}`, ...base, surface: "cli", args: { command: `candle ${argv.join(" ")}` }, requests, outcome })
    }
  }

  const periods = [{ walletAddress: WALLET, profileId: PROFILE, fromMs: t(0, 0), toMs: null, servable: true }]
  /** The board's own steps for one profile: the bundle, the hourly components over 30 days, the board figures, the publish over a prior build. */
  function publish(facts: Facts, B: number, prior: unknown) {
    const input = { profileId: PROFILE, periods, wallets: [facts] }
    const bundle = perpsProfileBundle({ ...input, buildAtMs: B })
    const toHourMs = floorPerpsHour(B)
    const hourly = bundle.available ? perpsProfileHourly({ ...input, fromHourMs: toHourMs - PERPS_WINDOW_MS["30d"], toHourMs }) : []
    return publishBoardPerps(boardPerpsOf(bundle, hourly, [facts]), prior, B)
  }
  /** A prior build: the same profile published with the two daily points. */
  const first = publish(history(), BUILD, null)
  assert.ok(first.available)
  const prior = { ...first, daily: PRIOR_DAYS }
  const published = publish(history(), BUILD, prior)
  assert.ok(published.available)

  let seq = 70
  const envelope = (window: string, summary: unknown, build: number) => ({ success: true, window, publishedBuildId: `build_fixture_${String(build).padStart(2, "0")}`, summary, seq: seq++ })
  const WINDOWS = ["all", "24h", "7d", "30d"] as const

  // 1. The build at day 40 12:30, every window.
  for (const window of WINDOWS) {
    const summary = perpsSummaryOf(published, window)
    const body = envelope(window, summary, 1)
    const base = { scenario: `summary-${window}`, window, buildAt: when(BUILD) }
    const outcome: Record<string, unknown> = { answer: body }
    if (summary.available) {
      // The series the max drawdown reads, as the source builds it: the hourly points (daily ones before them for all), then the build's.
      const series = perpsPnlSeries(published, window) as { ts: number; pnlUsd: number }[]
      assert.equal(maxDrawdownUsd(series), summary.maxDrawdownUsd)
      // Kept where the value moves (the first point, each change, and the build's last), with the whole series' length.
      const round6 = (n: number) => Math.round(n * 1e6) / 1e6
      const moves = series.filter((p, i) => i === 0 || i === series.length - 1 || round6(p.pnlUsd) !== round6(series[i - 1]!.pnlUsd))
      outcome.drawdownSeries = { points: series.length, moves: moves.map((p) => ({ at: when(p.ts), pnlUsd: round6(p.pnlUsd) })) }
    }
    rows.push({ id: `summary-${window}-api`, ...base, surface: "api-source",
      says: `Day 40 12:30, the 12:02 hour certified: the ${window} summary of five closed rounds (one in each window's own span, two in the last day), one position open, one builder-dex buy.`,
      evidence: "pure API source on made-up stored facts (perpsProfileBundle, perpsProfileHourly, boardPerpsOf, publishBoardPerps over a prior build with two daily points, perpsSummaryOf), in a stand-in route envelope; the database, the public gate and the perps jobs are not executed",
      outcome })
    await surfaces(base, { [pathFor(window)]: { status: 200, body } }, `summary-${window}-api`, window)
  }
  // The default window: the MCP tool and the SDK send none, the CLI asks for all; the route answers all.
  {
    const body = envelope("all", perpsSummaryOf(published, "all"), 1)
    rows.push({ id: "summary-default-api", scenario: "summary-default", buildAt: when(BUILD), surface: "api-source", says: "No window given: the route's default is all.", evidence: "the same pure source answer as summary-all, read with no window", outcome: { answer: body } })
    await surfaces({ scenario: "summary-default", buildAt: when(BUILD) }, { [pathFor()]: { status: 200, body }, [pathFor("all")]: { status: 200, body } }, "summary-default-api")
  }
  // A slug: the CLI resolves it through the public slug read first, then reads the summary by profile id.
  {
    const body = envelope("7d", perpsSummaryOf(published, "7d"), 1)
    const slugPath = `/api/v1/agent/slug/${SLUG}`
    const slugAnswer = { success: true, resolved: { profileId: PROFILE } }
    rows.push({ id: "summary-slug-api", scenario: "summary-slug", window: "7d", buildAt: when(BUILD), surface: "api-stub", says: "The CLI takes a slug too: the public slug read gives the profile id.", evidence: "a slug answer stand-in, then the 7d pure source answer", outcome: { slug: slugAnswer, answer: body } })
    await surfaces({ scenario: "summary-slug", window: "7d", buildAt: when(BUILD) }, { [slugPath]: { status: 200, body: slugAnswer }, [pathFor("7d")]: { status: 200, body } }, "summary-slug-api answer", "7d", { slug: true })
  }
  // 2. The builder-dex buy stored without its price: left out of the volume, counted, and the summary partial.
  {
    const p = publish(unpricedFacts(), BUILD, prior)
    const body = envelope("24h", perpsSummaryOf(p, "24h"), 2)
    const base = { scenario: "unpriced-fill", window: "24h", buildAt: when(BUILD) }
    rows.push({ id: "unpriced-fill-api", ...base, surface: "api-source", says: "The same build with the builder-dex buy stored before fill prices were kept: no notional, so it is left out of the volume, counted in volumeUnpricedFills, and the summary is partial.", evidence: "pure API source on made-up stored facts, one fill without px; the database, the public gate and the perps jobs are not executed", outcome: { answer: body } })
    await surfaces(base, { [pathFor("24h")]: { status: 200, body } }, "unpriced-fill-api", "24h")
  }
  // 3. A bundle published before the summary's figures: unknown, never zero.
  {
    const { summary: _drop, ...window } = published.windows["7d"]
    const old = { ...published, windows: { ...published.windows, "7d": window } }
    const body = envelope("7d", perpsSummaryOf(old, "7d"), 3)
    const base = { scenario: "older-bundle", window: "7d", buildAt: when(BUILD) }
    rows.push({ id: "older-bundle-api", ...base, surface: "api-source", says: "A bundle published before #4073 has no summary figures in its window: volume, fees to volume, leverage, liquidations and drawdown are null, and the record's own figures stay.", evidence: "pure perpsSummaryOf on the published bundle with the 7d window's summary figures taken out, as an older build stored it", outcome: { answer: body } })
    await surfaces(base, { [pathFor("7d")]: { status: 200, body } }, "older-bundle-api", "7d")
  }
  // 4. Delayed: day 40 14:45, certification still at 12:02, past the 2-hour line: the same figures, partial.
  {
    const B = t(40, 14, 45)
    const p = publish(history(), B, published)
    const body = envelope("all", perpsSummaryOf(p, "all"), 4)
    const base = { scenario: "delayed", window: "all", buildAt: when(B) }
    rows.push({ id: "delayed-api", ...base, surface: "api-source", says: "Day 40 14:45, certification still at 12:02: 2 h 43 min old, past the 2-hour line, so the figures are served partial.", evidence: "pure API source, published over the day 40 12:30 build; the database, the public gate and the perps jobs are not executed", outcome: { answer: body } })
    await surfaces(base, { [pathFor("all")]: { status: 200, body } }, "delayed-api", "all")
  }
  // 5. Unavailable: day 40 15:20, over 3 hours: no figures at all, and the last certified time.
  {
    const B = t(40, 15, 20)
    const p = publish(history(), B, published)
    const body = envelope("30d", perpsSummaryOf(p, "30d"), 5)
    const base = { scenario: "unavailable", window: "30d", buildAt: when(B) }
    rows.push({ id: "unavailable-api", ...base, surface: "api-source", says: "Day 40 15:20, certification still at 12:02: over 3 hours old, so the perps are unavailable: no figure, never zero, and the time they were last true.", evidence: "pure API source, published over the day 40 12:30 build; the database, the public gate and the perps jobs are not executed", outcome: { answer: body } })
    await surfaces(base, { [pathFor("30d")]: { status: 200, body } }, "unavailable-api", "30d")
  }
  // 6. A public agent with no perps history: summary null (no row on its page).
  {
    const body = envelope("all", null, 6)
    const base = { scenario: "no-perps", window: "all", buildAt: when(BUILD) }
    rows.push({ id: "no-perps-api", ...base, surface: "api-stub", says: "A public agent with no perps wallet: summary is null.", evidence: "the route's answer for a profile readActivePerps finds nothing for (readPublicPerpsSummary: perps ? perpsSummaryOf(...) : null), as a stand-in", outcome: { answer: body } })
    await surfaces(base, { [pathFor("all")]: { status: 200, body } }, "no-perps-api", "all")
  }
  // 7. Candle's own shared route answer, through every surface.
  {
    const body = JSON.parse(readFileSync(join(checkout, ROUTE_FIXTURE), "utf8"))
    rows.push({ id: "route-fixture-api", scenario: "route-fixture", window: body.window, surface: "api-source", evidence: `${ROUTE_FIXTURE}, the route answer Candle's CLI, MCP, SDK and web tests share (Candle's own fixture agent's 7d answer), read as it is`, says: "Candle's own fixture agent, 7d.", outcome: { answer: body } })
    await surfaces({ scenario: "route-fixture", window: body.window }, { [pathFor(body.window)]: { status: 200, body } }, "route-fixture-api", body.window)
  }
  // 8. Refusals, as stand-ins carrying the route's own status, code and words (checked as source text).
  const route = readFileSync(join(checkout, "apps/api/src/routes/agent-page-reads.ts"), "utf8")
  const refusals = [
    { id: "refused-not-published", says: "A private, hidden, revoked or unknown agent: the same 404 as every record read.", window: "7d", status: 404, source: `errorBody("RECORD_NOT_FOUND", "No published record for this agent")`, body: { success: false, error: { code: "RECORD_NOT_FOUND", message: "No published record for this agent" } } },
    { id: "refused-not-served", says: "A deployment that does not serve the board from Postgres yet: 503 for every profile, not retryable.", window: "all", status: 503, source: `code: "perps_summary_unavailable",\n          message: "The perps summary is not served by this API yet",\n          retryable: false,`, body: { success: false, error: { code: "perps_summary_unavailable", message: "The perps summary is not served by this API yet", retryable: false } } },
  ]
  for (const r of refusals) {
    assert.ok(route.includes(r.source), `the route no longer says: ${r.source}`)
    rows.push({ id: `${r.id}-api`, scenario: r.id, window: r.window, surface: "api-stub", evidence: "a response stand-in carrying the route's own status, code and message, which the recorder checks are in the route's source", says: r.says, outcome: { status: r.status, body: r.body } })
    await surfaces({ scenario: r.id, window: r.window }, { [pathFor(r.window)]: { status: r.status, body: r.body } }, `${r.id}-api`, r.window)
  }
  {
    // The route's 400 for a window it does not know: no surface sends one (the tool's schema and the CLI refuse it first).
    const message = "window must be 24h, 7d, 30d or all"
    assert.ok(route.includes(`return invalid(c, "window", "${message}")`), "the route's window refusal")
    rows.push({ id: "refused-window-api", scenario: "refused-window", surface: "api-stub", says: "The route refuses a window it does not know, 400 VALIDATION_FAILED on the field window. No agent surface can send one: each refuses it first, below.", evidence: "the route's own words, checked in its source", outcome: { status: 400, source: `invalid(c, "window", "${message}")` } })
  }
  // 9. What never leaves the machine.
  async function cliUsage(id: string, argv: string[], says: string, table: Record<string, Answer> = {}, exit = 2) {
    const requests: Request[] = []
    const stdout = createCapture(), stderr = createCapture()
    const deps = createTestDeps({ stdout, stderr, env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_API_URL: cfg.apiUrl }, fetch: serve(table, requests) })
    const exitCode = await cli.run(argv, deps)
    assert.equal(exitCode, exit, `${id}: ${stdout.text}${stderr.text}`)
    rows.push({ id, scenario: "usage", surface: "cli", args: { command: `candle ${argv.join(" ")}` }, requests, says, outcome: { exitCode, stdout: lines(stdout.text).filter(Boolean), stderr: lines(stderr.text).filter(Boolean) } })
    return requests
  }
  assert.deepEqual(await cliUsage("usage-cli-window-unknown", ["agent", PROFILE, "--perps", "--window", "90d"], "A window the command does not take: usage, and nothing is read."), [])
  assert.deepEqual(await cliUsage("usage-cli-no-perps-flag", ["agent", PROFILE], "The bare word with a profile id and no --perps: usage, and nothing is read."), [])
  assert.deepEqual(await cliUsage("usage-cli-not-an-id", ["agent", "Not An Agent!", "--perps"], "A word that is neither a profile id nor a slug: usage, and nothing is read."), [])
  {
    const requests = await cliUsage("refused-cli-slug-unknown", ["agent", "nobody-here", "--perps"], "A slug no published agent has: the slug read finds nothing, the CLI says so and reads no summary.",
      { "/api/v1/agent/slug/nobody-here": { status: 200, body: { success: true, resolved: null } } }, 1)
    assert.deepEqual(requests.map((r) => r.path), ["/api/v1/agent/slug/nobody-here"])
  }
  {
    const requests: Request[] = []
    globalThis.fetch = serve({}, requests)
    const server = createCandleMcpServer({}, cfg)
    const client = new Client({ name: "harness-perps-summary-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b); await client.connect(a)
    try {
      const r: any = await client.callTool({ name: "candle_get_agent_perps_summary", arguments: { profileId: PROFILE, window: "90d" } })
      assert.equal(r.isError, true)
      assert.deepEqual(requests, [])
      rows.push({ id: "usage-mcp-window-unknown", scenario: "usage", surface: "mcp", args: { profileId: PROFILE, window: "90d" }, requests, says: "A window the tool does not take is refused by its own schema, and nothing is read.", outcome: { isError: true } })
    } finally { await client.close(); await server.close(); globalThis.fetch = deny }
  }

  // 10. The chart's All / Spot / Perps split, run as the pure function it is over a stand-in spot chart.
  {
    const spotPoint = (ts: number, realized: number, unrealized: number) => ({ ts, realizedNetUsd: realized, unrealizedUsd: unrealized, totalPnlUsd: realized + unrealized, partial: false })
    // The current point already holds the all window's perps net, as the composed board entry does.
    const current = (realized: number) => ({ ts: BUILD, realizedNetUsd: realized, unrealizedUsd: 0, totalPnlUsd: realized + published.windows.all.netUsd, partial: false })
    const charts = {
      "24h": { range: "24h", points: [spotPoint(t(39, 12), 10, 2), spotPoint(t(40, 4), 12, 0), spotPoint(t(40, 8), 15, 1), spotPoint(t(40, 12), 18, 0), current(20)] },
      all: { range: "all", points: [spotPoint(t(2, 0), 5, 0), spotPoint(t(4, 0), 8, 0), spotPoint(t(8, 0), 9, 1), current(20)] },
    }
    for (const [range, chart] of Object.entries(charts)) {
      const composed = composeChartAnswer(structuredClone(chart), published, BUILD) as { points: Record<string, number>[] } & Record<string, unknown>
      for (const p of composed.points) assert.ok(Math.abs(p.spotPnlUsd! + p.perpsPnlUsd! - p.totalPnlUsd!) < 1e-9, "spot + perps = all")
      rows.push({ id: `chart-split-${range}`, scenario: "chart-split", window: range, surface: "api-source",
        says: range === "all" ? "The all-range chart: each day adds the published perps point for that day (0 on a day before perps were published), and every point splits into spotPnlUsd and perpsPnlUsd, which sum to totalPnlUsd." : "The 24h chart: each hour adds the perps realized net through it and the unrealized its certified hour saw, split the same way; the current point's perps part is the all window's net.",
        evidence: "pure composeChartAnswer over a stand-in spot chart and the published bundle above; no agent surface reads the chart at this commit",
        outcome: { spotChart: chart, composed: { ...composed, points: composed.points.map((p) => ({ ...p, at: when(p.ts!) })) } } })
    }
    const spotOnly = { range: "7d", points: [spotPoint(t(35, 0), 1, 0)] }
    assert.equal(composeChartAnswer(spotOnly, null, BUILD), spotOnly)
    rows.push({ id: "chart-split-spot-only", scenario: "chart-split", window: "7d", surface: "api-source", says: "A spot-only agent's chart is returned as it was: no split fields.", evidence: "pure composeChartAnswer with no perps bundle", outcome: { spotChart: spotOnly, composed: "the same object, untouched" } })
    // Which agent surfaces read the chart: none of the CLI, the local MCP server, the SDK or the hosted server at this commit.
    const files = (dir: string): string[] => readdirSync(join(checkout, dir)).flatMap((f) => (statSync(join(checkout, dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []))
    const readers = [...files("packages/cli/src"), ...files("packages/mcp/src"), ...files("packages/sdk/src"), "apps/api/src/mcp/hosted.ts"].filter((f) => /\/records\/[^"'`]*\/chart|\/chart[?"'`]/.test(readFileSync(join(checkout, f), "utf8")))
    rows.push({ id: "chart-agent-surfaces", scenario: "chart-split", surface: "source-text", says: "No agent surface reads the chart at this commit, so the split series is the web's only: the CLI, the local and hosted MCP servers and the SDK carry no chart read.", evidence: "every non-test .ts file under packages/cli/src, packages/mcp/src, packages/sdk/src and apps/api/src/mcp/hosted.ts, searched for a /records/.../chart path", outcome: { chartReaders: readers } })
  }

  // 11. How the local server describes the tool, and the hosted server's public list without it.
  {
    const server = createCandleMcpServer({}, cfg)
    const client = new Client({ name: "harness-perps-summary-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    globalThis.fetch = serve({}, [])
    await server.connect(b); await client.connect(a)
    try {
      const { tools } = await client.listTools()
      const tool = tools.find((x: { name: string }) => x.name === "candle_get_agent_perps_summary")
      assert.ok(tool, "the local server lists the summary tool")
      rows.push({ id: "local-tool", scenario: "tools", surface: "mcp", says: "The local server's summary tool: keyless, read-only, window optional.", outcome: { name: tool!.name, title: tool!.title, description: tool!.description, inputSchema: tool!.inputSchema, annotations: tool!.annotations ?? null } })
    } finally { await client.close(); await server.close(); globalThis.fetch = deny }
    const hosted = createHostedMcpRoute(() => { throw new Error("tools/list reads nothing") })
    const res = await hosted.request("/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })
    const { result } = await res.json()
    const names = result.tools.map((x: { name: string }) => x.name)
    assert.ok(!names.includes("candle_get_agent_perps_summary"))
    rows.push({ id: "hosted-tools-list", scenario: "tools", surface: "mcp-hosted", says: "The hosted server's public tools, listed with no sign-in: the summary is not one of them at this commit (local only, like the perp round and market reads).", outcome: { tools: names } })
  }

  // 12. What the public docs say at this commit: the section's lines, each formula row; its three copies agree.
  {
    const section = (file: string) => {
      const text = readFileSync(join(checkout, file), "utf8").split("\n")
      const start = text.findIndex((l) => l.startsWith("### Public agent perps summary"))
      assert.ok(start >= 0, `${file}: the section`)
      const end = text.findIndex((l, i) => i > start && l.startsWith("### "))
      return text.slice(start, end).filter((l) => l.trim() !== "")
    }
    const copies = DOCS.map(section)
    assert.ok(copies.every((c) => JSON.stringify(c) === JSON.stringify(copies[0])), "the three copies of the page say the same")
    rows.push({ id: "docs-summary-section", scenario: "docs", surface: "docs", args: { files: DOCS }, says: "The public page's section: the read, every formula, the times, the chart split and the clients.", outcome: { lines: copies[0] } })
  }

  const text = JSON.stringify(rows)
  assert.ok(!text.includes(WALLET) && !/0x[0-9a-f]{40}(?![0-9a-f])/i.test(text), "no wallet address in a recording")
  assert.ok(!/"(address|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid|walletAddress)"/i.test(text), "no address, account value or order id in a recording")
  assert.ok(!text.includes(cfg.apiKey))
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-summary-source.json"), `${JSON.stringify({
    about: "Offline agent perps summary contracts from exact source (BE-3775). Every time is on forty-one made-up days, and every figure, coin and hash is made up. api-source rows are answers built by Candle's pure source (the perps profile bundle and hourly components, the board figures, the publish over a prior build with two daily points, perpsSummaryOf) from one made-up wallet's stored facts, in a stand-in route envelope (publishedBuildId, seq); each window's row also carries the series its max drawdown reads. The wallet's address is hashed inside that source and is in no row. api-stub rows are response stand-ins: no perps history, a slug answer, and refusals carrying the route's own code and words. mcp, sdk and cli rows read the same answers through the registered local tool, the SDK and `candle agent <id> --perps` over an intercepted fetch; a served answer is kept once, in its api row, and each of those rows names it (`relays`) with the SHA-256 of the canonical JSON of what that surface gave, which the recorder checked is the same answer. chart-split rows run the chart's split as the pure function it is over a stand-in spot chart. docs rows are the public page's own lines (its three copies agree), read as text. The database, the public gate, the perps jobs, the venue and the keyed API route are not executed, and no deployed behavior is claimed.",
    source, rules, profile: PROFILE, firstDay: new Date(DAY).toISOString().slice(0, 10), coverageFrom: when(COVERAGE_FROM), buildAt: when(BUILD), rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline agent perps summary contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch; Date.now = originalNow }
