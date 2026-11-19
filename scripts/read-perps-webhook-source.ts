// Offline perps position webhook contracts, and the perps wallet activity read, from an exact clean Candle source
// checkout, recorded by running Candle's own source against stand-ins:
//   1. the events an endpoint may register (packages/db/convex/lib/webhookPolicy.ts): the three position events sit
//      beside the three risk events, and a list naming them is accepted;
//   2. which event a fill is (apps/api/src/lib/perps-fill-events.ts): an open from flat, a close to exactly zero, a
//      liquidation of this wallet; an increase, a partial close, a flip and a liquidator's own fill are none;
//   3. the payload each carries (`candle.perps.position_event/1`, with the exchange's `fillTime`, `dex` for a builder
//      dex, `source: "ingest"`);
//   4. the emit (apps/api/src/lib/perps-fill-event-emit.ts) with a stand-in owner lookup and a stand-in enqueue: one
//      event per new fill and owner, nothing for an unlinked wallet, a re-ingest or a fill more than a day old;
//   5. one delivery each (apps/api/src/lib/webhook-delivery.ts, signed by apps/api/src/lib/webhook-signature.ts) to a
//      stand-in endpoint, then the SDK's own `verifyWebhookSignature` and `isPerpsPositionEventPayload` on what
//      arrived (a tampered body, a stale timestamp and a wrong secret fail);
//   6. what the docs page and the SDK changelog say about the events, as text;
//   7. the perps wallet activity read through `candle perps activity --json`, MCP `candle_perps_activity` and the
//      SDK's `perpsOverviewActivity()` against a stand-in API answer, failed lists (null) included.
// Every fetch, lookup and enqueue is a stand-in; no address, key, secret, signature or figure is real, and the made-up
// wallet's address is replaced by its role before a row is written.
//   bun scripts/read-perps-webhook-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-webhook-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "apps/api/src", "apps/docs", "packages")
const FILES = [
  "packages/db/convex/lib/webhookPolicy.ts",
  "apps/api/src/services/hyperliquid-reconciliation.ts",
  "apps/api/src/lib/perps-fill-events.ts",
  "apps/api/src/lib/perps-fill-event-emit.ts",
  "apps/api/src/lib/webhook-delivery.ts",
  "packages/sdk/src/webhooks.ts",
]
const DOCS = { webhooks: "apps/docs/src/content/docs/developers/webhooks.md", sdkChangelog: "packages/sdk/CHANGELOG.md" }
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: FILES,
}
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
// Resolve workspace imports back to this checkout, even when dependencies are shared locally.
Bun.plugin({ name: "perps-webhook-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candledottv\/mcp\/src\// }, ({ path }) => ({ path: join(checkout, "packages/mcp/src", path.split("/src/")[1]! + ".ts") }))
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
} })

// No real deployment is reachable from here: every fetch not answered by a stand-in is refused and named.
for (const name of ["CONVEX_URL", "CONVEX_SITE_URL", "API_DATABASE_URL", "LEDGER_TEST_DATABASE_URL", "CANDLE_API_KEY", "CANDLE_AGENT_API_KEY"]) delete process.env[name]
const network: string[] = []
const refuse = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  network.push(url.host)
  throw new Error(`perps-webhook recording may not access the network (${url.host})`)
}) as unknown as typeof fetch
globalThis.fetch = refuse
const originalWarn = console.warn
const originalError = console.error
console.warn = () => {}
console.error = () => {}

// Made-up stand-ins; rows name them by role only. The recorder asserts none survives into a row.
const WALLET = `0x${"ab1e".repeat(10)}`
const OTHER = `0x${"0dd5".repeat(10)}`
const OWNER = `0x${"5a1e".repeat(10)}`
const OWNER_2 = `0x${"5a2e".repeat(10)}`
const HASH = `0x${"f1".repeat(32)}`
const SECRET = "fixture-only-not-a-webhook-secret"
const API_KEY = "fixture-only-not-a-key"
const ROLES: Array<[string, string]> = [[WALLET, "<wallet>"], [OTHER, "<another wallet>"], [OWNER, "<owner>"], [OWNER_2, "<second owner>"], [HASH, "<fill hash>"]]
const scrub = (value: unknown): unknown => {
  if (typeof value === "string") {
    let out = value
    for (const [real, role] of ROLES) out = out.split(real).join(role).split(real.toLowerCase()).join(role)
    return out
  }
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
  return value
}
const T = Date.parse("2026-11-17T12:00:00Z")

type Row = { id: string; scenario: string; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []
const push = (row: Row) => rows.push(scrub(row) as Row)

const policy = await load(FILES[0]!)
const { parsePerpFill } = await load(FILES[1]!)
const { perpsFillEventName, perpsFillEventPayload, PERPS_FILL_EVENT_MAX_AGE_MS } = await load(FILES[2]!)
const { emitPerpsFillEvents } = await load(FILES[3]!)
const { deliverOne } = await load(FILES[4]!)
const sdkHooks = await load(FILES[5]!)
const POSITION_EVENTS = ["perps.position_opened", "perps.position_closed", "perps.liquidated"]

// 1. What an endpoint may register.
{
  const events = [...policy.WEBHOOK_EVENTS] as string[]
  push({ id: "policy-perps-events", scenario: "policy", args: { file: FILES[0]! }, outcome: { perps: events.filter((e) => e.startsWith("perps.")), total: events.length } })
  const lists: Array<[string, unknown]> = [
    ["the-three-position-events", POSITION_EVENTS],
    ["position-and-risk-events", ["perps.risk_critical", ...POSITION_EVENTS]],
    ["an-unknown-perps-event", ["perps.position_flipped"]],
  ]
  for (const [id, list] of lists) {
    const verdict = policy.validateEventList(list)
    push({ id: `policy-register-${id}`, scenario: "policy", args: { events: list }, outcome: verdict.ok ? { ok: true, events: verdict.events } : { ok: false } })
  }
  assert.deepEqual([...sdkHooks.PERPS_POSITION_EVENT_NAMES], POSITION_EVENTS, "the SDK's event names differ from the policy's")
  for (const e of POSITION_EVENTS) assert.ok(events.includes(e), `${e} is not registrable`)
  push({ id: "sdk-event-names-match-policy", scenario: "policy", args: { file: FILES[5]! }, outcome: { sdk: [...sdkHooks.PERPS_POSITION_EVENT_NAMES], allRegistrable: true } })
}

// 2 and 3. Which event a fill is, and what it carries.
const fill = (over: Record<string, unknown>) => parsePerpFill({
  coin: "BTC", tid: 1, time: T, side: "B", px: "100000", sz: "0.5", startPosition: "0", dir: "Open Long", closedPnl: "0",
  fee: "1.5", feeToken: "USDC", hash: HASH, oid: 7, crossed: true, ...over,
})
const liq = (user: string) => ({ liquidatedUser: user, markPx: "90000", method: "market" })
const FILLS: Array<[string, Record<string, unknown>, string]> = [
  ["open-long-from-flat", {}, WALLET],
  ["open-short-from-flat", { side: "A", dir: "Open Short" }, WALLET],
  ["add-to-a-long", { startPosition: "0.5" }, WALLET],
  ["partial-close-of-a-long", { side: "A", dir: "Close Long", startPosition: "1", closedPnl: "250" }, WALLET],
  ["full-close-of-a-long", { tid: 2, side: "A", dir: "Close Long", startPosition: "0.5", closedPnl: "500.25" }, WALLET],
  ["full-close-of-a-short", { tid: 3, side: "B", dir: "Close Short", startPosition: "-0.5", closedPnl: "-120.5" }, WALLET],
  ["flip-long-to-short", { side: "A", dir: "Long > Short", startPosition: "0.25" }, WALLET],
  ["builder-dex-open", { coin: "xyz:TSLA", tid: 4, px: "250", sz: "4", feeToken: "USDC" }, WALLET],
  ["builder-dex-full-close", { coin: "xyz:TSLA", tid: 5, px: "260", sz: "4", side: "A", dir: "Close Long", startPosition: "4", closedPnl: "40" }, WALLET],
  ["liquidation-of-this-wallet", { tid: 6, side: "A", dir: "Liquidated Cross Long", startPosition: "0.5", px: "89990", closedPnl: "-5000", liquidation: liq(WALLET.toLowerCase()) }, WALLET],
  ["liquidation-address-case-differs", { tid: 7, side: "A", dir: "Liquidated Cross Long", startPosition: "0.5", liquidation: liq(WALLET.toUpperCase().replace("0X", "0x")) }, WALLET],
  ["liquidators-own-fill", { tid: 8, side: "B", dir: "Open Long", startPosition: "0", liquidation: liq(OTHER.toLowerCase()) }, WALLET],
  ["builder-dex-liquidation", { coin: "xyz:TSLA", tid: 9, px: "200", sz: "4", side: "A", dir: "Liquidated Isolated Long", startPosition: "4", liquidation: liq(WALLET.toLowerCase()) }, WALLET],
]
const payloads: Record<string, Record<string, unknown>> = {}
for (const [id, over, wallet] of FILLS) {
  const f = fill(over)
  const event = perpsFillEventName(f, wallet)
  push({ id: `event-${id}`, scenario: "event", args: { coin: f.coin, dir: f.raw.dir, side: f.side, startPosition: f.startPosition, size: f.sz, liquidation: f.raw.liquidation ? "present" : "none" }, outcome: { event } })
  if (!event) continue
  const payload = perpsFillEventPayload(event, f, wallet, "mainnet") as Record<string, unknown>
  assert.equal(payload.address, wallet, "the payload names another wallet")
  assert.equal(payload.fillTime, new Date(T).toISOString(), "the payload's fillTime is not the fill's time")
  payloads[id] = payload
  push({ id: `payload-${id}`, scenario: "payload", args: { event }, outcome: { payload, sdkAccepts: sdkHooks.isPerpsPositionEventPayload(payload) } })
}
{
  const risk = { schema: "candle.perps.risk_event/1", level: "critical", previous: "warn" }
  const notIngest = { ...payloads["full-close-of-a-long"], source: "monitor" }
  const unknown = { ...payloads["full-close-of-a-long"], event: "perps.position_flipped" }
  push({ id: "sdk-guard-refuses-other-shapes", scenario: "payload", args: { cases: ["risk-event", "source-not-ingest", "unknown-event", "null", "string"] }, outcome: {
    riskEvent: sdkHooks.isPerpsPositionEventPayload(risk), sourceNotIngest: sdkHooks.isPerpsPositionEventPayload(notIngest),
    unknownEvent: sdkHooks.isPerpsPositionEventPayload(unknown), null: sdkHooks.isPerpsPositionEventPayload(null), string: sdkHooks.isPerpsPositionEventPayload("perps.liquidated"),
  } })
  push({ id: "max-age", scenario: "emit", args: { name: "PERPS_FILL_EVENT_MAX_AGE_MS" }, outcome: { ms: PERPS_FILL_EVENT_MAX_AGE_MS, hours: PERPS_FILL_EVENT_MAX_AGE_MS / 3_600_000 } })
}

// 4. The emit, with a stand-in owner lookup (the ledger's linked wallets) and a stand-in enqueue.
{
  const run = async (id: string, owners: string[], fills: Record<string, unknown>[], now: number) => {
    const queries: string[] = []
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(strings.join("?").replace(/\s+/g, " ").trim())
      assert.deepEqual(values, [WALLET.toLowerCase()], "the owner lookup asks for another wallet")
      return owners.map((account) => ({ account }))
    }) as unknown
    const enqueued: Array<{ owner: string; event: string; fillId: unknown; fillTime: unknown }> = []
    const emit = (owner: string, event: string, payload: Record<string, unknown>) => void enqueued.push({ owner, event, fillId: payload.fillId, fillTime: payload.fillTime })
    const sent = await emitPerpsFillEvents(sql, "mainnet", WALLET, fills.map((f) => fill(f)), { now, emit })
    assert.equal(sent, enqueued.length)
    push({ id: `emit-${id}`, scenario: "emit", args: { owners: owners.length, fills: fills.length, hoursAfterFill: (now - T) / 3_600_000 }, outcome: { sent, enqueued, ownerLookups: queries.length, ...(queries[0] ? { lookup: queries[0] } : {}) } })
  }
  const byId = Object.fromEntries(FILLS.map(([id, over]) => [id, over]))
  const hour = 3_600_000
  await run("open-and-close-one-owner", [OWNER], [byId["open-long-from-flat"]!, byId["full-close-of-a-long"]!], T + hour)
  await run("two-hours-late-still-sent", [OWNER], [byId["full-close-of-a-short"]!], T + 2 * hour)
  await run("liquidation-two-owners", [OWNER, OWNER_2], [byId["liquidation-of-this-wallet"]!], T + hour)
  await run("increase-and-partial-close-send-nothing", [OWNER], [byId["add-to-a-long"]!, byId["partial-close-of-a-long"]!], T + hour)
  await run("unlinked-wallet-nobody-to-tell", [], [byId["full-close-of-a-long"]!], T + hour)
  await run("re-ingest-inserts-no-fill", [OWNER], [], T + hour)
  await run("fill-23-hours-old", [OWNER], [byId["full-close-of-a-long"]!], T + 23 * hour)
  await run("fill-25-hours-old-is-history", [OWNER], [byId["full-close-of-a-long"]!], T + 25 * hour)
  await run("first-scan-days-back", [OWNER], [byId["open-long-from-flat"]!, byId["builder-dex-full-close"]!], T + 72 * hour)
}

// 5. One delivery each, signed by Candle's delivery code, then verified by the SDK's own code.
{
  const deliveredAt = T + 2 * 3_600_000
  for (const id of ["open-long-from-flat", "full-close-of-a-long", "builder-dex-full-close", "liquidation-of-this-wallet"]) {
    const payload = payloads[id]!
    let seen: { headers: Record<string, string>; body: string } | undefined
    const result = await deliverOne(
      { deliveryId: `fixture-delivery-${id}`, eventId: `fixture-event-${id}`, event: payload.event, payload, url: "https://hooks.fixture.test/candle", secret: SECRET, attempts: 0, createdAt: deliveredAt - 1000, endpointRevoked: false },
      {
        now: () => deliveredAt,
        assertUrl: async () => ({ url: "https://hooks.fixture.test/candle", address: "192.0.2.10", family: 4 }),
        fetch: async (_target: unknown, init: { headers: Record<string, string>; body: string }) => {
          seen = { headers: init.headers, body: init.body }
          return new Response(null, { status: 204 })
        },
      },
    )
    assert.ok(seen, "nothing was delivered")
    const header = seen.headers["x-candle-signature"]!
    const nowSec = Math.floor(deliveredAt / 1000)
    const body = JSON.parse(seen.body) as Record<string, unknown>
    const shape = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
    assert.ok(shape, "the signature header is not t=<seconds>,v1=<64 hex>")
    const verify = sdkHooks.verifyWebhookSignature
    const outcome = {
      result,
      headers: { "content-type": seen.headers["content-type"], "x-candle-event": seen.headers["x-candle-event"], "x-candle-delivery": seen.headers["x-candle-delivery"], "x-candle-signature": "t=<seconds>,v1=<64 hex>" },
      signatureTimestampIsDeliveryTime: Number(shape[1]) === nowSec,
      envelope: { keys: Object.keys(body), event: body.event, createdAtIsDeliveryTime: body.createdAt === deliveredAt },
      data: body.data,
      sdk: {
        verifies: verify(SECRET, header, seen.body, nowSec),
        verifiesFourMinutesLater: verify(SECRET, header, seen.body, nowSec + 240),
        refusesSixMinutesLater: !verify(SECRET, header, seen.body, nowSec + 360),
        refusesATamperedBody: !verify(SECRET, header, seen.body.replace(/"fillTime":"[^"]+"/, '"fillTime":"2026-11-17T12:00:01.000Z"'), nowSec),
        refusesAnotherSecret: !verify(`${SECRET}-other`, header, seen.body, nowSec),
        refusesNoHeader: !verify(SECRET, undefined, seen.body, nowSec),
        acceptsThePayload: sdkHooks.isPerpsPositionEventPayload(body.data),
      },
    }
    assert.ok(Object.values(outcome.sdk).every((v) => v === true), `${id}: the SDK disagrees with Candle's delivery`)
    assert.deepEqual(body.data, payload, `${id}: the delivered data differs from the payload`)
    push({ id: `deliver-${id}`, scenario: "deliver", args: { event: payload.event, secret: "<fixture secret>" }, outcome })
  }
}

// 6. What the docs and the SDK changelog say.
{
  const docs = text(DOCS.webhooks)
  const docRows = docs.split("\n").filter((l) => /^\| `perps\.(position_opened|position_closed|liquidated)` \|/.test(l))
  assert.equal(docRows.length, 3, "the webhooks page does not list the three events")
  const lag = docs.split("\n").find((l) => l.startsWith("The three `perps.position_*` / `perps.liquidated` events"))
  assert.ok(lag, "the webhooks page's lateness paragraph is missing")
  push({ id: "docs-webhooks-rows", scenario: "docs", args: { file: DOCS.webhooks }, outcome: { rows: docRows } })
  push({ id: "docs-webhooks-lateness", scenario: "docs", args: { file: DOCS.webhooks }, outcome: { text: lag } })
  const changelog = text(DOCS.sdkChangelog).split("\n").find((l) => l.startsWith(`Release ${source.versions.sdk} `))
  assert.ok(changelog, "the SDK changelog has no entry for this version")
  push({ id: "sdk-changelog-entry", scenario: "docs", args: { file: DOCS.sdkChangelog }, outcome: { text: changelog } })
}

// 7. The perps wallet activity read through the CLI, MCP and the SDK, on the same stand-in answers.
{
  const ACTIVITY_PATH = "/api/v1/agent/perps/overview/activity"
  const cfg = { apiUrl: "https://api.test", apiKey: API_KEY }
  const walletsAnswer = { scopes: ["account:read"], privyAppId: "fixture-app", page: [{ id: "wallet", address: WALLET, label: "perps", chain: "evm", active: true, allowLaunch: false, privyWalletId: "fixture-privy" }], isDone: true }
  const orders = [
    { coin: "BTC", dex: null, side: "buy", price: "95000", size: "0.1", originalSize: "0.1", reduceOnly: false, type: "Limit", trigger: null, placedAt: T },
    { coin: "xyz:TSLA", dex: "xyz", side: "sell", price: "300", size: "2", originalSize: "4", reduceOnly: true, type: "Take Profit Limit", trigger: "Price above 295", placedAt: T + 60_000 },
  ]
  const withdrawals = [{ id: "fixture-withdrawal", status: "submitted", to: "<own solana tee>", amountUsdcMicros: 25_000_000, createdAt: T }]
  const answers: Array<[string, Record<string, unknown>]> = [
    ["orders-on-two-dexes-and-a-withdrawal", { openOrders: orders, withdrawalsInFlight: withdrawals }],
    ["nothing-resting", { openOrders: [], withdrawalsInFlight: [] }],
    ["both-reads-failed", { openOrders: null, withdrawalsInFlight: null }],
  ]
  type Req = { method: string; host: string; path: string; query: string; auth: string }
  const standIn = (answer: Record<string, unknown>, requests: Req[]) => async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const auth = headers.get("x-api-key") === API_KEY || headers.get("authorization") === `Bearer ${API_KEY}` ? "api-key" : headers.get("authorization") ? "other" : "none"
    requests.push({ method: init?.method ?? "GET", host: u.host, path: u.pathname, query: u.search, auth })
    if (u.host !== "api.test") throw new Error(`unexpected host ${u.host}`)
    if (u.pathname === "/api/v1/agent/wallets/trading") return Response.json(walletsAnswer)
    if (u.pathname === ACTIVITY_PATH) return Response.json({ success: true, schema: "candle.perps.overview_activity/1", walletId: "wallet", network: "mainnet", ...answer })
    throw new Error(`unexpected request ${u.pathname}`)
  }
  const cli = await load("packages/cli/src/commands/perps.ts")
  const { createCapture, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const { executePerps } = await load("packages/mcp/src/perps.ts")
  const { CandleClient } = await load("packages/sdk/src/index.ts")
  for (const [id, answer] of answers) {
    const cliRequests: Req[] = []
    const stdout = createCapture(), stderr = createCapture()
    const deps = createTestDeps({ stdout, stderr, now: () => T, fetch: standIn(answer, cliRequests), env: { CANDLE_API_KEY: API_KEY } })
    const exitCode = await cli.perpsActivity(["--wallet", "perps"], { deps, apiUrl: cfg.apiUrl, json: true })
    const human = createCapture(), humanErr = createCapture()
    const humanExit = await cli.perpsActivity(["--wallet", "perps"], { deps: createTestDeps({ stdout: human, stderr: humanErr, now: () => T, fetch: standIn(answer, []), env: { CANDLE_API_KEY: API_KEY } }), apiUrl: cfg.apiUrl, json: false })
    const cliBody = JSON.parse(stdout.text)
    const mcpRequests: Req[] = []
    const m = await executePerps("candle_perps_activity", { wallet: "perps" }, cfg, {}, standIn(answer, mcpRequests))
    const mcpBody = JSON.parse(m.text)
    const sdkRequests: Req[] = []
    const sdkBody = await new CandleClient({ ...cfg, fetch: standIn(answer, sdkRequests), maxRetries: 0 }).perpsOverviewActivity("wallet")
    assert.deepEqual(mcpBody, sdkBody, `${id}: MCP and the SDK disagree`)
    for (const list of ["openOrders", "withdrawalsInFlight"]) {
      assert.deepEqual(mcpBody[list], answer[list], `${id}: MCP changed ${list}`)
      assert.deepEqual(list in cliBody ? cliBody[list] : cliBody.data?.[list], answer[list], `${id}: the CLI changed ${list}`)
    }
    const lines = human.text.split("\n").map((l: string) => l.replace(/\u001b\[[0-9;]*m/g, "").trim().replace(/\s+/g, " ")).filter((l: string) => /^(Wallet|Network|Open orders|Coin|Dex|Side|Size|Price|Reduce only|Withdrawals in flight|Withdrawal|Status|Amount|To)\b/.test(l))
    push({ id: `activity-${id}`, scenario: "activity", args: { wallet: "<tee label>", answer: Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, v === null ? null : (v as unknown[]).length])) }, outcome: {
      cli: { exitCode, humanExit, requests: cliRequests, lines },
      mcp: { isError: m.isError === true, requests: mcpRequests },
      sdk: { requests: sdkRequests },
      sameAnswer: true,
      openOrders: mcpBody.openOrders,
      withdrawalsInFlight: mcpBody.withdrawalsInFlight,
    } })
  }
  const noKey = await executePerps("candle_perps_activity", {}, { apiUrl: cfg.apiUrl }, {}, refuse)
  push({ id: "activity-mcp-without-a-key", scenario: "activity", args: { apiKey: "none" }, outcome: { isError: noKey.isError === true, code: JSON.parse(noKey.text).error?.code } })
}

console.warn = originalWarn
console.error = originalError
assert.deepEqual(network, [], `the recording reached for ${network.join(", ")}`)
const textOut = JSON.stringify(rows).toLowerCase()
for (const secret of [WALLET, OTHER, OWNER, OWNER_2, HASH, SECRET, API_KEY]) assert.ok(!textOut.includes(secret.toLowerCase()), `a fixture carries ${secret.slice(0, 6)}`)
writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-webhook-source.json"), `${JSON.stringify({
  about: "Offline perps position webhook contracts and the perps wallet activity read, from exact merged source: the events an endpoint may register, which event a fill is (open from flat, close to zero, liquidation of this wallet), the `candle.perps.position_event/1` payload with the exchange's fillTime, the emit with a stand-in owner lookup and enqueue (one per new fill and owner, nothing for a re-ingest, an unlinked wallet or a fill more than a day old), one signed delivery each to a stand-in endpoint verified by the SDK's own code, the docs and changelog text, and `candle perps activity`, `candle_perps_activity` and `perpsOverviewActivity()` on the same stand-in answers. Every fetch, lookup and enqueue is a stand-in; made-up addresses are replaced by their role.",
  source, rows,
}, null, 2)}\n`)
console.log(`Recorded ${rows.length} offline perps webhook and activity contracts from ${source.commit}.`)
process.exit(0)
