// The person's view of an agent's memory: the `memory` chip on the agent
// pane's border, or the palette's memory row, opens it. It lists the index's lines and the files
// beside it, each with a ✕ chip that deletes it (or ⌫ on the highlighted row), and "clear all", which asks
// once. Each line has a pin or unpin chip (or ⏎): a pinned line sits under the index's ## Pinned, first
// here, and its delete asks once. A heading is a row as well, deleted as any line and never pinned; the highlighted
// row shows whole, wrapped, since every word of it reaches the agent's prompt. No key of its own: ctrl-y is readline's yank, and the palette (ctrl-k) reaches it. The agent writes its
// memory with its own file tools; the person's deletes go through the core, which journals them as theirs.
import type { MemoryFile, MemoryView } from "../../core/memory"
import { Chip, chipText, usePointer } from "../chip"
import { wrap } from "../format"
import { C, fit, OVERLAY_Z } from "../theme"

/** The `memory` topic: each agent's memory as the core last read it. */
export interface MemoryTopic {
  agents: Record<string, MemoryView>
}

export type MemoryRow = { kind: "entry"; id: string; text: string; pinned?: true; heading?: true } | ({ kind: "file" } & MemoryFile) | { kind: "clear" }

/** The overlay's rows, in order: the index's lines, the other files, then "clear all" when there's anything. */
export function memoryRows(view: MemoryView | undefined): MemoryRow[] {
  if (!view) return []
  const rows: MemoryRow[] = [...view.entries.map((e) => ({ kind: "entry" as const, ...e })), ...view.files.map((f) => ({ kind: "file" as const, ...f }))]
  return rows.length ? [...rows, { kind: "clear" }] : rows
}

const pinnedCount = (view: MemoryView) => view.entries.filter((e) => e.pinned).length

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

function rowText(row: MemoryRow, confirm: boolean): string {
  if (row.kind === "entry") return confirm ? "delete this pinned line? ⌫ or ✕ yes · esc no" : row.text
  if (row.kind === "file") return `memory/${row.path} · ${row.link ? "a link, never read" : kb(row.bytes)}`
  return confirm ? "clear all of it? ⏎ yes · esc no" : "clear all"
}

export function MemoryOverlay(props: {
  agent: string
  view: MemoryView | undefined
  index: number
  confirm: boolean
  /** The pinned line whose delete is asking, by its id. */
  confirmPinned?: string
  width: number
  height: number
  onDelete: (row: MemoryRow) => void
  /** A line's pin or unpin chip. */
  onPin: (row: MemoryRow) => void
  /** "clear all": the first press asks, the second clears. */
  onClear: () => void
}) {
  const pointer = usePointer()
  const rows = memoryRows(props.view)
  const w = Math.min(props.width - 4, 100)
  const inner = w - 4
  const head = props.view
    ? [
        props.view.unread ? `Not read: ${props.view.unread}.` : `${props.view.entries.length} in the index${pinnedCount(props.view) ? `, ${pinnedCount(props.view)} pinned` : ""}, ${kb(props.view.chars)}${props.view.long ? ": long, so the agent is asked to merge it" : ""}.`,
        `${props.view.dir}`,
      ]
    : ["The core hasn't said yet."]
  const empty = props.view && rows.length === 0 ? ["Nothing yet: the agent writes its memory with its own file tools."] : []
  // What was said in chat stays in the conversation the agent is given, whatever's deleted here.
  const said = props.view ? wrap("Every line here goes into each turn, headings too. A line takes the file it points to. A pinned line stays through the agent's merges. What you told the agent in chat stays in the conversation.", inner) : []
  const footer = "↑/↓ · ⏎ pins or unpins · ⌫ or ✕ deletes · esc closes"
  const index = Math.min(props.index, Math.max(0, rows.length - 1))
  const x = chipText("✕").length
  const pinChip = (row: MemoryRow) => (row.kind === "entry" && !row.heading ? (row.pinned ? "unpin" : "pin") : undefined)
  const chipCells = (row: MemoryRow) => (row.kind === "clear" ? 0 : x + 1 + (pinChip(row) ? chipText(pinChip(row)!).length + 1 : 0))
  const markOf = (row: MemoryRow) => (row.kind === "entry" && row.pinned ? "pinned · " : "")
  // The highlighted line shows whole, wrapped under itself: all of it reaches the agent's prompt, so none of it
  // may be out of sight. The others keep one row each, cut with an ellipsis, and ↑/↓ opens any of them.
  const picked = rows[index]
  const asks = picked?.kind === "entry" && picked.id === props.confirmPinned
  const whole = picked?.kind === "entry" && !asks ? wrap(picked.text, Math.max(8, inner - chipCells(picked) - 2 - markOf(picked).length)) : []
  const fixed = head.length + said.length + empty.length + 3
  const most = Math.max(1, props.height - 4 - fixed)
  const more = Math.max(0, Math.min(whole.length, most) - 1)
  // Rows that fit, keeping the highlighted one in view, with the rows its own lines take.
  const room = Math.max(1, Math.min(most, rows.length + more) - more)
  const first = Math.max(0, Math.min(index - room + 1, rows.length - room))
  const shown = rows.slice(first, first + room)
  const h = Math.min(props.height - 4, fixed + shown.length + more)
  return (
    <box
      position="absolute" zIndex={OVERLAY_Z}
      left={Math.floor((props.width - w) / 2)}
      top={Math.floor((props.height - h) / 2)}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` ${props.agent}'s memory `}
      flexDirection="column"
    >
      {head.map((line, i) => (
        <text key={`h${i}`} fg={C.dim}>
          {fit(line, inner)}
        </text>
      ))}
      {said.map((line, i) => (
        <text key={`s${i}`} fg={C.dim}>
          {fit(line, inner)}
        </text>
      ))}
      {empty.map((line, i) => (
        <text key={`e${i}`} fg={C.ink}>
          {fit(line, inner)}
        </text>
      ))}
      {shown.map((row, i) => {
        const at = first + i
        const selected = at === index
        const clear = row.kind === "clear"
        const asking = clear ? props.confirm : row.kind === "entry" && row.id === props.confirmPinned
        const pin = pinChip(row)
        const chips = chipCells(row)
        // A pinned line is marked before its words, in the heading's colour.
        const mark = asking ? "" : markOf(row)
        const textW = Math.max(1, inner - chips - 2 - mark.length)
        // The highlighted line's own rows: its first beside the chips, the rest under it.
        const lines = selected && whole.length > 1 ? whole.slice(0, more + 1) : undefined
        const cut = lines !== undefined && whole.length > lines.length
        return (
          <box key={at} flexDirection="column" height={lines ? lines.length : 1} backgroundColor={selected ? C.sel : C.term}>
            <box flexDirection="row" height={1} {...(clear ? { onMouseDown: props.onClear, ...pointer } : {})}>
              <text fg={asking ? C.bad : clear ? C.ctl : row.kind === "file" ? C.dim : C.ink}>
                {`${selected ? "▸" : " "} `}
                {mark ? <span fg={C.head}>{mark}</span> : null}
                {lines ? lines[0] : fit(rowText(row, asking), textW)}
              </text>
              <box flexGrow={1} />
              {pin ? <Chip label={pin} onClick={() => props.onPin(row)} /> : null}
              {pin ? <text> </text> : null}
              {clear ? null : <Chip label="✕" kind="danger" onClick={() => props.onDelete(row)} />}
            </box>
            {lines?.slice(1).map((l, j) => (
              <text key={j} fg={C.ink}>
                {`  ${" ".repeat(mark.length)}${cut && j === lines.length - 2 ? fit(`${l} …`, textW) : l}`}
              </text>
            ))}
          </box>
        )
      })}
      <text fg={C.dim}>{fit(footer, inner)}</text>
    </box>
  )
}
