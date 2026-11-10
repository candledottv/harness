// What triggers rest on, as recorded live from Hacc and Candle (test/record-triggers.ts) and scrubbed into
// test/fixtures/hacc-recorded/triggers/ and test/fixtures/candle-recorded/triggers/ (scripts/scrub-triggers.ts).
// Two kinds of check: what the answers say, which the watchers are built on, and that the fake Hacc answers in
// the same shapes and refusals.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { leftovers as candleLeftovers } from "../scripts/scrub-candle-rest"
import { leftovers as haccLeftovers } from "../scripts/scrub-hacc"
import { type FakeHacc, PRICE_REFRESH_LIMIT, PRICE_REFRESH_MS, startFakeHacc } from "./fake-hacc"

const haccDir = join(import.meta.dir, "fixtures/hacc-recorded/triggers")
const candleDir = join(import.meta.dir, "fixtures/candle-recorded/triggers")
type Row = Record<string, unknown>
interface Recording {
  name: string
  route: string
  query: Record<string, string>
  status: number
  answer: Row
  streamRow?: Row
}
const hacc = (name: string): Recording => JSON.parse(readFileSync(join(haccDir, `${name}.json`), "utf8"))
const candle = (name: string): Recording => JSON.parse(readFileSync(join(candleDir, `${name}.json`), "utf8"))
const prices = (r: Recording) => r.answer.prices as { address: string; price_usd: number | null; market_cap_usd: number | null }[]

test("nothing in the fixtures still looks like a real address, handle or link", () => {
  for (const f of readdirSync(haccDir).filter((f) => f.endsWith(".json"))) expect(haccLeftovers(JSON.parse(readFileSync(join(haccDir, f), "utf8")))).toEqual([])
  for (const f of readdirSync(candleDir).filter((f) => f.endsWith(".json"))) expect(candleLeftovers(JSON.parse(readFileSync(join(candleDir, f), "utf8")))).toEqual([])
})

describe("Hacc's price read, as recorded", () => {
  test("takes at most 20 tokens, not the docs' 60, and refuses more in its own words", () => {
    // The scrub keeps five rows and says how many there were.
    expect((hacc("prices-solana-20-1") as Recording & { truncated: Row }).truncated).toEqual({ "$.prices": 20 })
    for (const name of ["prices-solana-21", "prices-solana-60"]) {
      expect(hacc(name).status).toBe(400)
      expect(hacc(name).answer).toEqual({ error: "At most 20 addresses per request" })
    }
  })

  test("carries a market cap beside each price, and null for a token it doesn't price", () => {
    const rows = prices(hacc("prices-solana-20-1"))
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["address", "market_cap_usd", "price_usd", "symbol"])
    expect(rows.filter((r) => r.price_usd !== null).every((r) => typeof r.market_cap_usd === "number")).toBe(true)
    // Tokens minutes old off the tape: Hacc left a fifth of them unpriced.
    expect(rows.some((r) => r.price_usd === null)).toBe(true)
    expect(prices(hacc("prices-unknown"))[1]).toMatchObject({ price_usd: null, market_cap_usd: null })
  })

  test("prices a Hood token only when the read names chain=hood", () => {
    expect(prices(hacc("prices-hood")).every((r) => r.price_usd === null)).toBe(true)
    expect(prices(hacc("prices-hood-chain")).some((r) => r.price_usd !== null)).toBe(true)
  })

  test("says where each answer came from: a fresh read, then its stored snapshot", () => {
    expect(hacc("prices-solana-20-1").answer.provenance).toMatchObject({ source: "provider_refresh" })
    expect(hacc("prices-solana-20-2").answer.provenance).toMatchObject({ source: "stored_snapshot", stale: false })
    expect(typeof (hacc("prices-solana-20-2").answer.provenance as Row).observed_at).toBe("string")
    expect(hacc("prices-solana-20-1").answer.research_credits).toBe(0)
  })
})

describe("Candle's reads, as recorded", () => {
  test("the market read prices tokens Hacc's price read left unpriced", () => {
    const priced = readdirSync(candleDir)
      .filter((f) => f.startsWith("candle-market-unpriced-"))
      .map((f) => (candle(f.slice(0, -5)).answer.market as Row).priceUsd)
    expect(priced.filter((p) => typeof p === "number").length).toBeGreaterThan(0)
  })

  test("an open position's average entry is its cost over its quantity", () => {
    const open = ["entry-pnl-agent-a", "entry-pnl-agent-b"].flatMap((n) => ((candle(n).answer.pnl as Row).openPositions as Row[]) ?? [])
    expect(open.length).toBeGreaterThan(0)
    for (const p of open) expect(p.avgEntryUsd as number).toBeCloseTo((p.costBasisUsd as number) / (p.quantity as number), 12)
  })
})

describe("the tape's filtered read, as recorded", () => {
  test("has the stream's row, with the same fields, and no market cap on either", () => {
    const filtered = readdirSync(haccDir).filter((f) => f.startsWith("tape-filtered-"))
    expect(filtered.length).toBeGreaterThan(0)
    for (const f of filtered) {
      const r = hacc(f.slice(0, -5))
      const row = (r.answer.signals as Row[]).find((s) => s.id === r.streamRow!.id)
      expect(row).toBeDefined()
      expect(Object.keys(row!).sort()).toEqual(Object.keys(r.streamRow!).sort())
      expect(Object.keys(row!).some((k) => /mcap|market_cap/.test(k))).toBe(false)
    }
  })

  test("a gap refilled by date comes back oldest first", () => {
    const rows = hacc("reopen-refill-0").answer.signals as Row[]
    const times = rows.map((r) => Date.parse(String(r.created_at)))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe("the fake Hacc answers as recorded", () => {
  const KEY = ["cndl", "live", "f".repeat(32)].join("_")
  const A = "HaccFakeTrigger111111111111111111111111111"
  const B = "HaccFakeTrigger222222222222222222222222222"
  const HOOD = "0xfa4e000000000000000000000000000000000001"
  let fake: FakeHacc
  beforeAll(() => {
    fake = startFakeHacc({ keys: [KEY], prices: { [A]: { price: 0.5, mcap: 400_000, symbol: "AAA" }, [HOOD]: { price: 2, mcap: 9_000_000, symbol: "HHH" } } })
  })
  afterAll(() => fake.stop())
  const read = async (query: Record<string, string>) => {
    const res = await fetch(`${fake.url}/v1/market/prices?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${KEY}` } })
    return { status: res.status, body: (await res.json()) as Row }
  }

  test("prices by address, null for one it doesn't price, Hood only with chain=hood", async () => {
    const { status, body } = await read({ addresses: [A, B, HOOD].join(",") })
    expect(status).toBe(200)
    expect(body.prices).toEqual([
      { address: A, symbol: "AAA", price_usd: 0.5, market_cap_usd: 400_000 },
      { address: B, symbol: null, price_usd: null, market_cap_usd: null },
      { address: HOOD, symbol: null, price_usd: null, market_cap_usd: null },
    ])
    expect(((await read({ addresses: HOOD, chain: "hood" })).body.prices as Row[])[0]).toMatchObject({ price_usd: 2 })
    // Every field the real answer carries.
    for (const k of Object.keys(hacc("prices-solana-20-1").answer)) expect(Object.keys(body)).toContain(k)
  })

  test("refuses none and more than 20 in Hacc's words", async () => {
    expect(await read({})).toEqual({ status: 400, body: hacc("prices-none").answer })
    const many = Array.from({ length: 21 }, (_, i) => `HaccFakeMany${String(i).padStart(31, "1")}`)
    expect(await read({ addresses: many.join(",") })).toEqual({ status: 400, body: { error: "At most 20 addresses per request" } })
  })

  test(`refreshes at most every ${PRICE_REFRESH_MS / 1000} s, and answers its stored snapshot between`, async () => {
    fake.set({ priceRefreshMs: 50 })
    await Bun.sleep(60)
    expect((await read({ addresses: A })).body.provenance).toMatchObject({ source: "provider_refresh" })
    expect((await read({ addresses: A })).body.provenance).toMatchObject({ source: "stored_snapshot", stale: false })
    await Bun.sleep(60)
    expect((await read({ addresses: A })).body.provenance).toMatchObject({ source: "provider_refresh" })
    fake.set({ priceRefreshMs: PRICE_REFRESH_MS })
  })

  test("past the refresh limit, a set it holds answers stored and a new one answers no prices", async () => {
    fake.set({ priceRefreshLimit: 0 })
    const held = await read({ addresses: A })
    expect(held.body.provenance).toMatchObject({ source: "stored_snapshot", refresh_available: false })
    expect((held.body.prices as Row[])[0]).toMatchObject({ price_usd: 0.5 })
    const fresh = await read({ addresses: [A, B].join(",") })
    expect(fresh.status).toBe(200)
    expect(fresh.body.prices).toBeUndefined()
    expect(fresh.body).toMatchObject({ refresh_refused: "Request rate limit reached", missing_fields: ["snapshot"] })
    fake.set({ priceRefreshLimit: PRICE_REFRESH_LIMIT })
  })

  test("a stored snapshot keeps the price it was taken at", async () => {
    fake.set({ priceRefreshMs: 60_000 })
    const before = await read({ addresses: [A, HOOD].join(",") })
    fake.set({ prices: { [A]: { price: 0.25, mcap: 200_000, symbol: "AAA" } } })
    const after = await read({ addresses: [A, HOOD].join(",") })
    expect((after.body.prices as Row[])[0]).toEqual((before.body.prices as Row[])[0])
    expect(((await read({ addresses: A })).body.prices as Row[])[0]).toMatchObject({ price_usd: expect.any(Number) })
    fake.set({ priceRefreshMs: PRICE_REFRESH_MS, prices: { [A]: { price: 0.5, mcap: 400_000, symbol: "AAA" }, [HOOD]: { price: 2, mcap: 9_000_000, symbol: "HHH" } } })
  })

  test("a market-cap filter on the tape passes a token whose market cap it doesn't know", async () => {
    fake.push({ asset_address: A, pattern: "new_ticker" })
    fake.push({ asset_address: B, pattern: "new_ticker" })
    const tape = async (q: Record<string, string>) =>
      ((await (await fetch(`${fake.url}/v1/signals?${new URLSearchParams({ pattern: "new_ticker", ...q })}`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as Row).signals as Row[]
    const assets = (rows: Row[]) => new Set(rows.map((r) => r.asset_address))
    const wide = assets(await tape({ max_mcap_usd: "1" }))
    expect(wide.has(A)).toBe(false)
    expect(wide.has(B)).toBe(true)
    expect(assets(await tape({ asset: A, max_mcap_usd: "500000" }))).toEqual(new Set([A]))
    expect(await tape({ asset: A, min_mcap_usd: "500000" })).toEqual([])
  })
})

describe("personal signals' cursor, as recorded", () => {
  test("read back an hour later, it answers every row after it, oldest first, and the newest id as next_after", () => {
    const back = hacc("mine-watch-back-after-hour")
    const after = Number(back.query.after)
    const end = (hacc("mine-watch-end").answer.signals as Row[]).map((r) => r.id as number)
    const rows = (back.answer.signals as Row[]).map((r) => r.id as number)
    // The scrub keeps the first five rows of each and says how many there were. The end's first five, the
    // oldest, are the ones at or before the cursor, so the read-back is the rest of them.
    const count = (r: Recording) => (r as Recording & { truncated: Row }).truncated["$.signals"] as number
    expect(end.every((id) => id <= after)).toBe(true)
    expect(count(back)).toBe(count(hacc("mine-watch-end")) - end.length)
    expect(rows.every((id) => id > after)).toBe(true)
    expect(rows).toEqual([...rows].sort((a, b) => a - b))
    expect(back.answer.next_after).toBe(hacc("mine-watch-end").answer.next_after)
  })
})
