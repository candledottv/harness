// The commit a build is made from, baked into the binary so `candle-harness version` and the doctor can
// name it, and a test run can confirm its binary without a checksum.
import { spawnSync } from "node:child_process"

/** The short commit at `cwd`, with `+dirty` when any file differs from it (new files included); `unknown` outside git. */
export function buildCommit(cwd = "."): string {
  const git = (...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" })
  const head = git("rev-parse", "--short", "HEAD")
  if (head.status !== 0) return "unknown"
  const status = git("status", "--porcelain")
  return `${head.stdout.trim()}${status.status !== 0 || status.stdout.trim() !== "" ? "+dirty" : ""}`
}

/** The `bun build` flag that sets src/version.ts's COMMIT. */
export function commitDefine(commit: string): string[] {
  return ["--define", `CANDLE_HARNESS_BUILD_COMMIT=${JSON.stringify(commit)}`]
}

/** The `bun build` flag that sets src/version.ts's VERSION, for a release built from its tag. */
export function versionDefine(version: string): string[] {
  return ["--define", `CANDLE_HARNESS_BUILD_VERSION=${JSON.stringify(version)}`]
}

/**
 * The `bun build` flags for a production binary. NODE_ENV: `--compile` alone leaves it "development" at run
 * time, and React's development build records User Timing entries for every component it renders, which
 * Bun keeps: the view grew about 1 GB an hour. DEV: @opentui/react connects React DevTools to
 * ws://localhost:8097 when DEV=true is in the environment, a name people set for their own projects, and
 * whoever holds that port could read everything the view shows. Defined false, the minifier drops the
 * branch and the DevTools backend with it. Both builds pass --minify, which this relies on: unminified,
 * the reconciler's `process.env["DEV"]` isn't matched.
 */
export const PRODUCTION_DEFINE = [
  "--define",
  `process.env.NODE_ENV=${JSON.stringify("production")}`,
  "--define",
  `process.env.DEV=${JSON.stringify("false")}`,
]

/** Marks a compiled build (src/version.ts SHIPPED): what only the tests use is off in it. */
export const SHIPPED_DEFINE = ["--define", "CANDLE_HARNESS_SHIPPED=true"]

/**
 * The `bun build --compile` flags that stop a binary reading `bunfig.toml` and `.env` from the folder it is
 * started in. Bun's default is to load both, and a bunfig's `preload` is code: the binary starts in folders
 * an agent can write (its research folder, under the engine that runs it), so a file written there would run
 * as the person, before any hold. A binary reads its settings from its own config folder and nothing else.
 */
export const NO_AUTOLOAD = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv"]
