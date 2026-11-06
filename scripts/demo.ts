// A demo run for trying the Candle Harness in a terminal: a throwaway home with two agents (momentum
// and swing, sharing one embedded wallet), the fake Candle MCP server and the stand-in `candle` CLI,
// then the Candle Harness in this terminal. Nothing reaches Candle. The agent is your own Claude Code, if it's
// signed in. When the Candle Harness quits, or the window closes (a hangup), the core is stopped and the home
// removed.
//
//   bun scripts/demo.ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, testHome } from "../test/core-fixture"

const { home, p } = await testHome()
const harness = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts")], { env: { ...process.env, CANDLE_HARNESS_HOME: home }, stdio: ["inherit", "inherit", "inherit"] })

let finished = false
async function finish(code: number): Promise<never> {
  if (!finished) {
    finished = true
    harness.kill("SIGTERM")
    try {
      const { pid } = JSON.parse(readFileSync(p.lock, "utf8")) as { pid: number }
      process.kill(pid, "SIGTERM")
      await Bun.sleep(1_000)
    } catch {
      // No core left running.
    }
    cleanupHomes()
  }
  process.exit(code)
}
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.on(signal, () => void finish(1))
await finish(await harness.exited)
