// Records Hacc's real answers (`api.hacc.fun`), for the fake Hacc and the fixtures. The key is read from a
// file (the throwaway account's Read key), sent only to Hacc's host as a bearer token, never printed, and
// redacted from every recording. Recordings go to a git-ignored folder; scripts/scrub-recordings.ts turns
// their shapes into fixtures.
//
//   bun test/record-hacc.ts [--key-file PATH] [--out DIR] [--only reads,refusals,changes,stream,research]
//
// `reads` and `refusals` change nothing. `changes` adds and removes a follow,
// a rule of each pattern, a group with a wallet and a saved strategy, and runs about three replays, on
// the throwaway account's Hacc only: nothing on Hacc moves funds or changes anything on Candle.
// `stream` opens the signal stream, drops and reopens it, and briefly opens nine sockets.
// `research` reads what the Research tab and Signals' filters need, for JUP and for
// a token minutes old: top traders, profile, launch overview, its own signals (`asset=<mint>`) and
// mentions, then the tape by each pattern, a page deep, to see how far back each reaches.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Redactor } from "../src/shared/redact"

const HOST = "https://api.hacc.fun"

const { values: opts } = parseArgs({
  options: {
    "key-file": { type: "string", default: process.env.CANDLE_HARNESS_TEST_KEY_FILE },
    out: { type: "string" },
    only: { type: "string", default: "reads,refusals" },
  },
})
const phases = new Set(opts.only!.split(","))
if (!opts["key-file"]) throw new Error("name the Read key's file: --key-file <path>, or CANDLE_HARNESS_TEST_KEY_FILE")
const key = readFileSync(opts["key-file"], "utf8").trim()
if (!key.startsWith("cndl_")) throw new Error("the key file doesn't hold a Candle key")
const redactor = new Redactor()
redactor.add(key)
const out = resolve(opts.out ?? `test/fixtures/raw/hacc-${new Date().toISOString().slice(0, 10)}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

export interface HaccRecording {
  name: string
  method: string
  route: string
  query: Record<string, string>
  body?: unknown
  status: number | "timeout" | "error"
  ms: number
  bytes: number
  contentType?: string
  answer: unknown
}

const summary: { name: string; status: HaccRecording["status"]; ms: number; bytes: number }[] = []

function save(rec: HaccRecording) {
  writeFileSync(join(out, `${rec.name}.json`), `${JSON.stringify(redactor.value(rec), null, 2)}\n`, { mode: 0o600 })
  summary.push({ name: rec.name, status: rec.status, ms: rec.ms, bytes: rec.bytes })
  console.log(`${String(rec.status).padEnd(7)} ${String(rec.ms).padStart(6)} ms ${String(rec.bytes).padStart(8)} B  ${rec.name}`)
}

/** One call to Hacc. `auth` replaces the key for the refusal checks; null sends no header. */
async function call(
  name: string,
  method: string,
  route: string,
  query: Record<string, string> = {},
  o: { body?: unknown; timeoutMs?: number; auth?: string | null } = {},
): Promise<HaccRecording> {
  const url = new URL(route, HOST)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const headers: Record<string, string> = { accept: "application/json" }
  const auth = o.auth === undefined ? key : o.auth
  if (auth !== null) headers.authorization = `Bearer ${auth}`
  if (o.body !== undefined) headers["content-type"] = "application/json"
  const started = performance.now()
  let rec: HaccRecording
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    })
    const text = await res.text()
    let answer: unknown = text
    try {
      answer = JSON.parse(text)
    } catch {}
    rec = {
      name,
      method,
      route,
      query,
      ...(o.body === undefined ? {} : { body: o.body }),
      status: res.status,
      ms: Math.round(performance.now() - started),
      bytes: Buffer.byteLength(text),
      contentType: res.headers.get("content-type") ?? undefined,
      answer,
    }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
    rec = { name, method, route, query, status: timeout ? "timeout" : "error", ms: Math.round(performance.now() - started), bytes: 0, answer: String(e) }
  }
  save(rec)
  return rec
}

const get = (name: string, route: string, query: Record<string, string> = {}, timeoutMs?: number) => call(name, "GET", route, query, { timeoutMs })

// --- picking real ids from the tape, so every route is asked about something that exists ---

type Row = Record<string, unknown>
const rowsOf = (answer: unknown): Row[] => {
  if (Array.isArray(answer)) return answer as Row[]
  if (answer && typeof answer === "object") {
    for (const k of ["data", "signals", "rows", "items", "results", "wallets", "groups", "tokens", "assets"]) {
      const v = (answer as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  }
  return []
}
/** The first string found at any of these dotted paths, across rows. */
function pick(rows: Row[], ...paths: string[]): string | undefined {
  for (const row of rows)
    for (const path of paths) {
      let here: unknown = row
      for (const part of path.split(".")) here = here && typeof here === "object" ? (here as Row)[part] : undefined
      if (typeof here === "string" && here.length > 0) return here
      if (typeof here === "number") return String(here)
    }
  return undefined
}
function pickAll(rows: Row[], n: number, ...paths: string[]): string[] {
  const found = new Set<string>()
  for (const row of rows) {
    const one = pick([row], ...paths)
    if (one) found.add(one)
    if (found.size >= n) break
  }
  return [...found]
}

async function reads() {
  const tape = await get("signals-limit20", "/v1/signals", { limit: "20" })
  const rows = rowsOf(tape.answer)
  await get("signals-limit200", "/v1/signals", { limit: "200" })
  await get("signals-group-by-token", "/v1/signals", { group_by: "token", limit: "20" })
  for (const pattern of ["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "distribution", "kol_mention"])
    await get(`signals-pattern-${pattern}`, "/v1/signals", { pattern, limit: "5" })
  await get("signals-age-under-1h", "/v1/signals", { age: "<1h", limit: "5" })
  await get("signals-mcap-under-500k", "/v1/signals", { max_mcap_usd: "500000", limit: "5" })
  await get("signals-venue-pump", "/v1/signals", { venues: "pump", limit: "5" })
  await get("signals-order-asc", "/v1/signals", { order: "asc", limit: "5" })
  // `after` and `since` are dates (Hacc: "after: Invalid date" for an id).
  const oldest = rows.map((r) => r.created_at).filter((x): x is string => typeof x === "string").sort()[0]
  if (oldest) {
    await get("signals-after", "/v1/signals", { after: oldest, limit: "20" })
    await get("signals-since", "/v1/signals", { since: oldest, limit: "20" })
    await get("signals-since-asc", "/v1/signals", { since: oldest, order: "asc", limit: "20" })
  }
  await get("signals-offset", "/v1/signals", { limit: "5", offset: "5" })
  await get("signals-limit-over-cap", "/v1/signals", { limit: "500" })
  await get("signals-quality-all", "/v1/signals", { quality: "all", limit: "5" })
  const hood = await get("signals-chain-hood", "/v1/signals", { chain: "hood", limit: "20" })
  const hoodRows = rowsOf(hood.answer)

  const mints = pickAll(rows, 3, "token.address", "token.mint", "asset.address", "asset.mint", "mint", "token_address", "asset_address")
  const mint = mints[0]
  const symbol = pick(rows, "asset_symbol", "token.symbol", "symbol")
  const assetId = pick(rows, "asset.id", "asset_id", "token.asset_id")
  const wallets = pickAll(rows, 3, "wallet_address", "wallet.address")
  const book = rowsOf((await get("signals-pattern-intra_book-20", "/v1/signals", { pattern: "intra_book", limit: "20" })).answer)
  const bookWallet = pick(book, "wallet_address")
  const walletId = pick(rows, "wallet.id", "wallet_id")
  const hoodToken = pick(hoodRows, "token.address", "token.mint", "asset.address", "mint", "token_address", "asset_address")
  console.log(`picked: ${mints.length} mints, symbol ${symbol ? "yes" : "no"}, asset id ${assetId ? "yes" : "no"}, ${wallets.length} wallets, wallet id ${walletId ? "yes" : "no"}, hood token ${hoodToken ? "yes" : "no"}`)

  if (mint) {
    const t = `/v1/market/token/${mint}`
    await get("token-market", t)
    await get("token-history", `${t}/history`)
    // The window and resolution, as Hacc's own refusal words them ("one call fetches at most 6000").
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const now = new Date().toISOString()
    await get("token-history-1D", `${t}/history`, { resolution: "1D" })
    await get("token-history-1m-hour-from", `${t}/history`, { resolution: "1m", from: hourAgo, to: now })
    await get("token-history-1m-hour-since", `${t}/history`, { resolution: "1m", since: hourAgo })
    // The candles come only on request: `include_candles=true` (no other name is accepted).
    await get("token-history-1m-hour-candles", `${t}/history`, { resolution: "1m", from: hourAgo, to: now, include_candles: "true" })
    await get("token-history-1m-24h-too-many", `${t}/history`, { resolution: "1m", from: new Date(Date.now() - 6 * 86_400_000).toISOString(), include_candles: "true" })
    await get("token-top-traders", `${t}/top-traders`)
    await get("token-venues", `${t}/venues`)
    await get("token-holders-solana", `${t}/holders`)
    await get("token-profile", `${t}/profile`)
    await get("token-launch-overview", `${t}/launch-overview`)
    if (wallets.length) await get("token-wallet-pnl", `${t}/wallet-pnl`, { wallets: wallets.slice(0, 2).join(",") })
    await get("market-prices", "/v1/market/prices", { addresses: mints.join(",") })
    if (mints.length >= 2) await get("market-cohort-overlap", "/v1/market/cohort-overlap", { mints: mints.slice(0, 2).join(","), k: "2" })
    await get("social-mentions-address", "/v1/social/mentions", { address: mint })
    await get("social-mention-marks-address", "/v1/social/mention-marks", { address: mint })
  }
  await get("token-unknown-mint", "/v1/market/token/So11111111111111111111111111111111111111112")
  if (hoodToken) {
    const t = `/v1/market/token/${hoodToken}`
    await get("token-market-hood", t, { chain: "hood" })
    await get("token-history-hood", `${t}/history`, { chain: "hood" })
    await get("token-top-traders-hood", `${t}/top-traders`, { chain: "hood" })
    await get("token-holders-hood", `${t}/holders`, { chain: "hood" })
  }
  if (symbol) {
    await get("token-search-symbol", "/v1/market/token-search", { q: symbol })
    await get("social-mentions-ticker", "/v1/social/mentions", { ticker: symbol })
  }
  await get("social-mentions-ticker-common", "/v1/social/mentions", { ticker: "JUP" })
  await get("token-search-common", "/v1/market/token-search", { q: "JUP" })
  await get("token-search-name", "/v1/market/token-search", { q: "jupiter" })

  await get("market-gainers", "/v1/market/gainers")
  await get("market-metas", "/v1/market/metas")
  await get("market-activity", "/v1/market/activity", {}, 90_000)
  await get("launches-final-stretch", "/v1/launches/final-stretch")
  await get("social-mentions-trending", "/v1/social/mentions/trending")

  const tracked = await get("wallets", "/v1/wallets", { limit: "20" })
  const trackedRows = rowsOf(tracked.answer)
  const trackedId = pick(trackedRows, "id") ?? walletId
  const trackedAddress = pick(trackedRows, "address", "wallet_address") ?? wallets[0]
  if (trackedId) await get("wallet-by-id", `/v1/wallets/${trackedId}`)
  const groups = await get("groups", "/v1/groups")
  const groupId = pick(rowsOf(groups.answer), "id", "slug")
  if (groupId) {
    await get("group-by-id", `/v1/groups/${groupId}`)
    await get("signals-group", "/v1/signals", { group: groupId, limit: "5" }, 90_000)
  }
  await get("labelled-trades-smartmoney", "/v1/market/labelled-trades", { kind: "smartmoney" })
  await get("labelled-trades-kol", "/v1/market/labelled-trades", { kind: "kol" })
  if (trackedAddress) {
    const w = `/v1/market/wallet/${trackedAddress}`
    await get("wallet-stats", `${w}/stats`)
    await get("wallet-stats-all", `${w}/stats`, { period: "all" })
    await get("wallet-activity", `${w}/activity`)
    await get("wallet-token-breakdown", `${w}/token-breakdown`)
    await get("wallet-portfolio", `${w}/portfolio`)
    await get("wallet-book-legs", `${w}/book-legs`)
  }
  if (bookWallet) await get("wallet-book-legs-intra-book", `/v1/market/wallet/${bookWallet}/book-legs`)
  // Book legs answer only for wallets Hacc watches in real time (`not_in_book` otherwise).
  const realtime = await get("wallets-realtime", "/v1/wallets", { watch_level: "realtime", limit: "3" })
  const rtAddress = pick(rowsOf(realtime.answer), "address")
  if (rtAddress) {
    await get("wallet-book-legs-realtime", `/v1/market/wallet/${rtAddress}/book-legs`, {}, 60_000)
    await get("wallet-book-legs-realtime-7d", `/v1/market/wallet/${rtAddress}/book-legs`, { days: "7" }, 60_000)
  }
  await get("wallets-bad-watch-level", "/v1/wallets", { watch_level: "high", limit: "1" })

  await get("me-follows", "/v1/me/follows")
  await get("me-rules", "/v1/me/rules")
  await get("me-signals", "/v1/me/signals", { limit: "20" })
  await get("me-groups", "/v1/me/groups")

  await get("lab-edges", "/v1/strategy-lab/edges")
  // Only the defaults come from the hourly snapshot; anything else is computed (it took over 30 s).
  await get("lab-edges-7d-n20", "/v1/strategy-lab/edges", { days: "7", min_n: "20" }, 120_000)
  await get("lab-edges-pattern", "/v1/strategy-lab/edges", { pattern: "confluence" }, 120_000)
  await get("lab-runners-24h", "/v1/strategy-lab/runners", { hours: "24" }, 90_000)
  await get("lab-runners-1h-3w", "/v1/strategy-lab/runners", { hours: "1", min_wallets: "3" }, 90_000)
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  await get("lab-first-signals-30m", "/v1/strategy-lab/first-signals", { minutes: "30", launched_after: dayAgo }, 90_000)
  if (assetId) await get("lab-first-signals-asset", "/v1/strategy-lab/first-signals", { minutes: "30", asset_id: assetId }, 60_000)
  const assets = await get("assets", "/v1/assets", { launched_after: dayAgo, limit: "20" })
  await get("assets-ath", "/v1/assets", { min_ath_multiple: "10", limit: "20" })
  const anAsset = pick(rowsOf(assets.answer), "id") ?? assetId
  if (anAsset) await get("asset-by-id", `/v1/assets/${anAsset}`)
  await get("strategies", "/v1/strategies")
  await get("strategy-runs", "/v1/strategy-runs")
  if (assetId) await get("trades-asset", "/v1/trades", { asset_id: assetId })
}

async function refusals() {
  // Built at run time: the scrub refuses key literals, even fake ones.
  const testKey = ["cndl", "test", "0".repeat(32)].join("_")
  const liveShaped = ["cndl", "live", "0".repeat(32)].join("_")
  await call("refused-no-key", "GET", "/v1/signals", { limit: "1" }, { auth: null })
  await call("refused-test-key", "GET", "/v1/signals", { limit: "1" }, { auth: testKey })
  await call("refused-unknown-live-key", "GET", "/v1/signals", { limit: "1" }, { auth: liveShaped })
  await call("refused-garbage-key", "GET", "/v1/signals", { limit: "1" }, { auth: "not-a-key" })
  // Strategy ids are numbers, replay ids aren't (Hacc: "id: Expected number"; "invalid id").
  await get("refused-strategy-404", "/v1/strategies/999999999")
  await get("refused-strategy-not-a-number", "/v1/strategies/00000000-0000-0000-0000-000000000000")
  await get("refused-replay-404", "/v1/strategy-lab/replay/00000000-0000-0000-0000-000000000000")
  await get("refused-unknown-route", "/v1/nothing-here")
  await get("refused-bad-pattern", "/v1/signals", { pattern: "nonsense" })
  await get("refused-bad-address", "/v1/market/token/not-an-address")
}

// --- changes: each add is undone at the end, whatever happens in between ---

const DEFINITION = {
  chain: "solana",
  entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500000, max_age_minutes: 60 } },
  exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 },
  sizing: { usd_per_trade: 25, max_concurrent: 4 },
}
const idOf = (answer: unknown): string | undefined => {
  if (!answer || typeof answer !== "object") return undefined
  const a = answer as Row
  for (const k of ["id", "job_id"]) if (typeof a[k] === "string" || typeof a[k] === "number") return String(a[k])
  for (const k of ["data", "follow", "rule", "group", "strategy", "version"]) {
    const inner = idOf(a[k])
    if (inner) return inner
  }
  return undefined
}

async function changes() {
  const undo: (() => Promise<unknown>)[] = []
  try {
    const tracked = rowsOf((await get("changes-wallets", "/v1/wallets", { limit: "5" })).answer)
    const address = pick(tracked, "address", "wallet_address")
    if (!address) throw new Error("no tracked wallet to follow")

    const follow = await call("change-follow-add", "POST", "/v1/me/follows", {}, { body: { chain: "solana", address } })
    const followId = idOf(follow.answer)
    if (followId) undo.push(() => call("change-follow-delete", "DELETE", `/v1/me/follows/${followId}`))
    await get("change-follows-after-add", "/v1/me/follows")
    await call("change-follow-add-again", "POST", "/v1/me/follows", {}, { body: { chain: "solana", address } })
    await call("change-follow-bad-address", "POST", "/v1/me/follows", {}, { body: { chain: "solana", address: "not-an-address" } })

    const walletId = pick(rowsOf((await get("change-follows-read", "/v1/me/follows")).answer), "wallet_id", "wallet.id", "id")
    const rules: [string, Record<string, unknown>][] = [
      ["new_ticker", { min_usd: 100 }],
      ["confluence", { wallets: 2, window_minutes: 30 }],
      ["large_move", { min_usd: 5000 }],
      ["dormancy", { days: 30 }],
      ["distribution", {}],
    ]
    for (const [pattern, params] of rules) {
      const rule = await call(`change-rule-add-${pattern}`, "POST", "/v1/me/rules", {}, { body: { name: `q1 check ${pattern}`, pattern, ...(walletId ? { wallet_id: walletId } : {}), params } })
      const ruleId = idOf(rule.answer)
      if (ruleId) undo.push(() => call(`change-rule-delete-${pattern}`, "DELETE", `/v1/me/rules/${ruleId}`))
    }
    await call("change-rule-bad-params", "POST", "/v1/me/rules", {}, { body: { name: "q1 check bad", pattern: "confluence", params: { wallets: 1 } } })
    await call("change-rule-bad-pattern", "POST", "/v1/me/rules", {}, { body: { name: "q1 check bad", pattern: "nonsense" } })
    await get("change-rules-after-add", "/v1/me/rules")

    const group = await call("change-group-add", "POST", "/v1/me/groups", {}, { body: { name: "q1 check" } })
    const groupId = idOf(group.answer)
    if (groupId) {
      undo.push(() => call("change-group-delete", "DELETE", `/v1/me/groups/${groupId}`))
      const member = await call("change-group-wallet-add", "POST", `/v1/me/groups/${groupId}/wallets`, {}, { body: { chain: "solana", address } })
      const memberId = idOf(member.answer)
      await get("change-groups-after-add", "/v1/me/groups")
      await call("change-group-wallet-delete", "DELETE", `/v1/me/groups/${groupId}/wallets/${memberId ?? address}`)
    }

    const strategy = await call("change-strategy-save", "POST", "/v1/strategies", {}, { body: { name: "q1 check", definition: DEFINITION } })
    const strategyId = idOf(strategy.answer)
    await call("change-strategy-save-bad", "POST", "/v1/strategies", {}, { body: { name: "q1 check bad", definition: { ...DEFINITION, extra: true } } })
    if (strategyId) {
      undo.push(() => retire(strategyId))
      await call("change-strategy-version", "POST", `/v1/strategies/${strategyId}/versions`, {}, { body: { definition: { ...DEFINITION, exit: { ...DEFINITION.exit, stop_loss_pct: 30 } } } })
      await get("change-strategy-read", `/v1/strategies/${strategyId}`)
    }

    // Replays: one to done, one 409 while it runs, one cancelled. A malformed one is refused first.
    const to = new Date()
    const from = new Date(to.getTime() - 3 * 86_400_000)
    const window = { from: from.toISOString(), to: to.toISOString() }
    await call("replay-bad-definition", "POST", "/v1/strategy-lab/replay", {}, { body: { definition: { ...DEFINITION, extra: true }, ...window } })
    await call("replay-window-too-long", "POST", "/v1/strategy-lab/replay", {}, { body: { definition: DEFINITION, from: new Date(to.getTime() - 20 * 86_400_000).toISOString(), to: to.toISOString() } })
    const first = await call("replay-start", "POST", "/v1/strategy-lab/replay", {}, { body: { definition: DEFINITION, ...window } })
    const jobId = idOf(first.answer)
    if (jobId) {
      await call("replay-start-while-running", "POST", "/v1/strategy-lab/replay", {}, { body: { definition: DEFINITION, ...window } })
      const started = Date.now()
      let polls = 0
      for (;;) {
        const poll = await call(`replay-poll-${String(polls).padStart(3, "0")}`, "GET", `/v1/strategy-lab/replay/${jobId}`)
        polls++
        const status = (poll.answer as Row | undefined)?.status
        if (status === "done" || status === "failed" || Date.now() - started > 11 * 60_000) break
        await Bun.sleep(polls < 6 ? 5_000 : 15_000)
      }
      console.log(`replay settled after ${Math.round((Date.now() - started) / 1000)} s, ${polls} polls`)
    }
    const second = await call("replay-start-to-cancel", "POST", "/v1/strategy-lab/replay", {}, { body: { definition: DEFINITION, ...window } })
    const cancelId = idOf(second.answer)
    if (cancelId) {
      await call("replay-cancel", "POST", `/v1/strategy-lab/replay/${cancelId}/cancel`)
      await get("replay-after-cancel", `/v1/strategy-lab/replay/${cancelId}`)
    }

    if (strategyId) {
      // Hacc backtests a draft within minutes: wait up to 10 for `backtested`.
      const started = Date.now()
      for (let i = 0; Date.now() - started < 10 * 60_000; i++) {
        const read = await call(`strategy-wait-${String(i).padStart(3, "0")}`, "GET", `/v1/strategies/${strategyId}`)
        if (JSON.stringify(read.answer).includes("backtested")) break
        await Bun.sleep(30_000)
      }
      console.log(`strategy read for ${Math.round((Date.now() - started) / 1000)} s`)
      await get("strategy-trades", `/v1/strategies/${strategyId}/trades`)
      await get("strategy-comparison", `/v1/strategies/${strategyId}/comparison`)
      await get("strategy-runs-after", "/v1/strategy-runs")
      await get("trades-after", "/v1/trades")
    }
    await get("me-signals-after", "/v1/me/signals", { limit: "20" })
  } finally {
    for (const step of undo.reverse()) await step().catch((e) => console.log(`undo failed: ${e}`))
    await get("after-follows", "/v1/me/follows")
    await get("after-rules", "/v1/me/rules")
    await get("after-groups", "/v1/me/groups")
    await get("after-strategies", "/v1/strategies")
  }
}

/** The docs say a strategy can be set to `retired`, not how: try the likely shapes in turn. */
async function retire(id: string) {
  for (const [name, method, route, body] of [
    ["change-strategy-retire-patch", "PATCH", `/v1/strategies/${id}`, { status: "retired" }],
    ["change-strategy-retire-post", "POST", `/v1/strategies/${id}/retire`, undefined],
    ["change-strategy-retire-put", "PUT", `/v1/strategies/${id}`, { status: "retired" }],
  ] as const) {
    const rec = await call(name, method, route, {}, { body })
    if (typeof rec.status === "number" && rec.status < 300) return
  }
}

/** What the first runs left open: removing a wallet from a group, and first-signals' bare refusal. */
async function followups() {
  await get("lab-first-signals-30m-missing", "/v1/strategy-lab/first-signals", { minutes: "30" })
  // The stream's gap, filled by date (an id is refused): the last signal heard, then the tape after it.
  const heard = await listen("gap-before", 20)
  const lastHeard = heard
    .map((f) => f.frame as Row)
    .flatMap((fr) => (fr.type === "snapshot" ? (fr.signals as Row[]) : fr.type === "signal" ? [fr.signal as Row] : []))
    .map((r) => String(r.created_at))
    .sort()
    .at(-1)
  await Bun.sleep(45_000)
  if (lastHeard) {
    await get("stream-gap-fill-since", "/v1/signals", { since: lastHeard, order: "asc", limit: "200" })
    await get("stream-gap-fill-after", "/v1/signals", { after: lastHeard, order: "asc", limit: "200" })
  }
  await listen("filter-event-kind-swap", 20, { event_kind: "swap" })
  await listen("filter-pattern", 10, { pattern: "confluence" })
  await capAnswer()
  const address = pick(rowsOf((await get("followups-wallets", "/v1/wallets", { limit: "5" })).answer), "address")
  const group = await call("followup-group-add", "POST", "/v1/me/groups", {}, { body: { name: "q1 check" } })
  const groupId = idOf(group.answer)
  if (!groupId || !address) return
  try {
    const added = await call("followup-group-wallet-add", "POST", `/v1/me/groups/${groupId}/wallets`, {}, { body: { chain: "solana", address } })
    const walletId = pick(((added.answer as Row)?.group as Row)?.wallets as Row[] ?? [], "wallet_id")
    for (const [name, seg] of [["by-wallet-id", walletId], ["by-address", address]] as const) {
      if (!seg) continue
      const rec = await call(`followup-group-wallet-delete-${name}`, "DELETE", `/v1/me/groups/${groupId}/wallets/${seg}`)
      if (typeof rec.status === "number" && rec.status < 300) break
    }
    await call("followup-group-wallet-delete-body", "DELETE", `/v1/me/groups/${groupId}/wallets`, {}, { body: { chain: "solana", address } })
    await get("followup-group-after", "/v1/me/groups")
  } finally {
    await call("followup-group-delete", "DELETE", `/v1/me/groups/${groupId}`)
    await get("followup-groups-after", "/v1/me/groups")
  }
}

/** With eight sockets open, what Hacc answers a ninth upgrade, as HTTP (a WebSocket hides it). */
async function capAnswer() {
  const eight = Array.from({ length: 8 }, (_, i) => listen(`cap-hold-${i + 1}`, 12))
  await Bun.sleep(3_000)
  const https = await import("node:https")
  const started = performance.now()
  const answer = await new Promise<{ status?: number; headers: unknown; body: string }>((done) => {
    const req = https.request(`${HOST}/v1/signals/stream`, {
      headers: {
        authorization: `Bearer ${key}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("q1-cap-check-0000").toString("base64"),
      },
    })
    req.on("upgrade", (res, socket) => {
      socket.destroy()
      done({ status: res.statusCode, headers: res.headers, body: "(upgraded: the cap let a ninth through)" })
    })
    req.on("response", (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on("error", (e) => done({ headers: {}, body: String(e) }))
    req.end()
  })
  writeFileSync(join(out, "stream-cap-ninth.json"), `${JSON.stringify(redactor.value({ name: "stream-cap-ninth", ms: Math.round(performance.now() - started), ...answer }), null, 2)}\n`, { mode: 0o600 })
  console.log(`ninth socket: ${answer.status} ${answer.body.slice(0, 120)}`)
  await Promise.all(eight)
}

// --- the stream ---

function openSocket(query: Record<string, string> = {}) {
  const url = new URL("/v1/signals/stream", HOST.replace("https", "wss"))
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  // Bun's WebSocket takes headers, so the key goes in the header, never the URL.
  return new WebSocket(url.toString(), { headers: { authorization: `Bearer ${key}` } } as unknown as string[])
}

interface Frame {
  at: number
  bytes: number
  frame: unknown
}
function listen(name: string, seconds: number, query: Record<string, string> = {}): Promise<Frame[]> {
  return new Promise((done) => {
    const frames: Frame[] = []
    const started = performance.now()
    const ws = openSocket(query)
    let opened: number | undefined
    let closed: { code: number; reason: string } | undefined
    const finish = () => {
      writeFileSync(join(out, `stream-${name}.json`), `${JSON.stringify(redactor.value({ name, query, openedMs: opened, closed, frames }), null, 2)}\n`, { mode: 0o600 })
      console.log(`stream ${name}: opened ${opened ?? "never"} ms, ${frames.length} frames${closed ? `, closed ${closed.code} ${closed.reason}` : ""}`)
      done(frames)
    }
    const timer = setTimeout(() => {
      ws.close()
      setTimeout(finish, 500)
    }, seconds * 1000)
    ws.onopen = () => (opened = Math.round(performance.now() - started))
    ws.onmessage = (e) => {
      const text = String(e.data)
      let frame: unknown = text
      try {
        frame = JSON.parse(text)
      } catch {}
      frames.push({ at: Math.round(performance.now() - started), bytes: Buffer.byteLength(text), frame })
    }
    ws.onclose = (e) => {
      closed = { code: e.code, reason: e.reason }
      if (opened === undefined) {
        clearTimeout(timer)
        finish()
      }
    }
    ws.onerror = () => {}
  })
}

async function stream() {
  const frames = await listen("main", 150)
  // The last signal id seen, then a gap while closed, then the REST tape after it.
  const ids = frames.flatMap((f) => {
    const fr = f.frame as Row
    const rows = Array.isArray(fr) ? fr : rowsOf(fr).length ? rowsOf(fr) : [fr.signal ?? fr.data ?? fr]
    return rows.map((r) => pick([r as Row], "id", "signal_id")).filter((x): x is string => !!x)
  })
  const last = ids.at(-1)
  console.log(`stream: ${ids.length} signal ids seen; waiting 60 s closed`)
  await Bun.sleep(60_000)
  if (last) await get("stream-gap-fill", "/v1/signals", { after: last, limit: "200" })
  await listen("reopened", 20)
  await listen("filter-chain-hood", 20, { chain: "hood" })
  await listen("filter-event-kind", 20, { event_kind: "confluence" })
  await listen("filter-quality-all", 20, { quality: "all" })
  // Nine at once: the docs allow 8 per account (the web app and other apps count too).
  const nine = Array.from({ length: 9 }, (_, i) => listen(`cap-${i + 1}`, 15))
  await Promise.all(nine)
}

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"

async function research() {
  // A token minutes old: the newest first buy of a new ticker on the tape, under an hour old.
  const young = pick(rowsOf((await get("research-young-pick", "/v1/signals", { pattern: "new_ticker", age: "<1h", limit: "5" })).answer), "asset_address")
  for (const [label, mint] of [["jup", JUP], ["young", young]] as const) {
    if (!mint) {
      console.log(`research: no ${label} token picked`)
      continue
    }
    const t = `/v1/market/token/${mint}`
    await get(`research-${label}-top-traders`, `${t}/top-traders`)
    await get(`research-${label}-profile`, `${t}/profile`)
    await get(`research-${label}-launch-overview`, `${t}/launch-overview`)
    await get(`research-${label}-market`, t)
    // One token's signals: the tape by its mint, not in the first recording.
    await get(`research-${label}-signals-asset`, "/v1/signals", { asset: mint, limit: "20" })
    await get(`research-${label}-signals-asset-all`, "/v1/signals", { asset: mint, limit: "20", quality: "all" })
    await get(`research-${label}-mentions`, "/v1/social/mentions", { address: mint })
  }
  // An asset id in place of a mint, as the tool's description allows.
  const assetId = pick(rowsOf((await get("research-asset-pick", "/v1/signals", { limit: "1" })).answer), "asset_id")
  if (assetId) await get("research-signals-asset-id", "/v1/signals", { asset: assetId, limit: "5" })
  await get("research-signals-asset-unknown", "/v1/signals", { asset: "So11111111111111111111111111111111111111112", limit: "5" })
  // Signals' read-back: each pattern a page deep, and with the curated filter off.
  for (const pattern of ["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "distribution", "kol_mention"]) {
    await get(`research-pattern-${pattern}`, "/v1/signals", { pattern, limit: "50" })
    await get(`research-pattern-${pattern}-all`, "/v1/signals", { pattern, limit: "50", quality: "all" })
  }
  await get("research-pattern-chain-hood", "/v1/signals", { pattern: "new_ticker", chain: "hood", limit: "50" })
}

if (phases.has("reads")) await reads()
if (phases.has("refusals")) await refusals()
if (phases.has("changes")) await changes()
if (phases.has("followups")) await followups()
if (phases.has("stream")) await stream()
if (phases.has("research")) await research()
writeFileSync(join(out, `summary-${[...phases].join("-")}.json`), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
console.log(`${summary.length} calls recorded in ${out}`)
