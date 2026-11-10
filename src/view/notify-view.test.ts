// The view's notifier: never while the person is looking, the mode the core sends, each kind falling back to the
// next, the core stopping when nobody asked (and not when someone did); and, through a real core, a trigger's
// notice reaching the main view's session and sent while its terminal is in the background.
import { afterAll, afterEach, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { ViewSession } from "../core/client"
import { noticeOf } from "../shared/notify"
import { VIEW_TOPICS } from "./attach"
import { CORE_LOST_WORDS, LOOKING_MS, ViewNotifier } from "./notify-view"

function notifier(o: { remote?: boolean; native?: number; osc?: boolean; platform?: string } = {}) {
  const calls: string[] = []
  let now = 1_000_000
  const n = new ViewNotifier({
    env: {},
    platform: o.platform ?? "darwin",
    now: () => now,
    spawn: async (argv) => (calls.push(`native ${argv.at(-2)} | ${argv.at(-1)}`), { exitCode: o.native ?? 0 }),
    osc: (title, body) => (calls.push(`osc ${title} | ${body}`), o.osc ?? true),
    bell: () => calls.push("bell"),
    remote: o.remote ?? false,
  })
  return { n, calls, tick: (ms: number) => (now += ms) }
}
const notice = { notice: noticeOf("triggers", 'trigger "dip": MOON is down') }

test("never while the terminal is focused; sent once it isn't", async () => {
  const t = notifier()
  t.n.focus(true)
  await t.n.event(notice)
  expect(t.calls).toEqual([])
  t.n.focus(false)
  await t.n.event(notice)
  expect(t.calls).toEqual(['native Candle Harness · trigger | trigger "dip": MOON is down'])
})

test("where the terminal reports no focus, a key in the last minute counts as looking", async () => {
  const t = notifier()
  t.n.input()
  await t.n.event(notice)
  expect(t.calls).toEqual([])
  t.tick(LOOKING_MS)
  await t.n.event(notice)
  expect(t.calls).toHaveLength(1)
  // A focus report always wins over the guess.
  t.n.input()
  t.n.focus(false)
  await t.n.event(notice)
  expect(t.calls).toHaveLength(2)
})

test("a key after the last blur means the window is in front again: not sent, while the key is recent", async () => {
  const t = notifier()
  t.n.focus(false)
  t.tick(2_000)
  t.n.input()
  t.tick(5_000)
  await t.n.event(notice)
  expect(t.calls).toEqual([])
  t.tick(LOOKING_MS)
  await t.n.event(notice)
  expect(t.calls).toHaveLength(1)
})

test("auto: the computer's own locally, the terminal's over SSH; each falls back to the next, then the bell", async () => {
  const local = notifier()
  await local.n.event(notice)
  expect(local.calls[0]).toStartWith("native ")
  const ssh = notifier({ remote: true })
  await ssh.n.event(notice)
  expect(ssh.calls).toEqual(['osc Candle Harness · trigger | trigger "dip": MOON is down'])
  const failing = notifier({ native: 1, osc: false })
  await failing.n.event(notice)
  expect(failing.calls.map((c) => c.split(" ")[0])).toEqual(["native", "osc", "bell"])
  expect(failing.n.sent.at(-1)?.via).toBe("bell")
  // A machine with no OS notification goes straight to the terminal's.
  const other = notifier({ platform: "freebsd" })
  await other.n.event(notice)
  expect(other.calls.map((c) => c.split(" ")[0])).toEqual(["osc"])
})

test("the mode the core sends: bell rings, osc sends the terminal's, off sends nothing", async () => {
  for (const [mode, first] of [["bell", "bell"], ["osc", "osc"], ["native", "native"]] as const) {
    const t = notifier({ remote: true })
    await t.n.event({ settings: { mode, on: ["triggers"] } })
    await t.n.event(notice)
    expect(t.calls[0]!.split(" ")[0]).toBe(first)
  }
  const off = notifier()
  await off.n.event({ settings: { mode: "off", on: ["triggers"] } })
  await off.n.event(notice)
  expect(off.calls).toEqual([])
})

test("the core stopping when nobody asked is told; a planned stop isn't, until the view is attached again", async () => {
  const t = notifier()
  await t.n.lost()
  expect(t.calls).toEqual([`native Candle Harness · the core stopped | ${CORE_LOST_WORDS}`])
  t.calls.length = 0
  await t.n.event({ stopping: "candle-harness stop" })
  await t.n.lost()
  expect(t.calls).toEqual([])
  t.n.attached()
  await t.n.lost()
  expect(t.calls).toHaveLength(1)
  // `[notify] on` without "core" leaves it out.
  const quiet = notifier()
  await quiet.n.event({ settings: { mode: "auto", on: ["cards"] } })
  await quiet.n.lost()
  expect(quiet.calls).toEqual([])
})

const cores: TestCore[] = []
const sessions: ViewSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close()
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

test("through a real core: a trigger's notice reaches the main view's session, sent while in the background; a planned stop isn't told", async () => {
  const c = await startTestCore({ env: process.env, notify: { native: true, quietMs: 20, spawn: async () => ({ exitCode: 0, stderr: "" }) } })
  cores.push(c)
  const session = new ViewSession({ socketPath: c.p.socket, viewTokenPath: c.p.viewToken, clientName: "candle-harness view", topics: VIEW_TOPICS })
  sessions.push(session)
  const t = notifier()
  session.onLiveEvent((e) => {
    if (e.topic === "notices") void t.n.event(e.data)
  })
  session.onLost(() => void t.n.lost())
  await session.start()
  t.n.focus(false)
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  const line = `on call notify "MOON is moving" as "watch"`
  const { name } = await c.core.triggers.save(line, "momentum", { expansion: c.core.triggers.check(line, "momentum").trigger.expansion })
  await c.core.triggers.fire(name, { clientId: "test" })
  await until(() => t.calls.length === 1)
  expect(t.calls).toEqual(['native Candle Harness · trigger | trigger "watch": MOON is moving'])
  await c.core.stop("candle-harness stop")
  await Bun.sleep(100)
  expect(t.calls).toHaveLength(1)
})
