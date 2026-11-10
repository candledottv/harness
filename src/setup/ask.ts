// From outside: `candle-harness ask "<words>"` sends an agent the person's message from a script or another
// terminal, and `candle-harness trigger <name>` fires an `on call` trigger. Both attach to the running core with the
// view token in the state folder, so they work only as the same user, and neither starts a core: with none
// running they say so, and how to start one.
//
// - `ask` is the person's own message under the same rules as one typed in the Candle Harness (a secret is refused, a
//   card still waits for a press in the Candle Harness, funds out still needs the person's words), with no cap, and it's
//   marked "from outside" in the conversation, Activity and the Journal. It prints the reply when the turn
//   ends, and names any card the turn left waiting; `--no-wait` returns once the core has it. `--json` prints
//   one JSON object instead: the turn, its reply, how it ended, and each card it caused with where it
//   stands, for a caller that then follows the card with `candle-harness cards --wait <card id>`.
// - `trigger` fires as the trigger itself, with its cooldown, its plan, its wallet's figures and the kill
//   switch, exactly as its own condition would. It prints its Activity line as it goes and waits for what it
//   did (a trade to fill, a card to be pressed or expire, a notice, a wake); `--no-wait` returns once it fired.
//
// Exit codes: 0 done; 1 it ran and didn't finish well (the turn failed or was stopped, the firing was held or
// stopped), or the core went away; 2 usage; 3 no core running; 4 refused, nothing ran; 5 the trigger is
// cooling down, nothing ran.
import { ASK_CLIENT, buildPaneRefusal, connectView, CoreClientError, type CoreConnection, TRIGGER_CLIENT } from "../core/client"
import { type Paths, paths as pathsOf, PathsError } from "../paths"
import { answers } from "../shared/socket-path"
import { cardRow } from "./cards"

export const EXIT = { done: 0, failed: 1, usage: 2, noCore: 3, refused: 4, cooldown: 5 } as const

export interface OutsideIo {
  out(text: string): void
  err(text: string): void
  /** The message from stdin, when `ask` is given no words and stdin isn't a terminal. */
  readStdin?(): Promise<string | undefined>
}

export interface OutsideDeps {
  env: Record<string, string | undefined>
  /** Attaches to the core; a seam for tests. */
  connect?: (p: Paths, clientName: string) => Promise<{ connection: CoreConnection; hello: Record<string, unknown> }>
}

const ASK_USAGE = `Usage: candle-harness ask [--agent <name>] [--no-wait] [--json] <words…>
  Sends an agent your message from a script or another terminal, as if typed in the Candle Harness, and prints its reply.
  With no words, the message is read from stdin. --agent picks the agent (the active one by default);
  --no-wait returns once the core has the message. --json prints one JSON object on stdout:
  { agent, turnId, queued, outcome, reply, cards: [{ cardId, opId, kind, title, state, ended, expiresAt, … }] };
  a card it left waiting is approved only by a press in the Candle Harness (candle-harness cards --wait follows it).
  Exit codes: 0 replied; 1 the turn failed or was stopped; 2 usage; 3 no core running; 4 refused.
`

const TRIGGER_USAGE = `Usage: candle-harness trigger [--no-wait] <name>
  Fires an "on call" trigger by its name, with its cooldown, its wallet's figures and the kill switch.
  Waits for what it did, unless --no-wait.
  Exit codes: 0 done; 1 held or stopped; 2 usage; 3 no core running; 4 refused; 5 cooling down.
`

/** What to say when no core is running: neither command starts one. */
/** How long a firing's line may take to settle before it's printed as it stands. */
const HOLD_MS = 1500

const NO_CORE = "No Candle Harness core is running, so nothing was sent. `candle-harness` opens the Candle Harness and starts one; `candle-harness core` runs one headless, and `candle-harness service install` starts one at login.\n"

const realConnect = (p: Paths, clientName: string) => connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName })

/** Reads `--agent <name>` and `--no-wait` off the front or anywhere before `--`; the rest are words. */
function readFlags(args: readonly string[], allowAgent: boolean): { agent?: string; noWait: boolean; json: boolean; words: string[] } | { problem: string } {
  const words: string[] = []
  let agent: string | undefined
  let noWait = false
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--") {
      words.push(...args.slice(i + 1))
      break
    }
    if (a === "--no-wait") noWait = true
    else if (a === "--json" && allowAgent) json = true
    else if (a === "--agent" && allowAgent) {
      const v = args[++i]
      if (v === undefined || v.startsWith("--")) return { problem: "--agent needs an agent's name." }
      agent = v
    } else if (a.startsWith("--")) return { problem: `Unknown option ${a.slice(0, 40)}.` }
    else words.push(a)
  }
  return { ...(agent !== undefined ? { agent } : {}), noWait, json, words }
}

/** The state folder where a core answers; an exit code, said, when there's none. */
export async function reach(io: OutsideIo, d: OutsideDeps): Promise<Paths | number> {
  let p: Paths
  try {
    p = pathsOf(d.env)
  } catch (error) {
    if (error instanceof PathsError) {
      io.err(`${error.message}\n`)
      return EXIT.failed
    }
    throw error
  }
  if (!d.connect && !(await answers(p.socket))) {
    io.err(NO_CORE)
    return EXIT.noCore
  }
  return p
}

/** A refusal from the core in its own words, with the exit code it means. */
export function refusal(io: OutsideIo, error: unknown): number {
  if (error instanceof CoreClientError) {
    if (error.code === "CORE_NOT_RUNNING") {
      io.err(NO_CORE)
      return EXIT.noCore
    }
    if (error.code === "CORE_DISCONNECTED") {
      io.err("The core closed the connection before it answered. What it was doing goes on, or is read back when it next starts; the Candle Harness shows it.\n")
      return EXIT.failed
    }
    io.err(`${error.message}${/[.!?]$/.test(error.message) ? "" : "."} Nothing was sent.\n`)
    return error.code === "COOLDOWN" ? EXIT.cooldown : EXIT.refused
  }
  io.err(`${(error as Error)?.message ?? String(error)}\n`)
  return EXIT.failed
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** `candle-harness ask`. */
export async function askCommand(args: string[], io: OutsideIo, d: OutsideDeps): Promise<number> {
  // A Build pane's harness reads untrusted text: nothing it runs speaks or fires as the person.
  const pane = buildPaneRefusal(d.env)
  if (pane) return refusal(io, pane)
  const flags = readFlags(args, true)
  if ("problem" in flags) {
    io.err(`${flags.problem}\n\n${ASK_USAGE}`)
    return EXIT.usage
  }
  let text = flags.words.join(" ").trim()
  if (!text && io.readStdin) text = ((await io.readStdin()) ?? "").trim()
  if (!text) {
    io.err(ASK_USAGE)
    return EXIT.usage
  }
  const p = await reach(io, d)
  if (typeof p === "number") return p

  let connection: CoreConnection
  let hello: Record<string, unknown>
  try {
    ;({ connection, hello } = await (d.connect ?? realConnect)(p, ASK_CLIENT))
  } catch (error) {
    return refusal(io, error)
  }
  try {
    // Listening before the message goes, so no event of its turn is missed. Its turn is known once the core
    // answers; events before then wait. A card the agent proposes while its turn runs is this turn's.
    const early: Record<string, unknown>[] = []
    const cardsSeen = new Map<string, Record<string, unknown>>()
    const ours = new Set<string>()
    let mine: { agent: string; turnId: string } | undefined
    let running = false
    let ended: Record<string, unknown> | undefined
    let wake: (() => void) | undefined
    let gone = false
    const onAgent = (ev: Record<string, unknown>) => {
      if (!mine || ev.agent !== mine.agent || ev.turnId !== mine.turnId) return
      if (ev.type === "started") running = true
      if (ev.type === "ended") {
        running = false
        ended = ev
      }
    }
    connection.onEvent((e) => {
      if (e.snapshot) return
      const data = record(e.data)
      if (!data) return
      if (e.topic === "agent") mine ? onAgent(data) : early.push(data)
      if (e.topic === "cards" && typeof data.cardId === "string") {
        cardsSeen.set(data.cardId, data)
        if (running && data.agent === mine?.agent && record(data.origin)?.role === "harness") ours.add(data.cardId)
      }
      wake?.()
    })
    connection.onClose(() => {
      gone = true
      wake?.()
    })
    if (!flags.noWait) await connection.request("subscribe", { topics: ["agent", "cards"] })

    let sent: { agent?: unknown; turnId?: unknown; queued?: unknown }
    try {
      sent = (await connection.request("agent.send", { text, ...(flags.agent ? { agent: flags.agent } : {}) })) as typeof sent
    } catch (error) {
      return refusal(io, error)
    }
    const agent = typeof sent.agent === "string" ? sent.agent : (flags.agent ?? (typeof hello.activeAgent === "string" ? hello.activeAgent : "the agent"))
    mine = { agent, turnId: String(sent.turnId ?? "") }
    for (const ev of early.splice(0)) onAgent(ev)
    if (hello.paused === true) io.err("The kill switch is on: the agent's buys and swaps are refused until you resume in the Candle Harness.\n")
    if (flags.noWait) {
      if (flags.json) return io.out(`${JSON.stringify({ agent, turnId: mine.turnId, queued: sent.queued === true })}\n`), EXIT.done
      io.out(`Sent to ${agent}${sent.queued === true ? ", after the turn it's on" : ""}. Its reply shows in the Candle Harness.\n`)
      return EXIT.done
    }
    if (sent.queued === true) io.err(`${agent} is on a turn: your message goes when it ends.\n`)

    while (!ended) {
      if (gone) {
        io.err(`The core closed before ${agent}'s turn ended. Its reply, if any, shows in the Candle Harness.\n`)
        return EXIT.failed
      }
      await new Promise<void>((resolve) => (wake = resolve))
      wake = undefined
    }
    const end = ended as Record<string, unknown>
    const reply = String(end.reply ?? "")
    const outcome = String(end.outcome ?? "")
    if (flags.json) {
      // Everything a caller needs to follow up, in one object: the cards are as `candle-harness cards` lists them.
      io.out(`${JSON.stringify({ agent, turnId: mine.turnId, queued: sent.queued === true, outcome, reply, cards: [...ours].map((id) => cardRow(cardsSeen.get(id)!)) })}\n`)
    } else if (reply) io.out(reply.endsWith("\n") ? reply : `${reply}\n`)
    const waiting = [...ours].map((id) => cardsSeen.get(id)!).filter((c) => c.state === "awaiting_approval")
    if (waiting.length) {
      const titles = waiting.map((c) => String(record(c.display)?.headline ?? record(c.display)?.title ?? c.tool ?? "a card"))
      io.err(`${waiting.length === 1 ? "A card waits" : `${waiting.length} cards wait`} for you in the Candle Harness: ${titles.join("; ")}. Only a press there approves ${waiting.length === 1 ? "it" : "them"}.\n`)
    }
    if (outcome !== "done") {
      if (!reply) io.err(`${agent}'s turn ended: ${outcome || "with no reply"}.\n`)
      return EXIT.failed
    }
    return EXIT.done
  } finally {
    connection.close()
  }
}

/** `candle-harness trigger <name>`. */
export async function triggerCommand(args: string[], io: OutsideIo, d: OutsideDeps): Promise<number> {
  // A Build pane's harness reads untrusted text: nothing it runs speaks or fires as the person.
  const pane = buildPaneRefusal(d.env)
  if (pane) return refusal(io, pane)
  const flags = readFlags(args, false)
  if ("problem" in flags) {
    io.err(`${flags.problem}\n\n${TRIGGER_USAGE}`)
    return EXIT.usage
  }
  const name = flags.words.join(" ").trim()
  if (!name) {
    io.err(TRIGGER_USAGE)
    return EXIT.usage
  }
  const p = await reach(io, d)
  if (typeof p === "number") return p

  let connection: CoreConnection
  try {
    ;({ connection } = await (d.connect ?? realConnect)(p, TRIGGER_CLIENT))
  } catch (error) {
    return refusal(io, error)
  }
  try {
    // Its Activity line, as it goes: the first firing of this trigger after the call, each time its words change.
    let calling = false
    let lineSeq: number | undefined
    // A line that's settled in a moment is printed once, as it ended; one still going after HOLD_MS is printed as
    // it stands, then again as it changes (a card waiting for the person can take a minute).
    let lastSaid = ""
    let printed = ""
    let held: ReturnType<typeof setTimeout> | undefined
    const print = () => {
      held = undefined
      if (lastSaid === printed) return
      printed = lastSaid
      io.out(`⚡ ${name}  ${lastSaid}\n`)
    }
    const say = (said: string, now = false) => {
      lastSaid = said
      if (now || printed) return print()
      held ??= setTimeout(print, HOLD_MS)
    }
    connection.onEvent((e) => {
      if (e.snapshot || e.topic !== "activity" || !calling) return
      const entry = record(record(e.data)?.entry)
      const firing = record(entry?.firing)
      if (!entry || !firing || firing.name !== name || typeof entry.seq !== "number") return
      lineSeq ??= entry.seq
      if (entry.seq === lineSeq && typeof firing.said === "string") say(firing.said)
    })
    if (!flags.noWait) await connection.request("subscribe", { topics: ["activity"] })
    calling = true
    let answer: { said?: unknown; ended?: unknown; line?: unknown }
    try {
      answer = (await connection.request("triggers.fire", { name, ...(flags.noWait ? {} : { wait: true }) })) as typeof answer
    } catch (error) {
      return refusal(io, error)
    }
    if (flags.noWait) {
      io.out(`${String(answer.said ?? `"${name}" fired.`)} What it does shows in the Candle Harness's Activity.\n`)
      return EXIT.done
    }
    const line = record(answer.line)
    if (held) clearTimeout(held)
    if (typeof line?.said === "string") say(line.said, true)
    else if (lastSaid) print()
    const ended = record(answer.ended)
    const ok = ended?.ok === true
    // The line says what happened; the ending is added where it says more (why it stopped).
    const words = typeof ended?.words === "string" ? ended.words : ""
    if (!lastSaid) io.out(`⚡ ${name}  fired: ${words || "done"}\n`)
    else if (!ok && words && !lastSaid.includes(words)) io.err(`${words}\n`)
    return ok ? EXIT.done : EXIT.failed
  } finally {
    connection.close()
  }
}
