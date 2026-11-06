/**
 * One core per account per machine. A second core exits with
 * `CORE_ALREADY_RUNNING` and the socket path, so a view attaches instead of starting a rival that
 * would hold its own card queue and journal.
 *
 * The lock is a file created with O_EXCL holding the owner's pid. Unlike a lock taken for one
 * read-modify-write and broken by age, this one is held for the life of
 * the process, so age alone says nothing. A lock is stale when its pid is not a live process, when it
 * has stayed unreadable past a moment (a start that died between creating it and writing its pid), or
 * when its pid is alive but, a minute on, no core answers on the socket (a pid reused after a crash or
 * reboot). A stale lock is moved aside (never deleted in place, so two starters racing over it cannot
 * both win) and the create is tried once more.
 */
import { link, open, readFile, rename, rm, stat } from "node:fs/promises"
import { answers as socketAnswers } from "./socket-path"

/** Past this, a lock still without a pid is a start that died writing it, not one writing it now. */
export const UNREADABLE_LOCK_GRACE_MS = 2_000
/** Past this, a live pid with no core answering on the socket is a reused pid, not a core still starting. */
export const SILENT_LOCK_GRACE_MS = 60_000

export interface InstanceLock {
  /** Whether the lock is still the one this holder wrote: false once a later start has moved it aside. */
  held(): Promise<boolean>
  release(): Promise<void>
}

export class CoreAlreadyRunningError extends Error {
  readonly code = "CORE_ALREADY_RUNNING"
  constructor(
    readonly pid: number | undefined,
    readonly socketPath: string,
  ) {
    super(
      `A Candle Harness core is already running${pid !== undefined ? ` (pid ${pid})` : ""}. Attach to it at ${socketPath}.`,
    )
    this.name = "CoreAlreadyRunningError"
  }
}

/** Whether `pid` names a live process. EPERM means it exists under another user, so it is alive. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function lockOwner(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }
    return typeof parsed.pid === "number" ? parsed.pid : undefined
  } catch {
    return undefined
  }
}

export async function acquireInstanceLock(input: {
  lockPath: string
  socketPath: string
  pid?: number
  now?: () => number
  isAlive?: (pid: number) => boolean
  /** Whether a core answers on the socket. */
  answers?: (socketPath: string) => Promise<boolean>
}): Promise<InstanceLock> {
  const pid = input.pid ?? process.pid
  const isAlive = input.isAlive ?? pidIsAlive
  const answers = input.answers ?? socketAnswers
  const now = input.now ?? Date.now
  /** How long ago the lock file was last written, by the file system's clock. One that's gone is as good as stale. */
  const age = async () => {
    const info = await stat(input.lockPath).catch(() => undefined)
    return info ? Date.now() - info.mtimeMs : Number.POSITIVE_INFINITY
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Its own id too, so two holders with one pid (cores started in one process) are told apart.
      const wrote = `${JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), id: crypto.randomUUID() })}\n`
      const handle = await open(input.lockPath, "wx", 0o600)
      try {
        await handle.write(wrote)
        await handle.sync()
      } catch (writeError) {
        // A lock with no pid in it would hold every later start off.
        await rm(input.lockPath, { force: true })
        throw writeError
      } finally {
        await handle.close().catch(() => {})
      }
      let released = false
      const held = async () => !released && (await readFile(input.lockPath, "utf8").catch(() => undefined)) === wrote
      return {
        held,
        async release() {
          // Only our own lock: a lock another core took after ours was moved aside is not ours.
          const ours = await held()
          released = true
          if (ours) await rm(input.lockPath, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = await lockOwner(input.lockPath)
      // An unreadable lock may be one being written this instant; treat it as held, for a moment.
      if (owner === undefined && (await age()) < UNREADABLE_LOCK_GRACE_MS) throw new CoreAlreadyRunningError(owner, input.socketPath)
      // A live pid is a core unless the lock is old and nothing answers where that core would.
      if (owner !== undefined && isAlive(owner) && ((await age()) < SILENT_LOCK_GRACE_MS || (await answers(input.socketPath)))) {
        throw new CoreAlreadyRunningError(owner, input.socketPath)
      }
      const aside = `${input.lockPath}.stale-${owner ?? "unread"}-${pid}-${now()}`
      try {
        await rename(input.lockPath, aside)
      } catch (renameError) {
        // Another starter moved it first; the retry decides between us by O_EXCL.
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError
        continue
      }
      const moved = await lockOwner(aside)
      if (moved !== owner) {
        // Between our read and our rename, another starter replaced the stale lock with its own
        // live one, and we moved THAT aside. Put it back without clobbering (link fails if the
        // path is taken again), and yield to it.
        await link(aside, input.lockPath).catch(() => {})
        await rm(aside, { force: true })
        throw new CoreAlreadyRunningError(moved, input.socketPath)
      }
      await rm(aside, { force: true })
    }
  }
  throw new CoreAlreadyRunningError(await lockOwner(input.lockPath), input.socketPath)
}
