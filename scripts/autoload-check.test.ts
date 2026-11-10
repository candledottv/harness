import { afterAll, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUTOLOAD_PROBE, autoloadProbe } from "./autoload-check"
import { NO_AUTOLOAD } from "./commit"

const ROOT = join(import.meta.dir, "..")
const dir = mkdtempSync(join(tmpdir(), "autoload-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("a binary built with the no-autoload flags runs no preload and reads no .env from its working folder; one built without them does both", async () => {
  const source = join(dir, "toy.ts")
  writeFileSync(source, `console.log(process.env.${AUTOLOAD_PROBE} ?? "unset")\n`)
  const plain = join(dir, "plain")
  const held = join(dir, "held")
  await $`bun build --compile ${source} --outfile ${plain}`.quiet()
  await $`bun build --compile ${NO_AUTOLOAD} ${source} --outfile ${held}`.quiet()
  // The check itself must be able to see a loading binary, or it proves nothing about one that doesn't.
  expect(autoloadProbe(plain, [[]])).toEqual({ preloadRan: true, dotenvSeen: true })
  expect(autoloadProbe(held, [[]])).toEqual({ preloadRan: false, dotenvSeen: false })
}, 120_000)

test("every binary this repo builds is built with the no-autoload flags, and the release build checks the one it can run", () => {
  const build = readFileSync(join(ROOT, "scripts", "build.ts"), "utf8")
  expect(build).toContain("bun build --compile ${NO_AUTOLOAD} --minify")
  expect(build).toContain("await assertNoAutoload(out)")
  const others = [join(ROOT, "scripts", "mac-checks", "build.ts"), join(ROOT, "scripts", "install.live.test.ts")]
  for (const file of others) {
    const text = readFileSync(file, "utf8")
    const compiles = text.match(/bun build --compile[^\n]*/g) ?? []
    expect(compiles.length).toBeGreaterThan(0)
    for (const line of compiles) expect(line).toContain("${NO_AUTOLOAD}")
  }
})
