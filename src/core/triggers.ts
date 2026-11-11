// Triggers in the core: "when X, do Y", kept in triggers.toml and checked by the shared grammar
// (shared/trigger-grammar.ts) when proposed, when saved and again when they fire.
//
// - Nothing adds or widens a trigger but the person's press on its card: `save` runs only for an approved
//   card. There's no method that saves one. Switching one off, or removing it, is at once, from any view;
//   switching it back on, as it was approved, is the main view's.
// - Each trigger belongs to an agent: its trades use that agent's key, limits and wallets.
// - The state (state/triggers.json, 0600) keeps the hash each trigger was approved as, so a hand edit to
//   triggers.toml can't add or widen one unseen: one that doesn't match is held until it's approved again.
//   It also keeps whether each is switched on, armed or fired, and when it last fired. Without the file,
//   it's rebuilt from the journal's trigger rows.
// - Paper or live is the trigger's own, set when its card is approved and part of what's approved: its trades
//   go so whatever mode the Candle Harness is in when it fires, so switching to paper never turns a live stop
//   into a paper trade, nor uses it up. Taking one live is a new card.
// - Triggers need Pro or Max. On Free nothing is proposed, read or fired, and the topic says so. A plan
//   that ends holds every trigger as it is; one that returns puts them back.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { canonicalJson } from "../shared/canonical-json"
import { refused } from "../shared/rpc"
import {
  type ResolvedTrigger,
  type Read,
  type BotEvent,
  classOf,
  isOnce,
  DEFAULT_COOLDOWN_MS,
  defaultName,
  durationWords,
  fullLine,
  IT_MINT,
  PLAN_FIX,
  PLAN_WORDS,
  parseTriggerShape,
  partsOfAction,
  resolveTrigger,
  type TriggerClass,
  type TriggerWhen,
  triggerWords,
} from "../shared/trigger-grammar"
import type { WalletSetting } from "./autonomy"
import type { Mode } from "./classify"
import type { Journal, JournalRow } from "./journal"
import { usd } from "./limits"
import type { LineReader } from "./line-reader"
import type { HaccPlan } from "./plan-state"
import type { TriggerEntry, TriggersFileStore } from "./triggers-file"
import { type ChainSlug, chainName, requestChain } from "../shared/chains"

export interface TriggerState {
  /** The hash of what was approved: agent, expansion, again and cooldown. */
  approved: string
  on: boolean
  /** A level waiting to fire; false once it fired (until again re-arms it, or it's switched on again). */
  armed: boolean
  savedAt: string
  /** When it was last switched on (saved, or back on): a tape or personal signal from before it is never acted on. */
  onSince?: string
  lastFired?: string
  /** When a schedule runs next, as its watcher last worked out. */
  nextRun?: string
  /** For the tape and personal signals: each token's last firing. */
  cooldowns?: Record<string, string>
  /** Paper or live, as approved. For one saved before the file kept a mode: the mode its approval was recorded in. */
  mode?: Mode
}

interface StateFile {
  triggers: Record<string, TriggerState>
  /** Whether the plan held them when last looked: so a restart doesn't journal it twice. */
  planHeld?: boolean
}

export type Gate = { state: "ok" } | { state: "free" | "unknown"; words: string }

export interface TriggerView {
  name: string
  agent: string
  /** The line as shown on its card: the body, then again, cooldown and its name. */
  line: string
  expansion: string
  words: string
  class: TriggerClass
  /** Switched on (by the person, or as approved). */
  on: boolean
  /** On, and nothing holds it: it watches, and fires. */
  live: boolean
  /** Paper or live, as approved: its trades go so whatever the Candle Harness's mode is. */
  mode: Mode
  held?: { code: string; words: string }
  again: boolean
  cooldownMs?: number
  armed: boolean
  lastFired?: string
  nextRun?: string
  /** The line read now means something else than its expansion: an alias or a name changed since. */
  readsNow?: string
  /** What its watcher sees, in words: "checked about every 5 s · JUP $0.4312", "next run 09:00 tomorrow". */
  watching?: string
  /** A level's measured pace: how often its token's price is read. */
  paceMs?: number
  /** How its command runs now, by its wallet's setting today: on its own, or a card for the person each time. */
  runs?: Runs
  /** The wallet its first trade pays from, by name. */
  paysFrom?: string
  /** Its last card that expired with nobody there, not run again yet: `run it now` proposes it at a fresh price. */
  expired?: { cardId: string; at: string }
  /** For one that asks each time: the steps toward a wallet of its own, each a line for the input line. */
  fills?: { label: string; line: string }[]
}

export interface TriggersTopic {
  /** Undefined while triggers are open on this plan. */
  gate?: { plan: "free" | "unknown"; words: string; fix?: string }
  triggers: TriggerView[]
  problems: string[]
}

/** How a trigger's command will run when it fires: on its own, or as a card for the person each time. */
export interface Runs {
  runs: "own" | "asks" | "notifies" | "wakes" | "unknown"
  words: string
  /** Said in amber on the card: this will wait for you. */
  amber?: string
  /** For one that asks: a wallet of its own. */
  suggestion?: string
}

export interface TriggerCheck {
  trigger: ResolvedTrigger
  /** The line as the card shows it: the body, again, cooldown and the name. */
  line: string
  runs: Runs
  /** Paper or live: what its card binds, and its trades go as. */
  mode: Mode
  /** A trigger of that name is already saved. */
  replaces?: true
}

export interface PayWalletInfo {
  /** The wallet's address, or "none" before it's read. */
  address: string
  /** "embedded", or its name. */
  name: string
  /** The chain it pays on, where it's known: the embedded wallet on another chain than Solana is said on it. */
  chain?: ChainSlug
  setting: WalletSetting
}

export interface TriggerBookDeps {
  file: TriggersFileStore
  statePath: string
  journal: Journal
  lines: LineReader
  /** The configured agents that have a key. */
  agents(): string[]
  plan(agent: string): HaccPlan | undefined
  mode(): Mode
  now(): number
  /** The wallet a trade pays from: the one it names, else the agent's default; undefined before it's read or when it can't pay. */
  payWallet(agent: string, wallet: string | undefined, mint: string | undefined): PayWalletInfo | undefined
  /** Candle's fee on a buy, in basis points, for the agent's plan. */
  feeBps(agent: string): number
  /** The rules bots saved, by name: a trigger on a bot names one of them. */
  botNames?(): string[]
  /** The code bots saved, by name: a trigger on a bot names one of them too, and only theirs say a word. */
  codeBotNames?(): string[]
  /** The P&L window showing now: what a P&L trigger whose line names none takes, for good, when it's proposed. */
  pnlWindow?(): string
  onChange(): void
}

/** A token and the chain it's on, always together: a cause names both, or neither (a P&L level, a rule's signal with no token). */
export type TokenOn = { mint: string; chain: ChainSlug } | { mint?: undefined; chain?: undefined }

/** What made a trigger fire, journalled with it before anything it does is proposed. */
export type FireCause =
  | { by: "call"; clientId: string }
  | ({ by: "level"; what: "price" | "mcap" | "entry" | "pnl"; reading: number; level: number; entryUsd?: number; readAt: string } & TokenOn)
  | { by: "tape"; mint: string; chain: ChainSlug; signalId: number; pattern: string; signalAt: string; marketCap?: { usd: number; from: "hacc" } }
  | ({ by: "mine"; assetId?: number; signalId: number; pattern: string; rule?: string; signalAt: string } & TokenOn)
  | { by: "schedule"; due: string; late?: true }
  | { by: "event"; event: "fill" | "card-expired" | "replay-ended"; agent?: string; opId?: string; cardId?: string; jobId?: number; mint?: string }
  | { by: "event"; event: "bot"; bot: string; what: BotEvent; word?: string; agent?: string; opId?: string; mint?: string; paper?: true }
/** The firing path: what a trigger does once its firing is recorded, under the `trigger.fired` row's `fireId`. */
export type Firer = (trigger: TriggerEntry, cause: FireCause, fireId: string) => Promise<unknown>

/** What a firing was recorded as, or why it wasn't: the firing path isn't wired, or the trigger stopped being live. */
export type Fired = { fired: true; fireId: string; run: Promise<unknown> } | { fired: false; code: string; words: string }

/** Each skip's why, short, for a day's tally. */
const TRIGGER_SKIP_SHORT: Readonly<Record<string, string>> = {
  not_on_candle: "not on Candle",
  no_market_cap: "no market cap",
}

/** A trigger's skips over the last day, by why in words, most first. */
export function triggerSkips(rows: readonly JournalRow[], name: string, now: number): { total: number; by: { why: string; count: number }[] } {
  const skips = new Map<string, number>()
  const since = now - 24 * 60 * 60_000
  for (const r of rows) {
    if (r.type !== "trigger.skipped" || r.name !== name || Date.parse(r.at) < since) continue
    const why = TRIGGER_SKIP_SHORT[String(r.reason)] ?? String(r.reason ?? "other")
    skips.set(why, (skips.get(why) ?? 0) + (typeof r.count === "number" ? r.count : 1))
  }
  const by = [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([why, count]) => ({ why, count }))
  return { total: by.reduce((n, x) => n + x.count, 0), by }
}

/**
 * What a firing's cooldown is kept by: on the tape and personal signals, the token that fired it (Hacc's asset id
 * where the token's address isn't known); for the rest, the trigger itself ("*").
 */
export function cooldownKey(cls: TriggerClass, cause: FireCause): string {
  if (cls !== "tape" && cls !== "mine") return "*"
  if ("mint" in cause && cause.mint !== undefined) return cause.mint
  return cause.by === "mine" && cause.assetId !== undefined ? `asset:${cause.assetId}` : "*"
}

/** A trigger's cooldown in force: its own, else the default where one spaces anything (not a schedule, nor a level that fires once). */
export function cooldownOf(t: Pick<TriggerEntry, "again" | "cooldownMs">, cls: TriggerClass): number | undefined {
  return t.cooldownMs ?? (cls === "schedule" || (cls === "level" && !t.again) ? undefined : DEFAULT_COOLDOWN_MS)
}

/** When a trigger may fire again for `key`, from its state: undefined when it may now. */
export function cooledUntil(s: TriggerState | undefined, key: string, cooldownMs: number | undefined): number | undefined {
  if (!s || cooldownMs === undefined) return undefined
  const last = key === "*" ? s.lastFired : s.cooldowns?.[key]
  if (!last) return undefined
  return Date.parse(last) + cooldownMs
}

/** What the watcher says of a trigger on the topic. */
export interface WatchInfo {
  watching?: string
  paceMs?: number
}

/**
 * What was approved, to tell a hand edit from it: paper or live among it, so a paper trigger can't be made live in
 * the file, and its line, which a woken turn and the panes show, so the words can't be changed under the approval.
 * One saved before the file kept a mode has none there, and hashes as it always did.
 */
export function approvedHash(t: Pick<TriggerEntry, "agent" | "line" | "expansion" | "again" | "cooldownMs" | "mode" | "chain">): string {
  return createHash("sha256")
    .update(canonicalJson({ agent: t.agent, line: t.line, expansion: t.expansion, again: t.again, cooldownMs: t.cooldownMs ?? null, ...(t.mode !== undefined ? { mode: t.mode } : {}), ...(t.chain !== undefined ? { chain: t.chain } : {}) }))
    .digest("base64url")
}

/**
 * The hash approvals were recorded with before the line was part of it. A trigger approved then still runs, so an
 * update switches none off; its next approval or narrowing records the full hash. A hash recorded since never
 * matches this one, so a line changed by hand after that is held.
 */
export function approvedHashBeforeLine(t: Pick<TriggerEntry, "agent" | "expansion" | "again" | "cooldownMs" | "mode">): string {
  return createHash("sha256")
    .update(canonicalJson({ agent: t.agent, expansion: t.expansion, again: t.again, cooldownMs: t.cooldownMs ?? null, ...(t.mode !== undefined ? { mode: t.mode } : {}) }))
    .digest("base64url")
}

/**
 * The chain a trigger on a token keeps, where it isn't Solana: taken from the token's address when its card is approved
 * (the request's edge), and stored, so a read never guesses it again. None for a trigger with no token, or on Solana.
 */
export function chainOfTrigger(when: TriggerWhen): { chain?: ChainSlug } {
  const token = "token" in when ? when.token : undefined
  const chain = token === undefined ? undefined : requestChain(token)
  return chain && chain !== "solana" ? { chain } : {}
}

/** How long a live trigger's line must have gone unread before it's journalled: the wallets' first read at start isn't news. */
export const UNREAD_SAID_MS = 60_000

/** The window a saved P&L trigger's expansion names, if it names one. */
function windowIn(expansion: string): string | undefined {
  const shape = parseTriggerShape(expansion)
  return shape.ok && shape.value.when.kind === "pnl" ? shape.value.when.window : undefined
}

/** Each trigger's mode as its approval was recorded, for those saved before the state kept one. */
function approvalModes(rows: readonly JournalRow[]): Map<string, Mode> {
  const out = new Map<string, Mode>()
  for (const row of rows) {
    if (typeof row.name !== "string") continue
    if (row.type === "trigger.removed") out.delete(row.name)
    // An agent's narrowing was recorded in the Candle Harness's mode at the time, which wasn't the trigger's.
    else if ((row.type === "trigger.saved" || row.type === "trigger.changed") && typeof row.hash === "string" && row.how !== "agent" && (row.mode === "paper" || row.mode === "live")) out.set(row.name, row.mode)
  }
  return out
}

// A wallet by its name, said as a wallet: a sentence may start with it, and "Tee-one trades…" read as a person.
export const theWallet = (name: string, chain?: ChainSlug) => (name === "embedded" ? (chain !== undefined && chain !== "solana" ? `the embedded wallet on ${chainName(chain)}` : "the embedded wallet") : `the wallet ${name}`)

/**
 * How a trigger's command runs when it fires: on its own (its wallet trades inside limits and the command
 * fits its figures) or as a card each time (the wallet asks, or a buy is over its figure). Valued here only
 * where the line gives dollars; the rest is valued when it fires.
 */
export function runsOf(t: ResolvedTrigger, wallet: (part: { wallet?: string; mint?: string }) => PayWalletInfo | undefined, feeBps: number): Runs {
  if (t.action.kind === "notify") return { runs: "notifies", words: "Notifies you: nothing trades." }
  if (t.action.kind === "wake") return { runs: "wakes", words: `Wakes ${t.action.agent}: its trades run as yours would, inside the wallet's figures with a receipt, over them as a card.` }
  const suggestion = "For it to run on its own, give it a wallet of its own: a new TEE wallet just for this trigger, set to trade inside limits. Your wallets aren't changed."
  const parts = partsOfAction(t.action.command)
  let later = false
  let sellsOnly = true
  let shown: PayWalletInfo | undefined
  for (const p of parts) {
    const w = wallet({ ...(typeof p.args.wallet === "string" ? { wallet: p.args.wallet } : {}), ...(typeof p.args.mint === "string" && p.args.mint !== IT_MINT ? { mint: p.args.mint } : {}) })
    if (!w) return { runs: "unknown", words: "The wallet that pays hasn't been read yet, so whether it runs on its own is said when it fires." }
    shown ??= w
    const name = theWallet(w.name, w.chain)
    if (w.setting.setting === "ask") {
      return {
        runs: "asks",
        words: `Asks you each time: ${name} asks every time, so each firing is a card for you to approve or reject within 60 s.`,
        amber: `${name} asks every time, so this will wait for you`,
        suggestion,
      }
    }
    if (p.args.side === "sell") continue
    sellsOnly = false
    if (p.args.side === "buy" && typeof p.args.amountUsd === "string") {
      const value = Number(p.args.amountUsd) * (1 + feeBps / 10_000)
      if (value > w.setting.perTradeUsd) {
        return {
          runs: "asks",
          words: `Asks you each time: this buy, ${usd(value)} with Candle's fee, is over ${name}'s ${usd(w.setting.perTradeUsd)} a trade without a card, so each firing is a card for you to approve or reject within 60 s.`,
          amber: `this buy is over ${name}'s ${usd(w.setting.perTradeUsd)} a trade, so it will wait for you`,
          suggestion,
        }
      }
    } else later = true
  }
  const w = shown!
  if (w.setting.setting !== "inside") return { runs: "unknown", words: "" }
  const name = theWallet(w.name, w.chain)
  if (sellsOnly) return { runs: "own", words: `Runs on its own: ${name} trades inside limits, and sells aren't limited. Each firing trades with a receipt.` }
  return {
    runs: "own",
    words: `Runs on its own: ${name} trades inside limits${later ? ", and each trade is valued when it fires" : ""}. Each firing trades with a receipt while it fits ${usd(w.setting.perTradeUsd)} a trade and ${name}'s ${usd(w.setting.perDayUsd)} a day without a card; over them, it's a card that waits for you.`,
  }
}

export class TriggerBook {
  private state: StateFile = { triggers: {} }
  private firer: Firer | undefined
  private watchInfo: ((name: string) => WatchInfo | undefined) | undefined
  private ownWallet: ((agent: string) => { label: string; line: string }[]) | undefined
  /** Each trigger's last card that expired with nobody there, by name, until it's run again. */
  private readonly expiredCards = new Map<string, { cardId: string; at: string }>()
  /**
   * Each trigger's expansion read whole, by its expansion, agent and mode: the watchers ask on every check. Only a
   * line that read is kept: one that didn't (its wallets not read from Candle yet) is read again each time, so it
   * comes back by itself.
   */
  private readonly resolvedCache = new Map<string, ResolvedTrigger>()
  /** Live triggers whose line doesn't read now: why, since when, and whether the journal has it. */
  private readonly unread = new Map<string, { words: string; since: number; said: boolean }>()

  constructor(private readonly deps: TriggerBookDeps) {
    try {
      const saved = JSON.parse(readFileSync(deps.statePath, "utf8")) as Partial<StateFile>
      if (saved && typeof saved.triggers === "object" && saved.triggers !== null) {
        for (const [name, s] of Object.entries(saved.triggers)) {
          const t = s as Partial<TriggerState>
          if (typeof t.approved === "string" && typeof t.on === "boolean" && typeof t.savedAt === "string") {
            this.state.triggers[name] = {
              approved: t.approved,
              on: t.on,
              armed: t.armed !== false,
              savedAt: t.savedAt,
              ...(typeof t.onSince === "string" ? { onSince: t.onSince } : {}),
              ...(typeof t.lastFired === "string" ? { lastFired: t.lastFired } : {}),
              ...(typeof t.nextRun === "string" ? { nextRun: t.nextRun } : {}),
              ...(t.cooldowns && typeof t.cooldowns === "object" ? { cooldowns: Object.fromEntries(Object.entries(t.cooldowns).filter(([, v]) => typeof v === "string")) as Record<string, string> } : {}),
              ...(t.mode === "paper" || t.mode === "live" ? { mode: t.mode } : {}),
            }
          }
        }
        if (saved.planHeld === true) this.state.planHeld = true
        // One saved before the state kept a mode takes the mode its approval was recorded in; with no record, live.
        const recorded = Object.values(this.state.triggers).some((t) => t.mode === undefined) ? approvalModes(deps.journal.rows()) : undefined
        if (recorded) for (const [name, t] of Object.entries(this.state.triggers)) if (t.mode === undefined && recorded.has(name)) t.mode = recorded.get(name)!
        return
      }
    } catch {}
    this.state = rebuild(deps.journal.rows())
  }

  /**
   * Paper or live, as the trigger was approved: the file's own, else (for one saved before the file kept it) the
   * mode its approval was recorded in, else live. Never the Candle Harness's mode now.
   */
  modeOf(t: Pick<TriggerEntry, "name" | "mode">): Mode {
    return t.mode ?? this.state.triggers[t.name]?.mode ?? "live"
  }

  /** Called by the firing path once it's wired: every firing, watched or called, is handed to it. */
  setFirer(firer: Firer): void {
    this.firer = firer
  }

  /** Whether a firing has somewhere to go. Until it has, the watchers read but fire nothing, and miss nothing. */
  canFire(): boolean {
    return this.firer !== undefined
  }

  /** What the watchers say of each trigger, merged into the topic. */
  /**
   * A journal row, as it's appended (and each kept one at start): a trigger's card expiring, or run again. The kept
   * rows are read `quiet`, before the core has what a trigger's line reads against; its first publish shows them.
   */
  noteRow(row: JournalRow, opts: { quiet?: boolean } = {}): void {
    if (row.type === "card.expired" && typeof row.trigger === "string" && typeof row.cardId === "string") {
      this.expiredCards.set(row.trigger, { cardId: row.cardId, at: row.at })
      if (!opts.quiet) this.deps.onChange()
    } else if (row.type === "trigger.run_now" && typeof row.cardId === "string") {
      for (const [name, e] of this.expiredCards) if (e.cardId === row.cardId) this.expiredCards.delete(name)
      if (!opts.quiet) this.deps.onChange()
    }
  }

  /** The steps toward a wallet of its own, for a trigger that asks each time (the Triggers overlay's chip). */
  setOwnWallet(steps: (agent: string) => { label: string; line: string }[]): void {
    this.ownWallet = steps
  }

  setWatchInfo(info: (name: string) => WatchInfo | undefined): void {
    this.watchInfo = info
  }

  /**
   * A trigger's expansion read whole, as it means at firing: mints, aliases expanded, `it` as the token that
   * fires it. It reads with no names and no aliases, so nothing learnt since changes it. Undefined when it no
   * longer reads (an agent or wallet it names is gone).
   */
  resolved(t: TriggerEntry): ResolvedTrigger | undefined {
    const r = this.readExpansion(t)
    return r.ok ? r.value : undefined
  }

  /** The window a saved P&L trigger was approved with, where its expansion names one. */
  windowOf(t: Pick<TriggerEntry, "expansion">): string | undefined {
    return windowIn(t.expansion)
  }

  /** Why a trigger's expansion doesn't read now, in the reader's words; undefined when it reads. */
  whyUnread(t: TriggerEntry): string | undefined {
    const r = this.readExpansion(t)
    return r.ok ? undefined : r.message
  }

  private readExpansion(t: TriggerEntry): Read<ResolvedTrigger> {
    const mode = this.modeOf(t)
    const key = `${t.agent}\n${mode}\n${t.expansion}`
    const kept = this.resolvedCache.get(key)
    if (kept) return { ok: true, value: kept }
    // Read in the trigger's own mode: a live one that pays from a TEE wallet still reads while the Candle Harness is on paper.
    const ctx = this.deps.lines.context(t.agent, mode)
    const r = resolveTrigger(t.expansion, { ...ctx, knownTokens: new Map(), severalTokens: new Map(), aliases: new Map(), agents: this.deps.agents(), proposer: t.agent })
    if (!r.ok) return r
    if (this.resolvedCache.size > 500) this.resolvedCache.clear()
    this.resolvedCache.set(key, r.value)
    return r
  }

  /**
   * A live trigger whose line hasn't read for a minute is journalled once, with why (the wallet it pays from can't
   * be read, or can't pay), and once more when it reads again: the records then say why a level passed unanswered.
   * Called on the watchers' heartbeat.
   */
  async noteUnread(): Promise<void> {
    const now = this.deps.now()
    const still = new Set<string>()
    for (const t of this.live()) {
      const why = this.whyUnread(t)
      if (why === undefined) continue
      still.add(t.name)
      const u = this.unread.get(t.name)
      if (!u || u.words !== why) {
        this.unread.set(t.name, { words: why, since: now, said: false })
        continue
      }
      if (u.said || now - u.since < UNREAD_SAID_MS) continue
      u.said = true
      await this.deps.journal.append({ type: "trigger.held", mode: this.modeOf(t), agent: t.agent, name: t.name, reason: "unreadable", words: `its line doesn't read now, so it isn't watching: ${why}` })
    }
    for (const [name, u] of this.unread) {
      if (still.has(name)) continue
      this.unread.delete(name)
      const t = this.entry(name)
      if (u.said && t && this.isOn(t)) await this.deps.journal.append({ type: "trigger.released", mode: this.modeOf(t), agent: t.agent, name, reason: "unreadable", words: "its line reads again, so it's watching" })
    }
  }

  /** Whether triggers are open for this agent's plan. */
  gate(agent?: string): Gate {
    const agents = agent ? [agent] : this.deps.agents()
    const plans = agents.map((a) => this.deps.plan(a))
    if (plans.some((p) => p === "pro" || p === "max")) return { state: "ok" }
    if (plans.some((p) => p === "free")) return { state: "free", words: `${PLAN_WORDS}. This account is on Free.` }
    return { state: "unknown", words: "The account's plan hasn't been read yet, so triggers wait for it." }
  }

  /** Each trigger as the file holds it. */
  entries(): TriggerEntry[] {
    return this.deps.file.read().triggers
  }

  entry(name: string): TriggerEntry | undefined {
    return this.entries().find((t) => t.name === name)
  }

  stateOf(name: string): TriggerState | undefined {
    return this.state.triggers[name]
  }

  /** What holds a trigger that's switched on, or undefined when nothing does. */
  heldBy(t: TriggerEntry): { code: string; words: string } | undefined {
    const s = this.state.triggers[t.name]
    if (!s) return { code: "NOT_APPROVED", words: "It was added to triggers.toml outside the Candle Harness, so it doesn't run: ask the agent to propose it, and approve its card." }
    if (s.approved !== approvedHash(t) && s.approved !== approvedHashBeforeLine(t)) return { code: "CHANGED_OUTSIDE", words: "It was changed in triggers.toml since it was approved, so it doesn't run: ask the agent to propose it again, and approve its card." }
    if (!this.deps.agents().includes(t.agent)) return { code: "AGENT_GONE", words: `${t.agent} isn't one of your agents now, so it doesn't run.` }
    const gate = this.gate(t.agent)
    if (gate.state === "free") return { code: "PLAN_FREE", words: `The plan is Free now. ${PLAN_WORDS}; it's kept as it is, and comes back on with one.` }
    if (gate.state === "unknown") return { code: "PLAN_UNKNOWN", words: gate.words }
    return undefined
  }

  /** Switched on, as the file and the core both say. */
  isOn(t: TriggerEntry): boolean {
    return t.on && this.state.triggers[t.name]?.on === true
  }

  /** The triggers that watch and fire now: switched on, and nothing holds them. */
  live(): TriggerEntry[] {
    return this.entries().filter((t) => this.isOn(t) && !this.heldBy(t))
  }

  view(): TriggersTopic {
    const file = this.deps.file.read()
    const gate = this.gate()
    return {
      ...(gate.state !== "ok" ? { gate: { plan: gate.state, words: gate.state === "free" ? PLAN_WORDS : gate.words, ...(gate.state === "free" ? { fix: PLAN_FIX } : {}) } } : {}),
      triggers: file.triggers.map((t) => this.viewOf(t)),
      problems: file.problems,
    }
  }

  private viewOf(t: TriggerEntry): TriggerView {
    const s = this.state.triggers[t.name]
    const on = this.isOn(t)
    const held = this.heldBy(t)
    const cls = (() => {
      const shape = parseTriggerShape(t.expansion)
      return shape.ok ? classOf(shape.value.when) : "event"
    })()
    const cooldownMs = cooldownOf(t, cls)
    // In words, read against today's names and aliases where the line still reads; else from its words as typed.
    // The whole line, so its own `again` and cooldown are in the words, not the defaults.
    const mode = this.modeOf(t)
    const now = this.read(fullLine({ body: t.line, again: t.again, ...(t.cooldownMs !== undefined ? { cooldownMs: t.cooldownMs } : {}), name: t.name, defaultName: t.name }), t.agent, mode, windowIn(t.expansion) ?? null)
    // On, approved and on a plan that runs it, but its line doesn't read as things stand: said, since it isn't watching.
    const unread = on && !held ? this.whyUnread(t) : undefined
    const holds = held ?? (unread !== undefined ? { code: "UNREADABLE", words: `It isn't watching now: ${unread}` } : undefined)
    const typed = parseTriggerShape(t.line)
    const words = now.ok ? now.value.words : typed.ok ? triggerWords({ ...typed.value, again: t.again }, cooldownMs) : t.line
    const readsNow = now.ok && now.value.expansion !== t.expansion ? "This line reads differently now (an alias or a token name changed since it was approved). It still does what it was approved to do." : undefined
    return {
      name: t.name,
      agent: t.agent,
      line: fullLine({ body: t.line, again: t.again, ...(t.cooldownMs !== undefined ? { cooldownMs: t.cooldownMs } : {}), name: t.name, defaultName: typed.ok ? defaultName(typed.value.conditionText) : t.name }),
      expansion: t.expansion,
      words,
      class: cls,
      on,
      live: on && !holds,
      mode,
      // A hand edit is said whether or not it's on; the rest only hold one that's on.
      ...(holds && (on || holds.code === "NOT_APPROVED" || holds.code === "CHANGED_OUTSIDE") ? { held: holds } : {}),
      again: t.again,
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
      armed: s?.armed ?? false,
      ...(s?.lastFired ? { lastFired: s.lastFired } : {}),
      ...(s?.nextRun ? { nextRun: s.nextRun } : {}),
      ...(readsNow ? { readsNow } : {}),
      ...(on && !holds ? this.withSkips(t.name, cls, this.watchInfo?.(t.name)) : undefined),
      ...this.runsAndPays(t),
      ...(this.expiredCards.get(t.name) ? { expired: this.expiredCards.get(t.name)! } : {}),
    }
  }

  /**
   * A line read in `mode` (a trigger's own, or the Candle Harness's for a new one). A P&L level that names no window
   * takes `pnlWindow`: the one showing now, or, for a saved trigger read again, the one it was approved with.
   */
  private read(line: string, proposer: string, mode: Mode = this.deps.mode(), pnlWindow: string | null | undefined = this.deps.pnlWindow?.()) {
    const ctx = this.deps.lines.context(proposer, mode)
    return resolveTrigger(line, { ...ctx, agents: this.deps.agents(), proposer, ...(pnlWindow ? { pnlWindow } : {}) })
  }

  /**
   * A trigger's line, checked whole for a card: the plan, the grammar, its tokens, the action's kind, the
   * agent and wallet, and how it will run. Throws a refusal in words.
   */
  check(line: string, proposer: string, as: { mode?: Mode; pnlWindow?: string } = {}): TriggerCheck {
    const mode = as.mode ?? this.deps.mode()
    if (!this.deps.agents().includes(proposer)) throw refused("UNKNOWN_AGENT", `${proposer} has no key here, so it can't hold a trigger.`)
    const gate = this.gate(proposer)
    if (gate.state === "free") throw refused("TRIGGERS_NEED_PLAN", `${PLAN_WORDS}. This account is on Free, so nothing was proposed.`)
    if (gate.state === "unknown") throw refused("PLAN_UNKNOWN", `${gate.words} Try again in a moment. Nothing was proposed.`)
    const r = this.read(line, proposer, mode, as.pnlWindow ?? this.deps.pnlWindow?.())
    if (!r.ok) throw refused("INVALID_TRIGGER", r.message)
    const t = r.value
    if (!this.deps.agents().includes(t.agent)) throw refused("UNKNOWN_AGENT", `${t.agent} has no key here, so it can't hold a trigger.`)
    if (t.when.kind === "event" && t.when.event === "bot" && this.deps.botNames) {
      const code = this.deps.codeBotNames?.() ?? []
      const all = [...this.deps.botNames(), ...code]
      if (!all.includes(t.when.bot)) {
        const names = all.map((n) => `"${n}"`)
        throw refused("UNKNOWN_BOT", `No bot is named "${t.when.bot}"${names.length ? `: the bots are ${names.join(", ")}` : ", and none is saved"}. A trigger on a bot names one that's saved.`)
      }
      // Only a code bot says a word: a rules bot's would never fire.
      if (t.when.what === "says" && !code.includes(t.when.bot)) throw refused("NOT_A_CODE_BOT", `"${t.when.bot}" is a rules bot, which never says a word: on bot "${t.when.bot}" entered, exited or paused waits on what it does.`)
    }
    const was = this.entry(t.name)
    let runs = this.inMode(runsOf(t, (p) => this.deps.payWallet(t.agent, p.wallet, p.mint), this.deps.feeBps(t.agent)), mode)
    // A change that would also take a saved trigger from paper to live, or back, says so: the press approves that too.
    if (was && t.action.kind === "command" && this.modeOf(was) !== mode) runs = { ...runs, words: `${runs.words} "${t.name}" is a ${this.modeOf(was)} trigger now: this makes it a ${mode} one.`.trim() }
    const shown = fullLine({ body: t.shape.body, again: t.again, ...(t.shape.cooldownMs !== undefined ? { cooldownMs: t.shape.cooldownMs } : {}), name: t.name, defaultName: defaultName(t.shape.conditionText) })
    return { trigger: t, line: shown, runs, mode, ...(was ? { replaces: true as const } : {}) }
  }

  /**
   * Saves a trigger whose card the person approved, checked again now. `expansion` is what the card showed:
   * a line that reads differently now (an alias or a name changed since) is refused, naming it. A name
   * already saved is replaced only when the card said so.
   */
  async save(line: string, proposer: string, by: { expansion: string; replace?: boolean; cardId?: string; opId?: string; mode?: Mode }): Promise<{ name: string; replaced: boolean }> {
    // Paper or live is the card's: what the person pressed on. A P&L level keeps the window its card showed.
    const mode = by.mode ?? this.deps.mode()
    const window = windowIn(by.expansion)
    const c = this.check(line, proposer, { mode, ...(window ? { pnlWindow: window } : {}) })
    const t = c.trigger
    if (t.expansion !== by.expansion) {
      throw refused("LINE_CHANGED", `"${t.shape.body}" reads differently now than when its card was made (an alias or a token name changed): it would ${t.expansion} rather than ${by.expansion}. Nothing was saved; ask for it again.`)
    }
    const was = this.entry(t.name)
    if (was && !by.replace) throw refused("NAME_TAKEN", `A trigger named "${t.name}" is already saved. Give this one another name with as "<name>", or replace that one.`)
    const entry: TriggerEntry = { name: t.name, agent: t.agent, line: t.shape.body, expansion: t.expansion, on: true, again: t.again, ...(t.shape.cooldownMs !== undefined ? { cooldownMs: t.shape.cooldownMs } : {}), mode, ...chainOfTrigger(t.when) }
    const w = this.deps.file.write({ [t.name]: entry })
    if (!w.ok) throw refused("TRIGGERS_FILE", `${w.message} Nothing was saved.`)
    const at = new Date(this.deps.now()).toISOString()
    this.state.triggers[t.name] = { approved: approvedHash(entry), on: true, armed: true, savedAt: at, onSince: at, mode }
    this.persist()
    await this.deps.journal.append({
      type: was ? "trigger.changed" : "trigger.saved",
      mode,
      agent: t.agent,
      name: t.name,
      line: c.line,
      expansion: t.expansion,
      words: t.words,
      runs: c.runs.runs,
      hash: approvedHash(entry),
      on: true,
      by: "card",
      ...(by.cardId ? { cardId: by.cardId } : {}),
      ...(by.opId ? { opId: by.opId } : {}),
      ...(was ? { replaced: true } : {}),
    })
    this.deps.onChange()
    return { name: t.name, replaced: Boolean(was) }
  }

  /**
   * Changes a saved trigger to a narrower line at once (harness_triggers checked it only narrows: a smaller amount, a
   * level harder to reach, a longer cooldown): its file entry, the hash it's approved as, journalled with what
   * narrowed. On or off, armed, its last firing and cooldowns are kept as they were.
   */
  async narrow(name: string, c: TriggerCheck, by: { clientId: string; agent: string; what: string[] }): Promise<void> {
    const was = this.entry(name)
    const s = this.state.triggers[name]
    if (!was || !s) throw refused("UNKNOWN_TRIGGER", `No trigger named "${name}".${this.namesWords()}`)
    const t = c.trigger
    // A narrowing never changes paper or live: it stays as it was approved.
    const mode = this.modeOf(was)
    const entry: TriggerEntry = { name, agent: t.agent, line: t.shape.body, expansion: t.expansion, on: was.on, again: t.again, ...(t.shape.cooldownMs !== undefined ? { cooldownMs: t.shape.cooldownMs } : {}), mode, ...chainOfTrigger(t.when) }
    const w = this.deps.file.write({ [name]: entry })
    if (!w.ok) throw refused("TRIGGERS_FILE", `${w.message} "${name}" is unchanged.`)
    s.approved = approvedHash(entry)
    s.mode = mode
    this.persist()
    await this.deps.journal.append({
      type: "trigger.changed",
      mode,
      agent: t.agent,
      name,
      line: c.line,
      expansion: t.expansion,
      words: t.words,
      runs: c.runs.runs,
      hash: s.approved,
      on: s.on,
      by: by.clientId,
      how: "agent",
      changedBy: by.agent,
      narrowed: by.what,
    })
    this.deps.onChange()
  }

  private runsAndPays(t: TriggerEntry): Pick<TriggerView, "runs" | "paysFrom" | "fills"> {
    const r = this.resolved(t)
    if (!r) return {}
    const runs = this.inMode(runsOf(r, (p) => this.deps.payWallet(t.agent, p.wallet, p.mint), this.deps.feeBps(t.agent)), this.modeOf(t))
    const pays = this.payWalletOf(r)
    const fills = runs.runs === "asks" ? (this.ownWallet?.(t.agent) ?? []) : []
    return { ...(runs.words ? { runs } : {}), ...(pays ? { paysFrom: pays } : {}), ...(fills.length ? { fills } : {}) }
  }

  /**
   * How a trade runs in the trigger's own mode. A paper trigger's firing is a paper trade with no card, whatever its
   * wallet does live and whatever mode the Candle Harness is in then. A live one runs by its wallet, and says it's
   * live where the Candle Harness is on paper, since its trades are real all the same.
   */
  private inMode(runs: Runs, mode: Mode): Runs {
    if (runs.runs !== "own" && runs.runs !== "asks") return runs
    if (mode === "paper") return { runs: "own", words: "Runs on its own in paper: each firing is a paper trade at the quoted price, with no card, whatever mode the Candle Harness is in then. It stays a paper trigger: to trade live, ask for it again in live mode." }
    if (this.deps.mode() === "paper") return { ...runs, words: `${runs.words} It's a live trigger: its trades are real, though the Candle Harness is on paper now.` }
    return runs
  }

  /** How a saved trigger's command runs now, by its wallet's setting today; undefined when it no longer reads. */
  runsNow(t: TriggerEntry): Runs | undefined {
    const r = this.resolved(t)
    return r ? this.inMode(runsOf(r, (p) => this.deps.payWallet(t.agent, p.wallet, p.mint), this.deps.feeBps(t.agent)), this.modeOf(t)) : undefined
  }

  /** The wallet a trigger's first trade pays from, by name ("embedded", or its own), once it's read. */
  payWalletOf(t: Pick<ResolvedTrigger, "agent" | "action">): string | undefined {
    if (t.action.kind !== "command") return undefined
    const first = partsOfAction(t.action.command)[0]
    const mint = typeof first?.args.mint === "string" && first.args.mint !== IT_MINT ? first.args.mint : undefined
    return this.deps.payWallet(t.agent, typeof first?.args.wallet === "string" ? first.args.wallet : undefined, mint)?.name
  }

  /**
   * Switches a trigger off (from any view, or by an agent), or back on as it was approved (from the main view).
   * `how` says who: a view, or an agent through harness_triggers.
   */
  async set(name: string, on: boolean, from: { clientId: string; main: boolean; how?: "view" | "agent"; agent?: string; woken?: string }): Promise<{ name: string; on: boolean; said: string }> {
    const how = from.how ?? "view"
    if (on && how === "agent") throw refused("PERSON_ONLY", "Only the person switches a trigger back on, as it was approved, in the main window.")
    const t = this.entry(name)
    const s = this.state.triggers[name]
    if (!t && !(s && !on)) throw refused("UNKNOWN_TRIGGER", `No trigger named "${name}".${this.namesWords()}`)
    if (!on) {
      // Off always takes, in the core, even when the file can't be read or written.
      if (s) s.on = false
      this.persist()
      const w = t?.on ? this.deps.file.write({ [name]: { ...t, on: false } }) : t ? ({ ok: true } as const) : this.deps.file.write({})
      await this.deps.journal.append({ type: "trigger.changed", mode: t ? this.modeOf(t) : (s?.mode ?? this.deps.mode()), ...(t ? { agent: t.agent } : {}), name, on: false, by: from.clientId, how, ...(from.agent ? { changedBy: from.agent } : {}), ...(from.woken ? { woken: from.woken } : {}), ...this.guards(t) })
      this.deps.onChange()
      return { name, on: false, said: w.ok ? `"${name}" is off.` : `"${name}" is off, and won't fire. triggers.toml still says on, since it has a problem: ${w.message}` }
    }
    if (!t) throw refused("UNKNOWN_TRIGGER", `No trigger named "${name}".${this.namesWords()}`)
    if (!from.main) throw refused("MAIN_VIEW_ONLY", "A trigger is switched back on from the main window, not a popped pane.")
    const held = this.heldBy(t)
    if (held) throw refused(held.code, `"${name}" can't be switched on: ${held.words}`)
    const w = this.deps.file.write({ [name]: { ...t, on: true } })
    if (!w.ok) throw refused("TRIGGERS_FILE", `${w.message} "${name}" stays off.`)
    s!.on = true
    s!.armed = true
    s!.onSince = new Date(this.deps.now()).toISOString()
    delete s!.nextRun
    this.persist()
    await this.deps.journal.append({ type: "trigger.changed", mode: this.modeOf(t), agent: t.agent, name, on: true, by: from.clientId, how: "view" })
    this.deps.onChange()
    return { name, on: true, said: `"${name}" is on again, as it was approved.` }
  }

  /** Removes a trigger, from any view. With the file unwritable, it's still off and won't fire. */
  async remove(name: string, from: { clientId: string }): Promise<{ name: string; said: string }> {
    const t = this.entry(name)
    if (!t && !this.state.triggers[name]) throw refused("UNKNOWN_TRIGGER", `No trigger named "${name}".${this.namesWords()}`)
    delete this.state.triggers[name]
    this.persist()
    const w = t ? this.deps.file.write({ [name]: undefined }) : ({ ok: true } as const)
    await this.deps.journal.append({ type: "trigger.removed", mode: t ? this.modeOf(t) : this.deps.mode(), ...(t ? { agent: t.agent } : {}), name, by: from.clientId })
    this.deps.onChange()
    return { name, said: w.ok ? `"${name}" is removed.` : `"${name}" won't fire again. It stays in triggers.toml until its problem is fixed: ${w.message}` }
  }

  /**
   * Fires an `on call` trigger from outside: switched on, not held, past its cooldown. Answers once the firing
   * is recorded, with `run`, what it does, still going (a card can wait a minute for the person).
   */
  async fire(name: string, from: { clientId: string }): Promise<{ name: string; fireId: string; run: Promise<unknown> }> {
    const gate = this.gate()
    if (gate.state === "free") throw refused("TRIGGERS_NEED_PLAN", `${PLAN_WORDS}. This account is on Free, so nothing fired.`)
    const t = this.entry(name)
    if (!t) throw refused("UNKNOWN_TRIGGER", `No trigger named "${name}".${this.namesWords()}`)
    const shape = parseTriggerShape(t.expansion)
    if (!shape.ok || shape.value.when.kind !== "event" || shape.value.when.event !== "call") throw refused("NOT_ON_CALL", `"${name}" fires on its own condition. Only a trigger written on call is fired from outside.`)
    if (!this.isOn(t)) throw refused("TRIGGER_OFF", `"${name}" is off. Switch it on in the Triggers overlay first.`)
    const held = this.heldBy(t)
    if (held) throw refused(held.code, `"${name}" didn't fire: ${held.words}`)
    const last = this.state.triggers[name]?.lastFired
    const cooldownMs = t.cooldownMs ?? DEFAULT_COOLDOWN_MS
    if (last && this.deps.now() - Date.parse(last) < cooldownMs) {
      const next = new Date(Date.parse(last) + cooldownMs)
      // "Called", not "fired": a call skipped at its agent's wake cap still counts toward the cooldown.
      throw refused("COOLDOWN", `"${name}" was last called ${hhmm(new Date(last))}, and its cooldown is ${durationWords(cooldownMs)}: it can fire again ${hhmm(next)}.`)
    }
    const f = await this.fired(t, { by: "call", clientId: from.clientId }, "someone called it from outside")
    if (!f.fired) throw refused(f.code, f.words)
    return { name, fireId: f.fireId, run: f.run }
  }

  /**
   * A firing: recorded before anything it does is proposed, so a core that stops mid-firing never fires it
   * again. Its state first (when, for which token, a level disarmed, and switched off when it fires once),
   * then `trigger.fired` in the journal with what fired it, then the firing path. Refused, recording
   * nothing, while the firing path isn't wired or the trigger isn't live.
   */
  async fired(t: TriggerEntry, cause: FireCause, words: string): Promise<Fired> {
    if (!this.firer) return { fired: false, code: "NOT_READY", words: "This core doesn't fire triggers yet, so nothing fired." }
    if (!this.isOn(t)) return { fired: false, code: "TRIGGER_OFF", words: `"${t.name}" is off.` }
    const held = this.heldBy(t)
    if (held) return { fired: false, code: held.code, words: `"${t.name}" didn't fire: ${held.words}` }
    const s = this.state.triggers[t.name]!
    const r = this.resolved(t)
    const cls = r?.class ?? "event"
    const at = new Date(this.deps.now()).toISOString()
    s.lastFired = at
    const key = cooldownKey(cls, cause)
    if (key !== "*") s.cooldowns = prune({ ...(s.cooldowns ?? {}), [key]: at }, this.deps.now(), cooldownOf(t, cls) ?? DEFAULT_COOLDOWN_MS)
    if (cls === "level") s.armed = false
    const once = (cls === "level" && !t.again) || (r !== undefined && isOnce(r.when))
    if (once) s.on = false
    this.persist()
    // A level that fires once switches off in the file too; the core's state already holds it off if the file can't be written.
    const w = once ? this.deps.file.write({ [t.name]: { ...t, on: false } }) : ({ ok: true } as const)
    const fireId = `fire_${randomBytes(9).toString("base64url")}`
    await this.deps.journal.append({
      type: "trigger.fired",
      mode: this.modeOf(t),
      agent: t.agent,
      name: t.name,
      fireId,
      class: cls,
      cause,
      words,
      ...(key !== "*" ? { token: key } : {}),
      ...(once ? { switchedOff: true } : {}),
      ...(once && !w.ok ? { fileProblem: w.message } : {}),
    })
    this.deps.onChange()
    const run = this.firer(t, cause, fireId)
    run.catch(() => {})
    return { fired: true, fireId, run }
  }

  /**
   * Tape signals a trigger watched for and didn't act on, gathered by the watcher (a market cap no source it may use
   * knows): journalled one row per reason a minute at most, so a trigger that never fires says why.
   */
  async skipped(t: TriggerEntry, g: { reason: string; count: number; signals: number[]; mints: string[]; words: string }): Promise<void> {
    await this.deps.journal.append({ type: "trigger.skipped", mode: this.modeOf(t), agent: t.agent, name: t.name, reason: g.reason, count: g.count, signals: g.signals, mints: g.mints, words: g.words })
    this.deps.onChange()
  }

  /** A tape trigger's watch words, with its skips over the last day after them, tallied by why. */
  private withSkips(name: string, cls: TriggerClass, info: WatchInfo | undefined): WatchInfo | undefined {
    if (cls !== "tape") return info
    const tally = triggerSkips(this.deps.journal.rows(), name, this.deps.now())
    if (!tally.total) return info
    const skipped = `skipped ${tally.total} in the last day: ${tally.by.map((s) => `${s.count} ${s.why}`).join(", ")}`
    return { ...info, watching: info?.watching ? `${info.watching} · ${skipped}` : skipped }
  }

  /** A run the watcher couldn't make (a schedule the machine slept through), or tape rows too old to act on: said, never fired. */
  async missed(t: TriggerEntry, words: string, fields: Record<string, unknown> = {}, opts: { switchOff?: boolean } = {}): Promise<void> {
    // A run once that's missed has nothing left to run: off, in the state and the file, as a firing would leave it.
    const s = this.state.triggers[t.name]
    if (opts.switchOff && s) {
      s.on = false
      this.persist()
      this.deps.file.write({ [t.name]: { ...t, on: false } })
    }
    await this.deps.journal.append({ type: "trigger.missed", mode: this.modeOf(t), agent: t.agent, name: t.name, words, ...fields, ...(opts.switchOff ? { switchedOff: true } : {}) })
    this.deps.onChange()
  }

  /** When a schedule runs next, kept so a restart knows what it slept through. */
  setNextRun(name: string, at: number | undefined): void {
    const s = this.state.triggers[name]
    if (!s) return
    const next = at === undefined ? undefined : new Date(at).toISOString()
    if (s.nextRun === next) return
    if (next === undefined) delete s.nextRun
    else s.nextRun = next
    this.persist()
    this.deps.onChange()
  }

  /** Records a firing: when, and for which token, so the cooldown and a level's arming hold across a restart. */
  markFired(name: string, at: number, token?: string): void {
    const s = this.state.triggers[name]
    if (!s) return
    s.lastFired = new Date(at).toISOString()
    if (token) s.cooldowns = { ...(s.cooldowns ?? {}), [token]: s.lastFired }
    this.persist()
    this.deps.onChange()
  }

  /** A level's arming: false once it fired, true when it's crossed back (again) or switched on again. */
  setArmed(name: string, armed: boolean): void {
    const s = this.state.triggers[name]
    if (!s || s.armed === armed) return
    s.armed = armed
    this.persist()
    this.deps.onChange()
  }

  /** The plan changed: on Free every trigger is held as it is; with Pro or Max back, they run as they were. Journalled once each way. */
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
      .filter((t) => this.isOn(t))
      .map((t) => t.name)
    if (names.length) {
      await this.deps.journal.append({ type: held ? "trigger.held" : "trigger.released", mode: this.deps.mode(), names, reason: "plan", words: held ? `the plan is Free now: ${PLAN_WORDS}` : "the plan is Pro or Max again" })
    }
    this.deps.onChange()
  }

  /** How many triggers are live. */
  liveCount(): number {
    return this.live().length
  }

  /**
   * The triggers that keep the core running: each live one, and each switched on whose plan isn't read yet, since
   * a core that exits before its first status read would end a trigger that was about to run. One held for good
   * (Free, changed by hand, its agent gone) doesn't.
   */
  keepingUp(): TriggerEntry[] {
    return this.entries().filter((t) => {
      if (!this.isOn(t)) return false
      const held = this.heldBy(t)
      return !held || held.code === "PLAN_UNKNOWN"
    })
  }

  /**
   * What a trigger that's switched off was guarding, for the records: a sell (a stop or a take profit), by its token.
   * An agent switching one off removes protection, and the away note and the notice say so.
   */
  private guards(t: TriggerEntry | undefined): { sells?: string[] } {
    const r = t ? this.resolved(t) : undefined
    if (!r || r.action.kind !== "command") return {}
    const sells = partsOfAction(r.action.command).filter((p) => p.args.side === "sell" && typeof p.args.mint === "string").map((p) => p.args.mint as string)
    return sells.length ? { sells: [...new Set(sells)] } : {}
  }

  private namesWords(): string {
    const names = this.entries().map((t) => `"${t.name}"`)
    return names.length ? ` Triggers: ${names.join(", ")}.` : " There are none."
  }

  private persist(): void {
    const temp = `${this.deps.statePath}.tmp-${randomBytes(6).toString("base64url")}`
    writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, this.deps.statePath)
  }
}

/** Each token's last firing, less those whose cooldown is long over: the state stays small however busy the tape is. */
function prune(cooldowns: Record<string, string>, now: number, cooldownMs: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, at] of Object.entries(cooldowns)) if (now - Date.parse(at) < cooldownMs * 2) out[k] = at
  return out
}

const hhmm = (d: Date) => `at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`

/** The state, from the journal's trigger rows: what was approved and switched on, and when each last fired. */
export function rebuild(rows: readonly JournalRow[]): StateFile {
  const out: StateFile = { triggers: {} }
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name : undefined
    if (!name) continue
    // An agent's narrowing changes only what it's approved as: on, armed and its firings stay.
    if (row.type === "trigger.changed" && row.how === "agent" && typeof row.hash === "string" && out.triggers[name]) {
      out.triggers[name]!.approved = row.hash
    } else if ((row.type === "trigger.saved" || row.type === "trigger.changed") && typeof row.hash === "string") {
      out.triggers[name] = { approved: row.hash, on: row.on !== false, armed: true, savedAt: row.at, onSince: row.at, ...(row.mode === "paper" || row.mode === "live" ? { mode: row.mode } : {}) }
    } else if (row.type === "trigger.changed" && typeof row.on === "boolean" && out.triggers[name]) {
      out.triggers[name]!.on = row.on
      if (row.on) {
        out.triggers[name]!.armed = true
        out.triggers[name]!.onSince = row.at
      }
    } else if (row.type === "trigger.removed") {
      delete out.triggers[name]
    } else if (row.type === "trigger.fired" && out.triggers[name]) {
      const t = out.triggers[name]!
      t.lastFired = row.at
      if (typeof row.token === "string") t.cooldowns = { ...(t.cooldowns ?? {}), [row.token]: row.at }
      if (row.class === "level") t.armed = false
      if (row.switchedOff === true) t.on = false
    } else if (row.type === "trigger.missed" && row.switchedOff === true && out.triggers[name]) {
      out.triggers[name]!.on = false
    } else if (row.type === "trigger.held" && row.reason === "plan") {
      out.planHeld = true
    } else if (row.type === "trigger.released" && row.reason === "plan") {
      out.planHeld = false
    }
  }
  return out
}
