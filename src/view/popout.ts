// Pop-out: a pane moves into a split of its own, running
// `candle-harness view --pane <id>`, a view of that one pane attached to the same core. The tiled view leaves
// it out while it's there (the core's `views` topic says which are popped) and takes it back when that
// view closes or dies.
//
// Where the split comes from:
// - Inside tmux: `tmux split-window -h` beside this view's own pane, with the command as separate
//   arguments, so tmux runs it directly and no shell reads it.
// - Inside cmux: `cmux new-split right --command <text>`, cmux's documented way to start a program in a new
//   split (its CLI contract, docs/cli-contract.md in github.com/manaflow-ai/cmux, "Initial terminal command"). The text is typed into the
//   new split's own shell, so every word is single-quoted and a word that can't be quoted safely (a quote,
//   a backslash, a control character) sends it to the copy route instead. `exec` makes the view the split's
//   process, so the split closes with it, as a tmux one does; the leading space keeps it out of the shell's
//   history where the shell allows that.
// - Anywhere else, or when either fails: the command, with a chip that copies it, to run in any
//   terminal's split.
//
// A split starts with the multiplexer's environment, not this view's, so the Candle Harness's home goes with it.
import { isPoppable, type PaneId } from "../shared/panes"

/** What this view's environment passes on to the popped view: where the Candle Harness's config and state are (the 0.2 name is still read). */
const CARRIED = ["CANDLE_HARNESS_HOME", "CANDLE_TUI_HOME"] as const

export type PopRoute = { kind: "tmux" | "cmux"; file: string; args: string[] } | { kind: "copy"; why: string }

/** How a pop-out went: the pane is in a split, or here's the command to run by hand, and why. */
export type PopOutcome = { kind: "split"; where: "tmux" | "cmux" } | { kind: "copy"; command: string; why: string }

export type Popper = (pane: PaneId) => Promise<PopOutcome>

export interface PopInput {
  pane: PaneId
  /** How to run this binary: `selfCommand()`. */
  self: readonly string[]
  env: Readonly<Record<string, string | undefined>>
}

/** The popped view's command line. */
export const viewArgv = (self: readonly string[], pane: PaneId): string[] => [...self, "view", "--pane", pane]

const carried = (env: PopInput["env"]): string[] => CARRIED.flatMap((k) => (env[k] ? [`${k}=${env[k]}`] : []))

/** A word a shell reads back as itself inside single quotes, in sh, bash, zsh and fish alike. */
const quotable = (word: string): boolean => word !== "" && !/['\\\x00-\x1f\x7f]/.test(word)

/** A word as typed: bare when it has nothing a shell reads, else single-quoted. */
export const shellWord = (word: string): string => (/^[A-Za-z0-9_/.,:=+@%-]+$/.test(word) ? word : `'${word}'`)

/** The words to type, `env` first when the home goes with them. */
function typedWords(input: PopInput): string[] {
  const vars = carried(input.env)
  return [...(vars.length ? ["env", ...vars] : []), ...viewArgv(input.self, input.pane)]
}

/** The command to run by hand in another terminal's split, quoted for sh, bash and zsh (a quote in a word as `'\''`). */
export function copyCommand(input: PopInput): string {
  return typedWords(input).map((w) => (quotable(w) ? shellWord(w) : `'${w.replace(/'/g, "'\\''")}'`)).join(" ")
}

/** Where the pane goes, from this view's environment: tmux (the innermost, when both), cmux, or the copy route. */
export function popRoute(input: PopInput): PopRoute {
  if (!isPoppable(input.pane)) throw new Error(`${input.pane} doesn't pop out`)
  const { env } = input
  if (env.TMUX) {
    return {
      kind: "tmux",
      file: "tmux",
      args: ["split-window", "-h", ...(env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []), ...carried(env).flatMap((v) => ["-e", v]), ...viewArgv(input.self, input.pane)],
    }
  }
  if (env.CMUX_SURFACE_ID) {
    const words = typedWords(input)
    const odd = words.find((w) => !quotable(w))
    if (odd !== undefined) return { kind: "copy", why: "cmux types the command into the new split's shell, and a word of it can't be quoted safely" }
    return { kind: "cmux", file: "cmux", args: ["new-split", "right", "--surface", env.CMUX_SURFACE_ID, "--command", ` exec ${words.map(shellWord).join(" ")}`] }
  }
  return { kind: "copy", why: "this terminal isn't inside tmux or cmux" }
}

/** Runs a multiplexer's command: its exit code and what it said, or undefined when it couldn't start. */
export type RunTool = (file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<{ code: number | null; said: string } | undefined>

const TOOL_TIMEOUT_MS = 5_000

const runTool: RunTool = async (file, args, env) => {
  try {
    const proc = Bun.spawn([file, ...args], { env: env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: TOOL_TIMEOUT_MS })
    const said = await new Response(proc.stderr).text()
    return { code: await proc.exited, said: said.trim() }
  } catch {
    return undefined
  }
}

/** The view's pop-out: the route from its environment, run, and the copy route when that fails. */
export function makePopper(deps: { self: readonly string[]; env: Readonly<Record<string, string | undefined>>; run?: RunTool }): Popper {
  const run = deps.run ?? runTool
  return async (pane) => {
    const input: PopInput = { pane, self: deps.self, env: deps.env }
    const route = popRoute(input)
    const command = copyCommand(input)
    if (route.kind === "copy") return { kind: "copy", command, why: route.why }
    const ran = await run(route.file, route.args, deps.env)
    if (ran === undefined) return { kind: "copy", command, why: `${route.file} couldn't be started from here` }
    if (ran.code !== 0) return { kind: "copy", command, why: `${route.file} refused the split${ran.said ? `: ${ran.said.split("\n")[0]!.slice(0, 120)}` : ""}` }
    return { kind: "split", where: route.kind }
  }
}
