// Aliases and chains on the input line, through the frame: a chain's
// parts go one after another, each only once the one before filled, and a part that doesn't stops the
// rest; an alias or chain can't send what a typed line couldn't.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import { App, type Session } from "./app"
import type { StatusView, ViewCard, ViewOperation } from "./store"

const JUP = "JupFake111111111111111111111111111111111111"

class FakeSession implements Session {
  requests: { method: string; params: Record<string, unknown> }[] = []
  used = 0
  private listeners: ((e: CoreEventParams) => void)[] = []
  private seq = 0
  constructor(private readonly answer: (method: string, params: Record<string, unknown>, n: number) => unknown = () => ({})) {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // The view saying it was used is counted apart: it carries no change.
    if (method === "view.active") {
      this.used++
      return {} as T
    }
    this.requests.push({ method, params })
    return this.answer(method, params, this.proposals().length) as T
  }
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topic: string, data: unknown, snapshot = false): void {
    for (const l of this.listeners) l({ topic, seq: ++this.seq, data, ...(snapshot ? { snapshot } : {}) })
  }
  proposals() {
    return this.requests.filter((r) => r.method === "cards.propose")
  }
}

let clock = 1_000_000
const status = (over: Partial<StatusView> = {}): StatusView => ({
  agents: [{ name: "momentum", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 25, perDayUsd: 100 } }],
  activeAgent: "momentum",
  mode: "live",
  paused: false,
  ...over,
})
const card = (cardId: string, state: string, side: "buy" | "sell" = "buy", over: Partial<ViewCard> = {}): ViewCard => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: `hash-${cardId}`,
  kind: "trade",
  tool: "candle_trade",
  agent: "momentum",
  state,
  side,
  expiresAt: new Date(clock + 60_000).toISOString(),
  display: { title: `${side.toUpperCase()} JUP`, agent: "momentum", wallet: "WalletFake", mode: "live", expiresAt: new Date(clock + 60_000).toISOString(), mint: JUP, mintLabel: "JUP" },
  ...over,
})
const op = (cardId: string, state: string, over: Partial<ViewOperation> = {}): ViewOperation => ({ opId: `op-${cardId}`, cardId, agent: "momentum", state, ...over })
/** cards.propose answers with the next card id: c1, c2, … */
const proposing = (method: string, _p: Record<string, unknown>, n: number) => (method === "cards.propose" ? { cardId: `c${n}`, opId: `op-c${n}`, state: "awaiting_approval" } : {})

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

async function start(session: FakeSession, config?: string, over: Partial<StatusView> = {}) {
  const app = <App session={session} onQuit={() => {}} now={() => clock} tickMs={0} {...(config !== undefined ? { configText: () => config } : {})} />
  setup = await testRender(app, { width: 140, height: 36, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status(over), true))
  // JUP is known once a card has shown it.
  await input(() => session.push("cards", [card("seen", "rejected")], true))
}
const frame = () => setup!.captureCharFrame()
async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
    await Bun.sleep(1)
  })
  await setup!.renderOnce()
}
const send = async (line: string) => {
  await input(() => setup!.mockInput.typeText(line))
  await input(() => setup!.mockInput.pressEnter())
}

test("buy $1 of JUP; sell 100% of JUP: the sell is proposed only once the buy has filled", async () => {
  const session = new FakeSession(proposing)
  await start(session)
  await send("buy $1 of JUP; sell 100% of JUP")
  expect(session.proposals().map((r) => r.params)).toEqual([{ tool: "candle_trade", args: { mint: JUP, side: "buy", amountUsd: "1" }, typed: true }])
  await input(() => session.push("cards", card("c1", "awaiting_approval")))
  expect(frame()).toContain("chain: part 1 of 2, waiting on the card")
  // Approved, and Candle still working on it: no sell yet.
  await input(() => session.push("cards", card("c1", "approved")))
  await input(() => session.push("operations", op("c1", "pending")))
  expect(frame()).toContain("chain: part 1 of 2, waiting on Candle")
  expect(session.proposals()).toHaveLength(1)
  // The buy filled: now the sell, sized by the core from the balance it bought.
  await input(() => session.push("operations", op("c1", "succeeded")))
  expect(session.proposals().map((r) => r.params)).toEqual([
    { tool: "candle_trade", args: { mint: JUP, side: "buy", amountUsd: "1" }, typed: true },
    { tool: "candle_trade", args: { mint: JUP, side: "sell", percent: 100 }, typed: true },
  ])
  await input(() => session.push("cards", card("c2", "awaiting_approval", "sell")))
  expect(frame()).toContain("chain: part 2 of 2, waiting on the card")
  // Enter approves the chain's current card, the sell.
  clock += 400
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)).toMatchObject({ method: "cards.approve", params: { cardId: "c2" } })
  await input(() => session.push("cards", card("c2", "approved", "sell", { operation: { state: "succeeded" } })))
  expect(frame()).toContain("Chain done: 2 of 2 sent, each after the one before.")
  expect(frame()).not.toContain("chain: part")
})

test("a rejected part stops the rest, and says which ran", async () => {
  const session = new FakeSession(proposing)
  await start(session)
  await send("buy $1 of JUP; sell 100% of JUP")
  await input(() => session.push("cards", card("c1", "awaiting_approval")))
  await input(() => session.push("cards", card("c1", "rejected")))
  expect(frame()).toContain("1 of 2 sent; part 2 not sent: you rejected part 1.")
  await input(() => session.push("operations", op("c1", "succeeded")))
  expect(session.proposals()).toHaveLength(1)
})

test("a part the core refuses (over a limit) stops the rest; the first part's refusal puts the line back", async () => {
  const session = new FakeSession((method, params, n) => {
    if (method === "cards.propose" && n === 2) throw new Error("over momentum's $25 per trade. Nothing was sent.")
    return proposing(method, params, n)
  })
  await start(session)
  await send("buy $1 of JUP; buy $30 of JUP; sell 100% of JUP")
  await input(() => session.push("cards", card("c1", "approved", "buy", { operation: { state: "succeeded" } })))
  expect(session.proposals()).toHaveLength(2)
  expect(frame()).toContain("1 of 3 sent; part 2: over momentum's $25 per trade. Nothing was sent.")
  expect(frame()).not.toContain("› buy $1 of JUP")

  const first = new FakeSession((method) => {
    if (method === "cards.propose") throw new Error("Buys are paused by the kill switch. Nothing was sent.")
    return {}
  })
  await act(async () => setup!.dispose())
  await start(first)
  await send("buy $1 of JUP; sell 100% of JUP")
  expect(frame()).toContain("0 of 2 sent; part 1: Buys are paused by the kill switch. Nothing was sent.")
  expect(frame()).toContain("› buy $1 of JUP; sell 100% of JUP")
})

test("while the kill switch's pause holds, a chain's buy is refused as a typed one is, and a buy card it withdraws stops the chain", async () => {
  let paused = false
  const session = new FakeSession((method, params, n) => {
    if (method === "cards.propose" && paused && (params.args as { side?: string }).side === "buy") throw new Error("Buys are paused by the kill switch. Nothing was sent.")
    return proposing(method, params, n)
  })
  await start(session)
  await send("sell 50% of JUP; buy $1 of JUP")
  // The kill switch while the sell waits: sells stay, buys pause.
  paused = true
  await input(() => session.push("status", status({ paused: true })))
  await input(() => session.push("cards", card("c1", "approved", "sell", { operation: { state: "succeeded" } })))
  expect(session.proposals()).toHaveLength(2)
  expect(frame()).toContain("1 of 2 sent; part 2: Buys are paused by the kill switch.")

  // A buy card waiting when the kill switch withdraws it.
  paused = false
  await act(async () => setup!.dispose())
  const again = new FakeSession(proposing)
  await start(again)
  await send("buy $1 of JUP; sell 100% of JUP")
  await input(() => again.push("cards", card("c1", "awaiting_approval")))
  await input(() => again.push("status", status({ paused: true })))
  await input(() => again.push("cards", card("c1", "withdrawn")))
  expect(frame()).toContain("1 of 2 sent; part 2 not sent: part 1's card was withdrawn by the kill switch.")
  expect(again.proposals()).toHaveLength(1)
})

test("a chain refused whole sends nothing, and the line stays to fix", async () => {
  const session = new FakeSession(proposing)
  await start(session)
  await send("buy $1 of JUP; and then tell me how it went")
  expect(session.proposals()).toHaveLength(0)
  expect(frame()).toContain("Part 2 of 2 isn't a command")
  expect(frame()).toContain("› buy $1 of JUP; and then tell me how it went")
})

test("paper parts run in the call, one after another", async () => {
  const session = new FakeSession((method) => (method === "cards.propose" ? { paper: { content: [{ text: "{}" }] } } : {}))
  await start(session, undefined, { mode: "paper" })
  await send("buy $1 of JUP; sell 100% of JUP")
  expect(session.proposals().map((r) => (r.params.args as { side: string }).side)).toEqual(["buy", "sell"])
  expect(frame()).toContain("Chain done: 2 of 2 sent")
})

test("a second chain while one runs isn't sent, and stays on the line", async () => {
  const session = new FakeSession(proposing)
  await start(session)
  await send("buy $1 of JUP; sell 100% of JUP")
  await send("sell 10% JUP; sell 10% JUP")
  expect(session.proposals()).toHaveLength(1)
  expect(frame()).toContain("A chain is still running (part 1 of 2)")
  expect(frame()).toContain("› sell 10% JUP; sell 10% JUP")
})

test("a view that closes sends no more of its chain", async () => {
  const session = new FakeSession(proposing)
  await start(session)
  await send("buy $1 of JUP; sell 100% of JUP")
  await act(async () => setup!.dispose())
  setup = undefined
  session.push("cards", card("c1", "approved", "buy", { operation: { state: "succeeded" } }))
  await Bun.sleep(5)
  expect(session.proposals()).toHaveLength(1)
})

test("an alias from config.toml runs as its words; one it can't use is said when the view starts", async () => {
  const session = new FakeSession(proposing)
  await start(session, `[aliases]\nb1 = "buy $1 of"\nbuy = "sell 100% of"\n`)
  expect(frame()).toContain('config.toml line 3: alias "buy" is left out')
  await send("b1 JUP")
  expect(session.proposals().map((r) => r.params)).toEqual([{ tool: "candle_trade", args: { mint: JUP, side: "buy", amountUsd: "1" }, typed: true }])
  // buy is still buy.
  await send("buy $2 of JUP")
  expect(session.proposals().at(-1)!.params.args).toEqual({ mint: JUP, side: "buy", amountUsd: "2" })
})

test("the palette lists the aliases; a pick puts the name on the line, and reload reads config.toml again", async () => {
  let config = `[aliases]\nb1 = "buy $1 of"\n`
  const session = new FakeSession(proposing)
  const app = <App session={session} onQuit={() => {}} now={() => clock} tickMs={0} configText={() => config} />
  setup = await testRender(app, { width: 140, height: 36, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status(), true))
  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  await input(() => setup!.mockInput.typeText("alias"))
  expect(frame()).toContain("b1")
  expect(frame()).toContain("→ buy $1 of")
  await input(() => setup!.mockInput.pressEnter())
  expect(frame()).toContain("› b1 ")
  config = `[aliases]\nb1 = "buy $1 of"\ns = "sell 100% of"\n`
  await input(() => setup!.mockInput.pressKey("u", { ctrl: true }))
  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  await input(() => setup!.mockInput.typeText("reload aliases"))
  await input(() => setup!.mockInput.pressEnter())
  // The palette stays open on the aliases, read again, so the new one shows; the message waits under it.
  expect(frame()).toContain("→ sell 100% of")
  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  expect(frame()).toContain("Read 2 aliases from config.toml.")
})

test("a chain's card approved after it expired comes back fresh, and the chain waits on the fresh one", async () => {
  let session!: FakeSession
  session = new FakeSession((method, params, n) => {
    if (method === "cards.approve") {
      // The core closes the old card as expired, then answers with the fresh one.
      session.push("cards", card("c1", "expired"))
      session.push("cards", card("c9", "awaiting_approval"))
      return { kind: "reproposed", expired: { cardId: "c1" }, fresh: { cardId: "c9", opId: "op-c9" } }
    }
    return proposing(method, params, n)
  })
  await start(session)
  await send("buy $1 of JUP; sell 100% of JUP")
  await input(() => session.push("cards", card("c1", "awaiting_approval")))
  clock += 400
  await input(() => setup!.mockInput.pressEnter())
  // The repropose is said over the chain's words, and the chain goes on.
  expect(frame()).toContain("That card had expired, so here's a fresh one")
  expect(frame()).not.toContain("not sent")
  await input(() => session.push("cards", card("c9", "approved", "buy", { operation: { state: "succeeded" } })))
  expect(session.proposals().map((r) => (r.params.args as { side: string }).side)).toEqual(["buy", "sell"])
})

test("an alias's line refused for an unknown name asks the agent in its words, and the line clears", async () => {
  const session = new FakeSession(proposing)
  await start(session, `[aliases]\nb1 = "buy $1 of"\n`)
  await send("b1 WOOF")
  expect(frame()).toContain("WOOF isn't a token this session has shown")
  await input(() => setup!.mockInput.pressKey("t", { ctrl: true }))
  expect(session.requests.at(-1)).toEqual({ method: "agent.send", params: { text: "buy $1 of WOOF" } })
  expect(frame()).not.toContain("› b1 WOOF")
})
