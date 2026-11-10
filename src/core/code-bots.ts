// Code bots in the core: the person's own program, kept in bots.toml with `kind = "code"`. The core starts it in its
// folder with its command, and it trades only through the core, with a bot token, never its agent's key.
//
// - What its card approves is its run settings, not its code: its folder and command, its agent and the wallet it
//   pays from, paper or live, and the figures the core holds it to whatever its code does (per trade, per day, open
//   at most) with its slippage bound. The hash binds those. Editing its code needs no card.
// - Nothing makes one, raises a figure, takes one live, changes its wallet, folder or command, or resumes one but the
//   person's press: `save` runs only for an approved card, bound by its hash. Lowering a figure, or tightening its
//   slippage bound no further than the route's default, is at once, as is pausing. Stopping, resuming as approved and removing are the person's, from
//   the main view.
// - What it does is on, paused (its buys refused; its sells of its own still run) or stopped (none of its trades
//   run). bots.toml and the core each say, and the stricter holds, so a pause or a stop typed into the file always
//   takes, and only the person's own resume takes it back.
// - The state (state/code-bots.json, 0600) keeps the hash each bot was approved as, so a hand edit can't widen one
//   unseen: one that doesn't match has its buys held until it's approved again, and its sells run by what was
//   approved. Without the file, it's rebuilt from the journal's code bot rows, which carry each version whole.
// - Code bots need Pro or Max, as rules bots and triggers do: on Free none is proposed, its buys are held, and a bot
//   token is refused. A plan that ends holds every code bot's buys; its sells still run.
// - Its token (`chb_…`, tokens.ts) is issued when it's handed to the bot, and each issue replaces the one before. A
//   bot removed has its token revoked, as has one whose process the core ran and ended (stopped, given up on, or
//   ended on its own), and one run outside whose approved folder or command changed.
// - A Build pane can test a bot's code on paper before it's proposed: a test run is a code bot of the pane's agent named
//   `test:<folder>`, kept in memory only, never in bots.toml, never started by the supervisor and never live. It runs
//   with a token of its own under figures of its own, and ends when its command does, when its Build pane closes, or
//   after 30 minutes, whichever is first; its token is revoked then.
import { sharedWithWords, TEST_PREFIX } from "../shared/bot-name"
import type { BotControl, BotReport } from "./bot-report"
import type { BotProcessView } from "./supervisor"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { canonicalJson } from "../shared/canonical-json"
import { refused } from "../shared/rpc"
import { PLAN_FIX } from "../shared/trigger-grammar"
import { slippageProblem, underDefaultWords } from "../shared/definition-narrow"
import { BOTS_PLAN_WORDS, routeSlippageBps, slippageOnCard } from "./bots"
import { type BotRunState, botNameProblem, type BotsFileStore, type CodeBotEntry, commandProblem, figuresProblem, folderProblem } from "./bots-file"
import type { Mode } from "./classify"
import type { BotCardInput, BotRuns, BotSpec } from "./bots-tool"
import type { Journal, JournalRow } from "./journal"
import { usd } from "./limits"
import type { HaccPlan } from "./plan-state"
import { type PayWalletInfo, theWallet } from "./triggers"
import { short } from "./wallet-names"

/** On a code bot's card and its view: what the person approves, and what they don't. */
export const CODE_BOT_HOLDS = "The core holds this bot to these figures. What it trades inside them is its code's."

/** What a code bot's card approves, and its hash binds. */
export interface CodeRunSettings {
  agent: string
  /** The paying wallet's address, or `embedded`. */
  wallet: string
  mode: "paper" | "live"
  folder: string
  command: string[]
  perTradeUsd: number
  perDayUsd: number
  maxOpen: number
  maxSlippageBps?: number
}

export const codeRunOf = (b: Omit<CodeBotEntry, "kind" | "name" | "state">): CodeRunSettings => ({
  agent: b.agent,
  wallet: b.wallet,
  mode: b.mode,
  folder: b.folder,
  command: [...b.command],
  perTradeUsd: b.perTradeUsd,
  perDayUsd: b.perDayUsd,
  maxOpen: b.maxOpen,
  ...(b.maxSlippageBps !== undefined ? { maxSlippageBps: b.maxSlippageBps } : {}),
})

/** A code bot's run settings, hashed: what its card binds. Its name isn't in it, as a rules bot's isn't. */
export function codeBotHash(run: CodeRunSettings): string {
  const r = codeRunOf(run)
  return createHash("sha256")
    .update(canonicalJson({ kind: "code", ...r, maxSlippageBps: r.maxSlippageBps ?? null }), "utf8")
    .digest("hex")
}

/** A folder as the person reads it: their home as `~`. */
export function folderShown(folder: string, home = homedir()): string {
  return home && home !== "/" && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder
}

/** A command as a line, each word quoted only where it needs it. */
export function commandShown(command: readonly string[]): string {
  return command.map((w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : JSON.stringify(w))).join(" ")
}

/** Its figures, short: "$2.00 a trade · $10.00 a day · 3 open at most". */
export function figuresShort(f: Pick<CodeRunSettings, "perTradeUsd" | "perDayUsd" | "maxOpen">): string {
  return `${usd(f.perTradeUsd)} a trade · ${usd(f.perDayUsd)} a day · ${f.maxOpen} open at most`
}

/** At worst, every slot open at a trade's figure. */
export function codeWorstShort(f: Pick<CodeRunSettings, "perTradeUsd" | "maxOpen">): string {
  return f.maxOpen === 1 ? `one open at ${usd(f.perTradeUsd)}, plus Candle's fee` : `${f.maxOpen} open at ${usd(f.perTradeUsd)}: ${usd(f.perTradeUsd * f.maxOpen)} at risk, plus Candle's fee`
}

/**
 * How a code bot's trades will run: on paper with no card; or live, its buys and swaps through the wallet's figures
 * (inside them with a receipt, over them or on a wallet that asks as a card for the person) and its sells of what it
 * bought with no card on any wallet, since the person approves them with the bot. Every trade is held to its figures.
 */
export function codeBotRuns(run: Pick<CodeRunSettings, "mode">, pays: PayWalletInfo | undefined): BotRuns {
  if (run.mode === "paper") return { kind: "paper", entries: "On paper: each buy and sell is a paper trade with no card, and nothing real is bought or sold.", exits: "", buys: "paper trades with no card: nothing real is bought", sells: "paper trades, on their own" }
  const exits = "Its sells of what it bought run without a card on any wallet: you approve them now, with the bot."
  const sells = "of what it bought, on their own, on any wallet: you approve them now"
  if (!pays) return { kind: "unknown", entries: "The wallet that pays hasn't been read yet, so how its buys run is said when it trades.", exits, buys: "said when it trades: the wallet isn't read yet", sells }
  const wallet = theWallet(pays.name)
  if (pays.setting.setting === "ask") {
    return { kind: "asks", entries: `Its buys ask you each time: ${wallet} asks every time, so each buy is a card you approve or reject within 60 s, and one you miss is refused to the bot.`, exits, amber: `${wallet} asks every time, so each of its buys will wait for you`, buys: "each a card for you within 60 s; one you miss is refused to the bot", sells }
  }
  return {
    kind: "own",
    entries: `Runs on its own: ${wallet} trades inside limits, so each buy trades with a receipt while it fits ${usd(pays.setting.perTradeUsd)} a trade and ${usd(pays.setting.perDayUsd)} a day without a card; over them, it's a card that waits for you.`,
    exits,
    buys: `on their own inside ${wallet}'s ${usd(pays.setting.perTradeUsd)} a trade and ${usd(pays.setting.perDayUsd)} a day; over them, a card`,
    sells,
  }
}

/** What a code bot's card is made of, beside the proposal it binds. */
export interface CodeBotCardContext {
  pays: PayWalletInfo | undefined
  /** Who else trades from its wallet: agents, other bots. The embedded wallet is always shared. */
  sharedWith: string[]
  /** Chips toward a wallet of its own. */
  ownWallet: { label: string; line: string }[]
  /** The saved bot's mode, for a change: paper to live is said as taking it live. */
  wasMode?: "paper" | "live"
}

/** What a change card says of a bot the person paused or stopped: it stays so. */
export const staysWords = (state: "paused" | "stopped"): string => `it stays ${state}: put it back on from the Bots tab`

/**
 * A code bot's card: its folder and command, its figures, how its trades will run, the way to a wallet of its own
 * where its wallet is shared or asks (a live bot), and what the person approves: the figures, not the code.
 */
export function codeBotCard(c: CodeBotCheck, ctx: CodeBotCardContext): BotCardInput {
  const runs = codeBotRuns(c.run, ctx.pays)
  const live = ctx.wasMode === "paper" && c.run.mode === "live"
  const spec: BotSpec = {
    name: c.name,
    words: `Runs ${commandShown(c.run.command)} in ${folderShown(c.run.folder)}.`,
    definition: canonicalJson(c.run),
    mode: c.run.mode,
    runs,
    worst: `At worst ${c.run.maxOpen === 1 ? `one position of up to ${usd(c.run.perTradeUsd)} is open at a time` : `${c.run.maxOpen} positions of up to ${usd(c.run.perTradeUsd)} each are open at once: ${usd(c.run.perTradeUsd * c.run.maxOpen)} at risk`}, and its buys spend at most ${usd(c.run.perDayUsd)} a day, plus Candle's fee.`,
    parts: { buys: runs.buys ?? runs.entries, sells: runs.sells ?? runs.exits, worst: codeWorstShort(c.run), tested: CODE_BOT_HOLDS },
    code: { folder: folderShown(c.run.folder), command: commandShown(c.run.command), figures: figuresShort(c.run), holds: CODE_BOT_HOLDS },
    ...(c.replaces ? { replaces: true as const } : {}),
    ...(c.changes?.what.length || c.stays ? { changes: [...(c.changes?.what ?? []), ...(c.stays ? [staysWords(c.stays)] : [])].join("; ") } : {}),
    ...(live ? { live: true as const } : {}),
  }
  const steer = c.run.mode === "live" && (ctx.sharedWith.length > 0 || runs.kind === "asks")
  const why = ctx.sharedWith.length ? `${theWallet(c.paysFrom)} is shared with ${sharedWithWords(ctx.sharedWith)}` : runs.amber
  const warning = steer ? `${why ? `${why[0]!.toUpperCase()}${why.slice(1)}. ` : ""}A wallet of its own is the better way: the bot can lose only what that wallet holds, and its figures are the bot's alone.` : undefined
  const slip = c.run.maxSlippageBps
  return {
    action: "save",
    name: c.name,
    spec,
    params: { action: "saveCode", name: c.name, proposal: { name: c.name, run: c.run }, proposer: c.run.agent, hash: c.hash, replace: Boolean(c.replaces) },
    title: live ? `TAKE CODE BOT "${c.name}" LIVE` : `${c.replaces ? "CHANGE" : "NEW"} CODE BOT "${c.name}"`,
    paysFrom: c.paysFrom,
    ...(warning ? { warning } : {}),
    ...(steer ? { fills: ctx.ownWallet } : {}),
    ...(slip !== undefined ? { slippage: slippageOnCard(slip, c.run.wallet) } : {}),
  }
}

/** The bot in words, as its card and the Journal say it. */
export function codeBotWords(run: Pick<CodeRunSettings, "folder" | "command" | "perTradeUsd" | "perDayUsd" | "maxOpen">): string {
  return `Runs ${commandShown(run.command)} in ${folderShown(run.folder)}, held to ${usd(run.perTradeUsd)} a trade, ${usd(run.perDayUsd)} a day and ${run.maxOpen} open at once.`
}

/**
 * What changes from one code bot's settings to another's, each said short, and which of those are wider: a figure
 * raised, a looser slippage bound or one under the route's default, going live, another wallet, folder or command.
 * Lowering a figure, or tightening a bound no further than the route's default, is narrower; going to paper is a card too, as a rules bot keeps its mode.
 */
export function codeChanges(was: CodeRunSettings, now: CodeRunSettings, routeBps: number, walletName?: (wallet: string) => string): { what: string[]; wider: string[] } {
  const what: string[] = []
  const wider: string[] = []
  const figure = (label: string, a: number, b: number, said: (n: number) => string) => {
    if (a === b) return
    const words = `${label} ${said(b)}, from ${said(a)}`
    what.push(words)
    if (b > a) wider.push(words)
  }
  figure("a trade's figure", was.perTradeUsd, now.perTradeUsd, usd)
  figure("a day's figure", was.perDayUsd, now.perDayUsd, usd)
  figure("open at most", was.maxOpen, now.maxOpen, String)
  const sa = was.maxSlippageBps ?? routeBps
  const sb = now.maxSlippageBps ?? routeBps
  const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`
  if (sa !== sb) {
    const words = `a slippage bound of ${pct(sb)}, from ${pct(sa)}`
    what.push(words)
    // Looser is wider. Tighter than the route's own bound isn't a narrowing either: it binds the bot's sells and
    // the exits the core holds for it, which may then not fill.
    if (sb > sa) wider.push(words)
    else if (sb < routeBps) wider.push(underDefaultWords(sb, routeBps))
  }
  const other = (cond: boolean, words: string) => {
    if (!cond) return
    what.push(words)
    wider.push(words)
  }
  other(now.mode !== was.mode, now.mode === "live" ? "live, from paper" : "paper, from live")
  other(now.wallet !== was.wallet, walletName ? `pays from ${walletName(now.wallet)}, from ${walletName(was.wallet)}` : "another wallet pays")
  other(now.folder !== was.folder, `the folder ${folderShown(now.folder)}, from ${folderShown(was.folder)}`)
  other(canonicalJson(now.command) !== canonicalJson(was.command), `the command ${commandShown(now.command)}, from ${commandShown(was.command)}`)
  return { what, wider }
}

/**
 * What a bot's own control would do, against what its card approved: pausing and lowering happen at once on the
 * person's click; anything that raises a figure or loosens its bound is a card the person presses.
 */
export function controlEffect(run: CodeRunSettings, c: BotControl, routeBps: number): { how: "at once" | "card" | "same"; words: string; next?: CodeRunSettings } {
  if ("pause" in c) return { how: "at once", words: "pauses it: its buys are refused, and its sells still run" }
  const next: CodeRunSettings = { ...run, ...c.set }
  const ch = codeChanges(run, next, routeBps)
  if (!ch.what.length) return { how: "same", words: "it runs so already" }
  return { how: ch.wider.length ? "card" : "at once", words: ch.what.join("; "), next }
}

export interface CodeBotVersion {
  n: number
  hash: string
  run: CodeRunSettings
  at: string
  cardId?: string
}

export interface CodeBotState {
  approved: string
  run: BotRunState
  by: { how: "view" | "agent" | "build" | "card" | "candle"; clientId?: string; agent?: string; at: string }
  savedAt: string
  onSince: string
  versions: CodeBotVersion[]
}

interface StateFile {
  bots: Record<string, CodeBotState>
  planHeld?: boolean
}

/** What holds a code bot, and whether its sells still run while it's held. */
export interface CodeBotHeld {
  code: "NOT_APPROVED" | "CHANGED_OUTSIDE" | "AGENT_GONE" | "PLAN_FREE" | "PLAN_UNKNOWN"
  words: string
  sells: boolean
}

export interface CodeBotView {
  kind: "code"
  name: string
  agent: string
  wallet: string
  paysFrom?: string
  mode: "paper" | "live"
  state: BotRunState
  /** Whether its buys and swaps run now, and whether its sells of its own do. */
  buys: boolean
  sells: boolean
  held?: { code: CodeBotHeld["code"]; words: string }
  stateWords?: string
  byCandle?: true
  folder: string
  /** Its folder with the home as `~`, and its command as a line. */
  folderShown: string
  command: string[]
  commandShown: string
  perTradeUsd: number
  perDayUsd: number
  maxOpen: number
  figures: string
  maxSlippageBps?: number
  slippageLooser?: true
  words: string
  version?: number
  versions?: number
  savedAt?: string
  onSince?: string
  /** What its buys and swaps spent today, or may (under way), against its day figure. */
  usedTodayUsd?: number
  /** Whether a token has been issued to it, and when: the bot can't connect before one is. */
  token?: { issuedAt: string }
  /** Whether it's connected to the core now: one that isn't shows as "not connected". */
  connected: boolean
  /** What it last said about itself (bot-report.ts), its newest events only: shown as "the bot says", never as figures. */
  says?: BotReport
  /** The controls its report offers the person, each with what a click does: at once, or a card. */
  controls?: { id: string; label: string; how: "at once" | "card" | "same"; words: string }[]
  /** Its open positions the core holds exits on: each with them in words, who set them, and whether one is selling. */
  heldExits?: CodeHeldExitView[]
  /** Its process, as the supervisor runs it: running, restarting after a crash, given up, stopped, or run outside. */
  process?: BotProcessView
}

/** One position a code bot holds that the core holds exits on, for the Bots tab: the person may remove them. */
export interface CodeHeldExitView {
  position: string
  mint: string
  symbol?: string
  /** The exits, in words: "Sells at +50% or at -20%." */
  words: string
  by: "buy" | "bot" | "person"
  /** One of them is selling it now. */
  selling?: true
  /** Why its sell waits, where it does (two failed sells, the breaker, no price). */
  waits?: string
}

/** A code bot as the build session proposes it. */
export interface CodeBotProposal {
  name: string
  run: { agent: string; wallet: string; mode: "paper" | "live"; folder: string; command: string[]; perTradeUsd: number; perDayUsd: number; maxOpen: number; maxSlippageBps?: number }
}

export interface CodeBotCheck {
  name: string
  run: CodeRunSettings
  hash: string
  words: string
  paysFrom: string
  replaces?: true
  /** A change to a saved one: what it changes, and what of that is wider. */
  changes?: { what: string[]; wider: string[] }
  /** A saved one the person paused or stopped: a change keeps it so, and its card says it. */
  stays?: "paused" | "stopped"
}

/** The bot token's issuer: the token book's code bot records. */
export interface BotTokens {
  mintBot(bot: string, agent: string): Promise<{ token: string; tokenId: string; createdAt: string }>
  revokeBot(bot: string): Promise<string | undefined>
  botToken(bot: string): { tokenId: string; createdAt: string } | undefined
}

export interface CodeBotBookDeps {
  file: BotsFileStore
  statePath: string
  journal: Journal
  agents(): string[]
  plan(agent: string): HaccPlan | undefined
  mode(): Mode
  now(): number
  payWallet(agent: string, wallet: string): PayWalletInfo | undefined
  payRefusal?(agent: string, wallet: string): string | undefined
  tokens: BotTokens
  /** A token revoked or replaced: its connection ends now. */
  disconnect?(tokenId: string): void
  /** How long a test run lasts at most: 30 minutes, shorter in tests. */
  testMs?: number
  /** How many positions a code bot holds open, paper and live. */
  openPositions?(name: string): number
  /**
   * A test run ended: each request of its that Candle never answered is let go, so none holds a later test's open
   * figure; answers what was let go, in a few words each.
   */
  letGo?(name: string): Promise<string[]>
  /** Whether a code bot is connected to the core now. */
  connected?(name: string): boolean
  /** Whether a code bot runs outside the Candle Harness, with a token file in its folder. */
  runsOutside?(name: string): boolean
  /** Why a folder can't be a bot's by where it really is (folderPlaceProblem): checked at proposal, approval and every start. */
  folderPlace?(folder: string): string | undefined
  onChange(): void
}

type From = { clientId: string; how: "view" | "agent" | "build"; agent?: string }

export { isTestName, TEST_PREFIX } from "../shared/bot-name"
/** How long a test run lasts at most. */
export const TEST_MS = 30 * 60_000
/** A test run's figures where the Build pane gives none: on paper, so only what the test spends on paper. */
export const TEST_FIGURES = { perTradeUsd: 5, perDayUsd: 25, maxOpen: 3 } as const

/** A paper test run, as a Build pane started it. */
interface TestRun {
  entry: CodeBotEntry
  /** The Build pane's token it belongs to: closing the pane ends it. */
  buildTokenId: string
  startedAt: string
  endsAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/** A test run, for the Build tab: what it runs, under which figures, and until when. */
export interface CodeTestView {
  name: string
  agent: string
  folder: string
  folderShown: string
  commandShown: string
  figures: string
  startedAt: string
  endsAt: string
  connected: boolean
  /** What it last said about itself, as a code bot's is shown: never as figures. */
  says?: BotReport
  /** What happens to what it holds when it ends, in words. */
  afterEnd: string
}

/** A test that ended: what it said as it ended, and how many paper positions it left open. */
export interface CodeTestEnded {
  name: string
  agent: string
  said: string
  at: string
  open?: number
}

/** How many ended tests the topic keeps saying. */
const ENDED_KEPT = 3

/** A test's paper positions when it ends: left open, in its agent's paper book, the test's and no bot's. */
export const testLeftWords = (open: number, agent: string): string =>
  `${open === 1 ? "Its paper position stays" : `Its ${open} paper positions stay`} open in ${agent}'s paper book: the test's, not counted as any bot's.`
export const TEST_AFTER_END = (agent: string): string =>
  `Its exits the core holds sell while it runs. When it ends, anything it still holds stays open in ${agent}'s paper book, as the test's.`

/** Sells every open position of a code bot as its exits sell: set once the core's exit machinery is up. */
export type CodeFlattener = (bot: CodeBotEntry, by: { how: "view" | "agent"; agent?: string }) => { said: string }

const RANK: Record<BotRunState, number> = { on: 0, paused: 1, stopped: 2 }
const stricter = (a: BotRunState, b: BotRunState): BotRunState => (RANK[a] >= RANK[b] ? a : b)
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** A version read back from the state file or the journal: its run settings whole, or nothing. */
function readRun(v: unknown): CodeRunSettings | undefined {
  const r = v as Partial<CodeRunSettings> | undefined
  if (!r || typeof r.agent !== "string" || typeof r.wallet !== "string" || (r.mode !== "paper" && r.mode !== "live")) return undefined
  if (folderProblem(r.folder) || commandProblem(r.command) || figuresProblem({ perTradeUsd: r.perTradeUsd, perDayUsd: r.perDayUsd, maxOpen: r.maxOpen })) return undefined
  return codeRunOf(r as CodeRunSettings)
}

export class CodeBotBook {
  private state: StateFile = { bots: {} }
  private flattener: CodeFlattener | undefined
  private readonly tests = new Map<string, TestRun>()
  private readonly ended: (CodeTestEnded & { buildTokenId: string })[] = []

  constructor(private readonly deps: CodeBotBookDeps) {
    try {
      const saved = JSON.parse(readFileSync(deps.statePath, "utf8")) as Partial<StateFile>
      if (saved && typeof saved.bots === "object" && saved.bots !== null) {
        for (const [name, s] of Object.entries(saved.bots)) {
          const b = s as Partial<CodeBotState>
          if (typeof b.approved !== "string" || !(b.run === "on" || b.run === "paused" || b.run === "stopped") || typeof b.savedAt !== "string" || !Array.isArray(b.versions)) continue
          const versions = b.versions.flatMap((v) => {
            const run = readRun(v?.run)
            return run && typeof v.hash === "string" && typeof v.n === "number" && typeof v.at === "string" ? [{ ...v, run }] : []
          })
          if (!versions.length) continue
          this.state.bots[name] = {
            approved: b.approved,
            run: b.run,
            by: b.by && typeof b.by === "object" && typeof b.by.at === "string" ? b.by : { how: "card", at: b.savedAt },
            savedAt: b.savedAt,
            onSince: typeof b.onSince === "string" ? b.onSince : b.savedAt,
            versions,
          }
        }
        if (saved.planHeld === true) this.state.planHeld = true
        return
      }
    } catch {}
    this.state = rebuildCodeBots(deps.journal.botRows())
  }

  /** Called once the core can sell a code bot's positions itself: until then, a flatten is refused, and nothing is sold. */
  setFlattener(flattener: CodeFlattener): void {
    this.flattener = flattener
  }

  /**
   * Sells every open position of a code bot now, as the core's exits sell: its own only, with no card on any wallet,
   * whether the bot listens or not. The bot stays as it is. The person's, from the main view, or its agent's on a card.
   */
  async flatten(name: string, from: { clientId: string; main: boolean; how?: "view" | "agent"; agent?: string }): Promise<{ name: string; said: string }> {
    const b = this.entry(name)
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (from.how !== "agent" && !from.main) throw refused("MAIN_VIEW_ONLY", "A bot is flattened from the main window, not a popped pane.")
    if (!this.flattener) throw refused("NOT_READY", "This core can't sell a bot's positions yet, so nothing was sold.")
    return { name, said: this.flattener(b, { how: from.how ?? "view", ...(from.agent ? { agent: from.agent } : {}) }).said }
  }

  /** Whether code bots are open for this agent's plan, or any agent's: Pro or Max, as rules bots. */
  gate(agent?: string): { state: "ok" } | { state: "free" | "unknown"; words: string } {
    const plans = (agent ? [agent] : this.deps.agents()).map((a) => this.deps.plan(a))
    if (plans.some((p) => p === "pro" || p === "max")) return { state: "ok" }
    if (plans.some((p) => p === "free")) return { state: "free", words: `${BOTS_PLAN_WORDS}. This account is on Free.` }
    return { state: "unknown", words: "The account's plan hasn't been read yet, so bots wait for it." }
  }

  entries(): CodeBotEntry[] {
    return this.deps.file.read().code
  }

  /** Every code bot this core holds: in bots.toml, or approved here while the file can't be read. */
  known(): string[] {
    return [...new Set([...this.entries().map((b) => b.name), ...Object.keys(this.state.bots)])]
  }

  /** A saved code bot by name, or a test run. */
  entry(name: string): CodeBotEntry | undefined {
    return this.tests.get(name)?.entry ?? this.entries().find((b) => b.name === name)
  }

  isTest(name: string): boolean {
    return this.tests.has(name)
  }

  /** When a paper test going now started: its figures count from then, not from an earlier test of the same folder. */
  testSince(name: string): number | undefined {
    const t = this.tests.get(name)
    return t ? Date.parse(t.startedAt) : undefined
  }

  /** The test runs going now, as entries: their held exits run while they do, as a saved bot's. */
  testEntries(): CodeBotEntry[] {
    return [...this.tests.values()].map((t) => t.entry)
  }

  /**
   * Starts a paper test run of a bot's code for a Build pane: never in bots.toml, never supervised, never live. The
   * same folder tested again from the same pane replaces the run before. Returns its token, once.
   */
  async startTest(p: { folder: string; command: string[]; agent: string; buildTokenId: string; perTradeUsd?: number; perDayUsd?: number; maxOpen?: number }): Promise<{ name: string; token: string; endsAt: string; figures: string }> {
    if (!this.deps.agents().includes(p.agent)) throw refused("UNKNOWN_AGENT", `${p.agent} has no key here, so it can't test a bot. Nothing was started.`)
    const gate = this.gate(p.agent)
    if (gate.state !== "ok") throw refused(gate.state === "free" ? "BOTS_NEED_PLAN" : "PLAN_UNKNOWN", `${gate.words} Nothing was started.`)
    const folderWhy = folderProblem(p.folder) ?? this.deps.folderPlace?.(p.folder)
    if (folderWhy) throw refused("BAD_FOLDER", `${folderWhy}. Nothing was started.`)
    const commandWhy = commandProblem(p.command)
    if (commandWhy) throw refused("BAD_COMMAND", `${commandWhy}. Nothing was started.`)
    const figures = { perTradeUsd: p.perTradeUsd ?? TEST_FIGURES.perTradeUsd, perDayUsd: p.perDayUsd ?? TEST_FIGURES.perDayUsd, maxOpen: p.maxOpen ?? TEST_FIGURES.maxOpen }
    const figuresWhy = figuresProblem(figures)
    if (figuresWhy) throw refused("BAD_FIGURES", `${figuresWhy}. Nothing was started.`)
    const base = p.folder.replace(/\/+$/, "").split("/").at(-1) || "bot"
    const name = `${TEST_PREFIX}${base}`
    const was = this.tests.get(name)
    if (was && was.buildTokenId !== p.buildTokenId) throw refused("TEST_RUNNING", `"${name}" is running from another Build pane: it ends with that pane, or within 30 minutes. Nothing was started.`)
    if (was) await this.endTest(name, "replaced")
    const now = this.deps.now()
    const entry: CodeBotEntry = { kind: "code", name, agent: p.agent, wallet: "embedded", mode: "paper", state: "on", folder: p.folder, command: [...p.command], ...figures }
    const ms = this.deps.testMs ?? TEST_MS
    const run: TestRun = { entry, buildTokenId: p.buildTokenId, startedAt: new Date(now).toISOString(), endsAt: now + ms, timer: undefined }
    this.tests.set(name, run)
    // Its token and its row first, then its timer: an end can never come before the token it revokes.
    const minted = await this.deps.tokens.mintBot(name, p.agent)
    if (this.tests.get(name) !== run) {
      // Its pane closed while the token was made: it's revoked at once, and nothing runs.
      await this.deps.tokens.revokeBot(name)
      throw refused("TEST_ENDED", "Its Build pane closed as the test started, so nothing runs.")
    }
    await this.deps.journal.append({ type: "bot.test", mode: this.deps.mode(), kind: "code", agent: p.agent, name, what: "started", folder: p.folder, command: [...p.command], ...figures, endsAt: new Date(run.endsAt).toISOString() })
    run.timer = setTimeout(() => void this.endTest(name, "timed_out").catch(() => {}), Math.max(0, run.endsAt - this.deps.now()))
    run.timer.unref?.()
    this.deps.onChange()
    return { name, token: minted.token, endsAt: new Date(run.endsAt).toISOString(), figures: figuresShort(figures) }
  }

  /** Ends a test run: its token revoked and its connection ended. Its paper positions stay in the paper book, said. */
  async endTest(name: string, why: "ended" | "replaced" | "pane_closed" | "timed_out" | "agent_gone"): Promise<{ name: string; said: string } | undefined> {
    const run = this.tests.get(name)
    if (!run) return undefined
    this.tests.delete(name)
    if (run.timer) clearTimeout(run.timer)
    const tokenId = await this.deps.tokens.revokeBot(name)
    if (tokenId) this.deps.disconnect?.(tokenId)
    const open = this.deps.openPositions?.(name) ?? 0
    const left = open ? ` ${testLeftWords(open, run.entry.agent)}` : ""
    const gone = (await this.deps.letGo?.(name).catch(() => [])) ?? []
    const unanswered = gone.length ? ` ${gone.length === 1 ? `Its ${gone[0]} had no answer yet` : `${gone.length} of its requests had no answer yet (${gone.join(", ")})`}: let go, so ${gone.length === 1 ? "it holds" : "they hold"} nothing open.` : ""
    const how = { ended: "its command ended", replaced: "a new test of the same folder replaced it", pane_closed: "its Build pane closed", timed_out: "30 minutes passed", agent_gone: `${run.entry.agent} isn't one of your agents now` }[why]
    const said = `The test run "${name}" ended: ${how}.${left}${unanswered}`
    await this.deps.journal.append({ type: "bot.test", mode: this.deps.mode(), kind: "code", agent: run.entry.agent, name, what: "ended", why, ...(open ? { open } : {}), words: said })
    this.ended.unshift({ name, agent: run.entry.agent, buildTokenId: run.buildTokenId, said, at: new Date(this.deps.now()).toISOString(), ...(open ? { open } : {}) })
    this.ended.splice(ENDED_KEPT)
    this.deps.onChange()
    return { name, said }
  }

  /** Ends every test run a Build pane started: the pane closed. */
  async endTestsOf(buildTokenId: string): Promise<void> {
    for (const [name, run] of [...this.tests]) if (run.buildTokenId === buildTokenId) await this.endTest(name, "pane_closed")
  }

  /** A test run's owner: the Build pane token that started it. */
  testOwner(name: string): string | undefined {
    return this.tests.get(name)?.buildTokenId
  }

  /** The newest tests that ended, newest first, for the Build tab's test box after the run: what became of each. */
  endedTests(): CodeTestEnded[] {
    return this.ended.map(({ buildTokenId: _, ...e }) => e)
  }

  testViews(): CodeTestView[] {
    return [...this.tests.values()].map((t) => ({
      name: t.entry.name,
      agent: t.entry.agent,
      folder: t.entry.folder,
      folderShown: folderShown(t.entry.folder),
      commandShown: commandShown(t.entry.command),
      figures: figuresShort(t.entry),
      startedAt: t.startedAt,
      endsAt: new Date(t.endsAt).toISOString(),
      connected: this.deps.connected?.(t.entry.name) ?? false,
      afterEnd: TEST_AFTER_END(t.entry.agent),
    }))
  }

  stateOf(name: string): CodeBotState | undefined {
    return this.state.bots[name]
  }

  /** The version a code bot was approved as: what its trades run by while a hand edit holds its buys. */
  approvedVersion(name: string): CodeBotVersion | undefined {
    const t = this.tests.get(name)
    if (t) return { n: 0, hash: codeBotHash(codeRunOf(t.entry)), at: t.startedAt, run: codeRunOf(t.entry) }
    const s = this.state.bots[name]
    return s?.versions.find((v) => v.hash === s.approved)
  }

  runState(b: CodeBotEntry): BotRunState {
    const s = this.state.bots[b.name]
    return s ? stricter(b.state, s.run) : b.state
  }

  heldBy(b: CodeBotEntry): CodeBotHeld | undefined {
    if (this.tests.has(b.name)) {
      if (!this.deps.agents().includes(b.agent)) return { code: "AGENT_GONE", sells: false, words: `${b.agent} isn't one of your agents now, so it doesn't trade.` }
      const gate = this.gate(b.agent)
      return gate.state === "ok" ? undefined : { code: gate.state === "free" ? "PLAN_FREE" : "PLAN_UNKNOWN", sells: true, words: gate.words }
    }
    const s = this.state.bots[b.name]
    if (!s) return { code: "NOT_APPROVED", sells: false, words: "It was added to bots.toml outside the Candle Harness, so it doesn't trade: propose it from the Build tab, and approve its card." }
    if (s.approved !== codeBotHash(codeRunOf(b))) {
      return { code: "CHANGED_OUTSIDE", sells: true, words: "It was changed in bots.toml since it was approved, so its buys are held; its sells of its own still run, by what was approved. Propose the change, and approve its card." }
    }
    if (!this.deps.agents().includes(b.agent)) return { code: "AGENT_GONE", sells: false, words: `${b.agent} isn't one of your agents now, so it doesn't trade.` }
    const gate = this.gate(b.agent)
    if (gate.state === "free") return { code: "PLAN_FREE", sells: true, words: `The plan is Free now. ${BOTS_PLAN_WORDS} to buy; its sells of its own still run, and it comes back on with one.` }
    if (gate.state === "unknown") return { code: "PLAN_UNKNOWN", sells: true, words: `${gate.words} Its sells of its own still run.` }
    return undefined
  }

  /** Whether its buys and swaps run now, and whether its sells of its own do. */
  runs(b: CodeBotEntry): { buys: boolean; sells: boolean } {
    const state = this.runState(b)
    const held = this.heldBy(b)
    return { buys: state === "on" && !held, sells: state !== "stopped" && (!held || held.sells) }
  }

  /** The code bots that keep the core running: each that buys, or whose sells run on a position it holds. */
  keepingUp(): CodeBotEntry[] {
    return this.entries().filter((b) => {
      const r = this.runs(b)
      return r.buys || (r.sells && (this.deps.openPositions ? this.deps.openPositions(b.name) > 0 : true))
    })
  }

  /**
   * Whether a bot token may say hello now: the bot is saved and approved, its agent has a key, and the plan isn't
   * Free. Undefined when it may; else the refusal in words.
   */
  admits(name: string): { code: string; message: string } | undefined {
    if (this.tests.has(name)) {
      const t = this.tests.get(name)!
      if (!this.deps.agents().includes(t.entry.agent)) return { code: "AGENT_GONE", message: `${t.entry.agent} isn't one of your agents now, so its test doesn't connect.` }
      if (this.gate(t.entry.agent).state === "free") return { code: "BOTS_NEED_PLAN", message: `${BOTS_PLAN_WORDS}. This account is on Free, so no bot connects.` }
      return undefined
    }
    const b = this.entry(name)
    if (!b || !this.state.bots[name]) return { code: "UNKNOWN_BOT", message: `No code bot named "${name}" is approved here.` }
    if (!this.deps.agents().includes(b.agent)) return { code: "AGENT_GONE", message: `${b.agent} isn't one of your agents now, so its bots don't connect.` }
    if (this.gate(b.agent).state === "free") return { code: "BOTS_NEED_PLAN", message: `${BOTS_PLAN_WORDS}. This account is on Free, so no bot connects.` }
    return undefined
  }

  views(): CodeBotView[] {
    return this.entries().map((b) => this.viewOf(b))
  }

  /** The `bots` topic's gate words, where a rules bot's aren't there to say them. */
  gateView(): { plan: "free" | "unknown"; words: string; fix?: string } | undefined {
    const gate = this.gate()
    return gate.state === "ok" ? undefined : { plan: gate.state, words: gate.state === "free" ? BOTS_PLAN_WORDS : gate.words, ...(gate.state === "free" ? { fix: PLAN_FIX } : {}) }
  }

  viewOf(b: CodeBotEntry): CodeBotView {
    const s = this.state.bots[b.name]
    const state = this.runState(b)
    const held = this.heldBy(b)
    const r = this.runs(b)
    const v = this.approvedVersion(b.name)
    const pays = this.deps.payWallet(b.agent, b.wallet)
    const token = this.deps.tokens.botToken(b.name)
    return {
      kind: "code",
      name: b.name,
      agent: b.agent,
      wallet: b.wallet,
      ...(pays ? { paysFrom: pays.name } : {}),
      mode: b.mode,
      state,
      buys: r.buys,
      sells: r.sells,
      ...(held && (state !== "stopped" || held.code === "NOT_APPROVED" || held.code === "CHANGED_OUTSIDE") ? { held: { code: held.code, words: held.words } } : {}),
      ...(state !== "on" ? { stateWords: this.stateWords(b, state) } : {}),
      ...(state === "paused" && s?.by.how === "candle" && RANK[b.state] <= RANK[s.run] ? { byCandle: true as const } : {}),
      folder: b.folder,
      folderShown: folderShown(b.folder),
      command: [...b.command],
      commandShown: commandShown(b.command),
      perTradeUsd: b.perTradeUsd,
      perDayUsd: b.perDayUsd,
      maxOpen: b.maxOpen,
      figures: figuresShort(b),
      ...(b.maxSlippageBps !== undefined ? { maxSlippageBps: b.maxSlippageBps } : {}),
      ...(b.maxSlippageBps !== undefined && b.maxSlippageBps > routeSlippageBps(b.wallet) ? { slippageLooser: true as const } : {}),
      words: codeBotWords(b),
      ...(v ? { version: v.n } : {}),
      ...(s ? { versions: s.versions.length, savedAt: s.savedAt, onSince: s.onSince } : {}),
      ...(token ? { token: { issuedAt: token.createdAt } } : {}),
      connected: this.deps.connected?.(b.name) ?? false,
    }
  }

  private stateWords(b: CodeBotEntry, state: BotRunState): string {
    const open = this.deps.openPositions?.(b.name) ?? 0
    const left = open ? `its ${open === 1 ? "position is" : `${open} positions are`} left to you` : "it holds nothing"
    const what = state === "paused" ? "paused: its buys are refused, its sells of its own still run" : `stopped: none of its trades run, and ${left}`
    const s = this.state.bots[b.name]
    if (!s || RANK[b.state] > RANK[s.run]) return `${what}, set in bots.toml`
    if (s.by.how === "candle") return `${what}. Candle stopped ${b.agent}'s key at ${hhmm(s.by.at)} (a loss limit or its circuit breaker), sells included: resume the key in Candle's Agent Console, then put the bot back on here`
    const who = s.by.how === "agent" ? (s.by.agent ?? "its agent") : s.by.how === "build" ? "the Build tab" : "you"
    return `${what}, by ${who} at ${hhmm(s.by.at)}`
  }

  /**
   * A code bot as proposed, checked whole for a card: its agent, the plan, its name (no rules bot holds it), its
   * folder, command, figures and slippage, and the wallet it pays from. Throws a refusal in words.
   */
  check(p: CodeBotProposal, proposer: string): CodeBotCheck {
    if (!this.deps.agents().includes(proposer)) throw refused("UNKNOWN_AGENT", `${proposer} has no key here, so it can't hold a bot.`)
    if (p.run.agent !== proposer) throw refused("NOT_ITS_AGENT", `A bot belongs to the agent it's built for, and trades with its key: a bot for ${proposer} can't be ${p.run.agent}'s.`)
    const gate = this.gate(proposer)
    if (gate.state === "free") throw refused("BOTS_NEED_PLAN", `${BOTS_PLAN_WORDS}. This account is on Free, so nothing was proposed.`)
    if (gate.state === "unknown") throw refused("PLAN_UNKNOWN", `${gate.words} Try again in a moment. Nothing was proposed.`)
    const why = botNameProblem(p.name)
    if (why) throw refused("INVALID_BOT_NAME", `"${p.name}" can't name a bot: ${why}.`)
    if (this.deps.file.read().bots.some((b) => b.name === p.name)) throw refused("NAME_TAKEN", `A rules bot is named "${p.name}". Give this one a name of its own. Nothing was proposed.`)
    for (const problem of [folderProblem(p.run.folder), commandProblem(p.run.command), figuresProblem(p.run)]) if (problem) throw refused("INVALID_CODE_BOT", `${problem}. Nothing was proposed.`)
    // Where the folder really is, links resolved: checked here at proposal, again at approval (save) and at every start.
    const place = this.deps.folderPlace?.(p.run.folder)
    if (place) throw refused("INVALID_CODE_BOT", `${place}. Nothing was proposed.`)
    if (p.run.mode !== "paper" && p.run.mode !== "live") throw refused("INVALID_MODE", 'A bot runs on "paper" or "live".')
    const bps = p.run.maxSlippageBps
    // A bound the bot already runs at stands as it was approved; a new one has a floor.
    const slipProblem = bps !== undefined && bps !== this.entry(p.name)?.maxSlippageBps ? slippageProblem(bps) : undefined
    if (slipProblem) throw refused("INVALID_SLIPPAGE", slipProblem)
    const pays = this.deps.payWallet(proposer, p.run.wallet)
    if (!pays) throw refused("WALLET_CANT_PAY", `${this.deps.payRefusal?.(proposer, p.run.wallet) ?? `${proposer} can't pay from "${p.run.wallet}", or its wallets haven't been read yet.`} Nothing was proposed.`)
    const run = codeRunOf({ ...p.run, agent: proposer, wallet: pays.name === "embedded" ? "embedded" : pays.address })
    const saved = this.entry(p.name)
    const was = saved ? (this.approvedVersion(p.name)?.run ?? codeRunOf(saved)) : undefined
    const now = saved ? this.runState(saved) : "on"
    return {
      name: p.name,
      run,
      hash: codeBotHash(run),
      words: codeBotWords(run),
      paysFrom: pays.name,
      ...(saved ? { replaces: true as const } : {}),
      ...(was ? { changes: codeChanges(was, run, routeSlippageBps(was.wallet), (w) => this.walletShown(proposer, w)) } : {}),
      ...(now !== "on" ? { stays: now } : {}),
    }
  }

  /**
   * Saves a code bot whose card the person approved, checked whole again now. `hash` is what the card bound:
   * anything that reads differently now is refused. A name already saved is replaced only when the card said so.
   */
  /** A wallet as a change says it: its name where the agent pays from it, else its address short. */
  private walletShown(agent: string, wallet: string): string {
    if (wallet === "embedded") return "the embedded wallet"
    return this.deps.payWallet(agent, wallet)?.name ?? short(wallet)
  }

  async save(p: CodeBotProposal, proposer: string, by: { hash: string; replace?: boolean; cardId?: string; opId?: string }): Promise<{ name: string; replaced: boolean; version: number; said?: string }> {
    const c = this.check(p, proposer)
    if (c.hash !== by.hash) throw refused("BOT_CHANGED", `"${c.name}" reads differently now than when its card was made (its wallet moved). Nothing was saved; propose it again.`)
    const was = this.entry(c.name)
    if (was && !by.replace) throw refused("NAME_TAKEN", `A bot named "${c.name}" is already saved. Give this one another name, or replace that one.`)
    // A change keeps a bot the person paused or stopped as it was: putting it back on is theirs, by its own click.
    const keeps = c.stays ?? "on"
    const entry: CodeBotEntry = { kind: "code", name: c.name, ...c.run, state: keeps }
    const w = this.deps.file.write({ [c.name]: entry })
    if (!w.ok) throw refused("BOTS_FILE", `${w.message} Nothing was saved.`)
    const at = new Date(this.deps.now()).toISOString()
    const prior = this.state.bots[c.name]
    const n = (prior?.versions.at(-1)?.n ?? 0) + 1
    this.state.bots[c.name] = {
      approved: c.hash,
      run: keeps,
      by: keeps === "on" || !prior ? { how: "card", at } : prior.by,
      savedAt: prior?.savedAt ?? at,
      onSince: keeps === "on" || !prior ? at : prior.onSince,
      versions: [...(prior?.versions ?? []), { n, hash: c.hash, run: c.run, at, ...(by.cardId ? { cardId: by.cardId } : {}) }],
    }
    this.persist()
    await this.deps.journal.append({
      type: was ? "bot.changed" : "bot.saved",
      mode: this.deps.mode(),
      kind: "code",
      agent: c.run.agent,
      name: c.name,
      // A change says what it changed first, as its card did: "pays from agent-a-tee, from the embedded wallet".
      words: was && c.changes?.what.length ? `Changed: ${c.changes.what.join("; ")}. ${c.words}` : c.words,
      ...(was && c.changes?.what.length ? { changed: c.changes.what } : {}),
      hash: c.hash,
      version: n,
      run: c.run,
      state: keeps,
      by: "card",
      ...(by.cardId ? { cardId: by.cardId } : {}),
      ...(by.opId ? { opId: by.opId } : {}),
      ...(was ? { replaced: true } : {}),
    })
    // A bot run outside keeps its token through a change of figures. A new folder or command is another program:
    // what runs elsewhere under the old token isn't what the card showed, so that token ends here.
    let said: string | undefined
    const wasRun = prior?.versions.find((v) => v.hash === prior.approved)?.run ?? (was ? codeRunOf(was) : undefined)
    if (wasRun && (wasRun.folder !== c.run.folder || wasRun.command.join("\0") !== c.run.command.join("\0")) && this.deps.runsOutside?.(c.name)) {
      if (await this.endToken(c.name, "new_version")) said = `"${c.name}" ran outside the Candle Harness: its token is withdrawn. \`candle-harness bots token ${c.name}\` writes a new one in the new folder, or \`candle-harness bots start ${c.name}\` runs it here.`
    }
    this.deps.onChange()
    return { name: c.name, replaced: Boolean(was), version: n, ...(said ? { said } : {}) }
  }

  /**
   * Narrows a saved code bot at once: lower figures, or a slippage bound tightened no further than the route's default. Anything wider, or any other
   * change, is refused, naming it, for a card. One changed by hand isn't narrowed: its change waits for its card.
   */
  async narrow(name: string, next: Partial<Pick<CodeRunSettings, "perTradeUsd" | "perDayUsd" | "maxOpen" | "maxSlippageBps">>, from: From): Promise<{ name: string; version: number; narrowed: string[]; said: string }> {
    const b = this.entry(name)
    const s = this.state.bots[name]
    if (!b || !s) throw refused("UNKNOWN_BOT", `No code bot named "${name}".${this.namesWords()}`)
    if (from.how !== "view" && from.agent !== b.agent) throw refused("NOT_ITS_AGENT", `"${name}" is ${b.agent}'s bot: only ${b.agent}, or you, can narrow it.`)
    const held = this.heldBy(b)
    if (held && (held.code === "NOT_APPROVED" || held.code === "CHANGED_OUTSIDE")) throw refused(held.code, `"${name}" can't be narrowed: ${held.words}`)
    const was = codeRunOf(b)
    const run = codeRunOf({ ...was, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) } as CodeRunSettings)
    const problem = figuresProblem(run)
    if (problem) throw refused("INVALID_CODE_BOT", `${problem}. "${name}" is unchanged.`)
    const bps = run.maxSlippageBps
    const slipProblem = bps !== undefined && bps !== was.maxSlippageBps ? slippageProblem(bps) : undefined
    if (slipProblem) throw refused("INVALID_SLIPPAGE", `${slipProblem} "${name}" is unchanged.`)
    const c = codeChanges(was, run, routeSlippageBps(b.wallet))
    if (c.wider.length) throw refused("WIDER", `That's wider than "${name}" was approved: ${c.wider.join("; ")}. A wider bot is a new card for you to press. "${name}" is unchanged.`)
    if (!c.what.length) throw refused("NO_CHANGE", `That's what "${name}" already runs, so nothing changed.`)
    const hash = codeBotHash(run)
    const w = this.deps.file.write({ [name]: { ...b, ...run } })
    if (!w.ok) throw refused("BOTS_FILE", `${w.message} "${name}" is unchanged.`)
    const at = new Date(this.deps.now()).toISOString()
    const version: CodeBotVersion = { n: (s.versions.at(-1)?.n ?? 0) + 1, hash, run, at }
    s.approved = hash
    s.versions.push(version)
    this.persist()
    await this.deps.journal.append({
      type: "bot.changed",
      mode: this.deps.mode(),
      kind: "code",
      agent: b.agent,
      name,
      words: codeBotWords(run),
      hash,
      version: version.n,
      run,
      by: from.clientId,
      how: from.how,
      ...(from.agent ? { changedBy: from.agent } : {}),
      narrowed: c.what,
    })
    this.deps.onChange()
    return { name, version: version.n, narrowed: c.what, said: `"${name}" is narrowed: ${c.what.join("; ")}.` }
  }

  /** Pauses a code bot, at once, from any view, its agent or the Build tab: its buys refused; its sells still run. */
  async pause(name: string, from: From): Promise<{ name: string; state: BotRunState; said: string }> {
    const b = this.entry(name)
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (from.how !== "view" && from.agent !== b.agent) throw refused("NOT_ITS_AGENT", `"${name}" is ${b.agent}'s bot: only ${b.agent}, or you, can pause it.`)
    const now = this.runState(b)
    if (now === "stopped") return { name, state: now, said: `"${name}" is stopped, so none of its trades run already. Resuming it is yours, in the main window.` }
    if (now === "paused") return { name, state: now, said: `"${name}" is paused already: its buys are refused, and its sells still run.` }
    return this.setState(b, "paused", from)
  }

  /** Stops a code bot: none of its trades run. Its positions stay in the wallet, for you. The person's, from the main view. */
  async stop(name: string, from: { clientId: string; main: boolean }): Promise<{ name: string; state: BotRunState; said: string }> {
    const b = this.entry(name)
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (!from.main) throw refused("MAIN_VIEW_ONLY", "A bot is stopped from the main window, not a popped pane.")
    if (this.runState(b) === "stopped") return { name, state: "stopped", said: `"${name}" is stopped already.` }
    return this.setState(b, "stopped", { clientId: from.clientId, how: "view" })
  }

  /** Puts a paused or stopped code bot back on, as it was approved. The person's, from the main view. */
  async resume(name: string, from: { clientId: string; main: boolean; how?: "view" | "agent" | "build" }): Promise<{ name: string; state: BotRunState; said: string }> {
    if (from.how !== undefined && from.how !== "view") throw refused("PERSON_ONLY", "Only the person puts a bot back on, as it was approved, in the main window.")
    const b = this.entry(name)
    const s = this.state.bots[name]
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (!from.main) throw refused("MAIN_VIEW_ONLY", "A bot is put back on from the main window, not a popped pane.")
    const held = this.heldBy(b)
    if (held && held.code !== "PLAN_UNKNOWN") throw refused(held.code, `"${name}" can't be put back on: ${held.words}`)
    if (this.runState(b) === "on") return { name, state: "on", said: `"${name}" is on already.` }
    const w = this.deps.file.write({ [name]: { ...b, state: "on" } })
    if (!w.ok) throw refused("BOTS_FILE", `${w.message} "${name}" stays ${this.runState(b)}.`)
    const at = new Date(this.deps.now()).toISOString()
    s!.run = "on"
    s!.by = { how: "view", clientId: from.clientId, at }
    s!.onSince = at
    this.persist()
    await this.deps.journal.append({ type: "bot.resumed", mode: this.deps.mode(), kind: "code", agent: b.agent, name, by: from.clientId, how: "view" })
    this.deps.onChange()
    return { name, state: "on", said: `"${name}" is on again, as it was approved.` }
  }

  /** Candle stopped an agent's key: every code bot of that agent that's on is paused. Putting each back on is the person's. */
  async pauseByCandle(agent: string): Promise<string[]> {
    const paused: string[] = []
    for (const b of this.entries()) {
      if (b.agent !== agent || this.runState(b) !== "on" || !this.state.bots[b.name]) continue
      await this.setState(b, "paused", { clientId: "core", how: "candle" })
      paused.push(b.name)
    }
    return paused
  }

  private async setState(b: CodeBotEntry, to: "paused" | "stopped", from: { clientId: string; how: "view" | "agent" | "build" | "candle"; agent?: string }) {
    const at = new Date(this.deps.now()).toISOString()
    const s = this.state.bots[b.name]
    if (s) {
      s.run = to
      s.by = { how: from.how, clientId: from.clientId, at, ...(from.agent ? { agent: from.agent } : {}) }
      this.persist()
    }
    const w = this.deps.file.write({ [b.name]: { ...b, state: to } })
    await this.deps.journal.append({
      type: to === "paused" ? "bot.paused" : "bot.stopped",
      mode: this.deps.mode(),
      kind: "code",
      agent: b.agent,
      name: b.name,
      by: from.clientId,
      how: from.how,
      ...(from.agent ? { changedBy: from.agent } : {}),
      ...(from.how === "candle" ? { reason: "RISK_LIMIT_REACHED", words: `Candle stopped ${b.agent}'s key (a loss limit or its circuit breaker), sells included: resume the key in Candle's Agent Console, then put the bot back on here` } : {}),
      ...(!w.ok ? { fileProblem: w.message } : {}),
    })
    this.deps.onChange()
    const what = to === "paused" ? "paused: its buys are refused, and its sells still run" : "stopped: none of its trades run, and its positions are left to you"
    return { name: b.name, state: to as BotRunState, said: w.ok ? `"${b.name}" is ${what}.` : `"${b.name}" is ${what}. bots.toml still says otherwise, since it has a problem: ${w.message}` }
  }

  /**
   * Removes a code bot, the person's, from the main view: its token is revoked at once, so it can't trade again.
   * Its positions are left in the wallet. Its rows stay in the journal. With the file unwritable, it's still stopped.
   */
  async remove(name: string, from: { clientId: string; main: boolean }, positions: "flatten" | "leave" = "leave"): Promise<{ name: string; said: string }> {
    const b = this.entry(name)
    const s = this.state.bots[name]
    if (!b && !s) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (!from.main) throw refused("MAIN_VIEW_ONLY", "A bot is removed from the main window, not a popped pane.")
    // Sold first, as its exits sell: each sell is decided with the bound its card approved, then goes on its own.
    let sold = ""
    if (positions === "flatten") {
      if (!b) throw refused("BOTS_FILE", `"${name}" isn't in bots.toml now, so its positions can't be read to sell. Nothing was removed.`)
      sold = ` ${(await this.flatten(name, { clientId: from.clientId, main: true })).said}`
    }
    await this.endToken(name, "removed")
    delete this.state.bots[name]
    this.persist()
    const w = b ? this.deps.file.write({ [name]: undefined }) : ({ ok: true } as const)
    await this.deps.journal.append({ type: "bot.removed", mode: this.deps.mode(), kind: "code", ...(b ? { agent: b.agent } : {}), name, positions, by: from.clientId, ...(!w.ok ? { fileProblem: w.message } : {}) })
    this.deps.onChange()
    const left = positions === "leave" ? " Any positions it held are left in the wallet, for you." : sold
    return { name, said: w.ok ? `"${name}" is removed: its token no longer connects.${left}` : `"${name}" won't trade again: its token no longer connects. It stays in bots.toml until its problem is fixed: ${w.message}${left}` }
  }

  /**
   * A token for a saved, approved code bot, to hand to it: each issue replaces the one before, whose connection
   * ends. The token is returned once and kept nowhere but by its hash.
   */
  async issueToken(name: string, why: "start" | "outside"): Promise<{ token: string; tokenId: string }> {
    const refusedWhy = this.admits(name)
    if (refusedWhy) throw refused(refusedWhy.code, `${refusedWhy.message} No token was issued.`)
    const b = this.entry(name)!
    const was = this.deps.tokens.botToken(name)
    const minted = await this.deps.tokens.mintBot(name, b.agent)
    if (was) this.deps.disconnect?.(was.tokenId)
    await this.deps.journal.append({ type: "bot.token", mode: this.deps.mode(), kind: "code", agent: b.agent, name, tokenId: minted.tokenId, what: was ? "renewed" : "issued", why })
    this.deps.onChange()
    return { token: minted.token, tokenId: minted.tokenId }
  }

  /**
   * Ends a code bot's token and its connection: the bot was removed; its process here was stopped, given up on or
   * ended on its own, so no copy of it left behind can trade; or it ran outside and another folder or command was
   * approved. True when it had one.
   */
  async endToken(name: string, why: "removed" | "process_stopped" | "process_gave_up" | "process_ended" | "new_version"): Promise<boolean> {
    const tokenId = await this.deps.tokens.revokeBot(name)
    if (!tokenId) return false
    this.deps.disconnect?.(tokenId)
    await this.deps.journal.append({ type: "bot.token", mode: this.deps.mode(), kind: "code", name, tokenId, what: "revoked", why })
    if (why !== "removed") this.deps.onChange()
    return true
  }

  /** The plan changed: on Free every code bot's buys are held, its sells still run; with Pro or Max back, they buy again. */
  async planChanged(): Promise<void> {
    const gate = this.gate()
    if (gate.state === "unknown") return
    const held = gate.state === "free"
    if (held === (this.state.planHeld === true)) {
      this.deps.onChange()
      return
    }
    this.state.planHeld = held
    this.persist()
    const names = this.entries()
      .filter((b) => this.state.bots[b.name] && this.runState(b) !== "stopped")
      .map((b) => b.name)
    if (names.length) {
      await this.deps.journal.append({
        type: held ? "bot.held" : "bot.released",
        mode: this.deps.mode(),
        kind: "code",
        names,
        reason: "plan",
        words: held ? `the plan is Free now: ${BOTS_PLAN_WORDS} to buy, and their sells of their own still run` : "the plan is Pro or Max again",
      })
    }
    this.deps.onChange()
  }

  private namesWords(): string {
    const names = this.entries().map((b) => `"${b.name}"`)
    return names.length ? ` Code bots: ${names.join(", ")}.` : " There are no code bots."
  }

  private persist(): void {
    const temp = `${this.deps.statePath}.tmp-${randomBytes(6).toString("base64url")}`
    writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, this.deps.statePath)
  }
}

/** The state, from the journal's code bot rows: each approved version, what it does now, and the plan's hold. */
export function rebuildCodeBots(rows: readonly JournalRow[]): StateFile {
  const out: StateFile = { bots: {} }
  for (const row of rows) {
    if (row.kind !== "code" || !row.type.startsWith("bot.")) continue
    if (row.type === "bot.held" || row.type === "bot.released") {
      if (row.reason === "plan") out.planHeld = row.type === "bot.held"
      continue
    }
    const name = typeof row.name === "string" ? row.name : undefined
    if (!name) continue
    const s = out.bots[name]
    const how = row.how === "agent" ? "agent" : row.how === "build" ? "build" : row.how === "candle" ? "candle" : row.by === "card" ? "card" : "view"
    const by: CodeBotState["by"] = { how, ...(typeof row.by === "string" && row.by !== "card" ? { clientId: row.by } : {}), ...(typeof row.changedBy === "string" ? { agent: row.changedBy } : {}), at: row.at }
    if ((row.type === "bot.saved" || row.type === "bot.changed") && typeof row.hash === "string") {
      const run = readRun(row.run)
      if (!run) continue
      const version: CodeBotVersion = { n: typeof row.version === "number" ? row.version : (s?.versions.at(-1)?.n ?? 0) + 1, hash: row.hash, run, at: row.at, ...(typeof row.cardId === "string" ? { cardId: row.cardId } : {}) }
      if (row.by === "card" || !s) out.bots[name] = { approved: row.hash, run: "on", by, savedAt: s?.savedAt ?? row.at, onSince: row.at, versions: [...(s?.versions ?? []), version] }
      else {
        s.approved = row.hash
        s.versions.push(version)
      }
    } else if (!s) {
      continue
    } else if (row.type === "bot.paused" || row.type === "bot.stopped") {
      s.run = row.type === "bot.paused" ? "paused" : "stopped"
      s.by = by
    } else if (row.type === "bot.resumed") {
      s.run = "on"
      s.by = by
      s.onSince = row.at
    } else if (row.type === "bot.removed") {
      delete out.bots[name]
    }
  }
  return out
}
