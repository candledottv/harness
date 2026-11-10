// Candle's released MCP server, run as a child process per agent key and called as an MCP client
// (launched as `candle mcp` by default). Each child holds only its
// own agent's key, starts with the core and is kept while the core runs. A call can never reach a
// child holding a different key: the pool hands out one child per agent.
//
// Results are read without HTTP status, which an MCP client can't see. What a call returns:
//   ok     the tool's JSON result;
//   error  Candle refused it, or nothing was sent (bad arguments, the child down), with the code;
//   lost   nobody knows whether it reached Candle: the child died, the call timed out, the server
//          reported MCP_TRANSPORT, or the reply couldn't be read. Never retried here.
// The error shapes are the ones docs.candle.tv/developers/mcp-server lists under "Error shapes": the envelope
// `{ success: false, error: { code, ... } }`, and candle_trade's API body under `api`.
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ErrorCode, type JSONRPCMessage, McpError, type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { allowEnv, type LaunchSpec, type LongChild, spawnChild } from "../shared/child"
import { VERSION } from "../version"
import { type KeyBudget, MCP_LIST_REQUESTS, MCP_START_REQUESTS, metered, requestsOf } from "./key-budget"
import { utf8Bytes } from "./usage"

/** The oldest server the Candle Harness works with (the one bundled in `candle` 0.11.40). */
export const MIN_CANDLE_MCP = "0.10.22"
/** `initialize` can wait up to 15 s while the server checks the key at startup. */
export const CONNECT_TIMEOUT_MS = 20_000
export const DEFAULT_CALL_TIMEOUT_MS = 60_000
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000]
/** A child that stayed up this long starts its backoff over when it next exits. */
const STABLE_MS = 60_000
const STDERR_TAIL_BYTES = 4096

export type ToolOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; code: string; retryable: boolean; body: unknown }
  | { kind: "lost"; reason: "child_exited" | "timeout" | "transport" | "unparseable"; body?: unknown }

export type ChildStatus =
  | { state: "starting" }
  | { state: "ready"; version: string }
  | { state: "down"; reason: string }
  | { state: "refused"; reason: string }
  | { state: "stopped" }

export type McpRoute = "cli" | "package"

export class UnknownAgent extends Error {
  constructor(readonly agent: string) {
    super(`No agent named "${agent}" has a Candle connection`)
    this.name = "UnknownAgent"
  }
}

/** The private, empty config folder a child gets, so it never reads the CLI's own profiles. */
export function candleConfigDir(stateDir: string, agent: string): string {
  return join(stateDir, "candle", agent)
}

/** How a child is started: `candle mcp` (route A) or `candle-mcp` (route B), never through a shell. */
export function childLaunch(opts: {
  route: McpRoute
  path: string
  apiKey: string
  configDir: string
  parentEnv: Record<string, string | undefined>
}): LaunchSpec {
  return {
    cmd: opts.path,
    args: opts.route === "cli" ? ["mcp"] : [],
    // `candle mcp` passes its environment through, so it's built from the allowlist here.
    env: allowEnv(opts.parentEnv, {
      CANDLE_API_KEY: opts.apiKey,
      CANDLE_CONFIG_DIR: opts.configDir,
      CANDLE_NO_UPDATE_NOTIFIER: "1",
    }),
    cwd: opts.configDir,
  }
}

export function versionAtLeast(version: unknown, min: string): boolean {
  const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? []).slice(1).map(Number)
  if (typeof version !== "string") return false
  const have = parse(version)
  const want = parse(min)
  if (have.length !== 3) return false // a pre-release or anything else unreadable is refused
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! > want[i]!
  return true
}

/** The error object in either of Candle's shapes, or undefined. */
function errorOf(body: unknown): { code: string; retryable: boolean } | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>
  const api = record.api
  const holder = typeof api === "object" && api !== null && "error" in api ? (api as Record<string, unknown>) : record
  const error = holder.error
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>
    return { code: typeof e.code === "string" ? e.code : "UNKNOWN_ERROR", retryable: e.retryable === true }
  }
  if (error !== undefined && error !== false) return { code: "UNKNOWN_ERROR", retryable: false }
  return undefined
}

/** A tool result as an outcome. Exported for its tests. */
export function toOutcome(reply: object): ToolOutcome {
  const result = reply as { content?: unknown; isError?: unknown }
  const content = Array.isArray(result.content) ? result.content : []
  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  const text = first?.type === "text" && typeof first.text === "string" ? first.text : undefined
  if (text === undefined) return { kind: "lost", reason: "unparseable" }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // The SDK refuses bad arguments before the tool's handler runs, so nothing was sent.
    if (result.isError === true && text.startsWith(`MCP error ${ErrorCode.InvalidParams}:`)) {
      return { kind: "error", code: "MCP_VALIDATION", retryable: false, body: text }
    }
    return { kind: "lost", reason: "unparseable" }
  }
  const error = errorOf(body)
  if (error?.code === "MCP_TRANSPORT") return { kind: "lost", reason: "transport", body }
  if (result.isError === true) return { kind: "error", code: error?.code ?? "UNKNOWN_ERROR", retryable: error?.retryable ?? false, body }
  return { kind: "ok", result: body }
}

/** An answer's text content, in bytes: what Candle sent, near enough (the JSON-RPC frame around it isn't counted). */
function answerBytes(reply: object): number {
  const content = (reply as { content?: unknown }).content
  if (!Array.isArray(content)) return 0
  return content.reduce((n: number, c) => n + (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? utf8Bytes((c as { text: string }).text) : 0), 0)
}

/** MCP over a child's stdin and stdout, spawned under child.ts's rules (the SDK's own transport adds LOGNAME and SHELL). */
class ChildTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private child?: LongChild
  private readonly buffer = new ReadBuffer()
  private closed = false
  stderrTail = ""
  pid?: number

  constructor(private readonly spec: LaunchSpec) {}

  async start(): Promise<void> {
    const child = spawnChild(this.spec)
    this.child = child
    this.pid = child.proc.pid
    void this.pump(child.proc.stdout)
    void this.drain(child.proc.stderr)
    void child.proc.exited.then(() => this.finish())
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child) throw new Error("The Candle MCP child isn't running")
    this.child.proc.stdin.write(serializeMessage(message))
    await this.child.proc.stdin.flush()
  }

  async close(): Promise<void> {
    this.child?.killGroup()
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.child?.killGroup() // anything the child started goes with it
    this.onclose?.()
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stream) {
        this.buffer.append(Buffer.from(chunk))
        for (;;) {
          let message: JSONRPCMessage | null
          try {
            message = this.buffer.readMessage()
          } catch (error) {
            this.onerror?.(error as Error)
            continue
          }
          if (message === null) break
          this.onmessage?.(message)
        }
      }
    } catch (error) {
      this.onerror?.(error as Error)
    }
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stream) {
        this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES)
      }
    } catch {}
  }
}

export interface ChildOptions {
  connectTimeoutMs?: number
  backoffMs?: number[]
  /** Counts each call that reaches the server, and reads its answer for RATE_LIMITED. Never holds a call. */
  meter?: Pick<KeyBudget, "noteCall" | "noteOutcome">
  /** The size of each answer's text, for the core's usage totals. */
  onAnswer?: (agent: string, bytes: number) => void
}

/** One agent's child: started, checked, restarted with backoff when it exits. */
export class CandleMcpChild {
  private client?: Client
  private transport?: ChildTransport
  private current: ChildStatus = { state: "starting" }
  private toolList: Tool[] = []
  private attempt = 0
  private readyAt = 0
  private restartTimer?: ReturnType<typeof setTimeout>
  private stopping = false

  constructor(
    readonly agent: string,
    private readonly spec: LaunchSpec,
    private readonly options: ChildOptions = {},
  ) {}

  status(): ChildStatus {
    return this.current
  }

  tools(): Tool[] {
    return this.toolList
  }

  /** Recent stderr from the child, for the doctor. It may hold anything the child printed: redact before showing. */
  stderrTail(): string {
    return this.transport?.stderrTail ?? ""
  }

  /** Starts the child and resolves once it's ready, refused or down (a restart is then scheduled). */
  async start(): Promise<void> {
    if (this.stopping) return
    this.current = { state: "starting" }
    const transport = new ChildTransport(this.spec)
    const client = new Client({ name: "candle-harness", version: VERSION }, { capabilities: {} })
    let connected = false
    transport.onclose = () => {
      // The client wraps onclose when it connects; this runs from inside its wrapper.
      if (this.transport !== transport) return
      this.client = undefined
      if (this.stopping || this.current.state === "refused") return
      if (connected) this.current = { state: "down", reason: "the Candle MCP server exited" }
      this.scheduleRestart()
    }
    this.transport = transport
    try {
      await client.connect(transport, { timeout: this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS })
      connected = true
      const version = client.getServerVersion()?.version
      if (!versionAtLeast(version, MIN_CANDLE_MCP)) {
        this.current = {
          state: "refused",
          reason: `Candle's MCP server is ${version ?? "an unknown version"}; the Candle Harness needs ${MIN_CANDLE_MCP} or later. Run \`candle update\` to update Candle.`,
        }
        await client.close()
        return
      }
      // The server asked the key about its profile as it started, and does again on every tools/list: the key's limit counts both.
      this.options.meter?.noteCall(this.agent, MCP_START_REQUESTS)
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.options.meter?.noteCall(this.agent, MCP_LIST_REQUESTS)
        this.toolList = await listAllTools(client).catch(() => this.toolList)
      })
      this.toolList = await listAllTools(client)
      this.client = client
      this.readyAt = Date.now()
      this.current = { state: "ready", version: version as string }
    } catch (error) {
      if (this.current.state !== "refused") {
        this.current = { state: "down", reason: `couldn't start Candle's MCP server: ${(error as Error).message}` }
      }
      await transport.close()
    }
  }

  /** `uncounted`: a read Candle doesn't count toward the key's limit (its market read, measured), so the budget counts none. */
  async call(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; uncounted?: boolean } = {}): Promise<ToolOutcome> {
    const client = this.client
    if (!client || this.current.state !== "ready") {
      const why = "reason" in this.current ? this.current.reason : this.current.state
      return { kind: "error", code: "CANDLE_MCP_DOWN", retryable: true, body: { message: `Candle isn't connected for ${this.agent}: ${why}` } }
    }
    return metered(this.options.meter, this.agent, () => this.send(client, name, args, opts), opts.uncounted ? 0 : requestsOf(name))
  }

  private async send(client: Client, name: string, args: Record<string, unknown>, opts: { timeoutMs?: number }): Promise<ToolOutcome> {
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS })
      this.options.onAnswer?.(this.agent, answerBytes(result))
      return toOutcome(result)
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { kind: "lost", reason: "timeout" }
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        return { kind: "error", code: "MCP_VALIDATION", retryable: false, body: error.message }
      }
      return { kind: "lost", reason: "child_exited" }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    clearTimeout(this.restartTimer)
    this.current = { state: "stopped" }
    await this.transport?.close()
  }

  private scheduleRestart(): void {
    if (this.readyAt && Date.now() - this.readyAt >= STABLE_MS) this.attempt = 0
    this.readyAt = 0
    const backoff = this.options.backoffMs ?? BACKOFF_MS
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)]!
    this.attempt++
    clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => void this.start(), delay)
  }
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

/** Every agent's child, started together with the core. */
export class CandleMcpPool {
  private readonly children = new Map<string, CandleMcpChild>()
  private readonly keys = new Map<string, string>()

  constructor(
    private readonly opts: {
      route: McpRoute
      path: string
      stateDir: string
      parentEnv: Record<string, string | undefined>
      agents: { name: string; apiKey: string }[]
      child?: ChildOptions
    },
  ) {}

  /** Starts every agent's child at once; resolves when each is ready, refused or down. */
  async start(): Promise<void> {
    await Promise.all(this.opts.agents.map((agent) => this.add(agent)))
  }

  async add(agent: { name: string; apiKey: string }): Promise<void> {
    if (this.children.has(agent.name)) throw new Error(`${agent.name} already has a Candle connection`)
    this.keys.set(agent.name, agent.apiKey)
    const configDir = candleConfigDir(this.opts.stateDir, agent.name)
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const spec = childLaunch({ route: this.opts.route, path: this.opts.path, apiKey: agent.apiKey, configDir, parentEnv: this.opts.parentEnv })
    const child = new CandleMcpChild(agent.name, spec, this.opts.child)
    this.children.set(agent.name, child)
    await child.start()
  }

  for(agent: string): CandleMcpChild {
    const child = this.children.get(agent)
    if (!child) throw new UnknownAgent(agent)
    return child
  }

  agents(): string[] {
    return [...this.children.keys()]
  }

  async stop(): Promise<void> {
    await Promise.all([...this.children.values()].map((child) => child.stop()))
  }

  /** Every child stopped and started again (after `candle update`), so each runs the CLI as it now is. */
  async restart(): Promise<void> {
    await Promise.all(
      [...this.children].map(async ([name, child]) => {
        await child.stop()
        this.children.delete(name)
        await this.add({ name, apiKey: this.keys.get(name)! })
      }),
    )
  }
}
