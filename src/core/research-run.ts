// research_run, the code runner: the agent runs one program from its list (`[agents.<name>.tools] run`, such as
// ["python3", "bun", "node"]) in its research folder, held there by the operating system (hold.ts): reads and
// writes inside the folder only, the runtime's own install read-only, no network, 60 seconds, a data cap, and
// 16 KB of output back. The stop takes everything the program started: on Linux nothing can leave its process
// group (the hold refuses setsid and setpgid); on macOS, where Seatbelt can't refuse that, the runner follows
// the program's descendants from the moment it starts and stops those too, then every process in a sandbox that
// the hold could have started during the run and that lost its parent (a double fork). A run never waits on a pipe something left open. Off for every agent until its list is set, and offered only where this machine can hold
// it. The core runs it, so it's the same on every engine; its runs are journalled with the command.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
export { RUN_EXAMPLE, runEntryFault, runOn, type RunSetting, runWords } from "../engine/tools"
import { HOLD_DATA_LIMIT, RuntimePlaceRefused, appleShimWithoutTools, heldCommand, heldEnv, holdSupport, inSandbox, installReads, seatbeltExecRoots } from "./hold"

export const RUN_TIMEOUT_MS = 60_000
export const RUN_OUTPUT_BYTES = 16 * 1024
const MAX_ARGS = 64
const MAX_ARG_BYTES = 4096
const MAX_CODE_BYTES = 64 * 1024
const KEPT_SCRIPTS = 20
/** How long output is still read after the program itself has ended, before the pipes are let go. */
export const RUN_OUTPUT_GRACE_MS = 250

/** What the picker, the palette and the doctor say about the hold. */
export const RUN_HOLD_WORDS = "held to the research folder by the system, with no network, 60 s a run"

export function runTool(programs: readonly string[]) {
  return {
    name: "research_run",
    description: `Runs one program in your research folder and returns its output: ${programs.join(", ")}. Use it to compute, chart or analyse from your notes and files there. Pass code to run it as a script (saved in .runs/ in the folder), or args to run a file of yours, such as ["chart.py"]. The program is held to your research folder by the system: it reads and writes only there, has no network, and stops after 60 seconds. Output over 16 KB is cut, so print what you need. It never reaches Candle: everything on Candle goes through Candle's tools.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        program: { type: "string", enum: [...programs], description: "The program to run." },
        code: { type: "string", description: "A script to run, saved in .runs/ and passed as the first argument." },
        args: { type: "array", items: { type: "string" }, description: 'Its arguments, such as ["chart.py", "--hours", "1"].' },
      },
      required: ["program"],
    },
  }
}

export interface RunRow {
  program: string
  args: string[]
  script?: string
  exitCode: number | null
  signal?: string
  timedOut?: boolean
  ms: number
  outBytes: number
  errBytes: number
}

export type RunAnswer = { ok: true; body: Record<string, unknown>; row: RunRow } | { ok: false; code: string; message: string; row?: RunRow }

export interface RunOptions {
  /** The agent's research folder. */
  root: string
  programs: readonly string[]
  args: Record<string, unknown>
  /** The PATH programs are found on: the core's. */
  path: string | undefined
  home: string | undefined
  /** Folders a runtime's read-only grant must never open: the Harness's own, with its keys. */
  keep?: readonly string[]
  /** This program, as the Linux exec stage runs it (registry.ts's selfCommand). */
  self: readonly string[]
  platform?: NodeJS.Platform
  /** Whether this Mac has the Command Line Tools, which Apple's python3 shim needs. */
  commandLineTools?: () => boolean
  timeoutMs?: number
  now?: () => number
}

const refuse = (code: string, message: string): RunAnswer => ({ ok: false, code, message })

const EXTENSIONS: Record<string, string> = { python: ".py", node: ".mjs", bun: ".ts", deno: ".ts", ruby: ".rb", perl: ".pl", Rscript: ".R", julia: ".jl", lua: ".lua", php: ".php" }
/** A saved script's extension, by its program's name: `python3.12` is python's. */
const extensionFor = (program: string): string => EXTENSIONS[basename(program).replace(/[0-9.]+$/, "")] ?? ""

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)

/** The agent's runs go one at a time: a second waits for the first. */
const queues = new Map<string, Promise<unknown>>()

export function researchRun(o: RunOptions): Promise<RunAnswer> {
  const prior = queues.get(o.root) ?? Promise.resolve()
  const next = prior.then(() => runOnce(o))
  queues.set(
    o.root,
    next.catch(() => {}),
  )
  return next
}

async function runOnce(o: RunOptions): Promise<RunAnswer> {
  const now = o.now ?? Date.now
  const platform = o.platform ?? process.platform
  const { program, code, args: given } = o.args
  if (typeof program !== "string" || !o.programs.includes(program)) return refuse("INVALID_ARGS", `program is one of ${o.programs.join(", ")}.`)
  const args = given === undefined ? [] : given
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && !a.includes("\0") && Buffer.byteLength(a) <= MAX_ARG_BYTES)) {
    return refuse("INVALID_ARGS", `args is a list of up to ${MAX_ARGS} strings.`)
  }
  if (code !== undefined && (typeof code !== "string" || code.includes("\0") || Buffer.byteLength(code) > MAX_CODE_BYTES)) return refuse("INVALID_ARGS", `code is a script of up to ${MAX_CODE_BYTES / 1024} KB.`)

  const support = await holdSupport(platform)
  if (!support.ok) return refuse("NOT_HELD", `The code runner can't be held on this machine, so it ran nothing: ${support.why}.`)
  const found = isAbsolute(program) ? program : Bun.which(program, { PATH: o.path ?? "/usr/bin:/bin" })
  if (!found) return refuse("NOT_INSTALLED", `${program} isn't installed on this machine, so it ran nothing.`)
  let bin: string
  let folder: string
  try {
    bin = realpathSync(found)
    folder = realpathSync(o.root)
  } catch {
    return refuse("NOT_FOUND", "Your research folder doesn't exist yet: write a note first.")
  }
  if (appleShimWithoutTools(bin, platform, o.commandLineTools)) {
    return refuse("NOT_INSTALLED", `${program} is Apple's shim and this Mac has no Command Line Tools, so it ran nothing. Install them with xcode-select --install.`)
  }
  await mkdir(join(folder, ".tmp"), { recursive: true })

  let script: string | undefined
  if (typeof code === "string") {
    const runs = join(folder, ".runs")
    await mkdir(runs, { recursive: true })
    script = join(".runs", `run-${stamp(now())}-${Math.random().toString(16).slice(2, 6)}${extensionFor(bin)}`)
    await writeFile(join(folder, script), code)
    // The newest few are kept, for the agent to run again; older ones go.
    const all = (await readdir(runs)).filter((n) => n.startsWith("run-")).sort()
    for (const old of all.slice(0, Math.max(0, all.length - KEPT_SCRIPTS))) await rm(join(runs, old), { force: true })
  }
  const argv = [...(script ? [script] : []), ...(args as string[])]
  let reads: string[]
  try {
    reads = installReads(bin, o.home, o.keep).filter((r) => !r.includes(","))
  } catch (error) {
    if (!(error instanceof RuntimePlaceRefused)) throw error
    return refuse("RUNTIME_PLACE", `${program} is installed in a folder that holds your own files (${bin}), and a script it ran could read them, so it ran nothing. Install ${program} in a folder of its own.`)
  }

  const command = heldCommand(platform, folder, reads, bin, argv, o.self)
  // The stage holds itself before it runs anything; on macOS sandbox-exec takes the held program's environment.
  const env = platform === "darwin" ? heldEnv(folder, bin) : { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(o.home ? { HOME: o.home } : {}) }
  const started = now()
  // Linux's stage is this binary, and it moves into the folder itself once it has started.
  const child = Bun.spawn(command, { cwd: platform === "darwin" ? folder : "/", env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
  const group = child.pid
  // What the program started, where it can leave its group (macOS): followed while it runs, stopped with it.
  const tree = platform === "darwin" ? new ProcessTree(group) : undefined
  const killGroup = () => {
    try {
      process.kill(-group, "SIGKILL")
    } catch {}
  }
  // A child that leaves the group and whose parent ends before the tree sees it is followed by nothing: at the end,
  // every process in a sandbox that the hold could have started since the run began is stopped too.
  const roots = tree ? seatbeltExecRoots(folder, reads, bin) : []
  const uid = process.getuid?.() ?? -1
  const killAll = async () => {
    killGroup()
    if (!tree) return
    for (const pid of tree.alive(await psRows())) killPid(pid)
    for (const pid of await sandboxStrays(await strayRows(), { uid, ranSeconds: (now() - started) / 1000, roots, self: process.pid }, inSandbox)) killPid(pid)
  }
  let timedOut = false
  let overMemory = false
  const timer = setTimeout(() => {
    timedOut = true
    void killAll()
  }, o.timeoutMs ?? RUN_TIMEOUT_MS)
  // macOS has no data limit a held process can't raise, so the runner watches the memory of everything it follows.
  // Followed from the start: read at once, then every 50 ms for the first 2 s, when a child is likeliest to leave.
  const look = () =>
    void psRows().then((rows) => {
      if (!tree) return
      tree.see(rows)
      if (tree.rss(rows) > HOLD_DATA_LIMIT) {
        overMemory = true
        void killAll()
      }
    })
  if (tree) look()
  const early = tree ? setInterval(look, 50) : undefined
  const settle = early ? setTimeout(() => clearInterval(early), 2_000) : undefined
  const watch = tree ? setInterval(look, 500) : undefined
  const outRead = readCapped(child.stdout)
  const errRead = readCapped(child.stderr)
  const exitCode = await child.exited
  // The program has ended. Whatever it left behind is stopped, and its output is read for a moment more, never
  // to the end of a pipe: a process that escaped the stop and kept the pipe open would hold the agent's queue.
  if (tree) tree.see(await psRows())
  await killAll()
  clearTimeout(timer)
  if (watch) clearInterval(watch)
  if (early) clearInterval(early)
  if (settle) clearTimeout(settle)
  const settled = Promise.all([outRead.done, errRead.done])
  await Promise.race([settled, Bun.sleep(RUN_OUTPUT_GRACE_MS)])
  outRead.stop()
  errRead.stop()
  const [out, err] = await settled
  const ms = now() - started
  const errText = err.kept.toString("utf8")
  const row: RunRow = {
    program,
    args: argv.slice(0, 16).map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)),
    ...(script ? { script } : {}),
    exitCode: child.signalCode ? null : exitCode,
    ...(child.signalCode ? { signal: String(child.signalCode) } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ms,
    outBytes: out.total,
    errBytes: err.total,
  }
  if (platform !== "darwin" && exitCode === 126 && errText.startsWith("not held: ")) {
    return { ok: false, code: "NOT_HELD", message: `The code runner couldn't hold ${program}, so it ran nothing: ${errText.slice(10).trim()}.`, row }
  }
  // Both streams share the 16 KB: errors keep at least 4 KB of it.
  const errShare = Math.min(err.kept.length, Math.max(4096, RUN_OUTPUT_BYTES - out.kept.length))
  const outShare = Math.min(out.kept.length, RUN_OUTPUT_BYTES - errShare)
  const text = (b: Buffer) => b.toString("utf8").replace(/\0/g, "")
  const cut = out.total > outShare || err.total > errShare
  return {
    ok: true,
    row,
    body: {
      program,
      args: argv,
      ...(script ? { script } : {}),
      exitCode: row.exitCode,
      ...(row.signal ? { signal: row.signal } : {}),
      ...(timedOut ? { stopped: `It ran past ${Math.round((o.timeoutMs ?? RUN_TIMEOUT_MS) / 1000)} seconds and was stopped.` } : {}),
      ...(overMemory ? { stopped: "It used over 1 GB of memory and was stopped." } : {}),
      seconds: Math.round(ms / 100) / 10,
      stdout: text(out.kept.subarray(0, outShare)),
      stderr: text(err.kept.subarray(0, errShare)),
      ...(cut ? { cut: `The output was cut to ${RUN_OUTPUT_BYTES / 1024} KB (stdout ${out.total} bytes, stderr ${err.total} bytes): print less, or write it to a file and read the part you need.` } : {}),
    },
  }
}

/** A stream read until it ends or `stop` is called, keeping its first RUN_OUTPUT_BYTES. */
function readCapped(stream: ReadableStream<Uint8Array>): { done: Promise<{ kept: Buffer; total: number }>; stop(): void } {
  const reader = stream.getReader()
  const parts: Buffer[] = []
  let kept = 0
  let total = 0
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: ended } = await reader.read()
        if (ended) break
        total += value.length
        if (kept < RUN_OUTPUT_BYTES) {
          const part = Buffer.from(value.subarray(0, RUN_OUTPUT_BYTES - kept))
          parts.push(part)
          kept += part.length
        }
      }
    } catch {
      // Let go mid-read: what was read stands.
    }
    return { kept: Buffer.concat(parts), total }
  })()
  return { done, stop: () => void reader.cancel().catch(() => {}) }
}

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  rssKb: number
}

/** `ps -A -o pid=,ppid=,pgid=,rss=`, read into rows. */
export function parsePs(out: string): PsRow[] {
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((f) => f.length === 4 && f.every((n) => Number.isInteger(n) && n >= 0))
    .map(([pid, ppid, pgid, rssKb]) => ({ pid: pid!, ppid: ppid!, pgid: pgid!, rssKb: rssKb! }))
}

/** Every process's pid, parent, group and memory, by `ps` at its full path. */
export async function psRows(): Promise<PsRow[]> {
  try {
    const ps = Bun.spawn(["/bin/ps", "-A", "-o", "pid=,ppid=,pgid=,rss="], { stdout: "pipe", stderr: "ignore" })
    return parsePs(await new Response(ps.stdout).text())
  } catch {
    return []
  }
}

export interface StrayRow {
  pid: number
  ppid: number
  uid: number
  /** How long it has run, in seconds. */
  ageS: number
  /** The program it runs, by its path. */
  command: string
}

/** `ps`'s elapsed time, [[dd-]hh:]mm:ss, in seconds; NaN when it isn't one. */
export function elapsed(text: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text)
  if (!m) return Number.NaN
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4])
}

/** `ps -A -o pid=,ppid=,uid=,etime=,comm=`, read into rows; the program's path may hold spaces. */
export function parseStrayPs(out: string): StrayRow[] {
  const rows: StrayRow[] = []
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!m) continue
    const ageS = elapsed(m[4]!)
    if (Number.isNaN(ageS)) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), ageS, command: m[5]!.trim() })
  }
  return rows
}

/** Every process's pid, parent, owner, age and program, by `ps` at its full path. */
export async function strayRows(): Promise<StrayRow[]> {
  try {
    const ps = Bun.spawn(["/bin/ps", "-A", "-o", "pid=,ppid=,uid=,etime=,comm="], { stdout: "pipe", stderr: "ignore" })
    return parseStrayPs(await new Response(ps.stdout).text())
  } catch {
    return []
  }
}

/**
 * The macOS hold's strays: the person's processes in a sandbox, started since the run began, running a program from
 * a folder the hold's profile lets run, that were handed to the system's first process (their parent gone), and
 * whatever those started under them. A double fork whose middle process ends at once is found here, whatever group
 * or session it moved to; `sandboxed` asks the system which processes are in a sandbox at all.
 */
export async function sandboxStrays(
  rows: readonly StrayRow[],
  o: { uid: number; ranSeconds: number; roots: readonly string[]; self: number },
  sandboxed: (pid: number) => Promise<boolean>,
): Promise<number[]> {
  const fits = (r: StrayRow) =>
    r.uid === o.uid && r.pid !== o.self && r.ageS <= o.ranSeconds + 1 && o.roots.some((root) => r.command === root || r.command.startsWith(root.endsWith("/") ? root : `${root}/`))
  const found = new Set<number>()
  const asked = new Map<number, boolean>()
  const isSandboxed = async (pid: number) => asked.get(pid) ?? (asked.set(pid, await sandboxed(pid)), asked.get(pid)!)
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) {
      if (found.has(r.pid) || !fits(r) || !(r.ppid === 1 || found.has(r.ppid))) continue
      if (!(await isSandboxed(r.pid))) continue
      found.add(r.pid)
      grew = true
    }
  }
  return [...found]
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

/**
 * The processes a held program started, followed from `ps` while it runs: everything in its group, and every
 * child of something already followed, whatever group or session it moved itself to. A child whose parent has
 * gone is handed to the system's first process and can't be found by its parent any more, so each is recorded
 * when first seen, with the parent it had then.
 */
export class ProcessTree {
  private readonly seen = new Map<number, number>()

  constructor(private readonly root: number) {}

  /** Takes in one reading of `ps`. */
  see(rows: readonly PsRow[]): void {
    const present = new Set(rows.map((r) => r.pid))
    // A recorded pid that's gone is forgotten, so a later process given the same number isn't taken for it.
    for (const pid of [...this.seen.keys()]) if (!present.has(pid)) this.seen.delete(pid)
    for (let grew = true; grew; ) {
      grew = false
      for (const r of rows) {
        if (this.seen.has(r.pid) || r.pid === process.pid) continue
        if (r.pid === this.root || r.pgid === this.root || this.seen.has(r.ppid)) {
          this.seen.set(r.pid, r.ppid)
          grew = true
        }
      }
    }
  }

  /**
   * The followed processes still running in `rows`: each with the parent it was recorded with, or handed to the
   * system's first process since. One whose number now belongs to something else's child isn't among them.
   */
  alive(rows: readonly PsRow[]): number[] {
    return rows.filter((r) => this.seen.has(r.pid) && (r.ppid === this.seen.get(r.pid) || r.ppid === 1)).map((r) => r.pid)
  }

  /** The resident memory of everything followed, in bytes. */
  rss(rows: readonly PsRow[]): number {
    const mine = new Set(this.alive(rows))
    return rows.filter((r) => mine.has(r.pid) || r.pgid === this.root).reduce((sum, r) => sum + r.rssKb * 1024, 0)
  }
}
