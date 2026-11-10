// A stand-in for Hacc (`api.hacc.fun`): HTTP and the signal stream, on a local port, with made-up data
// and no network. Its answers are the shapes recorded live from Hacc (test/record-hacc.ts,
// scrubbed into fixtures/hacc-recorded/ by scripts/scrub-hacc.ts; hacc-recorded.test.ts keeps it in
// step). Where nothing was recorded, it follows Candle's docs (docs.candle.tv/developers/data-and-strategy-api) and
// says so: the Free and Pro refusals and the caps' bodies weren't reachable on a Max account.
//
// Tests start it in-process, as the core's Hacc client calls it in-process:
//   const hacc = startFakeHacc({ keys: [key] }); … hacc.url, hacc.wsUrl; hacc.set({ plan: "pro" }); hacc.stop()
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ServerWebSocket } from "bun"

const dir = join(import.meta.dir, "fixtures/hacc-recorded")
type Json = Record<string, unknown>
interface Recording {
  name: string
  status: number | string
  answer: unknown
  frames?: { at: number; frame: unknown }[]
}
const recordings = new Map<string, Recording>()
// The Research recordings sit in research/; their names start research-, so they never clash.
// The triggers' recordings sit in triggers/; their names (prices-, tape-, mine-) don't clash either.
// The bots' sit in bots/, each name starting bots-.
for (const sub of [dir, join(dir, "research"), join(dir, "triggers"), join(dir, "bots")])
  for (const f of readdirSync(sub)) if (f.endsWith(".json")) recordings.set(f.slice(0, -5), JSON.parse(readFileSync(join(sub, f), "utf8")))

/** A fresh copy of a recorded answer. */
export function recorded(name: string): Json {
  const r = recordings.get(name)
  if (!r) throw new Error(`fake Hacc: no recording ${name}`)
  return structuredClone(r.answer) as Json
}
const rowOf = (name: string, field: string) => structuredClone((recorded(name)[field] as Json[])[0]) as Json

/** How long Hacc answered a price read from its stored snapshot before refreshing: 65 s, measured live. */
export const PRICE_REFRESH_MS = 65_000
/** Hacc's limit on those refreshes, as measured live: this many in this window. */
export const PRICE_REFRESH_LIMIT = 10
export const PRICE_REFRESH_WINDOW_MS = 60_000

const PATTERNS = ["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "distribution", "kol_mention"]

export type Plan = "free" | "pro" | "max"
export interface FakeHaccSwitches {
  plan: Plan
  /** Keys Hacc accepts. Anything else answers `401 invalid api key`, as a test or revoked key does. */
  keys: string[]
  /** Delay before answering, by route ("GET /v1/market/activity"). */
  slow: Record<string, number>
  /** A fixed answer by route, for refusals and redirects. */
  fail: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>
  maxSockets: number
  pingMs: number
  /** Polls a replay answers `running` before it ends, and how it ends. */
  replayPolls: number
  replayEnds: "done" | "timeout"
  /** Replays a day: the docs' 20. */
  replayQuota: number
  /**
   * Tokens the market read answers for by their own address, over the recorded answer's fields (which
   * name one recorded token whatever was asked): `{ [mint]: { market: {...}, safety: {...} } }`.
   */
  tokens: Record<string, { market?: Json; safety?: Json }>
  /**
   * What the price read answers per token (`/v1/market/prices`), by address: a token not here is priced
   * null, as Hacc answers a token it doesn't price. A Hood token is priced only when the read names
   * `chain=hood`, as recorded.
   */
  prices: Record<string, { price: number | null; mcap?: number | null; symbol?: string | null }>
  /** How long a price read is answered from Hacc's stored snapshot before it refreshes from its provider. */
  priceRefreshMs: number
  /** Refreshes from the provider Hacc makes for the key in PRICE_REFRESH_WINDOW_MS before it refuses one. */
  priceRefreshLimit: number
}
export interface FakeHaccCall {
  method: string
  path: string
  query: Record<string, string>
  auth: string | undefined
  body?: unknown
}

const CAPS: Record<Exclude<Plan, "free">, { follows: number; rules: number; groups: number; groupWallets: number }> = {
  pro: { follows: 25, rules: 20, groups: 1, groupWallets: 25 },
  max: { follows: 100, rules: 20, groups: 5, groupWallets: 25 },
}

export function startFakeHacc(initial: Partial<FakeHaccSwitches> & { keys: string[] }) {
  const sw: FakeHaccSwitches = { plan: "max", slow: {}, fail: {}, maxSockets: 8, pingMs: 20_000, replayPolls: 2, replayEnds: "done", replayQuota: 20, tokens: {}, prices: {}, priceRefreshMs: PRICE_REFRESH_MS, priceRefreshLimit: PRICE_REFRESH_LIMIT, ...initial }
  const calls: FakeHaccCall[] = []
  const sockets = new Set<ServerWebSocket<{ key: string }>>()

  // The tape: generated from one recorded row, newest last, so REST and the stream agree.
  const template = rowOf("signals-limit20", "signals")
  const tape: Json[] = []
  let nextId = Number(template.id) || 1000
  const addSignal = (patch: Json = {}) => {
    const row = { ...structuredClone(template), id: ++nextId, created_at: new Date().toISOString(), ...patch }
    tape.push(row)
    return row
  }
  // The oldest eight carry each pattern once and the ninth is on Hood, so a pattern or chain filter
  // finds a row; the newest hundred, which the snapshot and the default page show, are all the recorded row's.
  for (let i = 0; i < 120; i++) addSignal({ created_at: new Date(Date.now() - (120 - i) * 1000).toISOString(), ...(i < PATTERNS.length ? { pattern: PATTERNS[i] } : {}), ...(i === PATTERNS.length ? { asset_chain: "hood", wallet_chain: "hood" } : {}) })

  // The account's own state on Hacc.
  const follows: Json[] = []
  const rules: Json[] = []
  const groups: Json[] = []
  const strategies: Json[] = []
  // Signals the account's rules produced (`/v1/me/signals`): empty when recorded, filled by pushMine.
  const mine: Json[] = []
  const replays = new Map<number, { polls: number; status: string; key: string }>()
  let ids = 1
  const priceSnapshots = new Map<string, { at: number; prices: Json[] }>()
  const priceRefreshes: number[] = []

  const json = (status: number, body: unknown) => Response.json(body, { status })
  const err = (status: number, error: string, extra: Json = {}) => json(status, { error, ...extra })
  const needs = (plan: "pro" | "max"): Response | undefined => {
    if (plan === "pro" && sw.plan === "free") return err(403, "requires Pro or Max") // the docs' words
    if (plan === "max" && sw.plan !== "max") return err(403, "requires Max") // made up: not documented
    return undefined
  }
  const cap = (kind: keyof (typeof CAPS)["max"], used: number) => {
    const quota = CAPS[sw.plan === "free" ? "pro" : sw.plan][kind]
    return used >= quota ? err(429, `${kind} cap reached`, { quota, used }) : undefined // body made up
  }

  // Recorded: an unknown field in a definition is refused naming it.
  const badDefinition = (def: unknown): Response | undefined => {
    const extra = Object.keys((def ?? {}) as Json).find((k) => !["chain", "entry", "exit", "sizing"].includes(k))
    return extra ? err(400, `Unrecognized key(s) in object: '${extra}'`) : undefined
  }

  // Book legs as Hacc pages them (checked live): a window of `from`/`to` (30 days to now by default, 90 at
  // most), `limit` up to 200 (500 when none is sent), oldest first, and a cursor that holds its window, so one
  // sent with another window is refused. The recorded legs are repeated to 60 so a page can run out.
  const bookLegs = (q: URLSearchParams): Response => {
    const base = recorded("wallet-book-legs-realtime") as { legs: Json[] } & Json
    const legs = Array.from({ length: 60 }, (_, i) => ({ ...base.legs[i % base.legs.length]!, id: String(1000 + i) }))
    const to = q.get("to") ?? new Date().toISOString()
    const from = q.get("from") ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString()
    if (Number.isNaN(Date.parse(from))) return err(400, "from: Invalid datetime")
    if (Date.parse(to) - Date.parse(from) > 90 * 86_400_000) return err(400, "window cap is 90 days")
    const limit = q.has("limit") ? Number(q.get("limit")) : 500
    if (q.has("limit") && limit > 200) return err(400, "Customer results are limited to 200 rows")
    let start = 0
    const cursor = q.get("cursor")
    if (cursor) {
      const held = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { from: string; to: string; next_index: number }
      if (!q.has("to") || held.to !== to || held.from !== from) return err(400, "cursor_mismatch")
      start = held.next_index
    }
    const page = legs.slice(start, start + limit)
    const next = start + limit < legs.length ? Buffer.from(JSON.stringify({ from, to, next_index: start + limit, pad: "c".repeat(900) })).toString("base64url") : null
    return json(200, { ...base, from, to, legs: page, next_cursor: next })
  }
  type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: Json, key: string) => Response | Promise<Response>
  const routes: [string, RegExp, Handler][] = [
    ["GET /v1/signals", /^\/v1\/signals$/, (_m, q) => {
      if (Number(q.get("limit") ?? 50) > 200) return json(400, recorded("signals-limit-over-cap"))
      if (q.get("group_by") === "token") return json(200, recorded("signals-group-by-token"))
      for (const k of ["after", "since"]) if (q.has(k) && Number.isNaN(Date.parse(q.get(k)!))) return err(400, `${k}: Invalid date`)
      const from = q.get("after") ?? q.get("since")
      let rows = from ? tape.filter((r) => Date.parse(String(r.created_at)) > Date.parse(from)) : [...tape]
      // Recorded: pattern, chain and asset filter the tape; asset takes a mint or Hacc's asset id.
      const pattern = q.get("pattern")
      const chain = q.get("chain")
      const asset = q.get("asset")
      if (pattern) rows = rows.filter((r) => r.pattern === pattern)
      if (chain) rows = rows.filter((r) => r.asset_chain === chain)
      if (asset) rows = rows.filter((r) => r.asset_address === asset || String(r.asset_id) === asset)
      // Recorded: a market-cap filter passes a token whose market cap Hacc doesn't know (`max_mcap_usd=1`
      // still answered a new ticker's rows). Here a token's market cap is the one the price read gives.
      const mcapOf = (r: Json) => sw.prices[String(r.asset_address)]?.mcap
      const lo = q.has("min_mcap_usd") ? Number(q.get("min_mcap_usd")) : undefined
      const hi = q.has("max_mcap_usd") ? Number(q.get("max_mcap_usd")) : undefined
      if (lo !== undefined || hi !== undefined)
        rows = rows.filter((r) => {
          const mcap = mcapOf(r)
          return mcap === undefined || mcap === null || ((lo === undefined || mcap >= lo) && (hi === undefined || mcap <= hi))
        })
      if (q.get("order") !== "asc") rows.reverse()
      const offset = Number(q.get("offset") ?? 0)
      rows = rows.slice(offset, offset + Number(q.get("limit") ?? 50))
      return json(200, { signals: rows })
    }],
    ["GET /v1/market/token/history", /^\/v1\/market\/token\/([^/]+)\/history$/, (_m, q) =>
      json(200, recorded(q.get("include_candles") === "true" ? "token-history-1m-hour-candles" : "token-history"))],
    ["GET /v1/market/token/holders", /^\/v1\/market\/token\/([^/]+)\/holders$/, (_m, q) =>
      q.get("chain") === "hood" ? json(200, recorded("token-holders-hood")) : json(502, recorded("token-holders-solana"))],
    ...(
      [["top-traders", "token-top-traders"], ["venues", "token-venues"], ["profile", "token-profile"], ["launch-overview", "research-young-launch-overview"], ["wallet-pnl", "token-wallet-pnl"]] as const
    ).map(([seg, name]): [string, RegExp, Handler] => [`GET /v1/market/token/${seg}`, new RegExp(`^/v1/market/token/([^/]+)/${seg}$`), () => json(200, recorded(name))]),
    ["GET /v1/market/token", /^\/v1\/market\/token\/([^/]+)$/, (m) => {
      if (m[1]!.length < 32) return json(400, recorded("refused-bad-address"))
      const answer = recorded("token-market")
      const t = sw.tokens[m[1]!]
      if (!t) return json(200, answer)
      return json(200, { ...answer, market: { ...(answer.market as Json), address: m[1], ...t.market }, safety: { ...(answer.safety as Json), ...t.safety } })
    }],
    ["GET /v1/market/token-search", /^\/v1\/market\/token-search$/, () => json(200, recorded("token-search-common"))],
    ["GET /v1/market/gainers", /^\/v1\/market\/gainers$/, () => json(200, recorded("market-gainers"))],
    ["GET /v1/market/prices", /^\/v1\/market\/prices$/, (_m, q) => {
      const refused = needs("pro")
      if (refused) return refused
      // Recorded: Hacc's own words for none and for more than 20 (the docs say 60).
      if (!q.get("addresses")) return json(400, recorded("prices-none"))
      const addresses = q.get("addresses")!.split(",")
      if (addresses.length > 20) return json(400, recorded("prices-solana-21"))
      const hood = q.get("chain") === "hood"
      // Recorded: each set of tokens has its own snapshot, refreshed from Hacc's provider when it's missing or
      // older than the refresh window, and answered as stored in between, with the prices as they were then.
      // Past the refresh limit, a set with a snapshot answers it stored; one without answers no prices at all.
      const now = Date.now()
      const set = `${hood ? "hood" : "solana"}:${addresses.join(",")}`
      let snap = priceSnapshots.get(set)
      const due = !snap || now - snap.at >= sw.priceRefreshMs
      while (priceRefreshes.length && now - priceRefreshes[0]! >= PRICE_REFRESH_WINDOW_MS) priceRefreshes.shift()
      const limited = due && priceRefreshes.length >= sw.priceRefreshLimit
      if (limited && !snap) return json(200, recorded("prices-refresh-refused"))
      if (due && !limited) {
        priceRefreshes.push(now)
        const prices = addresses.map((address) => {
          const p = sw.prices[address]
          const priced = p && (address.startsWith("0x") ? hood : !hood)
          return { address, symbol: priced ? (p.symbol ?? null) : null, price_usd: priced ? p.price : null, market_cap_usd: priced ? (p.mcap ?? null) : null }
        })
        snap = { at: now, prices }
        priceSnapshots.set(set, snap)
        return json(200, { prices, research_credits: 0, provenance: { source: "provider_refresh", retrieved_at: new Date(now).toISOString() } })
      }
      const provenance = { source: "stored_snapshot", observed_at: new Date(snap!.at).toISOString(), stale: false, refresh_available: priceRefreshes.length < sw.priceRefreshLimit }
      return json(200, { prices: structuredClone(snap!.prices), research_credits: 0, provenance })
    }],
    ["GET /v1/market/metas", /^\/v1\/market\/metas$/, () => json(200, recorded("market-metas"))],
    ["GET /v1/market/activity", /^\/v1\/market\/activity$/, () => json(200, recorded("market-activity"))],
    ["GET /v1/market/cohort-overlap", /^\/v1\/market\/cohort-overlap$/, () => json(200, recorded("market-cohort-overlap"))],
    ["GET /v1/launches/final-stretch", /^\/v1\/launches\/final-stretch$/, () => json(200, recorded("launches-final-stretch"))],
    ["GET /v1/social/mentions/trending", /^\/v1\/social\/mentions\/trending$/, () => json(200, recorded("social-mentions-trending"))],
    ["GET /v1/social/mentions", /^\/v1\/social\/mentions$/, (_m, q) =>
      q.has("address") || q.has("ticker") || q.has("since_id") ? json(200, recorded("social-mentions-address")) : err(400, ": address, ticker, or since_id is required")],
    ["GET /v1/social/mention-marks", /^\/v1\/social\/mention-marks$/, (_m, q) =>
      q.has("address") || q.has("ticker") ? json(200, recorded("social-mention-marks-address")) : err(400, ": address or ticker is required")],
    ["GET /v1/wallets/:id", /^\/v1\/wallets\/(\d+)$/, () => json(200, recorded("wallet-by-id"))],
    ["GET /v1/wallets", /^\/v1\/wallets$/, () => json(200, recorded("wallets"))],
    ["GET /v1/groups/:id", /^\/v1\/groups\/(\d+)$/, () => json(200, recorded("group-by-id"))],
    ["GET /v1/groups", /^\/v1\/groups$/, () => json(200, recorded("groups"))],
    ["GET /v1/market/labelled-trades", /^\/v1\/market\/labelled-trades$/, (_m, q) =>
      json(200, recorded(q.get("kind") === "kol" ? "labelled-trades-kol" : "labelled-trades-smartmoney"))],
    ["GET /v1/market/wallet/book-legs", /^\/v1\/market\/wallet\/([^/]+)\/book-legs$/, (_m, q) => needs("max") ?? bookLegs(q)],
    ...(
      [["stats", "wallet-stats"], ["activity", "wallet-activity"], ["token-breakdown", "wallet-token-breakdown"], ["portfolio", "wallet-portfolio"]] as const
    ).map(([seg, name]): [string, RegExp, Handler] => [`GET /v1/market/wallet/${seg}`, new RegExp(`^/v1/market/wallet/([^/]+)/${seg}$`), () => json(200, recorded(name))]),

    // Follows, rules, personal signals and the account's own groups (Pro and Max).
    ["GET /v1/me/follows", /^\/v1\/me\/follows$/, () => needs("pro") ?? json(200, { follows })],
    ["POST /v1/me/follows", /^\/v1\/me\/follows$/, (_m, _q, body) => {
      const refused = needs("pro")
      if (refused) return refused
      if (typeof body.address !== "string" || body.address.length < 32) return json(400, recorded("change-follow-bad-address"))
      const held = follows.find((f) => f.address === body.address)
      if (held) return json(201, { follow: held }) // as recorded: a second follow answers the first
      const over = cap("follows", follows.length)
      if (over) return over
      const follow = { ...(recorded("change-follow-add").follow as Json), id: ids++, address: body.address, chain: body.chain ?? "solana" }
      follows.push(follow)
      return json(201, { follow })
    }],
    ["DELETE /v1/me/follows/:id", /^\/v1\/me\/follows\/(\d+)$/, (m) => remove(follows, m[1]!, "follow")],
    ["GET /v1/me/rules", /^\/v1\/me\/rules$/, () => needs("pro") ?? json(200, { rules })],
    ["POST /v1/me/rules", /^\/v1\/me\/rules$/, (_m, _q, body) => {
      const refused = needs("pro")
      if (refused) return refused
      const pattern = String(body.pattern)
      if (!["new_ticker", "confluence", "large_move", "dormancy", "distribution"].includes(pattern)) return json(400, recorded("change-rule-bad-pattern"))
      const params = (body.params ?? {}) as Json
      if (pattern === "confluence" && !(Number(params.wallets) >= 2)) return json(400, recorded("change-rule-bad-params"))
      const over = cap("rules", rules.length)
      if (over) return over
      const rule = { ...(recorded(`change-rule-add-${pattern}`).rule as Json), id: ids++, name: body.name, pattern, params, wallet_id: body.wallet_id ?? null }
      rules.push(rule)
      return json(201, { rule })
    }],
    ["GET /v1/me/signals", /^\/v1\/me\/signals$/, (_m, q) => {
      const refused = needs("pro")
      if (refused) return refused
      // `after` is a whole number above 0, in Hacc's words otherwise (checked live: a date is refused,
      // and an empty page echoes it as next_after). Rows with one weren't recorded, so here it's the last id.
      const raw = q.get("after")
      if (raw !== null && !/^-?\d+(\.\d+)?$/.test(raw)) return json(400, { error: "after: Expected number, received nan" })
      if (raw !== null && raw.includes(".")) return json(400, { error: "after: Expected integer, received float" })
      if (raw !== null && Number(raw) <= 0) return json(400, { error: "after: Number must be greater than 0" })
      if (mine.length === 0) return json(200, raw === null ? recorded("me-signals") : { signals: [], next_after: Number(raw) })
      const after = raw === null ? 0 : Number(raw)
      const rows = mine.filter((r) => Number(r.id) > after).slice(0, Number(q.get("limit") ?? 50))
      return json(200, { signals: rows, next_after: Number(rows.at(-1)?.id ?? (raw === null ? null : after)) || null })
    }],
    ["GET /v1/me/groups", /^\/v1\/me\/groups$/, () => needs("pro") ?? json(200, { groups })],
    ["POST /v1/me/groups", /^\/v1\/me\/groups$/, (_m, _q, body) => {
      const refused = needs("pro") ?? cap("groups", groups.length)
      if (refused) return refused
      const group = { ...(recorded("change-group-add").group as Json), id: ids++, name: body.name, wallets: [] }
      groups.push(group)
      return json(201, { group })
    }],
    ["DELETE /v1/me/groups/:id", /^\/v1\/me\/groups\/(\d+)$/, (m) => remove(groups, m[1]!, "group")],
    ["POST /v1/me/groups/:id/wallets", /^\/v1\/me\/groups\/(\d+)\/wallets$/, (m, _q, body) => {
      const group = groups.find((g) => String(g.id) === m[1])
      if (!group) return err(404, "group not found")
      const wallets = group.wallets as Json[]
      const over = cap("groupWallets", wallets.length)
      if (over) return over
      wallets.push({ wallet_id: ids++, chain: body.chain ?? "solana", address: body.address })
      return json(200, { group })
    }],
    ["DELETE /v1/me/groups/:id/wallets/:wallet", /^\/v1\/me\/groups\/(\d+)\/wallets\/([^/]+)$/, (m) => {
      const group = groups.find((g) => String(g.id) === m[1])
      const wallets = (group?.wallets ?? []) as Json[]
      const i = wallets.findIndex((w) => String(w.wallet_id) === m[2] || w.address === m[2])
      if (!group || i < 0) return json(404, recorded("change-group-wallet-delete"))
      wallets.splice(i, 1)
      return json(200, { group })
    }],

    // The strategy lab and saved strategies (Max).
    ["GET /v1/strategy-lab/edges", /^\/v1\/strategy-lab\/edges$/, () => needs("max") ?? json(200, recorded("lab-edges"))],
    ["GET /v1/strategy-lab/runners", /^\/v1\/strategy-lab\/runners$/, () => needs("max") ?? json(200, recorded("lab-runners-1h-3w"))],
    ["GET /v1/strategy-lab/first-signals", /^\/v1\/strategy-lab\/first-signals$/, (_m, q) =>
      needs("max") ?? (q.has("asset_id") || q.has("asset_ids") || q.has("launched_after") || q.has("launched_before") || q.has("min_ath_multiple")
        ? json(200, recorded("lab-first-signals-30m"))
        : json(400, recorded("lab-first-signals-30m-missing")))],
    ["GET /v1/assets/:id", /^\/v1\/assets\/(\d+)$/, () => json(200, recorded("asset-by-id"))],
    ["GET /v1/assets", /^\/v1\/assets$/, () => json(200, recorded("assets"))],
    ["POST /v1/strategy-lab/replay", /^\/v1\/strategy-lab\/replay$/, (_m, _q, body, key) => {
      const refused = needs("max")
      if (refused) return refused
      const def = (body.definition ?? {}) as Json
      const extra = Object.keys(def).find((k) => !["chain", "entry", "exit", "sizing"].includes(k))
      if (extra) return err(400, `Unrecognized key(s) in object: '${extra}'`)
      if (Date.parse(String(body.to)) - Date.parse(String(body.from)) > 14 * 86_400_000) return json(400, recorded("replay-window-too-long"))
      if (replays.size >= sw.replayQuota) return err(429, "replay quota reached", { quota: sw.replayQuota, used: replays.size }) // the docs: quota and used
      for (const [id, job] of replays)
        if (job.key === key && job.status === "running") return err(409, `replay job ${id} is still running; one at a time per key`, { code: "lab_active", job_id: id })
      const id = ids++
      replays.set(id, { polls: 0, status: "running", key })
      return json(202, { job_id: id })
    }],
    ["GET /v1/strategy-lab/replay/:id", /^\/v1\/strategy-lab\/replay\/(\d+)$/, (m) => {
      const job = replays.get(Number(m[1]))
      if (!job) return err(404, "replay not found") // made up
      if (job.status === "running" && ++job.polls > sw.replayPolls) job.status = sw.replayEnds
      // Recorded: running, cancelled (`failed`, error "cancelled") and Hacc's 10-minute stop (`failed`,
      // "hard timeout after 600s"). A finished replay answers as the recorded one did, result and all.
      if (job.status === "running") return json(200, { ...recorded("replay-poll-000"), job_id: Number(m[1]) })
      if (job.status === "cancelled") return json(200, { ...recorded("replay-after-cancel"), job_id: Number(m[1]) })
      if (job.status === "timeout") return json(200, { ...recorded("replay-poll-last"), job_id: Number(m[1]) })
      return json(200, { ...recorded("bots-sizing-result"), job_id: Number(m[1]) })
    }],
    ["POST /v1/strategy-lab/replay/:id/cancel", /^\/v1\/strategy-lab\/replay\/(\d+)\/cancel$/, (m) => {
      const job = replays.get(Number(m[1]))
      if (!job) return err(404, "replay not found")
      job.status = "cancelled"
      return json(200, recorded("replay-cancel"))
    }],
    ["GET /v1/strategies", /^\/v1\/strategies$/, () => needs("max") ?? json(200, { strategies })],
    ["POST /v1/strategies", /^\/v1\/strategies$/, (_m, _q, body) => {
      const refused = needs("max") ?? badDefinition(body.definition)
      if (refused) return refused
      const strategy = { ...(recorded("change-strategy-save").strategy as Json), id: ids++, name: body.name, version: 1, definition: body.definition }
      strategies.push(strategy)
      return json(201, { strategy })
    }],
    // Recorded: a version is a new strategy id with version + 1; retire is a PATCH, and nothing deletes one.
    ["POST /v1/strategies/:id/versions", /^\/v1\/strategies\/(\d+)\/versions$/, (m, _q, body) => {
      const refused = needs("max") ?? badDefinition(body.definition)
      if (refused) return refused
      const parent = strategies.find((s) => String(s.id) === m[1])
      if (!parent) return json(404, recorded("refused-strategy-404"))
      const strategy = { ...(recorded("change-strategy-version").strategy as Json), id: ids++, name: parent.name, version: Number(parent.version) + 1, parent_version: parent.version, definition: body.definition }
      strategies.push(strategy)
      return json(201, { strategy })
    }],
    ["PATCH /v1/strategies/:id", /^\/v1\/strategies\/(\d+)$/, (m, _q, body) => {
      const strategy = strategies.find((s) => String(s.id) === m[1])
      if (!strategy) return json(404, recorded("refused-strategy-404"))
      if (body.status !== "retired") return err(400, "status: Invalid enum value. Expected 'retired'") // made up: only retired was recorded
      strategy.status = "retired"
      return json(200, { strategy })
    }],
    ["GET /v1/strategies/:id", /^\/v1\/strategies\/([^/]+)$/, (m) => {
      if (!/^\d+$/.test(m[1]!)) return json(400, recorded("refused-strategy-not-a-number"))
      const strategy = strategies.find((s) => String(s.id) === m[1])
      return strategy ? json(200, { strategy }) : json(404, recorded("refused-strategy-404"))
    }],
    ["GET /v1/strategies/:id/trades", /^\/v1\/strategies\/(\d+)\/trades$/, () => needs("max") ?? json(200, recorded("strategy-trades"))],
    ["GET /v1/strategies/:id/comparison", /^\/v1\/strategies\/(\d+)\/comparison$/, () => needs("max") ?? json(200, recorded("strategy-comparison"))],
    ["GET /v1/strategy-runs", /^\/v1\/strategy-runs$/, () => needs("max") ?? json(200, recorded("strategy-runs-after"))],
    ["GET /v1/trades", /^\/v1\/trades$/, (_m, q) =>
      needs("max") ??
      (Number(q.get("limit") ?? 0) > 500
        ? json(400, recorded("bots-trades-limit-501"))
        : q.has("run_id")
          ? json(200, recorded("bots-trades-run-page"))
          : q.has("asset_id")
            ? json(200, recorded("trades-asset"))
            : json(400, recorded("bots-trades-no-run")))],
    ["GET /v1/strategy-lab/status", /^\/v1\/strategy-lab\/status$/, () => {
      const refused = needs("max")
      if (refused) return refused
      const used = [...replays.values()].length
      const active = [...replays.entries()].find(([, j]) => j.status === "running")
      const status = recorded("bots-lab-status")
      return json(200, { ...status, replays: { ...(status.replays as Json), cap: sw.replayQuota, used }, active_job_id: active ? active[0] : null })
    }],
  ]

  function remove(list: Json[], id: string, what: string) {
    const refused = needs("pro")
    if (refused) return refused
    const i = list.findIndex((x) => String(x.id) === id)
    if (i < 0) return err(404, `${what} not found`)
    list.splice(i, 1)
    return new Response(null, { status: 204 })
  }

  const server = Bun.serve<{ key: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const header = req.headers.get("authorization") ?? undefined
      const key = header?.startsWith("Bearer ") ? header.slice(7) : undefined
      let body: Json = {}
      if (req.method !== "GET" && req.headers.get("content-type")?.includes("json")) body = (await req.json().catch(() => ({}))) as Json
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: header, ...(req.method === "GET" ? {} : { body }) })
      if (!key) return err(401, "missing bearer token") // recorded through the redactor as "missing bearer [redacted]"
      if (!sw.keys.includes(key)) return err(401, "invalid api key")
      if (url.pathname === "/v1/signals/stream") {
        // Recorded with eight open on one key: Hacc counts them per key, whatever the docs say.
        if ([...sockets].filter((ws) => ws.data.key === key).length >= sw.maxSockets) return err(429, "too many subscribers for this key")
        return srv.upgrade(req, { data: { key } }) ? undefined : err(400, "expected a WebSocket")
      }
      for (const [name, pattern, handle] of routes) {
        const [method] = name.split(" ")
        const m = url.pathname.match(pattern)
        if (!m || method !== req.method) continue
        if (sw.slow[name]) await Bun.sleep(sw.slow[name]!)
        const fixed = sw.fail[name]
        if (fixed) return new Response(fixed.body === undefined ? null : JSON.stringify(fixed.body), { status: fixed.status, headers: { "content-type": "application/json", ...fixed.headers } })
        return handle(m, url.searchParams, body, key)
      }
      return json(404, { message: `Route ${req.method}:${url.pathname} not found`, error: "Not Found", statusCode: 404 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(JSON.stringify(snapshotFrame(tape.slice(-100).reverse())))
        const timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify(pingFrame())), sw.pingMs)
        ;(ws as unknown as { timer: Timer }).timer = timer
      },
      message() {},
      close(ws) {
        clearInterval((ws as unknown as { timer: Timer }).timer)
        sockets.delete(ws)
      },
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    calls,
    state: { follows, rules, groups, strategies, replays, tape, sockets, mine },
    set(patch: Partial<FakeHaccSwitches>) {
      Object.assign(sw, patch)
    },
    /** A new signal on the tape, sent to every open socket. */
    push(patch: Json = {}) {
      const row = addSignal(patch)
      for (const ws of sockets) ws.send(JSON.stringify(signalFrame(row)))
      return row
    },
    /** A personal signal, as one of the account's rules would produce. */
    pushMine(patch: Json = {}) {
      const row = { ...structuredClone(template), id: ++nextId, created_at: new Date().toISOString(), rule_id: 1, ...patch }
      mine.push(row)
      return row
    },
    /** A signal on the tape that no socket hears: a gap for the reconciliation read to fill. */
    pushUnheard(patch: Json = {}) {
      return addSignal(patch)
    },
    dropSockets(code = 1006) {
      for (const ws of sockets) ws.close(code === 1006 ? 1011 : code, "dropped")
    },
    stop() {
      for (const ws of sockets) ws.close()
      server.stop(true)
    },
  }
}
export type FakeHacc = ReturnType<typeof startFakeHacc>

// The stream's frames, in the recorded shapes (fixtures/hacc-recorded/stream-main.json).
function streamFrame(i: number): Json {
  const s = recordings.get("stream-main")
  const f = s?.frames?.[i]?.frame
  if (!f || typeof f !== "object") throw new Error(`fake Hacc: stream-main has no frame ${i}`)
  return structuredClone(f) as Json
}
function snapshotFrame(rows: Json[]): Json {
  return { ...streamFrame(0), signals: rows }
}
function signalFrame(row: Json): Json {
  return { ...streamFrame(1), signal: row }
}
function pingFrame(): Json {
  const s = recordings.get("stream-main")
  const ping = s?.frames?.find((f) => (f.frame as Json)?.type === "ping")?.frame
  return structuredClone((ping as Json) ?? { type: "ping" })
}
