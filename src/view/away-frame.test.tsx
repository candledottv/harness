// While you were away on screen: the note at the top of the agent pane in the
// view whose attach made the summary, its chips, and every section over the frame (show all, the palette's
// row), from a realistic gap and from a gap with the core gone. Kept as frames, as frames.test.tsx keeps the
// Trade tab's.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import type { AwayView } from "../core/away"
import { goneAway, realisticAway } from "../../test/away-scene"
import { CLOCK, drawScene } from "../../test/frame-scenes"
import { AWAY_ASK, awayLines, awayNoteItems, awayNoteLines } from "./panes/away"
import { textOf } from "./panes/lines"

process.env.TZ = "UTC"
const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

const SIZES = [
  [160, 45],
  [120, 30],
  [80, 24],
] as const

async function away(width: number, height: number, view: AwayView) {
  const drawn = await drawScene("followed", width, height, "trade")
  setup = drawn.setup
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(topic, data, snapshot))
    await drawn.setup.renderOnce()
  }
  // The scene's own card goes, so the note's rows are what's drawn; one test puts a card back.
  await push("cards", [], true)
  await push("away", view, true)
  return { ...drawn, push }
}

async function compare(name: string, s: Setup): Promise<void> {
  const chars = s.captureCharFrame()
  const runs = s
    .captureSpans()
    .lines.map((l, y) => `${y}: ${l.spans.map((sp) => `${[sp.fg.r, sp.fg.g, sp.fg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}/${[sp.bg.r, sp.bg.g, sp.bg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}${sp.attributes ? `+${sp.attributes}` : ""}×${sp.width}`).join(" ")}`)
    .join("\n")
  const got = `${chars}\n--- colours ---\n${runs}\n`
  const file = join(DIR, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) throw new Error(`No frame kept for ${name}: run with UPDATE_FRAMES=1 to keep this one.\n${got}`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, got)
    return
  }
  expect(got).toBe(readFileSync(file, "utf8"))
}

async function input(s: Setup, run: () => void | Promise<void>) {
  await act(async () => {
    await run()
  })
  await s.renderOnce()
}

/** Clicks the chip whose text is `label`, on the first row that holds it. */
async function click(s: Setup, label: string) {
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes(` ${label} `))
  expect(y).toBeGreaterThanOrEqual(0)
  await input(s, () => s.mockMouse.click(rows[y]!.indexOf(` ${label} `) + 1, y))
}

const openAll = (s: Setup) => input(s, async () => {
  s.mockInput.pressKey("k", { ctrl: true })
  await s.renderOnce()
  s.mockInput.typeText("while you were away")
  await s.renderOnce()
  s.mockInput.pressEnter()
})

for (const [width, height] of SIZES) {
  test(`the note on startup, from a realistic gap, at ${width}×${height}`, async () => {
    const d = await away(width, height, realisticAway())
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("While you were away · 3h 12m")
    expect(frame).toContain("show all")
    // In order of weight: the refusal, then the trades, then outside the Candle Harness, P&L and signals.
    const at = (words: string) => frame.indexOf(words)
    expect(at("refused")).toBeGreaterThan(0)
    expect(at("3 trades")).toBeGreaterThan(at("refused"))
    expect(frame).toContain("2 filled (2 without a card)")
    await compare(`away-${width}x${height}-note`, d.setup)
  })

  test(`show all, from a realistic gap, at ${width}×${height}`, async () => {
    const d = await away(width, height, realisticAway())
    await click(d.setup, "show all")
    const frame = d.setup.captureCharFrame()
    expect(frame).toMatch(/╭─ While you were away · 3h 12m|╭─ Away · 3h 12m/)
    expect(frame).toContain("Trades · 3")
    expect(frame).toContain("esc closes")
    await compare(`away-${width}x${height}-all`, d.setup)
  })

  test(`the note and show all with the core gone, at ${width}×${height}`, async () => {
    const d = await away(width, height, goneAway())
    expect(d.setup.captureCharFrame()).toContain("The core wasn't running: nothing ran i")
    await compare(`away-${width}x${height}-gone-note`, d.setup)
    await openAll(d.setup)
    expect(d.setup.captureCharFrame()).toContain("From yesterday 22:19")
    await compare(`away-${width}x${height}-gone-all`, d.setup)
  })
}

test("the note shows on whichever tab the view opens on: the Cockpit at 120×30 too, over the welcome", async () => {
  for (const scene of ["followed", "fresh"] as const) {
    const drawn = await drawScene(scene, 120, 30, "cockpit")
    setup = drawn.setup
    await act(async () => drawn.session.push("away", realisticAway(), true))
    await drawn.setup.renderOnce()
    expect(drawn.setup.captureCharFrame()).toContain("While you were away · 3h 12m")
    await act(async () => drawn.setup.dispose())
    setup = undefined
  }
})

test("the note shows only in the view whose attach made the summary, and only when something happened", async () => {
  const other = realisticAway()
  other.summary!.forView = "v2"
  const d = await away(120, 30, other)
  expect(d.setup.captureCharFrame()).not.toContain("While you were away")
  const quiet = goneAway()
  quiet.summary!.happened = false
  await d.push("away", quiet)
  expect(d.setup.captureCharFrame()).not.toContain("While you were away")
})

test("✕ dismisses the note, ask puts the question on the input line, and the next message ends it", async () => {
  const d = await away(120, 30, realisticAway())
  await click(d.setup, "ask")
  expect(d.setup.captureCharFrame()).toContain(AWAY_ASK)
  expect(d.setup.captureCharFrame()).toContain("While you were away")
  await input(d.setup, () => d.setup.mockInput.pressEnter())
  expect(d.session.requests.find((r) => r.method === "agent.send")?.params).toEqual({ text: AWAY_ASK })
  expect(d.setup.captureCharFrame()).not.toContain("While you were away")

  // A new summary shows again; ✕ ends it, and nothing is sent.
  const next = realisticAway()
  next.summary!.id = "next"
  await d.push("away", next)
  expect(d.setup.captureCharFrame()).toContain("While you were away")
  const sent = d.session.requests.length
  await click(d.setup, "✕")
  expect(d.setup.captureCharFrame()).not.toContain("While you were away")
  expect(d.session.requests.slice(sent).filter((r) => r.method !== "view.active" && r.method !== "view.set")).toEqual([])
})

test("a turn the person sent from elsewhere ends the note too: drawn over meanwhile, it doesn't come back", async () => {
  const d = await away(120, 30, realisticAway())
  expect(d.setup.captureCharFrame()).toContain("While you were away")
  const agent = d.setup.captureCharFrame().match(/╭─ (\S+)/)?.[1] ?? ""
  // A message from another view (or a script) starts a turn this view sees start.
  await d.push("agent", { type: "started", agent, turnId: "t-elsewhere", user: "what did I miss?" })
  await d.push("agent", { type: "ended", agent, turnId: "t-elsewhere", text: "Not much.", outcome: "ok" })
  expect(d.setup.captureCharFrame()).not.toContain("While you were away")
})

test("show all opens over the frame and changes no layout; ↑/↓ scroll it and any other key closes it: a click never adds a pane", async () => {
  const d = await away(120, 30, realisticAway())
  const before = d.setup.captureCharFrame()
  await click(d.setup, "show all")
  let frame = d.setup.captureCharFrame()
  expect(frame).toMatch(/╭─ While you were away · 3h 12m/)
  expect(frame).not.toContain("unsaved changes")
  expect(d.session.requests.filter((r) => r.method.startsWith("layout"))).toEqual([])
  // At 120×30 it doesn't all fit: ↓ scrolls, and the footer says what's out of view.
  expect(frame).toMatch(/↓ \d+ more/)
  await input(d.setup, () => d.setup.mockInput.pressArrow("down"))
  frame = d.setup.captureCharFrame()
  expect(frame).toMatch(/↑ 1 above/)
  // Esc waits out the terminal's escape-sequence timeout before it counts as a key.
  await input(d.setup, async () => {
    d.setup.mockInput.pressEscape()
    await Bun.sleep(30)
  })
  expect(d.setup.captureCharFrame()).toBe(before)
})

test("a token's row in it picks the token and closes it", async () => {
  const d = await away(160, 45, realisticAway())
  await click(d.setup, "show all")
  const rows = d.setup.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes("│") && r.includes("BUY $1.00 of JUPF"))
  expect(y).toBeGreaterThan(0)
  await input(d.setup, () => d.setup.mockMouse.click(rows[y]!.indexOf("BUY $1.00 of JUPF") + 2, y))
  expect(d.setup.captureCharFrame()).not.toMatch(/╭─ While you were away/)
  expect(d.session.requests.some((r) => JSON.stringify(r.params ?? {}).includes("while you were away, by a click"))).toBe(true)
})

test("the note never covers a waiting card: at 80×24 it gives up its lines first", async () => {
  const d = await away(80, 24, realisticAway())
  await d.push("cards", [
    {
      cardId: "c9",
      opId: "op-c9",
      cardHash: "hash-c9",
      kind: "trade",
      tool: "candle_trade",
      agent: "agent-a",
      state: "awaiting_approval",
      expiresAt: new Date(CLOCK + 58_000).toISOString(),
      side: "buy",
      params: { side: "buy", amountUsd: "3" },
      display: { title: "BUY $3.00 of JUPF", headline: "BUY $3.00 of JUPF", agent: "agent-a", wallet: "embedded", mode: "live", expiresAt: new Date(CLOCK + 58_000).toISOString(), valueUsd: 3 },
    },
  ], true)
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("BUY $3.00 of JUPF")
  expect(frame).toContain("While you were away")
  await compare("away-80x24-note-card", d.setup)
})

test("the note's lines fit what they're given, the head and its chips last", () => {
  const s = realisticAway().summary!
  expect(awayNoteLines(s, 60, 0, CLOCK)).toEqual([])
  expect(awayNoteLines(s, 60, 1, CLOCK).map(textOf)[0]).toContain("While you were away")
  const full = awayNoteLines(s, 60, 20, CLOCK)
  // A box round the head and five lines at most, then a blank row.
  expect(full.length).toBeLessThanOrEqual(9)
  expect(full.every((l) => textOf(l).length <= 60)).toBe(true)
  expect(textOf(full[0]!)).toBe(`╭${"─".repeat(58)}╮`)
  expect(textOf(full[1]!)).toStartWith("│ While you were away")
  expect(textOf(full.at(-2)!)).toBe(`╰${"─".repeat(58)}╯`)
  expect(textOf(full.at(-1)!)).toBe("")
  // Short of rows, lines go first, then the blank row, but the box keeps one line: a note never shows only its head.
  const first = awayNoteItems(s, CLOCK)[0]!.text
  const four = awayNoteLines(s, 60, 4, CLOCK).map(textOf)
  expect(four).toEqual([`╭${"─".repeat(58)}╮`, expect.stringMatching(/^│ While you were away/), expect.stringContaining(first.slice(0, 20)), `╰${"─".repeat(58)}╯`])
  // No room for the box and a line: the head unboxed on a row, its chips beside it, and the lines under it.
  const three = awayNoteLines(s, 60, 3, CLOCK).map(textOf)
  expect(three).toHaveLength(3)
  expect(three[0]).toStartWith("While you were away")
  expect(three[0]).toContain("show all")
  expect(three[1]).toContain(first.slice(0, 20))
  // One row: the head and the weightiest line share it.
  const one = awayNoteLines(s, 60, 1, CLOCK).map(textOf)
  expect(one).toHaveLength(1)
  expect(one[0]).toStartWith("While you were away")
  expect(one[0]).toContain(first.slice(0, 10))
  // Nothing to list: no note at all.
  expect(awayNoteLines({ ...s, counts: { ...s.counts, stopped: 0, trades: 0, outside: 0, maybe: 0, triggers: 0, botTrades: 0, botHeld: 0, signals: 0, turns: 0, cards: 0, holdings: 0, changes: 0 }, pnl: { ...s.pnl, state: "reading" }, coreDown: [] } as typeof s, 60, 20, CLOCK)).toEqual([])
})

test("a live sell Candle closed as paper isn't counted as filled, nor as a paper-mode trade", () => {
  const s = realisticAway().summary!
  const [first, second] = [s.trades[0]!, s.trades[1] ?? s.trades[0]!]
  s.trades = [{ ...first, outcome: "filled", paper: undefined, withoutCard: undefined }, { ...second, outcome: "not-sold", paper: undefined, withoutCard: undefined }]
  s.counts.trades = 2
  const line = awayNoteItems(s, CLOCK).map((i) => i.text).find((t) => t.startsWith("2 trades"))!
  expect(line).toBe("2 trades: 1 filled, 1 not sold live (Candle closed a paper position)")
})

test("the Away pane before anything, on a first run, and after a quiet gap", () => {
  const text = (v: AwayView | undefined) => awayLines(v, { width: 60, now: CLOCK }).map(textOf).join(" ")
  expect(text(undefined)).toContain("Reading")
  expect(text({ summary: null, firstRun: true })).toContain("closed for 10 minutes or more and opened again")
  const quiet = goneAway()
  const s = quiet.summary!
  s.happened = false
  expect(text(quiet)).toContain("Nothing happened while you were away · 9h 40m")
  expect(text(quiet)).toContain("The core wasn't running the whole time")
})

test("rows that name a token are picks with ctrl-t's question; addresses carry ⧉", () => {
  const lines = awayLines(realisticAway(), { width: 100, now: CLOCK })
  const trades = lines.filter((l) => l.pick?.mint && textOf(l).includes("JUPF"))
  expect(trades.length).toBeGreaterThan(2)
  expect(trades.every((l) => l.pick!.ask?.includes("JUPF"))).toBe(true)
  expect(lines.some((l) => l.segs.some((s) => s.act === "copy"))).toBe(true)
})

test("the triggers: a section of their own, a line in the note, and run it now on a trigger's card nobody pressed", () => {
  const v = realisticAway()
  const s = v.summary!
  const at = new Date(s.from + 30 * 60_000).toISOString()
  s.triggers = [
    { at, last: at, agent: "agent-a", mode: "live", text: 'trigger "dip": BUY $1.50 of JUP waits for you: the embedded wallet asks every time', tone: "warn", seqs: [901] },
    { at, last: at, agent: "agent-a", mode: "live", text: 'trigger "dip" fired: JUP was $0.39, under $0.40', tone: "info", seqs: [900] },
  ]
  s.counts = { ...s.counts, triggers: 2, fired: 1 }
  s.trades = [{ at, last: at, agent: "agent-a", mode: "live", text: 'trigger "dip" proposed BUY $1.50 of JUP · expired, never ran', tone: "info", seqs: [902], outcome: "expired", trigger: "dip", runNow: "card_t" }, ...s.trades]
  s.counts.trades += 1
  const lines = awayLines(v, { width: 96, now: s.to })
  const all = lines.map(textOf)
  expect(all).toContain("Triggers · 1 firing")
  expect(all.some((l) => l.includes('trigger "dip" fired: JUP was $0.39, under $0.40'))).toBe(true)
  const chip = lines.flatMap((l) => l.segs).find((seg) => seg.act === "runNow")
  expect(chip).toMatchObject({ ref: "card_t" })
  expect(awayNoteItems(s, s.to).map((i) => i.text)).toContain("Triggers: 1 firing, 1 waited for you")
})

test("the bots: a line in the note and a section of their own, each bot's P&L the Candle Harness's count, what was held first", () => {
  const v = realisticAway()
  const s = v.summary!
  const at = new Date(s.from + 40 * 60_000).toISOString()
  s.bots = [
    {
      name: "conf",
      agent: "agent-a",
      mode: "live",
      bought: 3,
      sold: 2,
      exits: { "take profit": 1, stop: 1 },
      skipped: 4,
      trades: [{ at, last: at, agent: "agent-a", mode: "live", text: 'the bot "conf" proposed SELL 100 JUP from embedded · without a card, as its bot\'s exit · filled in 3.1 s', tone: "good", seqs: [950] }],
      held: [{ at, last: at, agent: "agent-a", mode: "live", text: 'the bot "conf": its buy of $1.50 of WIF waits for you: the embedded wallet asks every time', tone: "warn", seqs: [951] }],
      realizedUsd: 0.62,
      open: [{ mint: "WifFake111111111111111111111111111111111111", symbol: "WIF" }],
    },
  ]
  s.counts = { ...s.counts, botTrades: 5, botHeld: 1 }
  expect(awayNoteItems(s, s.to).map((i) => i.text)).toContain("conf: bought 3, sold 2 (1 at its take profit, 1 at its stop), 4 skipped · P&L +$0.62 · 1 open (WIF) · 1 held or refused")
  const all = awayLines(v, { width: 120, now: s.to }).map(textOf)
  const head = all.indexOf("Bots · 1 bot")
  expect(head).toBeGreaterThan(-1)
  expect(all[head + 1]).toContain("the Candle Harness's count from its own fills")
  expect(all.slice(head + 2, head + 6)).toEqual(["  conf", "    bought 3, sold 2 (1 at its take profit, 1 at its stop), 4 skipped", "    P&L over the gap +$0.62, from what its exits sold", "    still open: WIF"])
  expect(all[head + 6]).toContain("waits for you")
  expect(all[head + 7]).toContain("filled in 3.1 s")
  // In a narrow overlay its P&L and what's still open wrap onto lines of their own, never cut off.
  s.bots[0]!.skipped = 225
  s.bots[0]!.open = ["Jose", "TAOLF", "APU"].map((symbol, i) => ({ mint: `Mint${i}111111111111111111111111111111111111`, symbol }))
  const narrow = awayLines(v, { width: 56, now: s.to }).map(textOf)
  expect(narrow).toContain("    stop), 225 skipped")
  expect(narrow).toContain("    P&L over the gap +$0.62, from what its exits sold")
  expect(narrow).toContain("    still open: Jose, TAOLF, APU")
})

test("a stretch with the core down that began on another day names today at its end", () => {
  const v = goneAway()
  const s = v.summary!
  s.coreGoneThroughout = false
  const end = new Date(s.to - 60_000)
  const start = new Date(end.getTime() - 25 * 3_600_000)
  s.coreDown = [{ from: start.getTime(), to: end.getTime() }]
  const text = awayLines(v, { width: 120, now: s.to }).map(textOf).join(" ")
  const hhmm = (d: Date) => d.toTimeString().slice(0, 5)
  expect(text).toContain(`The core wasn't running from yesterday ${hhmm(start)} to today ${hhmm(end)}`)
})

test("a wallet's change no trade this Candle Harness sent explains says so, in the note and the section", () => {
  const v = realisticAway()
  const s = v.summary!
  s.holdings = { state: "read", then: s.from, changes: [{ wallet: "W1", name: "embedded", asset: "SOL", symbol: "SOL", then: 0.0479, now: 0.0437, outside: true }] }
  s.counts = { ...s.counts, holdings: 1 }
  const said = "embedded wallet: SOL 0.0479 → 0.0437, not from this Candle Harness's trades (other keys pay from this wallet)"
  expect(awayNoteItems(s, s.to).map((i) => i.text)).toContain(said)
  expect(awayLines(v, { width: 200, now: s.to }).map(textOf).some((l) => l.includes(said))).toBe(true)
})

test("the note's P&L says live beside a paper bot, since it's Candle's books and the bot's own figure is paper", () => {
  const view = realisticAway()
  const s = view.summary!
  const plain = awayNoteItems(s, CLOCK).find((i) => i.text.includes("since last session"))!
  expect(plain.text.startsWith("P&L since last session")).toBe(true)
  const withPaperBot = { ...s, bots: [{ name: "conf", mode: "paper" as const, bought: 1, sold: 1, exits: {}, skipped: 0, trades: [], held: [], realizedUsd: -0.07 }] }
  const live = awayNoteItems(withPaperBot, CLOCK).find((i) => i.text.includes("since last session"))!
  expect(live.text.startsWith("live P&L since last session")).toBe(true)
})
