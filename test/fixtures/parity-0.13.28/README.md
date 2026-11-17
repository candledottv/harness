# CLI 0.13.28 catch-up evidence

Harness 0.6.1 targets Candle CLI 0.13.28 and MCP 0.10.33 from
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
Candle local-Claude (`claude@candle.tv`), for a companion docs PR/review on candle-monorepo.

## Release dependency: do not close BE-3685 yet

`install.sh` and `MIN_CANDLE_CLI` now pin CLI 0.13.24, the newest public release on
2026-11-17 (`releases/latest/download/latest.json`). All eight assets/helpers were independently
verified with `scripts/pin-cli.ts`'s `verifyRelease` and checksum-verified cosign 2.5.2; the
installed pin block and fixture match that verified manifest. The linux-x64 binary's checksum
matched the pin, `--version` reported 0.13.24, and its supported `mcp --read-only` mode completed
a real MCP initialize/tools-list handshake (server 0.10.32, 19 public tools). That recording is
`../candle-cli-release/cli-v0.13.24-tools.json`. No API key or tool calls were used. Normal
keyed MCP startup requires a real Read key; no fake credential was used to bypass it.

CLI 0.13.28 latest.json still returns 404, including from the supported pin script with
cosign available. The worker GitHub wrapper does not permit `candledottv/cli`. This does not
establish that no private release exists. The source parity target remains 0.13.28; the
verified 0.13.24 installer pin does not satisfy that target's release gate.

Next owner: Andrew, the CLI release owner, to provide/publish the signed CLI 0.13.28 release
through an authorized release session. Then the assigned Harness engineer runs
`bun scripts/pin-cli.ts cli-v0.13.28` with cosign, updates `MIN_CANDLE_CLI` and its compatibility
fixtures/tests together, and records tools/list through that verified release using the existing
read-only recorder. Source fixture generation above is not a substitute for this release check.
Harness publishing remains Andrew's separately approved release step; no tag is created by this PR.
