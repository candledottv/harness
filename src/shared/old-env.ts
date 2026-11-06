// Candle TUI 0.2 read its variables as CANDLE_TUI_*; Candle Harness reads CANDLE_HARNESS_*. Through 0.3.x an
// old name still works: copied to the new one when that isn't set (the new name wins), and named once, at the
// start, as deprecated. The copy is in this process's environment, so every read here and every child sees
// it; a child finds both set and says nothing.

export const OLD_ENV_PREFIX = "CANDLE_TUI_"
export const NEW_ENV_PREFIX = "CANDLE_HARNESS_"

/** Copies each set CANDLE_TUI_* to its CANDLE_HARNESS_* where that's unset; the old names it used, sorted. */
export function adoptOldEnv(env: Record<string, string | undefined>): string[] {
  const used: string[] = []
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(OLD_ENV_PREFIX) || name.length === OLD_ENV_PREFIX.length) continue
    const value = env[name]
    const now = `${NEW_ENV_PREFIX}${name.slice(OLD_ENV_PREFIX.length)}`
    if (value === undefined || env[now] !== undefined) continue
    env[now] = value
    used.push(name)
  }
  return used
}

/** The one line that names the old variables in use. */
export function oldEnvNotice(used: readonly string[]): string {
  return `${used.join(", ")} ${used.length === 1 ? "is" : "are"} Candle TUI 0.2's name${used.length === 1 ? "" : "s"}, read for now as ${used.map((n) => `${NEW_ENV_PREFIX}${n.slice(OLD_ENV_PREFIX.length)}`).join(", ")}. The old names are deprecated: rename them.`
}
