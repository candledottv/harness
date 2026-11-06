// The layout menu's overlay: its rows by group, the highlighted one shaded, a click
// picks one. While "save as" asks, the name being typed. At its foot, where layouts.toml is and any
// problem found reading it, with its line.
import { usePointer } from "../chip"
import type { MouseEvent } from "@opentui/core"
import { wrap } from "../format"
import { type LayoutInfo, layoutMenuRows } from "../layout-menu"
import type { PaneId } from "../layout"
import { C, fit, OVERLAY_Z } from "../theme"

export interface LayoutMenuProps {
  info: LayoutInfo
  focus: PaneId | undefined
  index: number
  naming: string | undefined
  width: number
  height: number
  onPick: (index: number) => void
  onScroll: (delta: number) => void
}

export function LayoutMenu(p: LayoutMenuProps) {
  const pointer = usePointer()
  const rows = layoutMenuRows(p.info, p.focus)
  const w = Math.min(p.width - 4, 72)
  const inner = w - 4
  const foot = [
    ...(p.naming !== undefined ? [`name: ${p.naming}▏`, `⏎ ${rows[p.index]?.naming === "addTab" ? "adds the tab" : rows[p.index]?.naming === "renameTab" ? "renames the tab" : "saves it"} in layouts.toml · esc goes back`] : ["↑/↓ ⏎ or a click · esc closes"]),
    ...wrap(`layouts.toml: ${p.info.path}`, inner),
    ...p.info.problems.flatMap((x) => wrap(x, inner)).slice(0, 4),
  ]
  // Each group's heading, then its rows; the window keeps the highlighted row in view.
  const lines: ({ kind: "group"; text: string } | { kind: "row"; at: number })[] = []
  rows.forEach((r, at) => {
    if (at === 0 || rows[at - 1]!.group !== r.group) lines.push({ kind: "group", text: r.group })
    lines.push({ kind: "row", at })
  })
  const h = Math.min(p.height - 4, lines.length + foot.length + 3)
  const room = Math.max(1, h - 2 - foot.length - 1)
  const at = lines.findIndex((l) => l.kind === "row" && l.at === p.index)
  const start = Math.max(0, Math.min(lines.length - room, at - Math.floor(room / 2)))
  return (
    <box
      position="absolute" zIndex={OVERLAY_Z}
      left={Math.floor((p.width - w) / 2)}
      top={Math.floor((p.height - h) / 2)}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` layout · ${p.info.tab} `}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={(e: MouseEvent) => p.onScroll(e.scroll?.direction === "up" ? -3 : 3)}
    >
      {lines.slice(start, start + room).map((l) => {
        if (l.kind === "group") return <text key={`g${l.text}`} fg={C.head}>{fit(l.text, inner)}</text>
        const r = rows[l.at]!
        const on = l.at === p.index
        const label = `${on ? "▸" : " "} ${r.label}`
        const hint = r.hint ? `  ${r.hint}` : ""
        return (
          <box key={`r${l.at}`} flexDirection="row" backgroundColor={on ? C.sel : C.term} onMouseDown={() => p.onPick(l.at)} {...pointer}>
            <text fg={C.ctl}>{fit(label, inner - hint.length)}</text>
            {hint ? <text fg={C.dim}>{hint}</text> : null}
          </box>
        )
      })}
      <box flexGrow={1} />
      {foot.map((t, i) => (
        <text key={`f${i}`} fg={i === 0 && p.naming !== undefined ? C.hi : p.info.problems.some((x) => t && x.includes(t)) ? C.look : C.dim}>{fit(t, inner)}</text>
      ))}
    </box>
  )
}
