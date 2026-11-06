// The public prefix of a Candle API key, by the CLI's rule (agentic `packages/cli/src/profiles.ts`
// `apiKeyPrefix`, after the server's `parseAgentKey`): `cndl_live_` or `cndl_test_`, a 43-character
// random part, and the prefix is that part's first 8 characters. It's what `candle keys list` prints
// and what `candle_get_profile_wallets` takes as `keyPrefix` (docs.candle.tv/developers/agent-access).
const KEY_KINDS = ["cndl_live_", "cndl_test_"]
const RANDOM_LENGTH = 43

/** `undefined` for anything that isn't a whole key, so no slice of an unrecognised secret is ever shown. */
export function apiKeyPrefix(key: string): string | undefined {
  const trimmed = key.trim()
  for (const kind of KEY_KINDS) {
    if (!trimmed.startsWith(kind)) continue
    const random = trimmed.slice(kind.length)
    if (random.length !== RANDOM_LENGTH || !/^[A-Za-z0-9_-]+$/.test(random)) return undefined
    return random.slice(0, 8)
  }
  return undefined
}
