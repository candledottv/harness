// Candle TUI 0.2 kept its config and state in ~/.config/candle/tui; Candle Harness keeps them in
// ~/.config/candle/harness. On the first start the old folder is copied in, whole: config.toml, the
// agents' keys, the journal and every state file, each with its own mode. The old folder is never
// deleted. Once the copy is checked against the old folder and a start on the new folder has gone well, the old
// folder is renamed to tui.migrated-<UTC date>, so the keys in it aren't left where 0.2 would use them, and the
// person is told they may delete it. If the old folder changed since the copy (0.2 ran again), or a 0.2 core is
// running on it, it's left exactly as it is.
//
// Nothing is copied when a home is named (CANDLE_HARNESS_HOME, or 0.2's CANDLE_TUI_HOME, which paths()
// still reads), when the new folder already exists, or when there's no old one. A 0.2 core still running
// on the old folder is writing its journal, so the copy waits until it's quit. The copy is made beside the
// new folder and renamed into place, so a copy cut short never looks like a finished one.
import { createHash } from "node:crypto"
import { copyFile, chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { pidIsAlive } from "./shared/lock"

export type HomeMove = { kind: "none" } | { kind: "copied"; from: string; to: string } | { kind: "refused"; from: string; message: string }

/** Left behind in the old folder: a live core's socket and lock belong to that folder only. */
const LEFT = new Set(["state/core.sock", "state/core.lock"])

/** In the new folder: the copy's record, what the old folder held when it was copied, file by file. */
export const COPY_RECORD = join("state", "migrated-from-tui.json")

type Manifest = Record<string, string>

/** Each entry of a home folder that's copied, by its path: a file's SHA-256, a link's target, or "dir". */
async function manifest(dir: string, rel = "", out: Manifest = {}): Promise<Manifest> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (LEFT.has(path) || path.startsWith("state/core.lock.") || path === COPY_RECORD) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out[path] = "dir"
      await manifest(full, path, out)
    } else if (entry.isSymbolicLink()) out[path] = `link:${await readlink(full)}`
    else if (entry.isFile()) out[path] = createHash("sha256").update(await readFile(full)).digest("hex")
  }
  return out
}

const same = (a: Manifest, b: Manifest) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

export function oldHome(env: Record<string, string | undefined>): string {
  return join(env.HOME ?? homedir(), ".config", "candle", "tui")
}

export function newHome(env: Record<string, string | undefined>): string {
  return join(env.HOME ?? homedir(), ".config", "candle", "harness")
}

async function kind(path: string): Promise<"dir" | "other" | undefined> {
  try {
    return (await lstat(path)).isDirectory() ? "dir" : "other"
  } catch {
    return undefined
  }
}

/** The pid in a 0.2 core's lock, if it names a live process. */
async function liveCore(from: string, isAlive: (pid: number) => boolean): Promise<number | undefined> {
  try {
    const { pid } = JSON.parse(await readFile(join(from, "state", "core.lock"), "utf8")) as { pid?: unknown }
    return typeof pid === "number" && isAlive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

/** A Candle TUI 0.2 core's pid, when one is running on 0.2's home. */
export async function oldCoreRunning(env: Record<string, string | undefined>, isAlive: (pid: number) => boolean = pidIsAlive): Promise<number | undefined> {
  return liveCore(oldHome(env), isAlive)
}

async function copyTree(from: string, to: string, rel: string): Promise<void> {
  const info = await lstat(from)
  await mkdir(to, { mode: 0o700 })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (LEFT.has(path) || path.startsWith("state/core.lock.")) continue
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dest, path)
    else if (entry.isSymbolicLink()) await symlink(await readlink(src), dest)
    else if (entry.isFile()) {
      await copyFile(src, dest)
      await chmod(dest, (await lstat(src)).mode & 0o777)
    }
    // A socket or a pipe is a running process's, not state: never copied.
  }
  await chmod(to, info.mode & 0o777)
}

/**
 * A copy a start left half-made when it died (`harness.copying-<pid>`, holding a copy of the keys): removed once
 * its pid is gone. One whose pid still runs is another start copying now, and is left to it.
 */
async function sweepStaging(to: string, isAlive: (pid: number) => boolean): Promise<void> {
  const parent = join(to, "..")
  const prefix = `${basename(to)}.copying-`
  const names = await readdir(parent).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number(name.slice(prefix.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue
    const path = join(parent, name)
    if ((await kind(path)) === "dir") await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

/** Copies 0.2's home into the new one on the first start, checked file by file; says what it did. Never touches the old folder. */
export async function migrateHome(env: Record<string, string | undefined>, opts: { isAlive?: (pid: number) => boolean; afterCopy?: (staging: string) => Promise<void> } = {}): Promise<HomeMove> {
  if (env.CANDLE_HARNESS_HOME !== undefined || env.CANDLE_TUI_HOME !== undefined) return { kind: "none" }
  const from = oldHome(env)
  const to = newHome(env)
  await sweepStaging(to, opts.isAlive ?? pidIsAlive)
  if ((await kind(to)) !== undefined || (await kind(from)) !== "dir") return { kind: "none" }
  const pid = await liveCore(from, opts.isAlive ?? pidIsAlive)
  if (pid !== undefined) {
    return {
      kind: "refused",
      from,
      message: `A Candle TUI 0.2 core is still running (pid ${pid}) on ${from}. Quit it, then start candle-harness again: its config, keys and journal are copied to ${to} on the first start, and ${from} is left as it is.`,
    }
  }
  const staging = `${to}.copying-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  try {
    await copyTree(from, staging, "")
    await opts.afterCopy?.(staging)
    // The copy check: every file, link and folder the old one holds, the same in the copy.
    const held = await manifest(from)
    if (!same(held, await manifest(staging))) throw new Error("the copy doesn't match the old folder")
    // The record goes in state/: made private when the old folder had none, and never written through a link.
    const state = join(staging, "state")
    const stateKind = await lstat(state).then((i) => (i.isSymbolicLink() ? "link" : i.isDirectory() ? "dir" : "other")).catch(() => undefined)
    if (stateKind === undefined) await mkdir(state, { mode: 0o700 })
    else if (stateKind !== "dir") throw new Error(`${join(from, "state")} isn't a folder (a link or a file), so it can't be copied as a home's state`)
    await writeFile(join(staging, COPY_RECORD), `${JSON.stringify({ from, copiedAt: new Date().toISOString(), held })}\n`, { mode: 0o600 })
    await rename(staging, to)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    // Another start (the view and its core) copied it first: the new folder is there, and it's that one.
    if ((await kind(to)) === "dir") return { kind: "none" }
    throw error
  }
  return { kind: "copied", from, to }
}

export type HomeRetire = { kind: "none" } | { kind: "renamed"; from: string; to: string } | { kind: "kept"; from: string; why: string }

/**
 * After a start on the new folder went well: the old folder, checked once more against what was copied, is
 * renamed to `tui.migrated-<UTC date>` beside it. Never deleted; never renamed when it changed since the copy,
 * when a 0.2 core is running on it, or when there's no record of a checked copy.
 */
export async function retireOldHome(env: Record<string, string | undefined>, opts: { now?: () => Date; isAlive?: (pid: number) => boolean } = {}): Promise<HomeRetire> {
  if (env.CANDLE_HARNESS_HOME !== undefined && env.CANDLE_HARNESS_HOME !== newHome(env)) return { kind: "none" }
  const from = oldHome(env)
  const recordPath = join(newHome(env), COPY_RECORD)
  let record: { from?: unknown; held?: unknown; retired?: unknown }
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as typeof record
  } catch {
    return { kind: "none" }
  }
  if (record.retired !== undefined || record.from !== from || typeof record.held !== "object" || record.held === null) return { kind: "none" }
  if ((await kind(from)) !== "dir") return { kind: "none" }
  const pid = await liveCore(from, opts.isAlive ?? pidIsAlive)
  if (pid !== undefined) return { kind: "kept", from, why: `a Candle TUI 0.2 core is running on it (pid ${pid})` }
  if (!same(record.held as Manifest, await manifest(from))) {
    await writeFile(recordPath, `${JSON.stringify({ ...record, retired: "kept: changed since the copy" })}\n`, { mode: 0o600 })
    return { kind: "kept", from, why: "it changed after it was copied, so it may hold something the new folder doesn't" }
  }
  const day = (opts.now?.() ?? new Date()).toISOString().slice(0, 10)
  let to = `${from}.migrated-${day}`
  for (let n = 2; (await kind(to)) !== undefined; n++) to = `${from}.migrated-${day}-${n}`
  await rename(from, to)
  await writeFile(recordPath, `${JSON.stringify({ ...record, retired: to })}\n`, { mode: 0o600 })
  return { kind: "renamed", from, to }
}
