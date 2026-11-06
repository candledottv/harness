import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readSavedMode, saveAgent, saveMode, startingAgent, startingMode } from "./mode-state"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
const file = () => {
  const dir = mkdtempSync("/tmp/chrn-mode-")
  dirs.push(dir)
  return join(dir, "mode.json")
}

test("nothing picked yet: the config's mode", () => {
  expect(startingMode(file(), "paper")).toEqual({ mode: "paper", from: "config" })
  expect(startingMode(file(), "live")).toEqual({ mode: "live", from: "config" })
})

test("the mode last picked wins over the config's, either way", async () => {
  const path = file()
  await saveMode(path, "paper", Date.now())
  expect(startingMode(path, "live")).toEqual({ mode: "paper", from: "saved" })
  await saveMode(path, "live", Date.now())
  expect(startingMode(path, "paper")).toEqual({ mode: "live", from: "saved" })
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("a file that's garbled or names no mode falls back to the config's", () => {
  for (const text of ["", "{", "null", '{"mode":"yolo"}', '{"mode":1}', "[]"]) {
    const path = file()
    writeFileSync(path, text)
    expect(readSavedMode(path)).toBeUndefined()
    expect(startingMode(path, "paper")).toEqual({ mode: "paper", from: "config" })
  }
})

test("the agent last made active survives a restart; one no longer configured, or none, is config.toml's", async () => {
  const path = file()
  expect(startingAgent(path, "agent-a", ["agent-a", "agent-b"])).toBe("agent-a")
  await saveAgent(path, "agent-b", Date.now())
  expect(startingAgent(path, "agent-a", ["agent-a", "agent-b"])).toBe("agent-b")
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(startingAgent(path, "agent-a", ["agent-a"])).toBe("agent-a")
  writeFileSync(path, "{not json")
  expect(startingAgent(path, "agent-a", ["agent-a", "agent-b"])).toBe("agent-a")
})
