// The core's notifier: what the person is told when they aren't looking, read from the journal as each row is
// appended, in Activity's words, with no address or key (shared/notify.ts).
//
// - What notifies (`[notify] on`): a card that waits for the person and isn't theirs (the agent's, a woken turn's,
//   a trigger's), a trigger that did something (its notice, its trade's fill or failure, a missed run, a card
//   nobody pressed), a bot's every trade (a rules bot's or a code bot's), and its card waiting, a refusal or failure, a held sell or Candle's
//   pause (never its skips), a wake skipped at its cap, the kill switch going on, and Candle holding a key. The core
//   stopping when nobody asked is the view's to say: it's the one left running.
// - Who sends it: the main view the person last used, through its terminal, while it isn't focused (`notices`,
//   to that view alone). With no main view open, the core itself, as an OS notification, where the machine is
//   local; over SSH or on a VPS with no view, nothing on the machine can reach the person.
// - Rows that come together (a firing and its fill, a chain's parts) are one notification, sent once they've
//   been quiet for 1.5 s, or 5 s after the first. A card that no longer waits by then (it ran without one,
//   or was approved) is left out. A bot's trades in that time are one line a bot ("conf · bought BONK, WIF ·
//   stopped out of MOON").
// - A busy bot is told at most once in 5 minutes: after a bot's line goes, its next trades wait and go together
//   when the 5 minutes are up. A stop-loss exit goes at once, with what waited; a failed or refused sell, a held
//   sell and Candle's pause aren't trades, and go at once as they always do.
import type { BotPart, NotifyKind, Notice, NotifySettings } from "../shared/notify"
import { botLines, botVerb, joinNotices, noticeOf, osNotifyCommand } from "../shared/notify"
import type { JournalRow } from "./journal"
import { botName, triggerName } from "./trade-log"
import { short } from "./wallet-names"

export const QUIET_MS = 1_500
export const MAX_WAIT_MS = 5_000
/** A bot's trades after its line went wait this long, then go as one line. */
export const BOT_FOLD_MS = 5 * 60_000

/** Codes Candle holds a key by: its cap, or a loss limit or the circuit breaker. */
const HOLD_CODES = new Set(["KEY_LIMIT_REACHED", "RISK_LIMIT_REACHED"])
/** A held key is told once in this long: a hold lasts, and every trade it refuses says the same. */
const HOLD_TOLD_MS = 10 * 60_000

const OP_ENDS = new Set(["operation.succeeded", "operation.failed", "operation.refused", "operation.unknown", "operation.abandoned"])
const TRIGGER_ROWS = new Set(["trigger.notify", "trigger.ran", "trigger.woke", "trigger.missed"])

/** Where an operation came from: a trigger, an agent's turn a trigger woke, or a bot's entry, exit or swap. */
export interface OpOrigin {
  trigger?: string
  woken?: string
  bot?: { name: string; act?: string; reason?: string; token?: string; paper?: boolean }
}


/** A bot's sell held for these reasons is told: one more failed sell, or the breaker's pace, would stop the key on Candle; no price leaves its stop unguarded. */
const HELD_TOLD = new Set(["failed_sells", "pace", "route", "unpriced"])

/** A row's notice, before the card check: its kind, its words, and the card it's about. */
export interface RowNotice {
  kind: NotifyKind
  words: string
  cardId?: string
  /** A key Candle held: whose, for telling it once. */
  heldAgent?: string
  /** A bot's trade, joined with the bot's others into one line. */
  bot?: BotPart
  /** A bot's trade told at once, not folded into its next 5 minutes: a stop-loss exit. */
  urgent?: boolean
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const tokenOf = (mint: unknown, symbolOf: (mint: string) => string | undefined): string => (typeof mint === "string" ? (symbolOf(mint) ?? short(mint)) : "a token")

/**
 * What a journal row tells the person, if anything, with Activity's words for it (`said`) where Activity says
 * it. Pure: the card check and telling a hold once are the notifier's.
 */
export function rowNotice(row: JournalRow, said: string | undefined, origin: (opId: string) => OpOrigin | undefined, symbolOf: (mint: string) => string | undefined = () => undefined): RowNotice | undefined {
  const agent = str(row.agent) ?? "the agent"
  // Candle held a key: its cap, a loss limit or the circuit breaker, in Candle's words, whoever's trade it was.
  const error = row.error as { code?: unknown } | undefined
  if (OP_ENDS.has(row.type) && typeof error?.code === "string" && HOLD_CODES.has(error.code)) {
    const why = error.code === "RISK_LIMIT_REACHED" ? "a loss limit or the circuit breaker stopped it, so every trade waits" : "its cap is reached, so its buys and swaps wait; sells still go"
    return { kind: "keys", words: `Candle held ${agent}'s key: ${why}. ${said ?? ""}`.trim(), heldAgent: agent }
  }
  switch (row.type) {
    case "card.created":
      // The agent's card, or one from a turn a trigger woke. The person's own aren't told back to them; a trigger's is
      // told by its `trigger.waiting`, which says why it waits; a card made in place of another, by the kill switch
      // or a pick, followed the person's own press.
      if (row.role !== "harness" || str(row.trigger) || str(row.replaces) || !str(row.cardId)) return undefined
      return { kind: "cards", words: said ?? `${agent} proposed a card`, cardId: String(row.cardId) }
    case "trigger.waiting":
      return { kind: "cards", words: said ?? `${triggerName(row.name)}: its card waits for you`, ...(str(row.cardId) ? { cardId: String(row.cardId) } : {}) }
    case "trigger.held":
      // The kill switch held a firing's buy; the plan's hold of every trigger is the Triggers overlay's to say.
      return str(row.name) ? { kind: "triggers", words: said ?? `${triggerName(row.name)}: held` } : undefined
    // An agent switched off a trigger that sold (a stop, a take profit): that sell no longer waits. Any other switch-off
    // or narrowing removes no protection, and is Activity's and the away note's to say.
    case "trigger.changed":
      return row.how === "agent" && row.on === false && Array.isArray(row.sells) && row.sells.length > 0 && str(row.name) ? { kind: "triggers", words: said ?? `${agent} switched off ${triggerName(row.name)}: its sell no longer waits` } : undefined
    case "trigger.wake_skipped":
      return { kind: "wakes", words: said ?? `${triggerName(row.name)}: its wake was skipped` }
    case "card.expired":
      return str(row.trigger) ? { kind: "triggers", words: said ?? `${triggerName(row.trigger)}'s card expired: nobody pressed it` } : undefined
    case "kill.on":
      return { kind: "kill", words: said ?? "kill switch on: buys paused" }
    // A bot's sell held by two failed sells of its token or the breaker's pace: one more would stop the key on Candle.
    case "bot.exit_held":
      return HELD_TOLD.has(String(row.why)) && str(row.name) ? { kind: "bots", words: said ?? `${botName(row.name)}'s sell waits: ${String(row.words ?? "")}` } : undefined
    // A bot Candle's stop on its key paused: the person resumes the key in the Agent Console, then the bot.
    case "bot.paused":
      return row.how === "candle" && str(row.name) ? { kind: "bots", words: said ?? `${botName(row.name)} is paused: Candle stopped its key` } : undefined
    // A bot's trade that waits for the person: told unless it's been pressed by the time the notice goes.
    case "bot.waiting":
    case "bot.request_waiting":
    case "bot.exit_waiting":
      return str(row.name) ? { kind: "bots", words: said ?? `${botName(row.name)}: ${String(row.words ?? "its trade waits for you")}`, ...(str(row.cardId) ? { cardId: String(row.cardId) } : {}) } : undefined
    // A bot's entry or exit that ended with nothing: refused, failed, lost, or a card nobody pressed. The person's own reject isn't told back.
    case "bot.entry_ended":
    case "bot.request_ended":
    case "bot.exit_ended":
      return str(row.name) && ["refused", "failed", "lost", "expired"].includes(String(row.outcome)) ? { kind: "bots", words: said ?? `${botName(row.name)}: ${String(row.words ?? "its trade ended with nothing")}` } : undefined
    // A code bot's process crashed, or crashed too often to start again: told at once.
    case "bot.process":
      return str(row.name) && (row.what === "crashed" || row.what === "gave_up") ? { kind: "bots", words: said ?? `${botName(row.name)} ${String(row.words ?? "crashed")}` } : undefined
    case "bot.position_left":
      return str(row.name) ? { kind: "bots", words: said ?? `${botName(row.name)} gave up a position` } : undefined
    // A bot's paper trade, which has no operation.
    case "paper.call":
      if (!str(row.bot) || row.isError === true) return undefined
      return { kind: "bots", words: said ?? `${botName(row.bot)} traded on paper`, bot: { bot: String(row.bot), verb: botVerb(row.botAct, row.botReason), token: tokenOf((row.args as { mint?: unknown } | undefined)?.mint, symbolOf), paper: true }, ...(row.botAct === "exit" && row.botReason === "stop_loss" ? { urgent: true } : {}) }
    default:
      break
  }
  if (TRIGGER_ROWS.has(row.type)) return { kind: "triggers", words: said ?? `${triggerName(row.name)} fired` }
  // A trade nobody was there for: a trigger's, or one from a turn a trigger woke.
  if (OP_ENDS.has(row.type) && str(row.opId)) {
    const from = origin(String(row.opId))
    // A bot's fill is joined with its others; how one ended with nothing is said by its bot.* row.
    if (from?.bot) {
      if (row.type !== "operation.succeeded" || row.paper === true) return undefined
      return { kind: "bots", words: said ?? `${botName(from.bot.name)} traded`, bot: { bot: from.bot.name, verb: botVerb(from.bot.act, from.bot.reason), token: from.bot.token ?? "a token", ...(from.bot.paper ? { paper: true } : {}) }, ...(from.bot.act === "exit" && from.bot.reason === "stop_loss" ? { urgent: true } : {}) }
    }
    if (!from?.trigger && !from?.woken) return undefined
    const by = from.trigger ? ` · by ${triggerName(from.trigger)}` : ` · woke on ${triggerName(from.woken)}`
    return { kind: "triggers", words: said ? (said.includes(" · by trigger") || said.includes(" · woke on trigger") ? said : `${said}${by}`) : `a trade${by}` }
  }
  return undefined
}

export interface CoreNotifierDeps {
  settings: NotifySettings
  now(): number
  /** The main view the person last used, listening on `notices`, if one is open. */
  target(): string | undefined
  /** Sends a notice to that view alone. */
  publish(data: { notice: Notice }, clientId: string): void
  /** Whether a card still waits for the person. */
  waiting(cardId: string): boolean
  origin(opId: string): OpOrigin | undefined
  /** A token's symbol, for a bot's paper trade's notice. */
  symbolOf?: (mint: string) => string | undefined
  /** Whether the core can put a notification on this machine's screen (shared/notify.ts canNotifyNative). */
  native: boolean
  platform: "darwin" | "linux"
  /** Runs an OS notification's argv, with no shell. */
  spawn: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>
  journal: { append(row: { type: string } & Record<string, unknown>): Promise<unknown> }
  quietMs?: number
  maxWaitMs?: number
  botFoldMs?: number
}

export class CoreNotifier {
  private queue: { notice: Notice; cardId?: string; bot?: BotPart }[] = []
  /** Each bot whose line went: when, and its trades since, waiting for the 5 minutes to be up. */
  private readonly folds = new Map<string, { sentAt: number; held: { notice: Notice; bot: BotPart }[]; timer?: ReturnType<typeof setTimeout> }>()
  private first = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly heldTold = new Map<string, number>()
  private failedOnce = false
  private stopped = false

  constructor(private readonly deps: CoreNotifierDeps) {}

  /** A row was appended; `said` is Activity's line for it, where Activity says it. */
  row(row: JournalRow, said: string | undefined): void {
    if (this.stopped || this.deps.settings.mode === "off") return
    const n = rowNotice(row, said, (opId) => this.deps.origin(opId), this.deps.symbolOf)
    if (!n || !this.deps.settings.on.includes(n.kind)) return
    if (n.heldAgent) {
      const at = this.heldTold.get(n.heldAgent)
      if (at !== undefined && this.deps.now() - at < HOLD_TOLD_MS) return
      this.heldTold.set(n.heldAgent, this.deps.now())
    }
    if (n.bot) return this.botPart(noticeOf(n.kind, n.words), n.bot, n.urgent === true)
    this.add(noticeOf(n.kind, n.words), n.cardId)
  }

  /** A bot's trade: with the queue, unless its line went in the last 5 minutes; then it waits, but a stop-loss doesn't. */
  private botPart(notice: Notice, bot: BotPart, urgent: boolean): void {
    const fold = this.folds.get(bot.bot)
    const window = this.deps.botFoldMs ?? BOT_FOLD_MS
    const now = this.deps.now()
    if (!fold || now - fold.sentAt >= window) return this.add(notice, undefined, bot)
    if (!urgent) {
      fold.held.push({ notice, bot })
      if (!fold.timer) {
        fold.timer = setTimeout(() => this.release(bot.bot), Math.max(0, fold.sentAt + window - now))
        fold.timer.unref?.()
      }
      return
    }
    this.release(bot.bot)
    this.add(notice, undefined, bot)
  }

  /** A bot's waiting trades join the queue, to go as one line. */
  private release(bot: string): void {
    const fold = this.folds.get(bot)
    if (!fold) return
    if (fold.timer) clearTimeout(fold.timer)
    fold.timer = undefined
    const held = fold.held
    fold.held = []
    if (this.stopped) return
    for (const h of held) this.add(h.notice, undefined, h.bot)
  }

  /** A notice the core says itself, not from a row. */
  say(kind: NotifyKind, words: string): void {
    if (this.stopped || this.deps.settings.mode === "off" || !this.deps.settings.on.includes(kind)) return
    this.add(noticeOf(kind, words))
  }

  private add(notice: Notice, cardId?: string, bot?: BotPart): void {
    const now = this.deps.now()
    if (this.queue.length === 0) this.first = now
    // A card told twice (the agent's proposal, then a trigger's waiting row) is told once.
    if (cardId && this.queue.some((q) => q.cardId === cardId)) return
    this.queue.push({ notice, ...(cardId ? { cardId } : {}), ...(bot ? { bot } : {}) })
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(this.deps.quietMs ?? QUIET_MS, this.first + (this.deps.maxWaitMs ?? MAX_WAIT_MS) - now))
    this.timer = setTimeout(() => void this.flush(), wait)
    this.timer.unref?.()
  }

  /** Sends what's queued, as one notification. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const waiting = this.queue.filter((q) => !q.cardId || this.deps.waiting(q.cardId))
    this.queue = []
    // A bot's trades are one line a bot, where its first trade came.
    const parts = waiting.flatMap((q) => (q.bot ? [q.bot] : []))
    const sentAt = this.deps.now()
    for (const bot of new Set(parts.map((p) => p.bot))) {
      const fold = this.folds.get(bot)
      if (fold) fold.sentAt = sentAt
      else this.folds.set(bot, { sentAt, held: [] })
    }
    const lines = new Map(botLines(parts).map((text, i) => [[...new Set(parts.map((p) => p.bot))][i]!, text]))
    const kept = waiting.flatMap((q) => {
      if (!q.bot) return [q.notice]
      const text = lines.get(q.bot.bot)
      lines.delete(q.bot.bot)
      return text ? [noticeOf("bots", text)] : []
    })
    const notice = joinNotices(kept)
    if (!notice) return
    const target = this.deps.target()
    if (target) {
      this.deps.publish({ notice }, target)
      return
    }
    const { mode } = this.deps.settings
    if ((mode !== "auto" && mode !== "native") || !this.deps.native) return
    const argv = osNotifyCommand(this.deps.platform, notice.title, notice.body)
    let result: { exitCode: number; stderr: string }
    try {
      result = await this.deps.spawn(argv)
    } catch (error) {
      result = { exitCode: -1, stderr: error instanceof Error ? error.message : String(error) }
    }
    if (result.exitCode === 0) {
      await this.deps.journal.append({ type: "notify.sent", by: "core", via: argv[0], kinds: notice.kinds }).catch(() => {})
      return
    }
    // Said once a run: a machine that can't show one won't start to.
    if (this.failedOnce) return
    this.failedOnce = true
    await this.deps.journal.append({ type: "notify.failed", by: "core", via: argv[0], exitCode: result.exitCode, error: result.stderr.trim().split("\n")[0]?.slice(0, 200) ?? "" }).catch(() => {})
  }

  /** The core is stopping: what's queued goes now, and nothing after. */
  async stop(): Promise<void> {
    for (const bot of this.folds.keys()) this.release(bot)
    await this.flush()
    this.stopped = true
  }
}
