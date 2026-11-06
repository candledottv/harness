// candle-harness [view|core|mcp|key add|doctor|version|cli-pane]. With no subcommand, it runs the view.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { ConfigError, loadConfig } from "./config"
import { PathsError, type Paths, paths, UnsafeStateDir } from "./paths"
import { parseState, unfinished } from "./setup/onboarding"
import { adoptOldEnv, oldEnvNotice } from "./shared/old-env"
import { isPoppable, POPPABLE } from "./shared/panes"
import { COMMIT, VERSION } from "./version"

export interface Io {
  out(text: string): void
  err(text: string): void
  /** The key for `key add`: a hidden prompt on a terminal, or all of stdin when it's piped. */
  readKey?(prompt: string): Promise<string>
}

const USAGE = `Usage: candle-harness [command]

  (none), view   open the Candle Harness, starting the core if none is running; with no agent yet, onboarding
  setup          onboarding again on a set-up machine, to add an agent (--straight-in: skip the tour)
  view --pane <id>  one pane alone, popped out of the main view (ctrl-p there starts it in a tmux or cmux split)
  core           run the core headless
  mcp            the MCP server an engine uses to reach the core (--empty: one with no tools, for the doctor)
  key add        add an agent's key, read from stdin: key add --agent <name>
  doctor         check the setup and say what to fix (--offline skips Candle and the engines' turns)
  version        print the version and the commit it was built from
  cli-pane       the prompt pane's launcher, which the view starts for a card you approved
`

export async function main(argv: string[], io: Io): Promise<number> {
  // 0.2's CANDLE_TUI_* variables, read under their new names (shared/old-env.ts): said once, where a person reads it.
  const oldEnv = adoptOldEnv(process.env)
  if (oldEnv.length > 0 && argv[0] !== "mcp" && argv[0] !== "cli-pane") io.err(`${oldEnvNotice(oldEnv)}\n`)
  // `candle tui` runs us as `candle-harness [--profile <name>] --candle <path>` (the CLI's commands/tui.ts): the view.
  if (argv[0] === "--candle" || argv[0] === "--profile") return runViewCommand(argv, io)
  const [command = "view", ...rest] = argv
  switch (command) {
    case "view":
      return runViewCommand(rest, io)
    case "setup": {
      const unknown = rest.filter((a) => a !== "--straight-in")
      if (unknown.length > 0) {
        io.err(`Usage: candle-harness setup [--straight-in]\n`)
        return 2
      }
      return openView(io, { onboarding: { straightIn: rest.includes("--straight-in"), asked: true } })
    }
    case "core":
      return runCore(rest, io)
    case "mcp": {
      const { runShim } = await import("./mcp/shim")
      return runShim(rest, io.err)
    }
    case "key":
      if (rest[0] !== "add") {
        io.err(`Usage: candle-harness key add --agent <name>\n`)
        return 2
      }
      return (await moveOldHome(io)) ?? runKeyAdd(rest.slice(1), io)
    case "doctor": {
      const { doctorCommand } = await import("./setup/doctor")
      return (await moveOldHome(io)) ?? doctorCommand(rest, io)
    }
    case "cli-pane": {
      // The ticket comes in the environment, never on the command line, where ps shows it.
      if (rest.length > 0) {
        io.err(`Usage: candle-harness cli-pane (started by the view)\n`)
        return 2
      }
      const { runLauncher } = await import("./pane/launcher")
      return runLauncher(process.env)
    }
    case "version":
    case "--version":
      io.out(`candle-harness ${VERSION} (${COMMIT})\n`)
      return 0
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE)
      return 0
    default:
      io.err(`candle-harness: unknown command "${command}"\n\n${USAGE}`)
      return 2
  }
}

/**
 * 0.2's home folder, copied into the new one before anything reads it (migrate-home.ts): undefined to go on,
 * or the exit code when it can't be copied yet. Run once a command's own arguments are known good.
 */
async function moveOldHome(io: Io): Promise<number | undefined> {
  const { migrateHome } = await import("./migrate-home")
  const moved = await migrateHome(process.env).catch((error: unknown) => ({ kind: "failed" as const, error }))
  if (moved.kind === "refused") {
    io.err(`${moved.message}\n`)
    return 1
  }
  if (moved.kind === "failed") {
    io.err(`Couldn't copy Candle TUI 0.2's folder to the new one (${moved.error instanceof Error ? moved.error.message : String(moved.error)}). Nothing was changed in the old folder.\n`)
    return 1
  }
  if (moved.kind === "copied") io.err(`Copied Candle TUI 0.2's config, keys and journal from ${moved.from} to ${moved.to}. The old folder is renamed aside once this start goes well, and never deleted.\n`)
  return undefined
}

/** Once a start on the new folder went well: 0.2's folder renamed aside, or why it was left (migrate-home.ts). Never stops a start. */
async function retireOld(io: Io): Promise<void> {
  const { retireOldHome } = await import("./migrate-home")
  const done = await retireOldHome(process.env).catch(() => undefined)
  if (done?.kind === "renamed") io.err(`Renamed Candle TUI 0.2's folder ${done.from} to ${done.to}: everything in it was copied to the new folder and checked. You may delete it.\n`)
  if (done?.kind === "kept") io.err(`Left Candle TUI 0.2's folder ${done.from} as it was: ${done.why}. Check it before you delete it.\n`)
}

/** `candle-harness` or `candle-harness view`: the Candle Harness, attached to the core (started if none is running). */
async function runViewCommand(args: string[], io: Io): Promise<number> {
  // A popped view: `view --pane <id>`, which the main view's ctrl-p starts in a split.
  if (args[0] === "--pane") {
    const pane = poppedPane(args)
    if (typeof pane !== "string" || !isPoppable(pane)) {
      io.err(`${typeof pane === "object" ? pane.problem : `Usage: candle-harness view --pane <${POPPABLE.join("|")}>`}\n`)
      return 2
    }
    const stop = await moveOldHome(io)
    if (stop !== undefined) return stop
    try {
      const p = paths(process.env)
      const { runView } = await import("./view/run")
      return await runView(p, io.err, { pane })
    } catch (error) {
      if (error instanceof PathsError || error instanceof UnsafeStateDir) {
        io.err(`${error.message}\n`)
        return 1
      }
      throw error
    }
  }
  const fromCli = cliArgs(args)
  if (!fromCli) {
    io.err(`Usage: candle-harness [view]\n`)
    return 2
  }
  // `--profile` is taken and not used, without a word: the CLI passes its active profile on every
  // `candle tui`, so a line would print on every start, and the view's screen covers it.
  if (fromCli.fromCli) restoreLoginEnv(process.env)
  return openView(io)
}

/**
 * The view, after checking the config says what's wrong before a core is started. No config, or one with
 * no agents, opens onboarding in place of a refusal; any other problem is still refused.
 */
async function openView(io: Io, opts: { onboarding?: { straightIn: boolean; asked: boolean } } = {}): Promise<number> {
  const stop = await moveOldHome(io)
  if (stop !== undefined) return stop
  try {
    const p = paths(process.env)
    const { onboarding, warnings } = viewOpening(p, opts.onboarding)
    for (const warning of warnings) io.err(`config: ${warning}\n`)
    const { runView } = await import("./view/run")
    const code = await runView(p, io.err, onboarding ? { onboarding } : {})
    if (code === 0) await retireOld(io)
    if (code === 1) await whatsMissing(io) // the view couldn't attach
    return code
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PathsError || error instanceof UnsafeStateDir) {
      io.err(`${error.message}\n`)
      await whatsMissing(io)
      return 1
    }
    throw error
  }
}

/**
 * How the view opens: onboarding when there's no agent yet (no config.toml, or one with no agents), when a run
 * of it started and hasn't reached its end (such as a quit after the key was made), or when `candle-harness
 * setup` asked; the Candle Harness otherwise. A config with any other problem throws its ConfigError.
 */
export function viewOpening(p: Paths, asked?: { straightIn: boolean; asked: boolean }): { onboarding?: { straightIn: boolean; asked: boolean }; warnings: string[] } {
  const { config, warnings } = loadConfig(p, { setup: true })
  let held: ReturnType<typeof parseState>
  try {
    held = parseState(readFileSync(p.onboarding, "utf8"))
  } catch {
    held = undefined
  }
  const noAgents = Object.keys(config.agents).length === 0
  const onboarding = asked ?? (noAgents || unfinished(held) ? { straightIn: held?.straightIn === true, asked: false } : undefined)
  return { ...(onboarding ? { onboarding } : {}), warnings }
}

/** `--pane <id>`'s pane, or what's wrong with it: the conversation stays in the main window. */
export function poppedPane(args: readonly string[]): string | { problem: string } | undefined {
  if (args.length !== 2) return undefined
  const pane = args[1]!
  if (pane === "agent") return { problem: "The agent's conversation stays in the main window, with the input line and its cards: it doesn't pop out." }
  return isPoppable(pane) ? pane : { problem: `No pane "${pane.slice(0, 40)}" pops out: ${POPPABLE.join(", ")}.` }
}

/**
 * What `candle tui` passes: `--candle <path>` and maybe `--profile <name>`, both taken and neither
 * used. The core runs the CLI from config.toml's `candle.cliPath`, and trades with the agents' own
 * keys, never a CLI profile. Undefined for anything else.
 */
export function cliArgs(args: readonly string[]): { fromCli: boolean; profile?: string } | undefined {
  let fromCli = false
  let profile: string | undefined
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1]
    if (value === undefined || value.startsWith("--")) return undefined
    if (args[i] === "--candle") fromCli = true
    else if (args[i] === "--profile") profile = value
    else return undefined
  }
  return { fromCli, ...(profile !== undefined ? { profile } : {}) }
}

/**
 * `candle tui` builds our environment from empty (PATH, HOME, TERM and a few more), with USER, LOGNAME
 * and SHELL set to "unknown". The core this view starts passes them on to the engine and Candle's
 * server, so they're put back from the login record when missing, empty or "unknown". Claude Code
 * finds its macOS keychain sign-in by USER: with "unknown" it said "Not logged in", and USER alone
 * fixes it.
 */
export function restoreLoginEnv(env: Record<string, string | undefined>, login: () => string | undefined = loginName, shell: () => string | undefined = loginShell): void {
  const unset = (v: string | undefined) => v === undefined || v === "" || v === "unknown"
  if (unset(env.USER) || unset(env.LOGNAME)) {
    const name = login()
    if (name && unset(env.USER)) env.USER = name
    if (name && unset(env.LOGNAME)) env.LOGNAME = name
  }
  if (unset(env.SHELL)) {
    const found = shell()
    if (found) env.SHELL = found
  }
}

/**
 * The login name from the user database, by uid. Not `os.userInfo().username`: Bun (1.4.4) reads that
 * from USER, so it says "unknown" in exactly the environment being repaired.
 */
export function loginName(): string | undefined {
  try {
    const r = spawnSync("id", ["-un"], { encoding: "utf8", timeout: 2_000 })
    const name = r.status === 0 ? r.stdout.trim() : ""
    return name && name !== "unknown" ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * The login shell from the user database, by uid: `getent passwd` on Linux, `dscl` on macOS. Not
 * `os.userInfo().shell`: Bun (1.4.4) reads that from SHELL, so it says "unknown" where it's needed
 * (SHELL can be missing in the core).
 */
export function loginShell(): string | undefined {
  try {
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", timeout: 2_000 })
    let shell: string | undefined
    if (process.platform === "darwin") {
      const name = loginName()
      const r = name ? run("dscl", [".", "-read", `/Users/${name}`, "UserShell"]) : undefined
      shell = r?.status === 0 ? /UserShell:\s*(\S+)/.exec(r.stdout)?.[1] : undefined
    } else {
      const r = run("getent", ["passwd", String(process.getuid?.() ?? "")])
      shell = r.status === 0 ? r.stdout.trim().split(":")[6] : undefined
    }
    return shell?.startsWith("/") ? shell : undefined
  } catch {
    return undefined
  }
}

/** When the view can't start: the doctor's offline checks that aren't ok. */
async function whatsMissing(io: Io): Promise<void> {
  const { quickDoctor } = await import("./setup/doctor")
  io.err(await quickDoctor(process.env))
}

async function runKeyAdd(args: string[], io: Io): Promise<number> {
  const { keyAdd, PromptCancelled } = await import("./setup/key-add")
  try {
    return await keyAdd(args, { out: io.out, err: io.err, readKey: io.readKey ?? (async () => "") })
  } catch (error) {
    if (error instanceof PromptCancelled) return 130
    throw error
  }
}

/** The key from this process's stdin: hidden on a terminal, read whole when piped. */
async function readKeyFromStdin(prompt: string): Promise<string> {
  if (process.stdin.isTTY) {
    const { readHiddenLine } = await import("./setup/key-add")
    return readHiddenLine(process.stdin, (text) => process.stderr.write(text), prompt)
  }
  return Bun.stdin.text()
}

/**
 * `candle-harness core`: the core, headless, until it's stopped. `--exit-when-idle` is how a view starts
 * one for itself: that core exits 60 s after nothing holds it.
 */
async function runCore(args: string[], io: Io): Promise<number> {
  const unknown = args.filter((a) => a !== "--exit-when-idle")
  if (unknown.length > 0) {
    io.err(`Usage: candle-harness core\n`)
    return 2
  }
  const stop = await moveOldHome(io)
  if (stop !== undefined) return stop
  let core
  // The core's own environment, which the engine and Candle's children inherit parts of: a core started
  // from `candle tui`'s view or by hand gets USER, LOGNAME and SHELL put back the same way.
  restoreLoginEnv(process.env)
  try {
    const p = paths(process.env)
    // With no agent yet, the core runs for onboarding: no Candle reads, nothing trades.
    const { config, warnings } = loadConfig(p, { setup: true })
    for (const warning of warnings) io.err(`config: ${warning}\n`)
    if (Object.keys(config.agents).length === 0) io.err(`candle-harness core: no agent yet, so it's in setup: nothing reads Candle or trades until the first agent is made.\n`)
    const { startCore } = await import("./core/core-main")
    let resolveStopped!: (reason: string) => void
    const stopped = new Promise<string>((resolve) => (resolveStopped = resolve))
    core = await startCore({ paths: p, config, env: process.env, headless: !args.includes("--exit-when-idle"), onStopped: resolveStopped })
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void core!.stop(signal))
    io.err(`candle-harness core ${VERSION} listening at ${p.socket}\n`)
    await retireOld(io)
    const { losesNextReply, LOSE_NEXT_REPLY_NOTE, operationLogLine } = await import("./core/execute")
    if (losesNextReply(process.env)) io.err(`debug: ${LOSE_NEXT_REPLY_NOTE}\n`)
    // One line per operation step, so a core in its own terminal shows what it did rather than nothing.
    core.journal.onAppend((row) => {
      const text = operationLogLine(row)
      if (text) io.err(`${text}\n`)
    })
    const reason = await stopped
    io.err(`candle-harness core stopped (${reason})\n`)
    return 0
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PathsError || error instanceof UnsafeStateDir) {
      io.err(`${error.message}\n`)
      return 1
    }
    const code = (error as { code?: unknown }).code
    if (code === "CORE_ALREADY_RUNNING") {
      io.err(`${(error as Error).message}\n`)
      return 1
    }
    throw error
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    readKey: readKeyFromStdin,
  })
  process.exit(code)
}
