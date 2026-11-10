// A rules bot's exits: each exit as Hacc's replays read it, the order they're said in, the decision journalled
// before the sell, the bot's own amount sold, a restart mid-exit never selling twice, a sleep, two failed sells
// holding the third, and the triggers' watcher reading a bot's tokens as a sell's, first.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Definition, Exit } from "../shared/definition"
import { Redactor } from "../shared/redact"
import { BotPositions } from "./bot-book"
import { CodeBotDesk, type CodeBotDeskDeps } from "./bot-protocol"
import { BotExits, type BotExitsDeps, EMPTY_RECHECK_MS, exitReason, pctWords, READ_AFTER_FILL_MS, REFUSED_RETRY_MS } from "./bot-exits"
import type { BotEntry } from "./bots-file"
import type { Holding } from "./cards"
import { FailedSells } from "./failed-sells"
import { Journal, type JournalRow } from "./journal"
import { botFields, type FaceClient } from "./tool-face"
import { type Reading, TriggerWatch } from "./trigger-watch"
import type { TriggerEntry } from "./triggers-file"

const MOON = "MoonFake11111111111111111111111111111111111"
const TEE = "TeeWa11etFake1111111111111111111111111111111"
const T0 = Date.parse("2026-11-06T12:00:00Z")
const H = 3_600_000
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const label = "MOON"
const at = (entryUsd: number | undefined, priceUsd: number | null, o: { peakUsd?: number; heldMs?: number } = {}) => ({ label, entryUsd, priceUsd, peakUsd: o.peakUsd, entryAt: T0, now: T0 + (o.heldMs ?? 60_000) })

describe("each exit, as Hacc's replays read it", () => {
  test("a take profit at its threshold over the entry, a stop at its threshold under it", () => {
    const x: Exit = { take_profit_pct: 100, stop_loss_pct: 40 }
    expect(exitReason(x, at(2, 3.99))).toBeUndefined()
    expect(exitReason(x, at(2, 4))).toEqual({ code: "take_profit", words: "a take profit at +100%: MOON was $4, 100% over its $2 entry" })
    expect(exitReason(x, at(2, 1.21))).toBeUndefined()
    expect(exitReason(x, at(2, 1.2))).toEqual({ code: "stop_loss", words: "a stop at -40%: MOON was $1.2, 40% under its $2 entry" })
  })

  test("a trailing stop: nothing before it's armed at arm_multiple × the entry, then a fall of drop_pct from the highest since", () => {
    const x: Exit = { trailing: { arm_multiple: 1.3, drop_pct: 15 } }
    // Never armed: a fall of 20% from a peak of 1.2× the entry isn't a trailing stop.
    expect(exitReason(x, at(1, 0.96, { peakUsd: 1.2 }))).toBeUndefined()
    // Armed at 1.5×, fallen 10%: not yet.
    expect(exitReason(x, at(1, 1.35, { peakUsd: 1.5 }))).toBeUndefined()
    expect(exitReason(x, at(1, 1.275, { peakUsd: 1.5 }))).toEqual({ code: "trailing_stop", words: "a trailing stop: MOON rose to $1.5, 1.5× its entry, then fell 15% to $1.275" })
  })

  test("a max hold from the entry's fill, with no price needed; with no entry known, only the hold", () => {
    const x: Exit = { max_hold_hours: 24, stop_loss_pct: 10 }
    expect(exitReason(x, at(2, null, { heldMs: 24 * H - 1 }))).toBeUndefined()
    expect(exitReason(x, at(2, null, { heldMs: 24 * H }))).toEqual({ code: "max_hold", words: "its 24-hour hold ran out" })
    expect(exitReason(x, at(undefined, 0.01, { heldMs: H }))).toBeUndefined()
  })

  test("several at once: the stop first, then the take profit, the trailing stop, the hold", () => {
    expect(exitReason({ stop_loss_pct: 10, max_hold_hours: 1 }, at(2, 1, { heldMs: 2 * H }))?.code).toBe("stop_loss")
    expect(exitReason({ take_profit_pct: 10, trailing: { arm_multiple: 1, drop_pct: 5 }, max_hold_hours: 1 }, at(1, 1.2, { peakUsd: 2, heldMs: 2 * H }))?.code).toBe("take_profit")
    expect(exitReason({ trailing: { arm_multiple: 1, drop_pct: 5 }, max_hold_hours: 1 }, at(1, 1.2, { peakUsd: 2, heldMs: 2 * H }))?.code).toBe("trailing_stop")
  })
})

const bot = (o: Partial<BotEntry> = {}): BotEntry =>
  ({
    name: "conf",
    agent: "momentum",
    wallet: "embedded",
    mode: "live",
    state: "on",
    definition: { chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 }, sizing: { usd_per_trade: 2, max_concurrent: 4 } } as Definition,
    ...o,
  }) as BotEntry

async function setup(o: { bots?: BotEntry[]; held?: BotExitsDeps["held"]; mode?: "paper" | "live"; holding?: (wallet: string) => Holding; send?: (client: FaceClient) => Promise<unknown>; breaker?: BotExitsDeps["breaker"] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "chrn-botexits-"))
  dirs.push(dir)
  let now = T0
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => now })
  journals.push(journal)
  const positions = new BotPositions({ rows: [], schedule: () => () => {}, now: () => now })
  journal.onAppend((row) => positions.note(row))
  const failed = new FailedSells()
  journal.onAppend((row) => void failed.note(row))
  const bots = o.bots ?? [bot()]
  const readings = new Map<string, Reading>()
  const sent: { trade: { args: Record<string, unknown> }; client: FaceClient; reason: string }[] = []
  let seq = 0
  const make = () =>
    new BotExits({
      bots: { exiting: () => bots.map((b) => ({ bot: b, definition: b.definition })) },
      ...(o.held ? { held: o.held } : {}),
      positions,
      journal,
      clock: { now: () => now },
      mode: () => o.mode ?? "live",
      reading: (mint) => readings.get(mint),
      holding: async (_agent, wallet) => o.holding?.(wallet) ?? { amountRaw: 1_000_000n, decimals: 6 },
      failed,
      // As the core sends it: the bot's card, recorded with its origin, approved with no card; the fill comes after.
      send: async (trade, client, _mode, reason) => {
        sent.push({ trade, client, reason })
        if (o.send) return o.send(client)
        const opId = `op-exit-${++seq}`
        await journal.append({ type: "card.created", mode: "live", agent: client.agent, cardId: `card-${opId}`, opId, ...botFields(client.bot), kind: "trade", tool: "candle_trade", wallet: String(trade.args.wallet ?? "paper"), side: "sell", mint: String(trade.args.mint) })
        await journal.append({ type: "card.approved", mode: "live", agent: client.agent, cardId: `card-${opId}`, opId, how: "bot-exit", ...botFields(client.bot) })
        return { cardId: `card-${opId}`, opId, state: "approved", instant: { kind: "submitted" } }
      },
      card: () => undefined,
      nameOf: () => "MOON",
      ...(o.breaker ? { breaker: o.breaker } : {}),
    })
  const exits = make()
  journal.onAppend((row) => exits.note(row))
  /** A bot's entry, filled: 1 MOON (6 decimals) for 0.01 SOL at $200 a SOL, so $2 a token. */
  const enter = async (o2: { name?: string; wallet?: string; opId?: string; tokensRaw?: string } = {}) => {
    const opId = o2.opId ?? `op-in-${++seq}`
    const name = o2.name ?? "conf"
    await journal.append({ type: "card.created", mode: "live", agent: "momentum", cardId: `card-${opId}`, opId, ...botFields({ name, act: "entry", signal: seq }), kind: "trade", tool: "candle_trade", wallet: o2.wallet ?? "embedded", side: "buy", mint: MOON })
    await journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId, fill: { side: "buy", mint: MOON, wallet: o2.wallet ?? "embedded", asset: "SOL", tokensRaw: o2.tokensRaw ?? "1000000", assetRaw: "10000000", feeRaw: "0", measured: "chain", tokenDecimals: 6, assetUsd: 200 } })
    return opId
  }
  /** A buy read back by its id: its answer said what was sent (0.01 SOL, $2), and nothing of what it received. */
  const enterReadBack = async (name = "conf") => {
    const opId = `op-in-${++seq}`
    await journal.append({ type: "card.created", mode: "live", agent: "momentum", cardId: `card-${opId}`, opId, ...botFields({ name, act: "entry", signal: seq }), kind: "trade", tool: "candle_trade", wallet: "embedded", side: "buy", mint: MOON })
    await journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId, fill: { side: "buy", mint: MOON, wallet: "embedded", asset: "SOL", assetRaw: "10000000", measured: "none", assetUsd: 200 } })
    return opId
  }
  /** The exit's sell settled: filled, or Candle's error. */
  const settle = async (opId: string, ok: boolean, code = "SWAP_FAILED") => {
    if (ok) await journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId, fill: { side: "sell", mint: MOON, wallet: "embedded", asset: "SOL", tokensRaw: "1000000", assetRaw: "20000000", feeRaw: "0", measured: "chain", assetUsd: 200 } })
    else await journal.append({ type: "operation.failed", mode: "live", agent: "momentum", opId, error: { code, message: "The swap failed." } })
    // The exit's end is journalled as the outcome's row is noted.
    await Bun.sleep(5)
  }
  /** Candle's market read, a moment after anything already filled: a read as a buy fills is the price before it. */
  const price = (usd: number, decimals?: number) => {
    now += READ_AFTER_FILL_MS
    readings.set(MOON, { priceUsd: usd, marketCap: 1_000_000, at: now, ...(decimals !== undefined ? { decimals } : {}) })
  }
  const rows = (type: string) => journal.rows().filter((r) => r.type === type)
  /** A reading at this very moment, with no time passed since anything filled. */
  const priceNow = (usd: number | null) => readings.set(MOON, { priceUsd: usd, marketCap: 1_000_000, at: now })
  return { journal, positions, failed, exits, sent, enter, enterReadBack, settle, price, priceNow, rows, make, advance: (ms: number) => (now += ms), now: () => now }
}

describe("what a change of exits would sell at once", () => {
  test("counts the open positions the new exits sell on the next check and the bot's exits now don't", async () => {
    const s = await setup()
    await s.enter()
    await s.enter()
    s.price(1.9, 6)
    s.advance(2 * H)
    const now: Exit = { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 }
    // A hold shorter than they've been held sells both; a stop above the last price does too, though that price is old now.
    expect(s.exits.wouldSell("conf", now, { ...now, max_hold_hours: 1 })).toBe(2)
    expect(s.exits.wouldSell("conf", now, { ...now, stop_loss_pct: 2 })).toBe(2)
    // Exits nearer, with nothing crossed: nothing sells now.
    expect(s.exits.wouldSell("conf", now, { ...now, max_hold_hours: 12, stop_loss_pct: 20 })).toBe(0)
    // A position its exits sell already isn't the change's doing.
    expect(s.exits.wouldSell("conf", { max_hold_hours: 1 }, { max_hold_hours: 0.5 })).toBe(0)
    expect(s.exits.wouldSell("other", now, { ...now, max_hold_hours: 1 })).toBe(0)
  })
})

describe("a bot's exit, sold as its own", () => {
  test("a stop crossed: journalled first, then the bot's own amount sold as the bot's own, by its client; filled, the position closes", async () => {
    const s = await setup()
    const id = await s.enter()
    s.price(1.1, 6)
    await s.exits.check()
    const all = s.journal.rows()
    const exiting = all.findIndex((r) => r.type === "bot.exiting")
    const created = all.findIndex((r) => r.type === "card.created" && r.botAct === "exit")
    expect(exiting).toBeGreaterThanOrEqual(0)
    expect(created).toBeGreaterThan(exiting)
    expect(all[exiting]).toMatchObject({ name: "conf", position: id, mint: MOON, reason: "stop_loss", wallet: "embedded", botMode: "live", sell: { by: "amount", amountRaw: "1000000", amount: "1" } })
    expect(String(all[exiting]!.words)).toBe("sells 1 MOON: a stop at -40%: MOON was $1.1, 45% under its $2 entry")
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.trade.args).toEqual({ mint: MOON, side: "sell", amount: "1", wallet: "embedded" })
    expect(s.sent[0]!.client).toMatchObject({ clientId: "core:bot:conf", role: "core", agent: "momentum", bot: { name: "conf", act: "exit", position: id, reason: "stop_loss" } })
    // Under way: the next heartbeat doesn't sell it again.
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
    await s.settle("op-exit-2", true)
    expect(s.positions.get(id)?.closedAt).toBeDefined()
    expect(s.exits.under()).toHaveLength(0)
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })

  test("the embedded wallet sells a token Candle gives no decimals for by whole percent of its balance; a TEE wallet by amount", async () => {
    const s = await setup({ holding: () => ({ amountRaw: 4_000_000n, decimals: 6 }) })
    await s.enter()
    s.price(5)
    await s.exits.check()
    expect(s.sent[0]!.trade.args).toEqual({ mint: MOON, side: "sell", percent: 25, wallet: "embedded" })
    expect(s.rows("bot.exiting")[0]).toMatchObject({ reason: "take_profit", sell: { by: "percent", percent: 25, ownRaw: "1000000" } })

    const t = await setup({ bots: [bot({ wallet: TEE })], holding: () => ({ amountRaw: 4_000_000n, decimals: 6 }) })
    await t.enter({ wallet: TEE })
    t.price(5)
    await t.exits.check()
    expect(t.sent[0]!.trade.args).toEqual({ mint: MOON, side: "sell", amount: "1", wallet: TEE })
  })

  test("a price older than 30 s isn't one to exit on; the hold runs out with no price at all", async () => {
    const s = await setup()
    await s.enter()
    s.price(1)
    s.advance(31_000)
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
    s.advance(24 * H)
    await s.exits.check()
    expect(s.rows("bot.exiting")[0]).toMatchObject({ reason: "max_hold" })
    expect(String(s.rows("bot.exiting")[0]!.words)).toMatch(/: its 24-hour hold ran out$/)
  })

  test("the trailing stop's peak is kept from each reading, then the fall from it sells", async () => {
    const s = await setup({ bots: [bot({ definition: { ...bot().definition, exit: { trailing: { arm_multiple: 1.5, drop_pct: 20 } } } })] })
    const id = await s.enter()
    for (const usd of [2.5, 3.2, 3]) {
      s.price(usd, 6)
      await s.exits.check()
    }
    expect(s.positions.get(id)?.peakUsd).toBe(3.2)
    expect(s.sent).toHaveLength(0)
    s.price(2.5, 6)
    await s.exits.check()
    expect(s.rows("bot.exiting")[0]).toMatchObject({ reason: "trailing_stop" })
  })

  test("after a sleep, and as the core starts, an exit found says it was found on the first read, never when the price crossed", async () => {
    const s = await setup()
    await s.enter()
    s.price(1, 6)
    await s.exits.check({ slept: true })
    expect(String(s.rows("bot.exiting")[0]!.words)).toMatch(/\(found on the core's first read after this machine woke, past its stop\)$/)
    expect(String(s.rows("bot.exiting")[0]!.words)).not.toContain("passed the")

    const u = await setup()
    await u.enter()
    u.price(1, 6)
    await u.exits.check({ first: true })
    expect(String(u.rows("bot.exiting")[0]!.words)).toMatch(/\(found on the core's first read after it started, past its stop\)$/)

    const t = await setup()
    await t.enter()
    t.advance(25 * H)
    await t.exits.check({ first: true })
    expect(String(t.rows("bot.exiting")[0]!.words)).toMatch(/: its 24-hour hold ran out while the core wasn't running$/)
  })

  test("a percent under 10 is said to one decimal, so a +0.53% take profit doesn't read 1%", () => {
    const r = exitReason({ take_profit_pct: 0.5 }, { label: "JUP", entryUsd: 0.2456, priceUsd: 0.2469, entryAt: 0, now: 1 })
    expect(r?.words).toContain("0.5% over its")
    expect(pctWords(12.4)).toBe("12")
    expect(pctWords(0.53)).toBe("0.5")
  })

  test("a buy read back by its id: Candle's first price after it is its entry, said so, and the stop runs from it", async () => {
    const s = await setup({ holding: () => ({ amountRaw: 3_000_000n, decimals: 6 }) })
    const id = await s.enterReadBack()
    s.price(2, 6)
    await s.exits.check()
    expect(s.positions.get(id)?.markUsd).toBe(2)
    expect(s.sent).toHaveLength(0)
    s.price(1.1, 6)
    await s.exits.check()
    expect(String(s.rows("bot.exiting")[0]!.words)).toMatch(/a stop at -40%: MOON was \$1\.1, 45% under Candle's \$2 price when it entered$/)
    // It sells about the 1 MOON its $2 bought at that $2, of the wallet's 3: the other 2 are the person's.
    expect(s.rows("bot.exiting")[0]).toMatchObject({ sell: { by: "amount", amountRaw: "1000000", amount: "1" }, note: expect.stringContaining("it sells about what its $2.00 bought") })
    expect(s.sent[0]!.trade.args).toMatchObject({ side: "sell", amount: "1" })
  })

  test("a buy read back by its id, flattened before Candle priced it: nothing is sold or given up until its own can be worked out", async () => {
    const s = await setup({ holding: () => ({ amountRaw: 3_000_000n, decimals: 6 }) })
    const id = await s.enterReadBack()
    s.exits.flatten(bot(), { how: "view" })
    await Bun.sleep(10)
    expect(s.sent).toHaveLength(0)
    expect(s.rows("bot.position_left")).toEqual([])
    expect(s.positions.get(id)?.closedAt).toBeUndefined()
    expect(String(s.rows("bot.exit_held")[0]!.words)).toContain("Nothing is sold until it can")
  })

  test("flatten: every open position sold now, whatever the price, with flatten as why", async () => {
    const s = await setup()
    await s.enter()
    await s.enter()
    const said = s.exits.flatten(bot(), { how: "view" })
    expect(said).toEqual({ said: 'Selling its 2 open positions of "conf" now, as its exits sell. Activity says how each ends.', positions: 2 })
    await Bun.sleep(10)
    expect(s.rows("bot.exiting").map((r) => r.reason)).toEqual(["flatten", "flatten"])
    expect(s.exits.flatten(bot(), { how: "view" }).said).toBe('"conf" is already selling what it holds.')
  })
})

describe("nothing is sold twice, and nothing is lost", () => {
  test("a restart after the sell was sent: still under way from the journal, never sold again; its outcome read back closes it", async () => {
    const s = await setup()
    const id = await s.enter()
    s.price(1, 6)
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
    const again = s.make()
    await again.rebuild(s.journal.rows())
    s.journal.onAppend((row) => again.note(row))
    await again.check()
    expect(s.sent).toHaveLength(1)
    expect(again.under()).toHaveLength(1)
    await s.settle("op-exit-2", true)
    expect(again.under()).toHaveLength(0)
    expect(s.positions.get(id)?.closedAt).toBeDefined()
  })

  test("a restart between `bot.exiting` and its sell: the exit ends in words, and the position is checked again", async () => {
    const s = await setup({ send: async () => new Promise(() => {}) })
    const id = await s.enter()
    s.price(1, 6)
    void s.exits.check()
    await Bun.sleep(10)
    expect(s.rows("bot.exiting")).toHaveLength(1)
    const again = s.make()
    s.journal.onAppend((row) => again.note(row))
    await again.rebuild(s.journal.rows())
    expect(s.rows("bot.exit_ended")[0]).toMatchObject({ position: id, outcome: "lost" })
    expect(again.under()).toHaveLength(0)
  })

  test("an exit that filled with an answer the book can't read still closes its position", async () => {
    const s = await setup()
    const id = await s.enter()
    s.price(1, 6)
    await s.exits.check()
    await s.journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op-exit-2" })
    expect(s.positions.get(id)?.closedAt).toBeDefined()
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })

  test("a wallet that holds none of it, read twice a minute apart: the position is given up, said as sold outside the bot", async () => {
    const s = await setup({ holding: () => "none" })
    const id = await s.enter()
    s.price(1, 6)
    await s.exits.check()
    expect(s.rows("bot.position_left")).toHaveLength(0)
    s.advance(EMPTY_RECHECK_MS)
    s.price(1, 6)
    await s.exits.check()
    expect(s.rows("bot.position_left")[0]).toMatchObject({ position: id, outsideRaw: "1000000" })
    expect(s.positions.get(id)).toMatchObject({ left: true, outsideRaw: "1000000" })
    expect(s.sent).toHaveLength(0)
  })

  test("a sell the core refused before Candle (a held key): ended in its words, and tried again a minute later, not each heartbeat", async () => {
    const s = await setup({ send: async () => Promise.reject(Object.assign(new Error("Candle stopped this key."), { code: "RISK_LIMIT_REACHED" })) })
    await s.enter()
    s.price(1, 6)
    await s.exits.check()
    expect(s.rows("bot.exit_ended")[0]).toMatchObject({ outcome: "refused", code: "RISK_LIMIT_REACHED" })
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
    s.advance(REFUSED_RETRY_MS)
    s.price(1, 6)
    await s.exits.check()
    expect(s.sent).toHaveLength(2)
  })

  test("a live position sells live while the Candle Harness is on paper: the bot's mode is its own", async () => {
    const s = await setup({ mode: "paper" })
    await s.enter()
    s.price(1, 6)
    await s.exits.check()
    expect(s.rows("bot.exit_held")).toHaveLength(0)
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.client.bot?.mode).toBe("live")
    expect(s.sent[0]!.trade.args.wallet).toBe("embedded")
  })
})

describe("an exit that waits for room under Candle's breaker", () => {
  test("sells once there's room, as a stop order does, though the price has moved back over the stop meanwhile", async () => {
    let room = false
    const s = await setup({ breaker: { exit: () => (room ? undefined : { why: "pace", until: s.now() + 20_000, words: "momentum's key has had 20 trades in the last 75 s" }) } })
    await s.enter()
    s.price(1.2)
    await s.exits.check()
    expect(s.rows("bot.exit_held")).toHaveLength(1)
    expect(s.sent).toHaveLength(0)
    // The price back over the stop, then room: the stop it passed still sells, said with how long it waited.
    s.advance(20_000)
    s.price(1.5)
    room = true
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
    const exiting = s.rows("bot.exiting")
    expect(exiting).toHaveLength(1)
    expect(exiting[0]!.reason).toBe("stop_loss")
    expect(String(exiting[0]!.words)).toContain("a stop at -40%: MOON was $1.2, 40% under its $2 entry; it waited 21 s for room under Candle's breaker and sells once passed, as a stop order does")
  })

  test("one that never held waits for nothing: no exit while the price is between its stop and target", async () => {
    const s = await setup({ breaker: { exit: () => undefined } })
    await s.enter()
    s.price(1.5)
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
  })
})

describe("Candle's breaker: two failed sells of a token hold the third", () => {
  test("each failed sell is tried again at the next heartbeat; after two in a row the next waits, said once; retry sends one more", async () => {
    const s = await setup()
    const id = await s.enter()
    s.price(1, 6)
    await s.exits.check()
    await s.settle("op-exit-2", false)
    expect(s.rows("bot.exit_ended")[0]).toMatchObject({ outcome: "failed" })
    // Candle's sentence, its full stop dropped where the Candle Harness's words go on.
    expect(String(s.rows("bot.exit_ended")[0]!.words)).toContain("didn't go through: The swap failed; it's tried again")
    expect(s.failed.count("momentum", MOON)).toBe(1)
    await s.exits.check()
    await s.settle("op-exit-3", false)
    expect(s.sent).toHaveLength(2)
    await s.exits.check()
    await s.exits.check()
    expect(s.sent).toHaveLength(2)
    expect(s.rows("bot.exit_held")).toHaveLength(1)
    expect(String(s.rows("bot.exit_held")[0]!.words)).toBe(
      "MOON: its exit (a stop at -40%: MOON was $1, 50% under its $2 entry) waits: two sells of MOON in a row failed on momentum's key, and one more would stop the key on Candle, sells included, until you resume it in the Agent Console. Say retry on the bot to try once more.",
    )
    // The topic, the retry chip and the doctor read what waits.
    expect(s.exits.heldSells("conf")).toEqual([{ mint: MOON, why: "failed_sells", words: String(s.rows("bot.exit_held")[0]!.words) }])
    expect(s.exits.retry("conf")).toBe(1)
    expect(s.exits.heldSells("conf")).toEqual([])
    await s.exits.check()
    expect(s.sent).toHaveLength(3)
    await s.settle("op-exit-4", true)
    expect(s.positions.get(id)?.closedAt).toBeDefined()
    expect(s.failed.count("momentum", MOON)).toBe(0)
  })

  test("a failed exit holds until it sells, as a stop order does: a price back over its stop doesn't drop it, and the hold is said once", async () => {
    const s = await setup()
    await s.enter()
    s.price(1, 6)
    await s.exits.check()
    await s.settle("op-exit-2", false)
    await s.exits.check()
    await s.settle("op-exit-3", false)
    // The second failure says it waits, not that it's tried again.
    expect(String(s.rows("bot.exit_ended")[1]!.words)).toContain("; it waits: two sells of MOON in a row failed")
    await s.exits.check()
    expect(s.exits.heldSells("conf").map((h) => h.why)).toEqual(["failed_sells"])
    s.price(2.2, 6)
    await s.exits.check()
    expect(s.exits.heldSells("conf").map((h) => h.why)).toEqual(["failed_sells"])
    expect(s.rows("bot.exit_held")).toHaveLength(1)
    expect(s.sent).toHaveLength(2)
    // The person's retry sells it, though the price is back over its stop.
    s.exits.retry("conf")
    await s.exits.check()
    expect(s.sent).toHaveLength(3)
    expect(String(s.rows("bot.exiting")[2]!.words)).toContain("a stop at -40%: MOON was $1, 50% under its $2 entry; its last sell didn't go through, so it sells again")
  })
})

describe("the failed-sell count", () => {
  const created = (opId: string, agent = "momentum", side = "sell"): JournalRow => ({ type: "card.created", seq: 0, at: "", account: "a", mode: "live", opId, agent, side, mint: MOON }) as JournalRow
  const outcome = (opId: string, type: string, code?: string): JournalRow => ({ type, seq: 0, at: "", account: "a", mode: "live", opId, ...(code ? { error: { code } } : {}) }) as JournalRow
  test("anyone's sells on the key count; the core's own refusals and buys don't; a fill starts again", () => {
    const f = new FailedSells([created("a"), outcome("a", "operation.failed"), created("b", "momentum", "buy"), outcome("b", "operation.failed"), created("c"), outcome("c", "operation.refused", "PAUSED")])
    expect(f.count("momentum", MOON)).toBe(1)
    f.note(created("d"))
    f.note(outcome("d", "operation.refused", "SWAP_FAILED"))
    expect(f.held("momentum", MOON)).toBe(true)
    expect(f.held("swing", MOON)).toBe(false)
    // The same outcome read again counts once.
    f.note(outcome("d", "operation.refused", "SWAP_FAILED"))
    expect(f.count("momentum", MOON)).toBe(2)
    f.note(created("e"))
    f.note(outcome("e", "operation.succeeded"))
    expect(f.held("momentum", MOON)).toBe(false)
  })

  test("a sell Candle's key check refused before making a trade, its rate limit among them, counts nothing", () => {
    const f = new FailedSells([created("a"), outcome("a", "operation.failed")])
    for (const [i, code] of ["RATE_LIMITED", "RATE_LIMITED", "KEY_EXPIRED", "SCOPE_MISSING", "UNAUTHORIZED"].entries()) {
      f.note(created(`r${i}`))
      f.note(outcome(`r${i}`, "operation.refused", code))
    }
    expect(f.count("momentum", MOON)).toBe(1)
    expect(f.held("momentum", MOON)).toBe(false)
  })
})

describe("the triggers' watcher reads a bot's tokens", () => {
  test("as a sell's, first, with 25 levels' tokens wanting reads; then the exits check after the heartbeat", async () => {
    const read: string[] = []
    const levels = Array.from({ length: 25 }, (_, i) => `Lvl${String(i).padStart(2, "0")}Fake111111111111111111111111111111111`)
    const triggers = levels.map((_mint, i) => ({ name: `t${i}`, agent: "momentum", line: "", on: true, again: false }) as unknown as TriggerEntry)
    const beats: { slept: boolean; first: boolean }[] = []
    const watch = new TriggerWatch({
      book: {
        live: () => triggers,
        resolved: (t) => ({ class: "level", when: { kind: "price", token: levels[Number(t.name.slice(1))]!, op: ">", usd: 1e9 }, action: { kind: "notify", text: "" } }) as never,
        stateOf: () => ({ armed: true }) as never,
        fired: async () => ({}) as never,
        missed: async () => {},
        setArmed: () => {},
        setNextRun: () => {},
        canFire: () => true,
      },
      clock: { now: () => T0, schedule: () => () => {} },
      market: async (_chain, mint) => {
        read.push(mint)
        return { kind: "ok", result: { market: { mint, priceUsd: 1, decimals: 6 } } } as never
      },
      positions: () => [],
      walletOf: () => undefined,
      pnlUsd: () => null,
      pnlNow: () => {},
      hacc: async () => ({ kind: "refused", code: "HACC_NO_KEY", message: "", ms: 0 }),
      nameOf: () => undefined,
      needsChanged: () => {},
      onChange: () => {},
      exitTokens: () => [MOON],
      afterBeat: async (b) => void beats.push(b),
    })
    await watch.beat()
    expect(read).toHaveLength(20)
    expect(read).toContain(MOON)
    expect(watch.latest(MOON)).toMatchObject({ priceUsd: 1, decimals: 6 })
    expect(beats).toEqual([{ slept: false, first: true }])
  })
})

describe("the price an exit judges on", () => {
  test("a reading from before or as the position filled isn't one of its prices: the buy moved it", async () => {
    const s = await setup()
    // Read as the buy was being sent: a stop's price, from before the bot's own buy.
    s.priceNow(1)
    await s.enter()
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
    s.price(1)
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })

  test("no price from Candle for a minute: the position's figure goes, its exits wait, said once, and the hold still sells", async () => {
    const s = await setup()
    const id = await s.enter()
    s.price(2.5)
    await s.exits.check()
    s.advance(30_000)
    await s.exits.check()
    expect(s.rows("bot.exit_held")).toHaveLength(0)
    s.advance(40_000)
    await s.exits.check()
    await s.exits.check()
    const held = s.rows("bot.exit_held")
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: "unpriced" })
    expect(String(held[0]!.words)).toMatch(/^MOON: no price on Candle since \d\d:\d\d, so its stop and take profit can't be judged until one comes back; its max hold still sells$/)
    expect(s.exits.unpricedSince(id)).toBe(Date.parse(s.positions.get(id)!.entryAt) + 1_000)
    expect(s.exits.heldSells("conf").map((h) => h.why)).toEqual(["unpriced"])
    // A price again: no longer said, and none of it waits.
    s.price(2.4)
    await s.exits.check()
    expect(s.exits.heldSells("conf")).toEqual([])
    expect(s.exits.unpricedSince(id)).toBeUndefined()
    // Unpriced again, through the hold: the hold sells it.
    s.advance(25 * H)
    await s.exits.check()
    expect(s.rows("bot.exiting").at(-1)).toMatchObject({ reason: "max_hold" })
  })
})

describe("a sell that didn't go through", () => {
  test("a flatten's sell that fails after its bot was removed says the tokens are left in the wallet, and nothing sells them again", async () => {
    const s = await setup()
    await s.enter()
    s.price(2)
    s.exits.flatten(bot(), { how: "view" })
    await Bun.sleep(5)
    expect(s.sent).toHaveLength(1)
    // Removed with its positions sold: the bot goes while its sell is still on its way.
    await s.journal.append({ type: "bot.removed", mode: "live", agent: "momentum", name: "conf", positions: "flatten", by: "view-1" })
    await s.settle("op-exit-2", false)
    const words = String(s.rows("bot.exit_ended")[0]!.words)
    expect(words).toContain("didn't go through: The swap failed; its bot is removed, so it isn't tried again: the tokens are left in the wallet, yours to sell")
    expect(words).not.toContain("it's tried again")
    await s.exits.check()
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })

  test("a flatten refused before signing is sold again at the next heartbeat with a fresh id, whatever the price", async () => {
    const s = await setup()
    await s.enter()
    s.price(2)
    s.exits.flatten(bot(), { how: "view" })
    await Bun.sleep(5)
    expect(s.sent).toHaveLength(1)
    await s.journal.append({ type: "operation.refused", mode: "live", agent: "momentum", opId: "op-exit-2", error: { code: "PRE_SIGN_FAILED", message: "The built transaction failed the pre-sign safety check (simulation_failed); nothing was signed or sent. Retry to build a fresh one." } })
    await Bun.sleep(5)
    expect(String(s.rows("bot.exit_ended")[0]!.words)).toContain("; it's tried again")
    await s.exits.check()
    expect(s.sent).toHaveLength(2)
    const again = s.rows("bot.exiting")[1]!
    expect(again).toMatchObject({ reason: "flatten" })
    expect(again.exitId).not.toBe(s.rows("bot.exiting")[0]!.exitId)
    expect(String(again.words)).toContain("you flattened it; its last sell didn't go through, so it sells again")
    // Failed again, so the third is held: why it sells again is said once, not once for each sell that didn't go through.
    await s.settle("op-exit-3", false)
    await s.exits.check()
    const held = s.exits.heldSells("conf")
    expect(held.map((h) => h.why)).toEqual(["failed_sells"])
    expect(held[0]!.words.split("so it sells again")).toHaveLength(2)
  })

  test("a restart doesn't say an exit's end again", async () => {
    const s = await setup()
    await s.enter()
    s.price(1)
    await s.exits.check()
    await s.settle("op-exit-2", false)
    expect(s.rows("bot.exit_ended")).toHaveLength(1)
    const again = s.make()
    await again.rebuild(s.journal.rows())
    await Bun.sleep(5)
    expect(s.rows("bot.exit_ended")).toHaveLength(1)
  })
})

describe("a code bot's exits the core holds", () => {
  /** A code bot "scalper" whose exits the core holds on each position given them. */
  const code = (exits: Map<string, Exit>, o: { busy?: Set<string>; running?: () => boolean } = {}): BotExitsDeps["held"] => ({
    exiting: () => (o.running?.() === false ? [] : [{ name: "scalper" }]),
    exitOf: (position) => exits.get(position),
    slippage: () => 300,
    busy: (position) => o.busy?.has(position) ?? false,
  })

  test("a position with no exits held is its own code's: never read as a sell's token, never sold", async () => {
    const exits = new Map<string, Exit>()
    const s = await setup({ bots: [], held: code(exits) })
    await s.enter({ name: "scalper" })
    s.price(0.01, 6)
    await s.exits.check()
    expect(s.exits.tokens()).toEqual([])
    expect(s.sent).toHaveLength(0)
    expect(s.rows("bot.exiting")).toHaveLength(0)
  })

  test("a buy read back by its id with no exits held: its token is read until Candle's first price near it, which sizes the bot's own", async () => {
    const exits = new Map<string, Exit>()
    const s = await setup({ bots: [], held: code(exits), holding: () => ({ amountRaw: 3_000_000n, decimals: 6 }) })
    const id = await s.enterReadBack("scalper")
    expect(s.exits.tokens()).toEqual([MOON])
    s.price(2, 6)
    await s.exits.check()
    expect(s.positions.get(id)?.markUsd).toBe(2)
    // Sized, it needs no more reading: what's its own is about the 1 MOON its $2 bought, of the wallet's 3.
    expect(s.exits.tokens()).toEqual([])
    expect(s.positions.sellPlan(s.positions.get(id)!, { holding: 3_000_000n, byAmount: true })).toMatchObject({ by: "amount", amountRaw: 1_000_000n })
    expect(s.sent).toHaveLength(0)
  })

  test("a buy read back by its id that Candle priced only after the minute: never sized, its token no longer read, and given up as the person's", async () => {
    const exits = new Map<string, Exit>()
    const s = await setup({ bots: [], held: code(exits), holding: () => ({ amountRaw: 3_000_000n, decimals: 6 }) })
    const id = await s.enterReadBack("scalper")
    s.advance(2 * 60_000)
    expect(s.exits.tokens()).toEqual([])
    s.price(2, 6)
    await s.exits.check()
    expect(s.positions.get(id)?.markUsd).toBeUndefined()
    const plan = s.positions.sellPlan(s.positions.get(id)!, { holding: 3_000_000n, byAmount: true })
    expect(plan).toEqual({ by: "none", words: expect.stringContaining("This bot sells none of it: the wallet's this token is yours to sell.") })
    s.exits.flatten({ name: "scalper", kind: "code", agent: "momentum" }, { how: "view" })
    await Bun.sleep(10)
    expect(s.sent).toHaveLength(0)
    expect(s.positions.get(id)?.closedAt).toBeDefined()
    expect(String(s.rows("bot.position_left")[0]!.words)).toContain("within a minute of it")
  })

  test("a stop held on its position sells as the code bot's own: its kind on every row and on its client, at its card's slippage", async () => {
    const exits = new Map<string, Exit>()
    const s = await setup({ bots: [], held: code(exits) })
    const id = await s.enter({ name: "scalper" })
    exits.set(id, { stop_loss_pct: 40 })
    expect(s.exits.tokens()).toEqual([MOON])
    s.price(1.1, 6)
    await s.exits.check()
    expect(s.rows("bot.exiting")[0]).toMatchObject({ kind: "code", name: "scalper", position: id, reason: "stop_loss" })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.trade.args).toEqual({ mint: MOON, side: "sell", amount: "1", wallet: "embedded", maxSlippageBps: 300 })
    expect(s.sent[0]!.client).toMatchObject({ clientId: "core:bot:scalper", agent: "momentum", bot: { name: "scalper", kind: "code", act: "exit", position: id, reason: "stop_loss", slippageBps: 300 } })
    // Its failed sell's end carries its kind too, and it's sold again with a fresh id.
    await s.settle("op-exit-2", false)
    expect(s.rows("bot.exit_ended")[0]).toMatchObject({ kind: "code", name: "scalper", outcome: "failed" })
    await s.exits.check()
    expect(s.sent).toHaveLength(2)
  })

  test("a sell the bot asked for itself is under way: its held exit waits for it, and sells once it's done", async () => {
    const exits = new Map<string, Exit>()
    const busy = new Set<string>()
    const s = await setup({ bots: [], held: code(exits, { busy }) })
    const id = await s.enter({ name: "scalper" })
    exits.set(id, { stop_loss_pct: 40 })
    busy.add(id)
    s.price(1.1, 6)
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
    busy.delete(id)
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })

  test("flatten sells every position of its own, exits held or not, and leaves one it's selling itself to finish", async () => {
    const exits = new Map<string, Exit>()
    const busy = new Set<string>()
    const s = await setup({ bots: [], held: code(exits, { busy }) })
    const a = await s.enter({ name: "scalper" })
    const b = await s.enter({ name: "scalper", opId: "op-entry-b" })
    exits.set(a, { stop_loss_pct: 40 })
    s.price(1.1, 6)
    busy.add(b)
    const said = s.exits.flatten({ name: "scalper", kind: "code", agent: "momentum" }, { how: "view" }).said
    expect(said).toContain("Selling its open position")
    expect(said).toContain("One position is being sold by the bot itself already, so that sell is left to finish.")
    await Bun.sleep(20)
    expect(s.sent).toHaveLength(1)
    expect(s.rows("bot.exiting")).toMatchObject([{ kind: "code", position: a, reason: "flatten", words: expect.stringContaining("you flattened it") }])
    expect(s.sent[0]!.client.bot).toMatchObject({ kind: "code", reason: "flatten", slippageBps: 300 })
  })

  test("cleared, or its bot's sells not running (stopped or removed), its held exits don't sell", async () => {
    const exits = new Map<string, Exit>()
    let running = false
    const s = await setup({ bots: [], held: code(exits, { running: () => running }) })
    const id = await s.enter({ name: "scalper" })
    exits.set(id, { stop_loss_pct: 40 })
    s.price(1.1, 6)
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
    running = true
    exits.delete(id)
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
    exits.set(id, { stop_loss_pct: 40 })
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })

  test("a rules bot and a code bot side by side: each position judged by its own exits", async () => {
    const exits = new Map<string, Exit>()
    const s = await setup({ held: code(exits) })
    await s.enter()
    const mine = await s.enter({ name: "scalper" })
    // The code bot's take profit is far off; the rules bot's stop at -40% isn't crossed at $1.5.
    exits.set(mine, { take_profit_pct: 500 })
    s.price(1.5, 6)
    await s.exits.check()
    expect(s.sent).toHaveLength(0)
    s.price(1.1, 6)
    await s.exits.check()
    expect(s.sent.map((x) => x.client.bot?.name)).toEqual(["conf"])
  })

  test("a held exit reading the wallet and the bot's own sell of the same position at once: only one sells", async () => {
    const exits = new Map<string, Exit>()
    // The held exit's balance read waits until it's let go: the window the bot's own sell arrives in.
    let letGo: () => void = () => {}
    const gate = new Promise<void>((resolve) => (letGo = resolve))
    let desk: CodeBotDesk | undefined
    const s = await setup({
      bots: [],
      held: code(exits, { busy: { has: (position: string) => desk?.sellUnderWay(position) ?? false } as Set<string> }),
      holding: (() => gate.then(() => ({ amountRaw: 1_000_000n, decimals: 6 }))) as unknown as (wallet: string) => Holding,
    })
    const deskSent: { args: Record<string, unknown> }[] = []
    desk = new CodeBotDesk({
      codeBots: {
        entry: (name: string) => (name === "scalper" ? { name: "scalper", agent: "momentum", wallet: "embedded", mode: "live" } : undefined),
        runs: () => ({ buys: true, sells: true }),
        approvedVersion: () => ({ run: { mode: "live", wallet: "embedded", perTradeUsd: 2, perDayUsd: 5, maxOpen: 2 } }),
        heldBy: () => undefined,
        viewOf: () => ({}),
      },
      positions: s.positions,
      journal: s.journal,
      now: s.now,
      paused: () => false,
      room: () => undefined,
      failed: s.failed,
      send: async (trade: { args: Record<string, unknown> }) => {
        deskSent.push(trade)
        return new Promise(() => {})
      },
      holding: async () => ({ amountRaw: 1_000_000n, decimals: 6 }),
      decimalsOf: () => 6,
      byAmount: () => true,
      market: async () => undefined,
      card: () => undefined,
      nameOf: () => "MOON",
      tell: () => {},
      exitUnderWay: (position: string) => s.exits.selling(position),
    } as unknown as CodeBotDeskDeps)
    const id = await s.enter({ name: "scalper" })
    exits.set(id, { stop_loss_pct: 40 })
    s.price(1.1, 6)
    // The stop holds: the exit starts, and waits on the wallet's balance.
    const checked = s.exits.check()
    await Bun.sleep(5)
    // Its send never answers here: a sell that got through is seen in what was sent, not in an answer.
    const own = await Promise.race([
      desk.sell("scalper", { request: "req_s1_race_0001", position: id }).then(
        () => ({ sent: true }),
        (error: { code?: string }) => ({ code: error?.code }),
      ),
      Bun.sleep(100).then(() => ({ sent: true })),
    ])
    letGo()
    await checked
    await Bun.sleep(5)
    expect(deskSent.length + s.sent.length).toBe(1)
    expect(own).toEqual({ code: "SELL_UNDER_WAY" })
    expect(s.sent).toHaveLength(1)
    expect(s.rows("bot.exiting")).toHaveLength(1)
  })

  test("a sell the bot starts while its held exit reads the wallet: the exit reads busy again after the read, and doesn't sell", async () => {
    const exits = new Map<string, Exit>()
    const busy = new Set<string>()
    let letGo: () => void = () => {}
    const gate = new Promise<void>((resolve) => (letGo = resolve))
    const s = await setup({ bots: [], held: code(exits, { busy }), holding: (() => gate.then(() => ({ amountRaw: 1_000_000n, decimals: 6 }))) as unknown as (wallet: string) => Holding })
    const id = await s.enter({ name: "scalper" })
    exits.set(id, { stop_loss_pct: 40 })
    s.price(1.1, 6)
    const checked = s.exits.check()
    await Bun.sleep(5)
    // Reserved by the exit meanwhile: the bot's own sell (the desk's exitUnderWay) and a flatten see it.
    expect(s.exits.selling(id)).toBe(true)
    busy.add(id)
    letGo()
    await checked
    await Bun.sleep(5)
    expect(s.sent).toHaveLength(0)
    expect(s.rows("bot.exiting")).toHaveLength(0)
    expect(s.exits.selling(id)).toBe(false)
    // Once the bot's own sell is done, the exit sells.
    busy.delete(id)
    await s.exits.check()
    expect(s.sent).toHaveLength(1)
  })
})
