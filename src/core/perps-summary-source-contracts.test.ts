// A published agent's Hyperliquid perps summary for a window (BE-3775), as Candle's CLI, local MCP server and
// SDK give it. The fixture is recorded offline from exact source (scripts/read-perps-summary-source.ts): Candle's
// pure source builds each answer from one made-up wallet's stored facts, and `candle agent <id> --perps`,
// `candle_get_agent_perps_summary` and the SDK's `getAgentPerpsSummary()` read it. The commit is #4073's merge on
// staging (bdf8548b9): CLI 0.13.39, MCP 0.10.42 and SDK 0.6.32, not yet published to npm.
//
// Every figure below is worked out by hand from the stored facts the recorder writes (its comments carry them):
//   R1 BTC long, day 3, 5x by a leverage action: +300 - 4.8 - 4.92 = +290.28 (ALL only)
//   R2 ETH short, day 15, 4x seen by a certified hour, +2.5 funding: +200 - 4 - 3.92 + 2.5 = +194.58 (30D)
//   R3 SOL long, day 36, leverage not recorded: -200 - 1.2 - 1.12 = -202.32 (7D)
//   R4 DOGE long, day 40, 25x, liquidated: -150 - 0.6 - 0.54 = -151.14 (24H)
//   R5 ETH long, day 40, 10x: +80 - 1.04 - 1.07 = +77.89 (24H)
//   open BTC long, day 40 09:00, 0.1 at 62000, fee 2.48, +50 unrealized at 12:02; a builder-dex buy of 2 xyz:GOLD at 2400.
// Volume (px x sz, both legs): R1 24300, R2 19800, R3 5800, R4 2850, R5 5280, open BTC 6200, xyz:GOLD 4800.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import perps from "../../test/fixtures/candle-perps-source.json"
import recorded from "../../test/fixtures/candle-perps-summary-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { canonicalJson } from "../shared/canonical-json"
import { toOutcome } from "./candle-mcp"
import { classify, TOOL_CLASSES } from "./classify"
import { rowFor, SOURCE } from "./cli-table"
import { resolveCall } from "./cli-tool"

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; window?: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, any>; requests?: Request[]; outcome: any }
const rows = recorded.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const D = 86_400_000, H = 3_600_000, M = 60_000
const DAY = Date.parse(`${recorded.firstDay}T00:00:00Z`)
const t = (day: number, h: number, m = 0) => DAY + day * D + h * H + m * M
const CERTIFIED = t(40, 12, 2)
const WINDOWS = ["all", "24h", "7d", "30d"] as const
type Window = (typeof WINDOWS)[number]
/** Every answered scenario, and the window each was read for. */
const ANSWERED: Record<string, Window | undefined> = {
  "summary-all": "all", "summary-24h": "24h", "summary-7d": "7d", "summary-30d": "30d", "summary-default": undefined,
  "unpriced-fill": "24h", "older-bundle": "7d", delayed: "all", unavailable: "30d", "no-perps": "all", "route-fixture": "7d",
}
const REFUSED = { "refused-not-published": { window: "7d", status: 404, code: "RECORD_NOT_FOUND" }, "refused-not-served": { window: "all", status: 503, code: "perps_summary_unavailable" } } as const
const answer = (scenario: string) => row(`${scenario}-api`).outcome.answer as { success: true; window: Window; publishedBuildId: string; summary: any; seq: number }
const summary = (scenario: string) => answer(scenario).summary
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const PATH = `/api/v1/agent/records/${recorded.profile}/perps`
const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }

/** Worked out by hand (above). Fees are the main exchange's, as the record's: the builder-dex fee is not in them. */
const EXPECTED: Record<Window, Record<string, number>> = {
  "24h": {
    realizedUsd: -70, fundingUsd: 0, feesUsd: 1.14 + 2.11 + 2.48, unrealizedUsd: 50, netUsd: -25.73,
    volumeUsd: 2850 + 5280 + 6200 + 4800, builderDexVolumeUsd: 4800, feesToVolumePct: (5.73 / 14330) * 100,
    roundsClosed: 2, wins: 1, losses: 1, winRatePct: 50, largestWinUsd: 77.89, largestLossUsd: -151.14,
    highestLeverage: 25, averageLeverage: (25 + 10) / 2, leverageNotRecordedRounds: 0, liquidations: 1, maxDrawdownUsd: 151.14,
  },
  "7d": {
    realizedUsd: -270, fundingUsd: 0, feesUsd: 8.05, unrealizedUsd: 50, netUsd: -228.05,
    volumeUsd: 24930, builderDexVolumeUsd: 4800, feesToVolumePct: (8.05 / 20130) * 100,
    roundsClosed: 3, wins: 1, losses: 2, winRatePct: 100 / 3, largestWinUsd: 77.89, largestLossUsd: -202.32,
    // R3's leverage is not recorded: left out of both figures and counted.
    highestLeverage: 25, averageLeverage: 17.5, leverageNotRecordedRounds: 1, liquidations: 1, maxDrawdownUsd: 484.86 - 131.4,
  },
  "30d": {
    realizedUsd: -70, fundingUsd: 2.5, feesUsd: 15.97, unrealizedUsd: 50, netUsd: -33.47,
    volumeUsd: 44730, builderDexVolumeUsd: 4800, feesToVolumePct: (15.97 / 39930) * 100,
    roundsClosed: 4, wins: 2, losses: 2, winRatePct: 50, largestWinUsd: 194.58, largestLossUsd: -202.32,
    // R2's 4x comes from the certified hour that saw it open.
    highestLeverage: 25, averageLeverage: (25 + 10 + 4) / 3, leverageNotRecordedRounds: 1, liquidations: 1, maxDrawdownUsd: 353.46,
  },
  all: {
    realizedUsd: 230, fundingUsd: 2.5, feesUsd: 25.69, unrealizedUsd: 50, netUsd: 256.81,
    volumeUsd: 69030, builderDexVolumeUsd: 4800, feesToVolumePct: (25.69 / 64230) * 100,
    roundsClosed: 5, wins: 3, losses: 2, winRatePct: 60, largestWinUsd: 290.28, largestLossUsd: -202.32,
    // The prior build's day 8 point, 520, is the all-time peak; the trough is 131.40 after R4.
    highestLeverage: 25, averageLeverage: (25 + 10 + 4 + 5) / 4, leverageNotRecordedRounds: 1, liquidations: 1, maxDrawdownUsd: 520 - 131.4,
  },
}

test("the recording names the exact source commit and agrees with the other source fixtures", () => {
  expect(recorded.source).toEqual({ repo: "candledottv/candle-monorepo", commit: "bdf8548b9d6c3844b014f25ae1725cbae6f8b544", versions: { cli: "0.13.39", mcp: "0.10.42", sdk: "0.6.32" } })
  expect(recorded.source.commit).toBe(SOURCE.source.commit)
  expect(recorded.source.commit).toBe(tools.source.commit)
  expect(recorded.source.commit).toBe(perps.source.commit)
  // Read from the source's constants: partial past 2 hours, unavailable past 3, and the three windows' lengths.
  expect(recorded.rules).toEqual({ staleMs: 2 * H, unavailableMs: 3 * H, windowsMs: { "24h": D, "7d": 7 * D, "30d": 30 * D } })
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  const four = ["api-source", "cli", "cli", "mcp", "sdk"]
  for (const id of Object.keys(ANSWERED)) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(id === "no-perps" ? ["api-stub", "cli", "cli", "mcp", "sdk"] : four)
  for (const id of Object.keys(REFUSED)) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(["api-stub", "cli", "cli", "mcp", "sdk"])
  // 11 answered scenarios and 2 refusals of 5 rows, the slug read (3), the route's window refusal, 5 usage rows, 4 chart rows, 2 tool lists, the docs.
  expect(rows).toHaveLength(13 * 5 + 3 + 1 + 5 + 4 + 2 + 1)
})

test("nothing in the recording is a wallet address, a key or an account figure", () => {
  const text = JSON.stringify(recorded)
  expect(text).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/)
  expect(text).not.toMatch(/"(address|walletAddress|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid)"/i)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key/)
  expect(recorded.profile).toBe("prof_0123456789abcdef")
  for (const id of ["summary-all", "unpriced-fill", "delayed", "unavailable"]) expect(row(`${id}-api`).evidence).toContain("not executed")
})

describe("the summary per window, every figure by hand", () => {
  for (const window of WINDOWS)
    test(`${window}: net and its parts, volume and fees to volume, rounds, win rate, largest win and loss, leverage, liquidations, drawdown`, () => {
      const s = summary(`summary-${window}`)
      expect(s).toMatchObject({ available: true, window, partial: false, asOfMs: CERTIFIED, coverageFromMs: t(0, 0), volumeUnpricedFills: 0 })
      expect(s.perpsSnapshotId).toMatch(/^ps1_[0-9a-f]{32}$/)
      for (const [key, value] of Object.entries(EXPECTED[window])) expect([key, s[key]]).toEqual([key, expect.closeTo(value, 6)])
      expect(answer(`summary-${window}`)).toMatchObject({ success: true, window })
    })

  test("the formulas as the docs give them hold on every answer with figures", () => {
    const withFigures = [...WINDOWS.map((w) => `summary-${w}`), "unpriced-fill", "delayed", "route-fixture"]
    for (const id of withFigures) {
      const s = summary(id)
      expect(s.netUsd).toBeCloseTo(s.realizedUsd + s.fundingUsd - s.feesUsd + s.unrealizedUsd, 6)
      expect(s.feesToVolumePct).toBeCloseTo((s.feesUsd / (s.volumeUsd - s.builderDexVolumeUsd)) * 100, 9)
      expect(s.winRatePct).toBeCloseTo((s.wins / (s.wins + s.losses)) * 100, 9)
      expect(s.roundsClosed).toBeGreaterThanOrEqual(s.wins + s.losses)
      expect(s.largestWinUsd === null || s.largestWinUsd > 0).toBe(true)
      expect(s.largestLossUsd === null || s.largestLossUsd < 0).toBe(true)
      expect(s.highestLeverage).toBeGreaterThanOrEqual(s.averageLeverage)
      expect(s.maxDrawdownUsd).toBeGreaterThanOrEqual(0)
    }
    // A longer window holds the shorter one's rounds, volume and fees.
    for (const [short, long] of [["24h", "7d"], ["7d", "30d"], ["30d", "all"]] as const) {
      expect(summary(`summary-${long}`).roundsClosed).toBeGreaterThan(summary(`summary-${short}`).roundsClosed)
      expect(summary(`summary-${long}`).volumeUsd).toBeGreaterThan(summary(`summary-${short}`).volumeUsd)
      expect(summary(`summary-${long}`).feesUsd).toBeGreaterThan(summary(`summary-${short}`).feesUsd)
    }
  })

  test("max drawdown is peak to trough of the series the source reads: hourly inside 30 days, the daily points before for all", () => {
    const series = (w: Window) => row(`summary-${w}-api`).outcome.drawdownSeries as { points: number; moves: { at: string; pnlUsd: number }[] }
    const fall = (moves: { pnlUsd: number }[]) => {
      let peak = -Infinity, dd = 0
      for (const p of moves) { peak = Math.max(peak, p.pnlUsd); dd = Math.max(dd, peak - p.pnlUsd) }
      return dd
    }
    for (const w of WINDOWS) expect(fall(series(w).moves)).toBeCloseTo(summary(`summary-${w}`).maxDrawdownUsd, 6)
    // Hourly from the window's start hour, plus the build's own point.
    expect(series("24h").points).toBe(24 + 1 + 1)
    expect(series("7d").points).toBe(7 * 24 + 1 + 1)
    expect(series("30d").points).toBe(30 * 24 + 1 + 1)
    // All starts at the first daily point (day 4, the chart's "perps counted from") and takes the days before the first hour.
    expect(series("all").points).toBe(2 + 30 * 24 + 1 + 1)
    expect(series("all").moves.slice(0, 3)).toEqual([{ at: "2027-01-05T00:00Z", pnlUsd: 290.28 }, { at: "2027-01-09T00:00Z", pnlUsd: 520 }, { at: "2027-01-11T12:00Z", pnlUsd: 290.28 }])
    // While R2 was open the certified hour's unrealized (-40) is in the point; the series ends at the all-time net.
    expect(series("30d").moves.map((m) => m.pnlUsd)).toEqual([290.28, 248.78, 484.86, 282.54, 131.4, 209.29, 256.81, 256.81])
    for (const w of WINDOWS) expect(series(w).moves.at(-1)).toEqual({ at: "2027-02-10T12:30Z", pnlUsd: summary("summary-all").netUsd })
  })
})

describe("unknown is never zero", () => {
  test("a fill stored without a price is left out of the volume, counted, and makes the summary partial", () => {
    const s = summary("unpriced-fill")
    expect(s).toMatchObject({ partial: true, volumeUnpricedFills: 1, builderDexVolumeUsd: 0 })
    expect(s.volumeUsd).toBeCloseTo(EXPECTED["24h"].volumeUsd! - 4800, 6)
    // Every other figure is the same as the priced build's.
    for (const key of ["netUsd", "feesUsd", "roundsClosed", "averageLeverage", "maxDrawdownUsd"]) expect(s[key]).toEqual(summary("summary-24h")[key])
    expect(row("unpriced-fill-cli").outcome.lines[0]).toBe("Perps summary, 24h (partial)")
    expect(row("unpriced-fill-cli").outcome.lines.find((l: string) => l.startsWith("Volume"))).toStartWith("Volume            $14,330.00 (1 fills without a price left out)")
  })

  test("a bundle published before the summary's figures answers them null, and the record's own figures stay", () => {
    const s = summary("older-bundle")
    for (const key of ["volumeUsd", "builderDexVolumeUsd", "feesToVolumePct", "highestLeverage", "averageLeverage", "leverageNotRecordedRounds", "liquidations", "maxDrawdownUsd"]) expect([key, s[key]]).toEqual([key, null])
    for (const key of ["netUsd", "realizedUsd", "feesUsd", "roundsClosed", "wins", "losses", "largestLossUsd"]) expect(s[key]).toEqual(summary("summary-7d")[key])
    const lines = row("older-bundle-cli").outcome.lines as string[]
    const value = (label: string) => lines.find((l) => l.startsWith(label))!.slice(18).trim().split(/\s{2,}/)[0]
    for (const label of ["Volume", "Fees to volume", "Liquidations", "Max drawdown"]) expect(value(label)).toBe("unknown")
    // Recorded as the CLI is at this commit: an unknown leverage prints as "not recorded", the words for a round with none.
    expect(value("Highest leverage")).toBe("not recorded")
    expect(value("Average leverage")).toBe("not recorded")
  })

  test("delayed past 2 hours: the same figures, partial; unavailable past 3: no figure, and the time they were last true", () => {
    expect(row("delayed-api").buildAt).toBe("2027-02-10T14:45Z")
    const { partial, ...delayed } = summary("delayed")
    const { partial: fresh, ...certified } = summary("summary-all")
    expect([partial, fresh]).toEqual([true, false])
    expect(delayed).toEqual(certified)
    expect(row("unavailable-api").buildAt).toBe("2027-02-10T15:20Z")
    expect(summary("unavailable")).toEqual({ available: false, window: "30d", asOfMs: CERTIFIED, partial: true })
    expect(row("unavailable-cli").outcome.lines).toEqual(["Perps delayed since Feb 10 12:02Z; no summary now."])
  })

  test("a public agent with no perps history answers summary null, and the CLI says so", () => {
    expect(summary("no-perps")).toBeNull()
    expect(row("no-perps-cli").outcome.lines).toEqual(["No perps history (all time)."])
  })
})

describe("every surface reads the route's answer", () => {
  test("the MCP tool, the SDK and `candle agent <id> --perps --json` each give it whole, in one keyless read", () => {
    for (const [id, window] of Object.entries(ANSWERED)) {
      const body = answer(id)
      const relays = `${id}-api`
      // A read with no window is recorded under its scenario with "-default" after it.
      const at = window === undefined ? `${id}-default` : id
      const mcp = row(`${at}-mcp`), sdk = row(`${at}-sdk`), json = row(`${at}-cli-json`)
      expect(mcp.outcome).toEqual({ relays, sha256: sha256(body), isError: false })
      // The SDK gives the answer without `success`.
      const { success: _success, ...rest } = body
      expect(sdk.outcome).toEqual({ relays, part: "answer without success", sha256: sha256(rest), isError: false })
      expect(json.outcome).toEqual({ exitCode: 0, relays, sha256: sha256(body) })
      // No credential on any of them, though each had a key configured. The tool and the SDK send the window only when
      // one is given; the CLI always names it, all by default.
      const path = window === undefined ? PATH : `${PATH}?window=${window}`
      for (const r of [mcp, sdk]) expect(r.requests).toEqual([{ method: "GET", path, credential: false }])
      for (const r of [json, row(`${at}-cli`)]) expect(r.requests).toEqual([{ method: "GET", path: `${PATH}?window=${window ?? "all"}`, credential: false }])
      expect(row(`${at}-cli`).outcome.exitCode).toBe(0)
    }
    // With no window the route answers all: the same figures as asking for all.
    expect(summary("summary-default")).toEqual(summary("summary-all"))
  })

  test("`candle agent <slug> --perps` reads the public slug first, then the summary by profile id", () => {
    expect(row("summary-slug-cli").requests).toEqual([{ method: "GET", path: "/api/v1/agent/slug/summary-fixture", credential: false }, { method: "GET", path: `${PATH}?window=7d`, credential: false }])
    expect(row("summary-slug-cli").outcome.lines).toEqual(row("summary-7d-cli").outcome.lines)
    expect(row("summary-slug-cli-json").outcome).toMatchObject({ exitCode: 0, sha256: sha256(row("summary-slug-api").outcome.answer) })
  })

  test("the CLI prints the window, the time, the coverage start, then each figure with its formula", () => {
    const lines = row("summary-7d-cli").outcome.lines as string[]
    expect(lines.slice(0, 3)).toEqual(["Perps summary, 7d", "As of Feb 10 12:02Z", "Recorded since 2027-01-01"])
    expect(lines.slice(6).map((l) => l.split(/\s{2,}/))).toEqual([
      ["Perps P&L", "-$228.05", "realized + funding - fees + unrealized change"],
      ["Realized", "-$270.00", "closed P&L of the fills in the window"],
      ["Unrealized", "+$50.00", "change over the window"],
      ["Funding", "$0.00", "positive when received"],
      ["Fees", "$8.05", "Hyperliquid fees, Candle's builder fee included"],
      ["Volume", "$24,930.00", "sum of price x size per fill, $4,800.00 on builder dexes"],
      ["Fees to volume", "0.0400%", "fees / main-exchange volume"],
      ["Rounds closed", "3", "open to flat, counted at the close"],
      ["Win rate", "33.3% (1W 2L)", "wins / (wins + losses)"],
      ["Largest win", "+$77.89", "best round above zero"],
      ["Largest loss", "-$202.32", "worst round below zero"],
      ["Highest leverage", "25x", "rounds closed in the window (1 round with leverage not recorded left out)"],
      ["Average leverage", "17.5x", "mean over those rounds (1 round with leverage not recorded left out)"],
      ["Liquidations", "1", "rounds closed by a liquidation"],
      ["Max drawdown", "$353.46", "peak to trough of cumulative perps P&L"],
    ])
    expect(row("summary-all-cli").outcome.lines[0]).toBe("Perps summary, all time")
    expect(row("summary-all-cli").outcome.lines.find((l: string) => l.startsWith("Unrealized"))).toContain("open positions now")
  })

  test("Candle's own shared route answer reads the same on every surface", () => {
    expect(answer("route-fixture")).toMatchObject({ success: true, window: "7d", publishedBuildId: "build_fixture", seq: 42 })
    expect(summary("route-fixture")).toMatchObject({ roundsClosed: 3, leverageNotRecordedRounds: 1, liquidations: 1, builderDexVolumeUsd: 400 })
    expect(row("route-fixture-cli").outcome.lines[0]).toBe("Perps summary, 7d")
    // The answers differ from one scenario to the next, so a hash names one answer only.
    const answered = Object.keys(ANSWERED)
    expect(new Set(answered.map((id) => sha256(answer(id)))).size).toBe(answered.length)
  })
})

describe("refusals and what never leaves the machine", () => {
  test("not published and not served are relayed as they are: the tool as an error, the SDK throws, the CLI exits 1", () => {
    for (const [id, { window, status, code }] of Object.entries(REFUSED)) {
      const { body } = row(`${id}-api`).outcome
      expect(row(`${id}-api`).outcome.status).toBe(status)
      expect(row(`${id}-mcp`).outcome).toEqual({ body, isError: true })
      expect(row(`${id}-sdk`).outcome).toEqual({ isError: true, error: { status, code, message: body.error.message } })
      expect(row(`${id}-cli`).outcome).toMatchObject({ exitCode: 1, stderr: [body.error.message] })
      for (const surface of ["mcp", "sdk", "cli", "cli-json"]) expect(row(`${id}-${surface}`).requests).toEqual([{ method: "GET", path: `${PATH}?window=${window}`, credential: false }])
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(body) }], isError: true })).toMatchObject({ kind: "error", code })
    }
    expect(row("refused-not-served-api").outcome.body.error.retryable).toBe(false)
    expect(row("refused-window-api").outcome).toEqual({ status: 400, source: 'invalid(c, "window", "window must be 24h, 7d, 30d or all")' })
  })

  test("a window the command or tool doesn't take, no --perps, a word that is no id, and an unknown slug read no summary", () => {
    const usage = "Usage: candle agent <profile-id|slug> --perps [--window all|24h|7d|30d] [--json]"
    expect(row("usage-cli-window-unknown")).toMatchObject({ requests: [], outcome: { exitCode: 2, stdout: [], stderr: ["--window must be all, 24h, 7d or 30d", usage] } })
    expect(row("usage-cli-no-perps-flag")).toMatchObject({ requests: [], outcome: { exitCode: 2, stderr: [usage] } })
    expect(row("usage-cli-not-an-id")).toMatchObject({ requests: [], outcome: { exitCode: 2, stderr: [usage] } })
    expect(row("usage-mcp-window-unknown")).toMatchObject({ args: { window: "90d" }, requests: [], outcome: { isError: true } })
    expect(row("refused-cli-slug-unknown")).toMatchObject({ requests: [{ method: "GET", path: "/api/v1/agent/slug/nobody-here", credential: false }], outcome: { exitCode: 1, stderr: ["No published agent has the slug nobody-here."] } })
  })
})

describe("the chart's All / Spot / Perps split", () => {
  test("every point splits into spot and perps, which add up to the combined line; a spot-only chart is untouched", () => {
    for (const range of ["24h", "all"]) {
      const { spotChart, composed } = row(`chart-split-${range}`).outcome
      expect(composed.points).toHaveLength(spotChart.points.length)
      for (const [i, p] of composed.points.entries()) {
        expect(p.spotPnlUsd + p.perpsPnlUsd).toBeCloseTo(p.totalPnlUsd, 9)
        // Spot is the point as it was before perps joined it, but at the build, whose stand-in already held the perps net.
        if (i < composed.points.length - 1) expect(p.spotPnlUsd).toBe(spotChart.points[i].totalPnlUsd)
      }
      expect(composed.points.at(-1).perpsPnlUsd).toBeCloseTo(summary("summary-all").netUsd, 9)
      expect(composed).toMatchObject({ perpsAsOfMs: CERTIFIED, perpsPartial: false })
    }
    // A day before perps were published is all spot; the published days carry their perps points.
    const days = row("chart-split-all").outcome.composed
    expect(days.points.map((p: any) => p.perpsPnlUsd)).toEqual([0, 290.28, 520, summary("summary-all").netUsd])
    expect(days.perpsCountedFromMs).toBe(t(4, 0))
    // The 24h chart's perps part per hour is the drawdown series' point at that hour.
    expect(row("chart-split-24h").outcome.composed.points.map((p: any) => Math.round(p.perpsPnlUsd * 100) / 100)).toEqual([282.54, 131.4, 209.29, 256.81, 256.81])
    expect(row("chart-split-spot-only").outcome.composed).toBe("the same object, untouched")
  })

  test("no agent surface reads the chart at this commit: the split is the web's", () => {
    expect(row("chart-agent-surfaces").outcome).toEqual({ chartReaders: [] })
  })
})

describe("the Candle Harness and the tool", () => {
  test("the local tool is listed with its window enum; the hosted server's public list doesn't have it", () => {
    const tool = row("local-tool").outcome
    expect(tool).toMatchObject({ name: "candle_get_agent_perps_summary", title: "Get an agent's perps summary" })
    expect(tool.inputSchema).toMatchObject({ required: ["profileId"], properties: { window: { enum: ["all", "24h", "7d", "30d"] } } })
    expect(tool.description).toContain("No key needed. Reads only.")
    expect(tool.description).toContain("null means not known, never zero")
    // The same tool, as tools/list recorded it.
    expect(tools.tools.find((x) => x.name === "candle_get_agent_perps_summary")).toMatchObject({ description: tool.description, inputSchema: tool.inputSchema })
    expect(row("hosted-tools-list").outcome.tools).not.toContain("candle_get_agent_perps_summary")
    expect(row("hosted-tools-list").outcome.tools).toContain("candle_get_agent_record")
  })

  test("the read is a read by class, its answer passed through whole, and `candle agent <id> --perps` pointed at it", () => {
    expect(TOOL_CLASSES.candle_get_agent_perps_summary).toEqual({ class: "read" })
    for (const mode of ["live", "paper"] as const) expect(classify("candle_get_agent_perps_summary", { profileId: recorded.profile, window: "7d" }, mode)).toEqual({ class: "read" })
    for (const id of Object.keys(ANSWERED)) {
      // Unavailable perps and no perps history are answers, not errors.
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(answer(id)) }], isError: false })).toEqual({ kind: "ok", result: answer(id) })
    }
    expect(rowFor("agent")).toMatchObject({ rule: "mcp", route: "cli", identity: "agent", mcpTool: "candle_get_agent_perps_summary" })
    for (const args of [[recorded.profile, "--perps"], [recorded.profile, "--perps", "--window", "30d"], ["summary-fixture", "--perps"]]) {
      const routed = resolveCall({ command: "agent", args }, ctx)
      expect(routed.ok && routed.call.rule).toBe("mcp")
      expect(JSON.stringify(routed)).toContain("candle_get_agent_perps_summary")
    }
    expect(resolveCall({ command: "agent", args: [recorded.profile, "--perps", "--from", "x"] }, ctx)).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    // The bare word's handler, as its source declares it.
    const entry = SOURCE.commands.find((c) => c.command === "agent" && c.subcommand === null)!
    expect(entry).toMatchObject({ handler: "agentPerps", file: "commands/agent-perps.ts", identity: "none", json: true, unlocks: "never", flags: { value: ["--window"], boolean: ["--perps"], path: [] } })
  })

  test("the public page gives each formula, as the answers above hold them", () => {
    const lines = row("docs-summary-section").outcome.lines as string[]
    const formula = (field: string) => lines.find((l) => l.startsWith(`| \`${field}\``))
    expect(formula("netUsd")).toContain("`realizedUsd + fundingUsd - feesUsd + unrealizedUsd`")
    expect(formula("volumeUsd")).toContain("`px x sz`")
    expect(formula("feesToVolumePct")).toContain("`feesUsd / (volumeUsd - builderDexVolumeUsd) x 100`")
    expect(formula("winRatePct")).toContain("`wins / (wins + losses) x 100`")
    expect(formula("highestLeverage")).toContain("left out of both figures and counted in `leverageNotRecordedRounds`")
    expect(formula("maxDrawdownUsd")).toContain("peak to trough")
    expect(lines.at(-1)).toBe("Clients: SDK `getAgentPerpsSummary(profileId, { window })`; CLI `candle agent <profile-id|slug> --perps [--window all|24h|7d|30d] [--json]`; MCP `candle_get_agent_perps_summary` (keyless, local server).")
  })
})
