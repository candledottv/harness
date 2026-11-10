// Bun's own variables never pass to anything the Candle Harness starts. BUN_OPTIONS adds command-line flags to every
// Bun program that reads it, the built binary included, and a `--preload` among them is code that runs before the
// program does; the rest of BUN_* (BUN_CONFIG_*, BUN_JSC_*, BUN_INSTALL…) change how Bun installs, resolves and runs.
// An engine, the MCP shim under it, a held script, a bot, a bot's test run, the Build pane and the login service each
// start from an environment with none of them.

/** A variable that is Bun's own: BUN_OPTIONS and every other BUN_ name. */
export const BUN_VAR = /^BUN_/

/** `env` with Bun's own variables left out; the same object when it has none. */
export function withoutBunVars<T extends Record<string, string | undefined>>(env: T): T {
  if (!Object.keys(env).some((k) => BUN_VAR.test(k))) return env
  return Object.fromEntries(Object.entries(env).filter(([k]) => !BUN_VAR.test(k))) as T
}
