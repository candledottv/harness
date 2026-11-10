import { expect, test } from "bun:test"
import { $ } from "bun"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pkg from "../package.json"
import { commitDefine, versionDefine } from "../scripts/commit"
import { cliArgs, loginName, loginShell, main, restoreLoginEnv, viewOpening } from "./main"
import { paths } from "./paths"
import { COMMIT, VERSION } from "./version"

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err }
}

test("the version comes from package.json", () => {
  expect(VERSION).toBe(pkg.version)
})

test("version and --version print it, with `dev` for the commit when run from source", async () => {
  expect(COMMIT).toBe("dev")
  for (const argv of [["version"], ["--version"]]) {
    const { io, out } = capture()
    expect(await main(argv, io)).toBe(0)
    expect(out.join("")).toBe(`candle-harness ${VERSION} (dev)\n`)
  }
})

test("a binary prints the commit it was built from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-version-"))
  try {
    const bin = join(dir, "candle-harness")
    await $`bun build --compile ${commitDefine("abc1234+dirty")} ${join(import.meta.dir, "main.ts")} --outfile ${bin}`.quiet()
    expect((await $`${bin} version`.text()).trim()).toBe(`candle-harness ${VERSION} (abc1234+dirty)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

test("a release binary prints the version from its tag, not package.json's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-version-"))
  try {
    const bin = join(dir, "candle-harness")
    await $`bun build --compile ${commitDefine("abc1234")} ${versionDefine("1.2.3")} ${join(import.meta.dir, "main.ts")} --outfile ${bin}`.quiet()
    expect((await $`${bin} --version`.text()).trim()).toBe("candle-harness 1.2.3 (abc1234)")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

test("help lists every subcommand", async () => {
  const { io, out } = capture()
  expect(await main(["help"], io)).toBe(0)
  for (const sub of ["core", "mcp", "key add", "doctor", "version", "setup"]) expect(out.join("")).toContain(sub)
})

test("an unknown subcommand is a usage error", async () => {
  const { io, err } = capture()
  expect(await main(["trade"], io)).toBe(2)
  expect(err.join("")).toContain(`unknown command "trade"`)
})

test("key needs its add subcommand", async () => {
  const { io, err } = capture()
  expect(await main(["key"], io)).toBe(2)
  expect(err.join("")).toContain("candle-harness key add")
})

test("no config, or one with no agents, opens onboarding; setup asks for it on a set-up machine", () => {
  const home = mkdtempSync(join(tmpdir(), "chrn-main-"))
  try {
    const p = paths({ CANDLE_HARNESS_HOME: home })
    expect(viewOpening(p)).toEqual({ onboarding: { straightIn: false, asked: false }, warnings: [] })
    writeFileSync(p.configFile, `mode = "paper"\n`)
    expect(viewOpening(p).onboarding).toEqual({ straightIn: false, asked: false })
    writeFileSync(p.configFile, `[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`)
    expect(viewOpening(p).onboarding).toBeUndefined()
    expect(viewOpening(p, { straightIn: true, asked: true }).onboarding).toEqual({ straightIn: true, asked: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a config with a problem is still refused, says what to do, and starts no core; setup takes only --straight-in", async () => {
  const home = mkdtempSync(join(tmpdir(), "chrn-main-"))
  const saved = process.env.CANDLE_HARNESS_HOME
  process.env.CANDLE_HARNESS_HOME = home
  try {
    writeFileSync(join(home, "config.toml"), `[agents.momentum\n`)
    for (const argv of [[], ["view"], ["setup"]]) {
      const { io, err } = capture()
      expect(await main(argv, io)).toBe(1)
      expect(err.join("")).toContain("isn't valid TOML")
      expect(err.join("")).toContain("Run `candle-harness doctor` for the full check")
    }
    const { io } = capture()
    expect(await main(["view", "extra"], io)).toBe(2)
    const setup = capture()
    expect(await main(["setup", "--nope"], setup.io)).toBe(2)
    expect(setup.err.join("")).toContain("Usage: candle-harness setup [--straight-in]")
    expect(existsSync(join(home, "state", "core.sock"))).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.CANDLE_HARNESS_HOME
    else process.env.CANDLE_HARNESS_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test("key add and doctor are wired to their commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "chrn-main-"))
  const saved = process.env.CANDLE_HARNESS_HOME
  process.env.CANDLE_HARNESS_HOME = home
  try {
    const add = capture()
    expect(await main(["key", "add"], add.io)).toBe(2)
    expect(add.err.join("")).toContain("Usage: candle-harness key add --agent <name>")
    const doctor = capture()
    expect(await main(["doctor", "--nope"], doctor.io)).toBe(2)
    expect(doctor.err.join("")).toContain("Usage: candle-harness doctor")
  } finally {
    if (saved === undefined) delete process.env.CANDLE_HARNESS_HOME
    else process.env.CANDLE_HARNESS_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test("candle tui's arguments open the view: --candle is taken, --profile is taken without a word", async () => {
  expect(cliArgs([])).toEqual({ fromCli: false })
  expect(cliArgs(["--candle", "/usr/local/bin/candle"])).toEqual({ fromCli: true })
  expect(cliArgs(["--profile", "main", "--candle", "/usr/local/bin/candle"])).toEqual({ fromCli: true, profile: "main" })
  expect(cliArgs(["--candle"])).toBeUndefined()
  expect(cliArgs(["--candle", "--profile"])).toBeUndefined()
  expect(cliArgs(["extra"])).toBeUndefined()

  const home = mkdtempSync(join(tmpdir(), "chrn-main-"))
  const saved = process.env.CANDLE_HARNESS_HOME
  process.env.CANDLE_HARNESS_HOME = home
  try {
    // With a broken config the view stops before drawing anything, so what it says is all there is.
    writeFileSync(join(home, "config.toml"), `[agents.momentum\n`)
    const { io, err } = capture()
    expect(await main(["--profile", "main", "--candle", "/usr/local/bin/candle"], io)).toBe(1)
    // The CLI passes its active profile on every start, so saying it's ignored would be noise.
    expect(err.join("")).not.toContain("--profile")
    expect(err.join("")).toContain("isn't valid TOML")
    expect(err.join("")).not.toContain("unknown command")
    expect(await main(["--candle"], capture().io)).toBe(2)
  } finally {
    if (saved === undefined) delete process.env.CANDLE_HARNESS_HOME
    else process.env.CANDLE_HARNESS_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test("the login variables candle tui leaves out are put back, and set ones are kept", () => {
  const env: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/home/you" }
  restoreLoginEnv(env, () => "you")
  expect(env.USER).toBe("you")
  expect(env.LOGNAME).toBe("you")
  const kept: Record<string, string | undefined> = { USER: "someone", LOGNAME: "someone", SHELL: "/bin/zsh" }
  restoreLoginEnv(kept, () => "you")
  expect(kept).toEqual({ USER: "someone", LOGNAME: "someone", SHELL: "/bin/zsh" })
})

test("candle tui's \"unknown\" login variables are replaced: Claude Code finds its sign-in by USER", () => {
  const env: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/home/you", USER: "unknown", LOGNAME: "unknown", SHELL: "unknown" }
  restoreLoginEnv(env, () => "you", () => "/bin/zsh")
  expect(env).toMatchObject({ USER: "you", LOGNAME: "you", SHELL: "/bin/zsh" })
  // No shell found: left as it was.
  const noShell: Record<string, string | undefined> = { SHELL: "unknown" }
  restoreLoginEnv(noShell, () => "you", () => undefined)
  expect(noShell.SHELL).toBe("unknown")
  const empty: Record<string, string | undefined> = { USER: "" }
  restoreLoginEnv(empty, () => "you")
  expect(empty.USER).toBe("you")
  // No name found: left as it was, never set to something made up.
  const none: Record<string, string | undefined> = { USER: "unknown" }
  restoreLoginEnv(none, () => undefined)
  expect(none.USER).toBe("unknown")
})

test("the login name comes from the user database, not from USER (Bun's userInfo reads USER)", () => {
  const saved = process.env.USER
  process.env.USER = "unknown"
  try {
    const name = loginName()
    expect(name).toBeTruthy()
    expect(name).not.toBe("unknown")
  } finally {
    if (saved === undefined) delete process.env.USER
    else process.env.USER = saved
  }
})

test("the login shell comes from the user database by uid, not from SHELL (Bun's userInfo reads SHELL, which can be missing)", () => {
  const saved = process.env.SHELL
  process.env.SHELL = "unknown"
  try {
    const shell = loginShell()
    expect(shell).toMatch(/^\//)
    if (process.platform === "linux") {
      const entry = spawnSync("getent", ["passwd", String(process.getuid!())], { encoding: "utf8" }).stdout.trim()
      expect(shell).toBe(entry.split(":")[6])
    }
  } finally {
    if (saved === undefined) delete process.env.SHELL
    else process.env.SHELL = saved
  }
})

test("an old CANDLE_TUI_ variable is read under its new name, and said once at the start", async () => {
  const saved = { old: process.env.CANDLE_TUI_PASTE_LOG, now: process.env.CANDLE_HARNESS_PASTE_LOG }
  delete process.env.CANDLE_HARNESS_PASTE_LOG
  process.env.CANDLE_TUI_PASTE_LOG = "/nowhere/paste.log"
  try {
    const first = capture()
    expect(await main(["version"], first.io)).toBe(0)
    expect(first.err.join("")).toContain("CANDLE_TUI_PASTE_LOG is Candle TUI 0.2's name, read for now as CANDLE_HARNESS_PASTE_LOG")
    expect(process.env.CANDLE_HARNESS_PASTE_LOG as string | undefined).toBe("/nowhere/paste.log")
    // A process started from this one (the core, a pane) inherits both: nothing said again.
    const again = capture()
    expect(await main(["version"], again.io)).toBe(0)
    expect(again.err.join("")).toBe("")
  } finally {
    if (saved.old === undefined) delete process.env.CANDLE_TUI_PASTE_LOG
    else process.env.CANDLE_TUI_PASTE_LOG = saved.old
    if (saved.now === undefined) delete process.env.CANDLE_HARNESS_PASTE_LOG
    else process.env.CANDLE_HARNESS_PASTE_LOG = saved.now
  }
})

test("the usage text names --version beside version, since both print it", async () => {
  const { io, out } = capture()
  expect(await main(["help"], io)).toBe(0)
  expect(out.join("")).toMatch(/^  version +print the version and the commit it was built from \(also --version\)/m)
  // An unknown command still ends with the usage, and there's no status command.
  const unknown = capture()
  expect(await main(["status"], unknown.io)).toBe(2)
  expect(unknown.err.join("")).toContain('unknown command "status"')
})
