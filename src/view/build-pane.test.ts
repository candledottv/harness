// The Build pane's pure parts: which harness starts with which argv, the environment it gets, the first open's rows,
// and the daemons a harness leaves, read from `ps`.
import { expect, test } from "bun:test"
import { commandArgv } from "../core/build-prefs"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { buildEnv, buildTokenFile, forgetBuildToken, keepBuildToken } from "./build-process"
import { buildScreenLines, buildTitle, daemonsIn, elapsedSeconds, harnessArgv, harnessLabel, HARNESS_ROWS, selectionHint } from "./build-pane"
import { textOf } from "./panes/lines"

test("an engine starts by its binary as config names it; a command of yours by its words, quotes kept, no shell", () => {
  expect(harnessArgv("claude-code", { "claude-code": "/opt/claude/bin/claude" })).toEqual(["/opt/claude/bin/claude"])
  expect(harnessArgv("codex", {})).toEqual(["codex"])
  expect(harnessArgv(`aider --model "sonnet 5" --no-git`, {})).toEqual(["aider", "--model", "sonnet 5", "--no-git"])
  expect(commandArgv("echo $HOME; rm -rf /")).toEqual(["echo", "$HOME;", "rm", "-rf", "/"])
  expect(harnessLabel("opencode")).toBe("OpenCode")
  expect(harnessLabel("/usr/local/bin/aider --no-git")).toBe("aider")
  expect(HARNESS_ROWS).toEqual(["claude-code", "codex", "grok", "opencode", "pi", "command"])
})

test("the harness gets the person's environment less Candle's sign-in and ours, and the pane's token and socket", () => {
  const env = buildEnv(
    { HOME: "/home/me", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-own", CANDLE_API_KEY: "k", CANDLE_AGENT_API_KEY: "a", CANDLE_DEVICE_TOKEN: "d", CANDLE_KEYRING_PASSPHRASE: "p", CANDLE_PROFILE: "main", CANDLE_HARNESS_HOME: "/x", CANDLE_TUI_HOME: "/y", CANDLE_HARNESS_VIEW_TOKEN: "v", BUN_OPTIONS: "--preload=/tmp/p.ts", BUN_INSTALL: "/b", UNSET: undefined },
    { token: "chd_pane", socketPath: "/run/core.sock" },
  )
  expect(env).toEqual({ HOME: "/home/me", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-own", CANDLE_HARNESS_BUILD_TOKEN: "chd_pane", CANDLE_HARNESS_SOCKET: "/run/core.sock" })
})

test("the daemons a harness leaves: a known leftover, its parent gone, started since the pane opened", () => {
  expect(elapsedSeconds("05:07")).toBe(307)
  expect(elapsedSeconds("01:02:03")).toBe(3723)
  expect(elapsedSeconds("2-00:00:01")).toBe(172_801)
  const ps = [
    "  4242     1    02:10 /usr/local/bin/codex app-server --listen stdio",
    "  4243     1 3-01:00:00 /usr/local/bin/codex app-server",
    "  4244  4100    00:30 /usr/local/bin/codex app-server",
    "  4245     1    00:12 /usr/bin/vim notes",
  ].join("\n")
  expect(daemonsIn(ps, 600)).toEqual([{ pid: 4242, what: "Codex's app-server" }])
})

test("the first open: the folder, the harness rows with each engine's state, and ⏎ with where it starts", () => {
  const lines = buildScreenLines({ stage: "ask", ask: { folder: "~/candle-bots", field: "harness", index: 5, command: "" }, width: 80, focused: true }).map(textOf)
  expect(lines.some((l) => l.includes("~/candle-bots"))).toBe(true)
  expect(lines.filter((l) => l.includes("checking…"))).toHaveLength(5)
  expect(lines.find((l) => l.includes("another command…"))?.startsWith("▸ ")).toBe(true)
  expect(lines.at(-1)).toContain("⏎ start in ~/candle-bots")
  const error = buildScreenLines({ stage: "ask", ask: { folder: "bots", field: "folder", index: 0, command: "", error: "A folder starts with / or ~/, such as ~/candle-bots." }, width: 80, focused: true }).map(textOf)
  expect(error).toContain("A folder starts with / or ~/, such as ~/candle-bots.")
})

test("harness ▾ opened again is titled for the harness's choice; the first open keeps its own title", () => {
  expect(buildTitle("ask", undefined, undefined)).toBe("Build · first open")
  expect(buildTitle("written", undefined, undefined)).toBe("Build · first open")
  expect(buildTitle("ask", undefined, undefined, undefined, true)).toBe("Build · harness")
})

test("a selection in the Build pane's running harness says a right-click copies it: ctrl-c there is the harness's", () => {
  expect(selectionHint(true)).toBe("Selected: a right-click copies it.")
  expect(selectionHint(false)).toBe("Selected: ctrl-c or a right-click copies it.")
})

test("the pane's token file: named in the harness's environment, beside the core's socket, 0600 in a 0700 folder, gone with the view", () => {
  expect(buildEnv({ PATH: "/usr/bin" }, { token: "chd_pane", socketPath: "/run/core.sock", tokenFile: "/run/build/pane-7.token" })).toEqual({ PATH: "/usr/bin", CANDLE_HARNESS_BUILD_TOKEN: "chd_pane", CANDLE_HARNESS_SOCKET: "/run/core.sock", CANDLE_HARNESS_BUILD_TOKEN_FILE: "/run/build/pane-7.token" })
  // A file named in the person's own environment never reaches the harness: only the view's.
  expect(buildEnv({ CANDLE_HARNESS_BUILD_TOKEN_FILE: "/elsewhere" }, { token: "t", socketPath: "/s" })).not.toHaveProperty("CANDLE_HARNESS_BUILD_TOKEN_FILE")
  const state = mkdtempSync("/tmp/chrn-buildtok-")
  try {
    const file = buildTokenFile(join(state, "core.sock"), 4242)
    expect(file).toBe(join(state, "build", "pane-4242.token"))
    expect(keepBuildToken(file, "chd_one")).toBe(true)
    expect(keepBuildToken(file, "chd_two")).toBe(true)
    expect(readFileSync(file, "utf8")).toBe("chd_two\n")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(state, "build")).mode & 0o777).toBe(0o700)
    forgetBuildToken(file)
    expect(() => statSync(file)).toThrow()
    expect(keepBuildToken("/proc/no/such/place/pane.token", "chd_x")).toBe(false)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
