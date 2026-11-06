// The terminal the first-run script drives: tmux on Linux, cmux on a Mac.
// Both type text, press named keys and read the screen as plain text, one line a row.
import { spawnSync } from "node:child_process"

/** The keys the steps press, named once; each route spells them its own way. */
export type KeyName = "enter" | "escape" | "up" | "down" | "left" | "right" | "tab" | "backspace" | "ctrl-c" | "ctrl-]" | "ctrl-k" | "ctrl-u"

export interface Term {
  readonly label: string
  /** Text as keystrokes, exactly as given: no Enter. */
  type(text: string): void
  key(name: KeyName, times?: number): void
  /** The visible screen, plain text. */
  screen(): string
}

function run(cmd: string[], input?: string): string {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`)
  return r.stdout
}

const TMUX_KEYS: Record<KeyName, string> = {
  enter: "Enter",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  backspace: "BSpace",
  "ctrl-c": "C-c",
  "ctrl-]": "C-]",
  "ctrl-k": "C-k",
  "ctrl-u": "C-u",
}

export class TmuxTerm implements Term {
  readonly label: string
  constructor(readonly target: string) {
    this.label = `tmux ${target}`
  }
  type(text: string): void {
    if (text) run(["tmux", "send-keys", "-t", this.target, "-l", "--", text])
  }
  key(name: KeyName, times = 1): void {
    for (let i = 0; i < times; i++) run(["tmux", "send-keys", "-t", this.target, TMUX_KEYS[name]])
  }
  screen(): string {
    return run(["tmux", "capture-pane", "-p", "-t", this.target])
  }
}

// cmux's names, as its CLI contract spells them (`enter`, `escape`, `up`, chords joined with `+`).
const CMUX_KEYS: Record<KeyName, string> = {
  enter: "enter",
  escape: "escape",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  tab: "tab",
  backspace: "backspace",
  "ctrl-c": "ctrl+c",
  "ctrl-]": "ctrl+]",
  "ctrl-k": "ctrl+k",
  "ctrl-u": "ctrl+u",
}

export class CmuxTerm implements Term {
  readonly label: string
  constructor(readonly surface: string) {
    this.label = `cmux ${surface}`
  }
  type(text: string): void {
    // --force: the Candle Harness isn't an agent prompt, but cmux's draft guard can't tell. `--`: a key prefix can start
    // with "-", and cmux takes `send [--] <text>`.
    if (text) run(["cmux", "send", "--surface", this.surface, "--force", "--", text])
  }
  key(name: KeyName, times = 1): void {
    for (let i = 0; i < times; i++) run(["cmux", "send-key", "--surface", this.surface, "--force", CMUX_KEYS[name]])
  }
  screen(): string {
    // Trimmed as tmux's capture-pane trims, in case cmux pads a row: the steps match whole lines.
    return run(["cmux", "read-screen", "--surface", this.surface]).split("\n").map((l) => l.trimEnd()).join("\n")
  }
}
