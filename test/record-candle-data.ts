// Records Candle's answers for the lists, P&L and perps reads, for the fake and the fixtures. It runs
// where there's no CLI, so it reads the REST routes Candle's MCP tools wrap (docs.candle.tv/developers/mcp-server's
// tools table), with the throwaway account's Read key, which can only read. Each recording names the MCP
// tool and arguments it stands for: the local server answers with the route's body unchanged (the
// recordings of candle_get_market and candle_get_portfolio are the REST bodies), so a body here is that
// tool's `result`.
//
//   bun test/record-candle-data.ts --agents agent-a=<prefix>,agent-b=<prefix> [--key-file PATH] [--out DIR] [--only feed,pnl,perps]
//
// The prefixes are the agents' key prefixes on the same account;
// they go only into the raw recordings, which are git-ignored, and the scrub replaces them. The key
// is sent only to Candle's production host as `x-api-key`, never printed, and redacted everywhere.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { apiKeyPrefix } from "../src/shared/api-key"
import { Redactor } from "../src/shared/redact"

const HOST = "https://api.alpha.candle.tv"

const { values: opts } = parseArgs({
  options: {
    "key-file": { type: "string", default: process.env.CANDLE_HARNESS_TEST_KEY_FILE },
    agents: { type: "string", default: "" },
    out: { type: "string" },
    only: { type: "string", default: "feed,pnl,perps" },
  },
})
const phases = new Set(opts.only!.split(","))
if (!opts["key-file"]) throw new Error("name the Read key's file: --key-file <path>, or CANDLE_HARNESS_TEST_KEY_FILE")
const key = readFileSync(opts["key-file"], "utf8").trim()
const ownPrefix = apiKeyPrefix(key)
if (!ownPrefix) throw new Error("the key file doesn't hold a Candle key")
const agents = opts
  .agents!.split(",")
  .filter(Boolean)
  .map((pair) => {
    const [label, prefix] = pair.split("=")
    if (!label || !prefix || !/^[A-Za-z0-9_-]{8}$/.test(prefix)) throw new Error(`--agents takes label=prefix pairs: "${pair}"`)
    return { label, prefix }
  })
const redactor = new Redactor()
redactor.add(key)
const out = resolve(opts.out ?? `test/fixtures/raw/candle-data-${new Date().toISOString().slice(0, 10)}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

export interface CandleDataRecording {
  name: string
  /** The MCP tool this route stands for, and its arguments. */
  tool: string
  args: Record<string, unknown>
  route: string
  query: Record<string, string>
  status: number | "timeout" | "error"
  ms: number
  bytes: number
  answer: unknown
}

function save(rec: CandleDataRecording) {
  writeFileSync(join(out, `${rec.name}.json`), `${JSON.stringify(redactor.value(rec), null, 2)}\n`, { mode: 0o600 })
  console.log(`${String(rec.status).padEnd(7)} ${String(rec.ms).padStart(6)} ms ${String(rec.bytes).padStart(8)} B  ${rec.name}`)
}

async function get(name: string, tool: string, args: Record<string, unknown>, route: string, query: Record<string, string> = {}): Promise<CandleDataRecording> {
  const url = new URL(route, HOST)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const started = performance.now()
  let rec: CandleDataRecording
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "x-api-key": key }, redirect: "error", signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    let answer: unknown = text
    try {
      answer = JSON.parse(text)
    } catch {}
    rec = { name, tool, args, route, query, status: res.status, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text), answer }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
    rec = { name, tool, args, route, query, status: timeout ? "timeout" : "error", ms: Math.round(performance.now() - started), bytes: 0, answer: String(e) }
  }
  save(rec)
  return rec
}

const BUCKETS = ["new", "graduated", "onfire", "finalstretch"] as const
// What the Trending panes would draw, asked for by name. `fields` refuses a name it doesn't know
// (`_creationTime` and `newSortAt`, though rows carry them), so the age is `createdAt`.
const PANE_FIELDS = "name,symbol,priceUsd,marketCap,change1h,change24h,volume1h,liquidityUsd,createdAt,graduatedAt,progress,lastTradeAt,launchedAt,holderCount"

function feed(name: string, args: Record<string, string | number>) {
  const query = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))
  return get(name, "candle_get_feed", args, "/api/v1/markets/feed", query)
}
const cursorOf = (rec: CandleDataRecording) => (rec.answer as { cursor?: unknown } | null)?.cursor

async function feeds() {
  const cursors: Record<string, string> = {}
  for (const bucket of BUCKETS) {
    const rec = await feed(`feed-${bucket}-fields`, { bucket, chain: "solana", fields: PANE_FIELDS, limit: 20 })
    const cursor = cursorOf(rec)
    if (typeof cursor === "string") cursors[bucket] = cursor
    await feed(`feed-${bucket}-all-fields`, { bucket, chain: "solana", limit: 20 })
    await feed(`feed-${bucket}-whole`, { bucket, chain: "solana" })
  }
  await feed("feed-new-unknown-field", { bucket: "new", chain: "solana", fields: "name,_creationTime", limit: 5 })
  await feed("feed-finalstretch-hood", { bucket: "finalstretch", chain: "hood", limit: 20 })
  await feed("feed-unknown-bucket", { bucket: "nosuchbucket", chain: "solana", limit: 5 })
  await feed("feed-limit-over", { bucket: "new", chain: "solana", limit: 201 })
  // Deltas, about 20 s later: what changed since each list's cursor.
  await Bun.sleep(20_000)
  for (const bucket of BUCKETS) {
    if (cursors[bucket]) await feed(`feed-${bucket}-delta`, { bucket, chain: "solana", fields: PANE_FIELDS, limit: 20, since_seq: cursors[bucket]! })
  }
  // Each list's time, read five more times, 3 s apart, as a 15 s poll of four would see it.
  for (let i = 1; i <= 5; i++) {
    for (const bucket of BUCKETS) await feed(`feed-${bucket}-time-${i}`, { bucket, chain: "solana", fields: PANE_FIELDS, limit: 20 })
    await Bun.sleep(3_000)
  }
}

async function pnl() {
  const prefixes = [{ label: "self", prefix: ownPrefix! }, ...agents]
  for (const { label, prefix } of prefixes) {
    await get(`pnl-${label}`, "candle_get_profile_pnl", { keyPrefix: prefix }, `/api/v1/agent/keys/${prefix}/pnl`)
    await get(`trades-${label}`, "candle_get_profile_trades", { keyPrefix: prefix }, `/api/v1/agent/keys/${prefix}/trades`)
  }
  const first = agents[0]
  if (first) {
    await get(`trades-${first.label}-limit5`, "candle_get_profile_trades", { keyPrefix: first.prefix, limit: 5 }, `/api/v1/agent/keys/${first.prefix}/trades`, { limit: "5" })
    // The REST route takes since (docs.candle.tv/developers/agent-trading, "Trade history"); the recorded MCP schema doesn't.
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString()
    await get(`trades-${first.label}-since`, "candle_get_profile_trades", { keyPrefix: first.prefix }, `/api/v1/agent/keys/${first.prefix}/trades`, { since })
    await get(`pnl-${first.label}-since`, "candle_get_profile_pnl", { keyPrefix: first.prefix }, `/api/v1/agent/keys/${first.prefix}/pnl`, { since })
  }
  await get("pnl-unknown-prefix", "candle_get_profile_pnl", { keyPrefix: "zzzzzzzz" }, "/api/v1/agent/keys/zzzzzzzz/pnl")
  // The account's whole history, every key's rows, for the shared-wallet check.
  await get("transactions", "candle_get_profile_trades", {}, "/api/v1/agent/transactions", { limit: "500" })
}

async function perps() {
  await get("perps-markets-5", "candle_perps_markets", { limit: 5 }, "/api/v1/agent/perps/markets", { limit: "5" })
  await get("perps-markets-volume-5", "candle_perps_markets", { sort: "volume", limit: 5 }, "/api/v1/agent/perps/markets", { sort: "volume", limit: "5" })
  await get("perps-overview", "candle_perps_overview", {}, "/api/v1/agent/perps/overview")
  await get("portfolio", "candle_get_portfolio", {}, "/api/v1/agent/portfolio")
}

console.log(`Recording into ${out}`)
if (phases.has("feed")) await feeds()
if (phases.has("pnl")) await pnl()
if (phases.has("perps")) await perps()
console.log("Done. The recordings name the account's wallets and tokens; scrub them before anything is committed.")
