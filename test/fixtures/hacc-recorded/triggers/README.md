# Recorded Hacc shapes: what triggers read

Hacc's API, read on 2026-11-04 by `test/record-triggers.ts` with a throwaway test account's Read key
(Max). Written from the raw recordings by
`bun scripts/scrub-triggers.ts test/fixtures/raw/triggers-2026-11-04 test/fixtures/hacc-recorded/triggers test/fixtures/candle-recorded/triggers`,
through `scripts/scrub-hacc.ts`'s allowlist: every address, wallet, symbol, id and link is made up, the same
fake wherever the real value appeared; long arrays keep five rows, `truncated` says how many there were, and
`bytes` is the real answer's size.

- `prices-*`: the price read for 1, 10 and 20 tokens, each three times (a fresh read, then the stored
  snapshot), Hood with and without `chain=hood`, an unknown and a malformed address, none, and past 20.
  `prices-refresh-refused` is the answer past Hacc's refresh limit for a set it holds no snapshot of: no prices.
- `tape-filtered-*`: the tape filtered to one stream row's token and pattern, with that row as `streamRow`.
- `reopen-refill-*`: a stream gap refilled by date, oldest first.
- `mine-*`: the account's rules, and personal signals read by the cursor.

Only single reads are here. The measurements built from many reads (how old Hacc's prices are against
Candle's, the tape's two steps, the stream's reopen, the refresh limit, the cursor over an hour) are in the
check's notes. `test/triggers-recorded.test.ts` holds what these showed, and checks the fake answers in their shapes.
