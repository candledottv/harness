// The client-surface header and the per-swap timing row (BE-3919), as Candle's source runs them: every request the CLI,
// SDK, local MCP, hosted MCP and web make to the Candle API names its client (`X-Candle-Client: <surface>/<version>`),
// the API reads that label strictly, and each Solana swap the API broadcasts inside a swap route leaves one
// `ops.swap_landings` row with its send time, landing slot, winning path, wallet type and client. Recorded offline from
// the exact published release commit (scripts/read-client-surface-source.ts): CLI 0.13.35, MCP 0.10.40 and SDK 0.6.29.
import { expect, test } from "bun:test"
import surface from "../../test/fixtures/candle-client-surface-source.json"

type Request = { n: number; host: string; path: string; rpc?: string; client: string | null }
type Row = { id: string; scenario: string; evidence?: string; args: Record<string, any>; requests?: Request[]; outcome: Record<string, any> }
const rows = surface.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const CLI = "cli/0.13.35", SDK = "sdk/0.6.29", MCP = "mcp/0.10.40", HOSTED = "mcp-hosted/0.10.40", WEB = "web/0123456789ab"
const LANDING_FIELDS = ["signature", "route", "wallet_type", "client", "key_prefix", "sent_at", "send_ms", "outcome", "landed_slot", "confirmed_after_ms", "winning_path", "sends"]

test("the recording names the exact published release build and the files the label and the landing row live in", () => {
  expect(surface.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "ebd1e50050cddc82d82186a1e6a499cd0ca02e85",
    versions: { cli: "0.13.35", mcp: "0.10.40", sdk: "0.6.29" },
  })
  expect(surface.source.files).toContain("packages/cli/src/client.ts")
  expect(surface.source.files).toContain("apps/api/src/ledger/trading/swap-landings.ts")
  expect(rows).toHaveLength(75)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["cli", "sdk", "mcp", "mcp-hosted", "web", "api-label", "landing", "confirm", "source"]))
})

test("nothing in the recording is a key, an address, an RPC's path or a real signature, and every request is to a made-up host", () => {
  const text = JSON.stringify(surface)
  for (const secret of ["fixture-only-not-a-key", "fixture-path-not-a-key", "BEGIN", "7ZL9Fvkp", "9dXSV8VW", "fixture-account"]) expect(text).not.toContain(secret)
  const hosts = new Set(rows.flatMap((r) => (r.requests ?? []).map((q) => q.host)))
  expect([...hosts].sort()).toEqual(["api.test", "rpc.private.test"])
  for (const r of scenario("landing")) for (const l of r.outcome.rows) expect(l.signature).toBe("<signature>")
})

test("the CLI names itself on every API request of a swap, TEE and embedded, and on no RPC request", () => {
  for (const id of ["cli-tee-swap", "cli-embedded-swap"]) {
    const r = row(id)
    expect(r.outcome).toMatchObject({ exitCode: 0, status: "executed", label: CLI, rpcLabelled: 0 })
    const api = (r.requests ?? []).filter((q) => q.host === "api.test")
    const rpc = (r.requests ?? []).filter((q) => q.host !== "api.test")
    expect(api.length).toBeGreaterThanOrEqual(3)
    expect(api.every((q) => q.client === CLI)).toBe(true)
    expect(rpc.every((q) => q.client === null)).toBe(true)
    expect(r.outcome.apiLabelled).toBe(api.length)
  }
  // The TEE swap goes through build, the relay's sign and submit; the embedded wallet through build and execute.
  expect(row("cli-tee-swap").requests?.map((q) => q.path)).toEqual(expect.arrayContaining(["/api/v1/trade/agent/build", "/api/v1/trade/agent/submit"]))
  expect(row("cli-tee-swap").outcome.rpcRequests).toBeGreaterThan(0)
  expect(row("cli-embedded-swap").requests?.map((q) => q.path)).toContain("/api/v1/trade/agent/execute")
})

test("the CLI's quant key client keeps the headers' shape and a label already set", () => {
  expect(row("cli-quant-record-headers").outcome).toEqual({ headersOut: { "x-api-key": "<key>", "x-candle-client": CLI }, shapeOut: "record", label: CLI })
  expect(row("cli-quant-array-headers").outcome).toMatchObject({ shapeOut: "array", label: CLI })
  expect(row("cli-quant-Headers-object").outcome).toMatchObject({ shapeOut: "Headers", label: CLI })
  expect(row("cli-quant-no-headers").outcome).toMatchObject({ label: CLI })
  expect(row("cli-quant-label-already-set").outcome).toEqual({ headersOut: { "X-Candle-Client": "cli/other" }, shapeOut: "record", label: "cli/other" })
})

test("the SDK names itself on its API requests and only those", () => {
  const methods = row("sdk-client-methods")
  expect(methods.outcome).toMatchObject({ label: SDK })
  expect(methods.requests?.every((q) => q.host === "api.test" && q.client === SDK)).toBe(true)
  expect(row("sdk-api-string-url").outcome.label).toBe(SDK)
  expect(row("sdk-api-url-object").outcome.label).toBe(SDK)
  expect(row("sdk-hyperliquid-origin").outcome.label).toBeNull()
  // A Request object is passed through as it was: the SDK never builds one for the API.
  expect(row("sdk-request-object").outcome.label).toBeNull()
  expect(row("sdk-label-already-set").outcome.label).toBe("sdk/custom")
})

test("the local MCP server names itself on a tool's API request, reads the API URL per request, and leaves other origins alone", () => {
  const tool = row("mcp-tool-request")
  expect(tool.requests).toEqual([{ n: 1, host: "api.test", path: "/api/v1/activity/report", client: MCP }])
  expect(row("mcp-hyperliquid-origin").outcome.label).toBeNull()
  expect(row("mcp-api-array-headers").outcome.label).toBe(MCP)
  expect(row("mcp-label-already-set").outcome.label).toBe("mcp-hosted/1")
  expect(row("mcp-api-url-switched-old-origin").outcome.label).toBeNull()
  expect(row("mcp-api-url-switched-new-origin").outcome.label).toBe(MCP)
})

test("the hosted connector stamps its own label on the very request object it dispatches", () => {
  expect(row("mcp-hosted-stamp").outcome).toEqual({ sameRequestObject: true, label: HOSTED })
  expect(row("mcp-hosted-stamp").args.incomingLabel).toBe("mcp/0.0.1")
  expect(row("mcp-hosted-immutable-headers").outcome).toEqual({ dispatched: true, label: null })
})

test("the web labels only Candle API requests the browser already preflights, so the quote path pays no extra round trip", () => {
  expect(row("web-label-build-sha").outcome.label).toBe(WEB)
  expect(row("web-label-no-sha").outcome.label).toBe("web/dev")
  for (const id of ["web-json-post-swap", "web-json-post-confirm", "web-keyed-get"]) expect(row(id).outcome).toEqual({ preflighted: true, labelled: true, label: WEB })
  for (const id of ["web-simple-get-quote", "web-simple-get-accept-header", "web-form-post"]) expect(row(id).outcome).toEqual({ preflighted: false, labelled: false, label: null })
  expect(row("web-other-origin-post").outcome).toEqual({ preflighted: true, labelled: false, label: null })
  expect(row("web-label-already-set").outcome.labelled).toBe(false)
  expect(row("web-request-object").outcome.labelled).toBe(false)
})

test("the API reads each surface's own header as sent, and anything outside the strict shape as a raw caller without echoing it", () => {
  expect(row("api-reads-cli").outcome.label).toBe(CLI)
  expect(row("api-reads-sdk").outcome.label).toBe(SDK)
  expect(row("api-reads-mcp").outcome.label).toBe(MCP)
  expect(row("api-reads-mcp-hosted").outcome.label).toBe(HOSTED)
  expect(row("api-reads-web").outcome.label).toBe(WEB)
  expect(row("api-trims-spaces").outcome.label).toBe(CLI)
  for (const id of ["api-surface-is-case-sensitive", "api-unknown-surface", "api-empty-version", "api-version-too-long", "api-version-with-space", "api-version-with-separator", "api-no-header", "api-web-origin-plain-http", "api-lookalike-origin"]) {
    expect(row(id).outcome, id).toEqual({ label: "unknown", rawCaller: true, echoedInput: false })
  }
  expect(row("api-web-origin-no-header").outcome.label).toBe("web")
  expect(row("api-web-preview-origin").outcome.label).toBe("web")
  expect(row("api-header-wins-over-origin").outcome.label).toBe(SDK)
  expect(row("api-bad-header-falls-to-origin").outcome.label).toBe("web")
  // The only labels the API produces: a well-formed surface/version, `web`, or the raw-caller label.
  for (const r of scenario("api-label")) expect(r.outcome.label).toMatch(/^((cli|sdk|mcp|mcp-hosted|web)\/[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}|web|unknown)$/)
})

test("each swap route records one row per broadcast, with the wallet type app.ts mounts it with", () => {
  const want = { build: ["main", 391_000_001], execute: ["main", 391_000_002], submit: ["linked", 391_000_003], swap: ["main", 391_000_004] } as const
  for (const [route, [wallet, slot]] of Object.entries(want)) {
    const r = row(`landing-${route}-landed`)
    expect(r.outcome.rows).toEqual([{ signature: "<signature>", route, wallet_type: wallet, client: CLI, key_prefix: "FIXTURE1", sent_at: "<t0>", send_ms: 40, outcome: "landed", landed_slot: slot, confirmed_after_ms: 940, winning_path: "rpc", sends: 1 }])
  }
  for (const r of scenario("landing")) for (const l of r.outcome.rows) expect(Object.keys(l)).toEqual(LANDING_FIELDS)
  expect(row("source-swap-scope-mounts").outcome.mounts).toEqual([
    { path: "/api/v1/trade/agent/build", route: "build", wallet: "main" },
    { path: "/api/v1/trade/agent/execute", route: "execute", wallet: "main" },
    { path: "/api/v1/trade/agent/submit", route: "submit", wallet: "linked" },
    { path: "/api/v1/agent/swap", route: "swap", wallet: "main" },
  ])
})

test("each surface's own header, replayed into a swap route, lands as that surface's label", () => {
  expect(row("landing-client-sdk").outcome.rows[0].client).toBe(SDK)
  expect(row("landing-client-mcp").outcome.rows[0].client).toBe(MCP)
  expect(row("landing-client-mcp-hosted").outcome.rows[0].client).toBe(HOSTED)
  expect(row("landing-client-web").outcome.rows[0].client).toBe(WEB)
  expect(row("landing-client-web-origin-only").outcome.rows[0].client).toBe("web")
  expect(row("landing-client-raw-caller").outcome.rows[0].client).toBe("unknown")
})

test("the timing fields: send time and send ms, landing slot, confirm time, winning path and sends per outcome", () => {
  expect(row("landing-landed-after-resends").outcome.rows[0]).toMatchObject({ outcome: "landed", send_ms: 120, landed_slot: 391_000_777, confirmed_after_ms: 7_520, winning_path: "rpc", sends: 3 })
  expect(row("landing-reverted").outcome).toMatchObject({ tradeSaw: "TradeRevertedError" })
  expect(row("landing-reverted").outcome.rows[0]).toMatchObject({ outcome: "reverted", send_ms: 35, landed_slot: 55, confirmed_after_ms: 1_135, winning_path: "rpc", sends: 1 })
  for (const id of ["landing-unconfirmed-send-answer-lost", "landing-unconfirmed-confirm-timed-out"]) {
    expect(row(id).outcome.tradeSaw).toBe("TradeUnconfirmedError")
    expect(row(id).outcome.rows[0]).toMatchObject({ outcome: "unconfirmed", landed_slot: null, confirmed_after_ms: null, winning_path: null, sends: 1 })
  }
  // The send whose answer was lost still records how long the send call took before it threw.
  expect(row("landing-unconfirmed-send-answer-lost").outcome.rows[0].send_ms).toBe(30_000)
  expect(row("landing-observer-reports-no-slot").outcome.rows[0]).toMatchObject({ outcome: "landed", landed_slot: null, winning_path: "rpc" })
})

test("a refused send, a broadcast outside a swap route, and a process with no writer record nothing, and the trade sees the same outcome", () => {
  expect(row("landing-refused-send").outcome).toEqual({ httpStatus: 500, tradeSaw: "SendTransactionError", rows: [] })
  expect(row("landing-outside-swap-scope").outcome).toEqual({ httpStatus: 200, tradeSaw: "signature", rows: [] })
  expect(row("landing-no-writer").outcome).toEqual({ httpStatus: 200, tradeSaw: "signature", rows: [] })
})

test("every outcome a trade saw is a signature or one of the broadcaster's mapped errors", () => {
  const seen = new Set(scenario("landing").map((r) => r.outcome.tradeSaw))
  for (const s of seen) expect(["signature", "TradeRevertedError", "TradeUnconfirmedError", "SendTransactionError"]).toContain(s)
  expect(scenario("cli").filter((r) => r.outcome.exitCode !== undefined).every((r) => r.outcome.exitCode === 0)).toBe(true)
})

test("the real confirm loop reports the slot and the send count once, when a confirmed status is read", () => {
  expect(row("confirm-first-poll").outcome).toEqual({ outcome: "returned", observedOnce: true, slot: 400_000_001, sends: 1, resends: 0 })
  expect(row("confirm-after-a-resend").outcome).toEqual({ outcome: "returned", observedOnce: true, slot: 400_000_002, sends: 2, resends: 1 })
  expect(row("confirm-reverted").outcome).toEqual({ outcome: "OnChainRevertError", observedOnce: true, slot: 400_000_003, sends: 1, resends: 0 })
  // A processed status is not a landing: the slot reported is the confirmed one.
  expect(row("confirm-processed-is-not-landed").outcome).toMatchObject({ slot: 400_000_004, observedOnce: true })
})

test("the table holds the timing fields and no wallet, mint, amount or account, and names one winning path today", () => {
  const t = row("source-swap-landings-table").outcome
  for (const c of ["signature", "route", "wallet_type", "client", "key_prefix", "sent_at", "send_ms", "outcome", "landed_slot", "confirmed_at", "winning_path", "sends"]) expect(t.columns).toContain(c)
  for (const c of ["wallet_address", "mint", "amount", "account"]) expect(t.columns).not.toContain(c)
  expect(t.checks).toEqual({ route: ["build", "execute", "submit", "swap"], wallet_type: ["main", "linked"], outcome: ["landed", "reverted", "unconfirmed"], winning_path: ["rpc"], winningPathNullable: true })
})
