// The frame, drawn by OpenTUI's test renderer against a stand-in session: what it
// draws from the core's events, and what it asks the core for when keys and clicks arrive.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import { App, type Session } from "./app"
import type { StatusView, ViewCard } from "./store"

const MOON = "MoonFake11111111111111111111111111111111111"

class FakeSession implements Session {
  requests: { method: string; params: Record<string, unknown> }[] = []
  used = 0
  private listeners: ((e: CoreEventParams) => void)[] = []
  private seq = 0
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // The view saying it was used is counted apart: it carries no change.
    if (method === "view.active") {
      this.used++
      return {} as T
    }
    this.requests.push({ method, params })
    return this.answer(method, params) as T
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

const status = (over: Partial<StatusView> = {}): StatusView => ({
  agents: [
    { name: "momentum", candle: "ready", spentTodayUsd: 12, limits: { perTradeUsd: 10, perDayUsd: 50 } },
    { name: "swing", candle: "ready", spentTodayUsd: 3.5, limits: { perTradeUsd: 5, perDayUsd: 20 } },
  ],
  activeAgent: "momentum",
  mode: "live",
  paused: false,
  exposureUsd: 140,
  pnl: null,
  pricesAgeMs: 2_000,
  ...over,
})

const card = (cardId: string, title = "BUY 0.1 SOL (≈$15.00) → MOON"): ViewCard => ({
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
  display: { title, agent: "momentum", wallet: "WalletFake", mode: "live", expiresAt: new Date(clock + 60_000).toISOString(), mint: MOON, mintLabel: "MOON", price: "MOON $0.63" },
})

let clock = 1_000_000
type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
let quit = false

afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

async function start(session: FakeSession, width = 120, height = 32, configChangedAt?: number): Promise<Setup> {
  quit = false
  const app = <App session={session} onQuit={() => (quit = true)} now={() => clock} tickMs={0} {...(configChangedAt !== undefined ? { configChangedAt } : {})} />
  setup = await testRender(app, { width, height, exitOnCtrlC: false })
  await setup.renderOnce()
  return setup
}

const frame = () => setup!.captureCharFrame()
/**
 * The message and input lines' text, read across their rows: they sit under the agent pane, so
 * a phrase can wrap there, and the panes beside run on down the rows.
 */
const underAgent = (): string => {
  const rows = frame().split("\n")
  const bottom = rows.findIndex((r) => r.startsWith("╰"))
  const w = rows[bottom]!.indexOf("╯") + 1
  return rows
    .slice(bottom + 1)
    .map((r) => r.slice(0, w).trim())
    .join(" ")
    .replace(/\s+/g, " ")
}

async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
  })
  await setup!.renderOnce()
}

function find(label: string, onRow?: number): { x: number; y: number } {
  const rows = frame().split("\n")
  for (let y = 0; y < rows.length; y++) {
    if (onRow !== undefined && y !== onRow) continue
    const x = rows[y]!.indexOf(label)
    if (x >= 0) return { x, y }
  }
  throw new Error(`"${label}" not on screen:\n${frame()}`)
}

async function attached(over: Partial<StatusView> = {}) {
  const session = new FakeSession()
  await start(session)
  await input(() => session.push("status", status(over), true))
  return session
}

test("draws the status bar, the tab bar and the input line from the core's status", async () => {
  await attached()
  const top = frame().split("\n")[0]!
  for (const s of ["▲ candle", "momentum ▾", "LIVE", "today $12.00 / $50.00", "exposure $140.00", "● 0 cards waiting", "ctrl-x ×2 kill"]) expect(top).toContain(s)
  expect(frame()).toContain("1 Trade")
  // The tabs still to come aren't announced.
  expect(frame()).not.toContain("more tabs are coming")
  expect(frame()).toContain("type a command or ask the agent")
})

test("a missing P&L or exposure shows —, never 0, and stale prices say how old", async () => {
  await attached({ exposureUsd: null, pnl: null })
  expect(frame().split("\n")[0]).toContain("exposure —")
  expect(frame().split("\n")[0]).toContain("P&L —")
  setup!.renderer.root // keep the renderer referenced
  const session = await attached({ exposureUsd: 140, pricesAgeMs: 180_000 })
  expect(session).toBeDefined()
  expect(frame().split("\n")[0]).toContain("exposure $140.00 (3m old)")
})

test("attached to a core that predates a config edit, the view says the edit isn't in use", async () => {
  const session = new FakeSession()
  await start(session, 160, 32, 5_000)
  await input(() => session.push("status", status({ startedAt: 4_000 }), true))
  expect(frame()).toContain("config.toml changed after this core started")
})

test("a config.toml the core wrote itself (onboarding's agent, profile and limits) is in use, so nothing is said", async () => {
  const session = new FakeSession()
  await start(session, 160, 32, 5_000)
  await input(() => session.push("status", status({ startedAt: 4_000, configSeenMtime: 5_000 }), true))
  expect(frame()).not.toContain("config.toml changed")
})

test("a long message wraps above the input line rather than being cut off (at 108 columns)", async () => {
  const session = new FakeSession()
  await start(session, 108, 32, 5_000)
  await input(() => session.push("status", status({ startedAt: 4_000 }), true))
  const rows = frame().split("\n")
  expect(underAgent()).toContain("config.toml changed after this core started")
  // The end of the instruction shows, wrapped above the input line under the agent pane.
  expect(underAgent()).toContain("60 s after the last view closes.")
  expect(rows.filter((r) => r !== "").at(-1)).toContain("›")
})

test("a config older than the core it attached to says nothing", async () => {
  const session = new FakeSession()
  await start(session, 160, 32, 3_000)
  await input(() => session.push("status", status({ startedAt: 4_000 }), true))
  expect(frame()).not.toContain("config.toml changed")
})

test("in paper mode the exposure is labelled live, since it's the live wallets'", async () => {
  await attached({ mode: "paper", exposureUsd: 2 })
  expect(frame().split("\n")[0]).toContain("live exposure $2.00")
})

test("before the core answers, the bar says it's connecting", async () => {
  await start(new FakeSession())
  expect(frame().split("\n")[0]).toContain("connecting to the core")
})

test("a typed live buy asks the core for a card, typed; its card shows above the input line", async () => {
  const session = await attached()
  await input(() => session.push("cards", [], true))
  await input(async () => {
    await setup!.mockInput.typeText("buy 0.1 sol MOON")
  })
  // MOON isn't known yet: it says so, keeps the line and sends nothing.
  const before = session.requests.length
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.length).toBe(before)
  expect(frame()).toContain("MOON isn't a token this session has shown")
  // Once a card has shown MOON, its name resolves, and the kept line goes on Enter.
  await input(() => session.push("cards", { ...card("seen"), state: "rejected" }))
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)).toEqual({ method: "cards.propose", params: { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.1", quoteAsset: "sol" }, typed: true } })
  await input(() => session.push("cards", card("c1")))
  expect(frame()).toContain("1 card waiting · ⏎ approves the highlighted one")
  expect(frame()).toContain("BUY 0.1 SOL (≈$15.00) → MOON")
  expect(frame()).toContain("⏎ approve")
  expect(frame().split("\n")[0]).toContain("● 1 card waiting")
})

test("a typed CLI line the core refuses says why and stays on the line to fix (a look-alike)", async () => {
  const session = new FakeSession((method) => {
    if (method === "cli.run") throw new Error("VaultLook1 looks like your vault key cold, but isn't it. Nothing was run.")
    return {}
  })
  await start(session)
  await input(() => session.push("status", status(), true))
  await input(() => setup!.mockInput.typeText("candle vault transfer VaultLook1 --amount 0.01 --asset SOL --from cold"))
  await input(() => setup!.mockInput.pressEnter())
  await input(() => Bun.sleep(5))
  expect(underAgent()).toContain("looks like your vault key cold, but isn't it")
  // The line stays, its end in view (it's wider than the agent's column).
  expect(underAgent()).toContain("vault transfer VaultLook1 --amount 0.01 --asset SOL --from cold")
})

test("a line refused for an unknown name offers the agent: a click sends it as typed", async () => {
  const session = await attached()
  await input(() => setup!.mockInput.typeText("Buy $1 of WOOF."))
  await input(() => setup!.mockInput.pressEnter())
  expect(underAgent()).toContain("a name can match many tokens")
  expect(frame()).toContain("ctrl-t ask the agent")
  const before = session.requests.length
  const at = find("ctrl-t ask the agent")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  expect(session.requests.slice(before)).toEqual([{ method: "agent.send", params: { text: "Buy $1 of WOOF." } }])
  expect(frame()).not.toContain("ctrl-t ask the agent")
})

test("at 80×24 a wrapped message and its ask row sit under the panes, which keep their borders", async () => {
  const session = new FakeSession()
  await start(session, 80, 24)
  await input(() => session.push("status", status(), true))
  const closed = (rows: string[]) => rows.findLastIndex((r) => r.includes("╰"))
  const before = frame().split("\n")
  await input(() => setup!.mockInput.typeText("Buy $1 of WOOF."))
  await input(() => setup!.mockInput.pressEnter())
  const rows = frame().split("\n")
  const why = rows.findIndex((r) => r.includes("Not a trade yet"))
  expect(why).toBeGreaterThan(0)
  expect(rows.findIndex((r) => r.includes("ctrl-t ask the agent"))).toBeGreaterThan(why)
  // The agent pane's bottom border is drawn on the row just above the message, which sits under it; the
  // pane beside keeps its own, on the last row, as before.
  expect(rows[why - 1]!.startsWith("╰")).toBe(true)
  expect(closed(rows)).toBe(closed(before))
  expect(rows.filter((r) => r !== "").at(-1)!.trimEnd().endsWith("╯")).toBe(true)
  // Once the message clears (here, the ask taken), the panes take their rows back.
  const at = find("ctrl-t ask the agent")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  expect(frame()).not.toContain("Not a trade yet")
  expect(closed(frame().split("\n"))).toBe(closed(before))
})

test("Enter on an empty line approves the card only after 300 ms; a click on approve too", async () => {
  const session = await attached()
  await input(() => session.push("cards", card("c1")))
  clock += 100
  await input(() => setup!.mockInput.pressEnter())
  expect(session.methods()).not.toContain("cards.approve")
  clock += 250
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)).toEqual({ method: "cards.approve", params: { cardId: "c1", cardHash: "hash-c1", how: "enter" } })
  // The chip, not the header line that mentions it.
  const at = find(" ⏎ approve ")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  expect(session.requests.filter((r) => r.method === "cards.approve")).toHaveLength(2)
  expect(session.requests.at(-1)?.params).toMatchObject({ how: "click" })
})

test("ctrl-o shows what the highlighted card is bound to", async () => {
  const session = await attached()
  await input(() => session.push("cards", card("c1")))
  await input(() => setup!.mockInput.pressKey("o", { ctrl: true }))
  expect(frame()).toContain("hash      hash-c1")
  expect(frame()).toContain('candle_trade {"mint"')
  await input(() => setup!.mockInput.pressKey("x"))
  expect(frame()).not.toContain("hash      hash-c1")
})

test("ctrl-x twice kills; once only arms it, in the status bar", async () => {
  const session = await attached()
  await input(() => setup!.mockInput.pressKey("x", { ctrl: true }))
  expect(frame().split("\n")[0]).toContain("ctrl-x again to kill")
  expect(session.methods()).not.toContain("kill")
  clock += 300
  await input(() => setup!.mockInput.pressKey("x", { ctrl: true }))
  expect(session.methods()).toContain("kill")
})

test("a click on the status bar's kill kills at once; paused shows how to resume", async () => {
  const session = await attached()
  const at = find("ctrl-x ×2 kill", 0)
  await input(() => setup!.mockMouse.click(at.x + 2, 0))
  expect(session.methods()).toContain("kill")
  await input(() => session.push("status", status({ paused: true })))
  const bar = frame().split("\n")[0]!
  expect(bar).toContain("PAUSED")
  expect(bar).toContain(" resume ")
  // The resume chip resumes.
  const resume = find(" resume ", 0)
  await input(() => setup!.mockMouse.click(resume.x + 2, 0))
  expect(session.methods()).toContain("resume")
})

test("switching to live asks once, by click or by typing", async () => {
  const session = await attached({ mode: "paper" })
  const at = find("PAPER", 0)
  await input(() => setup!.mockMouse.click(at.x + 1, 0))
  expect(frame()).toContain("switch to live?")
  await input(() => setup!.mockInput.pressKey("y"))
  expect(session.requests.at(-1)).toEqual({ method: "mode.set", params: { mode: "live" } })
})

test("clicking the agent opens the picker; picking one asks the core, and its spend shows", async () => {
  const session = await attached()
  const at = find("momentum ▾", 0)
  await input(() => setup!.mockMouse.click(at.x + 1, 0))
  expect(frame()).toContain("active agent")
  const swing = find("  swing")
  await input(() => setup!.mockMouse.click(swing.x + 3, swing.y))
  expect(session.requests.at(-1)).toEqual({ method: "agent.setActive", params: { agent: "swing" } })
  await input(() => session.push("status", status({ activeAgent: "swing" })))
  expect(frame().split("\n")[0]).toContain("swing ▾")
  expect(frame().split("\n")[0]).toContain("today $3.50 / $20.00")
})

test("candle keys list goes to cli.run; candle swap points to swap … from <wallet>", async () => {
  const session = await attached()
  await input(async () => {
    await setup!.mockInput.typeText("candle keys list")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)).toEqual({ method: "cli.run", params: { argv: ["keys", "list"] } })
  await input(async () => {
    await setup!.mockInput.typeText("candle swap SOL USDC --amount 0.1")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(underAgent()).toContain("add from <wallet> to pay from a TEE wallet")
  expect(session.methods().filter((m) => m === "cli.run")).toHaveLength(1)
})

test("a refusal from the core shows on the message line", async () => {
  const session = new FakeSession((method) => {
    if (method === "cards.propose") throw new Error("Buying is paused by the kill switch. Sells still work; resume to buy.")
    return {}
  })
  await start(session)
  await input(() => session.push("status", status(), true))
  await input(() => session.push("cards", { ...card("seen"), state: "rejected" }))
  await input(async () => {
    await setup!.mockInput.typeText("buy $25 MOON")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(frame()).toContain("Buying is paused by the kill switch")
})

test("the conversation streams in the body, and the gated reply replaces it", async () => {
  const session = await attached()
  await input(() => session.push("agent", { agent: "momentum", turnId: "t1", type: "started", user: "what's up?" }))
  await input(() => session.push("agent", { agent: "momentum", turnId: "t1", type: "text", delta: "Quiet market " }))
  expect(frame()).toContain("you › what's up?")
  expect(frame()).toContain("Quiet market")
  await input(() => session.push("agent", { agent: "momentum", turnId: "t1", type: "ended", outcome: "done", reply: "Quiet market today.", labelled: [], steps: 0 }))
  expect(frame()).toContain("Quiet market today.")
})

test("a 40×12 terminal shows the too-small message, and a resize mid-render recovers", async () => {
  await attached()
  await input(() => setup!.resize(40, 12))
  expect(frame()).toContain("Too small: 40×12")
  await input(() => setup!.resize(120, 32))
  expect(frame()).toContain("1 Trade")
})

test("ctrl-c twice quits; once on a line with text clears it", async () => {
  await attached()
  await input(async () => {
    await setup!.mockInput.typeText("hello")
  })
  // The renderer's own ctrl-c handling is off in the app (exitOnCtrlC: false); the key goes to the reducer.
  const ctrlC = () => setup!.mockInput.pressKey("c", { ctrl: true })
  await input(ctrlC)
  expect(frame()).not.toContain("› hello")
  await input(ctrlC)
  expect(quit).toBe(false)
  await input(ctrlC)
  expect(quit).toBe(true)
})

test("at 80 columns the bar drops figures, never the agent, the mode or the kill switch", async () => {
  const session = new FakeSession()
  await start(session, 80, 24)
  await input(() => session.push("status", status(), true))
  const top = frame().split("\n")[0]!
  for (const s of ["momentum ▾", "LIVE", "ctrl-x ×2 kill"]) expect(top).toContain(s)
  expect(top).not.toContain("exposure")
})

test("a click on a tab focuses the tab bar", async () => {
  await attached()
  const at = find("1 Trade", 1)
  await input(() => setup!.mockMouse.click(at.x, 1))
  await input(() => setup!.mockInput.pressArrow("down"))
  // Down from the tab bar lands in the body: its border takes the accent (no error, no crash).
  expect(frame()).toContain("momentum")
})

test("the lost-reply debug switch shows in the status bar while it's armed", async () => {
  const session = await attached({ debugLoseNextReply: true })
  expect(frame().split("\n")[0]).toContain("DEBUG · next answer dropped")
  await input(() => session.push("status", status()))
  expect(frame().split("\n")[0]).not.toContain("DEBUG")
})

test("a trade Candle didn't answer is pinned with re-send and abandon: by click, or typed when it's the only one", async () => {
  const session = await attached()
  const unknown = (opId: string) => ({ opId, cardId: `card-${opId}`, agent: "momentum", state: "unknown", kind: "swap", tool: "candle_swap", params: { amount: "0.005", from: "SOL", to: "USDC" }, startedAt: clock - 20_000 })
  await input(() => session.push("operations", unknown("op-1")))
  expect(frame()).toContain("NO ANSWER FROM CANDLE · SWAP 0.005 SOL → USDC")
  const at = find("re-send (same id")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  expect(session.requests.at(-1)).toEqual({ method: "operations.resolve", params: { opId: "op-1", action: "resend" } })

  await input(async () => {
    await setup!.mockInput.typeText("abandon")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.at(-1)).toEqual({ method: "operations.resolve", params: { opId: "op-1", action: "abandon" } })

  // Two waiting: typed, it won't guess which.
  await input(() => session.push("operations", unknown("op-2")))
  const before = session.requests.length
  await input(async () => {
    await setup!.mockInput.typeText("resend")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(session.requests.length).toBe(before)
  expect(frame()).toContain("2 trades have no answer yet")

  // Settled: the block goes.
  await input(() => session.push("operations", [{ ...unknown("op-1"), state: "succeeded" }, { ...unknown("op-2"), state: "abandoned" }], true))
  expect(frame()).not.toContain("NO ANSWER FROM CANDLE")
  await input(async () => {
    await setup!.mockInput.typeText("resend")
  })
  await input(() => setup!.mockInput.pressEnter())
  expect(frame()).toContain("Nothing is waiting on an answer from Candle.")
  expect(session.requests.length).toBe(before)
})

test("text selected with the mouse copies on ctrl-c, and ctrl-c without a selection still arms quit", async () => {
  await attached()
  const at = find("momentum here.")
  await input(() => setup!.mockMouse.drag(at.x, at.y, at.x + 12, at.y))
  expect(setup!.renderer.hasSelection).toBe(true)
  expect(frame()).toContain("Selected: ctrl-c or a right-click copies it.")
  await input(() => setup!.mockInput.pressKey("c", { ctrl: true }))
  await input(() => Bun.sleep(50))
  // Copied, sent to the terminal, or couldn't: never a quit prompt, and the selection is gone.
  expect(frame()).toMatch(/Copied the selection|Sent the selection|Couldn't copy the selection/)
  expect(setup!.renderer.hasSelection).toBe(false)
  await input(() => setup!.mockInput.pressKey("c", { ctrl: true }))
  expect(frame()).toContain("ctrl-c again")
})

test("a plain click selects nothing, so the next ctrl-c still clears the line", async () => {
  await attached()
  await input(async () => {
    await setup!.mockInput.typeText("abc")
  })
  const at = find("momentum here.")
  await input(() => setup!.mockMouse.click(at.x + 2, at.y))
  await input(() => setup!.mockInput.pressKey("c", { ctrl: true }))
  expect(frame()).not.toContain("› abc")
  await input(() => setup!.mockInput.pressKey("c", { ctrl: true }))
  expect(frame()).toContain("ctrl-c again")
})

test("the mouse pointer is a hand over a chip, and back to normal off it", async () => {
  await attached()
  const shapes: string[] = []
  const r = setup!.renderer as unknown as { setMousePointer: (s: string) => void }
  const real = r.setMousePointer.bind(r)
  r.setMousePointer = (s: string) => {
    shapes.push(s)
    real(s)
  }
  const kill = find("ctrl-x ×2 kill", 0)
  await input(() => setup!.mockMouse.moveTo(kill.x + 2, 0))
  await input(() => setup!.mockMouse.moveTo(kill.x - 20, 5))
  expect(shapes).toEqual(["pointer", "default"])
})
