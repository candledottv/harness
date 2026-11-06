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
  // Short of rows, lines go first, then the blank row; the box stays round the head while it fits.
  expect(awayNoteLines(s, 60, 3, CLOCK).map(textOf)).toEqual([`╭${"─".repeat(58)}╮`, expect.stringMatching(/^│ While you were away/), `╰${"─".repeat(58)}╯`])
  expect(awayNoteLines(s, 60, 2, CLOCK).map(textOf)[0]).toStartWith("While you were away")
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
