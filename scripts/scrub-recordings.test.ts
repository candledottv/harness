import { describe, expect, test } from "bun:test"
import { FAKE, leftovers, scrub, toolFixture } from "./scrub-recordings"

// Made-up stand-ins for an account's real values, shaped like them.
const WALLET = "Hq7mZ3pTkR9vXw2sLbN4cYd8eFgJ5aUo6iK1nMrQtVx"
const EVM = "0x5c3E8b1A9d2F7e6C4b0a8D3f1E9c7B5a2D4f6E8c"
const TEE = "Gz4kP8wN2mQ7rT1vY5xB9cL3dF6hJ2sA8eU2iP4nRtK"
const MINT = "Cn5dL9xR2wQ7tP4mK8vB1zY6hF3jS2aG5eU9iP2nTCNDL"
const ID = "9b2e7f14-3c8d-4a6b-9e1f-0d5c7a2b8e43"

const files = {
  "cli-first-candle_get_wallets.json": {
    tool: "candle_get_wallets",
    args: {},
    ms: 250,
    outcome: { kind: "ok", result: { success: true, account: WALLET, username: "SOMEONE", wallets: { solana: { address: WALLET }, evm: { address: EVM } } } },
  },
  "cli-first-candle_get_portfolio.json": {
    tool: "candle_get_portfolio",
    args: {},
    ms: 600,
    outcome: {
      kind: "ok",
      result: {
        embedded: [{ address: WALLET, lamports: "123456789", tokens: [] }],
        tee: [{ id: "r1abc2def3", address: TEE, label: "my-tee", lamports: "42" }],
        prices: { So11111111111111111111111111111111111111112: { priceUsd: 101.23 } },
      },
    },
  },
  "cli-first-candle_trade-paper-buy.json": {
    tool: "candle_trade",
    args: { mint: MINT, side: "buy", amount: "0.01", paper: true, clientTradeId: ID },
    ms: 1100,
    outcome: { kind: "ok", result: { clientTradeId: ID, api: { paper: true, mint: MINT, expectedOutRaw: "662639181", tokenAmount: 662.639181 } } },
  },
  "cli-spare1-handshake.json": { route: "cli", status: { state: "ready", version: "0.10.22" }, stderrTail: "Profile: none   Account: someone at https://api.example\n", tools: [{ name: "candle_trade" }] },
}

describe("scrub", () => {
  const { files: out, problems } = scrub(files as never)
  const all = JSON.stringify(out)

  test("no address, id, label, username, figure or banner survives", () => {
    expect(problems).toEqual([])
    for (const real of [WALLET, EVM, TEE, MINT, ID, "SOMEONE", "r1abc2def3", "my-tee", "123456789", "101.23", "662639181", "api.example"]) {
      expect(all).not.toContain(real)
    }
  })

  test("each value gets the fake for its role, and the public mints stay", () => {
    const wallets = out["cli-agent-a-candle_get_wallets.json"] as { outcome: { result: { account: string; wallets: { evm: { address: string } } } } }
    expect(wallets.outcome.result.account).toBe(FAKE.wallet)
    expect(wallets.outcome.result.wallets.evm.address).toBe(FAKE.evm)
    expect(all).toContain(FAKE.tee(1))
    expect(all).toContain(FAKE.mint)
    expect(all).toContain(FAKE.uuid(1))
    expect(all).toContain("So11111111111111111111111111111111111111112")
  })

  test("the same id stays the same fake everywhere, so a trade and its read-back still match", () => {
    const trade = out["cli-agent-a-candle_trade-paper-buy.json"] as { args: { clientTradeId: string }; outcome: { result: { clientTradeId: string } } }
    expect(trade.outcome.result.clientTradeId).toBe(trade.args.clientTradeId)
  })

  test("key labels in file names are renamed", () => {
    expect(Object.keys(out).sort()).toEqual([
      "cli-agent-a-candle_get_portfolio.json",
      "cli-agent-a-candle_get_wallets.json",
      "cli-agent-a-candle_trade-paper-buy.json",
      "cli-agent-denied-handshake.json",
    ])
  })

  test("an address it can't place is reported, and nothing is written", () => {
    const stray = { "cli-first-x.json": { note: `sent to ${"Pq3wE8rT5yU1iP7pA4sD9fG2hJ6kL2zX5cV8bN3mQwE"}` } }
    expect(scrub(stray as never).problems).toHaveLength(1)
  })

  test("leftovers ignores the fakes and the public mints", () => {
    expect(leftovers(JSON.stringify([FAKE.wallet, FAKE.mint, FAKE.evm, FAKE.tee(2), FAKE.uuid(3), "So11111111111111111111111111111111111111112"]), [])).toEqual([])
  })

  test("the tool fixture marks the profile tools listed only after the key check", () => {
    const fixture = toolFixture(
      { status: { version: "0.10.22" }, tools: [{ name: "candle_trade" }, { name: "candle_update_profile" }] } as never,
      "2026-10-26",
    ) as { tools: { name: string; listedAfterKeyCheck?: boolean }[]; serverInfo: { version: string } }
    expect(fixture.serverInfo.version).toBe("0.10.22")
    expect(fixture.tools).toEqual([{ name: "candle_trade" }, { name: "candle_update_profile", listedAfterKeyCheck: true }])
  })
})

// TEE wallets, the CLI's own answers wrapped as `clicmd-*`, and two keys labelled a and b.
describe("scrub, TEE wallets and the CLI's answers", () => {
  const PREFIX_A = "Zq8x_Kp2"
  const PREFIX_B = "mN4-tR7w"
  const HELD = "Hk9dLmP3qRsT5vWx7yZa2bCd4eFg6hJk8mNp1qRsTuVw"
  const ORE = "Tr5aDeM1nT2bC3dE4fG5hJ6kL7mN8pQ9rS1tU2vW3xY4"
  const VAULT = "Vq2wE3rT4yU5iO6pA7sD8fG9hJ1kL2zX3cV4bN5mQ6w"
  const TREASURY = "Ts1aR2eA3sU4rY5wA6lL7eT8kE9yZ1xC2vB3nM4qW5e"
  const TEE_ID = "teeidfortests000000000001"
  const tee = {
    "cli-a-candle_get_portfolio.json": {
      tool: "candle_get_portfolio",
      args: {},
      ms: 650,
      outcome: {
        kind: "ok",
        result: {
          embedded: [{ address: WALLET, chain: "solana", lamports: "67175262", tokens: [{ mint: HELD, amountRaw: "24042617290", decimals: 6 }] }],
          tee: [{ id: TEE_ID, address: TEE, label: "my-tee", active: true, lamports: "20000000", tokens: [] }],
          prices: { [HELD]: { priceUsd: 0.00003, updatedAt: 1793109594237, symbol: "HELDX", name: "Held Token" } },
        },
      },
    },
    "cli-a-candle_get_profile_wallets.json": {
      tool: "candle_get_profile_wallets",
      args: { keyPrefix: PREFIX_A },
      ms: 290,
      outcome: { kind: "ok", result: { keyPrefix: PREFIX_A, profileId: "prof_0f1e2d3c4b5a6978", walletScope: "selected", wallets: [{ address: TEE, assignedAt: 1793110358708, label: "my-tee", linkedWalletId: TEE_ID, spendCapable: true }] } },
    },
    "cli-b-candle_get_staking.json": {
      tool: "candle_get_staking",
      args: {},
      ms: 586,
      outcome: { kind: "ok", result: { wallets: [{ cndl: { mint: "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL", amountRaw: "0" }, staked: { mint: "LuPsFmtvdFMuCjd6GBMVUErTiBAkkP6ECUVjsPcCNDL", amountRaw: "0" } }] } },
    },
    "clicmd-tee-status-other-key.json": {
      command: "tee status",
      exit: 1,
      stdout: { ok: false, code: "TEE_WALLET_NOT_ON_KEY", message: `${TEE} is not a TEE wallet bound to key ${PREFIX_B}.` },
    },
    "clicmd-tee-status-bound.json": {
      command: "tee status",
      exit: 0,
      stdout: { address: TEE, server: { boundKeyPrefix: PREFIX_A, vaultDestination: VAULT, evidenceObservedAt: 1792997647834 }, observedAt: "2026-10-27T14:14:07.937Z" },
    },
    "clicmd-wallets.json": {
      command: "wallets",
      exit: 0,
      stdout: { linked: { page: [{ _id: TEE_ID, address: TEE, privyWalletId: "fakeprivywallet00000001", privyPolicyId: "fakeprivypolicy00000001", signerQuorumId: "fakesignerquorum0000001", remoteEvidenceDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", userAddress: WALLET }] }, signers: { [TEE_ID]: "stored" } },
    },
    "clicmd-swap-trade-cancelled.json": {
      command: "swap",
      exit: 0,
      stdout: { status: "cancelled", quote: { intent: `Swap 0.001000000 SOL to ${ORE}`, fee: { bps: 25, treasury: TREASURY }, minimumReceived: `0.0006 ${ORE}` } },
    },
    "clicmd-swap-status-trade-built.json": { command: "swap status", exit: 0, stdout: { job: { status: "built", mint: ORE, createdAt: 1793110729912 } } },
    "clicmd-doctor.json": {
      command: "doctor",
      exit: 0,
      stdout: { rows: [{ check: "Config directory", detail: "/Users/tester9/.config/candle (the default)" }, { check: "API key", detail: `from CANDLE_API_KEY; ${PREFIX_A}` }], provenance: { apiUrl: { value: "https://api.example-env.candle.tv" } } }, // scrub-ok: a made-up home path the scrub must replace
    },
  }
  const { files: out, problems } = scrub(tee as never)
  const all = JSON.stringify(out)

  test("nothing of the account survives: prefixes in messages, Privy ids, the profile, the vault, the home path, the API host", () => {
    expect(problems).toEqual([])
    for (const real of [PREFIX_A, PREFIX_B, HELD, ORE, VAULT, TREASURY, TEE, TEE_ID, "prof_0f1e2d3c4b5a6978", "fakeprivywallet00000001", "fakeprivypolicy00000001", "fakesignerquorum0000001", "0123456789ab", "tester9", "example-env", "HELDX", "Held Token", "24042617290", "67175262", "1793110358708", "2026-10-27T14:14"]) {
      expect(all).not.toContain(real)
    }
  })

  test("each key keeps its own fake prefix, the same in fields and in messages", () => {
    const wallets = out["cli-agent-a-candle_get_profile_wallets.json"] as { args: { keyPrefix: string }; outcome: { result: { keyPrefix: string } } }
    expect(wallets.args.keyPrefix).toBe(FAKE.keyPrefix(1))
    expect(wallets.outcome.result.keyPrefix).toBe(FAKE.keyPrefix(1))
    expect(JSON.stringify(out["clicmd-tee-status-other-key.json"])).toContain(`bound to key ${FAKE.keyPrefix(2)}.`)
    expect(JSON.stringify(out["clicmd-tee-status-bound.json"])).toContain(FAKE.keyPrefix(1))
  })

  test("a TEE wallet is the same fake in the portfolio, the profile read and the CLI's answers", () => {
    for (const name of ["cli-agent-a-candle_get_portfolio.json", "cli-agent-a-candle_get_profile_wallets.json", "clicmd-tee-status-bound.json", "clicmd-wallets.json"]) {
      expect(JSON.stringify(out[name])).toContain(FAKE.tee(1))
    }
    const wallets = JSON.stringify(out["clicmd-wallets.json"])
    expect(wallets).toContain(`"${FAKE.teeId(1)}":"stored"`)
  })

  test("tokens get fakes, and Candle's public CNDL and sCNDL mints stay", () => {
    expect(all).toContain(FAKE.token(1))
    expect(all).toContain(FAKE.token(2))
    expect(all).toContain("9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL")
    expect(all).toContain("LuPsFmtvdFMuCjd6GBMVUErTiBAkkP6ECUVjsPcCNDL")
    const staking = JSON.stringify(out["cli-agent-b-candle_get_staking.json"])
    expect(staking).toContain('"amountRaw":"0"')
  })

  test("labels a and b are renamed, and clicmd files keep their names", () => {
    expect(Object.keys(out)).toContain("cli-agent-a-candle_get_profile_wallets.json")
    expect(Object.keys(out)).toContain("cli-agent-b-candle_get_staking.json")
    expect(Object.keys(out)).toContain("clicmd-doctor.json")
  })
})

describe("scrub, the vault", () => {
  const PREFIX_A = "Zq8x_Kp2"
  const PROFILE_KEY = "Pk3n-Wq9"
  const DEVICE = "Dv7mQ2xL"
  const VAULT = "Vq2wE3rT4yU5iO6pA7sD8fG9hJ1kL2zX3cV4bN5mQ6w"
  const OTHER_VAULT_KEY = "Ok9pL8mN7bV6cX5zA4sD3fG2hJ1kQ2wE3rT4yU5iO6p"
  const TEE_ID = "teeidfortests000000000001"
  const vaultEntries = [
    { address: VAULT, label: "my-cold", id: "vEnTrY0001a", role: "vault", derivation: "m/44'/501'/0'/0'" },
    { address: TEE, label: "my-tee", id: "vEnTrY0002b", role: "tee-wallet", teeLifecycle: "enabled" },
    { address: OTHER_VAULT_KEY, label: "my-spare", id: "vEnTrY0003c", role: "vault" },
  ]
  const vault = {
    "clicmd-auth-status.json": {
      command: "auth status",
      exit: 0,
      stdout: { profile: "production", deviceTokenPrefix: DEVICE, keyPrefix: PROFILE_KEY, account: WALLET, cachedAccount: WALLET, configPath: "/Users/tester9/.config/candle/config.json" }, // scrub-ok: a made-up home path
    },
    "clicmd-tee-status-verify.json": {
      command: "tee status --verify",
      exit: 0,
      stdout: { address: TEE, label: "my-tee", linkedWalletId: TEE_ID, vaultDestination: VAULT, server: { id: TEE_ID, address: TEE, boundKeyPrefix: PREFIX_A } },
    },
    "clicmd-vault-list.json": { command: "vault list", exit: 0, stdout: { ok: true, path: "/Users/tester9/.config/candle/vault.enc", entries: vaultEntries } }, // scrub-ok: a made-up home path
    "clicmd-vault-status-unlock.json": {
      command: "vault status --unlock",
      exit: 0,
      stdout: { ok: true, envelopes: [{ id: "eNvElOpE01x", factor: "passphrase", label: "my factor" }], unlocked: { entries: vaultEntries } },
    },
    "clicmd-wallets.json": {
      command: "wallets",
      exit: 0,
      stdout: { linked: { page: [{ _id: TEE_ID, address: TEE, label: "my-tee", walletKind: "tee", vaultDestination: VAULT, boundKeyPrefix: PREFIX_A }] }, signers: { [TEE_ID]: "stored" } },
    },
  }
  const { files: out, problems } = scrub(vault as never)
  const all = JSON.stringify(out)

  test("nothing of the vault survives: its keys, their labels and ids, the factor, the device token", () => {
    expect(problems).toEqual([])
    for (const real of [VAULT, OTHER_VAULT_KEY, TEE, TEE_ID, "my-cold", "my-tee", "my-spare", "vEnTrY000", "eNvElOpE01x", "my factor", DEVICE, PROFILE_KEY, PREFIX_A, "tester9"]) {
      expect(all).not.toContain(real)
    }
  })

  test("the TEE wallet and the pinned vault keep one fake each across the CLI's answers", () => {
    for (const name of ["clicmd-tee-status-verify.json", "clicmd-vault-list.json", "clicmd-vault-status-unlock.json", "clicmd-wallets.json"]) {
      expect(JSON.stringify(out[name])).toContain(FAKE.tee(1))
      expect(JSON.stringify(out[name])).toContain(FAKE.vault)
    }
    expect(JSON.stringify(out["clicmd-wallets.json"])).toContain(`"${FAKE.teeId(1)}":"stored"`)
    expect(JSON.stringify(out["clicmd-tee-status-verify.json"])).toContain(`"linkedWalletId":"${FAKE.teeId(1)}"`)
  })

  test("a second vault key gets its own fake, never the pinned vault's", () => {
    expect(all).toContain(FAKE.vaultKey(2))
    const entries = (out["clicmd-vault-list.json"] as { stdout: { entries: { address: string; role: string }[] } }).stdout.entries
    expect(entries.map((e) => [e.role, e.address])).toEqual([
      ["vault", FAKE.vault],
      ["tee-wallet", FAKE.tee(1)],
      ["vault", FAKE.vaultKey(2)],
    ])
  })

  test("the device token's prefix has its own fake, apart from the key prefixes", () => {
    const auth = (out["clicmd-auth-status.json"] as { stdout: { deviceTokenPrefix: string; keyPrefix: string } }).stdout
    expect(auth.deviceTokenPrefix).toBe(FAKE.devicePrefix(1))
    expect(auth.keyPrefix).toMatch(/^FakeKey\d$/)
  })

  test("a factor's label is a factor label, not a wallet's", () => {
    const status = (out["clicmd-vault-status-unlock.json"] as { stdout: { envelopes: { label: string; factor: string }[] } }).stdout
    expect(status.envelopes[0]).toMatchObject({ factor: "passphrase", label: "factor-label" })
  })
})

// close-empty's answers, a rename, a key's row with its cap, and staking withdrawals.
describe("scrub, closes, renames and key caps", () => {
  const LINKED = "linkedfortests0000000001"
  const ACCT_1 = "Ak1bC2dE3fG4hJ5kL6mN7pQ8rS9tU1vW2xY3zA4bC5d"
  const ACCT_2 = "Bm2cD3eF4gH5jK6lM7nP8qR9sT1uV2wX3yZ4aB5cD6e"
  const SIG = "3xKp9QmR2vT7wY4zA8bC1dE5fG6hJ9kL2mN4pQ7rS1tU3vW5xY8zA2bC4dE6fG8hJ1kL3mN5pQ7rS9tU2vW4xY6z"
  const WITHDRAWAL = "Wd4eF5gH6jK7lM8nP9qR1sT2uV3wX4yZ5aB6cD7eF8gH"
  const HELD = "Hk9dLmP3qRsT5vWx7yZa2bCd4eFg6hJk8mNp1qRsTuVw"
  const closed = [
    { mint: HELD, account: ACCT_1, lamports: "1488440", tokenProgram: "spl-token" },
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", account: ACCT_2, lamports: "1488440", tokenProgram: "spl-token" },
  ]
  const run = { success: true, status: "completed", clientTradeId: "close-1", wallet: TEE, linkedWalletId: LINKED, closed, transactions: [{ index: 0, signature: SIG, accounts: [ACCT_1, ACCT_2], lamports: "2976880" }], signatures: [SIG], lamportsRecovered: "2976880" }
  const cli0135 = {
    "clicmd-close-empty-preview.json": {
      command: "candle wallet close-empty",
      exit: 1,
      stdout: { ok: false, code: "CONFIRMATION_REQUIRED" },
      stderr: `Close 2 empty token accounts on the TEE wallet ${TEE}\n  ${HELD}  spl-token  0.00148844 SOL\n`,
    },
    "clicmd-close-empty-run.json": { command: "candle wallet close-empty --yes", exit: 0, stdout: run },
    "clicmd-close-empty-read-back.json": { command: "candle wallet close-empty --client-trade-id", exit: 0, stdout: { success: true, job: { kind: "close-empty", walletKind: "tee", linkedWalletId: LINKED, result: run } } },
    "clicmd-tee-rename.json": { command: "candle tee rename", exit: 0, stdout: { ok: true, renamed: [{ id: LINKED, chain: "solana", address: TEE, from: "my-renamed", to: "my-tee" }] } },
    "clicmd-keys-list.json": {
      command: "candle keys list",
      exit: 0,
      stdout: { keys: [{ _id: "keyrowfortests00000000001", keyPrefix: "Zq8x_Kp2", label: "my-key", txLimit: { usdMicros: 10_000_000, reset: "daily" }, usage: { todayUsdMicros: 4_006_421 }, emberWindow: { windowKey: "daily:1793491200000", capUsdMicros: 10_000_000, reservedUsdMicros: 4_006_421, remainingUsdMicros: 5_993_579 } }] },
    },
    "cli-a-candle_get_staking.json": {
      tool: "candle_get_staking",
      args: {},
      ms: 500,
      outcome: { kind: "ok", result: { wallets: [{ payer: "linked", linkedWalletId: LINKED, tee: true, address: TEE, pendingWithdrawalRaw: "328680247", withdrawals: { active: [{ withdrawal: WITHDRAWAL, amountRaw: "328680247" }] } }] } },
    },
  }
  const { files: out, problems } = scrub(cli0135 as never)
  const all = JSON.stringify(out)

  test("nothing of the account survives: token accounts, signatures, withdrawals, the wallet, its labels, the key's row and use", () => {
    expect(problems).toEqual([])
    for (const real of [TEE, LINKED, ACCT_1, ACCT_2, SIG, WITHDRAWAL, HELD, "my-renamed", "my-tee", "my-key", "keyrowfortests00000000001", "Zq8x_Kp2", "4006421", "1793491200000", "328680247"]) {
      expect(all).not.toContain(real)
    }
  })

  test("a close's TEE wallet is the TEE fake, in its fields and in the preview's words", () => {
    expect(JSON.stringify(out["clicmd-close-empty-preview.json"])).toContain(`on the TEE wallet ${FAKE.tee(1)}`)
    expect((out["clicmd-close-empty-run.json"] as { stdout: { wallet: string; linkedWalletId: string } }).stdout).toMatchObject({ wallet: FAKE.tee(1), linkedWalletId: FAKE.teeId(1) })
  })

  test("token accounts and the signature get fakes of their own, the same in every file; the rent stays", () => {
    const stdout = (out["clicmd-close-empty-run.json"] as { stdout: typeof run }).stdout
    expect(stdout.closed.map((c) => c.account)).toEqual([FAKE.tokenAccount(1), FAKE.tokenAccount(2)])
    expect(stdout.transactions[0]!.accounts).toEqual([FAKE.tokenAccount(1), FAKE.tokenAccount(2)])
    expect(stdout.signatures).toEqual([FAKE.signature(1)])
    expect(stdout.closed.map((c) => c.lamports)).toEqual(["1488440", "1488440"])
    expect(JSON.stringify(out["clicmd-close-empty-read-back.json"])).toContain(FAKE.signature(1))
    expect(leftovers(SIG, [])).toEqual([SIG])
  })

  test("a rename's old label is the fake's, marked renamed", () => {
    const row = (out["clicmd-tee-rename.json"] as { stdout: { renamed: { from: string; to: string }[] } }).stdout.renamed[0]!
    expect(row).toMatchObject({ from: `${FAKE.teeLabel(1)}-renamed`, to: FAKE.teeLabel(1) })
  })

  test("a key's label is a key label, and its cap and the day's use are made up but still add up", () => {
    const key = (out["clicmd-keys-list.json"] as { stdout: { keys: { label: string; emberWindow: Record<string, number> }[] } }).stdout.keys[0]!
    expect(key.label).toBe("key-label")
    expect(key.emberWindow.capUsdMicros! - key.emberWindow.reservedUsdMicros!).toBe(key.emberWindow.remainingUsdMicros!)
  })
})

describe("scrub, unchanged", () => {
  test("the tool fixture still marks the profile tools listed only after the key check", () => {
    const fixture = toolFixture(
      { status: { version: "0.10.22" }, tools: [{ name: "candle_trade" }, { name: "candle_update_profile" }] } as never,
      "2026-10-26",
    ) as { tools: { name: string; listedAfterKeyCheck?: boolean }[]; serverInfo: { version: string } }
    expect(fixture.serverInfo.version).toBe("0.10.22")
    expect(fixture.tools).toEqual([{ name: "candle_trade" }, { name: "candle_update_profile", listedAfterKeyCheck: true }])
  })
})
