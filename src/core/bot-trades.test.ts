import { expect, test } from "bun:test"
import { BOT_CLIENT_PREFIX as ENTRIES_PREFIX } from "./bot-entries"
import { BOT_CLIENT_PREFIX, botClient, botRequestId, BotTrades } from "./bot-trades"
import { PACE_TRADES, SELL_ROOM } from "./breaker"
import type { Card } from "./cards"
import type { JournalRow } from "./journal"
import { rowNotice } from "./notifier"
import { botFields, type FaceClient, modeFor, sourceOf } from "./tool-face"

const MOON = "MoonFake11111111111111111111111111111111111"
const T0 = Date.parse("2026-11-08T12:00:00.000Z")

let seq = 0
const row = (type: string, at: number, fields: Record<string, unknown> = {}): JournalRow => ({ seq: ++seq, at: new Date(at).toISOString(), type, ...fields }) as JournalRow

interface Sent {
  proposed: { client: FaceClient; tool: string; args: Record<string, unknown>; params: Record<string, unknown>; reason?: string }[]
  paper: { client: FaceClient; tool: string; args: Record<string, unknown> }[]
  withdrawn: string[]
  paused: string[]
}

function desk(opts: { rows?: JournalRow[]; now?: () => number; run?: "ran" | "waits" | "throws"; sleep?: (ms: number) => Promise<void> } = {}) {
  const sent: Sent = { proposed: [], paper: [], withdrawn: [], paused: [] }
  let n = 0
  const cards = new Map<string, Card>()
  const trades = new BotTrades({
    rows: opts.rows ?? [],
    now: opts.now ?? (() => T0),
    pauseKeyBots: async (agent) => void sent.paused.push(agent),
    face: () => ({
      call: async (client, tool, args) => {
        sent.paper.push({ client, tool, args })
        return { content: [], isError: false }
      },
    }),
    cards: () => ({
      propose: async (input) => {
        sent.proposed.push({ client: input.client, tool: input.tool, args: input.args, params: input.params, ...(input.reason ? { reason: input.reason } : {}) })
        const card = { cardId: `card-${++n}`, opId: `op-${n}`, state: "awaiting_approval", origin: { clientId: input.client.clientId, role: input.client.role, source: sourceOf(input.client), ...(input.client.bot ? { bot: input.client.bot } : {}) } } as unknown as Card
        cards.set(card.cardId, card)
        return card
      },
      runWithoutCard: async (card) => {
        if (opts.run === "throws") throw Object.assign(new Error("Candle stopped the key."), { code: "KEY_HELD" })
        const held = cards.get(card.cardId)!
        return opts.run === "waits" ? { card: held } : { card: held, ran: { ok: true } }
      },
      withdraw: async (_clientId, cardId) => void sent.withdrawn.push(String(cardId)),
      get: (cardId) => cards.get(cardId),
    }),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  })
  return { trades, sent }
}

test("a rules bot's client is the one entries and exits always made: its mode and slippage from its run settings, no kind, no request", () => {
  expect(ENTRIES_PREFIX).toBe(BOT_CLIENT_PREFIX)
  const entry = botClient({ name: "conf", agent: "momentum", mode: "live", slippageBps: 300 }, { act: "entry", signal: 41 })
  expect(entry).toEqual({ clientId: "core:bot:conf", role: "core", agent: "momentum", bot: { name: "conf", act: "entry", signal: 41, mode: "live", slippageBps: 300 } })
  const exit = botClient({ name: "conf", agent: "momentum", mode: "paper" }, { act: "exit", position: "entry_1", reason: "stop_loss", outside: "12" })
  expect(exit).toEqual({ clientId: "core:bot:conf", role: "core", agent: "momentum", bot: { name: "conf", act: "exit", position: "entry_1", reason: "stop_loss", outside: "12", mode: "paper" } })
  // Its rows read as before: no field a rules bot's rows didn't have.
  expect(botFields(entry.bot)).toEqual({ bot: "conf", botAct: "entry", botSignal: 41 })
  expect(botFields(exit.bot)).toEqual({ bot: "conf", botAct: "exit", botPosition: "entry_1", botReason: "stop_loss", botOutside: "12" })
  expect(botFields({ name: "conf", act: "entry", kind: "rules" })).toEqual({ bot: "conf", botAct: "entry" })
})

test("a code bot's client says its kind and the request it came from; its mode is still its card's, whatever the Candle Harness's", () => {
  const request = botRequestId()
  expect(request).toMatch(/^req_[A-Za-z0-9_-]{12}$/)
  expect(botRequestId()).not.toBe(request)
  const client = botClient({ kind: "code", name: "scalper", agent: "momentum", mode: "paper", slippageBps: 150 }, { act: "entry", request })
  expect(client.bot).toEqual({ name: "scalper", act: "entry", mode: "paper", slippageBps: 150, kind: "code", request })
  expect(botFields(client.bot)).toEqual({ bot: "scalper", botAct: "entry", botKind: "code", botRequest: request })
  expect(sourceOf(client)).toBe("bot")
  expect(modeFor(client, "live")).toBe("paper")
  // A bot's mode is only the core's own client's to carry.
  expect(modeFor({ role: "harness", bot: client.bot }, "live")).toBe("live")
})

test("the pace: the core's own trades on a key keep to 20 in 75 s, buys to 15, and a waiting sell goes before the next buy", () => {
  const { trades } = desk()
  for (let i = 0; i < PACE_TRADES - SELL_ROOM; i++) expect(trades.entryRoom("momentum", MOON, "MOON")).toBeUndefined()
  const buy = trades.entryRoom("momentum", MOON, "MOON")
  expect(buy).toEqual({ code: "pace", words: expect.stringContaining("the last 5 for sells") })
  for (let i = 0; i < SELL_ROOM; i++) expect(trades.exitRoom("momentum", MOON, "MOON")).toBeUndefined()
  const sell = trades.exitRoom("momentum", MOON, "MOON")
  expect(sell).toMatchObject({ why: "pace", until: T0 + 75_000 })
  // Another key has its own pace.
  expect(trades.entryRoom("swing", MOON, "MOON")).toBeUndefined()
  expect(trades.pace.used("momentum", T0)).toBe(PACE_TRADES)
})

test("a failing route holds that pair on the key until Candle's wait ends; other sides and tokens go", () => {
  const rows = [
    row("card.created", T0 - 5_000, { agent: "momentum", opId: "s1", side: "sell", mint: MOON }),
    row("operation.refused", T0 - 4_000, { agent: "momentum", opId: "s1", error: { code: "SWAP_ROUTE_FAILING", retryAfterSeconds: 30 } }),
  ]
  const { trades } = desk({ rows })
  expect(trades.exitRoom("momentum", MOON, "MOON")).toMatchObject({ why: "route", until: T0 + 26_000, words: expect.stringContaining("refusing sells of MOON") })
  expect(trades.entryRoom("momentum", MOON, "MOON")).toBeUndefined()
  expect(trades.room("momentum", "OtherFake1111111111111111111111111111111111", "sell", "OTHER")).toBeUndefined()
})

test("two failed sells of a token hold the core's third, warn the person's own, and a fill starts the count again", async () => {
  const fail = (op: string, at: number) => [row("card.created", at, { agent: "momentum", opId: op, side: "sell", mint: MOON }), row("operation.failed", at + 1, { agent: "momentum", opId: op, error: { code: "SWAP_FAILED" } })]
  const { trades } = desk({ rows: [...fail("f1", T0 - 9_000), ...fail("f2", T0 - 8_000)] })
  expect(trades.failedSells.held("momentum", MOON)).toBe(true)
  expect(trades.sellWarning("momentum", MOON, "MOON")).toContain("if this one fails too, Candle stops the key")
  expect(trades.sellWarning("swing", MOON, "MOON")).toBeUndefined()
  await expect(trades.waitForRoom({ tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 100 } }, "momentum", () => "MOON")).rejects.toMatchObject({ code: "FAILED_SELLS" })
  trades.note(row("card.created", T0, { agent: "momentum", opId: "ok1", side: "sell", mint: MOON }))
  trades.note(row("operation.succeeded", T0 + 1, { agent: "momentum", opId: "ok1" }))
  expect(trades.failedSells.held("momentum", MOON)).toBe(false)
})

test("the core's re-send of a lost exit: held by two failed sells of its token, never by its own flight, then by the pace", () => {
  const fail = (op: string, at: number) => [row("card.created", at, { agent: "momentum", opId: op, side: "sell", mint: MOON }), row("operation.failed", at + 1, { agent: "momentum", opId: op, error: { code: "SWAP_FAILED" } })]
  const lost = [row("card.created", T0 - 5_000, { agent: "momentum", opId: "x1", side: "sell", mint: MOON }), row("operation.submitting", T0 - 4_000, { agent: "momentum", opId: "x1" })]
  expect(desk({ rows: [...fail("f1", T0 - 9_000), ...fail("f2", T0 - 8_000), ...lost] }).trades.resendHold("momentum", MOON, "x1", "MOON")).toContain("two sells of MOON in a row failed")
  const { trades } = desk({ rows: lost })
  expect(trades.resendHold("momentum", MOON, "x1", "MOON")).toBeUndefined()
  for (let i = 0; i < PACE_TRADES; i++) trades.pace.take("momentum", T0, "sell")
  expect(trades.resendHold("momentum", MOON, "x1", "MOON")).toBeDefined()
})

test("a trigger's trade past the pace: a buy is refused with nothing sent, a sell waits for its slot and goes in it", async () => {
  let at = T0
  const slept: number[] = []
  const { trades } = desk({
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms)
      at += ms
    },
  })
  for (let i = 0; i < PACE_TRADES; i++) trades.note(row("operation.submitting", T0 - 1_000, { agent: "momentum", opId: `p${i}`, kind: "trade" }))
  await expect(trades.waitForRoom({ tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "1.00" } }, "momentum", () => "MOON")).rejects.toMatchObject({ code: "BREAKER_PACE" })
  await trades.waitForRoom({ tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 100 } }, "momentum", () => "MOON")
  // A minute at most at a time, then the rest.
  expect(slept).toEqual([60_000, 14_000])
  // A read isn't a trade: nothing to wait for.
  await trades.waitForRoom({ tool: "candle_get_market", args: {} }, "momentum", () => "MOON")
})

test("Candle stopping a key pauses every bot on it, live or on paper", () => {
  const { trades, sent } = desk()
  trades.noteOperation({ agent: "momentum", error: { code: "RISK_LIMIT_REACHED" } })
  trades.noteOperation({ agent: "swing", error: { code: "SWAP_FAILED" } })
  trades.note(row("paper.call", T0, { agent: "scout", tool: "candle_trade", isError: true, answer: '{"code":"RISK_LIMIT_REACHED"}' }))
  trades.note(row("paper.call", T0, { agent: "swing", tool: "candle_trade", isError: true, answer: '{"code":"INSUFFICIENT_BALANCE"}' }))
  expect(sent.paused).toEqual(["momentum", "scout"])
})

test("a bot's trade goes in the bot's mode, never the client's or the Candle Harness's: paper to the face, live to a card it runs", async () => {
  const { trades, sent } = desk()
  const given = botClient({ kind: "code", name: "scalper", agent: "momentum", mode: "live" }, { act: "entry", request: "req_a" })
  const paper = (await trades.send({ tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "1.00" } }, given, "paper", "the bot buys")) as { paper: unknown }
  expect(paper.paper).toBeDefined()
  expect(sent.paper[0]!.client.bot).toMatchObject({ mode: "paper", kind: "code", request: "req_a" })
  expect(sent.proposed).toHaveLength(0)
  const live = (await trades.send({ tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "1.00" } }, given, "live", "the bot buys")) as { instant?: unknown; cardId: string }
  expect(live.instant).toEqual({ ok: true })
  // Live params carry no paper flag, whatever the trade asked.
  expect(sent.proposed[0]!.params).toEqual({ mint: MOON, side: "buy", amountUsd: "1.00" })
  expect(sent.proposed[0]!.client.bot?.mode).toBe("live")
  expect(sent.proposed[0]!.reason).toBe("the bot buys")
})

test("a bot only buys, sells and swaps; a swap has no paper form", async () => {
  const { trades } = desk()
  const client = botClient({ name: "conf", agent: "momentum", mode: "paper" }, { act: "entry" })
  await expect(trades.send({ tool: "candle_swap", args: {} }, client, "paper", "x")).rejects.toMatchObject({ code: "NO_PAPER_SWAPS" })
  await expect(trades.send({ tool: "candle_get_market", args: {} }, client, "live", "x")).rejects.toMatchObject({ code: "NOT_A_CARD" })
})

test("a card that waits for the person comes back open; an exit refused at approval is withdrawn, an entry's isn't", async () => {
  const waits = desk({ run: "waits" })
  const open = (await waits.trades.send({ tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "3.00" } }, botClient({ name: "conf", agent: "momentum", mode: "live" }, { act: "entry" }), "live", "x")) as { state: string; instant?: unknown }
  expect(open.state).toBe("awaiting_approval")
  expect(open.instant).toBeUndefined()
  const throws = desk({ run: "throws" })
  await expect(throws.trades.send({ tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 100 } }, botClient({ name: "conf", agent: "momentum", mode: "live" }, { act: "exit", position: "e1", reason: "stop_loss" }), "live", "x")).rejects.toThrow("Candle stopped the key.")
  expect(throws.sent.withdrawn).toEqual(["card-1"])
  await expect(throws.trades.send({ tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "1.00" } }, botClient({ kind: "code", name: "scalper", agent: "momentum", mode: "live" }, { act: "entry" }), "live", "x")).rejects.toThrow()
  expect(throws.sent.withdrawn).toEqual(["card-1"])
})

test("a code bot's trades fold into one line a bot as a rules bot's do", () => {
  const n = rowNotice(row("paper.call", T0, { bot: "scalper", botAct: "entry", botKind: "code", botRequest: "req_a", args: { mint: MOON }, isError: false }), undefined, () => undefined, () => "MOON")
  expect(n?.kind).toBe("bots")
  expect(n?.bot).toEqual({ bot: "scalper", verb: "bought", token: "MOON", paper: true })
})
