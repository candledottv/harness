// The P&L tab: its four panes from Candle's recorded books, the window's chip and menu, the chart's spans and
// gaps, and the typed `pnl since …`. Every figure says whose it is, and paper is never added to live.
import { describe, expect, test } from "bun:test"
import { pnlScene, pnlSeriesScene } from "../../../test/pnl-scene"
import type { PnlView } from "../../core/pnl"
import { bucketsOnTimeline, gappedChart } from "../chart"
import { parseCommand } from "../../shared/commands"
import { type Effect, INITIAL_UI, type Key, SETTINGS, step, type UiAction, type UiContext, type UiState } from "../keys"
import { paletteRows, type PaletteInput } from "../palette-rows"
import { applyEvent, EMPTY_VIEW } from "../store"
import { type Line, textOf } from "./lines"
import {
  PNL_POSITIONS_TITLE,
  type PnlSeries,
  pnlChartLines,
  pnlLines,
  pnlPositionLines,
  pnlTitle,
  pnlWindowRows,
  spanFrom,
  tradeLines,
  tradesTitle,
  windowChip,
} from "./pnl"
import { borderChip, PANES, paneLines } from "./registry"

process.env.TZ = "UTC"
const NOW = Date.parse("2027-01-15T08:00:00Z")
const texts = (lines: Line[]) => lines.map(textOf)
const WIDTHS = [24, 40, 56, 76, 120]

describe("the P&L pane", () => {
  const full = pnlScene(NOW, "full")

  test("the window's figure, then the Candle Harness's agents' books, each agent's, and the rounds another agent opened", () => {
    const out = texts(pnlLines(full, { width: 76, now: NOW }))
    expect(out[0]).toBe("last 24h  +$0.31")
    expect(out[1]).toBe("The change in Candle's totals, from the Candle Harness's samples.")
    expect(out.find((l) => l.startsWith("agents"))).toMatch(/24h +total +realised +unrealised/)
    // Candle's books add up across the shared wallet, so the Candle Harness's agents are summed, and say they are.
    expect(out.find((l) => l.startsWith("together"))).toMatch(/\+\$0\.31 +-\$9\.86 +-\$1\.72 +-\$8\.14/)
    expect(out.find((l) => l.startsWith("agent-a"))).toMatch(/-\$0\.12 +-\$1\.35/)
    expect(out.find((l) => l.startsWith("agent-b"))).toMatch(/\+\$0\.43 +-\$8\.51/)
    expect(out).toContain("  incl. QUILL opened by agent-a, -$1.55")
    expect(out).toContain("fees $0.34, taken from realised · 1 swap not in Candle's fills, in Trades")
  })

  test("the wallets across agents: the shared one's agents named, its figures their books added", () => {
    const out = texts(pnlLines(full, { width: 76, now: NOW }))
    expect(out.find((l) => l.startsWith("embedded"))).toMatch(/-\$9\.76 +-\$1\.62 +-\$8\.14 +agent-a, agent-b/)
    expect(out.some((l) => l.startsWith("fake-label-1"))).toBe(true)
  })

  test("no line is wider than the pane, at any width", () => {
    for (const variant of ["full", "short", "failed", "paper", "fresh"] as const) {
      for (const width of WIDTHS) {
        for (const l of texts(pnlLines(pnlScene(NOW, variant), { width, now: NOW, mode: variant === "paper" ? "paper" : "live" }))) expect(l.length).toBeLessThanOrEqual(width)
      }
    }
  })

  test("narrower, the window's change and the total stay; realised and unrealised go first", () => {
    const narrow = texts(pnlLines(full, { width: 40, now: NOW }))
    expect(narrow.find((l) => l.startsWith("agents"))).toMatch(/24h +total$/)
  })

  test("a window the samples start late says from when, as the status bar does", () => {
    const out = texts(pnlLines(pnlScene(NOW, "short"), { width: 76, now: NOW }))
    // Named from the first sample, as the status bar names it, the window said after.
    expect(out[0]).toBe("since 04:46  +$0.31")
    expect(out[1]).toBe("The window is since midnight; the samples in it start at 04:46.")
    expect(windowChip("midnight")).toBe("today")
  })

  test("a read that failed says so in Candle's words, amber, and the agent's row isn't summed", () => {
    const lines = pnlLines(pnlScene(NOW, "failed"), { width: 76, now: NOW })
    const out = texts(lines)
    expect(out.some((l) => l.startsWith("together"))).toBe(false)
    const b = lines.find((l) => textOf(l).startsWith("agent-b"))!
    expect(textOf(b)).toContain("couldn't read: Rate limited: try again in 20 seconds")
    expect(b.segs[1]!.fg).not.toBe(b.segs[0]!.fg)
  })

  test("before any read, and with no agent, it says what it's waiting for, never 0", () => {
    const waiting = ["Reading each agent's P&L from Candle: its figures show here within a minute.", "Your P&L starts with your first fill."]
    expect(texts(pnlLines(pnlScene(NOW, "fresh"), { width: 80, now: NOW }))).toEqual(waiting)
    expect(texts(pnlLines(undefined, { width: 80, now: NOW }))).toEqual(waiting)
    const none: PnlView = { ...pnlScene(NOW, "fresh"), agents: [] }
    expect(texts(pnlLines(none, { width: 76, now: NOW })).join(" ")).toContain("No agent has a Candle key yet")
    expect(texts(pnlLines(none, { width: 76, now: NOW })).join(" ")).not.toContain("$0")
  })

  test("paper is its own block, ≈ at quoted prices, and never moves a live figure", () => {
    const paper = pnlScene(NOW, "paper")
    const withPaper = texts(pnlLines(paper, { width: 76, now: NOW, mode: "paper" }))
    expect(withPaper).toContain("paper, at quoted prices · never added to live")
    expect(withPaper.find((l) => l.startsWith("agent-a") && l.includes("≈"))).toContain("≈+$0.24")
    // In paper mode it comes before the live books; the live rows are the same as without paper.
    expect(withPaper.indexOf("paper, at quoted prices · never added to live")).toBeLessThan(withPaper.findIndex((l) => l.startsWith("agents")))
    const live = (out: string[]) => out.filter((l) => /^(last 24h|together|agent-[ab] +[+-]\$|embedded)/.test(l) && !l.includes("≈"))
    expect(live(withPaper)).toEqual(live(texts(pnlLines(full, { width: 76, now: NOW }))))
  })

  test("each rules bot from its own fills, its own block, never added to Candle's; a paper bot's ≈", () => {
    const p: PnlView = {
      ...full,
      bots: [
        { name: "conf", agent: "agent-a", mode: "live", open: 2, closed: 5, realizedUsd: 1.2, unrealizedUsd: -0.3 },
        { name: "dip", agent: "agent-b", mode: "paper", open: 1, closed: 1, realizedUsd: 0.05, unrealizedUsd: null, unpriced: 1 },
      ],
    }
    const out = texts(pnlLines(p, { width: 76, now: NOW }))
    const head = out.findIndex((l) => l.startsWith("bots"))
    expect(out[head + 1]).toBe("counted here from each bot's own fills, apart from Candle's books")
    expect(out[head + 2]).toMatch(/^conf +\+\$0\.90 +\+\$1\.20 +-\$0\.30$/)
    expect(out[head + 3]).toBe("  2 open positions, 5 closed · agent-a")
    expect(out[head + 4]).toMatch(/^dip ≈ +\+\$0\.05 +\+\$0\.05/)
    expect(out[head + 5]).toStartWith("  paper, at quoted prices · 1 open position, 1 closed · 1 unpriced")
    // Candle's figures are the same as without them.
    const live = (o: string[]) => o.filter((l) => /^(last 24h|together|agent-[ab] |embedded)/.test(l))
    expect(live(out)).toEqual(live(texts(pnlLines(full, { width: 76, now: NOW }))))
    for (const width of WIDTHS) for (const l of texts(pnlLines(p, { width, now: NOW }))) expect(l.length).toBeLessThanOrEqual(width)
  })

  test("its title says whose and how old, live in paper mode; its chip is the window", () => {
    expect(pnlTitle(full, NOW)).toBe("P&L · Candle's books, read 40s ago")
    expect(pnlTitle(full, NOW, "paper")).toBe("P&L · live, Candle's books, read 40s ago")
    expect(pnlTitle(pnlScene(NOW, "fresh"), NOW)).toBe("P&L · Candle's books")
    const view = applyEvent(EMPTY_VIEW, { topic: "pnl", seq: 1, data: full as never }, NOW)
    expect(borderChip("pnl", { only: undefined, view })).toBe("24h ▾")
    expect(borderChip("pnl", { only: undefined, view: { ...view, pnl: { ...full, window: "18:00" } } })).toBe("18:00 ▾")
  })
})

describe("the chart", () => {
  const full = pnlScene(NOW, "full")
  const series = (span: PnlSeries["span"] = "window", gap = true): PnlSeries => {
    const from = spanFrom(span, full, NOW)
    return { span, from, at: NOW, points: pnlSeriesScene(NOW, Math.max(from, full.samplesFrom!), 480, { gap }) }
  }

  test("the Candle Harness's samples on a scale from the span's own values, the change since its start, and a gap said", () => {
    const out = pnlChartLines(full, series(), { width: 70, height: 12, now: NOW, span: "window" })
    expect(out).toHaveLength(12)
    expect(textOf(out[1]!)).toMatch(/ -\$9\.\d\d$/)
    expect(textOf(out.at(-2)!)).toMatch(/ -\$\d+\.\d\d$/)
    expect(textOf(out.at(-1)!)).toBe("+$0.31 since Jan 14 08:01 · blank where the app wasn't running")
    // Without a gap, it says the samples are the Candle Harness's.
    expect(textOf(pnlChartLines(full, series("window", false), { width: 70, height: 12, now: NOW, span: "window" }).at(-1)!)).toBe("+$0.31 since Jan 14 08:01, from the Candle Harness's samples")
    // Narrower, the gap is still said, shorter.
    expect(textOf(pnlChartLines(full, series(), { width: 50, height: 12, now: NOW, span: "window" }).at(-1)!)).toBe("+$0.31 since Jan 14 08:01 · blank: app off")
  })

  test("a gap is drawn as a gap: blank columns, no line across it", () => {
    const values = [1, 2, 3, null, null, null, null, null, 2, 1]
    const rows = gappedChart(values, 5, 2, { lo: 0, hi: 4 })
    const blank = String.fromCharCode(0x2800)
    // Dot columns 3 to 7 hold no point: cells 2 and 3 are blank but for cell 1's right half.
    expect(rows.map((r) => r[2]).every((c) => c === blank)).toBe(true)
    expect(rows.map((r) => r[3]).every((c) => c === blank)).toBe(true)
  })

  test("buckets spread on the span's time axis: nothing before the first, null in a gap", () => {
    const pts = [
      { at: 2_000, usd: 1 },
      { at: 3_000, usd: null },
      { at: 4_000, usd: 3 },
    ]
    expect(bucketsOnTimeline(pts, 5, 0, 4_000)).toEqual([null, null, 1, null, 3])
  })

  test("the span's chips: the one shown in bright text, the others chips that switch it", () => {
    const head = pnlChartLines(full, series("7d"), { width: 60, height: 12, now: NOW, span: "7d" })[0]!
    expect(textOf(head)).toBe(" 24h   7d   30d   all ")
    expect(head.segs.filter((s) => s.act === "pnlSpan").map((s) => s.ref)).toEqual(["window", "30d", "all"])
    expect(run([{ type: "pnlSpan", span: "30d", now: 0 }]).state.pnlSpan).toBe("30d")
  })

  test("empty states: reading, a span still being read, no samples, none in the span, one sample, and a core that can't say", () => {
    const say = (s: PnlSeries | undefined, p: PnlView | undefined = full, span: PnlSeries["span"] = "window") => texts(pnlChartLines(p, s, { width: 60, height: 12, now: NOW, span })).slice(1).join(" ")
    expect(say(undefined)).toBe("Reading the Candle Harness's samples…")
    expect(say(series("window"), full, "7d")).toBe("Reading the Candle Harness's samples…")
    expect(say({ span: "window", from: 0, at: NOW, points: [] }, pnlScene(NOW, "fresh"))).toContain("No samples yet.")
    expect(say({ span: "window", from: 0, at: NOW, points: [{ at: NOW, usd: null }] })).toBe("No samples in this span. The first is from Jan 14 08:01: pick all.")
    expect(say({ span: "window", from: 0, at: NOW, points: [{ at: NOW, usd: -3 }] })).toBe("One sample so far: the chart starts with the next read.")
    expect(say({ span: "window", from: 0, at: NOW, points: [], failed: "Unknown method pnl.series" })).toBe("Couldn't read the Candle Harness's samples: Unknown method pnl.series.")
  })

  test("it fills what it's given, as the token pane's chart does", () => {
    expect(PANES["pnl-chart"].fills(EMPTY_VIEW)).toBe(true)
    const view = { ...applyEvent(EMPTY_VIEW, { topic: "pnl", seq: 1, data: full as never }, NOW), pnlSeries: series() }
    const drawn = paneLines("pnl-chart", { view, rect: { x: 0, y: 0, w: 62, h: 16 }, now: NOW, only: undefined, rows: 14 })
    expect(drawn.title).toBe("P&L over time")
    expect(drawn.lines).toHaveLength(14)
  })

  test("each span starts where it says: the window's start, 7 or 30 days back, or every sample", () => {
    expect(spanFrom("window", full, NOW)).toBe(NOW - 86_400_000)
    expect(spanFrom("window", { ...full, figure: { ...full.figure, start: null } }, NOW)).toBe(full.samplesFrom!)
    expect(spanFrom("7d", full, NOW)).toBe(NOW - 7 * 86_400_000)
    expect(spanFrom("all", full, NOW)).toBe(0)
  })
})

describe("P&L positions", () => {
  test("each open position as Candle books it, by value, with its wallet and agent; a pick that ctrl-t asks about", () => {
    const lines = pnlPositionLines(pnlScene(NOW, "full"), { width: 76, now: NOW })
    const out = texts(lines)
    expect(out[0]).toMatch(/^token +cost +value +unrealised +wallet · agent$/)
    expect(out[1]).toMatch(/^CNDL +\$3\.73 +\$3\.53 +-\$0\.21 +embedded · agent-b$/)
    expect(out[2]).toMatch(/^MOTH +\$8\.47 +\$0\.544 +-\$7\.93 +embedded · agent-b$/)
    expect(out).toContain("Candle's marks are up to 45m old.")
    const moth = lines[2]!.pick!
    expect(moth.mint).toBe("TokenFake30zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
    expect(moth.ask).toBe("What do you make of MOTH? Candle books 88,958 of it at a cost of $8.47, worth $0.544 now (-$7.93).")
    expect(PNL_POSITIONS_TITLE).toContain("Candle's cost book")
  })

  test("a position Candle couldn't mark shows — for its value, never 0", () => {
    const p = pnlScene(NOW, "full")
    const b = p.agents[1]!.book!
    const unmarked: PnlView = { ...p, agents: [p.agents[0]!, { ...p.agents[1]!, book: { ...b, positions: [{ ...b.positions[0]!, marketValueUsd: null, unrealizedUsd: null, markPriceUsd: null }] } }] }
    expect(texts(pnlPositionLines(unmarked, { width: 76, now: NOW }))[1]).toMatch(/^MOTH +\$8\.47 +— +— /)
  })

  test("none open says so, and that Positions shows what the wallets hold", () => {
    expect(texts(pnlPositionLines(pnlScene(NOW, "failed"), { width: 56, now: NOW })).join(" ")).toContain("No open positions in Candle's books. Positions shows what the wallets hold")
    expect(texts(pnlPositionLines(pnlScene(NOW, "fresh"), { width: 56, now: NOW }))).toEqual(["Reading Candle's books…"])
  })
})

describe("Trades", () => {
  test("newest first: a failed trade with its error in words, the Candle Harness's swap marked, each fill a pick", () => {
    const p = pnlScene(NOW, "full")
    const lines = tradeLines(p, { width: 76, now: NOW })
    const out = texts(lines)
    expect(out[0]).toMatch(/^07:53 +buy +MOTH +failed +agent-a$/)
    expect(out[1]).toBe("  Slippage tolerance exceeded: the price moved 4.1% before it landed")
    expect(out[2]).toMatch(/^07:35 +swap 0\.05 SOL → USDC +≈\$7\.50 +from the Candle Harness · agent-a$/)
    expect(out[3]).toMatch(/^Jan 14 23:10 sell LUMEN +\$3\.70 +agent-b$/)
    expect(lines[3]!.pick).toMatchObject({ mint: "TokenFake29zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" })
    expect(lines[3]!.pick!.ask).toBe("What do you make of LUMEN? I sold $3.70 of it on Jan 14 23:10.")
    // The swap has no mint to pick.
    expect(lines[2]!.pick).toBeUndefined()
    expect(tradesTitle(p)).toBe("Trades · live: Candle's fills and the Candle Harness's swaps")
    expect(tradesTitle({ ...p, swaps: [] })).toBe("Trades · live: Candle's fills, newest first")
  })

  test("a bot's fill says by which bot", () => {
    const p = pnlScene(NOW, "full")
    const sig = p.trades.find((t) => t.symbol === "LUMEN")!.signature!
    expect(texts(tradeLines({ ...p, byBot: { [sig]: "conf" } }, { width: 76, now: NOW }))[3]).toMatch(/^Jan 14 23:10 sell LUMEN +\$3\.70 +by bot conf · agent-b$/)
  })

  test("a failed trade's error is amber, and no line is wider than the pane", () => {
    const lines = tradeLines(pnlScene(NOW, "full"), { width: 40, now: NOW })
    for (const l of texts(lines)) expect(l.length).toBeLessThanOrEqual(40)
    const fg = lines[1]!.segs[0]!.fg
    expect(lines.filter((l) => textOf(l).startsWith("  ")).every((l) => l.segs[0]!.fg === fg)).toBe(true)
  })

  test("before a read, and with nothing filled", () => {
    expect(texts(tradeLines(pnlScene(NOW, "fresh"), { width: 56, now: NOW }))).toEqual(["Reading the recent fills from Candle…"])
    const p = pnlScene(NOW, "full")
    expect(texts(tradeLines({ ...p, trades: [], swaps: [] }, { width: 100, now: NOW }))).toEqual(["No recent fills on Candle for the Candle Harness's agents. Your fills show here as they land."])
  })
})

// --- The window: its menu, settings, the palette and the typed line ---------------------------------------

function ctx(over: Partial<UiContext> = {}): UiContext {
  return { cards: [], seenAt: {}, mode: "live", agents: ["agent-a"], activeAgent: "agent-a", commands: { agents: ["agent-a"], knownTokens: new Map() }, pnlWindow: "24h", ...over }
}
function run(actions: UiAction[], c: UiContext = ctx(), start: UiState = INITIAL_UI): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
const key = (name: string): UiAction => ({ type: "key", key: { name, ...(name.length === 1 ? { sequence: name } : {}) } as Key, now: 0 })
const typed = (text: string): UiAction[] => [...text].map((ch) => ({ type: "key", key: { name: ch === " " ? "space" : ch, sequence: ch }, now: 0 }))

describe("the P&L window", () => {
  test("the menu's rows: the default, midnight, last night, last session and a time of your own; the one on ticked", () => {
    expect(pnlWindowRows("24h").map((r) => [r.label, r.on])).toEqual([
      ["last 24 hours", true],
      ["since midnight", false],
      ["since 18:00", false],
      ["since last session", false],
      ["since another time…", false],
    ])
    // A time of your own shows as its own row, ticked.
    expect(pnlWindowRows("07:30").find((r) => r.on)).toMatchObject({ value: "07:30", label: "since 07:30" })
  })

  test("the chip opens the menu under it on the window that's on; ⏎ on another picks it, for the core to keep", () => {
    const opened = run([{ type: "clickPnlWindow", x: 60, y: 2, now: 0 }], ctx({ pnlWindow: "midnight" }))
    expect(opened.state.overlay).toEqual({ kind: "pnlMenu", index: 1, x: 60, y: 2 })
    const picked = run([key("down"), key("down"), key("return")], ctx({ pnlWindow: "midnight" }), opened.state)
    expect(picked.effects).toEqual([{ type: "pnlWindow", window: "session" }])
    expect(picked.state.overlay).toBeUndefined()
    // The chip again closes it; Esc does too.
    expect(run([{ type: "clickPnlWindow", now: 0 }], ctx(), opened.state).state.overlay).toBeUndefined()
    expect(run([key("escape")], ctx(), opened.state).state.overlay).toBeUndefined()
  })

  test("the window that's on already sends nothing, and says so", () => {
    const r = run([{ type: "clickPnlWindow", now: 0 }, { type: "pickPnlMenu", index: 0, now: 0 }])
    expect(r.effects).toEqual([])
    expect(r.state.message?.text).toBe("The P&L window is already the last 24 hours.")
  })

  test("a time of your own is typed on its row (on the input line it was out of sight); a bad time keeps the row, Esc goes back", () => {
    const r = run([{ type: "clickPnlWindow", now: 0 }, { type: "pickPnlMenu", index: 4, now: 0 }])
    expect(r.state.overlay).toMatchObject({ kind: "pnlMenu", index: 4, typing: "" })
    expect(r.state.input).toBe("")
    expect(r.effects).toEqual([])
    // Letters aren't a time: only digits and the colon are taken.
    const typing = run(typed("7a:30"), ctx(), r.state)
    expect(typing.state.overlay).toMatchObject({ typing: "7:30" })
    expect(pnlWindowRows(undefined, "7:30").at(-1)).toMatchObject({ label: "since 7:30▏" })
    const sent = run([key("return")], ctx(), typing.state)
    expect(sent.effects).toEqual([{ type: "pnlWindow", window: "07:30" }])
    expect(sent.state.overlay).toBeUndefined()
    const bad = run([...typed("25:00"), key("return")], ctx(), r.state)
    expect(bad.effects).toEqual([])
    expect(bad.state.message?.text).toBe(`"25:00" isn't a time of day: such as 07:30, then ⏎.`)
    expect(run([key("escape")], ctx(), bad.state).state.overlay).toEqual({ kind: "pnlMenu", index: 4 })
    // The typed line still picks one too.
    const line = run([...typed("pnl since 07:30"), key("return")], ctx())
    expect(line.effects).toEqual([{ type: "pnlWindow", window: "07:30" }])
  })

  test("typed: only a window parses; anything else goes to the agent", () => {
    const c = { agents: ["agent-a"], knownTokens: new Map<string, string>() }
    expect(parseCommand("pnl since 18:00", c)).toEqual({ kind: "pnlWindow", window: "18:00" })
    expect(parseCommand("pnl 9:15", c)).toEqual({ kind: "pnlWindow", window: "09:15" })
    expect(parseCommand("pnl since last session", c)).toEqual({ kind: "pnlWindow", window: "session" })
    expect(parseCommand("pnl today", c)).toEqual({ kind: "pnlWindow", window: "midnight" })
    expect(parseCommand("pnl 24h", c)).toEqual({ kind: "pnlWindow", window: "24h" })
    expect(parseCommand("pnl since tuesday?", c)).toEqual({ kind: "agent", text: "pnl since tuesday?" })
    expect(parseCommand("pnl since 25:00", c)).toEqual({ kind: "agent", text: "pnl since 25:00" })
  })

  test("settings ▾ has a row for it, which opens the menu", () => {
    const at = SETTINGS.findIndex((s) => s.id === "pnl")
    expect(at).toBeGreaterThan(-1)
    expect(run([{ type: "pickSettings", index: at, now: 0 }]).state.overlay).toEqual({ kind: "pnlMenu", index: 0 })
  })

  test("the palette has each window, the one on marked, and picking one sends it", () => {
    const input: PaletteInput = { tabs: ["Trade"], tab: 0, agents: [], presets: {}, tokens: new Map(), paused: false, card: false, requotable: false, working: false, ask: false, aliases: new Map(), aliasProblems: 0, popped: [], pnlWindow: "midnight" }
    const rows = paletteRows(input, "pnl")
    expect(rows.slice(0, 5).map((r) => r.label)).toEqual(["P&L window: last 24 hours", "P&L window: since midnight", "P&L window: since 18:00", "P&L window: since last session", "P&L window: since another time…"])
    expect(rows[1]!.current).toBe(true)
    const picked = run([{ type: "key", key: { name: "k", ctrl: true }, now: 0 }, ...typed("pnl"), key("return")], ctx({ pnlWindow: "midnight" }))
    expect(picked.effects).toEqual([{ type: "pnlWindow", window: "24h" }])
  })
})
