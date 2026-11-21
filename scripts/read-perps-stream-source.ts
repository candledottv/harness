// Offline perps activity-stream contracts (BE-3769) from an exact clean Candle source checkout: what a perps fill
// sends to Candle's public activity stream (the site banner's and the Discord announcer's feed), and the `hide` flag
// on perps orders, recorded by running the API's own source against stand-ins.
//   1. the one eligibility rule (apps/api/src/lib/stream-eligibility.ts): a perps event follows the trade rule
//      exactly (a published agent's key, never a hidden order; the AGENT_TRADES_IN_STREAM_ENABLED switch is gone at this commit, BE-3970), case by
//      case beside a `buy` given the same facts;
//   2. the event kind (apps/api/src/lib/perps-stream.ts): open, add, reduce, close, read from the position's size
//      before and after the fill, a flip through zero being an open;
//   3. one fill announced end to end: announcePerpFill reads a stand-in venue, broadcastActivity runs the rule with
//      a stand-in published-agent lookup, and the recorder subscribes to the stream and keeps what left on the wire
//      (or that nothing did);
//   4. the fills summary the settle path prices an increase from (volume-weighted price, size, P&L, time);
//   5. `hide` as the perps routes parse it (parseHide), and the route, settle and schema facts that have no process
//      to run here (behind auth, Convex and the database), pinned as source text from the same commit;
//   6. what Candle's CLI, MCP server and SDK carry for perps `hide` at that commit.
// Every venue read, lookup and fetch is a stand-in; no address, key, signature or figure is real.
//   bun scripts/read-perps-stream-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-stream-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "apps/api/src", "packages")
const FILES = [
  "apps/api/src/lib/stream-eligibility.ts",
  "apps/api/src/lib/perps-stream.ts",
  "apps/api/src/lib/activity-broadcast.ts",
  "apps/api/src/lib/agent-hide.ts",
  "apps/api/src/routes/agent-perps.ts",
  "apps/api/src/lib/perps-reconcile.ts",
  "packages/db/convex/perpOrders.ts",
  "packages/db/convex/schema.ts",
]
const CLIENT_FILES = {
  cli: "packages/cli/src/commands/perps.ts",
  mcp: "packages/mcp/src/perps.ts",
  mcpManage: "packages/mcp/src/hyperliquid-manage.ts",
  sdk: "packages/sdk/src/client.ts",
  sdkManage: "packages/sdk/src/hyperliquid-manage.ts",
}
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: FILES,
}
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)

// No real deployment is reachable from here: every fetch is refused and named, and the stores are unset.
for (const name of ["CONVEX_URL", "CONVEX_SITE_URL", "API_DATABASE_URL", "LEDGER_TEST_DATABASE_URL"]) delete process.env[name]
const network: string[] = []
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  network.push(url.host)
  throw new Error(`perps-stream recording may not access the network (${url.host})`)
}) as unknown as typeof fetch
const originalWarn = console.warn
const originalError = console.error
console.warn = () => {}
console.error = () => {}

const eligibility = await load(FILES[0]!)
const { PERP_STREAM_TYPES, isStreamEligible, needsAgentName, streamPayload } = eligibility
const stream = await load(FILES[1]!)
const { perpEventType, perpEventPayload, announcePerpFill, summarizeFills } = stream
const broadcast = await load(FILES[2]!)
const { activityBroadcaster, __setStreamDepsForTest } = broadcast
const { parseHide } = await load(FILES[3]!)

// Made-up stand-ins; rows name them by role only. The recorder asserts none survives into a row.
const OWNER = `0x${"5a1e".repeat(10)}`
const VENUE_WALLET = `0x${"be7a".repeat(10)}`
const KEY_PREFIX = "cndl_fx_7q2m"
const AGENT = "Fixture Agent"
const CLOID = `0x${"c1".repeat(16)}`

type Row = { id: string; scenario: string; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []

// 1. The one rule: perps types beside a trade, on the same facts.
{
  rows.push({ id: "perp-stream-types", scenario: "types", args: { file: FILES[0]! }, outcome: { types: [...PERP_STREAM_TYPES] } })
  const published = { viaApiKey: true, keyPrefix: KEY_PREFIX, agentName: AGENT }
  const cases: Array<[string, Record<string, unknown>]> = [
    ["published-agent-key", published],
    ["hidden-order", { ...published, streamHidden: true }],
    ["private-agent-no-name", { ...published, agentName: undefined }],
    ["blank-agent-name", { ...published, agentName: "  " }],
    ["human-order-no-agent-key", { ...published, viaApiKey: false }],
    ["agent-key-missing", { ...published, keyPrefix: undefined }],
    ["agent-key-blank", { ...published, keyPrefix: " " }],
    ["via-api-key-not-boolean-true", { ...published, viaApiKey: "true" }],
  ]
  for (const [id, facts] of cases) {
    const perps = Object.fromEntries(PERP_STREAM_TYPES.map((type: string) => [type, isStreamEligible({ ...facts, type })]))
    const trade = isStreamEligible({ ...facts, type: "buy" })
    for (const v of Object.values(perps)) assert.equal(v, trade, `${id}: a perps event and a trade disagree`)
    rows.push({ id: `eligible-${id}`, scenario: "eligibility", args: { case: id }, outcome: { perps, buy: trade } })
  }
  const asksName = Object.fromEntries(PERP_STREAM_TYPES.map((type: string) => [type, { agentKey: needsAgentName(type, true), noAgentKey: needsAgentName(type, false) }]))
  rows.push({ id: "perp-events-ask-for-the-agent-name", scenario: "eligibility", args: { case: "needsAgentName" }, outcome: { asksName } })
}

// 2. The event kind from the position's signed size before and after the fill.
{
  const kinds: Array<[string, number, number]> = [
    ["flat-to-long", 0, 1.5], ["flat-to-short", 0, -2], ["long-grows", 1, 1.5], ["short-grows", -1, -3],
    ["long-shrinks", 2, 0.5], ["short-shrinks", -3, -1], ["long-to-flat", 1, 0], ["short-to-flat", -2, 0],
    ["long-flips-short", 1, -0.5], ["short-flips-long", -1, 2], ["dust-before-is-flat", 1e-12, 0.4], ["dust-after-is-flat", 0.4, 1e-12],
  ]
  for (const [id, before, after] of kinds) rows.push({ id: `kind-${id}`, scenario: "event-kind", args: { before, after }, outcome: { type: perpEventType(before, after) } })
}

// 3. One fill, end to end: venue read, rule, lookup, wire.
type Venue = { szi?: string | null; leverage?: number; activeLeverage?: number | "throw"; clearinghouse?: "throw" }
function venue(coin: string, v: Venue) {
  const reads: string[] = []
  const info = {
    network: "mainnet",
    clearinghouse: async (user: string) => {
      assert.equal(user, VENUE_WALLET)
      reads.push("clearinghouse")
      if (v.clearinghouse === "throw") throw new Error("stand-in venue refused the read")
      const assetPositions = v.szi == null ? [] : [{ position: { coin, szi: v.szi, leverage: { type: "cross", value: v.leverage ?? 10 } } }]
      return { assetPositions }
    },
    activeAssetData: async () => {
      reads.push("activeAssetData")
      if (v.activeLeverage === "throw") throw new Error("stand-in venue refused the read")
      return { leverage: { type: "cross", value: v.activeLeverage ?? 10 } }
    },
  }
  return { info, reads }
}
type Announce = {
  coin?: string; sizeDelta: number; isBuy: boolean; px: number; realizedPnlUsd?: number
  venue: Venue; hidden?: boolean; name?: string | null | "throw"; keyPrefix?: string
}
async function announce(id: string, a: Announce) {
  const coin = a.coin ?? "ETH"
  const wire: Record<string, unknown>[] = []
  const unsubscribe = activityBroadcaster.subscribe((data: string) => wire.push(JSON.parse(data)))
  const lookups: Array<{ owner: string; key: string }> = []
  __setStreamDepsForTest({
    agentNameForKey: async (owner: string, key: string) => {
      lookups.push({ owner: owner === OWNER ? "the order's owner" : "other", key: key === KEY_PREFIX ? "the order's key" : "other" })
      if (a.name === "throw") throw new Error("stand-in lookup failed")
      return a.name === undefined ? AGENT : a.name
    },
    launchFacts: async () => { throw new Error("a perps event never reads the launch ledger") },
  })
  const { info, reads } = venue(coin, a.venue)
  let threw = false
  try {
    await announcePerpFill({
      userAddress: OWNER, keyPrefix: a.keyPrefix ?? KEY_PREFIX, streamHidden: a.hidden === true, address: VENUE_WALLET, info, at: 1_790_000_000_000,
      fill: { coin, sizeDelta: a.sizeDelta, isBuy: a.isBuy, px: a.px, ...(a.realizedPnlUsd !== undefined ? { realizedPnlUsd: a.realizedPnlUsd } : {}) },
    })
  } catch {
    threw = true
  }
  unsubscribe()
  __setStreamDepsForTest(null)
  assert.ok(wire.length <= 1, `${id}: more than one line for one fill`)
  rows.push({
    id: `announce-${id}`, scenario: "announce",
    args: { coin, sizeDelta: a.sizeDelta, side: a.isBuy ? "buy" : "sell", px: a.px, ...(a.realizedPnlUsd !== undefined ? { realizedPnlUsd: a.realizedPnlUsd } : {}), positionAfter: a.venue.szi ?? null, hidden: a.hidden === true, agent: a.name === undefined ? "published" : a.name === null ? "private" : a.name === "throw" ? "lookup fails" : "published", ...(a.keyPrefix !== undefined ? { agentKey: a.keyPrefix.trim() === "" ? "blank" : "other" } : {}) },
    outcome: { sent: wire.length === 1, ...(wire[0] ? { wire: wire[0] } : {}), lookups, venueReads: reads, threw },
  })
}
await announce("open-long-from-flat", { sizeDelta: 1.5, isBuy: true, px: 3_000, venue: { szi: "1.5", leverage: 10 } })
await announce("open-short-from-flat", { coin: "BTC", sizeDelta: 0.25, isBuy: false, px: 60_000, venue: { szi: "-0.25", leverage: 20 } })
await announce("add-to-long", { sizeDelta: 0.5, isBuy: true, px: 3_100, venue: { szi: "2", leverage: 10 } })
await announce("reduce-long-keeps-no-pnl", { sizeDelta: 0.5, isBuy: false, px: 3_200, realizedPnlUsd: 87.654, venue: { szi: "1.5", leverage: 10 } })
await announce("close-long-carries-pnl", { sizeDelta: 1.5, isBuy: false, px: 3_300, realizedPnlUsd: 412.345, venue: { szi: null, activeLeverage: 10 } })
await announce("close-short-carries-a-loss", { coin: "BTC", sizeDelta: 0.25, isBuy: true, px: 61_000, realizedPnlUsd: -250.004, venue: { szi: null, activeLeverage: 20 } })
await announce("flip-long-to-short-is-an-open", { sizeDelta: 2, isBuy: false, px: 3_000, venue: { szi: "-0.5", leverage: 5 } })
await announce("builder-dex-coin", { coin: "xyz:XYZ100", sizeDelta: 3, isBuy: true, px: 41.237, venue: { szi: "3", leverage: 3 } })
await announce("close-leverage-unreadable-is-left-out", { sizeDelta: 1, isBuy: false, px: 3_000, venue: { szi: null, activeLeverage: "throw" } })
await announce("hidden-order-sends-nothing", { sizeDelta: 1.5, isBuy: true, px: 3_000, hidden: true, venue: { szi: "1.5" } })
await announce("private-agent-sends-nothing", { sizeDelta: 1.5, isBuy: true, px: 3_000, name: null, venue: { szi: "1.5" } })
await announce("lookup-failure-sends-nothing", { sizeDelta: 1.5, isBuy: true, px: 3_000, name: "throw", venue: { szi: "1.5" } })
await announce("blank-agent-key-sends-nothing", { sizeDelta: 1.5, isBuy: true, px: 3_000, keyPrefix: " ", venue: { szi: "1.5" } })
await announce("venue-read-failure-sends-nothing", { sizeDelta: 1.5, isBuy: true, px: 3_000, venue: { clearinghouse: "throw" } })
await announce("unreadable-size-sends-nothing", { sizeDelta: 1.5, isBuy: true, px: 3_000, venue: { szi: "not-a-number" } })

// The payload before the wire strip, and what the strip removes: no wallet, account or key on the wire.
{
  const built = perpEventPayload({ type: "perp_close", userAddress: OWNER, coin: "ETH", side: "long", leverage: null, notionalUsd: 4_950.006, realizedPnlUsd: 12.345, at: 1 })
  const shown = streamPayload({ ...built, agentName: AGENT, username: "fixture-member", profilePic: "p", keyPrefix: KEY_PREFIX, streamHidden: false, walletAddress: VENUE_WALLET })
  rows.push({ id: "payload-before-the-strip", scenario: "payload", args: { type: "perp_close", leverage: null }, outcome: { fields: Object.keys(built).sort(), carriesTheOwner: built.userAddress === OWNER, viaApiKey: built.viaApiKey, notionalUsd: built.notionalUsd, realizedPnlUsd: built.realizedPnlUsd, hasLeverage: "leverage" in built } })
  rows.push({ id: "payload-after-the-strip", scenario: "payload", args: { named: "agent" }, outcome: { fields: Object.keys(shown).sort() } })
  const open = perpEventPayload({ type: "perp_open", userAddress: OWNER, coin: "ETH", side: "long", leverage: 10, notionalUsd: 1, realizedPnlUsd: 5, at: 1 })
  rows.push({ id: "payload-pnl-only-on-a-close", scenario: "payload", args: { type: "perp_open", realizedPnlUsd: 5 }, outcome: { hasRealizedPnl: "realizedPnlUsd" in open } })
}

// 4. The fills summary the settle path prices an increase from.
{
  const fill = (cloid: string, px: string, sz: string, closedPnl: string, time: number) => ({ cloid, px, sz, closedPnl, time })
  const other = `0x${"d2".repeat(16)}`
  const cases: Array<[string, unknown[], string]> = [
    ["two-fills-volume-weighted", [fill(CLOID, "3000", "1", "10", 100), fill(CLOID, "3100", "3", "-4", 300)], CLOID],
    ["cloid-read-case-insensitively", [fill(CLOID.toUpperCase().replace("0X", "0x"), "50", "2", "0", 7)], CLOID],
    ["other-orders-ignored", [fill(other, "1", "100", "999", 900), fill(CLOID, "40", "1", "1.5", 5)], CLOID],
    ["zero-negative-and-unreadable-sizes-ignored", [fill(CLOID, "40", "0", "9", 1), fill(CLOID, "40", "-1", "9", 1), fill(CLOID, "x", "1", "9", 1), fill(CLOID, "40", "2", "x", 8)], CLOID],
    ["no-fill-for-the-order", [fill(other, "1", "1", "0", 1)], CLOID],
  ]
  for (const [id, fills, cloid] of cases) rows.push({ id: `fills-${id}`, scenario: "fills", args: { fills: fills.length }, outcome: { summary: summarizeFills(fills, cloid) } })
}

// 5. `hide` as the perps routes parse it.
{
  const values: Array<[string, unknown]> = [
    ["true", true], ["string-true", "true"], ["1", 1], ["string-1", "1"],
    ["false", false], ["string-false", "false"], ["0", 0], ["string-0", "0"], ["absent", undefined], ["null", null],
    ["string-yes", "yes"], ["2", 2], ["string-upper-true", "TRUE"], ["object", {}],
  ]
  for (const [id, raw] of values) rows.push({ id: `hide-parse-${id}`, scenario: "hide-parse", args: { value: raw === undefined ? "absent" : raw }, outcome: parseHide(raw) })
}

// Source facts at the pinned commit: the routes, the settle claim and the schema, which have no process here.
const perpsRoute = text(FILES[4]!)
const hideLib = text(FILES[3]!)
const reconcile = text(FILES[5]!)
const perpOrders = text(FILES[6]!)
const schema = text(FILES[7]!)
const broadcastSrc = text(FILES[2]!)
const flags = text("apps/api/src/config/flags.ts")
const pin = (id: string, file: string, found: boolean) => {
  assert.ok(found, `${id} (${file})`)
  rows.push({ id, scenario: "source-pin", args: { file }, outcome: { found } })
}
const handler = (path: string) => {
  const start = perpsRoute.indexOf(`perps.post("/${path}", requireAgentKey("perps:write")`)
  const end = perpsRoute.indexOf("perps.post(", start + 10)
  return start < 0 ? "" : perpsRoute.slice(start, end < 0 ? undefined : end)
}
pin("perp-hide-is-parse-hide-or-a-400", FILES[4]!, /function perpHide\([^)]*\): boolean \{\s*const parsed = parseHide\(body\.hide\)\s*if \(!parsed\.ok\) throw new PerpsError\("VALIDATION_FAILED", parsed\.message, 400, \{ limit: "hide" \}\)/.test(perpsRoute))
for (const route of ["open", "close", "modify", "tpsl"]) {
  const h = handler(route)
  pin(`${route}-parses-hide-before-building`, FILES[4]!, /const body = await jsonBody\(c\)\s*const hide = perpHide\(body\)/.test(h))
  pin(`${route}-stores-and-echoes-hide`, FILES[4]!, (route === "modify" ? /\.\.\.\(streamHidden \? \{ streamHidden: true \} : \{\}\)[\s\S]*return c\.json\(echoPerpHide\(built, streamHidden\)\)/ : /\.\.\.\(hide \? \{ streamHidden: true \} : \{\}\)[\s\S]*return c\.json\(echoPerpHide\(built, hide\)\)/).test(h))
}
pin("open-and-close-fingerprint-carries-hide", FILES[4]!, ["open", "close"].every((r) => /clientIntentOf\(clientId, \{\s*\.\.\.\(hide \? \{ hide: true \} : \{\}\),/.test(handler(r))))
pin("modify-of-a-hidden-order-stays-hidden", FILES[4]!, /const streamHidden = hide \|\| row\.streamHidden === true/.test(handler("modify")))
pin("replay-answers-the-stored-flag", FILES[4]!, /\.\.\.\(row\.streamHidden === true \? \{ hide: true as const \} : \{\}\)/.test(perpsRoute))
pin("echo-only-when-hidden", FILES[4]!, /return hide \? \{ \.\.\.built, hide: true \} : built/.test(perpsRoute))
pin("row-stores-stream-hidden", FILES[4]!, /\.\.\.\(spec\.streamHidden \? \{ streamHidden: true \} : \{\}\)/.test(perpsRoute))
// Code, not comments: a line that is a comment (`//`, `*`) is left out before looking for a read of the switch.
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")
pin("hide-has-no-switch-in-the-route", FILES[4]!, !/AGENT_HIDE_ENABLED/.test(code(perpsRoute)) && !/AGENT_HIDE_ENABLED/.test(code(hideLib)) && !/AGENT_HIDE_ENABLED/.test(code(flags)))
pin("hide-switch-deleted-in-flags", "apps/api/src/config/flags.ts", /\/\/ AGENT_HIDE_ENABLED: deleted on BE-3734/.test(flags))
pin("settle-claims-each-increase-once", FILES[6]!, /const stream =\s*filledNow !== null && filledNow > announced[\s\S]{0,200}?await ctx\.db\.patch\(row\._id, \{\s*\.\.\.\(stream \? \{ streamedSz: stream\.toSz \} : \{\}\),/.test(perpOrders))
pin("reconcile-announces-only-the-claim", FILES[5]!, /if \(result\?\.ok && result\.stream\) await announceSettledFill\(info, args\.address, row, result\.stream, now\)/.test(reconcile))
pin("reconcile-announces-order-kinds-only", FILES[5]!, /if \(!\["open", "close", "modify", "tpsl"\]\.includes\(row\.kind\) \|\| !row\.coin\) return/.test(reconcile))
pin("reconcile-passes-the-rows-hide", FILES[5]!, /streamHidden: row\.streamHidden === true,/.test(reconcile))
pin("schema-perp-orders-stream-fields", FILES[7]!, /streamHidden: v\.optional\(v\.boolean\(\)\),\s*streamedSz: v\.optional\(v\.string\(\)\),/.test(schema))
pin("perps-agent-named-from-the-key-not-the-payload", FILES[2]!, /PERP_STREAM_TYPES as readonly string\[\]\)\.includes\(type\)[\s\S]{0,700}?streamDeps\.agentNameForKey\(userAddress, keyPrefix\)/.test(broadcastSrc))
pin("no-liquidation-emitter-yet", FILES[1]!, !/perp_liquidation"\s*[,)]/.test(text(FILES[1]!).replace(/Exclude<PerpStreamType, "perp_liquidation">/, "")) && !/type: "perp_liquidation"/.test(reconcile))

// 6. The clients at this commit: the perps orders take `hide` (BE-3996); scripts/read-perps-hide-source.ts records them.
{
  const cli = text(CLIENT_FILES.cli)
  const sdk = text(CLIENT_FILES.sdk)
  const sdkParams = sdk.slice(sdk.indexOf("export interface PerpsOpenParams"), sdk.indexOf("export interface PerpsLeverageParams"))
  const tpsl = (file: string) => { const t = text(file); const s = t.indexOf("export interface PerpsTpslParams"); return t.slice(s, t.indexOf("\n}\n", s)) }
  const facts = {
    cliPerpsTakesHide: /--hide/.test(cli),
    mcpPerpsTakesHide: /\bhide\b/.test(text(CLIENT_FILES.mcp)),
    mcpManageTakesHide: /\bhide\b/.test(text(CLIENT_FILES.mcpManage)),
    sdkOpenCloseModifyTakeHide: /\bhide\b/.test(sdkParams),
    sdkTpslTakesHide: /\bhide\b/.test(tpsl(CLIENT_FILES.sdkManage)),
  }
  assert.ok(sdkParams.includes("PerpsCloseParams") && sdkParams.includes("PerpsModifyParams"), "SDK perps params not found")
  rows.push({ id: "clients-carry-perps-hide", scenario: "clients", args: { files: Object.values(CLIENT_FILES) }, outcome: facts })
}

console.warn = originalWarn
console.error = originalError
assert.deepEqual(network.filter((h) => h !== ""), [], `the recording reached for ${network.join(", ")}`)
const textOut = JSON.stringify(rows)
for (const secret of [OWNER, VENUE_WALLET, KEY_PREFIX, CLOID, "fixture-member"]) assert.ok(!textOut.toLowerCase().includes(secret.toLowerCase()), `a fixture carries ${secret.slice(0, 6)}`)
writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-stream-source.json"), `${JSON.stringify({
  about: "Offline perps activity-stream contracts (BE-3769): the one eligibility rule applied to perps events exactly as to a trade (a published agent's key, never a hidden order), the event kind from the position's size before and after a fill, one fill announced end to end through announcePerpFill and broadcastActivity onto a subscribed stream with stand-in venue reads and a stand-in published-agent lookup, the fills summary, and `hide` as the perps routes parse it. The routes, the settle claim and the schema are pinned as source text. Recorded from an exact staging commit with every fetch refused; at it the CLI, MCP and SDK perps orders take `hide` (BE-3996), and the switches that gated the stream and `hide` are gone (BE-3970).",
  source, rows,
}, null, 2)}\n`)
console.log(`Recorded ${rows.length} offline perps stream contracts from ${source.commit}.`)
process.exit(0)
