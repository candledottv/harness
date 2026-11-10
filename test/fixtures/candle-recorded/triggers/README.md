# Recorded Candle shapes: what triggers read

Candle's production API, read on 2026-11-04 by `test/record-triggers.ts` with a throwaway test account's
Read key, from a machine with no CLI: the REST routes Candle's MCP tools wrap, as in `feeds-pnl/`. Written by
`scripts/scrub-triggers.ts` through `scripts/scrub-candle-rest.ts`'s allowlist:

- `candle-market-*`: the market read (`candle_get_market`) for JUP, a Hood token, and tokens Hacc's price
  read left unpriced. Public: figures and times are kept, tokens, names and links replaced.
- `entry-pnl-*` and `entry-trades-*`: each agent's P&L and trades, for the average entry of an open position.
  The account's own: every amount is multiplied by one made-up factor and every clock moved by one made-up
  offset, so the books still add up, and prices per token (`avgEntryUsd`) are unchanged. `FakeKey1` is
  agent-a and `FakeKey2` agent-b.

`test/triggers-recorded.test.ts` holds what they showed.
