// A PTY drawn in a pane: EmbeddedTerminalRenderable, for the prompt pane. What it needs: both sizes
// explicit (with flex alone it keeps 80×24 as a minimum and overdraws a smaller pane), focus from one place
// (the frame's), and a click handler on the terminal itself (once the child turns mouse reporting on, a
// click never bubbles to the box around it). The whole-screen clear on resize is the view's own (run.tsx).
//
// The prompt pane's keeps no scrollback and takes no part in text selection: what it shows stays in the pane, and
// goes when it unmounts. The Build pane's harness keeps 5,000 lines and can be selected and copied, as in any terminal.
import { EmbeddedTerminalRenderable } from "@opentui/core"
import { extend } from "@opentui/react"
import { useEffect, useRef } from "react"
import type { PaneProcess } from "./pane-process"

extend({ embeddedTerminal: EmbeddedTerminalRenderable })

declare module "@opentui/react" {
  interface OpenTUIComponents {
    embeddedTerminal: typeof EmbeddedTerminalRenderable
  }
}

export interface EmbeddedTerminalProps {
  proc: PaneProcess
  width: number
  height: number
  focused: boolean
  /** Every key the user typed into the pane, after it went to the PTY: the frame watches for Ctrl-C. */
  onInput?: (bytes: Uint8Array) => void
  onClick?: () => void
  /** Lines kept above the screen: none for the prompt pane. */
  maxScrollback?: number
  /** Whether its text takes part in selection: off for the prompt pane. */
  selectable?: boolean
  /** The terminal's default text and background, the theme's; without them, white on black. A harness may set its own. */
  colours?: { fg: string; bg: string }
}

/** The OSC 10 and 11 sequences that set a terminal's default foreground and background. */
export const defaultColours = (c: { fg: string; bg: string }) => `\x1b]10;${c.fg}\x07\x1b]11;${c.bg}\x07`

/** Written when another process takes the terminal: a full reset, the screen and its scrollback cleared. */
export const FRESH_TERMINAL = "\x1bc\x1b[3J\x1b[2J\x1b[H"

export function EmbeddedTerminal(p: EmbeddedTerminalProps) {
  const ref = useRef<EmbeddedTerminalRenderable>(null)
  const attached = useRef<PaneProcess | null>(null)
  useEffect(() => {
    if (attached.current === p.proc) return
    // Another process in the same terminal (a harness started after one exited): the last one's screen goes first,
    // rather than showing under the new one's title until it draws.
    if (attached.current) ref.current?.write(FRESH_TERMINAL)
    if (p.colours) ref.current?.write(defaultColours(p.colours))
    attached.current = p.proc
    // Unmounted, the ref is null and the bytes go nowhere: nothing of the pane is kept.
    p.proc.onData((chunk) => ref.current?.write(chunk))
  }, [p.proc])
  // A theme picked while it runs: the defaults follow, what the harness drew in its own colours stays.
  const fg = p.colours?.fg
  const bg = p.colours?.bg
  useEffect(() => {
    if (fg && bg) ref.current?.write(defaultColours({ fg, bg }))
  }, [fg, bg])
  useEffect(() => {
    if (p.focused) ref.current?.focus()
    else ref.current?.blur()
  }, [p.focused])
  // The process is told every size it's drawn at, the first included: a harness started at one width and drawn at
  // another (the Build pane's first open fills the tab, its side column comes after) drew over itself.
  useEffect(() => {
    p.proc.resize(p.width, p.height)
  }, [p.proc, p.width, p.height])
  return (
    <embeddedTerminal
      ref={ref}
      width={p.width}
      height={p.height}
      maxScrollback={p.maxScrollback ?? 0}
      selectable={p.selectable ?? false}
      onData={(data: Uint8Array, source: string) => {
        p.proc.write(data)
        if (source === "input") p.onInput?.(data)
      }}
      onTerminalResize={(cols: number, rows: number) => p.proc.resize(cols, rows)}
      onMouseDown={() => p.onClick?.()}
    />
  )
}
