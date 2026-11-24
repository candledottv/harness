// Perps fills in Candle's public activity stream, and `hide` on perps orders (BE-3769), as Candle's API runs them:
// a published agent's fill goes out as perp_open, perp_add, perp_reduce or perp_close under the trade rule (the
// a published agent's key, never a hidden order), with no wallet, account or key on the wire. Recorded offline from
// one exact commit (scripts/read-perps-stream-source.ts). At it the CLI, MCP and SDK perps orders take `hide`
// (BE-3996, recorded in scripts/read-perps-hide-source.ts), and the Candle Harness takes `--hide` on the perps cards
// it runs (`perps close` and `perps tpsl`); every MCP perps write is still refused, and `perps open` and `modify`
// are still coming.
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-perps-stream-source.json"
import { hideAsked } from "./cards"
import { classify } from "./classify"
import { resolveCall } from "./cli-tool"

type Row = { id: string; scenario: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = fixture.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const TYPES = ["perp_open", "perp_add", "perp_reduce", "perp_close", "perp_liquidation"]
const sent = (id: string) => row(`announce-${id}`).outcome

test("the recording names the exact staging build and the files", () => {
  expect(fixture.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "95bad55f61ae7e29a181c9d1c0e8fabaca8e104c",
    versions: { cli: "0.13.47", mcp: "0.10.45", sdk: "0.6.39" },
    files: [
      "apps/api/src/lib/stream-eligibility.ts",
      "apps/api/src/lib/perps-stream.ts",
      "apps/api/src/lib/activity-broadcast.ts",
      "apps/api/src/lib/agent-hide.ts",
      "apps/api/src/routes/agent-perps.ts",
      "apps/api/src/lib/perps-reconcile.ts",
      "packages/db/runtime/perpOrders.ts",
      "packages/db/convex/schema.ts",
    ],
  })
  expect(rows).toHaveLength(83)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["types", "eligibility", "event-kind", "announce", "payload", "fills", "hide-parse", "source-pin", "clients"]))
})

test("nothing in the recording is a wallet address, a key or a member's handle", () => {
  const text = JSON.stringify(fixture)
  expect(text.match(/0x[0-9a-fA-F]{32,}/g) ?? []).toEqual([])
  expect(text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? []).toEqual([])
  expect(text).not.toMatch(/cndl_|sk_live|BEGIN/)
  for (const r of scenario("announce")) {
    const wire = r.outcome.wire as Record<string, unknown> | undefined
    if (!wire) continue
    for (const field of ["userAddress", "walletAddress", "keyPrefix", "streamHidden", "viaApiKey", "username", "profilePic", "accountValue"]) expect(wire).not.toHaveProperty(field)
  }
})

test("the perps event types are the five Candle pins", () => {
  expect(row("perp-stream-types").outcome.types).toEqual(TYPES)
})

test("a perps event follows the trade rule exactly: a published agent's key, never hidden", () => {
  const cases = scenario("eligibility").filter((r) => r.outcome.perps)
  expect(cases).toHaveLength(8)
  for (const r of cases) {
    expect(Object.keys(r.outcome.perps)).toEqual(TYPES)
    for (const v of Object.values(r.outcome.perps)) expect(v).toBe(r.outcome.buy)
  }
  expect(Object.values(row("eligible-published-agent-key").outcome.perps).every(Boolean)).toBe(true)
  for (const id of ["hidden-order", "private-agent-no-name", "blank-agent-name", "human-order-no-agent-key", "agent-key-missing", "agent-key-blank", "via-api-key-not-boolean-true"])
    expect(Object.values(row(`eligible-${id}`).outcome.perps).some(Boolean)).toBe(false)
  for (const asks of Object.values(row("perp-events-ask-for-the-agent-name").outcome.asksName)) expect(asks).toEqual({ agentKey: true, noAgentKey: false })
})

test("the switch that gated perps events and trades in the stream is gone at this commit (BE-3970)", () => {
  expect(rows.some((r) => r.id === "trades-in-stream-switch-values" || r.id === "eligible-switch-off")).toBe(false)
})

test("the kind comes from the position's size before and after the fill; a flip through zero is an open", () => {
  const kind = (id: string) => row(`kind-${id}`).outcome.type
  expect(["flat-to-long", "flat-to-short", "long-flips-short", "short-flips-long", "dust-before-is-flat"].map(kind)).toEqual(Array(5).fill("perp_open"))
  expect(["long-grows", "short-grows"].map(kind)).toEqual(["perp_add", "perp_add"])
  expect(["long-shrinks", "short-shrinks"].map(kind)).toEqual(["perp_reduce", "perp_reduce"])
  expect(["long-to-flat", "short-to-flat", "dust-after-is-flat"].map(kind)).toEqual(Array(3).fill("perp_close"))
})

test("a published agent's fill goes out once under the agent's name, with side, leverage and notional", () => {
  const base = { timestamp: 1_790_000_000_000, agentName: "Fixture Agent" }
  expect(sent("open-long-from-flat").wire).toEqual({ type: "perp_open", coin: "ETH", side: "long", leverage: 10, notionalUsd: 4500, ...base })
  expect(sent("open-short-from-flat").wire).toEqual({ type: "perp_open", coin: "BTC", side: "short", leverage: 20, notionalUsd: 15000, ...base })
  expect(sent("add-to-long").wire).toEqual({ type: "perp_add", coin: "ETH", side: "long", leverage: 10, notionalUsd: 1550, ...base })
  expect(sent("flip-long-to-short-is-an-open").wire).toMatchObject({ type: "perp_open", side: "short", leverage: 5, notionalUsd: 6000 })
  for (const r of scenario("announce").filter((x) => x.outcome.sent)) {
    expect(r.outcome.lookups).toEqual([{ owner: "the order's owner", key: "the order's key" }])
    expect(r.outcome.threw).toBe(false)
  }
})

test("realized P&L rides only on a close, in cents; a reduce carries none", () => {
  expect(sent("close-long-carries-pnl").wire).toMatchObject({ type: "perp_close", side: "long", realizedPnlUsd: 412.35, notionalUsd: 4950, leverage: 10 })
  expect(sent("close-short-carries-a-loss").wire).toMatchObject({ type: "perp_close", side: "short", realizedPnlUsd: -250, notionalUsd: 15250 })
  expect(row("announce-reduce-long-keeps-no-pnl").args.realizedPnlUsd).toBe(87.654)
  expect(sent("reduce-long-keeps-no-pnl").wire).not.toHaveProperty("realizedPnlUsd")
  expect(row("payload-pnl-only-on-a-close").outcome.hasRealizedPnl).toBe(false)
})

test("a closed position's leverage is read from the account's asset setting, and left out when unreadable", () => {
  expect(sent("close-long-carries-pnl").venueReads).toEqual(["clearinghouse", "activeAssetData"])
  expect(sent("close-leverage-unreadable-is-left-out")).toMatchObject({ sent: true, venueReads: ["clearinghouse", "activeAssetData"] })
  expect(sent("close-leverage-unreadable-is-left-out").wire).not.toHaveProperty("leverage")
})

test("a builder-dex fill names its market as dex:COIN", () => {
  expect(sent("builder-dex-coin").wire).toMatchObject({ type: "perp_open", coin: "xyz:XYZ100", notionalUsd: 123.71 })
})

test("a hidden order, a private agent, a failed lookup, a blank key and a failed venue read send nothing", () => {
  for (const id of ["hidden-order", "private-agent", "lookup-failure", "blank-agent-key", "venue-read-failure", "unreadable-size"]) {
    const o = sent(`${id}-sends-nothing`)
    expect(o.sent).toBe(false)
    expect(o).not.toHaveProperty("wire")
    expect(o.threw).toBe(false)
  }
  // A hidden order stops before the agent lookup; a blank key never reaches it either.
  for (const id of ["hidden-order", "blank-agent-key"]) expect(sent(`${id}-sends-nothing`).lookups).toEqual([])
  expect(sent("private-agent-sends-nothing").lookups).toHaveLength(1)
})

test("the strip leaves the agent's name and the trade and drops the owner and the agent marker", () => {
  expect(row("payload-before-the-strip").outcome).toMatchObject({ carriesTheOwner: true, viaApiKey: true, notionalUsd: 4950.01, realizedPnlUsd: 12.35, hasLeverage: false })
  expect(row("payload-after-the-strip").outcome.fields).toEqual(["agentName", "coin", "notionalUsd", "realizedPnlUsd", "side", "timestamp", "type"])
})

test("an increase is priced from the order's own fills: volume-weighted, by cloid, bad sizes skipped", () => {
  expect(row("fills-two-fills-volume-weighted").outcome.summary).toEqual({ px: 3075, size: 4, pnl: 6, time: 300 })
  expect(row("fills-cloid-read-case-insensitively").outcome.summary).toEqual({ px: 50, size: 2, pnl: 0, time: 7 })
  expect(row("fills-other-orders-ignored").outcome.summary).toEqual({ px: 40, size: 1, pnl: 1.5, time: 5 })
  expect(row("fills-zero-negative-and-unreadable-sizes-ignored").outcome.summary).toEqual({ px: 40, size: 2, pnl: 0, time: 8 })
  expect(row("fills-no-fill-for-the-order").outcome.summary).toBeNull()
})

test("hide on a perps order is parsed as on a trade, and the Candle Harness reads every value the same or stricter", () => {
  const parse = scenario("hide-parse")
  expect(parse).toHaveLength(14)
  for (const r of parse) {
    const value = r.args.value === "absent" ? undefined : r.args.value
    const api = r.outcome as { ok: boolean; hide?: boolean }
    const ours = hideAsked(value)
    // null is the one value Candle reads as "not hidden" and the Candle Harness refuses as unreadable: stricter,
    // never a hidden order read as public.
    if (value === null) { expect(api).toEqual({ ok: true, hide: false }); expect(ours).toBeNull(); continue }
    expect(ours).toBe(api.ok ? api.hide! : null)
  }
  for (const id of ["string-yes", "2", "string-upper-true", "object"]) expect(row(`hide-parse-${id}`).outcome).toEqual({ ok: false, message: 'hide must be a boolean (true, "true" or 1)' })
})

test("the perps routes take hide on open, close, modify and tpsl, store it, echo it, and keep a hidden order hidden", () => {
  const pins = scenario("source-pin")
  expect(pins.every((r) => r.outcome.found === true)).toBe(true)
  const ids = new Set(pins.map((r) => r.id))
  for (const route of ["open", "close", "modify", "tpsl"]) {
    expect(ids.has(`${route}-parses-hide-before-building`)).toBe(true)
    expect(ids.has(`${route}-stores-and-echoes-hide`)).toBe(true)
  }
  for (const id of ["perp-hide-is-parse-hide-or-a-400", "open-and-close-fingerprint-carries-hide", "modify-of-a-hidden-order-stays-hidden", "replay-answers-the-stored-flag", "echo-only-when-hidden", "row-stores-stream-hidden"]) expect(ids.has(id)).toBe(true)
})

test("hide has no switch at this commit: AGENT_HIDE_ENABLED was deleted (BE-3734), so hide is always taken", () => {
  expect(row("hide-has-no-switch-in-the-route").outcome.found).toBe(true)
  expect(row("hide-switch-deleted-in-flags").outcome.found).toBe(true)
})

test("each fill increase is claimed once in the settle transaction and announced only from that claim", () => {
  for (const id of ["settle-claims-each-increase-once", "reconcile-announces-only-the-claim", "reconcile-announces-order-kinds-only", "reconcile-passes-the-rows-hide", "schema-perp-orders-stream-fields", "perps-agent-named-from-the-key-not-the-payload", "no-liquidation-emitter-yet"])
    expect(row(id).outcome.found).toBe(true)
})

test("the perps orders in Candle's CLI, MCP server and SDK take hide at this commit", () => {
  expect(row("clients-carry-perps-hide").outcome).toEqual({ cliPerpsTakesHide: true, mcpPerpsTakesHide: true, mcpManageTakesHide: true, sdkOpenCloseModifyTakeHide: true, sdkTpslTakesHide: true })
})

test("the Candle Harness takes --hide on the perps rows it can run, and still refuses every MCP perps write", () => {
  const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }
  for (const [subcommand, args] of [["close", ["BTC"]], ["tpsl", ["BTC", "--stop-loss", "50000"]]] as const) {
    const r = resolveCall({ command: "perps", subcommand, args: [...args, "--hide"] }, ctx)
    expect(r.ok).toBe(true)
    expect(r.ok ? r.call.argv : []).toContain("--hide")
  }
  // `perps open` and `modify` have no card yet: they are taken as a command (no unknown-flag refusal), then held as coming.
  for (const [subcommand, args] of [["open", ["BTC", "long", "10"]], ["modify", ["--cloid", `0x${"1".repeat(32)}`, "--price", "1"]]] as const) {
    const r = resolveCall({ command: "perps", subcommand, args: [...args, "--hide"] }, ctx)
    expect(r.ok ? r.call.argv : []).toContain("--hide")
  }
  for (const tool of ["candle_perps_open", "candle_perps_close", "candle_perps_modify"]) for (const mode of ["live", "paper"] as const) expect(classify(tool, { hide: true }, mode)).toMatchObject({ class: "refused", code: "NOT_YET_SUPPORTED" })
})
