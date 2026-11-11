// Every row carries its chain, from Candle's answer: a live trade's card, its journal rows, its operation and its fill,
// on Hood and on Solana; and an operation written before rows carried one gets its mint's family's when it's read.
import { afterAll, afterEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { candleConfigDir } from "./candle-mcp"
import { Operations } from "./execute"
import type { JournalRow } from "./journal"

afterAll(() => cleanupHomes())
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

const HOOD_TOKEN = `0x${"b2".repeat(20)}`
const SOL_TOKEN = "MoonFake11111111111111111111111111111111111"

const MARKETS = [
  { mint: HOOD_TOKEN, symbol: "HTOK", priceUsd: 0.5 },
  { mint: SOL_TOKEN, symbol: "MOON", priceUsd: 0.002 },
]

async function setup() {
  const c = await startTestCore({ env: process.env }, { candle: { momentum: { markets: MARKETS } }, config: { mode: "live" } })
  cores.push(c)
  const view = await c.view()
  const { client: harness } = await c.harness(view)
  const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name, args })).result as { content: { text: string }[] }).content[0]!.text)
  return { c, view, tool }
}

const rowsOf = (c: TestCore, type: string, opId: string) => c.core.journal.rows().filter((r) => r.type === type && r.opId === opId)

test("a trade's card, its journal rows, its operation and its fill all carry the chain Candle's market answer named", async () => {
  const s = await setup()
  for (const [mint, chain] of [
    [HOOD_TOKEN, "hood"],
    [SOL_TOKEN, "solana"],
  ] as const) {
    await s.tool("candle_trade", { side: "buy", mint, amount: chain === "hood" ? "0.001" : "0.01" })
    const card = s.c.core.cards.list().find((x) => x.state === "awaiting_approval" && x.params.mint === mint)
    expect(card?.chain).toBe(chain)
    expect(rowsOf(s.c, "card.created", card!.opId)[0]?.chain).toBe(chain)
    await Bun.sleep(350)
    expect((await s.view.request("cards.approve", { cardId: card!.cardId, cardHash: card!.cardHash })).error).toBeUndefined()
    await until(() => rowsOf(s.c, "operation.succeeded", card!.opId).length > 0, 10_000)
    expect(rowsOf(s.c, "operation.submitting", card!.opId)[0]?.chain).toBe(chain)
    expect(s.c.core.operations.get(card!.opId)?.chain).toBe(chain)
    const fill = rowsOf(s.c, "operation.succeeded", card!.opId)[0]?.fill as { chain?: string; asset?: string } | undefined
    expect(fill?.chain).toBe(chain)
  }
}, 60_000)

test("a sell's done line is what Candle's answer says it brought in, less the fee, not the card's estimate", async () => {
  const s = await setup()
  await s.tool("candle_trade", { side: "sell", mint: SOL_TOKEN, percent: 50 })
  const card = s.c.core.cards.list().find((x) => x.state === "awaiting_approval" && x.params.mint === SOL_TOKEN)!
  await Bun.sleep(350)
  expect((await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).error).toBeUndefined()
  await until(() => rowsOf(s.c, "operation.succeeded", card.opId).length > 0, 10_000)
  const row = rowsOf(s.c, "operation.succeeded", card.opId)[0]!
  const fill = row.fill as { assetRaw?: string; feeRaw?: string; measured?: string }
  const net = (BigInt(fill.assetRaw!) - BigInt(fill.feeRaw ?? "0")).toString()
  const received = (row.result as { received?: string }).received
  expect(received).toMatch(/ SOL$/)
  expect(Number(received!.replace(/^≈/, "").replace(/ SOL$/, "")).toPrecision(6)).toBe((Number(net) / 1e9).toPrecision(6))
  expect((s.c.core.operations.get(card.opId)?.result as { received?: string }).received).toBe(received)
}, 60_000)

test("a percent sell right after a buy Candle's portfolio doesn't show yet is sized from the buy, not refused as nothing held", async () => {
  const s = await setup()
  await s.tool("candle_trade", { side: "buy", mint: HOOD_TOKEN, amount: "0.001" })
  const buy = s.c.core.cards.list().find((x) => x.state === "awaiting_approval" && x.params.mint === HOOD_TOKEN)!
  await Bun.sleep(350)
  expect((await s.view.request("cards.approve", { cardId: buy.cardId, cardHash: buy.cardHash })).error).toBeUndefined()
  await until(() => rowsOf(s.c, "operation.succeeded", buy.opId).length > 0, 10_000)
  const bought = BigInt((rowsOf(s.c, "operation.succeeded", buy.opId)[0]!.fill as { tokensRaw: string }).tokensRaw)
  // The stand-in's portfolio holds no HTOK at all: Candle's read hasn't caught up with the fill. A card, with the percent.
  const answer = await s.tool("candle_trade", { side: "sell", mint: HOOD_TOKEN, percent: 50 })
  expect(answer.error?.code).not.toBe("NOTHING_TO_SELL")
  const first = s.c.core.cards.list().find((x) => x.state === "awaiting_approval" && x.params.mint === HOOD_TOKEN && x.side === "sell")!
  expect(first.display.headline).toBe("SELL 50% of HTOK")
  await s.view.request("cards.reject", { cardId: first.cardId })
  // Now it reads an older, smaller balance: the card's estimate is half of what the buy brought in.
  const script = join(candleConfigDir(s.c.p.stateDir, "momentum"), "fake-candle.json")
  writeFileSync(script, JSON.stringify({ markets: MARKETS, evmWei: "1000000000000000", evmTokens: [{ mint: HOOD_TOKEN, amountRaw: "1000000000000000", decimals: 18 }] }))
  await s.tool("candle_trade", { side: "sell", mint: HOOD_TOKEN, percent: 50 })
  const second = s.c.core.cards.list().filter((x) => x.state === "awaiting_approval" && x.params.mint === HOOD_TOKEN && x.side === "sell").at(-1)!
  expect(second.cardId).not.toBe(first.cardId)
  expect(second.display.sells?.amount).toBeCloseTo(Number(bought / 2n) / 1e18, 6)
}, 60_000)

test("an operation written before rows carried a chain gets its mint's family's when it's read after a restart", async () => {
  const ex = new Operations({
    journal: { append: async () => ({}) },
    pool: { for: () => ({ call: async () => ({ kind: "lost" }) }) },
    now: () => 0,
    schedule: () => () => {},
  } as never)
  const row = (opId: string, mint: string): JournalRow => ({ type: "operation.submitting", seq: 1, at: "2026-11-01T00:00:00.000Z", account: "a", mode: "paper", opId, cardId: `c-${opId}`, kind: "trade", tool: "candle_trade", agent: "momentum", params: { mint, side: "buy" }, cardExpiresAt: 0 }) as unknown as JournalRow
  await ex.rebuild([row("old-hood", HOOD_TOKEN), row("old-sol", SOL_TOKEN), { ...row("new", HOOD_TOKEN), chain: "solana" } as JournalRow]).catch(() => [])
  expect(ex.get("old-hood")?.chain).toBe("hood")
  expect(ex.get("old-sol")?.chain).toBe("solana")
  // A row that carries its chain keeps it, whatever its mint looks like.
  expect(ex.get("new")?.chain).toBe("solana")
})
