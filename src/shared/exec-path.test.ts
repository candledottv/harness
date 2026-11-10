// A program the app starts is never found through a PATH entry that isn't absolute: such an entry is looked
// up in the folder the child starts in, which for an engine is a folder its agent can write.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readVersion } from "../engine/engine"
import type { EngineEvent } from "../engine/events"
import { harnessEnv, runLines } from "../engine/spawn"
import { allowEnv, runChild, spawnChild } from "./child"
import { absolutePath, relativeEntries, resolveBin, withAbsolutePath } from "./exec-path"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A folder an agent could write, holding a program named as the engine is, and a real one on an absolute folder. */
function scene(): { research: string; bin: string; name: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chrn-path-")))
  dirs.push(dir)
  const research = join(dir, "research")
  const bin = join(dir, "bin")
  const name = "candle-test-engine"
  mkdirSync(research)
  mkdirSync(bin)
  mkdirSync(join(research, "sub"))
  for (const [folder, says] of [
    [research, "planted"],
    [join(research, "sub"), "planted"],
    [bin, "real 1.2.3"],
  ] as const) {
    writeFileSync(join(folder, name), `#!/bin/sh\necho '${says}'\n`)
    chmodSync(join(folder, name), 0o755)
  }
  return { research, bin, name }
}

test("relative entries are named and dropped; empty ones are neither", () => {
  expect(relativeEntries(".:/usr/bin::bin:/bin:../x")).toEqual([".", "bin", "../x"])
  expect(relativeEntries("/usr/bin:/bin:")).toEqual([])
  expect(relativeEntries(undefined)).toEqual([])
  expect(absolutePath(".:/usr/bin::bin:/bin")).toBe("/usr/bin:/bin")
  const env = { PATH: "/usr/bin:/bin", HOME: "/h" }
  expect(withAbsolutePath(env)).toBe(env)
  expect(withAbsolutePath({ PATH: ".:/bin" })).toEqual({ PATH: "/bin" })
})

test("a bare name resolves over the absolute entries only; a path with a slash never against the child's folder", () => {
  const s = scene()
  expect(resolveBin(s.name, `.:sub:${s.bin}`)).toBe(join(s.bin, s.name))
  // Not on any absolute entry: it comes back bare, and the spawn reports it missing.
  expect(resolveBin(s.name, ".:sub")).toBe(s.name)
  expect(resolveBin("/usr/bin/env", "")).toBe("/usr/bin/env")
  expect(resolveBin("./tool", "/bin")).toBe(join(process.cwd(), "tool"))
})

test("the environments a child gets carry no relative PATH entry", () => {
  expect(harnessEnv({ PATH: ".:/usr/bin:bin:/bin", HOME: "/h" })).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" })
  expect(allowEnv({ PATH: ".:/usr/bin:bin:/bin" }, { EXTRA: "1" })).toEqual({ PATH: "/usr/bin:/bin", EXTRA: "1" })
})

async function turnText(cmd: string[], cwd: string, env: Record<string, string>): Promise<EngineEvent[]> {
  const turn = runLines("Test", cmd, { cwd, env, parse: (line) => [{ type: "done", text: line }] })
  const out: EngineEvent[] = []
  for await (const e of turn.events) out.push(e)
  return out
}

test("an engine's turn runs the installed program, not one of its name in the agent's folder, whatever PATH says", async () => {
  const s = scene()
  // `.` and a relative folder come first, as a shell profile might leave them.
  expect(await turnText([s.name], s.research, { PATH: `.:sub:${s.bin}:/usr/bin:/bin` })).toEqual([{ type: "done", text: "real 1.2.3" }])
  // With the engine not installed at all, the planted one still doesn't run.
  const missing = await turnText([s.name], s.research, { PATH: ".:sub:/usr/bin:/bin" })
  expect(JSON.stringify(missing)).not.toContain("planted")
  expect(missing.at(-1)?.type).toBe("error")
})

test("reading an engine's version, and the Candle CLI's runs, hold the same way", async () => {
  const s = scene()
  const was = process.cwd()
  process.chdir(s.research)
  try {
    expect((await readVersion(s.name, [], { PATH: `.:${s.bin}:/usr/bin:/bin` })).out.trim()).toBe("real 1.2.3")
    expect((await readVersion(s.name, [], { PATH: ".:/usr/bin:/bin" })).missing).toBe(true)
  } finally {
    process.chdir(was)
  }
  const ran = await runChild({ cmd: s.name, args: [], env: { PATH: `.:${s.bin}:/usr/bin:/bin` }, cwd: s.research, timeoutMs: 5_000 })
  expect(ran.stdout.trim()).toBe("real 1.2.3")
  const absent = await runChild({ cmd: s.name, args: [], env: { PATH: ".:/usr/bin:/bin" }, cwd: s.research, timeoutMs: 5_000 })
  expect(absent.stdout).not.toContain("planted")
  expect(absent.exitCode).not.toBe(0)
  const child = spawnChild({ cmd: s.name, args: [], env: { PATH: `.:${s.bin}:/usr/bin:/bin` }, cwd: s.research })
  expect((await new Response(child.proc.stdout).text()).trim()).toBe("real 1.2.3")
  await child.proc.exited
})
