// The key's request budget in real time: a real core against the fake Candle on
// Free, enforcing Candle's 30 requests a minute per key (refusing RATE_LIMITED past it), with a view
// attached, the token pane linked, two pins, the list and prices running, two live cards proposed and
// approved, and a burst of an agent's reads between them. Nothing may be refused. About 2.5 minutes.
//   bun run test:live src/core/key-budget.live.test.ts
import { afterAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore } from "../../test/core-fixture"
import { candleConfigDir } from "./candle-mcp"

// The fake's own two tokens (test/fake-candle-mcp.ts FAKE_MINTS; importing it would start the fake).
const FAKE_MINTS = { MOON: "MoonFake11111111111111111111111111111111111", PEPE: "PepeFake11111111111111111111111111111111111" }
const PIN_A = "PinAFake11111111111111111111111111111111111"
const PIN_B = "PinBFake11111111111111111111111111111111111"
const RUN_MS = 150_000
let c: TestCore | undefined
afterAll(async () => {
  await c?.close()
  cleanupHomes()
})

test(
  "at Free's 30 a minute: the token pane, two pins, the list and prices run, two cards fill, and Candle refuses nothing",
  async () => {
    // Both of the test home's agents (momentum, swing) on Free: reads any key may make spread across them.
    const free = {
      tier: "free" as const,
      rateLimitPerMin: 30,
      markets: [
        { mint: PIN_A, symbol: "PINA", priceUsd: 1.5 },
        { mint: PIN_B, symbol: "PINB", priceUsd: 0.2 },
      ],
    }
    c = await startTestCore({}, { candle: { momentum: free, swing: free } })
    const view = await c.view()
    await view.request("subscribe", { topics: ["status", "market"] })
    // Two pins, each picked then pinned on a tab of its own, then the linked token.
    for (const [mint, at] of [
      [PIN_A, "Pins A"],
      [PIN_B, "Pins B"],
    ] as const) {
      expect((await view.request("view.link", { mint, chain: "solana" })).error).toBeUndefined()
      expect((await view.request("view.pin", { at })).error).toBeUndefined()
    }
    expect((await view.request("view.link", { mint: FAKE_MINTS.MOON, chain: "solana" })).error).toBeUndefined()
    const { client } = await c.harness()

    const started = Date.now()
    const cards: string[] = []
    const paces: unknown[] = []
    const approveAt = [55_000, 115_000]
    let burstDone = false
    while (Date.now() - started < RUN_MS) {
      const t = Date.now() - started
      if (approveAt.length && t >= approveAt[0]!) {
        approveAt.shift()
        const proposed = await view.request("cards.propose", { tool: "candle_trade", args: { mint: FAKE_MINTS.MOON, side: "buy", amount: "0.01" } })
        expect(proposed.error).toBeUndefined()
        const card = proposed.result as { cardId: string; cardHash: string }
        const approved = await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
        expect(approved.error).toBeUndefined()
        cards.push(card.cardId)
      }
      if (!burstDone && t >= 80_000) {
        burstDone = true
        for (let i = 0; i < 6; i++) await client.request("tools.call", { name: "candle_get_market", args: { chain: "solana", mint: FAKE_MINTS.PEPE } })
      }
      const status = (await view.request("core.status", {})).result as { budget: { pace: object } }
      paces.push(status.budget.pace)
      await Bun.sleep(5_000)
    }

    // Each key's own log: Candle's limit is per key.
    const logOf = (agent: string) =>
      readFileSync(join(candleConfigDir(c!.p.stateDir, agent), "fake-candle-calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; at: number; limited?: boolean })
    const counts: Record<string, Record<string, number>> = {}
    for (const agent of ["momentum", "swing"]) {
      const log = logOf(agent)
      const mine: Record<string, number> = (counts[agent] = {})
      for (const row of log) mine[row.name] = (mine[row.name] ?? 0) + 1
      let worst = 0
      for (const row of log) worst = Math.max(worst, log.filter((r) => r.at > row.at - 60_000 && r.at <= row.at).length)
      console.log(JSON.stringify({ agent, calls: log.length, worstMinute: worst, limited: log.filter((r) => r.limited).length, counts: mine }))
      expect(log.filter((r) => r.limited)).toEqual([])
      expect(worst).toBeLessThanOrEqual(30)
    }
    console.log(JSON.stringify({ lastPace: paces.at(-1) }))
    expect(counts.momentum!.candle_trade).toBe(2)
    expect(cards).toHaveLength(2)
    // The pane said what it slowed: each pin read about once a minute.
    expect(paces.some((p) => JSON.stringify(p).includes('"pins"'))).toBe(true)
  },
  RUN_MS + 60_000,
)
