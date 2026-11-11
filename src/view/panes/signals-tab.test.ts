// The Signals tab: the wide row, each tab's choice and its chips, the filter that matches nothing, pause,
// and a highlighted row holding the view. From rows recorded from Hacc's real tape.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { StreamRow } from "../../core/signal-stream"
import { type Effect, INITIAL_UI, step, type UiAction, type UiContext, type UiState } from "../keys"
import { paletteRows } from "../palette-rows"
import { textOf } from "./lines"
import {
  happenedWide,
  heldSignals,
  signalLine,
  signalsChips,
  signalsChoiceOf,
  signalsFilter,
  signalsLines,
  signalsMenuRows,
  signalsParams,
  signalsTitle,
  WIDE_SIGNALS,
} from "./signals"

const NOW = Date.parse("2026-10-29T03:00:00Z")
const recorded = (name: string): Record<string, unknown>[] =>
  (JSON.parse(readFileSync(join(import.meta.dir, `../../../test/fixtures/hacc-recorded/${name}.json`), "utf8")) as { answer: { signals: Record<string, unknown>[] } }).answer.signals
const PATTERNS = ["confluence", "deployer", "distribution", "dormancy", "intra_book", "kol_mention", "large_move", "new_ticker"]

describe("the wide row", () => {
  test("every recorded row draws at full width, in the Candle Harness's words, never Hacc's summary, none wider than the pane", () => {
    for (const p of PATTERNS) {
      for (const row of recorded(`signals-pattern-${p}`)) {
        const at = Date.parse((row as StreamRow).created_at)
        for (const age of [4_000, 45 * 60_000, 23 * 3_600_000]) {
          for (const w of [WIDE_SIGNALS, 100, 136, 156, 200]) {
            const text = textOf(signalLine(row as StreamRow, w, at + age))
            expect(text.length).toBeLessThanOrEqual(w)
            expect(text).not.toContain("fake-summary")
            expect(text).toContain(happenedWide(row).slice(0, 10))
            expect(text).toMatch(/Solana|Hood/)
          }
        }
      }
    }
  })

  test("what happened, the wallets and the chain, from each pattern's payload", () => {
    const at = NOW - 90_000
    const draw = (over: Record<string, unknown>) => textOf(signalLine({ id: 1, created_at: new Date(at).toISOString(), asset_symbol: "CSI", asset_chain: "solana", ...over } as StreamRow, 136, NOW))
    const confluence = draw({ pattern: "confluence", payload: { wallets: [{ label: "desk seven" }, { address: "Wal9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXk2p" }, { label: "early bird" }], window_minutes: 60 } })
    expect(confluence).toContain("3 wallets bought in 60m")
    expect(confluence).toContain("desk seven, Wal9…Xk2p, early bird")
    const kol = draw({ pattern: "kol_mention", payload: { handle: "callsguy", followers: 7896, order: "post_then_buy", lag_minutes: 47, usd_value: "130" } })
    expect(kol).toContain("posted, bought 47m later")
    expect(kol).toContain("@callsguy · 7.9K followers")
    expect(draw({ pattern: "dormancy", payload: { dormant_days: 27 }, asset_chain: "hood" })).toMatch(/wallet woke after 27d .*Hood/)
    expect(draw({ pattern: "large_move", event_kind: "swap", payload: { direction: "out", usd_value: "11640" } })).toContain("big sell")
    // Narrower than the wide row, the line is the Cockpit's short one.
    expect(textOf(signalLine({ id: 1, created_at: new Date(at).toISOString(), asset_symbol: "CSI", pattern: "confluence", payload: { wallets: [{}, {}, {}] } } as StreamRow, 44, NOW))).toStartWith("CSI     3 wallets")
  })

  test("a launch Hacc sizes at $0 has no size, wide or narrow", () => {
    const row = { id: 1, created_at: new Date(NOW).toISOString(), asset_symbol: "PUMP", asset_address: "Pump1111", pattern: "deployer_launch", payload: { usd_value: 0 } } as unknown as StreamRow
    expect(textOf(signalLine(row, 136, NOW))).not.toContain("$0")
    expect(textOf(signalLine(row, 44, NOW))).not.toContain("$0")
    expect(signalLine(row, 136, NOW).pick!.ask).not.toContain("$0")
  })

  test("many wallets: as many names as fit, then how many more", () => {
    const wallets = Array.from({ length: 9 }, (_, i) => ({ label: `wallet number ${i}` }))
    const text = textOf(signalLine({ id: 1, created_at: new Date(NOW).toISOString(), pattern: "confluence", payload: { wallets } } as StreamRow, 136, NOW))
    // The wallets come last, so they have the rest of the row.
    expect(text).toMatch(/wallet number 0, wallet number 1, wallet number 2 \+6$/)
    expect(text.length).toBeLessThanOrEqual(136)
  })
})

describe("each tab's choice", () => {
  test("kept by the tab: the whole tape where none is", () => {
    const choices = [{ at: "Signals", pattern: "dormancy" }, { at: "Cockpit", mine: true as const }]
    expect(signalsChoiceOf(choices, "Signals")).toEqual({ pattern: "dormancy" })
    expect(signalsChoiceOf(choices, "Trade")).toEqual({})
    // With the chain filter's chip on screen, the tab's own chain gives way to the filter's (none: all chains).
    const kept = [{ at: "Signals", pattern: "dormancy", chain: "solana" as const }]
    expect(signalsChoiceOf(kept, "Signals")).toEqual({ pattern: "dormancy", chain: "solana" })
    expect(signalsChoiceOf(kept, "Signals", { chain: "hood" })).toEqual({ pattern: "dormancy", chain: "hood", folded: true })
    expect(signalsChoiceOf(kept, "Signals", {})).toEqual({ pattern: "dormancy", folded: true })
    expect(signalsFilter({ pattern: "dormancy", chain: "hood" })).toEqual({ pattern: ["dormancy"], chain: ["hood"] })
    // Your rules' signals aren't Hacc's tape: no filter goes to the core for them.
    expect(signalsFilter({ mine: true, pattern: "dormancy" })).toBeUndefined()
    expect(signalsFilter({})).toBeUndefined()
  })

  test("a change keeps what it doesn't touch", () => {
    expect(signalsParams("Signals", { pattern: "dormancy" }, { chain: "hood" })).toEqual({ at: "Signals", mine: false, pattern: "dormancy", chain: "hood" })
    expect(signalsParams("Signals", { pattern: "dormancy", chain: "hood" }, { pattern: null, chain: null })).toEqual({ at: "Signals", mine: false, pattern: null, chain: null })
    expect(signalsParams("Signals", {}, { mine: true })).toEqual({ at: "Signals", mine: true, pattern: null, chain: null })
  })

  test("the chips: all three where the title fits beside them; a narrow pane keeps its title, and a chip that's set always shows", () => {
    expect(signalsChips({}, 156).map((c) => c.text)).toEqual(["pattern ▾", "chain ▾", "all ▾"])
    // The Cockpit's Signals pane, 40 wide: its title and one chip.
    expect(signalsChips({}, 40).map((c) => c.text)).toEqual(["all ▾"])
    expect(signalsChips({ chain: "hood" }, 40).map((c) => c.text)).toEqual(["Hood ▾", "all ▾"])
    expect(signalsChips({ pattern: "large_move" }, 156).map((c) => c.text)).toEqual(["big move ▾", "chain ▾", "all ▾"])
    expect(signalsChips({ mine: true }, 156).map((c) => c.text)).toEqual(["mine ▾"])
    expect(signalsTitle({ pattern: "dormancy" })).toBe("Signals · Hacc's tape")
    // With the status bar's chain filter on screen the chain is its: no chain chip, set or not.
    expect(signalsChips({ folded: true }, 156).map((c) => c.text)).toEqual(["pattern ▾", "all ▾"])
    expect(signalsChips({ folded: true, chain: "hood" }, 40).map((c) => c.text)).toEqual(["all ▾"])
  })

  test("the menus: every pattern Hacc sends, in words, and both chains; the one on is ticked", () => {
    const patterns = signalsMenuRows("pattern", { pattern: "dormancy" })
    expect(patterns[0]).toMatchObject({ value: null, label: "every pattern", on: false })
    expect(patterns.map((r) => r.value).slice(1).sort()).toEqual([...PATTERNS].sort())
    expect(patterns.find((r) => r.on)?.value).toBe("dormancy")
    expect(signalsMenuRows("chain", {}).map((r) => [r.label, r.on])).toEqual([["both chains", true], ["Solana", false], ["Hood", false]])
  })
})

describe("a filter that matches nothing says over what span", () => {
  const hacc = { enabled: true, agents: { "agent-a": { plan: "max", key: "ok" as const } }, stream: { state: "open", mine: { state: "polling" } } }
  const since = "2026-10-29T02:10:00Z"
  const lines = (held: Parameters<typeof signalsLines>[0], pick = { pattern: "deployer" }) => signalsLines(held, { hacc, pick, width: 120, now: NOW }).map(textOf)
  test("while the read-back is out, after it found none, and when it failed; each with clear filters", () => {
    expect(lines({ rows: [], since })[0]).toBe("Reading Hacc's tape back for deployer signals…")
    expect(lines({ rows: [], since, back: { at: since, ok: true, rows: 0 } })[0]).toBe("No deployer signals on Hacc's tape, nor in what the core has heard since 02:10.")
    const failed = lines({ rows: [], since, back: { at: since, ok: false, rows: 0, words: "HTTP 503: upstream busy" } }).join(" ")
    expect(failed).toContain("Hacc's read-back didn't answer (HTTP 503: upstream busy)")
    for (const held of [{ rows: [], since }, { rows: [], back: { at: since, ok: true, rows: 0 } }]) {
      const drawn = signalsLines(held, { hacc, pick: { pattern: "deployer" }, width: 120, now: NOW })
      expect(drawn.at(-1)?.segs[0]).toMatchObject({ text: " clear filters ", act: "signals" })
    }
    // Your rules' signals aren't filtered by the tape's pattern, which has no chip there: the choice keeps it for the tape.
    const mine = signalsLines({ rows: recorded("signals-pattern-dormancy") as StreamRow[] }, { hacc, pick: { mine: true, pattern: "confluence" }, width: 60, now: NOW }).map(textOf)
    expect(mine.length).toBe(5)
    expect(mine.every((l) => l.includes("woke"))).toBe(true)
  })

  test("a read-back's state and span are kept as rows arrive after it", () => {
    const first = heldSignals(undefined, { rows: [], since }, true)
    const back = heldSignals(first, { rows: [{ id: 9, created_at: "2026-10-29T01:00:00Z", pattern: "deployer" }], back: { at: since, ok: true, rows: 1 }, since }, false)
    expect(back.back).toEqual({ at: since, ok: true, rows: 1 })
    const later = heldSignals(back, { rows: [{ id: 10, created_at: "2026-10-29T02:59:00Z", pattern: "deployer" }] }, false)
    expect(later.back).toEqual(back.back)
    expect(later.since).toBe(since)
    expect(later.rows.map((r) => r.id)).toEqual([9, 10])
  })
})

describe("the keys", () => {
  const ctx = (over: Partial<UiContext> = {}): UiContext => ({ cards: [], seenAt: {}, mode: "live", agents: ["agent-a"], activeAgent: "agent-a", commands: { agents: ["agent-a"], knownTokens: new Map() }, ...over })
  const run = (actions: UiAction[], c: UiContext = ctx(), start: UiState = INITIAL_UI) => {
    let state = start
    const effects: Effect[] = []
    for (const a of actions) {
      const r = step(state, a, c)
      state = r.state
      effects.push(...r.effects)
    }
    return { state, effects }
  }

  test("the source chip switches to your rules; a pattern picked from its menu goes to the core; both start the pane at its newest", () => {
    const scrolled: UiState = { ...INITIAL_UI, scroll: { signals: { rows: 6, anchor: "116150004" } } }
    const mine = run([{ type: "clickSignalsChip", which: "source", now: 0 }], ctx(), scrolled)
    expect(mine.effects).toEqual([{ type: "signals", change: { mine: true } }])
    expect(mine.state.scroll.signals).toBeUndefined()
    const opened = run([{ type: "clickSignalsChip", which: "pattern", x: 90, y: 3, now: 0 }], ctx({ signals: { pattern: "dormancy" } }), scrolled)
    expect(opened.state.overlay).toEqual({ kind: "signalsMenu", which: "pattern", index: signalsMenuRows("pattern", { pattern: "dormancy" }).findIndex((r) => r.on), x: 90, y: 3 })
    const picked = run([{ type: "key", key: { name: "up" }, now: 0 }, { type: "key", key: { name: "return" }, now: 0 }], ctx({ signals: { pattern: "dormancy" } }), opened.state)
    expect(picked.state.overlay).toBeUndefined()
    expect(picked.state.scroll.signals).toBeUndefined()
    expect(picked.effects).toEqual([{ type: "signals", change: { pattern: signalsMenuRows("pattern", {})[signalsMenuRows("pattern", { pattern: "dormancy" }).findIndex((r) => r.on) - 1]!.value } }])
    const chain = run([{ type: "clickSignalsChip", which: "chain", now: 0 }, { type: "pickSignalsMenu", index: 2, now: 0 }])
    expect(chain.effects).toEqual([{ type: "signals", change: { chain: "hood" } }])
    expect(run([{ type: "clearSignals", now: 0 }]).effects).toEqual([{ type: "signals", change: { pattern: null, chain: null } }])
  })

  test("pause holds the view where it is and counts what arrives; scrolling to the top stays paused; resume goes back to the newest", () => {
    const c = ctx({ scrolls: { signals: { max: 40, newest: "116150029", since: 0, start: 0, rows: 12, total: 52 } } })
    const paused = run([{ type: "pauseSignals", on: true, now: 0 }], c)
    expect(paused.state.scroll.signals).toEqual({ rows: 0, anchor: "116150029", paused: true })
    const down = run([{ type: "scroll", pane: "signals", delta: -3, now: 0 }], c, paused.state)
    expect(down.state.scroll.signals).toMatchObject({ rows: 3, paused: true })
    const up = run([{ type: "scroll", pane: "signals", delta: 3, now: 0 }], c, down.state)
    expect(up.state.scroll.signals).toMatchObject({ rows: 0, paused: true })
    expect(run([{ type: "pauseSignals", on: false, now: 0 }], c, up.state).state.scroll.signals).toBeUndefined()
  })

  test("a highlighted row holds a head pane's view, so new rows don't push it away", () => {
    const c = ctx({
      panes: { order: ["signals", "agent"], group: [], rects: { signals: { x: 0, y: 3, w: 140, h: 20 }, agent: { x: 0, y: 24, w: 140, h: 10 } } },
      picks: { signals: [{ id: "116150029", mint: "Trend1", line: 0 }] },
      scrolls: { signals: { max: 40, newest: "116150029", since: 0, start: 0, rows: 18, total: 52 } },
    })
    const lit = run([{ type: "clickPane", pane: "signals", now: 0 }, { type: "key", key: { name: "down" }, now: 0 }], c)
    expect(lit.state.highlight?.signals?.id).toBe("116150029")
    expect(lit.state.scroll.signals).toEqual({ rows: 0, anchor: "116150029" })
  })

  test("the palette reaches what a narrow pane's chips can't: pause, the source, each menu, and clearing", () => {
    const base = { tabs: ["Cockpit"], tab: 0, agents: [], presets: {}, tokens: new Map(), paused: false, card: false, requotable: false, working: false, ask: false, aliases: new Map(), aliasProblems: 0, popped: [] }
    const layout = { tab: "Cockpit", names: ["Cockpit"], current: { name: "Cockpit", root: { dir: "row" as const, weight: 1, children: [{ pane: "signals" as const, weight: 1 }, { pane: "agent" as const, weight: 1 }] }, collapse: { below: 0, keep: "agent" as const, weights: [60, 40] as const } } }
    const ids = (signals: { pattern?: string; paused: boolean }) => paletteRows({ ...base, layout, signals } as never, "signals").map((r) => r.id).filter((id) => id.startsWith("signals:"))
    expect(ids({ paused: false })).toEqual(["signals:pause", "signals:source", "signals:pattern", "signals:chain"])
    expect(ids({ pattern: "dormancy", paused: true })).toEqual(["signals:resume", "signals:source", "signals:pattern", "signals:chain", "signals:clear"])
    const opened = run([{ type: "key", key: { name: "k", ctrl: true }, now: 0 }], ctx({ layout } as never))
    expect(opened.state.overlay?.kind).toBe("palette")
  })
})
