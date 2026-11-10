// Onboarding's step 3 on screen: a vault or not, the agent's key with Candle's cap, the wallet it pays from, its
// limits with who holds each, the approvals menu on "ask every time", and a deposit or paper. Kept as frames at
// 120×30 and 80×24, on Free and Max, with a vault and without; and what each choice asks of the core.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { CLOCK, SceneSession } from "../../test/frame-scenes"
import type { AutonomyTopic } from "../core/autonomy"
import { freshState, onboardingProgress, type OnboardingFacts, type OnboardingState, type OnboardingView } from "../setup/onboarding"
import { App, setupPaneFailed } from "./app"
import { lookAlikes } from "./onboarding"
import type { PaneProcess } from "./pane-process"
import type { EngineTopic } from "./panes/engines"

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
const SIGNED: Partial<OnboardingFacts> = { signIn: { state: "signed-in", account: ACCOUNT, profile: "candle-harness" }, profile: "candle-harness" }
const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({ vault: "missing", key: { state: "none" }, wallet: { state: "unknown" }, ...SIGNED, ...over }) as OnboardingFacts
const TESTED = { engine: "claude-code" as const, model: "sonnet", tested: { engine: "claude-code" as const, model: "sonnet", at: new Date(CLOCK).toISOString() } }
const state = (passed: OnboardingState["passed"], over: Partial<OnboardingState> = {}): OnboardingState => ({ ...freshState(CLOCK), passed: ["welcome", "engine", ...passed], ...TESTED, ...over })
const STORED: Partial<OnboardingFacts> = { key: { state: "stored", prefix: "FakeKey1" } }
const PAYABLE: Partial<OnboardingFacts> = { ...STORED, wallet: { state: "payable", count: 1, address: EMBEDDED, kind: "embedded", name: "embedded" } }

const caps = { webSearch: false, webFetch: false, files: "own" as const, shellList: true, deltas: true }
const ENGINES: EngineTopic = {
  agents: {},
  engines: {
    "claude-code": { label: "Claude Code", minVersion: "2.1.300", check: { ok: true, version: "2.1.316" }, capabilities: caps, signedIn: true, modelsReadAt: CLOCK },
    codex: { label: "Codex", minVersion: "0.160.0", check: { ok: true, version: "0.165.0" }, capabilities: caps, signedIn: true, modelsReadAt: CLOCK },
    grok: { label: "Grok", minVersion: "1.0.60", check: { ok: true, version: "1.0.70" }, capabilities: caps, signedIn: true, modelsReadAt: CLOCK },
    opencode: { label: "OpenCode", minVersion: "1.19.0", check: { ok: true, version: "1.19.5" }, capabilities: caps, signedIn: true, needsModel: true, modelsReadAt: CLOCK },
    pi: { label: "Pi", minVersion: "1.4.0", check: { ok: true, version: "1.4.0" }, capabilities: caps, signedIn: true, needsModel: true, modelsReadAt: CLOCK },
  },
}
const AGENT = {
  name: "agent-a",
  limits: { perTradeUsd: 10, perDayUsd: 50 },
  limitLines: [
    { by: "Harness", what: "trade", words: "Harness · $10.00 a trade" },
    { by: "Harness", what: "day", words: "Harness · $50.00 a day · $0.00 used" },
    { by: "Candle", what: "volume", words: "Candle · $50.00 a day (UTC) · $0.00 used" },
  ],
}
const AUTONOMY: AutonomyTopic = { wallets: [{ wallet: EMBEDDED, name: "main", kind: "embedded", setting: "ask", usedTodayUsd: 0, agents: ["agent-a"], notes: [] }] } as unknown as AutonomyTopic
const portfolio = (sol: number) => ({ readAt: CLOCK, wallets: [{ address: EMBEDDED, chain: "solana", kind: "embedded", name: "main", agents: ["agent-a"], active: true, sol: sol ? { amount: sol, usd: sol * 150 } : null, tokens: [] }], readOnly: [], paper: [] })

/** A session that answers onboarding's methods as a core would, and keeps what it was asked. */
class SetupSession extends SceneSession {
  view: OnboardingView
  constructor(view: OnboardingView) {
    super()
    this.view = view
  }
  private passing(step: string): OnboardingView {
    this.view = onboardingProgress({ ...this.view.state, passed: [...this.view.state.passed, step as never] }, this.view.facts)
    return this.view
  }
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === "onboarding.get") return this.view as T
    if (method === "onboarding.set") {
      if ("passed" in params) return this.passing(params.passed as string) as T
      const s = this.view.state
      const next: OnboardingState = "vaultChoice" in params ? { ...s, vaultChoice: params.vaultChoice as "now" | "later" } : "agent" in params ? { ...s, agent: { name: params.agent as string, askedAt: new Date(CLOCK).toISOString() } } : s
      this.view = onboardingProgress(next, this.view.facts)
      return this.view as T
    }
    if (method === "onboarding.limits") return this.passing("limits") as T
    if (method === "onboarding.paper") return this.passing("fund") as T
    if (method === "cli.run") return { kind: "pane", ticket: "chp_fake", ticketId: `t-${(params.argv as string[]).slice(0, 2).join("-")}`, title: `candle ${(params.argv as string[]).join(" ")} · the agent can't see this pane` } as T
    if (method === "wallets.name") return { said: `Named ${String(params.name)}.` } as T
    return {} as T
  }
}

/** A pane process that prints what a CLI would, and stays open. */
function fakePane(screen: string): PaneProcess {
  const bytes = new TextEncoder().encode(screen)
  return { pid: 4242, write: () => {}, resize: () => {}, onData: (l) => l(bytes), exited: new Promise(() => {}), signal: () => {}, close: () => {} }
}

async function draw(width: number, height: number, view: OnboardingView, opts: { pane?: string; straightIn?: boolean; agents?: unknown[]; sol?: number } = {}) {
  const session = new SetupSession(view)
  const spawnPane = () => fakePane(opts.pane ?? "")
  const s = await testRender(<App session={session} onQuit={() => {}} now={() => CLOCK} tickMs={0} spawnPane={spawnPane} onboarding={{ straightIn: opts.straightIn === true, asked: false }} />, { width, height, exitOnCtrlC: false })
  setup = s
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => session.push(topic, data, snapshot))
    await s.renderOnce()
  }
  await s.renderOnce()
  await push("status", { agents: opts.agents ?? [], activeAgent: opts.agents?.length ? "agent-a" : "", mode: "paper", setup: !opts.agents?.length, paused: false }, true)
  await push("engine", ENGINES, true)
  await push("autonomy", AUTONOMY, true)
  await push("portfolio", portfolio(opts.sol ?? 0), true)
  await push("onboarding", view, true)
  await settle(s)
  return { s, session, push }
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
      else if (key === "up" || key === "down") s.mockInput.pressArrow(key)
      else if (key === "backspace") s.mockInput.pressBackspace()
      else s.mockInput.typeText(key)
    })
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
  [120, 30],
  [80, 24],
] as const

async function each(name: string, view: () => OnboardingView, opts: Parameters<typeof draw>[3] = {}, check?: (frame: string, width: number) => void) {
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, view(), opts)
    await compare(`onboarding-${w}x${h}-${name}`, s)
    check?.(s.captureCharFrame(), w)
    await act(async () => s.dispose())
    setup = undefined
  }
}

test("a vault now, or the embedded wallet only: both say what they mean, and each asks the core for the choice; a vault now opens vault init in the pane", async () => {
  await each("vault", () => onboardingProgress(state([]), facts()), {}, (f) => {
    expect(f).toContain("A vault now, or the embedded wallet only for now?")
    expect(f).toContain("Funds out go through Candle's site.")
  })
  let d = await draw(120, 30, onboardingProgress(state([]), facts()))
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").map((r) => r.params)).toEqual([{ vaultChoice: "later" }])
  expect(d.session.requests.some((r) => r.method === "cli.run")).toBe(false)
  await act(async () => d.s.dispose())
  d = await draw(120, 30, onboardingProgress(state([]), facts()), { pane: "Your vault passphrase is about to be generated and shown once.\r\n" })
  await press(d.s, "down", "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set" || r.method === "cli.run").map((r) => r.params)).toEqual([{ vaultChoice: "now" }, { argv: ["vault", "init"] }])
  await compare("onboarding-120x30-vault-pane", d.s)
})

test("a vault that exists is shown and the question skipped: the key takes its factor first", async () => {
  await each("key-vault", () => onboardingProgress(state([]), facts({ vault: "present" })), {}, (f, w) => {
    expect(f).toContain("your vault's factor first, in the pane")
    // At 80×24 it's below the fold, reached by ↓.
    if (w === 120) expect(f).toContain("Add a security key")
  })
})

test("the agent's key: a name and Candle's cap on the create, then keys create in the pane; the name is asked for first", async () => {
  await each("key", () => onboardingProgress(state([], { vaultChoice: "later" }), facts()), {}, (f) => {
    expect(f).toContain("candle keys create --label agent-a --tx-limit 50 --reset daily")
    expect(f).toContain("no vault: approved by you in the pane")
  })
  const d = await draw(120, 30, onboardingProgress(state([], { vaultChoice: "later" }), facts()))
  // The name typed over the default (a "!" isn't a name's), then the cap: ⏎ on each goes on to the next.
  await press(d.s, "backspace", "b", "o", "t", "!", "enter")
  await press(d.s, "backspace", "backspace", "2", "5", "enter")
  expect(d.s.captureCharFrame()).toContain("candle keys create --label agent-bot --tx-limit 25 --reset daily")
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set" || r.method === "cli.run").map((r) => r.params)).toEqual([{ agent: "agent-bot" }, { argv: ["keys", "create", "--label", "agent-bot", "--tx-limit", "25", "--reset", "daily"] }])
  await act(async () => d.s.dispose())
  setup = undefined
  // No cap: the cap emptied leaves the flags off.
  const e = await draw(120, 30, onboardingProgress(state([], { vaultChoice: "later" }), facts()))
  await press(e.s, "down", "backspace", "backspace")
  expect(e.s.captureCharFrame()).toMatch(/candle keys create --label agent-a +│/)
})

test("a key made but not stored is offered for revoking, and nothing makes another", async () => {
  const view = () => onboardingProgress(state([], { vaultChoice: "later", agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() } }), facts({ key: { state: "made-not-stored", prefixes: ["FakeKey9"] } }))
  await each("key-revoke", view, {}, (f) => expect(f).toContain("Revoke FakeKey9"))
  const d = await draw(120, 30, view())
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "cli.run").map((r) => r.params)).toEqual([{ argv: ["keys", "revoke", "FakeKey9"] }])
})

test("a new account's wallet not authorized for agents: setup says what to do on Candle's site, with the link and Try again", async () => {
  const view = () => onboardingProgress(state([], { vaultChoice: "later", agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() } }), facts({ keyRefused: "AGENT_WALLET_NOT_DELEGATED" }))
  await each("key-not-delegated", view, {}, (f) => {
    expect(f).toContain("Create key and authorize")
    expect(f).toContain("Try again")
  })
  const d = await draw(120, 30, view())
  // The link first, copied; then Try again makes the key as before.
  await press(d.s, "enter")
  expect(d.s.captureCharFrame()).toContain("Copied the Agent Console's link.")
  await press(d.s, "down", "enter")
  const runs = d.session.requests.filter((r) => r.method === "cli.run").map((r) => (r.params as { argv: string[] }).argv)
  expect(runs.map((a) => a.slice(0, 4))).toEqual([["keys", "create", "--label", "agent-a"]])
})

test("the wallet: the embedded wallet allowed in the pane, the key's prefix to type back; a wallet of its own on Max with a vault key, and why not on Free", async () => {
  const later = state([], { vaultChoice: "later", agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() } })
  await each("wallet-free", () => onboardingProgress(later, facts({ ...STORED, wallet: { state: "none", embedded: "denied" }, plan: "free" })), { agents: [AGENT] }, (f) => expect(f).toContain("needs a vault first (Pro or Max)"))
  await each("wallet-max", () => onboardingProgress(later, facts({ ...STORED, vault: "present", wallet: { state: "none", embedded: "denied" }, plan: "max", vaultKey: "cold" })), { agents: [AGENT] }, (f) => expect(f).toContain("a TEE wallet, from your vault key cold"))
  const screen = "Embedded wallet change\r\n\r\n  Key              agent-a (FakeKey1)\r\n  Embedded wallet  denied  ->  allowed   (widen)\r\n\r\nType the key prefix FakeKey1 to allow it: "
  const d = await draw(120, 30, onboardingProgress(later, facts({ ...STORED, wallet: { state: "none", embedded: "denied" }, plan: "free" })), { agents: [AGENT], pane: screen })
  // Its name first (past the prefix's copy row), then the allow: the name goes on once the wallet's address is known.
  await press(d.s, "down", "down", "m", "a", "i", "n", "up", "up", "enter")
  expect(d.session.requests.filter((r) => r.method === "cli.run").map((r) => r.params)).toEqual([{ argv: ["keys", "update", "FakeKey1", "--embedded-wallet", "allow"] }])
  await compare("onboarding-120x30-wallet-pane", d.s)
  expect(d.s.captureCharFrame()).toContain("type FakeKey1 at the CLI's prompt")
  d.session.view = onboardingProgress(later, facts(PAYABLE))
  await d.push("onboarding", d.session.view)
  await settle(d.s)
  expect(d.session.requests.filter((r) => r.method === "wallets.name").map((r) => r.params)).toEqual([{ wallet: EMBEDDED, name: "main" }])
  await act(async () => d.s.dispose())
  setup = undefined
  // On Max with a vault key: promoted from it, its name as Candle's label.
  const m = await draw(120, 30, onboardingProgress(later, facts({ ...STORED, vault: "present", wallet: { state: "none", embedded: "denied" }, plan: "max", vaultKey: "cold" })), { agents: [AGENT] })
  await press(m.s, "down", "down", "down", "d", "e", "s", "k", "up", "enter")
  expect(m.session.requests.filter((r) => r.method === "cli.run").map((r) => r.params)).toEqual([{ argv: ["vault", "promote", "--to-key", "FakeKey1", "--label", "desk", "--from", "cold"] }])
})

test("limits, each with who holds it: the Candle Harness's two typed, Candle's cap as set on the key, Candle's other limits named", async () => {
  const view = () => onboardingProgress(state([], { vaultChoice: "later", agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() } }), facts(PAYABLE))
  await each("limits", view, { agents: [AGENT] }, (f) => {
    expect(f).toContain("$50.00 a day (UTC)")
    expect(f).toContain("Candle's Agent Console")
  })
  const d = await draw(120, 30, view(), { agents: [AGENT] })
  // ↓ from Use these limits to the figures; ⏎ after the last goes back to it.
  await press(d.s, "down", "backspace", "backspace", "5", "enter", "backspace", "5", "enter", "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.limits").map((r) => r.params)).toEqual([{ perTradeUsd: 5, perDayUsd: 55 }])
})

test("approvals, as the approvals menu: on ask every time; trade inside limits takes its two figures and sets them as the menu does", async () => {
  const view = () => onboardingProgress(state(["limits"], { vaultChoice: "later", agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() } }), facts(PAYABLE))
  await each("approvals", view, { agents: [AGENT] }, (f) => {
    expect(f).toContain("● ask every time")
    // The kill switch holds buys and swaps, not everything: sells still go.
    const flat = f.replace(/[│\s]+/g, " ")
    expect(flat).toContain("the kill switch still holds buys and")
    expect(flat).toContain("sells still go.")
    expect(flat).not.toContain("stops it all")
  })
  let d = await draw(120, 30, view(), { agents: [AGENT] })
  // Continue is first, with ⏎ on it.
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").map((r) => r.params)).toEqual([{ passed: "approvals" }])
  expect(d.session.requests.some((r) => r.method === "autonomy.set")).toBe(false)
  await act(async () => d.s.dispose())
  setup = undefined
  d = await draw(120, 30, view(), { agents: [AGENT] })
  // To trade inside limits, its two figures, then ↓ round to Turn it on and continue, first.
  await press(d.s, "down", "down", "enter", "down", "1", ".", "5", "0", "down", "3", "down")
  // Sells are named apart: they run without a card whatever the figures say.
  const picked = d.s.captureCharFrame().replace(/[│\s]+/g, " ")
  expect(picked).toContain("buys and swaps inside two figures of its own run without a card; every sell")
  expect(picked).toContain("runs without one, whatever its size, unless slippage is looser:")
  expect(picked).not.toContain("buys, sells and swaps inside two figures")
  await compare("onboarding-120x30-approvals-inside", d.s)
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "autonomy.set").map((r) => r.params)).toEqual([{ wallet: EMBEDDED, setting: "inside", perTradeUsd: 1.5, perDayUsd: 3 }])
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").map((r) => r.params)).toEqual([{ passed: "approvals" }])
})

test("fund it, now or later: the address with ⧉, a deposit moving it on by itself, or fund it later; setup ends live either way", async () => {
  const view = () => onboardingProgress(state(["limits", "approvals"], { vaultChoice: "later", agent: { name: "agent-a", askedAt: new Date(CLOCK).toISOString() } }), facts(PAYABLE))
  await each("fund", view, { agents: [AGENT] }, (f) => {
    expect(f).toContain("Fund main")
    expect(f).not.toContain("paper")
    expect(f).toContain("waiting for a deposit")
    expect(f).toContain("Fund it later")
  })
  let d = await draw(120, 30, view(), { agents: [AGENT] })
  await press(d.s, "down", "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.fundLater")).toHaveLength(1)
  await act(async () => d.s.dispose())
  setup = undefined
  // A deposit lands on the fake: the step goes on with nothing pressed.
  d = await draw(120, 30, view(), { agents: [AGENT] })
  expect(d.session.requests.some((r) => r.method === "onboarding.set")).toBe(false)
  await d.push("portfolio", portfolio(0.25))
  await settle(d.s)
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").map((r) => r.params)).toEqual([{ passed: "fund" }])
  await act(async () => d.s.dispose())
  setup = undefined
  // A wallet that held SOL when the part opened isn't gone past unseen: funded, with Continue.
  d = await draw(120, 30, view(), { agents: [AGENT], sol: 1.5 })
  await d.push("portfolio", portfolio(1.75))
  await settle(d.s)
  expect(d.session.requests.some((r) => r.method === "onboarding.set")).toBe(false)
  expect(d.s.captureCharFrame()).toContain("✓ 1.75 SOL  funded")
  // Funded, there's nothing to put off: Continue alone, and the words say live.
  expect(d.s.captureCharFrame()).not.toContain("Fund it later")
  expect(d.s.captureCharFrame().replace(/[│\s]+/g, " ")).toContain("The Candle Harness starts live")
  await compare("onboarding-120x30-fund-funded", d.s)
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").map((r) => r.params)).toEqual([{ passed: "fund" }])
})

test("Straight in at 80×24: the vault skipped, the key made with no vault, the tour and where to start skipped", async () => {
  const view = onboardingProgress(state([], { straightIn: true }), facts())
  const d = await draw(80, 24, view, { straightIn: true })
  await compare("onboarding-80x24-straight-key", d.s)
  const f = d.s.captureCharFrame()
  expect(f).toContain("STRAIGHT IN")
  expect(f).toContain("no vault: approved by you in the pane")
  // Done once the key is stored: the screen gives way to the Candle Harness.
  d.session.view = onboardingProgress(view.state, facts({ ...STORED }))
  await d.push("onboarding", d.session.view)
  await settle(d.s)
  expect(d.s.captureCharFrame()).not.toContain("STRAIGHT IN")
})

test("the key's prefix has its look-alike characters named, so a zero isn't typed as an o", () => {
  expect(lookAlikes("9pr0v7tO")).toBe("0 is a zero, O a capital o")
  expect(lookAlikes("Ab3_x9Zq")).toBeUndefined()
  expect(lookAlikes("lI1")).toBe("1 is a one, l a small L, I a capital i")
})

test("a setup pane that ended without its step done says setup offers it again, by how its operation ended", () => {
  // The launcher exits 0 when the CLI refused, so the operation decides.
  expect(setupPaneFailed({ exited: 0 }, { state: "refused" })).toBe(true)
  expect(setupPaneFailed({ exited: 0 }, { state: "succeeded" })).toBe(false)
  expect(setupPaneFailed({ exited: 0 }, { state: "pending" })).toBe(false)
  expect(setupPaneFailed({}, { state: "refused" })).toBe(false)
  expect(setupPaneFailed({ exited: 1 }, undefined)).toBe(true)
})
