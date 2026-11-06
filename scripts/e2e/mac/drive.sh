#!/bin/bash
# The Mac run's driver: the first-run script's mac route, in the split go.sh opened. When the script stops for a
# person, it says what to do and Enter carries on; when a step fails, Enter tries it again. Ends with the record.
# Started again by hand (bash drive.sh, in the same split), it picks up a run that hasn't finished.
set -u
here=$(cd "$(dirname "$0")" && pwd)
tag=$(cat "$here/TAG")
runs=/Users/Shared/e2e-mac-runs
surface=$(cat "$runs/start/surface")
fr="$here/first-run-darwin-arm64"

run=$(ls -dt "$runs"/*-mac-* 2>/dev/null | head -1)
if [ -n "$run" ] && ! grep -q '^Finished' "$run/run.md"; then
  "$fr" resume --run "$run"
  code=$?
else
  "$fr" probe --surface "$surface" || { echo; echo "cmux didn't do what the script expects: stop here and report what it printed. Nothing has been installed."; exec zsh -il; }
  # ACCOUNT, when packed: the account the device code must be approved on, checked once signed in.
  account=(); [ -s "$here/ACCOUNT" ] && account=(--account "$(cat "$here/ACCOUNT")")
  "$fr" start --route mac --surface "$surface" --release "$HOME/Downloads/candle-harness-$tag-darwin-arm64" --out "$runs" ${account[@]+"${account[@]}"}
  code=$?
  run=$(ls -dt "$runs"/*-mac-* | head -1)
fi
while [ "$code" -ne 0 ]; do
  echo
  if [ "$code" -eq 3 ]; then read -r -p "Press Enter here once that's done. " _
  else read -r -p "That step failed. Enter tries it again; ctrl-c stops, and the run can be picked up later. " _; fi
  "$fr" resume --run "$run"
  code=$?
done

echo
echo "All steps passed. Writing the record."
# This shell started before the install's PATH line, so ~/.local/bin isn't on its PATH.
export PATH="$HOME/.local/bin:$PATH"
T="$HOME/.config/candle/harness"
cd "$run" || exit 1
{ candle-harness version; candle --version; claude --version; } > versions.txt 2>&1
candle-harness doctor > doctor.txt 2>&1
candle keys list > keys-list.txt 2>&1
security dump-keychain 2>/dev/null | grep -i -E 'candle|claude' | sort > keychain-9.txt
diff "$runs/start/keychain-0.txt" keychain-9.txt > keychain-diff.txt
ls -la "$T" "$T/state" > state.txt
{ grep -rlE 'cndl_(live|test|dvc)_[A-Za-z0-9_-]{9,}' "$T" "$runs" --exclude-dir=keys --exclude=state.json 2>/dev/null; echo "key grep done"; } > key-grep.txt
cp "$T/config.toml" "$T/state/journal.jsonl" "$T/state/onboarding.json" . 2>/dev/null
chmod -R a+rX "$runs"
chmod 600 state.json
echo "Done. It's in $run"
exec zsh -il
