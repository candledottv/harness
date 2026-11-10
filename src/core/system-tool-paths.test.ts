// Each place the core starts `ps` or `git` hands Bun.spawn a full path, never a bare name for the spawn to look up.
// Bun.spawn is replaced here, so the program each call site names is read from the argv it hands over.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIgnores, groupCarriesBot, psIdentify, psSample } from "./supervisor"
import { psRows, strayRows } from "./research-run"

let spawned: string[][] = []
let spy: ReturnType<typeof spyOn> | undefined
let bin = ""
let savedPath: string | undefined
let savedPlatform: PropertyDescriptor | undefined

/** What the fake `ps` prints for each kind of question. */
function answer(argv: readonly string[]): string {
  const fields = argv.join(" ")
  if (fields.includes("pid=,pgid=")) return "4242 777\n"
  if (fields.includes("lstart=")) return "Sun Nov  8 14:02:03 2026 /usr/bin/true\n"
  return ""
}

beforeEach(() => {
  spawned = []
  // A folder holding a `ps` and a `git`, as the only entry on PATH: a full path is this folder's.
  bin = mkdtempSync(join(tmpdir(), "system-tools-"))
  for (const name of ["ps", "git"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n")
    chmodSync(join(bin, name), 0o755)
  }
  savedPath = process.env.PATH
  process.env.PATH = bin
  spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    spawned.push([...argv])
    return { pid: 1, stdout: new Response(answer(argv)).body, stderr: null, exited: Promise.resolve(1) }
  }) as never)
})

afterEach(() => {
  spy?.mockRestore()
  process.env.PATH = savedPath
  if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform)
  savedPlatform = undefined
  rmSync(bin, { recursive: true, force: true })
})

describe("the core's system tools are started by full path", () => {
  test("the supervisor's process reads name ps by its full path", async () => {
    await psSample()
    await psIdentify(4242)
    expect(spawned.map((a) => a[0])).toEqual([join(bin, "ps"), join(bin, "ps")])
  })

  test("the supervisor's git check names git by its full path", async () => {
    await gitIgnores(bin, "token")
    expect(spawned.map((a) => a[0])).toEqual([join(bin, "git")])
  })

  test("a bot's group read names ps by its full path, macOS's environment read too", async () => {
    savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    await groupCarriesBot(777, "bot", "/tmp/core.sock")
    expect(spawned.length).toBe(2)
    expect(spawned.map((a) => a[0])).toEqual([join(bin, "ps"), join(bin, "ps")])
  })

  test("the code runner's process reads name /bin/ps, whatever PATH holds", async () => {
    await psRows()
    await strayRows()
    expect(spawned.map((a) => a[0])).toEqual(["/bin/ps", "/bin/ps"])
  })
})
