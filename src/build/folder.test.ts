// The bots folder: what's written there, and the person's files never written over. Candle's bot-building skills go
// in unchanged, exactly as build-skills/SOURCE lists them, with Candle's licence.
import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILD_SKILLS_DIR, bundledFiles, checkSkills, parseSource } from "../../scripts/skills-check"
import { HARNESS_CLIENT_SOURCE } from "../shared/harness-client-source"
import { agentsMd, CLAUDE_MD, SKILL_NOTES } from "./agents-md"
import { botsFolderFiles, botsFolderPath, tempNames, writeBotsFolder, WRITTEN_FILE } from "./folder"
import { BUILD_SKILL_FILES, BUILD_SKILLS_LICENSE } from "./skill-files"

const made: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "bots-folder-"))
  made.push(d)
  return join(d, "candle-bots")
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

describe("Candle's bot-building skills", () => {
  test("build-skills/ matches SOURCE, and the binary carries exactly its files, byte for byte", () => {
    expect(checkSkills(BUILD_SKILLS_DIR)).toEqual([])
    const source = parseSource(readFileSync(join(BUILD_SKILLS_DIR, "SOURCE"), "utf8"))
    expect(source.repo).toBe("https://github.com/candledottv/agentic")
    const built = [...Object.entries(BUILD_SKILL_FILES).flatMap(([name, files]) => Object.keys(files).map((f) => `${name}/${f}`)), "LICENSE"].sort()
    expect(built).toEqual(bundledFiles(BUILD_SKILLS_DIR))
    for (const [name, files] of Object.entries(BUILD_SKILL_FILES)) for (const [f, text] of Object.entries(files)) expect(text).toBe(readFileSync(join(BUILD_SKILLS_DIR, name, f), "utf8"))
    expect(BUILD_SKILLS_LICENSE).toBe(readFileSync(join(BUILD_SKILLS_DIR, "LICENSE"), "utf8"))
  })

  test("AGENTS.md has a note for each one, saying the Candle Harness's way", () => {
    expect(SKILL_NOTES.map((n) => n.skill).sort()).toEqual(Object.keys(BUILD_SKILL_FILES).sort())
    const md = agentsMd()
    for (const n of SKILL_NOTES) expect(md).toContain(`| \`${n.skill}\` |`)
    // The rules a harness must not break, in the words it reads first.
    expect(md).toContain("A bot never holds a key")
    expect(md).toContain("Only their press makes it")
    expect(md).toContain("candle-harness build test")
  })

  test("AGENTS.md says a test needn't run to its end, and a live bot's wallet of its own and slippage are the person's to pick", () => {
    const md = agentsMd()
    expect(md).toContain("A test needn't run to its end")
    expect(md).toContain("a wallet of its own is the better way")
    expect(md).toContain("only when the person names a bound")
  })
})

describe("writing the bots folder", () => {
  test("a fresh folder gets every file; CLAUDE.md imports AGENTS.md; the skills go in both places harnesses read them", async () => {
    const folder = fresh()
    const w = await writeBotsFolder(folder)
    const all = botsFolderFiles().map((f) => f.path)
    expect(w.written).toEqual(all)
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD)
    expect(CLAUDE_MD).toBe("@AGENTS.md\n")
    expect(readFileSync(join(folder, "harness-client.ts"), "utf8")).toBe(HARNESS_CLIENT_SOURCE)
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toContain(".harness-bot.json")
    for (const name of Object.keys(BUILD_SKILL_FILES)) {
      expect(existsSync(join(folder, ".claude/skills", name, "SKILL.md"))).toBe(true)
      expect(existsSync(join(folder, ".agents/skills", name, "SKILL.md"))).toBe(true)
    }
    expect(existsSync(join(folder, WRITTEN_FILE))).toBe(true)
    // Again: nothing to write.
    expect((await writeBotsFolder(folder)).same).toEqual(all)
  })

  test("a file the person changed, or had there before, is kept; one still as written is brought up to date", async () => {
    const folder = fresh()
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "AGENTS.md"), "my own rules\n")
    const first = await writeBotsFolder(folder)
    expect(first.kept).toEqual(["AGENTS.md"])
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe("my own rules\n")

    writeFileSync(join(folder, "CLAUDE.md"), "@AGENTS.md\nAnd mine.\n")
    const files = botsFolderFiles().map((f) => (f.path === "CLAUDE.md" || f.path === ".gitignore" ? { ...f, text: `${f.text}# newer\n` } : f))
    const second = await writeBotsFolder(folder, files)
    expect(second.kept).toEqual(["AGENTS.md", "CLAUDE.md"])
    expect(second.updated).toEqual([".gitignore"])
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\nAnd mine.\n")
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toEndWith("# newer\n")
  })

  test("never writes through a link, and refuses a folder that's a file", async () => {
    const folder = fresh()
    mkdirSync(folder, { recursive: true })
    const outside = join(folder, "..", "outside.txt")
    writeFileSync(outside, "theirs\n")
    symlinkSync(outside, join(folder, ".gitignore"))
    const w = await writeBotsFolder(folder)
    expect(w.kept).toContain(".gitignore")
    expect(readFileSync(outside, "utf8")).toBe("theirs\n")

    const file = join(folder, "..", "a-file")
    writeFileSync(file, "x")
    await expect(writeBotsFolder(file)).rejects.toThrow("isn't a folder")
  })

  test("its record is never written through a link: not at .harness/written.json, nor at .harness", async () => {
    const folder = fresh()
    mkdirSync(join(folder, ".harness"), { recursive: true })
    const outside = join(folder, "..", "outside-record.txt")
    writeFileSync(outside, "theirs\n")
    symlinkSync(outside, join(folder, WRITTEN_FILE))
    await writeBotsFolder(folder)
    expect(readFileSync(outside, "utf8")).toBe("theirs\n")

    const other = fresh()
    mkdirSync(other, { recursive: true })
    const away = join(other, "..", "outside-harness")
    mkdirSync(away, { recursive: true })
    symlinkSync(away, join(other, ".harness"))
    await writeBotsFolder(other)
    expect(existsSync(join(away, "written.json"))).toBe(false)
  })

  test("a temporary file is made fresh: a link left under its name is never written through, for a file or the record", async () => {
    // The temporary names are fixed here, and a link to a file outside is left under the one each write will use.
    const outsideOf = (folder: string) => {
      const outside = join(folder, "..", "outside-temp.txt")
      writeFileSync(outside, "theirs\n")
      return outside
    }
    const plant = (target: string, at: string) => symlinkSync(target, `${at}.harness-${process.pid}-0badc0de`)
    let named = 0
    const spy = spyOn(tempNames, "part").mockImplementation(() => {
      named++
      return "0badc0de"
    })
    try {
      // The record alone: no files to write, so its temporary file is the only one.
      const record = fresh()
      mkdirSync(join(record, ".harness"), { recursive: true })
      const outside = outsideOf(record)
      plant(outside, join(record, WRITTEN_FILE))
      await writeBotsFolder(record, []).catch(() => {})
      expect(readFileSync(outside, "utf8")).toBe("theirs\n")

      // One file: its own temporary file.
      const folder = fresh()
      mkdirSync(folder, { recursive: true })
      const away = outsideOf(folder)
      plant(away, join(folder, "AGENTS.md"))
      await writeBotsFolder(folder, [{ path: "AGENTS.md", text: "ours\n", why: "the rules" }]).catch(() => {})
      expect(readFileSync(away, "utf8")).toBe("theirs\n")
    } finally {
      spy.mockRestore()
    }
    expect(named).toBe(2)
  })

  test("~ is the person's home", () => {
    expect(botsFolderPath("~/candle-bots", "/opt/person")).toBe("/opt/person/candle-bots")
    expect(botsFolderPath("~", "/opt/person")).toBe("/opt/person")
    expect(botsFolderPath("/srv/bots", "/opt/person")).toBe("/srv/bots")
  })
})
