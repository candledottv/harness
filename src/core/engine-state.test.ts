// Each agent's engine and model: the choice last made survives a restart; config gives
// where a fresh install starts.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineState } from "./engine-state"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const file = () => {
  const d = mkdtempSync(join(tmpdir(), "chrn-engine-state-"))
  dirs.push(d)
  return join(d, "engine.json")
}
const NOW = Date.parse("2026-10-28T12:00:00Z")

test("nothing chosen yet: every agent starts on the config's default", () => {
  const s = EngineState.open(file(), { engine: "claude-code" })
  expect(s.get("momentum")).toEqual({ engine: "claude-code", from: "config" })
  const withModel = EngineState.open(file(), { engine: "pi", model: "openrouter/anthropic/claude-haiku-5.5" })
  expect(withModel.get("swing")).toEqual({ engine: "pi", model: "openrouter/anthropic/claude-haiku-5.5", from: "config" })
})

test("a choice is per agent, written 0600, and read back by the next core", async () => {
  const path = file()
  const s = EngineState.open(path, { engine: "claude-code" })
  await s.set("momentum", { engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash" }, NOW)
  expect(s.get("momentum")).toEqual({ engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", from: "saved" })
  expect(s.get("swing")).toEqual({ engine: "claude-code", from: "config" }) // switching one never touches another
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ agents: { momentum: { engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash" } }, at: "2026-10-28T12:00:00.000Z" })
  const next = EngineState.open(path, { engine: "claude-code" })
  expect(next.get("momentum")).toMatchObject({ engine: "pi", from: "saved" })
})

test("choosing the harness's default model keeps no model", async () => {
  const s = EngineState.open(file(), { engine: "claude-code" })
  await s.set("momentum", { engine: "claude-code" }, NOW)
  expect(s.get("momentum")).toEqual({ engine: "claude-code", from: "saved" })
})

test("an unreadable file, or an entry naming no engine we know, falls back to the config", () => {
  const bad = file()
  writeFileSync(bad, "{not json")
  expect(EngineState.open(bad, { engine: "claude-code" }).get("momentum")).toMatchObject({ engine: "claude-code", from: "config" })
  const odd = file()
  writeFileSync(odd, JSON.stringify({ agents: { momentum: { engine: "crush" }, swing: { engine: "codex", model: 7 } } }))
  const s = EngineState.open(odd, { engine: "claude-code" })
  expect(s.get("momentum")).toMatchObject({ engine: "claude-code", from: "config" })
  expect(s.get("swing")).toEqual({ engine: "codex", from: "saved" }) // the engine holds; a model that isn't text is dropped
})
