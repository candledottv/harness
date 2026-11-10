// The supervisor: the core runs each code bot's command in its folder, and keeps it running.
//
// - A bot starts in its own process group, in its approved folder with its approved command (never what a hand edit of
//   bots.toml says), with a clean environment (the harnesses' allowlist) plus its bot token, the socket's path and its
//   name. Nothing else of the core's passes: no key, no view token, no Candle variable. Each start issues a new token,
//   so a process left over from an earlier start can't trade.
// - Each start journals its code's hash: every file in its folder (dependency and cache folders left out), its
//   lockfile's own hash, and its command's program where that's a file outside its folder. A hash that differs from
//   its last start's is noted on that row and in its log, and nowhere else: code under work changes at every start.
// - A crash (any end the supervisor didn't ask for, but a clean exit 0) is restarted after 2 s, then longer, up to a
//   minute. After five crashes in ten minutes it stops trying, says so, and is notified at once; `candle-harness bots
//   start` runs it again. A clean exit 0 is said as ended on its own and not restarted until it's started again.
// - The person can stop its process (`candle-harness bots stop`), which leaves the bot on: its held exits still run, and
//   it stays down, across a core restart too, until it's started again. A process stopped, given up on or ended on
//   its own has its token ended with it, so nothing it left behind can trade. The Bots tab's stop ends its trades as well,
//   and the supervisor ends its process with it. Pausing it leaves it running, since its sells still run.
// - It ends with its process group (SIGTERM, then SIGKILL after a grace), when it's stopped, removed, run outside, or
//   the core stops. A core that died without stopping leaves its groups running: the next core ends each it recorded,
//   once the pid is checked to be the one it started, before starting it again.
// - Its output (stdout and stderr, line by line) is kept, the last 5 MB in two files, every line redacted before it's
//   written: the core's keys, bot and build tokens, and every key shape the redactor knows. A private key printed
//   over several lines is left out whole, and terminal control sequences are taken out, so a log read in a terminal
//   can't move the cursor, set the clipboard or pass for one of the core's own lines.
// - Its memory and CPU are sampled once a minute, across its process group; past a figure it's said once.
// - A bot run elsewhere (launchd, tmux, a debugger) gets its token in a 0600 file in its folder, never on screen. It
//   shows as running outside the Candle Harness, with no restarts or logs, until it's started here again.
import { createHash } from "node:crypto"
import { constants as fsc, readFileSync } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { harnessEnv } from "../engine/spawn"
import { absolutePath, systemTool } from "../shared/exec-path"
import { refused } from "../shared/rpc"
import { pidIsAlive } from "../shared/lock"
import { terminalText } from "../shared/terminal-text"
import type { Mode } from "./classify"
import type { Journal } from "./journal"

/** The supervisor's figures. Tests shorten them. */
export interface SupervisorTuning {
  /** The wait before each restart after a crash: 2 s, then longer, up to a minute. */
  backoffMs: readonly number[]
  /** This many crashes inside the window, and it stops trying. */
  crashLimit: number
  crashWindowMs: number
  /** A run that lasts this long resets the back-off. */
  stableMs: number
  /** The log kept: the last this many bytes, in two files. */
  logBytes: number
  /** At most this many bytes of output logged a minute; past it, lines are counted, not kept. */
  logBytesPerMinute: number
  sampleMs: number
  memoryWarnMb: number
  cpuWarnPct: number
  /** After SIGTERM, how long before SIGKILL. */
  stopGraceMs: number
}

export const SUPERVISOR_TUNING: SupervisorTuning = {
  backoffMs: [2_000, 4_000, 8_000, 16_000, 32_000, 60_000],
  crashLimit: 5,
  crashWindowMs: 10 * 60_000,
  stableMs: 10 * 60_000,
  logBytes: 5 * 1024 * 1024,
  logBytesPerMinute: 2 * 1024 * 1024,
  sampleMs: 60_000,
  memoryWarnMb: 1024,
  cpuWarnPct: 90,
  stopGraceMs: 5_000,
}

/** The file a bot run elsewhere reads its token and the socket's path from: in its folder, 0600. */
export const BOT_TOKEN_FILE = ".harness-bot.json"

/** Folders a code hash leaves out: dependencies, caches and version control. The lockfile stands for dependencies. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".cache", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".turbo", "target"])
/** Lockfiles, in the order one is named. */
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt", "Cargo.lock", "go.sum"]
const HASH_MAX_FILES = 5_000
const HASH_MAX_BYTES = 50 * 1024 * 1024
/** A line longer than this is written in pieces. */
const LINE_MAX = 16 * 1024
/** How far back from the cut a long line looks for a break between words, so a key or token isn't cut in two. */
const CUT_BACK = 512
/** A private key printed over several lines: from its BEGIN line to its END line, or this many lines at most. */
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/
const PEM_MAX_LINES = 100
/** Terminal control sequences, whole: CSI (colours, cursor moves), OSC (titles, the clipboard) and the two-character escapes. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]/g

/** A line of a bot's output, safe to read in a terminal: its control sequences and control characters taken out. */
export const logText = (raw: string): string => terminalText(raw.replace(/\r+$/, "").replace(ESCAPES, ""))

/** Where a line over the limit is cut: at the last break between words near the limit, else at the limit. */
function cutAt(text: string): number {
  for (let i = LINE_MAX; i > LINE_MAX - CUT_BACK; i--) if (!/[A-Za-z0-9_+/=-]/.test(text[i - 1]!)) return i
  return LINE_MAX
}

/** A code bot's code at a start: one hash over its folder's files, and its lockfile's. */
export interface CodeHash {
  hash: string
  files: number
  lockfile?: { name: string; hash: string }
  /** Its command's program, where that's a file outside its folder: the folder's hash doesn't cover it. */
  program?: { path: string; hash: string }
  /** Past the file or byte limit: the hash covers what was read. */
  partial?: true
  /** The folder's hash, the lockfile's or the program's differs from its last start's. */
  changed?: true
}

/** Hashes a folder's files: each path with its content's hash, in order. Links are hashed by where they point, never followed. */
export async function codeHash(folder: string, command?: readonly string[]): Promise<CodeHash> {
  const entries: string[] = []
  let bytes = 0
  let partial = false
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[]
    try {
      names = (await readdir(dir)).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (partial) return
      const path = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      let st
      try {
        st = await lstat(path)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        const to = await readlink(path).catch(() => "")
        entries.push(`${r}\0link\0${to}`)
      } else if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) await walk(path, r)
      } else if (st.isFile()) {
        if (!rel && name === BOT_TOKEN_FILE) continue
        if (entries.length >= HASH_MAX_FILES || bytes + st.size > HASH_MAX_BYTES) {
          partial = true
          return
        }
        const content = await readFile(path).catch(() => undefined)
        if (!content) continue
        bytes += content.length
        entries.push(`${r}\0${createHash("sha256").update(content).digest("hex")}`)
      }
    }
  }
  await walk(folder, "")
  const hash = createHash("sha256").update(entries.join("\n"), "utf8").digest("hex")
  let lockfile: CodeHash["lockfile"]
  for (const name of LOCKFILES) {
    const content = await readFile(join(folder, name)).catch(() => undefined)
    if (content) {
      lockfile = { name, hash: createHash("sha256").update(content).digest("hex") }
      break
    }
  }
  // A command given as a path that leads out of the folder (a script elsewhere, an interpreter by its path) runs
  // code the folder's hash never saw. A bare name found on PATH isn't hashed.
  let program: CodeHash["program"]
  const first = command?.[0]
  if (first && first.includes("/")) {
    const path = isAbsolute(first) ? first : resolve(folder, first)
    const rel = relative(folder, path)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      const st = await stat(path).catch(() => undefined)
      if (st?.isFile() && st.size <= HASH_MAX_BYTES) {
        const content = await readFile(path).catch(() => undefined)
        if (content) program = { path, hash: createHash("sha256").update(content).digest("hex") }
      }
    }
  }
  return { hash, files: entries.length, ...(lockfile ? { lockfile } : {}), ...(program ? { program } : {}), ...(partial ? { partial: true as const } : {}) }
}

/** What a start's code hash is compared by, start to start. */
const codeMark = (c: CodeHash): string => [c.hash, c.lockfile?.hash ?? "", c.program?.hash ?? ""].join(":")

/** What runs: the approved version's folder and command, and the agent it trades for. */
export interface BotRunSpec {
  folder: string
  command: readonly string[]
  agent: string
}

/** Whether a bot may start now, and whether one running may go on; why not, in words. */
export interface Wanted {
  start: boolean
  keep: boolean
  spec?: BotRunSpec
  why?: string
}

/** How a supervised bot's process stands, for the Bots topic and `candle-harness bots list`. */
export interface BotProcessView {
  runs: "harness" | "outside"
  state: "running" | "starting" | "restarting" | "gave_up" | "down" | "ended" | "waits" | "outside"
  words: string
  pid?: number
  since?: string
  /** Crashes in the last ten minutes. */
  crashes?: number
  restartAt?: string
  memoryMb?: number
  cpuPct?: number
  warning?: string
  /** How its last run ended, in words. */
  lastExit?: string
  /** Its log file, for `tail -f`. */
  log?: string
}

export interface SupervisorDeps {
  statePath: string
  logsDir: string
  socketPath: string
  journal: Journal
  mode(): Mode
  now(): number
  /** The core's environment: only the harnesses' allowlist of it passes. */
  parentEnv: Record<string, string | undefined>
  /** Redacts a log line: the core's keys and every token and key shape. */
  redact(text: string): string
  /** Every code bot the core knows, saved or with state. */
  names(): string[]
  wanted(name: string): Wanted
  /** A fresh token for the bot, replacing its last. Throws a refusal in words. */
  issueToken(name: string, why: "start" | "outside"): Promise<{ token: string }>
  /** Ends the bot's token and its connection: its process here ended and won't be started again by itself. */
  endToken?(name: string, why: "process_stopped" | "process_gave_up" | "process_ended"): Promise<unknown>
  /** Whether the bot has a token now: one run outside whose token was withdrawn says so. */
  hasToken?(name: string): boolean
  /** Whether the folder's git ignores a file; undefined when the folder isn't in a git work tree. A seam for tests. */
  gitIgnores?(folder: string, file: string): Promise<boolean | undefined>
  /** Something the Bots topic shows changed. */
  onChange(): void
  tuning?: Partial<SupervisorTuning>
  /** Each process group's memory (KB) and CPU seconds so far: one read for every bot. A seam for tests. */
  sample?(): Promise<Map<number, { rssKb: number; cpuSec: number }>>
  /** A pid's start time and command line, to know a recorded pid is still the bot it started. A seam for tests. */
  identify?(pid: number): Promise<{ started: string; args: string } | undefined>
  /**
   * Whether a live member of process group `pgid` is the bot `name` this core's socket started: asked before a
   * group is signalled by a recorded number alone. A seam for tests.
   */
  groupIsBot?(pgid: number, name: string): Promise<boolean>
  /** When this machine started, as text: a pid recorded before a restart of the machine names nothing now. A seam for tests. */
  boot?(): string | undefined
}

interface Saved {
  /** Its code's hash at its last start, to say when it changed. */
  code?: string
  where?: "outside"
  down?: { at: string }
  gaveUp?: { at: string; crashes: number }
  running?: { pid: number; at: string; args: string; started?: string; boot?: string }
}

interface Live {
  spec: BotRunSpec
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  startedAt: number
  stopping?: { why: "stopped" | "down" | "core" | "restart" | "outside" | "removed"; words: string }
  log: BotLog
  exited: Promise<void>
}

interface Runtime {
  live?: Live
  starting?: boolean
  crashes: number[]
  restartTimer?: ReturnType<typeof setTimeout>
  restartAt?: number
  lastExit?: string
  ended?: string
  /** Why it isn't started now, where it was wanted to but couldn't be. */
  waits?: string
  usage?: { rssKb: number; cpuPct?: number }
  lastCpu?: { sec: number; at: number }
  warning?: string
}

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A process's end in words: "exit 1", "killed by SIGKILL". */
function exitWords(code: number | null, signal: NodeJS.Signals | number | null): string {
  if (signal) return `killed by ${signal}`
  return `exit ${code ?? "?"}`
}

/** `ps`'s cumulative CPU time in seconds: "[[DD-]hh:]mm:ss" on Linux, "m:ss.ss" or "h:mm:ss.ss" on macOS. */
export function cpuSeconds(text: string): number | undefined {
  const t = text.trim()
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(t)
  if (!m) return undefined
  const parts = m[2]!.split(":").map(Number)
  if (parts.some((p) => !Number.isFinite(p))) return undefined
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return sec + (m[1] ? Number(m[1]) * 86_400 : 0)
}

/** One read of every process's group, memory and CPU time, summed by group. */
export async function psSample(): Promise<Map<number, { rssKb: number; cpuSec: number }>> {
  const out = new Map<number, { rssKb: number; cpuSec: number }>()
  try {
    const proc = Bun.spawn([systemTool("ps"), "-A", "-o", "pgid=,rss=,time="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    for (const line of text.split("\n")) {
      const [pgid, rss, time] = line.trim().split(/\s+/)
      const g = Number(pgid)
      const kb = Number(rss)
      const cpu = time ? cpuSeconds(time) : undefined
      if (!Number.isInteger(g) || g <= 0 || !Number.isFinite(kb) || cpu === undefined) continue
      const was = out.get(g) ?? { rssKb: 0, cpuSec: 0 }
      out.set(g, { rssKb: was.rssKb + kb, cpuSec: was.cpuSec + cpu })
    }
  } catch {}
  return out
}

/** A pid's start time and command line, by `ps`. */
export async function psIdentify(pid: number): Promise<{ started: string; args: string } | undefined> {
  try {
    const proc = Bun.spawn([systemTool("ps"), "-o", "lstart=", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const text = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    // lstart is five words: "Sun Nov  8 14:02:03 2026".
    const m = /^(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(text)
    return m ? { started: m[1]!.replace(/\s+/g, " "), args: m[2]! } : undefined
  } catch {
    return undefined
  }
}

/** Whether a folder's git ignores a file: by `git check-ignore`. Undefined when the folder isn't in a work tree, or git isn't there. */
export async function gitIgnores(folder: string, file: string): Promise<boolean | undefined> {
  try {
    const proc = Bun.spawn([systemTool("git"), "-C", folder, "check-ignore", "-q", file], { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { PATH: absolutePath(process.env.PATH), ...(process.env.HOME ? { HOME: process.env.HOME } : {}), GIT_OPTIONAL_LOCKS: "0" } })
    const code = await proc.exited
    // 0: ignored. 1: not ignored. Anything else (128: not a repository) says nothing.
    return code === 0 ? true : code === 1 ? false : undefined
  } catch {
    return undefined
  }
}

/** Said with a token file written where the folder's git would pick it up: the person's .gitignore is theirs to change. */
export const TOKEN_NOT_IGNORED = `This folder's git doesn't ignore ${BOT_TOKEN_FILE}. Add it to .gitignore before you commit.`

/** When this machine started: Linux's btime, macOS's kern.boottime. Undefined where neither can be read. */
export function machineBoot(): string | undefined {
  try {
    if (process.platform === "linux") return /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]
    if (process.platform === "darwin") {
      const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"], { stdout: "pipe", stderr: "ignore" })
      return /sec = (\d+)/.exec(r.stdout.toString())?.[1]
    }
  } catch {}
  return undefined
}

/**
 * Whether a live member of process group `pgid` carries the environment the supervisor gives the bot `name`
 * (its name and this core's socket). Linux reads each member's /proc environ; macOS asks `ps` for it. A member
 * whose environment can't be read, or was replaced, doesn't count.
 */
export async function groupCarriesBot(pgid: number, name: string, socketPath: string): Promise<boolean> {
  const wanted = [`CANDLE_HARNESS_BOT=${name}`, `CANDLE_HARNESS_SOCKET=${socketPath}`]
  try {
    const ps = Bun.spawn([systemTool("ps"), "-A", "-o", "pid=,pgid="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const members = (await new Response(ps.stdout).text())
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pid, g]) => g === pgid && Number.isInteger(pid) && pid! > 1 && pid !== process.pid)
      .map(([pid]) => pid!)
    await ps.exited
    for (const pid of members) {
      let vars: string[]
      if (process.platform === "linux") {
        vars = await readFile(`/proc/${pid}/environ`, "utf8").then(
          (t) => t.split("\0"),
          () => [],
        )
      } else {
        const env = Bun.spawn([systemTool("ps"), "eww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
        vars = (await new Response(env.stdout).text()).trim().split(/\s+/)
        await env.exited
      }
      if (wanted.every((w) => vars.includes(w))) return true
    }
  } catch {}
  return false
}

/** Signals a process group, quietly: it may be gone already. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {}
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * One bot's log: line by line, each redacted, timestamped and tagged, the last `logBytes` kept as two files
 * (`<name>.log` and `<name>.log.1`), and at most `perMinute` bytes a minute; past it, lines are counted and said.
 */
class BotLog {
  private handle: FileHandle | undefined
  private size = 0
  private chain: Promise<void> = Promise.resolve()
  private windowStart = 0
  private windowBytes = 0
  private dropped = 0
  private partial: Record<"out" | "err", string> = { out: "", err: "" }
  /** Lines left of a private key being printed on a stream: each is left out until its END line. */
  private pem: Record<"out" | "err", number> = { out: 0, err: 0 }
  /**
   * Closed: a line written after it (a bot's last output read after its exit) opens the file, writes and closes it
   * again. A handle left open would be closed by GC, which Bun counts as an uncaught error that ends the core.
   */
  private closed = false

  constructor(
    readonly path: string,
    private readonly opts: { cap: number; perMinute: number; redact(text: string): string; now(): number },
  ) {}

  /** Bytes from the bot's stdout or stderr: whole lines are written, a part waits for its end. */
  feed(stream: "out" | "err", chunk: string): void {
    const text = this.partial[stream] + chunk
    const lines = text.split("\n")
    this.partial[stream] = lines.pop() ?? ""
    while (this.partial[stream].length > LINE_MAX) {
      const cut = cutAt(this.partial[stream])
      lines.push(this.partial[stream].slice(0, cut))
      this.partial[stream] = this.partial[stream].slice(cut)
    }
    for (const line of lines) this.line(stream, line)
  }

  /** The supervisor's own line about the bot. */
  note(text: string): void {
    this.write(`${new Date(this.opts.now()).toISOString()} ---  ${text}\n`)
  }

  /** Writes what's waiting for its end, then closes. */
  async close(): Promise<void> {
    this.closed = true
    for (const s of ["out", "err"] as const) {
      if (this.partial[s]) this.line(s, this.partial[s])
      this.partial[s] = ""
    }
    this.flushDropped()
    await this.chain
    await this.handle?.close().catch(() => {})
    this.handle = undefined
  }

  private line(stream: "out" | "err", raw: string): void {
    const now = this.opts.now()
    if (now - this.windowStart >= 60_000) {
      this.flushDropped()
      this.windowStart = now
      this.windowBytes = 0
    }
    const text = `${new Date(now).toISOString()} ${stream}  ${this.safe(stream, raw)}\n`
    if (this.windowBytes + text.length > this.opts.perMinute) {
      this.dropped++
      return
    }
    this.windowBytes += text.length
    this.write(text)
  }

  /**
   * A line as it's kept: cleaned for a terminal, then redacted. The redactor sees one line at a time, so a private
   * key printed over several lines is followed here: every line from its BEGIN to its END is left out.
   */
  private safe(stream: "out" | "err", raw: string): string {
    if (this.pem[stream] > 0) {
      this.pem[stream] = PEM_END.test(raw) ? 0 : this.pem[stream] - 1
      return "[redacted]"
    }
    const begin = PEM_BEGIN.exec(raw)
    if (begin && !PEM_END.test(raw.slice(begin.index))) {
      this.pem[stream] = PEM_MAX_LINES
      return `${this.opts.redact(logText(raw.slice(0, begin.index)))}[redacted]`
    }
    return this.opts.redact(logText(raw))
  }

  private flushDropped(): void {
    if (!this.dropped) return
    const n = this.dropped
    this.dropped = 0
    this.note(`${plural(n, "line")} left out: it wrote more than ${Math.round(this.opts.perMinute / 1024)} KB in a minute`)
  }

  private write(text: string): void {
    this.chain = this.chain
      .then(async () => {
        try {
          await this.append(text)
        } finally {
          if (this.closed && this.handle) {
            await this.handle.close().catch(() => {})
            this.handle = undefined
          }
        }
      })
      .catch(() => {})
  }

  private async append(text: string): Promise<void> {
    if (!this.handle) {
      this.handle = await open(this.path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_APPEND, 0o600)
      this.size = (await this.handle.stat()).size
    }
    const bytes = Buffer.from(text, "utf8")
    if (this.size + bytes.length > this.opts.cap / 2) {
      await this.handle.close()
      this.handle = undefined
      await rename(this.path, `${this.path}.1`).catch(() => {})
      this.handle = await open(this.path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_APPEND, 0o600)
      this.size = 0
    }
    await this.handle.write(bytes)
    this.size += bytes.length
  }
}

/** A bot's log file's name: its name made safe for a file. */
export const logFileOf = (logsDir: string, name: string) => join(logsDir, `${encodeURIComponent(name)}.log`)

/** The last `lines` lines of a bot's log, across its two files. */
export async function readLogTail(logsDir: string, name: string, lines: number): Promise<{ lines: string[]; file: string }> {
  const file = logFileOf(logsDir, name)
  const older = await readFile(`${file}.1`, "utf8").catch(() => "")
  const newer = await readFile(file, "utf8").catch(() => "")
  const all = (older + newer).split("\n").filter((l) => l.length > 0)
  return { lines: all.slice(-Math.max(1, lines)), file }
}

export class Supervisor {
  private readonly t: SupervisorTuning
  private saved: Record<string, Saved> = {}
  private readonly rt = new Map<string, Runtime>()
  private chain: Promise<void> = Promise.resolve()
  private sampler: ReturnType<typeof setInterval> | undefined
  private stopped = false

  constructor(private readonly deps: SupervisorDeps) {
    this.t = { ...SUPERVISOR_TUNING, ...deps.tuning }
  }

  /**
   * Reads what it recorded, ends any bot a core that died left running (once its pid is checked to be the one it
   * started), then starts every bot that should run. Called once the socket listens.
   */
  async start(): Promise<void> {
    try {
      const file = JSON.parse(await readFile(this.deps.statePath, "utf8")) as { bots?: Record<string, Saved> }
      if (file && typeof file.bots === "object" && file.bots) this.saved = file.bots
    } catch {}
    await mkdir(this.deps.logsDir, { recursive: true, mode: 0o700 })
    for (const [name, s] of Object.entries(this.saved)) {
      if (!s.running) continue
      await this.endLeftover(name, s.running)
      delete s.running
    }
    await this.persist()
    this.sampler = setInterval(() => void this.sample(), this.t.sampleMs)
    this.sampler.unref?.()
    await this.reconcile()
  }

  /** Each bot started, kept or stopped to match what's wanted now. Serialized: one pass at a time. */
  reconcile(): Promise<void> {
    const pass = this.chain.then(() => this.pass())
    this.chain = pass.catch(() => {})
    return pass
  }

  /** Ends every bot's process with the core's stop, and keeps nothing running. Each starts again with the next core. */
  async stopAll(reason: string): Promise<void> {
    this.stopped = true
    if (this.sampler) clearInterval(this.sampler)
    await this.chain.catch(() => {})
    const ends: Promise<void>[] = []
    for (const [name, r] of this.rt) {
      if (r.restartTimer) clearTimeout(r.restartTimer)
      r.restartTimer = undefined
      if (r.live) ends.push(this.end(name, r.live, "core", `the core stopped (${reason})`))
    }
    await Promise.all(ends)
    await this.persist()
  }

  /** How many bots' processes run now. */
  runningCount(): number {
    let n = 0
    for (const r of this.rt.values()) if (r.live) n++
    return n
  }

  /** `candle-harness bots start <name>`: runs it again, here: after its crashes, a stop of its process, or running outside. */
  async startByPerson(name: string): Promise<{ said: string }> {
    return this.serial(async () => {
      const w = this.deps.wanted(name)
      if (!w.spec) throw refused("UNKNOWN_BOT", w.why ?? `No code bot named "${name}" runs here.`)
      const r = this.runtime(name)
      if (r.live) return { said: `"${name}" is already running (pid ${r.live.pid}, since ${hhmm(r.live.startedAt)}). \`candle-harness bots restart ${name}\` starts it again with its code now.` }
      if (!w.start) throw refused("BOT_WONT_START", `"${name}" isn't started: ${w.why ?? "it can't run now"}.`)
      const s = this.savedOf(name)
      const was = s.where === "outside" ? " It ran outside the Candle Harness; its token there no longer connects." : ""
      delete s.where
      delete s.down
      delete s.gaveUp
      r.crashes = []
      r.ended = undefined
      if (r.restartTimer) clearTimeout(r.restartTimer)
      r.restartTimer = undefined
      r.restartAt = undefined
      await this.persist()
      await this.launch(name, w.spec!, "person")
      const live = this.runtime(name).live
      return { said: live ? `"${name}" is running (pid ${live.pid}).${was}` : `"${name}" didn't start: ${this.runtime(name).lastExit ?? this.runtime(name).waits ?? "see its log"}.${was}` }
    })
  }

  /** `candle-harness bots stop <name>`: ends its process, and leaves the bot on: its held exits still run. It stays down until it's started again. */
  async stopByPerson(name: string): Promise<{ said: string }> {
    return this.serial(async () => {
      if (!this.deps.names().includes(name)) throw refused("UNKNOWN_BOT", `No code bot named "${name}" runs here.`)
      const r = this.runtime(name)
      const s = this.savedOf(name)
      if (s.where === "outside") return { said: `"${name}" runs outside the Candle Harness, so there's no process here to stop. Stop it where it runs; \`candle-harness bots start ${name}\` runs it here instead.` }
      s.down = { at: new Date(this.deps.now()).toISOString() }
      if (r.restartTimer) clearTimeout(r.restartTimer)
      r.restartTimer = undefined
      r.restartAt = undefined
      await this.persist()
      const after = "The bot stays on: the exits the core holds on its positions still run. `candle-harness bots start " + name + "` runs it again."
      if (!r.live) {
        this.deps.onChange()
        return { said: `"${name}" wasn't running, and won't be started until you start it. ${after}` }
      }
      const pid = r.live.pid
      await this.end(name, r.live, "down", "you stopped its process")
      return { said: `"${name}"'s process (pid ${pid}) is stopped. ${after}` }
    })
  }

  /** `candle-harness bots restart <name>`: ends its process and starts it again, with its code as it is now. */
  async restart(name: string): Promise<{ said: string }> {
    const r = this.runtime(name)
    if (!r.live) return this.startByPerson(name)
    return this.serial(async () => {
      const w = this.deps.wanted(name)
      if (!w.start || !w.spec) throw refused("BOT_WONT_START", `"${name}" can't start again now: ${w.why ?? "it can't run now"}. It's left running.`)
      const live = this.runtime(name).live
      if (live) await this.end(name, live, "restart", "you restarted it")
      const s = this.savedOf(name)
      delete s.down
      delete s.gaveUp
      await this.persist()
      await this.launch(name, w.spec, "person")
      const now = this.runtime(name).live
      return { said: now ? `"${name}" started again (pid ${now.pid}).` : `"${name}" didn't start again: ${this.runtime(name).lastExit ?? "see its log"}.` }
    })
  }

  /**
   * `candle-harness bots token <name>`: for a bot run elsewhere. Its process here ends, a new token is written to a
   * 0600 file in its folder (never shown), and it shows as running outside the Candle Harness until it's started here.
   */
  async outside(name: string): Promise<{ file: string; said: string; warning?: string }> {
    return this.serial(async () => {
      const w = this.deps.wanted(name)
      if (!w.spec) throw refused("UNKNOWN_BOT", w.why ?? `No code bot named "${name}" is approved here.`)
      const r = this.runtime(name)
      if (r.live) await this.end(name, r.live, "outside", "it runs outside the Candle Harness now")
      if (r.restartTimer) clearTimeout(r.restartTimer)
      r.restartTimer = undefined
      r.restartAt = undefined
      const { token } = await this.deps.issueToken(name, "outside")
      const file = join(w.spec.folder, BOT_TOKEN_FILE)
      const temp = `${file}.tmp-${process.pid}-${Date.now()}`
      await writeFile(temp, `${JSON.stringify({ bot: name, socket: this.deps.socketPath, token }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
      await rename(temp, file)
      const s = this.savedOf(name)
      s.where = "outside"
      delete s.down
      delete s.gaveUp
      r.crashes = []
      await this.persist()
      this.deps.onChange()
      // The token file is never committed by the core's doing, and the person's .gitignore is never written: where
      // their git would pick the file up, they're told.
      const ignored = await (this.deps.gitIgnores ?? gitIgnores)(w.spec.folder, BOT_TOKEN_FILE)
      const warning = ignored === false ? TOKEN_NOT_IGNORED : undefined
      return { file, ...(warning ? { warning } : {}), said: `"${name}"'s token is in ${file}, readable by you alone. The client reads it there, so run the bot from that folder however you like. It shows as running outside the Candle Harness, with no restarts or logs, until \`candle-harness bots start ${name}\` runs it here again, which replaces the token.${warning ? `\n${warning}` : ""}` }
    })
  }

  view(name: string): BotProcessView {
    const r = this.runtime(name)
    const s = this.saved[name] ?? {}
    const log = logFileOf(this.deps.logsDir, name)
    const crashes = this.recentCrashes(r)
    const base = {
      ...(crashes ? { crashes } : {}),
      ...(r.lastExit ? { lastExit: r.lastExit } : {}),
      ...(r.usage ? { memoryMb: Math.round(r.usage.rssKb / 1024), ...(r.usage.cpuPct !== undefined ? { cpuPct: Math.round(r.usage.cpuPct) } : {}) } : {}),
      ...(r.warning ? { warning: r.warning } : {}),
    }
    if (s.where === "outside") {
      if (this.deps.hasToken?.(name) === false) return { runs: "outside", state: "outside", words: `ran outside the Candle Harness: its token is withdrawn. \`candle-harness bots token ${name}\` writes a new one, or \`candle-harness bots start ${name}\` runs it here` }
      return { runs: "outside", state: "outside", words: "runs outside the Candle Harness: no restarts or logs here" }
    }
    if (r.live) return { runs: "harness", state: "running", pid: r.live.pid, since: new Date(r.live.startedAt).toISOString(), words: `running since ${hhmm(r.live.startedAt)} (pid ${r.live.pid})`, log, ...base }
    if (r.starting) return { runs: "harness", state: "starting", words: "starting", log, ...base }
    if (s.gaveUp) return { runs: "harness", state: "gave_up", words: `crashed ${plural(s.gaveUp.crashes, "time")} in ${secs(this.t.crashWindowMs)}, so it isn't started again: \`candle-harness bots start ${name}\` runs it again`, log, ...base }
    if (s.down) return { runs: "harness", state: "down", words: `its process was stopped at ${hhmm(Date.parse(s.down.at))}; the bot stays on and its held exits still run. \`candle-harness bots start ${name}\` runs it again`, log, ...base }
    if (r.restartAt !== undefined) return { runs: "harness", state: "restarting", restartAt: new Date(r.restartAt).toISOString(), words: `${r.lastExit ?? "crashed"}; starts again in ${secs(Math.max(0, r.restartAt - this.deps.now()))} (${plural(crashes, "crash", "crashes")} in ${secs(this.t.crashWindowMs)})`, log, ...base }
    if (r.ended) return { runs: "harness", state: "ended", words: `${r.ended}: \`candle-harness bots start ${name}\` runs it again`, log, ...base }
    const w = this.deps.wanted(name)
    return { runs: "harness", state: "waits", words: r.waits ?? (w.why ? `not running: ${w.why}` : "not running"), log, ...base }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private runtime(name: string): Runtime {
    let r = this.rt.get(name)
    if (!r) this.rt.set(name, (r = { crashes: [] }))
    return r
  }

  private savedOf(name: string): Saved {
    return (this.saved[name] ??= {})
  }

  private recentCrashes(r: Runtime): number {
    const since = this.deps.now() - this.t.crashWindowMs
    r.crashes = r.crashes.filter((t) => t >= since)
    return r.crashes.length
  }

  private async pass(): Promise<void> {
    if (this.stopped) return
    const names = new Set(this.deps.names())
    // A bot removed: its process ends, and what was kept of it goes.
    for (const [name, r] of this.rt) {
      if (names.has(name)) continue
      if (r.restartTimer) clearTimeout(r.restartTimer)
      if (r.live) await this.end(name, r.live, "removed", "the bot was removed")
      this.rt.delete(name)
    }
    for (const name of Object.keys(this.saved)) if (!names.has(name)) delete this.saved[name]
    for (const name of names) {
      const r = this.runtime(name)
      const s = this.savedOf(name)
      const w = this.deps.wanted(name)
      if (r.live) {
        if (!w.keep) await this.end(name, r.live, "stopped", w.why ? `it doesn't run now: ${w.why}` : "it doesn't run now")
        else if (w.spec && (w.spec.folder !== r.live.spec.folder || w.spec.command.join("\0") !== r.live.spec.command.join("\0"))) {
          await this.end(name, r.live, "restart", "a new version was approved")
          if (w.start) await this.launch(name, w.spec, "approved")
        }
        continue
      }
      if (!w.keep && r.restartTimer) {
        clearTimeout(r.restartTimer)
        r.restartTimer = undefined
        r.restartAt = undefined
      }
      if (s.where === "outside" || s.down || s.gaveUp || r.ended || r.starting || r.restartTimer) continue
      if (!w.start || !w.spec) {
        r.waits = w.why ? `not running: ${w.why}` : undefined
        continue
      }
      await this.launch(name, w.spec, "core")
    }
    await this.persist()
    this.deps.onChange()
  }

  /** Starts one bot: its token, its code's hash journalled, its process in its own group, its output to its log. */
  private async launch(name: string, spec: BotRunSpec, by: "core" | "person" | "approved" | "restart"): Promise<void> {
    const r = this.runtime(name)
    if (r.live || r.starting || this.stopped) return
    r.starting = true
    r.waits = undefined
    this.deps.onChange()
    const log = new BotLog(logFileOf(this.deps.logsDir, name), { cap: this.t.logBytes, perMinute: this.t.logBytesPerMinute, redact: this.deps.redact, now: this.deps.now })
    try {
      const folder = await stat(spec.folder).catch(() => undefined)
      if (!folder?.isDirectory()) {
        await log.close()
        r.starting = false
        await this.failed(name, spec, `couldn't start: its folder ${spec.folder} isn't there`)
        return
      }
      const code = await codeHash(spec.folder, spec.command)
      const mark = codeMark(code)
      const lastMark = this.savedOf(name).code
      if (lastMark !== undefined && lastMark !== mark) code.changed = true
      let token: string
      try {
        ;({ token } = await this.deps.issueToken(name, "start"))
      } catch (error) {
        await log.close()
        r.starting = false
        r.waits = `not running: ${(error as Error).message}`
        this.deps.onChange()
        return
      }
      const env = { ...harnessEnv(this.deps.parentEnv), CANDLE_HARNESS_SOCKET: this.deps.socketPath, CANDLE_HARNESS_BOT_TOKEN: token, CANDLE_HARNESS_BOT: name }
      let proc: ReturnType<typeof Bun.spawn>
      try {
        proc = Bun.spawn([...spec.command], { cwd: spec.folder, env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      } catch (error) {
        await log.close()
        r.starting = false
        await this.failed(name, spec, `couldn't start ${spec.command[0]}: ${(error as Error).message}`)
        return
      }
      const startedAt = this.deps.now()
      const live: Live = { spec, proc, pid: proc.pid, startedAt, log, exited: Promise.resolve() }
      r.live = live
      r.starting = false
      r.restartAt = undefined
      r.usage = undefined
      r.lastCpu = undefined
      r.warning = undefined
      for (const [stream, which] of [
        [proc.stdout, "out"],
        [proc.stderr, "err"],
      ] as const) {
        if (!stream || typeof stream === "number") continue
        void (async () => {
          const decoder = new TextDecoder()
          for await (const chunk of stream as ReadableStream<Uint8Array>) log.feed(which, decoder.decode(chunk, { stream: true }))
        })().catch(() => {})
      }
      const args = spec.command.join(" ")
      // Said before anything is awaited: a bot that exits at once has its log closed by `exited`, and its "ended"
      // must come after this line.
      log.note(`started (pid ${proc.pid}): ${args} in ${spec.folder} · code ${code.hash.slice(0, 12)}${code.lockfile ? ` · ${code.lockfile.name} ${code.lockfile.hash.slice(0, 12)}` : ""}${code.changed ? " · its code changed since its last start" : ""}`)
      live.exited = proc.exited.then(() => this.exited(name, live))
      const boot = (this.deps.boot ?? machineBoot)()
      // Its pid is written at once, so a core that dies now still knows of it; then what `ps` says of it (its
      // start time and command line) is added before the start goes on. A later core tells by these that the
      // number still names this process, and without them falls back on the bot's own environment.
      this.savedOf(name).running = { pid: proc.pid, at: new Date(startedAt).toISOString(), args, ...(boot ? { boot } : {}) }
      this.savedOf(name).code = mark
      await this.persist()
      const id = await (this.deps.identify ?? psIdentify)(proc.pid).catch(() => undefined)
      const recorded = this.saved[name]?.running
      if (id && recorded?.pid === proc.pid) Object.assign(recorded, { started: id.started, args: id.args })
      await this.deps.journal.append({
        type: "bot.process",
        mode: this.deps.mode(),
        kind: "code",
        agent: spec.agent,
        name,
        what: "started",
        by,
        pid: proc.pid,
        code,
      })
      await this.persist()
      this.deps.onChange()
    } catch (error) {
      r.starting = false
      await log.close()
      r.waits = `not running: ${(error as Error).message}`
      this.deps.onChange()
    }
  }

  /** A start that couldn't happen counts as a crash: restarted after its back-off, and five in ten minutes stop it. */
  private async failed(name: string, spec: BotRunSpec, words: string): Promise<void> {
    await this.crashed(name, spec, words, undefined)
  }

  private async exited(name: string, live: Live): Promise<void> {
    const r = this.runtime(name)
    // Anything it left in its group goes with it.
    signalGroup(live.pid, "SIGKILL")
    const code = live.proc.exitCode
    const signal = live.proc.signalCode
    const how = exitWords(code, signal)
    const ranMs = this.deps.now() - live.startedAt
    live.log.note(`ended (${how}) after ${secs(ranMs)}${live.stopping ? `: ${live.stopping.words}` : ""}`)
    await live.log.close()
    if (r.live === live) r.live = undefined
    const s = this.savedOf(name)
    if (s.running?.pid === live.pid) delete s.running
    if (live.stopping) {
      r.lastExit = `stopped at ${hhmm(this.deps.now())}: ${live.stopping.words}`
      await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", agent: live.spec.agent, name, what: "stopped", why: live.stopping.why, words: live.stopping.words, pid: live.pid, exit: how })
      // Stopped and not started again by itself: its token ends, so a process it started outside its group can't
      // trade on. A restart, the core's stop and a move outside each replace or keep the token by their own rule.
      if (live.stopping.why === "down" || live.stopping.why === "stopped") await this.deps.endToken?.(name, "process_stopped")?.catch(() => {})
      await this.persist()
      this.deps.onChange()
      return
    }
    if (ranMs >= this.t.stableMs) r.crashes = []
    if (code === 0 && !signal) {
      r.ended = `ended on its own at ${hhmm(this.deps.now())} (exit 0)`
      r.lastExit = r.ended
      await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", agent: live.spec.agent, name, what: "ended", pid: live.pid, exit: how, words: "ended on its own (exit 0), so it isn't started again until you start it" })
      await this.deps.endToken?.(name, "process_ended")?.catch(() => {})
      await this.persist()
      this.deps.onChange()
      return
    }
    await this.crashed(name, live.spec, `crashed (${how}) at ${hhmm(this.deps.now())}`, live.pid)
  }

  private async crashed(name: string, spec: BotRunSpec, words: string, pid: number | undefined): Promise<void> {
    const r = this.runtime(name)
    r.crashes.push(this.deps.now())
    const n = this.recentCrashes(r)
    r.lastExit = words
    if (this.stopped) return
    if (n >= this.t.crashLimit) {
      this.savedOf(name).gaveUp = { at: new Date(this.deps.now()).toISOString(), crashes: n }
      r.restartAt = undefined
      await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", agent: spec.agent, name, what: "gave_up", crashes: n, ...(pid ? { pid } : {}), words: `${words}: ${plural(n, "crash", "crashes")} in ${secs(this.t.crashWindowMs)}, so it isn't started again until you start it` })
      await this.deps.endToken?.(name, "process_gave_up")?.catch(() => {})
      await this.persist()
      this.deps.onChange()
      return
    }
    const delay = this.t.backoffMs[Math.min(n - 1, this.t.backoffMs.length - 1)] ?? 60_000
    r.restartAt = this.deps.now() + delay
    await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", agent: spec.agent, name, what: "crashed", crashes: n, restartInMs: delay, ...(pid ? { pid } : {}), words: `${words}; it starts again in ${secs(delay)}` })
    r.restartTimer = setTimeout(() => {
      r.restartTimer = undefined
      r.restartAt = undefined
      void this.serial(async () => {
        const w = this.deps.wanted(name)
        const s = this.savedOf(name)
        if (r.live || s.where === "outside" || s.down || s.gaveUp) return
        if (w.start && w.spec) await this.launch(name, w.spec, "restart")
        else r.waits = w.why ? `not running: ${w.why}` : undefined
        this.deps.onChange()
      })
    }, delay)
    r.restartTimer.unref?.()
    await this.persist()
    this.deps.onChange()
  }

  /** Ends a bot's process group: SIGTERM, then SIGKILL after the grace. Resolves once it's gone and said. */
  private async end(_name: string, live: Live, why: NonNullable<Live["stopping"]>["why"], words: string): Promise<void> {
    if (!live.stopping) live.stopping = { why, words }
    signalGroup(live.pid, "SIGTERM")
    const kill = setTimeout(() => signalGroup(live.pid, "SIGKILL"), this.t.stopGraceMs)
    await live.exited
    clearTimeout(kill)
  }

  /**
   * A bot an earlier core started and didn't stop: ended, once what's recorded is checked to be that bot. A
   * recorded number alone is never signalled: the machine may have restarted since, or the number may have gone
   * to another process or group. A group that can't be told to be the bot's is left, and said.
   */
  private async endLeftover(name: string, was: NonNullable<Saved["running"]>): Promise<void> {
    const pid = was.pid
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
    // Recorded before this machine last started: the number names nothing of ours now.
    const boot = (this.deps.boot ?? machineBoot)()
    if (was.boot !== undefined && boot !== undefined && was.boot !== boot) return
    const carries = () => (this.deps.groupIsBot ? this.deps.groupIsBot(pid, name) : groupCarriesBot(pid, name, this.deps.socketPath))
    let ours = false
    if (pidIsAlive(pid)) {
      const id = await (this.deps.identify ?? psIdentify)(pid)
      // The same command line and start time; with no start time recorded, the bot's own environment instead.
      ours = !!id && id.args === was.args && (was.started ? id.started === was.started : await carries())
    } else if (groupAlive(pid)) {
      // Its leader is gone and something still runs under its group's number: the bot's own children, or an
      // unrelated group given the number since. Only a member carrying the bot's environment says which.
      ours = await carries()
      if (!ours) {
        await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", name, what: "warning", pid, words: `an earlier core left process group ${pid} recorded for it, and what runs there now can't be told to be its own, so it was left alone. Its token is replaced when it starts, so anything of its left running can't trade` })
      }
    }
    if (!ours) return
    signalGroup(pid, "SIGTERM")
    const until = Date.now() + this.t.stopGraceMs
    while (groupAlive(pid) && Date.now() < until) await Bun.sleep(50)
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL")
    await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", name, what: "stopped", why: "leftover", pid, words: "an earlier core didn't stop it, so it was ended before starting it again" })
  }

  private async sample(): Promise<void> {
    if (this.stopped || !this.runningCount()) return
    const read = await (this.deps.sample ?? psSample)()
    const now = this.deps.now()
    let changed = false
    for (const [name, r] of this.rt) {
      const live = r.live
      if (!live) continue
      const got = read.get(live.pid)
      if (!got) continue
      const cpuPct = r.lastCpu && now > r.lastCpu.at ? (Math.max(0, got.cpuSec - r.lastCpu.sec) / ((now - r.lastCpu.at) / 1000)) * 100 : undefined
      r.lastCpu = { sec: got.cpuSec, at: now }
      r.usage = { rssKb: got.rssKb, ...(cpuPct !== undefined ? { cpuPct } : {}) }
      changed = true
      const mb = got.rssKb / 1024
      const over = [...(mb > this.t.memoryWarnMb ? [`it uses ${Math.round(mb)} MB of memory, past ${this.t.memoryWarnMb} MB`] : []), ...(cpuPct !== undefined && cpuPct > this.t.cpuWarnPct ? [`it used ${Math.round(cpuPct)}% of a CPU core over the last minute, past ${this.t.cpuWarnPct}%`] : [])]
      if (over.length && !r.warning) {
        r.warning = over.join("; ")
        live.log.note(`warning: ${r.warning}`)
        await this.deps.journal.append({ type: "bot.process", mode: this.deps.mode(), kind: "code", agent: live.spec.agent, name, what: "warning", pid: live.pid, memoryMb: Math.round(mb), ...(cpuPct !== undefined ? { cpuPct: Math.round(cpuPct) } : {}), words: r.warning })
      } else if (!over.length && r.warning) r.warning = undefined
    }
    if (changed) this.deps.onChange()
  }

  private async persist(): Promise<void> {
    const bots = Object.fromEntries(Object.entries(this.saved).filter(([, s]) => Object.keys(s).length > 0))
    const temp = `${this.deps.statePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await writeFile(temp, `${JSON.stringify({ bots })}\n`, { mode: 0o600, flag: "wx" })
      await rename(temp, this.deps.statePath)
    } catch {
      await rm(temp, { force: true }).catch(() => {})
    }
  }
}
