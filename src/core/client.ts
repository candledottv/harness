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
/**
 * Views that only read. One is never the person's view: it doesn't open or close a session (the away gap,
 * "since last session") and doesn't keep an idle core running, so checking or measuring changes nothing.
 */
export const OBSERVER_CLIENTS: ReadonlySet<string> = new Set([DOCTOR_CLIENT, SAMPLER_CLIENT])

/**
 * Attaches as a view with the token the core published. Two views starting together can race for
 * one token (each hello rotates it), so an UNAUTHENTICATED is retried with the file's newer token.
 */
export async function connectView(input: { socketPath: string; viewTokenPath: string; clientName: string }): Promise<{ connection: CoreConnection; hello: Record<string, unknown> }> {
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
    if (typeof hello.clientId === "string") this.ids.push(hello.clientId)
    this.connection = connection
    connection.onEvent((params) => {
      if (typeof params.seq === "number") this.lastSeq[params.topic] = params.seq
      if (this.early) this.early.push(params)
      for (const listener of this.listeners) listener(params)
    })
    connection.onClose(() => {
      this.connection = undefined
      if (!this.stopped) void this.reconnect()
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
