// Offline contracts for perps traded from an embedded wallet, as Candle's public record now counts them: each
// fill is attributed to the agent whose key built the order (by `cloid`, pinned to the venue's `oid`), the
// owner's own trades are in no public answer, a cloid the venue never pinned claims nothing (`order_unverified`),
// a round on such a wallet carries no id and no hash, and a split that is not exact marks the round partial.
//
// Each answer is built by Candle's own board path (`computeBoardPerps`, which runs `attributeBoardPerps` and the
// profile engine, then `publishBoardPerps`, `composeRecordAnswer` and `composePositions`) from one made-up
// embedded wallet's stored facts and a made-up order inventory, then the positions answer is read through the
// registered MCP tool, the SDK and the CLI. The wallet's address goes into that source only and never into the
// fixture. Every fetch is intercepted; no key, database, venue or keyed API route is used.
//   bun scripts/read-perps-attribution-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-attribution-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const API_SOURCES = [
  "apps/api/src/ledger/perps/attribution.ts", "apps/api/src/ledger/perps/profile.ts", "apps/api/src/ledger/views/board/perps.ts",
  "apps/api/src/ledger/views/board/positions.ts",
]
/** The public page that explains the record's method, and its two published copies. */
const DOCS = ["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"]
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", ...API_SOURCES, ...DOCS)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const deny = (() => { throw new Error("attribution recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

const H = 3_600_000, M = 60_000
/** A made-up day; every time below is an hour and minute of it, in UTC. */
const DAY = Date.UTC(2027, 0, 12)
const at = (h: number, m = 0) => DAY + h * H + m * M
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const PROFILE = "prof_0123456789abcdef"
const OTHER_PROFILE = "prof_fedcba9876543210"
/** Input to Candle's pure source only: it is hashed there, and no row below may carry it. */
const WALLET = `0x${"e".repeat(40)}`
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const usd = (n: number) => BigInt(Math.round(n * 1_000_000))
const cloid = (n: number) => `0x${n.toString(16).padStart(32, "0")}`

type Position = Record<string, unknown>
type Fill = {
  coin: string; tid: string; hash: string; time: number; side: "A" | "B"; startPosition: string; sz: string
  closedPnlUsdMicros: bigint; feeUsdMicros: bigint; liquidated: boolean; liquidatedSelf: boolean
  oid: string; cloid: string | null; px: string; dir: string
}
type Funding = { coin: string; time: number; usdcUsdMicros: bigint; szi: string }
type Facts = {
  wallet: string
  ingest: { coverageFromMs: number; historyPartial: boolean; completeThroughMs: number | null }
  hours: { hourMs: number; cutoffMs: number | null; readOk: boolean; positions: Position[] | null }[]
  decisions: { hourMs: number; outcome: "certified" | "abandoned"; cutoffMs: number; fillsThroughMs: number | null; fundingThroughMs: number | null }[]
  fills: Fill[]; funding: Funding[]; gaps: never[]
}
type Order = { cloid: string; keyPrefix: string; profileId: string | null; builtAtMs: number; venueOid?: string }

let tid = 1
/** The owner's fills carry the hash a block explorer would resolve to the wallet; the tests below look for it. */
const ownerHash = (t: number) => `0x0e0e${t.toString(16).padStart(60, "0")}`
const fill = (time: number, start: number, delta: number, px: number, o: { cloid?: string; oid?: number; closedPnl?: number; fee?: number; owner?: boolean } = {}): Fill => {
  const t = tid++
  return {
    coin: "ETH", tid: String(t), hash: o.owner ? ownerHash(t) : `0x${t.toString(16).padStart(64, "0")}`, time, side: delta > 0 ? "B" : "A",
    startPosition: String(start), sz: String(Math.abs(delta)), closedPnlUsdMicros: usd(o.closedPnl ?? 0), feeUsdMicros: usd(o.fee ?? 0),
    liquidated: false, liquidatedSelf: false, oid: String(o.oid ?? 9000 + t), cloid: o.cloid ?? null, px: String(px), dir: delta > 0 ? "Open Long" : "Close Long",
  }
}
const venue = (size: number, entry: number, mark: number): Position => ({
  coin: "ETH", side: "long", size: String(size), entryPx: String(entry), markPx: String(mark), unrealizedPnlUsd: String(size * (mark - entry)),
  returnOnEquity: "0", leverage: { value: 10, type: "cross" }, liquidationPx: "1", liquidationDistance: 0.9, fundingSinceOpenUsd: "0",
  marginUsedUsd: String(size * mark / 10), positionValueUsd: String(size * mark), level: "ok",
})
const newWallet = (): Facts => ({ wallet: WALLET, ingest: { coverageFromMs: at(8), historyPartial: false, completeThroughMs: null }, hours: [], decisions: [], fills: [], funding: [], gaps: [] })
function certify(f: Facts, hourMs: number, positions: Position[]) {
  const cutoffMs = hourMs + 2 * M
  f.hours.push({ hourMs, cutoffMs, readOk: true, positions })
  f.decisions.push({ hourMs, outcome: "certified", cutoffMs, fillsThroughMs: cutoffMs, fundingThroughMs: cutoffMs })
  f.ingest.completeThroughMs = Math.max(f.ingest.completeThroughMs ?? 0, cutoffMs)
}
const order = (c: string, venueOid: string | undefined, profileId: string | null = PROFILE): Order => ({ cloid: c, keyPrefix: "cndl_fixture", profileId, builtAtMs: at(9), ...(venueOid === undefined ? {} : { venueOid }) })

const OPEN = cloid(1), CLOSE = cloid(2)
/** The agent opens 2 ETH at 100 (09:10, order 1). The owner buys 1 more at 105 from another tool (09:20). */
function opened(f: Facts, openOid: string | undefined) {
  f.fills.push(fill(at(9, 10), 0, 2, 100, { cloid: OPEN, oid: 1 }))
  f.fills.push(fill(at(9, 20), 2, 1, 105, { owner: true }))
  void openOid
}
/** Shared, still open: the agent holds 2 at its own entry, the wallet 3. */
function sharedOpen(): Facts { const f = newWallet(); opened(f, "1"); certify(f, at(10), [venue(3, 101.666667, 110)]); return f }
/** Shared, closed: the agent sells its 2 at 120 (10:10, order 2) with the owner still long 1. */
function sharedClosed(): Facts {
  const f = newWallet(); opened(f, "1")
  certify(f, at(10), [venue(3, 101.666667, 110)])
  f.funding.push({ coin: "ETH", time: at(10, 5), usdcUsdMicros: usd(-3), szi: "3" })
  // Hyperliquid's closed P&L is against the wallet's average entry: 2 x (120 - 101.666667).
  f.fills.push(fill(at(10, 10), 3, -2, 120, { cloid: CLOSE, oid: 2, closedPnl: 36.666666 }))
  certify(f, at(11), [venue(1, 101.666667, 130)])
  return f
}
/** Only the agent trades the wallet: open at 09:10, close at 10:10. */
function soleAgent(): Facts {
  const f = newWallet()
  f.fills.push(fill(at(9, 10), 0, 1.5, 100, { cloid: OPEN, oid: 1, fee: 0.1 }))
  certify(f, at(10), [venue(1.5, 100, 104)])
  f.fills.push(fill(at(10, 10), 1.5, -1.5, 110, { cloid: CLOSE, oid: 2, closedPnl: 15, fee: 0.1 }))
  certify(f, at(11), [])
  return f
}
/** The agent's open alone, still held at 10:02. */
function openOnly(): Facts {
  const f = newWallet()
  f.fills.push(fill(at(9, 10), 0, 1.5, 100, { cloid: OPEN, oid: 1 }))
  certify(f, at(10), [venue(1.5, 100, 104)])
  return f
}
/** The owner alone trades the wallet, and the agent has an order on it that never filled. */
function ownerOnly(): Facts {
  const f = newWallet()
  f.fills.push(fill(at(9, 20), 0, 1, 105, { owner: true }))
  f.fills.push(fill(at(10, 20), 1, -1, 108, { owner: true, closedPnl: 3 }))
  certify(f, at(11), [])
  return f
}

type Scenario = { id: string; says: string; buildAtMs: number; facts: () => Facts; orders: Order[]; servable?: boolean }
const scenarios: Scenario[] = [
  { id: "owner-trade-excluded-open", buildAtMs: at(10, 30), facts: sharedOpen, orders: [order(OPEN, "1")],
    says: "The agent opened 2 ETH at 100 and the owner bought 1 more from another tool: the agent's position is its own 2 at its own entry, not the wallet's 3. No closed round yet." },
  { id: "owner-trade-excluded-closed", buildAtMs: at(11, 30), facts: sharedClosed, orders: [order(OPEN, "1"), order(CLOSE, "2")],
    says: "The agent closed its 2 ETH while the owner stayed long 1: the round holds only the agent's fills, its P&L is against its own entry (2 x (120 - 100) less funding share), it is partial (unmatched_fill) because the owner's trade shared the coin, and it carries no id and no hash." },
  { id: "sole-agent", buildAtMs: at(11, 30), facts: soleAgent, orders: [order(OPEN, "1"), order(CLOSE, "2")],
    says: "Only the agent trades the wallet: the round is exact, not partial, and still carries no id and no hash on an embedded wallet." },
  { id: "unpinned-cloid", buildAtMs: at(11, 30), facts: soleAgent, orders: [order(OPEN, undefined), order(CLOSE, undefined)],
    says: "Candle built both orders, but the venue order that first carried each cloid was never observed, so the fills' oids cannot be checked: the fills are order_unverified, left out of the agent's profile, and the agent has no perps round." },
  { id: "reused-cloid", buildAtMs: at(10, 30), facts: openOnly, orders: [order(OPEN, "7")],
    says: "The venue pinned the open's cloid to order 7, but the fill is on order 1 (the cloid carried by another venue order, from another tool): the fill claims nothing, so the agent holds nothing." },
  { id: "owner-only", buildAtMs: at(11, 30), facts: ownerOnly, orders: [order(cloid(3), "5")],
    says: "The owner's own trades on the wallet and an agent order that never filled: the agent has no perps in its record, and none of the owner's fills appears." },
  { id: "agent-not-public", buildAtMs: at(11, 30), facts: soleAgent, orders: [order(OPEN, "1"), order(CLOSE, "2")], servable: false,
    says: "The same wallet for an agent that is not public (private, hidden or turned off): nothing is served." },
]

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []
try {
  const { computeBoardPerps, publishBoardPerps, composeRecordAnswer } = await load("apps/api/src/ledger/views/board/perps.ts")
  const { composePositions } = await load("apps/api/src/ledger/views/board/positions.ts")
  const { attributePerpsWallet } = await load("apps/api/src/ledger/perps/attribution.ts")
  const { floorPerpsHour } = await load("apps/api/src/ledger/perps/profile.ts")
  const { CandleClient } = await load("packages/sdk/src/client.ts")
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const cli = await load("packages/cli/src/index.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")

  const reports: { name: string; detail: unknown }[] = []
  for (const [n, s] of scenarios.entries()) {
    const B = s.buildAtMs
    const facts = s.facts()
    const servable = s.servable !== false
    const board = await computeBoardPerps({
      inventory: async () => [],
      facts: async () => [facts],
      orders: async () => ({
        orders: new Map([[WALLET, s.orders]]),
        embedded: [{ address: WALLET, profiles: [{ profileId: PROFILE, fromMs: at(9), servable }] }],
        servable: { [PROFILE]: servable },
      }),
      report: (name: string, detail: unknown) => reports.push({ name, detail }),
    }, B)
    const perps = board[PROFILE] ? publishBoardPerps(board[PROFILE], null, B) : null
    // Every profile the board built for this wallet: the owner is none of them.
    assert.deepEqual(Object.keys(board).filter((p) => p !== PROFILE), [], `${s.id}: only the agent's profile is built`)
    const mark = { hourMs: floorPerpsHour(B), holdingsAt: B - 2 * M, portfolioValueUsd: 0, portfolioPartial: false, unpriced: 0, positions: [] }
    const positions = { success: true, publishedBuildId: `build_fixture_${String(n + 1).padStart(2, "0")}`, ...composePositions(mark, perps, undefined, B), seq: n + 1 }
    const record = composeRecordAnswer({ success: true, record: { profileId: PROFILE, minClosesForRate: 10, totalPnlUsd: 0, unrealizedUsd: 0, totals: { realizedNetUsd: 0, wins: 0, losses: 0, counted: 0 } } }, perps)
    const base = { scenario: s.id, buildAt: clock(B) }
    // Why each fill went where it did. The holder is a role: the agent, or nobody public (the owner's own trades,
    // or a fill no agent's pinned order claims).
    const split = attributePerpsWallet({ facts, orders: s.orders, hideHash: true, profiles: [PROFILE] })
    const fills = split.fills.map((f: any) => ({ time: clock(facts.fills.find((x) => x.tid === f.tid)!.time), reason: f.reason, holder: f.parts.map((p: any) => (p.holder === PROFILE ? "agent" : "not public")) }))
    rows.push({ id: `${s.id}-attribution`, ...base, surface: "api-source", evidence: "Candle's attribution by order on the same made-up facts; not the database or the venue",
      outcome: { fills, partialEvents: (split.profiles.get(PROFILE)?.attribution?.events ?? []).map((e: any) => e.reason) } })
    const perpRounds = (record as any).record?.perpRounds ?? []
    rows.push({ id: `${s.id}-api`, ...base, surface: "api-source", says: s.says,
      evidence: "board path on made-up stored facts and a made-up order inventory; the database, the perps jobs, the venue and the keyed route are not executed",
      outcome: { served: perps !== null, available: perps?.available ?? null, perpRounds, positions, totals: (record as any).record?.totals } })

    const paths = { positions: `/api/v1/agent/records/${PROFILE}/positions`, orders: `/api/v1/agent/records/${PROFILE}/open-orders` }
    const orders = { success: true, orders: [], readAt: B, stale: false, dexes: [], seq: n + 1 }
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
      const client = new Client({ name: "harness-attribution-recorder", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(b); await client.connect(a)
      try {
        const r: any = await client.callTool({ name: "candle_get_agent_positions", arguments: { profileId: PROFILE } })
        const outcome = { body: JSON.parse(r.content[0].text), isError: r.isError === true }
        assert.deepEqual(outcome, { body: positions, isError: false }, `${s.id} mcp`)
        rows.push({ id: `${s.id}-mcp`, ...base, surface: "mcp", args: { profileId: PROFILE }, requests, outcome })
      } finally { await client.close(); await server.close(); globalThis.fetch = deny }
    }
    {
      const requests: Request[] = []
      const client = new CandleClient({ ...cfg, fetch: serve(requests), maxRetries: 0 })
      const body = await client.getAgentPositions(PROFILE)
      const { success: _success, ...answer } = positions
      assert.deepEqual(body, answer, `${s.id} sdk`)
      rows.push({ id: `${s.id}-sdk`, ...base, surface: "sdk", args: { profileId: PROFILE }, requests, outcome: { body, isError: false } })
    }
    for (const json of [false, true]) {
      const requests: Request[] = []
      const stdout = createCapture(), stderr = createCapture()
      const deps = createTestDeps({ stdout, stderr, now: () => B, env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_API_URL: cfg.apiUrl }, fetch: serve(requests) })
      const args = ["agent", "positions", PROFILE, ...(json ? ["--json"] : [])]
      const exitCode = await cli.run(args, deps)
      assert.equal(exitCode, 0, `${s.id} cli ${stdout.text}${stderr.text}`)
      assert.equal(stderr.text, "")
      assert.deepEqual(requests, [paths.positions, ...(hasPerp && !json ? [paths.orders] : [])].map((path) => ({ method: "GET", path, credential: false })))
      if (json) assert.deepEqual(JSON.parse(stdout.text), positions, `${s.id} cli --json`)
      rows.push({ id: `${s.id}-cli${json ? "-json" : ""}`, ...base, surface: "cli", args: { command: `candle ${args.join(" ")}` }, requests,
        outcome: json ? { exitCode, body: JSON.parse(stdout.text) } : { exitCode, lines: stdout.text.trimEnd().split("\n") } })
    }
  }
  // The board never logs an address: an embedded wallet is not an override report at all.
  assert.deepEqual(reports, [], "an embedded wallet reports no override")

  // What the public docs say at this commit. Public text, read as text.
  const section = (file: string) => {
    const text = readFileSync(join(checkout, file), "utf8")
    const start = text.indexOf("Which perps count for an agent")
    assert.ok(start >= 0, `${file}: the by-order section`)
    const from = text.lastIndexOf("\n#", start) + 1
    const rest = text.slice(start)
    const next = rest.search(/\n#{1,4} /)
    return (next < 0 ? text.slice(from) : text.slice(from, start + next)).trim()
  }
  const docs = DOCS.map(section)
  assert.ok(docs.every((d) => d === docs[0]), "the copies of the page say the same")
  rows.push({ id: "docs-agent-trading", scenario: "docs", surface: "docs", args: { files: DOCS }, outcome: { text: docs[0] } })

  const text = JSON.stringify(rows)
  assert.ok(!text.includes(WALLET) && !/0x[0-9a-f]{40}/i.test(text), "no wallet address in a recording")
  assert.ok(!text.includes("0x0e0e"), "no owner fill hash in a recording")
  assert.ok(!/"(wallet|address|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid)"/i.test(text), "no wallet, account value or order id in a recording")
  assert.ok(!text.includes(cfg.apiKey))
  void OTHER_PROFILE
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-attribution-source.json"), `${JSON.stringify({
    about: "Offline contracts for embedded-wallet perps in the public record, from exact source (BE-3773). Every time is an hour and minute of one made-up day, and every figure is made up. api-source rows are answers built by Candle's board path (attribution by order, the profile engine, the board publish, record and positions composition) from one made-up embedded wallet's stored facts and a made-up order inventory: the agent's own fills only, the owner's trades in no answer, a cloid the venue never pinned claiming nothing, and a round with no id and no hash. The wallet's address and the owner's fill hashes are in no row. mcp, sdk and cli rows read the same positions answer through the registered tool, the SDK and `candle agent positions` over an intercepted fetch. The docs row is the public page's own by-order section (its copies agree), read as text. The database, the perps jobs, the venue and the keyed API route are not executed, and no deployed behavior is claimed.",
    source, profile: PROFILE, day: new Date(DAY).toISOString().slice(0, 10), rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline perps attribution contracts (${scenarios.length} scenarios) from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch }
