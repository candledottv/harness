// What opens over the frame: help, a card's details (ctrl-o, or a click), the one question before
// going live, the agent picker, the palette (ctrl-k, or `?` then `c` at Candle's commands), the model
// picker (ctrl-g), an agent's memory (its chip, or the palette's row) and while you were away (the note's
// show all, or the palette's row). Help is the typed commands and keymap.ts's table, and scrolls where it
// doesn't fit; any other key closes help and details. A trade's or swap's details list the other wallets its
// agent can pay from, each a chip: a click proposes the same trade again from that wallet (no new keys).
import type { LiveGap } from "./live-gaps"
import { payableWallets, type WalletsTopic } from "../core/agent-wallets"
import type { KillReport } from "../core/kill"
import type { EngineId } from "../engine/engine"
import { Chip, chipText, usePointer } from "./chip"
import { helpLines, type Overlay, SETTINGS } from "./keys"
import { signalsMenuRows, type SignalsPick } from "./panes/signals"
import { walletsMenuRows } from "./panes/wallets"
import { EveryWalletOverlay } from "./panes/every-wallet"
import type { PortfolioView } from "../core/portfolio-view"
import type { WalletNameEntry } from "../core/wallet-names"
import type { WalletGroup } from "../core/wallet-groups"
import type { WalletsShown } from "../core/wallets-shown"
import { pnlWindowRows } from "./panes/pnl"
import { type BotLogHeld, botLogLines } from "./bots-view"
import { type JournalRowsHeld, journalRowsLines, journalRowsText } from "./panes/journal"
import type { PnlWindow } from "../core/pnl"
import { HELP_COLUMN } from "./keymap"
import { Palette } from "./palette"
import type { PaletteRow } from "./palette-rows"
import { EnginePicker, type PickerRow } from "./panes/engines"
import { type MemoryRow, MemoryOverlay, type MemoryTopic } from "./panes/memory"
import { LayoutMenu } from "./panes/layout-menu"
import type { LayoutInfo } from "./layout-menu"
import type { PaneId } from "./layout"
import type { Preset } from "../engine/preset"
import type { ViewCard } from "./store"
import type { AutonomyTopic } from "../core/autonomy"
import type { AgentLimits, ApprovalsRow } from "./approvals"
import { ApprovalsMenu } from "./panes/approvals"
import { type KeepAwakeView, TriggersMenu } from "./panes/triggers"
import { BotsMenu } from "./panes/bots"
import type { BotsTopic } from "../core/bots"
import type { BotConfirm } from "./bots-view"
import type { TriggersTopic } from "../core/triggers"
import type { AwayView } from "../core/away"
import { AwayOverlay } from "./panes/away"
import type { Act, RowPick } from "./panes/lines"
import { exact, wrap } from "./format"
import { C, fit, OVERLAY_Z } from "./theme"

/** A card's argv as read: without the RPC flag the core adds, whose value is a marker for the configured address. */
const shownArgv = (argv: readonly unknown[]): unknown[] => {
  const at = argv.indexOf("--rpc-url")
  return at < 0 ? [...argv] : argv.filter((_, i) => i !== at && i !== at + 1)
}

/**
 * A card's details (`ctrl-o`): everything the compact card leaves out, one field per line,
 * with the exact amounts.
 */
export function cardDetails(card: ViewCard): string[] {
  const d = card.display
  const field = (label: string, value: string | undefined) => (value ? [`${label.padEnd(9)} ${value}`] : [])
  const exactSize = card.params?.percent !== undefined ? `${String(card.params.percent)}% of the wallet's holding, when it runs` : card.params?.amount !== undefined ? exact(Number(card.params.amount)) + (d.spend ? ` ${d.spend.asset}` : "") : undefined
  return [
    ...field("title", d.title),
    // A trigger's card: the exact line it saves, in words, and how it runs.
    ...field("line", d.triggerCard?.line),
    ...field("trigger", d.triggerCard?.words),
    ...field("runs", d.triggerCard?.runs),
    // A rules bot's card: the bot, its definition exactly, how it trades, its worst case and backtest.
    ...field("changes", d.botCard?.changes),
    ...field("bot", d.botCard?.flatten ?? d.botCard?.words),
    ...field("trades", d.botCard && !d.botCard.flatten ? [d.botCard.runs.entries, d.botCard.runs.exits].filter(Boolean).join(" ") : undefined),
    ...field("worst", d.botCard?.worst || undefined),
    ...field("from", d.botCard?.from),
    ...field("backtest", d.botCard?.backtest),
    ...field("differs", d.botCard?.differs),
    ...field("folder", d.botCard?.code?.folder),
    ...field("command", d.botCard?.code?.command),
    ...field("limits", d.botCard?.code?.figures),
    ...field(d.botCard?.code ? "binds" : "defines", d.botCard && !d.botCard.flatten ? d.botCard.definition : undefined),
    // The token's address in full: the card's face has it short.
    ...field("mint", card.kind === "trade" ? d.mint : undefined),
    ...field("another", d.otherMint),
    ...field("size", exactSize),
    ...field("spends", d.spends),
    ...field("sized", d.sizedFromUsd && `from ${d.sizedFromUsd}`),
    ...field("gets", d.receives),
    ...field("value", d.estimate),
    ...field("price", d.price),
    ...field("slippage", d.slippage?.replace(/^slippage /, "")),
    ...field("priced", d.pricedAt && `${new Date(d.pricedAt).toLocaleTimeString()} by ${d.pricedBy ?? "Candle"}. Candle fills at its own price, within slippage.`),
    ...field("risks", d.risks),
    ...field("warning", d.warning),
    ...field("preview", d.preview),
    ...field("publishes", d.publishes),
    ...field("terms", d.launchTerms),
    ...field("public", d.publicNote),
    ...field("re-send", d.resendNote),
    ...field("limits", [d.limits, d.candleKeyLimit].filter(Boolean).join(" · ") || undefined),
    // A card that pays from no wallet of its own (a bot's, a trigger's) names the one it runs on, never "none".
    ...field("wallet", d.wallet && d.wallet !== "none" ? `${d.walletLabel ? `${d.walletLabel} ` : ""}${d.wallet}` : d.paysFrom?.replace(/^pays from /, "")),
    ...field("shared", d.sharedWith?.length ? `with ${d.sharedWith.join(", ")}${card.side === "sell" ? ": a sell takes from the whole holding, whoever bought it" : ""}` : undefined),
    ...field("agent", `${card.agent} · ${d.mode}`),
    ...field("mode", d.modeDiffers),
    ...field("why", d.why),
    ...field("a card", d.cardBecause),
    // What a short pane's card may leave out: a new address, and what the prompt pane asks.
    ...field("to", d.newAddress),
    ...field("pane", [...(d.paneSteps ?? []), d.paneNote].filter(Boolean).join(" · ") || undefined),
    // The CLI route runs the user's own candle with exactly this argv.
    ...field(d.triggerCard || d.botCard ? "saves" : "runs", Array.isArray(card.params?.argv) ? `candle ${shownArgv(card.params.argv as unknown[]).join(" ")}` : `${card.tool} ${JSON.stringify(card.params ?? {})}`),
    ...field("hash", `${card.cardHash.slice(0, 16)}… · expires ${new Date(card.expiresAt).toLocaleTimeString()}`),
  ]
}

/** The other wallets a waiting trade or swap could pay from: none for any other card, or before the core says. */
export function otherWallets(card: ViewCard, wallets: WalletsTopic | undefined): { word: string; name: string }[] {
  if (card.state !== "awaiting_approval" || (card.tool !== "candle_trade" && card.tool !== "candle_swap")) return []
  // A bot's buy pays from the wallet the bot was approved on.
  if (card.display.bot) return []
  // A Hood trade pays from the embedded EVM wallet; TEE wallets here are Solana's.
  if (card.display.wallet.startsWith("0x")) return []
  const agent = wallets?.agents[card.agent]
  if (!agent) return []
  return payableWallets(agent.payable)
    .filter((w) => w.address !== card.display.wallet)
    .map((w) => ({ word: w.word, name: w.name }))
}

/** Chips laid out in rows of `width`, after a label on the first. */
function chipRows<T extends { name: string }>(label: string, chips: readonly T[], width: number): T[][] {
  const rows: T[][] = [[]]
  let used = label.length
  for (const c of chips) {
    const cells = chipText(c.name).length + 1
    if (rows.at(-1)!.length && used + cells > width) {
      rows.push([])
      used = label.length
    }
    rows.at(-1)!.push(c)
    used += cells
  }
  return rows
}

type FrameChips = { label: string; chips: { name: string; onClick: () => void }[] }

/** A frame's width, and its lines wrapped to it: a long line's continuation indented under the value when the frame has labels (`hanging`). */
function frameRows(lines: readonly string[], width: number, hanging = 0, chipCells = 0): { w: number; rows: string[] } {
  const w = Math.min(width - 4, Math.max(40, chipCells, ...lines.map((l) => l.length + 4)))
  // A labelled line keeps its label column: wrap() would close up the padding after the label.
  const indent = " ".repeat(hanging)
  const rows = lines.flatMap((l) => {
    const labelled = hanging > 1 && l.length > hanging && l[hanging - 1] === " " && l[hanging] !== " "
    if (labelled) {
      const [first = "", ...rest] = wrap(l.slice(hanging), w - 4 - hanging)
      return [l.slice(0, hanging) + first, ...rest.map((t) => indent + t)]
    }
    const [first, ...rest] = wrap(l, w - 4)
    return [first!, ...rest.flatMap((r) => wrap(r, w - 4 - indent.length).map((t) => indent + t))]
  })
  return { w, rows }
}

/** How far help scrolls at this size: its rows as drawn, wrapped, past what fits. */
export function helpMaxScroll(width: number, height: number): number {
  return frameMaxScroll(helpLines(), width, height, HELP_COLUMN)
}

/** How far a frame's lines scroll at this size, wrapped as drawn, with `chipRows` rows of chips under them. */
export function frameMaxScroll(lines: readonly string[], width: number, height: number, hanging = 0, chipRows = 0): number {
  const { rows } = frameRows(lines, width, hanging)
  const fits = Math.max(0, Math.min(height - 4, rows.length + chipRows + 3) - 3 - chipRows)
  return Math.max(0, rows.length - fits)
}

function Frame(props: {
  width: number
  height: number
  title: string
  lines: string[]
  footer?: string
  accent?: string
  hanging?: number
  chips?: FrameChips
  onClick: () => void
  /** Rows scrolled past at the top, for a frame taller than the screen (help); its footer then says what's out of view. */
  scroll?: number
  onScroll?: (delta: number) => void
}) {
  const chipCells = props.chips ? props.chips.label.length + props.chips.chips.reduce((n, c) => n + chipText(c.name).length + 1, 0) + 4 : 0
  const fitted = frameRows(props.lines, props.width, props.hanging ?? 0, chipCells)
  // A frame as wide as it can be goes to one cell from each edge: two left a pane's first letter showing beside it.
  const wide = fitted.w >= props.width - 4
  const { w, rows } = wide ? frameRows(props.lines, props.width + 2, props.hanging ?? 0, chipCells) : fitted
  const chipLines = props.chips && props.chips.chips.length ? chipRows(props.chips.label, props.chips.chips, w - 4) : []
  const h = Math.min(props.height - 4, rows.length + chipLines.length + 3)
  const fits = Math.max(0, h - 3 - chipLines.length)
  const from = Math.max(0, Math.min(rows.length - fits, props.scroll ?? 0))
  const above = from
  const below = Math.max(0, rows.length - from - fits)
  const marks = [above ? `↑ ${above} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean).join(" · ")
  return (
    <box
      position="absolute" zIndex={OVERLAY_Z}
      left={Math.floor((props.width - w) / 2)}
      top={Math.floor((props.height - h) / 2)}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={props.accent ?? C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` ${props.title} `}
      flexDirection="column"
      onMouseDown={props.onClick}
      {...(props.onScroll ? { onMouseScroll: (e: { scroll?: { direction?: string } }) => props.onScroll!(e.scroll?.direction === "up" ? -1 : 1) } : {})}
    >
      {rows.slice(from, from + fits).map((line, i) => (
        <text key={i} fg={C.ink}>
          {fit(line, w - 4)}
        </text>
      ))}
      {chipLines.map((row, i) => (
        <box key={`chips-${i}`} flexDirection="row" height={1}>
          <text fg={C.dim}>{i === 0 ? props.chips!.label : " ".repeat(props.chips!.label.length)}</text>
          {row.map((c, j) => (
            <box key={j} flexDirection="row" flexShrink={0}>
              <Chip label={c.name} onClick={c.onClick} />
              <text fg={C.ink}> </text>
            </box>
          ))}
        </box>
      ))}
      <text fg={C.dim}>{fit(`${marks ? `${marks} · ↑/↓ scroll · ` : ""}${props.footer ?? "any key closes"}`, w - 4)}</text>
    </box>
  )
}

export interface OverlayProps {
  /** What going live would find missing, for its question. */
  liveGaps?: readonly LiveGap[]
  overlay: Overlay | undefined
  width: number
  height: number
  cards: readonly ViewCard[]
  agents: readonly string[]
  activeAgent: string | undefined
  onClose: () => void
  onPickAgent: (agent: string) => void
  /** The settings menu: a row clicked, and the column its chip starts at. */
  onPickSettings?: (index: number) => void
  settingsAt?: number
  /** Every tab and whether it's shown: the settings menu's ticks. */
  tabTicks?: readonly { name: string; shown: boolean }[]
  oneAgent: boolean
  onToggleOneAgent: () => void
  /** The palette's rows for its search, and how many there are in all. */
  paletteRows?: readonly PaletteRow[]
  paletteTotal?: number
  onPickPalette: (id: string) => void
  onScrollPalette: (delta: number) => void
  onScrollHelp: (delta: number) => void
  killReport?: KillReport | null
  /** What each agent can pay from, for the wallet chips in a card's details. */
  wallets?: WalletsTopic
  onPayFrom: (cardId: string, wallet: { word: string; name: string }) => void
  /** The model picker's rows for an agent and a search. */
  engineRows?: (query: string, agent: string) => readonly PickerRow[]
  onPickEngine: (engine: EngineId, model: string | undefined) => void
  onPickPreset: (preset: Preset) => void
  onPickRunner: (on: boolean) => void
  onScrollEngines: (delta: number) => void
  /** Each agent's memory, and the person's deletes. */
  memory?: MemoryTopic
  onDeleteMemory: (row: MemoryRow) => void
  onPinMemory: (row: MemoryRow) => void
  onClearMemory: () => void
  /** The tab's layout, and the pane the layout menu acts on. */
  layoutInfo?: LayoutInfo
  layoutFocus?: PaneId
  onPickLayoutRow?: (index: number) => void
  onScrollLayoutMenu?: (delta: number) => void
  /** This tab's Signals choice, and a row of its pattern or chain menu clicked. */
  signals?: SignalsPick
  onPickSignalsMenu?: (index: number) => void
  /** The P&L window the core keeps, and a row of its menu clicked. */
  pnlWindow?: PnlWindow
  onPickPnlMenu?: (index: number) => void
  /** The wallet groups, which wallets show, and a row of the Wallets pane's menu clicked. */
  walletGroups?: readonly WalletGroup[]
  walletsShown?: WalletsShown
  onPickWalletsMenu?: (index: number) => void
  /** The overlay of every wallet: the account's wallets and names, and its rows and chips. */
  allWallets?: PortfolioView["wallets"]
  walletNames?: readonly WalletNameEntry[]
  onEveryWallet?: (which: "pick" | "name" | "clear" | "preview" | "back", index?: number) => void
  onCopyWallet?: (address: string) => void
  onFillLine?: (text: string) => void
  /** A Journal row's rows as recorded, their ⧉, and scrolling them. */
  journalRows?: JournalRowsHeld
  onCopyJournalRows?: (text: string) => void
  onScrollJournalRows?: (delta: number) => void
  /** A code bot's log as read, copying it, scrolling it, and stderr alone. */
  botLog?: BotLogHeld
  onCopyBotLog?: (text: string) => void
  onScrollBotLog?: (delta: number) => void
  onBotLogOnly?: () => void
  /** The approvals menu: each wallet's setting, each agent's limits, and a wallet or row clicked. */
  autonomy?: AutonomyTopic
  limits?: readonly AgentLimits[]
  onPickApprovalsWallet?: (index: number) => void
  onPickApprovalsRow?: (row: ApprovalsRow) => void
  /** The Triggers overlay: the triggers, keep-awake, and a trigger or chip clicked. */
  triggers?: TriggersTopic
  keepAwake?: KeepAwakeView
  onPickTriggers?: (index: number) => void
  onTriggersAct?: (ref: string, act: Act) => void
  /** The Bots overlay: the bots and their books, a flatten or remove asking, and a bot or chip clicked. */
  bots?: BotsTopic
  botConfirm?: BotConfirm
  /** The kill switch is on: bots that are on are held. */
  killed?: boolean
  onPickBots?: (index: number) => void
  onBotsAct?: (ref: string, act: Act) => void
  /** While you were away: the last gap's summary, the view's clock, the address ⧉ showed in full, and its chips, picks and scrolling. */
  away?: AwayView
  now?: number
  shownInFull?: string
  onAct?: (ref: string, act: Act) => void
  onPickAway?: (pick: RowPick) => void
  onScrollAway?: (delta: number) => void
}

/** A short menu of choices: each row's label and words, the one on ticked. */
interface Choice {
  label: string
  words: string
  on: boolean
}

/**
 * A menu of choices under the chip that opened it at column `x` and row `y`, or in the middle from the
 * palette or settings: Signals' pattern and chain, and the P&L window.
 */
function ChoiceMenu(props: { title: string; rows: readonly Choice[]; index: number; x?: number; y?: number; width: number; height: number; onPick: (index: number) => void }) {
  const pointer = usePointer()
  const rows = props.rows
  const labelW = Math.max(...rows.map((r) => r.label.length)) + 4
  const w = Math.min(props.width - 2, Math.max(36, labelW + Math.max(...rows.map((r) => r.words.length)) + 4))
  const h = Math.min(props.height - 1, rows.length + 3)
  const shown = rows.slice(Math.max(0, Math.min(rows.length - (h - 3), props.index - Math.floor((h - 3) / 2))))
  const left = Math.max(0, Math.min(props.width - w, props.x ?? Math.floor((props.width - w) / 2)))
  const top = Math.max(0, Math.min(props.height - h, props.y !== undefined ? props.y + 1 : Math.floor((props.height - h) / 2)))
  return (
    <box position="absolute" zIndex={OVERLAY_Z} left={left} top={top} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title={` ${props.title} `} flexDirection="column">
      {shown.slice(0, h - 3).map((row) => {
        const index = rows.indexOf(row)
        return (
          <box key={row.label} flexDirection="row" backgroundColor={index === props.index ? C.sel : C.term} onMouseDown={() => props.onPick(index)} {...pointer}>
            <text fg={row.on ? C.hi : C.ctl}>{`${index === props.index ? "▸" : " "} ${row.on ? "✓" : " "} ${row.label}`.padEnd(labelW + 1)}</text>
            <text fg={C.dim}>{fit(row.words, Math.max(0, w - 3 - labelW))}</text>
          </box>
        )
      })}
      <text fg={C.dim}>{fit("↑/↓ ⏎ or a click · esc closes", w - 2)}</text>
    </box>
  )
}

/**
 * Signals' pattern or chain menu: under the chip that opened it, or in the middle from
 * the palette. Each row says what it is in the Candle Harness's words; the one on is ticked. Drawn by the main view's
 * overlays and by a popped Signals pane, which has no others.
 */
export function SignalsMenu(props: { overlay: Extract<Overlay, { kind: "signalsMenu" }>; pick: SignalsPick; width: number; height: number; onPick: (index: number) => void }) {
  const o = props.overlay
  return <ChoiceMenu title={o.which === "pattern" ? "which signals" : "which chain"} rows={signalsMenuRows(o.which, props.pick)} index={o.index} {...(o.x !== undefined ? { x: o.x } : {})} {...(o.y !== undefined ? { y: o.y } : {})} width={props.width} height={props.height} onPick={props.onPick} />
}

/** The Wallets pane's `all groups ▾` menu, drawn by the main view and a popped Wallets pane. */
export function WalletsMenu(props: { overlay: Extract<Overlay, { kind: "walletsMenu" }>; groups: readonly WalletGroup[]; shown: WalletsShown | undefined; width: number; height: number; onPick: (index: number) => void }) {
  const o = props.overlay
  return <ChoiceMenu title="which wallets" rows={walletsMenuRows(props.groups, props.shown)} index={o.index} {...(o.x !== undefined ? { x: o.x } : {})} {...(o.y !== undefined ? { y: o.y } : {})} width={props.width} height={props.height} onPick={props.onPick} />
}

/** The P&L window's menu, drawn by the main view and a popped P&L pane. */
export function PnlMenu(props: { overlay: Extract<Overlay, { kind: "pnlMenu" }>; window: PnlWindow | undefined; width: number; height: number; onPick: (index: number) => void }) {
  const o = props.overlay
  return <ChoiceMenu title="P&L window" rows={pnlWindowRows(props.window, o.typing)} index={o.index} {...(o.x !== undefined ? { x: o.x } : {})} {...(o.y !== undefined ? { y: o.y } : {})} width={props.width} height={props.height} onPick={props.onPick} />
}

export function Overlays(props: OverlayProps) {
  const pointer = usePointer()
  const o = props.overlay
  if (!o) return null
  if (o.kind === "help") {
    return <Frame width={props.width} height={props.height} title="help" lines={helpLines()} hanging={HELP_COLUMN} footer="c every command · any other key closes" scroll={o.scroll ?? 0} onScroll={props.onScrollHelp} onClick={props.onClose} />
  }
  if (o.kind === "palette") {
    return <Palette rows={props.paletteRows ?? []} total={props.paletteTotal ?? 0} query={o.query} index={o.index} width={props.width} height={props.height} onPick={props.onPickPalette} onScroll={props.onScrollPalette} />
  }
  if (o.kind === "engines") {
    return (
      <EnginePicker
        agent={o.agent}
        rows={props.engineRows?.(o.query, o.agent) ?? []}
        query={o.query}
        index={o.index}
        width={props.width}
        height={props.height}
        onPick={props.onPickEngine}
        onPickPreset={props.onPickPreset}
        onPickRunner={props.onPickRunner}
        onScroll={props.onScrollEngines}
      />
    )
  }
  if (o.kind === "memory") {
    return (
      <MemoryOverlay
        agent={o.agent}
        view={props.memory?.agents[o.agent]}
        index={o.index}
        confirm={o.confirm === true}
        {...(o.confirmPinned !== undefined ? { confirmPinned: o.confirmPinned } : {})}
        width={props.width}
        height={props.height}
        onDelete={props.onDeleteMemory}
        onPin={props.onPinMemory}
        onClear={props.onClearMemory}
      />
    )
  }
  if (o.kind === "layouts") {
    if (!props.layoutInfo) return null
    return (
      <LayoutMenu
        info={props.layoutInfo}
        focus={props.layoutFocus}
        index={o.index}
        naming={o.naming}
        width={props.width}
        height={props.height}
        onPick={(i) => props.onPickLayoutRow?.(i)}
        onScroll={(d) => props.onScrollLayoutMenu?.(d)}
      />
    )
  }
  if (o.kind === "confirmLive") {
    // What a live trade would find missing right now, said and not enforced: y still switches.
    const gaps = props.liveGaps ?? []
    const fills = gaps.flatMap((g) => (g.fill ? [g.fill] : []))
    return (
      <Frame
        width={props.width}
        height={props.height}
        title="switch to live?"
        accent={C.good}
        lines={["Live trades move real funds, through one-press cards, within your limits.", "Paper trades never do.", ...(gaps.length ? ["", "Not ready for a live trade yet:", ...gaps.map((g) => `· ${g.words}`)] : [])]}
        {...(fills.length ? { chips: { label: "type it: ", chips: fills.map((f) => ({ name: f.label, onClick: () => props.onFillLine?.(f.line) })) } } : {})}
        footer="y switches to live · any other key stays in paper"
        onClick={() => {}}
      />
    )
  }
  if (o.kind === "settings") {
    const w = Math.min(props.width - 4, 64)
    // Its own rows, then a tick for each tab, so the person clicks which tabs show.
    const ticks = props.tabTicks ?? []
    const rows = [
      // Padded to the longest label, so "P&L window" doesn't run into its words.
      ...SETTINGS.map((row, i) => ({ key: row.id, label: row.label.padEnd(Math.max(9, ...SETTINGS.map((r) => r.label.length))), words: row.words, index: i, head: undefined as string | undefined })),
      ...ticks.map((t, i) => ({ key: `tick:${t.name}`, label: `[${t.shown ? "x" : " "}] ${t.name}`.padEnd(Math.max(9, ...ticks.map((x) => x.name.length + 4))), words: t.shown ? "on the tab bar" : "ticked off", index: SETTINGS.length + i, head: i === 0 ? "tabs: tick the ones to show" : undefined })),
    ]
    // The rows that fit under the tab bar, kept around the highlighted one.
    const room = Math.max(3, props.height - 6 - (ticks.length ? 1 : 0))
    const start = Math.max(0, Math.min(rows.length - room, o.index - Math.floor(room / 2)))
    const shown = rows.slice(start, start + room)
    const h = shown.length + 3 + (shown.some((r) => r.head) ? 1 : 0)
    // Under the tab bar's chip, left of the screen, as a menu opens from where it was clicked.
    return (
      <box position="absolute" zIndex={OVERLAY_Z} left={Math.min(props.settingsAt ?? 1, Math.max(0, props.width - w))} top={2} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title=" settings " flexDirection="column">
        {shown.map((row) => (
          <box key={row.key} flexDirection="column">
            {row.head ? <text fg={C.head}>{fit(row.head, w - 2)}</text> : null}
            <box flexDirection="row" backgroundColor={row.index === o.index ? C.sel : C.term} onMouseDown={() => props.onPickSettings?.(row.index)} {...pointer}>
              <text fg={C.ctl}>{`${row.index === o.index ? "▸" : " "} ${row.label}`}</text>
              <text fg={C.dim}>{fit(` ${row.words}`, Math.max(0, w - 5 - row.label.length))}</text>
            </box>
          </box>
        ))}
        <text fg={C.dim}>{fit(`↑/↓ ⏎ or a click${ticks.length ? " · a tick stays open for another" : ""} · esc closes`, w - 2)}</text>
      </box>
    )
  }
  if (o.kind === "agents") {
    const only = `[${props.oneAgent ? "x" : " "}] only ${props.activeAgent ?? "this agent"} in positions, wallets, activity · ctrl-f`
    const w = Math.min(props.width - 4, Math.max(40, only.length + 6))
    const h = props.agents.length + 4
    return (
      <box position="absolute" zIndex={OVERLAY_Z} left={Math.floor((props.width - w) / 2)} top={Math.floor((props.height - h) / 2)} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title=" active agent " flexDirection="column">
        {props.agents.map((agent, i) => (
          <box key={agent} backgroundColor={i === o.index ? C.sel : C.term} onMouseDown={() => props.onPickAgent(agent)} {...pointer}>
            <text fg={agent === props.activeAgent ? C.hi : C.ctl}>{`${i === o.index ? "▸" : " "} ${agent}${agent === props.activeAgent ? " · active" : ""}`}</text>
          </box>
        ))}
        <box backgroundColor={o.index === props.agents.length ? C.sel : C.term} onMouseDown={props.onToggleOneAgent} {...pointer}>
          <text fg={C.ctl}>{fit(`${o.index === props.agents.length ? "▸" : " "} ${only}`, w - 2)}</text>
        </box>
        <text fg={C.dim}>↑/↓ ⏎ · esc closes</text>
      </box>
    )
  }
  if (o.kind === "signalsMenu") return <SignalsMenu overlay={o} pick={props.signals ?? {}} width={props.width} height={props.height} onPick={props.onPickSignalsMenu ?? (() => {})} />
  if (o.kind === "triggers") return <TriggersMenu state={o} topic={props.triggers} {...(props.keepAwake ? { keepAwake: props.keepAwake } : {})} width={props.width} height={props.height} now={props.now ?? Date.now()} onPick={props.onPickTriggers ?? (() => {})} onAct={props.onTriggersAct ?? (() => {})} />
  if (o.kind === "bots") return <BotsMenu state={o} topic={props.bots} killed={props.killed === true} {...(props.botConfirm ? { confirm: props.botConfirm } : {})} width={props.width} height={props.height} now={props.now ?? Date.now()} onPick={props.onPickBots ?? (() => {})} onAct={props.onBotsAct ?? (() => {})} />
  if (o.kind === "approvals") return <ApprovalsMenu state={o} autonomy={props.autonomy} groups={props.walletGroups ?? []} limits={props.limits ?? []} width={props.width} height={props.height} onPickWallet={props.onPickApprovalsWallet ?? (() => {})} onPickRow={props.onPickApprovalsRow ?? (() => {})} />
  if (o.kind === "everyWallet") {
    const data = { wallets: props.allWallets ?? [], groups: props.walletGroups ?? [], names: props.walletNames ?? [], autonomy: props.autonomy?.wallets ?? [] }
    return <EveryWalletOverlay state={o} data={data} width={props.width} height={props.height} onAct={props.onEveryWallet ?? (() => {})} onCopy={props.onCopyWallet ?? (() => {})} onFill={props.onFillLine ?? (() => {})} />
  }
  if (o.kind === "walletsMenu") return <WalletsMenu overlay={o} groups={props.walletGroups ?? []} shown={props.walletsShown} width={props.width} height={props.height} onPick={props.onPickWalletsMenu ?? (() => {})} />
  if (o.kind === "pnlMenu") return <PnlMenu overlay={o} window={props.pnlWindow} width={props.width} height={props.height} onPick={props.onPickPnlMenu ?? (() => {})} />
  if (o.kind === "stopHelp") {
    const n = props.killReport?.notStopped
    const lines = n ? [n.wording, "", ...n.steps.flatMap((s) => [`${s.agent}: ${s.takeOffWallet}, or ${s.revoke}`, ...(s.disableTee ?? []).map((t) => `${s.agent}'s TEE wallet ${t.wallet}: ${t.command} (for good: Candle never re-enables it; then sweep it home)`)]), ...n.candleStopped.map((c) => `Candle has stopped ${c.agent}: ${c.code}`)] : ["The kill switch is off."]
    return <Frame width={props.width} height={props.height} title="what the kill switch can't reach" lines={lines} hanging={2} onClick={props.onClose} />
  }
  if (o.kind === "away") {
    return (
      <AwayOverlay
        view={props.away}
        scroll={o.scroll ?? 0}
        width={props.width}
        height={props.height}
        now={props.now ?? Date.now()}
        {...(props.shownInFull ? { shownInFull: props.shownInFull } : {})}
        onAct={props.onAct ?? (() => {})}
        onPick={props.onPickAway ?? (() => {})}
        onScroll={props.onScrollAway ?? (() => {})}
      />
    )
  }
  if (o.kind === "botLog") {
    const held = props.botLog?.name === o.name ? props.botLog : undefined
    const lines = botLogLines(held, o.only)
    const copyable = held?.lines?.length ? lines.join("\n") : ""
    const chips = { label: "", chips: [...(copyable && props.onCopyBotLog ? [{ name: "⧉ copy all", onClick: () => props.onCopyBotLog!(copyable) }] : []), ...(held?.lines?.length && props.onBotLogOnly ? [{ name: o.only ? "every line" : "stderr only", onClick: props.onBotLogOnly }] : [])] }
    return <Frame width={props.width} height={props.height} title={`${o.name} · its log`} lines={lines} hanging={16} {...(chips.chips.length ? { chips } : {})} scroll={o.scroll ?? Number.MAX_SAFE_INTEGER} {...(props.onScrollBotLog ? { onScroll: props.onScrollBotLog } : {})} footer="kept by the core · redacted · its last 5 MB · esc or any key closes" onClick={props.onClose} />
  }
  if (o.kind === "journalRows") {
    const held = props.journalRows?.id === o.id ? props.journalRows : undefined
    const text = journalRowsText(held)
    const chips = text && props.onCopyJournalRows ? { label: "", chips: [{ name: "⧉ copy them", onClick: () => props.onCopyJournalRows!(text) }] } : undefined
    return <Frame width={props.width} height={props.height} title="as recorded" lines={journalRowsLines(held)} {...(chips ? { chips } : {})} scroll={o.scroll ?? 0} {...(props.onScrollJournalRows ? { onScroll: props.onScrollJournalRows } : {})} footer="already redacted · esc or any key closes" onClick={props.onClose} />
  }
  // The tour draws over the frame itself, where the panes are placed (app.tsx, tour.tsx); so does a folded pane
  // opened over it, from the pane's own lines (pane-overlay.tsx).
  if (o.kind === "tour" || o.kind === "pane") return null
  // A Build pane's card is drawn whole by the frame (pane-overlay.tsx), not as its details.
  if (o.build) return null
  const card = props.cards.find((c) => c.cardId === o.cardId)
  if (!card) return null
  const others = otherWallets(card, props.wallets)
  const chips = others.length ? { label: "pay from ", chips: others.map((w) => ({ name: w.name, onClick: () => props.onPayFrom(card.cardId, w) })) } : undefined
  const footer = chips ? "a wallet makes a new card paid from it · esc or any key closes" : "esc or any key closes"
  return <Frame width={props.width} height={props.height} title={card.display.headline ?? "card"} lines={cardDetails(card)} hanging={10} {...(chips ? { chips } : {})} onClick={props.onClose} footer={footer} />
}
