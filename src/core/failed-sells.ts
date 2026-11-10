// Failed sells of one token in a row, per agent key: Candle's circuit breaker stops a key after three, sells included,
// until its owner resumes it in the Agent Console (docs.candle.tv/developers/agent-trading, "RISK_LIMIT_REACHED").
//
// - Counted from the journal, whoever sold: the person, the agent, a trigger or a bot. A sell is the key's when its
//   card is the agent's (a TEE wallet's sell through the CLI included). It counts as failed when Candle answered it
//   with an error (`operation.failed`, or `operation.refused` with Candle's code); a refusal the core made before
//   anything reached Candle doesn't, nor one Candle's key check answered before it made a trade (its rate limit, an
//   expired key, a missing scope): Candle's streak counts only a trade it made and failed. A sell that filled starts
//   the count again; one whose outcome isn't known yet counts for nothing until it's read back.
// - After two in a row, the core's own sells of that token (a bot's exits) wait: a third that failed would stop the
//   key. They go again after a sell of it fills, anyone's, or when the person says retry.
// - A sell still under way counts as one that may fail: while any sell of a token is in flight on a
//   key, sent and not settled, or the core's own card made and not yet sent, the core's own next sell of it waits.
//   One sell in flight per key and token, so a run of sells sent together can never fail past the streak. A sell
//   whose outcome isn't known yet stays in flight until it's read back.
import type { JournalRow } from "./journal"

/** The rows that end a sell's flight: its outcome, whatever it is. */
const SETTLES = new Set(["operation.succeeded", "operation.failed", "operation.refused", "operation.abandoned"])
/** The rows that end a card before it was sent. */
const CARD_ENDS = new Set(["card.rejected", "card.withdrawn", "card.expired", "approval.refused"])

/** Failed sells in a row after which the core's own next sell of the token waits. */
export const FAILED_SELLS_HOLD = 2

/** Refusals the core made itself: nothing reached Candle, so Candle counted nothing. */
const NOT_CANDLES = ["MCP_VALIDATION", "CANDLE_MCP_DOWN", "PAUSED", "METHOD_NOT_AVAILABLE", "BOT_MODE"]
/** Refusals Candle's key check makes before any trade exists, so its failed-sell streak never sees them. */
const BEFORE_A_TRADE = ["RATE_LIMITED", "UNAUTHORIZED", "KEY_EXPIRED", "SCOPE_MISSING", "ACCOUNT_BLOCKED", "PROFILE_PAUSED"]
const NOT_COUNTED = new Set([...NOT_CANDLES, ...BEFORE_A_TRADE])

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const keyOf = (agent: string, mint: string) => `${agent}\n${mint}`

export class FailedSells {
  /** Each sell's agent and token, by its operation id, from its card. */
  private readonly sells = new Map<string, { agent: string; mint: string }>()
  private readonly counts = new Map<string, number>()
  /** Held tokens the person said to retry: one more sell goes, and holds again only on a further failure. */
  private readonly released = new Set<string>()
  private readonly settled = new Set<string>()
  /** Sells in flight, by operation id: their key. */
  private readonly flying = new Map<string, string>()
  /** Per agent, whether the last `held` said yes for a sell in flight: its words, asked right after, say so. */
  private readonly heldInFlight = new Map<string, boolean>()
  /** Sells that reached Candle's side: `operation.submitting` was journalled. */
  private readonly sent = new Set<string>()
  /** Each sell card's operation id, by its card id: a card that ends unsent ends its flight. */
  private readonly opOfCard = new Map<string, string>()

  constructor(rows: readonly JournalRow[] = []) {
    for (const row of rows) this.note(row)
  }

  /** A journal row, as it's appended: a sell's card, then its outcome. Whether a count changed. */
  note(row: JournalRow): boolean {
    if (row.type === "card.created" && row.side === "sell" && typeof row.opId === "string" && typeof row.agent === "string" && typeof row.mint === "string") {
      this.sells.set(row.opId, { agent: row.agent, mint: row.mint })
      if (typeof row.cardId === "string") this.opOfCard.set(row.cardId, row.opId)
      // The core's own sell approves itself and goes at once: in flight from its card, so two can't both pass the hold.
      if (row.role === "core") this.flying.set(row.opId, keyOf(row.agent, row.mint))
      return false
    }
    if (CARD_ENDS.has(row.type) && typeof row.cardId === "string") {
      const opId = this.opOfCard.get(row.cardId)
      // Rejected, withdrawn or expired before it was sent: nothing reached Candle. An approval refused leaves it unsent.
      if (opId !== undefined && !this.sent.has(opId)) this.flying.delete(opId)
      return false
    }
    if (typeof row.opId !== "string" || this.settled.has(row.opId)) return false
    const sell = this.sells.get(row.opId)
    if (!sell) return false
    const key = keyOf(sell.agent, sell.mint)
    if (row.type === "operation.submitting") {
      this.sent.add(row.opId)
      this.flying.set(row.opId, key)
      return true
    }
    if (SETTLES.has(row.type)) this.flying.delete(row.opId)
    if (row.type === "operation.succeeded") {
      this.settled.add(row.opId)
      this.counts.delete(key)
      this.released.delete(key)
      return true
    }
    const failed = row.type === "operation.failed" || (row.type === "operation.refused" && !NOT_COUNTED.has(String(record(row.error)?.code ?? "")))
    if (!failed) return SETTLES.has(row.type)
    this.settled.add(row.opId)
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    this.released.delete(key)
    return true
  }

  /** Failed sells of a token in a row on an agent's key. */
  count(agent: string, mint: string): number {
    return this.counts.get(keyOf(agent, mint)) ?? 0
  }

  /** Sells of a token in flight on an agent's key: sent, or the core's own card made, and not settled. */
  inFlight(agent: string, mint: string, except?: string): number {
    const key = keyOf(agent, mint)
    let n = 0
    for (const [opId, k] of this.flying) if (k === key && opId !== except) n++
    return n
  }

  /** Whether one more failed sell could stop the key: failed sells in a row and sells in flight together reach the hold. */
  atRisk(agent: string, mint: string): boolean {
    return this.count(agent, mint) + this.inFlight(agent, mint) >= FAILED_SELLS_HOLD
  }

  /**
   * Whether the core's own next sell of a token on this key waits: one sell of it is in flight already (one at a
   * time, whatever the person's retry says), or one more failure would stop the key.
   */
  held(agent: string, mint: string, except?: string): boolean {
    // `except`: a sell sent again under its own id is in flight already, and doesn't hold itself.
    const flying = this.inFlight(agent, mint, except) > 0
    this.heldInFlight.set(agent, flying)
    if (flying) return true
    const key = keyOf(agent, mint)
    return (this.counts.get(key) ?? 0) >= FAILED_SELLS_HOLD && !this.released.has(key)
  }

  /** The person's retry: the next sell goes once more. Whether one was held. */
  release(agent: string, mint: string): boolean {
    const key = keyOf(agent, mint)
    if (!((this.counts.get(key) ?? 0) >= FAILED_SELLS_HOLD && !this.released.has(key))) return false
    this.released.add(keyOf(agent, mint))
    return true
  }

  /** Why the core's sell waits, in words; with its token, a sell still under way is said as such. */
  words(agent: string, label: string, mint?: string, except?: string): string {
    if (mint !== undefined ? this.inFlight(agent, mint, except) > 0 : this.heldInFlight.get(agent) === true) return `a sell of ${label} on ${agent}'s key is still under way, and the Candle Harness sends one at a time, so a run of failed sells can't stop the key on Candle`
    return `two sells of ${label} in a row failed on ${agent}'s key, and one more would stop the key on Candle, sells included, until you resume it in the Agent Console`
  }
}
