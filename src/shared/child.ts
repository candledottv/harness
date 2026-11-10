// The one way the app starts a process: no shell, an environment built from an allowlist, no secret
// in the arguments, and its own process group, so a timeout takes the child's own children with it.
// Its program is found over PATH's absolute entries only (exec-path.ts), never through the folder it starts in.
import { absolutePath, resolveBin, withAbsolutePath } from "./exec-path"

const ALLOW = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "USER",
  // Network: without these a child has no network behind a proxy.
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

/** The parent's allowlisted variables (plus `LC_*`), then `extra` on top. Nothing else passes. */
export function allowEnv(parent: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (ALLOW.has(key) || key.startsWith("LC_"))) env[key] = value
  }
  if (env.PATH !== undefined) env.PATH = absolutePath(env.PATH)
  return { ...env, ...extra }
}

export interface ChildResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export interface LongChild {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">
  /** Ends the child and everything it started. Safe to call more than once. */
  killGroup(signal?: NodeJS.Signals): void
}

/** A long-running child on pipes (an MCP server), under the same rules as runChild. Throws if it can't start. */
export function spawnChild(spec: LaunchSpec): LongChild {
  const proc = Bun.spawn([resolveBin(spec.cmd, spec.env.PATH), ...spec.args], {
    cwd: spec.cwd,
    env: withAbsolutePath(spec.env),
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    proc,
    killGroup(signal = "SIGKILL") {
      try {
        process.kill(-proc.pid, signal)
      } catch {
        proc.kill(signal)
      }
    },
  }
}

/** Exit code for a child that couldn't start, as a shell reports a missing command. */
const COULD_NOT_START = 127

export async function runChild(opts: {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
  timeoutMs: number
  stdin?: string
}): Promise<ChildResult> {
  let proc
  try {
    proc = Bun.spawn([resolveBin(opts.cmd, opts.env.PATH), ...opts.args], {
      cwd: opts.cwd,
      env: withAbsolutePath(opts.env),
      detached: true, // setsid: the child leads its own process group
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return { exitCode: COULD_NOT_START, stdout: "", stderr: `couldn't start ${opts.cmd}: ${(error as Error).message}`, timedOut: false }
  }

  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill("SIGKILL")
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup()
  }, opts.timeoutMs)

  // Read while it runs, so a full pipe can't stall it.
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  const exitCode = await proc.exited
  clearTimeout(timer)
  // Anything it started is still in its group: end it, so nothing is left running and nothing holds
  // the pipes open.
  killGroup()
  return { exitCode, stdout: await stdout, stderr: await stderr, timedOut }
}
