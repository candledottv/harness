// The person's view of an agent's memory: the `memory` chip on the agent
// pane's border, or the palette's memory row, opens it. It lists the index's lines and the files
// beside it, each with a ✕ chip that deletes it (or ⌫ on the highlighted row), and "clear all", which asks
// once. No key of its own: ctrl-y is readline's yank, and the palette (ctrl-k) reaches it. The agent writes its
// memory with its own file tools; the person's deletes go through the core, which journals them as theirs.
import type { MemoryFile, MemoryView } from "../../core/memory"
import { Chip, chipText, usePointer } from "../chip"
import { wrap } from "../format"
import { C, fit, OVERLAY_Z } from "../theme"

/** The `memory` topic: each agent's memory as the core last read it. */
export interface MemoryTopic {
  agents: Record<string, MemoryView>
}

export type MemoryRow = { kind: "entry"; id: string; text: string } | ({ kind: "file" } & MemoryFile) | { kind: "clear" }

/** The overlay's rows, in order: the index's lines, the other files, then "clear all" when there's anything. */
export function memoryRows(view: MemoryView | undefined): MemoryRow[] {
  if (!view) return []
  const rows: MemoryRow[] = [...view.entries.map((e) => ({ kind: "entry" as const, ...e })), ...view.files.map((f) => ({ kind: "file" as const, ...f }))]
  return rows.length ? [...rows, { kind: "clear" }] : rows
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

function rowText(row: MemoryRow, confirm: boolean): string {
  if (row.kind === "entry") return row.text
  if (row.kind === "file") return `memory/${row.path} · ${row.link ? "a link, never read" : kb(row.bytes)}`
  return confirm ? "clear all of it? ⏎ yes · esc no" : "clear all"
}

export function MemoryOverlay(props: {
  agent: string
  view: MemoryView | undefined
  index: number
  confirm: boolean
  width: number
  height: number
  onDelete: (row: MemoryRow) => void
  /** "clear all": the first press asks, the second clears. */
  onClear: () => void
}) {
  const pointer = usePointer()
  const rows = memoryRows(props.view)
  const w = Math.min(props.width - 4, 100)
  const inner = w - 4
  const head = props.view
    ? [
        props.view.unread ? `Not read: ${props.view.unread}.` : `${props.view.entries.length} in the index, ${kb(props.view.chars)}${props.view.long ? ": long, so the agent is asked to merge it" : ""}.`,
        `${props.view.dir}`,
      ]
    : ["The core hasn't said yet."]
  const empty = props.view && rows.length === 0 ? ["Nothing yet: the agent writes its memory with its own file tools."] : []
  // What was said in chat stays in the conversation the agent is given, whatever's deleted here.
  const said = props.view ? wrap("A line takes the file it points to. What you told the agent in chat stays in the conversation.", inner) : []
  const footer = "↑/↓ · ⌫ or ✕ deletes · esc closes"
  // Rows that fit, keeping the highlighted one in view.
  const room = Math.max(1, Math.min(props.height - 4, rows.length + head.length + said.length + empty.length + 3) - head.length - said.length - empty.length - 3)
  const index = Math.min(props.index, Math.max(0, rows.length - 1))
  const first = Math.max(0, Math.min(index - room + 1, rows.length - room))
  const shown = rows.slice(first, first + room)
  const h = Math.min(props.height - 4, head.length + said.length + empty.length + shown.length + 3)
  const x = chipText("✕").length
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
        return (
          <box key={at} flexDirection="row" height={1} backgroundColor={selected ? C.sel : C.term} {...(clear ? { onMouseDown: props.onClear, ...pointer } : {})}>
            <text fg={clear ? (props.confirm ? C.bad : C.ctl) : row.kind === "file" ? C.dim : C.ink}>{fit(`${selected ? "▸" : " "} ${rowText(row, props.confirm && clear)}`, inner - (clear ? 0 : x + 1))}</text>
            <box flexGrow={1} />
            {clear ? null : <Chip label="✕" kind="danger" onClick={() => props.onDelete(row)} />}
          </box>
        )
      })}
      <text fg={C.dim}>{fit(footer, inner)}</text>
    </box>
  )
}
