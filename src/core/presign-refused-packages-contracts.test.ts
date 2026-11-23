// Pre-sign build refusals (`reason: "presign_refused"`) and stop-loss retry contracts (BE-4292, BE-4293, BE-4342,
// BE-4345) recorded directly from the PUBLISHED npm packages (`scripts/presign-refused-packages.json`, run by
// `scripts/run-presign-refused-packages.ts`): `@candledottv/agent-sdk` 0.6.39, `@candledottv/mcp` 0.10.45 and
// `@candledottv/cli` 0.13.47. Nothing is signed, submitted or sent over a network.
import { describe, expect, test } from "bun:test"
import pins from "../../scripts/presign-refused-packages.json"
import packaged from "../../test/fixtures/candle-presign-refused-packages.json"
import source from "../../test/fixtures/candle-presign-refused-source.json"
import { toOutcome } from "./candle-mcp"
import { mapCliTrade } from "./cli-trade"
import { outcomeOf } from "./execute"

type WireCall = { n: number; method: string; host: string; path: string; rpc?: string; clientTradeId?: string; maxSlippageBps?: number }
type Row = { id: string; scenario: string; surface: string; args: Record<string, any>; requests?: WireCall[]; outcome: Record<string, any> }
const rows = packaged.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing package recording ${id}`)
  return found
}

describe("pinned to the published npm packages", () => {
  test("exact versions, registry integrity hashes, shipped entry points and agreement with the release commit", () => {
    expect(packaged.packages).toEqual({
      "@candledottv/cli": { version: "0.13.47", integrity: expect.stringMatching(/^sha512-/) },
      "@candledottv/mcp": { version: "0.10.45", integrity: expect.stringMatching(/^sha512-/) },
      "@candledottv/agent-sdk": { version: "0.6.39", integrity: expect.stringMatching(/^sha512-/) },
    })
    expect(Object.fromEntries(Object.entries(packaged.packages).map(([n, p]) => [n, p.version]))).toEqual(pins)
    expect(pins["@candledottv/cli"]).toBe(source.source.versions.cli)
    expect(pins["@candledottv/mcp"]).toBe(source.source.versions.mcp)
    expect(pins["@candledottv/agent-sdk"]).toBe(source.source.versions.sdk)
    expect(packaged.entryPoints).toEqual({ sdk: "./dist/index.js", mcp: "./dist/index.js", cli: "./dist/index.js" })
    expect(rows).toHaveLength(16)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })

  test("nothing in the package recording is a real key, wallet address or secret, and every call hits a stand-in host", () => {
    const text = JSON.stringify(packaged)
    for (const forbidden of [
      "fixture-only-not-a-key",
      "fixture-passphrase-not-secret",
      "7ZL9FvkpCMg",
      "9dXSV8VWuYv",
      "JUP6LkbZbjS",
      "BEGIN",
    ]) {
      expect(text).not.toContain(forbidden)
    }
    const hosts = new Set(rows.flatMap((r) => (r.requests ?? []).map((q) => q.host)))
    expect([...hosts]).toEqual(["api.test"])
  })
})

describe("published @candledottv/agent-sdk@0.6.39 refusal and rebuild contracts", () => {
  test("CandleApiError preserves refusal, detail and requestId on presign_refused envelopes and ignores absent or non-string fields", () => {
    expect(row("sdk-pkg-slippage-refused").args.wireCause).toBe("slippage_exceeded")
    expect(row("sdk-pkg-slippage-refused").outcome).toMatchObject({
      code: "SWAP_FAILED",
      status: 500,
      retryable: true,
      stage: "not_broadcast",
      reason: "presign_refused",
      refusal: "simulation_failed",
      requestId: "req_fixture_064152",
    })
    expect(row("sdk-pkg-slippage-refused").outcome.detail).toContain("maxSlippageBps (default 100, cap 5000)")
    expect(row("sdk-pkg-slippage-refused").outcome.message).toContain("(request id req_fixture_064152)")

    expect(row("sdk-pkg-fee-mismatch").outcome).toMatchObject({
      code: "SWAP_FAILED",
      status: 500,
      retryable: true,
      stage: "not_broadcast",
      reason: "presign_refused",
      refusal: "fee_amount_mismatch",
      detail: "expected fee 50000 lamports, simulated transfer 48500 lamports",
    })

    expect(row("sdk-pkg-insufficient-lamports").outcome).toMatchObject({
      code: "INSUFFICIENT_OWNER_BALANCE",
      status: 400,
      retryable: false,
      stage: "not_broadcast",
      reason: "presign_refused",
      refusal: "simulation_failed",
      detail: "Transfer: insufficient lamports 900000, need 2039280",
    })

    expect(row("sdk-pkg-no-presign-fields").outcome).toMatchObject({
      code: "SPEND_LIMIT_EXCEEDED",
      status: 403,
      retryable: false,
      reason: null,
      refusal: null,
      detail: null,
    })
    expect(row("sdk-pkg-non-string-ignored").outcome).toMatchObject({
      code: "SWAP_FAILED",
      reason: "presign_refused",
      refusal: null,
      detail: null,
    })
    expect(row("sdk-pkg-non-json-502").outcome).toMatchObject({
      code: "HTTP_502",
      status: 502,
      retryable: false,
      refusal: null,
      detail: null,
      requestId: "req_proxy_502_abcd",
    })
  })

  test("CandleClient.buildTrade() and trade() expose refusal and detail without signing or blind-retrying, and immediate rebuilds succeed", () => {
    const buildRefused = row("sdk-pkg-build-trade-presign-refused")
    expect(buildRefused.requests).toHaveLength(1)
    expect(buildRefused.requests![0]).toMatchObject({ method: "POST", path: "/api/v1/trade/agent/build", clientTradeId: "stop-sell-1" })
    expect(buildRefused.outcome).toMatchObject({
      threw: "CandleApiError",
      code: "SWAP_FAILED",
      status: 500,
      retryable: true,
      stage: "not_broadcast",
      reason: "presign_refused",
      refusal: "simulation_failed",
      requestId: "req_build_refused_1",
      clientTradeId: null,
    })
    expect(buildRefused.outcome.detail).toContain("maxSlippageBps (default 100, cap 5000)")

    const oneCall = row("sdk-pkg-one-call-trade-presign-refused")
    expect(oneCall.requests).toHaveLength(1)
    expect(oneCall.outcome).toMatchObject({
      threw: "CandleApiError",
      code: "SWAP_FAILED",
      retryable: true,
      stage: "not_broadcast",
      reason: "presign_refused",
      refusal: "simulation_failed",
      requestId: "req_onecall_refused_1",
      clientTradeId: "stop-sell-onecall",
      signedCalls: 0,
    })
    expect(oneCall.outcome.detail).toContain("retry at once")

    const sameId = row("sdk-pkg-retry-same-id-fresh-quote")
    expect(sameId.requests?.map((q) => q.clientTradeId)).toEqual(["stop-sell-same-id", "stop-sell-same-id"])
    expect(sameId.outcome).toMatchObject({
      firstRefusal: "simulation_failed",
      firstRetryable: true,
      secondStatus: "built",
      sameClientTradeId: true,
    })

    const wider = row("sdk-pkg-retry-wider-slippage-new-id")
    expect(wider.requests?.map((q) => [q.clientTradeId, q.maxSlippageBps])).toEqual([
      ["stop-sell-100bps", 100],
      ["stop-sell-500bps", 500],
    ])
    expect(wider.outcome).toMatchObject({
      firstRefusal: "simulation_failed",
      secondStatus: "built",
      distinctClientTradeId: true,
    })
    expect(Number(wider.outcome.minOutRawAt500Bps)).toBeLessThan(Number(sameId.outcome.minOutRaw))
  })

  test("the published SDK tarball documents presign_refused in README.md and types refusal and detail on CandleApiError", () => {
    expect(String(row("sdk-pkg-readme-errors").outcome.text)).toContain('reason: "presign_refused"')
    expect(String(row("sdk-pkg-readme-errors").outcome.text)).toContain("`refusal`")
    expect(String(row("sdk-pkg-readme-errors").outcome.text)).toContain("`detail`")
    expect(row("sdk-pkg-dts-fields").outcome).toEqual({
      payloadRefusal: true,
      payloadDetail: true,
      classRefusal: true,
      classDetail: true,
      classRequestId: true,
    })
  })
})

describe("shipped @candledottv/mcp@0.10.45 and @candledottv/cli@0.13.47 through the Candle Harness", () => {
  test("candle-mcp relays refusal, detail and cause \"slippage_exceeded\", and outcomeOf surfaces all three on OperationError", () => {
    const stopSell = row("mcp-pkg-trade-stop-sell-presign-slippage")
    expect(stopSell.requests?.[0]).toMatchObject({ method: "GET", path: "/api/v1/agent/keys/self/public-profile" })
    const tradeOutcome = toOutcome({ content: [{ type: "text", text: JSON.stringify(stopSell.outcome.reply) }], isError: stopSell.outcome.isError })
    const mappedTrade = outcomeOf("trade", tradeOutcome)
    expect(mappedTrade).toMatchObject({
      state: "refused",
      error: {
        code: "SWAP_FAILED",
        retryable: true,
        stage: "not_broadcast",
        reason: "presign_refused",
        refusal: "simulation_failed",
        cause: "slippage_exceeded",
      },
    })
    expect(mappedTrade.error!.detail).toContain("maxSlippageBps (default 100, cap 5000)")
    expect(mappedTrade.error!.message).toContain("simulation_failed")
    expect(mappedTrade.error!.message).toContain("slippage_exceeded")
    expect(mappedTrade.error!.message).toContain("maxSlippageBps")

    const unfunded = row("mcp-pkg-trade-buy-presign-insufficient-lamports")
    // MCP 0.10.45 sends `amountDecimal` directly after its startup profile read (no market read).
    expect(unfunded.requests?.map((q) => q.path)).toEqual(["/api/v1/agent/keys/self/public-profile", "/api/v1/trade/agent/build"])
    const unfundedOutcome = toOutcome({ content: [{ type: "text", text: JSON.stringify(unfunded.outcome.reply) }], isError: unfunded.outcome.isError })
    const mappedUnfunded = outcomeOf("trade", unfundedOutcome)
    expect(mappedUnfunded).toMatchObject({
      state: "refused",
      error: {
        code: "INSUFFICIENT_OWNER_BALANCE",
        retryable: false,
        stage: "not_broadcast",
        reason: "presign_refused",
        refusal: "simulation_failed",
      },
    })
    expect(mappedUnfunded.error!.detail).toContain("insufficient lamports")
    expect(mappedUnfunded.error!.message).toContain("Send SOL to it")

    const swap = row("mcp-pkg-swap-presign-slippage")
    const swapOutcome = toOutcome({ content: [{ type: "text", text: JSON.stringify(swap.outcome.reply) }], isError: swap.outcome.isError })
    const mappedSwap = outcomeOf("swap", swapOutcome)
    expect(mappedSwap).toMatchObject({
      state: "refused",
      error: {
        code: "SWAP_FAILED",
        retryable: true,
        stage: "not_broadcast",
        reason: "presign_refused",
        refusal: "simulation_failed",
        cause: "slippage_exceeded",
      },
    })
    expect(mappedSwap.error!.message).toContain("slippage_exceeded")
  })

  test("the shipped candle CLI exits 1 on a presign_refused TEE swap and mapCliTrade marks it refused before signing", () => {
    const cliRun = row("cli-pkg-swap-presign-slippage")
    expect(cliRun.outcome.exitCode).toBe(1)
    const mapped = mapCliTrade(
      "trade",
      { exitCode: cliRun.outcome.exitCode, timedOut: false, json: cliRun.outcome.json },
      { found: false, detail: "JOB_NOT_FOUND" },
    )
    expect(mapped).toMatchObject({
      state: "refused",
      error: { code: "SWAP_FAILED" },
    })
    expect(mapped.error!.message).toContain("before anything was signed")
    expect(mapped.error!.message).toContain("simulation_failed")
  })
})
