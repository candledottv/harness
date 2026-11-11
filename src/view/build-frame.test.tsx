// The Build tab, drawn: its first open (the folder and the harness, then the files written), the harness running in
// its pane beside the bots folder and the test run, the strip it folds to below 100 columns, and "it exited". The
// harness is a stand-in that prints what a harness would; the folder is written into a home of the test's own.
import { afterEach, beforeAll, afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { advanceClock, card as tradeCard, CLOCK, drawScene, EMBEDDED, engineTopic, status } from "../../test/frame-scenes"
import type { ViewCard } from "./store"
import type { BuildSpawner } from "./build-process"
import type { PaneProcess, PaneSpawner } from "./pane-process"
import { memoryStore, type LayoutStore } from "./layouts-store"
import { KNOWN_TABS, layoutsText } from "./layouts-file"

const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

/** The frame's characters and colours, against the one kept; a new one is kept only when asked. */
async function compareFrame(name: string, s: Setup): Promise<void> {
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

process.env.TZ = "UTC"
const realHome = process.env.HOME
let home = ""
beforeAll(() => {
  home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "chrn-build-"))
  process.env.HOME = home
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

/** A harness that prints a session's last lines, then waits; `end` exits it. */
class FakeHarness implements PaneProcess {
  pid = 51_234
  written: string[] = []
  sizes: [number, number][] = []
  closed = false
  private listeners: ((c: Uint8Array) => void)[] = []
  private history: Uint8Array[] = []
  private exit!: (code: number) => void
  exited = new Promise<number>((resolve) => (this.exit = resolve))
  constructor(readonly input: Parameters<BuildSpawner>[0]) {}
  write(data: string | Uint8Array) {
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data))
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  onData(listener: (c: Uint8Array) => void) {
    this.listeners.push(listener)
    for (const h of this.history) listener(h)
  }
  signal() {}
  close() {
    this.closed = true
  }
  emit(text: string) {
    const bytes = new TextEncoder().encode(text)
    this.history.push(bytes)
    for (const l of this.listeners) l(bytes)
  }
  end(code = 0) {
    this.exit(code)
  }
}

const SESSION = [
  "> write a bot in momentum/ that buys $2 when three or more tracked wallets buy",
  "",
  "● I'll start from the candle-strategy-to-bot skill and harness-client.ts.",
  "",
  "● Write(momentum/bot.ts)",
  "  ⎿  Wrote 71 lines to momentum/bot.ts",
  "",
  "● Bash(candle-harness build test momentum)",
  "  ⎿  paper test · ends with this pane or in 30 min",
].join("\r\n")

/** Every engine as the picker reads them: four installed and signed in, Grok signed out. */
const ENGINES = {
  ...engineTopic,
  engines: {
    ...engineTopic.engines,
    codex: { label: "Codex", minVersion: "0.160.0", check: { ok: true, version: "0.165.0" }, capabilities: engineTopic.engines["claude-code"]!.capabilities, signedIn: true, modelsReadAt: CLOCK },
    grok: { label: "Grok", minVersion: "1.0.60", check: { ok: true, version: "1.0.70" }, capabilities: engineTopic.engines["claude-code"]!.capabilities, signedIn: false, modelsReadAt: CLOCK },
    opencode: { label: "OpenCode", minVersion: "1.19.0", check: { ok: true, version: "1.19.5" }, capabilities: engineTopic.engines["claude-code"]!.capabilities, signedIn: true, modelsReadAt: CLOCK },
    pi: { label: "Pi", minVersion: "1.4.0", check: { ok: true, version: "1.4.0" }, capabilities: engineTopic.engines["claude-code"]!.capabilities, signedIn: true, modelsReadAt: CLOCK },
  },
}

async function scene(width: number, height: number, prefs = { folder: "~/candle-bots", opened: false, bins: {} as Record<string, string> }, layouts?: LayoutStore, spawnPane?: PaneSpawner) {
  const harnesses: FakeHarness[] = []
  const spawnBuild: BuildSpawner = (input) => {
    const h = new FakeHarness(input)
    harnesses.push(h)
    return h
  }
  const drawn = await drawScene("followed", width, height, "build", layouts, { spawnBuild, buildPrefs: { ...prefs }, ...(spawnPane ? { spawnPane } : {}) })
  setup = drawn.setup
  const settle = async (fn: () => unknown = () => {}) => {
    await act(async () => {
      await fn()
    })
    for (let i = 0; i < 3; i++) await act(async () => void (await drawn.setup.renderOnce()))
  }
  await settle(() => drawn.session.push("engine", ENGINES, true))
  await settle(() => Bun.sleep(5))
  // Past its first open, the pane doesn't take the keys itself: ↓ from the tab bar goes into it, as into any tab's.
  if (prefs.opened) await settle(() => drawn.setup.mockInput.pressArrow("down"))
  return { ...drawn, harnesses, settle, frame: () => drawn.setup.captureCharFrame() }
}

const SIZES = [
  [160, 45],
  [120, 30],
  [80, 24],
] as const

for (const [w, h] of SIZES) {
  test(`the first open: where the bots live and which harness, then the files written, at ${w}×${h}`, async () => {
    const s = await scene(w, h)
    expect(s.frame()).toContain("Where should your bots live?")
    expect(s.frame()).toContain("Which coding harness?")
    expect(s.frame()).toContain("not signed in · it asks when it starts")
    await compareFrame(`build-first-open-${w}x${h}`, s.setup)
    // ⏎ does what its chip says on the first press: writes the folder and keeps the choice, from the folder's line.
    await s.settle(() => s.setup.mockInput.pressEnter())
    await s.settle(() => Bun.sleep(30))
    // The folder goes to the core first, which checks where it really is before anything's written there; opened once written.
    expect(s.session.requests.filter((r) => r.method === "build.prefs" && r.params.set).map((r) => r.params)).toEqual([{ set: { folder: "~/candle-bots", harness: "claude-code" } }, { set: { opened: true } }])
    expect(s.frame()).toContain("~/candle-bots is ready")
    expect(s.frame()).toContain("AGENTS.md")
    await compareFrame(`build-written-${w}x${h}`, s.setup)
    // ⏎ starts Claude Code in the folder, with the pane's token in its environment alone.
    await s.settle(() => s.setup.mockInput.pressEnter())
    await s.settle(() => Bun.sleep(10))
    const harness = s.harnesses.at(-1)!
    expect(harness.input.argv).toEqual(["claude"])
    expect(harness.input.cwd).toBe(join(home, "candle-bots"))
    expect(harness.input.token).toBe("scene-build-token")
    expect(s.session.requests.find((r) => r.method === "build.open")?.params).toEqual({ agent: "agent-a", harness: "Claude Code" })
  })

  test(`the harness running beside the bots folder and the test run, folded to a strip below 100 columns, at ${w}×${h}`, async () => {
    const s = await scene(w, h, { folder: "~/candle-bots", opened: true, bins: { "claude-code": "claude" }, harness: "claude-code" } as never)
    expect(s.frame()).toContain("Build · not started")
    await s.settle(() => s.setup.mockInput.pressEnter())
    await s.settle(() => Bun.sleep(10))
    const harness = s.harnesses.at(-1)!
    // Until the harness draws, the pane says it's starting, and a second ⏎ starts nothing more.
    expect(s.frame()).toContain("Starting Claude Code in ~/candle-bots…")
    await s.settle(() => s.setup.mockInput.pressEnter())
    expect(s.harnesses).toHaveLength(1)
    expect(harness.written.join("")).toBe("")
    await s.settle(() => harness.emit(SESSION))
    expect(s.frame()).toContain("Build · Claude Code · for agent-a · ~/candle-bots")
    expect(s.frame()).toContain("Wrote 71 lines")
    if (w < 100) expect(s.frame()).toContain("bots folder ▾")
    else expect(s.frame()).toContain("Bots folder")
    await compareFrame(`build-running-${w}x${h}`, s.setup)
    // Its keys are the harness's; ctrl-] leaves the pane, and the hint line says so first.
    expect(s.frame()).toContain("ctrl-] leaves the pane")
    await s.settle(() => s.setup.mockInput.typeText("y"))
    expect(harness.written.join("")).toContain("y")
    // It exits: the pane says so, and ⏎ starts it again with the same token.
    await s.settle(() => harness.end(0))
    await s.settle(() => Bun.sleep(20))
    expect(s.frame()).toContain("Claude Code exited.")
    if (w === 120) await compareFrame(`build-exited-${w}x${h}`, s.setup)
  })
}

test("the title names the agent the harness builds for, and a start after the active agent changed opens a session for the new one", async () => {
  const s = await scene(120, 30, { folder: "~/candle-bots", opened: true, bins: { "claude-code": "claude" }, harness: "claude-code" } as never)
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(10))
  expect(s.frame()).toContain("Build · Claude Code · for agent-a · ~/candle-bots")
  await s.settle(() => s.harnesses.at(-1)!.end(0))
  await s.settle(() => Bun.sleep(20))
  // Exited, then agent-b made active: ⏎ closes agent-a's session and opens one for agent-b.
  await s.settle(() => s.session.push("status", { ...status, activeAgent: "agent-b" }))
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(20))
  const opens = s.session.requests.filter((r) => r.method === "build.open").map((r) => r.params.agent)
  expect(opens).toEqual(["agent-a", "agent-b"])
  expect(s.session.requests.find((r) => r.method === "build.close")?.params).toEqual({ tokenId: "tok-build" })
  expect(s.frame()).toContain("Build · Claude Code · for agent-b · ~/candle-bots")
})

test("after the core restarts, the pane's session opens again at once and its token file says the new token, so the harness still running works", async () => {
  const s = await scene(120, 30, { folder: "~/candle-bots", opened: true, bins: { "claude-code": "claude" }, harness: "claude-code" } as never)
  const state = mkdtempSync("/tmp/chrn-buildtok-")
  try {
    s.session.buildSocketPath = join(state, "core.sock")
    await s.settle(() => s.setup.mockInput.pressEnter())
    await s.settle(() => Bun.sleep(10))
    const harness = s.harnesses.at(-1)!
    const file = harness.input.tokenFile!
    expect(file).toBe(join(state, "build", `pane-${process.pid}.token`))
    expect(readFileSync(file, "utf8").trim()).toBe("scene-build-token")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // The core goes (a `launchctl kickstart -k`), and the view reattaches to the new one.
    await s.settle(() => s.session.lose())
    await s.settle(() => s.session.push("status", { ...status }))
    await s.settle(() => Bun.sleep(20))
    expect(s.session.requests.filter((r) => r.method === "build.open").map((r) => r.params)).toEqual([
      { agent: "agent-a", harness: "Claude Code" },
      { agent: "agent-a", harness: "Claude Code" },
    ])
    // The harness kept running: what it runs reads the new token from the file it was named.
    expect(harness.closed).toBe(false)
    expect(readFileSync(file, "utf8").trim()).toBe("scene-build-token-2")
    // Started again later, a harness gets the new token in its environment too.
    await s.settle(() => harness.end(0))
    await s.settle(() => Bun.sleep(20))
    await s.settle(() => s.setup.mockInput.pressEnter())
    await s.settle(() => Bun.sleep(10))
    expect(s.harnesses.at(-1)!.input.token).toBe("scene-build-token-2")
    expect(s.session.requests.filter((r) => r.method === "build.open")).toHaveLength(2)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test("below 100 columns, the strip's chips open the bots folder and the test run over the frame", async () => {
  const s = await scene(80, 24, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never)
  const row = s.frame().split("\n").findIndex((l) => l.includes("bots folder ▾"))
  const x = s.frame().split("\n")[row]!.indexOf("bots folder ▾")
  await s.settle(() => s.setup.mockMouse.click(x + 2, row))
  expect(s.frame()).toContain("Bots folder")
  expect(s.frame()).toContain("open the folder")
  await compareFrame("build-folded-folder-80x24", s.setup)
  await s.settle(async () => {
    s.setup.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  expect(s.frame()).not.toContain("open the folder")
})

/** A code bot the harness proposed from the Build pane, as the core sends its card. */
const buildCard = (): ViewCard => {
  const run = { agent: "agent-a", wallet: "embedded", mode: "paper", folder: "/srv/bots/momentum", command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 }
  return {
    cardId: "cb1",
    opId: "op-cb1",
    cardHash: "hash-cb1",
    kind: "bot",
    tool: "bots.proposeCode",
    agent: "agent-a",
    state: "awaiting_approval",
    expiresAt: new Date(CLOCK + 590_000).toISOString(),
    params: { action: "saveCode" },
    origin: { role: "build" },
    display: {
      title: 'NEW CODE BOT "momentum"',
      headline: 'NEW CODE BOT "momentum"',
      agent: "agent-a",
      wallet: EMBEDDED,
      walletLabel: "embedded",
      mode: "paper",
      expiresAt: new Date(CLOCK + 590_000).toISOString(),
      paysFrom: "pays from embedded",
      modeNote: "paper bot",
      botCard: {
        name: "momentum",
        words: "Runs bun run bot.ts in ~/candle-bots/momentum.",
        definition: JSON.stringify(run),
        mode: "paper",
        runs: { kind: "own", entries: "Its buys run on paper, inside its figures.", exits: "Its sells of what it bought run on paper too." },
        worst: "Paper: nothing real is at risk.",
        parts: { buys: "on paper, inside its figures", sells: "of what it bought, on paper", worst: "paper: nothing real at risk", tested: "The core holds this bot to these figures. What it trades inside them is its code's." },
        code: { folder: "~/candle-bots/momentum", command: "bun run bot.ts", figures: "$2.00 a trade · $10.00 a day · 3 open at most", holds: "The core holds this bot to these figures. What it trades inside them is its code's." },
      },
    },
  } as ViewCard
}

for (const [w, h] of SIZES) {
  test(`a code bot the harness proposes opens whole over the frame: ⏎ approves after 300 ms, esc goes back to the harness, at ${w}×${h}`, async () => {
    const s = await scene(w, h, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never)
    await s.settle(() => s.setup.mockInput.pressEnter())
    await s.settle(() => Bun.sleep(10))
    await s.settle(() => s.harnesses.at(-1)!.emit(SESSION))
    await s.settle(() => s.session.push("cards", [buildCard()], true))
    expect(s.frame()).toContain("your harness proposed a bot")
    expect(s.frame()).toContain('NEW CODE BOT "momentum"')
    await compareFrame(`build-card-${w}x${h}`, s.setup)
    // A key typed now isn't the harness's: the card has the keys, and a stray letter doesn't close it.
    const before = s.harnesses.at(-1)!.written.length
    await s.settle(() => s.setup.mockInput.typeText("x"))
    expect(s.harnesses.at(-1)!.written.length).toBe(before)
    expect(s.frame()).toContain("your harness proposed a bot")
    // Esc goes back to the harness; the card waits.
    await s.settle(async () => {
      s.setup.mockInput.pressEscape()
      await Bun.sleep(30)
    })
    expect(s.frame()).not.toContain("your harness proposed a bot")
    expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
  })
}

/** The Build pane with its harness running and the keys in it. */
async function running(w = 120, h = 30, spawnPane?: PaneSpawner) {
  const s = await scene(w, h, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never, undefined, spawnPane)
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(10))
  await s.settle(() => s.harnesses.at(-1)!.emit(SESSION))
  return { ...s, harness: s.harnesses.at(-1)! }
}

test("the kill switch works from inside the harness: one ctrl-x is the harness's own, a second within the window pauses and never reaches it", async () => {
  const s = await running()
  const ctrlX = () => s.setup.mockInput.pressKey("x", { ctrl: true })
  await s.settle(ctrlX)
  expect(s.harness.written.join("")).toBe("\x18")
  expect(s.session.requests.some((r) => r.method === "kill")).toBe(false)
  expect(s.frame()).toContain("ctrl-x again to kill")
  // Another key between the two is the harness's, and takes the kill off its arm.
  await s.settle(() => s.setup.mockInput.typeText("a"))
  await s.settle(ctrlX)
  expect(s.session.requests.some((r) => r.method === "kill")).toBe(false)
  expect(s.harness.written.join("")).toBe("\x18a\x18")
  await s.settle(ctrlX)
  expect(s.session.requests.some((r) => r.method === "kill")).toBe(true)
  expect(s.harness.written.join("")).toBe("\x18a\x18")
})

test("while the harness has the keys, the cards' heading says how to reach them rather than that ⏎ approves", async () => {
  const s = await running()
  expect(s.frame()).toContain("1 card waiting · ctrl-] then ⏎, or click")
  expect(s.frame()).not.toContain("⏎ approves the highlighted one")
  // The card itself offers its approve chip without the Enter mark, since Enter is the harness's.
  expect(s.frame()).toMatch(/ approve /)
  expect(s.frame()).not.toMatch(/⏎ approve(?!s)/)
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  expect(s.frame()).toContain("1 card waiting · ⏎ approves the highlighted one")
  expect(s.frame()).toMatch(/⏎ approve(?!s)/)
})

test("an agent pane beside the harness draws its waiting card without the ⏎ mark while the harness has the keys", async () => {
  // The Build tab laid out as the Build pane with the agent pane beside it, so the agent pane draws the card.
  const own = { name: "Build with agent", root: { dir: "row" as const, weight: 1, children: [{ pane: "build" as const, weight: 60 }, { pane: "agent" as const, weight: 40 }] }, collapse: { below: 100, keep: "build" as const, weights: [60, 40] as [number, number] } }
  const tabs = KNOWN_TABS.filter((k) => k.shown).map((k) => (k.tab.name === "Build" ? { ...k.tab, layout: own.name } : k.tab))
  const s = await scene(160, 45, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never, memoryStore(layoutsText({ tabs, own: [own] })))
  // With the agent pane in the tab, the keys start on its input line: a click on the Build pane's chip starts the harness.
  const rows = s.frame().split("\n")
  const y = rows.findIndex((l) => l.includes("⏎ start Claude Code"))
  await s.settle(() => s.setup.mockMouse.click(rows[y]!.indexOf("⏎ start Claude Code") + 4, y))
  await s.settle(() => Bun.sleep(10))
  await s.settle(() => s.harnesses.at(-1)!.emit(SESSION))
  // The agent pane's columns only, so the message line's own hints don't count.
  const agentPane = () => {
    const lines = s.frame().split("\n")
    const x = lines.find((l) => l.includes("╭─ agent-a"))!.indexOf("╭─ agent-a")
    return lines.map((l) => l.slice(x)).join("\n")
  }
  expect(agentPane()).toContain("1 card waiting · ctrl-] then ⏎, or click")
  expect(agentPane()).toMatch(/ approve /)
  expect(agentPane()).not.toMatch(/⏎ approve(?!s)/)
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  expect(agentPane()).toContain("1 card waiting · ⏎ approves the highlighted one")
  expect(agentPane()).toMatch(/⏎ approve(?!s)/)
})

test("a bot proposed while the person is typing in the harness opens without the keys: their Enter is the harness's, and ctrl-] takes the card", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("add a stop at"))
  advanceClock(500)
  await s.settle(() => s.session.push("cards", [buildCard()], true))
  expect(s.frame()).toContain("your harness proposed a bot")
  expect(s.frame()).toContain("or ctrl-] · the keys are still your harness's")
  expect(s.frame()).not.toContain("⏎ approve · ctrl-n reject")
  // The hint line still says whose the keys are.
  expect(s.frame().split("\n").at(-2)).toContain("ctrl-] to the bot's card")
  // Inside the card, the approve chip is a click target and doesn't claim ⏎, which is the harness's until the card is taken.
  const chipRow = () => s.frame().split("\n").find((l, i, all) => all[i + 1]?.includes("review  or ctrl-]") || all[i + 1]?.includes("⏎ approve · ctrl-n reject"))!
  expect(chipRow()).toContain("│ ▌  approve    ctrl-n reject    ctrl-o details")
  await compareFrame("build-card-typing-120x30", s.setup)
  // The sentence goes on in the harness; its Enter, well past 300 ms, approves nothing.
  advanceClock(1_000)
  await s.settle(() => s.setup.mockInput.typeText(" -20%"))
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.harness.written.join("")).toBe("add a stop at -20%\r")
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
  // ctrl-] moves to the card; Enter approves it once it has had the keys 300 ms.
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  expect(s.frame()).toContain("⏎ approve · ctrl-n reject")
  expect(chipRow()).toContain("│ ▌  ⏎ approve    ctrl-n reject    ctrl-o details")
  advanceClock(100)
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
  advanceClock(250)
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(true)
  expect(s.harness.written.join("")).toBe("add a stop at -20%\r")
})

test("a bot proposed with no key typed in the harness for 2 s opens with the keys, and Enter approves it after 300 ms", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("go"))
  advanceClock(2_500)
  await s.settle(() => s.session.push("cards", [buildCard()], true))
  expect(s.frame()).toContain("⏎ approve · ctrl-n reject")
  advanceClock(350)
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(true)
  expect(s.harness.written.join("")).toBe("go")
})

test("after esc, a click on the code bot's card waiting in the strip opens it whole again", async () => {
  const s = await scene(120, 30, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never)
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(10))
  await s.settle(() => s.harnesses.at(-1)!.emit(SESSION))
  await s.settle(() => s.session.push("cards", [buildCard()], true))
  await s.settle(async () => {
    s.setup.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  expect(s.frame()).not.toContain("your harness proposed a bot")
  const rows = s.frame().split("\n")
  // The strip shows the card's foot; a click on any of its lines.
  const y = rows.findIndex((r) => r.includes("Runs bun run bot.ts in ~/candle-bots/momentum."))
  expect(y).toBeGreaterThan(0)
  await s.settle(() => s.setup.mockMouse.click(rows[y]!.indexOf("Runs bun") + 2, y))
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  expect(s.frame()).toContain("your harness proposed a bot")
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
})

test("a code bot's card taller than an 80×24 window keeps its command, its sells and its limits, and its foot: never cut off", async () => {
  const s = await scene(80, 24, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never)
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(10))
  await s.settle(() => s.harnesses.at(-1)!.emit(SESSION))
  const tall = buildCard()
  tall.display = {
    ...tall.display,
    warning: "The embedded wallet is shared with you and every agent. A wallet of its own is the better way: the bot can lose only what that wallet holds, and its figures are the bot's alone. ".repeat(2).trim(),
    fills: [{ label: "set up a vault", line: "candle vault init" }],
  } as never
  await s.settle(() => s.session.push("cards", [tall], true))
  expect(s.frame()).toContain('NEW CODE BOT "momentum"')
  // The steer's paragraph is what it gives up; its chip stays, and so does every line the press approves.
  expect(s.frame()).not.toContain("the bot can lose only")
  for (const kept of ["Runs bun run bot.ts in ~/candle-bots/momentum.", "│ sells  of what it bought", "│ limits $2.00 a trade", "set up a vault"]) expect(s.frame()).toContain(kept)
  expect(s.frame()).toContain("⏎ approve    ctrl-n reject")
})

test("on Free, the Build pane says code bots need a Pro or Max plan, with candle plan buy; the harness still starts", async () => {
  const s = await scene(120, 30, { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never)
  await s.settle(() => s.session.push("bots", { bots: [], problems: [], gate: { plan: "free", words: "Bots need a Pro or Max plan", fix: "candle plan buy" } }, true))
  expect(s.frame()).toContain("Bots need a Pro or Max plan. Your harness and the bots folder still work here")
  expect(s.frame()).toContain("candle plan buy")
  await compareFrame("build-free-120x30", s.setup)
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(10))
  expect(s.harnesses).toHaveLength(1)
})

test("a click on the approve chip of a bot's card that opened without the keys still approves it", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("add a stop at"))
  advanceClock(500)
  await s.settle(() => s.session.push("cards", [buildCard()], true))
  const lines = s.frame().split("\n")
  const y = lines.findIndex((l, i) => lines[i + 1]?.includes("review  or ctrl-]"))
  const x = lines[y]!.indexOf("▌  approve") + 4
  expect(x).toBeGreaterThan(4)
  advanceClock(400)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(true)
})

test("while a card's approval is on its way, another click or ⏎ on it sends nothing more; once answered, it can be sent again", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("add a stop at"))
  advanceClock(500)
  await s.settle(() => s.session.push("cards", [buildCard()], true))
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  advanceClock(400)
  // The core's answer waits until it's let go, as a real approval takes a moment.
  let answer!: () => void
  const asked = s.session.request.bind(s.session)
  s.session.request = (async (method: string, params?: Record<string, unknown>) => {
    if (method !== "cards.approve") return asked(method, params)
    s.session.requests.push({ method, params: params ?? {} })
    await new Promise<void>((r) => (answer = r))
    return { kind: "approved" }
  }) as typeof s.session.request
  const approvals = () => s.session.requests.filter((r) => r.method === "cards.approve").length
  const lines = s.frame().split("\n")
  const y = lines.findIndex((l, i) => lines[i + 1]?.includes("⏎ approve · ctrl-n reject"))
  const x = lines[y]!.indexOf("⏎ approve") + 2
  await s.settle(() => s.setup.mockMouse.click(x, y))
  // Past the 300 ms the close starts, so the next click and ⏎ reach the approval itself and are held only by it.
  advanceClock(400)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  expect(approvals()).toBe(1)
  expect(s.frame()).not.toContain("being approved")
  await s.settle(() => answer())
  // The card is still waiting here (the scene's core never moves it on): its chip in the strip sends again.
  advanceClock(400)
  const after = s.frame().split("\n")
  const row = after.findLastIndex((l) => /▌ +(⏎ )?approve /.test(l))
  await s.settle(() => s.setup.mockMouse.click(after[row]!.search(/(⏎ )?approve /) + 2, row))
  expect(approvals()).toBe(2)
})

test("a click on the Build card's approve closes it, as ⏎ does: the keys go back to the harness, and the next bot's card opens over the frame", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("go"))
  advanceClock(2_500)
  await s.settle(() => s.session.push("cards", [buildCard()], true))
  expect(s.frame()).toContain("your harness proposed a bot")
  advanceClock(400)
  const lines = s.frame().split("\n")
  const y = lines.findIndex((l, i) => lines[i + 1]?.includes("⏎ approve · ctrl-n reject"))
  await s.settle(() => s.setup.mockMouse.click(lines[y]!.indexOf("⏎ approve") + 2, y))
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  expect(s.session.requests.filter((r) => r.method === "cards.approve")).toHaveLength(1)
  // The core moves the card on; the harness has the keys again.
  await s.settle(() => s.session.push("cards", [], true))
  expect(s.frame()).not.toContain("your harness proposed a bot")
  await s.settle(() => s.setup.mockInput.typeText(" on"))
  expect(s.harness.written.join("")).toBe("go on")
  // Its next bot opens whole over the frame, not in the strip.
  advanceClock(2_500)
  await s.settle(() => s.session.push("cards", [{ ...buildCard(), cardId: "cb2", opId: "op-cb2", cardHash: "hash-cb2" }], true))
  expect(s.frame()).toContain("your harness proposed a bot")
})

/** The Build pane at the one size where a closed overlay's chip lines up with the live card's beneath it. */
async function overLiveCard() {
  const s = await running(74, 40)
  // The live trade card waits in the strip, well past its 300 ms, before the Build card opens over it.
  await s.settle(() => s.session.push("cards", [tradeCard], true))
  advanceClock(5_000)
  await s.settle(() => s.session.push("cards", [tradeCard, buildCard()], true))
  expect(s.frame()).toContain("your harness proposed a bot")
  const lines = s.frame().split("\n")
  const y = lines.findIndex((l, i) => lines[i + 1]?.includes("⏎ approve · ctrl-n reject"))
  expect(y).toBeGreaterThan(0)
  return { s, y }
}

test("at 74×40, a double click on the Build card's approve chip approves only it, not the live trade card beneath", async () => {
  const { s, y } = await overLiveCard()
  const lines = s.frame().split("\n")
  const x = lines[y]!.indexOf("⏎ approve") + 2
  advanceClock(400)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  // The second half of the double click, 120 ms later, lands where the live card's approve chip now draws.
  const beneath = s.frame().split("\n")[y]!
  expect(beneath).toMatch(/approve/)
  advanceClock(120)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  const approves = s.session.requests.filter((r) => r.method === "cards.approve")
  expect(approves.map((r) => r.params.cardId)).toEqual(["cb1"])
  expect(s.session.requests.some((r) => r.method === "cards.reject")).toBe(false)
})

test("at 74×40, a double click on the Build card's ctrl-n reject chip rejects only it, not the live trade card beneath", async () => {
  const { s, y } = await overLiveCard()
  const lines = s.frame().split("\n")
  const x = lines[y]!.indexOf("ctrl-n reject") + 4
  advanceClock(400)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  const beneath = s.frame().split("\n")[y]!
  expect(beneath).toMatch(/reject/)
  advanceClock(120)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  const rejects = s.session.requests.filter((r) => r.method === "cards.reject")
  expect(rejects.map((r) => r.params.cardId)).toEqual(["cb1"])
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
})

test("at 74×40, ⏎ on the Build card then a click 120 ms later approves only it, not the live trade card beneath", async () => {
  const { s, y } = await overLiveCard()
  const lines = s.frame().split("\n")
  const x = lines[y]!.indexOf("⏎ approve") + 2
  advanceClock(400)
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  // The click, 120 ms later, lands where the overlay's approve chip was: on the live card's chip beneath.
  const beneath = s.frame().split("\n")[y]!
  expect(beneath).toMatch(/approve/)
  advanceClock(120)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  const approves = s.session.requests.filter((r) => r.method === "cards.approve")
  expect(approves.map((r) => r.params.cardId)).toEqual(["cb1"])
  expect(s.session.requests.some((r) => r.method === "cards.reject")).toBe(false)
})

test("at 74×40, ctrl-n on the Build card then a click 120 ms later rejects only it, not the live trade card beneath", async () => {
  const { s, y } = await overLiveCard()
  const lines = s.frame().split("\n")
  const x = lines[y]!.indexOf("ctrl-n reject") + 4
  advanceClock(400)
  await s.settle(() => s.setup.mockInput.pressKey("n", { ctrl: true }))
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  const beneath = s.frame().split("\n")[y]!
  expect(beneath).toMatch(/reject/)
  advanceClock(120)
  await s.settle(() => s.setup.mockMouse.click(x, y))
  const rejects = s.session.requests.filter((r) => r.method === "cards.reject")
  expect(rejects.map((r) => r.params.cardId)).toEqual(["cb1"])
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
})

/** A pane the core opened for a typed `candle` line: its screen, then it ends when told. */
function endingPane(): { spawn: PaneSpawner; end: (code: number) => void } {
  let end!: (code: number) => void
  const exited = new Promise<number>((resolve) => (end = resolve))
  const pane: PaneProcess = { pid: 4242, write: () => {}, resize: () => {}, onData: (l) => l(new TextEncoder().encode("Vault passphrase (input hidden):\r\nFinished in the pane.\r\n")), exited, signal: () => {}, close: () => {} }
  return { spawn: () => pane, end }
}

/** The Build tab with a typed line's prompt pane run, ended and left behind its chip, then the harness started. */
async function harnessAfterPane() {
  const pane = endingPane()
  const harnesses: FakeHarness[] = []
  const drawn = await drawScene("followed", 120, 30, "build", undefined, { spawnPane: pane.spawn, spawnBuild: (input) => (harnesses.push(new FakeHarness(input)), harnesses.at(-1)!), buildPrefs: { folder: "~/candle-bots", opened: true, bins: {}, harness: "claude-code" } as never })
  setup = drawn.setup
  const ask = drawn.session.request.bind(drawn.session)
  drawn.session.request = (async (method: string, params: Record<string, unknown> = {}) =>
    method === "cli.run" ? { kind: "pane", ticket: "chp_fake", ticketId: "t1", title: "candle vault list · the agent can't see this pane" } : ask(method, params)) as typeof drawn.session.request
  const settle = async (fn: () => unknown = () => {}) => {
    await act(async () => {
      await fn()
    })
    for (let i = 0; i < 3; i++) await act(async () => void (await drawn.setup.renderOnce()))
  }
  await settle(() => drawn.session.push("engine", ENGINES, true))
  await settle(() => drawn.setup.mockInput.typeText("candle vault list"))
  await settle(() => drawn.setup.mockInput.pressEnter())
  await settle(() => Bun.sleep(10))
  expect(drawn.setup.captureCharFrame()).toContain("Finished in the pane.")
  await settle(() => pane.end(0))
  await settle(() => drawn.setup.mockInput.pressKey("]", { ctrl: true }))
  expect(drawn.setup.captureCharFrame()).toContain("▣ candle vault list (ended)")
  await settle(() => drawn.setup.mockInput.pressArrow("down"))
  await settle(() => drawn.setup.mockInput.pressEnter())
  await settle(() => Bun.sleep(10))
  const harness = harnesses.at(-1)!
  await settle(() => harness.emit(SESSION))
  return { ...drawn, settle, harness, frame: () => drawn.setup.captureCharFrame() }
}

test("with an ended prompt pane behind its chip, ctrl-] still leaves the harness: the waiting card takes ⏎, and no pane nobody sees holds the keys", async () => {
  const s = await harnessAfterPane()
  expect(s.frame()).toContain("1 card waiting · ctrl-] then ⏎, or click")
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  expect(s.frame()).not.toContain("candle vault list · the agent can't see this pane")
  expect(s.frame()).toContain("1 card waiting · ⏎ approves the highlighted one")
  advanceClock(350)
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(true)
  // Back in, ctrl-] goes to the harness on screen, not to the pane behind its chip.
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  await s.settle(() => s.setup.mockInput.typeText("zz"))
  expect(s.harness.written.join("")).toBe("zz")
})

test("a prompt pane shown on the Build tab is drawn over the harness, which takes its screen back once it's left", async () => {
  const s = await harnessAfterPane()
  // Its chip shows it again: over the harness, whose screen doesn't draw through it.
  const rows = s.frame().split("\n")
  const y = rows.findIndex((l) => l.includes("▣ candle vault list (ended)"))
  await s.settle(() => s.setup.mockMouse.click(rows[y]!.indexOf("▣ candle vault list") + 3, y))
  await s.settle(() => s.setup.mockMouse.moveTo(0, 0))
  expect(s.frame()).toContain("candle vault list · the agent can't see this pane")
  expect(s.frame()).toContain("Finished in the pane.")
  expect(s.frame()).not.toContain("candle-strategy-to-bot")
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  expect(s.frame()).toContain("candle-strategy-to-bot")
})

/** A trade a running code bot asked for, as the core sends its card. */
const botTrade = (id = "bt1"): ViewCard => ({ ...tradeCard, cardId: id, opId: `op-${id}`, cardHash: `hash-${id}`, origin: { role: "core", bot: { name: "momentum", kind: "code", act: "entry" } } }) as ViewCard

test("a code bot's own trade that arrives while the harness has the keys opens over the frame, and ⏎ approves it after 300 ms", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("go"))
  advanceClock(2_500)
  await s.settle(() => s.session.push("cards", [tradeCard, botTrade()], true))
  expect(s.frame()).toContain("code bot momentum's trade")
  expect(s.frame()).toContain("⏎ approve · ctrl-n reject")
  advanceClock(350)
  await s.settle(() => s.setup.mockInput.pressEnter())
  const approved = s.session.requests.filter((r) => r.method === "cards.approve")
  expect(approved).toHaveLength(1)
  expect(approved[0]!.params.cardId).toBe("bt1")
  expect(s.harness.written.join("")).toBe("go")
})

test("a code bot's trade that arrives mid-sentence in the harness opens without the keys, and ctrl-] takes it", async () => {
  const s = await running()
  await s.settle(() => s.setup.mockInput.typeText("add a stop"))
  advanceClock(500)
  await s.settle(() => s.session.push("cards", [tradeCard, botTrade()], true))
  expect(s.frame()).toContain("code bot momentum's trade")
  expect(s.frame()).toContain("or ctrl-] · the keys are still your harness's")
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.session.requests.some((r) => r.method === "cards.approve")).toBe(false)
  await s.settle(() => s.setup.mockInput.pressKey("]", { ctrl: true }))
  advanceClock(350)
  await s.settle(() => s.setup.mockInput.pressEnter())
  expect(s.session.requests.find((r) => r.method === "cards.approve")?.params.cardId).toBe("bt1")
})

test("the first open's folder: a whole path typed over the one offered takes its place, never nests in it; ctrl-u clears the line", async () => {
  const s = await scene(120, 30)
  const folderSet = () => s.session.requests.filter((r) => r.method === "build.prefs" && r.params.set).map((r) => (r.params.set as { folder?: string }).folder)
  await s.settle(() => s.setup.mockInput.typeText("/srv/my-bots"))
  expect(s.frame()).toContain("/srv/my-bots")
  expect(s.frame()).not.toContain("~/candle-bots/srv")
  // Edited, a slash goes on the end like any other character; ctrl-u empties the line for another path.
  await s.settle(() => s.setup.mockInput.typeText("/x"))
  expect(s.frame()).toContain("/srv/my-bots/x")
  await s.settle(() => s.setup.mockInput.pressKey("u", { ctrl: true }))
  expect(s.frame()).not.toContain("/srv/my-bots")
  await s.settle(() => s.setup.mockInput.typeText("~/bots"))
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(30))
  expect(folderSet()[0]).toBe("~/bots")
})

test("the first open's folder: a name typed after the one offered still adds to it", async () => {
  const s = await scene(120, 30)
  await s.settle(() => s.setup.mockInput.typeText("-test"))
  await s.settle(() => s.setup.mockInput.pressEnter())
  await s.settle(() => Bun.sleep(30))
  expect(s.session.requests.find((r) => r.method === "build.prefs" && r.params.set)?.params.set).toMatchObject({ folder: "~/candle-bots-test" })
})
