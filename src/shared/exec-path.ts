// Which file a program's name runs. A PATH entry that isn't absolute (`.`, `bin`) is looked up against the
// folder the child starts in, and an engine starts in its agent's research folder, which the agent can write:
// a file planted there under the engine's name would run in its place, outside every hold. So nothing the app
// starts is found through a relative entry: they're dropped from the PATH a child gets, and a bare name is
// resolved here, once, over the absolute entries only.
import { isAbsolute, resolve } from "node:path"

/** PATH's entries that aren't absolute, in order; empty ones aren't counted (nothing looks them up). */
export function relativeEntries(path: string | undefined): string[] {
  return (path ?? "").split(":").filter((dir) => dir.length > 0 && !isAbsolute(dir))
}

/** PATH with only its absolute entries. */
export function absolutePath(path: string | undefined): string {
  return (path ?? "")
    .split(":")
    .filter((dir) => isAbsolute(dir))
    .join(":")
}

/** `env` with its PATH held to absolute entries; the same object when there's nothing to drop. */
export function withAbsolutePath<T extends Record<string, string | undefined>>(env: T): T {
  if (env.PATH === undefined || relativeEntries(env.PATH).length === 0) return env
  return { ...env, PATH: absolutePath(env.PATH) }
}

/**
 * The file `cmd` names: a bare name found over PATH's absolute entries, a path with a slash made absolute
 * against this process's own folder (never the child's). A name that isn't found comes back as it was, for
 * the spawn to report as missing.
 */
export function resolveBin(cmd: string, path: string | undefined): string {
  if (cmd.includes("/")) return isAbsolute(cmd) ? cmd : resolve(cmd)
  return Bun.which(cmd, { PATH: absolutePath(path) }) ?? cmd
}

/**
 * A system tool the core starts by name (`ps`, `git`): found over the absolute entries of this process's own PATH,
 * so a relative entry can't pick a file in whatever folder the core was started from.
 */
export function systemTool(name: string): string {
  return resolveBin(name, process.env.PATH)
}
