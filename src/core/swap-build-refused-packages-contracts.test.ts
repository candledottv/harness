// Swap build refusal (BE-4462, the harness sibling of BE-4461, candle-monorepo #4279) recorded from the published
// `@candledottv/cli` by `scripts/run-swap-build-refused-packages.ts`. Offline stand-ins with mapped codes only;
// nothing is signed, submitted or sent over a network.
import { describe, expect, test } from "bun:test"
import pins from "../../scripts/swap-build-refused-packages.json"
import packaged from "../../test/fixtures/candle-swap-build-refused-packages.json"

type Row = { id: string; args: { apiStatus: number; apiBody: { error: Record<string, unknown> } }; requests: { path: string; rpc?: string }[]; outcome: { exitCode: number; json: Record<string, any>; signedOrSubmitted: boolean } }
const rows = packaged.rows as unknown as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing swap build recording ${id}`)
  return found
}
const DETAIL_KEYS = ["stage", "reason", "refusal", "detail", "cause", "retryable"]

describe("pinned to the published CLI", () => {
  test("version, hash and rows", () => {
    expect(pins).toEqual({ "@candledottv/cli": "0.13.51" })
    expect(packaged.packages["@candledottv/cli"].version).toBe("0.13.51")
    expect(packaged.packages["@candledottv/cli"].integrity).toMatch(/^sha512-/)
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })
  test("no key, secret, address or local path", () => {
    const text = JSON.stringify(packaged)
    for (const bad of ["BEGIN", "fixture-only-not-a-key", "fixture-passphrase", "/tmp/", "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB", "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"]) expect(text).not.toContain(bad)
  })
})

describe("candle swap when the build is refused with 422 PRESIGN_SIMULATION_REFUSED", () => {
  for (const [id, cause] of [["cli-swap-build-422-slippage-exceeded", "slippage_exceeded"], ["cli-swap-build-422-insufficient-lamports", "insufficient_lamports"]] as const) {
    test(`${cause}: code, exit 1 and structured details`, () => {
      const r = row(id)
      expect(r.args.apiStatus).toBe(422)
      expect(r.outcome.exitCode).toBe(1)
      expect(r.outcome.json.ok).toBe(false)
      expect(r.outcome.json.code).toBe("PRESIGN_SIMULATION_REFUSED")
      expect(Object.keys(r.outcome.json.details).sort()).toEqual([...DETAIL_KEYS].sort())
      expect(r.outcome.json.details).toMatchObject({ stage: "not_broadcast", reason: "presign_refused", refusal: "simulation_failed", cause, retryable: true })
      expect(typeof r.outcome.json.details.detail).toBe("string")
      // The CLI relays the API's refusal as sent.
      for (const k of DETAIL_KEYS) expect(r.outcome.json.details[k]).toEqual(r.args.apiBody.error[k])
    })
  }
  test("without a cause the CLI keeps the other details and invents none", () => {
    const d = row("cli-swap-build-422-no-cause").outcome.json.details
    expect(d).not.toHaveProperty("cause")
    expect(d).toMatchObject({ stage: "not_broadcast", reason: "presign_refused", refusal: "simulation_failed", retryable: true })
  })
})

describe("a 500 SWAP_FAILED (guard could not run) stays a 5xx-class outcome", () => {
  test("not relabelled as PRESIGN_SIMULATION_REFUSED", () => {
    const r = row("cli-swap-build-500-guard-could-not-run")
    expect(r.args.apiStatus).toBe(500)
    expect(r.outcome.exitCode).toBe(1)
    expect(r.outcome.json.code).toBe("SWAP_FAILED")
    expect(r.outcome.json.details.refusal).toBe("simulation_failed")
  })
})

describe("nothing is signed or submitted", () => {
  test("one build request, no submit, execute or RPC send", () => {
    for (const r of rows) {
      expect(r.outcome.signedOrSubmitted).toBe(false)
      expect(r.requests.filter((q) => q.path === "/api/v1/agent/swap/build")).toHaveLength(1)
      expect(r.requests.some((q) => /\/swap\/(submit|execute)$/.test(q.path) || q.rpc === "sendTransaction")).toBe(false)
    }
  })
})
