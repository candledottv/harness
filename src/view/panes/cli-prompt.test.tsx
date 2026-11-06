// The prompt pane in the frame, drawn by OpenTUI's test renderer against a stand-in
// session and a stand-in launcher: it opens over the agent pane on a pane answer, takes every key while
// shown, leaves and comes back on ctrl-], stops `candle` a second after a Ctrl-C, and closes on Enter
// or Esc once the launcher has exited.
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../../core/client"
import { App, type Session } from "../app"
import { type PaneProcess, paneEnv } from "../pane-process"
import type { StatusView, ViewCard } from "../store"
import { PANE_FOOTER_RUNNING, type Prompt, promptFooter } from "./cli-prompt"

const TEE = "TeeFake111111111111111111111111111111111111"
const TICKET = `chp_${"T".repeat(12)}_${"s".repeat(43)}`

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
}

class FakePane implements PaneProcess {
  static count = 0
  pid = 40_000 + ++FakePane.count
  written: string[] = []
  signals: string[] = []
  sizes: [number, number][] = []
  closed = false
  private listeners: ((c: Uint8Array) => void)[] = []
  private exit!: (code: number) => void
  exited = new Promise<number>((resolve) => (this.exit = resolve))
  write(data: string | Uint8Array) {
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data))
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  onData(listener: (c: Uint8Array) => void) {
    this.listeners.push(listener)
  }
  signal(signal: string) {
    this.signals.push(signal)
  }
  close() {
    this.closed = true
  }
  emit(text: string) {
    for (const l of this.listeners) l(new TextEncoder().encode(text))
  }
  end(code = 0) {
    this.exit(code)
  }
}

const status: StatusView = { agents: [{ name: "momentum", candle: "ready" }], activeAgent: "momentum", mode: "live", paused: false }
let clock = 1_000_000
const card = (cardId: string, headline = "LESS ACCESS · candle tee disable TeeF…1111"): ViewCard => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: `hash-${cardId}`,
  kind: "lessaccess",
  tool: "candle_cli",
  agent: "momentum",
  state: "awaiting_approval",
  route: "pane",
  expiresAt: new Date(clock + 600_000).toISOString(),
  params: {},
  display: { title: headline, headline, agent: "momentum", wallet: "none", mode: "live", expiresAt: new Date(clock + 600_000).toISOString(), paneSteps: ["it asks for the vault passphrase at the CLI's own prompt"], paneNote: "Runs in a terminal pane the agent can't see." },
})

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
const panes: FakePane[] = []
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
  panes.splice(0)
})

const opened = (cardId: string) => ({ kind: "pane", ticket: TICKET, ticketId: `T${cardId}`, title: `candle tee disable ${TEE} · the agent can't see this pane`, card: { cardId, opId: `op-${cardId}` } })

async function start(session: FakeSession, width = 120, height = 32, onPaste?: (text: string) => void) {
  const spawnPane = (input: { ticket: string; cols: number; rows: number }) => {
    const p = new FakePane()
    ;(p as FakePane & { input: typeof input }).input = input
    panes.push(p)
    return p
  }
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => clock} tickMs={0} spawnPane={spawnPane} stopAfterMs={20} {...(onPaste ? { onPaste } : {})} />, { width, height, exitOnCtrlC: false })
  session.push("status", status, true)
  session.push("cards", [card("c1")], true)
  await setup.renderOnce()
  return setup
}

const frame = () => setup!.captureCharFrame()
async function input(fn: () => unknown) {
  await act(async () => {
    await fn()
  })
  await act(async () => {
    await setup!.renderOnce()
  })
}

async function approveAndOpen(session: FakeSession) {
  clock += 1_000 // past the 300 ms before Enter approves
  await input(() => setup!.mockInput.pressEnter())
  await input(() => Bun.sleep(10))
  expect(session.requests.find((r) => r.method === "cards.approve")).toBeDefined()
  return panes.at(-1)!
}

test("approving a pane card opens the pane over the agent pane: titled, focused, the ticket in the launcher's hands only", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  expect(frame()).toContain("Runs in a terminal pane the agent can't see.")
  const pane = await approveAndOpen(session)
  expect((pane as FakePane & { input: { ticket: string; cols: number; rows: number } }).input.ticket).toBe(TICKET)
  expect(session.requests.find((r) => r.method === "pane.spawned")?.params).toEqual({ ticketId: "Tc1", pid: pane.pid })
  await input(() => pane.emit("Vault passphrase (input hidden): "))
  expect(frame()).toContain("candle tee disable TeeF…1111 · the agent can't see this pane")
  expect(frame()).toContain("Vault passphrase (input hidden):")
  expect(frame()).toContain(PANE_FOOTER_RUNNING.slice(0, 40))
  expect(frame()).not.toContain(TICKET)
})

test("while it's shown, every key goes to the pane: none to the input line or the frame's step", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  const pane = await approveAndOpen(session)
  await input(() => setup!.mockInput.typeText("kill"))
  await input(() => setup!.mockInput.pressEnter())
  expect(pane.written.join("")).toContain("kill")
  expect(session.requests.map((r) => r.method)).not.toContain("kill")
  expect(session.requests.map((r) => r.method)).not.toContain("agent.send")
})

test("a passphrase pasted into the pane reaches the pane, and never the paste log", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  const logged: string[] = []
  await start(session, 120, 32, (text) => logged.push(text))
  const pane = await approveAndOpen(session)
  await input(() => pane.emit("Vault passphrase (input hidden): "))
  await input(() => setup!.mockInput.pasteBracketedText("correct-horse-battery-staple"))
  expect(pane.written.join("")).toContain("correct-horse-battery-staple")
  expect(logged).toEqual([])
})

test("a Ctrl-C typed into the pane: a moment later the launcher is asked to stop candle (SIGUSR1)", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  const pane = await approveAndOpen(session)
  await input(() => setup!.mockInput.pressCtrlC())
  expect(pane.written.join("")).toContain("\x03")
  await input(() => Bun.sleep(60))
  expect(pane.signals).toEqual(["SIGUSR1"])
})

test("a Ctrl-C after the launcher has exited signals nothing", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  const pane = await approveAndOpen(session)
  await input(() => setup!.mockInput.pressCtrlC())
  pane.end(0)
  await input(() => Bun.sleep(60))
  expect(pane.signals).toEqual([])
})

test("ctrl-] leaves it running behind a chip, and the Candle Harness takes keys again; ctrl-] comes back", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  const pane = await approveAndOpen(session)
  await input(() => pane.emit("PANE-SCREEN"))
  await input(() => setup!.mockInput.pressKey("]", { ctrl: true }))
  expect(frame()).not.toContain("PANE-SCREEN")
  expect(frame()).toContain("▣ candle tee disable")
  await input(() => setup!.mockInput.typeText("hello"))
  expect(pane.written.join("")).not.toContain("hello")
  expect(frame()).toContain("hello")
  await input(() => setup!.mockInput.pressKey("]", { ctrl: true }))
  expect(frame()).toContain("PANE-SCREEN")
  expect(pane.closed).toBe(false)
})

test("once the launcher exits, the outcome line shows, and Enter closes the pane; its screen goes with it", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  const pane = await approveAndOpen(session)
  await input(() => pane.emit("SECRET-ON-SCREEN"))
  session.push("operations", { opId: "op-c1", cardId: "c1", agent: "momentum", state: "succeeded", route: "pane", result: { pane: { outcome: "finished", words: "finished in the pane." } } })
  await input(() => pane.end(0))
  await input(() => Bun.sleep(5))
  // Standing alone, the words start a sentence.
  expect(frame()).toContain("Finished in the pane.  ⏎ or Esc closes")
  await input(() => setup!.mockInput.pressEnter())
  expect(frame()).not.toContain("SECRET-ON-SCREEN")
  expect(frame()).not.toContain("⏎ or Esc closes")
  // It had exited: nothing to hang up.
  expect(pane.closed).toBe(false)
  // And the card says how it ended, in the pane's words.
  session.push("cards", { ...card("c1"), state: "approved", approvedHow: "enter" })
  await input(() => Bun.sleep(1))
  expect(frame()).toContain("finished in the pane.")
})

test("a step's next steps are chips on the pane's last line too: a click closes the pane and types the command", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session, 140, 32)
  const pane = await approveAndOpen(session)
  const line = `candle tee sweep ${TEE}`
  session.push("operations", { opId: "op-c1", cardId: "c1", agent: "momentum", state: "succeeded", route: "pane", result: { pane: { outcome: "finished", words: "stopped for good.", next: [{ label: "sweep it home", line }] } } })
  await input(() => pane.end(0))
  await input(() => Bun.sleep(5))
  const rows = frame().split("\n")
  const y = rows.findIndex((r) => r.includes("⏎ or Esc closes"))
  expect(rows[y]).toContain("sweep it home")
  await input(() => setup!.mockMouse.click(rows[y]!.indexOf("sweep it home") + 2, y))
  expect(frame()).not.toContain("⏎ or Esc closes")
  expect(frame()).toContain(line)
  expect(session.requests.filter((r) => r.method === "cli.run")).toEqual([])
})

test("Esc closes a finished pane too; a running one ignores Esc (it's the CLI's)", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session)
  const pane = await approveAndOpen(session)
  await input(() => setup!.mockInput.pressEscape())
  // A lone Esc is told from an escape sequence by a short wait.
  await input(() => Bun.sleep(60))
  expect(frame()).toContain(PANE_FOOTER_RUNNING.slice(0, 40))
  expect(pane.written.join("")).toContain("\x1b")
  await input(() => pane.end(1))
  await input(() => Bun.sleep(5))
  await input(() => setup!.mockInput.pressEscape())
  await input(() => Bun.sleep(60))
  expect(frame()).not.toContain("⏎ or Esc closes")
})

test("panes stack: a second opens in front, the first waits behind its chip", async () => {
  let n = 0
  const session = new FakeSession((m) => (m === "cards.approve" ? opened(`c${++n}`) : {}))
  await start(session)
  const first = await approveAndOpen(session)
  await input(() => first.emit("FIRST"))
  await input(() => setup!.mockInput.pressKey("]", { ctrl: true }))
  session.push("cards", card("c2", "OWNER · candle keys signer approve"))
  await input(() => Bun.sleep(1))
  const second = await approveAndOpen(session)
  await input(() => second.emit("SECOND"))
  expect(frame()).toContain("SECOND")
  expect(frame()).not.toContain("FIRST")
  expect(frame()).toContain("▣ candle tee disable")
  expect(first.closed).toBe(false)
})

test("a view that can't start a pane says so, and runs nothing", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => clock} tickMs={0} />, { width: 120, height: 32, exitOnCtrlC: false })
  session.push("status", status, true)
  session.push("cards", [card("c1")], true)
  await setup.renderOnce()
  clock += 1_000
  await input(() => setup!.mockInput.pressEnter())
  await input(() => Bun.sleep(10))
  expect(frame()).toContain("can't open the prompt pane")
  expect(session.requests.map((r) => r.method)).not.toContain("pane.spawned")
})

test("the pane's environment: the view's own, less ours and anything that changes who candle runs as, plus the ticket and the socket; the keyring passphrase the CLI opens its file store with stays", () => {
  const env = paneEnv(
    { PATH: "/bin", HOME: "/h", TERM: "xterm", CANDLE_CONFIG_DIR: "/c", CANDLE_HARNESS_HOME: "/t", CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1", CANDLE_API_KEY: "k", CANDLE_DEVICE_TOKEN: "d", CANDLE_KEYRING_PASSPHRASE: "p", LANG: "C", EMPTY: undefined },
    { ticket: TICKET, socketPath: "/s/core.sock" },
  )
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", TERM: "xterm", CANDLE_CONFIG_DIR: "/c", CANDLE_KEYRING_PASSPHRASE: "p", LANG: "C", CANDLE_HARNESS_PANE_TICKET: TICKET, CANDLE_HARNESS_PANE_SOCKET: "/s/core.sock" })
})

test("a resize sizes the pane's terminal again, in both directions", async () => {
  const session = new FakeSession((m) => (m === "cards.approve" ? opened("c1") : {}))
  await start(session, 140, 40)
  const pane = await approveAndOpen(session)
  const first = (pane as FakePane & { input: { cols: number; rows: number } }).input
  await input(() => setup!.resize(80, 24))
  await input(() => Bun.sleep(10))
  const last = pane.sizes.at(-1)!
  expect(last[0]).toBeLessThan(first.cols)
  expect(last[1]).toBeLessThan(first.rows)
  // The terminal fills the agent pane: 80 columns at 60% is 48, less its border.
  expect(last[0]).toBe(46)
})

test("a narrow pane's footer keeps how to close it, and cuts the outcome, which the pane shows in full above", () => {
  const ended = { ticketId: "t", title: "x", proc: {} as PaneProcess, exited: 1, hidden: false } satisfies Prompt
  const footer = promptFooter(ended, "the passphrase didn't open the vault. Nothing was run.", 46)
  expect(footer.length).toBeLessThanOrEqual(46)
  expect(footer).toEndWith("  ⏎ or Esc closes")
  expect(footer).toStartWith("The passphrase didn't")
  // Wide enough, the whole outcome.
  expect(promptFooter(ended, "finished in the pane.", 120)).toBe("Finished in the pane.  ⏎ or Esc closes")
})
