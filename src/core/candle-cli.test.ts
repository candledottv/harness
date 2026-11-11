// The core runs the user's `candle` CLI for what the MCP tools lack: no shell, an allowlisted
// environment, a key only ever in the environment, and `--rpc-url` only from config.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { CandleCli, RPC_FROM_CONFIG } from "./candle-cli"

const KEY = `cndl_live_${"c".repeat(40)}`
let dir: string
let bin: string
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "chrn-cli-"))
  bin = join(dir, "candle")
  await $`bun build --compile ${join(import.meta.dir, "../../test/fake-candle-cli.ts")} --outfile ${bin}`.quiet()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function cli(opts: { rpcUrl?: string; evmRpcUrl?: string; parentEnv?: Record<string, string | undefined> } = {}) {
  const configDir = mkdtempSync(join(dir, "cfg-"))
  const parentEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    CANDLE_CONFIG_DIR: configDir,
    CANDLE_API_KEY: `cndl_live_${"p".repeat(40)}`, // the parent's own key: must not pass
    CANDLE_DEVICE_TOKEN: "device-token-must-not-pass",
    CANDLE_HARNESS_HOME: "/must/not/pass",
    ...opts.parentEnv,
  }
  const runner = new CandleCli({
    cliPath: bin,
    ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
    ...(opts.evmRpcUrl ? { evmRpcUrl: opts.evmRpcUrl } : {}),
    keyFor: (agent) => (agent === "momentum" ? KEY : undefined),
    parentEnv,
  })
  const runs = () => (existsSync(join(configDir, "fake-cli-runs.jsonl")) ? readFileSync(join(configDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [])
  return { runner, runs, configDir }
}

describe("candleCli.run", () => {
  test("an agent's run carries its key in the environment only, never in an argument", async () => {
    const { runner, runs } = cli()
    const result = await runner.run({ agent: "momentum", args: ["portfolio"], json: true })
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, json: { ok: true, argv: ["portfolio", "--json"] } })
    const [run] = runs()
    expect(run.env.CANDLE_API_KEY).toBe(KEY)
    expect(JSON.stringify(run.argv)).not.toContain(KEY)
  })

  test("the user's own run carries no key at all, and the CLI's own config folder is kept", async () => {
    const { runner, runs, configDir } = cli()
    await runner.run({ args: ["keys", "list"], json: true })
    const [run] = runs()
    expect(run.env.CANDLE_API_KEY).toBeUndefined()
    expect(run.env.CANDLE_CONFIG_DIR).toBe(configDir)
  })

  test("nothing else from the parent passes: no device token, no Candle Harness variables", async () => {
    const { runner, runs } = cli()
    await runner.run({ agent: "momentum", args: ["portfolio"] })
    const env = runs()[0].env as Record<string, string>
    expect(env.CANDLE_DEVICE_TOKEN).toBeUndefined()
    expect(env.CANDLE_HARNESS_HOME).toBeUndefined()
    expect(Object.keys(env).filter((k) => k.startsWith("CANDLE_")).sort()).toEqual(["CANDLE_API_KEY", "CANDLE_CONFIG_DIR", "CANDLE_NO_UPDATE_NOTIFIER"])
  })

  test("the CLI's credential-store passphrase passes, for a machine with no keychain", async () => {
    const { runner, runs } = cli({ parentEnv: { CANDLE_KEYRING_PASSPHRASE: "the-person's-own" } })
    await runner.run({ args: ["auth", "status"], json: true })
    expect(runs()[0].env.CANDLE_KEYRING_PASSPHRASE).toBe("the-person's-own")
  })

  test("no shell: an argument is never interpreted", async () => {
    const { runner, runs } = cli()
    await runner.run({ args: ["portfolio", "$(id)", "a;b", "`id`"] })
    expect(runs()[0].argv).toEqual(["portfolio", "$(id)", "a;b", "`id`"])
  })

  test("--rpc-url comes only from config, and reaches the CLI in its environment, never on its command line", async () => {
    const { runner, runs } = cli({ rpcUrl: "https://rpc.example.com/solana" })
    // What's saved names the address by a marker; the address itself goes in only where the command runs.
    expect(runner.finalArgs({ args: ["portfolio"], withRpcUrl: true })).toEqual(["portfolio", "--rpc-url", RPC_FROM_CONFIG])
    await runner.run({ args: ["portfolio"], withRpcUrl: true })
    expect(runs()[0].argv).toEqual(["portfolio"])
    expect(runs()[0].env.CANDLE_SOLANA_RPC_URL).toBe("https://rpc.example.com/solana")
    await runner.run({ args: ["keys", "list"] })
    expect(runs()[1].argv).toEqual(["keys", "list"])
    expect(runs()[1].env.CANDLE_SOLANA_RPC_URL).toBeUndefined()
    await expect(runner.run({ args: ["portfolio", "--rpc-url", "https://evil.example"] })).rejects.toThrow(/rpc-url/)
    await expect(runner.run({ args: ["portfolio", "--rpc-url=https://evil.example"] })).rejects.toThrow(/rpc-url/)
    expect(runs()).toHaveLength(2)
  })

  test("the EVM RPC from config reaches every run in the CLI's own variable, never as --rpc-url; the person's own doesn't pass", async () => {
    const evm = `https://hood-rpc.example.com/v2/${"e".repeat(24)}`
    const { runner, runs } = cli({ evmRpcUrl: evm, rpcUrl: "https://rpc.example.com/solana", parentEnv: { CANDLE_EVM_RPC_URL: "https://the-persons-own.example" } })
    await runner.run({ agent: "momentum", args: ["swap", "ETH", "0x" + "4d".repeat(20), "--amount", "0.01"], json: true, withRpcUrl: true })
    expect(runs()[0].env.CANDLE_EVM_RPC_URL).toBe(evm)
    expect(runs()[0].env.CANDLE_SOLANA_RPC_URL).toBe("https://rpc.example.com/solana")
    expect(JSON.stringify(runs()[0].argv)).not.toContain("hood-rpc")
    const none = cli({ parentEnv: { CANDLE_EVM_RPC_URL: "https://the-persons-own.example" } })
    await none.runner.run({ args: ["portfolio"] })
    expect(none.runs()[0].env.CANDLE_EVM_RPC_URL).toBeUndefined()
  })

  test("saved arguments that went through the journal's redactor still run against the configured address, key and all", async () => {
    const rpcUrl = `https://rpc.example.com/?api-key=${"k".repeat(16)}`
    const pathKeyed = `https://rpc.example.com/v2/${"p".repeat(32)}`
    for (const url of [rpcUrl, pathKeyed]) {
      const { runner, runs } = cli({ rpcUrl: url })
      const saved = runner.finalArgs({ args: ["swap", "SOL", "MoonFake", "--amount", "0.04"], json: true, withRpcUrl: true })
      // Nothing saved holds the address, so a redacted copy read back from the journal is the same arguments.
      expect(JSON.stringify(saved)).not.toContain("rpc.example.com")
      const reread = JSON.parse(JSON.stringify(new Redactor().value({ argv: saved }))) as { argv: string[] }
      expect(reread.argv).toEqual(saved)
      await runner.runExact({ argv: reread.argv, json: true })
      expect(runs()[0].env.CANDLE_SOLANA_RPC_URL).toBe(url)
      expect(runs()[0].argv).toEqual(["swap", "SOL", "MoonFake", "--amount", "0.04", "--json"])
    }
  })

  test("arguments an older version saved with the address itself, redacted since, run against the configured one; with none configured the flag goes", async () => {
    const rpcUrl = `https://rpc.example.com/?api-key=${"k".repeat(16)}`
    const old = new Redactor().value(["swap", "SOL", "MoonFake", "--json", "--rpc-url", rpcUrl])
    expect(old.at(-1)).toContain("[redacted]")
    const configured = cli({ rpcUrl })
    await configured.runner.runExact({ argv: old })
    expect(configured.runs()[0].env.CANDLE_SOLANA_RPC_URL).toBe(rpcUrl)
    const none = cli()
    expect(none.runner.realArgs(old)).toEqual(["swap", "SOL", "MoonFake", "--json"])
    expect(none.runner.realArgs(["swap", "--rpc-url", RPC_FROM_CONFIG])).toEqual(["swap"])
    await none.runner.runExact({ argv: old })
    expect(none.runs()[0].env.CANDLE_SOLANA_RPC_URL).toBeUndefined()
  })

  test("an unknown agent is refused, never run as the user", async () => {
    const { runner, runs } = cli()
    await expect(runner.run({ agent: "ghost", args: ["portfolio"] })).rejects.toThrow(/ghost/)
    expect(runs()).toEqual([])
  })

  test("exit codes come back as they are; JSON that doesn't parse is said so", async () => {
    const { runner } = cli()
    expect(await runner.run({ args: ["exit3"], json: true })).toMatchObject({ exitCode: 3, json: { code: "OUTCOME_UNKNOWN" } })
    const bad = await runner.run({ args: ["badjson"], json: true })
    expect(bad.json).toBeUndefined()
    expect(bad.jsonError).toBeDefined()
  })

  test("a run past its timeout is killed and says so", async () => {
    const { runner } = cli()
    const result = await runner.run({ args: ["sleep"], timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
  })
})

// The fake CLI's TEE answers follow the recorded shapes (test/fixtures/candle-recorded/tee/clicmd-*).
describe("the fake CLI answers TEE reads in the recorded shapes", () => {
  const recorded = (name: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded/tee", `clicmd-${name}.json`), "utf8")) as { exit: number; stdout: Record<string, unknown> }
  const keys = (o: unknown) => Object.keys(o as object).sort()
  const TEE = "TeeFake111111111111111111111111111111111111"
  function scripted() {
    const c = cli()
    writeFileSync(
      join(c.configDir, "fake-cli.json"),
      JSON.stringify({
        tee: {
          wallets: [{ id: "teefakeid1", address: TEE, label: "tee-wallet-1", boundKeyPrefix: KEY.slice(10, 18) }],
          jobs: { "00000000-0000-4000-8000-000000000001": { kind: "trade", job: { status: "built", clientTradeId: "00000000-0000-4000-8000-000000000001" } } },
        },
      }),
    )
    return c
  }

  test("tee status: the bound wallet for its own key, TEE_WALLET_NOT_ON_KEY for another", async () => {
    const { runner } = scripted()
    const bound = await runner.run({ agent: "momentum", args: ["tee", "status", TEE], json: true })
    expect(bound.exitCode).toBe(0)
    expect(keys(bound.json)).toEqual(keys(recorded("tee-status-bound").stdout))
    const other = await runner.run({ args: ["tee", "status", TEE], json: true })
    expect(other.exitCode).toBe(1)
    expect(other.json).toMatchObject({ ok: false, code: "TEE_WALLET_NOT_ON_KEY" })
  })

  test("swap status: a scripted job on its rail, JOB_NOT_FOUND otherwise", async () => {
    const { runner } = scripted()
    const found = await runner.run({ agent: "momentum", args: ["swap", "status", "00000000-0000-4000-8000-000000000001", "--kind", "trade"], json: true })
    expect(found.exitCode).toBe(0)
    expect(keys(found.json)).toEqual(keys(recorded("swap-status-trade-built").stdout))
    const wrongRail = await runner.run({ agent: "momentum", args: ["swap", "status", "00000000-0000-4000-8000-000000000001", "--kind", "swap"], json: true })
    expect(wrongRail.exitCode).toBe(1)
    expect(wrongRail.json).toMatchObject({ ok: false, code: "JOB_NOT_FOUND" })
  })

  test("keys wallets and lp answer as recorded", async () => {
    const { runner } = scripted()
    const wallets = await runner.run({ args: ["keys", "wallets", KEY.slice(10, 18)], json: true })
    expect(keys(wallets.json)).toEqual(keys(recorded("keys-wallets-bound").stdout))
    expect((wallets.json as { wallets: unknown[] }).wallets).toHaveLength(1)
    const lp = await runner.run({ agent: "momentum", args: ["lp", "pools", "MoonFake11111111111111111111111111111111111"], json: true })
    expect(lp.exitCode).toBe(1)
    expect(lp.json).toEqual(recorded("lp-pools-not-enabled").stdout)
  })

  test("wallets answers in the recorded shape, with the signer the doctor reads", async () => {
    const { runner } = scripted()
    const wallets = await runner.run({ agent: "momentum", args: ["wallets"], json: true })
    const real = recorded("wallets").stdout as { signers: Record<string, string>; linked: { page: Record<string, unknown>[] } }
    expect(keys(wallets.json)).toEqual(keys(real))
    const fake = wallets.json as typeof real
    expect(Object.values(fake.signers)).toEqual(Object.values(real.signers))
    for (const field of ["_id", "address", "label", "boundKeyPrefix", "walletKind"]) expect(Object.keys(fake.linked.page[0]!)).toContain(field)
  })
})

// close-empty as production answered it (test/fixtures/candle-recorded/cli-0.13.5/clicmd-close-empty-*).
describe("the fake CLI answers close-empty in production's shapes", () => {
  const fromCli0135 = (name: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded/cli-0.13.5", `clicmd-${name}.json`), "utf8")) as { exit: number; stdout: Record<string, unknown>; stderr: string }
  const keys = (o: unknown) => Object.keys(o as object).sort()
  const TEE = "TeeFake111111111111111111111111111111111111"

  test("the preview, the close, its read-back and nothing to close: the same fields, exits and stderr lines", async () => {
    const c = cli()
    writeFileSync(join(c.configDir, "fake-cli.json"), JSON.stringify({ closeEmpty: { accounts: { [TEE]: 4 } } }))
    // A line's words, with every address, id and figure (anything holding a digit) as N.
    const shape = (s: string) => s.split("\n").map((l) => l.replace(/[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*/g, "N"))
    const preview = await c.runner.run({ agent: "momentum", args: ["wallets", "close-empty", "--wallet", TEE], json: true })
    expect(preview.exitCode).toBe(fromCli0135("close-empty-preview").exit)
    expect(keys(preview.json)).toEqual(keys(fromCli0135("close-empty-preview").stdout))
    expect(shape(preview.stderr)).toEqual(shape(fromCli0135("close-empty-preview").stderr))
    const close = await c.runner.run({ agent: "momentum", args: ["wallets", "close-empty", "--wallet", TEE, "--client-trade-id", "close-1", "--yes"], json: true })
    const recordedClose = fromCli0135("close-empty-run")
    expect(close.exitCode).toBe(recordedClose.exit)
    expect(keys(close.json)).toEqual(keys(recordedClose.stdout))
    const row = (o: unknown, k: string) => keys((o as Record<string, unknown[]>)[k]![0])
    expect(row(close.json, "closed")).toEqual(row(recordedClose.stdout, "closed"))
    expect(row(close.json, "transactions")).toEqual(row(recordedClose.stdout, "transactions"))
    expect(shape(close.stderr)).toEqual(shape(recordedClose.stderr))
    const back = await c.runner.run({ agent: "momentum", args: ["wallets", "close-empty", "--wallet", TEE, "--client-trade-id", "close-1"], json: true })
    const recordedBack = fromCli0135("close-empty-read-back")
    expect(keys(back.json)).toEqual(keys(recordedBack.stdout))
    const job = (o: unknown) => (o as { job: Record<string, unknown> }).job
    expect(keys(job(back.json))).toEqual(keys(job(recordedBack.stdout)))
    expect(keys(job(back.json).result)).toEqual(keys(job(recordedBack.stdout).result))
    const nothing = await c.runner.run({ agent: "momentum", args: ["wallets", "close-empty", "--wallet", TEE], json: true })
    const recordedNothing = fromCli0135("close-empty-nothing")
    expect(nothing.exitCode).toBe(recordedNothing.exit)
    expect(keys(nothing.json)).toEqual(keys(recordedNothing.stdout))
    expect(keys((nothing.json as { preview: object }).preview)).toEqual(keys(recordedNothing.stdout.preview))
    expect(shape(nothing.stderr)).toEqual(shape(recordedNothing.stderr))
  })
})
