// The prompt pane's process: the view starts `candle-harness cli-pane` in a PTY of its own, with the card's
// single-use ticket in CANDLE_HARNESS_PANE_TICKET and the core's socket in CANDLE_HARNESS_PANE_SOCKET, never on a
// command line, where ps shows them. The launcher drops both before `candle` runs. The PTY is sized in both
// directions, and a close hangs up the whole process group.
//
// The pane's environment is the view's own, less ours (CANDLE_HARNESS_*, and 0.2's CANDLE_TUI_*) and the variables that change who
// `candle` runs as (CANDLE_API_KEY, CANDLE_DEVICE_TOKEN). The launcher strips them again, and adds the
// agent's key for an agent's row. The person's CANDLE_KEYRING_PASSPHRASE passes through, as it does to
// the core's own `candle` runs: on a machine with no keychain, the CLI opens its file store with it.

export const PANE_TICKET_ENV = "CANDLE_HARNESS_PANE_TICKET"
export const PANE_SOCKET_ENV = "CANDLE_HARNESS_PANE_SOCKET"
const STRIPPED = /^(CANDLE_(HARNESS|TUI)_.*|CANDLE_API_KEY|CANDLE_DEVICE_TOKEN)$/

export function paneEnv(env: Record<string, string | undefined>, input: { ticket: string; socketPath: string }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !STRIPPED.test(key)) out[key] = value
  out[PANE_TICKET_ENV] = input.ticket
  out[PANE_SOCKET_ENV] = input.socketPath
  return out
}

export interface PaneProcess {
  pid: number
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  /** Output, with what arrived before replayed to each new listener (the terminal, and onboarding's code reader). */
  onData(listener: (chunk: Uint8Array) => void): void
  exited: Promise<number>
  /** A signal to the launcher alone: SIGUSR1 asks it to stop `candle`. */
  signal(signal: NodeJS.Signals): void
  /** Hangs up the pane: the launcher stops `candle` and reports, then the PTY closes. */
  close(): void
}

/** Starts a pane; the view's tests pass a stand-in. */
export type PaneSpawner = (input: { ticket: string; cols: number; rows: number }) => PaneProcess

export function makePaneSpawner(opts: { self: string[]; socketPath: string; env: Record<string, string | undefined> }): PaneSpawner {
  return ({ ticket, cols, rows }) => {
    const listeners: ((chunk: Uint8Array) => void)[] = []
    // What the pane has printed so far, replayed to each listener as it's added; kept to its first 256 KB.
    const history: Uint8Array[] = []
    let kept = 0
    const env = paneEnv(opts.env, { ticket, socketPath: opts.socketPath })
    const proc = Bun.spawn([...opts.self, "cli-pane"], {
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
    if (!terminal) throw new Error("Bun.spawn returned no terminal; the prompt pane needs a POSIX system")
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
        // The launcher leads its own session (it owns the PTY): a hangup to its group, so it stops `candle`
        // and reports; then the PTY closes. Anything left after 1.5 s is killed.
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
