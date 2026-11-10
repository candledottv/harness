// A client of the core's attach protocol: one connection, line-delimited
// JSON-RPC 2.0. The MCP shim attaches with it as a harness; a view attaches through ViewSession,
// which reads the current view token from `view.token`, reconnects when the core goes, and
// resubscribes with `sinceSeq` so it misses no card or operation event.
import { createConnection, type Socket } from "node:net"
import { encodeLine, LineDecoder, PROTOCOL_VERSION, type RpcErrorBody } from "../shared/rpc"
import { readViewToken } from "./tokens"

export class CoreClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "CoreClientError"
  }
}

export type CoreEventParams = { topic: string; seq: number; data: unknown; snapshot?: boolean }

export interface CoreConnection {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(listener: (params: CoreEventParams) => void): void
  onClose(listener: () => void): void
  close(): void
}

/** Connects and says hello. Refusals (PROTOCOL_MISMATCH, UNAUTHENTICATED) reject with their code. */
export async function connectCore(input: { socketPath: string; token: string; clientName: string; harnessKind?: string }): Promise<{ connection: CoreConnection; hello: Record<string, unknown> }> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection(input.socketPath)
    s.once("connect", () => resolve(s))
    s.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new CoreClientError("CORE_NOT_RUNNING", `No Candle Harness core is listening at ${input.socketPath}.`)
          : error,
      )
    })
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const eventListeners: ((params: CoreEventParams) => void)[] = []
  const closeListeners: (() => void)[] = []
  const decoder = new LineDecoder()
  let nextId = 1
  let closed = false
  socket.on("error", () => {})
  socket.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk).lines) {
      let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: RpcErrorBody }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.method === "event") {
        for (const listener of eventListeners) listener(message.params as CoreEventParams)
        continue
      }
      if (typeof message.id !== "number") continue
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) {
        const { code, ...details } = message.error.data ?? { code: "CORE_ERROR" }
        waiter?.reject(new CoreClientError(code, message.error.message, details))
      } else waiter?.resolve(message.result)
    }
  })
  socket.on("close", () => {
    closed = true
    for (const waiter of pending.values()) waiter.reject(new CoreClientError("CORE_DISCONNECTED", "The Candle Harness core closed the connection."))
    pending.clear()
    for (const listener of closeListeners) listener()
  })
  const connection: CoreConnection = {
    request(method, params) {
      if (closed) return Promise.reject(new CoreClientError("CORE_DISCONNECTED", "The Candle Harness core closed the connection."))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        socket.write(encodeLine({ jsonrpc: "2.0", id, method, params: params ?? {} }))
      })
    },
    onEvent: (listener) => eventListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: () => socket.end(),
  }
  try {
    const hello = await connection.request<Record<string, unknown>>("core.hello", {
      protocol: PROTOCOL_VERSION,
      token: input.token,
      clientName: input.clientName,
      ...(input.harnessKind ? { harnessKind: input.harnessKind } : {}),
    })
    return { connection, hello }
  } catch (error) {
    connection.close()
    throw error
  }
}

/** The doctor's name as a view: it only reads. */
export const DOCTOR_CLIENT = "candle-harness doctor"
/** The resource sampler's name as a view: it only reads `core.usage`. */
export const SAMPLER_CLIENT = "candle-harness sampler"
/** `candle-harness stop` and `candle-harness service` as a view: they read the status, and stop the core. */
export const STOP_CLIENT = "candle-harness stop"
/** `candle-harness ask` as a view: the person's message from a script or another terminal. */
export const ASK_CLIENT = "candle-harness ask"
/** `candle-harness trigger <name>` as a view: fires an `on call` trigger from outside. */
export const TRIGGER_CLIENT = "candle-harness trigger"
/** `candle-harness bots …` as a view: lists code bots, starts and stops their processes, writes a token file, reads a log. */
export const BOTS_CLIENT = "candle-harness bots"
/** `candle-harness cards` as a view: it lists cards and how each ended, and never approves one. */
export const CARDS_CLIENT = "candle-harness cards"
/** Views that only read: the doctor, the sampler, `stop` and `cards`. They fire no trigger. */
export const READ_ONLY_CLIENTS: ReadonlySet<string> = new Set([DOCTOR_CLIENT, SAMPLER_CLIENT, STOP_CLIENT, CARDS_CLIENT])
/**
 * Views that are never the person's open Candle Harness: the ones that only read, and `ask`, `trigger` and `bots` from outside.
 * One doesn't open or close a session (the away gap, "since last session"), isn't sent notifications, isn't
 * the main view for what only that may do, and doesn't keep an idle core running, so checking, measuring or
 * scripting changes nothing.
 */
export const OBSERVER_CLIENTS: ReadonlySet<string> = new Set([...READ_ONLY_CLIENTS, ASK_CLIENT, TRIGGER_CLIENT, BOTS_CLIENT])

/** A Build pane's token variables (setup/build.ts's BUILD_TOKEN_ENV and BUILD_TOKEN_FILE_ENV). */
const BUILD_PANE_ENV = ["CANDLE_HARNESS_BUILD_TOKEN", "CANDLE_HARNESS_BUILD_TOKEN_FILE"] as const

/**
 * Why nothing attaches as the person from here: this is a Build pane's environment, whose harness reads untrusted
 * text (bot logs, token names, agent replies). It works through its own token, never the view's, so text injected
 * into what it reads can't send `ask`, fire a trigger, or act as a view. Undefined elsewhere.
 */
export function buildPaneRefusal(env: Record<string, string | undefined> = process.env): CoreClientError | undefined {
  if (!BUILD_PANE_ENV.some((name) => env[name])) return undefined
  return new CoreClientError("BUILD_PANE", "This runs in a Build pane, whose harness can't act as you: ask, trigger and attaching as a view are the person's own, from a terminal of their own")
}

/**
 * Attaches as a view with the token the core published. Two views starting together can race for
 * one token (each hello rotates it), so an UNAUTHENTICATED is retried with the file's newer token.
 * Refused in a Build pane's environment (buildPaneRefusal).
 */
export async function connectView(input: { socketPath: string; viewTokenPath: string; clientName: string; env?: Record<string, string | undefined> }): Promise<{ connection: CoreConnection; hello: Record<string, unknown> }> {
  const pane = buildPaneRefusal(input.env)
  if (pane) throw pane
  let lastToken: string | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await readViewToken(input.viewTokenPath)
    if (token === undefined) throw new CoreClientError("NO_VIEW_TOKEN", `No view token at ${input.viewTokenPath}: the core hasn't published one.`)
    if (token === lastToken) await Bun.sleep(50) // give the other view's rotation time to land
    lastToken = token
    try {
      return await connectCore({ socketPath: input.socketPath, token, clientName: input.clientName })
    } catch (error) {
      if (!(error instanceof CoreClientError) || error.code !== "UNAUTHENTICATED") throw error
    }
  }
  throw new CoreClientError("UNAUTHENTICATED", "The view token kept changing under this view; try again.")
}

/** A view's session: reconnects when the core goes, says hello with the current token, and resubscribes from the last seq it saw. */
export class ViewSession {
  private connection: CoreConnection | undefined
  private lastSeq: Record<string, number> = {}
  private coreId: unknown
  private helloVersion: string | undefined
  private readonly listeners: ((params: CoreEventParams) => void)[] = []
  /** Events that arrived before anyone listened, such as the snapshots that answer the first subscribe. */
  private early: CoreEventParams[] | undefined = []
  private readonly helloListeners: ((hello: Record<string, unknown>) => void)[] = []
  private stopped = false
  /** The core's id for this view at each hello: the Away summary names the one whose attach made it. */
  private ids: string[] = []
  /** Topics wanted now beyond the session's own, subscribed again after a reconnect. */
  private wanted = new Set<string>()
  /** Each wanted topic's filter, by topic (`feeds`: the buckets on screen), kept for a reconnect. */
  private wantedFilters: Record<string, unknown> = {}

  constructor(private readonly input: { socketPath: string; viewTokenPath: string; clientName: string; topics: string[]; retryMs?: number }) {}

  /** Events from now on, past `onEvent`'s replay of early ones, which only its first listener gets: the notifier's. */
  private readonly live: ((params: CoreEventParams) => void)[] = []
  /** Called when the core goes away while the view is still open (not when it closes itself). */
  private readonly lostListeners: (() => void)[] = []

  /** Also given the early events held now, without taking them from `onEvent`'s first listener. */
  onLiveEvent(listener: (params: CoreEventParams) => void): void {
    this.live.push(listener)
    for (const params of this.early ?? []) listener(params)
  }

  onLost(listener: () => void): void {
    this.lostListeners.push(listener)
  }

  /** The first listener also gets every event that arrived before it, in order. */
  onEvent(listener: (params: CoreEventParams) => void): void {
    this.listeners.push(listener)
    const early = this.early
    this.early = undefined
    for (const params of early ?? []) listener(params)
  }

  /** Called after every hello, the first one and each reconnect's. */
  onHello(listener: (hello: Record<string, unknown>) => void): void {
    this.helloListeners.push(listener)
  }

  /** Every id the core has given this view, the first attach's and each reconnect's. */
  clientIds(): readonly string[] {
    return this.ids
  }

  /** The version the attached core said it is in its last hello: a core keeps the one it started as. */
  coreVersion(): string | undefined {
    return this.helloVersion
  }

  async start(): Promise<Record<string, unknown>> {
    return this.attach()
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connection) return Promise.reject(new CoreClientError("CORE_DISCONNECTED", "Not attached to the core right now."))
    return this.connection.request<T>(method, params)
  }

  close(): void {
    this.stopped = true
    this.connection?.close()
  }

  /**
   * The topics this view wants now beyond its own (the Signals pane's, while a layout shows it): new ones
   * are subscribed, dropped ones unsubscribed, and the set is kept for a reconnect. A topic a subscriber
   * holds open can cost the core something, such as Hacc's stream, so it's let go when not shown. A topic
   * may carry a filter (`feeds`: the lists on screen); a changed filter subscribes it again.
   */
  want(topics: readonly string[], filters: Record<string, unknown> = {}): void {
    const next = new Set(topics.filter((t) => !this.input.topics.includes(t)))
    const nextFilters = Object.fromEntries(Object.entries(filters).filter(([t]) => next.has(t)))
    const same = (t: string) => JSON.stringify(this.wantedFilters[t]) === JSON.stringify(nextFilters[t])
    const add = [...next].filter((t) => !this.wanted.has(t) || !same(t))
    const drop = [...this.wanted].filter((t) => !next.has(t))
    this.wanted = next
    this.wantedFilters = nextFilters
    const connection = this.connection
    if (!connection) return
    if (add.length) {
      const f = Object.fromEntries(add.filter((t) => t in nextFilters).map((t) => [t, nextFilters[t]]))
      void connection.request("subscribe", { topics: add, ...(Object.keys(f).length ? { filters: f } : {}) }).catch(() => {})
    }
    if (drop.length) void connection.request("unsubscribe", { topics: drop }).catch(() => {})
  }

  private async attach(): Promise<Record<string, unknown>> {
    const { connection, hello } = await connectView(this.input)
    // A different core (a restart) numbers its events from the start again: what was seen means nothing.
    if (hello.coreId !== this.coreId) this.lastSeq = {}
    this.coreId = hello.coreId
    this.helloVersion = typeof hello.coreVersion === "string" ? hello.coreVersion : undefined
    if (typeof hello.clientId === "string") this.ids.push(hello.clientId)
    this.connection = connection
    connection.onEvent((params) => {
      if (typeof params.seq === "number") this.lastSeq[params.topic] = params.seq
      if (this.early) this.early.push(params)
      for (const listener of this.listeners) listener(params)
      for (const listener of this.live) listener(params)
    })
    connection.onClose(() => {
      this.connection = undefined
      if (this.stopped) return
      for (const listener of this.lostListeners) listener()
      void this.reconnect()
    })
    await connection.request("subscribe", { topics: [...this.input.topics, ...this.wanted], sinceSeq: { ...this.lastSeq }, ...(Object.keys(this.wantedFilters).length ? { filters: { ...this.wantedFilters } } : {}) })
    for (const listener of this.helloListeners) listener(hello)
    return hello
  }

  private async reconnect(): Promise<void> {
    while (!this.stopped) {
      await Bun.sleep(this.input.retryMs ?? 250)
      try {
        await this.attach()
        return
      } catch {
        // The core isn't back yet: try again.
      }
    }
  }
}
