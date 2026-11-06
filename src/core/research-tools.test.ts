// The agent's research tools read only its own folder: a link out is refused, and so is a file swapped for
// one outside in the moment between the path's check and the open.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_READ_BYTES, namesOpened, researchCall } from "./research-tools"

const base = mkdtempSync(join(tmpdir(), "chrn-research-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const folder = () => {
  const dir = mkdtempSync(join(base, "r-"))
  const root = join(dir, "research")
  mkdirSync(join(root, "notes"), { recursive: true })
  writeFileSync(join(root, "notes", "a.md"), "inside\n")
  writeFileSync(join(dir, "secret.txt"), "outside\n")
  return { dir, root }
}

test("a note inside reads; a link out of the folder is refused", async () => {
  const { dir, root } = folder()
  expect(await researchCall(root, "research_read", { path: "notes/a.md" })).toMatchObject({ ok: true, body: { text: "inside\n" } })
  symlinkSync(join(dir, "secret.txt"), join(root, "out.md"))
  expect(await researchCall(root, "research_read", { path: "out.md" })).toMatchObject({ ok: false })
})

test("a folder swapped for a link outside right after the path's check reads nothing", async () => {
  const { dir, root } = folder()
  mkdirSync(join(dir, "elsewhere"))
  writeFileSync(join(dir, "elsewhere", "a.md"), "outside\n")
  const swap = async () => {
    renameSync(join(root, "notes"), join(dir, "notes-was"))
    symlinkSync(join(dir, "elsewhere"), join(root, "notes"))
  }
  const r = await researchCall(root, "research_read", { path: "notes/a.md" }, { afterCheck: swap })
  expect(r.ok).toBe(false)
  expect(JSON.stringify(r)).not.toContain("outside\n")
  expect(JSON.stringify(r)).toContain("OUTSIDE_RESEARCH_FOLDER")
})

test("a file grown past the limit after the check is refused by the opened file's size", async () => {
  const { root } = folder()
  const r = await researchCall(root, "research_read", { path: "notes/a.md" }, { afterCheck: async () => writeFileSync(join(root, "notes", "a.md"), "x".repeat(MAX_READ_BYTES + 1)) })
  expect(r).toMatchObject({ ok: false })
  expect(JSON.stringify(r)).toContain("TOO_BIG")
})

test("the path checked must name the opened file with no link on it: a folder swapped for a link, or swapped back, fails", async () => {
  const { dir, root } = folder()
  mkdirSync(join(dir, "elsewhere"))
  writeFileSync(join(dir, "elsewhere", "a.md"), "outside\n")
  const real = join(realpathSync(root), "notes", "a.md")
  expect(await namesOpened(real, statSync(real))).toBe(true)
  // The folder is a link out when the file is opened through it.
  renameSync(join(root, "notes"), join(dir, "notes-was"))
  symlinkSync(join(dir, "elsewhere"), join(root, "notes"))
  const opened = statSync(real)
  expect(await namesOpened(real, opened)).toBe(false)
  // And swapped back to the real folder before the check: the path names another file.
  rmSync(join(root, "notes"))
  renameSync(join(dir, "notes-was"), join(root, "notes"))
  expect(await namesOpened(real, opened)).toBe(false)
})
