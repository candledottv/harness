// The event stream: `subscribe {topics, sinceSeq?}`, then notifications
// `event {topic, seq, data}`, with `seq` rising per topic. Topics:
//
// | Topic        | What                                                  | Who                          |
// | `status`     | mode, pause, agents, Candle connections, clients      | both                         |
// | `cards`      | every card change                                     | view; a harness its own only  |
// | `operations` | every operation change                                | view; a harness its own only  |
// | `activity`   | what happened, in words, for the activity pane        | view                         |
// | `agent`      | the engine's event stream for the conversation        | view                         |
// | `market`     | the token pane's data                                 | both                         |
// | `portfolio`  | wallets, holdings and paper books, by wallet          | view                         |
// | `wallets`    | what each agent can pay from                          | view                         |
// | `hacc`       | Hacc: on or off, each agent's plan and key, the stream | both                         |
// | `signals`    | Hacc's signal tape, from the core's one socket        | both                         |
// | `signals:mine` | the account's own rules' signals, polled (Pro, Max) | both                         |
// | `views`      | the linked token, who moved it, and the pins          | view                         |
// | `feeds`      | Candle's four lists, each read while subscribed       | view                         |
//
// A topic with a filter (`signals`: pattern and chain; `feeds`: the buckets) takes one per subscription, as
// `subscribe {topics, filters: {<topic>: …}}`; its events and snapshot are cut to it, and an event that
// leaves nothing for a subscriber isn't sent to it.
//
// On reconnect a client subscribes again with `sinceSeq` per topic. `cards`, `operations` and
// `agent` events still held are replayed; otherwise the topic's snapshot is sent.
import type { Role } from "./tokens"

export const REPLAY_BUFFER = 1000
const REPLAYED = new Set(["cards", "operations", "agent"])
const OWNED = new Set(["cards", "operations"])
/** Sent to one view alone, whatever its role (the agent's change to the screen goes to the view last used). */
const DIRECTED = new Set(["asks"])
// `status` and `hacc` carry every agent's limits, spend, wallets and plan; an agent reads its own through its tools.
const VIEW_ONLY = new Set(["status", "hacc", "activity", "agent", "portfolio", "wallets", "engine", "memory", "skills", "views", "asks", "feeds", "pnl", "research", "autonomy", "away", "onboarding"])
const TOPICS = new Set(["status", "cards", "operations", "activity", "agent", "market", "portfolio", "wallets", "engine", "hacc", "signals", "signals:mine", "memory", "skills", "views", "asks", "feeds", "pnl", "research", "autonomy", "away", "onboarding"])

export interface CoreEvent {
  topic: string
  seq: number
  data: unknown
  /** The client the event belongs to, for `cards` and `operations`: a harness sees only its own. */
  ownerClientId?: string
}

export interface Subscriber {
  clientId: string
  role: Role
  send(notification: { jsonrpc: "2.0"; method: "event"; params: Record<string, unknown> }): void
}

export type SnapshotProvider = (subscriber: Subscriber, filter?: unknown) => unknown

/** A topic's own filter: parsed once at subscribe (a problem is the caller's error), applied to each event. */
export interface TopicFilter<F = unknown> {
  parse(raw: unknown): F | { problem: string }
  /** The event's data cut to the filter, or undefined when nothing is left for this subscriber. */
  apply(data: unknown, filter: F): unknown | undefined
  /** For a subscriber that took no filter: the event's data, or undefined to leave it out (Signals' read-backs). Absent, it gets everything. */
  unfiltered?(data: unknown): unknown | undefined
}

export function topicAllowed(topic: string, role: Role): { known: boolean; allowed: boolean } {
  if (!TOPICS.has(topic)) return { known: false, allowed: false }
  return { known: true, allowed: role === "view" || !VIEW_ONLY.has(topic) }
}

export class EventHub {
  private readonly seqs = new Map<string, number>()
  private readonly buffers = new Map<string, CoreEvent[]>()
  private readonly subscriptions = new Map<string, { subscriber: Subscriber; topics: Set<string>; filters: Map<string, unknown> }>()
  private readonly snapshots = new Map<string, SnapshotProvider>()
  private readonly filters = new Map<string, TopicFilter>()
  private readonly changeListeners: (() => void)[] = []

  provideSnapshot(topic: string, provider: SnapshotProvider): void {
    this.snapshots.set(topic, provider)
  }

  provideFilter<F>(topic: string, filter: TopicFilter<F>): void {
    this.filters.set(topic, filter as TopicFilter)
  }

  /** Each topic's filter parsed; throws an Error naming the problem, before anything is subscribed. */
  parseFilters(raw: unknown): Record<string, unknown> {
    if (raw === undefined) return {}
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("filters must be an object of topic to filter.")
    const parsed: Record<string, unknown> = {}
    for (const [topic, value] of Object.entries(raw)) {
      const filter = this.filters.get(topic)
      if (!filter) throw new Error(`${topic} takes no filter.`)
      const f = filter.parse(value)
      if (f && typeof f === "object" && "problem" in f && typeof f.problem === "string") throw new Error(f.problem)
      parsed[topic] = f
    }
    return parsed
  }

  /** Called whenever a subscription is added or removed: the stream opens and closes by it. */
  onSubscriptionsChanged(listener: () => void): void {
    this.changeListeners.push(listener)
  }

  subscriberCount(topic: string): number {
    let n = 0
    for (const { topics } of this.subscriptions.values()) if (topics.has(topic)) n++
    return n
  }

  publish(topic: string, data: unknown, ownerClientId?: string): CoreEvent {
    const seq = (this.seqs.get(topic) ?? 0) + 1
    this.seqs.set(topic, seq)
    const event: CoreEvent = { topic, seq, data, ...(ownerClientId !== undefined ? { ownerClientId } : {}) }
    if (REPLAYED.has(topic)) {
      const buffer = this.buffers.get(topic) ?? []
      buffer.push(event)
      if (buffer.length > REPLAY_BUFFER) buffer.shift()
      this.buffers.set(topic, buffer)
    }
    const filter = this.filters.get(topic)
    for (const { subscriber, topics, filters } of this.subscriptions.values()) {
      if (!topics.has(topic) || !this.visibleTo(event, subscriber)) continue
      if (filter && filters.has(topic)) {
        const data = filter.apply(event.data, filters.get(topic))
        if (data !== undefined) this.deliver(subscriber, { ...event, data })
      } else if (filter?.unfiltered) {
        const data = filter.unfiltered(event.data)
        if (data !== undefined) this.deliver(subscriber, { ...event, data })
      } else this.deliver(subscriber, event)
    }
    return event
  }

  /** Adds topics; each gets a replay (when every event since `sinceSeq` is still held) or a snapshot. */
  subscribe(subscriber: Subscriber, topics: string[], sinceSeq: Record<string, number> = {}, filters: Record<string, unknown> = {}): void {
    const entry = this.subscriptions.get(subscriber.clientId) ?? { subscriber, topics: new Set<string>(), filters: new Map<string, unknown>() }
    this.subscriptions.set(subscriber.clientId, entry)
    for (const topic of topics) {
      entry.topics.add(topic)
      // Subscribing again sets the filter afresh: none given means everything.
      if (topic in filters) entry.filters.set(topic, filters[topic])
      else entry.filters.delete(topic)
      const since = sinceSeq[topic]
      const buffer = this.buffers.get(topic)
      const oldest = buffer?.[0]?.seq
      if (since !== undefined && REPLAYED.has(topic) && (oldest === undefined || oldest <= since + 1)) {
        for (const event of buffer ?? []) if (event.seq > since && this.visibleTo(event, subscriber)) this.deliver(subscriber, event)
        continue
      }
      const provider = this.snapshots.get(topic)
      subscriber.send({
        jsonrpc: "2.0",
        method: "event",
        params: { topic, seq: this.seqs.get(topic) ?? 0, snapshot: true, data: provider ? provider(subscriber, entry.filters.get(topic)) : null },
      })
    }
    this.changed()
  }

  unsubscribe(clientId: string, topics?: string[]): void {
    const entry = this.subscriptions.get(clientId)
    if (entry === undefined) return
    if (topics === undefined) this.subscriptions.delete(clientId)
    else
      for (const topic of topics) {
        entry.topics.delete(topic)
        entry.filters.delete(topic)
      }
    this.changed()
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener()
  }

  /** The filters a topic's subscriptions hold now: `null` for one that took none (it gets everything). */
  filtersOf(topic: string): unknown[] {
    const out: unknown[] = []
    for (const { topics, filters } of this.subscriptions.values()) if (topics.has(topic)) out.push(filters.has(topic) ? filters.get(topic) : null)
    return out
  }

  topicsOf(clientId: string): string[] {
    return [...(this.subscriptions.get(clientId)?.topics ?? [])]
  }

  private visibleTo(event: CoreEvent, subscriber: Subscriber): boolean {
    if (DIRECTED.has(event.topic)) return event.ownerClientId === subscriber.clientId
    if (!OWNED.has(event.topic) || subscriber.role === "view") return true
    return event.ownerClientId === subscriber.clientId
  }

  private deliver(subscriber: Subscriber, event: CoreEvent): void {
    subscriber.send({ jsonrpc: "2.0", method: "event", params: { topic: event.topic, seq: event.seq, data: event.data } })
  }
}
