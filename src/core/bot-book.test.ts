// A rules bot's own book: its positions from its own fills on each route and on paper, rebuilt from the journal
// with nothing counted twice (rows from before the journal's window included), and the rule by which its exit
// sells only its own on a wallet the person or another bot also trades from.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { type BotPosition, BotPositions } from "./bot-book"
import type { ToolOutcome } from "./candle-mcp"
import type { Card } from "./cards"
import { Operations } from "./execute"
import { Journal } from "./journal"
import { type BotOrigin, botFields, type CardDesk, ToolFace } from "./tool-face"

const MINT = "MoonFake11111111111111111111111111111111111"
const OTHER = "BonkFake11111111111111111111111111111111111"
const TEE = "TeeWa11etFake1111111111111111111111111111111"
const SOL_USD = 200
const T0 = Date.parse("2026-11-06T12:00:00Z")
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Candle's answer to an embedded trade: the swap's amounts and the fee, as the passes recorded them. */
const embeddedAnswer = (a: { amountRaw: string; actualOutRaw?: string; expectedOutRaw: string; feeRaw: string }): ToolOutcome => ({
  kind: "ok",
  result: { clientTradeId: "x", resolved: {}, api: { success: true, status: "executed", signature: "sig", fee: { bps: 25, feeRaw: a.feeRaw }, amounts: { quoteAsset: "sol", amountRaw: a.amountRaw, expectedOutRaw: a.expectedOutRaw, ...(a.actualOutRaw ? { actualOutRaw: a.actualOutRaw } : {}) } } },
})

async function setup(opts: { windowRows?: number; dir?: string; script?: ToolOutcome[]; cli?: unknown[] } = {}) {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), "chrn-botbook-")))
  if (!opts.dir) dirs.push(dir)
  const now = T0
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => now, ...(opts.windowRows ? { windowRows: opts.windowRows } : {}) })
  journals.push(journal)
  const book = new BotPositions({ rows: journal.botRows(), statePath: join(dir, "bot-peaks.json"), schedule: () => () => {}, now: () => now })
  journal.onAppend((row) => book.note(row))
  const script = [...(opts.script ?? [])]
  const cli = [...(opts.cli ?? [])]
  const ops = new Operations({
    journal,
    pool: { for: () => ({ call: async () => script.shift() ?? { kind: "ok", result: {} } }) },
    now: () => now,
    schedule: () => () => {},
    assetUsd: (asset) => (asset === "SOL" ? SOL_USD : undefined),
    cliTrades: { execute: async () => ({ state: "succeeded", result: cli.shift() }), read: async () => ({ found: false, detail: "none" }) },
  })
  /** A bot's trade as its card records it, then run. */
  const trade = async (opId: string, bot: BotOrigin, t: { side: "buy" | "sell"; mint?: string; tee?: boolean; agent?: string }) => {
    const mint = t.mint ?? MINT
    const params = t.tee
      ? { argv: t.side === "buy" ? ["swap", "SOL", mint, "--amount", "0.01", "--wallet", TEE, "--client-trade-id", opId, "--yes"] : ["swap", mint, "SOL", "--percent", "100", "--wallet", TEE, "--client-trade-id", opId, "--yes"], identity: "agent", agent: "momentum", json: true }
      : { mint, side: t.side, amount: "0.01", clientTradeId: opId }
    const agent = t.agent ?? "momentum"
    await journal.append({ type: "card.created", mode: "live", agent, cardId: `card-${opId}`, opId, ...botFields(bot), kind: "trade", tool: t.tee ? "candle_cli" : "candle_trade", wallet: t.tee ? TEE : "embedded", side: t.side, mint })
    const card = {
      cardId: `card-${opId}`,
      opId,
      kind: "trade",
      tool: "candle_trade",
      agent,
      mode: "live",
      params,
      expiresAt: new Date(T0 + 60_000).toISOString(),
      wallet: t.tee ? TEE : "embedded",
      side: t.side,
      ...(t.tee ? { route: "cli" } : {}),
    } as unknown as Card
    return ops.execute(card)
  }
  return { dir, journal, book, ops, trade }
}

const ENTRY = (name = "confluence-small", signal = 101): BotOrigin => ({ name, act: "entry", signal })
const EXIT = (position: string, name = "confluence-small", reason = "take_profit"): BotOrigin => ({ name, act: "exit", position, reason })

describe("a Hood token written in another case", () => {
  test("is the same token to the book: the bot holds it, and a sell that names it in lower case closes the position", async () => {
    const HOOD = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
    const s = await setup({
      script: [
        embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "5000000", actualOutRaw: "4900000", feeRaw: "25000" }),
        embeddedAnswer({ amountRaw: "4900000", expectedOutRaw: "20000000", actualOutRaw: "19000000", feeRaw: "50000" }),
      ],
    })
    await s.trade("op-in", ENTRY(), { side: "buy", mint: HOOD })
    expect(s.book.holds("confluence-small", HOOD.toLowerCase(), "live")).toBe(true)
    // An exit that names no position sells the bot's open position in the token, however the mint is cased.
    await s.trade("op-out", { name: "confluence-small", act: "exit", reason: "bot" }, { side: "sell", mint: HOOD.toLowerCase() })
    expect(s.book.open("confluence-small")).toEqual([])
  })
})

describe("live fills", () => {
  test("an embedded entry and its exit: tokens from the chain, its cost with the fee, and what the exit realized", async () => {
    const s = await setup({
      script: [
        embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "5000000", actualOutRaw: "4900000", feeRaw: "25000" }),
        embeddedAnswer({ amountRaw: "4900000", expectedOutRaw: "20000000", actualOutRaw: "19000000", feeRaw: "50000" }),
      ],
    })
    await s.trade("op-in", ENTRY(), { side: "buy" })
    // The fill is on every trade's success row, not only a bot's: the P&L tab can list them.
    expect(s.journal.rows().find((r) => r.type === "operation.succeeded")?.fill).toMatchObject({ side: "buy", mint: MINT, wallet: "embedded", tokensRaw: "4900000", assetRaw: "10000000", feeRaw: "25000", measured: "chain", assetUsd: SOL_USD })
    const [p] = s.book.open("confluence-small")
    expect(p).toMatchObject({ id: "op-in", bot: "confluence-small", agent: "momentum", wallet: "embedded", mode: "live", mint: MINT, tokensRaw: "4900000", costRaw: "10025000", signal: 101, soldRaw: "0" })
    // 0.010025 SOL at $200.
    expect(p!.costUsd).toBeCloseTo(2.005, 6)
    expect(s.book.holds("confluence-small", MINT, "live")).toBe(true)

    await s.trade("op-out", EXIT("op-in"), { side: "sell" })
    expect(s.book.open("confluence-small")).toEqual([])
    const closed = s.book.get("op-in")!
    // 0.01895 SOL back ($3.79), less $2.005: read before any matcher touches the position.
    expect(s.book.realizedUsd(closed)).toBeCloseTo(3.79 - 2.005, 6)
    expect(typeof closed.closedAt).toBe("string")
    expect(closed.soldRaw).toBe("4900000")
    expect(closed.exits.map(({ id, reason, tokensRaw, proceedsRaw }) => ({ id, reason, tokensRaw, proceedsRaw }))).toEqual([{ id: "op-out", reason: "take_profit", tokensRaw: "4900000", proceedsRaw: "18950000" }])
    // The exit's row read again sells nothing twice, nor does the whole journal read again.
    s.book.note(s.journal.rows().findLast((r) => r.type === "operation.succeeded")!)
    expect(s.book.get("op-in")!.exits).toHaveLength(1)
    for (const row of s.journal.rows()) s.book.note(row)
    expect(s.book.get("op-in")!.exits).toHaveLength(1)
    expect(s.book.get("op-in")!.soldRaw).toBe("4900000")
    expect(s.book.totals("confluence-small", "live")).toMatchObject({ open: 0, closed: 1, valued: true })
    expect(s.book.totals("confluence-small", "paper")).toMatchObject({ open: 0, closed: 0, realizedUsd: 0 })
    // Between two times, by when its exit filled: the away note's P&L over a gap.
    const exitAt = Date.parse(closed.exits[0]!.at)
    expect(s.book.realizedBetween("confluence-small", exitAt - 1, exitAt + 1).usd).toBeCloseTo(3.79 - 2.005, 6)
    expect(s.book.realizedBetween("confluence-small", exitAt - 1, exitAt + 1)).toMatchObject({ exits: 1, valued: true })
    expect(s.book.realizedBetween("confluence-small", exitAt, exitAt + 60_000)).toEqual({ usd: 0, exits: 0, valued: true })
  })

  test("a TEE wallet's entry and exit through the CLI route: the mint from its argv, the amounts at the top", async () => {
    const teeAnswer = (amountRaw: string, out: string, feeRaw: string) => ({ success: true, status: "executed", signature: "sig", fee: { bps: 25, feeRaw }, amounts: { quoteAsset: "sol", amountRaw, expectedOutRaw: out, actualOutRaw: out }, kind: "trade", wallet: TEE })
    const s = await setup({ cli: [teeAnswer("5000000", "800000", "12500"), teeAnswer("800000", "6000000", "15000")] })
    await s.trade("op-tee-in", ENTRY("tee-bot"), { side: "buy", tee: true })
    expect(s.book.open("tee-bot")).toMatchObject([{ wallet: TEE, mint: MINT, tokensRaw: "800000", costRaw: "5012500" }])
    await s.trade("op-tee-out", EXIT("op-tee-in", "tee-bot", "stop"), { side: "sell", tee: true })
    expect(s.book.get("op-tee-in")).toMatchObject({ soldRaw: "800000", exits: [{ reason: "stop", proceedsRaw: "5985000" }] })
  })

  test("someone else's trade, or a fill with no bot on its card, never reaches a bot's book", async () => {
    const s = await setup({ script: [embeddedAnswer({ amountRaw: "1000", expectedOutRaw: "2000", actualOutRaw: "2000", feeRaw: "3" })] })
    await s.journal.append({ type: "card.created", mode: "live", agent: "momentum", cardId: "card-x", opId: "op-x", kind: "trade", tool: "candle_trade", wallet: "embedded", side: "buy", mint: MINT })
    await s.ops.execute({ cardId: "card-x", opId: "op-x", kind: "trade", tool: "candle_trade", agent: "momentum", mode: "live", params: { mint: MINT, side: "buy", amount: "0.01" }, expiresAt: new Date(T0 + 60_000).toISOString(), wallet: "embedded", side: "buy" } as unknown as Card)
    expect(s.journal.rows().at(-1)?.fill).toMatchObject({ tokensRaw: "2000" })
    expect(s.book.of("confluence-small")).toEqual([])
  })

  test("a buy read back by its id: nothing said of what it received, so its exit sells about what it spent bought, never the wallet's whole holding", async () => {
    const s = await setup({ script: [{ kind: "lost", reason: "timeout" }] })
    await s.trade("op-lost", ENTRY(), { side: "buy" })
    // Read back by the same id: Candle's job says what was sent.
    await s.journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op-lost", cardId: "card-op-lost", result: { clientTradeId: "op-lost" }, fill: { side: "buy", mint: MINT, wallet: "embedded", asset: "SOL", assetRaw: "10000000", measured: "none", assetUsd: SOL_USD } })
    const p = s.book.get("op-lost")!
    expect(p.tokensRaw).toBeUndefined()
    expect(p.costUsd).toBeCloseTo(2, 6)
    // No price since its fill: its own can't be worked out, so nothing is sold, and it waits rather than being given up.
    const early = s.book.sellPlan(p, { holding: 1000n, byAmount: true, decimals: 0, label: "MOON" })
    expect(early).toMatchObject({ by: "none", wait: true })
    expect(early.words).toContain("Candle has given no price for MOON since")
    // Candle's first price after it: $0.04, so its $2 bought about 50. The person's own 950 in the wallet stay.
    s.book.notePrice(MINT, 0.04)
    const plan = s.book.sellPlan(p, { holding: 1000n, byAmount: true, decimals: 0, label: "MOON" })
    expect(plan).toMatchObject({ by: "amount", amountRaw: 50n, amount: "50" })
    expect(plan.words).toBe("Candle's answer didn't say what this bot's buy received, so it sells about what its $2.00 bought at Candle's first price after it.")
    // By whole percent of the wallet, rounded down: 5%, never all of it.
    expect(s.book.sellPlan(p, { holding: 1000n, byAmount: false, decimals: 0, label: "MOON" })).toMatchObject({ by: "percent", percent: 5, ownRaw: 50n })
    // Never more than the wallet holds less other bots' own: another bot holds 970 of the wallet's 1,000.
    await s.journal.append({ type: "card.created", mode: "live", agent: "momentum", cardId: "card-o", opId: "op-o", ...botFields(ENTRY("other-bot")), kind: "trade" })
    await s.journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op-o", fill: { side: "buy", mint: MINT, wallet: "embedded", asset: "SOL", tokensRaw: "970", assetRaw: "1", measured: "chain" } })
    expect(s.book.sellPlan(p, { holding: 1000n, byAmount: true, decimals: 0, label: "MOON" })).toMatchObject({ by: "amount", amountRaw: 30n })
    // The wallet holding only what the bot bought: all of it, as before.
    expect(s.book.sellPlan(p, { holding: 1040n, byAmount: true, decimals: 0, label: "MOON" })).toMatchObject({ by: "amount", amountRaw: 50n })
  })
})

describe("paper", () => {
  test("a paper bot's buy and sell through the tool face: the fill and the bot on the paper row, kept apart from live", async () => {
    const s = await setup()
    const answers: Record<string, unknown>[] = [
      { clientTradeId: "p1", api: { success: true, paper: true, side: "buy", mint: MINT, quoteAsset: "sol", amountRaw: "10000000", expectedOutRaw: "500000000", feeRaw: "25000", tokenDecimals: 6 } },
      { clientTradeId: "p2", api: { success: true, paper: true, side: "sell", mint: MINT, quoteAsset: "sol", amountRaw: "500000000", expectedOutRaw: "15000000", feeRaw: "37500", tokenDecimals: 6 } },
    ]
    const desk: CardDesk = { held: () => undefined, propose: async () => ({}) as never }
    const face = new ToolFace({
      pool: { for: () => ({ call: async (): Promise<ToolOutcome> => ({ kind: "ok", result: answers.shift() }) }) },
      cards: desk,
      journal: s.journal,
      mode: () => "paper",
      sizing: {
        markets: { resolve: async (_a: string, mint: string) => ({ ok: true as const, market: { chain: "solana" as const, mint, candleLaunched: false } }) },
        pricing: { asset: async (_a: string, asset: string) => (asset === "SOL" ? { usd: SOL_USD, at: T0, source: "test" } : undefined) },
        spendAsset: () => "SOL" as const,
      },
    })
    await face.call({ clientId: "core", role: "core", agent: "momentum", bot: ENTRY("paper-bot", 7) }, "candle_trade", { mint: MINT, side: "buy", amount: "0.01" })
    const row = s.journal.rows().at(-1)!
    expect(row).toMatchObject({ type: "paper.call", bot: "paper-bot", botAct: "entry", botSignal: 7, fill: { side: "buy", wallet: "paper", tokensRaw: "500000000", tokenDecimals: 6, paper: true, assetUsd: SOL_USD } })
    const [p] = s.book.open("paper-bot", "paper")
    expect(p).toMatchObject({ id: `paper:${row.seq}`, mode: "paper", wallet: "paper", decimals: 6 })
    expect(s.book.entryPriceUsd(p!)).toBeCloseTo((0.010025 * SOL_USD) / 500, 9)
    // Paper sells by the bot's own amount: the key's paper book is shared with the agent's own paper trades.
    expect(s.book.sellPlan(p!, { byAmount: false })).toEqual({ by: "amount", amountRaw: 500000000n, amount: "500" })
    await face.call({ clientId: "core", role: "core", agent: "momentum", bot: EXIT(p!.id, "paper-bot") }, "candle_trade", { mint: MINT, side: "sell", amount: "500" })
    expect(s.book.totals("paper-bot", "paper")).toMatchObject({ open: 0, closed: 1, valued: true })
    expect(s.book.totals("paper-bot", "paper").realizedUsd).toBeCloseTo((0.015 - 0.0000375) * SOL_USD - 0.010025 * SOL_USD, 6)
    expect(s.book.totals("paper-bot", "live")).toMatchObject({ open: 0, closed: 0 })
  })
})

describe("rebuilt from the journal", () => {
  test("a restart rebuilds each position once, however often the same rows are read", async () => {
    const s = await setup({ script: [embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "4900000", actualOutRaw: "4900000", feeRaw: "25000" })] })
    await s.trade("op-in", ENTRY(), { side: "buy" })
    for (const row of s.journal.rows()) s.book.note(row)
    expect(s.book.of("confluence-small")).toHaveLength(1)
    await s.journal.close()
    const again = await setup({ dir: s.dir })
    expect(again.book.open("confluence-small")).toMatchObject([{ id: "op-in", tokensRaw: "4900000", costRaw: "10025000" }])
    for (const row of again.journal.rows()) again.book.note(row)
    expect(again.book.of("confluence-small")).toHaveLength(1)
  })

  test("a position opened before the journal's window is still rebuilt, with its exit", async () => {
    const s = await setup({ script: [embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "4900000", actualOutRaw: "4900000", feeRaw: "25000" })] })
    await s.trade("op-old", ENTRY(), { side: "buy" })
    for (let i = 0; i < 40; i++) await s.journal.append({ type: "view.attached", mode: "live", clientId: `v${i}` })
    await s.journal.close()
    const again = await setup({ dir: s.dir, windowRows: 10 })
    expect(again.journal.rows().some((r) => r.opId === "op-old")).toBe(false)
    expect(again.book.open("confluence-small")).toMatchObject([{ id: "op-old", tokensRaw: "4900000" }])
  })

  test("each open position's peak is kept across a restart, and starts at its entry price", async () => {
    const s = await setup({ script: [embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "4900000", actualOutRaw: "4900000", feeRaw: "25000" })] })
    await s.trade("op-in", ENTRY(), { side: "buy" })
    s.book.noteDecimals(MINT, 6)
    const entry = s.book.entryPriceUsd(s.book.get("op-in")!)!
    expect(entry).toBeCloseTo(2.005 / 4.9, 9)
    s.book.notePrice(MINT, 0.9)
    s.book.notePrice(MINT, 0.7)
    s.book.notePrice(OTHER, 5)
    expect(s.book.get("op-in")!.peakUsd).toBe(0.9)
    s.book.flush()
    await s.journal.close()
    const again = await setup({ dir: s.dir })
    expect(again.book.get("op-in")!.peakUsd).toBe(0.9)
  })
})

describe("a removed bot", () => {
  const twoIn = () =>
    setup({
      script: [
        embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "4900000", actualOutRaw: "4900000", feeRaw: "25000" }),
        embeddedAnswer({ amountRaw: "10000000", expectedOutRaw: "700000", actualOutRaw: "700000", feeRaw: "25000" }),
        embeddedAnswer({ amountRaw: "4900000", expectedOutRaw: "20000000", actualOutRaw: "19000000", feeRaw: "50000" }),
      ],
    })

  test("its open positions end with it: a new bot of the name holds none, and they stay ended across a restart", async () => {
    const s = await twoIn()
    await s.trade("op-in", ENTRY(), { side: "buy" })
    await s.trade("op-in-2", ENTRY("confluence-small", 102), { side: "buy", mint: OTHER })
    await s.trade("op-kept", ENTRY("other-bot"), { side: "buy" })
    expect(s.book.open("confluence-small")).toHaveLength(2)
    await s.journal.append({ type: "bot.removed", mode: "live", agent: "momentum", name: "confluence-small", positions: "leave", by: "view-1" })
    expect(s.book.open("confluence-small")).toEqual([])
    expect(s.book.holds("confluence-small", MINT, "live")).toBe(false)
    expect(s.book.get("op-in")).toMatchObject({ left: true, removed: true })
    // Left unsold, they're no trade of the name's: a bot saved under it later starts from nothing.
    expect(s.book.totals("confluence-small", "live")).toEqual({ open: 0, closed: 0, realizedUsd: 0, valued: true })
    // Another bot's position is its own still.
    expect(s.book.open("other-bot")).toHaveLength(1)
    // What the removed bot left is the person's now: another bot's exit doesn't count it as a bot's own.
    expect(s.book.sellPlan(s.book.get("op-kept")!, { holding: 1_000_000n, byAmount: true, decimals: 0, label: "MOON" })).toMatchObject({ by: "amount" })
    await s.journal.close()
    const again = await setup({ dir: s.dir })
    expect(again.book.open("confluence-small")).toEqual([])
    expect(again.book.get("op-in-2")).toMatchObject({ removed: true })
  })

  test("a buy still on its way as it was removed fills into the wallet, and is no later bot's position", async () => {
    const s = await twoIn()
    await s.journal.append({ type: "card.created", mode: "live", agent: "momentum", cardId: "card-late", opId: "op-late", ...botFields(ENTRY()), kind: "trade", tool: "candle_trade", wallet: "embedded", side: "buy", mint: MINT })
    await s.journal.append({ type: "bot.removed", mode: "live", agent: "momentum", name: "confluence-small", positions: "leave", by: "view-1" })
    await s.journal.append({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op-late", fill: { side: "buy", mint: MINT, wallet: "embedded", asset: "SOL", tokensRaw: "500", assetRaw: "1", measured: "chain" } })
    expect(s.book.open("confluence-small")).toEqual([])
    expect(s.book.get("op-late")).toMatchObject({ removed: true, left: true })
    // A buy by a bot saved under the name afterwards is its own.
    await s.trade("op-new", ENTRY(), { side: "buy" })
    expect(s.book.open("confluence-small").map((p) => p.id)).toEqual(["op-new"])
  })

  test("a sell under way as it was removed still lands on its position, with what it realized", async () => {
    const s = await twoIn()
    await s.trade("op-in", ENTRY(), { side: "buy" })
    await s.trade("op-in-2", ENTRY("confluence-small", 102), { side: "buy", mint: OTHER })
    await s.journal.append({ type: "bot.removed", mode: "live", agent: "momentum", name: "confluence-small", positions: "flatten", by: "view-1" })
    const removedAt = s.book.get("op-in")!.closedAt
    await s.trade("op-out", EXIT("op-in", "confluence-small", "flatten"), { side: "sell" })
    const sold = s.book.get("op-in")!
    expect(sold.exits.map((e) => e.id)).toEqual(["op-out"])
    expect(sold.closedAt).toBe(removedAt!)
    expect(s.book.realizedUsd(sold)).toBeCloseTo(3.79 - 2.005, 6)
    // What it realized stays on the removed bot's position; the name's own book is empty for whoever takes it next.
    expect(s.book.totals("confluence-small", "live")).toEqual({ open: 0, closed: 0, realizedUsd: 0, valued: true })
    expect(s.book.open("confluence-small")).toEqual([])
  })

  test("a new bot of the name starts with an empty book: none of the removed bot's closed positions or realized P&L, across a restart", async () => {
    const s = await twoIn()
    // The earlier bot bought and sold once, long before it was removed.
    await s.trade("op-in", ENTRY(), { side: "buy" })
    await s.trade("op-in-2", ENTRY("confluence-small", 102), { side: "buy", mint: OTHER })
    await s.trade("op-out", EXIT("op-in", "confluence-small", "take_profit"), { side: "sell" })
    expect(s.book.totals("confluence-small", "live")).toMatchObject({ open: 1, closed: 1 })
    expect(s.book.totals("confluence-small", "live").realizedUsd).not.toBe(0)
    await s.journal.append({ type: "bot.removed", mode: "live", agent: "momentum", name: "confluence-small", positions: "leave", by: "view-1" })
    const empty = { open: 0, closed: 0, realizedUsd: 0, valued: true }
    for (const book of [s.book, (await (async () => (await s.journal.close(), await setup({ dir: s.dir })))()).book]) {
      expect(book.of("confluence-small")).toEqual([])
      expect(book.totals("confluence-small", "live")).toEqual(empty)
      expect(book.realizedBetween("confluence-small", 0, Date.now() + 60_000, "live")).toEqual({ usd: 0, exits: 0, valued: true })
      // The earlier bot's positions are still there by id, for the rows that name them.
      expect(book.get("op-in")).toMatchObject({ past: true })
    }
  })
})

describe("selling only its own", () => {
  const position = (over: Partial<BotPosition> = {}): BotPosition => ({
    id: "op-a",
    bot: "a",
    agent: "momentum",
    wallet: "embedded",
    mode: "live",
    mint: MINT,
    asset: "SOL",
    tokensRaw: "1000",
    decimals: 0,
    costRaw: "1",
    costUsd: 1,
    entryAt: new Date(T0).toISOString(),
    soldRaw: "0",
    exits: [],
    ...over,
  })
  const book = (...positions: BotPosition[]) => {
    const b = new BotPositions({ rows: [] })
    for (const p of positions) (b as unknown as { positions: Map<string, BotPosition> }).positions.set(p.id, p)
    return b
  }

  test("holding the wallet's whole balance: 100% where the route sells by percent, its amount where it sells by amount", () => {
    const p = position()
    const b = book(p)
    expect(b.sellPlan(p, { holding: 1000n, byAmount: false })).toEqual({ by: "percent", percent: 100, ownRaw: 1000n })
    expect(b.sellPlan(p, { holding: 1000n, byAmount: true })).toEqual({ by: "amount", amountRaw: 1000n, amount: "1000" })
  })

  test("the person holds more of the token: the percent its own is, rounded down so it never sells theirs", () => {
    const p = position({ tokensRaw: "1000" })
    expect(book(p).sellPlan(p, { holding: 3000n, byAmount: false })).toMatchObject({ by: "percent", percent: 33, ownRaw: 1000n })
  })

  test("the person sold part of the bot's token from the same wallet: it sells what's there, and says the rest went outside", () => {
    const p = position({ tokensRaw: "1000" })
    const plan = book(p).sellPlan(p, { holding: 600n, byAmount: true, label: "MOON" })
    expect(plan).toMatchObject({ by: "amount", amountRaw: 600n, outsideRaw: 400n })
    expect(plan.words).toBe("The wallet held less than this bot's position: 400 MOON sold outside the bot.")
    expect(book(p).sellPlan(p, { holding: 0n, byAmount: true, label: "MOON" })).toEqual({ by: "none", outsideRaw: 1000n, words: "The wallet holds no MOON now: this bot's position, 1000 MOON, was sold outside the bot." })
  })

  test("two bots in one token on one wallet: each sells its own, and a shortfall is shared between them", () => {
    const a = position({ id: "op-a", bot: "a", tokensRaw: "600" })
    const b = position({ id: "op-b", bot: "b", tokensRaw: "400" })
    const both = book(a, b)
    expect(both.sellPlan(a, { holding: 1000n, byAmount: true })).toMatchObject({ by: "amount", amountRaw: 600n })
    expect(both.sellPlan(b, { holding: 1000n, byAmount: false })).toMatchObject({ by: "percent", percent: 40 })
    // 500 left of their 1,000: each sells half its own.
    expect(both.sellPlan(a, { holding: 500n, byAmount: true })).toMatchObject({ amountRaw: 300n, outsideRaw: 300n })
    expect(both.sellPlan(b, { holding: 500n, byAmount: true })).toMatchObject({ amountRaw: 200n, outsideRaw: 200n })
    // Another token, another wallet or paper aren't counted against it.
    const elsewhere = book(a, position({ id: "op-c", bot: "c", mint: OTHER }), position({ id: "op-d", bot: "d", wallet: TEE }), position({ id: "op-e", bot: "e", mode: "paper" }))
    expect(elsewhere.sellPlan(a, { holding: 600n, byAmount: true })).toMatchObject({ amountRaw: 600n })
  })

  test("its own under 1% of what the wallet holds, by whole percent: nothing is sold, and it says why", () => {
    const p = position({ tokensRaw: "5" })
    const plan = book(p).sellPlan(p, { holding: 1000n, byAmount: false, label: "MOON" })
    expect(plan.by).toBe("none")
    expect(plan.words).toContain("under 1% of what the wallet holds")
  })

  test("a position with no decimals known sells by percent even where the route takes an amount", () => {
    const p = position({ decimals: undefined })
    expect(book(p).sellPlan(p, { holding: 2000n, byAmount: true })).toMatchObject({ by: "percent", percent: 50 })
  })

  test("an exit naming no position closes the bot's oldest open one in the token on that wallet", async () => {
    const s = await setup({
      script: [
        embeddedAnswer({ amountRaw: "1000", expectedOutRaw: "10", actualOutRaw: "10", feeRaw: "3" }),
        embeddedAnswer({ amountRaw: "1000", expectedOutRaw: "20", actualOutRaw: "20", feeRaw: "3" }),
        embeddedAnswer({ amountRaw: "10", expectedOutRaw: "900", actualOutRaw: "900", feeRaw: "2" }),
      ],
    })
    await s.trade("op-1", ENTRY("x", 1), { side: "buy" })
    await s.trade("op-2", ENTRY("x", 2), { side: "buy", mint: OTHER })
    await s.trade("op-3", { name: "x", act: "exit", reason: "flatten" }, { side: "sell" })
    expect(s.book.open("x").map((p) => p.id)).toEqual(["op-2"])
    expect(s.book.get("op-1")!.exits[0]).toMatchObject({ reason: "flatten" })
  })
})

describe("a buy read back by its id: sized only from a price near its fill, and never past its quote", () => {
  const MOON_HOLDING = 1_000_000n
  // $10 spent at $0.001: about 10,000 tokens. The wallet holds 1,000,000, the rest of them the person's.
  const readBack = (over: Partial<BotPosition> = {}): BotPosition => ({
    id: "op-rb",
    bot: "a",
    agent: "momentum",
    wallet: "embedded",
    mode: "live",
    mint: MINT,
    asset: "SOL",
    decimals: 0,
    costUsd: 10,
    entryAt: new Date(T0).toISOString(),
    sentAt: new Date(T0).toISOString(),
    soldRaw: "0",
    exits: [],
    ...over,
  })
  const bookAt = (clock: { at: number }, ...positions: BotPosition[]) => {
    const b = new BotPositions({ rows: [], now: () => clock.at })
    for (const p of positions) (b as unknown as { positions: Map<string, BotPosition> }).positions.set(p.id, p)
    return b
  }

  test("a first price more than 60 s after the buy was sent sizes nothing: the bot sells none of the wallet, which is the person's", () => {
    const clock = { at: T0 + 10 * 60_000 }
    const p = readBack()
    const b = bookAt(clock, p)
    b.notePrice(MINT, 0.000001)
    expect(p.markUsd).toBeUndefined()
    const plan = b.sellPlan(p, { holding: MOON_HOLDING, byAmount: true })
    expect(plan).toMatchObject({ by: "none" })
    expect("wait" in plan).toBe(false)
    expect(plan.by === "none" && plan.words).toContain("This bot sells none of it")
  })

  test("within its minute, with no price yet, the sell waits for one", () => {
    const clock = { at: T0 + 20_000 }
    const p = readBack()
    const b = bookAt(clock, p)
    expect(b.awaitingMark()).toEqual([p])
    expect(b.sellPlan(p, { holding: MOON_HOLDING, byAmount: true })).toMatchObject({ by: "none", wait: true })
    clock.at = T0 + 61_000
    expect(b.awaitingMark()).toEqual([])
  })

  test("a first price within 60 s of the send sizes it", () => {
    const clock = { at: T0 + 20_000 }
    const p = readBack()
    const b = bookAt(clock, p)
    b.notePrice(MINT, 0.001)
    expect(p.markUsd).toBe(0.001)
    expect(b.sellPlan(p, { holding: MOON_HOLDING, byAmount: true })).toMatchObject({ by: "amount", amountRaw: 10_000n })
  })

  test("the estimate is capped at the quote's expected out plus the card's slippage bound", () => {
    const clock = { at: T0 + 20_000 }
    // The quote said 10,000 out at a 1% bound: no more than 10,100 can be its own, whatever the price says.
    const p = readBack({ capRaw: "10100" })
    const b = bookAt(clock, p)
    b.notePrice(MINT, 0.0001)
    expect(b.sellPlan(p, { holding: MOON_HOLDING, byAmount: true })).toMatchObject({ by: "amount", amountRaw: 10_100n })
  })

  test("the cap and the send time come from the journal: the card's quoteOutRaw and slippage, and its first operation.submitting", () => {
    const at = (ms: number) => new Date(ms).toISOString()
    const rows = [
      { seq: 1, at: at(T0), type: "card.created", mode: "live", agent: "momentum", opId: "op-rb", bot: "a", botAct: "entry", side: "buy", mint: MINT, quoteOutRaw: "10000", params: { mint: MINT, side: "buy", amount: "0.05", maxSlippageBps: 300 } },
      { seq: 2, at: at(T0 + 1_000), type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-rb" },
      // Read back by its id ten minutes later, after a restart.
      { seq: 3, at: at(T0 + 10 * 60_000), type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op-rb", fill: { side: "buy", mint: MINT, wallet: "embedded", asset: "SOL", assetRaw: "50000000", measured: "none", assetUsd: 200 } },
    ] as unknown as ConstructorParameters<typeof BotPositions>[0]["rows"]
    const clock = { at: T0 + 10 * 60_000 + 5_000 }
    const b = new BotPositions({ rows, now: () => clock.at })
    const p = b.get("op-rb")!
    expect(p).toMatchObject({ sentAt: at(T0 + 1_000), capRaw: "10300" })
    // A price just after the read-back is nine minutes after the send: it doesn't size the buy.
    b.notePrice(MINT, 0.000001)
    expect(p.markUsd).toBeUndefined()
  })
})
