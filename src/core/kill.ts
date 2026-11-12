// The kill switch. `kill` pauses buys, ends every agent's turn and withdraws every open card that
// spends or publishes: buys and swaps, launches, stakes, profile edits and new posts (classify.ts,
// pausedStops). Sell cards stay open and approvable, and so do unstakes, claims and post deletes: a kill
// is there to stop spending, and the way out stays one press away. Each open sell is re-proposed at a
// fresh price, the old card withdrawn, so it has its full 60 s while the report is read (a kept card could
// expire before it was pressed). Reads, paper trades and less-access still work while paused, and
// operations already sent carry on to reconciliation, but for a lost swap or stake, whose read-back is a
// replay: that waits for a resume, since a replay of one that never reached Candle would be its first send,
// and its in-flight line says so.
//
// It reaches only what runs through this core. The kill report says so, and offers the two
// less-access steps that stop bots and other apps using the same keys.
//
// Paused survives a restart. It's kept in `state/kill.json` (0600) as well as the journal, since the
// journal keeps only a window of rows in memory. Either one saying paused means paused: a crash
// between the two writes errs towards staying paused.
import { randomBytes } from "node:crypto"
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import type { Card } from "./cards"
import { pausedStops } from "./classify"
import type { Operation } from "./execute"
import type { Journal, JournalRow } from "./journal"
import type { ChainSlug } from "../shared/chains"
import type { DaySpend } from "./limits"
import { type WalletStanding, walletStanding } from "./standing"
import { notFollowedFurther } from "./trade-log"
import { walletName } from "./wallet-names"
import type { OperationState } from "./tool-face"

export const KILL_WORDING =
  "Stops the agent and everything that trades through the Candle Harness, and holds its bots' buys (their sells and exits still go). Other apps, and bots outside the Candle Harness, using your keys aren't stopped. To stop those too, take the key off the wallet (you can allow it again) or revoke it (permanent)."

/** What the report says while the pause couldn't be saved anywhere: rare, and the person's to act on. */
export const UNSAVED_WORDS = "The pause couldn't be saved (the disk or the state folder can't be written), so it won't survive a restart of the Candle Harness. Press the kill switch again once it can."

const IN_FLIGHT: ReadonlySet<OperationState> = new Set(["submitting", "pending", "unknown"])
/** The kinds whose open cards the report lists as kept: what moves value or takes something down. */
/** A trade card that sells: the kill switch keeps it, at a fresh price. */
const isSell = (card: Card) => card.kind === "trade" && card.side === "sell"
const KEPT: ReadonlySet<string> = new Set(["trade", "swap", "launch", "stake", "claim", "public", "lp", "close", "perps"])
/** Candle's own stops (docs.candle.tv/developers/agent-trading, "Errors"): the report names them when it has seen one. */
const CANDLE_STOPS = new Set(["PROFILE_PAUSED", "RISK_LIMIT_REACHED"])

export interface KillReport {
  at: string
  by: string
  stopped: { turns: { agent: string; turnId: string }[]; cards: { cardId: string; title: string; agent: string }[] }
  /** Open cards the kill keeps: sells, unstakes, claims and post deletes. */
  stillOpen: { cardId: string; cardHash: string; title: string; agent: string; kind?: string; side?: string }[]
  /** `held`: its read-back is a replay, which waits for a resume. */
  inFlight: { opId: string; cardId: string; agent: string; title: string; state: OperationState; held?: boolean }[]
  standing: {
    /** The last portfolio read, with its age; every figure is "—" (null) when there's none. */
    portfolioAgeMs: number | null
    wallets: WalletStanding[]
    /** The P&L window's figure, the status bar's: null (shown "—") before any sample in the window. */
    pnl: KillPnl | null
    spentToday: { agent: string; usd: number; perDayUsd: number | null }[]
  }
  notStopped: {
    wording: string
    /** Per agent, the less-access steps that also stop what this core can't reach. */
    steps: { agent: string; takeOffWallet: string; revoke: string; disableTee?: { wallet: string; command: string }[] }[]
    /** Agents Candle itself has stopped, from the refusals the core has seen. */
    candleStopped: { agent: string; code: string }[]
  }
  /**
   * Each wallet that trades inside limits: the kill switch doesn't change the setting; the
   * pause holds its buys and swaps as it holds cards, and its sells still go.
   */
  insideLimits?: { wallet: string; name: string; words: string }[]
  /**
   * Each live trigger the pause holds: one that buys, swaps or wakes. Its sells still go, and resuming
   * leaves each trigger as it was.
   */
  triggersHeld?: { name: string; agent: string; words: string }[]
  /**
   * Each bot the pause holds, rules or code: its buys, while its sells and exits still go, guarding the positions it
   * holds open.
   * Resuming leaves each bot as it was.
   */
  botsHeld?: BotHeldByKill[]
  /** The pause couldn't be written to the state file or the journal: it holds now, and wouldn't after a restart. */
  unsaved?: string
  resume: string
}

export interface BotHeldByKill {
  name: string
  /** A code bot: the person's own code, its buys and swaps held. Absent: a rules bot, its entries held. */
  kind?: "code"
  agent: string
  mode: "paper" | "live"
  /** Its open positions' tokens, by name: what its exits still guard. */
  open: string[]
  words: string
}

/** The P&L window's figure as the report shows it: Candle's, from the Candle Harness's samples, naming its window. */
export interface KillPnl {
  usd: number | null
  /** The window's name: "24h", "since midnight", "since 18:00", "since last session". */
  label: string
  /** Where the figure runs from. */
  from: number | null
  /** The Candle Harness's samples start later than the window: the report says "since 09:14" instead. */
  short: boolean
  /** Positions Candle can't price now, where that changed over the window: the figure is partly that. */
  unpriced?: number
}

export interface KillDeps {
  journal: Journal
  mode: () => "paper" | "live"
  statePath: string
  now: () => number
  agents: () => string[]
  cards: {
    list(): Card[]
    withdrawWhere(match: (card: Card) => boolean, reason: string): Promise<Card[]>
    refreshWhere(match: (card: Card) => boolean, reason: string): Promise<{ old: Card; fresh: Card }[]>
    /** Cards mid-approval, which withdrawWhere skips: each is refused before it runs if the pause stops it. */
    approvingNow?(): Card[]
  }
  /** `refuseWaiting`: the trades waiting for their Hood TEE wallet's last one, refused with nothing sent where the pause stops them. */
  operations: { list(): Operation[]; refuseWaiting?(): Promise<Operation[]> }
  engine: { cancelAll(): Promise<{ agent: string; turnId: string }[]> }
  spend: DaySpend
  limitsFor: (agent: string) => { perDayUsd: number } | undefined
  /** The embedded wallets each agent may pay from (Solana's, and the EVM one), from their last status reads. */
  walletsOf: (agent: string) => readonly (string | undefined)[]
  portfolio: () => { result: unknown; readAt: number } | undefined
  /** The chains the account uses, the core's one answer; unset, what the read alone says. */
  chains?: () => readonly ChainSlug[]
  prices: { usd(key: string | undefined): number | undefined }
  keyPrefix: (agent: string) => string | undefined
  /** The P&L window's figure now; unset, the report shows "—". */
  pnl?: () => KillPnl | null
  /**
   * The TEE wallets bound to each agent's key: `candle tee disable <address>` stops one
   * on Candle's server, bots included. Turning it back on is an owner step, so it's offered, never run.
   */
  teeWallets?: (agent: string) => { address: string; label?: string }[]
  /** What a wallet is called, from the core's one book. */
  nameOf?: (address: string, kind: "embedded" | "tee", label?: string) => string
  /** The wallets that trade inside limits now. */
  insideLimits?: () => { wallet: string; name: string }[]
  /** The live triggers the pause holds, by name, in words. */
  triggersHeld?: () => { name: string; agent: string; words: string }[]
  /** The bots that enter now, whose entries the pause holds, with their open positions. */
  botsHeld?: () => BotHeldByKill[]
  /** Just before the pause ends: what was held during it is said while it's still on (the bots' skips). */
  beforeResume?: () => Promise<void>
  /** Publishes the report, and each update to it, on `activity`. */
  publish: (report: KillReport) => void
  onChange: () => void
}

/** Whether the journal's last kill row is `kill.on`. */
export function pausedInJournal(rows: readonly JournalRow[]): boolean {
  let paused = false
  for (const row of rows) {
    if (row.type === "kill.on") paused = true
    else if (row.type === "kill.off") paused = false
  }
  return paused
}

export class KillSwitch {
  private on = false
  private report: KillReport | undefined
  /** Whether this pause is in the state file, and in the journal: a restart needs one of them. */
  private savedInFile = false
  private savedInJournal = false

  private constructor(private readonly deps: KillDeps) {}

  /** Opens the switch in the state the last core left it: paused if the state file or the journal says so. */
  static async open(deps: KillDeps): Promise<KillSwitch> {
    const k = new KillSwitch(deps)
    let fromFile = false
    try {
      fromFile = (JSON.parse(await readFile(deps.statePath, "utf8")) as { paused?: unknown }).paused === true
    } catch {}
    const fromJournal = pausedInJournal(deps.journal.rows())
    k.on = fromFile || fromJournal
    k.savedInFile = fromFile
    k.savedInJournal = fromJournal
    if (k.on) {
      const last = [...deps.journal.rows()].reverse().find((r) => r.type === "kill.report")
      if (last && typeof last.report === "object") k.report = last.report as KillReport
    }
    return k
  }

  paused(): boolean {
    return this.on
  }

  current(): KillReport | undefined {
    return this.report
  }

  /**
   * Pauses buys, ends turns, withdraws buy and swap cards. A second kill while paused does it again, and
   * journals the report as it now stands, not only its card rows, so a restart shows the newest report.
   */
  async kill(by: string): Promise<{ paused: true; report: KillReport; already: boolean }> {
    const already = this.on
    // Buys are refused from here, and every turn ends, before anything is written: neither needs the disk. The
    // pause is then written down, and a write that fails is caught, so it never leaves a buy card open: the
    // cards are withdrawn either way, and whichever write didn't take is tried again, now and by each later kill,
    // until the pause is somewhere a restart will find it.
    this.on = true
    if (!already) this.deps.onChange()
    const turns = await this.deps.engine.cancelAll().catch(() => [])
    await this.save(by)
    const withdrawn = await this.deps.cards.withdrawWhere(pausedStops, "kill_switch").catch(() => [])
    // A buy approved and waiting for its wallet's last trade hasn't been sent: it goes as a card does.
    await this.deps.operations.refuseWaiting?.().catch(() => [])
    // Each kept sell starts again at a fresh price, so reading the report doesn't run out its 60 s.
    await this.deps.cards.refreshWhere(isSell, "kill_switch_fresh").catch(() => [])
    await this.save(by)
    if (already && this.report) {
      this.report.stopped.turns.push(...turns)
      this.report.stopped.cards.push(...withdrawn.map(cardLine))
      this.report.stillOpen = this.stillOpen()
      const held = this.deps.triggersHeld?.() ?? []
      if (held.length) this.report.triggersHeld = held
      else delete this.report.triggersHeld
      const bots = this.deps.botsHeld?.() ?? []
      if (bots.length) this.report.botsHeld = bots
      else delete this.report.botsHeld
      for (const line of this.approvingLines()) if (!this.report.inFlight.some((l) => l.opId === line.opId)) this.report.inFlight.push(line)
      this.noteSaved(this.report)
      await this.deps.journal.append({ type: "kill.report", mode: this.deps.mode(), by, again: true, report: this.report }).catch(() => {})
      this.refresh()
      return { paused: true, report: this.report, already }
    }
    this.report = this.build(by, turns, withdrawn)
    this.noteSaved(this.report)
    await this.deps.journal.append({ type: "kill.report", mode: this.deps.mode(), by, report: this.report }).catch(() => {})
    this.deps.publish(this.report)
    return { paused: true, report: this.report, already }
  }

  /** Writes the pause to the state file and the journal: either one brings the next core up paused. */
  private async save(by: string): Promise<void> {
    if (!this.savedInFile) {
      try {
        await this.persist(true)
        this.savedInFile = true
      } catch {}
    }
    if (!this.savedInJournal) {
      try {
        await this.deps.journal.append({ type: "kill.on", mode: this.deps.mode(), by })
        this.savedInJournal = true
      } catch {}
    }
  }

  /** The report says so while the pause is nowhere a restart would find it, and stops saying so once it is. */
  private noteSaved(report: KillReport): void {
    if (this.savedInFile || this.savedInJournal) delete report.unsaved
    else report.unsaved = UNSAVED_WORDS
  }

  async resume(by: string): Promise<{ paused: false; already: boolean }> {
    if (!this.on) return { paused: false, already: true }
    await this.deps.beforeResume?.().catch(() => {})
    // The journal first, then the file: a crash between them leaves the file saying paused, which errs safe.
    await this.deps.journal.append({ type: "kill.off", mode: this.deps.mode(), by })
    this.on = false
    this.report = undefined
    this.savedInFile = false
    this.savedInJournal = false
    await this.persist(false)
    this.deps.onChange()
    return { paused: false, already: false }
  }

  /** An operation changed: the report's in-flight lines follow it until each one settles. */
  noteOperation(op: Operation): void {
    const line = this.report?.inFlight.find((l) => l.opId === op.opId)
    if (!line || (line.state === op.state && !!line.held === !!op.held)) return
    line.state = op.state
    if (op.held) line.held = true
    else delete line.held
    this.deps.publish(this.report!)
  }

  /**
   * A held bot's positions moved (one opened, or its exit sold it): while the report shows, its bots line follows, so it
   * never says a position still sells after it sold.
   */
  botsMoved(): void {
    if (!this.report) return
    const bots = this.deps.botsHeld?.() ?? []
    if (JSON.stringify(bots) === JSON.stringify(this.report.botsHeld ?? [])) return
    if (bots.length) this.report.botsHeld = bots
    else delete this.report.botsHeld
    this.refresh()
  }

  private refresh(): void {
    if (this.report) this.deps.publish(this.report)
  }

  /** A card caught mid-approval, as in flight until its operation says how it ended (refused, if the pause stops it). */
  private approvingLines(): KillReport["inFlight"] {
    return (this.deps.cards.approvingNow?.() ?? []).map((c) => ({ opId: c.opId, cardId: c.cardId, agent: c.agent, title: c.display.headline ?? c.display.title, state: "submitting" as const }))
  }

  private stillOpen(): KillReport["stillOpen"] {
    return this.deps.cards
      .list()
      .filter((c) => c.state === "awaiting_approval" && KEPT.has(c.kind) && !pausedStops(c))
      .map((c) => ({ cardId: c.cardId, cardHash: c.cardHash, title: c.display.headline ?? c.display.title, agent: c.agent, kind: c.kind, ...(c.side ? { side: c.side } : {}) }))
  }

  private build(by: string, turns: { agent: string; turnId: string }[], withdrawn: Card[]): KillReport {
    const now = this.deps.now()
    const cards = this.deps.cards.list()
    const titleOf = (cardId: string) => (cards.find((c) => c.cardId === cardId)?.display.headline ?? cards.find((c) => c.cardId === cardId)?.display.title) ?? "a trade"
    const agents = this.deps.agents()
    const ops = this.deps.operations.list()
    const candleStopped = new Map<string, string>()
    for (const op of ops) if (op.error && CANDLE_STOPS.has(op.error.code)) candleStopped.set(op.agent, op.error.code)
    return {
      at: new Date(now).toISOString(),
      by,
      stopped: { turns, cards: withdrawn.map(cardLine) },
      stillOpen: this.stillOpen(),
      inFlight: [
        // A trade whose job Candle ended (it may have filled) isn't in flight: nothing reads it, and its card says so.
        ...ops.filter((op) => IN_FLIGHT.has(op.state) && (op.kind === "bridge" || !notFollowedFurther(op))).map((op) => ({ opId: op.opId, cardId: op.cardId, agent: op.agent, title: titleOf(op.cardId), state: op.state, ...(op.held ? { held: true } : {}) })),
        ...this.approvingLines().filter((line) => !ops.some((op) => op.opId === line.opId)),
      ],
      standing: this.standing(now, agents),
      notStopped: {
        wording: KILL_WORDING,
        steps: agents.map((agent) => {
          const prefix = this.deps.keyPrefix(agent) ?? "<key prefix>"
          const tee = this.deps.teeWallets?.(agent) ?? []
          return {
            agent,
            takeOffWallet: "candle keys self embedded-wallet deny",
            revoke: `candle keys revoke ${prefix}`,
            ...(tee.length ? { disableTee: tee.map((w) => ({ wallet: this.deps.nameOf?.(w.address, "tee", w.label) ?? walletName(undefined, { ...w, kind: "tee" }), command: `candle tee disable ${w.address}` })) } : {}),
          }
        }),
        candleStopped: [...candleStopped].map(([agent, code]) => ({ agent, code })),
      },
      ...(() => {
        const inside = this.deps.insideLimits?.() ?? []
        return inside.length ? { insideLimits: inside.map((w) => ({ ...w, words: `${w.name === "embedded" ? "embedded wallet" : w.name}: trades inside limits, held by the pause. Its sells still go.` })) } : {}
      })(),
      ...(() => {
        const held = this.deps.triggersHeld?.() ?? []
        return held.length ? { triggersHeld: held } : {}
      })(),
      ...(() => {
        const bots = this.deps.botsHeld?.() ?? []
        return bots.length ? { botsHeld: bots } : {}
      })(),
      resume: "Type resume, or use the status bar, to allow buys again.",
    }
  }

  private standing(now: number, agents: string[]): KillReport["standing"] {
    const read = this.deps.portfolio()
    const all = walletStanding(read?.result, this.deps.prices, agents, (agent) => [...this.deps.walletsOf(agent), ...(this.deps.teeWallets?.(agent) ?? []).map((w) => w.address)], this.deps.nameOf, this.deps.chains?.())
    // The wallets the Candle Harness's agents pay from, as the Wallets pane shows by default: an old TEE wallet on another key
    // read as one the pause held. Every wallet, where none is known to be an agent's.
    const theirs = all.filter((w) => w.agents.length > 0)
    return {
      portfolioAgeMs: read ? now - read.readAt : null,
      wallets: theirs.length > 0 ? theirs : all,
      pnl: this.deps.pnl?.() ?? null,
      spentToday: agents.map((agent) => ({ agent, usd: this.deps.spend.spent(agent, now), perDayUsd: this.deps.limitsFor(agent)?.perDayUsd ?? null })),
    }
  }

  private async persist(paused: boolean): Promise<void> {
    const temp = `${this.deps.statePath}.tmp-${randomBytes(6).toString("base64url")}`
    try {
      await writeFile(temp, `${JSON.stringify({ paused, at: new Date(this.deps.now()).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
      await chmod(temp, 0o600)
      await rename(temp, this.deps.statePath)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
}

const cardLine = (card: Card) => ({ cardId: card.cardId, title: card.display.headline ?? card.display.title, agent: card.agent })
