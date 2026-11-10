// The tab bar at narrow widths: the tab you're on keeps its name, the others
// shrink to a digit and three letters, then their digit, and `settings ▾` is never cut.
import { expect, test } from "bun:test"
import { DEFAULT_TABS } from "./layouts-file"
import { SETTINGS_CHIP, settingsColumn, tabLabels } from "./tabs"

// The shrinking rules on eight tabs, as they were written; a fresh install's nine are checked by the frames.
const EIGHT = DEFAULT_TABS.slice(0, 8).map((t) => t.name)
const ELEVEN = [...EIGHT, "Watch", "Desk", "Tape"]
const width = (labels: ReturnType<typeof tabLabels>) => labels.reduce((n, l) => n + l.label.length + 2 + (l.marked ? 1 : 0), 0) + SETTINGS_CHIP.length + 3

test("at every width from 60 to 200, with eight tabs or eleven: the active tab's name, every tab reachable where it fits, settings ▾ never cut", () => {
  for (const tabs of [EIGHT, ELEVEN]) {
    for (let w = 60; w <= 200; w++) {
      for (let tab = 0; tab < tabs.length; tab++) {
        const labels = tabLabels(tabs, tab, w)
        expect({ w, tab, fits: width(labels) <= w - 1 }).toEqual({ w, tab, fits: true })
        const active = labels.find((l) => l.index === tab)!
        expect(active.label).toBe(tab < 9 ? `${tab + 1} ${tabs[tab]}` : tabs[tab]!)
        // In order, each once.
        expect(labels.map((l) => l.index)).toEqual([...labels.map((l) => l.index)].sort((a, b) => a - b))
      }
    }
  }
})

test("shrinking: names, then a digit and three letters, then digits; past nine, three letters, then one", () => {
  expect(tabLabels(EIGHT, 0, 140).map((l) => l.label)).toEqual(["1 Trade", "2 Cockpit", "3 Trending", "4 Signals", "5 P&L", "6 Research", "7 Journal", "8 Perps"])
  expect(tabLabels(EIGHT, 1, 80).map((l) => l.label)).toEqual(["1 Tra", "2 Cockpit", "3 Tre", "4 Sig", "5 P&L", "6 Res", "7 Jou", "8 Per"])
  expect(tabLabels(EIGHT, 2, 62).map((l) => l.label)).toEqual(["1", "2", "3 Trending", "4", "5", "6", "7", "8"])
  expect(tabLabels(ELEVEN, 0, 100).map((l) => l.label).slice(8)).toEqual(["9 Wat", "Des", "Tap"])
  expect(tabLabels(ELEVEN, 0, 60).map((l) => l.label).slice(8)).toEqual(["9", "D", "T"])
  // All eleven fit at 60, by digit and letter.
  expect(tabLabels(ELEVEN, 10, 60)).toHaveLength(11)
})

test("past what even digits fit, the tabs furthest from the one you're on are left off; the palette reaches them", () => {
  const many = Array.from({ length: 30 }, (_, i) => `T${i}`)
  const labels = tabLabels(many, 0, 60)
  expect(labels[0]).toMatchObject({ index: 0, label: "1 T0" })
  expect(labels.length).toBeLessThan(30)
  expect(width(labels)).toBeLessThanOrEqual(59)
  expect(labels.at(-1)!.index).toBe(labels.length - 1)
})

test("the settings menu opens under its chip, wherever the tabs end", () => {
  expect(settingsColumn(EIGHT, 0, 140)).toBe(83)
  expect(settingsColumn(EIGHT, 0, 80)).toBe(59)
  expect(settingsColumn(["Trade", "Cockpit"], 0, 140)).toBe(21)
})
