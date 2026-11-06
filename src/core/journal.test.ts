// The core's append-only journal. The identity is the account (and the agent a row is about), every
// row states its mode, and only a window of history is kept in memory.
import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REDACTED, Redactor } from "../shared/redact"
import { Journal, JournalIdentityError, readJournal } from "./journal"
import { DaySpend } from "./limits"

const FAKE_KEY = `cndl_live_${"k".repeat(43)}`
const ACCOUNT = "acct_fake_1"
const dirs: string[] = []

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chrn-journal-"))
  dirs.push(dir)
  return join(dir, "journal.jsonl")
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function openJournal(path: string, opts: { redactor?: Redactor; account?: string; windowRows?: number } = {}) {
  return Journal.open({
    path,
    redactor: opts.redactor ?? new Redactor(),
    account: opts.account ?? ACCOUNT,
    now: () => Date.parse("2026-10-26T12:00:00Z"),
    windowRows: opts.windowRows,
  })
}

describe("Journal", () => {
  test("every row carries account, mode, seq and time, and lands on disk before append resolves", async () => {
    const path = await freshPath()
    const journal = await openJournal(path)
    const row = await journal.append({ type: "core.started", mode: "live", pid: 42 })
    expect(row).toMatchObject({ seq: 1, type: "core.started", account: ACCOUNT, mode: "live", pid: 42 })
    expect(row.at).toBe("2026-10-26T12:00:00.000Z")
    // Read back while the journal is still open: the row is already in the file.
    expect((await readJournal(path)).rows).toEqual([row])
    await journal.close()
  })

  test("every append is synced to disk before it resolves", async () => {
    const path = await freshPath()
    const journal = await openJournal(path)
    // Spy on the file handle's class: a read-back can't tell a synced row from a buffered one.
    const probe = await open(path, "r")
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    const original = proto.sync
    let syncs = 0
    proto.sync = function (this: unknown) {
      syncs++
      return original.call(this)
    }
    try {
      await journal.append({ type: "operation.submitting", mode: "live", opId: "op-1" })
      expect(syncs).toBe(1)
      await journal.append({ type: "operation.succeeded", mode: "live", opId: "op-1" })
      expect(syncs).toBe(2)
    } finally {
      proto.sync = original
    }
    await journal.close()
  })

  test("a row says which agent it's about", async () => {
    const journal = await openJournal(await freshPath())
    const row = await journal.append({ type: "card.created", mode: "live", agent: "momentum", cardId: "c1" })
    expect(row.agent).toBe("momentum")
    await expect(journal.append({ type: "x", mode: "live", agent: "../x" })).rejects.toThrow(/agent/)
    await expect(journal.append({ type: "x", mode: "live", agent: 3 })).rejects.toThrow(/agent/)
    await journal.close()
  })

  test("a row with no mode is refused: every row says paper or live", async () => {
    const journal = await openJournal(await freshPath())
    await expect(journal.append({ type: "paper.call" } as never)).rejects.toThrow(/paper or live/)
    await expect(journal.append({ type: "x", mode: "sim" as never })).rejects.toThrow(/paper or live/)
    await journal.close()
  })

  test("an error carrying an agent key is written with the redaction marker, never the key", async () => {
    const path = await freshPath()
    const redactor = new Redactor()
    redactor.add(FAKE_KEY)
    const journal = await openJournal(path, { redactor })
    await journal.append({ type: "operation.failed", error: `upstream 500: key ${FAKE_KEY} rejected`, mode: "paper" })
    await journal.close()
    const text = await readFile(path, "utf8")
    expect(text).not.toContain(FAKE_KEY)
    expect(text).toContain(REDACTED)
    expect(JSON.parse(text.trim()).mode).toBe("paper")
  })

  test("an agent key is redacted in every field of a row, nested ones and field names that hold keys included", async () => {
    const path = await freshPath()
    const redactor = new Redactor()
    // Registered, and in a shape the key-pattern rule wouldn't catch on its own.
    const opaque = "opaque-agent-key-0123456789"
    redactor.add(opaque)
    const journal = await openJournal(path, { redactor })
    await journal.append({
      type: "candle.child_started",
      mode: "live",
      agent: "momentum",
      env: { CANDLE_API_KEY: opaque },
      args: ["mcp", `--note=${opaque}`],
      apiKey: "anything at all",
      detail: { nested: [{ text: `key ${opaque} and ${FAKE_KEY}` }] },
    })
    await journal.close()
    const text = await readFile(path, "utf8")
    expect(text).not.toContain(opaque)
    expect(text).not.toContain(FAKE_KEY)
    expect(text).not.toContain("anything at all")
    const row = JSON.parse(text.trim())
    expect(row.env.CANDLE_API_KEY).toBe(REDACTED)
    expect(row.args).toEqual(["mcp", `--note=${REDACTED}`])
    expect(row.apiKey).toBe(REDACTED)
  })

  test("a caller can't set the fields the journal owns", async () => {
    const journal = await openJournal(await freshPath())
    await expect(journal.append({ type: "x", mode: "live", account: "other" })).rejects.toThrow(/may not set "account"/)
    await expect(journal.append({ type: "x", mode: "live", seq: 9 })).rejects.toThrow(/may not set "seq"/)
    await expect(journal.append({ type: "x", mode: "live", at: "then" })).rejects.toThrow(/may not set "at"/)
    // A refused row doesn't wedge the ones after it.
    expect((await journal.append({ type: "ok", mode: "live" })).seq).toBe(1)
    await journal.close()
  })

  test("rows are rebuilt on open and seq continues", async () => {
    const path = await freshPath()
    const first = await openJournal(path)
    await first.append({ type: "a", mode: "live" })
    await first.append({ type: "b", mode: "paper" })
    await first.close()
    const second = await openJournal(path)
    expect(second.rows().map((row) => row.type)).toEqual(["a", "b"])
    expect((await second.append({ type: "c", mode: "live" })).seq).toBe(3)
    await second.close()
  })

  test("a torn last line is kept, skipped, terminated and recorded; nothing is rewritten", async () => {
    const path = await freshPath()
    const first = await openJournal(path)
    await first.append({ type: "a", mode: "live" })
    await first.close()
    await appendFile(path, '{"seq":2,"type":"half')
    const before = await readFile(path, "utf8")
    const second = await openJournal(path)
    expect(second.history.tornTail).toBe(true)
    expect(second.history.skipped).toBe(1)
    expect(second.rows().at(-1)).toMatchObject({ type: "journal.torn_tail", skipped: 1, seq: 2 })
    await second.close()
    const after = await readFile(path, "utf8")
    expect(after.startsWith(before)).toBe(true)
    expect((await readJournal(path)).tornTail).toBe(false)
  })

  test("a journal written for another account is refused, not merged", async () => {
    const path = await freshPath()
    await writeFile(path, `${JSON.stringify({ seq: 1, at: "x", type: "a", account: "acct_other", mode: "live" })}\n`)
    await expect(openJournal(path)).rejects.toBeInstanceOf(JournalIdentityError)
  })

  test("the file is created mode 0600, and a looser one is tightened", async () => {
    const path = await freshPath()
    const journal = await openJournal(path)
    await journal.close()
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const loose = await freshPath()
    await writeFile(loose, "", { mode: 0o644 })
    await (await openJournal(loose)).close()
    expect((await stat(loose)).mode & 0o777).toBe(0o600)
  })
})

describe("the in-memory window", () => {
  function row(seq: number, type: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ seq, at: "2026-10-26T00:00:00.000Z", type, account: ACCOUNT, mode: "live", ...extra })
  }

  test("20,000 rows open with only the recent ones and the open operations in memory", async () => {
    const path = await freshPath()
    const lines: string[] = []
    let seq = 0
    // Early on: one operation that settled, one that never did, one re-sent after being abandoned.
    lines.push(row(++seq, "operation.submitting", { opId: "op-settled" }))
    lines.push(row(++seq, "operation.succeeded", { opId: "op-settled" }))
    lines.push(row(++seq, "card.created", { cardId: "c-open", opId: "op-open" }))
    lines.push(row(++seq, "operation.submitting", { opId: "op-open" }))
    lines.push(row(++seq, "operation.unknown", { opId: "op-open" }))
    lines.push(row(++seq, "operation.submitting", { opId: "op-resent" }))
    lines.push(row(++seq, "operation.refused", { opId: "op-resent" }))
    lines.push(row(++seq, "operation.resend", { opId: "op-resent" }))
    lines.push(row(++seq, "operation.submitting", { opId: "op-resent" }))
    // A card that expired before it was ever sent has no operation to keep open.
    lines.push(row(++seq, "card.created", { cardId: "c-expired", opId: "op-never-sent" }))
    lines.push(row(++seq, "card.expired", { cardId: "c-expired" }))
    while (seq < 20_000) lines.push(row(++seq, "activity.note"))
    await writeFile(path, `${lines.join("\n")}\n`)

    const journal = await openJournal(path)
    const rows = journal.rows()
    expect(journal.history.total).toBe(20_000)
    expect(rows).toHaveLength(10_000 + 7)
    // Every row of the open operations, in order, then the recent window.
    expect(rows.slice(0, 7).map((r) => `${r.type} ${r.opId}`)).toEqual([
      "card.created op-open",
      "operation.submitting op-open",
      "operation.unknown op-open",
      "operation.submitting op-resent",
      "operation.refused op-resent",
      "operation.resend op-resent",
      "operation.submitting op-resent",
    ])
    expect(rows.some((r) => r.opId === "op-settled")).toBe(false)
    expect(rows.some((r) => r.opId === "op-never-sent")).toBe(false)
    expect(rows[7]!.seq).toBe(10_001)
    expect(rows.at(-1)!.seq).toBe(20_000)
    // seq continues from the file, not from what's in memory.
    expect((await journal.append({ type: "next", mode: "live" })).seq).toBe(20_001)
    await journal.close()
  })

  test("today's approvals the window dropped are still in the rows the day's limits rebuild from", async () => {
    const path = await freshPath()
    // Local times, so local midnight falls where the test means it to in any time zone.
    const local = (day: number, h: number, m = 0, sec = 0) => new Date(2026, 9, day, h, m, sec).toISOString()
    const now = Date.parse(local(26, 12))
    const r = (seq: number, at: string, type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, at, type, account: ACCOUNT, mode: "live", ...extra })
    const lines = [
      // Two days ago: before the floor, never counted.
      r(1, local(24, 9), "card.approved", { opId: "op-old", agent: "momentum", usd: 30, side: "buy" }),
      // This morning: a buy approved and filled, then more rows than the window holds.
      r(2, local(26, 9), "card.approved", { opId: "op-am", agent: "momentum", usd: 40, side: "buy" }),
      r(3, local(26, 9, 0, 1), "operation.submitting", { opId: "op-am" }),
      r(4, local(26, 9, 0, 5), "operation.succeeded", { opId: "op-am" }),
      r(5, local(26, 9, 0, 6), "view.picked"),
      ...Array.from({ length: 20 }, (_, i) => r(6 + i, local(26, 11), "client.attached")),
    ]
    await writeFile(path, `${lines.join("\n")}\n`)
    const journal = await Journal.open({ path, redactor: new Redactor(), account: ACCOUNT, now: () => now, windowRows: 10 })
    // The window itself is unchanged: the morning's rows are out of it.
    expect(journal.rows().some((row) => row.opId === "op-am")).toBe(false)
    const spend = journal.spendRows()
    expect(spend.filter((row) => row.opId === "op-am").map((row) => row.type)).toEqual(["card.approved", "operation.submitting", "operation.succeeded"])
    expect(spend.some((row) => row.opId === "op-old" || row.type === "view.picked")).toBe(false)
    // In order, the window's rows after them.
    expect(spend.map((row) => row.seq)).toEqual([...spend.map((row) => row.seq)].sort((a, b) => a - b))
    expect(spend.at(-1)!.seq).toBe(25)
    const day = new DaySpend()
    day.rebuild(spend)
    expect(day.spent("momentum", now)).toBe(40)
    await journal.close()
  })

  test("a short journal is kept whole", async () => {
    const path = await freshPath()
    await writeFile(path, `${[1, 2, 3].map((s) => row(s, "a")).join("\n")}\n`)
    const journal = await openJournal(path, { windowRows: 10 })
    expect(journal.rows().map((r) => r.seq)).toEqual([1, 2, 3])
    await journal.close()
  })
})
