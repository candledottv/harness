// A chain run by the core stops where the view's does, in the same words: each part once the one before
// filled, and a part rejected, expired, withdrawn, failed, refused, without an answer or refused when sent
// stops the rest.
import { expect, test } from "bun:test"
import type { ChainCard, ChainOperation } from "../shared/chain"
import { type ChainPart, parseCommand } from "../shared/commands"
import { ChainRunner } from "./chain-runner"

const MOON = "MoonFake11111111111111111111111111111111111"
const partsOf = (line: string): ChainPart[] => {
  const c = parseCommand(line, { agents: ["agent-a"], activeAgent: "agent-a", knownTokens: new Map([["MOON", MOON]]), mode: "live" })
  if (c?.kind !== "chain") throw new Error(`not a chain: ${line}`)
  return c.parts
}
const THREE = "buy $1 of MOON; sell 50% of MOON; sell 100% of MOON"

/** A core in miniature: each part proposed makes a card, and the test moves cards and operations along. */
function harness(opts: { refuse?: (at: number) => string | undefined; answer?: (at: number) => unknown } = {}) {
  const cards = new Map<string, ChainCard>()
  const ops = new Map<string, ChainOperation>()
  const sent: { text: string; at: number }[] = []
  let paused = false
  const runner = new ChainRunner({
    send: async (part, at) => {
      sent.push({ text: part.text, at })
      const why = opts.refuse?.(at)
      if (why) throw new Error(why)
      const answer = opts.answer?.(at)
      if (answer !== undefined) return answer
      const cardId = `c${at + 1}`
      cards.set(cardId, { cardId, opId: `op${at + 1}`, state: "awaiting_approval" })
      return { cardId, opId: `op${at + 1}` }
    },
    card: (id) => cards.get(id),
    operation: (id) => ops.get(id),
    paused: () => paused,
  })
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return {
    runner,
    sent,
    cards,
    ops,
    pause: () => (paused = true),
    /** Card `n` approved and its operation at `state`; then the runner is poked, as the core pokes it on a change. */
    async fill(n: number, state = "succeeded", over: Partial<ChainOperation> = {}) {
      cards.set(`c${n}`, { ...cards.get(`c${n}`)!, state: "approved" })
      ops.set(`op${n}`, { state, ...over })
      runner.poke()
      await settle()
    },
    async card(n: number, state: string, over: Partial<ChainCard> = {}) {
      cards.set(`c${n}`, { ...cards.get(`c${n}`)!, state, ...over })
      runner.poke()
      await settle()
    },
    settle,
  }
}

test("each part goes only once the one before filled, and the chain says it's done", async () => {
  const h = harness()
  const ended = h.runner.run(partsOf(THREE), THREE)
  await h.settle()
  expect(h.sent.map((s) => s.at)).toEqual([0])
  h.runner.poke()
  await h.settle()
  expect(h.sent.length).toBe(1)
  await h.fill(1, "submitting")
  expect(h.sent.length).toBe(1)
  await h.fill(1)
  expect(h.sent.map((s) => s.text)).toEqual(["buy $1 of MOON", "sell 50% of MOON"])
  await h.fill(2)
  await h.fill(3)
  expect(await ended).toEqual({ kind: "done", words: "Chain done: 3 of 3 sent, each after the one before.", sent: 3 })
  expect(h.runner.size).toBe(0)
})

const stops: [string, (h: ReturnType<typeof harness>) => Promise<void>, string, number][] = [
  ["rejected", (h) => h.card(2, "rejected"), "2 of 3 sent; part 3 not sent: you rejected part 2.", 2],
  ["expired", (h) => h.card(2, "expired"), "2 of 3 sent; part 3 not sent: part 2's card expired.", 2],
  ["failed", (h) => h.fill(2, "failed", { error: { message: "slippage" } }), "2 of 3 sent; part 3 not sent: part 2 failed: slippage.", 2],
  ["refused", (h) => h.fill(2, "refused"), "2 of 3 sent; part 3 not sent: part 2 was refused.", 2],
  ["without an answer", (h) => h.fill(2, "unknown"), "2 of 3 sent; part 3 not sent: part 2 has no answer from Candle yet: re-send or abandon it on its card.", 2],
  ["closed as paper", (h) => h.fill(2, "succeeded", { paper: true }), "2 of 3 sent; part 3 not sent: part 2 sold nothing live: the wallet held none, so Candle closed the key's paper position instead.", 2],
]

for (const [name, act, words, sent] of stops) {
  test(`a part ${name} stops the rest, in the view's words`, async () => {
    const h = harness()
    const ended = h.runner.run(partsOf(THREE), THREE)
    await h.settle()
    await h.fill(1)
    await act(h)
    expect(await ended).toEqual({ kind: "stopped", words, sent })
    expect(h.sent.length).toBe(2)
  })
}

test("withdrawn by the kill switch says so; a refusal when sent means nothing of that part ran", async () => {
  const h = harness()
  const ended = h.runner.run(partsOf(THREE), THREE)
  await h.settle()
  h.pause()
  await h.card(1, "withdrawn")
  expect(await ended).toEqual({ kind: "stopped", words: "1 of 3 sent; part 2 not sent: part 1's card was withdrawn by the kill switch.", sent: 1 })

  const r = harness({ refuse: (at) => (at === 1 ? "buys are paused by the kill switch" : undefined) })
  const second = r.runner.run(partsOf(THREE), THREE)
  await r.settle()
  await r.fill(1)
  expect(await second).toEqual({ kind: "stopped", words: "1 of 3 sent; part 2: buys are paused by the kill switch.", sent: 1 })
})

test("a card replaced by a fresh one is followed to its end", async () => {
  const h = harness()
  const ended = h.runner.run(partsOf(THREE), THREE)
  await h.settle()
  h.cards.set("c1-fresh", { cardId: "c1-fresh", opId: "op1-fresh", state: "approved" })
  await h.card(1, "withdrawn", { replacedBy: "c1-fresh" })
  expect(h.sent.length).toBe(1)
  h.ops.set("op1-fresh", { state: "succeeded" })
  h.runner.poke()
  await h.settle()
  expect(h.sent.length).toBe(2)
  await h.fill(2)
  await h.fill(3)
  expect((await ended).kind).toBe("done")
})

test("a part run in the call goes straight on; one for the prompt pane stops, since the core opens no pane", async () => {
  const h = harness({ answer: (at) => (at === 0 ? { paper: { isError: false } } : at === 1 ? { kind: "pane", card: { cardId: "p", opId: "q" } } : undefined) })
  const ended = h.runner.run(partsOf(THREE), THREE)
  await h.settle()
  expect(await ended).toEqual({ kind: "stopped", words: "2 of 3 sent; part 3 not sent: part 2 runs in the prompt pane, which only a view can open.", sent: 2 })
})

test("several chains run at once, each on its own cards, and a stopping core stops them all", async () => {
  let n = 0
  const cards = new Map<string, ChainCard>()
  const runner = new ChainRunner({
    send: async () => {
      const cardId = `k${++n}`
      cards.set(cardId, { cardId, opId: `o${n}`, state: "awaiting_approval" })
      return { cardId, opId: `o${n}` }
    },
    card: (id) => cards.get(id),
    operation: () => undefined,
    paused: () => false,
  })
  const a = runner.run(partsOf(THREE), THREE)
  const b = runner.run(partsOf("sell 50% of MOON; sell 100% of MOON"), "x")
  await Promise.resolve()
  expect(runner.size).toBe(2)
  runner.stopAll("the core stopped")
  expect(await a).toEqual({ kind: "stopped", words: "1 of 3 sent; part 2 not sent: the core stopped.", sent: 1 })
  expect(await b).toEqual({ kind: "stopped", words: "1 of 2 sent; part 2 not sent: the core stopped.", sent: 1 })
  expect(runner.size).toBe(0)
})
