// Every setting in the files you edit by hand: config.toml, layouts.toml, wallets.toml and a theme of your own.
// Each reader takes its known keys from this table, so a setting can't be added to a reader
// without words here; and the docs' configuration page (scripts/docs-pages.ts) is written from it. Each setting
// carries a short example, which its own reader must take without a word (config-settings.test.ts).
//
// A key is dotted from the file's top: <placeholder> for a name you choose (agents.<name>.preset), [] for a
// list's entries (tabs[].shown), and "<address>" for a quoted key of yours.
import { PANE_IDS } from "./shared/panes"

export type SettingsFile = "config.toml" | "layouts.toml" | "wallets.toml" | "theme"

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
const ROOT = `root = ["row", ["column", 60, "token 50", "activity 50"], "agent 40"]`
const colour = (key: string, words: string): SettingDef => ({ file: "theme", key, type: `a colour, "#rrggbb"`, default: "the base theme's", words, example: `${key} = "#6cb6ff"` })
const reply = (key: string, words: string): SettingDef => ({ file: "theme", key: `reply.${key}`, type: `a colour, "#rrggbb"`, default: "the base theme's", words, example: `[reply]\n${key} = "#9ecbff"` })
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
    words: "The mode a fresh install starts in. Once you switch, the mode you last picked is kept across restarts.",
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
    words: "The wallet this agent pays from when a trade names none. `from <wallet>` on a trade overrides it, and every card names the wallet that pays.",
    example: agent(`wallet = "embedded"`),
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
    default: "the eight tabs: Trade, Cockpit, Trending, Signals, P&L, Research, Journal and Perps",
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
    words: `The layout's panes: \`["row", …]\` or \`["column", …]\`, then its children. A child is a pane and its weight (\`"token 50"\`), a pane with fixed rows inside a column (\`"agent 8 rows"\`), or another row or column with its weight after it (\`["column", 60, …]\`). The panes: ${PANE_IDS.map((p) => `\`${p}\``).join(", ")}.`,
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
