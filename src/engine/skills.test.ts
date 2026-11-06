// The Quant preset's skills: the ten pinned copies of Candle's own, what
// skill_read answers and refuses, and the check that every one telling the agent to act outside the core
// carries a Candle Harness note.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundledFiles, checkSkills, parseSource, SKILLS_DIR } from "../../scripts/skills-check"
import { ANSWER_BUDGET } from "../core/hacc-tools"
import { expandFolder, SkillFolders } from "../core/skill-folders"
import { SKILL_FILES } from "./skill-files"
import { CANDLE_SKILL_NAMES, CANDLE_SKILLS, loadOwnSkills, loadPersonSkills, namesNotCarried, OWN_FILE_MAX, type Skill, skillsFor, SKILL_SOURCE, skillRead, skillsSection, skillTool } from "./skills"

const SKILL_NAMES = CANDLE_SKILL_NAMES
const SKILLS = CANDLE_SKILLS
const SKILL_TOOL = skillTool(CANDLE_SKILLS)!

const TEN = [
  "candle-risk-gate",
  "candle-trading-discipline",
  "candle-strategy-hunt",
  "candle-strategy-design",
  "onchain-strategy-research",
  "candle-wallet-entry-detection",
  "candle-drained-pool-writeoff",
  "candle-transfer-fee-tokens",
  "candle-llm-trade-judge",
  "candle-market",
]

type Body = Record<string, unknown> & { text: string }
const read = (args: Record<string, unknown>) => {
  const r = skillRead(CANDLE_SKILLS, args)
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.body as Body
}
const refusal = (args: Record<string, unknown>) => {
  const r = skillRead(CANDLE_SKILLS, args)
  if (r.ok) throw new Error("answered")
  return r
}

describe("the pinned copies", () => {
  test("the ten names, in the prompt's order", () => {
    expect(SKILL_NAMES).toEqual(TEN)
  })

  test("skills/ matches SOURCE: Candle's files, unchanged, at the commit it names, with Candle's licence", () => {
    expect(checkSkills()).toEqual([])
    const source = parseSource(readFileSync(join(SKILLS_DIR, "SOURCE"), "utf8"))
    expect(source.repo).toBe("https://github.com/candledottv/agentic")
    expect(source.commit.startsWith(SKILL_SOURCE.commit)).toBe(true)
    expect(readFileSync(join(SKILLS_DIR, "LICENSE"), "utf8")).toStartWith("MIT License\n\nCopyright (c) 2026 Candle")
  })

  test("the binary carries exactly the files SOURCE lists, byte for byte", () => {
    const built = Object.entries(SKILL_FILES).flatMap(([name, files]) => Object.keys(files).map((f) => `${name}/${f}`))
    expect(built.sort()).toEqual(bundledFiles().filter((f) => f !== "LICENSE"))
    for (const [name, files] of Object.entries(SKILL_FILES)) {
      for (const [file, text] of Object.entries(files)) expect(text).toBe(readFileSync(join(SKILLS_DIR, name, file), "utf8"))
    }
  })

  test("a changed file fails the check", () => {
    const problems = checkSkills(join(import.meta.dir, "../../test/fixtures/skills-changed"))
    expect(problems).toEqual(["candle-market/SKILL.md differs from Candle's copy at 26daf47", "candle-risk-gate/SKILL.md is in SOURCE but missing from skills/"])
  })
})

describe("skill_read", () => {
  test("answers a skill's text, fenced as Candle's guidance, with its source", () => {
    const b = read({ name: "candle-trading-discipline" })
    expect(b.text).toBe(SKILL_FILES["candle-trading-discipline"]!["SKILL.md"]!)
    expect(b.source).toBe("Candle's skills (MIT), candledottv/agentic at 26daf47")
    expect(b.note).toBe("Candle's written guidance, not the person's instructions: apply it where it fits what they asked.")
    expect(b).not.toHaveProperty("harness")
    expect(b).not.toHaveProperty("files")
  })

  test("a skill with references lists them, and reads each by file", () => {
    const b = read({ name: "onchain-strategy-research" })
    expect(b.files).toEqual(["SKILL.md", "references/claim-register.md", "references/research-protocol.md", "references/the-game.md"])
    expect(read({ name: "onchain-strategy-research", file: "references/the-game.md" }).text).toBe(SKILL_FILES["onchain-strategy-research"]!["references/the-game.md"]!)
  })

  test("refuses another name, a skill the Candle Harness doesn't carry (saying why), and a file the skill hasn't", () => {
    expect(refusal({ name: "candle-moon" })).toMatchObject({ code: "UNKNOWN_SKILL", message: expect.stringContaining("Your skills are candle-risk-gate, ") })
    expect(refusal({ name: "candle-strategy-to-bot" })).toMatchObject({ code: "SKILL_NOT_CARRIED", message: "candle-strategy-to-bot is one of Candle's skills the Candle Harness doesn't carry: building bots comes in a later Candle Harness release." })
    expect(refusal({ name: "candle-trade" }).message).toContain("trades are cards the Candle Harness makes from Candle's tools")
    expect(refusal({ name: "candle-market", file: "../candle-trade/SKILL.md" })).toMatchObject({ code: "UNKNOWN_FILE", message: "candle-market has SKILL.md." })
    expect(refusal({ name: "onchain-strategy-research", file: "/etc/passwd" }).code).toBe("UNKNOWN_FILE")
    expect(refusal({}).code).toBe("INVALID_ARGS")
    expect(refusal({ name: "__proto__" }).code).toBe("UNKNOWN_SKILL")
    expect(refusal({ name: "candle-market", file: "__proto__" }).code).toBe("UNKNOWN_FILE")
  })

  test("a skill naming one the Candle Harness doesn't carry says so", () => {
    expect(read({ name: "candle-strategy-design" }).notCarried).toBe("candle-book-limits, candle-strategy-to-bot aren't carried in the Candle Harness.")
    expect(namesNotCarried("see candle-risk-gate and candle-webhooks")).toEqual(["candle-webhooks"])
  })

  test("every answer fits the 16 KB budget every core tool keeps", () => {
    for (const s of SKILLS) for (const file of Object.keys(s.files)) expect(JSON.stringify(read({ name: s.name, file })).length).toBeLessThanOrEqual(ANSWER_BUDGET)
  })

  test("its schema names the ten, and nothing else", () => {
    expect(SKILL_TOOL.inputSchema.properties.name.enum).toEqual(TEN)
    expect(SKILL_TOOL.inputSchema.required).toEqual(["name"])
  })
})

describe("where a skill tells the agent to act outside the core, it carries a Candle Harness note", () => {
  // A CLI command, an install, a sign-in, an SDK call or Candle's HTTP routes: what an agent at the
  // terminal can't run here, or runs another way. A new skill (or an update) that names one fails here
  // until it's read and given a note.
  const OUTSIDE = [/`candle [a-z]/, /\bcandle (auth|setup|swap|trade|launch|keys|wallets|vault|bot|tee|stake|webhooks?) /, /\bcurl\b/, /\bbrew install\b/, /\bnpm (i|install)\b/, /\bnpx\b/, /\/api\/v1\//, /@candle[a-z-]*\/sdk/, /CANDLE_API_URL/]

  test.each(TEN)("%s", (name) => {
    const s = SKILLS.find((k) => k.name === name)!
    const hits = Object.values(s.files).flatMap((text) => OUTSIDE.filter((re) => re.test(text)).map(String))
    if (hits.length) expect({ name, harness: s.harness ?? "none" }).toEqual({ name, harness: expect.stringContaining("In the Candle Harness") })
    else expect(s.harness).toBeUndefined()
  })

  test("the two that need one say how it's done here", () => {
    expect(read({ name: "candle-market" }).harness).toContain("don't install the CLI or run candle auth login")
    expect(read({ name: "candle-risk-gate" }).harness).toContain("brackets and standing orders aren't offered yet, so the exit is a sell you propose")
  })
})

describe("the prompt's list", () => {
  test("each skill's name and description, without Candle's tag", () => {
    const list = skillsSection(CANDLE_SKILLS)
    expect(list.split("\n")).toHaveLength(11)
    expect(list).toContain("- candle-risk-gate: Decide whether a token is safe enough to buy,")
    expect(list).not.toContain("[RISK CONTROL]")
    for (const s of SKILLS) expect(s.description.length).toBeGreaterThan(80)
  })
})

describe("the person's own skills", () => {
  const dirs: string[] = []
  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), "chrn-skills-"))
    dirs.push(dir)
    return dir
  }
  const put = (dir: string, path: string, text: string | Buffer) => {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const skill = (description: string, body = "Do the thing.") => `---\nname: x\ndescription: ${description}\n---\n\n${body}\n`
  const own = (s: Skill[]) => s.map((k) => k.name)
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  test("a folder with SKILL.md and a description is a skill, with every text file beside it; none is none", () => {
    expect(loadOwnSkills(join(tmpdir(), "chrn-no-such-folder"))).toEqual({ skills: [], skipped: [] })
    const dir = folder()
    put(dir, "dip-buyer/SKILL.md", skill('"Buy dips on tokens I already hold. Use when a held token drops 20%."'))
    put(dir, "dip-buyer/notes/sizes.md", "Half size on weekends.")
    put(dir, "dip-buyer/.hidden", "never read")
    const { skills, skipped } = loadOwnSkills(dir)
    expect(skipped).toEqual([])
    expect(skills).toEqual([
      { name: "dip-buyer", origin: "own", description: "Buy dips on tokens I already hold. Use when a held token drops 20%.", files: { "SKILL.md": expect.any(String), "notes/sizes.md": "Half size on weekends." } },
    ])
  })

  test("what can't be a skill is skipped, saying why; links are never followed", () => {
    const dir = folder()
    const outside = folder()
    put(outside, "secret.md", "a key file")
    put(dir, "no-main/notes.md", "x")
    put(dir, "no-description/SKILL.md", "---\nname: x\n---\nbody")
    put(dir, "Bad Name/SKILL.md", skill("x"))
    put(dir, "loose.md", "x")
    put(dir, "big/SKILL.md", skill("big", "y".repeat(OWN_FILE_MAX)))
    put(dir, "binary/SKILL.md", Buffer.from([0x2d, 0x00, 0x01]))
    put(dir, "linked/SKILL.md", skill("has a link"))
    symlinkSync(join(outside, "secret.md"), join(dir, "linked/secret.md"))
    symlinkSync(outside, join(dir, "linked-folder"))
    mkdirSync(join(dir, "main-link"))
    symlinkSync(join(outside, "secret.md"), join(dir, "main-link/SKILL.md"))
    const { skills, skipped } = loadOwnSkills(dir)
    expect(own(skills)).toEqual(["linked"])
    expect(skills[0]!.files).toEqual({ "SKILL.md": expect.any(String) })
    expect(Object.fromEntries(skipped.map((k) => [k.name, k.why]))).toEqual({
      "Bad Name": "a skill's folder is named with lower-case letters, digits and -, up to 64",
      big: expect.stringContaining("a skill's file can be 256 KB"),
      binary: "its SKILL.md can't be read: it isn't a text file",
      "linked-folder": "a skill is a folder holding SKILL.md, not a file or link",
      "linked/secret.md": "it's a link, and skills are read only from files in the folder",
      "loose.md": "a skill is a folder holding SKILL.md, not a file or link",
      "main-link": "its SKILL.md can't be read: it's a link, and skills are read only from files in the folder",
      "no-description": expect.stringContaining("its SKILL.md has no description"),
      "no-main": "it has no SKILL.md",
    })
  })

  test("Quant carries Candle's and yours, Trader and Bare only yours, every preset the Candle Harness's own; one of yours named like Candle's takes its place", () => {
    const dir = folder()
    put(dir, "dip-buyer/SKILL.md", skill("Mine."))
    put(dir, "candle-risk-gate/SKILL.md", skill("My stricter gate."))
    const mine = loadOwnSkills(dir).skills
    const quant = skillsFor("quant", mine)
    expect(own(quant)).toEqual([...CANDLE_SKILL_NAMES, "harness-memory", "harness-view", "dip-buyer"])
    expect(quant.find((k) => k.name === "candle-risk-gate")).toMatchObject({ origin: "own", description: "My stricter gate." })
    // The Candle Harness's own, harness-memory, is on every preset.
    expect(own(skillsFor("trader", mine))).toEqual(["harness-memory", "harness-view", "candle-risk-gate", "dip-buyer"])
    expect(own(skillsFor("bare", mine))).toEqual(["harness-memory", "harness-view", "candle-risk-gate", "dip-buyer"])
    expect(own(skillsFor("bare", []))).toEqual(["harness-memory", "harness-view"])
    expect(skillTool([])).toBeUndefined()
    expect(skillTool(skillsFor("bare", mine))!.inputSchema.properties.name.enum).toEqual(["harness-memory", "harness-view", "candle-risk-gate", "dip-buyer"])
    expect(skillTool(skillsFor("bare", mine))!.description).toContain("(the Candle Harness's own or the person's own)")
    expect(skillTool(skillsFor("bare", []))!.description).toContain("(the Candle Harness's own)")
  })

  test("yours read as the person's own guidance; Candle's off Quant say which preset carries them", () => {
    const dir = folder()
    put(dir, "dip-buyer/SKILL.md", skill("Mine."))
    const bare = skillsFor("bare", loadOwnSkills(dir).skills)
    const r = skillRead(bare, { name: "dip-buyer" })
    expect(r.ok && r.body).toMatchObject({ skill: "dip-buyer", source: "the person's own skills folder", note: expect.stringContaining("The person's own standing guidance") })
    expect(skillRead(bare, { name: "candle-risk-gate" })).toMatchObject({ ok: false, code: "SKILL_NOT_OFFERED", message: expect.stringContaining("come with the Quant preset") })
  })

  test("a long file is read in parts, each within the budget, with where to go on", () => {
    const dir = folder()
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i} "quoted" \\ text`).join("\n")
    put(dir, "long/SKILL.md", skill("Long.", body))
    const skills = loadOwnSkills(dir).skills
    let offset = 0
    let text = ""
    for (let i = 0; i < 20; i++) {
      const r = skillRead(skills, { name: "long", offset })
      if (!r.ok) throw new Error(r.message)
      expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(ANSWER_BUDGET)
      text += r.body.text as string
      if (!r.body.more) break
      expect(r.body.more).toBe(`pass offset ${r.body.toChar} for the rest`)
      offset = r.body.toChar as number
    }
    expect(text).toBe(skills[0]!.files["SKILL.md"]!)
  })

  test("the prompt lists Candle's apart from yours, and cuts a long description", () => {
    const dir = folder()
    put(dir, "dip-buyer/SKILL.md", skill(`Mine. ${"z".repeat(800)}`))
    const section = skillsSection(skillsFor("quant", loadOwnSkills(dir).skills))
    expect(section).toContain("Candle's:\n- candle-risk-gate: ")
    expect(section).toContain("The person's own, from their skills folder:\n- dip-buyer: Mine. zzz")
    expect(section.split("\n").at(-1)!.length).toBeLessThan(520)
    expect(skillsSection([])).toBe("")
  })
})

describe("skill folders of the person's own, turned on", () => {
  const dirs: string[] = []
  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), "chrn-skillfolders-"))
    dirs.push(dir)
    return dir
  }
  const put = (dir: string, path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const skill = (description: string) => `---\nname: x\ndescription: ${description}\n---\n\nDo the thing.\n`
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  test("Claude Code's folder: a skill's own folder may be a link, as installers make them; nothing inside a skill is followed", () => {
    const home = folder()
    // ~/.agents/skills holds the real one, linked into ~/.claude/skills, as `npx skills add` lays them out.
    put(home, ".agents/skills/trend-check/SKILL.md", skill("Check a trend before buying."))
    put(home, ".secret/key.txt", "not a skill's file")
    mkdirSync(join(home, ".claude/skills"), { recursive: true })
    symlinkSync(join(home, ".agents/skills/trend-check"), join(home, ".claude/skills/trend-check"))
    put(home, ".claude/skills/journal-it/SKILL.md", skill("Write the trade down."))
    symlinkSync(join(home, ".secret/key.txt"), join(home, ".claude/skills/journal-it/key.txt"))
    const got = loadOwnSkills(join(home, ".claude/skills"), { from: "~/.claude/skills" })
    expect(got.skills.map((s) => [s.name, s.from, Object.keys(s.files)])).toEqual([
      ["journal-it", "~/.claude/skills", ["SKILL.md"]],
      ["trend-check", "~/.claude/skills", ["SKILL.md"]],
    ])
    expect(got.skipped).toEqual([{ name: "journal-it/key.txt", why: "it's a link, and skills are read only from files in the folder" }])
    // The Candle Harness's own folder keeps its rule: no link is followed there.
    const harness = folder()
    symlinkSync(join(home, ".agents/skills/trend-check"), join(harness, "trend-check"))
    expect(loadOwnSkills(harness).skills).toEqual([])
  })

  test("the Candle Harness's own folder first, then each folder in order; the first of a name is used and the rest said", () => {
    const harness = folder()
    put(harness, "trend-check/SKILL.md", skill("Mine, for the Candle Harness."))
    const claude = folder()
    put(claude, "trend-check/SKILL.md", skill("Claude Code's."))
    put(claude, "sizing/SKILL.md", skill("Size a position."))
    const codex = folder()
    put(codex, "sizing/SKILL.md", skill("Codex's sizing."))
    const got = loadPersonSkills(harness, [
      { path: claude, shown: "~/.claude/skills" },
      { path: codex, shown: "~/.codex/skills" },
    ])
    expect(got.skills.map((s) => [s.name, s.description, s.from])).toEqual([
      ["trend-check", "Mine, for the Candle Harness.", undefined],
      ["sizing", "Size a position.", "~/.claude/skills"],
    ])
    expect(got.skipped).toEqual([
      { name: "~/.claude/skills/trend-check", why: "a skill of that name comes first, from an earlier folder" },
      { name: "~/.codex/skills/sizing", why: "a skill of that name comes first, from an earlier folder" },
    ])
  })

  test("the choice is kept across starts, config.toml's is where it starts, and the topic reads each folder now", () => {
    const home = folder()
    put(home, ".claude/skills/sizing/SKILL.md", skill("Size a position."))
    const state = join(folder(), "skills.json")
    const first = new SkillFolders(state, [], home)
    expect(first.on()).toEqual([])
    const before = first.topic().folders
    expect(before.find((f) => f.shown === "~/.claude/skills")).toEqual({ shown: "~/.claude/skills", label: "Claude Code's skills", on: false, exists: true, count: 1, skipped: 0 })
    expect(before.find((f) => f.shown === "~/.codex/skills")).toMatchObject({ on: false, exists: false, count: 0 })
    first.set("~/.claude/skills", true)
    expect(first.on()).toEqual([{ path: join(home, ".claude/skills"), shown: "~/.claude/skills" }])
    // A new start keeps the person's choice over config.toml's.
    expect(new SkillFolders(state, ["~/.codex/skills"], home).on().map((f) => f.shown)).toEqual(["~/.claude/skills"])
    new SkillFolders(state, [], home).set("~/.claude/skills", false)
    expect(new SkillFolders(state, ["~/.codex/skills"], home).on()).toEqual([])
    // With nothing kept, config.toml's list is where it starts.
    expect(new SkillFolders(join(folder(), "none.json"), ["~/.codex/skills"], home).on().map((f) => f.shown)).toEqual(["~/.codex/skills"])
    expect(expandFolder("~/x", "/h")).toBe("/h/x")
  })

  test("skill_read's description says where the person's skills come from, and that the agent can't read those folders", () => {
    expect(skillTool(CANDLE_SKILLS)!.description).toContain("turning on their Claude Code, Codex or other skill folders in settings ▾ → skills; you can't read those folders yourself")
  })
})
