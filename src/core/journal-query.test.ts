import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { Journal, type JournalInput } from "./journal"
import { DEFAULT_KINDS, type JournalEntry, type JournalQuery, journalRows, queryJournal, queryProblem, ROW_KINDS, tookWords } from "./journal-query"
import { sequencedFailure } from "./reconcile"

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
const MOON = "MoonFake11111111111111111111111111111111111"
const T0 = Date.parse("2026-10-30T09:00:00.000Z")

const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A journal on disk, its clock moved by hand. */
async function journalAt(opts: { windowRows?: number; redactor?: Redactor; path?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chrn-jq-"))
  dirs.push(dir)
  const path = opts.path ?? join(dir, "journal.jsonl")
  let clock = T0
  const redactor = opts.redactor ?? new Redactor()
  const open = () => Journal.open({ path, redactor, account: "acct_fake", now: () => clock, ...(opts.windowRows ? { windowRows: opts.windowRows } : {}) })
  const j = await open()
  journals.push(j)
  return {
    j,
    path,
    redactor,
    tick: (ms: number) => (clock += ms),
    add: (row: JournalInput) => j.append(row),
    reopen: async () => {
      await j.close()
      const again = await open()
      journals.push(again)
      return again
    },
  }
}

const deps = (j: Journal, redactor = new Redactor(), slice?: number) => ({ memory: () => j.rows(), tail: j.tail, path: j.path, redactor, symbolOf: (m: string) => (m === JUP ? "JUP" : m === MOON ? "MOON" : undefined), ...(slice ? { slice } : {}) })

/** A whole buy: proposed, approved by Enter, sent and filled, `ms` apart. */
async function buy(t: Awaited<ReturnType<typeof journalAt>>, n: number, opts: { mint?: string; agent?: string; end?: "filled" | "failed" | "rejected" | "withdrawn" | "open"; gap?: number } = {}) {
  const cardId = `card_${n}`
  const opId = `op_${n}`
  const agent = opts.agent ?? "momentum"
  const mint = opts.mint ?? JUP
  await t.add({ type: "card.created", mode: "live", agent, cardId, opId, role: "harness", kind: "trade", tool: "candle_trade", params: { mint, side: "buy", amount: "0.05" }, mint, side: "buy", wallet: "Embed1111", headline: `Buy 0.05 SOL of ${mint === JUP ? "JUP" : "MOON"}`, title: "buy" })
  t.tick(opts.gap ?? 1_200)
  if (opts.end === "open") return
  if (opts.end === "rejected") return void (await t.add({ type: "card.rejected", mode: "live", agent, cardId, opId }))
  if (opts.end === "withdrawn") return void (await t.add({ type: "card.withdrawn", mode: "live", agent, cardId, opId, reason: "kill_switch" }))
  await t.add({ type: "card.approved", mode: "live", agent, cardId, opId, how: "enter", side: "buy" })
  t.tick(5)
  await t.add({ type: "operation.submitting", mode: "live", agent, opId, cardId, kind: "trade", tool: "candle_trade" })
  t.tick(3_100)
  if (opts.end === "failed") return void (await t.add({ type: "operation.failed", mode: "live", agent, opId, error: { code: "SLIPPAGE", message: "Price moved; nothing was sent." } }))
  await t.add({ type: "operation.succeeded", mode: "live", agent, opId })
}

const texts = (es: readonly JournalEntry[]) => es.map((e) => e.text)

describe("the chain filter", () => {
  test("each entry about a token carries its chain; a query for one chain keeps its entries and those about no token", async () => {
    const HOOD = "0x00000000000000000000000000000000000b0B01"
    const t = await journalAt()
    await buy(t, 1)
    t.tick(1_000)
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_h", opId: "op_h", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: HOOD, side: "buy", amount: "0.01" }, mint: HOOD, side: "buy", chain: "hood", wallet: "0xEmbed", title: "buy" })
    t.tick(1_000)
    await t.add({ type: "kill.on", mode: "live", by: "v1" })
    const all = await queryJournal({ kinds: ["trades", "cards", "kill"] }, deps(t.j))
    expect(all.entries.map((e) => [e.mint ? (e.mint === HOOD ? "HOOD" : "JUP") : "none", e.chain])).toEqual([
      ["none", undefined],
      ["HOOD", "hood"],
      ["JUP", "solana"],
    ])
    const hood = await queryJournal({ kinds: ["trades", "cards", "kill"], chain: "hood" }, deps(t.j))
    expect(hood.entries.map((e) => e.chain)).toEqual([undefined, "hood"])
    expect(queryProblem({ chain: "base" })).toBeDefined()
    expect(queryProblem({ chain: "hood" })).toBeUndefined()
  })
})

describe("the kind table", () => {
  test("names every row type the core and engines write", () => {
    // Every `type: "x.y"` literal in the source (the journal's row types, as the build-progress list has them), and the templated ones.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []))
    const src = join(import.meta.dir, "..")
    const found = new Set<string>()
    for (const file of [...files(join(src, "core")), ...files(join(src, "engine"))]) {
      for (const m of readFileSync(file, "utf8").matchAll(/type: "([a-z]+\.[a-z_]+)"/g)) found.add(m[1]!)
    }
    // `card.${state}` and `operation.${op.state}`: the closes and every operation state.
    for (const state of ["rejected", "withdrawn", "expired"]) found.add(`card.${state}`)
    for (const state of ["submitting", "pending", "succeeded", "failed", "refused", "unknown", "abandoned"]) found.add(`operation.${state}`)
    expect(found.size).toBeGreaterThan(60)
    expect([...found].filter((t) => !(t in ROW_KINDS))).toEqual([])
  })

  test("the core's own rows are off by default, every other kind on", () => {
    expect(DEFAULT_KINDS).not.toContain("core")
    expect(DEFAULT_KINDS).toContain("trades")
  })
})

describe("rows in words", () => {
  test("a card's life is one entry: who proposed what, how it was approved, how it ended, how long", async () => {
    const t = await journalAt()
    await buy(t, 1)
    const page = await queryJournal({}, deps(t.j))
    expect(page.entries).toHaveLength(1)
    const [e] = page.entries
    expect(e!.text).toBe("momentum proposed Buy 0.05 SOL of JUP from embedded · approved by Enter · filled in 3.1 s")
    expect(e).toMatchObject({ kind: "trades", tone: "good", agent: "momentum", mint: JUP, symbol: "JUP", mode: "live", seqs: [1, 2, 3, 4] })
    expect(page.more).toBeUndefined()
  })

  test("a harness's sign-in pane, which has no card, is a setup row of its own, never a card from before the journal's start", async () => {
    const t = await journalAt()
    await t.add({ type: "onboarding.harness", mode: "paper", engine: "grok", ticketId: "tk_1", by: "view_1" })
    await t.add({ type: "pane.redeemed", mode: "paper", ticketId: "tk_1", harness: "grok" })
    const page = await queryJournal({ kinds: ["core"] }, deps(t.j))
    expect(page.entries.map((e) => e.text)).toEqual(["setup: grok's sign-in pane started", "setup: grok's own sign-in opened in a pane"])
    expect(page.entries.every((e) => e.kind === "core")).toBe(true)
    // Nothing of it in the person's default view, and nothing waiting.
    expect((await queryJournal({ kinds: [...DEFAULT_KINDS] }, deps(t.j))).entries).toEqual([])
  })

  test("a live sell Candle closed as the key's paper position says nothing live was sold", async () => {
    const t = await journalAt()
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_p", opId: "op_p", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "sell", amount: "5" }, mint: JUP, side: "sell", wallet: "Embed1111", headline: "Sell 5 JUP", title: "sell" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_p", opId: "op_p", how: "enter", side: "sell" })
    await t.add({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op_p", cardId: "card_p" })
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_p", cardId: "card_p", paper: true })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain("not sold live")
    expect(e!.text).not.toContain("filled")
    expect(e!.tone).toBe("warn")
  })

  test("a trigger's card life names the trigger, and its firing, its wait and its hold are rows in words", async () => {
    const t = await journalAt()
    const trig = { trigger: "dip", fireId: "fire_1", part: 0 }
    await t.add({ type: "trigger.fired", mode: "live", agent: "momentum", name: "dip", fireId: "fire_1", class: "event", words: "someone called it from outside" })
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_t", opId: "op_t", role: "core", clientId: "core:triggers", ...trig, kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.006" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy 0.006 SOL of JUP", title: "buy" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_t", opId: "op_t", how: "inside-limits", side: "buy", ...trig })
    await t.add({ type: "trigger.waiting", mode: "live", agent: "momentum", name: "dip", fireId: "fire_2", cardId: "card_u", words: "Buy 0.02 SOL of JUP waits for you: the embedded wallet asks every time" })
    await t.add({ type: "trigger.held", mode: "live", agent: "momentum", name: "dip", fireId: "fire_3", reason: "paused", words: "the kill switch holds its buy, so it wasn't sent" })
    const texts = (await queryJournal({ kinds: ["trades", "agents"] }, deps(t.j))).entries.map((e) => e.text)
    expect(texts).toEqual([
      `trigger "dip": the kill switch holds its buy, so it wasn't sent`,
      `trigger "dip": Buy 0.02 SOL of JUP waits for you: the embedded wallet asks every time`,
      `trigger "dip" proposed Buy 0.006 SOL of JUP from embedded · without a card, inside its wallet's limits · approved, not sent yet`,
      `trigger "dip" fired: someone called it from outside`,
    ])
  })

  test("a bot's rows are the bots kind, in words: its card life says the bot's, its fill without a card, and a paper bot's are paper", async () => {
    const t = await journalAt()
    const origin = { bot: "conf", botAct: "entry", botSignal: 7 }
    // The Candle Harness is live; the bot trades on paper.
    await t.add({ type: "bot.entering", mode: "live", agent: "momentum", name: "conf", signalId: 7, mint: JUP, usd: 2, botMode: "paper", words: "buys $2.00 of JUP on a confluence signal at 09:00, on paper" })
    await t.add({ type: "paper.call", mode: "paper", agent: "momentum", role: "core", ...origin, tool: "candle_trade", args: { mint: JUP, side: "buy", amountUsd: 2 }, isError: false, answer: JSON.stringify({ api: { paper: true, side: "buy", mint: JUP, quoteAsset: "sol", amountRaw: "10000000", tokenAmount: 5 } }) })
    // A live bot's exit, sold without a card.
    const exit = { bot: "live-one", botAct: "exit", botPosition: "op_1", botReason: "take_profit" }
    await t.add({ type: "bot.exiting", mode: "live", agent: "momentum", name: "live-one", position: "op_1", mint: JUP, reason: "take_profit", botMode: "live", words: "sells 100 JUP: a take profit at +50%" })
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_x", opId: "op_x", role: "core", ...exit, kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "sell", amount: "100" }, mint: JUP, side: "sell", wallet: "Embed1111", headline: "Sell 100 JUP", title: "sell" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_x", opId: "op_x", how: "bot-exit", side: "sell", ...exit })
    await t.add({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op_x", cardId: "card_x", kind: "trade", tool: "candle_trade" })
    t.tick(3_000)
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_x", cardId: "card_x" })
    await t.add({ type: "bot.skipped", mode: "live", agent: "momentum", name: "conf", reason: "slot_full", count: 4, words: "4 signals, the last because every slot is full" })
    const all = (await queryJournal({}, deps(t.j))).entries
    expect(all.map((e) => [e.kind, e.mode, e.text])).toEqual([
      ["bots", "live", 'the bot "conf" skipped 4 signals, the last because every slot is full'],
      ["bots", "live", 'the bot "live-one" proposed Sell 100 JUP from embedded · without a card, as its bot\'s exit · filled in 3.0 s'],
      ["bots", "live", 'the bot "live-one" sells 100 JUP: a take profit at +50%'],
      ["bots", "paper", 'paper buy JUP by the bot "conf" (as momentum): ≈5 JUP at the quoted price'],
      ["bots", "paper", 'the bot "conf" buys $2.00 of JUP on a confluence signal at 09:00, on paper'],
    ])
    // The trades chip alone leaves them out: a busy bot would bury your own trades.
    expect((await queryJournal({ kinds: ["trades"] }, deps(t.j))).entries).toEqual([])
  })

  test("a code bot's trade says it's a code bot's and gives its request id; what it says and its process are the bots kind", async () => {
    const t = await journalAt()
    const origin = { bot: "grid", botAct: "entry", botKind: "code", botRequest: "buy-0042" }
    await t.add({ type: "bot.request", mode: "live", kind: "code", agent: "momentum", name: "grid", request: "buy-0042", side: "buy", mint: JUP, usd: 1, botMode: "live", wallet: "embedded", words: "buys $1.00 of JUP" })
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_c", opId: "op_c", role: "core", ...origin, kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amountUsd: 1 }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy $1.00 of JUP", title: "buy" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_c", opId: "op_c", how: "inside-limits", side: "buy", ...origin })
    await t.add({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op_c", cardId: "card_c", kind: "trade", tool: "candle_trade" })
    t.tick(2_000)
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_c", cardId: "card_c" })
    await t.add({ type: "bot.event", mode: "live", kind: "code", agent: "momentum", name: "grid", word: "needs-a-look", text: "spread above 8%" })
    const all = (await queryJournal({}, deps(t.j))).entries
    expect(all.map((e) => [e.kind, e.text])).toEqual([
      ["bots", 'the code bot "grid" says "needs-a-look": spread above 8%'],
      ["bots", 'the code bot "grid" proposed Buy $1.00 of JUP from embedded · its request buy-0042 · without a card, inside its wallet\'s limits · filled in 2.0 s'],
      ["bots", 'the code bot "grid" buys $1.00 of JUP'],
    ])
  })

  test("a bot's entry written before its token had a name says the name known now; paper amounts as the screen rounds them", async () => {
    const t = await journalAt()
    await t.add({ type: "bot.entering", mode: "live", agent: "momentum", name: "conf", signalId: 8, mint: JUP, usd: 2, botMode: "paper", words: "buys $2.00 of JUPy…DvCN on a confluence signal at 09:00, on paper" })
    await t.add({ type: "paper.call", mode: "paper", agent: "momentum", role: "core", bot: "conf", botAct: "entry", botSignal: 8, tool: "candle_trade", args: { mint: JUP, side: "buy", amountUsd: 2 }, isError: false, answer: JSON.stringify({ api: { paper: true, side: "buy", mint: JUP, quoteAsset: "sol", amountRaw: "10000000", tokenAmount: 17479.380519 } }) })
    const texts = (await queryJournal({}, deps(t.j))).entries.map((e) => e.text)
    expect(texts).toEqual(['paper buy JUP by the bot "conf" (as momentum): ≈17,479 JUP at the quoted price', 'the bot "conf" buys $2.00 of JUP on a confluence signal at 09:00, on paper'])
  })

  test("a bot's exit the core re-sent after a restart says the Candle Harness re-sent it, never the person", async () => {
    const t = await journalAt()
    const exit = { bot: "live-one", botAct: "exit", botPosition: "op_1", botReason: "stop" }
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_x", opId: "op_x", role: "core", ...exit, kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "sell", amount: "100" }, mint: JUP, side: "sell", wallet: "Embed1111", headline: "Sell 100 JUP", title: "sell" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_x", opId: "op_x", how: "bot-exit", side: "sell", ...exit })
    await t.add({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op_x", cardId: "card_x", kind: "trade", tool: "candle_trade", botExit: true })
    await t.add({ type: "operation.unknown", mode: "live", agent: "momentum", opId: "op_x", cardId: "card_x", reason: "core_restarted" })
    await t.add({ type: "operation.resend", mode: "live", agent: "momentum", opId: "op_x", by: "core" })
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_x", cardId: "card_x" })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain("· re-sent by the Candle Harness once: the core restarted mid-sell and Candle had no record of it ·")
    expect(e!.text).toContain("· filled in")
  })

  test("an operation the core reads no further says what its error says, never that it's being read back", async () => {
    const t = await journalAt()
    const job = { status: "failed", errorCode: "SWAP_FAILED", operation: { legs: [{ kind: "approve", status: "confirmed" }, { kind: "trade", status: "failed" }] } }
    const error = sequencedFailure(job)!
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_h", opId: "op_h", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.006" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy 0.006 ETH of JUP", title: "buy" })
    await t.add({ type: "operation.unknown", mode: "live", agent: "momentum", opId: "op_h", cardId: "card_h", result: job, error })
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_b", opId: "op_b", role: "harness", kind: "bridge", tool: "candle_bridge", params: { from: "SOL", to: "ETH", amount: "0.5" }, headline: "BRIDGE 0.5 SOL → ETH", title: "bridge" })
    await t.add({ type: "operation.unknown", mode: "live", agent: "momentum", opId: "op_b", cardId: "card_b", error: { code: "BRIDGE_PAST_TWO_HOURS", message: "No result after two hours. Check the balance of bot-1-h." } })
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_o", opId: "op_o", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.006" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy 0.006 SOL of JUP", title: "buy" })
    await t.add({ type: "operation.unknown", mode: "live", agent: "momentum", opId: "op_o", cardId: "card_o", reason: "no answer" })
    const texts = (await queryJournal({}, deps(t.j))).entries.map((e) => e.text)
    const [hood, bridge, open] = ["Buy 0.006 ETH", "BRIDGE", "Buy 0.006 SOL"].map((h) => texts.find((x) => x.includes(h))!)
    expect(hood).not.toContain("being read back")
    expect(hood).toContain("may have filled")
    expect(bridge).not.toContain("being read back")
    expect(bridge).toContain("Check the balance of bot-1-h")
    expect(open).toContain("no answer: being read back")
  })

  test("a trade the core ran without a card says so, never that the person approved it", async () => {
    const t = await journalAt()
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_9", opId: "op_9", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.006" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy 0.006 SOL of JUP", title: "buy" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_9", opId: "op_9", how: "inside-limits", side: "buy" })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain("· without a card, inside its wallet's limits")
  })

  test("a trade a wallet's figure sent to the person says which figure", async () => {
    const t = await journalAt()
    const words = "over the embedded wallet's $1.50 a trade without a card: this one is $1.75 with Candle's fee"
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_8", opId: "op_8", role: "view", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.018" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy $1.75 of JUP", title: "buy" })
    await t.add({ type: "card.because", mode: "live", agent: "momentum", cardId: "card_8", opId: "op_8", words })
    t.tick(25_000)
    await t.add({ type: "card.rejected", mode: "live", agent: "momentum", cardId: "card_8", opId: "op_8" })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain(`· a card: ${words} · rejected after 25 s`)
  })

  test("a wallet's autonomy, set by the person or narrowed by the agent's card", async () => {
    const t = await journalAt()
    const ask = { setting: "ask" }
    const inside = { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }
    await t.add({ type: "autonomy.set", mode: "live", wallet: "WalletFake111111111111111111111111111111111", walletName: "embedded", from: ask, to: inside, by: "v1", how: "view" })
    t.tick(1_000)
    await t.add({ type: "autonomy.set", mode: "live", agent: "momentum", wallet: "WalletFake111111111111111111111111111111111", walletName: "embedded", from: inside, to: ask, by: "card", how: "card", opId: "op_1" })
    const page = await queryJournal({}, deps(t.j))
    expect(page.entries.map((e) => [e.kind, e.text])).toEqual([
      ["cards", "momentum's card, which you approved, set the embedded wallet to ask every time (it traded inside limits · $1.00 a trade, $5.00 a day without a card)"],
      ["cards", "you set the embedded wallet to trade inside limits · $1.00 a trade, $5.00 a day without a card (it asked every time)"],
    ])
  })

  test("how each ends", async () => {
    const t = await journalAt()
    await buy(t, 1, { end: "failed" })
    await buy(t, 2, { end: "rejected", gap: 12_000 })
    await buy(t, 3, { end: "withdrawn" })
    await buy(t, 4, { end: "open" })
    expect(texts((await queryJournal({}, deps(t.j))).entries)).toEqual([
      "momentum proposed Buy 0.05 SOL of JUP from embedded · awaiting approval",
      "momentum proposed Buy 0.05 SOL of JUP from embedded · withdrawn (kill switch)",
      "momentum proposed Buy 0.05 SOL of JUP from embedded · rejected after 12 s",
      "momentum proposed Buy 0.05 SOL of JUP from embedded · approved by Enter · failed: SLIPPAGE: Price moved; nothing was sent.",
    ])
  })

  test("a turn is one entry; other rows say what Activity says, and the core's say what they are", async () => {
    const t = await journalAt()
    await t.add({ type: "core.started", mode: "live", coreVersion: "0.0.0", agents: ["momentum"] })
    await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: "t_1", engine: "claude-code" })
    t.tick(8_200)
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_1", user: "what about JUP?", reply: "JUP is steady.", tools: ["candle_get_token", "hacc_token"], outcome: "done" })
    await t.add({ type: "kill.on", mode: "live" })
    await t.add({ type: "view.picked", mode: "live", mint: MOON, symbol: "MOON", from: "feed, by a click" })
    const entries = (await queryJournal({}, deps(t.j))).entries
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ["view", "you picked MOON (feed, by a click)"],
      ["kill", "kill switch on: buys paused"],
      ["agents", 'you asked momentum: "what about JUP?" · answered in 8.2 s · 2 tool calls'],
      ["core", "the core started in live mode, version 0.0.0, with momentum"],
    ])
  })

  test("a woken turn names its trigger, never the person; a card from it says what woke it", async () => {
    const t = await journalAt()
    await t.add({ type: "trigger.woke", mode: "live", agent: "momentum", name: "conf", fireId: "fire_1", woke: "momentum", turnId: "t_3", words: "a confluence signal on BONK at 14:02" })
    await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: "t_3", engine: "claude-code", woken: ["conf"], fireIds: ["fire_1"] })
    t.tick(5_000)
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_3", user: 'woken by the trigger "conf": a confluence signal on BONK at 14:02', reply: "Bought.", tools: [], outcome: "done", woken: ["conf"], fireIds: ["fire_1"] })
    await t.add({ type: "trigger.wake_skipped", mode: "live", agent: "momentum", name: "conf", fireId: "fire_2", woke: "momentum", words: "momentum was woken 4 times in the last hour, its most (wake.perHour = 4), so it wasn't woken" })
    const entries = (await queryJournal({}, deps(t.j))).entries
    expect(entries.map((e) => e.text)).toEqual([
      'trigger "conf": momentum was woken 4 times in the last hour, its most (wake.perHour = 4), so it wasn\'t woken',
      'trigger "conf" woke momentum · answered in 5.0 s',
      'trigger "conf" woke momentum: a confluence signal on BONK at 14:02',
    ])
  })

  test("what you asked shows its addresses short, as replies do, so the quote keeps its words", async () => {
    const t = await journalAt()
    await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: "t_2", engine: "claude-code" })
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_2", user: `Check MOON (${MOON}) then buy $1`, reply: "Done.", tools: [], outcome: "done" })
    const [entry] = (await queryJournal({}, deps(t.j))).entries
    expect(entry!.text).toContain(`"Check MOON (${MOON.slice(0, 4)}…${MOON.slice(-4)}) then buy $1"`)
  })

  test("how long, in words", () => {
    expect([tookWords(40), tookWords(4_300), tookWords(12_400), tookWords(125_000), tookWords(11_400_000)]).toEqual(["under 0.1 s", "4.3 s", "12 s", "2m 05s", "3h 10m"])
  })
})

describe("the search", () => {
  test("words, kinds, agent, token and time", async () => {
    const t = await journalAt()
    await buy(t, 1, { mint: JUP })
    t.tick(60_000)
    await buy(t, 2, { mint: MOON, agent: "swing", end: "failed" })
    await t.add({ type: "client.attached", mode: "live", clientId: "v1", role: "view", clientName: "view" })
    const q = async (query: JournalQuery) => texts((await queryJournal(query, deps(t.j))).entries)
    expect(await q({ text: "jup FILLED" })).toEqual(["momentum proposed Buy 0.05 SOL of JUP from embedded · approved by Enter · filled in 3.1 s"])
    expect(await q({ text: "slippage" })).toHaveLength(1)
    expect(await q({ agent: "swing" })).toHaveLength(1)
    expect(await q({ mint: JUP })).toHaveLength(1)
    expect(await q({ kinds: [...DEFAULT_KINDS] })).toHaveLength(2)
    expect(await q({ kinds: ["core"] })).toEqual(["a view attached"])
    expect(await q({ from: T0 + 30_000 })).toHaveLength(2)
    expect(await q({ to: T0 + 30_000 })).toHaveLength(1)
    expect(await q({ text: "nothing like this" })).toEqual([])
  })

  test("a match the words don't show says where it was found (rows listed for \"stake\" with no stake in sight)", async () => {
    const t = await journalAt()
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_1", user: "What tools do you have?", reply: "I can read markets, trade, and add a stake in CNDL for you.", tools: ["harness_view"], outcome: "done" })
    await buy(t, 1, { mint: JUP })
    const stake = (await queryJournal({ text: "stake" }, deps(t.j))).entries
    expect(stake.map((e) => e.matched)).toEqual(["its reply: …markets, trade, and add a stake in CNDL for you."])
    // Words that show leave no note; nor does a page that wasn't searched.
    expect((await queryJournal({ text: "jup filled" }, deps(t.j))).entries.map((e) => e.matched)).toEqual([undefined])
    expect((await queryJournal({}, deps(t.j))).entries.every((e) => e.matched === undefined)).toBe(true)
  })

  test("a query's arguments are checked", () => {
    expect(queryProblem({ kinds: ["trades", "nope"] })).toContain("kinds")
    expect(queryProblem({ before: "not a cursor" })).toContain("before")
    expect(queryProblem({ text: "jup", limit: 10 })).toBeUndefined()
  })
})

describe("pages, over memory and the file", () => {
  /** 120 entries: buys with turns and core rows between, and a card whose life spans others. */
  async function busy(windowRows?: number) {
    const t = await journalAt(windowRows ? { windowRows } : {})
    for (let n = 0; n < 40; n++) {
      await buy(t, n, { mint: n % 2 ? JUP : MOON })
      await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: `t_${n}` })
      t.tick(500)
      await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: `t_${n}`, user: `question ${n}`, reply: "ok", tools: [], outcome: "done" })
      await t.add({ type: "mode.changed", mode: n % 2 ? "live" : "paper" })
    }
    // A long card: proposed, then 30 entries' worth of rows, then approved and filled.
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "long", opId: "op_long", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP }, mint: JUP, headline: "Sell 50% of JUP", wallet: "Embed1111" })
    for (let n = 0; n < 30; n++) await t.add({ type: "kill.off", mode: "live" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "long", opId: "op_long", how: "click" })
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_long" })
    return t
  }

  async function allPages(j: Journal, query: JournalQuery, slice?: number) {
    const out: JournalEntry[] = []
    let before: string | undefined
    let pages = 0
    do {
      const page = await queryJournal({ ...query, ...(before ? { before } : {}) }, deps(j, new Redactor(), slice))
      out.push(...page.entries)
      before = page.more
      pages++
    } while (before && pages < 500)
    return { out, pages }
  }

  test("every entry comes once, newest first, whatever the page size, and a card's life that spans a page comes whole", async () => {
    const t = await busy()
    const whole = (await allPages(t.j, { limit: 100 })).out
    expect(whole).toHaveLength(40 * 3 + 1 + 30)
    expect(whole.find((e) => e.id === String(whole.find((x) => x.text.includes("Sell 50%"))!.seq))!.text).toBe("momentum proposed Sell 50% of JUP from embedded · approved by a click · filled in under 0.1 s")
    for (const limit of [1, 3, 7, 50]) {
      const { out } = await allPages(t.j, { limit })
      expect(out.map((e) => e.id)).toEqual(whole.map((e) => e.id))
      expect(out.map((e) => e.text)).toEqual(whole.map((e) => e.text))
    }
  })

  test("rows older than memory's are read from the file, in small slices, the same", async () => {
    const t = await busy()
    const inMemory = (await allPages(t.j, { limit: 9 })).out
    const again = await t.reopen()
    expect(again.tail.seq).toBe(1)
    // Reopened with room for 25 rows: the rest are on disk only.
    await again.close()
    const t2 = { j: await Journal.open({ path: t.path, redactor: new Redactor(), account: "acct_fake", now: Date.now, windowRows: 25 }) }
    journals.push(t2.j)
    expect(t2.j.tail.seq).toBeGreaterThan(100)
    for (const slice of [300, 4096, 128 * 1024]) {
      const { out } = await allPages(t2.j, { limit: 9 }, slice)
      expect(out.map((e) => e.text)).toEqual(inMemory.map((e) => e.text))
    }
    // A search that matches nothing reads the whole file, and says how far back.
    const none = await queryJournal({ text: "zzzz" }, deps(t2.j, new Redactor(), 300))
    expect(none.entries).toEqual([])
    expect(none.more).toBeUndefined()
    expect(none.oldest).toBe(new Date(T0).toISOString())
  })

  test("a page stops at 64 KB", async () => {
    const t = await journalAt()
    // Cards read back many times: each entry carries every row's seq.
    for (let n = 0; n < 60; n++) {
      await buy(t, n)
      for (let c = 0; c < 200; c++) await t.add({ type: "operation.check", mode: "live", agent: "momentum", opId: `op_${n}`, outcome: "unclear" })
    }
    const page = await queryJournal({ limit: 100 }, deps(t.j))
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(64 * 1024)
    expect(page.entries.length).toBeLessThan(60)
    expect(page.more).toBeDefined()
    const next = await queryJournal({ limit: 100, before: page.more! }, deps(t.j))
    expect(page.entries.length + next.entries.length).toBe(60)
    // 12,000 rows appended one at a time first: on a shared runner's disk that takes more than the default 5 s.
  }, 30_000)

  test("a newer query from the same view stops this one at its next slice", async () => {
    const t = await busy(10)
    let current = true
    const page = queryJournal({ text: "zzzz" }, { ...deps(t.j, new Redactor(), 300), current: () => current })
    current = false
    expect(await page).toMatchObject({ entries: [], superseded: true })
  })
})

describe("what leaves", () => {
  test("passes the redactor again, and the details read a card's rows as recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrn-jq-"))
    dirs.push(dir)
    const path = join(dir, "journal.jsonl")
    // A row from before the key was known, as a copied state folder could hold, and a torn line.
    const secret = ["cndl", "live", "z".repeat(40)].join("_")
    writeFileSync(path, `${JSON.stringify({ seq: 1, at: new Date(T0).toISOString(), type: "cli.refused", account: "acct_fake", mode: "live", command: "keys list", message: `used ${secret}` })}\n{"seq":2,"at`)
    const redactor = new Redactor()
    redactor.add(secret)
    const t = await journalAt({ path, redactor, windowRows: 1 })
    await buy(t, 1)
    const before = readFileSync(path)
    const page = await queryJournal({ limit: 100 }, deps(t.j, redactor, 64))
    expect(JSON.stringify(page)).not.toContain(secret)
    expect(page.entries.map((e) => e.kind)).toEqual(["trades", "core", "cards"])
    const rows = await journalRows(page.entries[0]!.seqs, deps(t.j, redactor))
    expect(rows.rows.map((r) => r.type)).toEqual(["card.created", "card.approved", "operation.submitting", "operation.succeeded"])
    const old = await journalRows([1], deps(t.j, redactor, 64))
    expect(old.rows).toHaveLength(1)
    expect(JSON.stringify(old)).not.toContain(secret)
    // Reading writes nothing.
    expect(readFileSync(path).equals(before)).toBe(true)
    appendFileSync(path, "")
  })
})
