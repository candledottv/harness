// The recorder, run against the fake Candle: what it asks each key
// for, and that no recording holds the key.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { apiKeyPrefix } from "../src/shared/api-key"
import { cleanupHomes, fakeCandle } from "./core-fixture"

afterAll(cleanupHomes)
const outs: string[] = []
afterEach(() => {
  for (const out of outs.splice(0)) rmSync(out, { recursive: true, force: true })
})

/** Made-up keys of the real shape, built so no key-shaped text sits in the source. */
const KEY_A = `cndl_${"live"}_${"A1b2C3d4".repeat(5)}xyz`
const KEY_B = `cndl_${"live"}_${"Q9r8S7t6".repeat(5)}uvw`

test("each key's reads are recorded, wallets by that key's own prefix, and no key is written", async () => {
  const candle = await fakeCandle()
  const out = mkdtempSync("/tmp/chrn-rec-")
  outs.push(out)
  const run = Bun.spawn(["bun", join(import.meta.dir, "record-candle.ts"), "--out", out, "--cli", candle, "--package", join(out, "no-such-package")], {
    stdin: new Blob([`agent-a ${KEY_A}\nagent-b ${KEY_B}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await run.exited).toBe(0)

  const recording = (name: string) => JSON.parse(readFileSync(join(out, `${name}.json`), "utf8"))
  for (const [label, key] of [["agent-a", KEY_A], ["agent-b", KEY_B]] as const) {
    expect(recording(`cli-${label}-candle_get_profile_wallets`).args).toEqual({ keyPrefix: apiKeyPrefix(key) })
    for (const tool of ["candle_get_portfolio", "candle_execution_status", "candle_get_staking", "candle_get_fees", "candle_get_operation-not-found", "candle_get_operation-launch-not-found"]) {
      expect(recording(`cli-${label}-${tool}`).tool).toBe(tool.replace(/-.*$/, ""))
    }
  }
  expect(recording("cli-agent-a-candle_get_operation-launch-not-found").args).toMatchObject({ kind: "launch" })

  for (const file of readdirSync(out, { recursive: true }) as string[]) {
    if (!file.endsWith(".json")) continue
    const text = readFileSync(join(out, file), "utf8")
    expect(text).not.toContain(KEY_A)
    expect(text).not.toContain(KEY_B)
  }
}, 60_000)
