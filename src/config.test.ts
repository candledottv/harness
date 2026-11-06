import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, loadConfig, MAX_AGENTS } from "./config"
import { paths, type Paths } from "./paths"

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function withConfig(toml?: string): Paths {
  const home = mkdtempSync(join(tmpdir(), "chc-"))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const p = paths({ HOME: home })
  if (toml !== undefined) {
    mkdirSync(p.configDir, { recursive: true })
    writeFileSync(p.configFile, toml)
  }
  return p
}

const ONE_AGENT = `
[agents.momentum.limits]
perTradeUsd = 10
perDayUsd = 50
`

function configError(p: Paths): ConfigError {
  try {
    loadConfig(p)
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error("expected a ConfigError")
}

test("a minimal config fills in the defaults", () => {
  const { config, warnings } = loadConfig(withConfig(ONE_AGENT))
  expect(warnings).toEqual([])
  expect(config).toEqual({
    agents: { momentum: { name: "momentum", limits: { perTradeUsd: 10, perDayUsd: 50 } } },
    activeAgent: "momentum",
    mode: "paper",
    cards: { typedTrades: "card" },
    pricing: { source: "auto", quoteTool: "candle_quote" },
    trade: { spendAsset: "SOL" },
    engine: { default: "claude-code", claude: { path: "claude" }, codex: { path: "codex" }, grok: { path: "grok" }, opencode: { path: "opencode" }, pi: { path: "pi" }, stepCap: 30 },
    candle: { mcp: { route: "cli", path: "candle-mcp" }, cliPath: "candle", rpcUrl: undefined, profile: undefined },
    wallets: { show: "active" },
    hacc: { enabled: true },
    pnl: { window: "24h" },
    skills: { from: [] },
  })
})

test("a full config is read as written", () => {
  const { config, warnings } = loadConfig(
    withConfig(`
activeAgent = "swing"
mode = "live"

[cards]
typedTrades = "instant"

[trade]
spendAsset = "usdc"

[engine]
stepCap = 12
[engine.claude]
path = "/opt/claude/bin/claude"

[candle]
cliPath = "/opt/candle/bin/candle"
rpcUrl = "https://rpc.example.com/solana"
[candle.mcp]
route = "package"
path = "/opt/candle/bin/candle-mcp"

[agents.momentum.limits]
perTradeUsd = 10
perDayUsd = 50

[agents.swing.limits]
perTradeUsd = 2.5
perDayUsd = 20
`),
  )
  expect(warnings).toEqual([])
  expect(Object.keys(config.agents)).toEqual(["momentum", "swing"])
  expect(config.agents.swing!.limits).toEqual({ perTradeUsd: 2.5, perDayUsd: 20 })
  expect(config.activeAgent).toBe("swing")
  expect(config.mode).toBe("live")
  expect(config.cards.typedTrades).toBe("instant")
  expect(config.trade.spendAsset).toBe("USDC")
  expect(config.engine).toEqual({ default: "claude-code", claude: { path: "/opt/claude/bin/claude" }, codex: { path: "codex" }, grok: { path: "grok" }, opencode: { path: "opencode" }, pi: { path: "pi" }, stepCap: 12 })
  expect(config.candle).toEqual({
    mcp: { route: "package", path: "/opt/candle/bin/candle-mcp" },
    cliPath: "/opt/candle/bin/candle",
    rpcUrl: "https://rpc.example.com/solana",
    profile: undefined,
  })
})

test("with several agents and no activeAgent, the first listed is active", () => {
  const { config } = loadConfig(
    withConfig(`
[agents.swing.limits]
perTradeUsd = 1
perDayUsd = 2
[agents.momentum.limits]
perTradeUsd = 1
perDayUsd = 2
`),
  )
  expect(config.activeAgent).toBe("swing")
})

test("a missing config says to run candle-harness key add", () => {
  const p = withConfig()
  const error = configError(p)
  expect(error.code).toBe("missing")
  expect(error.message).toContain(p.configFile)
  expect(error.message).toContain("candle-harness key add")
})

test("a config with no agents says to run candle-harness key add", () => {
  const error = configError(withConfig(`mode = "paper"\n`))
  expect(error.code).toBe("no_agents")
  expect(error.message).toContain("candle-harness key add")
})

test("in setup, a missing config or one with no agents is the defaults with none; any other problem is still refused", () => {
  expect(loadConfig(withConfig(), { setup: true }).config).toMatchObject({ agents: {}, activeAgent: "", mode: "paper" })
  expect(loadConfig(withConfig(`mode = "live"\n`), { setup: true }).config).toMatchObject({ agents: {}, activeAgent: "", mode: "live" })
  expect(() => loadConfig(withConfig(`mode = "nope"\n`), { setup: true })).toThrow("mode is")
  expect(() => loadConfig(withConfig(`[agents.momentum\n`), { setup: true })).toThrow("isn't valid TOML")
})

test("a TOML syntax error is refused with the parser's reason", () => {
  const error = configError(withConfig(`[agents.momentum\n`))
  expect(error.code).toBe("parse")
  expect(error.message).toContain("config.toml")
})

test("bad limits are refused, naming the agent and the field", () => {
  const cases: [string, string][] = [
    [`perTradeUsd = "10"\nperDayUsd = 50`, "agents.momentum.limits.perTradeUsd"],
    [`perTradeUsd = -1\nperDayUsd = 50`, "agents.momentum.limits.perTradeUsd"],
    [`perTradeUsd = 0\nperDayUsd = 50`, "agents.momentum.limits.perTradeUsd"],
    [`perTradeUsd = 10\nperDayUsd = inf`, "agents.momentum.limits.perDayUsd"],
    [`perTradeUsd = 10\nperDayUsd = nan`, "agents.momentum.limits.perDayUsd"],
    [`perTradeUsd = 10`, "agents.momentum.limits.perDayUsd"],
  ]
  for (const [limits, field] of cases) {
    const error = configError(withConfig(`[agents.momentum.limits]\n${limits}\n`))
    expect(error.code).toBe("invalid")
    expect(error.problems.join("\n")).toContain(field)
  }
  const noLimits = configError(withConfig(`[agents.momentum]\n`))
  expect(noLimits.problems.join("\n")).toContain("agents.momentum.limits")
})

test("every problem is reported at once", () => {
  const error = configError(
    withConfig(`
mode = "yolo"
[cards]
typedTrades = "never"
[trade]
spendAsset = "usdt"
[engine]
stepCap = 2.5
[candle]
rpcUrl = "not a url"
[candle.mcp]
route = "docker"
${ONE_AGENT}`),
  )
  expect(error.code).toBe("invalid")
  const text = error.problems.join("\n")
  for (const field of ["mode", "cards.typedTrades", "trade.spendAsset", "engine.stepCap", "candle.rpcUrl", "candle.mcp.route"]) {
    expect(text).toContain(field)
  }
})

test("the engine a fresh install starts on, its model, and each engine's path", () => {
  const { config, warnings } = loadConfig(
    withConfig(`
[engine]
default = "pi"
model = "openrouter/anthropic/claude-haiku-5.5"
[engine.codex]
path = "/opt/codex"
[engine.pi]
path = "/opt/pi"
${ONE_AGENT}`),
  )
  expect(warnings).toEqual([])
  expect(config.engine).toMatchObject({ default: "pi", model: "openrouter/anthropic/claude-haiku-5.5", codex: { path: "/opt/codex" }, pi: { path: "/opt/pi" }, grok: { path: "grok" } })
})

test("an engine we don't know is refused, naming the five", () => {
  const error = configError(withConfig(`[engine]\ndefault = "crush"\n${ONE_AGENT}`))
  expect(error.problems.join("\n")).toContain('engine.default is "crush"; it must be one of claude-code, codex, grok, opencode, pi')
})

test("an activeAgent that isn't configured is refused", () => {
  const error = configError(withConfig(`activeAgent = "ghost"\n${ONE_AGENT}`))
  expect(error.problems.join("\n")).toContain(`activeAgent "ghost"`)
})

test("an agent name that can't be a key file name is refused", () => {
  const error = configError(withConfig(`[agents."../x".limits]\nperTradeUsd = 1\nperDayUsd = 2\n`))
  expect(error.problems.join("\n")).toContain("../x")
})

test(`more than ${MAX_AGENTS} agents is refused: Candle allows ${MAX_AGENTS} active keys per account`, () => {
  const agents = Array.from({ length: MAX_AGENTS + 1 }, (_, i) => `[agents.a${i}.limits]\nperTradeUsd = 1\nperDayUsd = 2\n`)
  const error = configError(withConfig(agents.join("")))
  expect(error.problems.join("\n")).toContain(`${MAX_AGENTS}`)
})

test("an rpcUrl must be one the CLI takes: https, or plain http only on this machine", () => {
  for (const bad of ["file:///etc/passwd", "http://rpc.example.com"]) {
    const error = configError(withConfig(`[candle]\nrpcUrl = "${bad}"\n${ONE_AGENT}`))
    expect(error.problems.join("\n")).toContain("candle.rpcUrl")
  }
  for (const good of ["https://rpc.example.com", "http://127.0.0.1:8899", "http://localhost:8899"]) {
    expect(loadConfig(withConfig(`[candle]\nrpcUrl = "${good}"\n${ONE_AGENT}`)).config.candle.rpcUrl).toBe(good)
  }
})

test("wallets.show: active by default, all, or a list; anything else is refused", () => {
  expect(loadConfig(withConfig(ONE_AGENT)).config.wallets).toEqual({ show: "active" })
  expect(loadConfig(withConfig(`[wallets]\nshow = "all"\n${ONE_AGENT}`)).config.wallets).toEqual({ show: "all" })
  expect(loadConfig(withConfig(`[wallets]\nshow = ["embedded", "tee-one"]\n${ONE_AGENT}`)).config.wallets).toEqual({ show: ["embedded", "tee-one"] })
  expect(configError(withConfig(`[wallets]\nshow = "some"\n${ONE_AGENT}`)).problems.join("\n")).toContain("wallets.show")
})

test("unknown keys warn and don't fail", () => {
  const { config, warnings } = loadConfig(
    withConfig(`
font = "mono"
[engine]
maxTurns = 5
[agents.momentum]
colour = "red"
[agents.momentum.limits]
perTradeUsd = 10
perDayUsd = 50
perWeekUsd = 100
`),
  )
  expect(config.activeAgent).toBe("momentum")
  expect(warnings.toSorted()).toEqual([
    "unknown setting agents.momentum.colour, ignored",
    "unknown setting agents.momentum.limits.perWeekUsd, ignored",
    "unknown setting engine.maxTurns, ignored",
    "unknown setting font, ignored",
  ])
  // [theme] is the view's: the core neither warns about it nor reads it.
  expect(loadConfig(withConfig(`[theme]\nname = "Candle light"\n[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`)).warnings).toEqual([])
})

test("a per-trade limit above the per-day limit warns", () => {
  const { warnings } = loadConfig(withConfig(`[agents.momentum.limits]\nperTradeUsd = 100\nperDayUsd = 50\n`))
  expect(warnings).toEqual(["agents.momentum: perTradeUsd ($100) is above perDayUsd ($50), so the day limit binds first"])
})

test("an agent's default wallet: a label, an address or embedded; anything else is refused", () => {
  const { config, warnings } = loadConfig(
    withConfig(`
[agents.momentum]
wallet = "  bot-wallet "
[agents.momentum.limits]
perTradeUsd = 10
perDayUsd = 50
[agents.swing.limits]
perTradeUsd = 10
perDayUsd = 50
`),
  )
  expect(warnings).toEqual([])
  expect(config.agents.momentum!.wallet).toBe("bot-wallet")
  expect(config.agents.swing!.wallet).toBeUndefined()
  for (const bad of [`wallet = ""`, `wallet = 3`, `wallet = "a\\u001bb"`, `wallet = "${"x".repeat(65)}"`]) {
    const error = configError(withConfig(`[agents.momentum]\n${bad}\n[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`))
    expect(error.problems.join("\n")).toContain("agents.momentum.wallet")
  }
})

test("an agent's preset: unset is Quant's start, quant, trader or bare; anything else is refused", () => {
  const { config, warnings } = loadConfig(withConfig(`[agents.momentum]\npreset = "trader"\n[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.swing.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`))
  expect(warnings).toEqual([])
  expect(config.agents.momentum!.preset).toBe("trader")
  expect(config.agents.swing!.preset).toBeUndefined()
  const error = configError(withConfig(`[agents.momentum]\npreset = "Quant"\n[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`))
  expect(error.problems).toContain('agents.momentum.preset is "Quant"; use "quant", "trader" or "bare"')
})

test("an agent's tools: the shell off by default, a list or everything, and allow and deny lists", () => {
  const { config, warnings } = loadConfig(
    withConfig(`${ONE_AGENT}
[agents.swing.limits]
perTradeUsd = 10
perDayUsd = 50
[agents.swing.tools]
shell = ["ls", "git log", "ls"]
deny = ["web_search", "candle_launch*"]
allow = ["candle_*", "read", "write", "web_search"]
[agents.scout.limits]
perTradeUsd = 10
perDayUsd = 50
[agents.scout.tools]
shell = "everything"
`),
  )
  expect(warnings).toEqual([])
  expect(config.agents.momentum!.tools).toBeUndefined()
  expect(config.agents.swing!.tools).toEqual({ shell: ["ls", "git log"], allow: ["candle_*", "read", "write", "web_search"], deny: ["web_search", "candle_launch*"] })
  expect(config.agents.scout!.tools).toEqual({ shell: "everything", deny: [] })
})

test("an agent's tools are checked, every problem at once", () => {
  const e = configError(
    withConfig(`${ONE_AGENT}
[agents.momentum.tools]
shell = ["ls; rm -rf ~", "cat"]
deny = ["bash", "view_image"]
allow = "read"
colour = "blue"
`),
  )
  expect(e.code).toBe("invalid")
  expect(e.problems).toEqual([
    expect.stringContaining('agents.momentum.tools.shell: "ls; rm -rf ~" isn\'t a command'),
    "agents.momentum.tools.allow must be a list of tool names, such as [\"web_search\", \"candle_launch_token\"]",
    expect.stringContaining("agents.momentum.tools.deny: the shell is set by tools.shell"),
    expect.stringContaining('agents.momentum.tools.deny: "view_image" names no tool'),
  ])
  expect(configError(withConfig(`${ONE_AGENT}\n[agents.momentum.tools]\nshell = true\n`)).problems).toEqual([expect.stringContaining('use "off", "everything" or a list of commands')])
  expect(configError(withConfig(`${ONE_AGENT}\n[agents.momentum.tools]\nshell = []\n`)).problems).toEqual([expect.stringContaining('use "off" to turn the shell off')])
  const { warnings } = loadConfig(withConfig(`${ONE_AGENT}\n[agents.momentum.tools]\nallow = []\ncolour = "blue"\n`))
  expect(warnings).toEqual(["unknown setting agents.momentum.tools.colour, ignored", "agents.momentum.tools.allow is empty, so the agent is offered no tools at all"])
})

test("[pnl] window: a fresh install's P&L window, and a wrong one named", () => {
  const read = (body: string) => loadConfig(withConfig(`${ONE_AGENT}\n${body}\n`))
  expect(read("").config.pnl.window).toBe("24h")
  expect(read('[pnl]\nwindow = "midnight"').config.pnl.window).toBe("midnight")
  expect(read('[pnl]\nwindow = "session"').config.pnl.window).toBe("session")
  expect(read('[pnl]\nwindow = "8:30"').config.pnl.window).toBe("08:30")
  expect(() => read('[pnl]\nwindow = "yesterday"')).toThrow(/pnl\.window is "yesterday"; use "24h", "midnight", "session"/)
  expect(() => read('[pnl]\nwindow = "25:00"')).toThrow(/pnl\.window/)
})
