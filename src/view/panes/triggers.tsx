// The Triggers overlay, drawn: the triggers on the left, the picked one on the right, as the approvals menu. Below
// 100 columns the list takes the width, and → opens one trigger with a `‹ triggers` chip to come back. Keep-awake's
// switch sits under the list on a Mac. On Free, the plan's words and `candle plan buy`. Its lines are
// triggers-view.ts's, so a test reads what's drawn; the keys are keys.ts's.
import type { TriggersTopic } from "../../core/triggers"
import { usePointer } from "../chip"
import { C, fit, OVERLAY_Z } from "../theme"
import { countWords, gateLines, listRow, pickedTrigger, TRIGGERS_LIST_W, TRIGGERS_WIDE, triggerDetail, triggersFound, triggersHint, type TriggersState } from "../triggers-view"
import { chip, type Act, type Line, Lines, line } from "./lines"

export interface KeepAwakeView {
  on: boolean
  available: boolean
  active: boolean
  failed?: string
}

export function TriggersMenu(props: {
  state: TriggersState
  topic: TriggersTopic | undefined
  keepAwake?: KeepAwakeView
  width: number
  height: number
  now: number
  onPick: (index: number) => void
  onAct: (ref: string, act: Act) => void
}) {
  const pointer = usePointer()
  const o = props.state
  const wide = props.width >= TRIGGERS_WIDE
  const w = Math.min(props.width - 4, 114)
  const listW = wide ? TRIGGERS_LIST_W : w - 2
  const detailW = wide ? w - TRIGGERS_LIST_W - 6 : w - 4
  const found = triggersFound(props.topic, o.find)
  const picked = pickedTrigger(props.topic, o)
  const showList = wide || o.side === "list"
  const showDetail = wide || o.side === "detail"
  // On Free, the box takes the plan's words alone; else the height it has, so it doesn't jump as triggers come and go.
  const gate = props.topic?.gate ? gateLines(props.topic, w - 4) : undefined
  const h = gate ? Math.min(props.height - 3, gate.length + 4) : Math.max(8, props.height - 3)
  const room = h - 3
  const left = Math.floor((props.width - w) / 2)
  const top = Math.max(2, Math.floor((props.height - h) / 2))
  const box = (children: React.ReactNode) => (
    <box position="absolute" zIndex={OVERLAY_Z} left={left} top={top} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title=" triggers " flexDirection="column">
      {children}
    </box>
  )
  // On Free: the plan's words and the chip, nothing else.
  if (gate) {
    return box(
      <>
        <box flexDirection="column" height={h - 3} paddingLeft={1}>
          <Lines lines={gate} width={w - 4} onAct={props.onAct} />
        </box>
        <text fg={C.dim}>{" esc closes"}</text>
      </>,
    )
  }
  // The list: the count, the find line, each trigger one line with a blank between; keep-awake at its foot.
  const head: Line[] = [{ segs: [{ text: "triggers", fg: C.head }, { text: " ".repeat(Math.max(1, listW - 2 - 8 - countWords(props.topic).length)), fg: C.ink }, { text: countWords(props.topic), fg: C.dim }] }, o.find !== undefined && o.find !== "" ? { segs: [{ text: `⌕ ${fit(o.find, listW - 5)}`, fg: C.hi }, { text: "▏", fg: C.focus }] } : line("⌕ type to find a trigger", C.dim), line("")]
  const foot: Line[] = props.keepAwake?.available
    ? [line(""), { segs: [{ text: "keep the Mac awake  ", fg: C.ink }, { ...chip(props.keepAwake.on ? "on" : "off", "fill"), ref: "keepAwake" }] }, ...(props.keepAwake.failed ? [line(fit(props.keepAwake.failed, listW - 2), C.look)] : [])]
    : []
  const rowsRoom = Math.max(1, room - head.length - foot.length)
  const per = 2
  const start = Math.max(0, Math.min(found.length - Math.floor(rowsRoom / per), o.index - Math.floor(rowsRoom / per / 3)))
  const shown = found.slice(start, start + Math.max(1, Math.floor(rowsRoom / per)))
  const below = found.length - start - shown.length
  const back: Line[] = !wide && showDetail ? [{ segs: [{ ...chip("‹ triggers", "fill"), ref: "list" }] }] : []
  const detail = [...back, ...triggerDetail(picked, { width: detailW, now: props.now, ...(o.confirm ? { confirm: true } : {}), topic: props.topic })]
  const more = below > 0 && showList ? `↓ ${below} more ` : ""
  return box(
    <>
      <box flexDirection="row" height={h - 3}>
        {showList ? (
          <box flexDirection="column" width={listW} paddingLeft={1}>
            <Lines lines={head} width={listW - 2} onAct={props.onAct} />
            {shown.map((t, i) => {
              const at = start + i
              const { left: segs, right } = listRow(t, listW - 2)
              const used = segs.reduce((n, seg) => n + seg.text.length, 0)
              const lit = at === o.index
              return (
                <box key={t.name} flexDirection="column" height={per}>
                  <box flexDirection="row" height={1} backgroundColor={lit ? C.sel : C.term} onMouseDown={() => props.onPick(at)} {...pointer}>
                    {segs.map((seg, j) => (
                      <text key={j} fg={seg.fg}>
                        {seg.text}
                      </text>
                    ))}
                    <text fg={C.ink}>{" ".repeat(Math.max(1, listW - 2 - used - right.text.length))}</text>
                    <text fg={right.fg}>{right.text}</text>
                  </box>
                  <text fg={C.ink}> </text>
                </box>
              )
            })}
            <box flexGrow={1} />
            <Lines lines={foot} width={listW - 2} onAct={props.onAct} />
          </box>
        ) : null}
        {wide ? (
          <box flexDirection="column" width={2}>
            {Array.from({ length: h - 3 }, (_, i) => (
              <text key={i} fg={C.edge}>
                │
              </text>
            ))}
          </box>
        ) : null}
        {showDetail ? (
          <box flexDirection="column" paddingLeft={1} width={detailW + 1}>
            <Lines lines={detail.slice(0, room)} width={detailW} onAct={props.onAct} />
          </box>
        ) : null}
      </box>
      <box flexDirection="row" height={1}>
        <text fg={C.dim}>{fit(` ${triggersHint(o, wide, picked)}`, w - 2 - more.length)}</text>
        <box flexGrow={1} />
        {more ? <text fg={C.dim}>{more}</text> : null}
      </box>
    </>,
  )
}
