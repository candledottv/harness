import { expect, test } from "bun:test"
import contracts from "../../test/fixtures/candle-source-contracts.json"
import fixture from "../../test/fixtures/candle-tools.json"
import { toOutcome } from "./candle-mcp"

test("source contract fixtures and tools/list name the same exact revision", () => {
  expect(contracts.source).toEqual({ repo: fixture.source.repo, commit: fixture.source.commit })
})

test("perps wallet failures survive the MCP envelope, before a signer or build can be requested", () => {
  const rows = contracts.rows.filter((r) => r.id.startsWith("perps-"))
  expect(rows).toHaveLength(4)
  const expected = { "perps-tee-no-pem": "SIGNER_UNAVAILABLE", "perps-unknown-wallet": "TEE_WALLET_REQUIRED", "perps-embedded-no-pem": "FIXTURE_BUILD_STOP", "perps-embedded-denied": "AGENT_WALLET_MISSING" }
  for (const row of rows) {
    const outcome = row.outcome as { body: { error: { code: string } }; isError: boolean }
    const code = expected[row.id as keyof typeof expected]
    expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: outcome.isError })).toMatchObject({ kind: "error", code, body: outcome.body })
    const requests = row.requests!
    expect(requests[0]!.method).toBe("GET")
    const posts = requests.filter((r) => r.method === "POST")
    // This is the only POST, served by a local refusal before building, signing or submitting.
    expect(posts).toEqual(row.id === "perps-embedded-no-pem" ? [{ method: "POST", path: "/api/v1/agent/perps/cancel" }] : [])
    expect(requests.some((r) => /sign|submit|exchange/.test(r.path))).toBe(false)
  }
})

test("SDK and MCP checks issue one GET; a paused or split quote is not admitted and an old server is refused", () => {
  for (const state of ["available", "paused", "split", "old-server"]) {
    const mcp = contracts.rows.find((r) => r.id === `mcp-launch-${state}`)!
    const sdk = contracts.rows.find((r) => r.id === `sdk-launch-${state}`)!
    expect(sdk.requests).toEqual(mcp.requests!)
    expect(mcp.requests).toHaveLength(1)
    expect(mcp.requests![0]!.method).toBe("GET")
    const m = mcp.outcome as { body: { works?: boolean; error?: { code: string } } }
    const s = sdk.outcome as typeof m
    if (state === "old-server") expect(s.body.error!.code).toBe(m.body.error!.code)
    else expect(s.body).toEqual(m.body)
  }
})

test("per-order hide: the echo is required, a dry run that lacks it stops a hidden launch, and a public order sends no hide", () => {
  const rows = contracts.rows.filter((r) => r.id.startsWith("hide-"))
  expect(rows).toHaveLength(18)
  const asked = (r: (typeof rows)[number]) => (r.args as { hide?: unknown }).hide === true
  for (const row of rows.filter((r) => r.requests && r.requests.length > 0)) {
    const sent = row.requests as { path: string; hide: true | null }[]
    // Only a request that asked for hide sends the field, and it sends exactly `true`.
    expect(sent.every((q) => q.hide === (asked(row) ? true : null))).toBe(true)
  }
  const refused = rows.filter((r) => (r.outcome as { isError: boolean }).isError).map((r) => r.id).sort()
  expect(refused).toEqual([
    "hide-mcp-launch-hide-dry-run-no-echo", "hide-mcp-launch-hide-live-no-echo", "hide-mcp-swap-hide-unconfirmed", "hide-mcp-trade-paper",
    "hide-sdk-launch-hide-dry-run-no-echo", "hide-sdk-launch-hide-live-no-echo", "hide-sdk-swap-hide-unconfirmed", "hide-sdk-swap-unreadable",
  ])
  // MCP and SDK refuse the same cases; the MCP names HIDE_NOT_CONFIRMED in its text, the SDK in its error code.
  for (const id of ["launch-hide-dry-run-no-echo", "launch-hide-live-no-echo", "swap-hide-unconfirmed"]) {
    expect(JSON.stringify(contracts.rows.find((r) => r.id === `hide-mcp-${id}`)!.outcome)).toContain("HIDE_NOT_CONFIRMED")
    expect(contracts.rows.find((r) => r.id === `hide-sdk-${id}`)!.outcome).toMatchObject({ isError: true, body: { error: { code: "HIDE_NOT_CONFIRMED" } } })
  }
  // A hidden launch is dry-run first: without the echo nothing is launched; with it, dry run then live.
  for (const surface of ["mcp", "sdk"]) {
    expect(contracts.rows.find((r) => r.id === `hide-${surface}-launch-hide-dry-run-no-echo`)!.requests!.map((q) => q.path)).toEqual(["/api/v1/launch/headless/dry-run"])
    expect(contracts.rows.find((r) => r.id === `hide-${surface}-launch-hide-echoed`)!.requests!.map((q) => q.path)).toEqual(["/api/v1/launch/headless/dry-run", "/api/v1/launch/headless"])
    // The public launch is unchanged: one live request, no hide, no dry run.
    expect(contracts.rows.find((r) => r.id === `hide-${surface}-launch-public`)!.requests!.map((q) => q.path)).toEqual(["/api/v1/launch/headless"])
  }
  // The unreadable hide and the hide with paper are refused before any request.
  expect(contracts.rows.find((r) => r.id === "hide-sdk-swap-unreadable")!.requests).toEqual([])
  expect(contracts.rows.find((r) => r.id === "hide-mcp-trade-paper")!.requests).toEqual([])
})

test("perp position pages: the round, open-orders and candles reads are one keyless GET each, the same on MCP and SDK, with no wallet, order id or cloid", () => {
  const rows = contracts.rows.filter((r) => r.id.startsWith("perp-pages-"))
  expect(rows).toHaveLength(12)
  const paths: Record<string, string> = {
    "round-closed": "/api/v1/agent/records/fixture-agent/perps/rounds/rnd_0123456789abcdef",
    "round-open-builder-dex": "/api/v1/agent/records/fixture-agent/perps/rounds/open%3Axyz%3ATSLA",
    "open-orders": "/api/v1/agent/records/fixture-agent/open-orders",
    "open-orders-none": "/api/v1/agent/records/fixture-agent/open-orders",
    "candles-default": "/api/v1/agent/perps-candles/BTC",
    "candles-builder-dex": "/api/v1/agent/perps-candles/xyz%3ATSLA?interval=15m&count=2&end=1760003600000",
  }
  for (const [id, path] of Object.entries(paths)) {
    const mcp = rows.find((r) => r.id === `perp-pages-mcp-${id}`)!
    const sdk = rows.find((r) => r.id === `perp-pages-sdk-${id}`)!
    for (const row of [mcp, sdk]) {
      expect(row.requests!.map((q) => [q.method, q.path])).toEqual([["GET", path]])
      expect((row.outcome as { isError: boolean }).isError).toBe(false)
      expect(JSON.stringify(row.outcome)).not.toMatch(/"(wallet|address|oid|cloid)"/i)
    }
    // The MCP tool relays the server's answer whole; the SDK drops `success` and keeps the rest.
    const { success: _s, ...answer } = (mcp.outcome as { body: Record<string, unknown> }).body
    const sdkBody = (sdk.outcome as { body: Record<string, unknown> }).body
    if (id.startsWith("round")) expect(sdkBody).toEqual({ ...(answer.round as object), seq: answer.seq })
    else expect(sdkBody).toEqual(answer)
    // The MCP tool never sends a credential, even though the recorder configures a key.
    expect((mcp.requests as { credential: boolean }[]).every((q) => q.credential === false)).toBe(true)
  }
})

test("perp position pages: a round has fills, funding and separate fees; open orders say type and trigger; none is []", () => {
  const body = (id: string) => (rows.find((r) => r.id === id)!.outcome as { body: any }).body
  const rows = contracts.rows
  const round = body("perp-pages-mcp-round-closed").round
  expect(round.fills.map((f: { role: string }) => f.role)).toEqual(["open", "close"])
  expect(round.funding).toHaveLength(1)
  expect(round.hyperliquidFeesUsd).toBe(0.02)
  expect(round.builderFeesUsd).toBe(0.005)
  expect(round.returnOnMargin).toBe(0.4)
  expect(body("perp-pages-mcp-round-open-builder-dex").round).toMatchObject({ id: "open:xyz:TSLA", coin: "xyz:TSLA", dex: "xyz" })
  const orders = body("perp-pages-mcp-open-orders").orders as { kind: string; triggerPx: string | null }[]
  expect(orders.map((o) => [o.kind, o.triggerPx])).toEqual([["limit", null], ["take_profit", "120.0"], ["stop_loss", "95.0"]])
  expect(body("perp-pages-sdk-open-orders-none").orders).toEqual([])
  expect(body("perp-pages-mcp-candles-builder-dex")).toMatchObject({ coin: "xyz:TSLA", interval: "15m" })
})
