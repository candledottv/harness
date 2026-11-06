// The tour: about a minute on the real screen with live data, one part lit at a time and the rest dimmed,
// with a box beside it that says what it is. Six stops: the agent, positions, a card, the kill switch,
// settings ▾ and the palette.
//
// It's an overlay, so no layout changes (a click never adds a pane): the frame under it is the tab as it is.
// Nothing is traded or proposed: the card is drawn for the tour, never sent to the core. → or ⏎ goes on, ← goes back,
// Esc ends it. Onboarding opens it on its step 4; the palette's "the tour" runs it again.
import { cardLines } from "./panes/card"
import { Lines, type Line } from "./panes/lines"
import type { ViewCard } from "./store"
import type { Placed, Rect } from "./layout"
import { Chip } from "./chip"
import { wrap } from "./format"
import { C, fit } from "./theme"
import { TOUR_STOPS, type TourStopId } from "./tour-stops"

export { TOUR_STOPS, type TourStopId }

/** Where the tour can light each stop: the tab's panes as placed, and the chips' own cells. */
export interface TourFrame {
  width: number
  height: number
  placed: Placed
  /** The settings chip's first column on the tab bar's row. */
  settingsX: number
  /** The input line, where the palette's chip is. */
  input: Rect
}

const KILL_CELLS = " ctrl-x ×2 kill ".length
const SETTINGS_CELLS = " settings ▾ ".length

/** The rect a stop lights: its pane, or its chip's cells. A pane the tab doesn't show lights the side the others switch in. */
export function tourRect(id: TourStopId, f: TourFrame): Rect {
  const pane = (p: string) => f.placed.panes.find((x) => x.id === p)?.rect
  const body: Rect = { x: 0, y: 2, w: f.width, h: Math.max(1, f.height - 3) }
  switch (id) {
    case "agent":
    case "card":
      return pane("agent") ?? body
    case "positions":
      return pane("positions") ?? (f.placed.switched?.group.includes("positions") ? f.placed.switched.rect : undefined) ?? f.placed.panes.find((x) => x.id !== "agent")?.rect ?? body
    case "kill":
      return { x: Math.max(0, f.width - KILL_CELLS), y: 0, w: Math.min(KILL_CELLS, f.width), h: 1 }
    case "settings":
      return { x: Math.max(0, Math.min(f.width - SETTINGS_CELLS, f.settingsX)), y: 1, w: SETTINGS_CELLS, h: 1 }
    case "palette":
      return f.input
  }
}

/** The card the third stop draws: never proposed, never sent, its chips not clickable. */
export function tourCard(agent: string, now: number): ViewCard {
  return {
    cardId: "tour",
    opId: "tour",
    cardHash: "",
    kind: "trade",
    tool: "candle_trade",
    agent,
    state: "awaiting_approval",
    expiresAt: new Date(now + 60_000).toISOString(),
    side: "buy",
    display: { title: "BUY $5.00 of JUP", headline: "BUY $5.00 of JUP", agent, wallet: "embedded", mintLabel: "JUP", why: "drawn for the tour, not a real one" } as ViewCard["display"],
  }
}

/** Whether positions shares the switched pane here (a narrow window), so the stop says how to reach it. */
export const positionsShared = (f: TourFrame): boolean => !f.placed.panes.some((x) => x.id === "positions") && (f.placed.switched?.group.includes("positions") ?? false)

/** The box's lines, at its inner width: what the stop is, the card on the third, and that nothing is traded. */
export function tourLines(id: TourStopId, inner: number, agent: string, now: number, shared = false): Line[] {
  const stop = TOUR_STOPS.find((s) => s.id === id)!
  const out: Line[] = [{ segs: [{ text: "", fg: C.ink }] }]
  const words = id === "positions" && shared ? `${stop.words} At this width it shares the lit pane: ◂ ▸ on it switches to it.` : stop.words
  for (const t of wrap(words, inner)) out.push({ segs: [{ text: t, fg: C.ink }] })
  if (id === "card") {
    out.push({ segs: [{ text: "", fg: C.ink }] })
    // Its chips are drawn, not clickable: the tour's Lines has no onAct.
    out.push(...cardLines(tourCard(agent, now), { now, focused: true, width: inner }))
  }
  out.push({ segs: [{ text: "", fg: C.ink }] })
  for (const t of wrap("Nothing is traded or proposed in the tour.", inner)) out.push({ segs: [{ text: t, fg: C.dim }] })
  out.push({ segs: [{ text: "", fg: C.ink }] })
  return out
}

/**
 * Where the box goes: beside the lit part, over the dimmed ones. A pane takes it on its right,
 * else its left; a chip under it (or over it, on the input line). Where nothing fits beside, it sits over the lit
 * pane's lower part, so the screen never scrolls.
 */
export function tourBox(lit: Rect, w: number, h: number, width: number, height: number): Rect {
  const clampX = (x: number) => Math.max(0, Math.min(width - w, x))
  const clampY = (y: number) => Math.max(0, Math.min(height - h, y))
  if (lit.h <= 1) {
    const x = clampX(lit.x + lit.w - w)
    // A chip on the status bar: the box goes under the tab bar too, so it never covers settings ▾ or the tabs.
    const under = lit.y === 0 ? 2 : lit.y + 1
    return under + h <= height ? { x, y: under, w, h } : { x, y: clampY(lit.y - h), w, h }
  }
  const y = clampY(lit.y + Math.min(4, Math.max(0, lit.h - h)))
  if (lit.x + lit.w + 1 + w <= width) return { x: lit.x + lit.w + 1, y, w, h }
  if (lit.x - 1 - w >= 0) return { x: lit.x - 1 - w, y, w, h }
  return { x: clampX(lit.x + lit.w - w - 1), y: clampY(lit.y + lit.h - h - 1), w, h }
}

/** The page's colour, see-through: drawn over a cell, it keeps the cell's text and fades its colours. */
const dimmer = (): string => (/^#[0-9a-f]{6}$/i.test(C.page) ? `${C.page}c4` : C.page)

export function TourOverlay(props: { step: number; frame: TourFrame; agent: string; now: number; onNext: () => void; onEnd: () => void }) {
  const { frame } = props
  const { width, height } = frame
  const at = Math.max(0, Math.min(TOUR_STOPS.length - 1, props.step))
  const stop = TOUR_STOPS[at]!
  const lit = tourRect(stop.id, frame)
  const w = Math.min(46, width - 2)
  const inner = w - 4
  const lines = tourLines(stop.id, inner, props.agent, props.now, positionsShared(frame))
  const last = at === TOUR_STOPS.length - 1
  // Its lines, a row for the chips and one for the keys, and the border.
  const h = Math.min(height, lines.length + 5)
  const box = tourBox(lit, w, h, width, height)
  const shade = dimmer()
  // Four see-through boxes round the lit part: everything else fades, and the lit part keeps its own colours.
  // Over every chip a pane's border carries (the engine chip, a prompt chip), so none draws across the box.
  const shades: Rect[] = [
    { x: 0, y: 0, w: width, h: lit.y },
    { x: 0, y: lit.y + lit.h, w: width, h: height - lit.y - lit.h },
    { x: 0, y: lit.y, w: lit.x, h: lit.h },
    { x: lit.x + lit.w, y: lit.y, w: width - lit.x - lit.w, h: lit.h },
  ].filter((r) => r.w > 0 && r.h > 0)
  return (
    <>
      {shades.map((r, i) => (
        <box key={`shade${i}`} position="absolute" zIndex={30} left={r.x} top={r.y} width={r.w} height={r.h} backgroundColor={shade} />
      ))}
      <box position="absolute" zIndex={30} left={box.x} top={box.y} width={box.w} height={box.h} border borderStyle="rounded" borderColor={C.focus} title={` ${at + 1} of ${TOUR_STOPS.length} · ${stop.title} `} titleColor={C.head} backgroundColor={C.term} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Lines lines={lines.slice(0, Math.max(0, h - 4))} width={inner} />
        <box height={1} flexDirection="row">
          <Chip label={last ? "done" : "next →"} onClick={props.onNext} />
          {/* At the last stop "done" and "end the tour" did the same, and read as two choices. */}
          {last ? null : <text> </text>}
          {last ? null : <Chip label="end the tour" onClick={props.onEnd} />}
        </box>
        <text fg={last ? C.ink : C.dim}>{fit(last ? "⏎ ends the tour · ← back" : "→ next · ← back · esc ends it", inner)}</text>
      </box>
    </>
  )
}
