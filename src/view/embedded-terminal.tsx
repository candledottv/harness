// A PTY drawn in a pane: EmbeddedTerminalRenderable, for the prompt pane. What it needs: both sizes
// explicit (with flex alone it keeps 80×24 as a minimum and overdraws a smaller pane), focus from one place
// (the frame's), and a click handler on the terminal itself (once the child turns mouse reporting on, a
// click never bubbles to the box around it). The whole-screen clear on resize is the view's own (run.tsx).
//
// It keeps no scrollback and takes no part in text selection: what the pane shows stays in the pane, and
// goes when it unmounts.
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
}

export function EmbeddedTerminal(p: EmbeddedTerminalProps) {
  const ref = useRef<EmbeddedTerminalRenderable>(null)
  const attached = useRef<PaneProcess | null>(null)
  useEffect(() => {
    if (attached.current === p.proc) return
    attached.current = p.proc
    // Unmounted, the ref is null and the bytes go nowhere: nothing of the pane is kept.
    p.proc.onData((chunk) => ref.current?.write(chunk))
  }, [p.proc])
  useEffect(() => {
    if (p.focused) ref.current?.focus()
    else ref.current?.blur()
  }, [p.focused])
  return (
    <embeddedTerminal
      ref={ref}
      width={p.width}
      height={p.height}
      maxScrollback={0}
      selectable={false}
      onData={(data: Uint8Array, source: string) => {
        p.proc.write(data)
        if (source === "input") p.onInput?.(data)
      }}
      onTerminalResize={(cols: number, rows: number) => p.proc.resize(cols, rows)}
      onMouseDown={() => p.onClick?.()}
    />
  )
}
