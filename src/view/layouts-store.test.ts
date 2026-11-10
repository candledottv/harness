// Where the view keeps layouts: layouts.toml written whole and 0600; each tab's choice
// in state/layout.json, 0600, read back after a restart. The doctor names a bad file by its line.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../paths"
import { layoutsChecks } from "../setup/doctor"
import { fileStore } from "./layouts-store"

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})
const home = () => {
  const h = mkdtempSync("/tmp/chrn-lay-")
  homes.push(h)
  const p = paths({ CANDLE_HARNESS_HOME: h })
  mkdirSync(p.stateDir, { recursive: true })
  return p
}

test("layouts.toml and each tab's choice are written 0600, and a fresh store reads them back (a restart)", () => {
  const p = home()
  const store = fileStore(p)
  expect(store.read()).toBeUndefined()
  expect(store.choices()).toEqual({})
  store.write("tabs = []\n")
  store.saveChoices({ Trade: "My desk" })
  expect(statSync(p.layoutsFile).mode & 0o777).toBe(0o600)
  expect(statSync(p.layoutChoice).mode & 0o777).toBe(0o600)
  expect(p.layoutsFile).toBe(join(p.configDir, "layouts.toml"))
  expect(p.layoutChoice).toBe(join(p.stateDir, "layout.json"))
  const again = fileStore(p)
  expect(again.read()).toBe("tabs = []\n")
  expect(again.choices()).toEqual({ Trade: "My desk" })
  // A choice file someone broke reads as none.
  writeFileSync(p.layoutChoice, "{not json")
  expect(fileStore(p).choices()).toEqual({})
  expect(readFileSync(p.layoutsFile, "utf8")).toBe("tabs = []\n")
})

test("the doctor: no file, a good one, and a bad one named by its line", () => {
  const p = home()
  expect(layoutsChecks(p)).toEqual([
    { area: "layouts", state: "ok", text: `no ${p.layoutsFile}: 5 tabs (Trade, Cockpit, Research, Bots, Build), each on its preset, 5 ticked off (Trending, Signals, P&L, Journal, Perps)` },
    { area: "layouts", state: "ok", text: "Trade shows Agent-first; Cockpit shows Cockpit; Research shows Research; Bots shows Bots; Build shows Build" },
  ])
  writeFileSync(p.layoutsFile, `[layouts.Desk]\nroot = ["row", "agent", "token"]\n`)
  expect(layoutsChecks(p)[0]).toMatchObject({ state: "ok", text: `${p.layoutsFile}: 5 tabs shown (Trade, Cockpit, Research, Bots, Build), 5 ticked off (Trending, Signals, P&L, Journal, Perps), 1 layout of yours` })
  // The tabs shown and ticked off, and the new ones a file that lists tabs has unticked.
  writeFileSync(p.layoutsFile, `tabs = [{ name = "Trade", layout = "Agent-first" }, { name = "Tape", layout = "Cockpit", shown = false }]\n`)
  const ticks = layoutsChecks(p)
  expect(ticks[0]).toMatchObject({ text: `${p.layoutsFile}: 1 tab shown (Trade), 9 ticked off (Tape, Trending, Signals, P&L, Research, Journal, Perps, Bots, Build), 0 layouts of yours` })
  expect(ticks[1]).toMatchObject({ text: `new since ${p.layoutsFile} listed its tabs, ticked off: Trending, Signals, P&L, Research, Journal, Perps, Bots, Build. Tick them on in the view's settings ▾.` })
  expect(ticks.at(-1)).toMatchObject({ text: "Trade shows Agent-first" })
  writeFileSync(p.layoutsFile, `[layouts.Desk]\nroot = ["row", "agnet"]\n`)
  const [bad] = layoutsChecks(p)
  expect(bad).toMatchObject({ area: "layouts", state: "warn" })
  expect(bad!.text).toStartWith(`layouts.toml line 2: layout "Desk": there's no pane called "agnet"`)
  expect(bad!.fix).toContain("won't write the file")
})

test("text TOML won't read back is refused, and layouts.toml is left as it was", () => {
  const p = home()
  const store = fileStore(p)
  store.write("tabs = []\n")
  expect(() => store.write(`[[layouts]]\nname = ${JSON.stringify("Mine\u007f")}\n`)).toThrow(/wouldn't read back/)
  expect(readFileSync(p.layoutsFile, "utf8")).toBe("tabs = []\n")
})
