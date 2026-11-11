// A live trade from a wallet that can't cover it, through a core: Candle's INSUFFICIENT_OWNER_BALANCE, before
// anything was broadcast, is refused in plain words that say what to do, in the paying chain's own asset.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"

afterAll(() => cleanupHomes())
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

const MOON = "MoonFake11111111111111111111111111111111111"
const HOOD_TOKEN = "0x00000000000000000000000000000000000b0b03"
const UNFUNDED = { refuse: "INSUFFICIENT_OWNER_BALANCE", status: 402, stage: "not_broadcast" }
const words = (asset: string) => `The wallet paying doesn't hold enough ${asset} for this trade and its fees. Nothing was sent. Send ${asset} to it (its address is in the Wallets pane, ⧉), or trade less.`

async function refusedWith(c: TestCore, args: Record<string, unknown>): Promise<{ code?: string; message?: string }> {
  const view = await c.view("candle-harness")
  const card = (await view.request("cards.propose", { tool: "candle_trade", args, typed: true })).result as { cardId: string; cardHash: string; opId: string }
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
  await until(() => c.core.operations.get(card.opId)?.state === "refused")
  return c.core.operations.get(card.opId)!.error ?? {}
}

describe("a live trade the paying wallet can't cover", () => {
  test("on Solana: SOL, nothing sent, where its address is, or trade less", async () => {
    const c = await startTestCore({}, { candle: { momentum: { tools: { candle_trade: UNFUNDED } } } })
    cores.push(c)
    expect(await refusedWith(c, { mint: MOON, side: "buy", amount: "0.01" })).toMatchObject({ code: "INSUFFICIENT_OWNER_BALANCE", message: words("SOL") })
  })

  test("on Hood, from the embedded wallet there: ETH", async () => {
    const script = { evmWei: "1000000000000000000", ethUsd: 3_000, markets: [{ mint: HOOD_TOKEN, symbol: "HTOK", priceUsd: 0.01 }], tools: { candle_trade: UNFUNDED } }
    const c = await startTestCore({}, { candle: { momentum: script, swing: script } })
    cores.push(c)
    expect(await refusedWith(c, { mint: HOOD_TOKEN, side: "buy", amount: "0.001" })).toMatchObject({ code: "INSUFFICIENT_OWNER_BALANCE", message: words("ETH") })
  })
})
