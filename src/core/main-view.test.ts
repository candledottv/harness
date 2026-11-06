// What only the main view may do: approve a card, type a trade or a candle command, switch the mode, resume after
// the kill switch, set a wallet's autonomy and forget the vault. A popped view (by its name or by the pane it holds), the doctor and the sampler are refused, by
// what each said at hello. A stop stays open to every view: the kill switch from a popped view's footer.
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore } from "../../test/core-fixture"
import { DOCTOR_CLIENT, SAMPLER_CLIENT } from "./client"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())

const STEPS: [string, Record<string, unknown>][] = [
  ["cards.approve", { cardId: "c_none", cardHash: "x" }],
  ["cli.run", { argv: ["portfolio"] }],
  ["mode.set", { mode: "live" }],
  ["resume", {}],
]

test("approving, a typed candle command, the mode and resuming are the main view's; the kill switch is every view's", async () => {
  const c = await startTestCore()
  cores.push(c)
  const main = await c.view()
  const named = await c.view("candle-harness view --pane wallets")
  const holder = await c.view()
  await holder.request("view.pop", { pane: "positions" })
  const doctor = await c.view(DOCTOR_CLIENT)
  const sampler = await c.view(SAMPLER_CLIENT)
  for (const other of [named, holder, doctor, sampler]) {
    for (const [method, params] of STEPS) expect([method, (await other.request(method, params)).error?.data?.code]).toEqual([method, "MAIN_VIEW_ONLY"])
  }
  // Nothing they asked for happened: the mode is as it was.
  expect(c.core.journal.rows().filter((r) => r.type === "mode.changed")).toEqual([])
  // The main view's own calls get past the check (a card that doesn't exist is the card's own refusal).
  expect((await main.request("cards.approve", { cardId: "c_none", cardHash: "x" })).error?.data?.code).not.toBe("MAIN_VIEW_ONLY")
  expect((await main.request("mode.set", { mode: "paper" })).result).toMatchObject({ mode: "paper" })
  // A stop from a popped view goes through, and only the main view resumes.
  expect((await named.request("kill", {})).error).toBeUndefined()
  expect((await named.request("resume", {})).error?.data?.code).toBe("MAIN_VIEW_ONLY")
  expect((await main.request("resume", {})).error).toBeUndefined()
})

test("a typed trade under cards.typedTrades = instant runs only from the main view; autonomy and forget vault are the main view's too", async () => {
  const c = await startTestCore({}, { config: { cards: { typedTrades: "instant" } } })
  cores.push(c)
  await c.core.candleReady
  const main = await c.view()
  const named = await c.view("candle-harness view --pane wallets")
  const holder = await c.view()
  await holder.request("view.pop", { pane: "positions" })
  const doctor = await c.view(DOCTOR_CLIENT)
  const sampler = await c.view(SAMPLER_CLIENT)
  const buy = { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amount: "0.01" }, typed: true }
  const turnOn = { wallet: "embedded", setting: "inside", perTradeUsd: 1, perDayUsd: 5 }
  for (const other of [named, holder, doctor, sampler]) {
    expect((await other.request("cards.propose", buy)).error?.data?.code).toBe("MAIN_VIEW_ONLY")
    expect((await other.request("autonomy.set", turnOn)).error?.data?.code).toBe("MAIN_VIEW_ONLY")
    expect((await other.request("vault.forget", {})).error?.data?.code).toBe("MAIN_VIEW_ONLY")
  }
  // Nothing was proposed, approved or set for them.
  expect(c.core.journal.rows().filter((r) => r.type === "card.proposed" || r.type === "card.approved" || r.type === "autonomy.set")).toEqual([])
  // The main view's typed trade runs at once, approved by the core as instant.
  const ran = (await main.request("cards.propose", buy)).result as { instant?: unknown }
  expect(ran.instant).toBeDefined()
  expect(c.core.journal.rows().filter((r) => r.type === "card.approved").map((r) => (r as { how?: string }).how)).toEqual(["instant"])
})
