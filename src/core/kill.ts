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
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import type { Card } from "./cards"
import { pausedStops } from "./classify"
import type { Operation } from "./execute"
import type { Journal, JournalRow } from "./journal"
import type { DaySpend } from "./limits"
import { type WalletStanding, walletStanding } from "./standing"
import { walletName } from "./wallet-names"
import type { OperationState } from "./tool-face"

export const KILL_WORDING =
  "Stops the agent and everything that trades through the Candle Harness. Bots and other apps using your keys aren't stopped. To stop those too, take the key off the wallet (you can allow it again) or revoke it (permanent)."

const IN_FLIGHT: ReadonlySet<OperationState> = new Set(["submitting", "pending", "unknown"])
/** The kinds whose open cards the report lists as kept: what moves value or takes something down. */
/** A trade card that sells: the kill switch keeps it, at a fresh price. */
const isSell = (card: Card) => card.kind === "trade" && card.side === "sell"
const KEPT: ReadonlySet<string> = new Set(["trade", "swap", "launch", "stake", "claim", "public", "lp", "close"])
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
  resume: string
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
  operations: { list(): Operation[] }
  engine: { cancelAll(): Promise<{ agent: string; turnId: string }[]> }
  spend: DaySpend
  limitsFor: (agent: string) => { perDayUsd: number } | undefined
  /** Which agents may use each wallet, from their last status reads. */
  walletOf: (agent: string) => string | undefined
  portfolio: () => { result: unknown; readAt: number } | undefined
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

  private constructor(private readonly deps: KillDeps) {}

  /** Opens the switch in the state the last core left it: paused if the state file or the journal says so. */
  static async open(deps: KillDeps): Promise<KillSwitch> {
    const k = new KillSwitch(deps)
    let fromFile = false
    try {
      fromFile = (JSON.parse(await readFile(deps.statePath, "utf8")) as { paused?: unknown }).paused === true
    } catch {}
    k.on = fromFile || pausedInJournal(deps.journal.rows())
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
    if (!already) {
      this.on = true
      await this.persist(true)
      await this.deps.journal.append({ type: "kill.on", mode: this.deps.mode(), by })
      this.deps.onChange()
    }
    const turns = await this.deps.engine.cancelAll()
    const withdrawn = await this.deps.cards.withdrawWhere(pausedStops, "kill_switch")
    // Each kept sell starts again at a fresh price, so reading the report doesn't run out its 60 s.
    await this.deps.cards.refreshWhere(isSell, "kill_switch_fresh")
    if (already && this.report) {
      this.report.stopped.turns.push(...turns)
      this.report.stopped.cards.push(...withdrawn.map(cardLine))
      this.report.stillOpen = this.stillOpen()
      for (const line of this.approvingLines()) if (!this.report.inFlight.some((l) => l.opId === line.opId)) this.report.inFlight.push(line)
      await this.deps.journal.append({ type: "kill.report", mode: this.deps.mode(), by, again: true, report: this.report })
      this.refresh()
      return { paused: true, report: this.report, already }
    }
    this.report = this.build(by, turns, withdrawn)
    await this.deps.journal.append({ type: "kill.report", mode: this.deps.mode(), by, report: this.report })
    this.deps.publish(this.report)
    return { paused: true, report: this.report, already }
  }

  async resume(by: string): Promise<{ paused: false; already: boolean }> {
    if (!this.on) return { paused: false, already: true }
    // The journal first, then the file: a crash between them leaves the file saying paused, which errs safe.
    await this.deps.journal.append({ type: "kill.off", mode: this.deps.mode(), by })
    this.on = false
    this.report = undefined
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
        ...ops.filter((op) => IN_FLIGHT.has(op.state)).map((op) => ({ opId: op.opId, cardId: op.cardId, agent: op.agent, title: titleOf(op.cardId), state: op.state, ...(op.held ? { held: true } : {}) })),
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
      resume: "Type resume, or use the status bar, to allow buys again.",
    }
  }

  private standing(now: number, agents: string[]): KillReport["standing"] {
    const read = this.deps.portfolio()
    const all = walletStanding(read?.result, this.deps.prices, agents, (agent) => [this.deps.walletOf(agent), ...(this.deps.teeWallets?.(agent) ?? []).map((w) => w.address)], this.deps.nameOf)
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
    await writeFile(temp, `${JSON.stringify({ paused, at: new Date(this.deps.now()).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.deps.statePath)
  }
}

const cardLine = (card: Card) => ({ cardId: card.cardId, title: card.display.headline ?? card.display.title, agent: card.agent })
