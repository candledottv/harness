// The core: one per account per machine, the only thing that trades. It holds the agents' keys, runs
// Candle's MCP server per agent, keeps the journal, the cards and the operations, and serves the
// attach socket. Views and engines attach to it.
//
// Starting: the private state folder, the instance lock, the socket rules (only a dead core's socket
// is removed), the journal rebuilt before it listens (spend, operations, cards left open), then the
// socket, then Candle's MCP children in the background (each can take 15 s to start).
//
// Staying up: `candle-harness core` (headless) runs until it's stopped (`candle-harness stop`, or a signal). A core a
// view started for itself stays up while a view is attached, an engine turn runs, an operation is in flight or
// being read back, a card is open, or a trigger is on, and exits 60 s after none of those hold. Keep-awake
// (macOS) keeps the Mac awake while a trigger or bot is on.
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { type Config, MAX_AGENTS, parseConfig } from "../config"
import type { Paths } from "../paths"
import { ensureStateDir, isAgentName } from "../paths"
import { isTestName } from "../shared/bot-name"
import { apiKeyPrefix } from "../shared/api-key"
import { acquireInstanceLock, type InstanceLock } from "../shared/lock"
import { canNotifyNative, DEFAULT_NOTIFY } from "../shared/notify"
import { Redactor } from "../shared/redact"
import { invalidParams, refused } from "../shared/rpc"
import { clearStaleSocket } from "../shared/socket-path"
import { ENGINE_IDS, ENGINE_LABELS, type Engine, type EngineId, isEngineId, newerMajor } from "../engine/engine"
import { buildEngines, selfCommand } from "../engine/registry"
import { recoverHomes } from "../engine/home"
import { EngineRunner, type RunnerDeps } from "../engine/runner"
import { BRIDGE_POLL_MS, BRIDGE_TOOL, bridgeFactsOf, landingBalance } from "./bridge"
import { canonicalToolName, DEFAULT_TOOLS, RUN_EXAMPLE, runOn, runWords, toolAllowed } from "../engine/tools"
import { harnessEnv } from "../engine/spawn"
import { isPreset, PRESET_LABELS, PRESETS } from "../engine/preset"
import { loadPersonSkills, skillsFor, skillTool } from "../engine/skills"
import { SkillFolders } from "./skill-folders"
import { SHIPPED, VERSION } from "../version"
import { BASE_ASSETS, baseAssetForMint, isBaseAsset, settlementAsset, spentSymbol } from "./assets"
import { AgentStatusBook, FALLBACK_FEE_BPS } from "./agent-status"
import { AwayDesk, awayRecords, FILLS_LIMIT as AWAY_FILLS_LIMIT, MINE_PAGE as AWAY_MINE_PAGE, type HoldingsSnapshot } from "./away"
import { HACC_HOST, type HaccAnswer, HaccClient } from "./hacc"
import { HaccChanges, replayNote } from "./hacc-changes"
import { HACC_TOOLS, haccDataLine, HaccTools, haccToolsFor } from "./hacc-tools"
import { PlanHeld } from "./plan-held"
import { PlanState } from "./plan-state"
import { isGap, SignalStream, type SignalFilter, type SignalRow, signalsTopicFilter } from "./signal-stream"
import { BUCKETS, type Bucket, type FeedChain, Feeds, type FeedsFilter, feedsTopicFilter } from "./feeds"
import { RESEARCH_PARTS, type ResearchFilter, type ResearchPart, ResearchReads, researchTopicFilter } from "./research-reads"
import { AgentWallets, defaultLineOf, payerContextFrom, pinKey, portfolioTee, resolvePayer, WALLETS_REFRESH_MS, walletsNote } from "./agent-wallets"
import { listsEveryTee, StoppedWallets, stoppedNote } from "./stopped-wallets"
import { type ChainBalance, PUBLIC_SOLANA_RPC, readChainBalance, readEvmBalance } from "./chain-balance"
import { CandleCli } from "./candle-cli"
import { CandleMcpPool, type ToolOutcome } from "./candle-mcp"
import { BUDGET_WAIT, CORE_TRADE_REQUESTS, KeyBudget, PLAN_LIMITS, requestsOf } from "./key-budget"
import { Usage } from "./usage"
import { ASK_CLIENT, OBSERVER_CLIENTS, READ_ONLY_CLIENTS } from "./client"
import { CliCards, UploadStage } from "./cli-cards"
import { CliTool } from "./cli-tool"
import { Destinations, fromVaultList, vaultKeysOn } from "./destinations"
import { EMPTY_REFRESH_MS, EmptyAccountsBook, PREVIEW_CALLS } from "./empty-accounts"
import { CliTrades } from "./cli-trade"
import { type Card, CardBook, type Holding, hashCard } from "./cards"
import { classify, type Mode, normaliseForMode, unclassifiedTools } from "./classify"
import { bridgeReadRequests, losesNextReply, type Operation, Operations } from "./execute"
import { Journal, type JournalRow } from "./journal"
import { Autonomy, AutonomyDesk, embeddedName, type PayWallet } from "./autonomy"
import { KillSwitch } from "./kill"
import { byWalletWithoutCard, DaySpend, KeyHolds, limitLines, Limits } from "./limits"
import { SymbolBook } from "./symbols"
import { DefaultPins } from "./default-pins"
import { Markets } from "./markets"
import { EngineModels, MODELS_EVERY_MS } from "./engine-models"
import { EngineState } from "./engine-state"
import { readSavedMode, saveAgent, saveMode, startingAgent, startingMode } from "./mode-state"
import { holdSupport } from "./hold"
import { researchRun, runTool } from "./research-run"
import { RESEARCH_TOOLS, researchCall } from "./research-tools"
import { HISTORY_TOOL, historyCall } from "./history-tool"
import { type JournalQuery, journalRows, type QueryDeps, queryJournal, queryProblem, rowsSince } from "./journal-query"
import { lastSessionEnd, parseWindow, PnlBook, type PnlWindow, readWindowState, SampleStore, saveWindowState, sinceStart } from "./pnl"
import { autonomyNote, LIMITS_TOOL, limitsRead } from "./limits-tool"
import { PNL_TOOL, pnlCall } from "./pnl-tool"
import { LONG_INDEX_CHARS, MemoryBook } from "./memory"
import { parseShown, readSavedShown, saveShown, shownGroup, shownWallets, unknownNames, type WalletsShown } from "./wallets-shown"
import { portfolioSymbol, portfolioView, viewName } from "./portfolio-view"
import { chainsInUse, decimalsIn, heldMints, holdingFrom } from "./portfolio-wallets"
import { tokenLabel } from "../shared/token-label"
import { buildNames, lookupWallet, pairsFile, planRenames, type RenameRow, short, walletName, type WalletKind, type WalletNameEntry } from "./wallet-names"
import { type GroupDef as GroupDefKept, type GroupOp, planGroupChange, resolveGroups, type WalletGroup } from "./wallet-groups"
import { WalletsFileStore } from "./wallets-file"
import { exposureUsd, walletStanding } from "./standing"
import { LatestPrices, PRICE_REFRESH_MS, PriceBook } from "./prices"
import { Pricing } from "./pricing"
import { readTrade } from "./reconcile"
import { VAULT_GONE, VaultMark } from "./vault-mark"
import { applyChange, changeFrom, freshState, keyFrom, OnboardingStore, onboardingProgress, signInFrom, stepBack, testedOn, withFinished, withTested, type OnboardingFacts, type OnboardingState, type OnboardingView } from "../setup/onboarding"
import { recordAgentLimits, recordAgentRun } from "../setup/key-add"
import { actingProfile, PRODUCTION_API, profilesFrom, recordProfile, setupProfile } from "../setup/candle-profile"
import { renewBefore } from "./plan-renew"
import { enginePathOf, HARNESS_SIGN_INS, harnessSignInArgv } from "../setup/harness-signin"
import { folderProblem, harnessProblem, readBuildPrefs, saveBuildPrefs } from "./build-prefs"
import { signInTurn } from "../setup/doctor"
import { type Captured, FACTOR_ARGV, NO_REPORT, NOT_OPENED, type PaneParams, type PaneReport, paneMapped, paneOutcome, type PaneResult, paneTitle, asSentence, STOPPED_FOR_GOOD, SWEPT_AND_RETIRED, vaultListCount } from "./pane-plan"
import { type Fill, freshTeeStep, freshTeeStepOf, hoodFundSteps, hoodNewKeyOf, hoodWalletStep, positionals, rebindLeft } from "./owner-rows"
import { rowFor, SOURCE, sourceFor } from "./cli-table"
import { readChainsKnown, saveChainsKnown } from "./chains-known"
import { type CallContext, CoreServer, WithSecret } from "./server"
import { type PaneGrant, PaneTickets } from "./tickets"
import { historyRequest, SAMPLE_MS, TokenWatch } from "./token-watch"
import { chainFilterParam, chainParam, mintParam, placeParam, signalsChoiceParam, tokenPaneParam, ViewState, type ViewsTopic } from "./view-state"
import { terminalText } from "../shared/terminal-text"
import { isPoppable, POPPABLE, TOKEN_PANES } from "../shared/panes"
import { TokenBook } from "./tokens"
import { TokenNames } from "./token-names"
import { AliasFile, LineReader } from "./line-reader"
import { TriggerBook } from "./triggers"
import { type Backtest, BOTS_TOOL, BOTS_TOOL_NAME, BotsTool, backtestFromJournal, botRecent, botSkips, readBotCard, runBotCard, strategyFrom } from "./bots-tool"
import { botBook, type BotBookView } from "./bot-books"
import { canonicalJson } from "../shared/canonical-json"
import type { Definition } from "../shared/definition"
import { exitWords } from "../shared/definition-words"
import { readTriggerCard, runTriggerCard, type TriggerCardParams, TRIGGERS_TOOL, TRIGGERS_TOOL_NAME, TriggersTool } from "./triggers-tool"
import { type BotEventSeen, type Clock, TriggerWatch } from "./trigger-watch"
import { CORE_HOWS } from "../shared/approved-how"
import { type FireEnd, fireEndSaid, TriggerFirer } from "./trigger-fire"
import { WAKES_PER_DAY, WAKES_PER_HOUR, Waker } from "./trigger-wake"
import { partsOfAction } from "../shared/trigger-grammar"
import { TriggersFileStore } from "./triggers-file"
import { BotBook, type BotsTopic, payChain, routeSlippageBps } from "./bots"
import { BotPositions } from "./bot-book"
import { type BotTold, CodeBotDesk } from "./bot-protocol"
import { HeldExits } from "./held-exits"
import { BotEvents } from "./bot-events"
import { BotReports } from "./bot-report"
import { BotEntries } from "./bot-entries"
import { BotExits, EXIT_WORDS, positionPrice } from "./bot-exits"
import type { FailedSells } from "./failed-sells"
import { PACE_TRADES, type RouteWaits, type TradePace } from "./breaker"
import { BotTrades } from "./bot-trades"
import { BotsFileStore, folderPlaceProblem } from "./bots-file"
import { CodeBotBook, type CodeBotProposal, type CodeHeldExitView, codeBotCard, controlEffect } from "./code-bots"
import { readLogTail, Supervisor, type SupervisorTuning } from "./supervisor"
import { type CaffeinateSpawn, KeepAwake } from "./keep-awake"
import { cardAnswer, type CardView, type FaceClient, GROUP_WALLETS_TOOL, modeFor, NAME_WALLETS_TOOL, offeredTools, SHOW_WALLETS_TOOL, ToolFace, VIEW_TOOL, withOwnPrefix, withReason, withScreenNotes } from "./tool-face"
import { CoreNotifier } from "./notifier"
import { ViewAsks } from "./view-asks"
import { clockNote, sessionNote, TradeLog } from "./trade-log"
import { addressKey, type ChainSlug, chainName, defaultEvmChain, enabledChains, EVM_ADDRESS_SOURCE, familyOfAddress, isAddressOn, isEvmAddress, LOOSE_SOLANA_ADDRESS_SOURCE, maybeChain, requestChain, sameAddress, storedChain } from "../shared/chains"

export const IDLE_EXIT_MS = 60_000
/**
 * A core with no agents yet (setup) has nothing to keep warm, so it goes as soon as its last view does: the
 * next start then takes the environment it was started in, such as a CANDLE_KEYRING_PASSPHRASE just set.
 */
export const IDLE_EXIT_NO_AGENTS_MS = 2_000
/** How often setup reads the agent's wallets while the person moves through its steps. */
export const SETUP_READ_EVERY_MS = 20_000
/** The same token picked again by the same view within this is the same pick, journalled once. */
export const REPICK_MS = 5_000
/** After a fill, the portfolio is read again at these delays, as the chain settles. */
export const AFTER_FILL_READS_MS = [2_000, 8_000, 20_000]

/** Schedules the portfolio reads that follow a fill; any other journal row schedules nothing. */
export function readAfterFill(row: { type: string }, schedule: (ms: number) => void): void {
  if (row.type === "operation.succeeded") for (const ms of AFTER_FILL_READS_MS) schedule(ms)
}

/**
 * The idle rule, apart so it can be tested on a clock: a headless core never exits on idle; a core a
 * view started exits once nothing has held it for `idleMs`.
 */
export class IdleWatch {
  private idleSince: number | undefined

  constructor(private readonly opts: { headless: boolean; idleMs: number }) {}

  /** True when the core should exit now. `idleMs` overrides the core's own for this tick (no agents yet). */
  tick(now: number, holds: boolean, idleMs = this.opts.idleMs): boolean {
    if (this.opts.headless || holds) {
      this.idleSince = undefined
      return false
    }
    this.idleSince ??= now
    return now - this.idleSince >= idleMs
  }
}

export interface CoreOptions {
  paths: Paths
  config: Config
  /** The environment the core was started with; children get allowlisted parts of it. */
  env: Record<string, string | undefined>
  headless: boolean
  now?: () => number
  idleExitMs?: number
  /** How often the idle rule is checked. */
  idleTickMs?: number
  /** Tests only: the triggers' watchers' clock (their heartbeat and every wait). */
  triggerClock?: Clock
  /** Tests only: how keep-awake starts caffeinate. */
  caffeinate?: CaffeinateSpawn
  /** How often each engine's models are read again (10 minutes). */
  modelsEveryMs?: number
  /** How long onboarding's test message may take. */
  testTurnMs?: number
  /** Called once, after the core has stopped, with why. */
  onStopped?: (reason: string) => void
  /** How to run this binary before its `mcp` subcommand; `selfCommand()` when unset. */
  shim?: string[]
  /**
   * Seams for tests: a stand-in engine, version check or process list. `engines` are registered over
   * this build's own, by id.
   */
  /** `engines` registers a test's over the built-in ones; `without` leaves built-in ones out, as a build without them. */
  engine?: Partial<Pick<RunnerDeps, "start" | "version" | "processes" | "leftoverDelayMs" | "onRaw">> & { engines?: Engine[]; without?: EngineId[] }
  /** Tests only: the fake Hacc's address. Hacc's host is fixed otherwise. */
  haccHost?: string
  /**
   * How the core sends a notification with no view open. Unset, it shows one where the machine can (a Mac, a Linux
   * desktop), never under `bun test`, so a contributor's test run on a Mac doesn't put the test cores' notices on screen.
   */
  notify?: { native?: boolean; spawn?: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>; quietMs?: number }
  /** Tests only: a stopped wallet's balance in place of the chain's (chain-balance.ts). */
  chainBalance?: (address: string, chain: ChainSlug) => Promise<ChainBalance>
  /**
   * The code bots' supervisor (supervisor.ts). Unset, it runs each approved code bot's command; `false` leaves it off,
   * for tests that connect a bot themselves; figures given replace its own, for tests.
   */
  supervise?: false | Partial<SupervisorTuning>
  /** How long a Build pane's paper test run lasts at most: 30 minutes, shorter in tests. */
  buildTestMs?: number
  /** How long after a promote finishes the key's wallets are read again when the new one isn't listed yet: 3 s. */
  promoteReadAgainMs?: number
}

export { selfCommand }

export interface RunningCore {
  server: CoreServer
  cards: CardBook
  operations: Operations
  pool: CandleMcpPool
  engine: EngineRunner
  journal: Journal
  wallets: AgentWallets
  /** Where funds may go. */
  destinations: Destinations
  /** Hacc, read with each agent's own key. */
  hacc: HaccClient
  plans: PlanState
  /** Hacc's signal tape: one socket per core. */
  signals: SignalStream
  /** Candle's P&L per agent, the Candle Harness's samples and the P&L window. */
  pnl: PnlBook
  /** Autonomy per wallet: the agent's narrowing card is proposed here (from harness_limits). */
  autonomy: AutonomyDesk
  /** Each TEE wallet's empty token accounts, from Candle's preview. */
  emptyAccounts: EmptyAccountsBook
  /** Reads a line as the input line would, with config.toml's aliases and the core's token names. */
  lines: LineReader
  /** Triggers: triggers.toml, their state, and the plan gate. */
  triggers: TriggerBook
  /** Rules bots: bots.toml, their state and approved versions, and the plan gate. */
  bots: BotBook
  /** Code bots: bots.toml's `kind = "code"` entries, their state and approved run settings, and their tokens. */
  codeBots: CodeBotBook
  /** The socket's tokens: a code bot's is issued through codeBots, a Build pane's minted here. */
  tokens: TokenBook
  /** Rules bots' entries, matched on Hacc's full tape. */
  botEntries: BotEntries
  /** Rules bots' exits, on Candle's market read after each heartbeat. */
  botExits: BotExits
  /** Failed sells of one token in a row, per key: the breaker's third. */
  failedSells: FailedSells
  /** Each key's trades in the last minute: the pace bots and triggers keep to, clear of Candle's breaker. */
  tradePace: TradePace
  /** The pairs Candle's route breaker refuses on a key now. */
  routeWaits: RouteWaits
  /** One heartbeat of the triggers' watcher and the bots' exits, now: for the tests. */
  watchBeat: () => Promise<void>
  /** The bots' own stream of Hacc's full tape. */
  botSignals: SignalStream
  account: string
  coreId: string
  /** Resolves when the MCP children have started (or failed to). */
  candleReady: Promise<void>
  stop(reason: string): Promise<void>
}

/** A stable local id for this state folder's account, so a journal from another state folder is refused. */
async function accountId(stateDir: string): Promise<string> {
  const path = join(stateDir, "account")
  let there = true
  try {
    const id = (await readFile(path, "utf8")).trim()
    if (/^acct_[A-Za-z0-9_-]{16,}$/.test(id)) return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    there = false
  }
  const id = `acct_${randomBytes(12).toString("base64url")}`
  if (!there) {
    await writeFile(path, `${id}\n`, { mode: 0o600, flag: "wx" })
    return id
  }
  // One left empty or garbled (a first start that died writing it) is replaced whole, or every start would stop here.
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  await writeFile(temp, `${id}\n`, { mode: 0o600, flag: "wx" })
  await rename(temp, path)
  return id
}

/** The agents' keys, from `keys/<agent>.key` (0600), written only by `candle-harness key add`. */
export function loadKeys(paths: Paths, config: Config): Map<string, string> {
  const keys = new Map<string, string>()
  for (const agent of Object.keys(config.agents)) {
    const file = paths.keyFile(agent)
    if (!existsSync(file)) continue
    const key = readFileSync(file, "utf8").trim()
    if (key.length > 0) keys.set(agent, key)
  }
  return keys
}

/** Candle's code for a key asked of an account whose embedded wallet isn't authorized for agents yet (Candle's docs, "Agent access & API keys"). */
export const AGENT_WALLET_NOT_DELEGATED = "AGENT_WALLET_NOT_DELEGATED"
const NOT_DELEGATED_WORDS = "Candle won't make a key yet: this account hasn't authorized its embedded wallet for agents. Setup says how."
/** How a `keys create` ends when Candle's browser confirm didn't approve it: no key was made either way. */
export const OWNER_CONFIRM_WORDS: Readonly<Record<string, string>> = {
  OWNER_CONFIRM_DENIED: "denied in your browser: nothing changed, and no key was made.",
  OWNER_CONFIRM_EXPIRED: "not approved in your browser before the code expired: nothing changed, and no key was made. Ask again, and approve it while the pane waits.",
  OWNER_CONFIRM_CANCELLED: "cancelled before it was approved: nothing changed, and no key was made.",
  OWNER_CONFIRM_REQUIRED: "Candle asks for this to be approved in your browser, and the CLI didn't wait for it: nothing changed, and no key was made. Run candle update, then ask again.",
}

export async function startCore(opts: CoreOptions): Promise<RunningCore> {
  const { paths, config } = opts
  const now = opts.now ?? Date.now
  const startedAt = now()
  /**
   * config.toml's modified time after the core's own last write or read of it (onboarding's profile, agent and limits):
   * each is in use at once, so a view reopened on this core warns only of an edit made since.
   */
  let configSeenMtime: number | undefined
  const sawConfig = () => {
    configSeenMtime = statSync(paths.configFile, { throwIfNoEntry: false })?.mtimeMs ?? configSeenMtime
  }
  await ensureStateDir(paths)
  for (const dir of [paths.keysDir, paths.turnsDir]) await mkdir(dir, { recursive: true, mode: 0o700 })

  const lock: InstanceLock = await acquireInstanceLock({ lockPath: paths.lock, socketPath: paths.socket })
  let journal: Journal | undefined
  try {
    await clearStaleSocket(paths.socket)
    const redactor = new Redactor()
    const keys = loadKeys(paths, config)
    // Whether this machine can hold the code runner (hold.ts): read once, since it's the kernel's or the system's.
    const runHold = await holdSupport()
    /** The programs the agent's code runner runs, when it's on and held here. */
    const runPrograms = (agent: string): readonly string[] | undefined => {
      const tools = config.agents[agent]?.tools
      return runHold.ok && runOn(tools?.run) && toolAllowed(tools, "research_run") ? tools.run : undefined
    }
    for (const key of keys.values()) redactor.add(key)
    // The RPC address often holds a paid key, in its path as often as its query: whole, it's never sent or written.
    redactor.add(config.candle.rpcUrl)
    redactor.add(config.candle.evmRpcUrl)
    // The CLI's keyring passphrase, passed to every candle run where there's no keychain: never written or shown.
    redactor.add(opts.env.CANDLE_KEYRING_PASSPHRASE)
    const account = await accountId(paths.stateDir)
    const coreId = randomBytes(9).toString("base64url")
    journal = await Journal.open({ path: paths.journal, redactor, account, now })
    const j = journal

    // The mode last picked survives a restart; config.toml's mode is where a fresh core starts.
    const starting = startingMode(paths.modeState, config.mode)
    let mode: Mode = starting.mode
    // Which wallets the panes show: the choice last made, else config.toml's.
    let walletsShown: WalletsShown = readSavedShown(paths.walletsShown) ?? config.wallets.show
    // Each agent's engine and model: the choice last made, else config.toml's default.
    const engineState = EngineState.open(paths.engineState, { engine: config.engine.default, ...(config.engine.model ? { model: config.engine.model } : {}) })
    // A private home a dead core left is handed back and removed before any turn runs.
    const recovered = recoverHomes(paths.homesDir)
    if (recovered.removed.length) await j.append({ type: "engine.homes_recovered", mode, removed: recovered.removed, handedBack: recovered.handedBack.length })
    // The agent last made active, else config.toml's.
    let activeAgent = startingAgent(paths.activeState, config.activeAgent, Object.keys(config.agents))
    // The kill switch, opened once the pieces it reaches exist; until then, paused.
    let kill: KillSwitch | undefined
    const paused = () => kill?.paused() ?? true

    const tokens = await TokenBook.open({ tokens: paths.tokens, viewToken: paths.viewToken }, now)
    // A replaced view token is refused, so only the live one needs redacting.
    tokens.onRotate((token, previous) => {
      if (previous !== undefined) redactor.remove(previous)
      redactor.add(token)
    })
    await tokens.publishViewToken()

    // Each key's request budget: every call through a key is counted, and background
    // reads go only while they fit in half its Candle limit, so they never cost a trade.
    // What the core has fetched since it started, for `core.usage` and the resource sampler.
    const usage = new Usage(now())
    const budget: KeyBudget = new KeyBudget({
      limitOf: (agent) => {
        const s = status.get(agent)
        return s?.rateLimitPerMin ?? (s?.tier !== undefined ? PLAN_LIMITS[s.tier] : undefined)
      },
      agents: () => [...keys.keys()].filter((a) => pool.agents().includes(a) && pool.for(a).status().state === "ready"),
      preferred: () => anyAgent(),
      now,
      onChange: () => publishStatus?.(),
      coreReserve: (agent) => coreReserveOf?.(agent) ?? 0,
    })
    /** Set once the bots and the pace exist: the calls a key keeps free for its bots' trades still to come. */
    let coreReserveOf: ((agent: string) => number) | undefined
    const route = config.candle.mcp.route
    const pool = new CandleMcpPool({
      route,
      path: route === "cli" ? config.candle.cliPath : config.candle.mcp.path,
      stateDir: paths.stateDir,
      parentEnv: opts.env,
      agents: [...keys].map(([name, apiKey]) => ({ name, apiKey })),
      child: {
        meter: {
          noteCall: (agent, n) => {
            budget.noteCall(agent, n)
            usage.candleCall(agent, n)
          },
          noteOutcome: (agent, outcome) => budget.noteOutcome(agent, outcome),
        },
        onAnswer: (agent, bytes) => usage.candleBytes(agent, bytes),
      },
    })
    const status = new AgentStatusBook({ pool, now })
    // Hacc: each agent reads with its own key; agents on one account (its embedded wallet) share
    // the client's short cache. The account's plan decides which Hacc tools are offered.
    const hacc = new HaccClient({ keyFor: (agent) => keys.get(agent), accountOf: (agent) => status.get(agent)?.wallets.solana, now, onRead: (bytes) => usage.haccRead(bytes), ...(opts.haccHost ? { host: opts.haccHost } : {}) })
    // A plan change reaches Hacc's topic and the triggers, which need Pro or Max.
    let onPlanChange: (() => void) | undefined
    const plans = new PlanState({
      status,
      agents: () => [...keys.keys()],
      now,
      onChange: () => {
        publishHacc?.()
        onPlanChange?.()
      },
    })
    let publishHacc: (() => void) | undefined
    // Views Hacc refused for the plan though Candle's table says it reaches them: held until it changes.
    const planHeld = new PlanHeld(() => publishHacc?.())
    // Hacc's reads as agent tools: the tape from the stream's cache when it's fresh. A plan
    // refusal reads the plan again, so the next turn's offer follows a change.
    const haccTools = new HaccTools({
      hacc,
      plan: (agent) => plans.planFor(agent).plan,
      onPlanRefused: (agent) => void status.refresh(agent).then(() => plans.noticeChanges(), () => {}),
      held: planHeld,
      signals: { recent: (filter, limit) => signals.recent(filter, limit), view: () => signals.view(), touch: () => signals.touch() },
      // Hacc's changes, made once the card book exists below.
      changes: { call: (client, tool, view, args) => haccChanges.call(client, tool, view, args) },
    })
    // Whether an agent is offered Hacc's tools at all: Hacc on, a key, and a key Hacc hasn't refused.
    const haccOffered = (agent: string) => config.hacc.enabled && keys.has(agent) && !hacc.keyRefused(agent)
    const haccOffer = (agent: string) => {
      const plan = plans.planFor(agent).plan
      return haccToolsFor(plan, (k) => planHeld.isHeld(k, plan))
    }
    const anyAgent = () => (keys.has(activeAgent) ? activeAgent : [...keys.keys()][0])
    // Set once the server exists; the status and portfolio topics are published through it.
    let publishStatus: (() => void) | undefined
    // What holds the core up now, in words: set with the idle rule.
    let holdWords: () => string[] = () => []
    let publishPortfolio: (() => void) | undefined
    // The Away summary waits for the portfolio read a view's attach makes; set once it exists.
    let awayPortfolioRead: (() => void) | undefined
    // TEE wallets Candle stops listing: noted on each good portfolio read, once the store exists.
    let noteTeeListed: (() => void) | undefined
    // Candle's children started (or failed to): the Away summary's reads wait for it.
    let candleUp: () => void = () => {}
    const candleStarted = new Promise<void>((resolve) => (candleUp = resolve))
    const prices = new PriceBook({
      read: async (): Promise<ToolOutcome> => {
        const active = anyAgent()
        if (!active) return { kind: "error", code: "NO_AGENT", retryable: false, body: {} }
        const agent = budget.take("prices", active, requestsOf("candle_get_portfolio"))
        return agent ? pool.for(agent).call("candle_get_portfolio", {}) : BUDGET_WAIT
      },
      now,
      stretch: () => budget.stretch("prices"),
      onRead: () => {
        publishStatus?.()
        publishPortfolio?.()
        nameHoldings()
        awayPortfolioRead?.()
        noteTeeListed?.()
      },
    })
    budget.want("prices", { perMin: () => prices.demandPerMin(), naturalMs: PRICE_REFRESH_MS, key: () => anyAgent() })
    // A held token with no name anywhere gets one market read, once, so Positions and the input line
    // know it by name on a fresh core (else `sell 100% ORE` isn't a trade until ORE is read).
    const named = new Set<string>()
    const nameHoldings = () => nameMints(heldMints(prices.lastPortfolio()?.result))
    // P&L's books and fills too (else a round another agent opened reads as a cut-short mint): Candle's P&L names no token.
    const nameMints = (mints: Iterable<string>) => {
      const agent = anyAgent()
      if (!agent) return
      for (const mint of mints) {
        if (named.has(mint) || symbolOf(mint)) continue
        named.add(mint)
        void markets
          .resolve(agent, mint)
          .then((r) => r.ok && r.market.symbol && publishPortfolio?.())
          .catch(() => {})
      }
    }
    // What the panes value holdings at: the newest of the portfolio's price and any market read's.
    const latest = new LatestPrices(prices)
    // Triggers' watchers, made once Hacc's stream exists below: every market read reaches their levels too.
    let triggerWatch: TriggerWatch | undefined
    // Triggers' firing path, made once the cards, the tools and the kill switch exist below.
    let triggerFirer: TriggerFirer | undefined
    // Rules bots' entries, made once the trade path and the bots' own stream exist below.
    let botEntries: BotEntries | undefined
    // Rules bots' exits, made with the entries; the watcher reads their positions' tokens and checks them each heartbeat.
    let botExits: BotExits | undefined
    let codeBotDesk: CodeBotDesk | undefined
    /** The exits the core holds on code bots' positions: built once the journal's bot rows are read. */
    let heldExitsRef: HeldExits | undefined
    let codeBotDeskTell: (name: string, told: BotTold) => void = () => {}
    // What each code bot last said about itself, beside the core's count (bot-report.ts). The Bots topic it shows on is
    // sent at most once a second for reports, so a bot reporting in a loop can't flood the views.
    const botReports = new BotReports(now)
    let reportPublish: ReturnType<typeof setTimeout> | undefined
    const noted = (tool: string, outcome: ToolOutcome): ToolOutcome => {
      if (tool === "candle_get_market") {
        latest.noteMarket(outcome, now())
        triggerWatch?.noteMarket(outcome)
      }
      return outcome
    }
    const spend = new DaySpend()
    spend.rebuild(j.spendRows())
    // Each wallet's spend today without a card, and keys Candle refused for its cap.
    const walletSpend = new DaySpend(byWalletWithoutCard)
    walletSpend.rebuild(j.spendRows())
    const keyHolds = new KeyHolds({ window: (agent) => status.get(agent)?.keyLimit })
    keyHolds.rebuild(j.spendRows())
    // Each wallet's autonomy, read by the card book for trades with no card.
    const autonomy = new Autonomy(paths.autonomyState)
    // What each wallet is called: one book, built below from where each name is kept.
    let nameBook: () => WalletNameEntry[] = () => []
    // The wallet groups, read against the book: they organise only, and never pay.
    let groupBook: () => WalletGroup[] = () => []
    // Which wallets each agent's key may pay from: read in the background, never on approve.
    // Each TEE wallet's empty token accounts, made once the CLI runner exists below.
    let emptyBook: EmptyAccountsBook | undefined
    const defaultPins = new DefaultPins(paths.defaultPins)
    let destinationsBook: Destinations | undefined
    const wallets = new AgentWallets({
      pool,
      status,
      agents: () => [...keys.keys()].filter((a) => pool.agents().includes(a)),
      keyPrefix: (agent) => apiKeyPrefix(keys.get(agent) ?? ""),
      portfolio: () => prices.lastPortfolio()?.result,
      readPortfolio: () => prices.refresh(),
      teeStatus: async (agent, address) => {
        const run = await candleCli.runExact({ agent, argv: candleCli.finalArgs({ args: ["tee", "status", address], json: true, withRpcUrl: true }), json: true })
        const body = run.json as { code?: unknown; server?: { boundKeyPrefix?: unknown } } | undefined
        if (run.exitCode === 0 && body?.server) return body.server.boundKeyPrefix === apiKeyPrefix(keys.get(agent) ?? "") ? "bound" : "not_on_key"
        return run.exitCode === 1 && body?.code === "TEE_WALLET_NOT_ON_KEY" ? "not_on_key" : "unreadable"
      },
      defaultWallet: (agent, chain) => defaultLineOf(config.agents[agent], chain),
      pins: defaultPins,
      now,
      names: () => nameBook(),
      groups: () => groupBook(),
      // Candle's own wallets read, once made: an imported wallet bound to a key isn't one the Candle Harness pays from.
      imported: (address) => {
        if (destinationsBook?.all().some((d) => d.address === address && d.kind === "tee")) return false
        const row = destinationsBook?.names().linked.find((l) => l.address === address)
        return row ? !row.tee : undefined
      },
      onChange: () => {
        publishStatus?.()
        publishPortfolio?.()
        emptyBook?.walletsChanged()
      },
    })
    // A default config.toml still names by a wallet's old name pays from it all the same (default-pins.ts):
    // said once, when the rename lands, with the line to change. config.toml is the person's, never written.
    const staleDefaults = (renamed: readonly { address: string; name: string }[]): string | undefined => {
      const lines: string[] = []
      for (const [agent, a] of Object.entries(config.agents)) {
        // Each line once: the one wallet line, or each chain's.
        const seen = new Set<string>()
        for (const { slug } of enabledChains()) {
          const line = defaultLineOf(a, slug)
          if (line?.word === undefined || seen.has(line.setting)) continue
          seen.add(line.setting)
          const row = renamed.find((r) => sameAddress(r.address, defaultPins.get(pinKey(agent, line, slug), line.word)))
          if (!row || row.name.toLowerCase() === line.word.toLowerCase()) continue
          lines.push(`${agent}'s default in config.toml (${line.setting} = "${terminalText(line.word, { maxLength: 64 })}") still pays from it, by its address: change the line to "${terminalText(row.name, { maxLength: 64 })}" when you like.`)
        }
      }
      return lines.length ? lines.join(" ") : undefined
    }
    // Where funds may go: the portfolio's wallets, the owner's `candle wallets` read
    // (trusted wallets, pinned vaults), made when a funds-out card is proposed and the last is over 5
    // minutes old, and the vault keys from the last `vault list` the user ran in the pane. Never read on
    // approve.
    const destinations = new Destinations({
      file: paths.destinations,
      portfolio: () => portfolioNow().wallets.map((w) => ({ address: w.address, ...(w.label ? { label: w.label } : {}), kind: w.kind })),
    })
    await destinations.load()
    destinationsBook = destinations
    // TEE wallets stopped in the pane (a stop is final): Candle drops them from every list, so the core keeps them until they're swept.
    const stoppedWallets = new StoppedWallets({ file: paths.stoppedWallets })
    await stoppedWallets.load()
    // The chains the account uses: one answer for Candle's lists, the approvals menu and every view (sent with the
    // portfolio). A read that can't say keeps what the last one said, so a known chain doesn't flicker off with Candle's health.
    // The last core's answer to start from, so a restart doesn't show one chain until the first read.
    let chainsKnown: readonly ChainSlug[] = readChainsKnown(paths.chainsUsed)
    const chainsUsed = (): ChainSlug[] => {
      const used = chainsInUse(prices.lastPortfolio()?.result, { stopped: stoppedWallets.all(), was: chainsKnown })
      if (used.join(",") !== chainsKnown.join(",")) void saveChainsKnown(paths.chainsUsed, used, now()).catch(() => {})
      chainsKnown = used
      return used
    }
    // A stopped wallet's balance, read on chain over the CLI's RPC, since no Candle read lists it any more:
    // after a portfolio read, at most every 5 minutes, only while there's a stopped wallet.
    const stoppedBalances = new Map<string, ChainBalance>()
    let balancesReadAt = 0
    let balancesFor = ""
    let listedReadAt: number | undefined
    const rpcForReads = () => config.candle.rpcUrl ?? actingProfile(opts.env, candleProfile).rpcUrl ?? PUBLIC_SOLANA_RPC
    const readStoppedBalances = async () => {
      const due = stoppedWallets.all()
      const which = due.map((w) => w.address).join(",")
      // A wallet newly stopped is read at once; the same ones, every 5 minutes.
      if (due.length === 0 || (which === balancesFor && now() - balancesReadAt < 5 * 60_000)) return
      balancesReadAt = now()
      balancesFor = which
      // Each over its own chain's RPC: a Hood wallet is never sent to the Solana RPC. A stopped wallet is kept from before
      // rows carried a chain, so its address's family says which.
      for (const w of due) {
        const chain = maybeChain(storedChain(undefined, w.address))
        const read =
          (chain ? opts.chainBalance?.(w.address, chain.slug) : undefined) ??
          (chain?.family === "evm"
            ? chain.publicRpcUrl || config.candle.evmRpcUrl
              ? readEvmBalance({ url: config.candle.evmRpcUrl ?? chain.publicRpcUrl!, address: w.address, now: now() })
              : Promise.resolve({ error: `no RPC for ${chain.name} is set`, readAt: now() })
            : readChainBalance({ url: rpcForReads(), address: w.address, now: now() }))
        stoppedBalances.set(w.address, await read)
      }
      publishPortfolio?.()
    }
    noteTeeListed = () => {
      const read = prices.lastPortfolio()
      if (!read || read.readAt === listedReadAt) return
      listedReadAt = read.readAt
      const body = read.result as { tee?: unknown; embedded?: unknown } | undefined
      // Only a read that lists TEE wallets at all, with a wallet list that wasn't cut off, says which are missing.
      if (!listsEveryTee(body)) return
      const embedded = Array.isArray(body?.embedded) ? (body.embedded as { address?: unknown }[]).find((e) => typeof e?.address === "string")?.address : undefined
      // Solana's and Hood's TEE wallets are one list on Candle's side (the account's linked wallets), so walletsComplete covers both.
      const listed = portfolioTee(body).map((t) => ({ address: t.address, ...(t.label ? { label: t.label } : {}), ...(wallets.boundTo(t.address) ? { agent: wallets.boundTo(t.address)! } : {}) }))
      void stoppedWallets
        .listed(listed, now(), typeof embedded === "string" ? embedded : undefined)
        .then(() => readStoppedBalances())
        .catch(() => {})
    }
    let destinationsReadAt: number | undefined
    const knownDestinations = async () => {
      if (destinationsReadAt === undefined || now() - destinationsReadAt >= WALLETS_REFRESH_MS) {
        const run = await candleCli.runExact({ argv: candleCli.finalArgs({ args: ["wallets"], json: true, withRpcUrl: false }), json: true }).catch(() => undefined)
        // A failed read keeps the last answer, and is tried again next time.
        if (run?.exitCode === 0 && run.json !== undefined) {
          destinations.readWallets(run.json)
          destinationsReadAt = now()
        }
      }
      return destinations.all()
    }
    // The book, one name per wallet kept where it's owned: Candle's labels for TEE and linked wallets (the portfolio, the owner's
    // `candle wallets` read, and the stopped wallets the core keeps), the vault's for vault keys (the last
    // `vault list`), and the Candle Harness's own in wallets.toml for the rest. Built when asked: it's a few dozen rows.
    const walletsFile = new WalletsFileStore(paths.walletsFile)
    nameBook = () => {
      const kept = destinations.names()
      const portfolio = prices.lastPortfolio()?.result as { embedded?: unknown } | undefined
      const embedded = new Set<string>(kept.embedded)
      for (const agent of keys.keys()) for (const a of [status.get(agent)?.wallets.solana, status.get(agent)?.wallets.evm]) if (a) embedded.add(a)
      for (const e of Array.isArray(portfolio?.embedded) ? portfolio.embedded : []) if (typeof (e as { address?: unknown })?.address === "string") embedded.add((e as { address: string }).address)
      const tee = [
        ...portfolioTee(portfolio).map((t) => ({ address: t.address, ...(t.label ? { label: t.label } : {}) })),
        ...stoppedWallets.all(),
        ...stoppedWallets.retired(),
        ...kept.linked.filter((l) => l.tee),
      ]
      return buildNames({ embedded: [...embedded], tee, linked: kept.linked.filter((l) => !l.tee), vaultKeys: kept.vaultKeys, other: kept.pinned, harness: walletsFile.read().names, agents: Object.keys(config.agents) })
    }
    groupBook = () => resolveGroups(walletsFile.read().groups, nameBook(), Object.keys(config.agents))
    const nameOf = (address: string, kind: WalletKind = "tee", label?: string): string => walletName(nameBook(), { address, kind, ...(label ? { label } : {}) })
    const refreshWallets = (opts: { readSince?: number } = {}) => {
      void wallets.refreshAll(opts).catch(() => {})
      // Imported and linked wallets' names are Candle's labels: the owner's wallets read, at most every 5 minutes.
      void knownDestinations().catch(() => {})
    }
    let walletsTimer: ReturnType<typeof setInterval> | undefined

    let server: CoreServer | undefined
    // A line the core reads (a trigger's) resolves its token names by what the core has shown its views.
    const tokenNames = new TokenNames()
    // The names the person has met as their own: on a card, or held in a wallet. A card for another token by one of
    // these names says so. Candle's lists aren't counted: copies of a ticker pass through them all day.
    const metNames = new TokenNames()
    const lines = new LineReader({
      aliases: new AliasFile(paths.configFile),
      names: tokenNames,
      agents: () => Object.keys(config.agents),
      wallets: () => walletsTopic(),
      mode: () => mode,
    })
    /** The wallet a trade pays from: the one it names, else the agent's default; undefined before it's read or when it can't pay. */
    const payWalletOf = (agent: string, wallet: string | undefined, mint: string | undefined) => {
      const ctx = payerContextFrom(walletsTopic(), agent, mint ? requestChain(mint) : undefined)
      const r = ctx ? resolvePayer(ctx, wallet) : undefined
      if (!r?.ok) return undefined
      return { address: r.address, name: r.kind === "embedded" ? "embedded" : nameOf(r.address, "tee", r.label), ...(ctx ? { chain: ctx.chain } : {}), setting: autonomy.get(r.address) }
    }
    /**
     * A bot's wallet as the payer resolves it on `chain`: a rules bot's definition's. With no chain (a rules bot on
     * both, or a code bot, which trades any token), on each chain that's on in turn, Solana first, until one pays: a
     * Hood wallet's on Hood, the embedded wallet's on Solana. When none pays, Solana's refusal.
     */
    const botPayer = (agent: string, wallet: string, chain: ChainSlug | undefined) => {
      let refusal: ReturnType<typeof resolvePayer> | undefined
      for (const c of chain ? [chain] : enabledChains().map((e) => e.slug)) {
        const ctx = payerContextFrom(walletsTopic(), agent, c)
        const r = ctx ? resolvePayer(ctx, wallet) : undefined
        if (r?.ok) return { ...r, chain: c }
        refusal ??= r
      }
      return refusal
    }
    const botPayWallet = (agent: string, wallet: string, chain?: ChainSlug) => {
      const r = botPayer(agent, wallet, chain)
      if (!r?.ok) return undefined
      // The words name the embedded wallet on its chain; the bot's setting keeps "embedded", as it's stored.
      return { address: r.address, name: r.kind === "embedded" ? "embedded" : nameOf(r.address, "tee", r.label), chain: r.chain, setting: autonomy.get(r.address) }
    }
    const botPayRefusal = (agent: string, wallet: string, chain?: ChainSlug) => {
      const r = botPayer(agent, wallet, chain)
      return r && !r.ok ? r.message : undefined
    }
    // Keep-awake: caffeinate while a trigger or bot is on, on macOS, when the person has it on.
    const keepAwake = new KeepAwake({
      file: join(paths.stateDir, "keep-awake.json"),
      initial: config.core?.keepAwake ?? false,
      platform: process.platform,
      pid: process.pid,
      now,
      ...(opts.caffeinate ? { spawn: opts.caffeinate } : {}),
      onChange: () => publishStatus?.(),
    })
    // Triggers, read by the core's own line reader: their file, their state, and the plan gate.
    // The code bots' names, once their book is made below: a trigger on a bot may name one.
    let codeBotNames: () => string[] = () => []
    const triggers = new TriggerBook({
      file: new TriggersFileStore(paths.triggersFile),
      statePath: paths.triggersState,
      journal: j,
      lines,
      agents: () => Object.keys(config.agents).filter((a) => keys.has(a)),
      plan: (agent) => plans.planFor(agent).plan,
      mode: () => mode,
      pnlWindow: () => pnlWindow,
      now,
      payWallet: (agent, wallet, mint) => payWalletOf(agent, wallet, mint),
      feeBps: (agent) => status.get(agent)?.feeBps ?? FALLBACK_FEE_BPS,
      botNames: () => bots.entries().map((b) => b.name),
      codeBotNames: () => codeBotNames(),
      onChange: () => {
        triggerWatch?.refresh()
        void publish("triggers", triggers.view())
        // How many keep the core up: the status bar's "3 triggers on", and keep-awake.
        keepAwake.update(keptUp())
        publishStatus?.()
      },
    })
    // The rules for a bot's trades, every kind, in one place (bot-trades.ts): Candle's breaker kept clear of by bots and
    // triggers (failed sells of a token in a row per key, anyone's; each key's trades in the last minute; the pairs
    // Candle's route breaker refuses, from the journal's window), Candle's stop pausing a key's bots, and the send.
    const botTrades = new BotTrades({
      rows: j.rows(),
      now,
      pauseKeyBots: async (agent) => [...(await bots.pauseByCandle(agent)), ...(await codeBots.pauseByCandle(agent))],
      face: () => face,
      cards: () => cards,
    })
    const { failedSells, pace: tradePace, routes: routeWaits } = botTrades
    j.onAppend((row) => botTrades.note(row))
    // Each rules bot's own positions, from its own fills in the journal.
    const botPositions = new BotPositions({
      rows: j.botRows(),
      statePath: paths.botPeaks,
      // The exits' clock: a read-back buy's mark counts only near when the buy was sent.
      now: () => (opts.triggerClock ?? { now }).now(),
      // A position opening or closing changes whether a paused bot keeps the core up.
      onChange: () => {
        keepAwake.update(keptUp())
        publishStatus?.()
      },
    })
    j.onAppend((row) => botPositions.note(row))
    // Rules bots: their file, their state, and the same plan gate as triggers.
    const bots = new BotBook({
      file: new BotsFileStore(paths.botsFile),
      statePath: paths.botsState,
      journal: j,
      agents: () => Object.keys(config.agents).filter((a) => keys.has(a)),
      plan: (agent) => plans.planFor(agent).plan,
      mode: () => mode,
      now,
      payWallet: botPayWallet,
      payRefusal: botPayRefusal,
      openPositions: (name) => botPositions.open(name).length,
      onChange: () => {
        botEntries?.refresh()
        void publish("bots", botsTopic())
        keepAwake.update(keptUp())
        publishStatus?.()
      },
    })
    // Code bots: programs of the person's own, in the same bots.toml, held to the figures their card approved. They
    // connect with a bot token, never a key; the token book keeps theirs across restarts.
    /** Runs each approved code bot's command and keeps it running: started once the socket listens. */
    let supervisor: Supervisor | undefined
    // Where a code bot's folder or the bots folder may never be: /, the home or above it, and the
    // Candle Harness's own folders (the research agents' folders are inside config), by real path.
    const folderPlace = (folder: string) => folderPlaceProblem(folder, { home: opts.env.HOME ?? homedir(), own: [paths.configDir, paths.stateDir, paths.keysDir] })
    /** The bots folder as typed (~/ is the home), as the Build pane opens it (build/folder.ts botsFolderPath). */
    const typedFolder = (typed: string) => {
      const t = typed.trim()
      const home = opts.env.HOME ?? homedir()
      return t === "~" ? home : t.startsWith("~/") ? join(home, t.slice(2)) : resolve(t)
    }
    const codeBots = new CodeBotBook({
      folderPlace,
      ...(opts.buildTestMs !== undefined ? { testMs: opts.buildTestMs } : {}),
      file: bots.file,
      statePath: paths.codeBotsState,
      journal: j,
      agents: () => Object.keys(config.agents).filter((a) => keys.has(a)),
      plan: (agent) => plans.planFor(agent).plan,
      mode: () => mode,
      now,
      payWallet: botPayWallet,
      payRefusal: botPayRefusal,
      tokens,
      disconnect: (tokenId) => server?.disconnectToken(tokenId),
      connected: (name) => server?.clients().some((c) => c.role === "bot" && c.bot === name) ?? false,
      runsOutside: (name) => supervisor?.view(name).runs === "outside",
      processIdle: (name) => ["ended", "down", "gave_up"].includes(supervisor?.view(name).state ?? ""),
      openPositions: (name) => botPositions.open(name).length,
      letGo: async (name) => (codeBotDesk ? codeBotDesk.letGo(name) : []),
      onChange: () => {
        // Each connected code bot is told its state when it changed.
        for (const b of codeBots.entries()) codeBotDesk?.stateChanged(b.name)
        // A bot removed takes what it said with it.
        botReports.forgetExcept(new Set(codeBots.entries().map((b) => b.name)))
        // Its process follows: started, kept, or ended as it may run now.
        void supervisor?.reconcile().catch(() => {})
        void publish("bots", botsTopic())
        keepAwake.update(keptUp())
        publishStatus?.()
      },
    })
    codeBotNames = () => codeBots.entries().map((b) => b.name)
    // A token whose bot is no longer saved (removed while the file couldn't be written, or by hand) goes at start.
    await tokens.pruneBots(new Set(codeBots.known())).catch(() => [])
    /** A code bot's or a paper test's book from its own fills, once the core can price them: set with the rules bots' books below. */
    let codeBook: ((name: string, mode: "paper" | "live") => BotBookView) | undefined
    /** The `bots` topic: each bot, and once the core can price them, each bot's book. */
    const withCode = (v: BotsTopic): BotsTopic => {
      const code = codeBots.views().map((c) => {
        const says = botReports.view(c.name)
        const held = heldExitsView(c.name)
        const proc = supervisor?.view(c.name)
        const run = codeBots.approvedVersion(c.name)?.run
        const controls = says && run
          ? says.controls.map((x) => {
              const e = controlEffect(run, x, routeSlippageBps(run.wallet))
              return { id: x.id, label: x.label, how: e.how, words: e.words }
            })
          : []
        const used = codeBotDesk?.usedToday(c.name)
        return { ...c, ...(used !== undefined ? { usedTodayUsd: used } : {}), ...(says ? { says } : {}), ...(controls.length ? { controls } : {}), ...(held.length ? { heldExits: held } : {}), ...(proc ? { process: proc } : {}) }
      })
      const gate = v.gate ?? codeBots.gateView()
      const codeBooks = codeBook ? Object.fromEntries(code.map((c) => [c.name, codeBook!(c.name, c.mode)])) : {}
      // A paper test: what it says, and the core's count from its paper fills, for the Build tab's test box.
      const tests = codeBots.testViews().map((t) => {
        const says = botReports.view(t.name)
        return { ...t, ...(says ? { says } : {}) }
      })
      const testBooks = codeBook ? Object.fromEntries(tests.map((t) => [t.name, codeBook!(t.name, "paper")])) : {}
      const books = Object.keys(testBooks).length || Object.keys(codeBooks).length ? { ...(v.books ?? {}), ...codeBooks, ...testBooks } : v.books
      const testsEnded = codeBots.endedTests()
      // A code bot's card waiting for the person, by its folder: the Build tab says its card waits, not "not proposed yet".
      const codeCards = cards
        .list()
        .filter((c) => c.state === "awaiting_approval" && c.tool === BOTS_TOOL_NAME && c.params.action === "saveCode")
        .flatMap((c) => {
          const proposal = c.params.proposal as { name?: unknown; run?: { folder?: unknown } } | undefined
          return typeof proposal?.name === "string" && typeof proposal.run?.folder === "string" ? [{ name: proposal.name, folder: proposal.run.folder, cardId: c.cardId, change: c.params.replace === true }] : []
        })
      return { ...v, ...(gate ? { gate } : {}), ...(code.length ? { code } : {}), ...(tests.length ? { tests } : {}), ...(testsEnded.length ? { testsEnded } : {}), ...(codeCards.length ? { codeCards } : {}), ...(books ? { books } : {}) }
    }
    /** A code bot's open positions the core holds exits on, in words, with why a sell of one waits. */
    const heldExitsView = (name: string): CodeHeldExitView[] => {
      const held = heldExitsRef
      if (!held) return []
      const waits = new Map((botExits?.heldSells(name) ?? []).map((h) => [h.mint, h.words]))
      return botPositions.open(name).flatMap((p) => {
        const h = held.of(p.id)
        if (!h) return []
        const symbol = symbolOf(p.mint)
        return [{ position: p.id, mint: p.mint, ...(symbol ? { symbol } : {}), words: exitWords(h.exit), by: h.by, ...(botExits?.selling(p.id) ? { selling: true as const } : {}), ...(waits.has(p.mint) ? { waits: waits.get(p.mint)! } : {}) }]
      })
    }
    let botsTopic: () => BotsTopic = () => withCode(bots.view())
    /** Whether a trigger or a bot keeps the core up: it outlives its views, and keep-awake follows it. */
    const botsUp = () => [...bots.keepingUp(), ...codeBots.keepingUp()]
    const keptUp = () => triggers.keepingUp().length > 0 || botsUp().length > 0
    onPlanChange = () => {
      void triggers.planChanged().catch(() => {})
      void bots.planChanged().catch(() => {})
      void codeBots.planChanged().catch(() => {})
    }
    /** The live triggers the kill switch's pause holds: each that buys, swaps or wakes. One that only sells or notifies runs on. */
    const triggersHeldByPause = () =>
      triggers.live().flatMap((t) => {
        const r = triggers.resolved(t)
        if (!r) return []
        if (r.action.kind === "wake") return [{ name: t.name, agent: t.agent, words: `wakes ${r.action.agent}: held, no wake until you resume` }]
        if (r.action.kind !== "command") return []
        const parts = partsOfAction(r.action.command)
        const spends = parts.filter((p) => p.tool === "candle_swap" || p.args.side === "buy").length
        if (!spends) return []
        return [{ name: t.name, agent: t.agent, words: spends === parts.length ? "its buys and swaps are held until you resume" : "its buys and swaps are held until you resume; its sells still go" }]
      })
    const publish = (topic: string, data: unknown, owner?: string) => {
      tokenNames.learnFrom(topic, data)
      if (topic === "cards" || topic === "portfolio") metNames.learnFrom(topic, data)
      return server?.events.publish(topic, data, owner)
    }
    const cardOwner = new Map<string, string>()

    // The prompt pane. Approving a pane card mints a ticket for the
    // approving view, which starts the launcher with it; the launcher's report settles the operation.
    // Nothing a pane runs is ever re-run by the core.
    const panes = new Map<string, { opId: string; cardId: string; pane: PaneParams["pane"]; approvedAt: number; holders?: string[]; teeBefore?: string[]; redeemed?: true }>()
    const settlePane = async (ticketId: string, reported: PaneResult, captured?: Captured): Promise<void> => {
      let result = reported
      const open = panes.get(ticketId)
      if (!open || operations.get(open.opId)?.state !== "pending") return
      // `vault list`'s addresses and labels: the vault keys become known destinations.
      if (open.pane.row === "vault list" && result.outcome === "finished" && captured?.addresses) {
        const list = fromVaultList({ entries: captured.addresses })
        await destinations.setVaultList(list).catch(() => {})
        const count = vaultListCount(list.filter((d) => d.kind === "vault-key").length, list.filter((d) => d.kind === "tee").length)
        // The chips that fill in a vault key follow what it now knows.
        publishPortfolio?.()
        result = { ...result, words: `finished in the pane: the Candle Harness now knows ${count} as places funds may go.` }
      }
      // What the step touched is read before the outcome is told, so the outcome says what's true now.
      const endedAt = now()
      const told = await afterOwner(open, result, captured).catch(() => result)
      await operations.settlePane(open.opId, paneMapped(told, { fundsOut: open.pane.rule === "funds-out" }))
      if (told.outcome === "usage") await j.append({ type: "pane.usage", mode, ...(open.pane.agent ? { agent: open.pane.agent } : {}), opId: open.opId, row: open.pane.row, note: "The CLI refused the Candle Harness's command line: the command table is wrong for this CLI." })
      afterPane(open.pane, told, endedAt)
    }

    // Owner rows. The core reads what a step changed and says what's next, as chips
    // that put the command on the input line: it never runs a key change itself.
    const prefixOf = (agent: string) => apiKeyPrefix(keys.get(agent) ?? "")
    const agentPrefixes = () => new Map([...keys.keys()].flatMap((a) => (prefixOf(a) ? [[a, prefixOf(a)!] as [string, string]] : [])))
    const ownerWords = (pane: PaneParams["pane"]) => {
      const argv = pane.steps.at(-1)!.argv
      const at = argv.indexOf("--rpc-url")
      return argv.filter((a, i) => a !== "--json" && a !== "--yes" && (at < 0 || (i !== at && i !== at + 1)))
    }
    /** The vault key a fresh TEE wallet is promoted from and funded by: filled in only when the Candle Harness knows just one. */
    // Every wallet name the Candle Harness knows, so a fresh TEE wallet's label is one no wallet holds.
    const takenNames = (): { taken: string[] } => ({ taken: nameBook().flatMap((e) => (e.name !== undefined ? [e.name] : [])) })
    // The Solana TEE chip's vault key: filled in when this machine's vault holds exactly one Solana key, whatever EVM keys it has.
    const vaultKeyOf = (): { vaultKey?: string } => {
      const held = vaultKeysOn(destinations.all(), "solana")
      return held.length === 1 ? { vaultKey: held[0]!.label ?? held[0]!.address } : {}
    }
    /**
     * The next step to an agent's own Hood TEE wallet, where one can be made and it has none: Hood on, Pro or Max (a TEE
     * wallet is a linked wallet, which Free has none of), and a key. Nothing is made unless the person sends the line.
     */
    const hoodWalletFor = (agent: string): Fill | undefined => {
      if (!maybeChain("hood")) return undefined
      const plan = plans.planFor(agent).plan
      if (plan !== "pro" && plan !== "max") return undefined
      const prefix = prefixOf(agent)
      if (!prefix || wallets.teeOnKey(prefix).some((w) => w.chain !== "solana")) return undefined
      const vault = vaultMark.seen() || destinations.all().some((d) => d.kind === "vault-key")
      return hoodWalletStep(agent, { prefix, vault, evmKeys: vaultKeysOn(destinations.all(), "evm").map((d) => d.label ?? d.address), ...takenNames() })
    }
    // A promote from an EVM vault key that makes the account's first Hood TEE wallet: the vault file moves to version 4.
    const firstEvmTee = (from: string): boolean => {
      const key = isEvmAddress(from) ? from : vaultKeysOn(destinations.all(), "evm").find((d) => d.label?.toLowerCase() === from.toLowerCase())?.address
      if (key === undefined) return false
      return !wallets.view().account.some((w) => w.chain !== "solana")
    }
    const valueFlagsOf = (words: string[]) => sourceFor(words[0]!, words[1] ?? null)?.flags?.value ?? []
    const afterOwner = async (open: { pane: PaneParams["pane"]; approvedAt: number; holders?: string[]; teeBefore?: string[] }, result: PaneResult, captured?: Captured): Promise<PaneResult> => {
      const pane = open.pane
      const words = ownerWords(pane)
      if (pane.row === "keys create" && pane.newAgent) return afterKeysCreate(pane.newAgent, words, open.approvedAt, result, captured)
      // Onboarding's sign-in: only its own `auth login` names a profile (the agent can't). Signed in
      // as that profile now, it's recorded as the one the Candle Harness acts as, whatever the CLI's exit said.
      if (pane.row === "auth login" && words.includes("--profile")) return afterSignIn(words[words.indexOf("--profile") + 1] ?? "", result)
      if (pane.row === "tee disable" && (result.outcome === "finished" || result.outcome === "pending")) return afterStop(positionals(words, valueFlagsOf(words)).find(isAddress), pane.agent, result)
      if (pane.row === "tee rename" || pane.row === "vault rename") return afterRename(pane, words, result)
      if (result.outcome !== "finished") return result
      // An owner step that finished may be what setup waits on (the wallet part would stay put after the allow, since
      // nothing read it again): read back and published, so setup moves on by itself.
      const setup = await onboarding.read().catch(() => undefined)
      if (setup && setup.finishedAt === undefined) await publishOnboarding({ fresh: true }).catch(() => {})
      // The wallet is the first word that isn't a flag or a flag's value: `--token 0x…` may come before it.
      if (pane.row === "tee sweep") return afterSweep(positionals(words, valueFlagsOf(words)).find(isAddress), result)
      if (pane.row === "update") return { ...result, words: await afterUpdate() }
      // A vault made here: read, so it's marked and owner steps take the factor from the next card.
      if (pane.row === "vault init" || pane.row === "vault restore") await cliTool.vaultState().catch(() => {})
      if (pane.row === "tee rebind") return afterRebind(open.holders ?? [], result)
      // A new EVM vault key the Hood chip named for an agent: its promote is next, from that key by its label.
      const newKey = pane.row === "vault new-key" ? hoodNewKeyOf(words, agentPrefixes()) : undefined
      if (newKey) {
        const prefix = prefixOf(newKey.agent)!
        publishPortfolio?.()
        return { ...result, next: [hoodWalletStep(newKey.agent, { prefix, vault: true, evmKeys: [newKey.key], ...takenNames() })] }
      }
      const step = freshTeeStepOf(words, agentPrefixes())
      if (step) {
        // The key's wallets as they were when the pane was approved: a read while it ran may already list the new one.
        const before = new Set(open.teeBefore ?? wallets.teeOnKey(prefixOf(step.agent)!).map((w) => w.address))
        // The promoted wallet by its label, else the one wallet new on the key: never a guess, which could fund the wrong one.
        const promoted = () => {
          const onKey = wallets.teeOnKey(prefixOf(step.agent)!)
          const fresh = onKey.filter((w) => !before.has(w.address))
          return { onKey, tee: onKey.find((w) => step.label !== undefined && w.label?.toLowerCase() === step.label.toLowerCase()) ?? (fresh.length === 1 ? fresh[0] : undefined) }
        }
        // The key's list names a wallet only once the account's portfolio has it too: both read again.
        const readBoth = () => Promise.all([prices.refresh().catch(() => {}), wallets.refresh(step.agent).catch(() => {})])
        await readBoth()
        // Candle may list a wallet a moment after its import: read once more before saying it without its address.
        if (promoted().tee === undefined) {
          await Bun.sleep(opts.promoteReadAgainMs ?? 3000)
          await readBoth()
        }
        const { onKey, tee } = promoted()
        // A Hood wallet (by the wallet found, else by the vault key it came from): funded ETH first.
        const from = words[words.indexOf("--from") + 1]
        const evmFrom = from !== undefined && (isEvmAddress(from) || vaultKeysOn(destinations.all(), "evm").some((d) => d.label?.toLowerCase() === from.toLowerCase()))
        if (tee ? tee.chain !== "solana" : evmFrom) {
          // The bridge lands only in the key's own wallet on the other chain, from its Solana TEE wallet: offered where it holds one that pays.
          const solana = onKey.filter((w) => w.chain === "solana" && w.active && !w.cantSign)
          const solanaTee = solana.length === 1 ? (solana[0]!.label ?? solana[0]!.address) : undefined
          return { ...result, next: hoodFundSteps(step.agent, { ...(tee ? { address: tee.address } : {}), ...(solanaTee ? { solanaTee } : {}) }) }
        }
        return { ...result, next: [freshTeeStep(2, step.agent, { prefix: prefixOf(step.agent)!, ...(tee ? { address: tee.address } : {}) })] }
      }
      // A fund or a rebind changes what an agent can pay from: read again now, so the approvals menu and the next card see it.
      if (pane.row === "vault fund" || pane.row === "tee fund") await wallets.refreshAll().catch(() => {})
      return result
    }

    /**
     * A stop is final (the CLI never re-enables a TEE wallet), and Candle then drops the wallet
     * from every list. The core keeps it, with its label and agent, so the Wallets pane, the agent and the
     * outcome can say what's left: sweep it home. Exit 3 is a stop asked for, not yet confirmed.
     */
    const afterStop = async (address: string | undefined, agent: string | undefined, result: PaneResult): Promise<PaneResult> => {
      if (!address) return result
      const label = teeLabel(address)
      await stoppedWallets.stopped({ address, ...(label ? { label } : {}), ...(agent ? { agent } : {}) }, { now: now(), confirmed: result.outcome === "finished" })
      publishPortfolio?.()
      if (result.outcome !== "finished") return result
      return { ...result, words: STOPPED_FOR_GOOD, next: [{ label: "sweep it home", line: `candle tee sweep ${address}${agent ? ` as ${agent}` : ""}` }] }
    }
    /** A finished sweep retired the address (the CLI: "this address is retired and must not be reused"). */
    const afterSweep = async (address: string | undefined, result: PaneResult): Promise<PaneResult> => {
      if (address) await stoppedWallets.swept(address, now())
      publishPortfolio?.()
      return { ...result, words: SWEPT_AND_RETIRED }
    }
    const teeLabel = (address: string): string | undefined => {
      for (const prefix of agentPrefixes().values()) {
        const label = wallets.teeOnKey(prefix).find((w) => w.address === address)?.label
        if (label) return label
      }
      return destinations.all().find((d) => d.address === address)?.label
    }

    /**
     * The launcher stored the key as the card's agent, so the core loads it with no
     * restart. A key made but not stored is found in the owner's key list (labelled as the agent, made
     * since the approval, held by no agent here) and offered for revoking, as a typed line. Nothing is
     * retried.
     */
    const afterSignIn = async (profile: string, result: PaneResult): Promise<PaneResult> => {
      const run = await candleCli.runExact({ argv: ["auth", "status", "--profile", profile, "--json"], json: true }).catch(() => undefined)
      const signed = signInFrom(run ? { exitCode: run.exitCode, json: run.json } : undefined)
      if (signed.state !== "signed-in") return { ...result, words: `${result.words} Candle doesn't show ${profile} signed in, so nothing was recorded: sign in again.` }
      try {
        await useProfile(profile, "pane")
      } catch (error) {
        return { ...result, words: `signed in as ${profile}, but ${(error as Error).message}` }
      }
      void publishOnboarding().catch(() => {})
      return { ...result, outcome: "finished", words: `signed in to Candle${signed.account ? ` as ${short(signed.account)}` : ""}: the Candle Harness acts as the profile ${profile} from now on.` }
    }
    /**
     * Paper the person picked, which a run of setup keeps: a mode saved since (the status bar, `paper`), or
     * config.toml's own `mode = "paper"`, as an install from before setup ended live wrote it. A fresh install's
     * config.toml says live, written at sign-in after the core started.
     */
    const pickedPaper = (): boolean => {
      const saved = readSavedMode(paths.modeState)
      if (saved !== undefined) return saved === "paper"
      try {
        return (Bun.TOML.parse(readFileSync(paths.configFile, "utf8")) as { mode?: unknown }).mode === "paper"
      } catch {
        return false
      }
    }
    /**
     * Setup ends in live on a fresh install: past the fund step, funded or not, and Straight in once its key is made.
     * A run of setup again keeps the mode the person is on. A live trade without funds, or from a key not yet allowed a
     * wallet, is refused saying what to do. Paper is the person's own pick, from the status bar or `paper`.
     */
    const setupGoesLive = async (by: string): Promise<void> => {
      if (mode === "live" || pickedPaper()) return
      mode = "live"
      await saveMode(paths.modeState, mode, now())
      await j.append({ type: "mode.changed", mode, by })
      publishStatus?.()
      void publish("triggers", triggers.view())
    }
    /**
     * The agent onboarding asked for: it runs on the engine and model step 2 tested, and Straight
     * in then opens the Candle Harness, live on a fresh install (setupGoesLive). An agent made any other way is left as `keys create` made it.
     */
    const afterOnboardingKey = async (agent: string): Promise<void> => {
      const state = await onboarding.read()
      if (!state || state.finishedAt !== undefined || state.agent?.name !== agent) return
      if (state.engine) {
        await engineState.set(agent, { engine: state.engine, ...(state.model ? { model: state.model } : {}) }, now())
        await j.append({ type: "engine.chosen", mode, agent, engine: state.engine, model: state.model ?? null, by: "onboarding" })
        publish("engine", engineView())
      }
      if (state.straightIn) await setupGoesLive("onboarding")
      await publishOnboarding()
    }
    // Candle's code when setup's last `keys create` made no key, for setup's key step to say what to do; the next try clears it.
    let keyRefused: string | undefined
    const afterKeysCreate = async (agent: string, words: string[], approvedAt: number, result: PaneResult, captured?: Captured): Promise<PaneResult> => {
      if (captured?.code && captured.stored === false && captured.prefix === undefined) {
        keyRefused = captured.code
        void publishOnboarding().catch(() => {})
        if (captured.code === AGENT_WALLET_NOT_DELEGATED) return { ...result, outcome: "didnt_finish", words: NOT_DELEGATED_WORDS }
        const confirm = OWNER_CONFIRM_WORDS[captured.code]
        if (confirm) return { ...result, outcome: "didnt_finish", words: confirm }
        return result
      }
      // The launcher's word, or, if its report was lost, the key file and config entry it wrote: only this pane writes them.
      const stored = (captured?.stored === true && captured.agent === agent) || (captured === undefined && !keys.has(agent) && existsSync(paths.keyFile(agent)))
      if (stored && (await addAgent(agent))) {
        const lp = (words[words.indexOf("--scopes") + 1] ?? "").split(",").includes("lp:write") && words.includes("--scopes")
        await afterOnboardingKey(agent).catch(() => {})
        return {
          ...result,
          outcome: "finished",
          words: `made ${agent} (key ${prefixOf(agent)}…): it's in the Agents list now.${lp ? " Next, its own TEE wallet." : ""}`,
          ...(lp ? { next: [freshTeeStep(1, agent, { prefix: prefixOf(agent)!, ...vaultKeyOf(), ...takenNames() })] } : {}),
        }
      }
      const run = await candleCli.runExact({ argv: candleCli.finalArgs({ args: ["keys", "list"], json: true, withRpcUrl: false }), json: true }).catch(() => undefined)
      const held = new Set(agentPrefixes().values())
      const rows = ((run?.json as { keys?: unknown } | undefined)?.keys ?? []) as { keyPrefix?: unknown; label?: unknown; createdAt?: unknown; revokedAt?: unknown }[]
      const ms = (t: unknown) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : typeof t === "string" ? Date.parse(t) : Number.NaN)
      const orphans = Array.isArray(rows)
        ? rows.filter((k) => typeof k.keyPrefix === "string" && !held.has(k.keyPrefix) && k.revokedAt == null && (k.keyPrefix === captured?.prefix || (k.label === agent && ms(k.createdAt) >= approvedAt - 60_000))).map((k) => k.keyPrefix as string)
        : captured?.prefix ? [captured.prefix] : []
      if (orphans.length === 0) return result
      await j.append({ type: "agent.key_not_stored", mode, agent, keyPrefixes: orphans })
      return {
        ...result,
        outcome: "didnt_finish",
        words: `a key was made but not stored: revoke ${orphans.join(", ")}, then ask again. It's live on your account and nothing holds it.`,
        next: orphans.map((prefix) => ({ label: `revoke ${prefix}`, line: `candle keys revoke ${prefix}` })),
      }
    }

    /** Loads an agent `keys create` just stored: its config, its key and its Candle child, with no restart. */
    const addAgent = async (agent: string): Promise<boolean> => {
      if (keys.has(agent)) return true
      if (!isAgentName(agent)) return false
      let entry: Config["agents"][string] | undefined
      try {
        entry = parseConfig(readFileSync(paths.configFile, "utf8"), paths.configFile).config.agents[agent]
      } catch {
        return false
      }
      const file = paths.keyFile(agent)
      const key = existsSync(file) ? readFileSync(file, "utf8").trim() : ""
      if (!entry || apiKeyPrefix(key) === undefined) return false
      redactor.add(key)
      config.agents[agent] = entry
      keys.set(agent, key)
      sawConfig()
      // The first agent, made in setup: it's the active one, so the view and a typed trade have someone to act as.
      if (activeAgent === "" || !Object.hasOwn(config.agents, activeAgent)) {
        activeAgent = agent
        await saveAgent(paths.activeState, agent, now()).catch(() => {})
      }
      await j.append({ type: "agent.added", mode, agent, keyPrefix: apiKeyPrefix(key), by: "keys create" })
      publishStatus?.()
      void pool
        .add({ name: agent, apiKey: key })
        .then(() => wallets.refresh(agent))
        .then(() => publishStatus?.())
        // Setup's wallet part reads what the new key can pay from: read again once Candle answers for it.
        .then(async () => {
          const held = await onboarding.read()
          if (held && held.finishedAt === undefined) await publishOnboarding()
        })
        .catch(async (error) => {
          await j.append({ type: "candle.start_failed", mode, agent, error: String(error) }).catch(() => {})
        })
      return true
    }

    /** After `candle update`: every Candle child runs the new CLI, and the version is checked against the table. */
    const afterUpdate = async (): Promise<string> => {
      await pool.restart().catch(() => {})
      const run = await candleCli.runExact({ argv: ["--version"], json: false }).catch(() => undefined)
      const version = run?.exitCode === 0 ? (run.stdout.trim().match(/\d+\.\d+\.\d+\S*/)?.[0] ?? run.stdout.trim()) : undefined
      const table = SOURCE.source.cliVersion
      await j.append({ type: "cli.updated", mode, ...(version ? { version } : {}), table })
      publishStatus?.()
      const now_ = version ? `candle is ${version} now` : "candle's version didn't read"
      return `finished in the pane: ${now_}, and each agent's Candle connection restarted.${version && version !== table ? ` The Candle Harness was checked against candle ${table}: run candle-harness doctor.` : ""}`
    }

    /**
     * After a rebind the user asked for: an agent it left with no TEE wallet is offered a
     * fresh one, and told whether it can still trade from the embedded wallet.
     */
    const afterRebind = async (holders: string[], result: PaneResult): Promise<PaneResult> => {
      await wallets.refreshAll().catch(() => {})
      const left = rebindLeft(holders, { teeCount: (a) => wallets.teeOnKey(prefixOf(a) ?? "").length, embedded: (a) => status.get(a)?.embeddedWallet, prefix: (a) => (keys.has(a) ? prefixOf(a) : undefined), ...vaultKeyOf(), ...takenNames() })
      if (left.next.length === 0) return result
      return { ...result, words: `${result.words} ${left.words.join(" ")}`, next: left.next }
    }
    /** Who holds each wallet a rebind names, read when it's approved: the agents it may leave with none. */
    const rebindHolders = (pane: PaneParams["pane"]): string[] => {
      const words = ownerWords(pane)
      const named = positionals(words, valueFlagsOf(words))
      return [...agentPrefixes()].filter(([, prefix]) => wallets.teeOnKey(prefix).some((w) => named.includes(w.address) || named.includes(w.id) || (w.label !== undefined && named.includes(w.label)))).map(([a]) => a)
    }
    // That this machine has had a vault: with it and no vault, owner rows are refused.
    const vaultMark = new VaultMark({ file: paths.vaultSeen, now })
    // Onboarding's harness sign-ins: each pane's engine, so its report reads the engine again.
    const harnessPanes = new Map<string, EngineId>()
    const tickets = new PaneTickets({
      now,
      onExpired: (entry) => {
        if (harnessPanes.delete(entry.ticketId)) return
        void settlePane(entry.ticketId, NOT_OPENED).catch(() => {})
      },
    })
    // What a pane step touched is read again; nothing is re-run. Funds out, or an end nobody saw, reads
    // the balances as after a fill (a finished one is read by the journal's operation.succeeded row).
    const afterPane = (pane: PaneParams["pane"], result: PaneResult, endedAt?: number) => {
      // A key the step's own read-back read after it ended (setup's, after an allow) isn't read again: a Free key has 30 a minute.
      refreshWallets(endedAt !== undefined ? { readSince: endedAt } : {})
      if (pane.rule === "funds-out" && result.outcome !== "finished") for (const ms of AFTER_FILL_READS_MS) setTimeout(() => void prices.refresh().catch(() => {}), ms).unref?.()
    }

    // An image upload's file, staged when its card is made; let go once it can't be re-sent.
    const uploads = new UploadStage(paths.uploads)
    const releaseUpload = (opId: string, params: Record<string, unknown>) => {
      if (params.file !== undefined) void uploads.release(opId).catch(() => {})
    }
    const operations = new Operations({
      journal: j,
      pool,
      now,
      // A fill's pair asset at its price now, from the prices already held: the book values a bot's entry by it.
      assetUsd: (asset) => (isBaseAsset(asset) ? latest.usd(BASE_ASSETS[asset].priceKey) : undefined),
      onChange: (op: Operation) => {
        if (op.state === "succeeded" || op.state === "failed" || op.state === "refused" || op.state === "abandoned") releaseUpload(op.opId, op.params)
        // A swap whose first leg landed spent what it sent, though it ended failed: the day still counts it.
        const spentAs = op.state === "failed" && op.partial ? "partial" : op.state
        spend.settle(op.opId, spentAs)
        walletSpend.settle(op.opId, spentAs)
        if (op.error?.code === "KEY_LIMIT_REACHED" || op.error?.code === "RISK_LIMIT_REACHED") keyHolds.note(op.agent, op.error, now())
        // Candle stopped the key: every bot of its agent is paused, so none enters when the owner resumes the key.
        botTrades.noteOperation(op)
        cards.noteOperation(op.opId, { state: op.state, ...(op.result !== undefined ? { result: op.result } : {}), ...(op.error ? { error: op.error } : {}), ...(op.paper ? { paper: true } : {}), ...(op.partial ? { partial: op.partial } : {}) })
        kill?.noteOperation(op)
        triggerFirer?.poke()
        publish("operations", op, cardOwner.get(op.cardId))
        publishStatus?.() // the agent's spend today changed
      },
      loseNextReply: losesNextReply(opts.env),
      cli: (op) => cliTool.execute(op),
      cliRead: (op) => cliTool.readBack(op),
      // A TEE wallet's trade or swap, through the user's own `candle swap`.
      cliTrades: { execute: (op) => cliTrades.execute(op), read: (op) => cliTrades.read(op), readBridge: (op) => cliTrades.readBridge(op) },
      // An open bridge's read is through the key that placed it: `candle swap status`, a replay, or a portfolio read.
      bridgeBudget: (agent, requests) => budget.take("bridges", agent, requests) !== undefined,
      // An embedded bridge's landing wallet: the account's embedded wallet on the chain of what it brings.
      bridgeLanding: async (op) => {
        const facts = bridgeFactsOf(op.params)
        const family = facts ? maybeChain(BASE_ASSETS[facts.to].chain)?.family : undefined
        const wallets = status.get(op.agent)?.wallets
        const address = family === "solana" ? wallets?.solana : family === "evm" ? wallets?.evm : undefined
        if (!facts || !address) return undefined
        const outcome = await pool.for(op.agent).call("candle_get_portfolio", {})
        return outcome.kind === "ok" ? landingBalance(outcome.result, address, facts.to) : undefined
      },
      // An approved Hacc card: a removal, or a rule's add.
      hacc: { run: (op) => haccChanges.run(op), read: (op) => haccChanges.readBack(op) },
      // The agent's narrowing of a wallet's autonomy, approved: it runs in the core.
      autonomy: { run: (op) => autonomyDesk.run(op), read: (op) => autonomyDesk.read(op) },
      // A trigger's card, approved: saved in the core, checked whole again.
      triggers: { run: (op) => runTriggerCard(triggers, op), read: (op) => readTriggerCard(triggers, op) },
      // A rules bot's card, approved: saved against the hash it bound, or flattened.
      bots: { run: (op) => runBotCard(bots, op, codeBots), read: (op) => readBotCard(bots, j.botRows(), op, codeBots) },
      paused,
      // A bot's exit a restart cut off, re-sent by the core: held as its other sells are.
      resendHold: (op) => {
        const mint = op.params.mint
        return typeof mint === "string" ? botTrades.resendHold(op.agent, mint, op.opId, symbolOf(mint) ?? short(mint)) : undefined
      },
    })
    // An open bridge is read every 10 s by its key until it ends: six reads a minute each (an embedded one's balance
    // read is two of Candle's requests), ahead of the panes' reads.
    const bridgeRequests = () => operations.openBridges().reduce((n, op) => n + bridgeReadRequests(op), 0)
    budget.want("bridges", { perMin: () => bridgeRequests() * (60_000 / BRIDGE_POLL_MS), floor: bridgeRequests, naturalMs: BRIDGE_POLL_MS, key: () => operations.openBridges()[0]?.agent })
    const symbols = new SymbolBook(paths.symbols)
    const markets = new Markets({ pool: { for: (agent) => ({ call: async (name, args) => noted(name, await pool.for(agent).call(name, args)) }) }, now, learned: (mint, symbol) => symbols.learn(mint, symbol) })
    // Cards are priced when proposed, fresh, or by Candle's quote once the MCP server has it.
    const pricing = new Pricing({
      call: async (agent, tool, args) => noted(tool, await pool.for(agent).call(tool, args)),
      tools: (agent) => (pool.agents().includes(agent) ? pool.for(agent).tools().map((t) => t.name) : []),
      now,
      config: config.pricing,
      book: prices,
    })
    /** A fresh read of what a wallet holds of a token, through the agent's own portfolio read. */
    const holdingNow = async (agent: string, wallet: string, mint: string): Promise<Holding> => {
      const outcome = await pool.for(agent).call("candle_get_portfolio", {})
      if (outcome.kind !== "ok") return "unreadable"
      return holdingFrom(outcome.result, wallet, mint)
    }
    const cards: CardBook = new CardBook({
      journal: j,
      account,
      now,
      mode: () => mode,
      agents: () => [...keys.keys()],
      keyPrefix: (agent) => apiKeyPrefix(keys.get(agent) ?? ""),
      status,
      markets,
      spendAsset: () => config.trade.spendAsset,
      holding: holdingNow,
      pricing,
      limits: new Limits({ limitsFor: (agent) => config.agents[agent]?.limits, spend }),
      spend,
      walletSpend,
      holds: keyHolds,
      sellWarning: (agent, mint) => botTrades.sellWarning(agent, mint, symbolOf(mint) ?? short(mint)),
      autonomy,
      // A name held in a wallet or on an earlier card under another mint: the card and its receipt say so.
      otherMints: (symbol, mint) => metNames.mintsOf(symbol).filter((m) => !sameAddress(m, mint)),
      onDropped: (card) => cardOwner.delete(card.cardId),
      paused,
      onValued: () => publishStatus?.(), // the agent's spend today changed
      // Which wallet pays (the agent's default, else the embedded wallet); a TEE wallet's card runs through `candle swap`.
      wallets,
      cliArgs: (args, o) => candleCli.finalArgs({ args, json: o?.json ?? true, withRpcUrl: o?.rpcUrl ?? true }),
      // The CLI's card rows: an upload's path rule and staging, a TEE launch's dry run.
      cliRows: { researchDir: (agent) => paths.researchDir(agent), stage: uploads, dryRun: (agent, argv) => candleCli.runExact({ agent, argv, json: true }), emptyOf: (address) => emptyBook?.get(address) },
      // Launches, staking and fee claims dry-run on the agent's own child when proposed.
      candle: (agent, tool, args) => pool.for(agent).call(tool, args),
      execute: (card) => operations.execute(card),
      refusePaused: (card) => operations.refusePaused(card),
      operations: () => operations.list(),
      openPane: async (card, viewClientId) => {
        const pane = (card.params as unknown as PaneParams).pane
        const title = paneTitle(card.params as unknown as PaneParams)
        const grant: PaneGrant = {
          cardId: card.cardId,
          opId: card.opId,
          title,
          bin: config.candle.cliPath,
          steps: pane.steps,
          identity: pane.identity,
          ...(pane.agent ? { agent: pane.agent } : {}),
          ...(pane.askPaths ? { askPaths: pane.askPaths } : {}),
          ...(pane.capture ? { capture: pane.capture } : {}),
          ...(pane.rule === "funds-out" ? { fundsOut: true } : {}),
          ...(pane.newAgent ? { newAgent: pane.newAgent } : {}),
        }
        const minted = tickets.mint({ cardId: card.cardId, cardHash: card.cardHash, viewClientId, grant })
        const promoteTo = pane.row === "vault promote" ? freshTeeStepOf(ownerWords(pane), agentPrefixes()) : undefined
        const teeBefore = promoteTo ? wallets.teeOnKey(prefixOf(promoteTo.agent)!).map((w) => w.address) : undefined
        panes.set(minted.ticketId, { opId: card.opId, cardId: card.cardId, pane, approvedAt: now(), ...(pane.row === "tee rebind" ? { holders: rebindHolders(pane) } : {}), ...(teeBefore ? { teeBefore } : {}) })
        const operation = await operations.beginPane(card, { ticketId: minted.ticketId })
        return { ...minted, title, operation: { state: operation.state } }
      },
      // The engine is made below; a harness can't propose before it has started a turn.
      turnOf: (tokenId) => engine.turnOf(tokenId),
      turnEnded: (tokenId) => engine.turnState(tokenId)?.ended === true,
      onChange: (card: Card) => {
        if (card.state === "rejected" || card.state === "expired" || card.state === "withdrawn") releaseUpload(card.opId, card.params)
        cardOwner.set(card.cardId, card.origin.clientId)
        triggerFirer?.poke()
        publish("cards", card, card.origin.clientId)
        // The token pane follows a token a card was just proposed on: the person's, when they typed it.
        const mint = card.display.mint ?? card.params.mint
        // On the card's own chain, from Candle's market answer; a card with none takes its mint's at the request's edge.
        const followChain = typeof mint === "string" ? (card.chain ?? requestChain(mint)) : undefined
        if (card.state === "awaiting_approval" && typeof mint === "string" && followChain) void tokenWatch.follow(mint, followChain, card.origin.role === "view" ? "you" : "agent").catch(() => {})
      },
    })
    // The CLI profile the Candle Harness acts as: config.toml's, or the one onboarding records.
    let candleProfile = config.candle.profile
    const candleCli = new CandleCli({
      profile: () => candleProfile,
      cliPath: config.candle.cliPath,
      ...(config.candle.rpcUrl ? { rpcUrl: config.candle.rpcUrl } : {}),
      ...(config.candle.evmRpcUrl ? { evmRpcUrl: config.candle.evmRpcUrl } : {}),
      keyFor: (agent) => keys.get(agent),
      parentEnv: opts.env,
      onRun: (agent, calls) => {
        budget.noteCall(agent, calls)
        usage.candleCall(agent, calls)
      },
    })
    // Empty token accounts: Candle's preview through the user's own CLI, with the key each
    // Solana TEE wallet is bound to, inside that key's budget. Never on a card's path.
    emptyBook = new EmptyAccountsBook({
      wallets: () => {
        const seen = new Map<string, string>()
        for (const agent of Object.keys(config.agents)) for (const w of wallets.payable(agent).tee) if (w.chain === "solana" && w.active && !seen.has(w.address)) seen.set(w.address, agent)
        return [...seen].map(([address, agent]) => ({ address, agent }))
      },
      run: (input) => candleCli.runExact(input),
      take: (agent) => budget.take("empty", agent, PREVIEW_CALLS),
      now,
      // The wallets topic carries the counts; it's sent with the portfolio.
      onChange: () => publishPortfolio?.(),
    })
    const emptyAccounts = emptyBook
    budget.want("empty", { perMin: () => emptyAccounts.perMin(), naturalMs: EMPTY_REFRESH_MS })
    const cliTrades = new CliTrades({ cli: candleCli, redactor, journal: j, readTrade: (agent, opId) => readTrade(pool.for(agent), opId) })
    const cliTool: CliTool = new CliTool({
      cli: candleCli,
      redactor,
      journal: j,
      cards,
      agents: () => new Set(keys.keys()),
      mode: () => mode,
      teeOnKey: (prefix) => wallets.teeOnKey(prefix),
      // Narrowing a key or its wallets changes what each agent can pay from: read it again.
      onAccessChanged: refreshWallets,
      cliCards: new CliCards({ cli: candleCli, redactor, journal: j, stage: uploads, now }),
      typedCards: () => config.cards.typedTrades,
      approveInstant: (viewClientId, card, how = "instant") => cards.approve(viewClientId, card.cardId, (card as Card).cardHash, how),
      // Owner rows: a new agent's name must be free; a rebind's card names who a wallet moves from and to.
      configured: () => new Set(Object.keys(config.agents)),
      maxAgents: MAX_AGENTS,
      agentPrefixes,
      firstEvmTee: (from) => firstEvmTee(from),
      isTee: (wallet) => [...agentPrefixes().values()].some((prefix) => wallets.teeOnKey(prefix).some((w) => w.address === wallet || w.id === wallet || w.label === wallet)),
      nameOf: (address, label) => nameOf(address, "tee", label),
      // Funds out: where funds may go, and the user's own message this turn, which must ask.
      destinations: knownDestinations,
      askedText: (client) => (client.role === "harness" && client.tokenId ? engine.askedIn(client.tokenId) : undefined),
      teeEnabled: (address) => portfolioNow().wallets.find((w) => w.kind === "tee" && w.address === address)?.active,
      pinnedVault: (address) => destinations.pinnedVault(address),
      gone: (address) => stoppedWallets.gone(address),
      vaultMark,
      renewBefore: (words) => renewBefore(words, opts.env, candleProfile, now()),
    })
    // Hacc's changes: adds at once with an undo, removals and a rule's add on a card.
    const haccChanges = new HaccChanges({
      hacc,
      cards,
      journal: j,
      mode: () => mode,
      now,
      plan: (agent) => plans.planFor(agent).plan,
      onPlanRefused: (agent) => void status.refresh(agent).then(() => plans.noticeChanges(), () => {}),
    })
    // Autonomy per wallet: each wallet's own figures, set only from a main view, narrowed by
    // the agent on a card, kept in state/autonomy.json. The wallets are those the configured agents pay from.
    const payWallets = (): { list: PayWallet[]; read: boolean } => {
      const byAddress = new Map<string, PayWallet>()
      let read = true
      // The embedded EVM wallet joins once the account uses its chain, or once it has a setting: every account has one,
      // and a Solana-only account's approvals menu stays as it was.
      const evm = defaultEvmChain()
      const evmInUse = evm !== undefined && chainsUsed().includes(evm.slug)
      for (const agent of keys.keys()) {
        const payable = wallets.payable(agent)
        if (!status.get(agent) || payable.readAt === undefined) read = false
        const add = (address: string, name: string, kind: PayWallet["kind"], cantSign?: true, chain?: ChainSlug) => {
          const w = byAddress.get(addressKey(address)) ?? { address, name, kind, agents: [], ...(cantSign ? { cantSign } : {}), ...(chain && chain !== "solana" ? { chain } : {}) }
          if (!w.agents.includes(agent)) w.agents.push(agent)
          byAddress.set(addressKey(address), w)
        }
        if (payable.embedded) add(payable.embedded.address, "embedded", "embedded")
        if (evm && payable.embeddedEvm && (evmInUse || autonomy.entry(payable.embeddedEvm))) add(payable.embeddedEvm, embeddedName(evm.slug), "embedded", undefined, evm.slug)
        for (const t of payable.tee) add(t.address, nameOf(t.address, "tee", t.label), "tee", t.cantSign, t.chain)
      }
      return { list: [...byAddress.values()], read }
    }
    const autonomyDesk = new AutonomyDesk({
      autonomy,
      journal: j,
      mode: () => mode,
      now,
      wallets: payWallets,
      usedToday: (wallet) => walletSpend.spent(wallet, now()),
      agentLimits: (agent) => config.agents[agent]?.limits,
      candleCaps: (agent) => {
        const st = status.get(agent)
        return st && !st.limitsUnread ? st.keyLimit !== undefined || (st.assetCaps?.length ?? 0) > 0 : undefined
      },
      propose: (input) => cards.propose(input),
      // The status topic carries the limit lines, and the autonomy topic goes with it.
      onChange: () => publishStatus?.(),
    })
    // The skills each agent has: its preset's, and the person's own, read from
    // their folder each time, so an edit shows on the next call or turn.
    // And from the skill folders the person turned on (Claude Code's, say), read by the core alone.
    const skillFolders = new SkillFolders(join(paths.stateDir, "skills.json"), config.skills.from, opts.env.HOME ?? homedir())
    const skillsOf = (agent: string) => skillsFor(engineState.preset(agent, config.agents[agent]?.preset).preset, loadPersonSkills(paths.skillsDir, skillFolders.on()).skills)
    // Each agent's memory: its own, in its research folder, written by its engine.
    const memory = new MemoryBook({
      researchDir: (agent) => paths.researchDir(agent),
      journal: j,
      mode: () => mode,
      changed: () => publish("memory", memoryTopic()),
    })
    const memoryTopic = () => ({ agents: Object.fromEntries(Object.keys(config.agents).map((agent) => [agent, memory.view(agent)])) })
    // harness_view: answered by a view, once the server is up.
    let askView: (client: FaceClient, args: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }> = async () => ({
      ok: false,
      code: "NO_VIEW",
      message: "No Candle Harness view is open, so there's no screen to change.",
    })
    // Every limit on an agent, each naming who enforces it, with each wallet it pays from
    // that trades inside limits: for the status topic and harness_limits alike.
    const agentLimitLines = (name: string) => {
      const s = status.get(name)
      return limitLines({
        harness: config.agents[name]?.limits,
        spentTodayUsd: spend.spent(name, now()),
        wallets: autonomyDesk.figures(name),
        candle: { read: s !== undefined && !s.limitsUnread, ...(s?.keyLimit ? { keyLimit: s.keyLimit } : {}), ...(s?.assetCaps ? { assetCaps: s.assetCaps } : {}) },
      })
    }
    // What the agent's wallets let run without a card, read fresh.
    const agentAutonomy = (agent: string) => {
      const view = autonomyDesk.view()
      return { read: view.read, wallets: view.wallets.filter((w) => !w.gone && w.agents.includes(agent)) }
    }
    // harness_triggers: the agent reads, proposes a trigger as a card, and narrows or switches one off at once.
    const wakeCaps = (agent: string) => ({ perHour: config.agents[agent]?.wake?.perHour ?? WAKES_PER_HOUR, perDay: config.agents[agent]?.wake?.perDay ?? WAKES_PER_DAY })
    // A wallet of its own: a fresh TEE wallet from a vault key, or a vault first where this machine has none.
    const ownWalletSteps = (agent: string): { label: string; line: string }[] => {
      const prefix = prefixOf(agent)
      const vault = vaultMark.seen() || destinations.all().some((d) => d.kind === "vault-key")
      if (!vault) return [{ label: "set up a vault", line: "candle vault init" }]
      return prefix ? [freshTeeStep(1, agent, { prefix, ...vaultKeyOf(), ...takenNames() })] : []
    }
    const triggersTool = new TriggersTool({
      book: triggers,
      propose: async (client, c, reason) => {
        const name = c.check.trigger.name
        const title = `${c.spec.replaces ? "CHANGE" : "NEW"} TRIGGER "${name}"`
        const params: TriggerCardParams = { line: c.check.line, proposer: client.agent, name, expansion: c.check.trigger.expansion, replace: c.spec.replaces === true, mode: c.check.mode }
        const card = await cards.propose({
          client,
          agent: client.agent,
          tool: TRIGGERS_TOOL_NAME,
          args: { action: "propose", line: c.check.line, ...(c.spec.replaces ? { replace: true } : {}) },
          params: params as unknown as Record<string, unknown>,
          kind: "trigger",
          idKey: "coreOpId",
          title,
          triggerCard: { spec: c.spec, ...(c.paysFrom ? { paysFrom: c.paysFrom } : {}) },
          ...(c.warning ? { warning: c.warning } : {}),
          ...(c.fills?.length ? { fills: c.fills } : {}),
          ...(reason ? { reason } : {}),
        })
        return card.opId
      },
      wokenBy: (tokenId) => engine.turnOf(tokenId)?.woken?.trigger,
      caps: wakeCaps,
      ownWallet: (agent) => ownWalletSteps(agent),
    })
    triggers.setOwnWallet((agent) => ownWalletSteps(agent))
    // harness_bots: the agent reads its bots, proposes one (or a wider change, or going live) as a card, narrows or
    // pauses at once, and flattens on a card.
    /** Who else trades from a bot's wallet: other agents, other bots. The embedded wallet is always shared. */
    const botSharedWith = (agent: string, wallet: string, bot: string): string[] => {
      const others = [...bots.entries(), ...codeBots.entries()]
        .filter((b) => b.wallet === wallet && b.name !== bot)
        .map((b) => `the bot "${b.name}"`)
      if (wallet === "embedded") return ["you and every agent", ...others]
      const agents = autonomyDesk.view().wallets.find((w) => w.wallet === wallet)?.agents.filter((a) => a !== agent) ?? []
      return [...agents, ...others]
    }
    const botsTool = new BotsTool({
      book: bots,
      triggers,
      bookOf: (name, mode) => {
        const open = botPositions.open(name, mode).map((p) => {
          const now = triggerWatch?.latest(p.mint)?.priceUsd ?? undefined
          const entry = botPositions.entryPriceUsd(p)
          const up = now !== undefined && now !== null ? botPositions.unrealizedUsd(p, now) : undefined
          return {
            token: wordName(p.mint) ?? p.mint,
            mint: p.mint,
            since: p.entryAt,
            ...(entry !== undefined ? { entryUsd: Number(entry.toPrecision(6)) } : {}),
            ...(now !== undefined && now !== null ? { nowUsd: Number(now.toPrecision(6)) } : {}),
            ...(up !== undefined ? { unrealizedUsd: Number(up.toFixed(2)) } : {}),
            ...(p.costUsd !== undefined ? { costUsd: Number(p.costUsd.toFixed(2)) } : {}),
          }
        })
        const totals = botPositions.totals(name, mode)
        return { open, closed: totals.closed, realizedUsd: totals.realizedUsd, valued: totals.valued }
      },
      recent: (name) => botRecent(j.botRows(), name, now(), (mint: string) => wordName(mint)),
      payWallet: botPayWallet,
      feeBps: (agent) => status.get(agent)?.feeBps ?? FALLBACK_FEE_BPS,
      sharedWith: botSharedWith,
      ownWallet: (agent) => ownWalletSteps(agent),
      backtestOf: (definition) => backtestFromJournal(j.rows(), definition),
      lab: (agent) => haccOffered(agent) && plans.planFor(agent).plan === "max",
      strategy: async (agent, id) => {
        if (!haccOffered(agent)) return { ok: false, code: "HACC_OFF", message: "Hacc's data isn't open to this agent, so its saved strategies can't be read." }
        const got = await hacc.get(agent, `/v1/strategies/${id}`)
        if (got.kind !== "ok") return { ok: false, code: got.kind === "refused" ? got.code : "HACC_UNREACHABLE", message: got.kind === "refused" ? `Hacc refused: ${got.message}` : "Hacc didn't answer for that strategy." }
        return strategyFrom(got.body, id)
      },
      propose: async (client, c, reason) => {
        const card = await cards.propose({
          client,
          agent: client.agent,
          tool: BOTS_TOOL_NAME,
          args: { action: c.action === "flatten" ? "flatten" : "propose", name: c.name, ...(c.params.action === "flatten" && c.params.kind === "code" ? { kind: "code" } : {}) },
          params: c.params as unknown as Record<string, unknown>,
          kind: "bot",
          idKey: "coreOpId",
          title: c.title,
          botCard: { spec: c.spec, ...(c.paysFrom ? { paysFrom: c.paysFrom } : {}), ...(c.slippage ? { slippage: c.slippage } : {}) },
          ...(c.warning ? { warning: c.warning } : {}),
          ...(c.fills?.length ? { fills: c.fills } : {}),
          ...(reason ? { reason } : {}),
        })
        return card.opId
      },
      wokenBy: (tokenId) => engine.turnOf(tokenId)?.woken?.trigger,
      // Code bots: read with what the Bots tab shows of each (its report, held exits and process).
      code: {
        book: codeBots,
        views: () => botsTopic().code ?? [],
        testsLeftOpen: () =>
          botPositions.openWhere((name) => isTestName(name) && !codeBots.isTest(name)).map((p) => ({ test: p.bot, agent: p.agent, token: symbolOf(p.mint) ?? p.mint, since: p.entryAt })),
      },
    })
    const face = new ToolFace({
      pool,
      schemaOf: (agent, tool) => pool.for(agent).tools().find((t) => t.name === tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined,
      cards,
      journal: j,
      mode: () => mode,
      cli: cliTool,
      sizing: { markets, pricing, spendAsset: () => config.trade.spendAsset },
      wokenBy: (tokenId) => engine.turnOf(tokenId)?.woken?.trigger,
      turn: (tokenId) => engine.turnState(tokenId),
      research: (client, name, args) => researchCall(paths.researchDir(client.agent), name, args),
      // The code runner: held to the agent's research folder, journalled with the command, said in Activity.
      run: async (client, args) => {
        const programs = runPrograms(client.agent)
        if (!programs) {
          const why = runHold.ok ? `the code runner is off for ${client.agent}` : `the code runner can't be held on this machine (${runHold.why})`
          return { ok: false, code: "TOOL_HIDDEN", message: `research_run isn't offered: ${why}.` }
        }
        const r = await researchRun({ root: paths.researchDir(client.agent), programs, args, path: opts.env.PATH, home: opts.env.HOME, keep: [paths.configDir], self: selfCommand(), now })
        if (r.row) {
          const ran = [r.row.program, ...r.row.args].join(" ")
          const ended = r.ok ? (r.row.timedOut ? "stopped at 60 s" : r.row.signal ? `stopped by ${r.row.signal}` : `exit ${r.row.exitCode}`) : "not held, nothing ran"
          await j.append({ type: "research.run", mode, agent: client.agent, clientId: client.clientId, ...r.row, ...(r.ok ? {} : { refused: r.code }) })
          publish("activity", { kind: "research.run", agent: client.agent, text: `${client.agent} ran ${ran.length > 80 ? `${ran.slice(0, 79)}…` : ran} · ${ended} in ${(r.row.ms / 1000).toFixed(1)} s` })
        }
        return r
      },
      skills: (client) => skillsOf(client.agent),
      history: (client, args) => historyCall(j.rows(), client.agent, args, { now, sessionEnd: () => sessionEnd }),
      pnl: (_client, args) => pnlCall(pnl, args, { now, sessionEnd: () => sessionEnd, mode: () => mode }),
      limits: {
        read: (client) => {
          const { read, wallets } = agentAutonomy(client.agent)
          const own = config.agents[client.agent]?.limits
          const hold = keyHolds.held(client.agent, now())
          return limitsRead({
            agent: client.agent,
            mode,
            paused: paused(),
            lines: agentLimitLines(client.agent),
            wallets,
            walletsRead: read,
            ...(own ? { own: { ...own, usedUsd: spend.spent(client.agent, now()) } } : {}),
            ...(hold ? { hold } : {}),
            now: now(),
          })
        },
        propose: (client, args, reason) => autonomyDesk.propose(client, args, reason),
      },
      triggers: triggersTool,
      bots: botsTool,
      hacc: async (client, name, args) => {
        if (!config.hacc.enabled) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: "HACC_OFF", message: "Hacc's data is turned off in this Candle Harness's config ([hacc] enabled = false)." } }) }], isError: true }
        return haccTools.call(client.agent, name, args, client)
      },
      view: (client, args) => askView(client, args),
      // Whether a named wallet is the account's embedded one, on either chain: a paper trade has no wallet behind it.
      isEmbedded: (agent, word) =>
        (["solana", "hood"] as const).some((chain) => {
          const r = wallets.payer(agent, word, { chain })
          return r.ok && r.kind === "embedded"
        }),
      nameWallets: async (client, asks, reason) => {
        const named = await nameWallets(client, asks, { typed: false, ...(reason !== undefined ? { reason } : {}) })
        if (!named.ok) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: named.code, message: named.message } }) }], isError: true }
        // The cards' own answers, as candle_cli gives them: awaiting the person's approval, never a refusal.
        const cards = named.cards.map((c) => JSON.parse((cardAnswer(c).content[0] as { text: string }).text) as unknown)
        return { content: [{ type: "text", text: JSON.stringify({ success: true, done: named.said, ...(cards.length ? { cards } : {}) }) }] }
      },
      groupWallets: async (client, args) => {
        const op: GroupOp | undefined = (() => {
          const group = typeof args.group === "string" ? args.group : undefined
          if (group === undefined) return undefined
          const ops = [args.add !== undefined, args.remove !== undefined, args.prefix !== undefined, args.delete === true].filter(Boolean).length
          if (ops !== 1) return undefined
          if (args.add !== undefined) return groupOpOf({ group, op: "add", wallets: args.add })
          if (args.remove !== undefined) return groupOpOf({ group, op: "remove", wallets: args.remove })
          if (args.prefix !== undefined) return groupOpOf({ group, op: "prefix", prefix: args.prefix })
          return { op: "delete", group }
        })()
        const fail = (code: string, message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: { code, message } }) }], isError: true })
        if (!op) return fail("MCP_VALIDATION", "group is the group's name, with exactly one of add (wallets), remove (wallets), prefix (text, or null to drop it) or delete: true.")
        const done = await groupWallets(client, op)
        if (!done.ok) return fail(done.code, done.message)
        return { content: [{ type: "text", text: JSON.stringify({ success: true, done: done.said }) }] }
      },
      showWallets: async (client, show) => {
        const set = await setWalletsShown(show, client.clientId, client.agent)
        if (!set.ok) return set
        const { shown, hidden } = shownWallets(portfolioNow().wallets, walletsShown, groupBook())
        const names = shown.map((w) => viewName(w))
        return { ok: true, text: `The panes now show ${names.length ? names.join(", ") : "no wallets"}${hidden ? `; ${hidden} hidden` : ""}.` }
      },
    })

    // The Trade tab: the activity pane's lines, paper books and who bought what come from the
    // journal; the token pane follows what the agent shows from Candle.
    // A token's name wherever the views show it, and so what the input line learns (without it,
    // Positions showed USDC and RIFT as mints, and `sell 100% ORE` on a fresh core wasn't a trade).
    // Names learned from Candle are kept: the journal's replay just below names its tokens.
    const symbolOf = (mint: string) => markets.get(mint)?.symbol ?? symbols.get(mint) ?? portfolioSymbol(prices.lastPortfolio()?.result, mint) ?? baseAssetForMint(mint)
    // In words (Activity, the Journal, notices, the bots' rows), a name that could pass for another token's carries its short address.
    const wordName = (mint: string) => tokenLabel(symbolOf(mint), mint)
    const tradeLog = new TradeLog({
      symbolOf,
      onLine: (entry) => {
        publish("activity", { kind: "line", entry })
        publishPortfolio?.()
      },
    })
    for (const row of j.rows()) tradeLog.add(row)
    j.onAppend((row) => tradeLog.add(row))
    // A fill changes the wallet: read it again soon, as the chain settles, rather than at the next
    // 15 s tick (Wallets otherwise missed a swap for between 8 s and 2 minutes).
    j.onAppend((row) =>
      readAfterFill(row, (ms) => {
        setTimeout(() => void prices.refresh().catch(() => {}), ms).unref?.()
      }),
    )
    // P&L: Candle's book per agent, read with its own key inside its budget; the Candle Harness's
    // samples give it a window, since Candle's P&L has none. The window last picked is kept, config.toml's is where a fresh
    // install starts; "since last session" runs from the main view's last close.
    const pnlSamples = new SampleStore(paths.pnlSamples, now)
    pnlSamples.load()
    const savedWindow = readWindowState(paths.pnlWindow)
    let pnlWindow: PnlWindow = savedWindow.window ?? config.pnl.window
    let sessionEnd = lastSessionEnd(j.rows(), { runEnded: true }) ?? savedWindow.sessionEnd
    const pnl: PnlBook = new PnlBook({
      call: async (agent, tool, args, asked) => {
        if (!pool.agents().includes(agent)) return { kind: "error", code: "NO_AGENT", retryable: false, body: {} }
        return (asked ? budget.ask(agent) : budget.take("pnl", agent)) ? pool.for(agent).call(tool, args) : BUDGET_WAIT
      },
      agents: () => [...keys].flatMap(([agent, key]) => (pool.agents().includes(agent) && apiKeyPrefix(key) ? [{ agent, prefix: apiKeyPrefix(key)! }] : [])),
      now,
      samples: pnlSamples,
      wanted: () => s.events.subscriberCount("pnl") > 0,
      sessionEnd: () => sessionEnd,
      window: () => pnlWindow,
      rows: () => j.rows(),
      paper: () => tradeLog.paperBooks(),
      priceOf: (mint) => latest.usd(mint),
      symbolOf,
      stretch: () => budget.stretch("pnl"),
      // Each bot's figures from its own fills: its open positions at the newest price the core holds.
      // Rules bots and code bots alike: each one's count from its own fills.
      bots: () =>
        [...bots.entries(), ...codeBots.entries()].map((b) => {
          const t = botPositions.totals(b.name, b.mode)
          let unrealizedUsd: number | null = null
          let unpriced = 0
          for (const p of botPositions.open(b.name, b.mode)) {
            const price = latest.usd(p.mint) ?? triggerWatch?.latest(p.mint)?.priceUsd ?? undefined
            const up = price !== undefined && price !== null ? botPositions.unrealizedUsd(p, price) : undefined
            if (up === undefined) unpriced++
            else unrealizedUsd = (unrealizedUsd ?? 0) + up
          }
          return { name: b.name, ...("kind" in b && b.kind === "code" ? { kind: "code" as const } : {}), agent: b.agent, mode: b.mode, open: t.open, closed: t.closed, realizedUsd: t.realizedUsd, unrealizedUsd, ...(t.valued ? {} : { unvalued: true as const }), ...(unpriced ? { unpriced } : {}) }
        }),
      publish: () => {
        const view = pnl.view()
        publish("pnl", view)
        triggerWatch?.pnlRead()
        publishStatus?.()
        nameMints(view.agents.flatMap((a) => [...(a.book?.crossed ?? []), ...(a.book?.positions ?? [])].filter((r) => !r.symbol).map((r) => r.mint)).concat(view.trades.filter((t) => !t.symbol).map((t) => t.mint)))
      },
    })
    budget.want("pnl", { perMin: () => pnl.demand().perMin, floor: () => pnl.demand().agents, naturalMs: () => pnl.paceMs() })
    // A fill moves the books (a sell can move a round from one agent's book to another's); a paper trade, the paper book.
    j.onAppend((row) => {
      if (row.type === "operation.succeeded") pnl.afterFill(typeof row.agent === "string" ? row.agent : undefined)
      else if (row.type === "paper.call") publish("pnl", pnl.view())
    })
    // A trade, swap or close from a TEE wallet settled: its empty accounts are counted again.
    j.onAppend((row) => {
      if (row.type !== "operation.succeeded" || typeof row.opId !== "string") return
      const op = operations.get(row.opId)
      const argv = Array.isArray(op?.params.argv) ? (op.params.argv as unknown[]) : []
      const flag = argv.indexOf("--wallet")
      const address = op?.wallet ?? (flag >= 0 && typeof argv[flag + 1] === "string" ? (argv[flag + 1] as string) : undefined)
      if (address) emptyAccounts.afterSettle(address)
    })
    /** The window's figure as the status bar and the kill report show it. */
    // `window` too: a view off the P&L tab holds no `pnl` topic, so a typed `pnl 24h` would read a stale one.
    const pnlFigure = () => {
      const f = pnl.figure()
      return { window: pnlWindow, usd: f.usd, label: f.label, from: f.from, short: f.short, ...(f.unpriced !== undefined ? { unpriced: f.unpriced } : {}) }
    }
    // Research's reads follow the link, told once they exist below.
    let lastResearched = ""
    let pokeResearch: (() => void) | undefined
    const tokenWatch: TokenWatch = new TokenWatch({
      // A market read is the same for any key, so it goes to the key with most room. A read
      // someone asked for (a pick, a token the agent showed) never waits; the pane's own samples may.
      call: async (tool, args, read) => {
        if (!anyAgent()) return { kind: "error", code: "NO_AGENT", retryable: false, body: {} }
        const agent = read === "asked" ? budget.ask() : budget.take(read)
        return agent ? noted(tool, await pool.for(agent).call(tool, args)) : BUDGET_WAIT
      },
      stretch: (kind) => budget.stretch(kind),
      // Hacc's last hour of the followed token, with the first key Hacc takes: it reads the
      // account, not the key. Off, or with no such key, the chart is the core's own samples.
      history: async (chain, mint, from) => {
        if (!config.hacc.enabled) return { kind: "refused", words: "Hacc is off in this Candle Harness's config ([hacc] enabled = false)." }
        const { route, query } = historyRequest(chain, mint, from)
        // A key Hacc refuses is the key's answer, not the token's: the next agent's goes at once, as Research's
        // reads do (otherwise a fresh core's first read could go to a refused key, and the chart wait a minute).
        let refusal: string | undefined
        for (const agent of new Set([anyAgent(), ...keys.keys()])) {
          if (agent === undefined || !haccOffered(agent)) continue
          const answer = await hacc.get(agent, route, query)
          if (answer.kind === "ok") return { kind: "ok", body: answer.body }
          refusal = answer.message
          if (answer.code !== "HACC_KEY_REFUSED" && answer.code !== "HACC_NO_KEY") break
        }
        if (refusal !== undefined) return { kind: "refused", words: refusal }
        return { kind: "refused", words: keys.size === 0 ? "no agent has a key yet." : "Hacc refused every agent's key (see the doctor)." }
      },
      now,
      trending: () => feeds.trending(),
      // Hacc's market read of a Hood token, for its safety fields (Candle's forensics doesn't read Hacc there): the first
      // agent whose key Hacc answers, as the history's; with no key Hacc's plan admits, it says the check needs Pro.
      haccMarket: async (chain, address) => {
        if (!config.hacc.enabled) return { kind: "refused", words: "Hacc is off in this Candle Harness's config" }
        let refusal: string | undefined
        let offered = false
        let keyRefused = false
        for (const agent of new Set([anyAgent(), ...keys.keys()])) {
          // Hacc's market read is Pro and Max: a Free key isn't asked, nor one Hacc has refused.
          if (agent !== undefined && hacc.keyRefused(agent)) keyRefused = true
          if (agent === undefined || !haccOffered(agent) || plans.planFor(agent).plan === "free") continue
          offered = true
          const answer = await hacc.get(agent, `/v1/market/token/${address}`, { chain })
          if (answer.kind === "ok") return { kind: "ok", body: answer.body }
          refusal = answer.message
          if (answer.code !== "HACC_KEY_REFUSED" && answer.code !== "HACC_NO_KEY") break
        }
        // A key Hacc refused isn't a plan's limit: said as the history's line says it.
        if (!offered) return { kind: "refused", words: keyRefused ? "Hacc refused every agent's key" : "Hacc's check needs a Pro or Max plan" }
        return { kind: "refused", words: refusal ?? "no answer" }
      },
      publish: (view) => {
        publish("market", view)
        budget.check() // a token linked or pinned changes what the key's budget plans
        // The views topic says where the link is and who moved it, when that changes.
        const f = view.followed
        const link = f ? `${f.chain}:${f.mint}:${f.by ?? ""}` : ""
        if (link !== lastLink) {
          lastLink = link
          publishViews()
        }
        // Research follows the link: a new token's reads start, the old one's stop.
        const token = f ? `${f.chain}:${f.mint}` : ""
        if (token !== lastResearched) {
          lastResearched = token
          pokeResearch?.()
        }
      },
    })
    // The token pane's reads, planned by the key's budget after prices: the linked token, then pins, then the list.
    budget.want("linked", { perMin: () => tokenWatch.demand().linked, naturalMs: SAMPLE_MS })
    budget.want("pins", { perMin: () => tokenWatch.demand().pins, floor: () => tokenWatch.demand().pinCount, naturalMs: SAMPLE_MS })
    // Candle's four lists: each read while a view's `feeds` subscription names it, and
    // On Fire while any view is attached, for the token pane's empty state. Last in the budget's order.
    const feeds: Feeds = new Feeds({
      call: async (tool, args) => {
        if (!anyAgent()) return { kind: "error", code: "NO_AGENT", retryable: false, body: {} }
        const agent = budget.take("lists")
        return agent ? noted(tool, await pool.for(agent).call(tool, args)) : BUDGET_WAIT
      },
      now,
      stretch: () => budget.stretch("lists"),
      chains: () => feedChains(),
      wanted: () => {
        const out = new Set<Bucket>()
        for (const f of s.events.filtersOf("feeds")) for (const b of f === null ? BUCKETS : (f as FeedsFilter).buckets) out.add(b)
        return out
      },
      publish: (view, changed) => {
        for (const list of Object.values(view)) for (const row of list?.rows ?? []) symbols.learn(row.mint, row.symbol)
        publish("feeds", view)
        if (changed === "onfire") publish("market", tokenWatch.view())
        budget.check()
      },
    })
    budget.want("lists", { perMin: () => feeds.demand().perMin, floor: () => feeds.demand().lists, naturalMs: () => feeds.paceMs() })
    // The chains Candle's lists are read on: the account's, under the chain filter. A chain beside Solana's is read at
    // half the pace while all chains show; picked, it takes Solana's pace and Solana's stop. One chain in use: Solana's.
    function feedChains(): FeedChain[] {
      const used = chainsUsed()
      if (used.length < 2) return [{ chain: "solana" }]
      const picked = viewState.chain()
      if (picked && used.includes(picked)) return [{ chain: picked }]
      return used.map((chain) => (chain === "solana" ? { chain } : { chain, slow: true }))
    }
    let feedChainsWere = ""
    /** Candle's lists plan again when the chains they're read on change. */
    const replanFeeds = () => {
      const now = JSON.stringify(feedChains())
      if (now === feedChainsWere) return
      feedChainsWere = now
      feeds.poke()
    }
    // Research, one token in depth: Hacc's reads of the linked token while a view's `research`
    // subscription names a pane, each at most once a minute for each token, with the first agent Hacc is
    // offered to; and Candle's check, the token pane's own, read again every 5 minutes while Check shows.
    const haccReader = () => [anyAgent(), ...keys.keys()].find((a) => a !== undefined && haccOffered(a))
    const research: ResearchReads = new ResearchReads({
      linked: () => {
        const f = tokenWatch.view().followed
        return f ? { mint: f.mint, chain: f.chain, ...(f.symbol ? { symbol: f.symbol } : {}) } : null
      },
      wanted: () => {
        const out = new Set<ResearchPart>()
        for (const f of s.events.filtersOf("research")) for (const p of f === null ? RESEARCH_PARTS : (f as ResearchFilter).parts) out.add(p)
        return out
      },
      hacc: async (_read, route, query, cacheMs) => {
        const agent = haccReader()
        if (!agent) return { kind: "refused", words: "no agent's key reaches Hacc." }
        const answer = await hacc.get(agent, route, query, { cacheMs })
        if (answer.kind === "ok") return { kind: "ok", body: answer.body }
        // The key's refusal, not the read's: another agent's key may answer, so it goes again at once.
        const again = answer.code === "HACC_KEY_REFUSED" || answer.code === "HACC_NO_KEY"
        return { kind: "refused", words: answer.message, ...(again ? { again: true as const } : {}), ...(answer.code === "PLAN_REQUIRED" ? { plan: true as const } : {}) }
      },
      haccCant: () => {
        if (!config.hacc.enabled) return "Hacc's data is off in this Candle Harness's config ([hacc] enabled = false)."
        if (keys.size === 0) return "No agent has a key yet, so Hacc can't be read."
        return haccReader() ? undefined : "Hacc refused every agent's key: candle-harness doctor says how to fix it."
      },
      plan: () => {
        const agent = haccReader()
        return agent ? plans.planFor(agent).plan : undefined
      },
      held: planHeld,
      check: () => tokenWatch.checkRead(),
      recheck: () => tokenWatch.recheck(),
      now,
      publish: (view) => publish("research", view),
    })
    pokeResearch = () => research.poke()
    // The pins and the person's last pick: kept by the core, so every view shows the same.
    const viewState = new ViewState({ path: paths.pinsState, signalsPath: paths.signalsFilters, chainPath: paths.chainFilter, now })
    let lastLink = ""
    const viewsNow = (): ViewsTopic => ({ link: tokenWatch.view().followed, pins: viewState.pins(), signals: viewState.signals(), popped: viewState.popped(), chain: viewState.chain() })
    const publishViews = () => publish("views", viewsNow())
    tokenWatch.setPinned(viewState.pins())
    // The plan is the account's: any agent's status read says it.
    const accountTier = () => [...keys.keys()].map((a) => status.get(a)?.tier).find((t) => t !== undefined)
    const portfolioNow = () => {
      const read = prices.lastPortfolio()
      return portfolioView({
        portfolio: read?.result,
        readAt: read?.readAt ?? null,
        prices: latest,
        symbolOf,
        agents: Object.keys(config.agents).map((name) => {
          const st = status.get(name)
          const key = keys.get(name)
          return { name, ...(st?.wallets.solana ? { wallet: st.wallets.solana } : {}), ...(st?.wallets.evm ? { evmWallet: st.wallets.evm } : {}), ...(st ? { embeddedWallet: st.embeddedWallet } : {}), ...(key ? { prefix: apiKeyPrefix(key) } : {}) }
        }),
        buyers: (mint) => tradeLog.buyers(mint),
        paper: tradeLog.paper(),
        boundTo: (address) => wallets.boundTo(address),
        stopped: stoppedWallets.all(),
        stoppedBalance: (address) => stoppedBalances.get(address),
        names: nameBook(),
        chains: chainsUsed(),
        ...(accountTier() ? { tier: accountTier()! } : {}),
        ...(prices.lastFailure() ? { failed: prices.lastFailure()! } : {}),
      })
    }

    /** Sets which wallets the panes show: checked against the wallets read, kept, journalled and published. */
    const setWalletsShown = async (value: unknown, by: string, agent?: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
      const parsed = parseShown(value)
      if (!parsed.ok) return { ok: false, code: "INVALID_SHOW", message: `show: ${parsed.message}.` }
      const wallets = portfolioNow().wallets
      const unknown = unknownNames(wallets, parsed.shown, groupBook())
      const asked = shownGroup(parsed.shown)
      if (asked !== undefined && unknown.length) {
        const groups = groupBook().map((g) => g.name)
        return { ok: false, code: "UNKNOWN_GROUP", message: `There's no group called ${asked}. ${groups.length ? `The groups: ${groups.join(", ")}.` : "There are no groups yet: make one with harness_group_wallets."}` }
      }
      if (unknown.length) {
        const known = wallets.map((w) => viewName(w))
        return { ok: false, code: "UNKNOWN_WALLET", message: `No wallet named ${unknown.join(", ")}. The account's wallets: ${known.join(", ") || "none read yet"}.` }
      }
      walletsShown = parsed.shown
      await saveShown(paths.walletsShown, walletsShown, now())
      await j.append({ type: "wallets.shown", mode, show: walletsShown, by, ...(agent ? { agent } : {}) })
      publishStatus?.()
      return { ok: true }
    }

    // The journal, before anything listens: operations left in flight are read back, cards left open expire.
    haccChanges.rebuild(j.rows())
    await operations.rebuild(j.rows())
    await cards.expireAfterRestart(j.rows())
    // Staged upload files whose operation can't be re-sent any more: the cards they were for are gone.
    await uploads.sweep(new Set(operations.list().filter((op) => op.state === "unknown" || op.state === "pending").map((op) => op.opId)))

    // Whether this core can show the computer's own notification with no view open: a Mac, or a Linux desktop.
    const notifyNative = opts.notify?.native ?? canNotifyNative(process.platform, opts.env)
    const statusView = () => ({
      coreId,
      account,
      coreVersion: VERSION,
      agents: Object.keys(config.agents).map((name) => {
        const child = keys.has(name) ? pool.agents().includes(name) ? pool.for(name).status() : { state: "starting" } : { state: "no_key" }
        const s = status.get(name)
        return {
          name,
          candle: child.state,
          ...(s ? { embeddedWallet: s.embeddedWallet, wallet: s.wallets.solana } : {}),
          spentTodayUsd: spend.spent(name, now()),
          limits: config.agents[name]!.limits,
          // Every limit on the agent, each naming who enforces it, with each wallet it
          // pays from that trades inside limits.
          limitLines: agentLimitLines(name),
          ...(() => {
            const hold = keyHolds.held(name, now())
            return hold ? { keyHeld: { until: hold.until, why: hold.why } } : {}
          })(),
        }
      }),
      activeAgent,
      // Setup: no agent yet, so nothing reads Candle or Hacc, and nothing trades.
      ...(Object.keys(config.agents).length === 0 ? { setup: true } : {}),
      mode,
      walletsShown,
      paused: paused(),
      typedTrades: config.cards.typedTrades,
      headless: opts.headless,
      pid: process.pid,
      startedAt,
      // The triggers that keep the core up, and keep-awake.
      triggersOn: triggers.keepingUp().length,
      botsOn: botsUp().length,
      // How many run live, whatever the Candle Harness's mode: a bot's mode is its own.
      botsLive: botsUp().filter((b) => b.mode === "live").length,
      keepAwake: keepAwake.view(),
      // How notifications go with no view open, for the doctor.
      notify: { mode: (config.notify ?? DEFAULT_NOTIFY).mode, native: notifyNative },
      // What holds a view-started core up now, in words; a headless core runs until it's stopped.
      holds: holdWords(),
      ...(configSeenMtime !== undefined ? { configSeenMtime } : {}),
      ...(operations.losingNextReply() ? { debugLoseNextReply: true } : {}),
      viewCount: server?.viewCount() ?? 0,
      pricesAgeMs: prices.ageMs() ?? null,
      // Each key's Candle limit and its use over the last minute, and the background reads slowed to fit.
      budget: { keys: budget.use(), pace: budget.pace() },
      // The status bar's exposure, from the last portfolio read; null (shown "—") until there is one.
      // The P&L window's figure: Candle's, from the Candle Harness's samples, naming its window;
      // null (shown "—") before any sample in it, never 0. Always live: paper P&L is the P&L tab's.
      exposureUsd: (() => {
        const read = prices.lastPortfolio()
        return read ? exposureUsd(walletStanding(read.result, latest, [...keys.keys()], (a) => [status.get(a)?.wallets.solana], undefined, chainsUsed())) : null
      })(),
      pnl: pnlFigure(),
    })

    server = new CoreServer({
      socketPath: paths.socket,
      coreVersion: VERSION,
      journal: j,
      redactor,
      tokens,
      tickets,
      now,
      identity: () => ({ coreId, account, agents: Object.keys(config.agents), activeAgent, mode, paused: paused() }),
      admitBot: (bot) => codeBots.admits(bot),
    })
    const s = server
    s.events.provideSnapshot("status", statusView)
    // The `hacc` topic: whether Hacc is on, each agent's plan and whether Hacc takes its key, the
    // stream's state, and the last refusal's words. No keys, and no rows.
    const haccView = () => ({
      enabled: config.hacc.enabled,
      agents: Object.fromEntries(
        [...keys.keys()].map((agent) => {
          const { plan, readAt } = plans.planFor(agent)
          const refused = hacc.keyRefused(agent)
          return [agent, { plan: plan ?? null, planReadAt: readAt ?? null, key: refused ? "refused" : "ok", ...(refused ? { why: refused } : {}) }]
        }),
      ),
      stream: signals.view(),
      lastRefusal: hacc.lastRefusal ?? null,
    })
    // Hacc's signal tape: one socket for every view and agent, opened while anything subscribes
    // to `signals` (or an agent reads the tape) and closed 5 minutes after. Each subscription may filter it.
    const signals = new SignalStream({
      hacc,
      onFrame: (bytes) => usage.streamFrame(bytes),
      agents: () => Object.keys(config.agents).flatMap((agent) => (keys.has(agent) ? [{ agent, key: keys.get(agent)! }] : [])),
      enabled: () => config.hacc.enabled,
      host: opts.haccHost ?? HACC_HOST,
      cursorPath: paths.signalsCursor,
      // A trigger watching the tape or personal signals holds them open as a view's subscription does.
      wanted: () => {
        const need = triggerWatch?.needs() ?? { tape: false, mine: false }
        return { signals: s.events.subscriberCount("signals") > 0 || need.tape, mine: s.events.subscriberCount("signals:mine") > 0 || need.mine }
      },
      filters: () => s.events.filtersOf("signals").filter((f): f is SignalFilter => f !== null),
      publish: (topic, data) => {
        // The stream's own rows (not a filter's read-back, which is older rows for one view) reach the triggers.
        if (!data.for) {
          const rows = data.rows.filter((r): r is SignalRow => !isGap(r))
          if (topic === "signals") void triggerWatch?.onTape(rows).catch(() => {})
          else void triggerWatch?.onMine(rows).catch(() => {})
        }
        return publish(topic, data)
      },
      onState: () => publishHacc?.(),
      record: (entry) => void j.append({ ...entry, type: String(entry.type), mode }).catch(() => {}),
      now,
    })
    // Rules bots read Hacc's full tape, as Hacc's replays do, on a stream of their own: the views and triggers keep the
    // curated one. It's open while a bot enters, and its rows reach only the bots' entries, never a view.
    const botSignals = new SignalStream({
      hacc,
      onFrame: (bytes) => usage.streamFrame(bytes),
      agents: () => Object.keys(config.agents).flatMap((agent) => (keys.has(agent) ? [{ agent, key: keys.get(agent)! }] : [])),
      enabled: () => config.hacc.enabled,
      host: opts.haccHost ?? HACC_HOST,
      cursorPath: paths.botSignalsCursor,
      quality: "all",
      wanted: () => ({ signals: botEntries?.needsTape() ?? false, mine: false }),
      publish: (topic, data) => {
        if (topic === "signals" && !data.for) void botEntries?.onTape(data.rows.filter((r): r is SignalRow => !isGap(r))).catch(() => {})
      },
      onState: () => {},
      record: (entry) => void j.append({ ...entry, type: String(entry.type), mode, tape: "all" }).catch(() => {}),
      now,
    })
    s.events.provideFilter("signals", signalsTopicFilter)
    s.events.provideSnapshot("signals", (_sub, filter) => signals.snapshot(filter as SignalFilter | undefined))
    s.events.provideSnapshot("signals:mine", () => signals.mineSnapshot())
    s.events.onSubscriptionsChanged(() => signals.poke())
    // Triggers' watchers: levels on Candle's market read (not counted toward a key's limit), the tape and
    // personal signals through the stream above, P&L after each read, fills, cards and replays from the journal,
    // and schedules. They run whether or not a view is open.
    /** Run after each heartbeat's reads, before the bots' exits check. */
    const afterBeatHooks: (() => void)[] = []
    triggerWatch = new TriggerWatch({
      book: triggers,
      clock: opts.triggerClock ?? {
        now,
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms)
          timer.unref?.()
          return () => clearTimeout(timer)
        },
      },
      market: async (chain, mint) => {
        const agent = budget.uncountedKey()
        if (!agent) return undefined
        // The panes' prices learn from it; the watcher keeps its own answer itself.
        const outcome = await pool.for(agent).call("candle_get_market", { chain, mint }, { uncounted: true })
        latest.noteMarket(outcome, now())
        return outcome
      },
      positions: () => pnl.agentsView().flatMap((a) => a.book?.positions ?? []),
      walletOf: (agent, wallet, mint) => payWalletOf(agent, wallet, mint)?.address,
      pnlUsd: (window) => {
        const own = window !== undefined ? sinceStart(window, now(), sessionEnd) : undefined
        return (own ? pnl.figure(own) : pnl.figure()).usd
      },
      pnlNow: () => void pnl.readNow().catch(() => {}),
      hacc: (agent, route, query) => (config.hacc.enabled ? hacc.get(agent, route, query) : Promise.resolve({ kind: "refused", code: "HACC_NO_KEY", message: "Hacc is off in this Candle Harness's config ([hacc] enabled = false).", ms: 0 })),
      nameOf: (mint) => wordName(mint),
      needsChanged: () => signals.poke(),
      onChange: () => void publish("triggers", triggers.view()),
      exitTokens: () => botExits?.tokens() ?? [],
      // Not awaited: a sell's answer takes seconds, and the next heartbeat's reads mustn't wait for it.
      afterBeat: async (beat) => {
        for (const hook of afterBeatHooks) hook()
        void botExits?.check(beat).catch(() => {})
      },
    })
    triggers.setWatchInfo((name) => triggerWatch?.info(name))
    // Each bot's book for the Bots tab, at the prices the watcher read: told after each heartbeat while a bot holds
    // a position, and after each of a bot's rows, only when it changed. A backtest is looked up once a definition,
    // and again after a replay ends.
    const backtests = new Map<string, Backtest | null>()
    const backtestOfBot = (definition: Definition): Backtest | undefined => {
      const key = canonicalJson(definition)
      if (!backtests.has(key)) backtests.set(key, backtestFromJournal(j.rows(), definition) ?? null)
      return backtests.get(key) ?? undefined
    }
    codeBook = (name, mode) => {
      const at = now()
      return botBook({
        name,
        mode,
        exit: undefined,
        exitOf: (p) => heldExitsRef?.of(p.id)?.exit,
        positions: botPositions,
        priceOf: (mint) => triggerWatch?.latest(mint)?.priceUsd ?? undefined,
        priceFor: (p) => positionPrice(triggerWatch?.latest(p.mint), Date.parse(p.entryAt), at) ?? undefined,
        unpricedSince: (id) => botExits?.unpricedSince(id),
        symbolOf: (mint) => symbolOf(mint) ?? short(mint),
        lab: false,
        now: at,
      })
    }
    botsTopic = () => {
      // On Free too: a bot held by the plan still holds what it bought, and its sells still run. Its book is the
      // journal's and the prices already read, so it costs no read.
      const v = bots.view()
      const at = now()
      const rows = j.botRows()
      const books = Object.fromEntries(
        v.bots.map((b) => {
          const entry = bots.entry(b.name)
          return [
            b.name,
            botBook({
              name: b.name,
              mode: b.mode,
              exit: entry?.definition.exit,
              positions: botPositions,
              priceOf: (mint) => triggerWatch?.latest(mint)?.priceUsd ?? undefined,
              priceFor: (p) => positionPrice(triggerWatch?.latest(p.mint), Date.parse(p.entryAt), at) ?? undefined,
              unpricedSince: (id) => botExits?.unpricedSince(id),
              symbolOf: (mint) => symbolOf(mint) ?? short(mint),
              skips: botSkips(rows, b.name, at),
              ...(entry && backtestOfBot(entry.definition) ? { backtest: backtestOfBot(entry.definition)! } : {}),
              lab: haccOffered(b.agent) && plans.planFor(b.agent).plan === "max",
              now: at,
            }),
          ]
        }),
      )
      const views = v.bots.map((b) => {
        const held = botExits?.heldSells(b.name) ?? []
        const shared = b.mode === "live" ? botSharedWith(b.agent, b.wallet, b.name) : []
        // The way to a wallet of its own, as its card offered it: where the wallet is shared or asks every time.
        const asks = b.mode === "live" && botPayWallet(b.agent, b.wallet, payChain(b.definition))?.setting.setting === "ask"
        const own = b.mode === "live" && b.state !== "stopped" && (shared.length > 0 || asks) ? ownWalletSteps(b.agent) : []
        return { ...b, ...(held.length ? { sellsHeld: held } : {}), ...(shared.length ? { sharedWith: shared } : {}), ...(own.length ? { ownWallet: own } : {}) }
      })
      return withCode({ ...v, bots: views, books })
    }
    let botsTold = ""
    let botsSoon: ReturnType<typeof setTimeout> | undefined
    /** The kill switch's report following a held bot's positions: set once the kill switch is made. */
    let botsMovedRef: (() => void) | undefined
    const tellBots = () => {
      const topic = botsTopic()
      const said = JSON.stringify(topic)
      if (said === botsTold) return
      botsTold = said
      void publish("bots", topic)
    }
    // A bot changed (a card approved, or narrowed): a buy it asked for under the version before, still waiting for the
    // person, would pay as that version said. It's withdrawn, said to the bot, which asks again under the new one.
    j.onAppend((row) => {
      if (row.type !== "bot.changed" || typeof row.name !== "string") return
      const name = row.name
      void cards
        .withdrawWhere((card) => card.origin.role === "core" && card.origin.bot?.name === name && card.side !== "sell", "bot_changed")
        .catch(() => {})
    })
    j.onAppend((row) => {
      if (row.type === "hacc.replay" || row.type === "hacc.change") backtests.clear()
      // A bot's trade ending (its operation's row names no bot) closes a position and ends an exit under way: said at once.
      const botTrade = row.type.startsWith("operation.") && typeof row.opId === "string" && cards.held(row.opId)?.origin.bot !== undefined
      // A code bot's card made, approved or gone: the Build tab's folder line follows it.
      const codeCard = row.type.startsWith("card.") && typeof row.cardId === "string" && cards.get(row.cardId)?.params.action === "saveCode"
      if (!row.type.startsWith("bot.") && typeof row.bot !== "string" && row.type !== "hacc.replay" && !botTrade && !codeCard) return
      botsSoon ??= setTimeout(() => {
        botsSoon = undefined
        tellBots()
        // The kill report's held bots name what they hold open: it follows a fill.
        botsMovedRef?.()
      }, 250)
    })
    // Each heartbeat's prices reach the Bots tab while any bot, rules or code, holds a position.
    afterBeatHooks.push(() => {
      if ([...bots.entries(), ...codeBots.entries()].some((b) => botPositions.open(b.name).length > 0)) tellBots()
    })
    // A trigger's card that expired with nobody there, for the Triggers overlay's run it now: from the kept rows, then as they come.
    for (const row of j.rows()) triggers.noteRow(row, { quiet: true })
    j.onAppend((row) => triggers.noteRow(row))
    // What a fill filled, for `on fill` triggers: a trade's or swap's agent and the tokens it named (its argv on the CLI route).
    const ADDRESS = { test: (word: string) => familyOfAddress(word) !== undefined }
    const fillOf = (row: JournalRow) => {
      const op = typeof row.opId === "string" ? operations.get(row.opId) : undefined
      if (!op || (op.kind !== "trade" && op.kind !== "swap")) return undefined
      const values = [...Object.values(op.params), ...(Array.isArray(op.params.argv) ? op.params.argv : [])]
      return { agent: op.agent, mints: [...new Set(values.filter((v): v is string => typeof v === "string" && ADDRESS.test(v) && v !== op.wallet))] }
    }
    // A row a trigger's own card or operation caused carries its name, so it never fires that trigger again; one
    // from a turn a trigger woke carries that trigger's, so a woken turn's fill never wakes it again.
    const withTrigger = (row: JournalRow): JournalRow => {
      if (row.trigger !== undefined || typeof row.opId !== "string") return row
      const origin = cards.held(row.opId)?.origin
      const name = origin?.trigger?.name
      if (name) return { ...row, trigger: name }
      return origin?.woken && row.woken === undefined ? { ...row, woken: origin.woken.trigger } : row
    }
    // What a rules bot did, for `on bot` triggers: an entry's or exit's buy or sell filled (live by its card, paper by its
    // own row), or a pause, whoever paused it.
    const botEventOf = (row: JournalRow): BotEventSeen | undefined => {
      // A code bot's own word: what a trigger set as `on bot "<name>" says "<word>"` waits on.
      if (row.type === "bot.event" && typeof row.name === "string" && typeof row.word === "string") {
        return { bot: row.name, what: "says", word: row.word, ...(typeof row.text === "string" ? { text: row.text } : {}), ...(typeof row.agent === "string" ? { agent: row.agent } : {}) }
      }
      if (row.type === "bot.paused" && typeof row.name === "string") {
        return { bot: row.name, what: "paused", ...(typeof row.agent === "string" ? { agent: row.agent } : {}), ...(row.how === "candle" ? { reason: "Candle stopped its key" } : row.how === "agent" ? { reason: `by ${String(row.changedBy ?? row.agent ?? "its agent")}` } : { reason: "by you" }) }
      }
      const origin =
        row.type === "operation.succeeded" && typeof row.opId === "string"
          ? cards.held(row.opId)?.origin.bot
          : row.type === "paper.call" && row.isError !== true && typeof row.bot === "string" && (row.botAct === "entry" || row.botAct === "exit")
            ? { name: row.bot, act: row.botAct, ...(typeof row.botReason === "string" ? { reason: row.botReason } : {}) }
            : undefined
      if (!origin) return undefined
      const args = row.type === "paper.call" ? (row.args as Record<string, unknown> | undefined) : cards.held(String(row.opId))?.params
      const mint = typeof args?.mint === "string" ? args.mint : undefined
      return {
        bot: origin.name,
        what: origin.act === "entry" ? "entered" : "exited",
        ...(typeof row.agent === "string" ? { agent: row.agent } : {}),
        ...(mint ? { mint } : {}),
        ...(origin.reason ? { reason: EXIT_WORDS[origin.reason] ?? origin.reason } : {}),
        ...(row.type === "paper.call" ? { paper: true as const } : {}),
      }
    }
    j.onAppend((row) => void triggerWatch?.onJournal(withTrigger(row), fillOf, botEventOf).catch(() => {}))
    // Candle's lists while a view's `feeds` subscription names them.
    s.events.provideFilter("feeds", feedsTopicFilter)
    s.events.provideSnapshot("feeds", (_sub, filter) => (filter ? feedsTopicFilter.apply(feeds.view(), filter as FeedsFilter) ?? {} : feeds.view()))
    s.events.onSubscriptionsChanged(() => {
      feeds.poke()
      budget.check()
    })
    // Research's reads while a view's `research` subscription names its panes.
    s.events.provideFilter("research", researchTopicFilter)
    s.events.provideSnapshot("research", (_sub, filter) => (filter ? researchTopicFilter.apply(research.view(), filter as ResearchFilter) : research.view()))
    s.events.onSubscriptionsChanged(() => research.poke())
    s.events.provideSnapshot("hacc", haccView)
    // P&L: a subscription reads each book every 60 s, with its fills.
    s.events.provideSnapshot("pnl", () => pnl.view())
    s.events.onSubscriptionsChanged(() => pnl.poke())
    publishHacc = () => publish("hacc", haccView())
    // Both fit one attach message: what's still open or in flight, then the newest that ended.
    s.events.provideSnapshot("cards", (sub) => cards.listWithin(undefined, (c) => sub.role === "view" || c.origin.clientId === sub.clientId))
    s.events.provideSnapshot("operations", (sub) => operations.listWithin(undefined, (op) => sub.role === "view" || cardOwner.get(op.cardId) === sub.clientId))

    // This build's engines (engine/registry.ts); a test registers its own over them.
    const { engines: extraEngines, without, ...engineSeams } = opts.engine ?? {}
    const engines = buildEngines(config, paths, opts.env)
    for (const id of without ?? []) engines.delete(id)
    for (const e of extraEngines ?? []) engines.set(e.id, e)
    const engine = new EngineRunner({
      journal: j,
      redactor,
      mode: () => mode,
      agents: () => new Set(keys.keys()),
      // The account's own wallets: embedded, TEE, linked and the vault's keys; not an address only pinned or named.
      ownEvm: (key) => nameBook().some((e) => e.kind !== "other" && addressKey(e.address) === key),
      tokens,
      disconnectToken: (tokenId) => s.disconnectToken(tokenId),
      publish: (event) => {
        publish("agent", event)
        if (event.type === "ended") void tokenWatch.followReply(event.labelled).catch(() => {})
        // The agent pane's chip shows what the last turn ran on.
        if (event.type === "ended" && event.engine) publish("engine", engineView())
      },
      activity: (data) => publish("activity", data),
      turnsDir: paths.turnsDir,
      homesDir: paths.homesDir,
      configDir: paths.configDir,
      researchDir: (agent) => paths.researchDir(agent),
      shim: opts.shim ?? selfCommand(),
      engines,
      choice: (agent) => engineState.get(agent),
      // The code runner reaches the prompt only where it's offered: on, held here, and not denied.
      tools: (agent) => {
        const t = config.agents[agent]?.tools
        return t && runOn(t.run) && !runPrograms(agent) ? { ...t, run: "off" as const } : t
      },
      preset: (agent) => engineState.preset(agent, config.agents[agent]?.preset).preset,
      skills: (agent) => skillsOf(agent),
      memory: { forTurn: (agent) => memory.forTurn(agent), afterTurn: (agent, turnId) => memory.afterTurn(agent, turnId), longChars: LONG_INDEX_CHARS },
      offers: (agent, tool) =>
        tool === "hacc_lab"
          ? haccOffered(agent) && haccOffer(agent).some((t) => t.name === tool)
          : (tool === "harness_triggers" ? triggers.gate(agent).state === "ok" : tool === "harness_bots" ? bots.gate(agent).state === "ok" : false) && toolAllowed(config.agents[agent]?.tools ?? DEFAULT_TOOLS, tool),
      stepCap: config.engine.stepCap,
      data: (agent) =>
        haccDataLine({
          enabled: config.hacc.enabled && keys.has(agent),
          ...(hacc.keyRefused(agent) ? { keyRefused: hacc.keyRefused(agent)! } : {}),
          plan: plans.planFor(agent).plan,
          held: planHeld.keys(plans.planFor(agent).plan),
          allowed: (name) => toolAllowed(config.agents[agent]?.tools ?? DEFAULT_TOOLS, name),
        }),
      // The token the person picked since the agent's last turn, once.
      context: (agent) => viewState.pickNote(agent),
      didInTurn: (agent, turnId) => {
        const rows = j.rows()
        const start = rows.findLast((r) => r.type === "agent.turn_started" && r.turnId === turnId)
        if (!start) return []
        const done = awayRecords(rows.filter((r) => r.seq >= start.seq), Date.parse(start.at) - 1, Number.POSITIVE_INFINITY, symbolOf)
        const oldestFirst = <T extends { at: string; agent?: string }>(list: T[]) => list.filter((e) => e.agent === agent).reverse()
        return [...oldestFirst(done.trades), ...oldestFirst(done.cards), ...oldestFirst(done.changes)].map((e) => e.text)
      },
      session: (agent) =>
        [
          clockNote(now()),
          sessionNote(tradeLog.sessionTrades(), tradeLog.paper(), { leftOut: tradeLog.sessionLeftOut(), wallets: [walletsNote(wallets.view(), agent, chainsUsed()), stoppedNote(stoppedWallets.all(), agent), autonomyNote(agentAutonomy(agent).wallets, agent, mode)].filter(Boolean).join(" ") || undefined }),
          replayNote(j.rows(), agent, now()),
        ]
          .filter(Boolean)
          .join("\n\n") || undefined,
      env: opts.env,
      ...engineSeams,
    })
    s.events.provideSnapshot("agent", () => engine.snapshot())
    // Each engine's models and sign-in, read in the background: as the core starts,
    // every 10 minutes and when the picker opens, never on a turn's path. A read also gives an engine
    // its default by name (Codex, Grok, Pi), so a turn with none picked says what ran.
    const signedIn = new Map<EngineId, boolean | undefined>()
    const models = new EngineModels(engines, () => harnessEnv(opts.env), now, () => publish("engine", engineView()))
    const readEngine = async (id: EngineId) => {
      if (!engine.lastCheck(id)?.ok) return
      const e = engines.get(id)!
      const [, signed] = await Promise.all([models.read(id, { force: true }), e.signedIn?.(harnessEnv(opts.env)).catch(() => undefined)])
      if (e.signedIn) signedIn.set(id, signed)
    }
    // The engine topic: each agent's choice and what its last turn ran on, and each
    // engine's check, sign-in and default, without the model lists, so it stays small; engine.models
    // lists one engine's on request.
    const engineView = () => ({
      agents: Object.fromEntries(
        Object.keys(config.agents).map((agent) => {
          const last = engine.lastRan(agent)
          const tools = config.agents[agent]?.tools
          const preset = engineState.preset(agent, config.agents[agent]?.preset)
          return [agent, { ...engineState.get(agent), preset: preset.preset, presetFrom: preset.from, ...(last ? { last } : {}), ...(tools ? { tools } : {}) }]
        }),
      ),
      // Whether the code runner can be held here, and if not, why and what fixes it.
      runner: runHold,
      engines: Object.fromEntries(
        [...engines].map(([id, e]) => {
          const list = models.get(id)
          // Without a sign-in check of its own (OpenCode, Pi), an engine is ready once it lists a model.
          const signed = e.signedIn ? signedIn.get(id) : list && !list.error ? list.models.length > 0 : undefined
          const defaultModel = e.defaultModel?.()
          return [
            id,
            {
              label: e.label,
              minVersion: e.minVersion,
              check: engine.lastCheck(id) ?? null,
              capabilities: e.capabilities(process.platform),
              signedIn: signed ?? null,
              ...(e.signIn ? { signIn: e.signIn } : {}),
              ...(e.needsModel ? { needsModel: true } : {}),
              ...(defaultModel ? { defaultModel } : {}),
              modelsReadAt: list?.readAt ?? null,
            },
          ]
        }),
      ),
    })
    s.events.provideSnapshot("engine", engineView)
    // A harness found on a newer major version than its holds were checked on is journalled, once for each
    // version: nothing is blocked or marked, the record says which version ran from when.
    const newerMajorNoted = new Set<string>()
    const noteNewerMajor = (id: EngineId): void => {
      const version = engine.lastCheck(id)?.version
      const checked = engines.get(id)?.checkedVersion
      if (!version || !checked || !newerMajor(version, checked) || newerMajorNoted.has(`${id} ${version}`)) return
      newerMajorNoted.add(`${id} ${version}`)
      if (j.rows().some((r) => r.type === "engine.newer_major" && r.engine === id && r.version === version)) return
      void j.append({ type: "engine.newer_major", mode, engine: id, label: engines.get(id)!.label, version, checked }).catch(() => {})
    }
    // Every engine is checked in the background as the core starts, never on a turn's path, then its list read.
    void Promise.all([...engines.keys()].map((id) => engine.check(id, true).catch(() => undefined))).then(async () => {
      for (const id of engines.keys()) noteNewerMajor(id)
      publish("engine", engineView())
      await Promise.all([...engines.keys()].map((id) => readEngine(id).catch(() => undefined)))
      publish("engine", engineView())
    })
    const modelsTimer = setInterval(() => {
      void Promise.all([...engines.keys()].map((id) => readEngine(id).catch(() => undefined))).then(() => publish("engine", engineView()))
    }, opts.modelsEveryMs ?? MODELS_EVERY_MS)
    modelsTimer.unref?.()

    kill = await KillSwitch.open({
      journal: j,
      mode: () => mode,
      statePath: paths.killState,
      now,
      agents: () => [...keys.keys()],
      cards,
      operations,
      engine,
      spend,
      limitsFor: (agent) => config.agents[agent]?.limits,
      // Only a key allowed the embedded wallet stands on it (else the report would list denied agents): Solana's, and the EVM one.
      walletsOf: (agent) => {
        const payable = wallets.payable(agent)
        return [payable.embedded?.address, payable.embeddedEvm]
      },
      portfolio: () => prices.lastPortfolio(),
      chains: chainsUsed,
      prices: latest,
      keyPrefix: (agent) => apiKeyPrefix(keys.get(agent) ?? ""),
      // Every TEE wallet on the agent's key, either chain: the kill switch's `tee disable <address>` stops a Hood one too.
      teeWallets: (agent) => wallets.payable(agent).tee,
      nameOf: (address, kind, label) => nameOf(address, kind, label),
      pnl: pnlFigure,
      insideLimits: () => autonomyDesk.inside(),
      triggersHeld: () => triggersHeldByPause(),
      // Each bot that enters now: the pause holds its entries, and its exits go on guarding what it holds.
      botsHeld: () =>
        bots.live().map((b) => {
          const open = botPositions.open(b.name).map((p) => symbolOf(p.mint) ?? short(p.mint))
          const guards = open.length ? `its exits still sell, guarding ${open.length === 1 ? `its ${open[0]} position` : `${open.length} open positions (${open.slice(0, 4).join(", ")}${open.length > 4 ? ", …" : ""})`}` : "it holds nothing open"
          return { name: b.name, agent: b.agent, mode: b.mode, open, words: `its entries are held until you resume; ${guards}` }
        }).concat(
          // A code bot whose buys run now: its buys and swaps are held, and it's told; its sells and held exits go.
          codeBots.entries().flatMap((b) => {
            if (!codeBots.runs(b).buys) return []
            const positions = botPositions.open(b.name)
            const open = positions.map((p) => symbolOf(p.mint) ?? short(p.mint))
            const guarded = positions.filter((p) => heldExitsRef?.of(p.id)).length
            const what = open.length === 1 ? `its ${open[0]} position` : `its ${open.length} open positions (${open.slice(0, 4).join(", ")}${open.length > 4 ? ", …" : ""})`
            const holds = !open.length ? "it holds nothing open" : `its sells still go, for ${what}${guarded ? `, and the core's exits guard ${guarded === open.length ? (open.length === 1 ? "it" : "every one") : `${guarded} of them`}` : ""}`
            return [{ name: b.name, kind: "code" as const, agent: b.agent, mode: b.mode, open, words: `its buys and swaps are held until you resume, and it's told; ${holds}` }]
          }),
        ),
      // The bots' skips gathered while paused are journalled before the pause ends, never after it.
      beforeResume: async () => {
        await botEntries?.flush()
      },
      publish: (report) => publish("activity", { kind: "kill.report", report }),
      onChange: () => {
        publishStatus?.()
        tellKill()
      },
    })
    const killSwitch = kill
    botsMovedRef = () => killSwitch.botsMoved()
    // Every connected code bot hears the kill switch go on or off: its buys and swaps held, its sells still going.
    let killTold = kill.paused()
    function tellKill() {
      const paused = killSwitch.paused()
      if (paused === killTold) return
      killTold = paused
      const told = { kind: "kill" as const, paused, words: paused ? "The kill switch is on: your buys and swaps are held until the person resumes; your sells still go." : "The kill switch is off: your buys and swaps run again." }
      for (const b of codeBots.entries()) codeBotDeskTell(b.name, told)
    }
    // Triggers' firing path: each part proposed as the trigger's own, by the core's own client, through its
    // wallet's figures (never as typed, so never typed-instant), in paper mode as its agent's paper trade.
    // What a firing saw, for its cards: the `trigger.fired` row's words, by its id.
    const firedWords = (fireId: string | undefined): { fired?: string } => {
      if (!fireId) return {}
      const row = j.rows().findLast((r) => r.type === "trigger.fired" && r.fireId === fireId)
      return typeof row?.words === "string" ? { fired: row.words } : {}
    }
    /**
     * Candle's breaker for a trigger's trade: a pair Candle's route breaker refuses, and a sell after two failed sells of
     * its token, are refused in words; past the key's pace a buy or swap is refused and a sell waits for the next slot.
     */
    const triggerBreaker = (part: { tool: string; args: Record<string, unknown> }, client: FaceClient) => botTrades.waitForRoom(part, client.agent, (mint) => symbolOf(mint) ?? short(mint))
    const firer = new TriggerFirer({
      book: triggers,
      journal: j,
      send: async (part, client) => {
        await triggerBreaker(part, client)
        // The trigger's own mode, as approved: a live stop stays live while the Candle Harness is on paper.
        const own = modeFor(client, mode)
        const verdict = classify(part.tool, part.args, own)
        if (verdict.class === "refused") throw refused(verdict.code, verdict.reason)
        if (verdict.class === "paper") return { paper: await face.call(client, part.tool, part.args) }
        if (verdict.class !== "card") throw refused("NOT_A_CARD", "A trigger's command is a trade, a sell or a swap.")
        const card = await cards.propose({ client, agent: client.agent, tool: part.tool, args: part.args, params: normaliseForMode(part.tool, part.args, own), kind: verdict.kind, idKey: verdict.idKey, reason: `the trigger "${client.trigger?.name ?? ""}" fired`, ...firedWords(client.trigger?.fireId) })
        const alone = await cards.runWithoutCard(card, client)
        if (alone.ran) return { ...alone.card, instant: alone.ran }
        return cards.get(card.cardId) ?? card
      },
      card: (cardId) => cards.get(cardId),
      operation: (opId) => operations.get(opId),
      paused: () => killSwitch.paused(),
      nameOf: (mint) => symbolOf(mint),
      wake: (t, r, cause, fireId) => waker.wake(t, r, cause, fireId),
    })
    // Waking an agent: a turn treated like the person's message, capped per agent, held by the pause.
    const waker = new Waker({
      journal: j,
      mode: () => mode,
      now,
      runner: engine,
      caps: wakeCaps,
      paused: () => killSwitch.paused(),
    })
    triggerFirer = firer
    triggers.setFirer((t, cause, fireId) => firer.fire(t, cause, fireId))
    /** A bot's trade, as its own, by its own client, in the bot's mode (bot-trades.ts). */
    const sendAsBot = (trade: { tool: string; args: Record<string, unknown> }, given: FaceClient, botMode: "paper" | "live", reason: string) => botTrades.send(trade, given, botMode, reason)
    // Code bots' requests (bot-protocol.ts): each with the bot's own id, recorded before it's proposed, as the bot's own
    // through the same seam as rules bots, held to its card's figures. Told to the bot's own connection.
    const tellBot = (name: string, told: BotTold) => {
      for (const c of s.clients()) if (c.role === "bot" && c.bot === name) publish("bot", told, c.clientId)
    }
    codeBotDeskTell = tellBot
    // The exits the core holds on code bots' positions, from the journal: set on a buy, by the bot, or removed by the person.
    const heldExits = new HeldExits()
    for (const row of j.botRows()) heldExits.note(row)
    j.onAppend((row) => heldExits.note(row))
    heldExitsRef = heldExits
    const desk = new CodeBotDesk({
      codeBots,
      positions: botPositions,
      journal: j,
      now,
      paused: () => killSwitch.paused(),
      room: (agent, mint, side, label) => botTrades.room(agent, mint, side, label),
      failed: failedSells,
      send: (trade, client, botMode, reason, check) => botTrades.send(trade, client, botMode, reason, check),
      // "embedded" is the embedded wallet on the position's own chain: a Hood position's is the EVM one.
      holding: (agent, wallet, mint, chain) => {
        const address = wallet === "embedded" ? botPayWallet(agent, "embedded", chain)?.address : wallet
        return address ? holdingNow(agent, address, mint) : Promise.resolve("unreadable" as const)
      },
      wrongChain: (agent, wallet, chain) => {
        const r = botPayer(agent, wallet, chain)
        return r && !r.ok && r.code === "WRONG_CHAIN" ? r.message : undefined
      },
      decimalsOf: (mint) => decimalsIn(prices.lastPortfolio()?.result, mint) ?? triggerWatch?.latest(mint)?.decimals,
      byAmount: (wallet, mint) => wallet !== "embedded" || triggerWatch?.latest(mint)?.decimals !== undefined,
      market: async (chain, mint) => {
        const agent = budget.uncountedKey()
        if (!agent) return undefined
        const outcome = await pool.for(agent).call("candle_get_market", { chain, mint }, { uncounted: true })
        latest.noteMarket(outcome, now())
        triggerWatch?.noteMarket(outcome)
        return outcome
      },
      card: (cardId) => cards.get(cardId),
      nameOf: (mint) => symbolOf(mint),
      tell: tellBot,
      heldExits: (position) => heldExits.of(position),
      exitUnderWay: (position) => botExits?.selling(position) ?? false,
    })
    await desk.rebuild(j.botRows())
    j.onAppend((row) => desk.note(row))
    codeBotDesk = desk
    s.events.provideSnapshot("bot", (sub) => {
      const name = s.clients().find((c) => c.clientId === sub.clientId)?.bot
      return name ? { kind: "snapshot", state: desk.stateNow(name) ?? null, open: desk.open(name), paused: killSwitch.paused() } : null
    })
    // Rules bots' entries: each bot's definition matched on its own full tape, and each buy proposed as the bot's own,
    // by its own client, through its wallet's figures (never typed-instant). The decision is journalled first.
    const entries = new BotEntries({
      bots: { live: () => bots.live(), onSince: (name) => bots.stateOf(name)?.onSince, setLastSignal: (name, signal) => bots.setLastSignal(name, signal) },
      positions: botPositions,
      journal: j,
      clock: opts.triggerClock ?? {
        now,
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms)
          timer.unref?.()
          return () => clearTimeout(timer)
        },
      },
      mode: () => mode,
      market: async (chain, mint) => {
        const agent = budget.uncountedKey()
        if (!agent) return undefined
        const outcome = await pool.for(agent).call("candle_get_market", { chain, mint }, { uncounted: true })
        latest.noteMarket(outcome, now())
        triggerWatch?.noteMarket(outcome)
        return outcome
      },
      hacc: (agent, route, query) => (config.hacc.enabled ? hacc.get(agent, route, query) : Promise.resolve({ kind: "refused", code: "HACC_NO_KEY", message: "Hacc is off in this Candle Harness's config ([hacc] enabled = false).", ms: 0 })),
      spendable: (agent, wallet, chain, market) => {
        // "embedded" is the embedded wallet on the token's chain: the EVM one for a Hood token.
        const ctx = wallet === "embedded" ? payerContextFrom(walletsTopic(), agent, chain) : undefined
        const payer = ctx ? resolvePayer(ctx, "embedded") : undefined
        const address = wallet === "embedded" ? (payer?.ok ? payer.address : undefined) : wallet
        const w = address === undefined ? undefined : portfolioNow().wallets.find((x) => sameAddress(x.address, address))
        // A wallet on another chain holds nothing a buy here spends; the trade's own payer check refuses it.
        if (!w || w.chain !== chain) return undefined
        const entry = maybeChain(chain)
        // The asset a bot's dollar buy spends, as sizing.ts settles it: a Candle-launched token's own pair asset; else
        // the configured spend asset on Solana, the native asset elsewhere.
        const settled = settlementAsset({ chain, ...market }, entry?.family === "solana" && !market.candleLaunched ? config.trade.spendAsset.toLowerCase() : undefined)
        const asset = "asset" in settled ? settled.asset : undefined
        if (asset === undefined) return undefined
        if (asset === entry?.native.symbol) return typeof w.native?.usd === "number" ? { usd: w.native.usd, asset } : undefined
        // Another asset (USDC as the spend asset): its token row, or none of it where the tokens were read whole.
        if (w.tokens === null) return undefined
        const held = w.tokens.find((t) => baseAssetForMint(t.mint) === asset)
        if (!held) {
          // A row Candle sent without its amount or decimals (or a list cut short) isn't none of it.
          const mint = isBaseAsset(asset) ? (BASE_ASSETS[asset].address ?? BASE_ASSETS[asset].priceKey) : undefined
          const read = prices.lastPortfolio()?.result
          return mint !== undefined && read !== undefined && holdingFrom(read, w.address, mint) === "unreadable" ? undefined : { usd: 0, asset }
        }
        return held.usd === null ? undefined : { usd: held.usd, asset }
      },
      feeBps: (agent) => status.get(agent)?.feeBps ?? FALLBACK_FEE_BPS,
      // The payer's own words, only where it says the wallet is on another chain: an unread wallet isn't skipped here.
      wrongChain: (agent, wallet, chain) => {
        const r = botPayer(agent, wallet, chain)
        return r && !r.ok && r.code === "WRONG_CHAIN" ? r.message : undefined
      },
      paused: () => killSwitch.paused(),
      send: (trade, client, botMode) => sendAsBot(trade, client, botMode, `the bot "${client.bot?.name ?? ""}" entered on a signal`),
      breaker: { entry: (agent, mint, label) => botTrades.entryRoom(agent, mint, label) },
      card: (cardId) => cards.get(cardId),
      nameOf: (mint) => wordName(mint),
      needsChanged: () => botSignals.poke(),
    })
    coreReserveOf = (agent) => (bots.keepingUp().some((b) => b.agent === agent) ? Math.max(0, PACE_TRADES - tradePace.used(agent, now())) * CORE_TRADE_REQUESTS : 0)
    // What each bot decided and what's still under way, from the journal; then each row as it comes.
    const botRowsAtStart = [...j.botRows()]
    j.onAppend((row) => entries.note(row))
    await entries.rebuild(botRowsAtStart)
    botEntries = entries
    entries.refresh()
    // Rules bots' exits: each open position against its bot's exits after every heartbeat of the triggers' watcher,
    // sold as the bot's own, with no card on any wallet. The decision is journalled first.
    const exits = new BotExits({
      bots: {
        exiting: () => bots.entries().flatMap((b) => (bots.runs(b).exits ? [{ bot: b, definition: bots.approvedVersion(b.name)?.definition ?? b.definition }] : [])),
        slippage: (name) => bots.approvedSlippage(name),
      },
      // A code bot's held exits run while its sells do: paused, crashed or not connected, and through the kill switch.
      held: {
        // A Build pane's paper test too, while it runs: a test of a bot that leans on held exits shows them sell.
        exiting: () => [...codeBots.entries(), ...codeBots.testEntries()].filter((b) => codeBots.runs(b).sells),
        exitOf: (position) => heldExits.of(position)?.exit,
        slippage: (name) => codeBots.approvedVersion(name)?.run.maxSlippageBps,
        busy: (position) => desk.sellUnderWay(position),
      },
      positions: botPositions,
      journal: j,
      clock: opts.triggerClock ?? { now },
      mode: () => mode,
      reading: (mint) => triggerWatch?.latest(mint),
      // A position's wallet is "embedded" or a TEE wallet's address; the portfolio read names the embedded one by its
      // address, on the position's own chain: a Hood position's is the EVM embedded wallet, never the Solana one.
      holding: (agent, wallet, mint, chain) => {
        const address = wallet === "embedded" ? botPayWallet(agent, "embedded", chain)?.address : wallet
        return address ? holdingNow(agent, address, mint) : Promise.resolve("unreadable" as const)
      },
      decimalsOf: (mint) => decimalsIn(prices.lastPortfolio()?.result, mint),
      failed: failedSells,
      breaker: { exit: (agent, mint, label) => botTrades.exitRoom(agent, mint, label) },
      send: (trade, client, botMode, reason) => sendAsBot(trade, client, botMode, reason),
      card: (cardId) => cards.get(cardId),
      nameOf: (mint) => wordName(mint),
    })
    j.onAppend((row) => exits.note(row))
    await exits.rebuild(botRowsAtStart)
    botExits = exits
    bots.setFlattener(async (b, by) => ({ said: exits.flatten(b, { how: by.how, ...(by.agent ? { agent: by.agent } : {}) }).said }))
    bots.setSellsNow((name, was, next) => exits.wouldSell(name, was, next))
    codeBots.setFlattener((b, by) => ({ said: exits.flatten({ name: b.name, kind: "code", agent: b.agent }, { how: by.how, ...(by.agent ? { agent: by.agent } : {}) }).said }))
    // The report stays pinned until resume: a view attaching later gets it in the snapshot.
    s.events.provideSnapshot("activity", () => ({ killReport: killSwitch.current() ?? null, lines: tradeLog.activity().slice(-50) }))
    s.events.provideSnapshot("portfolio", portfolioNow)
    s.events.provideSnapshot("market", () => tokenWatch.view())
    s.events.provideSnapshot("views", viewsNow)
    // The agent's changes to the screen: asked of the main view the person last used.
    const viewAsks = new ViewAsks({
      listening: () => s.clients().filter((c) => c.role === "view" && s.events.topicsOf(c.clientId).includes("asks")).map((c) => c.clientId),
      publish: (data, clientId) => publish("asks", data, clientId),
      now,
    })
    // Notifications: to the main view the person last used, which sends them while it isn't focused; with none
    // open, the core shows them itself where the machine can.
    const isPersonView = (c: { role: string; clientName: string }) => c.role === "view" && !c.clientName.includes("--pane") && !OBSERVER_CLIENTS.has(c.clientName)
    const notifySettings = config.notify ?? DEFAULT_NOTIFY
    const notifier = new CoreNotifier({
      settings: notifySettings,
      now,
      target: () => viewAsks.latest(s.clients().filter((c) => isPersonView(c) && s.events.topicsOf(c.clientId).includes("notices")).map((c) => c.clientId)),
      publish: (data, clientId) => publish("notices", data, clientId),
      waiting: (cardId) => cards.get(cardId)?.state === "awaiting_approval",
      origin: (opId) => tradeLog.originOfOp(opId),
      symbolOf: (mint) => wordName(mint),
      native: opts.notify?.native ?? (process.env.NODE_ENV !== "test" && notifyNative),
      platform: process.platform === "darwin" ? "darwin" : "linux",
      spawn:
        opts.notify?.spawn ??
        (async (argv) => {
          const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
          const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
          return { exitCode, stderr }
        }),
      journal: { append: (r) => j.append({ ...r, mode }) },
      ...(opts.notify?.quietMs !== undefined ? { quietMs: opts.notify.quietMs } : {}),
    })
    j.onAppend((row) => notifier.row(row, tradeLog.lineFor(row.seq)?.text))
    s.events.provideSnapshot("notices", () => ({ settings: notifySettings }))
    askView = async (client, args) => {
      // A pin of a token the pane doesn't show yet moves the link to it first, as the agent showing it would.
      if (args.action === "pin" && args.mint !== undefined) {
        const mint = mintParam(args.mint)
        if (!mint) return { ok: false, code: "MCP_VALIDATION", message: "mint is a token's address." }
        const v = tokenWatch.view()
        if (v.followed?.mint !== mint && !v.pinned?.some((p) => p.mint === mint)) {
          // The chain the agent names wins; with none, its address's family's (the request's edge).
          let chain: ChainSlug | undefined
          try {
            chain = requestChain(mint, args.chain)
          } catch (e) {
            return { ok: false, code: "UNKNOWN_CHAIN", message: (e as Error).message }
          }
          if (!chain || !isAddressOn(chain, mint)) return { ok: false, code: "MCP_VALIDATION", message: chain ? `That address isn't one on ${chainName(chain)}.` : "mint is a token's address." }
          const outcome = await tokenWatch.link(mint, chain, "agent")
          if (outcome === "base") return { ok: false, code: "BASE_ASSET", message: "That's what trades spend, so a token pane doesn't follow it." }
          if (outcome === "no-market") return { ok: false, code: "NO_MARKET", message: "Candle has no market for that token, so it can't be pinned." }
        }
      }
      const answer = await viewAsks.ask(client.agent, args)
      if (answer.ok && answer.words) await j.append({ type: "view.changed", mode, agent: client.agent, clientId: client.clientId, action: String(args.action), words: answer.words })
      return answer
    }
    s.events.provideSnapshot("wallets", () => walletsTopic())
    publishStatus = () => {
      publish("status", statusView())
      // Each wallet's setting and today's use without a card change with the status.
      publish("autonomy", autonomyDesk.view())
    }
    // What each agent can pay from joins the key's reads to the portfolio, so it's sent with it.
    publishPortfolio = () => {
      // A default found once the names it uses are read (the portfolio's labels can follow the key's rows).
      wallets.pinDefaults()
      publish("portfolio", portfolioNow())
      publish("wallets", walletsTopic())
      publish("autonomy", autonomyDesk.view())
      replanFeeds()
    }

    // Naming wallets: one name per wallet, kept where it's owned. The whole ask is checked first (planRenames). The Candle Harness's own
    // names are written to wallets.toml at once; Candle's and the vault's are renamed where they're kept, in the
    // pane: typed, it opens at once; from the agent, it's a card. A batch goes as one `--pairs-from` run, its file
    // written by the core. Cards, hashes and argv keep naming wallets by address: a name is only looked up.
    let lastNamed: { changeId: string; agent?: string; words: string; rows: { address: string; name: string; was?: string }[]; at: number } | undefined
    let lastGrouped: { changeId: string; agent?: string; words: string; group: string; was?: GroupDefKept; at: number } | undefined
    // Each agent's Hood chip, where it's offered.
    const hoodWalletsOffered = (): { hoodWallet?: Record<string, Fill> } => {
      const offered = [...keys.keys()].flatMap((agent) => {
        const step = hoodWalletFor(agent)
        return step ? [[agent, step] as const] : []
      })
      return offered.length ? { hoodWallet: Object.fromEntries(offered) } : {}
    }
    const walletsTopic = () => ({
      ...wallets.view(),
      ...hoodWalletsOffered(),
      empty: emptyAccounts.view(),
      ...(lastNamed ? { named: { changeId: lastNamed.changeId, words: lastNamed.words, at: lastNamed.at, ...(lastNamed.agent ? { agent: lastNamed.agent } : {}) } } : {}),
      ...(lastGrouped ? { grouped: { changeId: lastGrouped.changeId, words: lastGrouped.words, at: lastGrouped.at, ...(lastGrouped.agent ? { agent: lastGrouped.agent } : {}) } } : {}),
    })
    const renameAsks = (params: Record<string, unknown>): { wallet: string; name: string }[] | undefined => {
      const list = Array.isArray(params.names) ? params.names : typeof params.wallet === "string" && typeof params.name === "string" ? [{ wallet: params.wallet, name: params.name }] : undefined
      if (!list || list.length === 0 || list.length > 256) return undefined
      if (!list.every((a) => typeof a === "object" && a !== null && typeof (a as { wallet?: unknown }).wallet === "string" && typeof (a as { name?: unknown }).name === "string")) return undefined
      return (list as { wallet: string; name: string }[]).map((a) => ({ wallet: a.wallet, name: a.name }))
    }
    const namesWords = (rows: readonly RenameRow[]) => rows.map((r) => `${walletName(undefined, { address: r.address, kind: r.kind, ...(r.was !== undefined ? { label: r.was } : {}) })} → ${terminalText(r.name, { maxLength: 64 })}`).join(", ")
    const nameWallets = async (
      client: FaceClient,
      asks: { wallet: string; name: string }[],
      opts: { typed: boolean; reason?: string },
    ): Promise<{ ok: true; said: string; opened: unknown[]; cards: CardView[]; changeId?: string } | { ok: false; code: string; message: string }> => {
      const plan = planRenames(asks, nameBook(), Object.keys(config.agents))
      const agent = client.role === "harness" ? client.agent : undefined
      if (!plan.ok) {
        await j.append({ type: "wallets.name.refused", mode, by: client.clientId, role: client.role, ...(agent ? { agent } : {}), code: plan.code, message: plan.message })
        return plan
      }
      // Each default found by address before any name moves, so a rename can't leave one naming no wallet.
      wallets.pinDefaults()
      const harness = plan.rows.filter((r) => r.owner === "harness")
      // A hand edit with a problem is never written over: refused before any pane opens.
      const problem = harness.length ? walletsFile.read().problems[0] : undefined
      if (problem) return { ok: false, code: "WALLETS_FILE_PROBLEM", message: `wallets.toml has a problem (${problem}): fix it before the Candle Harness writes it. Nothing was changed.` }
      const said: string[] = []
      const opened: unknown[] = []
      const cards: CardView[] = []
      for (const path of ["tee rename", "vault rename"] as const) {
        const rows = plan.rows.filter((r) => r.owner === (path === "tee rename" ? "candle" : "vault"))
        if (rows.length === 0) continue
        const renames = rows.map((r) => ({ address: r.address, name: r.name }))
        let args = [rows[0]!.address, rows[0]!.name]
        if (rows.length > 1) {
          await mkdir(paths.renamesDir, { recursive: true, mode: 0o700 })
          const file = join(paths.renamesDir, `${randomBytes(9).toString("base64url")}.txt`)
          await writeFile(file, pairsFile(renames), { mode: 0o600 })
          args = ["--pairs-from", file]
        }
        const r = await cliTool.rename(client, { path, args, renames, preview: rows.length > 1, typed: opts.typed, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) })
        const where = path === "tee rename" ? "Candle" : "the vault"
        if (r.kind === "card") {
          cards.push(r.card)
          said.push(`${namesWords(rows)}: ${where} keeps ${rows.length === 1 ? "that name" : "those names"}, so it's a card for the person, then the pane.`)
        } else {
          opened.push(r.opened)
          said.push(`${namesWords(rows)}: renamed on ${where} in the pane${rows.length > 1 ? ", after its preview" : ""}.`)
        }
      }
      let changeId: string | undefined
      if (harness.length) {
        const w = walletsFile.write(Object.fromEntries(harness.map((r) => [r.address, r.name])))
        if (!w.ok) return { ok: false, code: "WALLETS_FILE_PROBLEM", message: `${w.message} Nothing was changed.` }
        changeId = `wn_${randomBytes(9).toString("base64url")}`
        const words = namesWords(harness)
        lastNamed = { changeId, ...(agent ? { agent } : {}), words, rows: harness.map((r) => ({ address: r.address, name: r.name, ...(r.was !== undefined ? { was: r.was } : {}) })), at: now() }
        await j.append({ type: "wallets.named", mode, by: client.clientId, role: client.role, ...(agent ? { agent } : {}), changeId, names: lastNamed.rows })
        said.push(`${words}${agent ? ": named at once; the person can undo it under your reply." : " (wallets.toml)."}`)
        const stale = staleDefaults(harness)
        if (stale) said.push(stale)
        publishPortfolio?.()
      }
      if (plan.unchanged) said.push(`${plan.unchanged} already had ${plan.unchanged === 1 ? "that name" : "those names"}.`)
      return { ok: true, said: said.join(" "), opened, cards, ...(changeId ? { changeId } : {}) }
    }
    /** The undo of the last naming at once (the agent's, under its reply, or the person's): each name put back as it was. */
    const undoNaming = async (by: string, changeId: unknown): Promise<{ ok: true; said: string } | { ok: false; code: string; message: string }> => {
      if (!lastNamed || lastNamed.changeId !== changeId) return { ok: false, code: "NOTHING_TO_UNDO", message: "That naming is no longer the last one, so it can't be undone here: name the wallet again." }
      const back = Object.fromEntries(lastNamed.rows.map((r) => [r.address, r.was]))
      const w = walletsFile.write(back)
      if (!w.ok) return { ok: false, code: "WALLETS_FILE_PROBLEM", message: w.message }
      const undone = lastNamed
      lastNamed = undefined
      await j.append({ type: "wallets.named", mode, by, role: "view", changeId: `wn_${randomBytes(9).toString("base64url")}`, undo: undone.changeId, names: undone.rows.map((r) => ({ address: r.address, ...(r.was !== undefined ? { name: r.was } : {}), was: r.name })) })
      publishPortfolio?.()
      return { ok: true, said: `Undone: ${undone.words}${undone.agent ? `, as ${undone.agent} named ${undone.rows.length === 1 ? "it" : "them"}` : ""}.` }
    }
    // Wallet groups: a change to one group, checked whole (planGroupChange), then
    // written to wallets.toml at once, the person's or the agent's, with an undo under the agent's reply. A group
    // organises only, so nothing here needs a card.
    const cap = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`
    const groupWallets = async (client: FaceClient, op: GroupOp): Promise<{ ok: true; said: string; changeId: string } | { ok: false; code: string; message: string }> => {
      const agent = client.role === "harness" ? client.agent : undefined
      const file = walletsFile.read()
      const plan = planGroupChange(op, file.groups, nameBook(), Object.keys(config.agents))
      if (!plan.ok) {
        await j.append({ type: "wallets.group.refused", mode, by: client.clientId, role: client.role, ...(agent ? { agent } : {}), group: op.group, code: plan.code, message: plan.message })
        return plan
      }
      const w = walletsFile.writeGroups({ [plan.group]: plan.next })
      if (!w.ok) return { ok: false, code: "WALLETS_FILE_PROBLEM", message: `${w.message} Nothing was changed.` }
      const changeId = `wg_${randomBytes(9).toString("base64url")}`
      lastGrouped = { changeId, ...(agent ? { agent } : {}), words: plan.words, group: plan.group, ...(plan.was ? { was: plan.was } : {}), at: now() }
      await j.append({ type: "wallets.grouped", mode, by: client.clientId, role: client.role, ...(agent ? { agent } : {}), changeId, group: plan.group, words: plan.words, ...(plan.next ? { def: plan.next } : {}), ...(plan.was ? { was: plan.was } : {}) })
      publishPortfolio?.()
      return { ok: true, said: `${cap(plan.words)}${agent ? ": at once; the person can undo it under your reply." : "."}`, changeId }
    }
    /** The undo of the last group change: the group put back as it was, or gone if it was new. */
    const undoGrouping = async (by: string, changeId: unknown): Promise<{ ok: true; said: string } | { ok: false; code: string; message: string }> => {
      if (!lastGrouped || lastGrouped.changeId !== changeId) return { ok: false, code: "NOTHING_TO_UNDO", message: "That change to a group is no longer the last one, so it can't be undone here: change the group again." }
      const undone = lastGrouped
      const w = walletsFile.writeGroups({ [undone.group]: undone.was })
      if (!w.ok) return { ok: false, code: "WALLETS_FILE_PROBLEM", message: w.message }
      lastGrouped = undefined
      await j.append({ type: "wallets.grouped", mode, by, role: "view", changeId: `wg_${randomBytes(9).toString("base64url")}`, undo: undone.changeId, group: undone.group, words: undone.words, ...(undone.was ? { def: undone.was } : {}) })
      publishPortfolio?.()
      return { ok: true, said: `Undone: ${undone.words}${undone.agent ? `, as ${undone.agent} did` : ""}.` }
    }
    /** A group change from a view's params or the agent's tool: one op on one group, or why it isn't one. */
    const groupOpOf = (params: Record<string, unknown>): GroupOp | undefined => {
      const group = typeof params.group === "string" && params.group.length <= 64 ? params.group : undefined
      if (group === undefined) return undefined
      const list = Array.isArray(params.wallets) && params.wallets.length > 0 && params.wallets.length <= 256 && params.wallets.every((w) => typeof w === "string" && w.length <= 128) ? (params.wallets as string[]) : undefined
      if (params.op === "add" || params.op === "remove") return list ? { op: params.op, group, wallets: list } : undefined
      if (params.op === "prefix") return typeof params.prefix === "string" && params.prefix.length <= 64 ? { op: "prefix", group, prefix: params.prefix } : params.prefix === null ? { op: "prefix", group, prefix: null } : undefined
      if (params.op === "delete") return { op: "delete", group }
      return undefined
    }
    /** A rename that finished in the pane: shown at once, and the kept copies follow it by address. */
    const afterRename = async (pane: PaneParams["pane"], words: string[], result: PaneResult): Promise<PaneResult> => {
      const file = words[words.indexOf("--pairs-from") + 1]
      if (words.includes("--pairs-from") && file?.startsWith(paths.renamesDir)) void rm(file, { force: true }).catch(() => {})
      if (result.outcome !== "finished" && result.outcome !== "didnt_finish" && result.outcome !== "pending") return result
      // A rename typed as candle tee rename <wallet> <name>: its wallet found by address or name, as the CLI finds it.
      const typed = (): { address: string; name: string }[] => {
        const [target, next] = positionals(words, valueFlagsOf(words))
        if (target === undefined || next === undefined) return []
        const look = lookupWallet(nameBook(), target)
        return look.kind === "found" ? [{ address: look.entry.address, name: next }] : []
      }
      const renames = pane.renames ?? typed()
      if (result.outcome === "finished" && renames.length) {
        await stoppedWallets.relabel(renames).catch(() => {})
        await destinations.renamed(renames).catch(() => {})
      }
      // Candle holds a TEE or linked wallet's label: read again now, not in up to 15 s, and only while a view is attached.
      if (pane.row === "tee rename") {
        // A rename typed as candle tee rename: each default kept by address before the labels are read again.
        wallets.pinDefaults()
        destinationsReadAt = undefined
        await Promise.all([prices.refresh().catch(() => {}), knownDestinations().catch(() => {}), wallets.refreshAll().catch(() => {})])
      }
      publishPortfolio?.()
      if (result.outcome !== "finished") return result
      const stale = staleDefaults(renames)
      return { ...result, words: `finished in the pane: ${renames.length === 1 ? `${short(renames[0]!.address)} is now ${terminalText(renames[0]!.name, { maxLength: 64 })}` : `${renames.length || "the"} wallets renamed`}, everywhere in the Candle Harness.${stale ? ` ${stale}` : ""}` }
    }

    const faceClient = (call: CallContext): FaceClient => {
      // A pane, a code bot and a Build pane are never clients of cards or tools here (METHOD_ROLES): each has its own methods.
      const role = call.client.role
      if (role !== "view" && role !== "harness") throw refused("FORBIDDEN_FOR_ROLE", `A ${role} may not call this.`)
      return { clientId: call.client.clientId, role, agent: call.agent, ...(call.client.tokenId ? { tokenId: call.client.tokenId } : {}) }
    }
    const own = (call: CallContext, ownerClientId: string | undefined) => call.access !== "own" || ownerClientId === call.client.clientId
    const cardFor = (call: CallContext, cardId: unknown) => {
      const card = typeof cardId === "string" ? cards.get(cardId) : undefined
      if (!card || !own(call, card.origin.clientId)) throw refused("CARD_NOT_FOUND", "No card with that id.")
      return card
    }

    // An agent's allow and deny lists hide Candle's tools and the core's research tools from its
    // engine, whatever the engine: left out of tools.list, and refused when called or proposed anyway.
    // They govern the agent only, never what the person does in a view.
    const hiddenFrom = (call: CallContext, name: unknown): boolean =>
      call.client.role === "harness" && typeof name === "string" && !toolAllowed(config.agents[call.agent]?.tools ?? DEFAULT_TOOLS, name)
    const refuseHidden = (call: CallContext, name: unknown) => {
      if (hiddenFrom(call, name)) throw refused("TOOL_HIDDEN", `${String(name)} is turned off for ${call.agent} in config.toml (agents.${call.agent}.tools), so it isn't offered.`)
    }

    s.handle("core.status", async () => statusView())
    // Totals since the core started, and which background reads are live now: for the
    // resource sampler, which takes the differences a minute apart. Never rows or keys.
    s.handle("core.usage", async () => ({
      ...usage.totals(),
      at: now(),
      reading: {
        lists: feeds.active(),
        stream: signals.snapshot().state,
        pnlPerMin: pnl.demand().perMin,
        research: research.demand(),
        budget: budget.use().map((k) => ({ agent: k.agent, used: k.used, background: k.background })),
      },
    }))
    // `candle-harness stop`: the person's, from a terminal, with no question. It answers with what it stops, then stops.
    s.handle("core.stop", async (_params, call) => {
      const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
      const on = triggers.keepingUp().length
      const running = botsUp().length
      const views = personViews().filter((c) => c.clientId !== call.client.clientId).length
      const open = cards.list().filter((c) => c.state === "awaiting_approval").length
      const stopped = [
        ...(on ? [`${n(on, "trigger")} stopped watching; ${on === 1 ? "it starts" : "they start"} again with the next core`] : []),
        ...(running ? [`${n(running, "bot")} stopped watching, ${running === 1 ? "its" : "their"} positions held as they are; ${running === 1 ? "it starts" : "they start"} again with the next core`] : []),
        ...((supervisor?.runningCount() ?? 0) > 0 ? [`${n(supervisor!.runningCount(), "code bot's process", "code bots' processes")} ended; ${supervisor!.runningCount() === 1 ? "it starts" : "they start"} again with the next core`] : []),
        ...(engine.busy() ? ["an agent's turn was stopped"] : []),
        ...(operations.busy() ? ["a trade or step in flight is read back when the core next starts, and never sent twice"] : []),
        ...(open ? [`${n(open, "card")} waiting expired unapproved`] : []),
        ...(views ? [`${n(views, "open view")} lost ${views === 1 ? "its" : "their"} core: quit ${views === 1 ? "it" : "them"} and start the Candle Harness again`] : []),
        ...(keepAwake.view().active ? ["keep-awake ended, so the Mac can sleep"] : []),
      ]
      // After the answer has gone.
      setTimeout(() => void stop("candle-harness stop"), 50)
      return { pid: process.pid, headless: opts.headless, stopped }
    })
    s.handle("tools.list", async (_params, call) => {
      if (!keys.has(call.agent)) return { tools: [] }
      // harness_triggers and harness_bots, as triggers and bots, are Pro and Max: a Free agent, or one whose plan isn't read yet, isn't offered them.
      const all = [
        ...withOwnPrefix(withReason(offeredTools(pool.for(call.agent).tools())), apiKeyPrefix(keys.get(call.agent) ?? "")),
        cliTool.definition(),
        BRIDGE_TOOL,
        SHOW_WALLETS_TOOL,
        NAME_WALLETS_TOOL,
        GROUP_WALLETS_TOOL,
        VIEW_TOOL,
        ...RESEARCH_TOOLS,
        ...[runPrograms(call.agent)].flatMap((p) => (p ? [runTool(p)] : [])),
        HISTORY_TOOL,
        PNL_TOOL,
        LIMITS_TOOL,
        ...(triggers.gate(call.agent).state === "ok" ? [TRIGGERS_TOOL] : []),
        ...(bots.gate(call.agent).state === "ok" ? [BOTS_TOOL] : []),
        ...[skillTool(skillsOf(call.agent))].filter((t) => t !== undefined),
        ...(haccOffered(call.agent) ? haccOffer(call.agent) : []),
      ]
      return { tools: withScreenNotes(all, !hiddenFrom(call, VIEW_TOOL.name)).filter((t) => !hiddenFrom(call, t.name)) }
    })
    s.handle("tools.call", async (params, call) => {
      // 0.2's tui_* names are still taken for the core's own tools in 0.3.x, never listed (engine/tools.ts).
      const name = canonicalToolName(params.name)
      refuseHidden(call, name)
      const result = await face.call(faceClient(call), name, params.args ?? {}, typeof params.reason === "string" ? params.reason : undefined)
      // The token pane follows a token the agent just asked Candle about, once Candle answered, or a
      // token it read on Hacc, which names it `address` (without it, a Quant turn reading only Hacc
      // left the pane on the trending list), on the chain the call named, else its address's family's.
      const args = params.args as { mint?: unknown; address?: unknown; chain?: unknown } | undefined
      const mint = args?.mint ?? (params.name === "hacc_token" ? args?.address : undefined)
      let readChain: ChainSlug | undefined
      try {
        readChain = typeof mint === "string" ? requestChain(mint, args?.chain) : undefined
      } catch {}
      // An address named for a chain it can't be on (a Solana mint called Hood's) is followed nowhere.
      if (typeof mint === "string" && readChain && isAddressOn(readChain, mint) && !(result as { isError?: boolean }).isError) void tokenWatch.follow(mint, readChain).catch(() => {})
      return result
    })
    // The main view's alone, by what each connection said at hello and can't change: approving a card, a typed
    // trade or candle command, the mode, and resuming after the kill switch. A popped view, the doctor and the sampler are
    // refused; a stop (kill, reject, withdraw) stays open to every view.
    const fromMainView = (call: { client: { clientId: string; clientName: string; role: string } }) =>
      call.client.role === "view" && !call.client.clientName.includes("--pane") && !OBSERVER_CLIENTS.has(call.client.clientName) && !viewState.holdsPane(call.client.clientId)
    const mainViewOnly = (call: { client: { clientId: string; clientName: string; role: string } }, what: string) => {
      if (!fromMainView(call)) throw refused("MAIN_VIEW_ONLY", `${what} is the person's step, from the main window.`)
    }
    // The doctor, the sampler, `stop` and `cards` only look: they change nothing a person set. `ask` still sends its message.
    const onlyLooks = (call: { client: { clientName: string } }) => {
      if (READ_ONLY_CLIENTS.has(call.client.clientName)) throw refused("OBSERVER", "The doctor, the sampler, stop and cards only look: they change nothing.")
    }
    s.handle("cards.propose", async (params, call) => {
      refuseHidden(call, params.tool)
      // A typed trade can run at once (paper, or cards.typedTrades = "instant"), so only the main view types one.
      if (params.typed === true && call.client.role === "view") mainViewOnly(call, "A typed trade")
      const tool = params.tool
      const args = params.args ?? {}
      if (typeof tool !== "string" || tool.length === 0 || tool.length > 64) throw invalidParams("tool must name a tool.")
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw invalidParams("args must be an object.")
      const verdict = classify(tool, args as Record<string, unknown>, mode)
      if (verdict.class === "refused") throw refused(verdict.code, verdict.reason)
      // Setup: nothing trades before an agent and its limits exist.
      if (keys.size === 0) throw refused("NO_AGENT_YET", "There's no agent yet, so nothing can trade: finish setting up first. Nothing was sent.")
      // A view can name another agent (`buy … as swing`); one that isn't configured is refused, never run as the active one.
      let agent = call.agent
      if (call.client.role === "view" && params.agent !== undefined) {
        if (typeof params.agent !== "string" || !keys.has(params.agent)) throw refused("UNKNOWN_AGENT", "No agent by that name has a key.")
        agent = params.agent
      }
      // A trade the user typed in paper mode needs no card: it runs as that agent's paper trade.
      if (verdict.class === "paper" && params.typed === true && call.client.role === "view") {
        return { paper: await face.call({ ...faceClient(call), agent }, tool, args as Record<string, unknown>) }
      }
      if (verdict.class !== "card") throw refused("NOT_A_CARD", `This ${verdict.class === "read" ? "read" : "paper trade"} needs no card: call the tool.`)
      const card = await cards.propose({
        client: { ...faceClient(call), agent },
        agent,
        tool,
        args: args as Record<string, unknown>,
        params: normaliseForMode(tool, args as Record<string, unknown>, mode),
        kind: verdict.kind,
        idKey: verdict.idKey,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      })
      // A trade the user typed is a one-press card unless cards.typedTrades is "instant",
      // when it's approved here, in the same call: the same hash, limits and kill switch apply. A wallet's
      // figures never make "instant" stricter, and a typed instant trade never uses them up.
      const trade = verdict.kind === "trade" || verdict.kind === "swap"
      const typed = params.typed === true && call.client.role === "view" && trade
      if (typed && config.cards.typedTrades === "instant") return { ...card, instant: await cards.approve(call.client.clientId, card.cardId, card.cardHash, "instant") }
      // Otherwise a trade its wallet runs without a card goes now, typed or the agent's: a buy, sell or swap.
      if (trade) {
        const alone = await cards.runWithoutCard(card, { ...faceClient(call), agent })
        if (alone.ran) return { ...alone.card, instant: alone.ran }
      }
      return cards.get(card.cardId) ?? card
    })
    s.handle("cards.list", async (_params, call) => ({ cards: cards.listWithin(undefined, (c) => own(call, c.origin.clientId)) }))
    s.handle("cards.get", async (params, call) => cardFor(call, params.cardId))
    // A view can't claim "instant": that's the core's own approval of a typed trade.
    // Only the core's own paths approve as instant or typed.
    s.handle("cards.approve", async (params, call) => (mainViewOnly(call, "Approving a card"), cards.approve(call.client.clientId, params.cardId, params.cardHash, typeof params.how === "string" && CORE_HOWS.includes(params.how) ? "view" : params.how)))
    s.handle("cards.reject", async (params, call) => cards.reject(call.client.clientId, params.cardId))
    s.handle("cards.withdraw", async (params, call) => cards.withdraw(call.client.clientId, params.cardId))
    s.handle("cards.requote", async (params, call) => cards.requote(call.client.clientId, params.cardId, params.wallet === undefined ? {} : { wallet: params.wallet }))
    s.handle("operations.list", async (_params, call) => ({ operations: operations.listWithin(undefined, (op) => own(call, cardOwner.get(op.cardId))) }))
    s.handle("operations.get", async (params, call) => {
      const op = typeof params.opId === "string" ? operations.get(params.opId) : undefined
      if (!op || !own(call, cardOwner.get(op.cardId))) throw refused("OPERATION_NOT_FOUND", "No operation with that id.")
      return op
    })
    s.handle("operations.resolve", async (params, call) => {
      if (params.action !== "resend" && params.action !== "abandon") throw invalidParams('action is "resend" or "abandon".')
      // A re-send is a send: the main window's, as approving is. Letting go of one is a stop, open to every view but those that only look.
      if (params.action === "resend") mainViewOnly(call, "Re-sending a trade")
      else onlyLooks(call)
      return operations.resolve(call.client.clientId, params.opId, params.action)
    })
    // The undo chip on an Activity line: the person's click, so it runs at once.
    s.handle("hacc.undo", async (params, call) => (onlyLooks(call), haccChanges.undo(call.client.clientId, params.changeId)))
    s.handle("wallets.name", async (params, call) => {
      const asks = renameAsks(params)
      if (!asks) throw invalidParams("names is a list of 1 to 256 { wallet, name }, each a string; or give wallet and name.")
      const named = await nameWallets(faceClient(call), asks, { typed: true })
      if (!named.ok) throw refused(named.code, named.message)
      return { said: named.said, ...(named.opened.length ? { panes: named.opened } : {}), ...(named.changeId ? { changeId: named.changeId } : {}) }
    })
    s.handle("wallets.group", async (params, call) => {
      const op = groupOpOf(params)
      if (!op) throw invalidParams('group is a group\'s name, and op is "add" or "remove" (with wallets, a list of names or addresses), "prefix" (with prefix, or null to drop it) or "delete".')
      const done = await groupWallets(faceClient(call), op)
      if (!done.ok) throw refused(done.code, done.message)
      return { said: done.said, changeId: done.changeId }
    })
    s.handle("wallets.undo", async (params, call) => {
      const undone = typeof params.changeId === "string" && params.changeId.startsWith("wg_") ? await undoGrouping(call.client.clientId, params.changeId) : await undoNaming(call.client.clientId, params.changeId)
      if (!undone.ok) throw refused(undone.code, undone.message)
      return { said: undone.said }
    })
    s.handle("wallets.show", async (params, call) => {
      const set = await setWalletsShown(params.show, call.client.clientId)
      if (!set.ok) throw refused(set.code, set.message)
      return { show: walletsShown }
    })
    // Onboarding: the person's choices are kept in state/onboarding.json; every step
    // that leaves something behind is read back from where it lives, each time, so a resume runs nothing twice.
    const onboarding = new OnboardingStore({ file: paths.onboarding, now })
    const ownerJson = (args: string[]) => candleCli.runExact({ argv: candleCli.finalArgs({ args, json: true, withRpcUrl: false }), json: true }).catch(() => undefined)
    // When setup last read the agent's wallets, which costs 8 of a Free key's 30 requests a minute.
    let setupReadAt = Number.NEGATIVE_INFINITY
    // What the last view read from the CLI and Candle: a step gone past is answered from it at once, and read again after.
    let lastFacts: OnboardingFacts | undefined
    let setSeq = 0
    const onboardingView = async (state: OnboardingState, opts: { fresh?: boolean } = {}): Promise<OnboardingView> => {
      const name = state.agent?.name
      const storedPrefix = name !== undefined && keys.has(name) ? prefixOf(name) : undefined
      // `auth status` runs as the Candle Harness's profile once one is recorded (CANDLE_PROFILE); until then, as the CLI picks,
      // and the machine's profiles are listed so the person can pick.
      const [auth, vault, keysList, profileList] = await Promise.all([
        ownerJson(["auth", "status"]),
        cliTool.vaultState(),
        name !== undefined && !storedPrefix ? ownerJson(["keys", "list"]) : Promise.resolve(undefined),
        candleProfile === undefined ? ownerJson(["profile", "list"]) : Promise.resolve(undefined),
      ])
      let wallet: OnboardingFacts["wallet"] = { state: "unknown" }
      let plan: string | undefined
      if (name !== undefined && storedPrefix) {
        // Not on every step's change: read when an owner step has changed something, and at most every 20 s otherwise.
        // A status read the core made itself counts, such as the one when a new agent's key is loaded, so setup
        // doesn't read the same wallets again a moment later on a key Candle allows 30 requests a minute.
        const lastRead = Math.max(setupReadAt, status.get(name)?.readAt ?? Number.NEGATIVE_INFINITY)
        if (opts.fresh || status.get(name) === undefined || now() - lastRead >= SETUP_READ_EVERY_MS) {
          setupReadAt = now()
          await wallets.refresh(name).catch(() => {}) // its status read first, then its TEE wallets
        }
        const payable = wallets.payable(name)
        const tee = payable.tee.filter((w) => w.active !== false)
        const count = (payable.embedded ? 1 : 0) + tee.length
        // The fund step's wallet: the embedded wallet first, as the default.
        const first = payable.embedded ? { address: payable.embedded.address, kind: "embedded" as const, name: nameOf(payable.embedded.address, "embedded") } : tee[0] ? { address: tee[0].address, kind: "tee" as const, name: nameOf(tee[0].address, "tee", tee[0].label) } : undefined
        const read = status.get(name)
        plan = read?.tier
        wallet = count > 0 ? { state: "payable", count, ...first } : read ? { state: "none", ...(read.embeddedWallet === "denied" ? { embedded: "denied" as const } : {}) } : { state: "unknown" }
      }
      const profiles = profilesFrom(profileList ? { exitCode: profileList.exitCode, json: profileList.json } : undefined)
      const facts: OnboardingFacts = {
        signIn: signInFrom(auth ? { exitCode: auth.exitCode, json: auth.json, stderr: auth.stderr } : undefined),
        ...(candleProfile ? { profile: candleProfile } : {}),
        ...(profiles ? { profiles } : {}),
        vault,
        key: keyFrom({ ...(state.agent ? { agent: state.agent } : {}), ...(storedPrefix ? { storedPrefix } : {}), heldPrefixes: new Set(agentPrefixes().values()), keysList: keysList ? { exitCode: keysList.exitCode, json: keysList.json } : undefined }),
        wallet,
        ...(plan ? { plan } : {}),
        ...(vault === "present" ? vaultKeyOf() : {}),
        ...(keyRefused && !storedPrefix ? { keyRefused } : {}),
        ...(mode === "paper" && pickedPaper() ? { keepsPaper: true as const } : {}),
      }
      lastFacts = facts
      const view = onboardingProgress(state, facts)
      // Setup's end is marked once, the first time it's read as done, so a quit after it opens the Candle Harness.
      const finished = withFinished(state, view, now())
      if (finished) {
        await onboarding.write(finished)
        await j.append({ type: "onboarding.changed", mode, change: "finished", by: "core" })
        // Setup ends on the agent it made: a later run's second agent is the one you just set up.
        const made = finished.agent?.name
        if (made !== undefined && Object.hasOwn(config.agents, made) && made !== activeAgent) {
          activeAgent = made
          await j.append({ type: "agent.active", mode, agent: made, by: "setup" })
          await saveAgent(paths.activeState, made, now()).catch(() => {})
          publishStatus?.()
        }
        return { ...view, state: finished }
      }
      return view
    }
    const publishOnboarding = async (opts: { fresh?: boolean } = {}) => publish("onboarding", await onboardingView(await onboarding.open(), opts))
    // Records the profile the Candle Harness acts as: config.toml first, so a restart keeps it, then every run.
    const useProfile = async (profile: string, by: string): Promise<void> => {
      const recorded = await recordProfile(paths, profile)
      if (!recorded.ok) throw refused("PROFILE_NOT_RECORDED", `${recorded.why}. Nothing changed.`)
      candleProfile = profile
      sawConfig()
      await j.append({ type: "onboarding.profile", mode, profile, wrote: recorded.wrote, by })
    }
    // `again` is the person's `candle-harness setup`: once the last run finished, it starts a new one, for another agent.
    s.handle("onboarding.get", async (params, call) => {
      const straightIn = params.straightIn === true
      const view = await onboardingView(await onboarding.open({ straightIn }))
      if (params.again !== true || view.at !== "done") return view
      const fresh = freshState(now(), straightIn)
      await onboarding.write(fresh)
      await j.append({ type: "onboarding.changed", mode, change: "again", by: call.client.clientId })
      return onboardingView(fresh)
    })
    s.handle("onboarding.set", async (params, call) => {
      const change = changeFrom(params)
      if ("problem" in change) throw invalidParams(change.problem)
      // An agent's name must be free: onboarding makes a new agent, never takes one that's configured.
      if ("agent" in change && Object.hasOwn(config.agents, change.agent) && !keys.has(change.agent)) throw refused("AGENT_EXISTS", `${change.agent} is already in config.toml: pick another name.`)
      if ("passed" in change && change.passed === "engine" && !testedOn(await onboarding.open())) throw refused("NOT_TESTED", "Send the test message on the engine and model you picked first.")
      // "Use this account": a profile on this machine, recorded in config.toml.
      if ("profile" in change) {
        mainViewOnly(call, "Picking the Candle account")
        const listed = profilesFrom(await ownerJson(["profile", "list"]).then((r) => (r ? { exitCode: r.exitCode, json: r.json } : undefined)))
        if (!listed?.some((r) => r.name === change.profile)) throw refused("NO_SUCH_PROFILE", `The CLI has no profile named ${change.profile} on this machine. Nothing changed.`)
        await useProfile(change.profile, call.client.clientId)
      }
      let next: OnboardingState
      if ("back" in change) {
        const back = stepBack(await onboardingView(await onboarding.open()), now())
        if ("problem" in back) throw refused("NOTHING_TO_GO_BACK_TO", back.problem)
        next = back.state
      } else next = applyChange(await onboarding.open(), change, now())
      await onboarding.write(next)
      await j.append({ type: "onboarding.changed", mode, change: Object.keys(change)[0], ...("passed" in change ? { step: change.passed } : {}), by: call.client.clientId })
      if ("passed" in change && change.passed === "fund") await setupGoesLive(call.client.clientId)
      // A step gone past changes only the person's own marks, so it's answered from what was read last, at once: each
      // read runs the CLI (sign-in, vault, keys), seconds on a slow machine, and the screen would sit still meanwhile.
      // The reads follow, and what they find is published. Setup's end waits for them, since it's marked from them.
      const seq = ++setSeq
      if ("passed" in change && lastFacts) {
        const quick = onboardingProgress(next, lastFacts)
        if (quick.at !== "done") {
          publish("onboarding", quick)
          // Dropped if the person has gone on again meanwhile: the later change's own reads follow it.
          void onboarding
            .open()
            .then((state) => onboardingView(state))
            .then((view) => (seq === setSeq ? publish("onboarding", view) : undefined))
            .catch(() => {})
          return quick
        }
      }
      const view = await onboardingView(next)
      publish("onboarding", view)
      return view
    })
    // Setup's step 1: Candle's own device code, in the pane. The profile the Candle Harness records signs in again; with
    // none, a new profile of its own on Candle's production host, named so it can't collide with one on the machine.
    s.handle("onboarding.signIn", async (_params, call) => {
      mainViewOnly(call, "Signing in to Candle")
      const client = faceClient(call)
      if (candleProfile) return { profile: candleProfile, opened: await cliTool.signIn(client, { profile: candleProfile }) }
      const listed = profilesFrom(await ownerJson(["profile", "list"]).then((r) => (r ? { exitCode: r.exitCode, json: r.json } : undefined))) ?? []
      // 0.2's own profile, when it's there and no new one is, signs in again: it already names its host.
      const { profile, reused, warning } = setupProfile(listed)
      if (warning) await j.append({ type: "onboarding.profile_host", mode, profile, warning, by: call.client.clientId })
      return { profile, ...(warning ? { warning } : {}), opened: await cliTool.signIn(client, reused ? { profile } : { profile, apiUrl: PRODUCTION_API }) }
    })
    // Setup's step 2: a harness's own sign-in, from the fixed list, in the pane, as the person.
    s.handle("onboarding.harness", async (params, call) => {
      mainViewOnly(call, "Signing in to an engine")
      if (!isEngineId(params.engine)) throw invalidParams("engine is one of the engines' ids.")
      const id = params.engine
      const argv = harnessSignInArgv(id, enginePathOf(config, id))
      const title = `${argv.map((a, i) => (i === 0 ? basename(a) : a)).join(" ")} · your own ${ENGINE_LABELS[id]} sign-in`
      const minted = tickets.mint({ cardId: `harness:${id}`, cardHash: "", viewClientId: call.client.clientId, grant: { cardId: `harness:${id}`, opId: "", title, bin: argv[0]!, steps: [{ stage: "command", argv: argv.slice(1) }], identity: "owner", harness: id } })
      harnessPanes.set(minted.ticketId, id)
      await j.append({ type: "onboarding.harness", mode, engine: id, ticketId: minted.ticketId, by: call.client.clientId })
      return { ...minted, title }
    })
    // Setup's step 2, its test message: the doctor's one-word turn, on the engine and model picked, kept with them once it answers.
    s.handle("onboarding.test", async (_params, call) => {
      mainViewOnly(call, "The test message")
      const state = await onboarding.open()
      if (!state.engine) throw refused("NO_ENGINE", "Pick an engine first.")
      const e = engines.get(state.engine)!
      const started = now()
      const outcome = await signInTurn({ p: paths, engine: e, env: harnessEnv(opts.env), homesDir: join(paths.stateDir, "test-homes"), timeoutMs: opts.testTurnMs ?? 90_000, ...(state.model ? { model: state.model } : {}), shim: opts.shim ?? selfCommand() })
      const ms = now() - started
      await j.append({ type: "onboarding.tested", mode, engine: state.engine, ...(state.model ? { model: state.model } : {}), ok: outcome.ok, ms, by: call.client.clientId })
      if (!outcome.ok) {
        const words = outcome.timedOut ? `${e.label} didn't answer in ${Math.round((opts.testTurnMs ?? 90_000) / 1000)} s.` : `${e.label} didn't answer: ${e.explain(outcome.message)}`
        return { ok: false, words: redactor.text(words).slice(0, 300) }
      }
      const next = withTested(await onboarding.open(), state.engine, state.model, now())
      await onboarding.write(next)
      const view = await onboardingView(next)
      publish("onboarding", view)
      // The reply is the model's, and only a word: shown as data, cut short.
      return { ok: true, ms, reply: terminalText(outcome.text ?? "").slice(0, 80), view }
    })
    // Setup's step 3, the limits: the Candle Harness's two for the agent onboarding made, written into its own table in
    // config.toml and used at once, then the step is gone past. Only that agent, and only while setup runs.
    s.handle("onboarding.limits", async (params, call) => {
      mainViewOnly(call, "Setting your agent's limits")
      const state = await onboarding.open()
      const agent = state.agent?.name
      if (state.finishedAt !== undefined || agent === undefined || !keys.has(agent) || !config.agents[agent]) throw refused("NO_AGENT_YET", "Make your agent's key first: its limits go in its own table in config.toml.")
      const perTradeUsd = params.perTradeUsd
      const perDayUsd = params.perDayUsd
      if (typeof perTradeUsd !== "number" || typeof perDayUsd !== "number") throw invalidParams("perTradeUsd and perDayUsd are dollar figures.")
      const recorded = await recordAgentLimits(paths, agent, { perTradeUsd, perDayUsd })
      if (!recorded.ok) throw refused("LIMITS_NOT_RECORDED", `${recorded.why.charAt(0).toUpperCase()}${recorded.why.slice(1)}. Nothing changed.`)
      config.agents[agent] = { ...config.agents[agent]!, limits: { perTradeUsd, perDayUsd } }
      sawConfig()
      await j.append({ type: "onboarding.limits", mode, agent, perTradeUsd, perDayUsd, wrote: recorded.wrote, by: call.client.clientId })
      publishStatus?.()
      const next = applyChange(state, { passed: "limits" }, now())
      await onboarding.write(next)
      const view = await onboardingView(next)
      publish("onboarding", view)
      return view
    })
    // Setup's step 3, its last part: "fund it later". The step is gone past unfunded, and setup still ends live, as
    // setupGoesLive has it: the first trade without funds is refused saying so. The Candle Harness doesn't steer the first trade.
    s.handle("onboarding.fundLater", async (_params, call) => {
      mainViewOnly(call, "Funding it later")
      const next = applyChange(await onboarding.open(), { passed: "fund" }, now())
      await onboarding.write(next)
      await j.append({ type: "onboarding.changed", mode, change: "passed", step: "fund", later: true, by: call.client.clientId })
      await setupGoesLive(call.client.clientId)
      const view = await onboardingView(next)
      publish("onboarding", view)
      return view
    })
    // The person's own `forget vault`, from a main view, only while the CLI finds no vault.
    // It removes the mark, so owner steps run without a factor, approved in the pane, until there's a vault again.
    s.handle("vault.forget", async (_params, call) => {
      if (!fromMainView(call)) throw refused("MAIN_VIEW_ONLY", "Type forget vault in the main window.")
      if (!vaultMark.seen()) return { said: "The Candle Harness has never seen a vault on this machine, so there's nothing to forget." }
      const vault = await cliTool.vaultState()
      if (vault === "present") throw refused("VAULT_PRESENT", "The CLI finds this machine's vault, so there's nothing to forget: owner steps take your factor. Nothing changed.")
      if (vault === "unreadable") throw refused("VAULT_UNREADABLE", "The CLI didn't say whether there's a vault, so the Candle Harness keeps asking for your factor. Nothing changed.")
      await vaultMark.forget()
      await j.append({ type: "vault.forgotten", mode, by: call.client.clientId })
      return { said: "Forgotten: this machine has no vault, so owner steps run without a factor, approved by you in the pane, until you make one with candle vault init." }
    })
    // Autonomy per wallet: the person's, from a main view only. A popped view, the doctor and the sampler are refused.
    s.events.provideSnapshot("autonomy", () => autonomyDesk.view())
    s.handle("autonomy.set", async (params, call) => {
      const set = await autonomyDesk.set({ clientId: call.client.clientId, popped: !fromMainView(call) }, params)
      return { wallet: set.wallet, name: set.name, was: set.was, now: set.now }
    })
    // Triggers: kept in triggers.toml, saved only by the person's press on a trigger's card. Off and removal from
    // any view; back on, as approved, from the main view. Pro and Max: on Free the topic says so and nothing fires.
    s.events.provideSnapshot("triggers", () => triggers.view())
    s.handle("triggers.list", async () => triggers.view())
    s.handle("triggers.set", async (params, call) => {
      if (typeof params.name !== "string" || typeof params.on !== "boolean") throw invalidParams("name is a trigger's name, and on is true or false.")
      return triggers.set(params.name, params.on, { clientId: call.client.clientId, main: fromMainView(call) })
    })
    s.handle("triggers.remove", async (params, call) => {
      if (typeof params.name !== "string") throw invalidParams("name is a trigger's name.")
      return triggers.remove(params.name, { clientId: call.client.clientId })
    })
    s.handle("triggers.fire", async (params, call) => {
      if (typeof params.name !== "string") throw invalidParams("name is a trigger's name.")
      // The doctor and the sampler only look.
      if (READ_ONLY_CLIENTS.has(call.client.clientName)) throw refused("OBSERVER", "The doctor and the sampler don't fire triggers.")
      const f = await triggers.fire(params.name, { clientId: call.client.clientId })
      const fired = { name: f.name, fireId: f.fireId, said: `"${f.name}" fired.` }
      if (params.wait !== true) return fired
      // `candle-harness trigger` waits for what it did: a trade to fill, a card to be pressed or expire, a notice, a wake.
      const end = await (f.run as Promise<FireEnd>).catch((error: unknown): FireEnd => ({ kind: "stopped", words: (error as Error)?.message ?? String(error) }))
      const line = tradeLog.firingLine(f.fireId)
      return { ...fired, ended: fireEndSaid(end), ...(line ? { line } : {}) }
    })
    // `run it now` on a trigger's card that expired with nobody there: its line again at a fresh price, from the
    // part that expired on. A trade that may run without a card, so the main view's, as a typed trade is.
    s.handle("triggers.runNow", async (params, call) => {
      if (typeof params.cardId !== "string") throw invalidParams("cardId is a trigger's expired card.")
      mainViewOnly(call, "Running a trigger's line again")
      const held = cards.get(params.cardId)
      // A card from before a restart is read from the journal: its proposal names the trigger, and its close says it expired.
      const rows = j.rows()
      const created = held ? undefined : rows.find((r) => r.type === "card.created" && r.cardId === params.cardId)
      const origin = held?.origin.trigger ?? (created && typeof created.trigger === "string" && typeof created.fireId === "string" ? { name: created.trigger, fireId: created.fireId, part: typeof created.part === "number" ? created.part : 0 } : undefined)
      if (!held && !created) throw refused("CARD_NOT_FOUND", "No card with that id.")
      const state = held?.state ?? (rows.some((r) => r.type === "card.expired" && r.cardId === params.cardId) ? "expired" : "awaiting_approval")
      if (rows.some((r) => r.type === "trigger.run_now" && r.cardId === params.cardId)) throw refused("ALREADY_RUN", "This card's line was already run again. Nothing was sent.")
      const ran = await firer.runNow({ cardId: params.cardId, state, ...(origin ? { trigger: origin } : {}) }, call.client.clientId)
      return { said: ran.said, runId: ran.runId }
    })
    // Bots: kept in bots.toml, saved only by the person's press on a bot's card. Paused or narrowed from any view;
    // stopped, back on as approved, flattened and removed from the main view. Pro and Max, as triggers.
    s.events.provideSnapshot("bots", () => botsTopic())
    s.handle("bots.list", async () => botsTopic())
    const botName = (params: Record<string, unknown>) => {
      if (typeof params.name !== "string") throw invalidParams("name is a bot's name.")
      return params.name
    }
    // The doctor and the sampler only look.
    const notObserver = (call: { client: { clientName: string } }) => {
      if (READ_ONLY_CLIENTS.has(call.client.clientName)) throw refused("OBSERVER", "The doctor and the sampler don't change bots.")
    }
    // A code bot's controls go to its own book: the same methods, by its name.
    const isCode = (name: string) => codeBots.entry(name) !== undefined || codeBots.stateOf(name) !== undefined
    s.handle("bots.pause", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (isCode(name)) return codeBots.pause(name, { clientId: call.client.clientId, how: "view" })
      return bots.pause(name, { clientId: call.client.clientId, how: "view" })
    })
    s.handle("bots.narrow", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (isCode(name)) {
        const figures: Record<string, number> = {}
        for (const key of ["perTradeUsd", "perDayUsd", "maxOpen", "maxSlippageBps"] as const) {
          if (params[key] === undefined) continue
          if (typeof params[key] !== "number") throw invalidParams(`${key} is a number.`)
          figures[key] = params[key] as number
        }
        if (!Object.keys(figures).length) throw invalidParams("A code bot narrows by perTradeUsd, perDayUsd, maxOpen or maxSlippageBps.")
        return codeBots.narrow(name, figures, { clientId: call.client.clientId, how: "view" })
      }
      if (params.definition === undefined) throw invalidParams("definition is the bot's narrower definition, in Hacc's JSON.")
      if (params.maxSlippageBps !== undefined && typeof params.maxSlippageBps !== "number") throw invalidParams("maxSlippageBps is a whole number of basis points.")
      return bots.narrow(name, { definition: params.definition, ...(typeof params.maxSlippageBps === "number" ? { maxSlippageBps: params.maxSlippageBps } : {}) }, { clientId: call.client.clientId, how: "view" })
    })
    s.handle("bots.stop", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (isCode(name)) return codeBots.stop(name, { clientId: call.client.clientId, main: fromMainView(call) })
      return bots.stop(name, { clientId: call.client.clientId, main: fromMainView(call) })
    })
    s.handle("bots.resume", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (isCode(name)) return codeBots.resume(name, { clientId: call.client.clientId, main: fromMainView(call) })
      return bots.resume(name, { clientId: call.client.clientId, main: fromMainView(call) })
    })
    s.handle("bots.flatten", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (isCode(name)) return codeBots.flatten(name, { clientId: call.client.clientId, main: fromMainView(call) })
      return bots.flatten(name, { clientId: call.client.clientId, main: fromMainView(call) })
    })
    // Two failed sells of a token held a bot's exits: the person says to try once more.
    s.handle("bots.retry", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (!fromMainView(call)) throw refused("MAIN_VIEW_ONLY", "A bot's held sells are retried from the main window, not a popped pane.")
      if (!bots.entry(name) && !isCode(name)) throw refused("UNKNOWN_BOT", `No bot named "${name}".`)
      const released = botExits?.retry(name) ?? 0
      void botExits?.check().catch(() => {})
      return { name, released, said: released ? `"${name}" tries ${released === 1 ? "its held sell" : `its ${released} held sells`} once more.` : `None of "${name}"'s sells were held.` }
    })
    // A code bot's process, the supervisor's: started, stopped and started again; its token for running it
    // elsewhere, written to a 0600 file in its folder and never answered; and its log, redacted when it was kept.
    // Stopping its process leaves the bot on, so its held exits still run; only the main window stops its trades.
    const supervised = (call: { client: { clientName: string } }): Supervisor => {
      if (READ_ONLY_CLIENTS.has(call.client.clientName)) throw refused("OBSERVER", "The doctor and the sampler don't change bots.")
      if (!supervisor) throw refused("NOT_SUPERVISED", "This core doesn't run code bots.")
      return supervisor
    }
    const codeName = (params: Record<string, unknown>): string => {
      const name = typeof params.name === "string" ? params.name : ""
      if (!name) throw invalidParams("name must name a code bot.")
      if (!codeBots.entry(name)) {
        const names = codeBots.entries().map((b) => `"${b.name}"`)
        throw refused("UNKNOWN_BOT", `No code bot named "${name}".${names.length ? ` Code bots: ${names.join(", ")}.` : " There are no code bots."}`)
      }
      return name
    }
    s.handle("bots.process.start", async (params, call) => supervised(call).startByPerson(codeName(params)))
    s.handle("bots.process.stop", async (params, call) => supervised(call).stopByPerson(codeName(params)))
    s.handle("bots.process.restart", async (params, call) => supervised(call).restart(codeName(params)))
    s.handle("bots.token", async (params, call) => supervised(call).outside(codeName(params)))
    s.handle("bots.logs", async (params) => {
      const name = codeName(params)
      const lines = typeof params.lines === "number" && Number.isInteger(params.lines) ? Math.min(Math.max(params.lines, 1), 5_000) : 200
      return readLogTail(paths.botLogsDir, name, lines)
    })
    // The person removes the exits the core holds on a code bot's position: its own code sells it from then on.
    s.handle("bots.exits.remove", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (!fromMainView(call)) throw refused("MAIN_VIEW_ONLY", "A bot's held exits are removed from the main window, not a popped pane.")
      if (!isCode(name)) throw refused("NOT_A_CODE_BOT", `"${name}" isn't a code bot: a rules bot's exits are its definition's, changed on its card.`)
      if (typeof params.position !== "string") throw invalidParams("position is the position's id, from the Bots tab.")
      return desk.removeExits(name, params.position, call.client.clientId)
    })
    s.handle("bots.remove", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (params.positions !== "flatten" && params.positions !== "leave") throw invalidParams('positions is "flatten", to sell its open positions first, or "leave", to leave them in the wallet.')
      if (isCode(name)) {
        const guarded = params.positions === "leave" ? botPositions.open(name).filter((p) => heldExits.of(p.id)).length : 0
        const removed = await codeBots.remove(name, { clientId: call.client.clientId, main: fromMainView(call) }, params.positions)
        return guarded ? { ...removed, said: `${removed.said} The exits the core held on ${guarded === 1 ? "it" : `${guarded} of them`} end with the bot.` } : removed
      }
      return bots.remove(name, params.positions, { clientId: call.client.clientId, main: fromMainView(call) })
    })
    // A code bot reads its own settings and state, by its token: never another's.
    s.handle("bot.self", async (_params, call) => {
      const name = call.client.bot
      const b = name ? codeBots.entry(name) : undefined
      if (!name || !b) throw refused("UNKNOWN_BOT", "This bot isn't in bots.toml now.")
      const v = codeBots.viewOf(b)
      const run = codeBots.approvedVersion(name)?.run
      return {
        name,
        agent: b.agent,
        mode: v.mode,
        state: v.state,
        buys: v.buys,
        sells: v.sells,
        ...(v.held ? { held: v.held } : {}),
        ...(v.stateWords ? { stateWords: v.stateWords } : {}),
        // What it's held to: the figures its card approved, whatever a hand edit says.
        ...(run ? { figures: { perTradeUsd: run.perTradeUsd, perDayUsd: run.perDayUsd, maxOpen: run.maxOpen, ...(run.maxSlippageBps !== undefined ? { maxSlippageBps: run.maxSlippageBps } : {}) } } : {}),
        ...(v.paysFrom ? { paysFrom: v.paysFrom } : {}),
      }
    })
    // A code bot's trades and reads, by its token: always its own (bot-protocol.ts).
    const botOf = (call: { client: { bot?: string } }) => {
      const name = call.client.bot
      if (!name || !codeBots.entry(name)) throw refused("UNKNOWN_BOT", "This bot isn't in bots.toml now.")
      return name
    }
    s.handle("bot.buy", async (params, call) => desk.buy(botOf(call), params))
    s.handle("bot.sell", async (params, call) => desk.sell(botOf(call), params))
    s.handle("bot.swap", async (params, call) => desk.swap(botOf(call), params))
    s.handle("bot.request", async (params, call) => desk.status(botOf(call), params))
    s.handle("bot.positions", async (_params, call) => desk.positions(botOf(call)))
    s.handle("bot.fills", async (params, call) => desk.fills(botOf(call), params))
    s.handle("bot.market", async (params, call) => desk.market(botOf(call), params))
    // Exits the core holds on one of its positions: set, changed or cleared by the bot, watched by the core.
    s.handle("bot.exits", async (params, call) => {
      const kept = await desk.setExits(botOf(call), params)
      void botExits?.check().catch(() => {})
      return kept
    })
    // Its own report about itself: kept beside the core's count, and shown on the Bots tab as "the bot says".
    s.handle("bot.report", async (params, call) => {
      const kept = botReports.take(botOf(call), params)
      reportPublish ??= setTimeout(() => {
        reportPublish = undefined
        void publish("bots", botsTopic())
      }, 1_000)
      reportPublish.unref?.()
      return kept
    })
    // What it says, one word and a line: journalled as its own, and a trigger on its word fires on the row.
    const botEvents = new BotEvents(now)
    s.handle("bot.event", async (params, call) => {
      const name = botOf(call)
      const said = botEvents.take(name, params)
      const row = await j.append({ type: "bot.event", mode, kind: "code", agent: codeBots.entry(name)!.agent, name, word: said.word, ...(said.text ? { text: said.text } : {}) })
      return { word: said.word, at: row.at }
    })
    // Hacc's reads its agent's plan offers, with its agent's key: never a change, which is the person's or the agent's.
    s.handle("bot.hacc", async (params, call) => {
      const name = botOf(call)
      const agent = codeBots.entry(name)!.agent
      if (!config.hacc.enabled) throw refused("HACC_OFF", "Hacc's data is turned off in this Candle Harness's config ([hacc] enabled = false).")
      const tool = typeof params.tool === "string" ? params.tool : ""
      const offered = haccOffered(agent) ? haccOffer(agent).map((t) => t.name) : []
      if (!offered.includes(tool)) throw refused("NOT_OFFERED", `${tool || "That"} isn't one of Hacc's reads ${agent}'s plan offers: ${offered.join(", ") || "none now"}.`)
      const { tool: _tool, ...args } = params
      const view = HACC_TOOLS.find((t) => t.name === tool)?.views[String(args.view)]
      if (view?.change) throw refused("READS_ONLY", "A bot reads Hacc; a change to it (a follow, a rule, a group, a strategy) is the person's or the agent's.")
      const answer = await haccTools.call(agent, tool, args)
      const text = answer.content[0]?.text ?? "{}"
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        data = { text }
      }
      if (answer.isError) {
        const e = (data as { error?: { code?: unknown; message?: unknown } }).error
        throw refused(typeof e?.code === "string" ? e.code : "HACC_REFUSED", typeof e?.message === "string" ? e.message : "Hacc refused the read.")
      }
      return data
    })
    // A Build pane proposes a code bot for its agent: a card in the person's view. A change that only lowers a figure
    // or tightens its slippage bound happens at once; anything else is the person's press.
    /** A code bot's card, for the person's press: from a Build pane's proposal, or a control its report offered. */
    const proposeCodeCard = (check: ReturnType<typeof codeBots.check>, client: FaceClient, wasMode: "paper" | "live" | undefined, reason?: string) => {
      const input = codeBotCard(check, {
        pays: botPayWallet(client.agent, check.run.wallet),
        sharedWith: check.run.mode === "live" ? botSharedWith(client.agent, check.run.wallet, check.name) : [],
        ownWallet: ownWalletSteps(client.agent),
        ...(wasMode ? { wasMode } : {}),
      })
      return cards.propose({
        client,
        agent: client.agent,
        tool: BOTS_TOOL_NAME,
        args: { action: "propose", kind: "code", name: check.name, hash: check.hash },
        params: input.params as unknown as Record<string, unknown>,
        kind: "bot",
        idKey: "coreOpId",
        title: input.title,
        botCard: { spec: input.spec, ...(input.paysFrom ? { paysFrom: input.paysFrom } : {}), ...(input.slippage ? { slippage: input.slippage } : {}) },
        ...(input.warning ? { warning: input.warning } : {}),
        ...(input.fills?.length ? { fills: input.fills } : {}),
        ...(reason ? { reason } : {}),
      })
    }
    s.handle("bots.proposeCode", async (params, call) => {
      const agent = call.client.agent
      if (!agent) throw refused("UNKNOWN_AGENT", "This Build pane builds for no agent.")
      const name = typeof params.name === "string" ? params.name.trim() : ""
      if (!name) throw invalidParams("name is the bot's name.")
      const replace = params.replace === true
      const saved = codeBots.entry(name)
      if (saved && !replace) throw refused("NAME_TAKEN", `A code bot named "${name}" is saved already. To change it, propose again with replace: true; for another one, give it a name of its own. Nothing was proposed.`)
      if (!saved && replace) throw refused("UNKNOWN_BOT", `No code bot is named "${name}", so there's nothing to replace. Nothing was proposed.`)
      if (saved && saved.agent !== agent) throw refused("NOT_ITS_AGENT", `"${name}" is ${saved.agent}'s bot: a Build pane for ${agent} can't change it.`)
      // The bot's settings as given; a change keeps the saved bot's where one is left out. check() reads each.
      const given = <T>(key: string, was: T | undefined): T | undefined => (params[key] === undefined ? was : (params[key] as T))
      const wallet = given<string>("wallet", saved?.wallet)
      const mode = given<"paper" | "live">("mode", saved?.mode)
      if (typeof wallet !== "string" || wallet === "") throw refused("ASK_FIRST", "Ask the person which wallet it pays from: they pick. Offer a wallet of its own for a live bot. Nothing was proposed.")
      if (mode !== "paper" && mode !== "live") throw refused("ASK_FIRST", "Ask the person whether it runs on paper or live: they pick. Nothing was proposed.")
      const bps = given<number>("maxSlippageBps", saved?.maxSlippageBps)
      const proposal: CodeBotProposal = {
        name,
        run: {
          agent,
          wallet,
          mode,
          folder: given<string>("folder", saved?.folder) as string,
          command: given<string[]>("command", saved?.command) as string[],
          perTradeUsd: given<number>("perTradeUsd", saved?.perTradeUsd) as number,
          perDayUsd: given<number>("perDayUsd", saved?.perDayUsd) as number,
          maxOpen: given<number>("maxOpen", saved?.maxOpen) as number,
          ...(bps !== undefined ? { maxSlippageBps: bps } : {}),
        },
      }
      const check = codeBots.check(proposal, agent)
      const reason = typeof params.reason === "string" ? params.reason : undefined
      // A change that only narrows a bot that runs as approved: at once.
      if (saved && check.changes && check.changes.what.length && !check.changes.wider.length && !codeBots.heldBy(saved)) {
        const next = { perTradeUsd: check.run.perTradeUsd, perDayUsd: check.run.perDayUsd, maxOpen: check.run.maxOpen, ...(check.run.maxSlippageBps !== undefined ? { maxSlippageBps: check.run.maxSlippageBps } : {}) }
        const done = await codeBots.narrow(name, next, { clientId: call.client.clientId, how: "build", agent })
        return { done: true, said: done.said }
      }
      if (saved && check.changes && !check.changes.what.length) throw refused("NO_CHANGE", `That's what "${name}" already runs, so nothing was proposed.`)
      // One open card for a bot's name: proposed again with other settings, the card before is withdrawn.
      await cards.withdrawWhere((c) => c.kind === "bot" && c.origin.role === "build" && c.agent === agent && c.asked.kind === "code" && c.asked.name === name && c.asked.hash !== check.hash, "proposed_again")
      const card = await proposeCodeCard(check, { clientId: call.client.clientId, role: "build", agent }, saved?.mode, reason)
      return { cardId: card.cardId, said: `"${name}" waits on a card in the person's main window. Nothing runs before they press it.` }
    })

    // Build panes: each gets a token of its own when it opens, minted for the agent the person builds for and handed
    // to the main view, which puts it in the pane's environment alone. It's revoked when the pane closes, when the view
    // that opened it goes, and with the core. Through it, the person's own harness reads the books, a bot's log and its
    // agent's record, tests a bot on paper, and proposes one: it approves, trades and changes nothing itself.
    const buildSessions = new Map<string, { agent: string; viewId: string; harness?: string }>()
    const closeBuild = async (tokenId: string) => {
      const session = buildSessions.get(tokenId)
      if (!session) return false
      buildSessions.delete(tokenId)
      await tokens.revoke(tokenId)
      s.disconnectToken(tokenId)
      await codeBots.endTestsOf(tokenId)
      await j.append({ type: "build.session", mode, agent: session.agent, what: "closed", tokenId })
      return true
    }
    s.handle("build.open", async (params, call) => {
      notObserver(call)
      mainViewOnly(call, "Opening a Build pane")
      const agent = typeof params.agent === "string" && params.agent ? params.agent : undefined
      if (!agent || !keys.has(agent)) throw refused("UNKNOWN_AGENT", agent ? `${agent} has no key here, so there's no agent to build for.` : "agent is the agent the bots are built for.")
      // The bots folder, by where it really is, at every open.
      const place = folderPlace(typedFolder(readBuildPrefs(paths.buildPrefs, config.build).folder))
      if (place) throw refused("BAD_FOLDER", `The bots ${place}. Pick another with harness ▾. Nothing was opened.`)
      const harness = typeof params.harness === "string" ? terminalText(params.harness).slice(0, 80) : undefined
      const minted = await tokens.mintBuild(`build-${agent}`, agent)
      buildSessions.set(minted.tokenId, { agent, viewId: call.client.clientId, ...(harness ? { harness } : {}) })
      await j.append({ type: "build.session", mode, agent, what: "opened", tokenId: minted.tokenId, ...(harness ? { harness } : {}) })
      return new WithSecret({ tokenId: minted.tokenId, agent, socketPath: paths.socket, gate: codeBots.gateView() ?? null }, { token: minted.token }, "view")
    })
    // The Build pane's folder and harness: as last picked in the pane, else config.toml's [build], else the defaults.
    // Each engine's binary goes with them, as config names it, so the pane opens the harness the person's turns run on.
    s.handle("build.prefs", async (params, call) => {
      const set = params.set as { folder?: unknown; harness?: unknown; opened?: unknown } | undefined
      if (set !== undefined) {
        notObserver(call)
        mainViewOnly(call, "Choosing the Build pane's folder or harness")
        const change: { folder?: string; harness?: string; opened?: true } = {}
        if (set.folder !== undefined) {
          const problem = typeof set.folder === "string" ? folderProblem(set.folder) : "A folder is a path."
          if (problem) throw refused("INVALID_PARAMS", problem)
          const place = folderPlace(typedFolder(set.folder as string))
          if (place) throw refused("INVALID_PARAMS", `The bots ${place}.`)
          change.folder = (set.folder as string).trim()
        }
        if (set.harness !== undefined) {
          const problem = typeof set.harness === "string" ? harnessProblem(set.harness) : "A harness is an engine's id or a command."
          if (problem) throw refused("INVALID_PARAMS", problem)
          change.harness = (set.harness as string).trim()
        }
        if (set.opened === true) change.opened = true
        saveBuildPrefs(paths.buildPrefs, change)
      }
      const read = readBuildPrefs(paths.buildPrefs, config.build)
      // A saved folder that's now one of ours (or /, or the home) is asked for again, never opened.
      const refusedPlace = folderPlace(typedFolder(read.folder))
      const prefs = refusedPlace ? { ...read, opened: false, folderRefused: `The bots ${refusedPlace}.` } : read
      return { ...prefs, bins: Object.fromEntries(ENGINE_IDS.map((id) => [id, enginePathOf(config, id)])) }
    })
    s.handle("build.close", async (params, call) => {
      const tokenId = typeof params.tokenId === "string" ? params.tokenId : ""
      const session = buildSessions.get(tokenId)
      if (!session) return { closed: false }
      if (session.viewId !== call.client.clientId) throw refused("NOT_YOURS", "A Build pane is closed by the view that opened it.")
      return { closed: await closeBuild(tokenId) }
    })
    const buildAgent = (call: { client: { agent?: string; tokenId?: string } }) => {
      const agent = call.client.agent
      if (!agent || !call.client.tokenId || !buildSessions.has(call.client.tokenId)) throw refused("UNAUTHENTICATED", "This Build pane's token isn't open now.")
      return { agent, tokenId: call.client.tokenId }
    }
    s.handle("build.books", async (_params, call) => {
      buildAgent(call)
      return botsTopic()
    })
    s.handle("build.logs", async (params, call) => {
      const { agent, tokenId } = buildAgent(call)
      const name = typeof params.bot === "string" ? params.bot : ""
      const entry = codeBots.entry(name)
      if (!entry || (codeBots.isTest(name) && codeBots.testOwner(name) !== tokenId)) throw refused("UNKNOWN_BOT", `No code bot named "${name}" is saved here.`)
      // A Build pane reads its own agent's bots' logs, as it proposes only its own agent's bots.
      if (entry.agent !== agent) throw refused("NOT_ITS_AGENT", `"${name}" is ${entry.agent}'s bot: a Build pane for ${agent} can't read its log.`)
      if (codeBots.isTest(name)) throw refused("TEST_RUN", "A test run's output is in the terminal that ran it: the core keeps no log of it.")
      const lines = typeof params.lines === "number" && Number.isInteger(params.lines) ? Math.min(Math.max(params.lines, 1), 5_000) : 200
      return readLogTail(paths.botLogsDir, name, lines)
    })
    s.handle("build.journal", async (params, call) => {
      const { agent } = buildAgent(call)
      const answer = historyCall(j.rows(), agent, params, { now, sessionEnd: () => sessionEnd })
      if (!answer.ok) throw refused(answer.code, answer.message)
      return answer.body
    })
    s.handle("build.test", async (params, call) => {
      const { agent, tokenId } = buildAgent(call)
      const num = (k: string) => (typeof params[k] === "number" ? (params[k] as number) : undefined)
      const started = await codeBots.startTest({
        folder: params.folder as string,
        command: params.command as string[],
        agent,
        buildTokenId: tokenId,
        ...(num("perTradeUsd") !== undefined ? { perTradeUsd: num("perTradeUsd")! } : {}),
        ...(num("perDayUsd") !== undefined ? { perDayUsd: num("perDayUsd")! } : {}),
        ...(num("maxOpen") !== undefined ? { maxOpen: num("maxOpen")! } : {}),
      })
      const { token, ...rest } = started
      return new WithSecret(rest, { token }, "build")
    })
    s.handle("build.testEnd", async (params, call) => {
      const { tokenId } = buildAgent(call)
      const name = typeof params.name === "string" ? params.name : ""
      if (codeBots.testOwner(name) !== tokenId) return { ended: false }
      const done = await codeBots.endTest(name, "ended")
      return { ended: !!done, ...(done ? { said: done.said } : {}) }
    })
    // The person's `stop test` in the Build tab: a paper test a Build pane of this view started, ended at once.
    s.handle("build.endTest", async (params, call) => {
      notObserver(call)
      const name = typeof params.name === "string" ? params.name : ""
      const owner = codeBots.testOwner(name)
      const session = owner ? buildSessions.get(owner) : undefined
      if (!owner || !session) return { ended: false }
      if (session.viewId !== call.client.clientId) throw refused("NOT_YOURS", "A paper test is ended from the view whose Build pane started it.")
      const done = await codeBots.endTest(name, "ended")
      return { ended: !!done, ...(done ? { said: done.said } : {}) }
    })
    // A control the bot's own report offers, clicked by the person: a pause or a lowered figure at once; a raised
    // figure, a looser bound or one under the route's default a card. The bot only suggests: nothing it says changes it.
    s.handle("bots.control", async (params, call) => {
      const name = botName(params)
      notObserver(call)
      if (!fromMainView(call)) throw refused("MAIN_VIEW_ONLY", "A bot's controls are clicked in the main window, not a popped pane.")
      const b = codeBots.entry(name)
      if (!b) throw refused("UNKNOWN_BOT", `No code bot named "${name}".`)
      const id = typeof params.id === "string" ? params.id : ""
      const c = botReports.control(name, id)
      if (!c) throw refused("UNKNOWN_CONTROL", `"${name}" doesn't offer that control now. Nothing changed.`)
      if ("pause" in c) return codeBots.pause(name, { clientId: call.client.clientId, how: "view" })
      const approved = codeBots.approvedVersion(name)?.run
      if (!approved) throw refused("NOT_APPROVED", `"${name}" hasn't been approved as it is, so its figures can't change from its controls. Nothing changed.`)
      const e = controlEffect(approved, c, routeSlippageBps(approved.wallet))
      if (e.how === "same" || !e.next) return { name, said: `"${name}" runs so already, so nothing changed.` }
      const next = e.next
      if (e.how === "at once" && !codeBots.heldBy(b)) {
        const done = await codeBots.narrow(name, { perTradeUsd: next.perTradeUsd, perDayUsd: next.perDayUsd, maxOpen: next.maxOpen, ...(next.maxSlippageBps !== undefined ? { maxSlippageBps: next.maxSlippageBps } : {}) }, { clientId: call.client.clientId, how: "view" })
        return { name, said: done.said }
      }
      // Wider, or a bot held: a card for what its card approved, with the control's figures, for the person's press.
      const proposal: CodeBotProposal = { name, run: { ...next, command: [...next.command] } }
      const check = codeBots.check(proposal, b.agent)
      const card = await proposeCodeCard(check, { clientId: call.client.clientId, role: "view", agent: b.agent }, approved.mode, `the bot "${name}" offers: ${c.label}`)
      return { name, cardId: card.cardId, said: `"${name}"'s ${c.label} is more than a lowering of what you approved, so it's a card: press it to change the bot.` }
    })
    // The person's pick: the link moves to it if Candle has a market for it. A pick
    // answered after a later one says so, and the view lets it go.
    const lastPicked = new Map<string, { mint: string; at: number }>()
    s.handle("view.link", async (params, call) => {
      const mint = mintParam(params.mint)
      const chain = chainParam(params.chain)
      if (!mint || !chain) throw invalidParams('mint is a token\'s address, and chain "solana" or "hood".')
      const outcome = await tokenWatch.link(mint, chain, "you")
      if (outcome === "base") throw refused("BASE_ASSET", `${spentSymbol(mint, chain) ?? "That"} is what trades spend, so the token pane doesn't follow it.`)
      if (outcome === "no-market") throw refused("NO_MARKET", "Candle has no market for that token, so the token pane stays where it was.")
      if (outcome === "superseded") return { linked: false, superseded: true }
      const v = tokenWatch.view()
      viewState.pick({ mint, chain, ...(v.followed?.symbol ? { symbol: v.followed.symbol } : {}), ...(v.market?.name ? { name: v.market.name } : {}) })
      // For the record (a pick nobody remembered making couldn't be traced): where it came from.
      // The same token picked again by the same view within a few seconds is one pick (a double click and a
      // settle in quick succession would journal it twice).
      const from = typeof params.from === "string" ? terminalText(params.from, { maxLength: 60 }).trim() : ""
      const last = lastPicked.get(call.client.clientId)
      lastPicked.set(call.client.clientId, { mint, at: now() })
      if (last?.mint === mint && now() - last.at < REPICK_MS) return { linked: true, ...(v.followed?.symbol ? { symbol: v.followed.symbol } : {}) }
      await j.append({ type: "view.picked", mode, mint, chain, ...(v.followed?.symbol ? { symbol: v.followed.symbol } : {}), ...(from ? { from } : {}), by: call.client.clientId })
      return { linked: true, ...(v.followed?.symbol ? { symbol: v.followed.symbol } : {}) }
    })
    // A token pane pinned on a token, by where it is (a tab's name, and which of its token panes): the linked token unless one is named.
    s.handle("view.pin", async (params) => {
      const at = placeParam(params.at)
      if (!at) throw invalidParams("at names the tab the token pane is on.")
      const pane = tokenPaneParam(params.pane)
      if (!pane) throw invalidParams(`pane is one of ${TOKEN_PANES.join(", ")}: which of the tab's token panes.`)
      const v = tokenWatch.view()
      const named = params.mint === undefined ? undefined : mintParam(params.mint)
      if (params.mint !== undefined && !named) throw invalidParams("mint is a token's address.")
      const token = named === undefined || named === v.followed?.mint ? v.followed : v.pinned?.find((p) => p.mint === named)
      if (!token) throw refused("NOT_WATCHED", "Pick the token first: a pin holds the token pane on the token it shows.")
      const pinned = await viewState.pin({ at, ...(pane !== "token" ? { pane } : {}), mint: token.mint, chain: token.chain, ...(token.symbol ? { symbol: token.symbol } : {}) })
      if (!pinned.ok) throw refused("TOO_MANY_PINS", pinned.message)
      tokenWatch.setPinned(viewState.pins())
      publishViews()
      return { pins: viewState.pins() }
    })
    // `pane` "all": every pin on the tab (a tab removed).
    s.handle("view.unpin", async (params) => {
      const at = placeParam(params.at)
      if (!at) throw invalidParams("at names the tab the token pane is on.")
      const pane = params.pane === "all" ? "all" : tokenPaneParam(params.pane)
      if (!pane) throw invalidParams(`pane is one of ${TOKEN_PANES.join(", ")}, or "all".`)
      if (await viewState.unpin(at, pane)) {
        tokenWatch.setPinned(viewState.pins())
        publishViews()
      }
      return { pins: viewState.pins() }
    })
    // What a tab's Signals pane shows: kept by the tab, as a pin is, for every view of it.
    s.handle("view.signals", async (params) => {
      const choice = signalsChoiceParam(params)
      if ("problem" in choice) throw invalidParams(choice.problem)
      if (await viewState.setSignals(choice)) publishViews()
      return { signals: viewState.signals() }
    })
    // The chain every pane shows, in every view: the person's choice, kept, and journalled as theirs.
    s.handle("view.chain", async (params, call) => {
      const read = chainFilterParam(params.chain === undefined ? undefined : params.chain)
      if ("problem" in read) throw invalidParams(read.problem)
      if (await viewState.setChain(read.chain)) {
        publishViews()
        replanFeeds()
        await j.append({ type: "view.set", mode, by: call.client.clientId, words: `showed ${read.chain ? chainName(read.chain) : "all chains"} in every pane` })
      }
      return { chain: viewState.chain() }
    })
    // A popped view's pane: held by its connection, so it returns to the tiled views when that goes.
    s.handle("view.pop", async (params, call) => {
      if (!isPoppable(params.pane)) throw invalidParams(`pane is one of ${POPPABLE.join(", ")}: the agent's conversation stays in the main window.`)
      const popped = viewState.pop(params.pane, call.client.clientId)
      if (!popped.ok) throw refused("POPPED_ELSEWHERE", popped.message)
      publishViews()
      return { popped: viewState.popped() }
    })
    // While you were away: the gap from the last session's mark to the main
    // view's next open, from the journal, the P&L samples and three reads at start, kept until the next gap.
    // The doctor and the resource sampler attach as views that only read: never the main view.
    const isMainView = (client: { role: string; clientName: string }) => client.role === "view" && !client.clientName.includes("--pane") && !OBSERVER_CLIENTS.has(client.clientName)
    const awayHoldings = (): HoldingsSnapshot | undefined => {
      const view = portfolioNow()
      if (view.readAt === null) return undefined
      return {
        at: now(),
        readAt: view.readAt,
        wallets: view.wallets.map((w) => ({
          address: w.address,
          name: viewName(w),
          sol: w.native?.amount ?? null,
          ...(w.nativeSymbol !== "SOL" ? { native: w.nativeSymbol } : {}),
          tokens: w.tokens ? w.tokens.map((t) => ({ mint: t.mint, ...(t.symbol ? { symbol: t.symbol } : {}), amount: t.amount })) : null,
        })),
      }
    }
    const away = new AwayDesk({
      statePath: paths.awayState,
      now,
      redactor,
      rowsSince: (from, max) => rowsSince(from, { memory: () => j.rows(), tail: j.tail, path: j.path }, max),
      memoryRows: () => j.rows(),
      // Defined with the Journal's handlers below; a view attaches only once the server listens.
      symbolOf: (mint) => journalSymbol(mint),
      waitingCards: () => cards.list().filter((c) => c.state === "awaiting_approval").length,
      ready: () => candleStarted,
      agents: () => [...agentPrefixes()].map(([agent, prefix]) => ({ agent, prefix })),
      readPnl: () => pnl.readNow(),
      pnlFigure: (start, label) => pnl.figure({ start, label, mark: true }),
      pnlFailed: (agent) => pnl.failedWords(agent),
      // Each read at start is one the person asked for by opening the Candle Harness (key-budget.ts ask): it never waits.
      fills: async (agent, prefix) => {
        if (!pool.agents().includes(agent)) return { kind: "error", code: "NO_AGENT", retryable: false, body: { message: `${agent} has no Candle connection` } }
        budget.ask(agent)
        return pool.for(agent).call("candle_get_profile_trades", { keyPrefix: prefix, limit: AWAY_FILLS_LIMIT })
      },
      ...(config.hacc.enabled
        ? {
            // Hacc reads the account, not the key: the first key it takes.
            mine: async (after: string | undefined) => {
              let last: HaccAnswer = { kind: "refused", code: "HACC_NO_KEY", message: "Personal signals need an agent with a live key Hacc takes.", ms: 0 }
              for (const agent of keys.keys()) {
                last = await hacc.get(agent, "/v1/me/signals", { after, limit: AWAY_MINE_PAGE })
                if (last.kind === "ok" || (last.code !== "HACC_KEY_REFUSED" && last.code !== "HACC_NO_KEY")) return last
              }
              return last
            },
          }
        : {}),
      holdings: awayHoldings,
      // Each bot's own book: the Candle Harness's count from its fills.
      bots: (from, to) =>
        [...bots.entries(), ...codeBots.entries()].map((b) => {
          const r = botPositions.realizedBetween(b.name, from, to, b.mode)
          return { name: b.name, agent: b.agent, mode: b.mode, realizedUsd: r.valued ? Number(r.usd.toFixed(2)) : null, open: botPositions.open(b.name, b.mode).map((p) => ({ mint: p.mint, ...(symbolOf(p.mint) ? { symbol: symbolOf(p.mint)! } : {}) })) }
        }),
      publish: (view) => publish("away", view),
    })
    awayPortfolioRead = () => away.portfolioRead()
    s.events.provideSnapshot("away", () => away.view())
    s.handle("away.get", async () => away.view())
    s.onAttached((client) => {
      // A main view opening with none other open ends the gap; a second one shows the same summary.
      if (!isMainView(client) || s.clients().filter(isMainView).length !== 1) return
      void away.opened(client.clientId, sessionEnd).catch(() => {})
    })
    // A code bot connecting or dropping: the Bots tab says whether it's connected.
    s.onAttached((client) => {
      if (client.role === "bot") void publish("bots", botsTopic())
    })
    s.onDetached((client) => {
      if (client.role === "bot") void publish("bots", botsTopic())
      // A view that goes takes its Build panes with it: their harnesses were its children.
      if (client.role === "view") for (const [tokenId, b] of buildSessions) if (b.viewId === client.clientId) void closeBuild(tokenId).catch(() => {})
      if (client.role === "view" && viewState.unpop(client.clientId)) publishViews()
      if (client.role === "view") viewAsks.detached(client.clientId)
      // The main view closed: "since last session" runs from here next time, and the Away summary's gap starts here too.
      if (isMainView(client)) {
        // What the wallets hold now is "then" for the next Away summary.
        if (s.clients().filter(isMainView).length === 0) away.closed()
        sessionEnd = now()
        void saveWindowState(paths.pnlWindow, { ...(readWindowState(paths.pnlWindow).window ? { window: pnlWindow } : {}), sessionEnd }, now()).catch(() => {})
      }
    })
    // Which main view the agent's harness_view goes to: the one last used.
    s.handle("view.active", async (_params, call) => {
      viewAsks.used(call.client.clientId)
      return {}
    })
    s.handle("view.answer", async (params, call) => ({ taken: viewAsks.answer(call.client.clientId, params.id, params.result) }))
    // The person's click on an agent's change (keep, discard, undo, use it): for the record and Activity.
    s.handle("view.note", async (params, call) => {
      const agent = typeof params.agent === "string" && Object.hasOwn(config.agents, params.agent) ? params.agent : undefined
      const words = typeof params.words === "string" ? terminalText(params.words, { maxLength: 160 }).trim() : ""
      if (!agent || !words) throw invalidParams("agent names a configured agent, and words say what the person did.")
      await j.append({ type: "view.decided", mode, agent, by: call.client.clientId, words })
      return {}
    })
    // The person's own change to the tabs or a layout, for the record.
    s.handle("view.set", async (params, call) => {
      const words = typeof params.words === "string" ? terminalText(params.words, { maxLength: 160 }).trim() : ""
      if (!words) throw invalidParams("words say what the person changed.")
      await j.append({ type: "view.set", mode, by: call.client.clientId, words })
      return {}
    })
    // A tab renamed: its pin goes with it.
    s.handle("view.repin", async (params) => {
      const from = placeParam(params.from)
      const to = placeParam(params.to)
      if (!from || !to) throw invalidParams("from and to name tabs.")
      if (await viewState.move(from, to)) {
        tokenWatch.setPinned(viewState.pins())
        publishViews()
      }
      return { pins: viewState.pins(), signals: viewState.signals() }
    })
    // The P&L window: picked in settings ▾ or the palette, kept across a restart.
    s.handle("pnl.window", async (params, call) => {
      const parsed = parseWindow(params.window)
      if (!parsed.ok) throw invalidParams(`window: ${parsed.message}.`)
      if (parsed.window !== pnlWindow || readWindowState(paths.pnlWindow).window === undefined) {
        pnlWindow = parsed.window
        await saveWindowState(paths.pnlWindow, { window: pnlWindow, ...(sessionEnd !== undefined ? { sessionEnd } : {}) }, now())
        await j.append({ type: "pnl.window", mode, window: pnlWindow, by: call.client.clientId })
        publish("pnl", pnl.view())
        publishStatus?.()
      }
      return { window: pnlWindow }
    })
    // The chart's points: the Candle Harness's agents' total from the samples, a gap where there were none.
    s.handle("pnl.series", async (params) => {
      const from = typeof params.from === "number" && Number.isFinite(params.from) ? params.from : now() - 24 * 3_600_000
      const points = typeof params.points === "number" && Number.isInteger(params.points) && params.points >= 2 && params.points <= 1000 ? params.points : 120
      return { points: pnl.series(from, points) }
    })
    // The Journal: everything recorded, in words, a page at a time. A newer
    // query from the same view stops the one before it at its next slice (typing a search sends one a key).
    const journalAsked = new Map<string, number>()
    // A mint the core can't name now (a fresh core reads markets as asked) is named by the journal's own picks,
    // which record the symbol shown (else a restart leaves the paper rows as a cut-short mint). Words only:
    // nothing resolves a trade by it.
    const picked = new Map<string, string>()
    const notePick = (row: JournalRow) => {
      if (row.type === "view.picked" && typeof row.mint === "string" && typeof row.symbol === "string") picked.set(row.mint, row.symbol)
    }
    for (const row of j.rows()) notePick(row)
    j.onAppend(notePick)
    const journalSymbol = (mint: string) => wordName(mint) ?? tokenLabel(picked.get(mint), mint)
    const journalDeps = (current?: () => boolean): QueryDeps => ({ memory: () => j.rows(), tail: j.tail, path: j.path, redactor, symbolOf: journalSymbol, ...(current ? { current } : {}) })
    s.handle("journal.query", async (params, call) => {
      const problem = queryProblem(params)
      if (problem) throw invalidParams(problem)
      const asked = (journalAsked.get(call.client.clientId) ?? 0) + 1
      journalAsked.set(call.client.clientId, asked)
      return queryJournal(params as JournalQuery, journalDeps(() => journalAsked.get(call.client.clientId) === asked))
    })
    s.handle("journal.rows", async (params) => {
      if (!Array.isArray(params.seqs) || params.seqs.length > 200 || params.seqs.some((n) => !Number.isInteger(n))) throw invalidParams("seqs is a list of up to 200 row seqs.")
      return journalRows(params.seqs as number[], journalDeps())
    })
    s.handle("mode.set", async (params, call) => {
      mainViewOnly(call, "Switching between paper and live")
      if (params.mode !== "paper" && params.mode !== "live") throw invalidParams('mode is "paper" or "live".')
      if (params.mode !== mode) {
        mode = params.mode
        await saveMode(paths.modeState, mode, now())
        await j.append({ type: "mode.changed", mode, by: call.client.clientId })
        publishStatus?.()
        // How a trigger runs is said by its own mode and the mode now: the overlay's words follow the switch.
        void publish("triggers", triggers.view())
        // A trigger keeps the mode it was approved in: said at the switch, so a live stop isn't taken for a paper one.
        const other = triggers.live().filter((t) => triggers.modeOf(t) !== mode && triggers.resolved(t)?.action.kind === "command")
        if (other.length) {
          const kind = mode === "paper" ? "live" : "paper"
          const still = mode === "paper" ? "still real" : "still on paper"
          return { mode, said: other.length === 1 ? `1 ${kind} trigger stays as approved: its trades are ${still}.` : `${other.length} ${kind} triggers stay as approved: their trades are ${still}.` }
        }
      } else if (readSavedMode(paths.modeState) !== mode) {
        // The mode the core is already on, picked: saved all the same, so a setup in progress keeps it (setupGoesLive).
        await saveMode(paths.modeState, mode, now())
        void publishOnboarding().catch(() => {})
      }
      return { mode }
    })
    s.handle("agent.setActive", async (params, call) => {
      onlyLooks(call)
      const agent = params.agent
      if (typeof agent !== "string" || !Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      activeAgent = agent
      await j.append({ type: "agent.active", mode, agent, by: call.client.clientId })
      await saveAgent(paths.activeState, agent, now()).catch(() => {})
      publishStatus?.()
      return { activeAgent }
    })
    s.handle("cli.run", async (params, call) => {
      mainViewOnly(call, "Running a candle command")
      // One key made at a time (setup's "Make the key" pressed twice made two keys, and the second was left live).
      const argv = Array.isArray(params.argv) ? params.argv : []
      if (argv[0] === "keys" && argv[1] === "create" && [...panes.values()].some((p) => p.pane.row === "keys create" && operations.get(p.opId)?.state === "pending")) {
        throw refused("KEY_BEING_MADE", "A key is being made in the pane now: finish or close that first. Nothing was run.")
      }
      if (argv[0] === "keys" && argv[1] === "create") keyRefused = undefined
      return cliTool.runTyped(call.client.clientId, params.argv, typeof params.agent === "string" ? params.agent : call.agent)
    })
    s.handle("kill", async (_params, call) => killSwitch.kill(call.client.clientId))
    s.handle("resume", async (_params, call) => (mainViewOnly(call, "Resuming after the kill switch"), killSwitch.resume(call.client.clientId)))
    s.handle("agent.send", async (params, call) => {
      if (Object.keys(config.agents).length === 0) throw refused("NO_AGENT_YET", "There's no agent yet: finish setting up first, and your message goes to it then.")
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      // `candle-harness ask`: the person's own message from outside, under the same rules, marked as from outside.
      const outside = call.client.clientName === ASK_CLIENT
      return { agent, ...(await engine.send(agent, params.text, call.client.clientId, { outside })) }
    })
    s.handle("agent.cancel", async (params, call) => {
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      // The press itself, for the record (with only the cancelled turn journalled, a stop's speed couldn't be read).
      if (Object.hasOwn(config.agents, agent)) await j.append({ type: "agent.stop_asked", mode, agent, by: call.client.clientId })
      return engine.cancel(agent, { keepQueued: params.keepQueued === true })
    })
    const engineNamed = (id: unknown): Engine => {
      if (!isEngineId(id)) throw refused("UNKNOWN_ENGINE", `There's no engine named ${JSON.stringify(id)}.`)
      const e = engines.get(id)
      if (!e) throw refused("ENGINE_NOT_IN_BUILD", `${ENGINE_LABELS[id]} isn't in this build yet.`)
      return e
    }
    // The picker asks twice as it opens: the list last read (at once, when there is one), then `fresh`.
    // A harness installed after the core started (Claude Code installed while onboarding was open had
    // stayed "not installed"): checked again only when its last check failed, so one that runs costs nothing.
    // A missing binary fails at once; one just installed is spawned for its version once.
    // `again`: checked even when the last check passed, for a harness that may have updated itself (the Build pane's
    // harnesses do), its version and sign-in read afresh.
    const recheck = async (id: EngineId, again = false): Promise<void> => {
      if (engine.lastCheck(id)?.ok && !again) return
      const was = engine.lastCheck(id)
      const wasSigned = signedIn.get(id)
      const check = await engine.check(id, true).catch(() => undefined)
      noteNewerMajor(id)
      // Its models are read again only when it's newly there or a new version; the same one has its sign-in read.
      const changed = check?.ok !== was?.ok || check?.version !== was?.version
      const e = engines.get(id)
      if (check?.ok && changed) await readEngine(id).catch(() => undefined)
      else if (check?.ok && e?.signedIn) signedIn.set(id, await e.signedIn(harnessEnv(opts.env)).catch(() => undefined))
      if (check?.ok !== was?.ok || check?.version !== was?.version || signedIn.get(id) !== wasSigned) publish("engine", engineView())
    }
    s.handle("engine.check", async (params) => {
      const e = engineNamed(params.engine)
      await recheck(e.id, params.again === true)
      return { engine: e.id, check: engine.lastCheck(e.id) ?? null }
    })
    s.handle("engine.models", async (params) => {
      const e = engineNamed(params.engine)
      const fresh = params.fresh === true
      // One that runs is checked again behind the answer (it may have updated itself); one that failed, before it.
      if (fresh && engine.lastCheck(e.id)?.ok) void recheck(e.id, true).catch(() => {})
      else if (fresh) await recheck(e.id)
      const list = await models.read(e.id, { fresh })
      if (fresh && e.signedIn) {
        signedIn.set(e.id, await e.signedIn(harnessEnv(opts.env)).catch(() => undefined))
        publish("engine", engineView())
      }
      return { engine: e.id, models: list.models, ...(list.notes.length ? { notes: list.notes } : {}), readAt: list.readAt, ...(list.error ? { error: list.error } : {}) }
    })
    s.handle("engine.choose", async (params, call) => {
      onlyLooks(call)
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      if (!Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      const e = engineNamed(params.engine)
      const model = params.model
      if (model !== undefined && (typeof model !== "string" || model.length === 0 || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model))) {
        throw invalidParams("model is a model id of at most 200 characters, or left out for the engine's own default.")
      }
      const check = await engine.check(e.id)
      if (!check?.ok) throw refused("ENGINE_CANT_RUN", check?.message ?? `${e.label} couldn't be checked.`)
      await engineState.set(agent, { engine: e.id, ...(model ? { model } : {}) }, now())
      // None picked: the engine's default by name, from its list, if none has been read yet.
      if (!model && e.defaultModel?.() === undefined) void models.read(e.id).catch(() => undefined)
      await j.append({ type: "engine.chosen", mode, agent, engine: e.id, model: model ?? null, by: call.client.clientId })
      publish("activity", { kind: "engine.chosen", agent, engine: e.id, model: model ?? null, text: `${agent} now on ${e.label}${model ? ` · ${model}` : ""}` })
      publish("engine", engineView())
      return { agent, engine: e.id, ...(model ? { model } : {}) }
    })
    // The agent's preset: the person's choice, from the agent's next turn.
    s.handle("preset.choose", async (params, call) => {
      onlyLooks(call)
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      if (!Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      const preset = params.preset
      if (!isPreset(preset)) throw invalidParams(`preset is ${PRESETS.map((p) => `"${p}"`).join(", ").replace(/, ([^,]+)$/, " or $1")}.`)
      await engineState.setPreset(agent, preset, now())
      await j.append({ type: "preset.chosen", mode, agent, preset, by: call.client.clientId })
      publish("activity", { kind: "preset.chosen", agent, preset, text: `${agent} now runs as ${PRESET_LABELS[preset]}` })
      publish("engine", engineView())
      return { agent, preset }
    })
    // The code runner for an agent, turned on or off by the person from the picker or the palette: written into its
    // own [agents.<name>.tools] table and used from its next turn. On writes the documented programs found here.
    s.handle("agent.run", async (params, call) => {
      mainViewOnly(call, "Turning the code runner on or off")
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      if (!Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      if (typeof params.on !== "boolean") throw invalidParams("on is true or false.")
      if (params.on && !runHold.ok) throw refused("NOT_HELD", `The code runner can't be held on this machine: ${runHold.why}. It needs ${runHold.fix}.`)
      const found = RUN_EXAMPLE.filter((p) => Bun.which(p, { PATH: opts.env.PATH ?? "/usr/bin:/bin" }))
      if (params.on && found.length === 0) throw refused("NOT_INSTALLED", `None of ${RUN_EXAMPLE.join(", ")} is installed here, so there's nothing for the code runner to run.`)
      const run = params.on ? found : ("off" as const)
      const recorded = await recordAgentRun(paths, agent, run)
      if (!recorded.ok) throw refused("NOT_RECORDED", `${recorded.why.charAt(0).toUpperCase()}${recorded.why.slice(1)}. Nothing changed.`)
      const was = config.agents[agent]!.tools
      config.agents[agent] = { ...config.agents[agent]!, tools: { ...DEFAULT_TOOLS, ...was, ...(run === "off" ? { run: "off" } : { run }) } }
      sawConfig()
      await j.append({ type: "tools.run", mode, agent, run, by: call.client.clientId })
      publish("activity", { kind: "tools.run", agent, text: run === "off" ? `${agent}'s code runner is off` : `${agent}'s code runner is on for ${runWords(run)}, held to its research folder with no network` })
      publish("engine", engineView())
      return { agent, run }
    })
    // Skill folders of the person's own: read as settings ▾ → skills opens, and turned on or off there.
    s.events.provideSnapshot("skills", () => skillFolders.topic())
    // Keep-awake: the person's, from the main view; the choice is kept in state.
    s.handle("core.keepAwake", async (params, call) => {
      mainViewOnly(call, "Keeping the Mac awake")
      if (typeof params.on !== "boolean") throw invalidParams("on is true or false.")
      if (!keepAwake.available()) throw refused("NOT_MACOS", "Keep-awake is macOS only: it keeps a Mac from sleeping while a trigger or bot is on.")
      keepAwake.set(params.on)
      keepAwake.update(keptUp())
      await j.append({ type: "core.keep_awake", mode, on: params.on, by: call.client.clientId })
      publish("activity", { kind: "core.keep_awake", text: params.on ? "the Mac is kept awake while a trigger or bot is on" : "keep-awake is off: the Mac may sleep while triggers or bots are on" })
      publishStatus?.()
      return keepAwake.view()
    })
    s.handle("skills.read", async () => {
      const topic = skillFolders.topic()
      publish("skills", topic)
      return topic
    })
    s.handle("skills.set", async (params, call) => {
      mainViewOnly(call, "Choosing which skill folders the agents use")
      const folder = typeof params.folder === "string" ? params.folder : ""
      if (!(folder.startsWith("~/") || folder.startsWith("/")) || /[\x00-\x1f]/.test(folder)) throw invalidParams("folder is a folder from / or ~/, such as ~/.claude/skills.")
      if (typeof params.on !== "boolean") throw invalidParams("on is true or false.")
      skillFolders.set(folder, params.on)
      await j.append({ type: "skills.folder", mode, folder, on: params.on, by: call.client.clientId })
      const topic = skillFolders.topic()
      const f = topic.folders.find((x) => x.shown === folder)
      publish("activity", { kind: "skills.folder", text: params.on ? `the agents now use the skills in ${folder} (${f?.count ?? 0})` : `the agents no longer use the skills in ${folder}` })
      publish("skills", topic)
      return topic
    })
    // The person's deletes from an agent's memory (a line of its index, a file, or all of it), and their pins.
    s.events.provideSnapshot("memory", memoryTopic)
    // Read fresh as the overlay opens, so a file the person edited in their own editor shows.
    s.handle("memory.read", async () => {
      const topic = memoryTopic()
      publish("memory", topic)
      return topic
    })
    s.handle("memory.delete", async (params, call) => {
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      if (!Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      const done = await memory.delete(agent, call.client.clientId, { entry: params.entry, file: params.file, all: params.all })
      if (!done.ok) throw refused(done.code, done.message)
      return { agent, view: memory.view(agent) }
    })
    // The person's pin or unpin of a line: it moves under the index's ## Pinned, or out from under it.
    s.handle("memory.pin", async (params, call) => {
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      if (!Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      if (typeof params.pinned !== "boolean") throw invalidParams("pinned is true to pin the line, false to unpin it.")
      const done = await memory.pin(agent, call.client.clientId, params.entry, params.pinned)
      if (!done.ok) throw refused(done.code, done.message)
      return { agent, view: memory.view(agent) }
    })
    s.handle("harness.register", async (params, call) => {
      // The tests' way to attach a harness by hand. A shipped build attaches one only for an agent's turn.
      if (SHIPPED) throw refused("NOT_IN_THIS_BUILD", "harness.register is only in the Candle Harness's test builds: a shipped core attaches a harness only for an agent's turn.")
      const name = typeof params.name === "string" ? params.name.slice(0, 64) : "harness"
      const agent = typeof params.agent === "string" ? params.agent : activeAgent
      if (!Object.hasOwn(config.agents, agent)) throw refused("UNKNOWN_AGENT", "No agent by that name is configured.")
      const minted = await tokens.mintHarness(name, agent)
      await j.append({ type: "harness.registered", mode, agent, by: call.client.clientId, tokenId: minted.tokenId })
      // The token is returned exactly once, here, to the view that asked.
      return minted
    })
    // The prompt pane's methods (docs.candle.tv/harness/developers/attach-protocol, "The prompt pane").
    s.handle("pane.spawned", async (params, call) => {
      tickets.spawned(params.ticketId, call.client.clientId, params.pid)
      await j.append({ type: "pane.spawned", mode, ticketId: String(params.ticketId), pid: params.pid as number, by: call.client.clientId })
      return { ok: true }
    })
    s.handle("pane.redeem", async (_params, call) => {
      const ticketId = call.client.ticketId!
      const entry = tickets.redeem(ticketId)
      // A harness's own sign-in: the fixed command, as the person, with no Candle key or profile.
      if (entry.grant.harness) {
        await j.append({ type: "pane.redeemed", mode, ticketId, harness: entry.grant.harness })
        const note = HARNESS_SIGN_INS[entry.grant.harness].typeThis
        return { title: entry.grant.title, bin: entry.grant.bin, steps: entry.grant.steps, identity: "owner", harness: entry.grant.harness, ...(note ? { note: asSentence(note) + "." } : {}) }
      }
      const card = cards.get(entry.cardId)
      // Bound to the hash: the card as it stands must still hash to what was approved, so a changed
      // argv, identity, agent or step is refused, and nothing runs.
      const now_ = card ? hashCard({ kind: card.kind, tool: card.tool, params: card.params, opId: card.opId, account, agent: card.agent, wallet: card.wallet, mode: card.mode, route: "pane" }) : undefined
      if (!card || card.state !== "approved" || card.cardHash !== entry.cardHash || now_ !== entry.cardHash) {
        await settlePane(ticketId, { outcome: "refused_before", words: "the card changed after it was approved. Nothing was run.", code: "CARD_CHANGED" })
        throw refused("CARD_CHANGED", "The card changed after it was approved. Nothing was run.")
      }
      const pane = (card.params as unknown as PaneParams).pane
      const apiKey = pane.identity === "agent" ? keys.get(pane.agent ?? "") : undefined
      if (pane.identity === "agent" && apiKey === undefined) {
        await settlePane(ticketId, { outcome: "refused_before", words: `${pane.agent ?? "the agent"} has no key in the Candle Harness any more. Nothing was run.`, code: "UNKNOWN_AGENT" })
        throw refused("UNKNOWN_AGENT", "That agent has no key in the Candle Harness. Nothing was run.")
      }
      // A card made with no vault is read again as its pane starts. A vault there now (or a
      // read that didn't answer) puts the factor back on; a vault gone after the mark refuses it.
      let steps = pane.steps
      let title = entry.grant.title
      if (pane.noVault) {
        const vault = await cliTool.vaultState()
        if (vault === "missing" && vaultMark.seen()) {
          await settlePane(ticketId, { outcome: "refused_before", words: `${VAULT_GONE} Nothing was run.`, code: "VAULT_GONE" })
          throw refused("VAULT_GONE", `${VAULT_GONE} Nothing was run.`)
        }
        if (vault !== "missing") {
          steps = [{ stage: "factor", argv: [...FACTOR_ARGV] }, ...pane.steps]
          title = paneTitle({ pane: { ...pane, noVault: undefined } } as PaneParams)
          await j.append({ type: "pane.factor_added", mode, ...(pane.agent ? { agent: pane.agent } : {}), ticketId, cardId: card.cardId, opId: card.opId, vault })
        }
      }
      panes.get(ticketId)!.redeemed = true
      await j.append({ type: "pane.redeemed", mode, ...(pane.agent ? { agent: pane.agent } : {}), ticketId, cardId: card.cardId, opId: card.opId })
      const answer = {
        title,
        bin: entry.grant.bin,
        // The card's steps name the configured RPC by a marker: the address goes in here, to the launcher alone.
        steps: steps.map((step) => ({ ...step, argv: candleCli.realArgs(step.argv) })),
        identity: pane.identity,
        ...(pane.agent ? { agent: pane.agent } : {}),
        ...(pane.askPaths ? { askPaths: pane.askPaths } : {}),
        ...(pane.capture ? { capture: pane.capture } : {}),
        ...(pane.rule === "funds-out" ? { fundsOut: true } : {}),
        // Still no vault as the pane starts: the launcher says so before the command.
        ...(pane.noVault && steps === pane.steps ? { noVault: true } : {}),
        // A typed line opens the pane with no card, so the plan renewal the CLI pays first is said there.
        ...(pane.renews ? { renews: pane.renews } : {}),
        // The profile every `candle` run acts as: the launcher runs it as the core's runs do.
        ...(candleProfile ? { profile: candleProfile } : {}),
        // The EVM RPC from config, as the core's own runs get it: in the CLI's variable, never on a command line.
        ...(config.candle.evmRpcUrl ? { evmRpcUrl: config.candle.evmRpcUrl } : {}),
        // The core's own home: the pane's environment drops CANDLE_HARNESS_*, so the launcher can't find it otherwise.
        ...(pane.newAgent ? { newAgent: pane.newAgent, home: paths.configDir } : {}),
      }
      // The one answer besides harness.register's that carries a secret: the agent's key, once, to this launcher.
      return new WithSecret(answer, apiKey !== undefined ? { apiKey } : {})
    })
    s.handle("pane.report", async (params, call) => {
      const ticketId = call.client.ticketId!
      const harness = harnessPanes.get(ticketId)
      if (harness) {
        harnessPanes.delete(ticketId)
        const report = paneReportFrom(params)
        const finished = report?.exit === 0 && !report.stopped
        await j.append({ type: "onboarding.harness_ended", mode, engine: harness, ticketId, ...(report?.exit !== undefined ? { exit: report.exit } : {}), ...(report?.stopped ? { stopped: true } : {}) })
        // Read again whatever happened: a sign-in can land even when the harness exits non-zero.
        await engine.check(harness, true).catch(() => undefined)
        await readEngine(harness).catch(() => undefined)
        publish("engine", engineView())
        const label = ENGINE_LABELS[harness]
        return { outcome: finished ? "finished" : report?.stopped ? "stopped" : "didnt_finish", words: finished ? `${label}'s sign-in finished: the Candle Harness read ${label} again.` : `${label}'s sign-in didn't finish: nothing was stored by the Candle Harness. Try again, or pick another engine.` }
      }
      const open = panes.get(ticketId)
      if (!open?.redeemed) throw refused("NOT_REDEEMED", "Redeem the ticket first.")
      const report = paneReportFrom(params)
      if (!report) throw invalidParams("A report is {stage, exit?, signal?, code?, stopped?}.")
      const spec = rowFor(open.pane.row)?.pane
      const result = paneOutcome(report, { fundsOut: open.pane.rule === "funds-out", ...(spec?.reveals ? { reveals: spec.reveals } : {}), ...(spec?.exit3 ? { exit3: spec.exit3 } : {}) })
      await settlePane(ticketId, result, open.pane.capture ? report.captured : undefined)
      const told = operations.get(open.opId)?.result as { pane?: PaneResult } | undefined
      return { outcome: told?.pane?.outcome ?? result.outcome, words: told?.pane?.words ?? result.words }
    })
    // A pane whose connection ended with no report: nobody saw how the step ended.
    s.onPaneClosed((ticketId) => {
      if (harnessPanes.has(ticketId)) {
        const harness = harnessPanes.get(ticketId)!
        harnessPanes.delete(ticketId)
        void Promise.resolve(engine.check(harness, true))
          .then(() => readEngine(harness))
          .then(() => publish("engine", engineView()))
          .catch(() => {})
        return
      }
      void settlePane(ticketId, NO_REPORT).catch(() => {})
    })

    s.onViewCount((count) => {
      if (count > 0) {
        prices.start()
        tokenWatch.start()
        feeds.start()
        research.start()
        walletsTimer ??= setInterval(refreshWallets, WALLETS_REFRESH_MS)
        walletsTimer.unref?.()
        emptyAccounts.start()
      } else {
        prices.stop()
        tokenWatch.stop()
        feeds.stop()
        research.stop()
        if (walletsTimer) clearInterval(walletsTimer)
        walletsTimer = undefined
        emptyAccounts.stop()
      }
      publishStatus?.()
    })

    await s.listen()
    // Code bots run once the socket they connect to listens: what an earlier core left running is ended first.
    if (opts.supervise !== false) {
      supervisor = new Supervisor({
        statePath: paths.supervisorState,
        logsDir: paths.botLogsDir,
        socketPath: paths.socket,
        journal: j,
        mode: () => mode,
        now,
        parentEnv: opts.env,
        redact: (text) => redactor.text(text),
        names: () => [...new Set([...codeBots.entries().map((b) => b.name)])],
        wanted: (name) => {
          const b = codeBots.entry(name)
          const v = codeBots.approvedVersion(name)
          if (!b || !v) return { start: false, keep: false, why: `"${name}" isn't approved here: propose it from the Build tab, and approve its card` }
          const spec = { folder: v.run.folder, command: v.run.command, agent: v.run.agent }
          // Every start checks where its folder really is now: a link changed since its card can't move it into ours.
          const place = folderPlace(v.run.folder)
          if (place) return { start: false, keep: false, spec, why: place }
          if (codeBots.runState(b) === "stopped") return { start: false, keep: false, spec, why: "it's stopped: put it back on from the Bots tab, in the main window" }
          const held = codeBots.heldBy(b)
          if (held && !held.sells) return { start: false, keep: false, spec, why: held.words }
          const no = codeBots.admits(name)
          return no ? { start: false, keep: true, spec, why: no.message } : { start: true, keep: true, spec }
        },
        issueToken: (name, why) => codeBots.issueToken(name, why),
        endToken: (name, why) => codeBots.endToken(name, why),
        hasToken: (name) => tokens.botToken(name) !== undefined,
        onChange: () => void publish("bots", botsTopic()),
        ...(opts.supervise ? { tuning: opts.supervise } : {}),
      })
      void supervisor.start().catch(async (error) => {
        await j.append({ type: "bot.process", mode, kind: "code", what: "supervisor_failed", words: String(error) }).catch(() => {})
      })
    }
    await j.append({ type: "core.started", mode, modeFrom: starting.from, pid: process.pid, coreId, coreVersion: VERSION, headless: opts.headless, agents: [...keys.keys()], ...(losesNextReply(opts.env) ? { debugLoseNextReply: true } : {}) })
    cards.start()
    tickets.start()

    // Candle, in the background: each child can hold its start for 15 s.
    const candleReady = (async () => {
      await pool.start()
      // What a past core left unknown, read back by its id now that there's a Candle to ask.
      operations.readBack()
      for (const agent of pool.agents()) {
        await wallets.refresh(agent) // its status read first, then its TEE wallets
        const unknown = unclassifiedTools(pool.for(agent).tools().map((t) => t.name))
        if (unknown.length > 0) await j.append({ type: "candle.unclassified_tools", mode, agent, tools: unknown })
      }
      publishStatus?.()
      publishPortfolio?.()
      plans.noticeChanges()
      plans.start()
      pnl.start()
      triggerWatch?.start()
    })()
      .catch(async (error) => {
        await j.append({ type: "candle.start_failed", mode, error: String(error) }).catch(() => {})
      })
      .finally(() => candleUp())

    // The idle rule.
    const idle = new IdleWatch({ headless: opts.headless, idleMs: opts.idleExitMs ?? IDLE_EXIT_MS })
    let stopping: Promise<void> | undefined
    const personViews = () => s.clients().filter((c) => c.role === "view" && !OBSERVER_CLIENTS.has(c.clientName))
    holdWords = () => {
      const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
      const on = triggers.keepingUp().length
      const running = botsUp().length
      const views = personViews().length
      const open = cards.list().filter((c) => c.state === "awaiting_approval").length
      return [
        ...(running ? [`${n(running, "bot")} running`] : []),
        ...(on ? [`${n(on, "trigger")} on`] : []),
        ...(views ? [`${n(views, "view")} attached`] : []),
        ...(tokens.harnessCount() > 0 || engine.busy() ? ["an agent's turn"] : []),
        ...(operations.busy() ? ["a trade or step in flight"] : []),
        ...(open ? [`${n(open, "card")} waiting`] : []),
      ]
    }
    const holds = () => personViews().length > 0 || tokens.harnessCount() > 0 || engine.busy() || operations.busy() || cards.list().some((c) => c.state === "awaiting_approval") || keptUp()
    const idleTimer = setInterval(() => {
      // Keep-awake follows the triggers and bots here too: a plan read or an agent removed changes what keeps the core up.
      keepAwake.update(keptUp())
      if (idle.tick(now(), holds(), keys.size === 0 ? Math.min(IDLE_EXIT_NO_AGENTS_MS, opts.idleExitMs ?? IDLE_EXIT_MS) : undefined)) void stop("idle")
    }, opts.idleTickMs ?? 1_000)
    idleTimer.unref?.()

    const stop = (reason: string): Promise<void> => {
      stopping ??= (async () => {
        clearInterval(idleTimer)
        clearInterval(modelsTimer)
        if (botsSoon) clearTimeout(botsSoon)
        if (walletsTimer) clearInterval(walletsTimer)
        await engine.stop()
        cards.stop()
        tickets.stop()
        operations.stop()
        prices.stop()
        tokenWatch.stop()
        feeds.stop()
        research.stop()
        emptyAccounts.close()
        pnl.stop()
        triggerWatch?.stop()
        botEntries?.stop()
        botPositions.flush()
        keepAwake.stop()
        triggerFirer?.stop("the core stopped")
        // A planned stop, said to every view first, so none tells the person the core stopped unexpectedly.
        await notifier.stop()
        for (const c of s.clients()) if (c.role === "view") publish("notices", { stopping: reason }, c.clientId)
        // Each connected code bot hears it too: its connection ends with the core.
        for (const c of s.clients()) if (c.role === "bot" && c.bot) publish("bot", { kind: "stopping", words: `The core is stopping (${reason}): your connection ends now, and nothing of yours is sent until it's back.` }, c.clientId)
        // Each supervised code bot's process ends with it, and starts again with the next core.
        await supervisor?.stopAll(reason).catch(() => {})
        away.stop()
        plans.stop()
        haccChanges.stop()
        await signals.stop()
        await botSignals.stop()
        await s.close()
        await pool.stop()
        await pnlSamples.flush()
        await away.flush()
        await botEntries?.flush().catch(() => {})
        await triggerWatch?.flushSkips().catch(() => {})
        await j.append({ type: "core.stopped", mode, reason }).catch(() => {})
        await j.close()
        // A core started while this one was stopping may hold the lock, the socket and the view token by now: only ours go.
        if (await lock.held()) {
          await rm(paths.socket, { force: true })
          await rm(paths.viewToken, { force: true })
        }
        await lock.release()
        opts.onStopped?.(reason)
      })()
      return stopping
    }

    return { server: s, cards, operations, pool, engine, journal: j, wallets, destinations, hacc, plans, signals, pnl, autonomy: autonomyDesk, emptyAccounts, lines, triggers, bots, codeBots, tokens, botEntries: entries, botExits: exits, failedSells, tradePace, routeWaits, watchBeat: async () => void (await triggerWatch?.beat()), botSignals, account, coreId, candleReady, stop }
  } catch (error) {
    await journal?.close().catch(() => {})
    await lock.release()
    throw error
  }
}

/** A launcher's report, checked for shape: anything else is refused. */
export function paneReportFrom(params: Record<string, unknown>): PaneReport | undefined {
  const { stage, exit, signal, code, stopped, captured } = params
  if (stage !== "factor" && stage !== "paths" && stage !== "preview" && stage !== "command") return undefined
  if (exit !== undefined && (typeof exit !== "number" || !Number.isInteger(exit) || exit < 0 || exit > 255)) return undefined
  if (signal !== undefined && (typeof signal !== "string" || !/^SIG[A-Z0-9]{2,8}$/.test(signal))) return undefined
  if (code !== undefined && (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code))) return undefined
  if (stopped !== undefined && typeof stopped !== "boolean") return undefined
  const caught = captured === undefined ? undefined : capturedFrom(captured)
  if (captured !== undefined && caught === undefined) return undefined
  return { stage, ...(caught ? { captured: caught } : {}), ...(exit !== undefined ? { exit: exit as number } : {}), ...(signal !== undefined ? { signal: signal as string } : {}), ...(code !== undefined ? { code: code as string } : {}), ...(stopped ? { stopped: true } : {}) }
}

/** At most this many of `vault list`'s entries are taken back. */
const MAX_CAPTURED_ADDRESSES = 500
/** A wallet's address on either family's chains: `tee disable` and `tee sweep` take a Hood TEE wallet's `0x` address too. */
const isAddress = (word: string) => familyOfAddress(word) !== undefined
const CAPTURED_ADDRESS = new RegExp(`^(${EVM_ADDRESS_SOURCE}|${LOOSE_SOLANA_ADDRESS_SOURCE})$`)

/** `vault list`'s capture: each entry's address, label and role, and nothing else. */
function capturedAddresses(value: unknown): Captured["addresses"] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CAPTURED_ADDRESSES) return undefined
  const out: NonNullable<Captured["addresses"]> = []
  for (const e of value) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return undefined
    const { address, label, role, ...rest } = e as Record<string, unknown>
    if (Object.keys(rest).length > 0) return undefined
    if (typeof address !== "string" || !CAPTURED_ADDRESS.test(address)) return undefined
    if (label !== undefined && (typeof label !== "string" || label.length > 64 || /[\x00-\x1f\x7f]/.test(label))) return undefined
    if (role !== "vault" && role !== "tee-wallet") return undefined
    out.push({ address, ...(label !== undefined ? { label } : {}), role })
  }
  return out
}

/** A capture's shape: a key's prefix, an agent's name and whether it was stored, a code, or `vault list`'s addresses and labels. Nothing else. */
function capturedFrom(value: unknown): Captured | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const { prefix, agent, stored, code, addresses, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0) return undefined
  const listed = addresses === undefined ? undefined : capturedAddresses(addresses)
  if (addresses !== undefined && listed === undefined) return undefined
  // Candle's prefixes are base64url, `-` and `_` included (a prefix with a `-` once failed a letters-and-digits
  // check, the whole report was dropped, and a key the launcher had stored was called "not stored").
  if (prefix !== undefined && (typeof prefix !== "string" || !/^[A-Za-z0-9_-]{4,32}$/.test(prefix))) return undefined
  if (agent !== undefined && (typeof agent !== "string" || !isAgentName(agent))) return undefined
  if (stored !== undefined && typeof stored !== "boolean") return undefined
  if (code !== undefined && (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code))) return undefined
  return { ...(prefix !== undefined ? { prefix } : {}), ...(agent !== undefined ? { agent } : {}), ...(stored !== undefined ? { stored } : {}), ...(code !== undefined ? { code } : {}), ...(listed ? { addresses: listed } : {}) }
}
