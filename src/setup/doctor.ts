// `candle-harness doctor`: what's missing, and exactly what to do about each thing. It checks, in order:
//   where things live (the socket path's length), the config, the state folder, whether a core is
//   running, each agent's key file, the `candle` CLI, Claude Code (its version, and that it's signed
//   in: a one-word turn, which fails with Claude Code's "Not logged in" error), the other engines
//   (each one's version, gaps, models and a one-word turn through its own adapter, and each agent's
//   choice), each key's access
//   as the owner's `candle keys list --json` reports it, and each agent through its own Candle MCP
//   server: `candle_execution_status`, read first, as docs.candle.tv/developers/mcp-server advises.
// Then the TEE wallets: each agent's, from its MCP server (candle_get_profile_wallets,
//   joined to the portfolio), active, and with its signer on this machine (`candle wallets --json`
//   with the agent's key, `signers`); each agent's default wallet; TEE wallets stranded on a revoked key
//   (the owner's key list, then `candle keys wallets <prefix>`, which still lists them); the RPC the CLI
//   reads the chain over; and whether Candle serves LP yet.
// Then owner steps: whether this machine has a vault (`candle vault status --json`, no
//   unlock), which every owner step through the Candle Harness needs, and any agent key with Withdraw access,
//   which can move funds with its own key: none is expected, since the Candle Harness moves funds only from the
//   vault, in the prompt pane.
// Each key's Candle request limit is named with it, and a running core says how much of each it used over
//   the last minute and which background reads it slowed to fit.
// Then Hacc: each agent's key reaching it, the account's plan and what it reaches, and the
//   signal stream's state (the running core's, else whether Hacc would open it); each agent's preset
//   and memory, and the source of the skills built in, are checked offline beside the tools.
// The view's own files are checked offline too: layouts.toml and which layout
//   each tab shows, config.toml's aliases, and the theme the view starts on, with each theme of yours
//   that fails its check; every problem is named with its line and what's used instead.
// `--offline` skips what reaches the network or costs a turn, and is what a view that can't start runs.
//
// No agent-key read says what a key may do: `candle_execution_status` reports the embedded wallets and
// whether this key may spend them, the plan and the key's own limit, but not its scopes, revocation or
// expiry. The owner's key list does (docs.candle.tv/developers/agent-access, "List and revoke"), so the doctor
// reads it through the user's own CLI when it's signed in, and says so when it isn't.
import { newKeyFix } from "../shared/fix-words"
import { parseAliases } from "../shared/aliases"
import { EMPTY_FILE, parseLayouts, tabShows } from "../view/layouts-file"
import { fileStore } from "../view/layouts-store"
import { CANDLE_DARK, TERMINAL } from "../view/theme"
import { configTheme, fileThemes, loadTheme, startingTheme } from "../view/themes"
import { createReadStream, existsSync, lstatSync, readFileSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { type Config, ConfigError, loadConfig, solanaRpcFault } from "../config"
import { type AgentStatus, parseExecutionStatus } from "../core/agent-status"
import { joinTee, parseProfileWallets, portfolioTee, resolvePayer, type TeeWallet } from "../core/agent-wallets"
import { pinnedAddress, readDefaultPins, type DefaultPin } from "../core/default-pins"
import { BASE_ASSETS } from "../core/assets"
import { CandleCli, type CliResult } from "../core/candle-cli"
import { CandleMcpChild, candleConfigDir, childLaunch, type ChildOptions, type ToolOutcome, versionAtLeast } from "../core/candle-mcp"
import { MIN_CANDLE_CLI, SOURCE } from "../core/cli-table"
import { LOSE_NEXT_REPLY_NOTE, losesNextReply, refusalMessage } from "../core/execute"
import { connectView, DOCTOR_CLIENT } from "../core/client"
import { HACC_HOST, HaccClient } from "../core/hacc"
import { stretchFrom } from "../core/feeds"
import { HACC_TOOLS, unreachedBy } from "../core/hacc-tools"
import { type KeyUse, type Pace, PLAN_LIMITS, paceWords, type ReadKind } from "../core/key-budget"
import { LONG_INDEX_CHARS, MEMORY_DIR, MEMORY_INDEX, readMemory } from "../core/memory"
import type { HaccPlan } from "../core/plan-state"
import { lastSessionEnd, readSamples, readWindowState, windowLabel } from "../core/pnl"
import { Autonomy, type WalletSetting } from "../core/autonomy"
import { AWAY_MIN_GAP_MS, type AwaySummary, gapLength } from "../core/away"
import { readJournal, type JournalRow } from "../core/journal"
import { byWalletWithoutCard, DaySpend, KeyHolds, usd } from "../core/limits"
import { researchUnreached } from "../core/research-reads"
import { probeUpgrade } from "../core/signal-stream"
import { PRESET_LABELS } from "../engine/preset"
import { CANDLE_SKILLS, loadPersonSkills, SKILL_SOURCE, SKILL_TOOL_NAME, skillsFor } from "../engine/skills"
import { SkillFolders } from "../core/skill-folders"
import { EngineState } from "../core/engine-state"
import { startingMode } from "../core/mode-state"
import { CHECKED_CLAUDE_CODE, claudeParser, claudeVersion } from "../engine/claude"
import { ENGINE_LABELS, type Engine, type EngineCheck, type EngineId, type EngineModel, newerMajor, newerMajorWords } from "../engine/engine"
import { gapsOf } from "../engine/gaps"
import { recoverHomes, removeAll } from "../engine/home"
import { buildEngines, selfCommand } from "../engine/registry"
import { GROK_UNLISTABLE } from "../engine/grok"
import { DEFAULT_TOOLS, runOn, SHELL_ON_NOTE, shellWords, toolAllowed } from "../engine/tools"
import { type HoldSupport, holdSupport } from "../core/hold"
import { harnessEnv, runLines } from "../engine/spawn"
import { configProblem, ensureStateDir, paths, PathsError, type Paths, SOCKET_PATH_MAX_BYTES, UnsafeStateDir } from "../paths"
import { apiKeyPrefix } from "../shared/api-key"
import { isTestName, sharedWithWords } from "../shared/bot-name"
import { Redactor } from "../shared/redact"
import { terminalText } from "../shared/terminal-text"
import { answers } from "../shared/socket-path"
import { COMMIT, VERSION } from "../version"
import { relativeEntries } from "../shared/exec-path"
import { runningCoreVersion, staleCoreWords } from "./core-version"
import { buildNames, renameCommand, short, walletName } from "../core/wallet-names"
import { resolveGroups } from "../core/wallet-groups"
import { WalletsFileStore } from "../core/wallets-file"
import { type EmptyState, isCounted, previewArgv, readPreview } from "../core/empty-accounts"
import { ONBOARDING_STEPS, OnboardingStore, signInFrom } from "./onboarding"
import { defaultServiceDeps, oldServiceFile, type ServiceDeps, serviceState, type ServiceState } from "./service"
import { TriggersFileStore } from "../core/triggers-file"
import type { TriggersTopic } from "../core/triggers"
import { BotsFileStore, type CodeBotEntry } from "../core/bots-file"
import { type BuildPrefs, commandArgv, isEngineHarness, readBuildPrefs } from "../core/build-prefs"
import { botsFolderPath, DEFAULT_BOTS_FOLDER, type FolderLook, lookAtBotsFolder } from "../build/folder"
import type { CodeBotView } from "../core/code-bots"
import type { BotsTopic } from "../core/bots"
import type { KeepAwakeView } from "../core/keep-awake"
import { actingProfile } from "./candle-profile"
import { canNotifyNative, DEFAULT_NOTIFY, fallbacks, isRemote, NOTIFY_KINDS, type Notifier, type NotifySettings } from "../shared/notify"

export { MIN_CANDLE_CLI }
const CLAUDE_TURN_TIMEOUT_MS = 60_000
const STATUS_TIMEOUT_MS = 30_000
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000
/** At most this many revoked keys are asked for stranded TEE wallets, newest first. */
const REVOKED_KEYS_CHECKED = 20

export type CheckState = "ok" | "warn" | "fail" | "skip"

export interface Check {
  area: string
  state: CheckState
  text: string
  /** Exactly what to do, for a check that isn't ok. */
  fix?: string
}

export interface DoctorOptions {
  env: Record<string, string | undefined>
  /** False skips Candle's reads and Claude Code's one-word turn. */
  online?: boolean
  now?: () => number
  claudeTurnTimeoutMs?: number
  /** How long each other engine's one-word turn may take. */
  engineTurnTimeoutMs?: number
  /** How to run this binary before its `mcp` subcommand, for the engines' empty MCP server; `selfCommand()` when unset. */
  shim?: string[]
  /** How each agent's Candle MCP server is started; the doctor never restarts one. */
  mcp?: Pick<ChildOptions, "connectTimeoutMs">
  /** Tests only: the fake Hacc's address. The host is otherwise fixed, as the core's is. */
  haccHost?: string
  /** Tests only: how the login service is looked at (launchctl, systemctl, loginctl). */
  service?: ServiceDeps
  /** Tests only: the user id and system the doctor runs as. */
  uid?: number
  platform?: NodeJS.Platform
  /** Tests only: this binary's own version, to compare with the running core's. */
  version?: string
}

/** The CLI's message when the login keychain is locked, as recorded over SSH. It gives no hint itself. */
const LOCKED_KEYCHAIN = /Cannot read the macOS Keychain|security exited 36/i
export const UNLOCK_KEYCHAIN =
  "Your login keychain is locked, which is common over SSH. Unlock it with `security unlock-keychain ~/Library/Keychains/login.keychain-db` " +
  "(it asks for your login password; never pass it with -p), then run candle-harness doctor again."
const NOT_SIGNED_IN = /auth login|not signed in|not logged in|no device token|no credentials/i
const INSTALL_CANDLE = "Install it with `curl -fsSL https://candle.tv/install.sh | bash` or `brew install candledottv/tap/candle`, or set candle.cliPath in config.toml."

const newKey = newKeyFix

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The last non-empty line of a run's output, redacted, for a message. */
/** A TEE wallet as everywhere else calls it: Candle's label, else its short address. */
const teeName = (t: { address: string; label?: string }): string => walletName(undefined, { ...t, kind: "tee" })

function lastLine(redactor: Redactor, ...texts: string[]): string {
  const lines = texts.join("\n").split("\n").map((l) => l.trim()).filter(Boolean)
  return redactor.text(lines.at(-1) ?? "").slice(0, 300)
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export async function runDoctor(opts: DoctorOptions): Promise<Check[]> {
  const { env } = opts
  const online = opts.online ?? true
  const now = opts.now ?? Date.now
  const checks: Check[] = []
  const add = (check: Check) => void checks.push(check)
  const redactor = new Redactor()

  let p: Paths
  try {
    p = paths(env)
  } catch (error) {
    if (!(error instanceof PathsError)) throw error
    add({ area: "paths", state: "fail", text: error.message, fix: "Set CANDLE_HARNESS_HOME to a short absolute folder, such as ~/.candle-harness." })
    return checks
  }
  add({ area: "paths", state: "ok", text: `the core's socket path is ${Buffer.byteLength(p.socket)} bytes, under the ${SOCKET_PATH_MAX_BYTES}-byte limit` })
  for (const check of pathChecks(env.PATH)) add(check)
  for (const check of rootChecks(opts.uid ?? process.getuid?.(), opts.platform ?? process.platform)) add(check)
  if (losesNextReply(env)) {
    add({ area: "debug", state: "warn", text: `${LOSE_NEXT_REPLY_NOTE}, in a core started from this shell`, fix: "Unless you're testing that, run `unset CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY`." })
  }

  let config: Config | undefined
  try {
    const loaded = loadConfig(p)
    config = loaded.config
    const names = Object.keys(config.agents)
    const start = startingMode(p.modeState, config.mode)
    const why = start.from === "saved" ? "the mode last picked" : "config.toml's mode, as nothing's been picked yet"
    add({ area: "config", state: "ok", text: `${p.configFile}: ${names.length} agent${names.length === 1 ? "" : "s"} (${names.join(", ")}); the core starts in ${start.mode} mode (${why})` })
    for (const warning of loaded.warnings) add({ area: "config", state: "warn", text: warning, fix: `Edit ${p.configFile}.` })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    // Before setup there's nothing wrong yet: say where to start, not a fault to fix.
    if (error.code === "missing" || error.code === "no_agents") {
      const why = error.code === "missing" ? `${p.configFile} isn't made yet` : `${p.configFile} has no agents`
      add({ area: "config", state: "warn", text: `no agent yet: setup hasn't made one (${why})`, fix: "Run `candle-harness`: setup opens and makes your first agent." })
    } else add({ area: "config", state: "fail", text: error.message, fix: `Edit ${p.configFile}.` })
  }

  for (const check of await onboardingChecks(p, Object.keys(config?.agents ?? {}).length > 0)) add(check)
  for (const check of layoutsChecks(p)) add(check)
  for (const check of aliasesChecks(p)) add(check)
  for (const check of themeChecks(p)) add(check)

  if (config) for (const check of toolChecks(config, EngineState.open(p.engineState, { engine: config.engine.default, ...(config.engine.model ? { model: config.engine.model } : {}) }))) add(check)
  if (config) for (const check of runnerChecks(config, await holdSupport(), env.PATH)) add(check)
  if (config) for (const check of skillChecks(p, config, EngineState.open(p.engineState, { engine: config.engine.default }), env.HOME)) add(check)
  if (config) for (const check of memoryChecks(p, config)) add(check)
  if (config) for (const check of pnlChecks(p, config, now())) add(check)
  for (const check of await journalChecks(p)) add(check)
  const coreUp = await answers(p.socket)
  // The hands-off and away lines, from the journal and state: online, the approvals' lines also read who pays from each wallet.
  const rows = await journalRowsOf(p)
  for (const check of awayChecks(p, rows, now(), coreUp)) add(check)
  const handsOff = (reads?: Map<string, PayRead>) => {
    if (config) for (const check of approvalsChecks({ p, config, rows, now: now(), ...(reads ? { reads } : {}) })) add(check)
    return checks
  }

  const stateOk = checkStateDir(p, add)
  add(
    coreUp
      ? { area: "core", state: "ok", text: `a core is running at ${p.socket}` }
      : { area: "core", state: "ok", text: "no core is running; candle-harness starts one" },
  )
  // A core keeps the version it started as: one that ran through an update is still the old one.
  if (coreUp) for (const check of coreVersionChecks(await runningCoreVersion(env), opts.version ?? VERSION)) add(check)

  // Triggers keeping the core up, what holds it, the login service and keep-awake.
  if (stateOk) for (const check of await keptRunningChecks(p, config, coreUp, opts.service ?? defaultServiceDeps(env, selfCommand(), env.USER), Boolean(env.CANDLE_KEYRING_PASSPHRASE))) add(check)
  if (stateOk) for (const check of await botChecks(p, coreUp)) add(check)
  for (const check of await buildFolderChecks(p, config, env.HOME)) add(check)
  if (stateOk) for (const check of await notifyChecks(p, config, env, coreUp)) add(check)

  // Each agent's key file: there, private, and a Candle agent key.
  const keys = new Map<string, string>()
  for (const agent of Object.keys(config?.agents ?? {})) {
    const key = checkKeyFile(p, agent, add)
    if (key) {
      keys.set(agent, key)
      redactor.add(key)
    }
  }

  // config.toml names the candle CLI and every engine: while it isn't safe, the doctor runs none of them.
  const unsafe = configProblem(p)
  if (unsafe) {
    add({ area: "candle", state: "skip", text: `the candle CLI and the engines weren't run: config.toml names them, and ${unsafe.path} ${unsafe.why}`, fix: unsafe.fix })
    return handsOff()
  }
  const cliOk = await checkCandleCli(config, env, redactor, add)
  if (config) for (const check of await profileChecks(config, env, online && cliOk)) add(check)
  // Every engine at once: Claude Code's own checks, then the others through their own
  // adapters, each whether or not an agent is on it; only an engine an agent is on gets a one-word turn.
  const choices = config ? EngineState.open(p.engineState, { engine: config.engine.default, ...(config.engine.model ? { model: config.engine.model } : {}) }) : undefined
  const onEngine = (id: EngineId) => Object.keys(config?.agents ?? {}).filter((agent) => choices?.get(agent).engine === id)
  const claudeChecks: Check[] = []
  // Each engine's own check runs once: the engines' lines and the Build tab's harnesses read the same answer.
  const checked = new Map<EngineId, Promise<EngineCheck>>()
  const [, engineRows, buildRows] = await Promise.all([
    checkClaude(p, config, env, online, opts.claudeTurnTimeoutMs ?? CLAUDE_TURN_TIMEOUT_MS, onEngine("claude-code").length > 0, (c) => void claudeChecks.push(c)),
    config ? engineChecks({ p, config, env, online, stateOk, choices: choices!, timeoutMs: opts.engineTurnTimeoutMs ?? CLAUDE_TURN_TIMEOUT_MS, checked, ...(opts.shim ? { shim: opts.shim } : {}) }) : Promise.resolve([]),
    config ? buildHarnessChecks(p, config, env, checked) : Promise.resolve([]),
  ])
  for (const check of [...claudeChecks, ...engineRows, ...buildRows]) add(check)
  if (online && cliOk) add(await checkVault(p, config, env, redactor))

  if (!online) {
    add({ area: "candle", state: "skip", text: "Candle wasn't asked about each key (--offline)", fix: "Run candle-harness doctor without --offline." })
    if (config?.hacc.enabled) add({ area: "hacc", state: "skip", text: "Hacc wasn't asked about each key or the stream (--offline)" })
    return handsOff()
  }
  if (!config || keys.size === 0) return handsOff()
  if (!stateOk) {
    add({ area: "candle", state: "skip", text: "Candle wasn't asked about each key: the state folder needs fixing first" })
    return handsOff()
  }

  const owned = cliOk ? await ownerKeyRows(config, env, redactor, add) : undefined
  const prefixes = new Map([...keys].map(([agent, key]) => [agent, apiKeyPrefix(key)!]))
  const results = await Promise.all([...keys].map(([agent, key], i) => checkAgent({ p, config: config!, env, agent, key, redactor, now, mcp: opts.mcp ?? {}, owned, cliOk, askStretch: i === 0 })))
  for (const result of results) for (const check of result.checks) add(check)
  const stretch = results.find((r) => r.stretch)?.stretch
  if (stretch) add(stretchCheck(stretch))
  for (const check of await budgetChecks(p)) add(check)
  const reads = new Map([...keys.keys()].flatMap((agent, i) => (results[i]!.read ? [[agent, results[i]!.read!] as const] : [])))
  for (const check of defaultWalletChecks(config, reads, prefixes, readDefaultPins(p.defaultPins))) add(check)
  for (const check of await nameChecks(p, config, reads)) add(check)
  if (owned) for (const check of withdrawKeys(prefixes, owned)) add(check)
  if (owned) for (const check of await strandedWallets(config, env, owned, prefixes)) add(check)
  if ([...reads.values()].some((r) => r.tee?.some((t) => t.chain === "solana"))) add(rpcCheck(config, env))
  if (cliOk) for (const check of await emptyAccountChecks({ p, config, env, keys, reads, coreUp, now })) add(check)
  if (cliOk) add(await lpCheck(config, env, keys, redactor))
  const plans = new Map([...reads].map(([agent, r]) => [agent, r.status.tier]))
  for (const check of await haccChecks({ p, config, keys, plans, now, ...(opts.haccHost ? { host: opts.haccHost } : {}) })) add(check)
  return handsOff(reads)
}

/**
 * Each agent's shell and tool settings: an agent with the shell on is named,
 * since reads aren't held to its research folder then and cards don't cover what the shell runs; a list
 * on an engine that can't hold one is said to be off; hidden tools are listed.
 */
export function toolChecks(config: Config, choices: Pick<EngineState, "get">): Check[] {
  const out: Check[] = []
  for (const [agent, a] of Object.entries(config.agents)) {
    const t = a.tools
    if (!t) continue
    const setting = `agents.${agent}.tools`
    if (t.shell !== "off") {
      out.push({
        area: "tools",
        state: "warn",
        text: `${agent} has the shell on (${shellWords(t.shell)}): ${SHELL_ON_NOTE}`,
        fix: `If you don't mean that, set ${setting}.shell = "off" in config.toml. docs.candle.tv/harness/engines says what each engine's shell can reach.`,
      })
    }
    const engine = choices.get(agent).engine
    if (Array.isArray(t.shell) && SHELL_LIST_OFF.includes(engine)) {
      out.push({
        area: "tools",
        state: "warn",
        text: `${agent} is on ${ENGINE_LABELS[engine]}, which can't hold a list of shell commands, so its shell is off there`,
        fix: `Pick Claude Code, Grok, OpenCode or Pi for ${agent} with ctrl-g to use the list.`,
      })
    }
    // Grok holds a list by its own rules, which differ (docs.candle.tv/harness/engines).
    if (Array.isArray(t.shell) && engine === "grok") {
      const unlistable = t.shell.filter((e) => GROK_UNLISTABLE.some((u) => e === u || e.startsWith(`${u} `)))
      if (unlistable.length) {
        out.push({
          area: "tools",
          state: "warn",
          text: `${agent} is on Grok, which won't run ${unlistable.join(", ")} from a list: Grok refuses its dangerous commands unless the shell is "everything"`,
          fix: `Pick Claude Code, OpenCode or Pi for ${agent} with ctrl-g, or set ${setting}.shell = "everything" if you mean that.`,
        })
      }
      out.push({ area: "tools", state: "ok", text: `${agent} is on Grok, which also runs its own read-only commands (ls, cat, grep…) beside the list` })
    }
    const hides = [...(t.allow ? [`offers only ${t.allow.join(", ")}`] : []), ...(t.deny.length ? [`hides ${t.deny.join(", ")}`] : [])]
    if (hides.length) out.push({ area: "tools", state: "ok", text: `${agent} ${hides.join(", and ")} (${setting})` })
  }
  return out
}

/**
 * The code runner: whether this machine can hold it, and each agent it's on for, with any program on its list that
 * isn't installed. Off for every agent until the person turns it on, so a machine that can't hold it only says why.
 */
export function runnerChecks(config: Config, support: HoldSupport, path: string | undefined): Check[] {
  const on = Object.entries(config.agents).flatMap(([agent, a]) => (runOn(a.tools?.run) ? [[agent, a.tools!.run as readonly string[]] as const] : []))
  if (!support.ok) {
    if (on.length === 0) return [{ area: "tools", state: "ok", text: `the code runner can't be held here (${support.why}), so it isn't offered; it needs ${support.fix}` }]
    return on.map(([agent]) => ({ area: "tools", state: "warn", text: `${agent}'s code runner is set, but it can't be held here (${support.why}), so it isn't offered`, fix: `It needs ${support.fix}. Or set agents.${agent}.tools.run = "off".` }))
  }
  if (on.length === 0) return [{ area: "tools", state: "ok", text: `the code runner can be held here (${support.how}); it's off for every agent: ctrl-g or the palette turns it on` }]
  return on.flatMap(([agent, programs]): Check[] => {
    const missing = programs.filter((prog) => !(prog.startsWith("/") ? existsSync(prog) : Bun.which(prog, { PATH: path ?? "/usr/bin:/bin" })))
    return [
      { area: "tools", state: "ok", text: `${agent}'s code runner is on for ${programs.join(", ")}, held to its research folder by ${support.how}, with no network` },
      ...(missing.length ? [{ area: "tools" as const, state: "warn" as const, text: `${agent}'s code runner lists ${missing.join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} installed here`, fix: `Install ${missing.length === 1 ? "it" : "them"}, or take ${missing.length === 1 ? "it" : "them"} off agents.${agent}.tools.run in config.toml.` }] : []),
    ]
  })
}

/**
 * Each agent's preset, and the person's own skills: which skills each agent
 * gets, and every folder or file in the skills folder left out, with why and what to do.
 */
export function skillChecks(p: Paths, config: Config, choices: Pick<EngineState, "preset">, home?: string): Check[] {
  const out: Check[] = []
  // And the skill folders of the person's own that are turned on, as the core reads them.
  const folders = new SkillFolders(join(p.stateDir, "skills.json"), config.skills.from, home)
  const own = loadPersonSkills(p.skillsDir, folders.on())
  for (const agent of Object.keys(config.agents)) {
    const preset = choices.preset(agent, config.agents[agent]?.preset).preset
    // The Candle Harness's own (harness-memory) is memory's guidance, on every preset; the count is Candle's and yours.
    const skills = skillsFor(preset, own.skills).filter((s) => s.origin !== "harness")
    const hidden = !toolAllowed(config.agents[agent]?.tools ?? DEFAULT_TOOLS, SKILL_TOOL_NAME)
    const which = hidden
      ? "; skill_read is hidden in config, so it has no skills"
      : skills.length === 0
        ? ", with no skills"
        : `, with ${skills.length} skill${skills.length === 1 ? "" : "s"}${own.skills.length ? ` (${own.skills.length} your own)` : ""}`
    out.push({ area: "skills", state: "ok", text: `${agent} runs as ${PRESET_LABELS[preset]}${which}` })
  }
  out.push({ area: "skills", state: "ok", text: `Candle's ${CANDLE_SKILLS.length} skills are built in from ${SKILL_SOURCE.repo} at ${SKILL_SOURCE.commit} (${SKILL_SOURCE.licence}); Quant agents get them` })
  for (const f of folders.topic().folders.filter((x) => x.on)) {
    out.push(f.exists ? { area: "skills", state: "ok", text: `the agents use the ${f.count} skill${f.count === 1 ? "" : "s"} in ${f.shown} (settings ▾ → skills), read by the core; the agents can't read the folder itself` } : { area: "skills", state: "warn", text: `${f.shown} is turned on for skills, but isn't on this machine`, fix: "Turn it off in settings ▾ → skills, or make the folder." })
  }
  for (const s of own.skipped) {
    const linked = s.name.startsWith("~") || s.name.startsWith("/")
    out.push({ area: "skills", state: "warn", text: `${s.name}${linked ? "" : " in your skills folder"} is left out: ${s.why}`, fix: linked ? "Each skill is a folder (or a link to one) holding SKILL.md, with a description in its frontmatter." : `See ${p.skillsDir}: each skill is a folder holding SKILL.md, with a description in its frontmatter.` })
  }
  return out
}

/**
 * Each agent's memory: how long its index is, read as a turn reads it. A long index
 * isn't a problem the person must fix (the agent is asked to merge it), so only one the core can't read warns.
 */
export function memoryChecks(p: Paths, config: Config): Check[] {
  return Object.keys(config.agents).map((agent): Check => {
    const dir = join(p.researchDir(agent), MEMORY_DIR)
    const read = readMemory(p.researchDir(agent))
    if (read.unread) return { area: "memory", state: "warn", text: `${agent}'s memory isn't read into its turns: ${read.unread}`, fix: `Make ${join(dir, MEMORY_INDEX)} a plain file, or clear the memory with the memory chip.` }
    const files = read.files.length ? `, and ${read.files.length} other file${read.files.length === 1 ? "" : "s"}` : ""
    if (read.index === undefined) return { area: "memory", state: "ok", text: `${agent} has no memory index yet${files}` }
    const lines = `${read.entries.length} line${read.entries.length === 1 ? "" : "s"}`
    const long = read.chars > LONG_INDEX_CHARS ? `; past ${LONG_INDEX_CHARS.toLocaleString("en-US")}, so the agent is asked to merge it` : ""
    return { area: "memory", state: "ok", text: `${agent}'s memory index is ${lines}, ${read.chars.toLocaleString("en-US")} characters${long}${files}` }
  })
}

/** The engines that can't hold a shell list, by their capabilities. */
const SHELL_LIST_OFF: readonly EngineId[] = ["codex"]

function checkStateDir(p: Paths, add: (c: Check) => void): boolean {
  const config = configProblem(p)
  if (config) {
    add({ area: "state", state: "fail", text: `${config.path} ${config.why}; config.toml names the programs the core runs with your agents' keys`, fix: config.fix })
    return false
  }
  let info
  try {
    info = lstatSync(p.stateDir)
  } catch {
    add({ area: "state", state: "ok", text: `${p.stateDir} isn't made yet; the core makes it, private (0700)` })
    return true
  }
  const fail = (why: string, fix: string) => {
    add({ area: "state", state: "fail", text: `${p.stateDir} ${why}; the core's keys and socket need a private folder`, fix })
    return false
  }
  if (info.isSymbolicLink()) return fail("is a symlink", `Replace it with a real folder: \`rm ${p.stateDir}\`, and the core makes it again.`)
  if (!info.isDirectory()) return fail("isn't a folder", `Move it aside, and the core makes the folder.`)
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return fail("belongs to another user", `Move it aside, and the core makes a new one.`)
  const mode = info.mode & 0o777
  if (mode & 0o022) return fail(`is writable by others (mode ${mode.toString(8)})`, `Run \`chmod 700 ${p.stateDir}\`.`)
  if (mode & 0o077) {
    add({ area: "state", state: "warn", text: `${p.stateDir} is readable by others (mode ${mode.toString(8)}); the core tightens it to 0700 when it starts`, fix: `Run \`chmod 700 ${p.stateDir}\`.` })
    return true
  }
  add({ area: "state", state: "ok", text: `${p.stateDir} is private (0700)` })
  return true
}

function checkKeyFile(p: Paths, agent: string, add: (c: Check) => void): string | undefined {
  const file = p.keyFile(agent)
  const addKey = `Run \`candle-harness key add --agent ${agent}\` with its key.`
  let info
  try {
    info = lstatSync(file)
  } catch {
    add({ area: "key", state: "fail", text: `${agent} has no key file (${file})`, fix: addKey })
    return undefined
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    add({ area: "key", state: "fail", text: `${file} isn't a plain file`, fix: `Remove it, then ${addKey.charAt(0).toLowerCase()}${addKey.slice(1)}` })
    return undefined
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    add({ area: "key", state: "fail", text: `${file} belongs to another user`, fix: `Remove it, then ${addKey.charAt(0).toLowerCase()}${addKey.slice(1)}` })
    return undefined
  }
  const mode = info.mode & 0o777
  const key = readFileSync(file, "utf8").trim()
  const prefix = apiKeyPrefix(key)
  if (prefix === undefined) {
    add({ area: "key", state: "fail", text: `${file} doesn't hold a Candle agent key`, fix: addKey })
    return undefined
  }
  if (mode & 0o077) {
    add({ area: "key", state: "fail", text: `${file} can be read by others (mode ${mode.toString(8)})`, fix: `Run \`chmod 600 ${file}\`.` })
  } else {
    add({ area: "key", state: "ok", text: `${agent}: key ${key.slice(0, 10)}${prefix}…, private (0600)` })
  }
  if (key.startsWith("cndl_test_")) {
    add({ area: "key", state: "warn", text: `${agent} has a test key: Candle refuses every trade from one, paper included (TEST_ENVIRONMENT_FORBIDDEN)`, fix: `Use a cndl_live_ key: ${addKey.charAt(0).toLowerCase()}${addKey.slice(1)}` })
  }
  return key
}

async function checkCandleCli(config: Config | undefined, env: Record<string, string | undefined>, redactor: Redactor, add: (c: Check) => void): Promise<boolean> {
  const route = config?.candle.mcp.route ?? "cli"
  const cliPath = config?.candle.cliPath ?? "candle"
  // The package route runs Candle's MCP server without the CLI; the agent's CLI reads still need it.
  const missingState: CheckState = route === "package" ? "warn" : "fail"
  if (route === "package") {
    const path = config!.candle.mcp.path
    if (Bun.which(path) || existsSync(path)) add({ area: "candle", state: "ok", text: `Candle's MCP package: ${path}` })
    else add({ area: "candle", state: "fail", text: `Candle's MCP package isn't installed (no "${path}" found)`, fix: "Install @candledottv/mcp, or set candle.mcp.route to \"cli\" in config.toml." })
  }
  const run = await new CandleCli({ cliPath, rpcUrl: undefined, keyFor: () => undefined, parentEnv: env }).run({ args: ["--version"], timeoutMs: 15_000 })
  if (run.exitCode === 127 && run.stderr.startsWith("couldn't start")) {
    add({ area: "candle", state: missingState, text: `the candle CLI isn't installed (no "${cliPath}" found)`, fix: INSTALL_CANDLE })
    return false
  }
  if (LOCKED_KEYCHAIN.test(run.stdout + run.stderr)) {
    add({ area: "candle", state: "fail", text: "the candle CLI can't read the macOS keychain", fix: UNLOCK_KEYCHAIN })
    return false
  }
  const version = /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1]
  if (run.exitCode !== 0 || !version) {
    add({ area: "candle", state: missingState, text: `couldn't read the candle CLI's version from \`${cliPath} --version\`: ${lastLine(redactor, run.stdout, run.stderr) || `exit ${run.exitCode}`}`, fix: INSTALL_CANDLE })
    return false
  }
  if (!versionAtLeast(version, MIN_CANDLE_CLI)) {
    add({ area: "candle", state: missingState, text: `the candle CLI is ${version}; the Candle Harness needs ${MIN_CANDLE_CLI} or later`, fix: "Run `candle update`." })
    return false
  }
  // The table of what the agent may run was read from the CLI's source at one version. A newer CLI runs,
  // and what the table doesn't hold is refused.
  const table = SOURCE.source.cliVersion
  if (!versionAtLeast(table, version)) {
    add({
      area: "candle",
      state: "warn",
      text: `the candle CLI is ${version}; the Candle Harness was checked against ${table}, so commands newer than that are refused`,
      fix: `Everything in ${table} still works. A candle-harness release checked against ${version} adds the rest.`,
    })
    return true
  }
  add({ area: "candle", state: "ok", text: `the candle CLI is ${version}, the version the Candle Harness was checked against` })
  return true
}

/** The arguments of the doctor's one-word turn: no tools, no MCP servers, none of the user's settings, nothing kept. */
export function signInTurnArgs(bin: string): string[] {
  return [
    bin, "-p",
    "--output-format", "stream-json", "--verbose",
    "--restricted", "--strict-mcp-config", "--disable-slash-commands",
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
  ]
}

async function checkClaude(p: Paths, config: Config | undefined, env: Record<string, string | undefined>, online: boolean, timeoutMs: number, inUse: boolean, add: (c: Check) => void): Promise<void> {
  const bin = config?.engine.claude.path ?? "claude"
  const childEnv = harnessEnv(env)
  const version = claudeVersion(bin, childEnv)
  // With no agent on Claude Code, a problem with it is said, but blocks nothing. With no config, setup hasn't
  // run: its step 2 installs and signs in whichever engine the person picks, so it's a warning that says so
  // (a failure there would contradict setup's "setup signs you in").
  const bad: CheckState = inUse ? "fail" : "warn"
  const viaSetup = config ? "" : "Setup's step 2 does this when you pick Claude Code (candle-harness), or: "
  if (!version.ok) {
    const missing = /isn't installed/.test(version.message)
    if (missing && !inUse && config) {
      add({ area: "claude", state: "skip", text: `Claude Code isn't installed; no agent is on it` })
      return
    }
    add({
      area: "claude",
      state: bad,
      text: missing ? `Claude Code isn't installed (no "${bin}" found)` : version.message,
      fix: missing ? `${viaSetup}Install Claude Code (https://claude.com/claude-code), sign in, or set engine.claude.path in config.toml.` : "Run `claude update`.",
    })
    return
  }
  add({ area: "claude", state: "ok", text: `Claude Code is ${version.version}` })
  for (const check of newerMajorChecks("claude", "Claude Code", version.version, CHECKED_CLAUDE_CODE)) add(check)
  if (!online) {
    add({ area: "claude", state: "skip", text: "Claude Code's sign-in wasn't checked (--offline)" })
    return
  }
  // A turn spends the user's subscription or credit: only on an engine an agent is on.
  if (!inUse && config) {
    add({ area: "claude", state: "skip", text: "Claude Code wasn't sent a one-word turn: no agent is on it" })
    return
  }

  // A folder of its own, empty: the turn has no tools, so nothing is read or written there.
  const cwd = join(p.configDir, "doctor")
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const turn = runLines("Claude Code", signInTurnArgs(bin), { cwd, parse: claudeParser(), env: childEnv, stdin: "Reply with the single word: ok" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void turn.cancel()
  }, timeoutMs)
  let outcome: { ok: true } | { ok: false; message: string } = { ok: false, message: "Claude Code ended without a reply" }
  for await (const event of turn.events) {
    if (event.type === "done") outcome = { ok: true }
    else if (event.type === "error") outcome = { ok: false, message: event.message }
  }
  clearTimeout(timer)
  if (outcome.ok) {
    add({ area: "claude", state: "ok", text: "Claude Code is signed in (a one-word turn answered)" })
  } else if (timedOut) {
    add({ area: "claude", state: bad, text: `Claude Code didn't answer a one-word turn in ${Math.round(timeoutMs / 1000)} s`, fix: "Run `claude` in a terminal and check it answers, then run candle-harness doctor again." })
  } else if (/not logged in|\/login|please run.*login/i.test(outcome.message)) {
    add({ area: "claude", state: bad, text: "Claude Code isn't signed in", fix: `${viaSetup}Run \`claude\` in a terminal and sign in with /login, then run candle-harness doctor again.` })
  } else {
    add({ area: "claude", state: bad, text: `Claude Code's one-word turn failed: ${outcome.message.slice(0, 300)}`, fix: "Run `claude` in a terminal and check it answers." })
  }
}

/** The harnesses besides Claude Code, whose sign-in the doctor checks through their own adapters. */
const OTHER_ENGINES: readonly EngineId[] = ["codex", "grok", "opencode", "pi"]

/** The names of provider keys set in the environment (`OPENROUTER_API_KEY`…), never their values; Candle's own aren't one. */
export const providerKeys = (env: Record<string, string | undefined>): string[] =>
  Object.keys(env).filter((k) => /^[A-Z][A-Z0-9_]*_API_KEY$/.test(k) && !k.startsWith("CANDLE") && env[k]).sort()

/** An engine's check message, for the doctor rather than a turn. */
const doctorWords = (message: string) => message.replace(/,? and send your message again\.$/, ".")

/**
 * Each engine but Claude Code, whether or not an agent is on it: installed, its version
 * against the minimum and what it can't do here; then, online, how many models it lists (with any it
 * held back: a Claude, ChatGPT or Grok subscription's) and whether it's signed in. An engine an agent is on also gets a one-word turn
 * through its own adapter, with its private home, gate and sandbox as a real turn has them, and an MCP
 * server with no tools in place of the core's. A problem with an engine no agent is on blocks nothing, so
 * it warns. Then each agent's choice.
 */
async function engineChecks(input: {
  p: Paths
  config: Config
  env: Record<string, string | undefined>
  online: boolean
  stateOk: boolean
  choices: Pick<EngineState, "get">
  timeoutMs: number
  shim?: string[]
  /** Each engine's own check, shared so it runs once. */
  checked?: Map<EngineId, Promise<EngineCheck>>
}): Promise<Check[]> {
  const { p, config, online, choices } = input
  const env = harnessEnv(input.env)
  // Homes of the doctor's own, so a core starting meanwhile never takes a doctor's turn for a dead one's.
  const homesDir = join(p.stateDir, "doctor-homes")
  if (online && input.stateOk) {
    await ensureStateDir(p)
    recoverHomes(homesDir)
  }
  const engines = buildEngines(config, { homesDir, stateDir: p.stateDir }, input.env)
  const agents = Object.keys(config.agents)
  const rows = await Promise.all(
    OTHER_ENGINES.map(async (id): Promise<Check[]> => {
      const engine = engines.get(id)!
      const users = agents.filter((agent) => choices.get(agent).engine === id)
      return checkEngine({ ...input, engine, users, env, userEnv: input.env, homesDir })
    }),
  )
  const out = rows.flat()
  if (!online) out.push({ area: "engine", state: "skip", text: "the other engines' models and sign-ins weren't checked (--offline)" })
  for (const agent of agents) {
    const c = choices.get(agent)
    const why = c.from === "saved" ? "picked with ctrl-g" : "config's engine.default"
    out.push({ area: "engine", state: "ok", text: `${agent} is on ${ENGINE_LABELS[c.engine]}, ${c.model ? `model ${c.model}` : "its default model"} (${why})` })
  }
  return out
}

async function checkEngine(input: {
  p: Paths
  engine: Engine
  users: string[]
  env: Record<string, string>
  /** The doctor's own environment, before it's cut down for the harness: read for provider keys' names only. */
  userEnv: Record<string, string | undefined>
  online: boolean
  stateOk: boolean
  choices: Pick<EngineState, "get">
  timeoutMs: number
  homesDir: string
  shim?: string[]
  checked?: Map<EngineId, Promise<EngineCheck>>
}): Promise<Check[]> {
  const { engine, users, env } = input
  const out: Check[] = []
  const label = engine.label
  const bad: CheckState = users.length ? "fail" : "warn"
  const onIt = users.length ? `${users.join(", ")} ${users.length === 1 ? "is" : "are"} on it` : "no agent is on it"
  const other = users.length ? ` Or pick another engine for ${users.join(", ")} with ctrl-g.` : ""

  const version = await checkOnce(input.checked, engine, env)
  if (!version.ok) {
    if (!version.version && /isn't installed/.test(version.message) && !users.length) return [{ area: "engine", state: "skip", text: `${label} isn't installed; no agent is on it` }]
    // The check's own words say how to install or update it.
    return [
      users.length
        ? { area: "engine", state: "fail", text: doctorWords(version.message), fix: `${users.join(", ")} ${users.length === 1 ? "is" : "are"} on ${label}: do that, or pick another engine with ctrl-g.` }
        : { area: "engine", state: "warn", text: `${doctorWords(version.message)} No agent is on it.` },
    ]
  }
  const gaps = gapsOf(engine.id, engine.capabilities(process.platform), process.platform)
  out.push({ area: "engine", state: "ok", text: `${label} is ${version.version} (needs ${engine.minVersion}+; ${onIt})${gaps.length ? `: ${gaps.join(", ")}` : ""}` })
  out.push(...newerMajorChecks("engine", label, version.version, engine.checkedVersion))
  if (!input.online) return out
  // Codex's and Grok's model reads make private homes too.
  if (!input.stateOk) {
    out.push({ area: "engine", state: "skip", text: `${label}'s models and sign-in weren't checked: the state folder needs fixing first` })
    return out
  }
  const signIn = engine.signIn ? ` (${engine.signIn})` : ""

  let models: EngineModel[]
  try {
    models = await engine.models(env)
  } catch (error) {
    out.push({ area: "engine", state: bad, text: `${label} couldn't list its models: ${(error as Error).message.slice(0, 300)}`, fix: `Run ${label} in a terminal and check it starts.${other}` })
    return out
  }
  for (const note of engine.modelNotes?.() ?? []) out.push({ area: "engine", state: "ok", text: note })
  const signed = await engine.signedIn?.(env).catch(() => undefined)
  if (signed === false || (engine.needsModel && models.length === 0)) {
    const what = engine.needsModel ? `${label} has no models to run: it lists none with a key or a sign-in` : `${label} isn't signed in`
    // A key only in the environment never reaches an engine, whose environment is cut down.
    const keys = engine.needsModel ? providerKeys(input.userEnv) : []
    const unseen = keys.length ? ` ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set in your shell, but engines don't get your environment here: store the key in ${label} itself.` : ""
    out.push({ area: "engine", state: bad, text: `${what} (${onIt})`, fix: `Sign in${signIn}, then run candle-harness doctor again.${unseen}${other}` })
    return out
  }
  const listed = `${models.length} model${models.length === 1 ? "" : "s"}`
  // An engine nobody is on would send its turn to its own default, such as the priciest model on the user's
  // OpenRouter key. A turn spends their credit, so only an engine an agent is on gets one.
  if (!users.length) {
    out.push({ area: "engine", state: "ok", text: `${label} lists ${listed}${signed === true ? " and is signed in" : ""}; no one-word turn was sent, since no agent is on it` })
    return out
  }

  // The turn runs on the model an agent picked here, else the harness's own default by name.
  const model = users.map((agent) => input.choices.get(agent).model).find(Boolean) ?? engine.defaultModel?.()
  if (engine.needsModel && !model) {
    out.push({
      area: "engine",
      state: "warn",
      text: `${label} lists ${listed} but has no default of yours, so no one-word turn was sent`,
      fix: `Pick a model for ${users.join(", ")} with ctrl-g; their next message opens the picker otherwise.`,
    })
    return out
  }

  const outcome = await signInTurn({ ...input, ...(model ? { model } : {}) })
  const on = model ? ` on ${model}` : ""
  if (outcome.ok) out.push({ area: "engine", state: "ok", text: `${label} is ready: a one-word turn answered${on} (it lists ${listed})` })
  else if (outcome.timedOut) {
    out.push({ area: "engine", state: bad, text: `${label} didn't answer a one-word turn${on} in ${Math.round(input.timeoutMs / 1000)} s`, fix: `Run ${label} in a terminal and check it answers, then run candle-harness doctor again.${other}` })
  } else {
    // Out of credit isn't a sign-in (Grok's "402 Payment Required … usage balance exhausted" was once told to sign in).
    const fix = outOfCredit(outcome.message) ? `${label}'s account is out of credit or over its usage limit: top it up with ${label}'s provider, or wait for the limit to reset.` : `Run ${label} in a terminal and check it answers${signIn ? `; to sign in${signIn}` : ""}.`
    out.push({ area: "engine", state: bad, text: `${label}'s one-word turn${on} failed: ${engine.explain(outcome.message).slice(0, 300)}`, fix: `${fix}${other}` })
  }
  return out
}

/** A refusal for money, not for sign-in: HTTP 402, or a provider's words for an empty balance or a spent quota. */
export const outOfCredit = (message: string | undefined): boolean =>
  /\b402\b|payment required|balance (is )?exhausted|insufficient (credit|balance|funds)|out of credits?|quota exceeded|credit balance is too low/i.test(message ?? "")

/**
 * One turn asking for one word, through the engine's own adapter; its folders are removed after. Also
 * onboarding's test message: no agent exists yet, so it's this turn, with the same private
 * home, gate and sandbox a real turn uses and an MCP server with no tools; its reply and time are shown.
 */
export async function signInTurn(input: { p: Paths; engine: Engine; env: Record<string, string>; homesDir: string; timeoutMs: number; model?: string; shim?: string[] }): Promise<{ ok: true; text?: string } | { ok: false; timedOut: boolean; message?: string }> {
  const { p, engine } = input
  // A research folder of its own, empty: nothing is asked of it, and the turn has no Candle tools.
  const researchDir = join(p.configDir, "doctor", engine.id)
  await mkdir(researchDir, { recursive: true, mode: 0o700 })
  await mkdir(input.homesDir, { recursive: true, mode: 0o700 })
  const workDir = await mkdtemp(join(input.homesDir, `${engine.id}-`))
  const shim = input.shim ?? selfCommand()
  const turn = engine.start({
    prompt: "Reply with the single word: ok",
    systemPrompt: "This is a check that you answer. Reply with exactly the word the user asks for, and use no tools.",
    researchDir,
    mcpConfig: "",
    mcp: { command: shim[0]!, args: [...shim.slice(1), "mcp", "--empty"], env: { CANDLE_HARNESS_HOME: p.configDir } },
    ...(input.model ? { model: input.model } : {}),
    env: input.env,
    workDir,
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void turn.cancel()
  }, input.timeoutMs)
  let outcome: { ok: true; text?: string } | { ok: false; timedOut: boolean; message?: string } = { ok: false, timedOut: false }
  try {
    for await (const event of turn.events) {
      if (event.type === "done") outcome = { ok: true, ...(event.text ? { text: event.text } : {}) }
      else if (event.type === "error") outcome = { ok: false, timedOut: false, message: event.message }
    }
  } finally {
    clearTimeout(timer)
    removeAll(workDir)
  }
  return timedOut && !outcome.ok ? { ok: false, timedOut: true } : outcome
}

/** Whether this machine has a vault, read as the core reads it before an owner card: no unlock, no prompt. */
async function checkVault(p: Paths, config: Config | undefined, env: Record<string, string | undefined>, redactor: Redactor): Promise<Check> {
  const cli = new CandleCli({ cliPath: config?.candle.cliPath ?? "candle", rpcUrl: undefined, keyFor: () => undefined, parentEnv: env, profile: () => config?.candle.profile })
  const run = await cli.run({ args: ["vault", "status"], json: true, timeoutMs: 15_000 }).catch(() => undefined)
  const body = record(run?.json)
  if (run?.exitCode === 0 && body?.ok === true) {
    const factors = Array.isArray(body.envelopes) ? body.envelopes.length : 0
    const counted = factors > 0 ? `, with ${factors} factor${factors === 1 ? "" : "s"}` : ""
    return { area: "vault", state: "ok", text: `a vault is on this machine${counted}: owner steps through the Candle Harness ask for it in the prompt pane` }
  }
  if (body?.code === "VAULT_MISSING") {
    // A vault the core saw here that's gone now refuses owner steps, rather than running them without the factor.
    if (existsSync(p.vaultSeen)) {
      return {
        area: "vault",
        state: "fail",
        text: "this machine had a vault, and the candle CLI can't find it now: the Candle Harness refuses owner steps until it's back",
        fix: "Restore it from its backup: type `candle vault restore` in the Candle Harness, or run it in your own terminal. If you removed it on purpose, type `forget vault` in the Candle Harness.",
      }
    }
    return {
      area: "vault",
      state: "warn",
      text: "no vault: owner steps run without a factor, approved by you in the prompt pane, which the agent can't type in",
      fix: "Type `candle vault init` in the Candle Harness to set one up: from then on every owner step asks for its factor. A TEE wallet or a send from the Candle Harness needs one. Trades don't.",
    }
  }
  const output = run ? `${run.stdout}\n${run.stderr}` : ""
  if (LOCKED_KEYCHAIN.test(output)) return { area: "vault", state: "warn", text: "couldn't read this machine's vault: the candle CLI can't read the macOS keychain", fix: UNLOCK_KEYCHAIN }
  const why = typeof body?.message === "string" ? redactor.text(body.message).slice(0, 300) : run ? lastLine(redactor, run.stdout, run.stderr) || `exit ${run.exitCode}` : "candle vault status didn't run"
  return { area: "vault", state: "warn", text: `couldn't tell whether this machine has a vault: ${why}`, fix: "Run `candle vault status` in your own terminal to see why. Until it answers, owner steps through the Candle Harness ask for the factor." }
}

/**
 * Agent keys with Withdraw access (transfer:write), from the owner's key list: they can move funds with
 * their own key, outside any card. The Candle Harness never does, so none is expected; the line says
 * so plainly either way. A revoked key moves nothing, and a key on another account wasn't read.
 */
function withdrawKeys(prefixes: Map<string, string>, owned: Map<string, KeyRow>): Check[] {
  const read = [...prefixes].flatMap(([agent, prefix]) => {
    const row = owned.get(prefix)
    return row && typeof row.revokedAt !== "number" ? [{ agent, prefix, scopes: Array.isArray(row.scopes) ? row.scopes : [] }] : []
  })
  if (read.length === 0) return []
  const withdraw = read.filter((k) => k.scopes.includes("transfer:write"))
  if (withdraw.length === 0) {
    return [{ area: "access", state: "ok", text: "no agent key is Withdraw: none can move funds with its own key, and funds out goes from your vault, in the prompt pane" }]
  }
  return withdraw.map((k) => ({
    area: "access",
    state: "warn",
    text: `${k.agent}'s key is Withdraw (transfer:write): it can move funds out with its own key, outside any card. The Candle Harness never moves funds with an agent's key, only from your vault`,
    fix: `Unless it needs that, narrow it to Write: type \`candle keys access ${k.prefix} --access write\` in the Candle Harness (it opens the prompt pane for your factor), or run it in your own terminal. The key keeps trading.`,
  }))
}

type KeyRow = Record<string, unknown> & { keyPrefix: string }

/** The owner's key list by prefix, or undefined (with a check saying why) when the CLI can't read it. */
async function ownerKeyRows(config: Config, env: Record<string, string | undefined>, redactor: Redactor, add: (c: Check) => void): Promise<Map<string, KeyRow> | undefined> {
  const cli = new CandleCli({ cliPath: config.candle.cliPath, rpcUrl: undefined, keyFor: () => undefined, parentEnv: env, profile: () => config.candle.profile })
  let run: CliResult
  try {
    run = await cli.run({ args: ["keys", "list"], json: true, timeoutMs: 30_000 })
  } catch (error) {
    add({ area: "access", state: "warn", text: `couldn't run \`candle keys list\`: ${(error as Error).message}` })
    return undefined
  }
  const output = `${run.stdout}\n${run.stderr}`
  const rows = record(run.json)?.keys
  if (run.exitCode === 0 && Array.isArray(rows)) {
    const byPrefix = new Map<string, KeyRow>()
    for (const row of rows) {
      const r = record(row)
      if (r && typeof r.keyPrefix === "string") byPrefix.set(r.keyPrefix, r as KeyRow)
    }
    return byPrefix
  }
  if (LOCKED_KEYCHAIN.test(output)) {
    add({ area: "access", state: "fail", text: "the candle CLI can't read the macOS keychain, so each key's access wasn't checked", fix: UNLOCK_KEYCHAIN })
  } else if (NOT_SIGNED_IN.test(output)) {
    add({ area: "access", state: "skip", text: "your candle CLI isn't signed in here, so each key's access level wasn't checked", fix: "Run `candle auth login`, or check each key in Candle's agent console." })
  } else if (run.exitCode === 0) {
    add({ area: "access", state: "warn", text: "`candle keys list --json` answered in a shape the Candle Harness doesn't know, so each key's access wasn't checked", fix: "Run `candle update`; if it stays, report it." })
  } else {
    add({ area: "access", state: "warn", text: `\`candle keys list\` failed (exit ${run.exitCode}), so each key's access wasn't checked: ${lastLine(redactor, run.stdout, run.stderr)}` })
  }
  return undefined
}

async function checkAgent(input: {
  p: Paths
  config: Config
  env: Record<string, string | undefined>
  agent: string
  key: string
  redactor: Redactor
  now: () => number
  mcp: Pick<ChildOptions, "connectTimeoutMs">
  owned: Map<string, KeyRow> | undefined
  cliOk: boolean
  /** Whether Final Stretch is on here is the account's, so one agent's server is asked. */
  askStretch?: boolean
}): Promise<{ checks: Check[]; read?: TeeRead; stretch?: ReturnType<typeof stretchFrom> }> {
  const { p, config, agent, key, redactor } = input
  const out: Check[] = []
  let read: TeeRead | undefined
  let stretch: ReturnType<typeof stretchFrom> | undefined
  const done = () => ({ checks: out, ...(read ? { read } : {}), ...(stretch ? { stretch } : {}) })
  const add = (state: CheckState, text: string, fix?: string) => void out.push({ area: "candle", state, text: `${agent}: ${text}`, ...(fix ? { fix } : {}) })
  const prefix = apiKeyPrefix(key)!

  // Candle's MCP server with this agent's key, as the core starts it, in the same private folder.
  try {
    await ensureStateDir(p)
  } catch (error) {
    if (error instanceof UnsafeStateDir) return done()
    throw error
  }
  const configDir = candleConfigDir(p.stateDir, agent)
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const route = config.candle.mcp.route
  const spec = childLaunch({ route, path: route === "cli" ? config.candle.cliPath : config.candle.mcp.path, apiKey: key, configDir, parentEnv: input.env })
  // One start, no restarts: the doctor reports what happened and stops it.
  const child = new CandleMcpChild(agent, spec, { ...input.mcp, backoffMs: [24 * 60 * 60 * 1000] })
  let rejected: string | undefined
  let tee: { status: AgentStatus; wallets: ToolOutcome; portfolio: ToolOutcome } | undefined
  try {
    await child.start()
    const status = child.status()
    if (status.state !== "ready") {
      const reason = "reason" in status ? status.reason : status.state
      const stderr = child.stderrTail()
      if (LOCKED_KEYCHAIN.test(stderr)) add("fail", "Candle's MCP server can't read the macOS keychain", UNLOCK_KEYCHAIN)
      else add("fail", `${redactor.text(reason)}${stderr.trim() ? ` (${lastLine(redactor, stderr)})` : ""}`, status.state === "refused" ? undefined : "Run candle-harness doctor again; if it stays, run `candle doctor` to check the CLI itself.")
      return done()
    }
    const outcome = await child.call("candle_execution_status", {}, { timeoutMs: STATUS_TIMEOUT_MS })
    const judged = judgeStatus(outcome, { agent, prefix, version: status.version }, add)
    rejected = judged.code
    if (judged.status) {
      const wallets = await child.call("candle_get_profile_wallets", { keyPrefix: prefix }, { timeoutMs: STATUS_TIMEOUT_MS })
      const portfolio = await child.call("candle_get_portfolio", {}, { timeoutMs: STATUS_TIMEOUT_MS })
      tee = { status: judged.status, wallets, portfolio }
      if (input.askStretch) stretch = stretchFrom(await child.call("candle_get_feed", { bucket: "finalstretch", chain: "solana", fields: "name", limit: 1 }, { timeoutMs: STATUS_TIMEOUT_MS }))
    }
  } finally {
    await child.stop()
  }
  if (tee) {
    const result = await teeChecks({ ...input, ...tee })
    out.push(...result.checks)
    read = result.read
  }

  // What the owner's key list says of this key: access, revocation, expiry.
  if (!input.owned) return done()
  const row = input.owned.get(prefix)
  if (!row) {
    add("warn", `key ${prefix} isn't on the account your candle CLI is signed in to, so its access level wasn't checked`, "Check it in Candle's agent console, or sign the CLI in to this key's account.")
    return done()
  }
  if (typeof row.revokedAt === "number") {
    if (rejected !== "UNAUTHORIZED") add("fail", `its key was revoked on ${day(row.revokedAt)}`, newKey(agent))
    return done()
  }
  if (typeof row.expiresAt === "number") {
    if (row.expiresAt <= input.now()) {
      if (rejected !== "KEY_EXPIRED") add("fail", `its key expired on ${day(row.expiresAt)}`, newKey(agent))
      return done()
    }
    if (row.expiresAt - input.now() < EXPIRY_WARNING_MS) {
      add("warn", `its key expires on ${day(row.expiresAt)}; a key's expiry is fixed when it's made`, `Before then: ${newKey(agent)}`)
    }
  }
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === "string") : []
  if (!scopes.includes("swap:write")) {
    add(
      "fail",
      `its key can't trade: it has ${scopes.length ? scopes.join(", ") : "no scopes"}, without swap:write (a key made without --access write)`,
      `In your own terminal: \`candle keys access ${prefix} --access write\` (it asks you to type the prefix back), or ${newKey(agent).charAt(0).toLowerCase()}${newKey(agent).slice(1)}`,
    )
  } else {
    add("ok", "its key has Write access (swap:write)")
  }
  const cap = keyCapUse(row)
  // The reserved figure is what Candle checks a buy against, built as each trade reserves: a TEE wallet's
  // sell reserves nothing and counts when it books (docs.candle.tv/developers/agent-trading). The booked
  // figure beside it counts every fill, over the calendar period rather than the key's own window.
  if (cap) {
    const left = cap.limit - cap.used
    const booked =
      cap.booked === undefined
        ? "and a TEE wallet's sells count towards it without showing here"
        : Math.abs(cap.booked - cap.used) < 0.005
          ? "and its fills agree"
          : `and its fills book ${usdText(cap.booked)} ${CAP_WINDOW[cap.reset]}, a TEE wallet's sells included, which the figure Candle checks counts only as they settle`
    const text = `Candle's cap on its key: ${usdText(cap.used)} of ${usdText(cap.limit)} used ${capWindow(cap.reset)}, counting buys, sells and swaps; selling a token is never refused by it, ${booked}`
    if (left < cap.limit * 0.1) add("warn", text, `Buys and swaps are refused when it's used up, until it resets${cap.reset === "never" ? " (it never does)" : ""}. To change the cap, in your own terminal: \`candle keys limit ${prefix} --tx-limit <usd>\`.`)
    else add("ok", text)
  }
  return done()
}

/**
 * The next midnight UTC in local time, such as "20:00 here": the Candle Harness's own day limit runs to local midnight,
 * Candle's cap to UTC's. West of UTC, just after its midnight, the next one is tomorrow's evening here, and a
 * bare "19:00 here" read at 19:02 looks already past, so it says "tomorrow" then.
 */
export const utcMidnightHere = (now = new Date()): string => {
  const d = new Date(now)
  d.setUTCHours(24, 0, 0, 0)
  const tomorrow = d.getDate() !== now.getDate()
  return `${d.toTimeString().slice(0, 5)} here${tomorrow ? " tomorrow" : ""}`
}
const CAP_WINDOW = { daily: "today (UTC)", weekly: "this week (UTC)", monthly: "this month (UTC)", never: "in all" } as const
/** The window's words, with when Candle's day ends locally where that isn't midnight. */
const capWindow = (reset: keyof typeof CAP_WINDOW): string => (reset === "daily" && new Date().getTimezoneOffset() !== 0 ? `today (UTC, to ${utcMidnightHere()})` : CAP_WINDOW[reset])
const usdText = (n: number) => `$${n.toFixed(2)}`

/**
 * A key's Candle cap and how much of it is used, from the owner's key list, by the CLI's own rule
 * (cli/src/commands/core.ts, keyLimitOf): the window's reservation when there is one, else the usage field
 * for the cap's window. No agent-key read has it, and the Candle Harness's own count isn't it: that counts only buys,
 * while Candle's cap counts all volume.
 */
export function keyCapUse(row: Record<string, unknown>): { limit: number; used: number; booked?: number; reset: keyof typeof CAP_WINDOW } | undefined {
  const limit = record(row.txLimit)
  if (typeof limit?.usdMicros !== "number") return undefined
  const reset = limit.reset === "weekly" || limit.reset === "monthly" || limit.reset === "never" ? limit.reset : "daily"
  const reserved = record(row.emberWindow)?.reservedUsdMicros
  const field = { daily: "todayUsdMicros", weekly: "weekUsdMicros", monthly: "monthUsdMicros", never: "lifetimeUsdMicros" }[reset]
  const fills = record(row.usage)?.[field]
  const used = typeof reserved === "number" ? reserved : fills
  return {
    limit: limit.usdMicros / 1e6,
    used: (typeof used === "number" ? used : 0) / 1e6,
    // The booked figure, beside the reserved one where both are read.
    ...(typeof reserved === "number" && typeof fills === "number" ? { booked: fills / 1e6 } : {}),
    reset,
  }
}

/** The execution-status read, judged: the refusal code when Candle refused it, the status when it answered. */
function judgeStatus(outcome: ToolOutcome, ctx: { agent: string; prefix: string; version: string }, add: (state: CheckState, text: string, fix?: string) => void): { code?: string; status?: AgentStatus } {
  if (outcome.kind === "lost") {
    add("fail", `Candle didn't answer the status read (${outcome.reason.replace("_", " ")})`, "Run candle-harness doctor again; check your network if it stays.")
    return {}
  }
  if (outcome.kind === "error") {
    const body = record(outcome.body)
    const error = record(body?.error) ?? record(record(body?.api)?.error) ?? {}
    const code = outcome.code
    switch (code) {
      case "UNAUTHORIZED":
        add("fail", "Candle doesn't accept this key: it was revoked, mistyped, or made on another Candle deployment", newKey(ctx.agent))
        break
      case "KEY_EXPIRED":
        add("fail", "this key has expired, and only a new key fixes that", newKey(ctx.agent))
        break
      case "PROFILE_PAUSED":
        add("fail", "Candle has this agent paused, so it can't trade", "The owner resumes it in Candle's agent console.")
        break
      case "RISK_LIMIT_REACHED":
        add("fail", "Candle stopped this agent: it reached a loss limit or tripped its circuit breaker, and waiting won't clear it", "The owner reviews it and resumes it in Candle's agent console.")
        break
      case "RATE_LIMITED":
        add("warn", "Candle is rate-limiting this key", "Run candle-harness doctor again in a minute.")
        break
      default:
        add("fail", refusalMessage(code, error) ?? `Candle refused the status read (${code})`, "Run `candle doctor`, and check the key in Candle's agent console.")
    }
    return { code }
  }
  const status = parseExecutionStatus(outcome.result, Date.now())
  if (!status) {
    add("fail", "Candle's status read came back in a shape the Candle Harness doesn't know", "Run `candle update`; if it stays, report it.")
    return {}
  }
  if (status.unreadable.length > 0) {
    add("fail", `Candle couldn't read this key's ${status.unreadable.join(", ")}. Fix that before anything else: a trade can fail for the same reason`, "Run candle-harness doctor again shortly; if it stays, check the key in Candle's agent console.")
  }
  // The plan by name: TEE wallets need Pro or Max, and buying a token Candle didn't launch does too.
  const planName = status.tier ? `${status.tier.charAt(0).toUpperCase()}${status.tier.slice(1)}` : undefined
  const feeText = status.feeBps !== undefined ? `fee ${status.feeBps / 100}%` : undefined
  const freeNote = status.tier === "free" ? "TEE wallets need Pro or Max" : undefined
  const plan = planName ? `, plan ${planName}${feeText || freeNote ? ` (${[feeText, freeNote].filter(Boolean).join("; ")})` : ""}` : feeText ? `, plan ${feeText}` : ""
  const limit = status.keyLimit ? `, Candle key limit $${status.keyLimit.usd} ${status.keyLimit.reset}` : ", no Candle key limit"
  // Candle doesn't always state it (a Free key's read didn't): then the plan's figure, as the Candle Harness keeps to it.
  const byPlan = status.tier ? PLAN_LIMITS[status.tier] : undefined
  const requests = status.rateLimitPerMin !== undefined ? `; Candle allows the key ${status.rateLimitPerMin} requests a minute` : byPlan !== undefined ? `; ${byPlan} requests a minute on ${planName}, which the Candle Harness keeps its reads inside (Candle's read doesn't state the key's own)` : ""
  // A warning, not a failure: a key the Candle Harness makes starts denied by design, and reads and paper work.
  if (status.embeddedWallet === "denied") {
    add(
      "warn",
      "its key isn't allowed the account's embedded wallet, so its live cards from it are refused (reads and paper trades still work)",
      `Type it in the Candle Harness, as the owner: \`candle keys update ${ctx.prefix} --embedded-wallet allow\`. It opens the prompt pane, where you give your factor and type the prefix back.`,
    )
    // The plan, the key's limit and its requests a minute are the key's whatever its wallets.
    if (status.unreadable.length === 0) add("ok", `Candle answers (MCP server ${ctx.version})${plan}${limit}${requests}`)
    return { status }
  }
  if (!status.wallets.solana) {
    add("warn", "Candle reported no Solana embedded wallet for this account", "Check the account's wallets in the Candle app.")
    return { status }
  }
  if (status.unreadable.length === 0) add("ok", `Candle answers (MCP server ${ctx.version}); trades from the embedded wallet ${short(status.wallets.solana)}${plan}${limit}${requests}`)
  return { status }
}

interface TeeRead {
  status: AgentStatus
  /** The TEE wallets its key holds, joined to the portfolio; undefined when that couldn't be read. */
  tee: TeeWallet[] | undefined
  portfolio: unknown
}

/** One agent's TEE wallets: the plan, active, and its signer on this machine. */
async function teeChecks(input: {
  config: Config
  env: Record<string, string | undefined>
  agent: string
  key: string
  redactor: Redactor
  cliOk: boolean
  status: AgentStatus
  wallets: ToolOutcome
  portfolio: ToolOutcome
}): Promise<{ checks: Check[]; read: TeeRead }> {
  const { agent, config, status, redactor } = input
  const checks: Check[] = []
  const add = (state: CheckState, text: string, fix?: string) => void checks.push({ area: "wallet", state, text: `${agent}: ${text}`, ...(fix ? { fix } : {}) })
  const portfolio = input.portfolio.kind === "ok" ? input.portfolio.result : undefined
  const parsed = input.wallets.kind === "ok" ? parseProfileWallets(input.wallets.result) : undefined
  let tee: TeeWallet[] | undefined
  if (!parsed) {
    const why = input.wallets.kind === "error" ? input.wallets.code : input.wallets.kind === "lost" ? `no answer (${input.wallets.reason})` : "an unknown shape"
    add("warn", `couldn't read which TEE wallets its key holds (candle_get_profile_wallets: ${why})`, "Run candle-harness doctor again; if it stays, run `candle keys wallets <prefix>`.")
  } else if (parsed.scope === "all" && parsed.rows.length === 0) {
    // An empty list under scope "all" says nothing about binding: the core asks the CLI per wallet.
    add("skip", "its key's wallet scope is all, so its TEE wallets are found when the core runs, wallet by wallet")
  } else {
    tee = joinTee(parsed.rows, portfolio)
  }
  const held = tee ?? []
  const free = status.tier === "free"
  if (free && held.length > 0) {
    add("warn", `its key holds TEE wallet ${held.map((t) => teeName(t)).join(", ")}, but the plan is Free: TEE wallets need Pro or Max, so its TEE cards are refused`, "Move the account to Pro or Max in the Candle app, or trade from the embedded wallet.")
  }
  // The signer: `candle wallets --json` with this agent's key says, per wallet id, whether it's here.
  // Solana's and Hood's alike: `candle wallets` lists every linked wallet's signer by id.
  const active = held.filter((t) => t.active)
  let signers: Record<string, unknown> | undefined
  let signerError: string | undefined
  if (active.length > 0 && input.cliOk && !free) {
    const cli = new CandleCli({ cliPath: config.candle.cliPath, rpcUrl: undefined, keyFor: () => input.key, parentEnv: input.env, profile: () => config.candle.profile })
    const run = await cli.run({ agent, args: ["wallets"], json: true, timeoutMs: 30_000 }).catch((error: Error) => ({ exitCode: -1, stdout: "", stderr: error.message, json: undefined }))
    signers = record(record(run.json)?.signers)
    if (run.exitCode !== 0 || !signers) {
      signers = undefined
      signerError = lastLine(redactor, run.stdout, run.stderr) || `exit ${run.exitCode}`
    }
  }
  for (const t of held) {
    const name = `${t.chain === "hood" ? "Hood " : ""}TEE wallet ${teeName(t)} (${short(t.address)})`
    if (t.chain !== "solana" && t.chain !== "hood") add("ok", `${name} is on ${terminalText(t.chain, { maxLength: 16 })}, a chain the Candle Harness doesn't trade on`)
    else if (!t.active) add("warn", `${name} is stopped on Candle's side (inactive), so its cards are refused`, "Turning it back on is the owner's step, in their own terminal.")
    else if (free || !input.cliOk) continue
    else if (signerError !== undefined) add("warn", `couldn't read whether ${name}'s signer is on this machine: ${signerError}`, "Run `candle wallets` with this agent's key to see it.")
    else if (signers?.[t.id] === "stored") add("ok", `${name} is active, and its signer is on this machine`)
    else {
      const said = typeof signers?.[t.id] === "string" ? ` (${terminalText(String(signers[t.id]), { maxLength: 32 })})` : ""
      add(
        "warn",
        `${name}'s signer isn't on this machine${said}, so its trades from here fail (SIGNER_UNAVAILABLE)`,
        "The relay signer stays on the machine that promoted it: trade the wallet from there, or give the key a key signer here (docs.candle.tv/developers/cli-custody).",
      )
    }
  }
  return { checks, read: { status, tee, portfolio } }
}

/** Each agent's default wallet, when set, still pays; read once every agent's wallets are. */
/**
 * Wallet names: wallets.toml's problems by line, a name of the Candle Harness's left unused since Candle
 * or the vault names the wallet, and a name that breaks the Candle Harness's rules (marked, and taken by address only), each
 * with the rename that fixes it. From what the doctor read (each key's TEE wallets and the account's portfolio)
 * and what the core keeps (the vault keys from the last `vault list`).
 */
export async function nameChecks(p: Paths, config: Config, reads: ReadonlyMap<string, TeeRead>): Promise<Check[]> {
  const checks: Check[] = []
  const file = new WalletsFileStore(p.walletsFile).read()
  for (const problem of file.problems) checks.push({ area: "wallet", state: "warn", text: `${problem}: the Candle Harness won't write wallets.toml until it's fixed`, fix: `Fix that line in ${p.walletsFile}.` })
  let vaultKeys: { address: string; label?: string }[] = []
  try {
    const kept = JSON.parse(await readFile(p.destinations, "utf8")) as { vaultList?: { address?: unknown; label?: unknown; kind?: unknown }[] }
    vaultKeys = (kept.vaultList ?? []).flatMap((d) => (typeof d.address === "string" && d.kind === "vault-key" ? [{ address: d.address, ...(typeof d.label === "string" ? { label: d.label } : {}) }] : []))
  } catch {
    vaultKeys = []
  }
  const tee = new Map<string, { address: string; label?: string }>()
  const embedded = new Set<string>()
  for (const read of reads.values()) {
    for (const t of portfolioTee(read.portfolio)) tee.set(t.address, { address: t.address, ...(t.label ? { label: t.label } : {}) })
    for (const t of read.tee ?? []) if (!tee.has(t.address)) tee.set(t.address, { address: t.address, ...(t.label ? { label: t.label } : {}) })
    if (read.status.wallets.solana) embedded.add(read.status.wallets.solana)
  }
  const names = buildNames({ embedded: [...embedded], tee: [...tee.values()], linked: [], vaultKeys, other: [], harness: file.names, agents: Object.keys(config.agents) })
  for (const e of names) {
    const called = walletName(names, e)
    if (e.marked) checks.push({ area: "wallet", state: "warn", text: `${called} (${short(e.address)}) is taken by address only: ${e.marked}`, fix: `Rename it: ${renameCommand(e)}.` })
    if (e.shadowed) checks.push({ area: "wallet", state: "ok", text: `wallets.toml names ${short(e.address)} ${e.shadowed}, but ${e.owner === "vault" ? "the vault" : "Candle"} calls it ${called}, which wins`, fix: `Rename it where it's kept (${renameCommand(e)}), or drop its line from wallets.toml.` })
  }
  const own = Object.keys(file.names).length
  if (own > 0 && checks.length === 0) checks.push({ area: "wallet", state: "ok", text: `wallets.toml names ${own} wallet${own === 1 ? "" : "s"}, each by the Candle Harness's rules` })
  // Wallet groups: they organise only, so a problem is a warning, never a failure.
  const groups = resolveGroups(file.groups, names, Object.keys(config.agents))
  for (const g of groups) {
    if (g.marked) checks.push({ area: "wallet", state: "warn", text: `the group ${g.name} is named like a wallet (${g.marked}), so it's hard to tell apart from it`, fix: `Rename the group in ${p.walletsFile}, or the wallet.` })
    for (const word of g.unknown) checks.push({ area: "wallet", state: "warn", text: `the group ${g.name} lists ${terminalText(word, { maxLength: 64 })}, which isn't a wallet the Candle Harness knows (or two wallets share that name): it's kept, and shows nothing`, fix: `Drop it from the group in ${p.walletsFile}, or name it by its address.` })
  }
  if (groups.length) {
    const words = groups.map((g) => `${g.name} (${g.members.length}${g.prefix !== undefined ? ` wallet${g.members.length === 1 ? "" : "s"}, names starting ${g.prefix}` : ""})`)
    checks.push({ area: "wallet", state: "ok", text: `${groups.length} wallet group${groups.length === 1 ? "" : "s"}: ${words.join(", ")}` })
  }
  return checks
}

function defaultWalletChecks(config: Config, reads: Map<string, TeeRead>, prefixes: Map<string, string>, pins: Record<string, DefaultPin> = {}): Check[] {
  const checks: Check[] = []
  const boundTo = (address: string) => [...reads].find(([, r]) => r.tee?.some((t) => t.address === address))?.[0]
  for (const [agent, read] of reads) {
    const word = config.agents[agent]?.wallet
    if (word === undefined || read.tee === undefined) continue
    const { status } = read
    const prefix = prefixes.get(agent)
    const defaultPin = pinnedAddress(pins, agent, word)
    const ctx = {
      agent,
      payable: {
        ...(status.embeddedWallet === "allowed" && status.wallets.solana ? { embedded: { address: status.wallets.solana, chain: "solana" as const } } : {}),
        tee: read.tee,
        readAt: Date.now(),
        unreadable: [],
        ...(status.tier ? { tier: status.tier } : {}),
      },
      embeddedWallet: status.embeddedWallet,
      ...(prefix ? { prefix } : {}),
      account: portfolioTee(read.portfolio),
      boundTo,
      defaultWallet: word,
    }
    // Followed by the address it was last found at (default-pins.ts), as the core pays: a rename leaves the line's name behind.
    const picked = resolvePayer({ ...ctx, ...(defaultPin ? { defaultPin } : {}) })
    const byLine = defaultPin ? resolvePayer(ctx) : picked
    const add = (state: CheckState, text: string, fix?: string) => void checks.push({ area: "wallet", state, text: `${agent}: ${text}`, ...(fix ? { fix } : {}) })
    const paysFrom = picked.ok ? (picked.kind === "embedded" ? "the embedded wallet" : teeName(picked)) : ""
    const line = `agents.${agent}.wallet = "${terminalText(word, { maxLength: 64 })}"`
    if (picked.ok && !(byLine.ok && byLine.address === picked.address)) {
      const now = picked.kind === "tee" && picked.label ? picked.label : undefined
      add("warn", `pays from ${paysFrom} when a trade names no wallet, by its address: config.toml's line (${line}) is that wallet's old name`, `Change agents.${agent}.wallet in config.toml to ${now ? `"${now}"` : "its name now"} (or its address), so the line says what it pays from.`)
    } else if (picked.ok) add("ok", `pays from ${paysFrom} when a trade names no wallet (agents.${agent}.wallet)`)
    else add("warn", picked.message.replace(/ Change it in config\.toml, or name a wallet\.$/, ""), `Edit agents.${agent}.wallet in config.toml, or remove it to pay from the embedded wallet.`)
  }
  return checks
}

/**
 * TEE wallets bound to a revoked key: no key can trade them, and Candle gives no warning.
 * The owner's `candle keys wallets <prefix> --json` still lists them, so each revoked key is asked.
 */
async function strandedWallets(config: Config, env: Record<string, string | undefined>, owned: Map<string, KeyRow>, prefixes: Map<string, string>): Promise<Check[]> {
  const revoked = [...owned.values()].filter((r) => typeof r.revokedAt === "number").sort((a, b) => (b.revokedAt as number) - (a.revokedAt as number))
  if (revoked.length === 0) return []
  const cli = new CandleCli({ cliPath: config.candle.cliPath, rpcUrl: undefined, keyFor: () => undefined, parentEnv: env, profile: () => config.candle.profile })
  const checks: Check[] = []
  const unread: string[] = []
  for (const row of revoked.slice(0, REVOKED_KEYS_CHECKED)) {
    const run = await cli.run({ args: ["keys", "wallets", row.keyPrefix], json: true, timeoutMs: 30_000 }).catch(() => undefined)
    const parsed = run?.exitCode === 0 ? parseProfileWallets(run.json) : undefined
    if (!parsed) {
      unread.push(row.keyPrefix)
      continue
    }
    for (const w of parsed.rows) {
      checks.push({
        area: "wallet",
        state: "warn",
        text: `TEE wallet ${teeName(w)} (${short(w.address)}) is bound to revoked key ${row.keyPrefix}: no key can trade it until the owner rebinds it`,
        // An owner row in the Candle Harness: typed there, it opens the prompt pane.
        fix: prefixes.size
          ? `Type one of these in the Candle Harness, for the agent that should trade it: ${[...prefixes].map(([agent, prefix]) => `\`candle tee rebind ${w.address} --to-key ${prefix}\` (${agent})`).join(", or ")}. It opens the prompt pane for your factor and a typed confirm, and the funds don't move.`
          : `As the owner, in the Candle Harness or your own terminal: \`candle tee rebind ${w.address} --to-key <prefix>\`, with the prefix of the key that should trade it. It takes your factor and a typed confirm, and the funds don't move.`,
      })
    }
  }
  if (unread.length > 0) {
    checks.push({ area: "wallet", state: "warn", text: `couldn't check revoked key${unread.length === 1 ? "" : "s"} ${unread.join(", ")} for stranded TEE wallets`, fix: "Run `candle keys wallets <prefix>` for each, as the owner." })
  }
  if (revoked.length > REVOKED_KEYS_CHECKED) {
    checks.push({ area: "wallet", state: "skip", text: `${revoked.length - REVOKED_KEYS_CHECKED} older revoked keys weren't checked for stranded TEE wallets`, fix: "Run `candle keys wallets <prefix>` for each, as the owner." })
  }
  return checks
}

/**
 * The RPC a TEE trade reads the chain over, by the CLI's own order (cli/src/solana-endpoint.ts:91-118):
 * `--rpc-url`, which the core never passes; else CANDLE_SOLANA_RPC_URL, which the core sets only from
 * candle.rpcUrl (the person's own never reaches the CLI, since its environment is an allowlist); else
 * the acting profile's `rpcUrl` in the CLI's config.json; else Solana's public endpoint. The acting profile is the CLI's
 * `resolveProfileName` (cli/src/profiles.ts:47-74) without CANDLE_PROFILE, which doesn't reach it
 * either: `activeProfile`, else the only profile. An agent's CANDLE_API_KEY doesn't change which.
 */
function rpcCheck(config: Config, env: Record<string, string | undefined>): Check {
  const ok = (text: string): Check => ({ area: "wallet", state: "ok", text })
  if (config.candle.rpcUrl) return ok(`TEE trades read the chain over ${new URL(config.candle.rpcUrl).host} (candle.rpcUrl)`)
  const profile = actingProfile(env, config.candle.profile)
  if (profile.missing) return { area: "wallet", state: "skip", text: "TEE trades' RPC wasn't read: config.toml's candle.profile isn't one of the candle CLI's profiles (above)" }
  if (profile.unresolved) {
    return {
      area: "wallet",
      state: "fail",
      text: `the candle CLI has several profiles and none is selected (${profile.unresolved.join(", ")}), so it refuses every TEE trade (PROFILE_UNRESOLVED)`,
      fix: "Pick one with `candle profile use <name>`.",
    }
  }
  if (profile.rpcUrl) {
    const fault = solanaRpcFault(profile.rpcUrl)
    if (fault) {
      return {
        area: "wallet",
        state: "fail",
        text: `the candle CLI's profile ${profile.name}'s rpcUrl ${fault}, so the CLI refuses every TEE trade`,
        fix: `Run \`candle profile set ${profile.name} --rpc-url <your Solana RPC>\`, or set candle.rpcUrl in config.toml.`,
      }
    }
    return ok(`TEE trades read the chain over ${new URL(profile.rpcUrl).host} (the candle CLI's profile ${profile.name})`)
  }
  return {
    area: "wallet",
    state: "warn",
    text: `neither candle.rpcUrl nor ${profile.name ? `the candle CLI's profile ${profile.name}` : "a candle CLI profile"} names an RPC, so TEE trades read the chain over Solana's public endpoint, which rate-limits (RPC_RATE_LIMITED)`,
    fix: "Set candle.rpcUrl in config.toml to your own Solana RPC.",
  }
}


/**
 * Onboarding's state, from state/onboarding.json alone, so offline too: finished, or where it
 * stopped and that `candle-harness` picks up there. What each step made is read back by onboarding itself, never from here.
 */
export async function onboardingChecks(p: Paths, hasAgents: boolean): Promise<Check[]> {
  const line = (state: CheckState, text: string, fix?: string): Check[] => [{ area: "setup", state, text, ...(fix ? { fix } : {}) }]
  if (!existsSync(p.onboarding)) return hasAgents ? line("ok", "onboarding wasn't run on this machine (the agents were added by hand); `candle-harness setup` runs it") : line("ok", "onboarding hasn't started: `candle-harness` opens it")
  const state = await new OnboardingStore({ file: p.onboarding, now: Date.now }).read()
  if (!state) return line("warn", `${p.onboarding} couldn't be read, so onboarding starts again from its welcome. Nothing it made is lost: the sign-in, vault, key and wallet are read back from where they live`, `Remove ${p.onboarding} if it was edited by hand.`)
  const day = (iso: string) => iso.slice(0, 16).replace("T", " ")
  const route = state.straightIn ? "straight in" : `guided${state.vaultChoice === "later" ? ", the embedded wallet only for now" : state.vaultChoice === "now" ? ", with a vault" : ""}`
  const agent = state.agent ? `, ${state.agent.name}${state.engine ? ` on ${ENGINE_LABELS[state.engine]}` : ""}` : ""
  if (state.finishedAt) return line("ok", `onboarding finished ${day(state.finishedAt)} UTC (${route}${agent}); \`candle-harness setup\` reopens it`)
  // The furthest step gone past, from the person's own marks: what the other steps made is read back when it opens.
  const passed = ONBOARDING_STEPS.filter((s) => state.passed.includes(s))
  const last = passed.length ? `, past ${STEP_WORDS[passed.at(-1)!]}` : ""
  return line(
    hasAgents ? "warn" : "ok",
    `onboarding started ${day(state.startedAt)} UTC and isn't finished (${route}${agent}${last}; last changed ${day(state.updatedAt)} UTC): \`candle-harness\` opens it where it stopped, and runs nothing twice`,
    ...(hasAgents ? ["Run `candle-harness` to finish it: until then it opens in place of the Candle Harness."] : []),
  )
}

const STEP_WORDS: Record<(typeof ONBOARDING_STEPS)[number], string> = {
  welcome: "the welcome",
  signIn: "the sign-in",
  engine: "your agent",
  vault: "the vault",
  key: "the key",
  wallet: "the wallet",
  limits: "the limits",
  approvals: "the approvals",
  fund: "funding",
  tour: "the tour",
  start: "where to start",
}

/**
 * The CLI profile the Candle Harness acts as: config.toml's `candle.profile`, that the CLI
 * has it, and online whether it's signed in (`candle auth status --json` as that profile). With none recorded,
 * each run acts as the CLI's own pick, named where it can be.
 */
async function profileChecks(config: Config, env: Record<string, string | undefined>, ask: boolean): Promise<Check[]> {
  const line = (state: CheckState, text: string, fix?: string): Check => ({ area: "candle", state, text, ...(fix ? { fix } : {}) })
  const recorded = config.candle.profile
  const acting = actingProfile(env, recorded)
  if (recorded === undefined) {
    if (acting.unresolved) return [line("warn", `config.toml names no candle.profile, and the candle CLI has several profiles with none selected (${acting.unresolved.join(", ")}), so its runs refuse (PROFILE_UNRESOLVED)`, "Run `candle-harness setup` to pick the one the Candle Harness acts as, or `candle profile use <name>`.")]
    return [line("ok", `config.toml names no candle.profile, so each candle run acts as the CLI's own pick${acting.name ? ` (now ${acting.name})` : ""}; \`candle-harness setup\` records one`)]
  }
  if (acting.missing) {
    const has = acting.names?.length ? ` (it has ${acting.names.join(", ")})` : ""
    return [line("fail", `config.toml's candle.profile is ${recorded}, which isn't one of the candle CLI's profiles${has}, so every candle run the Candle Harness makes refuses`, "Run `candle-harness setup` to sign in again, or set candle.profile in config.toml to one of the CLI's profiles.")]
  }
  if (!ask) return [line("ok", `the Candle Harness acts as the candle CLI's profile ${recorded} (config.toml's candle.profile)`)]
  const cli = new CandleCli({ cliPath: config.candle.cliPath, rpcUrl: undefined, keyFor: () => undefined, parentEnv: env, profile: () => recorded })
  const run = await cli.runExact({ argv: ["auth", "status", "--profile", recorded, "--json"], json: true, timeoutMs: 15_000 }).catch(() => undefined)
  const signed = signInFrom(run ? { exitCode: run.exitCode, json: run.json } : undefined)
  if (signed.state === "signed-in") return [line("ok", `the Candle Harness acts as the candle CLI's profile ${recorded} (config.toml's candle.profile), signed in${signed.account ? ` as ${short(signed.account)}` : ""}`)]
  if (signed.state === "signed-out") return [line("fail", `the Candle Harness acts as the candle CLI's profile ${recorded}, which isn't signed in${signed.code ? ` (${signed.code})` : ""}, so owner steps and the CLI's reads refuse`, `Run \`candle auth login --profile ${recorded}\`, or \`candle-harness setup\`.`)]
  return [line("warn", `the Candle Harness acts as the candle CLI's profile ${recorded}; couldn't read whether it's signed in (\`candle auth status\`)`, `Run \`candle auth status --profile ${recorded}\`.`)]
}

/** At most this many TEE wallets' previews are read with no core: each is four of Candle's calls on the wallet's key. */
const EMPTY_PREVIEWS = 3

/**
 * Each Solana TEE wallet's empty token accounts: a running core's count, from its
 * `wallets` topic, so nothing more is asked of Candle; with no core, Candle's preview through the user's own CLI
 * with the wallet's key (never `--yes`), for the first few. Whether Candle serves the preview here is said too.
 */
async function emptyAccountChecks(input: { p: Paths; config: Config; env: Record<string, string | undefined>; keys: Map<string, string>; reads: Map<string, TeeRead>; coreUp: boolean; now: () => number }): Promise<Check[]> {
  const wallets = new Map<string, { agent: string; t: TeeWallet }>()
  for (const [agent, read] of input.reads) for (const t of read.tee ?? []) if (t.chain === "solana" && t.active && read.status.tier !== "free" && !wallets.has(t.address)) wallets.set(t.address, { agent, t })
  if (wallets.size === 0) return []
  let counted = input.coreUp ? await coreEmpty(input.p).catch(() => undefined) : undefined
  const from = counted ? "the running core's count" : "Candle's preview"
  if (!counted) {
    counted = {}
    for (const [address, { agent }] of [...wallets].slice(0, EMPTY_PREVIEWS)) {
      const cli = new CandleCli({ cliPath: input.config.candle.cliPath, rpcUrl: undefined, keyFor: () => input.keys.get(agent), parentEnv: input.env, profile: () => input.config.candle.profile })
      const run = await cli.runExact({ agent, argv: previewArgv(address), json: true, timeoutMs: 30_000 }).catch((error: Error) => ({ exitCode: -1, stdout: "", stderr: error.message, json: undefined, timedOut: false }))
      counted[address] = readPreview(run, input.now())
    }
  }
  const checks: Check[] = []
  const add = (state: CheckState, text: string, fix?: string) => void checks.push({ area: "wallet", state, text, ...(fix ? { fix } : {}) })
  let unread = 0
  for (const [address, { t }] of wallets) {
    const name = `TEE wallet ${teeName(t)} (${short(address)})`
    const e = counted[address]
    if (!e) {
      unread++
      continue
    }
    if (isCounted(e)) {
      if (e.count === 0) add("ok", `${name} has no empty token accounts (${from})`)
      else add("ok", `${name} has ${e.count} empty token account${e.count === 1 ? "" : "s"} · ${e.netSol} SOL back (${from})`, "Close them from the Wallets pane's close chip, or ask the agent: the rent goes back to the same wallet.")
    } else if (e.code === "CLOSE_EMPTY_DISABLED") add("ok", `Candle doesn't serve closing empty token accounts here (CLOSE_EMPTY_DISABLED), so ${name}'s aren't counted`)
    else if (e.code === "PREVIEW_UNREAD") add("warn", `${name}'s empty token accounts couldn't be counted: ${e.failed}, so the Wallets pane shows none`, `Check \`candle --version\`: a CLI newer than ${SOURCE.source.cliVersion} may word its preview differently.`)
    else add("warn", `${name}'s empty token accounts couldn't be counted (${e.code}: ${e.failed})`, "Run candle-harness doctor again; the Wallets pane says the same until a read answers.")
  }
  if (unread > 0) add("skip", `${unread} more TEE wallet${unread === 1 ? "" : "s"}' empty token accounts weren't read, to spare the keys' Candle limit: the core counts them once it runs`)
  return checks
}

/** The running core's `wallets` topic's `empty`, read once as a view; nothing is asked of Candle. */
async function coreEmpty(p: Paths): Promise<Record<string, EmptyState> | undefined> {
  const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
  try {
    const got = new Promise<Record<string, EmptyState> | undefined>((resolve) => {
      connection.onEvent((e) => {
        if (e.topic === "wallets") resolve(record(record(e.data)?.empty) as Record<string, EmptyState> | undefined)
      })
      setTimeout(() => resolve(undefined), 5_000).unref?.()
    })
    await connection.request("subscribe", { topics: ["wallets"] })
    return await got
  } finally {
    connection.close()
  }
}

/** Whether Candle serves LP yet: the Candle Harness's LP cards wait until it does and they're checked live. */
async function lpCheck(config: Config, env: Record<string, string | undefined>, keys: Map<string, string>, redactor: Redactor): Promise<Check> {
  const [agent, key] = [...keys][0]!
  const cli = new CandleCli({ cliPath: config.candle.cliPath, rpcUrl: undefined, keyFor: () => key, parentEnv: env, profile: () => config.candle.profile })
  // CNDL's pools: Candle's own token, public, and the likeliest to have one.
  const run = await cli.run({ agent, args: ["lp", "pools", BASE_ASSETS.CNDL.priceKey!], json: true, timeoutMs: 30_000 }).catch(() => undefined)
  const body = record(run?.json)
  if (run?.exitCode === 1 && body?.code === "LP_NOT_ENABLED") return { area: "candle", state: "ok", text: "Candle doesn't serve LP yet (LP_NOT_ENABLED), so the Candle Harness's LP cards stay \"coming\"" }
  if (run?.exitCode === 0 && body && body.ok !== false) return { area: "candle", state: "ok", text: "Candle serves LP now (candle lp pools answered); the Candle Harness's LP cards switch on in a release after they're checked live" }
  return { area: "candle", state: "skip", text: `couldn't tell whether Candle serves LP: ${run ? lastLine(redactor, run.stdout, run.stderr) || `exit ${run.exitCode}` : "candle lp pools didn't run"}` }
}

const READ_NAMES: Record<ReadKind, string> = { prices: "prices", linked: "the linked token", pnl: "P&L", pins: "pinned tokens", lists: "Candle's lists", empty: "empty token accounts" }

/**
 * A running core's use of each key's Candle limit over the last minute, from its status:
 * turns, cards and background reads together, and the background reads it slowed to keep a trade's room.
 * Nothing here fails the doctor: a slowed read is the budget working.
 */
export async function budgetChecks(p: Paths): Promise<Check[]> {
  if (!(await answers(p.socket))) return []
  const budget = await coreBudget(p).catch(() => undefined)
  if (!budget) return []
  return budgetWords(budget)
}

export function budgetWords(budget: { keys: KeyUse[]; pace: Partial<Record<ReadKind, Pace>> }): Check[] {
  const slowed = (Object.entries(budget.pace ?? {}) as [ReadKind, Pace][]).map(([kind, pace]) => `${READ_NAMES[kind]} ${paceWords(pace)}`)
  const out: Check[] = budget.keys.map((k) => {
    const of = `${k.used} of its ${k.limit} requests in the last minute`
    const own = k.lowered ? ` (half its ${k.keyLimit}, since Candle rate-limited it in the last 2 minutes)` : ""
    const text = `${k.agent}: the running core used ${of}${own}, ${k.background} by background reads, which may use ${k.allowance}`
    return k.lowered
      ? { area: "candle", state: "warn", text, fix: "It eases by itself after 2 minutes. If it keeps happening, something else is using the key: an app or script with the same key counts against the same limit." }
      : { area: "candle", state: "ok", text }
  })
  if (slowed.length) out.push({ area: "candle", state: "ok", text: `to leave room for trades, the running core reads ${slowed.join("; ")}` })
  return out
}

/** The running core's budget, from `core.status` as a view: counts and limits, no keys. */
async function coreBudget(p: Paths): Promise<{ keys: KeyUse[]; pace: Partial<Record<ReadKind, Pace>> } | undefined> {
  const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
  try {
    const status = record(await connection.request("core.status", {}))
    const budget = record(status?.budget)
    return Array.isArray(budget?.keys) ? (budget as unknown as { keys: KeyUse[]; pace: Partial<Record<ReadKind, Pace>> }) : undefined
  } finally {
    connection.close()
  }
}

/** The doctor's read of each key: one row of the tape, which every plan reaches. */
const HACC_KEY_READ = { route: "/v1/signals", query: { limit: 1 }, timeoutMs: 10_000 }
const PLAN_NAMES: Record<HaccPlan, string> = { free: "Free", pro: "Pro", max: "Max" }

/**
 * Hacc: whether it takes each agent's key (one row of the tape, read as the core reads
 * it), the account's plan and the Hacc tools that offers the agent, and the signal stream: the running
 * core's state, or with no core, whether Hacc would open it for the first key it took. Hacc refusing a
 * key leaves trading alone, so nothing here fails the doctor.
 */
async function haccChecks(input: { p: Paths; config: Config; keys: Map<string, string>; plans: Map<string, string | undefined>; now: () => number; host?: string }): Promise<Check[]> {
  const { p, config, keys } = input
  if (!config.hacc.enabled) {
    return [{ area: "hacc", state: "skip", text: "Hacc's data is off in config ([hacc] enabled = false): no agent is offered Hacc's tools, and the token pane charts its own samples only", fix: "Set [hacc] enabled = true in config.toml to turn it on." }]
  }
  const out: Check[] = []
  const host = input.host ?? HACC_HOST
  const client = new HaccClient({ keyFor: (agent) => keys.get(agent), now: input.now, host })
  const took: string[] = []
  const rows = await Promise.all(
    [...keys].map(async ([agent, key]): Promise<Check> => {
      if (!key.startsWith("cndl_live_")) {
        return { area: "hacc", state: "warn", text: `${agent} has a test key, which Hacc refuses: it gets no Hacc tools`, fix: `Use a cndl_live_ key: run \`candle-harness key add --agent ${agent}\` with one.` }
      }
      const answer = await client.get(agent, HACC_KEY_READ.route, HACC_KEY_READ.query, { timeoutMs: HACC_KEY_READ.timeoutMs })
      if (answer.kind === "refused") {
        if (answer.code === "HACC_KEY_REFUSED") return { area: "hacc", state: "warn", text: `${answer.message} Its trades and Candle's reads still work; its Hacc tools are left out`, fix: newKey(agent) }
        // Past the key, and stopped by the plan (as on Free): nothing to fix, and running this again won't change it.
        if (answer.code === "PLAN_REQUIRED") return { area: "hacc", state: "ok", text: `${agent}: Hacc takes its key, and this read of the tape needs a paid plan (${answer.message}); ${planWords(config, agent, input.plans.get(agent))}` }
        return { area: "hacc", state: "warn", text: `${agent}: Hacc didn't answer a read of the tape: ${answer.message}`, fix: "Run candle-harness doctor again; the core asks Hacc afresh on every call." }
      }
      took.push(agent)
      return { area: "hacc", state: "ok", text: `${agent}: Hacc takes its key (the tape answered in ${answer.ms} ms); ${planWords(config, agent, input.plans.get(agent))}` }
    }),
  )
  out.push(...rows)
  // The plan of an agent Hacc took, since Research reads with the first agent Hacc is offered to.
  const plan = [...keys.keys()].filter((a) => took.includes(a)).map((a) => input.plans.get(a)).find((t): t is HaccPlan => t === "free" || t === "pro" || t === "max")
  if (plan) {
    const unreached = researchUnreached(plan)
    out.push(
      unreached.length
        ? { area: "hacc", state: "warn", text: `Research on ${PLAN_NAMES[plan]}: ${unreached.join("; ")}. Its panes say so, and the rest of Research works`, fix: "A higher plan on Hacc adds them." }
        : { area: "hacc", state: "ok", text: `Research: the account's plan (${PLAN_NAMES[plan]}) reaches all of Hacc's reads its panes make` },
    )
  }
  out.push(await streamCheck(p, took.length ? { agent: took[0]!, key: keys.get(took[0]!)!, host } : undefined))
  return out
}

/** The account's plan, and the Hacc tools it offers this agent, less any its config hides. */
function planWords(config: Config, agent: string, tier: string | undefined): string {
  const plan = tier === "free" || tier === "pro" || tier === "max" ? tier : undefined
  if (!plan) return "the account's plan wasn't read, so the core offers Free's Hacc tools until it is"
  const tools = config.agents[agent]?.tools ?? DEFAULT_TOOLS
  const unreached = unreachedBy(plan)
  const offered = HACC_TOOLS.filter((t) => !unreached.includes(t.name) && toolAllowed(tools, t.name)).length
  const hidden = HACC_TOOLS.filter((t) => !toolAllowed(tools, t.name)).map((t) => t.name)
  const needs = unreached.length ? ` (${plan === "free" ? "Pro and Max add" : "Max adds"} ${unreached.join(", ")})` : ""
  const hides = hidden.length ? `, with ${hidden.join(", ")} hidden in config` : ""
  return `the account is on ${PLAN_NAMES[plan]}, so it's offered ${offered} of Hacc's ${HACC_TOOLS.length} tools${needs}${hides}`
}

/** The signal stream: the running core's, read from its `hacc` topic as a view, else Hacc's answer to an upgrade. */
export async function streamCheck(p: Paths, probe: { agent: string; key: string; host: string } | undefined): Promise<Check> {
  if (await answers(p.socket)) {
    const view = await coreHaccView(p).catch(() => undefined)
    if (view) return streamState(view)
  }
  if (!probe) return { area: "hacc", state: "skip", text: "Hacc's stream wasn't tried: Hacc took no agent's key" }
  const url = new URL("/v1/signals/stream", probe.host)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const why = await probeUpgrade(url.toString(), probe.key)
  if (why.status === 101) return { area: "hacc", state: "ok", text: `Hacc's stream opens with ${probe.agent}'s key; the core opens it while a view or an agent reads the tape` }
  if (why.status === 429) {
    return { area: "hacc", state: "warn", text: `Hacc's stream is full for ${probe.agent}'s key (Hacc: "${why.words}"): it allows 8 open at once, and the web app and other apps count`, fix: "Close the tape in Candle's web app or another app, or leave it: the core tries again every 30 s, and Hacc's reads still answer." }
  }
  return { area: "hacc", state: "warn", text: `Hacc's stream didn't open with ${probe.agent}'s key (${why.status ? `HTTP ${why.status}: ` : ""}${why.words})`, fix: "Run candle-harness doctor again; Hacc's reads answer without the stream." }
}

interface StreamView {
  state: string
  words?: string
  agent?: string
  openSince?: string
  mine?: { state: string; words?: string }
}

/** The running core's `hacc` topic, read once as a view: no rows and no keys, and it opens nothing. */
async function coreHaccView(p: Paths): Promise<StreamView | undefined> {
  const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
  try {
    const got = new Promise<StreamView | undefined>((resolve) => {
      connection.onEvent((e) => {
        if (e.topic === "hacc") resolve(record(record(e.data)?.stream) as StreamView | undefined)
      })
      setTimeout(() => resolve(undefined), 5_000).unref?.()
    })
    await connection.request("subscribe", { topics: ["hacc"] })
    return await got
  } finally {
    connection.close()
  }
}

function streamState(view: StreamView): Check {
  const words = view.words ? `: ${terminalText(view.words, { maxLength: 300 })}` : ""
  const mine = view.mine?.state === "failing" ? `; personal signals are failing (${terminalText(view.mine.words ?? "", { maxLength: 200 })})` : ""
  switch (view.state) {
    case "open":
      return { area: "hacc", state: mine ? "warn" : "ok", text: `the running core has Hacc's stream open${view.agent ? ` on ${view.agent}'s key` : ""}${view.openSince ? ` since ${view.openSince.slice(11, 16)} UTC` : ""}${mine}` }
    case "closed":
      return { area: "hacc", state: mine ? "warn" : "ok", text: `the running core has Hacc's stream closed: it opens while a view or an agent reads the tape${mine}` }
    case "opening":
    case "filling":
      return { area: "hacc", state: "ok", text: `the running core is opening Hacc's stream${words}` }
    case "off":
      return { area: "hacc", state: "skip", text: "the running core has Hacc off" }
    case "full":
      return { area: "hacc", state: "warn", text: `the running core can't open Hacc's stream${words}`, fix: "Close the tape in Candle's web app or another app, or leave it: the core tries again every 30 s." }
    default:
      return { area: "hacc", state: "warn", text: `the running core's Hacc stream is ${view.state}${words}`, fix: "It retries by itself; run candle-harness doctor again shortly." }
  }
}

/**
 * PATH entries that aren't full paths. The Candle Harness never finds a program through one (an engine starts
 * in its agent's folder, where such an entry would be looked up), so they're named: a program the person meant
 * to be found through one isn't.
 */
export function pathChecks(path: string | undefined): Check[] {
  const relative = relativeEntries(path)
  if (relative.length === 0) return []
  return [
    {
      area: "paths",
      state: "warn",
      text: `PATH has ${relative.length === 1 ? "an entry that isn't a full path" : "entries that aren't full paths"} (${relative.join(", ")}): the Candle Harness leaves ${relative.length === 1 ? "it" : "them"} out when it looks for an engine or the candle CLI, since ${relative.length === 1 ? "it" : "they"} would be looked up in whatever folder a program starts in`,
      fix: "Take them out of PATH in your shell's startup file, or give each engine's full path in config.toml ([engine.<name>] path).",
    },
  ]
}

/** Running as root on Linux: everything an agent's engine runs then runs as root too. Said once; nothing is refused. */
export function rootChecks(uid: number | undefined, platform: NodeJS.Platform): Check[] {
  if (platform !== "linux" || uid !== 0) return []
  return [
    {
      area: "state",
      state: "warn",
      text: "the Candle Harness is running as root: each agent's engine, every code bot and the Build tab's harness run as root too, and what holds them back is weaker for root",
      fix: "Make an unprivileged user (`adduser <name>`), install as it, and run the Candle Harness there.",
    },
  ]
}

/** The running core's version against this binary's: a warning when they differ, with how to restart it. */
export function coreVersionChecks(running: string | undefined, ours: string): Check[] {
  const words = staleCoreWords(running, ours)
  return words ? [{ area: "core", state: "warn", text: words[0]!.toLowerCase() + words.slice(1).replace(/\.$/, ""), fix: `Open candle-harness and choose \`restart it\` in its status bar. Or run \`candle-harness stop\`, then open candle-harness again (with the login service, \`candle-harness service install\` instead, so its core runs on after the view quits).` }] : []
}

/** A harness on a newer major version than the one its holds were checked on: said, and nothing is blocked. */
export function newerMajorChecks(area: "engine" | "claude", label: string, version: string | undefined, checked: string): Check[] {
  if (version === undefined || !newerMajor(version, checked)) return []
  return [
    {
      area,
      state: "warn",
      text: newerMajorWords(label, version, checked),
      fix: "Nothing is blocked. A new major version can change what a harness's own flags and sandbox do: update the Candle Harness when a newer one is out, and keep that engine's shell off meanwhile.",
    },
  ]
}

const LABEL: Record<CheckState, string> = { ok: "ok", warn: "warn", fail: "FAIL", skip: "skip" }

export function formatReport(checks: Check[], opts: { only?: CheckState[] } = {}): string {
  const shown = opts.only ? checks.filter((c) => opts.only!.includes(c.state)) : checks
  const lines: string[] = []
  for (const check of shown) {
    lines.push(`${LABEL[check.state].padEnd(5)} ${check.area.padEnd(7)} ${check.text}`)
    if (check.fix && check.state !== "ok") lines.push(`${" ".repeat(14)}→ ${check.fix}`)
  }
  return lines.join("\n")
}

export function summary(checks: Check[]): string {
  const fails = checks.filter((c) => c.state === "fail").length
  const warns = checks.filter((c) => c.state === "warn").length
  const warnText = warns ? ` and ${warns} warning${warns === 1 ? "" : "s"}` : ""
  if (fails === 0) return warns ? `Nothing blocking${warnText}.` : "All checks passed."
  return `${fails} problem${fails === 1 ? "" : "s"} to fix${warnText}. Fix the first, then run candle-harness doctor again.`
}

/**
 * The whole report as the command prints it: every check in order, the summary, and under it the checks that
 * aren't ok once more, failures first, so they aren't lost among the lines that passed.
 */
export function doctorReport(checks: Check[]): string {
  const toLookAt = [...checks.filter((c) => c.state === "fail"), ...checks.filter((c) => c.state === "warn")]
  const again = toLookAt.length ? `\nTo look at:\n${formatReport(toLookAt)}\n` : ""
  return `${formatReport(checks)}\n\n${summary(checks)}\n${again}`
}

const USAGE = `Usage: candle-harness doctor [--offline]

  Checks the config, the key files, the candle CLI, each engine (its version, its models, and a one-word
  turn on each engine an agent is on), and each agent's key with Candle. --offline skips Candle, the
  model lists and the turns.
  docs.candle.tv/harness/engines says what each engine can and can't do.
`

export async function doctorCommand(args: string[], io: { out(text: string): void; err(text: string): void }, env: Record<string, string | undefined> = process.env): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE)
    return 0
  }
  const unknown = args.filter((a) => a !== "--offline")
  if (unknown.length) {
    io.err(`candle-harness doctor: unknown option ${unknown[0]}\n\n${USAGE}`)
    return 2
  }
  const online = !args.includes("--offline")
  io.out(`candle-harness doctor ${VERSION} (${COMMIT})${online ? " (it asks Candle about each key, and sends each engine an agent is on one word)" : ""}\n\n`)
  const checks = await runDoctor({ env, online })
  io.out(doctorReport(checks))
  return checks.some((c) => c.state === "fail") ? 1 : 0
}

/** What a view that can't start prints: the offline checks that aren't ok, and where to go next. */
export async function quickDoctor(env: Record<string, string | undefined>): Promise<string> {
  const checks = await runDoctor({ env, online: false })
  const problems = formatReport(checks, { only: ["fail", "warn"] })
  return `${problems ? `\n${problems}\n` : ""}\nRun \`candle-harness doctor\` for the full check, Candle and each engine's sign-in included.\n`
}

/** config.toml's [aliases]: how many the view uses, or each left out with its line. The rest still work. */
/** Final Stretch here: Candle's server has it on, or its source is behind, or it's off. */
function stretchCheck(stretch: ReturnType<typeof stretchFrom>): Check {
  switch (stretch.state) {
    case "on":
      return { area: "candle", state: "ok", text: "Final Stretch is on Candle's server, so Trending shows all four lists" }
    case "behind":
      return { area: "candle", state: "warn", text: `Final Stretch is on, but Candle says its source is behind${stretch.behindS !== undefined ? ` by ${stretch.behindS} s` : ""}; Trending marks the list behind while it is`, fix: "Nothing to do here: Candle catches it up." }
    case "off":
      return { area: "candle", state: "ok", text: "Final Stretch is off on Candle's server, so Trending shows three lists and gives it no room" }
    case "failed":
      return { area: "candle", state: "warn", text: `Final Stretch wasn't read: ${stretch.words}`, fix: "Run candle-harness doctor again; Trending says the same in its pane if it stays." }
  }
}

const agoWords = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 1) return "under a minute ago"
  if (min < 120) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`
}

/**
 * P&L: the window and where it came from (the last picked, else config's [pnl] window),
 * and each agent's samples: how many, from when, and how old the last is. Without samples, the window's
 * figure runs from the first one the core takes.
 */
export function pnlChecks(p: Paths, config: Config, now: number): Check[] {
  const state = readWindowState(p.pnlWindow)
  const window = state.window ?? config.pnl.window
  const why = state.window ? "the window last picked" : "config.toml's [pnl] window, as nothing's been picked yet"
  const session = window === "session" ? (state.sessionEnd !== undefined ? `; the last session ended ${agoWords(now - state.sessionEnd)}` : "; no session has ended yet, so it runs from the first sample") : ""
  const out: Check[] = [{ area: "pnl", state: "ok", text: `the P&L window is ${windowLabel(window)} (${why})${session}` }]
  const samples = readSamples(p.pnlSamples)
  const agents = Object.keys(config.agents)
  if (samples.length === 0) {
    out.push({ area: "pnl", state: "ok", text: `no P&L samples yet in ${p.pnlSamples}: the core takes one with each read of Candle's books (every 5 minutes, every minute while a P&L pane is on screen), so each figure starts from its first` })
    return out
  }
  const words = agents.map((agent) => {
    const own = samples.filter((s) => s.agent === agent)
    if (own.length === 0) return `${agent} none yet`
    return `${agent} ${own.length} since ${new Date(own[0]!.at).toISOString().slice(0, 10)}, the last ${agoWords(now - own.at(-1)!.at)}`
  })
  out.push({ area: "pnl", state: "ok", text: `P&L samples in ${p.pnlSamples}: ${words.join("; ")}` })
  return out
}

/**
 * The journal: its size and rows, which the Journal tab searches, a page at a time, in
 * the whole file. Counted by its newlines, a slice at a time, so a large journal costs no memory.
 */
export async function journalChecks(p: Paths): Promise<Check[]> {
  let size: number
  try {
    size = statSync(p.journal).size
  } catch {
    return [{ area: "journal", state: "ok", text: `no journal yet at ${p.journal}: the core starts one` }]
  }
  let rows = 0
  for await (const chunk of createReadStream(p.journal)) {
    const bytes = chunk as Buffer
    for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) rows++
  }
  const mb = size / 1_048_576
  const sizeText = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
  return [{ area: "journal", state: "ok", text: `${p.journal}: ${rows.toLocaleString("en-US")} rows, ${sizeText}; the Journal tab searches all of it` }]
}

/** The Agent Console's keys page, where the owner sets a key's caps and loss limits and resumes a stopped key (docs.candle.tv/developers/agent-access). */
export const CONSOLE_KEYS = "https://alpha.candle.tv/agents?tab=keys"

/** A time on this machine's clock, with its day: "2026-10-31 14:02". */
const localStamp = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const utcClock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`
const inWords = (ms: number) => gapLength(Math.max(60_000, ms))

/** The journal's rows for the doctor's hands-off and away lines, or none where it can't be read (journalChecks says so). */
async function journalRowsOf(p: Paths): Promise<JournalRow[]> {
  return (await readJournal(p.journal).catch(() => undefined))?.rows ?? []
}

/** What the doctor read of each agent's key: its embedded wallet, its TEE wallets and Candle's caps on it. */
export type PayRead = { status: Pick<AgentStatus, "embeddedWallet" | "wallets" | "keyLimit" | "assetCaps">; tee?: Pick<TeeWallet, "address" | "label" | "chain">[] }

/**
 * Hands off: each wallet's setting and figures, from state/autonomy.json, with today's
 * use without a card from the journal (as the core counts it); online, who pays from each, a figure an
 * agent's own limit binds before, and a key Candle doesn't cap on a wallet that trades inside limits.
 * Then Candle's loss limits and circuit breaker, named since no read shows them, and
 * each key the core holds for Candle's cap or a stop, rebuilt from the journal as the core rebuilds it.
 */
export function approvalsChecks(input: { p: Paths; config: Config; rows: readonly JournalRow[]; now: number; reads?: Map<string, PayRead> }): Check[] {
  const { p, config, rows, now, reads } = input
  const out: Check[] = []
  const autonomy = new Autonomy(p.autonomyState)
  const spend = new DaySpend(byWalletWithoutCard)
  spend.rebuild(rows)
  // Who pays from each wallet, as the core lists them: the embedded wallet where a key is allowed it, and each Solana TEE wallet bound to a key.
  const payers = new Map<string, { name: string; agents: string[] }>()
  const pays = (address: string, name: string, agent: string) => {
    const w = payers.get(address) ?? { name, agents: [] }
    w.agents.push(agent)
    payers.set(address, w)
  }
  for (const [agent, read] of reads ?? []) {
    if (read.status.wallets.solana && read.status.embeddedWallet !== "denied") pays(read.status.wallets.solana, "embedded", agent)
    for (const t of read.tee ?? []) if (t.chain === "solana" || t.chain === "hood") pays(t.address, teeName(t), agent)
  }
  const label = (address: string, name: string) => `${name === "embedded" ? "the embedded wallet" : `TEE wallet ${name}`} (${short(address)})`
  const inside = autonomy.all().filter((e) => e.value.setting === "inside")
  if (inside.length === 0) {
    const named = [...payers].map(([address, w]) => label(address, w.name))
    const which = named.length ? `every wallet the agents pay from asks every time (${named.join(", ")})` : "every wallet asks every time"
    out.push({ area: "wallet", state: "ok", text: `${which}, so every live trade is a card, as by default. Trading inside limits is turned on wallet by wallet in the view's settings ▾ → approvals` })
  }
  for (const entry of inside) {
    const v = entry.value as Extract<WalletSetting, { setting: "inside" }>
    const payer = payers.get(entry.wallet)
    const name = payer?.name ?? entry.name ?? short(entry.wallet)
    const used = spend.spent(entry.wallet, now)
    if (reads && !payer) {
      out.push({ area: "wallet", state: "ok", text: `${label(entry.wallet, name)} was set to trade inside limits, but no agent pays from it now: the setting is kept, and applies to no other wallet` })
      continue
    }
    const by = payer ? `, paid from by ${payer.agents.join(" and ")}` : ""
    out.push({ area: "wallet", state: "ok", text: `${label(entry.wallet, name)} trades inside limits${by}: up to ${usd(v.perTradeUsd)} a trade and ${usd(v.perDayUsd)} a day run without a card, ${usd(used)} of it used today; every sell from it runs without one, unless its slippage is looser than the default` })
    for (const agent of payer?.agents ?? []) {
      const own = config.agents[agent]?.limits
      const lower = `Lower the wallet's figure in the view's settings ▾ → approvals, or raise ${agent}'s limits in ${p.configFile}.`
      if (own && own.perTradeUsd < v.perTradeUsd) {
        out.push({ area: "wallet", state: "warn", text: `${agent}'s own limit, ${usd(own.perTradeUsd)} a trade, binds first on ${label(entry.wallet, name)}, whose figure is ${usd(v.perTradeUsd)}: a trade between the two is refused, not run without a card`, fix: lower })
      } else if (own && own.perDayUsd < v.perDayUsd) {
        out.push({ area: "wallet", state: "warn", text: `${agent}'s own limit, ${usd(own.perDayUsd)} a day, binds first on ${label(entry.wallet, name)}, whose figure is ${usd(v.perDayUsd)} a day without a card: ${agent} stops at its own`, fix: lower })
      }
      const status = reads?.get(agent)?.status
      if (status && status.keyLimit === undefined && !status.assetCaps?.length) {
        out.push({
          area: "wallet",
          state: "warn",
          text: `Candle doesn't cap ${agent}'s key, and ${agent} pays from ${label(entry.wallet, name)}, which trades inside limits: only the Candle Harness's limits hold for it, and nothing holds what the key does outside the Candle Harness`,
          fix: `The owner sets a cap on the key in Candle's Agent Console, on its Agents tab (${CONSOLE_KEYS}), or makes a new key with one: \`candle keys create --access write --embedded-wallet allow --tx-limit <usd>\`.`,
        })
      }
    }
  }
  if (inside.length > 0) {
    for (const [address, w] of payers) {
      if (!inside.some((e) => e.wallet === address)) out.push({ area: "wallet", state: "ok", text: `${label(address, w.name)} asks every time: each live trade from it is a card` })
    }
  }
  out.push({
    area: "limits",
    state: "ok",
    text: "Candle also has loss limits on each key (a day's realized loss, a fall from its high mark, losing trades in a row) and a circuit breaker on every key (30 trades in a minute, or 3 failed sells of one token in a row). A breach stops the key, sells included, until the owner resumes it in Candle's Agent Console, where they're set; the Candle Harness can't read them yet",
  })
  // Held keys, rebuilt from the journal as the core does at its start, with each key's window from Candle's status read.
  const holds = new KeyHolds({ window: (agent) => reads?.get(agent)?.status.keyLimit })
  holds.rebuild(rows)
  for (const hold of holds.all(now)) {
    if (!config.agents[hold.agent]) continue
    const a = hold.agent
    if (hold.why === "stopped") {
      out.push({ area: "limits", state: "warn", text: `${a}: Candle stopped its key (a loss limit or its circuit breaker), so the Candle Harness holds its trades, sells included, and asks Candle again from ${utcClock(hold.until!)}`, fix: `Waiting won't clear it: the owner reviews the key and resumes it in Candle's Agent Console (${CONSOLE_KEYS}).` })
    } else if (hold.why === "lifetime") {
      out.push({ area: "limits", state: "warn", text: `${a}: Candle's lifetime cap on its key is used up, so the Candle Harness holds its buys and swaps until the owner raises it; sells still go`, fix: `The owner raises or clears the cap in Candle's Agent Console (${CONSOLE_KEYS}).` })
    } else if (hold.why === "unavailable") {
      out.push({ area: "limits", state: "ok", text: `${a}: Candle couldn't check its key's cap a moment ago, so its buys and swaps wait until ${utcClock(hold.until!)}; sells still go` })
    } else {
      out.push({ area: "limits", state: "warn", text: `${a}: Candle's cap on its key is used up, so the Candle Harness holds its buys and swaps until ${utcClock(hold.until!)}, in ${inWords(hold.until! - now)}; sells still go`, fix: `Nothing to do: it lifts then. Sooner, only the owner can raise the cap, in Candle's Agent Console (${CONSOLE_KEYS}).` })
    }
  }
  return out
}

/**
 * While you were away: when the main view last closed, by the core's own rule (after a
 * core that died with the view open, its last row), and the last gap's summary from state/away.json.
 */
export function awayChecks(p: Paths, rows: readonly JournalRow[], now: number, coreRunning: boolean): Check[] {
  const end = lastSessionEnd(rows, { runEnded: !coreRunning }) ?? readWindowState(p.pnlWindow).sessionEnd
  const out: Check[] = [
    end === undefined
      ? { area: "away", state: "ok", text: "the main view hasn't closed yet, so there's no last session" }
      : { area: "away", state: "ok", text: `the last session ended ${localStamp(end)} (${agoWords(now - end)})` },
  ]
  let summary: AwaySummary | undefined
  try {
    const raw = JSON.parse(readFileSync(p.awayState, "utf8")) as { summary?: AwaySummary | null }
    if (raw.summary && typeof raw.summary.from === "number" && typeof raw.summary.to === "number") summary = raw.summary
  } catch {}
  if (!summary) {
    out.push({ area: "away", state: "ok", text: `no gap yet: while you were away fills once the main view has been closed for ${AWAY_MIN_GAP_MS / 60_000} minutes or more and opened again` })
    return out
  }
  const c = summary.counts
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const what = [
    c.trades ? `${plural(c.trades, "trade")}${c.withoutCard ? ` (${c.withoutCard} without a card)` : ""}` : "",
    c.turns ? plural(c.turns, "turn") : "",
    c.stopped ? `${c.stopped} stopped or refused` : "",
    c.outside ? `${plural(c.outside, "fill")} outside the Candle Harness` : "",
  ].filter(Boolean)
  // As the note's show all says it: one stretch by its times, so a core that stopped a moment after the close
  // doesn't read as a partial outage.
  const clock = (ms: number) => localStamp(ms).slice(11)
  const stretches = summary.coreDown
  const total = stretches.reduce((n, d) => n + d.to - d.from, 0)
  const down = summary.coreGoneThroughout
    ? "; the core wasn't running"
    : stretches.length === 1
      ? `; the core wasn't running from ${clock(stretches[0]!.from)} to ${clock(stretches[0]!.to)}`
      : stretches.length
        ? `; the core wasn't running ${stretches.length} times, ${gapLength(total)} in all`
        : ""
  const said = summary.happened ? (what.length ? what.join(", ") : "something happened") : "nothing happened"
  out.push({ area: "away", state: "ok", text: `the last gap ran ${gapLength(summary.to - summary.from)}, from ${localStamp(summary.from)} to ${localStamp(summary.to)}: ${said}${down}. The palette's "while you were away" shows it` })
  return out
}

export function aliasesChecks(p: Paths): Check[] {
  let source: string
  try {
    source = readFileSync(p.configFile, "utf8")
  } catch {
    return []
  }
  const { map, problems } = parseAliases(source, "config.toml")
  if (problems.length === 0) return map.size === 0 ? [] : [{ area: "aliases", state: "ok", text: `${map.size} ${map.size === 1 ? "alias" : "aliases"} in ${p.configFile}: ${[...map.keys()].join(", ")}` }]
  return problems.map((problem) => ({ area: "aliases", state: "warn" as const, text: problem, fix: `Edit [aliases] in ${p.configFile}, then pick "read config.toml again" in the palette (ctrl-k); the other aliases work meanwhile.` }))
}

/**
 * layouts.toml: its tabs and layouts of yours, or each problem with its line, and which
 * layout each tab shows, by the view's own rule: the last chosen, else the file's, else Agent-first.
 */
export function layoutsChecks(p: Paths): Check[] {
  const store = fileStore(p)
  const source = store.read()
  const file = source === undefined ? EMPTY_FILE : parseLayouts(source, "layouts.toml")
  const choices = store.choices()
  const adjusted = store.adjusted()
  const shows = file.tabs
    .map((tab) => {
      const { layout, from } = tabShows(file, choices, tab)
      const why = from === "chosen" ? (layout.name === tab.layout ? "" : ", last picked") : from === "fallback" ? `, since there's no layout called ${JSON.stringify(choices[tab.name] ?? tab.layout)}` : ""
      // A tab's own changes, kept until saved by name, as the view reads them.
      const changed = adjusted[tab.name]?.base === layout.name ? ", with unsaved changes" : ""
      return `${tab.name} shows ${layout.name}${why}${changed}`
    })
    .join("; ")
  const checks: Check[] = []
  // The tabs shown and those ticked off: tabs are a setting, ticked in settings ▾.
  const names = (tabs: readonly { name: string }[]) => tabs.map((t) => t.name).join(", ")
  const hidden = file.hidden.map((h) => h.tab)
  const off = hidden.length ? `, ${hidden.length} ticked off (${names(hidden)})` : ""
  if (source === undefined) checks.push({ area: "layouts", state: "ok", text: `no ${p.layoutsFile}: ${file.tabs.length} tabs (${names(file.tabs)}), each on its preset${off}` })
  else if (file.problems.length === 0) checks.push({ area: "layouts", state: "ok", text: `${p.layoutsFile}: ${file.tabs.length} ${file.tabs.length === 1 ? "tab" : "tabs"} shown (${names(file.tabs)})${off}, ${file.own.length} ${file.own.length === 1 ? "layout" : "layouts"} of yours` })
  if (file.added.length) checks.push({ area: "layouts", state: "ok", text: `new since ${p.layoutsFile} listed its tabs, ticked off: ${file.added.join(", ")}. Tick them on in the view's settings ▾.` })
  for (const problem of file.problems) checks.push({ area: "layouts", state: "warn", text: problem, fix: `Edit ${p.layoutsFile}; until then the view uses the presets in place of what it can't read, and won't write the file.` })
  checks.push({ area: "layouts", state: "ok", text: shows })
  return checks
}

/**
 * Themes: config.toml's [theme] name, the theme the view starts on and why, and
 * each theme of yours that can't be used or leaves something out, by the check every theme gets when it
 * loads. Terminal's colours are the terminal's, read when the view starts, so the doctor can't check them.
 */
export function themeChecks(p: Paths): Check[] {
  let source: string | undefined
  try {
    source = readFileSync(p.configFile, "utf8")
  } catch {
    source = undefined
  }
  const store = fileThemes(p)
  const fromConfig = configTheme(source)
  const checks: Check[] = []
  if (fromConfig.problem) checks.push({ area: "theme", state: "warn", text: fromConfig.problem, fix: `Edit [theme] in ${p.configFile}; the view starts on the theme last picked, else ${CANDLE_DARK}.` })
  const starts = startingTheme(store, fromConfig.name)
  const chosen = store.chosen()
  const why = chosen && chosen.config === fromConfig.name ? "the theme last picked" : fromConfig.name ? "config.toml's [theme] name" : "the default"
  const own = store.own()
  const yours = own.length ? `; ${own.length} of yours in ${store.dir}: ${own.join(", ")}` : ""
  if (starts.toLowerCase() === TERMINAL.toLowerCase()) {
    checks.push({ area: "theme", state: "ok", text: `the view starts on ${TERMINAL} (${why}), drawn from the terminal's own colours, read and checked when it starts${yours}` })
  } else {
    const loaded = loadTheme(starts, store)
    if (loaded.used) checks.push({ area: "theme", state: "ok", text: `the view starts on ${loaded.name} (${why})${yours}` })
    else checks.push({ area: "theme", state: "warn", text: `${loaded.problems[0]}: the view starts on ${CANDLE_DARK} instead`, fix: `Pick a theme in the palette (ctrl-k, Themes)${own.includes(starts) ? `, or fix ${store.dir}/${starts}.toml` : ""}.` })
  }
  for (const name of own) {
    const loaded = loadTheme(name, store)
    // A theme that can't be used says why first; the rest are leaves it left out.
    const refusal = loaded.used ? undefined : loaded.problems[0]
    const leftOut = loaded.used ? loaded.problems : loaded.problems.slice(1)
    if (refusal && name !== starts) checks.push({ area: "theme", state: "warn", text: refusal, fix: `Fix ${store.dir}/${name}.toml; the palette won't draw it until then.` })
    const meanwhile = loaded.used ? "the rest of it is used meanwhile" : "the palette won't draw it until then"
    for (const problem of leftOut) checks.push({ area: "theme", state: "warn", text: problem, fix: `Fix ${store.dir}/${name}.toml; ${meanwhile}.` })
  }
  return checks
}

/** A level read slower than this is named: it aims for about every 5 s. */
const SLOW_LEVEL_MS = 30_000

/** What the doctor reads for keeping the core up, gathered: the triggers.toml and state, the running core, the service. */
export interface KeptRead {
  platform: NodeJS.Platform
  /** The triggers switched on, as triggers.toml and the core's state both say, by name. */
  on: string[]
  /** config.toml's `[core] keepAwake`, and the choice last made, if any. */
  keepAwake: boolean
  core?: { pid?: number; headless?: boolean; holds?: string[]; triggersOn?: number; keepAwake?: KeepAwakeView; triggers?: TriggersTopic; notify?: { native: boolean } }
  /** triggers.toml's problems, each naming its line. */
  problems?: string[]
  service?: ServiceState
  /** The Candle TUI 0.2's login service file, when it's still installed. */
  oldService?: string
  /** Linux: whether lingering is on, by loginctl; undefined when it can't say. */
  linger?: boolean
  /** Whether this shell has CANDLE_KEYRING_PASSPHRASE, which the login service never carries. */
  keyringPassphrase?: boolean
}

/**
 * Keeping the core up, in words: how many triggers are on and whether a core watches them, what holds a running
 * core, each level's pace, the login service, and keep-awake.
 */
export function keptRunningWords(r: KeptRead): Check[] {
  const out: Check[] = []
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`
  for (const problem of r.problems ?? []) out.push({ area: "trigger", state: "warn", text: problem, fix: "Fix that line in triggers.toml, or ask the agent to propose the trigger again: the Candle Harness won't write the file until it reads cleanly." })
  if (r.core) {
    const who = `the running core${r.core.pid ? ` (pid ${r.core.pid})` : ""}`
    const holds = r.core.holds ?? []
    const services = r.service?.installed && r.core.pid !== undefined && r.service.running === r.core.pid
    if (services) out.push({ area: "core", state: "ok", text: `${who} is the login service's: it runs until \`candle-harness stop\`, and starts again at your next login${holds.length ? `; now ${holds.join(", ")}` : ""}` })
    else if (r.core.headless) out.push({ area: "core", state: "ok", text: `${who} is headless: it runs until \`candle-harness stop\`${holds.length ? `; now ${holds.join(", ")}` : ""}` })
    else out.push({ area: "core", state: "ok", text: holds.length ? `${who} was started by a view, and is held up by: ${holds.join(", ")}` : `${who} was started by a view, and nothing holds it: it exits within a minute` })
    const on = r.core.triggersOn ?? 0
    if (on) out.push({ area: "trigger", state: "ok", text: `${n(on, "trigger")} on ${on === 1 ? "keeps" : "keep"} the core running after the view quits; \`candle-harness stop\` ends it` })
    for (const t of r.core.triggers?.triggers ?? []) {
      if (!t.on) continue
      if (t.held) out.push({ area: "trigger", state: "warn", text: `trigger "${t.name}" is on and held: ${t.held.words}` })
      else if (t.class === "level" && t.paceMs !== undefined && t.paceMs > SLOW_LEVEL_MS) out.push({ area: "trigger", state: "warn", text: `trigger "${t.name}": ${t.watching ?? `checked about every ${Math.round(t.paceMs / 1000)} s`}, slower than the 5 s it aims for`, fix: "Candle's market read is slow or the key is rate-limited; candle-harness doctor's candle lines say which." })
      else if (t.watching) out.push({ area: "trigger", state: "ok", text: `trigger "${t.name}": ${t.watching}` })
      // Nothing to watch (an on call trigger, a fill, a card expiring): what it waits for, in its own words.
      else out.push({ area: "trigger", state: "ok", text: /^on call\b/.test(t.line) ? `trigger "${t.name}": waits for \`candle-harness trigger "${t.name}"\`` : `trigger "${t.name}": ${t.words}` })
      if (t.readsNow) out.push({ area: "trigger", state: "warn", text: `trigger "${t.name}": ${t.readsNow}`, fix: "Ask the agent to propose it again if you want it to follow the new reading." })
    }
  }
  if (!r.on.length && !(r.core?.triggersOn ?? 0) && !(r.core?.triggers?.triggers ?? []).some((t) => t.on)) out.push({ area: "trigger", state: "ok", text: "no trigger is on" })
  else if (!r.core && r.on.length) {
    out.push({ area: "trigger", state: "warn", text: `${n(r.on.length, "trigger")} on in triggers.toml, and no core is running, so none is watched`, fix: "Open the Candle Harness (candle-harness), run `candle-harness core` in tmux, or `candle-harness service install` to start the core at login." })
  }
  if (r.oldService) out.push({ area: "core", state: "warn", text: `${r.oldService} is the Candle TUI 0.2's login service: it runs \`candle-tui core\` on the old home at login`, fix: "Run `candle-harness service install` to replace it with this one, or `candle-harness service uninstall` to remove it." })
  if (r.service) {
    const s = r.service
    if (!s.installed) out.push({ area: "core", state: "ok", text: `the login service isn't installed${r.on.length ? "; `candle-harness service install` starts the core at login, so triggers run with no terminal open" : ""}` })
    else {
      out.push({ area: "core", state: "ok", text: `the login service is installed (${s.file}): ${s.words}` })
      if (r.platform === "linux" && r.linger === false) out.push({ area: "core", state: "warn", text: "lingering is off for your user, so the service's core stops when you log out", fix: "On a VPS, run `loginctl enable-linger $USER` (it may need sudo); the Candle Harness never runs it." })
      // With no keychain, the CLI signs for a TEE wallet from its file store, which only the passphrase opens.
      if (r.platform === "linux" && r.keyringPassphrase)
        out.push({
          area: "core",
          state: "warn",
          text: "this shell opens the CLI's store with CANDLE_KEYRING_PASSPHRASE, which the login service doesn't carry, so a TEE wallet's trades from the service's core are refused",
          fix: "Trade from the embedded wallet on this machine, or uninstall the service and run `candle-harness core` in tmux from a shell that has the passphrase.",
        })
    }
  }
  const awake = r.core?.keepAwake
  if (r.platform === "darwin") {
    const on = awake?.on ?? r.keepAwake
    if (awake?.failed) out.push({ area: "core", state: "warn", text: `keep-awake is on, and ${awake.failed}`, fix: "Switch it off and on in ctrl-k's palette to try again; `which caffeinate` should name /usr/bin/caffeinate." })
    else out.push({ area: "core", state: "ok", text: on ? `keep-awake is on: the Mac is kept from sleeping while a trigger or bot is on${awake?.active ? " (now)" : ""}; a closed lid still sleeps it on battery` : `keep-awake is off: the Mac may sleep while triggers or bots are on, and they wait for it${r.on.length ? " (ctrl-k's palette: keep the Mac awake)" : ""}` })
  } else if (r.keepAwake) {
    out.push({ area: "core", state: "warn", text: "config.toml sets [core] keepAwake, which is macOS only: it does nothing here", fix: "Remove keepAwake from config.toml's [core]." })
  }
  return out
}

/** The triggers switched on, as triggers.toml and the core's state both say. */
function triggersOn(p: Paths): string[] {
  const file = new TriggersFileStore(p.triggersFile).read()
  let state: Record<string, { on?: unknown }> = {}
  try {
    state = (JSON.parse(readFileSync(p.triggersState, "utf8")) as { triggers?: Record<string, { on?: unknown }> }).triggers ?? {}
  } catch {}
  return file.triggers.filter((t) => t.on && state[t.name]?.on === true).map((t) => t.name)
}

async function keptRunningChecks(p: Paths, config: Config | undefined, coreUp: boolean, service: ServiceDeps, keyringPassphrase: boolean): Promise<Check[]> {
  let keepAwake = config?.core?.keepAwake ?? false
  try {
    const kept = (JSON.parse(readFileSync(join(p.stateDir, "keep-awake.json"), "utf8")) as { on?: unknown }).on
    if (typeof kept === "boolean") keepAwake = kept
  } catch {}
  let core: KeptRead["core"]
  if (coreUp) {
    core = await (async () => {
      const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
      try {
        const status = record(await connection.request("core.status", {}))
        const triggers = (await connection.request("triggers.list", {}).catch(() => undefined)) as TriggersTopic | undefined
        return {
          ...(typeof status?.pid === "number" ? { pid: status.pid } : {}),
          ...(typeof status?.headless === "boolean" ? { headless: status.headless } : {}),
          ...(Array.isArray(status?.holds) ? { holds: status.holds.filter((h): h is string => typeof h === "string") } : {}),
          ...(typeof status?.triggersOn === "number" ? { triggersOn: status.triggersOn } : {}),
          ...(record(status?.keepAwake) ? { keepAwake: status!.keepAwake as KeepAwakeView } : {}),
          ...(triggers && Array.isArray(triggers.triggers) ? { triggers } : {}),
        }
      } finally {
        connection.close()
      }
    })().catch(() => undefined)
  }
  const state = serviceState(service)
  let linger: boolean | undefined
  if (service.platform === "linux" && state?.installed && service.user) {
    const r = service.run("loginctl", ["show-user", service.user, "--property=Linger", "--value"])
    if (r.code === 0 && /^(yes|no)$/.test(r.stdout.trim())) linger = r.stdout.trim() === "yes"
  }
  const problems = new TriggersFileStore(p.triggersFile).read().problems
  const oldService = oldServiceFile(service)
  return keptRunningWords({ platform: service.platform, on: triggersOn(p), keepAwake, problems, ...(core ? { core } : {}), ...(state ? { service: state } : {}), ...(oldService ? { oldService } : {}), ...(linger !== undefined ? { linger } : {}), keyringPassphrase })
}

/** What the doctor reads for rules bots: bots.toml, the core's state file, and a running core's own list. */
export interface BotsRead {
  /** bots.toml's problems, each naming its line. */
  problems: string[]
  /** The bots in bots.toml that the core's state says go on (approved, and neither paused nor stopped), by name. */
  on: string[]
  /** How many bots bots.toml holds. */
  saved: number
  /** The running core's list, and how many bots it says keep it up. */
  core?: { topic: BotsTopic; botsOn?: number }
  /**
   * Code bots, as bots.toml and the state hold them with no core: how many, the ones that go on, the ones whose
   * process was given up on after crashing (a core won't start those by itself), and any whose folder is gone.
   */
  code?: { saved: number; on: string[]; gaveUp?: { name: string; crashes: number }[]; noFolder?: { name: string; folder: string }[] }
}

const HELD_FIX: Record<string, string> = {
  NOT_APPROVED: "Ask the agent to propose it, and approve its card; or take it out of bots.toml.",
  CHANGED_OUTSIDE: "Ask the agent to propose the change, and approve its card; or put bots.toml back as it was approved.",
  AGENT_GONE: "Add the agent back with `candle-harness key add --agent <name>`, or flatten and remove the bot on the Bots tab.",
}

const CODE_HELD_FIX: Record<string, string> = {
  NOT_APPROVED: "Propose it from its Build pane (`candle-harness build propose`) and approve its card; or take it out of bots.toml.",
  CHANGED_OUTSIDE: "Propose the change from its Build pane and approve its card; or put bots.toml back as it was approved.",
  AGENT_GONE: "Add the agent back with `candle-harness key add --agent <name>`, or flatten and remove the bot on the Bots tab.",
}

const NO_CORE_FIX = "Open the Candle Harness (candle-harness), run `candle-harness core` in tmux, or `candle-harness service install` to start the core at login."
const logsFix = (name: string) => `Read why with \`candle-harness bots logs ${name}\`.`
const gaveUpFix = (name: string) => `Read why with \`candle-harness bots logs ${name}\`, fix its code, then \`candle-harness bots start ${name}\`.`

/**
 * Rules bots, in words: bots.toml's problems; with a core, each bot's state, mode, wallet and open positions,
 * what holds it (a hand edit, the plan, Candle's stop on its key) and any sell its exits hold; a live bot on a
 * shared wallet as a note; without a core, the bots that would trade and don't.
 */
export function botWords(r: BotsRead): Check[] {
  const out: Check[] = []
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`
  for (const problem of r.problems) out.push({ area: "bot", state: "warn", text: problem, fix: "Fix that line in bots.toml, or ask the agent to propose the bot again: the Candle Harness won't write the file until it reads cleanly." })
  const c = r.code ?? { saved: 0, on: [] }
  if (!r.saved && !c.saved) {
    if (!r.problems.length) out.push({ area: "bot", state: "ok", text: "no bot is saved, rules or code" })
    return out
  }
  if (!r.core) {
    if (r.on.length) out.push({ area: "bot", state: "warn", text: `${n(r.on.length, "bot")} on in bots.toml, and no core is running, so none enters, and their exits don't sell what they hold`, fix: NO_CORE_FIX })
    else if (r.saved) out.push({ area: "bot", state: "ok", text: `${n(r.saved, "bot")} in bots.toml, none on` })
    if (c.on.length) out.push({ area: "bot", state: "warn", text: `${n(c.on.length, "code bot")} on in bots.toml, and no core is running, so none runs, and the exits the core holds for them don't sell`, fix: NO_CORE_FIX })
    else if (c.saved) out.push({ area: "bot", state: "ok", text: `${n(c.saved, "code bot")} in bots.toml, none on` })
  }
  for (const g of c.gaveUp ?? []) if (!r.core) out.push({ area: "bot", state: "warn", text: `code bot "${g.name}" crashed ${g.crashes} times in a row and was given up on: a core won't start it again by itself`, fix: gaveUpFix(g.name) })
  for (const f of c.noFolder ?? []) out.push({ area: "bot", state: "warn", text: `code bot "${f.name}": its folder ${f.folder} isn't there`, fix: "Put its code back there, or propose the bot again from its Build pane with the folder it's in now, and approve its card." })
  if (!r.core) return out
  const t = r.core.topic
  if (t.gate && (t.bots.length || t.code?.length)) out.push({ area: "bot", state: "warn", text: `${t.gate.words}: no bot enters on this plan, and each bot's exits still sell what it holds`, ...(t.gate.fix ? { fix: t.gate.fix } : {}) })
  const on = r.core.botsOn ?? 0
  if (on) out.push({ area: "bot", state: "ok", text: `${n(on, "bot")} ${on === 1 ? "keeps" : "keep"} the core running after the view quits; \`candle-harness stop\` ends it` })
  for (const b of t.bots) {
    const open = t.books?.[b.name]?.open.length ?? b.open ?? 0
    const pays = b.paysFrom ?? (b.wallet === "embedded" ? "embedded" : short(b.wallet))
    const does = b.state === "on" && !b.held ? (b.entries ? "enters and sells" : "sells") : (b.stateWords ?? b.state)
    const head = `bot "${b.name}": ${b.mode} · ${does} · ${b.agent}, pays from ${pays}${open ? ` · ${n(open, "open position")}` : ""}`
    if (b.byCandle) out.push({ area: "bot", state: "warn", text: head, fix: "Resume the key in Candle's Agent Console, then put the bot back on from the Bots tab." })
    else out.push({ area: "bot", state: "ok", text: head })
    if (b.held) out.push({ area: "bot", state: b.held.code === "PLAN_FREE" || b.held.code === "PLAN_UNKNOWN" ? "ok" : "warn", text: `bot "${b.name}" is held: ${b.held.words}`, ...(HELD_FIX[b.held.code] ? { fix: HELD_FIX[b.held.code] } : {}) })
    for (const h of b.sellsHeld ?? []) {
      if (h.why === "failed_sells") out.push({ area: "bot", state: "warn", text: `bot "${b.name}": ${h.words}`, fix: "Check why the sells failed (on a young token, often slippage), then use the bot's `retry its sells` chip on the Bots tab." })
      else out.push({ area: "bot", state: "ok", text: `bot "${b.name}": ${h.words}` })
    }
    // A note, not a warning: a shared wallet is the person's pick, and the book is still the bot's own fills.
    if (b.mode === "live" && b.sharedWith?.length) out.push({ area: "bot", state: "ok", text: `bot "${b.name}" trades live from ${pays}, shared with ${sharedWithWords(b.sharedWith)}: its book is the Candle Harness's count from its own fills, and a wallet of its own would fence what it can lose` })
  }
  for (const b of t.code ?? []) if (!isTestName(b.name)) out.push(...codeBotLines(b, t.books?.[b.name]?.open.length ?? 0))
  return out
}

/**
 * One code bot with a core running: its state and wallet, what holds it, its process as the supervisor runs it (or,
 * run outside, its token and whether it's connected), a memory or CPU warning, and the exits the core holds for it.
 */
function codeBotLines(b: CodeBotView, open: number): Check[] {
  const out: Check[] = []
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`
  const who = `code bot "${b.name}"`
  const pays = b.paysFrom ?? (b.wallet === "embedded" ? "embedded" : short(b.wallet))
  const does = b.state === "on" && !b.held ? (b.buys ? "buys and sells" : "sells") : (b.stateWords ?? b.state)
  const head = `${who}: ${b.mode} · ${does} · ${b.agent}, pays from ${pays}${open ? ` · ${n(open, "open position")}` : ""}`
  if (b.byCandle) out.push({ area: "bot", state: "warn", text: head, fix: "Resume the key in Candle's Agent Console, then put the bot back on from the Bots tab." })
  else out.push({ area: "bot", state: "ok", text: head })
  if (b.held) out.push({ area: "bot", state: b.held.code === "PLAN_FREE" || b.held.code === "PLAN_UNKNOWN" ? "ok" : "warn", text: `${who} is held: ${b.held.words}`, ...(CODE_HELD_FIX[b.held.code] ? { fix: CODE_HELD_FIX[b.held.code] } : {}) })
  const p = b.process
  if (p?.runs === "outside") {
    if (!b.token) out.push({ area: "bot", state: "warn", text: `${who} runs outside the Candle Harness and has no token yet, so it can't connect`, fix: `Run \`candle-harness bots token ${b.name}\`: it writes the bot's token to .harness-bot.json in its folder, where the client reads it.` })
    else if (!b.connected) out.push({ area: "bot", state: b.state === "on" ? "warn" : "ok", text: `${who} runs outside the Candle Harness and isn't connected: its buys don't run, and the exits the core holds still sell`, fix: `Start it where you run it: its folder's .harness-bot.json holds its token. Or \`candle-harness bots start ${b.name}\` runs it here instead.` })
    else out.push({ area: "bot", state: "ok", text: `${who} runs outside the Candle Harness, connected` })
  } else if (p) {
    if (p.state === "restarting") out.push({ area: "bot", state: "warn", text: `${who} crashed: ${p.words}`, fix: logsFix(b.name) })
    else if (p.state === "gave_up") out.push({ area: "bot", state: "warn", text: `${who}'s process: ${p.words}`, fix: gaveUpFix(b.name) })
    else {
      const extra = p.state === "running" ? [p.crashes ? `${p.crashes} ${p.crashes === 1 ? "crash" : "crashes"} in 10 minutes` : undefined, p.memoryMb !== undefined ? `${p.memoryMb} MB` : undefined, p.cpuPct !== undefined ? `${p.cpuPct}% CPU` : undefined].filter(Boolean) : []
      out.push({ area: "bot", state: "ok", text: `${who}'s process: ${[p.words, ...extra].join(" · ")}` })
    }
    if (p.warning) out.push({ area: "bot", state: "warn", text: `${who}: ${p.warning}`, fix: `Check its log with \`candle-harness bots logs ${b.name}\`: the Candle Harness only says so, it doesn't stop it.` })
  }
  const exits = b.heldExits ?? []
  let quiet = 0
  for (const h of exits) {
    const token = h.symbol ?? short(h.mint)
    if (h.waits) out.push({ area: "bot", state: "warn", text: `${who}: the exits the core holds on ${token} wait: ${h.waits}`, fix: "Check why the sells failed (on a young token, often slippage), then use the bot's `retry its sells` chip on the Bots tab." })
    else if (h.selling) out.push({ area: "bot", state: "ok", text: `${who}: the core is selling its ${token} position (${h.words})` })
    else quiet++
  }
  if (quiet) out.push({ area: "bot", state: "ok", text: `${who}: the core holds exits on ${quiet < exits.length ? `${quiet} more` : quiet} open position${quiet === 1 ? "" : "s"}` })
  return out
}

export async function botChecks(p: Paths, coreUp: boolean): Promise<Check[]> {
  const file = new BotsFileStore(p.botsFile).read()
  let state: Record<string, { run?: unknown }> = {}
  try {
    state = (JSON.parse(readFileSync(p.botsState, "utf8")) as { bots?: Record<string, { run?: unknown }> }).bots ?? {}
  } catch {}
  const on = file.bots.filter((b) => b.state === "on" && state[b.name]?.run === "on").map((b) => b.name)
  const code = codeBotsRead(p, file.code)
  let core: BotsRead["core"]
  if (coreUp) {
    core = await (async () => {
      const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
      try {
        const topic = (await connection.request("bots.list", {})) as BotsTopic | undefined
        if (!topic || !Array.isArray(topic.bots)) return undefined
        const status = record(await connection.request("core.status", {}).catch(() => undefined))
        return { topic, ...(typeof status?.botsOn === "number" ? { botsOn: status.botsOn } : {}) }
      } finally {
        connection.close()
      }
    })().catch(() => undefined)
  }
  return botWords({ problems: file.problems, on, saved: file.bots.length, ...(code.saved ? { code } : {}), ...(core ? { core } : {}) })
}

/** Code bots with no core needed: which go on, which the supervisor gave up on, and any whose folder is gone. */
function codeBotsRead(p: Paths, entries: readonly CodeBotEntry[]): NonNullable<BotsRead["code"]> {
  const read = <T>(path: string): Record<string, T> => {
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { bots?: Record<string, T> }).bots ?? {}
    } catch {
      return {}
    }
  }
  const state = read<{ run?: unknown }>(p.codeBotsState)
  const sup = read<{ gaveUp?: { crashes?: unknown } }>(p.supervisorState)
  const named = entries.filter((b) => !isTestName(b.name))
  return {
    saved: named.length,
    on: named.filter((b) => b.state === "on" && state[b.name]?.run === "on").map((b) => b.name),
    gaveUp: named.flatMap((b) => (typeof sup[b.name]?.gaveUp?.crashes === "number" ? [{ name: b.name, crashes: sup[b.name]!.gaveUp!.crashes as number }] : [])),
    noFolder: named.filter((b) => !existsSync(b.folder)).map((b) => ({ name: b.name, folder: b.folder })),
  }
}

/** What the doctor reads for the bots folder: the Build tab's choices, and the folder against what's written there. */
export interface BuildFolderRead {
  prefs: Pick<BuildPrefs, "folder" | "opened">
  look: FolderLook
  /** The folder with the home as `~`. */
  shown: string
}

const listed = (items: readonly string[]) => {
  const head = items.slice(0, 4)
  const more = items.length - head.length
  if (more) return `${head.join(", ")} and ${more} more`
  return head.length > 1 ? `${head.slice(0, -1).join(", ")} and ${head.at(-1)}` : (head[0] ?? "")
}

/**
 * The bots folder, in words: not asked for yet, gone, missing files or older ones (fixed by `bots init`, which keeps
 * what the person changed), up to date, and the person's own files named as kept.
 */
export function buildFolderWords(r: BuildFolderRead): Check[] {
  const { look, shown } = r
  const init = `candle-harness bots init${r.prefs.folder === DEFAULT_BOTS_FOLDER ? "" : ` ${r.prefs.folder}`}`
  if (!look.exists) {
    if (!r.prefs.opened) return [{ area: "build", state: "ok", text: `the Build tab hasn't been opened here yet: its first open asks where your bots live (${shown} unless you pick another)` }]
    return [{ area: "build", state: "warn", text: `the bots folder ${shown} isn't there`, fix: `Run \`${init}\` to write it again, or pick another folder in the Build tab.` }]
  }
  const out: Check[] = []
  if (look.missing.length || look.older.length) {
    const parts = [
      ...(look.missing.length ? [`is missing ${look.missing.length} of the Candle Harness's files`] : []),
      ...(look.older.length ? [`${look.missing.length ? "and " : "has "}${look.older.length} ${look.older.length === 1 ? (look.missing.length ? "is" : "file") : look.missing.length ? "are" : "files"} from an older Candle Harness`] : []),
    ]
    out.push({ area: "build", state: "warn", text: `the bots folder ${shown} ${parts.join(", ")}`, fix: `Run \`${init}\`: it adds what's missing, updates what you haven't changed, and keeps what you have.` })
  } else out.push({ area: "build", state: "ok", text: `the bots folder is ${shown}: AGENTS.md, the client and Candle's skills are up to date` })
  if (look.kept.length) {
    const one = look.kept.length === 1
    out.push({ area: "build", state: "ok", text: `in the bots folder, ${listed(look.kept)} ${one ? "is" : "are"} yours (changed by you, or there before): kept as ${one ? "it is" : "they are"}, never written over` })
  }
  return out
}

/** What the doctor reads for the Build tab's harnesses: each engine's own check, and the one picked. */
export interface BuildHarnessRead {
  engines: Record<EngineId, { ok: boolean; version?: string; message?: string }>
  harness?: string
  from?: "saved" | "config"
  /** A command of the person's own: its program, and whether it's found. */
  command?: { word: string; found: boolean }
}

/**
 * The harnesses the Build tab can open, in words: each engine installed here with its version (an engine older than an
 * agent needs still opens, since the Build tab runs it as the person's own), and the one it opens, warned when it can't.
 */
export function buildHarnessWords(r: BuildHarnessRead): Check[] {
  const ids = Object.keys(ENGINE_LABELS) as EngineId[]
  const here = ids.filter((id) => r.engines[id]?.version)
  const gone = ids.filter((id) => !r.engines[id]?.version)
  const out: Check[] = [
    here.length
      ? { area: "build", state: "ok", text: `the Build tab can open ${here.map((id) => `${ENGINE_LABELS[id]} ${r.engines[id]!.version}`).join(", ")}${gone.length ? `; not installed here: ${gone.map((id) => ENGINE_LABELS[id]).join(", ")}` : ""}` }
      : { area: "build", state: "ok", text: "none of the five harnesses is installed here; the Build tab can still run a command of your own" },
  ]
  if (!r.harness) {
    out.push({ area: "build", state: "ok", text: "no harness is picked for the Build tab yet: its first open asks" })
    return out
  }
  const from = r.from === "config" ? "config.toml's [build] harness" : "picked in the Build tab"
  if (isEngineHarness(r.harness)) {
    const label = ENGINE_LABELS[r.harness]
    if (r.engines[r.harness]?.version) out.push({ area: "build", state: "ok", text: `the Build tab opens ${label} (${from})` })
    else out.push({ area: "build", state: "warn", text: `the Build tab opens ${label} (${from}), which isn't installed here`, fix: `Install ${label}, or pick another harness with the Build pane's harness ▾.` })
    return out
  }
  if (r.command && !r.command.found) {
    out.push({ area: "build", state: "warn", text: `the Build tab opens your own command, ${r.harness} (${from}), and ${r.command.word} isn't found on your PATH`, fix: "Install it, give its full path, or pick another harness with the Build pane's harness ▾." })
  } else out.push({ area: "build", state: "ok", text: `the Build tab opens your own command, ${r.harness} (${from})` })
  return out
}

async function buildFolderChecks(p: Paths, config: Config | undefined, home: string | undefined): Promise<Check[]> {
  const prefs = readBuildPrefs(p.buildPrefs, config?.build)
  const folder = botsFolderPath(prefs.folder, home)
  const h = home ?? ""
  const shown = h && folder === h ? "~" : h && folder.startsWith(`${h}/`) ? `~${folder.slice(h.length)}` : folder
  return buildFolderWords({ prefs, look: await lookAtBotsFolder(folder), shown })
}

/** An engine's own check, run once per doctor run when a cache is given. */
function checkOnce(cache: Map<EngineId, Promise<EngineCheck>> | undefined, engine: Engine, env: Record<string, string>): Promise<EngineCheck> {
  const run = () => engine.check(env).catch((error: Error): EngineCheck => ({ ok: false, message: error.message }))
  if (!cache) return run()
  let p = cache.get(engine.id)
  if (!p) cache.set(engine.id, (p = run()))
  return p
}

async function buildHarnessChecks(p: Paths, config: Config, env: Record<string, string | undefined>, checked?: Map<EngineId, Promise<EngineCheck>>): Promise<Check[]> {
  const prefs = readBuildPrefs(p.buildPrefs, config.build)
  const homesDir = join(p.stateDir, "doctor-homes")
  const engines = buildEngines(config, { homesDir, stateDir: p.stateDir }, env)
  const clean = harnessEnv(env)
  const ids = Object.keys(ENGINE_LABELS) as EngineId[]
  const checks = await Promise.all(ids.map((id) => checkOnce(checked, engines.get(id)!, clean)))
  const read: BuildHarnessRead = { engines: Object.fromEntries(ids.map((id, i) => [id, checks[i]!])) as BuildHarnessRead["engines"] }
  if (prefs.harness) {
    read.harness = prefs.harness
    if (prefs.from.harness) read.from = prefs.from.harness
    if (!isEngineHarness(prefs.harness)) {
      const word = commandArgv(prefs.harness)[0] ?? prefs.harness
      const found = word.includes("/") ? existsSync(botsFolderPath(word, env.HOME)) : Bun.which(word, { PATH: env.PATH ?? "" }) !== null
      read.command = { word, found }
    }
  }
  return buildHarnessWords(read)
}

/** What the doctor reads for notifications: the settings, this machine, and a running core's own judgement. */
export interface NotifyRead {
  settings: NotifySettings
  /** This shell is over SSH, or in a VPS's container. */
  remote: boolean
  /** A core started from this shell could show the computer's own notification. */
  native: boolean
  /** The running core's own answer, when one runs: it may have been started elsewhere. */
  core?: { native: boolean }
  /** Triggers switched on: they act with nobody watching, so how they reach you matters. */
  triggersOn: number
  /** This machine's platform: on a Mac, the computer's own notification is filed under Script Editor. */
  platform?: string
}

/** macOS files `osascript`'s notifications under Script Editor, which may be set to show no banner. */
export const MAC_BANNER_WORDS =
  "on a Mac, the computer's own notifications are filed under Script Editor: if they reach Notification Center with no banner, set Script Editor to Banners or Alerts in System Settings → Notifications"


const NOTIFIER_WORDS: Record<Notifier, string> = { native: "your computer's own notification", osc: "the terminal's own notification", bell: "the terminal's bell" }

/**
 * Notifications, in words: what the main view sends while its window isn't in front, and what reaches you with no
 * Candle Harness window open (the computer's own on a Mac or a Linux desktop; nothing on a VPS, over SSH or in a container).
 */
export function notifyWords(r: NotifyRead): Check[] {
  const { mode, on } = r.settings
  if (mode === "off") return [{ area: "notify", state: "ok", text: 'notifications are off (config.toml\'s [notify] mode = "off"): nothing is sent, with a Candle Harness window open or not' }]
  if (!on.length) return [{ area: "notify", state: "ok", text: "nothing notifies: config.toml's [notify] on is an empty list" }]
  const out: Check[] = []
  const first: Notifier = mode === "auto" ? (r.remote ? "osc" : "native") : mode
  const chain = fallbacks(first).filter((k) => k !== "native" || r.native)
  const some = on.length < NOTIFY_KINDS.length ? ` (only ${on.join(", ")}, by [notify] on)` : ""
  const [lead, ...rest] = chain.map((k) => NOTIFIER_WORDS[k])
  out.push({ area: "notify", state: "ok", text: `with a Candle Harness window open, the main view tells you while its window isn't in front: ${lead}${rest.length ? `, else ${rest.join(", else ")}` : ""}${some}` })
  const native = r.core?.native ?? r.native
  const who = r.core ? "the running core" : "a core started here"
  if (native) out.push({ area: "notify", state: "ok", text: `with no Candle Harness window open, ${who} shows your computer's own notification` })
  if (r.platform === "darwin" && (native || chain.includes("native"))) out.push({ area: "notify", state: "ok", text: MAC_BANNER_WORDS })
  if (!native) {
    out.push({
      area: "notify",
      state: r.triggersOn ? "warn" : "ok",
      text: `with no Candle Harness window open, nothing reaches you: ${who} ${r.core ? "has" : "would have"} no screen to show a notification on (over SSH, on a VPS or in a container)${r.triggersOn ? `, and ${r.triggersOn === 1 ? "a trigger is" : `${r.triggersOn} triggers are`} on` : ""}`,
      ...(r.triggersOn ? { fix: "Keep the Candle Harness open in tmux and reattach over SSH to be told: its main view sends the terminal's notification. A trigger's card still waits only 60 s." } : {}),
    })
  }
  return out
}

async function notifyChecks(p: Paths, config: Config | undefined, env: Record<string, string | undefined>, coreUp: boolean): Promise<Check[]> {
  let core: NotifyRead["core"]
  if (coreUp) {
    core = await (async () => {
      const { connection } = await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: DOCTOR_CLIENT })
      try {
        const n = record(record(await connection.request("core.status", {}))?.notify)
        return typeof n?.native === "boolean" ? { native: n.native } : undefined
      } finally {
        connection.close()
      }
    })().catch(() => undefined)
  }
  return notifyWords({
    settings: config?.notify ?? DEFAULT_NOTIFY,
    remote: isRemote(env),
    native: canNotifyNative(process.platform, env),
    triggersOn: triggersOn(p).length,
    platform: process.platform,
    ...(core ? { core } : {}),
  })
}
