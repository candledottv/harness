// The desk's memory of requests, on its own: an ended request let go from memory keeps its id, so the bot is never
// told nothing was sent for a trade that filled, and the id is never taken for a new trade.
import { expect, test } from "bun:test"
import { CodeBotDesk, type CodeBotDeskDeps } from "./bot-protocol"
import type { JournalRow } from "./journal"

const DAY = 86_400_000
const MOON = "MoonFake11111111111111111111111111111111111"

function desk(now: number, endedKept: number, codeBots: Record<string, unknown> = {}) {
  const never = () => {
    throw new Error("not reached")
  }
  const deps = {
    codeBots: { entry: never, runs: never, approvedVersion: never, heldBy: never, viewOf: never, ...codeBots },
    positions: { open: never, of: never, get: () => undefined, sellPlan: never, noteDecimals: never, remainingRaw: never, entryPriceUsd: never, totals: never, realizedUsd: never },
    journal: { append: async () => {} },
    now: () => now,
    paused: () => false,
    room: () => undefined,
    failed: { held: () => false, words: () => "" },
    send: never,
    holding: never,
    decimalsOf: () => undefined,
    byAmount: () => false,
    market: never,
    card: () => undefined,
    nameOf: () => "MOON",
    tell: () => {},
    endedKept,
  } as unknown as CodeBotDeskDeps
  return new CodeBotDesk(deps)
}

/** A paper buy recorded and filled, as the journal keeps it. */
function filledBuy(request: string, at: number, seq: number): JournalRow[] {
  const iso = new Date(at).toISOString()
  return [
    { type: "bot.request", mode: "paper", kind: "code", agent: "momentum", name: "grid", request, side: "buy", mint: MOON, usd: 1, botMode: "paper", words: "buys $1.00 of MOON, on paper", seq, at: iso },
    { type: "paper.call", mode: "paper", agent: "momentum", bot: "grid", botKind: "code", botAct: "entry", botRequest: request, tool: "candle_trade", isError: false, seq: seq + 1, at: iso },
  ] as unknown as JournalRow[]
}

test("a request that filled before today and was let go from memory is said as ended, never as unknown, and its id isn't taken again", async () => {
  const now = Date.now()
  const d = desk(now, 2)
  const ids = ["req_old_0001", "req_old_0002", "req_old_0003"]
  await d.rebuild(ids.flatMap((id, i) => filledBuy(id, now - 2 * DAY + i * 1000, 10 + i * 2)))
  // The newest two are kept whole.
  expect(d.status("grid", { request: ids[2]! }).state).toBe("filled")
  expect(d.status("grid", { request: ids[1]! }).state).toBe("filled")
  // The oldest was let go: its id is remembered, so it isn't "nothing was sent".
  const old = d.status("grid", { request: ids[0]! })
  expect(old.state).toBe("ended")
  expect(old.words).toContain("the Journal has what became of it")
  expect(old.words).not.toContain("nothing was sent")
  // Asked again as a trade, on any side, it's refused before anything else is read.
  for (const ask of [() => d.buy("grid", { request: ids[0]!, mint: MOON, amountUsd: 1 }), () => d.sell("grid", { request: ids[0]!, mint: MOON }), () => d.swap("grid", { request: ids[0]!, from: "SOL", to: "USDC", amount: "1" })]) {
    const refusal = await ask().then(
      () => undefined,
      (e: { code?: string }) => e.code,
    )
    expect(refusal).toBe("REQUEST_SPENT")
  }
  // Another bot's same id, and an id never seen, are still unknown.
  expect(d.status("other", { request: ids[0]! }).state).toBe("unknown")
  expect(d.status("grid", { request: "req_never_01" }).state).toBe("unknown")
})

test("requests that ended today stay whole in memory past the kept figure", async () => {
  const now = Date.now()
  const d = desk(now, 1)
  const ids = ["req_new_0001", "req_new_0002", "req_new_0003"]
  await d.rebuild(ids.flatMap((id, i) => filledBuy(id, now - i, 10 + i * 2)))
  for (const id of ids) expect(d.status("grid", { request: id }).state).toBe("filled")
})

test("a code bot saved under a removed bot's name starts its day at zero, with ids of its own", async () => {
  const now = Date.now()
  const d = desk(now, 100, { approvedVersion: () => ({ run: { mode: "paper" } }) })
  const removed = { type: "bot.removed", mode: "paper", kind: "code", agent: "momentum", name: "grid", positions: "leave", by: "view-1", seq: 20, at: new Date(now - 2000).toISOString() } as unknown as JournalRow
  await d.rebuild([...filledBuy("req_day_0001", now - 5000, 10), ...filledBuy("req_day_0002", now - 4000, 12)])
  expect(d.usedToday("grid")).toBe(2)
  d.note(removed)
  // The earlier bot's buys aren't the new one's day, and its ids aren't the new one's history.
  expect(d.usedToday("grid")).toBe(0)
  expect(d.status("grid", { request: "req_day_0001" }).state).toBe("unknown")
  // The new bot's own buy counts, and the same holds when the journal is read again from the start.
  const again = desk(now, 100, { approvedVersion: () => ({ run: { mode: "paper" } }) })
  await again.rebuild([...filledBuy("req_day_0001", now - 5000, 10), ...filledBuy("req_day_0002", now - 4000, 12), removed, ...filledBuy("req_day_0003", now - 1000, 22)])
  expect(again.usedToday("grid")).toBe(1)
  expect(again.status("grid", { request: "req_day_0003" }).state).toBe("filled")
})
