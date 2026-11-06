// The attack surface a reviewer reads the code against: every method on the core's socket, every tool the core
// serves an agent besides Candle's own (which classify.ts holds, every one, against the recorded list), each
// engine's own tools, and every place the app starts a process. audit-surface.test.ts fails when one is added
// to the code without a row here, or a row names one that's gone, so the list can't fall behind the code.

/** Each socket method: what it reaches. Who may call it is server.ts METHOD_ROLES; the test checks the names. */
export const METHODS: Record<string, string> = {
  "core.hello": "the first message: a view token, a harness token or a pane ticket decides the role",
  "core.status": "agents, limits, spend, mode, budget: every agent's, to a harness too",
  "core.usage": "call and read totals for the resource sampler",
  "tools.list": "the tools offered to the caller's agent",
  "tools.call": "runs a tool as the caller's agent: Candle's reads, the core's own tools",
  "cards.propose": "a card from a tool call; a typed trade from a view, which may name another agent",
  "cards.list": "open cards; a harness sees its own",
  "cards.get": "one card; a harness only its own",
  "cards.approve": "runs a card by id and hash",
  "cards.reject": "drops a card",
  "cards.withdraw": "drops the caller's own card",
  "cards.requote": "replaces a card with one at a fresh price, or from another wallet",
  "operations.list": "trades in flight or done; a harness sees its own",
  "operations.get": "one operation; a harness only its own",
  "operations.resolve": "re-sends or abandons an operation whose answer was lost",
  "mode.set": "paper or live",
  "wallets.show": "which wallets the panes show",
  "wallets.name": "renames wallets: the Candle Harness's own names at once, Candle's and the vault's in the pane",
  "wallets.undo": "undoes a rename or a grouping",
  "wallets.group": "wallet groups in wallets.toml",
  "vault.forget": "forgets that this machine had a vault, so owner steps run without the factor",
  "onboarding.get": "setup's progress",
  "onboarding.set": "setup's choices",
  "onboarding.signIn": "opens Candle's device-code sign-in in the pane",
  "onboarding.harness": "opens a harness's own sign-in in the pane",
  "onboarding.test": "one test message on an engine",
  "onboarding.limits": "writes an agent's limits into config.toml",
  "onboarding.paper": "starts on paper",
  "autonomy.set": "a wallet's setting: ask every time, or trade inside two figures with no card",
  "view.link": "the linked token",
  "view.pin": "pins a token pane",
  "view.unpin": "unpins a token pane",
  "view.signals": "a Signals pane's filters",
  "view.pop": "names the pane a popped view shows",
  "view.active": "the view the person last used",
  "view.answer": "a view's answer to the agent's ask to change the screen",
  "view.note": "a note to the agent about what the person picked",
  "view.set": "kept view choices: layout, theme",
  "view.repin": "moves a pin",
  "hacc.undo": "undoes an agent's change on Hacc",
  "pnl.window": "the P&L window",
  "pnl.series": "P&L samples for the chart",
  "journal.query": "the whole journal, searched",
  "journal.rows": "a Journal entry's rows as recorded",
  "away.get": "the last while-you-were-away summary",
  "agent.setActive": "which agent the input line talks to",
  kill: "the kill switch: pauses buys, stops the turn, withdraws buy and swap cards",
  resume: "lifts the kill switch",
  "agent.send": "starts a turn with the person's message",
  "agent.cancel": "stops a turn",
  "engine.models": "an engine's model list",
  "engine.check": "checks an engine again",
  "engine.choose": "an agent's engine and model",
  "preset.choose": "an agent's preset",
  "memory.read": "an agent's memory",
  "memory.delete": "deletes from an agent's memory",
  "skills.read": "the person's skill folders and which are on",
  "skills.set": "turns a skill folder on or off",
  "cli.run": "a candle command typed by the person, under the command table's rule",
  "harness.register": "mints a harness token that lasts until the core stops; only tests call it",
  "pane.spawned": "names the prompt pane's launcher pid for its ticket",
  "pane.redeem": "the launcher's ticket for the exact command, and an agent's key where the row needs one",
  "pane.report": "how the pane's command ended",
  subscribe: "topics; a harness only those not kept for views, and its own cards and operations",
  unsubscribe: "topics",
}

/** The core's own agent tools, beside Candle's: what each reaches. */
export const CORE_TOOLS: Record<string, string> = {
  candle_cli: "the user's candle CLI under the command table: reads at once, the rest as cards or in the pane",
  harness_show_wallets: "which wallets the panes show",
  harness_name_wallets: "renames wallets, with an undo",
  harness_group_wallets: "wallet groups, with an undo",
  harness_view: "the person's last-used view: tabs, layouts as a preview, pins, themes, filters",
  research_read: "a file in the agent's research folder",
  research_list: "a folder in the agent's research folder",
  harness_history: "the agent's own turns, cards and trades from the journal",
  harness_pnl: "the P&L figure for a window",
  harness_limits: "what runs without a card and every limit; or a card that narrows a wallet's setting",
  skill_read: "a skill: Candle's built in, the person's own, and folders the person turned on",
  hacc_signals: "Hacc's signal tape, with the agent's key",
  hacc_token: "a token on Hacc",
  hacc_market: "Hacc's market reads",
  hacc_wallets: "wallets on Hacc, and a watched wallet's book legs",
  hacc_social: "mentions on X by accounts Hacc follows",
  hacc_follows: "the account's follows, rules and groups on Hacc; adds at once, removals as cards",
  hacc_lab: "Hacc's strategy lab: reports, saved strategies, replays",
}

/** Each engine's own tools a turn may offer, held as engine.md and each adapter say. Codex offers no file tool and only its web search. */
export const ENGINE_TOOLS: Record<string, readonly string[]> = {
  claude: ["WebSearch", "WebFetch", "Read", "Write", "Edit"],
  grok: ["read_file", "list_dir", "grep", "write", "search_replace", "todo_write", "web_search", "web_fetch"],
  opencode: ["read", "write", "edit", "multiedit", "apply_patch", "patch", "list", "glob", "grep", "webfetch", "todowrite", "todoread", "invalid"],
  pi: ["read", "write", "edit", "ls", "web_fetch"],
}

/** Every place the app starts a process, by file, in order: what it runs, its arguments' source, and its environment. */
export const SPAWNS: Record<string, readonly string[]> = {
  "src/main.ts": [
    "id -un: the login name, when the environment's USER is missing or unknown",
    "the login shell's lookup (dscl or getent), fixed arguments, when SHELL is missing",
  ],
  "src/shared/child.ts": [
    "candle mcp, one per agent key: the CLI path from config, CANDLE_API_KEY and an allowlisted environment",
    "the candle CLI for one command: argv from the command table, CANDLE_API_KEY where it runs as an agent, an allowlisted environment, its own process group",
  ],
  "src/pane/launcher.ts": [
    "stty -g: the terminal's settings, before the command",
    "stty: the settings put back, after it",
    "the redeemed candle command in the pane, as the user, with the agent's key only where its row needs it",
  ],
  "src/engine/engine.ts": ["an engine's --version, for its check"],
  "src/engine/spawn.ts": [
    "a harness in a terminal of its own, with harnessEnv: no Candle variable or token",
    "an engine turn in its own process group, with the environment the adapter builds",
  ],
  "src/engine/runner.ts": [
    "ps: every process's id, parent and name",
    "ps with environments (-E on macOS, e on Linux): the processes a turn left running, by a marker; only their ids are kept",
  ],
  "src/engine/claude.ts": ["claude --version", "claude auth status --json, for its sign-in"],
  "src/engine/codex.ts": ["codex debug models, in a private home"],
  "src/engine/grok.ts": ["grok models, in a private home"],
  "src/engine/opencode.ts": ["opencode models and opencode auth list, isolated", "opencode serve on 127.0.0.1 for one turn, behind a random password"],
  "src/engine/pi.ts": ["pi --list-models and pi auth check, in a private agent folder"],
  "src/view/attach.ts": ["candle-harness core --exit-when-idle: the view starts its core"],
  "src/view/pane-process.ts": ["candle-harness cli-pane: the prompt pane's launcher, in an embedded terminal"],
  "src/view/popout.ts": ["tmux split-window or cmux new-split with candle-harness view --pane, arguments not through a shell for tmux"],
}

/** What counts as starting a process, line by line, in the app's source. */
export const SPAWN_CALL = /Bun\.spawn(?:Sync)?\(|(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\(/
