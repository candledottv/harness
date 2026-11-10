# Changelog

What changed in each version of Candle Harness (called the Candle TUI before 0.3.0). Versions follow [semantic versioning](https://semver.org), and each release is listed on [GitHub](https://github.com/candledottv/harness/releases).

## 0.5.3 (2026-11-10)

### Safety and correctness

- **A trade pays from a wallet on its own chain.** A Solana TEE wallet, named or set as the agent's default, was taken to pay for a Hood token: the card could be approved, checked against that wallet's figures, and Candle's CLI refused it only after the press. Now it's refused before any card, saying the wallet's chain and the trade's. The embedded wallet's Solana address named for a Hood trade, or its Hood address for a Solana trade, is refused too, never swapped for the other. `from embedded` still takes the embedded wallet on the trade's chain, and on paper either address is the embedded wallet.

## 0.5.2 (2026-11-10)

Triggers, rules bots, code bots with the Build tab, and the code runner, each through independent code and security reviews. **Update from any earlier version:** see the first line under "Safety and correctness".

### Triggers

- "When this happens, do that", run by the core with its window open or closed: a price or market-cap level (from your entry too), your P&L, Hacc's tape or your own signals, a schedule, a fill, or a call from a script. It trades, notifies you, or wakes an agent. Pro and Max.
- The agent writes each one with you, asking what your words leave open, and proposes it as a card that says whether it runs on its own or asks you each time. Your press saves it.
- A trigger's trades go through the wallet's figures, the agent's limits and the kill switch, which holds its buys and wakes and lets its sells go.
- Triggers keep the core running after you quit; `candle-harness stop` ends it, `candle-harness service install` starts it at login, and keep-awake keeps a Mac from sleeping.
- Notifications while its window isn't in front, and from the core with no window open on a Mac or a Linux desktop.
- `candle-harness ask` sends an agent a message from a script, and `candle-harness trigger` fires an `on call` trigger.

### Rules bots

- A Hacc strategy definition the core runs for you: it buys on Hacc's full tape when its pattern and filters match, and sells each position by its take profit, stop, max hold or trailing exit, with its window open or closed. Pro and Max.
- The agent writes each one with you, offers a wallet of its own first, and proposes it as a card with its worst case and the backtest of its exact definition. Your press starts it, on paper or live, whatever the app's own mode.
- Its buys go through the wallet's figures; its exits sell without a card on any wallet. It keeps its own book from its own fills and sells only its own.
- Pause, stop, flatten and remove, the kill switch holding its entries, and a pace that keeps bots and triggers clear of Candle's circuit breaker.
- The Bots tab, a Bots section in the note when you come back, and notifications: one a bot every 5 minutes at most, folding what it bought and sold, and at once for a stop or a sell that failed or is held.
- A bot buys only on a signal at most 2 minutes old, and takes a slot only once a signal passes its checks.
- Its exits judge only a price read after its buy filled. A token Candle stops pricing says so, its stop and target wait, and its max hold still sells. A sell that fails or is refused, flatten's included, is tried again, and says why once.
- A wallet of its own from the Bots tab, as from the bot's card. A fresh TEE wallet Candle can't sign for yet stays listed, marked, and is refused in those words.

### Code bots and the Build tab

- The Build tab runs your own coding harness (Claude Code, Codex, Grok, OpenCode, Pi or any command), unmodified and signed in as you, in a terminal pane in your bots folder, `~/candle-bots` unless you pick another. The folder holds `AGENTS.md` with the rules every bot runs under, the client, and nine of Candle's bot-building skills; a file you change is never written over.
- A code bot is a program of yours that trades through the core with a token of its own, never a key. Your press on its card saves it; the card approves its run settings and three figures (a trade's, a day's, open at most), not its code, and the core holds every trade to them whatever the code does.
- Its buys go through its figures and the wallet's; its sells of its own run without a card. A buy may carry exits the core holds, which keep selling while the bot is paused, crashed or held by the kill switch.
- The core runs each code bot, restarts it after a crash, gives up after five in ten minutes, keeps its last 5 MB of log with keys taken out, and starts it again with the core. A bot can also run elsewhere on the machine with `candle-harness bots token`.
- `candle-harness build` lets the Build tab's harness read every bot's book, test a bot on paper for up to 30 minutes, and propose one. `candle-harness bots` lists, starts, stops and restarts code bots, and prints their logs.
- Code bots on the Bots tab: their process, figures and today's use, held exits, what the bot says beside the core's count, and their log. A bot's word can fire a trigger: `on bot "<name>" says "<word>"`.
- The bot protocol, and `harness-client.ts`, one file with no dependencies, for Bun or Node 20 and later.

### The code runner

- Off until you turn it on for an agent: then it runs a short script with `python3`, `bun` or `node` in its research folder, held there by the operating system (macOS's sandbox, or Landlock on Linux 6.12 or later), with no network, for 60 seconds at most.

### Safety and correctness

- **Update from any earlier version.** A built binary read `bunfig.toml` and `.env` from the folder it was started in. It reads neither now, the release build checks that, and the code runner's hold starts outside the agent's folder.
- What trades spend (SOL, USDC, ETH, USDG) can't be a trade's token, live or on paper, so a "sell" can't be an unlimited conversion.
- A bot's change takes at once only when it truly narrows: an emptied filter list is wider, a slippage bound under the route's default is a card (and under 0.1% is refused), and an exit change that would sell an open position now is a card.
- A code bot's sells asked for together can't sell more than its own; a request that lands on another's card ends rather than waits; a new bot with a removed bot's name starts with an empty book and day.
- A buy read back by its id sells about what the bot's own spend bought, not the wallet's whole holding.
- A trigger keeps the mode it was approved in: switching to paper leaves a live stop live and says so. A `pnl` trigger carries its own window. A trigger that can't be read shows as not watching, with why, and reads again when it can. A woken turn switches off only its own agent's triggers.
- A stopped turn's calls make no card, and a turn that began on paper is refused once you've gone live under it.
- Enter never approves a card you can't see: not while the screen is too small, and a card that arrives under another waits 1.5 s. A Build card proposed while you type opens without the keys. `ctrl-x` twice kills from the Build tab's terminal and a prompt pane.
- A trade card and its receipt show the token's short address, in amber when that name has been another token here. A bot's card at 80×24 keeps what the press approves. A launch card says what it publishes.
- The kill switch stops first and saves after, and says when its state couldn't be saved. Re-sending a trade is the main window's alone.
- A core that has run for days still opens: closed cards are pruned, lists are bounded, and a window that stops reading is dropped rather than buffered.
- After a restart, a re-sent trade through the CLI runs with your RPC address, which no longer enters cards, operations or the Journal.
- Text from Candle, Hacc, code bots and fetched pages reaches an engine cleaned; a bot's log has control sequences and multi-line keys taken out; the paste log keeps no wallet key or recovery phrase. A pasted hex or base64 keypair, or a labelled recovery phrase, is refused.
- Activity shows the full address of every page an agent fetches.
- The code runner refuses 32-bit-table system calls and new sessions inside a held script, and never grants your home or the Harness's folder to a runtime.
- After an update, the installer, the doctor and the status bar say when the running core is still the old version. `install.sh` can't run half-downloaded. Engines and `candle` are started by full path.
- `candle-harness ask --json`, and a read-only `candle-harness cards` with `--wait`, for scripts and outside agents.
- The agent's memory view shows every line that reaches its prompt, headings included.
- A code bot that fails as it starts no longer takes the core down with it.
- A held exit and a code bot's own sell can't both sell one position. A buy read back by its id is sized only from a price within a minute of it, never past its quote with the slippage bound; with no such price the position is left to you.
- A code bot's folder and the bots folder can't be `/`, your home or the Harness's own folders. A sell trigger's smaller amount or harder-to-reach level is a card. SOL, USDC, ETH, USDG and CNDL only ever name their real mints.
- The core sends one sell of a token at a time per key, counts sells in flight toward Candle's failed-sells stop, and warns you when your sell could be the one that stops the key. Its re-send of a lost exit waits behind the same holds.
- More secret shapes are kept out of logs and the Journal, and the CLI's keyring passphrase is never written or shown.
- In a Build pane, `ask`, `trigger` and attaching as a view are refused, and bot logs reach the harness marked as untrusted data.
- Bun's own variables never reach what the Harness starts. The code runner caps a script's file size and processes and refuses namespaces and other kernel surfaces on Linux; on macOS it stops everything a script started. A held script gets only its three standard streams, and a runtime in a home folder is granted as that file alone. `ps` and `git` are started by full path.
- Triggers' and memory's text reaches the agent fenced, and a trigger's line is part of what you approved. Smaller hardening: `notify-send`, the bots folder's record, the login service's unit and the config folder's permissions.
- Every "sells run with no card" line names the exception, a looser slippage bound; a card behind a pane no longer shows `⏎`.

### Also

- A fresh install shows five tabs: Trade, Cockpit, Research, Bots and Build. Trending, Signals, P&L, Journal and Perps are one tick away in `settings ▾`.
- The agent acts when you message it, and a trigger can wake it, within caps of its own, when something needs its judgment.
- Memory lines you pin are kept word for word.
- Up to three token panes side by side.
- A token name mixing look-alike letters from other scripts carries its short address wherever it's shown, and a stray zero-width joiner no longer shows as a letter.
- A new agent's key on Free is no longer rate-limited by setup's own reads: the core counts Candle's status read and its MCP server's own start as Candle does at CLI 0.13.18, and doesn't read a new key twice in a row. A paper trade Candle refuses says why in words.
- `candle-harness service install` stops and removes the Candle TUI 0.2's login service first, if it's there, so a 0.2 core never runs on the old home; `service status` and the doctor name it. The agent's `tui_triggers` and `tui_bots` are still taken as `harness_triggers` and `harness_bots`, never listed, as the other `tui_*` names are.

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
