// A rules bot's entries through a real core: a signal off the tape becomes the bot's own buy, journalled before it's
// proposed and run through the wallet's figures, one test per condition, each of which a test here fails without.
// Inside the figures it runs with a receipt; on a wallet that asks, or over a figure, it's a card that waits and
// says why; over the agent's own limit, paused or on a key Candle holds, nothing is sent and it's said; typed-instant
// never applies; two bots of one agent buying one token are two trades; and a restart never enters a signal again.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { BOT_CLIENT_PREFIX } from "./bot-entries"
import type { AutonomyTopic } from "./autonomy"
import type { BotProposal, BotsTopic } from "./bots"
import { candleConfigDir } from "./candle-mcp"
import { startCore } from "./core-main"
import type { JournalRow } from "./journal"
import type { SignalRow } from "./signal-stream"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
// A $1.50 stake with Candle's fee is under a $2.00 figure; $3.00 is over it.
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }
const LIMITS = { perTradeUsd: 10, perDayUsd: 50 }
const definition = (usd: number) => ({ chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { take_profit_pct: 100, stop_loss_pct: 40 }, sizing: { usd_per_trade: usd, max_concurrent: 4 } })
const proposal = (o: { name?: string; usd?: number } = {}): BotProposal => ({ name: o.name ?? "conf", definition: definition(o.usd ?? 1.5), run: { agent: "momentum", wallet: "embedded", mode: "live" } })

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const trades = (p: TestCore["p"]) => {
  const file = join(candleConfigDir(p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
        .filter((x) => x.name === "candle_trade")
    : []
}
const rows = (rs: readonly JournalRow[], type: string) => rs.filter((r) => r.type === type)

type Home = NonNullable<Parameters<typeof startTestCore>[1]>
async function core(o: { config?: Home["config"]; candle?: Home["candle"]; inside?: typeof INSIDE | false } = {}) {
  const c = await startTestCore({ env: process.env }, { ...(o.config ? { config: o.config } : {}), ...(o.candle ? { candle: o.candle } : {}) })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "activity"] })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  if (o.inside !== false) await view.request("autonomy.set", o.inside ?? INSIDE)
  return { c, view }
}

/** Saved as an approved card saves it. */
async function save(c: TestCore, p = proposal()) {
  await until(() => {
    try {
      c.core.bots.check(p, p.run.agent)
      return true
    } catch {
      return false
    }
  })
  await c.core.bots.save(p, p.run.agent, { hash: c.core.bots.check(p, p.run.agent).hash })
}

let nextId = 5_000
/** A confluence signal on MOON, just now, as the bots' stream sends it. */
const signal = (): SignalRow => ({ id: nextId++, pattern: "confluence", created_at: new Date().toISOString(), asset_address: MOON, asset_chain: "solana", wallet_groups: [], payload: { window_minutes: 30 } }) as SignalRow

describe("a bot's entry, through the wallet's figures", () => {
  test("inside them: journalled first, then run with no card as the bot's own, by its own client; never worded as the person's", async () => {
    const { c } = await core()
    await save(c)
    const s = signal()
    await c.core.botEntries.onTape([s])
    await until(() => trades(c.p).length === 1)
    const all = c.core.journal.rows()
    const entering = all.findIndex((r) => r.type === "bot.entering" && r.name === "conf")
    const created = all.findIndex((r) => r.type === "card.created" && r.bot === "conf")
    expect(entering).toBeGreaterThanOrEqual(0)
    expect(created).toBeGreaterThan(entering)
    expect(all[entering]).toMatchObject({ signalId: s.id, mint: MOON, usd: 1.5, botMode: "live" })
    expect(all[created]).toMatchObject({ role: "core", clientId: `${BOT_CLIENT_PREFIX}conf`, botAct: "entry", botSignal: s.id })
    expect(all.find((r) => r.type === "card.approved" && r.bot === "conf")).toMatchObject({ how: "inside-limits" })
    const card = c.core.cards.list().find((x) => x.origin.bot?.name === "conf")!
    expect(card.origin).toMatchObject({ role: "core", source: "bot", bot: { name: "conf", act: "entry", signal: s.id } })
    expect(trades(c.p)[0]!.args).toMatchObject({ mint: MOON, side: "buy" })
    // Filled: the entry is the book's, no longer under way.
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
    await until(() => c.core.botEntries.under().length === 0)
  })

  test("its fill reaches the Bots tab: the bots topic carries its book, the position open with its exits", async () => {
    const { c, view } = await core()
    await view.request("subscribe", { topics: ["bots"] })
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => (lastOf<BotsTopic>(view, "bots")?.books?.conf?.open.length ?? 0) === 1)
    const book = lastOf<BotsTopic>(view, "bots")!.books!.conf!
    expect(book.open[0]).toMatchObject({ mint: MOON })
    expect(book.recent[0]).toMatchObject({ act: "in" })
    expect(book).toMatchObject({ closed: 0, realizedUsd: 0 })
  })

  test("a wallet that asks every time: a card that waits, saying so; nothing sent", async () => {
    const { c } = await core({ inside: false })
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c.core.journal.rows(), "bot.waiting").length === 1)
    expect(rows(c.core.journal.rows(), "bot.waiting")[0]).toMatchObject({ name: "conf", because: "the embedded wallet asks every time" })
    expect(c.core.cards.list().find((x) => x.origin.bot?.name === "conf")?.state).toBe("awaiting_approval")
    expect(trades(c.p)).toHaveLength(0)
  })

  test("a bot's card nobody pressed is skipped: re-quoted, pressed late or paid from another wallet, nothing is sent", async () => {
    const { c, view } = await core({ inside: false })
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c.core.journal.rows(), "bot.waiting").length === 1)
    const card = c.core.cards.list().find((x) => x.origin.bot?.name === "conf")!
    // Another wallet: the bot pays from the one it was approved on.
    expect((await view.request("cards.requote", { cardId: card.cardId, wallet: "embedded" })).error?.data).toMatchObject({ code: "WALLET_FIXED" })
    // Pressed after its time: closed as expired, refused, and no fresh card.
    card.expiresAt = new Date(0).toISOString()
    const late = await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    expect(late.error?.data).toMatchObject({ code: "BOT_ENTRY_SKIPPED" })
    expect(String(late.error?.message)).toBe('The bot "conf"\'s buy waited past its card and was skipped: it buys again on its next signal. Nothing was sent.')
    expect(card.state).toBe("expired")
    // Re-quoted: refused the same way.
    expect((await view.request("cards.requote", { cardId: card.cardId })).error?.data).toMatchObject({ code: "BOT_ENTRY_SKIPPED" })
    await until(() => rows(c.core.journal.rows(), "bot.entry_ended").length === 1)
    expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval")).toHaveLength(0)
    expect(trades(c.p)).toHaveLength(0)
  })

  test("over the per-trade figure: a card, saying which figure", async () => {
    const { c } = await core()
    await save(c, proposal({ usd: 3 }))
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c.core.journal.rows(), "bot.waiting").length === 1)
    expect(String(rows(c.core.journal.rows(), "bot.waiting")[0]!.because)).toMatch(/^over the embedded wallet's \$2\.00 a trade without a card/)
    expect(trades(c.p)).toHaveLength(0)
  })

  test("over the agent's own limit: refused at proposal, said with its code, and nothing sent", async () => {
    const { c } = await core({ config: { agents: { momentum: { name: "momentum", limits: { perTradeUsd: 1, perDayUsd: 50 } }, swing: { name: "swing", limits: LIMITS } } } })
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c.core.journal.rows(), "bot.entry_ended").length === 1)
    expect(rows(c.core.journal.rows(), "bot.entry_ended")[0]).toMatchObject({ name: "conf", outcome: "refused" })
    expect(rows(c.core.journal.rows(), "card.refused").at(-1)).toMatchObject({ bot: "conf", botAct: "entry", role: "core" })
    expect(trades(c.p)).toHaveLength(0)
  })

  test("the kill switch: no entry is journalled or sent, and the skip says why", async () => {
    const { c, view } = await core()
    await save(c)
    await view.request("kill", {})
    await c.core.botEntries.onTape([signal()])
    await c.core.botEntries.flush()
    expect(rows(c.core.journal.rows(), "bot.entering")).toHaveLength(0)
    expect(rows(c.core.journal.rows(), "bot.skipped").at(-1)).toMatchObject({ name: "conf", reason: "paused" })
    expect(trades(c.p)).toHaveLength(0)
  })

  test("a key Candle held for its cap: the bot's buy is refused before anything is sent", async () => {
    const { c, view } = await core({ candle: { momentum: { tools: { candle_trade: { refuse: "KEY_LIMIT_REACHED", retryable: true, extra: { resetsAt: new Date(Date.now() + 3_600_000).toISOString() } } } } } })
    await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })
    await until(() => trades(c.p).length === 1 && c.core.operations.list().some((op) => op.error?.code === "KEY_LIMIT_REACHED"))
    await save(c)
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c.core.journal.rows(), "bot.entry_ended").length === 1)
    expect(rows(c.core.journal.rows(), "bot.entry_ended")[0]).toMatchObject({ outcome: "refused", code: "KEY_LIMIT_REACHED" })
    expect(trades(c.p)).toHaveLength(1)
  })

  test("typedTrades = instant never applies: over the figures it's still a card", async () => {
    const { c } = await core({ config: { cards: { typedTrades: "instant" } } })
    await save(c, proposal({ usd: 3 }))
    await c.core.botEntries.onTape([signal()])
    await until(() => rows(c.core.journal.rows(), "bot.waiting").length === 1)
    expect(rows(c.core.journal.rows(), "card.approved").filter((r) => r.bot === "conf")).toHaveLength(0)
    expect(trades(c.p)).toHaveLength(0)
  })

  test("two bots of one agent on one token, one signal: two trades, each its own bot's", async () => {
    const { c } = await core({ inside: { ...INSIDE, perDayUsd: 10 } })
    await save(c)
    await save(c, proposal({ name: "conf-two" }))
    await c.core.botEntries.onTape([signal()])
    await until(() => trades(c.p).length === 2)
    expect(rows(c.core.journal.rows(), "card.created").map((r) => r.bot).sort()).toEqual(["conf", "conf-two"])
  })
})

describe("nothing is entered twice", () => {
  test("a restart after a bot entered: the same signal, heard again by the stream's refill, isn't entered again", async () => {
    const { c } = await core()
    await save(c)
    const s = signal()
    await c.core.botEntries.onTape([s])
    await until(() => trades(c.p).length === 1)
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      await until(() => ["pro", "max"].includes(String(again.plans.planFor("momentum").plan)))
      await again.botEntries.onTape([s])
      await Bun.sleep(300)
      expect(rows(again.journal.rows(), "bot.entering")).toHaveLength(1)
      expect(trades(p)).toHaveLength(1)
    } finally {
      await again.stop("test")
    }
  })

  test("a restart between `bot.entering` and its proposal: the entry ends in words, and the signal isn't entered again", async () => {
    const { c } = await core()
    await save(c)
    const s = signal()
    await c.core.botEntries.onTape([s])
    await until(() => trades(c.p).length === 1)
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    // As a core killed before the card was made: the journal ends at the entry.
    const lines = readFileSync(p.journal, "utf8").split("\n").filter(Boolean)
    const at = lines.findIndex((l) => l.includes('"type":"bot.entering"'))
    await Bun.write(p.journal, `${lines.slice(0, at + 1).join("\n")}\n`)
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      await until(() => rows(again.journal.rows(), "bot.entry_ended").length === 1)
      expect(rows(again.journal.rows(), "bot.entry_ended")[0]).toMatchObject({ outcome: "lost", signalId: s.id })
      await again.botEntries.onTape([s])
      await Bun.sleep(300)
      expect(rows(again.journal.rows(), "card.created").filter((r) => r.bot === "conf")).toHaveLength(0)
    } finally {
      await again.stop("test")
    }
  })
})
