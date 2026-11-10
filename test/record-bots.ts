// Records what a rules bot rests on, from Hacc's strategy lab and tape (`api.hacc.fun`), with Candle's market read
// (`api.alpha.candle.tv`) for market caps at arrival. Nothing here trades or saves a strategy; replays use the account's
// daily quota (20 on Max). The key is read from a file, sent only to its own hosts, never printed, and redacted from
// every recording.
//
//   bun test/record-bots.ts [--key-file PATH] [--out DIR] [--only schema,runs,exits,sizing,semantics,filters,hour,hour-extra,hour-clean,compare]
//                           [--signal-window <from>,<to>] [--signal-asset <asset id>]
//                           [--minutes 60] [--hours 3]
//
// - `schema`: what Hacc's definition takes, field by field. Each probe is a replay over 29 days: Hacc checks the
//   definition first and the window second, so a definition it takes answers `lab_window` and nothing runs.
// - `runs`: the account's strategies, their backtest runs, and the newest run's trades (paged by offset).
// - `exits`: one replay per exit (take profit, stop, max hold, trailing, exit on signal) over `--hours`, each alone, to
//   read what each exit means from the trades' prices and `reason_closed`.
// - `sizing`: one replay with `base_usd`, `max_usd` and `rules`, to read `required_start_usd`,
//   `peak_capital_at_risk_usd` and each trade's `reason_opened.sizing`.
// - `semantics`: what `exit_on_signal` exits on, and how `base_usd`, `mult` and `add` combine (see `semantics`).
// - `filters`: the tape's rows by pattern, curated and `quality=all`, for which of a definition's filters a row
//   carries; and the routes a live read of trade signals or conviction might sit on, with Hacc's answers.
// - `hour`: the stream for `--minutes`, each new token's market read from Candle as it arrives, then the same window
//   read back by REST and replayed with two definitions.
// - `hour-extra`: the same window replayed with filters the row itself carries (groups, min_usd, direction);
//   `hour-clean`, with no filters and slots for every token.
// - `compare`: offline, from `hour`'s files: the core's matcher over the recorded stream against each replay's entries.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { apiKeyPrefix } from "../src/shared/api-key"
import { Redactor } from "../src/shared/redact"

const HACC = "https://api.hacc.fun"
const CANDLE = "https://api.alpha.candle.tv"

const { values: opts } = parseArgs({
  options: {
    "key-file": { type: "string", default: process.env.CANDLE_HARNESS_TEST_KEY_FILE },
    out: { type: "string" },
    only: { type: "string", default: "schema,runs" },
    minutes: { type: "string", default: "60" },
    hours: { type: "string", default: "3" },
    "signal-window": { type: "string" },
    "signal-asset": { type: "string" },
  },
})
const phases = new Set(opts.only!.split(","))
if (!opts["key-file"]) throw new Error("name the Read key's file: --key-file <path>, or CANDLE_HARNESS_TEST_KEY_FILE")
const key = readFileSync(opts["key-file"], "utf8").trim()
if (!apiKeyPrefix(key)) throw new Error("the key file doesn't hold a Candle key")
const redactor = new Redactor()
redactor.add(key)
const out = resolve(opts.out ?? `test/fixtures/raw/bots-${new Date().toISOString().slice(0, 10)}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

type Row = Record<string, unknown>
export interface BotRecording {
  name: string
  host: "hacc" | "candle"
  method: "GET" | "POST"
  route: string
  query: Record<string, string>
  body?: unknown
  status: number | "timeout" | "error"
  at: number
  ms: number
  bytes: number
  answer: unknown
}

function write(name: string, value: unknown) {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(redactor.value(value), null, 2)}\n`, { mode: 0o600 })
}
const read = (name: string): Row => JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")) as Row

async function call(host: "hacc" | "candle", method: "GET" | "POST", route: string, query: Record<string, string> = {}, body?: unknown, timeoutMs = 30_000): Promise<BotRecording> {
  const url = new URL(route, host === "hacc" ? HACC : CANDLE)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const headers: Record<string, string> = host === "hacc" ? { accept: "application/json", authorization: `Bearer ${key}` } : { accept: "application/json", "x-api-key": key }
  if (body !== undefined) headers["content-type"] = "application/json"
  const at = Date.now()
  const started = performance.now()
  const base = { name: "", host, method, route, query, ...(body !== undefined ? { body } : {}) }
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let answer: unknown = text
    try {
      answer = JSON.parse(text)
    } catch {}
    return { ...base, status: res.status, at, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text), answer }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
    return { ...base, status: timeout ? "timeout" : "error", at, ms: Math.round(performance.now() - started), bytes: 0, answer: String(e) }
  }
}

async function record(name: string, method: "GET" | "POST", route: string, query: Record<string, string> = {}, body?: unknown) {
  const rec = { ...(await call("hacc", method, route, query, body)), name }
  write(name, rec)
  console.log(`${String(rec.status).padEnd(7)} ${String(rec.ms).padStart(6)} ms ${String(rec.bytes).padStart(8)} B  ${name}`)
  return rec
}

const rowsOf = (answer: unknown, k = "signals"): Row[] => {
  const v = answer && typeof answer === "object" ? (answer as Row)[k] : undefined
  return Array.isArray(v) ? (v as Row[]) : []
}
const iso = (ms: number) => new Date(ms).toISOString()

// --- schema ---

type Def = { chain: string; entry: Row; exit: Row; sizing: Row; [k: string]: unknown }
const base = (): Def => ({ chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: {} }, exit: { take_profit_pct: 100 }, sizing: { usd_per_trade: 5, max_concurrent: 2 } })
const withFilters = (filters: Row, pattern = "confluence") => ({ ...base(), entry: { source: "pattern", pattern, filters } })
const withExit = (exit: Row) => ({ ...base(), exit })
const withSizing = (sizing: Row) => ({ ...base(), sizing: { usd_per_trade: 5, max_concurrent: 2, ...sizing } })
const withEntry = (entry: Row) => ({ ...base(), entry })
const rule = (when: Row, act: Row) => withSizing({ rules: [{ when, ...act }] })

const PROBES: [string, unknown][] = [
  ["base", base()],
  ["unknown-top", { ...base(), extra: 1 }],
  ["chain-any", { ...base(), chain: "any" }],
  ["chain-bad", { ...base(), chain: "x" }],
  ["entry-source-bad", withEntry({ source: "x" })],
  ["entry-unknown", withEntry({ source: "pattern", pattern: "confluence", filters: {}, extra: 1 })],
  ["entry-no-filters", withEntry({ source: "pattern", pattern: "confluence" })],
  ["entry-no-pattern", withEntry({ source: "pattern", filters: {} })],
  ["pattern-bad", withFilters({}, "x")],
  ["pattern-distribution", withFilters({}, "distribution")],
  ["trade-signal", withEntry({ source: "trade_signal", min_confidence: 0.7 })],
  ["trade-signal-empty", withEntry({ source: "trade_signal" })],
  ["conviction-empty", withEntry({ source: "conviction" })],
  ["manual-empty", withEntry({ source: "manual" })],
  ["levels-empty", withEntry({ source: "levels" })],
  ["launch-fingerprint-empty", withEntry({ source: "launch_fingerprint" })],
  ["schedule-empty", withEntry({ source: "schedule" })],
  ["filter-unknown", withFilters({ extra: 1 })],
  ["filter-min-usd", withFilters({ min_usd: 10 })],
  ["filter-min-usd-text", withFilters({ min_usd: "10" })],
  ["filter-mcap-band", withFilters({ min_mcap_usd: 10_000, max_mcap_usd: 500_000 })],
  ["filter-mcap-negative", withFilters({ min_mcap_usd: -1 })],
  ["filter-age-band", withFilters({ min_age_minutes: 0, max_age_minutes: 60 })],
  ["filter-age-negative", withFilters({ max_age_minutes: -1 })],
  ["filter-groups", withFilters({ groups: ["g"] })],
  ["filter-groups-number", withFilters({ groups: [1] })],
  ["filter-groups-all", withFilters({ groups_all: ["g"] })],
  ["filter-min-group-wallets-no-group", withFilters({ min_group_wallets: 2 })],
  ["filter-min-group-wallets", withFilters({ groups: ["g"], min_group_wallets: 2 })],
  ...["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "kol_mention"].map((p): [string, unknown] => [`filter-wallet-ids-${p}`, withFilters({ wallet_ids: [1] }, p)]),
  ["filter-wallet-ids-text", withFilters({ wallet_ids: ["1"] }, "new_ticker")],
  ["filter-venues", withFilters({ venues: ["pump"], exclude_venues: ["candle"] })],
  ["filter-venues-text", withFilters({ venues: "pump" })],
  ["filter-direction-in", withFilters({ direction: "in" })],
  ["filter-direction-bad", withFilters({ direction: "x" })],
  ["filter-hours-et", withFilters({ hours_et: [9, 17] })],
  ["filter-hours-et-one", withFilters({ hours_et: [9] })],
  ["filter-hours-et-wrap", withFilters({ hours_et: [22, 4] })],
  ["filter-hours-et-24", withFilters({ hours_et: [24, 1] })],
  ["filter-hours-et-half", withFilters({ hours_et: [9.5, 17] })],
  ["filter-min-score-1h", withFilters({ min_score_1h: 1 })],
  ["exit-empty", withExit({})],
  ["exit-unknown", withExit({ take_profit_pct: 10, extra: 1 })],
  ["exit-take-profit-0", withExit({ take_profit_pct: 0 })],
  ["exit-stop-100", withExit({ stop_loss_pct: 100 })],
  ["exit-stop-101", withExit({ stop_loss_pct: 101 })],
  ["exit-hold-half", withExit({ max_hold_hours: 0.5 })],
  ["exit-on-signal", withExit({ exit_on_signal: true })],
  ["exit-on-signal-text", withExit({ exit_on_signal: "x" })],
  ["exit-trailing", withExit({ trailing: { arm_multiple: 2, drop_pct: 30 } })],
  ["exit-trailing-empty", withExit({ trailing: {} })],
  ["exit-trailing-arm-under-1", withExit({ trailing: { arm_multiple: 0.5, drop_pct: 30 } })],
  ["exit-ladder-empty", withExit({ ladder: {} })],
  ["sizing-unknown", withSizing({ extra: 1 })],
  ["sizing-usd-0", withSizing({ usd_per_trade: 0 })],
  ["sizing-concurrent-0", withSizing({ max_concurrent: 0 })],
  ["sizing-base-max", withSizing({ base_usd: 2, max_usd: 10 })],
  ["sizing-base-over-max", withSizing({ base_usd: 20, max_usd: 10 })],
  ["rule-empty", withSizing({ rules: [{}] })],
  ["rule-when-text", rule({ mcap_at_entry: 1 } as Row, { mult: 2 })],
  ["rule-feature-bad", rule({ x: { lt: 1 } }, { mult: 2 })],
  ["rule-no-action", rule({ mcap_at_entry: { lt: 100_000 } }, {})],
  ["rule-mult", rule({ mcap_at_entry: { lt: 100_000 } }, { mult: 2 })],
  ["rule-ops", rule({ mcap_at_entry: { gt: 1, gte: 1, lt: 2, lte: 2 } }, { mult: 2 })],
  ["rule-op-unknown", rule({ mcap_at_entry: { max: 1 } }, { mult: 2 })],
  ["rule-two-features", rule({ mcap_at_entry: { lt: 1 }, score_15m: { gt: 1 } }, { mult: 2 })],
  ["rule-two-actions", rule({ mcap_at_entry: { lt: 1 } }, { mult: 2, add: 1 })],
  ["rule-add-negative", rule({ mcap_at_entry: { lt: 1 } }, { add: -1 })],
  ["rule-skip", rule({ mcap_at_entry: { lt: 1 } }, { skip: true })],
  ["rule-skip-false", rule({ mcap_at_entry: { lt: 1 } }, { skip: false })],
  ["rule-boolean-feature", rule({ proven_follow_present: true } as unknown as Row, { skip: true })],
]

async function schema() {
  const summary: Row[] = []
  for (const [label, definition] of PROBES) {
    const rec = await record(`schema-${label}`, "POST", "/v1/strategy-lab/replay", {}, { definition, from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z" })
    const a = rec.answer as Row
    if (rec.status === 202) throw new Error(`schema probe ${label} started a replay: the window check moved`)
    summary.push({ label, takes: a?.code === "lab_window", error: a?.code === "lab_window" ? null : (a?.error ?? null) })
  }
  write("schema-summary", summary)
}

// --- runs ---

async function pagedTrades(name: string, runId: number) {
  const trades: Row[] = []
  for (let offset = 0; offset < 20_000; offset += 500) {
    const rec = await call("hacc", "GET", "/v1/trades", { run_id: String(runId), limit: "500", offset: String(offset) })
    if (rec.status !== 200) {
      write(`${name}-refused`, { ...rec, name: `${name}-refused` })
      break
    }
    const page = rowsOf(rec.answer, "trades")
    trades.push(...page)
    if (page.length < 500) break
  }
  write(name, { name, runId, count: trades.length, answer: { trades } })
  console.log(`runs: ${trades.length} trades for run ${runId}`)
  return trades
}

async function runs() {
  await record("lab-status", "GET", "/v1/strategy-lab/status")
  await record("strategies", "GET", "/v1/strategies")
  const list = await record("strategy-runs", "GET", "/v1/strategy-runs")
  await record("trades-no-run", "GET", "/v1/trades")
  await record("trades-limit-501", "GET", "/v1/trades", { run_id: "1", limit: "501" })
  const newest = rowsOf(list.answer, "runs").find((r) => Number(r.trade_count) > 0)
  if (newest) {
    await record("trades-run-page", "GET", "/v1/trades", { run_id: String(newest.id), limit: "3" })
    await pagedTrades("trades-run-all", Number(newest.id))
  }
}

// --- replays ---

const POLL_MS = 3_000
/** Starts a replay, waiting out another one still running on the key, and polls it to the end. */
async function replay(name: string, definition: unknown, from: number, to: number, extra: Row = {}) {
  const body = { definition, from: iso(from), to: iso(to), ...extra }
  let start = await record(`${name}-start`, "POST", "/v1/strategy-lab/replay", {}, body)
  for (let i = 0; start.status === 409 && i < 40; i++) {
    await Bun.sleep(15_000)
    start = await record(`${name}-start`, "POST", "/v1/strategy-lab/replay", {}, body)
  }
  const jobId = (start.answer as Row)?.job_id
  if (start.status !== 202 || jobId === undefined) return undefined
  const started = Date.now()
  let polls = 0
  let last: BotRecording | undefined
  while (Date.now() - started < 11 * 60_000) {
    await Bun.sleep(POLL_MS)
    last = await call("hacc", "GET", `/v1/strategy-lab/replay/${jobId}`, {}, undefined, 60_000)
    polls++
    const status = (last.answer as Row)?.status
    if (status === "done" || status === "failed") break
  }
  const settled = { ...last!, name: `${name}-result`, polls, seconds: Math.round((Date.now() - started) / 1000), request: body }
  write(`${name}-result`, settled)
  const a = settled.answer as Row
  const result = (a?.result ?? {}) as Row
  console.log(`replay ${name}: ${a?.status} after ${settled.seconds} s, ${String(result.trade_count ?? "?")} trades${a?.error ? `, ${String(a.error)}` : ""}`)
  return a
}

// A floor on market cap keeps the candidates few: an unfiltered 6 hours of new tickers ran out Hacc's 10 minutes.
const NEW_TICKER = { source: "pattern", pattern: "new_ticker", filters: { min_mcap_usd: 100_000 } }
const EXITS: [string, Row][] = [
  ["exit-take-profit", { take_profit_pct: 30 }],
  ["exit-stop", { stop_loss_pct: 20 }],
  ["exit-hold", { max_hold_hours: 1 }],
  ["exit-trailing", { trailing: { arm_multiple: 1.3, drop_pct: 15 } }],
  ["exit-signal", { exit_on_signal: true }],
]

/** A window that ended half an hour ago, so Hacc has recorded its prices. */
function window(): [number, number] {
  const to = Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000
  return [to - Number(opts.hours) * 3_600_000, to]
}

async function exits() {
  const [from, to] = window()
  for (const [name, exit] of EXITS) await replay(name, { chain: "solana", entry: NEW_TICKER, exit, sizing: { usd_per_trade: 10, max_concurrent: 10 } }, from, to)
}

async function sizing() {
  const [from, to] = window()
  await replay(
    "sizing",
    {
      chain: "solana",
      entry: NEW_TICKER,
      exit: { take_profit_pct: 30, stop_loss_pct: 20, max_hold_hours: 1 },
      sizing: {
        usd_per_trade: 10,
        max_concurrent: 3,
        base_usd: 5,
        max_usd: 20,
        rules: [
          { when: { mcap_at_entry: { lt: 300_000 } }, mult: 2 },
          { when: { mcap_at_entry: { gte: 2_000_000 } }, skip: true },
          { when: { tracked_buyers_at_trigger: { gte: 3 } }, add: 5 },
        ],
      },
    },
    from,
    to,
  )
}

/**
 * What `exit_on_signal` exits on, over a window that holds a distribution signal (a tracked wallet selling) on a token
 * new tickers entered, found first on the tape (`--signal-window from,to`, `--signal-asset <asset id>`); and how
 * `base_usd`, `mult` and `add` combine, each alone, with a rule that always holds.
 */
async function semantics() {
  if (opts["signal-window"]) {
    const [from, to] = opts["signal-window"].split(",").map((x) => Date.parse(x))
    const asset = opts["signal-asset"] ? { asset_ids: [Number(opts["signal-asset"])] } : {}
    await replay("exit-signal-distribution", { chain: "solana", entry: { source: "pattern", pattern: "new_ticker", filters: {} }, exit: { exit_on_signal: true }, sizing: { usd_per_trade: 10, max_concurrent: 50 } }, from!, to!, asset)
  }
  const [, to] = window()
  const from = to - 3_600_000
  const always = { mcap_at_entry: { gt: 0 } }
  const sized = (sizing: Row) => ({ chain: "solana", entry: NEW_TICKER, exit: { max_hold_hours: 1 }, sizing: { usd_per_trade: 10, max_concurrent: 50, ...sizing } })
  await replay("sizing-base", sized({ base_usd: 5, max_usd: 100 }), from, to)
  await replay("sizing-mult", sized({ base_usd: 5, max_usd: 100, rules: [{ when: always, mult: 2 }] }), from, to)
  await replay("sizing-add", sized({ base_usd: 5, max_usd: 100, rules: [{ when: always, add: 3 }] }), from, to)
}

// --- filters ---

const PATTERNS = ["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "distribution", "kol_mention"]

async function filters() {
  const since = iso(Date.now() - 3 * 3_600_000)
  for (const pattern of PATTERNS) {
    await record(`tape-${pattern}`, "GET", "/v1/signals", { pattern, since, limit: "200" })
    await record(`tape-${pattern}-all`, "GET", "/v1/signals", { pattern, since, limit: "200", quality: "all" })
  }
  await record("tape-direction", "GET", "/v1/signals", { pattern: "large_move", direction: "in", limit: "5" })
  await record("tape-min-usd", "GET", "/v1/signals", { pattern: "large_move", min_usd: "1000", limit: "5" })
  await record("tape-groups-unknown-param", "GET", "/v1/signals", { groups: "x", limit: "5" })
  // Where a live read of trade signals or conviction might be: none is documented.
  for (const [n, route, q] of [
    ["trade-signals", "/v1/trade-signals", {}],
    ["trade-signals-lab", "/v1/strategy-lab/trade-signals", {}],
    ["signals-trade-signal", "/v1/signals", { pattern: "trade_signal" }],
    ["signals-source-trade-signal", "/v1/signals", { source: "trade_signal" }],
    ["conviction", "/v1/conviction", {}],
    ["conviction-lab", "/v1/strategy-lab/conviction", {}],
    ["me-trade-signals", "/v1/me/trade-signals", {}],
    ["signals-stream-trade", "/v1/signals/trade", {}],
  ] as [string, string, Record<string, string>][])
    await record(`live-${n}`, "GET", route, q)
}

// --- the hour ---

function openSocket() {
  const url = new URL("/v1/signals/stream", HACC.replace("https", "wss"))
  return new WebSocket(url.toString(), { headers: { authorization: `Bearer ${key}` } } as unknown as string[])
}

const HOUR_DEFS: [string, Def][] = [
  ["hour-new-ticker", { chain: "solana", entry: { source: "pattern", pattern: "new_ticker", filters: { max_mcap_usd: 1_000_000 } }, exit: { take_profit_pct: 50, stop_loss_pct: 30, max_hold_hours: 1 }, sizing: { usd_per_trade: 10, max_concurrent: 20 } }],
  ["hour-confluence", { chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } }, exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 }, sizing: { usd_per_trade: 10, max_concurrent: 20 } }],
]
/** Filters the row itself carries, replayed over the same hour after it (`hour-extra`). */
const EXTRA_DEFS: [string, Def][] = [
  ["hour-groups", { chain: "solana", entry: { source: "pattern", pattern: "new_ticker", filters: { groups: ["serial"] } }, exit: { max_hold_hours: 1 }, sizing: { usd_per_trade: 10, max_concurrent: 50 } }],
  ["hour-usd-direction", { chain: "solana", entry: { source: "pattern", pattern: "large_move", filters: { min_usd: 15_000, direction: "in" } }, exit: { max_hold_hours: 1 }, sizing: { usd_per_trade: 10, max_concurrent: 50 } }],
]

/** No filters and slots enough for every token, so only the tape, the timing and one position a token can differ. */
const CLEAN_DEFS: [string, Def][] = [
  ["hour-clean-new-ticker", { chain: "solana", entry: { source: "pattern", pattern: "new_ticker", filters: {} }, exit: { max_hold_hours: 1 }, sizing: { usd_per_trade: 10, max_concurrent: 1000 } }],
  ["hour-clean-confluence", { chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: {} }, exit: { max_hold_hours: 1 }, sizing: { usd_per_trade: 10, max_concurrent: 1000 } }],
]

async function hourExtra(defs: [string, Def][]) {
  const stream = read("hour-stream")
  for (const [name, def] of defs) await replay(name, def, Number(stream.from), Number(stream.to))
}

async function hour() {
  const minutes = Number(opts.minutes)
  const heard: { at: number; row: Row }[] = []
  const markets: Row[] = []
  const ws = openSocket()
  let openedAt = 0
  ws.onopen = () => (openedAt = Date.now())
  ws.onmessage = (e) => {
    const at = Date.now()
    let frame: Row
    try {
      frame = JSON.parse(String(e.data)) as Row
    } catch {
      return
    }
    if (frame.type !== "signal" || !frame.signal) return
    const row = frame.signal as Row
    heard.push({ at, row })
    const mint = (row.payload as Row | undefined)?.asset_address ?? row.asset_address
    if (typeof mint === "string" && row.asset_chain !== "hood") void call("candle", "GET", `/api/v1/markets/solana/${mint}`).then((m) => markets.push({ signalId: row.id, mint, at: m.at, ms: m.ms, status: m.status, answer: m.answer }))
  }
  ws.onerror = () => {}
  while (!openedAt) await Bun.sleep(100)
  const from = openedAt
  console.log(`hour: stream open, listening ${minutes} min`)
  for (let m = 0; m < minutes; m++) {
    await Bun.sleep(60_000)
    if ((m + 1) % 10 === 0) console.log(`hour: ${m + 1} min, ${heard.length} signals`)
  }
  const to = Date.now()
  await new Promise<void>((done) => ((ws.onclose = () => done()), ws.close(), setTimeout(done, 1_000)))
  await Bun.sleep(5_000)
  write("hour-stream", { name: "hour-stream", from, to, signals: heard, markets })
  console.log(`hour: ${heard.length} signals, ${markets.length} market reads; waiting 2 min before reading back`)
  await Bun.sleep(120_000)
  for (const pattern of PATTERNS)
    for (const quality of ["", "all"]) {
      const rows: Row[] = []
      for (let offset = 0; offset < 2_000; offset += 200) {
        const rec = await call("hacc", "GET", "/v1/signals", { pattern, since: iso(from), until: iso(to), limit: "200", offset: String(offset), order: "asc", ...(quality ? { quality } : {}) })
        const page = rowsOf(rec.answer)
        rows.push(...page)
        if (page.length < 200) break
      }
      write(`hour-rest-${pattern}${quality ? "-all" : ""}`, { name: `hour-rest-${pattern}`, from, to, quality: quality || "curated", rows })
    }
  // Each candidate's age, by Hacc's own filter, as the core asks it.
  const ages: Row[] = []
  for (const { row } of heard) {
    const [, def] = HOUR_DEFS.find(([, d]) => d.entry.pattern === row.pattern) ?? []
    const maxAge = (def?.entry.filters as Row | undefined)?.max_age_minutes
    if (maxAge === undefined) continue
    const mint = (row.payload as Row | undefined)?.asset_address ?? row.asset_address
    const rec = await call("hacc", "GET", "/v1/signals", { asset: String(mint), pattern: String(row.pattern), since: iso(Date.parse(String(row.created_at)) - 1), limit: "20", max_age_minutes: String(maxAge) })
    ages.push({ signalId: row.id, status: rec.status, passes: rowsOf(rec.answer).some((r) => r.id === row.id) })
  }
  write("hour-ages", { name: "hour-ages", ages })
  for (const [name, def] of HOUR_DEFS) await replay(name, def, from, to)
}

// --- compare ---

/** The core's matcher, sketched: a definition's pattern and the filters the core checks, over the stream as heard. */
interface Sketch {
  signalId: unknown
  assetId: unknown
  createdAt: unknown
  mcap: number | undefined
  enters: boolean
  why: string | undefined
}
function match(def: Def, stream: { at: number; row: Row }[], markets: Row[], ages: Row[]): Sketch[] {
  const f = (def.entry.filters ?? {}) as Row
  const mcapOf = new Map(markets.map((m) => [m.signalId, Number(((m.answer as Row)?.market as Row | undefined)?.marketCap ?? Number.NaN)]))
  const ageOf = new Map(ages.map((a) => [a.signalId, a.passes as boolean]))
  const out: Sketch[] = []
  for (const { row } of stream) {
    if (row.pattern !== def.entry.pattern) continue
    if (row.asset_chain === "hood") continue
    const mcap = mcapOf.get(row.id)
    let why: string | undefined
    if ((f.max_mcap_usd !== undefined || f.min_mcap_usd !== undefined) && !(mcap !== undefined && Number.isFinite(mcap))) why = "no market cap"
    else if (f.max_mcap_usd !== undefined && !(mcap! < Number(f.max_mcap_usd))) why = `market cap ${Math.round(mcap!)}`
    else if (f.min_mcap_usd !== undefined && !(mcap! > Number(f.min_mcap_usd))) why = `market cap ${Math.round(mcap!)}`
    else if (f.max_age_minutes !== undefined && ageOf.get(row.id) !== true) why = "age"
    else if (Array.isArray(f.groups) && !(f.groups as string[]).some((g) => ((row.wallet_groups as string[] | undefined) ?? []).includes(g))) why = "groups"
    else if (f.direction !== undefined && (row.payload as Row | undefined)?.direction !== f.direction) why = `direction ${String((row.payload as Row | undefined)?.direction)}`
    else if (f.min_usd !== undefined && !(Number((row.payload as Row | undefined)?.usd_value) >= Number(f.min_usd))) why = `usd ${String((row.payload as Row | undefined)?.usd_value)}`
    out.push({ signalId: row.id, assetId: row.asset_id, createdAt: row.created_at, mcap, enters: why === undefined, why })
  }
  return out
}

function compare() {
  const stream = read("hour-stream")
  const ages = existsSync(join(out, "hour-ages.json")) ? (read("hour-ages").ages as Row[]) : []
  const report: Row = {}
  for (const [name, def] of [...HOUR_DEFS, ...EXTRA_DEFS, ...CLEAN_DEFS]) {
    if (!existsSync(join(out, `${name}-result.json`))) continue
    const result = read(`${name}-result`)
    const trades = (((result.answer as Row)?.result as Row)?.trades ?? []) as Row[]
    const replayed = new Map(trades.map((t) => [(t.reason_opened as Row | undefined)?.signal_id ?? t.signal_id, t]))
    const sketched = match(def, stream.signals as { at: number; row: Row }[], stream.markets as Row[], ages)
    const rows = sketched.map((s) => ({ ...s, replay: replayed.has(s.signalId) }))
    const heardIds = new Set(sketched.map((s) => s.signalId))
    const onlyReplay = [...replayed.keys()].filter((id) => !heardIds.has(id))
    report[name] = {
      sketchEnters: rows.filter((r) => r.enters).length,
      replayTrades: trades.length,
      both: rows.filter((r) => r.enters && r.replay).length,
      sketchOnly: rows.filter((r) => r.enters && !r.replay),
      replaySkippedBySketch: rows.filter((r) => !r.enters && r.replay),
      replayNotHeard: onlyReplay,
      skips: ((result.answer as Row)?.result as Row)?.skips ?? null,
    }
    console.log(`compare ${name}: sketch ${report[name] && (report[name] as Row).sketchEnters}, replay ${trades.length}, both ${(report[name] as Row).both}`)
  }
  write("hour-compare", report)
}

console.log(`Recording into ${out}`)
if (phases.has("schema")) await schema()
if (phases.has("runs")) await runs()
if (phases.has("filters")) await filters()
if (phases.has("exits")) await exits()
if (phases.has("sizing")) await sizing()
if (phases.has("semantics")) await semantics()
if (phases.has("hour")) await hour()
if (phases.has("hour-extra")) await hourExtra(EXTRA_DEFS)
if (phases.has("hour-clean")) await hourExtra(CLEAN_DEFS)
if (phases.has("compare")) compare()
console.log("Done. The recordings name real tokens and the account's own; scrub them before anything is committed.")
