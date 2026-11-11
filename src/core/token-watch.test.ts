// The token pane's data: the token the agent last showed from Candle, its market read and token check,
// price samples for the chart, and Candle's on-fire list (the core's feeds') until there is one.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolOutcome } from "./candle-mcp"
import { historyCandles, type TokenView, TokenWatch } from "./token-watch"

const MOON = "MoonFake11111111111111111111111111111111111"
const WALLET = "WalletFake111111111111111111111111111111111"
const SOL = "So11111111111111111111111111111111111111112"

function rig(over: Partial<Record<string, (args: Record<string, unknown>) => ToolOutcome>> = {}) {
  let clock = 1_000_000
  let price = 0.63
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const published: TokenView[] = []
  const answers: Record<string, (args: Record<string, unknown>) => ToolOutcome> = {
    candle_get_market: (args) =>
      args.mint === MOON
        ? { kind: "ok", result: { success: true, market: { chain: "solana", mint: MOON, metadata: { name: "Moon\u001b[2J Coin", symbol: "MOON" }, priceUsd: price, marketCap: 1_000_000, liquidityUsd: 100_000 } } }
        : { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} },
    candle_token_forensics: () => ({
      kind: "ok",
      result: { success: true, forensics: { safety: { summary: "incomplete", flags: { mintAuthority: { status: "clear" }, lpLock: { status: "flagged" }, sellability: { status: "unknown" } } } } },
    }),
    candle_get_feed: () => ({ kind: "ok", result: { success: true, bucket: "onfire", tokens: [{ chain: "solana", address: MOON, symbol: "MOON", name: "Moon Coin", marketCap: 812_000 }, { chain: "solana", address: "x" }] } }),
    ...over,
  }
  const watch = new TokenWatch({
    call: async (tool, args) => {
      calls.push({ tool, args })
      return answers[tool]!(args)
    },
    now: () => clock,
    publish: (v) => published.push(v),
  })
  return {
    watch,
    calls,
    published,
    tick: (ms: number) => (clock += ms),
    setPrice: (p: number) => (price = p),
  }
}

describe("following a token", () => {
  test("a token Candle knows: its market and its token check, with when they were read", async () => {
    const r = rig()
    expect(await r.watch.follow(MOON)).toBe(true)
    const v = r.watch.view()
    expect(v.followed).toMatchObject({ mint: MOON, chain: "solana", symbol: "MOON" })
    // Text from Candle is drawn as it arrives, less control characters.
    expect(v.market).toEqual({ name: "Moon[2J Coin", symbol: "MOON", priceUsd: 0.63, marketCap: 1_000_000, liquidityUsd: 100_000, at: 1_000_000 })
    expect(v.check).toEqual({ summary: "incomplete", flagged: ["lpLock"], unknown: ["sellability"], at: 1_000_000 })
    expect(v.samples).toEqual([{ at: 1_000_000, usd: 0.63 }])
    expect(r.published.at(-1)?.followed?.mint).toBe(MOON)
  })

  test("an address Candle has no market for (a wallet, say) isn't followed, and the pane keeps what it had", async () => {
    const r = rig()
    await r.watch.follow(MOON)
    expect(await r.watch.follow(WALLET)).toBe(false)
    expect(r.watch.view().followed?.mint).toBe(MOON)
  })

  test("base assets aren't followed: they're what every trade spends", async () => {
    const r = rig()
    expect(await r.watch.follow(SOL)).toBe(false)
    expect(r.calls).toEqual([])
  })

  test("CNDL is followed like any token, though trades can spend it (its Positions row once did nothing)", async () => {
    const r = rig()
    await r.watch.follow("9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL")
    expect(r.calls.length).toBeGreaterThan(0)
  })

  test("following the same token again reads nothing", async () => {
    const r = rig()
    await r.watch.follow(MOON)
    const n = r.calls.length
    await r.watch.follow(MOON)
    expect(r.calls.length).toBe(n)
  })

  test("a token check Candle couldn't run says unavailable, never clear", async () => {
    const r = rig({ candle_token_forensics: () => ({ kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} }) })
    await r.watch.follow(MOON)
    expect(r.watch.view().check).toMatchObject({ summary: "unavailable", note: "MARKET_NOT_FOUND" })
  })

  test("the real answer, recorded from Candle's real server, reads as flagged with its flag named", async () => {
    const real = JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded/cli-agent-a-candle_token_forensics.json"), "utf8"))
    const r = rig({ candle_token_forensics: () => real.outcome })
    await r.watch.follow(MOON)
    expect(r.watch.view().check).toMatchObject({ summary: "flagged", flagged: ["mintAuthority"], unknown: [] })
  })
})

describe("following the agent's reply", () => {
  test("the one token a Candle or Hacc read showed; a reply naming several leaves the pane where the reads left it", async () => {
    const r = rig()
    await r.watch.followReply([{ address: MOON, source: "hacc" }])
    expect(r.watch.view().followed?.mint).toBe(MOON)
    // SOL alongside is named in passing.
    const s = rig()
    await s.watch.followReply([
      { address: "So11111111111111111111111111111111111111112", source: "candle" },
      { address: MOON, source: "candle" },
    ])
    expect(s.watch.view().followed?.mint).toBe(MOON)
    const t = rig()
    await t.watch.followReply([
      { address: MOON, source: "candle" },
      { address: WALLET, source: "candle" },
    ])
    expect(t.watch.view().followed).toBeNull()
    expect(t.calls).toEqual([])
  })

  test("an address only the web showed isn't followed until a Candle tool shows it", async () => {
    const r = rig()
    await r.watch.followReply([{ address: MOON, source: "web" }])
    expect(r.watch.view().followed).toBeNull()
    expect(r.calls).toEqual([])
    await r.watch.followReply([{ address: MOON, source: "candle" }])
    expect(r.watch.view().followed?.mint).toBe(MOON)
  })
})

describe("samples and the 1h change", () => {
  test("each sample reads the market again; the 1h change needs an hour of samples, so it's missing until then", async () => {
    const r = rig()
    await r.watch.follow(MOON)
    for (let i = 0; i < 4; i++) {
      r.tick(15_000)
      r.setPrice(0.63 + (i + 1) * 0.01)
      await r.watch.sample()
    }
    expect(r.watch.view().samples.map((s) => s.usd)).toEqual([0.63, 0.64, 0.65, 0.66, 0.67])
    expect(r.watch.view().change1h).toBeNull()
    r.tick(60 * 60_000)
    r.setPrice(0.63 * 1.5)
    await r.watch.sample()
    // From the sample nearest an hour ago.
    expect(r.watch.view().change1h).toBeCloseTo(0.945 / 0.67 - 1, 6)
  })

  test("samples older than the chart's span go", async () => {
    const r = rig()
    await r.watch.follow(MOON)
    r.tick(2 * 60 * 60_000)
    await r.watch.sample()
    expect(r.watch.view().samples).toHaveLength(1)
  })

  test("a failed read adds no sample and keeps the last market read, with its own time", async () => {
    let reads = 0
    const r = rig({
      candle_get_market: () =>
        ++reads === 1
          ? { kind: "ok", result: { success: true, market: { chain: "solana", mint: MOON, metadata: { symbol: "MOON" }, priceUsd: 0.63 } } }
          : ({ kind: "lost", reason: "timeout" } as ToolOutcome),
    })
    await r.watch.follow(MOON)
    r.tick(15_000)
    await r.watch.sample()
    expect(r.watch.view().samples).toHaveLength(1)
    expect(r.watch.view().market).toMatchObject({ priceUsd: 0.63, marketCap: null, at: 1_000_000 })
  })
})

describe("pacing", () => {
  test("a sample every 5 s; a rate-limited read doubles the wait up to a minute, and a good read restores it", async () => {
    let limited = false
    const r = rig({
      candle_get_market: (args) =>
        limited ? { kind: "error", code: "RATE_LIMITED", retryable: true, body: {} } : { kind: "ok", result: { success: true, market: { chain: "solana", mint: args.mint, metadata: { symbol: "MOON" }, priceUsd: 0.63 } } },
    })
    await r.watch.follow(MOON)
    expect(r.watch.nextSampleMs()).toBe(5_000)
    limited = true
    for (const wait of [10_000, 20_000, 40_000, 60_000, 60_000]) {
      await r.watch.sample()
      expect(r.watch.nextSampleMs()).toBe(wait)
    }
    limited = false
    await r.watch.sample()
    expect(r.watch.nextSampleMs()).toBe(5_000)
  })
})

describe("trending: Candle's on-fire list, the token pane's empty state", () => {
  test("is the core's feeds' list: carried in the view, never read here", async () => {
    const trending = { bucket: "onfire", at: 999_000, rows: [{ mint: MOON, symbol: "MOON", marketCap: 812_000, priceUsd: null, change1h: null }] }
    const calls: string[] = []
    const watch = new TokenWatch({ call: async (tool) => (calls.push(tool), { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} }), now: () => 1_000_000, publish: () => {}, trending: () => trending })
    await watch.sample()
    expect(calls).toEqual([])
    expect(watch.view().trending).toEqual(trending)
    expect(new TokenWatch({ call: async () => ({ kind: "ok", result: {} }), now: () => 0, publish: () => {} }).view().trending).toBeNull()
  })
})

// The chart and the 1h change from Hacc's history, so they show
// at once rather than after an hour of the core's own samples.
describe("Hacc's history", () => {
  const MIN = 60_000
  const MOON2 = "Moon2Fake1111111111111111111111111111111111"
  const iso = (ms: number) => new Date(ms).toISOString()
  /** Candles in Hacc's recorded shape (test/fixtures/hacc-recorded/token-history-1m-hour-candles.json). */
  const candles = (rows: [number, number][]) => ({ chain: "solana", resolution: "1m", candles: rows.map(([at, close]) => ({ at: iso(at), open: close, high: close, low: close, close, volume_usd: 10 })) })

  function hrig(answer: (chain: string, mint: string, from: string) => { kind: "ok"; body: unknown } | { kind: "refused"; words: string }) {
    let clock = 1_800_000_000_000 // a whole minute
    const reads: { chain: string; mint: string; from: string }[] = []
    const market = (args: Record<string, unknown>): ToolOutcome =>
      args.mint === MOON || args.mint === MOON2 ? { kind: "ok", result: { success: true, market: { chain: "solana", mint: args.mint, metadata: { symbol: "MOON" }, priceUsd: 0.63 } } } : { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} }
    const watch = new TokenWatch({
      call: async (tool, args) => (tool === "candle_get_market" ? market(args) : { kind: "ok", result: { success: true, forensics: { safety: { summary: "clear", flags: {} } } } }),
      history: async (chain, mint, from) => {
        reads.push({ chain, mint, from })
        return answer(chain, mint, from)
      },
      now: () => clock,
      publish: () => {},
    })
    return { watch, reads, now: () => clock, tick: (ms: number) => (clock += ms) }
  }

  test("a followed token's last hour at 1m, then the core's own samples on top, on one chart", async () => {
    let t0 = 0
    const r = hrig(() => ({ kind: "ok", body: candles([[t0 - 60 * MIN, 0.5], [t0 - 30 * MIN, 0.55], [t0 - 2 * MIN, 0.6]]) }))
    t0 = r.now()
    await r.watch.follow(MOON)
    // One read: the chart's span from a whole minute, at 1m, with the candles (they come only with
    // include_candles), a few minutes past the hour so the 1h change has a price to start from.
    expect(r.reads).toEqual([{ chain: "solana", mint: MOON, from: iso(t0 - 65 * MIN) }])
    const v = r.watch.view()
    // The first candle's open stands at its start, and each close at the end of its minute, before the first sample.
    expect(v.history).toEqual([
      { at: t0 - 60 * MIN, usd: 0.5 },
      { at: t0 - 59 * MIN, usd: 0.5 },
      { at: t0 - 29 * MIN, usd: 0.55 },
      { at: t0 - MIN, usd: 0.6 },
    ])
    expect(v.samples).toEqual([{ at: t0, usd: 0.63 }])
    expect(v.historyRead).toEqual({ source: "hacc", at: t0 })
    r.tick(5_000)
    await r.watch.sample()
    expect(r.watch.view().samples).toHaveLength(2)
    expect(r.reads).toHaveLength(1) // once per follow, not per sample
  })

  test("the 1h change shows from the start, from the last close at or before an hour ago", async () => {
    let t0 = 0
    const r = hrig(() => ({ kind: "ok", body: candles([[t0 - 61 * MIN, 0.5], [t0 - 10 * MIN, 0.6]]) }))
    t0 = r.now()
    await r.watch.follow(MOON)
    // No trade in the minute an hour ago has no candle: the price then is the last close before it.
    expect(r.watch.view().change1h).toBeCloseTo(0.63 / 0.5 - 1, 6)
    // Twenty minutes on, an hour ago is still before the next close, and that close is kept past the span.
    for (let i = 0; i < 4 * 12; i++) {
      r.tick(25_000)
      await r.watch.sample()
    }
    expect(r.watch.view().change1h).toBeCloseTo(0.63 / 0.5 - 1, 6)
    r.tick(60 * MIN)
    await r.watch.sample()
    expect(r.watch.view().history).toEqual([])
  })

  test("a token younger than an hour has no 1h change, though its chart starts at once", async () => {
    let t0 = 0
    const r = hrig(() => ({ kind: "ok", body: candles([[t0 - 20 * MIN, 0.5]]) }))
    t0 = r.now()
    await r.watch.follow(MOON)
    expect(r.watch.view().history).toHaveLength(2)
    expect(r.watch.view().change1h).toBeNull()
  })

  test("a refused read falls back to the core's samples and says why", async () => {
    const r = hrig(() => ({ kind: "refused", words: "Hacc didn't answer in 5 s." }))
    await r.watch.follow(MOON)
    const v = r.watch.view()
    expect(v.history).toEqual([])
    expect(v.historyRead).toEqual({ source: "samples", at: r.now(), words: "Hacc didn't answer in 5 s." })
    expect(v.samples).toHaveLength(1)
  })

  test("an answer with no candles, or none that read, is the fallback too, in plain words", async () => {
    const r = hrig(() => ({ kind: "ok", body: { candles: [{ at: "soon", close: 1 }, { at: iso(0), close: "0.5" }, { at: iso(0), close: -1 }] } }))
    await r.watch.follow(MOON)
    expect(r.watch.view().historyRead).toMatchObject({ source: "samples", words: "Hacc has no trades for it in the last hour." })
  })

  test("one history read per token per minute, refusals included", async () => {
    const r = hrig(() => ({ kind: "refused", words: "no" }))
    await r.watch.follow(MOON)
    await r.watch.follow(MOON2)
    r.tick(30_000)
    await r.watch.follow(MOON)
    expect(r.reads.map((x) => x.mint)).toEqual([MOON, MOON2])
    await r.watch.follow(MOON2)
    r.tick(31_000)
    await r.watch.follow(MOON)
    expect(r.reads.map((x) => x.mint)).toEqual([MOON, MOON2, MOON])
  })

  test("a Hood token's history names its chain", async () => {
    const r = hrig(() => ({ kind: "refused", words: "no" }))
    await r.watch.follow(MOON, "hood")
    expect(r.reads[0]?.chain).toBe("hood")
  })

  test("a token followed meanwhile keeps its own chart: a late answer for the last one is dropped", async () => {
    let release: (() => void) | undefined
    const r = hrig(() => ({ kind: "ok", body: candles([[r.now() - 30 * MIN, 0.5]]) }))
    const slow = new TokenWatch({
      call: async (tool, args) =>
        tool === "candle_get_market" ? { kind: "ok", result: { success: true, market: { chain: "solana", mint: args.mint, metadata: { symbol: "X" }, priceUsd: 1 } } } : { kind: "ok", result: {} },
      history: async (_c, mint) => {
        if (mint === MOON) await new Promise<void>((done) => (release = done))
        return { kind: "refused", words: `none for ${mint === MOON ? "MOON" : "MOON2"}` }
      },
      now: r.now,
      publish: () => {},
    })
    const first = slow.follow(MOON)
    await Bun.sleep(1)
    await slow.follow(MOON2)
    release!()
    await first
    expect(slow.view().followed?.mint).toBe(MOON2)
    expect(slow.view().historyRead).toMatchObject({ words: "none for MOON2" })
  })
})

describe("the link and pins", () => {
  const JUP = "JupFake111111111111111111111111111111111111"
  const BONK = "BonkFake11111111111111111111111111111111111"
  const known = new Set([MOON, JUP, BONK])
  const symbols: Record<string, string> = { [MOON]: "MOON", [JUP]: "JUP", [BONK]: "BONK" }
  const market = (mint: unknown): ToolOutcome =>
    typeof mint === "string" && known.has(mint)
      ? { kind: "ok", result: { success: true, market: { chain: "solana", mint, metadata: { symbol: symbols[mint] }, priceUsd: 1 } } }
      : { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} }

  test("who moved the link: the person's pick says you, the agent's read says agent, and the agent showing the picked token leaves it yours", async () => {
    const r = rig({ candle_get_market: (args) => market(args.mint) })
    expect(await r.watch.link(JUP, "solana", "you")).toBe("ok")
    expect(r.watch.view().followed).toMatchObject({ mint: JUP, by: "you" })
    await r.watch.follow(JUP)
    expect(r.watch.view().followed?.by).toBe("you")
    await r.watch.follow(BONK)
    expect(r.watch.view().followed).toMatchObject({ mint: BONK, by: "agent" })
  })

  test("what isn't followed says why: a base asset, or no market on Candle", async () => {
    const r = rig({ candle_get_market: (args) => market(args.mint) })
    expect(await r.watch.link(SOL, "solana", "you")).toBe("base")
    expect(await r.watch.link(WALLET, "solana", "you")).toBe("no-market")
    expect(r.watch.view().followed).toBeNull()
  })

  test("a run of picks ends on the last one asked for, however the reads answer (a burst of keys)", async () => {
    const waits: Record<string, () => void> = {}
    const watch = new TokenWatch({
      call: async (tool, args) => {
        if (tool === "candle_get_market" && args.mint === JUP) await new Promise<void>((done) => (waits.jup = done))
        return tool === "candle_get_market" ? market(args.mint) : { kind: "ok", result: {} }
      },
      now: () => 1,
      publish: () => {},
    })
    const first = watch.link(JUP, "solana", "you")
    await Bun.sleep(1)
    expect(await watch.link(BONK, "solana", "you")).toBe("ok")
    waits.jup!()
    expect(await first).toBe("superseded")
    expect(watch.view().followed?.mint).toBe(BONK)
  })

  test("a pinned token is watched beside the linked one, each sample reading both, and moving the link leaves the pin", async () => {
    const r = rig({ candle_get_market: (args) => market(args.mint) })
    await r.watch.link(JUP, "solana", "you")
    r.watch.setPinned([{ mint: JUP, chain: "solana" }])
    await r.watch.follow(BONK)
    expect(r.watch.view().followed?.mint).toBe(BONK)
    expect(r.watch.view().pinned?.map((p) => p.mint)).toEqual([JUP])
    r.calls.length = 0
    r.tick(5_000)
    await r.watch.sample()
    expect(r.calls.filter((c) => c.tool === "candle_get_market").map((c) => c.args.mint).sort()).toEqual([BONK, JUP].sort())
    expect(r.watch.view().pinned?.[0]?.samples).toHaveLength(2)
  })

  test("linking a pinned token reads nothing: it's watched already", async () => {
    const r = rig({ candle_get_market: (args) => market(args.mint) })
    await r.watch.link(JUP, "solana", "you")
    r.watch.setPinned([{ mint: JUP, chain: "solana" }])
    await r.watch.follow(BONK)
    r.calls.length = 0
    expect(await r.watch.link(JUP, "solana", "you")).toBe("ok")
    expect(r.calls).toEqual([])
    expect(r.watch.view().followed?.mint).toBe(JUP)
  })

  test("a pin kept across a restart reads its market, check and history at the first sample", async () => {
    const r = rig({ candle_get_market: (args) => market(args.mint) })
    r.watch.setPinned([{ mint: JUP, chain: "solana", symbol: "JUP" }])
    expect(r.watch.view().pinned?.[0]).toMatchObject({ mint: JUP, market: null })
    await r.watch.sample()
    const p = r.watch.view().pinned?.[0]
    expect(p?.market?.priceUsd).toBe(1)
    expect(p?.check?.summary).toBe("incomplete")
    expect(r.watch.view().followed).toBeNull()
  })

  test("an unpinned token not linked is let go: the next sample doesn't read it", async () => {
    const r = rig({ candle_get_market: (args) => market(args.mint) })
    await r.watch.link(JUP, "solana", "you")
    r.watch.setPinned([{ mint: JUP, chain: "solana" }])
    await r.watch.follow(BONK)
    r.watch.setPinned([])
    r.calls.length = 0
    await r.watch.sample()
    expect(r.calls.filter((c) => c.tool === "candle_get_market").map((c) => c.args.mint)).toEqual([BONK])
    expect(r.watch.view().pinned).toEqual([])
  })
})

describe("the key's request budget", () => {
  const PIN = "PinFake111111111111111111111111111111111111"
  function budgeted(stretch: { linked?: number; pins?: number }) {
    let clock = 1_000_000
    const reads: { tool: string; mint?: unknown; read: string }[] = []
    const watch = new TokenWatch({
      call: async (tool, args, read) => {
        reads.push({ tool, mint: args.mint, read })
        if (tool === "candle_get_feed") return { kind: "ok", result: { tokens: [] } }
        if (tool === "candle_token_forensics") return { kind: "ok", result: { forensics: { safety: { summary: "clear" } } } }
        return { kind: "ok", result: { market: { mint: args.mint, metadata: { symbol: "T" }, priceUsd: 1 } } }
      },
      stretch: (kind) => stretch[kind] ?? 1,
      now: () => clock,
      publish: () => {},
    })
    return { watch, reads, tick: (ms: number) => (clock += ms) }
  }

  test("each read says what it's for: a token someone asked for, the linked token's samples, a pin's", async () => {
    const r = budgeted({})
    await r.watch.follow(MOON, "solana", "you")
    r.watch.setPinned([{ mint: PIN, chain: "solana" }])
    await r.watch.sample()
    expect(r.reads.map((x) => `${x.tool}:${x.read}`)).toEqual([
      "candle_get_market:asked",
      "candle_token_forensics:asked",
      "candle_get_market:linked",
      "candle_get_market:pins", // the pin's first reads, in full
      "candle_token_forensics:pins",
    ])
  })

  test("a stretched pin is sampled less often than the linked token, and the next sample comes when it's due", async () => {
    const r = budgeted({ pins: 3 })
    await r.watch.follow(MOON)
    r.watch.setPinned([{ mint: PIN, chain: "solana" }])
    await r.watch.sample() // both sampled (the pin loads)
    r.reads.length = 0
    for (let i = 0; i < 6; i++) {
      r.tick(5_000)
      await r.watch.sample()
    }
    const by = (mint: string) => r.reads.filter((x) => x.tool === "candle_get_market" && x.mint === mint).length
    expect(by(MOON)).toBe(6)
    expect(by(PIN)).toBe(2) // every 15 s over 30 s
    expect(r.watch.nextSampleMs()).toBe(5_000)
  })

  test("its demand: a token's samples while linked, each pin apart from it; none while stopped", () => {
    const r = budgeted({})
    expect(r.watch.demand()).toEqual({ linked: 0, pins: 0, pinCount: 0 })
    // Running as with a view attached, without its timer.
    ;(r.watch as unknown as { running: boolean }).running = true
    r.watch.setPinned([{ mint: PIN, chain: "solana" }, { mint: MOON, chain: "solana" }])
    expect(r.watch.demand()).toEqual({ linked: 0, pins: 24, pinCount: 2 })
    ;(r.watch as unknown as { running: boolean }).running = false
  })
})

test("Hacc's 1m candles kept whole for the pane's two-minute candles; a missing high or low takes the open and close", () => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/hacc-recorded/token-history-1m-hour-candles.json"), "utf8")) as { answer: unknown }
  const candles = historyCandles(recorded.answer, Date.parse("2026-10-30T00:00:00Z"))
  expect(candles.length).toBeGreaterThan(1)
  expect(candles.every((c) => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close))).toBe(true)
  expect(candles.map((c) => c.at)).toEqual([...candles.map((c) => c.at)].sort((a, b) => a - b))
  expect(historyCandles({ candles: [{ at: "2026-10-29T02:48:00Z", open: 2, close: 3 }] }, Date.parse("2026-10-30T00:00:00Z"))).toEqual([{ at: Date.parse("2026-10-29T02:48:00Z"), open: 2, high: 3, low: 2, close: 3 }])
  expect(historyCandles({ candles: [{ at: "nope", close: 1 }] }, Date.now())).toEqual([])
})

describe("Hacc's check on a Hood token", () => {
  const HTOK = "0x00000000000000000000000000000000000b0B01"
  const safety = (set: Record<string, unknown>) => ({ chain: "hood", market: {}, safety: { honeypot: null, cannot_buy: null, cannot_sell_all: null, buy_tax_pct: null, sell_tax_pct: null, transfer_tax_pct: null, mintable: null, transfer_pausable: null, hidden_owner: null, can_take_back_ownership: null, blacklisted: null, is_proxy: null, open_source: null, owner_pct: null, creator_pct: null, lp_locked_pct: null, honeypot_with_same_creator: null, ...set } })
  function hoodRig(hacc: (chain: string, address: string) => Promise<{ kind: "ok"; body: unknown } | { kind: "refused"; words: string }>) {
    let clock = 1_000_000
    const asked: string[] = []
    const published: TokenView[] = []
    const watch = new TokenWatch({
      call: async (tool, args) =>
        tool === "candle_get_market" && args.mint === HTOK
          ? { kind: "ok", result: { success: true, market: { chain: "hood", mint: HTOK, metadata: { symbol: "HTOK" }, priceUsd: 0.0000443, marketCap: 44_000, liquidityUsd: 18_000 } } }
          : tool === "candle_token_forensics"
            ? { kind: "ok", result: { success: true, forensics: { safety: { summary: "incomplete", flags: {} } } } }
            : { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} },
      now: () => clock,
      publish: (v) => published.push(v),
      haccMarket: async (chain, address) => {
        asked.push(`${chain}:${address}`)
        return hacc(chain, address)
      },
    })
    return { watch, asked, published, tick: (ms: number) => (clock += ms) }
  }

  test("read once a Hood token is followed, said as Hacc's, kept a minute, read again after", async () => {
    const r = hoodRig(async () => ({ kind: "ok", body: safety({ honeypot: false, buy_tax_pct: 0, sell_tax_pct: 0, lp_locked_pct: 92 }) }))
    expect(await r.watch.link(HTOK, "hood", "agent")).toBe("ok")
    expect(r.asked).toEqual([`hood:${HTOK}`])
    expect(r.watch.view().hacc).toMatchObject({ words: "Hacc: no honeypot, 0% buy and sell tax, LP locked 92% (13 more not said by Hacc)", amber: false })
    await r.watch.recheck()
    expect(r.asked).toHaveLength(1)
    r.tick(60_000)
    await r.watch.recheck()
    expect(r.asked).toHaveLength(2)
  })

  test("amber where Hacc says a honeypot; a fresh token's all-null answer is unchecked, never clean", async () => {
    const hp = hoodRig(async () => ({ kind: "ok", body: safety({ honeypot: true }) }))
    await hp.watch.link(HTOK, "hood", "agent")
    expect(hp.watch.view().hacc?.amber).toBe(true)
    expect(hp.watch.view().hacc?.words).toStartWith("Hacc: a honeypot")
    const fresh = hoodRig(async () => ({ kind: "ok", body: safety({}) }))
    await fresh.watch.link(HTOK, "hood", "agent")
    expect(fresh.watch.view().hacc).toMatchObject({ amber: false, words: "Hacc has no check for this token yet: not checked, not clean" })
  })

  test("a refusal (Free, or Hacc down) is said in its words, as not checked; a Solana token isn't read on Hacc for it", async () => {
    const free = hoodRig(async () => ({ kind: "refused", words: "Hacc's check needs a Pro or Max plan" }))
    await free.watch.link(HTOK, "hood", "agent")
    expect(free.watch.view().hacc?.words).toBe("Hacc's check didn't load (Hacc's check needs a Pro or Max plan): not checked, not clean")
    const sol = rig()
    await sol.watch.link(MOON, "solana", "agent")
    expect(sol.watch.view().hacc).toBeUndefined()
  })
})
