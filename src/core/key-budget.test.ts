// Each key's request budget: every call counted over a sliding minute, background reads
// planned into half the key's Candle limit in order, a reserve kept for a card, reads any key may make
// spread to the key with most room, and nothing on the trade path ever asked or held.
import { describe, expect, test } from "bun:test"
import type { ToolOutcome } from "./candle-mcp"
import { BUDGET_WAIT, CARD_RESERVE, KeyBudget, LOWERED_MS, metered, paceWords, type ReadKind, requestsOf, WINDOW_MS } from "./key-budget"
import { PRICE_REFRESH_MS, PriceBook } from "./prices"
import { BUCKETS, Feeds, ONFIRE_MS as TRENDING_MS } from "./feeds"
import { SAMPLE_MS, TokenWatch, type WatchRead } from "./token-watch"

const OK: ToolOutcome = { kind: "ok", result: {} }
const LIMITED: ToolOutcome = { kind: "error", code: "RATE_LIMITED", retryable: true, body: {} }

function rig(opts: { limits?: Record<string, number | undefined>; agents?: string[]; active?: string } = {}) {
  let clock = 1_000_000
  let changes = 0
  const agents = opts.agents ?? ["agent-a"]
  const budget = new KeyBudget({
    limitOf: (agent) => opts.limits?.[agent],
    agents: () => agents,
    preferred: () => opts.active ?? agents[0],
    now: () => clock,
    onChange: () => changes++,
  })
  return { budget, tick: (ms: number) => (clock += ms), now: () => clock, changes: () => changes }
}

/** The token pane's and prices' demands as the core registers them, at their own paces. */
function wantAll(budget: KeyBudget, d: { prices?: number; linked?: boolean; pins?: number; lists?: boolean }, key = "agent-a") {
  budget.want("prices", { perMin: () => (d.prices ?? 0), naturalMs: PRICE_REFRESH_MS, key: () => key })
  budget.want("linked", { perMin: () => (d.linked ? 60_000 / SAMPLE_MS : 0), naturalMs: SAMPLE_MS })
  budget.want("pins", { perMin: () => (d.pins ?? 0) * (60_000 / SAMPLE_MS), floor: () => d.pins ?? 0, naturalMs: SAMPLE_MS })
  budget.want("lists", { perMin: () => (d.lists ? 60_000 / TRENDING_MS : 0), naturalMs: TRENDING_MS })
}

describe("what a call costs", () => {
  test("a tool that makes several of Candle's requests is counted as that many (measured on a Free key)", async () => {
    expect(requestsOf("candle_execution_status")).toBe(3)
    expect(requestsOf("candle_get_portfolio")).toBe(2)
    expect(requestsOf("candle_trade")).toBe(3)
    expect(requestsOf("candle_get_market")).toBe(1)
    const r = rig()
    await metered(r.budget, "agent-a", async () => OK, requestsOf("candle_execution_status"))
    expect(r.budget.use().find((u) => u.agent === "agent-a")?.used).toBe(3)
  })
})

describe("counting and the limit", () => {
  test("every call through a key is counted over a sliding minute, background reads apart", () => {
    const r = rig()
    r.budget.noteCall("agent-a")
    r.budget.noteCall("agent-a")
    expect(r.budget.take("prices", "agent-a")).toBe("agent-a")
    r.budget.noteCall("agent-a") // the read itself, as the child counts it
    expect(r.budget.use()).toEqual([{ agent: "agent-a", limit: 30, keyLimit: 30, lowered: false, used: 3, background: 1, allowance: 15 }])
    r.tick(WINDOW_MS - 1)
    expect(r.budget.use()[0]).toMatchObject({ used: 3, background: 1 })
    r.tick(1)
    expect(r.budget.use()[0]).toMatchObject({ used: 0, background: 0 })
  })

  test("the limit is the key's own as Candle states it, else Free's 30 until it's read", () => {
    const r = rig({ agents: ["agent-a", "agent-b"], limits: { "agent-a": 600 } })
    expect(r.budget.limit("agent-a")).toBe(600)
    expect(r.budget.allowance("agent-a")).toBe(300)
    expect(r.budget.limit("agent-b")).toBe(30)
    expect(r.budget.allowance("agent-b")).toBe(15)
  })

  test("a RATE_LIMITED answer halves the key's limit here for two minutes, and says so", () => {
    const r = rig({ limits: { "agent-a": 300 } })
    r.budget.noteOutcome("agent-a", OK)
    expect(r.budget.lowered("agent-a")).toBe(false)
    r.budget.noteOutcome("agent-a", LIMITED)
    expect(r.budget.use()[0]).toMatchObject({ limit: 150, keyLimit: 300, lowered: true, allowance: 75 })
    r.tick(LOWERED_MS - 1)
    expect(r.budget.lowered("agent-a")).toBe(true)
    r.tick(1)
    expect(r.budget.use()[0]).toMatchObject({ limit: 300, lowered: false })
  })
})

describe("planning the background reads", () => {
  test("at Free's 30: prices in full, the linked token slowed to fit, each pin once a minute, the list as it is", () => {
    const r = rig()
    wantAll(r.budget, { prices: 4, linked: true, pins: 2, lists: true })
    // 15 for background, planned to 13: one a minute each first (a pin counts one each), then prices' full 4,
    // then the linked token's 6 of 12.
    expect(r.budget.stretch("prices")).toBe(1)
    expect(r.budget.stretch("linked")).toBe(2)
    expect(r.budget.stretch("pins")).toBe(12)
    expect(r.budget.stretch("lists")).toBe(1)
    expect(r.budget.pace()).toEqual({ linked: { everyMs: 10_000, why: "limit" }, pins: { everyMs: 60_000, why: "limit" } })
  })

  test("on Pro or Max nothing is slowed", () => {
    for (const limit of [300, 600]) {
      const r = rig({ limits: { "agent-a": limit } })
      wantAll(r.budget, { prices: 4, linked: true, pins: 3, lists: true })
      for (const kind of ["prices", "linked", "pins", "lists"] as ReadKind[]) expect(r.budget.stretch(kind)).toBe(1)
      expect(r.budget.pace()).toEqual({})
    }
  })

  test("what isn't running asks for nothing, and isn't slowed", () => {
    const r = rig()
    wantAll(r.budget, { prices: 4 })
    expect(r.budget.pace()).toEqual({})
    expect(r.budget.stretch("pins")).toBe(1)
  })

  test("a second agent's key adds room for the reads any key may make, not for the active key's prices", () => {
    // 29 a minute wanted: one key at 40 a minute schedules 18 of them; two schedule 36, and it all fits.
    const one = rig({ limits: { "agent-a": 40 } })
    wantAll(one.budget, { prices: 4, linked: true, pins: 1, lists: true })
    expect(one.budget.stretch("pins")).toBeGreaterThan(1)
    const two = rig({ agents: ["agent-a", "agent-b"], limits: { "agent-a": 40, "agent-b": 40 } })
    wantAll(two.budget, { prices: 4, linked: true, pins: 1, lists: true })
    expect(two.budget.stretch("linked")).toBe(1)
    expect(two.budget.stretch("pins")).toBe(1)
    // The second key's room isn't lent to prices, which read the active key's own portfolio: 13 of 40.
    const solo = rig({ agents: ["agent-a", "agent-b"] })
    wantAll(solo.budget, { prices: 40 })
    expect(solo.budget.stretch("prices")).toBeCloseTo(40 / 13)
  })

  test("after a RATE_LIMITED, the plan halves too and the panes say Candle rate-limited", () => {
    const r = rig({ limits: { "agent-a": 40 } })
    wantAll(r.budget, { prices: 4, linked: true, lists: true })
    expect(r.budget.pace()).toEqual({})
    r.budget.noteOutcome("agent-a", LIMITED)
    // 10 for background, planned to 9: one each, then prices' 3 more, then 3 more for the linked token: 4 of 12.
    expect(r.budget.pace()).toEqual({ linked: { everyMs: 15_000, why: "rate-limited" } })
    expect(r.changes()).toBeGreaterThan(0)
  })
})

describe("taking a background read", () => {
  test("goes while there's room under half the limit, then waits; at its own share's edge the pane isn't told it waited", () => {
    const r = rig()
    wantAll(r.budget, { lists: true })
    for (let i = 0; i < 15; i++) expect(r.budget.take("lists")).toBe("agent-a")
    expect(r.budget.take("lists")).toBeUndefined()
    expect(r.budget.pace()).toEqual({})
    r.tick(WINDOW_MS)
    expect(r.budget.take("lists")).toBe("agent-a")
  })

  test(`waits when the key's calls in the last minute come within ${CARD_RESERVE} of its limit, whoever made them, and the pane says why`, () => {
    const r = rig()
    wantAll(r.budget, { prices: 4 })
    for (let i = 0; i < 30 - CARD_RESERVE; i++) r.budget.noteCall("agent-a") // a turn's tools and a card
    expect(r.budget.take("prices", "agent-a")).toBeUndefined()
    expect(r.budget.pace()).toEqual({ prices: { why: "busy" } })
    // A card still has its room: the budget never asked it.
    expect(30 - r.budget.use()[0]!.used).toBe(CARD_RESERVE)
    r.tick(WINDOW_MS)
    expect(r.budget.take("prices", "agent-a")).toBe("agent-a")
    expect(r.budget.pace()).toEqual({})
  })

  test("a read any key may make goes to the key with most room; the active key first among equals", () => {
    const r = rig({ agents: ["agent-a", "agent-b"], active: "agent-b" })
    expect(r.budget.take("linked")).toBe("agent-b")
    expect(r.budget.take("linked")).toBe("agent-a")
    for (let i = 0; i < 10; i++) r.budget.noteCall("agent-a")
    expect(r.budget.take("pins")).toBe("agent-b")
  })

  test("prices and P&L keep to their own key", () => {
    const r = rig({ agents: ["agent-a", "agent-b"] })
    for (let i = 0; i < 15; i++) r.budget.take("prices", "agent-a")
    expect(r.budget.take("prices", "agent-a")).toBeUndefined()
    expect(r.budget.take("pnl", "agent-b")).toBe("agent-b")
  })

  test("a read someone asked for never waits, and counts so the planned reads make room after it", () => {
    const r = rig()
    for (let i = 0; i < 40; i++) r.budget.noteCall("agent-a")
    expect(r.budget.ask()).toBe("agent-a")
    expect(r.budget.use()[0]!.background).toBe(1)
  })

  test("with no Candle connection up, a read goes to the active agent and fails on its own", () => {
    const r = rig({ agents: [] , active: "agent-a" })
    expect(r.budget.take("lists")).toBe("agent-a")
    expect(r.budget.ask()).toBe("agent-a")
  })
})

describe("the trade path", () => {
  test("a call is sent at once whatever the budget, counted, and its answer read", async () => {
    const r = rig()
    for (let i = 0; i < 100; i++) r.budget.noteCall("agent-a")
    let sent = false
    const outcome = metered(r.budget, "agent-a", async () => {
      sent = true
      return LIMITED
    })
    // Sent before metered's promise is even awaited: nothing in front of it.
    expect(sent).toBe(true)
    expect(await outcome).toBe(LIMITED)
    expect(r.budget.use()[0]).toMatchObject({ used: 101, lowered: true })
  })
})

describe("the pane's words", () => {
  test("how often it now reads, and why", () => {
    expect(paceWords(undefined)).toBeUndefined()
    expect(paceWords({ everyMs: 8_000, why: "limit" })).toBe("every 8 s (Candle's limit)")
    expect(paceWords({ everyMs: 120_000, why: "rate-limited" })).toBe("every 2 min (Candle rate-limited)")
    expect(paceWords({ why: "busy" })).toBe("waiting (room kept for trades)")
    // No " · ": a title splits on it.
    expect(paceWords({ everyMs: 60_000, why: "limit" })).not.toContain(" · ")
  })
})

/**
 * Five minutes at Free's 30 a minute, against a Candle that refuses past 30 in any minute:
 * the real token watch with a linked token, two pins and the list, the real price book, a card proposed and
 * approved twice with prices read after each fill, and a burst of a turn's reads between. Driven on a
 * simulated clock, each part at the time its own timer would fire.
 */
async function simulate(opts: { budgeted: boolean; away?: boolean }) {
  let clock = 0
  const LIMIT = 30
  const seen: number[] = []
  const answered: { tool: string; at: number; limited: boolean; by: "card" | "turn" | WatchRead | "prices" | "lists" | "away"; bucket?: unknown }[] = []
  // Candle: per key, a sliding minute.
  const candle = (tool: string, by: (typeof answered)[number]["by"], args: Record<string, unknown> = {}): ToolOutcome => {
    while (seen.length && clock - seen[0]! >= 60_000) seen.shift()
    const limited = seen.length >= LIMIT
    if (!limited) seen.push(clock)
    answered.push({ tool, at: clock, limited, by, ...(args.bucket ? { bucket: args.bucket } : {}) })
    if (limited) return LIMITED
    if (tool === "candle_get_market") return { kind: "ok", result: { market: { mint: args.mint ?? "MINT", priceUsd: 1, metadata: { symbol: "X" } } } }
    if (tool === "candle_get_feed") return { kind: "ok", result: { tokens: [] } }
    if (tool === "candle_get_portfolio") return { kind: "ok", result: { prices: { MINT: { priceUsd: 1 } } } }
    return OK
  }
  const budget = new KeyBudget({
    limitOf: () => (opts.budgeted ? LIMIT : 1_000_000),
    agents: () => ["agent-a"],
    preferred: () => "agent-a",
    now: () => clock,
  })
  const call = (tool: string, by: (typeof answered)[number]["by"], args?: Record<string, unknown>) => metered(budget, "agent-a", async () => candle(tool, by, args))
  const watch: TokenWatch = new TokenWatch({
    call: async (tool, args, read) => {
      const agent = read === "asked" ? budget.ask() : budget.take(read)
      return agent ? call(tool, read, args) : BUDGET_WAIT
    },
    stretch: (kind) => budget.stretch(kind),
    now: () => clock,
    publish: () => {},
  })
  const prices = new PriceBook({
    read: async () => (budget.take("prices", "agent-a") ? call("candle_get_portfolio", "prices") : BUDGET_WAIT),
    stretch: () => budget.stretch("prices"),
    now: () => clock,
  })
  // The Trending tab on screen: all four of Candle's lists wanted, each every 15 s at its own pace.
  const feeds = new Feeds({
    call: async (tool, args) => (budget.take("lists") ? call(tool, "lists", args) : BUDGET_WAIT),
    now: () => clock,
    wanted: () => new Set(BUCKETS),
    publish: () => {},
    stretch: () => budget.stretch("lists"),
  })
  ;(feeds as unknown as { running: boolean }).running = true
  // What the core registers while a view is attached (the loops running): driven here on the simulated
  // clock rather than by their own timers, so their demand is stated as it would be then.
  wantAll(budget, { prices: 60_000 / PRICE_REFRESH_MS, linked: true, pins: 2 })
  budget.want("lists", { perMin: () => feeds.demand().perMin, floor: () => feeds.demand().lists, naturalMs: () => feeds.paceMs() })
  await watch.follow("LinkedMint1111111111111111111111111111111111", "solana", "you")
  watch.setPinned([{ mint: "PinOne11111111111111111111111111111111111111", chain: "solana" }, { mint: "PinTwo11111111111111111111111111111111111111", chain: "solana" }])

  let nextSample = 0
  let nextPrices = 0
  let nextFeeds = 0
  const extraPrices: number[] = []
  // The view just opened on a gap: a card a second later, while the Away summary's reads land.
  const cards: { at: number; outcome?: ToolOutcome }[] = [...(opts.away ? [{ at: 1_000 }] : []), { at: 95_000 }, { at: 212_500 }]
  const turn = { from: 150_000, to: 170_000, every: 2_000 }
  let nextTurnRead = turn.from
  for (clock = 0; clock <= 300_000; clock += 250) {
    // The Away summary's reads at start, as the core makes them: reads the person asked for by opening the
    // Candle Harness (budget.ask), the agent's P&L book and its fills, never waiting.
    if (opts.away && clock === 0) {
      for (const tool of ["candle_get_profile_pnl", "candle_get_profile_trades"]) {
        budget.ask("agent-a")
        await call(tool, "away")
      }
    }
    if (clock >= nextSample) {
      await watch.sample()
      nextSample = clock + watch.nextSampleMs()
    }
    if (clock >= nextFeeds) {
      await feeds.step()
      nextFeeds = clock + feeds.nextMs()
    }
    if (clock >= nextPrices) {
      await prices.refresh()
      nextPrices = clock + prices.nextReadMs()
    }
    for (const at of extraPrices.filter((a) => a === clock)) await prices.refresh()
    if (clock >= nextTurnRead && clock <= turn.to) {
      await call("candle_get_market", "turn")
      nextTurnRead += turn.every
    }
    for (const card of cards.filter((c) => c.at === clock)) {
      // Proposed (a fresh price, the holding), approved and sent, then the wallet read after the fill.
      await call("candle_get_market", "card")
      await call("candle_get_portfolio", "card")
      card.outcome = await call("candle_trade", "card")
      for (const ms of [2_000, 8_000, 20_000]) extraPrices.push(clock + ms)
    }
  }
  return { answered, cards, budget, pace: budget.pace() }
}

describe("at Free's 30 a minute, with the token pane, two pins and Trending's four lists running", () => {
  test("no call is refused, the cards' trades go through, and the panes say what was slowed", async () => {
    const run = await simulate({ budgeted: true })
    expect(run.answered.filter((a) => a.limited)).toEqual([])
    for (const card of run.cards) expect(card.outcome).toEqual(OK)
    // Every sliding minute stayed at or under 30.
    for (const a of run.answered) expect(run.answered.filter((b) => b.at > a.at - 60_000 && b.at <= a.at).length).toBeLessThanOrEqual(30)
    // Each kind still read: the linked token most, each pin about once a minute, prices, and each of the four lists.
    const by = (k: string) => run.answered.filter((a) => a.by === k).length
    expect(by("linked")).toBeGreaterThan(by("pins"))
    expect(by("pins")).toBeGreaterThanOrEqual(8)
    expect(by("prices")).toBeGreaterThanOrEqual(15)
    for (const bucket of BUCKETS) expect(run.answered.filter((a) => a.by === "lists" && a.bucket === bucket).length).toBeGreaterThanOrEqual(4)
    expect(run.pace.pins).toEqual({ everyMs: 60_000, why: "limit" })
    // The lists slowed from 15 s to fit, and their panes say so.
    expect(run.pace.lists?.why).toBe("limit")
    expect(run.pace.lists!.everyMs!).toBeGreaterThan(15_000)
  })

  test("opening on a gap: the Away summary's reads at start and a card a second later, with Trending on screen, and nothing refused", async () => {
    const run = await simulate({ budgeted: true, away: true })
    expect(run.answered.filter((a) => a.limited)).toEqual([])
    expect(run.answered.filter((a) => a.by === "away").map((a) => a.tool)).toEqual(["candle_get_profile_pnl", "candle_get_profile_trades"])
    expect(run.cards).toHaveLength(3)
    for (const card of run.cards) expect(card.outcome).toEqual(OK)
    for (const a of run.answered) expect(run.answered.filter((b) => b.at > a.at - 60_000 && b.at <= a.at).length).toBeLessThanOrEqual(30)
    // Trending's four lists still read in the first minute.
    for (const bucket of BUCKETS) expect(run.answered.some((a) => a.by === "lists" && a.bucket === bucket && a.at < 60_000)).toBe(true)
  })

  test("without the budget, the same five minutes is refused RATE_LIMITED, a card's trade among them", async () => {
    const run = await simulate({ budgeted: false })
    expect(run.answered.filter((a) => a.limited).length).toBeGreaterThan(0)
    expect(run.answered.some((a) => a.limited && (a.by === "card" || a.by === "turn"))).toBe(true)
  })
})
