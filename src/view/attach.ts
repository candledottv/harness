// How a view reaches the core: attach to the one running, or start one (`candle-harness core
// --exit-when-idle`, which exits 60 s after nothing holds it) and attach to that. The core runs in its
// own process group and outlives the view; its log goes to `state/core.log` (0600).
import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CoreClientError, ViewSession } from "../core/client"
import { ensureStateDir, type Paths } from "../paths"

// `signals` and `signals:mine` aren't here: the view asks for them while a layout on screen shows the
// Signals pane (Session.want), since the core opens Hacc's stream while anyone subscribes.
export const VIEW_TOPICS = ["status", "cards", "operations", "agent", "activity", "portfolio", "market", "wallets", "autonomy", "away", "onboarding", "engine", "memory", "skills", "hacc", "views"]
const START_TIMEOUT_MS = 15_000

export function coreLogPath(p: Paths): string {
  return join(p.stateDir, "core.log")
}

function notRunning(error: unknown): boolean {
  return error instanceof CoreClientError && (error.code === "CORE_NOT_RUNNING" || error.code === "NO_VIEW_TOKEN")
}

/** Attaches a view session, starting the core first when none is running. */
export async function attachView(input: { paths: Paths; self: string[]; env: Record<string, string | undefined>; clientName?: string; timeoutMs?: number }): Promise<{ session: ViewSession; started: boolean }> {
  const { paths } = input
  const session = () => new ViewSession({ socketPath: paths.socket, viewTokenPath: paths.viewToken, clientName: input.clientName ?? "candle-harness view", topics: VIEW_TOPICS })
  const first = session()
  try {
    await first.start()
    return { session: first, started: false }
  } catch (error) {
    if (!notRunning(error)) throw error
  }

  // A fresh machine has no state folder yet (onboarding): it's made private before the log goes in it.
  await ensureStateDir(paths)
  const log = openSync(coreLogPath(paths), "a", 0o600)
  try {
    const child = spawn(input.self[0]!, [...input.self.slice(1), "core", "--exit-when-idle"], {
      env: input.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", log, log],
    })
    child.unref()
  } finally {
    closeSync(log)
  }

  const deadline = Date.now() + (input.timeoutMs ?? START_TIMEOUT_MS)
  for (;;) {
    const attempt = session()
    try {
      await attempt.start()
      return { session: attempt, started: true }
    } catch (error) {
      if (!notRunning(error)) throw error
      if (Date.now() > deadline) {
        const tail = existsSync(coreLogPath(paths)) ? readFileSync(coreLogPath(paths), "utf8").trim().split("\n").slice(-5).join("\n") : ""
        throw new CoreClientError("CORE_DIDNT_START", `The core didn't start within ${Math.round((input.timeoutMs ?? START_TIMEOUT_MS) / 1000)} s.${tail ? `\n${tail}` : ""}`)
      }
      await Bun.sleep(100)
    }
  }
}
