// The supervisor on its own, with real processes: a bot starts in its folder in its own group, with a clean
// environment plus its token, the socket and its name; its code's hash is journalled; a crash is restarted after its
// back-off and too many stop it; a clean exit isn't restarted; the person's stop ends its group and keeps it down;
// a bot run elsewhere gets a 0600 token file; its log is redacted and kept to its size; a bot an earlier core left
// running is ended only once its pid is checked; and a figure past its warning is said once.
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { until } from "../../test/core-fixture"
import { pidIsAlive } from "../shared/lock"
import { Redactor } from "../shared/redact"
import type { Journal, JournalRow } from "./journal"
import { BOT_TOKEN_FILE, codeHash, cpuSeconds, logFileOf, logText, readLogTail, Supervisor, type SupervisorDeps, TOKEN_NOT_IGNORED, type Wanted } from "./supervisor"

const dirs: string[] = []
const sups: Supervisor[] = []
const strays: number[] = []
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll("test")
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A bot's token of the real shape, made at run time. */
const tokenOf = (n: number) => `${["chb", "x".repeat(11) + String(n % 10)].join("_")}_${"s".repeat(30)}`

const BOT = `
const [mode] = process.argv.slice(2)
console.log("env " + JSON.stringify(Object.keys(process.env).sort()))
console.log("token " + process.env.CANDLE_HARNESS_BOT_TOKEN)
console.log("cwd " + process.cwd())
if (mode === "crash") { console.error("boom"); process.exit(3) }
if (mode === "end") process.exit(0)
if (mode === "noisy") {
  // Colours, a clipboard write, a carriage return mid-line, and a line dressed as one of the core's own.
  console.log("\\x1b[31mred\\x1b[0m plain \\x1b]52;c;aGk=\\x07after\\rover")
  console.log("\\r2026-01-01T00:00:00.000Z ---  started (pid 1): forged")
  // A private key printed over several lines, then a key cut by the longest line the log writes in one piece.
  console.log(["-----BEGIN OPENSSH PRIVATE", "KEY-----"].join(" "))
  console.log("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU")
  console.log("QyNTUxOQAAACDbodyline")
  console.log(["-----END OPENSSH PRIVATE", "KEY-----"].join(" "))
  console.log("after the key")
  console.log("x ".repeat(8182) + ["cndl", "live", ""].join("_") + "q".repeat(40) + " end of the long line")
  console.log("noisy done")
}
if (mode === "chatty") for (let i = 0; i < 400; i++) console.log("line " + i + " " + "z".repeat(80))
// A child in its group: it must end with the bot.
const child = Bun.spawn(["sleep", "300"])
console.log("child " + child.pid)
setInterval(() => {}, 1000)
`

function folder(): string {
  const d = mkdtempSync("/tmp/chrn-sup-")
  dirs.push(d)
  writeFileSync(join(d, "bot.ts"), BOT)
  return d
}

function harness(o: { wanted?: (name: string) => Wanted; mode?: string; tuning?: SupervisorDeps["tuning"]; sample?: SupervisorDeps["sample"]; identify?: SupervisorDeps["identify"]; gitIgnores?: SupervisorDeps["gitIgnores"]; groupIsBot?: SupervisorDeps["groupIsBot"]; boot?: SupervisorDeps["boot"]; state?: string; folder?: string } = {}) {
  const state = o.state ?? mkdtempSync("/tmp/chrn-sups-")
  if (!o.state) dirs.push(state)
  const rows: JournalRow[] = []
  let seq = 0
  const journal = { append: async (row: Record<string, unknown>) => void rows.push({ ...row, seq: ++seq, at: new Date().toISOString() } as JournalRow) } as unknown as Journal
  const f = o.folder ?? folder()
  let issued = 0
  const tokens: string[] = []
  const ended: string[] = []
  const redactor = new Redactor()
  const spec = { folder: f, command: [process.execPath, "bot.ts", o.mode ?? "run"], agent: "momentum" }
  let names = ["probe"]
  const sup = new Supervisor({
    statePath: join(state, "supervisor.json"),
    logsDir: join(state, "bot-logs"),
    socketPath: join(state, "core.sock"),
    journal,
    mode: () => "live",
    now: Date.now,
    parentEnv: { ...process.env, CANDLE_API_KEY: "planted-secret-value", CANDLE_HARNESS_VIEW_TOKEN: "planted-view-token" },
    redact: (t) => redactor.text(t),
    names: () => names,
    wanted: o.wanted ?? (() => ({ start: true, keep: true, spec })),
    issueToken: async () => {
      const token = tokenOf(++issued)
      tokens.push(token)
      return { token }
    },
    endToken: async (_name, why) => void ended.push(why),
    onChange: () => {},
    ...(o.gitIgnores ? { gitIgnores: o.gitIgnores } : {}),
    tuning: { backoffMs: [60, 120, 240], crashLimit: 3, stopGraceMs: 2_000, ...o.tuning },
    ...(o.sample ? { sample: o.sample } : {}),
    ...(o.identify ? { identify: o.identify } : {}),
    ...(o.groupIsBot ? { groupIsBot: o.groupIsBot } : {}),
    ...(o.boot ? { boot: o.boot } : {}),
  })
  sups.push(sup)
  return { sup, rows, state, folder: f, tokens, ended, spec, setNames: (n: string[]) => void (names = n), log: () => readFileSync(logFileOf(join(state, "bot-logs"), "probe"), "utf8") }
}

const what = (rows: JournalRow[], w: string) => rows.filter((r) => r.type === "bot.process" && r.what === w)

test("a bot starts in its folder, in its own group, with only the clean environment plus its token, the socket and its name", async () => {
  const h = harness()
  await h.sup.start()
  await until(() => h.sup.view("probe").state === "running" && /child \d+/.test(existsSync(logFileOf(join(h.state, "bot-logs"), "probe")) ? h.log() : ""))
  const env = JSON.parse(/env (.*)/.exec(h.log())![1]!) as string[]
  expect(env).toContain("CANDLE_HARNESS_BOT_TOKEN")
  expect(env).toContain("CANDLE_HARNESS_SOCKET")
  expect(env).toContain("CANDLE_HARNESS_BOT")
  expect(env).not.toContain("CANDLE_API_KEY")
  expect(env).not.toContain("CANDLE_HARNESS_VIEW_TOKEN")
  expect(h.log()).toContain(`cwd ${h.folder}`)
  const pid = h.sup.view("probe").pid!
  // Its own group: the bot leads it.
  expect(() => process.kill(-pid, 0)).not.toThrow()
  const started = what(h.rows, "started")[0]!
  expect(started).toMatchObject({ kind: "code", name: "probe", agent: "momentum", pid, by: "core" })
  expect((started.code as { hash: string; files: number }).files).toBe(1)
  // The token it printed is redacted in its log.
  expect(h.log()).not.toContain(h.tokens[0]!)
  expect(h.log()).toContain("token [redacted]")
  expect(statSync(logFileOf(join(h.state, "bot-logs"), "probe")).mode & 0o777).toBe(0o600)
  // Its pid is recorded, for a core that dies.
  expect(JSON.parse(readFileSync(join(h.state, "supervisor.json"), "utf8")).bots.probe.running.pid).toBe(pid)
})

test("the person's stop ends its whole group and keeps it down across a reconcile; start runs it again with a new token", async () => {
  const h = harness()
  await h.sup.start()
  await until(() => /child (\d+)/.test(existsSync(logFileOf(join(h.state, "bot-logs"), "probe")) ? h.log() : ""))
  const child = Number(/child (\d+)/.exec(h.log())![1])
  const pid = h.sup.view("probe").pid!
  const said = await h.sup.stopByPerson("probe")
  expect(said.said).toContain("stays on")
  expect(pidIsAlive(pid)).toBe(false)
  await until(() => !pidIsAlive(child))
  expect(what(h.rows, "stopped")[0]).toMatchObject({ why: "down" })
  await h.sup.reconcile()
  expect(h.sup.view("probe").state).toBe("down")
  expect(h.sup.runningCount()).toBe(0)
  await h.sup.startByPerson("probe")
  expect(h.sup.view("probe").state).toBe("running")
  expect(h.tokens.length).toBe(2)
})

test("a crash restarts after its back-off; too many crashes in the window stop it, said; the person's start runs it again", async () => {
  const h = harness({ mode: "crash" })
  await h.sup.start()
  await until(() => what(h.rows, "gave_up").length === 1, 10_000)
  expect(what(h.rows, "crashed").map((r) => r.restartInMs)).toEqual([60, 120])
  expect(String(what(h.rows, "crashed")[0]!.words)).toMatch(/^crashed \(exit 3\) at \d\d:\d\d; it starts again in 0 s$/)
  expect(what(h.rows, "gave_up")[0]).toMatchObject({ crashes: 3 })
  expect(h.sup.view("probe")).toMatchObject({ state: "gave_up" })
  expect(h.sup.view("probe").words).toContain("candle-harness bots start probe")
  // Given up stays given up, across a reconcile and a new supervisor on the same state.
  await h.sup.reconcile()
  expect(what(h.rows, "started").length).toBe(3)
  expect(h.log()).toContain("err  boom")
  await h.sup.startByPerson("probe")
  await until(() => what(h.rows, "started").length === 4)
})

test("a clean exit 0 is said as ended on its own and isn't restarted", async () => {
  const h = harness({ mode: "end" })
  await h.sup.start()
  await until(() => what(h.rows, "ended").length === 1)
  await Bun.sleep(200)
  expect(what(h.rows, "started").length).toBe(1)
  expect(h.sup.view("probe").state).toBe("ended")
})

test("a bot that ended on its own stays ended across a core restart, until it's started or a new version is approved", async () => {
  const f = folder()
  const h = harness({ mode: "end", folder: f })
  await h.sup.start()
  await until(() => what(h.rows, "ended").length === 1)
  await h.sup.stopAll("test")
  // The next core, from what this one saved: the bot isn't started again by itself.
  const spec = { folder: f, command: [process.execPath, "bot.ts", "run"], agent: "momentum" }
  let wanted: Wanted = { start: true, keep: true, spec: h.spec }
  const next = harness({ state: h.state, folder: f, wanted: () => wanted })
  await next.sup.start()
  await Bun.sleep(300)
  expect(what(next.rows, "started")).toHaveLength(0)
  expect(next.sup.view("probe")).toMatchObject({ state: "ended" })
  expect(next.sup.view("probe").words).toMatch(/^ended on its own at \d\d:\d\d \(exit 0\): `candle-harness bots start probe` runs it again$/)
  // Another command approved: a new version, so it starts.
  wanted = { start: true, keep: true, spec }
  await next.sup.reconcile()
  await until(() => next.sup.view("probe").state === "running")
})

test("a bot ended on its own and kept ended by the next core runs again when the person starts it", async () => {
  const h = harness({ mode: "end" })
  await h.sup.start()
  await until(() => what(h.rows, "ended").length === 1)
  await h.sup.stopAll("test")
  const next = harness({ state: h.state, folder: h.folder, wanted: () => ({ start: true, keep: true, spec: h.spec }) })
  await next.sup.start()
  expect(next.sup.view("probe").state).toBe("ended")
  await next.sup.startByPerson("probe")
  await until(() => what(next.rows, "started").length === 1)
})

test("a bot that may no longer run is ended; a new version's folder or command restarts it", async () => {
  let wanted: Wanted | undefined
  const f = folder()
  const spec = { folder: f, command: [process.execPath, "bot.ts", "run"], agent: "momentum" }
  const h = harness({ folder: f, wanted: () => wanted ?? { start: true, keep: true, spec } })
  await h.sup.start()
  await until(() => h.sup.view("probe").state === "running")
  wanted = { start: true, keep: true, spec: { ...spec, command: [process.execPath, "bot.ts", "again"] } }
  await h.sup.reconcile()
  await until(() => what(h.rows, "started").length === 2)
  expect(what(h.rows, "stopped")[0]).toMatchObject({ why: "restart" })
  wanted = { start: false, keep: false, spec, why: "it's stopped" }
  await h.sup.reconcile()
  expect(h.sup.runningCount()).toBe(0)
  expect(what(h.rows, "stopped")[1]).toMatchObject({ why: "stopped" })
  expect(h.sup.view("probe").words).toBe("not running: it's stopped")
  // A bot removed: its process goes with it.
  wanted = undefined
  await h.sup.reconcile()
  await until(() => h.sup.view("probe").state === "running")
  h.setNames([])
  await h.sup.reconcile()
  expect(h.sup.runningCount()).toBe(0)
  expect(what(h.rows, "stopped").at(-1)).toMatchObject({ why: "removed" })
})

test("a bot run elsewhere: its process ends, its token goes to a 0600 file in its folder, and it isn't started until the person starts it here", async () => {
  const h = harness()
  await h.sup.start()
  await until(() => h.sup.view("probe").state === "running")
  const out = await h.sup.outside("probe")
  expect(out.file).toBe(join(h.folder, BOT_TOKEN_FILE))
  expect(out.said).not.toContain(h.tokens.at(-1)!)
  expect(statSync(out.file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(out.file, "utf8"))).toEqual({ bot: "probe", socket: join(h.state, "core.sock"), token: h.tokens.at(-1) })
  expect(h.sup.view("probe")).toMatchObject({ runs: "outside", state: "outside" })
  await h.sup.reconcile()
  expect(h.sup.runningCount()).toBe(0)
  const back = await h.sup.startByPerson("probe")
  expect(back.said).toContain("its token there no longer connects")
  expect(h.sup.view("probe").state).toBe("running")
})

test("the log keeps the last of its size in two files, and a flood past a minute's bytes is counted, not kept", async () => {
  const h = harness({ mode: "chatty", tuning: { logBytes: 16 * 1024, logBytesPerMinute: 12 * 1024 } })
  await h.sup.start()
  const file = logFileOf(join(h.state, "bot-logs"), "probe")
  const size = () => (existsSync(file) ? statSync(file).size : 0) + (existsSync(`${file}.1`) ? statSync(`${file}.1`).size : 0)
  // The bot's 400 lines (about 40 KB) are past the minute's 12 KB, so its last line ("child N") is one of those left
  // out, and can't be waited for: the log is waited on to hold the minute's share instead (each line is ~110 bytes).
  await until(() => size() >= 12 * 1024 - 200)
  await h.sup.stopByPerson("probe")
  const both = statSync(file).size + (existsSync(`${file}.1`) ? statSync(`${file}.1`).size : 0)
  expect(both).toBeLessThanOrEqual(16 * 1024)
  const tail = await readLogTail(join(h.state, "bot-logs"), "probe", 5_000)
  expect(tail.lines.some((l) => /lines? left out: it wrote more than 12 KB in a minute/.test(l))).toBe(true)
})

test("a bot an earlier core left running is ended once its pid is checked; one that isn't it is left alone", async () => {
  const state = mkdtempSync("/tmp/chrn-sups-")
  dirs.push(state)
  // An older record has no start time: the process is then told by the environment the supervisor gave it.
  const left = Bun.spawn(["sleep", "301"], { detached: true, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", CANDLE_HARNESS_BOT: "probe", CANDLE_HARNESS_SOCKET: join(state, "core.sock") } })
  const other = Bun.spawn(["sleep", "302"], { detached: true, stdout: "ignore", stderr: "ignore" })
  strays.push(left.pid, other.pid)
  writeFileSync(
    join(state, "supervisor.json"),
    JSON.stringify({ bots: { probe: { running: { pid: left.pid, at: "2026-11-08T10:00:00.000Z", args: "sleep 301" } }, gone: { running: { pid: other.pid, at: "2026-11-08T10:00:00.000Z", args: "bun run something-else.ts" } } } }),
  )
  const h = harness({ state })
  await h.sup.start()
  expect(pidIsAlive(left.pid)).toBe(false)
  expect(pidIsAlive(other.pid)).toBe(true)
  expect(h.rows.find((r) => r.type === "bot.process" && r.why === "leftover")).toMatchObject({ name: "probe", pid: left.pid })
  await until(() => h.sup.view("probe").state === "running")
})

/** A group whose leader has gone and whose child runs on, under the leader's number: [the group's number, the child's pid]. */
async function orphanedGroup(seconds: number, env: Record<string, string> = {}): Promise<[number, number]> {
  const leader = Bun.spawn(["sh", "-c", `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { detached: true, stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "", ...env } })
  const child = Number((await new Response(leader.stdout).text()).trim())
  await leader.exited
  strays.push(leader.pid)
  await until(() => !pidIsAlive(leader.pid))
  expect(pidIsAlive(child)).toBe(true)
  return [leader.pid, child]
}

const savedRunning = (state: string, running: Record<string, unknown>) => writeFileSync(join(state, "supervisor.json"), JSON.stringify({ bots: { probe: { running: { at: "2026-11-08T10:00:00.000Z", ...running } } } }))

test("a recorded group whose leader has gone is signalled only when what runs there is the bot's; anything else is left, and said", async () => {
  // Some other program's group, which happens to carry the recorded number: nothing in it is the bot's.
  const state = mkdtempSync("/tmp/chrn-sups-")
  dirs.push(state)
  const [group, child] = await orphanedGroup(304)
  savedRunning(state, { pid: group, args: "bun bot.ts run", started: "Sun Nov  8 10:00:00 2026" })
  const h = harness({ state })
  await h.sup.start()
  expect(pidIsAlive(child)).toBe(true)
  expect(h.rows.some((r) => r.type === "bot.process" && r.why === "leftover")).toBe(false)
  expect(h.rows.find((r) => r.type === "bot.process" && r.what === "warning")).toMatchObject({ name: "probe", pid: group })
  expect(String(h.rows.find((r) => r.type === "bot.process" && r.what === "warning")?.words)).toContain("so it was left alone")

  // The bot's own children, left behind with the environment it was started with: ended.
  const state2 = mkdtempSync("/tmp/chrn-sups-")
  dirs.push(state2)
  const [group2, child2] = await orphanedGroup(305, { CANDLE_HARNESS_BOT: "probe", CANDLE_HARNESS_SOCKET: join(state2, "core.sock") })
  savedRunning(state2, { pid: group2, args: "bun bot.ts run", started: "Sun Nov  8 10:00:00 2026" })
  const h2 = harness({ state: state2 })
  await h2.sup.start()
  await until(() => !pidIsAlive(child2))
  expect(h2.rows.find((r) => r.type === "bot.process" && r.why === "leftover")).toMatchObject({ name: "probe", pid: group2 })

  // Another core's bot of the same name (another socket) isn't this one's.
  const state3 = mkdtempSync("/tmp/chrn-sups-")
  dirs.push(state3)
  const [group3, child3] = await orphanedGroup(306, { CANDLE_HARNESS_BOT: "probe", CANDLE_HARNESS_SOCKET: "/somewhere/else/core.sock" })
  savedRunning(state3, { pid: group3, args: "bun bot.ts run" })
  const h3 = harness({ state: state3 })
  await h3.sup.start()
  expect(pidIsAlive(child3)).toBe(true)
})

test("a pid recorded before the machine last started is never signalled, whatever runs under it now", async () => {
  const state = mkdtempSync("/tmp/chrn-sups-")
  dirs.push(state)
  const now = Bun.spawn(["sleep", "307"], { detached: true, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", CANDLE_HARNESS_BOT: "probe", CANDLE_HARNESS_SOCKET: join(state, "core.sock") } })
  strays.push(now.pid)
  savedRunning(state, { pid: now.pid, args: "sleep 307", boot: "1700000000" })
  const h = harness({ state, boot: () => "1800000000" })
  await h.sup.start()
  expect(pidIsAlive(now.pid)).toBe(true)
  expect(h.rows.some((r) => r.type === "bot.process" && (r.why === "leftover" || r.what === "warning"))).toBe(false)
  // The same record from this start of the machine is ended as before.
  await h.sup.stopAll("test")
  const state2 = mkdtempSync("/tmp/chrn-sups-")
  dirs.push(state2)
  const same = Bun.spawn(["sleep", "308"], { detached: true, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", CANDLE_HARNESS_BOT: "probe", CANDLE_HARNESS_SOCKET: join(state2, "core.sock") } })
  strays.push(same.pid)
  savedRunning(state2, { pid: same.pid, args: "sleep 308", boot: "1800000000" })
  const h2 = harness({ state: state2, boot: () => "1800000000" })
  await h2.sup.start()
  expect(pidIsAlive(same.pid)).toBe(false)
})

test("a start records the process's start time and the machine's with its pid, before the start goes on", async () => {
  const h = harness({ boot: () => "1800000000" })
  await h.sup.start()
  await until(() => h.sup.view("probe").state === "running")
  const saved = JSON.parse(readFileSync(join(h.state, "supervisor.json"), "utf8")) as { bots: { probe: { running: { pid: number; started?: string; boot?: string; args: string } } } }
  expect(saved.bots.probe.running.started).toMatch(/\d{4}$/)
  expect(saved.bots.probe.running.boot).toBe("1800000000")
  expect(saved.bots.probe.running.args).toContain("bot.ts run")
})

test("memory or CPU past its figure is said once, until it falls back", async () => {
  let rssKb = 100 * 1024
  let cpuSec = 0
  const h = harness({
    tuning: { sampleMs: 40, memoryWarnMb: 512 },
    sample: async () => {
      cpuSec += 0.001
      const m = new Map<number, { rssKb: number; cpuSec: number }>()
      for (const pid of [h.sup.view("probe").pid]) if (pid) m.set(pid, { rssKb, cpuSec })
      return m
    },
  })
  await h.sup.start()
  await until(() => h.sup.view("probe").memoryMb === 100)
  rssKb = 900 * 1024
  await until(() => what(h.rows, "warning").length === 1)
  expect(String(what(h.rows, "warning")[0]!.words)).toBe("it uses 900 MB of memory, past 512 MB")
  await Bun.sleep(200)
  expect(what(h.rows, "warning").length).toBe(1)
  rssKb = 100 * 1024
  await until(() => h.sup.view("probe").warning === undefined)
})

test("the code's hash covers its files and lockfile, leaves dependencies out, and changes with the code", async () => {
  const d = mkdtempSync("/tmp/chrn-hash-")
  dirs.push(d)
  writeFileSync(join(d, "bot.ts"), "one")
  writeFileSync(join(d, "bun.lock"), "lock")
  mkdirSync(join(d, "node_modules", "dep"), { recursive: true })
  writeFileSync(join(d, "node_modules", "dep", "index.js"), "dep")
  writeFileSync(join(d, BOT_TOKEN_FILE), "token")
  const a = await codeHash(d)
  expect(a.files).toBe(2)
  expect(a.lockfile?.name).toBe("bun.lock")
  writeFileSync(join(d, "node_modules", "dep", "index.js"), "changed")
  writeFileSync(join(d, BOT_TOKEN_FILE), "another token")
  expect((await codeHash(d)).hash).toBe(a.hash)
  writeFileSync(join(d, "bot.ts"), "two")
  expect((await codeHash(d)).hash).not.toBe(a.hash)
})

test("ps's CPU time reads on Linux and macOS", () => {
  expect(cpuSeconds("00:01:05")).toBe(65)
  expect(cpuSeconds("1-02:00:00")).toBe(93_600)
  expect(cpuSeconds("0:01.50")).toBe(1.5)
  expect(cpuSeconds("1:02:03.00")).toBe(3723)
  expect(cpuSeconds("garbage")).toBeUndefined()
})

test("a process stopped, ended on its own or given up on has its token ended; a restart, a move outside and the core's stop don't", async () => {
  // The person's stop.
  const h = harness()
  await h.sup.start()
  await until(() => h.sup.view("probe").state === "running")
  await h.sup.restart("probe")
  expect(h.ended).toEqual([])
  await h.sup.stopByPerson("probe")
  expect(h.ended).toEqual(["process_stopped"])
  // Run outside: its new token there is its own to keep.
  await h.sup.startByPerson("probe")
  await h.sup.outside("probe")
  expect(h.ended).toEqual(["process_stopped"])
  // The core's stop: each starts again with the next core, which gives it a new one.
  const core = harness()
  await core.sup.start()
  await until(() => core.sup.view("probe").state === "running")
  await core.sup.stopAll("test")
  expect(core.ended).toEqual([])
  // A clean exit.
  const done = harness({ mode: "end" })
  await done.sup.start()
  await until(() => done.sup.view("probe").state === "ended")
  expect(done.ended).toEqual(["process_ended"])
  // Too many crashes.
  const crashing = harness({ mode: "crash" })
  await crashing.sup.start()
  await until(() => crashing.sup.view("probe").state === "gave_up", 10_000)
  expect(crashing.ended).toEqual(["process_gave_up"])
}, 30_000)

test("a bot's output is kept without terminal control sequences, and can't pass for one of the core's own lines", async () => {
  const h = harness({ mode: "noisy" })
  await h.sup.start()
  await until(() => (existsSync(logFileOf(join(h.state, "bot-logs"), "probe")) ? h.log() : "").includes("noisy done"))
  const log = h.log()
  expect(log).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  expect(log).toContain("out  red plain after over")
  expect(log).not.toContain("aGk=")
  expect(log).not.toContain("[31m")
  // Every line opens with the time and whose line it is; the forged one is the bot's.
  for (const line of log.trim().split("\n")) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z (out|err|---)  /)
  expect(log.split("\n").find((l) => l.includes("forged"))).toMatch(/Z out +2026-01-01T00:00:00.000Z ---  started \(pid 1\): forged$/)
  expect(logText("a\u001b[2Jb\u001b]0;title\u0007c\u009b31md\u001bMe\r")).toBe("abcde")
})

test("a private key printed over several lines is left out whole, and a key cut by the longest line is still redacted", async () => {
  const h = harness({ mode: "noisy" })
  await h.sup.start()
  await until(() => (existsSync(logFileOf(join(h.state, "bot-logs"), "probe")) ? h.log() : "").includes("noisy done"))
  const log = h.log()
  expect(log).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU")
  expect(log).not.toContain("bodyline")
  expect(log).not.toContain("PRIVATE KEY")
  expect(log).toContain("out  after the key")
  // The long line: its key sat across the cut, and no half of it is kept.
  expect(log).toContain("end of the long line")
  expect(log).not.toContain("q".repeat(12))
})

test("a start whose code differs from its last start's says so on its row and in its log, and nowhere else; a program outside the folder is hashed too", async () => {
  const h = harness()
  await h.sup.start()
  await until(() => h.sup.view("probe").state === "running")
  await h.sup.restart("probe")
  const first = what(h.rows, "started")
  expect(first).toHaveLength(2)
  expect((first[0]!.code as { changed?: boolean }).changed).toBeUndefined()
  expect((first[1]!.code as { changed?: boolean }).changed).toBeUndefined()
  expect(h.log()).not.toContain("its code changed since its last start")
  writeFileSync(join(h.folder, "bot.ts"), `${BOT}\n// edited`)
  await h.sup.restart("probe")
  expect((what(h.rows, "started")[2]!.code as { changed?: boolean }).changed).toBe(true)
  expect(h.log().split("\n").filter((l) => l.includes("its code changed since its last start"))).toHaveLength(1)
  // Nothing but the started row says it.
  expect(h.rows.filter((r) => JSON.stringify(r).includes("changed")).map((r) => r.what)).toEqual(["started"])
  expect(h.sup.view("probe").words).not.toContain("changed")

  // A command by a path that leads out of the folder: its file's hash is on record, and a change to it is a change.
  const outside = mkdtempSync("/tmp/chrn-prog-")
  dirs.push(outside)
  writeFileSync(join(outside, "run.sh"), "one")
  const a = await codeHash(h.folder, [join(outside, "run.sh"), "arg"])
  expect(a.program).toEqual({ path: join(outside, "run.sh"), hash: expect.any(String) })
  writeFileSync(join(outside, "run.sh"), "two")
  expect((await codeHash(h.folder, [join(outside, "run.sh")])).program!.hash).not.toBe(a.program!.hash)
  expect((await codeHash(h.folder, ["bun", "bot.ts"])).program).toBeUndefined()
  expect((await codeHash(h.folder, ["./bot.ts"])).program).toBeUndefined()
}, 30_000)

test("a token file written where the folder's git would pick it up says so, and the person's .gitignore is never written", async () => {
  const d = folder()
  if (Bun.spawnSync(["git", "init", "-q", d]).exitCode !== 0) return
  const h = harness({ folder: d })
  await h.sup.start()
  const out = await h.sup.outside("probe")
  expect(out.warning).toBe(TOKEN_NOT_IGNORED)
  expect(out.said.split("\n").at(-1)).toBe("This folder's git doesn't ignore .harness-bot.json. Add it to .gitignore before you commit.")
  expect(existsSync(join(d, ".gitignore"))).toBe(false)
  // Ignored by the person's own rule: nothing is said.
  writeFileSync(join(d, ".gitignore"), `${BOT_TOKEN_FILE}\n`)
  const again = await h.sup.outside("probe")
  expect(again.warning).toBeUndefined()
  expect(again.said).not.toContain("git")
  // A folder that isn't in git: nothing is said either.
  const plain = harness()
  await plain.sup.start()
  expect((await plain.sup.outside("probe")).warning).toBeUndefined()
})

test("a bot that exits before its start is identified: its log says started before ended, and no file is left open for GC to close", async () => {
  // `identify` answers only once the bot has ended, so its `ended` note and log close come first unless the start's
  // note was written before anything was awaited.
  let h: ReturnType<typeof harness> | undefined
  const identify = async () => {
    await until(() => (h ? what(h.rows, "ended").length === 1 : false))
    await Bun.sleep(50)
    return { started: "Mon Nov  9 00:00:00 2026", args: "bun bot.ts end" }
  }
  h = harness({ mode: "end", identify })
  await h.sup.start()
  await until(() => what(h!.rows, "ended").length === 1 && what(h!.rows, "started").length === 1)
  await Bun.sleep(100)
  for (let i = 0; i < 3; i++) {
    Bun.gc(true)
    await Bun.sleep(20)
  }
  const lines = h.log().split("\n").filter((l) => / --- {2}(started|ended) /.test(l))
  expect(lines.length).toBe(2)
  expect(lines[0]).toContain("started (pid")
  expect(lines[1]).toContain("ended (exit 0)")
})
