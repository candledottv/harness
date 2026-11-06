// Runs the user's `candle` CLI for what Candle's MCP tools lack (candle_cli), through
// runChild's rules: no shell, an allowlisted environment, a 120 s timeout. An agent's run carries
// that agent's key as CANDLE_API_KEY (which takes precedence over any stored key, docs.candle.tv/developers/cli)
// and the CLI's normal config; a run with no agent is the user's own profile, with no key passed.
// `--rpc-url` is only ever the one in config, and only for a command the caller says takes it.
// It stays in the arguments a card binds, but reaches the CLI as CANDLE_SOLANA_RPC_URL, never on its
// command line: another local user can read a process's arguments, and an RPC address often holds a paid key.
import { allowEnv, type ChildResult, runChild } from "../shared/child"

/** The CLI's own variable for the Solana RPC, which it reads right after --rpc-url (solana-endpoint.ts). */
export const RPC_URL_ENV = "CANDLE_SOLANA_RPC_URL"

/** The arguments with `--rpc-url <url>` taken out, and the URL, for the child's environment. */
export function rpcToEnv(argv: readonly string[]): { argv: string[]; rpcUrl?: string } {
  const out: string[] = []
  let rpcUrl: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rpc-url" && argv[i + 1] !== undefined) {
      rpcUrl = argv[++i]
      continue
    }
    out.push(argv[i]!)
  }
  return { argv: out, ...(rpcUrl !== undefined ? { rpcUrl } : {}) }
}

export const CLI_TIMEOUT_MS = 120_000

export interface CliResult extends ChildResult {
  json?: unknown
  jsonError?: string
}

export class CandleCli {
  constructor(
    private readonly deps: {
      cliPath: string
      rpcUrl?: string
      keyFor: (agent: string) => string | undefined
      parentEnv: Record<string, string | undefined>
      /**
       * Each run with an agent's key, counted against that key's Candle limit. The CLI's
       * own requests can't be seen from here, so a run counts as one, or as `calls` where the caller knows
       * from the CLI's source how many it makes.
       */
      onRun?: (agent: string, calls: number) => void
      /** The CLI profile the Candle Harness acts as: every run gets it as CANDLE_PROFILE. Unset, the CLI picks. */
      profile?: () => string | undefined
    },
  ) {}

  /** The RPC from config, so what goes back to an agent can leave it out. */
  get rpcUrl(): string | undefined {
    return this.deps.rpcUrl
  }

  /** The exact arguments a run gets: the caller's, then `--json` and the configured `--rpc-url` where asked. */
  finalArgs(input: { args: string[]; json?: boolean; withRpcUrl?: boolean }): string[] {
    if (input.args.some((arg) => arg === "--rpc-url" || arg.startsWith("--rpc-url="))) {
      throw new Error("--rpc-url is set from the Candle Harness's config (candle.rpcUrl), never on a command line")
    }
    const args = [...input.args]
    if (input.json && !args.includes("--json")) args.push("--json")
    if (input.withRpcUrl && this.deps.rpcUrl) args.push("--rpc-url", this.deps.rpcUrl)
    return args
  }

  async run(input: { agent?: string; args: string[]; json?: boolean; withRpcUrl?: boolean; stdin?: string; timeoutMs?: number; calls?: number }): Promise<CliResult> {
    return this.runExact({ ...input, argv: this.finalArgs(input) })
  }

  /** Runs exactly `argv`, exactly as finalArgs made it (and, for an approved card, bound by its hash). */
  async runExact(input: { agent?: string; argv: string[]; json?: boolean; stdin?: string; timeoutMs?: number; calls?: number }): Promise<CliResult> {
    const extra: Record<string, string> = { CANDLE_NO_UPDATE_NOTIFIER: "1" }
    // The CLI's own config folder, when the user moved it: their profiles and vault live there.
    const configDir = this.deps.parentEnv.CANDLE_CONFIG_DIR
    if (configDir) extra.CANDLE_CONFIG_DIR = configDir
    // The CLI's own credential store on a machine with no keychain (Linux with no Secret Service): the person's
    // passphrase for it, from their own environment. Without it every owner read fails there.
    const keyring = this.deps.parentEnv.CANDLE_KEYRING_PASSPHRASE
    if (keyring) extra.CANDLE_KEYRING_PASSPHRASE = keyring
    const profile = this.deps.profile?.()
    if (profile) extra.CANDLE_PROFILE = profile
    if (input.agent !== undefined) {
      const key = this.deps.keyFor(input.agent)
      if (key === undefined) throw new Error(`No agent named "${input.agent}" has a key in the Candle Harness`)
      extra.CANDLE_API_KEY = key
      this.deps.onRun?.(input.agent, input.calls ?? 1)
    }
    const moved = rpcToEnv(input.argv)
    if (moved.rpcUrl !== undefined) extra[RPC_URL_ENV] = moved.rpcUrl
    const result = await runChild({
      cmd: this.deps.cliPath,
      args: moved.argv,
      env: allowEnv(this.deps.parentEnv, extra),
      cwd: this.deps.parentEnv.HOME ?? "/",
      timeoutMs: input.timeoutMs ?? CLI_TIMEOUT_MS,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    })
    if (!input.json) return result
    try {
      return { ...result, json: JSON.parse(result.stdout) }
    } catch (error) {
      return { ...result, jsonError: (error as Error).message }
    }
  }
}
