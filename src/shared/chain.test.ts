// When a chain's part has ended, from the core's cards and operations, and the words it stops with.
import { expect, test } from "bun:test"
import { judge, type RunningChain, startedFrom, stopWords } from "./chain"
import type { ChainPart } from "./commands"
import type { CoreView, ViewCard, ViewOperation } from "../view/store"

const part = (text: string): ChainPart => ({ text, command: { kind: "trade", tool: "candle_trade", args: {}, echo: text } })
const chain = (n: number, over: Partial<RunningChain> = {}): RunningChain => ({ parts: Array.from({ length: n }, (_, i) => part(`part ${i + 1}`)), at: 0, line: "x", ...over })
const card = (cardId: string, state: string, over: Partial<ViewCard> = {}): ViewCard =>
  ({ cardId, opId: `op-${cardId}`, cardHash: "h", kind: "trade", tool: "candle_trade", agent: "a", state, expiresAt: "", display: {} as ViewCard["display"], ...over }) as ViewCard
const op = (opId: string, state: string, over: Partial<ViewOperation> = {}): ViewOperation => ({ opId, cardId: "", agent: "a", state, ...over })
const view = (cards: ViewCard[], ops: ViewOperation[] = [], paused = false): Pick<CoreView, "cards" | "operations" | "status"> => ({
  cards,
  operations: Object.fromEntries(ops.map((o) => [o.opId, o])),
  status: { agents: [], activeAgent: "a", mode: "live", paused },
})

test("a part waits on its card, then on Candle, and goes on only once it filled", () => {
  const r = chain(2, { wait: { cardId: "c1" } })
  expect(judge(r, view([card("c1", "awaiting_approval")]))).toEqual({ kind: "wait", words: "chain: part 1 of 2, waiting on the card" })
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "pending")]))).toEqual({ kind: "wait", words: "chain: part 1 of 2, waiting on Candle" })
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "succeeded")]))).toEqual({ kind: "next" })
  // The card's own operation state counts before the operations topic says it.
  expect(judge(r, view([card("c1", "approved", { operation: { state: "succeeded" } })]))).toEqual({ kind: "next" })
})

test("a sell Candle closed as the key's paper position stops the rest: nothing live was sold", () => {
  const r = chain(2, { wait: { cardId: "c1" } })
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "succeeded", { paper: true })]))).toMatchObject({ kind: "stop", why: expect.stringContaining("sold nothing live") })
  expect(judge(r, view([card("c1", "approved", { operation: { state: "succeeded", paper: true } })]))).toMatchObject({ kind: "stop" })
})

test("a part that didn't fill stops the rest, with why", () => {
  const r = chain(3, { wait: { cardId: "c1" } })
  expect(judge(r, view([card("c1", "rejected")]))).toEqual({ kind: "stop", why: "you rejected part 1" })
  expect(judge(r, view([card("c1", "expired")]))).toEqual({ kind: "stop", why: "part 1's card expired" })
  expect(judge(r, view([card("c1", "withdrawn")], [], true))).toEqual({ kind: "stop", why: "part 1's card was withdrawn by the kill switch" })
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "failed", { error: { code: "X", message: "slippage" } })]))).toEqual({ kind: "stop", why: "part 1 failed: slippage" })
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "refused", { error: { code: "X", message: "no route" } })]))).toEqual({ kind: "stop", why: "part 1 was refused: no route" })
  // No answer from Candle: the rest isn't sent on a guess.
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "unknown")]))).toMatchObject({ kind: "stop", why: expect.stringContaining("has no answer from Candle yet") })
  expect(judge(r, view([card("c1", "approved")], [op("op-c1", "abandoned")]))).toEqual({ kind: "stop", why: "part 1 was abandoned" })
})

test("a card replaced by another (a wallet re-quote, the kill switch's fresh sell) is followed; an expired one being approved waits", () => {
  const r = chain(2, { wait: { cardId: "c1" } })
  expect(judge(r, view([card("c1", "withdrawn", { replacedBy: "c2" }), card("c2", "awaiting_approval")]))).toMatchObject({ kind: "wait" })
  expect(judge(r, view([card("c1", "withdrawn", { replacedBy: "c2" }), card("c2", "approved")], [op("op-c2", "succeeded")]))).toEqual({ kind: "next" })
  expect(judge(r, view([card("c1", "withdrawn", { replacedBy: "c2" })]))).toMatchObject({ kind: "wait" })
  expect(judge({ ...r, approving: "c1" }, view([card("c1", "expired")]))).toMatchObject({ kind: "wait" })
})

test("the core's answer to a part: a card to wait on, a paper trade done, a refusal", () => {
  const r = chain(2)
  expect(startedFrom(r, { cardId: "c1", opId: "op-c1", state: "awaiting_approval" })).toEqual({ kind: "wait", cardId: "c1", opId: "op-c1" })
  expect(startedFrom(r, { cardId: "c1", opId: "op-c1", instant: { kind: "submitted" } })).toEqual({ kind: "wait", cardId: "c1", opId: "op-c1" })
  expect(startedFrom(r, { paper: { content: [{ text: "{}" }] } })).toEqual({ kind: "done" })
  expect(startedFrom(r, { paper: { isError: true, content: [{ text: "holds no MOON" }] } })).toEqual({ kind: "stop", why: "part 1 was refused in paper mode: holds no MOON" })
  expect(startedFrom(r, { kind: "pane", card: { cardId: "p1", opId: "op-p1" } })).toEqual({ kind: "wait", cardId: "p1", opId: "op-p1" })
  expect(startedFrom(r, { output: [] })).toEqual({ kind: "done" })
})

test("the stop's words say how many parts were sent and which weren't", () => {
  expect(stopWords(chain(3, { at: 1 }), "over agent-a's $25 per trade", false)).toBe("1 of 3 sent; part 2: over agent-a's $25 per trade.")
  expect(stopWords(chain(2, { at: 0 }), "you rejected part 1", true)).toBe("1 of 2 sent; part 2 not sent: you rejected part 1.")
  expect(stopWords(chain(2, { at: 1 }), "you rejected part 2", true)).toBe("2 of 2 sent; you rejected part 2.")
  expect(stopWords(chain(2, { at: 0 }), "Over the limit. Nothing was sent.", false)).toBe("0 of 2 sent; part 1: Over the limit. Nothing was sent.")
})
