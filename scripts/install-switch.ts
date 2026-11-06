// The installer's test copy. The shipped install.sh never installs a release with no signature: its
// UNSIGNED_OK is 0. The tests, the first-run script and the team's unsigned preview bundles run this copy,
// in which CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING=1 lets an unsigned file install, its checksum still checked.
//
//   bun scripts/install-switch.ts <install.sh> <out>   writes the test copy to <out>
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const SHIPPED_SWITCH = "UNSIGNED_OK=0"
const TEST_SWITCH = 'UNSIGNED_OK="${CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING:-0}"'

/** install.sh with its switch reading the test variable. Refuses a script without exactly one shipped switch. */
export function testCopy(script: string): string {
  const lines = script.split("\n")
  const at = lines.flatMap((line, i) => (line === SHIPPED_SWITCH ? [i] : []))
  if (at.length !== 1) throw new Error(`install.sh should hold "${SHIPPED_SWITCH}" on one line of its own, once; it holds it ${at.length} times`)
  lines[at[0]!] = TEST_SWITCH
  return lines.join("\n")
}

/**
 * A release folder for a test run: every file of `release` linked into `dir`, and install.sh as its test
 * copy, so the release folder itself is never changed. Anyone may read it (a mkdtemp folder is 0700), since
 * the install route runs install.sh as a separate test user.
 */
export function testRelease(release: string, dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o755)
  for (const name of readdirSync(release)) if (name !== "install.sh") symlinkSync(join(release, name), join(dir, name))
  writeFileSync(join(dir, "install.sh"), testCopy(readFileSync(join(release, "install.sh"), "utf8")))
  chmodSync(join(dir, "install.sh"), 0o755)
  return dir
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2)
  if (!from || !to) {
    console.error("usage: bun scripts/install-switch.ts <install.sh> <out>")
    process.exit(2)
  }
  writeFileSync(to, testCopy(readFileSync(from, "utf8")))
  chmodSync(to, 0o755)
}
