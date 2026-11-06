// What every Trade tab pane draws: lines of coloured segments, some of them clickable, built by pure
// functions (so a test can read them) and drawn here, clipped to the pane. A clickable segment is
// always a chip: built with `chip`, drawn with `Chip`.
import { TextAttributes } from "@opentui/core"
import { Chip, type ChipKind, chipText } from "../chip"
import { C } from "../theme"

/** What a click on a segment does, for the card it's on. */
export type Act = "focus" | "approve" | "reject" | "details" | "requote" | "resend" | "abandon" | "stopHelp" | "copyReply" | "copy" | "walletsAll" | "walletsActive" | "fill" | "undo" | "tab" | "offer" | "ask" | "signals" | "pnlSpan" | "journalSearch" | "journalKind" | "journalOlder" | "approvals" | "away" | "walletsFind" | "closeEmpty" | "openToken"

export interface Seg {
  text: string
  fg: string
  act?: Act
  /** Set with `act`, by `chip`. */
  kind?: ChipKind
  /** What this chip acts on, where a line holds several (the ⧉ of each address under a reply); else the line's `ref`. */
  ref?: string
  bold?: boolean
}

/** A clickable segment: the only way to make one. Its text includes the chip's padding, so widths add up. */
export const chip = (label: string, act: Act, kind: ChipKind = "control"): Seg => ({ text: chipText(label), fg: C.ctl, act, kind })

export interface Line {
  segs: Seg[]
  bg?: string
  /** The card this line belongs to: a click on it highlights the card. */
  cardId?: string
  /** What a chip on a line with no card acts on, such as the turn `show all` opens. Never focuses a card. */
  ref?: string
  /** The item the line draws (an Activity entry's seq): a scrolled tail pane holds its view by it. */
  key?: string
  /**
   * The token the line is about, which ↑/↓ or a click picks: the link moves to it. `id`
   * is the row's own within its pane (a holding's wallet and mint), so the highlight stays on it as rows move.
   */
  pick?: RowPick
}

export interface RowPick {
  id: string
  /** The token it picks; "" for a row with none (a Journal row), which ↑/↓ and a click highlight without moving the link. */
  mint: string
  chain?: "solana" | "hood"
  /** What ctrl-t on the row puts on the input line: a question in the Candle Harness's own words (ask.ts). */
  ask?: string
}

export const line = (text: string, fg: string = C.ink, extra: Partial<Line> = {}): Line => ({ segs: [{ text, fg }], ...extra })
export const blank = (): Line => line("")
export const textOf = (l: Line): string => l.segs.map((s) => s.text).join("")

/** A row's segments as runs: each chip alone, and the plain segments between them together, drawn as one text. */
function runsOf(segs: readonly Seg[], chips: boolean): { chip?: Seg; texts: Seg[] }[] {
  const out: { chip?: Seg; texts: Seg[] }[] = []
  for (const s of segs) {
    if (s.act && chips) out.push({ chip: s, texts: [] })
    else if (out.length && !out.at(-1)!.chip) out.at(-1)!.texts.push(s)
    else out.push({ texts: [s] })
  }
  return out.length ? out : [{ texts: [{ text: "", fg: C.ink }] }]
}

/** Draws lines, each cut to `width`; a click on an acting segment calls `onAct`, elsewhere on a card line focuses that card, and on a token row picks it. */
export function Lines(props: { lines: readonly Line[]; width: number; onAct?: (cardId: string, act: Act) => void; onPick?: (pick: RowPick) => void }) {
  return (
    <>
      {props.lines.map((l, i) => {
        let room = props.width
        const segs = l.segs.flatMap((s) => {
          if (room <= 0) return []
          const text = s.text.length > room ? `${s.text.slice(0, Math.max(0, room - 1))}…` : s.text
          room -= text.length
          return [{ ...s, text }]
        })
        const cardId = l.cardId
        const pick = l.pick
        const down = cardId && props.onAct ? () => props.onAct!(cardId, "focus") : pick && props.onPick ? () => props.onPick!(pick) : undefined
        return (
          <box
            key={i}
            flexDirection="row"
            height={1}
            width={props.width}
            {...(l.bg ? { backgroundColor: l.bg } : {})}
            {...(down ? { onMouseDown: down } : {})}
          >
            {runsOf(segs, !!props.onAct).map((run, j, all) =>
              run.chip ? (
                <Chip key={j} label={run.chip.text.slice(1, -1)} kind={run.chip.kind ?? "control"} onClick={() => props.onAct!(run.chip!.ref ?? l.ref ?? cardId ?? "", run.chip!.act!)} />
              ) : (
                // One text a run, the last stretched to the row's end: OpenTUI keeps, within a row, only the pieces
                // inside a drag's columns, so pieces side by side dropped from a copy. One
                // selection colour for every run, so dim text doesn't highlight darker.
                <text key={j} selectionBg={C.sel} selectionFg={C.hi} {...(j === all.length - 1 ? { flexGrow: 1 } : {})}>
                  {run.texts.map((s, k) => (
                    <span key={k} fg={s.fg} {...(s.bold ? { attributes: TextAttributes.BOLD } : {})}>
                      {s.text}
                    </span>
                  ))}
                </text>
              ),
            )}
            {/* After a closing chip, the rest of the row: no width of its own, so nothing before it is squeezed. */}
            {segs.at(-1)?.act && props.onAct ? <text flexGrow={1} flexShrink={0} width={0} selectionBg={C.sel} selectionFg={C.hi}>{""}</text> : null}
          </box>
        )
      })}
    </>
  )
}
