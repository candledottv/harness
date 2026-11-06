// The repo's files, relative to its root: what git tracks, or, in a copy with no .git (an archive, say), every
// file but what .gitignore leaves out, so the checks that read the whole tree run the same either way.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..")
/** .gitignore's entries, as folders and names a walk skips. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "test/fixtures/raw"])
const SKIPPED_NAMES = /^(\.DS_Store|\.env.*|.*\.log)$/

export function repoFiles(under = ""): string[] {
  if (existsSync(join(ROOT, ".git"))) {
    const listed = spawnSync("git", ["ls-files", "-z", ...(under ? [under] : [])], { cwd: ROOT, encoding: "utf8" })
    if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`)
    return listed.stdout.split("\0").filter((f) => f !== "")
  }
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = relative(ROOT, path)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(rel) && !SKIPPED_DIRS.has(entry.name)) walk(path)
      } else if (!SKIPPED_NAMES.test(entry.name)) out.push(rel)
    }
  }
  walk(join(ROOT, under))
  return out.sort()
}
