// Where the Candle Harness keeps its config and state. Config in ~/.config/candle/harness (or CANDLE_HARNESS_HOME,
// else 0.2's CANDLE_TUI_HOME), state in its private state/ folder. 0.2's ~/.config/candle/tui is copied in on
// the first start (migrate-home.ts). Nothing lives under /tmp or $TMPDIR, where engine sandboxes
// leave writes open.
import { chmodSync, statSync } from "node:fs"
import { chmod, lstat, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/** macOS's sun_path holds 104 bytes with its terminating NUL, so a usable path is at most 103. */
export const SOCKET_PATH_MAX_BYTES = 104

/** Agent names become key file names, so they stay plain: lower case, digits, `-` and `_`. */
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface Paths {
  configDir: string
  configFile: string
  /** The tabs and layouts of your own: the Candle Harness's file beside config.toml, read by the view only. */
  layoutsFile: string
  /** The Candle Harness's own names for wallets Candle holds no label for: beside config.toml, the core's to write. */
  walletsFile: string
  /** Triggers: beside config.toml, written whole by the core when one is saved, switched or removed. */
  triggersFile: string
  /** Rules bots: beside config.toml, written whole by the core when one is saved, narrowed, paused, stopped, resumed or removed. */
  botsFile: string
  /** `--pairs-from` files the core writes for a batch rename, 0600, one per card. */
  renamesDir: string
  /** Themes of your own: `themes/<name>.toml` beside config.toml, read by the view only. */
  themesDir: string
  /** The person's own skills: `<name>/SKILL.md`, read by the core, never written by it. */
  skillsDir: string
  stateDir: string
  socket: string
  lock: string
  journal: string
  keysDir: string
  keyFile(agent: string): string
  tokens: string
  viewToken: string
  turnsDir: string
  /** Each turn's engine's private work folder (homes, configs): handed back and removed on the next start if a core died. */
  homesDir: string
  /** Each agent's engine and model, last chosen (0600); config.toml's engine.default is only where a fresh agent starts. */
  engineState: string
  /** The kill switch's state (0600): paused or not, so a restart keeps it whatever the journal's window holds. */
  killState: string
  /** The mode last picked (0600), so a restart keeps it; config.toml's mode is only where a fresh core starts. */
  modeState: string
  /** The agent last made active (0600), so a restart keeps it; config.toml's activeAgent is where a fresh core starts. */
  activeState: string
  /** The vault keys from the last `vault list` run in the prompt pane (0600): known destinations for funds out. */
  destinations: string
  /** TEE wallets this Candle Harness stopped in the prompt pane and hasn't swept yet (0600): Candle drops a stopped wallet from every list. */
  stoppedWallets: string
  /** Which wallets the panes show, last chosen (0600); config.toml's wallets.show is only where a fresh core starts. */
  walletsShown: string
  /** Each wallet's autonomy, ask every time or trade inside limits with its figures (0600). No config key sets it. */
  autonomyState: string
  /** Each trigger's state: switched on, armed or fired, last fired, cooldowns, and the line it was approved as. */
  triggersState: string
  /** Each bot's state: on, paused or stopped and by whom, the hash it was approved as, its approved versions. */
  botsState: string
  /** Each code bot's state, as botsState for rules bots: its approved run settings by hash and its versions (0600). */
  codeBotsState: string
  /** The supervisor's record of each code bot's process: run outside, stopped, given up, and the pid it started. */
  supervisorState: string
  /** Each supervised code bot's log, the last 5 MB, redacted. */
  botLogsDir: string
  /** Each open bot position's highest price since its entry (0600), for a trailing exit: a price isn't a journal row. */
  botPeaks: string
  /** Where the rules bots' full tape was last heard (0600): a restart reads on from it. */
  botSignalsCursor: string
  /** That this machine has had a vault (0600): with it and no vault, owner steps are refused, never run without the factor. */
  vaultSeen: string
  /** Onboarding's progress (0600): the step reached, and what each step did, read back on resume. */
  onboarding: string
  /** Token names learned from Candle (0600), so a restart names what it replays. */
  symbols: string
  /** Where each agent's default wallet was last found (0600), so a rename never leaves it naming no wallet. */
  defaultPins: string
  /** The layout each tab shows, last chosen (0600); layouts.toml's tab layout is only where a tab starts. */
  layoutChoice: string
  /** The theme last chosen (0600), so a restart keeps it; config.toml's [theme] name is only where a fresh install starts. */
  themeChoice: string
  /** The token panes pinned on a token, by where each is (0600), so a restart keeps them. */
  pinsState: string
  /** Where Hacc's signal tape was last heard (0600): the newest signal's date and id, for "while you were away". */
  signalsCursor: string
  /** Each tab's Signals choice: your rules or Hacc's tape, and its pattern and chain (0600), so a restart keeps them. */
  signalsFilters: string
  /** The chain filter every view shows. */
  chainFilter: string
  /** The chains the account was last known to use (0600), so a core that has just started shows them at once. */
  chainsUsed: string
  /** Each agent's P&L totals from Candle, a sample a minute at most (0600): the P&L window's start, and the chart. */
  pnlSamples: string
  /** The P&L window last picked, and when the main view was last closed (0600); config.toml's [pnl] window is where a fresh install starts. */
  pnlWindow: string
  /** The Build pane's bots folder and harness, as last chosen. */
  buildPrefs: string
  /** The last "while you were away" summary, and what the wallets held at the main view's last close (0600). */
  awayState: string
  /** Image uploads' files, copied in when a card is made, so the upload is the file the card showed. */
  uploads: string
  /** Each agent's research folder, the engine's working folder: beside the state folder, never in it. */
  researchDir(agent: string): string
}

export class PathsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathsError"
  }
}

export class InvalidAgentName extends Error {
  constructor(readonly agent: string) {
    super(`"${agent}" isn't a valid agent name: use 1 to 32 lower-case letters, digits, "-" or "_", starting with a letter or digit`)
    this.name = "InvalidAgentName"
  }
}

export class UnsafeStateDir extends Error {
  constructor(readonly folder: string, reason: string) {
    super(`${folder} ${reason}; the core's state needs a private folder`)
    this.name = "UnsafeStateDir"
  }
}

/** The config folder or a file in it isn't safe to trust. An UnsafeStateDir, so every place that stops on one stops on this. */
export class UnsafeConfigDir extends UnsafeStateDir {
  constructor(folder: string, reason: string, fix: string) {
    super(folder, reason)
    this.message = `${folder} ${reason}; config.toml names the programs the core runs with your agents' keys, so it must be yours alone. ${fix}`
    this.name = "UnsafeConfigDir"
  }
}

export function isAgentName(name: string): boolean {
  return AGENT_NAME.test(name)
}

export function paths(env: Record<string, string | undefined> = process.env): Paths {
  // CANDLE_TUI_HOME is 0.2's name for it, still read when the new one isn't set.
  const named = env.CANDLE_HARNESS_HOME !== undefined ? "CANDLE_HARNESS_HOME" : env.CANDLE_TUI_HOME !== undefined ? "CANDLE_TUI_HOME" : undefined
  const override = named === undefined ? undefined : env[named]
  if (override !== undefined && !isAbsolute(override)) {
    throw new PathsError(`${named} must be an absolute path, not "${override}"`)
  }
  const configDir = override ?? join(env.HOME ?? homedir(), ".config", "candle", "harness")
  const stateDir = join(configDir, "state")
  const keysDir = join(stateDir, "keys")
  const socket = join(stateDir, "core.sock")

  const bytes = Buffer.byteLength(socket)
  if (bytes >= SOCKET_PATH_MAX_BYTES) {
    throw new PathsError(
      `the core's socket path is ${bytes} bytes, and must be under ${SOCKET_PATH_MAX_BYTES}: ${socket}. ` +
        `Set CANDLE_HARNESS_HOME to a shorter folder.`,
    )
  }

  return {
    configDir,
    configFile: join(configDir, "config.toml"),
    layoutsFile: join(configDir, "layouts.toml"),
    walletsFile: join(configDir, "wallets.toml"),
    triggersFile: join(configDir, "triggers.toml"),
    botsFile: join(configDir, "bots.toml"),
    themesDir: join(configDir, "themes"),
    skillsDir: join(configDir, "skills"),
    stateDir,
    socket,
    lock: join(stateDir, "core.lock"),
    journal: join(stateDir, "journal.jsonl"),
    keysDir,
    keyFile(agent) {
      if (!isAgentName(agent)) throw new InvalidAgentName(agent)
      return join(keysDir, `${agent}.key`)
    },
    tokens: join(stateDir, "tokens.json"),
    viewToken: join(stateDir, "view.token"),
    turnsDir: join(stateDir, "turns"),
    homesDir: join(stateDir, "homes"),
    engineState: join(stateDir, "engine.json"),
    killState: join(stateDir, "kill.json"),
    modeState: join(stateDir, "mode.json"),
    activeState: join(stateDir, "active.json"),
    walletsShown: join(stateDir, "wallets-shown.json"),
    autonomyState: join(stateDir, "autonomy.json"),
    triggersState: join(stateDir, "triggers.json"),
    botsState: join(stateDir, "bots.json"),
    codeBotsState: join(stateDir, "code-bots.json"),
    supervisorState: join(stateDir, "supervisor.json"),
    botLogsDir: join(stateDir, "bot-logs"),
    botPeaks: join(stateDir, "bot-peaks.json"),
    botSignalsCursor: join(stateDir, "bot-signals.json"),
    vaultSeen: join(stateDir, "vault-seen.json"),
    onboarding: join(stateDir, "onboarding.json"),
    symbols: join(stateDir, "symbols.json"),
    defaultPins: join(stateDir, "default-wallets.json"),
    signalsCursor: join(stateDir, "signals.json"),
    signalsFilters: join(stateDir, "signals-filters.json"),
    chainFilter: join(stateDir, "chain-filter.json"),
    chainsUsed: join(stateDir, "chains-used.json"),
    pnlSamples: join(stateDir, "pnl.jsonl"),
    pnlWindow: join(stateDir, "pnl-window.json"),
    buildPrefs: join(stateDir, "build.json"),
    awayState: join(stateDir, "away.json"),
    layoutChoice: join(stateDir, "layout.json"),
    themeChoice: join(stateDir, "theme.json"),
    pinsState: join(stateDir, "pins.json"),
    destinations: join(stateDir, "destinations.json"),
    stoppedWallets: join(stateDir, "stopped-wallets.json"),
    uploads: join(stateDir, "uploads"),
    renamesDir: join(stateDir, "renames"),
    researchDir(agent) {
      if (!isAgentName(agent)) throw new InvalidAgentName(agent)
      return join(configDir, "research", agent)
    },
  }
}

/**
 * Creates the state folder 0700. One that's group- or world-writable, a symlink, or someone else's is
 * refused, since another user could have planted a socket or key file there. One
 * that's only readable by others is ours, so it's tightened to 0700.
 */
export async function ensureStateDir(p: Paths): Promise<void> {
  await mkdir(p.stateDir, { recursive: true, mode: 0o700 })
  const info = await lstat(p.stateDir)
  if (info.isSymbolicLink()) throw new UnsafeStateDir(p.stateDir, "is a symlink")
  if (!info.isDirectory()) throw new UnsafeStateDir(p.stateDir, "isn't a folder")
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new UnsafeStateDir(p.stateDir, "belongs to another user")
  }
  if (info.mode & 0o022) {
    throw new UnsafeStateDir(p.stateDir, `is writable by others (mode ${(info.mode & 0o777).toString(8)})`)
  }
  if (info.mode & 0o077) await chmod(p.stateDir, 0o700)
  const problem = configProblem(p)
  if (problem) throw new UnsafeConfigDir(problem.path, problem.why, problem.fix)
}

/**
 * The config folder and the files in it the Candle Harness trusts (config.toml names the binaries the core runs
 * with every agent's key). Each is looked at where it leads, so a folder or file linked from dotfiles is
 * fine. Someone else's, or one anyone can write, is a problem: another user could have put their own
 * program there. One of ours that's only group-writable is tightened, as a private-group umask leaves them.
 */
export function configProblem(p: Paths): { path: string; why: string; fix: string } | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  for (const path of [p.configDir, p.configFile, p.layoutsFile, p.walletsFile, p.triggersFile, p.botsFile]) {
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    const folder = path === p.configDir
    if (folder ? !info.isDirectory() : !info.isFile()) return { path, why: folder ? "isn't a folder" : "isn't a file", fix: `Move ${path} aside.` }
    if (uid !== undefined && info.uid !== uid) return { path, why: "belongs to another user", fix: `Move ${path} aside, and check what's in it before using it again.` }
    const mode = info.mode & 0o777
    if (mode & 0o002) return { path, why: `is writable by anyone (mode ${mode.toString(8)})`, fix: `Check what's in it, then run \`chmod o-w ${path}\`.` }
    if (mode & 0o020) chmodSync(path, mode & ~0o020)
  }
  return undefined
}
