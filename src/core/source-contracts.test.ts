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
