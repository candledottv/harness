// Records what triggers rest on, from Hacc (`api.hacc.fun`) and Candle (`api.alpha.candle.tv`), for the fakes
// and the fixtures. Nothing here trades or saves anything; only `mine-watch` changes Hacc's follows, and undoes them. The keys are read from files,
// sent only to their own hosts, never printed, and redacted from every recording.
//
//   bun test/record-triggers.ts [--key-file PATH] [--free-key-file PATH] [--agents a=<prefix>,...]
//                               [--out DIR] [--only prices,refresh,staleness,tape,reopen,mine,mine-again,mine-watch,entry,cost] [--minutes 15]
//
// - `prices`: Hacc's price read for 1, 10 and 20 tokens, Solana and Hood, an unknown token, and past 20.
// - `refresh`: how many token sets Hacc's price read refreshes from its provider before it answers with no
//   prices ("Request rate limit reached"), and how soon it refreshes again.
// - `staleness`: Hacc's prices against Candle's market read for the same busy tokens, every 5 s for `--minutes`,
//   to see how old each source's price is and which follows the other.
// - `tape`: a stream row, then the tape filtered to that row's token and pattern (a definition's filters), to see
//   whether and how soon the filtered read has the row.
// - `reopen`: the stream's opening snapshot against the time it opened, then a gap refilled by date, checked
//   against a second socket that stayed open across the gap.
// - `mine` saves personal signals' cursor; `mine-again`, run later, reads after it. `mine-watch` follows three
//   busy wallets for `--minutes` so the rules have something to fire on, then unfollows them (it changes Hacc's
//   follows on the account, and nothing else).
// - `entry`: each agent's open positions from the P&L read, with the fills that made them.
// - `cost`: whether a token's market read counts toward a key's per-minute limit, on a Free key (30 a minute):
//   40 market reads, then a P&L read; then, a minute later, P&L reads until the limit answers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { apiKeyPrefix } from "../src/shared/api-key"
import { Redactor } from "../src/shared/redact"

const HACC = "https://api.hacc.fun"
const CANDLE = "https://api.alpha.candle.tv"
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"

const { values: opts } = parseArgs({
  options: {
    "key-file": { type: "string", default: process.env.CANDLE_HARNESS_TEST_KEY_FILE },
    "free-key-file": { type: "string" },
    agents: { type: "string", default: "" },
    out: { type: "string" },
    only: { type: "string", default: "prices,mine,entry" },
    minutes: { type: "string", default: "15" },
  },
})
const phases = new Set(opts.only!.split(","))
if (!opts["key-file"]) throw new Error("name the Read key's file: --key-file <path>, or CANDLE_HARNESS_TEST_KEY_FILE")
const key = readFileSync(opts["key-file"], "utf8").trim()
if (!apiKeyPrefix(key)) throw new Error("the key file doesn't hold a Candle key")
const freeKey = opts["free-key-file"] ? readFileSync(opts["free-key-file"], "utf8").trim() : undefined
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
if (freeKey) redactor.add(freeKey)
const out = resolve(opts.out ?? `test/fixtures/raw/triggers-${new Date().toISOString().slice(0, 10)}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

type Row = Record<string, unknown>
export interface TriggerRecording {
  name: string
  host: "hacc" | "candle"
  route: string
  query: Record<string, string>
  status: number | "timeout" | "error"
  /** When the request was sent, epoch ms, and how long it took. */
  at: number
  ms: number
  bytes: number
  answer: unknown
}

function write(name: string, value: unknown) {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(redactor.value(value), null, 2)}\n`, { mode: 0o600 })
}

async function call(host: "hacc" | "candle", route: string, query: Record<string, string> = {}, o: { as?: string; quiet?: boolean } = {}): Promise<TriggerRecording> {
  const url = new URL(route, host === "hacc" ? HACC : CANDLE)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const k = o.as ?? key
  const headers: Record<string, string> = host === "hacc" ? { accept: "application/json", authorization: `Bearer ${k}` } : { accept: "application/json", "x-api-key": k }
  const at = Date.now()
  const started = performance.now()
  try {
    const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    let answer: unknown = text
    try {
      answer = JSON.parse(text)
    } catch {}
    return { name: "", host, route, query, status: res.status, at, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text), answer }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
    return { name: "", host, route, query, status: timeout ? "timeout" : "error", at, ms: Math.round(performance.now() - started), bytes: 0, answer: String(e) }
  }
}

async function record(name: string, host: "hacc" | "candle", route: string, query: Record<string, string> = {}, o: { as?: string } = {}) {
  const rec = { ...(await call(host, route, query, o)), name }
  write(name, rec)
  console.log(`${String(rec.status).padEnd(7)} ${String(rec.ms).padStart(6)} ms ${String(rec.bytes).padStart(8)} B  ${name}`)
  return rec
}

const rowsOf = (answer: unknown): Row[] => {
  if (Array.isArray(answer)) return answer as Row[]
  if (answer && typeof answer === "object")
    for (const k of ["data", "signals", "rows", "items", "prices"]) {
      const v = (answer as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  return []
}
const unique = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0))]

/** Distinct tokens from the tape, newest first, on one chain. */
async function tapeTokens(chain: "solana" | "hood", n: number): Promise<string[]> {
  const tape = await call("hacc", "/v1/signals", { chain, limit: "200" })
  return unique(rowsOf(tape.answer).map((r) => r.asset_address as string | undefined)).slice(0, n)
}

// --- prices ---

async function prices() {
  const sol = await tapeTokens("solana", 60)
  const hood = await tapeTokens("hood", 10)
  console.log(`prices: ${sol.length} Solana tokens and ${hood.length} Hood tokens from the tape`)
  const sixty = [JUP, ...sol.filter((m) => m !== JUP)].slice(0, 60)
  // With none named, before the burst below and again after it: Hacc answers the two differently.
  await record("prices-none", "hacc", "/v1/market/prices", {})
  // The docs say 60 a request; Hacc answers "At most 20 addresses per request" past 20.
  for (const n of [1, 10, 20]) for (let i = 1; i <= 3; i++) await record(`prices-solana-${n}-${i}`, "hacc", "/v1/market/prices", { addresses: sixty.slice(0, n).join(",") })
  const twenty = await call("hacc", "/v1/market/prices", { addresses: sixty.slice(0, 20).join(",") })
  // Tokens Hacc doesn't price: does Candle's market read?
  const unpriced = rowsOf(twenty.answer).filter((r) => r.price_usd === null).map((r) => String(r.address))
  for (const [i, m] of unpriced.slice(0, 5).entries()) await record(`candle-market-unpriced-${i}`, "candle", `/api/v1/markets/solana/${m}`)
  await record("prices-solana-60", "hacc", "/v1/market/prices", { addresses: sixty.join(",") })
  if (hood.length) {
    await record("prices-hood", "hacc", "/v1/market/prices", { addresses: hood.join(",") })
    await record("prices-hood-chain", "hacc", "/v1/market/prices", { addresses: hood.join(","), chain: "hood" })
    await record("prices-mixed", "hacc", "/v1/market/prices", { addresses: [JUP, ...hood.slice(0, 2)].join(",") })
  }
  await record("prices-unknown", "hacc", "/v1/market/prices", { addresses: `${JUP},11111111111111111111111111111111` })
  await record("prices-malformed", "hacc", "/v1/market/prices", { addresses: `${JUP},not-an-address` })
  await record("prices-none-burst", "hacc", "/v1/market/prices", {})
  await record("prices-solana-21", "hacc", "/v1/market/prices", { addresses: sixty.slice(0, 21).join(",") })
  // Candle's own read of the same token, for the fields side by side.
  await record("candle-market-jup", "candle", `/api/v1/markets/solana/${JUP}`)
  if (hood[0]) await record("candle-market-hood", "candle", `/api/v1/markets/hood/${hood[0]}`)
}

/**
 * Hacc's refresh limit: after two quiet minutes, single-token reads of tokens not yet read, one after another,
 * until a read is refused its refresh; then a new token every 10 s until one refreshes again.
 */
async function refreshLimit() {
  const tokens = await tapeTokens("solana", 60)
  console.log(`refresh: ${tokens.length} tokens; quiet for 120 s first`)
  await Bun.sleep(120_000)
  const reads: { at: number; ms: number; status: TriggerRecording["status"]; source?: unknown; refused?: unknown; priced: boolean }[] = []
  const one = async (mint: string) => {
    const rec = await call("hacc", "/v1/market/prices", { addresses: mint })
    const a = rec.answer as Row
    const p = (a?.provenance as Row | undefined) ?? a
    reads.push({ at: rec.at, ms: rec.ms, status: rec.status, source: p?.source, refused: p?.refresh_refused, priced: rowsOf(a).length > 0 })
    return { rec, refused: typeof p?.refresh_refused === "string" }
  }
  let i = 0
  let first: Awaited<ReturnType<typeof one>> | undefined
  for (; i < 40 && i < tokens.length; i++) {
    const r = await one(tokens[i]!)
    if (r.refused) {
      first = r
      break
    }
  }
  console.log(`refresh: ${i} fresh reads before one was refused`)
  if (first) write("prices-refresh-refused", { ...first.rec, name: "prices-refresh-refused" })
  const refusedAt = Date.now()
  for (i++; first && i < tokens.length && Date.now() - refusedAt < 5 * 60_000; i++) {
    await Bun.sleep(10_000)
    if (!(await one(tokens[i]!)).refused) break
  }
  console.log(`refresh: refreshed again ${Math.round((Date.now() - refusedAt) / 1000)} s after the refusal`)
  write("refresh-limit", { reads })
}

// --- staleness: both sources, side by side, every 5 s ---

interface Sample {
  at: number
  hacc: { ms: number; status: TriggerRecording["status"]; provenance?: unknown; prices: Record<string, { price?: number; mcap?: number }> }
  candle: Record<string, { ms: number; status: TriggerRecording["status"]; price?: number; mcap?: number }>
}

async function staleness() {
  const feed = await call("candle", "/api/v1/markets/feed", { bucket: "onfire", chain: "solana", fields: "priceUsd,volume1h,marketCap", limit: "20" })
  const onfire = ((feed.answer as Row)?.tokens as Row[] | undefined) ?? []
  const busy = onfire
    .filter((t) => typeof t.volume1h === "number")
    .sort((a, b) => (b.volume1h as number) - (a.volume1h as number))
    .map((t) => t.address as string)
  const tokens = unique([JUP, ...busy]).slice(0, 6)
  console.log(`staleness: ${tokens.length} tokens, every 5 s for ${opts.minutes} min`)
  const samples: Sample[] = []
  const end = Date.now() + Number(opts.minutes) * 60_000
  while (Date.now() < end) {
    const tick = Date.now()
    const [h, ...c] = await Promise.all([
      call("hacc", "/v1/market/prices", { addresses: tokens.join(",") }),
      ...tokens.map((m) => call("candle", `/api/v1/markets/solana/${m}`)),
    ])
    const hp: Sample["hacc"]["prices"] = {}
    for (const r of rowsOf(h!.answer)) hp[r.address as string] = { price: (r.price_usd as number | null) ?? undefined, mcap: (r.market_cap_usd as number | null) ?? undefined }
    const cp: Sample["candle"] = {}
    tokens.forEach((m, i) => {
      const market = ((c[i]!.answer as Row)?.market as Row | undefined) ?? {}
      cp[m] = { ms: c[i]!.ms, status: c[i]!.status, price: market.priceUsd as number | undefined, mcap: market.marketCap as number | undefined }
    })
    samples.push({ at: tick, hacc: { ms: h!.ms, status: h!.status, provenance: (h!.answer as Row)?.provenance, prices: hp }, candle: cp })
    if (samples.length % 12 === 0) console.log(`staleness: ${samples.length} samples`)
    await Bun.sleep(Math.max(0, 5_000 - (Date.now() - tick)))
  }
  write("staleness", { tokens, everyMs: 5_000, samples })
  write("staleness-summary", summarise(tokens, samples))
  console.log(JSON.stringify(summarise(tokens, samples), null, 2))
}

/** How long each source holds one price, how far apart they are, and at what lag Hacc's moves best follow Candle's. */
export function summarise(tokens: string[], samples: Sample[]) {
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : undefined)
  const holds = (series: (number | undefined)[]) => {
    const runs: number[] = []
    let run = 0
    for (let i = 1; i < series.length; i++) {
      run++
      if (series[i] !== series[i - 1]) (runs.push(run * 5), (run = 0))
    }
    return { changes: runs.length, medianHoldS: median(runs), longestHoldS: runs.length ? Math.max(...runs) : undefined }
  }
  const provenance = samples.map((s) => s.hacc.provenance as Row | undefined)
  const sources = unique(provenance.map((p) => p?.source as string | undefined))
  // A fresh read names `retrieved_at`; a stored snapshot names `observed_at`. Either is when Hacc's price was taken.
  const takenAt = (p: Row | undefined) => (typeof p?.retrieved_at === "string" ? p.retrieved_at : typeof p?.observed_at === "string" ? p.observed_at : undefined)
  const ages = provenance.map((p, i) => (takenAt(p) ? samples[i]!.at + samples[i]!.hacc.ms - Date.parse(takenAt(p)!) : undefined)).filter((x): x is number => x !== undefined)
  const bySource = Object.fromEntries(sources.map((src) => [src, provenance.filter((p) => p?.source === src).length]))
  return {
    samples: samples.length,
    haccMs: { median: median(samples.map((s) => s.hacc.ms)), max: Math.max(...samples.map((s) => s.hacc.ms)) },
    candleMs: { median: median(samples.flatMap((s) => Object.values(s.candle).map((c) => c.ms))), max: Math.max(...samples.flatMap((s) => Object.values(s.candle).map((c) => c.ms))) },
    haccProvenance: { bySource, stale: provenance.filter((p) => p?.stale === true).length, refused: unique(provenance.map((p) => p?.refresh_refused as string | undefined)), ageAtAnswerMs: { median: median(ages), max: ages.length ? Math.max(...ages) : undefined } },
    tokens: tokens.map((m, i) => {
      const hs = samples.map((s) => s.hacc.prices[m]?.price)
      const cs = samples.map((s) => s.candle[m]?.price)
      const gaps = samples.map((s) => (s.hacc.prices[m]?.price && s.candle[m]?.price ? Math.abs(s.hacc.prices[m]!.price! / s.candle[m]!.price! - 1) * 100 : undefined)).filter((x): x is number => x !== undefined)
      // Log returns per 5 s step; the lag (in steps) where Hacc's returns best match Candle's earlier ones.
      const ret = (xs: (number | undefined)[]) => xs.map((x, j) => (j && x && xs[j - 1] ? Math.log(x / xs[j - 1]!) : 0))
      const hr = ret(hs)
      const cr = ret(cs)
      let best = { lagS: 0, corr: -2 }
      for (let lag = -12; lag <= 12; lag++) {
        const pairs: [number, number][] = []
        for (let j = 0; j < hr.length; j++) if (j - lag >= 0 && j - lag < cr.length) pairs.push([hr[j]!, cr[j - lag]!])
        const mh = pairs.reduce((a, p) => a + p[0], 0) / pairs.length
        const mc = pairs.reduce((a, p) => a + p[1], 0) / pairs.length
        const cov = pairs.reduce((a, p) => a + (p[0] - mh) * (p[1] - mc), 0)
        const vh = Math.sqrt(pairs.reduce((a, p) => a + (p[0] - mh) ** 2, 0))
        const vc = Math.sqrt(pairs.reduce((a, p) => a + (p[1] - mc) ** 2, 0))
        const corr = vh && vc ? cov / (vh * vc) : 0
        if (corr > best.corr) best = { lagS: lag * 5, corr: Math.round(corr * 100) / 100 }
      }
      return {
        token: i === 0 && m === JUP ? "JUP" : `busy-${i}`,
        hacc: holds(hs),
        candle: holds(cs),
        gapPct: { median: median(gaps), max: gaps.length ? Math.max(...gaps) : undefined },
        haccFollowsCandleBy: best,
        mcap: { hacc: samples.some((s) => s.hacc.prices[m]?.mcap !== undefined), candle: samples.some((s) => s.candle[m]?.mcap !== undefined) },
      }
    }),
  }
}

// --- the stream ---

function openSocket(query: Record<string, string> = {}) {
  const url = new URL("/v1/signals/stream", HACC.replace("https", "wss"))
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new WebSocket(url.toString(), { headers: { authorization: `Bearer ${key}` } } as unknown as string[])
}

interface Heard {
  at: number
  kind: "snapshot" | "signal"
  rows: Row[]
}
/** A socket that keeps every snapshot and signal frame, with the time it arrived, until `stop`. */
function listener(onSignal?: (row: Row, at: number) => void) {
  const heard: Heard[] = []
  const ws = openSocket()
  let openedAt: number | undefined
  ws.onopen = () => (openedAt = Date.now())
  ws.onmessage = (e) => {
    const at = Date.now()
    let frame: Row
    try {
      frame = JSON.parse(String(e.data)) as Row
    } catch {
      return
    }
    if (frame.type === "snapshot") heard.push({ at, kind: "snapshot", rows: (frame.signals as Row[]) ?? [] })
    if (frame.type === "signal" && frame.signal) {
      heard.push({ at, kind: "signal", rows: [frame.signal as Row] })
      onSignal?.(frame.signal as Row, at)
    }
  }
  ws.onerror = () => {}
  return {
    heard,
    opened: () => openedAt,
    stop: () => new Promise<void>((done) => ((ws.onclose = () => done()), ws.close(), setTimeout(done, 1_000))),
  }
}

const createdMs = (r: Row) => Date.parse(String(r.created_at))

async function tape() {
  // Filters a definition can carry that the stream can't: wide enough that the row passes, and a control that
  // nothing passes, so the filter is seen to apply.
  const WIDE = { max_mcap_usd: "1000000000000", max_age_minutes: "5256000" }
  const NONE = { max_mcap_usd: "1" }
  const checks: Promise<unknown>[] = []
  let lastCheck = 0
  const results: unknown[] = []
  const check = async (row: Row, heardAt: number) => {
    const asset = String(row.asset_address ?? "")
    const pattern = String(row.pattern ?? "")
    if (!asset || !pattern) return
    const since = new Date(createdMs(row) - 1).toISOString()
    const base = { asset, pattern, since, limit: "20", ...(row.chain === "hood" ? { chain: "hood" } : {}) }
    const tries: { afterS: number; ms: number; status: TriggerRecording["status"]; found: boolean; mcapFields: string[] }[] = []
    for (const afterS of [0, 2, 5, 10, 30, 60]) {
      await Bun.sleep(Math.max(0, heardAt + afterS * 1000 - Date.now()))
      const rec = await call("hacc", "/v1/signals", { ...base, ...WIDE })
      const hit = rowsOf(rec.answer).find((r) => r.id === row.id)
      tries.push({ afterS, ms: rec.ms, status: rec.status, found: !!hit, mcapFields: hit ? Object.keys(hit).filter((k) => /mcap|market_cap|age/i.test(k)) : [] })
      if (hit) {
        write(`tape-filtered-${results.length}`, { ...rec, name: `tape-filtered-${results.length}`, streamRow: row })
        break
      }
    }
    const none = await call("hacc", "/v1/signals", { ...base, ...NONE })
    results.push({ pattern, chain: row.chain, createdToHeardMs: heardAt - createdMs(row), streamKeys: Object.keys(row), tries, controlRows: rowsOf(none.answer).length, controlStatus: none.status })
    console.log(`tape: ${pattern} ${tries.at(-1)?.found ? `found after ${tries.at(-1)!.afterS} s (${tries.at(-1)!.ms} ms)` : "not found"}, control ${rowsOf(none.answer).length} rows`)
  }
  const sock = listener((row, at) => {
    if (results.length + checks.length >= 12 || at - lastCheck < 10_000) return
    lastCheck = at
    checks.push(check(row, at))
  })
  const until = Date.now() + 6 * 60_000
  while (checks.length < 12 && Date.now() < until) await Bun.sleep(1_000)
  await Promise.all(checks)
  await sock.stop()
  write("tape-two-steps", { wide: WIDE, none: NONE, results })
}

async function reopen() {
  const control = listener()
  await Bun.sleep(3_000)
  const first = listener()
  await Bun.sleep(30_000)
  await first.stop()
  const closedAt = Date.now()
  const snapshot = first.heard.find((h) => h.kind === "snapshot")
  const openedAt = first.opened() ?? closedAt
  const snapAges = (snapshot?.rows ?? []).map((r) => openedAt - createdMs(r))
  const lastHeard = first.heard.flatMap((h) => h.rows).map(createdMs).sort((a, b) => a - b).at(-1)
  console.log(`reopen: snapshot ${snapshot?.rows.length ?? 0} rows, newest ${Math.min(...snapAges)} ms old, oldest ${Math.max(...snapAges)} ms; closed for 90 s`)
  await Bun.sleep(90_000)
  // The gap, refilled by date from the last row heard (1 ms early, as the core does), paged by the newest date.
  const refill: Row[] = []
  let since = new Date((lastHeard ?? closedAt) - 1).toISOString()
  for (let page = 0; page < 5; page++) {
    const rec = await record(`reopen-refill-${page}`, "hacc", "/v1/signals", { since, order: "asc", limit: "200" })
    const rows = rowsOf(rec.answer)
    refill.push(...rows)
    if (rows.length < 200) break
    since = String(rows.at(-1)!.created_at)
  }
  const second = listener()
  await Bun.sleep(20_000)
  await second.stop()
  await control.stop()
  const gapStart = closedAt
  const gapEnd = second.opened() ?? Date.now()
  const inGap = control.heard.filter((h) => h.kind === "signal" && h.at >= gapStart && h.at <= gapEnd).flatMap((h) => h.rows)
  const refilled = new Set([...refill, ...(second.heard.find((h) => h.kind === "snapshot")?.rows ?? [])].map((r) => r.id))
  const missing = inGap.filter((r) => !refilled.has(r.id))
  const firstIds = new Set(first.heard.flatMap((h) => h.rows).map((r) => r.id))
  const twice = refill.filter((r) => firstIds.has(r.id)).length
  const summary = {
    snapshot: { rows: snapshot?.rows.length ?? 0, newestAgeMs: snapAges.length ? Math.min(...snapAges) : undefined, oldestAgeMs: snapAges.length ? Math.max(...snapAges) : undefined, olderThanOpen: snapAges.filter((a) => a > 0).length },
    gapS: Math.round((gapEnd - gapStart) / 1000),
    controlHeardInGap: inGap.length,
    refillRows: refill.length,
    refillAlreadyHeard: twice,
    missingFromRefill: missing.length,
    missing: missing.map((r) => ({ id: r.id, created_at: r.created_at, pattern: r.pattern })),
  }
  write("reopen", { summary, control: control.heard, first: first.heard, second: second.heard })
  console.log(`reopen: ${JSON.stringify(summary)}`)
}

// --- personal signals' cursor ---

async function mine() {
  await record("mine-rules", "hacc", "/v1/me/rules")
  const rec = await record("mine-signals", "hacc", "/v1/me/signals", { limit: "200" })
  const next = (rec.answer as Row)?.next_after
  write("mine-cursor", { at: Date.now(), next_after: next ?? null, rows: rowsOf(rec.answer).length })
  console.log(`mine: ${rowsOf(rec.answer).length} rows, next_after ${next ?? "null"}`)
}

async function mineAgain() {
  const file = join(out, "mine-cursor.json")
  if (!existsSync(file)) throw new Error("run --only mine first, into the same --out")
  const saved = JSON.parse(readFileSync(file, "utf8")) as { at: number; next_after: number | string | null }
  console.log(`mine-again: ${Math.round((Date.now() - saved.at) / 60_000)} min after the cursor was saved`)
  if (saved.next_after !== null) await record("mine-again-after", "hacc", "/v1/me/signals", { after: String(saved.next_after), limit: "200" })
  await record("mine-again-fresh", "hacc", "/v1/me/signals", { limit: "200" })
}

/**
 * The cursor over an hour, with something to read: the account follows the tape's three busiest wallets for
 * `--minutes` (its rules apply to followed wallets), personal signals are read every 5 minutes, and at the end the
 * cursor saved at the start is read back. The follows are undone at the end, whatever happens; their ids are
 * written first, so a run that's killed can be undone by hand.
 */
async function mineWatch() {
  const tapeRows = rowsOf((await call("hacc", "/v1/signals", { chain: "solana", limit: "200" })).answer)
  const counts = new Map<string, number>()
  for (const r of tapeRows) if (typeof r.wallet_address === "string") counts.set(r.wallet_address, (counts.get(r.wallet_address) ?? 0) + 1)
  const busiest = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w)
  const followIds: string[] = []
  try {
    for (const [i, address] of busiest.entries()) {
      const url = new URL("/v1/me/follows", HACC)
      const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ chain: "solana", address }), redirect: "error" })
      const answer = (await res.json().catch(() => null)) as Row | null
      const id = (answer?.follow as Row | undefined)?.id ?? answer?.id
      write(`mine-watch-follow-${i}`, { status: res.status, answer })
      if (id !== undefined) followIds.push(String(id))
      write("mine-watch-follow-ids", followIds)
    }
    console.log(`mine-watch: following ${followIds.length} wallets for ${opts.minutes} min`)
    const start = await record("mine-watch-start", "hacc", "/v1/me/signals", { limit: "200" })
    let cursor = (start.answer as Row)?.next_after as number | string | null | undefined
    // The cursor to read back at the end: the first one Hacc gives, since the account may have had no rows yet.
    let first = cursor
    const polls: unknown[] = []
    const end = Date.now() + Number(opts.minutes) * 60_000
    for (let i = 1; Date.now() < end; i++) {
      await Bun.sleep(Math.min(5 * 60_000, Math.max(0, end - Date.now())))
      const fresh = await call("hacc", "/v1/me/signals", { limit: "200" })
      const after = cursor === null || cursor === undefined ? undefined : await call("hacc", "/v1/me/signals", { after: String(cursor), limit: "200" })
      const next = ((after ?? fresh).answer as Row)?.next_after as number | string | null | undefined
      polls.push({ at: Date.now(), cursor, freshRows: rowsOf(fresh.answer).length, freshNext: (fresh.answer as Row)?.next_after, afterRows: after ? rowsOf(after.answer).length : null, afterStatus: after?.status ?? null, next })
      console.log(`mine-watch: ${JSON.stringify(polls.at(-1))}`)
      if (next !== null && next !== undefined) cursor = next
      if ((first === null || first === undefined) && cursor !== null && cursor !== undefined) first = cursor
      if (i === 1 || rowsOf(fresh.answer).length) write(`mine-watch-poll-${i}`, { fresh, after })
    }
    const back = first === null || first === undefined ? undefined : await record("mine-watch-back-after-hour", "hacc", "/v1/me/signals", { after: String(first), limit: "200" })
    const latest = await record("mine-watch-end", "hacc", "/v1/me/signals", { limit: "200" })
    write("mine-watch", { firstCursor: first ?? null, polls, backRows: back ? rowsOf(back.answer).length : null, latestRows: rowsOf(latest.answer).length })
  } finally {
    for (const id of followIds) {
      const res = await fetch(new URL(`/v1/me/follows/${id}`, HACC), { method: "DELETE", headers: { authorization: `Bearer ${key}` }, redirect: "error" })
      console.log(`mine-watch: unfollow ${res.status}`)
    }
    await record("mine-watch-follows-after", "hacc", "/v1/me/follows")
  }
}

// --- the entry, from the cost book ---

async function entry() {
  for (const { label, prefix } of agents) {
    await record(`entry-pnl-${label}`, "candle", `/api/v1/agent/keys/${prefix}/pnl`)
    await record(`entry-trades-${label}`, "candle", `/api/v1/agent/keys/${prefix}/trades`, { limit: "200" })
  }
}

// --- whether a market read counts toward a key's limit ---

async function cost() {
  if (!freeKey) throw new Error("--only cost needs --free-key-file (a key on a Free account: its 30 a minute is reachable)")
  const prefix = apiKeyPrefix(freeKey)!
  const results: Row = {}
  const markets: (number | string)[] = []
  for (let i = 0; i < 40; i++) markets.push((await call("candle", `/api/v1/markets/solana/${JUP}`, {}, { as: freeKey })).status)
  const after = await call("candle", `/api/v1/agent/keys/${prefix}/pnl`, {}, { as: freeKey })
  results.marketReads = { statuses: markets, refused: markets.filter((s) => s === 429).length }
  results.pnlAfter = { status: after.status, error: (after.answer as Row)?.error ?? null }
  console.log(`cost: 40 market reads, ${markets.filter((s) => s === 429).length} refused; a P&L read after: ${after.status}`)
  await Bun.sleep(65_000)
  const pnls: (number | string)[] = []
  for (let i = 0; i < 40; i++) {
    const rec = await call("candle", `/api/v1/agent/keys/${prefix}/pnl`, {}, { as: freeKey })
    pnls.push(rec.status)
    if (rec.status === 429) {
      results.pnlRefusal = rec.answer
      break
    }
  }
  results.pnlReads = { statuses: pnls, refusedAt: pnls.indexOf(429) + 1 || null }
  console.log(`cost: control, P&L reads until refused: ${pnls.length}`)
  write("cost", results)
}

console.log(`Recording into ${out}`)
if (phases.has("prices")) await prices()
if (phases.has("refresh")) await refreshLimit()
if (phases.has("mine")) await mine()
if (phases.has("mine-again")) await mineAgain()
if (phases.has("mine-watch")) await mineWatch()
if (phases.has("entry")) await entry()
if (phases.has("cost")) await cost()
await Promise.all([phases.has("staleness") ? staleness() : undefined, phases.has("tape") ? tape() : undefined, phases.has("reopen") ? reopen() : undefined])
console.log("Done. The recordings name real tokens and the account's own; scrub them before anything is committed.")
