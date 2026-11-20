// Offline agent record contracts from an exact clean Candle source checkout: a published agent's measured
// record with its Hyperliquid perps in it, as `candle agent record`, `candle_get_agent_record` (the local
// server and the hosted one) and the SDK's `getAgentRecord()` give it. Closed perp rounds sit among the spot
// swaps, newest first, each with its largest size, entry and exit averages, recorded leverage, return on
// initial margin, funding, fees and duration; the record's perps figures split the P&L into realized, funding,
// fees and unrealized; and a time says how fresh they are, also when they are too old to serve.
//
// Each answer is built by Candle's own pure source (`perpsProfileBundle`, `boardPerpsOf`, `publishBoardPerps`,
// `composeRecordAnswer`, `orderRounds`, `mergeRecordRows`, the union cursor, `composeTopCloses`, `roundRow`)
// from one made-up wallet's stored facts over three made-up days, then read through every agent surface. The
// spot half of each answer is a stand-in, as are the refusals, which carry the route's own codes and words.
// The wallet's address goes into that source only and never into the fixture. Every fetch is intercepted; no
// key, database, venue or keyed API route is used.
//   bun scripts/read-record-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { canonicalJson } from "../src/shared/canonical-json"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-record-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const API_SOURCES = [
  "apps/api/src/ledger/perps/profile.ts", "apps/api/src/ledger/views/board/perps.ts", "apps/api/src/ledger/views/board/round-prices.ts",
  "apps/api/src/ledger/views/board/record-rows.ts", "apps/api/src/ledger/views/board/record-rows-cursor.ts", "apps/api/src/mcp/hosted.ts", "apps/api/src/routes/agent.ts",
]
/** The web's own split of the headline figure, run here as the pure function it is. */
const WEB_SOURCE = "apps/frontend/src/components/agents/board/perps-record-data.ts"
/** The route answer Candle's own CLI, MCP and SDK tests share. */
const ROUTE_FIXTURE = "packages/shared/src/agent-record.fixture.json"
/** The public page that describes the record, and its two published copies. */
const DOCS = ["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"]
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", "packages/db", ROUTE_FIXTURE, WEB_SOURCE, ...API_SOURCES, ...DOCS)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const deny = (() => { throw new Error("record recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

const D = 86_400_000, H = 3_600_000, M = 60_000
/** Three made-up days; every time below is a day (0, 1 or 2), an hour and a minute of them, in UTC. */
const DAY = Date.UTC(2027, 0, 10)
const at = (day: number, h: number, m = 0) => DAY + day * D + h * H + m * M
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`
const PROFILE = "prof_0123456789abcdef"
/** Input to Candle's pure source only: it is hashed there, and no row below may carry it. */
const WALLET = `0x${"ab1e".repeat(10)}`
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const usd = (n: number) => BigInt(Math.round(n * 1_000_000))

type Position = Record<string, unknown>
type Fill = { coin: string; tid: string; hash: string; time: number; side: "A" | "B"; startPosition: string; sz: string; px?: string; closedPnlUsdMicros: bigint; feeUsdMicros: bigint; liquidated: boolean }
type Funding = { coin: string; time: number; usdcUsdMicros: bigint }
type Facts = {
  wallet: string
  ingest: { coverageFromMs: number; historyPartial: boolean; completeThroughMs: number | null }
  hours: { hourMs: number; cutoffMs: number | null; readOk: boolean; positions: Position[] | null }[]
  decisions: { hourMs: number; outcome: "certified" | "abandoned"; cutoffMs: number; fillsThroughMs: number | null; fundingThroughMs: number | null }[]
  fills: Fill[]; funding: Funding[]; gaps: never[]
  leverageOrders: { coin: string; atMs: number; leverage: number; isCross: boolean }[]
}
let tid = 1
/** One stored fill: `delta` is signed (a buy is positive), `closedPnl` and `fee` are the exchange's own figures. */
const fill = (coin: string, time: number, start: number, delta: number, px: number, closedPnl = 0, fee = 0, liquidated = false): Fill => ({
  coin, tid: String(tid++), hash: `0x${time.toString(16).padStart(64, "0")}`, time, side: delta > 0 ? "B" : "A",
  startPosition: String(start), sz: String(Math.abs(delta)), px: String(px), closedPnlUsdMicros: usd(closedPnl), feeUsdMicros: usd(fee), liquidated,
})
/** One open position as a certified hour saw it. `fundingSinceOpenUsd` is the engine's sign: positive is paid. */
const position = (coin: string, side: "long" | "short", size: number, entryPx: number, markPx: number, leverage: { value: number; type: string }): Position => {
  const unrealized = (side === "long" ? 1 : -1) * size * (markPx - entryPx)
  return {
    coin, side, size: String(size), entryPx: String(entryPx), markPx: String(markPx), unrealizedPnlUsd: String(unrealized),
    returnOnEquity: (unrealized / (size * entryPx / leverage.value)).toFixed(4), leverage, liquidationPx: null, liquidationDistance: null,
    fundingSinceOpenUsd: "0", marginUsedUsd: String(size * markPx / leverage.value), positionValueUsd: String(size * markPx), level: "ok",
  }
}

// The made-up wallet's stored history. Four closed rounds on the default dex, one on a builder dex, one position still open.
/** ETH long, 10x isolated set by a Candle leverage action five minutes before the open: 2 at 3000, 1 more at 3060, all 3 out at 3150. */
const ETH_ROUND = [fill("ETH", at(0, 9), 0, 2, 3000, 0, 1.8), fill("ETH", at(0, 9, 30), 2, 1, 3060, 0, 0.9), fill("ETH", at(0, 11), 3, -3, 3150, 390, 2.85)]
/** BTC short with no Candle leverage action: the 15:02 certified hour saw it at 5x cross. 0.1 at 95000, bought back at 96000, a loss. */
const BTC_ROUND = [fill("BTC", at(0, 14, 20), 0, -0.1, 95000, 0, 2.85), fill("BTC", at(0, 16, 40), -0.1, 0.1, 96000, -100, 2.88)]
/** SOL long opened and closed inside one hour, between two certified hours and with no leverage action: nothing recorded its leverage. */
const SOL_ROUND = [fill("SOL", at(1, 9, 10), 0, 50, 180, 0, 2.7), fill("SOL", at(1, 9, 40), 50, -50, 183, 150, 2.7)]
/** DOGE long, 20x cross by a leverage action, liquidated: 10000 at 0.40, closed by the exchange at 0.381. */
const DOGE_ROUND = [fill("DOGE", at(1, 12, 5), 0, 10000, 0.4, 0, 1.2), fill("DOGE", at(1, 13, 30), 10000, -10000, 0.381, -190, 1.14, true)]
/** A builder-dex round, the figures Candle's own tests use: 6 at 7687.5, out at 7969.95, 20x isolated. */
const DEX_ROUND = [fill("xyz:S&P500", at(1, 15), 0, 6, 7687.5, 0, 3.5), fill("xyz:S&P500", at(1, 16), 6, -6, 7969.95, 1694.7, 3.5)]
/** Still open at the last certified hour: 1 ETH long at 3200, 5x cross. */
const OPEN_FILL = fill("ETH", at(2, 8), 0, 1, 3200, 0, 0.96)
const FUNDING: Funding[] = [
  { coin: "ETH", time: at(0, 10), usdcUsdMicros: usd(-1.2) },
  { coin: "BTC", time: at(0, 15), usdcUsdMicros: usd(0.4) },
  { coin: "BTC", time: at(0, 16), usdcUsdMicros: usd(0.4) },
]
const LEVERAGE_ORDERS = [
  { coin: "ETH", atMs: at(0, 8, 55), leverage: 10, isCross: false },
  { coin: "DOGE", atMs: at(1, 12), leverage: 20, isCross: true },
  { coin: "xyz:S&P500", atMs: at(1, 14, 55), leverage: 20, isCross: false },
  { coin: "ETH", atMs: at(2, 7, 55), leverage: 5, isCross: true },
]
/** Stored coverage starts at the first made-up midnight. */
const COVERAGE_FROM = at(0, 0)
function certify(f: Facts, hourMs: number, positions: Position[]) {
  const cutoffMs = hourMs + 2 * M
  f.hours.push({ hourMs, cutoffMs, readOk: true, positions })
  f.decisions.push({ hourMs, outcome: "certified", cutoffMs, fillsThroughMs: cutoffMs, fundingThroughMs: cutoffMs })
  f.ingest.completeThroughMs = Math.max(f.ingest.completeThroughMs ?? 0, cutoffMs)
}
const empty = (): Facts => ({ wallet: WALLET, ingest: { coverageFromMs: COVERAGE_FROM, historyPartial: false, completeThroughMs: null }, hours: [], decisions: [], fills: [], funding: [], gaps: [], leverageOrders: [] })
/** Every hour certified two minutes past it, through day 2 09:00, each seeing what was open then. */
function history(): Facts {
  const f = empty()
  f.fills.push(...ETH_ROUND, ...BTC_ROUND, ...SOL_ROUND, ...DOGE_ROUND, ...DEX_ROUND, OPEN_FILL)
  f.funding.push(...FUNDING)
  f.leverageOrders.push(...LEVERAGE_ORDERS)
  for (let hourMs = at(0, 1); hourMs <= at(2, 9); hourMs += H) {
    const cutoff = hourMs + 2 * M
    const open: Position[] = []
    if (cutoff >= at(0, 9) && cutoff < at(0, 11)) open.push(position("ETH", "long", cutoff >= at(0, 9, 30) ? 3 : 2, cutoff >= at(0, 9, 30) ? 3020 : 3000, 3100, { value: 10, type: "isolated" }))
    if (cutoff >= at(0, 14, 20) && cutoff < at(0, 16, 40)) open.push(position("BTC", "short", 0.1, 95000, 95500, { value: 5, type: "cross" }))
    if (cutoff >= at(1, 12, 5) && cutoff < at(1, 13, 30)) open.push(position("DOGE", "long", 10000, 0.4, 0.39, { value: 20, type: "cross" }))
    if (cutoff >= at(2, 8)) open.push(position("ETH", "long", 1, 3200, 3230, { value: 5, type: "cross" }))
    certify(f, hourMs, open)
  }
  return f
}
/** A wallet with fills and no certified hour yet. */
function uncertified(): Facts {
  const f = empty()
  f.fills.push(...SOL_ROUND)
  return f
}
/** The stored facts an older API wrote: no fill prices and no leverage actions. */
function olderFacts(): Facts {
  const f = history()
  f.fills = f.fills.map(({ px: _px, ...rest }) => rest)
  f.leverageOrders = []
  return f
}

// The spot half: a stand-in for the stored record, made-up tokens and figures. Six swaps, newest first.
const MINT = { FAKE: "MintFake11111111111111111111111111111111111", MOON: "MoonFake11111111111111111111111111111111111" }
const swap = (n: number, timestampMs: number, side: "buy" | "sell", symbol: keyof typeof MINT, usdAmount: number, realizedNetUsd?: number) => ({
  signature: `SigFake${String(n).padStart(2, "0")}${"1".repeat(40)}`, side, mint: MINT[symbol], chain: "solana", symbol, timestampMs, counted: realizedNetUsd !== undefined,
  usdAmount, ...(realizedNetUsd === undefined ? {} : { realizedNetUsd }),
})
const SWAPS = [
  swap(6, at(2, 7), "buy", "MOON", 120),
  swap(5, at(1, 10), "sell", "FAKE", 260, 60),
  swap(4, at(0, 16, 40), "sell", "MOON", 90, -10),
  swap(3, at(0, 12), "buy", "MOON", 100),
  swap(2, at(0, 8), "buy", "FAKE", 200),
  swap(1, at(-1, 20), "buy", "FAKE", 50),
]
/** The spot record as stored: two closes (+$60, −$10), $40 of open spot gain, $12.5 of valued creator fees. */
const spotRecord = (rows = SWAPS) => ({
  profileId: PROFILE, name: "Record fixture", wallet: "fixture-public-owner",
  totals: { realizedNetUsd: 50, feesUsd: 1.5, wins: 1, losses: 1, counted: 2, unvalued: 0, bestUsd: 60, worstUsd: -10, unrealizedUsd: 40, totalPnlUsd: 102.5, creatorFeesUsd: 12.5 },
  winRatePct: null, minClosesForRate: 10, unrealizedUsd: 40, totalPnlUsd: 102.5, creatorFeesUsd: 12.5,
  rows, rowsCursor: null as string | null, rowsTotal: rows.length, scannedTrades: rows.length, truncated: false,
})
const noSpotRecord = () => ({
  ...spotRecord([]), totals: { realizedNetUsd: 0, feesUsd: 0, wins: 0, losses: 0, counted: 0, unvalued: 0, unrealizedUsd: 0, totalPnlUsd: 0, creatorFeesUsd: 0 },
  unrealizedUsd: 0, totalPnlUsd: 0, creatorFeesUsd: 0,
})

type Scenario = {
  id: string; says: string; buildAtMs: number; prior?: string | null; facts: (() => Facts) | null
  /** The spot swaps the stored record holds; `chunk` is how many of the newest ones the first page's stored chunk carries. */
  spot?: "none" | "all"; chunk?: number
}
// Each build is published over the one before it, as the board does, unless `prior` names another (null: none before it).
const scenarios: Scenario[] = [
  { id: "record", says: "Day 2 09:10, the 09:02 hour certified: four closed rounds among six swaps, newest first, one position still open, and the perps figures all present.", buildAtMs: at(2, 9, 10), prior: null, facts: history },
  { id: "record-paged", says: "The same build with the stored swaps in two chunks, three swaps each here where the store keeps 500: the first page ends where its chunk ends and gives a cursor; the second page, read with it, holds the rest.", buildAtMs: at(2, 9, 10), prior: null, facts: history, chunk: 3 },
  { id: "perps-only", says: "The same build for an agent with no spot swap: every row is a round, and the perps figures are the whole P&L.", buildAtMs: at(2, 9, 10), prior: null, facts: history, spot: "none" },
  { id: "older-facts", says: "The same build from facts stored before fill prices and leverage actions were kept: sizes and averages are unknown, leverage is what a certified hour saw or nothing, and no return is made up.", buildAtMs: at(2, 9, 10), prior: null, facts: olderFacts },
  { id: "delayed", says: "Day 2 11:45, certification still at 09:02: 2 h 43 min old is past the 2-hour line, so the same figures are served partial.", buildAtMs: at(2, 11, 45), prior: "record", facts: history },
  { id: "unavailable", says: "Day 2 12:20, still 09:02: over 3 hours old, so the perps are unavailable. The record says so, gives the last certified time, and lists the swaps alone.", buildAtMs: at(2, 12, 20), prior: "delayed", facts: history },
  { id: "never-certified", says: "A wallet with fills and no certified hour yet: unavailable, with no perps time at all.", buildAtMs: at(1, 10), prior: null, facts: uncertified },
  { id: "no-perps", says: "An agent with no perps wallet: the swaps alone, each marked a trade, no perps figure and no perps time.", buildAtMs: at(2, 9, 10), prior: null, facts: null },
]

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []
try {
  const { perpsProfileBundle, perpsProfileHourly, floorPerpsHour, PERPS_WINDOW_MS, PERPS_STALE_MS, PERPS_UNAVAILABLE_MS } = await load("apps/api/src/ledger/perps/profile.ts")
  const { boardPerpsOf, publishBoardPerps, composeRecordAnswer, composeTopCloses, roundRow, PERP_ROUND_ROWS_MAX, PERP_TOP_CLOSES } = await load("apps/api/src/ledger/views/board/perps.ts")
  const { orderRounds, mergeRecordRows, perpsRowsPin } = await load("apps/api/src/ledger/views/board/record-rows.ts")
  const { formatUnionCursor, parseUnionCursor, isUnionCursor, RECORD_PAGE_ROWS, UNION_ROWS } = await load("apps/api/src/ledger/views/board/record-rows-cursor.ts")
  const { recordRowsVersion } = await load("packages/db/board.ts")
  const { recordBreakdown } = await load(WEB_SOURCE)
  const { createHostedMcpRoute, HOSTED_TOOL_NAMES, UNTRUSTED_PREAMBLE } = await load("apps/api/src/mcp/hosted.ts")
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { CandleApiError } = await load("packages/sdk/src/errors.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const rules = { staleMs: PERPS_STALE_MS, unavailableMs: PERPS_UNAVAILABLE_MS, pageRows: RECORD_PAGE_ROWS, roundRowsMax: PERP_ROUND_ROWS_MAX, topCloses: PERP_TOP_CLOSES, unionRows: UNION_ROWS }
  assert.deepEqual(rules, { staleMs: 2 * H, unavailableMs: 3 * H, pageRows: 500, roundRowsMax: 200, topCloses: 5, unionRows: "all" })
  assert.ok(HOSTED_TOOL_NAMES.includes("candle_get_agent_record"), "the hosted server lists the record tool")

  const RECORD_PATH = `/api/v1/agent/records/${PROFILE}`
  const firstPage = `${RECORD_PATH}?rows=all`
  const pageAt = (cursor: string) => `${firstPage}&cursor=${encodeURIComponent(cursor)}`
  type Answer = { status: number; body: unknown }
  /** A stand-in for the API: each path answers what the table says, and every request is noted. */
  const serve = (table: Record<string, Answer>, requests: Request[], origin = cfg.apiUrl) => (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const request = input instanceof globalThis.Request ? input : null
    const url = String(request ? request.url : input)
    assert.ok(url.startsWith(`${origin}/`), `unexpected host: ${url}`)
    const path = url.slice(origin.length)
    const headers = new Headers(request ? request.headers : init?.headers)
    const method = request ? request.method : (init?.method ?? "GET")
    requests.push({ method, path, credential: headers.has("authorization") || headers.has("x-api-key") })
    assert.equal(method, "GET")
    const answer = table[path]
    if (!answer) throw new Error(`unexpected local request: ${path}`)
    return Response.json(answer.body, { status: answer.status })
  }) as unknown as typeof fetch

  /** What a surface gave, kept once: a served answer is in its api row, and each surface names it with the hash of what it got. */
  const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
  /**
   * One read of the record through each agent surface. Every surface must give the route's answer: `relays` names
   * where that answer is kept (an api row, or its second page).
   */
  async function surfaces(base: { scenario: string; buildAt?: string }, suffix: string, table: Record<string, Answer>, relays: string, cursor?: string) {
    const path = cursor === undefined ? firstPage : pageAt(cursor)
    const answer = table[path]!
    const ok = answer.status === 200
    /** A served answer as the row keeps it; a refusal is small, and kept whole. */
    const kept = (body: unknown) => (ok ? { relays, sha256: sha256(body) } : { body })
    const args = { profileId: PROFILE, ...(cursor === undefined ? {} : { cursor }) }
    const one = [{ method: "GET", path, credential: false }]
    {
      const requests: Request[] = []
      globalThis.fetch = serve(table, requests)
      const server = createCandleMcpServer({}, cfg)
      const client = new Client({ name: "harness-record-recorder", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(b); await client.connect(a)
      try {
        const r: any = await client.callTool({ name: "candle_get_agent_record", arguments: args })
        const outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
        // The tool relays the route's answer whole, a refusal as an error, and sends no credential though one is configured.
        assert.deepEqual(outcome, { body: answer.body, isError: !ok }, `${base.scenario}${suffix} mcp`)
        assert.deepEqual(requests, one)
        rows.push({ id: `${base.scenario}${suffix}-mcp`, ...base, surface: "mcp", args, requests, outcome: { ...kept(outcome.body), isError: outcome.isError } })
      } finally { await client.close(); await server.close(); globalThis.fetch = deny }
    }
    {
      const requests: Request[] = []
      // The hosted server calls the API it runs inside, by its own internal origin.
      const dispatch = serve(table, requests, "http://candle-mcp.internal")
      const route = createHostedMcpRoute((req: globalThis.Request) => dispatch(req))
      const res = await route.request("/", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "candle_get_agent_record", arguments: args } }),
      })
      const { result } = await res.json()
      const text = result.content[0].text as string
      const preamble = text.startsWith(UNTRUSTED_PREAMBLE)
      const outcome = { preamble, body: JSON.parse(preamble ? text.slice(UNTRUSTED_PREAMBLE.length) : text), isError: result.isError === true }
      // The hosted server reads the same route with no caller credential, and marks what it relays as untrusted data.
      assert.deepEqual(outcome, { preamble: true, body: answer.body, isError: !ok }, `${base.scenario}${suffix} hosted`)
      assert.deepEqual(requests, one)
      rows.push({ id: `${base.scenario}${suffix}-mcp-hosted`, ...base, surface: "mcp-hosted", args, requests, outcome: { preamble, ...kept(outcome.body), isError: outcome.isError } })
    }
    {
      const requests: Request[] = []
      const client = new CandleClient({ ...cfg, fetch: serve(table, requests), maxRetries: 0 })
      let outcome: Record<string, unknown>
      try {
        const body = await client.getAgentRecord(PROFILE, cursor === undefined ? {} : { cursor })
        assert.ok(ok, `${base.scenario}${suffix} sdk answered a refusal`)
        assert.deepEqual(body, (answer.body as { record: unknown }).record, `${base.scenario}${suffix} sdk`)
        // The SDK gives the record itself, without the envelope.
        outcome = { relays, part: "record", sha256: sha256(body), isError: false }
      } catch (err) {
        if (ok || !(err instanceof CandleApiError)) throw err
        outcome = { isError: true, error: { status: (err as { status: number }).status, code: (err as { code: string }).code, message: (err as Error).message } }
      }
      assert.deepEqual(requests, one, `${base.scenario}${suffix} sdk sent no credential`)
      rows.push({ id: `${base.scenario}${suffix}-sdk`, ...base, surface: "sdk", args, requests, outcome })
    }
    for (const json of [false, true]) {
      const requests: Request[] = []
      const stdout = createCapture(), stderr = createCapture()
      const deps = createTestDeps({ stdout, stderr, env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_API_URL: cfg.apiUrl }, fetch: serve(table, requests) })
      const argv = ["agent", "record", PROFILE, ...(cursor === undefined ? [] : ["--cursor", cursor]), ...(json ? ["--json"] : [])]
      const exitCode = await cli.run(argv, deps)
      assert.equal(exitCode, ok ? 0 : 1, `${base.scenario}${suffix} cli ${stdout.text}${stderr.text}`)
      // A public read: no key is sent though one is in the environment.
      assert.deepEqual(requests, one)
      const lines = (text: string) => text.trimEnd().split("\n").filter((line, i, all) => line !== "" || all.length > 1)
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

  const periods = [{ walletAddress: WALLET, profileId: PROFILE, fromMs: at(-1, 0), toMs: null, servable: true }]
  const published = new Map<string, unknown>()
  for (const [n, s] of scenarios.entries()) {
    const B = s.buildAtMs
    // The board's own steps for one profile (computeBoardPerps, then the publish over the prior build).
    let perps: any = null
    let read: Record<string, unknown> = { kind: "none" }
    let facts: Facts | null = null
    if (s.facts) {
      facts = s.facts()
      const input = { profileId: PROFILE, periods, wallets: [facts] }
      const bundle = perpsProfileBundle({ ...input, buildAtMs: B })
      const toHourMs = floorPerpsHour(B)
      const hourly = bundle.available ? perpsProfileHourly({ ...input, fromHourMs: toHourMs - PERPS_WINDOW_MS["30d"], toHourMs }) : []
      const prior = s.prior ? published.get(s.prior) : null
      assert.notEqual(prior, undefined, `${s.id}: prior build ${s.prior}`)
      perps = publishBoardPerps(boardPerpsOf(bundle, hourly, [facts]), prior, B)
      read = { kind: !bundle.available ? "unavailable" : perps.partial ? "delayed" : "certified", ...(bundle.available ? {} : { reason: bundle.reason }), retained: perps.retained === true }
    }
    published.set(s.id, perps)
    // The stored spot record, then the record answer and the union of its rows, as the board read composes them.
    const stored = s.spot === "none" ? noSpotRecord() : spotRecord()
    const manifest = stored.rows.length === 0 ? [] : s.chunk
      ? [{ kind: "rows", sequence: 0, count: stored.rows.length - s.chunk }, { kind: "rows", sequence: 1, count: s.chunk }]
      : [{ kind: "rows", sequence: 0, count: stored.rows.length }]
    const spotVersion = recordRowsVersion(manifest)
    const rounds = perps?.available ? orderRounds(perps.rounds) : []
    const perpsPin = perpsRowsPin(perps, rounds)
    const composed = composeRecordAnswer({ success: true, record: stored }, perps) as { success: true; record: Record<string, unknown> }
    const page = (spot: unknown[], spotRemaining: number, roundsServed: number) => {
      const merged = mergeRecordRows({ spot, spotRemaining, rounds, roundsServed })
      const done = merged.spotRemaining === 0 && merged.roundsServed === rounds.length
      return {
        merged,
        answer: { success: true, seq: 40 + n, record: { ...composed.record, publishedBuildId: `build_fixture_${String(n + 1).padStart(2, "0")}`, rows: merged.rows, rowsTotal: stored.rows.length + rounds.length,
          rowsCursor: done ? null : formatUnionCursor({ spotVersion, spotRemaining: merged.spotRemaining, perpsPin, roundsServed: merged.roundsServed }) } },
      }
    }
    const first = page(s.chunk ? stored.rows.slice(0, s.chunk) : stored.rows, stored.rows.length, 0)
    const record = first.answer.record as Record<string, any>
    const base = { scenario: s.id, buildAt: when(B) }
    const outcome: Record<string, unknown> = { read, record: first.answer }
    const table: Record<string, Answer> = { [firstPage]: { status: 200, body: first.answer } }
    let second: ReturnType<typeof page> | null = null
    if (s.chunk) {
      const cursor = record.rowsCursor as string
      assert.ok(isUnionCursor(cursor) && parseUnionCursor(cursor), `${s.id}: a union cursor`)
      second = page(stored.rows.slice(s.chunk), first.merged.spotRemaining, first.merged.roundsServed)
      assert.equal(second.answer.record.rowsCursor, null)
      // Both pages together are one merge of the two whole lists.
      assert.deepEqual([...first.merged.rows, ...second.merged.rows], mergeRecordRows({ spot: stored.rows, spotRemaining: stored.rows.length, rounds, roundsServed: 0 }).rows)
      table[pageAt(cursor)] = { status: 200, body: second.answer }
      outcome.nextPage = second.answer
    }
    if (perps?.available) {
      // The server's all-time best closes: the stored spot closes and the best rounds, by dollars then newer first.
      const spotTop = (stored.rows as { realizedNetUsd?: number; timestampMs: number }[]).filter((r) => r.realizedNetUsd !== undefined).sort((a, b) => b.realizedNetUsd! - a.realizedNetUsd! || b.timestampMs - a.timestampMs).slice(0, PERP_TOP_CLOSES)
      outcome.topCloses = composeTopCloses({ topCloses: spotTop as never, asOfMs: B - 2 * M }, perps)
    }
    // The web's split of the headline figure, from the same answer: perps realized, funding, fees and unrealized, creator fees, and spot as what is left.
    const figures = (r: Record<string, any>) => Object.fromEntries(["perpsRealizedUsd", "perpsFundingUsd", "perpsFeesUsd", "perpsUnrealizedUsd", "perpsNetUsd"].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
    outcome.breakdown = { total: record.totalPnlUsd, creatorFeesUsd: record.creatorFeesUsd, figures: figures(record), parts: recordBreakdown(record.totalPnlUsd, record.creatorFeesUsd, record) }
    if (s.id === "record") {
      // A record whose creator fees are not valued, and one missing one perps component: spot cannot be told by subtraction.
      const { perpsFundingUsd: _funding, ...withoutFunding } = record
      outcome.breakdownMissing = {
        creatorFees: recordBreakdown(record.totalPnlUsd, undefined, record),
        funding: recordBreakdown(record.totalPnlUsd, record.creatorFeesUsd, withoutFunding),
      }
    }
    rows.push({ id: `${s.id}-api`, ...base, surface: "api-source", says: s.says,
      evidence: "pure API source on made-up stored facts, over a stand-in spot record, build id and push cursor; the database, the perps jobs and the keyed route are not executed",
      outcome })
    await surfaces(base, "", table, `${s.id}-api`)
    if (second) await surfaces(base, "-page-2", table, `${s.id}-api nextPage`, record.rowsCursor)
  }

  // One round row, built by the source's own `roundRow` from a builder-dex round's facts: the full `dex:COIN` name stays.
  {
    const facts = history()
    const [open, close] = DEX_ROUND as [Fill, Fill]
    const round = { wallet: WALLET, coin: open.coin, side: "long", openedMs: open.time, closedMs: close.time, closeHash: close.hash, closedPnlUsdMicros: close.closedPnlUsdMicros,
      feesUsdMicros: open.feeUsdMicros + close.feeUsdMicros, fundingUsdMicros: usd(2), pnlUsdMicros: close.closedPnlUsdMicros - open.feeUsdMicros - close.feeUsdMicros + usd(2), liquidated: false, complete: true, ownerProfileId: PROFILE }
    rows.push({ id: "builder-dex-round-row", scenario: "builder-dex", surface: "api-source",
      says: "A builder-dex round as the source's round row gives it: the dex:COIN name whole, 20x isolated from the leverage action, and the return on the initial margin at the largest size.",
      evidence: "the source's roundRow on made-up facts; the record built above does not count builder-dex rounds at this commit", outcome: { row: roundRow(round, facts) } })
  }
  // Candle's own shared route answer, a builder-dex round in it, through every surface.
  {
    const body = JSON.parse(readFileSync(join(checkout, ROUTE_FIXTURE), "utf8"))
    assert.equal(body.record.profileId, PROFILE)
    rows.push({ id: "route-fixture-api", scenario: "route-fixture", surface: "api-source", evidence: `${ROUTE_FIXTURE}, the route answer Candle's CLI, MCP and SDK tests share, read as it is`, says: "A record whose one row is a builder-dex round.", outcome: { record: body } })
    await surfaces({ scenario: "route-fixture" }, "", { [firstPage]: { status: 200, body } }, "route-fixture-api")
  }
  // An older published bundle: the round rows of the first scenario without the fields added since.
  {
    const healthy = rows.find((r) => r.id === "record-api")!.outcome.record as { record: Record<string, any> }
    const ADDED = ["size", "entryPx", "exitPx", "initialMarginUsd", "returnPct", "fundingUsd", "feesUsd", "durationMs", "leverageSource"]
    const strip = (row: Record<string, unknown>) => row.kind === "perp_round" ? Object.fromEntries(Object.entries(row).filter(([k]) => !ADDED.includes(k))) : row
    const { perpsCoverageFromMs: _coverage, ...record } = healthy.record
    const body = { ...healthy, record: { ...record, rows: record.rows.map(strip), perpRounds: record.perpRounds.map(strip), perpsTopCloses: record.perpsTopCloses.map(strip), totals: Object.fromEntries(Object.entries(record.totals).filter(([k]) => k !== "perpsCoverageFromMs")) } }
    rows.push({ id: "older-bundle-api", scenario: "older-bundle", surface: "api-stub", evidence: "a response stand-in: the first scenario's answer without the fields this source adds, as a bundle published before it carries them", says: "Rounds published before the added fields: each is still a round, and what is missing is unknown, never zero.", outcome: { removed: [...ADDED, "perpsCoverageFromMs"], record: body } })
    await surfaces({ scenario: "older-bundle" }, "", { [firstPage]: { status: 200, body } }, "older-bundle-api")
  }
  // Refusals, as stand-ins carrying the route's own status, code and words (pinned below as source text).
  const route = readFileSync(join(checkout, "apps/api/src/routes/agent.ts"), "utf8")
  const EXPIRED = "u1:" + "0".repeat(64) + ":3:" + "0".repeat(32) + ":2"
  assert.ok(parseUnionCursor(EXPIRED), "a well-formed union cursor")
  const refusals: Array<{ id: string; says: string; status: number; code: string; message: string; details?: Record<string, unknown>; cursor?: string }> = [
    { id: "refused-not-published", says: "A private, hidden, revoked or unknown agent: one answer for all of them, so the read cannot tell which ids exist.", status: 404, code: "RECORD_NOT_FOUND", message: "No published record for this agent" },
    { id: "refused-cursor-expired", says: "A cursor from a record that has changed since: start paging again.", status: 400, code: "VALIDATION_FAILED", message: "Record changed; restart paging", details: { field: "cursor" }, cursor: EXPIRED },
  ]
  for (const r of refusals) {
    assert.ok(route.includes(`errorBody("${r.code}", "${r.message}"`), `the route no longer says: ${r.message}`)
    const body = { success: false, error: { code: r.code, message: r.message, ...(r.details ? { details: r.details } : {}) } }
    rows.push({ id: `${r.id}-api`, scenario: r.id, surface: "api-stub", evidence: "a response stand-in carrying the route's own status, code and message, which the recorder checks are in the route's source", says: r.says, outcome: { status: r.status, body } })
    await surfaces({ scenario: r.id }, "", { [r.cursor === undefined ? firstPage : pageAt(r.cursor)]: { status: r.status, body } }, `${r.id}-api`, r.cursor)
  }
  // What never leaves the machine: an id that is not a profile id, and a cursor that is not text.
  {
    const requests: Request[] = []
    const stdout = createCapture(), stderr = createCapture()
    const deps = createTestDeps({ stdout, stderr, env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_API_URL: cfg.apiUrl }, fetch: serve({}, requests) })
    const exitCode = await cli.run(["agent", "record", "momentum"], deps)
    assert.equal(exitCode, 2)
    assert.deepEqual(requests, [])
    rows.push({ id: "usage-cli-not-a-profile-id", scenario: "usage", surface: "cli", args: { command: "candle agent record momentum" }, requests, says: "The command takes a profile id (prof_ and 16 hex), not a slug: usage, and nothing is read.",
      outcome: { exitCode, stdout: stdout.text.trimEnd().split("\n").filter(Boolean), stderr: stderr.text.trimEnd().split("\n").filter(Boolean) } })
  }
  {
    const requests: Request[] = []
    globalThis.fetch = serve({}, requests)
    const server = createCandleMcpServer({}, cfg)
    const client = new Client({ name: "harness-record-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b); await client.connect(a)
    try {
      const r: any = await client.callTool({ name: "candle_get_agent_record", arguments: { profileId: PROFILE, cursor: 123 } })
      assert.equal(r.isError, true)
      assert.deepEqual(requests, [])
      rows.push({ id: "usage-mcp-cursor-not-text", scenario: "usage", surface: "mcp", args: { profileId: PROFILE, cursor: 123 }, requests, says: "A cursor that is not text is refused by the tool's own schema, and nothing is read.", outcome: { isError: true } })
    } finally { await client.close(); await server.close(); globalThis.fetch = deny }
  }

  // What the hosted server lists with no sign-in, and how it describes the record tool.
  {
    const route = createHostedMcpRoute(() => { throw new Error("tools/list reads nothing") })
    const res = await route.request("/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })
    const { result } = await res.json()
    const tool = result.tools.find((t: { name: string }) => t.name === "candle_get_agent_record")
    assert.ok(tool, "the hosted server lists the record tool with no sign-in")
    rows.push({ id: "hosted-tools-list", scenario: "hosted", surface: "mcp-hosted", says: "The hosted server's public tools, listed with no sign-in: the record read is one of them.",
      outcome: { tools: result.tools.map((t: { name: string }) => t.name), record: { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations } } })
  }

  // What the public docs say at this commit. Public text, read as text.
  const paragraph = (file: string, starts: string) => {
    const found = readFileSync(join(checkout, file), "utf8").split("\n").filter((line) => line.startsWith(starts))
    assert.equal(found.length, 1, `${file}: one line starting ${starts}`)
    return found[0]!
  }
  for (const [id, starts] of [["docs-record-read", "`candle agent record <profile-id>"], ["docs-round-row", "A `kind: \"perp_round\"` row"], ["docs-perps-times", "`perpsAsOfMs` stamps every perps figure"]] as const) {
    const copies = DOCS.map((file) => paragraph(file, starts))
    assert.ok(copies.every((line) => line === copies[0]), `the three copies of the page say the same: ${id}`)
    rows.push({ id, scenario: "docs", surface: "docs", args: { files: DOCS }, outcome: { text: copies[0] } })
  }

  const text = JSON.stringify(rows)
  assert.ok(!text.includes(WALLET) && !/0x[0-9a-f]{40}(?![0-9a-f])/i.test(text), "no wallet address in a recording")
  assert.ok(!/"(address|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid|walletAddress)"/i.test(text), "no address, account value or order id in a recording")
  assert.ok(!text.includes(cfg.apiKey))
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-record-source.json"), `${JSON.stringify({
    about: "Offline agent record contracts from exact source. Every time is on three made-up days, and every figure, token and hash is made up. api-source rows are answers built by Candle's pure source (the perps profile bundle, the board publish, the record composition, the round rows and the union of swaps and rounds with its cursor) from one made-up wallet's stored facts, over a stand-in spot record; each also carries the server's best closes and the web's own split of the headline figure, run as the pure function it is. The wallet's address is hashed inside that source and is in no row. api-stub rows are response stand-ins: an older bundle's rows, and refusals carrying the route's own code and words. mcp, mcp-hosted, sdk and cli rows read the same answers through the registered tool, the hosted server's route, the SDK and `candle agent record` over an intercepted fetch; a served answer is kept once, in its api row, and each of those rows names it (`relays`) with the SHA-256 of the canonical JSON of what that surface gave, which the recorder checked is the same answer. docs rows are the public page's own paragraphs (its three copies agree), read as text. The database, the perps jobs, the venue and the keyed API route are not executed, and no deployed behavior is claimed.",
    source, rules, profile: PROFILE, firstDay: new Date(DAY).toISOString().slice(0, 10), coverageFrom: when(COVERAGE_FROM), rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline agent record contracts (${scenarios.length} builds) from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch }
