// Rules bots in the core: a Hacc strategy definition and its run settings, kept in bots.toml and checked by the
// shared reader (shared/definition.ts) when proposed, when saved and when narrowed.
//
// - Nothing makes, widens or takes a bot live but the person's press on its card: `save` runs only for an
//   approved card, bound by its hash. There's no method that saves one. Narrowing and pausing are at once, by
//   the person from any view or by the agent; stopping, resuming as approved, flattening and removing are the
//   person's, from the main view.
// - Each bot belongs to an agent: its trades use that agent's key and limits, from the wallet it was approved on.
// - What a bot does is on, paused (no new entries; its exits still sell, so its positions stay protected) or
//   stopped (nothing trades). bots.toml and the core each say; the stricter of the two holds, so a pause or a
//   stop typed into the file always takes, and only the person's own resume takes it back.
// - The state (state/bots.json, 0600) keeps the hash each bot was approved as, so a hand edit can't widen one
//   unseen: one that doesn't match takes no entries until it's approved again, and its exits run as it was
//   approved. It keeps every approved version, numbered, and the last signal it read. Without the file, it's
//   rebuilt from the journal's bot rows, which carry each version whole.
// - Bots need Pro or Max, as triggers do. On Free nothing is proposed, read or entered, and the topic says so.
//   A plan that ends holds every bot's entries; its exits still sell. One that returns puts them back.
import type { BotBookView } from "./bot-books"
import type { CodeBotView, CodeTestEnded, CodeTestView } from "./code-bots"
import { randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { type BotRunSettings, botHash, type Definition, type Exit, type LiveMark, readDefinition, refusedLive } from "../shared/definition"
import { narrowing, slippageProblem } from "../shared/definition-narrow"
import { definitionWords } from "../shared/definition-words"
import { refused } from "../shared/rpc"
import { PLAN_FIX } from "../shared/trigger-grammar"
import { type BotEntry, type BotRunState, type BotsFileStore, botNameProblem } from "./bots-file"
import { CANDLE_SLIPPAGE_BPS, CLI_SLIPPAGE_BPS } from "./cards"
import type { Mode } from "./classify"
import type { Journal, JournalRow } from "./journal"
import type { HaccPlan } from "./plan-state"
import type { PayWalletInfo } from "./triggers"

export const BOTS_PLAN_WORDS = "Bots need a Pro or Max plan"

/** Who set a bot's state, and when: the person from a view, an agent, a card, or Candle stopping the bot's key. */
export interface BotBy {
  how: "view" | "agent" | "card" | "candle"
  clientId?: string
  agent?: string
  at: string
}

export interface BotVersion {
  n: number
  hash: string
  definition: Definition
  run: BotRunSettings
  at: string
  cardId?: string
}

export interface BotState {
  /** The hash of what was approved: its definition and run settings. */
  approved: string
  run: BotRunState
  by: BotBy
  savedAt: string
  /** When it last went on: a signal from before it is never entered on. */
  onSince: string
  /** Every version approved, oldest first; the one whose hash is `approved` is what runs. */
  versions: BotVersion[]
  /** The newest signal it read, for a restart to read on from. */
  lastSignal?: { id: number; at: string }
}

interface StateFile {
  bots: Record<string, BotState>
  /** Whether the plan held them when last looked: so a restart doesn't journal it twice. */
  planHeld?: boolean
}

export type BotsGate = { state: "ok" } | { state: "free" | "unknown"; words: string }

/** What holds a bot, and whether its exits still sell while it's held. */
export interface BotHeld {
  code: "NOT_APPROVED" | "CHANGED_OUTSIDE" | "AGENT_GONE" | "PLAN_FREE" | "PLAN_UNKNOWN"
  words: string
  exits: boolean
}

export interface BotView {
  /** A rules bot: a definition the core runs. Code bots will sit beside them as their own kind. */
  kind: "rules"
  name: string
  agent: string
  /** The paying wallet's address, or "embedded". */
  wallet: string
  /** The wallet by its name, once it's read. */
  paysFrom?: string
  mode: "paper" | "live"
  /** What it does, the stricter of bots.toml and the core. */
  state: BotRunState
  /** Whether it enters now, and whether its exits sell now. */
  entries: boolean
  exits: boolean
  held?: { code: BotHeld["code"]; words: string }
  /** Who paused or stopped it, in words: "paused by agent-a at 14:02". */
  stateWords?: string
  /** Paused because Candle stopped its agent's key: the owner resumes the key in the Agent Console first. */
  byCandle?: true
  /** Its open positions, paper and live: a stopped bot's are left to the person, with no exits. */
  open?: number
  words: string
  definition: Definition
  maxSlippageBps?: number
  /** Its slippage bound is looser than its route's default: said in amber. */
  slippageLooser?: true
  /** What in its definition can't run live, where anything can't. */
  refused?: LiveMark[]
  /** The approved version that runs, and how many there are. */
  version?: number
  versions?: number
  savedAt?: string
  onSince?: string
  lastSignal?: { id: number; at: string }
  /** Its exits' sells that wait now: two failed sells of the token, Candle's pace, a failing route, a balance unread. */
  /** A live bot's wallet is shared: who else trades from it. Its book is the Candle Harness's count from its own fills. */
  sharedWith?: string[]
  /**
   * A live bot whose wallet is shared or asks every time: the steps to a wallet of its own, the same chip its card
   * showed ("new TEE wallet for agent-a"), for the person to come back to after approving it.
   */
  ownWallet?: { label: string; line: string }[]
  sellsHeld?: { mint: string; why: "failed_sells" | "unread" | "decimals" | "pace" | "route" | "unpriced"; words: string }[]
}

export interface BotsTopic {
  /** Undefined while bots are open on this plan. */
  gate?: { plan: "free" | "unknown"; words: string; fix?: string }
  bots: BotView[]
  /** Code bots: programs of the person's own, held by the core to their figures. */
  code?: CodeBotView[]
  /** Paper test runs from Build panes, each ending with its pane or within 30 minutes. */
  tests?: CodeTestView[]
  /** The newest tests that ended, newest first: what each said as it ended, its paper positions left open among it. */
  testsEnded?: CodeTestEnded[]
  /** Code bots' cards waiting for the person: a new bot's or a change's, by its folder. */
  codeCards?: { name: string; folder: string; cardId: string; change: boolean }[]
  problems: string[]
  /** Each bot's book by name, as the Bots tab shows it: the Candle Harness's count from its own fills. */
  books?: Record<string, BotBookView>
}

/** A bot as an agent proposes it: its name, Hacc's definition as written, and what it runs as. */
export interface BotProposal {
  name: string
  definition: unknown
  run: { agent: string; wallet: string; mode: "paper" | "live"; maxSlippageBps?: number }
}

/** A proposal checked whole, as its card shows it and its hash binds it. */
export interface BotCheck {
  name: string
  definition: Definition
  run: BotRunSettings
  hash: string
  words: string
  /** The wallet by its name. */
  paysFrom: string
  /** A bot of that name is already saved: the card says it replaces it. */
  replaces?: true
  /** A saved one the person paused or stopped: a change keeps it so, and its card says it. */
  stays?: "paused" | "stopped"
}

export interface BotBookDeps {
  file: BotsFileStore
  statePath: string
  journal: Journal
  /** The configured agents that have a key. */
  agents(): string[]
  plan(agent: string): HaccPlan | undefined
  /** The Candle Harness's mode, for the journal's rows: a bot's own is in its run settings. */
  mode(): Mode
  now(): number
  /** The wallet an agent pays from, by "embedded", a name or an address; undefined before it's read or when it can't pay. */
  payWallet(agent: string, wallet: string): PayWalletInfo | undefined
  /** Why the agent can't pay from the wallet, in the payer's own words; undefined when that isn't known yet. */
  payRefusal?(agent: string, wallet: string): string | undefined
  /** How many positions a bot holds open, paper and live: one whose entries are held keeps the core up only while it holds some. */
  openPositions?(name: string): number
  onChange(): void
}

/** What a flatten does once the bot's book is wired: sells every open position, as its exits sell. */
export type Flattener = (bot: BotEntry, by: { clientId: string; how: "view" | "agent"; agent?: string }) => Promise<{ said: string }>

const RANK: Record<BotRunState, number> = { on: 0, paused: 1, stopped: 2 }
const stricter = (a: BotRunState, b: BotRunState): BotRunState => (RANK[a] >= RANK[b] ? a : b)

/** What a change of exits that sells open positions at once is, on its refusal and its card. */
export const sellsNowWords = (n: number) => `its new exits would sell ${n === 1 ? "its open position" : `${n} of its open positions`} now`

/**
 * A bot's own slippage bound as its card says it. Amber where it's off the route's default either way: looser, its
 * trades can fill at a worse price; tighter, its sells may not fill at all.
 */
export function slippageOnCard(bps: number, wallet: string): { words: string; looser: boolean } {
  const route = routeSlippageBps(wallet)
  const pct = (n: number) => `${Number((n / 100).toFixed(2))}%`
  const off = bps > route ? `, looser than the route's ${pct(route)}` : bps < route ? `, under the route's ${pct(route)}: its sells may not fill` : ""
  return { words: `its own slippage bound: ${pct(bps)}${off}`, looser: bps !== route }
}

/** The route's own slippage bound for a wallet: Candle's server for the embedded wallet, the CLI's for a TEE wallet. */
export const routeSlippageBps = (wallet: string) => (wallet === "embedded" ? CANDLE_SLIPPAGE_BPS : CLI_SLIPPAGE_BPS)

const runOf = (b: Pick<BotEntry, "agent" | "wallet" | "mode" | "maxSlippageBps">): BotRunSettings => ({
  agent: b.agent,
  wallet: b.wallet,
  mode: b.mode,
  ...(b.maxSlippageBps !== undefined ? { maxSlippageBps: b.maxSlippageBps } : {}),
})

export const hashOf = (b: Pick<BotEntry, "agent" | "wallet" | "mode" | "maxSlippageBps" | "definition">) => botHash(b.definition, runOf(b))

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export class BotBook {
  private state: StateFile = { bots: {} }
  private flattener: Flattener | undefined
  private sellsNow: ((name: string, now: Exit | undefined, next: Exit | undefined) => number) | undefined

  constructor(private readonly deps: BotBookDeps) {
    try {
      const saved = JSON.parse(readFileSync(deps.statePath, "utf8")) as Partial<StateFile>
      if (saved && typeof saved.bots === "object" && saved.bots !== null) {
        for (const [name, s] of Object.entries(saved.bots)) {
          const b = s as Partial<BotState>
          if (typeof b.approved !== "string" || !(b.run === "on" || b.run === "paused" || b.run === "stopped") || typeof b.savedAt !== "string" || !Array.isArray(b.versions)) continue
          const versions = b.versions.filter((v): v is BotVersion => typeof v?.hash === "string" && typeof v.n === "number" && readDefinition(v.definition).ok)
          if (!versions.length) continue
          this.state.bots[name] = {
            approved: b.approved,
            run: b.run,
            by: b.by && typeof b.by === "object" && typeof b.by.at === "string" ? b.by : { how: "card", at: b.savedAt },
            savedAt: b.savedAt,
            onSince: typeof b.onSince === "string" ? b.onSince : b.savedAt,
            versions,
            ...(b.lastSignal && typeof b.lastSignal.id === "number" && typeof b.lastSignal.at === "string" ? { lastSignal: b.lastSignal } : {}),
          }
        }
        if (saved.planHeld === true) this.state.planHeld = true
        return
      }
    } catch {}
    this.state = rebuild(deps.journal.botRows())
  }

  /** bots.toml, which code bots share: one store, so each write sees the other kind's bots. */
  get file(): BotsFileStore {
    return this.deps.file
  }

  /** Called once the bot's book can sell its positions: until then, a flatten is refused, and nothing is sold. */
  setFlattener(flattener: Flattener): void {
    this.flattener = flattener
  }

  /** Once the bots' exits are wired: how many open positions a change of exits would sell at once. */
  setSellsNow(sellsNow: (name: string, now: Exit | undefined, next: Exit | undefined) => number): void {
    this.sellsNow = sellsNow
  }

  /**
   * How many of a saved bot's open positions a change to these exits would sell on the next check. Selling what a
   * bot holds is a flatten, which is the person's press: such a change is a card, never a narrowing at once.
   */
  wouldSellNow(name: string, next: Exit | undefined): number {
    const b = this.entry(name)
    return b && this.sellsNow ? this.sellsNow(name, b.definition.exit, next) : 0
  }

  /** Whether bots are open for this agent's plan, or any agent's. */
  gate(agent?: string): BotsGate {
    const agents = agent ? [agent] : this.deps.agents()
    const plans = agents.map((a) => this.deps.plan(a))
    if (plans.some((p) => p === "pro" || p === "max")) return { state: "ok" }
    if (plans.some((p) => p === "free")) return { state: "free", words: `${BOTS_PLAN_WORDS}. This account is on Free.` }
    return { state: "unknown", words: "The account's plan hasn't been read yet, so bots wait for it." }
  }

  /** Each bot as the file holds it. */
  entries(): BotEntry[] {
    return this.deps.file.read().bots
  }

  entry(name: string): BotEntry | undefined {
    return this.entries().find((b) => b.name === name)
  }

  stateOf(name: string): BotState | undefined {
    return this.state.bots[name]
  }

  /** The version a bot was approved as: what its exits run by while a hand edit holds its entries. */
  approvedVersion(name: string): BotVersion | undefined {
    const s = this.state.bots[name]
    return s?.versions.find((v) => v.hash === s.approved)
  }

  /** The slippage bound a bot was approved with, whatever a hand edit says: its trades run at it, named on each receipt. */
  approvedSlippage(name: string): number | undefined {
    const v = this.approvedVersion(name)
    return v ? v.run.maxSlippageBps : undefined
  }

  /** What a bot does now: the stricter of the file and the core. */
  runState(b: BotEntry): BotRunState {
    const s = this.state.bots[b.name]
    return s ? stricter(b.state, s.run) : b.state
  }

  /** What holds a bot, or undefined when nothing does. */
  heldBy(b: BotEntry): BotHeld | undefined {
    const s = this.state.bots[b.name]
    if (!s) return { code: "NOT_APPROVED", exits: false, words: "It was added to bots.toml outside the Candle Harness, so it doesn't run: ask the agent to propose it, and approve its card." }
    if (s.approved !== hashOf(b)) {
      return { code: "CHANGED_OUTSIDE", exits: true, words: "It was changed in bots.toml since it was approved, so it takes no new entries; its exits still sell as it was approved. Ask the agent to propose the change, and approve its card." }
    }
    if (!this.deps.agents().includes(b.agent)) return { code: "AGENT_GONE", exits: false, words: `${b.agent} isn't one of your agents now, so it doesn't trade.` }
    const gate = this.gate(b.agent)
    if (gate.state === "free") return { code: "PLAN_FREE", exits: true, words: `The plan is Free now. ${BOTS_PLAN_WORDS} to enter; its exits still sell, and it comes back on with one.` }
    if (gate.state === "unknown") return { code: "PLAN_UNKNOWN", exits: true, words: `${gate.words} Its exits still sell.` }
    return undefined
  }

  /** Whether a bot enters now, and whether its exits sell now. */
  runs(b: BotEntry): { entries: boolean; exits: boolean } {
    const state = this.runState(b)
    const held = this.heldBy(b)
    return { entries: state === "on" && !held, exits: state !== "stopped" && (!held || held.exits) }
  }

  /** The bots that enter now. */
  live(): BotEntry[] {
    return this.entries().filter((b) => this.runs(b).entries)
  }

  /** The bots that keep the core running: each that enters, or whose exits sell a position it holds. A stopped one doesn't. */
  keepingUp(): BotEntry[] {
    return this.entries().filter((b) => {
      const r = this.runs(b)
      return r.entries || (r.exits && (this.deps.openPositions ? this.deps.openPositions(b.name) > 0 : true))
    })
  }

  view(): BotsTopic {
    const file = this.deps.file.read()
    const gate = this.gate()
    return {
      ...(gate.state !== "ok" ? { gate: { plan: gate.state, words: gate.state === "free" ? BOTS_PLAN_WORDS : gate.words, ...(gate.state === "free" ? { fix: PLAN_FIX } : {}) } } : {}),
      bots: file.bots.map((b) => this.viewOf(b)),
      problems: file.problems,
    }
  }

  private viewOf(b: BotEntry): BotView {
    const s = this.state.bots[b.name]
    const state = this.runState(b)
    const held = this.heldBy(b)
    const r = this.runs(b)
    const v = this.approvedVersion(b.name)
    const refusedMarks = refusedLive(b.definition)
    const pays = this.deps.payWallet(b.agent, b.wallet)
    return {
      kind: "rules",
      name: b.name,
      agent: b.agent,
      wallet: b.wallet,
      ...(pays ? { paysFrom: pays.name } : {}),
      mode: b.mode,
      state,
      entries: r.entries,
      exits: r.exits,
      // A hand edit is said whatever its state; the rest only hold one that isn't stopped.
      ...(held && (state !== "stopped" || held.code === "NOT_APPROVED" || held.code === "CHANGED_OUTSIDE") ? { held: { code: held.code, words: held.words } } : {}),
      ...(state !== "on" ? { stateWords: this.stateWords(b, state) } : {}),
      ...(state === "paused" && s?.by.how === "candle" && RANK[b.state] <= RANK[s.run] ? { byCandle: true as const } : {}),
      ...(this.deps.openPositions ? { open: this.deps.openPositions(b.name) } : {}),
      words: definitionWords(b.definition),
      definition: b.definition,
      ...(b.maxSlippageBps !== undefined ? { maxSlippageBps: b.maxSlippageBps } : {}),
      ...(b.maxSlippageBps !== undefined && b.maxSlippageBps > routeSlippageBps(b.wallet) ? { slippageLooser: true as const } : {}),
      ...(refusedMarks.length ? { refused: refusedMarks } : {}),
      ...(v ? { version: v.n } : {}),
      ...(s ? { versions: s.versions.length, savedAt: s.savedAt, onSince: s.onSince } : {}),
      ...(s?.lastSignal ? { lastSignal: s.lastSignal } : {}),
    }
  }

  private stateWords(b: BotEntry, state: BotRunState): string {
    const open = this.deps.openPositions?.(b.name) ?? 0
    const left = open ? `its ${open === 1 ? "position is" : `${open} positions are`} left to you` : "it holds nothing"
    const what = state === "paused" ? "paused: no new entries, its exits still sell" : `stopped: nothing trades, and ${left}`
    const s = this.state.bots[b.name]
    // The file is stricter than the core: set by hand.
    if (!s || RANK[b.state] > RANK[s.run]) return `${what}, set in bots.toml`
    if (s.by.how === "candle") return `${what}. Candle stopped ${b.agent}'s key at ${hhmm(s.by.at)} (a loss limit or its circuit breaker), sells included: resume the key in Candle's Agent Console, then put the bot back on here`
    const who = s.by.how === "agent" ? (s.by.agent ?? "its agent") : "you"
    return `${what}, by ${who} at ${hhmm(s.by.at)}`
  }

  /**
   * Candle stopped an agent's key (RISK_LIMIT_REACHED): every bot of that agent that's on is paused, so none enters
   * when the owner resumes the key. Its exits still sell once the key trades again. Putting each back on is the
   * person's, as any resume. The bots it paused, by name.
   */
  async pauseByCandle(agent: string): Promise<string[]> {
    const paused: string[] = []
    for (const b of this.entries()) {
      if (b.agent !== agent || this.runState(b) !== "on" || !this.state.bots[b.name]) continue
      await this.setState(b, this.state.bots[b.name], "paused", { clientId: "core", how: "candle" })
      paused.push(b.name)
    }
    return paused
  }

  /**
   * A bot as proposed, checked whole for a card: its agent, the plan, its name, its definition as Hacc reads it,
   * that every part of it runs live, its mode and slippage, and the wallet it pays from. Throws a refusal in words.
   */
  check(p: BotProposal, proposer: string): BotCheck {
    if (!this.deps.agents().includes(proposer)) throw refused("UNKNOWN_AGENT", `${proposer} has no key here, so it can't hold a bot.`)
    if (p.run.agent !== proposer) throw refused("NOT_ITS_AGENT", `A bot belongs to the agent that makes it, and trades with its key: ${proposer} can't make one for ${p.run.agent}.`)
    const gate = this.gate(proposer)
    if (gate.state === "free") throw refused("BOTS_NEED_PLAN", `${BOTS_PLAN_WORDS}. This account is on Free, so nothing was proposed.`)
    if (gate.state === "unknown") throw refused("PLAN_UNKNOWN", `${gate.words} Try again in a moment. Nothing was proposed.`)
    const why = botNameProblem(p.name)
    if (why) throw refused("INVALID_BOT_NAME", `"${p.name}" can't name a bot: ${why}.`)
    if (this.deps.file.read().code.some((b) => b.name === p.name)) throw refused("NAME_TAKEN", `A code bot is named "${p.name}". Give this one a name of its own. Nothing was proposed.`)
    const read = readDefinition(p.definition)
    if (!read.ok) throw refused("INVALID_DEFINITION", `Hacc's lab wouldn't take this definition: ${read.message}`)
    const notLive = refusedLive(read.definition)
    if (notLive.length) throw refused("NOT_LIVE", `This can be backtested, not run as a bot: ${notLive.map((m) => `${m.path}: ${m.why}`).join(" ")}`)
    if (p.run.mode !== "paper" && p.run.mode !== "live") throw refused("INVALID_MODE", 'A bot runs on "paper" or "live".')
    const bps = p.run.maxSlippageBps
    // A bound the bot already runs at stands as it was approved; a new one has a floor.
    const slipProblem = bps !== undefined && bps !== this.entry(p.name)?.maxSlippageBps ? slippageProblem(bps) : undefined
    if (slipProblem) throw refused("INVALID_SLIPPAGE", slipProblem)
    const pays = this.deps.payWallet(proposer, p.run.wallet)
    if (!pays) throw refused("WALLET_CANT_PAY", `${this.deps.payRefusal?.(proposer, p.run.wallet) ?? `${proposer} can't pay from "${p.run.wallet}", or its wallets haven't been read yet.`} Nothing was proposed.`)
    const run: BotRunSettings = { agent: proposer, wallet: pays.name === "embedded" ? "embedded" : pays.address, mode: p.run.mode, ...(bps !== undefined ? { maxSlippageBps: bps } : {}) }
    const saved = this.entry(p.name)
    const now = saved ? this.runState(saved) : "on"
    return {
      name: p.name,
      definition: read.definition,
      run,
      hash: botHash(read.definition, run),
      words: definitionWords(read.definition),
      paysFrom: pays.name,
      ...(saved ? { replaces: true as const } : {}),
      ...(now !== "on" ? { stays: now } : {}),
    }
  }

  /**
   * Saves a bot whose card the person approved, checked whole again now. `hash` is what the card bound: anything
   * that reads differently now is refused. A name already saved is replaced only when the card said so.
   */
  async save(p: BotProposal, proposer: string, by: { hash: string; replace?: boolean; cardId?: string; opId?: string }): Promise<{ name: string; replaced: boolean; version: number }> {
    const c = this.check(p, proposer)
    if (c.hash !== by.hash) throw refused("BOT_CHANGED", `"${c.name}" reads differently now than when its card was made (its wallet or definition moved). Nothing was saved; ask for it again.`)
    const was = this.entry(c.name)
    if (was && !by.replace) throw refused("NAME_TAKEN", `A bot named "${c.name}" is already saved. Give this one another name, or replace that one.`)
    // A change keeps a bot the person paused or stopped as it was: putting it back on is theirs, by its own click.
    const keeps = c.stays ?? "on"
    const entry: BotEntry = { name: c.name, ...c.run, state: keeps, definition: c.definition }
    const w = this.deps.file.write({ [c.name]: entry })
    if (!w.ok) throw refused("BOTS_FILE", `${w.message} Nothing was saved.`)
    const at = new Date(this.deps.now()).toISOString()
    const prior = this.state.bots[c.name]
    const n = (prior?.versions.at(-1)?.n ?? 0) + 1
    const version: BotVersion = { n, hash: c.hash, definition: c.definition, run: c.run, at, ...(by.cardId ? { cardId: by.cardId } : {}) }
    this.state.bots[c.name] = {
      approved: c.hash,
      run: keeps,
      by: keeps === "on" || !prior ? { how: "card", at } : prior.by,
      savedAt: prior?.savedAt ?? at,
      onSince: keeps === "on" || !prior ? at : prior.onSince,
      versions: [...(prior?.versions ?? []), version],
    }
    this.persist()
    await this.deps.journal.append({
      type: was ? "bot.changed" : "bot.saved",
      mode: this.deps.mode(),
      agent: c.run.agent,
      name: c.name,
      words: c.words,
      hash: c.hash,
      version: n,
      definition: c.definition,
      run: c.run,
      state: keeps,
      by: "card",
      ...(by.cardId ? { cardId: by.cardId } : {}),
      ...(by.opId ? { opId: by.opId } : {}),
      ...(was ? { replaced: true } : {}),
    })
    this.deps.onChange()
    return { name: c.name, replaced: Boolean(was), version: n }
  }

  /**
   * Narrows a saved bot at once: a definition that only buys less, buys on less, holds less or sells sooner, and
   * a slippage bound tightened no further than the route's default. Anything wider is refused, naming it, for a card. A bot changed by hand
   * isn't narrowed: its change waits for its card. Its state, entries and book are kept as they were.
   */
  async narrow(name: string, next: { definition: unknown; maxSlippageBps?: number }, from: { clientId: string; how: "view" | "agent"; agent?: string }): Promise<{ name: string; version: number; narrowed: string[]; said: string }> {
    const b = this.entry(name)
    const s = this.state.bots[name]
    if (!b || !s) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (from.how === "agent" && from.agent !== b.agent) throw refused("NOT_ITS_AGENT", `"${name}" is ${b.agent}'s bot: only ${b.agent}, or you, can narrow it.`)
    const held = this.heldBy(b)
    if (held && (held.code === "NOT_APPROVED" || held.code === "CHANGED_OUTSIDE")) throw refused(held.code, `"${name}" can't be narrowed: ${held.words}`)
    const read = readDefinition(next.definition)
    if (!read.ok) throw refused("INVALID_DEFINITION", `Hacc's lab wouldn't take this definition: ${read.message}`)
    const notLive = refusedLive(read.definition)
    if (notLive.length) throw refused("NOT_LIVE", `That can be backtested, not run as a bot: ${notLive.map((m) => `${m.path}: ${m.why}`).join(" ")} "${name}" is unchanged.`)
    const bps = next.maxSlippageBps
    const slipProblem = bps !== undefined && bps !== b.maxSlippageBps ? slippageProblem(bps) : undefined
    if (slipProblem) throw refused("INVALID_SLIPPAGE", slipProblem)
    const wasRun = runOf(b)
    const run: BotRunSettings = { ...wasRun, ...(bps !== undefined ? { maxSlippageBps: bps } : {}) }
    const n = narrowing({ definition: b.definition, run: wasRun }, { definition: read.definition, run }, routeSlippageBps(b.wallet))
    if (!n.ok) throw refused("WIDER", `That's wider than "${name}" was approved: ${n.wider}. A wider bot is a new card for you to press. "${name}" is unchanged.`)
    if (!n.what.length) throw refused("NO_CHANGE", `That's what "${name}" already runs, so nothing changed.`)
    const sells = this.wouldSellNow(name, read.definition.exit)
    if (sells > 0) throw refused("WIDER", `${sellsNowWords(sells)[0]!.toUpperCase()}${sellsNowWords(sells).slice(1)}. That's a flatten, and a card for you to press. "${name}" is unchanged.`)
    const entry: BotEntry = { ...b, ...(run.maxSlippageBps !== undefined ? { maxSlippageBps: run.maxSlippageBps } : {}), definition: read.definition }
    const hash = botHash(read.definition, run)
    const w = this.deps.file.write({ [name]: entry })
    if (!w.ok) throw refused("BOTS_FILE", `${w.message} "${name}" is unchanged.`)
    const at = new Date(this.deps.now()).toISOString()
    const version: BotVersion = { n: (s.versions.at(-1)?.n ?? 0) + 1, hash, definition: read.definition, run, at }
    s.approved = hash
    s.versions.push(version)
    this.persist()
    await this.deps.journal.append({
      type: "bot.changed",
      mode: this.deps.mode(),
      agent: b.agent,
      name,
      words: definitionWords(read.definition),
      hash,
      version: version.n,
      definition: read.definition,
      run,
      by: from.clientId,
      how: from.how,
      ...(from.agent ? { changedBy: from.agent } : {}),
      narrowed: n.what,
    })
    this.deps.onChange()
    return { name, version: version.n, narrowed: n.what, said: `"${name}" is narrowed: ${n.what.join("; ")}.` }
  }

  /** Pauses a bot, at once, from any view or by its agent: no new entries; its exits still sell. */
  async pause(name: string, from: { clientId: string; how: "view" | "agent"; agent?: string }): Promise<{ name: string; state: BotRunState; said: string }> {
    const b = this.entry(name)
    const s = this.state.bots[name]
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (from.how === "agent" && from.agent !== b.agent) throw refused("NOT_ITS_AGENT", `"${name}" is ${b.agent}'s bot: only ${b.agent}, or you, can pause it.`)
    const now = this.runState(b)
    if (now === "stopped") return { name, state: now, said: `"${name}" is stopped, so it takes no entries already, and its exits don't sell. Resuming it is yours, in the main window.` }
    if (now === "paused") return { name, state: now, said: `"${name}" is paused already: no new entries, and its exits still sell.` }
    return this.setState(b, s, "paused", from)
  }

  /** Stops a bot: no entries and no exits. Its positions stay in the wallet, for you. The person's, from the main view. */
  async stop(name: string, from: { clientId: string; main: boolean }): Promise<{ name: string; state: BotRunState; said: string }> {
    const b = this.entry(name)
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (!from.main) throw refused("MAIN_VIEW_ONLY", "A bot is stopped from the main window, not a popped pane: a stop leaves its positions without exits.")
    if (this.runState(b) === "stopped") return { name, state: "stopped", said: `"${name}" is stopped already.` }
    return this.setState(b, this.state.bots[name], "stopped", { clientId: from.clientId, how: "view" })
  }

  /** Puts a paused or stopped bot back on, as it was approved. The person's, from the main view. */
  async resume(name: string, from: { clientId: string; main: boolean; how?: "view" | "agent" }): Promise<{ name: string; state: BotRunState; said: string }> {
    if (from.how === "agent") throw refused("PERSON_ONLY", "Only the person puts a bot back on, as it was approved, in the main window.")
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
    await this.deps.journal.append({ type: "bot.resumed", mode: this.deps.mode(), agent: b.agent, name, by: from.clientId, how: "view" })
    this.deps.onChange()
    return { name, state: "on", said: `"${name}" is on again, as it was approved: it enters on signals from now.` }
  }

  /** Pause and stop: the core's state first, so it holds even when the file can't be written. */
  private async setState(b: BotEntry, s: BotState | undefined, to: "paused" | "stopped", from: { clientId: string; how: "view" | "agent" | "candle"; agent?: string }) {
    const at = new Date(this.deps.now()).toISOString()
    if (s) {
      s.run = to
      s.by = { how: from.how, clientId: from.clientId, at, ...(from.agent ? { agent: from.agent } : {}) }
      this.persist()
    }
    const w = this.deps.file.write({ [b.name]: { ...b, state: to } })
    await this.deps.journal.append({
      type: to === "paused" ? "bot.paused" : "bot.stopped",
      mode: this.deps.mode(),
      agent: b.agent,
      name: b.name,
      by: from.clientId,
      how: from.how,
      ...(from.agent ? { changedBy: from.agent } : {}),
      ...(from.how === "candle" ? { reason: "RISK_LIMIT_REACHED", words: `Candle stopped ${b.agent}'s key (a loss limit or its circuit breaker), sells included: resume the key in Candle's Agent Console, then put the bot back on here` } : {}),
      ...(!w.ok ? { fileProblem: w.message } : {}),
    })
    this.deps.onChange()
    const what = to === "paused" ? "paused: no new entries, and its exits still sell" : "stopped: nothing trades, and its positions are left to you"
    return { name: b.name, state: to as BotRunState, said: w.ok ? `"${b.name}" is ${what}.` : `"${b.name}" is ${what}. bots.toml still says otherwise, since it has a problem: ${w.message}` }
  }

  /** Sells every open position of a bot now, through the same rules as its exits. The person's, from the main view. */
  async flatten(name: string, from: { clientId: string; main: boolean; how?: "view" | "agent"; agent?: string }): Promise<{ name: string; said: string }> {
    const b = this.entry(name)
    if (!b) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (from.how !== "agent" && !from.main) throw refused("MAIN_VIEW_ONLY", "A bot is flattened from the main window, not a popped pane.")
    if (!this.flattener) throw refused("NOT_READY", "This core can't sell a bot's positions yet, so nothing was sold.")
    return { name, said: (await this.flattener(b, { clientId: from.clientId, how: from.how ?? "view", ...(from.agent ? { agent: from.agent } : {}) })).said }
  }

  /**
   * Removes a bot, the person's, from the main view: `positions` says whether its open positions are sold first or
   * left in the wallet. Its book and events stay in the journal. With the file unwritable, it's still stopped.
   */
  async remove(name: string, positions: "flatten" | "leave", from: { clientId: string; main: boolean }): Promise<{ name: string; said: string }> {
    const b = this.entry(name)
    const s = this.state.bots[name]
    if (!b && !s) throw refused("UNKNOWN_BOT", `No bot named "${name}".${this.namesWords()}`)
    if (!from.main) throw refused("MAIN_VIEW_ONLY", "A bot is removed from the main window, not a popped pane.")
    let sold = ""
    if (positions === "flatten") {
      if (!b) throw refused("BOTS_FILE", `"${name}" isn't in bots.toml now, so its positions can't be read to sell. Nothing was removed.`)
      sold = ` ${(await this.flatten(name, { clientId: from.clientId, main: true })).said}`
    }
    delete this.state.bots[name]
    this.persist()
    const w = b ? this.deps.file.write({ [name]: undefined }) : ({ ok: true } as const)
    await this.deps.journal.append({ type: "bot.removed", mode: this.deps.mode(), ...(b ? { agent: b.agent } : {}), name, positions, by: from.clientId, ...(!w.ok ? { fileProblem: w.message } : {}) })
    this.deps.onChange()
    const left = positions === "leave" ? " Any positions it held are left in the wallet, for you." : sold
    return { name, said: w.ok ? `"${name}" is removed.${left}` : `"${name}" won't trade again. It stays in bots.toml until its problem is fixed: ${w.message}${left}` }
  }

  /** The newest signal a bot read: kept so a restart reads on from it. */
  setLastSignal(name: string, signal: { id: number; at: string }): void {
    const s = this.state.bots[name]
    if (!s || (s.lastSignal && s.lastSignal.id >= signal.id)) return
    s.lastSignal = signal
    this.persist()
  }

  /** The plan changed: on Free every bot's entries are held, its exits still sell; with Pro or Max back, they enter again. Journalled once each way. */
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
        names,
        reason: "plan",
        words: held ? `the plan is Free now: ${BOTS_PLAN_WORDS} to enter, and their exits still sell` : "the plan is Pro or Max again",
      })
    }
    this.deps.onChange()
  }

  private namesWords(): string {
    const names = this.entries().map((b) => `"${b.name}"`)
    return names.length ? ` Bots: ${names.join(", ")}.` : " There are none."
  }

  private persist(): void {
    const temp = `${this.deps.statePath}.tmp-${randomBytes(6).toString("base64url")}`
    writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, this.deps.statePath)
  }
}

/** The state, from the journal's bot rows: each approved version, what it does now, and the plan's hold. */
export function rebuild(rows: readonly JournalRow[]): StateFile {
  const out: StateFile = { bots: {} }
  for (const row of rows) {
    // A code bot's rows are its own book's (code-bots.ts).
    if (row.kind === "code") continue
    if (row.type === "bot.held" || row.type === "bot.released") {
      if (row.reason === "plan") out.planHeld = row.type === "bot.held"
      continue
    }
    const name = typeof row.name === "string" ? row.name : undefined
    if (!name || !row.type.startsWith("bot.")) continue
    const s = out.bots[name]
    const by: BotBy = { how: row.how === "agent" ? "agent" : row.how === "candle" ? "candle" : row.by === "card" ? "card" : "view", ...(typeof row.by === "string" && row.by !== "card" ? { clientId: row.by } : {}), ...(typeof row.changedBy === "string" ? { agent: row.changedBy } : {}), at: row.at }
    if ((row.type === "bot.saved" || row.type === "bot.changed") && typeof row.hash === "string") {
      const read = readDefinition(row.definition)
      const run = row.run as BotRunSettings | undefined
      if (!read.ok || !run || typeof run.agent !== "string") continue
      const version: BotVersion = { n: typeof row.version === "number" ? row.version : (s?.versions.at(-1)?.n ?? 0) + 1, hash: row.hash, definition: read.definition, run, at: row.at, ...(typeof row.cardId === "string" ? { cardId: row.cardId } : {}) }
      if (row.by === "card" || !s) {
        // An approved card: on, from now.
        out.bots[name] = { approved: row.hash, run: "on", by, savedAt: s?.savedAt ?? row.at, onSince: row.at, versions: [...(s?.versions ?? []), version] }
      } else {
        // A narrowing: what it's approved as, nothing else.
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

