// Offline perps freshness contracts from an exact clean Candle source checkout: how fresh an agent's public
// Hyperliquid figures are, as `candle agent positions`, `candle_get_agent_positions` and the SDK's
// `getAgentPositions()` say it. Between certified hours Candle reads each wallet again every board build
// (about 10 minutes) and marks the figures provisional; the hourly certified snapshot stays underneath and
// replaces them when it certifies the hour.
//
// Each answer is built by Candle's own pure source (`perpsProfileBundle`, `boardPerpsOf`, `publishBoardPerps`,
// `composePositions`, `composeRecordAnswer`) from one made-up wallet's stored facts on a made-up day, then read
// through the registered MCP tool, the SDK and the CLI. The wallet's address goes into that source only and
// never into the fixture. Every fetch is intercepted; no key, database, venue or keyed API route is used.
//   bun scripts/read-freshness-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-freshness-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const API_SOURCES = ["apps/api/src/ledger/perps/profile.ts", "apps/api/src/ledger/views/board/perps.ts", "apps/api/src/ledger/views/board/positions.ts"]
/** The public page that says how fresh the figures are, and its two published copies. */
const DOCS = ["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"]
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", ...API_SOURCES, ...DOCS)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const deny = (() => { throw new Error("freshness recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

const H = 3_600_000, M = 60_000
/** A made-up day; every time below is an hour and minute of it, in UTC. */
const DAY = Date.UTC(2027, 0, 12)
const at = (h: number, m = 0) => DAY + h * H + m * M
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const PROFILE = "prof_0123456789abcdef"
/** Input to Candle's pure source only: it is hashed there, and no row below may carry it. */
const WALLET = `0x${"a".repeat(40)}`
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const usd = (n: number) => BigInt(Math.round(n * 1_000_000))

type Position = Record<string, unknown>
type Fill = { coin: string; tid: string; hash: string; time: number; side: "A" | "B"; startPosition: string; sz: string; closedPnlUsdMicros: bigint; feeUsdMicros: bigint; liquidated: boolean }
type Funding = { coin: string; time: number; usdcUsdMicros: bigint }
type Facts = {
  wallet: string
  ingest: { coverageFromMs: number; historyPartial: boolean; completeThroughMs: number | null }
  hours: { hourMs: number; cutoffMs: number | null; readOk: boolean; positions: Position[] | null }[]
  decisions: { hourMs: number; outcome: "certified" | "abandoned"; cutoffMs: number; fillsThroughMs: number | null; fundingThroughMs: number | null }[]
  fills: Fill[]; funding: Funding[]; gaps: never[]
  provisional?: { baseCutoffMs: number; stateMs: number; readAtMs: number; positions: Position[]; fills: Fill[]; funding: Funding[] } | null
}
let tid = 1
const fill = (time: number, start: number, delta: number, closedPnl = 0, fee = 0): Fill => ({
  coin: "ETH", tid: String(tid++), hash: `0x${time.toString(16).padStart(64, "0")}`, time, side: delta > 0 ? "B" : "A",
  startPosition: String(start), sz: String(Math.abs(delta)), closedPnlUsdMicros: usd(closedPnl), feeUsdMicros: usd(fee), liquidated: false,
})
/** A long ETH position entered at 100, 5x cross. `fundingSinceOpenUsd` is the engine's sign: positive is paid. */
const eth = (size: number, markPx: number, fundingPaid = "0"): Position => ({
  coin: "ETH", side: "long", size: String(size), entryPx: "100", markPx: String(markPx), unrealizedPnlUsd: String(size * (markPx - 100)),
  returnOnEquity: ((markPx - 100) / 100 * 5).toFixed(2), leverage: { value: 5, type: "cross" }, liquidationPx: "82", liquidationDistance: Number(((markPx - 82) / markPx).toFixed(4)),
  fundingSinceOpenUsd: fundingPaid, marginUsedUsd: String(size * markPx / 5), positionValueUsd: String(size * markPx), level: "ok",
})
const OPEN = fill(at(9, 30), 0, 1, 0, 0.05)
/** Half the position closed at 10:15, between two certified hours: +$6, less a $0.03 fee. */
const CLOSE = fill(at(10, 15), 1, -0.5, 6, 0.03)
const wallet = (): Facts => ({ wallet: WALLET, ingest: { coverageFromMs: 0, historyPartial: false, completeThroughMs: null }, hours: [], decisions: [], fills: [OPEN], funding: [], gaps: [] })
function certify(f: Facts, hourMs: number, cutoffMs: number, positions: Position[]) {
  f.hours.push({ hourMs, cutoffMs, readOk: true, positions })
  f.decisions.push({ hourMs, outcome: "certified", cutoffMs, fillsThroughMs: cutoffMs, fundingThroughMs: cutoffMs })
  f.ingest.completeThroughMs = Math.max(f.ingest.completeThroughMs ?? 0, cutoffMs)
}
/** The 10:00 hour certified at 10:02: one ETH long, opened at 09:30. */
function hour10(): Facts {
  const f = wallet()
  certify(f, at(10), at(10, 2), [eth(1, 110)])
  return f
}
/** The 11:00 hour certified at 11:02 as well: the 10:15 close is now a stored, certified fact. */
function hour11(): Facts {
  const f = hour10()
  f.fills.push(CLOSE)
  certify(f, at(11), at(11, 2), [eth(0.5, 111)])
  return f
}
/** A provisional read on top of a certified cutoff: account state at `stateMs`, and the fills and funding since the cutoff. */
const provisional = (baseCutoffMs: number, stateMs: number, positions: Position[], fills: Fill[] = [], funding: Funding[] = []) =>
  ({ baseCutoffMs, stateMs, readAtMs: stateMs + 20_000, positions, fills, funding })
const HOURLY_FUNDING: Funding[] = [12, 13, 14].map((h) => ({ coin: "ETH", time: at(h), usdcUsdMicros: usd(-0.02) }))

type Scenario = { id: string; says: string; buildAtMs: number; prior?: string | null; facts: (() => Facts) | null }
// One day, in order. Each build is published over the one before it, as the board does, unless `prior` names another
// (null: no build before it).
const scenarios: Scenario[] = [
  { id: "certified", says: "10:10, no provisional read yet: the 10:02 certified figures, with no provisional mark.", buildAtMs: at(10, 10), prior: null, facts: hour10 },
  { id: "provisional", says: "10:24, a provisional read at 10:22 on the 10:02 cutoff: its time, marked provisional, with the certified cutoff under it; the 10:15 close is already in the figures.", buildAtMs: at(10, 24),
    facts: () => ({ ...hour10(), provisional: provisional(at(10, 2), at(10, 22), [eth(0.5, 112)], [CLOSE]) }) },
  { id: "provisional-next-build", says: "10:34, the next board build: the provisional time moved 10 minutes on, the certified cutoff did not.", buildAtMs: at(10, 34),
    facts: () => ({ ...hour10(), provisional: provisional(at(10, 2), at(10, 32), [eth(0.5, 113)], [CLOSE]) }) },
  { id: "provisional-one-missed-refresh", says: "10:44, the read was not refreshed: 12 minutes old is still inside the 15-minute limit, so still provisional.", buildAtMs: at(10, 44),
    facts: () => ({ ...hour10(), provisional: provisional(at(10, 2), at(10, 32), [eth(0.5, 113)], [CLOSE]) }) },
  { id: "provisional-too-old", says: "10:50, the read is 18 minutes old: not used. The certified 10:02 figures come back with their real age and no provisional mark.", buildAtMs: at(10, 50),
    facts: () => ({ ...hour10(), provisional: provisional(at(10, 2), at(10, 32), [eth(0.5, 113)], [CLOSE]) }) },
  { id: "certified-supersedes", says: "11:34, the 11:00 hour certified at 11:02: it replaces the provisional figures. A read still standing on the 10:02 cutoff is not used, however new.", buildAtMs: at(11, 34),
    facts: () => ({ ...hour11(), provisional: provisional(at(10, 2), at(11, 30), [eth(0.5, 109)], [CLOSE]) }) },
  { id: "provisional-on-new-hour", says: "11:44, a provisional read at 11:42 on the new 11:02 cutoff: provisional again, certified to 11:02.", buildAtMs: at(11, 44),
    facts: () => ({ ...hour11(), provisional: provisional(at(11, 2), at(11, 42), [eth(0.5, 112)]) }) },
  { id: "delayed", says: "13:45, certification stalled at 11:02 and no fresh provisional read: 2 h 43 min old is past the 2-hour line, so the certified figures are served partial.", buildAtMs: at(13, 45),
    facts: () => ({ ...hour11(), provisional: provisional(at(11, 2), at(11, 42), [eth(0.5, 112)]) }) },
  { id: "unavailable", says: "14:10, still 11:02 and no fresh provisional read: over 3 hours old, so the perps are unavailable. No rows, no combined value, never a flat book.", buildAtMs: at(14, 10),
    facts: () => ({ ...hour11(), provisional: provisional(at(11, 2), at(11, 42), [eth(0.5, 112)]) }) },
  { id: "provisional-while-certification-lags", says: "14:10 again, certification still at 11:02 but a provisional read at 14:08: the 3-hour rule is measured from the newest read of either kind, so the figures are served, provisional, certified to 11:02.", buildAtMs: at(14, 10), prior: "delayed",
    facts: () => ({ ...hour11(), provisional: provisional(at(11, 2), at(14, 8), [eth(0.5, 115, "0.06")], [], HOURLY_FUNDING) }) },
  { id: "certified-base-too-old", says: "17:10, a provisional read at 17:08 whose certified cutoff is over 6 hours under it: not used, and the perps are unavailable.", buildAtMs: at(17, 10), prior: "provisional-while-certification-lags",
    facts: () => ({ ...hour11(), provisional: provisional(at(11, 2), at(17, 8), [eth(0.5, 115, "0.12")], [], HOURLY_FUNDING) }) },
  { id: "never-certified", says: "10:24, a wallet with a provisional read and no certified hour yet: unavailable. A provisional read alone never makes figures.", buildAtMs: at(10, 24), prior: null,
    facts: () => ({ ...wallet(), provisional: provisional(at(10, 2), at(10, 22), [eth(1, 112)]) }) },
  { id: "no-perps", says: "10:24, an agent with no perps wallet (or a server that leaves perps out of the record): spot only, the perps times null, and no perps line.", buildAtMs: at(10, 24), prior: null, facts: null },
]

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []
try {
  const { perpsProfileBundle, perpsProfileHourly, floorPerpsHour, usableProvisional, certifiedObservations, PERPS_WINDOW_MS, PERPS_STALE_MS, PERPS_UNAVAILABLE_MS, PERPS_PROVISIONAL_MAX_AGE_MS, PERPS_PROVISIONAL_BASE_MAX_MS } = await load("apps/api/src/ledger/perps/profile.ts")
  const { boardPerpsOf, publishBoardPerps, composeRecordAnswer } = await load("apps/api/src/ledger/views/board/perps.ts")
  const { composePositions } = await load("apps/api/src/ledger/views/board/positions.ts")
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const rules = { staleMs: PERPS_STALE_MS, unavailableMs: PERPS_UNAVAILABLE_MS, provisionalMaxAgeMs: PERPS_PROVISIONAL_MAX_AGE_MS, provisionalBaseMaxMs: PERPS_PROVISIONAL_BASE_MAX_MS }
  assert.deepEqual(rules, { staleMs: 2 * H, unavailableMs: 3 * H, provisionalMaxAgeMs: 15 * M, provisionalBaseMaxMs: 6 * H })

  const periods = [{ walletAddress: WALLET, profileId: PROFILE, fromMs: at(9), toMs: null, servable: true }]
  const published = new Map<string, unknown>()
  let previous: unknown = null
  for (const [n, s] of scenarios.entries()) {
    const B = s.buildAtMs
    // The board's own steps for one profile (computeBoardPerps, then the publish over the prior build).
    let perps: any = null
    let read: Record<string, unknown> = { kind: "none" }
    if (s.facts) {
      const facts = s.facts()
      const input = { profileId: PROFILE, periods, wallets: [facts] }
      const bundle = perpsProfileBundle({ ...input, buildAtMs: B })
      const toHourMs = floorPerpsHour(B)
      const hourly = bundle.available ? perpsProfileHourly({ ...input, fromHourMs: toHourMs - PERPS_WINDOW_MS["30d"], toHourMs }) : []
      const prior = s.prior === undefined ? previous : s.prior === null ? null : published.get(s.prior)
      assert.notEqual(prior, undefined, `${s.id}: prior build ${s.prior}`)
      perps = publishBoardPerps(boardPerpsOf(bundle, hourly, [facts]), prior, B)
      const certified = certifiedObservations(facts).filter((o: { cutoffMs: number }) => o.cutoffMs <= B).at(-1) ?? null
      const p = facts.provisional ?? null
      read = {
        kind: !bundle.available ? "unavailable" : bundle.provisional ? "provisional" : "certified",
        ...(bundle.available ? {} : { reason: bundle.reason }),
        certifiedCutoff: certified ? clock(certified.cutoffMs) : null,
        provisionalRead: p ? { on: clock(p.baseCutoffMs), state: clock(p.stateMs), used: usableProvisional(p, certified, B) } : null,
      }
    }
    published.set(s.id, perps)
    if (s.prior === undefined || s.id === "certified") previous = perps
    // The spot half moves with every board build, as it already did: one made-up token, marked two minutes before the build.
    const mark = { hourMs: floorPerpsHour(B), holdingsAt: B - 2 * M, portfolioValueUsd: 500, portfolioPartial: false, unpriced: 0,
      positions: [{ mint: "MintFake11111111111111111111111111111111111", chain: "solana", symbol: "FAKE", quantity: 50, valueUsd: 500, unrealizedUsd: 100, unrealizedPct: 25, origin: "bought" }] }
    const positions = { success: true, publishedBuildId: `build_fixture_${String(n + 1).padStart(2, "0")}`, ...composePositions(mark, perps, undefined, B), seq: n + 1 }
    const record = composeRecordAnswer({ success: true, record: { profileId: PROFILE, minClosesForRate: 10, totalPnlUsd: 100, unrealizedUsd: 100, totals: { realizedNetUsd: 0, wins: 0, losses: 0, counted: 0 } } }, perps)
    const base = { scenario: s.id, buildAt: clock(B) }
    rows.push({ id: `${s.id}-api`, ...base, surface: "api-source", says: s.says,
      evidence: "pure API source on made-up stored facts; the database, the perps jobs and the keyed route are not executed",
      outcome: { read, positions, record } })

    const orders = { success: true, orders: [], readAt: B, stale: false, dexes: [], seq: n + 1 }
    const paths = { positions: `/api/v1/agent/records/${PROFILE}/positions`, orders: `/api/v1/agent/records/${PROFILE}/open-orders` }
    const serve = (requests: Request[]) => (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
      assert.ok(String(url).startsWith(`${cfg.apiUrl}/`))
      const path = String(url).slice(cfg.apiUrl.length)
      const headers = new Headers(init?.headers)
      requests.push({ method: init?.method ?? "GET", path, credential: headers.has("authorization") || headers.has("x-api-key") })
      assert.equal(init?.method ?? "GET", "GET")
      if (path === paths.positions) return Response.json(positions)
      if (path === paths.orders) return Response.json(orders)
      throw new Error(`unexpected local request: ${path}`)
    }) as unknown as typeof fetch
    const hasPerp = positions.positions.some((p: { kind: string }) => p.kind === "perp")

    {
      const requests: Request[] = []
      globalThis.fetch = serve(requests)
      const server = createCandleMcpServer({}, cfg)
      const client = new Client({ name: "harness-freshness-recorder", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(b); await client.connect(a)
      try {
        const r: any = await client.callTool({ name: "candle_get_agent_positions", arguments: { profileId: PROFILE } })
        const outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
        // The tool relays the route's answer whole, and sends no credential though one is configured.
        assert.deepEqual(outcome, { body: positions, isError: false }, `${s.id} mcp`)
        assert.deepEqual(requests, [{ method: "GET", path: paths.positions, credential: false }])
        rows.push({ id: `${s.id}-mcp`, ...base, surface: "mcp", args: { profileId: PROFILE }, requests, outcome })
      } finally { await client.close(); await server.close(); globalThis.fetch = deny }
    }
    {
      const requests: Request[] = []
      const client = new CandleClient({ ...cfg, fetch: serve(requests), maxRetries: 0 })
      const body = await client.getAgentPositions(PROFILE)
      const { success: _success, ...answer } = positions
      assert.deepEqual(body, answer, `${s.id} sdk`)
      assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", paths.positions]])
      rows.push({ id: `${s.id}-sdk`, ...base, surface: "sdk", args: { profileId: PROFILE }, requests, outcome: { body, isError: false } })
    }
    for (const json of [false, true]) {
      const requests: Request[] = []
      const stdout = createCapture(), stderr = createCapture()
      // The CLI's clock is the build's: it only decides whether a time prints its year.
      const deps = createTestDeps({ stdout, stderr, now: () => B, env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_API_URL: cfg.apiUrl }, fetch: serve(requests) })
      const args = ["agent", "positions", PROFILE, ...(json ? ["--json"] : [])]
      const exitCode = await cli.run(args, deps)
      assert.equal(exitCode, 0, `${s.id} cli ${stdout.text}${stderr.text}`)
      assert.equal(stderr.text, "")
      // A public read: no key is sent. The open orders are read beside a perp on the human view only.
      assert.deepEqual(requests, [paths.positions, ...(hasPerp && !json ? [paths.orders] : [])].map((path) => ({ method: "GET", path, credential: false })))
      if (json) assert.deepEqual(JSON.parse(stdout.text), positions, `${s.id} cli --json`)
      rows.push({ id: `${s.id}-cli${json ? "-json" : ""}`, ...base, surface: "cli", args: { command: `candle ${args.join(" ")}` }, requests,
        outcome: json ? { exitCode, body: JSON.parse(stdout.text) } : { exitCode, lines: stdout.text.trimEnd().split("\n") } })
    }
  }
  // What the public docs and the SDK's changelog say at this commit. Public text, read as text.
  const docLine = (file: string, starts: string) => {
    const found = readFileSync(join(checkout, file), "utf8").split("\n").filter((line) => line.startsWith(starts))
    assert.equal(found.length, 1, `${file}: one line starting ${starts}`)
    return found[0]!
  }
  const docs = DOCS.map((file) => docLine(file, "- Perp rows, `perpsAsOfMs`"))
  assert.ok(docs.every((line) => line === docs[0]), "the three copies of the page say the same")
  rows.push({ id: "docs-agent-trading", scenario: "docs", surface: "docs", args: { files: DOCS }, outcome: { text: docs[0] } })
  rows.push({ id: "docs-sdk-changelog", scenario: "docs", surface: "docs", args: { files: ["packages/sdk/CHANGELOG.md"] }, outcome: { text: docLine("packages/sdk/CHANGELOG.md", "BE-3767 (unreleased") } })
  const text = JSON.stringify(rows)
  assert.ok(!text.includes(WALLET) && !/0x[0-9a-f]{40}/i.test(text), "no wallet address in a recording")
  assert.ok(!/"(wallet|address|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid)"/i.test(text), "no wallet, account value or order id in a recording")
  assert.ok(!text.includes(cfg.apiKey))
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-freshness-source.json"), `${JSON.stringify({
    about: "Offline perps freshness contracts from exact merged source. Every time is an hour and minute of one made-up day, and every figure is made up. api-source rows are answers built by Candle's pure perps source (profile bundle, board publish, positions and record composition) from one made-up wallet's stored facts: the provisional read between certified hours, the certified hour that replaces it, and the delayed and unavailable rules. The wallet's address is hashed inside that source and is in no row. mcp, sdk and cli rows read the same positions answer through the registered tool, the SDK and `candle agent positions` over an intercepted fetch. docs rows are the public page's own freshness line (its three copies agree) and the SDK changelog entry, read as text. The database, the perps jobs, the venue and the keyed API route are not executed, and no deployed behavior is claimed.",
    source, rules, profile: PROFILE, day: new Date(DAY).toISOString().slice(0, 10), rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline perps freshness contracts (${scenarios.length} builds) from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch }
