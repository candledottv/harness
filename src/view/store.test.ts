import { expect, test } from "bun:test"
import { applyEvent, EMPTY_VIEW, openCards } from "./store"

const MOON = "MoonFake11111111111111111111111111111111111"
const card = (cardId: string, state = "awaiting_approval") => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: "h",
  kind: "trade",
  tool: "candle_trade",
  agent: "momentum",
  state,
  expiresAt: "",
  display: { title: "BUY", agent: "momentum", wallet: "W", mode: "live", expiresAt: "", mint: MOON, mintLabel: "moon" },
})

test("a card's first sighting is stamped once, by the view's clock, and its token name is learnt", () => {
  let v = applyEvent(EMPTY_VIEW, { topic: "cards", seq: 1, data: card("a") }, 100)
  v = applyEvent(v, { topic: "cards", seq: 2, data: { ...card("a"), state: "approved" } }, 900)
  expect(v.seenAt).toEqual({ a: 100 })
  expect(openCards(v)).toEqual([])
  expect(v.knownTokens.get("MOON")).toBe(MOON)
})

test("a snapshot replaces the cards, keeping when each was first seen", () => {
  let v = applyEvent(EMPTY_VIEW, { topic: "cards", seq: 1, data: card("a") }, 100)
  v = applyEvent(v, { topic: "cards", seq: 1, data: [card("a"), card("b")], snapshot: true }, 500)
  expect(v.seenAt).toEqual({ a: 100, b: 500 })
  expect(openCards(v).map((c) => c.cardId)).toEqual(["a", "b"])
})

test("a card that arrives while another waits is marked, so Enter takes longer to reach it; one arriving alone, or in a snapshot, isn't", () => {
  let v = applyEvent(EMPTY_VIEW, { topic: "cards", seq: 1, data: card("a") }, 100)
  expect(v.behind).toBeUndefined()
  v = applyEvent(v, { topic: "cards", seq: 2, data: card("b") }, 5_000)
  expect(v.behind).toEqual({ b: true })
  // Once the first is settled, the next arrives alone.
  v = applyEvent(v, { topic: "cards", seq: 3, data: { ...card("a"), state: "approved" } }, 6_000)
  v = applyEvent(v, { topic: "cards", seq: 4, data: { ...card("b"), state: "rejected" } }, 6_000)
  v = applyEvent(v, { topic: "cards", seq: 5, data: card("c") }, 7_000)
  expect(v.behind).toEqual({ b: true })
  // A snapshot's cards show together: none slid in under another.
  const fresh = applyEvent(EMPTY_VIEW, { topic: "cards", seq: 1, data: [card("a"), card("b")], snapshot: true }, 500)
  expect(fresh.behind).toBeUndefined()
})

test("a reply streams, a re-ask voids what streamed, and the gated reply is final", () => {
  const e = (data: Record<string, unknown>) => ({ topic: "agent", seq: 0, data: { agent: "momentum", turnId: "t", ...data } })
  let v = applyEvent(EMPTY_VIEW, e({ type: "started", user: "hi" }), 0)
  v = applyEvent(v, e({ type: "text", delta: `Buy [checking address] ` }), 0)
  v = applyEvent(v, e({ type: "reask", unknown: [MOON] }), 0)
  expect(v.conversations.momentum![0]!.reply).toBe("")
  v = applyEvent(v, e({ type: "ended", outcome: "done", reply: "Final." }), 0)
  expect(v.conversations.momentum![0]).toMatchObject({ user: "hi", reply: "Final.", streaming: false, outcome: "done" })
})

test("the kill report arrives on activity, is pinned by the snapshot, and goes when the status says resumed", () => {
  const report = { notStopped: { wording: "w" } }
  let v = applyEvent(EMPTY_VIEW, { topic: "activity", seq: 0, data: { killReport: report }, snapshot: true }, 0)
  expect(v.killReport).toEqual(report as never)
  v = applyEvent(v, { topic: "status", seq: 1, data: { agents: [], activeAgent: "a", mode: "live", paused: true } }, 0)
  expect(v.killReport).not.toBeNull()
  v = applyEvent(v, { topic: "status", seq: 2, data: { agents: [], activeAgent: "a", mode: "live", paused: false } }, 0)
  expect(v.killReport).toBeNull()
})

test("the figure gate's marks come with the final reply and with the conversation's snapshot", () => {
  const e = (data: Record<string, unknown>) => ({ topic: "agent", seq: 0, data: { agent: "momentum", turnId: "t", ...data } })
  const marked = [{ at: 8, text: "$0.0051" }]
  let v = applyEvent(EMPTY_VIEW, e({ type: "started", user: "hi" }), 0)
  v = applyEvent(v, e({ type: "ended", outcome: "done", reply: "MOON is $0.0051.", marked }), 0)
  expect(v.conversations.momentum![0]!.marked).toEqual(marked)
  const snap = { topic: "agent", seq: 0, snapshot: true, data: { agents: { momentum: { exchanges: [{ turnId: "t", user: "hi", reply: "MOON is $0.0051.", outcome: "done", marked }] } } } }
  expect(applyEvent(EMPTY_VIEW, snap, 0).conversations.momentum![0]!.marked).toEqual(marked)
})
