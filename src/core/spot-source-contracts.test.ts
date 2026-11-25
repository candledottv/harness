// Hyperliquid spot, as Candle's source takes it: the API's pure spot gate, the pre-sign check every
// package ships, and `candle perps spot` in the CLI, recorded offline from one exact commit
// (scripts/read-spot-source.ts), and how candle_cli routes each spot command.
import { describe, expect, test } from "bun:test"
import perps from "../../test/fixtures/candle-perps-source.json"
import spot from "../../test/fixtures/candle-spot-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { catalogueFor } from "./cli-catalogue"
import { rowFor, SOURCE, SPOT_LATER, sourceFor } from "./cli-table"
import { describeTool, resolveCall } from "./cli-tool"

type Row = { id: string; surface: string; evidence?: string; args: Record<string, unknown>; requests?: { method: string; host?: string; path: string; body?: Record<string, unknown> }[]; outcome: any }
const rows = spot.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }
const resolve = (args: string[]) => resolveCall({ command: "perps", subcommand: "spot", args }, ctx)

test("the recording names the exact merged source, the same commit as the CLI table and the other source fixtures", () => {
  expect(spot.source).toMatchObject({ repo: "candledottv/candle-monorepo", commit: "5d7a861a83bcc5c4f2c3dace9897c325b3525e43", versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" } })
  expect(spot.source.commit).toBe(SOURCE.source.commit)
  expect(spot.source.commit).toBe(tools.source.commit)
  expect(spot.source.commit).toBe(perps.source.commit)
  // One pre-sign check, copied into the three packages: the recorder refuses to run if they differ.
  expect(spot.source.presignCheck.files).toEqual(["packages/sdk/src/hyperliquid.ts", "packages/mcp/src/hyperliquid.ts", "packages/cli/src/hyperliquid.ts"])
  expect(spot.source.presignCheck.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(rows).toHaveLength(59)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
})

test("nothing in the recording is a real address, key or account figure", () => {
  const text = JSON.stringify(spot)
  for (const hex of text.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) expect(hex).toMatch(/^0x0{39}[0-9]$/)
  // A client order id is 0x and 32 hex digits: only the made-up one.
  for (const cloid of text.match(/0x[0-9a-fA-F]{32}\b/g) ?? []) expect(cloid).toBe(`0x${"1".repeat(32)}`)
  expect(text).not.toContain("fixture-only-not-a-key")
  expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  // The CLI is asked by a stand-in: no signature, and nothing goes to Hyperliquid's exchange endpoint.
  for (const r of rows) expect((r.requests ?? []).some((q) => q.path === "/exchange")).toBe(false)
})

describe("the API's spot gate", () => {
  test("a pair resolves by name, case-folded name or @index to asset 10000 + its spot index, never its array position", () => {
    for (const id of ["pair-name", "at-index", "case-folded"]) expect(row(`api-gate-${id}`).outcome).toMatchObject({ ok: true, asset: 10_007, coin: "@7", pair: "ALPHA/USDC" })
    expect(row("api-gate-canonical").outcome).toMatchObject({ ok: true, asset: 10_000, coin: "CANON/USDC" })
    expect(row("api-gate-exact-of-ambiguous").outcome).toMatchObject({ ok: true, asset: 10_031 })
  })

  test("its terms: Hyperliquid's spot fee, and Candle's builder fee on the sell side only", () => {
    expect(row("api-gate-pair-name").outcome.terms).toEqual({ venue: "hyperliquid-spot", base: "ALPHA", quote: "USDC", takerFeePct: "0.07", makerFeePct: "0.04", builderFeeSide: "sell" })
  })

  test("delisted, below-floor, one-sided, unpriced, non-USDC, ambiguous and malformed markets are refused, each naming its rule", () => {
    const refused = (id: string, code: string, limit: string, status: number) => expect(row(`api-gate-${id}`).outcome).toMatchObject({ ok: false, code, limit, status })
    refused("delisted", "SPOT_MARKET_REFUSED", "market", 403)
    refused("delisted-index", "SPOT_MARKET_REFUSED", "market", 403)
    refused("below-floor", "SPOT_MARKET_REFUSED", "minDayVolume", 403)
    refused("one-sided-book", "SPOT_MARKET_REFUSED", "liquidity", 403)
    refused("non-usdc-quote", "SPOT_MARKET_REFUSED", "quote", 403)
    refused("ambiguous-fold", "SPOT_MARKET_REFUSED", "market", 403)
    refused("malformed", "VALIDATION_FAILED", "market", 400)
    expect(row("api-gate-no-mark").outcome).toMatchObject({ ok: false, code: "SPOT_UNAVAILABLE", status: 503, retryable: true })
    expect(row("api-gate-below-floor").outcome.message).toContain("below Candle's spot liquidity floor")
  })

  test("an exit isn't held to the volume floor, and a cancel needs no book", () => {
    expect(row("api-gate-below-floor-exit").outcome).toMatchObject({ ok: true, asset: 10_012, dayVolumeUsd: "5000" })
    expect(row("api-gate-one-sided-book-cancel").outcome).toEqual({ ok: true, asset: 10_015, coin: "@15", pair: "LOPSD/USDC" })
  })

  test("size, price and balance rules", () => {
    expect(row("api-gate-size-decimals").outcome).toMatchObject({ ok: false, limit: "size" })
    expect(row("api-gate-price-decimals").outcome).toMatchObject({ ok: false, limit: "price" })
    expect(row("api-gate-price-sig-figs").outcome).toMatchObject({ ok: false, limit: "price" })
    // A market order's price rounds back toward the mid, inside its slippage.
    expect(row("api-gate-slippage-buy").outcome.px).toBe("25.755")
    expect(row("api-gate-slippage-sell").outcome.px).toBe("25.245")
    expect(row("api-gate-sell-balance").outcome).toMatchObject({ ok: false, code: "SPOT_INSUFFICIENT_BALANCE", status: 409 })
    expect(row("api-gate-buy-balance").outcome.message).toContain("spot and perps balances are separate")
  })
})

describe("the pre-sign check (SDK, MCP and CLI copies agree on every case)", () => {
  test("an honest buy, sell, reduce-only sell and cancel pass", () => {
    for (const id of ["buy-honest", "sell-honest", "reduce-only-sell", "cancel-honest"]) expect(row(`presign-${id}`).outcome).toEqual({ ok: true, kind: "l1" })
  })

  test("each hostile change is refused before anything is signed", () => {
    const reasons: Record<string, string> = {
      "buy-with-builder": "a spot buy carries no builder fee",
      "sell-builder-above-cap": "outside Candle's 0.1% maximum",
      "sell-other-builder": "not Candle's",
      "wrong-pair-asset": "not the requested pair's",
      "perp-asset": "not a Hyperliquid spot market",
      "non-usdc-pair": "not quoted in USDC",
      "delisted-pair": "lists no such spot pair",
      "outside-slippage": "outside its slippage",
      "size-changed": "does not match the request",
      "side-flipped": "does not match the request",
      "reduce-only-buy": "reduce-only",
      "typed-data-other-action": "does not commit to this action",
      "cancel-other-oid": "does not name the order",
      "cancel-not-resting": "no order with this cloid",
    }
    for (const [id, reason] of Object.entries(reasons)) {
      const r = row(`presign-${id}`)
      expect(r.evidence).toContain("same answer")
      expect(r.outcome.ok).toBe(false)
      expect(r.outcome.reason).toContain(reason)
    }
    expect(row("presign-perps-method-refuses-spot-asset").outcome).toMatchObject({ ok: false })
  })

  test("it reads Hyperliquid itself: the pair for an order, the resting order and the pair for a cancel", () => {
    expect(row("presign-buy-honest").requests!.map((q) => q.body!.type)).toEqual(["spotMetaAndAssetCtxs"])
    expect(row("presign-cancel-honest").requests!.map((q) => q.body!.type)).toEqual(["orderStatus", "spotMetaAndAssetCtxs"])
  })
})

describe("candle perps spot in the CLI", () => {
  test("the pair, Hyperliquid's spot fee and the builder fee are shown before the prompt, and before the relay with --yes", () => {
    for (const side of ["buy", "sell"]) for (const when of ["prompt", "yes"]) {
      const r = row(`cli-${side}-${when}`)
      expect(r.outcome.stop).toBe(when === "yes" ? "before-relay" : "before-prompt")
      const shown = (r.outcome.disclosure as string[]).join(" ").replace(/\s+/g, " ")
      expect(shown).toContain("Market ALPHA/USDC (@7): Hyperliquid spot, ALPHA priced in USDC; no leverage.")
      expect(shown).toContain("Hyperliquid spot fee: taker 0.07%, maker 0.04%")
      expect(shown).toContain(side === "buy" ? "Candle builder fee: none (Hyperliquid charges no builder fee on spot buys)." : "fee: 10 bps.")
      expect(shown.indexOf("Hyperliquid spot fee")).toBeLessThan(shown.indexOf("Candle builder"))
      expect(r.requests!.some((q) => q.path.endsWith("/sign"))).toBe(when === "yes")
      // The CLI checks Candle's build against its own read of Hyperliquid before anything is signed.
      expect(r.requests!.filter((q) => q.host === "api.hyperliquid.xyz").map((q) => q.body!.type)).toEqual(["spotMetaAndAssetCtxs"])
    }
    expect(row("cli-cancel-prompt").outcome).toMatchObject({ stop: "before-prompt", disclosure: ["  · Cancel asset 10007 order 77."] })
  })

  test("a hostile build is refused before the relay is asked", () => {
    for (const id of ["hostile-buy-builder", "hostile-wrong-asset"]) {
      const r = row(`cli-${id}`)
      expect(r.outcome.body).toMatchObject({ ok: false, code: "PERPS_BUILD_REFUSED" })
      expect(r.outcome.body.message).toContain("Nothing was signed.")
      expect(r.requests!.some((q) => q.path.endsWith("/sign"))).toBe(false)
    }
  })

  test("the embedded wallet, a malformed pair and a resting order without a price are refused with nothing requested", () => {
    for (const id of ["embedded-wallet", "malformed-pair", "gtc-without-price"]) {
      const r = row(`cli-local-${id}`)
      expect(r.outcome).toMatchObject({ exitCode: 2, body: { ok: false, code: "USAGE" } })
      expect(r.requests).toEqual([])
    }
  })

  test("Candle's refusals for delisted, below-floor, one-sided and non-USDC markets come through with their code", () => {
    for (const id of ["delisted", "below-floor", "one-sided-book", "non-usdc-quote"]) {
      const r = row(`cli-refused-${id}`)
      expect(r.evidence).toContain("keyed API route not executed")
      expect(r.outcome.exitCode).not.toBe(0)
      expect(r.outcome.body).toMatchObject({ ok: false, code: "SPOT_MARKET_REFUSED", message: row(`api-gate-${id}`).outcome.message })
      expect(r.requests!.filter((q) => q.method === "POST").map((q) => q.path)).toEqual(["/api/v1/agent/perps/spot/order"])
      expect(r.requests!.some((q) => q.path.endsWith("/sign"))).toBe(false)
    }
  })

  test("the market list leaves refused pairs out, and --all lists them with why", () => {
    const plain = (row("cli-markets").outcome.text as string[]).join("\n")
    const all = (row("cli-markets-all").outcome.text as string[]).join("\n").replace(/\s+/g, " ")
    expect(plain).toContain("ALPHA/USDC (@7, asset 10007)")
    expect(plain).not.toContain("QUIET/USDC")
    expect(all).toContain("QUIET/USDC traded under 100000 USD in the last 24 hours, below Candle's spot liquidity floor")
    expect(all).toContain("LOPSD/USDC has no live two-sided order book")
  })
})

describe("how candle_cli routes perps spot", () => {
  test("the CLI table holds the command and each word its handler dispatches", () => {
    const entry = sourceFor("perps", "spot")!
    expect(entry).toMatchObject({ handler: "perpsSpot", identity: "agent", unlocks: "never" })
    expect(Object.keys(entry.actions!)).toEqual(["markets", "balances", "buy", "sell", "cancel"])
    expect(entry.flags!.boolean).toEqual(["--all", "--hide", "--no-submit", "--sign-only", "--yes"])
  })

  test("markets and balances run at once as reads with the agent's key", () => {
    for (const args of [["markets"], ["markets", "--all", "--limit", "20"], ["balances", "--wallet", "perps"]]) {
      const r = resolve(args)
      expect(r.ok && { rule: r.call.rule, route: r.call.route, identity: r.call.identity }).toEqual({ rule: "read", route: "cli", identity: "agent" })
    }
    expect(resolve(["markets", "HYPE/USDC"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
  })

  test("buy, sell and cancel are coming, so the user runs them in their own terminal where the CLI shows the fees", () => {
    for (const word of ["buy", "sell", "cancel"]) {
      expect(rowFor(`perps spot ${word}`)).toMatchObject({ rule: "card", route: "later", identity: "agent", note: SPOT_LATER })
      const r = resolve(word === "cancel" ? [word, `0x${"1".repeat(32)}`] : [word, "HYPE/USDC", "1"])
      expect(r.ok && r.call.route).toBe("later")
      const entry = catalogueFor(false).find((e) => e.path === `perps spot ${word}`)!
      expect(entry).toMatchObject({ availability: "coming", why: SPOT_LATER, documented: true })
      expect(catalogueFor(true).find((e) => e.path === `perps spot ${word}`)!.availability).toBe("coming")
    }
    const later = describeTool(false).split("\n").find((l) => l.startsWith("Later (perps writes)"))!
    expect(later).toContain("spot buy, sell, cancel")
  })

  test("the agent never passes --yes, a dry run or a sign-only run, and a later action word is refused", () => {
    expect(resolve(["buy", "HYPE/USDC", "1", "--yes"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve(["buy", "HYPE/USDC", "1", "--no-submit"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve(["sell", "@107", "1", "--sign-only"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve(["--limit", "5", "markets"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
    expect(resolve(["swap"])).toMatchObject({ ok: false, code: "BAD_ARGS" })
  })
})
