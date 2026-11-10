// Rules bots' entries, unit by unit: which tape rows are a definition's candidates, the stake its sizing pays, and
// each condition an entry waits on, one test each, broken on purpose where it matters. The decision is journalled
// before the buy, a signal is entered once (a refill and a restart included), and skips are said with why. The last
// tests run the matcher over the hour of Hacc's full tape that was replayed live, and take the replays' entries.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fakeAddress } from "../../scripts/scrub-hacc"
import { HOUR_COLUMNS } from "../../scripts/scrub-bots"
import { type Definition, readDefinition } from "../shared/definition"
import { BOT_CLIENT_PREFIX, BotEntries, type BotEntriesDeps, easternHour, PRICE_RECHECK_MS, PRICE_WAIT_MS, rowMatches, SKIP_FLUSH_MS, stakeOf } from "./bot-entries"
import type { BotEntry } from "./bots-file"
import type { ToolOutcome } from "./candle-mcp"
import type { HaccAnswer } from "./hacc"
import type { JournalRow } from "./journal"
import type { SignalRow } from "./signal-stream"
import type { FaceClient } from "./tool-face"

const T0 = Date.parse("2026-11-06T15:00:00.000Z")
const MOON = "MoonFake11111111111111111111111111111111111"
const WIFZ = "WifzFake11111111111111111111111111111111111"
const BONK = "BonkFake11111111111111111111111111111111111"

const def = (d: Record<string, unknown>): Definition => {
  const read = readDefinition({ chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { max_hold_hours: 1 }, sizing: { usd_per_trade: 2, max_concurrent: 4 }, ...d })
  if (!read.ok) throw new Error(read.message)
  return read.definition
}
const BOT: BotEntry = { name: "conf", agent: "momentum", wallet: "embedded", mode: "live", state: "on", definition: def({}) }

let nextId = 1000
const row = (o: Partial<SignalRow> & { mint?: string; at?: number } = {}): SignalRow => {
  const { mint = MOON, at = T0 - 3_000, ...rest } = o
  return { id: nextId++, pattern: "confluence", created_at: new Date(at).toISOString(), asset_address: mint, asset_chain: "solana", wallet_groups: [], payload: {}, ...rest } as SignalRow
}
const market = (mint: string, priceUsd: number | null, marketCap: number | null = 100_000): ToolOutcome => ({ kind: "ok", result: { market: { mint, priceUsd, marketCap } } })

interface Harness {
  e: BotEntries
  rows: JournalRow[]
  sent: { args: Record<string, unknown>; client: FaceClient; mode: string }[]
  bots: BotEntry[]
  held: Set<string>
  open: Map<string, number>
  prices: Map<string, ToolOutcome | undefined>
  hacc: { route: string; query: Record<string, unknown> }[]
  haccAnswer: (query: Record<string, unknown>) => HaccAnswer
  now: { at: number }
  tick(ms: number): Promise<void>
  types(): string[]
  of(type: string): JournalRow[]
  set: { paused: boolean; mode: "paper" | "live"; sol: number | undefined; send: (args: Record<string, unknown>) => unknown }
}

function harness(o: { bots?: BotEntry[]; onSince?: number; journal?: JournalRow[] } = {}): Harness {
  const rows: JournalRow[] = [...(o.journal ?? [])]
  const now = { at: T0 }
  const timers: { at: number; run: () => void; live: boolean }[] = []
  const h = {} as Harness
  const set: Harness["set"] = { paused: false, mode: "live", sol: 100, send: () => ({ cardId: "card_1", state: "approved", instant: { ok: true } }) }
  const prices = new Map<string, ToolOutcome | undefined>([
    [MOON, market(MOON, 0.001)],
    [WIFZ, market(WIFZ, 0.002)],
    [BONK, market(BONK, 0.003)],
  ])
  const bots = o.bots ?? [BOT]
  const held = new Set<string>()
  const open = new Map<string, number>()
  const sent: Harness["sent"] = []
  const hacc: Harness["hacc"] = []
  let seq = rows.length
  const deps: BotEntriesDeps = {
    bots: { live: () => bots.filter((b) => b.state === "on"), onSince: () => new Date(o.onSince ?? T0 - 60_000).toISOString(), setLastSignal: () => {} },
    positions: { holds: (bot, mint) => held.has(`${bot}\n${mint}`), open: (bot) => Array.from({ length: open.get(bot) ?? 0 }) },
    journal: {
      append: async (input) => {
        const r = { ...input, seq: ++seq, at: new Date(now.at).toISOString(), account: "acct" } as JournalRow
        rows.push(r)
        h.e.note(r)
        return r
      },
    },
    clock: {
      now: () => now.at,
      schedule: (run, ms) => {
        const t = { at: now.at + ms, run, live: true }
        timers.push(t)
        return () => {
          t.live = false
        }
      },
    },
    mode: () => set.mode,
    market: async (_chain, mint) => prices.get(mint),
    hacc: async (_agent, route, query) => {
      hacc.push({ route, query })
      return h.haccAnswer(query)
    },
    solUsd: () => set.sol,
    feeBps: () => 25,
    paused: () => set.paused,
    send: async (trade, client, mode) => {
      sent.push({ args: trade.args, client, mode })
      return set.send(trade.args)
    },
    card: () => ({ display: { cardBecause: "over the embedded wallet's $1.00 a trade without a card: this one is $2.01 with Candle's fee" } }),
    nameOf: (mint) => (mint === MOON ? "MOON" : mint === WIFZ ? "WIFZ" : undefined),
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  Object.assign(h, {
    e: new BotEntries(deps),
    rows,
    sent,
    bots,
    held,
    open,
    prices,
    hacc,
    haccAnswer: () => ({ kind: "ok", status: 200, body: { signals: [] }, ms: 1, cached: false }),
    now,
    set,
    async tick(ms: number) {
      const until = now.at + ms
      for (;;) {
        await settle()
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now.at = due.at
        due.live = false
        due.run()
      }
      now.at = until
      await settle()
    },
    types: () => rows.map((r) => r.type),
    of: (type: string) => rows.filter((r) => r.type === type),
  })
  return h
}

describe("a tape row as a definition's candidate", () => {
  test("its pattern and chain, from after nothing else: a Hood row isn't a Solana bot's, and `any` takes both", () => {
    expect(rowMatches(def({}), row())).toBe(true)
    expect(rowMatches(def({}), row({ pattern: "new_ticker" }))).toBe(false)
    expect(rowMatches(def({}), row({ asset_chain: "hood", mint: "0xfa4e000000000000000000000000000000000001" }))).toBe(false)
    expect(rowMatches(def({ chain: "any" }), row({ asset_chain: "hood", mint: "0xfa4e000000000000000000000000000000000001" }))).toBe(true)
    expect(rowMatches(def({}), row({ asset_address: "" }))).toBe(false)
  })

  test("groups (any of), groups_all (each of) and wallet_ids, from the row's wallet", () => {
    const single = (filters: Record<string, unknown>) => def({ entry: { source: "pattern", pattern: "new_ticker", filters } })
    const r = row({ pattern: "new_ticker", wallet_groups: ["serial", "early"], wallet_id: 42 })
    expect(rowMatches(single({ groups: ["serial", "kol"] }), r)).toBe(true)
    expect(rowMatches(single({ groups: ["kol"] }), r)).toBe(false)
    expect(rowMatches(single({ groups_all: ["serial", "early"] }), r)).toBe(true)
    expect(rowMatches(single({ groups_all: ["serial", "kol"] }), r)).toBe(false)
    expect(rowMatches(single({ wallet_ids: [7, 42] }), r)).toBe(true)
    expect(rowMatches(single({ wallet_ids: [7] }), r)).toBe(false)
  })

  test("direction and min_usd from the payload, whose size Hacc sends as a decimal string; no size doesn't pass a floor", () => {
    const large = def({ entry: { source: "pattern", pattern: "large_move", filters: { min_usd: 15_000, direction: "in" } } })
    expect(rowMatches(large, row({ pattern: "large_move", payload: { usd_value: "15000.5", direction: "in" } }))).toBe(true)
    expect(rowMatches(large, row({ pattern: "large_move", payload: { usd_value: "14999.99", direction: "in" } }))).toBe(false)
    expect(rowMatches(large, row({ pattern: "large_move", payload: { usd_value: "90000", direction: "out" } }))).toBe(false)
    expect(rowMatches(large, row({ pattern: "large_move", payload: { usd_value: null, direction: "in" } }))).toBe(false)
  })

  test("hours_et in US Eastern time, both ends in: [9, 9] is the hour from 9", () => {
    // 2026-11-06 is after the clocks went back: Eastern is UTC-5.
    const nine = Date.parse("2026-11-06T14:30:00.000Z")
    expect(easternHour(nine)).toBe(9)
    expect(rowMatches(def({ entry: { source: "pattern", pattern: "confluence", filters: { hours_et: [9, 9] } } }), row({ at: nine }))).toBe(true)
    expect(rowMatches(def({ entry: { source: "pattern", pattern: "confluence", filters: { hours_et: [10, 17] } } }), row({ at: nine }))).toBe(false)
  })
})

describe("the stake", () => {
  const sizing = (s: Record<string, unknown>) => def({ sizing: { usd_per_trade: 10, max_concurrent: 4, ...s } }).sizing
  test("base_usd where given, else usd_per_trade; a mult multiplies, an add adds to the multiple, max_usd caps", () => {
    expect(stakeOf(sizing({}), {})).toEqual({ usd: 10, applied: [] })
    expect(stakeOf(sizing({ base_usd: 5 }), {})).toEqual({ usd: 5, applied: [] })
    expect(stakeOf(sizing({ base_usd: 5, rules: [{ when: { mcap_at_entry: { lt: 300_000 } }, mult: 2 }] }), { mcap_at_entry: 100_000 })).toMatchObject({ usd: 10 })
    expect(stakeOf(sizing({ base_usd: 5, rules: [{ when: { mcap_at_entry: { gt: 0 } }, add: 3 }] }), { mcap_at_entry: 1 })).toMatchObject({ usd: 20 })
    expect(stakeOf(sizing({ base_usd: 5, max_usd: 20, rules: [{ when: { mcap_at_entry: { gt: 0 } }, mult: 2 }, { when: { mcap_at_entry: { gt: 0 } }, add: 5 }] }), { mcap_at_entry: 1 })).toMatchObject({ usd: 20 })
  })
  test("a rule that doesn't hold, or whose feature isn't read, does nothing; a skip rule skips", () => {
    const s = sizing({ rules: [{ when: { mcap_at_entry: { gte: 2_000_000 } }, skip: true }, { when: { mcap_at_entry: { lt: 300_000 } }, mult: 2 }] })
    expect(stakeOf(s, { mcap_at_entry: 500_000 })).toEqual({ usd: 10, applied: [] })
    expect(stakeOf(s, {})).toEqual({ usd: 10, applied: [] })
    expect(stakeOf(s, { mcap_at_entry: 3_000_000 })).toMatchObject({ skip: true })
  })
})

describe("an entry", () => {
  test("journalled before its buy, then proposed as the bot's own, by its own client, for the stake in dollars from its wallet", async () => {
    const h = harness()
    const order: string[] = []
    h.set.send = () => {
      order.push(`send after ${h.types().at(-1)}`)
      return { cardId: "card_1", state: "approved", instant: { ok: true } }
    }
    const r = row()
    await h.e.onTape([r])
    expect(order).toEqual(["send after bot.entering"])
    expect(h.of("bot.entering")[0]).toMatchObject({ name: "conf", agent: "momentum", signalId: r.id, mint: MOON, usd: 2, botMode: "live", wallet: "embedded" })
    expect(h.sent[0]).toMatchObject({ mode: "live", args: { mint: MOON, side: "buy", amountUsd: "2.00", wallet: "embedded" }, client: { clientId: `${BOT_CLIENT_PREFIX}conf`, role: "core", agent: "momentum", bot: { name: "conf", act: "entry", signal: r.id } } })
  })

  test("a signal from before the bot went on, or heard over 10 minutes after it happened, isn't one", async () => {
    const h = harness({ onSince: T0 - 1_000 })
    await h.e.onTape([row({ at: T0 - 2_000 })])
    const h2 = harness({ onSince: T0 - 20 * 60_000 })
    await h2.e.onTape([row({ at: T0 - 11 * 60_000 })])
    expect([...h.sent, ...h2.sent]).toEqual([])
    expect([...h.rows, ...h2.rows]).toEqual([])
  })

  test("the same signal heard twice (a reopen's refill) is entered once", async () => {
    const h = harness()
    const r = row()
    await h.e.onTape([r])
    await h.e.onTape([r])
    expect(h.sent).toHaveLength(1)
  })

  test("a signal decided once stays decided: refused and heard again, it isn't tried again", async () => {
    const h = harness()
    h.set.send = () => {
      throw Object.assign(new Error("Candle holds momentum's key."), { code: "KEY_HELD" })
    }
    const r = row()
    await h.e.onTape([r])
    expect(h.e.under()).toEqual([])
    h.set.send = () => ({ cardId: "card_1", state: "approved" })
    await h.e.onTape([r])
    expect(h.sent).toHaveLength(1)
    // Skipped for a full slot, then heard again once one is free: still the decision it had.
    const full = harness()
    full.open.set("conf", 4)
    const s2 = row({ mint: WIFZ })
    await full.e.onTape([s2])
    full.open.set("conf", 0)
    await full.e.onTape([s2])
    expect(full.sent).toEqual([])
  })

  test("a token's first signal, by when it happened then by id: two in one batch enter once, on the earlier", async () => {
    const h = harness()
    const later = row({ at: T0 - 1_000 })
    const earlier = row({ at: T0 - 2_000 })
    await h.e.onTape([later, earlier])
    expect(h.sent.map((s) => s.client.bot?.signal)).toEqual([earlier.id])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "already_open", signals: [later.id] })
  })

  test("not on a token it holds: already_open", async () => {
    const h = harness()
    h.held.add(`conf\n${MOON}`)
    await h.e.onTape([row()])
    expect(h.sent).toEqual([])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "already_open", words: "it holds MOON already" })
  })

  test("not past max_concurrent, counting entries under way: the fifth of four is max_concurrent", async () => {
    const h = harness()
    h.open.set("conf", 3)
    h.set.send = () => ({ cardId: "card_1", state: "approved" })
    await h.e.onTape([row({ mint: MOON })])
    await h.e.onTape([row({ mint: WIFZ })])
    expect(h.sent).toHaveLength(1)
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "max_concurrent", words: "all 4 of its slots are taken" })
  })

  test("a candidate still being checked holds no slot: one that then fails its market cap never cost another signal its slot", async () => {
    const bot = { ...BOT, definition: def({ entry: { source: "pattern", pattern: "confluence", filters: { min_mcap_usd: 100_000 } }, sizing: { usd_per_trade: 2, max_concurrent: 1 } }) }
    const h = harness({ bots: [bot] })
    h.set.send = () => ({ cardId: "card_1", state: "approved" })
    h.prices.set(MOON, market(MOON, 0.001, 3_141))
    h.prices.set(WIFZ, market(WIFZ, 0.002, 400_000))
    await h.e.onTape([row({ mint: MOON }), row({ mint: WIFZ })])
    expect(h.sent.map((s) => s.args.mint)).toEqual([WIFZ])
    await h.e.flush()
    expect(h.of("bot.skipped").map((r) => r.reason)).toEqual(["market_cap"])
  })

  test("two candidates passing at once take one slot between them: the second is max_concurrent, never both entered", async () => {
    const bot = { ...BOT, definition: def({ sizing: { usd_per_trade: 2, max_concurrent: 1 } }) }
    const h = harness({ bots: [bot] })
    h.set.send = () => ({ cardId: "card_1", state: "approved" })
    await h.e.onTape([row({ mint: MOON }), row({ mint: WIFZ }), row({ mint: BONK })])
    expect(h.sent.map((s) => s.args.mint)).toEqual([MOON])
    expect(h.e.under("conf")).toHaveLength(1)
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "max_concurrent", count: 2 })
  })

  test("a signal more than 2 minutes old when it's decided is skipped as heard too late; one under 2 minutes is entered", async () => {
    const h = harness({ onSince: T0 - 10 * 60_000 })
    const late = row({ mint: MOON, at: T0 - 8 * 60_000 })
    await h.e.onTape([late, row({ mint: WIFZ, at: T0 - 90_000 })])
    expect(h.sent.map((s) => s.args.mint)).toEqual([WIFZ])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "stale_signal", words: "heard too late: the signal was 8 minutes old", signals: [late.id] })
    // Decided: heard again, it's neither entered nor counted again.
    await h.e.onTape([late])
    await h.e.flush()
    expect(h.of("bot.skipped")).toHaveLength(1)
  })

  test("a signal that ages past 2 minutes while Candle's price is waited for isn't bought on", async () => {
    const h = harness({ onSince: T0 - 10 * 60_000 })
    h.prices.set(MOON, market(MOON, null, null))
    const tape = h.e.onTape([row({ at: T0 - 100_000 })])
    await h.tick(PRICE_RECHECK_MS * 2)
    h.prices.set(MOON, market(MOON, 0.001))
    await h.tick(PRICE_RECHECK_MS * 2)
    await tape
    expect(h.sent).toEqual([])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "stale_signal" })
  })

  test("a signal heard while the kill switch is on is skipped as paused when it's heard, with no read made", async () => {
    const h = harness()
    h.set.paused = true
    let reads = 0
    const prices = h.prices
    prices.set(MOON, market(MOON, 0.001))
    const before = prices.get(MOON)
    h.prices.get = ((mint: string) => {
      reads++
      return mint === MOON ? before : undefined
    }) as typeof prices.get
    await h.e.onTape([row({ mint: MOON })])
    expect(reads).toBe(0)
    expect(h.sent).toEqual([])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "paused" })
  })

  test("a token Candle can't price yet is read again every 15 s for a minute, and entered once it's priced", async () => {
    const h = harness()
    h.prices.set(MOON, market(MOON, null, null))
    const tape = h.e.onTape([row({ at: T0 })])
    await h.tick(PRICE_RECHECK_MS)
    expect(h.sent).toEqual([])
    h.prices.set(MOON, market(MOON, 0.001))
    await h.tick(PRICE_RECHECK_MS)
    await tape
    expect(h.sent).toHaveLength(1)
  })

  test("still no price after a minute: skipped as unpriceable, in words", async () => {
    const h = harness()
    h.prices.set(MOON, market(MOON, null, null))
    const tape = h.e.onTape([row({ at: T0 })])
    await h.tick(PRICE_WAIT_MS + 1)
    await tape
    expect(h.sent).toEqual([])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "unpriceable", words: "Candle had no price for MOON within a minute of its signal" })
  })

  test("the market-cap band on Candle's market cap; one Candle doesn't know doesn't pass", async () => {
    const bot = { ...BOT, definition: def({ entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000 } } }) }
    const h = harness({ bots: [bot] })
    h.prices.set(MOON, market(MOON, 0.001, 900_000))
    h.prices.set(WIFZ, market(WIFZ, 0.002, null))
    await h.e.onTape([row({ mint: MOON }), row({ mint: WIFZ }), row({ mint: BONK })])
    expect(h.sent.map((s) => s.args.mint)).toEqual([BONK])
    await h.e.flush()
    expect(h.of("bot.skipped").map((r) => r.reason)).toEqual(["market_cap"])
    expect(h.of("bot.skipped")[0]).toMatchObject({ count: 2, mints: [MOON, WIFZ] })
  })

  test("age and venues on Hacc's full tape, for that one signal: entered only where Hacc holds it, and said when Hacc can't be read", async () => {
    const bot = { ...BOT, definition: def({ entry: { source: "pattern", pattern: "confluence", filters: { max_age_minutes: 60, venues: ["pump"] } } }) }
    const h = harness({ bots: [bot] })
    const yes = row({ mint: MOON })
    const no = row({ mint: WIFZ })
    h.haccAnswer = (q) => (q.asset === MOON ? { kind: "ok", status: 200, body: { signals: [{ id: yes.id }] }, ms: 1, cached: false } : q.asset === WIFZ ? { kind: "ok", status: 200, body: { signals: [] }, ms: 1, cached: false } : { kind: "refused", code: "HACC_NO_ANSWER", message: "Hacc didn't answer.", ms: 1 })
    await h.e.onTape([yes, no, row({ mint: BONK })])
    expect(h.sent.map((s) => s.args.mint)).toEqual([MOON])
    expect(h.hacc[0]).toMatchObject({ route: "/v1/signals", query: { asset: MOON, pattern: "confluence", quality: "all", max_age_minutes: 60, venues: "pump" } })
    await h.e.flush()
    expect(h.of("bot.skipped").map((r) => [r.reason, r.words])).toEqual([
      ["tape_filter", "Hacc's tape says WIFZ is outside its age and venue filters"],
      ["tape_unread", `Hacc's tape couldn't be read for its age and venue filters: Hacc didn't answer.`],
    ])
  })

  test("its sizing: a rule on the market cap at entry sizes it, and a skip rule skips it", async () => {
    const bot = { ...BOT, definition: def({ sizing: { usd_per_trade: 2, max_concurrent: 4, rules: [{ when: { mcap_at_entry: { lt: 50_000 } }, mult: 2 }, { when: { mcap_at_entry: { gt: 1_000_000 } }, skip: true }] } }) }
    const h = harness({ bots: [bot] })
    h.prices.set(MOON, market(MOON, 0.001, 20_000))
    h.prices.set(WIFZ, market(WIFZ, 0.002, 2_000_000))
    await h.e.onTape([row({ mint: MOON }), row({ mint: WIFZ })])
    expect(h.sent.map((s) => s.args.amountUsd)).toEqual(["4.00"])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "sizing_skip" })
  })

  test("a live wallet that can't hold the stake with Candle's fee, entries under way counted: no_budget", async () => {
    const h = harness()
    h.set.sol = 3
    h.set.send = () => ({ cardId: "card_1", state: "approved" })
    await h.e.onTape([row({ mint: MOON }), row({ mint: WIFZ })])
    expect(h.sent).toHaveLength(1)
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "no_budget" })
    expect(String(h.of("bot.skipped")[0]!.words)).toContain("short of the $2.01 stake with Candle's fee")
  })

  test("the kill switch holds every entry", async () => {
    const h = harness()
    h.set.paused = true
    await h.e.onTape([row()])
    expect(h.sent).toEqual([])
    await h.e.flush()
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "paused" })
    expect(h.of("bot.entering")).toEqual([])
  })

  test("a live bot enters live while the Candle Harness is on paper: the bot's mode is its own", async () => {
    const h = harness()
    h.set.mode = "paper"
    await h.e.onTape([row()])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.mode).toBe("live")
    expect(h.sent[0]!.client.bot?.mode).toBe("live")
    expect(h.sent[0]!.args.wallet).toBe("embedded")
    await h.e.flush()
    expect(h.of("bot.skipped")).toHaveLength(0)
  })

  test("a bot paused while it waited for a price enters nothing", async () => {
    const h = harness()
    h.prices.set(MOON, market(MOON, null, null))
    const tape = h.e.onTape([row({ at: T0 })])
    await h.tick(PRICE_RECHECK_MS)
    h.bots[0]!.state = "paused"
    h.prices.set(MOON, market(MOON, 0.001))
    await h.tick(PRICE_RECHECK_MS)
    await tape
    h.bots[0]!.state = "on"
    expect(h.sent).toEqual([])
  })

  test("a bot narrowed while it waited for a price isn't entered at the stake it had before", async () => {
    const h = harness()
    h.prices.set(MOON, market(MOON, null, null))
    const tape = h.e.onTape([row({ at: T0 })])
    await h.tick(PRICE_RECHECK_MS)
    // A smaller stake approved meanwhile: the bot is still on, as another entry.
    h.bots[0] = { ...BOT, definition: def({ sizing: { usd_per_trade: 1, max_concurrent: 4 } }) }
    h.prices.set(MOON, market(MOON, 0.001))
    await h.tick(PRICE_RECHECK_MS)
    await tape
    expect(h.sent).toEqual([])
    await h.e.flush()
    expect(h.of("bot.skipped").map((r) => [r.reason, r.words])).toEqual([["changed", "the bot changed while this signal was being checked"]])
  })

  test("a bot paused, or its slippage bound changed, while Hacc's tape was read enters nothing", async () => {
    for (const change of ["pause", "bound"] as const) {
      const bot = { ...BOT, definition: def({ entry: { source: "pattern", pattern: "confluence", filters: { max_age_minutes: 60 } } }) }
      const h = harness({ bots: [bot] })
      const signal = row({ mint: MOON })
      h.haccAnswer = () => {
        if (change === "pause") h.bots[0]!.state = "paused"
        else h.bots[0] = { ...bot, maxSlippageBps: 300 }
        return { kind: "ok", status: 200, body: { signals: [{ id: signal.id }] }, ms: 1, cached: false }
      }
      await h.e.onTape([signal])
      expect([change, h.hacc.length, h.sent]).toEqual([change, 1, []])
    }
  })

  test("refused at proposal (over the agent's limit, a held key): ended in words, with the code, and the slot is free again", async () => {
    const h = harness()
    h.set.send = () => {
      throw Object.assign(new Error("Over momentum's Candle Harness limit of $10.00 a trade."), { code: "LIMIT_PER_TRADE" })
    }
    await h.e.onTape([row()])
    expect(h.of("bot.entry_ended")[0]).toMatchObject({ outcome: "refused", code: "LIMIT_PER_TRADE", words: "MOON: its buy was refused: Over momentum's Candle Harness limit of $10.00 a trade." })
    expect(h.e.under()).toEqual([])
  })

  test("a card that waits for the person says why; expired or rejected, it ends with nothing bought", async () => {
    const h = harness()
    h.set.send = () => ({ cardId: "card_w", state: "awaiting_approval" })
    const r = row()
    await h.e.onTape([r])
    expect(h.of("bot.waiting")[0]).toMatchObject({ cardId: "card_w", signalId: r.id, words: "its buy of $2.00 of MOON waits for you: over the embedded wallet's $1.00 a trade without a card: this one is $2.01 with Candle's fee" })
    // The card's own rows, as the card book appends them.
    h.e.note({ type: "card.created", bot: "conf", botAct: "entry", botSignal: r.id, cardId: "card_w", opId: "op_w", seq: 90, at: new Date(T0).toISOString(), account: "acct", mode: "live" } as JournalRow)
    expect(h.e.under()[0]).toMatchObject({ cardId: "card_w", opId: "op_w" })
    h.e.note({ type: "card.expired", bot: "conf", botAct: "entry", botSignal: r.id, cardId: "card_w", opId: "op_w", seq: 91, at: new Date(T0).toISOString(), account: "acct", mode: "live" } as JournalRow)
    await h.tick(0)
    expect(h.of("bot.entry_ended")[0]).toMatchObject({ outcome: "expired", words: "MOON: nobody pressed its card in time, so nothing was bought" })
    expect(h.e.under()).toEqual([])
  })

  test("an approved buy's operation: filled, it's the book's; failed, it ends in words", async () => {
    const h = harness()
    h.set.send = () => ({ cardId: "card_1", state: "approved" })
    const [a, b] = [row({ mint: MOON }), row({ mint: WIFZ })]
    await h.e.onTape([a, b])
    const created = (r: SignalRow, n: number) => ({ type: "card.created", bot: "conf", botAct: "entry", botSignal: r.id, cardId: `card_${n}`, opId: `op_${n}`, seq: n, at: new Date(T0).toISOString(), account: "acct", mode: "live" }) as JournalRow
    h.e.note(created(a, 1))
    h.e.note(created(b, 2))
    h.e.note({ type: "operation.succeeded", opId: "op_1", seq: 3, at: new Date(T0).toISOString(), account: "acct", mode: "live" } as JournalRow)
    h.e.note({ type: "operation.failed", opId: "op_2", error: { message: "Slippage." }, seq: 4, at: new Date(T0).toISOString(), account: "acct", mode: "live" } as JournalRow)
    await h.tick(0)
    expect(h.e.under()).toEqual([])
    expect(h.of("bot.entry_ended")).toHaveLength(1)
    expect(h.of("bot.entry_ended")[0]).toMatchObject({ outcome: "failed", mint: WIFZ, words: "WIFZ: its buy didn't go through: Slippage." })
  })

  test("skips gather per bot and reason, one row a minute at most", async () => {
    const h = harness()
    h.held.add(`conf\n${MOON}`)
    h.held.add(`conf\n${WIFZ}`)
    await h.e.onTape([row({ mint: MOON }), row({ mint: WIFZ })])
    await h.e.onTape([row({ mint: MOON })])
    expect(h.of("bot.skipped")).toEqual([])
    await h.tick(SKIP_FLUSH_MS)
    expect(h.of("bot.skipped")).toHaveLength(1)
    expect(h.of("bot.skipped")[0]).toMatchObject({ reason: "already_open", count: 3, mints: [MOON, WIFZ], words: "3 signals, the last because it holds MOON already" })
  })
})

describe("across a restart", () => {
  test("a signal entered or skipped before is never decided again; an entry that never reached a card ends, said", async () => {
    const first = harness()
    first.set.send = () => new Promise(() => {}) // the core stops before the buy is sent
    first.held.add(`conf\n${WIFZ}`)
    const entered = row({ mint: MOON })
    const skipped = row({ mint: WIFZ })
    void first.e.onTape([entered, skipped])
    await first.tick(0)
    await first.e.flush()
    expect(first.of("bot.entering")).toHaveLength(1)

    const second = harness({ journal: first.rows })
    await second.e.rebuild(first.rows)
    expect(second.of("bot.entry_ended").at(-1)).toMatchObject({ outcome: "lost", signalId: entered.id, words: "MOON: the core stopped before its buy was sent, so nothing was bought" })
    // The stream's refill hears both again.
    await second.e.onTape([entered, skipped])
    expect(second.sent).toEqual([])
  })

  test("an end the journal already says isn't said again at a restart; one it never said is said once", async () => {
    const first = harness()
    first.set.send = () => ({ cardId: "card_1", state: "awaiting_approval" })
    const r = row({ mint: MOON })
    await first.e.onTape([r])
    const t = new Date(T0).toISOString()
    const append = (o: Record<string, unknown>) => {
      const x = { seq: first.rows.length + 1, at: t, account: "acct", mode: "live", ...o } as JournalRow
      first.rows.push(x)
      first.e.note(x)
    }
    append({ type: "card.created", bot: "conf", botAct: "entry", botSignal: r.id, cardId: "card_1", opId: "op_1" })
    append({ type: "card.expired", bot: "conf", botAct: "entry", botSignal: r.id, cardId: "card_1", opId: "op_1" })
    await first.tick(0)
    expect(first.of("bot.entry_ended")).toHaveLength(1)

    const second = harness({ journal: first.rows })
    await second.e.rebuild(first.rows)
    await second.tick(0)
    expect(second.of("bot.entry_ended")).toHaveLength(1)

    // The core stopped after the card expired and before it said so: said now, once.
    const cut = first.rows.filter((x) => x.type !== "bot.entry_ended")
    const third = harness({ journal: cut })
    await third.e.rebuild(cut)
    await third.tick(0)
    expect(third.of("bot.entry_ended")).toHaveLength(1)
    expect(third.of("bot.entry_ended")[0]).toMatchObject({ outcome: "expired", words: "MOON: nobody pressed its card in time, so nothing was bought" })
  })

  test("an entry whose buy was sent and not yet settled stays under way, holding its token and its slot", async () => {
    const first = harness()
    first.set.send = () => ({ cardId: "card_1", state: "approved" })
    const r = row({ mint: MOON })
    await first.e.onTape([r])
    first.rows.push({ type: "card.created", bot: "conf", botAct: "entry", botSignal: r.id, cardId: "card_1", opId: "op_1", seq: 50, at: new Date(T0).toISOString(), account: "acct", mode: "live" } as JournalRow)
    first.rows.push({ type: "card.approved", bot: "conf", botAct: "entry", botSignal: r.id, cardId: "card_1", opId: "op_1", seq: 51, at: new Date(T0).toISOString(), account: "acct", mode: "live" } as JournalRow)

    const second = harness({ journal: first.rows })
    await second.e.rebuild(first.rows)
    expect(second.e.under()).toHaveLength(1)
    await second.e.onTape([row({ mint: MOON })])
    expect(second.sent).toEqual([])
  })
})

// --- the hour Hacc replayed ---

interface Hour {
  from: string
  columns: string[]
  replays: Record<string, { definition: unknown; entries: number[] }>
  tapes: Record<string, unknown[][]>
}
const HOUR = JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/hacc-recorded/bots/bots-hour-tape.json"), "utf8")) as Hour

/** The hour's rows as the stream sends them. */
function hourRows(pattern: string): SignalRow[] {
  expect(HOUR.columns).toEqual([...HOUR_COLUMNS])
  const start = Date.parse(HOUR.from)
  return HOUR.tapes[pattern]!.map(([id, ms, asset, chain, groups, usd, direction]) => ({
    id: id as number,
    pattern,
    created_at: new Date(start + (ms as number)).toISOString(),
    asset_address: fakeAddress(asset as number),
    asset_chain: chain as string,
    wallet_groups: groups as string[],
    payload: { usd_value: usd, ...(direction !== null ? { direction } : {}) },
  }))
}

/**
 * The matcher over the hour, as the core runs it: each row as it would have been heard (a second after it happened),
 * and slots for every token (positions never close within the hour, since every replay held for an hour or more).
 * Candle prices exactly the tokens the replays named in `pricedBy` entered, since a token Hacc couldn't price is one
 * it skips; `unpriced` prices every token. Answers the signals it entered on.
 */
async function replayHour(name: string, pattern: string, o: { pricedBy?: string[]; unpriced?: boolean } = {}): Promise<number[]> {
  const read = readDefinition(HOUR.replays[name]!.definition)
  if (!read.ok) throw new Error(read.message)
  const definition = { ...read.definition, sizing: { ...read.definition.sizing, max_concurrent: 100_000 } }
  const rows = hourRows(pattern).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
  const entered = new Set((o.pricedBy ?? [name]).flatMap((n) => HOUR.replays[n]!.entries))
  const priced = new Set(rows.filter((r) => entered.has(r.id)).map((r) => String(r.asset_address)))
  const h = harness({ bots: [{ ...BOT, definition }], onSince: Date.parse(HOUR.from) - 1 })
  h.set.sol = undefined
  const held = new Set<string>()
  h.set.send = (args) => {
    held.add(String(args.mint))
    return { paper: { content: [] } }
  }
  for (const r of rows) {
    const mint = String(r.asset_address)
    if (!h.prices.has(mint)) h.prices.set(mint, priced.has(mint) || o.unpriced ? market(mint, 0.001) : market(mint, null, null))
  }
  for (const r of rows) {
    h.now.at = Date.parse(r.created_at) + 1_000
    for (const m of held) h.held.add(`conf\n${m}`)
    const tape = h.e.onTape([r])
    await h.tick(PRICE_WAIT_MS + 1)
    await tape
  }
  return h.sent.map((s) => s.client.bot!.signal!)
}

describe("the hour Hacc replayed, through the matcher", () => {
  test("new tickers on the full tape, no filters: the replay's 355 entries, signal for signal", async () => {
    const replay = HOUR.replays["hour-clean-new-ticker"]!.entries
    expect(replay).toHaveLength(355)
    expect((await replayHour("hour-clean-new-ticker", "new_ticker")).sort()).toEqual([...replay].sort())
  }, 60_000)

  test("confluence: the replay's 222, signal for signal", async () => {
    const replay = HOUR.replays["hour-clean-confluence"]!.entries
    expect(replay).toHaveLength(222)
    expect((await replayHour("hour-clean-confluence", "confluence")).sort()).toEqual([...replay].sort())
  }, 60_000)

  test("large moves of $15,000 or more, in: the replay's 5, from the row's size and direction alone", async () => {
    const replay = HOUR.replays["hour-usd-direction"]!.entries
    expect(replay).toHaveLength(5)
    expect((await replayHour("hour-usd-direction", "large_move")).sort()).toEqual([...replay].sort())
    // Priced or not, a row the filters refuse is never entered: every token priced adds only the one Hacc didn't price.
    const all = await replayHour("hour-usd-direction", "large_move", { unpriced: true })
    expect(all).toEqual(expect.arrayContaining(replay))
    expect(all).toHaveLength(6)
  }, 60_000)

  test("serial wallets' new tickers: every replay entry is the matcher's, and every matcher entry had a serial wallet", async () => {
    // The replay's 50 slots filled in its own price-mark order, which a live run can't see: with slots for every
    // token, the matcher's entries take in all 50.
    const replay = HOUR.replays["hour-groups"]!.entries
    const ours = await replayHour("hour-groups", "new_ticker", { pricedBy: ["hour-clean-new-ticker"] })
    expect(ours).toEqual(expect.arrayContaining(replay))
    const serial = (HOUR.replays["hour-groups"]!.definition as { entry: { filters: { groups: string[] } } }).entry.filters.groups[0]!
    const byId = new Map(hourRows("new_ticker").map((r) => [r.id, r]))
    expect(ours.every((id) => (byId.get(id)!.wallet_groups as string[]).includes(serial))).toBe(true)
  }, 60_000)
})
