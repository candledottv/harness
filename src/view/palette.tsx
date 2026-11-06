// The palette: ctrl-k, or the chip on the hint line. One list, searched together: the Candle Harness's own actions with
// their keys, the tabs, the layouts, the panes, the agents, each agent's preset and memory, the model picker,
// the tokens seen this session, then every Candle CLI command, grouped as the CLI's help groups them, with the
// CLI's own line on what it does, the rule the agent meets and whether it can do it now. Typing searches.
// Enter, or a click, does what the row's key or click does; a Candle command only puts a plain-English request
// on the input line for the user to finish and send to the agent. A row that can't run here says why on the
// detail line, and so does a card row still held. A row that runs in the prompt pane says its rule in words:
// in its row where the palette is wide enough, and always on the detail line.
import { usePointer } from "./chip"
import type { MouseEvent } from "@opentui/core"
import type { CatalogueEntry } from "../core/cli-catalogue"
import { wrap } from "./format"
import type { PaletteRow } from "./palette-rows"
import { C, fit, OVERLAY_Z } from "./theme"

export interface PaletteProps {
  rows: readonly PaletteRow[]
  /** Every row there is, for the count beside the search. */
  total: number
  query: string
  index: number
  width: number
  height: number
  onPick: (id: string) => void
  onScroll: (delta: number) => void
}

const LABEL_WIDTH = 25
const RULE_WIDTH = 24
/** The rule column in words: "you complete it in the pane · now". */
const WORDS_WIDTH = 33
/** The description keeps at least this much before the rule column takes words. */
const MIN_DESC_WIDTH = 30

type Line = { kind: "group"; group: string } | { kind: "row"; row: PaletteRow; at: number }

/** What a Candle command's right-hand column says: the rule (in words, when there's room and it has them) and when, or why never. */
export const whenLabel = (e: CatalogueEntry, words = false): string =>
  e.availability === "never" ? e.ruleLabel : `${words && e.how ? e.how : e.ruleLabel} · ${e.availability}`

function lines(found: readonly PaletteRow[]): Line[] {
  const out: Line[] = []
  found.forEach((row, at) => {
    if (at === 0 || found[at - 1]!.section !== row.section) out.push({ kind: "group", group: row.section })
    out.push({ kind: "row", row, at })
  })
  return out
}

/** The highlighted row in full, since a narrow terminal cuts its line short. */
export function detailOf(row: PaletteRow | undefined): string {
  if (!row) return "Nothing matches."
  const e = row.cli
  if (e) return [`candle ${e.path}`, e.description, e.how, ...(e.asks ?? []), e.shows, e.partly, e.why && `coming: ${e.why}`, e.note].filter(Boolean).join(" · ")
  return [row.label, row.words, row.key, row.why && `can't here: ${row.why}`].filter(Boolean).join(" · ")
}

export function Palette(props: PaletteProps) {
  const pointer = usePointer()
  const found = props.rows
  // Over everything but the status bar and the input line.
  const width = props.width
  const height = props.height - 2
  const inner = width - 4
  const index = Math.min(props.index, Math.max(0, found.length - 1))
  const detailLines = wrap(detailOf(found[index]), Math.max(10, inner)).slice(0, 3)
  // The rest go to the search, the detail, the keys and the border.
  const rows = Math.max(1, height - 4 - detailLines.length)
  const all = lines(found)
  const selectedLine = all.findIndex((l) => l.kind === "row" && l.at === index)
  const start = Math.max(0, Math.min(all.length - rows, selectedLine - Math.floor(rows / 2)))
  const shown = all.slice(start, start + rows)
  const words = inner - 2 - LABEL_WIDTH - 2 - WORDS_WIDTH - 2 >= MIN_DESC_WIDTH
  const ruleWidth = words ? WORDS_WIDTH : RULE_WIDTH
  const descWidth = Math.max(0, inner - 2 - LABEL_WIDTH - 2 - ruleWidth - 2)
  const count = `${found.length} of ${props.total}`

  return (
    <box
      position="absolute" zIndex={OVERLAY_Z}
      left={0}
      top={1}
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title=" palette "
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={(e: MouseEvent) => props.onScroll(e.scroll?.direction === "up" ? -1 : 1)}
    >
      <box flexDirection="row" height={1}>
        <text fg={C.hi}>{"search › "}</text>
        <text fg={C.hi}>{fit(`${props.query}▏`, inner - 10 - count.length - 1)}</text>
        <box flexGrow={1} />
        <text fg={C.dim}>{count}</text>
      </box>
      {shown.map((line) => {
        if (line.kind === "group") {
          return (
            <text key={`g-${line.group}`} fg={C.head}>
              {`── ${line.group} ${"─".repeat(Math.max(0, inner))}`.slice(0, inner)}
            </text>
          )
        }
        const r = line.row
        const on = line.at === index
        const e = r.cli
        const right = e ? whenLabel(e, words) : (r.key ?? "")
        const rightColour = e ? (e.availability === "now" ? C.good : C.dim) : C.dim
        return (
          <box key={r.id} flexDirection="row" height={1} backgroundColor={on ? C.sel : C.term} onMouseDown={() => props.onPick(r.id)} {...pointer}>
            <text fg={on ? C.hi : C.dim}>{on ? "▸ " : "  "}</text>
            <text fg={r.current ? C.hi : r.run ? C.ctl : C.dim}>{`${fit(r.label, LABEL_WIDTH).padEnd(LABEL_WIDTH)}  `}</text>
            <text fg={C.dim}>{fit(`${r.current ? "✓ " : ""}${r.words}`, descWidth).padEnd(descWidth)}</text>
            <box flexGrow={1} />
            <text fg={rightColour}>{fit(right, ruleWidth)}</text>
          </box>
        )
      })}
      <box flexGrow={1} />
      {detailLines.map((t, i) => (
        <text key={`d-${i}`} fg={C.ink}>
          {fit(t, inner)}
        </text>
      ))}
      <text fg={C.dim}>{fit("↑/↓ · type to search · ⏎ does it (a Candle command goes on the input line for the agent) · esc closes", inner)}</text>
    </box>
  )
}
