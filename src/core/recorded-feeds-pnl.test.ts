// The contract with Candle for the lists' and P&L's reads, recorded with a throwaway test
// account's Read key (test/record-candle-data.ts: the REST routes the MCP tools wrap) and scrubbed into
// test/fixtures/candle-recorded/feeds-pnl/ by scripts/scrub-candle-rest.ts. Two kinds of check: what Candle's
// answers say, which the tabs are built on, and that the fake answers in the same shapes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { leftovers } from "../../scripts/scrub-candle-rest"
import { CandleMcpPool, candleConfigDir, type ToolOutcome } from "./candle-mcp"

const dir = join(import.meta.dir, "../../test/fixtures/candle-recorded/feeds-pnl")
type Row = Record<string, unknown>
interface Recording {
  name: string
  tool: string
  args: Record<string, unknown>
  route: string
  query: Record<string, string>
  status: number
  ms: number
  bytes: number
  answer: Row
  truncated?: Record<string, number>
}
const feedsPnl = (name: string): Recording => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"))
const BUCKETS = ["new", "graduated", "onfire", "finalstretch"] as const

interface Position {
  agent: string
  openedBy?: string
  mint: string
  wallet: string
  quantity: number
  soldQuantity?: number
}
interface Book {
  keyPrefix: string
  pnl: { closedPositions: Position[]; openPositions: Position[]; byWallet: Row[]; totalUsd: number; realizedNetUsd: number; unrealizedUsd: number }
}
interface Trade {
  mint: string
  side: "buy" | "sell"
  status: string
  filledAmount: number | null
  payerWallet: string
  clientTradeId: string
}

test("nothing in the fixtures still looks like a real address or link", () => {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) expect(leftovers(JSON.parse(readFileSync(join(dir, f), "utf8")))).toEqual([])
})

describe("Candle's four lists", () => {
  test("each answers on Solana at limit 20, in under a second, with its envelope", () => {
    for (const bucket of BUCKETS) {
      const r = feedsPnl(`feed-${bucket}-fields`)
      expect(r.status).toBe(200)
      expect(r.ms).toBeLessThan(1000)
      expect(r.answer.success).toBe(true)
      expect(r.answer.bucket).toBe(bucket)
      for (const k of ["tokens", "matched", "scanned", "cursor", "warming"]) expect(r.answer).toHaveProperty(k)
    }
  })

  test("Final Stretch is on in production and says whether it can be trusted", () => {
    const fs = feedsPnl("feed-finalstretch-fields").answer as { cursor: string; reset: boolean; stale: boolean; feed: Row; exact: Row; tokens: Row[] }
    expect(fs.cursor).toBe("finalstretch:0")
    expect(fs.reset).toBe(true)
    expect(fs.stale).toBe(false)
    expect(Object.keys(fs.feed).sort()).toEqual(["ageS", "lastCurveTradeAt", "ok"])
    expect(Object.keys(fs.exact).sort()).toEqual(["lastReadAt", "ok"])
    // Every row has its curve progress and last trade; price and market cap often don't come.
    expect(fs.tokens.every((t) => typeof t.progress === "number" && typeof t.lastTradeAt === "string")).toBe(true)
    expect(fs.tokens.some((t) => t.priceUsd === undefined)).toBe(true)
    // Hood has no Final Stretch: an empty list that's still trusted.
    const hood = feedsPnl("feed-finalstretch-hood").answer as { tokens: Row[]; feed: { ok: boolean }; stale: boolean }
    expect(hood.tokens).toEqual([])
    expect(hood.feed.ok && !hood.stale).toBe(true)
  })

  test("fields: chain, address and symbol always come; a name the feed doesn't know is refused by name", () => {
    for (const bucket of BUCKETS) {
      const r = feedsPnl(`feed-${bucket}-fields`)
      const asked = new Set([...String(r.query.fields).split(","), "chain", "address", "symbol"])
      for (const row of r.answer.tokens as Row[]) for (const k of Object.keys(row)) expect(asked.has(k)).toBe(true)
    }
    const refused = feedsPnl("feed-new-unknown-field").answer as { error: { code: string; message: string; field: string } }
    expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", message: "Unknown field: _creationTime", field: "fields" })
    // Rows carry _creationTime, but `fields` can't ask for it: createdAt is the age.
    expect(Object.keys((feedsPnl("feed-new-all-fields").answer.tokens as Row[])[0]!)).toContain("_creationTime")
  })

  test("which figures each list carries: change1h only where the list has the hour, no holder count on most", () => {
    const share = (bucket: string, k: string) => {
      const rows = feedsPnl(`feed-${bucket}-fields`).answer.tokens as Row[]
      return rows.filter((t) => t[k] !== undefined && t[k] !== null).length / rows.length
    }
    expect(share("onfire", "change1h")).toBe(1)
    expect(share("graduated", "graduatedAt")).toBe(1)
    expect(share("finalstretch", "progress")).toBe(1)
    expect(share("new", "createdAt")).toBe(1)
    expect(share("finalstretch", "priceUsd")).toBeLessThan(1)
  })

  test("an unknown bucket is refused, and a limit over 200 is answered whole, not refused", () => {
    expect((feedsPnl("feed-unknown-bucket").answer as { error: Row }).error).toMatchObject({ code: "VALIDATION_FAILED", field: "bucket" })
    const over = feedsPnl("feed-limit-over")
    expect(over.status).toBe(200)
    expect(over.truncated?.["$.tokens"]).toBe(feedsPnl("feed-new-whole").truncated?.["$.tokens"])
  })

  test("deltas: New and On Fire came back reset after 20 s; Graduated sent changed rows and removed ids as chain:mint", () => {
    expect(feedsPnl("feed-new-delta").answer.reset).toBe(true)
    expect(feedsPnl("feed-onfire-delta").answer.reset).toBe(true)
    const grad = feedsPnl("feed-graduated-delta").answer as { reset: boolean; removed: string[] }
    expect(grad.reset).toBe(false)
    expect(grad.removed.every((r) => /^solana:\w+$/.test(r))).toBe(true)
    expect(feedsPnl("feed-finalstretch-delta").answer.reset).toBe(true)
  })
})

describe("P&L and trades", () => {
  const books = { a: feedsPnl("pnl-agent-a").answer as unknown as Book, b: feedsPnl("pnl-agent-b").answer as unknown as Book }
  const trades = { a: (feedsPnl("trades-agent-a").answer.trades as Trade[]), b: (feedsPnl("trades-agent-b").answer.trades as Trade[]) }

  test("a Read key reads any key's P&L on the account, and an unknown prefix answers an empty book, not an error", () => {
    expect(books.a.pnl.closedPositions.length).toBeGreaterThan(0)
    const unknown = feedsPnl("pnl-unknown-prefix").answer
    expect((unknown as unknown as Book).pnl.totalUsd).toBe(0)
    // Only the board and the perps record say nobody has that prefix.
    expect(unknown).not.toHaveProperty("board")
    expect(unknown.hyperliquid).toMatchObject({ read: false, code: "no_profile" })
    expect(feedsPnl("pnl-self").answer).toHaveProperty("board")
  })

  test("the P&L has no window: since is ignored", () => {
    expect(feedsPnl("pnl-agent-a-since").answer).toEqual(feedsPnl("pnl-agent-a").answer)
    // The trades route takes since on REST; the MCP tool's schema has only keyPrefix and limit.
    expect((feedsPnl("trades-agent-a-since").answer.trades as Trade[]).length).toBeLessThan(trades.a.length)
  })

  test("the shared wallet: each round sits in one book, so the books add up to what the wallet did", () => {
    const sum = (rows: Position[], f: (p: Position) => number) => rows.reduce((n, p) => n + f(p), 0)
    const key = (wallet: string, mint: string) => `${wallet} ${mint}`
    const held = new Map<string, number>()
    for (const b of [books.a, books.b]) {
      for (const p of b.pnl.closedPositions) held.set(key(p.wallet, p.mint), (held.get(key(p.wallet, p.mint)) ?? 0) + (p.soldQuantity ?? 0))
      for (const p of b.pnl.openPositions) held.set(key(p.wallet, p.mint), (held.get(key(p.wallet, p.mint)) ?? 0) + p.quantity)
    }
    const bought = new Map<string, number>()
    for (const t of [...trades.a, ...trades.b]) if (t.status === "confirmed" && t.side === "buy") bought.set(key(t.payerWallet, t.mint), (bought.get(key(t.payerWallet, t.mint)) ?? 0) + (t.filledAmount ?? 0))
    for (const [k, qty] of bought) expect(held.get(k)).toBeCloseTo(qty, 6)
    // A position no trade opened: agent-b's SOL→CNDL swap is in its book but not in its trades.
    const swapOnly = [...held.keys()].filter((k) => !bought.has(k))
    expect(swapOnly).toHaveLength(1)
    expect(sum(books.b.pnl.openPositions.filter((p) => key(p.wallet, p.mint) === swapOnly[0]), (p) => p.quantity)).toBeGreaterThan(0)
  })

  test("a round goes to one key: agent-b's book holds a round agent-a opened and both sold; agent-a's doesn't", () => {
    const [aPrefix, bPrefix] = [books.a.keyPrefix, books.b.keyPrefix]
    const crossed = books.b.pnl.closedPositions.filter((p) => p.openedBy === aPrefix)
    expect(crossed).toHaveLength(1)
    expect(crossed[0]!.agent).toBe(bPrefix)
    // Both keys' sells closed it, but only agent-b's last sell is in agent-b's trades.
    expect(books.a.pnl.closedPositions.some((p) => p.mint === crossed[0]!.mint && p.wallet === crossed[0]!.wallet && Math.abs(p.quantity - crossed[0]!.quantity) < 1e-9)).toBe(false)
    // An open position both bought into sits whole in the first buyer's book, with no openedBy.
    const merged = books.b.pnl.openPositions.find((p) => trades.a.some((t) => t.mint === p.mint && t.side === "buy" && t.status === "confirmed"))!
    expect(merged.openedBy).toBeUndefined()
    expect(books.a.pnl.openPositions.some((p) => p.mint === merged.mint)).toBe(false)
  })

  test("each book splits by the wallet that paid; trades name the wallet; the account's rows name each key by its label", () => {
    expect(books.a.pnl.byWallet.map((w) => w.payerType).sort()).toEqual(["linked", "linked", "main"])
    expect(trades.a.every((t) => typeof t.payerWallet === "string")).toBe(true)
    const all = feedsPnl("transactions").answer as { total: number; transactions: Row[] }
    expect(all.total).toBe(trades.a.length + trades.b.length)
    expect(new Set(all.transactions.map((t) => t.book))).toEqual(new Set(["agent-a", "agent-b"]))
  })

  test("the P&L carries a Hyperliquid block, and the portfolio none", () => {
    expect(feedsPnl("pnl-agent-a").answer.hyperliquid).toMatchObject({ read: true, coverage: "profile", positions: [] })
    expect(feedsPnl("portfolio").answer).not.toHaveProperty("hyperliquid")
  })
})

describe("the fake answers the lists' and P&L's reads in the real shapes", () => {
  let binDir: string
  let pool: CandleMcpPool
  let stateDir: string
  const keyA = `cndl_live_${"a".repeat(43)}`
  beforeAll(async () => {
    binDir = mkdtempSync(join(tmpdir(), "chrn-fakebin-"))
    await $`bun build --compile ${join(import.meta.dir, "../../test/fake-candle-mcp.ts")} --outfile ${join(binDir, "candle")}`.quiet()
  })
  afterAll(() => rmSync(binDir, { recursive: true, force: true }))
  afterEach(async () => {
    await pool?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })
  async function start(script: Record<string, unknown> = {}) {
    stateDir = mkdtempSync(join(tmpdir(), "chrn-recorded-feeds-pnl-"))
    const configDir = candleConfigDir(stateDir, "a")
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(configDir, "fake-candle.json"), JSON.stringify(script))
    pool = new CandleMcpPool({ route: "cli", path: join(binDir, "candle"), stateDir, parentEnv: process.env, agents: [{ name: "a", apiKey: keyA }], child: { backoffMs: [100] } })
    await pool.start()
    return (tool: string, args: Record<string, unknown>) => pool.for("a").call(tool, args)
  }
  const result = (o: ToolOutcome) => (o.kind === "ok" ? (o.result as Row) : (o as unknown as { body: Row }).body)
  const keys = (o: unknown) => Object.keys(o as object).sort()

  test("each list: the real envelope, rows in the real fields, and fields as Candle reads them", async () => {
    const call = await start()
    for (const bucket of BUCKETS) {
      const real = feedsPnl(`feed-${bucket}-all-fields`).answer
      const fake = result(await call("candle_get_feed", { bucket, chain: "solana", limit: 20 }))
      expect(keys(fake)).toEqual(keys(real))
      const realRow = (real.tokens as Row[])[0]!
      for (const k of Object.keys((fake.tokens as Row[])[0]!)) expect(Object.keys(realRow)).toContain(k)
      const asked = feedsPnl(`feed-${bucket}-fields`)
      const narrowed = result(await call("candle_get_feed", { bucket, chain: "solana", fields: asked.query.fields, limit: 20 }))
      for (const row of narrowed.tokens as Row[]) for (const k of Object.keys(row)) expect([...String(asked.query.fields).split(","), "chain", "address", "symbol"]).toContain(k)
    }
    const refused = await call("candle_get_feed", { bucket: "new", fields: "name,_creationTime" })
    expect(refused.kind).toBe("error")
    expect(JSON.stringify(refused)).toContain("Unknown field: _creationTime")
  })

  test("Final Stretch off is refused as an unknown bucket; behind, it says it's stale", async () => {
    let call = await start({ finalStretch: "off" })
    const off = await call("candle_get_feed", { bucket: "finalstretch", limit: 20 })
    expect(off.kind).toBe("error")
    expect(JSON.stringify(off)).toContain("VALIDATION_FAILED")
    await pool.stop()
    rmSync(stateDir, { recursive: true, force: true })
    call = await start({ finalStretch: "stale" })
    const stale = result(await call("candle_get_feed", { bucket: "finalstretch", limit: 20 })) as { stale: boolean; feed: { ok: boolean } }
    expect(stale.stale).toBe(true)
    expect(stale.feed.ok).toBe(false)
  })

  test("P&L: an empty book in the real shape for any prefix, a scripted book as given; trades and perps markets", async () => {
    const book = feedsPnl("pnl-agent-b").answer
    const call = await start({ pnl: { FakeKey2: book }, trades: { FakeKey2: feedsPnl("trades-agent-b").answer.trades } })
    // A key with a profile and no trades, as the Read key's own book was recorded.
    expect(keys(result(await call("candle_get_profile_pnl", { keyPrefix: "FakeKey9" })))).toEqual(keys(feedsPnl("pnl-self").answer))
    expect(result(await call("candle_get_profile_pnl", { keyPrefix: "FakeKey2" }))).toEqual(book)
    const trades = result(await call("candle_get_profile_trades", { keyPrefix: "FakeKey2", limit: 5 }))
    expect(keys(trades)).toEqual(["keyPrefix", "success", "trades"])
    expect(trades.trades as Row[]).toHaveLength(5)
    const markets = result(await call("candle_perps_markets", { limit: 2 }))
    expect(keys(markets)).toEqual(keys(feedsPnl("perps-markets-5").answer))
    expect(markets.markets as Row[]).toHaveLength(2)
  })
})
