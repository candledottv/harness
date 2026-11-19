// A published agent's measured record with its Hyperliquid perps in it (BE-3754), as Candle's source says it:
// closed perp rounds sit among the spot swaps, newest first, each with its largest size, entry and exit averages,
// recorded leverage, return on initial margin, funding, fees and duration; the perps figures split the P&L; and a
// time says how fresh they are, also when they are too old to serve. Recorded offline from one exact commit
// (scripts/read-record-source.ts): Candle's pure source builds each answer from made-up stored facts, and
// `candle agent record`, `candle_get_agent_record` on the local and the hosted server, and the SDK read it.
// The commit is the head of an open pull request, not a merged build: its CLI 0.13.32, MCP 0.10.37 and SDK 0.6.26
// are not published with this in them, and the fixtures are re-read once it merges.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import perps from "../../test/fixtures/candle-perps-source.json"
import recorded from "../../test/fixtures/candle-record-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { canonicalJson } from "../shared/canonical-json"
import { toOutcome } from "./candle-mcp"
import { classify, TOOL_CLASSES } from "./classify"
import { rowFor, SOURCE } from "./cli-table"
import { resolveCall } from "./cli-tool"

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, any>; requests?: Request[]; outcome: any }
const rows = recorded.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const D = 86_400_000, H = 3_600_000, M = 60_000
const DAY = Date.parse(`${recorded.firstDay}T00:00:00Z`)
/** A day (0, 1 or 2), an hour and a minute of the three made-up days. */
const at = (day: number, h: number, m = 0) => DAY + day * D + h * H + m * M
/** The builds Candle's pure source made, in the order recorded. */
const BUILDS = ["record", "record-paged", "perps-only", "older-facts", "delayed", "unavailable", "never-certified", "no-perps"] as const
type Build = (typeof BUILDS)[number]
/** Every answered read: the builds, Candle's own shared route answer, and an older bundle's rows. */
const ANSWERED = [...BUILDS, "route-fixture", "older-bundle"] as const
const REFUSED = ["refused-not-published", "refused-cursor-expired"] as const
const api = (id: Build) => row(`${id}-api`).outcome as { read: any; record: { success: true; seq: number; record: any }; nextPage?: { record: any }; topCloses?: any; breakdown: any; breakdownMissing?: any }
const record = (id: Build) => api(id).record.record
/** The answer a scenario's surfaces read: the route's whole body. */
const answer = (scenario: string) => (row(`${scenario}-api`).outcome.record ?? row(`${scenario}-api`).outcome.body) as { record: any }
const rounds = (id: Build) => (record(id).rows as any[]).filter((r) => r.kind === "perp_round")
const round = (id: Build, coin: string) => {
  const found = rounds(id).find((r) => r.coin === coin)
  if (!found) throw new Error(`no ${coin} round in ${id}`)
  return found
}
/** A served answer is kept once, in its api row; each surface's row names it with the hash of what that surface gave. */
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const PATH = `/api/v1/agent/records/${recorded.profile}?rows=all`
const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }
const CERTIFIED = at(2, 9, 2)

test("the recording names the exact source commit, agrees with the other source fixtures, and carries Candle's own limits", () => {
  expect(recorded.source).toEqual({ repo: "candledottv/candle-monorepo", commit: "36d4bf2642244e82deaa690d8d1277d60d8b9021", versions: { cli: "0.13.32", mcp: "0.10.37", sdk: "0.6.26" } })
  expect(recorded.source.commit).toBe(SOURCE.source.commit)
  expect(recorded.source.commit).toBe(tools.source.commit)
  expect(recorded.source.commit).toBe(perps.source.commit)
  // Read from the source's constants, not written here: partial past 2 hours, unavailable past 3, 500 rows a page,
  // the newest 200 rounds and the best 5 closes published, and `rows=all` as the word that asks for the one list.
  expect(recorded.rules).toEqual({ staleMs: 2 * H, unavailableMs: 3 * H, pageRows: 500, roundRowsMax: 200, topCloses: 5, unionRows: "all" })
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  const five = ["cli", "cli", "mcp", "mcp-hosted", "sdk"]
  for (const id of BUILDS) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(id === "record-paged" ? ["api-source", ...five, ...five].sort() : ["api-source", ...five])
  expect(rows.filter((r) => r.scenario === "route-fixture").map((r) => r.surface).sort()).toEqual(["api-source", ...five])
  for (const id of ["older-bundle", ...REFUSED]) expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(["api-stub", ...five])
  // 8 builds, a second page, the shared route answer, an older bundle, two refusals; one round row, two usage rows, the hosted list, three docs rows.
  expect(rows).toHaveLength(8 * 6 + 5 + 6 + 6 + 2 * 6 + 1 + 2 + 1 + 3)
})

test("nothing in the recording is a wallet address, a key or an account figure", () => {
  const text = JSON.stringify(recorded)
  // A closing fill's hash is 64 hex digits and public on the exchange; an address is 40, and there is none.
  expect(text).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/)
  expect(text).not.toMatch(/"(address|walletAddress|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid)"/i)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key/)
  expect(recorded.profile).toBe("prof_0123456789abcdef")
  // The record's own `wallet` field is a role here, never an address, and no round row carries one.
  for (const id of BUILDS) {
    expect(record(id).wallet).toBe("fixture-public-owner")
    for (const r of rounds(id)) expect(Object.keys(r)).not.toContain("wallet")
    // The answers are made by the pure source, and each row says the database, jobs and keyed route did not run.
    expect(row(`${id}-api`).evidence).toContain("the keyed route are not executed")
  }
  for (const id of ["older-bundle", ...REFUSED]) expect(row(`${id}-api`).evidence).toStartWith("a response stand-in")
})

describe("perp rounds among the swaps", () => {
  test("closed rounds and spot swaps are one list, newest first, each marked with its kind", () => {
    const list = record("record").rows as any[]
    expect(list.map((r) => `${r.kind} ${r.coin ?? r.symbol}`)).toEqual([
      "trade MOON", "perp_round DOGE", "trade FAKE", "perp_round SOL", "trade MOON", "perp_round BTC", "trade MOON", "perp_round ETH", "trade FAKE", "trade FAKE",
    ])
    const time = (r: any) => (r.kind === "perp_round" ? r.closedMs : r.timestampMs)
    for (let i = 1; i < list.length; i++) expect(time(list[i - 1])).toBeGreaterThanOrEqual(time(list[i]))
    // A swap and a round at the same time: the swap comes first.
    expect(time(list[4])).toBe(time(list[5]))
    expect(time(list[4])).toBe(at(0, 16, 40))
    // A round is placed by when it closed, and opened before that.
    for (const r of rounds("record")) expect(r.openedMs).toBeLessThan(r.closedMs)
    expect(record("record")).toMatchObject({ rowsTotal: 10, rowsCursor: null })
    // The same rounds are still beside the record under their older name, for a client that reads them there.
    expect(record("record").perpRounds).toEqual(rounds("record"))
  })

  test("an agent with no swap lists its rounds alone; one with no perps lists its swaps alone, each marked a trade", () => {
    expect((record("perps-only").rows as any[]).map((r) => r.kind)).toEqual(["perp_round", "perp_round", "perp_round", "perp_round"])
    expect(record("perps-only").rowsTotal).toBe(4)
    expect(rounds("perps-only")).toEqual(rounds("record"))
    expect((record("no-perps").rows as any[]).map((r) => r.kind)).toEqual(["trade", "trade", "trade", "trade", "trade", "trade"])
    expect(record("no-perps")).not.toHaveProperty("perpRounds")
  })

  test("a page ends where its stored chunk of swaps ends, and its cursor reads the rest: the two pages are the one list", () => {
    const first = record("record-paged"), second = api("record-paged").nextPage!.record
    expect(first.rows).toHaveLength(5)
    expect(first.rowsCursor).toMatch(/^u1:[a-f0-9]{64}:3:[a-f0-9]{32}:2$/)
    expect(second.rowsCursor).toBeNull()
    expect([...first.rows, ...second.rows]).toEqual(record("record").rows)
    // Both pages count the whole list, and the figures beside the rows are the same on each.
    expect([first.rowsTotal, second.rowsTotal]).toEqual([10, 10])
    for (const field of ["perpsNetUsd", "perpsAsOfMs", "perpsSnapshotId", "totalPnlUsd"]) expect(second[field]).toBe(first[field])
    // Three swaps and two rounds were still to come, as the cursor says.
    expect((second.rows as any[]).filter((r) => r.kind === "trade")).toHaveLength(3)
    expect((second.rows as any[]).filter((r) => r.kind === "perp_round")).toHaveLength(2)
    // The second page is asked for with the cursor, still as the one list.
    const paged = `${PATH}&cursor=${encodeURIComponent(first.rowsCursor)}`
    for (const surface of ["mcp", "mcp-hosted", "sdk", "cli", "cli-json"]) expect(row(`record-paged-page-2-${surface}`).requests).toEqual([{ method: "GET", path: paged, credential: false }])
    expect(row("record-paged-cli").outcome.lines.at(-1)).toBe(`Next page: --cursor ${first.rowsCursor}`)
    expect(row("record-paged-page-2-cli").outcome.lines.join("\n")).not.toContain("Next page")
    expect(row("record-paged-page-2-cli").args!.command).toBe(`candle agent record ${recorded.profile} --cursor ${first.rowsCursor}`)
  })

  test("a builder-dex round keeps its dex:COIN name in a row, and the record built at this commit does not count one", () => {
    // The made-up wallet also closed a round on a builder dex; the record's rounds and figures are the default dex's only.
    expect(rounds("record").map((r) => r.coin).sort()).toEqual(["BTC", "DOGE", "ETH", "SOL"])
    expect(JSON.stringify(api("record").record)).not.toContain("xyz:")
    expect(row("builder-dex-round-row").evidence).toContain("does not count builder-dex rounds at this commit")
    // The round row itself carries the whole name, with the same arithmetic.
    const built = row("builder-dex-round-row").outcome.row
    expect(built).toMatchObject({ kind: "perp_round", coin: "xyz:S&P500", side: "long", leverage: { value: 20, type: "isolated" }, leverageSource: "order", size: "6", entryPx: 7687.5, exitPx: 7969.95, initialMarginUsd: 2306.25, fundingUsd: 2, feesUsd: 7, pnlUsd: 1689.7, durationMs: H })
    expect(built.returnPct).toBeCloseTo((1689.7 / 2306.25) * 100, 10)
    // Candle's own shared route answer has such a round, and every surface relays it.
    const shared = answer("route-fixture").record.rows[0]
    expect(shared).toMatchObject({ kind: "perp_round", coin: "xyz:S&P500", size: "6", initialMarginUsd: 2306.25, leverage: { value: 20, type: "isolated" } })
    expect(shared.returnPct.toFixed(1)).toBe("73.5")
    expect(row("route-fixture-cli").outcome.lines[2]).toStartWith("Long xyz:S&P500 20x · size 6 · entry 7687.5 · exit 7969.95 · +$1,694.70 · 73.5% ROE · funding 2 · fees 7 · duration 3600s · https://app.hyperliquid.xyz/explorer/tx/0x")
  })
})

describe("the round row", () => {
  test("largest size, entry and exit averages, initial margin and the return on it, funding, fees and duration", () => {
    // Bought 2 at 3000 and 1 more at 3060, all 3 sold at 3150: the entry average is at the largest size.
    const eth = round("record", "ETH")
    expect(eth).toMatchObject({ side: "long", size: "3", entryPx: 3020, exitPx: 3150, leverage: { value: 10, type: "isolated" }, leverageSource: "order", initialMarginUsd: 906, fundingUsd: -1.2, feesUsd: 5.55, pnlUsd: 383.25, liquidated: false, openedMs: at(0, 9), closedMs: at(0, 11), durationMs: 2 * H })
    expect(eth.entryPx).toBe((2 * 3000 + 1 * 3060) / 3)
    // Net of fees and funding: 390 closed, 5.55 in fees, 1.20 of funding paid.
    expect(eth.pnlUsd).toBeCloseTo(390 - 5.55 - 1.2, 10)
    for (const r of rounds("record").filter((r) => r.leverage)) {
      // Initial margin is entry average x largest size / leverage; the return is net P&L over it, in percent.
      expect(r.initialMarginUsd).toBeCloseTo((r.entryPx * Number(r.size)) / r.leverage.value, 10)
      expect(r.returnPct).toBeCloseTo((r.pnlUsd / r.initialMarginUsd) * 100, 10)
      expect(r.durationMs).toBe(r.closedMs - r.openedMs)
    }
    // Funding is positive when earned: the short was paid 0.80, the long paid 1.20.
    expect(round("record", "BTC")).toMatchObject({ side: "short", fundingUsd: 0.8, pnlUsd: -104.93, entryPx: 95000, exitPx: 96000, size: "0.1" })
    // Each closed round names its closing fill, and none names a wallet or an account value.
    for (const r of rounds("record")) {
      expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(r.id).toMatch(/^rnd_[0-9a-f]{16}$/)
      expect(Object.keys(r).sort()).toEqual(["closedMs", "coin", "durationMs", "entryPx", "exitPx", "feesUsd", "fundingUsd", "hash", "id", "initialMarginUsd", "kind", "leverage", "leverageSource", "liquidated", "openedMs", "pnlUsd", "returnPct", "side", "size"])
    }
  })

  test("leverage is the last Candle leverage action before the open, else the highest a certified hour saw, and says which", () => {
    expect(round("record", "ETH")).toMatchObject({ leverage: { value: 10, type: "isolated" }, leverageSource: "order" })
    expect(round("record", "DOGE")).toMatchObject({ leverage: { value: 20, type: "cross" }, leverageSource: "order" })
    // No leverage action for BTC: the 15:02 certified hour saw the short at 5x cross.
    expect(round("record", "BTC")).toMatchObject({ leverage: { value: 5, type: "cross" }, leverageSource: "snapshot", initialMarginUsd: 1900 })
    // Facts stored before leverage actions were kept: every leverage that is known came from a certified hour.
    expect(rounds("older-facts").map((r) => [r.coin, r.leverageSource])).toEqual([["DOGE", "snapshot"], ["SOL", null], ["BTC", "snapshot"], ["ETH", "snapshot"]])
  })

  test("a round whose leverage nothing recorded says so: no leverage, no margin and no return, and its P&L still counts", () => {
    // Opened and closed inside one hour, between two certified hours, with no leverage action.
    const sol = round("record", "SOL")
    expect(sol).toMatchObject({ leverage: null, leverageSource: null, initialMarginUsd: null, returnPct: null, size: "50", entryPx: 180, exitPx: 183, pnlUsd: 144.6, feesUsd: 5.4, durationMs: 30 * M })
    expect(row("record-cli").outcome.lines[5]).toBe(`Long SOL leverage not recorded · size 50 · entry 180 · exit 183 · +$144.60 · ROE unknown · funding 0 · fees 5.4 · duration 1800s · https://app.hyperliquid.xyz/explorer/tx/${sol.hash}`)
    // It is one of the record's wins all the same.
    expect(record("record").totals).toMatchObject({ wins: 3, losses: 3, counted: 6 })
    expect(record("perps-only").totals).toMatchObject({ wins: 2, losses: 2, counted: 4, bestUsd: 383.25, worstUsd: -192.34 })
  })

  test("a liquidated round is marked, with the loss the exchange closed it at", () => {
    const doge = round("record", "DOGE")
    expect(doge).toMatchObject({ liquidated: true, size: "10000", entryPx: 0.4, exitPx: 0.381, initialMarginUsd: 200, pnlUsd: -192.34 })
    expect(doge.returnPct).toBeCloseTo(-96.17, 10)
    expect(rounds("record").filter((r) => r.liquidated).map((r) => r.coin)).toEqual(["DOGE"])
    expect(row("record-cli").outcome.lines[3]).toContain(" · -$192.34 · -96.2% ROE · funding 0 · fees 2.34 · duration 5100s · LIQUIDATED · https://")
  })

  test("what was never stored is unknown, never zero: facts without fill prices, and rows published before the added fields", () => {
    // Stored facts with no fill price: sizes and averages are null, and so no margin or return is made from them.
    for (const r of rounds("older-facts")) {
      expect(r).toMatchObject({ size: null, entryPx: null, exitPx: null, initialMarginUsd: null, returnPct: null })
      // The certified money is untouched.
      expect(r.pnlUsd).toBe(round("record", r.coin).pnlUsd)
      expect(r.feesUsd).toBe(round("record", r.coin).feesUsd)
    }
    for (const field of ["perpsRealizedUsd", "perpsFundingUsd", "perpsFeesUsd", "perpsUnrealizedUsd", "perpsNetUsd", "totalPnlUsd"]) expect(record("older-facts")[field]).toBe(record("record")[field])
    expect(row("older-facts-cli").outcome.lines[9]).toStartWith("Long ETH 10x · size unknown · entry unknown · exit unknown · +$383.25 · ROE unknown · funding -1.2 · fees 5.55 · duration 7200s")
    // An older published bundle has none of the added fields on a round: each is absent, and the CLI says unknown.
    const older = answer("older-bundle").record
    expect(row("older-bundle-api").outcome.removed).toEqual(["size", "entryPx", "exitPx", "initialMarginUsd", "returnPct", "fundingUsd", "feesUsd", "durationMs", "leverageSource", "perpsCoverageFromMs"])
    for (const r of (older.rows as any[]).filter((r) => r.kind === "perp_round")) expect(Object.keys(r).sort()).toEqual(["closedMs", "coin", "hash", "id", "kind", "leverage", "liquidated", "openedMs", "pnlUsd", "side"])
    expect(older).not.toHaveProperty("perpsCoverageFromMs")
    expect(row("older-bundle-cli").outcome.lines[3]).toStartWith("Long DOGE 20x · size unknown · entry unknown · exit unknown · -$192.34 · ROE unknown · funding unknown · fees unknown · duration unknown · LIQUIDATED · https://")
    expect(row("older-bundle-cli").outcome.lines[5]).toStartWith("Long SOL leverage not recorded · size unknown · entry unknown · exit unknown · +$144.60 · ROE unknown · funding unknown · fees unknown · duration unknown · https://")
  })
})

describe("the P&L breakdown", () => {
  test("the record's perps figures are realized, funding, fees and unrealized, and they add up to the perps net", () => {
    const r = record("record")
    // Four closes: +390, -100, +150 and -190. Funding: 1.20 paid, 0.80 earned. One position open, $30 up.
    expect(r).toMatchObject({ perpsRealizedUsd: 250, perpsFundingUsd: -0.4, perpsFeesUsd: 19.98, perpsUnrealizedUsd: 30, perpsNetUsd: 259.62 })
    expect(r.perpsNetUsd).toBeCloseTo(r.perpsRealizedUsd + r.perpsFundingUsd - r.perpsFeesUsd + r.perpsUnrealizedUsd, 10)
    // The fees are every fill's, the open position's too; the rounds' own fees are the closed ones'.
    expect(rounds("record").reduce((n, x) => n + x.feesUsd, 0)).toBeCloseTo(19.98 - 0.96, 10)
    expect(rounds("record").reduce((n, x) => n + x.pnlUsd, 0)).toBeCloseTo(r.perpsRealizedUsd + r.perpsFundingUsd - (19.98 - 0.96), 10)
    // The totals carry the same figures, and the headline is spot plus perps: 102.50 of spot and creator fees, 259.62 of perps.
    for (const field of ["perpsRealizedUsd", "perpsFundingUsd", "perpsFeesUsd", "perpsUnrealizedUsd", "perpsNetUsd", "perpsAsOfMs", "perpsCoverageFromMs", "perpsPartial"]) expect(r.totals[field]).toBe(r[field])
    expect(record("no-perps").totalPnlUsd).toBe(102.5)
    expect(r.totalPnlUsd).toBeCloseTo(102.5 + 259.62, 10)
    expect(r.unrealizedUsd).toBe(40 + 30)
    expect(r.totals.realizedNetUsd).toBeCloseTo(50 + 229.62, 10)
  })

  test("the web's split of the headline adds up exactly: spot, perps realized, funding, fees, perps unrealized and creator fees", () => {
    const b = api("record").breakdown
    expect(b).toEqual({ total: 362.12, creatorFeesUsd: 12.5, figures: { perpsRealizedUsd: 250, perpsFundingUsd: -0.4, perpsFeesUsd: 19.98, perpsUnrealizedUsd: 30, perpsNetUsd: 259.62 }, parts: { spot: 90, realized: 250, funding: -0.4, fees: -19.98, unrealized: 30, creatorFees: 12.5 } })
    // Fees are shown as a cost. Spot is what is left: the stored record's 50 realized and 40 unrealized.
    const sum = (p: Record<string, number>) => Math.round((p.spot! + p.realized! + p.funding! + p.fees! + p.unrealized! + p.creatorFees!) * 1e6) / 1e6
    expect(sum(b.parts)).toBe(b.total)
    // An agent with perps only has no spot part at all: exactly zero, not a rounding crumb.
    const only = api("perps-only").breakdown
    expect(only.parts).toEqual({ spot: 0, realized: 250, funding: -0.4, fees: -19.98, unrealized: 30, creatorFees: 0 })
    expect(only.total).toBe(259.62)
    expect(sum(only.parts)).toBe(only.total)
  })

  test("a missing part is missing, and then spot is too: nothing is assigned to spot by subtraction", () => {
    const missing = api("record").breakdownMissing
    // Creator fees not valued: no creator fees and no spot, the perps parts as they were.
    expect(missing.creatorFees).toEqual({ realized: 250, funding: -0.4, fees: -19.98, unrealized: 30 })
    // One perps component absent: that one and spot are gone, the rest stay.
    expect(missing.funding).toEqual({ realized: 250, fees: -19.98, unrealized: 30, creatorFees: 12.5 })
    // Perps unavailable or absent: the record has no perps figure, so the split has none and no spot.
    for (const id of ["unavailable", "never-certified", "no-perps"] as const) expect(api(id).breakdown).toEqual({ total: 102.5, creatorFeesUsd: 12.5, figures: {}, parts: { creatorFees: 12.5 } })
    // A known zero stays a zero.
    expect(round("record", "SOL").fundingUsd).toBe(0)
    expect(api("perps-only").breakdown.parts.creatorFees).toBe(0)
  })

  test("the best closes come from the server: the best rounds beside the record, and one list of spot and perps by dollars", () => {
    // Beside the record: the best rounds of all time, by net P&L.
    expect((record("record").perpsTopCloses as any[]).map((r) => [r.coin, r.pnlUsd])).toEqual([["ETH", 383.25], ["SOL", 144.6], ["BTC", -104.93], ["DOGE", -192.34]])
    // The best-closes answer puts the spot closes among them, five at most, with the perps time and snapshot.
    const top = api("record").topCloses
    expect((top.topCloses as any[]).map((r) => [r.coin ?? r.symbol, r.pnlUsd ?? r.realizedNetUsd])).toEqual([["ETH", 383.25], ["SOL", 144.6], ["FAKE", 60], ["MOON", -10], ["BTC", -104.93]])
    expect(top.topCloses).toHaveLength(recorded.rules.topCloses)
    expect(top).toMatchObject({ perpsPartial: false, perpsAsOfMs: CERTIFIED, perpsSnapshotId: record("record").perpsSnapshotId })
    // Every best round is a listed row with its closing fill.
    for (const best of record("record").perpsTopCloses as any[]) {
      expect(rounds("record")).toContainEqual(best)
      expect(best.hash).toMatch(/^0x[0-9a-f]{64}$/)
    }
    // With perps unavailable there is no best-closes answer from them, and none is made up.
    for (const id of ["unavailable", "never-certified", "no-perps"] as const) {
      expect(api(id)).not.toHaveProperty("topCloses")
      expect(record(id)).not.toHaveProperty("perpsTopCloses")
    }
  })
})

describe("how fresh the perps are, and why there are none", () => {
  test("a served record carries the certified time of its perps figures and the start of stored coverage", () => {
    expect(api("record").read).toEqual({ kind: "certified", retained: false })
    expect(record("record")).toMatchObject({ perpsAsOfMs: CERTIFIED, perpsCoverageFromMs: at(0, 0), perpsPartial: false })
    expect(recorded.coverageFrom).toBe("2027-01-10T00:00Z")
    expect(record("record")).not.toHaveProperty("perpsUnavailable")
    expect(row("record-cli").outcome.lines.slice(0, 2)).toEqual(["Record fixture", "Perps as of 2027-01-12T09:02:00.000Z"])
  })

  test("past 2 hours the same figures are served partial", () => {
    expect(row("delayed-api").buildAt).toBe("2027-01-12T11:45Z")
    expect(at(2, 11, 45) - CERTIFIED).toBeGreaterThan(recorded.rules.staleMs)
    expect(at(2, 11, 45) - CERTIFIED).toBeLessThanOrEqual(recorded.rules.unavailableMs)
    expect(api("delayed").read).toEqual({ kind: "delayed", retained: false })
    expect(record("delayed")).toMatchObject({ perpsPartial: true, perpsAsOfMs: CERTIFIED })
    expect(record("delayed")).not.toHaveProperty("perpsUnavailable")
    for (const field of ["perpsNetUsd", "totalPnlUsd", "perpsSnapshotId"]) expect(record("delayed")[field]).toBe(record("record")[field])
    expect(record("delayed").rows).toEqual(record("record").rows)
    expect(row("delayed-cli").outcome.lines[1]).toBe("Perps as of 2027-01-12T09:02:00.000Z (partial)")
  })

  test("past 3 hours the perps are unavailable: the record says so with the last certified time, and no perps figure or round", () => {
    expect(row("unavailable-api").buildAt).toBe("2027-01-12T12:20Z")
    expect(at(2, 12, 20) - CERTIFIED).toBeGreaterThan(recorded.rules.unavailableMs)
    expect(api("unavailable").read).toEqual({ kind: "unavailable", reason: "stale_observation", retained: false })
    const r = record("unavailable")
    // The time is the reason an agent can give: the perps data has been delayed since then.
    expect(r).toMatchObject({ perpsUnavailable: true, perpsPartial: true, perpsAsOfMs: CERTIFIED })
    expect(r.totals).toMatchObject({ perpsUnavailable: true, perpsPartial: true, perpsAsOfMs: CERTIFIED })
    for (const field of ["perpsRealizedUsd", "perpsFundingUsd", "perpsFeesUsd", "perpsUnrealizedUsd", "perpsNetUsd", "perpsSnapshotId", "perpsCoverageFromMs", "perpRounds", "perpsTopCloses"]) expect(r).not.toHaveProperty(field)
    // The list is the swaps alone and the headline the spot record's: never a flat book in the perps' place.
    expect((r.rows as any[]).map((x) => x.kind)).toEqual(["trade", "trade", "trade", "trade", "trade", "trade"])
    expect(r).toMatchObject({ rowsTotal: 6, totalPnlUsd: 102.5 })
    expect(r.totals).toMatchObject({ wins: 1, losses: 1, counted: 2 })
    expect(row("unavailable-cli").outcome.lines.slice(0, 2)).toEqual(["Record fixture", "Perps as of 2027-01-12T09:02:00.000Z (unavailable)"])
    expect(row("unavailable-cli").outcome.lines.join("\n")).not.toMatch(/ROE|Long |Short /)
  })

  test("a wallet no hour has certified yet is unavailable with no perps time, and an agent with no perps has no perps field", () => {
    expect(api("never-certified").read).toEqual({ kind: "unavailable", reason: "no_certified_observation", retained: false })
    expect(record("never-certified")).toMatchObject({ perpsUnavailable: true, perpsPartial: true })
    expect(record("never-certified")).not.toHaveProperty("perpsAsOfMs")
    expect(row("never-certified-cli").outcome.lines[1]).toBe("Perps as of not recorded (unavailable)")
    expect(api("no-perps").read).toEqual({ kind: "none" })
    expect(Object.keys(record("no-perps")).filter((k) => k.startsWith("perp"))).toEqual([])
    expect(Object.keys(record("no-perps").totals).filter((k) => k.startsWith("perp"))).toEqual([])
    // The CLI prints its perps line for every record, so an agent with no perps reads "not recorded" there.
    expect(row("no-perps-cli").outcome.lines.slice(0, 2)).toEqual(["Record fixture", "Perps as of not recorded"])
  })
})

describe("the agent surfaces", () => {
  test("the MCP tool, the hosted server, the SDK and `candle agent record --json` each give the route's answer whole, in one keyless read", () => {
    for (const id of ANSWERED) {
      const body = answer(id)
      const relays = `${id}-api`
      const mcp = row(`${id}-mcp`), hosted = row(`${id}-mcp-hosted`), sdk = row(`${id}-sdk`), json = row(`${id}-cli-json`)
      expect(mcp.outcome).toEqual({ relays, sha256: sha256(body), isError: false })
      // The hosted server puts its note that the content is untrusted data in front, and relays the same answer.
      expect(hosted.outcome).toEqual({ preamble: true, relays, sha256: sha256(body), isError: false })
      // The SDK gives the record itself, without the envelope.
      expect(sdk.outcome).toEqual({ relays, part: "record", sha256: sha256(body.record), isError: false })
      expect(json.outcome).toEqual({ exitCode: 0, relays, sha256: sha256(body) })
      // No credential on any of them, though the local server, the SDK and the CLI each had a key configured.
      for (const r of [mcp, hosted, sdk, json, row(`${id}-cli`)]) expect(r.requests).toEqual([{ method: "GET", path: PATH, credential: false }])
      expect(row(`${id}-cli`).outcome.exitCode).toBe(0)
    }
    const second = api("record-paged").nextPage!
    const relays = "record-paged-api nextPage"
    expect(row("record-paged-page-2-mcp").outcome).toEqual({ relays, sha256: sha256(second), isError: false })
    expect(row("record-paged-page-2-mcp-hosted").outcome).toEqual({ preamble: true, relays, sha256: sha256(second), isError: false })
    expect(row("record-paged-page-2-sdk").outcome).toEqual({ relays, part: "record", sha256: sha256(second.record), isError: false })
    expect(row("record-paged-page-2-cli-json").outcome).toEqual({ exitCode: 0, relays, sha256: sha256(second) })
    // The answers differ from one scenario to the next, so a hash names one answer only.
    expect(new Set(ANSWERED.map((id) => sha256(answer(id)))).size).toBe(ANSWERED.length)
  })

  test("`candle agent record` prints the name, the perps time, then one line a row: a swap, or a round with every figure", () => {
    const lines = row("record-cli").outcome.lines as string[]
    expect(lines).toHaveLength(2 + 10)
    expect(lines[2]).toBe("buy MOON 120")
    expect(lines[4]).toBe("sell FAKE 260")
    expect(lines[7]).toBe(`Short BTC 5x · size 0.1 · entry 95000 · exit 96000 · -$104.93 · -5.5% ROE · funding 0.8 · fees 5.73 · duration 8400s · https://app.hyperliquid.xyz/explorer/tx/${round("record", "BTC").hash}`)
    expect(lines[9]).toBe(`Long ETH 10x · size 3 · entry 3020 · exit 3150 · +$383.25 · 42.3% ROE · funding -1.2 · fees 5.55 · duration 7200s · https://app.hyperliquid.xyz/explorer/tx/${round("record", "ETH").hash}`)
    // The human view has no P&L line: the breakdown's figures are in --json, the MCP tool and the SDK.
    expect(lines.join("\n")).not.toMatch(/realized|unrealized|P&L|Portfolio/i)
    expect(answer("record").record).toMatchObject({ perpsRealizedUsd: 250, perpsNetUsd: 259.62 })
  })

  test("a refusal is relayed as one: an agent that is not published, and a cursor from a record that has changed", () => {
    const expected = {
      "refused-not-published": { status: 404, code: "RECORD_NOT_FOUND", message: "No published record for this agent" },
      "refused-cursor-expired": { status: 400, code: "VALIDATION_FAILED", message: "Record changed; restart paging" },
    }
    for (const id of REFUSED) {
      const { status, code, message } = expected[id]
      const stub = row(`${id}-api`).outcome
      expect(stub).toMatchObject({ status, body: { success: false, error: { code, message } } })
      expect(row(`${id}-mcp`).outcome).toEqual({ body: stub.body, isError: true })
      expect(row(`${id}-mcp-hosted`).outcome).toEqual({ preamble: true, body: stub.body, isError: true })
      expect(row(`${id}-sdk`).outcome).toEqual({ isError: true, error: { status, code, message } })
      expect(row(`${id}-cli`).outcome).toEqual({ exitCode: 1, stdout: [], stderr: [message] })
      expect(row(`${id}-cli-json`).outcome).toMatchObject({ exitCode: 1, body: { ok: false, code, status, message } })
      // One read each, with no key, and nothing retried.
      for (const surface of ["mcp", "mcp-hosted", "sdk", "cli", "cli-json"]) {
        expect(row(`${id}-${surface}`).requests).toHaveLength(1)
        expect(row(`${id}-${surface}`).requests![0]!.credential).toBe(false)
      }
      // The Candle Harness hands the agent the refusal with its code.
      const { outcome } = row(`${id}-mcp`)
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(outcome.body) }], isError: true })).toMatchObject({ kind: "error", code, retryable: false })
    }
    expect(row("refused-cursor-expired-api").outcome.body.error.details).toEqual({ field: "cursor" })
    expect(row("refused-cursor-expired-mcp").args!.cursor).toMatch(/^u1:/)
  })

  test("what never leaves the machine: a name that is not a profile id, and a cursor that is not text", () => {
    expect(row("usage-cli-not-a-profile-id")).toMatchObject({ args: { command: "candle agent record momentum" }, requests: [], outcome: { exitCode: 2, stdout: [], stderr: ["Usage: candle agent record <profile-id> [--cursor cursor] [--json]"] } })
    expect(row("usage-mcp-cursor-not-text")).toMatchObject({ args: { cursor: 123 }, requests: [], outcome: { isError: true } })
  })

  test("the Candle Harness passes the read through: a read by class, the answer whole, and the CLI command pointed at the tool", () => {
    expect(TOOL_CLASSES.candle_get_agent_record).toEqual({ class: "read" })
    for (const mode of ["live", "paper"] as const) expect(classify("candle_get_agent_record", { profileId: recorded.profile }, mode)).toEqual({ class: "read" })
    for (const id of ANSWERED) {
      const { outcome } = row(`${id}-mcp`)
      // Unavailable perps are an answer, not an error: the agent reads the flag and the time.
      expect(toOutcome({ content: [{ type: "text", text: JSON.stringify(answer(id)) }], isError: outcome.isError })).toEqual({ kind: "ok", result: answer(id) })
    }
    expect(rowFor("agent record")).toMatchObject({ rule: "mcp", route: "cli", identity: "agent", mcpTool: "candle_get_agent_record" })
    for (const args of [[recorded.profile], [recorded.profile, "--cursor", record("record-paged").rowsCursor]]) {
      const routed = resolveCall({ command: "agent", subcommand: "record", args }, ctx)
      expect(routed.ok && routed.call.rule).toBe("mcp")
      expect(JSON.stringify(routed)).toContain("candle_get_agent_record")
    }
    // A flag the command doesn't have is refused before anything runs, as for every command.
    expect(resolveCall({ command: "agent", subcommand: "record", args: [recorded.profile, "--kind", "perp"] }, ctx)).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    // The command's own flags, as its source declares them.
    const entry = SOURCE.commands.find((c) => c.command === "agent" && c.subcommand === "record")!
    expect(entry).toMatchObject({ handler: "agentRecord", identity: "none", json: true, unlocks: "never", flags: { value: ["--cursor"], boolean: [], path: [] } })
  })
})

describe("what Candle's tools and docs say", () => {
  const local = tools.tools.find((t) => t.name === "candle_get_agent_record")!
  const hosted = row("hosted-tools-list").outcome as { tools: string[]; record: { description: string; inputSchema: any; annotations: any } }

  test("the local tool takes a profile id and an optional cursor, and says what a round carries and that unknown is not zero", () => {
    expect(local.inputSchema).toMatchObject({ properties: { profileId: { type: "string" }, cursor: { type: "string" } }, required: ["profileId"], additionalProperties: false })
    for (const fragment of [
      "spot swaps and certified closed Hyperliquid rounds interleaved newest first", "No key needed", "dex:COIN", "recorded leverage (null when unknown)", "largest size, entry and exit averages",
      "funding (positive earned)", "returnPct is net P&L / initial margin at the largest size, times 100", "perpsAsOfMs stamps the certified figures", "perpsCoverageFromMs is the coverage start",
      "A missing field is unknown, never zero", "Pass rowsCursor as cursor to page; restart if the cursor expires", "Private and hidden agents answer RECORD_NOT_FOUND", "Measured record, not a forecast",
    ]) expect(local.description).toContain(fragment)
  })

  test("the hosted server lists the record read among its thirteen public tools, read-only, with the same arguments", () => {
    expect(hosted.tools).toHaveLength(13)
    expect(hosted.tools).toContain("candle_get_agent_record")
    expect(hosted.tools).toContain("candle_get_agent_positions")
    expect(hosted.record.inputSchema).toMatchObject({ properties: local.inputSchema.properties, required: ["profileId"], additionalProperties: false })
    expect(hosted.record.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    for (const fragment of ["spot swaps and certified Hyperliquid rounds", "return on initial margin", "rowsCursor pages the combined history", "perpsAsOfMs and perpsCoverageFromMs name freshness and coverage", "Unknown is not zero", "Measured record, not a forecast"]) expect(hosted.record.description).toContain(fragment)
  })

  test("the public page describes the read, the round row and the perps times, the same in its three copies", () => {
    for (const id of ["docs-record-read", "docs-round-row", "docs-perps-times"]) expect(row(id).args!.files).toEqual(["docs/agent-trading.md", "apps/docs/src/content/docs/developers/agent-trading.md", "apps/frontend/public/docs/agent-trading.md"])
    const read = row("docs-record-read").outcome.text as string
    for (const fragment of ["`candle agent record <profile-id> [--cursor cursor] [--json]`", "SDK `getAgentRecord(profileId, { cursor })`", "MCP `candle_get_agent_record` (local and hosted) request `rows=all`", "newest first", "restart paging if it expires", "These reads send no credential"]) expect(read).toContain(fragment)
    const roundRow = row("docs-round-row").outcome.text as string
    for (const fragment of [
      "preserves the full `dex:COIN` name", "`size` (largest size reached)", "`entryPx` (average basis at that size)", "`exitPx` (size-weighted reductions)", "`fundingUsd` (positive earned)",
      "Initial margin is entry average × largest size / leverage; ROE is net round P&L / that margin × 100", "the last landed Candle leverage action before open, else the highest certified observation during the round",
      "`leverageSource` names `order` or `snapshot`; unknown leverage and return are null", "Older published bundles omit the added fields", "No wallet or account value is added to a round",
    ]) expect(roundRow).toContain(fragment)
    const times = row("docs-perps-times").outcome.text as string
    for (const fragment of ["`perpsAsOfMs` stamps every perps figure, including the last certified time when unavailable", "`perpsCoverageFromMs` names the start of stored coverage", "Measured record, not a forecast"]) expect(times).toContain(fragment)
  })
})
