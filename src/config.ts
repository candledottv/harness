// config.toml: the agents and their Candle Harness limits, the active agent, the mode a fresh core starts in (after
// that, the mode last picked is kept: core/mode-state.ts), what a buy sized
// in dollars spends, and where the engine and Candle's tools live. Every problem is reported at once; unknown keys only warn.
import { keysIn } from "./config-settings"
import { type ChainSlug, chainName, enabledChains, isChainSlug } from "./shared/chains"
import { parseShown, type WalletsShown } from "./core/wallets-shown"
import { DEFAULT_WINDOW, parseWindow, type PnlWindow } from "./core/pnl"
import { existsSync, readFileSync } from "node:fs"
import { ENGINE_IDS, type EngineId } from "./engine/engine"
import { isPreset, type Preset, PRESETS } from "./engine/preset"
import { runEntryFault, shellEntryFault, type ToolSettings, toolNameFault } from "./engine/tools"
import { isAgentName, type Paths } from "./paths"
import { DEFAULT_NOTIFY, NOTIFY_KINDS, NOTIFY_MODES, type NotifyKind, type NotifySettings } from "./shared/notify"

/** Candle's cap on active agent keys per account. */
export const MAX_AGENTS = 12
export const DEFAULT_STEP_CAP = 30
/** The name asked of Candle for its quote tool, which its MCP server doesn't list yet; config can name another. */
export const DEFAULT_QUOTE_TOOL = "candle_quote"

export type Mode = "paper" | "live"
export type TypedTrades = "card" | "instant"
export type McpRoute = "cli" | "package"
export type SpendAsset = "SOL" | "USDC" | "CNDL"

export interface AgentConfig {
  name: string
  limits: { perTradeUsd: number; perDayUsd: number }
  /**
   * The wallet this agent pays from when a trade names none: "embedded", or a TEE
   * wallet's label, address or id. Unset: the embedded wallet when the key is allowed it, else the
   * agent's only TEE wallet.
   */
  wallet?: string
  /**
   * A default per chain (`[agents.<name>.wallet] solana = "…"`, `hood = "…"`), in place of the one `wallet`:
   * a chain with none pays from the embedded wallet on that chain.
   */
  walletOn?: Partial<Record<ChainSlug, string>>
  /** Shell access and tool permissions (engine/tools.ts); unset is the shell off and every research tool. */
  tools?: ToolSettings
  /** How often triggers may wake this agent: woken turns an hour and a day. Unset, 4 and 24. */
  wake?: { perHour?: number; perDay?: number }
  /**
   * Where the agent's preset starts: unset is Quant. The preset last picked in
   * the Candle Harness is kept in state (core/engine-state.ts), as the engine is.
   */
  preset?: Preset
}

export interface Config {
  agents: Record<string, AgentConfig>
  activeAgent: string
  mode: Mode
  cards: { typedTrades: TypedTrades }
  /**
   * How cards are priced when proposed: `auto` uses Candle's quote tool as soon as an
   * agent's MCP server lists `quoteTool`, and fresh market reads until then; `market` keeps to them.
   */
  pricing: { source: "auto" | "market"; quoteTool: string }
  /** What a buy sized in dollars spends on Solana, for a token Candle didn't launch. */
  trade: { spendAsset: SpendAsset }
  /**
   * `default` and `model` are where an agent starts when nothing has been chosen for it;
   * the choice last made is kept in state (engine-state.ts). Each engine's `path` is its binary.
   */
  engine: {
    default: EngineId
    model?: string
    claude: { path: string }
    codex: { path: string }
    grok: { path: string }
    opencode: { path: string }
    pi: { path: string }
    stepCap: number
  }
  candle: {
    /** `cli` runs `candle mcp` from cliPath; `package` runs the `candle-mcp` package at path. */
    mcp: { route: McpRoute; path: string }
    cliPath: string
    /** The only `--rpc-url` a `candle` run ever gets. */
    rpcUrl: string | undefined
    /** The EVM RPC a `candle` run gets as CANDLE_EVM_RPC_URL, never on its command line; unset, the CLI's built-in Hood RPC. */
    evmRpcUrl?: string
    /**
     * The CLI profile the Candle Harness acts as, recorded by onboarding's sign-in: every `candle`
     * run gets it as CANDLE_PROFILE, so switching the CLI's active profile never moves the Candle Harness to another
     * account. Unset, the CLI picks as it always does.
     */
    profile: string | undefined
  }
  /** Which wallets the panes show on a fresh install (wallets-shown.ts); the choice last made is kept in state. */
  wallets: { show: WalletsShown }
  /** Hacc, Candle's market data engine: off hides every Hacc tool and closes the stream. Its host isn't configurable. */
  hacc: { enabled: boolean }
  /** Perps writes through candle_cli: off, each perps card row is held "coming" (cli-table.ts, PERPS_HELD). Unset is off. */
  perps: { writes: boolean }
  /** The P&L window a fresh install starts on; the window last picked is kept in state (core/pnl.ts). */
  pnl: { window: PnlWindow }
  /**
   * Skill folders of the person's own to use, such as Claude Code's "~/.claude/skills", as written
   * (a leading ~ is the home folder). Where a fresh install starts: the choice last made in settings ▾ → skills
   * is kept in state (core/skill-folders.ts).
   */
  skills: { from: string[] }
  /**
   * The core's own settings. `keepAwake`: keep the Mac awake while a trigger or bot is on (core/keep-awake.ts), where a
   * fresh install starts; the choice last made is kept in state. Unset is off.
   */
  core?: { keepAwake: boolean }
  /**
   * The Build tab's bots folder and harness (core/build-prefs.ts), where a fresh install starts; the choice last made
   * in the Build pane is kept in state. Unset, the folder is ~/candle-bots and the pane asks for the harness.
   */
  build?: { folder?: string; harness?: string }
  /**
   * Notifications (shared/notify.ts): how they're sent, and which things send one. Unset is `auto` with
   * every kind on.
   */
  notify?: NotifySettings
}

export type ConfigErrorCode = "missing" | "parse" | "no_agents" | "invalid"

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}` : message)
    this.name = "ConfigError"
  }
}

type Table = Record<string, unknown>

// Known keys per table, used only to warn about the rest: config-settings.ts's, so a setting can't be read here
// without words for the docs. aliases and theme are the view's alone; the core never reads them.
const known = (table: string) => keysIn("config.toml", table)
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  "": known(""),
  skills: known("skills"),
  wallets: known("wallets"),
  pnl: known("pnl"),
  hacc: known("hacc"),
  perps: known("perps"),
  core: known("core"),
  build: known("build"),
  notify: known("notify"),
  pricing: known("pricing"),
  cards: known("cards"),
  trade: known("trade"),
  engine: known("engine"),
  "engine.claude": known("engine.claude"),
  "engine.codex": known("engine.codex"),
  "engine.grok": known("engine.grok"),
  "engine.opencode": known("engine.opencode"),
  "engine.pi": known("engine.pi"),
  candle: known("candle"),
  "candle.mcp": known("candle.mcp"),
  agent: known("agents.<name>"),
  "agent.tools": known("agents.<name>.tools"),
  "agent.limits": known("agents.<name>.limits"),
  "agent.wake": known("agents.<name>.wake"),
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value)
}

/** The CLI's own rule for a profile's name (profiles.ts `isValidProfileName`, CLI 0.13.5). */
export const isProfileName = (name: unknown): name is string => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)

const ADD_FIRST = `Run \`candle-harness\` to set up your first agent, or \`candle-harness key add --agent <name>\` with a key you already have.`

/**
 * `setup`: onboarding's core and view run before there's an agent, so a missing file or
 * one with no agents is the defaults with none, rather than a refusal. Every other problem is still refused.
 */
export function loadConfig(p: Paths, opts: { setup?: boolean } = {}): { config: Config; warnings: string[] } {
  if (!existsSync(p.configFile)) {
    if (opts.setup) return parseConfig("", p.configFile, opts)
    throw new ConfigError("missing", `No config at ${p.configFile}. ${ADD_FIRST}`)
  }
  return parseConfig(readFileSync(p.configFile, "utf8"), p.configFile, opts)
}

/** A config's text, checked as loadConfig checks the file; `file` names it in messages. */
export function parseConfig(source: string, file: string, opts: { setup?: boolean } = {}): { config: Config; warnings: string[] } {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch (error) {
    throw new ConfigError("parse", `${file} isn't valid TOML: ${(error as Error).message}`)
  }
  if (!isTable(raw)) throw new ConfigError("parse", `${file} isn't valid TOML`)

  const problems: string[] = []
  const warnings: string[] = []

  const unknownKeys = (table: Table, known: readonly string[], prefix: string) => {
    for (const key of Object.keys(table)) {
      if (!known.includes(key)) warnings.push(`unknown setting ${prefix}${key}, ignored`)
    }
  }
  const table = (parent: Table, key: string, prefix: string): Table => {
    const value = parent[key]
    if (value === undefined) return {}
    if (isTable(value)) return value
    problems.push(`${prefix}${key} must be a table`)
    return {}
  }
  const oneOf = <T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T => {
    if (value === undefined) return fallback
    if (allowed.includes(value as T)) return value as T
    problems.push(`${field} is ${show(value)}; use ${allowed.map((a) => `"${a}"`).join(" or ")}`)
    return fallback
  }
  const text = (value: unknown, field: string, fallback: string): string => {
    if (value === undefined) return fallback
    if (typeof value === "string" && value.length > 0) return value
    problems.push(`${field} must be a non-empty string`)
    return fallback
  }
  const dollars = (value: unknown, field: string): number => {
    if (value === undefined) {
      problems.push(`${field} is missing: set it to a dollar amount, such as 10`)
      return NaN
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      problems.push(`${field} is ${show(value)}; it must be a positive dollar amount`)
      return NaN
    }
    return value
  }

  unknownKeys(raw, KNOWN[""]!, "")

  // Agents, in the order the file lists them.
  const agentsTable = table(raw, "agents", "")
  const agents: Record<string, AgentConfig> = {}
  const names = Object.keys(agentsTable)
  if (names.length === 0 && !opts.setup) {
    throw new ConfigError("no_agents", `${file} has no agents. ${ADD_FIRST}`)
  }
  if (names.length > MAX_AGENTS) {
    problems.push(`${names.length} agents are configured; Candle allows at most ${MAX_AGENTS} active keys per account`)
  }
  for (const name of names) {
    const prefix = `agents.${name}`
    if (!isAgentName(name)) {
      problems.push(`agent name "${name}" can't be used: use 1 to 32 lower-case letters, digits, "-" or "_"`)
      continue
    }
    const agent = table(agentsTable, name, "agents.")
    unknownKeys(agent, KNOWN.agent!, `${prefix}.`)
    if (agent.limits === undefined) {
      problems.push(`${prefix}.limits is missing: set perTradeUsd and perDayUsd`)
      continue
    }
    const limits = table(agent, "limits", `${prefix}.`)
    unknownKeys(limits, KNOWN["agent.limits"]!, `${prefix}.limits.`)
    const perTradeUsd = dollars(limits.perTradeUsd, `${prefix}.limits.perTradeUsd`)
    const perDayUsd = dollars(limits.perDayUsd, `${prefix}.limits.perDayUsd`)
    if (perTradeUsd > perDayUsd) {
      warnings.push(`${prefix}: perTradeUsd ($${perTradeUsd}) is above perDayUsd ($${perDayUsd}), so the day limit binds first`)
    }
    let wallet: string | undefined
    let walletOn: AgentConfig["walletOn"]
    const walletWord = (value: unknown): value is string => typeof value === "string" && /^[^\x00-\x1f\x7f]{1,64}$/.test(value.trim())
    if (isTable(agent.wallet)) {
      // A default per chain: each key a chain the Candle Harness trades on.
      const chains = enabledChains().map((c) => c.slug)
      walletOn = {}
      for (const [chain, value] of Object.entries(agent.wallet)) {
        if (!isChainSlug(chain)) problems.push(`${prefix}.wallet.${chain} isn't a chain: use ${chains.join(" or ")}`)
        else if (walletWord(value)) walletOn[chain] = value.trim()
        else problems.push(`${prefix}.wallet.${chain} is ${show(value)}; use "embedded", or a wallet's name or address on ${chainName(chain)}`)
      }
    } else if (agent.wallet !== undefined) {
      if (walletWord(agent.wallet)) wallet = agent.wallet.trim()
      else problems.push(`${prefix}.wallet is ${show(agent.wallet)}; use "embedded", or a TEE wallet's label, address or id`)
    }
    const tools = agent.tools === undefined ? undefined : toolSettings(table(agent, "tools", `${prefix}.`), `${prefix}.tools`, problems, warnings)
    let preset: Preset | undefined
    if (agent.preset !== undefined) {
      if (isPreset(agent.preset)) preset = agent.preset
      else problems.push(`${prefix}.preset is ${show(agent.preset)}; use ${PRESETS.map((p) => `"${p}"`).join(", ").replace(/, ([^,]+)$/, " or $1")}`)
    }
    let wake: AgentConfig["wake"]
    if (agent.wake !== undefined) {
      const w = table(agent, "wake", `${prefix}.`)
      unknownKeys(w, KNOWN["agent.wake"]!, `${prefix}.wake.`)
      const count = (value: unknown, key: string): number | undefined => {
        if (value === undefined) return undefined
        if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000) return value
        problems.push(`${prefix}.wake.${key} is ${show(value)}; use a whole number from 0 (never woken) to 1000`)
        return undefined
      }
      const perHour = count(w.perHour, "perHour")
      const perDay = count(w.perDay, "perDay")
      wake = { ...(perHour !== undefined ? { perHour } : {}), ...(perDay !== undefined ? { perDay } : {}) }
      if (perHour !== undefined && perDay !== undefined && perHour > perDay) warnings.push(`${prefix}.wake: perHour (${perHour}) is above perDay (${perDay}), so the day's cap binds first`)
    }
    agents[name] = { name, limits: { perTradeUsd, perDayUsd }, ...(wallet ? { wallet } : {}), ...(walletOn && Object.keys(walletOn).length ? { walletOn } : {}), ...(tools ? { tools } : {}), ...(preset ? { preset } : {}), ...(wake ? { wake } : {}) }
  }

  // No agents only in setup: there's no active agent until the first is made.
  let activeAgent = names[0] ?? ""
  if (raw.activeAgent !== undefined) {
    if (typeof raw.activeAgent === "string" && agents[raw.activeAgent]) activeAgent = raw.activeAgent
    else problems.push(`activeAgent ${show(raw.activeAgent)} isn't one of the configured agents (${names.join(", ")})`)
  }

  const mode = oneOf(raw.mode, "mode", ["paper", "live"] as const, "paper")

  const cards = table(raw, "cards", "")
  unknownKeys(cards, KNOWN.cards!, "cards.")
  const typedTrades = oneOf(cards.typedTrades, "cards.typedTrades", ["card", "instant"] as const, "card")

  const pricingTable = table(raw, "pricing", "")
  unknownKeys(pricingTable, KNOWN.pricing!, "pricing.")
  const pricing = {
    source: oneOf(pricingTable.source, "pricing.source", ["auto", "market"] as const, "auto"),
    quoteTool: text(pricingTable.quoteTool, "pricing.quoteTool", DEFAULT_QUOTE_TOOL),
  }

  const trade = table(raw, "trade", "")
  unknownKeys(trade, KNOWN.trade!, "trade.")
  const spendAsset = oneOf(typeof trade.spendAsset === "string" ? trade.spendAsset.toLowerCase() : trade.spendAsset, "trade.spendAsset", ["sol", "usdc", "cndl"] as const, "sol").toUpperCase() as SpendAsset

  const engine = table(raw, "engine", "")
  unknownKeys(engine, KNOWN.engine!, "engine.")
  const enginePath = (key: "claude" | "codex" | "grok" | "opencode" | "pi") => {
    const t = table(engine, key, "engine.")
    unknownKeys(t, KNOWN[`engine.${key}`]!, `engine.${key}.`)
    return text(t.path, `engine.${key}.path`, key)
  }
  let engineDefault: EngineId = "claude-code"
  if (engine.default !== undefined) {
    if ((ENGINE_IDS as readonly unknown[]).includes(engine.default)) engineDefault = engine.default as EngineId
    else problems.push(`engine.default is ${show(engine.default)}; it must be one of ${ENGINE_IDS.join(", ")}`)
  }
  const engineModel = engine.model === undefined ? undefined : text(engine.model, "engine.model", "")
  const engineTable = {
    default: engineDefault,
    ...(engineModel ? { model: engineModel } : {}),
    claude: { path: enginePath("claude") },
    codex: { path: enginePath("codex") },
    grok: { path: enginePath("grok") },
    opencode: { path: enginePath("opencode") },
    pi: { path: enginePath("pi") },
  }
  let stepCap = DEFAULT_STEP_CAP
  if (engine.stepCap !== undefined) {
    if (Number.isInteger(engine.stepCap) && (engine.stepCap as number) > 0) stepCap = engine.stepCap as number
    else problems.push(`engine.stepCap is ${show(engine.stepCap)}; it must be a whole number above 0`)
  }

  const candle = table(raw, "candle", "")
  unknownKeys(candle, KNOWN.candle!, "candle.")
  const mcp = table(candle, "mcp", "candle.")
  unknownKeys(mcp, KNOWN["candle.mcp"]!, "candle.mcp.")
  let rpcUrl: string | undefined
  if (candle.rpcUrl !== undefined) {
    // The CLI refuses any other, on every TEE trade, so it's refused here instead.
    const fault = typeof candle.rpcUrl === "string" ? solanaRpcFault(candle.rpcUrl) : "isn't a URL"
    if (fault === undefined) rpcUrl = candle.rpcUrl as string
    else problems.push(`candle.rpcUrl is ${show(candle.rpcUrl)}; it ${fault}`)
  }
  let evmRpcUrl: string | undefined
  if (candle.evmRpcUrl !== undefined) {
    // The CLI's rule for its EVM RPC is the same as for Solana's (cli/src/evm-lite.ts resolveEvmRpcUrl).
    const fault = typeof candle.evmRpcUrl === "string" ? solanaRpcFault(candle.evmRpcUrl) : "isn't a URL"
    if (fault === undefined) evmRpcUrl = candle.evmRpcUrl as string
    else problems.push(`candle.evmRpcUrl is ${show(candle.evmRpcUrl)}; it ${fault}`)
  }
  let profile: string | undefined
  if (candle.profile !== undefined) {
    if (isProfileName(candle.profile)) profile = candle.profile
    else problems.push(`candle.profile is ${show(candle.profile)}; it must be a CLI profile's name (a letter or digit, then letters, digits, ".", "_" or "-", up to 32)`)
  }

  const walletsTable = table(raw, "wallets", "")
  unknownKeys(walletsTable, KNOWN.wallets!, "wallets.")
  let walletsShow: WalletsShown = "active"
  if (walletsTable.show !== undefined) {
    const parsed = parseShown(walletsTable.show)
    if (parsed.ok) walletsShow = parsed.shown
    else problems.push(`wallets.show is ${show(walletsTable.show)}; ${parsed.message}`)
  }

  const haccTable = table(raw, "hacc", "")
  unknownKeys(haccTable, KNOWN.hacc!, "hacc.")
  let haccEnabled = true
  if (haccTable.enabled !== undefined) {
    if (typeof haccTable.enabled === "boolean") haccEnabled = haccTable.enabled
    else problems.push(`hacc.enabled is ${show(haccTable.enabled)}; it must be true or false`)
  }

  const perpsTable = table(raw, "perps", "")
  unknownKeys(perpsTable, KNOWN.perps!, "perps.")
  let perpsWrites = false
  if (perpsTable.writes !== undefined) {
    if (typeof perpsTable.writes === "boolean") perpsWrites = perpsTable.writes
    else problems.push(`perps.writes is ${show(perpsTable.writes)}; it must be true or false`)
  }

  const pnlTable = table(raw, "pnl", "")
  unknownKeys(pnlTable, KNOWN.pnl!, "pnl.")
  let pnlWindow: PnlWindow = DEFAULT_WINDOW
  if (pnlTable.window !== undefined) {
    const parsed = parseWindow(pnlTable.window)
    if (parsed.ok) pnlWindow = parsed.window
    else problems.push(`pnl.window is ${show(pnlTable.window)}; ${parsed.message}`)
  }

  const coreTable = table(raw, "core", "")
  unknownKeys(coreTable, KNOWN.core!, "core.")
  let keepAwake = false
  if (coreTable.keepAwake !== undefined) {
    if (typeof coreTable.keepAwake === "boolean") keepAwake = coreTable.keepAwake
    else problems.push(`core.keepAwake is ${show(coreTable.keepAwake)}; it must be true or false`)
  }

  const buildTable = table(raw, "build", "")
  unknownKeys(buildTable, KNOWN.build!, "build.")
  const build: { folder?: string; harness?: string } = {}
  if (buildTable.folder !== undefined) {
    if (typeof buildTable.folder === "string" && /^(\/|~\/|~$)/.test(buildTable.folder.trim())) build.folder = buildTable.folder.trim()
    else problems.push(`build.folder is ${show(buildTable.folder)}; it's a folder from / or ~/, such as "~/candle-bots"`)
  }
  if (buildTable.harness !== undefined) {
    if (typeof buildTable.harness === "string" && buildTable.harness.trim() && buildTable.harness.length <= 200 && !/[\x00-\x1f\x7f]/.test(buildTable.harness)) build.harness = buildTable.harness.trim()
    else problems.push(`build.harness is ${show(buildTable.harness)}; it's "claude-code", "codex", "grok", "opencode", "pi", or a command of your own`)
  }

  const notifyTable = table(raw, "notify", "")
  unknownKeys(notifyTable, KNOWN.notify!, "notify.")
  const notifyMode = oneOf(notifyTable.mode, "notify.mode", NOTIFY_MODES, DEFAULT_NOTIFY.mode)
  let notifyOn: NotifyKind[] = [...DEFAULT_NOTIFY.on]
  if (notifyTable.on !== undefined) {
    const kinds = NOTIFY_KINDS as readonly string[]
    if (!Array.isArray(notifyTable.on)) problems.push(`notify.on is ${show(notifyTable.on)}; it's a list of what notifies, from ${NOTIFY_KINDS.join(", ")}`)
    else {
      notifyOn = []
      for (const k of notifyTable.on) {
        if (typeof k === "string" && kinds.includes(k)) notifyOn.push(k as NotifyKind)
        else problems.push(`notify.on has ${show(k)}; each is one of ${NOTIFY_KINDS.join(", ")}`)
      }
    }
  }

  const skillsTable = table(raw, "skills", "")
  unknownKeys(skillsTable, KNOWN.skills!, "skills.")
  const skillsFrom: string[] = []
  if (skillsTable.from !== undefined) {
    if (!Array.isArray(skillsTable.from)) problems.push(`skills.from is ${show(skillsTable.from)}; it's a list of folders, such as ["~/.claude/skills"]`)
    else
      for (const f of skillsTable.from) {
        if (typeof f === "string" && (f.startsWith("/") || f.startsWith("~/"))) skillsFrom.push(f)
        else problems.push(`skills.from has ${show(f)}; each is a folder from / or ~/, such as "~/.claude/skills"`)
      }
  }

  const route = oneOf(mcp.route, "candle.mcp.route", ["cli", "package"] as const, "cli")
  const mcpPath = text(mcp.path, "candle.mcp.path", "candle-mcp")
  const cliPath = text(candle.cliPath, "candle.cliPath", "candle")

  if (problems.length) throw new ConfigError("invalid", `${file} has problems:`, problems)

  return {
    config: {
      agents,
      activeAgent,
      mode,
      cards: { typedTrades },
      pricing,
      trade: { spendAsset },
      engine: { ...engineTable, stepCap },
      candle: { mcp: { route, path: mcpPath }, cliPath, rpcUrl, ...(evmRpcUrl ? { evmRpcUrl } : {}), profile },
      wallets: { show: walletsShow },
      hacc: { enabled: haccEnabled },
      perps: { writes: perpsWrites },
      pnl: { window: pnlWindow },
      skills: { from: skillsFrom },
      core: { keepAwake },
      ...(Object.keys(build).length ? { build } : {}),
      notify: { mode: notifyMode, on: notifyOn },
    },
    warnings,
  }
}

/** An agent's `[tools]` table (engine/tools.ts), every problem reported. */
function toolSettings(t: Table, prefix: string, problems: string[], warnings: string[]): ToolSettings {
  for (const key of Object.keys(t)) if (!KNOWN["agent.tools"]!.includes(key)) warnings.push(`unknown setting ${prefix}.${key}, ignored`)
  let shell: ToolSettings["shell"] = "off"
  if (t.shell === "off" || t.shell === "everything") shell = t.shell
  else if (Array.isArray(t.shell)) {
    const faults = t.shell.map(shellEntryFault).filter((f): f is string => f !== undefined)
    if (faults.length) problems.push(...faults.map((f) => `${prefix}.shell: ${f}`))
    else if (t.shell.length === 0) problems.push(`${prefix}.shell is an empty list; use "off" to turn the shell off`)
    else shell = [...new Set(t.shell as string[])]
  } else if (t.shell !== undefined) problems.push(`${prefix}.shell is ${show(t.shell)}; use "off", "everything" or a list of commands, such as ["ls", "cat"]`)
  const names = (key: "allow" | "deny"): string[] | undefined => {
    const v = t[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v)) {
      problems.push(`${prefix}.${key} must be a list of tool names, such as ["web_search", "candle_launch_token"]`)
      return undefined
    }
    const faults = v.map(toolNameFault).filter((f): f is string => f !== undefined)
    problems.push(...faults.map((f) => `${prefix}.${key}: ${f}`))
    return faults.length ? undefined : [...new Set(v as string[])]
  }
  const allow = names("allow")
  const deny = names("deny") ?? []
  if (allow && allow.length === 0) warnings.push(`${prefix}.allow is empty, so the agent is offered no tools at all`)
  // The code runner: off unless a list of programs is set.
  let run: ToolSettings["run"] | undefined
  if (t.run === "off") run = "off"
  else if (Array.isArray(t.run)) {
    const faults = t.run.map(runEntryFault).filter((f): f is string => f !== undefined)
    if (faults.length) problems.push(...faults.map((f) => `${prefix}.run: ${f}`))
    else if (t.run.length === 0) problems.push(`${prefix}.run is an empty list; use "off" to turn the code runner off`)
    else run = [...new Set(t.run as string[])]
  } else if (t.run !== undefined) problems.push(`${prefix}.run is ${show(t.run)}; use "off", or a list of programs, such as ["python3", "bun", "node"]`)
  return { shell, ...(allow ? { allow } : {}), deny, ...(run && run !== "off" ? { run } : {}) }
}

/** The CLI's own rule (cli/src/solana-endpoint.ts:62-74): https, or plain http only on this machine. */
export function solanaRpcFault(url: string): string | undefined {
  const parsed = URL.parse(url)
  if (!parsed) return "isn't a valid URL"
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) return "isn't https (plain http is allowed only for 127.0.0.1 or localhost)"
  return undefined
}
