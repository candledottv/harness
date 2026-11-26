// Hyperliquid spot (HM2, BE-3772) recorded from the published npm packages by `scripts/run-spot-packages.ts`.
// Nothing is signed, submitted or sent over a network.
import { describe, expect, test } from "bun:test"
import pins from "../../scripts/spot-packages.json"
import packaged from "../../test/fixtures/candle-spot-packages.json"

type Row = { id: string; scenario: string; surface: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = packaged.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing spot recording ${id}`)
  return found
}

describe("pinned to the published npm packages", () => {
  test("exact versions and hashes, and the card's unpublished versions are not used", () => {
    expect(Object.fromEntries(Object.entries(packaged.packages).map(([n, p]) => [n, p.version]))).toEqual(pins)
    expect(pins).toEqual({ "@candledottv/cli": "0.13.47", "@candledottv/mcp": "0.10.45", "@candledottv/agent-sdk": "0.6.39" })
    for (const p of Object.values(packaged.packages)) expect((p as { integrity?: string }).integrity).toMatch(/^sha512-/)
    expect(rows).toHaveLength(19)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })

  test("no key, wallet address or secret, and no request left the process", () => {
    const text = JSON.stringify(packaged)
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/)
    expect(text).not.toContain("BEGIN")
    expect(text).not.toContain("fixture-only-not-a-key")
  })
})

describe("spot orders: --hide and its echo check (SDK)", () => {
  test("a hidden spot order whose build lacks the echo is refused after the one build request", () => {
    for (const id of ["sdk-spot-order-hide-without-echo-refused", "sdk-spot-order-by-index-hide-without-echo-refused"]) {
      const r = row(id)
      expect(r.outcome.refused.code).toBe("HIDE_NOT_CONFIRMED")
      expect(r.outcome.requests).toHaveLength(1)
      expect(r.outcome.requests[0]).toMatchObject({ path: "/api/v1/agent/perps/spot/order", sendsHide: true })
    }
    expect(row("sdk-spot-order-by-index-hide-without-echo-refused").outcome.requests[0].market).toBe("@107")
  })
  test("without hide the body has no hide key", () => {
    expect(row("sdk-spot-order-without-hide-sends-no-hide-key").outcome).toEqual({ bodiesWithAHideKey: 0, requests: 2 })
  })
  test("embedded wallet, a bad side and a bad cloid are refused with nothing requested", () => {
    const o = row("sdk-spot-refusals-send-nothing").outcome
    expect(o.requests).toBe(0)
    expect(o.embeddedOrder.message).toContain("signs only from the key's EVM TEE wallet")
    expect(o.embeddedBalances.message).toContain("embedded wallet is not offered for spot")
    expect(o.badSide.message).toContain("side must be buy or sell")
    expect(o.badCloid.message).toContain("0x followed by 32 hex digits")
  })
  test("market and balance reads", () => {
    expect(row("sdk-spot-reads-paths").outcome.requests).toEqual([
      "GET /api/v1/agent/perps/spot/markets?limit=5&all=true",
      "GET /api/v1/agent/perps/spot/markets",
      "GET /api/v1/agent/perps/spot/balances?walletId=wallet-fixture",
    ])
  })
})

describe("holdings and realized P&L carry the venue tag (SDK)", () => {
  test("positions keep both spot shapes; the Hyperliquid row has no mint or chain", () => {
    const o = row("sdk-positions-carry-venue-tag").outcome
    expect(o.path).toBe("/api/v1/agent/records/profile-fixture/positions?kind=spot")
    expect(o.venues).toEqual(["solana", "hyperliquid"])
    expect(o.hyperliquidRowHasMintOrChain).toBe(false)
    expect(o.successKeyDropped).toBe(true)
  })
  test("the record carries hyperliquidSpot figures", () => {
    expect(row("sdk-record-carries-hyperliquid-spot-figures").outcome.hyperliquidSpot).toMatchObject({ realizedUsd: 4.2, trades: 6 })
  })
})

describe("published CLI, MCP and SDK dist (symbol pins)", () => {
  const pinned = rows.filter((r) => r.scenario === "package-text")
  test("every pin was found and names a file and a symbol", () => {
    expect(pinned).toHaveLength(12)
    for (const r of pinned) {
      expect(r.outcome.found).toBe(true)
      expect(r.args.file).toContain("@candledottv/")
      expect(String(r.args.symbol).length).toBeGreaterThan(3)
    }
  })
  test("the CLI shows fees before the order, takes @index and --hide, refuses delisted, and prints the venue rows", () => {
    for (const id of ["cli-usage-spot-buy-sell-with-hide", "cli-resolves-at-index", "cli-spot-fee-and-builder-fee-before-the-order", "cli-delisted-refusal", "cli-positions-hyperliquid-spot-row", "cli-record-hyperliquid-spot-line"]) {
      expect(row(id).surface).toBe("cli")
    }
  })
  test("the MCP spot tools sign from the TEE wallet only and a spot buy has no builder field", () => {
    for (const id of ["mcp-spot-tools", "mcp-spot-signs-only-from-tee-wallet", "mcp-spot-buy-has-no-builder-field", "mcp-positions-kind-spot-or-perp"]) {
      expect(row(id).surface).toBe("mcp")
    }
  })
})
