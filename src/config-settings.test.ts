// The settings table (config-settings.ts) agrees with each file's reader both ways: every setting it names is
// one the reader takes, its example sets it, and its default is what the reader gives; and a key it doesn't
// name draws a warning, so a setting can't be read without words for the docs.
import { describe, expect, test } from "bun:test"
import { parseConfig } from "./config"
import { keysIn, SETTINGS, type SettingsFile } from "./config-settings"
import { parseBotsFile } from "./core/bots-file"
import { parseTriggersFile } from "./core/triggers-file"
import { parseWalletsFile } from "./core/wallets-file"
import { parseAliases } from "./shared/aliases"
import { parseLayouts } from "./view/layouts-file"
import { configTheme, KEYS as THEME_KEYS, parseTheme, REPLY_KEYS } from "./view/themes"

/** What each file's reader says about a file: its problems and warnings, every one. */
function readerSays(file: SettingsFile, source: string): string[] {
  switch (file) {
    case "config.toml": {
      const said: string[] = []
      try {
        said.push(...parseConfig(source, "config.toml", { setup: true }).warnings)
      } catch (error) {
        said.push((error as Error).message)
      }
      said.push(...parseAliases(source).problems)
      const theme = configTheme(source).problem
      if (theme) said.push(theme)
      return said
    }
    case "layouts.toml":
      return parseLayouts(source).problems
    case "wallets.toml":
      return parseWalletsFile(source).problems
    case "triggers.toml":
      return parseTriggersFile(source).problems
    case "bots.toml":
      return parseBotsFile(source).problems
    case "theme":
      return parseTheme(source, "mine.toml").problems
  }
}

/** The last part of a key that's a word of the file's, not a name you choose: `preset` of agents.<name>.preset. */
const leafOf = (key: string): string =>
  key
    .split(".")
    .map((p) => p.replace(/\[\]$/, ""))
    .filter((p) => !p.startsWith("<") && !p.startsWith('"'))
    .at(-1)!

/** The example with its key's word changed, as a mistyped setting would be. */
const misspelt = (example: string, leaf: string): string => example.replace(new RegExp(`(^|[\\s\\[.{,])${leaf}(?=\\s*[=\\].])`, "m"), `$1${leaf}Zz`)

describe("the settings table", () => {
  test("a default wallet's words say what pays where none is set: the embedded wallet where the key may, else the only TEE wallet there", () => {
    const words = (key: string) => SETTINGS.find((s) => s.key === key)!
    expect(words("agents.<name>.wallet").words).toContain("a trade on the other chain pays as if none were set: from the embedded wallet there where the key may pay from it, else from its only TEE wallet there.")
    expect(words("agents.<name>.wallet.hood").default).toBe("the embedded wallet, when the agent's key may pay from it; else its only Hood TEE wallet")
    expect(words("mode").words).toContain("a run of setup again keeps the mode you're on")
    expect(words("mode").words).toContain("ends live unless you picked paper during it")
  })

  test("each setting is listed once, with a type, a default, words and an example", () => {
    const ids = SETTINGS.map((s) => `${s.file} ${s.key}`)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    for (const s of SETTINGS) expect(`${s.key}: ${[s.type, s.default, s.words, s.example].every((t) => t.trim() !== "")}`).toBe(`${s.key}: true`)
  })

  test("each example is read by its file's reader without a word, and the same with its key misspelt draws one", () => {
    const wrong: string[] = []
    for (const s of SETTINGS) {
      const leaf = leafOf(s.key)
      const said = readerSays(s.file, s.example)
      if (said.length) wrong.push(`${s.file} ${s.key}: ${said.join("; ")}`)
      const typo = misspelt(s.example, leaf)
      if (typo === s.example) wrong.push(`${s.file} ${s.key}: its example doesn't set ${leaf}`)
      else if (readerSays(s.file, typo).length === 0) wrong.push(`${s.file} ${s.key}: the reader takes ${leaf}Zz as readily as ${leaf}`)
    }
    expect(wrong).toEqual([])
  })

  test("the misspelling lands on the key's own word, in each file's shapes", () => {
    const cases: [string, string][] = [
      ["agents.<name>.preset", `[agents.a]\npreset = "bare"`],
      ["tabs[].shown", `tabs = [{ name = "Perps", layout = "Perps", shown = false }]`],
      ['names."<address>"', `[names]\n"x" = "main"`],
      ["reply.code", `[reply]\ncode = "#9ecbff"`],
    ]
    expect(cases.map(([key, example]) => misspelt(example, leafOf(key)))).toEqual([`[agents.a]\npresetZz = "bare"`, `tabs = [{ name = "Perps", layout = "Perps", shownZz = false }]`, `[namesZz]\n"x" = "main"`, `[reply]\ncodeZz = "#9ecbff"`])
  })

  test("a key the table doesn't name warns in every reader, where a reader warns", () => {
    expect(readerSays("config.toml", `[pnl]\nspan = "7d"`)).toEqual(["unknown setting pnl.span, ignored"])
    expect(readerSays("config.toml", `[theme]\nfont = "mono"`)[0]).toContain("theme.font isn't a setting (name)")
    expect(readerSays("layouts.toml", `tabs = [{ name = "Desk", layout = "Cockpit", pinned = true }]`)[0]).toContain(`"pinned" isn't a tab's setting (name, layout, shown)`)
    expect(readerSays("wallets.toml", `[groups.bots]\nprefix = "bot-"\ncolour = "red"`)[0]).toContain(`"colour" isn't something a group holds (prefix, wallets)`)
  })

  test("a theme's keys are its reader's colours, its base and [reply]", () => {
    expect(keysIn("theme", "").sort()).toEqual(["base", "reply", ...Object.keys(THEME_KEYS)].sort())
    expect(keysIn("theme", "reply").sort()).toEqual(Object.keys(REPLY_KEYS).sort())
  })

  test("config.toml's defaults, where there's a value, are what its reader gives for an empty file", () => {
    const { config } = parseConfig("", "config.toml", { setup: true })
    const checked: string[] = []
    for (const s of SETTINGS) {
      if (s.file !== "config.toml" || s.key.includes("<")) continue
      let literal: unknown
      try {
        literal = (Bun.TOML.parse(`v = ${s.default}`) as { v: unknown }).v
      } catch {
        continue // a default in words: "the engine's own default"
      }
      const value = s.key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], config)
      if (value === undefined) continue // the view's own: theme.name
      const same = typeof literal === "string" && typeof value === "string" ? literal.toLowerCase() === value.toLowerCase() : JSON.stringify(literal) === JSON.stringify(value)
      expect(`${s.key}: ${same ? "same" : `${s.default} in the table, ${JSON.stringify(value)} read`}`).toBe(`${s.key}: same`)
      checked.push(s.key)
    }
    expect(checked).toEqual(expect.arrayContaining(["mode", "engine.stepCap", "pnl.window", "skills.from", "hacc.enabled", "trade.spendAsset"]))
  })

  test("each reader's tables are read from it", () => {
    expect(keysIn("config.toml", "agents.<name>").sort()).toEqual(["limits", "preset", "tools", "wake", "wallet"])
    expect(keysIn("config.toml", "agents.<name>.wake")).toEqual(["perHour", "perDay"])
    expect(keysIn("config.toml", "aliases")).toEqual([])
    expect(keysIn("layouts.toml", "")).toEqual(["tabs", "layouts"])
    expect(keysIn("layouts.toml", "tabs[]")).toEqual(["name", "layout", "shown"])
    expect(keysIn("wallets.toml", "groups.<group>")).toEqual(["prefix", "wallets"])
    expect(keysIn("triggers.toml", "")).toEqual(["triggers"])
    expect(keysIn("triggers.toml", "triggers.<name>")).toEqual(["agent", "line", "expansion", "on", "again", "cooldown", "mode", "chain"])
    expect(keysIn("bots.toml", "")).toEqual(["bots"])
    expect(keysIn("bots.toml", "bots.<name>")).toEqual(["agent", "wallet", "mode", "state", "maxSlippageBps", "definition", "kind", "folder", "command", "perTradeUsd", "perDayUsd", "maxOpen"])
  })
})
