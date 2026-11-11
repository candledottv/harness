// The Journal's query: everything the core recorded, in words, searched
// over the whole file, newest first, a page at a time. View only (`journal.query`, `journal.rows`): an
// agent reads its own record with harness_history.
//
//   - One entry for each card's life: its proposal, approval and how, operation and how it ended, with how
//     long it took, folded by its card and operation ids. One for each agent turn, by its turn id. Every
//     other row is an entry of its own, in Activity's words (trade-log.ts) where Activity says it.
//   - Each row type's kind is a table (ROW_KINDS), which the kind chips filter by; a test fails on a row
//     type the code writes and the table doesn't name. The core's own rows are a kind like any other.
//   - Rows memory holds in an unbroken run come from memory, and older ones from the file, read backwards
//     in slices with a turn of the event loop between them, so a search over 200,000 rows never holds up a
//     key press (the bench beside the trade path's).
//   - A page stops at `limit` entries or 64 KB. Its `more` is where the next page resumes: the oldest entry
//     sent, and the cards whose later rows the scan has seen but not yet their proposal, so a card's life
//     that straddles two pages comes whole on the second and nothing comes twice.
//   - What leaves passes the redactor again: rows on disk were redacted when written, but a file can hold
//     rows from before a key was known.
import { ranWithoutCard } from "../shared/approved-how"
import { open } from "node:fs/promises"
import type { Redactor } from "../shared/redact"
import { baseAssetForMint } from "./assets"
import { settingWords, type WalletSetting } from "./autonomy"
import { type JournalRow, parseRow } from "./journal"
import { usd } from "./limits"
import { cardTitle, doneWord, notFollowedFurther, PAPER_CLOSED_WORDS, paneResult, shortAddresses, TradeLog, withdrawnWhy } from "./trade-log"
import { short } from "./wallet-names"
import { type ChainSlug, maybeChain, storedChain } from "../shared/chains"

/** The kind chips: trades, cards, the kill switch, Hacc, memory, agents, rules bots, the view and the core. */
export const JOURNAL_KINDS = ["trades", "cards", "kill", "hacc", "memory", "agents", "bots", "view", "core"] as const
export type JournalKind = (typeof JOURNAL_KINDS)[number]

/** Each kind as its chip says it. */
export const KIND_WORDS: Record<JournalKind, string> = { trades: "trades", cards: "cards", kill: "kill switch", hacc: "Hacc", memory: "memory", agents: "agents", bots: "bots", view: "view", core: "core" }

/** The kinds on by default: all but the core's own rows. */
export const DEFAULT_KINDS: readonly JournalKind[] = JOURNAL_KINDS.filter((k) => k !== "core")

/**
 * Each row type the core writes, and its kind. `life`: it folds into a card's life, whose kind is trades for
 * a trade or swap and cards otherwise. `turn`: it folds into an agent's turn. `tool`: a refusal, trades for
 * a trade or swap tool and cards otherwise. A rules bot's card, paper trade or refusal is the bots kind: a busy bot
 * trades dozens of times a day, which would bury your own trades.
 */
export const ROW_KINDS: Readonly<Record<string, JournalKind | "life" | "turn" | "tool">> = {
  "card.created": "life",
  "card.approved": "life",
  "card.rejected": "life",
  "card.withdrawn": "life",
  "card.expired": "life",
  "card.because": "life",
  "card.valued": "life",
  "approval.refused": "life",
  "operation.submitting": "life",
  "operation.waiting": "life",
  "operation.pending": "life",
  "operation.succeeded": "life",
  "operation.failed": "life",
  "operation.refused": "life",
  "operation.unknown": "life",
  "operation.abandoned": "life",
  "operation.check": "life",
  "operation.resend": "life",
  "operation.resend_refused": "life",
  "pane.redeemed": "life",
  "pane.usage": "life",
  "pane.factor_added": "life",
  "card.refused": "tool",
  "tool.refused": "tool",
  "paper.call": "trades",
  "mode.changed": "trades",
  "cli.refused": "cards",
  "cli.typed": "cards",
  "cli.typed_result": "cards",
  "cli.updated": "cards",
  "agent.key_not_stored": "cards",
  "autonomy.set": "cards",
  "trigger.saved": "agents",
  "trigger.changed": "agents",
  "trigger.removed": "agents",
  "trigger.held": "agents",
  "trigger.released": "agents",
  "trigger.fired": "agents",
  "trigger.missed": "agents",
  "trigger.skipped": "agents",
  "trigger.waiting": "agents",
  "trigger.notify": "agents",
  "trigger.ran": "agents",
  "trigger.run_now": "agents",
  "trigger.woke": "agents",
  "trigger.wake_skipped": "agents",
  "bot.saved": "bots",
  "bot.changed": "bots",
  "bot.paused": "bots",
  "bot.resumed": "bots",
  "bot.stopped": "bots",
  "bot.removed": "bots",
  "bot.held": "bots",
  "bot.released": "bots",
  "bot.token": "bots",
  "bot.test": "bots",
  "build.session": "bots",
  "bot.entering": "bots",
  "bot.waiting": "bots",
  "bot.entry_ended": "bots",
  "bot.skipped": "bots",
  "bot.exiting": "bots",
  "bot.exit_waiting": "bots",
  "bot.exit_ended": "bots",
  "bot.exit_held": "bots",
  "bot.position_left": "bots",
  "bot.request": "bots",
  "bot.request_waiting": "bots",
  "bot.request_ended": "bots",
  "bot.refused": "bots",
  "bot.exits_set": "bots",
  "bot.process": "bots",
  "bot.event": "bots",
  "kill.on": "kill",
  "kill.off": "kill",
  "kill.report": "kill",
  "hacc.change": "hacc",
  "hacc.replay": "hacc",
  "memory.change": "memory",
  "agent.turn_started": "turn",
  "agent.turn": "turn",
  "agent.turn_failed": "turn",
  "agent.message_refused": "agents",
  "agent.stop_asked": "agents",
  "agent.leftovers": "agents",
  "agent.fetch": "agents",
  "agent.added": "agents",
  "engine.chosen": "agents",
  "preset.chosen": "agents",
  "research.run": "agents",
  "tools.run": "agents",
  "skills.folder": "agents",
  "view.changed": "view",
  "view.decided": "view",
  "view.set": "view",
  "view.picked": "view",
  "wallets.shown": "view",
  "wallets.named": "agents",
  "wallets.name.refused": "agents",
  "wallets.grouped": "agents",
  "wallets.group.refused": "agents",
  "pnl.window": "view",
  "agent.active": "view",
  "core.started": "core",
  "core.stopped": "core",
  "core.bug": "core",
  "core.keep_awake": "core",
  "notify.sent": "core",
  "notify.failed": "core",
  "client.attached": "core",
  "client.detached": "core",
  "client.refused": "core",
  "client.dropped": "core",
  "send.oversize": "core",
  "call.forbidden": "core",
  "candle.start_failed": "core",
  "candle.unclassified_tools": "core",
  "engine.homes_recovered": "core",
  "engine.newer_major": "core",
  "harness.registered": "core",
  "journal.torn_tail": "core",
  "hacc.stream": "core",
  "pane.spawned": "core",
  "vault.seen": "core",
  "vault.forgotten": "core",
  "onboarding.changed": "core",
  "onboarding.profile": "core",
  "onboarding.profile_host": "core",
  "onboarding.harness": "core",
  "onboarding.harness_ended": "core",
  "onboarding.tested": "core",
  "onboarding.limits": "core",
}

export interface JournalQuery {
  /** Words that must all appear in an entry, in any case: its words, agent, token, and a turn's messages. */
  text?: string
  kinds?: readonly JournalKind[]
  agent?: string
  /** A token's mint: only entries about it. */
  mint?: string
  /** One chain: only entries about a token on it, and those about no token. */
  chain?: ChainSlug
  /** Times in ms: only entries that start within them. */
  from?: number
  to?: number
  /** A page's `more`: the next page from where it stopped. */
  before?: string
  limit?: number
}

export interface JournalEntry {
  /** Its first row's seq, as a string: the view's key for it. */
  id: string
  seq: number
  /** When it started, and its last row. */
  at: string
  last: string
  kind: JournalKind
  mode: "paper" | "live"
  agent?: string
  /** The token it's about, where it's one the token pane follows. */
  mint?: string
  /** That token's chain, as its rows recorded it (an old row's, by the address). */
  chain?: ChainSlug
  symbol?: string
  text: string
  tone: "info" | "good" | "bad" | "warn"
  /**
   * Where a search matched that the words don't show, and a little of it: "its reply: …a stake of…". Without
   * it, rows listed for "stake" whose words don't say it have nothing to say why.
   */
  matched?: string
  /** Its rows, oldest first, for `journal.rows` (ctrl-o). */
  seqs: number[]
}

export interface JournalPage {
  entries: JournalEntry[]
  /** Where the next page resumes; absent once the scan reached the journal's start (or `from`). */
  more?: string
  /** Rows read for this page. */
  scanned: number
  /** The time of the oldest row read, so a search that found nothing says how far back it looked. */
  oldest?: string
  /** A newer query from the same view replaced this one before it finished. */
  superseded?: true
}

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100
/** A page's answer at most (the plan's 64 KB). */
export const PAGE_BYTES = 64 * 1024
/** An entry's words at most. */
const TEXT_CHARS = 400
/** A file slice read at a time, between turns of the event loop. */
export const SLICE_BYTES = 128 * 1024
/** A card whose proposal hasn't turned up this many rows below its newest row is its own entry (a row from before its card, or damage). */
const ORPHAN_ROWS = 5_000
/** What `journal.rows` sends at most. */
const ROWS_BYTES = 128 * 1024

interface Group {
  keys: Set<string>
  /** Newest first, as scanned. */
  rows: JournalRow[]
  newest: number
  /** Where each of its rows from the file starts and ends, by seq. */
  at: Map<number, { start: number; end: number }>
}

/** A row and where it ends in the file (undefined for one from memory). */
interface Scanned {
  row: JournalRow
  start?: number
  end?: number
}

interface Cursor {
  /** The oldest entry sent: only entries before it. */
  b: number
  /** Resume at rows with seq at most this. */
  f: number
  /** The file offset just after row `f`, where it's older than memory's run. */
  o?: number
  /** The keys of cards still waiting for their proposal: their rows newer than `b` are read again. */
  k: string[]
}

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url")
}

function decodeCursor(text: unknown): Cursor | undefined {
  if (typeof text !== "string" || text.length > 4096) return undefined
  try {
    const c = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<Cursor>
    if (!Number.isInteger(c.b) || !Number.isInteger(c.f) || !Array.isArray(c.k) || (c.o !== undefined && !Number.isInteger(c.o))) return undefined
    return { b: c.b!, f: c.f!, ...(c.o !== undefined ? { o: c.o } : {}), k: c.k.filter((k): k is string => typeof k === "string") }
  } catch {
    return undefined
  }
}

/** A row's keys: a card's life by its card and operation ids, a turn by its turn id; none for a row of its own. */
export function keysOf(row: JournalRow): string[] {
  const kind = ROW_KINDS[row.type]
  if (kind === "life") return [...(str(row.cardId) ? [`c:${row.cardId}`] : []), ...(str(row.opId) ? [`o:${row.opId}`] : [])]
  if (kind === "turn") return str(row.turnId) ? [`t:${row.turnId}`] : []
  return []
}

/**
 * A row of a card's life: one of its types, naming its card or operation. A harness's own sign-in pane is
 * redeemed with neither (it has no card), and read as a card it showed as one "from before this journal's start".
 */
export const isLifeRow = (row: JournalRow) => ROW_KINDS[row.type] === "life" && keysOf(row).length > 0

/** The row that starts a group: a card's proposal, a turn's start. */
export const isAnchor = (row: JournalRow) => row.type === "card.created" || row.type === "agent.turn_started"

/** Rows newest first, from memory's unbroken run and then the file backwards from where that run begins, a batch at a time. */
async function* rowsBackward(input: { memory: readonly JournalRow[]; tail: { seq: number; offset: number }; path: string; from?: number; offset?: number; slice?: number }): AsyncGenerator<Scanned[]> {
  const { memory, tail } = input
  const from = input.from ?? Number.POSITIVE_INFINITY
  if (from >= tail.seq) {
    // Memory's run: the rows from the tail on (older unsettled rows memory keeps are read from the file).
    let i = memory.length - 1
    while (i >= 0 && memory[i]!.seq > from) i--
    const batch: Scanned[] = []
    for (; i >= 0 && memory[i]!.seq >= tail.seq; i--) batch.push({ row: memory[i]! })
    if (batch.length) yield batch
  }
  let end = from >= tail.seq ? tail.offset : (input.offset ?? tail.offset)
  if (end <= 0) return
  const slice = input.slice ?? SLICE_BYTES
  const handle = await open(input.path, "r")
  try {
    let carry: Buffer = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - slice)
      const buf = Buffer.alloc(end - start)
      await handle.read(buf, 0, buf.length, start)
      const joined = carry.length ? Buffer.concat([buf, carry]) : buf
      const batch: Scanned[] = []
      let lineEnd = joined.length
      // Lines from the last to the first; the first is whole only at the file's start.
      for (let i = joined.length - 1; i >= -1; i--) {
        if (i >= 0 && joined[i] !== 0x0a) continue
        if (i < 0 && start > 0) break
        const lineStart = i + 1
        if (lineEnd > lineStart) {
          const row = parseRow(joined.toString("utf8", lineStart, lineEnd))
          if (row && row.seq <= from) batch.push({ row, start: start + lineStart, end: start + lineEnd + 1 })
        }
        lineEnd = i
      }
      carry = start > 0 ? joined.subarray(0, lineEnd < 0 ? 0 : lineEnd) : Buffer.alloc(0)
      end = start
      if (batch.length) yield batch
      // A turn of the event loop between slices: a key press, an approval, goes first.
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    await handle.close()
  }
}

/** One row's words in Activity's, where Activity says it. */
function activityWords(row: JournalRow, symbolOf: (mint: string) => string | undefined): { text: string; tone: JournalEntry["tone"]; mint?: string } | undefined {
  const log = new TradeLog({ symbolOf })
  log.add(row)
  const line = log.activity()[0]
  return line ? { text: line.text, tone: line.tone, ...(line.mint ? { mint: line.mint } : {}) } : undefined
}

const HOW: Record<string, string> = { enter: "approved by Enter", click: "approved by a click", instant: "sent at once (typed cards run instantly)", typed: "typed", view: "approved", "inside-limits": "without a card, inside its wallet's limits", "bot-exit": "without a card, as its bot's exit" }

/** "4.3 s", "2m 05s", "3h 10m"; "under 0.1 s". */
export function tookWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 100) return "under 0.1 s"
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
}

const errorWords = (row: JournalRow) => {
  const e = record(row.error)
  return [e?.code, e?.message].filter((p): p is string => typeof p === "string" && p.length > 0).join(": ")
}

const TRADE_TOOLS = new Set(["candle_trade", "candle_swap"])
const isTrade = (row: JournalRow | undefined) => !!row && (row.kind === "trade" || row.kind === "swap" || TRADE_TOOLS.has(String(row.tool)))

interface Built {
  text: string
  tone: JournalEntry["tone"]
  kind: JournalKind
  mint?: string
  /** What's searched beyond the words. */
  hay: string
  /** The same, by where it's from, to say why a search matched. */
  hidden?: { where: string; text: string | undefined }[]
}

/** Where the first search word the entry's words don't show was found, with the words around it. */
export function matchedWhy(visible: string, hidden: readonly { where: string; text: string | undefined }[], words: readonly string[]): string | undefined {
  const shown = visible.toLowerCase()
  const word = words.find((w) => !shown.includes(w))
  if (word === undefined) return undefined
  for (const h of hidden) {
    const text = h.text?.replace(/\s+/g, " ")
    const at = text?.toLowerCase().indexOf(word) ?? -1
    if (!text || at < 0) continue
    // About 24 characters either side, to a whole word.
    const before = at > 24 ? text.lastIndexOf(" ", at - 24) : -1
    const from = before < 0 ? 0 : before + 1
    const after = text.indexOf(" ", at + word.length + 24)
    const to = after < 0 ? text.length : after
    return `${h.where}: ${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`
  }
  return undefined
}

/** A card's life, oldest row first, in one line: who proposed what, how it was approved, how it ended and how long it took. */
function cardLife(rows: readonly JournalRow[], symbolOf: (mint: string) => string | undefined): Built {
  const created = rows.find((r) => r.type === "card.created")
  const kind: JournalKind = typeof created?.bot === "string" ? "bots" : isTrade(created) || isTrade(rows.find((r) => r.type === "operation.submitting")) ? "trades" : "cards"
  const title = created ? cardTitle(created) : "a card from before this journal's start"
  const params = record(created?.params)
  const named = str(created?.mint) ?? str(params?.mint)
  const mint = named && !baseAssetForMint(named) ? named : undefined
  const said = created ? (activityWords(created, symbolOf)?.text ?? `you ran ${title}`) : title
  // A code bot's trade says it's a code bot's, and the request id its own code gave it, to find in its log.
  const code = created?.botKind === "code"
  const head = code ? said.replace(/^the bot "/, 'the code bot "') : said
  const parts = [head]
  if (code && str(created?.botRequest)) parts.push(`its request ${String(created!.botRequest)}`)
  const approved = rows.find((r) => r.type === "card.approved")
  // Why a trade from a wallet that trades inside limits was a card: its figure, in the card's words.
  const because = str(rows.findLast((r) => r.type === "card.because")?.words)
  if (because && !ranWithoutCard(approved?.how)) parts.push(`a card: ${because}`)
  if (approved && approved.how !== "typed") parts.push(HOW[String(approved.how)] ?? "approved")
  const resends = rows.filter((r) => r.type === "operation.resend")
  // The core re-sends only a bot's exit a restart cut off, once: said, so it never reads as the person's.
  if (resends.some((r) => r.by === "core")) parts.push("re-sent by the Candle Harness once: the core restarted mid-sell and Candle had no record of it")
  else if (resends.length > 0) parts.push("re-sent")
  // An unpriced buy or swap, valued once it filled so the day counts it.
  const valued = rows.find((r) => r.type === "card.valued")
  if (typeof valued?.usd === "number") parts.push(`no price when proposed, counted as ${usd(valued.usd)} once it filled`)
  // How it ended: the last of the card's closes and its operation's states.
  const ends = rows.filter((r) => r.type.startsWith("card.") ? ["card.rejected", "card.withdrawn", "card.expired"].includes(r.type) : r.type.startsWith("operation.") && !["operation.check", "operation.resend", "operation.resend_refused"].includes(r.type))
  const end = ends.at(-1)
  // An operation's time runs from the press (the trade's own speed); a card's close from its proposal.
  const since = (row: JournalRow, from = created) => (from ? Date.parse(row.at) - Date.parse(from.at) : Number.NaN)
  const took = (row: JournalRow, word: "in" | "after") => {
    const words = tookWords(since(row, row.type.startsWith("operation.") ? (approved ?? created) : created))
    return words ? ` ${word} ${words}` : ""
  }
  let tone: JournalEntry["tone"] = "info"
  const pane = end ? paneResult(end) : undefined
  if (pane) {
    parts.push(pane)
    tone = end!.type === "operation.succeeded" ? "good" : end!.type === "operation.unknown" ? "warn" : "bad"
  } else if (!end) {
    const refusal = rows.findLast((r) => r.type === "approval.refused")
    if (refusal) {
      parts.push(`approval refused: ${String(refusal.code)}`)
      tone = "bad"
    } else parts.push(approved ? "approved, not sent yet" : "awaiting approval")
  } else {
    switch (end.type) {
      case "operation.succeeded":
        if (end.paper === true) {
          parts.push(PAPER_CLOSED_WORDS)
          tone = "warn"
          break
        }
        parts.push(`${doneWord(str(created?.kind))}${took(end, "in")}`)
        tone = "good"
        break
      case "operation.failed":
      case "operation.refused": {
        const said = errorWords(end)
        // A swap whose first leg landed: part done, never plainly failed.
        const partDone = end.type === "operation.failed" && typeof record(end.partial)?.leg1 === "string"
        parts.push(`${end.type === "operation.refused" ? "refused" : partDone ? "part done: the first leg went, the second failed" : "failed"}${said ? `: ${said}` : ""}`)
        tone = partDone ? "warn" : "bad"
        break
      }
      case "operation.unknown": {
        // One the core reads no further says why and where to look, never that it's being read back.
        const error = end.error as { message?: unknown } | undefined
        const ended = notFollowedFurther({ kind: str(created?.kind), error: end.error, result: end.result }) && typeof error?.message === "string"
        parts.push(ended ? String(error!.message) : "no answer: being read back")
        tone = "warn"
        break
      }
      case "operation.abandoned":
        parts.push(`abandoned${took(end, "after")}`)
        tone = "warn"
        break
      case "operation.submitting":
      case "operation.pending":
        parts.push("sent, no answer yet")
        break
      case "operation.waiting":
        parts.push("waiting for the wallet's last trade")
        break
      case "card.rejected":
        parts.push(`rejected${took(end, "after")}`)
        break
      case "card.withdrawn": {
        const why = withdrawnWhy(end)
        parts.push(`withdrawn${why ? ` (${why})` : ""}`)
        tone = "warn"
        break
      }
      case "card.expired":
        parts.push("expired, never ran")
        break
    }
  }
  const hay = [title, str(created?.title), str(created?.tool), str(created?.kind), mint, ...rows.map(errorWords)].filter(Boolean).join(" ")
  const hidden = [
    { where: "its card", text: [title, str(created?.title)].filter(Boolean).join(" · ") },
    { where: "its tool", text: [str(created?.tool), str(created?.kind)].filter(Boolean).join(" ") },
    { where: "its token", text: mint },
    { where: "its error", text: rows.map(errorWords).filter(Boolean).join("; ") },
  ]
  return { text: parts.join(" · "), tone, kind, ...(mint ? { mint } : {}), hay, hidden }
}

const OUTCOME: Record<string, string> = { done: "answered", stopped: "stopped at its step cap", cancelled: "stopped", error: "ended with an error" }

/** An agent's turn: what the person asked, how it ended and how long it took, and the tools it called. */
function turnLife(rows: readonly JournalRow[]): Built {
  const started = rows.find((r) => r.type === "agent.turn_started")
  const turn = rows.find((r) => r.type === "agent.turn")
  const failed = rows.find((r) => r.type === "agent.turn_failed")
  const agent = rows.find((r) => r.agent)?.agent ?? "the agent"
  const user = str(turn?.user)
  // Addresses in what you asked show short, as replies show them, so the quote keeps its words.
  // A turn a trigger woke has no words of the person's: it names the triggers, then what fired.
  const woken = Array.isArray(turn?.woken) ? turn.woken.map(String) : Array.isArray(started?.woken) ? started.woken.map(String) : []
  const quote = user ? `"${clip(shortAddresses(user.replace(/\s+/g, " ")), 80)}"` : ""
  const outside = turn?.outside === true || started?.outside === true ? " from outside" : ""
  const parts = [woken.length ? `${woken.map((w) => `trigger "${w}"`).join(", ")} woke ${agent}` : user ? `you asked ${agent}${outside}: ${quote}` : `${agent}'s turn`]
  let tone: JournalEntry["tone"] = "info"
  const last = turn ?? failed
  const took = started && last ? tookWords(Date.parse(last.at) - Date.parse(started.at)) : ""
  if (turn) {
    const outcome = String(turn.outcome)
    parts.push(`${OUTCOME[outcome] ?? outcome}${took ? ` in ${took}` : ""}`)
    if (outcome === "error") tone = "bad"
    const tools = Array.isArray(turn.tools) ? turn.tools.length : 0
    if (tools) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`)
    const marked = Array.isArray(turn.marked) ? turn.marked.length : 0
    if (marked) parts.push(`${marked} figure${marked === 1 ? "" : "s"} marked ?`)
  } else if (failed) {
    parts.push(`failed: ${clip(String(failed.error), 160)}`)
    tone = "bad"
  } else parts.push("running")
  const reply = str(turn?.reply)?.slice(0, 4000)
  const tools = Array.isArray(turn?.tools) ? turn.tools.map(String) : []
  const hay = [user, reply, ...tools, str(started?.engine), str(started?.model)].filter(Boolean).join(" ")
  const hidden = [
    { where: woken.length ? "what woke it" : "what you asked", text: user },
    { where: "its reply", text: reply },
    { where: "its tools", text: tools.join(", ") },
    { where: "its engine", text: [str(started?.engine), str(started?.model)].filter(Boolean).join(" · ") },
  ]
  return { text: parts.join(" · "), tone, kind: "agents", hay, hidden }
}

const STREAM: Record<string, string> = { opened: "opened", full: "is full on Hacc", key_refused: "was refused the key", dropped: "dropped", gap: "has a gap it couldn't read back", filled: "read back what it missed", closed: "closed", read_back: "read a filter back" }

/** Words for the rows Activity doesn't say. */
function ownWords(row: JournalRow): string {
  const agent = row.agent ?? "the agent"
  switch (row.type) {
    case "core.started":
      return `the core started in ${row.mode} mode${str(row.coreVersion) ? `, version ${row.coreVersion}` : ""}${Array.isArray(row.agents) ? `, with ${row.agents.join(", ") || "no agents"}` : ""}`
    case "core.stopped":
      return `the core stopped${str(row.reason) ? `: ${row.reason}` : ""}`
    case "core.bug":
      return `a bug in the Candle Harness: ${String(row.what ?? "")}`
    case "client.attached":
      return `a ${String(row.role)} attached${str(row.clientName) && row.clientName !== row.role ? ` (${row.clientName})` : ""}`
    case "client.detached":
      return `a ${String(row.role)} detached`
    case "client.dropped":
      return `dropped a ${str(row.role) ?? "client"} that had stopped reading${str(row.clientName) && row.clientName !== row.role ? ` (${row.clientName})` : ""}: it reattaches when it's back`
    case "send.oversize":
      return `left out a ${String(row.topic)} message too large to send to a ${String(row.role)}`
    case "client.refused":
      return `refused a connection: ${String(row.reason ?? row.code ?? "")}`
    case "call.forbidden":
      return `refused a ${String(row.role)}'s ${String(row.method)}${str(row.topic) ? ` of ${row.topic}` : ""}`
    case "candle.start_failed":
      return `${agent}'s Candle connection didn't start: ${clip(String(row.error), 160)}`
    case "candle.unclassified_tools":
      return `Candle offers ${agent} tools the Candle Harness doesn't know: ${Array.isArray(row.tools) ? row.tools.join(", ") : ""}`
    case "engine.newer_major":
      return `${String(row.label ?? row.engine)} is ${String(row.version)}, a newer major version than the one its holds were checked on (${String(row.checked)})`
    case "engine.homes_recovered":
      return `recovered ${Array.isArray(row.removed) ? row.removed.length : 0} engine homes left by a crash`
    case "harness.registered":
      return `a harness registered for ${agent}`
    case "journal.torn_tail":
      return `the journal's last line was cut off when the core started (${String(row.skipped)} skipped)`
    case "hacc.stream":
      return `Hacc's signal stream ${STREAM[String(row.event)] ?? String(row.event)}${row.agent ? ` (${row.agent}'s key)` : ""}`
    case "pane.spawned":
      return "a prompt pane opened"
    case "vault.seen":
      return "the Candle Harness saw this machine's vault: owner steps take your factor from now on"
    case "onboarding.changed":
      if (row.change === "finished") return "setup finished: every step done or skipped"
      if (row.paper === true) return "setup: you started on paper"
      return str(row.step) ? `setup: you went past ${row.step}` : `setup: you chose ${String(row.change)}`
    case "onboarding.limits":
      return `setup: ${String(row.agent)}'s Candle Harness limits set to $${String(row.perTradeUsd)} a trade and $${String(row.perDayUsd)} a day`
    case "onboarding.profile":
      return `setup: the Candle Harness acts as the Candle profile ${String(row.profile)} from now on`
    case "onboarding.profile_host":
      return `setup: the profile ${String(row.profile)} is signed in again with a host other than Candle's production API`
    case "onboarding.harness":
      return `setup: ${String(row.engine)}'s own sign-in opened in a pane`
    case "pane.redeemed":
      if (str(row.harness)) return `setup: ${String(row.harness)}'s sign-in pane started`
      return row.type.replace(/[._]/g, " ")
    case "onboarding.harness_ended":
      return `setup: ${String(row.engine)}'s sign-in ${row.exit === 0 ? "finished" : row.stopped ? "was stopped" : "didn't finish"}`
    case "onboarding.tested":
      return `setup: the test message ${row.ok === true ? "answered" : "didn't answer"} on ${String(row.engine)}${str(row.model) ? ` · ${String(row.model)}` : ""}`
    case "vault.forgotten":
      return "you told the Candle Harness this machine's vault is gone on purpose: owner steps run without a factor until there's one again"
    case "kill.report":
      return row.again === true ? "the kill switch was pressed again: its report, read again" : "the kill switch's report"
    case "agent.message_refused":
      return `refused a message to ${agent}: it held something like a key or secret`
    case "agent.stop_asked":
      return `you asked ${agent} to stop its turn`
    case "agent.added":
      return `${agent} was added${str(row.keyPrefix) ? ` with key ${row.keyPrefix}` : ""}`
    case "agent.key_not_stored":
      return `a key was made but not stored: revoke ${Array.isArray(row.keyPrefixes) ? row.keyPrefixes.join(", ") : "it"}`
    case "agent.active":
      return `${agent} is the active agent`
    case "preset.chosen":
      return `${agent} now on the ${String(row.preset)} preset`
    case "notify.sent":
      return `the core sent a notification${Array.isArray(row.kinds) ? ` (${row.kinds.map(String).join(", ")})` : ""}, since no Candle Harness window was open`
    case "notify.failed":
      return `the core couldn't show a notification on this machine: ${String(row.via ?? "")} ${row.exitCode === -1 ? "didn't start" : `exited ${String(row.exitCode)}`}${str(row.error) ? ` (${clip(String(row.error), 120)})` : ""}`
    case "core.keep_awake":
      return row.on ? "the Mac is kept awake while a trigger or bot is on" : "keep-awake is off: the Mac may sleep while triggers or bots are on"
    case "skills.folder":
      return row.on ? `the agents now use the skills in ${String(row.folder)}` : `the agents no longer use the skills in ${String(row.folder)}`
    case "pnl.window":
      return `the P&L window is now ${String(row.window)}`
    case "view.set":
      return str(row.words) ? `you ${row.words}` : "you changed the view"
    case "view.picked":
      return `you picked ${str(row.symbol) ?? (str(row.mint) ? short(String(row.mint)) : "a token")}${str(row.from) ? ` (${row.from})` : ""}`
    case "wallets.named": {
      // Naming wallets: the Candle Harness's own names, written at once, and their undo.
      const names = Array.isArray(row.names) ? (row.names as { address?: unknown; name?: unknown; was?: unknown }[]) : []
      const words = names.map((n) => `${str(n.was) ?? (str(n.address) ? short(String(n.address)) : "a wallet")} → ${str(n.name) ?? short(String(n.address ?? ""))}`).join(", ")
      return row.undo ? `you undid a naming: ${words}` : `${str(row.agent) ? `${agent} named` : "you named"} ${words}`
    }
    case "wallets.grouped":
      // Wallet groups: a change to one group, the person's or the agent's, and its undo.
      return row.undo ? `you undid a change to ${str(row.group) ?? "a group"}: ${clip(String(row.words ?? ""), 160)}` : `${str(row.agent) ? `${agent}` : "you"} ${clip(String(row.words ?? `changed ${str(row.group) ?? "a group"}`), 160)}`
    case "wallets.group.refused":
      return `${str(row.agent) ? `${agent}'s change` : "a change"} to ${str(row.group) ?? "a group"} was refused: ${clip(String(row.message ?? ""), 160)}`
    case "wallets.name.refused":
      return `${str(row.agent) ? `${agent}'s naming` : "a naming"} was refused: ${clip(String(row.message ?? ""), 160)}`
    case "wallets.shown":
      return row.show === "all" ? "the panes show every wallet" : typeof row.show === "string" && row.show.startsWith("group:") ? `the panes show the group ${row.show.slice(6)}` : Array.isArray(row.show) ? "the panes show the wallets named" : "the panes show the wallets an agent can pay from"
    case "autonomy.set": {
      // Autonomy per wallet: the person's setting, or the agent's narrowing they approved.
      const name = str(row.walletName) === "embedded" ? "the embedded wallet" : (str(row.walletName) ?? "a wallet")
      const to = row.to as WalletSetting | undefined
      const from = row.from as WalletSetting | undefined
      const who = row.how === "card" ? `${agent}'s card, which you approved,` : "you"
      return `${who} set ${name} to ${to ? settingWords(to).replace(/^asks/, "ask").replace(/^trades/, "trade") : "?"}${from ? ` (it ${pastWords(from)})` : ""}`
    }
    case "trigger.saved":
      return `you approved ${agent}'s trigger "${String(row.name)}": ${clip(String(row.words ?? row.line ?? ""), 200)}`
    case "trigger.changed":
      // An agent narrows one at once, or switches one off; widening it is a card the person approved.
      if (row.how === "agent" && typeof row.hash === "string") return `${String(row.changedBy ?? agent)} narrowed the trigger "${String(row.name)}": ${Array.isArray(row.narrowed) ? row.narrowed.map(String).join("; ") : clip(String(row.words ?? row.line ?? ""), 200)}`
      if (row.how === "agent") return `${String(row.changedBy ?? agent)} switched off the trigger "${String(row.name)}"${Array.isArray(row.sells) && row.sells.length ? `: its sell of ${row.sells.map((m) => short(String(m))).join(", ")} no longer waits` : ""}`
      if (typeof row.hash === "string") return `you approved a change to ${agent}'s trigger "${String(row.name)}": ${clip(String(row.words ?? row.line ?? ""), 200)}`
      return row.on === true ? `you switched the trigger "${String(row.name)}" back on` : `you switched off the trigger "${String(row.name)}"`
    case "trigger.removed":
      return `you removed the trigger "${String(row.name)}"`
    // The plan's hold, naming every trigger; a firing's own rows are in Activity's words.
    case "trigger.held":
    case "trigger.released": {
      // One firing's trade held (the kill switch, Candle's breaker); the plan's hold names every trigger.
      if (row.type === "trigger.held" && typeof row.name === "string") return `the trigger "${row.name}" was held: ${clip(String(row.words ?? row.reason ?? ""), 200)}`
      if (typeof row.name === "string") return `the trigger "${row.name}": ${clip(String(row.words ?? "watching again"), 200)}`
      const names = Array.isArray(row.names) ? row.names.map((n) => `"${String(n)}"`).join(", ") : "triggers"
      return `${row.type === "trigger.held" ? "held" : "back on"}: ${names}, since ${String(row.words ?? "the plan changed")}`
    }
    case "bot.saved":
      return `you approved ${agent}'s ${row.kind === "code" ? "code bot" : "bot"} "${String(row.name)}"${botMode(row)}: ${clip(String(row.words ?? ""), 200)}`
    case "bot.changed": {
      // Narrowed at once from a view, or by a code bot's Build pane; anything wider is a card the person approved.
      if (row.by === "card") return `you approved a change to ${agent}'s ${row.kind === "code" ? "code bot" : "bot"} "${String(row.name)}"${botMode(row)}: ${clip(String(row.words ?? ""), 200)}`
      // The agent's narrowing, and Candle's or the agent's pause, are in Activity's words.
      const who = row.how === "build" ? "the Build tab" : "you"
      return `${who} narrowed the bot "${String(row.name)}": ${Array.isArray(row.narrowed) ? clip(row.narrowed.map(String).join("; "), 200) : clip(String(row.words ?? ""), 200)}`
    }
    case "bot.paused":
      return `${row.how === "build" ? "the Build tab" : "you"} paused the bot "${String(row.name)}": ${row.kind === "code" ? "its buys are refused, its sells still run" : "no new entries, its exits still sell"}`
    case "bot.stopped":
      return `you stopped the bot "${String(row.name)}": ${row.kind === "code" ? "none of its trades run" : "nothing trades"}, and its positions are left to you`
    // A code bot's token: issued when it's handed to the bot, replacing the one before; revoked when the bot is removed,
    // when its process here ends for good, or when one run outside has a new folder or command approved.
    case "bot.token":
      return row.what === "revoked" ? `the bot "${String(row.name)}"'s token was revoked: it no longer connects${row.why === "new_version" ? " (it ran outside the Candle Harness, and a new folder or command was approved)" : typeof row.why === "string" && row.why.startsWith("process_") ? " (its process here ended)" : ""}` : `the bot "${String(row.name)}" was given ${row.what === "renewed" ? "a new token, replacing its last" : "its token"}${row.why === "outside" ? ", to run outside the Candle Harness" : ""}`
    case "bot.resumed":
      return `you put the bot "${String(row.name)}" back on, as it was approved`
    // A Build pane's paper test of a bot's code: never supervised, never live, over within 30 minutes.
    case "bot.test": {
      if (row.what === "started") return `the Build tab started a paper test, "${String(row.name)}", of ${clip(String(row.folder ?? "?"), 120)}`
      const why = { ended: "its command ended", replaced: "a new test replaced it", pane_closed: "its Build pane closed", timed_out: "after 30 minutes", agent_gone: "its agent was removed" }[String(row.why)] ?? String(row.why ?? "")
      return `the paper test "${String(row.name)}" ended: ${why}`
    }
    // A Build pane opened or closed: its token is minted for its agent when it opens, and revoked when it closes.
    case "build.session":
      return row.what === "opened" ? `a Build pane opened for ${String(row.agent ?? "?")}${row.harness ? ` with ${clip(String(row.harness), 60)}` : ""}` : `a Build pane for ${String(row.agent ?? "?")} closed: its token was revoked`
    // A code bot's own requests, each by its id: what it asked for, a card that waits for you, and how one ended.
    case "bot.request":
      return `the code bot "${String(row.name)}" ${clip(String(row.words ?? row.side ?? ""), 200)}`
    case "bot.request_waiting":
    case "bot.request_ended":
      return `the code bot "${String(row.name)}": ${clip(String(row.words ?? ""), 200)}`
    // Exits the core holds on a code bot's position: set or cleared by the bot, or removed by you.
    case "bot.exits_set":
      return `the code bot "${String(row.name)}": ${clip(String(row.words ?? ""), 200)}`
    // A code bot's process, as the supervisor ran it: started with its code's hash, stopped, ended on its own, crashed,
    // given up after too many crashes, or past a figure for memory or CPU.
    case "bot.process": {
      const name = `the code bot "${String(row.name ?? "?")}"`
      const code = row.code as { hash?: unknown; lockfile?: { name?: unknown } } | undefined
      if (row.what === "started") return `${name} started (pid ${String(row.pid ?? "?")})${typeof code?.hash === "string" ? `, its code ${code.hash.slice(0, 12)}${typeof code.lockfile?.name === "string" ? ` with ${code.lockfile.name}` : ""}${(code as { changed?: unknown }).changed === true ? ", changed since its last start" : ""}` : ""}`
      if (row.what === "stopped") return `${name}'s process was stopped: ${clip(String(row.words ?? ""), 200)}`
      if (row.what === "warning") return `${name}: ${clip(String(row.words ?? ""), 200)}`
      if (row.what === "supervisor_failed") return `the code bots' supervisor didn't start: ${clip(String(row.words ?? ""), 200)}`
      return `${name} ${clip(String(row.words ?? row.what ?? ""), 200)}`
    }
    // What a code bot says about itself, one word and a line: a trigger may wait on the word.
    case "bot.event":
      return `the code bot "${String(row.name)}" says "${String(row.word ?? "")}"${str(row.text) ? `: ${clip(String(row.text), 200)}` : ""}`
    case "bot.refused":
      return `the code bot "${String(row.name)}" was refused: ${clip(String(row.words ?? row.code ?? ""), 200)}`
    case "bot.removed":
      return `you removed the bot "${String(row.name)}"${row.positions === "flatten" ? ", selling its positions" : row.positions === "leave" ? ", leaving its positions in the wallet" : ""}`
    // The plan's hold, naming every bot: their exits still sell.
    case "bot.held":
    case "bot.released": {
      const names = Array.isArray(row.names) ? row.names.map((n) => `"${String(n)}"`).join(", ") : "bots"
      if (row.kind === "code") return `${row.type === "bot.held" ? "buys held" : "buying again"}: ${names}, since ${String(row.words ?? "the plan changed")}`
      return `${row.type === "bot.held" ? "entries held" : "entering again"}: ${names}, since ${String(row.words ?? "the plan changed")}`
    }
    case "research.run": {
      const ran = [String(row.program ?? "a program"), ...(Array.isArray(row.args) ? row.args.map(String) : [])].join(" ")
      const ended = str(row.refused) ? "not held, so nothing ran" : row.timedOut ? "stopped at 60 s" : str(row.signal) ? `stopped by ${row.signal}` : `exit ${String(row.exitCode)}`
      return `${agent} ran ${clip(ran, 120)} in its research folder · ${ended}${typeof row.ms === "number" ? ` in ${(row.ms / 1000).toFixed(1)} s` : ""}`
    }
    case "tools.run":
      return Array.isArray(row.run) ? `you turned on ${agent}'s code runner for ${row.run.map(String).join(", ")}` : `you turned off ${agent}'s code runner`
    case "cli.updated":
      return `candle updated${str(row.version) ? ` to ${row.version}` : ""}`
    case "agent.fetch":
      return `${agent} fetched ${String(row.url)}`
    case "agent.turn_failed":
      return `${agent}'s turn failed: ${clip(String(row.error), 160)}`
    default:
      return row.type.replace(/[._]/g, " ")
  }
}

/** A bot's mode, said where it's live: paper is a bot's usual start. */
const botMode = (row: JournalRow) => ((row.run as { mode?: unknown } | undefined)?.mode === "live" ? " (live)" : " (paper)")

/** An entry from its rows, oldest first. */
type Searched = JournalEntry & { hay: string; shows: string; hidden: { where: string; text: string | undefined }[] }

function entryOf(rows: readonly JournalRow[], symbolOf: (mint: string) => string | undefined): Searched {
  const first = rows[0]!
  const type = ROW_KINDS[first.type]
  const isLife = rows.some(isLifeRow)
  const isTurn = !isLife && rows.some((r) => ROW_KINDS[r.type] === "turn") && rows.length > 0 && (rows.length > 1 || first.type !== "agent.turn_failed")
  let built: Built
  if (isLife) built = cardLife(rows, symbolOf)
  else if (isTurn) built = turnLife(rows)
  else {
    const said = activityWords(first, symbolOf)
    const kind: JournalKind =
      typeof first.bot === "string" && (type === "tool" || first.type === "paper.call") ? "bots" : type === "tool" ? (isTrade(first) ? "trades" : "cards") : type === undefined || type === "life" || type === "turn" ? (type === "turn" ? "agents" : "core") : type
    const named = said?.mint ?? str(first.mint) ?? str(record(first.args)?.mint)
    const mint = named && !baseAssetForMint(named) ? named : undefined
    built = { text: said?.text ?? ownWords(first), tone: said?.tone ?? (first.type.endsWith("refused") || first.type === "core.bug" ? "bad" : "info"), kind, ...(mint ? { mint } : {}), hay: [str(first.message), str(first.code), str(first.tool)].filter(Boolean).join(" "), hidden: [{ where: "the row", text: [str(first.message), str(first.code), str(first.tool)].filter(Boolean).join(" · ") }] }
  }
  const agent = rows.find((r) => r.agent)?.agent
  const chain = built.mint ? storedChain(rows.find((r) => maybeChain(r.chain))?.chain, built.mint) : undefined
  const symbol = built.mint ? symbolOf(built.mint) : undefined
  // A row written before its token had a name says its address, short: the Journal says the name known now, as the
  // rows after it do.
  if (built.mint && symbol && built.text.includes(short(built.mint))) built = { ...built, text: built.text.split(short(built.mint)).join(symbol) }
  return {
    id: String(first.seq),
    seq: first.seq,
    at: first.at,
    last: rows.at(-1)!.at,
    kind: built.kind,
    // A bot's rows carry the Candle Harness's mode and the bot's own: a paper bot's trades are paper whatever the Candle Harness's mode.
    mode: first.botMode === "paper" || first.botMode === "live" ? first.botMode : (record(first.run)?.mode === "paper" || record(first.run)?.mode === "live" ? (record(first.run)!.mode as "paper" | "live") : first.mode),
    ...(agent ? { agent } : {}),
    ...(built.mint ? { mint: built.mint } : {}),
    ...(chain ? { chain } : {}),
    ...(symbol ? { symbol } : {}),
    text: clip(built.text, TEXT_CHARS),
    tone: built.tone,
    seqs: rows.map((r) => r.seq),
    hay: [built.text, built.hay, agent, built.mint, symbol, KIND_WORDS[built.kind]].filter(Boolean).join(" ").toLowerCase(),
    shows: [built.text, agent, symbol, KIND_WORDS[built.kind]].filter(Boolean).join(" "),
    hidden: built.hidden ?? [],
  }
}

/** An entry's words from its rows, oldest first, as the Journal says them (the Away summary's too). */
export function entryWords(rows: readonly JournalRow[], symbolOf: (mint: string) => string | undefined): JournalEntry {
  const { hay: _hay, shows: _shows, hidden: _hidden, ...entry } = entryOf(rows, symbolOf)
  return entry
}

/**
 * The rows from `from` (ms) on, oldest first: memory's run, then the file backwards from where it begins, as
 * the Journal reads them. At most `max`, the newest kept; `cut` when older rows from `from` were left out.
 */
export async function rowsSince(from: number, deps: Pick<QueryDeps, "memory" | "tail" | "path" | "slice">, max: number): Promise<{ rows: JournalRow[]; cut?: true }> {
  const out: JournalRow[] = []
  let cut = false
  const scan = rowsBackward({ memory: deps.memory(), tail: deps.tail, path: deps.path, ...(deps.slice ? { slice: deps.slice } : {}) })
  try {
    outer: for await (const batch of scan) {
      for (const { row } of batch) {
        if (Date.parse(row.at) < from) break outer
        if (out.length >= max) {
          cut = true
          break outer
        }
        out.push(row)
      }
    }
  } finally {
    await scan.return?.(undefined)
  }
  // Older unsettled rows memory keeps out of its run, where they fall in the span.
  const seen = new Set(out.map((r) => r.seq))
  for (const row of deps.memory()) if (!seen.has(row.seq) && Date.parse(row.at) >= from && out.length < max) out.push(row)
  return { rows: out.sort((a, b) => a.seq - b.seq), ...(cut ? { cut: true as const } : {}) }
}

export interface QueryDeps {
  memory: () => readonly JournalRow[]
  tail: { seq: number; offset: number }
  path: string
  redactor: Redactor
  symbolOf: (mint: string) => string | undefined
  /** False once a newer query from the same view has started: this one stops at its next slice. */
  current?: () => boolean
  slice?: number
}

/** Why a query's arguments can't run, or undefined. */
export function queryProblem(q: Record<string, unknown>): string | undefined {
  if (q.text !== undefined && typeof q.text !== "string") return "text is a string."
  if (q.kinds !== undefined && (!Array.isArray(q.kinds) || q.kinds.some((k) => !(JOURNAL_KINDS as readonly unknown[]).includes(k)))) return `kinds are any of ${JOURNAL_KINDS.join(", ")}.`
  for (const k of ["agent", "mint", "before"] as const) if (q[k] !== undefined && typeof q[k] !== "string") return `${k} is a string.`
  for (const k of ["from", "to", "limit"] as const) if (q[k] !== undefined && (typeof q[k] !== "number" || !Number.isFinite(q[k]))) return `${k} is a number.`
  if (q.before !== undefined && !decodeCursor(q.before)) return "before is a page's more, as it was sent."
  if (q.chain !== undefined && !maybeChain(q.chain)) return "chain is a chain that's on, such as \"solana\" or \"hood\"."
  return undefined
}

/** One page of the journal, newest first. */
export async function queryJournal(q: JournalQuery, deps: QueryDeps): Promise<JournalPage> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? DEFAULT_LIMIT)))
  const kinds = new Set(q.kinds ?? JOURNAL_KINDS)
  const words = (q.text ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const cursor = q.before !== undefined ? decodeCursor(q.before) : undefined
  const carried = new Set(cursor?.k ?? [])
  const wants = (e: Searched) =>
    kinds.has(e.kind) &&
    (q.agent === undefined || e.agent === q.agent) &&
    (q.mint === undefined || e.mint === q.mint) &&
    (q.chain === undefined || e.chain === undefined || e.chain === q.chain) &&
    (q.to === undefined || Date.parse(e.at) <= q.to) &&
    words.every((w) => e.hay.includes(w))

  const entries: JournalEntry[] = []
  let bytes = 0
  let full = false
  let scanned = 0
  let oldest: string | undefined
  // The oldest entry sent, and where its first row starts in the file: the next page's `more`.
  let sent: { seq: number; start?: number } | undefined
  const byKey = new Map<string, Group>()
  const groups = new Set<Group>()

  /** Sends an entry, if it's wanted and fits; false when the page is full without it. */
  const emit = (rows: readonly JournalRow[], start: number | undefined): boolean => {
    const entry = entryOf(rows, deps.symbolOf)
    if (cursor && entry.seq >= cursor.b) return true
    if (!wants(entry)) return true
    const { hay: _hay, shows, hidden, ...rest } = entry
    const why = words.length ? matchedWhy(shows, hidden, words) : undefined
    const out: JournalEntry = { ...rest, ...(why ? { matched: clip(why, 100) } : {}) }
    const clean = deps.redactor.value(out)
    const size = JSON.stringify(clean).length + 1
    if (entries.length >= limit || bytes + size > PAGE_BYTES) {
      full = true
      return false
    }
    entries.push(clean)
    bytes += size
    if (!sent || entry.seq < sent.seq) sent = { seq: entry.seq, ...(start !== undefined ? { start } : {}) }
    if (entries.length >= limit) full = true
    return true
  }

  /** A group whose first row came (or never will): its entry. One that didn't fit waits for the next page. */
  const close = (g: Group) => {
    const rows = [...g.rows].reverse()
    if (!emit(rows, g.at.get(rows[0]!.seq)?.start)) return
    for (const k of g.keys) byKey.delete(k)
    groups.delete(g)
  }

  const from = cursor?.f
  const offset = cursor?.o
  const scan = rowsBackward({ memory: deps.memory(), tail: deps.tail, path: deps.path, ...(from !== undefined ? { from } : {}), ...(offset !== undefined ? { offset } : {}), ...(deps.slice ? { slice: deps.slice } : {}) })
  let reachedFrom = false
  try {
    outer: for await (const batch of scan) {
      if (deps.current && !deps.current()) return { entries: [], scanned, superseded: true }
      for (const item of batch) {
        const { row } = item
        if (q.from !== undefined && Date.parse(row.at) < q.from) {
          reachedFrom = true
          break outer
        }
        scanned++
        oldest = row.at
        const keys = keysOf(row)
        // Rows newer than the oldest entry sent belong to an entry sent or to the cards it was waiting on.
        if (cursor && row.seq >= cursor.b && !keys.some((k) => carried.has(k))) continue
        if (keys.length === 0) {
          emit([row], item.start)
        } else {
          const found = [...new Set(keys.map((k) => byKey.get(k)).filter((g): g is Group => g !== undefined))]
          let g = found[0]
          if (!g) {
            g = { keys: new Set(), rows: [], newest: row.seq, at: new Map() }
            groups.add(g)
          }
          for (const other of found.slice(1)) {
            // Two groups one row ties together: the operation's and the card's.
            for (const k of other.keys) g.keys.add(k)
            g.rows.push(...other.rows)
            g.rows.sort((a, b) => b.seq - a.seq)
            for (const [seq, at] of other.at) g.at.set(seq, at)
            g.newest = Math.max(g.newest, other.newest)
            groups.delete(other)
          }
          for (const k of keys) {
            g.keys.add(k)
            byKey.set(k, g)
          }
          g.rows.push(row)
          if (item.start !== undefined && item.end !== undefined) g.at.set(row.seq, { start: item.start, end: item.end })
          if (isAnchor(row)) close(g)
        }
        if (full) break outer
        // A group whose first row never came (a row from before its card, or damage): its own entry, from its oldest row.
        if (scanned % 512 === 0) for (const g of [...groups]) if (g.newest - row.seq > ORPHAN_ROWS && !full) close(g)
        if (full) break outer
      }
    }
    // The start of the journal: what's still waiting is its own entry, newest first.
    if (!full && !reachedFrom) for (const g of [...groups].sort((a, b) => b.rows.at(-1)!.seq - a.rows.at(-1)!.seq)) if (!full) close(g)
  } finally {
    // An early stop closes the file behind the generator.
    await scan.return?.(undefined)
  }
  const page: JournalPage = { entries, scanned, ...(oldest ? { oldest } : {}) }
  if (!full || !sent) return page
  // The next page: before the oldest entry sent, from the newest row of any card still waiting on its start
  // (re-read, so its life comes whole), else from the row before that entry.
  const waiting = [...groups]
  const top = waiting.length ? waiting.reduce((a, b) => (b.newest > a.newest ? b : a)) : undefined
  const f = top && top.newest >= sent.seq ? top.newest : sent.seq - 1
  const o = top && top.newest >= sent.seq ? top.at.get(top.newest)?.end : sent.start
  return { ...page, more: encodeCursor({ b: sent.seq, f, ...(o !== undefined ? { o } : {}), k: waiting.flatMap((g) => [...g.keys]) }) }
}

/** Rows by seq, as recorded (already redacted, and redacted again), for an entry's details. Oldest first; `cut` once over 128 KB. */
export async function journalRows(seqs: readonly number[], deps: QueryDeps): Promise<{ rows: JournalRow[]; cut?: true }> {
  const want = new Set(seqs.filter((s) => Number.isInteger(s)))
  if (want.size === 0) return { rows: [] }
  const min = Math.min(...want)
  const found: JournalRow[] = []
  const scan = rowsBackward({ memory: deps.memory(), tail: deps.tail, path: deps.path, from: Math.max(...want) })
  try {
    outer: for await (const batch of scan) {
      for (const { row } of batch) {
        if (want.has(row.seq)) found.push(row)
        if (row.seq <= min) break outer
      }
    }
  } finally {
    await scan.return?.(undefined)
  }
  // Older unsettled rows memory keeps out of its run, where the file scan didn't reach them.
  for (const row of deps.memory()) if (want.has(row.seq) && !found.some((r) => r.seq === row.seq)) found.push(row)
  const rows: JournalRow[] = []
  let bytes = 0
  for (const row of found.sort((a, b) => a.seq - b.seq)) {
    const clean = deps.redactor.value(row)
    bytes += JSON.stringify(clean).length
    if (bytes > ROWS_BYTES) return { rows, cut: true }
    rows.push(clean)
  }
  return { rows }
}

/** A wallet's setting before a change: "asked every time", or "traded inside limits · …". */
const pastWords = (v: WalletSetting) => settingWords(v).replace(/^asks/, "asked").replace(/^trades/, "traded")
