// Private homes: a harness's sign-in
// reaches it by link or copy, a refreshed sign-in reaches the real file, and a home a dead core left is
// handed back and removed on the next start.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateHome, recoverHomes, removeAll } from "./home"

const roots: string[] = []
afterAll(() => {
  for (const r of roots) removeAll(r)
})
function world() {
  const root = mkdtempSync(join(tmpdir(), "candle-home-test-"))
  roots.push(root)
  const real = join(root, "real")
  mkdirSync(real)
  const auth = join(real, "auth.json")
  writeFileSync(auth, '{"token":"old"}')
  const past = new Date(Date.now() - 60_000)
  utimesSync(auth, past, past)
  const base = join(root, "homes")
  return { root, real, auth, base }
}

test("a linked home holds a symlink to the real sign-in, and a write in place needs no hand-back", () => {
  const w = world()
  const h = privateHome({ base: w.base, name: "t_1-codex", realAuth: w.auth })
  const link = join(h.home, "auth.json")
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readlinkSync(link)).toBe(w.auth)
  writeFileSync(link, '{"token":"refreshed"}') // through the link, in place
  h.close()
  expect(readFileSync(w.auth, "utf8")).toBe('{"token":"refreshed"}')
  expect(existsSync(h.home)).toBe(false)
})

test("a harness that replaces the linked file has its refreshed copy handed back", () => {
  const w = world()
  const h = privateHome({ base: w.base, name: "t_2-codex", realAuth: w.auth })
  const link = join(h.home, "auth.json")
  rmSync(link)
  writeFileSync(link, '{"token":"rotated"}')
  h.close()
  expect(readFileSync(w.auth, "utf8")).toBe('{"token":"rotated"}')
})

test("a real sign-in newer than the turn's copy is kept", () => {
  const w = world()
  const h = privateHome({ base: w.base, name: "t_3-codex", realAuth: w.auth })
  const link = join(h.home, "auth.json")
  rmSync(link)
  writeFileSync(link, '{"token":"stale"}')
  const past = new Date(Date.now() - 120_000)
  utimesSync(link, past, past)
  writeFileSync(w.auth, '{"token":"user-signed-in-again"}')
  h.close()
  expect(readFileSync(w.auth, "utf8")).toBe('{"token":"user-signed-in-again"}')
})

test("no sign-in: the home has none, and closing makes none", () => {
  const w = world()
  rmSync(w.auth)
  const h = privateHome({ base: w.base, name: "t_4-codex", realAuth: w.auth })
  expect(existsSync(join(h.home, "auth.json"))).toBe(false)
  h.close()
  expect(existsSync(w.auth)).toBe(false)
})

test("a copied home (Grok under strict) carries the real file's times, so an untouched copy isn't handed back", () => {
  const w = world()
  const before = statSync(w.auth).mtimeMs
  const h = privateHome({ base: w.base, name: "t_5-grok", realAuth: w.auth, copy: true })
  const copy = join(h.home, "auth.json")
  expect(lstatSync(copy).isSymbolicLink()).toBe(false)
  expect(Math.round(statSync(copy).mtimeMs)).toBe(Math.round(before))
  expect(statSync(copy).mode & 0o777).toBe(0o600)
  h.close()
  expect(statSync(w.auth).mtimeMs).toBe(before) // not rewritten
})

test("a copied home a harness refreshed is handed back", () => {
  const w = world()
  const h = privateHome({ base: w.base, name: "t_6-grok", realAuth: w.auth, copy: true })
  writeFileSync(join(h.home, "auth.json"), '{"token":"grok-refreshed"}')
  h.close()
  expect(readFileSync(w.auth, "utf8")).toBe('{"token":"grok-refreshed"}')
})

test("homes live in a private folder under the base, never /tmp's own", () => {
  const w = world()
  const h = privateHome({ base: w.base, name: "t_7-codex", realAuth: w.auth })
  expect(h.home).toBe(join(w.base, "t_7-codex"))
  expect(statSync(w.base).mode & 0o777).toBe(0o700)
  expect(statSync(h.home).mode & 0o777).toBe(0o700)
  h.close()
})

test("removeAll restores the owner's permissions first: Grok's sandbox leaves a mode-000 folder", () => {
  const w = world()
  const dir = join(w.root, "probe")
  mkdirSync(join(dir, "sandbox-blocked-dir.1"), { recursive: true })
  writeFileSync(join(dir, "sandbox-blocked-dir.1", "x"), "x")
  chmodSync(join(dir, "sandbox-blocked-dir.1"), 0o000)
  writeFileSync(join(dir, "sandbox-blocked.1"), "")
  chmodSync(join(dir, "sandbox-blocked.1"), 0o000)
  removeAll(dir)
  expect(existsSync(dir)).toBe(false)
})

test("on the next start, a home a dead core left is handed back and removed", () => {
  const w = world()
  const h = privateHome({ base: w.base, name: "t_8-codex", realAuth: w.auth })
  const link = join(h.home, "auth.json")
  rmSync(link)
  writeFileSync(link, '{"token":"refreshed-before-the-crash"}')
  // The core died here: no close.
  const r = recoverHomes(w.base)
  expect(r).toEqual({ handedBack: [w.auth], removed: ["t_8-codex"] })
  expect(readFileSync(w.auth, "utf8")).toBe('{"token":"refreshed-before-the-crash"}')
  expect(existsSync(h.home)).toBe(false)
  expect(recoverHomes(w.base)).toEqual({ handedBack: [], removed: [] })
})

test("recovery removes a folder with no record, and a base that doesn't exist is nothing to do", () => {
  const w = world()
  mkdirSync(join(w.base, "stray"), { recursive: true })
  expect(recoverHomes(w.base)).toEqual({ handedBack: [], removed: ["stray"] })
  expect(recoverHomes(join(w.root, "absent"))).toEqual({ handedBack: [], removed: [] })
})
