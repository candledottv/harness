// The engine runner: the core's side of a conversation with an agent. `agent.send`
// starts a turn as that agent; the runner mints a harness token bound to it (so its proposals become
// that agent's cards), writes the turn's token and MCP config files, runs the agent's engine in its
// research folder, and streams `agent` events to the views. One turn at a time per agent: a message
// sent mid-turn waits its turn.
//
// The engine is whichever harness the agent's choice names, behind the
// seam in engine.ts. The choice is read when a turn starts, so a turn running finishes on its engine
// and a message waiting runs on the new one; the conversation carries over, since the core keeps it.
// What ran is always known: the engine, its version, the model passed and the model the
// stream says answered are journalled with the turn and sent with its `started` and `ended` events.
//
// The prompt is the agent's preset's: Quant by default, with Candle's skills listed, or the plain trader
// prompt. Like the engine, it's read when each turn starts and journalled with what ran. Every preset
// carries the agent's memory (one per agent): its index,
// read fresh as each turn starts and sent with the turn's prompt, never on the system prompt (which most
// engines take on their command line), and what the turn changed in it is journalled once the turn ends.
//
// What the runner enforces, whatever the model does:
//   - the step cap: at `engine.stepCap` tool calls the turn is cancelled (Claude Code has no
//     --max-turns), and the person is told to say carry on;
//   - the address gate on the final reply: an address no tool result in this turn showed
//     gets one corrective re-ask, then it's masked with a fixed note. While the reply streams, an
//     address not yet seen is shown as pending, so nothing unchecked reaches the screen. The reply is
//     cleaned first (gate.ts's replyText), so an invisible character or a Markdown marker the pane drops
//     can't split an address the gate reads;
//   - the figure gate on the reply as shown: a price, market cap, liquidity,
//     volume, balance or holding that matches no number this turn's tool results showed (nor the
//     core's own words to the agent, nor the person's message) is marked, never held back. The marks go
//     with the reply in its `ended` event, the journal and the transcript, and the pane dims each with a `?`;
//   - secret refusal: a message holding something shaped like a Candle key, a secret the core holds,
//     or a wallet's keypair or recovery phrase (wallet-secret.ts), never reaches the engine;
//   - the turn's harness token is revoked, its connections dropped and its files deleted when it ends;
//   - a woken turn (a trigger's wake) never counts as the person's message: askedIn answers only for a
//     turn the person sent, so funds out can't start from one;
//   - the leftover check: processes the turn started that are still running 2 s after it ended are
//     named in activity. They aren't killed: daemons are the user's. Each turn's engine
//     carries CANDLE_HARNESS_TURN=<turnId> in its environment, which everything it starts inherits, even
//     a process that detaches itself, so only the turn's own processes are named, never whatever else
//     the machine started meanwhile.
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Journal } from "../core/journal"
import type { Redactor } from "../shared/redact"
import { systemTool } from "../shared/exec-path"
import { refused } from "../shared/rpc"
import { mcpConfigFor, mcpServerFor } from "./claude"
import { ENGINE_LABELS, type Engine, type EngineCapabilities, type EngineCheck, type EngineId, type EngineTurn, isEngineId } from "./engine"
import type { EngineEvent, Turn } from "./events"
import { checkAddresses, checkFigures, numbersIn, replyText, type SeenValue, seenFrom, type Source } from "./gate"
import { DEFAULT_PRESET, type Preset } from "./preset"
import { type MemoryForPrompt, memoryParts } from "./prompt"
import { presetPrompt } from "./quant-prompt"
import { type Skill, SKILL_TOOL_NAME, skillsFor } from "./skills"
import { removeAll } from "./home"
import { harnessEnv } from "./spawn"
import { terminalText } from "../shared/terminal-text"
import { ownEvmKeysIn, walletSecretIn } from "../shared/wallet-secret"
import { DEFAULT_TOOLS, shellFor, shellOn, toolAllowed, type ToolSettings } from "./tools"
import { type Exchange, fenced, type FigureMark, toolName, toolSummary, Transcript, type TurnOutcome } from "./transcript"

export const MAX_MESSAGE_CHARS = 20_000
export const LEFTOVER_DELAY_MS = 2_000
export const UNCONFIRMED = "[unconfirmed address]"
export const PENDING_ADDRESS = "[checking address]"
export const FALLBACK_NOTE = "I couldn't confirm that address from Candle's data."
/** What a turn can do when no engine says (a test's `start` seam with no engine registered). */
const FULL: EngineCapabilities = { webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true }
// A Candle key's shape, held or not (shared/redact.ts holds the same rule for redaction).
const KEY_SHAPE = /cndl_(?:live|test)_[A-Za-z0-9_-]{8,}/

/** How many of a stopped turn's actions are listed; the rest are in the Journal. */
const DID_SHOWN = 8

/**
 * A stopped turn's reply: why it stopped, what it did, then what the model had said, marked as said before
 * the stop, so a half-sentence doesn't read as the answer.
 */
/**
 * The address a tool call fetches, in full, when it's an engine's own web fetch: a call outside Candle's
 * and the Candle Harness's tools whose input names an http(s) `url`. An address the agent composed can
 * carry anything it read this turn, so Activity and the Journal show where each fetch went, never a cut of it.
 */
export function fetchAddress(name: string, input: unknown): string | undefined {
  if (/candle|hacc_|harness_|research_|skill_read/i.test(name)) return undefined
  const url = input && typeof input === "object" ? (input as Record<string, unknown>).url : undefined
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return undefined
  return terminalText(url.trim())
}

export function stoppedReply(why: string, did: readonly string[] | undefined, steps: number, spoken: string, answered = steps): string {
  const parts = [why]
  if (did !== undefined) {
    if (did.length) {
      const shown = did.slice(0, DID_SHOWN).map((d) => `- ${d}`)
      if (did.length > DID_SHOWN) shown.push(`- and ${did.length - DID_SHOWN} more, in the Journal`)
      parts.push(`What it did:\n${shown.join("\n")}`)
    } else if (steps > 0) {
      // Only answered calls are named over the reply, so the count says how many weren't.
      const open = steps - Math.min(answered, steps)
      parts.push(`It made no trades, cards or changes on Candle or Hacc, in ${steps === 1 ? "1 tool call" : `${steps} tool calls`}${open > 0 ? ` (${open === steps ? (open === 1 ? "it hadn't" : "none had") : `${open} hadn't`} answered when it stopped)` : ""}.`)
    }
  }
  if (spoken) parts.push(`Before it stopped, it had said:\n\n${spoken}`)
  return parts.join("\n\n")
}

/**
 * One trigger's wake: the trigger, its firing, and what fired it. `fired` is the Candle Harness's words from what the
 * watcher read (a token's name is the token's own), so the prompt fences it as data; `asked` is the
 * person's own words on the trigger, approved on its card.
 */
export interface Wake {
  trigger: string
  fireId: string
  /** The trigger's line, as approved. */
  line: string
  fired: string
  at: string
  asked?: string
  /** Addresses the firing names, by the source that showed them: shown, for the address gate. */
  addresses?: SeenValue[]
  /** The token that fired it, in full: `fired` names it short or by its symbol, which isn't enough to trade on. */
  mint?: string
}

/**
 * Who started a turn: the person's message, or one or more triggers' wakes, joined while the agent was busy.
 * `outside`: the person sent it from a script or another terminal (`candle-harness ask`), not the input line.
 */
export type TurnOrigin = { source: "person"; outside?: true } | { source: "trigger"; wakes: Wake[] }

/** Whether a turn's message came from outside the Candle Harness. */
export const fromOutside = (origin: TurnOrigin | undefined): boolean => origin?.source === "person" && origin.outside === true

/** A woken turn's line for the agent pane, the Journal and the conversation: which triggers, on what. */
export function wokenWords(wakes: readonly Wake[]): string {
  if (wakes.length === 1) return `woken by the trigger "${wakes[0]!.trigger}": ${wakes[0]!.fired}`
  return `woken by ${wakes.length} triggers, joined while the agent was busy:\n${wakes.map((w) => `- "${w.trigger}": ${w.fired}`).join("\n")}`
}

/** The names a woken turn's triggers go by, oldest first, each once. */
export const wokenBy = (origin: TurnOrigin | undefined): string[] => (origin?.source === "trigger" ? [...new Set(origin.wakes.map((w) => w.trigger))] : [])

/** What a turn ran on: the engine, the model passed (null for the harness's own default) and the one that answered, where the stream names it. */
export interface Ran {
  engine: EngineId
  model: string | null
  answeredModel: string | null
}

/** What the views see on the `agent` topic. */
export type AgentEvent = { agent: string; turnId: string } & (
  /** `woken`: the triggers that woke it, for a turn no person sent; `outside`: the person sent it from outside the Candle Harness. */
  | { type: "queued"; user: string; woken?: string[]; outside?: true }
  | ({ type: "started"; user: string; woken?: string[]; outside?: true } & Omit<Ran, "answeredModel">)
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; summary: string }
  | { type: "tool_result"; id: string; name: string; source: Source; summary: string }
  /** The reply named addresses no tool showed; the engine is asked once more, and the streamed text is void. */
  | { type: "reask"; unknown: string[] }
  /** `marked`: each figure in the reply no tool showed (the figure gate), where it starts and as written. */
  | ({ type: "ended"; outcome: TurnOutcome; reply: string; labelled: { address: string; source: Source }[]; marked: FigureMark[]; steps: number } & Partial<Ran>)
)

export interface Proc {
  pid: number
  ppid: number
  name: string
}

/** The environment variable each turn's engine carries, and passes to everything it starts. */
export const TURN_MARKER = "CANDLE_HARNESS_TURN"

/** Every process, from `ps` (the same flags on macOS and Linux). */
export function listProcesses(): Proc[] {
  const run = spawnSync(systemTool("ps"), ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 5_000 })
  return (run.stdout ?? "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]! }))
}

/**
 * The processes whose environment holds `marker` (`CANDLE_HARNESS_TURN=<turnId>`). `ps` shows the environment
 * a process started with: `-E` on macOS, `e` on Linux, for the user's own processes; `-ww` so the
 * line isn't cut.
 */
export function processesMarked(marker: string): Proc[] {
  const args = process.platform === "darwin" ? ["-A", "-E", "-ww", "-o", "pid=,command="] : ["-A", "e", "-ww", "-o", "pid=,args="]
  const run = spawnSync(systemTool("ps"), args, { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 * 1024 })
  const marked = new Set<number>()
  for (const line of (run.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s/.exec(line)
    if (m && line.split(/\s/).includes(marker)) marked.add(Number(m[1]))
  }
  if (marked.size === 0) return []
  return listProcesses().filter((p) => marked.has(p.pid))
}

export interface RunnerDeps {
  journal: Journal
  redactor: Redactor
  mode: () => "paper" | "live"
  /** The agents that have a key, so a turn's tools can reach Candle as them. */
  agents: () => ReadonlySet<string>
  /** Whether an EVM address (by addressKey) is one of the account's own wallets, so its private key in a message is refused. */
  ownEvm?: (addressKey: string) => boolean
  tokens: { mintHarness(name: string, agent: string): Promise<{ token: string; tokenId: string }>; revoke(tokenId: string): Promise<boolean> }
  /** Drops every connection made with a revoked harness token. */
  disconnectToken: (tokenId: string) => void
  publish: (event: AgentEvent) => void
  activity: (data: Record<string, unknown>) => void
  turnsDir: string
  /** Where each turn's engine gets its private work folder (homes, configs), removed after the turn. */
  homesDir: string
  configDir: string
  researchDir: (agent: string) => string
  /** How to run this binary, before its `mcp` subcommand. */
  shim: string[]
  /** The engines in this build, by id. */
  engines: ReadonlyMap<EngineId, Engine>
  /** The agent's engine and model now (engine-state.ts); read when each turn starts. */
  choice: (agent: string) => { engine: EngineId; model?: string }
  /** The agent's shell and tool settings (config's `[agents.<name>.tools]`); undefined is the default. */
  tools?: (agent: string) => ToolSettings | undefined
  /** The agent's preset now (engine-state.ts); read when each turn starts. Unset is Quant. */
  preset?: (agent: string) => Preset
  /** The skills the agent has now (skills.ts's skillsFor), read when each turn starts. Unset: the preset's own. */
  skills?: (agent: string) => readonly Skill[]
  stepCap: number
  /** The core's environment; the engine gets the allowlisted part (harnessEnv). */
  env: Record<string, string | undefined>
  /** What went through the Candle Harness, told to the agent ahead of each turn; undefined for nothing. */
  session?: (agent: string) => string | undefined
  /**
   * The Candle Harness's note ahead of the turn: the token the person picked since the agent's last
   * turn, once. Its addresses and figures count as shown to the address and figure gates.
   */
  context?: (agent: string) => { text: string; addresses: string[] } | undefined
  /**
   * What the turn did, in the Journal's words, trades first: its cards and how each stands, its paper trades
   * and its changes. Said under a turn the cap or a cancel stopped, so nothing it did goes unsaid.
   */
  didInTurn?: (agent: string, turnId: string) => readonly string[]
  /** The prompt's data line: Hacc's tools and what the account's plan doesn't reach. */
  data?: (agent: string) => string | undefined
  /** The agent's memory (core/memory.ts's MemoryBook): read as each turn starts, its change noted after. Unset: no memory section. */
  memory?: { forTurn(agent: string): MemoryForPrompt; afterTurn(agent: string, turnId: string): Promise<unknown>; longChars: number }
  /** Whether a core tool that depends on more than config is offered to the agent now: hacc_lab and harness_triggers by the account's plan. */
  offers?: (agent: string, tool: string) => boolean
  /** Seams for tests: `start` stands in for every engine's own; `version` for every engine's check. */
  start?: (turn: EngineTurn) => Turn
  version?: (engine: EngineId, env: Record<string, string>) => EngineCheck | Promise<EngineCheck>
  /** The processes carrying a turn's marker (processesMarked); a seam for tests. */
  processes?: (marker: string) => Proc[]
  leftoverDelayMs?: number
  /** Every raw line the engine prints, before any redaction: the live canary tests read it. */
  onRaw?: (line: string) => void
}

interface Running {
  turnId: string
  /** The user's message this turn: funds out from the agent must be asked for in it. */
  text: string
  origin: TurnOrigin
  /** When the message was sent (performance.now()), for the time from a message to its card. */
  sentAt: number
  cancel: () => Promise<void>
  done: Promise<void>
  /** The harness token minted for it, once it has one. */
  tokenId?: string
  /** Paper or live when it began: what its prompt told the agent. */
  mode?: "paper" | "live"
  /** Stopped (the person's Esc, the kill switch, the step cap) or over: nothing more of it may act. */
  ended?: boolean
  /** On its second run, asked only to correct its reply: what the first run already asked for isn't asked for again. */
  correcting?: boolean
}

/** How many ended turns' tokens are remembered: enough for every call still in flight when its turn stops. */
const ENDED_KEPT = 500

/** Holds back the end of the stream until a word boundary, and shows an address no tool has shown as pending. */
export class StreamMask {
  private tail = ""
  constructor(private readonly seen: () => readonly SeenValue[]) {}

  push(delta: string): string {
    const all = this.tail + delta
    const cut = Math.max(all.lastIndexOf(" "), all.lastIndexOf("\n"), all.lastIndexOf("\t"))
    if (cut < 0) {
      this.tail = all
      return ""
    }
    this.tail = all.slice(cut + 1)
    return this.mask(all.slice(0, cut + 1))
  }

  flush(): string {
    const rest = this.tail
    this.tail = ""
    return this.mask(rest)
  }

  private mask(raw: string): string {
    // Cut at whitespace, so nothing the cleaner reads across (an address, a surrogate pair) is split.
    const text = replyText(raw)
    const gate = checkAddresses(text, this.seen())
    let out = text
    for (const address of gate.unknown) out = out.split(address).join(PENDING_ADDRESS)
    return out
  }
}

interface Queued {
  turnId: string
  text: string
  sentAt: number
  origin: TurnOrigin
}

export class EngineRunner {
  private readonly transcripts = new Map<string, Transcript>()
  private readonly running = new Map<string, Running>()
  private readonly queues = new Map<string, Queued[]>()
  /** The running turn each live harness token was minted for. */
  private readonly turnsByToken = new Map<string, Running>()
  /**
   * The turns that were stopped or are over, by their token, oldest first: a tool call still in the core when its
   * turn stops is known by this, since its token says nothing else once the turn is gone.
   */
  private readonly endedByToken = new Map<string, Running>()
  /** Each engine's last check: a good one is kept, a bad one is checked again next time. */
  private readonly checks = new Map<EngineId, EngineCheck>()
  /** What each agent's last turn ran on, for the agent pane's chip; kept across restarts by the journal. */
  private readonly ran = new Map<string, Ran>()
  private stopped = false

  constructor(private readonly deps: RunnerDeps) {
    for (const agent of deps.agents()) this.transcripts.set(agent, Transcript.fromJournal(deps.journal.rows(), agent))
    for (const row of deps.journal.rows()) {
      const r = row as Record<string, unknown>
      if (r.type !== "agent.turn" || typeof r.agent !== "string" || !isEngineId(r.engine)) continue
      this.ran.set(r.agent, { engine: r.engine, model: typeof r.model === "string" ? r.model : null, answeredModel: typeof r.answeredModel === "string" ? r.answeredModel : null })
    }
  }

  /** What the agent's last turn that reached its engine ran on; undefined before its first. */
  lastRan(agent: string): Ran | undefined {
    return this.ran.get(agent)
  }

  /** Starts a turn as `agent`, or queues it behind the one running. `outside`: sent by `candle-harness ask`, under the same rules. */
  async send(agent: string, text: unknown, by: string, opts: { outside?: boolean } = {}): Promise<{ turnId: string; queued: boolean }> {
    if (this.stopped) throw refused("CORE_STOPPING", "The core is stopping.")
    if (!this.deps.agents().has(agent)) throw refused("UNKNOWN_AGENT", `No agent named ${agent} has a key.`)
    if (typeof text !== "string" || text.trim().length === 0) throw refused("EMPTY_MESSAGE", "There's no message to send.")
    if (text.length > MAX_MESSAGE_CHARS) throw refused("MESSAGE_TOO_LONG", `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`)
    // A wallet's keypair, recovery phrase or EVM private key first, in its own words (the redactor catches a keypair's array too).
    const ctx = { ...(this.deps.ownEvm ? { ownEvm: this.deps.ownEvm } : {}) }
    if (walletSecretIn(text, ctx)) {
      // An EVM key has a transaction hash's shape, so no log can tell it by its shape: one of the account's own wallets'
      // keys refused here is taken out of every log after. A value refused for the words before it alone isn't kept,
      // since it may be a hash the person asks about next.
      for (const key of ownEvmKeysIn(text, ctx)) {
        const hex = key.replace(/^0x/i, "")
        for (const h of [hex, hex.toLowerCase(), hex.toUpperCase()]) for (const shown of [`0x${h}`, `0X${h}`, h]) this.deps.redactor.add(shown)
      }
      await this.deps.journal.append({ type: "agent.message_refused", mode: this.deps.mode(), agent, by, code: "SECRET_IN_MESSAGE" })
      throw refused("SECRET_IN_MESSAGE", "That message holds a wallet's private key or recovery phrase, so it wasn't sent to the agent. Never paste one into the chat: the agent can't use it, and it would reach the model's provider.")
    }
    if (KEY_SHAPE.test(text) || this.deps.redactor.text(text) !== text) {
      await this.deps.journal.append({ type: "agent.message_refused", mode: this.deps.mode(), agent, by, code: "SECRET_IN_MESSAGE" })
      throw refused("SECRET_IN_MESSAGE", "That message holds something that looks like a key or secret, so it wasn't sent to the agent. Never paste a secret into the chat.")
    }
    const turnId = `t_${randomBytes(9).toString("base64url")}`
    const queue = this.queues.get(agent) ?? []
    this.queues.set(agent, queue)
    queue.push({ turnId, text, sentAt: performance.now(), origin: opts.outside ? { source: "person", outside: true } : { source: "person" } })
    const queued = this.running.has(agent)
    if (queued) this.deps.publish({ agent, turnId, type: "queued", user: text, ...(opts.outside ? { outside: true as const } : {}) })
    else this.next(agent)
    return { turnId, queued }
  }

  /**
   * Wakes `agent` for a trigger: a turn of its own, or, while the agent is busy, the woken turn already
   * waiting, which this wake joins as one more line. `joined` names that turn; nothing new was started.
   */
  wake(agent: string, wake: Wake): { turnId: string; queued: boolean; joined: boolean } {
    if (this.stopped) throw refused("CORE_STOPPING", "The core is stopping.")
    if (!this.deps.agents().has(agent)) throw refused("UNKNOWN_AGENT", `No agent named ${agent} has a key.`)
    const queue = this.queues.get(agent) ?? []
    this.queues.set(agent, queue)
    const waiting = queue.find((q) => q.origin.source === "trigger")
    if (waiting && waiting.origin.source === "trigger") {
      waiting.origin.wakes.push(wake)
      waiting.text = wokenWords(waiting.origin.wakes)
      this.deps.publish({ agent, turnId: waiting.turnId, type: "queued", user: waiting.text, woken: wokenBy(waiting.origin) })
      return { turnId: waiting.turnId, queued: true, joined: true }
    }
    const turnId = `t_${randomBytes(9).toString("base64url")}`
    const origin: TurnOrigin = { source: "trigger", wakes: [wake] }
    const text = wokenWords(origin.wakes)
    queue.push({ turnId, text, sentAt: performance.now(), origin })
    const queued = this.running.has(agent)
    if (queued) this.deps.publish({ agent, turnId, type: "queued", user: text, woken: wokenBy(origin) })
    else this.next(agent)
    return { turnId, queued, joined: false }
  }

  /** Whether a woken turn waits in the agent's queue: a wake now joins it, rather than starting one. */
  wakeWaiting(agent: string): boolean {
    return this.queues.get(agent)?.some((q) => q.origin.source === "trigger") ?? false
  }

  /**
   * The turn a harness token was minted for, and the time since its message was sent: a card the
   * engine proposes carries both, so the time from a message to its card can be read.
   */
  turnOf(tokenId: string): { turnId: string; msSinceStart: number; woken?: { trigger: string; fireId: string }; correcting?: true } | undefined {
    // A stopped turn's call still in flight is still that turn's: a woken turn's is never read as the person's.
    const running = this.turnsByToken.get(tokenId) ?? this.endedByToken.get(tokenId)
    if (!running) return undefined
    const first = running.origin.source === "trigger" ? running.origin.wakes[0] : undefined
    return { turnId: running.turnId, msSinceStart: Math.round(performance.now() - running.sentAt), ...(first ? { woken: { trigger: first.trigger, fireId: first.fireId } } : {}), ...(running.correcting ? { correcting: true as const } : {}) }
  }

  /**
   * Where the turn a harness token was minted for stands: whether it was stopped or is over, and the mode it began
   * in. Undefined for a token no turn was started with (a harness registered on its own), which is never "ended".
   */
  turnState(tokenId: string): { ended: boolean; mode?: "paper" | "live" } | undefined {
    const running = this.turnsByToken.get(tokenId) ?? this.endedByToken.get(tokenId)
    if (!running) return undefined
    return { ended: running.ended === true, ...(running.mode ? { mode: running.mode } : {}) }
  }

  /** The turn stops here: from now on nothing its harness asks for may act, whatever is already on its way in. */
  private markEnded(running: Running): void {
    running.ended = true
    if (!running.tokenId || this.endedByToken.has(running.tokenId)) return
    this.endedByToken.set(running.tokenId, running)
    if (this.endedByToken.size > ENDED_KEPT) this.endedByToken.delete(this.endedByToken.keys().next().value!)
  }

  /**
   * The user's own message in the turn a harness token was minted for: what a funds-out card from the
   * agent must have asked for. Never a message from an earlier turn, and never a woken turn's: a trigger
   * isn't the person asking.
   */
  askedIn(tokenId: string): string | undefined {
    const running = this.turnsByToken.get(tokenId)
    return running?.origin.source === "person" ? running.text : undefined
  }

  /** Ends the agent's turn, and drops the messages waiting behind it unless they're to run next (the person's Esc). */
  async cancel(agent: string, opts: { keepQueued?: boolean } = {}): Promise<{ cancelled: boolean }> {
    if (!opts.keepQueued) this.queues.delete(agent)
    const turn = this.running.get(agent)
    if (!turn) return { cancelled: false }
    await turn.cancel()
    await turn.done
    return { cancelled: true }
  }

  /** Every agent's turn, for the kill switch and for stopping the core: the turns it ended. */
  async cancelAll(): Promise<{ agent: string; turnId: string }[]> {
    const turns = [...this.running].map(([agent, running]) => ({ agent, turnId: running.turnId }))
    this.queues.clear()
    await Promise.all(turns.map((t) => this.cancel(t.agent)))
    return turns
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.cancelAll()
  }

  busy(): boolean {
    return this.running.size > 0
  }

  /** An engine's check, run again unless the last one was good; undefined for one not in this build. */
  async check(id: EngineId, fresh = false): Promise<EngineCheck | undefined> {
    const engine = this.deps.engines.get(id)
    if (!engine && !this.deps.start) return undefined
    const last = this.checks.get(id)
    if (last?.ok && !fresh) return last
    const env = harnessEnv(this.deps.env)
    const check = await (this.deps.version ? this.deps.version(id, env) : engine!.check(env))
    this.checks.set(id, check)
    return check
  }

  /** Each engine's last check, for the `engine` topic. */
  lastCheck(id: EngineId): EngineCheck | undefined {
    return this.checks.get(id)
  }

  transcript(agent: string): readonly Exchange[] {
    return this.transcripts.get(agent)?.all() ?? []
  }

  /** The `agent` topic's snapshot: each agent's recent conversation and what's running. */
  snapshot(): unknown {
    return {
      agents: Object.fromEntries(
        [...this.deps.agents()].map((agent) => [
          agent,
          { running: this.running.get(agent)?.turnId ?? null, queued: this.queues.get(agent)?.length ?? 0, exchanges: this.transcripts.get(agent)?.recent() ?? [] },
        ]),
      ),
    }
  }

  private next(agent: string): void {
    if (this.running.has(agent) || this.stopped) return
    const item = this.queues.get(agent)?.shift()
    if (!item) return
    let cancelTurn: () => Promise<void> = async () => {}
    let cancelled = false
    const running: Running = {
      turnId: item.turnId,
      text: item.text,
      origin: item.origin,
      sentAt: item.sentAt,
      cancel: async () => {
        cancelled = true
        // Before the engine is told: a call of its harness's already in the core finds the turn stopped.
        this.markEnded(running)
        await cancelTurn()
      },
      done: Promise.resolve(),
    }
    running.done = this.turn(agent, running, item.text, item.origin, (fn) => (cancelTurn = fn), () => cancelled)
      .catch(async (error) => {
        await this.deps.journal.append({ type: "agent.turn_failed", mode: this.deps.mode(), agent, turnId: item.turnId, error: String(error) }).catch(() => {})
      })
      .finally(() => {
        this.running.delete(agent)
        this.next(agent)
      })
    this.running.set(agent, running)
  }

  private async turn(agent: string, running: Running, user: string, origin: TurnOrigin, onCancel: (fn: () => Promise<void>) => void, wasCancelled: () => boolean): Promise<void> {
    const deps = this.deps
    const { turnId } = running
    const mode = deps.mode()
    running.mode = mode
    const env = { ...harnessEnv(deps.env), [TURN_MARKER]: turnId }

    const choice = deps.choice(agent)
    const engine = deps.engines.get(choice.engine)
    const label = engine?.label ?? ENGINE_LABELS[choice.engine]
    // None picked: the engine's own default by name, so the journal says what ran (Codex, Grok).
    const model = choice.model ?? engine?.defaultModel?.()
    const settings = deps.tools?.(agent) ?? DEFAULT_TOOLS
    const preset = deps.preset?.(agent) ?? DEFAULT_PRESET
    const can = engine?.capabilities(process.platform) ?? FULL
    // The shell this turn gets on this engine, journalled when it's on: what ran includes it.
    const shell = shellFor(settings, can)
    const woken = wokenBy(origin)
    // A woken turn's rows name what woke it, so nothing it did reads as the person's.
    const wokeFields = origin.source === "trigger" ? { woken, fireIds: origin.wakes.map((w) => w.fireId) } : fromOutside(origin) ? { outside: true as const } : {}
    const outside = fromOutside(origin) ? { outside: true as const } : {}
    deps.publish({ agent, turnId, type: "started", user, ...(woken.length ? { woken } : {}), ...outside, engine: choice.engine, model: model ?? null })
    let check: EngineCheck | undefined
    // The model the stream says answered (every engine but Codex names it), and whether the engine ran at all.
    let answeredModel: string | undefined
    let reached = false
    // The numbers the turn showed the agent, for the figure gate: the person's own message first, since a
    // figure they gave isn't one the agent made up; then the core's words and every tool result.
    const shownNumbers: number[] = numbersIn(user)
    const ran = () => ({
      engine: choice.engine,
      engineVersion: check?.version ?? null,
      model: model ?? null,
      preset,
      // Older rows named only Claude Code's version; a Claude Code turn still does, for their readers.
      ...(choice.engine === "claude-code" ? { claudeVersion: check?.version ?? null } : {}),
      ...(shellOn(shell) ? { shell } : {}),
    })

    /** `spoken` is the part of `reply` the agent wrote (a prefix): the figure gate checks it, never the core's own note after it. */
    const end = async (outcome: TurnOutcome, reply: string, extra: { labelled?: { address: string; source: Source }[]; steps?: number; tools?: string[]; reasked?: boolean; spoken?: string } = {}) => {
      const figures = extra.spoken ? checkFigures(extra.spoken, shownNumbers) : undefined
      const marked: FigureMark[] = (figures?.marked ?? []).map(({ at, text }) => ({ at, text }))
      const exchange: Exchange = { turnId, user, reply, tools: extra.tools ?? [], outcome, ...(marked.length ? { marked } : {}), ...(woken.length ? { woken } : {}), ...outside }
      this.transcripts.get(agent)?.add(exchange)
      // A turn that never reached its engine (not in this build, a failed check) ran on nothing, and isn't what the chip shows.
      const what: Ran = { engine: choice.engine, model: model ?? null, answeredModel: answeredModel ?? null }
      if (reached) this.ran.set(agent, what)
      await deps.journal.append({
        type: "agent.turn",
        mode,
        agent,
        ...exchange,
        ...wokeFields,
        steps: extra.steps ?? 0,
        reasked: extra.reasked ?? false,
        // How many figures the gate checked; `marked` (in the exchange) are those no tool showed.
        ...(figures ? { figures: figures.read.length + figures.marked.length } : {}),
        ...ran(),
        ...(reached ? { answeredModel: what.answeredModel } : {}),
      })
      deps.publish({ agent, turnId, type: "ended", outcome, reply, labelled: extra.labelled ?? [], marked, steps: extra.steps ?? 0, ...(reached ? what : {}) })
    }

    if (!engine && !deps.start) return end("error", `${label} isn't in this build yet. Pick another engine for ${agent} with ctrl-g.`)
    // The version, checked before every turn once it's bad; a good one is kept.
    check = await this.check(choice.engine)
    if (!check?.ok) return end("error", check?.message ?? `${label} couldn't be checked.`)

    const researchDir = deps.researchDir(agent)
    await mkdir(researchDir, { recursive: true, mode: 0o700 })
    const { token, tokenId } = await deps.tokens.mintHarness(choice.engine, agent)
    deps.redactor.add(token)
    // The turn's token sits alone in a folder of its own, so a harness whose sandbox holds reads can be
    // granted that folder and nothing else of the core's (Grok under strict).
    const turnDir = join(deps.turnsDir, turnId)
    const tokenFile = join(turnDir, "token")
    const mcpConfig = join(deps.turnsDir, `${turnId}.json`)
    const workDir = join(deps.homesDir, turnId)
    // A message from outside isn't on anyone's input line: Activity says it as its turn starts, so its words go here too.
    await deps.journal.append({ type: "agent.turn_started", mode, agent, turnId, tokenId, ...wokeFields, ...(fromOutside(origin) ? { user: user.slice(0, 200) } : {}), ...ran() })

    try {
      running.tokenId = tokenId
      this.turnsByToken.set(tokenId, running)
      // Stopped while its token was being minted: it's known as stopped from its first call.
      if (running.ended) this.markEnded(running)
      await mkdir(turnDir, { mode: 0o700 })
      await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" })
      await writeFile(mcpConfig, mcpConfigFor(deps.shim, tokenFile, deps.configDir), { mode: 0o600, flag: "wx" })
      await mkdir(deps.homesDir, { recursive: true, mode: 0o700 })
      await mkdir(workDir, { mode: 0o700 })

      const seen: SeenValue[] = []
      const tools: string[] = []
      const inputs = new Map<string, { name: string; input: unknown }>()
      let steps = 0
      let capped = false
      // Hidden in config, skill_read isn't offered, so the prompt lists none.
      const skills = toolAllowed(settings, SKILL_TOOL_NAME) ? (deps.skills?.(agent) ?? skillsFor(preset, [])) : []
      const has = (tool: string) =>
        toolAllowed(settings, tool) && (tool === SKILL_TOOL_NAME ? skills.length > 0 : tool === "harness_history" ? true : (deps.offers?.(agent, tool) ?? false))
      const remembered = deps.memory?.forTurn(agent)
      // What the agent's own memory says reaches it in the prompt, so a figure recalled from it (the
      // person's own "$1M" rule) isn't one it made up.
      if (remembered?.index) for (const n of numbersIn(remembered.index)) shownNumbers.push(n)
      // How to keep memory goes on the system prompt; the agent's own notes go with the turn's prompt, never on
      // the system prompt, which four of the engines take on their command line, where any local account can
      // read it. The prompt goes on stdin or in a 0600 file.
      const memory = deps.memory && remembered ? memoryParts({ memory: remembered, can, tools: settings, has, longChars: deps.memory.longChars }) : undefined
      const base: Omit<EngineTurn, "prompt"> = {
        systemPrompt: presetPrompt(preset, {
          agent,
          mode,
          researchDir,
          stepCap: deps.stepCap,
          can,
          tools: settings,
          data: deps.data?.(agent),
          triggers: deps.offers?.(agent, "harness_triggers") ?? false,
          skills,
          ...(memory ? { memory: memory.guide } : {}),
        }),
        researchDir,
        mcpConfig,
        mcp: mcpServerFor(deps.shim, tokenFile, deps.configDir),
        ...(model ? { model } : {}),
        env,
        workDir,
        tools: settings,
      }

      /** One engine run; the re-ask is a second one, sharing the step cap and what was seen. */
      const run = async (prompt: string): Promise<{ text?: string; error?: string; partial: string }> => {
        reached = true
        const turn = deps.start ? deps.start({ ...base, prompt }) : engine!.start({ ...base, prompt }, deps.onRaw ? { onRaw: deps.onRaw } : {})
        onCancel(() => turn.cancel())
        if (wasCancelled()) await turn.cancel()
        const mask = new StreamMask(() => seen)
        let partial = ""
        let text: string | undefined
        let error: string | undefined
        // Text after a tool call is a new message, which the harnesses stream with nothing between: it
        // starts a new paragraph, so "…top traders.The last 30 minutes…" doesn't run on (as Grok's did).
        let afterTool = false
        let lastChar = ""
        for await (const e of turn.events as AsyncIterable<EngineEvent>) {
          if (e.type === "text") {
            const lead = afterTool && lastChar !== "" && !/\s/.test(lastChar) && !/^\s/.test(e.delta) ? "\n\n" : ""
            afterTool = false
            if (e.delta) lastChar = e.delta.at(-1)!
            const shown = mask.push(lead + e.delta)
            if (shown) {
              partial += shown
              deps.publish({ agent, turnId, type: "text", delta: shown })
            }
          } else if (e.type === "tool_call") {
            afterTool = true
            steps += 1
            inputs.set(e.id, { name: e.name, input: e.input })
            const fetched = fetchAddress(e.name, e.input)
            if (fetched) void deps.journal.append({ type: "agent.fetch", mode, agent, turnId, tool: toolName(e.name), url: fetched }).catch(() => {})
            deps.publish({ agent, turnId, type: "tool_call", id: e.id, name: toolName(e.name), summary: toolSummary(e.name, e.input, undefined) })
            if (steps >= deps.stepCap && !capped) {
              capped = true
              // The cap stops the turn as the person's stop does: the call that reached it doesn't act.
              this.markEnded(running)
              void turn.cancel()
            }
          } else if (e.type === "tool_result") {
            seen.push(...seenFrom(e.output, e.source))
            for (const n of numbersIn(e.output)) shownNumbers.push(n)
            const call = inputs.get(e.id)
            const summary = toolSummary(e.name, call?.input, e.output, e.failed)
            tools.push(summary)
            deps.publish({ agent, turnId, type: "tool_result", id: e.id, name: toolName(e.name), source: e.source, summary })
          } else if (e.type === "model") answeredModel = e.model
          // The reply is checked, shown, journalled and kept as cleaned, so the gates read what's drawn.
          else if (e.type === "done") text = replyText(e.text)
          else if (e.type === "error") error = e.message
        }
        const rest = mask.flush()
        if (rest) {
          partial += rest
          deps.publish({ agent, turnId, type: "text", delta: rest })
        }
        return { ...(text !== undefined ? { text } : {}), ...(error !== undefined ? { error } : {}), partial }
      }

      const transcript = this.transcripts.get(agent) ?? new Transcript()
      this.transcripts.set(agent, transcript)
      const note = deps.context?.(agent)
      const session = [deps.session?.(agent), note?.text].filter(Boolean).join("\n\n") || undefined
      // What the core itself told the agent: its trades this session, its wallets, the plan's data line, the person's pick.
      for (const n of numbersIn([session ?? "", deps.data?.(agent) ?? ""].join("\n"))) shownNumbers.push(n)
      // The picked token's mint is Candle's: the link moves only to a token Candle has a market for.
      for (const value of note?.addresses ?? []) seen.push({ value, source: "candle" })
      // What fired a woken turn named its token, as Candle or Hacc showed it.
      if (origin.source === "trigger") for (const w of origin.wakes) seen.push(...(w.addresses ?? []))
      // An address the person wrote this turn is theirs to name: the reply may say it back without a second
      // run. A woken turn's words are the core's, and its addresses came in above.
      if (origin.source === "person") seen.push(...seenFrom(user, "you"))
      const prompt = [session, memory?.notes, transcript.promptFor(user, origin)].filter(Boolean).join("\n\n")
      let result = await run(prompt)
      let reasked = false

      const stoppedEarly = () => {
        const spoken = result.partial.trim()
        if (capped) return end("stopped", stoppedReply(`Stopped after ${steps} steps: tell the agent to carry on.`, deps.didInTurn?.(agent, turnId), steps, spoken, tools.length), { steps, tools, reasked, spoken })
        if (wasCancelled()) return end("cancelled", stoppedReply("Turn cancelled.", deps.didInTurn?.(agent, turnId), steps, spoken, tools.length), { steps, tools, reasked, spoken })
        return undefined
      }
      const early = stoppedEarly()
      if (early) return await early
      const explain = (m: string | undefined) => (engine ? engine.explain(m) : (m ?? `${label} ended without a reply.`))
      // An engine's own error words (the tail of its stderr) are cleaned as a reply is.
      if (result.text === undefined) return await end("error", replyText(explain(result.error)), { steps, tools })

      let gate = checkAddresses(result.text, seen)
      if (!gate.ok) {
        reasked = true
        deps.publish({ agent, turnId, type: "reask", unknown: gate.unknown })
        const first = result.text
        // The second run starts with no memory of the first, so it's told what the first already did:
        // a trade or card it made stands, and mustn't be made again.
        const did = deps.didInTurn?.(agent, turnId) ?? []
        running.correcting = true
        const already = did.length ? ` Already done this turn, and standing:\n${did.map((d) => `- ${d}`).join("\n")}\nDon't do any of it again: only correct your reply.` : tools.length ? " The tool calls you made this turn stand: don't repeat a trade, a card or a change, only correct your reply." : ""
        result = await run(
          `${prompt}\n\nYour reply was:\n<reply>\n${fenced(first, "reply")}\n</reply>\nIt names ${gate.unknown.length === 1 ? "an address" : "addresses"} that no tool result in this turn showed: ${gate.unknown.join(", ")}. Look each one up with Candle's tools, or leave it out, and give your whole reply again.${already}`,
        )
        const late = stoppedEarly()
        if (late) return await late
        if (result.text === undefined) return await end("error", replyText(explain(result.error)), { steps, tools, reasked })
        gate = checkAddresses(result.text, seen)
      }
      let reply = result.text
      if (!gate.ok) {
        for (const address of gate.unknown) reply = reply.split(address).join(UNCONFIRMED)
        reply = `${reply.trim()}\n\n${FALLBACK_NOTE}`
      }
      // The fallback note names no figure, so the whole reply is the agent's to check.
      return await end("done", reply, { labelled: gate.labelled, steps, tools, reasked, spoken: reply })
    } finally {
      this.markEnded(running)
      this.turnsByToken.delete(tokenId)
      // A revoked token is refused, so the redactor needn't carry one for every turn the core has run.
      deps.redactor.remove(token)
      await deps.tokens.revoke(tokenId)
      deps.disconnectToken(tokenId)
      await rm(turnDir, { recursive: true, force: true })
      await rm(mcpConfig, { force: true })
      removeAll(workDir)
      // What the turn changed in the agent's memory, after its agent.turn row: Activity says so.
      if (deps.memory) await deps.memory.afterTurn(agent, turnId).catch(() => {})
      this.leftovers(agent, turnId)
    }
  }

  private leftovers(agent: string, turnId: string): void {
    const timer = setTimeout(() => {
      const left = (this.deps.processes ?? processesMarked)(`${TURN_MARKER}=${turnId}`).filter((p) => p.pid !== process.pid)
      if (left.length === 0) return
      const processes = left.map((p) => ({ pid: p.pid, name: p.name }))
      this.deps.activity({ kind: "engine.leftovers", agent, turnId, processes })
      void this.deps.journal.append({ type: "agent.leftovers", mode: this.deps.mode(), agent, turnId, processes }).catch(() => {})
    }, this.deps.leftoverDelayMs ?? LEFTOVER_DELAY_MS)
    timer.unref?.()
  }
}

