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
