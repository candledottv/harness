import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { Journal, type JournalInput } from "./journal"
import { DEFAULT_KINDS, type JournalEntry, type JournalQuery, journalRows, queryJournal, queryProblem, ROW_KINDS, tookWords } from "./journal-query"

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
const MOON = "MoonFake11111111111111111111111111111111111"
const T0 = Date.parse("2026-10-30T09:00:00.000Z")

const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A journal on disk, its clock moved by hand. */
async function journalAt(opts: { windowRows?: number; redactor?: Redactor; path?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chrn-jq-"))
  dirs.push(dir)
  const path = opts.path ?? join(dir, "journal.jsonl")
  let clock = T0
  const redactor = opts.redactor ?? new Redactor()
  const open = () => Journal.open({ path, redactor, account: "acct_fake", now: () => clock, ...(opts.windowRows ? { windowRows: opts.windowRows } : {}) })
  const j = await open()
  journals.push(j)
  return {
    j,
    path,
    redactor,
    tick: (ms: number) => (clock += ms),
    add: (row: JournalInput) => j.append(row),
    reopen: async () => {
      await j.close()
      const again = await open()
      journals.push(again)
      return again
    },
  }
}

const deps = (j: Journal, redactor = new Redactor(), slice?: number) => ({ memory: () => j.rows(), tail: j.tail, path: j.path, redactor, symbolOf: (m: string) => (m === JUP ? "JUP" : m === MOON ? "MOON" : undefined), ...(slice ? { slice } : {}) })

/** A whole buy: proposed, approved by Enter, sent and filled, `ms` apart. */
async function buy(t: Awaited<ReturnType<typeof journalAt>>, n: number, opts: { mint?: string; agent?: string; end?: "filled" | "failed" | "rejected" | "withdrawn" | "open"; gap?: number } = {}) {
  const cardId = `card_${n}`
  const opId = `op_${n}`
  const agent = opts.agent ?? "momentum"
  const mint = opts.mint ?? JUP
  await t.add({ type: "card.created", mode: "live", agent, cardId, opId, role: "harness", kind: "trade", tool: "candle_trade", params: { mint, side: "buy", amount: "0.05" }, mint, side: "buy", wallet: "Embed1111", headline: `Buy 0.05 SOL of ${mint === JUP ? "JUP" : "MOON"}`, title: "buy" })
  t.tick(opts.gap ?? 1_200)
  if (opts.end === "open") return
  if (opts.end === "rejected") return void (await t.add({ type: "card.rejected", mode: "live", agent, cardId, opId }))
  if (opts.end === "withdrawn") return void (await t.add({ type: "card.withdrawn", mode: "live", agent, cardId, opId, reason: "kill_switch" }))
  await t.add({ type: "card.approved", mode: "live", agent, cardId, opId, how: "enter", side: "buy" })
  t.tick(5)
  await t.add({ type: "operation.submitting", mode: "live", agent, opId, cardId, kind: "trade", tool: "candle_trade" })
  t.tick(3_100)
  if (opts.end === "failed") return void (await t.add({ type: "operation.failed", mode: "live", agent, opId, error: { code: "SLIPPAGE", message: "Price moved; nothing was sent." } }))
  await t.add({ type: "operation.succeeded", mode: "live", agent, opId })
}

const texts = (es: readonly JournalEntry[]) => es.map((e) => e.text)

describe("the kind table", () => {
  test("names every row type the core and engines write", () => {
    // Every `type: "x.y"` literal in the source (the journal's row types, as the build-progress list has them), and the templated ones.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []))
    const src = join(import.meta.dir, "..")
    const found = new Set<string>()
    for (const file of [...files(join(src, "core")), ...files(join(src, "engine"))]) {
      for (const m of readFileSync(file, "utf8").matchAll(/type: "([a-z]+\.[a-z_]+)"/g)) found.add(m[1]!)
    }
    // `card.${state}` and `operation.${op.state}`: the closes and every operation state.
    for (const state of ["rejected", "withdrawn", "expired"]) found.add(`card.${state}`)
    for (const state of ["submitting", "pending", "succeeded", "failed", "refused", "unknown", "abandoned"]) found.add(`operation.${state}`)
    expect(found.size).toBeGreaterThan(60)
    expect([...found].filter((t) => !(t in ROW_KINDS))).toEqual([])
  })

  test("the core's own rows are off by default, every other kind on", () => {
    expect(DEFAULT_KINDS).not.toContain("core")
    expect(DEFAULT_KINDS).toContain("trades")
  })
})

describe("rows in words", () => {
  test("a card's life is one entry: who proposed what, how it was approved, how it ended, how long", async () => {
    const t = await journalAt()
    await buy(t, 1)
    const page = await queryJournal({}, deps(t.j))
    expect(page.entries).toHaveLength(1)
    const [e] = page.entries
    expect(e!.text).toBe("momentum proposed Buy 0.05 SOL of JUP from embedded · approved by Enter · filled in 3.1 s")
    expect(e).toMatchObject({ kind: "trades", tone: "good", agent: "momentum", mint: JUP, symbol: "JUP", mode: "live", seqs: [1, 2, 3, 4] })
    expect(page.more).toBeUndefined()
  })

  test("a harness's sign-in pane, which has no card, is a setup row of its own, never a card from before the journal's start", async () => {
    const t = await journalAt()
    await t.add({ type: "onboarding.harness", mode: "paper", engine: "grok", ticketId: "tk_1", by: "view_1" })
    await t.add({ type: "pane.redeemed", mode: "paper", ticketId: "tk_1", harness: "grok" })
    const page = await queryJournal({ kinds: ["core"] }, deps(t.j))
    expect(page.entries.map((e) => e.text)).toEqual(["setup: grok's sign-in pane started", "setup: grok's own sign-in opened in a pane"])
    expect(page.entries.every((e) => e.kind === "core")).toBe(true)
    // Nothing of it in the person's default view, and nothing waiting.
    expect((await queryJournal({ kinds: [...DEFAULT_KINDS] }, deps(t.j))).entries).toEqual([])
  })

  test("a live sell Candle closed as the key's paper position says nothing live was sold", async () => {
    const t = await journalAt()
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_p", opId: "op_p", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "sell", amount: "5" }, mint: JUP, side: "sell", wallet: "Embed1111", headline: "Sell 5 JUP", title: "sell" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_p", opId: "op_p", how: "enter", side: "sell" })
    await t.add({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op_p", cardId: "card_p" })
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_p", cardId: "card_p", paper: true })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain("not sold live")
    expect(e!.text).not.toContain("filled")
    expect(e!.tone).toBe("warn")
  })

  test("a trade the core ran without a card says so, never that the person approved it", async () => {
    const t = await journalAt()
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_9", opId: "op_9", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.006" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy 0.006 SOL of JUP", title: "buy" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "card_9", opId: "op_9", how: "inside-limits", side: "buy" })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain("· without a card, inside its wallet's limits")
  })

  test("a trade a wallet's figure sent to the person says which figure", async () => {
    const t = await journalAt()
    const words = "over the embedded wallet's $1.50 a trade without a card: this one is $1.75 with Candle's fee"
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "card_8", opId: "op_8", role: "view", kind: "trade", tool: "candle_trade", params: { mint: JUP, side: "buy", amount: "0.018" }, mint: JUP, side: "buy", wallet: "Embed1111", headline: "Buy $1.75 of JUP", title: "buy" })
    await t.add({ type: "card.because", mode: "live", agent: "momentum", cardId: "card_8", opId: "op_8", words })
    t.tick(25_000)
    await t.add({ type: "card.rejected", mode: "live", agent: "momentum", cardId: "card_8", opId: "op_8" })
    const [e] = (await queryJournal({}, deps(t.j))).entries
    expect(e!.text).toContain(`· a card: ${words} · rejected after 25 s`)
  })

  test("a wallet's autonomy, set by the person or narrowed by the agent's card", async () => {
    const t = await journalAt()
    const ask = { setting: "ask" }
    const inside = { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }
    await t.add({ type: "autonomy.set", mode: "live", wallet: "WalletFake111111111111111111111111111111111", walletName: "embedded", from: ask, to: inside, by: "v1", how: "view" })
    t.tick(1_000)
    await t.add({ type: "autonomy.set", mode: "live", agent: "momentum", wallet: "WalletFake111111111111111111111111111111111", walletName: "embedded", from: inside, to: ask, by: "card", how: "card", opId: "op_1" })
    const page = await queryJournal({}, deps(t.j))
    expect(page.entries.map((e) => [e.kind, e.text])).toEqual([
      ["cards", "momentum's card, which you approved, set the embedded wallet to ask every time (it traded inside limits · $1.00 a trade, $5.00 a day without a card)"],
      ["cards", "you set the embedded wallet to trade inside limits · $1.00 a trade, $5.00 a day without a card (it asked every time)"],
    ])
  })

  test("how each ends", async () => {
    const t = await journalAt()
    await buy(t, 1, { end: "failed" })
    await buy(t, 2, { end: "rejected", gap: 12_000 })
    await buy(t, 3, { end: "withdrawn" })
    await buy(t, 4, { end: "open" })
    expect(texts((await queryJournal({}, deps(t.j))).entries)).toEqual([
      "momentum proposed Buy 0.05 SOL of JUP from embedded · awaiting approval",
      "momentum proposed Buy 0.05 SOL of JUP from embedded · withdrawn (kill switch)",
      "momentum proposed Buy 0.05 SOL of JUP from embedded · rejected after 12 s",
      "momentum proposed Buy 0.05 SOL of JUP from embedded · approved by Enter · failed: SLIPPAGE: Price moved; nothing was sent.",
    ])
  })

  test("a turn is one entry; other rows say what Activity says, and the core's say what they are", async () => {
    const t = await journalAt()
    await t.add({ type: "core.started", mode: "live", coreVersion: "0.0.0", agents: ["momentum"] })
    await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: "t_1", engine: "claude-code" })
    t.tick(8_200)
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_1", user: "what about JUP?", reply: "JUP is steady.", tools: ["candle_get_token", "hacc_token"], outcome: "done" })
    await t.add({ type: "kill.on", mode: "live" })
    await t.add({ type: "view.picked", mode: "live", mint: MOON, symbol: "MOON", from: "feed, by a click" })
    const entries = (await queryJournal({}, deps(t.j))).entries
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ["view", "you picked MOON (feed, by a click)"],
      ["kill", "kill switch on: buys paused"],
      ["agents", 'you asked momentum: "what about JUP?" · answered in 8.2 s · 2 tool calls'],
      ["core", "the core started in live mode, version 0.0.0, with momentum"],
    ])
  })

  test("what you asked shows its addresses short, as replies do, so the quote keeps its words", async () => {
    const t = await journalAt()
    await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: "t_2", engine: "claude-code" })
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_2", user: `Check MOON (${MOON}) then buy $1`, reply: "Done.", tools: [], outcome: "done" })
    const [entry] = (await queryJournal({}, deps(t.j))).entries
    expect(entry!.text).toContain(`"Check MOON (${MOON.slice(0, 4)}…${MOON.slice(-4)}) then buy $1"`)
  })

  test("how long, in words", () => {
    expect([tookWords(40), tookWords(4_300), tookWords(12_400), tookWords(125_000), tookWords(11_400_000)]).toEqual(["under 0.1 s", "4.3 s", "12 s", "2m 05s", "3h 10m"])
  })
})

describe("the search", () => {
  test("words, kinds, agent, token and time", async () => {
    const t = await journalAt()
    await buy(t, 1, { mint: JUP })
    t.tick(60_000)
    await buy(t, 2, { mint: MOON, agent: "swing", end: "failed" })
    await t.add({ type: "client.attached", mode: "live", clientId: "v1", role: "view", clientName: "view" })
    const q = async (query: JournalQuery) => texts((await queryJournal(query, deps(t.j))).entries)
    expect(await q({ text: "jup FILLED" })).toEqual(["momentum proposed Buy 0.05 SOL of JUP from embedded · approved by Enter · filled in 3.1 s"])
    expect(await q({ text: "slippage" })).toHaveLength(1)
    expect(await q({ agent: "swing" })).toHaveLength(1)
    expect(await q({ mint: JUP })).toHaveLength(1)
    expect(await q({ kinds: [...DEFAULT_KINDS] })).toHaveLength(2)
    expect(await q({ kinds: ["core"] })).toEqual(["a view attached"])
    expect(await q({ from: T0 + 30_000 })).toHaveLength(2)
    expect(await q({ to: T0 + 30_000 })).toHaveLength(1)
    expect(await q({ text: "nothing like this" })).toEqual([])
  })

  test("a match the words don't show says where it was found (rows listed for \"stake\" with no stake in sight)", async () => {
    const t = await journalAt()
    await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: "t_1", user: "What tools do you have?", reply: "I can read markets, trade, and add a stake in CNDL for you.", tools: ["harness_view"], outcome: "done" })
    await buy(t, 1, { mint: JUP })
    const stake = (await queryJournal({ text: "stake" }, deps(t.j))).entries
    expect(stake.map((e) => e.matched)).toEqual(["its reply: …markets, trade, and add a stake in CNDL for you."])
    // Words that show leave no note; nor does a page that wasn't searched.
    expect((await queryJournal({ text: "jup filled" }, deps(t.j))).entries.map((e) => e.matched)).toEqual([undefined])
    expect((await queryJournal({}, deps(t.j))).entries.every((e) => e.matched === undefined)).toBe(true)
  })

  test("a query's arguments are checked", () => {
    expect(queryProblem({ kinds: ["trades", "nope"] })).toContain("kinds")
    expect(queryProblem({ before: "not a cursor" })).toContain("before")
    expect(queryProblem({ text: "jup", limit: 10 })).toBeUndefined()
  })
})

describe("pages, over memory and the file", () => {
  /** 120 entries: buys with turns and core rows between, and a card whose life spans others. */
  async function busy(windowRows?: number) {
    const t = await journalAt(windowRows ? { windowRows } : {})
    for (let n = 0; n < 40; n++) {
      await buy(t, n, { mint: n % 2 ? JUP : MOON })
      await t.add({ type: "agent.turn_started", mode: "live", agent: "momentum", turnId: `t_${n}` })
      t.tick(500)
      await t.add({ type: "agent.turn", mode: "live", agent: "momentum", turnId: `t_${n}`, user: `question ${n}`, reply: "ok", tools: [], outcome: "done" })
      await t.add({ type: "mode.changed", mode: n % 2 ? "live" : "paper" })
    }
    // A long card: proposed, then 30 entries' worth of rows, then approved and filled.
    await t.add({ type: "card.created", mode: "live", agent: "momentum", cardId: "long", opId: "op_long", role: "harness", kind: "trade", tool: "candle_trade", params: { mint: JUP }, mint: JUP, headline: "Sell 50% of JUP", wallet: "Embed1111" })
    for (let n = 0; n < 30; n++) await t.add({ type: "kill.off", mode: "live" })
    await t.add({ type: "card.approved", mode: "live", agent: "momentum", cardId: "long", opId: "op_long", how: "click" })
    await t.add({ type: "operation.succeeded", mode: "live", agent: "momentum", opId: "op_long" })
    return t
  }

  async function allPages(j: Journal, query: JournalQuery, slice?: number) {
    const out: JournalEntry[] = []
    let before: string | undefined
    let pages = 0
    do {
      const page = await queryJournal({ ...query, ...(before ? { before } : {}) }, deps(j, new Redactor(), slice))
      out.push(...page.entries)
      before = page.more
      pages++
    } while (before && pages < 500)
    return { out, pages }
  }

  test("every entry comes once, newest first, whatever the page size, and a card's life that spans a page comes whole", async () => {
    const t = await busy()
    const whole = (await allPages(t.j, { limit: 100 })).out
    expect(whole).toHaveLength(40 * 3 + 1 + 30)
    expect(whole.find((e) => e.id === String(whole.find((x) => x.text.includes("Sell 50%"))!.seq))!.text).toBe("momentum proposed Sell 50% of JUP from embedded · approved by a click · filled in under 0.1 s")
    for (const limit of [1, 3, 7, 50]) {
      const { out } = await allPages(t.j, { limit })
      expect(out.map((e) => e.id)).toEqual(whole.map((e) => e.id))
      expect(out.map((e) => e.text)).toEqual(whole.map((e) => e.text))
    }
  })

  test("rows older than memory's are read from the file, in small slices, the same", async () => {
    const t = await busy()
    const inMemory = (await allPages(t.j, { limit: 9 })).out
    const again = await t.reopen()
    expect(again.tail.seq).toBe(1)
    // Reopened with room for 25 rows: the rest are on disk only.
    await again.close()
    const t2 = { j: await Journal.open({ path: t.path, redactor: new Redactor(), account: "acct_fake", now: Date.now, windowRows: 25 }) }
    journals.push(t2.j)
    expect(t2.j.tail.seq).toBeGreaterThan(100)
    for (const slice of [300, 4096, 128 * 1024]) {
      const { out } = await allPages(t2.j, { limit: 9 }, slice)
      expect(out.map((e) => e.text)).toEqual(inMemory.map((e) => e.text))
    }
    // A search that matches nothing reads the whole file, and says how far back.
    const none = await queryJournal({ text: "zzzz" }, deps(t2.j, new Redactor(), 300))
    expect(none.entries).toEqual([])
    expect(none.more).toBeUndefined()
    expect(none.oldest).toBe(new Date(T0).toISOString())
  })

  test("a page stops at 64 KB", async () => {
    const t = await journalAt()
    // Cards read back many times: each entry carries every row's seq.
    for (let n = 0; n < 60; n++) {
      await buy(t, n)
      for (let c = 0; c < 200; c++) await t.add({ type: "operation.check", mode: "live", agent: "momentum", opId: `op_${n}`, outcome: "unclear" })
    }
    const page = await queryJournal({ limit: 100 }, deps(t.j))
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(64 * 1024)
    expect(page.entries.length).toBeLessThan(60)
    expect(page.more).toBeDefined()
    const next = await queryJournal({ limit: 100, before: page.more! }, deps(t.j))
    expect(page.entries.length + next.entries.length).toBe(60)
  })

  test("a newer query from the same view stops this one at its next slice", async () => {
    const t = await busy(10)
    let current = true
    const page = queryJournal({ text: "zzzz" }, { ...deps(t.j, new Redactor(), 300), current: () => current })
    current = false
    expect(await page).toMatchObject({ entries: [], superseded: true })
  })
})

describe("what leaves", () => {
  test("passes the redactor again, and the details read a card's rows as recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrn-jq-"))
    dirs.push(dir)
    const path = join(dir, "journal.jsonl")
    // A row from before the key was known, as a copied state folder could hold, and a torn line.
    const secret = ["cndl", "live", "z".repeat(40)].join("_")
    writeFileSync(path, `${JSON.stringify({ seq: 1, at: new Date(T0).toISOString(), type: "cli.refused", account: "acct_fake", mode: "live", command: "keys list", message: `used ${secret}` })}\n{"seq":2,"at`)
    const redactor = new Redactor()
    redactor.add(secret)
    const t = await journalAt({ path, redactor, windowRows: 1 })
    await buy(t, 1)
    const before = readFileSync(path)
    const page = await queryJournal({ limit: 100 }, deps(t.j, redactor, 64))
    expect(JSON.stringify(page)).not.toContain(secret)
    expect(page.entries.map((e) => e.kind)).toEqual(["trades", "core", "cards"])
    const rows = await journalRows(page.entries[0]!.seqs, deps(t.j, redactor))
    expect(rows.rows.map((r) => r.type)).toEqual(["card.created", "card.approved", "operation.submitting", "operation.succeeded"])
    const old = await journalRows([1], deps(t.j, redactor, 64))
    expect(old.rows).toHaveLength(1)
    expect(JSON.stringify(old)).not.toContain(secret)
    // Reading writes nothing.
    expect(readFileSync(path).equals(before)).toBe(true)
    appendFileSync(path, "")
  })
})
