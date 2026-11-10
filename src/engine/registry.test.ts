// selfCommand from source: what it reads from the folder it starts in.
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selfCommand } from "./registry"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test("a run from source reads no bunfig.toml or .env from the folder it starts in: the MCP shim starts in a research folder", async () => {
  const folder = mkdtempSync(join(tmpdir(), "chrn-self-"))
  dirs.push(folder)
  const marker = join(folder, "preload-ran")
  writeFileSync(join(folder, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`)
  writeFileSync(join(folder, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
  writeFileSync(join(folder, ".env"), "CANDLE_HARNESS_HOME=/tmp/chrn-planted-home\n")
  const self = selfCommand()
  const run = Bun.spawn([...self, "--version"], { cwd: folder, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: folder }, stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
  expect(code).toBe(0)
  expect(out.trim().length).toBeGreaterThan(0)
  expect(existsSync(marker)).toBe(false)
  if (self.length > 1) expect(self).toContain("--no-env-file")
}, 30_000)
