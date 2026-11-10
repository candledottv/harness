// `candle-harness service install | uninstall | status`: an opt-in login service that runs `candle-harness core` headless
// at login, for an always-on machine or a VPS, so triggers run with no terminal open. A LaunchAgent on macOS,
// a systemd user unit on Linux. It restarts the core only if it crashed: `candle-harness stop` ends it until the
// next login. It logs to the state folder's core.log, as a core a view starts does.
//
// The unit carries PATH (the core runs `candle` and the engines by name), CANDLE_HARNESS_HOME when it's set, and the
// proxy and certificate variables when they're set, since a core without the proxy it was set up behind can't
// reach Candle. Never a key: the agents' keys are in the state folder, and the CLI's own are the CLI's.
//
// On Linux a user's services end at logout unless lingering is on; the Candle Harness says so, and never turns it on.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { spawnSync } from "node:child_process"
import { connectView, STOP_CLIENT } from "../core/client"
import { paths as pathsOf, type Paths } from "../paths"
import { answers } from "../shared/socket-path"
import { relativeEntries } from "../shared/exec-path"
import { coreLogPath } from "../view/attach"
import { migrateHome, oldCoreRunning, type HomeMove } from "../migrate-home"

export const SERVICE_LABEL = "tv.candle.harness.core"
export const SYSTEMD_UNIT = "candle-harness-core.service"
/** The Candle TUI 0.2's names for the same service: found, said, and replaced by `service install`. */
export const OLD_SERVICE_LABEL = "tv.candle.tui.core"
export const OLD_SYSTEMD_UNIT = "candle-tui-core.service"

/** The variables the unit carries from the shell it's installed from, when set: a list, so never Bun's own (BUN_OPTIONS). */
export const CARRIED_ENV = ["PATH", "CANDLE_HARNESS_HOME", "LANG", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

export interface ServiceDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
  uid: number
  /** The login name, for loginctl. */
  user: string | undefined
  /** How to run this binary: the service's ExecStart or ProgramArguments, before `core --service`. */
  self: string[]
  run: (cmd: string, args: string[]) => Ran
  /** Copies 0.2's home into the new one when it's due (migrate-home.ts); tests pass their own clock. */
  moveHome?: () => Promise<HomeMove>
  /** Whether a pid is a live process: 0.2's core, while it stops. */
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

const realRun = (cmd: string, args: string[]): Ran => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 })
    return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") }
  } catch (error) {
    return { code: 127, stdout: "", stderr: (error as Error).message }
  }
}

export function defaultServiceDeps(env: Record<string, string | undefined>, self: string[], user: string | undefined): ServiceDeps {
  return { platform: process.platform, env, home: env.HOME ?? homedir(), uid: process.getuid?.() ?? 0, user, self, run: realRun }
}

/** Where the service's file goes: undefined where there's no service (not macOS or Linux). */
export function serviceFile(d: Pick<ServiceDeps, "platform" | "env" | "home">, old = false): string | undefined {
  if (d.platform === "darwin") return join(d.home, "Library", "LaunchAgents", `${old ? OLD_SERVICE_LABEL : SERVICE_LABEL}.plist`)
  if (d.platform === "linux") {
    const config = d.env.XDG_CONFIG_HOME?.startsWith("/") ? d.env.XDG_CONFIG_HOME : join(d.home, ".config")
    return join(config, "systemd", "user", old ? OLD_SYSTEMD_UNIT : SYSTEMD_UNIT)
  }
  return undefined
}

/** The Candle TUI 0.2's login service file, when it's still installed: it runs `candle-tui core` on the old home. */
export function oldServiceFile(d: Pick<ServiceDeps, "platform" | "env" | "home">): string | undefined {
  const file = serviceFile(d, true)
  return file && existsSync(file) ? file : undefined
}

/**
 * Stops and removes 0.2's login service, so its core never runs on the old home beside this one (and the
 * home's copy, which waits while a 0.2 core runs, isn't held up by it). Returns the file it removed.
 */
function retireOldService(d: ServiceDeps): string | undefined {
  const file = oldServiceFile(d)
  if (!file) return undefined
  if (d.platform === "darwin") d.run("launchctl", ["bootout", `gui/${d.uid}/${OLD_SERVICE_LABEL}`])
  else d.run("systemctl", ["--user", "disable", "--now", OLD_SYSTEMD_UNIT])
  rmSync(file, { force: true })
  if (d.platform === "linux") d.run("systemctl", ["--user", "daemon-reload"])
  return file
}

const OLD_SERVICE_WORDS = "the Candle TUI 0.2's login service, which runs `candle-tui core` on the old home"

/** The variables carried, by name, with their values from `env`. */
export function carried(env: Record<string, string | undefined>): [string, string][] {
  return CARRIED_ENV.flatMap((name) => {
    const value = name === "PATH" && env.PATH ? onePath(env.PATH) : env[name]
    return value ? [[name, value] as [string, string]] : []
  })
}

/**
 * PATH with each folder once, in its first place, and no empty entries: a login shell often repeats folders, and
 * the same setup must write the same file, so a second install from another shell keeps the running service.
 * Entries that aren't absolute are left out: the service's core starts engines in their agents' folders, and
 * such an entry would be looked up there.
 */
export function onePath(path: string): string {
  const seen = new Set<string>()
  return path
    .split(":")
    .filter((dir) => isAbsolute(dir) && !seen.has(dir) && (seen.add(dir), true))
    .join(":")
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The LaunchAgent: started at login, restarted only after a crash (a clean exit, as `candle-harness stop` makes, isn't). */
export function launchAgentText(self: readonly string[], p: Paths, env: Record<string, string | undefined>): string {
  const args = [...self, "core", "--service"].map((a) => `    <string>${xml(a)}</string>`).join("\n")
  const vars = carried(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n")
  const log = xml(coreLogPath(p))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`
}

/** A word a systemd line can't hold: a line break would start a line of its own (another directive) in the unit. */
export class UnitWordRefused extends Error {}

/**
 * One word of a systemd line, quoted: `%` is systemd's specifier and `$` its variable, so both are doubled. A word
 * with a line break (or any other control character) is refused, never written.
 */
const unitWord = (text: string, what = "the command it runs") => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's refused
  if (/[\x00-\x1f\x7f]/.test(text)) throw new UnitWordRefused(`${what} holds a line break or another control character, which a systemd unit can't hold`)
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`
}

/** The systemd user unit: started at login (with lingering, at boot), restarted only after a crash. */
export function systemdUnitText(self: readonly string[], p: Paths, env: Record<string, string | undefined>): string {
  const log = coreLogPath(p)
  // `append:` takes a bare path: one with a space or a % goes to systemd's journal instead.
  const logLines = /[\s%]/.test(log) ? [] : [`StandardOutput=append:${log}`, `StandardError=append:${log}`]
  return [
    "[Unit]",
    "Description=Candle Harness core",
    "",
    "[Service]",
    `ExecStart=${[...self, "core", "--service"].map((w) => unitWord(w)).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=30",
    ...carried(env).map(([k, v]) => `Environment=${unitWord(`${k}=${v}`, k).replace(/\$\$/g, "$")}`),
    ...logLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

/** A file's text as printed: a proxy's user and password in a URL are left out. */
export const shownText = (text: string) => text.replace(/(\/\/)[^/@\s"<]+@/g, "$1…@")

/** Whether lingering is on for the user, by loginctl; undefined when loginctl can't say. */
function linger(d: ServiceDeps): boolean | undefined {
  if (!d.user) return undefined
  const r = d.run("loginctl", ["show-user", d.user, "--property=Linger", "--value"])
  const v = r.stdout.trim()
  return r.code === 0 && (v === "yes" || v === "no") ? v === "yes" : undefined
}

function lingerWords(d: ServiceDeps): string {
  const on = linger(d)
  const enable = `\`loginctl enable-linger ${d.user ?? "$USER"}\``
  if (on === true) return "Lingering is on for you, so the service keeps running after you log out, and starts at boot."
  if (on === false) return `On a VPS: your user's services stop when you log out unless lingering is on. ${enable} turns it on (it may need sudo); the Candle Harness never runs it.`
  return `On a VPS: your user's services stop when you log out unless lingering is on (${enable}, which may need sudo); the Candle Harness never runs it.`
}

/** The running core's pid and whether it's headless, read as a view that only reads; undefined with none. */
async function runningCore(p: Paths): Promise<{ pid?: number; headless?: boolean } | undefined> {
  if (!(await answers(p.socket))) return undefined
  try {
    const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: STOP_CLIENT })
    try {
      const status = (await connection.request("core.status", {})) as { pid?: unknown; headless?: unknown }
      return { ...(typeof status.pid === "number" ? { pid: status.pid } : {}), ...(typeof status.headless === "boolean" ? { headless: status.headless } : {}) }
    } finally {
      connection.close()
    }
  } catch {
    return {}
  }
}

export type ServiceState = { installed: false; file: string } | { installed: true; file: string; loaded: boolean; running?: number; words: string }

/** Whether the service is installed and loaded, and its core's pid when the service manager says. */
export function serviceState(d: ServiceDeps): ServiceState | undefined {
  const file = serviceFile(d)
  if (!file) return undefined
  if (!existsSync(file)) return { installed: false, file }
  if (d.platform === "darwin") {
    const r = d.run("launchctl", ["print", `gui/${d.uid}/${SERVICE_LABEL}`])
    if (r.code !== 0) return { installed: true, file, loaded: false, words: "installed, not loaded: it starts at your next login" }
    const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1]
    // launchd says `state = not running` for a loaded job with no process: nothing to add to "not running".
    const state = /^\s*state = (.+?)\s*$/m.exec(r.stdout)?.[1]
    const extra = state && !/^not running$/.test(state) ? ` (${state})` : ""
    return { installed: true, file, loaded: true, ...(pid ? { running: Number(pid) } : {}), words: pid ? `loaded, its core running (pid ${pid})` : `loaded, its core not running now${extra}` }
  }
  const enabled = d.run("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT]).stdout.trim()
  const active = d.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim()
  const pid = d.run("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=MainPID", "--value"]).stdout.trim()
  const running = active === "active" && /^[1-9]\d*$/.test(pid) ? Number(pid) : undefined
  return { installed: true, file, loaded: enabled === "enabled", ...(running ? { running } : {}), words: `${enabled || "unknown"}, ${active || "unknown"}${running ? ` (pid ${running})` : ""}` }
}

const USAGE = "Usage: candle-harness service install | uninstall | status\n"

export async function serviceCommand(args: string[], io: { out(text: string): void; err(text: string): void }, d: ServiceDeps): Promise<number> {
  const [verb, ...rest] = args
  if (rest.length > 0 || (verb !== "install" && verb !== "uninstall" && verb !== "status")) {
    io.err(USAGE)
    return 2
  }
  const file = serviceFile(d)
  if (!file) {
    io.err("The login service runs on macOS (launchd) and Linux (systemd). Here, run `candle-harness core` in tmux or screen to keep the core up.\n")
    return 1
  }
  const p = pathsOf(d.env)
  if (verb === "status") return status(io, d, p)
  if (verb === "uninstall") return uninstall(io, d, file)
  return install(io, d, p, file)
}

async function status(io: { out(text: string): void }, d: ServiceDeps, p: Paths): Promise<number> {
  const s = serviceState(d)!
  const old = oldServiceFile(d)
  if (old) io.out(`${old} is ${OLD_SERVICE_WORDS}. \`candle-harness service install\` replaces it; \`candle-harness service uninstall\` removes it.\n`)
  if (!s.installed) io.out(`The login service isn't installed (it would be ${s.file}). \`candle-harness service install\` adds it.\n`)
  else io.out(`The login service is installed at ${s.file}: ${s.words}.\n`)
  const core = await runningCore(p)
  const old02 = await oldCoreRunning(d.env, d.isAlive)
  if (old02 !== undefined) io.out(`A Candle TUI 0.2 core is running (pid ${old02}) on the old home.\n`)
  if (!core) io.out(`No Candle Harness core is running now.\n`)
  else io.out(`A core is running now${core.pid ? ` (pid ${core.pid}${s.installed && s.running === core.pid ? ", the service's" : ""})` : ""}${core.headless === false ? ", started by a view" : ""}.\n`)
  if (d.platform === "linux" && s.installed) io.out(`${lingerWords(d)}\n`)
  return 0
}

async function install(io: { out(text: string): void; err(text: string): void }, d: ServiceDeps, p: Paths, file: string): Promise<number> {
  const old = retireOldService(d)
  if (old) io.out(`Stopped and removed ${old}, ${OLD_SERVICE_WORDS}.\n`)
  // 0.2's home is copied before the service's core first starts: launchd and systemd open core.log in the new
  // home before the core runs, and a new home that's there is never copied into, so the core would start empty.
  const moved = await copyOldHome(d, old !== undefined)
  if (moved.kind === "refused" || moved.kind === "failed") {
    const why = moved.kind === "refused" ? moved.message : `Couldn't copy Candle TUI 0.2's folder to the new one (${moved.error}). Nothing was changed in the old folder.`
    io.err(`${why}\nThe login service isn't installed: run \`candle-harness service install\` again once that's done.\n`)
    return 1
  }
  if (moved.kind === "copied") io.out(`Copied Candle TUI 0.2's config, keys and journal from ${moved.from} to ${moved.to}. The old folder is renamed aside once the service's core starts well, and never deleted.\n`)
  let text: string
  try {
    text = d.platform === "darwin" ? launchAgentText(d.self, p, d.env) : systemdUnitText(d.self, p, d.env)
  } catch (error) {
    if (!(error instanceof UnitWordRefused)) throw error
    io.err(`The login service isn't installed: ${error.message}. Set it without one and run \`candle-harness service install\` again.\n`)
    return 1
  }
  mkdirSync(dirname(file), { recursive: true })
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
  // 0600: a proxy's address can carry its password. A mode given to a write only counts when the file is made,
  // so one that was there with wider access is replaced by a new file, and one kept as it is has its mode set.
  if (before === text) chmodSync(file, 0o600)
  else {
    const part = `${file}.part`
    rmSync(part, { force: true })
    writeFileSync(part, text, { mode: 0o600 })
    chmodSync(part, 0o600)
    renameSync(part, file)
  }
  if (before === text) io.out(`Kept ${file}: it already says what this install would write.\n`)
  else io.out(`${before === undefined ? "Wrote" : "Rewrote"} ${file}:\n\n${shownText(text)}\n`)
  const names = carried(d.env).map(([k]) => k)
  const dropped = relativeEntries(d.env.PATH)
  if (dropped.length > 0) io.out(`Left out of its PATH: ${dropped.join(", ")}. An entry that isn't a full path would be looked up in whatever folder a program starts in.\n`)
  io.out(`It carries ${names.length ? names.join(", ") : "nothing"} from this shell, and runs ${[...d.self, "core", "--service"].join(" ")} at login. It logs to ${coreLogPath(p)}. It restarts the core only if it crashed: \`candle-harness stop\` ends it until your next login.\n`)
  const core = await runningCore(p)
  const unchanged = before === text
  const started = d.platform === "darwin" ? await loadLaunchAgent(io, d, file, unchanged, core) : loadSystemdUnit(io, d, unchanged, core)
  if (!started) {
    const now = await runningCore(p)
    io.err(now ? `A core is running now${now.pid ? ` (pid ${now.pid})` : ""}, but not the service's.\n` : "No Candle Harness core is running now.\n")
    return 1
  }
  if (d.platform === "linux") io.out(`${lingerWords(d)}\n`)
  return 0
}

const sleepFor = (d: ServiceDeps) => d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

/** launchd's word on the service: loaded or not, and its core's pid when it has one. */
function launchd(d: ServiceDeps): { loaded: boolean; pid?: number } {
  const r = d.run("launchctl", ["print", `gui/${d.uid}/${SERVICE_LABEL}`])
  if (r.code !== 0) return { loaded: false }
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1]
  return { loaded: true, ...(pid ? { pid: Number(pid) } : {}) }
}

/** launchd's error for a label it's still unloading: `bootstrap` right after `bootout` gets it until the job is gone. */
const LAUNCHD_BUSY = 5
const UNLOAD_WAIT_MS = 10_000
const UNLOAD_POLL_MS = 250
const BOOTSTRAP_TRIES = 5

type Io = { out(text: string): void; err(text: string): void }
type Core = { pid?: number; headless?: boolean } | undefined

/**
 * Loads the LaunchAgent. A file that didn't change, already loaded, is kept as it runs: its core is never stopped
 * (and started with `kickstart` when it isn't running). A changed one replaces the loaded copy: `bootout` returns
 * before launchd has let the job go, so the label is waited out before `bootstrap`, and `bootstrap` is asked again
 * while launchd still answers that it's busy. False when the service couldn't be loaded, said with the command to run.
 */
async function loadLaunchAgent(io: Io, d: ServiceDeps, file: string, unchanged: boolean, core: Core): Promise<boolean> {
  const sleep = sleepFor(d)
  const target = `gui/${d.uid}/${SERVICE_LABEL}`
  const was = launchd(d)
  if (unchanged && was.loaded) {
    if (was.pid !== undefined) {
      io.out(`The service is loaded and its core is running (pid ${was.pid}): nothing was restarted.\n`)
      return true
    }
    if (core) {
      io.out(`The service is loaded. A core is running now${core.pid ? ` (pid ${core.pid})` : ""}, so the service's core starts at your next login. To hand over now, run \`candle-harness stop\`, then \`candle-harness service install\` again.\n`)
      return true
    }
    const r = d.run("launchctl", ["kickstart", target])
    if (r.code !== 0) {
      io.err(`\`launchctl kickstart ${target}\` failed (exit ${r.code}): ${lastLine(r)}\nThe service is loaded: its core starts at your next login, or run that command yourself.\n`)
      return false
    }
    io.out("The service was loaded with its core stopped: its core is starting now, and starts at every login.\n")
    return true
  }
  if (was.loaded) {
    d.run("launchctl", ["bootout", target]) // the older copy: replaced
    for (let waited = 0; launchd(d).loaded && waited < UNLOAD_WAIT_MS; waited += UNLOAD_POLL_MS) await sleep(UNLOAD_POLL_MS)
  }
  let r: Ran = { code: 0, stdout: "", stderr: "" }
  for (let n = 0; n < BOOTSTRAP_TRIES; n++) {
    r = d.run("launchctl", ["bootstrap", `gui/${d.uid}`, file])
    if (r.code !== LAUNCHD_BUSY) break
    await sleep(500 * 2 ** n)
  }
  if (r.code !== 0) {
    io.err(`\`launchctl bootstrap gui/${d.uid} ${file}\` failed (exit ${r.code}): ${lastLine(r)}\nThe file is written but the service isn't loaded, so its core isn't running. Run that command yourself in a minute, or log out and in.\n`)
    return false
  }
  coreWords(io, core, was.pid)
  return true
}

/** Enables the systemd unit now. A changed unit whose core runs is restarted, so it runs as the new file says. */
function loadSystemdUnit(io: Io, d: ServiceDeps, unchanged: boolean, core: Core): boolean {
  const active = !unchanged && d.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim() === "active"
  const steps: string[][] = [["--user", "daemon-reload"], ["--user", "enable", "--now", SYSTEMD_UNIT], ...(active ? [["--user", "restart", SYSTEMD_UNIT]] : [])]
  for (const a of steps) {
    const r = d.run("systemctl", a)
    if (r.code !== 0) {
      io.err(`\`systemctl ${a.join(" ")}\` failed (exit ${r.code}): ${lastLine(r)}\nThe file is written; run that command yourself once the problem is fixed, or log out and in.\n`)
      return false
    }
  }
  if (active) io.out("The service's core restarted, so it runs as the new file says.\n")
  else coreWords(io, core, undefined)
  return true
}

/** What runs now: the service's own core, restarted; another core, which keeps the socket until it's stopped; or none. */
function coreWords(io: Io, core: Core, servicePid: number | undefined): void {
  if (core && servicePid !== undefined && core.pid === servicePid) io.out("The service's core restarted, so it runs as the new file says.\n")
  else if (core) io.out(`A core is running now${core.pid ? ` (pid ${core.pid})` : ""}, so the service's core starts at your next login. To hand over now, run \`candle-harness stop\`, then \`candle-harness service install\` again.\n`)
  else io.out("The service's core is starting now, and starts at every login.\n")
}

const lastLine = (r: Ran) => (r.stderr || r.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? ""

/**
 * Starts the login service's core, for a restart once the running core has stopped: a core that stops cleanly
 * isn't started again by launchd or systemd, so it's asked for. "not loaded" when the service isn't installed
 * and loaded (enabled, on Linux), and the caller starts a core of its own instead.
 */
export function startServiceCore(d: ServiceDeps): "started" | "not loaded" | { failed: string } {
  const file = serviceFile(d)
  if (!file || !existsSync(file)) return "not loaded"
  const r =
    d.platform === "darwin"
      ? launchd(d).loaded
        ? d.run("launchctl", ["kickstart", `gui/${d.uid}/${SERVICE_LABEL}`])
        : undefined
      : d.run("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT]).stdout.trim() === "enabled"
        ? d.run("systemctl", ["--user", "start", SYSTEMD_UNIT])
        : undefined
  if (!r) return "not loaded"
  return r.code === 0 ? "started" : { failed: lastLine(r) || `exit ${r.code}` }
}

/**
 * 0.2's home, copied when it's due. A 0.2 core just stopped with its service is waited for, up to 10 s; one
 * running in a view isn't: it's said, for the person to quit.
 */
async function copyOldHome(d: ServiceDeps, oldJustStopped: boolean): Promise<HomeMove | { kind: "failed"; error: string }> {
  const move = d.moveHome ?? (() => migrateHome(d.env, d.isAlive ? { isAlive: d.isAlive } : {}))
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  try {
    let moved = await move()
    for (let n = 0; moved.kind === "refused" && oldJustStopped && n < 20; n++) {
      await sleep(500)
      moved = await move()
    }
    return moved
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}

function uninstall(io: { out(text: string): void; err(text: string): void }, d: ServiceDeps, file: string): number {
  const old = retireOldService(d)
  if (old) io.out(`Stopped and removed ${old}, ${OLD_SERVICE_WORDS}.\n`)
  if (!existsSync(file)) {
    if (old) return 0
    io.out(`The login service isn't installed (no ${file}).\n`)
    return 0
  }
  if (d.platform === "darwin") d.run("launchctl", ["bootout", `gui/${d.uid}/${SERVICE_LABEL}`])
  else d.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT])
  rmSync(file, { force: true })
  if (d.platform === "linux") d.run("systemctl", ["--user", "daemon-reload"])
  io.out(`Removed ${file}, and stopped the core the service ran, if it was running. Your triggers are kept: they run again whenever a core runs (open the Candle Harness, or \`candle-harness core\`).\n`)
  return 0
}
