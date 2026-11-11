#!/bin/bash
# A two-chain account for looking at the Harness's Solana-and-Hood screens, with no network and no funds:
# a scratch Harness home whose `candle` is a stand-in (fake-candle) that answers from the files written here.
# Made-up wallets and keys only; nothing here reaches Candle, and the guest's own Harness home is untouched.
#
#   bash two-chain-scene.sh <path to candle-harness> [solana-only]
#
# Then, in the same Terminal window, it prints the one line that opens the view on the scratch home.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${1:?the path to the candle-harness binary to run}"
MODE="${2:-two-chain}"
case "$(uname -s)" in Darwin) FAKE="$KIT/fake-candle-darwin-arm64" ;; *) FAKE="$KIT/fake-candle-linux" ;; esac
[ -x "$FAKE" ] || { echo "no stand-in at $FAKE" >&2; exit 1; }
S="$HOME/m11s"
H="$S/h"
if [ -S "$H/state/core.sock" ]; then
  CANDLE_HARNESS_HOME="$H" "$HARNESS" stop >/dev/null 2>&1 || true
fi
rm -rf "$S"
mkdir -p "$H/state/keys" "$S/cli" "$S/bin" "$H/state/candle/momentum" "$H/state/candle/swing"
chmod 700 "$S" "$H" "$H/state" "$H/state/keys" "$S/cli"
cp "$FAKE" "$S/bin/candle"

# Made-up keys of the real shape, put together here so no key-shaped text sits in this file.
key() { local p="$1"; local pad; pad="$(printf '%*s' $((43 - ${#p})) '' | tr ' ' x)"; printf 'cndl_%s_%s%s\n' live "$p" "$pad"; }
key Momentum > "$H/state/keys/momentum.key"
key Swingkey > "$H/state/keys/swing.key"
chmod 600 "$H/state/keys/"*.key

cat > "$H/config.toml" <<EOF
mode = "live"
activeAgent = "momentum"
[candle]
cliPath = "$S/bin/candle"
[hacc]
enabled = false
[agents.momentum.limits]
perTradeUsd = 10
perDayUsd = 50
[agents.swing.limits]
perTradeUsd = 10
perDayUsd = 50
EOF

HTOK="0x4b1d00000000000000000000000000000000ab1d"
BOT1="TbotOne1111111111111111111111111111111111"
BOT1H="0x9b2e00000000000000000000000000000000d07a"
if [ "$MODE" = "solana-only" ]; then
  TEE="[{\"id\":\"tee-bot-1\",\"address\":\"$BOT1\",\"label\":\"bot-1\",\"boundKeyPrefix\":\"Momentum\",\"lamports\":\"1000000000\"}]"
  HOOD=""
else
  TEE="[{\"id\":\"tee-bot-1\",\"address\":\"$BOT1\",\"label\":\"bot-1\",\"boundKeyPrefix\":\"Momentum\",\"lamports\":\"1000000000\"},{\"id\":\"tee-bot-1-h\",\"address\":\"$BOT1H\",\"label\":\"bot-1-h\",\"boundKeyPrefix\":\"Momentum\",\"chain\":\"hood\",\"wei\":\"2000000000000000\"}]"
  HOOD=",\"evmWei\":\"50000000000000000\",\"ethUsd\":3300,\"evmTokens\":[{\"mint\":\"$HTOK\",\"amountRaw\":\"2400000000000000000000\",\"decimals\":18}],\"markets\":[{\"mint\":\"$HTOK\",\"symbol\":\"HTOK\",\"priceUsd\":0.0025,\"chain\":\"hood\"}]"
fi
for a in momentum swing; do
  printf '{"tier":"max","teeWallets":%s%s}\n' "$TEE" "$HOOD" > "$H/state/candle/$a/fake-candle.json"
done
printf '{"tee":{"wallets":%s},"mcpScripts":["%s","%s"]}\n' "$TEE" "$H/state/candle/momentum/fake-candle.json" "$H/state/candle/swing/fake-candle.json" > "$S/cli/fake-cli.json"

echo "scene ready ($MODE): $S"
echo "HTOK, the made-up Hood token: $HTOK"
echo "open it with:"
echo "  CANDLE_HARNESS_HOME=$H CANDLE_CONFIG_DIR=$S/cli $HARNESS"
