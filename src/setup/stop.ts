// `candle-harness stop`: ends the core, saying what it stopped. No question: the person typed it. It asks the core
// itself (`core.stop`, with the view token, as the same user only), which answers with what it's stopping and
// then stops as on a signal; a core that can't be asked (an older one, or one not answering) gets SIGTERM, by the
// pid in its lock file, once that pid is checked to be a Candle Harness core.
import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { connectView, STOP_CLIENT } from "../core/client"
import { type Paths, paths as pathsOf, PathsError } from "../paths"
import { pidIsAlive } from "../shared/lock"
import { answers } from "../shared/socket-path"
import { serviceFile } from "./service"

/** How long a stopping core is waited for. */
export const STOP_WAIT_MS = 15_000

export interface StopDeps {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  home: string
  /** Whether a pid names a live process. */
  isAlive?: (pid: number) => boolean
  /** A pid's command line, or undefined when it can't be read. */
  commandOf?: (pid: number) => string | undefined
  kill?: (pid: number, signal: NodeJS.Signals) => void
  waitMs?: number
}

const realCommandOf = (pid: number): string | undefined => {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 })
  const text = r.status === 0 ? r.stdout.trim() : ""
  return text || undefined
}

/** Whether a command line is a Candle Harness core: `candle-harness core`, or a run from source, `… main.ts core`. */
export function isCoreCommand(args: string): boolean {
  const words = args.split(/\s+/)
  const at = words.indexOf("core")
  return at > 0 && words.slice(0, at).some((w) => /(^|\/)candle-harness(-[\w-]+)?$/.test(w) || /(^|\/)main\.ts$/.test(w))
}

function lockPid(p: Paths): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(p.lock, "utf8")) as { pid?: unknown }).pid
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function waitFor(done: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await done()) return true
    await Bun.sleep(100)
  }
  return done()
}

export async function stopCommand(args: string[], io: { out(text: string): void; err(text: string): void }, d: StopDeps): Promise<number> {
  if (args.length > 0) {
    io.err("Usage: candle-harness stop\n")
    return 2
  }
  let p: Paths
  try {
    p = pathsOf(d.env)
  } catch (error) {
    if (error instanceof PathsError) {
      io.err(`${error.message}\n`)
      return 1
    }
    throw error
  }
  const waitMs = d.waitMs ?? STOP_WAIT_MS
  const service = serviceFile(d)
  const serviceNote = () => {
    if (service && existsSync(service)) io.out("The login service starts a core again at your next login (`candle-harness service uninstall` removes it).\n")
  }

  // Asked first: the core says what it stops.
  if (await answers(p.socket)) {
    try {
      const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: STOP_CLIENT })
      let answer: { pid?: unknown; stopped?: unknown }
      try {
        answer = (await connection.request("core.stop", {})) as typeof answer
      } finally {
        connection.close()
      }
      const pid = typeof answer.pid === "number" ? answer.pid : undefined
      const stopped = Array.isArray(answer.stopped) ? answer.stopped.filter((s): s is string => typeof s === "string") : []
      const gone = await waitFor(async () => !(await answers(p.socket)), waitMs)
      if (!gone) {
        io.err(`The core${pid ? ` (pid ${pid})` : ""} was asked to stop and is still running after ${Math.round(waitMs / 1000)} s.${pid ? ` \`kill ${pid}\` asks again; \`kill -9 ${pid}\` ends it at once.` : ""}\n`)
        return 1
      }
      io.out(`Stopped the Candle Harness core${pid ? ` (pid ${pid})` : ""}.\n${stopped.length ? stopped.map((s) => `  · ${s}\n`).join("") : "  · nothing else was running in it\n"}`)
      serviceNote()
      return 0
    } catch {
      // Not answered as asked (an older core, or a view token that kept changing): by its pid.
    }
  }

  const pid = lockPid(p)
  const alive = d.isAlive ?? pidIsAlive
  if (pid === undefined || !alive(pid)) {
    io.out("No Candle Harness core is running.\n")
    return 0
  }
  const command = (d.commandOf ?? realCommandOf)(pid)
  if (!command || !isCoreCommand(command)) {
    io.err(`The lock at ${p.lock} names pid ${pid}, which ${command ? `is \`${command.slice(0, 120)}\`, not a Candle Harness core` : "couldn't be read"}, so nothing was stopped.\n`)
    return 1
  }
  try {
    ;(d.kill ?? ((target, signal) => process.kill(target, signal)))(pid, "SIGTERM")
  } catch (error) {
    io.err(`Couldn't signal pid ${pid}: ${(error as Error).message}\n`)
    return 1
  }
  if (!(await waitFor(() => !alive(pid), waitMs))) {
    io.err(`The core (pid ${pid}) was sent SIGTERM and is still running after ${Math.round(waitMs / 1000)} s. \`kill -9 ${pid}\` ends it at once.\n`)
    return 1
  }
  io.out(`Stopped the Candle Harness core (pid ${pid}). It didn't answer, so it was signalled: a trade in flight is read back when the core next starts, and never sent twice.\n`)
  serviceNote()
  return 0
}

