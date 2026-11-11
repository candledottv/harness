# Perps writes in the Candle Harness: design spec

Status: proposal, no code. Tracks BE-3109 (audit finding #11, 2026-11-11). Building waits for Andrew's go.

## 1. Problem

The Harness reads Hyperliquid perps (eleven `candle_perps_*` MCP reads) but every write is held "coming":
`PERPS_LATER` (`src/core/cli-catalogue.ts:121`), 16 rows with `route: "later"` (`src/core/cli-table.ts:243-270`), and
`candle_perps_*` write tools mapped to `notYet` (`src/core/classify.ts:181-193`). The Candle CLI, SDK and API already
serve all of them, and withdraw is on in production. A trader can read a position in the Harness but must leave it to
open, protect or close one. That is the gap this spec closes, without loosening any Harness invariant.

The 16 held rows (the task text said "11 others"; the table has 10 besides the six named, one of them `reduce-only` in
three spellings): `deposit`, `withdraw`, `setup`, `open`, `close`, `cancel`, `modify`, `margin`, `tpsl`,
`schedule-cancel`, `flatten`, `leverage`, `reduce-only`, `reduce-only on`, `reduce-only off`, `thresholds set`.
`perps watch` stays `never`. Status reads (`deposit status`, `withdraw status`) already run.

## 2. Principles (existing Harness rules this must not break)

1. The agent's key is never a funds-out key. `prepareKeysCreate` refuses `transfer:write`/`transfer:bound` ("A key that
   can move funds out never lives in the Candle Harness", `src/core/owner-rows.ts:99,150`).
2. Money-moving or position-changing commands are one-press cards: hash over the final argv, core-minted id, limits,
   kill switch, journal, session block (`src/core/cli-cards.ts` header). Owner steps run in the prompt pane where the
   user answers the CLI's own prompts and the agent only sees how it ended.
3. Getting out is never limited (sells are exempt in `limits.ts`). Risk-reducing perps actions inherit that.
4. The agent may only narrow access without the owner (`less-access` rule); loosening is owner-only.
5. No new surface that parses output we do not own: reuse the CLI as the executor (`candle <argv>` with the agent key),
   as stake, LP and launch cards do. We do not call the API or SDK from the Harness.

## 3. Mirroring: CLI, SDK, API

Each Harness row is a thin wrapper over the same-named `candle perps <cmd>` (CLI source pinned in
`src/core/cli-source.json`, `MIN_CANDLE_CLI` 0.13.20). The CLI is the authority for validation, builder fee, cloid
and signing via the key's EVM TEE wallet and the trading-machine signer. The Harness adds: argv hashing, card UX,
core limits, journal and kill switch. SDK and API are not called directly, so contract changes stay a CLI-version bump
plus a drift test (section 8). Open question for Andrew: confirm with the CLI owners that `--json` output of each write
is stable enough to parse for the journal (fill price, cloid, status).

## 4. Command plan

Card kind `perps` (new `CardRow.kind`), `wallet: "tee"` (EVM TEE wallet only; no embedded wallet), `idFlag` is the cloid
the CLI already mints (verify per command; if a command takes no client id the card's `readBack` is `none` and a lost
answer is the user's call, never a blind rerun).

| Command | Rule / route | Who | Scope the key needs | Confirmation | Stops on kill switch | Limits |
|---|---|---|---|---|---|---|
| `open` | card | agent | `perps:write` | one-press card; shows coin, side, size, notional USD, leverage, market vs limit price, TP/SL, reduce-only | yes | notional counted as a buy against per-trade and per-day |
| `close` | card | agent | `perps:write` | one-press card; shows size or %, reduce-only | no (getting out) | none |
| `tpsl` | card | agent | `perps:write` | one-press; card states the protection gap on a change (CLI cancels old leg first) | no | none; refuse when it would remove the last stop on a levered position unless the user typed it |
| `cancel` | card | agent | `perps:write` | one-press | no | none |
| `modify` | card | agent | `perps:write` | one-press; a size increase counts like `open` | yes | size increase counted |
| `leverage` | card | agent | `perps:write` | one-press; raising leverage on a coin with a position shows liquidation distance | yes when raising; no when lowering | cap max leverage (section 5) |
| `margin` | card | agent | `perps:write` | one-press; add isolated margin counted, mode change refused with a position (CLI already refuses) | yes when adding margin | margin added counted |
| `flatten` | card | agent | `perps:write` | one-press listing every order and position it will touch (up to 100 signed steps); the card is the only gate | no | none |
| `schedule-cancel` | card | agent | `perps:write` | one-press; card warns it cancels protection legs too | no for `--clear`; yes for set | none |
| `setup` | card | agent | `perps:write` | one-press; one-time builder-fee approval, card shows it | yes | none |
| `reduce-only on` | less-access | agent | `perps:write` | at once when typed, one-press from the agent | no | none |
| `reduce-only` (read) / `off` | read / owner | read: agent; off: owner | owner device token | owner pane | n/a | n/a |
| `thresholds set` | owner | owner | owner device token (agent may only tighten as `self`) | owner pane; agent path only for tightening | n/a | n/a |
| `deposit` | card | agent | `perps:write` plus `swap:write` (not in the Trade perps preset, see 5) | one-press; shows asset, USD value, source and destination EVM wallet; Relay quote | yes | counted as a spend against the per-trade and per-day limits, the same as a swap |
| `withdraw` | funds-out | owner only | `perps:withdraw` (never on an agent key) | owner pane: vault unlock plus typed confirm, no `--yes` | yes | see 6 |

Every write also supports the CLI's `--no-submit` dry run, which the card path may run first to render preview figures
for card display; this holds no wallet and uses no limit.

## 5. Key scopes

Existing preset `tradeperps` = `account:read` + `perps:write`; it "cannot fund its own Hyperliquid account" (CLI help).
Needs per command are in the table. Decisions needed:

- Add a Harness-recognised agent preset "Perps" for `keys create --access trade-perps` (already accepted by
  `ACCESS`). It must hold only `account:read` + `perps:write`. Open, close, tpsl, cancel, modify, leverage, margin,
  flatten, schedule-cancel, setup and reduce-only all run on it.
- Deposit: either (a) a second scope set, `Write` + `perps:write` (adds `swap:write`), minted as a custom `--scopes`
  list like `LP_AGENT_SCOPES`, or (b) deposit is an owner pane row like `vault transfer`. Recommendation: (a), since
  deposit moves funds toward a venue the key already controls and swap:write is already allowed in Harness keys; the
  card plus core limits bound it. Alternative if Andrew wants a smaller agent: (b).
- Withdraw: the agent key never carries `perps:withdraw`. Add `perps:withdraw` to `MOVES_FUNDS` in
  `src/core/owner-rows.ts:99` so `keys create --scopes ...perps:withdraw` is refused (today only `transfer:*` is
  listed, so this is a hole to close regardless of whether withdraw ships).
- `doctor` gains a perps line: whether the key holds `perps:write`, whether an EVM TEE wallet is promoted onto it and
  whether a signer is on this machine (these are the CLI's own preconditions).

## 6. Withdraw safety (it is on in production)

Withdraw is the one write that sends funds out of the venue, and Candle already serves it for real money. The Harness
design for it is the most conservative of the set:

1. Owner row, not agent row: `rule: "funds-out"`, `route: "pane"`, `identity: "owner"`, like `vault transfer`
   (`cli-table.ts:467`) and `tee sweep`. The user runs it in the prompt pane with their own CLI profile: vault
   unlock, the CLI's typed confirm, and no `--yes`. The agent can propose it (a card that opens the pane) but never
   sees a passphrase or runs it.
2. No agent key ever holds `perps:withdraw` (section 5), so even a prompt-injected agent cannot withdraw by calling
   the CLI directly with its key.
3. Destination is fixed by the CLI to the key's own Solana or Hood TEE wallet (`--to solana|hood`), never an arbitrary
   address; the Harness `destinations.ts` check is not needed but we assert the argv has no address-shaped value.
4. CLI minimums stand: at least 10 USDC, Relay fees at most 5%, and Hyperliquid's one-time 1 USDC activation fee
   shown on the card. The Harness adds a refusal while a withdrawal is in flight (read `perps positions`/`withdraw
   status`), and a refusal when the kill switch is on.
5. Exit-3 wording ("sent, may still land"): copy `vault transfer`'s so the user never resends blind; the CLI keeps the
   id durable and `perps withdraw status <id>` reads it.
6. Everything journaled with amount, destination wallet and Relay id.

Option kept for Andrew: ship withdraw last, or never from the Harness (the user withdraws in their own terminal and
the Harness only reads `withdraw status`). Recommendation: ship it in the last phase, owner pane only.

## 7. Confirmations and limits

- Opening risk is limited, closing risk is not. `open`, `modify` (size up), `margin` (add), `leverage` (raise) and
  `deposit` are counted. Notional USD is priced from the CLI's market read (mark price at card time, `pricedAt` shown;
  unpriced = card shows "couldn't price it" as it does for trades today).
- New perps settings, per agent, default conservative: `perpsPerTradeUsd`, `perpsPerDayUsd` (notional, separate from
  spot limits so a spot allowance does not fund perps), `perpsMaxLeverage` (default 5x), `perpsMaxOpenPositions`. Zero
  binds, unset means the CLI's own limits only; recommend setting defaults on, not unlimited. Open question: whether
  to put leverage on notional (what Hyperliquid margins) or on margin posted.
- Card for `open`/`leverage` shows liquidation price when the CLI's `market`/`risk` data gives it; it refuses (not
  warns) a card that would put the account into `risk` level `critical` per `perps thresholds`.
- Autonomy: perps writes never use the "no card inside limits" shortcut that spot trades have in `cards.ts:243-297`. Every
  perps write needs a press in v1. Bots (rules and code) cannot place perps orders in v1.
- Kill switch pauses every opening action (table) and keeps closes, cancels, `reduce-only on`, `flatten`.
- Session block and journal: new `perps` journal kind with coin, side, size, notional, cloid, fill, fee.

## 8. Test plan

1. Table and catalogue: flip rows from `later` to their route; update `cli-table.test.ts`, `cli-catalogue.test.ts` (the
   "later release" assertion at line 121 is replaced by per-row assertions); remove `PERPS` from `classify.ts` and
   map each write tool to its card kind; update `cli-tool.ts:244` "Later (perps writes)" text.
2. Drift test (like `classify.drift.test.ts`): every row's flags are a subset of the CLI source's for that command;
   fails on a CLI bump that renames a flag. Bump `MIN_CANDLE_CLI` only after the pinned version is checked.
3. Card unit tests with `test/fake-candle-cli.ts`: argv hash covers every core-added flag; `--no-submit` preview;
   limits (per-trade, per-day, leverage, positions); closes exempt; kill switch stops opens not closes; exit-code
   mapping 0/3/non-zero; lost answer is `rerun`-safe where an id exists.
4. Key-scope tests: `keys create --scopes perps:withdraw` refused; `--access trade-perps` accepted; `perps withdraw`
   refuses an agent identity; `deposit` refused on a key lacking `swap:write` with a clear message.
5. Withdraw: pane row shows the CLI's prompts, no `--yes` ever added, agent can't pass a path/address, in-flight
   withdrawal refused, exit 3 wording.
6. Injection: a tool result or webpage telling the agent to withdraw or raise leverage cannot run without a card or
   the pane; the agent cannot lift its own limits.
7. Integration against Hyperliquid testnet if the CLI supports it; otherwise the fake CLI only, plus a manual checklist
   with a funded throwaway account at tiny size (no production tests in CI; per team rule no live funds in agent runs,
   so the live pass is a human step by Andrew).

## 9. Rollout

Each phase is a PR with an independent review, default off behind a setting (`perps_writes = false`) until the live
check passes.

1. Phase 0 (no feature): close the scope hole, add `perps:withdraw` to `MOVES_FUNDS`; add doctor perps line.
2. Phase 1: risk-reducing, no new exposure: `close`, `cancel`, `tpsl`, `reduce-only on`, `schedule-cancel`, `flatten`.
3. Phase 2: opening exposure: `setup`, `open`, `modify`, `leverage`, `margin`, with the limits and the Perps tab
   surfacing cards.
4. Phase 3: money in: `deposit` (card).
5. Phase 4: money out: `withdraw` (owner pane), `thresholds set`, `reduce-only off`.

Each phase: dogfood by Andrew on a small live account, update README/CHANGELOG and the docs site, release behind the
`perps_writes` setting (see Activation, section 10). Rollback is the setting plus the kill switch; the catalogue falls
back to the existing "coming" text. The default flips only inside Activation's bounds — never "after one release"
unbounded.

Estimate: larger than a day. Roughly 1 to 2 days for phase 1, 3 to 4 for phase 2, 1 to 2 for each of phases 3 and 4,
plus review time. Not started.

## 10. Activation (the `perps_writes` setting)

Where it lives: `config.toml`, as `perps.writes` (`[perps]\nwrites = false`), declared in the Harness's settings
registry — a `SettingDef` in `src/config-settings.ts` (`SETTINGS`, the same table `hacc.enabled` sits in) and read by
`src/config.ts`'s config reader, whose `KNOWN` table gains the `perps` key so a typo is refused. Until Andrew's go
there is no entry and no reader: the setting exists only from Phase 1's PR on.

Every step below has a named owner; no step waits on nobody.

- Turn-on after each phase's merge: same day as the merge, set by the phase's implementing engineer seat (named in the
  phase PR's title, walked from the roster review table; for this spec's phases that start is GLM Engineer unless the
  dispatch names another). They set `perps.writes = true` on their own dogfood install only — production installs stay
  `false` until the production gate below.
- Functional check with the switch ON, one per gate (phase): run by that same engineer seat, in the same session as
  the turn-on, on paper mode plus the CLI's `--no-submit` dry runs; the checklist is section 8's tests 3 to 6 for the
  rows that phase ships. The check's evidence (commands, output) is posted on the phase's card. Gate owner: Andrew —
  perps writes move money, so his bundled go/no-go (section 11, decision 1) is the exception that applies: production
  waits for that decision, not for a timer.
- Production/dogfood turn-on: at the next safe window after a passing check — for Andrew's dogfood account, the next
  session he is at the desk; named watcher for the turn-on: Andrew for dogfood, and for any wider production default
  flip, Andrew again (no agent turns the default on). The setting stays the kill switch after turn-on: `false` pauses
  every opening action exactly as the in-app kill switch does, and the catalogue falls back to "coming".
- Bounded dark period: the default flips to `true` only in the next release after the section 11 go lands and Phase 4's
  production check passes — and at the latest one release after that check. If that window is missed, the last phase's
  engineer seat posts why and the new date on the card; an unbounded "after one release with no issues" wait is not
  allowed. Until the flip, every install that wants perps writes sets `perps.writes = true` by hand.

## 11. Decisions for Andrew

1. Go or no-go, and whether to ship in the phase order above.
2. Deposit as a card with a `Write + perps:write` key (recommended) or as an owner pane row.
3. Withdraw: owner pane in Phase 4 (recommended) or never from the Harness.
4. Default limits: per-trade, per-day, max leverage 5x, max positions.
5. Whether bots may ever place perps orders (spec says no in v1).
6. Confirm the CLI's `--json` outputs are stable enough to parse.
