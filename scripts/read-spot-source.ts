// Offline Hyperliquid spot contracts from an exact clean Candle source checkout: the API's pure spot
// gate, the shared pre-sign check (its SDK, MCP and CLI copies), and the CLI's `perps spot` disclosures
// and refusals. All venue data is synthetic, every fetch is intercepted, and the CLI stops at its own
// prompt or before the relay is asked to sign. No real key, balance, signature or order.
//   bun scripts/read-spot-source.ts <candle-monorepo checkout>
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-spot-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const COPIES = ["packages/sdk/src/hyperliquid.ts", "packages/mcp/src/hyperliquid.ts", "packages/cli/src/hyperliquid.ts"] as const
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", "apps/api/src/lib/spot-gate.ts", "apps/api/src/lib/perps-gate.ts")
const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(checkout, path))).digest("hex")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  // The pre-sign check is one file copied into the three packages; the recording holds only if they agree.
  presignCheck: { files: [...COPIES], sha256: sha256(COPIES[0]) },
}
for (const path of COPIES) assert.equal(sha256(path), source.presignCheck.sha256, `${path} is not the SDK's pre-sign check`)
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({ name: "spot-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
} })
const originalFetch = globalThis.fetch
const originalNow = Date.now
const NOW = 1_790_000_000_000
globalThis.fetch = (() => { throw new Error("spot recording may not access the network") }) as unknown as typeof fetch
Date.now = () => NOW
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const fakeAddress = (n: string) => `0x${n.padStart(40, "0")}`
const BUILDER = fakeAddress("7"), OTHER_BUILDER = fakeAddress("8"), ADDRESS = fakeAddress("9")
const CLOID = `0x${"1".repeat(32)}`

// A made-up spot book in Hyperliquid's `spotMetaAndAssetCtxs` shape. The universe is sparse (indexes are
// not array positions) and the contexts are reversed with a decoy, so a context is found by coin only.
const token = (name: string, index: number, szDecimals = 2) => ({ name, index, szDecimals, weiDecimals: 8 })
const tokens = [token("USDC", 0, 8), token("CANON", 1), token("ALPHA", 2), token("QUIET", 3), token("LOPSD", 4), token("NOMRK", 5), token("USDH", 6), token("Dup", 7), token("DUP", 8)]
const pair = (name: string, index: number, base: number, quote = 0) => ({ name, index, tokens: [base, quote] as [number, number] })
const universe = [pair("CANON/USDC", 0, 1), pair("@7", 7, 2), pair("@12", 12, 3), pair("@15", 15, 4), pair("@18", 18, 5), pair("@21", 21, 2, 6), pair("@30", 30, 7), pair("@31", 31, 8)]
const ctx = (coin: string, midPx: string | null, dayNtlVlm: string, markPx: string | null = midPx ?? "1") => ({ coin, markPx, midPx, prevDayPx: markPx, dayNtlVlm })
const ctxs = [
  ctx("CANON/USDC", "4.2", "300000"), ctx("@7", "25.5", "2000000"), ctx("@12", "3.1", "5000"), ctx("@15", null, "400000", "1.2"),
  ctx("@18", "2", "400000", null), ctx("@21", "25.4", "900000"), ctx("@30", "1.5", "200000"), ctx("@31", "1.6", "200000"), ctx("@999", "9", "9000000"),
].reverse()
const venueAnswer = [{ universe, tokens }, ctxs]
const markets = { universe, tokens, ctxs }

type Request = { method: string; host?: string; path: string; body?: Record<string, unknown> }
type Row = { id: string; surface: string; evidence?: string; args: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []
try {
  const gate = await load("apps/api/src/lib/spot-gate.ts")

  // 1. The API's pure spot gate: names, asset numbering, terms and every market refusal.
  const resolveCases: [string, unknown, { exit?: true; cancel?: true }?][] = [
    ["pair-name", "ALPHA/USDC"], ["at-index", "@7"], ["case-folded", "alpha/usdc"], ["canonical", "CANON/USDC"],
    ["delisted", "GONE/USDC"], ["delisted-index", "@44"], ["below-floor", "QUIET/USDC"], ["below-floor-exit", "QUIET/USDC", { exit: true }],
    ["one-sided-book", "LOPSD/USDC"], ["one-sided-book-cancel", "@15", { cancel: true }], ["no-mark", "NOMRK/USDC"],
    ["non-usdc-quote", "ALPHA/USDH"], ["ambiguous-fold", "dup/usdc"], ["exact-of-ambiguous", "DUP/USDC"], ["malformed", "ALPHA-USDC"],
  ]
  for (const [id, name, how] of resolveCases) {
    const r = how?.cancel ? gate.spotCancelTargetForCoin(markets, name) : how?.exit ? gate.spotMarketForCoin(markets, "@12") : gate.resolveSpotMarket(markets, name)
    const outcome = r.ok
      ? r.market
        ? { ok: true, asset: r.market.asset, coin: r.market.coin, pair: r.market.pair, szDecimals: r.market.szDecimals, midPx: r.market.midPx, dayVolumeUsd: r.market.dayVolumeUsd, terms: r.market.terms }
        : { ok: true, ...r.target }
      : { ok: false, code: r.code, limit: r.limit, status: r.status, message: r.message, ...(r.retryable ? { retryable: true } : {}) }
    rows.push({ id: `api-gate-${id}`, surface: "api-gate", evidence: "pure API gate source on the synthetic book", args: { market: how?.exit ? "@12" : name, ...(how ?? {}) }, outcome })
  }
  const alpha = gate.resolveSpotMarket(markets, "ALPHA/USDC").market
  const sizePrice: [string, () => any][] = [
    ["size-decimals", () => gate.checkSpotSize("1.234", alpha)], ["size-ok", () => gate.checkSpotSize("1.23", alpha)],
    ["price-decimals", () => gate.checkSpotPrice("25.1234567", alpha)], ["price-sig-figs", () => gate.checkSpotPrice("25.12345", alpha)], ["price-ok", () => gate.checkSpotPrice("25.123", alpha)],
    ["slippage-buy", () => ({ ok: true, px: gate.spotSlippagePrice("25.5", true, 100, alpha) })], ["slippage-sell", () => ({ ok: true, px: gate.spotSlippagePrice("25.5", false, 100, alpha) })],
    ["sell-balance", () => gate.checkSpotSellBalance([{ coin: "ALPHA", token: 2, total: "1", hold: "0.5" }], alpha, "0.6")],
    ["buy-balance", () => gate.checkSpotBuyBalance([{ coin: "USDC", token: 0, total: "20", hold: "0" }], alpha, "1", "25.755")],
  ]
  for (const [id, run] of sizePrice) {
    const r = run()
    rows.push({ id: `api-gate-${id}`, surface: "api-gate", evidence: "pure API gate source on the synthetic book", args: { market: "ALPHA/USDC" },
      outcome: r.ok ? { ok: true, ...(r.sz ? { sz: r.sz } : {}), ...(r.px ? { px: r.px } : {}) } : { ok: false, code: r.code, limit: r.limit, status: r.status, message: r.message } })
  }

  // 2. The pre-sign check, every copy: an honest build passes, each hostile change is refused.
  const copies = await Promise.all(COPIES.map(load))
  const { hyperliquidActionHash, hyperliquidL1TypedData } = copies[0]
  const buyPx = gate.spotSlippagePrice("25.5", true, 100, alpha)
  const order = (o: Record<string, unknown> = {}) => ({ a: 10_007, b: true, p: buyPx, s: "1", r: false, t: { limit: { tif: "Ioc" } }, c: CLOID, ...o })
  const buyAction = { type: "order", orders: [order()], grouping: "na" }
  const sellAction = { type: "order", orders: [order({ b: false, p: "25", t: { limit: { tif: "Gtc" } } })], grouping: "na", builder: { b: BUILDER, f: 100 } }
  const cancelAction = { type: "cancel", cancels: [{ a: 10_007, o: 77 }] }
  const buyParams = { market: "ALPHA/USDC", side: "buy", size: "1", type: "market", clientId: CLOID }
  const sellParams = { market: "@7", side: "sell", size: "1", type: "limit", price: "25", tif: "Gtc", clientId: CLOID }
  const build = (action: Record<string, unknown>, typedFor = action) => ({ network: "mainnet", nonce: NOW, address: ADDRESS, action, typedData: hyperliquidL1TypedData(hyperliquidActionHash(typedFor, NOW), "mainnet") })
  const verifyCases: { id: string; method: "spotOrder" | "spotCancel"; action: Record<string, unknown>; params: Record<string, unknown>; reduceOnly?: boolean; typedFor?: Record<string, unknown>; resting?: unknown }[] = [
    { id: "buy-honest", method: "spotOrder", action: buyAction, params: buyParams },
    { id: "sell-honest", method: "spotOrder", action: sellAction, params: sellParams },
    { id: "buy-with-builder", method: "spotOrder", action: { ...buyAction, builder: { b: BUILDER, f: 100 } }, params: buyParams },
    { id: "sell-builder-above-cap", method: "spotOrder", action: { ...sellAction, builder: { b: BUILDER, f: 101 } }, params: sellParams },
    { id: "sell-other-builder", method: "spotOrder", action: { ...sellAction, builder: { b: OTHER_BUILDER, f: 100 } }, params: sellParams },
    { id: "wrong-pair-asset", method: "spotOrder", action: { ...buyAction, orders: [order({ a: 10_012 })] }, params: buyParams },
    { id: "perp-asset", method: "spotOrder", action: { ...buyAction, orders: [order({ a: 7 })] }, params: buyParams },
    { id: "non-usdc-pair", method: "spotOrder", action: { ...buyAction, orders: [order({ a: 10_021 })] }, params: { ...buyParams, market: "ALPHA/USDH" } },
    { id: "delisted-pair", method: "spotOrder", action: { ...buyAction, orders: [order({ a: 10_044 })] }, params: { ...buyParams, market: "@44" } },
    { id: "outside-slippage", method: "spotOrder", action: { ...buyAction, orders: [order({ p: "26.5" })] }, params: buyParams },
    { id: "size-changed", method: "spotOrder", action: { ...buyAction, orders: [order({ s: "2" })] }, params: buyParams },
    { id: "side-flipped", method: "spotOrder", action: { ...buyAction, orders: [order({ b: false })] }, params: buyParams },
    { id: "reduce-only-buy", method: "spotOrder", action: buyAction, params: buyParams, reduceOnly: true },
    { id: "reduce-only-sell", method: "spotOrder", action: sellAction, params: sellParams, reduceOnly: true },
    { id: "typed-data-other-action", method: "spotOrder", action: buyAction, params: buyParams, typedFor: { ...buyAction, orders: [order({ s: "2" })] } },
    { id: "cancel-honest", method: "spotCancel", action: cancelAction, params: { cloid: CLOID } },
    { id: "cancel-other-oid", method: "spotCancel", action: { type: "cancel", cancels: [{ a: 10_007, o: 78 }] }, params: { cloid: CLOID } },
    { id: "cancel-not-resting", method: "spotCancel", action: cancelAction, params: { cloid: CLOID }, resting: { status: "unknownOid" } },
  ]
  for (const c of verifyCases) {
    const results: any[] = []
    let requests: Request[] = []
    for (const copy of copies) {
      requests = []
      const fetcher = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        assert.equal(url, "https://api.hyperliquid.xyz/info")
        requests.push({ method: init?.method ?? "GET", path: "/info", body: { type: body.type } })
        const answer = body.type === "spotMetaAndAssetCtxs" ? venueAnswer
          : body.type === "orderStatus" ? (c.resting ?? { status: "order", order: { order: { coin: "@7", oid: 77 } } }) : null
        assert.notEqual(answer, null, `unexpected venue read ${body.type}`)
        return { ok: true, status: 200, text: async () => JSON.stringify(answer) }
      }
      results.push(await copy.verifySpotBuildAgainstVenue(build(c.action, c.typedFor), {
        builder: BUILDER, address: ADDRESS, intent: { method: c.method, params: c.params }, keyReduceOnly: c.reduceOnly, fetcher,
      }))
    }
    for (const r of results.slice(1)) assert.deepEqual(r, results[0], `${c.id}: the copies disagree`)
    rows.push({ id: `presign-${c.id}`, surface: "presign", evidence: "SDK, MCP and CLI copies of the pre-sign check, same answer", args: { method: c.method, ...c.params, ...(c.reduceOnly ? { keyReduceOnly: true } : {}) }, requests, outcome: results[0] })
  }
  // Perps' own check still refuses a spot asset, so no perps method can carry a spot order.
  const perpsCheck = copies[0].verifyPerpsBuild(build(buyAction), { builder: BUILDER, network: "mainnet", address: ADDRESS, intent: { method: "open", params: { coin: "ALPHA", side: "long", size: "1" } } })
  assert.equal(perpsCheck.ok, false)
  rows.push({ id: "presign-perps-method-refuses-spot-asset", surface: "presign", args: { method: "open", asset: 10_007 }, outcome: perpsCheck })

  // 3. The CLI: terms before the confirm (prompt declined, or --yes stopped before the relay signs),
  //    a hostile build refused before the relay, local refusals with nothing requested, and the API's
  //    refusals passed through with their code.
  const cli = await load("packages/cli/src/commands/perps-spot.ts")
  const { createCapture, createTestDeps, createFakeStore } = await load("packages/cli/src/test-support.ts")
  const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const spotPreview = (action: any) => {
    const o = action.orders[0], b = action.builder
    // The shape of agent-perps.ts's spot preview, with the market fields from the pure gate above.
    return { venue: "hyperliquid-spot", market: alpha.pair, coin: alpha.coin, asset: alpha.asset, side: o.b ? "buy" : "sell", size: o.s, sizeToken: alpha.base.name,
      limitPx: o.p, priceToken: alpha.quote.name, tif: o.t.limit.tif, midPx: alpha.midPx, dayVolumeUsd: alpha.dayVolumeUsd, terms: alpha.terms,
      builderFee: b ? { address: b.b, feeTenthsBps: b.f, feePct: String(b.f / 1000) } : { address: null, feeTenthsBps: 0, feePct: "0", reason: o.b ? "not charged on spot buys" : "none on this plan" } }
  }
  const spotBuild = (action: any, kind = "spotOrder") => ({ success: true, perpOrderId: "fixture-perp", kind, network: "mainnet", walletId: "wallet", address: ADDRESS, nonce: NOW, action,
    typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, NOW), "mainnet"), claimHash: "fixture-claim", cloid: CLOID, clientId: CLOID, builder: action.builder ?? null,
    preview: kind === "spotOrder" ? spotPreview(action) : { venue: "hyperliquid-spot", market: alpha.pair, coin: alpha.coin, oid: 77, targetCloid: CLOID } })
  const runCli = async (argv: string[], answer: (path: string, body: any) => unknown, opts: { json?: boolean } = {}) => {
    const requests: Request[] = []
    const stdout = createCapture(), stderr = createCapture()
    let shown = "", stop = "exit"
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method: init?.method ?? "GET", host: u.host, path: u.pathname, ...(u.host === "api.hyperliquid.xyz" && body ? { body: { type: body.type } } : {}) })
      if (u.pathname.endsWith("/sign")) { shown = stdout.text; stop = "before-relay"; throw new Error("offline recorder stops before signing") }
      if (u.pathname === "/api/v1/agent/wallets/trading") return Response.json({ scopes: ["perps:write"], privyAppId: "fixture-app", page: [{ id: "wallet", address: ADDRESS, label: "perps", chain: "evm", active: true, allowLaunch: false, privyWalletId: "fixture-privy" }], isDone: true })
      if (u.host === "api.hyperliquid.xyz") {
        assert.equal(u.pathname, "/info")
        if (body.type === "spotMetaAndAssetCtxs") return Response.json(venueAnswer)
        if (body.type === "orderStatus") return Response.json({ status: "order", order: { order: { coin: "@7", oid: 77 } } })
        throw new Error(`unexpected venue read ${body.type}`)
      }
      const reply = answer(u.pathname, body)
      if (reply instanceof Response) return reply
      if (reply === undefined) throw new Error(`unexpected request ${u.pathname}`)
      return Response.json(reply)
    }
    const deps = createTestDeps({ stdout, stderr, now: () => NOW, fetch: fetcher,
      env: { CANDLE_API_KEY: cfg.apiKey, CANDLE_HYPERLIQUID_BUILDER: BUILDER },
      store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(ephemeral) }),
      promptLine: async () => { shown = stdout.text; stop = "before-prompt"; return "n" },
    })
    const exitCode = await cli.perpsSpot(argv, { deps, apiUrl: cfg.apiUrl, json: opts.json === true })
    return { exitCode, stop, shown, stdout: stdout.text, stderr: stderr.text, requests }
  }
  // Only the market and fee lines are kept: the account and the authorization never enter a fixture.
  // A cancel has no market terms, only its preview line.
  const disclosureOf = (shown: string) => (shown.includes("Market ") ? shown.slice(shown.indexOf("Market ")).split("\n") : shown.split("\n").filter((l) => l.startsWith("  · "))).filter((l) => l.trim() !== "")
  for (const side of ["buy", "sell"] as const) for (const yes of [false, true]) {
    const action = side === "buy" ? buyAction : sellAction
    const argv = side === "buy" ? ["buy", "ALPHA/USDC", "1", "--client-id", CLOID] : ["sell", "@7", "1", "--price", "25", "--tif", "Gtc", "--client-id", CLOID]
    const r = await runCli([...argv, "--wallet", "perps", ...(yes ? ["--yes"] : [])], (path, body) => {
      if (path !== "/api/v1/agent/perps/spot/order") return undefined
      assert.equal(body.walletId, "wallet")
      return spotBuild(action)
    })
    assert.equal(r.stop, yes ? "before-relay" : "before-prompt", r.stdout + r.stderr)
    assert.ok(r.shown.includes("Hyperliquid spot fee"), r.shown)
    assert.ok(!r.requests.some((q) => q.host === "api.hyperliquid.xyz" && q.path === "/exchange"))
    rows.push({ id: `cli-${side}-${yes ? "yes" : "prompt"}`, surface: "cli", args: { argv: [...argv, "--wallet", "<tee>", ...(yes ? ["--yes"] : [])] }, requests: r.requests,
      outcome: { stop: r.stop, exitCode: r.exitCode, disclosure: disclosureOf(r.shown) } })
  }
  {
    const r = await runCli(["cancel", CLOID, "--wallet", "perps"], (path) => path === "/api/v1/agent/perps/spot/cancel" ? spotBuild(cancelAction, "spotCancel") : undefined)
    assert.equal(r.stop, "before-prompt", r.stdout + r.stderr)
    assert.ok(r.shown.includes("Cancel asset 10007 order 77."))
    rows.push({ id: "cli-cancel-prompt", surface: "cli", args: { argv: ["cancel", "<cloid>", "--wallet", "<tee>"] }, requests: r.requests, outcome: { stop: r.stop, exitCode: r.exitCode, disclosure: disclosureOf(r.shown) } })
  }
  for (const [id, action] of [["hostile-buy-builder", { ...buyAction, builder: { b: BUILDER, f: 100 } }], ["hostile-wrong-asset", { ...buyAction, orders: [order({ a: 10_012 })] }]] as const) {
    const r = await runCli(["buy", "ALPHA/USDC", "1", "--client-id", CLOID, "--wallet", "perps", "--yes"], (path) => path === "/api/v1/agent/perps/spot/order" ? spotBuild(action) : undefined, { json: true })
    assert.equal(r.stop, "exit")
    assert.ok(!r.requests.some((q) => q.path.endsWith("/sign")), "a refused build never reaches the relay")
    rows.push({ id: `cli-${id}`, surface: "cli", args: { argv: ["buy", "ALPHA/USDC", "1", "--client-id", "<cloid>", "--wallet", "<tee>", "--yes"] }, requests: r.requests, outcome: { exitCode: r.exitCode, body: JSON.parse(r.stdout) } })
  }
  for (const [id, argv] of [
    ["embedded-wallet", ["buy", "ALPHA/USDC", "1", "--wallet", "embedded", "--yes"]],
    ["malformed-pair", ["buy", "ALPHA-USDC", "1", "--yes"]],
    ["gtc-without-price", ["buy", "ALPHA/USDC", "1", "--tif", "Gtc", "--yes"]],
  ] as const) {
    const r = await runCli([...argv], () => undefined, { json: true })
    assert.equal(r.requests.length, 0, `${id} requests nothing`)
    rows.push({ id: `cli-local-${id}`, surface: "cli", args: { argv }, requests: [], outcome: { exitCode: r.exitCode, body: JSON.parse(r.stdout || r.stderr) } })
  }
  for (const [id, market] of [["delisted", "GONE/USDC"], ["below-floor", "QUIET/USDC"], ["one-sided-book", "LOPSD/USDC"], ["non-usdc-quote", "ALPHA/USDH"]] as const) {
    const refusal = gate.resolveSpotMarket(markets, market)
    assert.equal(refusal.ok, false)
    const r = await runCli(["buy", market, "1", "--client-id", CLOID, "--wallet", "perps", "--yes"], (path, body) => {
      if (path !== "/api/v1/agent/perps/spot/order") return undefined
      assert.equal(body.market, market)
      return Response.json({ success: false, error: { code: refusal.code, message: refusal.message, limit: refusal.limit } }, { status: refusal.status })
    }, { json: true })
    assert.notEqual(r.exitCode, 0)
    assert.ok(r.stdout.includes(refusal.code))
    assert.equal(r.requests.filter((q) => q.method === "POST").length, 1)
    rows.push({ id: `cli-refused-${id}`, surface: "cli", evidence: "response-stub: generated by the pure spot gate; keyed API route not executed", args: { market }, requests: r.requests, outcome: { exitCode: r.exitCode, body: JSON.parse(r.stdout) } })
  }
  // The markets list as agent-perps.ts's spot markets route builds it: every pair through the gate, a
  // refused one (listed with --all) with its reason, the busiest first, at most 50.
  const marketsAnswer = (all: boolean) => {
    const list = universe.map((p) => {
      const resolved = gate.resolveSpotMarket(markets, p.name)
      if (resolved.ok) {
        const m = resolved.market
        return { market: m.pair, coin: m.coin, asset: m.asset, base: m.base.name, quote: m.quote.name, midPx: m.midPx, markPx: m.markPx, dayVolumeUsd: m.dayVolumeUsd, szDecimals: m.szDecimals, terms: m.terms, tradable: true, refusal: null }
      }
      const f = gate.spotMarketForCoin(markets, p.name)
      const m = f.ok ? f.market : null
      return { market: m ? m.pair : p.name, coin: p.name, asset: 10_000 + p.index, base: m?.base.name ?? null, quote: m?.quote.name ?? null, midPx: m?.midPx ?? null, markPx: m?.markPx ?? null,
        dayVolumeUsd: m?.dayVolumeUsd ?? null, szDecimals: m?.szDecimals ?? null, terms: m?.terms ?? null, tradable: false, refusal: { limit: resolved.limit, message: resolved.message } }
    }).filter((r) => all || r.tradable).sort((a, b) => Number(b.dayVolumeUsd ?? 0) - Number(a.dayVolumeUsd ?? 0)).slice(0, 50)
    return { success: true, network: "mainnet", minDayVolumeUsd: 100_000, quote: "USDC", count: list.length, markets: list }
  }
  for (const all of [false, true]) {
    const argv = all ? ["markets", "--all"] : ["markets"]
    const r = await runCli(argv, (path) => path === "/api/v1/agent/perps/spot/markets" ? marketsAnswer(all) : undefined)
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(r.requests.length, 1)
    rows.push({ id: `cli-markets${all ? "-all" : ""}`, surface: "cli", evidence: "response-stub: rows generated by the pure spot gate as the route orders them; keyed API route not executed", args: { argv }, requests: r.requests, outcome: { exitCode: r.exitCode, text: r.stdout.split("\n").filter((l: string) => l.trim() !== "") } })
  }

  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-spot-source.json"), `${JSON.stringify({
    about: "Offline Hyperliquid spot contracts from exact merged source. The book is synthetic (made-up tokens, sparse indexes, reversed contexts with a decoy). api-gate rows run the API's pure spot gate; presign rows run the SDK, MCP and CLI copies of the pre-sign check and agree; cli rows run `candle perps spot` with an ephemeral in-memory key, declining at the prompt or stopping before the relay signs. API refusals and the markets list are response stubs generated by the pure gate; the keyed API route is not executed. No funded account, signature, submission or deployed behavior is claimed.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline spot contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch; Date.now = originalNow }
