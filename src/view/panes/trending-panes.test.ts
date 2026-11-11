// The Trending tab's lists: New with each token's age, Graduated with when it
// graduated, Final Stretch with the curve's progress and the last trade, each in Feed's look; and Final
// Stretch saying the truth about itself: off, empty, or behind.
import { describe, expect, test } from "bun:test"
import { type Bucket, type FeedList, feedRows } from "../../core/feeds"
import graduatedFields from "../../../test/fixtures/candle-recorded/feeds-pnl/feed-graduated-fields.json"
import newFields from "../../../test/fixtures/candle-recorded/feeds-pnl/feed-new-fields.json"
import stretchFields from "../../../test/fixtures/candle-recorded/feeds-pnl/feed-finalstretch-fields.json"
import { C } from "../theme"
import { feedBuckets, feedLines, feedPanesLeftOut, feedTitle, since } from "./feed"
import { textOf } from "./lines"

const NOW = Date.parse("2026-10-30T14:00:00Z")
const list = (bucket: Bucket, rows: FeedList["rows"], over: Partial<FeedList> = {}): FeedList => ({ bucket, at: NOW - 5_000, rows, ...over })
const texts = (bucket: Bucket, l: FeedList | undefined, width = 40) => feedLines(bucket, l, width, NOW).map(textOf)

describe("each list's own column", () => {
  test("New: each token's age, between the token and its hour's change", () => {
    const l = list("new", [{ mint: "n1", symbol: "SPARK", name: "Spark", marketCap: 3_900, priceUsd: 0.0000039, change1h: -0.045, createdAt: NOW - 4 * 60_000 }])
    expect(texts("new", l, 30)).toEqual(["token    age      1h   mcap", "SPARK     4m  ▼ 4.5%  $3.9K"])
    expect(textOf(feedLines("new", l, 41, NOW)[1]!)).toBe("SPARK     4m  ▼ 4.5%  $3.9K  —")
  })

  test("Graduated: when it graduated, a missing change missing, and a short list saying it's whole (Candle's real list held 4 to 7 rows)", () => {
    const l = list("graduated", [{ mint: "g1", symbol: "BRIDGE", marketCap: 848, priceUsd: null, change1h: null, graduatedAt: NOW - 2 * 3_600_000 }], { matched: 1 })
    expect(texts("graduated", l, 30)).toEqual(["token   grad      1h   mcap", "BRIDGE    2h       —   $848", "That's the only one Candle lists."])
    const five = list("graduated", Array.from({ length: 5 }, (_, i) => ({ mint: `g${i}`, symbol: `G${i}`, marketCap: 1, priceUsd: null, change1h: null })), { matched: 5 })
    expect(texts("graduated", five, 40).at(-1)).toBe("Candle lists just these 5.")
    // A full list of 20 holding more doesn't say so: the border says what's out of view.
    const full = list("new", Array.from({ length: 20 }, (_, i) => ({ mint: `n${i}`, symbol: `N${i}`, marketCap: 1, priceUsd: null, change1h: null })), { matched: 79 })
    expect(texts("new", full).at(-1)).toStartWith("N19")
  })

  test("Final Stretch: the curve's progress and the last trade lead, and a missing market cap shows missing (on Candle's real list, 13 of 20 had one)", () => {
    const l = list("finalstretch", [{ mint: "f1", symbol: "CURVE", marketCap: null, priceUsd: null, change1h: null, progress: 0.96278, lastTradeAt: NOW - 12_000 }])
    expect(texts("finalstretch", l, 30)).toEqual(["token    curve  last   mcap", "CURVE    96.2%   12s      —"])
  })

  test("Candle's recorded lists draw a row for every token, none wider than its pane", () => {
    for (const [bucket, rec] of [["new", newFields], ["graduated", graduatedFields], ["finalstretch", stretchFields]] as const) {
      const rows = feedRows(rec.answer)!
      for (const width of [26, 30, 36, 60]) {
        const lines = feedLines(bucket, list(bucket, rows), width, NOW)
        expect(lines.filter((l) => l.pick).length).toBe(rows.length)
        for (const l of lines) expect(textOf(l).length).toBeLessThanOrEqual(Math.max(width, 30))
      }
    }
  })

  test("since: seconds, minutes, hours, days", () => {
    expect([since(NOW - 45_000, NOW), since(NOW - 4 * 60_000, NOW), since(NOW - 2 * 3_600_000, NOW), since(NOW - 3 * 86_400_000, NOW), since(undefined, NOW)]).toEqual(["45s", "4m", "2h", "3d", "—"])
  })
})

describe("ctrl-t on a row: the Candle Harness's own words for where it was seen", () => {
  const ask = (bucket: Bucket, row: FeedList["rows"][number]) => feedLines(bucket, list(bucket, [row]), 40, NOW)[1]!.pick!.ask
  test("each list says what its row showed", () => {
    expect(ask("new", { mint: "n1", symbol: "SPARK", marketCap: 3_900, priceUsd: null, change1h: null, createdAt: NOW - 240_000 })).toBe("What do you make of SPARK? From New: made 4m ago, $3.9K market cap.")
    expect(ask("graduated", { mint: "g1", symbol: "BRIDGE", marketCap: 848_000, priceUsd: null, change1h: null, graduatedAt: NOW - 600_000 })).toBe("What do you make of BRIDGE? From Graduated: graduated 10m ago, $848K market cap.")
    expect(ask("finalstretch", { mint: "f1", symbol: "CU\u001bRVE", marketCap: null, priceUsd: null, change1h: null, progress: 0.962, lastTradeAt: NOW - 12_000 })).toBe("What do you make of CURVE? From Final Stretch: 96% along its bonding curve, last traded 12s ago.")
  })
})

describe("Final Stretch says the truth", () => {
  test("off on Candle's server: said, with no age in the title, and nothing that looks like an empty list", () => {
    const off = list("finalstretch", [], { state: "off" })
    expect(texts("finalstretch", off)).toEqual(["Candle's server doesn't have Final", "Stretch on.", "Asked again every 10 minutes."])
    expect(feedTitle("finalstretch", off, NOW)).toBe("Final Stretch")
  })

  test("empty and trusted: nothing on the stretch right now", () => {
    expect(texts("finalstretch", list("finalstretch", []), 60)).toEqual(["Nothing on the curve's final stretch right now."])
  })

  test("behind: how far, in the look colour, before the rows; empty and behind isn't called nothing", () => {
    const rows = [{ mint: "f1", symbol: "CURVE", marketCap: null, priceUsd: null, change1h: null, progress: 0.9 }]
    const lines = feedLines("finalstretch", list("finalstretch", rows, { state: "behind", behindS: 184 }), 40, NOW)
    expect(textOf(lines[0]!)).toBe("Candle's source is 3 min behind.")
    expect(lines[0]!.segs[0]!.fg).toBe(C.look)
    expect(lines.some((l) => l.pick?.mint === "f1")).toBe(true)
    expect(texts("finalstretch", list("finalstretch", [], { state: "behind", behindS: 30 }), 80)).toEqual(["Candle's source is 30 s behind.", "Its list is empty, which may not be everything while it's behind."])
  })

  test("left out of a layout with another of Candle's lists while off, so they take its width; alone it stays and says why", () => {
    const off = { finalstretch: list("finalstretch", [], { state: "off" }) }
    expect(feedPanesLeftOut(["new", "graduated", "feed", "final-stretch", "token", "agent"], off)).toEqual(["final-stretch"])
    expect(feedPanesLeftOut(["final-stretch", "agent"], off)).toEqual([])
    expect(feedPanesLeftOut(["new", "final-stretch"], { finalstretch: list("finalstretch", []) })).toEqual([])
    expect(feedPanesLeftOut(["new", "final-stretch"], undefined)).toEqual([])
  })
})

describe("the lists a layout's panes want", () => {
  test("each list pane names its bucket; other panes none", () => {
    expect(feedBuckets(["new", "graduated", "feed", "final-stretch", "token", "agent"])).toEqual(["new", "graduated", "onfire", "finalstretch"])
    expect(feedBuckets(["agent", "token", "positions"])).toEqual([])
  })
})

describe("a failed read", () => {
  test("keeps the last list and says how old it is; with none yet, says it's trying again", () => {
    const rows = [{ mint: "n1", symbol: "SPARK", marketCap: 1, priceUsd: null, change1h: null }]
    expect(texts("new", list("new", rows, { at: NOW - 120_000, failed: { at: NOW, words: "RATE_LIMITED" } }), 80)[0]).toBe("The last read failed (RATE_LIMITED): this is the list from 2m ago.")
    expect(texts("new", list("new", [], { at: null, failed: { at: NOW, words: "INTERNAL" } }), 80)).toEqual(["Couldn't read it: INTERNAL. Trying again shortly."])
  })
})

describe("Hood's lists, as Candle sends them", () => {
  const HOOD = (end: string) => `0x4b1d000000000000000000000000000000${end}`
  test("a new Hood token with no creation time takes its age from when Candle first saw it (most new Hood tokens come so)", () => {
    const rows = feedRows({ tokens: [{ chain: "hood", address: HOOD("00ab1d"), symbol: "FIZZ", marketCap: 9_536, createdAt: null, firstSeenAt: NOW - 7 * 60_000 }] }, "hood")!
    expect(rows[0]!.createdAt).toBe(NOW - 7 * 60_000)
    expect(texts("new", list("new", rows), 30)[1]).toBe("FIZZ      7m       —  $9.5K")
    // Its own creation time wins where there is one.
    expect(feedRows({ tokens: [{ chain: "hood", address: HOOD("00ab1d"), symbol: "FIZZ", createdAt: NOW - 60_000, firstSeenAt: NOW - 7 * 60_000 }] }, "hood")![0]!.createdAt).toBe(NOW - 60_000)
  })

  test("a market cap of nothing shows missing, never $0", () => {
    const l = list("new", [{ mint: HOOD("000001"), symbol: "MOON", marketCap: 0, priceUsd: null, change1h: null, createdAt: NOW - 60_000 }])
    expect(texts("new", l, 30)[1]).toBe("MOON      1m       —      —")
  })

  test("a ticker the list holds more than once says which by its address's end: in the name's column, else the launch column, else its own cell", () => {
    const copies = list("new", [
      { mint: HOOD("00ab1d"), symbol: "PAYOLA", name: "Payola", marketCap: 242_000, priceUsd: null, change1h: null, createdAt: NOW - 5 * 60_000, where: "hood" },
      { mint: HOOD("0077c2"), symbol: "PAYOLA", name: "Payola", marketCap: 54_800, priceUsd: null, change1h: null, createdAt: NOW - 9 * 60_000, where: "hood" },
      { mint: HOOD("000aaa"), symbol: "ECHO", marketCap: 10_900, priceUsd: null, change1h: null, createdAt: NOW - 60_000, where: "hood" },
    ])
    // Narrow: the token's own cell.
    expect(texts("new", copies, 30).slice(1)).toEqual(["PA…ab1d   5m       —  $242K", "PA…77c2   9m       — $54.8K", "ECHO      1m       — $10.9K"])
    // With the launch column: the address's end in it, the ticker whole.
    expect(texts("new", copies, 38).slice(1)).toEqual(["PAYOLA    5m       —  $242K  …ab1d", "PAYOLA    9m       — $54.8K  …77c2", "ECHO      1m       — $10.9K  hood"])
    // With the name's column: there, where it launched kept; a name that differs from the ticker after it.
    expect(texts("new", copies, 64).slice(1)).toEqual(["PAYOLA    5m       —  $242K  hood    …ab1d", "PAYOLA    9m       — $54.8K  hood    …77c2", "ECHO      1m       — $10.9K  hood"])
    const named = list("new", copies.rows.map((r, i) => ({ ...r, name: i === 0 ? "Payola Cat" : r.name })))
    expect(texts("new", named, 64)[1]).toBe("PAYOLA    5m       —  $242K  hood    …ab1d Payola Cat")
  })
})
