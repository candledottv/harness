# Recorded Candle shapes: CLI 0.13.5

Recorded on a separate test machine on 2026-11-01, after `candle update --to cli-v0.13.5`
took the CLI from 0.12.0 to 0.13.5. Candle's MCP server answered as 0.10.25 through `candle mcp`. One
throwaway account on the Max plan, two agent keys (`agent-a`, `agent-b`), and one TEE wallet bound to
agent-a's key and held in this machine's vault. Nothing in the run traded. The one thing that moved
funds was closing the TEE wallet's four empty token accounts, which sent their rent back to that same
wallet.

Two kinds of file:

- **`cli-agent-*`**: `test/record-candle.ts` through `candle mcp`, one per tool call, the same reads as
  `../tee`. The `package-*` handshakes are `down`, since the npm package wasn't installed. The tool
  list was rewritten into `../../candle-tools.json` (61 tools).
- **`clicmd-*`**: the CLI's own `--json` answers, wrapped as `{ command, exit, stdout }`, plus
  `stderr` where the core reads it (close-empty's preview). `command` says what was run, with
  placeholders. The `keys-list-*` files keep agent-b's row alone. `tee-rename` was run under `script`
  at a terminal, and its JSON is the transcript's last line, after the passphrase prompt.

Written by `bun scripts/scrub-recordings.ts <staged raw folder> test/fixtures/candle-recorded/cli-0.13.5 --tools test/fixtures/candle-tools.json`.
Every address, id, key prefix, label, Privy id, balance, price, clock, signature, token account and
the API host is made up, and the home folder is written `~`. `FakeKey1` is agent-a, `FakeKey2`
agent-b and `FakeKey3` the CLI profile's own key. `TeeFake1…` is the TEE wallet, `TokenAcctFake…` its
token accounts, and `SigFake1…` the close's transaction. A key's cap and the day's use are made up,
but they still add up. A close's rent figures are as recorded, so they match the preview's words.
Shapes, codes, messages, exits and timings are as recorded.

`src/core/recorded-cli-0.13.5.test.ts` checks the core's reads against these files, and
`src/core/candle-cli.test.ts` checks the fake CLI's close-empty answers.

What they showed:

- **Production serves a TEE wallet's close-empty.** Without `--yes`, and with stdin not a terminal,
  the CLI exits 1 with `CONFIRMATION_REQUIRED` and prints its preview on stderr. The preview is the
  two lines the core reads, then one line for each account (`  <mint>  spl-token  <SOL> SOL`). The
  close (`--yes --client-trade-id`) exited 0, `status: "completed"`, with one transaction and
  `remaining: 0`, and printed `Operation: <id>` on stderr. Read back under the same id, it exited 0
  with Candle's stored job (`job.status` and `job.result.status` both `completed`, `submitState:
  "done"`, `reconciled: true`) and the same single signature, so nothing was sent again. The preview
  afterwards was `nothing_to_close`, exit 0, with the whole preview on stdout.
- **Server 0.10.25 lists 61 tools,** three more than 0.10.22: `candle_token_card` and
  `candle_token_events` (keyless reads, each off on a deployment until Candle switches it on) and
  `candle_upload_profile_image` (fetches a public https image, re-hosts it on `uploads.candle.tv` and
  sets the avatar or banner; it uses one of the profile's 20 daily edits even if the fetch fails).
  `candle_update_profile` now takes only `uploads.candle.tv` URLs for the avatar and banner. The
  launch tools' parameters gained enums and new descriptions, with the same names and the same
  required list. The four profile and post tools are listed only to a key whose public profile
  Candle says it may edit. Both keys may, so both listed all 61.
- **The TEE reads (`../tee`) only gained fields at 0.10.25:** `updateAvailable` in the status read, a CNDL price in
  the portfolio, and an open withdrawal's fields in staking.
- **`keys limit` with the same cap** answers `{ ok, keyPrefix, txLimit }` and leaves the day's use
  and the window (`emberWindow`) exactly as they were.
- **No vault** (`vault status --keystore <missing file>`): exit 1, `VAULT_MISSING`, with
  `details.path` and `details.pathSource`. The read doesn't create the file.
- **`tee rename --json` needs stdout to be a terminal too.** With stdout in a file it refuses before
  asking (`VAULT_UNLOCK_FAILED`, "needs a terminal"), which is what the CLI's source said
  (`requireTty`). At a terminal it renames on Candle and in the vault (`server` and `vault`:
  `renamed`).
- **`keys update --embedded-wallet allow` on a key that already has it** answers `direction:
  "unchanged"` with `dryRun: true`, and asks nothing.
- **An unknown profile** is `PROFILE_UNRESOLVED`, exit 1. Its suggestion lists the machine's profiles.
