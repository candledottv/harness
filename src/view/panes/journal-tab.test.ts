// The Journal pane: its lines from the core's own answer over a scene's rows, the empty
// and failed states, the kind chips, and the keys: the search line takes keys only while it's focused,
// Enter there never approves, ↓ past the last row reads the next page, ctrl-o shows a row's rows.
import { describe, expect, test } from "bun:test"
import type { JournalPage } from "../../core/journal-query"
import { journalScenePage } from "../../../test/journal-scene"
import { journalContext, mergeFirst } from "../journal-feed"
import { EMPTY_VIEW } from "../store"
import { type Effect, INITIAL_UI, step, type UiAction, type UiContext, type UiState } from "../keys"
import { hintsHere } from "../keymap"
import type { ViewCard } from "../store"
import { picksOf } from "../trade-tab"
import { textOf } from "./lines"
import { journalHead, type JournalHeld, journalKey, journalLines, journalRowsLines, journalRowsText, toggleKind } from "./journal"

const CLOCK = 1_800_000_000_000
const held = async (params: Record<string, unknown> = {}, empty = false): Promise<JournalHeld> => {
  const page = await journalScenePage(CLOCK, { limit: 50, ...params }, empty)
  return { key: journalKey(undefined), entries: page.entries, ...(page.more ? { more: page.more } : {}), ...(page.oldest ? { oldest: page.oldest } : {}) }
}

describe("the lines", () => {
  test("a row each, newest first, under a divider for each day; none wider than the pane; older's chip at the foot", async () => {
    const h = await held()
    for (const width of [24, 40, 77, 117, 137, 157]) {
      const lines = journalLines(h, undefined, { width, now: CLOCK })
      for (const l of [...journalHead(undefined, width), ...lines]) expect(textOf(l).length).toBeLessThanOrEqual(width)
      expect(textOf(lines[0]!)).toStartWith("── today")
      expect(lines.some((l) => textOf(l).startsWith("── yesterday"))).toBe(true)
      expect(lines.at(-1)!.segs[0]!.act).toBe("journalOlder")
    }
    // Each row is one pick, whatever its wrap; only a row about a token moves the link or asks.
    const picks = picksOf(journalLines(h, undefined, { width: 60, now: CLOCK }))
    expect(picks).toHaveLength(h.entries.length)
    const card = picks.find((p) => p.mint !== "")!
    expect(card.ask).toContain("What do you make of JUPF? From the Journal, today")
    expect(picks.find((p) => p.mint === "")?.ask).toBeUndefined()
  })

  test("before its first page, a fresh install, a search that found nothing, a failed read, the journal's start", async () => {
    const lines = (h: JournalHeld | undefined, query = "") => journalLines(h, { query }, { width: 100, now: CLOCK }).map(textOf)
    expect(lines(undefined)).toEqual(["Reading the journal…"])
    expect(lines({ key: "k", entries: [], loading: "first" }, "jup")).toEqual(["Searching the journal…"])
    expect(lines(await held({}, true))[0]).toStartWith("Nothing recorded yet.")
    expect(lines({ key: "k", entries: [], oldest: new Date(CLOCK - 86_400_000).toISOString() }, "zzz")[0]).toStartWith("Nothing matched, searching everything recorded back to yesterday")
    expect(lines({ key: "k", entries: [], failed: "The core isn't running." })[0]).toBe("The journal didn't answer: The core isn't running.")
    const all = await journalScenePage(CLOCK, { limit: 100, text: "rejected" })
    expect(lines({ key: "k", entries: all.entries }, "rejected").at(-1)).toBe(`The journal's start: ${all.entries.length} rows matched.`)
  })

  test("a searched row whose words don't show the match says where it matched, dim under it", async () => {
    const h = await held()
    const e = { ...h.entries[0]!, matched: "its reply: …add a stake in CNDL…" }
    const lines = (query: string) => journalLines({ ...h, entries: [e] }, { query }, { width: 100, now: CLOCK }).map(textOf)
    expect(lines("stake")).toContain("       matched in its reply: …add a stake in CNDL…")
    expect(lines("").some((l) => l.includes("matched in"))).toBe(false)
  })

  test("the head: the search line, shaded with a cursor while it takes keys, and a chip for each kind, the core's off", () => {
    const [search, chips] = journalHead({ query: "jup", editing: true }, 137)
    expect(textOf(search!)).toContain("jup▏")
    expect(textOf(search!)).toContain("esc back to the line")
    expect(search!.bg).toBeDefined()
    expect(textOf(chips!)).toContain("✓ trades")
    expect(textOf(chips!)).toMatch(/ core /)
    expect(textOf(chips!)).not.toContain("✓ core")
    expect(chips!.segs.filter((s) => s.act === "journalKind").map((s) => s.ref)).toEqual(["trades", "cards", "kill", "hacc", "memory", "agents", "bots", "view", "core"])
    // Narrow, the chips still take one row.
    expect(journalHead(undefined, 77)).toHaveLength(2)
  })

  test("kinds: on and off, and the last one on stays on", () => {
    const off = toggleKind(undefined, "trades")
    expect(off.kinds).not.toContain("trades")
    expect(toggleKind(off, "core").kinds).toContain("core")
    expect(toggleKind({ query: "", kinds: ["memory"] }, "memory").kinds).toEqual(["memory"])
    expect(journalKey(off)).not.toBe(journalKey(undefined))
  })

  test("a row's details: each row as recorded, one JSON line, and ⧉ copies them", () => {
    const rows = [{ seq: 1, type: "card.created" }, { seq: 2, type: "card.approved" }]
    expect(journalRowsLines({ id: "1", rows })).toEqual([JSON.stringify(rows[0]), "", JSON.stringify(rows[1])])
    expect(journalRowsText({ id: "1", rows })).toBe(rows.map((r) => JSON.stringify(r)).join("\n"))
    expect(journalRowsLines({ id: "1" })).toEqual(["Reading its rows…"])
  })

  test("a fresh first page keeps the older pages read under it", async () => {
    const all = (await journalScenePage(CLOCK, { limit: 100 })).entries
    const first: JournalPage = { entries: all.slice(0, 10), more: "next-1", scanned: 10 }
    const read: JournalHeld = { key: "k", entries: all.slice(0, 30), more: "next-3" }
    const merged = mergeFirst(read, { ...first, entries: [{ ...all[0]!, text: "changed" }, ...all.slice(1, 10)] }, "k")
    expect(merged.entries).toHaveLength(30)
    expect(merged.entries[0]!.text).toBe("changed")
    expect(merged.more).toBe("next-3")
    expect(mergeFirst(read, first, "other").entries).toHaveLength(10)
  })
})

describe("the keys", () => {
  const card: ViewCard = { cardId: "c1", opId: "o1", cardHash: "h", kind: "trade", tool: "candle_trade", agent: "agent-a", state: "awaiting_approval", expiresAt: new Date(CLOCK + 60_000).toISOString(), side: "buy", display: { title: "BUY", agent: "agent-a", wallet: "W", mode: "live", expiresAt: new Date(CLOCK + 60_000).toISOString() } }
  const rows = [
    { id: "40", mint: "", line: 0 },
    { id: "38", mint: "JupFake1", line: 1 },
  ]
  const ctx = (over: Partial<UiContext> = {}): UiContext => ({
    cards: [card],
    seenAt: { c1: 0 },
    mode: "live",
    agents: ["agent-a"],
    activeAgent: "agent-a",
    commands: { agents: ["agent-a"], knownTokens: new Map() },
    picks: { journal: rows },
    journal: { more: true, seqsOf: (id) => (id === "38" ? [38, 39, 41] : [40]) },
    ...over,
  })
  const key = (name: string, extra: Record<string, unknown> = {}): UiAction => ({ type: "key", key: { name, sequence: name.length === 1 ? name : undefined, ...extra }, now: CLOCK })
  const run = (actions: UiAction[], c: UiContext = ctx(), start: UiState = { ...INITIAL_UI, focus: "journal" }) => {
    let state = start
    const effects: Effect[] = []
    for (const a of actions) {
      const r = step(state, a, c)
      state = r.state
      effects.push(...r.effects)
    }
    return { state, effects }
  }

  test("↑ in the Journal takes the search line; typing searches; ⏎ keeps it and never approves; Esc gives the keys back", () => {
    const typing = run([key("up"), key("j"), key("u"), key("p"), key("?")])
    expect(typing.state.journal).toEqual({ query: "jup?", editing: true })
    expect(typing.state.input).toBe("")
    expect(typing.state.overlay).toBeUndefined()
    // ⏎ with a card waiting and the line empty: the search keeps, nothing is approved.
    const enter = run([key("return")], ctx(), typing.state)
    expect(enter.effects).toEqual([])
    expect(enter.state.journal).toEqual({ query: "jup?" })
    expect(enter.state.focus).toBe("journal")
    const esc = run([key("escape")], ctx(), typing.state)
    expect(esc.state.journal?.editing).toBeUndefined()
    expect(esc.state.focus).toBe("agent")
    // ⌫ and ctrl-u edit the search; a paste goes into it.
    expect(run([key("backspace")], ctx(), typing.state).state.journal?.query).toBe("jup")
    expect(run([key("u", { ctrl: true })], ctx(), typing.state).state.journal?.query).toBe("")
    expect(run([{ type: "paste", text: " filled\n", now: CLOCK }], ctx(), typing.state).state.journal?.query).toBe("jup? filled ")
  })

  test("the hint line says what Esc does there, and offers no approve; on the Journal, that ↑ searches", () => {
    const words = hintsHere({ empty: true, card: true, searching: true }).map((h) => `${h.chord} ${h.words}`)
    expect(words).toContain("esc back to the line")
    expect(words.some((w) => w.includes("approve"))).toBe(false)
    expect(hintsHere({ empty: true, card: false, journal: true }).map((h) => `${h.chord} ${h.words}`)).toContain("↑ search")
  })

  test("while the next page is read, ↓ past the last row waits for it rather than leaving the Journal", () => {
    const size = { width: 140, height: 40 }
    expect(journalContext({ ...EMPTY_VIEW, journal: { key: "k", entries: [], loading: "older" } }, size).more).toBe(true)
    expect(journalContext({ ...EMPTY_VIEW, journal: { key: "k", entries: [] } }, size).more).toBe(false)
  })

  test("the search's chip takes keys; a click elsewhere gives them back; a kind chip starts the rows again", () => {
    const chip = run([{ type: "journalSearch", now: CLOCK }], ctx(), INITIAL_UI)
    expect(chip.state.focus).toBe("journal")
    expect(chip.state.journal?.editing).toBe(true)
    const away = run([{ type: "clickPane", pane: "token", now: CLOCK }], ctx(), chip.state)
    expect(away.state.journal?.editing).toBeUndefined()
    const scrolled: UiState = { ...INITIAL_UI, scroll: { journal: { rows: 5 } } }
    const kind = run([{ type: "journalKind", kind: "core", now: CLOCK }], ctx(), scrolled)
    expect(kind.state.journal?.kinds).toContain("core")
    expect(kind.state.scroll.journal).toBeUndefined()
  })

  test("↓ from the search to the first row; past the last, the next page; ↑ from the first, the search again", () => {
    const first = run([key("up"), key("down")])
    expect(first.state.journal?.editing).toBeUndefined()
    expect(first.state.highlight?.journal?.id).toBe("40")
    const last = run([key("down"), key("down")], ctx(), first.state)
    expect(last.state.highlight?.journal?.id).toBe("38")
    expect(last.effects).toContainEqual({ type: "journalOlder" })
    expect(run([key("up")], ctx(), first.state).state.journal?.editing).toBe(true)
    // With nothing more to read, ↓ past the last goes on as in any pane.
    expect(run([key("down"), key("down"), key("down")], ctx({ journal: { more: false, seqsOf: () => undefined } })).effects).not.toContainEqual({ type: "journalOlder" })
  })

  test("a row with no token is highlighted, never the link; one with a token is; ctrl-o shows the row's rows", () => {
    const plain = run([{ type: "clickRow", pane: "journal", pick: { id: "40", mint: "" }, now: CLOCK }, { type: "tick", now: CLOCK + 1_000 }])
    expect(plain.effects.filter((e) => e.type === "link")).toEqual([])
    expect(plain.state.highlight?.journal?.id).toBe("40")
    const token = run([{ type: "clickRow", pane: "journal", pick: { id: "38", mint: "JupFake1" }, now: CLOCK }])
    expect(token.effects).toContainEqual({ type: "link", mint: "JupFake1", from: "journal, by a click" })
    const details = run([key("o", { ctrl: true })], ctx(), token.state)
    expect(details.state.overlay).toEqual({ kind: "journalRows", id: "38" })
    expect(details.effects).toEqual([{ type: "journalRows", id: "38", seqs: [38, 39, 41] }])
    // It scrolls, within what it holds, and any other key closes it.
    const scrolled = run([key("down"), key("down")], ctx({ journal: { more: true, seqsOf: () => [38], rowsMax: 1 } }), details.state)
    expect(scrolled.state.overlay).toEqual({ kind: "journalRows", id: "38", scroll: 1 })
    expect(run([key("x")], ctx(), scrolled.state).state.overlay).toBeUndefined()
    // Elsewhere, ctrl-o is the card's details, as ever.
    expect(run([key("o", { ctrl: true })], ctx(), { ...INITIAL_UI, focus: "agent" }).state.overlay).toEqual({ kind: "card", cardId: "c1" })
  })
})
