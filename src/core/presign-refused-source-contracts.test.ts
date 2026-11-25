// Server pre-sign guard (`cause: "slippage_exceeded"`) and fast-market stop-loss docs contracts (BE-3904, BE-4292,
// BE-4343, BE-4344) recorded at the published release commit `5d7a861a8` (`scripts/read-presign-refused-source.ts`).
// The SDK, MCP and CLI package contracts themselves are tested from the published npm tarballs in
// `src/core/presign-refused-packages-contracts.test.ts`.
import { expect, test } from "bun:test"
import presign from "../../test/fixtures/candle-presign-refused-source.json"

type Row = { id: string; scenario: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = presign.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)

test("the server and docs recording pins the published release commit 5d7a861a8 (CLI 0.13.47, MCP 0.10.45, SDK 0.6.39)", () => {
  expect(presign.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "5d7a861a83bcc5c4f2c3dace9897c325b3525e43",
    versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" },
  })
  for (const file of [
    "apps/api/src/services/solana/presign-guard.ts",
    "apps/api/src/lib/agent-slippage.ts",
    "apps/api/src/routes/trade-agent.ts",
    "docs/agent-trading.md",
    "apps/docs/src/content/docs/developers/agent-trading.md",
    "apps/frontend/public/docs/agent-trading.md",
  ]) {
    expect(presign.source.files).toContain(file)
  }
  expect(rows).toHaveLength(11)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["api-presign", "docs"]))
})

test("nothing in the server and docs recording is a wallet address or a program id", () => {
  const text = JSON.stringify(presign)
  for (const forbidden of ["PayrFake111", "Dex2Fake111", "JUP6LkbZbjS", "BEGIN"]) {
    expect(text).not.toContain(forbidden)
  }
})

test("API presign guard labels Jupiter 6001 as slippage_exceeded with (default 100, cap 5000), excludes inner-CPI 6001, and redacts addresses", () => {
  const jup = row("api-jupiter-6001-labelled-and-redacted").outcome
  expect(jup).toMatchObject({
    slippageExceeded: true,
    otherProgram6001: false,
    innerCpi6001: false,
    diagnosticBeforeJupiter6001: true,
    jupiter6000: false,
    nullLogs: false,
    jupiterIdRedacted: true,
    otherAddressRedacted: true,
  })
  expect(jup.envelope).toMatchObject({
    success: false,
    error: {
      code: "SWAP_FAILED",
      retryable: true,
      stage: "not_broadcast",
      reason: "presign_refused",
      refusal: "simulation_failed",
      cause: "slippage_exceeded",
    },
  })
  expect(jup.envelope.error.detail).toContain("maxSlippageBps (default 100, cap 5000)")

  expect(row("api-slippage-bounds-and-risk-breaker").outcome).toEqual({
    defaultMaxSlippageBps: 100,
    capMaxSlippageBps: 5_000,
    presignCountsTowardRiskBreaker: false,
  })
})

test("Fast markets and stop losses docs match across all three copies and fastConnectFetch retries only API reads and trade builds once", () => {
  const docs = row("docs-fast-markets-and-stop-losses")
  expect(docs.args.files).toEqual([
    "docs/agent-trading.md",
    "apps/docs/src/content/docs/developers/agent-trading.md",
    "apps/frontend/public/docs/agent-trading.md",
  ])
  expect(docs.outcome.identicalCopies).toBe(true)
  const section = String(docs.outcome.text)
  expect(section).toContain('reason: "presign_refused"')
  expect(section).toContain("retryable: true")
  expect(section).toContain("Nothing was signed or broadcast")
  expect(section).toContain("clientTradeId")
  expect(section).toContain("100 bps (1%)")
  expect(section).toContain("5,000 bps (50%)")
  expect(section).toContain('cause: "slippage_exceeded"')
  expect(section).toContain("CandleApiError")
  expect(section).toContain("UND_ERR_CONNECT_TIMEOUT")
  expect(String(docs.outcome.sdkDocsErrors)).toContain("presign_refused")
  expect(String(docs.outcome.sdkChangelogEntry)).toContain("CandleApiError")

  const bounds = row("api-slippage-bounds-and-risk-breaker").outcome
  expect(section).toContain(`${bounds.defaultMaxSlippageBps} bps`)
  expect(section).toContain("5,000 bps")

  expect(row("docs-connect-retry-get-read").outcome).toMatchObject({
    agentOptions: { connect: { timeout: 3_000 } },
    attempts: 2,
    transports: ["undici", "undici"],
    status: 200,
    threwCode: null,
  })
  expect(row("docs-connect-retry-trade-build").outcome).toMatchObject({
    attempts: 2,
    transports: ["undici", "undici"],
    sameBodyAcrossAttempts: true,
    status: 200,
    threwCode: null,
  })
  expect(row("docs-connect-second-timeout-throws").outcome).toMatchObject({
    attempts: 2,
    transports: ["undici", "undici"],
    threwCode: "UND_ERR_CONNECT_TIMEOUT",
  })
  expect(row("docs-connect-headers-timeout-no-retry").outcome).toMatchObject({
    attempts: 1,
    transports: ["undici"],
    threwCode: "UND_ERR_HEADERS_TIMEOUT",
  })
  for (const id of [
    "docs-connect-submit-never-retried",
    "docs-connect-confirm-never-retried",
    "docs-connect-execute-never-retried",
    "docs-connect-other-origin-never-retried",
  ]) {
    expect(row(id).outcome, id).toMatchObject({
      attempts: 1,
      transports: ["default"],
      threwCode: "UND_ERR_CONNECT_TIMEOUT",
    })
  }
  expect(scenario("docs")).toHaveLength(9)
})
