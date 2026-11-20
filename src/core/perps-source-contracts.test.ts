import { describe, expect, test } from "bun:test"
import perps from "../../test/fixtures/candle-perps-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { toOutcome } from "./candle-mcp"
import { classify } from "./classify"
import { SOURCE } from "./cli-table"

const rows = perps.rows as { id: string; surface: string; evidence?: string; args: Record<string, unknown>; requests: { method: string; path: string; body?: Record<string, unknown> }[]; outcome: any }[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const envelope = (id: string) => {
  const { outcome } = row(id)
  return toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: outcome.isError })
}

test("builder contracts, CLI flags and MCP schemas name the exact merged source and its separate package versions", () => {
  expect(perps.source).toEqual({ repo: "candledottv/candle-monorepo", commit: "31e075fe6ab401b03a562a2caba090f398b13fcd", versions: { cli: "0.13.34", mcp: "0.10.39", sdk: "0.6.28" } })
  expect(rows).toHaveLength(25)
  expect(new Set(rows.map((r) => r.id)).size).toBe(25)
  expect(perps.source.commit).toBe(SOURCE.source.commit)
  expect(perps.source.commit).toBe(tools.source.commit)
  expect(SOURCE.commands.find((r) => r.command === "perps" && r.subcommand === "markets")!.flags!.value).toContain("--dex")
  expect(tools.tools.find((t) => t.name === "candle_perps_markets")!.inputSchema.properties).toHaveProperty("dex")
})

describe("builder-dex refusal and disclosure recordings", () => {
  for (const surface of ["cli", "mcp", "sdk"]) {
    test(`${surface}: build refusals survive the result shape and request no signing or submission`, () => {
      for (const [id, code] of Object.entries({ "isolated-cross": "VALIDATION_FAILED", "above-max": "PERPS_LIMIT_EXCEEDED", delisted: "PERPS_MARKET_REFUSED", collateral: "PERPS_MARKET_REFUSED", "halted-open": "PERPS_MARKET_REFUSED" })) {
        const r = row(`${surface}-${id}`)
        expect(r.evidence).toContain("response-stub:")
        expect(r.evidence).toContain("keyed API route not executed")
        expect(r.outcome.isError).toBe(true)
        expect(envelope(`${surface}-${id}`).kind).not.toBe("ok")
        expect(r.requests.some((q) => /\/sign$|\/exchange$/.test(q.path))).toBe(false)
        // CLI failures use {ok:false, code}; MCP and SDK use {error:{code}}. Both stay errors here.
        expect(JSON.stringify(envelope(`${surface}-${id}`))).toContain(code)
        expect(row(`${surface}-${id}`).requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/v1/agent/perps/${id === "isolated-cross" || id === "above-max" ? "leverage" : "open"}`])
      }
    })
  }

  test("CLI terms are visible before the prompt and before the intercepted relay with --yes", () => {
    for (const id of ["prompt", "yes"]) {
      const r = row(`cli-order-${id}`)
      expect(r.outcome.stop).toBe(id === "yes" ? "before-relay" : "before-prompt")
      const shown = r.outcome.disclosure.replace(/\s+/g, " ")
      for (const fragment of ["Market xyz:TSLA: builder dex xyz (XYZ)", "deployed by", "sets the oracle price", "isolated margin only; collateral USDC", "3x the main exchange's", "taker 0.135%", "maker 0.045%", "above Candle's 2x warning line"]) expect(shown).toContain(fragment)
      expect(shown.indexOf("Hyperliquid venue fee")).toBeLessThan(shown.indexOf("Candle builder"))
      expect(r.requests.some((q) => q.path.endsWith("/exchange"))).toBe(false)
      expect(r.requests.some((q) => q.path.endsWith("/sign"))).toBe(id === "yes")
    }
  })

  test("MCP and SDK TP/SL dry runs retain terms and fee warnings on each built step", () => {
    for (const surface of ["mcp", "sdk"]) for (const leg of ["tp", "sl"]) for (const operation of ["attach", "replace"]) {
      const r = row(`${surface}-tpsl-${leg}-${operation}`)
      expect(r.outcome.complete).toBe(false)
      expect(r.outcome.steps.map((s: any) => s.status)).toEqual(operation === "replace" ? ["built", "planned"] : ["built"])
      const built = r.outcome.steps.filter((s: any) => s.preview)
      expect(built).toHaveLength(1)
      expect(built[0].preview.terms).toMatchObject({ dex: "xyz", oracleSource: "deployer", marginMode: "isolated", collateral: "USDC", feeMultiplier: "3", takerFeePct: "0.135", makerFeePct: "0.045" })
      expect(r.outcome.warnings).toContain(built[0].preview.terms.feeWarning)
      expect(r.requests.some((q) => /\/sign$|\/exchange$/.test(q.path))).toBe(false)
    }
  })

  test("reads remain reads and perps writes keep the Harness's card routing", () => {
    for (const tool of ["candle_perps_markets", "candle_perps_market"]) expect(classify(tool, { coin: "xyz:TSLA", dex: "xyz" }, "live").class).toBe("read")
    expect(classify("candle_perps_open", { coin: "xyz:TSLA" }, "live").class).toBe("refused")
  })
})
