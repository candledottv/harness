# CLI 0.13.28 catch-up evidence

Harness 0.6.1 targets Candle CLI 0.13.28 (MCP 0.10.33 released, 0.10.34 in source) from
`candledottv/candle-monorepo@940055a9819283d721a313e9e39003f566663e6f`.
This is source parity, not proof of a published release or deployed server behavior.

## Refreshing the contracts without external requests

From the Harness root, with Bun 1.4.4 and dependencies installed in both checkouts:

```sh
bun scripts/read-cli-source.ts <source>/packages/cli/src <source-sha> candledottv/candle-monorepo > src/core/cli-source.json
bun scripts/read-mcp-source.ts <source>
bun scripts/read-candle-contracts.ts <source>
bun scripts/cli-parity.ts
bun run typecheck
```

The MCP recorder makes a real MCP initialize/tools-list exchange in memory. It uses no
real key, disables global fetch, calls no tools, and uses a local eligibility stub to include
the four conditional profile tools. The contract recorder injects local response stubs into
the actual MCP/SDK functions; unexpected requests fail. Its perps build request is intercepted
by a local refusal before any build, signature or submission. Nothing reaches Candle, hacc,
Hyperliquid, an RPC, a model or an upload service.

The source SHA, CLI version and method are recorded in `candle-tools.json` and
`src/core/launch-quotes.json`; `candle-source-contracts.json` records each input, request
method/path and outcome. These are deliberately labeled source/synthetic fixtures. The
historical live recordings keep their original versions and provenance.

## Changes checked since 2026-11-12

| Source change | Harness behavior and evidence |
| --- | --- |
| #3747 signal records | Three MCP tools classified as reads, CLI rows added, real descriptions/schemas refreshed. Results are relayed with the measured-record disclaimer. |
| #3783/#3786 quote selection and launch checks | Both launch tools accept `check` and `quote`; a check is a read in paper/live. Old server schemas refuse these controls before forwarding. Fixed quotes bind the seed's asset and chain; new quotes and chain/selection conflicts refuse before a card or preview. MCP and SDK admission/refusal cases are recorded. |
| #3840 quote state and Hood fee output | Refreshed market tool documents quoteAsset, quoteAssets and quoteState (paused/split/launchBlocked). Read bodies and errors pass through unchanged; paused/split checks never become launch cards. CLI fee-claim output remains the CLI's own output. |
| #3761/#3765 embedded perps and signer ordering | Perps read schemas allow embedded and preserve the requested wallet. Offline source cases show named-wallet refusal before PEM, TEE signer refusal before a build, embedded permission refusal, and embedded reaching the local build stub without a PEM. Harness perps writes retain their existing EVM TEE-only card policy; the refusal now describes that Harness limitation accurately. |
| #3739 transfer via agent/transfer | `transfer --client-id` appears in the source map. Embedded transfer still needs Withdraw access; Harness agent keys do not gain it. Owner funds-out routes remain gated. |
| #3830/#3867 vault preflight/rent floor and --amount | Fresh CLI help/flags preserve `--amount` and `max` guidance from 0.13.28. Owner pane runs the CLI, which owns refusal/exit semantics; no signer or submit logic is copied into Harness. |
| #3842 local-image dry run | Source MCP descriptions now say a dry run checks the file and uploads nothing. Harness launch cards continue requiring URLs; an image upload is a separate explicit card. |
| #3815 ambiguous launch | Existing operation read-back remains in place; no fresh id or automatic resend is added. |
| #3750/#3756/#3762 Hood previews, swap cancel and bridge dry runs | Refreshed flags; swap dry-run stays a read. Cancel/recover stay held because they change persisted operation state. No hold is cleared automatically. |
| #3852 and one-shot receipt/guard work | Added receipt read, explicit hold for MCP recovery, and exclusive operationId passthrough on the agent's own MCP child, preserving held/clearing-condition bodies. |
| #3752 embedded LP | Fresh `--wallet embedded` help/flags; existing LP card gates/scopes remain. |
| #3708 device-code flow | Fresh auth help; owner browser/prompt flow remains outside the agent's view. No code is prefilled by Harness. |
| #3709 key/webhook caps; #3688/#3711 key labels/resume | Current help, dispatch and presets refreshed; owner pane retains CLI responses and errors. No cap or device-session restriction is bypassed. |
| #3698/#3701 permanent bridge/custom curves | Current source map reflects the removed switches; Harness does not add a server enable flag. |
| #3818 test budget and later docs/version-only changes | Source audit only; no runtime Harness contract changed. |

The complete audit command is `git log origin/staging --since=2026-11-12 -- packages/cli packages/sdk packages/mcp`.
The snapshot above contains 36 commits. Source updates after the recorded SHA require another refresh.

## Docs handoff

`docs-0.6.1.patch` contains the four actual generated reference pages and the matching
`apps/docs/harness-version.json` bump to 0.6.1. It is generated against the source SHA above,
not hand-written reference text. Apply from the monorepo root with:

```sh
git apply --unidiff-zero <path-to-harness>/test/fixtures/parity-0.13.28/docs-0.6.1.patch
bun test apps/docs/harness-docs.test.ts
```

Generated with `bun scripts/docs-pages.ts --write <source>/apps/docs/src/content/docs/harness --release v0.6.1`.
Checked with the same script without `--write`, the docs app's seven parity/link tests, and
`git apply --unidiff-zero --check --reverse` against the generated worktree. The docs site is a different
repository; this patch in the single Harness PR does not publish it. Next owner:
Sonnet Engineer, dispatched by orchestrator 2 at 09:20Z for the companion docs PR/review on candle-monorepo.

## npm release verification and runtime minimum

`@candledottv/cli@0.13.28` is published. On 2026-11-17 the registry tarball matched
both its SHA-512 integrity and SHA-1 shasum; npm 10.9.2 `audit signatures` verified the
registry signature. With Node 20.19.0 the published bundle reports CLI 0.13.28 and its
keyless `mcp --read-only` handshake reports MCP 0.10.33 and 19 public tools. Every recorded
public tool definition hashes identically to the current source fixture. The package
identity, integrity, signer key id, entry hash and public tool hashes are recorded in
`../candle-cli-release/cli-v0.13.28-npm.json`. No API key, tool calls or production writes
were used for this public-subset recording.

`MIN_CANDLE_CLI` and `install.sh`'s `CLI_MIN_VERSION` now require 0.13.28. Installer
readiness and update guidance use that requirement. `CLI_TAG` and its checksums still name
the independently verified native 0.13.24 binaries: npm publication does not provide native
checksums or Sigstore bundles, and the native 0.13.28 `latest.json` still returns HTTP 404.
The older native CLI can verify a downloaded Harness signature under the existing trust
chain, but the installer explicitly says it cannot run this Harness and directs the user
to `npm install -g @candledottv/cli@0.13.28`. It never presents the native bootstrap as
meeting the runtime minimum. No npm command runs automatically, and native signature
verification is unchanged. Publishing remains a separately authorized human step.

To reproduce npm verification in a scratch directory (no package scripts):

```sh
npm install --ignore-scripts --no-audit --no-fund --save-exact @candledottv/cli@0.13.28
npm audit signatures
node node_modules/@candledottv/cli/dist/index.js --version
```

## Released-CLI Read-key recording

The released-CLI Read-key capture was supplied on 2026-11-17 by the authorized staging
test session. Its reviewed recorder checked CLI 0.13.28 before starting `candle mcp`;
the handshake reports the distinct MCP version 0.10.33. It performed initialize and
tools/list only against staging.api.candle.tv, using an account:read key that was revoked
immediately afterwards. No tools/call or transaction was performed. The supplied attachment
SHA-256 is `2f8418f8393543271f142a353574e904b0dc5e5e310dbcd95d90f812f3c669df`.

`../candle-cli-release/cli-v0.13.28-read-handshake.json` contains the scrubbed full recording
and its provenance, with separate CLI and MCP version pins. The existing scrubber normalized
the startup banner; every tool definition is unchanged. All 96 definitions match the source
fixture exactly, including the three signal tools. The only four source tools absent from
the capture are the conditional profile-edit tools marked listedAfterKeyCheck. They remain
explicitly source-only; this capture does not pretend that the Read key could list them.
Listing tool definitions does not grant permission to call writes. The contract tests hold
the captured definitions, conditional gap, classification and card arguments to the source.

To repeat the capture on an authorized test machine:

The existing recorder now supports a CLI-only tools/list mode. On the authorized test
machine, supply its Read key through the recorder's existing hidden input (never argv or a
board comment), with a wrapper that runs the verified npm bundle as `candle`:

```sh
bun test/record-candle.ts --tools-only --route cli --cli <verified-cli-wrapper> --out test/fixtures/raw/cli-0.13.28
```

This mode performs initialize/tools-list and the MCP server's normal read-only profile
eligibility check, with no tools/call or optional paper trade. Scrub the raw recording
using `scripts/scrub-recordings.ts` before committing it; preserve the separately marked
conditional profile-tool definitions when reconciling the full fixture.

The delivered Read-key fixture is ready for independent review. Do not paste a key into a
card. Harness implementation does not mint keys or borrow another session's credentials.

## Relay calldata ownership

The follow-up source change in candle-monorepo #3880, at
`6f61eaf272c7585e15fe3b6b257772ab0125fcf7`, adds Hood router selectors
`0xcd6e13f7` / `0xf9e4bab4` and trailer lengths `[0, 32]` to the CLI/shared Relay
constants. A tracked-file search of Harness found no copy of those constants, router
addresses, calldata builders or old-calldata assertions. Harness invokes Candle's CLI/API
for execution and retains its own card and operation gates; it does not decode or sign
Relay router calldata. No Harness constant or assertion needs changing for that source
change. The recorded source snapshot above retains its original SHA and is not relabeled
as including later commits.

## Per-order hide, MCP 0.10.34 (BE-3709)

`candle-tools.json`, `launch-quotes.json` and `candle-source-contracts.json` are re-recorded at
`candledottv/candle-monorepo@a6a801ac679b9879bae979e09d0e8ac8b881c313` (SDK 0.6.23, MCP 0.10.34, CLI 0.13.28), with the
same two scripts. `scripts/read-candle-contracts.ts` now also records 18 `hide-*` scenarios through the real MCP
server (in memory) and SDK client against local stubs. The released CLI 0.13.28 ships MCP 0.10.33, so its
recordings are compared with `../candle-cli-release/source-mcp-0.10.33-tools.json` (the previous source fixture).
#3871 (hide) and #3880 (Relay Hood router calldata, no Harness copy) are the changes since the snapshot above.
