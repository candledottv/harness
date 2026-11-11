// The chain filter, drawn by OpenTUI's test renderer against a stand-in session: cards inline and one
// press to approve, expiry and re-quote, the kill report, the panes following the core's topics, the
// empty states, and the narrow layout.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import type { PortfolioView } from "../core/portfolio-view"
import { App, type Session } from "./app"
import type { StatusView, ViewCard } from "./store"

const MOON = "MoonFake11111111111111111111111111111111111"
const W = "WalletFake111111111111111111111111111111111"

class FakeSession implements Session {
  requests: { method: string; params: Record<string, unknown> }[] = []
  wanted: { topics: readonly string[]; filters?: Record<string, unknown> }[] = []
  want(topics: readonly string[], filters?: Record<string, unknown>): void {
    this.wanted.push({ topics, ...(filters ? { filters } : {}) })
  }
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


const HOOD_W = "0x00000000000000000000000000000000000E1b01"
const embeddedSol = { address: W, chain: "solana" as const, kind: "embedded" as const, agents: ["momentum", "swing"], nativeSymbol: "SOL", native: { amount: 2.184, usd: 328 }, tokens: [] }
const embeddedHood = { address: HOOD_W, chain: "hood" as const, kind: "embedded" as const, agents: ["momentum", "swing"], nativeSymbol: "ETH", native: { amount: 0.05, usd: 150 }, tokens: [] }
const portfolio = (wallets: PortfolioView["wallets"]): PortfolioView => ({ readAt: clock - 3_000, wallets, readOnly: [], paper: {}, deposit: W })
const views = (chain: "solana" | "hood" | null) => ({ link: null, pins: [], signals: [], popped: [], chain })

test("a Solana-only account has no chain chip, and its status bar is as it was", async () => {
  const session = await attached({}, 120, 30)
  await input(() => session.push("portfolio", portfolio([embeddedSol])))
  expect(frame().split("\n")[0]).not.toContain("all chains")
  expect(frame().split("\n")[0]).toContain("momentum ▾  LIVE")
})

test("with wallets on two chains, the chip sits beside the agent's; its menu picks the chain every pane shows, and the chip then says it", async () => {
  const session = await attached({}, 120, 30)
  await input(() => session.push("portfolio", portfolio([embeddedSol, embeddedHood])))
  const top = frame().split("\n")[0]!
  expect(top).toContain("momentum ▾   all chains ▾  LIVE")
  const at = find("all chains ▾")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  expect(frame()).toContain(" chain ")
  expect(frame()).toContain("✓ all chains")
  expect(frame()).toContain("Hood only")
  const hood = find("every pane shows Hood only")
  await input(() => setup!.mockMouse.click(hood.x, hood.y))
  expect(session.requests.filter((r) => r.method === "view.chain")).toEqual([{ method: "view.chain", params: { chain: "hood" } }])
  await input(() => session.push("views", views("hood")))
  expect(frame().split("\n")[0]).toContain("momentum ▾   Hood ▾  LIVE")
  expect(frame()).not.toContain(" chain ")
})

const HOOD_TOKEN = "0x00000000000000000000000000000000000b0B01"
const holdings = (): PortfolioView => portfolio([
  { ...embeddedSol, tokens: [{ mint: MOON, symbol: "MOON", amount: 120.5, usd: 51.2, buyers: ["momentum"] }] },
  { ...embeddedHood, tokens: [{ mint: HOOD_TOKEN, symbol: "KITE", amount: 2150, usd: 8.6, buyers: ["swing"] }] },
])
const line = (seq: number, text: string, chain?: "solana" | "hood") => ({ kind: "line", entry: { seq, at: new Date(clock - (10 - seq) * 60_000).toISOString(), agent: "momentum", text, tone: "good", ...(chain ? { chain, mint: chain === "hood" ? HOOD_TOKEN : MOON } : {}) } })

test("Hood picked: Wallets, Positions and Activity show Hood's rows, and lines about no token; the agent's pane isn't filtered", async () => {
  const session = await attached({}, 120, 30)
  await input(() => session.push("portfolio", holdings()))
  await input(() => session.push("activity", line(1, "filled BUY 0.04 SOL → MOON", "solana")))
  await input(() => session.push("activity", line(2, "filled BUY 0.01 ETH → KITE", "hood")))
  await input(() => session.push("activity", line(3, "kill switch off")))
  // All chains: both, under a heading per chain.
  expect(frame()).toContain("filled BUY 0.04 SOL → MOON")
  expect(frame()).toContain("2.184 SOL")
  await input(() => session.push("views", views("hood")))
  const f = frame()
  expect(f).toContain("filled BUY 0.01 ETH → KITE")
  expect(f).toContain("kill switch off")
  expect(f).not.toContain("filled BUY 0.04 SOL → MOON")
  expect(f).toContain("0.05 ETH")
  // The deposit row is the embedded Solana wallet's: it goes with it.
  expect(f).not.toMatch(/│ embedded  ⧉/)
  expect(f).not.toContain("2.184 SOL")
  expect(f).toMatch(/KITE\s+2,150/)
  expect(f).not.toMatch(/MOON\s+120\.5/)
  // One chain on screen: no heading per chain.
  expect(f).not.toMatch(/│ Hood\s+│/)
  expect(f).toContain("momentum here.")
})

test("with the chip on screen, Signals' tape is asked for on the filter's chain; on one chain, as the tab kept it", async () => {
  const session = await attached({}, 160, 45)
  await input(() => session.push("portfolio", holdings()))
  await input(() => session.push("views", { ...views("hood"), signals: [{ at: "Cockpit", chain: "solana" }] }))
  const tab = find("2 Cockpit")
  await input(() => setup!.mockMouse.click(tab.x + 1, tab.y))
  expect(session.wanted.at(-1)?.filters?.signals).toEqual({ chain: ["hood"] })
  // An account on one chain: the chip goes, and the pane's own choice is as it was.
  await input(() => session.push("portfolio", portfolio([embeddedSol])))
  expect(session.wanted.at(-1)?.filters?.signals).toEqual({ chain: ["solana"] })
})
