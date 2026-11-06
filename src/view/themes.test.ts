// Themes of your own, config.toml's [theme] name and the choice kept.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILT_IN, CANDLE_DARK, CANDLE_LIGHT, TERMINAL } from "./theme"
import { configTheme, fileThemes, loadTheme, memoryThemes, parseTheme, startingTheme } from "./themes"

const DARK = BUILT_IN[CANDLE_DARK]!
const LIGHT = BUILT_IN[CANDLE_LIGHT]!
const DRACULA = { defaultBackground: "#282a36", defaultForeground: "#f8f8f2", palette: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"] }

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

test("a theme of yours sets the roles it names, in words, with the reply's under [reply]; the rest are its base's", () => {
  const read = parseTheme('base = "candle light"\npane = "#fafafa"\nattention = "#7a4f00"\n\n[reply]\ncode = "#0550ae"\n', "themes/Paper.toml")
  expect(read).toEqual({ base: CANDLE_LIGHT, set: { term: "#fafafa", look: "#7a4f00", mdCode: "#0550ae" }, problems: [] })
  const loaded = loadTheme("Paper", memoryThemes({ Paper: 'base = "Candle light"\npane = "#fafafa"\n' }))
  expect(loaded).toEqual({ name: "Paper", used: true, colours: { ...LIGHT, term: "#fafafa" }, problems: [] })
})

test("each leaf that can't be read is named with its line and left out; the theme is still used", () => {
  const source = ['base = "Candle dusk"', 'pane = "blue"', "glow = \"#ffffff\"", "", "[reply]", 'code = "#9ecbff"', "italic = \"#ffffff\""].join("\n")
  const read = parseTheme(source, "themes/Mine.toml")
  expect(read.base).toBe(CANDLE_DARK)
  expect(read.set).toEqual({ mdCode: "#9ecbff" })
  expect(read.problems).toEqual([
    'themes/Mine.toml line 1: base is "Candle dusk"; a theme starts from "Candle dark" or "Candle light", so it\'s Candle dark',
    'themes/Mine.toml line 2: pane is "blue"; a colour is written "#rrggbb", such as "#6cb6ff". It\'s left out.',
    'themes/Mine.toml line 3: "glow" isn\'t one of a theme\'s colours (page, bar, pane, border, selected, focus, bright, text, dim, heading, attention, good, bad, control, control_bg, control_hover, bad_bg, paper_bg, and [reply]). It\'s left out.',
    'themes/Mine.toml line 7: "italic" isn\'t one of a reply\'s colours (heading, bright, dim, code, quote). It\'s left out.',
  ])
  const loaded = loadTheme("Mine", memoryThemes({ Mine: source }))
  expect(loaded.used).toBe(true)
  expect(loaded.colours).toEqual({ ...DARK, mdCode: "#9ecbff" })
  expect(loaded.problems).toHaveLength(4)
})

test("a file that isn't TOML is named, and nothing of it is used", () => {
  expect(parseTheme("pane = #fff", "themes/Bad.toml").problems[0]).toStartWith("themes/Bad.toml isn't valid TOML (")
})

test("a theme that would make text unreadable or hide a meaning isn't used, and says why", () => {
  const store = memoryThemes({ Faint: 'dim = "#2a2e36"', Alike: 'good = "#ff5c5c"' })
  const faint = loadTheme("Faint", store)
  expect(faint.used).toBe(false)
  expect(faint.colours).toEqual(DARK)
  expect(faint.problems[0]).toMatch(/^themes\/Faint\.toml can't be used, since dim text on term is 1\.\d:1, under 4:1 \(and \d more\)$/)
  expect(loadTheme("Alike", store).problems[0]).toBe("themes/Alike.toml can't be used, since good and bad are too alike to tell apart")
})

test("a theme there isn't says which there are", () => {
  expect(loadTheme("Ocean", memoryThemes({ Paper: "" }))).toEqual({ name: "Ocean", used: false, colours: DARK, problems: ['There\'s no theme called "Ocean" (the themes: Candle dark, Candle light, Terminal, Paper)'] })
  // A name that couldn't be a file's isn't looked for.
  expect(loadTheme("../config", memoryThemes({ "../config": "" })).used).toBe(false)
})

test("built-ins are found whatever their case; Terminal needs the terminal's colours", () => {
  expect(loadTheme("candle LIGHT", undefined)).toEqual({ name: CANDLE_LIGHT, used: true, colours: LIGHT, problems: [] })
  const blind = loadTheme(TERMINAL, undefined)
  expect(blind.used).toBe(false)
  expect(blind.problems[0]).toBe("Terminal draws from the terminal's own colours, and this terminal didn't say what they are")
  const seen = loadTheme("terminal", undefined, DRACULA)
  expect(seen.used).toBe(true)
  expect(seen.colours.term).toBe("#282a36")
})

test("config.toml's [theme] name, and what's wrong with it, by line", () => {
  expect(configTheme(undefined)).toEqual({})
  expect(configTheme('mode = "paper"\n')).toEqual({})
  expect(configTheme('[theme]\nname = "candle light"\n')).toEqual({ name: CANDLE_LIGHT })
  expect(configTheme('[theme]\nname = "Paper"\n')).toEqual({ name: "Paper" })
  expect(configTheme('mode = "paper"\n\n[theme]\nname = 3\n')).toEqual({ problem: 'config.toml line 4: theme.name is 3; it\'s a theme\'s name, such as "Candle light"' })
  expect(configTheme('[theme]\nshade = "x"\n').problem).toBe("config.toml line 2: theme.shade isn't a setting (name)")
  expect(configTheme('theme = "dark"\n').problem).toBe('config.toml line 1: theme must be a table, such as [theme] then name = "Candle light"')
})

test("a view starts on the last choice, until config.toml's [theme] name is changed by hand; then on that", () => {
  expect(startingTheme(undefined, undefined)).toBe(CANDLE_DARK)
  expect(startingTheme(memoryThemes(), CANDLE_LIGHT)).toBe(CANDLE_LIGHT)
  // Picked from the palette while config said nothing, and config still says nothing: the pick holds.
  expect(startingTheme(memoryThemes({}, { name: TERMINAL }), undefined)).toBe(TERMINAL)
  // Picked while config said Candle light: the pick holds while it still does.
  expect(startingTheme(memoryThemes({}, { name: TERMINAL, config: CANDLE_LIGHT }), CANDLE_LIGHT)).toBe(TERMINAL)
  // config.toml edited since: the edit wins.
  expect(startingTheme(memoryThemes({}, { name: TERMINAL, config: CANDLE_LIGHT }), "Paper")).toBe("Paper")
  expect(startingTheme(memoryThemes({}, { name: TERMINAL }), CANDLE_LIGHT)).toBe(CANDLE_LIGHT)
})

test("the file store: your themes from the folder, built-in names and odd files left out, the choice kept 0600", () => {
  dir = mkdtempSync(join(tmpdir(), "themes-"))
  const themesDir = join(dir, "themes")
  const store = fileThemes({ themesDir, themeChoice: join(dir, "theme.json") })
  expect(store.own()).toEqual([])
  expect(store.chosen()).toBeUndefined()
  mkdirSync(themesDir)
  for (const f of ["Paper.toml", "night owl.toml", "candle dark.toml", ".hidden.toml", "notes.txt"]) writeFileSync(join(themesDir, f), 'pane = "#ffffff"\n')
  expect(store.own()).toEqual(["night owl", "Paper"])
  expect(store.read("Paper")).toBe('pane = "#ffffff"\n')
  expect(store.read("Ocean")).toBeUndefined()
  store.saveChosen({ name: "Paper", config: CANDLE_LIGHT })
  expect(store.chosen()).toEqual({ name: "Paper", config: CANDLE_LIGHT })
  expect(statSync(join(dir, "theme.json")).mode & 0o777).toBe(0o600)
})
