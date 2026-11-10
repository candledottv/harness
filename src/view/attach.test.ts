// Attaching a view: to the core that's running, or to one it starts (`core --exit-when-idle`).
import { afterAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, testHome, until } from "../../test/core-fixture"
import type { CoreEventParams } from "../core/client"
import { pidIsAlive } from "../shared/lock"
import { attachView, coreLogPath } from "./attach"

afterAll(cleanupHomes)
const MAIN = join(import.meta.dir, "../main.ts")

test("with no core running, the view starts one in its own process group, and attaches", async () => {
  const { home, p } = await testHome()
  const env = { ...process.env, CANDLE_HARNESS_HOME: home }
  const { session, started } = await attachView({ paths: p, self: [process.execPath, MAIN], env, timeoutMs: 20_000 })
  const events: CoreEventParams[] = []
  session.onEvent((e) => events.push(e))
  try {
    expect(started).toBe(true)
    const status = await session.request<{ headless: boolean; agents: { name: string }[] }>("core.status")
    // Started by a view: it exits when idle, unlike `candle-harness core` run by hand.
    expect(status.headless).toBe(false)
    expect(status.agents.map((a) => a.name)).toEqual(["momentum", "swing"])
  } finally {
    session.close()
    const pid = (JSON.parse(readFileSync(p.lock, "utf8")) as { pid: number }).pid
    process.kill(pid, "SIGTERM")
    await until(() => !pidIsAlive(pid), 10_000)
    expect(readFileSync(coreLogPath(p), "utf8")).toContain("listening at")
  }
}, 30_000)

test("with a core running, the view attaches to it and starts nothing", async () => {
  const c = await startTestCore()
  try {
    const { session, started } = await attachView({ paths: c.p, self: ["/nonexistent/candle-harness"], env: process.env })
    expect(started).toBe(false)
    // The snapshots answer the subscribe before the frame mounts: a listener added later still gets them.
    await Bun.sleep(100)
    const events: CoreEventParams[] = []
    session.onEvent((e) => events.push(e))
    expect(events.filter((e) => e.snapshot).map((e) => e.topic).sort()).toEqual(["activity", "agent", "autonomy", "away", "bots", "cards", "engine", "hacc", "market", "memory", "notices", "onboarding", "operations", "portfolio", "skills", "status", "triggers", "views", "wallets"])
    session.close()
  } finally {
    await c.close()
  }
})
