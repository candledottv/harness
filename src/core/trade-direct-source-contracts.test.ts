// candle_trade skipping its market read when Candle's server converts the amount (BE-3924), as Candle's MCP server
// runs it. Recorded offline from one exact commit (scripts/read-trade-direct-source.ts): the registered tool is
// called through an in-memory MCP client against stand-ins for the API, whose build converts with Candle's own
// decimalAmountToRaw and refuses with the API's own errorBody. The commit is 5d7a861a8 (#4232 on staging), the
// gitHead npm records for the published CLI 0.13.47, MCP 0.10.45 and SDK 0.6.39 (2026-11-24). BE-3924 merged
// at #3988 (1774b96b4); its MCP source is unchanged between the two, and every row recorded there reads the same here.
//
// Each recorded reply is read the way the Candle Harness reads a live one: toOutcome, then outcomeOf for a trade.
// Every code the Candle Harness can meet here is one it maps to a settled state; none is UNKNOWN_ERROR.
import { describe, expect, test } from "bun:test"
import recorded from "../../test/fixtures/candle-trade-direct-source.json"
import { toOutcome } from "./candle-mcp"
import { outcomeOf } from "./execute"
import { requestsOf } from "./key-budget"

type Request = { n: number; method: string; path: string; key: boolean; client: string | null; body?: Record<string, any> }
type Row = { id: string; scenario: string; surface: string; says: string; evidence?: string; args?: Record<string, any>; world?: Record<string, any>; requests?: Request[]; reply?: { isError: boolean; text: string }; outcome?: any }
const rows = recorded.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const mcpRows = rows.filter((r) => r.surface === "mcp")
const BUILD = "/api/v1/trade/agent/build"
const MARKET = "/api/v1/markets/solana/<mint>"
const shape = (r: Row) => r.requests!.map((q) => `${q.method} ${q.path}`)
const builds = (r: Row) => r.requests!.filter((q) => q.path === BUILD).map((q) => q.body!)
const body = (r: Row) => JSON.parse(r.reply!.text)
/** The reply as the Candle Harness's MCP client would hand it on, then as an operation's state. */
const reading = (r: Row) => {
  const outcome = toOutcome({ content: [{ type: "text", text: r.reply!.text }], ...(r.reply!.isError ? { isError: true } : {}) })
  return { outcome, mapped: outcomeOf("trade", outcome) }
}

test("the recording names the published release commit, MCP 0.10.45, and the files the change is in", () => {
  expect(recorded.source).toEqual({
    repo: "candledottv/candle-monorepo",
    commit: "5d7a861a83bcc5c4f2c3dace9897c325b3525e43",
    versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" },
    files: ["packages/mcp/src/orchestrate.ts", "packages/mcp/src/tools.ts", "packages/mcp/src/convert.ts", "apps/api/src/lib/decimal-amount.ts", "apps/api/src/lib/launch-errors.ts", "apps/api/src/routes/trade-agent.ts"],
  })
  expect(rows).toHaveLength(21)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["fast-path", "fallback", "relayed", "read-path", "local", "conversion", "source-text"]))
})

test("nothing in the recording is a key, an address or a signature, and every request names the MCP client", () => {
  const text = JSON.stringify(recorded)
  expect(text).not.toContain("fixture-only-not-a-key")
  expect(/0x[0-9a-f]{40}(?![0-9a-f])/i.test(text)).toBe(false)
  // No base58 run long enough to be a Solana address or signature, past the source commit and the MCP's 81 nines.
  const runs = text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []
  expect(runs.filter((s) => s !== recorded.source.commit && !/^9+$/.test(s))).toEqual([])
  for (const r of mcpRows) for (const q of r.requests!) expect(q.client).toBe(`mcp/${recorded.source.versions.mcp}`)
  // The key rides on the build and the wallet read; the market and balance reads are public and send none.
  for (const r of mcpRows) for (const q of r.requests!) expect(q.key).toBe(q.path === BUILD || q.path === "/api/v1/agent/wallets/embedded")
})

describe("the fast path: one build, the decimal as given, no market read", () => {
  const fast = scenario("fast-path")
  test("five rows: a live buy, a paper buy, a paper sell, a hidden buy and a Hood buy", () => {
    expect(fast.map((r) => r.id)).toEqual(["fast-buy", "fast-buy-paper", "fast-sell-paper", "fast-buy-hide", "fast-buy-hood"])
  })
  test.each(fast.map((r) => [r.id, r] as const))("%s", (_id, r) => {
    expect(shape(r)).toEqual([`POST ${BUILD}`])
    const [sent] = builds(r)
    expect(sent!.amountDecimal).toBe(r.args!.amount)
    expect(sent!.clientTradeId).toBe(r.args!.clientTradeId)
    expect(sent!.payer).toEqual({ type: "main" })
    // Nothing the MCP sized itself rides along: the server converts with its own decimals.
    expect(sent).not.toHaveProperty("amountRaw")
    expect(sent).not.toHaveProperty("amountDecimals")
    expect(Boolean(sent!.paper)).toBe(r.args!.paper === true)
    expect(body(r)).toMatchObject({ clientTradeId: r.args!.clientTradeId, resolved: { amountDecimal: r.args!.amount } })
    expect(Object.keys(body(r).resolved)).toEqual(["amountDecimal"])
    expect(r.reply!.isError).toBe(false)
  })
  test("the server's conversion gives the raw amount the MCP's own read gave before, for the same decimal", () => {
    expect(body(row("fast-buy")).api.amountRaw).toBe("500000000")
    expect(body(row("fast-buy")).api.amountRaw).toBe(builds(row("fallback-old-api"))[1]!.amountRaw)
    expect(body(row("fast-sell-paper")).api.amountRaw).toBe("2500000")
    expect(body(row("fast-sell-paper")).api.amountRaw).toBe(builds(row("fallback-old-api-paper-sell"))[1]!.amountRaw)
    // A Hood buy is sized at its quote asset's 6 decimals (USDG) by the server, not by a market read.
    expect(body(row("fast-buy-hood")).api.amountRaw).toBe("10000000")
    expect(builds(row("fast-buy-hood"))[0]!.quoteAsset).toBe("usdg")
  })
  test("hide rides the one build and is echoed", () => {
    expect(builds(row("fast-buy-hide"))[0]!.hide).toBe(true)
    expect(body(row("fast-buy-hide")).api.hide).toBe(true)
  })
  test("the Candle Harness reads each as a trade that went through, a paper one as paper", () => {
    for (const r of fast) {
      const { outcome, mapped } = reading(r)
      expect(outcome.kind).toBe("ok")
      expect(mapped.state).toBe("succeeded")
      expect(Boolean(mapped.paper)).toBe(r.args!.paper === true)
    }
  })
})

describe("the fallback through the market read, under the same id", () => {
  const ok = ["fallback-old-api", "fallback-no-decimals", "fallback-feed-down", "fallback-old-api-paper-sell"]
  test.each(ok.map((id) => [id] as const))("%s: build, market read, build again with amountRaw", (id) => {
    const r = row(id)
    expect(shape(r)).toEqual([`POST ${BUILD}`, `GET ${MARKET}`, `POST ${BUILD}`])
    const [first, second] = builds(r)
    expect(first!.clientTradeId).toBe(r.args!.clientTradeId)
    expect(second!.clientTradeId).toBe(r.args!.clientTradeId)
    expect(first!.amountDecimal).toBe(r.args!.amount)
    expect(second).not.toHaveProperty("amountDecimal")
    const decimals = r.args!.side === "sell" ? 6 : 9
    expect(second!.amountDecimals).toBe(decimals)
    expect(body(r).resolved).toEqual({ amountDecimal: r.args!.amount, decimals, amountRaw: second!.amountRaw })
    expect(Boolean(second!.paper)).toBe(r.args!.paper === true)
    expect(reading(r).mapped.state).toBe("succeeded")
  })
  test("only an API that predates the field, or a QUOTE_UNAVAILABLE on amountDecimal, is retried", () => {
    expect(row("fallback-old-api").world).toMatchObject({ api: "old" })
    expect(row("fallback-no-decimals").world).toMatchObject({ decimalRefusal: "QUOTE_UNAVAILABLE" })
    expect(row("fallback-feed-down").world).toMatchObject({ decimalRefusal: "QUOTE_UNAVAILABLE" })
  })
  test("a chain mismatch is retried through the read, which relays its refusal; nothing is built twice", () => {
    const r = row("fallback-chain-mismatch")
    expect(shape(r)).toEqual([`POST ${BUILD}`, `GET ${MARKET}`])
    expect(body(r)).toMatchObject({ clientTradeId: "trade-chain-mismatch", success: false, api: { error: { code: "MARKET_NOT_FOUND", routing: { reason: "chain_mismatch" }, discovery: { chain: "hood" } } } })
    const { outcome, mapped } = reading(r)
    expect(outcome).toMatchObject({ kind: "error", code: "MARKET_NOT_FOUND", retryable: false })
    expect(mapped.state).toBe("refused")
  })
  test("the retryable QUOTE_UNAVAILABLE the fallback answers never reaches the Candle Harness", () => {
    // Retryable with no stage, the Candle Harness would read it as maybe sent; the MCP answers it itself.
    for (const r of mcpRows) expect(r.reply!.text).not.toContain("QUOTE_UNAVAILABLE")
  })
})

describe("refusals relayed as they are", () => {
  const relayed = scenario("relayed")
  test("one request each, no market read, no second build", () => {
    expect(relayed.map((r) => r.id)).toEqual(["relayed-buy-precision", "relayed-sell-precision", "relayed-spend-cap", "relayed-hood-scale", "relayed-transport"])
    for (const r of relayed) {
      expect(shape(r)).toEqual([`POST ${BUILD}`])
      expect(body(r).clientTradeId).toBe(r.args!.clientTradeId)
      expect(r.reply!.isError).toBe(true)
    }
  })
  test("too many fraction digits is the server's refusal on amountDecimal, and nothing is truncated", () => {
    expect(body(row("relayed-buy-precision")).api.error).toMatchObject({ code: "VALIDATION_FAILED", field: "amountDecimal", message: 'amountDecimal "0.1234567891" has more fraction digits than the asset\'s 9 decimals' })
    expect(body(row("relayed-sell-precision")).api.error).toMatchObject({ code: "VALIDATION_FAILED", field: "amountDecimal", message: 'amountDecimal "1.1234567" has more fraction digits than the asset\'s 6 decimals' })
  })
  test("a graduated Hood token's settlement scale is refused before anything is sent", () => {
    expect(body(row("relayed-hood-scale")).api.error).toMatchObject({ code: "VALIDATION_FAILED", field: "amountDecimal", stage: "not_broadcast", retryable: false })
  })
  test("each refusal is one the Candle Harness maps as refused, nothing sent", () => {
    for (const id of ["relayed-buy-precision", "relayed-sell-precision", "relayed-spend-cap", "relayed-hood-scale"]) {
      const { outcome, mapped } = reading(row(id))
      expect(outcome.kind).toBe("error")
      expect(mapped.state).toBe("refused")
    }
    expect(reading(row("relayed-spend-cap")).mapped.error).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED", message: "Over this key's per-trade spend cap on Candle. Nothing was sent; a smaller amount can go." })
  })
  test("a transport failure keeps its id and is lost to the Candle Harness, never retried under a new one", () => {
    const r = row("relayed-transport")
    expect(body(r)).toMatchObject({ clientTradeId: "trade-transport", error: { code: "MCP_TRANSPORT", retryable: true } })
    expect(body(r).error.message).toContain('Retry with THIS SAME clientTradeId ("trade-transport")')
    const { outcome, mapped } = reading(r)
    expect(outcome).toMatchObject({ kind: "lost", reason: "transport" })
    expect(mapped.state).toBe("unknown")
  })
})

describe("the read paths that stay", () => {
  test("a live sell by amount reads the market, then builds with amountRaw and amountDecimals", () => {
    const r = row("read-live-sell-amount")
    expect(shape(r)).toEqual([`GET ${MARKET}`, `POST ${BUILD}`])
    expect(builds(r)[0]).toMatchObject({ amountRaw: "2500000", amountDecimals: 6 })
    expect(builds(r)[0]).not.toHaveProperty("amountDecimal")
  })
  test("a live percent sell reads the wallet and its balance", () => {
    const r = row("read-live-sell-percent")
    expect(shape(r)).toEqual(["GET /api/v1/agent/wallets/embedded", "GET /api/v1/tokens/<mint>/balance/<embedded-sol>", `POST ${BUILD}`])
    expect(builds(r)[0]).toMatchObject({ amountRaw: "2500000" })
    expect(body(r).resolved).toEqual({ percent: 50, balanceRaw: "5000000", amountRaw: "2500000" })
  })
  test("a paper percent sell sends percent alone", () => {
    const r = row("read-paper-sell-percent")
    expect(shape(r)).toEqual([`POST ${BUILD}`])
    expect(builds(r)[0]).toMatchObject({ percent: 100, paper: true })
    expect(builds(r)[0]).not.toHaveProperty("amountDecimal")
  })
  test("both amount and percent is refused by the MCP before any request", () => {
    const r = row("local-amount-and-percent")
    expect(r.requests).toEqual([])
    expect(reading(r).mapped.state).toBe("refused")
  })
})

test("no call makes more of Candle's requests than the key budget counts for a trade", () => {
  for (const r of mcpRows) expect(r.requests!.length).toBeLessThanOrEqual(requestsOf("candle_trade"))
  // The fast path is the one-request case the budget overcounts.
  for (const r of scenario("fast-path")) expect(r.requests!.length).toBe(1)
})

test("every code the Candle Harness meets is one it maps to a settled state", () => {
  const codes = new Set<string>()
  for (const r of mcpRows) {
    const { outcome, mapped } = reading(r)
    if (outcome.kind === "error") {
      codes.add(outcome.code)
      expect(mapped.state).toBe("refused")
    }
  }
  expect([...codes].sort()).toEqual(["MARKET_NOT_FOUND", "MCP_VALIDATION", "SPEND_LIMIT_EXCEEDED", "VALIDATION_FAILED"])
  expect(JSON.stringify(recorded)).not.toContain("UNKNOWN_ERROR")
})

test("the server's conversion agrees with the MCP's own on every literal but one longer than its 80-character bound", () => {
  const table = row("conversion-table").outcome.rows as { amount: string; decimals: number; api: { raw?: string; refused?: string }; mcp: { raw?: string; refused?: string }; agree: boolean }[]
  expect(table).toHaveLength(16)
  expect(table.filter((t) => !t.agree).map((t) => t.amount)).toEqual(["<81 nines>"])
  // Over the bound, the server refuses what the MCP would have converted: stricter, never looser.
  expect(table.find((t) => t.amount === "<81 nines>")!.api.refused).toBe('amountDecimal must be a plain positive decimal string, such as "1.5"')
  const raw = (amount: string, decimals: number) => table.find((t) => t.amount === amount && t.decimals === decimals)!.api.raw
  expect(raw("0.5", 9)).toBe("500000000")
  expect(raw("0.000001", 6)).toBe("1")
  expect(raw("10", 18)).toBe("10000000000000000000")
  for (const literal of ["1.1234567", "0", "0.000", "1e3", "-1", ".5", "5.", " 1", "1,5"]) {
    const t = table.find((x) => x.amount === literal)!
    expect(t.api.raw).toBeUndefined()
    expect(t.mcp.raw).toBeUndefined()
  }
})

test("the stand-ins' refusals carry words found in the route's source", () => {
  const found = row("route-words").outcome.found as { file: string; words: string[] }[]
  expect(new Set(found.map((f) => f.file))).toEqual(new Set(["apps/api/src/routes/trade-agent.ts", "apps/api/src/routes/markets.ts"]))
  expect(found.flatMap((f) => f.words)).toContain('"chain_mismatch: this mint is indexed on a different chain"')
  expect(found.flatMap((f) => f.words)).toContain("The mint's chain could not be checked against the feed to convert amountDecimal; retry later")
})
