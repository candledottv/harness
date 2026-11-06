import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureStateDir, InvalidAgentName, paths, PathsError, SOCKET_PATH_MAX_BYTES, UnsafeConfigDir, UnsafeStateDir } from "./paths"

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chp-"))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test("defaults resolve under ~/.config/candle/harness", () => {
  const home = tempHome()
  const p = paths({ HOME: home })
  const base = join(home, ".config", "candle", "harness")
  expect(p.configDir).toBe(base)
  expect(p.configFile).toBe(join(base, "config.toml"))
  expect(p.stateDir).toBe(join(base, "state"))
  expect(p.socket).toBe(join(base, "state", "core.sock"))
  expect(p.lock).toBe(join(base, "state", "core.lock"))
  expect(p.journal).toBe(join(base, "state", "journal.jsonl"))
  expect(p.keysDir).toBe(join(base, "state", "keys"))
  expect(p.keyFile("momentum")).toBe(join(base, "state", "keys", "momentum.key"))
  expect(p.tokens).toBe(join(base, "state", "tokens.json"))
  expect(p.viewToken).toBe(join(base, "state", "view.token"))
  expect(p.turnsDir).toBe(join(base, "state", "turns"))
  // The engine's working folder is outside the state folder, so its file tools never reach keys or tokens.
  expect(p.researchDir("momentum")).toBe(join(base, "research", "momentum"))
})

test("CANDLE_HARNESS_HOME overrides the config folder", () => {
  const home = tempHome()
  const custom = join(home, "elsewhere")
  const p = paths({ HOME: home, CANDLE_HARNESS_HOME: custom })
  expect(p.configDir).toBe(custom)
  expect(p.socket).toBe(join(custom, "state", "core.sock"))
})

test("a relative CANDLE_HARNESS_HOME is refused: a tmux split would resolve it somewhere else", () => {
  expect(() => paths({ HOME: "/home/you", CANDLE_HARNESS_HOME: "rel/harness" })).toThrow(PathsError)
})

test("a socket path of 104 bytes or more is refused, naming the variable that shortens it", () => {
  const suffix = "/state/core.sock" // what paths() adds under the home
  const fits = "/" + "a".repeat(SOCKET_PATH_MAX_BYTES - 1 - suffix.length - 1)
  expect(paths({ CANDLE_HARNESS_HOME: fits }).socket.length).toBe(SOCKET_PATH_MAX_BYTES - 1)

  const tooLong = fits + "a"
  expect(() => paths({ CANDLE_HARNESS_HOME: tooLong })).toThrow(/CANDLE_HARNESS_HOME/)
  // Bytes, not characters: a multi-byte name counts for what the kernel sees.
  const multiByte = "/" + "é".repeat(50)
  expect(() => paths({ CANDLE_HARNESS_HOME: multiByte })).toThrow(PathsError)
})

test("an agent name that could leave the keys folder is refused", () => {
  const p = paths({ HOME: "/home/you" })
  for (const bad of ["../x", "a/b", "", ".hidden", "A".repeat(33), "Mo mentum", "x\0"]) {
    expect(() => p.keyFile(bad)).toThrow(InvalidAgentName)
    expect(() => p.researchDir(bad)).toThrow(InvalidAgentName)
  }
  expect(p.keyFile("swing-2_b")).toEndWith("/keys/swing-2_b.key")
})

test("ensureStateDir creates the state folder private", async () => {
  const p = paths({ HOME: tempHome() })
  await ensureStateDir(p)
  expect(statSync(p.stateDir).mode & 0o777).toBe(0o700)
})

test("ensureStateDir tightens a readable folder it owns", async () => {
  const p = paths({ HOME: tempHome() })
  mkdirSync(p.stateDir, { recursive: true })
  chmodSync(p.stateDir, 0o755)
  await ensureStateDir(p)
  expect(statSync(p.stateDir).mode & 0o777).toBe(0o700)
})

test("ensureStateDir refuses a group- or world-writable state folder", async () => {
  for (const mode of [0o770, 0o707]) {
    const p = paths({ HOME: tempHome() })
    mkdirSync(p.stateDir, { recursive: true })
    chmodSync(p.stateDir, mode)
    await expect(ensureStateDir(p)).rejects.toBeInstanceOf(UnsafeStateDir)
    expect(statSync(p.stateDir).mode & 0o777).toBe(mode) // refused, not quietly fixed
  }
})

test("ensureStateDir refuses a state path that is a symlink", async () => {
  const home = tempHome()
  const p = paths({ HOME: home })
  const real = join(home, "real")
  mkdirSync(real, { mode: 0o700 })
  mkdirSync(p.configDir, { recursive: true })
  symlinkSync(real, p.stateDir)
  await expect(ensureStateDir(p)).rejects.toThrow(/is a symlink/)
})

test("ensureStateDir refuses a config folder or config.toml anyone can write, and leaves it as it was", async () => {
  const home = tempHome()
  const p = paths({ CANDLE_HARNESS_HOME: join(home, "harness") })
  mkdirSync(p.configDir, { mode: 0o700 })
  chmodSync(p.configDir, 0o777)
  await expect(ensureStateDir(p)).rejects.toBeInstanceOf(UnsafeConfigDir)
  expect(statSync(p.configDir).mode & 0o777).toBe(0o777)
  chmodSync(p.configDir, 0o700)
  writeFileSync(p.configFile, "mode = \"paper\"\n")
  chmodSync(p.configFile, 0o646)
  const refused = await ensureStateDir(p).catch((e: unknown) => e)
  expect(refused).toBeInstanceOf(UnsafeStateDir)
  expect((refused as Error).message).toContain(p.configFile)
  expect((refused as Error).message).toContain("chmod o-w")
})

test("ensureStateDir refuses a config.toml that is another user's, followed through a link", async () => {
  const p = paths({ CANDLE_HARNESS_HOME: join(tempHome(), "harness") })
  mkdirSync(p.configDir, { mode: 0o700 })
  symlinkSync("/etc/passwd", p.configFile)
  await expect(ensureStateDir(p)).rejects.toThrow(/belongs to another user/)
})

test("ensureStateDir tightens a group-writable config folder and files of ours, and takes a linked config.toml of ours", async () => {
  const home = tempHome()
  const p = paths({ CANDLE_HARNESS_HOME: join(home, "harness") })
  mkdirSync(p.configDir, { mode: 0o700 })
  chmodSync(p.configDir, 0o775)
  const real = join(home, "dotfiles-config.toml")
  writeFileSync(real, "mode = \"paper\"\n")
  chmodSync(real, 0o664)
  symlinkSync(real, p.configFile)
  writeFileSync(p.layoutsFile, "")
  chmodSync(p.layoutsFile, 0o664)
  await ensureStateDir(p)
  expect(statSync(p.configDir).mode & 0o777).toBe(0o755)
  expect(statSync(real).mode & 0o777).toBe(0o644)
  expect(statSync(p.layoutsFile).mode & 0o777).toBe(0o644)
})
