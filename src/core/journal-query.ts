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
import { open } from "node:fs/promises"
import type { Redactor } from "../shared/redact"
import { baseAssetForMint } from "./assets"
import { settingWords, type WalletSetting } from "./autonomy"
import { type JournalRow, parseRow } from "./journal"
import { usd } from "./limits"
import { cardTitle, doneWord, PAPER_CLOSED_WORDS, paneResult, TradeLog, withdrawnWhy } from "./trade-log"
import { short } from "./wallet-names"

/** The kind chips: trades, cards, the kill switch, Hacc, memory, agents, the view and the core. */
export const JOURNAL_KINDS = ["trades", "cards", "kill", "hacc", "memory", "agents", "view", "core"] as const
export type JournalKind = (typeof JOURNAL_KINDS)[number]

/** Each kind as its chip says it. */
export const KIND_WORDS: Record<JournalKind, string> = { trades: "trades", cards: "cards", kill: "kill switch", hacc: "Hacc", memory: "memory", agents: "agents", view: "view", core: "core" }

/** The kinds on by default: all but the core's own rows. */
export const DEFAULT_KINDS: readonly JournalKind[] = JOURNAL_KINDS.filter((k) => k !== "core")

/**
 * Each row type the core writes, and its kind. `life`: it folds into a card's life, whose kind is trades for
 * a trade or swap and cards otherwise. `turn`: it folds into an agent's turn. `tool`: a refusal, trades for
 * a trade or swap tool and cards otherwise.
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
  "agent.added": "agents",
  "engine.chosen": "agents",
  "preset.chosen": "agents",
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
  "client.attached": "core",
  "client.detached": "core",
  "client.refused": "core",
  "call.forbidden": "core",
  "candle.start_failed": "core",
  "candle.unclassified_tools": "core",
  "engine.homes_recovered": "core",
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

const HOW: Record<string, string> = { enter: "approved by Enter", click: "approved by a click", instant: "sent at once (typed cards run instantly)", typed: "typed", view: "approved", "inside-limits": "without a card, inside its wallet's limits" }

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
  const kind: JournalKind = isTrade(created) || isTrade(rows.find((r) => r.type === "operation.submitting")) ? "trades" : "cards"
  const title = created ? cardTitle(created) : "a card from before this journal's start"
  const params = record(created?.params)
  const named = str(created?.mint) ?? str(params?.mint)
  const mint = named && !baseAssetForMint(named) ? named : undefined
  const head = created ? (activityWords(created, symbolOf)?.text ?? `you ran ${title}`) : title
  const parts = [head]
  const approved = rows.find((r) => r.type === "card.approved")
  // Why a trade from a wallet that trades inside limits was a card: its figure, in the card's words.
  const because = str(rows.findLast((r) => r.type === "card.because")?.words)
  if (because && approved?.how !== "inside-limits") parts.push(`a card: ${because}`)
  if (approved && approved.how !== "typed") parts.push(HOW[String(approved.how)] ?? "approved")
  if (rows.some((r) => r.type === "operation.resend")) parts.push("re-sent")
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
        parts.push(`${end.type === "operation.refused" ? "refused" : "failed"}${said ? `: ${said}` : ""}`)
        tone = "bad"
        break
      }
      case "operation.unknown":
        parts.push("no answer: being read back")
        tone = "warn"
        break
      case "operation.abandoned":
        parts.push(`abandoned${took(end, "after")}`)
        tone = "warn"
        break
      case "operation.submitting":
      case "operation.pending":
        parts.push("sent, no answer yet")
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

/** Every address in a line, short: "MoonFake111…1111" as "Moon…1111". */
const shortAddresses = (text: string): string => text.replace(/\b(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})\b/g, short)

/** An agent's turn: what the person asked, how it ended and how long it took, and the tools it called. */
function turnLife(rows: readonly JournalRow[]): Built {
  const started = rows.find((r) => r.type === "agent.turn_started")
  const turn = rows.find((r) => r.type === "agent.turn")
  const failed = rows.find((r) => r.type === "agent.turn_failed")
  const agent = rows.find((r) => r.agent)?.agent ?? "the agent"
  const user = str(turn?.user)
  // Addresses in what you asked show short, as replies show them, so the quote keeps its words.
  const parts = [user ? `you asked ${agent}: "${clip(shortAddresses(user.replace(/\s+/g, " ")), 80)}"` : `${agent}'s turn`]
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
    { where: "what you asked", text: user },
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
    case "client.refused":
      return `refused a connection: ${String(row.reason ?? row.code ?? "")}`
    case "call.forbidden":
      return `refused a ${String(row.role)}'s ${String(row.method)}${str(row.topic) ? ` of ${row.topic}` : ""}`
    case "candle.start_failed":
      return `${agent}'s Candle connection didn't start: ${clip(String(row.error), 160)}`
    case "candle.unclassified_tools":
      return `Candle offers ${agent} tools the Candle Harness doesn't know: ${Array.isArray(row.tools) ? row.tools.join(", ") : ""}`
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
    case "cli.updated":
      return `candle updated${str(row.version) ? ` to ${row.version}` : ""}`
    case "agent.turn_failed":
      return `${agent}'s turn failed: ${clip(String(row.error), 160)}`
    default:
      return row.type.replace(/[._]/g, " ")
  }
}

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
    const kind: JournalKind = type === "tool" ? (isTrade(first) ? "trades" : "cards") : type === undefined || type === "life" || type === "turn" ? (type === "turn" ? "agents" : "core") : type
    const named = said?.mint ?? str(first.mint) ?? str(record(first.args)?.mint)
    const mint = named && !baseAssetForMint(named) ? named : undefined
    built = { text: said?.text ?? ownWords(first), tone: said?.tone ?? (first.type.endsWith("refused") || first.type === "core.bug" ? "bad" : "info"), kind, ...(mint ? { mint } : {}), hay: [str(first.message), str(first.code), str(first.tool)].filter(Boolean).join(" "), hidden: [{ where: "the row", text: [str(first.message), str(first.code), str(first.tool)].filter(Boolean).join(" · ") }] }
  }
  const agent = rows.find((r) => r.agent)?.agent
  const symbol = built.mint ? symbolOf(built.mint) : undefined
  return {
    id: String(first.seq),
    seq: first.seq,
    at: first.at,
    last: rows.at(-1)!.at,
    kind: built.kind,
    mode: first.mode,
    ...(agent ? { agent } : {}),
    ...(built.mint ? { mint: built.mint } : {}),
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
