import { expect, test } from "bun:test"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "supervisor-gc-check.ts")

test("a code bot that doesn't parse crashes and restarts under the real supervisor with GC running, and nothing is left for GC to close", async () => {
  const run = Bun.spawn([process.execPath, SCRIPT, "1500"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  // Counted, not quoted: each one prints a dozen lines.
  expect(err.split("FileHandle object was closed").length - 1).toBe(0)
  expect(out).toMatch(/[1-9]\d* crashes and restarts under GC/)
  expect(code).toBe(0)
}, 30_000)
