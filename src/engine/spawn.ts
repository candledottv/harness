// Starting harnesses. Every harness gets a clean environment
// (`harnessEnv`): it never sees a view token, a harness token or a Candle variable.
//   - `spawnHarness` runs one in a PTY, for the panes where the user drives it;
//   - `runLines` runs one headless in its own process group, reading one JSON event per stdout line,
//     for engine turns (Claude Code, Codex, Grok), and optionally stderr lines too (Codex's
//     retry notices, which its JSON stream leaves out).
import { spawn } from "node:child_process"
import type { EngineEvent, Turn } from "./events"


const KEEP = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "LANG",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMPDIR",
  // Network: without these a harness has no network behind a proxy.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
])

export function harnessEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    if (KEEP.has(k) || k.startsWith("LC_")) env[k] = v
  }
  return env
}

export type HarnessProcess = {
  pid: number
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  onData(cb: (chunk: Uint8Array) => void): void
  exited: Promise<number>
  kill(): void
}

export function spawnHarness(
  cmd: string[],
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
): HarnessProcess {
  const listeners: ((chunk: Uint8Array) => void)[] = []
  const early: Uint8Array[] = [] // output that arrives before anyone listens
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name: opts.env.TERM ?? "xterm-256color",
      data(_t, chunk) {
        if (listeners.length === 0) early.push(chunk)
        for (const l of listeners) l(chunk)
      },
    },
  })
  const terminal = proc.terminal
  if (!terminal) throw new Error("Bun.spawn returned no terminal; a PTY needs Bun >= 1.3.5 on a POSIX system")

  return {
    pid: proc.pid,
    write: (data) => void terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    onData(cb) {
      listeners.push(cb)
      for (const chunk of early.splice(0)) cb(chunk)
    },
    exited: proc.exited,
    kill() {
      // The child leads its own session (it owns the PTY), so signal the whole process group:
      // a harness's own children (MCP servers, shells) go too. Then close the PTY, which hangs up
      // anything that slipped into another group.
      for (const sig of ["SIGHUP", "SIGTERM"] as const) {
        try {
          process.kill(-proc.pid, sig)
        } catch {
          proc.kill(sig)
        }
      }
      setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {}
      }, 1500).unref()
      terminal.close()
    },
  }
}

/** A per-turn parser: one line in, the events it means out. Stateful only to pair tool results with
 *  their calls; the same lines always give the same events. */
export type LineParser = (line: string) => EngineEvent[]

/** Per-run extras: an environment override (tests simulate a signed-out user with an empty HOME),
 *  and a tap on the raw lines, for recordings. */
export type RunHooks = { env?: Record<string, string>; onRaw?: (line: string) => void }

/** An async queue the adapter pushes into and the caller iterates. */
export function eventQueue() {
  const items: EngineEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    push(e: EngineEvent) {
      items.push(e)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *iterate(): AsyncIterable<EngineEvent> {
      for (;;) {
        if (items.length) {
          yield items.shift()!
          continue
        }
        if (ended) return
        await new Promise<void>((r) => (wake = r))
        wake = undefined
      }
    },
  }
}

/**
 * Runs `cmd` in `cwd` with a clean environment in its own process group, feeds stdout lines to
 * `parse`, and closes the turn with exactly one `done` or one `error`:
 * - the binary missing from PATH is an error naming the harness;
 * - an exit before the harness's own `done` is an error (its last stderr lines are the message);
 * - `cancel()` ends the whole group (the harness and anything it started, MCP servers included);
 * - with `stderr`, each stderr line is parsed too, and with `endOnError` an error either parser finds
 *   ends the harness at once rather than leaving it the usual 5 s to exit (Codex signed out or
 *   rate-limited would otherwise keep retrying for minutes).
 */
export function runLines(
  harness: string,
  cmd: string[],
  opts: {
    cwd: string
    parse: LineParser
    stderr?: LineParser
    endOnError?: boolean
    env?: Record<string, string>
    stdin?: string
    onRaw?: (line: string) => void
    onExit?: () => void
  },
): Turn {
  const q = eventQueue()
  let finished = false
  // The turn's last event (done or error) is pushed at once, but the stream only ends after the
  // harness has exited and been cleaned up, so a caller that has drained it leaves nothing behind.
  const finish = (e?: EngineEvent) => {
    if (finished) return
    finished = true
    if (e) q.push(e)
    // A harness still running 5 s after its turn ended is told to go.
    setTimeout(() => !exitHandled && child.pid !== undefined && killGroup(child.pid, "SIGTERM"), 5000).unref()
  }
  let exitHandled = false
  // Once the harness has exited, end whatever it left in its group (helpers still writing, MCP
  // servers), and only then clean up after it.
  const exited = () => {
    if (exitHandled) return
    exitHandled = true
    void (child.pid === undefined ? Promise.resolve() : endGroup(child.pid))
      .then(() => opts.onExit?.())
      .finally(() => q.end())
  }
  const emit = (events: EngineEvent[]) => {
    for (const e of events) {
      if (finished) return
      if (e.type === "done" || e.type === "error") {
        finish(e)
        if (e.type === "error" && opts.endOnError && !exitHandled && child.pid !== undefined) killGroup(child.pid, "SIGTERM")
      } else q.push(e)
    }
  }

  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? harnessEnv(process.env),
    detached: true, // its own process group, so cancel reaches everything it started
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  })
  if (opts.stdin !== undefined) child.stdin!.end(opts.stdin)

  let cancelled = false
  let stderrTail = ""
  let errBuf = ""
  child.stderr!.setEncoding("utf8")
  child.stderr!.on("data", (s: string) => {
    stderrTail = (stderrTail + s).slice(-2000)
    if (!opts.stderr) return
    errBuf = (errBuf + s).slice(-64_000)
    let nl: number
    while ((nl = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, nl)
      errBuf = errBuf.slice(nl + 1)
      if (line.trim()) emit(opts.stderr(line))
    }
  })
  let buf = ""
  child.stdout!.setEncoding("utf8")
  child.stdout!.on("data", (s: string) => {
    buf += s
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      opts.onRaw?.(line)
      emit(opts.parse(line))
    }
  })
  child.on("error", (err: NodeJS.ErrnoException) => {
    exited()
    if (err.code === "ENOENT") finish({ type: "error", message: `${harness} isn't installed (no "${cmd[0]}" on PATH)` })
    else finish({ type: "error", message: `${harness} couldn't start: ${err.message}` })
  })
  child.on("close", (code, signal) => {
    exited()
    if (buf.trim()) {
      opts.onRaw?.(buf)
      emit(opts.parse(buf))
    }
    if (cancelled) return finish({ type: "error", message: `${harness} turn cancelled` })
    const why = stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 400)
    finish({ type: "error", message: `${harness} ended without finishing the turn (${signal ?? `exit ${code}`})${why ? `: ${why}` : ""}` })
  })

  return {
    events: q.iterate(),
    async cancel() {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
      cancelled = true
      const exited = new Promise<void>((r) => child.once("close", () => r()))
      killGroup(child.pid, "SIGTERM")
      const timer = setTimeout(() => killGroup(child.pid!, "SIGKILL"), 1500)
      await exited
      clearTimeout(timer)
      killGroup(child.pid, "SIGKILL") // anything in the group that outlived the leader
    },
  }
}

/** Whether any process is left in group `pid`. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** SIGTERM the group, SIGKILL after 1 s, and resolve once nothing is left in it. */
export async function endGroup(pid: number): Promise<void> {
  if (!groupAlive(pid)) return
  killGroup(pid, "SIGTERM")
  for (let waited = 0; groupAlive(pid); waited += 50) {
    if (waited === 1000) killGroup(pid, "SIGKILL")
    if (waited > 3000) return
    await Bun.sleep(50)
  }
}

export function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig)
  } catch {}
}

export function tryJson(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
