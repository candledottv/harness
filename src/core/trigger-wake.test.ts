// A wake's caps, with the runner faked: what counts toward them, and when.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { resolveTrigger } from "../shared/trigger-grammar"
import { Journal } from "./journal"
import { Waker } from "./trigger-wake"
import type { TriggerEntry } from "./triggers-file"

const T0 = new Date(2026, 10, 4, 12, 0, 0).getTime()
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function rig(caps = { perHour: 4, perDay: 24 }) {
  const dir = mkdtempSync(join(tmpdir(), "chrn-wake-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => T0 })
  journals.push(journal)
  const started: string[] = []
  // The agent is idle: each wake starts a turn of its own, which runs at once, so none is left waiting to join.
  const runner = {
    wake: (_agent: string, wake: { fireId: string }) => {
      started.push(wake.fireId)
      return { turnId: `t_${started.length}`, queued: false, joined: false }
    },
    wakeWaiting: () => false,
  }
  const make = () => new Waker({ journal, mode: () => "live", now: () => T0, runner, caps: () => caps, paused: () => false })
  const entry = (name: string): { t: TriggerEntry; r: NonNullable<ReturnType<typeof resolved>> } => {
    const line = "on call wake agent-a"
    const r = resolved(line)!
    return { t: { name, agent: "agent-a", line, expansion: r.expansion, on: true, again: false }, r }
  }
  return { journal, started, make, entry }
}

const resolved = (line: string) => {
  const r = resolveTrigger(line, { agents: ["agent-a"], knownTokens: new Map(), mode: "live", proposer: "agent-a" })
  return r.ok ? r.value : undefined
}

test("two triggers firing together at one wake under the cap: one wakes, the other is skipped", async () => {
  const w = await rig()
  const waker = w.make()
  for (const n of [1, 2, 3]) {
    const { t, r } = w.entry(`first-${n}`)
    await waker.wake(t, r, { by: "call", clientId: "c" }, `fire_${n}`)
  }
  expect(waker.used("agent-a")).toEqual({ hour: 3, day: 3 })
  const a = w.entry("a")
  const b = w.entry("b")
  // Started together, as two firings of one heartbeat are: neither waits for the other's row.
  const ends = await Promise.all([waker.wake(a.t, a.r, { by: "call", clientId: "c" }, "fire_a"), waker.wake(b.t, b.r, { by: "call", clientId: "c" }, "fire_b")])
  expect(ends.map((e) => e.kind)).toEqual(["woke", "skipped"])
  expect(w.started).toEqual(["fire_1", "fire_2", "fire_3", "fire_a"])
  expect(waker.used("agent-a")).toEqual({ hour: 4, day: 4 })
})

test("a wake is counted once: as it starts, not again from its row, and the same after a restart", async () => {
  const w = await rig()
  const waker = w.make()
  const { t, r } = w.entry("one")
  await waker.wake(t, r, { by: "call", clientId: "c" }, "fire_1")
  expect(waker.used("agent-a")).toEqual({ hour: 1, day: 1 })
  expect(w.make().used("agent-a")).toEqual({ hour: 1, day: 1 })
})
