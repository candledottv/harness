// Skill folders of the person's own, through a real core: off until the person turns one on from
// the main view; then its skills are in every agent's prompt and skill_read, read by the core; an agent can't
// turn one on, and the choice is journalled.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import { type Script, scriptedEngine } from "../../test/scripted-engine"

const cores: TestCore[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  cleanupHomes()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test("Claude Code's skills folder, turned on in settings ▾, reaches the agent's prompt; off, it doesn't", async () => {
  const home = mkdtempSync(join(tmpdir(), "chrn-skillhome-"))
  dirs.push(home)
  mkdirSync(join(home, ".claude/skills/trend-check"), { recursive: true })
  writeFileSync(join(home, ".claude/skills/trend-check/SKILL.md"), "---\nname: trend-check\ndescription: Check the trend before any buy.\n---\n\nLook at the 1h change first.\n")
  const prompts: string[] = []
  const script: Script = async (t, push) => {
    prompts.push(t.systemPrompt)
    push({ type: "done", text: "ok" })
  }
  const engine = scriptedEngine("claude-code", [script, script])
  const c = await startTestCore({ env: { ...process.env, HOME: home }, engine: { engines: [engine.engine], processes: () => [], leftoverDelayMs: 10 } }, { config: { engine: testEngine } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["agent", "skills"] })
  const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").length

  // Off until turned on: the folder is offered, with its one skill, and not used.
  const before = (await view.request("skills.read", {})).result as { folders: { shown: string; on: boolean; count: number }[] }
  expect(before.folders.find((f) => f.shown === "~/.claude/skills")).toMatchObject({ on: false, count: 1 })
  await view.request("agent.send", { text: "hi" })
  await until(() => ended() === 1)
  expect(prompts[0]).not.toContain("trend-check")

  // Turned on by the person: the next turn lists it, journalled as theirs.
  const on = await view.request("skills.set", { folder: "~/.claude/skills", on: true })
  expect(on.error).toBeUndefined()
  await view.request("agent.send", { text: "hi again" })
  await until(() => ended() === 2)
  expect(prompts[1]).toContain("trend-check")
  expect(prompts[1]).toContain("Check the trend before any buy.")
  expect(c.core.journal.rows().filter((r) => r.type === "skills.folder")).toMatchObject([{ folder: "~/.claude/skills", on: true }])

  // An agent's harness can't turn one on, and a folder must be one.
  const { client: harness } = await c.harness(view, "momentum")
  expect((await harness.request("skills.set", { folder: "~/.codex/skills", on: true })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  expect((await view.request("skills.set", { folder: "skills", on: true })).error?.data?.code).toBe("INVALID_PARAMS")
})
