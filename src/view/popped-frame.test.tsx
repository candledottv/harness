// Pop-out on screen: ctrl-p, the ⇱ chip and the palette move the focused pane out; the
// tiled view leaves a popped pane out and takes it back when the core says it's back; and the popped view
// draws its pane with a footer, approves nothing, and has the kill switch.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import type { PaneId } from "../shared/panes"
import { App, type Session } from "./app"
import type { PopOutcome } from "./popout"
import { PoppedApp } from "./popped"
import type { StatusView, ViewCard } from "./store"

const MOON = "MoonFake11111111111111111111111111111111111"

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
  push(topic: string, data: unknown): void {
    for (const l of this.listeners) l({ topic, seq: ++this.seq, data, snapshot: true })
  }
  methods(): string[] {
    return this.requests.map((r) => r.method)
  }
}

const status = (over: Partial<StatusView> = {}): StatusView => ({
  agents: [{ name: "momentum", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } }],
  activeAgent: "momentum",
  mode: "live",
  paused: false,
  exposureUsd: 0,
  pnl: null,
  pricesAgeMs: 1_000,
  ...over,
})

const card = (cardId: string): ViewCard => ({
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
  display: { title: "BUY 0.1 SOL → MOON", agent: "momentum", wallet: "WalletFake", mode: "live", expiresAt: new Date(clock + 60_000).toISOString(), mint: MOON, mintLabel: "MOON" },
})

const views = (popped: PaneId[]) => ({ link: null, pins: [], popped })

let clock = 1_000_000
type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined

afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
  })
  await setup!.renderOnce()
}

const frame = () => setup!.captureCharFrame()

function find(label: string): { x: number; y: number } {
  const rows = frame().split("\n")
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y]!.indexOf(label)
    if (x >= 0) return { x, y }
  }
  throw new Error(`"${label}" not on screen:\n${frame()}`)
}

async function main(outcome: PopOutcome = { kind: "split", where: "tmux" }) {
  const session = new FakeSession()
  const asked: PaneId[] = []
  const popOut = async (pane: PaneId) => {
    asked.push(pane)
    return outcome
  }
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => clock} tickMs={0} popOut={popOut} />, { width: 140, height: 40, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status()))
  await input(() => session.push("views", views([])))
  return { session, asked }
}

test("ctrl-p on a focused pane pops it out, and the hint line says which first", async () => {
  const { asked } = await main()
  // On the agent pane, ctrl-p says why not.
  await input(() => setup!.mockInput.pressKey("p", { ctrl: true }))
  expect(asked).toEqual([])
  expect(frame()).toContain("The agent's conversation and its cards stay here")
  const at = find("╭─ Positions")
  await input(() => setup!.mockMouse.click(at.x + 4, at.y))
  expect(frame()).toContain("ctrl-p pop out positions")
  await input(() => setup!.mockInput.pressKey("p", { ctrl: true }))
  expect(asked).toEqual(["positions"])
  expect(frame()).toContain("positions is in a tmux split of its own")
})

test("the ⇱ chip on a pane's border pops it out; the palette's Panes rows too", async () => {
  const { asked } = await main()
  const rows = frame().split("\n")
  const activity = find("╭─ Activity")
  const bottom = rows.findIndex((r, y) => y > activity.y && r.slice(activity.x).startsWith("╰─ ⇱"))
  await input(() => setup!.mockMouse.click(activity.x + 3, bottom))
  expect(asked).toEqual(["activity"])

  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  await input(() => setup!.mockInput.typeText("pop out wallets"))
  expect(frame()).toContain("pop out wallets")
  await input(() => setup!.mockInput.pressEnter())
  expect(asked).toEqual(["activity", "wallets"])
})

test("a popped pane leaves the tiled layout, the others taking its rows, and comes back when the core says its view went", async () => {
  const { session } = await main()
  expect(frame()).toContain("╭─ Positions")
  await input(() => session.push("views", views(["positions"])))
  expect(frame()).not.toContain("╭─ Positions")
  expect(frame()).toContain("╭─ Wallets")
  // The palette names it as out, and offers no second pop-out.
  await input(() => setup!.mockInput.pressKey("k", { ctrl: true }))
  await input(() => setup!.mockInput.typeText("popped"))
  expect(frame()).toContain("positions is popped out")
  // Esc closes it (it read as typed "escape" before, and the pane coming back drew over the palette).
  await input(async () => {
    setup!.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  expect(frame()).not.toContain("╭─ palette")
  await input(() => session.push("views", views([])))
  expect(frame()).toContain("╭─ Positions")
})

test("with no split to go to, the command shows with a chip that copies it", async () => {
  await main({ kind: "copy", command: "'/opt/candle-harness' view --pane feed", why: "this terminal isn't inside tmux or cmux" })
  const at = find("╭─ Positions")
  await input(() => setup!.mockMouse.click(at.x + 4, at.y))
  await input(() => setup!.mockInput.pressKey("p", { ctrl: true }))
  expect(frame()).toContain("positions has no split to pop out to: this terminal isn't inside tmux or cmux")
  expect(frame()).toContain("⧉ copy")
  expect(frame()).toContain("'/opt/candle-harness' view --pane feed")
})

async function popped(pane: PaneId, width = 60, height = 20) {
  const session = new FakeSession()
  let quit = false
  setup = await testRender(<PoppedApp session={session} pane={pane} onQuit={() => (quit = true)} now={() => clock} tickMs={0} />, { width, height, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() => session.push("status", status()))
  return { session, quit: () => quit }
}

test("the popped view: its pane alone, a footer with the cards waiting in the main window, and nothing approves", async () => {
  const { session } = await popped("activity")
  expect(frame()).toContain("╭─ Activity")
  expect(frame()).not.toContain("╭─ Positions")
  expect(frame()).toContain("⇱ activity · popped out")
  // No ⇱ chip on a pane that's already out.
  expect(frame()).not.toContain("╰─ ⇱")
  await input(() => session.push("cards", [card("c1")]))
  // Short of room it says the count alone, and drops how to close it before that.
  expect(frame()).toContain("1 card waiting ")
  expect(frame()).not.toContain("ctrl-c twice closes")
  await input(() => setup!.resize(100, 20))
  expect(frame()).toContain("1 card waiting, in the main window")
  expect(frame()).toContain("ctrl-c twice closes")
  // Enter, typing and the card keys do nothing here.
  clock += 5_000
  await input(() => setup!.mockInput.pressEnter())
  await input(() => setup!.mockInput.typeText("buy 1 sol of MOON"))
  await input(() => setup!.mockInput.pressEnter())
  await input(() => setup!.mockInput.pressKey("n", { ctrl: true }))
  expect(session.methods()).toEqual([])
})

test("the kill switch works from a popped view, by keys and its chip; ctrl-c twice closes it", async () => {
  const { session, quit } = await popped("positions")
  await input(() => setup!.mockInput.pressKey("x", { ctrl: true }))
  await input(() => setup!.mockInput.pressKey("x", { ctrl: true }))
  expect(session.methods()).toEqual(["kill"])
  const chip = find(" kill ")
  await input(() => setup!.mockMouse.click(chip.x + 2, chip.y))
  expect(session.methods()).toEqual(["kill", "kill"])
  await input(() => setup!.mockInput.pressKey("c", { ctrl: true }))
  await input(() => setup!.mockInput.pressKey("c", { ctrl: true }))
  expect(quit()).toBe(true)
})

test("a popped token pane pins at its own place, not a tab's", async () => {
  const { session } = await popped("token", 70, 24)
  await input(() =>
    session.push("market", { followed: { mint: MOON, chain: "solana", symbol: "MOON", since: clock, by: "agent" }, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null, trending: null }),
  )
  const pin = find(" pin ")
  await input(() => setup!.mockMouse.click(pin.x + 2, pin.y))
  expect(session.requests.at(-1)).toEqual({ method: "view.pin", params: { at: "popped out", pane: "token" } })
})
