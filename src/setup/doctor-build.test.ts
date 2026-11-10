// The doctor on the Build tab: the bots folder against the files the Candle Harness writes there (what's missing, what
// an older version wrote, what's the person's own), and each harness the Build tab can open, with the one it opens.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookAtBotsFolder, writeBotsFolder } from "../build/folder"
import { buildFolderWords, buildHarnessWords, type Check } from "./doctor"

const texts = (checks: Check[]) => checks.map((c) => `${c.state} ${c.area}: ${c.text}`)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "doctor-build-"))
  dirs.push(d)
  return d
}
const prefs = (p: Partial<{ folder: string; opened: boolean }>) => ({ folder: "~/candle-bots", opened: true, from: { folder: "default" as const }, ...p })

test("the bots folder: not opened yet, gone, up to date, missing and older files, and the person's own kept", async () => {
  const none = join(tmp(), "nothing")
  expect(texts(buildFolderWords({ prefs: prefs({ opened: false }), look: await lookAtBotsFolder(none), shown: "~/candle-bots" }))).toEqual([
    "ok build: the Build tab hasn't been opened here yet: its first open asks where your bots live (~/candle-bots unless you pick another)",
  ])
  const gone = buildFolderWords({ prefs: prefs({ folder: "~/code/bots" }), look: await lookAtBotsFolder(none), shown: "~/code/bots" })
  expect(texts(gone)).toEqual(["warn build: the bots folder ~/code/bots isn't there"])
  expect(gone[0]!.fix).toBe("Run `candle-harness bots init ~/code/bots` to write it again, or pick another folder in the Build tab.")

  const folder = tmp()
  await writeBotsFolder(folder)
  expect(texts(buildFolderWords({ prefs: prefs({}), look: await lookAtBotsFolder(folder), shown: "~/candle-bots" }))).toEqual([
    "ok build: the bots folder is ~/candle-bots: AGENTS.md, the client and Candle's skills are up to date",
  ])

  writeFileSync(join(folder, "AGENTS.md"), "my own rules\n")
  rmSync(join(folder, ".gitignore"))
  const older = await lookAtBotsFolder(folder, [
    { path: "AGENTS.md", text: "new", why: "" },
    { path: ".gitignore", text: "x", why: "" },
    { path: "CLAUDE.md", text: "@AGENTS.md, newer\n", why: "" },
  ])
  expect(older.kept).toEqual(["AGENTS.md"])
  expect(older.missing).toEqual([".gitignore"])
  expect(older.older).toEqual(["CLAUDE.md"])
  const checks = buildFolderWords({ prefs: prefs({}), look: older, shown: "~/candle-bots" })
  expect(texts(checks)).toEqual([
    "warn build: the bots folder ~/candle-bots is missing 1 of the Candle Harness's files, and 1 is from an older Candle Harness",
    "ok build: in the bots folder, AGENTS.md is yours (changed by you, or there before): kept as it is, never written over",
  ])
  expect(checks[0]!.fix).toBe("Run `candle-harness bots init`: it adds what's missing, updates what you haven't changed, and keeps what you have.")
})

test("the person's own files, many: the first four named, then how many more", () => {
  const look = { folder: "/b", exists: true, missing: [], older: [], same: [], kept: ["a", "b", "c", "d", "e", "f"] }
  expect(texts(buildFolderWords({ prefs: prefs({}), look, shown: "~/candle-bots" })).at(-1)).toBe(
    "ok build: in the bots folder, a, b, c, d and 2 more are yours (changed by you, or there before): kept as they are, never written over",
  )
})

const engines = {
  "claude-code": { ok: true, version: "2.1.319" },
  codex: { ok: false, version: "0.100.0", message: "Codex 0.100.0 is older than 0.160.0" },
  grok: { ok: false, message: "Grok isn't installed" },
  opencode: { ok: false, message: "OpenCode isn't installed" },
  pi: { ok: true, version: "1.4.0" },
}

test("the harnesses the Build tab can open, and the one it opens", () => {
  expect(texts(buildHarnessWords({ engines }))).toEqual([
    "ok build: the Build tab can open Claude Code 2.1.319, Codex 0.100.0, Pi 1.4.0; not installed here: Grok, OpenCode",
    "ok build: no harness is picked for the Build tab yet: its first open asks",
  ])
  expect(texts(buildHarnessWords({ engines, harness: "codex", from: "saved" })).at(-1)).toBe("ok build: the Build tab opens Codex (picked in the Build tab)")
  const missing = buildHarnessWords({ engines, harness: "grok", from: "config" })
  expect(texts(missing).at(-1)).toBe("warn build: the Build tab opens Grok (config.toml's [build] harness), which isn't installed here")
  expect(missing.at(-1)!.fix).toBe("Install Grok, or pick another harness with the Build pane's harness ▾.")
  expect(texts(buildHarnessWords({ engines, harness: "aider --no-git", from: "saved", command: { word: "aider", found: true } })).at(-1)).toBe(
    "ok build: the Build tab opens your own command, aider --no-git (picked in the Build tab)",
  )
  const lost = buildHarnessWords({ engines, harness: "aider", from: "saved", command: { word: "aider", found: false } })
  expect(texts(lost).at(-1)).toBe("warn build: the Build tab opens your own command, aider (picked in the Build tab), and aider isn't found on your PATH")
  expect(lost.at(-1)!.fix).toContain("full path")
  const nothing = Object.fromEntries(Object.keys(engines).map((k) => [k, { ok: false, message: "x" }])) as unknown as typeof engines
  expect(texts(buildHarnessWords({ engines: nothing }))[0]).toBe("ok build: none of the five harnesses is installed here; the Build tab can still run a command of your own")
})
