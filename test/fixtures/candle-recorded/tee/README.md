# Recorded Candle shapes: TEE wallets

Recorded on a separate test machine on 2026-10-27, after a TEE wallet was rebound onto
`agent-a`'s key. CLI 0.11.41, Candle's MCP server 0.10.22 through `candle mcp`, the Max plan, and two
agent keys (`agent-a`, `agent-b`) on one throwaway account. Nothing in the run moved funds.

Two kinds of file:

- **`cli-agent-*`**: `test/record-candle.ts` through `candle mcp`, one per tool call, as in the parent
  folder. The `package-*` handshakes are `down`: the npm package wasn't installed.
- **`clicmd-*`**: the CLI's own `--json` answers, wrapped as `{ command, exit, stdout }`. `command`
  says what was run, with placeholders. The two quotes were run without `--yes` and answered `N`
  at the CLI's prompt. Their result is the last line of the recorded terminal; the quote lines
  printed above it on stderr are left out.

Written by `bun scripts/scrub-recordings.ts <staged raw folder> test/fixtures/candle-recorded/tee`.
Every address, id, key prefix, label, Privy id, balance, price, clock and the API host is made up,
and the home folder is written `~`. Each key prefix keeps its own fake (`FakeKey1` is agent-a,
`FakeKey2` agent-b), in fields and in messages alike. Candle's public CNDL and sCNDL mints stay. Shapes, codes, messages and
timings are as recorded. The tool list matched `../../candle-tools.json` exactly, so that file
wasn't rewritten.

`src/core/recorded.test.ts` and `src/core/candle-cli.test.ts` check the core's reads and both fakes
against these files.

What they showed:

- **`candle_get_profile_wallets { keyPrefix }` lists the bound TEE wallet.** agent-a's key shows it
  under `walletScope: "selected"` with `spendCapable: true`, and agent-b's key shows none. That
  agrees with the owner's `keys wallets` and with `tee status` under each key. So the core can
  use the MCP read. The answer also carries `profileId` and `scopeLimit`, which the docs don't list.
- **The portfolio's `tee` array is the account's.** Both keys see the same wallet, with `id`,
  `address`, `label`, `active`, `chain`, `lamports` and `tokens`. The profile read's
  `linkedWalletId` joins to `id`.
- **TEE base swaps are switched on.** A SOL to USDC quote from the TEE wallet came back like the
  token buy's, `kind: "swap"`. The base swap's tier fee was 0 bps, and the token buy's 25 bps (Max).
- **A declined quote** is `{ success: true, status: "cancelled", clientTradeId, kind, quote }`, with
  `quote.wallet`, `venue`, `priceImpactPct`, `fee { bps, feeRaw, treasury? }`, `minimumReceived`,
  `minOutRaw`, `minimumReceivedRaw` and `tokenRisks`.
- **A declined quote still leaves a built job:**
  - the trade rail's job is `{ status: "built", clientTradeId, chain, side, mint, quoteAsset, amountRaw, createdAt, updatedAt }`;
  - the swap rail's is `{ status: "built", clientTradeId, kind: "swap", signature: null }`, with no
    `settlement` yet.

  `swap status` adds `success`, `kind` and `clientTradeId` around it. Asked on the other rail, or
  for an unknown id, it's `JOB_NOT_FOUND`, exit 1. Hence the rule: a card's id never runs without
  `--yes`.
- **Each run claims its id** in `<CLI config>/operations/<sha256>.json` as `{ id, kind }`, in a 0700
  folder with 0600 files. The folder didn't exist before this run.
- **`candle wallets --json`** reports `signers: { <tee id>: "stored" }`: the signer is reachable on
  this machine. The CLI's `doctor --json` has no per-wallet row, only "TEE limits".
- **LP is still off:** `LP_NOT_ENABLED` for every key.
