// Keep-awake on a clock: caffeinate -i -w <pid> runs only on macOS, with the setting on and a trigger on; it ends
// when either goes, and with the core; the choice is kept over config.toml's; one that ends as it starts isn't
// tried again until the setting is switched, and one killed from outside later is started again.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Caffeinated, KeepAwake } from "./keep-awake"

const dir = mkdtempSync("/tmp/chrn-awake-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0

function fake() {
  const runs: { argv: string[]; killed: boolean; end: (code: number | null) => void }[] = []
  const spawn = (argv: string[]): Caffeinated => {
    let end!: (code: number | null) => void
    const exited = new Promise<number | null>((resolve) => (end = resolve))
    const run = { argv, killed: false, end }
    runs.push(run)
    return { kill: () => ((run.killed = true), end(null)), exited }
  }
  return { runs, spawn }
}

function awake(opts: { initial?: boolean; platform?: NodeJS.Platform; now?: () => number; file?: string } = {}) {
  const f = fake()
  const changes: [boolean, string][] = []
  const k = new KeepAwake({ file: opts.file ?? join(dir, `k${n++}.json`), initial: opts.initial ?? true, platform: opts.platform ?? "darwin", pid: 4242, now: opts.now ?? (() => 0), spawn: f.spawn, onChange: (a, why) => void changes.push([a, why]) })
  return { k, ...f, changes }
}

test("runs with the setting and a trigger on, and ends with the last trigger, the setting, or the core", async () => {
  const { k, runs, changes } = awake()
  k.update(false)
  expect(runs).toEqual([])
  k.update(true)
  k.update(true)
  expect(runs.map((r) => r.argv)).toEqual([["caffeinate", "-i", "-w", "4242"]])
  expect(k.view()).toEqual({ on: true, available: true, active: true })
  k.update(false)
  expect(runs[0]!.killed).toBe(true)
  k.update(true)
  k.set(false)
  expect(runs[1]!.killed).toBe(true)
  expect(k.view()).toEqual({ on: false, available: true, active: false })
  k.set(true)
  expect(runs.length).toBe(3)
  k.stop()
  expect(runs[2]!.killed).toBe(true)
  k.update(true)
  expect(runs.length).toBe(3)
  expect(changes.map(([a, why]) => `${a} ${why}`)).toEqual([
    "true a trigger or bot is on",
    "false no trigger or bot is on",
    "true a trigger or bot is on",
    "false keep-awake was switched off",
    "true a trigger or bot is on",
    "false the core stopped",
  ])
})

test("macOS only, and off by default: never runs elsewhere, or with the setting off", () => {
  const linux = awake({ platform: "linux" })
  linux.k.update(true)
  expect(linux.runs).toEqual([])
  expect(linux.k.view()).toEqual({ on: true, available: false, active: false })
  const off = awake({ initial: false })
  off.k.update(true)
  expect(off.runs).toEqual([])
})

test("the choice last made is kept, 0600, over config.toml's", () => {
  const file = join(dir, "kept.json")
  const first = awake({ initial: false, file })
  first.k.set(true)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ on: true })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(awake({ initial: false, file }).k.view().on).toBe(true)
  writeFileSync(file, "not json")
  expect(awake({ initial: true, file }).k.view().on).toBe(true)
})

test("one that ends as it starts isn't tried again until switched; one killed from outside later is started again", async () => {
  let t = 0
  const { k, runs } = awake({ now: () => t })
  k.update(true)
  runs[0]!.end(1)
  await Bun.sleep(0)
  expect(k.view()).toEqual({ on: true, available: true, active: false, failed: "caffeinate ended as it started (exit 1)" })
  k.update(true)
  expect(runs.length).toBe(1)
  k.set(true)
  expect(runs.length).toBe(2)
  t = 60_000
  runs[1]!.end(null)
  await Bun.sleep(0)
  expect(runs.length).toBe(3)
  expect(k.view().active).toBe(true)
})
