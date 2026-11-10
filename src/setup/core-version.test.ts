// A core keeps the version it started as: what reads the running core's version, and what's said when it
// isn't this binary's.
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, testHome } from "../../test/core-fixture"
import { main } from "../main"
import { VERSION } from "../version"
import { runningCoreVersion, staleCoreWords } from "./core-version"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => cleanupHomes())

test("a running core answers with its version", async () => {
  const c = await startTestCore()
  cores.push(c)
  expect(await runningCoreVersion({ CANDLE_HARNESS_HOME: c.p.configDir })).toBe(VERSION)
})

test("no core, or a home that isn't there: nothing, and nothing is started", async () => {
  const { home } = await testHome()
  expect(await runningCoreVersion({ CANDLE_HARNESS_HOME: home })).toBeUndefined()
  expect(await runningCoreVersion({ CANDLE_HARNESS_HOME: "/nonexistent/candle-test/home" })).toBeUndefined()
})

test("`version --core` prints one line the installer can read, and nothing with no core", async () => {
  const c = await startTestCore()
  cores.push(c)
  const run = async (home: string) => {
    const was = process.env.CANDLE_HARNESS_HOME
    process.env.CANDLE_HARNESS_HOME = home
    const out: string[] = []
    try {
      expect(await main(["version", "--core"], { out: (t) => void out.push(t), err: () => {} })).toBe(0)
    } finally {
      if (was === undefined) delete process.env.CANDLE_HARNESS_HOME
      else process.env.CANDLE_HARNESS_HOME = was
    }
    return out.join("")
  }
  expect(await run(c.p.configDir)).toBe(`core ${VERSION}\n`)
  expect(await run((await testHome()).home)).toBe("")
})

test("words only when the running core is another version", () => {
  expect(staleCoreWords(undefined, "0.5.1")).toBeUndefined()
  expect(staleCoreWords("0.5.1", "0.5.1")).toBeUndefined()
  expect(staleCoreWords("0.5.0", "0.5.1")).toBe("The core that's running is still 0.5.0, and this is 0.5.1. It carries on as 0.5.0, with its triggers and bots, until it's restarted.")
})
