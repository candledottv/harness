// Onboarding's screen: the rail and the step, for the welcome, the Candle sign-in's three cases with its device
// code in the pane, and connecting your agent with a harness's sign-in, the subscription notice and the test
// message. Kept as frames at 120×30 and 80×24, as the other frame tests keep theirs; and what each choice asks of
// the core.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { CLOCK, SceneSession } from "../../test/frame-scenes"
import { freshState, onboardingProgress, type OnboardingFacts, type OnboardingState, type OnboardingView } from "../setup/onboarding"
import { App } from "./app"
import type { PaneProcess } from "./pane-process"
import type { EngineTopic } from "./panes/engines"
import { codeFrom } from "./onboarding"

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
const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({ signIn: { state: "signed-out", code: "NOT_SIGNED_IN" }, vault: "missing", key: { state: "none" }, wallet: { state: "unknown" }, ...over })
const at = (passed: OnboardingState["passed"], over: Partial<OnboardingState> = {}): OnboardingState => ({ ...freshState(CLOCK), passed, ...over })
const SIGNED: Partial<OnboardingFacts> = { signIn: { state: "signed-in", account: ACCOUNT, profile: "candle-harness" }, profile: "candle-harness" }

const caps = { webSearch: false, webFetch: false, files: "own" as const, shellList: true, deltas: true }
const ENGINES: EngineTopic = {
  agents: {},
  engines: {
    "claude-code": { label: "Claude Code", minVersion: "2.1.300", check: { ok: true, version: "2.1.316" }, capabilities: caps, signedIn: true, modelsReadAt: CLOCK },
    codex: { label: "Codex", minVersion: "0.160.0", check: { ok: true, version: "0.165.0" }, capabilities: caps, signedIn: false, signIn: "codex login", modelsReadAt: CLOCK },
    grok: { label: "Grok", minVersion: "1.0.60", check: { ok: true, version: "1.0.70" }, capabilities: caps, signedIn: true, modelsReadAt: CLOCK },
    opencode: { label: "OpenCode", minVersion: "1.19.0", check: { ok: true, version: "1.19.5" }, capabilities: caps, signedIn: false, needsModel: true, modelsReadAt: CLOCK },
    pi: { label: "Pi", minVersion: "1.4.0", check: { ok: false, message: "Pi isn't installed (no \"pi\" found)." }, capabilities: caps, signedIn: null, needsModel: true, modelsReadAt: null },
  },
}
const MODELS = [
  { id: "sonnet", label: "Claude Sonnet 5.5", isDefault: true },
  { id: "opus", label: "Claude Opus 5.5" },
  { id: "haiku", label: "Claude Haiku 5.5" },
]

/** A session that answers onboarding's methods as a core would, and keeps what it was asked. */
class SetupSession extends SceneSession {
  view: OnboardingView
  /** Holds engine.models' answer until it settles, as a slow harness's list does. */
  modelsGate: Promise<void> = Promise.resolve()
  constructor(view: OnboardingView) {
    super()
    this.view = view
  }
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === "onboarding.get") return this.view as T
    if (method === "onboarding.set") {
      const s = this.view.state
      // Esc's step back, as the core does it for the steps that were choices.
      if (params.back === true) {
        if (s.passed.length === 0) throw new Error("This is the first step.")
        this.view = onboardingProgress({ ...s, passed: s.passed.slice(0, -1) }, this.view.facts)
        return this.view as T
      }
      const state: OnboardingState =
        "passed" in params ? { ...s, passed: [...s.passed, params.passed as never] } : "engine" in params ? { ...s, engine: params.engine as never, ...(params.model ? { model: params.model as string } : {}) } : "straightIn" in params ? { ...s, straightIn: params.straightIn as boolean } : s
      const f = "profile" in params ? { ...this.view.facts, profile: params.profile as string } : this.view.facts
      this.view = onboardingProgress(state, f)
      return this.view as T
    }
    if (method === "engine.models") {
      await this.modelsGate
      return { engine: params.engine, models: MODELS } as T
    }
    if (method === "onboarding.signIn") return { profile: "candle-harness", opened: { ticket: "chp_fake", ticketId: "t-signin", title: "candle auth login --profile candle-harness --api-url https://api.alpha.candle.tv · the agent can't see this pane", card: { opId: "op1" } } } as T
    if (method === "onboarding.harness") return { ticket: "chp_fake2", ticketId: "t-harness", title: `${params.engine} login · your own sign-in` } as T
    if (method === "onboarding.test") {
      const state = { ...this.view.state, tested: { engine: this.view.state.engine!, ...(this.view.state.model ? { model: this.view.state.model } : {}), at: new Date(CLOCK).toISOString() } }
      this.view = onboardingProgress(state, this.view.facts)
      return { ok: true, ms: 2400, reply: "ok", view: this.view } as T
    }
    return {} as T
  }
}

/** A pane process that prints what a CLI would, and stays open. */
function fakePane(screen: string, exits = false): PaneProcess {
  const listeners: ((c: Uint8Array) => void)[] = []
  const bytes = new TextEncoder().encode(screen)
  return {
    pid: 4242,
    write: () => {},
    resize: () => {},
    onData(l) {
      listeners.push(l)
      l(bytes)
    },
    exited: exits ? Promise.resolve(0) : new Promise(() => {}),
    signal: () => {},
    close: () => {},
  }
}

async function draw(width: number, height: number, view: OnboardingView, opts: { pane?: string; paneExits?: boolean } = {}) {
  const session = new SetupSession(view)
  const spawned: { ticket: string }[] = []
  const spawnPane = ({ ticket }: { ticket: string }) => {
    spawned.push({ ticket })
    return fakePane(opts.pane ?? "", opts.paneExits)
  }
  const s = await testRender(<App session={session} onQuit={() => {}} now={() => CLOCK} tickMs={0} spawnPane={spawnPane} onboarding={{ straightIn: false, asked: false }} />, { width, height, exitOnCtrlC: false })
  setup = s
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => session.push(topic, data, snapshot))
    await s.renderOnce()
  }
  await s.renderOnce()
  await push("status", { agents: [], activeAgent: "", mode: "paper", setup: true, paused: false }, true)
  await push("engine", ENGINES, true)
  await push("onboarding", view, true)
  await settle(s)
  return { s, session, push, spawned }
}

async function settle(s: Setup) {
  for (let i = 0; i < 4; i++) {
    await act(async () => Bun.sleep(5))
    await s.renderOnce()
  }
}

async function press(s: Setup, key: "down" | "up" | "enter") {
  await act(async () => (key === "enter" ? s.mockInput.pressEnter() : s.mockInput.pressArrow(key)))
  await settle(s)
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

test("the welcome: guided setup or straight in, and straight in asks the core for both", async () => {
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, onboardingProgress(at([]), facts()))
    // The welcome says what setup needs and an honest time, before the first step.
    const welcome = s.captureCharFrame().replace(/[│\s]+/g, " ")
    expect(welcome).toContain("You need one AI coding tool with its own account: Claude Code, Codex, Grok,")
    expect(welcome).toContain("about 5 minutes; longer if you")
    expect(welcome).not.toContain("3 minutes")
    expect(welcome).toContain("then straight to trading")
    expect(welcome).not.toContain("paper")
    await compare(`onboarding-${w}x${h}-welcome`, s)
    const frame = s.captureCharFrame()
    expect(frame).toContain("Welcome to Candle")
    expect(frame).toContain(w >= 100 ? "Setup" : "▸ 0 Welcome")
    await act(async () => s.dispose())
    setup = undefined
  }
  const { s, session } = await draw(120, 30, onboardingProgress(at([]), facts()))
  await press(s, "down")
  await press(s, "enter")
  expect(session.requests.filter((r) => r.method === "onboarding.set").map((r) => r.params)).toEqual([{ straightIn: true }, { passed: "welcome" }])
})

test("sign in: the CLI's own account offered, several profiles listed, or a new one by Candle's device code in the pane", async () => {
  const signedHere: Partial<OnboardingFacts> = { signIn: { state: "signed-in", account: ACCOUNT, profile: "production" }, profiles: [{ name: "production", active: true, account: ACCOUNT, apiUrl: "https://api.alpha.candle.tv" }] }
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, onboardingProgress(at(["welcome"]), facts(signedHere)))
    await compare(`onboarding-${w}x${h}-signin-signed`, s)
    await act(async () => s.dispose())
    setup = undefined
  }
  // Use this account: the profile, recorded by the core.
  let d = await draw(120, 30, onboardingProgress(at(["welcome"]), facts(signedHere)))
  await press(d.s, "enter")
  expect(d.session.requests.find((r) => r.method === "onboarding.set")?.params).toEqual({ profile: "production" })
  await act(async () => d.s.dispose())
  setup = undefined

  const several: Partial<OnboardingFacts> = {
    signIn: { state: "signed-out", code: "PROFILE_UNRESOLVED" },
    profiles: [
      { name: "production", active: false, account: ACCOUNT, apiUrl: "https://api.alpha.candle.tv" },
      { name: "desk", active: false, account: "WalletFake222222222222222222222222222222222", apiUrl: "https://api.alpha.candle.tv" },
      { name: "old", active: false },
    ],
  }
  d = await draw(120, 30, onboardingProgress(at(["welcome"]), facts(several)))
  await compare("onboarding-120x30-signin-several", d.s)
  await act(async () => d.s.dispose())
  setup = undefined

  // A new profile: Candle's own screen in the pane, inside the step, with ⧉ chips for its code and link.
  const candle = "Authorize this device\r\n\r\n  API          https://api.alpha.candle.tv\r\n  Device code  WXYZ-4821\r\n  Approve at   https://alpha.candle.tv/dev/agent/device?code=WXYZ-4821\r\n"
  for (const [w, h] of SIZES) {
    d = await draw(w, h, onboardingProgress(at(["welcome"]), facts({ profiles: [] })), { pane: candle })
    expect(d.s.captureCharFrame()).toContain("Candle signs this machine in with a device code")
    await press(d.s, "enter")
    expect(d.session.requests.some((r) => r.method === "onboarding.signIn")).toBe(true)
    expect(d.spawned).toEqual([{ ticket: "chp_fake" }])
    expect(d.session.requests.find((r) => r.method === "pane.spawned")?.params).toEqual({ ticketId: "t-signin", pid: 4242 })
    const frame = d.s.captureCharFrame()
    expect(frame).toContain("Device code  WXYZ-4821")
    expect(frame).toContain("⧉ code")
    await compare(`onboarding-${w}x${h}-signin-pane`, d.s)
    await act(async () => d.s.dispose())
    setup = undefined
  }
})

test("connect your agent: each engine as the picker reads it, a sign-in for one that isn't, an install line for one that's missing, then one test message", async () => {
  const view = onboardingProgress(at(["welcome"], { engine: "claude-code" }), facts(SIGNED))
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, view)
    await compare(`onboarding-${w}x${h}-engine`, s)
    await act(async () => s.dispose())
    setup = undefined
  }
  const d = await draw(120, 30, view)
  const frame = d.s.captureCharFrame()
  expect(frame).toContain("Claude Code 2.1.316 · signed in")
  expect(frame).toContain("sonnet · Claude Sonnet 5.5 · default")
  expect(frame).toContain("Codex 0.165.0 · not signed in")
  expect(frame).toContain("Pi · not installed")
  // The model's coding tool is an engine on screen; "harness" is the product's name alone.
  expect(frame).toContain("Your agent runs on an engine: an AI coding tool you already use")
  expect(frame).not.toContain("runs on a harness")
  // Down to the test message (Claude Code, its three models, Codex, Grok, OpenCode, Pi's install line, then the test).
  for (let i = 0; i < 8; i++) await press(d.s, "down")
  await press(d.s, "enter")
  expect(d.session.requests.some((r) => r.method === "onboarding.test")).toBe(true)
  expect(d.s.captureCharFrame()).toContain("Claude Code answered in 2.4 s:")
  await compare("onboarding-120x30-engine-tested", d.s)
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").at(-1)?.params).toEqual({ passed: "engine" })
})

test("no keychain (WSL, say): only the fix, the line to copy, then start again; nothing that can't work", async () => {
  const said = "No keychain available and no CANDLE_KEYRING_PASSPHRASE set; set it to use the encrypted file store on this machine"
  // The line names the shell's own file: bash here, so the frames are the same on any machine.
  const shell = process.env.SHELL
  process.env.SHELL = "/bin/bash"
  for (const [w, h] of SIZES) {
    const { s } = await draw(w, h, onboardingProgress(at(["welcome"]), facts({ signIn: { state: "unreadable", said } })))
    const frame = s.captureCharFrame()
    expect(frame).toContain("This machine has no keychain")
    expect(frame).toContain("⧉ Copy the line")
    // The passphrase goes into the file in an editor: no command that appends it, which would leave it in the
    // shell's history; and the file is closed to others.
    expect(frame).not.toContain("echo ")
    expect(frame).not.toContain(">>")
    expect(frame).toContain('export CANDLE_KEYRING_PASSPHRASE="<a passphrase of your own>"')
    expect(frame).toContain("⧉ chmod 600 ~/.bashrc")
    // Or no owner sign-in here at all.
    expect(frame).toContain("keep the owner sign-in off this machine")
    expect(frame).toContain("⧉ candle-harness key add --agent agent-a")
    expect(frame).toContain("This isn't a vault's passphrase.")
    expect(frame).not.toContain("Read it again")
    expect(frame).not.toContain("a new profile, by Candle's device code")
    expect(frame).not.toContain("docs/install.md")
    await compare(`onboarding-${w}x${h}-signin-no-keychain`, s)
    await act(async () => s.dispose())
    setup = undefined
  }
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
})

test("picking a model moves the highlight to the test message, and Esc goes back a step", async () => {
  const d = await draw(120, 30, onboardingProgress(at(["welcome"], { engine: "claude-code" }), facts(SIGNED)))
  // Claude Code, then its models: opus is the second.
  await press(d.s, "down")
  await press(d.s, "down")
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").at(-1)?.params).toEqual({ engine: "claude-code", model: "opus" })
  expect(d.s.captureCharFrame()).toContain("⏎ sends one word to test it, then you go on.")
  await press(d.s, "enter")
  expect(d.session.requests.some((r) => r.method === "onboarding.test")).toBe(true)
  // Esc: back to the welcome, the step before (the sign-in is done on Candle and stepped over by the fake).
  await act(async () => {
    d.s.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  await settle(d.s)
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").at(-1)?.params).toEqual({ back: true })
  expect(d.s.captureCharFrame()).toContain("Guided setup")
  // At the first step, Esc says so, plainly.
  await act(async () => {
    d.s.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  await settle(d.s)
  expect(d.s.captureCharFrame()).toContain("This is the first step.")
})

test("picking an engine whose models land a moment later keeps the highlight on the test message, and a press while the core answers is said and not taken twice", async () => {
  const d = await draw(120, 30, onboardingProgress(at(["welcome"], { engine: "grok" }), facts(SIGNED)))
  let release = () => {}
  d.session.modelsGate = new Promise<void>((r) => (release = r))
  // The highlight starts on Claude Code's row: picking it, with its models not read yet.
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").at(-1)?.params).toEqual({ engine: "claude-code" })
  await act(async () => release())
  await settle(d.s)
  const frame = d.s.captureCharFrame()
  expect(frame).toContain("haiku · Claude Haiku 5.5")
  // The ▸ is on the test message, not on a model the list slid under it.
  expect(frame.split("\n").find((l) => l.includes("▸") && !l.includes("Connect your agent"))).toContain("Send a test message")
  // Enter sends the test on the engine as picked: no model was chosen on the way.
  await press(d.s, "enter")
  expect(d.session.requests.filter((r) => r.method === "onboarding.set").at(-1)?.params).toEqual({ engine: "claude-code" })
  expect(d.session.requests.filter((r) => r.method === "onboarding.test")).toHaveLength(1)
})

test("a harness's sign-in: Codex's opens at once; OpenCode's says first that subscriptions there are held back", async () => {
  const view = onboardingProgress(at(["welcome"]), facts(SIGNED))
  let d = await draw(120, 30, view, { pane: "Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   https://auth.openai.com/codex/device\r\n\r\n2. Enter this one-time code (expires in 15 minutes)\r\n   KQ4M-T7ZRB\r\n" })
  // Claude Code, Codex: Codex's sign-in is the second choice.
  await press(d.s, "down")
  await press(d.s, "enter")
  expect(d.session.requests.find((r) => r.method === "onboarding.harness")?.params).toEqual({ engine: "codex" })
  expect(d.s.captureCharFrame()).toContain("KQ4M-T7ZRB")
  await compare("onboarding-120x30-harness-pane", d.s)
  await act(async () => d.s.dispose())
  setup = undefined

  d = await draw(120, 30, view)
  for (let i = 0; i < 3; i++) await press(d.s, "down")
  await press(d.s, "enter")
  expect(d.session.requests.some((r) => r.method === "onboarding.harness")).toBe(false)
  expect(d.s.captureCharFrame()).toContain("won't be used")
  await compare("onboarding-120x30-opencode-before", d.s)
  await press(d.s, "enter")
  expect(d.session.requests.find((r) => r.method === "onboarding.harness")?.params).toEqual({ engine: "opencode" })
})

test("a harness's sign-in that worked closes its pane by itself, and the highlight goes to the test message", async () => {
  const view = onboardingProgress(at(["welcome"]), facts(SIGNED))
  // Signed in: the pane's launcher ends, and the core says Codex is signed in.
  let d = await draw(120, 30, view, { pane: "Signed in.\r\n", paneExits: true })
  await press(d.s, "down")
  await press(d.s, "enter")
  await d.push("engine", { ...ENGINES, engines: { ...ENGINES.engines, codex: { ...ENGINES.engines.codex!, signedIn: true } } })
  await act(async () => Bun.sleep(1_400))
  await settle(d.s)
  let frame = d.s.captureCharFrame()
  expect(frame).toContain("Signed in to Codex. ⏎ sends a test message.")
  expect(frame).not.toContain("⏎ or Esc closes")
  expect(frame).toMatch(/▸ Send a test message/)
  await act(async () => d.s.dispose())
  setup = undefined

  // Not signed in when the launcher ends: the pane stays, its words to read, and Enter closes it as before.
  d = await draw(120, 30, view, { pane: "Didn't finish.\r\n", paneExits: true })
  await press(d.s, "down")
  await press(d.s, "enter")
  await act(async () => Bun.sleep(1_400))
  await settle(d.s)
  frame = d.s.captureCharFrame()
  expect(frame).toContain("Didn't finish.")
  expect(frame).not.toContain("Signed in to Codex")
})

test("the hint under a pane says ctrl-] and Ctrl-C while it runs, and that ⏎ or Esc closes it once it has finished", async () => {
  const view = onboardingProgress(at(["welcome"]), facts(SIGNED))
  for (const exits of [false, true]) {
    const d = await draw(120, 30, view, { pane: "Signed in.\r\n", paneExits: exits })
    await press(d.s, "down")
    await press(d.s, "enter")
    const hint = d.s.captureCharFrame().split("\n").at(-2) ?? ""
    expect(hint).toContain(exits ? "⏎ or Esc closes the pane" : "ctrl-] back to setup · Ctrl-C stops it")
    await act(async () => d.s.dispose())
    setup = undefined
  }
})

test("a device code and its link are read from what the pane printed: Candle's, Codex's and Grok's screens as recorded from each", () => {
  expect(codeFrom("Authorize this device\n\n  API          https://api.alpha.candle.tv\n  Device code  BQSV-P2AN\n  Approve at   https://alpha.candle.tv/dev/agent/device?code=BQSV-P2AN\n")).toEqual({ code: "BQSV-P2AN", url: "https://alpha.candle.tv/dev/agent/device?code=BQSV-P2AN" })
  expect(codeFrom("1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   TTA7-DOY2C\n")).toEqual({ code: "TTA7-DOY2C", url: "https://auth.openai.com/codex/device" })
  expect(codeFrom("To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=AHEP-N3AQ\n\nConfirm this code in your browser:\n\n  AHEP-N3AQ\n")).toEqual({ code: "AHEP-N3AQ", url: "https://accounts.x.ai/oauth2/device?user_code=AHEP-N3AQ" })
  expect(codeFrom("\x1b[1mnothing here\x1b[0m")).toEqual({})
})
