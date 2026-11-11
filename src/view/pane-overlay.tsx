// A pane folded into its tab's strip, opened over the frame by its chip: its own lines and chips, in a box as the
// Away overlay's, scrolled where they don't fit. Esc or any other key closes it; a click never adds a pane.
import type { Line } from "./panes/lines"
import { type Act, Lines } from "./panes/lines"
import { Chip, chipText } from "./chip"
import { C, fit, OVERLAY_Z } from "./theme"

/** The box: as wide as the window allows up to 72, as tall as its lines up to the window less the bars. */
export function paneOverlayFit(lines: readonly Line[], width: number, height: number): { w: number; h: number; fits: number } {
  const w = Math.min(72, Math.max(30, width - 4))
  const h = Math.min(height - 4, lines.length + 3)
  return { w, h, fits: Math.max(1, h - 3) }
}

export function PaneOverlay(props: { title: string; lines: readonly Line[]; scroll: number; width: number; height: number; onAct: (ref: string, act: Act) => void; onScroll: (delta: number) => void }) {
  const { w, h, fits } = paneOverlayFit(props.lines, props.width, props.height)
  const from = Math.max(0, Math.min(props.lines.length - fits, props.scroll))
  const below = Math.max(0, props.lines.length - from - fits)
  const marks = [from ? `↑ ${from} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean).join(" · ")
  return (
    <box
      position="absolute"
      zIndex={OVERLAY_Z}
      left={Math.floor((props.width - w) / 2)}
      top={Math.floor((props.height - h) / 2)}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` ${props.title} `}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={(e: { scroll?: { direction: string } }) => props.onScroll(e.scroll?.direction === "up" ? -3 : 3)}
    >
      <Lines lines={props.lines.slice(from, from + fits)} width={w - 4} onAct={props.onAct} />
      <text fg={C.dim}>{`${marks ? `${marks} · ↑/↓ scroll · ` : ""}esc closes`}</text>
    </box>
  )
}

/**
 * A code bot's card the Build pane's harness proposed, or a code bot's own trade that arrived while the harness had the
 * keys, whole over the frame with focus on it: the strip above the input line would cut its headline and command, and
 * the harness's Enter isn't an approval. ⏎ approves it after the usual 300 ms; Esc goes back to the harness, and the
 * card waits in the strip.
 */
/** The card's own rows in the overlay: the window less the bars, the box and its footer. */
export const buildCardRows = (height: number): number => Math.max(4, height - 6)

export function BuildCardOverlay(props: { lines: readonly Line[]; width: number; height: number; onAct: (ref: string, act: Act) => void; waiting?: boolean; onTake?: () => void; title?: string }) {
  const w = Math.min(84, Math.max(36, props.width - 4))
  const fits = buildCardRows(props.height)
  const shown = props.lines.slice(0, fits)
  const h = shown.length + 3
  return (
    <box
      position="absolute"
      zIndex={OVERLAY_Z}
      left={Math.floor((props.width - w) / 2)}
      top={Math.max(1, Math.floor((props.height - h) / 2))}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={props.waiting ? C.edge : C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` ${props.title ?? "your harness proposed a bot"} `}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <Lines lines={shown} width={w - 4} onAct={props.onAct} />
      {props.waiting ? (
        <box flexDirection="row" height={1}>
          <Chip label="review" onClick={() => props.onTake?.()} />
          <text fg={C.look}>{fit(" or ctrl-] · the keys are still your harness's", w - 4 - chipText("review").length)}</text>
        </box>
      ) : (
        <text fg={C.dim}>{"⏎ approve · ctrl-n reject · esc back to the harness, the card waits"}</text>
      )}
    </box>
  )
}
