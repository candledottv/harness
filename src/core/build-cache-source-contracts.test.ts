// The build path's cached reads (BE-3920), as Candle's API runs them: a blockhash kept warm for 1.5 s, lookup tables
// kept for 10 s, and the web's buy (POST /jupiter/swap) reading neither inside those windows while the fee rides as
// before. Recorded offline from one exact commit (scripts/read-build-cache-source.ts). The build handler's parallel
// checks and the web route's wiring are pinned as source text. The commit is a staging build that changes no CLI, MCP
// or SDK file.
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-build-cache-source.json"
import { outcomeOf } from "./execute"

type Read = { n: number; rpc: string; table?: string }
type Row = { id: string; scenario: string; args: Record<string, unknown>; reads?: Read[]; jupiter?: string[]; outcome: Record<string, any> }
const rows = fixture.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const rpcs = (r: Row) => (r.reads ?? []).map((x) => x.rpc)
const count = (r: Row, rpc: string) => rpcs(r).filter((x) => x === rpc).length
// Why a buy gave its fee up, as the composer names it: the only two reasons it has.
const FORGONE_REASONS = new Set(["input_fee_packet_limit", "input_fee_simulation_failed"])

test("the recording names the exact staging build, the files, and that no CLI, MCP or SDK file moved", () => {
  expect(fixture.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "d47d374040283ecf3c435e967d6c36f58121e43c",
    versions: { cli: "0.13.31", mcp: "0.10.36", sdk: "0.6.25" },
    files: [
      "apps/api/src/services/jupiter/build-cache.ts",
      "apps/api/src/services/jupiter/swap.ts",
      "apps/api/src/routes/jupiter.ts",
      "apps/api/src/services/candle/client.ts",
      "apps/api/src/routes/trade-agent.ts",
      "apps/api/src/services/jupiter/dflow.ts",
    ],
  })
  expect(rows).toHaveLength(37)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["blockhash", "lookup-table", "web-buy", "stale-table", "source-pin", "codes"]))
})

test("nothing in the recording is a key, a hash or the bytes of a transaction, and Jupiter is only ever a stand-in", () => {
  const text = JSON.stringify(fixture)
  // Base58 runs of key length: no address, hash or signature survives into a row.
  expect(text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []).toEqual([])
  expect(text).not.toContain("BEGIN")
  const paths = new Set(rows.flatMap((r) => r.jupiter ?? []))
  expect([...paths].sort()).toEqual(["/swap/v1/swap", "/swap/v1/swap-instructions"])
  const reads = new Set(rows.flatMap(rpcs))
  expect([...reads].sort()).toEqual(["getAddressLookupTable", "getLatestBlockhash", "simulateTransaction"])
})

test("a blockhash younger than 1.5 s is served as is, and one 1.5 s old is read again", () => {
  expect(row("blockhash-reused-inside-the-window")).toMatchObject({ args: { gapMs: 1_499 }, outcome: { fetches: 1, sameHash: true, heightIsTheRpcs: true } })
  expect(row("blockhash-read-again-at-the-window")).toMatchObject({ args: { gapMs: 1_500 }, outcome: { fetches: 2, sameHash: false, heightIsTheRpcs: true } })
})

test("a burst of callers shares one blockhash read, and each connection keeps its own", () => {
  expect(row("blockhash-burst-shares-one-read").outcome).toEqual({ fetches: 1, sameHash: true })
  expect(row("blockhash-per-connection").outcome.fetches).toBe(2)
})

test("a failed blockhash read is never kept, and an expired hash is never served in place of a failed read", () => {
  expect(row("blockhash-failed-read-is-not-kept").outcome).toEqual({ firstRejected: true, fetches: 2, secondIsTheRpcs: true })
  expect(row("blockhash-expired-is-never-served-on-failure").outcome).toEqual({ secondRejected: true, fetches: 2 })
})

test("a lookup table younger than 10 s is served as is, per address and per connection", () => {
  expect(row("table-reused-inside-the-window")).toMatchObject({ args: { gapMs: 9_999 }, outcome: { fetches: 1 } })
  expect(row("table-read-again-at-the-window")).toMatchObject({ args: { gapMs: 10_000 }, outcome: { fetches: 2 } })
  expect(row("table-per-address").outcome.fetches).toBe(2)
  expect(row("table-per-connection").outcome.fetches).toBe(2)
})

test("a table the RPC can't read, or fails to read, is never kept; a dropped table alone is read again", () => {
  expect(row("table-unreadable-is-not-kept").outcome).toEqual({ firstFound: false, secondFound: true, fetches: 2 })
  expect(row("table-failed-read-is-not-kept").outcome).toEqual({ firstRejected: true, secondFound: true, fetches: 2 })
  expect(row("table-dropped-is-read-again-and-only-it").outcome).toEqual({ fetches: 3, readAgain: ["route"] })
})

test("a second web buy inside both windows reads neither, and still carries the fee on the RPC's own hash and height", () => {
  const r = row("web-buy-second-reads-neither")
  expect(rpcs(r)).toEqual(["getAddressLookupTable", "getLatestBlockhash", "simulateTransaction", "simulateTransaction"])
  expect(r.jupiter).toEqual(["/swap/v1/swap-instructions", "/swap/v1/swap-instructions"])
  for (const buy of [r.outcome.first, r.outcome.second]) expect(buy).toEqual({ feeForgone: false, feeCarried: true, tablesUsed: 1, hash: "read 1", lastValidBlockHeight: 1001 })
})

test("a web buy past a window reads that read again, and only that one", () => {
  const hash = row("web-buy-past-the-hash-window-reads-the-hash")
  expect(hash.outcome).toMatchObject({ tableReads: 1, hashReads: 2, second: { hash: "read 2", lastValidBlockHeight: 1002, feeCarried: true } })
  const both = row("web-buy-past-the-table-window-reads-both")
  expect(both.outcome).toMatchObject({ tableReads: 2, hashReads: 2, second: { hash: "read 2", feeCarried: true, tablesUsed: 1 } })
})

test("an agent build warms the web's buy on the same connection, and a burst of web buys shares the hash read", () => {
  expect(row("web-buy-after-an-agent-build-reads-neither").outcome).toMatchObject({ tableReads: 1, hashReads: 1, web: { feeCarried: true, hash: "read 1" } })
  // The table cache has no shared in-flight read: three buys at once each read the table, one hash read between them.
  const burst = row("web-buy-burst-shares-the-hash")
  expect(burst.outcome).toEqual({ hashReads: 1, tableReads: 3, feeCarried: true, sameHash: true })
})

test("a web buy whose table can't be read composes without it, and the next buy reads it again", () => {
  const r = row("web-buy-unreadable-table-is-read-next-buy")
  expect(r.outcome.first).toMatchObject({ tablesUsed: 0, feeCarried: true, feeForgone: false })
  expect(r.outcome.second).toMatchObject({ tablesUsed: 1, feeCarried: true, feeForgone: false })
  expect(count(r, "getAddressLookupTable")).toBe(2)
})

test("a failed hash read builds nothing to sign, and the next buy reads the hash again", () => {
  const r = row("web-buy-failed-hash-read-builds-nothing")
  expect(r.outcome).toMatchObject({ firstRejected: true, simulatedBeforeTheRetry: false, hashReads: 2, second: { hash: "read 2", feeCarried: true } })
  expect(rpcs(r)).toEqual(["getAddressLookupTable", "getLatestBlockhash", "getLatestBlockhash", "simulateTransaction"])
})

test("a stale cached table that overflows is read again once before the fee is given up, and the old fallback is unchanged", () => {
  const kept = row("web-buy-stale-table-is-read-again-and-the-fee-kept")
  expect(rpcs(kept)).toEqual(["getAddressLookupTable", "getLatestBlockhash", "getAddressLookupTable", "simulateTransaction"])
  expect(kept.outcome).toMatchObject({ tableReads: 2, feeFreeRequests: 0, buy: { feeForgone: false, feeCarried: true, tablesUsed: 1 } })
  const forgone = row("web-buy-still-too-big-after-one-read-falls-back-as-before")
  expect(count(forgone, "getAddressLookupTable")).toBe(2)
  expect(forgone.jupiter).toEqual(["/swap/v1/swap-instructions", "/swap/v1/swap"])
  expect(forgone.outcome).toMatchObject({ feeFreeRequests: 1, buy: { feeForgone: true, feeForgoneReason: "input_fee_packet_limit", feeCarried: false, hash: "jupiter's own" } })
})

test("every reason a buy gave its fee up is one the composer names, and every composed buy carried its fee", () => {
  const buys = rows.flatMap((r) => [r.outcome.first, r.outcome.second, r.outcome.web, r.outcome.buy].filter(Boolean))
  expect(buys.length).toBeGreaterThan(10)
  for (const buy of buys) {
    if (buy.feeForgone) expect(FORGONE_REASONS.has(buy.feeForgoneReason), buy.feeForgoneReason).toBe(true)
    else expect(buy.feeCarried).toBe(true)
  }
})

test("the web route and the build handler hold what the card changed, as source", () => {
  const pins = scenario("source-pin")
  expect(pins.map((p) => p.id)).toEqual([
    "web-buy-uses-the-process-connection", "web-buy-passes-no-priority-cap", "web-swap-is-session-auth", "one-connection-per-process",
    "tables-read-through-the-cache", "hash-read-through-the-cache", "compile-failure-reads-tables-once-more", "overflow-reads-tables-once-before-the-fee-goes",
    "build-breaker-and-payer-start-together", "build-breaker-answers-before-the-payer-is-used", "build-payer-read-only-for-a-linked-payer",
    "build-feed-read-starts-early", "build-mount-reads-wallets-fresh", "dflow-quote-budget-is-400ms",
  ])
  for (const p of pins) expect(p.outcome.found, p.id).toBe(true)
})

test("every code the build's checks answer with is one the harness maps as refused, nothing sent", () => {
  const { codes, previewOnly } = row("build-check-codes").outcome as { codes: string[]; previewOnly: string[] }
  expect(codes).toEqual(["SWAP_ROUTE_FAILING", "AGENT_WALLET_MISSING", "VALIDATION_FAILED"])
  // The Hood-only preview route's refusal is not a build answer; the harness never asks for a preview build.
  expect(previewOnly).toEqual(["PREVIEW_UNSUPPORTED"])
  for (const code of codes) {
    // The breaker's refusal is retryable and carries its wait; the others are plain refusals.
    const error = code === "SWAP_ROUTE_FAILING" ? { code, retryable: true, retry_after_seconds: 30 } : { code, retryable: false }
    const mapped = outcomeOf("trade", { kind: "error", code, retryable: error.retryable, body: { api: { error } } })
    expect(mapped.state, code).toBe("refused")
  }
})
