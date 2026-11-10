// The core reads processes with `ps` and asks `git` about a bot's folder. Started from a folder that holds a
// program named `ps` or `git`, with `.` on its PATH, the core still runs the system's own, never the planted one.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test("ps and git run from the absolute PATH entries, whatever folder the core starts in", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chrn-tools-")))
  dirs.push(dir)
  const start = join(dir, "start")
  const driverDir = join(dir, "driver")
  mkdirSync(start)
  mkdirSync(driverDir)
  const ran = join(dir, "planted-ran")
  for (const name of ["ps", "git"]) {
    writeFileSync(join(start, name), `#!/bin/sh\necho ${name} >> '${ran}'\n`)
    chmodSync(join(start, name), 0o755)
  }
  const src = join(import.meta.dir, "..")
  const driver = join(driverDir, "driver.ts")
  writeFileSync(
    driver,
    [
      `import { gitIgnores, groupCarriesBot, psIdentify, psSample } from ${JSON.stringify(join(src, "core/supervisor.ts"))}`,
      `import { listProcesses, processesMarked } from ${JSON.stringify(join(src, "engine/runner.ts"))}`,
      `const procs = listProcesses()`,
      `processesMarked("CANDLE_TEST_MARK=none")`,
      `const id = await psIdentify(process.pid)`,
      `const sample = await psSample()`,
      `await groupCarriesBot(process.pid, "none", "/nowhere")`,
      `await gitIgnores(${JSON.stringify(start)}, "x")`,
      `console.log(JSON.stringify({ procs: procs.length, id: id !== undefined, sample: sample.size }))`,
    ].join("\n"),
  )
  const run = Bun.spawnSync([process.execPath, "--no-env-file", driver], { cwd: start, env: { ...process.env, PATH: `.:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" })
  expect(run.stderr.toString()).toBe("")
  const out = JSON.parse(run.stdout.toString().trim()) as { procs: number; id: boolean; sample: number }
  expect(existsSync(ran) ? readFileSync(ran, "utf8") : "").toBe("")
  // The real ps answered.
  expect(out.procs).toBeGreaterThan(0)
  expect(out.id).toBe(true)
  expect(out.sample).toBeGreaterThan(0)
})
