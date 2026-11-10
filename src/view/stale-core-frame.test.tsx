// A core keeps the version it started as. After an update, one that a trigger, a bot or the login service
// held open is still the old version: the status bar says so until it's restarted, and its chip restarts it.
import { afterAll, afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { join } from "node:path"
import { act } from "react"
import { cleanupHomes, testHome, until } from "../../test/core-fixture"
import { SceneSession, status } from "../../test/frame-scenes"
import { ViewSession } from "../core/client"
import { pidIsAlive } from "../shared/lock"
import { VERSION } from "../version"
import { App } from "./app"
import { attachView, restartCore } from "./attach"
import { staleCoreVersion } from "./status-bar"

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})
afterAll(cleanupHomes)

class VersionedSession extends SceneSession {
  version: string | undefined
  coreVersion(): string | undefined {
    return this.version
  }
}

async function draw(session: VersionedSession, restart?: () => Promise<void>, width = 140): Promise<() => string> {
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => 1_800_000_000_000} tickMs={0} {...(restart ? { restartCore: restart } : {})} />, { width, height: 40, exitOnCtrlC: false })
  await setup.renderOnce()
  await act(async () => session.push("status", status, true))
  await setup.renderOnce()
  return () => setup!.captureCharFrame().split("\n")[0]!
}

test("only a core of another version is named", () => {
  expect(staleCoreVersion(undefined, "0.5.1")).toBeUndefined()
  expect(staleCoreVersion("0.5.1", "0.5.1")).toBeUndefined()
  expect(staleCoreVersion("0.5.0", "0.5.1")).toBe("0.5.0")
})

test("a core on this version, or one whose version isn't known, puts nothing on the status bar", async () => {
  const session = new VersionedSession()
  session.version = VERSION
  const top = await draw(session, async () => {})
  expect(top()).not.toContain("the core is still")
  expect(top()).not.toContain("restart it")
  await act(async () => {
    session.version = undefined
    session.push("status", status, true)
  })
  await setup!.renderOnce()
  expect(top()).not.toContain("the core is still")
})

test("a core still on an older version is said on the status bar, with a chip that restarts it once", async () => {
  const session = new VersionedSession()
  session.version = "0.0.1"
  let restarts = 0
  let done = () => {}
  const top = await draw(session, () => {
    restarts++
    return new Promise<void>((r) => (done = r))
  })
  expect(top()).toContain("the core is still 0.0.1")
  expect(top()).toContain("restart it")
  // The kill switch keeps its place beside it.
  expect(top()).toContain("ctrl-x ×2 kill")
  const x = top().indexOf("restart it")
  await act(async () => setup!.mockMouse.click(x + 2, 0))
  await act(async () => setup!.mockMouse.click(x + 2, 0))
  await setup!.renderOnce()
  // A second click while the first restart runs starts nothing more.
  expect(restarts).toBe(1)
  done()
  // The new core's hello carries this version: the notice goes.
  await act(async () => {
    session.version = VERSION
    session.push("status", status, true)
  })
  await setup!.renderOnce()
  expect(top()).not.toContain("the core is still")
})

test("at 80 columns the notice and its chip still fit beside the agent, the mode and the kill switch", async () => {
  const session = new VersionedSession()
  session.version = "0.0.1"
  const top = await draw(session, async () => {}, 80)
  for (const s of ["the core is still 0.0.1", "restart it", "ctrl-x ×2 kill"]) expect(top()).toContain(s)
})

test("the restart stops the running core and starts this binary's, and the view's session finds it", async () => {
  const MAIN = join(import.meta.dir, "../main.ts")
  const { home, p } = await testHome()
  const env = { ...process.env, CANDLE_HARNESS_HOME: home }
  const self = [process.execPath, MAIN]
  const { session } = await attachView({ paths: p, self, env, timeoutMs: 20_000 })
  const pidOf = async () => (await session.request<{ pid?: number }>("core.status").catch(() => ({ pid: undefined }))).pid
  let second: number | undefined
  try {
    expect((session as ViewSession).coreVersion()).toBe(VERSION)
    const first = (await pidOf())!
    await restartCore({ paths: p, self, env, request: (m, params) => session.request(m, params) })
    await until(() => !pidIsAlive(first), 15_000)
    // The session reattaches by itself to the core just started.
    for (let i = 0; i < 200 && (second === undefined || second === first); i++) {
      await Bun.sleep(100)
      second = await pidOf()
    }
    expect(second).toBeGreaterThan(0)
    expect(second).not.toBe(first)
    expect((session as ViewSession).coreVersion()).toBe(VERSION)
  } finally {
    session.close()
    if (second) {
      process.kill(second, "SIGTERM")
      await until(() => !pidIsAlive(second!), 10_000)
    }
  }
}, 60_000)
