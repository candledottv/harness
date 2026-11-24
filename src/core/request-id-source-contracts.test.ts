// The API request id, as Candle's source runs it: every API response carries `X-Candle-Request-Id`, and Candle's SDK
// keeps it on the `CandleApiError` it throws (`requestId`, and a message ending `(request id <id>)`), so a failed
// call can be quoted to Candle and found in its logs. Recorded offline from the exact published release commit
// (scripts/read-request-id-source.ts): CLI 0.13.47, MCP 0.10.45 and SDK 0.6.39.
//
// The core reaches Candle through the CLI and the MCP server, never the SDK, and neither of those reads the header at
// this release, so no core error carries an id: the rows below hold that, and fail when either starts reading it.
// The SDK is what a code bot may use for keyless public reads (src/build/agents-md.ts), so a bot's log is where an
// id shows today.
import { expect, test } from "bun:test"
import recorded from "../../test/fixtures/candle-request-id-source.json"
import { agentsMd } from "../build/agents-md"

type Request = { n: number; method: string; host: string; path: string; key: boolean }
type Row = { id: string; scenario: string; evidence?: string; args: Record<string, any>; requests?: Request[]; outcome: Record<string, any> }
const rows = recorded.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const ID = "0f3c2a9e-6b1d-4e57-9a2c-5d8e7f6a1b20"
const SUFFIX = ` (request id ${ID})`

test("the recording names the exact published release build and the files the request id lives in", () => {
  expect(recorded.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "5d7a861a83bcc5c4f2c3dace9897c325b3525e43",
    versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" },
  })
  expect(recorded.source.files).toContain("packages/sdk/src/errors.ts")
  expect(recorded.source.files).toContain("apps/api/src/lib/request-id.ts")
  expect(rows).toHaveLength(33)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["sdk-error", "sdk-client", "api", "source", "docs"]))
})

test("nothing in the recording is a key or a real mint, and every request is to a made-up host", () => {
  const text = JSON.stringify(recorded)
  for (const secret of ["cndl_live_", "cndl_test_", "BEGIN", "So11111111111111111111111111111111111111112"]) expect(text).not.toContain(secret)
  const hosts = new Set(rows.flatMap((r) => (r.requests ?? []).map((q) => q.host)))
  expect([...hosts]).toEqual(["api.test"])
})

test("the SDK exports the header's name, its reader and the error class a bot catches", () => {
  expect(row("sdk-exports").outcome).toEqual({ header: "x-candle-request-id", exported: ["REQUEST_ID_HEADER", "requestIdOf", "CandleApiError"] })
})

test("CandleApiError keeps the id and ends its message with it, for an envelope and for a plain-text answer", () => {
  expect(row("sdk-error-envelope-with-id").outcome).toEqual({
    name: "CandleApiError", code: "QUOTE_UNAVAILABLE", status: 503, retryable: true, requestId: ID, message: `No quote is available right now${SUFFIX}`,
  })
  expect(row("sdk-error-plain-text-with-id").outcome).toMatchObject({ code: "HTTP_502", retryable: false, requestId: ID, message: `Bad Gateway${SUFFIX}` })
  expect(row("sdk-error-empty-body-with-id").outcome).toMatchObject({ code: "HTTP_500", requestId: ID, message: `HTTP 500${SUFFIX}` })
  // An answer with no id (an older API) is the error it always was.
  expect(row("sdk-error-envelope-without-id").outcome).toMatchObject({ requestId: null, message: "No quote is available right now" })
  // Built again from an error already carrying it, the message keeps one suffix.
  expect(row("sdk-error-suffixed-once").outcome).toEqual({ message: `No quote is available right now${SUFFIX}`, suffixes: 1 })
})

test("only a short safe token is read as an id: a proxy's header never reaches a message", () => {
  expect(row("sdk-request-id-of-api-uuid").outcome.requestId).toBe(ID)
  expect(row("sdk-request-id-of-caller-token").outcome.requestId).toBe("bot-run.42_a")
  for (const label of ["absent", "empty", "too-short", "too-long", "with-space", "markup", "no-headers"]) {
    expect(row(`sdk-request-id-of-${label}`).outcome.requestId).toBeNull()
  }
})

test("the SDK's keyless public reads throw CandleApiError with the response's id, and send no key", () => {
  const failures: [string, string, number][] = [
    ["sdk-client-market-not-found", "TOKEN_NOT_FOUND", 404],
    ["sdk-client-feed-unavailable", "FEED_UNAVAILABLE", 503],
    ["sdk-client-token-card-proxy-page", "HTTP_502", 502],
  ]
  for (const [id, code, status] of failures) {
    const o = row(id).outcome
    expect(o).toMatchObject({ threw: true, name: "CandleApiError", code, status, requestId: ID })
    expect(String(o.message).endsWith(SUFFIX)).toBe(true)
  }
  expect(row("sdk-client-token-events-rate-limited-older-api").outcome).toMatchObject({ threw: true, code: "RATE_LIMITED", requestId: null, message: "Too many requests" })
  expect(row("sdk-client-market-proxy-header").outcome).toMatchObject({ threw: true, requestId: null, message: "No quote is available right now" })
  expect(row("sdk-client-market-ok").outcome).toEqual({ threw: false, value: "object" })
  for (const r of scenario("sdk-client")) {
    expect(r.requests).toHaveLength(1)
    expect(r.requests?.[0]).toMatchObject({ method: "GET", host: "api.test", key: false })
  }
})

test("the API puts an id on every answer, reuses a caller's safe one and replaces anything else", () => {
  expect(row("api-success-gets-an-id").outcome).toEqual({ status: 200, header: "X-Candle-Request-Id", id: "uuid" })
  expect(row("api-503-gets-an-id").outcome).toEqual({ status: 503, header: "X-Candle-Request-Id", id: "uuid" })
  expect(row("api-reuses-a-safe-caller-id").outcome.id).toBe("caller's id")
  expect(row("api-replaces-a-short-caller-id").outcome.id).toBe("uuid")
  expect(row("api-replaces-markup").outcome.id).toBe("uuid")
  expect(row("api-fresh-ids-differ").outcome).toEqual({ shapes: ["uuid", "uuid"], differ: true })
  expect(row("source-cors-exposes-the-id").outcome).toEqual({ corsBlocks: 2, everyBlockExposesIt: true })
})

test("at this release only the SDK reads the id: the CLI and the MCP server the core uses don't", () => {
  // When either starts reading it, this fails, and the core's Candle errors can carry the id they pass on.
  expect(row("source-cli-reads-the-id").outcome).toMatchObject({ readsTheHeader: false, reading: [] })
  expect(row("source-mcp-reads-the-id").outcome).toMatchObject({ readsTheHeader: false, reading: [] })
  expect(row("source-sdk-reads-the-id").outcome).toMatchObject({ readsTheHeader: true })
  expect(row("source-sdk-reads-the-id").outcome.reading).toEqual(expect.arrayContaining(["packages/sdk/src/errors.ts", "packages/sdk/src/client.ts"]))
})

test("Candle's docs say the same in all three copies, and the SDK's changelog names the field", () => {
  const docs = row("docs-quoting-the-request-id").outcome
  expect(docs.identical).toBe(true)
  expect(docs.text).toContain("`CandleApiError.requestId` in the SDK holds it, and the error message ends with `(request id <id>)`")
  expect(docs.text).toContain("8 to 64 characters from `A-Za-z0-9._-`")
  expect(row("docs-sdk-changelog").outcome.entry).toContain("`CandleApiError.requestId`")
})

test("the bots folder tells a bot to log the id of a failed SDK read", () => {
  const md = agentsMd()
  expect(md).toContain("`CandleApiError`")
  expect(md).toContain("`requestId`")
  expect(md).toContain("(request id <id>)")
})
