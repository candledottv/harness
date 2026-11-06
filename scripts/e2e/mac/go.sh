#!/bin/bash
# The Mac run's start: run once by the person, in a fresh macOS user's first cmux
# terminal. It records what the user starts with, puts the release in ~/Downloads as a browser would leave it,
# checks that macOS refuses it until the README's step clears the mark, then opens the split the script runs from.
set -u
here=$(cd "$(dirname "$0")" && pwd)
tag=$(cat "$here/TAG")
name="candle-harness-$tag-darwin-arm64"
runs=/Users/Shared/e2e-mac-runs

[ -n "${CMUX_SURFACE_ID:-}" ] || { echo "Run this in a cmux terminal: cmux only takes commands from its own."; exit 1; }
# Not `command -v claude`: every cmux terminal has cmux's own stand-ins for claude, codex, pi and grok on its PATH,
# so Claude Code is looked for where its installer puts it.
if command -v candle >/dev/null || [ -e "$HOME/.local/bin/claude" ] || [ -e "$HOME/.config/candle" ]; then
  echo "This user already has Candle or Claude Code. The run needs a user with neither."; exit 1
fi
(cd "$here" && shasum -a 256 -c SHA256SUMS) || { echo "A file doesn't match its checksum: copy the folder again."; exit 1; }

mkdir -p "$runs/start" && chmod a+rX "$runs" "$runs/start"
{
  date -u +"started %Y-%m-%dT%H:%M:%SZ"; echo "$SHELL"; sw_vers -productVersion; uname -m; cmux --version
  for b in candle candle-harness claude codex grok opencode pi node npm brew; do printf '%-11s' "$b"; command -v "$b" || echo "(none)"; done
} 2>&1 | tee "$runs/start/start.txt"
security dump-keychain 2>/dev/null | grep -i -E 'candle|claude' | sort > "$runs/start/keychain-0.txt"

mkdir -p ~/Downloads && cd ~/Downloads || exit 1
tar -xzf "$here/$name.tar.gz"
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;" "$name/candle-harness-darwin-arm64"
echo
echo "macOS should now refuse the binary. Click Done on its dialog, never Move to Bin."
"./$name/candle-harness-darwin-arm64" --version > "$runs/start/gatekeeper.txt" 2>&1
echo "exit $?" >> "$runs/start/gatekeeper.txt"
# The bundle's README, step 2, as written.
xattr -dr com.apple.quarantine "$name"
"./$name/candle-harness-darwin-arm64" --version 2>&1 | tee -a "$runs/start/gatekeeper.txt"

echo "$CMUX_SURFACE_ID" > "$runs/start/surface"
echo
echo "Opening the lower split, where the run prints what it needs from you."
cmux new-split down --surface "$CMUX_SURFACE_ID" --command "bash $here/drive.sh"
