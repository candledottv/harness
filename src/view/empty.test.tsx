// Empty states for every pane: no pane may open with nothing to say. A fresh
// install's every tab is drawn at 120×30 and 80×24 and each pane on screen must hold a line of words; then
// each pane, wherever a tab puts it and popped out alone, is asked for its lines before its first read, read
// with nothing to show, and with its read failed, and must say something each time, the failure in its words.
import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import type { CoreEventParams } from "../core/client"
import { CLOCK, drawScene, freshEvents, MINT } from "../../test/frame-scenes"
import { AGENT_FIRST, BOTS, BUILD, COCKPIT, JOURNAL, type Layout, PERPS, PNL, panesOf, RESEARCH, SIGNALS, TRENDING } from "./layout"
import { journalKey } from "./panes/journal"
import { activityTape, PANES, paneLines } from "./panes/registry"
import { tabTip } from "./panes/agent"
import { PANE_IDS, type PaneId } from "../shared/panes"
import { applyEvent, type CoreView, EMPTY_VIEW } from "./store"

process.env.TZ = "UTC"

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

/** A word: two letters together. A border, a chart's dots, a figure or a switcher's arrows aren't words. */
const WORD = /[A-Za-z]{2,}/
/** A collapsed layout's switcher row ("◂  token  ▸   3/5 · ←/→"): it names the pane, which isn't the pane saying anything. */
const SWITCHER = /◂ .* ▸ +\d+\/\d+/

/** Each framed pane on screen: its title and the rows inside its border. */
export function framedPanes(frame: string): { title: string; rows: string[] }[] {
  const grid = frame.split("\n").map((r) => [...r])
  const out: { title: string; rows: string[] }[] = []
  grid.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== "╭") return
      const right = row.indexOf("╮", x + 1)
      let bottom = y + 1
      while (bottom < grid.length && grid[bottom]![x] !== "╰") bottom++
      if (right < 0 || bottom >= grid.length) return
      const title = row.slice(x + 1, right).join("").replace(/─/g, " ").trim()
      out.push({ title, rows: grid.slice(y + 1, bottom).map((r) => r.slice(x + 1, right).join("")) })
    }),
  )
  return out
}

const TABS = ["trade", "cockpit", "trending", "signals", "pnl", "research", "journal", "perps"] as const

describe("a fresh install: every tab, every pane on screen says something", () => {
  for (const [w, h] of [
    [120, 30],
    [80, 24],
  ] as const) {
    for (const tab of TABS) {
      test(`${tab} at ${w}×${h}`, async () => {
        ;({ setup } = await drawScene("fresh", w, h, tab))
        const panes = framedPanes(setup.captureCharFrame())
        expect(panes.length).toBeGreaterThan(0)
        for (const p of panes) expect({ pane: p.title, says: p.rows.some((r) => !SWITCHER.test(r) && WORD.test(r)) }).toEqual({ pane: p.title, says: true })
      })
    }
  }

  test("the short agent pane shows the welcome's first line and the tab's one thing to try, not the welcome's tail", async () => {
    ;({ setup } = await drawScene("fresh", 80, 24, "trending"))
    const agent = framedPanes(setup.captureCharFrame()).find((p) => p.title.startsWith("agent-a"))!
    const said = agent.rows.join(" ").replace(/\s+/g, " ")
    expect(said).toContain("agent-a here.")
    expect(said).toContain("Try ctrl-t on a row: it asks me about that token.")
  })

  test("on Trade, Activity shows Hacc's tape, dim and labelled, and the token pane Candle's list, which Positions doesn't repeat", async () => {
    ;({ setup } = await drawScene("fresh", 140, 40, "trade"))
    const panes = framedPanes(setup.captureCharFrame())
    const activity = panes.find((p) => p.title.startsWith("Activity"))!
    expect(activity.title).toContain("Hacc's tape")
    expect(activity.rows.join("\n")).toContain("↑ Hacc's tape, until your first card")
    expect(panes.find((p) => p.title.startsWith("Token"))!.rows.join("\n")).toContain("ORBIT")
    const positions = panes.find((p) => p.title.startsWith("Positions"))!.rows.join("\n")
    expect(positions).toContain("No open paper positions.")
    expect(positions).not.toContain("ORBIT")
    const wallets = panes.find((p) => p.title.startsWith("Wallets"))!.rows.join("\n")
    expect(wallets).toContain("send SOL to trade live")
    expect(wallets).toContain("Paper trades need no funds.")
  })

  test("Activity's tape is subscribed while Activity has no line of its own, and let go at its first", async () => {
    const drawn = await drawScene("fresh", 140, 40, "trade")
    setup = drawn.setup
    expect(drawn.session.wanted.at(-1)).toEqual(["signals", "asks"])
    // Unfiltered: the Trade tab's Signals choice, if it had one, is for a Signals pane.
    expect(drawn.session.filters.at(-1)).toEqual({})
    await act(async () => drawn.session.push("activity", { lines: [{ seq: 1, at: new Date(CLOCK).toISOString(), text: "live mode", tone: "info" }] }, true))
    await drawn.setup.renderOnce()
    expect(drawn.session.wanted.at(-1)).toEqual(["asks"])
    const activity = framedPanes(drawn.setup.captureCharFrame()).find((p) => p.title.startsWith("Activity"))!
    expect(activity.title).not.toContain("Hacc")
    expect(activity.rows.join("\n")).not.toContain("Hacc's tape")
  })

  test("on Trending, the token pane says how to pick one rather than repeat the lists", async () => {
    ;({ setup } = await drawScene("fresh", 160, 45, "trending"))
    const token = framedPanes(setup.captureCharFrame()).find((p) => p.title.startsWith("Token"))!
    expect(token.title).not.toContain("trending")
    expect(token.rows.join(" ")).toContain("Pick a row in a list here to see its token")
    expect(token.rows.join(" ")).not.toContain("ORBIT")
  })
})

// ---------------------------------------------------------------------------------------------------------
// Each pane's three states.

const event = (topic: string, data: unknown): CoreEventParams => ({ topic, seq: 0, data, snapshot: true })
const build = (events: [string, unknown][]): CoreView => events.reduce<CoreView>((v, [topic, data]) => applyEvent(v, event(topic, data), CLOCK), { ...EMPTY_VIEW, connected: true })

const WORDS = "upstream busy"
const failure = { at: CLOCK - 5_000, words: WORDS }
const failedPart = { at: CLOCK - 5_000, data: null, failed: failure }

/** Before the core has sent anything but who's here: an agent, live. */
const before = (): CoreView => build([["status", { agents: [{ name: "agent-a", candle: "ready", spentTodayUsd: 0, limits: {} }], activeAgent: "agent-a", mode: "live", paused: false }]])

/** A fresh install, read: nothing traded, nothing recorded. */
const fresh = (): CoreView => {
  const v = build([...freshEvents(), ["away", { summary: null, firstRun: true }], ["bots", { bots: [], problems: [] }]])
  return { ...v, journal: { key: journalKey(undefined), entries: [] }, pnlSeries: { span: "window", from: CLOCK - 86_400_000, at: CLOCK, points: [] }, research: { token: null } }
}

/** A quiet gap whose reads at start all failed: the Away pane says each, never "nothing happened" alone. */
function quietAway(words: string) {
  const counts = { turns: 0, trades: 0, withoutCard: 0, cards: 0, expired: 0, changes: 0, stopped: 0, outside: 0, maybe: 0, signals: 0, holdings: 0 }
  return {
    id: "gap", from: CLOCK - 3 * 3_600_000, to: CLOCK - 60_000, madeAt: CLOCK - 60_000, coreDown: [], coreGoneThroughout: false, turns: [], trades: [], cards: [], changes: [], stopped: [], waitingNow: 0,
    pnl: { state: "failed", label: "since last session", usd: null, from: null, short: false, agents: {}, words },
    outside: { state: "failed", agents: [{ agent: "agent-a", state: "failed", words, fills: [], maybe: [], claimed: 0 }] },
    signals: { state: "failed", count: 0, newest: [], words },
    holdings: { state: "failed", changes: [], words },
    counts,
    happened: false,
  }
}

/** Every read failed, in Candle's or Hacc's words. */
const failed = (): CoreView => {
  const list = (bucket: string) => ({ bucket, at: null, rows: [], failed: failure })
  const v = build([
    ["status", { agents: [{ name: "agent-a", candle: "ready", spentTodayUsd: 0, limits: {} }], activeAgent: "agent-a", mode: "live", paused: false }],
    ["portfolio", { readAt: null, wallets: [], readOnly: [], paper: {}, failed: WORDS }],
    ["hacc", { enabled: true, agents: { "agent-a": { plan: null, key: "refused", why: `Hacc refused agent-a's key (${WORDS}).` } }, stream: { state: "no-key", mine: { state: "closed" } } }],
    ["feeds", { new: list("new"), graduated: list("graduated"), onfire: list("onfire"), finalstretch: list("finalstretch") }],
    ["away", { summary: quietAway(failure.words) }],
    ["bots", { bots: [], problems: [] }],
    ["pnl", { window: "24h", figure: { window: "24h", label: "24h", start: CLOCK - 86_400_000, usd: null, from: null, short: false, agents: {} }, agents: [{ agent: "agent-a", prefix: "agntAb3d", readAt: null, book: null, failed: failure }], sum: null, wallets: [], trades: [], swaps: [], paper: {}, samplesFrom: null }],
  ])
  const token = { mint: MINT, chain: "solana" as const, symbol: "JUPF" }
  return {
    ...v,
    journal: { key: journalKey(undefined), entries: [], failed: WORDS },
    pnlSeries: { span: "window", from: CLOCK - 86_400_000, at: CLOCK, points: [], failed: WORDS },
    research: { token, check: { candle: failedPart, hacc: failedPart }, traders: failedPart, signals: failedPart, mentions: failedPart },
  } as CoreView
}

const LAYOUTS: Layout[] = [AGENT_FIRST, COCKPIT, TRENDING, SIGNALS, PNL, RESEARCH, JOURNAL, PERPS, BOTS, BUILD]
/** Each pane's tabs: every preset it's on, and alone, as popped out. */
const contexts = (id: PaneId): (readonly PaneId[])[] => [...LAYOUTS.map((l) => panesOf(l.root)).filter((p) => p.includes(id)), [id]]

/**
 * The panes with nothing to read: their words are their own, so a failed read can't reach them. The triggers and bots
 * are the core's own, and the Build tab's are the harness's terminal, the bots folder as this view reads it, and the core's tests.
 */
const NO_READ: readonly PaneId[] = ["activity", "perps", "triggers", "bots", "bot", "build", "build-folder", "build-test"]
/** Where a list is on the tab, the token pane before a token points to it, and the list says its read failed. */
const LISTS: readonly PaneId[] = ["feed", "new", "graduated", "final-stretch", "signals", "lists"]
const saysWhy = (id: PaneId, panes: readonly PaneId[]) => !NO_READ.includes(id) && !(id === "token" && panes.some((p) => LISTS.includes(p)))

const said = (id: Exclude<PaneId, "agent">, view: CoreView, panes: readonly PaneId[], w: number) => {
  const drawn = paneLines(id, { view, rect: { x: 0, y: 0, w, h: 20 }, now: CLOCK, only: undefined, panes, at: "Trade" })
  return [...(drawn.head ?? []), ...drawn.lines].map((l) => l.segs.map((s) => s.text).join(""))
}

describe("each pane says something before its first read, with nothing to show, and when its read fails", () => {
  for (const id of PANE_IDS.filter((p): p is Exclude<PaneId, "agent"> => p !== "agent")) {
    test(id, () => {
      for (const [state, view] of [
        ["before", before()],
        ["fresh", fresh()],
        ["failed", failed()],
      ] as const) {
        for (const panes of contexts(id)) {
          for (const w of [30, 100]) {
            const text = said(id, view, panes, w)
            expect({ id, state, panes, w, says: text.some((t) => WORD.test(t)) }).toEqual({ id, state, panes, w, says: true })
            // A failed read says so, in the words it failed with, never "reading" for good.
            if (state === "failed" && saysWhy(id, panes)) expect({ id, panes, w, why: text.join(" ").replace(/\s+/g, " ").includes(WORDS) }).toEqual({ id, panes, w, why: true })
          }
        }
      }
    })
  }

  test("every pane is in the registry this test walks", () => {
    expect(Object.keys(PANES).sort()).toEqual([...PANE_IDS].sort())
  })

  test("Activity shows the tape only before its first line, with Hacc on, where no Signals pane shows it", () => {
    const v = fresh()
    expect(activityTape(v, panesOf(AGENT_FIRST.root))).toBe(true)
    expect(activityTape(v, ["activity", "signals"])).toBe(false)
    expect(activityTape({ ...v, hacc: { ...v.hacc!, enabled: false } }, ["activity"])).toBe(false)
    expect(activityTape({ ...v, activity: [{ seq: 1, at: new Date(CLOCK).toISOString(), text: "paper mode", tone: "info" }] }, ["activity"])).toBe(false)
  })

  test("one thing to try, by what's on the tab", () => {
    expect(tabTip(panesOf(TRENDING.root))).toBe("ctrl-t on a row: it asks me about that token.")
    expect(tabTip(panesOf(SIGNALS.root))).toBe("ctrl-t on a signal: it asks me what it means.")
    expect(tabTip(panesOf(PNL.root))).toBe('asking: "how am I doing today?"')
    expect(tabTip(panesOf(BOTS.root))).toBe('asking: "how are my bots doing?", or for a bot of your own.')
    expect(tabTip(panesOf(JOURNAL.root))).toBe('asking: "what did I trade yesterday?"')
    expect(tabTip(panesOf(PERPS.root))).toBe("a question above, or ask me about perps on Hyperliquid.")
  })
})
