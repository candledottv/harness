// One core per account per machine: the instance lock.
import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireInstanceLock, CoreAlreadyRunningError, pidIsAlive, SILENT_LOCK_GRACE_MS, UNREADABLE_LOCK_GRACE_MS } from "./lock"

const dirs: string[] = []
async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "candle-core-lock-"))
  dirs.push(dir)
  return { lockPath: join(dir, "core.lock"), socketPath: join(dir, "core.sock") }
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("acquireInstanceLock", () => {
  test("a second acquire for a live holder refuses with CORE_ALREADY_RUNNING and the socket path", async () => {
    const p = await paths()
    const held = await acquireInstanceLock({ ...p, pid: process.pid })
    const second = acquireInstanceLock({ ...p, pid: process.pid + 1 })
    await expect(second).rejects.toBeInstanceOf(CoreAlreadyRunningError)
    await second.catch((error: CoreAlreadyRunningError) => {
      expect(error.code).toBe("CORE_ALREADY_RUNNING")
      expect(error.socketPath).toBe(p.socketPath)
      expect(error.pid).toBe(process.pid)
    })
    await held.release()
    const third = await acquireInstanceLock({ ...p, pid: process.pid })
    await third.release()
  })

  test("a lock whose pid is dead is taken over", async () => {
    const p = await paths()
    await writeFile(p.lockPath, `${JSON.stringify({ pid: 999_999_999 })}\n`)
    const lock = await acquireInstanceLock({ ...p, pid: process.pid, isAlive: (pid) => pid === process.pid })
    expect(JSON.parse(await readFile(p.lockPath, "utf8")).pid).toBe(process.pid)
    await lock.release()
  })

  test("an unreadable lock counts as held for a moment: it may be one being written this instant", async () => {
    const p = await paths()
    await writeFile(p.lockPath, "")
    await expect(acquireInstanceLock({ ...p, isAlive: () => false })).rejects.toBeInstanceOf(CoreAlreadyRunningError)
  })

  test("a lock still unreadable past that moment (a start that died writing it) is taken over", async () => {
    const p = await paths()
    for (const left of ["", "{\"pi"]) {
      await writeFile(p.lockPath, left)
      const then = (Date.now() - UNREADABLE_LOCK_GRACE_MS - 1000) / 1000
      await utimes(p.lockPath, then, then)
      const lock = await acquireInstanceLock({ ...p, pid: process.pid })
      expect(JSON.parse(await readFile(p.lockPath, "utf8")).pid).toBe(process.pid)
      await lock.release()
    }
  })

  test("a lock that couldn't be written is removed, so it doesn't hold off the next start", async () => {
    const p = await paths()
    await expect(acquireInstanceLock({ ...p, now: () => Number.NaN })).rejects.toBeInstanceOf(RangeError)
    await expect(access(p.lockPath)).rejects.toMatchObject({ code: "ENOENT" })
    await (await acquireInstanceLock(p)).release()
  })

  test("a holder whose lock a later start took over no longer holds it, even with the same pid, and its release leaves the new one", async () => {
    const p = await paths()
    const first = await acquireInstanceLock({ ...p, pid: process.pid })
    expect(await first.held()).toBe(true)
    const then = (Date.now() - SILENT_LOCK_GRACE_MS - 1000) / 1000
    await utimes(p.lockPath, then, then)
    const second = await acquireInstanceLock({ ...p, pid: process.pid, isAlive: () => true, answers: async () => false })
    expect(await first.held()).toBe(false)
    expect(await second.held()).toBe(true)
    await first.release()
    expect(await second.held()).toBe(true)
    await second.release()
    await expect(access(p.lockPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("an old lock whose pid is alive but where no core answers (a reused pid) is taken over; one that answers is not", async () => {
    const p = await paths()
    const old = async () => {
      await writeFile(p.lockPath, `${JSON.stringify({ pid: 4242 })}\n`)
      const then = (Date.now() - SILENT_LOCK_GRACE_MS - 1000) / 1000
      await utimes(p.lockPath, then, then)
    }
    await old()
    await expect(acquireInstanceLock({ ...p, pid: process.pid, isAlive: () => true, answers: async () => true })).rejects.toBeInstanceOf(CoreAlreadyRunningError)
    const lock = await acquireInstanceLock({ ...p, pid: process.pid, isAlive: () => true, answers: async () => false })
    expect(JSON.parse(await readFile(p.lockPath, "utf8")).pid).toBe(process.pid)
    await lock.release()
    // A young lock is a core still starting, socket or no.
    await writeFile(p.lockPath, `${JSON.stringify({ pid: 4242 })}\n`)
    await expect(acquireInstanceLock({ ...p, pid: process.pid, isAlive: () => true, answers: async () => false })).rejects.toBeInstanceOf(CoreAlreadyRunningError)
  })

  test("release removes only our own lock", async () => {
    const p = await paths()
    const lock = await acquireInstanceLock({ ...p, pid: process.pid })
    await writeFile(p.lockPath, `${JSON.stringify({ pid: 12345 })}\n`)
    await lock.release()
    expect(JSON.parse(await readFile(p.lockPath, "utf8")).pid).toBe(12345)
  })

  test("pidIsAlive", () => {
    expect(pidIsAlive(process.pid)).toBe(true)
    expect(pidIsAlive(0)).toBe(false)
    expect(pidIsAlive(-1)).toBe(false)
  })
})
