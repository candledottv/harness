# CLI 0.13.29 source table and docs

The complete command table is read from candle-monorepo
`578db6462d65842c0fdbaf08a37aedf405decee5` (CLI 0.13.29, MCP 0.10.34,
SDK 0.6.23). It includes typed `perps markets --dex`, `agent round`,
`agent positions --orders`, and the source's hide flags. This is source parity;
the signed CLI release capture, runtime minimum and install pins are separate.

`docs-0.6.2.patch` carries the four generated reference pages and the matching
`apps/docs/harness-version.json` pin, against that exact source. From that
monorepo checkout, apply it with `git apply --unidiff-zero <path>/docs-0.6.2.patch`, then check
with `bun scripts/docs-pages.ts <source>/apps/docs/src/content/docs/harness`
from the Harness checkout. Generated with `--write` and `--release v0.6.2`.
The patch is a docs handoff, not a published docs change; the owning project
operator routes its application and review in the docs repository.

The additional perps recorder is `bun scripts/read-perps-source.ts <source>`.
Its 25 scenarios use synthetic data and intercepted requests only. Cross-margin
and leverage-cap refusals are response stubs, not keyed API-route executions.
Existing market recordings and the perps journal fixes stay intact.
