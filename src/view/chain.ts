// A chain's parts, run one after another. The view
// holds the chain: each part goes to the core as a typed line would (a card, or at once under
// cards.typedTrades = "instant"), and the next only once the one before has ended, filled or done, as the
// core's cards and operations say. So `buy $1 of JUP; sell 100% of JUP` sizes the sell from what the buy
// bought, and Enter's card is always the chain's current one. A part rejected, expired, withdrawn, failed,
// refused or left without an answer stops the rest, and the message says what ran. If the view closes, the
// rest is never sent: nothing but the view holds it.
import type { ChainPart } from "./commands"
import type { CoreView, ViewCard } from "./store"

export interface RunningChain {
  parts: readonly ChainPart[]
  /** The part being sent or waited on, from 0. */
  at: number
  /** The typed line, put back to fix when the first part is refused (nothing ran). */
  line: string
  /** What part `at` waits on, once the core took it. */
  wait?: { cardId?: string; opId?: string }
  /** The request for part `at` hasn't been answered yet. */
  sending?: true
  /** Part `at`'s card is being approved: an approval after it expired comes back as a fresh card. */
  approving?: string
}

export type Verdict = { kind: "wait"; words: string } | { kind: "next" } | { kind: "stop"; why: string }

/** What the core's answer to a part says: it's done, there's a card or operation to wait on, or it stopped. */
export type Started = { kind: "done" } | { kind: "wait"; cardId?: string; opId?: string } | { kind: "stop"; why: string }

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** Part `n` (from 1) in the words of a stop. */
const nth = (r: RunningChain) => `part ${r.at + 1}`

/** The core's answer to a part: cards.propose for a trade, cli.run for a candle command. */
export function startedFrom(r: RunningChain, answer: unknown): Started {
  const a = rec(answer) ?? {}
  // A typed paper trade runs in the call (no card).
  const paper = rec(a.paper)
  if (paper) {
    if (paper.isError !== true) return { kind: "done" }
    const text = str(rec((paper.content as unknown[] | undefined)?.[0])?.text) ?? ""
    return { kind: "stop", why: `${nth(r)} was refused in paper mode${text ? `: ${text.slice(0, 160)}` : ""}` }
  }
  // A card, typed or instant, or a step in the prompt pane (its card is approved as typed).
  const card = a.kind === "pane" ? rec(a.card) : a
  const cardId = str(card?.cardId)
  const opId = str(card?.opId)
  if (cardId || opId) return { kind: "wait", ...(cardId ? { cardId } : {}), ...(opId ? { opId } : {}) }
  // A read or narrowing access, run in the call.
  if (a.success === false) return { kind: "stop", why: `${nth(r)} failed${str(rec(a.error)?.message) ? `: ${str(rec(a.error)?.message)}` : ""}` }
  return { kind: "done" }
}

/** The card a part waits on, through any card that replaced it (a wallet re-quote, the kill switch's fresh sell). */
function following(view: Pick<CoreView, "cards">, cardId: string): ViewCard | "missing" {
  let card = view.cards.find((c) => c.cardId === cardId)
  for (let i = 0; card?.replacedBy && i < 10; i++) {
    const next = view.cards.find((c) => c.cardId === card!.replacedBy)
    if (!next) return "missing"
    card = next
  }
  return card ?? "missing"
}

/** Whether part `at` has ended, from the cards and operations as the view holds them. */
export function judge(r: RunningChain, view: Pick<CoreView, "cards" | "operations" | "status">): Verdict {
  const waiting = (on: string): Verdict => ({ kind: "wait", words: `chain: part ${r.at + 1} of ${r.parts.length}, waiting on ${on}` })
  if (r.sending || !r.wait) return waiting("the core")
  let opId = r.wait.opId
  let cardState: string | undefined
  let cardOp: string | undefined
  let cardPaper = false
  if (r.wait.cardId) {
    const card = following(view, r.wait.cardId)
    if (card === "missing") {
      if (!opId) return waiting("the card")
    } else {
      opId = card.opId
      cardState = card.state
      cardOp = card.operation?.state
      cardPaper = card.operation?.paper === true
      if (card.state === "awaiting_approval") return waiting("the card")
      if (card.state === "rejected") return { kind: "stop", why: `you rejected ${nth(r)}` }
      if (card.state === "expired") return r.approving ? waiting("the card") : { kind: "stop", why: `${nth(r)}'s card expired` }
      if (card.state === "withdrawn") return { kind: "stop", why: `${nth(r)}'s card was withdrawn${view.status?.paused ? " by the kill switch" : ""}` }
    }
  }
  const op = opId ? view.operations[opId] : undefined
  const state = op?.state ?? cardOp
  if (state === undefined || state === "submitting" || state === "pending") return waiting(cardState === "approved" || op ? "Candle" : "the card")
  // Candle closed the key's paper position: nothing live was sold, so what follows would act on a sell that didn't happen.
  if (state === "succeeded" && (op?.paper || cardPaper)) return { kind: "stop", why: `${nth(r)} sold nothing live: the wallet held none, so Candle closed the key's paper position instead` }
  if (state === "succeeded") return { kind: "next" }
  const words = op?.error?.message ? `: ${op.error.message}` : ""
  if (state === "failed") return { kind: "stop", why: `${nth(r)} failed${words}` }
  if (state === "refused") return { kind: "stop", why: `${nth(r)} was refused${words}` }
  if (state === "unknown") return { kind: "stop", why: `${nth(r)} has no answer from Candle yet: re-send or abandon it on its card` }
  if (state === "abandoned") return { kind: "stop", why: `${nth(r)} was abandoned` }
  return { kind: "stop", why: `${nth(r)} ended ${state}` }
}

/**
 * The message when a chain stops: how many parts the core took, and why the rest weren't sent. `taken` is
 * whether part `at` itself reached the core (a card made, or run) before it stopped.
 */
export function stopWords(r: RunningChain, why: string, taken: boolean): string {
  const total = r.parts.length
  const sent = r.at + (taken ? 1 : 0)
  if (!taken) return `${sent} of ${total} sent; ${nth(r)}: ${why}${/[.!]$/.test(why) ? "" : "."}`
  if (r.at + 1 >= total) return `${sent} of ${total} sent; ${why}.`
  return `${sent} of ${total} sent; part ${r.at + 2} not sent: ${why}.`
}

export const doneWords = (r: RunningChain): string => `Chain done: ${r.parts.length} of ${r.parts.length} sent, each after the one before.`

/** The request a part makes of the core: the same a typed line of it makes. */
export function requestOf(part: ChainPart): { method: string; params: Record<string, unknown> } {
  const c = part.command
  if (c.kind === "trade") return { method: "cards.propose", params: { tool: c.tool, args: c.args, typed: true, ...(c.agent ? { agent: c.agent } : {}) } }
  return { method: "cli.run", params: { argv: c.argv, ...(c.agent ? { agent: c.agent } : {}) } }
}
