// The version of the core that's running. A core keeps the version it started as after the binary is
// replaced: one held open by a trigger, a bot or the login service carries on as the old version until it's
// restarted. The installer, the doctor and the view each read it to say so; none of them restarts it unasked.
import { connectView, DOCTOR_CLIENT } from "../core/client"
import { paths as pathsOf } from "../paths"
import { answers } from "../shared/socket-path"

/**
 * The running core's version, or undefined when no core runs or it can't be asked. It attaches as the doctor
 * does, which starts nothing and counts as nobody's open window.
 */
export async function runningCoreVersion(env: Record<string, string | undefined>): Promise<string | undefined> {
  try {
    const p = pathsOf(env)
    if (!(await answers(p.socket))) return undefined
    const { connection, hello } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
    connection.close()
    return typeof hello.coreVersion === "string" && /^\d+\.\d+\.\d+$/.test(hello.coreVersion) ? hello.coreVersion : undefined
  } catch {
    return undefined
  }
}

/** What to say when the running core isn't this binary's version, or undefined when they match. */
export function staleCoreWords(running: string | undefined, ours: string): string | undefined {
  if (running === undefined || running === ours) return undefined
  return `The core that's running is still ${running}, and this is ${ours}. It carries on as ${running}, with its triggers and bots, until it's restarted.`
}
