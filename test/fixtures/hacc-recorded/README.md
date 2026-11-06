# Hacc, recorded

Hacc's real answers (`api.hacc.fun`), recorded on 2026-10-29 by `test/record-hacc.ts` with a Read key
on a throwaway Max account, then scrubbed by `scripts/scrub-hacc.ts`.

- **Kept:** routes, queries, statuses, timings, real sizes (`bytes`), field names, Hacc's own enums and
  messages, numbers and times.
- **Replaced:** every address, transaction hash and cursor (`HaccFake…`, `0xfa4e…`), and all third-party
  text: signal summaries, wallet labels and owners, X handles and links, group, token and narrative
  names (`fake-<field>-<n>`). Arrays keep five rows; `truncated` says how many there were.
- **Not recorded:** Free and Pro (the account is on Max), a replay that finished, and a cap's `429` on
  follows or rules. `test/fake-hacc.ts` takes those from Candle's docs and says so.

`test/hacc-recorded.test.ts` keeps the fake in step: every read the tools use answers from the fake
with every field recorded here.

**`research/`** (2026-10-30): the `research` phase of `test/record-hacc.ts`, scrubbed the
same way. For JUP and for a token nine minutes old: top traders, profile, launch overview, market,
mentions, and the token's own signals (`/v1/signals?asset=<mint>`, not in the first recording). Then the
tape by each pattern at 50 rows, with and without `quality=all`, for Signals' read-back. The fake
answers the launch overview from `research-young-launch-overview` (the first recording's had no phases), and filters
its tape by `pattern`, `chain` and `asset` (a mint or Hacc's asset id).
