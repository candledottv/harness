// The parity check: the table (src/core/cli-table.ts) and the public page (the docs site's reference/cli-parity) each have
// one row for every command the CLI routes, and name nothing it doesn't. When the pinned CLI moves,
// scripts/read-cli-source.ts refreshes src/core/cli-source.json and this test says what to add or drop.
import { describe, expect, test } from "bun:test"
import { CLI_ROWS, SOURCE } from "../src/core/cli-table"
import { docPaths, parityBody, parityProblems } from "./cli-parity"
import { BUILD_WORDS } from "./docs-map"

const doc = parityBody()

describe("the parity check", () => {
  test("the table and the page match the CLI's command table", () => {
    expect(parityProblems(SOURCE, CLI_ROWS, doc)).toEqual([])
  })

  test("the page is written from the table, so its rules and availability can't drift either", () => {
    expect(docPaths(doc).length).toBe(CLI_ROWS.length)
  })

  test("a subcommand the CLI adds is missing from both", () => {
    const added = { ...SOURCE, commands: [...SOURCE.commands, { ...SOURCE.commands[0]!, command: "keys", subcommand: "audit" }] }
    expect(parityProblems(added, CLI_ROWS, doc)).toEqual(["keys audit: no row in the table", "keys audit: not in the docs page"])
  })

  test("a subcommand the CLI removes leaves a row in both that names nothing", () => {
    const removed = { ...SOURCE, commands: SOURCE.commands.filter((c) => !(c.command === "lp" && c.subcommand === "claim")) }
    expect(parityProblems(removed, CLI_ROWS, doc)).toEqual(["lp claim: the table names a command the CLI doesn't have", "lp claim: the docs page names a command the CLI doesn't have"])
  })

  test("a second word the CLI's help no longer documents is a removed command too", () => {
    const help = { ...SOURCE.help, keys: { ...SOURCE.help.keys!, rows: SOURCE.help.keys!.rows.filter((r) => !r.invocation.trim().startsWith("move ")) } }
    expect(parityProblems({ ...SOURCE, help }, CLI_ROWS, doc)).toEqual([
      "keys signer move: the table names a command the CLI doesn't have",
      "keys signer move: the docs page names a command the CLI doesn't have",
    ])
  })

  test("a row listed twice is a problem", () => {
    expect(parityProblems(SOURCE, [...CLI_ROWS, CLI_ROWS[0]!], doc)).toEqual([`${CLI_ROWS[0]!.path}: more than one row in the table`])
  })
})

describe("the public page", () => {
  test("says available now and coming, every coming row with why, and nothing internal", () => {
    expect(doc).toContain("| now |")
    expect(doc).toContain("| coming: ")
    expect(doc).not.toContain("| coming |")
    // A row that runs in the prompt pane says how.
    expect(doc).toContain("| `candle keys create` | Create an API key | owner step | now (the factor first) |")
    expect(BUILD_WORDS.exec(doc)?.[0]).toBeUndefined()
    for (const word of ["Fable", "Task ", "v0.1.0", "Correction"]) expect(`${word}: ${doc.includes(word)}`).toBe(`${word}: false`)
  })
})
