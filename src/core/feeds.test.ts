// Candle's four lists: each read while a view's subscription names it, at
// 15 s with a Trending list on screen and 60 s for On Fire alone, inside the key's budget; Final Stretch's
// truth (off, empty, behind); and the reads stopping when the tab goes.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import graduatedFields from "../../test/fixtures/candle-recorded/feeds-pnl/feed-graduated-fields.json"
import newFields from "../../test/fixtures/candle-recorded/feeds-pnl/feed-new-fields.json"
import onfireFields from "../../test/fixtures/candle-recorded/feeds-pnl/feed-onfire-fields.json"
import stretchFields from "../../test/fixtures/candle-recorded/feeds-pnl/feed-finalstretch-fields.json"
import stretchHood from "../../test/fixtures/candle-recorded/feeds-pnl/feed-finalstretch-hood.json"
import unknownBucket from "../../test/fixtures/candle-recorded/feeds-pnl/feed-unknown-bucket.json"
import { candleConfigDir } from "./candle-mcp"
import { BACKGROUND_SHARE, BUDGET_WAIT, FREE_LIMIT, KeyBudget } from "./key-budget"
import type { ToolOutcome } from "./candle-mcp"
import { type Bucket, BUCKETS, FEED_FIELDS, feedRows, Feeds, type FeedsView, feedsTopicFilter, OFF_RETRY_MS, RETRY_SOON_MS, whereOf } from "./feeds"

const MOON = "MoonFake11111111111111111111111111111111111"
const HOOD = "0x00000000000000000000000000000000000b0B01"
const DUST = "DustFake11111111111111111111111111111111111"

const ok = (result: unknown): ToolOutcome => ({ kind: "ok", result })
const refused = (code: string, body: unknown = {}): ToolOutcome => ({ kind: "error", code, retryable: false, body })

function rig(opts: { wanted?: Bucket[]; answer?: (bucket: Bucket, chain: string) => ToolOutcome; stretch?: number; chains?: () => readonly { chain: "solana" | "hood"; slow?: boolean }[] } = {}) {
  let clock = 1_000_000
  let wanted = new Set<Bucket>(opts.wanted ?? [])
  const calls: { bucket: Bucket; chain: string; args: Record<string, unknown>; at: number }[] = []
  const published: { view: FeedsView; changed: Bucket }[] = []
  const feeds = new Feeds({
    call: async (_tool, args) => {
      calls.push({ bucket: args.bucket as Bucket, chain: String(args.chain), args, at: clock })
      return (
        opts.answer?.(args.bucket as Bucket, String(args.chain)) ??
        ok({ success: true, tokens: args.chain === "hood" ? [{ chain: "hood", address: HOOD, symbol: "KITE", marketCap: 1, createdAt: 2_000 }] : [{ chain: "solana", address: MOON, symbol: "MOON", marketCap: 1, createdAt: 1_000 }] })
      )
    },
    now: () => clock,
    wanted: () => wanted,
    publish: (view, changed) => published.push({ view, changed }),
    stretch: () => opts.stretch ?? 1,
    ...(opts.chains ? { chains: opts.chains } : {}),
  })
  // Running as with a view attached, driven by step() rather than its own timer.
  ;(feeds as unknown as { running: boolean }).running = true
  /** Steps on the clock for `ms`, a second at a time, as the timer would. */
  const run = async (ms: number) => {
    const end = clock + ms
    while (clock < end) {
      await feeds.step()
      clock += 1_000
    }
  }
  return { feeds, calls, published, run, tick: (ms: number) => (clock += ms), want: (b: Bucket[]) => (wanted = new Set(b)), count: (b: Bucket, chain = "solana") => calls.filter((c) => c.bucket === b && c.chain === chain).length }
}

describe("reading Candle's lists", () => {
  test("each wanted list is read whole at limit 20, with only the fields its pane draws (no _creationTime, no since_seq)", async () => {
    const r = rig({ wanted: ["new", "graduated", "finalstretch"] })
    await r.feeds.step()
    expect(r.calls.map((c) => c.bucket).sort()).toEqual([...BUCKETS].sort())
    for (const c of r.calls) {
      expect(c.args).toEqual({ bucket: c.bucket, chain: "solana", fields: FEED_FIELDS[c.bucket], limit: 20 })
      expect(String(c.args.fields)).not.toContain("_creationTime")
    }
    expect(FEED_FIELDS.new).toContain("createdAt")
    expect(FEED_FIELDS.graduated).toContain("graduatedAt")
    expect(FEED_FIELDS.finalstretch).toContain("progress")
    expect(FEED_FIELDS.finalstretch).toContain("lastTradeAt")
  })

  test("rows: figures as they are, a missing one missing (never zero), the hour's change a fraction, and rows that name no token left out", () => {
    const rows = feedRows({
      success: true,
      tokens: [
        { chain: "solana", address: MOON, symbol: "MO\u001b[2JON", name: "Moon Coin", priceUsd: 0.000806, marketCap: 812_000, change1h: 24.1, createdAt: 1_793_367_492_000 },
        { chain: "solana", address: "x" },
        { chain: "solana", address: DUST, symbol: "DUST", progress: 0.96278036, lastTradeAt: "2026-10-30T13:36:07.869Z", priceUsd: 0 },
      ],
    })!
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ mint: MOON, chain: "solana", symbol: "MO[2JON", name: "Moon Coin", priceUsd: 0.000806, marketCap: 812_000, change1h: expect.closeTo(0.241, 9), createdAt: 1_793_367_492_000 })
    expect(rows[1]).toEqual({ mint: DUST, chain: "solana", symbol: "DUST", marketCap: null, priceUsd: null, change1h: null, progress: 0.96278036, lastTradeAt: Date.parse("2026-10-30T13:36:07.869Z") })
  })

  test("a row's chain is Candle's own, else the chain the list was read for", () => {
    const HOOD = "0x00000000000000000000000000000000000b0B01"
    expect(feedRows({ tokens: [{ chain: "hood", address: HOOD, symbol: "MOON" }] })![0]!.chain).toBe("hood")
    expect(feedRows({ tokens: [{ address: HOOD, symbol: "MOON" }] }, "hood")![0]!.chain).toBe("hood")
    expect(feedRows({ tokens: [{ chain: "base", address: MOON, symbol: "MOON" }] })![0]!.chain).toBe("solana")
  })

  test("Candle's recorded lists read: New's ages, Graduated's times, Final Stretch's progress and last trade, and On Fire's outlier change", () => {
    const at = (rec: { answer: unknown }) => feedRows(rec.answer)!
    expect(at(newFields).length).toBeGreaterThan(0)
    expect(at(newFields).every((r) => r.createdAt !== undefined && r.marketCap !== null)).toBe(true)
    expect(at(graduatedFields).every((r) => r.graduatedAt !== undefined)).toBe(true)
    expect(at(stretchFields).every((r) => r.progress !== undefined && r.lastTradeAt !== undefined)).toBe(true)
    // The recorded On Fire held a change of 4,445,280%: read as it is.
    expect(at(onfireFields).some((r) => (r.change1h ?? 0) > 40_000)).toBe(true)
  })

  test("a failed read keeps the last list, with when it was read and why it failed", async () => {
    let fail = false
    const r = rig({ wanted: ["new"], answer: (b) => (fail && b === "new" ? refused("INTERNAL", { success: false, error: { code: "INTERNAL", message: "feed unavailable" } }) : ok({ success: true, tokens: [{ address: MOON, symbol: "MOON" }] })) })
    await r.feeds.step()
    const first = r.feeds.view().new!
    fail = true
    await r.run(16_000)
    const after = r.feeds.view().new!
    expect(after.rows).toEqual(first.rows)
    expect(after.at).toBe(first.at)
    expect(after.failed).toMatchObject({ words: "feed unavailable" })
    // The next good read clears it.
    fail = false
    await r.run(16_000)
    expect(r.feeds.view().new!.failed).toBeUndefined()
  })

  test("a read that never reached Candle isn't a try: it's asked again in seconds, not at the list's next turn", async () => {
    let answer: ToolOutcome = refused("CANDLE_MCP_DOWN")
    const r = rig({ answer: () => answer })
    await r.feeds.step()
    expect(r.feeds.view().onfire).toEqual({ bucket: "onfire", at: null, rows: [] })
    answer = refused("BUDGET_WAIT")
    r.tick(RETRY_SOON_MS)
    await r.feeds.step()
    expect(r.count("onfire")).toBe(2)
    answer = ok({ success: true, tokens: [{ address: MOON, symbol: "MOON" }] })
    r.tick(RETRY_SOON_MS)
    await r.feeds.step()
    expect(r.feeds.view().onfire?.rows.map((t) => t.symbol)).toEqual(["MOON"])
    // A refusal from Candle itself waits On Fire's minute.
    answer = refused("RATE_LIMITED")
    r.tick(60_000)
    await r.feeds.step()
    await r.run(30_000)
    expect(r.count("onfire")).toBe(4)
  })

  test("On Fire carries over to the token pane's empty state as `trending`, in its old shape", async () => {
    const r = rig({ answer: () => ok({ success: true, tokens: [{ address: MOON, symbol: "MOON", name: "Moon Coin", marketCap: 812_000, priceUsd: 0.5, change1h: -3.2 }] }) })
    expect(r.feeds.trending()).toBeNull()
    await r.feeds.step()
    expect(r.feeds.trending()).toEqual({ bucket: "onfire", at: 1_000_000, rows: [{ mint: MOON, symbol: "MOON", name: "Moon Coin", marketCap: 812_000, priceUsd: 0.5, change1h: expect.closeTo(-0.032, 9) }] })
    expect(r.published.at(-1)?.changed).toBe("onfire")
  })
})

describe("how often", () => {
  test("with a Trending list on screen, every wanted list every 15 s, On Fire with them", async () => {
    const r = rig({ wanted: ["new", "graduated", "onfire", "finalstretch"] })
    await r.run(60_000)
    for (const b of BUCKETS) expect(r.count(b)).toBe(4)
    expect(r.feeds.demand()).toEqual({ perMin: 16, lists: 4 })
    expect(r.feeds.paceMs()).toBe(15_000)
  })

  test("On Fire alone (the Cockpit's Feed, the empty states) stays at a minute; nothing else is read", async () => {
    const r = rig({ wanted: ["onfire"] })
    await r.run(120_000)
    expect(r.calls.map((c) => c.bucket)).toEqual(["onfire", "onfire"])
    expect(r.feeds.demand()).toEqual({ perMin: 1, lists: 1 })
    expect(r.feeds.paceMs()).toBe(60_000)
  })

  test("leaving the tab stops its lists: only On Fire goes on, at its minute; stopped, nothing", async () => {
    const r = rig({ wanted: ["new", "graduated", "finalstretch"] })
    await r.run(30_000)
    r.want([])
    r.calls.length = 0
    await r.run(180_000)
    expect(new Set(r.calls.map((c) => c.bucket))).toEqual(new Set(["onfire"]))
    expect(r.count("onfire")).toBe(3)
    r.feeds.stop()
    expect(r.feeds.active()).toEqual([])
    expect(r.feeds.demand()).toEqual({ perMin: 0, lists: 0 })
  })

  test("a list newly wanted is read at once, not at the next turn", async () => {
    const r = rig()
    await r.feeds.step()
    r.tick(3_000)
    r.want(["graduated"])
    await r.feeds.step()
    expect(r.count("graduated")).toBe(1)
  })

  test("the key's budget stretches the lists: at 4 times, every 60 s", async () => {
    const r = rig({ wanted: ["new", "onfire"], stretch: 4 })
    await r.run(120_000)
    expect(r.count("new")).toBe(2)
    expect(r.count("onfire")).toBe(2)
  })
})

describe("Trending on Hood", () => {
  const both = () => [{ chain: "solana" as const }, { chain: "hood" as const, slow: true }]
  test("all chains: Hood's New, Graduated and On Fire at half the pace, only while on screen; never Final Stretch. Inside Free's 30 a minute", async () => {
    const r = rig({ wanted: ["new", "graduated", "onfire", "finalstretch"], chains: both })
    await r.run(60_000)
    for (const b of BUCKETS) expect(r.count(b)).toBe(4)
    for (const b of ["new", "graduated", "onfire"] as const) expect(r.count(b, "hood")).toBe(2)
    expect(r.count("finalstretch", "hood")).toBe(0)
    expect(r.feeds.demand()).toEqual({ perMin: 22, lists: 7 })
    expect(r.feeds.demand().perMin).toBeLessThanOrEqual(30)
    // Off the tab, Hood's lists stop: only Solana's On Fire goes on, for the empty states.
    r.want([])
    r.calls.length = 0
    await r.run(120_000)
    expect(new Set(r.calls.map((c) => `${c.chain}:${c.bucket}`))).toEqual(new Set(["solana:onfire"]))
  })

  test("on Free's 30 a minute, both chains on screen and then off it: the lists' reads stay inside the background share, and their pane says the limit slows them", async () => {
    let clock = 1_000_000
    let wanted = new Set<Bucket>(["new", "graduated", "onfire", "finalstretch"])
    const budget = new KeyBudget({ limitOf: () => FREE_LIMIT, agents: () => ["momentum"], preferred: () => "momentum", now: () => clock })
    const reads: number[] = []
    const feeds: Feeds = new Feeds({
      call: async (_tool, args) => {
        const agent = budget.take("lists")
        if (!agent) return BUDGET_WAIT
        budget.noteCall(agent)
        reads.push(clock)
        return ok({ success: true, tokens: args.chain === "hood" ? [{ chain: "hood", address: HOOD, symbol: "KITE" }] : [{ chain: "solana", address: MOON, symbol: "MOON" }] })
      },
      now: () => clock,
      wanted: () => wanted,
      publish: () => {},
      stretch: () => budget.stretch("lists"),
      chains: both,
    })
    budget.want("lists", { perMin: () => feeds.demand().perMin, floor: () => feeds.demand().lists, naturalMs: () => feeds.paceMs() })
    ;(feeds as unknown as { running: boolean }).running = true
    const share = Math.floor(FREE_LIMIT * BACKGROUND_SHARE)
    /** The most reads in any minute from `from` on. */
    const busiest = (from: number) => Math.max(0, ...reads.filter((at) => at >= from).map((at) => reads.filter((x) => x >= at && x < at + 60_000).length))
    const run = async (ms: number) => {
      const end = clock + ms
      while (clock < end) {
        await feeds.step()
        clock += 1_000
      }
    }

    // On screen: 22 a minute wanted, more than the share holds.
    await run(5 * 60_000)
    expect(feeds.demand().perMin).toBe(22)
    expect(busiest(0)).toBeLessThanOrEqual(share)
    expect(reads.length).toBeGreaterThan(0)
    expect(budget.pace().lists).toMatchObject({ why: "limit" })
    expect(budget.use()[0]!.background).toBeLessThanOrEqual(share)

    // Off the tab: Solana's On Fire alone, inside the share too, and nothing slows it.
    wanted = new Set()
    const closed = clock
    await run(5 * 60_000)
    expect(busiest(closed)).toBeLessThanOrEqual(share)
    expect(reads.filter((at) => at >= closed).length).toBeGreaterThan(0)
    expect(budget.pace().lists).toBeUndefined()
  })

  test("Hood picked: Hood's lists take Solana's pace and Solana's stop", async () => {
    const r = rig({ wanted: ["new", "onfire"], chains: () => [{ chain: "hood" }] })
    await r.run(60_000)
    expect(r.count("new", "hood")).toBe(4)
    expect(r.count("onfire", "hood")).toBe(4)
    expect(r.count("new")).toBe(0)
    expect(r.count("onfire")).toBe(0)
  })

  test("each list holds both chains' rows, each with its chain: New by when it was made, newest first", async () => {
    const r = rig({ wanted: ["new"], chains: both })
    await r.run(1_000)
    const rows = r.feeds.view().new!.rows
    expect(rows.map((x) => [x.symbol, x.chain])).toEqual([
      ["KITE", "hood"],
      ["MOON", "solana"],
    ])
    // On Fire's ranks interleave, a chain's first beside the other's first.
    const fire = rig({
      wanted: ["onfire"],
      chains: both,
      answer: (_b, chain) => ok({ tokens: chain === "hood" ? [{ chain: "hood", address: HOOD, symbol: "H1" }, { chain: "hood", address: `${HOOD.slice(0, -1)}2`, symbol: "H2" }] : [{ chain: "solana", address: MOON, symbol: "S1" }, { chain: "solana", address: DUST, symbol: "S2" }] }),
    })
    await fire.run(1_000)
    expect(fire.feeds.view().onfire!.rows.map((x) => x.symbol)).toEqual(["S1", "H1", "S2", "H2"])
  })
})

describe("Final Stretch says the truth", () => {
  test("off on Candle's server (refused as an unknown bucket): off, no rows, and asked again only every 10 minutes", async () => {
    const r = rig({ wanted: ["finalstretch"], answer: (b) => (b === "finalstretch" ? refused("VALIDATION_FAILED", unknownBucket.answer) : ok({ success: true, tokens: [] })) })
    await r.run(60_000)
    expect(r.feeds.view().finalstretch).toEqual({ bucket: "finalstretch", at: 1_000_000, rows: [], state: "off" })
    expect(r.count("finalstretch")).toBe(1)
    expect(r.feeds.naturalMs("finalstretch")).toBe(OFF_RETRY_MS)
    await r.run(OFF_RETRY_MS)
    expect(r.count("finalstretch")).toBe(2)
  })

  test("empty and trusted (feed.ok, exact.ok, not stale): nothing on the stretch, no state", async () => {
    const r = rig({ wanted: ["finalstretch"], answer: () => ok(stretchHood.answer) })
    await r.feeds.step()
    const list = r.feeds.view().finalstretch!
    expect(list.rows).toEqual([])
    expect(list.state).toBeUndefined()
  })

  test("behind: stale, or its feed or exact read not ok, says so with how far, and keeps the rows it has", async () => {
    const answer = stretchFields.answer as Record<string, unknown>
    for (const shape of [
      { ...answer, stale: true, feed: { ok: true, ageS: 184 } },
      { ...answer, feed: { ok: false, ageS: 184 } },
      { ...answer, exact: { ok: false }, feed: { ok: true, ageS: 184 } },
    ]) {
      const r = rig({ wanted: ["finalstretch"], answer: () => ok(shape) })
      await r.feeds.step()
      const list = r.feeds.view().finalstretch!
      expect(list).toMatchObject({ state: "behind", behindS: 184 })
      expect(list.rows.length).toBeGreaterThan(0)
    }
    // The recorded answer is trusted.
    const trusted = rig({ wanted: ["finalstretch"], answer: () => ok(answer) })
    await trusted.feeds.step()
    expect(trusted.feeds.view().finalstretch!.state).toBeUndefined()
  })
})

describe("the feeds topic's filter", () => {
  test("a subscription names its buckets; a list Candle doesn't have, or none, is the caller's error", () => {
    expect(feedsTopicFilter.parse({ buckets: ["new", "onfire", "new"] })).toEqual({ buckets: ["new", "onfire"] })
    expect(feedsTopicFilter.parse({ buckets: [] })).toHaveProperty("problem")
    expect(feedsTopicFilter.parse({ buckets: ["bluechip"] })).toEqual({ problem: "No list called bluechip: the lists are new, graduated, onfire, finalstretch." })
    expect(feedsTopicFilter.parse(null)).toHaveProperty("problem")
  })

  test("each subscriber gets only its own lists; an event with none of them isn't sent", () => {
    const view: FeedsView = { new: { bucket: "new", at: 1, rows: [] }, onfire: { bucket: "onfire", at: 1, rows: [] } }
    expect(feedsTopicFilter.apply(view, { buckets: ["onfire"] })).toEqual({ onfire: view.onfire })
    expect(feedsTopicFilter.apply(view, { buckets: ["graduated"] })).toBeUndefined()
  })
})

// End to end through a real core and the fake Candle server: what the views subscribe to is what's read.
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const feedCalls = (c: TestCore): string[] =>
  ["momentum", "swing"].flatMap((agent) => {
    const path = join(candleConfigDir(c.p.stateDir, agent), "fake-candle-calls.jsonl")
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; args: { bucket?: string } })
      .filter((l) => l.name === "candle_get_feed")
      .map((l) => l.args.bucket ?? "")
  })

const latestFeeds = (view: TestClient): FeedsView | undefined => view.events.filter((e) => e.topic === "feeds").at(-1)?.data as FeedsView | undefined

describe("through a real core", () => {
  test("a view subscribing to Trending's lists gets them; unsubscribed, only On Fire is read, for the empty states", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    const sub = await view.request("subscribe", { topics: ["feeds"], filters: { feeds: { buckets: ["new", "graduated", "finalstretch"] } } })
    expect(sub.error).toBeUndefined()
    await until(() => ["new", "graduated", "finalstretch"].every((b) => (latestFeeds(view)?.[b as Bucket]?.rows.length ?? 0) > 0))
    // Its own lists only: On Fire is read, but not sent to a subscriber that didn't name it.
    expect(view.events.filter((e) => e.topic === "feeds").some((e) => "onfire" in ((e.data as object) ?? {}))).toBe(false)
    await view.request("unsubscribe", { topics: ["feeds"] })
    const before = feedCalls(c).filter((b) => b !== "onfire").length
    await Bun.sleep(1_500)
    expect(feedCalls(c).filter((b) => b !== "onfire").length).toBe(before)
    expect(feedCalls(c)).toContain("onfire")
  })

  test("Final Stretch off on Candle's server reaches the view as off", async () => {
    const c = await startTestCore({}, { candle: { momentum: { finalStretch: "off" }, swing: { finalStretch: "off" } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["feeds"], filters: { feeds: { buckets: ["finalstretch"] } } })
    await until(() => latestFeeds(view)?.finalstretch?.state === "off")
  })

  test("a Solana-only account whose Hood read fails reads Solana's lists alone; one that holds on Hood reads Hood's too", async () => {
    const chainsRead = (c: TestCore) =>
      ["momentum", "swing"].flatMap((agent) => {
        const path = join(candleConfigDir(c.p.stateDir, agent), "fake-candle-calls.jsonl")
        if (!existsSync(path)) return []
        return readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { name: string; args: { chain?: string } })
          .filter((l) => l.name === "candle_get_feed")
          .map((l) => l.args.chain ?? "solana")
      })
    const read = async (script: Record<string, unknown>) => {
      const c = await startTestCore({}, { candle: { momentum: script, swing: script } })
      cores.push(c)
      const view = await c.view()
      await view.request("subscribe", { topics: ["feeds", "portfolio"], filters: { feeds: { buckets: ["new"] } } })
      await until(() => view.events.some((e) => e.topic === "portfolio" && (e.data as { readAt: number | null }).readAt !== null))
      return { c, view }
    }
    const held = await read({ evmWei: "1000000000000000000" })
    await until(() => chainsRead(held.c).includes("hood"))
    const failed = await read({ hoodUnread: true })
    const portfolio = failed.view.events.filter((e) => e.topic === "portfolio").at(-1)!.data as { chains: string[]; wallets: { chain: string }[] }
    expect(portfolio.chains).toEqual(["solana"])
    expect(portfolio.wallets.map((w) => w.chain)).not.toContain("hood")
    await until(() => (latestFeeds(failed.view)?.new?.rows.length ?? 0) > 0)
    await Bun.sleep(500)
    expect(chainsRead(failed.c)).not.toContain("hood")
  })

  test("a harness may not subscribe to the lists", async () => {
    const c = await startTestCore()
    cores.push(c)
    const { client } = await c.harness()
    const sub = await client.request("subscribe", { topics: ["feeds"] })
    expect(sub.error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  })
})

test("where a token launched, in six cells (the column that took the price's place)", () => {
  expect(whereOf({ launchpad: "pump.fun", isCandle: false, chain: "solana" })).toBe("pump")
  expect(whereOf({ launchpad: "letsbonk.fun" })).toBe("bonk")
  expect(whereOf({ launchpad: "https://www.moonshot.money/x" })).toBe("moonsh")
  expect(whereOf({ launchpad: "pump.fun", isCandle: true })).toBe("candle")
  expect(whereOf({ launchpad: "pump.fun", chain: "hood" })).toBe("hood")
  expect(whereOf({})).toBeUndefined()
  // No launchpad from Candle (most Final Stretch rows): a pump.fun mint says it; any other stays "—".
  expect(whereOf({ address: "Fake1111111111111111111111111111111111pump" })).toBe("pump")
  expect(whereOf({ address: "Fake11111111111111111111111111111111111111" })).toBeUndefined()
  expect(whereOf({ launchpad: "raydium-launchlab", address: "Fake1111111111111111111111111111111111pump" })).toBe("raydiu")
  // Candle's recorded New list: every row says where it launched.
  const rows = feedRows((JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded/feeds-pnl/feed-new-all-fields.json"), "utf8")) as { answer: unknown }).answer)
  expect(rows?.length).toBeGreaterThan(0)
  expect(rows!.every((r) => r.where === "pump" || r.where === "candle")).toBe(true)
})
