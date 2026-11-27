// Hood generation 2 launch options (BE-4351, the harness sibling of BE-4350) recorded from the published npm
// packages by `scripts/run-hood-gen2-packages.ts`. Nothing is launched, signed or sent over a network.
import { describe, expect, test } from "bun:test"
import pins from "../../scripts/hood-gen2-packages.json"
import packaged from "../../test/fixtures/candle-hood-gen2-packages.json"

type Row = { id: string; scenario: string; surface: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = packaged.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing Hood gen 2 recording ${id}`)
  return found
}
const TOP_KEYS = ["snipeExempt", "feeWallet", "creatorFeeBps", "teamAllocation", "launchRules"]
const A = (n: number) => `0x${String(n).repeat(40)}`
const BASE = { clientLaunchId: "cl-fixture-1", name: "T", symbol: "TT", imageUrl: "https://img.fixture.test/a.png", chain: "hood", quoteAsset: "eth" }
const hoodBody = (extra: Record<string, unknown>) => ({ ...BASE, dexVersion: "v3", ...extra })
const mcpBody = (extra: Record<string, unknown>) => ({ ...BASE, ...extra })

// What each option must put on the wire, as the API's top-level keys.
const FRAGMENTS: Record<string, Record<string, unknown>> = {
  "snipe-exempt": { snipeExempt: [A(1), A(2)] },
  "snipe-exempt-empty": { snipeExempt: [] },
  "fee-wallet": { feeWallet: A(3), creatorFeeBps: 150 },
  "creator-fee-bps": { creatorFeeBps: 150 },
  "creator-fee-bps-zero": { creatorFeeBps: 0 },
  "team-allocation": { teamAllocation: { recipient: A(4), percent: 2.5, cliffDays: 30, vestingDays: 90 } },
  "launch-rules-sniper-fee": { launchRules: { snipeFeeStartBps: 500, snipeFeeDecaySecs: 60 } },
  "launch-rules-open-cap-allowlist": {
    launchRules: { openDelaySecs: 5400, maxBuyPerWalletRaw: "500000000000000000", capWindowSecs: 3600, allowlist: [A(5), A(6)], allowlistWindowSecs: 1800, devBuyMaxRaw: "100000000000000000" },
  },
  "all-options-together": {
    snipeExempt: [A(1)],
    feeWallet: A(3),
    creatorFeeBps: 150,
    teamAllocation: { recipient: A(4), percent: 2.5, cliffDays: 30, vestingDays: 90 },
    launchRules: { snipeFeeStartBps: 500, snipeFeeDecaySecs: 60 },
  },
}
const NOT_ON_MCP = ["fee-wallet", "all-options-together"]

describe("pinned to the published npm packages", () => {
  test("exact versions and hashes", () => {
    expect(Object.fromEntries(Object.entries(packaged.packages).map(([n, p]) => [n, p.version]))).toEqual(pins)
    expect(pins).toEqual({ "@candledottv/cli": "0.13.50", "@candledottv/mcp": "0.10.48", "@candledottv/agent-sdk": "0.6.41" })
    for (const p of Object.values(packaged.packages)) expect((p as { integrity?: string }).integrity).toMatch(/^sha512-/)
    expect(rows).toHaveLength(39)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })

  test("no key, secret or local path, and made-up addresses only", () => {
    const text = JSON.stringify(packaged)
    expect(text).not.toContain("BEGIN")
    expect(text).not.toContain("fixture-only-not-a-key")
    expect(text).not.toContain("/tmp/")
    for (const m of text.match(/0x[0-9a-fA-F]{40}/g) ?? []) expect(/^0x(\d)\1{39}$/.test(m)).toBe(true)
  })
})

describe("a Hood launch sends each gen 2 option as a top-level key (SDK, CLI, MCP)", () => {
  for (const [name, fragment] of Object.entries(FRAGMENTS)) {
    test(`${name}: SDK and CLI body`, () => {
      for (const surface of ["sdk", "cli"] as const) {
        const r = row(`${surface}-hood-dry-run-${name}`)
        expect(r.outcome.path).toBe("/api/v1/launch/headless/dry-run")
        // The first buy (0.1 ETH) rides on the open/cap/allowlist case only, as buyAmount.
        const extra = name === "launch-rules-open-cap-allowlist" ? { buyAmount: "100000000000000000" } : {}
        expect(r.outcome.body).toEqual(hoodBody({ ...fragment, ...extra }))
        expect(r.outcome.topLevelKeys).toEqual(TOP_KEYS.filter((k) => k in fragment))
        expect(r.outcome.wrapperSent).toBe(false)
        expect(r.outcome.body).not.toHaveProperty("hoodGen2Options")
      }
    })
    if (!NOT_ON_MCP.includes(name)) {
      test(`${name}: MCP body`, () => {
        const r = row(`mcp-hood-dry-run-${name}`)
        expect(r.outcome.path).toBe("/api/v1/launch/headless/dry-run")
        expect(r.outcome.body).toEqual(mcpBody(fragment))
        expect(r.outcome.wrapperSent).toBe(false)
        expect(r.outcome.body).not.toHaveProperty("hoodGen2Options")
      })
    }
  }

  test("an explicit empty snipeExempt is sent as [] and creatorFeeBps 0 as 0", () => {
    for (const s of ["sdk", "cli", "mcp"]) {
      expect(row(`${s}-hood-dry-run-snipe-exempt-empty`).outcome.body.snipeExempt).toEqual([])
      expect(row(`${s}-hood-dry-run-creator-fee-bps-zero`).outcome.body.creatorFeeBps).toBe(0)
    }
  })

  test("the SDK's real launch() (stubbed response) posts the same top-level keys and no wrapper", () => {
    const r = row("sdk-hood-launch-all-options-stubbed")
    expect(r.outcome.path).toBe("/api/v1/launch/headless")
    expect(r.outcome.body).toEqual(hoodBody(FRAGMENTS["all-options-together"]!))
    expect(r.outcome.wrapperSent).toBe(false)
  })

  test("MCP withholds feeWallet (BE-4350): it is not one of its options", () => {
    expect(rows.filter((r) => r.surface === "mcp" && r.id.includes("fee-wallet") && r.scenario === "hood-body")).toEqual([])
    expect(row("mcp-check-refuses-misplaced-or-unknown-gen2-key").outcome.refusals["feeWallet-withheld-on-mcp"]).toEqual({ isError: true, httpCalls: 0, mentionsKey: true })
  })

  test("the SDK refuses a wrapper, unknown nested keys and an unaffordable fee stack with nothing requested", () => {
    const o = row("sdk-hood-refusals-send-nothing").outcome
    expect(o.requests).toBe(0)
    expect(o.wrapper.code).toBe("VALIDATION_FAILED")
    expect(o.wrapper.message).toContain("not hoodGen2Options")
    expect(o.unknownRule.message).toContain("launchRules.notARule")
    expect(o.unknownTeamKey.message).toContain("teamAllocation.bogus")
    expect(o.creatorFeeOver.message).toContain("0 to 9999")
    expect(o.feeStack.message).toContain("under 100%")
  })
})

describe("MCP check mode refuses a misplaced or unknown gen 2 key with zero HTTP calls", () => {
  test("every case is an error with no request", () => {
    const o = row("mcp-check-refuses-misplaced-or-unknown-gen2-key")
    expect(Object.keys(o.outcome.refusals)).toEqual(o.args.cases)
    expect(o.args.cases).toEqual(["wrapper-hoodGen2Options", "unknown-top-level-key", "unknown-launchRules-key", "unknown-teamAllocation-key", "snipeExempt-nested-in-launchRules", "feeWallet-withheld-on-mcp"])
    for (const v of Object.values(o.outcome.refusals) as Record<string, unknown>[]) expect(v).toEqual({ isError: true, httpCalls: 0, mentionsKey: true })
  })
  test("valid gen 2 keys in check mode make only the one preflight read", () => {
    expect(row("mcp-check-valid-gen2-keys-reach-preflight-only").outcome.requests).toEqual([{ method: "GET", path: "/api/v1/launch/preflight" }])
  })
  test("a launch (not a check) with a wrapper or an unknown key is refused too", () => {
    expect(row("mcp-hood-launch-refuses-wrapper-and-unknown-key").outcome.refusals).toEqual({ wrapper: { isError: true, httpCalls: 0 }, unknownKey: { isError: true, httpCalls: 0 } })
  })
})

describe("Solana: Hood-only fields are refused, creatorFeeBps: null is accepted, the body is unchanged", () => {
  const SDK_MCP_CASES = ["snipeExempt", "snipeExempt-null", "teamAllocation", "teamAllocation-null", "launchRules.snipeFeeStartBps", "launchRules.snipeFeeStartBps-null", "launchRules.snipeFeeDecaySecs", "launchRules.snipeFeeDecaySecs-null", "creatorFeeBps-150"]
  test("SDK refuses each with nothing requested, explicit nulls included", () => {
    const r = row("sdk-solana-hood-only-fields-refused")
    expect(r.args.cases).toEqual(SDK_MCP_CASES)
    expect(r.outcome.requests).toBe(0)
    for (const c of SDK_MCP_CASES) expect(r.outcome.refusals[c].code).toBe("VALIDATION_FAILED")
    expect(r.outcome.refusals["snipeExempt-null"].message).toContain("only available on Hood")
    expect(r.outcome.refusals["teamAllocation-null"].message).toContain("only available on Hood")
    expect(r.outcome.refusals["launchRules.snipeFeeStartBps-null"].message).toContain("only available on Hood")
    expect(r.outcome.refusals["launchRules.snipeFeeDecaySecs-null"].message).toContain("only available on Hood")
    expect(r.outcome.refusals["creatorFeeBps-150"].message).toContain("0, 100 or 200")
  })
  test("MCP refuses each with no HTTP call, explicit nulls included", () => {
    const r = row("mcp-solana-hood-only-fields-refused")
    expect(r.args.cases).toEqual(SDK_MCP_CASES)
    for (const c of SDK_MCP_CASES) expect(r.outcome.refusals[c]).toEqual({ isError: true, httpCalls: 0 })
  })
  test("the CLI refuses the Hood-only flags and a creator fee off 0/100/200 with nothing requested", () => {
    const r = row("cli-solana-hood-only-flags-refused")
    expect(r.outcome.requests).toBe(0)
    for (const v of Object.values(r.outcome.refusals) as { exitCode: number }[]) expect(v.exitCode).not.toBe(0)
    expect(r.outcome.refusals["team-percent"].message).toContain("only available on Hood")
  })
  test("creatorFeeBps: null is accepted by the SDK and MCP and goes out as null; 100 is accepted by the CLI", () => {
    expect(row("sdk-solana-creator-fee-bps-null-accepted").outcome.body).toEqual({ clientLaunchId: BASE.clientLaunchId, name: "T", symbol: "TT", imageUrl: BASE.imageUrl, chain: "solana", creatorFeeBps: null })
    expect(row("mcp-solana-creator-fee-bps-null-accepted").outcome.body.creatorFeeBps).toBeNull()
    expect(row("cli-solana-creator-fee-bps-accepted").outcome.body).toMatchObject({ chain: "solana", mode: "exp-a", creatorFeeBps: 100 })
  })
  test("a plain Solana launch body carries none of the gen 2 keys and no wrapper", () => {
    for (const s of ["sdk", "cli", "mcp"]) {
      const r = row(`${s}-solana-body-unchanged`)
      expect(r.outcome.hoodOnlyKeysPresent).toEqual([])
      expect(r.outcome.body).not.toHaveProperty("hoodGen2Options")
      expect(r.outcome.body.chain).toBe("solana")
    }
    expect(row("sdk-solana-body-unchanged").outcome.body).toEqual({ clientLaunchId: "cl-fixture-1", name: "T", symbol: "TT", imageUrl: BASE.imageUrl, chain: "solana" })
    expect(row("mcp-solana-body-unchanged").outcome.body).toEqual({ clientLaunchId: "cl-fixture-1", name: "T", symbol: "TT", imageUrl: BASE.imageUrl, chain: "solana" })
    expect(row("cli-solana-body-unchanged").outcome.body).toEqual({ clientLaunchId: "cl-fixture-1", chain: "solana", name: "T", symbol: "TT", imageUrl: BASE.imageUrl, quoteAsset: "sol" })
  })
})
