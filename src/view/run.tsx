// `candle-harness` (or `candle-harness view`): attach to the core, starting one if none is running, and draw
// the frame until the user quits (ctrl-c twice). The core keeps running for 60 s after the last view
// goes, then exits, unless something still holds it (a card, an operation being read back, a trigger that's on:
// quitting says how many keep running, and how to stop them).
import { appendFileSync, chmodSync, readFileSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { type CliRenderer, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { selfCommand } from "../core/core-main"
import type { Paths } from "../paths"
import { Redactor } from "../shared/redact"
import { walletSecretIn } from "../shared/wallet-secret"
import { fileStore } from "./layouts-store"
import { App } from "./app"
import { quitNote } from "./status-bar"
import type { StatusView } from "./store"
import { attachView, restartCore } from "./attach"
import { defaultServiceDeps, startServiceCore } from "../setup/service"
import { makePaneSpawner } from "./pane-process"
import { makeBuildSpawner } from "./build-process"
import { PoppedApp } from "./popped"
import { makePopper } from "./popout"
import type { ViewSession } from "../core/client"
import type { PaneId } from "../shared/panes"
import { TERMINAL, type TerminalColours } from "./theme"
import { configTheme, fileThemes, startingTheme, type ThemeStore } from "./themes"
import { ViewNotifier } from "./notify-view"

/** config.toml's text, or undefined when it can't be read. */
const configReader = (paths: Paths) => () => {
  try {
    return readFileSync(paths.configFile, "utf8")
  } catch {
    return undefined
  }
}

/**
 * The terminal's own colours, as OpenTUI reads them (OSC 4, 10 and 11); undefined when
 * the terminal doesn't answer within a second. OpenTUI keeps what it read, so a second pick is instant.
 */
async function readTerminal(renderer: CliRenderer): Promise<TerminalColours | undefined> {
  try {
    const read = await renderer.getPalette({ timeout: 1000 })
    return { palette: read.palette, defaultForeground: read.defaultForeground, defaultBackground: read.defaultBackground }
  } catch {
    return undefined
  }
}

/** What a view needs for its theme: the store, and the terminal's colours read before the first frame when it starts on Terminal. */
async function themeProps(paths: Paths, renderer: CliRenderer): Promise<{ themes: ThemeStore; configText: () => string | undefined; terminal?: TerminalColours; readTerminal: () => Promise<TerminalColours | undefined> }> {
  const themes = fileThemes(paths)
  const configText = configReader(paths)
  const starts = startingTheme(themes, configTheme(configText()).name)
  const terminal = starts.toLowerCase() === TERMINAL.toLowerCase() ? await readTerminal(renderer) : undefined
  return { themes, configText, ...(terminal ? { terminal } : {}), readTerminal: () => readTerminal(renderer) }
}

/** A mouse report (SGR or X10): a click or the wheel. Raw input also carries the terminal's own replies, which aren't the person. */
const MOUSE_REPORT = /^\x1b\[(?:<|M)/

/**
 * The main view's notifier: what the core hands this view on `notices`, sent through this terminal while the
 * person isn't looking at it, and the core stopping when nobody asked. Registered before the App, so it's handed
 * the settings the first subscribe brought.
 */
export function attachNotifier(session: ViewSession, renderer: CliRenderer): ViewNotifier {
  const notifier = new ViewNotifier({
    env: process.env,
    platform: process.platform,
    now: Date.now,
    spawn: async (argv) => ({ exitCode: await Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited }),
    osc: (title, body) => renderer.triggerNotification(body, title),
    bell: () => void process.stdout.write("\x07"),
  })
  renderer.on("focus", () => notifier.focus(true))
  renderer.on("blur", () => notifier.focus(false))
  // Keys and pastes as OpenTUI parsed them: the terminal's answers to its startup questions (colours, version,
  // modes) arrive as raw input too, and counted as the person, they held every notice back for a minute.
  renderer.keyInput.on("keypress", () => notifier.input())
  renderer.keyInput.on("paste", () => notifier.input())
  renderer.prependInputHandler((sequence) => {
    if (MOUSE_REPORT.test(sequence)) notifier.input()
    return false
  })
  session.onLiveEvent((event) => {
    if (event.topic === "notices") void notifier.event(event.data)
  })
  session.onLost(() => void notifier.lost())
  session.onHello(() => notifier.attached())
  return notifier
}

/**
 * React's development build, which a run from source uses, records User Timing entries for every component
 * it renders, and Bun keeps them all: about 75 KB a re-render of the App, 1 GB an hour.
 * The binaries are built with React's production build, which records none (scripts/commit.ts).
 */
export function dropRenderTimings(everyMs = 10_000): () => void {
  if (process.env.NODE_ENV === "production") return () => {}
  const timer = setInterval(() => {
    performance.clearMeasures()
    performance.clearMarks()
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Any of the Candle Harness's own tokens (a view's, a turn's, a bot's, a Build pane's): `ch`, a letter, `_`, then the id and secret. */
const OWN_TOKEN_SHAPE = /(?<![A-Za-z0-9_])ch[a-z]_[A-Za-z0-9_-]{20,}/

/**
 * The long-paste check: with CANDLE_HARNESS_PASTE_LOG naming a file, each paste the
 * terminal delivers to the input line is appended to it as one JSON line, its length, SHA-256 and text,
 * so a script can diff what arrived against what was pasted. Off unless set. The prompt pane's and
 * setup's pastes are never logged. A paste keeps only its length and SHA-256, never its text, when it
 * holds anything shaped like a key or token, or a wallet's private key or recovery phrase (which no
 * shape tells: each is checked exactly). The file is held to its owner, one that was there before too.
 */
export function pasteLogger(env: Record<string, string | undefined>): ((text: string) => void) | undefined {
  const file = env.CANDLE_HARNESS_PASTE_LOG
  if (!file || !isAbsolute(file)) return undefined
  const redactor = new Redactor()
  let held = false
  return (text) => {
    const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    const secret = redactor.text(text) !== text || OWN_TOKEN_SHAPE.test(text) || walletSecretIn(text)
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), length: text.length, sha256, ...(secret ? {} : { text }) })}\n`, { mode: 0o600 })
    // The mode above counts only for a file this made: one that was already there is narrowed once.
    if (!held) {
      chmodSync(file, 0o600)
      held = true
    }
  }
}

/**
 * `onboarding`: the view opens for setting up, as a fresh machine's `candle-harness` or
 * `candle-harness setup` asks. `asked` is the person's own `setup`; otherwise there's simply no agent yet.
 */
export interface OnboardingOpen {
  straightIn: boolean
  asked: boolean
}

export async function runView(paths: Paths, err: (text: string) => void, options: { pane?: PaneId; onboarding?: OnboardingOpen } = {}): Promise<number> {
  let attached
  try {
    attached = await attachView({ paths, self: selfCommand(), env: process.env, ...(options.pane ? { clientName: `candle-harness view --pane ${options.pane}` } : {}) })
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (options.pane) return runPopped(attached.session, options.pane, paths, err)
  const { session, started } = attached
  // A core this view didn't start may predate an edit to config.toml.
  const configChangedAt = started ? undefined : statSync(paths.configFile, { throwIfNoEntry: false })?.mtimeMs
  dropRenderTimings()
  const renderer = await startRenderer()
  // After a shrink, Terminal.app keeps the cells past the new width and draws them in the window's margin,
  // where no repaint reaches (pane borders were left there); clearing on every resize, before OpenTUI
  // repaints, drops them.
  renderer.on("resize", () => process.stdout.write("\x1b[2J"))
  attachNotifier(session, renderer)
  const theme = await themeProps(paths, renderer)
  const quit = new Promise<string | undefined>((resolve) => {
    // However the renderer ends (ctrl-c twice, or a hangup when the window closes: OpenTUI catches the
    // signal and destroys the renderer without exiting), the session closes and the view ends, so it
    // never lingers attached to the core with no terminal.
    renderer.on("destroy", () => {
      // What keeps running, read as the view goes, so quitting says so on the shell's screen.
      void Promise.race([session.request<StatusView>("core.status").catch(() => undefined), Bun.sleep(500).then(() => undefined)]).then((status) => {
        session.close()
        resolve(quitNote(status))
      })
    })
    // The prompt pane's launcher is this binary again (`cli-pane`), in a PTY of the view's own.
    const spawnPane = makePaneSpawner({ self: selfCommand(), socketPath: paths.socket, env: process.env })
    const spawnBuild = makeBuildSpawner({ env: process.env })
    const popOut = makePopper({ self: selfCommand(), env: process.env })
    const onPaste = pasteLogger(process.env)
    // A core that kept running through an update: the status bar's chip stops it and starts this binary's.
    // With the login service loaded, the service starts the new core, so triggers and bots outlive the view.
    const startService = () => startServiceCore(defaultServiceDeps(process.env, selfCommand(), process.env.USER)) === "started"
    const restart = () => restartCore({ paths, self: selfCommand(), env: process.env, request: (method, params) => session.request(method, params), startService })
    createRoot(renderer).render(<App session={session} onQuit={() => renderer.destroy()} restartCore={restart} spawnPane={spawnPane} spawnBuild={spawnBuild} popOut={popOut} layouts={fileStore(paths)} {...theme} {...(configChangedAt !== undefined ? { configChangedAt } : {})} {...(options.onboarding ? { onboarding: options.onboarding } : {})} {...(onPaste ? { onPaste } : {})} />)
  })
  const note = await quit
  // Once the renderer has left the alternate screen, which it does a moment after it's destroyed: written before,
  // the note would land on the alternate screen and go with it.
  if (note) await Bun.sleep(QUIT_NOTE_DELAY_MS)
  if (note) err(`${note}\n`)
  return 0
}

/** How long after the renderer is destroyed the quit note waits, for the terminal to be back on the shell's screen. */
export const QUIT_NOTE_DELAY_MS = 200

/** Enters the alternate screen; leaves it. */
export const ALT_SCREEN = { on: "\x1b[?1049h", off: "\x1b[?1049l" } as const

/**
 * The renderer, on the alternate screen from its first byte. OpenTUI asks the terminal what it can do
 * (XTGETTCAP, a kitty-graphics probe, DECRQM) before it switches screens; Terminal.app parses none of
 * them and prints their payloads ("+q4d73pppppp Gi=31337,…") onto the shell's own screen, where they
 * stayed after quitting. Switched first, they land on the alternate screen, which OpenTUI clears, and
 * its own switch back at the end returns to the shell as it was.
 */
export async function startRenderer(out: { isTTY?: boolean; write: (s: string) => unknown } = process.stdout): Promise<CliRenderer> {
  if (out.isTTY) out.write(ALT_SCREEN.on)
  try {
    return await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 30 })
  } catch (error) {
    if (out.isTTY) out.write(ALT_SCREEN.off)
    throw error
  }
}

/**
 * A popped view: the core holds `pane` as popped while this connection lasts, and again
 * after a reconnect, so the tiled views leave it out until this view goes. A pane another view holds is
 * refused before anything is drawn.
 */
async function runPopped(session: ViewSession, pane: PaneId, paths: Paths, err: (text: string) => void): Promise<number> {
  try {
    await session.request("view.pop", { pane })
  } catch (error) {
    session.close()
    err(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  session.onHello(() => void session.request("view.pop", { pane }).catch(() => {}))
  dropRenderTimings()
  const renderer = await startRenderer()
  renderer.on("resize", () => process.stdout.write("\x1b[2J"))
  const theme = await themeProps(paths, renderer)
  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => {
      session.close()
      resolve()
    })
    createRoot(renderer).render(<PoppedApp session={session} pane={pane} onQuit={() => renderer.destroy()} {...theme} />)
  })
  return 0
}
