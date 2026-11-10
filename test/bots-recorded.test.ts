// What a rules bot rests on, as recorded live from Hacc's strategy lab and tape (test/record-bots.ts) and scrubbed
// into test/fixtures/hacc-recorded/bots/ (scripts/scrub-bots.ts). Two kinds of check: what Hacc's definition takes and
// what each exit and sizing rule means in its replay, which the bot's reader and runner are built on; and that the
// fake Hacc answers finished replays, run trades and the lab's status in the same shapes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { leftovers } from "../scripts/scrub-hacc"
import { type FakeHacc, startFakeHacc } from "./fake-hacc"

const dir = join(import.meta.dir, "fixtures/hacc-recorded/bots")
type Row = Record<string, unknown>
interface Recording {
  name: string
  route: string
  status: number
  body?: Row
  request?: Row
  answer: Row
}
const rec = (name: string): Recording => JSON.parse(readFileSync(join(dir, `bots-${name}.json`), "utf8"))
/** A schema probe: `true` where Hacc took the definition (it went on to refuse the 29-day window), else its words. */
const probe = (name: string): true | string => {
  const a = rec(`schema-${name}`).answer
  return a.code === "lab_window" ? true : String(a.error)
}
interface Trade {
  reason_closed: string
  entry_price_usd: string
  exit_price_usd: string
  opened_at: string
  closed_at: string
  entry_usd: number
  reason_opened: { sizing: { usd: number; paid_usd: number; applied: string[]; fell_back: string[] }; pattern: string; signal_id: number }
}
const result = (name: string) => rec(name).answer.result as Row & { trades: Trade[]; skips: Record<string, number>; to: string; trade_count: number }
const move = (t: Trade) => Number(t.exit_price_usd) / Number(t.entry_price_usd) - 1
const heldMinutes = (t: Trade) => (Date.parse(t.closed_at) - Date.parse(t.opened_at)) / 60_000

test("nothing in the fixtures still looks like a real address, handle or link", () => {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) expect(leftovers(JSON.parse(readFileSync(join(dir, f), "utf8")))).toEqual([])
})

describe("Hacc's definition, field by field", () => {
  test("is checked before the window, so a probe over 29 days runs nothing", () => {
    expect(probe("base")).toBe(true)
    expect(rec("schema-base").answer).toEqual({ error: "window cannot exceed 14 days for a lab key", code: "lab_window" })
  })

  test("refuses unknown fields at every level, naming the path", () => {
    expect(probe("unknown-top")).toBe("Unrecognized key(s) in object: 'extra'")
    expect(probe("entry-unknown")).toBe("entry: Unrecognized key(s) in object: 'extra'")
    expect(probe("filter-unknown")).toBe("entry.filters: Unrecognized key(s) in object: 'extra'")
    expect(probe("exit-unknown")).toBe("exit: Unrecognized key(s) in object: 'extra'")
    expect(probe("sizing-unknown")).toBe("sizing: Unrecognized key(s) in object: 'extra'")
  })

  test("enters on seven patterns: distribution is a tape pattern but not an entry", () => {
    expect(probe("pattern-distribution")).toContain("Expected 'confluence' | 'deployer' | 'large_move' | 'dormancy' | 'intra_book' | 'new_ticker' | 'kol_mention', received 'distribution'")
    expect(probe("entry-no-filters")).toBe(true)
    expect(probe("entry-no-pattern")).toBe("entry.pattern: Required")
  })

  test("has seven entry sources, four of them undocumented", () => {
    expect(probe("entry-source-bad")).toBe("entry.source: Invalid discriminator value. Expected 'pattern' | 'trade_signal' | 'conviction' | 'manual' | 'levels' | 'launch_fingerprint' | 'schedule'")
    expect(probe("trade-signal")).toBe(true)
    expect(probe("trade-signal-empty")).toBe("entry.min_confidence: Required")
    expect(probe("conviction-empty")).toBe("entry.score_window_minutes: Required")
  })

  test("filters: wallet_ids never on confluence, one group for min_group_wallets, hours_et a [start, end] without a wrap", () => {
    expect(probe("filter-wallet-ids-confluence")).toBe("entry.filters: wallet_ids cannot be used with pattern confluence")
    for (const p of ["deployer", "large_move", "dormancy", "intra_book", "new_ticker", "kol_mention"]) expect(probe(`filter-wallet-ids-${p}`)).toBe(true)
    expect(probe("filter-min-group-wallets-no-group")).toBe("entry.filters: min_group_wallets requires exactly one entry in groups")
    expect(probe("filter-min-group-wallets")).toBe(true)
    expect(probe("filter-hours-et")).toBe(true)
    expect(probe("filter-hours-et-wrap")).toBe("entry.filters.hours_et: hours_et must be [start, end] with start <= end (no overnight wrap)")
    expect(probe("filter-hours-et-half")).toBe("entry.filters.hours_et.0: Expected integer, received float")
    expect(probe("filter-direction-bad")).toContain("Expected 'in' | 'out'")
    expect(probe("filter-groups-number")).toBe("entry.filters.groups.0: Expected string, received number")
    expect(probe("filter-min-score-1h")).toBe(true)
  })

  test("exits: at least one, trailing arms at a multiple of 1 or more, a stop may be over 100", () => {
    expect(probe("exit-empty")).toBe("exit: exit must include at least one of take_profit_pct, stop_loss_pct, max_hold_hours, exit_on_signal: true, ladder, or trailing")
    expect(probe("exit-trailing")).toBe(true)
    expect(probe("exit-trailing-empty")).toBe("exit.trailing.arm_multiple: Required")
    expect(probe("exit-trailing-arm-under-1")).toBe("exit.trailing.arm_multiple: Number must be greater than or equal to 1")
    expect(probe("exit-on-signal-text")).toBe("exit.exit_on_signal: Expected boolean, received string")
    expect(probe("exit-take-profit-0")).toBe("exit.take_profit_pct: Number must be greater than 0")
    expect(probe("exit-stop-101")).toBe(true)
    expect(probe("exit-ladder-empty")).toBe("exit.ladder.sell_aggregate: Required")
  })

  test("sizing rules: `when` is keyed by feature, compared by lt, lte, gt and gte, with one of mult, add or skip", () => {
    expect(probe("rule-feature-bad")).toContain("Expected 'mcap_at_entry' | 'score_15m' | 'tracked_buyers_at_trigger' | 'proven_follow_present' | 'fomo_buyers_at_trigger' | 'momentum_since_first_bar' | 'minutes_since_first_signal'")
    expect(probe("rule-ops")).toBe(true)
    expect(probe("rule-op-unknown")).toBe("sizing.rules.0.when.mcap_at_entry: Unrecognized key(s) in object: 'max'")
    expect(probe("rule-two-features")).toBe(true)
    expect(probe("rule-no-action")).toBe("sizing.rules.0: a sizing rule needs exactly one of mult, add or skip")
    expect(probe("rule-two-actions")).toBe("sizing.rules.0: a sizing rule needs exactly one of mult, add or skip")
    expect(probe("rule-skip-false")).toBe("sizing.rules.0.skip: skip must be true (write no rule instead of skip: false)")
    expect(probe("rule-add-negative")).toBe("sizing.rules.0.add: add must be greater than 0")
    expect(probe("sizing-base-over-max")).toBe(true)
  })
})

describe("what each exit means in Hacc's replay", () => {
  test("a take profit closes at exactly its threshold over the entry", () => {
    const r = result("exit-take-profit-result")
    for (const t of r.trades.filter((t) => t.reason_closed === "take_profit")) expect(move(t)).toBeCloseTo(0.3, 6)
  })

  test("a stop is against the entry, filled 5% below its threshold or worse", () => {
    const trades = result("exit-stop-result").trades.filter((t) => t.reason_closed === "stop_loss")
    expect(trades.length).toBeGreaterThan(0)
    for (const t of trades) expect(move(t)).toBeLessThanOrEqual((1 - 0.2) * 0.95 - 1 + 1e-9)
  })

  test("max hold closes at the first mark at or after the hold", () => {
    const trades = result("exit-hold-result").trades.filter((t) => t.reason_closed === "max_hold")
    for (const t of trades) expect(heldMinutes(t)).toBeGreaterThanOrEqual(60)
  })

  test("trailing closes as trailing_stop", () => {
    expect(result("exit-trailing-result").trades.some((t) => t.reason_closed === "trailing_stop")).toBe(true)
  })

  test("a position still open at the window's end closes there as aborted", () => {
    const r = result("exit-signal-result")
    for (const t of r.trades) {
      expect(t.reason_closed).toBe("aborted")
      expect(t.closed_at).toBe(r.to)
    }
  })

  test("a signal on a token already held is skipped as already_open, never added to", () => {
    for (const name of ["exit-take-profit-result", "exit-stop-result", "exit-hold-result"]) expect(result(name).skips.already_open).toBeGreaterThan(0)
  })
})

describe("sizing in Hacc's replay", () => {
  test("base_usd is the stake, mult multiplies it, and add adds to the multiple", () => {
    const stake = (name: string) => [...new Set(result(name).trades.map((t) => t.reason_opened.sizing.usd))]
    expect(stake("sizing-base-result")).toEqual([5])
    expect(stake("sizing-mult-result")).toEqual([10])
    expect(stake("sizing-add-result")).toEqual([20])
  })

  test("a feature it can't read falls back, and a skip rule counts as sizing_skip", () => {
    const r = result("sizing-result")
    expect(r.skips.sizing_skip).toBeGreaterThan(0)
    for (const t of r.trades) expect(t.reason_opened.sizing.usd).toBeLessThanOrEqual(20)
  })
})

describe("the fake Hacc, as recorded", () => {
  // A key shaped like a live one, made at run time so no key literal sits in the source.
  const KEY = ["cndl", "live", "f".repeat(32)].join("_")
  let hacc: FakeHacc
  beforeAll(() => {
    hacc = startFakeHacc({ keys: [KEY] })
  })
  afterAll(() => hacc.stop())
  const get = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(new URL(path, hacc.url), { ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers ?? {}) } })
    return { status: res.status, body: (await res.json()) as Row }
  }

  test("a finished replay answers every field the recorded one has", async () => {
    const def = rec("sizing-result").request!.definition
    const started = await get("/v1/strategy-lab/replay", { method: "POST", body: JSON.stringify({ definition: def, from: "2026-11-05T11:00:00Z", to: "2026-11-05T12:00:00Z" }) })
    expect(started.status).toBe(202)
    let polled: Row = {}
    for (let i = 0; i < 5 && polled.status !== "done"; i++) polled = (await get(`/v1/strategy-lab/replay/${started.body.job_id}`)).body
    expect(polled.status).toBe("done")
    expect(Object.keys(polled.result as Row).sort()).toEqual(Object.keys(rec("sizing-result").answer.result as Row).sort())
    expect(Object.keys((polled.result as { trades: Row[] }).trades[0]!).sort()).toEqual(Object.keys(result("sizing-result").trades[0]!).sort())
  })

  test("a run's trades page by offset, at most 500, and need a run or a token", async () => {
    expect((await get("/v1/trades?run_id=1&limit=3")).body).toEqual(rec("trades-run-page").answer)
    expect((await get("/v1/trades?run_id=1&limit=501")).body).toEqual(rec("trades-limit-501").answer)
    expect((await get("/v1/trades")).body).toEqual(rec("trades-no-run").answer)
  })

  test("the lab's status says the cap, the replays used and the one running", async () => {
    const { body } = await get("/v1/strategy-lab/status")
    expect(Object.keys(body).sort()).toEqual(Object.keys(rec("lab-status").answer).sort())
    expect(body.replays).toMatchObject({ cap: 20 })
  })
})
