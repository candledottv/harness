// Hyperliquid unified accounts (BE-3863) as the PUBLISHED npm packages behave: the exported SDK entry point, the shipped
// `candle` CLI binary and the shipped `candle-mcp` server, installed at exact pins and driven offline against stand-in Candle
// and Hyperliquid answers (scripts/run-perps-unified-packages.ts). The source recording (perps-unified-source-contracts.test.ts)
// reads TypeScript from a monorepo checkout; this file is what catches a build or packaging regression between that source and
// the tarballs people install. Nothing is signed, submitted or sent over the network.
import { describe, expect, test } from "bun:test"
import pins from "../../scripts/perps-unified-packages.json"
import packaged from "../../test/fixtures/candle-perps-unified-packages.json"
import source from "../../test/fixtures/candle-perps-unified-source.json"

type Req = { host: string; method: string; path: string; body?: Record<string, any> }
type Row = { id: string; scenario: string; surface: string; args?: Record<string, any>; requests: Req[]; outcome: any }
const rows = packaged.rows as Row[]
const sourceRows = source.rows as (Row & { requests?: Req[] })[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing package run ${id}`)
  return found
}
const venueTypes = (r: Row) => r.requests.filter((q) => q.host === "api.hyperliquid.xyz").map((q) => (q.body?.dex ? `${q.body.type}:${q.body.dex}` : String(q.body?.type)))
// The shipped MCP server reads the key's public profile once when it starts; the in-process source recorder builds the server directly.
const withoutMcpStartup = (r: Row) => (r.surface === "mcp" ? r.requests.filter((q) => !q.path.endsWith("/keys/self/public-profile")) : r.requests)

describe("the run is pinned to the published packages", () => {
  test("exact versions, registry integrity and the shipped entry points", () => {
    expect(packaged.packages).toEqual({
      "@candledottv/cli": { version: "0.13.35", integrity: expect.stringMatching(/^sha512-/) },
      "@candledottv/mcp": { version: "0.10.40", integrity: expect.stringMatching(/^sha512-/) },
      "@candledottv/agent-sdk": { version: "0.6.29", integrity: expect.stringMatching(/^sha512-/) },
    })
    expect(Object.fromEntries(Object.entries(packaged.packages).map(([n, p]) => [n, p.version]))).toEqual(pins)
    expect(packaged.entryPoints).toEqual({ sdk: "./dist/index.js", cli: "./dist/index.js", mcp: "./dist/index.js" })
  })

  test("the pins are the same versions as the source recording", () => {
    expect(pins["@candledottv/cli"]).toBe(source.source.versions.cli)
    expect(pins["@candledottv/mcp"]).toBe(source.source.versions.mcp)
    expect(pins["@candledottv/agent-sdk"]).toBe(source.source.versions.sdk)
  })
})

describe("the packages agree with the source recording", () => {
  test("every package row has a source row with the same output (CLI text and JSON, MCP result, SDK result) and the same venue calls", () => {
    expect(rows.length).toBe(70)
    for (const r of rows) {
      const s = sourceRows.find((x) => x.id === r.id)
      expect(s, `source row for ${r.id}`).toBeDefined()
      expect(r.outcome, `${r.id} outcome`).toEqual(s!.outcome)
      expect(withoutMcpStartup(r), `${r.id} requests`).toEqual(s!.requests ?? [])
    }
  })

  test("the only extra request is the shipped MCP server's startup profile read, first and once", () => {
    for (const r of rows.filter((x) => x.surface === "mcp")) {
      expect(r.requests[0]).toMatchObject({ host: "api.test", method: "GET", path: "/api/v1/agent/keys/self/public-profile" })
      expect(r.requests.filter((q) => q.path.endsWith("/keys/self/public-profile"))).toHaveLength(1)
    }
    for (const r of rows.filter((x) => x.surface !== "mcp")) expect(r.requests.some((q) => q.path.endsWith("/keys/self/public-profile"))).toBe(false)
  })

  test("every scenario ran through all three published entry points", () => {
    const scenarios = ["setup-unified-on", "setup-unified-off", "setup-unified-older-api", "setup-standard-with-switch-on", "setup-unsupported-mode"]
      .concat(["risk-unified-ok", "risk-unified-warn-ratio", "risk-unified-no-equity", "risk-unified-switch-off", "risk-unified-older-api", "risk-standard-switch-on", "risk-standard-switch-off"])
      .concat(["account-unified-on", "account-unified-off", "account-standard-on"])
    for (const id of scenarios) for (const suffix of ["cli", "cli-json", "mcp", "sdk"]) expect(rows.some((r) => r.id === `${id}-${suffix}`), `${id}-${suffix}`).toBe(true)
    for (const id of ["positions-unified-on", "positions-standard-on"]) for (const suffix of ["cli", "cli-json", "mcp"]) expect(rows.some((r) => r.id === `${id}-${suffix}`), `${id}-${suffix}`).toBe(true)
    for (const id of ["limits-switch-on", "limits-switch-off", "limits-older-api", "watch-unified-on"]) expect(rows.some((r) => r.id === `${id}-sdk`)).toBe(true)
  })
})

describe("setup", () => {
  test("a unified wallet with the switch on reaches POST /perps/setup from every shipped entry point and reports unified mode", () => {
    for (const s of ["cli-json", "mcp", "sdk"] as const) {
      const r = row(`setup-unified-on-${s}`)
      expect(r.requests.some((q) => q.method === "POST" && q.path === "/api/v1/agent/perps/setup"), s).toBe(true)
      const body = r.outcome.body
      expect(body).toMatchObject({ ready: true, mode: "unifiedAccount", standardMode: false })
    }
    expect(row("setup-unified-on-cli").outcome.exitCode).toBe(0)
  })

  test("with the switch off, on an older API, or in an unsupported mode, setup is refused before the server is asked to set anything up", () => {
    for (const id of ["setup-unified-off", "setup-unified-older-api", "setup-unsupported-mode"]) {
      for (const s of ["cli", "cli-json", "mcp", "sdk"]) {
        const r = row(`${id}-${s}`)
        expect(r.requests.some((q) => q.method === "POST" && q.path === "/api/v1/agent/perps/setup"), `${id}-${s}`).toBe(false)
      }
      expect(row(`${id}-cli`).outcome.exitCode).toBe(1)
      expect(row(`${id}-cli-json`).outcome.body).toMatchObject({ ok: false, code: "PERPS_ACCOUNT_MODE" })
      expect(row(`${id}-mcp`).outcome.isError).toBe(true)
      expect(row(`${id}-sdk`).outcome.error.message).toContain("PERPS_ACCOUNT_MODE")
    }
  })

  test("a standard wallet skips the switch lookup and is set up as before, with the switch on", () => {
    for (const s of ["cli-json", "mcp", "sdk"]) {
      const r = row(`setup-standard-with-switch-on-${s}`)
      expect(r.requests.some((q) => q.path === "/api/v1/agent/keys/self/limits")).toBe(false)
      expect(r.requests.some((q) => q.method === "POST" && q.path === "/api/v1/agent/perps/setup")).toBe(true)
      expect(r.outcome.body).toMatchObject({ ready: true, mode: "default", standardMode: true })
    }
  })
})

describe("risk and account displays", () => {
  test("a unified wallet with the switch on is read through spot collateral and every dex, and prints the unified rows", () => {
    for (const s of ["cli", "cli-json", "mcp", "sdk"]) {
      const types = venueTypes(row(`risk-unified-ok-${s}`))
      expect(types, s).toContain("spotClearinghouseState")
      expect(types, s).toContain("clearinghouseState:xyz")
      expect(types, s).not.toContain("metaAndAssetCtxs:alt")
    }
    const text = row("risk-unified-ok-cli").outcome.lines.join("\n")
    expect(text).toContain("Unified ratio")
    expect(text).toContain("Unified dexes")
    expect(text).toContain("unifiedAccount")
    const body = row("risk-unified-ok-cli-json").outcome.body
    expect(body.unified).toBeDefined()
    expect(body).toMatchObject({ level: "ok" })
  })

  test("the warn and no-equity levels exit 10 and 11 from the shipped CLI", () => {
    expect(row("risk-unified-warn-ratio-cli").outcome.exitCode).toBe(10)
    expect(row("risk-unified-warn-ratio-cli-json").outcome.body.level).toBe("warn")
    expect(row("risk-unified-no-equity-cli").outcome.exitCode).toBe(11)
    expect(row("risk-unified-no-equity-cli-json").outcome.body.level).toBe("critical")
  })

  test("a unified wallet with the switch off or an older API reads nothing from spot or builder dexes", () => {
    for (const id of ["risk-unified-switch-off", "risk-unified-older-api", "account-unified-off"]) {
      for (const s of ["cli", "cli-json", "mcp", "sdk"]) {
        const r = rows.find((x) => x.id === `${id}-${s}`)
        if (!r) continue
        const types = venueTypes(r)
        expect(types, `${id}-${s}`).not.toContain("spotClearinghouseState")
        expect(types.some((t) => t.includes(":")), `${id}-${s}`).toBe(false)
      }
    }
    expect(row("risk-unified-switch-off-cli").outcome.exitCode).toBe(1)
    expect(row("risk-unified-switch-off-mcp").outcome.isError).toBe(true)
  })

  test("the unified account display adds the unified rows and nothing else changes shape", () => {
    const text = row("account-unified-on-cli").outcome.lines.join("\n")
    expect(text).toContain("Unified ratio")
    expect(text).toContain("Unified dexes")
    expect(row("account-unified-on-cli-json").outcome.body.unified).toBeDefined()
  })
})

describe("standard-mode wallets are unchanged", () => {
  test("risk output is identical with the switch on or off from every shipped entry point, with no unified block", () => {
    for (const s of ["cli", "cli-json", "mcp", "sdk"]) {
      const on = row(`risk-standard-switch-on-${s}`)
      const off = row(`risk-standard-switch-off-${s}`)
      expect(on.outcome, s).toEqual(off.outcome)
      expect(JSON.stringify(on.outcome), s).not.toMatch(/"unified"|Unified (ratio|dexes)/)
    }
  })

  test("standard wallets never touch spot, dex discovery or builder dexes", () => {
    for (const id of ["risk-standard-switch-on", "risk-standard-switch-off", "account-standard-on", "positions-standard-on"]) {
      for (const s of ["cli", "cli-json", "mcp", "sdk"]) {
        const r = rows.find((x) => x.id === `${id}-${s}`)
        if (!r) continue
        const types = venueTypes(r)
        for (const forbidden of ["spotClearinghouseState", "perpDexs", "allPerpMetas"]) expect(types, `${id}-${s}`).not.toContain(forbidden)
        expect(types.some((t) => t.includes(":")), `${id}-${s}`).toBe(false)
      }
    }
    expect(row("account-standard-on-cli-json").outcome.body.unified).toBeUndefined()
    expect(row("positions-standard-on-cli-json").outcome.body.unified).toBeUndefined()
  })

  test("positions show the unified rows only for the unified wallet", () => {
    expect(row("positions-unified-on-cli").outcome.lines.join("\n")).toContain("Unified ratio")
    expect(row("positions-standard-on-cli").outcome.lines.join("\n")).not.toContain("Unified")
  })
})

describe("the run is offline and signs nothing", () => {
  test("no request reaches anything but the two stand-in hosts, and none signs, submits or withdraws", () => {
    for (const r of rows) {
      for (const q of r.requests) {
        expect(["api.test", "api.hyperliquid.xyz"], r.id).toContain(q.host)
        expect(q.path, r.id).not.toMatch(/\/sign$|\/exchange$|\/withdraw/)
      }
    }
  })

  test("no key, private key or real address is in the recording", () => {
    const text = JSON.stringify(packaged)
    expect(text).not.toContain("fixture-only-not-a-key")
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
    expect(text).not.toContain("perps-unified-run-")
    for (const hex of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) expect(hex).toMatch(/^0x0{39}[0-9]$/)
  })
})
