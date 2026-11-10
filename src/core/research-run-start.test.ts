import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selfCommand } from "../engine/registry"
import { holdSupport } from "./hold"
import { researchRun } from "./research-run"

const support = await holdSupport()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-start-")))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// The agent writes freely in its research folder, a bunfig.toml included, and a bunfig's preload is code. The
// stage that holds a run is this program: started inside the folder, it would run that preload as the person,
// before any hold exists.
test.skipIf(!support.ok || process.platform !== "linux" || !Bun.which("python3"))(
  "a preload the agent planted in its research folder isn't run by the stage that holds a script, and the script still runs in the folder",
  async () => {
    const research = join(dir, "research")
    const home = join(dir, "home")
    for (const d of [research, home]) await Bun.$`mkdir -p ${d}`.quiet()
    const marker = join(dir, "preload-ran")
    writeFileSync(join(research, "planted.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`)
    writeFileSync(join(research, "bunfig.toml"), `preload = ["./planted.ts"]\n`)
    const r = await researchRun({
      root: research,
      programs: ["python3"],
      args: { program: "python3", code: "import os\nprint(os.getcwd())\n" },
      path: process.env.PATH,
      home,
      self: selfCommand(),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(String(r.body.stdout).trim()).toBe(research)
    expect(existsSync(marker)).toBe(false)
  },
  30_000,
)
