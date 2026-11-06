// Research's reads: the linked token's check, top traders, signals and
// mentions, each of Hacc's reads at most once a minute for each token while a Research pane shows it; the
// old token's reads dropped when the link moves, and every read stopped when the tab goes.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { startFakeHacc } from "../../test/fake-hacc"
import forensicsRecorded from "../../test/fixtures/candle-recorded/cli-agent-a-candle_token_forensics.json"
import jupOverview from "../../test/fixtures/hacc-recorded/research/research-jup-launch-overview.json"
import jupProfile from "../../test/fixtures/hacc-recorded/research/research-jup-profile.json"
import jupSignals from "../../test/fixtures/hacc-recorded/research/research-jup-signals-asset.json"
import jupTraders from "../../test/fixtures/hacc-recorded/research/research-jup-top-traders.json"
import youngOverview from "../../test/fixtures/hacc-recorded/research/research-young-launch-overview.json"
import youngProfile from "../../test/fixtures/hacc-recorded/research/research-young-profile.json"
import youngSignals from "../../test/fixtures/hacc-recorded/research/research-young-signals-asset.json"
import { PlanHeld } from "./plan-held"
import type { HaccPlan } from "./plan-state"
import {
  AGAIN_MS,
  CHECK_MS,
  candleCheck,
  READ_PLAN,
  type CheckRead,
  type HaccRead,
  haccFacts,
  mentionRows,
  READ_MS,
  type ResearchAnswer,
  type ResearchPart,
  ResearchReads,
  researchRequest,
  type ResearchToken,
  researchTopicFilter,
  type ResearchView,
  tokenSignalRows,
  traderRows,
} from "./research-reads"

const JUP: ResearchToken = { mint: "JupFake111111111111111111111111111111111111", chain: "solana", symbol: "JUP" }
const YOUNG: ResearchToken = { mint: "YoungFake11111111111111111111111111111111111", chain: "solana", symbol: "YNG" }

const BODIES: Record<HaccRead, unknown> = { traders: jupTraders.answer, signals: jupSignals.answer, overview: jupOverview.answer, profile: jupProfile.answer }

function rig(opts: { wanted?: ResearchPart[]; linked?: ResearchToken | null; plan?: HaccPlan; cant?: string; answer?: (read: HaccRead, mint: string) => ResearchAnswer; check?: CheckRead | null } = {}) {
  let clock = 1_000_000
  let wanted = new Set<ResearchPart>(opts.wanted ?? ["check", "traders", "signals", "mentions"])
  let linked: ResearchToken | null = opts.linked === undefined ? JUP : opts.linked
  let check: CheckRead | null = opts.check === undefined ? { at: clock, outcome: { kind: "ok", result: forensicsRecorded.outcome.result } } : opts.check
  const calls: { read: HaccRead; route: string; query: Record<string, string | number>; mint: string; at: number }[] = []
  const published: ResearchView[] = []
  let rechecks = 0
  let plan = opts.plan
  const research = new ResearchReads({
    linked: () => linked,
    wanted: () => wanted,
    hacc: async (read, route, query) => {
      const mint = decodeURIComponent(route.split("/")[4] ?? String(query.asset))
      calls.push({ read, route, query, mint, at: clock })
      return opts.answer?.(read, mint) ?? { kind: "ok", body: BODIES[read] }
    },
    haccCant: () => opts.cant,
    plan: () => plan,
    held: new PlanHeld(),
    check: () => check,
    recheck: async () => {
      rechecks++
      check = { at: clock, outcome: { kind: "ok", result: forensicsRecorded.outcome.result } }
    },
    now: () => clock,
    publish: (view) => published.push(view),
  })
  // Running as with a view attached, driven by step() rather than its own timer.
  ;(research as unknown as { running: boolean }).running = true
  const run = async (ms: number) => {
    const end = clock + ms
    while (clock < end) {
      await research.step()
      clock += 1_000
    }
  }
  return {
    research,
    calls,
    published,
    run,
    setPlan: (p: HaccPlan) => {
      plan = p
    },
    rechecks: () => rechecks,
    tick: (ms: number) => (clock += ms),
    want: (p: ResearchPart[]) => (wanted = new Set(p)),
    link: (t: ResearchToken | null) => {
      linked = t
      research.poke()
    },
    count: (read: HaccRead, mint = JUP.mint) => calls.filter((c) => c.read === read && c.mint === mint).length,
  }
}

describe("what each pane shows, from Candle's and Hacc's recordings", () => {
  test("Check: Candle's flags, mint facts, the sell probe, the dev wallet and what Candle couldn't check", () => {
    const c = candleCheck(forensicsRecorded.outcome.result)!
    expect(c.summary).toBe("flagged")
    expect(c.flags.map((f) => [f.name, f.status])).toEqual([
      ["mintAuthority", "flagged"],
      ["freezeAuthority", "clear"],
      ["tokenExtensions", "clear"],
      ["lpLock", "clear"],
      ["sellability", "clear"],
      ["liquidityDrain", "clear"],
    ])
    // An address is never a flag's value; a short word or a count is.
    expect(c.flags.find((f) => f.name === "mintAuthority")!.value).toBeUndefined()
    expect(c.flags.find((f) => f.name === "sellability")!.value).toBe("sellable")
    expect(c.mint).toEqual({ mintAuthority: "AuthorityFake111111111111111111111111111111", freezeAuthority: null, program: "spl", renounced: false, extensions: [], risks: [] })
    expect(c.sellProbe).toMatchObject({ routable: true, usd: 50 })
    expect(c.dev).toEqual({ address: "DevFake111111111111111111111111111111111111", priorLaunches: 0, graduated: 0, died: 0, verdict: "first_launch" })
    expect(c.unchecked).toEqual(["deploy_window", "disclosed_wallets"])
    expect(candleCheck({ success: false })).toBeUndefined()
  })

  test("Check: Hacc's stage, curve and age from the profile; holders and the top-10 share from the overview", () => {
    const young = haccFacts(youngProfile.answer, youngOverview.answer)
    expect(young).toMatchObject({ stage: "bonding_curve", launchpad: "pump", progress: expect.closeTo(0.639, 3), createdAt: Date.parse("2026-10-30T13:31:28.000Z") })
    // A curve's liquidity of 0 is no pool, not an empty one: left out.
    expect(young.liquidityUsd ?? null).toBe((youngOverview.answer.market.liquidity_usd as number | null) || null)
    const jup = haccFacts(jupProfile.answer, jupOverview.answer)
    expect(jup).toMatchObject({ holders: 831031, top10Pct: 65.2096 })
    expect(jup.liquidityUsd).toBeGreaterThan(1e6)
    expect(haccFacts(undefined, undefined)).toEqual({})
    // A token Hacc doesn't know (as Hacc answers live): its profile's "unknown" stage, 0 holders and 0 progress aren't facts.
    expect(haccFacts({ stage: "unknown", launchpad_progress: 0, holder_count: 0 }, undefined)).toEqual({})
  })

  test("Traders: each wallet's P&L as Hacc reads it, a handle only if it's one, and no row without an address", () => {
    const rows = traderRows(jupTraders.answer)!
    expect(rows).toHaveLength(jupTraders.answer.traders.length)
    expect(rows[1]).toEqual({ address: "HaccFake1111111111111111111111111111111111U", realizedUsd: 1102.7670380375648, unrealizedUsd: -894.8288901202384, totalUsd: 207.93814791732643, trades: 1584, volumeUsd: 815033.2677492005, tracked: false })
    const odd = traderRows({ traders: [{ address: "not an address" }, { address: "HaccFake1111111111111111111111111111111111U", x_handle: "@good_one", entity: { name: "Fund\u001b[2J X" } }, { address: "HaccFake1111111111111111111111111111111111V", x_handle: "bad handle!" }] })!
    expect(odd).toHaveLength(2)
    expect(odd[0]).toMatchObject({ handle: "good_one", label: "Fund[2J X" })
    expect(odd[1]!.handle).toBeUndefined()
  })

  test("Its signals: the stream's cleaned rows, oldest first", () => {
    const rows = tokenSignalRows(youngSignals.answer)!
    expect(rows.length).toBe(youngSignals.answer.signals.length)
    expect(rows.map((r) => Date.parse(r.created_at))).toEqual(rows.map((r) => Date.parse(r.created_at)).toSorted((a, b) => a - b))
    expect(tokenSignalRows({ nope: 1 })).toBeUndefined()
  })

  test("Mentions: the overview's posts, newest first, with how many accounts over what span", () => {
    const m = mentionRows(jupOverview.answer)!
    expect(m.rows.map((r) => [r.handle, r.followers, r.repost])).toEqual([
      ["fake-handle-1", 540989, false],
      ["fake-handle-2", 3352, true],
    ])
    expect(m.accounts).toBe(2)
    expect(m.from).toBe(Date.parse("2026-10-09T12:43:56.000Z"))
    expect(m.rows[0]!.at).toBeGreaterThan(m.rows[1]!.at)
    // The young token's overview has no posts: an empty list, which the pane says in words.
    expect(mentionRows(youngOverview.answer)!.rows).toEqual([])
    const odd = mentionRows({ kol_tweets: { tweets: [{ handle: "ok_handle", posted_at: "2026-10-30T12:00:00Z", text: "buy\u001b[31m now\nplease", rt: false }, { handle: "no", posted_at: "never" }] } })!
    expect(odd.rows).toEqual([{ handle: "ok_handle", at: Date.parse("2026-10-30T12:00:00Z"), text: "buy[31m now please", repost: false }])
  })

  test("each read's route and query: the same as the agent's tools ask, so Hacc's short cache serves both", () => {
    expect(researchRequest("traders", "solana", JUP.mint)).toEqual({ route: `/v1/market/token/${JUP.mint}/top-traders`, query: {}, cacheMs: 30_000 })
    expect(researchRequest("traders", "hood", "0xfa4e000000000000000000000000000000000005").query).toEqual({ chain: "hood" })
    expect(researchRequest("signals", "solana", JUP.mint)).toEqual({ route: "/v1/signals", query: { asset: JUP.mint, limit: 30, quality: "all" }, cacheMs: 30_000 })
    expect(researchRequest("overview", "solana", JUP.mint).route).toBe(`/v1/market/token/${JUP.mint}/launch-overview`)
    expect(researchRequest("profile", "solana", JUP.mint).route).toBe(`/v1/market/token/${JUP.mint}/profile`)
  })
})

describe("when it reads (each read at most once a minute for each token)", () => {
  test("every pane wanted: four reads at once, the overview once for Check and Mentions together", async () => {
    const r = rig()
    await r.research.step()
    expect(r.calls.map((c) => c.read).toSorted()).toEqual(["overview", "profile", "signals", "traders"])
    const v = r.research.view()
    expect(v.token).toEqual(JUP)
    expect(v.traders!.data).toHaveLength(jupTraders.answer.traders.length)
    expect(v.mentions!.data!.rows).toHaveLength(2)
    expect(v.check!.candle.data!.summary).toBe("flagged")
    expect(v.check!.hacc.data!.holders).toBe(831031)
  })

  test("then once a minute, however often it steps", async () => {
    const r = rig()
    await r.run(5 * 60_000 - 1_000)
    for (const read of ["traders", "signals", "overview", "profile"] as const) expect(r.count(read)).toBe(5)
  })

  test("only what the panes on screen need: Traders alone reads top traders alone", async () => {
    const r = rig({ wanted: ["traders"] })
    await r.run(60_000)
    expect(new Set(r.calls.map((c) => c.read))).toEqual(new Set(["traders"]))
    expect(Object.keys(r.research.view()).toSorted()).toEqual(["token", "traders"])
  })

  test("a refusal counts as a read: it isn't asked again for a minute, and the last good rows stay under its words", async () => {
    let fail = false
    const r = rig({ wanted: ["traders"], answer: (read) => (fail ? { kind: "refused", words: "Hacc failed (503: busy)." } : { kind: "ok", body: BODIES[read] }) })
    await r.research.step()
    fail = true
    r.tick(READ_MS)
    await r.research.step()
    await r.run(30_000)
    expect(r.count("traders")).toBe(2)
    const t = r.research.view().traders!
    expect(t.data).toHaveLength(jupTraders.answer.traders.length)
    expect(t.failed?.words).toBe("Hacc failed (503: busy).")
  })

  test("an answer Hacc couldn't fill says Hacc's words, holds nothing, and keeps the last good rows", async () => {
    // As Hacc answered top traders from a Max key: a 200 with no rows and why.
    const tariff = { source: "stored", observed_at: null, missing_fields: ["snapshot"], refresh_available: false, required_tier: "pro", research_credits: 0, refresh_refused: "Provider endpoint has no approved research tariff" }
    let unread = true
    const r = rig({ wanted: ["traders"], answer: (read) => ({ kind: "ok", body: read === "traders" && unread ? tariff : BODIES[read] }) })
    await r.research.step()
    let t = r.research.view().traders!
    expect(t.data).toBeNull()
    expect(t.cant).toBeUndefined()
    expect(t.failed?.words).toBe("Hacc couldn't read it (Hacc: Provider endpoint has no approved research tariff)")
    unread = false
    r.tick(READ_MS)
    await r.research.step()
    expect(r.research.view().traders!.data).toHaveLength(jupTraders.answer.traders.length)
    unread = true
    r.tick(READ_MS)
    await r.research.step()
    t = r.research.view().traders!
    expect(t.data).toHaveLength(jupTraders.answer.traders.length)
    expect(t.failed?.words).toContain("no approved research tariff")
  })

  test("a key Hacc refused isn't a try: the read goes again in seconds (with the next agent's key), not in a minute", async () => {
    let refused = true
    const r = rig({ wanted: ["traders"], answer: (read) => (refused ? { kind: "refused", words: "Hacc refused momentum's key", again: true } : { kind: "ok", body: BODIES[read] }) })
    await r.research.step()
    expect(r.research.view().traders).toEqual({ at: null, data: null })
    refused = false
    expect(r.research.nextMs()).toBeLessThanOrEqual(AGAIN_MS)
    await r.run(AGAIN_MS + 1_000)
    expect(r.count("traders")).toBe(2)
    expect(r.research.view().traders!.data).toHaveLength(jupTraders.answer.traders.length)
  })

  test("switching the linked token drops the old token's reads: the new one's are read at once, and nothing more of the old", async () => {
    const r = rig()
    await r.research.step()
    r.tick(10_000)
    r.link(YOUNG)
    // The panes show the new token at once, as reading, before any of its answers.
    expect(r.published.at(-1)!.token).toEqual(YOUNG)
    expect(r.published.at(-1)!.traders).toEqual({ at: null, data: null })
    await r.research.step()
    expect(r.count("traders", YOUNG.mint)).toBe(1)
    await r.run(3 * 60_000)
    expect(r.count("traders", JUP.mint)).toBe(1)
    // At 0, 60 and 120 s.
    expect(r.count("traders", YOUNG.mint)).toBe(3)
  })

  test("back and forth within a minute costs nothing more: each token's answer is reused", async () => {
    const r = rig({ wanted: ["traders"] })
    await r.research.step()
    r.link(YOUNG)
    await r.research.step()
    r.tick(20_000)
    r.link(JUP)
    await r.research.step()
    expect(r.count("traders", JUP.mint)).toBe(1)
    expect(r.research.view().traders!.data).toHaveLength(jupTraders.answer.traders.length)
  })

  test("a late answer for a token the link has left is never shown under the new one", async () => {
    let release: (() => void) | undefined
    const r = rig({ wanted: ["traders"] })
    ;(r.research as unknown as { deps: { hacc: unknown } }).deps.hacc = async (read: HaccRead, route: string) => {
      r.calls.push({ read, route, query: {}, mint: route.split("/")[4]!, at: 0 })
      if (route.includes(JUP.mint)) await new Promise<void>((resolve) => (release = resolve))
      return { kind: "ok", body: BODIES[read] }
    }
    const first = r.research.step()
    r.link(YOUNG)
    const shown = r.published.length
    release!()
    await first
    expect(r.published.slice(shown).every((v) => v.token?.mint === YOUNG.mint)).toBe(true)
    expect(r.published.length).toBeGreaterThan(shown)
  })

  test("leaving the tab stops every read; nothing linked, nothing read; stopped, nothing", async () => {
    const r = rig()
    await r.research.step()
    r.want([])
    await r.run(3 * 60_000)
    expect(r.calls).toHaveLength(4)
    expect(r.research.nextMs()).toBe(READ_MS)
    r.want(["traders"])
    r.link(null)
    await r.run(2 * 60_000)
    expect(r.calls).toHaveLength(4)
    expect(r.research.view()).toEqual({ token: null })
    r.research.stop()
    r.link(JUP)
    await r.run(2 * 60_000)
    expect(r.calls).toHaveLength(4)
    expect(r.research.demand()).toBe(0)
  })

  test("Candle's check is read again every 5 minutes while Check shows, and not at all for the other panes", async () => {
    const r = rig({ wanted: ["traders"] })
    await r.run(2 * CHECK_MS)
    expect(r.rechecks()).toBe(0)
    r.want(["check"])
    await r.run(2 * CHECK_MS)
    expect(r.rechecks()).toBe(2)
  })
})

describe("what can't be read is said once, with no read", () => {
  test("Hacc off, or no key it takes: every Hacc part says why, and nothing is sent; Candle's check still shows", async () => {
    const r = rig({ cant: "Hacc's data is off in this Candle Harness's config ([hacc] enabled = false)." })
    await r.run(2 * 60_000)
    expect(r.calls).toHaveLength(0)
    const v = r.research.view()
    expect(v.traders).toEqual({ at: null, data: null, cant: "Hacc's data is off in this Candle Harness's config ([hacc] enabled = false)." })
    expect(v.check!.hacc.cant).toContain("off")
    expect(v.check!.candle.data!.summary).toBe("flagged")
  })

  test("a read the account's plan doesn't reach says which plan, and isn't sent", async () => {
    const r = rig({ plan: "free" })
    const was = READ_PLAN.traders
    ;(READ_PLAN as Record<HaccRead, HaccPlan>).traders = "pro"
    try {
      await r.run(2 * 60_000)
      expect(r.count("traders")).toBe(0)
      expect(r.count("signals")).toBe(2)
      expect(r.research.view().traders).toEqual({ at: null, data: null, cant: "Top traders need Pro on Hacc." })
    } finally {
      ;(READ_PLAN as Record<HaccRead, HaccPlan>).traders = was
    }
  })

  test("a read Hacc refused for the plan, though Candle's table says it reaches it, is held until the plan changes", async () => {
    const now = { plan: "free" as HaccPlan }
    const r = rig({ plan: "free", wanted: ["traders"], answer: (read) => (now.plan === "free" ? { kind: "refused", words: "Stored intelligence requires Pro or Max.", plan: true } : { kind: "ok", body: BODIES[read] }) })
    await r.run(5 * 60_000)
    // Asked once, then said with Hacc's words, with no "read again".
    expect(r.count("traders")).toBe(1)
    expect(r.research.view().traders).toEqual({ at: null, data: null, cant: "Top traders need a higher plan on Hacc than this account's (Hacc: Stored intelligence requires Pro or Max)." })
    now.plan = "pro"
    r.setPlan("pro")
    await r.run(2_000)
    expect(r.count("traders")).toBe(2)
    expect(r.research.view().traders!.data).toHaveLength(jupTraders.answer.traders.length)
  })
})

describe("the research topic's filter", () => {
  test("a subscription names its panes; one that isn't Research's, or none, is the caller's error", () => {
    expect(researchTopicFilter.parse({ parts: ["traders", "traders", "mentions"] })).toEqual({ parts: ["traders", "mentions"] })
    expect(researchTopicFilter.parse({})).toHaveProperty("problem")
    expect((researchTopicFilter.parse({ parts: ["chart"] }) as { problem: string }).problem).toContain("No Research pane called chart")
  })

  test("each subscriber gets the token and its own panes only", () => {
    const view: ResearchView = { token: JUP, traders: { at: 1, data: [] }, mentions: { at: 1, data: { rows: [] } } }
    expect(researchTopicFilter.apply(view, { parts: ["traders"] })).toEqual({ token: JUP, traders: { at: 1, data: [] } })
  })
})

// End to end, through a real core, the fake Candle server and the fake Hacc.
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const latest = (view: TestClient): ResearchView | undefined => view.events.filter((e) => e.topic === "research").at(-1)?.data as ResearchView | undefined

describe("through a real core", () => {
  test("a view on Research reads the linked token from Hacc with an agent's key; a new link reads the new one; unsubscribed, nothing more", async () => {
    const hacc = startFakeHacc({ keys: [AGENT_KEY] })
    try {
      const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } } })
      cores.push(c)
      const view = await c.view()
      const sub = await view.request("subscribe", { topics: ["research"], filters: { research: { parts: ["check", "traders", "signals", "mentions"] } } })
      expect(sub.error).toBeUndefined()
      expect((await view.request("view.link", { mint: MOON, chain: "solana" })).error).toBeUndefined()
      await until(() => latest(view)?.token?.mint === MOON && (latest(view)?.traders?.data?.length ?? 0) > 0 && latest(view)?.check?.candle.data != null && latest(view)?.mentions?.at != null)
      const research = () => hacc.calls.filter((call) => /top-traders|launch-overview|\/profile$/.test(call.path) || (call.path === "/v1/signals" && call.query.asset !== undefined))
      expect(research().every((call) => call.auth === `Bearer ${AGENT_KEY}`)).toBe(true)
      expect(research().filter((call) => call.path.includes(MOON) || call.query.asset === MOON)).toHaveLength(4)
      expect(latest(view)!.check!.candle.data!.summary).toBe("incomplete")
      // A new link: the new token's four reads, none more of the old.
      await view.request("view.link", { mint: PEPE, chain: "solana" })
      await until(() => latest(view)?.token?.mint === PEPE && (latest(view)?.traders?.data?.length ?? 0) > 0)
      expect(research().filter((call) => call.path.includes(MOON) || call.query.asset === MOON)).toHaveLength(4)
      await view.request("unsubscribe", { topics: ["research"] })
      const before = research().length
      await Bun.sleep(1_200)
      expect(research().length).toBe(before)
    } finally {
      hacc.stop()
    }
  })

  test("with Hacc off, the panes say so and nothing is sent to Hacc", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["research"], filters: { research: { parts: ["traders"] } } })
    await view.request("view.link", { mint: MOON, chain: "solana" })
    await until(() => latest(view)?.token?.mint === MOON)
    expect(latest(view)!.traders!.cant).toContain("off")
  })

  test("a harness may not subscribe to Research", async () => {
    const c = await startTestCore()
    cores.push(c)
    const { client } = await c.harness()
    const sub = await client.request("subscribe", { topics: ["research"] })
    expect(sub.error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  })
})
