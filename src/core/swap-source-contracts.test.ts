// The CLI's swap fast path (BE-3923), as Candle's source runs it: the job, wallet and decimals reads on the wire
// together, the same order of outcomes as before, the embedded wallet's execute probe cached per API URL for a day,
// and the local simulation read from the configured RPC. Recorded offline from one exact commit
// (scripts/read-swap-source.ts). The commit is a staging build: the published CLI 0.13.31, MCP 0.10.36 and SDK 0.6.25
// predate it, so these rows hold only until a release carries it and the pin below moves with it.
import { expect, test } from "bun:test"
import swap from "../../test/fixtures/candle-swap-source.json"
import { PRE_BUILD_CODES } from "./cli-trade"

type Request = { n: number; host: string; path: string; rpc?: string }
type Row = { id: string; scenario: string; evidence?: string; args: { argv: string[] }; requests: Request[]; outcome: Record<string, any> }
const rows = swap.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const executes = (r: Row) => r.requests.filter((q) => q.path === "/api/v1/trade/agent/execute").length

test("the recording names the exact staging build and the files the fast path is in", () => {
  expect(swap.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "aca38574f1a307730318f9bf3be91e7d0b67c0b4",
    versions: { cli: "0.13.31", mcp: "0.10.36", sdk: "0.6.25" },
    files: ["packages/cli/src/commands/swap.ts", "packages/cli/src/trading.ts"],
  })
  expect(rows).toHaveLength(21)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["parallel-reads", "order", "execute-probe", "private-rpc"]))
})

test("nothing in the recording is a key, an address or an RPC's path, and every request is to a made-up host", () => {
  const text = JSON.stringify(swap)
  for (const secret of ["fixture-only-not-a-key", "fixture-path-not-a-key", "BEGIN", "7ZL9Fvkp", "9dXSV8VW"]) expect(text).not.toContain(secret)
  const hosts = new Set(rows.flatMap((r) => r.requests.map((q) => q.host)))
  expect([...hosts].sort()).toEqual(["api.mainnet-beta.solana.com", "api.test", "other-api.test", "rpc.private.test", "rpc.profile.test"])
  // The public endpoint appears once, in the row that names it as the default; no other row reaches it.
  expect(rows.filter((r) => r.requests.some((q) => q.host === "api.mainnet-beta.solana.com")).map((r) => r.id)).toEqual(["private-rpc-default-is-the-public-endpoint"])
})

test("every code a row carries is one the trade path maps before any build", () => {
  const codes = rows.map((r) => r.outcome.code).filter((c) => c !== undefined)
  expect(codes.length).toBeGreaterThan(0)
  for (const code of codes) expect(PRE_BUILD_CODES.has(code), code).toBe(true)
  expect(JSON.stringify(swap)).not.toContain("EMBEDDED_PAYER_UNSUPPORTED")
})

test("the job, the wallet and the decimals are all read before the build, started together", () => {
  const r = row("parallel-reads-tee-swap")
  expect(r.outcome).toMatchObject({ exitCode: 0, readsStartedTogether: ["job", "wallets", "decimals"], readsBeforeBuild: 3, builtAfterReads: true })
  const build = r.requests.findIndex((q) => q.path.endsWith("/build"))
  const before = r.requests.slice(0, build)
  expect(before.map((q) => (q.path.includes("/jobs/") ? "job" : q.path.endsWith("/wallets/trading") || q.path.endsWith("/wallets/embedded") ? "wallets" : q.rpc === "getTokenSupply" ? "decimals" : "other")).sort()).toEqual(["decimals", "job", "wallets", "wallets"])
  expect(r.evidence).toContain("stand-in")
})

test("a job stored under the id still wins, and a read that fails is reported in the old order", () => {
  expect(row("prior-job-wins-over-failed-reads").outcome).toMatchObject({ exitCode: 0, replayed: true, builtAnything: false })
  // Each read fails with its own code: the job read first, then the wallet, then the decimals.
  expect(row("job-read-failure-first").outcome).toMatchObject({ exitCode: 1, code: "SCOPE_MISSING", builtAnything: false })
  expect(row("wallet-failure-over-decimals-failure").outcome).toMatchObject({ exitCode: 1, code: "TIER_REQUIRED", builtAnything: false })
  expect(row("decimals-failure-alone").outcome).toMatchObject({ exitCode: 1, code: "RPC_RATE_LIMITED", builtAnything: false })
  for (const r of scenario("order")) expect(r.requests.some((q) => q.path.endsWith("/build")), r.id).toBe(false)
})

test("a passed execute probe is remembered per API URL for a day and then asked again", () => {
  expect([executes(row("probe-first-trade")), executes(row("probe-cached-second-trade"))]).toEqual([2, 1])
  expect(executes(row("probe-cached-after-23-hours"))).toBe(1)
  expect(executes(row("probe-asks-again-after-25-hours"))).toBe(2)
  expect(executes(row("probe-per-api-url"))).toBe(2)
  expect(row("probe-per-api-url").requests.filter((q) => !q.rpc).every((q) => q.host === "other-api.test")).toBe(true)
  // Declining the quote leaves the pass cached: the next trade skips the probe.
  expect(row("probe-passed-then-quote-declined").outcome).toMatchObject({ exitCode: 5, executedAfterDecline: false, status: "cancelled" })
  expect(executes(row("probe-cached-after-a-declined-quote"))).toBe(1)
})

test("a deployment that fails the probe is refused before any build and asked again next time", () => {
  for (const id of ["probe-failure-never-cached", "probe-failure-asks-again"]) {
    const r = row(id)
    expect(r.outcome).toMatchObject({ exitCode: 1, executeCalls: 1, builtAnything: false })
    expect(r.requests.some((q) => q.path.endsWith("/build"))).toBe(false)
  }
})

test("the local simulation reads from the configured RPC, by flag, then variable, then profile, and its host is the only thing shown", () => {
  const hostOf: Record<string, string> = {
    "private-rpc-flag": "rpc.private.test",
    "private-rpc-env": "rpc.private.test",
    "private-rpc-profile": "rpc.profile.test",
    "private-rpc-flag-over-env": "rpc.private.test",
    "private-rpc-default-is-the-public-endpoint": "api.mainnet-beta.solana.com",
  }
  for (const [id, host] of Object.entries(hostOf)) {
    const r = row(id)
    expect(r.outcome, id).toMatchObject({ exitCode: 0, rpcHosts: [host], simulatedLocally: true, hostShown: true, pathShown: false })
    expect(r.requests.filter((q) => q.rpc).every((q) => q.host === host && q.path === "<rpc>"), id).toBe(true)
    expect(r.requests.some((q) => q.rpc === "simulateTransaction"), id).toBe(true)
    // The Candle API is never a Solana endpoint.
    expect(r.requests.filter((q) => q.host === "api.test").some((q) => q.rpc), id).toBe(false)
  }
})

test("an RPC that is not https, or not a URL, is refused with usage before any request is built, and is never echoed", () => {
  for (const id of ["private-rpc-refused-plain-http", "private-rpc-refused-not-a-url"]) {
    expect(row(id).outcome).toEqual({ exitCode: 2, code: "USAGE", builtAnything: false })
    expect(row(id).requests.some((q) => q.path.endsWith("/build"))).toBe(false)
  }
})
