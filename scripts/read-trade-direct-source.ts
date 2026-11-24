// Offline contracts for `candle_trade` skipping its market read when the server converts the amount (BE-3924), from
// an exact clean Candle source checkout. The registered MCP tool is called through an in-memory MCP client, and its
// requests are answered by stand-ins for Candle's API:
//   1. fast path: a buy by amount, and a paper sell by amount, send `amountDecimal` to /trade/agent/build as the
//      only request (no market read), and `resolved` is `{ amountDecimal }`;
//   2. fallback: an API that predates the field, one that can't name the asset's decimals, and one whose feed can't be
//      read, are retried through the market read under the same clientTradeId, then built with `amountRaw` and
//      `amountDecimals` as before; a chain mismatch is retried through the read, which relays its refusal;
//   3. relayed refusals: too many fraction digits, a spend cap, a graduated Hood token's settlement scale, and a
//      transport failure come back as they are, with no market read and no second build;
//   4. read paths kept: a live sell by amount reads the market, a live percent sell reads the wallet and the balance,
//      and a paper percent sell sends `percent` alone, as before.
// The stand-in build converts a decimal with Candle's own `decimalAmountToRaw` (apps/api/src/lib/decimal-amount.ts),
// and every refusal is made with the API's own `errorBody` and `statusForCode`, in words the route carries (the
// recorder checks each is in the route's source). The conversion is also run on its own, beside the MCP's own
// `decimalToRaw`, on literals it must take or refuse. The route itself, the database, the planner and the signer
// are not run. Every fetch is intercepted: nothing is sent or signed, and every address is made up.
//   bun scripts/read-trade-direct-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-trade-direct-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const ROUTE = "apps/api/src/routes/trade-agent.ts"
const FILES = ["packages/mcp/src/orchestrate.ts", "packages/mcp/src/tools.ts", "packages/mcp/src/convert.ts", "apps/api/src/lib/decimal-amount.ts", "apps/api/src/lib/launch-errors.ts", ROUTE]
git("diff", "--exit-code", "HEAD", "--", "packages/mcp", "packages/shared", ...FILES)
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: FILES,
}
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
const deny = (() => { throw new Error("trade recording may not access the network") }) as unknown as typeof fetch
globalThis.fetch = deny

const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
/** Base58 of 32 repeated bytes: a valid-looking Solana address that is no real account. */
const base58 = (bytes: Buffer) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  let n = BigInt(`0x${bytes.toString("hex")}`), out = ""
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}` }
  return out
}
const MINT = base58(Buffer.alloc(32, 7)), EMBEDDED_SOL = base58(Buffer.alloc(32, 9))
const HOOD_TOKEN = `0x${"2".repeat(40)}`, EMBEDDED_EVM = `0x${"3".repeat(40)}`
const SIGNATURE = base58(Buffer.alloc(64, 5))
const NAMES: [string, string][] = [[MINT, "<mint>"], [HOOD_TOKEN, "<hood-token>"], [EMBEDDED_SOL, "<embedded-sol>"], [EMBEDDED_EVM, "<embedded-evm>"], [SIGNATURE, "<signature>"]]
const named = (text: string) => NAMES.reduce((t, [from, to]) => t.split(from).join(to), text)
/** The made-up Solana token's scale, its quote asset's (SOL), and the Hood token's quote asset's (USDG). */
const TOKEN_DECIMALS = 6, QUOTE_DECIMALS = 9, HOOD_QUOTE_DECIMALS = 6
const BALANCE_RAW = "5000000"

type Request = { n: number; method: string; path: string; key: boolean; client: string | null; body?: Record<string, unknown> }
type Row = { id: string; scenario: string; surface: string; says: string; evidence?: string; args?: Record<string, unknown>; world?: Record<string, unknown>; requests?: Request[]; reply?: { isError: boolean; text: string }; outcome?: unknown }
const rows: Row[] = []

try {
  const { createCandleMcpServer } = await load("packages/mcp/src/server.ts")
  const { decimalAmountToRaw } = await load("apps/api/src/lib/decimal-amount.ts")
  const { decimalToRaw } = await load("packages/mcp/src/convert.ts")
  const { errorBody, statusForCode } = await load("apps/api/src/lib/launch-errors.ts")
  const routeText = readFileSync(join(checkout, ROUTE), "utf8")
  const marketsText = readFileSync(join(checkout, "apps/api/src/routes/markets.ts"), "utf8")

  /** A refusal in the API's own envelope and status. `words` are fragments the route's source must carry. */
  type Refusal = { code: string; message: string; opts?: Record<string, unknown>; words: string[]; file?: string }
  const usedWords: { file: string; words: string[] }[] = []
  const refusal = (r: Refusal) => {
    const file = r.file ?? ROUTE
    const text = file === ROUTE ? routeText : marketsText
    for (const w of r.words) assert.ok(text.includes(w), `${file} no longer says ${JSON.stringify(w)}`)
    usedWords.push({ file, words: r.words })
    return { status: statusForCode(r.code) as number, body: errorBody(r.code, r.message, r.opts ?? {}) }
  }
  const OLD_API = refusal({ code: "VALIDATION_FAILED", message: "amountRaw is required (or percent on a paper sell)", opts: { field: "amountRaw" }, words: ['"amountRaw is required (or percent on a paper sell)", { field: "amountRaw" }'] })
  const NO_DECIMALS = refusal({ code: "QUOTE_UNAVAILABLE", message: "The quote asset's decimals could not be read to convert amountDecimal; retry later", opts: { field: "amountDecimal", retryable: true }, words: ["decimals could not be read to ${", '"convert amountDecimal"', "{ field: sizedField, retryable: true }"] })
  const FEED_DOWN = refusal({ code: "QUOTE_UNAVAILABLE", message: "The mint's chain could not be checked against the feed to convert amountDecimal; retry later", opts: { field: "amountDecimal", retryable: true }, words: ["The mint's chain could not be checked against the feed to convert amountDecimal; retry later", '{ field: "amountDecimal", retryable: true }'] })
  const CHAIN_MISMATCH = refusal({ code: "VALIDATION_FAILED", message: "chain_mismatch: this mint is indexed on a different chain", opts: { field: "amountDecimal" }, words: ['"chain_mismatch: this mint is indexed on a different chain"'] })
  const HOOD_SCALE = refusal({
    code: "VALIDATION_FAILED",
    message: "This buy settles in usdg (6 decimals), not at the 18 decimals the amount was read at. Send amountRaw in usdg's raw units, or name the quoteAsset the token trades against.",
    opts: { field: "amountDecimal", stage: "not_broadcast", retryable: false },
    words: ["`This buy settles in ${plan.quoteAsset} (${plan.quoteDecimals} decimals), not at the ${sizedScale} decimals the amount was read at.", "{ field, stage: \"not_broadcast\", retryable: false }"],
  })
  // A spend cap's own words come from the limit check, not this route; the stand-in carries its code and field only.
  const SPEND_CAP = { status: statusForCode("SPEND_LIMIT_EXCEEDED") as number, body: errorBody("SPEND_LIMIT_EXCEEDED", "Over this key's per-trade spend cap (stand-in words)", {}) }
  const MARKET_CHAIN_MISMATCH = refusal({
    code: "MARKET_NOT_FOUND", message: "No market for this mint on solana (stand-in words); it is indexed on hood",
    opts: { routing: { reason: "chain_mismatch" }, discovery: { chain: "hood" }, docsPath: "developers/market-state" },
    words: ['new MarketNotFoundError("chain_mismatch"', "routing: { reason: error.reason }", 'docsPath: "developers/market-state"'], file: "apps/api/src/routes/markets.ts",
  })

  type World = {
    /** The build route: today's (converts a decimal), or one that predates `amountDecimal` and ignores it. */
    api?: "current" | "old"
    /** The current route's refusal of a decimal build before it converts. */
    decimalRefusal?: { status: number; body: unknown }
    /** A refusal of the build after its amount is known, decimal or raw. */
    buildRefusal?: { status: number; body: unknown }
    market?: "candle" | "chain-mismatch"
    buildThrows?: boolean
    hideEcho?: boolean
  }
  const describe = (w: World) => ({
    api: w.api ?? "current",
    ...(w.decimalRefusal ? { decimalRefusal: (w.decimalRefusal.body as any).error.code } : {}),
    ...(w.buildRefusal ? { buildRefusal: (w.buildRefusal.body as any).error.code } : {}),
    market: w.market ?? "candle",
    ...(w.buildThrows ? { buildThrows: true } : {}),
  })

  /** A stand-in for Candle's API: every request is noted, and each path answers what the world says. */
  const serve = (world: World, requests: Request[]) => (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof globalThis.Request ? input.url : input))
    assert.equal(url.origin, cfg.apiUrl, `unexpected host: ${url}`)
    const headers = new Headers(init?.headers)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ n: requests.length + 1, method, path: named(url.pathname), key: headers.has("x-api-key"), client: headers.get("x-candle-client"), ...(body ? { body: JSON.parse(named(JSON.stringify(body))) } : {}) })
    const json = (status: number, value: unknown) => Response.json(value, { status })
    const path = url.pathname
    if (method === "POST" && path === "/api/v1/trade/agent/build") {
      if (world.buildThrows) throw new TypeError("fetch failed (stand-in: the connection dropped)")
      let amountRaw: string | undefined = body.amountRaw
      if (body.amountDecimal !== undefined) {
        if ((world.api ?? "current") === "old") return json(OLD_API.status, OLD_API.body)
        if (world.decimalRefusal) return json(world.decimalRefusal.status, world.decimalRefusal.body)
        // Candle's own conversion, at the scale the route trusts: a sell in the token's, a buy in its quote asset's.
        const converted = decimalAmountToRaw(body.amountDecimal, body.side === "sell" ? TOKEN_DECIMALS : body.mint === HOOD_TOKEN ? HOOD_QUOTE_DECIMALS : QUOTE_DECIMALS)
        if (!converted.ok) {
          const r = refusal({ code: "VALIDATION_FAILED", message: converted.message, opts: { field: "amountDecimal" }, words: ['if (!converted.ok) return fail(c, "VALIDATION_FAILED", converted.message, { field: "amountDecimal" })'] })
          return json(r.status, r.body)
        }
        amountRaw = converted.raw
      }
      if (world.buildRefusal) return json(world.buildRefusal.status, world.buildRefusal.body)
      return json(200, {
        success: true, clientTradeId: body.clientTradeId, side: body.side,
        ...(body.paper ? { status: "paper", paper: true } : { status: "executed", signature: SIGNATURE }),
        ...(amountRaw !== undefined ? { amountRaw } : { percent: body.percent }),
        ...(body.hide === true && world.hideEcho !== false ? { hide: true } : {}),
      })
    }
    if (method === "GET" && path.startsWith("/api/v1/markets/")) {
      if (world.market === "chain-mismatch") return json(MARKET_CHAIN_MISMATCH.status, MARKET_CHAIN_MISMATCH.body)
      return json(200, { success: true, market: { chain: "solana", mint: MINT, candleLaunched: true, decimals: TOKEN_DECIMALS, quoteDecimals: QUOTE_DECIMALS } })
    }
    if (method === "GET" && path === "/api/v1/agent/wallets/embedded") return json(200, { success: true, wallets: { solana: { address: EMBEDDED_SOL }, evm: { address: EMBEDDED_EVM } } })
    if (method === "GET" && path === `/api/v1/tokens/${MINT}/balance/${EMBEDDED_SOL}`) return json(200, { payload: { balance: BALANCE_RAW } })
    if (method === "GET" && path === "/api/v1/trade/agent/paper/inventory") return json(200, { positions: [] })
    throw new Error(`unexpected request ${method} ${path}`)
  }) as unknown as typeof fetch

  /** One call of the registered tool, through an in-memory MCP client, against a stand-in world. */
  async function trade(args: Record<string, unknown>, world: World = {}) {
    const requests: Request[] = []
    globalThis.fetch = serve(world, requests)
    const server = createCandleMcpServer({}, cfg)
    const client = new Client({ name: "harness-trade-direct-recorder", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b); await client.connect(a)
    try {
      const r: any = await client.callTool({ name: "candle_trade", arguments: args })
      assert.equal(r.content.length, 1)
      const text: string = r.content[0].text
      return { requests, isError: r.isError === true, text, body: JSON.parse(text) }
    } finally { await client.close(); await server.close(); globalThis.fetch = deny }
  }
  const record = (id: string, scenario: string, says: string, args: Record<string, unknown>, world: World, r: Awaited<ReturnType<typeof trade>>, evidence?: string) =>
    rows.push({ id, scenario, surface: "mcp", says, ...(evidence ? { evidence } : {}), args: JSON.parse(named(JSON.stringify(args))), world: describe(world), requests: r.requests, reply: { isError: r.isError, text: named(r.text) } })
  const builds = (r: { requests: Request[] }) => r.requests.filter((q) => q.path === "/api/v1/trade/agent/build")
  const marketReads = (r: { requests: Request[] }) => r.requests.filter((q) => q.path.startsWith("/api/v1/markets/"))

  // 1. Fast path: one request, the decimal as given, no market read.
  const fast: [string, string, Record<string, unknown>, string][] = [
    ["fast-buy", "A live buy by amount: one build with amountDecimal, no market read; the server converts 0.5 at the quote asset's 9 decimals.", { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-fast-buy" }, "500000000"],
    ["fast-buy-paper", "A paper buy by amount: the same one build, marked paper.", { mint: MINT, side: "buy", amount: "0.5", paper: true, clientTradeId: "trade-fast-buy-paper" }, "500000000"],
    ["fast-sell-paper", "A paper sell by amount: one build with amountDecimal, converted at the token's 6 decimals; the paper book is not read.", { mint: MINT, side: "sell", amount: "2.5", paper: true, clientTradeId: "trade-fast-sell-paper" }, "2500000"],
    ["fast-buy-hide", "A hidden buy by amount: the same one build, hide sent and echoed.", { mint: MINT, side: "buy", amount: "0.5", hide: true, clientTradeId: "trade-fast-buy-hide" }, "500000000"],
    ["fast-buy-hood", "A buy of a Hood token by amount: one build with amountDecimal and no market read, converted at USDG's 6 decimals, so the MCP no longer reads the token's market to size it.", { mint: HOOD_TOKEN, side: "buy", amount: "10", quoteAsset: "usdg", clientTradeId: "trade-fast-buy-hood" }, "10000000"],
  ]
  for (const [id, says, args, raw] of fast) {
    const r = await trade(args)
    assert.equal(r.isError, false, r.text)
    assert.equal(r.requests.length, 1)
    assert.equal(marketReads(r).length, 0)
    const sent = builds(r)[0]!.body!
    assert.equal(sent.amountDecimal, args.amount)
    assert.ok(!("amountRaw" in sent) && !("amountDecimals" in sent))
    assert.deepEqual(r.body.resolved, { amountDecimal: args.amount })
    assert.equal(r.body.api.amountRaw, raw)
    record(id, "fast-path", says, args, {}, r, "stand-in build: Candle's decimalAmountToRaw converts the decimal at the made-up asset's scale")
  }

  // 2. Fallback through the market read, under the same id.
  {
    const fallback: [string, string, Record<string, unknown>, World, number, string][] = [
      ["fallback-old-api", "An API that predates amountDecimal ignores it and asks for amountRaw: the MCP reads the market and builds again with amountRaw and amountDecimals, same clientTradeId.", { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-old-api" }, { api: "old" }, QUOTE_DECIMALS, "500000000"],
      ["fallback-no-decimals", "The server can't name the quote asset's decimals (QUOTE_UNAVAILABLE on amountDecimal, retryable): retried through the market read, same id.", { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-no-decimals" }, { decimalRefusal: NO_DECIMALS }, QUOTE_DECIMALS, "500000000"],
      ["fallback-feed-down", "The server can't check the mint's chain against the feed (QUOTE_UNAVAILABLE on amountDecimal, retryable): retried through the market read, which decides.", { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-feed-down" }, { decimalRefusal: FEED_DOWN }, QUOTE_DECIMALS, "500000000"],
      ["fallback-old-api-paper-sell", "A paper sell by amount on an API that predates amountDecimal: the market read gives the token's 6 decimals, and the second build is paper with amountRaw.", { mint: MINT, side: "sell", amount: "2.5", paper: true, clientTradeId: "trade-old-api-sell" }, { api: "old" }, TOKEN_DECIMALS, "2500000"],
    ]
    for (const [id, says, args, world, decimals, raw] of fallback) {
      const r = await trade(args, world)
      assert.equal(r.isError, false, r.text)
      assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), ["POST /api/v1/trade/agent/build", "GET /api/v1/markets/solana/<mint>", "POST /api/v1/trade/agent/build"])
      const [first, second] = builds(r).map((q) => q.body!)
      assert.equal(first!.clientTradeId, args.clientTradeId)
      assert.equal(second!.clientTradeId, args.clientTradeId)
      assert.equal(first!.amountDecimal, args.amount)
      assert.equal(second!.amountRaw, raw)
      assert.equal(second!.amountDecimals, decimals)
      assert.ok(!("amountDecimal" in second!))
      assert.deepEqual(r.body.resolved, { amountDecimal: args.amount, decimals, amountRaw: raw })
      record(id, "fallback", says, args, world, r)
    }
    const args = { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-chain-mismatch" }
    const world: World = { decimalRefusal: CHAIN_MISMATCH, market: "chain-mismatch" }
    const r = await trade(args, world)
    assert.equal(r.isError, true)
    assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), ["POST /api/v1/trade/agent/build", "GET /api/v1/markets/solana/<mint>"])
    assert.equal(r.body.clientTradeId, args.clientTradeId)
    assert.equal(r.body.api.error.code, "MARKET_NOT_FOUND")
    assert.equal(r.body.api.error.routing.reason, "chain_mismatch")
    record("fallback-chain-mismatch", "fallback", "A mint indexed on another chain: the build refuses on the chain_mismatch: prefix, the MCP retries through the market read, and relays the read's MARKET_NOT_FOUND with its discovery hint. Nothing is built twice.", args, world, r,
      "stand-in market refusal in the API's errorBody envelope, with the route's reason and docs path")
  }

  // 3. Refusals relayed as they are: no market read, no second build.
  {
    const relayed: [string, string, Record<string, unknown>, World, string][] = [
      ["relayed-buy-precision", "A buy with more fraction digits than the quote asset's 9: Candle's conversion refuses it (VALIDATION_FAILED on amountDecimal), and nothing is truncated.", { mint: MINT, side: "buy", amount: "0.1234567891", clientTradeId: "trade-precision-buy" }, {}, "VALIDATION_FAILED"],
      ["relayed-sell-precision", "A paper sell with more fraction digits than the token's 6: refused by the server's conversion, relayed.", { mint: MINT, side: "sell", amount: "1.1234567", paper: true, clientTradeId: "trade-precision-sell" }, {}, "VALIDATION_FAILED"],
      ["relayed-spend-cap", "A buy over the key's spend cap: the server converts, then refuses; relayed, no read.", { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-spend-cap" }, { buildRefusal: SPEND_CAP }, "SPEND_LIMIT_EXCEEDED"],
      ["relayed-hood-scale", "A graduated Hood token's buy that would settle at another scale than the amount was read at: refused before anything is planned or signed (stage not_broadcast), relayed.", { mint: HOOD_TOKEN, side: "buy", amount: "10", clientTradeId: "trade-hood-scale" }, { decimalRefusal: HOOD_SCALE }, "VALIDATION_FAILED"],
    ]
    for (const [id, says, args, world, code] of relayed) {
      const r = await trade(args, world)
      assert.equal(r.isError, true)
      assert.equal(r.requests.length, 1, id)
      assert.equal(r.body.clientTradeId, args.clientTradeId)
      assert.deepEqual(r.body.resolved, { amountDecimal: args.amount })
      assert.equal(r.body.api.error.code, code)
      record(id, "relayed", says, args, world, r, id === "relayed-spend-cap" ? "stand-in refusal: the code is the API's, the words are not" : undefined)
    }
    const args = { mint: MINT, side: "buy", amount: "0.5", clientTradeId: "trade-transport" }
    const world: World = { buildThrows: true }
    const r = await trade(args, world)
    assert.equal(r.isError, true)
    assert.equal(r.requests.length, 1)
    assert.equal(r.body.error.code, "MCP_TRANSPORT")
    assert.equal(r.body.clientTradeId, args.clientTradeId)
    record("relayed-transport", "relayed", "The build fails in transit: MCP_TRANSPORT with the same clientTradeId, retryable, and no market read or second build behind it.", args, world, r)
  }

  // 4. The read paths that stay.
  {
    const live = { mint: MINT, side: "sell", amount: "2.5", clientTradeId: "trade-live-sell" }
    const a = await trade(live)
    assert.deepEqual(a.requests.map((q) => `${q.method} ${q.path}`), ["GET /api/v1/markets/solana/<mint>", "POST /api/v1/trade/agent/build"])
    assert.deepEqual(builds(a)[0]!.body!.amountRaw, "2500000")
    assert.equal(builds(a)[0]!.body!.amountDecimals, TOKEN_DECIMALS)
    record("read-live-sell-amount", "read-path", "A live sell by amount still reads the market (a mint with no Candle market falls back to the paper book, which only the read can tell), then builds with amountRaw and amountDecimals.", live, {}, a)
    const pct = { mint: MINT, side: "sell", percent: 50, clientTradeId: "trade-live-percent" }
    const b = await trade(pct)
    assert.deepEqual(b.requests.map((q) => `${q.method} ${q.path}`), ["GET /api/v1/agent/wallets/embedded", "GET /api/v1/tokens/<mint>/balance/<embedded-sol>", "POST /api/v1/trade/agent/build"])
    assert.equal(builds(b)[0]!.body!.amountRaw, "2500000")
    record("read-live-sell-percent", "read-path", "A live percent sell still reads the embedded wallet and its balance, then builds 50% of it as amountRaw.", pct, {}, b)
    const paperPct = { mint: MINT, side: "sell", percent: 100, paper: true, clientTradeId: "trade-paper-percent" }
    const c = await trade(paperPct)
    assert.equal(c.requests.length, 1)
    assert.equal(builds(c)[0]!.body!.percent, 100)
    record("read-paper-sell-percent", "read-path", "A paper percent sell sends percent alone, sized by the paper book on the server, as before.", paperPct, {}, c)
    const both = { mint: MINT, side: "buy", amount: "0.5", percent: 50, clientTradeId: "trade-local" }
    const d = await trade(both)
    assert.equal(d.requests.length, 0)
    assert.equal(d.body.error.code, "MCP_VALIDATION")
    record("local-amount-and-percent", "local", "Both amount and percent: refused by the MCP before any request, as before.", both, {}, d)
  }

  // 5. Candle's conversion beside the MCP's own, on literals each must take or refuse.
  {
    const literals: [string, number][] = [["0.5", 9], ["2.5", 6], ["1", 6], ["0.000001", 6], ["10", 18], ["1.1234567", 6], ["0.1234567891", 9], ["0", 6], ["0.000", 6], ["1e3", 6], ["-1", 6], [".5", 6], ["5.", 6], [" 1", 6], ["1,5", 6], ["9".repeat(81), 6]]
    const mcpSays = (amount: string, decimals: number) => { try { return { raw: decimalToRaw(amount, decimals) } } catch (e) { return { refused: (e as Error).message } } }
    const apiSays = (amount: string, decimals: number) => { const r = decimalAmountToRaw(amount, decimals); return r.ok ? { raw: r.raw } : { refused: r.message } }
    const table = literals.map(([amount, decimals]) => {
      const api = apiSays(amount, decimals), mcp = mcpSays(amount, decimals)
      return { amount: amount.length > 20 ? `<${amount.length} nines>` : amount, decimals, api, mcp, agree: JSON.stringify("raw" in api ? api.raw : null) === JSON.stringify("raw" in mcp ? mcp.raw : null) }
    })
    rows.push({ id: "conversion-table", scenario: "conversion", surface: "api-source", says: "Candle's decimalAmountToRaw, the server's conversion, beside the MCP's own decimalToRaw it replaces on the fast path: the raw each gives, or its refusal.", evidence: "pure functions from apps/api/src/lib/decimal-amount.ts and packages/mcp/src/convert.ts", outcome: { rows: table } })
  }

  // 6. The route's words the stand-ins carry, found in its source.
  rows.push({ id: "route-words", scenario: "source-text", surface: "source-text", says: "Each refusal a stand-in answers is made with the API's errorBody, and these fragments of it are in the route's source at this commit.", outcome: { found: usedWords.filter((u, i, all) => all.findIndex((v) => JSON.stringify(v) === JSON.stringify(u)) === i) } })

  const text = JSON.stringify(rows)
  for (const secret of [cfg.apiKey, MINT, HOOD_TOKEN, EMBEDDED_SOL, EMBEDDED_EVM, SIGNATURE]) assert.ok(!text.includes(secret), `a row carries ${secret.slice(0, 8)}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-trade-direct-source.json"), `${JSON.stringify({
    about: "Offline contracts for candle_trade skipping its market read when the server converts the amount (BE-3924), from exact source. mcp rows call the registered candle_trade tool through an in-memory MCP client; its requests are answered by stand-ins for Candle's API. The stand-in build converts amountDecimal with Candle's own decimalAmountToRaw at a made-up asset's scale (a sell in the token's 6 decimals, a buy in the quote asset's 9), and every refusal is the API's own errorBody and status, in words the route-words row finds in the route's source (a spend cap's words are a stand-in). api-source rows run the server's conversion beside the MCP's own decimalToRaw. The route, the database, the planner and the signer are not run; every fetch is intercepted, nothing is signed, and every address and signature is made up.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline candle_trade contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch }
