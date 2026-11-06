// The feature map agrees with the code both ways, and each check catches what it's for.
import { beforeAll, describe, expect, test } from "bun:test"
import { type DocsMap, type Feature, loadMap, mapProblems, type Sources, sources } from "./docs-map"

let src: Sources
const map = loadMap()

beforeAll(async () => {
  src = await sources()
})

/** The map with one feature changed. */
const withFeature = (id: string, change: (f: Feature) => Feature): DocsMap => ({ ...map, features: map.features.map((f) => (f.id === id ? change(f) : f)) })

describe("the docs' feature map", () => {
  test("names only what exists, and leaves nothing out", () => {
    expect(mapProblems(map, src)).toEqual([])
  })

  test("the sources it's checked against were read", () => {
    expect(src.keys.length).toBeGreaterThan(20)
    expect(src.palette).toContain("tour")
    expect(src.doctor).toContain("wallet")
    expect(src.subcommands).toEqual(expect.arrayContaining(["view", "setup", "view --pane", "key add", "doctor", "cli-pane"]))
    expect(src.tools).toContain("hacc_lab")
  })

  test("a key, pane, tab, tool, palette row, doctor area, command or CLI row that doesn't exist", () => {
    const made = withFeature("cards", (f) => ({ ...f, keys: [...f.keys!, "teleport"], panes: ["orderbook"], tabs: ["Options"], tools: ["harness_teleport"], palette: ["teleport"], doctor: ["teleport"], subcommands: ["teleport"], cli: ["teleport now"] }))
    expect(mapProblems(made, src)).toEqual([
      'cards: names key "teleport", and there\'s no such key',
      'cards: names pane "orderbook", and there\'s no such pane',
      'cards: names tab "Options", and there\'s no such tab',
      'cards: names tool "harness_teleport", and there\'s no such tool',
      'cards: names palette row "teleport", and there\'s no such palette row',
      'cards: names doctor area "teleport", and there\'s no such doctor area',
      'cards: names command "teleport", and there\'s no such command',
      'cards: names CLI row "teleport now", and Candle\'s CLI has no such command',
    ])
  })

  test("a key, pane or tool the code has and no feature names", () => {
    const less = { ...map, features: map.features.map((f) => (f.id === "kill-switch" ? { ...f, keys: [] } : f.id === "perps" ? { ...f, panes: [] } : f.id === "hacc-lab" ? { ...f, tools: [] } : f)) }
    expect(mapProblems(less, src)).toEqual(['key "kill" is in no feature', 'pane "perps" is in no feature', 'tool "hacc_lab" is in no feature'])
  })

  test("an item two features name", () => {
    const twice = withFeature("quit", (f) => ({ ...f, keys: [...f.keys!, "kill"] }))
    expect(mapProblems(twice, src)).toEqual(['kill-switch: names key "kill", which quit already names'])
  })

  test("a typed line the input line refuses, and a kind of command no line shows", () => {
    const refused = withFeature("typed-trades", (f) => ({ ...f, typed: [...f.typed!, "sell 100% ORE"] }))
    expect(mapProblems(refused, src)[0]).toStartWith('typed-trades: typed "sell 100% ORE" is refused: Not a trade yet: ORE isn\'t a token')
    const noVault = withFeature("vault", (f) => ({ ...f, typed: [] }))
    expect(mapProblems(noVault, src)).toEqual(["no typed line in the map is a forgetVault command"])
  })

  test("a setting the table doesn't have, and one no feature names, in any of the four files", () => {
    const unknown = withFeature("pnl", (f) => ({ ...f, settings: [...f.settings!, "config.toml pnl.span"] }))
    expect(mapProblems(unknown, src)).toEqual(['pnl: names setting "config.toml pnl.span", and there\'s no such setting'])
    const less = map.features.map((f) => (f.id === "step-cap" || f.id === "wallet-groups" || f.id === "tabs-shown" ? { ...f, settings: [] } : f.id === "themes" ? { ...f, settings: f.settings!.filter((s) => s !== "theme focus") } : f))
    expect(mapProblems({ ...map, features: less }, src)).toEqual([
      'setting "config.toml engine.stepCap" is in no feature',
      'setting "layouts.toml tabs[].shown" is in no feature',
      'setting "wallets.toml groups.<group>.prefix" is in no feature',
      'setting "wallets.toml groups.<group>.wallets" is in no feature',
      'setting "theme focus" is in no feature',
    ])
    const added = { ...src, settings: [...src.settings, "config.toml pnl.span"] }
    expect(mapProblems(map, added)).toEqual(['setting "config.toml pnl.span" is in no feature'])
  })

  test("a page with no feature, a feature on no page, and words from how it was built", () => {
    const off = withFeature("perps", (f) => ({ ...f, page: "perps" }))
    expect(mapProblems(off, src)).toEqual(['perps: names page "perps", which isn\'t in pages'])
    const empty = { ...map, features: map.features.filter((f) => f.page !== "while-you-were-away") }
    expect(mapProblems(empty, src)).toContain('page "while-you-were-away" covers no feature')
    // Built from pieces, so this file's own text carries none of the words it plants.
    const word = ["mile", "stone"].join("")
    const built = withFeature("perps", (f) => ({ ...f, what: `Arrives in ${word} 8.` }))
    expect(mapProblems(built, src)).toEqual([`perps: says "${word}", which belongs to how it was built, not what it does`])
  })
})
