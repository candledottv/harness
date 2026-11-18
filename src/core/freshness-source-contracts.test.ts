// How fresh an agent's public Hyperliquid figures are (BE-3767), as Candle's source says it: between certified
// hours each wallet is read again every board build (about 10 minutes) and the figures are marked provisional,
// and the hourly certified snapshot stays underneath and replaces them when it certifies the hour. Recorded
// offline from one exact commit (scripts/read-freshness-source.ts): Candle's pure perps source builds each
// positions answer from made-up stored facts, and the registered MCP tool, the SDK and `candle agent positions`
// read it. The commit is a staging build: the published CLI 0.13.30, MCP 0.10.35 and SDK 0.6.24 predate it.
import { describe, expect, test } from "bun:test"
import freshness from "../../test/fixtures/candle-freshness-source.json"
import perps from "../../test/fixtures/candle-perps-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { toOutcome } from "./candle-mcp"
import { classify } from "./classify"
import { rowFor, SOURCE } from "./cli-table"
import { resolveCall } from "./cli-tool"

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, any>; requests?: Request[]; outcome: any }
const rows = freshness.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const H = 3_600_000, M = 60_000
const DAY = Date.parse(`${freshness.day}T00:00:00Z`)
const at = (h: number, m = 0) => DAY + h * H + m * M
/** The builds of the made-up day, in order. */
const BUILDS = [
  "certified", "provisional", "provisional-next-build", "provisional-one-missed-refresh", "provisional-too-old", "certified-supersedes", "provisional-on-new-hour",
  "delayed", "unavailable", "provisional-while-certification-lags", "certified-base-too-old", "never-certified", "no-perps",
] as const
type Build = (typeof BUILDS)[number]
const api = (id: Build) => row(`${id}-api`).outcome as { read: any; positions: any; record: { record: any } }
const positions = (id: Build) => api(id).positions
const record = (id: Build) => api(id).record.record
const buildAt = (id: Build) => { const [h, m] = row(`${id}-api`).buildAt!.split(":").map(Number); return at(h!, m!) }
const perpRows = (id: Build) => positions(id).positions.filter((p: { kind: string }) => p.kind === "perp")
const PATH = `/api/v1/agent/records/${freshness.profile}/positions`

test("the recording names the exact staging build, agrees with the other source fixtures, and carries Candle's own limits", () => {
  expect(freshness.source).toEqual({ repo: "candledottv/candle-monorepo", commit: "df74deb0d9cf0f9e67842dfa4e1086035288557e", versions: { cli: "0.13.30", mcp: "0.10.35", sdk: "0.6.24" } })
  expect(freshness.source.commit).toBe(SOURCE.source.commit)
  expect(freshness.source.commit).toBe(tools.source.commit)
  expect(freshness.source.commit).toBe(perps.source.commit)
  // Read from the source's constants, not written here: partial past 2 hours, unavailable past 3, a provisional
  // read used for 15 minutes, on a certified cutoff at most 6 hours under it.
  expect(freshness.rules).toEqual({ staleMs: 2 * H, unavailableMs: 3 * H, provisionalMaxAgeMs: 15 * M, provisionalBaseMaxMs: 6 * H })
  expect(rows).toHaveLength(BUILDS.length * 5 + 2)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  for (const id of BUILDS) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(["api-source", "cli", "cli", "mcp", "sdk"])
})

test("nothing in the recording is a wallet address, a key or an account figure", () => {
  const text = JSON.stringify(freshness)
  expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/)
  expect(text).not.toMatch(/"(wallet|address|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid)"/i)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key/)
  expect(freshness.profile).toBe("prof_0123456789abcdef")
  // The answers are made by the pure source, and each row says the database, jobs and keyed route did not run.
  for (const id of BUILDS) expect(row(`${id}-api`).evidence).toContain("the keyed route are not executed")
})

describe("between certified hours", () => {
  test("certified figures carry the certified cutoff and no provisional mark", () => {
    const p = positions("certified")
    expect(api("certified").read).toEqual({ kind: "certified", certifiedCutoff: "10:02", provisionalRead: null })
    expect(p.perpsAsOfMs).toBe(at(10, 2))
    expect(p).not.toHaveProperty("perpsProvisional")
    expect(p).not.toHaveProperty("perpsCertifiedAsOfMs")
    expect(p).toMatchObject({ perpsPartial: false, portfolioPartial: false })
    expect(record("certified")).toMatchObject({ perpsAsOfMs: at(10, 2), perpsPartial: false })
    expect(record("certified")).not.toHaveProperty("perpsProvisional")
  })

  test("a provisional read carries its own time, the mark, and the certified cutoff under it; its fills are already in the figures", () => {
    const p = positions("provisional")
    expect(api("provisional").read).toEqual({ kind: "provisional", certifiedCutoff: "10:02", provisionalRead: { on: "10:02", state: "10:22", used: true } })
    expect(p).toMatchObject({ perpsAsOfMs: at(10, 22), perpsProvisional: true, perpsCertifiedAsOfMs: at(10, 2), perpsPartial: false })
    // asOfMs is still the older of the spot and perps times.
    expect(p.asOfMs).toBe(Math.min(p.spotAsOfMs, p.perpsAsOfMs))
    // The 10:15 close (half the position, +$6, a $0.03 fee) is in no certified hour yet and is already counted.
    expect(perpRows("certified")[0].size).toBe("1")
    expect(perpRows("provisional")[0].size).toBe("0.5")
    expect(record("certified")).toMatchObject({ perpsRealizedUsd: 0, perpsFeesUsd: 0.05 })
    expect(record("provisional")).toMatchObject({ perpsRealizedUsd: 6, perpsFeesUsd: 0.08, perpsProvisional: true, perpsAsOfMs: at(10, 22), perpsCertifiedAsOfMs: at(10, 2) })
    // The record's totals carry the same three fields.
    expect(record("provisional").totals).toMatchObject({ perpsProvisional: true, perpsAsOfMs: at(10, 22), perpsCertifiedAsOfMs: at(10, 2) })
    // A provisional vector is its own snapshot id: a client pinning the id sees the change.
    expect(p.perpsSnapshotId).not.toBe(positions("certified").perpsSnapshotId)
  })

  test("the provisional time moves with each board build, about 10 minutes; the certified cutoff under it stays", () => {
    expect(buildAt("provisional-next-build") - buildAt("provisional")).toBe(10 * M)
    const next = positions("provisional-next-build")
    expect(next.perpsAsOfMs - positions("provisional").perpsAsOfMs).toBe(10 * M)
    expect(next).toMatchObject({ perpsProvisional: true, perpsCertifiedAsOfMs: at(10, 2) })
    // Never more than the limit behind the build while the reads keep coming.
    for (const id of ["provisional", "provisional-next-build", "provisional-on-new-hour", "provisional-while-certification-lags"] as const)
      expect(buildAt(id) - positions(id).perpsAsOfMs).toBeLessThanOrEqual(freshness.rules.provisionalMaxAgeMs)
  })

  test("one missed refresh is still provisional; a read past 15 minutes is dropped for the certified figures at their real age", () => {
    const missed = positions("provisional-one-missed-refresh")
    expect(buildAt("provisional-one-missed-refresh") - missed.perpsAsOfMs).toBe(12 * M)
    expect(missed).toMatchObject({ perpsAsOfMs: at(10, 32), perpsProvisional: true })
    const old = positions("provisional-too-old")
    expect(api("provisional-too-old").read).toMatchObject({ kind: "certified", provisionalRead: { state: "10:32", used: false } })
    expect(buildAt("provisional-too-old") - at(10, 32)).toBeGreaterThan(freshness.rules.provisionalMaxAgeMs)
    expect(old.perpsAsOfMs).toBe(at(10, 2))
    expect(old).not.toHaveProperty("perpsProvisional")
    expect(old).not.toHaveProperty("perpsCertifiedAsOfMs")
    // The same answer as before any provisional read, the unconfirmed close gone from it again.
    expect(old.perpsSnapshotId).toBe(positions("certified").perpsSnapshotId)
    expect(perpRows("provisional-too-old")).toEqual(perpRows("certified"))
    expect(record("provisional-too-old")).toMatchObject({ perpsRealizedUsd: 0 })
  })
})

describe("the hourly certified snapshot stays underneath", () => {
  test("a certified hour replaces the provisional figures, and a read still standing on the older cutoff is not used", () => {
    const p = positions("certified-supersedes")
    expect(api("certified-supersedes").read).toEqual({ kind: "certified", certifiedCutoff: "11:02", provisionalRead: { on: "10:02", state: "11:30", used: false } })
    expect(p.perpsAsOfMs).toBe(at(11, 2))
    expect(p).not.toHaveProperty("perpsProvisional")
    expect(p).not.toHaveProperty("perpsCertifiedAsOfMs")
    // The unused read is newer than the certified cutoff, and inside 15 minutes of the build: the cutoff decides.
    expect(buildAt("certified-supersedes") - at(11, 30)).toBeLessThan(freshness.rules.provisionalMaxAgeMs)
    // What the provisional read had counted is now certified, unchanged: the same realized and fees.
    for (const field of ["perpsRealizedUsd", "perpsFeesUsd", "perpsFundingUsd"]) expect(record("certified-supersedes")[field]).toBe(record("provisional-next-build")[field])
    expect(perpRows("certified-supersedes")[0]).toMatchObject({ size: "0.5", markPx: "111" })
    expect(record("certified-supersedes")).not.toHaveProperty("perpsProvisional")
  })

  test("the next provisional read stands on the new certified cutoff", () => {
    expect(positions("provisional-on-new-hour")).toMatchObject({ perpsAsOfMs: at(11, 42), perpsProvisional: true, perpsCertifiedAsOfMs: at(11, 2) })
    expect(positions("provisional-on-new-hour").perpsCertifiedAsOfMs).toBe(positions("certified-supersedes").perpsAsOfMs)
  })

  test("while certification lags, a fresh provisional read keeps the figures served and says how far the certified cutoff is behind", () => {
    const p = positions("provisional-while-certification-lags")
    expect(p).toMatchObject({ perpsAsOfMs: at(14, 8), perpsProvisional: true, perpsCertifiedAsOfMs: at(11, 2), perpsPartial: false, portfolioPartial: false })
    // The certified cutoff alone is past the 3-hour line here: the rule is measured from the newest read of either kind.
    expect(buildAt("provisional-while-certification-lags") - p.perpsCertifiedAsOfMs).toBeGreaterThan(freshness.rules.unavailableMs)
    expect(p).not.toHaveProperty("perpsUnavailable")
    // The same build time and certified cutoff without that read is unavailable.
    expect(buildAt("unavailable")).toBe(buildAt("provisional-while-certification-lags"))
    expect(positions("unavailable").perpsUnavailable).toBe(true)
    // Funding since the cutoff rides in with the read: three hourly payments of $0.02, shown as paid.
    expect(record("provisional-while-certification-lags").perpsFundingUsd).toBe(-0.06)
    expect(perpRows("provisional-while-certification-lags")[0].fundingNetUsd).toBe("-0.06")
  })

  test("a provisional read alone never makes figures: not over a certified cutoff 6 hours under it, and not with no certified hour", () => {
    expect(api("certified-base-too-old").read).toEqual({ kind: "unavailable", reason: "stale_observation", certifiedCutoff: "11:02", provisionalRead: { on: "11:02", state: "17:08", used: false } })
    expect(at(17, 8) - at(11, 2)).toBeGreaterThan(freshness.rules.provisionalBaseMaxMs)
    expect(api("never-certified").read).toEqual({ kind: "unavailable", reason: "no_certified_observation", certifiedCutoff: null, provisionalRead: { on: "10:02", state: "10:22", used: false } })
    for (const id of ["certified-base-too-old", "never-certified"] as const) {
      expect(positions(id)).toMatchObject({ perpsUnavailable: true, perpsAsOfMs: null, portfolioValueUsd: null })
      expect(positions(id)).not.toHaveProperty("perpsProvisional")
    }
  })
})

describe("delayed and unavailable perps, at the new cadence", () => {
  test("past 2 hours with no fresh read the certified figures are served partial, still valued", () => {
    const p = positions("delayed")
    const age = buildAt("delayed") - p.perpsAsOfMs
    expect(age).toBeGreaterThan(freshness.rules.staleMs)
    expect(age).toBeLessThanOrEqual(freshness.rules.unavailableMs)
    expect(p).toMatchObject({ perpsAsOfMs: at(11, 2), perpsPartial: true, portfolioPartial: true })
    expect(p).not.toHaveProperty("perpsUnavailable")
    expect(p).not.toHaveProperty("perpsProvisional")
    expect(typeof p.portfolioValueUsd).toBe("number")
    expect(perpRows("delayed")).toHaveLength(1)
    expect(record("delayed")).toMatchObject({ perpsPartial: true, perpsAsOfMs: at(11, 2) })
  })

  test("past 3 hours the perps are unavailable: no rows, no combined value, no perps time, never a flat book", () => {
    const p = positions("unavailable")
    expect(api("unavailable").read).toMatchObject({ kind: "unavailable", reason: "stale_observation", certifiedCutoff: "11:02" })
    expect(buildAt("unavailable") - at(11, 2)).toBeGreaterThan(freshness.rules.unavailableMs)
    expect(p).toMatchObject({ perpsUnavailable: true, perpsPartial: true, perpsAsOfMs: null, perpsSnapshotId: null, portfolioValueUsd: null, portfolioPartial: true })
    expect(perpRows("unavailable")).toEqual([])
    // The spot rows are still listed, and the delayed build's bundle is not kept past the line.
    expect(p.positions.map((r: { kind: string }) => r.kind)).toEqual(["spot"])
    expect(record("unavailable").totals).toMatchObject({ perpsPartial: true, perpsUnavailable: true })
    expect(record("unavailable").totals).not.toHaveProperty("perpsAsOfMs")
    expect(record("unavailable")).not.toHaveProperty("perpsNetUsd")
  })

  test("an agent with no perps answers null perps times and no flag", () => {
    const p = positions("no-perps")
    expect(api("no-perps").read).toEqual({ kind: "none" })
    expect(p).toMatchObject({ perpsAsOfMs: null, perpsSnapshotId: null, perpsPartial: false, portfolioValueUsd: 500, portfolioPartial: false })
    for (const field of ["perpsProvisional", "perpsCertifiedAsOfMs", "perpsUnavailable"]) expect(p).not.toHaveProperty(field)
    expect(record("no-perps")).not.toHaveProperty("perpsAsOfMs")
  })
})

describe("the agent surfaces", () => {
  test("the MCP tool, the SDK and `candle agent positions --json` each give the route's answer whole, in one keyless read", () => {
    for (const id of BUILDS) {
      const answer = positions(id)
      const mcp = row(`${id}-mcp`), sdk = row(`${id}-sdk`), json = row(`${id}-cli-json`)
      expect(mcp.outcome).toEqual({ body: answer, isError: false })
      const { success: _success, ...withoutSuccess } = answer
      expect(sdk.outcome).toEqual({ body: withoutSuccess, isError: false })
      expect(json.outcome).toEqual({ exitCode: 0, body: answer })
      // The MCP tool and the CLI send no credential though one is configured; the SDK client attaches its own key as it does everywhere.
      expect(mcp.requests).toEqual([{ method: "GET", path: PATH, credential: false }])
      expect(json.requests).toEqual([{ method: "GET", path: PATH, credential: false }])
      expect(sdk.requests!.map((q) => [q.method, q.path])).toEqual([["GET", PATH]])
    }
  })

  test("the Candle Harness passes the read through: a read by class, the answer whole, and the CLI command pointed at the tool", () => {
    expect(classify("candle_get_agent_positions", { profileId: freshness.profile }, "live").class).toBe("read")
    for (const id of BUILDS) {
      const { outcome } = row(`${id}-mcp`)
      // Unavailable perps are an answer, not an error: the agent reads the flag.
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: outcome.isError })).toEqual({ kind: "ok", result: positions(id) })
    }
    expect(rowFor("agent positions")!.mcpTool).toBe("candle_get_agent_positions")
    const routed = resolveCall({ command: "agent", subcommand: "positions", args: [freshness.profile] }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
    expect(JSON.stringify(routed)).toContain("candle_get_agent_positions")
  })

  test("`candle agent positions` says certified or provisional under its Updated line, and nothing without a perps time", () => {
    const lines = (id: Build) => row(`${id}-cli`).outcome.lines as string[]
    const stamp = (id: Build) => lines(id).filter((l) => l.startsWith("Perps as of"))
    const expected: Record<Build, string[]> = {
      certified: ["Perps as of Jan 12 10:02Z (certified hourly)"],
      provisional: ["Perps as of Jan 12 10:22Z (provisional; certified to Jan 12 10:02Z, corrected hourly)"],
      "provisional-next-build": ["Perps as of Jan 12 10:32Z (provisional; certified to Jan 12 10:02Z, corrected hourly)"],
      "provisional-one-missed-refresh": ["Perps as of Jan 12 10:32Z (provisional; certified to Jan 12 10:02Z, corrected hourly)"],
      "provisional-too-old": ["Perps as of Jan 12 10:02Z (certified hourly)"],
      "certified-supersedes": ["Perps as of Jan 12 11:02Z (certified hourly)"],
      "provisional-on-new-hour": ["Perps as of Jan 12 11:42Z (provisional; certified to Jan 12 11:02Z, corrected hourly)"],
      delayed: ["Perps as of Jan 12 11:02Z (certified hourly)"],
      unavailable: [],
      "provisional-while-certification-lags": ["Perps as of Jan 12 14:08Z (provisional; certified to Jan 12 11:02Z, corrected hourly)"],
      "certified-base-too-old": [],
      "never-certified": [],
      "no-perps": [],
    }
    for (const id of BUILDS) {
      expect(row(`${id}-cli`).outcome.exitCode).toBe(0)
      expect(stamp(id)).toEqual(expected[id])
      // The line sits straight under "Updated", before the table.
      if (expected[id].length) expect(lines(id)[2]).toBe(expected[id][0]!)
      else expect(lines(id)[2]).toBe("")
      // The human view reads the open orders beside a perp, keyless as well; nothing else.
      expect(row(`${id}-cli`).requests).toEqual([PATH, ...(perpRows(id).length ? [PATH.replace(/positions$/, "open-orders")] : [])].map((path) => ({ method: "GET", path, credential: false })))
    }
    expect(lines("delayed").slice(0, 2)).toEqual(["Portfolio $516.60 (partial)", "Updated Jan 12 11:02Z; perps partial"])
    for (const id of ["unavailable", "certified-base-too-old", "never-certified"] as const) {
      expect(lines(id)[0]).toBe("Portfolio unavailable (perps not reconciled yet)")
      expect(lines(id)[1]).toEndWith("; perps partial")
      expect(lines(id).join("\n")).not.toContain("perp 5x")
    }
    expect(lines("no-perps").slice(0, 2)).toEqual(["Portfolio $500.00", "Updated Jan 12 10:22Z"])
  })
})

describe("what Candle's tool and docs say", () => {
  const tool = tools.tools.find((t) => t.name === "candle_get_agent_positions")!.description
  const page = row("docs-agent-trading").outcome.text as string
  const changelog = row("docs-sdk-changelog").outcome.text as string

  test("the tool's description names the provisional mark, the certified cutoff under it and both cadences", () => {
    for (const fragment of ["with perpsProvisional true it is a provisional read refreshed every board build (about 10 minutes)", "perpsCertifiedAsOfMs is the hourly certified cutoff under it, which corrects the provisional figures", "without it the figures are certified, about an hour behind"]) expect(tool).toContain(fragment)
    // The older wording gave one cadence only.
    expect(tool).not.toContain("the oldest wallet cutoff, about an hour behind")
  })

  test("the public page gives the 10-minute cadence, the certified backstop and the 15-minute and 3-hour limits, the same in its three copies", () => {
    expect(row("docs-agent-trading").args!.files).toEqual(["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"])
    for (const fragment of [
      "Between certified hours each wallet is read again every board build (about every 10 minutes, the cadence spot marks have)",
      "`perpsProvisional: true`", "`perpsCertifiedAsOfMs` the hourly certified cutoff under it",
      "The hourly certified snapshot stays the backstop: when it certifies an hour it replaces the provisional figures for that hour and corrects any drift",
      "more than 15 minutes old", "Perps older than 3 hours by either kind of read are `perpsUnavailable`",
    ]) expect(page).toContain(fragment)
    for (const text of [tool, page, changelog]) expect(text).not.toMatch(/one to two hours|1 to 2 hours|1-2 hours/i)
    // The limits the page states are the ones the source runs on.
    expect(freshness.rules).toMatchObject({ provisionalMaxAgeMs: 15 * M, unavailableMs: 3 * H })
  })

  test("the SDK's changelog names both new fields, optional and absent on certified figures and from an older API", () => {
    for (const fragment of ["`AgentPositions` and `AgentPublicRecord` gain optional `perpsProvisional` and `perpsCertifiedAsOfMs`", "every board build (about 10 minutes)", "Both are absent on certified figures and from an older API", "unreleased; a later bump ships it"]) expect(changelog).toContain(fragment)
  })
})
