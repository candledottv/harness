/**
 * The core's journal: `journal.jsonl`, append-only, one JSON row per line,
 * fsync'd before `append` resolves.
 *
 * Every card, approval, operation transition, refused call and client event becomes one row. The
 * order matters for reconciliation: an operation's `submitting` row is on disk before its request
 * is sent, so a core that dies mid-call finds it on the next start. That's why a row is never
 * buffered: `append` resolves only after the file descriptor has been synced.
 *
 * Every row carries `account` and `mode`, and the agent it's about when there is one, and passed
 * the redactor. Both are enforced here, at the one writer, rather than trusted to every caller.
 * `mode` has no default: every row says paper or live.
 *
 * A row is never rewritten or deleted. A torn last line (the process died mid-write) is left where
 * it is; the next start terminates it with a newline, skips it when reading, and records that it
 * did so in a row of its own.
 *
 * There's no rotation yet. On open, memory keeps the last `windowRows` rows plus every row of an
 * operation that isn't settled; older rows stay on disk.
 */
import { chmod, type FileHandle, open, readFile } from "node:fs/promises"
import { isAgentName } from "../paths"
import type { Redactor } from "../shared/redact"

/** `paper` for a paper trade's rows; `live` for everything else, which acts on the real account. */
export type JournalMode = "paper" | "live"

export interface JournalRow {
  seq: number
  at: string
  type: string
  account: string
  mode: JournalMode
  agent?: string
  opId?: string
  [field: string]: unknown
}

export type JournalInput = { type: string; mode: JournalMode; agent?: unknown } & Record<string, unknown>

export interface JournalReadResult {
  rows: JournalRow[]
  /** Rows in the file, all of them, before the window was taken. */
  total: number
  /** Lines that didn't parse as a row: a torn tail, or damage. Counted, never thrown on. */
  skipped: number
  /** Whether the file ended mid-line when it was opened. */
  tornTail: boolean
}

/**
 * Where the rows memory holds in an unbroken run begin, as the file was opened: the first such row's seq
 * and its byte offset. Older rows are read from the file, backwards from that offset.
 */
export interface JournalTail {
  seq: number
  offset: number
}

export const DEFAULT_WINDOW_ROWS = 10_000

/** An operation's rows are `operation.<state>`; these states end it. A re-send opens it again. */
const SETTLED = new Set(["operation.succeeded", "operation.failed", "operation.refused", "operation.abandoned"])
const REOPENED = new Set(["operation.submitting", "operation.pending", "operation.unknown", "operation.resend"])

const RESERVED = new Set(["seq", "at", "account"])

export class Journal {
  private chain: Promise<unknown> = Promise.resolve()
  private seq: number
  private closed = false
  private readonly listeners: ((row: JournalRow) => void)[] = []

  private constructor(
    /** The file, which `journal-query.ts` reads backwards for rows older than memory's. */
    readonly path: string,
    /** Where memory's unbroken run of rows begins in the file. */
    readonly tail: JournalTail,
    private readonly handle: FileHandle,
    private readonly redactor: Redactor,
    private readonly account: string,
    private readonly now: () => number,
    readonly history: JournalReadResult,
    lastSeq: number,
    /** Rows older than the window that the day's limits still count: see `spendRows`. */
    private readonly spendHistory: readonly JournalRow[] = [],
  ) {
    this.seq = lastSeq
  }

  /**
   * Opens (creating, mode 0600) the journal at `path` and reads what it already holds. A row written
   * for a different account is a sign the state folder was copied or reused, and is refused rather
   * than merged: the core is bound to one account for its life.
   */
  static async open(input: {
    path: string
    redactor: Redactor
    account: string
    now: () => number
    windowRows?: number
  }): Promise<Journal> {
    const { offsets, ...all } = await readJournalWithOffsets(input.path)
    const foreign = all.rows.find((row) => row.account !== input.account)
    if (foreign !== undefined) {
      throw new JournalIdentityError(
        `This journal holds rows for account "${foreign.account}"; this core is account "${input.account}".`,
      )
    }
    const lastSeq = all.rows.reduce((max, row) => Math.max(max, row.seq), 0)
    const size = input.windowRows ?? DEFAULT_WINDOW_ROWS
    const history = { ...all, rows: windowOf(all.rows, size) }
    // The window's unbroken run starts at its cut; everything is in memory when the file holds no more.
    const cut = Math.max(0, all.rows.length - size)
    const tail: JournalTail = all.rows.length > size ? { seq: all.rows[cut]!.seq, offset: offsets[cut]! } : { seq: all.rows[0]?.seq ?? lastSeq + 1, offset: 0 }
    // Today's approvals and their outcomes from before the cut: a restart's day limits count them too.
    const kept = new Set(history.rows.map((row) => row.seq))
    const since = spendFloor(input.now())
    const spendHistory = all.rows.slice(0, cut).filter((row) => !kept.has(row.seq) && SPEND_ROW(row) && Date.parse(row.at) >= since)

    const handle = await open(input.path, "a", 0o600)
    // The mode on `open` applies only when the file is created; an older, looser file is tightened.
    await chmod(input.path, 0o600)
    const journal = new Journal(input.path, tail, handle, input.redactor, input.account, input.now, history, lastSeq, spendHistory)
    if (history.tornTail) {
      await journal.raw("\n")
      await journal.append({ type: "journal.torn_tail", mode: "live", skipped: history.skipped })
    }
    return journal
  }

  /** Appends one row and resolves once it's on disk. Rows are written in call order. */
  append(input: JournalInput): Promise<JournalRow> {
    const next = this.chain.then(async () => {
      if (this.closed) throw new Error("The journal is closed.")
      for (const field of Object.keys(input)) {
        if (RESERVED.has(field)) throw new Error(`A journal row may not set "${field}"; the journal does.`)
      }
      if (input.mode !== "paper" && input.mode !== "live") {
        throw new Error(`A journal row's mode must be paper or live, not ${String(input.mode)}.`)
      }
      if (typeof input.type !== "string" || input.type.length === 0) throw new Error("A journal row needs a type.")
      // An owner step taken before any agent exists (setup) is no agent's: its row carries none.
      if (input.agent === "") input = { ...input, agent: undefined }
      if (input.agent !== undefined && (typeof input.agent !== "string" || !isAgentName(input.agent))) {
        throw new Error(`A journal row's agent must be an agent name, not ${String(input.agent)}.`)
      }
      const row = this.redactor.value({
        ...input,
        seq: this.seq + 1,
        at: new Date(this.now()).toISOString(),
        account: this.account,
      }) as JournalRow
      await this.raw(`${JSON.stringify(row)}\n`)
      this.seq = row.seq
      this.history.rows.push(row)
      // The row is on disk: a listener's failure is its own, never the append's.
      for (const listener of this.listeners) {
        try {
          listener(row)
        } catch {}
      }
      return row
    })
    // A failed append must not wedge every later one behind it.
    this.chain = next.catch(() => {})
    return next
  }

  /** Called with each row once it's on disk, in order (the activity pane's lines). */
  onAppend(listener: (row: JournalRow) => void): void {
    this.listeners.push(listener)
  }

  /** The rows in memory, in order: the window read at open, then what this core appended. */
  rows(): readonly JournalRow[] {
    return this.history.rows
  }

  /**
   * What the day's limits rebuild from on a restart: `rows()`, plus every approval and operation row
   * since the day before local midnight that fell outside the window, in order. A busy day writes more
   * rows than the window holds, and an approval it dropped would let the day's spend start again at zero.
   */
  spendRows(): readonly JournalRow[] {
    if (this.spendHistory.length === 0) return this.history.rows
    return [...this.spendHistory, ...this.history.rows].sort((a, b) => a.seq - b.seq)
  }

  async close(): Promise<void> {
    await this.chain
    this.closed = true
    await this.handle.close()
  }

  private async raw(text: string): Promise<void> {
    await this.handle.write(text)
    await this.handle.sync()
  }
}

export class JournalIdentityError extends Error {
  readonly code = "JOURNAL_IDENTITY_MISMATCH"
  constructor(message: string) {
    super(message)
    this.name = "JournalIdentityError"
  }
}

/** The rows a day's spend and Candle's refusals are rebuilt from. */
const SPEND_ROW = (row: JournalRow): boolean => row.type === "card.approved" || row.type === "card.valued" || row.type.startsWith("operation.")

/**
 * How far back `spendRows` reaches: the day before local midnight, so the local day's limits and a
 * Candle key's UTC day are both whole in any time zone.
 */
function spendFloor(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime() - 24 * 60 * 60_000
}

/** The last `size` rows, plus every earlier row of an operation that isn't settled, in file order. */
function windowOf(rows: JournalRow[], size: number): JournalRow[] {
  if (rows.length <= size) return rows
  const open = new Set<string>()
  for (const row of rows) {
    if (typeof row.opId !== "string") continue
    if (SETTLED.has(row.type)) open.delete(row.opId)
    else if (REOPENED.has(row.type)) open.add(row.opId)
  }
  const cut = rows.length - size
  return rows.filter((row, i) => i >= cut || (typeof row.opId === "string" && open.has(row.opId)))
}

/** Reads a journal file without opening it for writing. A missing file is an empty journal. */
export async function readJournal(path: string): Promise<JournalReadResult> {
  const { offsets: _offsets, ...read } = await readJournalWithOffsets(path)
  return read
}

/** As readJournal, with each row's byte offset in the file. */
async function readJournalWithOffsets(path: string): Promise<JournalReadResult & { offsets: number[] }> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], total: 0, skipped: 0, tornTail: false, offsets: [] }
    throw error
  }
  const tornTail = text.length > 0 && !text.endsWith("\n")
  const rows: JournalRow[] = []
  const offsets: number[] = []
  let skipped = 0
  let at = 0
  for (const line of text.split("\n")) {
    const start = at
    at += Buffer.byteLength(line, "utf8") + 1
    if (line.trim() === "") continue
    const row = parseRow(line)
    if (row === undefined) skipped++
    else {
      rows.push(row)
      offsets.push(start)
    }
  }
  return { rows, total: rows.length, skipped, tornTail, offsets }
}

/** One line as a journal row, or undefined where it isn't one (a torn line, damage). */
export function parseRow(line: string): JournalRow | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== "object") return undefined
  const row = value as Partial<JournalRow>
  if (typeof row.seq !== "number" || typeof row.type !== "string") return undefined
  if (typeof row.account !== "string" || (row.mode !== "paper" && row.mode !== "live")) return undefined
  return row as JournalRow
}
