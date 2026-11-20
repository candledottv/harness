// Perps position webhooks (`perps.position_opened`, `perps.position_closed`, `perps.liquidated`) and the perps wallet
// activity read, as Candle's API, SDK, MCP server and CLI carry them. Recorded offline from one exact commit
// (scripts/read-perps-webhook-source.ts): the events come from the perps ingest, so they can be up to about two hours
// late, and each carries the exchange's fill time. The Candle Harness receives no webhook itself; what it holds here
// is that the shapes an owner's endpoint gets are the ones the SDK verifies, that `candle perps activity` and
// `candle_perps_activity` are reads, and that another key's thresholds stay the owner's.
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-perps-webhook-source.json"
import { classify, TOOL_CLASSES } from "./classify"
import { resolveCall } from "./cli-tool"
import { rowFor } from "./cli-table"
import SOURCE from "./cli-source.json"
import tools from "../../test/fixtures/candle-tools.json"

type Row = { id: string; scenario: string; args: Record<string, any>; outcome: Record<string, any> }
const rows = fixture.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const EVENTS = ["perps.position_opened", "perps.position_closed", "perps.liquidated"]
const PAYLOAD_KEYS = ["schema", "event", "network", "address", "coin", "dex", "side", "dir", "size", "price", "startPosition", "closedPnl", "fee", "fillId", "hash", "fillTime", "source"]
const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }

test("the recording names the exact merged source, the same commit as the CLI table and tools/list", () => {
  expect(fixture.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "bdf8548b9d6c3844b014f25ae1725cbae6f8b544",
    versions: { cli: "0.13.39", mcp: "0.10.42", sdk: "0.6.32" },
  })
  expect(fixture.source.commit).toBe(SOURCE.source.commit)
  expect(fixture.source.commit).toBe(tools.source.commit)
  expect(rows).toHaveLength(49)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["policy", "event", "payload", "emit", "deliver", "docs", "activity"]))
})

test("nothing in the recording is a wallet address, a fill hash, a key, a secret or a signature", () => {
  const text = JSON.stringify(fixture)
  expect(text.match(/0x[0-9a-fA-F]{32,}/g) ?? []).toEqual([])
  expect(text.match(/[0-9a-f]{64}/g) ?? []).toEqual([])
  expect(text).not.toMatch(/cndl_|sk_live|whsec_|BEGIN/)
  for (const r of scenario("payload").filter((r) => r.id.startsWith("payload-"))) {
    expect(r.outcome.payload.address).toBe("<wallet>")
    expect(r.outcome.payload.hash).toBe("<fill hash>")
  }
  for (const r of scenario("deliver")) expect(r.outcome.headers["x-candle-signature"]).toBe("t=<seconds>,v1=<64 hex>")
})

test("an endpoint may register the three position events beside the risk events, and the SDK names the same three", () => {
  expect(row("policy-perps-events").outcome.perps).toEqual(["perps.risk_warning", "perps.risk_critical", "perps.risk_cleared", ...EVENTS])
  expect(row("policy-register-the-three-position-events").outcome).toEqual({ ok: true, events: EVENTS })
  expect(row("policy-register-position-and-risk-events").outcome.ok).toBe(true)
  expect(row("policy-register-an-unknown-perps-event").outcome).toEqual({ ok: false })
  expect(row("sdk-event-names-match-policy").outcome).toEqual({ sdk: EVENTS, allRegistrable: true })
})

test("an open from flat, a close to zero and a liquidation of this wallet are events; nothing else is", () => {
  const expected: Record<string, string | null> = {
    "open-long-from-flat": "perps.position_opened",
    "open-short-from-flat": "perps.position_opened",
    "add-to-a-long": null,
    "partial-close-of-a-long": null,
    "full-close-of-a-long": "perps.position_closed",
    "full-close-of-a-short": "perps.position_closed",
    "flip-long-to-short": null,
    "builder-dex-open": "perps.position_opened",
    "builder-dex-full-close": "perps.position_closed",
    "liquidation-of-this-wallet": "perps.liquidated",
    "liquidation-address-case-differs": "perps.liquidated",
    "liquidators-own-fill": null,
    "builder-dex-liquidation": "perps.liquidated",
  }
  expect(Object.fromEntries(scenario("event").map((r) => [r.id.replace(/^event-/, ""), r.outcome.event]))).toEqual(expected)
  // Every event has its payload, and only events do.
  expect(scenario("payload").filter((r) => r.id.startsWith("payload-")).map((r) => r.id.replace(/^payload-/, "")).sort()).toEqual(Object.keys(expected).filter((k) => expected[k] !== null).sort())
})

test("each payload is candle.perps.position_event/1 with the fill time, the dex and source ingest, and the SDK accepts it", () => {
  for (const r of scenario("payload").filter((r) => r.id.startsWith("payload-"))) {
    const p = r.outcome.payload
    const keys = r.args.event === "perps.liquidated" ? [...PAYLOAD_KEYS.slice(0, -1), "liquidation", "source"] : PAYLOAD_KEYS
    expect(Object.keys(p)).toEqual(keys)
    expect(p).toMatchObject({ schema: "candle.perps.position_event/1", event: r.args.event, network: "mainnet", source: "ingest", fillTime: "2026-11-17T12:00:00.000Z" })
    expect(p.dex).toBe(p.coin.includes(":") ? p.coin.split(":")[0] : null)
    expect(p.fillId.startsWith(`${p.coin}:`)).toBe(true)
    expect(r.outcome.sdkAccepts).toBe(true)
  }
  expect(row("payload-full-close-of-a-short").outcome.payload).toMatchObject({ side: "short", closedPnl: "-120.5", startPosition: "-0.5" })
  expect(row("payload-builder-dex-full-close").outcome.payload).toMatchObject({ coin: "xyz:TSLA", dex: "xyz", side: "long" })
  expect(row("payload-liquidation-of-this-wallet").outcome.payload.liquidation).toEqual({ markPx: "90000", method: "market" })
  // Leverage isn't on a fill, so no payload claims one.
  for (const r of scenario("payload").filter((r) => r.id.startsWith("payload-"))) expect(r.outcome.payload).not.toHaveProperty("leverage")
  expect(row("sdk-guard-refuses-other-shapes").outcome).toEqual({ riskEvent: false, sourceNotIngest: false, unknownEvent: false, null: false, string: false })
})

test("the emit sends one event per new fill and owner, and nothing twice, late past a day, or with nobody to tell", () => {
  const sent = (id: string) => row(`emit-${id}`).outcome
  expect(row("max-age").outcome).toEqual({ ms: 86_400_000, hours: 24 })
  expect(sent("open-and-close-one-owner").enqueued.map((e: any) => e.event)).toEqual(["perps.position_opened", "perps.position_closed"])
  expect(sent("two-hours-late-still-sent").sent).toBe(1)
  expect(sent("liquidation-two-owners").enqueued.map((e: any) => [e.owner, e.event])).toEqual([["<owner>", "perps.liquidated"], ["<second owner>", "perps.liquidated"]])
  for (const id of ["increase-and-partial-close-send-nothing", "unlinked-wallet-nobody-to-tell", "re-ingest-inserts-no-fill", "fill-25-hours-old-is-history", "first-scan-days-back"]) expect(sent(id)).toMatchObject({ sent: 0, enqueued: [] })
  expect(sent("fill-23-hours-old").sent).toBe(1)
  // The owner is looked up only when there is something to send, from the ledger's live EVM links.
  expect(sent("re-ingest-inserts-no-fill").ownerLookups).toBe(0)
  expect(sent("increase-and-partial-close-send-nothing").ownerLookups).toBe(0)
  expect(sent("open-and-close-one-owner").lookup).toBe("select distinct account from identity.linked_wallets where chain = 'evm' and lower(address) = ? and revoked_at is null")
  for (const r of scenario("emit").filter((r) => r.id.startsWith("emit-"))) for (const e of r.outcome.enqueued) expect(e.fillTime).toBe("2026-11-17T12:00:00.000Z")
})

test("a delivery is signed as every Candle webhook, and the SDK verifies exactly what arrived", () => {
  const delivered = scenario("deliver")
  expect(delivered.map((r) => r.args.event).sort()).toEqual(["perps.liquidated", "perps.position_closed", "perps.position_closed", "perps.position_opened"])
  for (const r of delivered) {
    const o = r.outcome
    expect(o.result).toEqual({ ok: true, statusCode: 204 })
    expect(o.headers).toMatchObject({ "content-type": "application/json", "x-candle-event": r.args.event })
    expect(o.signatureTimestampIsDeliveryTime).toBe(true)
    expect(o.envelope).toEqual({ keys: ["id", "event", "createdAt", "data"], event: r.args.event, createdAtIsDeliveryTime: true })
    expect(o.data.fillTime).toBe("2026-11-17T12:00:00.000Z")
    expect(o.sdk).toEqual({ verifies: true, verifiesFourMinutesLater: true, refusesSixMinutesLater: true, refusesATamperedBody: true, refusesAnotherSecret: true, refusesNoHeader: true, acceptsThePayload: true })
  }
  // Delivered two hours after the fill: the payload's fillTime is the fill's, not the delivery's.
  expect(row("deliver-full-close-of-a-long").outcome.data).toEqual(row("payload-full-close-of-a-long").outcome.payload)
})

test("Candle's docs say the events are read from the ingest and can be about two hours late", () => {
  expect(row("docs-webhooks-rows").outcome.rows).toHaveLength(3)
  for (const e of EVENTS) expect(row("docs-webhooks-rows").outcome.rows.some((l: string) => l.startsWith(`| \`${e}\` |`))).toBe(true)
  expect(row("docs-webhooks-lateness").outcome.text).toContain("up to about two hours after `fillTime`")
  expect(row("docs-webhooks-lateness").outcome.text).toContain("perps.risk_critical")
  expect(row("sdk-changelog-entry").outcome.text).toMatch(/^Release 0\.6\.26 .*perps\.position_opened.*fillTime/)
})

test("candle perps activity, candle_perps_activity and perpsOverviewActivity() make the same two reads and give the same answer", () => {
  const runs = scenario("activity").filter((r) => r.id !== "activity-mcp-without-a-key")
  expect(runs).toHaveLength(3)
  for (const r of runs) {
    const reads = [
      { method: "GET", host: "api.test", path: "/api/v1/agent/wallets/trading", query: "", auth: "api-key" },
      { method: "GET", host: "api.test", path: "/api/v1/agent/perps/overview/activity", query: "?walletId=wallet", auth: "api-key" },
    ]
    expect(r.outcome.cli.requests).toEqual(reads)
    expect(r.outcome.mcp.requests).toEqual(reads)
    // The SDK is given the wallet id, so it makes only the activity read.
    expect(r.outcome.sdk.requests).toEqual([reads[1]])
    expect(r.outcome.cli.exitCode).toBe(0)
    expect(r.outcome.cli.humanExit).toBe(0)
    expect(r.outcome.mcp.isError).toBe(false)
    expect(r.outcome.sameAnswer).toBe(true)
  }
  const both = row("activity-orders-on-two-dexes-and-a-withdrawal").outcome
  expect(both.openOrders.map((o: any) => [o.coin, o.dex])).toEqual([["BTC", null], ["xyz:TSLA", "xyz"]])
  expect(both.cli.lines).toContain("Dex default")
  expect(both.cli.lines).toContain("Dex xyz")
  expect(both.cli.lines).toContain("Amount 25 USDC")
  // A failed read is null and says "not read", never an empty list that would read as "nothing open".
  const failed = row("activity-both-reads-failed").outcome
  expect([failed.openOrders, failed.withdrawalsInFlight]).toEqual([null, null])
  expect(failed.cli.lines).toEqual(["Wallet wallet", "Network mainnet", "Open orders not read", "Withdrawals in flight not read"])
  expect(row("activity-nothing-resting").outcome.cli.lines).toEqual(["Wallet wallet", "Network mainnet", "Open orders none", "Withdrawals in flight none"])
  expect(row("activity-mcp-without-a-key").outcome).toEqual({ isError: true, code: "MCP_VALIDATION" })
})

test("the Candle Harness treats the activity read as a read, and another key's thresholds as the owner's", () => {
  expect(TOOL_CLASSES.candle_perps_activity).toEqual({ class: "read" })
  for (const mode of ["live", "paper"] as const) expect(classify("candle_perps_activity", {}, mode)).toEqual({ class: "read" })
  expect(rowFor("perps activity")).toMatchObject({ rule: "mcp", route: "cli", identity: "agent", mcpTool: "candle_perps_activity" })
  const activity = resolveCall({ command: "perps", subcommand: "activity", args: ["--wallet", "perps"] }, ctx)
  expect(activity.ok && activity.call.rule).toBe("mcp")
  // The key's own thresholds stay Candle's MCP read; another key's, with its stored perps limits, needs the owner's device token.
  for (const args of [[], ["--key", "self"]]) {
    const own = resolveCall({ command: "perps", subcommand: "thresholds", args }, ctx)
    expect(own.ok && { rule: own.call.rule, route: own.call.route }).toEqual({ rule: "mcp", route: "cli" })
  }
  for (const key of ["abcd1234", "trading-bot"]) {
    const other = resolveCall({ command: "perps", subcommand: "thresholds", args: ["--key", key] }, ctx)
    expect(other.ok && { rule: other.call.rule, route: other.call.route }).toEqual({ rule: "owner", route: "later" })
  }
})
