// The input line, at the bottom: a command runs, anything else goes to the agent. Above it, one line
// for what just happened (a refusal, a prompt to press again). Right of what's typed, the hint line,
// from keymap.ts's table: what Enter and Esc do here, then the palette's chip and
// help's. It takes only the room the line leaves, so it never moves a row: Enter's word goes last,
// the palette's chip before it, and Esc's and help's first.
import { Chip, chipText } from "./chip"
import { wrap } from "./format"
import type { UiState } from "./keys"
import { chordOf, type Here, hintsHere } from "./keymap"
import { C, fit } from "./theme"

const PLACEHOLDER = "type a command or ask the agent"
/** The least of the placeholder the hints leave, so an empty line still says what it's for. */
const PLACEHOLDER_KEEPS = 16
export const PALETTE_CHIP = `${chordOf("palette")} palette`
const HELP_CHIP = "? help"

type Part = { kind: "hint"; id: string; chord: string; words: string } | { kind: "chip"; id: "palette" | "help"; label: string }

const partCells = (p: Part): number => (p.kind === "chip" ? chipText(p.label).length : p.chord.length + 1 + p.words.length) + 2

/**
 * The hint line's parts that fit in `room` cells, in the order they show (Enter's and Esc's words, the
 * palette's chip, help's), chosen by what matters most: what Enter does, the palette, Esc, the pane ctrl-p moves, help.
 */
export function hintParts(here: Here, room: number, chips: { palette: boolean; help: boolean }): Part[] {
  const hints: Part[] = hintsHere(here)
    .filter((h) => h.id !== "palette")
    .map((h) => ({ kind: "hint", id: h.id, chord: h.chord, words: h.words }))
  const all: Part[] = [...hints, ...(chips.palette ? [{ kind: "chip", id: "palette", label: PALETTE_CHIP } as Part] : []), ...(chips.help && here.empty ? [{ kind: "chip", id: "help", label: HELP_CHIP } as Part] : [])]
  const rank = (p: Part) => ["search", "searchJournal", "approve", "send", "palette", "stop", "popOut", "help"].indexOf(p.id)
  let left = room
  const kept = new Set<Part>()
  for (const p of [...all].sort((a, b) => rank(a) - rank(b))) {
    if (partCells(p) > left) continue
    kept.add(p)
    left -= partCells(p)
  }
  return all.filter((p) => kept.has(p))
}

export function InputLine(props: { left?: number; width: number; top: number; ui: UiState; here: Here; onHelp?: () => void; onPalette?: () => void }) {
  const { ui } = props
  const prompt = "› "
  const room = Math.max(1, props.width - prompt.length - 1)
  // Keep the cursor in view on a long line.
  const start = Math.max(0, ui.cursor - room + 1)
  const shown = ui.input.slice(start, start + room)
  const at = ui.cursor - start
  const typed = ui.input === "" ? Math.min(PLACEHOLDER.length, PLACEHOLDER_KEEPS) : shown.length + 1
  const parts = hintParts(props.here, room - typed - 1, { palette: !!props.onPalette, help: !!props.onHelp })
  const placeholder = fit(PLACEHOLDER, room - parts.reduce((n, p) => n + partCells(p), 0) - 1)
  return (
    <box position="absolute" left={props.left ?? 0} top={props.top} width={props.width} height={1} backgroundColor={C.bar} flexDirection="row">
      <text fg={C.hi}>{prompt}</text>
      {ui.input === "" ? (
        <text fg={C.dim}>{placeholder}</text>
      ) : (
        <text fg={C.ink}>
          {shown.slice(0, at)}
          <span bg={C.ink} fg={C.page}>
            {shown[at] ?? " "}
          </span>
          {shown.slice(at + 1)}
        </text>
      )}
      <box flexGrow={1} />
      {parts.map((p) =>
        p.kind === "chip" ? (
          <box key={p.id} flexDirection="row" flexShrink={0}>
            <Chip label={p.label} onClick={p.id === "palette" ? props.onPalette! : props.onHelp!} />
            <text fg={C.dim}>{"  "}</text>
          </box>
        ) : (
          <text key={p.id} fg={C.dim}>
            <span fg={C.ink}>{p.chord}</span>
            {` ${p.words}  `}
          </text>
        ),
      )}
    </box>
  )
}

/** Rows a message may take: a long one (a refusal with its numbers, or why a typed trade can't run) wraps upward. */
// Four: the lines sit under the agent pane, narrower than the window.
export const MESSAGE_ROWS = 4

/** The message's lines at this width: up to MESSAGE_ROWS, the last cut to fit. */
function messageLines(ui: UiState, width: number): string[] {
  const lines = ui.message ? wrap(ui.message.text, Math.max(1, width - 2)) : [""]
  return lines.length > MESSAGE_ROWS ? [...lines.slice(0, MESSAGE_ROWS - 1), fit(lines.slice(MESSAGE_ROWS - 1).join(" "), width - 2)] : lines
}

/**
 * Rows the message line takes: its wrapped lines, plus one for an offer to ask the agent. A long
 * message wraps upward, so a notice isn't cut off at 108 columns. The body
 * gives up the rows above the first while it shows, so the panes keep their borders (at 80×24 a
 * wrapped refusal had covered them).
 */
export function messageRows(ui: UiState, width: number, canAsk: boolean): number {
  return messageLines(ui, width).length + (ui.message?.ask !== undefined && canAsk ? 1 : 0) + (ui.message?.copy !== undefined ? 1 : 0)
}

export function MessageLine(props: { left?: number; width: number; top: number; ui: UiState; onAsk?: () => void; onCopy?: (text: string) => void }) {
  const m = props.ui.message
  const ask = m?.ask !== undefined && props.onAsk ? props.onAsk : undefined
  const copy = m?.copy
  const shown = messageLines(props.ui, props.width)
  // An offer to ask the agent takes a row of its own, under the why; so does a command to copy (a pop-out with nowhere to go).
  const rows = messageRows(props.ui, props.width, ask !== undefined)
  const top = props.top - (rows - 1)
  return (
    <box position="absolute" left={props.left ?? 0} top={top} width={props.width} height={rows} backgroundColor={C.page} flexDirection="column">
      {shown.map((line, i) => (
        <text key={i} fg={m?.level === "error" ? C.bad : C.dim}>
          {fit(` ${line}`, props.width)}
        </text>
      ))}
      {ask ? (
        <box flexDirection="row" height={1}>
          <text fg={C.dim}> </text>
          <Chip label="ctrl-t ask the agent" onClick={ask} />
          <text fg={C.dim}>{fit("  sends the line as typed; the agent confirms the token with you", Math.max(0, props.width - 24))}</text>
        </box>
      ) : null}
      {copy !== undefined ? (
        <box flexDirection="row" height={1}>
          <text fg={C.dim}> </text>
          <Chip label="⧉ copy" onClick={() => props.onCopy?.(copy)} />
          <text fg={C.ink}>{fit(`  ${copy}`, Math.max(0, props.width - 10))}</text>
        </box>
      ) : null}
    </box>
  )
}
