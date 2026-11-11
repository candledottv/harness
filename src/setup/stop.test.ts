// `candle-harness stop` by the lock's pid, for a core that can't be asked: only a pid that's a Candle Harness core is
// signalled, it's waited for, and one that doesn't go says how to end it. Asking a running core is in
// core/kept-running-core.test.ts.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, testHome } from "../../test/core-fixture"
import { systemdUnitText, SYSTEMD_UNIT } from "./service"
import { isCoreCommand, stopCommand } from "./stop"
import { paths } from "../paths"

afterAll(() => cleanupHomes())
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { text: () => out.join(""), errors: () => err.join(""), io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } }
}

test("a core's command line, compiled or from source; anything else isn't", () => {
  expect(isCoreCommand("/usr/local/bin/candle-harness core --exit-when-idle")).toBe(true)
  expect(isCoreCommand("/opt/candle/bin/candle-harness core --service")).toBe(true)
  expect(isCoreCommand("/usr/local/bin/candle-harness-darwin-arm64 core")).toBe(true)
  expect(isCoreCommand("/opt/bun/bin/bun /srv/app/src/main.ts core --exit-when-idle")).toBe(true)
  expect(isCoreCommand("/usr/local/bin/candle-harness view")).toBe(false)
  expect(isCoreCommand("/usr/bin/python3 server.py core")).toBe(false)
  expect(isCoreCommand("core")).toBe(false)
})

async function lockedHome(pid: number) {
  const { home, p } = await testHome()
  writeFileSync(p.lock, `${JSON.stringify({ pid, startedAt: new Date().toISOString(), id: "x" })}\n`)
  return { home, env: { ...process.env, CANDLE_HARNESS_HOME: home } }
}

test("no answer on the socket: the lock's pid, checked to be a core, gets SIGTERM and is waited for", async () => {
  const { env } = await lockedHome(4242)
  let alive = true
  const signals: string[] = []
  const t = io()
  const code = await stopCommand([], t.io, { env, platform: "linux", home: "/nonexistent/home", isAlive: () => alive, commandOf: () => "/usr/local/bin/candle-harness core --exit-when-idle", kill: (pid, s) => ((signals.push(`${pid} ${s}`), (alive = false)), undefined), waitMs: 1_000 })
  expect(code).toBe(0)
  expect(signals).toEqual(["4242 SIGTERM"])
  expect(t.text()).toStartWith("Stopped the Candle Harness core (pid 4242). It didn't answer, so it was signalled")
})

test("a pid that isn't a Candle Harness core is never signalled; a dead one means no core", async () => {
  const { env } = await lockedHome(4243)
  const signals: string[] = []
  const t = io()
  expect(await stopCommand([], t.io, { env, platform: "linux", home: "/nonexistent/home", isAlive: () => true, commandOf: () => "/usr/sbin/sshd -D", kill: (pid, s) => void signals.push(`${pid} ${s}`) })).toBe(1)
  expect(signals).toEqual([])
  expect(t.errors()).toContain("names pid 4243, which is `/usr/sbin/sshd -D`, not a Candle Harness core, so nothing was stopped")

  const dead = io()
  expect(await stopCommand([], dead.io, { env, platform: "linux", home: "/nonexistent/home", isAlive: () => false })).toBe(0)
  expect(dead.text()).toBe("No Candle Harness core is running.\n")
})

test("one still running after the wait says how to end it", async () => {
  const { env } = await lockedHome(4244)
  const t = io()
  expect(await stopCommand([], t.io, { env, platform: "linux", home: "/nonexistent/home", isAlive: () => true, commandOf: () => "candle-harness core", kill: () => {}, waitMs: 200 })).toBe(1)
  expect(t.errors()).toContain("`kill -9 4244` ends it at once")
})

test("stop takes no arguments", async () => {
  expect(await stopCommand(["now"], io().io, { env: process.env, platform: "linux", home: "/nonexistent/home" })).toBe(2)
})

test("the login service's note is said only when the service runs the home being stopped", async () => {
  const user = mkdtempSync("/tmp/chrn-u-")
  const units = join(user, ".config", "systemd", "user")
  mkdirSync(units, { recursive: true })
  const serviced = await lockedHome(4245)
  writeFileSync(join(units, SYSTEMD_UNIT), systemdUnitText(["/usr/local/bin/candle-harness"], paths(serviced.env), serviced.env))
  const run = async (env: Record<string, string | undefined>) => {
    const t = io()
    let alive = true
    await stopCommand([], t.io, { env: { ...env, XDG_CONFIG_HOME: undefined }, platform: "linux", home: user, isAlive: () => alive, commandOf: () => "candle-harness core", kill: () => void (alive = false), waitMs: 500 })
    return t.text()
  }
  expect(await run(serviced.env)).toContain("The login service starts a core again at your next login")
  // A scratch home's core: the service runs another home, so it isn't mentioned.
  const scratch = await lockedHome(4246)
  expect(await run(scratch.env)).not.toContain("login service")
})

