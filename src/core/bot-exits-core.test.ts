// A rules bot's exits through a real core: the price read by the triggers' watcher, the decision journalled before the
// sell, and the sell run with no card on a wallet that asks every time, approved as the bot's exit. The kill switch
// lets it through; a view can't claim the bot's approval; a restart after the sell was sent reads it back and never
// sells again; and two failed sells of a token hold the third.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import type { AutonomyTopic } from "./autonomy"
import type { BotProposal } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import { startCore } from "./core-main"
import type { JournalRow } from "./journal"
import type { SignalRow } from "./signal-stream"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }
const definition = { chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { take_profit_pct: 100, stop_loss_pct: 40 }, sizing: { usd_per_trade: 1.5, max_concurrent: 4 } }
const proposal: BotProposal = { name: "conf", definition, run: { agent: "momentum", wallet: "embedded", mode: "live" } }

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const calls = (p: TestCore["p"]) => {
  const file = join(candleConfigDir(p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
    : []
}
const sells = (p: TestCore["p"]) => calls(p).filter((x) => x.name === "candle_trade" && x.args.side === "sell")
const rows = (rs: readonly JournalRow[], type: string) => rs.filter((r) => r.type === type)

/** A key's fake script, changed while the core runs: it's read on every call. */
function script(p: TestCore["p"], change: Record<string, unknown>, agent = "momentum") {
  const file = join(candleConfigDir(p.stateDir, agent), "fake-candle.json")
  const was = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
  writeFileSync(file, JSON.stringify({ ...was, ...change }))
}
/** MOON's price on Candle's market read, from now, through either key: the watcher reads with whichever has room. */
const moonAt = (p: TestCore["p"], usd: number) => {
  for (const agent of ["momentum", "swing"]) script(p, { markets: [{ mint: MOON, symbol: "MOON", priceUsd: usd }] }, agent)
}

/**
 * The watcher's clock, ahead of the wall's by `skew`: a test moves it on past the 5 s a market read is reused for, so
 * the next heartbeat reads the price it just set.
 */
let skew = 0
const clock = {
  now: () => Date.now() + skew,
  schedule: (run: () => void, ms: number) => {
    const t = setTimeout(run, ms)
    return () => clearTimeout(t)
  },
}
/** One heartbeat, with Candle's market read again. */
const beat = async (c: { watchBeat(): Promise<void> }) => {
  skew += 5_000
  await c.watchBeat()
}

/** A core with the bot holding one MOON position, entered inside the wallet's figures; the wallet then asks every time. */
async function holding() {
  const c = await startTestCore({ env: process.env, triggerClock: clock })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "activity"] })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  await view.request("autonomy.set", INSIDE)
  await until(() => {
    try {
      c.core.bots.check(proposal, "momentum")
      return true
    } catch {
      return false
    }
  })
  await c.core.bots.save(proposal, "momentum", { hash: c.core.bots.check(proposal, "momentum").hash })
  await c.core.botEntries.onTape([{ id: 9_001, pattern: "confluence", created_at: new Date().toISOString(), asset_address: MOON, asset_chain: "solana", wallet_groups: [], payload: {} } as SignalRow])
  await until(() => c.core.botEntries.under().length === 0 && c.core.bots.entries().length === 1 && rows(c.core.journal.rows(), "operation.succeeded").length === 1)
  const position = (c.core as unknown as { botExits: { tokens(): string[] } }).botExits.tokens()
  expect(position).toEqual([MOON])
  await view.request("autonomy.set", { wallet: "embedded", setting: "ask" })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "ask")
  return { c, view }
}

describe("a bot's exit on a real core", () => {
  test("a stop on a wallet that asks every time: journalled first, then sold with no card, as the bot's exit", async () => {
    const { c, view } = await holding()
    moonAt(c.p, 0.01)
    await beat(c.core)
    await until(() => sells(c.p).length === 1)
    const all = c.core.journal.rows()
    const exiting = all.findIndex((r) => r.type === "bot.exiting")
    const created = all.findIndex((r) => r.type === "card.created" && r.botAct === "exit")
    expect(exiting).toBeGreaterThanOrEqual(0)
    expect(created).toBeGreaterThan(exiting)
    expect(all[exiting]).toMatchObject({ name: "conf", reason: "stop_loss", sell: { by: "amount" } })
    expect(all.find((r) => r.type === "card.approved" && r.botAct === "exit")).toMatchObject({ how: "bot-exit", inside: { words: 'without a card, as the bot "conf"\'s exit: you approved its exits with it' } })
    expect(sells(c.p)[0]!.args).toMatchObject({ mint: MOON, side: "sell" })
    await until(() => c.core.botExits.under().length === 0 && c.core.botExits.tokens().length === 0)
    // Nothing waits for the person.
    expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval")).toHaveLength(0)
    // A view can't claim the bot's approval for a card of its own: it's a plain approval.
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "sell", amount: "1" } })
    await until(() => c.core.cards.list().some((x) => x.state === "awaiting_approval"))
    const mine = c.core.cards.list().find((x) => x.state === "awaiting_approval")!
    await view.request("cards.approve", { cardId: mine.cardId, cardHash: mine.cardHash, how: "bot-exit" })
    await until(() => c.core.journal.rows().some((r) => r.type === "card.approved" && r.cardId === mine.cardId))
    expect(c.core.journal.rows().find((r) => r.type === "card.approved" && r.cardId === mine.cardId)).toMatchObject({ how: "view" })
  })

  test("the kill switch holds a bot's entries and lets its exits sell", async () => {
    const { c, view } = await holding()
    await view.request("kill", {})
    moonAt(c.p, 2)
    await beat(c.core)
    await until(() => sells(c.p).length === 1)
    expect(rows(c.core.journal.rows(), "bot.exiting")[0]).toMatchObject({ reason: "take_profit" })
  })

  test("a restart after its sell was sent: read back by its id, never sold again", async () => {
    const { c } = await holding()
    moonAt(c.p, 0.01)
    await beat(c.core)
    await until(() => sells(c.p).length === 1 && rows(c.core.journal.rows(), "operation.succeeded").length === 2)
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    // As a core killed once the sell went out: the journal ends at its write-ahead row.
    const lines = readFileSync(p.journal, "utf8").split("\n").filter(Boolean)
    const exitOp = (JSON.parse(lines.find((l) => l.includes('"type":"card.created"') && l.includes('"botAct":"exit"'))!) as JournalRow).opId
    const at = lines.findIndex((l) => l.includes('"type":"operation.submitting"') && l.includes(`"${exitOp}"`))
    expect(at).toBeGreaterThan(0)
    await Bun.write(p.journal, `${lines.slice(0, at + 1).join("\n")}\n`)
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      await until(() => ["pro", "max"].includes(String(again.plans.planFor("momentum").plan)))
      await until(() => again.journal.rows().some((r) => r.type === "operation.succeeded" && r.opId === exitOp))
      await beat(again)
      await Bun.sleep(300)
      expect(again.botExits.tokens()).toEqual([])
      expect(sells(p)).toHaveLength(1)
      expect(rows(again.journal.rows(), "bot.exiting")).toHaveLength(1)
    } finally {
      await again.stop("test")
    }
  })

  test("two failed sells of MOON in a row on the key: the third waits, said once", async () => {
    const { c } = await holding()
    script(c.p, { tools: { candle_trade: { refuse: "SWAP_FAILED", stage: "reverted" } } })
    moonAt(c.p, 0.01)
    for (let i = 1; i <= 2; i++) {
      await beat(c.core)
      await until(() => rows(c.core.journal.rows(), "bot.exit_ended").length === i)
    }
    expect(c.core.failedSells.count("momentum", MOON)).toBe(2)
    await beat(c.core)
    await until(() => rows(c.core.journal.rows(), "bot.exit_held").length === 1)
    await beat(c.core)
    await Bun.sleep(200)
    expect(sells(c.p)).toHaveLength(2)
    expect(rows(c.core.journal.rows(), "bot.exit_held")).toHaveLength(1)
    expect(rows(c.core.journal.rows(), "bot.exit_held")[0]).toMatchObject({ why: "failed_sells" })
  })
})

describe("a Hood bot's exit on a real core", () => {
  test("a live Hood bot's stop sells what its book holds in the embedded wallet on Hood, never looking for it in the Solana one", async () => {
    const TOKEN = "0x00000000000000000000000000000000000b0B21"
    const held = "1000000000000000000000"
    const hoodScript = { evmWei: "5000000000000000000", ethUsd: 2_000, evmTokens: [{ mint: TOKEN, amountRaw: held, decimals: 18 }], markets: [{ mint: TOKEN, symbol: "HTOK", priceUsd: 0.002, chain: "hood" }] }
    const c = await startTestCore({ env: process.env, triggerClock: clock }, { candle: { momentum: hoodScript, swing: hoodScript } })
    cores.push(c)
    await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
    const hood: BotProposal = { name: "hood-conf", definition: { ...definition, chain: "hood" }, run: { agent: "momentum", wallet: "embedded", mode: "live" } }
    await until(() => {
      try {
        c.core.bots.check(hood, "momentum")
        return true
      } catch {
        return false
      }
    })
    await c.core.bots.save(hood, "momentum", { hash: c.core.bots.check(hood, "momentum").hash })
    // Its entry, as the journal holds a filled buy of the bot's: 1,000 HTOK bought for $2 from the embedded wallet on Hood.
    const base = { mode: "live" as const, agent: "momentum", cardId: "card_hood1", opId: "op_hood1" }
    await c.core.journal.append({ type: "card.created", ...base, bot: "hood-conf", botAct: "entry", side: "buy", mint: TOKEN, route: "embedded", chain: "hood" })
    await c.core.journal.append({ type: "card.approved", ...base, how: "bot-entry", usd: 2 })
    await c.core.journal.append({ type: "operation.succeeded", ...base, fill: { side: "buy", mint: TOKEN, chain: "hood", wallet: "embedded", asset: "ETH", tokensRaw: held, assetRaw: "1000000000000000", measured: "chain", tokenDecimals: 18 } })
    await until(() => c.core.botExits.tokens().includes(TOKEN))
    // The price falls 60%: its 40% stop holds.
    for (const agent of ["momentum", "swing"]) script(c.p, { markets: [{ mint: TOKEN, symbol: "HTOK", priceUsd: 0.0008, chain: "hood" }] }, agent)
    await beat(c.core)
    await until(() => sells(c.p).some((s) => s.args.mint === TOKEN) || rows(c.core.journal.rows(), "bot.position_left").length > 0 || rows(c.core.journal.rows(), "bot.held").length > 0)
    // A second look a minute on, as the exits read a wallet that seemed empty again before giving the position up.
    skew += 61_000
    await beat(c.core)
    await until(() => sells(c.p).some((s) => s.args.mint === TOKEN) || rows(c.core.journal.rows(), "bot.position_left").length > 0)
    expect(rows(c.core.journal.rows(), "bot.position_left")).toEqual([])
    expect(rows(c.core.journal.rows(), "bot.exiting").at(-1)).toMatchObject({ name: "hood-conf", reason: "stop_loss", chain: "hood", wallet: "embedded" })
    expect(sells(c.p).find((s) => s.args.mint === TOKEN)!.args).toMatchObject({ mint: TOKEN, side: "sell" })
  }, 30_000)
})
