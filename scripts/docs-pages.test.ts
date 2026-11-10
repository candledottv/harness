// The generated pages are what the code says, and the check catches a page that has drifted from it.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SETTINGS } from "../src/config-settings"
import { CLI_ROWS, SOURCE } from "../src/core/cli-table"
import { TYPED_ROWS } from "../src/shared/commands"
import { HELP_LINES, KEYMAP } from "../src/view/keymap"
import { parseTheme } from "../src/view/themes"
import { docPaths, parityProblems } from "./cli-parity"
import { BUILD_WORDS, loadMap } from "./docs-map"
import { GENERATED, pageProblems, renderPages, stampOf, THEME_EXAMPLE, typedProblems, writePages } from "./docs-pages"

const dirs: string[] = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-pages-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const pages = renderPages("1.2.3")
const page = (path: string) => pages[`${path}.md` as keyof typeof pages]

describe("the generated pages", () => {
  test("written into a folder, they pass the check, each stamped with its version and titled as the map has it", () => {
    const dir = fresh()
    expect(writePages(dir, "1.2.3")).toEqual(GENERATED.map((p) => `${p}.md`))
    expect(pageProblems(dir)).toEqual([])
    const titles = loadMap().pages
    for (const path of GENERATED) {
      const text = readFileSync(join(dir, `${path}.md`), "utf8")
      expect(stampOf(text)).toBe("1.2.3")
      expect(text).toStartWith(`---\ntitle: ${JSON.stringify(titles[path])}\ndescription: `)
    }
  })

  test("a page edited by hand, one missing, and one with no stamp each fail the check", () => {
    const dir = fresh()
    writePages(dir, "1.2.3")
    const keys = join(dir, "reference/keys.md")
    writeFileSync(keys, readFileSync(keys, "utf8").replace("Reject the highlighted card.", "Reject it."))
    unlinkSync(join(dir, "reference/config.md"))
    const typed = join(dir, "reference/typed-commands.md")
    writeFileSync(typed, readFileSync(typed, "utf8").replace(/^<!-- candle-harness .*$/m, ""))
    expect(pageProblems(dir)).toEqual([
      "reference/keys.md isn't what the code writes for candle-harness 1.2.3: run bun scripts/docs-pages.ts --write",
      "reference/typed-commands.md has no candle-harness stamp, so it wasn't written by this script",
      "reference/config.md is missing",
    ])
  })

  test("a page written for an older version still passes while the code hasn't changed it: the docs site checks the version", () => {
    const dir = fresh()
    writePages(dir, "1.2.2")
    expect(pageProblems(dir)).toEqual([])
  })

  test("the keys page has every key, with where and what it does", () => {
    for (const k of KEYMAP) expect(page("reference/keys")).toContain(`| \`${k.chord.replace(/\|/g, "\\|")}\` | ${k.where ?? "anywhere"} |`)
    expect(page("reference/keys")).toContain("| `ctrl-x twice` | anywhere | Kill switch: pause buys, stop the agent; sells still work. | \"kill switch\" |")
  })

  test("the typed-commands page has every row of ?, with its example", () => {
    for (const r of TYPED_ROWS) expect(page("reference/typed-commands")).toContain(`| \`${r.form}\` | \`${r.example}\` | ${r.words} |`)
    expect(HELP_LINES.length).toBe(TYPED_ROWS.length)
  })

  test("the configuration page has every setting but a theme's colours under its own heading, with its type, its default and an example", () => {
    for (const s of SETTINGS.filter((x) => x.file !== "theme" || x.key === "base")) expect(page("reference/config")).toContain(`### \`${s.key}\`\n\n**Takes:** `)
    expect(page("reference/config")).toContain("### `mode`\n\n**Takes:** `\"paper\"` or `\"live\"` · **Default:** `\"paper\"`")
    expect(page("reference/config")).toContain("**Default:** the engine's own default")
  })

  test("a theme's colours are one table, with an example theme the theme reader takes", () => {
    for (const s of SETTINGS.filter((x) => x.file === "theme" && x.key !== "base")) expect(page("reference/config")).toContain(`| ${s.words} |`)
    expect(page("reference/config")).toContain("| `code` under `[reply]` | Code in a reply. |")
    expect(parseTheme(THEME_EXAMPLE, "mine.toml").problems).toEqual([])
  })

  test("Candle's commands page lists every command the CLI routes, as the parity check wants", () => {
    expect(parityProblems(SOURCE, CLI_ROWS, page("reference/cli-parity"))).toEqual([])
    expect(docPaths(page("reference/cli-parity")).length).toBe(CLI_ROWS.length)
  })

  test("no page says anything about how the Candle Harness was built", () => {
    for (const path of GENERATED) expect(`${path}: ${BUILD_WORDS.exec(page(path))?.[0] ?? "none"}`).toBe(`${path}: none`)
  })
})

describe("the typed rows", () => {
  test("each example is its row's kind of command, and every kind the input line takes has a row", () => {
    expect(typedProblems(TYPED_ROWS)).toEqual([])
  })

  test("a kind with no row, and an example the input line refuses, are both caught", () => {
    const less = TYPED_ROWS.filter((r) => r.form !== "forget vault")
    expect(typedProblems(less)).toEqual(["the input line takes forgetVault commands, and no typed row covers them"])
    const wrong = TYPED_ROWS.map((r) => (r.form === "sell 50% MOON" ? { ...r, example: "sell 100% ORE" } : r))
    expect(typedProblems(wrong)[0]).toStartWith('sell 50% MOON: its example "sell 100% ORE" is a refused command (Not a trade yet: ORE isn\'t a token')
  })
})
