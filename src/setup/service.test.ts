// The login service: the LaunchAgent's and the systemd unit's text (restarted only after a crash, the variables it
// carries and never a key, quoting), what install, uninstall and status run and say, the linger line, and the
// refusal where there's no service manager.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { paths } from "../paths"
import { launchAgentText, oldServiceFile, onePath, type Ran, serviceCommand, type ServiceDeps, serviceFile, shownText, startServiceCore, systemdUnitText, UnitWordRefused } from "./service"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const home = () => {
  const d = mkdtempSync("/tmp/chrn-svc-")
  dirs.push(d)
  return d
}
const SELF = ["/usr/local/bin/candle-harness"]
const ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", CANDLE_HARNESS_HOME: "/tmp/chrn-x", HTTPS_PROXY: "http://me:secret@proxy.local:3128", CANDLE_API_KEY: "never-carried", BUN_OPTIONS: "--preload=/tmp/never-carried.ts", HOME: "/Users/someone" }

/**
 * A fake launchd for the service's label, as macOS behaves: `bootout` returns while the job is still going, so
 * the label stays loaded for `lag` more `print`s, and `bootstrap` meanwhile fails with exit 5 (EIO).
 */
export interface FakeLaunchd {
  loaded: boolean
  pid?: number
  lag: number
  unloading: number
}

function deps(platform: NodeJS.Platform, h: string, answers: Record<string, Ran> = {}, launchd: FakeLaunchd = { loaded: false, lag: 0, unloading: 0 }): ServiceDeps & { ran: string[]; launchd: FakeLaunchd } {
  const ran: string[] = []
  const ok = { code: 0, stdout: "", stderr: "" }
  const fake = (line: string): Ran => {
    if (line === "launchctl print gui/501/tv.candle.harness.core") {
      if (launchd.unloading > 0 && --launchd.unloading === 0) launchd.loaded = false
      return launchd.loaded ? { code: 0, stdout: `gui/501/tv.candle.harness.core = {\n${launchd.pid ? `\tpid = ${launchd.pid}\n` : "\tstate = not running\n"}}`, stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" }
    }
    if (line === "launchctl bootout gui/501/tv.candle.harness.core") {
      if (!launchd.loaded) return { code: 3, stdout: "", stderr: "No such process" }
      delete launchd.pid
      if (launchd.lag > 0) launchd.unloading = launchd.lag
      else launchd.loaded = false
      return ok
    }
    if (line.startsWith("launchctl bootstrap gui/501 ") && line.endsWith("tv.candle.harness.core.plist")) {
      if (launchd.loaded) {
        if (launchd.unloading > 0 && --launchd.unloading === 0) launchd.loaded = false
        return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
      }
      launchd.loaded = true
      launchd.pid = 4242
      return ok
    }
    if (line === "launchctl kickstart gui/501/tv.candle.harness.core") {
      if (!launchd.loaded) return { code: 113, stdout: "", stderr: "Could not find service" }
      launchd.pid = 4243
      return ok
    }
    return ok
  }
  return {
    platform,
    env: { ...ENV, HOME: h, CANDLE_HARNESS_HOME: join(h, "harness") },
    home: h,
    uid: 501,
    user: "someone",
    self: SELF,
    ran,
    launchd,
    sleep: async () => {},
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`
      ran.push(line)
      return answers[line] ?? fake(line)
    },
  }
}
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { text: () => out.join(""), errors: () => err.join(""), io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } }
}

test("the LaunchAgent: runs `core --service` at login, restarted only after a crash, logging to core.log, carrying PATH and the proxy and never a key", () => {
  const text = launchAgentText(SELF, paths({ CANDLE_HARNESS_HOME: "/tmp/chrn-x" }), ENV)
  expect(text).toContain("<string>tv.candle.harness.core</string>")
  expect(text).toContain("<string>/usr/local/bin/candle-harness</string>\n    <string>core</string>\n    <string>--service</string>")
  expect(text).toContain("<key>RunAtLoad</key>\n  <true/>")
  expect(text).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>")
  expect(text).toContain("<key>PATH</key>\n    <string>/usr/local/bin:/usr/bin:/bin</string>")
  expect(text).toContain("<key>CANDLE_HARNESS_HOME</key>\n    <string>/tmp/chrn-x</string>")
  expect(text).toContain("<key>HTTPS_PROXY</key>")
  expect(text).toContain("<string>/tmp/chrn-x/state/core.log</string>")
  expect(text).not.toContain("CANDLE_API_KEY")
  expect(text).not.toContain("never-carried")
  expect(systemdUnitText(["/usr/local/bin/candle-harness"], paths({ CANDLE_HARNESS_HOME: "/tmp/chrn-x" }), ENV)).not.toContain("BUN_OPTIONS")
  expect(launchAgentText(["/a b/c&d"], paths({ CANDLE_HARNESS_HOME: "/tmp/chrn-x" }), {})).toContain("<string>/a b/c&amp;d</string>")
})

test("the systemd unit: Restart=on-failure, each word quoted, % and $ kept as written, and a log path with a space left to the journal", () => {
  const text = systemdUnitText(["/opt/my tui/candle-harness"], paths({ CANDLE_HARNESS_HOME: "/tmp/chrn-x" }), { PATH: "/a:/b", LANG: "en_US.UTF-8%x$y" })
  expect(text.split("\n")).toEqual([
    "[Unit]",
    "Description=Candle Harness core",
    "",
    "[Service]",
    'ExecStart="/opt/my tui/candle-harness" "core" "--service"',
    "Restart=on-failure",
    "RestartSec=30",
    'Environment="PATH=/a:/b"',
    'Environment="LANG=en_US.UTF-8%%x$y"',
    "StandardOutput=append:/tmp/chrn-x/state/core.log",
    "StandardError=append:/tmp/chrn-x/state/core.log",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ])
  expect(systemdUnitText(["/x$y"], paths({ CANDLE_HARNESS_HOME: "/tmp/chrn x" }), {})).toContain('ExecStart="/x$$y" "core" "--service"')
  expect(systemdUnitText(["/x"], paths({ CANDLE_HARNESS_HOME: "/tmp/chrn x" }), {})).not.toContain("StandardOutput")
})

test("a line break in a carried variable or the command is refused, never written into the unit as a line of its own", async () => {
  const p = paths({ CANDLE_HARNESS_HOME: "/tmp/chrn-x" })
  expect(() => systemdUnitText(["/usr/local/bin/candle-harness"], p, { PATH: "/usr/bin", HTTPS_PROXY: "http://me:secret@p:1\nExecStartPre=/bin/sh -c evil" })).toThrow(UnitWordRefused)
  expect(() => systemdUnitText(["/opt/x\nExecStartPre=/bin/evil"], p, {})).toThrow("the command it runs holds a line break")
  const h = home()
  const base = deps("linux", h)
  const d = { ...base, env: { ...base.env, HTTPS_PROXY: "http://me:secret@p:1\nExecStartPre=/bin/sh -c evil" } }
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(1)
  expect(t.errors()).toContain("HTTPS_PROXY holds a line break")
  expect(t.errors()).not.toContain("secret")
  expect(t.errors()).not.toContain("evil")
  expect(existsSync(serviceFile(d)!)).toBe(false)
})

test("printed, a proxy's user and password are left out", () => {
  expect(shownText("<string>http://me:secret@proxy.local:3128</string>")).toBe("<string>http://…@proxy.local:3128</string>")
})

test("install on macOS: writes the LaunchAgent 0600, prints it, replaces a loaded copy and loads it; uninstall unloads and removes it", async () => {
  const h = home()
  const d = deps("darwin", h)
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  const file = join(h, "Library/LaunchAgents/tv.candle.harness.core.plist")
  expect(serviceFile(d)).toBe(file)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(d.ran).toEqual(["launchctl print gui/501/tv.candle.harness.core", `launchctl bootstrap gui/501 ${file}`])
  expect(t.text()).toStartWith(`Wrote ${file}:\n\n<?xml`)
  expect(t.text()).toContain("http://…@proxy.local:3128")
  expect(t.text()).not.toContain("secret")
  expect(t.text()).toContain("It carries PATH, CANDLE_HARNESS_HOME, HTTPS_PROXY from this shell")
  expect(t.text()).toContain("The service's core is starting now, and starts at every login.")
  expect(readFileSync(file, "utf8")).toContain("secret") // the file itself carries the proxy as set

  const again = io()
  d.ran.length = 0
  await serviceCommand(["install"], again.io, d)
  expect(again.text()).toStartWith(`Kept ${file}: it already says what this install would write.\n`)
  expect(again.text()).not.toContain("<?xml")
  // Kept and loaded: the running core is left alone.
  expect(d.ran).toEqual(["launchctl print gui/501/tv.candle.harness.core"])
  expect(again.text()).toContain("The service is loaded and its core is running (pid 4242): nothing was restarted.")

  const u = io()
  d.ran.length = 0
  expect(await serviceCommand(["uninstall"], u.io, d)).toBe(0)
  expect(d.ran).toEqual(["launchctl bootout gui/501/tv.candle.harness.core"])
  expect(existsSync(file)).toBe(false)
  expect(u.text()).toContain("Your triggers are kept")
})

test("a failed load says so and what to run, with the file written", async () => {
  const h = home()
  const file = join(h, "Library/LaunchAgents/tv.candle.harness.core.plist")
  const d = deps("darwin", h, { [`launchctl bootstrap gui/501 ${file}`]: { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } })
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(1)
  expect(t.errors()).toContain("`launchctl bootstrap gui/501 " + file + "` failed (exit 5): Bootstrap failed: 5: Input/output error")
  expect(t.errors()).toContain("The file is written but the service isn't loaded, so its core isn't running. Run that command yourself in a minute, or log out and in.")
  expect(t.errors()).toContain("No Candle Harness core is running now.")
  // launchd's busy answer is asked again a few times, then said.
  expect(d.ran.filter((r) => r.startsWith("launchctl bootstrap")).length).toBe(5)
  expect(existsSync(file)).toBe(true)
})

test("a changed LaunchAgent over a loaded one: the old job is waited out after bootout, so bootstrap loads the new one and the core runs", async () => {
  const h = home()
  // launchd lets the old job go only after a few more answers: bootstrap at once would get exit 5.
  const d = deps("darwin", h, {}, { loaded: true, pid: 1930, lag: 3, unloading: 0 })
  const file = serviceFile(d)!
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "an older copy")
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  expect(t.errors()).toBe("")
  expect(t.text()).toContain(`Rewrote ${file}:`)
  expect(d.launchd).toMatchObject({ loaded: true, pid: 4242 })
  const boot = d.ran.indexOf(`launchctl bootstrap gui/501 ${file}`)
  expect(d.ran.indexOf("launchctl bootout gui/501/tv.candle.harness.core")).toBeLessThan(boot)
  expect(d.ran.slice(0, boot).filter((r) => r === "launchctl print gui/501/tv.candle.harness.core").length).toBeGreaterThan(1)
  expect(t.text()).toContain("The service's core is starting now, and starts at every login.")
})

test("bootstrap answering busy is asked again until launchd lets the old job go", async () => {
  const h = home()
  // launchd says the old job is gone at once, but still refuses the first bootstrap with exit 5.
  const launchd = { loaded: true, pid: 1930, lag: 0, unloading: 0 }
  const d = deps("darwin", h, {}, launchd)
  const run = d.run
  let refusedOnce = false
  d.run = (cmd, args) => {
    if (args[0] === "bootstrap" && !refusedOnce) {
      refusedOnce = true
      d.ran.push(`${cmd} ${args.join(" ")}`)
      return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
    }
    return run(cmd, args)
  }
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  expect(d.ran.filter((r) => r.startsWith("launchctl bootstrap")).length).toBe(2)
  expect(launchd).toMatchObject({ loaded: true, pid: 4242 })
})

test("kept and loaded with its core stopped (after `candle-harness stop`): started with kickstart, never booted out", async () => {
  const h = home()
  const d = deps("darwin", h)
  await serviceCommand(["install"], io().io, d)
  delete d.launchd.pid
  d.ran.length = 0
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  expect(d.ran).toEqual(["launchctl print gui/501/tv.candle.harness.core", "launchctl kickstart gui/501/tv.candle.harness.core"])
  expect(t.text()).toContain("its core is starting now")
})

test("PATH is carried with each folder once: a shell that repeats folders writes the same file, so the service is kept", async () => {
  const h = home()
  const d = deps("darwin", h)
  d.env.PATH = "/usr/local/bin:/usr/bin:/usr/local/bin::/bin:/usr/bin"
  await serviceCommand(["install"], io().io, d)
  const file = serviceFile(d)!
  expect(readFileSync(file, "utf8")).toContain("<key>PATH</key>\n    <string>/usr/local/bin:/usr/bin:/bin</string>")
  d.env.PATH = "/usr/local/bin:/usr/bin:/bin"
  d.ran.length = 0
  const t = io()
  await serviceCommand(["install"], t.io, d)
  expect(t.text()).toStartWith(`Kept ${file}`)
  expect(d.ran.some((r) => r.includes("bootout"))).toBe(false)
})

test("install on Linux: the user unit, enabled now, and the linger line; the Candle Harness never turns lingering on", async () => {
  const h = home()
  const d = deps("linux", h, { "loginctl show-user someone --property=Linger --value": { code: 0, stdout: "no\n", stderr: "" } })
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  const file = join(h, ".config/systemd/user/candle-harness-core.service")
  expect(existsSync(file)).toBe(true)
  expect(d.ran).toEqual(["systemctl --user is-active candle-harness-core.service", "systemctl --user daemon-reload", "systemctl --user enable --now candle-harness-core.service", "loginctl show-user someone --property=Linger --value"])
  expect(t.text()).toContain("`loginctl enable-linger someone` turns it on (it may need sudo); the Candle Harness never runs it.")
  expect(d.ran.some((r) => r.includes("enable-linger"))).toBe(false)
  expect(serviceFile({ ...d, env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/systemd/user/candle-harness-core.service")
})

test("status: not installed, then installed and running, by the service manager's words", async () => {
  const h = home()
  const d = deps("linux", h, {
    "systemctl --user is-enabled candle-harness-core.service": { code: 0, stdout: "enabled\n", stderr: "" },
    "systemctl --user is-active candle-harness-core.service": { code: 0, stdout: "active\n", stderr: "" },
    "systemctl --user show candle-harness-core.service --property=MainPID --value": { code: 0, stdout: "777\n", stderr: "" },
    "loginctl show-user someone --property=Linger --value": { code: 0, stdout: "yes\n", stderr: "" },
  })
  const before = io()
  expect(await serviceCommand(["status"], before.io, d)).toBe(0)
  expect(before.text()).toBe(`The login service isn't installed (it would be ${join(h, ".config/systemd/user/candle-harness-core.service")}). \`candle-harness service install\` adds it.\nNo Candle Harness core is running now.\n`)
  await serviceCommand(["install"], io().io, d)
  const after = io()
  await serviceCommand(["status"], after.io, d)
  expect(after.text()).toContain(": enabled, active (pid 777).")
  expect(after.text()).toContain("Lingering is on for you")
})

test("Linux: a changed unit whose core runs is restarted, so it runs as the new file says; an unchanged one is left running", async () => {
  const h = home()
  const d = deps("linux", h, { "systemctl --user is-active candle-harness-core.service": { code: 0, stdout: "active\n", stderr: "" } })
  const file = serviceFile(d)!
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "an older copy")
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  expect(d.ran).toContain("systemctl --user restart candle-harness-core.service")
  expect(t.text()).toContain("The service's core restarted, so it runs as the new file says.")
  d.ran.length = 0
  await serviceCommand(["install"], io().io, d)
  expect(d.ran.some((r) => r.includes("restart"))).toBe(false)
})

test("elsewhere there's no service; a wrong verb is the usage", async () => {
  const t = io()
  expect(await serviceCommand(["install"], t.io, deps("win32", home()))).toBe(1)
  expect(t.errors()).toContain("macOS (launchd) and Linux (systemd)")
  expect(await serviceCommand(["start"], io().io, deps("linux", home()))).toBe(2)
  expect(await serviceCommand([], io().io, deps("linux", home()))).toBe(2)
})

test("status on macOS: launchd's `state = not running` adds nothing to \"not running now\"; another state is said", async () => {
  const { serviceState } = await import("./service")
  const h = home()
  const d = deps("darwin", h)
  const file = serviceFile(d)!
  await serviceCommand(["install"], io().io, d)
  const print = `launchctl print gui/501/tv.candle.harness.core`
  const at = (stdout: string) => serviceState({ ...d, run: (cmd, args) => (`${cmd} ${args.join(" ")}` === print ? { code: 0, stdout, stderr: "" } : d.run(cmd, args)) })
  expect(existsSync(file)).toBe(true)
  expect(at("gui/501/tv.candle.harness.core = {\n\tstate = not running\n}")).toMatchObject({ words: "loaded, its core not running now" })
  expect(at("gui/501/tv.candle.harness.core = {\n\tstate = spawn scheduled\n}")).toMatchObject({ words: "loaded, its core not running now (spawn scheduled)" })
  expect(at("gui/501/tv.candle.harness.core = {\n\tstate = running\n\tpid = 439\n}")).toMatchObject({ words: "loaded, its core running (pid 439)", running: 439 })
})

test("the Candle TUI 0.2's login service: status names it, install stops and removes it first, and uninstall removes it too", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const h = home()
    const d = deps(platform, h)
    const old = serviceFile(d, true)!
    expect(old).toEndWith(platform === "darwin" ? "LaunchAgents/tv.candle.tui.core.plist" : "systemd/user/candle-tui-core.service")
    mkdirSync(dirname(old), { recursive: true })
    writeFileSync(old, "0.2's service")
    expect(oldServiceFile(d)).toBe(old)

    const s = io()
    expect(await serviceCommand(["status"], s.io, d)).toBe(0)
    expect(s.text()).toContain(`${old} is the Candle TUI 0.2's login service, which runs \`candle-tui core\` on the old home`)

    const i = io()
    expect(await serviceCommand(["install"], i.io, d)).toBe(0)
    expect(i.text()).toStartWith(`Stopped and removed ${old}`)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(serviceFile(d)!)).toBe(true)
    const stop = platform === "darwin" ? "launchctl bootout gui/501/tv.candle.tui.core" : "systemctl --user disable --now candle-tui-core.service"
    const start = platform === "darwin" ? `launchctl bootstrap gui/501 ${serviceFile(d)}` : "systemctl --user enable --now candle-harness-core.service"
    expect(d.ran.indexOf(stop)).toBeGreaterThanOrEqual(0)
    expect(d.ran.indexOf(stop)).toBeLessThan(d.ran.indexOf(start))

    // Uninstall with only the old one there: removed, and said.
    rmSync(serviceFile(d)!, { force: true })
    writeFileSync(old, "0.2's service")
    const u = io()
    expect(await serviceCommand(["uninstall"], u.io, d)).toBe(0)
    expect(u.text()).toContain(`Stopped and removed ${old}`)
    expect(existsSync(old)).toBe(false)
  }
})

test("install over 0.2's service copies 0.2's home first, waiting for its core to stop, so the service's core never starts on an empty home", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const h = home()
    const base = deps(platform, h)
    // No named home: the new home is ~/.config/candle/harness, and 0.2's is ~/.config/candle/tui.
    const env = { PATH: ENV.PATH, HOME: h }
    const oldHome = join(h, ".config/candle/tui")
    mkdirSync(join(oldHome, "state/keys"), { recursive: true })
    writeFileSync(join(oldHome, "config.toml"), "[agents.agent-a]\n")
    writeFileSync(join(oldHome, "state/journal.jsonl"), "{}\n")
    writeFileSync(join(oldHome, "state/core.lock"), JSON.stringify({ pid: 999_991 }))
    const old = serviceFile(base, true)!
    mkdirSync(dirname(old), { recursive: true })
    writeFileSync(old, "0.2's service")
    // 0.2's core stops a moment after its service is booted out.
    let checks = 0
    const d: ServiceDeps = { ...base, env, isAlive: (pid) => pid === 999_991 && ++checks < 3, sleep: async () => {} }
    const t = io()
    expect(await serviceCommand(["install"], t.io, d)).toBe(0)
    expect(t.text()).toContain(`Copied Candle TUI 0.2's config, keys and journal from ${oldHome} to ${join(h, ".config/candle/harness")}`)
    expect(readFileSync(join(h, ".config/candle/harness/config.toml"), "utf8")).toBe("[agents.agent-a]\n")
    expect(existsSync(serviceFile(d)!)).toBe(true)
  }
})

test("install with a 0.2 core still running on the old home says so and installs nothing", async () => {
  const h = home()
  const base = deps("darwin", h)
  const oldHome = join(h, ".config/candle/tui")
  mkdirSync(join(oldHome, "state"), { recursive: true })
  writeFileSync(join(oldHome, "config.toml"), "")
  writeFileSync(join(oldHome, "state/core.lock"), JSON.stringify({ pid: 999_992 }))
  const d: ServiceDeps = { ...base, env: { PATH: ENV.PATH, HOME: h }, isAlive: (pid) => pid === 999_992, sleep: async () => {} }
  const s = io()
  await serviceCommand(["status"], s.io, d)
  expect(s.text()).toContain("A Candle TUI 0.2 core is running (pid 999992) on the old home.\nNo Candle Harness core is running now.\n")
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(1)
  expect(t.errors()).toContain("A Candle TUI 0.2 core is still running (pid 999992)")
  expect(t.errors()).toContain("The login service isn't installed")
  expect(existsSync(serviceFile(d)!)).toBe(false)
  expect(existsSync(join(h, ".config/candle/harness"))).toBe(false)
})

test("a service file that was there with wider access ends 0600, rewritten or kept; no part file is left", async () => {
  const h = home()
  const d = deps("darwin", h)
  const file = serviceFile(d)!
  mkdirSync(dirname(file), { recursive: true })
  // An older file, readable by anyone: its text differs, so it's rewritten.
  writeFileSync(file, "<plist/>\n", { mode: 0o644 })
  chmodSync(file, 0o644)
  expect(await serviceCommand(["install"], io().io, d)).toBe(0)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readFileSync(file, "utf8")).toContain("<?xml")
  // The same text, opened up since: kept, and closed again.
  chmodSync(file, 0o644)
  const kept = io()
  expect(await serviceCommand(["install"], kept.io, d)).toBe(0)
  expect(kept.text()).toStartWith(`Kept ${file}`)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(existsSync(`${file}.part`)).toBe(false)
})

test("the service's PATH carries no entry that isn't a full path, and install says which it left out", async () => {
  expect(onePath(".:/usr/bin:bin:/usr/bin::/bin:../x")).toBe("/usr/bin:/bin")
  const h = home()
  const d = { ...deps("darwin", h), env: { ...ENV, PATH: ".:/usr/local/bin:node_modules/.bin:/usr/bin" } }
  const t = io()
  expect(await serviceCommand(["install"], t.io, d)).toBe(0)
  expect(t.text()).toContain("Left out of its PATH: ., node_modules/.bin. An entry that isn't a full path would be looked up in whatever folder a program starts in.")
  expect(readFileSync(serviceFile(d)!, "utf8")).toContain("<string>/usr/local/bin:/usr/bin</string>")
  const clean = io()
  await serviceCommand(["install"], clean.io, deps("darwin", home()))
  expect(clean.text()).not.toContain("Left out of its PATH")
})

test("a restart's new core is the service's when it's loaded: kickstart on macOS, start on Linux; otherwise not loaded, and nothing run", () => {
  const h = home()
  const mac = deps("darwin", h, {}, { loaded: true, lag: 0, unloading: 0 })
  expect(startServiceCore(mac)).toBe("not loaded") // no file: not installed
  mkdirSync(dirname(serviceFile(mac)!), { recursive: true })
  writeFileSync(serviceFile(mac)!, "x")
  expect(startServiceCore(mac)).toBe("started")
  expect(mac.ran).toEqual(["launchctl print gui/501/tv.candle.harness.core", "launchctl kickstart gui/501/tv.candle.harness.core"])
  expect(mac.launchd.pid).toBe(4243)

  const unloaded = deps("darwin", h)
  expect(startServiceCore(unloaded)).toBe("not loaded")
  expect(unloaded.ran).toEqual(["launchctl print gui/501/tv.candle.harness.core"])

  const failing = deps("darwin", h, { "launchctl kickstart gui/501/tv.candle.harness.core": { code: 37, stdout: "", stderr: "Operation not permitted" } }, { loaded: true, lag: 0, unloading: 0 })
  expect(startServiceCore(failing)).toEqual({ failed: "Operation not permitted" })

  const l = home()
  const enabled = deps("linux", l, { "systemctl --user is-enabled candle-harness-core.service": { code: 0, stdout: "enabled\n", stderr: "" } })
  mkdirSync(dirname(serviceFile(enabled)!), { recursive: true })
  writeFileSync(serviceFile(enabled)!, "x")
  expect(startServiceCore(enabled)).toBe("started")
  expect(enabled.ran).toEqual(["systemctl --user is-enabled candle-harness-core.service", "systemctl --user start candle-harness-core.service"])
  const disabled = deps("linux", l, { "systemctl --user is-enabled candle-harness-core.service": { code: 1, stdout: "disabled\n", stderr: "" } })
  expect(startServiceCore(disabled)).toBe("not loaded")
  expect(disabled.ran).toEqual(["systemctl --user is-enabled candle-harness-core.service"])

  expect(startServiceCore(deps("win32", h))).toBe("not loaded")
})
