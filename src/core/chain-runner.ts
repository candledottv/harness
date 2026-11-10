// A chain run by the core: a trigger's line of several parts, with no view to hold it. It's the view's
// runner (view/app.tsx) on the core's own cards and operations, judged by the same rule (shared/chain.ts):
// each part is sent only once the one before has filled or is done, and a part rejected, expired,
// withdrawn, failed, refused or left without an answer stops the rest. Unlike the view, the core may run
// several chains at once, one for each trigger that fired.
//
// How a part is sent is the caller's: a trigger proposes it as the trigger, never as typed. A part that
// opens the prompt pane stops the chain, since the core has no pane of its own to open.
import { type ChainCard, type ChainOperation, type ChainView, doneWords, judge, type RunningChain, startedFrom, stopWords } from "../shared/chain"
import type { ChainPart } from "../shared/commands"

/** How a chain ended: its words, and how many parts the core took (a card made, or run). */
export type ChainEnd = { kind: "done"; words: string; sent: number } | { kind: "stopped"; words: string; sent: number }

/**
 * Sends part `at`, answering as `cards.propose` or `cli.run` does. A throw is the core's refusal (a limit,
 * the kill switch's pause), and nothing of that part ran.
 */
export type SendPart = (part: ChainPart, at: number) => Promise<unknown>

export interface ChainRunnerDeps {
  /** How a part is sent, for a chain run without one of its own. */
  send?: SendPart
  card(cardId: string): ChainCard | undefined
  operation(opId: string): ChainOperation | undefined
  /** Whether the kill switch's pause is on: a withdrawn card says so. */
  paused(): boolean
}

/** Replacements followed at most this far: the shared judge's own bound. */
const MAX_FOLLOW = 10

export class ChainRunner {
  private readonly running = new Map<RunningChain, (end: ChainEnd) => void>()
  private readonly senders = new Map<RunningChain, SendPart>()

  constructor(private readonly deps: ChainRunnerDeps) {}

  /**
   * Runs the parts one after another; resolves once the last is done or one stops the rest. `send` is how
   * this chain's parts are sent (a trigger's, as that trigger), else the runner's own.
   */
  run(parts: readonly ChainPart[], line: string, send?: SendPart): Promise<ChainEnd> {
    const r: RunningChain = { parts, at: 0, line }
    const how = send ?? this.deps.send
    if (!how) throw new Error("A chain needs a way to send its parts.")
    this.senders.set(r, how)
    const ended = new Promise<ChainEnd>((resolve) => this.running.set(r, resolve))
    void this.sendPart(r)
    return ended
  }

  /** A card or an operation changed: every chain waiting on one is judged again. */
  poke(): void {
    for (const r of [...this.running.keys()]) this.check(r)
  }

  /** Chains still running. */
  get size(): number {
    return this.running.size
  }

  /** The core is stopping: every chain still running stops, and nothing more of it is sent. */
  stopAll(why: string): void {
    for (const r of [...this.running.keys()]) this.end(r, { kind: "stopped", words: stopWords(r, why, !r.sending && !!r.wait), sent: r.at + (!r.sending && r.wait ? 1 : 0) })
  }

  private end(r: RunningChain, end: ChainEnd): void {
    const resolve = this.running.get(r)
    if (!resolve) return
    this.running.delete(r)
    this.senders.delete(r)
    resolve(end)
  }

  private stop(r: RunningChain, why: string, taken: boolean): void {
    this.end(r, { kind: "stopped", words: stopWords(r, why, taken), sent: r.at + (taken ? 1 : 0) })
  }

  private async sendPart(r: RunningChain): Promise<void> {
    const part = r.parts[r.at]!
    r.sending = true
    r.wait = undefined
    let answer: unknown
    try {
      answer = await this.senders.get(r)!(part, r.at)
    } catch (error) {
      if (!this.running.has(r)) return
      return this.stop(r, (error as Error)?.message ?? String(error), false)
    }
    if (!this.running.has(r)) return
    r.sending = undefined
    if ((answer as { kind?: unknown } | undefined)?.kind === "pane") return this.stop(r, `part ${r.at + 1} runs in the prompt pane, which only a view can open`, true)
    const started = startedFrom(r, answer)
    if (started.kind === "stop") return this.stop(r, started.why, true)
    if (started.kind === "done") return this.next(r)
    r.wait = { ...(started.cardId ? { cardId: started.cardId } : {}), ...(started.opId ? { opId: started.opId } : {}) }
    this.check(r)
  }

  private next(r: RunningChain): void {
    if (!this.running.has(r)) return
    if (r.at + 1 >= r.parts.length) return this.end(r, { kind: "done", words: doneWords(r), sent: r.parts.length })
    r.at += 1
    void this.sendPart(r)
  }

  private check(r: RunningChain): void {
    if (!this.running.has(r) || r.sending || !r.wait) return
    const verdict = judge(r, this.viewFor(r))
    if (verdict.kind === "next") return this.next(r)
    if (verdict.kind === "stop") return this.stop(r, verdict.why, true)
  }

  /** The cards and operations part `at` is judged against: its card, any that replaced it, and their operations. */
  private viewFor(r: RunningChain): ChainView {
    const cards: ChainCard[] = []
    const operations: Record<string, ChainOperation | undefined> = {}
    const addOp = (opId: string | undefined) => {
      if (opId && !(opId in operations)) operations[opId] = this.deps.operation(opId)
    }
    let cardId = r.wait?.cardId
    for (let i = 0; cardId && i <= MAX_FOLLOW; i++) {
      const card = this.deps.card(cardId)
      if (!card) break
      cards.push(card)
      addOp(card.opId)
      cardId = card.replacedBy
    }
    addOp(r.wait?.opId)
    return { cards, operations, status: { paused: this.deps.paused() } }
  }
}
