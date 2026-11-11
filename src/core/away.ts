// While you were away: what happened between the main view's last close and
// its next open, in the Candle Harness's own words, built from what the core records, never by a model.
//
// The gap runs from the last session's mark (pnl.ts `lastSessionEnd`: the main view's last close, or, after a
// core that died with the view open, the journal's last row before the next `core.started`) to the attach
// that opens the view again. A gap under 10 minutes makes no summary, and the last one stays.
//
// From the records:
//   - when the core wasn't running in the gap, from its start and stop rows;
//   - the journal's rows in the gap, grouped as the Journal groups them and in its words: each agent's
//     turns that ended, every trade with or without a card and how it ended, the other cards (one that
//     waited and expired among them), what the agents changed on Hacc and in memory, and what was stopped or
//     refused (the kill switch, refusals at proposal, a Candle connection or Hacc key that failed), the
//     triggers: what fired, what waited for the person, what the kill switch held, what was missed; and each
//     bot, rules or code: what it bought and sold, its skips, and what waited, was refused or held, with its own book's
//     P&L over the gap and what it holds now (its trades are its own section, never Trades);
//   - P&L over the gap from the samples, as harness_pnl's "since last session" reads it, so the agent's answer
//     to `ask` is the same figure: from the mark's own sample, so a gap with the core stopped is counted
//     whole.
// From three reads at start, each as a read the person asked for (key-budget.ts `ask`), never waiting:
//   - each agent's P&L book, for "now";
//   - each agent key's fills (`candle_get_profile_trades`) since the mark that the Candle Harness didn't send: Candle
//     books each fill with its `clientTradeId`, which is the core's opId on both routes, so the Candle Harness's own are
//     known by id; a fill with no id is the Candle Harness's by signature; and a Candle Harness trade whose outcome is still unknown
//     claims a fill of the same agent, token and side made after it was sent, or, where it could be either,
//     the fill says "may be the Candle Harness's". Nothing the Candle Harness sent is ever called outside it;
//   - Hacc's personal signals (`/v1/me/signals`) since the mark, by date, counted with the newest few kept.
// And what the wallets hold now against the last read before the view closed, from the portfolio read the
// view's attach makes anyway (no extra read).
//
// Each read that fails says so in its place, never as nothing. The summary is kept in `state/away.json`
// (0600) until the next gap, so a restart or a second view shows the same one.
import { ranWithoutCard } from "../shared/approved-how"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { sameAddress } from "../shared/chains"
import type { Redactor } from "../shared/redact"
import type { ToolOutcome } from "./candle-mcp"
import { type HaccAnswer, haccCursor } from "./hacc"
import type { JournalRow } from "./journal"
import { entryWords, isAnchor, isLifeRow, type JournalEntry, keysOf } from "./journal-query"
import { type PnlTrade, signatureOf, tradesFrom, type WindowFigure } from "./pnl"
import { cleanRow, type SignalRow } from "./signal-stream"

/** A gap shorter than this makes no summary. */
export const AWAY_MIN_GAP_MS = 10 * 60_000
/** Rows this far before the gap are read too: a card proposed before the close can end in the gap (a trade's card lives a minute, any other ten). */
export const LOOKBACK_MS = 15 * 60_000
/** The most journal rows a summary reads; past that, the oldest in the gap are left out, and it says so. */
export const MAX_ROWS = 20_000
/** The core counts as not running for a stretch this long or longer with no rows between a stop and a start. */
export const DOWN_MIN_MS = 60_000
/** Each list's entries at most; the counts hold every one. */
export const LISTED = 100
/** Candle's fills read per agent key: its default, the newest that many. */
export const FILLS_LIMIT = 200
/** Personal signals: Hacc's pages read at most, and the newest kept. */
export const MINE_PAGES = 5
export const MINE_PAGE = 100
export const MINE_NEWEST = 6
/** The portfolio read after the attach is waited for this long, then the holdings say they weren't read. */
export const HOLDINGS_WAIT_MS = 60_000
/** A holdings snapshot counts as "then" when it was taken this close to the gap's start. */
export const THEN_SLACK_MS = 2 * 60_000

type Tone = JournalEntry["tone"]

export interface AwayEntry {
  at: string
  /** Its last row: a turn's end, a card's close. */
  last: string
  agent?: string
  mode: "paper" | "live"
  text: string
  tone: Tone
  mint?: string
  symbol?: string
  /** Its rows, for the Journal's details. */
  seqs: number[]
}

/** `not-sold`: a live sell Candle closed as the key's paper position, so nothing live was sold. */
export type TradeOutcome = "filled" | "not-sold" | "failed" | "refused" | "unknown" | "sent" | "abandoned" | "rejected" | "withdrawn" | "expired" | "waiting" | "approved"

export interface AwayCard extends AwayEntry {
  outcome: TradeOutcome
  kind?: string
  side?: string
  /** The card's value when proposed, ≈. */
  usd?: number
  /** It ran without a card, inside its wallet's limits. */
  withoutCard?: true
  /** Typed, run at once under `cards.typedTrades = "instant"`. */
  instant?: true
  paper?: true
  /** A trigger's card: the trigger's name. */
  trigger?: string
  /** A trigger's card that expired with nobody there, not yet run again: its id, for `run it now`. */
  runNow?: string
}

/** A bot in the gap, rules or code: what it bought and sold, its P&L, what it holds now, and anything held or refused. */
export interface AwayBot {
  name: string
  agent?: string
  mode: "paper" | "live"
  /** Entries and exits that filled in the gap. */
  bought: number
  sold: number
  /** Its exits that filled, by why: "take profit", "stop"… */
  exits: Record<string, number>
  skipped: number
  /** Its trades in the gap, newest first, in the Journal's words. */
  trades: AwayEntry[]
  /** What waited for the person, was refused or failed, was held, or paused it. */
  held: AwayEntry[]
  /** What its exits realized in the gap: the Candle Harness's count from its own fills; null where one couldn't be valued. */
  realizedUsd?: number | null
  /** Its positions open now, by token. */
  open?: { mint: string; symbol?: string }[]
  /** Its own day figure refused its buys in the gap: from when, and the figure. Also a line in `held`. */
  dayFigure?: { from: string; figure?: string; words: string }
}

/** A bot's own book at the summary's making (bot-book.ts): what its exits realized in the gap, and what it holds now. */
export interface AwayBotBook {
  name: string
  agent: string
  mode: "paper" | "live"
  realizedUsd: number | null
  open: { mint: string; symbol?: string }[]
}

export interface OutsideFill {
  at: number
  agent: string
  mint: string
  symbol?: string
  side: string
  usd: number | null
  wallet?: string
  signature?: string
}

export interface AgentFills {
  agent: string
  state: "reading" | "read" | "failed"
  words?: string
  /** Fills the Candle Harness didn't send. */
  fills: OutsideFill[]
  /** Fills that may be a Candle Harness trade whose outcome is unknown, or may not. */
  maybe: OutsideFill[]
  /** Fills a Candle Harness trade of unknown outcome claimed. */
  claimed: number
  /** Candle's newest FILLS_LIMIT didn't reach back to the gap's start: they reach this far. */
  reachesBack?: number
}

export interface HoldingChange {
  wallet: string
  name: string
  /** A token's mint, or the wallet's native asset's symbol ("SOL", "ETH"). */
  asset: string
  symbol?: string
  /** The wallet's native asset, not a token. */
  native?: true
  then: number
  now: number
  /** No live trade this Candle Harness sent from the wallet in the gap explains it: other keys pay from it too. */
  outside?: true
}

export interface HoldingsSnapshot {
  /** When it was taken: the main view's close. */
  at: number
  /** When that portfolio was read. */
  readAt: number | null
  /** `sol` is the wallet's native balance (kept under that name, as snapshots were written); `native` names it when it isn't SOL. */
  wallets: { address: string; name: string; sol: number | null; native?: string; tokens: { mint: string; symbol?: string; amount: number }[] | null }[]
}

export type ReadState = "reading" | "read" | "failed"

export interface AwaySummary {
  id: string
  from: number
  to: number
  madeAt: number
  /** The view whose attach made it: that view shows the note on startup. */
  forView?: string
  /** Stretches in the gap when the core wasn't running: nothing ran in the Candle Harness then. */
  coreDown: { from: number; to: number }[]
  /** The core wasn't running at all from the mark until this attach started it. */
  coreGoneThroughout: boolean
  turns: AwayEntry[]
  trades: AwayCard[]
  cards: AwayCard[]
  /** What the agents changed on Hacc and in memory. */
  changes: AwayEntry[]
  stopped: AwayEntry[]
  /** What the triggers did: fired, waited for the person, held by the kill switch, missed or stopped. Absent in a summary from before triggers. */
  triggers?: AwayEntry[]
  /** Each bot, rules or code, that traded, was held, or holds a position. Absent in a summary from before bots. */
  bots?: AwayBot[]
  /** Cards still waiting for the person when it was made. */
  waitingNow: number
  /** The gap held more rows than a summary reads: it covers from here. */
  cut?: { from: string }
  pnl: { state: ReadState; label: string; usd: number | null; from: number | null; short: boolean; agents: Record<string, { usd: number | null; from: number | null }>; words?: string }
  outside: { state: ReadState; agents: AgentFills[] }
  signals: { state: ReadState | "off" | "needs-plan" | "no-key"; count: number; newest: SignalRow[]; more?: true; words?: string }
  holdings: { state: "reading" | "read" | "unknown" | "failed"; then?: number; changes: HoldingChange[]; words?: string }
  counts: { turns: number; trades: number; withoutCard: number; cards: number; expired: number; changes: number; stopped: number; outside: number; maybe: number; signals: number; holdings: number; triggers?: number; fired?: number; botTrades?: number; botHeld?: number }
  happened: boolean
}

export interface AwayView {
  summary: AwaySummary | null
  /** No gap has been seen yet: the Candle Harness hasn't been closed and opened again since its record began. */
  firstRun?: true
}

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const ms = (iso: string) => Date.parse(iso)
/** A time of day on this machine's clock, as the person reads it. */
const hm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** "45m", "3h 12m", "2d 3h": how long the gap ran. */
export function gapLength(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// --- The gap's records ---------------------------------------------------------------------------------

/** Stretches in (from, to] when the core wasn't running: from a stop (or, for a core that died, its last row) to the next start. */
export function coreDown(rows: readonly JournalRow[], from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let prev = from
  let stoppedAt: number | undefined
  for (const row of rows) {
    const at = ms(row.at)
    if (!(at > from) || at > to) {
      if (at <= from) prev = Math.max(prev, at)
      continue
    }
    if (row.type === "core.stopped") stoppedAt = at
    else if (row.type === "core.started") {
      // No stop row: the core before died, after its last row.
      const down = stoppedAt ?? prev
      if (at - down >= DOWN_MIN_MS) out.push({ from: down, to: at })
      stoppedAt = undefined
    }
    prev = Math.max(prev, at)
  }
  return out
}

const CARD_END: Record<string, TradeOutcome> = {
  "card.rejected": "rejected",
  "card.withdrawn": "withdrawn",
  "card.expired": "expired",
  "operation.submitting": "sent",
  "operation.pending": "sent",
  "operation.succeeded": "filled",
  "operation.failed": "failed",
  "operation.refused": "refused",
  "operation.unknown": "unknown",
  "operation.abandoned": "abandoned",
}
const TRADE_TOOLS = new Set(["candle_trade", "candle_swap"])
const isTradeRow = (row: JournalRow | undefined) => !!row && (row.kind === "trade" || row.kind === "swap" || TRADE_TOOLS.has(String(row.tool)))

/** Single rows that say something was stopped or refused. */
function stopRow(row: JournalRow): boolean {
  switch (row.type) {
    case "kill.on":
    case "kill.off":
    case "card.refused":
    case "tool.refused":
    case "cli.refused":
    case "candle.start_failed":
    case "agent.message_refused":
    case "core.bug":
      return true
    case "hacc.stream":
      return row.event === "key_refused" || row.event === "full" || row.event === "gap"
    default:
      return false
  }
}
const CHANGE_TYPES = new Set(["hacc.change", "hacc.replay", "memory.change"])
/** A trigger's rows: what fired, what waited for the person, what the kill switch held, what was missed or stopped, whom it woke or why not. */
function triggerRow(row: JournalRow): boolean {
  // Held by the pause or the plan, or not watching since its line stopped reading (the wallet it pays from).
  if (row.type === "trigger.held") return row.reason === "paused" || row.reason === "plan" || row.reason === "unreadable"
  // An agent switched one off or narrowed it with nobody there: a stop that no longer waits is worth knowing on return.
  if (row.type === "trigger.changed") return row.how === "agent"
  if (row.type === "trigger.ran") return row.outcome === "stopped"
  return row.type === "trigger.fired" || row.type === "trigger.waiting" || row.type === "trigger.missed" || row.type === "trigger.notify" || row.type === "trigger.woke" || row.type === "trigger.wake_skipped"
}

/**
 * A bot's rows the person should hear of: a card that waits, a refusal or failure, a held sell, a position given up,
 * a pause by the agent or Candle; and a code bot's crash or giving up.
 */
function botHeldRow(row: JournalRow): boolean {
  switch (row.type) {
    case "bot.waiting":
    case "bot.request_waiting":
    case "bot.exit_waiting":
    case "bot.exit_held":
    case "bot.position_left":
      return true
    case "bot.process":
      return row.what === "crashed" || row.what === "gave_up"
    case "bot.entry_ended":
    case "bot.request_ended":
    case "bot.exit_ended":
      return row.outcome === "refused" || row.outcome === "failed" || row.outcome === "lost" || row.outcome === "expired"
    case "bot.paused":
      return row.how === "candle" || row.how === "agent"
    // An agent narrowed it at once (a smaller stake, a tighter filter or exit): the bot isn't what was approved.
    case "bot.changed":
      return row.how === "agent"
    default:
      return false
  }
}
const BAD_OUTCOMES = new Set<TradeOutcome>(["failed", "refused", "unknown", "abandoned"])

/** What a Candle Harness trade tells the fill matcher: its id, its signature, and, while its outcome is unknown, what it was. */
interface HarnessTrade {
  opId: string
  agent?: string
  /** The wallet that paid, by address. */
  wallet?: string
  mint?: string
  side?: string
  signature?: string
  unknown: boolean
  sentAt?: number
}

export interface Records {
  coreDown: { from: number; to: number }[]
  coreGoneThroughout: boolean
  turns: AwayEntry[]
  trades: AwayCard[]
  cards: AwayCard[]
  changes: AwayEntry[]
  stopped: AwayEntry[]
  triggers: AwayEntry[]
  bots: AwayBot[]
  /** Every live trade the rows hold, for matching Candle's fills. */
  harness: HarnessTrade[]
}

/**
 * The gap's records from the journal's rows (oldest first, from LOOKBACK_MS before the gap): each group (a
 * card's life, a turn) that has a row in (from, to], and each single row in it that says something.
 */
export function awayRecords(rows: readonly JournalRow[], from: number, to: number, symbolOf: (mint: string) => string | undefined): Records {
  const groups: JournalRow[][] = []
  const byKey = new Map<string, JournalRow[]>()
  const singles: JournalRow[] = []
  for (const row of rows) {
    const keys = keysOf(row)
    if (keys.length === 0) {
      singles.push(row)
      continue
    }
    // A proposal or a turn's start begins its own group; any other row joins its keys' group, tying two together.
    const found = isAnchor(row) ? [] : [...new Set(keys.map((k) => byKey.get(k)).filter((g): g is JournalRow[] => g !== undefined))]
    let g = found[0]
    if (!g) {
      g = []
      groups.push(g)
    }
    for (const other of found.slice(1)) {
      g.push(...other)
      other.length = 0
    }
    g.push(row)
    for (const k of keys) byKey.set(k, g)
  }
  const inGap = (row: JournalRow) => ms(row.at) > from && ms(row.at) <= to
  const turns: AwayEntry[] = []
  const trades: AwayCard[] = []
  const cards: AwayCard[] = []
  const changes: AwayEntry[] = []
  const stopped: AwayEntry[] = []
  const triggers: AwayEntry[] = []
  const firings = new Map<string, AwayEntry>()
  const bots = new Map<string, AwayBot>()
  const botOf = (name: string, agent: string | undefined, mode: "paper" | "live"): AwayBot => {
    let b = bots.get(name)
    if (!b) bots.set(name, (b = { name, ...(agent ? { agent } : {}), mode, bought: 0, sold: 0, exits: {}, skipped: 0, trades: [], held: [] }))
    return b
  }
  /** A bot's trade that filled: counted as bought or sold, an exit by its reason. */
  const botFilled = (b: AwayBot, act: unknown, reason: unknown) => {
    if (act === "exit") {
      b.sold++
      // A code bot's own sell has no exit's why: its code sold it.
      const why = reason === "bot" ? "its own sell" : String(reason ?? "exit").replace(/_/g, " ").replace(/^stop loss$/, "stop")
      b.exits[why] = (b.exits[why] ?? 0) + 1
    } else b.bought++
  }
  const harness: HarnessTrade[] = []
  const entry = (group: readonly JournalRow[]): AwayEntry => {
    const e = entryWords(group, symbolOf)
    return { at: e.at, last: e.last, ...(e.agent ? { agent: e.agent } : {}), mode: e.mode, text: e.text, tone: e.tone, ...(e.mint ? { mint: e.mint } : {}), ...(e.symbol ? { symbol: e.symbol } : {}), seqs: e.seqs }
  }

  for (const raw of groups) {
    if (raw.length === 0) continue
    const group = [...raw].sort((a, b) => a.seq - b.seq)
    const isLife = group.some(isLifeRow)
    const created = group.find((r) => r.type === "card.created")
    const trade = isLife && (isTradeRow(created) || isTradeRow(group.find((r) => r.type === "operation.submitting")))
    if (trade && created && created.mode === "live" && typeof created.opId === "string") {
      const end = group.findLast((r) => CARD_END[r.type] !== undefined)
      const done = group.find((r) => r.type === "operation.succeeded")
      const sig = done ? signatureOf(done.result) : undefined
      const params = record(created.params)
      const sent = group.find((r) => r.type === "operation.submitting")
      const outcome = end ? CARD_END[end.type]! : undefined
      harness.push({
        opId: created.opId,
        ...(created.agent ? { agent: created.agent } : {}),
        ...(str(created.wallet) ? { wallet: str(created.wallet) } : {}),
        ...(str(created.mint) ?? str(params?.mint) ? { mint: str(created.mint) ?? str(params?.mint) } : {}),
        ...(str(created.side) ? { side: str(created.side) } : {}),
        ...(sig ? { signature: sig } : {}),
        unknown: outcome === "unknown" || outcome === "sent",
        ...(sent ? { sentAt: ms(sent.at) } : {}),
      })
    }
    if (!group.some(inGap)) continue
    if (isLife) {
      const e = entry(group)
      const approved = group.find((r) => r.type === "card.approved")
      const end = group.findLast((r) => CARD_END[r.type] !== undefined)
      const closedAsPaper = end?.type === "operation.succeeded" && end.paper === true
      const outcome: TradeOutcome = closedAsPaper ? "not-sold" : end ? CARD_END[end.type]! : approved ? "approved" : group.some((r) => r.type === "approval.refused") ? "refused" : "waiting"
      const value = record(created?.value)
      const usd = num(value?.usd)
      // A bot's trade is the bot's, a rules bot's or a code bot's: its section, never Trades (a busy bot would bury the person's own).
      if (typeof created?.bot === "string") {
        const b = botOf(created.bot, created.agent, created.mode)
        if (outcome === "filled") botFilled(b, created.botAct, created.botReason)
        if (BAD_OUTCOMES.has(outcome) || outcome === "expired" || outcome === "waiting") b.held.push(e)
        else b.trades.push(e)
        continue
      }
      const card: AwayCard = {
        ...e,
        outcome,
        ...(str(created?.kind) ? { kind: str(created?.kind) } : {}),
        ...(str(created?.side) ? { side: str(created?.side) } : {}),
        ...(usd !== undefined ? { usd } : {}),
        ...(ranWithoutCard(approved?.how) ? { withoutCard: true as const } : {}),
        ...(approved?.how === "instant" ? { instant: true as const } : {}),
        ...(typeof created?.trigger === "string" ? { trigger: created.trigger } : {}),
        // A trigger's card nobody pressed, not run again since: `run it now`.
        ...(typeof created?.trigger === "string" && outcome === "expired" && typeof created.cardId === "string" && !rows.some((r) => r.type === "trigger.run_now" && r.cardId === created.cardId) ? { runNow: created.cardId } : {}),
      }
      ;(trade ? trades : cards).push(card)
      continue
    }
    // A turn: only one that ended in the gap (a turn still running shows as running, from the agent pane).
    const ended = group.find((r) => r.type === "agent.turn" || r.type === "agent.turn_failed")
    if (ended && inGap(ended)) turns.push(entry(group))
  }

  for (const row of singles) {
    if (!inGap(row)) continue
    // A bot's paper trades, its decisions' troubles and its skips are the bot's section.
    if (typeof row.bot === "string" && (row.type === "paper.call" || row.type === "card.refused")) {
      const b = botOf(row.bot, row.agent, row.type === "paper.call" ? row.mode : row.botMode === "paper" ? "paper" : row.mode)
      if (row.type === "card.refused" || row.isError === true) b.held.push(entry([row]))
      else {
        botFilled(b, row.botAct, row.botReason)
        b.trades.push(entry([row]))
      }
      continue
    }
    if (row.type.startsWith("bot.") && typeof row.name === "string") {
      const mode = row.botMode === "paper" || row.botMode === "live" ? row.botMode : row.mode
      if (row.type === "bot.skipped") botOf(row.name, row.agent, mode).skipped += typeof row.count === "number" ? row.count : 1
      else if (row.type === "bot.refused" && row.code === "FIGURE_DAY") {
        // Its day figure reached: the one thing worth knowing on return, said once from when, not once a refusal.
        const b = bots.get(row.name) ?? botOf(row.name, row.agent, mode)
        if (!b.dayFigure) {
          const figure = /over its (\$[\d,.]+) a day/.exec(String(row.words ?? ""))?.[1]
          const words = `refused its buys from ${hm(ms(row.at))} on: over its ${figure ? `${figure} a day` : "day figure"}`
          b.dayFigure = { from: row.at, ...(figure ? { figure } : {}), words }
          b.held.push({ ...entry([row]), text: words, tone: "warn" })
        }
      } else if (botHeldRow(row)) botOf(row.name, row.agent, mode).held.push(entry([row]))
      continue
    }
    if (row.type === "paper.call") {
      const e = entry([row])
      const args = record(row.args)
      trades.push({ ...e, outcome: row.isError === true ? "refused" : "filled", paper: true, ...(str(args?.side) ? { side: str(args?.side) } : {}) })
    } else if (row.type === "agent.turn_failed") turns.push(entry([row]))
    else if (CHANGE_TYPES.has(row.type)) changes.push(entry([row]))
    else if (stopRow(row)) stopped.push(entry([row]))
    else if (triggerRow(row)) {
      // One line a firing: its notice or the agent it woke joins the line that says what fired.
      const fired = typeof row.fireId === "string" ? firings.get(row.fireId) : undefined
      if (fired && (row.type === "trigger.notify" || row.type === "trigger.woke")) {
        fired.text += row.type === "trigger.notify" ? " → notified you" : row.joined === true ? ` → joined ${String(row.woke ?? "the agent")}'s woken turn` : ` → woke ${String(row.woke ?? "the agent")}`
        fired.seqs = [...fired.seqs, row.seq]
        continue
      }
      const e = entry([row])
      if (row.type === "trigger.fired" && typeof row.fireId === "string") firings.set(row.fireId, e)
      triggers.push(e)
    }
  }
  const down = coreDown(rows, from, to)
  // The core started by this attach, with no row of its own between the mark and its start.
  const gone = down.length === 1 && down[0]!.from === from && !rows.some((r) => ms(r.at) > from && ms(r.at) < down[0]!.to)
  const newestFirst = <T extends { at: string }>(list: T[]) => list.sort((a, b) => ms(b.at) - ms(a.at))
  for (const b of bots.values()) {
    newestFirst(b.trades)
    newestFirst(b.held)
  }
  return { coreDown: down, coreGoneThroughout: gone, turns: newestFirst(turns), trades: newestFirst(trades), cards: newestFirst(cards), changes: newestFirst(changes), stopped: newestFirst(stopped), triggers: newestFirst(triggers), bots: [...bots.values()], harness }
}

/**
 * The gap's bots with their own books: each one's P&L over the gap and what it holds now. A bot that did
 * nothing in the gap is listed only while it holds a position, so the note says what's still open.
 */
export function withBooks(active: readonly AwayBot[], books: readonly AwayBotBook[]): AwayBot[] {
  const out = active.map((b) => ({ ...b, trades: b.trades.slice(0, LISTED), held: b.held.slice(0, LISTED) }))
  for (const book of books) {
    let b = out.find((x) => x.name === book.name)
    if (!b) {
      if (book.open.length === 0) continue
      out.push((b = { name: book.name, agent: book.agent, mode: book.mode, bought: 0, sold: 0, exits: {}, skipped: 0, trades: [], held: [] }))
    }
    b.mode = book.mode
    if (b.sold > 0 || book.realizedUsd !== 0) b.realizedUsd = book.realizedUsd
    b.open = book.open
  }
  return out
}

// --- Fills outside the Candle Harness -------------------------------------------------------------------------------

/**
 * An agent key's fills since `from` that the Candle Harness didn't send. A fill is the Candle Harness's by its `clientTradeId` (the
 * core's opId), else its signature. A Candle Harness trade whose outcome is unknown claims the one fill of its agent,
 * token and side made after it was sent; where there are several, each "may be the Candle Harness's".
 */
export function outsideFills(result: unknown, agent: string, from: number, harness: readonly HarnessTrade[], symbolOf?: (mint: string) => string | undefined): Omit<AgentFills, "state"> | undefined {
  const all = tradesFrom(result, agent, symbolOf)
  if (!all) return undefined
  const ids = new Set(harness.map((t) => t.opId))
  const sigs = new Set(harness.flatMap((t) => (t.signature ? [t.signature] : [])))
  const theirs = (t: PnlTrade) => (t.clientTradeId !== undefined && ids.has(t.clientTradeId)) || (t.signature !== undefined && sigs.has(t.signature))
  // A failed trade moved nothing.
  const since = all.filter((t) => t.at >= from && !t.error && t.status !== "failed")
  let left = since.filter((t) => !theirs(t))
  // A fill with an id the Candle Harness never used is someone else's for certain (the Candle Harness's carry theirs); one with none may be a lost Candle Harness trade.
  const unsure = (t: PnlTrade) => t.clientTradeId === undefined
  let claimed = 0
  const maybe = new Set<PnlTrade>()
  for (const lost of harness.filter((t) => t.unknown && t.agent === agent)) {
    const could = left.filter((f) => unsure(f) && f.mint === lost.mint && f.side === lost.side && (lost.sentAt === undefined || f.at >= lost.sentAt - 5_000))
    if (could.length === 1) {
      left = left.filter((f) => f !== could[0])
      claimed++
    } else for (const f of could) maybe.add(f)
  }
  const fill = (t: PnlTrade): OutsideFill => ({ at: t.at, agent, mint: t.mint, ...(t.symbol ? { symbol: t.symbol } : {}), side: t.side, usd: t.usd, ...(t.wallet ? { wallet: t.wallet } : {}), ...(t.signature ? { signature: t.signature } : {}) })
  const oldest = all.at(-1)
  return {
    agent,
    fills: left.filter((f) => !maybe.has(f)).map(fill),
    maybe: [...maybe].map(fill),
    claimed,
    ...(all.length >= FILLS_LIMIT && oldest && oldest.at > from ? { reachesBack: oldest.at } : {}),
  }
}

// --- Holdings ------------------------------------------------------------------------------------------

/** What changed in each wallet between two snapshots: a token or SOL whose amount moved. */
export function holdingChanges(then: HoldingsSnapshot, now: HoldingsSnapshot): HoldingChange[] {
  const out: HoldingChange[] = []
  const moved = (a: number, b: number) => Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  for (const w of now.wallets) {
    const before = then.wallets.find((x) => x.address === w.address)
    if (!before) continue
    const native = w.native ?? "SOL"
    if (w.sol !== null && before.sol !== null && (before.native ?? "SOL") === native && moved(before.sol, w.sol)) out.push({ wallet: w.address, name: w.name, asset: native, symbol: native, native: true, then: before.sol, now: w.sol })
    if (!w.tokens || !before.tokens) continue
    const mints = new Set([...w.tokens.map((t) => t.mint), ...before.tokens.map((t) => t.mint)])
    for (const mint of mints) {
      const a = before.tokens.find((t) => t.mint === mint)
      const b = w.tokens.find((t) => t.mint === mint)
      const symbol = b?.symbol ?? a?.symbol
      if (moved(a?.amount ?? 0, b?.amount ?? 0)) out.push({ wallet: w.address, name: w.name, asset: mint, ...(symbol ? { symbol } : {}), then: a?.amount ?? 0, now: b?.amount ?? 0 })
    }
  }
  return out
}

/**
 * Marks each change no live trade this Candle Harness sent in the gap explains: none from that wallet (for SOL),
 * or none of that token from it. A sent trade whose wallet or token wasn't recorded explains anything, so a
 * change is never called outside when it may be the Candle Harness's own. A card never sent explains nothing.
 */
export function markOutside(changes: readonly HoldingChange[], trades: readonly HarnessTrade[], from: number, to: number): HoldingChange[] {
  const sent = trades.filter((t) => t.sentAt !== undefined && t.sentAt > from && t.sentAt <= to)
  return changes.map((c) => {
    const explained = sent.some((t) => (t.wallet === undefined || sameAddress(t.wallet, c.wallet)) && (c.native === true || c.asset === "SOL" || t.mint === undefined || sameAddress(t.mint, c.asset) || t.side === "swap"))
    return explained ? c : { ...c, outside: true as const }
  })
}

// --- The desk --------------------------------------------------------------------------------------------

export interface AwayDeps {
  statePath: string
  now: () => number
  redactor: Redactor
  /** The journal's rows from a time on, oldest first, at most `max` (journal-query.ts `rowsSince`). */
  rowsSince: (from: number, max: number) => Promise<{ rows: JournalRow[]; cut?: true }>
  /** The rows in memory: a fill's id is matched against these too. */
  memoryRows: () => readonly JournalRow[]
  symbolOf: (mint: string) => string | undefined
  /** Cards waiting for the person now. */
  waitingCards: () => number
  /** Candle is up (the core's children started): the reads wait for it. */
  ready: () => Promise<unknown>
  /** The agents with a key, and its prefix. */
  agents: () => { agent: string; prefix: string }[]
  /** Each agent's P&L book read now, as asked; then the figure from a start. */
  readPnl: () => Promise<void>
  /** The figure from the mark: its own sample is the start (pnl.ts `windowFigure`'s `mark`). */
  pnlFigure: (start: number, label: string) => WindowFigure
  /** Why an agent's last P&L read failed, if it did. */
  pnlFailed: (agent: string) => string | undefined
  /** One read of an agent key's fills, through its own key, as asked. */
  fills: (agent: string, prefix: string) => Promise<ToolOutcome>
  /**
   * A page of Hacc's personal signals, with the first agent key Hacc takes; undefined when Hacc is off. `after`
   * is only ever Hacc's own `next_after`: Hacc takes a whole number there and refuses a date.
   */
  mine?: (after: string | undefined) => Promise<HaccAnswer> | undefined
  /** What the wallets hold now, from the last portfolio read. */
  holdings: () => HoldingsSnapshot | undefined
  /** Each bot's own book, rules and code: what its sells realized between two times, and what it holds now. */
  bots?: (from: number, to: number) => AwayBotBook[]
  publish: (view: AwayView) => void
  /** Tests: waits for the portfolio read. */
  holdingsWaitMs?: number
}

interface State {
  summary: AwaySummary | null
  then?: HoldingsSnapshot
  sawGap?: boolean
}

function readState(path: string): State {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const summary = record(raw.summary) ? (raw.summary as unknown as AwaySummary) : null
    const then = record(raw.then) ? (raw.then as unknown as HoldingsSnapshot) : undefined
    return { summary: summary && typeof summary.from === "number" && typeof summary.to === "number" ? summary : null, ...(then && Array.isArray(then.wallets) ? { then } : {}), ...(raw.sawGap === true ? { sawGap: true } : {}) }
  } catch {
    return { summary: null }
  }
}

const refusalWords = (o: ToolOutcome): string => {
  if (o.kind === "ok") return "Candle's answer had no fills"
  if (o.kind === "lost") return "Candle didn't answer"
  const body = record(o.body)
  const message = str(body?.message) ?? str(record(body?.error)?.message)
  return message ? `${o.code}: ${message}` : o.code
}

export class AwayDesk {
  private state: State
  private writing: Promise<void> = Promise.resolve()
  private holdingsTimer: ReturnType<typeof setTimeout> | undefined
  /** The summary the reads at start are filling, by id: an older one's late answers are dropped. */
  private filling: string | undefined
  /** The Candle Harness's own live trades, for the summary being filled: what explains a wallet's change. */
  private gapTrades: { id: string; trades: HarnessTrade[] } | undefined

  constructor(private readonly deps: AwayDeps) {
    this.state = readState(deps.statePath)
  }

  view(): AwayView {
    return { summary: this.state.summary, ...(!this.state.summary && !this.state.sawGap ? { firstRun: true as const } : {}) }
  }

  /** The main view closed: what the wallets hold now is "then" for the next summary. */
  closed(): void {
    const snap = this.deps.holdings()
    if (!snap) return
    this.state.then = snap
    this.save()
  }

  /**
   * A main view opened with no other open: the gap since `mark` (undefined before the main view has ever
   * closed) ends now. A gap of AWAY_MIN_GAP_MS or more makes a summary; the reads at start fill it after.
   */
  async opened(clientId: string, mark: number | undefined): Promise<AwaySummary | undefined> {
    const to = this.deps.now()
    if (mark === undefined || to - mark < AWAY_MIN_GAP_MS) return undefined
    const read = await this.deps.rowsSince(mark - LOOKBACK_MS, MAX_ROWS)
    const rows = read.rows
    const r = awayRecords(rows, mark, to, this.deps.symbolOf)
    const firstInGap = rows.find((row) => Date.parse(row.at) > mark)
    const id = `${mark}-${to}-${randomBytes(3).toString("hex")}`
    const cap = <T>(list: T[]) => list.slice(0, LISTED)
    const summary: AwaySummary = {
      id,
      from: mark,
      to,
      madeAt: to,
      forView: clientId,
      coreDown: r.coreDown,
      coreGoneThroughout: r.coreGoneThroughout,
      turns: cap(r.turns),
      trades: cap(r.trades),
      cards: cap(r.cards),
      changes: cap(r.changes),
      stopped: cap(r.stopped),
      triggers: cap(r.triggers),
      bots: withBooks(r.bots, this.deps.bots?.(mark, to) ?? []),
      waitingNow: this.deps.waitingCards(),
      ...(read.cut && firstInGap ? { cut: { from: firstInGap.at } } : read.cut && rows[0] ? { cut: { from: rows[0].at } } : {}),
      pnl: { state: "reading", label: "since last session", usd: null, from: null, short: false, agents: {} },
      outside: { state: "reading", agents: this.deps.agents().map(({ agent }) => ({ agent, state: "reading", fills: [], maybe: [], claimed: 0 })) },
      signals: this.deps.mine ? { state: "reading", count: 0, newest: [] } : { state: "off", count: 0, newest: [], words: "Hacc is off in this Candle Harness's config ([hacc] enabled = false)." },
      holdings: { state: "reading", changes: [] },
      counts: {
        turns: r.turns.length,
        trades: r.trades.length,
        withoutCard: r.trades.filter((t) => t.withoutCard).length,
        cards: r.cards.length,
        expired: [...r.trades, ...r.cards].filter((c) => c.outcome === "expired").length,
        changes: r.changes.length,
        stopped: r.stopped.length,
        triggers: r.triggers.length,
        fired: rows.filter((row) => row.type === "trigger.fired" && Date.parse(row.at) > mark && Date.parse(row.at) <= to).length,
        botTrades: r.bots.reduce((n, b) => n + b.bought + b.sold, 0),
        botHeld: r.bots.reduce((n, b) => n + b.held.length, 0),
        outside: 0,
        maybe: 0,
        signals: 0,
        holdings: 0,
      },
      happened: false,
    }
    // The rows are redacted as written; they're redacted again on the way out, as the Journal's are.
    this.state = { summary: this.finish(this.deps.redactor.value(summary)), ...(this.state.then ? { then: this.state.then } : {}), sawGap: true }
    this.filling = id
    this.changed()
    // The Candle Harness's trades in memory too, older than the rows read, so a fill's id is matched against every one.
    const read_ = new Set(rows.map((row) => row.seq))
    const older = this.deps.memoryRows().filter((row) => !read_.has(row.seq))
    const harness = [...r.harness, ...awayRecords(older, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, this.deps.symbolOf).harness]
    this.gapTrades = { id, trades: harness }
    this.waitHoldings(id)
    await this.deps.ready()
    await Promise.all([this.readPnl(id), this.readFills(id, harness), this.readMine(id)])
    return this.state.summary ?? undefined
  }

  /** A portfolio read landed: the holdings, if a summary waits for them. */
  portfolioRead(): void {
    const s = this.state.summary
    if (!s || s.holdings.state !== "reading" || s.id !== this.filling) return
    const now = this.deps.holdings()
    if (!now || now.readAt === null || now.readAt < s.to) return
    const then = this.state.then
    clearTimeout(this.holdingsTimer)
    if (!then || Math.abs(then.at - s.from) > THEN_SLACK_MS) {
      // Two reasons, said apart (an older build kept no record, and was wrongly told the core had stopped with the view open).
      const words = then
        ? "The Candle Harness didn't see what the wallets held when it closed (the core stopped with the view open), so there's nothing to compare against."
        : "The Candle Harness has no record of what the wallets held when it last closed, so there's nothing to compare against."
      this.update(s.id, (x) => {
        x.holdings = { state: "unknown", changes: [], words }
      })
      return
    }
    // A token the snapshots didn't name is named as the views name it.
    const named = holdingChanges(then, now).map((c) => (c.symbol || c.native || c.asset === "SOL" ? c : { ...c, ...(this.deps.symbolOf(c.asset) ? { symbol: this.deps.symbolOf(c.asset)! } : {}) }))
    // A change no trade this Candle Harness sent explains is said so: other keys pay from a shared wallet.
    const changes = this.gapTrades?.id === s.id ? markOutside(named, this.gapTrades.trades, then.at, now.readAt) : named
    this.update(s.id, (x) => {
      x.holdings = { state: "read", then: then.readAt ?? then.at, changes: changes.slice(0, LISTED) }
      x.counts.holdings = changes.length
    })
  }

  private waitHoldings(id: string): void {
    clearTimeout(this.holdingsTimer)
    this.holdingsTimer = setTimeout(() => {
      this.update(id, (x) => {
        if (x.holdings.state === "reading") x.holdings = { state: "failed", changes: [], words: "Candle's portfolio wasn't read after the Candle Harness opened, so the wallets aren't compared." }
      })
    }, this.deps.holdingsWaitMs ?? HOLDINGS_WAIT_MS)
    this.holdingsTimer.unref?.()
    // A read already newer than the attach (a second view's) counts.
    this.portfolioRead()
  }

  private async readPnl(id: string): Promise<void> {
    try {
      await this.deps.readPnl()
      const s = this.state.summary
      if (!s || s.id !== id) return
      const f = this.deps.pnlFigure(s.from, "since last session")
      const failed = this.deps.agents().flatMap(({ agent }) => {
        const why = this.deps.pnlFailed(agent)
        return why ? [`${agent}: ${why}`] : []
      })
      this.update(id, (x) => {
        x.pnl = {
          state: f.usd === null && failed.length ? "failed" : "read",
          label: f.label,
          usd: f.usd,
          from: f.from,
          short: f.short,
          agents: Object.fromEntries(Object.entries(f.agents).map(([a, v]) => [a, { usd: v.usd, from: v.from }])),
          ...(failed.length ? { words: `Candle's P&L didn't answer for ${failed.join("; ")}` } : f.usd === null ? { words: "No P&L sample in the gap yet." } : {}),
        }
      })
    } catch (e) {
      this.update(id, (x) => {
        x.pnl = { ...x.pnl, state: "failed", words: `P&L wasn't read: ${e instanceof Error ? e.message : String(e)}` }
      })
    }
  }

  private async readFills(id: string, harness: HarnessTrade[]): Promise<void> {
    await Promise.all(
      this.deps.agents().map(async ({ agent, prefix }) => {
        let one: AgentFills
        try {
          const outcome = await this.deps.fills(agent, prefix)
          const s = this.state.summary
          const read = outcome.kind === "ok" && s ? outsideFills(outcome.result, agent, s.from, harness, this.deps.symbolOf) : undefined
          one = read ? { ...read, state: "read" } : { agent, state: "failed", words: refusalWords(outcome), fills: [], maybe: [], claimed: 0 }
        } catch (e) {
          one = { agent, state: "failed", words: e instanceof Error ? e.message : String(e), fills: [], maybe: [], claimed: 0 }
        }
        this.update(id, (x) => {
          x.outside.agents = x.outside.agents.map((a) => (a.agent === agent ? one : a))
          if (!x.outside.agents.some((a) => a.agent === agent)) x.outside.agents.push(one)
          x.outside.state = x.outside.agents.some((a) => a.state === "reading") ? "reading" : x.outside.agents.every((a) => a.state === "failed") && x.outside.agents.length ? "failed" : "read"
          x.counts.outside = x.outside.agents.reduce((n, a) => n + a.fills.length, 0)
          x.counts.maybe = x.outside.agents.reduce((n, a) => n + a.maybe.length, 0)
        })
      }),
    )
    // No agent at all: nothing to read.
    this.update(id, (x) => {
      if (x.outside.agents.length === 0) x.outside.state = "read"
    })
  }

  private async readMine(id: string): Promise<void> {
    const s = this.state.summary
    if (!s || !this.deps.mine) return
    const rows: SignalRow[] = []
    const seen = new Set<number>()
    // No cursor of our own: the first page is Hacc's, then its `next_after`, and rows are kept by their date.
    let after: string | undefined
    let more = false
    try {
      for (let page = 0; page < MINE_PAGES; page++) {
        const answer = await this.deps.mine(after)
        if (!answer) {
          this.update(id, (x) => {
            x.signals = { state: "off", count: 0, newest: [], words: "Hacc is off in this Candle Harness's config ([hacc] enabled = false)." }
          })
          return
        }
        if (answer.kind !== "ok") {
          const state = answer.code === "PLAN_REQUIRED" ? "needs-plan" : answer.code === "HACC_NO_KEY" || answer.code === "HACC_KEY_REFUSED" ? "no-key" : "failed"
          const words = state === "needs-plan" ? `Personal signals need Pro or Max (${answer.message})` : answer.message
          this.update(id, (x) => {
            x.signals = { state, count: 0, newest: [], words }
          })
          return
        }
        const body = record(answer.body)
        const got = (Array.isArray(body?.signals) ? body.signals : []).map(cleanRow).filter((r): r is SignalRow => r !== undefined)
        for (const r of got) if (!seen.has(r.id) && Date.parse(r.created_at) >= s.from && Date.parse(r.created_at) <= s.to) {
          seen.add(r.id)
          rows.push(r)
        }
        const next = haccCursor(body?.next_after)
        if (got.length < MINE_PAGE || !next || next === after) break
        after = next
        if (page === MINE_PAGES - 1) more = true
      }
    } catch (e) {
      this.update(id, (x) => {
        x.signals = { state: "failed", count: 0, newest: [], words: e instanceof Error ? e.message : String(e) }
      })
      return
    }
    rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    this.update(id, (x) => {
      x.signals = { state: "read", count: rows.length, newest: rows.slice(0, MINE_NEWEST), ...(more ? { more: true as const } : {}) }
      x.counts.signals = rows.length
    })
  }

  /** Changes the summary `id` if it's still the one kept, then saves and publishes it. */
  private update(id: string, change: (s: AwaySummary) => void): void {
    const s = this.state.summary
    if (!s || s.id !== id) return
    change(s)
    this.state.summary = this.finish(this.deps.redactor.value(s))
    this.changed()
  }

  private finish(s: AwaySummary): AwaySummary {
    const c = s.counts
    s.happened = c.turns + c.trades + c.cards + c.changes + c.stopped + (c.triggers ?? 0) + (c.botTrades ?? 0) + (c.botHeld ?? 0) + c.outside + c.maybe + c.signals + c.holdings > 0
    return s
  }

  private changed(): void {
    this.save()
    this.deps.publish(this.view())
  }

  private save(): void {
    const body = `${JSON.stringify(this.state)}\n`
    const path = this.deps.statePath
    this.writing = this.writing
      .then(async () => {
        const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
        await writeFile(temp, body, { mode: 0o600, flag: "wx" })
        await chmod(temp, 0o600)
        await rename(temp, path)
      })
      .catch(() => {})
  }

  /** Waits for the writes so far. */
  flush(): Promise<void> {
    return this.writing
  }

  stop(): void {
    clearTimeout(this.holdingsTimer)
  }
}
