// Offline request-id contracts from an exact clean Candle source checkout: the `X-Candle-Request-Id` the API puts on
// every response, how Candle's SDK keeps it on the error it throws, and which of Candle's clients read it at all.
// Recorded by running Candle's own source against stand-ins:
//   1. sdk-error:  `candleApiErrorFromResponse` and `requestIdOf`: an envelope and a plain-text error, with an id and
//                  without one, keep `requestId` and end the message with `(request id <id>)`; an id that isn't a short
//                  safe token (a proxy's header) is dropped; an error built again from one already suffixed is not
//                  suffixed twice;
//   2. sdk-client: `CandleClient`'s keyless public reads (market, feed, token card, token events), with no key, against
//                  a stand-in API: each failure throws `CandleApiError` carrying the response's id, a success carries
//                  no error, and no request carries a key;
//   3. api:        the API's own `requestTiming` middleware in a stand-in app: the header on a success and on a 503, a
//                  caller's safe id reused, anything else replaced by a fresh UUID;
//   4. source:     the API's CORS exposing the header, and whether the CLI's and the MCP server's own source reads it
//                  (pinned as source text);
//   5. docs:       "Quoting the request id", byte-identical in the three copies of the agent-trading page, and the
//                  SDK's changelog entry.
// Every fetch is intercepted: nothing reaches a network, no key is sent, and no id is a real request's.
//   bun scripts/read-request-id-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-request-id-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/sdk", "packages/mcp", "packages/shared", "apps/api/src", "docs", "apps/docs", "apps/frontend/public/docs")
const FILES = [
  "packages/sdk/src/errors.ts",
  "packages/sdk/src/client.ts",
  "packages/sdk/CHANGELOG.md",
  "apps/api/src/lib/request-id.ts",
  "apps/api/src/middleware/request-timing.ts",
  "apps/api/src/app.ts",
  "docs/agent-trading.md",
  "apps/docs/src/content/docs/developers/agent-trading.md",
  "apps/frontend/public/docs/agent-trading.md",
]
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(text(`packages/${p}/package.json`)).version])),
  files: FILES,
}
for (const f of FILES) text(f)
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({ name: "request-id-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
} })
const originalFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error("request-id recording may not access the network") }) as unknown as typeof fetch

const API = "https://api.test"
/** Made-up ids, in the API's own shape and in a caller's. */
const ID = "0f3c2a9e-6b1d-4e57-9a2c-5d8e7f6a1b20"
const CALLER_ID = "bot-run.42_a"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
type Request = { n: number; method: string; host: string; path: string; key: boolean }
type Row = { id: string; scenario: string; evidence?: string; args: Record<string, unknown>; requests?: Request[]; outcome: Record<string, unknown> }
const rows: Row[] = []
const record = (id: string, scenario: string, args: Record<string, unknown>, outcome: Record<string, unknown>, requests?: Request[], evidence?: string) =>
  rows.push({ id, scenario, ...(evidence ? { evidence } : {}), args, ...(requests ? { requests } : {}), outcome })
/** What a caller sees of a thrown error: its class, its fields, and its message. */
const seen = (e: any) => ({
  name: e?.name, code: e?.code, status: e?.status, retryable: e?.retryable,
  requestId: e?.requestId ?? null, message: e?.message,
})

try {
  // 1. The SDK's error, built from a response's status, body and id.
  {
    const { candleApiErrorFromResponse, requestIdOf, REQUEST_ID_HEADER, CandleApiError } = await load("packages/sdk/src/errors.ts")
    const index = text("packages/sdk/src/index.ts")
    record("sdk-exports", "sdk-error", {}, {
      header: REQUEST_ID_HEADER,
      exported: ["REQUEST_ID_HEADER", "requestIdOf", "CandleApiError", "candleApiErrorFromResponse"].filter((name) => new RegExp(`\\b${name}\\b`).test(index)),
    })
    const envelope = JSON.stringify({ success: false, error: { code: "QUOTE_UNAVAILABLE", message: "No quote is available right now", retryable: true } })
    const cases: [string, number, string, string | undefined][] = [
      ["sdk-error-envelope-with-id", 503, envelope, ID],
      ["sdk-error-envelope-without-id", 503, envelope, undefined],
      ["sdk-error-plain-text-with-id", 502, "Bad Gateway", ID],
      ["sdk-error-empty-body-with-id", 500, "", ID],
    ]
    for (const [id, status, body, requestId] of cases) {
      const e = candleApiErrorFromResponse(status, body, requestId)
      assert.ok(e instanceof CandleApiError)
      record(id, "sdk-error", { status, body: body ? (body.startsWith("{") ? "envelope" : body) : "", requestId: requestId ?? null }, seen(e))
    }
    const first = candleApiErrorFromResponse(503, envelope, ID)
    const again = new CandleApiError({ code: first.code, message: first.message, status: first.status, retryable: first.retryable, requestId: first.requestId })
    record("sdk-error-suffixed-once", "sdk-error", { from: "sdk-error-envelope-with-id" }, { message: again.message, suffixes: again.message.split("(request id ").length - 1 })
    const headerCases: [string, string | null][] = [
      ["api-uuid", ID], ["caller-token", CALLER_ID], ["absent", null], ["empty", ""], ["too-short", "abc1234"],
      ["too-long", "a".repeat(65)], ["with-space", "abc 12345"], ["markup", "<b>12345678</b>"],
    ]
    for (const [label, value] of headerCases) {
      const headers = new Headers(value === null ? {} : { [REQUEST_ID_HEADER]: value })
      const read = requestIdOf({ headers })
      record(`sdk-request-id-of-${label}`, "sdk-error", { header: value === null ? "absent" : value.length > 20 ? `${value.length} chars` : value }, { requestId: read ?? null })
    }
    record("sdk-request-id-of-no-headers", "sdk-error", { response: "no headers object" }, { requestId: requestIdOf({}) ?? null })
  }

  // 2. The SDK's keyless public reads, against a stand-in API.
  {
    const { CandleClient } = await load("packages/sdk/src/client.ts")
    const MINT = "So11111111111111111111111111111111111111112"
    type Answer = { status: number; body: string; id?: string }
    const runRead = async (id: string, label: string, answer: Answer, call: (c: any) => Promise<unknown>) => {
      const requests: Request[] = []
      const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : (input as any).url)
        const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])
        requests.push({ n: requests.length + 1, method: init?.method ?? "GET", host: url.host, path: url.pathname.replace(MINT, "<mint>"), key: headers.has("x-api-key") })
        return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.body.startsWith("{") ? "application/json" : "text/plain", ...(answer.id ? { "x-candle-request-id": answer.id } : {}) } })
      }
      const client = new CandleClient({ apiUrl: API, fetch: fetcher as unknown as typeof fetch })
      let outcome: Record<string, unknown>
      try {
        const value = await call(client)
        outcome = { threw: false, value: value === undefined ? null : typeof value }
      } catch (e) {
        outcome = { threw: true, ...seen(e) }
      }
      record(id, "sdk-client", { read: label, status: answer.status, body: answer.body.startsWith("{") ? "envelope" : answer.body, requestId: answer.id ?? null }, outcome, requests)
    }
    const env = (code: string, message: string, retryable = false) => JSON.stringify({ success: false, error: { code, message, retryable } })
    await runRead("sdk-client-market-not-found", "getMarket", { status: 404, body: env("TOKEN_NOT_FOUND", "No market for that token"), id: ID }, (c) => c.getMarket("solana", MINT))
    await runRead("sdk-client-feed-unavailable", "getFeed", { status: 503, body: env("FEED_UNAVAILABLE", "The feed is unavailable right now", true), id: ID }, (c) => c.getFeed("new", "solana"))
    await runRead("sdk-client-token-card-proxy-page", "getTokenCard", { status: 502, body: "Bad Gateway", id: ID }, (c) => c.getTokenCard("solana", MINT))
    await runRead("sdk-client-token-events-rate-limited-older-api", "getTokenEvents", { status: 429, body: env("RATE_LIMITED", "Too many requests", true) }, (c) => c.getTokenEvents("solana", MINT))
    await runRead("sdk-client-market-proxy-header", "getMarket", { status: 503, body: env("QUOTE_UNAVAILABLE", "No quote is available right now", true), id: "<proxy page>" }, (c) => c.getMarket("solana", MINT))
    await runRead("sdk-client-market-ok", "getMarket", { status: 200, body: JSON.stringify({ success: true, market: { chain: "solana" } }), id: ID }, (c) => c.getMarket("solana", MINT))
  }

  // 3. The API's own middleware in a stand-in app.
  {
    const { Hono } = await import(pathToFileURL(join(checkout, "node_modules/hono/dist/index.js")).href)
    const { requestTiming } = await load("apps/api/src/middleware/request-timing.ts")
    const { REQUEST_ID_HEADER, resolveRequestId } = await load("apps/api/src/lib/request-id.ts")
    const lines: string[] = []
    const app = new Hono()
    app.use("/*", requestTiming((line: string) => lines.push(line)))
    app.get("/api/v1/markets/:chain/:mint", (c: any) => c.json({ success: true }))
    app.get("/api/v1/markets/feed", (c: any) => c.json({ success: false, error: { code: "FEED_UNAVAILABLE", message: "unavailable", retryable: true } }, 503))
    const shapeOf = (id: string | null) => (id === null ? "none" : id === CALLER_ID ? "caller's id" : UUID.test(id) ? "uuid" : id)
    const apiCases: [string, string, string | undefined][] = [
      ["api-success-gets-an-id", "/api/v1/markets/solana/mint", undefined],
      ["api-503-gets-an-id", "/api/v1/markets/feed", undefined],
      ["api-reuses-a-safe-caller-id", "/api/v1/markets/solana/mint", CALLER_ID],
      ["api-replaces-a-short-caller-id", "/api/v1/markets/solana/mint", "abc1234"],
      ["api-replaces-markup", "/api/v1/markets/solana/mint", "<b>12345678</b>"],
    ]
    for (const [id, path, incoming] of apiCases) {
      const res = await app.request(`${API}${path}`, { headers: incoming ? { [REQUEST_ID_HEADER]: incoming } : {} })
      record(id, "api", { path, incoming: incoming ?? null }, { status: res.status, header: REQUEST_ID_HEADER, id: shapeOf(res.headers.get(REQUEST_ID_HEADER)) })
    }
    const fresh = [resolveRequestId(undefined), resolveRequestId(undefined)]
    record("api-fresh-ids-differ", "api", { calls: 2 }, { shapes: fresh.map(shapeOf), differ: fresh[0] !== fresh[1] })
  }

  // 4. Source text: the API's CORS, and the clients that read the header.
  {
    const app = text("apps/api/src/app.ts")
    const exposes = [...app.matchAll(/exposeHeaders:\s*\[([^\]]*)\]/g)].map((m) => (m[1] as string).includes("REQUEST_ID_HEADER"))
    assert.ok(exposes.length > 0)
    record("source-cors-exposes-the-id", "source", { file: "apps/api/src/app.ts" }, { corsBlocks: exposes.length, everyBlockExposesIt: exposes.every(Boolean) }, undefined, "pinned as source text: app.ts is the whole API and is not run here")
    const sources = (dir: string): string[] => readdirSync(join(checkout, dir)).flatMap((name) => {
      const path = `${dir}/${name}`
      if (statSync(join(checkout, path)).isDirectory()) return sources(path)
      return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.|\.fixtures?\.|test-support/.test(name) ? [path] : []
    })
    const READS = /x-candle-request-id|REQUEST_ID_HEADER|requestIdOf/i
    for (const pkg of ["cli", "mcp", "sdk"]) {
      const files = sources(`packages/${pkg}/src`)
      const reading = files.filter((f) => READS.test(text(f)))
      record(`source-${pkg}-reads-the-id`, "source", { dir: `packages/${pkg}/src` }, { files: files.length, readsTheHeader: reading.length > 0, reading }, undefined, "pinned as source text: every non-test source file of the package, searched for the header's name or the SDK's reader")
    }
  }

  // 5. Docs: the section, in its three copies, and the SDK's changelog.
  {
    const COPIES = ["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"]
    const section = (md: string) => {
      const m = /^## Quoting the request id\n[\s\S]*?(?=^## )/m.exec(md)
      return m ? m[0].trim() : null
    }
    const found = COPIES.map((f) => section(text(f)))
    assert.ok(found[0])
    record("docs-quoting-the-request-id", "docs", { files: COPIES }, { identical: found.every((s) => s === found[0]), text: found[0] })
    const changelog = text("packages/sdk/CHANGELOG.md")
    const entry = changelog.split("\n").find((l) => /CandleApiError\.requestId|`requestId`/.test(l)) ?? null
    record("docs-sdk-changelog", "docs", { file: "packages/sdk/CHANGELOG.md" }, { entry })
  }

  const out = JSON.stringify(rows)
  for (const secret of ["cndl_live_", "cndl_test_", "BEGIN", "So11111111111111111111111111111111111111112"]) assert.ok(!out.includes(secret), `a fixture carries ${secret}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-request-id-source.json"), `${JSON.stringify({
    about: "Offline request-id contracts: the X-Candle-Request-Id the API puts on every response, how Candle's SDK keeps it on CandleApiError (requestId, and a message ending `(request id <id>)`), and which of Candle's clients read it. Recorded by running Candle's own source against stand-ins from the published release commit; every fetch is intercepted.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline request-id contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch }
