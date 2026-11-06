// A tab's body: its layout's panes, placed by the tree (layout.ts) and drawn from the
// registry (panes/registry.ts). The agent pane carries the cards inline at its foot. The Trade tab is
// Agent-first: the agent at 60% of the width beside token, positions, wallets
// and activity, which follow what the agent is discussing; below 100 columns that column is one pane,
// switched with ←/→ or a click on its name. The Cockpit tab adds Feed and Signals.
import { Chip } from "./chip"
import { Fragment } from "react"
import { type PickRow, type ScrollReach, scrollOf, type UiState } from "./keys"
import { type Gap, type Layout, type Need, type PaneId, panesOf, place, type PlaceOpts, type Rect, shownOf } from "./layout"
import { EngineChip, engineChipText } from "./engine-chip"
import { type AgentOffer, AgentPane, agentTitle, type SetUpSummary, tabTip } from "./panes/agent"
import type { AwaySummary } from "../core/away"
import { type Act, chip, type Line, Lines, line, type RowPick } from "./panes/lines"
import { innerCols, innerRows, Pane, type PaneEdges } from "./panes/pane"
import { cardLines } from "./panes/card"
import { highlightedCard } from "./panes/agent"
import type { ViewOperation } from "./store"
import { borderChips, type Order, PANES, paneLines } from "./panes/registry"
import { type SignalsChipId, signalsChoiceOf } from "./panes/signals"
import { walletsMenuChip } from "./panes/wallets"
import type { CoreView, ViewCard } from "./store"
import { C } from "./theme"

/** How long a closed card stays inline, and how many do. */
const CLOSED_SHOWN_MS = 5 * 60_000
const CLOSED_SHOWN = 3

/**
 * The cards drawn inline: every open card, then the active agent's recent closed ones, until the agent's
 * next exchange starts (a refused sell's block stayed under every answer after it).
 */
export function inlineCards(view: CoreView, agent: string, now: number): ViewCard[] {
  const open = view.cards.filter((c) => c.state === "awaiting_approval")
  const latest = view.conversations[agent]?.at(-1)?.seenAt ?? 0
  const closed = view.cards
    .filter((c) => {
      const seen = view.seenAt[c.cardId] ?? 0
      return c.state !== "awaiting_approval" && c.agent === agent && now - seen < CLOSED_SHOWN_MS && seen >= latest
    })
    .slice(-CLOSED_SHOWN)
  return [...closed, ...open]
}

/** The newest inline card that has expired, for `r` (re-quote). */
export const requotable = (cards: readonly ViewCard[]): string | undefined => cards.filter((c) => c.state === "expired").at(-1)?.cardId

/** What of a pane's lines shows, and how many sit above and below it. */
export interface Window {
  shown: Line[]
  above: number
  below: number
  /** A tail or head pane's lines past its anchor: arrived since it was scrolled. */
  since: number
  /** The rows past what shows, the most it can scroll. */
  max: number
}

/**
 * A pane's lines cut to its rows. A tail pane (Activity) shows its newest, scrolled up
 * `scroll` rows from its anchor's line, so lines arriving after it don't move the view; a head pane
 * (Signals, newest first) the same the other way up; a list shows its first, scrolled down `scroll` rows.
 * Either says on its border what's out of view (at 120×30 the Wallets pane dropped a TEE wallet with
 * no sign).
 */
export function windowOf(lines: readonly Line[], rows: number, order: Order = "list", scroll = 0, anchor?: string): Window {
  const max = Math.max(0, lines.length - Math.max(0, rows))
  if (rows <= 0) return { shown: [], above: 0, below: lines.length, since: 0, max }
  if (order === "tail") {
    const at = anchor === undefined ? -1 : lines.findLastIndex((l) => l.key === anchor)
    const since = at < 0 ? 0 : lines.length - 1 - at
    const end = Math.max(Math.min(rows, lines.length), lines.length - Math.min(max, scroll + since))
    const start = Math.max(0, end - rows)
    return { shown: lines.slice(start, end), above: start, below: lines.length - end, since, max }
  }
  const at = order === "head" && anchor !== undefined ? lines.findIndex((l) => l.key === anchor) : -1
  // Lines above a head pane's anchor are the ones that arrived since; a pane not scrolled has no anchor.
  const since = at < 0 ? 0 : at - lines.slice(0, at).filter((l) => l.key === undefined).length
  const start = Math.min(max, Math.max(0, scroll + since))
  const shown = lines.slice(start, start + rows)
  return { shown, above: start, below: lines.length - start - shown.length, since, max }
}

/** A pane's token rows, each once, at its first line (an Activity entry can wrap over several). */
export function picksOf(lines: readonly Line[]): PickRow[] {
  const out: PickRow[] = []
  const seen = new Set<string>()
  lines.forEach((l, i) => {
    if (!l.pick || seen.has(l.pick.id)) return
    seen.add(l.pick.id)
    out.push({ ...l.pick, line: i })
  })
  return out
}

/** The bottom border's words for what's out of view: a tail's newer lines below, or a head's above, once scrolled; a list's lines above and below. */
export function scrollMark(w: Pick<Window, "above" | "below">, order: Order): string | undefined {
  if (order === "tail") return w.below > 0 ? `↓ ${w.below} newer` : undefined
  if (order === "head") return w.above > 0 ? `↑ ${w.above} newer` : undefined
  const parts = [...(w.above > 0 ? [`↑ ${w.above} above`] : []), ...(w.below > 0 ? [`↓ ${w.below} more`] : [])]
  return parts.length ? parts.join(" · ") : undefined
}

/** The scroll mark on a pane's bottom border, right-aligned, plain text. */
function ScrollMark(props: { rect: Rect; text: string }) {
  const text = ` ${props.text} `
  if (text.length > props.rect.w - 4) return null
  return (
    <box position="absolute" left={props.rect.x + props.rect.w - text.length - 2} top={props.rect.y + props.rect.h - 1} height={1} backgroundColor={C.term}>
      <text fg={C.dim}>{text}</text>
    </box>
  )
}

/** A collapsed layout's switcher: ◂ positions ▸ 2/4, each arrow clickable. */
function Switcher(props: { group: readonly PaneId[]; index: number; onPick: (pane: PaneId) => void }) {
  const n = props.group.length
  const arrow = (label: string, to: number) => <Chip label={label} onClick={() => props.onPick(props.group[(to + n) % n]!)} />
  return (
    <box flexDirection="row" height={1}>
      {arrow("◂", props.index - 1)}
      <text fg={C.ink}>{` ${props.group[props.index]!} `}</text>
      {arrow("▸", props.index + 1)}
      <text fg={C.dim}>{`  ${props.index + 1}/${n} · ←/→`}</text>
    </box>
  )
}

export interface TabBodyProps {
  layout: Layout
  top: number
  width: number
  height: number
  view: CoreView
  ui: UiState
  cards: readonly ViewCard[]
  focusedCardId: string | undefined
  now: number
  onFocusPane: (pane: PaneId) => void
  /** The wheel on a pane: `delta` rows towards its top when positive. */
  onScroll: (pane: PaneId, delta: number) => void
  /** Filled in as drawn: how far each pane can scroll, for the keys (as the panes' places are). */
  reach?: Partial<Record<PaneId, ScrollReach>>
  /** Filled in as drawn: each pane's token rows, for ↑/↓. */
  picks?: Partial<Record<PaneId, readonly PickRow[]>>
  /** A token row clicked: picked at once. */
  onPick?: (pane: PaneId, pick: RowPick) => void
  /** The highlighted row's `ask` chip: as ctrl-t on it. */
  onAskRow?: (pane: PaneId, id: string) => void
  /** The tab's name: where its token pane's pin is kept. */
  tabName?: string
  /** The token pane's pin chip: pins it on its token, or lets it follow the link again. */
  onTogglePin?: () => void
  onAct: (cardId: string, act: Act) => void
  onToggleOneAgent: () => void
  /** The Signals pane's chips: `source` switches Hacc's tape and your rules; `pattern` and `chain` open their menu under the chip, at column `x` of row `y`. */
  onSignalsChip?: (which: SignalsChipId, x: number, y: number) => void
  /** Signals' pause chip, and resume. */
  onPauseSignals?: (on: boolean) => void
  /** The P&L pane's window chip: opens the window's menu under it, at column `x` of row `y`. */
  onPnlWindowChip?: (x: number, y: number) => void
  /** The list pane's ◂ ▸ chips. */
  onListsChip?: (delta: number) => void
  /** The Wallets pane's `⌕ find` and `all groups ▾` chips; the menu opens under the chip, at column `x` of row `y`. */
  onWalletsFind?: () => void
  onWalletsGroups?: (x: number, y: number) => void
  /** The agent pane's engine chip: opens the model picker. */
  onEngineChip?: () => void
  /** Each pane's border, dragged, resizes it; never on a collapsed layout. */
  edges?: (pane: PaneId) => PaneEdges
  /** The ⇱ chip on each pane that can pop out: moves it into a split of its own. */
  onPopOut?: (pane: PaneId) => void
  /** The air between panes, and the rows kept for the message and input lines. */
  gap?: Gap
  foot?: number
  /** The agent's change to the screen waiting on a click, drawn under its reply. */
  offer?: AgentOffer
  /** While you were away: the note at the top of the agent pane, while it shows. */
  away?: AwaySummary
  /** Setup just finished in this view: what it made, first in the agent's welcome. */
  setUp?: SetUpSummary
}

/** The `ask` chip's text, and the line it goes on, cut to make room for it at the end. */
const ASK_CHIP = chip("ask", "ask")
export function withAsk(l: Line, width: number): Line {
  let room = Math.max(0, width - ASK_CHIP.text.length - 1)
  const segs = l.segs.flatMap((seg) => {
    if (room <= 0) return []
    const text = seg.text.length > room ? seg.text.slice(0, room) : seg.text
    room -= text.length
    return [{ ...seg, text }]
  })
  const used = segs.reduce((n, seg) => n + seg.text.length, 0)
  return { ...l, segs: [...segs, { text: " ".repeat(Math.max(1, width - ASK_CHIP.text.length - used)), fg: C.ink }, { ...ASK_CHIP, ref: l.pick!.id }] }
}

/** The label on a pane's top border that says, and switches, whose positions, wallets or activity it shows, or which signals. */
function ScopeLabel(props: { rect: Rect; text: string; onClick: () => void }) {
  return (
    <box position="absolute" left={props.rect.x + props.rect.w - props.text.length - 5} top={props.rect.y} height={1} backgroundColor={C.term}>
      <Chip label={props.text} onClick={props.onClick} />
    </box>
  )
}

/** Several chips on a pane's top border, right-aligned as ScopeLabel's one, a border's dash between each: Signals' pattern, chain and source. */
function ChipsLabel(props: { rect: Rect; chips: readonly { text: string; onClick: (x: number) => void }[] }) {
  const cells = props.chips.reduce((n, c) => n + c.text.length + 2, 0) + Math.max(0, props.chips.length - 1) * 2
  const left = props.rect.x + props.rect.w - 3 - cells
  let x = left
  const at = props.chips.map((c) => {
    const from = x
    x += c.text.length + 4
    return from
  })
  return (
    <box position="absolute" left={left} top={props.rect.y} height={1} flexDirection="row" backgroundColor={C.term}>
      {props.chips.map((c, i) => (
        <Fragment key={c.text}>
          {i > 0 ? <text fg={C.edge}>──</text> : null}
          <Chip label={c.text} onClick={() => c.onClick(at[i]!)} />
        </Fragment>
      ))}
    </box>
  )
}

/**
 * Signals' pause on its bottom border's right: `pause`, with the scroll mark before it
 * when scrolled; paused, how many arrived since and `resume`. Left off where the border hasn't the room.
 */
function PauseFoot(props: { rect: Rect; paused: boolean; arrived: number; mark: string | undefined; onPause: (on: boolean) => void }) {
  const words = props.paused ? ` paused · ${props.arrived} new ` : props.mark ? ` ${props.mark} ` : ""
  const label = props.paused ? "resume" : "pause"
  if (words.length + label.length + 2 > props.rect.w - 4) return null
  return (
    <box position="absolute" left={props.rect.x + props.rect.w - words.length - label.length - 4} top={props.rect.y + props.rect.h - 1} height={1} flexDirection="row" backgroundColor={C.term}>
      {words ? <text fg={props.paused ? C.look : C.dim}>{words}</text> : null}
      <Chip label={label} onClick={() => props.onPause(!props.paused)} />
    </box>
  )
}

/** The words PauseFoot puts on the border, for the ⇱ chip's room. */
const pauseFootText = (paused: boolean, arrived: number, mark: string | undefined) => `${paused ? ` paused · ${arrived} new ` : mark ? ` ${mark} ` : ""} ${paused ? "resume" : "pause"} `

/** The ⇱ chip's cells at a pane's bottom left, from its corner: the dash, the chip and the gap after it. */
const POP_CELLS = 6

/**
 * The ⇱ chip, on the bottom border's left, which nothing else uses, so it
 * costs a title no room: pops the pane out, as ctrl-p does on it. Left off where the scroll mark needs the room.
 */
function PopChip(props: { rect: Rect; mark: string | undefined; onClick: () => void }) {
  const markCells = props.mark === undefined ? 0 : props.mark.length + 4
  if (POP_CELLS + markCells > props.rect.w - 2) return null
  return (
    <box position="absolute" left={props.rect.x + 2} top={props.rect.y + props.rect.h - 1} height={1} backgroundColor={C.term}>
      <Chip label="⇱" onClick={props.onClick} />
    </box>
  )
}

/**
 * The Wallets pane's chips on its bottom border, after ⇱: `⌕ find` puts a
 * search line over its rows, and `all groups ▾` shows one group. Each is left off where the border hasn't the room.
 */
export function walletsFootChips(w: number, pop: boolean, mark: string | undefined, find: boolean, groups: string | undefined): string[] {
  // From after ⇱ (or the corner's dash) to a dash before the scroll mark, or before the corner.
  const room = w - 2 - (pop ? POP_CELLS - 1 : 1) - (mark === undefined ? 1 : mark.length + 3)
  const chips = [...(find ? ["⌕ find"] : []), ...(groups !== undefined ? [groups] : [])]
  while (chips.length && chips.reduce((n, c) => n + c.length + 3, 0) > room) chips.pop()
  return chips
}

function WalletsFoot(props: { rect: Rect; pop: boolean; mark: string | undefined; find: boolean; groups: string | undefined; onFind: () => void; onGroups: (x: number) => void }) {
  const chips = walletsFootChips(props.rect.w, props.pop, props.mark, props.find, props.groups)
  if (chips.length === 0) return null
  const left = props.rect.x + (props.pop ? POP_CELLS - 1 : 1)
  let x = left
  const at = chips.map((c) => {
    const from = x + 1
    x += c.length + 3
    return from
  })
  return (
    <box position="absolute" left={left} top={props.rect.y + props.rect.h - 1} height={1} flexDirection="row" backgroundColor={C.term}>
      {chips.map((c, i) => (
        <Fragment key={c}>
          <text fg={C.edge}>─</text>
          <Chip label={c} onClick={() => (c === "⌕ find" ? props.onFind() : props.onGroups(at[i]!))} />
        </Fragment>
      ))}
    </box>
  )
}

export function TabBody(p: TabBodyProps) {
  const agent = p.view.status?.activeAgent ?? ""
  const only = p.ui.oneAgent && agent ? agent : undefined
  const inFull = p.ui.shownInFull && p.ui.shownInFull.until > p.now ? p.ui.shownInFull.text : undefined
  const area: Rect = { x: 0, y: p.top, w: p.width, h: p.height }
  const tabAt = p.tabName
  // What this tab's Signals pane shows: the core keeps it by the tab, for every view.
  const signals = signalsChoiceOf(p.view.views?.signals, tabAt)
  const popChip = p.onPopOut !== undefined
  const onTab = panesOf(p.layout.root)
  const linesOf = (id: Exclude<PaneId, "agent">, rect: Rect, rows?: number) =>
    paneLines(id, { view: p.view, rect, now: p.now, only, signals, panes: onTab, ...(p.ui.wallets ? { wallets: p.ui.wallets } : {}), ...(p.ui.lists ? { lists: p.ui.lists } : {}), ...(p.ui.pnlSpan ? { pnlSpan: p.ui.pnlSpan } : {}), ...(p.ui.journal ? { journal: p.ui.journal } : {}), ...(tabAt !== undefined ? { at: tabAt } : {}), ...(inFull ? { shownInFull: inFull } : {}), ...(rows !== undefined ? { rows } : {}) })
  // Each pane's lines at its column's width first, so a pane they don't fit takes rows another has spare.
  const opts: PlaceOpts = { ...(p.gap ? { gap: p.gap } : {}), ...(p.foot ? { foot: p.foot } : {}) }
  const even = place(p.layout, area, {}, opts)
  const need: Need = {}
  if (!even.switched) {
    for (const { id, rect } of even.panes) {
      if (id === "agent" || PANES[id].fills(p.view, tabAt)) continue
      const drawn = linesOf(id, rect)
      need[id] = drawn.lines.length + (drawn.head?.length ?? 0)
    }
  }
  let placed = even.switched ? even : place(p.layout, area, need, opts)
  // A pane with a compact form whose lines still don't fit asks only for its compact lines, so the rows it
  // borrowed for its full form go back (Wallets, with more than two wallets).
  const compact: Need = { ...need }
  for (const { id, rect } of placed.panes) {
    if (id !== "agent" && PANES[id].compact && need[id] !== undefined && need[id]! > innerRows(rect)) compact[id] = linesOf(id, rect, 0).lines.length
  }
  if (Object.keys(compact).some((id) => compact[id as PaneId] !== need[id as PaneId])) placed = place(p.layout, area, compact, opts)
  const edgesOf = (id: PaneId) => (placed.switched ? undefined : p.edges?.(id))
  const exchanges = p.view.conversations[agent] ?? []
  const working = exchanges.some((e) => e.streaming)
  const chip = engineChipText(p.view.engine, agent)

  const drawAgent = (rect: Rect) => (
    <Fragment key="agent">
      <AgentPane
        rect={rect}
        agent={agent}
        exchanges={exchanges}
        killReport={p.view.killReport}
        operations={p.view.operations}
        cards={p.cards}
        focusedCardId={p.focusedCardId}
        cardsFocused={p.ui.focus === "cards"}
        now={p.now}
        scroll={scrollOf(p.ui, "agent")}
        onReach={(max) => {
          if (p.reach) p.reach.agent = { max }
        }}
        {...(inFull ? { shownInFull: inFull } : {})}
        focused={p.ui.focus === "agent"}
        working={working}
        onFocus={() => p.onFocusPane("agent")}
        onScroll={(delta) => p.onScroll("agent", delta)}
        onAct={p.onAct}
        {...(edgesOf("agent") ? { edges: edgesOf("agent")! } : {})}
        {...(p.offer ? { offer: p.offer } : {})}
        {...(p.away ? { away: p.away } : {})}
        {...(p.setUp ? { setUp: p.setUp } : {})}
        {...(p.view.status?.setup ? { setup: p.view.onboarding ? { view: p.view.onboarding } : {} } : {})}
        tip={tabTip(onTab)}
      />
      {chip && p.onEngineChip ? <EngineChip rect={rect} title={agentTitle(agent, working, scrollOf(p.ui, "agent"))} text={chip} onClick={p.onEngineChip} /> : null}
    </Fragment>
  )

  const drawLines = (id: Exclude<PaneId, "agent">, rect: Rect, key: string, group?: readonly PaneId[]) => {
    const { title, lines, head = [] } = linesOf(id, rect, innerRows(rect) - (group ? 1 : 0))
    // The lines held above the scrolled ones (the Journal's search): the window is what's left under them.
    const rows = innerRows(rect) - (group ? 1 : 0) - head.length
    const def = PANES[id]
    const at = p.ui.scroll[id]
    const win = windowOf(lines, rows, def.order, at?.rows ?? 0, at?.anchor)
    const newest = def.order === "tail" ? lines.findLast((l) => l.key !== undefined) : def.order === "head" ? lines.find((l) => l.key !== undefined) : undefined
    if (p.reach) p.reach[id] = { max: win.max, ...(newest ? { newest: newest.key!, since: win.since } : {}), start: win.above, rows: Math.max(0, rows), total: lines.length }
    if (p.picks) p.picks[id] = picksOf(lines)
    const paused = id === "signals" && at?.paused === true
    const mark = paused ? undefined : scrollMark(win, def.order)
    const chips = borderChips(id, { only, signals, view: p.view, width: rect.w, ...(tabAt !== undefined ? { at: tabAt } : {}) })
    const pauseFoot = id === "signals" && p.onPauseSignals !== undefined
    // The highlighted row, while the pane has focus: the token ↑/↓ moved to.
    const lit = p.ui.focus === id ? p.ui.highlight?.[id]?.id : undefined
    // Its first line carries the `ask` chip, where the row has a question for the agent.
    const asked = lit === undefined ? -1 : win.shown.findIndex((l) => l.pick?.id === lit && l.pick.ask !== undefined)
    const shown = lit === undefined ? win.shown : win.shown.map((l, i) => (l.pick?.id === lit ? { ...(i === asked && p.onAskRow ? withAsk(l, innerCols(rect) - 1) : l), bg: C.sel } : l))
    const onAct = (ref: string, a: Act) => (a === "ask" ? p.onAskRow?.(id, ref) : p.onAct(ref, a))
    const onChip = id === "token" ? (p.onTogglePin ?? (() => {})) : p.onToggleOneAgent
    return (
      <Fragment key={key}>
        <Pane rect={rect} title={title} focused={p.ui.focus === id} onFocus={() => p.onFocusPane(id)} {...(def.scrolls ? { onScroll: (delta: number) => p.onScroll(id, delta) } : {})} {...(!group && edgesOf(id) ? { edges: edgesOf(id)! } : {})}>
          {group ? <Switcher group={group} index={group.indexOf(id)} onPick={p.onFocusPane} /> : null}
          <Lines lines={[...head, ...shown]} width={innerCols(rect) - 1} onAct={onAct} {...(p.onPick ? { onPick: (pick: RowPick) => p.onPick!(id, pick) } : {})} />
        </Pane>
        {id === "signals" && chips.length ? (
          <ChipsLabel rect={rect} chips={chips.map((c) => ({ text: c.text, onClick: (x: number) => p.onSignalsChip?.(c.signals!, x, rect.y) }))} />
        ) : id === "lists" ? (
          <ChipsLabel rect={rect} chips={chips.map((c, i) => ({ text: c.text, onClick: () => p.onListsChip?.(i === 0 ? -1 : 1) }))} />
        ) : id === "pnl" && chips.length ? (
          <ChipsLabel rect={rect} chips={[{ text: chips[0]!.text, onClick: (x: number) => p.onPnlWindowChip?.(x, rect.y) }]} />
        ) : chips.length ? (
          <ScopeLabel rect={rect} text={chips[0]!.text} onClick={onChip} />
        ) : null}
        {popChip && def.pops ? <PopChip rect={rect} mark={pauseFoot ? pauseFootText(paused, win.since, mark).trim() : mark} onClick={() => p.onPopOut!(id)} /> : null}
        {id === "wallets" && p.onWalletsFind ? (
          <WalletsFoot rect={rect} pop={popChip} mark={mark} find={!p.ui.wallets?.find && (win.max > 0 || (p.view.wallets?.groups?.length ?? 0) > 0)} groups={(p.view.wallets?.groups?.length ?? 0) > 0 ? walletsMenuChip(p.view.status?.walletsShown) : undefined} onFind={p.onWalletsFind} onGroups={(x) => p.onWalletsGroups?.(x, rect.y + rect.h - 1)} />
        ) : null}
        {pauseFoot ? <PauseFoot rect={rect} paused={paused} arrived={win.since} mark={mark} onPause={p.onPauseSignals!} /> : mark ? <ScrollMark rect={rect} text={mark} /> : null}
      </Fragment>
    )
  }

  const switched = placed.switched
  const shown = switched ? shownOf(switched.group, p.ui.recent, switched.first) : undefined
  return (
    <>
      {placed.panes.map(({ id, rect }) => (id === "agent" ? drawAgent(rect) : drawLines(id, rect, id)))}
      {switched && shown && shown !== "agent" ? drawLines(shown, switched.rect, "switched", switched.group.length > 1 ? switched.group : undefined) : null}
    </>
  )
}

/**
 * A layout without the agent pane: the cards wait in a strip above the input line, so
 * Enter's approve still has its card on screen. It says when the agent is answering, with a chip to the
 * tab that shows it, so a reply isn't missed.
 */
export function stripLines(p: {
  cards: readonly ViewCard[]
  operations: Readonly<Record<string, ViewOperation>>
  focusedCardId: string | undefined
  cardsFocused: boolean
  now: number
  width: number
  /** The agent, while it's answering. */
  answering?: string
  /** The first tab whose layout has the agent pane. */
  agentTab?: { index: number; name: string }
}): Line[] {
  const out: Line[] = []
  if (p.answering) {
    out.push({
      segs: [{ text: `${p.answering} is answering`, fg: C.ink }, ...(p.agentTab ? [{ text: "  ", fg: C.ink }, chip(`see it on ${p.agentTab.name}`, "tab")] : [])],
      ...(p.agentTab ? { ref: String(p.agentTab.index) } : {}),
    })
  }
  const open = p.cards.filter((c) => c.state === "awaiting_approval")
  if (open.length) out.push(line(`${open.length === 1 ? "1 card" : `${open.length} cards`} waiting · ⏎ approves the highlighted one`, p.cardsFocused ? C.look : C.dim))
  const shaded = highlightedCard(open, p.focusedCardId, p.cardsFocused)
  for (const c of p.cards) out.push(...cardLines(c, { now: p.now, focused: c.cardId === shaded, width: p.width, op: p.operations[c.opId] }))
  return out
}

/** The strip's rows, border included: what its lines need, up to half the body, none when it has nothing to say. */
export const stripRows = (lines: readonly Line[], bodyRows: number): number => (lines.length ? Math.min(lines.length + 2, Math.max(4, Math.floor(bodyRows / 2))) : 0)

export function CardStrip(props: { rect: Rect; lines: readonly Line[]; focused: boolean; onFocus: () => void; onAct: (cardId: string, act: Act) => void }) {
  const rows = innerRows(props.rect)
  // The newest at the foot, as in the agent pane: a strip too short for every card shows the latest.
  return (
    <Pane rect={props.rect} title="cards" focused={props.focused} onFocus={props.onFocus}>
      <Lines lines={props.lines.slice(-rows)} width={innerCols(props.rect) - 1} onAct={props.onAct} />
    </Pane>
  )
}
