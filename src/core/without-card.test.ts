// Trades with no card through a real core: the agent's tool call on a
// wallet that trades inside limits answers with the operation, never APPROVAL_REQUIRED; over a figure it's a
// card that says which; typed trades take the same path, and `cards.typedTrades = "instant"` is never made
// stricter; a turn runs on with no view attached; a lost answer is read back and never sent twice.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { AutonomyTopic } from "./autonomy"
import { candleConfigDir } from "./candle-mcp"

/** The fake Candle's embedded wallet and token (test/fake-candle-mcp.ts). */
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }
// 0.01 SOL at the fake's $150, with Candle's fee: about $1.51, under the $2.00 figure. 0.02 SOL is over it.
const buy = (amount = "0.01") => ({ mint: MOON, side: "buy", amount })

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
const answer = (r: { result?: unknown }) => JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
const tradesSent = (c: TestCore, agent = "momentum") => {
  const file = join(candleConfigDir(c.p.stateDir, agent), "fake-candle-calls.jsonl")
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter((l) => JSON.parse(l).name === "candle_trade").length : 0
}

async function core(config: NonNullable<Parameters<typeof startTestCore>[1]>["config"] = {}, env: Record<string, string> = {}) {
  const c = await startTestCore({ env: { ...process.env, ...env } }, { config })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy"] })
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
  return { c, view }
}

describe("the agent's trade on a wallet that trades inside limits", () => {
  test("inside its figures: answered with the operation and how it ran, never APPROVAL_REQUIRED", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", INSIDE)
    const { client: harness } = await c.harness(view)
    const out = answer(await harness.request("tools.call", { name: "candle_trade", args: buy() }))
    expect(out).toMatchObject({ success: true, state: "succeeded" })
    expect(out.approved).toMatch(/^without a card, inside the embedded wallet's limits \(\$1\.5\d of \$2\.00 a trade, \$1\.5\d of \$4\.00 today\)$/)
    expect(tradesSent(c)).toBe(1)
    const approved = c.core.journal.rows().findLast((r) => r.type === "card.approved")!
    expect(approved).toMatchObject({ how: "inside-limits", wallet: FAKE_WALLET, inside: { perTradeUsd: 2, perDayUsd: 4, usedUsd: 0 } })
    // Journalled before it was sent.
    const rows = c.core.journal.rows()
    expect(rows.findIndex((r) => r.type === "card.approved")).toBeLessThan(rows.findIndex((r) => r.type === "operation.submitting"))
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.usedTodayUsd! > 1.5)
  })

  test("over a figure: APPROVAL_REQUIRED as today, saying which figure sent it to a card", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", INSIDE)
    const { client: harness } = await c.harness(view)
    const out = answer(await harness.request("tools.call", { name: "candle_trade", args: buy("0.02") }))
    expect(out).toMatchObject({ success: false, error: { code: "APPROVAL_REQUIRED" } })
    expect(out.why).toMatch(/^over the embedded wallet's \$2\.00 a trade without a card: this one is \$3\.0\d with Candle's fee$/)
    expect(out.approved).toBeUndefined()
    expect(tradesSent(c)).toBe(0)
  })

  test("a wallet that asks every time: APPROVAL_REQUIRED, with no figure named", async () => {
    const { c, view } = await core()
    const { client: harness } = await c.harness(view)
    const out = answer(await harness.request("tools.call", { name: "candle_trade", args: buy() }))
    expect(out).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } })
    expect(out.why).toBeUndefined()
  })

  test("a turn runs on after the view closes, and its trade still runs without a card", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", INSIDE)
    const { client: harness, registrar } = await c.harness(view)
    registrar.close()
    await Bun.sleep(50)
    const out = answer(await harness.request("tools.call", { name: "candle_trade", args: buy() }))
    expect(out).toMatchObject({ success: true, state: "succeeded" })
    expect(tradesSent(c)).toBe(1)
  })

  test("the kill switch mid-turn: a buy with no card is refused, a sell still runs without one", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", INSIDE)
    const { client: harness } = await c.harness(view)
    await view.request("kill", {})
    const bought = await harness.request("tools.call", { name: "candle_trade", args: buy() })
    expect((bought.result as { isError?: boolean }).isError).toBe(true)
    expect(answer(bought)).toMatchObject({ error: { code: "PAUSED" } })
    const sold = answer(await harness.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "sell", percent: 50 } }))
    expect(sold).toMatchObject({ success: true })
    expect(sold.approved).toBe("without a card: the embedded wallet trades inside limits, and sells aren't limited")
  })

  test("a lost answer: read back under the same id, never sent twice, and the same trade again waits for the person", async () => {
    const { c, view } = await core({}, { CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1" })
    await view.request("autonomy.set", INSIDE)
    const { client: harness } = await c.harness(view)
    const lost = answer(await harness.request("tools.call", { name: "candle_trade", args: buy() }))
    expect(lost).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" }, state: "unknown" })
    expect(lost.approved).toContain("without a card")
    // The same request again while it's unknown: a card, not a second trade.
    const again = answer(await harness.request("tools.call", { name: "candle_trade", args: buy() }))
    expect(again).toMatchObject({ error: { code: "APPROVAL_REQUIRED" }, why: "the same trade is still in flight, so this one waits for you" })
    // Under its own id it's a read of the first.
    const byId = answer(await harness.request("tools.call", { name: "candle_trade", args: { ...buy(), clientTradeId: lost.opId } }))
    expect(byId.opId).toBe(lost.opId)
    await until(() => c.core.operations.get(String(lost.opId))?.state === "succeeded", 10_000)
    expect(tradesSent(c)).toBe(1)
  })
})

describe("typed trades on a wallet that trades inside limits", () => {
  const typed = (amount = "0.01") => ({ tool: "candle_trade", args: buy(amount), typed: true })

  test("inside its figures: run at once as inside-limits, whatever cards.typedTrades says", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", INSIDE)
    const r = (await view.request("cards.propose", typed())).result as { cardId: string; instant?: { kind: string; operation: { state: string } } }
    expect(r.instant).toMatchObject({ kind: "submitted", operation: { state: "succeeded" } })
    expect(c.core.journal.rows().find((row) => row.type === "card.approved" && row.cardId === r.cardId)).toMatchObject({ how: "inside-limits" })
  })

  test("over its figures with typedTrades = card: a card, saying which figure", async () => {
    const { view } = await core()
    await view.request("autonomy.set", INSIDE)
    const r = (await view.request("cards.propose", typed("0.02"))).result as { state: string; instant?: unknown; display: { cardBecause?: string } }
    expect(r.state).toBe("awaiting_approval")
    expect(r.instant).toBeUndefined()
    expect(r.display.cardBecause).toContain("$2.00 a trade without a card")
  })

  test("with typedTrades = instant: runs at once as instant, inside its figures or over them, and never uses them up", async () => {
    const { c, view } = await core({ cards: { typedTrades: "instant" } })
    await view.request("autonomy.set", INSIDE)
    for (const amount of ["0.02", "0.01"]) {
      const r = (await view.request("cards.propose", typed(amount))).result as { cardId: string; instant?: { kind: string } }
      expect(r.instant?.kind).toBe("submitted")
      expect(c.core.journal.rows().find((row) => row.type === "card.approved" && row.cardId === r.cardId)).toMatchObject({ how: "instant" })
    }
    await Bun.sleep(50)
    expect(lastOf<AutonomyTopic>(view, "autonomy")!.wallets.find((w) => w.wallet === FAKE_WALLET)!.usedTodayUsd).toBe(0)
  })
})
