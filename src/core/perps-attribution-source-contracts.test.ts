// Perps traded from an embedded wallet, in Candle's public record (BE-3773): each fill belongs to the agent whose
// key built the order, matched by client order id (`cloid`) and checked against the venue order id (`oid`) the
// venue pinned to it. Recorded offline from one exact commit (scripts/read-perps-attribution-source.ts): Candle's
// own board path builds each answer from one made-up embedded wallet's stored facts and a made-up order
// inventory, and the registered MCP tool, the SDK and `candle agent positions` read the positions answer. The
// commit is a pull request's head, not yet in a staging build: the published CLI, MCP and SDK are unchanged by it.
import { expect, test } from "bun:test"
import attribution from "../../test/fixtures/candle-perps-attribution-source.json"

type Request = { method: string; path: string; credential: boolean }
type Row = { id: string; scenario: string; surface: string; evidence?: string; says?: string; buildAt?: string; args?: Record<string, any>; requests?: Request[]; outcome: any }
const rows = attribution.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const SCENARIOS = ["owner-trade-excluded-open", "owner-trade-excluded-closed", "sole-agent", "unpinned-cloid", "reused-cloid", "owner-only", "agent-not-public"] as const
type Scenario = (typeof SCENARIOS)[number]
const api = (id: Scenario) => row(`${id}-api`).outcome
const why = (id: Scenario) => row(`${id}-attribution`).outcome
const PATH = `/api/v1/agent/records/${attribution.profile}/positions`

test("the recording names its exact source and says what it did not run", () => {
  expect(attribution.source.repo).toBe("candledottv/candle-monorepo")
  expect(attribution.source.commit).toBe("61d0d40b454e177c4b6d60d507c3f7c6ff985182")
  expect(attribution.source.versions).toEqual({ cli: "0.13.32", mcp: "0.10.37", sdk: "0.6.26" })
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  for (const id of SCENARIOS) {
    expect(rows.filter((r) => r.scenario === id).map((r) => r.surface).sort()).toEqual(["api-source", "api-source", "cli", "cli", "mcp", "sdk"])
    expect(row(`${id}-api`).evidence).toContain("the keyed route are not executed")
  }
  expect(rows).toHaveLength(SCENARIOS.length * 6 + 1)
})

test("nothing in the recording is a wallet address, an owner's fill hash, a key, an account figure or an order id", () => {
  const text = JSON.stringify(attribution)
  expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/)
  expect(text).not.toContain("0x0e0e")
  expect(text).not.toMatch(/"(wallet|address|accountValue|withdrawable|freeMargin|marginRatio|oid|cloid)"/i)
  expect(text).not.toMatch(/cndl_|fixture-only-not-a-key/)
  expect(attribution.profile).toBe("prof_0123456789abcdef")
})

test("the owner's own trade is in no answer: the agent's position is its own size at its own entry", () => {
  expect(why("owner-trade-excluded-open").fills).toEqual([
    { time: "09:10", reason: "order", holder: ["agent"] },
    { time: "09:20", reason: "no_order", holder: ["not public"] },
  ])
  // The wallet holds 3 ETH at 101.67; the agent bought 2 at 100.
  const perp = api("owner-trade-excluded-open").positions.positions.filter((p: any) => p.kind === "perp")
  expect(perp).toHaveLength(1)
  expect(perp[0]).toMatchObject({ coin: "ETH", side: "long", size: "2", entryPx: "100" })
  expect(api("owner-trade-excluded-open").perpRounds).toEqual([])
  // The owner's own round (buy, then sell) never becomes anyone's, and the agent with only an unfilled order has none.
  expect(why("owner-only").fills.every((f: any) => f.reason === "no_order" && f.holder[0] === "not public")).toBe(true)
  expect(api("owner-only")).toMatchObject({ perpRounds: [], totals: { counted: 0, perpsRealizedUsd: 0, perpsNetUsd: 0 } })
  expect(api("owner-only").positions.positions.filter((p: any) => p.kind === "perp")).toEqual([])
})

test("a shared round is the agent's fills only, marked partial with the reason, and carries no id and no hash", () => {
  expect(why("owner-trade-excluded-closed").partialEvents).toEqual(["unmatched_fill"])
  const [round, ...rest] = api("owner-trade-excluded-closed").perpRounds
  expect(rest).toEqual([])
  // Against its own entry (100): 2 x (120 - 100) = 40, less its two-thirds funding share of 3 USD.
  expect(round).toEqual({
    kind: "perp_round", coin: "ETH", side: "long", leverage: { value: 10, type: "cross" }, pnlUsd: 38, liquidated: false,
    openedMs: Date.parse(`${attribution.day}T09:10:00Z`), closedMs: Date.parse(`${attribution.day}T10:10:00Z`),
    hash: null, partial: true, partialReasons: ["unmatched_fill"],
  })
  expect(round).not.toHaveProperty("id")
  expect(api("owner-trade-excluded-closed").totals).toMatchObject({ perpsRealizedUsd: 40, perpsFundingUsd: -2, perpsNetUsd: 38, counted: 1, perpsPartial: true })
})

test("a wallet only the agent trades gives an exact round, not partial, and still no id and no hash", () => {
  expect(why("sole-agent")).toEqual({ fills: [{ time: "09:10", reason: "order", holder: ["agent"] }, { time: "10:10", reason: "order", holder: ["agent"] }], partialEvents: [] })
  const [round] = api("sole-agent").perpRounds
  expect(round).toMatchObject({ coin: "ETH", side: "long", pnlUsd: 14.8, hash: null })
  expect(round).not.toHaveProperty("partial")
  expect(round).not.toHaveProperty("partialReasons")
  expect(round).not.toHaveProperty("id")
  expect(api("sole-agent").totals).toMatchObject({ perpsPartial: false, counted: 1 })
})

test("a cloid the venue never pinned claims nothing: order_unverified, not in the profile", () => {
  expect(why("unpinned-cloid").fills).toEqual([
    { time: "09:10", reason: "order_unverified", holder: ["not public"] },
    { time: "10:10", reason: "order_unverified", holder: ["not public"] },
  ])
  // The same facts as the sole agent's, which has a round; the unpinned orders give the agent none, and no position.
  expect(api("unpinned-cloid")).toMatchObject({ perpRounds: [], totals: { counted: 0, perpsRealizedUsd: 0, perpsFeesUsd: 0, perpsNetUsd: 0 } })
  expect(api("unpinned-cloid").positions.positions.filter((p: any) => p.kind === "perp")).toEqual([])
  expect(api("sole-agent").perpRounds).toHaveLength(1)
})

test("a cloid carried by another venue order than the pinned one claims nothing either", () => {
  expect(why("reused-cloid").fills).toEqual([{ time: "09:10", reason: "cloid_reused", holder: ["not public"] }])
  expect(api("reused-cloid").positions.positions.filter((p: any) => p.kind === "perp")).toEqual([])
  expect(api("reused-cloid").totals).toMatchObject({ perpsFeesUsd: 0, perpsNetUsd: 0, counted: 0 })
})

test("an agent that is not public is served nothing", () => {
  expect(api("agent-not-public")).toMatchObject({ served: false, available: null, perpRounds: [] })
  expect(api("agent-not-public").positions.positions.filter((p: any) => p.kind === "perp")).toEqual([])
  // The fills are the agent's by order; only the public gate keeps them out.
  expect(why("agent-not-public").fills.map((f: any) => f.reason)).toEqual(["order", "order"])
})

test("the MCP tool, the SDK and the CLI carry the positions answer whole, from a public read with no key", () => {
  for (const id of SCENARIOS) {
    const positions = api(id).positions
    const { success: _success, ...answer } = positions
    expect(row(`${id}-mcp`).outcome).toEqual({ body: positions, isError: false })
    expect(row(`${id}-sdk`).outcome.body).toEqual(answer)
    expect(row(`${id}-cli-json`).outcome).toEqual({ exitCode: 0, body: positions })
    for (const surface of ["mcp", "sdk", "cli", "cli-json"]) {
      const requests = row(`${id}-${surface}`).requests as Request[]
      expect(requests[0]).toMatchObject({ method: "GET", path: PATH })
      expect(requests.every((r) => r.method === "GET")).toBe(true)
      // Public reads: the MCP tool and the CLI send no key though one is configured.
      if (surface !== "sdk") expect(requests.every((r) => !r.credential)).toBe(true)
    }
  }
  // The human view of the shared open position is the agent's 2, marked partial.
  const lines = row("owner-trade-excluded-open-cli").outcome.lines.join("\n")
  expect(lines).toContain("perps partial")
  expect(lines).toMatch(/ETH/)
})

test("the public page's by-order section says the record is by order, not by wallet", () => {
  const { text } = row("docs-agent-trading").outcome
  expect(text).toContain("Which perps count for an agent: by order, not by wallet")
  expect(text).toContain("cloid")
  expect(text).toContain("`hash: null`")
  expect(text).toContain("`partialReasons`")
  expect(text).toContain("in no public figure, rank, round")
  expect(text).not.toContain("KEY_LIMIT_REACHED")
})
