#!/bin/bash
# Packs the Mac run for a test Mac, from the repo root: dist/e2e-mac/ holds the
# bundle under test, the compiled first-run script, go.sh, drive.sh and the run's instructions. Copied whole to /Users/Shared/.
# The bundle is a .tar.gz of one folder, candle-harness-<tag>-darwin-arm64/, holding candle-harness-darwin-arm64 (from
# `bun scripts/build.ts --release <tag>`) and a README for its first run; go.sh unpacks it as a download would be.
#   bash scripts/e2e/mac/pack.sh v1.2.3 <the bundle's path> <the instructions' path> [<the run account's address>]
set -euo pipefail
tag=$1
bundle=$2
brief=$3
account=${4:-}
out=dist/e2e-mac
rm -rf "$out"
mkdir -p "$out"
bun scripts/mac-checks/build.ts --platform darwin-arm64
cp "$bundle" "$out/candle-harness-$tag-darwin-arm64.tar.gz"
cp dist/mac-checks/first-run-darwin-arm64 scripts/e2e/mac/go.sh scripts/e2e/mac/drive.sh "$out/"
cp "$brief" "$out/BRIEF.md"
chmod +x "$out/first-run-darwin-arm64" "$out/go.sh" "$out/drive.sh"
echo "$tag" > "$out/TAG"
# The account the run signs in to, checked at its signed-in step, so a code approved on another account is caught.
[ -z "$account" ] || echo "$account" > "$out/ACCOUNT"
(cd "$out" && sha256sum "candle-harness-$tag-darwin-arm64.tar.gz" first-run-darwin-arm64 go.sh drive.sh $([ -e ACCOUNT ] && echo ACCOUNT) > SHA256SUMS)
cat "$out/SHA256SUMS"
