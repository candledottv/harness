// A bot's log after it's closed: a line that arrives late (a bot's last output, read after its exit) is still
// written, and the file it opened for that line is closed again at once. A handle left open would be closed by GC,
// which Bun counts as an uncaught error that ends the core; so this looks at the open handles, not at GC.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotLog } from "./supervisor"

let dir = ""
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ""
})

/** This process's open descriptors that name `path`, where the system lists them (Linux). */
function openOn(path: string): number | undefined {
  let fds: string[]
  try {
    fds = readdirSync("/proc/self/fd")
  } catch {
    return undefined
  }
  let n = 0
  for (const fd of fds) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`) === path) n++
    } catch {}
  }
  return n
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

const settle = async (path: string, text: string) => {
  for (let i = 0; i < 100 && !read(path).includes(text); i++) await Bun.sleep(5)
  // The line is in the file; the close that follows it is the next step of the same chain.
  await Bun.sleep(20)
}

test("a line written after the log is closed is kept, and the file it opened is closed again", async () => {
  dir = mkdtempSync(join(tmpdir(), "bot-log-"))
  const path = join(dir, "momentum.log")
  const log = new BotLog(path, { cap: 1 << 20, perMinute: 1 << 20, redact: (t) => t, now: () => Date.UTC(2026, 10, 10) })
  log.note("started")
  await log.close()
  expect(openOn(path) ?? 0).toBe(0)

  log.note("ended (exit 1)")
  await settle(path, "ended (exit 1)")
  expect(readFileSync(path, "utf8")).toContain("ended (exit 1)")
  expect((log as unknown as { handle?: unknown }).handle).toBeUndefined()
  const open = openOn(path)
  if (open !== undefined) expect(open).toBe(0)
})

test("a bot's output fed after the close is kept too, and leaves no file open", async () => {
  dir = mkdtempSync(join(tmpdir(), "bot-log-"))
  const path = join(dir, "relay.log")
  const log = new BotLog(path, { cap: 1 << 20, perMinute: 1 << 20, redact: (t) => t, now: () => Date.UTC(2026, 10, 10) })
  await log.close()
  log.feed("err", "SyntaxError: Unexpected token\n")
  await settle(path, "SyntaxError")
  expect(read(path)).toContain("err  SyntaxError: Unexpected token")
  expect((log as unknown as { handle?: unknown }).handle).toBeUndefined()
  const open = openOn(path)
  if (open !== undefined) expect(open).toBe(0)
})
