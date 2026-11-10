// Checks that a built binary reads nothing from the folder it is started in. A compiled Bun binary loads
// `bunfig.toml` and `.env` from its working folder unless it is built not to, and a bunfig `preload` is code
// that runs before the program does.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** This machine as a release platform name, such as `linux-arm64`. */
export function hostPlatform(): string {
  return `${process.platform}-${process.arch}`
}

/** What a binary did when started in a folder holding a preload and a `.env`. */
export interface AutoloadResult {
  /** The bunfig's preload ran. */
  preloadRan: boolean
  /** The binary printed the `.env` file's value: only a program that prints its environment can show this. */
  dotenvSeen: boolean
}

const PROBE = "CANDLE_HARNESS_AUTOLOAD_PROBE"

/** Starts `binary` with each argument list in a folder holding a bunfig preload and a `.env`, and says what was loaded. */
export function autoloadProbe(binary: string, runs: readonly (readonly string[])[] = [["version"], ["run-held"]]): AutoloadResult {
  const dir = mkdtempSync(join(tmpdir(), "autoload-check-"))
  try {
    const marker = join(dir, "ran")
    writeFileSync(join(dir, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`)
    writeFileSync(join(dir, "bunfig.toml"), `preload = ["./preload.ts"]\n`)
    writeFileSync(join(dir, ".env"), `${PROBE}=from-dotenv\n`)
    const env = { ...process.env }
    delete env[PROBE]
    let dotenvSeen = false
    for (const args of runs) {
      const ran = spawnSync(resolve(binary), [...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
      if (ran.error) throw new Error(`${binary} didn't start: ${ran.error.message}`)
      if (`${ran.stdout}${ran.stderr}`.includes("from-dotenv")) dotenvSeen = true
    }
    return { preloadRan: existsSync(marker), dotenvSeen }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Throws when `binary` loads a bunfig or a `.env` from the folder it is started in. */
export async function assertNoAutoload(binary: string): Promise<void> {
  const result = autoloadProbe(binary)
  if (result.preloadRan) throw new Error(`${binary} ran a preload from a bunfig.toml in its working folder: build it with the no-autoload flags`)
  if (result.dotenvSeen) throw new Error(`${binary} read a .env from its working folder: build it with the no-autoload flags`)
}

export { PROBE as AUTOLOAD_PROBE }
