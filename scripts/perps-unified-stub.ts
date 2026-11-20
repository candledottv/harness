// Shared offline stand-ins for the Hyperliquid unified-account contracts (BE-3863): Candle API and Hyperliquid /info
// answers, every address, balance and position made up. Used by the source recorder and by the published-package run.
import { strict as assert } from "node:assert"

export const NOW = 1_790_000_000_000
export const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
export const fakeAddress = (n: string) => `0x${n.padStart(40, "0")}`
export const WALLET_ID = "wallet-unified"
export const PRIVY_ID = "fixture-privy"
export const ADDRESS = fakeAddress("9")
export const BUILDER = fakeAddress("7")
export const DEPLOYER_XYZ = fakeAddress("1")
export const DEPLOYER_ALT = fakeAddress("2")
export const ORACLE_XYZ = fakeAddress("4")
export const ORACLE_ALT = fakeAddress("5")

export const DEFAULT_THRESHOLDS = {
  warnDistanceBps: 1500,
  criticalDistanceBps: 700,
  warnMarginRatioBps: 6000,
  criticalMarginRatioBps: 8000,
  clearBandBps: 200,
}

export const limitsPayload = (unifiedAccounts: boolean | "omit") => ({
  success: true,
  perpsRisk: null,
  perpsRiskEffective: DEFAULT_THRESHOLDS,
  ...(unifiedAccounts === "omit" ? {} : { unifiedAccounts }),
})

export const tradingWalletsPayload = {
  scopes: ["perps:write", "account:read"],
  privyAppId: "fixture-app",
  page: [{ id: WALLET_ID, address: ADDRESS, label: "perps", chain: "evm", active: true, allowLaunch: false, privyWalletId: PRIVY_ID }],
  isDone: true,
}

export const perpDexsBody = [
  null,
  { name: "xyz", fullName: "XYZ", deployer: DEPLOYER_XYZ, oracleUpdater: ORACLE_XYZ },
  { name: "alt", fullName: "ALT", deployer: DEPLOYER_ALT, oracleUpdater: ORACLE_ALT },
]

export const mainMeta = { collateralToken: 0, universe: [{ name: "BTC", szDecimals: 3, maxLeverage: 40 }] }
export const xyzMeta = { collateralToken: 0, universe: [{ name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10, marginMode: "strictIsolated" }] }
export const altMeta = { collateralToken: 0, universe: [{ name: "alt:ETH", szDecimals: 3, maxLeverage: 20 }] }
export const allPerpMetasBody = [mainMeta, xyzMeta, altMeta]
export const mainCtxs = [{ markPx: "100000", midPx: "100000", oraclePx: "100000" }]
export const xyzCtxs = [{ markPx: "250", midPx: "250", oraclePx: "250" }]

export const btcPosition = (liquidationPx = "70000", marginUsed = "150", unrealizedPnl = "25") => ({
  position: {
    coin: "BTC",
    szi: "0.05",
    entryPx: "99500",
    positionValue: "5000",
    unrealizedPnl,
    returnOnEquity: "0.1667",
    leverage: { type: "cross", value: 20 },
    liquidationPx,
    marginUsed,
    cumFunding: { sinceOpen: "1.25" },
  },
})

export const tslaIsolatedPosition = (marginUsed = "100", unrealizedPnl = "15") => ({
  position: {
    coin: "xyz:TSLA",
    szi: "4",
    entryPx: "246.25",
    positionValue: "1000",
    unrealizedPnl,
    returnOnEquity: "0.15",
    leverage: { type: "isolated", value: 10 },
    liquidationPx: "200",
    marginUsed,
    cumFunding: { sinceOpen: "0.50" },
  },
})

export const emptyDexState = {
  marginSummary: { accountValue: "0", totalMarginUsed: "0" },
  crossMarginSummary: { accountValue: "0", totalMarginUsed: "0" },
  crossMaintenanceMarginUsed: "0",
  withdrawable: "0",
  assetPositions: [],
}

/**
 * Stand-in per-dex states for a unified wallet:
 * - Main dex reports accountValue "0" and withdrawable "0" (Hyperliquid's per-dex state does not carry
 *   the shared collateral balance), with 1 cross BTC position (`crossMaintenanceMarginUsed: "50"`).
 * - Builder dex `xyz` holds 1 isolated `xyz:TSLA` position (`marginUsed: "100"`).
 * - Builder dex `alt` has no positions (proving its marks are never fetched).
 * - Spot USDC balance is `total: "1000.0"`, `hold: "100.0"` -> `free: "900"`, `available = 1000 - 100 = 900`,
 *   unified ratio = `50 / 900` (~0.0556).
 */
export interface VenuePreset {
  mode: string
  spotBalances: { coin: string; token: number; total: string; hold: string }[]
  mainState: Record<string, unknown>
  xyzState: Record<string, unknown>
  altState: Record<string, unknown>
}

export const UNIFIED_OK_VENUE: VenuePreset = {
  mode: "unifiedAccount",
  spotBalances: [
    { coin: "USDC", token: 0, total: "1000.0", hold: "100.0" },
    { coin: "USDH", token: 360, total: "200.0", hold: "0" },
  ],
  mainState: {
    marginSummary: { accountValue: "0", totalMarginUsed: "150" },
    crossMarginSummary: { accountValue: "0", totalMarginUsed: "150" },
    crossMaintenanceMarginUsed: "50",
    withdrawable: "0",
    assetPositions: [btcPosition()],
  },
  xyzState: {
    marginSummary: { accountValue: "0", totalMarginUsed: "100" },
    crossMarginSummary: { accountValue: "0", totalMarginUsed: "0" },
    crossMaintenanceMarginUsed: "0",
    withdrawable: "0",
    assetPositions: [tslaIsolatedPosition()],
  },
  altState: emptyDexState,
}

export const UNIFIED_WARN_RATIO_VENUE: VenuePreset = {
  ...UNIFIED_OK_VENUE,
  mainState: {
    ...UNIFIED_OK_VENUE.mainState,
    // 600 / (1000 - 100) = 600 / 900 = 0.6667 > 0.60 warn threshold (< 0.80 critical).
    crossMaintenanceMarginUsed: "600",
  },
}

export const UNIFIED_NO_EQUITY_VENUE: VenuePreset = {
  ...UNIFIED_OK_VENUE,
  // Spot USDC total 80 minus isolated margin 100 = -20 available collateral with crossMaintenanceMarginUsed 50 -> E2 critical no equity.
  spotBalances: [{ coin: "USDC", token: 0, total: "80", hold: "80" }],
}

export const STANDARD_VENUE: VenuePreset = {
  mode: "default",
  spotBalances: [],
  mainState: {
    marginSummary: { accountValue: "1200", totalMarginUsed: "150" },
    crossMarginSummary: { accountValue: "1200", totalMarginUsed: "150" },
    crossMaintenanceMarginUsed: "60",
    withdrawable: "1050",
    assetPositions: [btcPosition()],
  },
  xyzState: emptyDexState,
  altState: emptyDexState,
}

export const RECENT_FILLS = [{ coin: "BTC", closedPnl: "12.50", fee: "0.75", time: NOW - 3_600_000 }]
export const RECENT_FUNDING = [{ time: NOW - 3_600_000, delta: { coin: "BTC", usdc: "-0.40" } }]


export type Req = { host: string; method: string; path: string; body?: Record<string, unknown> }

export const makeFetcher = (
  requests: Req[],
  opts: {
    venue: VenuePreset
    unifiedAccounts: boolean | "omit"
    setupReady?: boolean
    positionsBody?: Record<string, unknown>
  },
) =>
  (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = init?.method ?? "GET"
    const rawBody = init?.body ? JSON.parse(String(init.body)) : undefined
    const recordedBody =
      u.hostname === "api.hyperliquid.xyz" && rawBody
        ? Object.fromEntries(Object.entries(rawBody).filter(([k]) => ["type", "dex"].includes(k)))
        : rawBody
    requests.push({ host: u.hostname, method, path: u.pathname, ...(recordedBody !== undefined ? { body: recordedBody } : {}) })
    assert.ok(!/\/sign$|\/exchange$/.test(u.pathname), `offline unified recorder must never sign or submit: ${u.href}`)

    if (u.hostname === "api.test") {
      if (u.pathname === "/api/v1/agent/wallets/trading") return Response.json(tradingWalletsPayload)
      if (u.pathname === "/api/v1/agent/keys/self/limits") return Response.json(limitsPayload(opts.unifiedAccounts))
      if (u.pathname === "/api/v1/agent/perps/setup" && method === "POST") {
        assert.equal(opts.setupReady, true, `unexpected setup POST in scenario where setup should have been refused`)
        const standard = opts.venue.mode === "default" || opts.venue.mode === "disabled"
        return Response.json({
          success: true,
          ready: true,
          walletId: WALLET_ID,
          address: ADDRESS,
          network: "mainnet",
          mode: opts.venue.mode,
          standardMode: standard,
          accountValue: standard ? "1200" : "1000.0",
          withdrawable: standard ? "1050" : "900",
          builder: BUILDER,
          approvedFeeTenthsBps: 100,
        })
      }
      if (u.pathname === "/api/v1/agent/perps/positions" && method === "GET") {
        assert.ok(opts.positionsBody, "unexpected /perps/positions GET")
        return Response.json(opts.positionsBody)
      }
      throw new Error(`unexpected API request: ${method} ${u.pathname}`)
    }

    assert.equal(u.href, "https://api.hyperliquid.xyz/info", `unexpected host: ${u.href}`)
    const t = rawBody?.type
    if (t === "userAbstraction") return Response.json(opts.venue.mode)
    if (t === "clearinghouseState") {
      if (!rawBody.dex) return Response.json(opts.venue.mainState)
      if (rawBody.dex === "xyz") return Response.json(opts.venue.xyzState)
      if (rawBody.dex === "alt") return Response.json(opts.venue.altState)
      throw new Error(`unexpected dex clearinghouseState: ${rawBody.dex}`)
    }
    if (t === "metaAndAssetCtxs") {
      if (!rawBody.dex) return Response.json([mainMeta, mainCtxs])
      if (rawBody.dex === "xyz") return Response.json([xyzMeta, xyzCtxs])
      throw new Error(`unexpected dex metaAndAssetCtxs: ${rawBody.dex}`)
    }
    if (t === "spotClearinghouseState") return Response.json({ balances: opts.venue.spotBalances })
    if (t === "perpDexs") return Response.json(perpDexsBody)
    if (t === "allPerpMetas") return Response.json(allPerpMetasBody)
    if (t === "userFillsByTime") return Response.json(RECENT_FILLS)
    if (t === "userFunding") return Response.json(RECENT_FUNDING)
    throw new Error(`unexpected Hyperliquid info type: ${String(t)}`)
  }) as unknown as typeof fetch

export const VENUES = {
  unifiedOk: UNIFIED_OK_VENUE,
  unifiedWarnRatio: UNIFIED_WARN_RATIO_VENUE,
  unifiedNoEquity: UNIFIED_NO_EQUITY_VENUE,
  standard: STANDARD_VENUE,
  portfolioMargin: { ...STANDARD_VENUE, mode: "portfolioMargin" },
} satisfies Record<string, VenuePreset>
export type VenueName = keyof typeof VENUES
