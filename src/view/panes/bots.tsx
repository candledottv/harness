// The Bots overlay, drawn: the rules bots and code bots on the left, the picked one on the right in full with its chips, as the
// Triggers overlay. Below 100 columns the list takes the width, and → opens one bot with a `‹ bots` chip to come
// back. On Free, the plan's words and `candle plan buy`. Its lines are bots-view.ts's, so a test reads what's
// drawn; the keys are keys.ts's. The Bots tab draws the same lines in two panes.
import type { BotsTopic } from "../../core/bots"
import { type BotConfirm, botDetailLines, botListLines, botNameWidth, BOTS_LIST_W, BOTS_WIDE, botsCountWords, botsHint, type BotsState, emptyBotLines, everyBot, pickedBot } from "../bots-view"
import { C, fit, OVERLAY_Z } from "../theme"
import { type Act, chip, type Line, Lines, line } from "./lines"

export function BotsMenu(props: { state: BotsState; topic: BotsTopic | undefined; confirm?: BotConfirm; killed?: boolean; width: number; height: number; now: number; onPick: (index: number) => void; onAct: (ref: string, act: Act) => void }) {
  const o = props.state
  const wide = props.width >= BOTS_WIDE
  const w = Math.min(props.width - 4, 114)
  const listW = wide ? BOTS_LIST_W : w - 2
  const detailW = wide ? w - BOTS_LIST_W - 6 : w - 4
  const bots = everyBot(props.topic)
  const picked = bots.length ? pickedBot(props.topic, o.index) : undefined
  const showList = wide || o.side === "list"
  const showDetail = wide || o.side === "detail"
  const empty = bots.length === 0 ? emptyBotLines(props.topic, w - 4) : undefined
  const h = empty ? Math.min(props.height - 3, empty.length + 5) : Math.max(8, props.height - 3)
  const room = h - 3
  const left = Math.floor((props.width - w) / 2)
  const top = Math.max(2, Math.floor((props.height - h) / 2))
  const box = (children: React.ReactNode) => (
    <box position="absolute" zIndex={OVERLAY_Z} left={left} top={top} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title=" bots " flexDirection="column">
      {children}
    </box>
  )
  // On Free, before a read, or with none yet: the words alone.
  if (empty) {
    return box(
      <>
        <box flexDirection="column" height={h - 3} paddingLeft={1}>
          <Lines lines={[line(""), ...empty]} width={w - 4} onAct={props.onAct} />
        </box>
        <text fg={C.dim}>{" esc closes"}</text>
      </>,
    )
  }
  // The list: the count, then each bot two lines with a blank between, the picked one lit.
  const count = botsCountWords(props.topic, props.killed === true)
  const head: Line[] = [{ segs: [{ text: "bots", fg: C.head }, { text: " ".repeat(Math.max(1, listW - 2 - 4 - count.length)), fg: C.ink }, { text: count, fg: C.dim }] }, line("")]
  const per = 3
  const rowsRoom = Math.max(1, room - head.length)
  const start = Math.max(0, Math.min(bots.length - Math.floor(rowsRoom / per), o.index - Math.floor(rowsRoom / per / 3)))
  const shown = bots.slice(start, start + Math.max(1, Math.floor(rowsRoom / per)))
  const below = bots.length - start - shown.length
  const list: Line[] = [...head]
  shown.forEach((b, i) => {
    const lit = start + i === o.index
    for (const l of botListLines(b, props.topic?.books?.[b.name], listW - 2, botNameWidth(bots), props.killed === true)) list.push({ ...l, ...(lit ? { bg: C.sel } : {}) })
    list.push(line(""))
  })
  const back: Line[] = !wide && showDetail ? [{ segs: [{ ...chip("‹ bots", "fill"), ref: "list" }] }] : []
  const detail = [...back, ...botDetailLines(picked, picked ? props.topic?.books?.[picked.name] : undefined, { width: detailW, now: props.now, head: true, killed: props.killed === true, ...(props.confirm ? { confirm: props.confirm } : {}), ...(props.topic ? { topic: props.topic } : {}) })]
  const more = below > 0 && showList ? `↓ ${below} more ` : ""
  const confirming = props.confirm !== undefined && props.confirm.name === picked?.name
  return box(
    <>
      <box flexDirection="row" height={h - 3}>
        {showList ? (
          <box flexDirection="column" width={listW} paddingLeft={1}>
            <Lines lines={list} width={listW - 2} onPick={(pick) => props.onPick(bots.findIndex((b) => `bot:${b.name}` === pick.id))} />
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
        <text fg={C.dim}>{fit(` ${botsHint(o, wide, confirming)}`, w - 2 - more.length)}</text>
        <box flexGrow={1} />
        {more ? <text fg={C.dim}>{more}</text> : null}
      </box>
    </>,
  )
}
