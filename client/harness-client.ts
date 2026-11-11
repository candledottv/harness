// The Candle Harness client for code bots. MIT licence, as the Candle Harness. One file, no dependencies: it runs
// under Bun or Node 20 and later.
//
// A code bot trades only through the Harness's core, with its bot token, never a key. The core holds every trade to
// the figures the person approved on the bot's card (a trade's, a day's, open at most), its wallet's setting, its
// agent's limits and the kill switch. The bot's mode, wallet and slippage are its card's: a request never names them.
//
//   import { HarnessClient } from "./harness-client"
//   const harness = await HarnessClient.connect()   // the socket and token the Harness gave it
//   const bought = await harness.buy({ mint, amountUsd: 2 })
//   if (bought.state === "filled") console.log(bought.fill)
//   await harness.sell({ position: bought.position ?? "", percent: 50 })
//
// - Run by the Harness, a bot finds its socket and token in CANDLE_HARNESS_SOCKET and CANDLE_HARNESS_BOT_TOKEN. Run
//   elsewhere (launchd, tmux, a debugger), it reads them from `.harness-bot.json` in the folder it runs from, which
//   `candle-harness bots token <name>` writes, readable by its owner alone.
// - Each trade carries its own request id, made here. An answer lost to a dropped connection is asked again under
//   the same id once the client reconnects, so the core never sends it twice: it answers what became of it.
// - While it isn't connected it refuses to trade (`NotConnected`), and reconnects on its own, from 0.5 s to 30 s apart.
// - A buy or swap on a wallet that asks every time waits for the person's press: by default the call waits for how
//   it ended (up to 90 s), and `wait: false` answers at once with "waiting".
// - A buy may carry `exits` the core holds on the position it opens (a take profit, a stop, a max hold, a trailing
//   stop), and `setExits` sets, changes or clears them later. The core watches them while the bot is paused, crashed or
//   not connected, and through the kill switch: a crash never leaves a position unwatched. `on("exit", …)` hears each
//   one fire and how its sell ended.
// - `on("state" | "kill" | "stopping" | "request" | "exit" | "exits", …)` hears what happens to the bot. Hacc's tape
//   comes by `signals`.
// - `report({ status, health, alerts, rules, counts, events, controls })` says what the bot is doing, shown on the
//   Bots tab as "the bot says". `controls` offers the person up to 4 chips: a pause, or figures of its card to set. Its P&L, positions and fills are never its report's: the core counts them from its own fills.
// - `event(word, text)` says one word and a line ("needs-a-look", "spread above 8%"): a trigger set as
//   `on bot "<name>" says "<word>"` fires on it, to notify the person or wake an agent for judgment. One of a word
//   every 10 s, and 30 a minute.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createConnection, type Socket } from "node:net"

export const PROTOCOL = "2.0"

export type RequestState = "pending" | "waiting" | "sent" | "filled" | "refused" | "rejected" | "withdrawn" | "expired" | "failed" | "lost"

export interface Fill {
  side: "buy" | "sell" | "swap"
  mint?: string
  tokens?: string
  asset?: string
  assetAmount?: string
  usd?: number
  at: string
}

/** What became of a trade the bot asked for. */
export interface TradeAnswer {
  request: string
  side: "buy" | "sell" | "swap"
  state: RequestState
  /** What happened, in words. */
  words: string
  code?: string
  mint?: string
  usd?: number
  /** A buy's: the position it opened, once it filled (the id `positions()` and `sell()` take). A sell's: the position it sells. */
  position?: string
  cardId?: string
  fill?: Fill
}

/**
 * Exits the core holds on a position, in a strategy definition's exit shape: at least one. Percents are of what the
 * position cost per token, Candle's fee in it; a trailing stop arms once the price reaches `arm_multiple` × that, then
 * sells on a fall of `drop_pct` from the highest since.
 */
export interface Exits {
  take_profit_pct?: number
  stop_loss_pct?: number
  max_hold_hours?: number
  trailing?: { arm_multiple: number; drop_pct: number }
}

/** How an exit the core held went: deciding to sell, waiting, sold, or ended with nothing sold. */
export type ExitState = "selling" | "waiting" | "held" | "sold" | "failed" | "refused" | "rejected" | "withdrawn" | "expired" | "lost" | "left"

export interface Position {
  id: string
  mint: string
  /** The chain it was bought on. */
  chain: "solana" | "hood"
  symbol?: string
  mode: "paper" | "live"
  wallet: string
  tokens?: string
  tokensLeft?: string
  costUsd?: number
  entryPriceUsd?: number
  entryAt: string
  sells: number
  /** The exits the core holds on it, and who set them; null when its own code sells it. */
  exits: (Exits & { by: "buy" | "bot" | "person" }) | null
  /** One of those exits is selling it now. */
  exiting?: true
}

export type Told =
  | ({ kind: "request" } & TradeAnswer)
  | { kind: "state"; state: "on" | "paused" | "stopped"; buys: boolean; sells: boolean; words?: string; held?: { code: string; words: string } }
  | { kind: "kill"; paused: boolean; words: string }
  | { kind: "stopping"; words: string }
  /** An exit the core held: `reason` is stop_loss, take_profit, trailing_stop or max_hold. Failed sells are tried again. */
  | { kind: "exit"; position: string; mint: string; state: ExitState; reason?: string; words: string; fill?: Fill }
  /** The person removed the exits the core held on a position. */
  | { kind: "exits"; position: string; mint: string; exits: null; by: "person"; words: string }

/** What a bot says about itself. Each field sent replaces that field; one left out keeps what it said before. */
export interface Report {
  /** What it's doing now, in a line (120 characters at most). */
  status?: string
  health?: "ok" | "warn" | "error"
  /** Up to 8, each a line or `{ code, text }`. */
  alerts?: (string | { code?: string; text: string })[]
  /** How it trades, in words, up to 8 lines. */
  rules?: string[]
  /** Up to 12 named numbers, such as `{ watching: 14, "quotes failing": 2 }`. Never its P&L or positions. */
  counts?: Record<string, number>
  /** Added to what it said before, up to 50 a report. An `id` sent again is kept once. `at` is ISO text or unix seconds. */
  events?: { kind: "considered" | "entered" | "skipped" | "exited" | "alert" | "note"; text: string; id?: string; at?: string | number; mint?: string }[]
  /**
   * Up to 4 chips it offers the person on the Bots tab, each with its own `id` and a `label` (40 characters at most):
   * `pause: true`, or `set` with one or more of its card's figures. The person's click pauses it or lowers a figure
   * at once; anything that raises one is a card for them. An empty list clears them.
   */
  controls?: ({ id: string; label: string; pause: true } | { id: string; label: string; set: { perTradeUsd?: number; perDayUsd?: number; maxOpen?: number; maxSlippageBps?: number } })[]
}

/** The core refused a call, with its code and words. Nothing was sent for a trade it refused. */
export class HarnessRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "HarnessRefused"
  }
}

/** The client isn't connected to the core: nothing was sent. */
export class NotConnected extends Error {
  constructor(message = "Not connected to the Candle Harness's core, so nothing was sent.") {
    super(message)
    this.name = "NotConnected"
  }
}

/** A trade asked before the connection dropped, whose answer the core never gave back in time: ask `request(id)` later. */
export class AnswerLost extends Error {
  constructor(readonly request: string) {
    super(`The answer to request ${request} was lost with the connection. Ask request("${request}") once connected: the core never sends one id twice.`)
    this.name = "AnswerLost"
  }
}

export interface ClientOptions {
  /** The core's socket; `CANDLE_HARNESS_SOCKET` when unset. */
  socket?: string
  /** The bot's token; `CANDLE_HARNESS_BOT_TOKEN` when unset. */
  token?: string
  /** Where a bot run elsewhere reads both: `CANDLE_HARNESS_BOT_FILE`, else `.harness-bot.json` in the folder it runs from. */
  file?: string
  /** How long a trade's lost answer waits for the connection to come back before `AnswerLost`; 2 minutes. */
  lostAnswerMs?: number
}

type Pending = { method: string; params: Record<string, unknown>; resolve(v: unknown): void; reject(e: unknown): void; sent: boolean; lostTimer?: ReturnType<typeof setTimeout> }
type Listener = (told: Told) => void
type Kind = Told["kind"]

const TERMINAL: ReadonlySet<RequestState> = new Set(["filled", "refused", "rejected", "withdrawn", "expired", "failed", "lost"])
const TRADES = new Set(["bot.buy", "bot.sell", "bot.swap"])
/** Answers that mean this token won't ever connect: the client stops trying. */
const FINAL = new Set(["UNAUTHENTICATED", "PROTOCOL_MISMATCH"])

/** The file `candle-harness bots token <name>` writes in the bot's folder, for a bot run elsewhere. */
export const BOT_TOKEN_FILE = ".harness-bot.json"

/** The socket and token from a bot's token file, or nothing where there's none. */
function readTokenFile(path: string): { socket?: string; token?: string } | undefined {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  const v = JSON.parse(text) as { socket?: unknown; token?: unknown }
  return { ...(typeof v.socket === "string" ? { socket: v.socket } : {}), ...(typeof v.token === "string" ? { token: v.token } : {}) }
}

/** A new request id: the bot's own, for one trade. */
export const newRequestId = (): string => `req_${randomBytes(12).toString("base64url")}`

export class HarnessClient {
  private socket: Socket | undefined
  private connected = false
  private closed = false
  private nextId = 1
  private buffer = ""
  private backoff = 500
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<Kind, Set<Listener>>()
  private readonly signalHandlers = new Set<(rows: unknown) => void>()
  private readonly waiters = new Map<string, Set<(a: TradeAnswer) => void>>()
  private hello: { agent: string; bot: string } | undefined
  /** Why it stopped trying, when the core said it never will connect. */
  refusedWith: HarnessRefused | undefined

  private constructor(private readonly opts: Required<Pick<ClientOptions, "socket" | "token" | "lostAnswerMs">>) {}

  /** Connects and says hello. Throws `HarnessRefused` when the core refuses this token. */
  static async connect(options: ClientOptions = {}): Promise<HarnessClient> {
    let socket = options.socket ?? process.env.CANDLE_HARNESS_SOCKET
    let token = options.token ?? process.env.CANDLE_HARNESS_BOT_TOKEN
    if (!socket || !token) {
      const saved = readTokenFile(options.file ?? process.env.CANDLE_HARNESS_BOT_FILE ?? BOT_TOKEN_FILE)
      socket ??= saved?.socket
      token ??= saved?.token
    }
    if (!socket) throw new Error("No socket: run the bot from the Candle Harness, or run `candle-harness bots token <name>` and run it from its folder.")
    if (!token) throw new Error("No bot token: run the bot from the Candle Harness, or run `candle-harness bots token <name>` and run it from its folder.")
    const client = new HarnessClient({ socket, token, lostAnswerMs: options.lostAnswerMs ?? 120_000 })
    await client.open()
    return client
  }

  /** Whether it's connected now: it trades only while it is. */
  get isConnected(): boolean {
    return this.connected
  }

  /** The bot's name and agent, from its hello. */
  get who(): { agent: string; bot: string } | undefined {
    return this.hello
  }

  /**
   * Buys a token, in dollars. `chain` is the token's chain where it names one ("solana", "hood"): the core checks the
   * address can be on it, and that the bot's wallet pays there. Left out, the address's own. Waits for how it ended
   * unless `wait: false`.
   */
  buy(p: { mint: string; amountUsd: number; chain?: "solana" | "hood"; exits?: Exits; request?: string }, o: { wait?: boolean; waitMs?: number } = {}): Promise<TradeAnswer> {
    return this.trade("bot.buy", { request: p.request ?? newRequestId(), mint: p.mint, amountUsd: p.amountUsd, ...(p.chain ? { chain: p.chain } : {}), ...(p.exits ? { exits: p.exits } : {}) }, o)
  }

  /** Sets or changes the exits the core holds on one of its positions (by id, or its oldest in a token); null clears them. */
  setExits(p: { position?: string; mint?: string }, exits: Exits | null): Promise<{ position: string; exits: Exits | null; words: string }> {
    return this.call("bot.exits", { ...(p.position ? { position: p.position } : {}), ...(p.mint ? { mint: p.mint } : {}), exits }) as never
  }

  /** Sells its own: a position by id, or its oldest in a token; all of it, a percent of it, or an amount of tokens. */
  sell(p: { position?: string; mint?: string; percent?: number; amount?: string; request?: string }, o: { wait?: boolean; waitMs?: number } = {}): Promise<TradeAnswer> {
    const params: Record<string, unknown> = { request: p.request ?? newRequestId() }
    for (const k of ["position", "mint", "percent", "amount"] as const) if (p[k] !== undefined) params[k] = p[k]
    return this.trade("bot.sell", params, o)
  }

  /** Swaps between two base assets (SOL, USDC, CNDL, ETH, USDG): live only. */
  swap(p: { from: string; to: string; amount: string; request?: string }, o: { wait?: boolean; waitMs?: number } = {}): Promise<TradeAnswer> {
    return this.trade("bot.swap", { request: p.request ?? newRequestId(), from: p.from, to: p.to, amount: p.amount }, o)
  }

  /**
   * What became of a request, by its id: "unknown" when the core never got it, so nothing was sent; "ended" when it
   * ended before today and the core keeps only its id, so it may have filled (the Journal has it).
   */
  request(id: string): Promise<TradeAnswer | { request: string; state: "unknown" | "ended"; words: string }> {
    return this.call("bot.request", { request: id }) as never
  }

  /** Its settings and state, and the figures the core holds it to. */
  self(): Promise<Record<string, unknown>> {
    return this.call("bot.self", {}) as never
  }

  /** Its open positions, from the core's count of its own fills. */
  positions(): Promise<{ positions: Position[]; totals: Record<string, unknown> }> {
    return this.call("bot.positions", {}) as never
  }

  /** Its fills, newest first. */
  fills(limit = 50): Promise<{ fills: (Fill & { request?: string; position?: string; exit?: string })[] }> {
    return this.call("bot.fills", { limit }) as never
  }

  /** Candle's market read for a token: its price, market cap and more. */
  market(mint: string, chain?: "solana" | "hood"): Promise<{ market: Record<string, unknown> }> {
    return this.call("bot.market", { mint, ...(chain ? { chain } : {}) }) as never
  }

  /** One of Hacc's reads its agent's plan offers: `hacc("hacc_token", { view: "overview", address })`. */
  hacc(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call("bot.hacc", { ...args, tool })
  }

  /** Says what it's doing, on the Bots tab as "the bot says". Refused whole (`INVALID_PARAMS`, `REPORT_FIGURES`) when any of it doesn't fit. */
  report(r: Report): Promise<{ at: string; events: number }> {
    return this.call("bot.report", { ...r }) as never
  }

  /**
   * Says one word and a line, which a trigger set as `on bot "<name>" says "<word>"` waits on. The word is lowercase
   * letters, digits and dashes, up to 24; the line up to 200 characters. Refused (`TOO_SOON`, `TOO_MANY`) past one of
   * a word every 10 s or 30 a minute.
   */
  event(word: string, text?: string): Promise<{ word: string; at: string }> {
    return this.call("bot.event", { word, ...(text !== undefined ? { text } : {}) }) as never
  }

  /** Hacc's tape as it arrives (Pro and Max), optionally one pattern or chain. */
  async signals(handler: (rows: unknown) => void, filter?: { pattern?: string[]; chain?: string[] }): Promise<void> {
    this.signalHandlers.add(handler)
    await this.call("subscribe", { topics: ["signals"], ...(filter ? { filters: { signals: filter } } : {}) })
  }

  /** Hears what happens to the bot. Returns a function that stops listening. */
  on(kind: Kind, listener: Listener): () => void {
    let set = this.listeners.get(kind)
    if (!set) this.listeners.set(kind, (set = new Set()))
    set.add(listener)
    return () => set!.delete(listener)
  }

  close(): void {
    this.closed = true
    this.socket?.end()
    for (const [id, p] of this.pending) {
      if (p.lostTimer) clearTimeout(p.lostTimer)
      p.reject(new NotConnected("The client was closed."))
      this.pending.delete(id)
    }
  }

  private async trade(method: string, params: Record<string, unknown>, o: { wait?: boolean; waitMs?: number }): Promise<TradeAnswer> {
    if (!this.connected) throw new NotConnected()
    const id = String(params.request)
    // Told before the answer can come back: an outcome that arrives first isn't missed.
    let last: TradeAnswer | undefined
    const done = new Promise<TradeAnswer>((resolve) => {
      const set = this.waiters.get(id) ?? new Set()
      this.waiters.set(id, set)
      set.add((a) => {
        last = a
        if (TERMINAL.has(a.state)) resolve(a)
      })
    })
    try {
      const answer = (await this.call(method, params)) as TradeAnswer
      if (o.wait === false || TERMINAL.has(answer.state)) return answer
      if (last && TERMINAL.has(last.state)) return last
      const waitMs = o.waitMs ?? 90_000
      const timeout = new Promise<TradeAnswer>((resolve) => {
        const t = setTimeout(async () => {
          // Asked once more, in case a told outcome was missed with a reconnect.
          const now = await this.request(id).catch(() => undefined)
          resolve(now && now.state !== "unknown" ? (now as TradeAnswer) : (last ?? answer))
        }, waitMs)
        t.unref?.()
      })
      return await Promise.race([done, timeout])
    } finally {
      this.waiters.delete(id)
    }
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) return Promise.reject(new NotConnected())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, params, resolve, reject, sent: false })
      this.send(id)
    })
  }

  private send(id: number): void {
    const p = this.pending.get(id)
    if (!p || !this.socket || !this.connected) return
    p.sent = true
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: p.method, params: p.params })}\n`)
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.opts.socket)
      this.socket = socket
      this.buffer = ""
      let settled = false
      const settle = (error?: unknown) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "core.hello", params: { protocol: PROTOCOL, token: this.opts.token, clientName: "code bot" } })}\n`)
      })
      socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8")
        for (;;) {
          const nl = this.buffer.indexOf("\n")
          if (nl === -1) break
          const line = this.buffer.slice(0, nl)
          this.buffer = this.buffer.slice(nl + 1)
          if (!line.trim()) continue
          let message: Record<string, unknown>
          try {
            message = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (message.id === 0) {
            const error = message.error as { message?: string; data?: { code?: string } & Record<string, unknown> } | undefined
            if (error) {
              const refusedWith = new HarnessRefused(error.data?.code ?? "REFUSED", error.message ?? "The core refused this bot.", error.data ?? {})
              if (FINAL.has(refusedWith.code)) {
                this.refusedWith = refusedWith
                this.closed = true
              }
              settle(refusedWith)
              socket.destroy()
              continue
            }
            const r = message.result as { agent: string; bot: string }
            this.hello = { agent: r.agent, bot: r.bot }
            this.connected = true
            this.backoff = 500
            // Calls whose answers the drop lost, asked again under the same ids: the core never sends one twice.
            for (const [id, p] of this.pending) {
              if (p.lostTimer) clearTimeout(p.lostTimer)
              delete p.lostTimer
              this.send(id)
            }
            // What it's told goes to its own connection, subscribed again after a reconnect: connected once that's answered.
            this.call("subscribe", { topics: ["bot"] }).then(
              () => settle(),
              (error) => settle(error),
            )
            continue
          }
          this.onMessage(message)
        }
      })
      socket.on("error", (error) => settle(error))
      socket.on("close", () => {
        const was = this.connected
        this.connected = false
        settle(new NotConnected())
        if (this.closed) return
        if (was || this.hello) this.lose()
        const wait = this.backoff
        this.backoff = Math.min(30_000, this.backoff * 2)
        const t = setTimeout(() => void this.open().catch(() => {}), wait)
        t.unref?.()
      })
    })
  }

  /** The connection dropped: a trade's call waits for it to come back, under the same id; anything else is refused. */
  private lose(): void {
    for (const [id, p] of this.pending) {
      if (TRADES.has(p.method)) {
        p.lostTimer ??= setTimeout(() => {
          this.pending.delete(id)
          p.reject(new AnswerLost(String(p.params.request)))
        }, this.opts.lostAnswerMs)
        continue
      }
      this.pending.delete(id)
      p.reject(new NotConnected("The connection dropped before the core answered."))
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message.method === "event") {
      const e = message.params as { topic: string; data: unknown; snapshot?: boolean }
      if (e.topic === "signals") for (const h of this.signalHandlers) h(e.data)
      if (e.topic !== "bot" || !e.data) return
      const data = e.data as Record<string, unknown>
      if (data.kind === "snapshot") {
        if (data.state) this.emit(data.state as Told)
        for (const r of (data.open as TradeAnswer[] | undefined) ?? []) this.emit({ kind: "request", ...r })
        return
      }
      this.emit(data as Told)
      return
    }
    if (typeof message.id !== "number") return
    const p = this.pending.get(message.id)
    if (!p) return
    this.pending.delete(message.id)
    if (p.lostTimer) clearTimeout(p.lostTimer)
    const error = message.error as { message?: string; data?: { code?: string } & Record<string, unknown> } | undefined
    if (error) p.reject(new HarnessRefused(error.data?.code ?? "REFUSED", error.message ?? "The core refused it.", error.data ?? {}))
    else p.resolve(message.result)
  }

  private emit(told: Told): void {
    if (told.kind === "request") for (const w of this.waiters.get(told.request) ?? []) w(told)
    for (const l of this.listeners.get(told.kind) ?? []) l(told)
  }
}
