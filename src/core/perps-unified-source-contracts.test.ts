// Hyperliquid unified accounts (BE-3860 / BE-3863), as Candle's published CLI, MCP server and SDK carry them:
// setup in unified mode with the server switch on (and refused when off or against an older API), risk, account,
// positions and watch displays across main and builder dexes (spot collateral, per-dex positions, unified account
// ratio, warn and no-equity levels), standard-mode wallets unchanged whether the switch is on or off, and
// unsupported modes still refused. Recorded offline from one exact published commit
// (scripts/read-perps-unified-source.ts); nothing is signed, submitted or sent over the network.
import { describe, expect, test } from "bun:test"
import perps from "../../test/fixtures/candle-perps-source.json"
import unified from "../../test/fixtures/candle-perps-unified-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { toOutcome } from "./candle-mcp"
import { classify, TOOL_CLASSES } from "./classify"
import { rowFor, SOURCE } from "./cli-table"

type Req = { host: string; method: string; path: string; body?: Record<string, any> }
type Row = { id: string; scenario: string; surface: string; says?: string; args?: Record<string, any>; requests?: Req[]; outcome: any }
const rows = unified.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const textOf = (lines: string[]) => lines.join("\n")
const flat = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ")
const venueTypes = (id: string) =>
  (row(id).requests ?? [])
    .filter((r) => r.host === "api.hyperliquid.xyz")
    .map((r) => (r.body?.dex ? `${r.body.type}:${r.body.dex}` : String(r.body?.type)))

test("the recording pins the exact published source, the same commit as the CLI table, tools/list and the other source fixtures", () => {
  expect(unified.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "ebd1e50050cddc82d82186a1e6a499cd0ca02e85",
    versions: { cli: "0.13.35", mcp: "0.10.40", sdk: "0.6.29" },
  })
  expect(unified.source.commit).toBe(SOURCE.source.commit)
  expect(unified.source.commit).toBe(tools.source.commit)
  expect(unified.source.commit).toBe(perps.source.commit)
  // One shared risk engine copied byte-identically into SDK, MCP and CLI.
  expect(unified.source.riskEngine.files).toEqual([
    "packages/sdk/src/hyperliquid-risk.ts",
    "packages/mcp/src/hyperliquid-risk.ts",
    "packages/cli/src/hyperliquid-risk.ts",
  ])
  expect(unified.source.riskEngine.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(rows).toHaveLength(72)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(unified.about).toContain("no deployed behavior is claimed")
})

test("no real address, key, private key, signature or venue submission enters any recording", () => {
  const text = JSON.stringify(unified)
  for (const hex of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) expect(hex).toMatch(/^0x0{39}[0-9]$/)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key|BEGIN [A-Z ]*PRIVATE KEY/)
  for (const r of rows) {
    expect((r.requests ?? []).some((q) => /\/sign$|\/exchange$/.test(q.path)), r.id).toBe(false)
  }
})

describe("setup in unified mode, switch off, standard and unsupported modes", () => {
  test("with the switch on, unifiedAccount continues to POST /perps/setup and accepts a unified ready answer pinned to the venue mode", () => {
    for (const id of ["setup-unified-on-cli", "setup-unified-on-cli-json", "setup-unified-on-mcp", "setup-unified-on-sdk"]) {
      const r = row(id)
      expect(r.requests!.map((q) => q.path)).toEqual([
        "/api/v1/agent/wallets/trading",
        "/info",
        "/api/v1/agent/keys/self/limits",
        "/api/v1/agent/perps/setup",
      ])
      expect(venueTypes(id)).toEqual(["userAbstraction"])
    }
    expect(flat(row("setup-unified-on-cli").outcome.stderr)).toContain("unifiedAccount mode and Candle's unified accounts are on; setup continues on the unified path.")
    expect(row("setup-unified-on-cli-json").outcome).toMatchObject({ exitCode: 0, body: { ready: true, mode: "unifiedAccount", standardMode: false, accountValue: "1000.0", withdrawable: "900" } })
    expect(row("setup-unified-on-mcp").outcome).toMatchObject({ isError: false, body: { ready: true, mode: "unifiedAccount", standardMode: false } })
    expect(row("setup-unified-on-sdk").outcome).toMatchObject({ isError: false, body: { ready: true, mode: "unifiedAccount", standardMode: false } })
  })

  test("with the switch off or omitted by an older API, unifiedAccount is refused with PERPS_ACCOUNT_MODE before POST /perps/setup", () => {
    for (const scenario of ["setup-unified-off", "setup-unified-older-api"]) {
      for (const suffix of ["cli", "cli-json", "mcp", "sdk"]) {
        const r = row(`${scenario}-${suffix}`)
        expect(r.requests!.some((q) => q.path === "/api/v1/agent/perps/setup")).toBe(false)
        expect(r.requests!.some((q) => q.path === "/api/v1/agent/keys/self/limits")).toBe(true)
      }
      expect(row(`${scenario}-cli`).outcome.exitCode).toBe(1)
      expect(flat(row(`${scenario}-cli`).outcome.stderr)).toContain("unifiedAccount mode and Candle's unified accounts are off")
      expect(row(`${scenario}-cli-json`).outcome).toMatchObject({ exitCode: 1, body: { ok: false, code: "PERPS_ACCOUNT_MODE" } })
      expect(row(`${scenario}-mcp`).outcome).toMatchObject({ isError: true, body: { success: false, error: { code: "PERPS_ACCOUNT_MODE" }, mode: "unifiedAccount" } })
      expect(row(`${scenario}-sdk`).outcome.isError).toBe(true)
      expect(row(`${scenario}-sdk`).outcome.error.message).toContain("unifiedAccount mode and Candle's unified accounts are off")
    }
  })

  test("a standard-mode wallet skips the limits switch check and keeps standard setup unchanged even with the switch on", () => {
    for (const suffix of ["cli", "cli-json", "mcp", "sdk"]) {
      const r = row(`setup-standard-with-switch-on-${suffix}`)
      expect(r.requests!.map((q) => q.path)).toEqual([
        "/api/v1/agent/wallets/trading",
        "/info",
        "/api/v1/agent/perps/setup",
      ])
    }
    expect(row("setup-standard-with-switch-on-cli-json").outcome).toMatchObject({ exitCode: 0, body: { ready: true, mode: "default", standardMode: true } })
    expect(row("setup-standard-with-switch-on-mcp").outcome).toMatchObject({ isError: false, body: { ready: true, mode: "default", standardMode: true } })
    expect(row("setup-standard-with-switch-on-sdk").outcome).toMatchObject({ isError: false, body: { ready: true, mode: "default", standardMode: true } })
  })

  test("an unsupported mode (portfolioMargin) is still refused before setup without checking unifiedAccounts", () => {
    for (const suffix of ["cli", "cli-json", "mcp", "sdk"]) {
      const r = row(`setup-unsupported-mode-${suffix}`)
      expect(r.requests!.some((q) => q.path === "/api/v1/agent/keys/self/limits")).toBe(false)
      expect(r.requests!.some((q) => q.path === "/api/v1/agent/perps/setup")).toBe(false)
    }
    expect(row("setup-unsupported-mode-cli-json").outcome).toMatchObject({ exitCode: 1, body: { ok: false, code: "PERPS_ACCOUNT_MODE" } })
    expect(row("setup-unsupported-mode-mcp").outcome).toMatchObject({ isError: true, body: { error: { code: "PERPS_ACCOUNT_MODE" }, mode: "portfolioMargin" } })
    expect(row("setup-unsupported-mode-sdk").outcome.error.message).toContain("PERPS_ACCOUNT_MODE: the account is in portfolioMargin mode")
  })
})

describe("unified risk, account, positions and watch displays with the switch on", () => {
  test("risk-unified-ok reads spot collateral and per-dex positions (skipping marks on empty dexes) and agrees across CLI, MCP and SDK", () => {
    const cliReport = row("risk-unified-ok-cli-json").outcome.body
    const mcpReport = row("risk-unified-ok-mcp").outcome.body
    const sdkReport = row("risk-unified-ok-sdk").outcome.body
    expect(cliReport).toEqual(mcpReport)
    expect(cliReport).toEqual(sdkReport)

    expect(cliReport).toMatchObject({
      mode: "unifiedAccount",
      level: "ok",
      reason: null,
      account: {
        accountValueUsd: "1000.0",
        crossAccountValueUsd: "900",
        marginUsedUsd: "250",
        freeMarginUsd: "900",
        withdrawableUsd: "900",
        crossMaintenanceMarginUsedUsd: "50",
        unrealizedPnlUsd: "40",
        positionCount: 2,
        mode: "unifiedAccount",
      },
      unified: {
        ratioToken: 0,
        dexes: ["", "xyz", "alt"],
      },
    })
    expect(cliReport.unified.ratio).toBeCloseTo(50 / 900, 6)
    expect(cliReport.account.marginRatio).toBe(cliReport.unified.ratio)
    expect(cliReport.positions.map((p: any) => p.coin)).toEqual(["BTC", "xyz:TSLA"])

    // Empty builder dex `alt` reads clearinghouseState but never fetches metaAndAssetCtxs.
    for (const id of ["risk-unified-ok-cli", "risk-unified-ok-mcp", "risk-unified-ok-sdk"]) {
      const types = venueTypes(id)
      expect(types).toContain("spotClearinghouseState")
      expect(types).toContain("perpDexs")
      expect(types).toContain("allPerpMetas")
      expect(types).toContain("clearinghouseState:xyz")
      expect(types).toContain("clearinghouseState:alt")
      expect(types).toContain("metaAndAssetCtxs:xyz")
      expect(types).not.toContain("metaAndAssetCtxs:alt")
    }

    const human = textOf(row("risk-unified-ok-cli").outcome.lines)
    expect(human).toContain("Value          $1,000.00")
    expect(human).toContain("Free margin    $900.00")
    expect(human).toContain("Withdrawable   $900.00")
    expect(human).toContain("Mode           unifiedAccount")
    expect(human).toContain("Unified ratio  0.0556 (USDC)")
    expect(human).toContain("Unified dexes  main, xyz, alt")
    expect(human).toContain("BTC")
    expect(human).toContain("xyz:TSLA")
  })

  test("unified warn ratio exits 10 in CLI and reports the margin driver across all surfaces", () => {
    expect(row("risk-unified-warn-ratio-cli").outcome.exitCode).toBe(10)
    expect(row("risk-unified-warn-ratio-cli-json").outcome.exitCode).toBe(10)
    expect(row("risk-unified-warn-ratio-mcp").outcome.isError).toBe(false)
    for (const body of [row("risk-unified-warn-ratio-cli-json").outcome.body, row("risk-unified-warn-ratio-mcp").outcome.body, row("risk-unified-warn-ratio-sdk").outcome.body]) {
      expect(body).toMatchObject({
        mode: "unifiedAccount",
        level: "warn",
        drivers: [{ kind: "margin", level: "warn", threshold: 0.6 }],
        unified: { ratioToken: 0 },
      })
      expect(body.unified.ratio).toBeCloseTo(600 / 900, 6)
    }
    expect(textOf(row("risk-unified-warn-ratio-cli").outcome.lines)).toContain("Unified ratio  0.6667 (USDC)")
  })

  test("unified cross exposure with no available collateral is critical no equity (ratio null, exit 11)", () => {
    expect(row("risk-unified-no-equity-cli").outcome.exitCode).toBe(11)
    expect(row("risk-unified-no-equity-cli-json").outcome.exitCode).toBe(11)
    expect(row("risk-unified-no-equity-mcp").outcome.isError).toBe(false)
    for (const body of [row("risk-unified-no-equity-cli-json").outcome.body, row("risk-unified-no-equity-mcp").outcome.body, row("risk-unified-no-equity-sdk").outcome.body]) {
      expect(body).toMatchObject({
        mode: "unifiedAccount",
        level: "critical",
        account: { marginRatio: null },
        unified: { ratio: null, ratioToken: null },
        drivers: [{ kind: "margin", level: "critical", marginRatio: null, reason: "no equity" }],
      })
    }
    expect(textOf(row("risk-unified-no-equity-cli").outcome.lines)).toContain("Unified ratio  none (no available collateral)")
  })

  test("account and positions displays carry the unified block and spot balances when the switch is on", () => {
    const cliAccount = row("account-unified-on-cli-json").outcome.body
    const mcpAccount = row("account-unified-on-mcp").outcome.body
    const sdkAccount = row("account-unified-on-sdk").outcome.body
    expect(cliAccount).toEqual(mcpAccount)
    expect(cliAccount).toEqual(sdkAccount)
    expect(cliAccount).toMatchObject({
      mode: "unifiedAccount",
      accountValueUsd: "1000.0",
      freeMarginUsd: "900",
      withdrawableUsd: "900",
      unified: { ratioToken: 0, dexes: ["", "xyz", "alt"] },
    })
    const accountHuman = textOf(row("account-unified-on-cli").outcome.lines)
    expect(accountHuman).toContain("Mode                 unifiedAccount")
    expect(accountHuman).toContain("Unified ratio        0.0556 (USDC)")
    expect(accountHuman).toContain("Unified dexes        main, xyz, alt")

    const posJson = row("positions-unified-on-cli-json").outcome.body
    const posMcp = row("positions-unified-on-mcp").outcome.body
    expect(posJson).toEqual(posMcp)
    expect(posJson.rows.map((p: any) => p.coin)).toEqual(["BTC", "xyz:TSLA"])
    expect(posJson.risk.unified).toMatchObject({ ratioToken: 0, dexes: ["", "xyz", "alt"] })
    const posHuman = textOf(row("positions-unified-on-cli").outcome.lines)
    expect(posHuman).toContain("Unified ratio        0.0556 (USDC)")
    expect(posHuman).toContain("Unified dexes        main, xyz, alt")
    expect(posHuman).toContain("xyz:TSLA")
  })

  test("watch reads the switch once on start and emits the unified block on its level event (CLI and SDK)", () => {
    expect(row("watch-unified-on-cli").outcome.exitCode).toBe(10)
    expect(row("watch-unified-on-sdk").outcome.level).toBe("warn")
    for (const id of ["watch-unified-on-cli", "watch-unified-on-sdk"]) {
      const events = row(id).outcome.events
      expect(events.map((e: any) => e.event)).toEqual(["start", "level"])
      expect(events[1]).toMatchObject({
        mode: "unifiedAccount",
        level: "warn",
        unified: { ratioToken: 0, dexes: ["", "xyz", "alt"] },
      })
    }
  })

  test("SDK getPerpsRisk() surfaces unifiedAccounts from /keys/self/limits and defaults false when omitted", () => {
    expect(row("limits-switch-on-sdk").outcome.body.unifiedAccounts).toBe(true)
    expect(row("limits-switch-off-sdk").outcome.body.unifiedAccounts).toBe(false)
    expect(row("limits-older-api-sdk").outcome.body.unifiedAccounts).toBe(false)
  })
})

describe("switch off and standard-mode wallets unchanged", () => {
  test("while the switch is off or omitted, a unified wallet answers unknown PERPS_ACCOUNT_MODE with zero spot or builder-dex calls", () => {
    for (const scenario of ["risk-unified-switch-off", "risk-unified-older-api"]) {
      for (const suffix of ["cli", "cli-json", "mcp", "sdk"]) {
        const types = venueTypes(`${scenario}-${suffix}`)
        expect(types.sort()).toEqual(["clearinghouseState", "metaAndAssetCtxs", "userAbstraction"])
      }
      expect(row(`${scenario}-cli`).outcome.exitCode).toBe(1)
      expect(flat(row(`${scenario}-cli`).outcome.stderr)).toContain("unifiedAccount mode, and Candle's unified accounts are off")
      expect(row(`${scenario}-cli-json`).outcome).toMatchObject({ exitCode: 1, body: { ok: false, code: "PERPS_ACCOUNT_MODE" } })
      expect(row(`${scenario}-mcp`).outcome).toMatchObject({ isError: true, body: { error: { code: "PERPS_ACCOUNT_MODE" }, report: { level: "unknown", mode: "unifiedAccount", account: null } } })
      expect(row(`${scenario}-sdk`).outcome.body).toMatchObject({ level: "unknown", reason: "PERPS_ACCOUNT_MODE", mode: "unifiedAccount", account: null, positions: [] })
      expect(row(`${scenario}-sdk`).outcome.body).not.toHaveProperty("unified")
    }
    expect(row("account-unified-off-sdk").outcome.body).toMatchObject({ mode: "unifiedAccount", risk: { level: "unknown", reason: "PERPS_ACCOUNT_MODE" } })
    expect(row("account-unified-off-sdk").outcome.body).not.toHaveProperty("accountValueUsd")
    expect(row("account-unified-off-sdk").outcome.body).not.toHaveProperty("unified")
    expect(venueTypes("account-unified-off-sdk")).not.toContain("spotClearinghouseState")
  })

  test("standard-mode wallets are byte-for-byte identical whether unifiedAccounts is on or off and never call unified endpoints", () => {
    for (const suffix of ["cli", "cli-json", "mcp", "sdk"]) {
      expect(row(`risk-standard-switch-on-${suffix}`).outcome).toEqual(row(`risk-standard-switch-off-${suffix}`).outcome)
      expect(venueTypes(`risk-standard-switch-on-${suffix}`).sort()).toEqual(["clearinghouseState", "metaAndAssetCtxs", "userAbstraction"])
      expect(venueTypes(`risk-standard-switch-off-${suffix}`).sort()).toEqual(["clearinghouseState", "metaAndAssetCtxs", "userAbstraction"])
    }
    const stdReport = row("risk-standard-switch-on-sdk").outcome.body
    expect(stdReport).toMatchObject({
      mode: "default",
      level: "ok",
      account: { accountValueUsd: "1200", withdrawableUsd: "1050", marginUsedUsd: "150", mode: "default" },
    })
    expect(stdReport).not.toHaveProperty("unified")
    expect(textOf(row("risk-standard-switch-on-cli").outcome.lines)).not.toContain("Unified ratio")
    expect(textOf(row("risk-standard-switch-on-cli").outcome.lines)).not.toContain("Unified dexes")

    expect(row("account-standard-on-sdk").outcome.body).toMatchObject({ mode: "default", accountValueUsd: "1200", withdrawableUsd: "1050" })
    expect(row("account-standard-on-sdk").outcome.body).not.toHaveProperty("unified")
    expect(venueTypes("account-standard-on-sdk")).not.toContain("spotClearinghouseState")
    expect(textOf(row("account-standard-on-cli").outcome.lines)).not.toContain("Unified ratio")

    expect(row("positions-standard-on-cli-json").outcome.body.risk).not.toHaveProperty("unified")
    expect(textOf(row("positions-standard-on-cli").outcome.lines)).not.toContain("Unified ratio")
  })
})

describe("help, docs and Candle Harness routing", () => {
  test("Candle's CLI help, agent-trading docs and limits route document the unified path and its switch", () => {
    const docs = row("source-docs-and-help").outcome
    expect(docs.docModeRow).toContain("HYPERLIQUID_UNIFIED_ACCOUNTS")
    expect(docs.docModeRow).toContain("unifiedAccount")
    expect(docs.docUnifiedParagraph).toContain("spotClearinghouseState")
    expect(docs.docUnifiedParagraph).toContain("unifiedAccounts: true")
    expect(docs.docUnifiedParagraph).toContain("PERPS_ACCOUNT_MODE")
    expect(docs.helpUnifiedText).toContain("unifiedAccount")
    expect(docs.helpUnifiedText).toContain("GET /keys/self/limits")
    expect(docs.limitsRouteLine).toBe("unifiedAccounts: perpsUnifiedAccountsEnabled()")
  })

  test("risk, account and positions stay reads in the Candle Harness, setup stays a held write, and the agent reads the unified payload whole", () => {
    for (const tool of ["candle_perps_risk", "candle_perps_account", "candle_perps_positions"]) {
      expect(TOOL_CLASSES[tool]).toEqual({ class: "read" })
      for (const mode of ["live", "paper"] as const) expect(classify(tool, { wallet: "wallet-unified" }, mode)).toEqual({ class: "read" })
    }
    expect(classify("candle_perps_setup", { wallet: "wallet-unified" }, "live").class).toBe("refused")
    expect(rowFor("perps setup")).toMatchObject({ rule: "card", route: "later", identity: "agent" })
    expect(rowFor("perps risk")).toMatchObject({ rule: "mcp", mcpTool: "candle_perps_risk" })
    expect(rowFor("perps account")).toMatchObject({ rule: "mcp", mcpTool: "candle_perps_account" })
    expect(rowFor("perps positions")).toMatchObject({ rule: "mcp", mcpTool: "candle_perps_positions" })

    // The Candle Harness MCP outcome passes the unified risk and account bodies through untouched.
    for (const id of ["risk-unified-ok-mcp", "risk-unified-warn-ratio-mcp", "risk-unified-no-equity-mcp", "account-unified-on-mcp"]) {
      const { outcome } = row(id)
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: outcome.isError })).toEqual({ kind: "ok", result: outcome.body })
    }
    const refused = row("risk-unified-switch-off-mcp").outcome
    expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(refused.body) }], isError: refused.isError }).kind).not.toBe("ok")
  })
})
