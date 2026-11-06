import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowEnv, runChild } from "./child"

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

test("allowEnv keeps the allowlist, and the proxy and CA variables", () => {
  expect(
    allowEnv({
      PATH: "/bin",
      HOME: "/home/you",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm-256color",
      USER: "you",
      HTTPS_PROXY: "http://proxy.example:3128",
      https_proxy: "http://proxy.example:3128",
      NO_PROXY: "localhost",
      SSL_CERT_FILE: "/etc/ssl/c.crt",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/c.crt",
    }),
  ).toEqual({
    PATH: "/bin",
    HOME: "/home/you",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TERM: "xterm-256color",
    USER: "you",
    HTTPS_PROXY: "http://proxy.example:3128",
    https_proxy: "http://proxy.example:3128",
    NO_PROXY: "localhost",
    SSL_CERT_FILE: "/etc/ssl/c.crt",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/c.crt",
  })
})

test("allowEnv never passes a signer, a device token, a Candle Harness variable or any other secret through", () => {
  const env = allowEnv({
    PATH: "/bin",
    CANDLE_KEY_SIGNER_PEM_FILE: "/k.pem",
    CANDLE_DEVICE_TOKEN: "dt",
    CANDLE_API_KEY: "cndl_live_x",
    CANDLE_AGENT_API_KEY: "cndl_live_y",
    CANDLE_KEYRING_PASSPHRASE: "p",
    CANDLE_HARNESS_HOME: "/h",
    CANDLE_HARNESS_VIEW_TOKEN: "chv_x",
    ANTHROPIC_API_KEY: "sk",
    GH_TOKEN: "gho",
    CLAUDECODE: "1",
    undefinedOne: undefined,
  })
  expect(env).toEqual({ PATH: "/bin" })
})

test("allowEnv adds the extras on top", () => {
  expect(allowEnv({ PATH: "/bin", CANDLE_API_KEY: "parent" }, { CANDLE_API_KEY: "agent", CANDLE_NO_UPDATE_NOTIFIER: "1" })).toEqual({
    PATH: "/bin",
    CANDLE_API_KEY: "agent",
    CANDLE_NO_UPDATE_NOTIFIER: "1",
  })
})

test("runChild runs with no shell and returns exit code and output", async () => {
  const result = await runChild({
    cmd: "/bin/echo",
    args: ["$HOME", "a;b", "`id`"],
    env: allowEnv(process.env),
    cwd: tmpdir(),
    timeoutMs: 5000,
  })
  expect(result).toEqual({ exitCode: 0, stdout: "$HOME a;b `id`\n", stderr: "", timedOut: false })
})

test("runChild passes only the environment it's given", async () => {
  const result = await runChild({ cmd: "/usr/bin/env", args: [], env: { ONLY: "this" }, cwd: tmpdir(), timeoutMs: 5000 })
  expect(result.stdout).toBe("ONLY=this\n")
})

test("runChild feeds stdin and reports a failing exit and stderr", async () => {
  const result = await runChild({
    cmd: "/bin/sh",
    args: ["-c", 'read line; echo "got $line" >&2; exit 3'],
    env: {},
    cwd: tmpdir(),
    timeoutMs: 5000,
    stdin: "hello\n",
  })
  expect(result).toEqual({ exitCode: 3, stdout: "", stderr: "got hello\n", timedOut: false })
})

test("a timeout kills the whole process group, the child's own children included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-child-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, "grandchild-survived")
  const started = Date.now()
  // The child starts a grandchild that would write the marker after a second, then hangs.
  const result = await runChild({
    cmd: "/bin/sh",
    args: ["-c", `(sleep 1; touch ${marker}) & sleep 30`],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cwd: dir,
    timeoutMs: 200,
  })
  expect(result.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(3000)
  await Bun.sleep(1500)
  expect(existsSync(marker)).toBe(false)
})

test("a child that exits leaves nothing behind, and isn't held open by what it started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-child-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, "leftover-survived")
  const started = Date.now()
  const result = await runChild({
    cmd: "/bin/sh",
    args: ["-c", `(sleep 1; touch ${marker}) & echo done`],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cwd: dir,
    timeoutMs: 5000,
  })
  expect(result).toEqual({ exitCode: 0, stdout: "done\n", stderr: "", timedOut: false })
  expect(Date.now() - started).toBeLessThan(900)
  await Bun.sleep(1500)
  expect(existsSync(marker)).toBe(false)
})

test("a child that can't start is reported, not thrown", async () => {
  const result = await runChild({ cmd: "/no/such/binary", args: [], env: {}, cwd: tmpdir(), timeoutMs: 1000 })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("/no/such/binary")
})
