# Recorded Candle shapes: the vault and the prompt pane

Recorded on a separate test machine on 2026-10-27, before the prompt pane was built. The
CLI was updated from 0.11.41 to 0.12.0 first, and every answer here is 0.12.0's. One throwaway
account on the Max plan, with a vault holding one vault key and one TEE wallet, the TEE wallet bound to
`agent-a`'s key. Nothing in the run moved funds or changed a key.

Every file is a `clicmd-*` answer: the CLI's own `--json` output, wrapped as `{ command, exit, stdout }`.
`command` says what was run, with placeholders. Rows that asked for the passphrase were run at a
terminal with stdout sent to a file, as the pane's factor step will be. The passphrase was typed only at
the CLI's own hidden prompt. Prompts and progress lines went to the terminal (stderr) and aren't here.

Written by `bun scripts/scrub-recordings.ts <staged raw folder> test/fixtures/candle-recorded/vault`.
Every address, id, key prefix, label, Privy id, balance, clock and the API host is made up, and the home
folder is written `~`. `FakeKey1` is the CLI profile's own key and `FakeKey2` is agent-a's (the one the
TEE wallet is bound to). `FakeDvc1` is the device token's prefix. `VaultFake…` is the vault key the TEE
wallet is pinned to, and `TeeFake1…` the TEE wallet, the same in every file. Shapes, codes, messages and
exit statuses are as recorded.

What they showed:

- **The factor step works on a terminal with stdout in a file.** `vault status --unlock --json` asks
  `Vault passphrase (input hidden): `, then prints `Deriving the vault key (Argon2id, 64 MiB)` on
  stderr, and writes its JSON to the file:
  - right: exit 0, `ok: true`, with `unlocked.entries`;
  - wrong: exit 1, `{ ok: false, code: "VAULT_UNLOCK_FAILED", message: "Could not open the vault: wrong passphrase, or the file is corrupt." }`.
    It asks once;
  - two unlocks in a row give byte-identical output, and none of them writes to the vault's files.
- **Ctrl-C at the hidden prompt doesn't end the CLI** (`clicmd-vault-status-unlock-ctrlc.json`). It sat
  at the prompt at 100% CPU until a SIGTERM from another terminal: exit 143, nothing written to stdout,
  and the terminal's settings (`stty -a`) the same as before. So the pane has to stop the child itself.
- **The vault had one factor,** a generated passphrase, so the unlock opened on the passphrase prompt
  with no menu. `legacyWalletsEnc` was `null`: no older TEE wallet store.
- **`vault list --json`** is `{ ok, path, total, matched, entries }`. Each entry has `address`, `label`,
  `id`, `role` (`vault` or `tee-wallet`), `origin`, `derivation`, `exposure`; a TEE wallet's also has
  `teeLifecycle` and `teeRemoteState`. `chain` isn't in the entries.
- **`tee status <address> --verify --json`** found the TEE wallet in this vault (`source: "vault"`,
  `localState: "enabled"`), so `vault transfer --from <it>` can sign here. Its `vaultDestination` is the
  vault key, the same locally and in `server`. `server` answered under the profile's own key, though the
  wallet is bound to agent-a's. TEE commands take the address: the CLI matches entries by address only.
- **`tee fund … --json`** asks for the passphrase, then prints the instruction and signs nothing. **Its
  success has no `ok` field:** `{ action: "fund-tee-wallet", network, asset, amount, amountRaw,
  destination, from, note }`. A wrong passphrase is the usual `VAULT_UNLOCK_FAILED`, exit 1.
- **`wallets --json`** under the profile's own key has one linked row, the TEE wallet:
  `addedVia: "agent"`, `trustedAt` absent, `allowLaunch: false`, `walletKind: "tee"`. The account has
  no trusted wallet, so there's no trusted row's shape yet. The vault key isn't a linked wallet.
- **`auth status --json`** carries `deviceTokenPrefix` and `keyPrefix`: this profile holds an API key of
  its own, so a new key from `keys create` wouldn't become its working key.
- **`update --to cli-v0.12.0 --json`** from a binary install: `{ current, latest, updated: true, path,
  helper }`. It changed nothing in the keychain or the CLI's config.
