// The tour and where to start: six stops over the real Trade tab, one lit at a time; then Trade or Cockpit
// as the tab the Candle Harness opens on; then the agent's welcome, saying what was set up. Kept as frames at 160×45, 120×30 and 80×24; and what each asks of the core.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { CLOCK, SceneSession } from "../../test/frame-scenes"
import type { AutonomyTopic } from "../core/autonomy"
import { freshState, onboardingProgress, type OnboardingFacts, type OnboardingState, type OnboardingView } from "../setup/onboarding"
import { App } from "./app"
import { INITIAL_UI, step, type UiContext } from "./keys"
import { memoryStore } from "./layouts-store"
import type { EngineTopic } from "./panes/engines"
import { TOUR_STOPS, tourBox, tourRect } from "./tour"
import { AGENT_FIRST, place } from "./layout"

process.env.TZ = "UTC"
const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

const ACCOUNT = "WalletFake111111111111111111111111111111111"
const EMBEDDED = "EmbedFake1111111111111111111111111111111111"
const FACTS: OnboardingFacts = {
  signIn: { state: "signed-in", account: ACCOUNT, profile: "candle-harness" },
  profile: "candle-harness",
  vault: "missing",
  key: { state: "stored", prefix: "FakeKey1" },
  wallet: { state: "payable", count: 1, address: EMBEDDED, kind: "embedded", name: "main" },
}
const STATE = (passed: OnboardingState["passed"] = []): OnboardingState => ({
  ...freshState(CLOCK),
  passed: ["welcome", "engine", "limits", "approvals", "fund", ...passed],
  engine: "claude-code",
  model: "sonnet",
  tested: { engine: "claude-code", model: "sonnet", at: new Date(CLOCK).toISOString() },
  vaultChoice: "later",
  agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() },
})
const atTour = () => onboardingProgress(STATE(), FACTS)
const atStart = () => onboardingProgress(STATE(["tour"]), FACTS)
const atDone = () => onboardingProgress(STATE(["tour", "start"]), FACTS)

const caps = { webSearch: false, webFetch: false, files: "own" as const, shellList: true, deltas: true }
const ENGINES: EngineTopic = {
  agents: { "agent-a": { engine: "claude-code", model: "sonnet", from: "saved" } },
  engines: { "claude-code": { label: "Claude Code", minVersion: "2.1.300", check: { ok: true, version: "2.1.316" }, capabilities: caps, signedIn: true, modelsReadAt: CLOCK } },
} as EngineTopic
const AGENT = {
  name: "agent-a",
  limits: { perTradeUsd: 10, perDayUsd: 50 },
  limitLines: [
    { by: "Harness", what: "trade", words: "Harness · $10.00 a trade" },
    { by: "Harness", what: "day", words: "Harness · $50.00 a day · $0.00 used" },
    { by: "Candle", what: "volume", words: "Candle · $50.00 a day (UTC) · $0.00 used" },
  ],
}
const AUTONOMY = { wallets: [{ wallet: EMBEDDED, name: "main", kind: "embedded", setting: "ask", usedTodayUsd: 0, agents: ["agent-a"], notes: [] }] } as unknown as AutonomyTopic
const PORTFOLIO = { readAt: CLOCK, wallets: [{ address: EMBEDDED, chain: "solana", kind: "embedded", name: "main", agents: ["agent-a"], active: true, nativeSymbol: "SOL", native: null, tokens: [] }], readOnly: [], paper: [] }

/** A session that answers onboarding's methods as a core would, and keeps what it was asked. */
class SetupSession extends SceneSession {
  view: OnboardingView
  constructor(view: OnboardingView) {
    super()
    this.view = view
  }
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!method.startsWith("onboarding.")) return super.request<T>(method, params)
    this.requests.push({ method, params })
    if (method === "onboarding.set" && "passed" in params) this.view = onboardingProgress({ ...this.view.state, passed: [...this.view.state.passed, params.passed as never] }, this.view.facts)
    return this.view as T
  }
}

async function draw(width: number, height: number, view: OnboardingView | undefined, opts: { store?: ReturnType<typeof memoryStore> } = {}) {
  const session = new SetupSession(view ?? atDone())
  // Where a real install keeps it, so step 5 names the files as a person sees them.
  const store = opts.store ?? { ...memoryStore(), path: join(homedir(), ".config", "candle", "harness", "layouts.toml") }
  const s = await testRender(<App session={session} onQuit={() => {}} now={() => CLOCK} tickMs={0} layouts={store} {...(view ? { onboarding: { straightIn: false, asked: false } } : {})} />, { width, height, exitOnCtrlC: false })
  setup = s
  const push = async (topic: string, data: unknown) => {
    await act(async () => session.push(topic, data, true))
    await s.renderOnce()
  }
  await s.renderOnce()
  await push("status", { agents: [AGENT], activeAgent: "agent-a", mode: "live", paused: false })
  await push("engine", ENGINES)
  await push("autonomy", AUTONOMY)
  await push("portfolio", PORTFOLIO)
  if (view) await push("onboarding", view)
  await settle(s)
  return { s, session, store }
}

async function settle(s: Setup) {
  for (let i = 0; i < 4; i++) {
    await act(async () => Bun.sleep(5))
    await s.renderOnce()
  }
}

async function press(s: Setup, ...keys: string[]) {
  for (const key of keys) {
    await act(async () => {
      if (key === "enter") s.mockInput.pressEnter()
      else if (key === "up" || key === "down" || key === "left" || key === "right") s.mockInput.pressArrow(key)
      else if (key === "escape") s.mockInput.pressEscape()
      else if (key === "ctrl-k") s.mockInput.pressKey("k", { ctrl: true })
      else s.mockInput.typeText(key)
    })
    // Esc waits for the sequence that might follow it (memory `frame-test-input`).
    if (key === "escape") await act(async () => Bun.sleep(30))
    await settle(s)
  }
}

async function compare(name: string, s: Setup): Promise<void> {
  const chars = s.captureCharFrame()
  const runs = s
    .captureSpans()
    .lines.map((l, y) => `${y}: ${l.spans.map((sp) => `${[sp.fg.r, sp.fg.g, sp.fg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}/${[sp.bg.r, sp.bg.g, sp.bg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}${sp.attributes ? `+${sp.attributes}` : ""}×${sp.width}`).join(" ")}`)
    .join("\n")
  const got = `${chars}\n--- colours ---\n${runs}\n`
  const file = join(DIR, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) throw new Error(`No frame kept for ${name}: run with UPDATE_FRAMES=1 to keep this one.\n${got}`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, got)
    return
  }
  expect(got).toBe(readFileSync(file, "utf8"))
}

const SIZES = [
  [160, 45],
  [120, 30],
  [80, 24],
] as const

const asked = (session: SetupSession, method: string) => session.requests.filter((r) => r.method === method).map((r) => r.params)

test("setup's step 4 opens the tour over the real Trade tab, and → walks its six stops, one lit at a time, at three sizes", async () => {
  for (const [w, h] of SIZES) {
    const { s, session } = await draw(w, h, atTour())
    for (const [i, stop] of TOUR_STOPS.entries()) {
      const frame = s.captureCharFrame()
      expect(frame).toContain(`${i + 1} of 6 · ${stop.title}`)
      expect(frame).toContain("Nothing is traded or proposed in the tour.")
      await compare(`tour-${w}x${h}-${i + 1}-${stop.id}`, s)
      await press(s, "right")
    }
    // Past the last stop it ends, and the step is gone past: where to start is next.
    expect(asked(session, "onboarding.set")).toEqual([{ passed: "tour" }])
    // The card was drawn, never proposed: nothing went to the core but onboarding's own calls and the topics.
    expect(session.requests.some((r) => r.method.startsWith("cards.") || r.method === "agent.send")).toBe(false)
    expect(s.captureCharFrame()).toContain("Where do you want to start?")
    await act(async () => s.dispose())
    setup = undefined
  }
})

test("the card stop draws a card with its keys, marked as the tour's; ← goes back, a letter does nothing, Esc ends the tour", async () => {
  const { s, session } = await draw(120, 30, atTour())
  await press(s, "right", "right")
  let frame = s.captureCharFrame()
  expect(frame).toContain("BUY $5.00 of JUP")
  expect(frame).toContain("⏎ approve")
  expect(frame).toContain("drawn for the tour")
  await press(s, "left")
  expect(s.captureCharFrame()).toContain("2 of 6 · Positions")
  await press(s, "x")
  frame = s.captureCharFrame()
  expect(frame).toContain("2 of 6 · Positions")
  expect(asked(session, "onboarding.set")).toEqual([])
  await press(s, "escape")
  expect(asked(session, "onboarding.set")).toEqual([{ passed: "tour" }])
  expect(s.captureCharFrame()).toContain("Where do you want to start?")
})

test("where to start: Trade or Cockpit, every tab on, the files; Cockpit opens the Candle Harness on it and is kept for next time", async () => {
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, atStart())
    const frame = s.captureCharFrame()
    expect(frame).toContain("Where do you want to start?")
    expect(frame).toContain("5 of your 10 tabs are on.")
    expect(frame).toContain("layouts.toml")
    await compare(`onboarding-${w}x${h}-start`, s)
    await act(async () => s.dispose())
    setup = undefined
  }
  // At 160 wide, so the Cockpit isn't collapsed and its Feed shows.
  const { s, session, store } = await draw(160, 45, atStart())
  await press(s, "down", "enter")
  expect(asked(session, "onboarding.set")).toEqual([{ passed: "start" }])
  expect(store.opensOn()).toBe("Cockpit")
  // The Candle Harness, on the Cockpit: its feed beside the agent.
  const frame = s.captureCharFrame()
  expect(frame).not.toContain("Where do you want to start?")
  expect(frame).toContain("Feed")
  await act(async () => s.dispose())
  setup = undefined
  // A later start opens on it, with no setup.
  const again = await draw(160, 45, undefined, { store })
  expect(again.s.captureCharFrame()).toContain("Feed")
})

test("a layouts.toml with a tab ticked off says how many are on; one that names neither Trade nor Cockpit offers its first tab", async () => {
  const shown = memoryStore(['[[tabs]]', 'name = "Trade"', 'layout = "Agent-first"', "", "[[tabs]]", 'name = "Cockpit"', 'layout = "Cockpit"', "shown = false"].join("\n"))
  let d = await draw(120, 30, atStart(), { store: shown })
  let frame = d.s.captureCharFrame()
  expect(frame).toMatch(/1 of your \d+ tabs are on\./)
  expect(frame).toContain("Trade")
  expect(frame).not.toContain("feed, signals and the token")
  await act(async () => d.s.dispose())
  const own = memoryStore(['[[tabs]]', 'name = "Desk"', 'layout = "Agent-first"'].join("\n"))
  d = await draw(120, 30, atStart(), { store: own })
  frame = d.s.captureCharFrame()
  expect(frame).toContain("Open the Candle Harness")
  expect(frame).toContain("on Desk, your first tab")
  await press(d.s, "enter")
  expect(own.opensOn()).toBe("Desk")
})

test("the welcome after setup says what was set up, then Try: and the one risk notice; a later start has the plain welcome", async () => {
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, atDone())
    const frame = s.captureCharFrame()
    expect(frame).toContain("Set up, and ready")
    expect(frame).toContain("Claude Code · sonnet")
    expect(frame).toContain("main, asking every time")
    expect(frame).toContain("Try:")
    await compare(`welcome-${w}x${h}-after-setup`, s)
    await act(async () => s.dispose())
    setup = undefined
  }
  const { s } = await draw(120, 30, undefined)
  const frame = s.captureCharFrame()
  expect(frame).not.toContain("Set up, and ready")
  expect(frame).toContain("Try:")
  expect(frame).toContain("Nothing here is financial advice.")
})

test("the palette's row runs the tour again, on the first tab with the agent pane; ending it asks nothing of setup", async () => {
  const { s, session } = await draw(120, 30, undefined)
  // From the P&L tab: the tour moves to Trade, so every stop is on screen.
  await act(async () => s.mockInput.pressKey("5", { ctrl: false }))
  await press(s, "ctrl-k", "t", "o", "u", "r", "enter")
  const frame = s.captureCharFrame()
  expect(frame).toContain("1 of 6 · Your agent")
  expect(frame).toContain("Token")
  await press(s, "escape")
  expect(s.captureCharFrame()).not.toContain("1 of 6")
  expect(session.requests.some((r) => r.method.startsWith("onboarding."))).toBe(false)
})

test("the reducer: → past the last stop ends the tour, ← stops at the first, Esc ends it, the kill switch still works over it", () => {
  const ctx = { tourTab: 0 } as unknown as UiContext
  let s = step(INITIAL_UI, { type: "openTour", now: CLOCK }, ctx).state
  expect(s.overlay).toEqual({ kind: "tour", step: 0 })
  s = step(s, { type: "key", key: { name: "left", sequence: "", ctrl: false, meta: false, shift: false } as never, now: CLOCK }, ctx).state
  expect(s.overlay).toEqual({ kind: "tour", step: 0 })
  for (let i = 0; i < TOUR_STOPS.length; i++) s = step(s, { type: "tourNext", now: CLOCK }, ctx).state
  expect(s.overlay).toBeUndefined()
  s = step(INITIAL_UI, { type: "openTour", now: CLOCK }, ctx).state
  const x = { name: "x", sequence: "\x18", ctrl: true, meta: false, shift: false } as never
  s = step(s, { type: "key", key: x, now: CLOCK }, ctx).state
  const killed = step(s, { type: "key", key: x, now: CLOCK + 100 }, ctx)
  expect(killed.effects).toContainEqual({ type: "kill" })
  expect(killed.state.overlay).toBeUndefined()
})

test("the box sits beside the lit pane where there's room, and never over a lit chip", () => {
  for (const [w, h] of SIZES) {
    const placed = place(AGENT_FIRST, { x: 0, y: 3, w, h: h - 3 }, {}, { foot: 2 })
    const frame = { width: w, height: h, placed, settingsX: 60, input: { x: 0, y: h - 1, w: 60, h: 1 } }
    for (const stop of TOUR_STOPS) {
      const lit = tourRect(stop.id, frame)
      const box = tourBox(lit, Math.min(46, w - 2), 12, w, h)
      expect(box.x >= 0 && box.y >= 0 && box.x + box.w <= w && box.y + box.h <= h).toBe(true)
      const overlaps = box.x < lit.x + lit.w && lit.x < box.x + box.w && box.y < lit.y + lit.h && lit.y < box.y + box.h
      if (lit.h <= 1 || w >= 120) expect(overlaps).toBe(false)
      // The kill switch's box clears the tab bar, so settings ▾ and the tabs stay in sight.
      if (stop.id === "kill") expect(box.y).toBeGreaterThanOrEqual(2)
    }
  }
})
