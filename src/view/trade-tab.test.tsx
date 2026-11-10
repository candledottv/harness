// The Trade tab, drawn by OpenTUI's test renderer against a stand-in session: cards inline and one
// press to approve, expiry and re-quote, the kill report, the panes following the core's topics, the
// empty states, and the narrow layout.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { RGBA } from "@opentui/core"
import { act } from "react"
import type { WalletsTopic } from "../core/agent-wallets"
import type { CoreEventParams } from "../core/client"
import type { KillReport } from "../core/kill"
import type { PortfolioView } from "../core/portfolio-view"
import type { TokenView } from "../core/token-watch"
import { App, type Session } from "./app"
import { EMPTY_VIEW, type StatusView, type ViewCard } from "./store"
import { inlineCards, scrollMark, windowOf } from "./trade-tab"
import { type Line, line } from "./panes/lines"
import { C } from "./theme"

const MOON = "MoonFake11111111111111111111111111111111111"
const W = "WalletFake111111111111111111111111111111111"

class FakeSession implements Session {
  requests: { method: string; params: Record<string, unknown> }[] = []
  used = 0
  private listeners: ((e: CoreEventParams) => void)[] = []
  private seq = 0
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // The view saying it was used is counted apart: it carries no change.
    if (method === "view.active") {
      this.used++
      return {} as T
    }
    this.requests.push({ method, params })
    return {} as T
  }
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topic: string, data: unknown, snapshot = false): void {
    for (const l of this.listeners) l({ topic, seq: ++this.seq, data, ...(snapshot ? { snapshot } : {}) })
  }
  methods(): string[] {
    return this.requests.map((r) => r.method)
  }
}

let clock = 1_000_000_000_000
const status = (over: Partial<StatusView> = {}): StatusView => ({
  agents: [
    { name: "momentum", candle: "ready", spentTodayUsd: 12, limits: { perTradeUsd: 10, perDayUsd: 50 } },
    { name: "swing", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } },
  ],
  activeAgent: "momentum",
  mode: "live",
  paused: false,
  exposureUsd: 140,
  pnl: null,
  pricesAgeMs: 2_000,
  ...over,
})
const card = (cardId: string, over: Partial<ViewCard> = {}, display: Partial<ViewCard["display"]> = {}): ViewCard => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: `hash-${cardId}`,
  kind: "trade",
  tool: "candle_trade",
  agent: "momentum",
  state: "awaiting_approval",
  expiresAt: new Date(clock + 60_000).toISOString(),
  side: "buy",
  params: { mint: MOON, side: "buy", amount: "0.1" },
  display: { title: "BUY 0.1 SOL (≈$15.00) → MOON", agent: "momentum", wallet: W, mode: "live", expiresAt: new Date(clock + 60_000).toISOString(), mint: MOON, mintLabel: "MOON", price: "MOON $0.63", why: "momentum on the 5m", ...display },
  ...over,
})
const portfolio = (over: Partial<PortfolioView> = {}): PortfolioView => ({
  readAt: clock - 3_000,
  wallets: [{ address: W, chain: "solana", kind: "embedded", agents: ["momentum", "swing"], sol: { amount: 2, usd: 300 }, tokens: [{ mint: MOON, symbol: "MOON", amount: 12345.678901, usd: 7777.78, buyers: ["swing"] }] }],
  readOnly: [],
  paper: {},
  deposit: W,
  ...over,
})
const market = (over: Partial<TokenView> = {}): TokenView => ({
  followed: { mint: MOON, chain: "solana", symbol: "MOON", since: clock - 60_000 },
  market: { name: "Moon Coin", symbol: "MOON", priceUsd: 0.63, marketCap: 1_000_000, liquidityUsd: 100_000, at: clock - 5_000 },
  check: { summary: "clear", flagged: [], unknown: [], at: clock - 60_000 },
  samples: Array.from({ length: 10 }, (_, i) => ({ at: clock - (9 - i) * 15_000, usd: 0.6 + i * 0.003 })),
  history: [],
  historyRead: null,
  change1h: null,
  trending: null,
  ...over,
})

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})
const frame = () => setup!.captureCharFrame()
async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
  })
  await setup!.renderOnce()
}
function find(label: string): { x: number; y: number } {
  const rows = frame().split("\n")
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y]!.indexOf(label)
    if (x >= 0) return { x, y }
  }
  throw new Error(`"${label}" not on screen:\n${frame()}`)
}
async function attached(over: Partial<StatusView> = {}, width = 140, height = 40): Promise<FakeSession> {
  const session = new FakeSession()
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => clock} tickMs={0} />, { width, height, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status(over), true))
  return session
}

test("the agent speaks first, and every pane has something to say before there's data", async () => {
  await attached()
  for (const s of ["momentum here.", "what's the tape saying in the last hour?", "Nothing here is financial advice.", "Waiting on Candle for its On Fire list", "Reading your portfolio…", "Reading your wallets…", "Nothing yet. Cards, fills, refusals"]) expect(frame()).toContain(s)
})

test("a card inline: one press of Enter approves it, with nothing in between; ctrl-n rejects the next", async () => {
  const session = await attached()
  await input(() => session.push("cards", card("c1")))
  expect(frame()).toContain("why  momentum on the 5m")
  clock += 400
  const before = session.requests.length
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.slice(before)).toEqual([{ method: "cards.approve", params: { cardId: "c1", cardHash: "hash-c1", how: "enter" } }])
  // The card says how it was approved.
  await input(() => session.push("cards", { ...card("c1"), state: "approved", approvedHow: "enter", operation: { state: "pending" } }))
  expect(frame()).toContain("pending · approved by Enter")
  await input(() => session.push("cards", card("c2")))
  await input(() => setup!.mockInput.pressKey("n", { ctrl: true }))
  expect(session.requests.at(-1)).toEqual({ method: "cards.reject", params: { cardId: "c2" } })
})

test("a card whose countdown reaches 0 greys out and offers a re-quote; ctrl-r or a click asks for one, and r is a letter", async () => {
  const session = await attached()
  await input(() => session.push("cards", card("c1")))
  expect(frame()).toContain("⏎ approve")
  clock += 60_000
  await input(() => session.push("cards", { ...card("c1"), state: "expired" }))
  expect(frame()).toContain("expired, never ran   ctrl-r re-quote")
  expect(frame()).not.toContain("⏎ approve")
  const at = find("ctrl-r re-quote")
  await input(() => setup!.mockMouse.click(at.x + 1, at.y))
  expect(session.requests.at(-1)).toEqual({ method: "cards.requote", params: { cardId: "c1" } })
  await input(() => setup!.mockInput.pressKey("r"))
  expect(session.requests.filter((r) => r.method === "cards.requote")).toHaveLength(1)
  await input(() => setup!.mockInput.pressKey("r", { ctrl: true }))
  expect(session.requests.filter((r) => r.method === "cards.requote")).toHaveLength(2)
})

test("a closed card stays under the conversation until the agent's next exchange starts", () => {
  const closed = card("c1", { state: "approved", operation: { state: "refused" } })
  const view = { ...EMPTY_VIEW, cards: [closed, card("c2")], seenAt: { c1: 1_000, c2: 1_000 } }
  const exchange = (turnId: string, seenAt: number) => ({ turnId, user: "u", reply: "r", streaming: false, tools: [], seenAt })
  // The turn the card came in: it stays.
  expect(inlineCards({ ...view, conversations: { momentum: [exchange("t1", 500)] } }, "momentum", 2_000).map((c) => c.cardId)).toEqual(["c1", "c2"])
  // The next message: the closed card goes; the open one stays.
  expect(inlineCards({ ...view, conversations: { momentum: [exchange("t1", 500), exchange("t2", 1_500)] } }, "momentum", 2_000).map((c) => c.cardId)).toEqual(["c2"])
})

test("a sell from a shared wallet says who shares it", async () => {
  const session = await attached()
  await input(() => session.push("cards", card("s1", { side: "sell" }, { title: "SELL 100% MOON", sharedWith: ["swing"] })))
  expect(frame()).toContain("shared with swing")
  // Details says what that means: the percent is of the wallet's whole holding.
  await input(() => setup!.mockInput.pressKey("o", { ctrl: true }))
  expect(frame()).toContain("a sell takes from the whole holding, whoever bought it")
})

const report: KillReport = {
  at: new Date(clock).toISOString(),
  by: "v1",
  stopped: { turns: [{ agent: "momentum", turnId: "t1" }], cards: [] },
  stillOpen: [],
  inFlight: [{ opId: "op-x", cardId: "x", agent: "momentum", title: "BUY 0.05 SOL → MOON", state: "pending" }],
  standing: { portfolioAgeMs: null, wallets: [], pnl: null, spentToday: [] },
  notStopped: { wording: "Bots and other apps using your keys aren't stopped.", steps: [], candleStopped: [] },
  resume: "type resume",
}

test("after a kill the report is pinned at the top, and its in-flight line follows the operation", async () => {
  const session = await attached()
  await input(() => session.push("status", status({ paused: true })))
  await input(() => session.push("activity", { kind: "kill.report", report }))
  expect(frame()).toContain("KILL SWITCH ON")
  expect(frame()).toContain("in flight   BUY 0.05 SOL → MOON (momentum): pending")
  expect(frame()).toContain("standing    — (no portfolio read yet) · P&L —")
  await input(() => session.push("operations", { opId: "op-x", cardId: "x", agent: "momentum", state: "succeeded" }))
  expect(frame()).toContain("in flight   BUY 0.05 SOL → MOON (momentum): filled")
  await input(() => session.push("status", status({ paused: false })))
  expect(frame()).not.toContain("KILL SWITCH ON")
})

test("the panes follow the core: the token, positions by wallet with both agents, wallets, activity", async () => {
  const session = await attached()
  await input(() => session.push("market", market()))
  await input(() => session.push("portfolio", portfolio({ readOnly: [{ agent: "watcher", command: "candle keys update ij90kl12 --embedded-wallet allow" }] })))
  await input(() => session.push("activity", { kind: "line", entry: { seq: 1, at: new Date(clock).toISOString(), agent: "momentum", text: "filled BUY 0.1 SOL → MOON", tone: "good" } }))
  const f = frame()
  expect(f).toContain("Token · MOON · follows the agent")
  expect(f).toContain("✓ no flags")
  expect(f).toContain("MOON price in USD, samples since")
  expect(f).toContain("embedded wallet · momentum, swing")
  // Who bought each holding, dim beside it; the wallet's agents in the wallets pane.
  expect(f).toMatch(/MOON\s+12,346\s+≈\$7,777\.78\s+swing/)
  expect(f).toContain("embedded · momentum, swing")
  expect(f).toContain("watcher: read only")
  expect(f).toContain("filled BUY 0.1 SOL → MOON")
  // MOON is now a name the input line resolves.
  await input(async () => {
    await setup!.mockInput.typeText("buy 0.1 sol MOON")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)?.method).toBe("cards.propose")
})

test("ctrl-f, a pane's border label or the agent menu show the active agent only, in positions, wallets and activity", async () => {
  const session = await attached()
  await input(() =>
    session.push(
      "portfolio",
      portfolio({
        wallets: [
          ...portfolio().wallets,
          { address: "TeeWallet1111111111111111111111111111111111", chain: "solana", kind: "tee", label: "swing tee", agents: ["swing"], sol: { amount: 1, usd: 150 }, tokens: [{ mint: MOON, symbol: "MOON", amount: 5, usd: 3.15, buyers: ["swing"] }] },
        ],
      }),
    ),
  )
  await input(() => session.push("activity", { kind: "line", entry: { seq: 1, at: new Date(clock).toISOString(), agent: "swing", text: "swing proposed SELL 50% MOON", tone: "info" } }))
  await input(() => session.push("activity", { kind: "line", entry: { seq: 2, at: new Date(clock).toISOString(), agent: "momentum", text: "momentum proposed BUY 0.1 SOL → MOON", tone: "info" } }))
  const all = () => {
    expect(frame()).toContain("swing tee")
    expect(frame()).toContain("swing proposed SELL 50% MOON")
    expect(frame()).toContain("all agents ▾")
    expect(frame().split("\n")[0]).toContain("momentum ▾")
  }
  const onlyMomentum = () => {
    const f = frame()
    expect(f.match(/momentum only ▾/g)).toHaveLength(3)
    expect(f.split("\n")[0]).toContain("momentum · only ▾")
    expect(f).not.toContain("swing tee")
    expect(f).not.toContain("swing proposed SELL 50% MOON")
    expect(f).toContain("momentum proposed BUY 0.1 SOL → MOON")
    // The shared wallet stays: momentum is on it.
    expect(f).toContain("embedded wallet · momentum, swing")
  }
  all()
  // ctrl-f works from anywhere, even with text on the line, and types nothing.
  await input(async () => {
    await setup!.mockInput.typeText("hello")
  })
  await input(() => setup!.mockInput.pressKey("f", { ctrl: true }))
  onlyMomentum()
  expect(frame()).toContain("› hello")
  await input(() => setup!.mockInput.pressKey("f", { ctrl: true }))
  all()
  // A click on a border label.
  const at = find("all agents ▾")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  onlyMomentum()
  // The agent menu's last row.
  const menu = find("momentum · only ▾")
  await input(() => setup!.mockMouse.click(menu.x + 1, menu.y))
  expect(frame()).toContain("[x] only momentum in positions, wallets, activity")
  const row = find("[x] only momentum")
  await input(() => setup!.mockMouse.click(row.x + 1, row.y))
  all()
})

test("paper mode: the positions pane shows this Candle Harness's paper books", async () => {
  const session = await attached({ mode: "paper" })
  await input(() => session.push("portfolio", portfolio({ paper: { swing: [{ mint: MOON, symbol: "MOON", tokens: 2.38, buys: 1, sells: 0 }] } })))
  expect(frame()).toContain("Positions · paper")
  expect(frame()).toContain("paper, at the quoted price")
})

test("narrow: one side pane, switched with ←/→ or a click on its arrows", async () => {
  const session = await attached({}, 80, 24)
  await input(() => session.push("portfolio", portfolio()))
  expect(frame()).toContain(" ◂  token  ▸   1/4")
  expect(frame()).not.toContain(" Positions ")
  await input(() => setup!.mockInput.pressArrow("right")) // agent → side
  await input(() => setup!.mockInput.pressArrow("right")) // token → positions
  expect(frame()).toContain(" Positions ")
  const at = find(" ▸")
  await input(() => setup!.mockMouse.click(at.x + 1, at.y))
  await input(() => setup!.mockMouse.click(find(" ▸").x + 1, at.y))
  expect(frame()).toContain(" ◂  activity  ▸   4/4")
  // ← walks back through the panes, then from the first to the agent.
  for (let i = 0; i < 4; i++) await input(() => setup!.mockInput.pressArrow("left"))
  expect(frame()).toContain(" ◂  token  ▸   1/4")
})

test("the wheel scrolls the conversation", async () => {
  const session = await attached()
  for (let i = 0; i < 30; i++) {
    await input(() => session.push("agent", { agent: "momentum", turnId: `t${i}`, type: "ended", user: `question ${i}`, reply: `answer ${i}`, outcome: "done" }))
  }
  expect(frame()).toContain("answer 29")
  const at = find("answer 29")
  await input(() => setup!.mockMouse.scroll(at.x, at.y, "up"))
  await input(() => setup!.mockMouse.scroll(at.x, at.y, "up"))
  await input(() => setup!.mockMouse.scroll(at.x, at.y, "up"))
  expect(frame()).toContain("scrolled up")
  expect(frame()).not.toContain("answer 29")
})

// Paying from a wallet.
const TEE = "TeeFakeA11111111111111111111111111111111111"
const wallets = (over: { active?: boolean } = {}): WalletsTopic => {
  const tee = { id: "teeA", address: TEE, label: "tee-one", chain: "solana", active: over.active ?? true }
  return {
    agents: {
      momentum: { payable: { embedded: { address: W, chain: "solana" }, tee: [tee], readAt: clock, unreadable: [] }, embeddedWallet: "allowed", prefix: "momeAb3d" },
      swing: { payable: { embedded: { address: W, chain: "solana" }, tee: [], readAt: clock, unreadable: [] }, embeddedWallet: "allowed", prefix: "swinAb3d" },
    },
    account: [tee],
    boundTo: { [TEE]: "momentum" },
  }
}
const teeCard = (cardId: string) =>
  card(
    cardId,
    { params: { argv: ["swap", "SOL", MOON, "--amount", "0.04", "--wallet", TEE, "--client-trade-id", `op-${cardId}`, "--yes", "--json", "--rpc-url", "https://rpc.example.invalid"], identity: "agent", agent: "momentum", json: true } },
    { title: "BUY 0.04 SOL (≈$6.00) → MOON · tee-one", headline: "BUY 0.04 SOL of MOON", gets: { amount: 9.52, asset: "MOON" }, valueUsd: 6, wallet: TEE, walletLabel: "tee-one", paysFrom: "pays from tee-one (TEE · TeeF…1111)" },
  )
const teePortfolio = (active = true) =>
  portfolio({
    wallets: [
      ...portfolio().wallets,
      { address: TEE, chain: "solana", kind: "tee", label: "tee-one", agents: ["momentum"], active, sol: { amount: 0.5, usd: 75 }, tokens: [] },
    ],
  })

for (const [width, height] of [
  [140, 40],
  [80, 24],
] as const) {
  test(`a TEE card at ${width}×${height}: the paying wallet on its second line, the actions in reach`, async () => {
    const session = await attached({}, width, height)
    await input(() => session.push("cards", teeCard("t1")))
    const f = frame()
    expect(f).toContain("BUY 0.04 SOL of MOON")
    // Cut to the pane when narrow, never run off it.
    expect(f).toContain(width >= 100 ? "momentum · pays from tee-one (TEE · TeeF…1111) · live · Moon…1111" : "momentum · tee-one (TEE)")
    // The token's short address ends the line at every width.
    expect(f).toContain("· Moon…1111")
    expect(f).toContain("⏎ approve")
    for (const row of f.split("\n")) expect(row.length).toBeLessThanOrEqual(width)
  })
}

test("ctrl-o details list the other wallets as chips; a click proposes it again from that wallet, and the old card is withdrawn", async () => {
  const session = await attached()
  await input(() => session.push("wallets", wallets()))
  await input(() => session.push("cards", card("c1")))
  await input(() => setup!.mockInput.pressKey("o", { ctrl: true }))
  expect(frame()).toContain("pay from  tee-one")
  expect(frame()).toContain("a wallet makes a new card paid from it")
  const at = find(" tee-one ")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  expect(session.requests.at(-1)).toEqual({ method: "cards.requote", params: { cardId: "c1", wallet: TEE } })
  expect(frame()).not.toContain("pay from  tee-one")
  expect(frame()).toContain("A new card, paid from tee-one, at the current price. The old one is withdrawn.")
  // The TEE card's details offer the embedded wallet back.
  await input(() => session.push("cards", { ...card("c1"), state: "withdrawn" }))
  await input(() => session.push("cards", teeCard("t1")))
  await input(() => setup!.mockInput.pressKey("o", { ctrl: true }))
  expect(frame()).toContain("runs      candle swap SOL")
  // The label column holds when a long value wraps.
  expect(frame()).toMatch(/│ {10}TeeFakeA1{3}/)
  await input(() => setup!.mockMouse.click(find(" embedded ").x + 2, find(" embedded ").y))
  expect(session.requests.at(-1)).toEqual({ method: "cards.requote", params: { cardId: "t1", wallet: "embedded" } })
})

test("details offer no wallets before the core says what the agent can pay from", async () => {
  const session = await attached()
  await input(() => session.push("cards", card("c1")))
  await input(() => setup!.mockInput.pressKey("o", { ctrl: true }))
  expect(frame()).toContain("hash      hash-c1")
  expect(frame()).not.toContain("pay from ")
})

test("from <wallet> typed: the trade names the wallet; one the agent can't pay from stays on the line and sends nothing", async () => {
  const session = await attached()
  await input(() => session.push("wallets", wallets()))
  await input(() => session.push("market", market()))
  await input(async () => {
    await setup!.mockInput.typeText("buy 0.1 sol MOON from tee-one")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)).toEqual({ method: "cards.propose", params: { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.1", quoteAsset: "sol", wallet: TEE }, typed: true } })
  const before = session.requests.length
  await input(async () => {
    await setup!.mockInput.typeText("buy 0.1 sol MOON from ghost")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.length).toBe(before)
  // Wrapped under the agent pane: the message's words, read across its rows.
  expect(frame().replace(/[│ ]*\n[ ]*/g, " ").replace(/\s+/g, " ")).toContain("Not a trade yet: momentum can't pay from ghost.")
  expect(frame()).toContain("› buy 0.1 sol MOON from ghost")
})

test("the wallets pane: one line a wallet, with its agents, balance and a ⧉ chip; a copy keeps the order", async () => {
  const session = await attached()
  await input(() => session.push("portfolio", teePortfolio()))
  // The embedded wallet carries the deposit address, so it has no row of its own; the read's age is in the title.
  expect(frame()).not.toContain("deposit")
  expect(frame()).toContain("Wallets · read 3s ago")
  // The column is too narrow for one line here: the balance goes below, the chip ends the first line.
  expect(frame()).toContain("tee-one · TEE · momentum  ⧉")
  expect(frame()).toContain("  0.5 SOL ≈$75.00 · 0 tokens")
  const at = find("tee-one · TEE · momentum  ⧉")
  await input(() => setup!.mockMouse.click(at.x + "tee-one · TEE · momentum  ".length + 1, at.y))
  expect(session.requests).toEqual([])
  // In full under its own line, which stays where it was, balance and all.
  const lines = frame().split("\n")
  const row = lines.findIndex((l) => l.includes("tee-one · TEE · momentum  ⧉"))
  expect(row).toBeGreaterThan(lines.findIndex((l) => l.includes("embedded · momentum, swing")))
  expect(lines[row + 1]).toContain("0.5 SOL ≈$75.00")
  expect(lines[row + 2]).toContain(TEE)
  await input(() => session.push("portfolio", teePortfolio(false)))
  expect(frame()).toContain("tee-one · TEE · momentum · stopped")
})

test("at 120×30 with a real trending list, both wallets fit with their balances; the list gives the rows", async () => {
  const session = await attached({}, 120, 30)
  const rows = Array.from({ length: 11 }, (_, i) => ({ mint: `Mint${i}`.padEnd(43, "1"), symbol: `TOK${i}`, name: `Token ${i}`, marketCap: 100_000 + i }))
  await input(() => session.push("market", market({ followed: null, market: null, check: null, samples: [], history: [], historyRead: null, trending: { bucket: "onfire", at: clock - 5_000, rows } })))
  const holdings = Array.from({ length: 6 }, (_, i) => ({ mint: `Hold${i}`.padEnd(43, "1"), symbol: `H${i}`, amount: 1, usd: 1, buyers: [] }))
  await input(() => session.push("portfolio", portfolio({ wallets: [{ ...portfolio().wallets[0]!, tokens: holdings }, teePortfolio().wallets[1]!] })))
  const f = frame()
  for (const s of ["embedded · momentum, swing", "  2 SOL ≈$300.00", "tee-one · TEE · momentum", "  0.5 SOL ≈$75.00"]) expect(f).toContain(s)
  // The trending list keeps its heading and four tokens; its bottom border says how many more, to scroll to.
  expect(f).toContain("TOK3")
  expect(f).not.toContain("TOK4 ")
  expect(f).toMatch(/╰─( ⇱ ─)?─+ ↓ \d+ more ─╯/)
  // Positions names the wallet above its holdings.
  expect(f.indexOf("embedded wallet · momentum, swing")).toBeLessThan(f.indexOf("H0 "))
})

test("more wallets than two lines each can hold: one line each, the name, SOL and ⧉", async () => {
  const session = await attached({}, 120, 30)
  const rows = Array.from({ length: 11 }, (_, i) => ({ mint: `Mint${i}`.padEnd(43, "1"), symbol: `TOK${i}`, name: `Token ${i}`, marketCap: 100_000 + i }))
  await input(() => session.push("market", market({ followed: null, market: null, check: null, samples: [], history: [], historyRead: null, trending: { bucket: "onfire", at: clock - 5_000, rows } })))
  const tees = Array.from({ length: 4 }, (_, i) => ({ address: `Tee${i}`.padEnd(43, "1"), chain: "solana" as const, kind: "tee" as const, label: `bot-${i}`, agents: ["momentum"], active: true, sol: { amount: 0.1 * (i + 1), usd: 15 * (i + 1) }, tokens: [] }))
  await input(() => session.push("portfolio", portfolio({ wallets: [portfolio().wallets[0]!, ...tees] })))
  const f = frame()
  expect(f).toContain("embedded     2 SOL ≈$300.00  ⧉")
  // It asks only for the rows it uses: the trending list keeps the rest.
  expect(f).toContain("TOK3")
  for (let i = 0; i < 4; i++) expect(f).toContain(`bot-${i} · TEE  `)
  expect(f).not.toMatch(/Wallets[\s\S]*\+\d more/)
})

test("the panes show the core's choice of wallets; the rest are counted, and a chip shows them", async () => {
  const session = await attached({ walletsShown: "active" })
  const other = { address: "Other11111111111111111111111111111111111111", chain: "solana" as const, kind: "tee" as const, label: "other-bot", agents: [], active: true, sol: { amount: 1, usd: 150 }, tokens: [{ mint: MOON, symbol: "MOON", amount: 5, usd: 3, buyers: [] }] }
  await input(() => session.push("portfolio", portfolio({ wallets: [...teePortfolio().wallets, other] })))
  let f = frame()
  expect(f).toContain("tee-one · TEE · momentum")
  expect(f).not.toContain("other-bot")
  expect(f).toMatch(/\+1 hidden +show all/)
  expect(f).toContain("1 hidden wallet left out")
  const at = find("show all")
  await input(() => setup!.mockMouse.click(at.x + 1, at.y))
  expect(session.requests.at(-1)).toEqual({ method: "wallets.show", params: { show: "all" } })
  // Once the core says all, every wallet shows, and the chip goes back the other way.
  await input(() => session.push("status", status({ walletsShown: "all" })))
  f = frame()
  expect(f).toContain("other-bot · TEE")
  expect(f).toContain("active only")
  expect(f).not.toContain("hidden")
})

test("the wallets pane at 80×24: each wallet on two lines, the agents cut before the ⧉ chip ever is", async () => {
  const session = await attached({}, 80, 24)
  await input(() => session.push("portfolio", teePortfolio()))
  for (let i = 0; i < 3; i++) await input(() => setup!.mockInput.pressArrow("right"))
  expect(frame()).toContain(" ◂  wallets  ▸   3/4")
  expect(frame()).toContain("tee-one · TEE · momentum  ⧉")
  expect(frame()).toContain("embedded · momentum, swi…  ⧉")
  expect(frame()).toContain("  0.5 SOL ≈$75.00 · 0 tokens")
  // The title ends before the scope chip; the read's age moves inside, its first line (the chip covered it).
  const title = frame().split("\n").find((l) => l.includes("─ Wallets"))!
  expect(title).toContain("all agents ▾")
  expect(title).not.toContain("read")
  expect(frame()).toContain("read 3s ago")
})

test("the wallets pane on Free: TEE wallets are a Pro or Max feature", async () => {
  const session = await attached()
  await input(() => session.push("portfolio", { ...teePortfolio(), teeNote: "TEE wallets are a Pro or Max feature" }))
  expect(frame()).toContain("TEE wallets are a Pro or Max feature")
  await input(() => session.push("portfolio", { ...portfolio(), teeNote: "TEE wallets are a Pro or Max feature" }))
  expect(frame()).not.toContain("TEE wallets are a Pro or Max feature")
})

test("a pane cut to its rows: a list shows its first and scrolls down, Activity its newest and scrolls up; the border says what's out of view", () => {
  const lines = ["a", "b", "c", "d", "e"].map((t) => line(t, C.ink))
  const text = (ls: Line[]) => ls.map((l) => l.segs.map((s) => s.text).join(""))
  expect(text(windowOf(lines, 5).shown)).toEqual(["a", "b", "c", "d", "e"])
  expect(scrollMark(windowOf(lines, 5), "list")).toBeUndefined()
  // A list (a wallet mustn't be cut with no sign): what's below is counted on the border, then scrolled to.
  expect(text(windowOf(lines, 3).shown)).toEqual(["a", "b", "c"])
  expect(scrollMark(windowOf(lines, 3), "list")).toBe("↓ 2 more")
  expect(text(windowOf(lines, 3, "list", 1).shown)).toEqual(["b", "c", "d"])
  expect(scrollMark(windowOf(lines, 3, "list", 1), "list")).toBe("↑ 1 above · ↓ 1 more")
  expect(text(windowOf(lines, 3, "list", 9).shown)).toEqual(["c", "d", "e"])
  expect(windowOf(lines, 3).max).toBe(2)
  // Activity scrolls back, never past its oldest line (an older undo chip was out of reach).
  expect(text(windowOf(lines, 3, "tail").shown)).toEqual(["c", "d", "e"])
  expect(scrollMark(windowOf(lines, 3, "tail"), "tail")).toBeUndefined()
  expect(text(windowOf(lines, 3, "tail", 1).shown)).toEqual(["b", "c", "d"])
  expect(scrollMark(windowOf(lines, 3, "tail", 1), "tail")).toBe("↓ 1 newer")
  expect(text(windowOf(lines, 3, "tail", 9).shown)).toEqual(["a", "b", "c"])
  expect(text(windowOf(lines.slice(0, 2), 3, "tail", 1).shown)).toEqual(["a", "b"])
  expect(windowOf(lines, 0).shown).toEqual([])
})

test("a scrolled Activity holds its view as new lines arrive after its anchor", () => {
  const keyed = (n: number) => Array.from({ length: n }, (_, i) => line(`k${i}`, C.ink, { key: String(i) }))
  const text = (ls: Line[]) => ls.map((l) => l.segs.map((s) => s.text).join(""))
  // Scrolled 1 up when k5 was the newest: k2 to k4 show.
  expect(text(windowOf(keyed(6), 3, "tail", 1, "5").shown)).toEqual(["k2", "k3", "k4"])
  // Four more arrive: the same lines show, and the border counts what's newer.
  const later = windowOf(keyed(10), 3, "tail", 1, "5")
  expect(text(later.shown)).toEqual(["k2", "k3", "k4"])
  expect(later.since).toBe(4)
  expect(scrollMark(later, "tail")).toBe("↓ 5 newer")
  // An anchor gone from the pane: rows from the newest.
  expect(text(windowOf(keyed(10), 3, "tail", 1, "gone").shown)).toEqual(["k6", "k7", "k8"])
})

test("a scrolled Signals pane, newest first, holds its view as new signals arrive above it", () => {
  // Newest first: k9 is the newest; one state line without a key above the rows.
  const keyed = (n: number) => [line("state", C.dim), ...Array.from({ length: n }, (_, i) => line(`k${n - 1 - i}`, C.ink, { key: String(n - 1 - i) }))]
  const text = (ls: Line[]) => ls.map((l) => l.segs.map((s) => s.text).join(""))
  expect(text(windowOf(keyed(10), 3, "head").shown)).toEqual(["state", "k9", "k8"])
  expect(scrollMark(windowOf(keyed(10), 3, "head"), "head")).toBeUndefined()
  // Scrolled 3 down when k9 was the newest: k7 to k5 show.
  expect(text(windowOf(keyed(10), 3, "head", 3, "9").shown)).toEqual(["k7", "k6", "k5"])
  // Two more arrive at the head: the same lines show, and the border counts what's newer above.
  const later = windowOf(keyed(12), 3, "head", 3, "9")
  expect(text(later.shown)).toEqual(["k7", "k6", "k5"])
  expect(later.since).toBe(2)
  expect(scrollMark(later, "head")).toBe("↑ 5 newer")
})

test("the figure gate at 80×24: a figure no tool showed is dimmed with a ?, under the legend", async () => {
  const session = await attached({}, 80, 24)
  const reply = "MOON's price is $0.0042; an hour ago the price was $0.0051."
  await input(() => session.push("agent", { agent: "momentum", turnId: "f1", type: "ended", user: "MOON?", reply, outcome: "done", marked: [{ at: reply.indexOf("$0.0051"), text: "$0.0051" }] }))
  expect(frame()).toContain("$0.0051?")
  expect(frame()).toContain("? not read from a tool")
  expect(frame()).not.toContain("$0.0042?")
  const spans = setup!.captureSpans().lines.flatMap((l) => l.spans)
  const dim = RGBA.fromHex(C.dim)
  const same = (a: RGBA, b: RGBA) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.01
  expect(same(spans.find((s) => s.text.includes("$0.0051?"))!.fg, dim)).toBe(true)
  expect(same(spans.find((s) => s.text.includes("$0.0042"))!.fg, dim)).toBe(false)
})

test("every pane scrolls by the wheel; a scrolled Activity stays put under a burst of fills, and says what's newer", async () => {
  const session = await attached()
  const entry = (seq: number) => ({ kind: "line", entry: { seq, at: new Date(clock).toISOString(), agent: "momentum", text: `fill number ${seq}`, tone: "good" } })
  for (let seq = 1; seq <= 60; seq++) await input(() => session.push("activity", entry(seq)))
  const shown = () => [...frame().matchAll(/fill number (\d+)/g)].map((m) => Number(m[1]))
  expect(shown().at(-1)).toBe(60)
  const at = find("fill number 60")
  for (let i = 0; i < 3; i++) await input(() => setup!.mockMouse.scroll(at.x, at.y, "up"))
  const before = shown()
  expect(before.at(-1)).toBe(51)
  expect(frame()).toContain("↓ 9 newer")
  for (let seq = 61; seq <= 65; seq++) await input(() => session.push("activity", entry(seq)))
  expect(shown()).toEqual(before)
  expect(frame()).toContain("↓ 14 newer")
  // The wheel down takes in what arrived: back to the newest, and the mark goes.
  for (let i = 0; i < 6; i++) await input(() => setup!.mockMouse.scroll(at.x, at.y, "down"))
  expect(shown().at(-1)).toBe(65)
  expect(frame()).not.toContain("newer")
  // A list scrolls down by the wheel: Positions' holdings past its rows.
  const holdings = Array.from({ length: 30 }, (_, i) => ({ mint: `Hold${i}`.padEnd(43, "1"), symbol: `HLD${i}`, amount: 1, usd: 1, buyers: [] }))
  await input(() => session.push("portfolio", portfolio({ wallets: [{ ...portfolio().wallets[0]!, tokens: holdings }] })))
  expect(frame()).toMatch(/↓ \d+ more/)
  const top = find("HLD0 ")
  await input(() => setup!.mockMouse.scroll(top.x, top.y, "down"))
  expect(frame()).not.toContain("HLD0 ")
  expect(frame()).toMatch(/↑ 3 above/)
})
