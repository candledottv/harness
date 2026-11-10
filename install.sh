#!/usr/bin/env bash
# Candle Harness installer. Puts `candle-harness` beside your `candle`, or in ~/.local/bin, checked twice: its
# SHA-256 against the release's SHA256SUMS and latest.json, and its Sigstore signature against this
# repository's release workflow at the exact tag, with your own `candle verify` (cosign or gh if there's
# no candle to ask). A file that fails either check is never installed. Usage:
#   curl -fsSL https://github.com/candledottv/harness/releases/latest/download/install.sh | bash
#   curl -fsSL https://github.com/candledottv/harness/releases/latest/download/install.sh | bash -s -- --to v1.0.0
#   bash install.sh --from ./release-folder        # a release you downloaded yourself
#
# The Candle Harness needs the Candle CLI (CLI_TAG below). With none, this offers to install it, and only on a yes:
# Candle's own release files for that version, checked against the SHA-256s this script carries before
# anything is put in place, so no cosign is needed. Those SHA-256s were taken from files whose Candle
# signature scripts/pin-cli.ts verified with cosign; the candle's own `candle verify` run here after them
# can't vouch for itself, since it's the file being checked.
#
# Never uses sudo, and never edits your shell's files: when the folder isn't on PATH it prints the line
# to add. Writes only the install folder and a temporary folder it removes.
set -euo pipefail

# The one identity a release is signed as: this repository's release workflow on the release's own tag.
# .github/workflows/release.yaml checks a tag build signs exactly IDENTITY_PREFIX<version>.
REPOSITORY='candledottv/harness'
TAG_PREFIX='v'
IDENTITY_PREFIX='https://github.com/candledottv/harness/.github/workflows/release.yaml@refs/tags/v'
ISSUER='https://token.actions.githubusercontent.com'

# A release with no signature never installs from this script as shipped. The tests and the team's unsigned
# preview bundles run a copy made by scripts/install-switch.ts, in which this reads
# CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING instead.
UNSIGNED_OK=0

# The Candle CLI the Candle Harness's command table was read at (src/setup/doctor.ts MIN_CANDLE_CLI), and the
# SHA-256 of each of its release files this script may install. scripts/pin-cli.ts writes this block
# from Candle's own latest.json, and scripts/install.test.ts holds it to the doctor's minimum.
# BEGIN CLI PINS
CLI_TAG='cli-v0.13.20'
CLI_IDENTITY='https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/cli-v0.13.20'
cli_pin() {
  case "$1" in
    candle-darwin-arm64) echo 'db1ad6665c80bc076b48f21a70d1dc25411c265f2c12636a3c3a7cc8c868d70f' ;;
    candle-darwin-x64) echo 'd8f61c0c9d811231a497ba783934b873c937e4abf35fbc0a81be02fc3c934e8d' ;;
    candle-linux-arm64) echo '130aa317c3870e042338aae090654cad2b66fbb662132c123e6e64fc70b516b0' ;;
    candle-linux-x64) echo '475fcc7212a56ca65651170cec157e794db95ebc6becf539135a222ef4cff49b' ;;
    candle-fido2-darwin-arm64) echo 'a49f09bb6e5131282f0194fabf6585941c03485219da03e43c6818f1bed566b5' ;;
    candle-fido2-darwin-x64) echo '8405279384ecf231a5739ef9154556e4eca2a26684f4ab684366a422508a7255' ;;
    candle-fido2-linux-arm64) echo 'dfb8ccb4299938f88a9a178d097a8dd2e472ecb0ff1f56080887caad85f146e2' ;;
    candle-fido2-linux-x64) echo '839c9288cf9cb95d5dc22e9bb128395322c748377a23d704361843cc9e25b5bd' ;;
    *) echo '' ;;
  esac
}
# END CLI PINS
CLI_VERSION="${CLI_TAG#cli-v}"

VERSION_TAG=""
FROM_DIR=""
BIN_DIR=""
ASSUME_YES=0
SKIP_CLI=0

usage() {
  cat <<EOF
Candle Harness installer
  --to <tag>        Install a specific release (default: the latest), e.g. ${TAG_PREFIX}1.0.0
  --from <folder>   Install from a release folder on this machine, checked the same way
  --bin-dir <dir>   Where to put candle-harness (default: beside candle, else ~/.local/bin)
  --yes             Install or update the Candle CLI without asking, if it's missing or too old
  --no-cli          Don't offer to install or update the Candle CLI
EOF
}

# Set once this run has put the Candle CLI in place: a later refusal then says what stays installed.
cli_installed_now=0
fail() {
  local message="$*"
  if [ "$cli_installed_now" -eq 1 ]; then
    message="${message%; nothing installed}"
    message="${message}; candle-harness wasn't installed. The Candle CLI ${CLI_VERSION} this run installed stays at ${BIN_DIR}/candle"
  fi
  echo "install.sh: ${message}" >&2
  exit 1
}
need_arg() { [ "$2" -ge 2 ] || { echo "install.sh: $1 needs a value" >&2; usage >&2; exit 2; }; }

# Every step runs inside main, called on the script's last line: piped from curl, a download cut short
# is a syntax error or a script that never reaches the call, so it does nothing rather than stopping
# partway. The pins above stay at the top level, where the release workflow and scripts/pin-cli.ts read
# and write them by line. The body isn't indented, so its lines stay as they were.
main() {
while [ $# -gt 0 ]; do
  case "$1" in
    --to) need_arg "$1" "$#"; VERSION_TAG="$2"; shift 2 ;;
    --to=*) VERSION_TAG="${1#*=}"; shift ;;
    --from) need_arg "$1" "$#"; FROM_DIR="$2"; shift 2 ;;
    --from=*) FROM_DIR="${1#*=}"; shift ;;
    --bin-dir) need_arg "$1" "$#"; BIN_DIR="$2"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --no-cli) SKIP_CLI=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done
BIN_DIR="${BIN_DIR/#\~/$HOME}"
FROM_DIR="${FROM_DIR/#\~/$HOME}"

# 0.2's names for this script's variables, still read when the new one isn't set (deprecated).
old_names=""
if [ -z "${CANDLE_HARNESS_RELEASE_BASE_URL:-}" ] && [ -n "${CANDLE_TUI_RELEASE_BASE_URL:-}" ]; then CANDLE_HARNESS_RELEASE_BASE_URL="$CANDLE_TUI_RELEASE_BASE_URL"; old_names="$old_names CANDLE_TUI_RELEASE_BASE_URL"; fi
if [ -z "${CANDLE_HARNESS_CLI_RELEASE_DIR:-}" ] && [ -n "${CANDLE_TUI_CLI_RELEASE_DIR:-}" ]; then CANDLE_HARNESS_CLI_RELEASE_DIR="$CANDLE_TUI_CLI_RELEASE_DIR"; old_names="$old_names CANDLE_TUI_CLI_RELEASE_DIR"; fi
if [ -z "${CANDLE_HARNESS_INSTALL_TTY:-}" ] && [ -n "${CANDLE_TUI_INSTALL_TTY:-}" ]; then CANDLE_HARNESS_INSTALL_TTY="$CANDLE_TUI_INSTALL_TTY"; old_names="$old_names CANDLE_TUI_INSTALL_TTY"; fi
if [ -z "${CANDLE_HARNESS_INSTALL_WINDOWS_MOUNT:-}" ] && [ -n "${CANDLE_TUI_INSTALL_WINDOWS_MOUNT:-}" ]; then CANDLE_HARNESS_INSTALL_WINDOWS_MOUNT="$CANDLE_TUI_INSTALL_WINDOWS_MOUNT"; old_names="$old_names CANDLE_TUI_INSTALL_WINDOWS_MOUNT"; fi
if [ -n "$old_names" ]; then echo "Note:${old_names} read under the CANDLE_HARNESS_ name; the CANDLE_TUI_ names are deprecated."; fi

# 1. The platform. The binaries are Bun builds for macOS 13 or later, and Linux.
os="$(uname -s)"; machine="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "$os isn't supported: the Candle Harness runs on macOS 13 or later, and Linux" ;;
esac
case "$machine" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) fail "$machine isn't supported: the Candle Harness runs on arm64 and x64" ;;
esac
if [ "$os" = "darwin" ] && command -v sw_vers >/dev/null 2>&1; then
  macos_version="$(sw_vers -productVersion 2>/dev/null || true)"
  macos_major="${macos_version%%.*}"
  case "$macos_major" in
    ''|*[!0-9]*) ;;
    *) [ "$macos_major" -ge 13 ] || fail "macOS $macos_version is too old: the Candle Harness needs macOS 13 (Ventura) or later" ;;
  esac
fi
platform="${os}-${arch}"
asset="candle-harness-${platform}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is needed"
fi

# 2. Where the files come from: https only, or a folder on this machine.
if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR" ] || fail "$FROM_DIR isn't a folder"
  release_source="$(cd "$FROM_DIR" && pwd -P)"
else
  release_base="${CANDLE_HARNESS_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases}"
  case "$release_base" in
    https://*) ;;
    *) fail "the release must come over https, not ${release_base}, so nothing was installed; for a folder on this machine, use --from" ;;
  esac
  if [ -n "$VERSION_TAG" ]; then release_source="${release_base}/download/${VERSION_TAG}"; else release_source="${release_base}/latest/download"; fi
fi
# The CLI's files: Candle's own release, or (for an offline test) a folder holding them.
cli_source="${CANDLE_HARNESS_CLI_RELEASE_DIR:-https://github.com/candledottv/cli/releases/download/${CLI_TAG}}"

# $1: a folder or an https:// base; $2: a file name; $3: where to write it; $4 "big" for a binary, which
# shows curl's progress bar on a terminal, since a silent 100 MB download looks hung.
fetch() {
  case "$1" in
    https://*)
      command -v curl >/dev/null 2>&1 || fail "curl is needed"
      local quiet="-s"
      if [ "${4:-}" = "big" ] && [ -t 2 ]; then quiet="--progress-bar"; fi
      curl --proto '=https' --proto-redir '=https' -fSL "$quiet" "$1/$2" -o "$3" ;;
    /*) [ -f "$1/$2" ] && cp "$1/$2" "$3" ;;
    *) fail "files come over https or from a folder, not $1" ;;
  esac
}

tmp="$(mktemp -d)"
created_top=""
staged=""
staged_helper=""
cleanup() {
  rm -rf "$tmp"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
  if [ -n "$staged_helper" ]; then rm -f "$staged_helper"; fi
  # Folders this run made and left empty go too, so a refusal leaves the machine as it was.
  if [ -n "$created_top" ]; then
    local dir="$BIN_DIR"
    while rmdir "$dir" 2>/dev/null && [ "$dir" != "$created_top" ]; do dir="$(dirname "$dir")"; done
  fi
}
trap cleanup EXIT

# Answers come from the terminal, since stdin is this script when it's piped from curl.
# CANDLE_HARNESS_INSTALL_TTY moves where they're read from, for the installer's own tests.
ask() {
  if [ "$ASSUME_YES" -eq 1 ]; then echo "$1 yes (--yes)"; return 0; fi
  local answer=""
  { exec 3<"${CANDLE_HARNESS_INSTALL_TTY:-/dev/tty}"; } 2>/dev/null || { echo "$1 No: there's no terminal to answer on (run this again with --yes to say yes)."; return 1; }
  printf '%s [y/N] ' "$1"
  IFS= read -r answer <&3 || answer=""
  exec 3<&-
  case "$answer" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

version_of() { "$1" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true; }
# 0 when $1 is $2 or later; both are three numbers.
at_least() {
  local a b c x y z
  IFS=. read -r a b c <<< "$1"
  IFS=. read -r x y z <<< "$2"
  [ "$a" -ne "$x" ] && { [ "$a" -gt "$x" ]; return; }
  [ "$b" -ne "$y" ] && { [ "$b" -gt "$y" ]; return; }
  [ "$c" -ge "$z" ]
}

# A folder is the user's when they own it and can write to it. One that doesn't exist yet is, when the
# nearest folder above it that does is.
is_users() {
  local dir="$1"
  while [ ! -e "$dir" ]; do dir="$(dirname "$dir")"; done
  [ -d "$dir" ] && [ -O "$dir" ] && [ -w "$dir" ]
}

# 3. The Candle CLI, first: the signature check below uses it. On WSL, Windows' own PATH comes after
# Linux's (/mnt/c/…), and a candle there is Windows' (npm's shim, say): this Linux machine can't use or
# update it, and its folder isn't for candle-harness. It's skipped, and said. Said first: on a fresh Mac the
# first run of each tool can take seconds, and a silent installer read as hung.
echo "Checking this machine for the Candle CLI…"
is_wsl=0
if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then is_wsl=1; fi
windows_mount="${CANDLE_HARNESS_INSTALL_WINDOWS_MOUNT:-/mnt}"
candle_path=""
windows_candle=""
IFS=: read -r -a path_dirs <<< "$PATH"
for dir in "${path_dirs[@]}"; do
  [ -n "$dir" ] || continue
  if [ "$is_wsl" -eq 1 ]; then
    case "$dir" in "$windows_mount"/[a-zA-Z]|"$windows_mount"/[a-zA-Z]/*)
      if [ -z "$windows_candle" ] && [ -f "$dir/candle" ]; then windows_candle="$dir/candle"; fi
      continue ;;
    esac
  fi
  if [ -f "$dir/candle" ] && [ -x "$dir/candle" ]; then candle_path="$dir/candle"; break; fi
done
if [ -n "$windows_candle" ]; then echo "Skipping Windows' candle at ${windows_candle}: on WSL the Candle Harness needs the Linux CLI."; fi
candle_version=""
candle_native=0
if [ -n "$candle_path" ]; then
  candle_version="$(version_of "$candle_path")"
  # Homebrew's and npm's candle are theirs to update, and their folders aren't for candle-harness.
  candle_real="$candle_path"
  if [ -L "$candle_path" ]; then candle_real="$(readlink "$candle_path")"; fi
  case "$candle_real" in
    */Cellar/*|/opt/homebrew/*|/home/linuxbrew/*) ;; # scrub-ok: Homebrew on Linux installs there
    # npm's candle is a script run by node.
    *) head -n 1 "$candle_path" 2>/dev/null | grep -q '^#!.*node' || candle_native=1 ;;
  esac
fi

# Where candle-harness goes: beside the user's own candle, else ~/.local/bin; checked before anything is
# written, so a folder that isn't the user's leaves the machine unchanged.
if [ -z "$BIN_DIR" ]; then
  if [ "$candle_native" -eq 1 ] && is_users "$(dirname "$candle_path")"; then BIN_DIR="$(dirname "$candle_path")"; else BIN_DIR="$HOME/.local/bin"; fi
fi
case "$BIN_DIR" in /*) ;; *) BIN_DIR="$PWD/$BIN_DIR" ;; esac
is_users "$BIN_DIR" || fail "$BIN_DIR isn't yours to write to (it must be a folder you own), so nothing was installed. Choose one with --bin-dir"

make_bin_dir() {
  if [ ! -d "$BIN_DIR" ]; then
    created_top="$BIN_DIR"
    while [ ! -e "$(dirname "$created_top")" ]; do created_top="$(dirname "$created_top")"; done
    mkdir -p "$BIN_DIR"
  fi
}

# Installs Candle's CLI at CLI_TAG into BIN_DIR: each file checked against its pin, then put in place.
# Fails with nothing installed. The pin is the check; that candle's `candle verify` of itself and its
# helper after it only catches a release whose own verifier disagrees with it.
install_cli() {
  local bin="candle-${platform}" helper="candle-fido2-${platform}" name pin
  echo "Downloading the Candle CLI ${CLI_VERSION} (about 100 MB)…"
  for name in "$bin" "$helper"; do
    pin="$(cli_pin "$name")"
    [ -n "$pin" ] || fail "this installer carries no checksum for ${name}; nothing installed"
    fetch "$cli_source" "$name" "$tmp/$name" big || fail "couldn't fetch ${name} from ${cli_source}; nothing installed"
    fetch "$cli_source" "$name.sigstore.json" "$tmp/$name.sigstore.json" || fail "couldn't fetch ${name}'s signature from ${cli_source}; nothing installed"
    [ "$(sha256 "$tmp/$name")" = "$pin" ] || fail "${name} isn't the file Candle released as ${CLI_TAG} (its SHA-256 differs from this installer's); nothing installed"
  done
  make_bin_dir
  # Staged in the install folder, which a temporary folder mounted noexec can't stop running.
  staged="$(mktemp "$BIN_DIR/.candle.new.XXXXXX")"
  cp "$tmp/$bin" "$staged"
  chmod 755 "$staged"
  for name in "$bin" "$helper"; do
    "$staged" verify "$tmp/$name" --bundle "$tmp/$name.sigstore.json" --identity "$CLI_IDENTITY" --issuer "$ISSUER" >/dev/null \
      || fail "${name} doesn't carry Candle's signature for ${CLI_TAG}; nothing installed"
  done
  staged_helper="$(mktemp "$BIN_DIR/.candle-fido2.new.XXXXXX")"
  cp "$tmp/$helper" "$staged_helper"
  chmod 755 "$staged_helper"
  mv -f "$staged_helper" "$BIN_DIR/candle-fido2"
  mv -f "$staged" "$BIN_DIR/candle"
  staged=""
  staged_helper=""
  created_top=""
  candle_path="$BIN_DIR/candle"
  candle_version="$CLI_VERSION"
  cli_installed_now=1
  echo "Installed the Candle CLI ${CLI_VERSION} to ${BIN_DIR}/candle, checked against the SHA-256s this installer carries for Candle's release."
}

cli_note=""
if [ -z "$candle_path" ]; then
  echo "The Candle CLI isn't installed, and the Candle Harness needs it (${CLI_VERSION})."
  if [ "$SKIP_CLI" -eq 0 ]; then
    echo "This can install Candle's CLI ${CLI_VERSION} into ${BIN_DIR}, from Candle's release on GitHub, checked against the SHA-256s this installer carries for it."
    if ask "Install the Candle CLI now?"; then install_cli; fi
  fi
  if [ -z "$candle_path" ]; then
    # This installer's own route, pinned and checked, rather than a pipe to another script.
    cli_note="Install the Candle CLI before running the Candle Harness: run this installer again with --yes, which installs Candle's CLI ${CLI_VERSION}, checked against the SHA-256s it carries."
  fi
elif [ -z "$candle_version" ] || ! at_least "$candle_version" "$CLI_VERSION"; then
  echo "Your Candle CLI (${candle_path}) is ${candle_version:-an unknown version}; the Candle Harness needs ${CLI_VERSION}."
  if [ "$SKIP_CLI" -eq 0 ] && ask "Run candle update --to ${CLI_TAG} now?"; then
    # The CLI's own updater, signed and checked by the CLI itself; for Homebrew or npm it says what to run.
    "$candle_path" update --to "$CLI_TAG" </dev/null || true
    candle_version="$(version_of "$candle_path")"
  fi
  if [ -z "$candle_version" ] || ! at_least "$candle_version" "$CLI_VERSION"; then
    cli_note="Update the Candle CLI to ${CLI_VERSION} before running the Candle Harness: candle update --to ${CLI_TAG}"
  fi
else
  echo "The Candle CLI ${candle_version} is already installed, at ${candle_path}."
fi
candle_ready=0
if [ -n "$candle_path" ] && [ -n "$candle_version" ] && at_least "$candle_version" "$CLI_VERSION"; then candle_ready=1; fi

# 4. The release: latest.json names its version and tag, both checked before they pin anything.
fetch "$release_source" latest.json "$tmp/latest.json" || fail "couldn't fetch latest.json from ${release_source}"
manifest="$(tr -d '[:space:]' < "$tmp/latest.json")"
version="$(printf '%s' "$manifest" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
tag="$(printf '%s' "$manifest" | sed -n 's/.*"tag":"\([^"]*\)".*/\1/p')"
# The version becomes part of the identity the signature must carry, so it's checked, never trusted.
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "latest.json's version isn't a version: ${version}; nothing installed"
[ "$tag" = "${TAG_PREFIX}${version}" ] || fail "latest.json names version ${version} but tag ${tag}; nothing installed"
if [ -n "$VERSION_TAG" ] && [ "$VERSION_TAG" != "$tag" ]; then fail "asked for ${VERSION_TAG}, but the release found is ${tag}; nothing installed"; fi
identity="${IDENTITY_PREFIX}${version}"

# 5. The checksum: SHA256SUMS and latest.json must both name this file's bytes.
fetch "$release_source" SHA256SUMS "$tmp/SHA256SUMS" || fail "couldn't fetch SHA256SUMS from ${release_source}"
case "$release_source" in https://*) echo "Downloading candle-harness ${version} (about 100 MB)…" ;; esac
fetch "$release_source" "$asset" "$tmp/$asset" big || fail "the release has no ${asset} at ${release_source}"
fetch "$release_source" "$asset.sigstore.json" "$tmp/$asset.sigstore.json" || touch "$tmp/no-bundle"
actual="$(sha256 "$tmp/$asset")"
expected_sums="$(awk -v a="$asset" '$2 == a {print $1}' "$tmp/SHA256SUMS")"
expected_manifest="$(printf '%s' "$manifest" | sed -n "s/.*\"${asset}\"[^}]*\"sha256\":\"\([0-9a-f]*\)\".*/\1/p")"
[ "$actual" = "$expected_sums" ] || fail "${asset}'s SHA-256 is ${actual}, but SHA256SUMS says ${expected_sums:-nothing}; nothing installed"
[ "$actual" = "$expected_manifest" ] || fail "${asset}'s SHA-256 is ${actual}, but latest.json says ${expected_manifest:-nothing}; nothing installed"

# 6. The signature, pinned to this repository's release workflow at exactly this tag. --identity and
# --issuer are always passed: without them candle verify takes the identity from a latest.json beside
# the bundle, which is the release's own file.
verified_by=""
if [ -f "$tmp/no-bundle" ]; then
  [ "$UNSIGNED_OK" = "1" ] || fail "the release has no signature for ${asset}; nothing installed"
elif [ "$candle_ready" -eq 1 ]; then
  out="$("$candle_path" verify "$tmp/$asset" --bundle "$tmp/$asset.sigstore.json" --identity "$identity" --issuer "$ISSUER" 2>&1)" \
    || { echo "$out" >&2; fail "${asset} isn't signed by ${identity}; nothing installed"; }
  verified_by="candle verify"
elif command -v cosign >/dev/null 2>&1; then
  out="$(cosign verify-blob --new-bundle-format --bundle "$tmp/$asset.sigstore.json" --certificate-identity "$identity" --certificate-oidc-issuer "$ISSUER" "$tmp/$asset" 2>&1)" \
    || { echo "$out" >&2; fail "${asset} isn't signed by ${identity}; nothing installed"; }
  verified_by="cosign"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  out="$(gh attestation verify "$tmp/$asset" --repo "$REPOSITORY" --cert-identity "$identity" 2>&1)" \
    || { echo "$out" >&2; fail "${asset} isn't signed by ${identity}; nothing installed"; }
  verified_by="gh"
fi
if [ -z "$verified_by" ]; then
  if [ "$UNSIGNED_OK" != "1" ]; then
    if [ -z "$candle_path" ]; then why="The Candle CLI wasn't installed"; else why="The Candle CLI here is ${candle_version:-an unknown version}, older than ${CLI_VERSION}"; fi
    fail "${why}, and nothing else here can check ${asset}'s signature, so nothing was installed. The Candle CLI ${CLI_VERSION} checks it: run this again and answer yes (or pass --yes)"
  fi
  echo "Warning: ${asset}'s signature wasn't checked (CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING=1, for testing only); its checksum matched."
fi

# 7. Into place: staged in the install folder, so the last step is a rename on one filesystem.
make_bin_dir
staged="$(mktemp "$BIN_DIR/.candle-harness.new.XXXXXX")"
cp "$tmp/$asset" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$BIN_DIR/candle-harness"
staged=""
created_top=""
echo "Installed candle-harness ${version} to ${BIN_DIR}/candle-harness${verified_by:+, signature checked by ${verified_by}}."
"$BIN_DIR/candle-harness" --version || { echo "install.sh: ${BIN_DIR}/candle-harness is in place but didn't run" >&2; exit 1; }

# A core started by the version this replaced keeps running that version: one a trigger, a bot or the
# login service holds open doesn't end when the window closes. It's said, never stopped from here, since
# stopping it stops what it's watching.
running_core="$("$BIN_DIR/candle-harness" version --core 2>/dev/null </dev/null | sed -n 's/^core \([0-9][0-9.]*\)$/\1/p' | head -1 || true)"
if [ -n "$running_core" ] && [ "$running_core" != "$version" ]; then
  echo "A core from ${running_core} is still running, with its triggers and bots. It carries on as ${running_core} until it's restarted: open candle-harness and choose restart it in its status bar."
fi

# The Candle CLI's `candle tui` still runs a binary named candle-tui (the 0.2 name): a link to this one beside
# it, so it opens Candle Harness. Deprecated: it goes once the CLI runs candle-harness itself. An old link is
# removed first (mv onto a link to a folder would drop the new link inside that folder); a file is replaced only
# when it's 0.2's own binary; a folder, or anything else of that name, is left alone and said.
tui_link="$BIN_DIR/candle-tui"
tui_replace=0
if [ -L "$tui_link" ]; then
  rm -f "$tui_link" && tui_replace=1
elif [ ! -e "$tui_link" ]; then
  tui_replace=1
elif [ -f "$tui_link" ] && "$tui_link" --version 2>/dev/null | grep -q '^candle-tui 0\.'; then
  tui_replace=1
fi
if [ "$tui_replace" = 1 ]; then
  link="$BIN_DIR/.candle-tui.link.$$"
  rm -f "$link"
  ln -s candle-harness "$link" && mv -f "$link" "$tui_link" \
    && echo "Linked ${tui_link} to candle-harness, so candle tui opens it. The candle-tui name is deprecated and goes in a later release."
  rm -f "$link"
elif [ -d "$tui_link" ]; then
  echo "Left ${tui_link} as it is: it's a folder, so candle tui won't open Candle Harness until the Candle CLI runs candle-harness."
else
  echo "Left ${tui_link} as it is: it isn't Candle TUI 0.2's binary, so candle tui won't open Candle Harness. Remove it and run this again to link it."
fi

other="$(command -v candle-harness 2>/dev/null || true)"
if [ -n "$other" ] && [ "$other" != "$BIN_DIR/candle-harness" ]; then
  echo "Note: another candle-harness comes first on PATH, at ${other}. Remove it, or put ${BIN_DIR} ahead of it."
fi
other_tui="$(command -v candle-tui 2>/dev/null || true)"
if [ -n "$other_tui" ] && [ "$other_tui" != "$BIN_DIR/candle-tui" ]; then
  echo "Note: another candle-tui comes first on PATH, at ${other_tui}, so candle tui opens that one, not Candle Harness. Remove it, or put ${BIN_DIR} ahead of it."
fi

# 8. PATH: the one line to add, for this shell. Nothing is edited. The line has one `$` only: copied out of
# a page that renders text, `$HOME…$PATH` read as maths lost both and emptied the shell's PATH.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    shown_dir="$BIN_DIR"
    # A literal ~ is the point: it's text for the user's shell file, which expands it there.
    # shellcheck disable=SC2088
    case "$BIN_DIR" in "$HOME"/*) shown_dir="~/${BIN_DIR#"$HOME"/}" ;; esac
    # Quoted only past the ~, so the shell still expands it, and only when a space or the like needs it.
    # shellcheck disable=SC2088
    case "$shown_dir" in
      *[!A-Za-z0-9._/~-]*) case "$shown_dir" in "~/"*) shown_dir="~/\"${shown_dir#"~/"}\"" ;; *) shown_dir="\"${shown_dir}\"" ;; esac ;;
    esac
    echo "${BIN_DIR} isn't on your PATH. Add it with:"
    case "${SHELL:-}" in
      */zsh) echo "  echo 'path=(${shown_dir} \$path)' >> ~/.zshrc && source ~/.zshrc" ;;
      */fish) echo "  fish_add_path ${BIN_DIR}" ;;
      *) echo "  echo 'export PATH=${shown_dir}:\$PATH' >> ~/.bashrc && source ~/.bashrc" ;;
    esac
    ;;
esac

if [ -n "$cli_note" ]; then echo "$cli_note"; fi
echo "Next: candle-harness"
}

# In braces, so no part of this line alone runs anything either.
{ main "$@"; }
