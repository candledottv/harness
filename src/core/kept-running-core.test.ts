// Kept running, on a real core: a trigger that's on holds a view-started core past its idle time and one switched
// off lets it go; the status says how many are on and what holds the core; keep-awake starts caffeinate with the
// first trigger and ends it with the last; and `candle-harness stop`, from a second terminal, ends the core saying
// what it stopped.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testHome, until } from "../../test/core-fixture"
import { stopCommand } from "../setup/stop"
import { candleConfigDir } from "./candle-mcp"
import type { Caffeinated } from "./keep-awake"

const MOON = "MoonFake11111111111111111111111111111111111"
const STOP = `when ${MOON} < $0.40 sell 50% of ${MOON}`
const NAME = "Moon…1111 < $0.40"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())

async function save(c: TestCore, line: string) {
  const check = c.core.triggers.check(line, "momentum")
  return c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })
}

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } }
}

test("a trigger that's on holds a view-started core past its idle time; switched off, the core goes", async () => {
  let stopped: string | undefined
  const c = await startTestCore({ headless: false, idleExitMs: 300, idleTickMs: 25, onStopped: (r) => (stopped = r) })
  cores.push(c)
  await save(c, STOP)
  const view = await c.view()
  const status = (await view.request("core.status", {})).result as { triggersOn: number; holds: string[]; headless: boolean; pid: number }
  expect(status).toMatchObject({ triggersOn: 1, headless: false, pid: process.pid })
  expect(status.holds).toEqual(["1 trigger on", "1 view attached"])
  view.close()
  await Bun.sleep(800)
  expect(stopped).toBeUndefined()

  await c.core.triggers.set(NAME, false, { clientId: "test", main: true })
  await until(() => stopped !== undefined, 3000)
  expect(stopped).toBe("idle")
})

test("a trigger a Free plan holds doesn't hold the core: nothing reads or fires there", async () => {
  let stopped: string | undefined
  let now = Date.now()
  const c = await startTestCore({ headless: false, idleExitMs: 300, idleTickMs: 25, now: () => now, onStopped: (r) => (stopped = r) })
  cores.push(c)
  await save(c, STOP)
  const view = await c.view()
  view.close()
  // The plan ends with the trigger on: held, and kept as it is.
  for (const agent of ["momentum", "swing"]) {
    const folder = candleConfigDir(c.p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify({ tier: "free" }))
  }
  now += 5 * 60_000
  await c.core.plans.refresh()
  // The idle rule reads the same clock.
  const ticking = setInterval(() => (now += 100), 25)
  await until(() => stopped !== undefined, 3000).finally(() => clearInterval(ticking))
  expect(c.core.triggers.entries().map((t) => [t.name, t.on])).toEqual([[NAME, true]])
  expect(c.core.triggers.keepingUp()).toEqual([])
})

test("keep-awake: caffeinate -w the core's pid starts with the first trigger on and ends with the last, and with the core", async () => {
  const runs: { argv: string[]; killed: boolean }[] = []
  const caffeinate = (argv: string[]): Caffeinated => {
    const run = { argv, killed: false }
    runs.push(run)
    let end!: (code: number | null) => void
    const exited = new Promise<number | null>((resolve) => (end = resolve))
    return {
      kill: () => {
        run.killed = true
        end(null)
      },
      exited,
    }
  }
  const c = await startTestCore({ idleTickMs: 25, caffeinate }, { before: (p) => writeFileSync(`${p.stateDir}/keep-awake.json`, `${JSON.stringify({ on: true })}\n`) })
  cores.push(c)
  if (process.platform !== "darwin") {
    // macOS only: elsewhere it never runs, whatever the setting says.
    await save(c, STOP)
    await Bun.sleep(100)
    expect(runs).toEqual([])
    const view = await c.view()
    expect(((await view.request("core.status", {})).result as { keepAwake: unknown }).keepAwake).toEqual({ on: true, available: false, active: false })
    expect((await view.request("core.keepAwake", { on: true })).error?.data?.code).toBe("NOT_MACOS")
    return
  }
  await Bun.sleep(100)
  expect(runs).toEqual([])
  await save(c, STOP)
  await until(() => runs.length === 1)
  expect(runs[0]!.argv).toEqual(["caffeinate", "-i", "-w", String(process.pid)])
  await c.core.triggers.set(NAME, false, { clientId: "test", main: true })
  await until(() => runs[0]!.killed)
  await c.core.triggers.set(NAME, true, { clientId: "test", main: true })
  await until(() => runs.length === 2)
  await c.close()
  cores.length = 0
  expect(runs[1]!.killed).toBe(true)
})

test("candle-harness stop, from a second terminal: the core answers with what it stops, and stops", async () => {
  let stopped: string | undefined
  const c = await startTestCore({ onStopped: (r) => (stopped = r) })
  cores.push(c)
  await save(c, STOP)
  const view = await c.view()
  const t = io()
  const code = await stopCommand([], t.io, { env: { ...process.env, CANDLE_HARNESS_HOME: c.p.configDir }, platform: "linux", home: "/nonexistent/home" })
  expect(t.err).toEqual([])
  expect(code).toBe(0)
  expect(stopped).toBe("candle-harness stop")
  expect(t.out.join("")).toBe(
    [
      `Stopped the Candle Harness core (pid ${process.pid}).`,
      "  · 1 trigger stopped watching; it starts again with the next core",
      "  · 1 open view lost its core: quit it and start the Candle Harness again",
      "",
    ].join("\n"),
  )
  expect(c.core.journal.rows().filter((r) => r.type === "core.stopped").map((r) => r.reason)).toEqual(["candle-harness stop"])
  view.close()
})

test("candle-harness stop with no core running says so; a harness can't stop the core", async () => {
  const { home } = await testHome()
  const t = io()
  expect(await stopCommand([], t.io, { env: { ...process.env, CANDLE_HARNESS_HOME: home }, platform: "linux", home: "/nonexistent/home" })).toBe(0)
  expect(t.out).toEqual(["No Candle Harness core is running.\n"])

  const c = await startTestCore()
  cores.push(c)
  const { client } = await c.harness()
  expect((await client.request("core.stop", {})).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
  expect((await client.request("core.keepAwake", { on: true })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
})
