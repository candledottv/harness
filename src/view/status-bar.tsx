// The status bar: always visible. The active agent and the mode are
// clickable, and so is the kill switch, where one click kills; while paused, resume is.
// Every clickable segment is a chip: the agent and resume blue, the mode a solid block in its
// colour, kill the red one. Exposure and the P&L window's figure show "—" when the core has no figure,
// never 0, and say when the figure is stale. The P&L names its window.
import { Chip, type ChipKind } from "./chip"
import type { PnlFigure, StatusView } from "./store"
import { cellWidth } from "./format"
import { C, money, shortDuration, signedMoney } from "./theme"

/** Prices older than this are marked stale in the status bar. */
export const STALE_MS = 60_000

export interface StatusBarProps {
  width: number
  connected: boolean
  /** The core went away after this view attached: said in place of figures that no longer move. */
  lost?: boolean
  /** The core went away because the person chose "restart it": it comes back by itself, so nothing asks them to start it. */
  restarting?: boolean
  status: StatusView | undefined
  cardsWaiting: number
  killArmed: boolean
  /** Positions, wallets and activity show only the active agent. */
  oneAgent?: boolean
  /** The view's clock: the P&L figure says "since 09:14" today, a date before. */
  now?: number
  onAgent: () => void
  /** The chain filter's chip, beside the agent's: its words, only while the account uses more than one chain. */
  chain?: string
  /** A click on it, with the column it starts at, for its menu to open under it. */
  onChain?: (x: number) => void
  onMode: () => void
  onKill: () => void
  onResume: () => void
  /** The triggers chip: the Triggers overlay. */
  onTriggers?: () => void
  /** The bots chip: the Bots tab, or its overlay. */
  onBots?: () => void
  /** The attached core's version, when it isn't this view's: it kept running through an update. */
  staleCore?: string
  /** The restart chip beside it: stops that core and starts this version's. */
  onRestartCore?: () => void
}

interface SegmentSpec {
  key: string
  text: string
  fg: string
  bg?: string
  onClick?: () => void
  /** A clickable segment's chip, when it isn't a plain control (a solid block in its own colour, or kill). */
  chip?: ChipKind | { fg: string; bg: string }
  /** 0 is always shown; higher numbers go first when the bar is too narrow. */
  priority: number
  /** Takes the leftover width, pushing what follows to the right. */
  spacer?: boolean
  /** A figure with its label: the figure in `fg`, the words dim. */
  figure?: boolean
  /** A cell of air before it, where it would otherwise run into a chip of the same colours. */
  gap?: boolean
  /** A name that gives up its end ("…") when what always shows is still too wide. */
  shrink?: boolean
}

function Segment(props: { spec: SegmentSpec }) {
  const { spec } = props
  if (spec.spacer) return <box flexGrow={1} />
  if (spec.onClick) {
    const kind = typeof spec.chip === "string" ? spec.chip : "control"
    const chip = <Chip label={spec.text} kind={kind} onClick={spec.onClick} {...(typeof spec.chip === "object" ? { colours: spec.chip } : {})} />
    return spec.gap ? (
      <box flexDirection="row" flexShrink={0}>
        <text fg={C.dim}> </text>
        {chip}
      </box>
    ) : (
      chip
    )
  }
  return (
    <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="row" backgroundColor={spec.bg ?? C.bar}>
      {spec.figure ? (
        figureParts(spec.text, spec.fg).map((p, i) => (
          <text key={i} fg={p.fg}>
            {p.text}
          </text>
        ))
      ) : (
        <text fg={spec.fg}>{spec.text}</text>
      )}
    </box>
  )
}

/** "today $12.00 / $50.00": the first figure in its colour, the words around it dim. */
export function figureParts(text: string, fg: string): { text: string; fg: string }[] {
  const m = /\$[\d,.]+|[+-]\$[\d,.]+|—/.exec(text)
  if (!m) return [{ text, fg: C.dim }]
  return [
    { text: text.slice(0, m.index), fg: C.dim },
    { text: m[0], fg },
    { text: text.slice(m.index + m[0].length), fg: C.dim },
  ].filter((p) => p.text)
}

/** The segments that fit `width`, dropping the least important first; the kill switch always stays. */
export function fitSegments<T extends { text: string; priority: number; spacer?: boolean; gap?: boolean; shrink?: boolean }>(segments: T[], width: number): T[] {
  // Plain segments and chips both take one cell of padding either side, and one of air before where it's asked for.
  const cells = (s: T) => (s.spacer ? 0 : cellWidth(s.text) + 2 + (s.gap ? 1 : 0))
  const kept = [...segments]
  for (let p = Math.max(...segments.map((s) => s.priority)); p > 0 && kept.reduce((n, s) => n + cells(s), 0) > width; p--) {
    for (let i = kept.length - 1; i >= 0 && kept.reduce((n, s) => n + cells(s), 0) > width; i--) if (kept[i]!.priority === p) kept.splice(i, 1)
  }
  // Still too wide with only what always shows: a name gives up its end rather than the bar losing the kill switch.
  const over = kept.reduce((n, s) => n + cells(s), 0) - width
  const at = kept.findIndex((s) => s.shrink)
  if (over > 0 && at >= 0) kept[at] = { ...kept[at]!, text: shrunk(kept[at]!.text, cellWidth(kept[at]!.text) - over) }
  return kept
}

/** A name cut to `cells` with "…", keeping a closing " ▾" and at least four characters of the name. */
function shrunk(text: string, cells: number): string {
  const tail = text.endsWith(" ▾") ? " ▾" : ""
  const name = [...text.slice(0, text.length - tail.length)]
  const room = Math.max(4, cells - cellWidth(tail) - 1)
  return name.length <= room ? text : `${name.slice(0, room).join("")}…${tail}`
}

/** The figures, as text, so tests and narrow layouts can read them without drawing. */
export function statusFigures(status: StatusView | undefined, now = Date.now()): { spend: string; exposure: string; pnl: string } {
  const agent = status?.agents.find((a) => a.name === status.activeAgent)
  const spend = agent?.limits ? `today ${money(agent.spentTodayUsd ?? 0)} / ${money(agent.limits.perDayUsd)}` : "today —"
  const stale = status?.pricesAgeMs != null && status.pricesAgeMs > STALE_MS ? ` (${shortDuration(status.pricesAgeMs)} old)` : ""
  // In paper mode the figure is still the live wallets' (it was misread as paper's).
  const label = status?.mode === "paper" ? "live exposure" : "exposure"
  const exposure = status?.exposureUsd == null ? `${label} —` : `${label} ${money(status.exposureUsd)}${stale}`
  return { spend, exposure, pnl: pnlWords(status?.pnl, status?.mode, now) }
}

/** A time the figure runs from: "09:14" today, "Oct 29 20:00" before. */
function fromWords(from: number, now: number): string {
  const d = new Date(from)
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  return new Date(now).toDateString() === d.toDateString() ? clock : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${clock}`
}

/**
 * The P&L window's figure in words, as the status bar and the kill report say it: its window
 * ("P&L 24h +$1.20"), or from when where the Candle Harness's samples start later ("P&L since 09:14"). It's always
 * live, Candle's: in paper mode it says so, as exposure does.
 */
export function pnlWords(pnl: PnlFigure | null | undefined, mode?: "paper" | "live", now = Date.now()): string {
  const name = mode === "paper" ? "live P&L" : "P&L"
  if (!pnl) return `${name} —`
  const window = pnl.short && pnl.from !== null ? `since ${fromWords(pnl.from, now)}` : pnl.label
  // Candle priced a different number of positions at the window's two ends: the figure is ≈, and says why.
  const partial = pnl.usd !== null && pnl.unpriced !== undefined
  return `${name} ${window} ${pnl.usd === null ? "—" : `${partial ? "≈" : ""}${signedMoney(pnl.usd)}`}${partial ? ` (${pnl.unpriced} unpriced)` : ""}`
}

/** "3 triggers on", with "· Mac kept awake" while keep-awake holds it awake. */
export const triggersOnWords = (count: number, awake = false) => `${count} trigger${count === 1 ? "" : "s"} on${awake ? " · Mac kept awake" : ""}`

/** The status bar's chip: "⚡ 4 triggers", with "· Mac awake" while keep-awake holds it awake; narrow, without it (a bare "⚡ 4" beside "3 bots" read as cut off). */
export const triggersChipWords = (count: number, awake = false, narrow = false) => `⚡ ${count} trigger${count === 1 ? "" : "s"}${awake && !narrow ? " · Mac awake" : ""}`

/** The status bar's words for a core that kept running through an update. */
export const staleCoreWords = (version: string) => `the core is still ${version}`

/** The version to name when the attached core's isn't this view's own; undefined when they match or it isn't known. */
export const staleCoreVersion = (running: string | undefined, ours: string): string | undefined => (running !== undefined && running !== ours ? running : undefined)

/** The status bar's bots chip: "3 bots", the bots that keep the core running. */
export const botsChipWords = (count: number) => `${count} bot${count === 1 ? "" : "s"}`

/**
 * What quitting the view says, on the shell's screen, when triggers keep the core running: how many, and how to
 * stop them. Nothing when none is on.
 */
export function quitNote(status: Pick<StatusView, "triggersOn" | "botsOn"> | undefined): string | undefined {
  const t = status?.triggersOn ?? 0
  const b = status?.botsOn ?? 0
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  const what = [...(b > 0 ? [count(b, "bot")] : []), ...(t > 0 ? [count(t, "trigger")] : [])]
  if (!what.length) return undefined
  const one = t + b === 1
  return `${what.join(" and ")} ${one ? "keeps" : "keep"} running in the background · \`candle-harness stop\` to end ${one ? "it" : "them"}`
}

export function StatusBar(props: StatusBarProps) {
  const { status } = props
  const bar = (segments: SegmentSpec[]) => (
    <box position="absolute" left={0} top={0} width={props.width} height={1} backgroundColor={C.bar} flexDirection="row">
      {fitSegments(segments, props.width).map((spec) => (
        <Segment key={spec.key} spec={spec} />
      ))}
    </box>
  )
  if (props.lost && props.restarting) {
    return bar([
      { key: "brand", text: "▲ candle", fg: C.hi, priority: 1 },
      { key: "lost", text: "restarting the core…", fg: C.look, priority: 0 },
      { key: "how", text: "the view reattaches by itself", fg: C.dim, priority: 2 },
    ])
  }
  if (props.lost) {
    return bar([
      { key: "brand", text: "▲ candle", fg: C.hi, priority: 1 },
      { key: "lost", text: "the core stopped · reconnecting…", fg: C.look, priority: 0 },
      { key: "how", text: "quit and run candle-harness to start it again", fg: C.dim, priority: 2 },
    ])
  }
  if (!props.connected || !status) {
    return bar([
      { key: "brand", text: "▲ candle", fg: C.hi, priority: 1 },
      { key: "connecting", text: "connecting to the core…", fg: C.dim, priority: 0 },
    ])
  }
  const figures = statusFigures(status, props.now)
  const live = status.mode === "live"
  const waiting = props.cardsWaiting
  const segments: SegmentSpec[] = [
    { key: "brand", text: "▲ candle", fg: C.hi, priority: 5 },
    { key: "agent", text: `${status.activeAgent}${props.oneAgent ? " · only" : ""} ▾`, fg: C.ctl, onClick: props.onAgent, priority: 0, shrink: true },
    // The chain every pane shows: its menu opens under it. On a narrow bar it goes before a waiting card's count
    // (it's also in the palette); a card waits only a minute, and on a tab without the agent's pane this is where it shows.
    ...(props.chain !== undefined && props.onChain ? [{ key: "chain", text: `${props.chain} ▾`, fg: C.ctl, gap: true, onClick: () => props.onChain?.(segmentAt(segments, props.width, "chain") + 1), priority: 2 }] : []),
    { key: "mode", text: live ? "LIVE" : "PAPER", fg: live ? C.page : C.hi, chip: live ? { fg: C.page, bg: C.good } : { fg: C.hi, bg: C.paperBg }, onClick: props.onMode, priority: 0 },
    { key: "spend", text: figures.spend, fg: C.hi, figure: true, priority: 2 },
    // With the chain chip on the bar, exposure is the first to give way, before the brand.
    { key: "exposure", text: figures.exposure, fg: C.hi, figure: true, priority: props.chain !== undefined ? 6 : 4 },
    { key: "pnl", text: figures.pnl, fg: status.pnl?.usd == null ? C.dim : status.pnl.usd >= 0 ? C.good : C.bad, figure: true, priority: 3 },
    // A card waiting always shows; none waiting gives way as before.
    { key: "cards", text: `● ${waiting} card${waiting === 1 ? "" : "s"} waiting`, fg: waiting > 0 ? C.look : C.dim, priority: waiting > 0 ? 0 : 1 },
    // The triggers that keep the core running after the view quits.
    // The triggers on, which keep the core running after the view quits: a chip to the Triggers overlay. Narrow, its count alone.
    ...(status.triggersOn ? [{ key: "triggers", text: triggersChipWords(status.triggersOn, status.keepAwake?.active === true, props.width < 100), fg: C.ctl, ...(props.onTriggers ? { onClick: props.onTriggers } : {}), priority: 1 }] : []),
    // The bots that keep the core running: a chip to the Bots tab.
    ...(status.botsOn ? [{ key: "bots", text: botsChipWords(status.botsOn), fg: C.ctl, ...(props.onBots ? { onClick: props.onBots } : {}), priority: 1 }] : []),
    // A core from before an update, still running as the older version: said until it's restarted, the person's click.
    ...(props.staleCore ? [{ key: "stale", text: staleCoreWords(props.staleCore), fg: C.look, priority: 0 }] : []),
    ...(props.staleCore && props.onRestartCore ? [{ key: "restart", text: "restart it", fg: C.ctl, onClick: props.onRestartCore, priority: 0 }] : []),
    ...(status.debugLoseNextReply ? [{ key: "debug", text: "DEBUG · next answer dropped", fg: C.page, bg: C.look, priority: 0 }] : []),
    { key: "spacer", text: "", fg: C.bar, priority: 0, spacer: true },
    ...(status.paused
      ? [
          // White on this red is 3:1, so PAUSED is dark on it (theme.test.ts).
          { key: "paused", text: "PAUSED", fg: C.page, bg: C.bad, priority: 0 },
          { key: "resume", text: "resume", fg: C.ctl, onClick: props.onResume, priority: 0 },
        ]
      : [
          {
            key: "kill",
            text: props.killArmed ? "ctrl-x again to kill" : "ctrl-x ×2 kill",
            fg: C.bad,
            chip: props.killArmed ? { fg: C.page, bg: C.bad } : ("danger" as const),
            onClick: props.onKill,
            priority: 0,
          },
        ]),
  ]
  return bar(segments)
}

/** The column a segment starts at, among those that fit. */
function segmentAt(segments: SegmentSpec[], width: number, key: string): number {
  let x = 0
  for (const s of fitSegments(segments, width)) {
    if (s.key === key) return x
    x += s.spacer ? 0 : cellWidth(s.text) + 2 + (s.gap ? 1 : 0)
  }
  return 0
}
