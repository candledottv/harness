// The core's usage totals: what the resource sampler reads once a minute.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { DOCTOR_CLIENT, SAMPLER_CLIENT } from "./client"
import { METHOD_ROLES } from "./server"
import { Usage, type UsageTotals } from "./usage"

afterAll(() => cleanupHomes())
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

describe("Usage", () => {
  test("adds calls, bytes, reads and frames, and hands back copies", () => {
    const u = new Usage(1_000)
    u.candleCall("momentum")
    u.candleCall("momentum", 4)
    u.candleBytes("momentum", 120)
    u.candleBytes("swing", 30)
    u.haccRead(500)
    u.haccRead(0)
    u.streamFrame(64)
    const t = u.totals()
    expect(t).toEqual({ since: 1_000, candle: { momentum: { calls: 5, bytes: 120 }, swing: { calls: 0, bytes: 30 } }, hacc: { requests: 2, bytes: 500 }, stream: { frames: 1, bytes: 64 } })
    t.candle.momentum!.calls = 99
    t.hacc.bytes = 0
    expect(u.totals().candle.momentum!.calls).toBe(5)
    expect(u.totals().hacc.bytes).toBe(500)
  })
})

describe("core.usage", () => {
  test("a view reads what the core fetched through each key, and what's live; a harness can't", async () => {
    const t = await startTestCore()
    cores.push(t)
    const view = await t.view()
    const before = (await view.request("core.usage")).result as UsageTotals & { at: number; reading: Record<string, unknown> }
    const read = await view.request("tools.call", { name: "candle_get_feed", args: { limit: 1 } })
    expect(read.error).toBeUndefined()
    const after = (await view.request("core.usage")).result as UsageTotals & { at: number; reading: Record<string, unknown> }
    const active = Object.keys(after.candle).find((a) => (after.candle[a]!.calls ?? 0) > (before.candle[a]?.calls ?? 0))
    expect(active).toBeDefined()
    expect(after.candle[active!]!.bytes).toBeGreaterThan(before.candle[active!]?.bytes ?? 0)
    expect(after.since).toBe(before.since)
    expect(after.at).toBeGreaterThanOrEqual(before.at)
    expect(after.reading).toMatchObject({ lists: expect.any(Array), stream: expect.any(String), pnlPerMin: expect.any(Number), research: expect.any(Number), budget: expect.any(Array) })
    // Totals only: no key, token or row.
    expect(JSON.stringify(after)).not.toMatch(/cndl_|token|mint/i)
    expect(METHOD_ROLES["core.usage"]).toEqual({ view: "yes", harness: "no" })
    const { client: harness } = await t.harness()
    expect((await harness.request("core.usage")).error?.data?.code).toBeDefined()
  }, 30_000)
})

describe("views that only read (the doctor, the sampler)", () => {
  test("attaching and leaving never marks a session's end", async () => {
    const t = await startTestCore()
    cores.push(t)
    const sessionEnd = () => (existsSync(t.p.pnlWindow) ? JSON.parse(readFileSync(t.p.pnlWindow, "utf8")).sessionEnd : undefined)
    const main = await t.view()
    for (const name of [SAMPLER_CLIENT, DOCTOR_CLIENT]) {
      const observer = await t.view(name)
      expect((await observer.request("core.usage")).error).toBeUndefined()
      observer.close()
    }
    await Bun.sleep(300)
    expect(sessionEnd()).toBeUndefined()
    // The person's view leaving does mark it.
    main.close()
    await until(() => sessionEnd() !== undefined)
  }, 30_000)

  test("with only the sampler attached, an idle core still stops", async () => {
    let stopped: string | undefined
    const t = await startTestCore({ headless: false, idleExitMs: 300, idleTickMs: 50, onStopped: (why) => (stopped = why) })
    cores.push(t)
    const observer = await t.view(SAMPLER_CLIENT)
    expect((await observer.request("core.usage")).error).toBeUndefined()
    await until(() => stopped !== undefined, 5_000)
    expect(stopped).toBe("idle")
  }, 30_000)
})
