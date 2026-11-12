// A popped view: `candle-harness view --pane <id>`, one pane alone in a
// tmux or cmux split (or any terminal), attached to the same core as the main view. The core holds the
// pane as popped while this view's connection lasts, so the tiled views leave it out and take it back when
// this one closes or dies.
//
// It draws the pane as a tab would (TabBody, with a layout of that one pane) and a footer: the pane's name,
// the cards waiting in the main window, and the kill switch. It approves nothing: cards are approved where
// the input line is, by Enter's rules. So only the keys that read the pane reach the step:
// ↑/↓ and the wheel to pick and scroll, PgUp/PgDn, ctrl-f, the kill switch (ctrl-x twice, as everywhere)
// and ctrl-c twice to close it. It draws in the main view's theme, and follows when that's switched.
import { feedBuckets } from "./panes/feed"
import { researchParts } from "./panes/research"
import { signalsChoiceOf, signalsFilter, signalsParams } from "./panes/signals"
import { PnlMenu, SignalsMenu, WalletsMenu } from "./overlays"
import { type PnlSpan, pnlWindowWords } from "./panes/pnl"
import { PNL_PANES, usePnlSeries } from "./pnl-series"
import { journalContext, useJournal } from "./journal-feed"
import type { JournalKind } from "../core/journal-query"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { POPPED_AT, type PaneId, type TokenPane } from "../shared/panes"
import { pinPane } from "../core/view-state"
import type { Session } from "./app"
import { Chip } from "./chip"
import { copiedMessage, makeCopier } from "./clipboard"
import { type Effect, INITIAL_UI, type Key, type PickRow, type ScrollReach, step, type UiAction, type UiContext, type UiState } from "./keys"
import { pressed } from "./keymap"
import { type Layout, paneNav, place, type Rect, roomy } from "./layout"
import type { Act } from "./panes/lines"
import { activityTape, PANES } from "./panes/registry"
import { setPanePadding } from "./panes/pane"
import { applyEvent, type CoreView, EMPTY_VIEW, lostCore, openCards } from "./store"
import { C, fit, type TerminalColours } from "./theme"
import type { ThemeStore } from "./themes"
import { useTheme } from "./use-theme"
import { TabBody } from "./trade-tab"
import { chainInForce, signalsFold } from "./chain-filter"
import { useRepaintAfterResize } from "./repaint"
import { guardMouse } from "./mouse-guard"

const CLOSE_HINT = "ctrl-c twice closes  "

/** The one-pane layout a popped view draws. */
export const poppedLayout = (pane: PaneId): Layout => ({ name: pane, root: { dir: "row", weight: 1, children: [{ pane, weight: 1 }] }, collapse: { below: 0, keep: pane, weights: [1, 0] } })

/** The keys a popped view acts on: reading the pane, the kill switch and closing. Enter, typing and the rest do nothing here. */
export function poppedKey(key: Key): boolean {
  return pressed(key, "kill") || pressed(key, "quit") || pressed(key, "scroll") || pressed(key, "oneAgent") || key.name === "up" || key.name === "down"
}

/** The footer's words: the pane, what's waiting in the main window, and the state of the core. */
export function footerWords(p: { pane: PaneId; view: CoreView }): { left: string; waiting?: string; waitingShort?: string } {
  const n = openCards(p.view).length
  const paused = p.view.status?.paused ? " · buys paused" : ""
  const left = `⇱ ${p.pane} · popped out${p.view.connected ? "" : " · reconnecting to the core…"}${paused}`
  const cards = n === 1 ? "1 card" : `${n} cards`
  return { left, ...(n > 0 ? { waiting: `${cards} waiting, in the main window`, waitingShort: `${cards} waiting` } : {}) }
}

export interface PoppedProps {
  session: Session
  pane: PaneId
  onQuit: () => void
  now?: () => number
  tickMs?: number
  /** The theme kept, and config.toml's text for its [theme]: the main view's, followed when it's switched. */
  themes?: ThemeStore
  configText?: () => string | undefined
  terminal?: TerminalColours
  readTerminal?: () => Promise<TerminalColours | undefined>
}

export function PoppedApp({ session, pane, onQuit, now = Date.now, tickMs = 250, themes, configText, terminal, readTerminal }: PoppedProps) {
  useTheme({ store: themes, config: configText, terminal, readTerminal })
  const { width, height } = useTerminalDimensions()
  setPanePadding(roomy(width, height) ? 1 : 0)
  const renderer = useRenderer()
  useRepaintAfterResize(renderer, width, height)
  useEffect(() => guardMouse(renderer), [renderer])
  const copier = useMemo(() => makeCopier(renderer), [renderer])
  useEffect(() => () => void copier.dispose(), [copier])
  const [view, setView] = useState<CoreView>(EMPTY_VIEW)
  const start: UiState = { ...INITIAL_UI, focus: pane, recent: [pane] }
  const [ui, setUi] = useState<UiState>(start)
  const [clock, setClock] = useState(now())
  const viewRef = useRef(view)
  const uiRef = useRef(ui)
  const reachRef = useRef<Partial<Record<PaneId, ScrollReach>>>({})
  const picksRef = useRef<Partial<Record<PaneId, readonly PickRow[]>>>({})
  const layout = useMemo(() => poppedLayout(pane), [pane])
  const bodyRef = useRef<Rect>({ x: 0, y: 0, w: width, h: Math.max(1, height - 1) })

  useEffect(() => {
    session.onLost?.(() => {
      viewRef.current = lostCore(viewRef.current)
      setView(viewRef.current)
    })
    session.onEvent((event) => {
      viewRef.current = applyEvent(viewRef.current, event, now())
      setView(viewRef.current)
    })
  }, [session, now])

  // Hacc's tape while this is the Signals pane, as a tab showing it asks; a list of Candle's
  // while this is one of them.
  // Its Signals choice is kept as `popped out`'s, as its pin is.
  const signalsPick = signalsChoiceOf(view.views?.signals, POPPED_AT, signalsFold(view))
  // A popped Activity before its first line shows the tape.
  const signalsTopic = pane === "signals" ? (signalsPick.mine ? "signals:mine" : "signals") : activityTape(view, [pane]) ? "signals" : undefined
  const signalsWant = signalsTopic === "signals" ? signalsFilter(signalsPick) : undefined
  const signalsKey = signalsWant ? JSON.stringify(signalsWant) : undefined
  const bucket = feedBuckets([pane])[0]
  // P&L while this is a P&L pane, and the chart's points while it's the chart.
  const pnlOn = (PNL_PANES as readonly PaneId[]).includes(pane)
  // Research's reads while this is one of its panes.
  const part = researchParts([pane])[0]
  useEffect(() => {
    session.want?.([...(signalsTopic ? [signalsTopic] : []), ...(bucket ? ["feeds"] : []), ...(pnlOn ? ["pnl"] : []), ...(part ? ["research"] : [])], { ...(bucket ? { feeds: { buckets: [bucket] } } : {}), ...(signalsKey ? { signals: JSON.parse(signalsKey) } : {}), ...(part ? { research: { parts: [part] } } : {}) })
  }, [session, signalsTopic, bucket, signalsKey, pnlOn, part])
  usePnlSeries(session, pane === "pnl-chart", ui.pnlSpan ?? "window", view.pnl, now, (pnlSeries) => {
    viewRef.current = { ...viewRef.current, pnlSeries }
    setView(viewRef.current)
  })
  // The Journal's rows while this is the Journal, as the main view reads them.
  const journal = useJournal({
    session,
    on: pane === "journal",
    search: ui.journal,
    chain: chainInForce(view),
    newest: view.activity.at(-1)?.seq,
    held: () => viewRef.current.journal,
    got: (held) => {
      viewRef.current = { ...viewRef.current, journal: held }
      setView(viewRef.current)
    },
  })
  const journalRef = useRef(journal)
  journalRef.current = journal

  const context = (): UiContext => {
    const v = viewRef.current
    return {
      // No cards: a popped view approves nothing, so Enter's card is never here.
      cards: [],
      seenAt: {},
      mode: v.status?.mode,
      agents: v.status?.agents.map((a) => a.name) ?? [],
      activeAgent: v.status?.activeAgent,
      commands: { agents: [], knownTokens: new Map() },
      panes: paneNav(place(layout, bodyRef.current)),
      scrolls: reachRef.current,
      picks: picksRef.current,
      popped: v.views?.popped ?? [],
      signals: signalsChoiceOf(v.views?.signals, POPPED_AT, signalsFold(v)),
      ...(v.pnl ? { pnlWindow: v.pnl.window } : {}),
      journal: journalContext(v, { width, height }),
      ...(v.wallets?.groups ? { walletGroups: v.wallets.groups } : {}),
      ...(v.status?.walletsShown !== undefined ? { walletsShown: v.status.walletsShown } : {}),
      ...(v.status?.perpsWrites ? { perpsWrites: true } : {}),
    }
  }

  const say = (text: string, level: "info" | "error" = "info") => dispatch({ type: "message", text, level, now: now() })

  const dispatch = useCallback((action: UiAction) => {
    const result = step(uiRef.current, action, context())
    // The pane keeps the keys: ↑ past its first row would have gone to a tab bar this view hasn't got.
    const state = result.state.focus === pane ? result.state : { ...result.state, focus: pane }
    uiRef.current = state
    setUi(state)
    for (const effect of result.effects) void run(effect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const call = async <T,>(method: string, params: Record<string, unknown>, done?: (result: T) => string | undefined) => {
    try {
      const text = done?.(await session.request<T>(method, params))
      if (text) say(text)
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const run = async (effect: Effect) => {
    switch (effect.type) {
      case "kill":
        return call("kill", {}, () => "Kill switch on: buys paused, the agent's turn stopped. Sells still work.")
      case "quit":
        return onQuit()
      case "link":
        return call("view.link", { mint: effect.mint, ...(effect.chain ? { chain: effect.chain } : {}) })
      case "wake": {
        const timer = setTimeout(() => dispatch({ type: "tick", now: now() }), effect.afterMs)
        timer.unref?.()
        return
      }
      case "copy": {
        const m = copiedMessage(await copier.copy(effect.text), "the address", true)
        return say(m.text, m.level)
      }
      case "pnlWindow":
        return call("pnl.window", { window: effect.window }, () => `The P&L window is now ${pnlWindowWords(effect.window)}.`)
      case "signals":
        return call("view.signals", signalsParams(POPPED_AT, signalsChoiceOf(viewRef.current.views?.signals, POPPED_AT), effect.change))
      case "journalOlder":
        return journalRef.current.older()
      case "walletsShow":
        return call("wallets.show", { show: effect.show })
      default:
        return undefined
    }
  }

  const togglePin = (pane: TokenPane) => {
    const pinned = viewRef.current.views?.pins.some((p) => p.at === POPPED_AT && pinPane(p) === pane)
    if (pinned) return void call("view.unpin", { at: POPPED_AT, pane }, () => "The token pane follows the link again.")
    return void call("view.pin", { at: POPPED_AT, pane }, () => `The token pane stays on ${viewRef.current.market?.followed?.symbol ?? "this token"} while the link moves on.`)
  }

  const act = (cardId: string, a: Act) => {
    if (a === "copy") return dispatch({ type: "clickCopy", text: cardId, now: now() })
    // An Activity line's undo of a Hacc change, and which wallets show: the person's clicks, as in the main window.
    if (a === "undo") return void call<{ text: string }>("hacc.undo", { changeId: cardId }, (r) => r.text)
    if (a === "walletsAll" || a === "walletsActive") return void call("wallets.show", { show: a === "walletsAll" ? "all" : "active" })
    if (a === "signals") return dispatch({ type: "clearSignals", now: now() })
    if (a === "pnlSpan") return dispatch({ type: "pnlSpan", span: cardId as PnlSpan, now: now() })
    if (a === "journalSearch") return dispatch({ type: "journalSearch", now: now() })
    if (a === "journalKind") return dispatch({ type: "journalKind", kind: cardId as JournalKind, now: now() })
    if (a === "journalOlder") return dispatch({ type: "journalOlder", now: now() })
    if (a === "walletsFind") return dispatch({ type: "walletsFind", now: now() })
    return say("That's done in the main window, beside the input line and the cards.")
  }

  useKeyboard((key: KeyEvent) => {
    const k: Key = { name: key.name, ctrl: key.ctrl, meta: key.meta, shift: key.shift, sequence: key.sequence }
    // Signals' menu takes ⏎ and Esc too, while it's open.
    const menu = (uiRef.current.overlay?.kind === "signalsMenu" || uiRef.current.overlay?.kind === "pnlMenu" || uiRef.current.overlay?.kind === "walletsMenu") && (k.name === "return" || k.name === "enter" || k.name === "escape")
    // The Journal's and the Wallets pane's searches take every key while they're typed into.
    const searching = uiRef.current.journal?.editing === true || uiRef.current.wallets?.find?.editing === true
    if (poppedKey(k) || menu || searching) dispatch({ type: "key", key: k, now: now() })
  })

  useEffect(() => {
    if (!tickMs) return
    const timer = setInterval(() => {
      setClock(now())
      dispatch({ type: "tick", now: now() })
    }, tickMs)
    return () => clearInterval(timer)
  }, [tickMs, now, dispatch])

  const minCols = PANES[pane].minWidth + 2
  if (width < minCols || height < 5) {
    return (
      <box width={width} height={height} backgroundColor={C.page}>
        <text fg={C.look}>{fit(`Too small for ${pane}: ${minCols}×5 at least.`, width)}</text>
      </box>
    )
  }

  const bodyHeight = Math.max(1, height - 1)
  bodyRef.current = { x: 0, y: 0, w: width, h: bodyHeight }
  const words = footerWords({ pane, view })
  const said = ui.message
  // The footer's parts, while they fit beside the kill chip: the pane's name always, then what's waiting, what was just said, and how to close it.
  let room = width - 7
  const take = (text: string | undefined): string | undefined => {
    if (!text || text.length > room) return undefined
    room -= text.length
    return text
  }
  const left = fit(` ${words.left}`, Math.max(1, room))
  room -= left.length
  const waiting = take(words.waiting ? `  ${words.waiting}` : undefined) ?? take(words.waitingShort ? `  ${words.waitingShort}` : undefined)
  const message = said ? take(fit(`  ${said.text}`, Math.max(0, room - CLOSE_HINT.length))) : undefined
  const close = take(CLOSE_HINT)
  return (
    <box width={width} height={height} backgroundColor={C.page}>
      <TabBody
        layout={layout}
        top={0}
        width={width}
        height={bodyHeight}
        view={view}
        ui={ui}
        cards={[]}
        focusedCardId={undefined}
        now={clock}
        onFocusPane={() => {}}
        onScroll={(p, delta) => dispatch({ type: "scroll", pane: p, delta, now: now() })}
        reach={reachRef.current}
        picks={picksRef.current}
        tabName={POPPED_AT}
        onPick={(p, pick) => dispatch({ type: "clickRow", pane: p, pick, now: now() })}
        onTogglePin={togglePin}
        onToggleOneAgent={() => dispatch({ type: "toggleOneAgent", now: now() })}
        onSignalsChip={(which, x, y) => dispatch({ type: "clickSignalsChip", which, x, y, now: now() })}
        onPauseSignals={(on) => dispatch({ type: "pauseSignals", on, now: now() })}
        onPnlWindowChip={(x, y) => dispatch({ type: "clickPnlWindow", x, y, now: now() })}
        onWalletsFind={() => dispatch({ type: "walletsFind", now: now() })}
        onWalletsGroups={(x, y) => dispatch({ type: "clickWalletsGroups", x, y, now: now() })}
        onAct={act}
      />
      {ui.overlay?.kind === "pnlMenu" ? <PnlMenu overlay={ui.overlay} window={view.pnl?.window} width={width} height={height} onPick={(index) => dispatch({ type: "pickPnlMenu", index, now: now() })} /> : null}
      {ui.overlay?.kind === "walletsMenu" ? <WalletsMenu overlay={ui.overlay} groups={view.wallets?.groups ?? []} shown={view.status?.walletsShown} width={width} height={height} onPick={(index) => dispatch({ type: "pickWalletsMenu", index, now: now() })} /> : null}
      {ui.overlay?.kind === "signalsMenu" ? <SignalsMenu overlay={ui.overlay} pick={signalsPick} width={width} height={height} onPick={(index) => dispatch({ type: "pickSignalsMenu", index, now: now() })} /> : null}
      <box position="absolute" left={0} top={height - 1} width={width} height={1} backgroundColor={C.bar} flexDirection="row">
        <text fg={C.head}>{left}</text>
        {waiting ? <text fg={C.look}>{waiting}</text> : null}
        {message ? <text fg={said?.level === "error" ? C.bad : C.dim}>{message}</text> : null}
        <box flexGrow={1} />
        {close ? <text fg={C.dim}>{close}</text> : null}
        <Chip label="kill" kind="danger" onClick={() => dispatch({ type: "clickKill", now: now() })} />
      </box>
    </box>
  )
}
