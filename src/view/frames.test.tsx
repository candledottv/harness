// Frames of the Trade tab from realistic data, kept in test/fixtures/frames/ and compared character by
// character and colour by colour (Agent-first on the layout tree draws exactly what the
// hard-coded layout drew). A change meant to move the screen rewrites them with
// UPDATE_FRAMES=1, and the diff shows what moved.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { CLOCK, drawScene, SIGNAL_ROWS, type SceneName, settleJournal } from "../../test/frame-scenes"
import { CANDLE_DARK, CANDLE_LIGHT } from "./theme"
import { memoryThemes } from "./themes"

// Activity's times are local: the frames are kept in UTC.
process.env.TZ = "UTC"
/** PgUp as a terminal sends it (the mock has no name for it). */
const PAGE_UP = "\x1b[5~"

const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

/** `title`: a click on the pane's title, to focus it; ↓ in a pane with token rows moves its highlight, so ↓ doesn't step past it. */
type Press = { arrow: "left" | "right" | "up" | "down" } | { key: string } | { title: string }
const SIZES = [
  [140, 40],
  [120, 30],
  [80, 24],
] as const
/** What's pressed before the frame: none, focus on a side pane, and Activity scrolled. Narrow, the right column is one switched pane. */
const STEPS: { name: string; wide: Press[]; narrow: Press[] }[] = [
  { name: "start", wide: [], narrow: [] },
  { name: "wallets", wide: [{ title: "Wallets" }], narrow: [{ arrow: "right" }, { arrow: "right" }, { arrow: "right" }] },
  { name: "activity-scrolled", wide: [{ title: "Activity" }, { key: PAGE_UP }], narrow: [{ arrow: "right" }, { arrow: "right" }, { arrow: "right" }, { arrow: "right" }, { key: PAGE_UP }] },
]

/**
 * The Cockpit: wide, ← from the agent is the token pane and ← again Feed, ↓ Signals;
 * collapsed (below 130), → walks the switched pane from Feed. Then Signals scrolled down to older rows.
 */
const COCKPIT_SIZES = [
  [160, 45],
  [140, 40],
  [120, 30],
  [80, 24],
] as const
const PAGE_DOWN = "\x1b[6~"
const COCKPIT_STEPS: { name: string; wide: Press[]; narrow: Press[] }[] = [
  { name: "start", wide: [], narrow: [] },
  { name: "signals", wide: [{ title: "Signals" }], narrow: [{ arrow: "right" }, { arrow: "right" }] },
  { name: "signals-scrolled", wide: [{ title: "Signals" }, { key: PAGE_DOWN }], narrow: [{ arrow: "right" }, { arrow: "right" }, { key: PAGE_DOWN }] },
]

/** Each row's characters, then each row's runs of colour and attributes. */
function serialise(s: Setup): string {
  const chars = s.captureCharFrame()
  const runs = s
    .captureSpans()
    .lines.map((l, y) =>
      `${y}: ${l.spans
        .map((sp) => {
          const hex = (c: { r: number; g: number; b: number; a: number }) => [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") + (c.a < 1 ? `@${c.a.toFixed(2)}` : "")
          return `${hex(sp.fg)}/${hex(sp.bg)}${sp.attributes ? `+${sp.attributes}` : ""}×${sp.width}`
        })
        .join(" ")}`,
    )
    .join("\n")
  return `${chars}\n--- colours ---\n${runs}\n`
}

/** A click on the first cell of `text` where it's on screen. */
async function clickText(s: Setup, text: string): Promise<void> {
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes(text))
  if (y < 0) throw new Error(`no "${text}" on screen`)
  await act(async () => s.mockMouse.click(rows[y]!.indexOf(text) + 1, y))
  await s.renderOnce()
}

async function compare(name: string, drawn: Awaited<ReturnType<typeof drawScene>>, presses: readonly Press[]): Promise<void> {
  setup = drawn.setup
  for (const press of presses) {
    await act(async () => {
      if ("title" in press) {
        const rows = drawn.setup.captureCharFrame().split("\n")
        const y = rows.findIndex((r) => r.includes(`╭─ ${press.title}`))
        if (y < 0) throw new Error(`no ${press.title} pane on screen`)
        return drawn.setup.mockMouse.click(rows[y]!.indexOf(`╭─ ${press.title}`) + 3, y)
      }
      return "arrow" in press ? drawn.setup.mockInput.pressArrow(press.arrow) : drawn.setup.mockInput.pressKey(press.key)
    })
    await drawn.setup.renderOnce()
  }
  const got = serialise(drawn.setup)
  const file = join(DIR, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) throw new Error(`No frame kept for ${name}: run with UPDATE_FRAMES=1 to keep this one.\n${got}`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, got)
    return
  }
  expect(got).toBe(readFileSync(file, "utf8"))
}

for (const scene of ["followed", "trending"] as SceneName[]) {
  for (const [width, height] of SIZES) {
    for (const step of STEPS) {
      const name = `${scene}-${width}x${height}-${step.name}`
      test(`Agent-first frame: ${name}`, async () => compare(name, await drawScene(scene, width, height), width < 100 ? step.narrow : step.wide))
    }
  }
}

for (const scene of ["followed", "trending"] as SceneName[]) {
  for (const [width, height] of COCKPIT_SIZES) {
    for (const step of COCKPIT_STEPS) {
      const name = `cockpit-${scene}-${width}x${height}-${step.name}`
      test(`Cockpit frame: ${name}`, async () => compare(name, await drawScene(scene, width, height, "cockpit"), width < 130 ? step.narrow : step.wide))
    }
  }
}

// The Trending tab: Candle's four lists over the token, the short agent pane across the
// foot; below 130 columns one list at a time over the token. Final Stretch on, off (its width goes to the
// others) and behind.
const TRENDING_SIZES = [
  [160, 45],
  [140, 40],
  [120, 30],
  [80, 24],
] as const
for (const [width, height] of TRENDING_SIZES) {
  for (const finalStretch of ["on", "off"] as const) {
    for (const scene of ["followed", "trending"] as SceneName[]) {
      const name = `trending-tab-${scene}-${width}x${height}-stretch-${finalStretch}`
      test(`Trending frame: ${name}`, async () => compare(name, await drawScene(scene, width, height, "trending", undefined, { finalStretch }), []))
    }
  }
}
test("Trending frame: trending-tab-trending-160x45-stretch-behind", async () => compare("trending-tab-trending-160x45-stretch-behind", await drawScene("trending", 160, 45, "trending", undefined, { finalStretch: "behind" }), []))

// The Signals tab: Hacc's tape full width over the token, the short agent pane across
// the foot; below 100 columns Signals and the token switch. The whole tape, a filter with rows, a filter
// that matches nothing (Hacc read back with none, and Hacc's read-back failing), and paused with signals
// arriving after.
const SIGNALS_SIZES = [
  [160, 45],
  [140, 40],
  [120, 30],
  [80, 24],
] as const
for (const [width, height] of SIGNALS_SIZES) {
  for (const scene of ["followed", "trending"] as SceneName[]) {
    const name = `signals-tab-${scene}-${width}x${height}`
    test(`Signals frame: ${name}`, async () => compare(name, await drawScene(scene, width, height, "signals"), []))
  }
  for (const which of ["filtered", "empty"] as const) {
    const name = `signals-tab-followed-${width}x${height}-${which}`
    test(`Signals frame: ${name}`, async () => compare(name, await drawScene("followed", width, height, "signals", undefined, { signals: which }), []))
  }
  test(`Signals frame: signals-tab-followed-${width}x${height}-paused`, async () => {
    const drawn = await drawScene("followed", width, height, "signals")
    setup = drawn.setup
    await clickText(drawn.setup, " pause ")
    // Three signals arrive after the pause: the view holds, and the border counts them.
    for (const [i, row] of SIGNAL_ROWS.slice(0, 3).entries()) {
      await act(async () => drawn.session.push("signals", { rows: [{ ...row, id: 117_000_000 + i, created_at: new Date(CLOCK - 2_000 + i * 500).toISOString() }] }))
    }
    await drawn.setup.renderOnce()
    expect(drawn.setup.captureCharFrame()).toContain("paused · 3 new")
    await compare(`signals-tab-followed-${width}x${height}-paused`, drawn, [])
  })
}
test("Signals frame: signals-tab-followed-140x40-empty-failed", async () => compare("signals-tab-followed-140x40-empty-failed", await drawScene("followed", 140, 40, "signals", undefined, { signals: "empty-failed" }), []))

// The short agent pane across the foot, on the Perps tab over its stub: a card
// waiting (it keeps its rows, the conversation gets the rest), the conversation alone, and a reply
// streaming in, which moves no pane.
const PERPS_SIZES = [
  [140, 40],
  [120, 30],
  [80, 24],
] as const
const STREAMING = "Hyperliquid's biggest perps markets right now, by open interest:\n\n| Market | Open interest | 24h |\n|---|---|---|\n| BTC | $2.1B | +1.2% |\n| ETH | $1.4B | -0.4% |\n| SOL | $610M | +3.8% |\n\nWant"
for (const [width, height] of PERPS_SIZES) {
  test(`Perps frame: perps-followed-${width}x${height}-card`, async () => compare(`perps-followed-${width}x${height}-card`, await drawScene("followed", width, height, "perps"), []))
  test(`Perps frame: perps-trending-${width}x${height}-start`, async () => compare(`perps-trending-${width}x${height}-start`, await drawScene("trending", width, height, "perps"), []))
  test(`Perps frame: perps-trending-${width}x${height}-streaming`, async () => compare(`perps-trending-${width}x${height}-streaming`, await drawScene("trending", width, height, "perps", undefined, { streaming: STREAMING }), []))
  test(`a reply streaming into the short agent pane moves no pane, at ${width}×${height}`, async () => {
    const idle = await drawScene("trending", width, height, "perps")
    const still = idle.setup.captureCharFrame().split("\n")
    await act(async () => idle.setup.dispose())
    const busy = await drawScene("trending", width, height, "perps", undefined, { streaming: STREAMING })
    setup = busy.setup
    const moving = busy.setup.captureCharFrame().split("\n")
    const agentTop = moving.findIndex((r) => r.includes("╭─ agent-a"))
    expect(agentTop).toBe(still.findIndex((r) => r.includes("╭─ agent-a")))
    // Everything above the agent pane, the tab bar down, is as it was.
    expect(moving.slice(1, agentTop)).toEqual(still.slice(1, agentTop))
    expect(height - agentTop).toBe((height >= 30 ? 8 : 6) + 2)
  })
}

// The P&L tab, from books recorded from Candle's real server: at four sizes, several positions and a gap in the
// samples; the window that starts late; a failed read; paper beside live; a fresh install; the window's menu.
const PNL_FRAMES = [
  [160, 45, "full"],
  [140, 40, "short"],
  [120, 30, "failed"],
  [80, 24, "full"],
  [140, 40, "paper"],
  [140, 40, "fresh"],
] as const
for (const [width, height, variant] of PNL_FRAMES) {
  test(`P&L frame: pnl-${variant}-${width}x${height}`, async () => compare(`pnl-${variant}-${width}x${height}`, await drawScene("followed", width, height, "pnl", undefined, { pnl: variant }), []))
}
test("P&L frame: pnl-full-140x40-window-menu (its chip clicked)", async () => {
  const drawn = await drawScene("followed", 140, 40, "pnl", undefined, { pnl: "full" })
  setup = drawn.setup
  await clickText(drawn.setup, "24h ▾")
  await compare("pnl-full-140x40-window-menu", drawn, [])
})

test("the P&L topic is asked for only while a P&L pane is on screen, and the chart's points with it", async () => {
  const drawn = await drawScene("followed", 140, 40, "trade", undefined, { pnl: "full" })
  setup = drawn.setup
  expect(drawn.session.wanted.at(-1)).not.toContain("pnl")
  expect(drawn.session.requests.some((r) => r.method === "pnl.series")).toBe(false)
  for (const arrow of ["up", "right", "right", "right", "right", "down"] as const) {
    await act(async () => drawn.setup.mockInput.pressArrow(arrow))
    await drawn.setup.renderOnce()
  }
  expect(drawn.session.wanted.at(-1)).toContain("pnl")
  const series = drawn.session.requests.filter((r) => r.method === "pnl.series")
  expect(series.at(-1)?.params).toEqual({ from: CLOCK - 86_400_000, points: 480 })
  // A span chip asks again, from its own start.
  await clickText(drawn.setup, " 7d ")
  expect(drawn.session.requests.filter((r) => r.method === "pnl.series").at(-1)?.params).toEqual({ from: CLOCK - 7 * 86_400_000, points: 480 })
})

// The Journal tab: two days of a trader's journal in the core's own words, at four sizes;
// a fresh install's; a search typed into its line; and ctrl-o on a row, its rows as recorded.
const JOURNAL_SIZES = [
  [160, 45],
  [140, 40],
  [120, 30],
  [80, 24],
] as const
for (const [width, height] of JOURNAL_SIZES) {
  test(`Journal frame: journal-${width}x${height}`, async () => compare(`journal-${width}x${height}`, await drawScene("followed", width, height, "journal", undefined, { journal: "full" }), []))
}
test("Journal frame: journal-empty-140x40 (a fresh install)", async () => compare("journal-empty-140x40", await drawScene("trending", 140, 40, "journal", undefined, { journal: "empty" }), []))

// A fresh install's every tab: one agent, paper, nothing traded or recorded, at 120×30 and 80×24.
for (const tab of ["trade", "cockpit", "trending", "signals", "pnl", "research", "journal", "perps"] as const) {
  for (const [w, h] of [
    [120, 30],
    [80, 24],
  ] as const) {
    const name = `fresh-${tab}-${w}x${h}`
    test(`fresh install frame: ${name}`, async () => compare(name, await drawScene("fresh", w, h, tab), []))
  }
}
test("Journal frame: journal-search-140x40 (↑ to its search, JUPF typed)", async () => {
  const drawn = await drawScene("followed", 140, 40, "journal", undefined, { journal: "full" })
  setup = drawn.setup
  await clickText(drawn.setup, "╭─ Journal")
  await act(async () => drawn.setup.mockInput.pressArrow("up"))
  for (const ch of "jupf filled") await act(async () => drawn.setup.mockInput.pressKey(ch))
  await settleJournal(drawn.setup, 200)
  const query = drawn.session.requests.filter((r) => r.method === "journal.query").at(-1)
  expect(query?.params).toMatchObject({ text: "jupf filled" })
  await compare("journal-search-140x40", drawn, [])
})
test("Journal frame: journal-rows-140x40 (ctrl-o on a card's row)", async () => {
  const drawn = await drawScene("followed", 140, 40, "journal", undefined, { journal: "full" })
  setup = drawn.setup
  await clickText(drawn.setup, "╭─ Journal")
  await act(async () => drawn.setup.mockInput.pressArrow("down"))
  await act(async () => drawn.setup.mockInput.pressKey("o", { ctrl: true }))
  await settleJournal(drawn.setup)
  expect(drawn.session.requests.some((r) => r.method === "journal.rows")).toBe(true)
  await compare("journal-rows-140x40", drawn, [])
})

// The Research tab: one token in depth, a recorded JUP and a token minutes old, at four sizes.
const RESEARCH_SIZES = [
  [160, 45],
  [140, 40],
  [120, 30],
  [80, 24],
] as const
for (const variant of ["jup", "young"] as const) {
  for (const [width, height] of RESEARCH_SIZES) {
    test(`Research frame: research-${variant}-${width}x${height}`, async () => compare(`research-${variant}-${width}x${height}`, await drawScene("followed", width, height, "research", undefined, { research: variant }), []))
  }
}

test("Research's reads are asked for only while one of its panes is on screen: collapsed, the one shown; leaving the tab drops them", async () => {
  for (const [width, parts] of [
    [160, ["check", "traders", "signals", "mentions"]],
    // Collapsed, the token shows first: nothing of Research's until Check is switched to.
    [100, []],
  ] as const) {
    const drawn = await drawScene("followed", width, 45)
    setup = drawn.setup
    const s = drawn.setup
    const press = async (fn: () => void) => {
      await act(async () => fn())
      await s.renderOnce()
    }
    for (const arrow of ["up", ...Array.from({ length: 5 }, () => "right" as const)] as const) await press(() => s.mockInput.pressArrow(arrow))
    expect(s.captureCharFrame()).toContain("6 Research")
    if (parts.length) {
      // The list pane to pick from reads its list too.
      expect(drawn.session.wanted.at(-1)).toEqual(["feeds", "research", "asks"])
      expect(drawn.session.filters.at(-1)).toEqual({ feeds: { buckets: ["onfire"] }, research: { parts: [...parts] } })
    } else {
      expect(drawn.session.wanted.at(-1)).toEqual(["asks"])
      // Down to the switched pane, and along to Check.
      await press(() => s.mockInput.pressArrow("down"))
      await clickText(s, "╭─ Token")
      await press(() => s.mockInput.pressArrow("right"))
      expect(s.captureCharFrame()).toContain("╭─ Check")
      expect(drawn.session.filters.at(-1)).toEqual({ research: { parts: ["check"] } })
    }
    await press(() => s.mockInput.pressArrow("up"))
    for (const arrow of ["up", "left"] as const) await press(() => s.mockInput.pressArrow(arrow))
    expect(drawn.session.wanted.at(-1)).not.toContain("research")
    await act(async () => s.dispose())
    setup = undefined
  }
})

// Both built-in themes: a rendered reply with a table, a card, and the kill switch's
// report with the sell it kept, at 140×40. Candle dark's must match the frames above.
for (const theme of [CANDLE_DARK, CANDLE_LIGHT]) {
  for (const kill of [false, true]) {
    const name = `theme-${theme.toLowerCase().replace(" ", "-")}-140x40${kill ? "-kill" : ""}`
    test(`theme frame: ${name}`, async () => compare(name, await drawScene("followed", 140, 40, "trade", undefined, { themes: memoryThemes({}, { name: theme }), kill }), []))
  }
}

test("Hacc's tape is subscribed only while the tab on screen shows Signals, and its chip switches to your own rules", async () => {
  const drawn = await drawScene("followed", 160, 45)
  setup = drawn.setup
  const s = drawn.setup
  const press = async (fn: () => void) => {
    await act(async () => fn())
    await s.renderOnce()
  }
  // The Trade tab has no Signals pane: nothing beyond the view's own topics, and the agent's asks.
  expect(drawn.session.wanted.at(-1) ?? []).toEqual(["asks"])
  for (const arrow of ["up", "right", "down"] as const) await press(() => s.mockInput.pressArrow(arrow))
  // The Cockpit's Feed asks for On Fire too.
  expect(drawn.session.wanted.at(-1)).toEqual(["signals", "feeds", "asks"])
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes("Signals · Hacc's tape"))
  const x = rows[y]!.indexOf("all ▾")
  await press(() => s.mockMouse.click(x + 1, y))
  expect(drawn.session.wanted.at(-1)).toEqual(["signals:mine", "feeds", "asks"])
  expect(s.captureCharFrame()).toContain("Signals · your rules")
  expect(s.captureCharFrame()).toContain("mine ▾")
  // Back on the Trade tab, the stream is let go.
  for (const arrow of ["up", "left"] as const) await press(() => s.mockInput.pressArrow(arrow))
  expect(drawn.session.wanted.at(-1)).toEqual(["asks"])
})

test("Candle's lists are subscribed only while a pane on screen shows them; leaving the tab drops them", async () => {
  for (const [width, buckets] of [
    [160, ["new", "graduated", "onfire", "finalstretch"]],
    // Collapsed, one list shows at a time over the token: only it is read.
    [100, ["new"]],
  ] as const) {
    const drawn = await drawScene("followed", width, 45)
    setup = drawn.setup
    const s = drawn.setup
    const press = async (fn: () => void) => {
      await act(async () => fn())
      await s.renderOnce()
    }
    // Along the tab bar, as a tab is picked there.
    for (const arrow of ["up", "right", "right"] as const) await press(() => s.mockInput.pressArrow(arrow))
    expect(s.captureCharFrame()).toContain("╭─ New")
    expect(drawn.session.wanted.at(-1)).toEqual(["feeds", "asks"])
    expect(drawn.session.filters.at(-1)).toEqual({ feeds: { buckets: [...buckets] } })
    for (const arrow of ["left", "left"] as const) await press(() => s.mockInput.pressArrow(arrow))
    expect(drawn.session.wanted.at(-1)).toEqual(["asks"])
    expect(drawn.session.filters.at(-1)).toEqual({})
    await act(async () => s.dispose())
    setup = undefined
  }
})
