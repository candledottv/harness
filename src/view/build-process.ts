// The Build pane's process: the person's own coding harness (Claude Code, Codex, Grok, OpenCode, Pi, or a command of
// theirs), unmodified, in a PTY of its own in the bots folder. It runs as the person would run it in a terminal, with
// their own environment and sign-ins, less the variables that change who `candle` runs as and the Candle Harness's
// own; it gets the pane's socket and build token, in its environment alone, never on a command line. The PTY is
// sized in both directions, the harness leads its own process group, and a close hangs up the whole group. A core that
// restarts mints the pane a new token, which the running harness's environment can't take, so the view also keeps the
// current one in a 0600 file beside the core's socket, named in the environment, and `candle-harness build` reads it first.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BUN_VAR } from "../shared/bun-env"
import { BUILD_SOCKET_ENV, BUILD_TOKEN_ENV, BUILD_TOKEN_FILE_ENV } from "../setup/build"
import type { PaneProcess } from "./pane-process"
/**
 * What never reaches the harness from the view's environment: ours, 0.2's, and `candle`'s own sign-in, the key
 * Candle's MCP server reads ahead of any other among them, so a harness that starts one never trades as a key
 * the person had exported. Nor do Bun's own variables (BUN_OPTIONS can preload code into any Bun program it starts).
 */
const STRIPPED = /^(CANDLE_(HARNESS|TUI)_.*|CANDLE_API_KEY|CANDLE_AGENT_API_KEY|CANDLE_DEVICE_TOKEN|CANDLE_KEYRING_PASSPHRASE|CANDLE_PROFILE)$/

export function buildEnv(env: Record<string, string | undefined>, input: { token: string; socketPath: string; tokenFile?: string }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !STRIPPED.test(key) && !BUN_VAR.test(key)) out[key] = value
  out[BUILD_TOKEN_ENV] = input.token
  out[BUILD_SOCKET_ENV] = input.socketPath
  if (input.tokenFile) out[BUILD_TOKEN_FILE_ENV] = input.tokenFile
  return out
}

/**
 * Where this view keeps its Build pane's current token: beside the core's socket, in the state folder, one file a
 * view. A core that restarts mints the pane a new token, and the harness already running reads it here.
 */
export function buildTokenFile(socketPath: string, pid = process.pid): string {
  return join(dirname(socketPath), "build", `pane-${pid}.token`)
}

/** Writes the pane's token, 0600 in a 0700 folder, whole or not at all. False where it can't be written. */
export function keepBuildToken(file: string, token: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const part = `${file}.${process.pid}.part`
    writeFileSync(part, `${token}\n`, { mode: 0o600 })
    chmodSync(part, 0o600)
    renameSync(part, file)
    return true
  } catch {
    return false
  }
}

/** The pane's token file, gone with the view (the core revokes the token itself). */
export function forgetBuildToken(file: string): void {
  rmSync(file, { force: true })
}

/** Starts a harness in the Build pane; the view's tests pass a stand-in. */
export type BuildSpawner = (input: { argv: readonly string[]; cwd: string; token: string; socketPath: string; tokenFile?: string; cols: number; rows: number }) => PaneProcess

export function makeBuildSpawner(opts: { env: Record<string, string | undefined> }): BuildSpawner {
  return ({ argv, cwd, token, socketPath, tokenFile, cols, rows }) => {
    const listeners: ((chunk: Uint8Array) => void)[] = []
    // What the harness printed before the terminal listened, replayed to it; kept to its first 256 KB.
    const history: Uint8Array[] = []
    let kept = 0
    const env = buildEnv(opts.env, { token, socketPath, ...(tokenFile ? { tokenFile } : {}) })
    const proc = Bun.spawn([...argv], {
      cwd,
      env,
      terminal: {
        cols: Math.max(20, cols),
        rows: Math.max(5, rows),
        name: env.TERM ?? "xterm-256color",
        data(_t, chunk) {
          if (kept < 256 * 1024) {
            history.push(chunk)
            kept += chunk.length
          }
          for (const l of listeners) l(chunk)
        },
      },
    })
    const terminal = proc.terminal
    if (!terminal) throw new Error("Bun.spawn returned no terminal; the Build pane needs a POSIX system")
    let closed = false
    return {
      pid: proc.pid,
      write: (data) => void (closed || terminal.write(data)),
      resize: (c, r) => void (closed || terminal.resize(Math.max(20, c), Math.max(5, r))),
      onData(listener) {
        listeners.push(listener)
        for (const chunk of history) listener(chunk)
      },
      exited: proc.exited,
      signal(signal) {
        try {
          proc.kill(signal)
        } catch {}
      },
      close() {
        if (closed) return
        closed = true
        // The harness leads its own session (it owns the PTY): a hangup to its group, then the PTY closes. Anything
        // left after 1.5 s is killed, but a daemon that left the group (Codex's) is the person's to stop.
        try {
          process.kill(-proc.pid, "SIGHUP")
        } catch {
          proc.kill("SIGHUP")
        }
        setTimeout(() => {
          try {
            process.kill(-proc.pid, "SIGKILL")
          } catch {}
          terminal.close()
        }, 1500).unref?.()
      },
    }
  }
}
