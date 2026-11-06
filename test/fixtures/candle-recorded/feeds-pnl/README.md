# Recorded Candle shapes: lists, P&L and perps

Candle's production API, read on 2026-10-30 by `test/record-candle-data.ts`, with a throwaway test
account's Read key, from a machine with no CLI. So these are the REST routes Candle's MCP tools wrap
(developers/mcp-server.md, the tools table). Each recording names the tool and arguments it stands for. The local server answers with the route's body
unchanged (the recorded `candle_get_market` and `candle_get_portfolio` are the REST bodies), so `answer`
here is that tool's `result`. One difference: the perps market read is the REST route's, which adds
`readAt` and `stale` to what the local tool answers (developers/mcp-server.md, "Hyperliquid perps
reads (hosted)").

Written from the raw recordings by
`bun scripts/scrub-candle-rest.ts test/fixtures/raw/candle-data-2026-10-30 test/fixtures/candle-recorded/feeds-pnl`:

- every address, mint, key prefix, id, label, signature, name, symbol and link is made up, the same
  fake wherever the real value appeared. `FakeKey1` is agent-a and `FakeKey2` agent-b; `FakeKey3` is
  the Read key itself. `zzzzzzzz` was the recorder's own prefix for a key nobody has;
- in the account's own reads (`pnl-*`, `trades-*`, `transactions`, `portfolio`, `perps-overview`),
  every amount is multiplied by one made-up factor and every clock moved by one made-up offset. The
  books still add up, durations are as recorded, and prices per token are unchanged;
- the market reads (the lists, perps markets) keep their figures and times;
- long lists keep their first five rows; `truncated` says how many there were, and `bytes` is the
  real answer's size.

`src/core/recorded-feeds-pnl.test.ts` holds what they showed, and checks the fake answers in their shapes.
