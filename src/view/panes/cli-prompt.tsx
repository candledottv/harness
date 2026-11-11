// The CLI prompt pane: where the user answers `candle`'s own prompts
// (a passphrase, a typed confirm, a path) for a card they approved. It opens over the agent pane,
// focused, with the focus border, titled with what runs and that the agent can't see it.
//   - ctrl-] leaves it running and shows the Candle Harness; a chip on the agent pane's border, or ctrl-] again,
//     comes back. Panes stack: a second card can open one while another waits;
//   - when the launcher exits, the last screen stays with the outcome line, and Enter or Esc closes it.
//     Closing drops its screen: no scrollback, no copy. A step's next steps are chips on that line too
//     (on the card alone, behind the pane, nobody saw them): a click closes the pane and puts the
//     command on the input line.
import { asSentence } from "../../core/pane-plan"
import type { PaneNextStep } from "../store"
import { shortAddress } from "../format"
import type { Rect } from "../layout"
import { Chip } from "../chip"
import { EmbeddedTerminal } from "../embedded-terminal"
import type { PaneProcess } from "../pane-process"
import { C, fit } from "../theme"
import { SOLANA_ADDRESS_SOURCE } from "../../shared/chains"

/** One open prompt pane. The ticket isn't kept: it went to the launcher's environment, once. */
export interface Prompt {
  ticketId: string
  opId?: string
  title: string
  proc: PaneProcess
  /** The launcher's exit status, once it has exited. */
  exited?: number
  /** Left with ctrl-]: still running, the Candle Harness shown. */
  hidden: boolean
}

export const PANE_FOOTER_RUNNING = "ctrl-] back to the Candle Harness · Ctrl-C stops it · the agent can't see this pane"

const CLOSES = "  ⏎ or Esc closes"

/**
 * The pane's last line, cut to `width`: how to leave it while it runs, its outcome once it has exited.
 * A narrow pane cuts the outcome, never how to close it: the launcher printed the outcome in full above.
 */
export function promptFooter(prompt: Prompt, outcome: string | undefined, width: number, running = PANE_FOOTER_RUNNING, closes = CLOSES): string {
  if (prompt.exited === undefined) return fit(running, width)
  return `${fit(outcome ? asSentence(outcome) : "The pane has closed.", Math.max(4, width - closes.length))}${closes}`
}

/** A pane's title as drawn: addresses shortened (the card's hash covers them in full), cut to the border. */
export function promptTitle(title: string, width: number): string {
  const short = title.replace(new RegExp(SOLANA_ADDRESS_SOURCE, "g"), (a) => shortAddress(a))
  return fit(short, Math.max(4, width - 6))
}

/** The terminal's size inside the pane: its border, and the footer line. */
export const promptInner = (rect: Rect) => ({ cols: Math.max(20, rect.w - 2), rows: Math.max(5, rect.h - 3) })

export function CliPrompt(p: {
  prompt: Prompt
  rect: Rect
  focused: boolean
  outcome?: string
  next?: readonly PaneNextStep[]
  onInput: (bytes: Uint8Array) => void
  onFocus: () => void
  onFill?: (line: string, cursor?: number) => void
  /** A next step that copies a value: a wallet's address. */
  onCopy?: (text: string) => void
  /** What the footer says while it runs: onboarding's says "back to setup", with no agent to name. */
  running?: string
  /** How it closes, once it has exited: setup's says it offers a step that didn't work again. */
  closes?: string
}) {
  const { rect, prompt } = p
  const inner = promptInner(rect)
  // Whole chips, in order, while they fit beside how to close it and a little of the outcome; one that doesn't is left out, never cut.
  const offered = prompt.exited !== undefined && p.onFill ? (p.next ?? []) : []
  const room = rect.w - 2 - CLOSES.length - 4
  const next = offered.filter((_, i) => i === 0 || offered.slice(0, i + 1).reduce((n, c) => n + c.label.length + 3, 0) <= room)
  const chipCells = next.reduce((n, c) => n + c.label.length + 3, 0)
  const footer = promptFooter(prompt, p.outcome, Math.max(4, rect.w - 2 - chipCells), p.running, p.closes)
  return (
    <box
      position="absolute"
      left={rect.x}
      top={rect.y}
      width={rect.w}
      height={rect.h}
      border
      borderStyle="rounded"
      borderColor={p.focused ? C.focus : C.edge}
      titleColor={C.head}
      title={` ${promptTitle(prompt.title, rect.w)} `}
      backgroundColor={C.term}
      flexDirection="column"
      visible={!prompt.hidden}
      onMouseDown={p.onFocus}
    >
      <EmbeddedTerminal proc={prompt.proc} width={inner.cols} height={inner.rows} focused={p.focused} onInput={p.onInput} onClick={p.onFocus} />
      {next.length === 0 ? (
        <text height={1} fg={prompt.exited === undefined ? C.dim : C.ink}>
          {footer}
        </text>
      ) : (
        <box height={1} flexDirection="row">
          <text fg={C.ink}>{footer.slice(0, footer.length - CLOSES.length)}</text>
          {next.map((n) => (
            <box key={"copy" in n ? `copy-${n.copy}` : n.line} flexDirection="row">
              <text> </text>
              <Chip label={n.label} onClick={() => ("copy" in n ? p.onCopy?.(n.copy) : p.onFill!(n.line, n.cursor))} />
            </box>
          ))}
          <text fg={C.ink}>{CLOSES}</text>
        </box>
      )}
    </box>
  )
}

/** The panes left with ctrl-], as chips on the agent pane's top border: a click comes back to one. */
export function PromptChips(p: { prompts: readonly Prompt[]; rect: Rect; onShow: (ticketId: string) => void }) {
  const hidden = p.prompts.filter((x) => x.hidden)
  if (hidden.length === 0) return null
  const label = (x: Prompt) => `▣ ${promptTitle(x.title.replace(/ · the agent can't see this pane$/, ""), 34)}${x.exited === undefined ? "" : " (ended)"}`
  const width = hidden.reduce((n, x) => n + label(x).length + 3, 0)
  return (
    <box position="absolute" zIndex={10} left={Math.max(p.rect.x + 2, p.rect.x + p.rect.w - width - 2)} top={p.rect.y} height={1} flexDirection="row" backgroundColor={C.term}>
      {hidden.map((x) => (
        <box key={x.ticketId} flexDirection="row">
          <text> </text>
          <Chip label={label(x)} onClick={() => p.onShow(x.ticketId)} />
        </box>
      ))}
    </box>
  )
}
