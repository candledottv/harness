// A request budget per key. Candle limits each key's requests a minute
// (30, 300 and 600 on Free, Pro and Max; docs.candle.tv/developers/agent-wallets: "Each key carries its own
// `rateLimitPerMin`"), and the core's background reads share a key with its trades and turns: a trade
// Candle answers RATE_LIMITED is refused (execute.ts). So every call through an agent's key is counted
// here, over a sliding minute, and background reads ask before they go:
//   - a key's limit is its status read's `tierCaps.rateLimitPerMin`, else its plan's, else Free's 30. For
//     two minutes after Candle answers RATE_LIMITED, it's taken as half that;
//   - background reads may use at most half of it, planned in this order: prices (cards
//     need them), the linked token, P&L, pins, the lists. Each gets one read a minute first, as far as the
//     half goes, then its full pace in order, to 90% of the half. What doesn't fit is read less often, and
//     its pane says so;
//   - a background read also waits while the key's calls in the last minute come within CARD_RESERVE of
//     its limit, so a card proposed and approved in that minute still has room;
//   - a read that's the same for any key (a token's market, its check, the lists) goes to the agent key
//     with the most room, not always the active one;
//   - some MCP tools make several of Candle's requests (requestsOf), and a call is counted as that many;
//   - a read through the user's own CLI makes several of Candle's calls (an empty-accounts preview makes
//     four), so it asks for room for, and is counted as, that many.
//   - triggers' level checks read Candle's market read, which Candle doesn't count toward a key's limit
//     (measured on a Free key: 40 market reads, then a P&L read, all answered). So they're no part of the
//     plan above and count nothing here; `uncountedKey` only picks the key, skipping one Candle just rate-limited.
// Nothing here is on the trade path: a card's call and a turn's are counted, never asked, never queued.
import type { ToolOutcome } from "./candle-mcp"

export type ReadKind = "prices" | "bridges" | "linked" | "pnl" | "pins" | "lists" | "empty"
/**
 * The order background reads are planned in: what doesn't fit is read less often, from the end. An open bridge's
 * read is second: it says where the person's funds are between two chains.
 */
export const READ_ORDER: readonly ReadKind[] = ["prices", "bridges", "linked", "pnl", "pins", "lists", "empty"]
/** Reads that answer the same for any key on the account, so any agent's key may make them. */
const ANY_KEY: ReadonlySet<ReadKind> = new Set(["linked", "pins", "lists"])

/**
 * How many of Candle's requests one MCP tool call makes, where it's more than one: what the key's limit counts.
 * Measured on a Free key, by calls until RATE_LIMITED: the status read 10, so 3 each, and a fourth since CLI 0.13.18
 * (its MCP server's executionStatus also reads the key's risk settings); the portfolio 22 of 30, so 2 here. The profile wallets and P&L reads took 30, and a token's market read never met the limit. A trade is
 * from the MCP server's source (orchestrate.ts executeTrade): a market read or two reads for a percent sell, then the
 * trade, so 3 at most.
 */
const TOOL_REQUESTS: Readonly<Record<string, number>> = { candle_execution_status: 4, candle_get_portfolio: 2, candle_trade: 3 }
export const requestsOf = (tool: string): number => TOOL_REQUESTS[tool] ?? 1
/**
 * What Candle's MCP server asks of the key by itself: whether the key may edit its profile, once as it starts and
 * again on every tools/list (CLI 0.13.18, packages/mcp/src/server.ts runStdioServer).
 */
export const MCP_START_REQUESTS = 2
export const MCP_LIST_REQUESTS = 1
/** What one of a bot's own trades makes against the key: the holding read before an exit, then the trade. */
export const CORE_TRADE_REQUESTS = requestsOf("candle_trade") + requestsOf("candle_get_portfolio")

export const WINDOW_MS = 60_000
export const FREE_LIMIT = 30
export const PLAN_LIMITS: Readonly<Record<string, number>> = { free: 30, pro: 300, max: 600 }
/** The most of a key's limit background reads may use. */
export const BACKGROUND_SHARE = 0.5
/**
 * How much of the background half the plan fills: the rest is slack for reads someone asked for, the wallet
 * reads after a fill, and timers that drift, so a planned read isn't turned back at the edge.
 */
export const PLAN_FILL = 0.9
/** How long a RATE_LIMITED answer halves the key's limit here. */
export const LOWERED_MS = 2 * 60_000
/** Calls kept free under the limit for a card: its pricing read, a holding read, the trade, a read-back. */
export const CARD_RESERVE = 5

/** Why a pane's read is slowed: to fit the key's limit, because Candle rate-limited it, or waiting on calls a card or turn made. */
export interface Pace {
  /** How often it now reads; none while it waits. */
  everyMs?: number
  why: "limit" | "rate-limited" | "busy"
}

/** One key's limit and use, for the status topic and the doctor. */
export interface KeyUse {
  agent: string
  /** The limit the budget works to now: half the key's own for two minutes after a RATE_LIMITED. */
  limit: number
  /** The key's own limit, as Candle states it (or its plan's, or Free's 30 until read). */
  keyLimit: number
  lowered: boolean
  /** Calls through the key in the last minute: turns, cards and background reads. */
  used: number
  /** Of those, background reads. */
  background: number
  /** The most background reads may use. */
  allowance: number
}

/** A background read's natural pace and its key. */
export interface Want {
  /** Reads a minute it would make at its own pace now (0 when it isn't running). */
  perMin: () => number
  /** Reads a minute it gets first, before anything's full pace: one per token or list. */
  floor?: () => number
  /** Its own interval, for saying how often it now reads: a function where it changes (the lists, 15 s or 60 s). */
  naturalMs: number | (() => number)
  /** The key it must use (prices and P&L are the key's own); unset for a read any key may make. */
  key?: () => string | undefined
}

/** A background read that waited: the caller keeps what it had and tries at its next turn. */
export const BUDGET_WAIT: ToolOutcome = { kind: "error", code: "BUDGET_WAIT", retryable: true, body: { message: "a background read waited for room in the key's Candle limit" } }

export class KeyBudget {
  private readonly calls = new Map<string, number[]>()
  private readonly background = new Map<string, number[]>()
  private readonly loweredUntil = new Map<string, number>()
  private readonly wants = new Map<ReadKind, Want>()
  /** When each kind last waited on the reserve kept for a card (not on its own share). */
  private readonly waited = new Map<ReadKind, number>()
  private lastPace = "{}"

  constructor(
    private readonly deps: {
      /** The key's limit a minute as Candle states it, or its plan's; undefined until read. */
      limitOf: (agent: string) => number | undefined
      /** The agents whose Candle connection is up: where a read any key may make can go. */
      agents: () => string[]
      /** The active agent: first among equals. */
      preferred: () => string | undefined
      now: () => number
      /** When what the panes are told (`pace()`) changes. */
      onChange?: () => void
      /**
       * Calls to keep free on a key for the core's own trades still to come: a key with bots on keeps room for the
       * trades its pace still allows, so a burst of entries and exits never meets Candle's limit behind the reads.
       */
      coreReserve?: (agent: string) => number
    },
  ) {}

  /** Every call through an agent's key, counted as it's sent (`n` for a CLI run that makes several). Never waits. */
  noteCall(agent: string, n = 1): void {
    for (let i = 0; i < n; i++) push(this.calls, agent, this.deps.now())
  }

  /** Candle's answer: a RATE_LIMITED halves the key's limit here for two minutes. */
  noteOutcome(agent: string, outcome: ToolOutcome): void {
    if (outcome.kind !== "error" || outcome.code !== "RATE_LIMITED") return
    this.loweredUntil.set(agent, this.deps.now() + LOWERED_MS)
    this.check()
  }

  /** The key's own limit: Candle's figure, else Free's. */
  keyLimit(agent: string): number {
    const stated = this.deps.limitOf(agent)
    return stated !== undefined && Number.isFinite(stated) && stated > 0 ? stated : FREE_LIMIT
  }

  lowered(agent: string): boolean {
    return (this.loweredUntil.get(agent) ?? 0) > this.deps.now()
  }

  /** The limit worked to now. */
  limit(agent: string): number {
    const own = this.keyLimit(agent)
    return this.lowered(agent) ? Math.max(1, Math.floor(own / 2)) : own
  }

  allowance(agent: string): number {
    return Math.floor(this.limit(agent) * BACKGROUND_SHARE)
  }

  /** A background read's pace, registered once. */
  want(kind: ReadKind, want: Want): void {
    this.wants.set(kind, want)
  }

  /** How many times its own interval a kind now waits between reads: 1 when it fits. */
  stretch(kind: ReadKind): number {
    const want = this.wants.get(kind)
    const perMin = want?.perMin() ?? 0
    if (perMin <= 0) return 1
    const got = this.plan().get(kind) ?? 0
    // Nothing fits: once a minute in name, and the reserve check decides each read.
    return got > 0 ? Math.max(1, perMin / got) : Math.max(1, perMin)
  }

  /**
   * A planned background read asks to go: the agent whose key it uses, or undefined to keep what it has and
   * try at its next turn. `key` is the key it must use (prices, P&L); without one, the key with most room.
   * `cost` is how many of Candle's calls the read makes: it needs that much room, and is counted as that many.
   */
  take(kind: ReadKind, key?: string, cost = 1): string | undefined {
    const now = this.deps.now()
    const candidates = this.candidates(kind, key)
    if (candidates.length === 0) return undefined
    const best = this.roomiest(candidates, now)
    if (this.room(best, now) < cost) {
      // Turned back by a card's or a turn's calls, the pane says so; at its own share's edge, its pace says enough.
      if (candidates.every((a) => this.reserveRoom(a, now) < cost)) this.waited.set(kind, now)
      this.check()
      return undefined
    }
    for (let i = 0; i < cost; i++) push(this.background, best, now)
    this.check()
    return best
  }

  /**
   * A read someone asked for (the person's pick, the agent showing a token): never waits, and counts as
   * background so the planned reads make room after it. Undefined only with no agent at all.
   */
  ask(key?: string): string | undefined {
    const candidates = key !== undefined ? [key] : this.deps.agents()
    const fallback = this.deps.preferred()
    if (candidates.length === 0) return fallback
    const best = this.roomiest(candidates, this.deps.now())
    push(this.background, best, this.deps.now())
    return best
  }

  /**
   * The key for a read Candle doesn't count (triggers' level checks): the active agent's, else the first up,
   * passing over a key Candle rate-limited in the last two minutes. Undefined when every key is.
   */
  uncountedKey(): string | undefined {
    const up = this.deps.agents()
    const preferred = this.deps.preferred()
    const order = preferred !== undefined && up.includes(preferred) ? [preferred, ...up.filter((a) => a !== preferred)] : up
    return order.find((a) => !this.lowered(a))
  }

  /** What each slowed read's pane says: how often it reads now, and why. */
  pace(): Partial<Record<ReadKind, Pace>> {
    const now = this.deps.now()
    const out: Partial<Record<ReadKind, Pace>> = {}
    for (const kind of READ_ORDER) {
      const want = this.wants.get(kind)
      if (!want || want.perMin() <= 0) continue
      const s = this.stretch(kind)
      const keys = want.key ? [want.key()].filter((k) => k !== undefined) : this.deps.agents()
      const lowered = keys.some((k) => this.lowered(k))
      const natural = typeof want.naturalMs === "function" ? want.naturalMs() : want.naturalMs
      if (s > 1.01) out[kind] = { everyMs: roundMs(natural * s), why: lowered ? "rate-limited" : "limit" }
      else if (now - (this.waited.get(kind) ?? Number.NEGATIVE_INFINITY) < WINDOW_MS) out[kind] = { why: lowered ? "rate-limited" : "busy" }
    }
    return out
  }

  /** Each key's limit and use over the last minute. */
  use(): KeyUse[] {
    const now = this.deps.now()
    const agents = [...new Set([...this.deps.agents(), ...this.calls.keys()])]
    return agents.map((agent) => ({
      agent,
      limit: this.limit(agent),
      keyLimit: this.keyLimit(agent),
      lowered: this.lowered(agent),
      used: count(this.calls, agent, now),
      background: count(this.background, agent, now),
      allowance: this.allowance(agent),
    }))
  }

  /** Tells the panes when what they'd say changed: a pace, a limit read, a RATE_LIMITED, a wait. */
  check(): void {
    const next = JSON.stringify(this.pace())
    if (next === this.lastPace) return
    this.lastPace = next
    this.deps.onChange?.()
  }

  private candidates(kind: ReadKind, key: string | undefined): string[] {
    if (key !== undefined && !ANY_KEY.has(kind)) return [key]
    const up = this.deps.agents()
    if (up.length > 0) return up
    // No connection up: the call fails on its own, and isn't Candle's to count.
    const fallback = key ?? this.deps.preferred()
    return fallback !== undefined ? [fallback] : []
  }

  /** Room for one more background read: under the allowance, and clear of the reserve kept for a card. */
  private room(agent: string, now: number): number {
    return Math.min(this.allowance(agent) - count(this.background, agent, now), this.reserveRoom(agent, now))
  }

  /** Calls left before the key's calls in the last minute reach the reserve kept for a card and for its bots' trades. */
  private reserveRoom(agent: string, now: number): number {
    return this.limit(agent) - CARD_RESERVE - this.coreReserve(agent) - count(this.calls, agent, now)
  }

  /** Room kept for the key's bots' trades still to come, at most the half of the limit background reads don't get. */
  private coreReserve(agent: string): number {
    const most = Math.max(0, Math.floor(this.limit(agent) * (1 - BACKGROUND_SHARE)) - CARD_RESERVE)
    return Math.min(most, Math.max(0, this.deps.coreReserve?.(agent) ?? 0))
  }

  /** The candidate with most room; the active agent first among equals. */
  private roomiest(candidates: string[], now: number): string {
    const preferred = this.deps.preferred()
    let best = candidates.includes(preferred ?? "") ? preferred! : candidates[0]!
    for (const agent of candidates) if (this.room(agent, now) > this.room(best, now)) best = agent
    return best
  }

  /**
   * Reads a minute each kind gets, from each key's allowance: one a minute per token or list first, in
   * order, then each kind's full pace in order. A read any key may make draws on every key's.
   */
  private plan(): Map<ReadKind, number> {
    const agents = this.deps.agents()
    const fill = (a: string) => Math.floor(this.allowance(a) * PLAN_FILL)
    const remaining = new Map(agents.map((a) => [a, fill(a)]))
    const got = new Map<ReadKind, number>()
    const keyOf = (kind: ReadKind) => (ANY_KEY.has(kind) ? undefined : this.wants.get(kind)?.key?.())
    const avail = (kind: ReadKind) => {
      const key = keyOf(kind)
      if (key !== undefined) return remaining.get(key) ?? fill(key)
      return [...remaining.values()].reduce((a, b) => a + Math.max(0, b), 0)
    }
    const spend = (kind: ReadKind, n: number) => {
      got.set(kind, (got.get(kind) ?? 0) + n)
      const key = keyOf(kind)
      if (key !== undefined) {
        remaining.set(key, (remaining.get(key) ?? fill(key)) - n)
        return
      }
      let left = n
      for (const [agent, r] of [...remaining].sort((a, b) => b[1] - a[1])) {
        const take = Math.min(left, Math.max(0, r))
        remaining.set(agent, r - take)
        left -= take
        if (left <= 0) break
      }
    }
    for (const kind of READ_ORDER) {
      const want = this.wants.get(kind)
      if (!want) continue
      const perMin = want.perMin()
      spend(kind, Math.max(0, Math.min(want.floor?.() ?? 1, perMin, avail(kind))))
    }
    for (const kind of READ_ORDER) {
      const want = this.wants.get(kind)
      if (!want) continue
      spend(kind, Math.max(0, Math.min(want.perMin() - (got.get(kind) ?? 0), avail(kind))))
    }
    return got
  }
}

/** A call through a key, counted, and its answer read for RATE_LIMITED. The budget is told; it never holds the call. */
export async function metered(budget: Pick<KeyBudget, "noteCall" | "noteOutcome"> | undefined, agent: string, call: () => Promise<ToolOutcome>, requests = 1): Promise<ToolOutcome> {
  budget?.noteCall(agent, requests)
  const outcome = await call()
  budget?.noteOutcome(agent, outcome)
  return outcome
}

/** How often a pane now reads, and why, for its title: "every 15 s (Candle's limit)". */
export function paceWords(pace: Pace | undefined): string | undefined {
  if (!pace) return undefined
  if (pace.everyMs === undefined) return pace.why === "rate-limited" ? "waiting (Candle rate-limited)" : "waiting (room kept for trades)"
  const s = Math.round(pace.everyMs / 1000)
  const every = s < 90 ? `every ${s} s` : `every ${Math.round(s / 60)} min`
  return `${every} (${pace.why === "rate-limited" ? "Candle rate-limited" : "Candle's limit"})`
}

function push(map: Map<string, number[]>, agent: string, at: number): void {
  const list = map.get(agent) ?? []
  list.push(at)
  prune(list, at)
  map.set(agent, list)
}

function count(map: Map<string, number[]>, agent: string, now: number): number {
  const list = map.get(agent)
  if (!list) return 0
  prune(list, now)
  return list.length
}

function prune(list: number[], now: number): void {
  let drop = 0
  while (drop < list.length && now - list[drop]! >= WINDOW_MS) drop++
  if (drop) list.splice(0, drop)
}

/** A slowed interval, to the second under a minute and to 5 s above. */
function roundMs(ms: number): number {
  return ms < 60_000 ? Math.ceil(ms / 1000) * 1000 : Math.ceil(ms / 5000) * 5000
}
