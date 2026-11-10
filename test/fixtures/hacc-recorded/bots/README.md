# Recorded Hacc shapes: what a rules bot reads

Hacc's strategy lab and tape, read on 2026-11-05 by `test/record-bots.ts` with a throwaway test account's Read key
(Max). Written from the raw recordings by
`bun scripts/scrub-bots.ts test/fixtures/raw/bots-2026-11-05 test/fixtures/hacc-recorded/bots`, through
`scripts/scrub-hacc.ts`'s allowlist: every address, wallet, symbol and link is made up, the same fake wherever the
real value appeared; long arrays keep five rows, `truncated` says how many there were, and `bytes` is the real
answer's size. Each name starts `bots-`, so the fake Hacc loads them beside the others.

- `bots-schema-*`: one definition each, replayed over 29 days. Hacc checks the definition before the window, so a
  definition it takes answers `lab_window` and nothing runs; one it refuses answers `"<path>: <message>"`. Each
  recording's `body` is the definition sent.
- `bots-exit-*-start` and `-result`: a replay of new tickers over the same 3 hours with one exit each (take profit,
  stop, max hold, trailing, exit on signal), and exit on signal over a window holding a distribution signal. The
  result keeps the request it answered as `request`.
- `bots-sizing-*`: replays with `base_usd`, a `mult`, an `add`, and three rules together.
- `bots-hour-*`: the replays of one recorded hour of the tape, with filters and without.
- `bots-strategies`, `bots-strategy-runs`, `bots-trades-*`: the account's strategies and runs, and a run's trades
  (paged by `offset`, at most 500). `bots-lab-status`: the lab's status read.
- `bots-tape-*`: the tape by pattern over 3 hours, curated and `quality=all`. `bots-live-*`: the routes a live read
  of trade signals or conviction might sit on, with Hacc's answers.

- `bots-hour-tape`: the recorded hour's full tape (`quality=all`) for new tickers, confluence and large moves, cut to
  what the core's matcher reads, a row as a list of its `columns`: Hacc's id, ms after `from`, the token as the number
  of its made-up address (`fakeAddress` in `scripts/scrub-hacc.ts`), its chain, the wallet groups a replay's
  definition names, the payload's size to the cent and its direction. With each replay of that hour: its definition,
  the signals it entered on and its skips.

The hour's stream as heard, its read-back and the comparison with the core's matcher name real tokens throughout;
their figures are in the check's notes. `test/bots-recorded.test.ts` holds what these
showed, and checks the fake answers in their shapes.
