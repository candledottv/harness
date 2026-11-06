// `candle-harness` (or `candle-harness view`): attach to the core, starting one if none is running, and draw
// the frame until the user quits (ctrl-c twice). The core keeps running for 60 s after the last view
// goes, then exits, unless something still holds it (a card, an operation being read back).
import { appendFileSync, readFileSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { type CliRenderer, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { selfCommand } from "../core/core-main"
import type { Paths } from "../paths"
import { Redactor } from "../shared/redact"
import { fileStore } from "./layouts-store"
import { App } from "./app"
import { attachView } from "./attach"
import { makePaneSpawner } from "./pane-process"
import { PoppedApp } from "./popped"
import { makePopper } from "./popout"
import type { ViewSession } from "../core/client"
import type { PaneId } from "../shared/panes"
import { TERMINAL, type TerminalColours } from "./theme"
import { configTheme, fileThemes, startingTheme, type ThemeStore } from "./themes"

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

/**
 * The long-paste check: with CANDLE_HARNESS_PASTE_LOG naming a file, each paste the
 * terminal delivers to the input line is appended to it (0600) as one JSON line, its length, SHA-256 and text,
 * so a script can diff what arrived against what was pasted. Off unless set, and it may be left set: the
 * prompt pane's and setup's pastes are never logged, and a paste holding anything shaped like a key keeps
 * only its length and SHA-256, never its text.
 */
export function pasteLogger(env: Record<string, string | undefined>): ((text: string) => void) | undefined {
  const file = env.CANDLE_HARNESS_PASTE_LOG
  if (!file || !isAbsolute(file)) return undefined
  const redactor = new Redactor()
  return (text) => {
    const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    const shown = redactor.text(text) === text ? { text } : {}
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), length: text.length, sha256, ...shown })}\n`, { mode: 0o600 })
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
  const theme = await themeProps(paths, renderer)
  const quit = new Promise<void>((resolve) => {
    // However the renderer ends (ctrl-c twice, or a hangup when the window closes: OpenTUI catches the
    // signal and destroys the renderer without exiting), the session closes and the view ends, so it
    // never lingers attached to the core with no terminal.
    renderer.on("destroy", () => {
      session.close()
      resolve()
    })
    // The prompt pane's launcher is this binary again (`cli-pane`), in a PTY of the view's own.
    const spawnPane = makePaneSpawner({ self: selfCommand(), socketPath: paths.socket, env: process.env })
    const popOut = makePopper({ self: selfCommand(), env: process.env })
    const onPaste = pasteLogger(process.env)
    createRoot(renderer).render(<App session={session} onQuit={() => renderer.destroy()} spawnPane={spawnPane} popOut={popOut} layouts={fileStore(paths)} {...theme} {...(configChangedAt !== undefined ? { configChangedAt } : {})} {...(options.onboarding ? { onboarding: options.onboarding } : {})} {...(onPaste ? { onPaste } : {})} />)
  })
  await quit
  return 0
}

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
