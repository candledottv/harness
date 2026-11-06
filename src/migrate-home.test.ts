// Candle TUI 0.2's home folder copied into Candle Harness's on the first start, the old one never touched.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COPY_RECORD, migrateHome, newHome, oldHome, retireOldHome } from "./migrate-home"
import { paths } from "./paths"

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** A HOME with 0.2's folder in it, as a 0.2 core left it. */
function oldMachine(): { env: { HOME: string }; from: string; to: string } {
  const home = mkdtempSync(join(tmpdir(), "chm-"))
  homes.push(home)
  const env = { HOME: home }
  const from = oldHome(env)
  mkdirSync(join(from, "state", "keys"), { recursive: true, mode: 0o700 })
  chmodSync(join(from, "state"), 0o700)
  chmodSync(join(from, "state", "keys"), 0o700)
  writeFileSync(join(from, "config.toml"), `[agents.momentum]\n`, { mode: 0o600 })
  writeFileSync(join(from, "state", "keys", "momentum.key"), "cndl_live_fake\n", { mode: 0o600 })
  writeFileSync(join(from, "state", "journal.jsonl"), `{"type":"core.started"}\n`, { mode: 0o600 })
  writeFileSync(join(from, "state", "core.lock"), `${JSON.stringify({ pid: 999_999_999 })}\n`, { mode: 0o600 })
  mkdirSync(join(from, "research", "momentum"), { recursive: true })
  writeFileSync(join(from, "research", "momentum", "notes.md"), "mine\n")
  symlinkSync("notes.md", join(from, "research", "momentum", "latest.md"))
  return { env, from, to: newHome(env) }
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
    .sort()

test("the first start copies 0.2's folder in, modes kept, and leaves the old one exactly as it was", async () => {
  const { env, from, to } = oldMachine()
  // A 0.2 core that died left its socket behind: a socket is a process's, never copied.
  const server = createServer()
  const sock = join(from, "state", "core.sock")
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  server.close()
  const before = tree(from)
  const beforeKey = readFileSync(join(from, "state", "keys", "momentum.key"), "utf8")

  expect(await migrateHome(env, { isAlive: () => false })).toEqual({ kind: "copied", from, to })
  expect(to).toBe(join(env.HOME, ".config", "candle", "harness"))
  expect(readFileSync(join(to, "config.toml"), "utf8")).toBe(`[agents.momentum]\n`)
  expect(readFileSync(join(to, "state", "keys", "momentum.key"), "utf8")).toBe(beforeKey)
  expect(readFileSync(join(to, "state", "journal.jsonl"), "utf8")).toContain("core.started")
  expect(statSync(join(to, "state", "keys", "momentum.key")).mode & 0o777).toBe(0o600)
  expect(statSync(join(to, "state")).mode & 0o777).toBe(0o700)
  expect(statSync(join(to, "state", "keys")).mode & 0o777).toBe(0o700)
  expect(readFileSync(join(to, "research", "momentum", "latest.md"), "utf8")).toBe("mine\n")
  // The old core's lock and socket stay with the old folder.
  expect(existsSync(join(to, "state", "core.lock"))).toBe(false)
  expect(existsSync(join(to, "state", "core.sock"))).toBe(false)
  // Nothing in the old folder moved, went or changed; the copy's record holds what it held.
  expect(tree(from)).toEqual(before)
  expect(Object.keys(JSON.parse(readFileSync(join(to, COPY_RECORD), "utf8")).held)).toContain("state/keys/momentum.key")
  expect(statSync(join(to, COPY_RECORD)).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(from, "state", "keys", "momentum.key"), "utf8")).toBe(beforeKey)
  // No copy left half-made beside it.
  expect(readdirSync(join(env.HOME, ".config", "candle")).sort()).toEqual(["harness", "tui"])
  // The new folder is where paths() looks.
  expect(paths(env).configDir).toBe(to)

  // A second start finds the new folder and copies nothing again, even after the old one changed.
  writeFileSync(join(from, "config.toml"), `[agents.other]\n`)
  expect(await migrateHome(env, { isAlive: () => false })).toEqual({ kind: "none" })
  expect(readFileSync(join(to, "config.toml"), "utf8")).toBe(`[agents.momentum]\n`)
})

test("a 0.2 core still running on the old folder: nothing copied until it's quit", async () => {
  const { env, from, to } = oldMachine()
  const moved = await migrateHome(env, { isAlive: (pid) => pid === 999_999_999 })
  expect(moved.kind).toBe("refused")
  expect(moved.kind === "refused" && moved.message).toContain("still running (pid 999999999)")
  expect(existsSync(to)).toBe(false)
  expect(readdirSync(join(env.HOME, ".config", "candle"))).toEqual(["tui"])
  // Quit: the next start copies it.
  expect((await migrateHome(env, { isAlive: () => false })).kind).toBe("copied")
})

test("nothing to copy: no old folder, a named home, or the new folder already there", async () => {
  const bare = mkdtempSync(join(tmpdir(), "chm-"))
  homes.push(bare)
  expect(await migrateHome({ HOME: bare })).toEqual({ kind: "none" })
  expect(existsSync(newHome({ HOME: bare }))).toBe(false)

  const named = oldMachine()
  expect(await migrateHome({ ...named.env, CANDLE_HARNESS_HOME: join(named.env.HOME, "elsewhere") })).toEqual({ kind: "none" })
  expect(await migrateHome({ ...named.env, CANDLE_TUI_HOME: named.from })).toEqual({ kind: "none" })
  expect(existsSync(named.to)).toBe(false)

  const both = oldMachine()
  mkdirSync(both.to, { recursive: true })
  expect(await migrateHome(both.env, { isAlive: () => false })).toEqual({ kind: "none" })
  expect(readdirSync(both.to)).toEqual([])
})

test("0.2's CANDLE_TUI_HOME is still read when CANDLE_HARNESS_HOME isn't set; the new name wins", () => {
  const home = mkdtempSync(join(tmpdir(), "chm-"))
  homes.push(home)
  expect(paths({ HOME: home, CANDLE_TUI_HOME: join(home, "old") }).configDir).toBe(join(home, "old"))
  expect(paths({ HOME: home, CANDLE_TUI_HOME: join(home, "old"), CANDLE_HARNESS_HOME: join(home, "new") }).configDir).toBe(join(home, "new"))
  expect(() => paths({ HOME: home, CANDLE_TUI_HOME: "relative" })).toThrow("CANDLE_TUI_HOME must be an absolute path")
})

const NOW = () => new Date("2026-11-06T23:30:00Z")

test("after a start that went well, the checked old folder is renamed aside, never deleted, and only once", async () => {
  const { env, from, to } = oldMachine()
  expect((await migrateHome(env, { isAlive: () => false })).kind).toBe("copied")
  // The new folder is in use: its journal grows, which doesn't make the old one different from what was copied.
  writeFileSync(join(to, "state", "journal.jsonl"), `{"type":"core.started"}\n{"type":"core.started"}\n`)
  const aside = `${from}.migrated-2026-11-06`
  expect(await retireOldHome(env, { now: NOW, isAlive: () => false })).toEqual({ kind: "renamed", from, to: aside })
  expect(existsSync(from)).toBe(false)
  expect(readFileSync(join(aside, "state", "keys", "momentum.key"), "utf8")).toBe("cndl_live_fake\n")
  expect(JSON.parse(readFileSync(join(to, COPY_RECORD), "utf8")).retired).toBe(aside)
  expect(await retireOldHome(env, { now: NOW, isAlive: () => false })).toEqual({ kind: "none" })
  // 0.2 makes a fresh folder at the old path later: never renamed, it wasn't the one copied.
  mkdirSync(join(from, "state"), { recursive: true })
  expect(await retireOldHome(env, { now: NOW, isAlive: () => false })).toEqual({ kind: "none" })
  expect(existsSync(from)).toBe(true)
})

test("an old folder that changed after the copy, or has a 0.2 core on it, is left exactly as it is", async () => {
  const { env, from } = oldMachine()
  expect((await migrateHome(env, { isAlive: () => false })).kind).toBe("copied")
  // A 0.2 core running on it: kept, and asked again next time.
  const running = await retireOldHome(env, { now: NOW, isAlive: (pid) => pid === 999_999_999 })
  expect(running).toMatchObject({ kind: "kept", from })
  expect(running.kind === "kept" && running.why).toContain("running on it")
  // 0.2 ran again and wrote to it: what it holds now isn't all in the copy.
  writeFileSync(join(from, "state", "journal.jsonl"), `{"type":"core.started"}\n{"type":"trade"}\n`)
  const before = tree(from)
  const changed = await retireOldHome(env, { now: NOW, isAlive: () => false })
  expect(changed).toMatchObject({ kind: "kept", from })
  expect(changed.kind === "kept" && changed.why).toContain("changed after it was copied")
  expect(tree(from)).toEqual(before)
  expect(existsSync(`${from}.migrated-2026-11-06`)).toBe(false)
  // Said once: the next start leaves it without a word.
  expect(await retireOldHome(env, { now: NOW, isAlive: () => false })).toEqual({ kind: "none" })
})

test("a copy that fails its check: no new folder, nothing renamed, the old folder as it was", async () => {
  const { env, from, to } = oldMachine()
  const before = tree(from)
  await expect(migrateHome(env, { isAlive: () => false, afterCopy: async (staging) => writeFileSync(join(staging, "config.toml"), "changed\n") })).rejects.toThrow("the copy doesn't match the old folder")
  expect(existsSync(to)).toBe(false)
  expect(readdirSync(join(env.HOME, ".config", "candle"))).toEqual(["tui"])
  expect(tree(from)).toEqual(before)
  // With no checked copy on record, nothing is ever renamed.
  expect(await retireOldHome(env, { now: NOW, isAlive: () => false })).toEqual({ kind: "none" })
  expect(existsSync(from)).toBe(true)
})

test("an old folder with only config.toml: copied, its state folder made private for the record; a state that's a link is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "chm-"))
  homes.push(home)
  const env = { HOME: home }
  const from = oldHome(env)
  const to = newHome(env)
  mkdirSync(from, { recursive: true })
  writeFileSync(join(from, "config.toml"), `[agents.momentum]\n`, { mode: 0o600 })
  expect(await migrateHome(env, { isAlive: () => false })).toEqual({ kind: "copied", from, to })
  expect(statSync(join(to, "state")).mode & 0o777).toBe(0o700)
  expect(existsSync(join(to, COPY_RECORD))).toBe(true)
  expect(readdirSync(from)).toEqual(["config.toml"])
  expect((await retireOldHome(env, { now: NOW, isAlive: () => false })).kind).toBe("renamed")

  // state/ as a link out of the folder: nothing written through it, nothing copied, the old folder as it was.
  const home2 = mkdtempSync(join(tmpdir(), "chm-"))
  homes.push(home2)
  const env2 = { HOME: home2 }
  const from2 = oldHome(env2)
  const elsewhere = join(home2, "elsewhere")
  mkdirSync(elsewhere)
  mkdirSync(from2, { recursive: true })
  writeFileSync(join(from2, "config.toml"), `[agents.momentum]\n`)
  symlinkSync(elsewhere, join(from2, "state"))
  await expect(migrateHome(env2, { isAlive: () => false })).rejects.toThrow("isn't a folder")
  expect(existsSync(newHome(env2))).toBe(false)
  expect(readdirSync(elsewhere)).toEqual([])
  expect(readdirSync(join(home2, ".config", "candle"))).toEqual(["tui"])
})

test("a copy a dead start left half-made is removed at the next start; one whose start still runs is left to it", async () => {
  const { env, to } = oldMachine()
  const parent = join(env.HOME, ".config", "candle")
  const dead = join(parent, "harness.copying-999999998")
  const running = join(parent, "harness.copying-999999997")
  for (const d of [dead, running]) {
    mkdirSync(join(d, "state", "keys"), { recursive: true, mode: 0o700 })
    writeFileSync(join(d, "state", "keys", "momentum.key"), "cndl_live_fake\n", { mode: 0o600 })
  }
  // A file of that shape isn't a copy: left.
  writeFileSync(join(parent, "harness.copying-999999996"), "not a folder\n")
  expect((await migrateHome(env, { isAlive: (pid) => pid === 999_999_997 })).kind).toBe("copied")
  expect(existsSync(dead)).toBe(false)
  expect(existsSync(running)).toBe(true)
  expect(existsSync(join(parent, "harness.copying-999999996"))).toBe(true)
  expect(existsSync(to)).toBe(true)
  // Swept on a later start too, when the new folder is already there.
  mkdirSync(dead, { recursive: true })
  expect((await migrateHome(env, { isAlive: () => false })).kind).toBe("none")
  expect(existsSync(dead)).toBe(false)
  expect(existsSync(running)).toBe(false)
})
