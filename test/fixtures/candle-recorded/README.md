# Recorded Candle shapes

Candle's real MCP server, recorded on a separate test machine on 2026-10-26 by
`test/record-candle.ts`: server 0.10.22 started through `candle mcp` (CLI 0.11.41), with three agent
keys on one throwaway account. `agent-a` and `agent-b` are allowed the embedded wallet, and
`agent-denied` is not. The npm package's server (`candle-mcp`) wasn't installed, so its handshakes are
`down`.

The raw recordings aren't in the repo. These were written from them by
`bun scripts/scrub-recordings.ts <raw> test/fixtures/candle-recorded --tools test/fixtures/candle-tools.json`:
every address, id, label, username, balance, price, market figure, timestamp and tx limit is
made up. The shapes, codes, messages and timings are as recorded. Each handshake keeps only the
tool names; the full `tools/list` is `test/fixtures/candle-tools.json`.

`cli-agent-a-candle_token_forensics.json` came later, from a live run (2026-10-27): the
agent wrote one `candle_token_forensics` answer for a token Candle didn't launch, unchanged, into its
research folder. The mint, the deployer and the mint authority are made up (it holds no account
data), and its timing wasn't recorded (`ms: 0`). It showed the report sits under `forensics`.

`src/core/recorded.test.ts` reads these with the core's own parsers, and checks that the fake
server puts every field the core relies on where the real server does.

What they showed:

- **Paper trades are never found by id.** A paper trade writes no ledger row
  (developers/agent-trading.md, "Paper mode"), so `candle_get_operation` answers `JOB_NOT_FOUND`.
- **The portfolio never shows paper positions.** Paper inventory is per key, and only REST reads it
  (`GET /api/v1/trade/agent/paper/inventory`); no MCP tool does.
- **`candle_get_profile_wallets` requires `keyPrefix`.** The recording sent `{}` and got
  `MCP_VALIDATION`.
- **The market read carries `priceUsd`, `marketCap` and `liquidityUsd`,** though
  developers/market-state.md doesn't list them.
- **All 58 tools were listed:** the key passed the start-up check, so the three profile-edit tools
  were there from the start.
