// The Cockpit's two new panes: Feed, Candle's on-fire list; and Signals, Hacc's tape, one line a signal in
// words, from Hacc's recorded rows.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { StreamRow } from "../../core/signal-stream"
import type { TokenView } from "../../core/token-watch"
import { C } from "../theme"
import type { FeedList } from "../../core/feeds"
import { feedLines, feedTitle, listOf } from "./feed"
import { textOf } from "./lines"
import { type HaccTopic, happened, heldSignals, SIGNAL_ROWS, signalLine, signalsLines } from "./signals"

const NOW = Date.parse("2026-10-29T03:00:00Z")
const recorded = (name: string): Record<string, unknown>[] =>
  (JSON.parse(readFileSync(join(import.meta.dir, `../../../test/fixtures/hacc-recorded/${name}.json`), "utf8")) as { answer: { signals: Record<string, unknown>[] } }).answer.signals

describe("Feed", () => {
  const market = (rows: NonNullable<TokenView["trending"]>["rows"]): TokenView => ({ followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null, trending: { bucket: "onfire", at: NOW - 12_000, rows } })
  const rows = [
    { mint: "m1", symbol: "ORBIT", name: "Orbit Coin", marketCap: 160_000_000, priceUsd: 0.16, change1h: 0.1015 },
    { mint: "m2", symbol: "DUST", name: "Dust", marketCap: null, priceUsd: 0.0000031718, change1h: -0.9261 },
    { mint: "m3", symbol: "NEW", marketCap: 5_000, priceUsd: null, change1h: null },
  ]
  const lines = (m: TokenView | undefined, width: number) => feedLines("onfire", listOf("onfire", undefined, m), width, NOW)

  test("figures before the name: the change and market cap always, where it launched from 30 cells, the name from 45, under a heading (no price)", () => {
    const launched = [{ ...rows[0]!, where: "pump" }, { ...rows[1]!, where: "candle" }, rows[2]!]
    // One cell before where it launched where that's all there is, two where there's room.
    expect(lines(market(launched), 29).map(textOf)).toEqual(["token         1h   mcap", "ORBIT    ▲ 10.2%  $160M", "DUST     ▼ 92.6%      —", "NEW            —    $5K"])
    expect(lines(market(launched), 30).map(textOf)).toEqual(["token         1h   mcap where", "ORBIT    ▲ 10.2%  $160M pump", "DUST     ▼ 92.6%      — candle", "NEW            —    $5K —"])
    expect(textOf(lines(market(launched), 40)[0]!)).toBe("token         1h   mcap  where")
    expect(textOf(lines(market(launched), 40)[1]!)).toBe("ORBIT    ▲ 10.2%  $160M  pump")
    expect(textOf(lines(market(launched), 60)[1]!)).toBe("ORBIT    ▲ 10.2%  $160M  pump    Orbit Coin")
    // A name that's the symbol isn't said twice; a launch Candle didn't say is a dash.
    expect(textOf(lines(market(launched), 60)[2]!)).toBe("DUST     ▼ 92.6%      —  candle")
    expect(textOf(lines(market(launched), 60)[3]!)).toBe("NEW            —    $5K  —")
  })

  test("up green, down red, unknown dim and never zero", () => {
    const [, up, down, none] = lines(market(rows), 40)
    expect(up!.segs[1]!.fg).toBe(C.good)
    expect(down!.segs[1]!.fg).toBe(C.bad)
    expect(none!.segs[1]!.fg).toBe(C.dim)
    expect(textOf(none!)).toContain("—")
  })

  test("before the first read, an empty list, and the title's age", () => {
    expect(lines(undefined, 40).map(textOf)).toEqual(["Waiting on Candle for its On Fire list:", "the first read takes a few seconds."])
    expect(lines(market([]), 60).map(textOf)).toEqual(["Candle's on-fire list is empty right now."])
    // Words wrap in a narrow pane rather than run off it.
    expect(lines(market([]), 30).map(textOf)).toEqual(["Candle's on-fire list is empty", "right now."])
    expect(feedTitle("onfire", listOf("onfire", undefined, market(rows)), NOW)).toBe("Feed · on fire · 12s ago")
    expect(feedTitle("onfire", listOf("onfire", undefined, market(rows)), NOW + 10 * 60_000)).toContain("stale")
  })

  test("the core's feeds list comes first: the token view's copy only stands in for an older core", () => {
    const own: FeedList = { bucket: "onfire", at: NOW, rows: [{ mint: "m9", symbol: "MINE", marketCap: 1, priceUsd: null, change1h: null }] }
    expect(listOf("onfire", { onfire: own }, market(rows))).toBe(own)
    expect(listOf("new", undefined, market(rows))).toBeUndefined()
  })
})

describe("Signals", () => {
  test("what happened, in words, for every pattern Hacc sends (Hacc's recorded rows)", () => {
    const word = (pattern: string) => happened(recorded(`signals-pattern-${pattern}`)[0]!)
    expect(word("new_ticker")).toBe("first buy")
    expect(word("confluence")).toBe("3 wallets")
    expect(["big buy", "big sell", "big move"]).toContain(word("large_move"))
    expect(word("dormancy")).toMatch(/^woke \d+d$/)
    expect(word("distribution")).toBe("selling")
    expect(word("deployer")).toBe("deployer")
    expect(word("intra_book")).toBe("book move")
    expect(word("kol_mention")).toBe("mention")
    expect(happened({ pattern: "some_new_thing" })).toBe("some new…")
    // Every recorded row draws, none wider than the pane, whatever its age (a three-character age was cut at 27).
    for (const p of ["confluence", "deployer", "distribution", "dormancy", "intra_book", "kol_mention", "large_move", "new_ticker"]) {
      for (const row of recorded(`signals-pattern-${p}`)) {
        const at = Date.parse((row as StreamRow).created_at)
        for (const age of [4_000, 13_000, 45 * 60_000, 23 * 3_600_000]) {
          for (let w = 22; w <= 70; w++) {
            const text = textOf(signalLine(row as StreamRow, w, at + age))
            expect(text.length).toBeLessThanOrEqual(w)
            expect(text).toEndWith(` ${text.split(" ").at(-1)}`)
            expect(text.endsWith("…")).toBe(false)
          }
        }
      }
    }
  })

  const row = (over: Record<string, unknown> = {}): StreamRow =>
    ({
      id: 1,
      pattern: "new_ticker",
      event_kind: "swap",
      summary: "🆕 \"quickflipsclub\" on Pump.fun bought CSI for the first time ($970)",
      payload: { usd_value: "970.497" },
      created_at: new Date(NOW - 90_000).toISOString(),
      wallet_address: "Wal9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXk2p",
      wallet_label: null,
      display_label: '"quickflipsclub" on Pump.fun',
      asset_symbol: "CSI",
      ...over,
    }) as StreamRow

  test("one line: the token, what happened, its size, the wallet, its age; Hacc's own summary never", () => {
    expect(textOf(signalLine(row(), 44, NOW))).toBe("CSI     first buy   $970  quickflipsclub  1m")
    expect(textOf(signalLine(row({ wallet_label: "desk seven" }), 44, NOW))).toBe("CSI     first buy   $970  desk seven      1m")
    expect(textOf(signalLine(row({ display_label: null }), 44, NOW))).toBe("CSI     first buy   $970  Wal9…Xk2p       1m")
    expect(textOf(signalLine(row({ pattern: "kol_mention", payload: { handle: "callsguy", usd_value: "130" } }), 44, NOW))).toContain("@callsguy")
    expect(textOf(signalLine(row(), 44, NOW))).not.toContain("🆕")
  })

  test("a symbol of eight letters or more is cut, never run into what happened", () => {
    expect(textOf(signalLine(row({ asset_symbol: "hypecoin", pattern: "deployer" }), 44, NOW))).toMatch(/^hypeco… deployer/)
    // No symbol: the mint's first four.
    expect(textOf(signalLine(row({ asset_symbol: null, asset_address: "GTukAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApXyz" }), 44, NOW))).toMatch(/^GTuk…   first buy/)
  })

  test("narrow, the wallet goes first, then the size; the token, what happened and the age stay", () => {
    expect(textOf(signalLine(row(), 32, NOW))).toBe("CSI     first buy   $970      1m")
    expect(textOf(signalLine(row(), 24, NOW))).toBe("CSI     first buy     1m")
  })

  test("a gap reads as one row, in the dim colour", () => {
    const gap = { kind: "gap", id: "g1", created_at: new Date(NOW - 60_000).toISOString(), from: "2026-10-29T02:02:00Z", to: "2026-10-29T02:05:00Z", words: "Hacc's tape didn't answer" } as StreamRow
    const l = signalLine(gap, 70, NOW)
    expect(l.segs).toHaveLength(1)
    expect(l.segs[0]!.fg).toBe(C.dim)
    expect(textOf(l)).toContain("not read back: Hacc's tape didn't answer")
  })

  test("newest first; held rows join once each, in time order, up to a cap", () => {
    const a = row({ id: 1, created_at: new Date(NOW - 3_000).toISOString(), asset_symbol: "A" })
    const b = row({ id: 2, created_at: new Date(NOW - 2_000).toISOString(), asset_symbol: "B" })
    const c = row({ id: 3, created_at: new Date(NOW - 1_000).toISOString(), asset_symbol: "C" })
    const held = heldSignals(heldSignals(undefined, { state: "open", rows: [a, b] }, true), { rows: [b, c] }, false)
    expect(held.rows.map((r) => (r as { id: number }).id)).toEqual([1, 2, 3])
    expect(signalsLines(held, { hacc: undefined, mine: false, width: 44, now: NOW }).map((l) => textOf(l).slice(0, 2))).toEqual(["C ", "B ", "A "])
    // A snapshot replaces what was held.
    expect(heldSignals(held, { rows: [a] }, true).rows).toEqual([a])
    const many = Array.from({ length: SIGNAL_ROWS + 5 }, (_, i) => row({ id: i, created_at: new Date(NOW - 1_000_000 + i).toISOString() }))
    expect(heldSignals(undefined, { rows: many }, true).rows).toHaveLength(SIGNAL_ROWS)
  })

  const hacc = (over: Partial<HaccTopic> = {}): HaccTopic => ({ enabled: true, agents: { "agent-a": { plan: "max", key: "ok" } }, stream: { state: "open", mine: { state: "polling" } }, ...over })
  const say = (h: HaccTopic, mine = false) => signalsLines({ rows: [] }, { hacc: h, mine, width: 60, now: NOW }).map(textOf).join(" ")

  test("when the tape can't show, a line says why", () => {
    expect(say(hacc({ enabled: false }))).toBe("Hacc's data is off in this Candle Harness's config ([hacc] enabled = false).")
    const why = "Hacc refused agent-a's key (invalid api key). Hacc takes only a live, unrevoked production key (cndl_live_)."
    const refused = signalsLines({ rows: [] }, { hacc: hacc({ agents: { "agent-a": { plan: null, key: "refused", why } } }), mine: false, width: 60, now: NOW })
    // The core's sentence once, then the doctor's own fix; nothing said twice (it once read "Hacc refused …: Hacc refused …..").
    expect(refused.map(textOf).join(" ")).toBe(`${why} Make a new key with candle keys create --access write --embedded-wallet allow --label agent-a, then run candle-harness key add --agent agent-a.`)
    expect(refused[0]!.segs[0]!.fg).toBe(C.look)
    // One agent's key refused while another's works: the tape still shows.
    expect(say(hacc({ agents: { "agent-a": { plan: null, key: "refused" }, "agent-b": { plan: "pro", key: "ok" } } }))).toContain("No signals yet")
    expect(say(hacc({ stream: { state: "full", words: "Hacc's stream is full (Hacc: \"too many subscribers for this key\")", mine: { state: "closed" } } }))).toContain("Hacc's stream is full")
    expect(say(hacc({ stream: { state: "open", mine: { state: "needs-plan" } } }), true)).toBe("Your own rules' signals need Pro or Max on Hacc.")
    expect(say(hacc(), true)).toBe("None of your rules has fired yet.")
    expect(signalsLines(undefined, { hacc: hacc(), mine: false, width: 60, now: NOW }).map(textOf)).toEqual(["Reading Hacc's tape…"])
  })
})
