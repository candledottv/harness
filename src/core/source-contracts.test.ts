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

// Builder-deployed (HIP-3) perps markets: synthetic venue, made-up dexes and addresses, MCP and SDK source.
type Hip3Row = { id: string; surface: string; requests?: { method: string; path: string; body?: { type?: string; dex?: string } }[]; outcome: any }
const hip3 = (id: string) => contracts.rows.find((r) => r.id === id) as unknown as Hip3Row

test("HIP-3 reads: MCP and SDK name builder markets dex:COIN, number their assets per dex, and agree", () => {
  const ids = contracts.rows.filter((r) => r.id.startsWith("hip3-mcp-")).map((r) => r.id.slice("hip3-mcp-".length))
  expect(ids).toHaveLength(13)
  for (const id of ids) {
    const mcp = hip3(`hip3-mcp-${id}`)
    const sdk = hip3(`hip3-sdk-${id}`)
    if (id === "markets-bad-dex") {
      // MCP's schema refuses the filter before any read; the SDK refuses it as a usage error. Neither reads anything.
      expect(mcp.outcome).toMatchObject({ isError: true, body: { error: { code: "MCP_VALIDATION" } } })
      expect(sdk.outcome).toMatchObject({ isError: true, body: { error: { code: "PERPS_USAGE" } } })
      expect(mcp.requests).toEqual([])
      expect(sdk.requests).toEqual([])
      continue
    }
    expect(sdk.requests).toEqual(mcp.requests!)
    if (mcp.outcome.isError) expect(sdk.outcome.body.error.code).toBe(mcp.outcome.body.error.code)
    else expect(sdk.outcome).toEqual(mcp.outcome)
    // Reads only: Candle's config and Hyperliquid's public info, never an exchange, sign or order path.
    for (const q of mcp.requests!) expect(q.path === "/api/v1/agent/perps/config" ? q.method : q.path).toBe(q.path === "/api/v1/agent/perps/config" ? "GET" : "hyperliquid:/info")
  }
  const all = hip3("hip3-mcp-markets-all").outcome.body
  expect(all.markets.map((m: any) => [m.coin, m.asset, m.dex])).toEqual([
    ["BTC", 0, ""], ["halt:OIL", 130000, "halt"], ["usdt:SPX", 120000, "usdt"], ["xyz:GOLD", 110001, "xyz"], ["xyz:OLD", 110002, "xyz"], ["xyz:TSLA", 110000, "xyz"],
  ])
  // The main exchange alone is unchanged: no dex list, BTC at its meta index, validators set its oracle.
  const main = hip3("hip3-mcp-markets-main").outcome.body
  expect(main.dexes).toBeUndefined()
  expect(main.markets.map((m: any) => m.coin)).toEqual(["BTC"])
  expect(hip3("hip3-mcp-market-main").outcome.body.market.terms).toMatchObject({ dex: "", oracleSource: "validators", feeMultiplier: "1", feeWarning: null })
  // --dex xyz reads that dex's universe by name and lists the dex with its deployer, oracle setters and collateral.
  const xyz = hip3("hip3-mcp-markets-xyz")
  expect(xyz.requests!.filter((q) => q.body?.type === "metaAndAssetCtxs").map((q) => q.body!.dex ?? "")).toEqual(["xyz"])
  expect(xyz.outcome.body.dexes).toEqual([{ index: 1, name: "xyz", fullName: "XYZ Fixture", deployer: "0x00000000000000000000000000000000000000d1", oracleUpdater: null, oracleSetters: ["0x00000000000000000000000000000000000000a1"], collateral: "USDC", tradeable: true }])
})

test("HIP-3 terms before an order: dex, oracle, deployer, margin mode, max leverage and fee, with the above-2x warning", () => {
  const tsla = hip3("hip3-mcp-market-tsla").outcome.body.market
  expect(tsla).toMatchObject({ coin: "xyz:TSLA", asset: 110000, maxLeverage: 10, onlyIsolated: false, candle: { tradeable: true } })
  expect(tsla.terms).toEqual({ dex: "xyz", dexName: "XYZ Fixture", deployer: "0x00000000000000000000000000000000000000d1", oracleSource: "deployer", oracleSetters: ["0x00000000000000000000000000000000000000a1"], marginMode: "cross", collateral: "USDC", feeMultiplier: "1.5", takerFeePct: "0.0675", makerFeePct: "0.0225", feeWarning: null })
  const gold = hip3("hip3-mcp-market-gold").outcome.body.market
  expect(gold).toMatchObject({ coin: "xyz:GOLD", maxLeverage: 20, onlyIsolated: true, candle: { tradeable: true } })
  expect(gold.terms).toMatchObject({ marginMode: "isolated", feeMultiplier: "3" })
  // A fee above 2x the main exchange's warns and never refuses.
  expect(gold.terms.feeWarning).toContain("3x the main exchange's fee")
})

test("HIP-3 refusals: delisted, non-USDC dex, the per-dex kill switch, unknown and malformed names", () => {
  const reason = (id: string) => hip3(`hip3-mcp-market-${id}`).outcome.body.market.candle
  expect(reason("delisted")).toEqual({ tradeable: false, reason: "delisted" })
  expect(reason("usdt")).toEqual({ tradeable: false, reason: "collateral" })
  expect(reason("halted")).toEqual({ tradeable: false, reason: "dexOpensRefused" })
  expect(hip3("hip3-mcp-market-usdt").outcome.body.market.terms.collateral).toBe("USDT0")
  // Without all, the refused markets are left out of the list; the dex list still says which dexes can't trade.
  const tradeable = hip3("hip3-mcp-markets-all-tradeable").outcome.body
  expect(tradeable.markets.map((m: any) => m.coin)).toEqual(["BTC", "xyz:GOLD", "xyz:TSLA"])
  expect(tradeable.dexes.map((d: any) => [d.name, d.collateral, d.tradeable])).toEqual([["xyz", "USDC", true], ["usdt", "USDT0", false], ["halt", "USDC", false]])
  expect(tradeable.gate.dexOpensRefused).toEqual(["halt"])
  expect(hip3("hip3-mcp-market-unknown-dex").outcome).toMatchObject({ isError: true, body: { error: { code: "PERPS_MARKET_NOT_FOUND" } } })
  expect(hip3("hip3-mcp-market-malformed").outcome).toMatchObject({ isError: true, body: { error: { code: "PERPS_MARKET_NOT_FOUND" } } })
})

test("HIP-3 gate (API source): the kill switch refuses opens and lets closes resolve; other refusals hold on both", () => {
  const gate = (config: "open" | "closing", coin: string) => hip3(`hip3-gate-${config}-${coin === "BTC" ? "main" : coin.split(":")[0]}-${coin}`).outcome
  expect(gate("open", "halt:OIL")).toMatchObject({ ok: false, code: "PERPS_MARKET_REFUSED", limit: "dexOpensRefused", status: 403 })
  expect(gate("open", "halt:OIL").message).toContain("closing stays open")
  expect(gate("closing", "halt:OIL")).toMatchObject({ ok: true, market: { coin: "halt:OIL", asset: 130000, dex: "halt" } })
  for (const config of ["open", "closing"] as const) {
    expect(gate(config, "xyz:OLD")).toMatchObject({ ok: false, limit: "market" })
    expect(gate(config, "xyz:OLD").message).toContain("delisted")
    expect(gate(config, "usdt:SPX")).toMatchObject({ ok: false, limit: "collateral" })
    expect(gate(config, "usdt:SPX").message).toContain("USDT0")
    expect(hip3(`hip3-gate-${config}-xyz-xyz:TS-LA`).outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED", status: 400 })
    // The leverage cap and margin mode the build enforces are the market's own: isolated only on xyz:GOLD, up to 20x.
    expect(gate(config, "xyz:GOLD")).toMatchObject({ ok: true, market: { maxLeverage: 20, onlyIsolated: true, terms: { marginMode: "isolated" } } })
    expect(gate(config, "BTC")).toMatchObject({ ok: true, market: { asset: 0, dex: "", maxLeverage: 40 } })
  }
  // A builder name is never resolved against the main exchange's list.
  expect(["open", "closing"].map((c) => hip3(`hip3-gate-${c}-main-xyz:TSLA`).outcome)).toEqual([
    expect.objectContaining({ ok: false, code: "PERPS_MARKET_REFUSED" }),
    expect.objectContaining({ ok: false, code: "PERPS_MARKET_REFUSED" }),
  ])
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
