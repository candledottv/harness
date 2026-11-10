import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileStamp, RECENT_MS } from "./file-stamp"

const dir = mkdtempSync(join(tmpdir(), "chrn-stamp-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("a file's stamp, and whether it changed too recently to trust it; none with no file", () => {
  const path = join(dir, "a.toml")
  expect(fileStamp(path)).toBeUndefined()
  writeFileSync(path, "x = 1\n")
  const at = new Date(Date.now() - 10 * RECENT_MS)
  utimesSync(path, at, at)
  const old = fileStamp(path)!
  expect(old.recent).toBe(false)
  // Rewritten at the same size, its modified time set back: the stamp can't tell, so only age decides.
  writeFileSync(path, "x = 2\n")
  utimesSync(path, at, at)
  expect(fileStamp(path)!.stamp).toBe(old.stamp)
  expect(fileStamp(path, at.getTime() + RECENT_MS - 1)!.recent).toBe(true)
  expect(fileStamp(path, at.getTime() + RECENT_MS)!.recent).toBe(false)
})
