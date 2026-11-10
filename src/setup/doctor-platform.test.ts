// The doctor's lines about the machine it runs on: a core still on an older version, PATH entries that aren't
// full paths, running as root, and a harness on a newer major version than its holds were checked on; and the
// report repeating what isn't ok under its summary.
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore } from "../../test/core-fixture"
import { newerMajor } from "../engine/engine"
import { VERSION } from "../version"
import { type Check, coreVersionChecks, doctorReport, newerMajorChecks, pathChecks, rootChecks, runDoctor } from "./doctor"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => cleanupHomes())

test("a core on another version warns with how to restart it; the same version, or none read, says nothing", () => {
  expect(coreVersionChecks("0.5.1", "0.5.1")).toEqual([])
  expect(coreVersionChecks(undefined, "0.5.1")).toEqual([])
  const [check] = coreVersionChecks("0.5.0", "0.5.1")
  expect(check).toMatchObject({ area: "core", state: "warn" })
  expect(check!.text).toBe("the core that's running is still 0.5.0, and this is 0.5.1. It carries on as 0.5.0, with its triggers and bots, until it's restarted")
  expect(check!.fix).toContain("choose `restart it` in its status bar")
  expect(check!.fix).toContain("`candle-harness stop`, then open candle-harness again")
})

test("PATH entries that aren't full paths are named in one warning; a clean PATH says nothing", () => {
  expect(pathChecks("/usr/bin:/bin")).toEqual([])
  expect(pathChecks(undefined)).toEqual([])
  const [check, ...rest] = pathChecks(".:/usr/bin:node_modules/.bin:/bin")
  expect(rest).toEqual([])
  expect(check).toMatchObject({ area: "paths", state: "warn" })
  expect(check!.text).toStartWith("PATH has entries that aren't full paths (., node_modules/.bin)")
  expect(pathChecks(".:/bin")[0]!.text).toStartWith("PATH has an entry that isn't a full path (.)")
})

test("root on Linux warns once; any other user, and root's name on a Mac, says nothing", () => {
  expect(rootChecks(1000, "linux")).toEqual([])
  expect(rootChecks(undefined, "linux")).toEqual([])
  expect(rootChecks(0, "darwin")).toEqual([])
  const checks = rootChecks(0, "linux")
  expect(checks).toHaveLength(1)
  expect(checks[0]).toMatchObject({ area: "state", state: "warn" })
  expect(checks[0]!.text).toStartWith("the Candle Harness is running as root")
  expect(checks[0]!.fix).toContain("unprivileged user")
})

test("only a newer major version of a harness is said: a newer minor or patch, which ship weekly, never is", () => {
  expect(newerMajor("2.1.999", "2.1.321")).toBe(false)
  expect(newerMajor("2.9.0", "2.1.321")).toBe(false)
  expect(newerMajor("1.0.0", "2.1.321")).toBe(false)
  expect(newerMajor("3.0.0", "2.1.321")).toBe(true)
  expect(newerMajor("1.0.0", "0.165.0")).toBe(true)
  expect(newerMajor(undefined, "1.0.0")).toBe(false)
  expect(newerMajor("not a version", "1.0.0")).toBe(false)
  expect(newerMajorChecks("engine", "Codex", "0.170.2", "0.165.0")).toEqual([])
  const [check] = newerMajorChecks("engine", "Codex", "1.0.0", "0.165.0")
  expect(check).toMatchObject({ area: "engine", state: "warn", text: "Codex is 1.0.0, a newer major version than the one its holds were checked on (0.165.0)" })
  expect(check!.fix).toStartWith("Nothing is blocked.")
})

test("the report repeats what isn't ok under its summary, failures first; with nothing wrong it adds nothing", () => {
  const ok: Check = { area: "paths", state: "ok", text: "fine" }
  const warn: Check = { area: "engine", state: "warn", text: "a warning among many lines", fix: "do this" }
  const fail: Check = { area: "key", state: "fail", text: "a failure", fix: "fix that" }
  expect(doctorReport([ok, ok])).toBe("ok    paths   fine\nok    paths   fine\n\nAll checks passed.\n")
  const report = doctorReport([ok, warn, ok, fail, ok])
  const [full, tail] = report.split("\nTo look at:\n")
  expect(full).toEndWith("1 problem to fix and 1 warning. Fix the first, then run candle-harness doctor again.\n")
  expect(tail).toBe("FAIL  key     a failure\n              → fix that\nwarn  engine  a warning among many lines\n              → do this\n")
})

test("on a real home: a running core of another version, a relative PATH entry and root each show, once", async () => {
  const c = await startTestCore()
  cores.push(c)
  const env = { ...process.env, CANDLE_HARNESS_HOME: c.p.configDir, PATH: `.:${process.env.PATH ?? "/usr/bin:/bin"}` }
  const checks = await runDoctor({ env, online: false, uid: 0, platform: "linux", version: "999.0.0" })
  const texts = (start: string) => checks.filter((x) => x.state === "warn" && x.text.startsWith(start))
  expect(texts(`the core that's running is still ${VERSION}, and this is 999.0.0`)).toHaveLength(1)
  expect(texts("PATH has an entry that isn't a full path (.)")).toHaveLength(1)
  expect(texts("the Candle Harness is running as root")).toHaveLength(1)
  // The same doctor as this binary's own version and an ordinary user says none of the three.
  const plain = await runDoctor({ env: { ...env, PATH: process.env.PATH ?? "/usr/bin:/bin" }, online: false, uid: 1000, platform: "linux" })
  for (const start of ["the core that's running", "PATH has", "the Candle Harness is running as root"]) expect(plain.filter((x) => x.text.startsWith(start))).toEqual([])
}, 60_000)
