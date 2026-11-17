import { expect, test } from "bun:test"
import contracts from "../../test/fixtures/candle-source-contracts.json"
import pairs from "./launch-quotes.json"
import { launchSelection } from "./launch-quote"

test("fixed selection and refusal codes match the recorded MCP and SDK contracts", () => {
  for (const row of contracts.rows.filter((r) => r.surface === "mcp+sdk")) {
    const result = launchSelection(row.input!)
    const expected = row.outcome as { ok: boolean; args?: Record<string, unknown>; code?: string }
    expect(result.ok).toBe(expected.ok)
    if (result.ok) expect(result.args).toEqual(expected.args!)
    else expect(result.code).toBe(expected.code!)
  }
})

test("every fixed pair's symbol and address select the correct chain and decimal scale", () => {
  for (const pair of pairs.fixedPairs) {
    for (const quote of [pair.id.toUpperCase(), pair.address, ...(pair.chain === "hood" ? [pair.address.toUpperCase()] : [])]) {
      expect(launchSelection({ quote, buyAmount: "50" })).toEqual({ ok: true, args: { quoteAsset: pair.id, chain: pair.chain, buyAmount: "50" } })
    }
  }
  expect(launchSelection({ quote: pairs.fixedPairs[0]!.address.toLowerCase() })).toMatchObject({ ok: false, code: "QUOTE_LAUNCH_UNAVAILABLE" })
})
