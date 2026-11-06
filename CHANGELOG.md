# Changelog

What changed in each version of Candle Harness (called the Candle TUI before 0.3.0). Versions follow [semantic versioning](https://semver.org), and each release is listed on [GitHub](https://github.com/candledottv/harness/releases).

## 0.3.0 (2026-11-06)

The Candle TUI is now **Candle Harness**, and its repository is [candledottv/harness](https://github.com/candledottv/harness). The guide moved to [docs.candle.tv/harness](https://docs.candle.tv/harness).

### The new name

- The binary is `candle-harness` (was `candle-tui`), and the release files are `candle-harness-<os>-<arch>`. The installer comes from `https://github.com/candledottv/harness/releases/latest/download/install.sh` and checks each file's signature against `candledottv/harness`'s release workflow at the exact tag. Run `candle-harness` to open it.
- Config and state live in `~/.config/candle/harness` (was `~/.config/candle/tui`). On the first start, an existing `~/.config/candle/tui` is copied there whole: `config.toml`, your agents' keys, the journal and every state file, each with its own permissions. The copy is checked file by file against the old folder. Once a start on the new folder has gone well, the old folder is renamed to `~/.config/candle/tui.migrated-<date>`, never deleted, and a line says you may delete it. If 0.2 wrote to the old folder after the copy, it's left exactly as it is. The copy waits while a 0.2 core is still running on the old folder.
- `CANDLE_HARNESS_HOME` names another home folder, and every other `CANDLE_TUI_*` variable is now `CANDLE_HARNESS_*`. Through 0.3.x an old name is still read when the new one isn't set (the new one wins), and the start says once which old names are in use: they're deprecated. The installer does the same for its own.
- The agent's own tools are `harness_history`, `harness_limits`, `harness_view`, `harness_pnl`, `harness_show_wallets`, `harness_name_wallets`, `harness_group_wallets` and `harness_teleport` (were `tui_*`), and its own skills are `harness-memory` and `harness-view`. The old `tui_*` names are still taken on a call through 0.3.x, deprecated and never listed to the agent, and a `tui_*` entry in an agent's `allow` or `deny` list still names the same tools.
- Setup names the Candle CLI profile it makes `candle-harness`; a profile you already use keeps its name, and 0.2's `candle-tui` profile, when no `candle-harness` one exists, is signed in again rather than a second profile made.

### Fixes

- A portfolio read whose wallet list Candle cut off (`walletsComplete: false`, or `complete: false` from a server that doesn't send `walletsComplete`) no longer marks a live TEE wallet as stopped outside the app.
- The kill switch pressed while a re-send is being written down stops the re-send: nothing is sent, and the operation is still read back.
- A CLI card row read back by running it again (`stake add`, `lp add`) is held while the kill switch stops its kind, and run after a resume inside the card's lifetime, as a swap's replay is.
- A card the kill switch stops at approval whose journal row can't be written no longer leaves its operation stuck as submitting, and the day's spend goes back.
- A stopped wallet's on-chain balance read keeps a good SOL balance when the RPC refuses the token read (the public endpoint's rate limit), and says the tokens weren't read.
- An RPC's error text reaches the Wallets pane only as plain text, never with terminal escape sequences.
- A slippage bound that isn't a whole number of basis points from 0 to 10000 is always a card.
- An address from Candle's portfolio that isn't a Solana address is never kept as a stopped wallet or put in a sweep command.
- A trade or swap error with no stage whose code says nothing was sent, but which Candle marks retryable, is read back by its id with the day's spend held, since Candle uses some of those codes for a generic server error too. A rate limit and a key limit stay refused.
- The installer links `candle-tui` only over a link or Candle TUI 0.2's own binary, never through a link to a folder, and names another `candle-tui` that comes first on your PATH.
- An old home folder with no state folder is copied too, and a copy left half-made by a start that died is removed.
- A reused `candle-tui` profile on a host other than Candle's production API is named at sign-in.
- The prompt pane drops 0.2's `CANDLE_TUI_*` variables as it does its own.
- A portfolio read counts its wallet list as whole only when `walletsComplete` is exactly `true`.

## 0.2.10 (2026-11-05)

The first public version. The guide at [docs.candle.tv/tui](https://docs.candle.tv/tui) covers all of it.

### Your agent

- Runs on a coding agent you already use and are signed in to: Claude Code, Codex, Grok, OpenCode or Pi, each held to its own research folder, with your own setup of it kept out. One engine and model per agent, picked with `ctrl-g`.
- Three presets: Quant (Candle's analyst prompt and ten of Candle's skills), Trader, and Bare. Skills of your own, and memory each agent keeps across turns and engines.
- Reads Candle and Hacc for you: the feed, the signal tape, token checks, wallets worth watching, your positions and P&L, plus your follows on Pro and the strategy lab on Max.
- Acts when you message it, and never starts a turn on its own.

### Trading

- Every trade the agent proposes is a card, priced fresh and checked against your limits; one press approves it.
- Typed trades on the input line (`buy $5 of JUP`, `sell 50% JUP`), aliases, and chains of up to five parts, each sent once the one before has filled.
- Paper and live, from the embedded wallet or a TEE wallet, and Candle's CLI commands through the agent or typed, each under its own rule.
- Owner steps and anything that asks for a passphrase run in a prompt pane the agent can't see. Funds go out only on your own word, with a destination check.

### Limits and safety

- Each agent's own limits, held by the TUI, beside Candle's caps on each key, each labelled with who holds it.
- A wallet can trade inside two figures of its own with no card, and a note says what happened while you were away. A trade with a slippage bound looser than the default is always a card.
- The kill switch (`ctrl-x` twice) stops the agent and pauses buys, and keeps your sells one press away.
- The journal records every step, and a trade whose answer was lost is read back, never sent twice.

### The screen

- Eight tabs, each a setting: Trade, Cockpit, Trending, Signals, P&L, Research, Journal and Perps.
- Layouts of your own, linked panes and pins, pop-out into tmux or cmux, the palette (`ctrl-k`), and themes, including one drawn from your terminal's own colours.
- Wallets by name and in groups, and empty token accounts closed from the Wallets pane. A stopped TEE wallet stays on it with what the chain says is still in it, until you sweep it home.

### Setup

- A one-line installer that checks each file's checksum and signature, and offers to install Candle's CLI.
- Guided setup on first run: signing in to Candle, connecting your agent, a vault or the embedded wallet only, the agent's key, limits, and a short tour.
- `candle-tui doctor` checks everything and says what to fix.
