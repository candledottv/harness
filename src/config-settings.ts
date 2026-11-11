// Every setting in the files you edit by hand: config.toml, layouts.toml, wallets.toml, triggers.toml, bots.toml and a theme of your own.
// Each reader takes its known keys from this table, so a setting can't be added to a reader
// without words here; and the docs' configuration page (scripts/docs-pages.ts) is written from it. Each setting
// carries a short example, which its own reader must take without a word (config-settings.test.ts).
//
// A key is dotted from the file's top: <placeholder> for a name you choose (agents.<name>.preset), [] for a
// list's entries (tabs[].shown), and "<address>" for a quoted key of yours.
import { PANE_IDS } from "./shared/panes"

export type SettingsFile = "config.toml" | "layouts.toml" | "wallets.toml" | "triggers.toml" | "bots.toml" | "theme"

export interface SettingDef {
  file: SettingsFile
  key: string
  /** What it takes, in words: `"paper" or "live"`, `true or false`, a list of folders. */
  type: string
  /** A TOML value when there is one (`"paper"`, `30`, `[]`), else in words. */
  default: string
  /** What it does, in the guide's voice. */
  words: string
  /** A short file setting it, which its reader takes without a word. */
  example: string
}

/** An agent's table needs its limits, so an example of one of its settings carries them. */
const limits = (name: string, perTrade = 25, perDay = 100) => `[agents.${name}.limits]\nperTradeUsd = ${perTrade}\nperDayUsd = ${perDay}\n`
const agent = (line: string) => `[agents.agent-a]\n${line}\n\n${limits("agent-a")}`
const tools = (line: string) => `${limits("agent-a")}\n[agents.agent-a.tools]\n${line}\n`
const wake = (line: string) => `${limits("agent-a")}\n[agents.agent-a.wake]\n${line}\n`
const ROOT = `root = ["row", ["column", 60, "token 50", "activity 50"], "agent 40"]`
const colour = (key: string, words: string): SettingDef => ({ file: "theme", key, type: `a colour, "#rrggbb"`, default: "the base theme's", words, example: `${key} = "#6cb6ff"` })
const reply = (key: string, words: string): SettingDef => ({ file: "theme", key: `reply.${key}`, type: `a colour, "#rrggbb"`, default: "the base theme's", words, example: `[reply]\n${key} = "#9ecbff"` })
/** A trigger as triggers.toml keeps it, with `extra` after its keys. */
const MOON = "MoonFake11111111111111111111111111111111111"
/** A token on Hood, for a trigger's chain: made up, of the address's shape. */
const HOOD_TOKEN = "0x00000000000000000000000000000000000b0b01"
const trigger = (extra = "", again = "false") =>
  `[triggers."MOON < $0.40"]\nagent = "agent-a"\nline = "when MOON < $0.40 sell 50% of MOON"\nexpansion = "when ${MOON} < $0.40 sell 50% of ${MOON}"\non = true\nagain = ${again}\n${extra}`
/** A rules bot as bots.toml keeps it, with `extra` after its run settings. */
const bot = (extra = "") =>
  `[bots.confluence-small]\nagent = "agent-a"\nwallet = "embedded"\nmode = "paper"\nstate = "on"\n${extra}\n[bots.confluence-small.definition]\nchain = "solana"\n\n[bots.confluence-small.definition.entry]\nsource = "pattern"\npattern = "confluence"\n\n[bots.confluence-small.definition.entry.filters]\nmax_mcap_usd = 500000\n\n[bots.confluence-small.definition.exit]\ntake_profit_pct = 100\nstop_loss_pct = 40\n\n[bots.confluence-small.definition.sizing]\nusd_per_trade = 2\nmax_concurrent = 4\n`
/** A code bot as bots.toml keeps it, with `extra` after its figures. */
const codeBot = (extra = "") =>
  `[bots.momentum]\nkind = "code"\nagent = "agent-a"\nwallet = "embedded"\nmode = "paper"\nstate = "on"\nfolder = "/home/you/candle-bots/momentum"\ncommand = ["bun", "run", "bot.ts"]\nperTradeUsd = 2\nperDayUsd = 10\nmaxOpen = 3\n${extra}`
const engine = (key: string, name: string): SettingDef => ({
  file: "config.toml",
  key: `engine.${key}.path`,
  type: "a path, or a name on your PATH",
  default: `"${key}"`,
  words: `Where ${name} is installed. The Candle Harness runs your own install, signed in as you.`,
  example: `[engine.${key}]\npath = "/usr/local/bin/${key}"`,
})

export const SETTINGS: readonly SettingDef[] = [
  // config.toml
  {
    file: "config.toml",
    key: "mode",
    type: `"paper" or "live"`,
    default: `"paper"`,
    words: "The mode a core starts in before you've switched. A fresh install's setup writes `mode = \"live\"` and ends live unless you picked paper during it; a run of setup again keeps the mode you're on. The default is for a config.toml with no mode line. Once you switch, the mode you last picked is kept across restarts.",
    example: `mode = "live"`,
  },
  {
    file: "config.toml",
    key: "activeAgent",
    type: "an agent's name",
    default: "the first agent listed",
    words: "The agent a line without `as <agent>` runs as when the Candle Harness starts. `agent <name>` changes it while the Candle Harness runs.",
    example: `activeAgent = "agent-b"\n\n${limits("agent-a")}\n${limits("agent-b", 10, 50)}`,
  },
  {
    file: "config.toml",
    key: "agents.<name>.limits.perTradeUsd",
    type: "a dollar amount above 0",
    default: "none: every agent sets one",
    words: "The most one of this agent's trades may be worth. The core checks it before a card is made, and refuses a trade over it.",
    example: limits("agent-a"),
  },
  {
    file: "config.toml",
    key: "agents.<name>.limits.perDayUsd",
    type: "a dollar amount above 0",
    default: "none: every agent sets one",
    words: "The most this agent may trade in a day, all its trades together. Set below `perTradeUsd`, it binds first, and the Candle Harness warns of it.",
    example: `[agents.agent-a.limits]\nperDayUsd = 100\nperTradeUsd = 25\n`,
  },
  {
    file: "config.toml",
    key: "agents.<name>.wallet",
    type: `"embedded", or a wallet's name or address`,
    default: "the embedded wallet, when the agent's key may pay from it; else its only TEE wallet",
    words: "The wallet this agent pays from when a trade names none. `from <wallet>` on a trade overrides it, and every card names the wallet that pays. One wallet is the default on its own chain; a trade on the other chain pays as if none were set: from the embedded wallet there where the key may pay from it, else from its only TEE wallet there. For a default on each chain, use the `[agents.<name>.wallet]` table instead.",
    example: agent(`wallet = "embedded"`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.wallet.solana",
    type: `"embedded", or a Solana wallet's name or address`,
    default: "the embedded wallet, when the agent's key may pay from it; else its only Solana TEE wallet",
    words: "This agent's default wallet for a trade on Solana, in place of the one `wallet` line. A trade pays only from a wallet on its own chain, so a Hood wallet here is refused.",
    example: `[agents.agent-a.wallet]\nsolana = "agent-a-tee"\nhood = "embedded"\n\n${limits("agent-a")}`,
  },
  {
    file: "config.toml",
    key: "agents.<name>.wallet.hood",
    type: `"embedded", or a Robinhood Chain wallet's name or address`,
    default: "the embedded wallet, when the agent's key may pay from it; else its only Hood TEE wallet",
    words: "This agent's default wallet for a trade on Robinhood Chain (Hood), in place of the one `wallet` line.",
    example: `[agents.agent-a.wallet]\nhood = "embedded"\n\n${limits("agent-a")}`,
  },
  {
    file: "config.toml",
    key: "agents.<name>.preset",
    type: `"quant", "trader" or "bare"`,
    default: `"quant"`,
    words: "The preset this agent starts on: Quant, an analyst with Hacc's data and Candle's skills; Trader, a plain trading agent; or Bare, the essentials only. The preset you last picked with `ctrl-g` is kept.",
    example: agent(`preset = "trader"`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.tools.shell",
    type: `"off", "everything", or a list of commands`,
    default: `"off"`,
    words:
      "Shell access for this agent. A list runs only a plain command whose words start with an entry's, with nothing joined, piped or substituted. With the shell on, the agent's reads aren't held to its research folder, and cards and limits don't cover what the shell runs. Engines differ here: Codex runs everything or nothing.",
    example: tools(`shell = ["ls", "cat"]`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.tools.run",
    type: `"off", or a list of programs`,
    default: `"off"`,
    words:
      "The code runner for this agent: the programs it may run in its research folder with research_run, each by its name or full path. Each run is held to the folder by the system, with no network, for at most 60 seconds, and its output comes back to the agent. Offered only where the system can hold it (macOS, or Linux 6.12 or later); the model picker and the palette turn it on for the active agent.",
    example: tools(`run = ["python3", "bun", "node"]`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.tools.allow",
    type: "a list of tool names, `*` matching any characters",
    default: "every tool",
    words: "Only these tools are offered to the agent; every other is hidden from it. An empty list offers none.",
    example: tools(`allow = ["candle_*", "research_*"]`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.tools.deny",
    type: "a list of tool names, `*` matching any characters",
    default: "[]",
    words: "These tools are hidden from the agent entirely, even where `allow` names them.",
    example: tools(`deny = ["candle_launch_token"]`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.wake.perHour",
    type: "a whole number from 0 to 1000",
    default: "4",
    words: "How many turns triggers may wake this agent for in an hour. A wake past it is skipped and said; wakes that come while the agent is busy join one turn, which counts once. 0 means triggers never wake it.",
    example: wake(`perHour = 2`),
  },
  {
    file: "config.toml",
    key: "agents.<name>.wake.perDay",
    type: "a whole number from 0 to 1000",
    default: "24",
    words: "How many turns triggers may wake this agent for in 24 hours. A wake past it is skipped and said.",
    example: wake(`perDay = 10`),
  },
  {
    file: "config.toml",
    key: "cards.typedTrades",
    type: `"card" or "instant"`,
    default: `"card"`,
    words: "Whether a live trade you type is a card you approve, or runs at once. \"instant\" covers every one-press card you type, not only trades: a stake, closing empty accounts, an image upload or a token page edit (both public) run at once too. On a wallet set to trade inside limits, a typed trade inside its figures runs at once either way.",
    example: `[cards]\ntypedTrades = "instant"`,
  },
  {
    file: "config.toml",
    key: "pricing.source",
    type: `"auto" or "market"`,
    default: `"auto"`,
    words: "How a card is valued when it's proposed: `auto` uses Candle's quote for the exact trade as soon as Candle offers one, and a fresh market read until then; `market` keeps to market reads.",
    example: `[pricing]\nsource = "market"`,
  },
  {
    file: "config.toml",
    key: "pricing.quoteTool",
    type: "a tool's name",
    default: `"candle_quote"`,
    words: "The name of Candle's quote tool, which `auto` pricing looks for.",
    example: `[pricing]\nquoteTool = "candle_quote"`,
  },
  {
    file: "config.toml",
    key: "trade.spendAsset",
    type: `"sol", "usdc" or "cndl"`,
    default: `"sol"`,
    words: "What a buy sized in dollars (`buy $25 MOON`) spends on Solana, for a token Candle didn't launch.",
    example: `[trade]\nspendAsset = "usdc"`,
  },
  {
    file: "config.toml",
    key: "engine.default",
    type: `"claude-code", "codex", "grok", "opencode" or "pi"`,
    default: `"claude-code"`,
    words: "The engine a new agent starts on. The engine you pick for each agent with `ctrl-g` is kept.",
    example: `[engine]\ndefault = "codex"`,
  },
  {
    file: "config.toml",
    key: "engine.model",
    type: "a model's name, as its engine lists it",
    default: "the engine's own default",
    words: "The model a new agent starts on. The model you pick for each agent with `ctrl-g` is kept.",
    example: `[engine]\nmodel = "gpt-5.5"`,
  },
  engine("claude", "Claude Code"),
  engine("codex", "Codex"),
  engine("grok", "Grok"),
  engine("opencode", "OpenCode"),
  engine("pi", "Pi"),
  {
    file: "config.toml",
    key: "engine.stepCap",
    type: "a whole number above 0",
    default: "30",
    words: "The most steps one of the agent's turns may take before it stops.",
    example: `[engine]\nstepCap = 20`,
  },
  {
    file: "config.toml",
    key: "candle.cliPath",
    type: "a path, or a name on your PATH",
    default: `"candle"`,
    words: "Where Candle's CLI is installed. The Candle Harness runs your own `candle` for the commands that need it.",
    example: `[candle]\ncliPath = "/usr/local/bin/candle"`,
  },
  {
    file: "config.toml",
    key: "candle.profile",
    type: "a CLI profile's name",
    default: "unset: the CLI picks its profile as it always does",
    words: "The Candle CLI profile the Candle Harness acts as. Setup records the one you signed in with, so switching the CLI's active profile elsewhere never moves the Candle Harness to another account.",
    example: `[candle]\nprofile = "candle-harness"`,
  },
  {
    file: "config.toml",
    key: "candle.rpcUrl",
    type: "an https address (plain http only for 127.0.0.1 or localhost)",
    default: "unset: the CLI profile's own",
    words: "The Solana RPC the Candle Harness gives Candle's CLI, for the commands that use one, such as a TEE wallet's trades.",
    example: `[candle]\nrpcUrl = "https://rpc.example.com"`,
  },
  {
    file: "config.toml",
    key: "candle.evmRpcUrl",
    type: "an https address (plain http only for 127.0.0.1 or localhost)",
    default: "unset: the candle CLI's built-in Robinhood Chain RPC",
    words: "The Robinhood Chain RPC the Candle Harness gives Candle's CLI, which reads a Hood TEE wallet's balances and decimals over it. Candle sets every nonce and fee and sends each transaction itself, so this RPC only reads.",
    example: `[candle]\nevmRpcUrl = "https://hood-rpc.example.com"`,
  },
  {
    file: "config.toml",
    key: "candle.mcp.route",
    type: `"cli" or "package"`,
    default: `"cli"`,
    words: "How Candle's MCP server runs for each agent's key: `cli` runs `candle mcp` from `candle.cliPath`; `package` runs the `candle-mcp` package at `candle.mcp.path`.",
    example: `[candle.mcp]\nroute = "cli"`,
  },
  {
    file: "config.toml",
    key: "candle.mcp.path",
    type: "a path, or a name on your PATH",
    default: `"candle-mcp"`,
    words: "Where the `candle-mcp` package is, when `candle.mcp.route` is `package`.",
    example: `[candle.mcp]\npath = "candle-mcp"`,
  },
  {
    file: "config.toml",
    key: "wallets.show",
    type: `"active", "all", "group:<name>", or a list of up to 20 wallets`,
    default: `"active"`,
    words:
      "Which wallets the panes show on a fresh install: the ones a Candle Harness agent can pay from, every one, one of your groups, or the wallets you list by name, address or `embedded`. A wallet the Candle Harness stopped always shows until it's swept. The choice you last made in the Wallets pane is kept.",
    example: `[wallets]\nshow = "all"`,
  },
  {
    file: "config.toml",
    key: "hacc.enabled",
    type: "true or false",
    default: "true",
    words: "Hacc, Candle's market data engine. Off hides every Hacc tool from the agent and closes the signal stream.",
    example: `[hacc]\nenabled = false`,
  },
  {
    file: "config.toml",
    key: "pnl.window",
    type: `"24h", "midnight", "session", or a time of day such as "18:00"`,
    default: `"24h"`,
    words: "The P&L window a fresh install starts on: the last 24 hours, since midnight, since the Candle Harness was last closed, or since a time of day. The window you last picked is kept.",
    example: `[pnl]\nwindow = "midnight"`,
  },
  {
    file: "config.toml",
    key: "skills.from",
    type: "a list of folders, each from / or ~/",
    default: "[]",
    words: "Skill folders of your own, such as Claude Code's `~/.claude/skills`, for the core to read and serve to the agent, which can't read them itself. Where a fresh install starts: the choice you last made in settings ▾ → skills is kept.",
    example: `[skills]\nfrom = ["~/.claude/skills"]`,
  },
  {
    file: "config.toml",
    key: "build.folder",
    type: "a folder, from / or ~/",
    default: `"~/candle-bots"`,
    words:
      "The Build tab's bots folder, where your coding harness writes bots: each bot in a folder of its own, beside the rules every bot runs under, the client, and Candle's bot-building skills. Where a fresh install starts: the folder you last picked in the Build pane is kept.",
    example: `[build]\nfolder = "~/code/candle-bots"`,
  },
  {
    file: "config.toml",
    key: "build.harness",
    type: `"claude-code", "codex", "grok", "opencode", "pi", or a command such as "aider --no-git"`,
    default: "unset: the Build pane asks",
    words:
      "The coding harness the Build tab opens, unmodified and signed in as you: one of the five, by the binary its engine setting names, or a command of your own. Where a fresh install starts: the harness you last picked in the Build pane is kept.",
    example: `[build]\nharness = "claude-code"`,
  },
  {
    file: "config.toml",
    key: "core.keepAwake",
    type: "true or false",
    default: "false",
    words:
      "macOS only: keep the Mac from sleeping while a trigger or bot is on, so a level, a schedule or a bot's exit isn't missed while it sleeps. A closed lid still sleeps a Mac on battery. Where a fresh install starts: the choice you last made in the palette is kept.",
    example: `[core]\nkeepAwake = true`,
  },
  {
    file: "config.toml",
    key: "notify.mode",
    type: `"auto", "native", "osc", "bell" or "off"`,
    default: `"auto"`,
    words:
      "How a notification reaches you. Only while the Candle Harness's window isn't in front: `auto` is your computer's own notification here and the terminal's notification over SSH, and the bell where neither works. `native` is always the computer's, `osc` the terminal's, `bell` the bell alone, and `off` nothing. With no Candle Harness window open, the core sends the computer's own, on a Mac or a Linux desktop; over SSH or on a VPS with no window open, nothing reaches you. Read when the core starts.",
    example: `[notify]\nmode = "bell"`,
  },
  {
    file: "config.toml",
    key: "notify.on",
    type: `a list from "cards", "triggers", "bots", "wakes", "kill", "keys" and "core"`,
    default: `["cards", "triggers", "bots", "wakes", "kill", "keys", "core"]`,
    words:
      "What notifies you: a card waiting that you didn't make (`cards`), a trigger firing (`triggers`), a rules bot's every buy and sell, a bot's trade that waits for you, was refused or failed, and a bot's sell held (`bots`, a bot's trades that come together as one notice), a wake skipped at its agent's cap (`wakes`), the kill switch going on (`kill`), Candle holding a key (`keys`), and the core stopping when nobody asked it to (`core`). Leave one out to stop it. Read when the core starts.",
    example: `[notify]\non = ["cards", "triggers"]`,
  },
  {
    file: "config.toml",
    key: "aliases.<name>",
    type: "the words it stands for",
    default: "none",
    words: "A word that stands for the start of a typed line: `b5 = \"buy $5 of\"` makes `b5 MOON` buy $5 of MOON. An alias can't take a command's own name, such as buy, can't loop, and can't make more than 5 parts.",
    example: `[aliases]\nb5 = "buy $5 of"`,
  },
  {
    file: "config.toml",
    key: "theme.name",
    type: "a theme's name",
    default: `"Candle dark"`,
    words: "The theme a fresh install starts on: Candle dark, Candle light, Terminal, or one of yours by its file's name. The theme you last picked in the palette is kept, until you change this by hand.",
    example: `[theme]\nname = "Candle light"`,
  },

  // layouts.toml
  {
    file: "layouts.toml",
    key: "tabs[].name",
    type: "1 to 20 characters",
    default: "the nine tabs: Trade, Cockpit, Trending, Signals, P&L, Research, Journal, Perps and Bots",
    words: "A tab's name, as the tab bar shows it. Each name is used once.",
    example: `tabs = [{ name = "Desk", layout = "Cockpit" }]`,
  },
  {
    file: "layouts.toml",
    key: "tabs[].layout",
    type: "a layout's name: a preset's, or one of yours",
    default: "each tab's own preset",
    words: "The layout the tab shows. A name that isn't a layout shows Agent-first, and the Candle Harness says which line.",
    example: `tabs = [{ name = "Desk", layout = "Agent-first" }]`,
  },
  {
    file: "layouts.toml",
    key: "tabs[].shown",
    type: "true or false",
    default: "true",
    words: "Whether the tab is on the tab bar. A tab ticked off in settings ▾ stays in the file with `shown = false`, keeping its place and layout. One tab is always shown.",
    example: `tabs = [{ name = "Trade", layout = "Agent-first" }, { name = "Perps", layout = "Perps", shown = false }]`,
  },
  {
    file: "layouts.toml",
    key: "layouts.<name>.root",
    type: "a row or column of panes",
    default: "none: every layout of yours has one",
    words: `The layout's panes: \`["row", …]\` or \`["column", …]\`, then its children. A child is a pane and its weight (\`"token 50"\`), a pane with fixed rows inside a column (\`"agent 8 rows"\`), or another row or column with its weight after it (\`["column", 60, …]\`). The panes: ${PANE_IDS.map((p) => `\`${p}\``).join(", ")}; \`token:2\` and \`token:3\` are more token panes, each pinned on a token of its own while \`token\` follows the link.`,
    example: `[layouts."My desk"]\n${ROOT}`,
  },
  {
    file: "layouts.toml",
    key: "layouts.<name>.collapse",
    type: "a whole number of columns, from 60",
    default: "the width its panes need",
    words: "The terminal width below which the layout collapses to the agent and one switched pane. It can't be below the width the panes need.",
    example: `[layouts."My desk"]\ncollapse = 140\n${ROOT}`,
  },
  {
    file: "layouts.toml",
    key: "layouts.<name>.from",
    type: "a preset's name",
    default: "none",
    words: "The preset the layout was saved from. The Candle Harness writes it, with `from_panes`, so it can offer you a pane that preset has gained since.",
    example: `[layouts."My desk"]\nfrom = "Agent-first"\nfrom_panes = ["agent", "token", "activity"]\n${ROOT}`,
  },
  {
    file: "layouts.toml",
    key: "layouts.<name>.from_panes",
    type: "a list of panes",
    default: "none",
    words: "The panes the preset in `from` had when the layout was saved.",
    example: `[layouts."My desk"]\nfrom = "Agent-first"\nfrom_panes = ["agent", "token", "activity"]\n${ROOT}`,
  },

  // wallets.toml
  {
    file: "wallets.toml",
    key: `names."<address>"`,
    type: "up to 64 characters",
    default: "none",
    words:
      "The Candle Harness's own name for a wallet that neither Candle nor the vault labels, such as the embedded wallet. A name is unique, has no space at either end, and can't be `embedded`, an agent's name, or shaped like an address. The Candle Harness writes this when you name a wallet.",
    example: `[names]\n"Fk3eQ9mW2vT8rYp5LxN7cZ1bH4jS6dGuAa8KqRwEs2Vn" = "main"`,
  },
  {
    file: "wallets.toml",
    key: "groups.<group>.prefix",
    type: "the start of a wallet's name",
    default: "none",
    words: "Every wallet whose name starts with this, in any case, is in the group, as Candle's `bot-*` selects.",
    example: `[groups.bots]\nprefix = "bot-"`,
  },
  {
    file: "wallets.toml",
    key: "groups.<group>.wallets",
    type: "a list of wallets, by name or address",
    default: "none",
    words: "These wallets are in the group, kept by address so a rename never drops one. A group organises wallets; it never pays.",
    example: `[groups.desk]\nwallets = ["main", "embedded"]`,
  },

  // triggers.toml: written by the Candle Harness when you approve a trigger's card, switch one or remove one.
  {
    file: "triggers.toml",
    key: "triggers.<name>.agent",
    type: "an agent's name",
    default: "the agent that proposed it",
    words: "The agent the trigger belongs to: its trades use this agent's key, limits and default wallet.",
    example: trigger(),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.line",
    type: "a trigger's line",
    default: "none",
    words: "The trigger as it was written and approved, with token names and aliases as typed: `when MOON < $0.40 sell 50% of MOON`.",
    example: trigger(),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.expansion",
    type: "a trigger's line",
    default: "none",
    words: "The same line with aliases expanded and token names as mints: what it does when it fires, whatever an alias or a name means later.",
    example: trigger(),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.on",
    type: "true or false",
    default: "true",
    words: "Whether it's switched on. Set it to false to switch it off; it's switched back on in the Triggers overlay, as it was approved.",
    example: trigger(),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.again",
    type: "true or false",
    default: "false",
    words: "For a level: whether it re-arms each time it's crossed back, rather than firing once and switching off.",
    example: trigger(),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.cooldown",
    type: `a duration, such as "30m", "2h" or "1d"`,
    default: `"30m"`,
    words: "The least time between two firings: of the same token, for a tape trigger or one on your personal signals.",
    example: trigger(`cooldown = "2h"\n`, "true"),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.mode",
    type: `"paper" or "live"`,
    default: "the mode it was approved in",
    words: "Whether the trigger's trades are paper or live, whatever mode the Candle Harness is in when it fires. It's set when its card is approved; taking one live is a new card.",
    example: trigger(`mode = "live"\n`),
  },
  {
    file: "triggers.toml",
    key: "triggers.<name>.chain",
    type: `a chain's name, such as "hood"`,
    default: "Solana",
    words: "The chain of the token a trigger watches, where it isn't Solana: its price and market cap are read there. It's set when its card is approved.",
    example: `[triggers."HTOK < $0.002"]\nagent = "agent-a"\nline = "when ${HOOD_TOKEN} < $0.002 notify"\nexpansion = "when ${HOOD_TOKEN} < $0.002 notify"\non = true\nagain = false\nchain = "hood"\n`,
  },

  // bots.toml: written by the Candle Harness when you approve a bot's card, or narrow, pause, stop, resume or remove one.
  {
    file: "bots.toml",
    key: "bots.<name>.agent",
    type: "an agent's name",
    default: "the agent that proposed it",
    words: "The agent the bot belongs to: its trades use this agent's key and limits.",
    example: bot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.wallet",
    type: `"embedded", or a wallet's address`,
    default: "none",
    words: "The wallet the bot pays from and sells from. A wallet of its own keeps its book exact and its risk to what that wallet holds.",
    example: bot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.mode",
    type: `"paper" or "live"`,
    default: "none",
    words: "Whether the bot trades on paper or live, whatever mode the Candle Harness is in. Taking a bot live is a new card.",
    example: bot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.state",
    type: `"on", "paused" or "stopped"`,
    default: `"on"`,
    words: "Paused takes no new entries while its exits still sell; stopped trades nothing, and leaves its positions to you. Setting either here is always taken; a bot goes back on from the Bots tab, as it was approved.",
    example: bot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.maxSlippageBps",
    type: "a whole number of basis points, from 10 to 10000",
    default: "the route's default",
    words: "The bot's own slippage bound, approved on its card: shown in amber where it's looser than the default, or under it, where its sells may not fill. A card takes none under 10.",
    example: bot("maxSlippageBps = 300\n"),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.definition",
    type: "Hacc's strategy definition, as tables",
    default: "none",
    words: "What the bot enters on, how it exits and how much it stakes, in the field names of Hacc's strategy lab, so the same definition backtests on Hacc.",
    example: bot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.kind",
    type: `"code"`,
    default: "a rules bot",
    words: "A program of yours, the Candle Harness runs and holds to its figures, where a rules bot has a definition. Its agent, wallet, mode, state and maxSlippageBps are as a rules bot's.",
    example: codeBot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.folder",
    type: "an absolute path",
    default: "none",
    words: "A code bot's folder: its command runs there. Your code is yours to change; the core holds it to its figures whatever it does.",
    example: codeBot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.command",
    type: "a list of words",
    default: "none",
    words: "What runs a code bot, word by word, in its folder and with no shell. Changing it is a new card.",
    example: codeBot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.perTradeUsd",
    type: "a dollar figure",
    default: "none",
    words: "The most one of a code bot's buys or swaps may spend. Raising it is a new card; lowering it is at once.",
    example: codeBot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.perDayUsd",
    type: "a dollar figure, at least perTradeUsd",
    default: "none",
    words: "The most a code bot's buys and swaps may spend in a day. Raising it is a new card; lowering it is at once.",
    example: codeBot(),
  },
  {
    file: "bots.toml",
    key: "bots.<name>.maxOpen",
    type: "a whole number, from 1 to 100",
    default: "none",
    words: "The most positions a code bot may hold open at once. Raising it is a new card; lowering it is at once.",
    example: codeBot(),
  },

  // A theme of yours: themes/<name>.toml.
  {
    file: "theme",
    key: "base",
    type: `"Candle dark" or "Candle light"`,
    default: `"Candle dark"`,
    words: "The theme yours starts from. Every colour you don't set is its.",
    example: `base = "Candle light"`,
  },
  colour("page", "Behind everything, around the panes."),
  colour("bar", "The status bar, the tab bar and the input line."),
  colour("pane", "Inside a pane."),
  colour("border", "A pane's border."),
  colour("selected", "Behind the highlighted row, card or tab."),
  colour("focus", "The focused pane's border, and an overlay's. Borders only, never text."),
  colour("bright", "The text you act on."),
  colour("text", "Content."),
  colour("dim", "Labels, times and sources."),
  colour("heading", "Pane headings."),
  colour("attention", "Look at this: a waiting card, a near limit, a flag."),
  colour("good", "Filled, and up."),
  colour("bad", "Refused, down, and the kill switch."),
  colour("control", "Anything you can click, drawn as a chip."),
  colour("control_bg", "Behind a chip."),
  colour("control_hover", "Behind a chip under the mouse."),
  colour("bad_bg", "Behind the kill switch's chip, the one red chip."),
  colour("paper_bg", "Behind PAPER in the status bar."),
  reply("heading", "A heading in the agent's reply."),
  reply("bright", "Bold text and addresses in a reply."),
  reply("dim", "A table's labels and rules, and a list's bullets, in a reply."),
  reply("code", "Code in a reply."),
  reply("quote", "A quote in a reply, and its bar."),
]

/** Each key's parts: `agents.<name>.preset` is agents, <name>, preset. */
const parts = (key: string) => key.split(".")
/** A part that's a name you choose, not a word of the file's. */
const chosen = (part: string) => part.startsWith("<") || part.startsWith('"')

/**
 * The words a reader takes inside `table` of `file`: "" for the file's top, `agents.<name>` for an agent's
 * table, `tabs[]` for a tab. A table holding settings of its own is one of its parent's words too.
 */
export function keysIn(file: SettingsFile, table: string): string[] {
  const depth = table === "" ? 0 : parts(table).length
  const words = new Set<string>()
  for (const s of SETTINGS) {
    if (s.file !== file) continue
    const p = parts(s.key)
    if (p.length <= depth || p.slice(0, depth).join(".") !== table) continue
    const word = p[depth]!.replace(/\[\]$/, "")
    if (!chosen(word)) words.add(word)
  }
  return [...words]
}
