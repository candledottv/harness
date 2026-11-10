// The attach protocol, 2.0: the core's local socket and the
// methods views and harnesses call on it.
//
// Transport: a Unix socket at `state/core.sock`, mode 0600, in the 0700 state folder, so another user
// can't reach it. JSON-RPC 2.0, one message per line, 1 MiB at most.
//
// Authentication: the first message must be `core.hello {protocol, token, clientName, harnessKind?}`.
// The token decides the role (tokens.ts). A different protocol major is PROTOCOL_MISMATCH; an unknown
// token, or any other method first, is UNAUTHENTICATED. Either closes the connection. Every view hello
// rotates the view token.
//
// Roles: METHOD_ROLES is the single copy of the table. A call outside the caller's column is
// `-32001 FORBIDDEN_FOR_ROLE`, journalled. No method returns a key or a stored token, and every
// outgoing message passes the redactor first, with these exceptions, each once, to the one that asked:
// `harness.register`'s new token, to the view; `pane.redeem`'s agent key, to the prompt pane's launcher;
// `build.open`'s new token, to the main view that puts it in a Build pane's environment; and `build.test`'s test
// token, to the Build pane that runs the test. Each is carried as a WithSecret, sent only to the role it names.
//
// The bot role: a code bot's token (`chb_`), bound to the bot and its agent. It's refused at hello where the bot
// isn't approved here, or the plan is Free. The build role: a Build pane's token (`chd_`), bound to its agent.
//
// The pane role: the launcher's hello carries a single-use ticket instead of a token
// (tickets.ts), and it's accepted only from the process the approving view named, by the socket's
// peer pid. A pane may call only `pane.redeem` and `pane.report`, and its connection ends after the
// report.
//
// No card is refused for want of a view: cards live 60 s either way.
import { randomBytes } from "node:crypto"
import { chmod } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { peerPid } from "../shared/peer-pid"
import { terminalText } from "../shared/terminal-text"
import type { Redactor } from "../shared/redact"
import {
  encodeLine,
  invalidParams,
  LineDecoder,
  PROTOCOL_VERSION,
  protocolMajor,
  MAX_UNREAD_BYTES,
  MessageTooLarge,
  RPC_FORBIDDEN_FOR_ROLE,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RpcError,
  type RpcErrorBody,
  type RpcId,
  refused,
} from "../shared/rpc"
import type { Mode } from "./classify"
import { EventHub, type Subscriber, topicAllowed } from "./events"
import type { Journal } from "./journal"
import type { PaneTickets } from "./tickets"
import { cleanName, type Role, type TokenBook } from "./tokens"

/** `yes`: may call. `own`: may call, scoped to its own cards, operations or topics. `no`: refused. */
export type Access = "yes" | "own" | "no"

/**
 * The method table. Methods not listed here don't exist. A pane, a code bot and a Build pane may call only what
 * names their role: a role a method leaves out is refused.
 */
export const METHOD_ROLES: Readonly<Record<string, { view: Access; harness: Access; pane?: Access; bot?: Access; build?: Access }>> = {
  "core.hello": { view: "yes", harness: "yes", pane: "yes", bot: "yes", build: "yes" },
  // A code bot reads its own settings and state: never another bot's, an agent's or the person's.
  "bot.self": { view: "no", harness: "no", bot: "own" },
  // A code bot's trades, each with its own request id, as the core's own proposal with its card's run settings; what
  // became of one by its id; its own book from the core's count; Candle's market read; Hacc's reads its agent's plan
  // offers. Never another bot's or agent's.
  "bot.buy": { view: "no", harness: "no", bot: "own" },
  "bot.sell": { view: "no", harness: "no", bot: "own" },
  "bot.swap": { view: "no", harness: "no", bot: "own" },
  "bot.request": { view: "no", harness: "no", bot: "own" },
  "bot.positions": { view: "no", harness: "no", bot: "own" },
  "bot.fills": { view: "no", harness: "no", bot: "own" },
  "bot.market": { view: "no", harness: "no", bot: "own" },
  "bot.hacc": { view: "no", harness: "no", bot: "own" },
  // A code bot's own report about itself (its status, health, alerts, rules in words, counts and events): kept beside the
  // core's count, never in place of it. Only its own.
  "bot.report": { view: "no", harness: "no", bot: "own" },
  // What a code bot says, one word and a line: a trigger on its word fires. Only its own.
  "bot.event": { view: "no", harness: "no", bot: "own" },
  // Exits the core holds on one of its own positions: set, changed or cleared by the bot, and watched by the core.
  "bot.exits": { view: "no", harness: "no", bot: "own" },
  // A Build pane proposes a code bot for its agent, as a card the person approves in the main view.
  "bots.proposeCode": { view: "no", harness: "no", build: "own" },
  // A Build pane's own reads and paper tests, by its token (`candle-harness build …`): every bot's book, a code bot's
  // log, its agent's own record, and a paper test run of a bot's code that ends with the pane. It approves, trades and
  // changes nothing. The main view opens a pane's token and closes it.
  "build.open": { view: "yes", harness: "no" },
  "build.close": { view: "yes", harness: "no" },
  // The Build pane's folder and harness, as last picked: read by any view, set by the main view's pane.
  "build.prefs": { view: "yes", harness: "no" },
  "build.endTest": { view: "yes", harness: "no" },
  // The person's stop of a paper test their own Build pane started, from the test box.
  "build.books": { view: "no", harness: "no", build: "own" },
  "build.logs": { view: "no", harness: "no", build: "own" },
  "build.journal": { view: "no", harness: "no", build: "own" },
  "build.test": { view: "no", harness: "no", build: "own" },
  "build.testEnd": { view: "no", harness: "no", build: "own" },
  // Every agent's limits, spend and wallets: the person's. An agent reads its own through harness_limits and harness_pnl.
  "core.status": { view: "yes", harness: "no" },
  "core.usage": { view: "yes", harness: "no" },
  // Stopping the core: the person's, from `candle-harness stop` with the view token. No agent stops it.
  "core.stop": { view: "yes", harness: "no" },
  // Keep-awake (macOS): the person's setting, from the main view.
  "core.keepAwake": { view: "yes", harness: "no" },
  "tools.list": { view: "yes", harness: "yes" },
  "tools.call": { view: "yes", harness: "yes" },
  "cards.propose": { view: "yes", harness: "yes" },
  "cards.list": { view: "yes", harness: "own" },
  "cards.get": { view: "yes", harness: "own" },
  "cards.approve": { view: "yes", harness: "no" },
  "cards.reject": { view: "yes", harness: "no" },
  "cards.withdraw": { view: "own", harness: "own" },
  "cards.requote": { view: "yes", harness: "no" },
  "operations.list": { view: "yes", harness: "own" },
  "operations.get": { view: "yes", harness: "own" },
  "operations.resolve": { view: "yes", harness: "no" },
  "mode.set": { view: "yes", harness: "no" },
  "wallets.show": { view: "yes", harness: "no" },
  // Naming wallets: the person's, from a view. The agent names them through harness_name_wallets.
  "wallets.name": { view: "yes", harness: "no" },
  "wallets.undo": { view: "yes", harness: "no" },
  // Wallet groups: the person's, from a view. The agent groups them through harness_group_wallets.
  "wallets.group": { view: "yes", harness: "no" },
  "vault.forget": { view: "yes", harness: "no" },
  // Onboarding: the person's, from a view.
  "onboarding.get": { view: "yes", harness: "no" },
  "onboarding.set": { view: "yes", harness: "no" },
  // Onboarding's sign-ins and test message: the person's, from the main view only.
  "onboarding.signIn": { view: "yes", harness: "no" },
  "onboarding.harness": { view: "yes", harness: "no" },
  "onboarding.test": { view: "yes", harness: "no" },
  // Onboarding step 3's limits and "fund it later": the person's, from the main view only.
  "onboarding.limits": { view: "yes", harness: "no" },
  "onboarding.fundLater": { view: "yes", harness: "no" },
  // Autonomy per wallet is the person's: no agent widens its own leash. It narrows on a card.
  "autonomy.set": { view: "yes", harness: "no" },
  // Triggers: saved only by approving a trigger's card. Off and removal from any view; back on from the main view.
  // The agent reads and switches them through harness_triggers. Fired from outside by the person's own view token.
  "triggers.list": { view: "yes", harness: "no" },
  "triggers.set": { view: "yes", harness: "no" },
  "triggers.remove": { view: "yes", harness: "no" },
  "triggers.fire": { view: "yes", harness: "no" },
  "triggers.runNow": { view: "yes", harness: "no" },
  // Bots: made, widened or taken live only by approving a bot's card. Paused or narrowed from any view; stopped,
  // put back on, flattened and removed from the main view. The agent reads, pauses and narrows through its tool.
  "bots.list": { view: "yes", harness: "no" },
  "bots.pause": { view: "yes", harness: "no" },
  "bots.narrow": { view: "yes", harness: "no" },
  "bots.stop": { view: "yes", harness: "no" },
  "bots.resume": { view: "yes", harness: "no" },
  "bots.flatten": { view: "yes", harness: "no" },
  "bots.retry": { view: "yes", harness: "no" },
  "bots.remove": { view: "yes", harness: "no" },
  "bots.exits.remove": { view: "yes", harness: "no" },
  "bots.control": { view: "yes", harness: "no" },
  // A code bot's process, the supervisor's: started, stopped (the bot stays on) and started again; its token written to a
  // 0600 file in its folder for running it elsewhere; and its log.
  "bots.process.start": { view: "yes", harness: "no" },
  "bots.process.stop": { view: "yes", harness: "no" },
  "bots.process.restart": { view: "yes", harness: "no" },
  "bots.token": { view: "yes", harness: "no" },
  "bots.logs": { view: "yes", harness: "no" },
  // The linked token and the pins are the person's picks; the agent moves the link by showing a token.
  "view.link": { view: "yes", harness: "no" },
  "view.pin": { view: "yes", harness: "no" },
  "view.unpin": { view: "yes", harness: "no" },
  // What a tab's Signals pane shows: the person's choice, kept by the tab as a pin is.
  "view.signals": { view: "yes", harness: "no" },
  // A popped view says which pane it shows; it's the view's own, held by its connection.
  "view.pop": { view: "yes", harness: "no" },
  "view.active": { view: "yes", harness: "no" },
  "view.answer": { view: "yes", harness: "no" },
  "view.note": { view: "yes", harness: "no" },
  "view.set": { view: "yes", harness: "no" },
  "view.repin": { view: "yes", harness: "no" },
  // Undoing a Hacc change is the person's click on Activity, never the agent's.
  "hacc.undo": { view: "yes", harness: "no" },
  // The P&L window is the person's setting; the agent reads its figure with harness_pnl, and may pass its own since.
  "pnl.window": { view: "yes", harness: "no" },
  "pnl.series": { view: "yes", harness: "no" },
  // The Journal: the whole record, the person's; an agent reads its own with harness_history.
  "journal.query": { view: "yes", harness: "no" },
  "journal.rows": { view: "yes", harness: "no" },
  // While you were away: the person's record of the gap; the agent reads its own with harness_history.
  "away.get": { view: "yes", harness: "no" },
  "agent.setActive": { view: "yes", harness: "no" },
  kill: { view: "yes", harness: "no" },
  resume: { view: "yes", harness: "no" },
  "agent.send": { view: "yes", harness: "no" },
  "agent.cancel": { view: "yes", harness: "no" },
  // Each agent's engine is the person's choice: it spends their subscription or credit.
  "engine.models": { view: "yes", harness: "no" },
  // A harness installed while onboarding is open: checked again only when its last check failed.
  "engine.check": { view: "yes", harness: "no" },
  "engine.choose": { view: "yes", harness: "no" },
  // So is its preset, Quant or Trader.
  "preset.choose": { view: "yes", harness: "no" },
  "agent.run": { view: "yes", harness: "no" },
  // The agent's memory is its own to write, with its file tools; deleting from it is the person's.
  "memory.read": { view: "yes", harness: "no" },
  "memory.delete": { view: "yes", harness: "no" },
  "memory.pin": { view: "yes", harness: "no" },
  // Skill folders of the person's own: which are used is the person's choice, from the main view.
  "skills.read": { view: "yes", harness: "no" },
  "skills.set": { view: "yes", harness: "no" },
  "cli.run": { view: "yes", harness: "no" },
  "harness.register": { view: "yes", harness: "no" },
  "pane.spawned": { view: "yes", harness: "no" },
  "pane.redeem": { view: "no", harness: "no", pane: "yes" },
  "pane.report": { view: "no", harness: "no", pane: "yes" },
  // A code bot subscribes to what's told to it alone (`bot`) and to Hacc's tape (`signals`).
  subscribe: { view: "yes", harness: "own", bot: "own" },
  unsubscribe: { view: "yes", harness: "own", bot: "own" },
}

const HELLO_TIMEOUT_MS = 10_000

/** An answer carrying a secret for a pane connection only (`pane.redeem`'s agent key). The value is redacted as usual; `secret` is added after. */
export class WithSecret {
  constructor(
    readonly value: Record<string, unknown>,
    readonly secret: Record<string, string>,
    /** Who may be sent the secret: the prompt pane's launcher, unless another role is named. */
    readonly to: Role = "pane",
  ) {}
}

/** Whose access column a client's role reads. A role a method doesn't name is refused. */
export function accessFor(method: string, role: Role): Access {
  const roles = Object.hasOwn(METHOD_ROLES, method) ? METHOD_ROLES[method]! : undefined
  return roles?.[role] ?? "no"
}

export interface ClientInfo {
  clientId: string
  role: Role
  clientName: string
  harnessKind?: string
  tokenId?: string
  /** A harness acts as the agent its turn was started for; a bot and a Build pane as theirs. */
  agent?: string
  /** A code bot: its name. */
  bot?: string
  /** A pane: the ticket it said hello with, by id. */
  ticketId?: string
  connectedAt: string
}

export interface CallContext {
  client: ClientInfo
  /** `own` when the caller's column says so: the handler must scope to `client.clientId`. */
  access: Access
  /** The agent this call acts as: the harness's own, or the active agent for a view. */
  agent: string
  server: CoreServer
}

export type Handler = (params: Record<string, unknown>, call: CallContext) => Promise<unknown>

/** What a hello returns about the core, besides the protocol and the client's own id and role. */
export interface CoreIdentity {
  /** Random per core start, so a reconnecting view knows a restarted core's seqs start again. */
  coreId: string
  account: string
  agents: string[]
  activeAgent: string
  mode: Mode
  paused: boolean
}

interface Connection {
  socket: Socket
  client?: ClientInfo
  helloTimer?: ReturnType<typeof setTimeout>
}

export class CoreServer {
  readonly events = new EventHub()
  private readonly handlers = new Map<string, Handler>()
  private readonly connections = new Map<string, Connection>()
  private server: Server | undefined
  private readonly viewListeners: ((count: number) => void)[] = []
  private readonly paneListeners: ((ticketId: string) => void)[] = []
  private readonly detachListeners: ((client: ClientInfo) => void)[] = []
  private readonly attachListeners: ((client: ClientInfo) => void)[] = []

  constructor(
    private readonly options: {
      socketPath: string
      coreVersion: string
      journal: Journal
      redactor: Redactor
      tokens: TokenBook
      /** The prompt pane's tickets; without them a ticket hello is refused. */
      tickets?: PaneTickets
      /** Whether a code bot may say hello now: undefined when it may, else the refusal. Without it, no bot connects. */
      admitBot?: (bot: string) => { code: string; message: string } | undefined
      now: () => number
      identity: () => CoreIdentity
    },
  ) {
    this.registerBuiltins()
  }

  /** Registers the handler for a method in METHOD_ROLES. A permitted call with no handler is METHOD_NOT_AVAILABLE. */
  handle(method: string, handler: Handler): void {
    if (!Object.hasOwn(METHOD_ROLES, method) || method === "core.hello") throw new Error(`Not an attach-protocol method: ${method}`)
    this.handlers.set(method, handler)
  }

  onViewCount(listener: (count: number) => void): void {
    this.viewListeners.push(listener)
  }

  /** Called when a pane connection ends, reported or not. */
  onPaneClosed(listener: (ticketId: string) => void): void {
    this.paneListeners.push(listener)
  }

  /** Called when a view or harness has said hello, once it's counted and journalled (not a pane). */
  onAttached(listener: (client: ClientInfo) => void): void {
    this.attachListeners.push(listener)
  }

  /** Called when any client that said hello goes, after it's no longer counted. */
  onDetached(listener: (client: ClientInfo) => void): void {
    this.detachListeners.push(listener)
  }

  viewCount(): number {
    return this.clients().filter((client) => client.role === "view").length
  }

  clients(): ClientInfo[] {
    return [...this.connections.values()].flatMap((connection) => (connection.client ? [{ ...connection.client }] : []))
  }

  /** Listens at the socket path. The caller holds the instance lock and has cleared a stale socket. */
  async listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.options.socketPath, () => {
        server.off("error", reject)
        resolve()
      })
    })
    await chmod(this.options.socketPath, 0o600)
    this.server = server
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.socket.destroy()
    this.connections.clear()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Disconnects every client attached with a token, when its turn or pane ends, or a bot's is revoked or replaced. */
  disconnectToken(tokenId: string): void {
    for (const connection of this.connections.values()) if (connection.client?.tokenId === tokenId) connection.socket.destroy()
  }

  private accept(socket: Socket): void {
    const connectionId = `c_${randomBytes(9).toString("base64url")}`
    const connection: Connection = { socket }
    this.connections.set(connectionId, connection)
    const decoder = new LineDecoder()
    connection.helloTimer = setTimeout(() => {
      if (connection.client === undefined) socket.destroy()
    }, HELLO_TIMEOUT_MS)
    connection.helloTimer.unref?.()
    let queue = Promise.resolve()
    socket.on("data", (chunk: Buffer) => {
      const { lines, oversized } = decoder.push(chunk)
      for (let i = 0; i < oversized; i++) {
        this.send(socket, { jsonrpc: "2.0", id: null, error: errorBody(RPC_INVALID_REQUEST, "MESSAGE_TOO_LARGE", "A message exceeded 1 MiB.") })
      }
      for (const line of lines) {
        const run = () => this.onLine(connectionId, connection, line)
        // Until the hello is answered, lines wait their turn. After it, each request runs as it
        // arrives (answers carry their ids), so one waiting on Candle, such as an approve whose call
        // hangs, never holds up the next one, such as the kill switch.
        queue = queue.then(() => (connection.client === undefined ? run() : void run()))
      }
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      if (connection.helloTimer) clearTimeout(connection.helloTimer)
      void queue.then(() => this.detach(connectionId))
    })
  }

  private async onLine(connectionId: string, connection: Connection, line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.send(connection.socket, { jsonrpc: "2.0", id: null, error: errorBody(RPC_PARSE_ERROR, "PARSE_ERROR", "Not valid JSON.") })
      return
    }
    const request = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    const id: RpcId = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null
    if (request === null || typeof request !== "object" || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      this.send(connection.socket, { jsonrpc: "2.0", id, error: errorBody(RPC_INVALID_REQUEST, "INVALID_REQUEST", "Not a JSON-RPC 2.0 request.") })
      return
    }
    // A notification from a client asks for nothing back, and no method is one.
    if (request.id === undefined) return
    const params = request.params === undefined ? {} : request.params
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      this.send(connection.socket, { jsonrpc: "2.0", id, error: invalidParams("params must be an object.").body() })
      return
    }
    try {
      const result =
        connection.client === undefined
          ? await this.hello(connectionId, connection, request.method, params as Record<string, unknown>)
          : await this.call(connection.client, request.method, params as Record<string, unknown>)
      if (result instanceof WithSecret) {
        // Only a pane is ever sent a secret; anyone else gets the value redacted, without it. The pane's
        // value is the exact command its launcher runs, so it goes unchanged: a keyed RPC address
        // (`?api-key=…`) redacted there would run the step against a broken RPC.
        if (connection.client?.role === "pane" && result.to === "pane") this.sendRaw(connection.socket, { jsonrpc: "2.0", id, result: { ...result.value, ...result.secret } })
        // A token for a view or a Build pane: the rest redacted as ever, the token added after.
        else if (connection.client?.role === result.to) this.sendRaw(connection.socket, { jsonrpc: "2.0", id, result: { ...(this.options.redactor.value(result.value) as Record<string, unknown>), ...result.secret } })
        else this.send(connection.socket, { jsonrpc: "2.0", id, result: this.options.redactor.value(result.value) })
      } else this.send(connection.socket, { jsonrpc: "2.0", id, result })
      // A pane's connection ends with its report.
      if (connection.client?.role === "pane" && request.method === "pane.report") connection.socket.end()
    } catch (error) {
      const body = error instanceof RpcError ? error.body() : errorBody(RPC_INTERNAL_ERROR, "INTERNAL", `The core failed: ${error instanceof Error ? error.message : String(error)}`)
      this.send(connection.socket, { jsonrpc: "2.0", id, error: body })
      if (error instanceof RpcError && error.closes) connection.socket.end()
    }
  }

  private async hello(connectionId: string, connection: Connection, method: string, params: Record<string, unknown>): Promise<unknown> {
    const mode = this.options.identity().mode
    if (method !== "core.hello") throw closing(refused("UNAUTHENTICATED", "Send core.hello first."))
    if (protocolMajor(params.protocol) !== protocolMajor(PROTOCOL_VERSION)) {
      throw closing(refused("PROTOCOL_MISMATCH", `This core speaks protocol ${PROTOCOL_VERSION}.`, { core: PROTOCOL_VERSION, client: typeof params.protocol === "string" ? params.protocol : null }))
    }
    if (typeof params.token === "string" && params.token.startsWith("chp_")) return this.paneHello(connectionId, connection, params.token, mode)
    const who = this.options.tokens.authenticate(params.token)
    if (who === undefined) {
      await this.options.journal.append({ type: "client.refused", mode, reason: "UNAUTHENTICATED" })
      throw closing(refused("UNAUTHENTICATED", "The token isn't one this core issued, or it's been replaced. A view reads the current one from view.token."))
    }
    if (who.role === "bot") {
      const no = this.options.admitBot ? this.options.admitBot(who.bot) : { code: "METHOD_NOT_AVAILABLE", message: "This core runs no code bots." }
      if (no) {
        await this.options.journal.append({ type: "client.refused", mode, reason: no.code, role: "bot", bot: who.bot })
        throw closing(refused(no.code, no.message))
      }
    }
    // A view's token is single-use: the next view reads the new one from view.token.
    if (who.role === "view") {
      try {
        await this.options.tokens.rotateViewToken()
      } catch {
        // The new token couldn't be written, so the old one stands and the file still holds it: this attach is
        // refused by name, and the next one works once the folder can be written.
        await this.options.journal.append({ type: "client.refused", mode, reason: "VIEW_TOKEN_NOT_WRITTEN" }).catch(() => {})
        throw closing(refused("VIEW_TOKEN_NOT_WRITTEN", "The core couldn't write a new view token, so this attach was refused. The token in view.token still works: check the disk and the state folder, then open the Candle Harness again."))
      }
    }
    // A bot is named by its own name, whatever it says; the rest by what they say, or their token's name.
    const clientName = who.role === "bot" ? who.bot : (cleanName(params.clientName) ?? (who.role === "view" ? "view" : who.name))
    const harnessKind = who.role === "harness" ? cleanName(params.harnessKind) : undefined
    const client: ClientInfo = {
      clientId: connectionId,
      role: who.role,
      clientName,
      ...(harnessKind !== undefined ? { harnessKind } : {}),
      ...(who.role !== "view" ? { tokenId: who.tokenId, agent: who.agent } : {}),
      ...(who.role === "bot" ? { bot: who.bot } : {}),
      connectedAt: new Date(this.options.now()).toISOString(),
    }
    if (connection.helloTimer) clearTimeout(connection.helloTimer)
    connection.client = client
    await this.options.journal.append({ type: "client.attached", mode, ...(client.agent ? { agent: client.agent } : {}), clientId: client.clientId, role: client.role, clientName, ...(client.bot ? { bot: client.bot } : {}) })
    if (client.role === "view") this.viewsChanged()
    for (const listener of this.attachListeners) listener({ ...client })
    // A code bot and a Build pane learn only what they act as, not the core's agents, account or mode.
    if (client.role === "bot" || client.role === "build") return { protocol: PROTOCOL_VERSION, coreVersion: this.options.coreVersion, clientId: client.clientId, role: client.role, agent: client.agent, ...(client.bot ? { bot: client.bot } : {}) }
    const identity = this.options.identity()
    return { protocol: PROTOCOL_VERSION, coreVersion: this.options.coreVersion, ...identity, clientId: client.clientId, role: client.role }
  }

  /**
   * A launcher's hello: its ticket, from the process the approving view named (the socket's peer pid).
   * The answer says nothing about the core beyond the protocol and the role.
   */
  private async paneHello(connectionId: string, connection: Connection, ticket: string, mode: CoreIdentity["mode"]): Promise<unknown> {
    const entry = await this.options.tickets?.authenticate(ticket, peerPid(connection.socket))
    if (entry === undefined) {
      await this.options.journal.append({ type: "client.refused", mode, reason: "UNAUTHENTICATED", role: "pane" })
      throw closing(refused("UNAUTHENTICATED", "That ticket isn't live, was used already, or wasn't given to this process."))
    }
    const client: ClientInfo = {
      clientId: connectionId,
      role: "pane",
      clientName: "prompt pane",
      ticketId: entry.ticketId,
      ...(entry.grant.agent ? { agent: entry.grant.agent } : {}),
      connectedAt: new Date(this.options.now()).toISOString(),
    }
    if (connection.helloTimer) clearTimeout(connection.helloTimer)
    connection.client = client
    await this.options.journal.append({ type: "client.attached", mode, ...(client.agent ? { agent: client.agent } : {}), clientId: client.clientId, role: "pane", clientName: client.clientName, ticketId: entry.ticketId })
    return { protocol: PROTOCOL_VERSION, coreVersion: this.options.coreVersion, clientId: client.clientId, role: "pane" }
  }

  private async call(client: ClientInfo, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "core.hello") throw refused("ALREADY_AUTHENTICATED", "This connection already said hello.")
    if (!Object.hasOwn(METHOD_ROLES, method)) throw new RpcError(RPC_METHOD_NOT_FOUND, "METHOD_NOT_FOUND", `No method ${terminalText(method).slice(0, 64)}.`)
    const access = accessFor(method, client.role)
    if (access === "no") {
      await this.options.journal.append({ type: "call.forbidden", mode: this.options.identity().mode, clientId: client.clientId, role: client.role, method })
      throw new RpcError(RPC_FORBIDDEN_FOR_ROLE, "FORBIDDEN_FOR_ROLE", `A ${client.role} may not call ${method}.`)
    }
    const handler = this.handlers.get(method)
    if (handler === undefined) throw refused("METHOD_NOT_AVAILABLE", `${method} isn't in this build of the core yet.`)
    return handler(params, { client, access, agent: client.agent ?? this.options.identity().activeAgent, server: this })
  }

  private async detach(clientId: string): Promise<void> {
    const connection = this.connections.get(clientId)
    if (connection === undefined) return
    this.connections.delete(clientId)
    const client = connection.client
    if (client === undefined) return
    this.events.unsubscribe(clientId)
    await this.options.journal.append({ type: "client.detached", mode: this.options.identity().mode, clientId, role: client.role })
    if (client.role === "view") this.viewsChanged()
    if (client.role === "pane" && client.ticketId) for (const listener of this.paneListeners) listener(client.ticketId)
    for (const listener of this.detachListeners) listener({ ...client })
  }

  private viewsChanged(): void {
    const count = this.viewCount()
    for (const listener of this.viewListeners) listener(count)
  }

  private send(socket: Socket, message: unknown): void {
    this.sendRaw(socket, this.options.redactor.value(message))
  }

  /** Unredacted: only for a WithSecret's answer to a pane, the launcher's own command and its key. */
  private sendRaw(socket: Socket, message: unknown): void {
    if (socket.destroyed) return
    // A peer that has stopped reading is dropped rather than buffered for without limit; it reattaches when it's back.
    if (socket.writableLength > MAX_UNREAD_BYTES) return this.dropUnread(socket)
    socket.write(encodeLine(message))
  }

  private dropUnread(socket: Socket): void {
    const bytes = socket.writableLength
    const found = [...this.connections].find(([, c]) => c.socket === socket)
    socket.destroy()
    void this.options.journal
      .append({ type: "client.dropped", mode: this.options.identity().mode, ...(found ? { clientId: found[0] } : {}), ...(found?.[1].client ? { role: found[1].client.role, clientName: found[1].client.clientName } : {}), reason: "not_reading", bytes })
      .catch(() => {})
  }

  private subscriberFor(client: ClientInfo): Subscriber {
    const connection = this.connections.get(client.clientId)
    return {
      clientId: client.clientId,
      role: client.role,
      // An event too large for one message is skipped and written down, never thrown into whatever published it.
      send: (notification) => {
        if (!connection) return
        try {
          this.send(connection.socket, notification)
        } catch (error) {
          this.sendFailed(String(notification.params.topic), client, error)
        }
      },
    }
  }

  private sendFailed(topic: string, client: Pick<ClientInfo, "clientId" | "role">, error: unknown): void {
    void this.options.journal
      .append({
        type: "send.oversize",
        mode: this.options.identity().mode,
        clientId: client.clientId,
        role: client.role,
        topic,
        ...(error instanceof MessageTooLarge ? { bytes: error.bytes } : { error: terminalText(error instanceof Error ? error.message : String(error)).slice(0, 200) }),
      })
      .catch(() => {})
  }

  private registerBuiltins(): void {
    this.handle("subscribe", async (params, call) => {
      const asked = params.topics
      if (!Array.isArray(asked) || asked.length === 0 || !asked.every((topic) => typeof topic === "string")) {
        throw invalidParams("topics must be a non-empty array of strings.")
      }
      for (const topic of asked as string[]) {
        const verdict = topicAllowed(topic, call.client.role)
        if (!verdict.known) throw invalidParams(`Unknown topic: ${terminalText(topic).slice(0, 80)}`)
        if (!verdict.allowed) {
          await this.options.journal.append({ type: "call.forbidden", mode: this.options.identity().mode, clientId: call.client.clientId, role: call.client.role, method: "subscribe", topic })
          throw new RpcError(RPC_FORBIDDEN_FOR_ROLE, "FORBIDDEN_FOR_ROLE", `A ${call.client.role} may not subscribe to ${topic}.`)
        }
      }
      const since: Record<string, number> = {}
      const sinceSeq = params.sinceSeq
      if (sinceSeq !== undefined) {
        if (sinceSeq === null || typeof sinceSeq !== "object" || Array.isArray(sinceSeq)) throw invalidParams("sinceSeq must be an object of topic to seq.")
        for (const [topic, seq] of Object.entries(sinceSeq)) if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) since[topic] = seq
      }
      let filters: Record<string, unknown>
      try {
        filters = this.events.parseFilters(params.filters)
      } catch (error) {
        throw invalidParams(terminalText(error instanceof Error ? error.message : String(error)).slice(0, 200))
      }
      for (const topic of Object.keys(filters)) if (!(asked as string[]).includes(topic)) throw invalidParams(`A filter for ${terminalText(topic).slice(0, 80)} needs that topic subscribed in the same call.`)
      // The response goes out before the replay or snapshot it triggers.
      // Nothing thrown here has a caller: a failure is written down, and the connection carries on.
      queueMicrotask(() => {
        try {
          this.events.subscribe(this.subscriberFor(call.client), asked as string[], since, filters)
        } catch (error) {
          this.sendFailed("subscribe", call.client, error)
        }
      })
      return { topics: [...new Set([...this.events.topicsOf(call.client.clientId), ...(asked as string[])])] }
    })
    this.handle("unsubscribe", async (params, call) => {
      const topics = params.topics
      if (topics !== undefined && (!Array.isArray(topics) || !topics.every((topic) => typeof topic === "string"))) throw invalidParams("topics must be an array of strings.")
      this.events.unsubscribe(call.client.clientId, topics as string[] | undefined)
      return { topics: this.events.topicsOf(call.client.clientId) }
    })
  }
}

function closing(error: RpcError): RpcError {
  error.closes = true
  return error
}

function errorBody(rpcCode: number, code: string, message: string): RpcErrorBody {
  return { code: rpcCode, message, data: { code } }
}
