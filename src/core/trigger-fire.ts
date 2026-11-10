// Firing a trigger: what it does once its firing is recorded (triggers.ts `fired`, which journals
// `trigger.fired` before this runs, so a core that stops here never fires it again).
//
// - A command (a trade, sell or swap, or a chain or alias of them) is proposed part by part as the trigger's
//   own, by the core's own client: never as typed, so `cards.typedTrades = "instant"` never applies. Each part
//   then runs through its wallet's figures: inside them it runs with a receipt; over them, or on a wallet that
//   asks every time, it's a card that waits for the person, says why and is notified. The agent's limits,
//   the kill switch's pause and a key Candle holds refuse a part at proposal as they refuse any card. A chain's
//   next part goes only once the one before has filled, as a typed chain's does, judged by the same rule.
// - Paper or live is the trigger's own, as its card was approved, whatever mode the Candle Harness is in when it
//   fires: a paper trigger's part runs as its agent's paper trade, a live one's as a card or a trade with a receipt.
// - `it` is the token that fired it: the tape's or a personal signal's token, put into the line's parts here.
// - `notify` is journalled and handed to the notifier; a wake is handed to the waker (trigger-wake.ts), which
//   holds it while paused and skips it past the woken agent's caps.
// - Every card, row and paper trade a firing causes carries its origin (the trigger's name, the firing, the
//   part), so nothing a trigger did is worded as the person's, and an `on fill` or `on card expired`
//   trigger never fires on its own trigger's rows.
//
// "Run it now": a trigger's card that expired with nobody there is proposed again at a fresh price, from the
// part that expired on, by the person's click in the main view. It isn't a firing: the trigger's cooldown
// and arming stay as they are, and it runs even after a level that fires once has switched itself off.
import { randomBytes } from "node:crypto"
import { refused } from "../shared/rpc"
import type { ChainPart, Command } from "../shared/commands"
import { IT_MINT, partsOfAction, type ResolvedTrigger, renderCommand } from "../shared/trigger-grammar"
import type { ChainCard, ChainOperation } from "../shared/chain"
import { type ChainEnd, ChainRunner } from "./chain-runner"
import type { Mode } from "./classify"
import type { Journal, JournalRow } from "./journal"
import type { FaceClient, TriggerOrigin } from "./tool-face"
import type { FireCause, Gate } from "./triggers"
import type { TriggerEntry } from "./triggers-file"
import { short } from "./wallet-names"

/** The core's own client, for every trigger's cards: its own open-card cap, apart from the person's and the agents'. */
export const TRIGGERS_CLIENT = "core:triggers"

type Trade = Extract<Command, { kind: "trade" }>

/** What a firing tells the person, through the notifier: in Activity's words, with no address or key. */
export interface TriggerNotice {
  kind: "notify" | "waiting" | "held" | "stopped" | "skipped"
  name: string
  agent: string
  words: string
  cardId?: string
}

/** A trigger's card as the firing path reads it: enough to judge a chain, and why it waits. */
export interface FiringCard extends ChainCard {
  agent: string
  display: { cardBecause?: string; walletLabel?: string; headline?: string; title: string }
  origin: { trigger?: TriggerOrigin }
}

export interface TriggerFireDeps {
  book: {
    resolved(t: TriggerEntry): ResolvedTrigger | undefined
    entry(name: string): TriggerEntry | undefined
    gate(agent?: string): Gate
    /** Paper or live, as the trigger was approved. */
    modeOf(t: TriggerEntry): Mode
  }
  journal: Journal
  /**
   * Sends one part as the trigger's own, in the trigger's mode (on the client): on paper its agent's paper trade; live, proposed as a card and
   * run without one where its wallet's figures allow. Answers as `cards.propose` does; a throw is a refusal
   * at proposal (the agent's limits, the pause, a held key), and nothing of that part ran.
   */
  send(part: Trade, client: FaceClient): Promise<unknown>
  card(cardId: string): FiringCard | undefined
  operation(opId: string): ChainOperation | undefined
  paused(): boolean
  /** A token's name, where the core knows one, for the words. */
  nameOf(mint: string): string | undefined
  /** Hands what a firing says to the notifier. */
  notify?(notice: TriggerNotice): void
  /** Wakes the trigger's agent (trigger-wake.ts); until it's set, a wake is said and nothing more. */
  wake?(t: TriggerEntry, r: ResolvedTrigger, cause: FireCause, fireId: string): Promise<{ kind: "woke"; turnId: string; joined: boolean } | { kind: "skipped" | "held"; words: string }>
}

/** What a firing did, for its caller and the tests. */
export type FireEnd =
  | { kind: "notified" }
  | { kind: "woke"; turnId: string; joined: boolean }
  | { kind: "skipped" | "held"; words: string }
  | { kind: "ran"; end: ChainEnd }
  | { kind: "stopped"; words: string }

/** How a firing ended, for `candle-harness trigger`: whether it did all it says, and in words. */
export function fireEndSaid(end: FireEnd): { ok: boolean; words: string; turnId?: string } {
  switch (end.kind) {
    case "notified":
      return { ok: true, words: "it notified you" }
    case "woke":
      return { ok: true, words: end.joined ? "it joined the woken turn already waiting" : "it woke the agent", turnId: end.turnId }
    case "ran":
      // One trade's "done" is the chain's words for one part: said as the trade.
      return { ok: end.end.kind === "done", words: end.end.kind === "done" && end.end.sent === 1 ? "its trade went through" : end.end.words }
    default:
      return { ok: false, words: end.words }
  }
}

/** A part's args with `it` as the token that fired: every value that names it. */
function withIt(c: Trade, mint: string | undefined): Trade | undefined {
  const uses = Object.values(c.args).some((v) => v === IT_MINT)
  if (!uses) return c
  if (!mint) return undefined
  return { ...c, args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, v === IT_MINT ? mint : v])) }
}

const errorCode = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; data?: { code?: unknown } } | undefined
  return typeof e?.data?.code === "string" ? e.data.code : typeof e?.code === "string" ? e.code : undefined
}

/** The refusals that keep a trigger's trade clear of Candle's breaker (breaker.ts), with their fallback words. */
const BREAKER_HOLDS: Readonly<Record<string, string>> = {
  ROUTE_FAILING: "Candle's route breaker refuses this token on this side for now, so it wasn't sent",
  FAILED_SELLS: "two sells of this token failed in a row, and one more would stop the key on Candle, so it wasn't sent",
  BREAKER_PACE: "the key is at the pace bots and triggers keep to, clear of Candle's breaker, so it wasn't sent",
}

export class TriggerFirer {
  readonly chains: ChainRunner

  constructor(private readonly deps: TriggerFireDeps) {
    this.chains = new ChainRunner({
      card: (cardId) => this.deps.card(cardId),
      operation: (opId) => this.deps.operation(opId),
      paused: () => this.deps.paused(),
    })
  }

  /** A card or an operation changed: every trigger's chain waiting on one is judged again. */
  poke(): void {
    this.chains.poke()
  }

  /** The core is stopping: no more of any trigger's chain is sent. */
  stop(why: string): void {
    this.chains.stopAll(why)
  }

  /** The book's firer: what `t` does, now its firing `fireId` is recorded. */
  async fire(t: TriggerEntry, cause: FireCause, fireId: string): Promise<FireEnd> {
    const r = this.deps.book.resolved(t)
    if (!r) return this.stopped(t, fireId, "its line no longer reads (an agent or a wallet it names is gone), so it did nothing")
    if (r.action.kind === "notify") {
      // The person's words say what to look at; the token that fired it says which one, or every notice reads alike.
      const token = "mint" in cause && cause.mint ? (this.deps.nameOf(cause.mint) ?? short(cause.mint)) : undefined
      const words = r.action.words !== undefined ? `${r.action.words}${token ? ` · ${token}` : ""}` : this.whenSaid(t, cause)
      await this.deps.journal.append({ type: "trigger.notify", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId, words })
      this.deps.notify?.({ kind: "notify", name: t.name, agent: t.agent, words })
      return { kind: "notified" }
    }
    if (r.action.kind === "wake") {
      if (!this.deps.wake) return this.stopped(t, fireId, `waking ${r.action.agent} isn't in this core yet, so nothing ran`)
      return this.deps.wake(t, r, cause, fireId)
    }
    const mint = "mint" in cause ? cause.mint : undefined
    return this.run(t, r, fireId, 0, mint)
  }

  /**
   * The person's "run it now" on a trigger's expired card: that part and the rest of its line, proposed again
   * at a fresh price, as a new run of the same trigger. Refused for a card that isn't a trigger's, isn't
   * expired, or whose trigger is gone or held.
   */
  async runNow(card: { cardId: string; state: string; trigger?: TriggerOrigin }, by: string): Promise<{ runId: string; said: string; ended: Promise<FireEnd> }> {
    if (!card.trigger) throw refused("NOT_A_TRIGGER_CARD", "Run it now is for a trigger's card. Re-quote this one instead.")
    if (card.state !== "expired") throw refused("CARD_NOT_EXPIRED", `This card is ${card.state.replace("awaiting_approval", "waiting for you")}; run it now is for one that expired.`)
    const t = this.deps.book.entry(card.trigger.name)
    if (!t) throw refused("UNKNOWN_TRIGGER", `The trigger "${card.trigger.name}" is removed, so its line can't run again. Nothing was sent.`)
    const gate = this.deps.book.gate(t.agent)
    if (gate.state !== "ok") throw refused(gate.state === "free" ? "TRIGGERS_NEED_PLAN" : "PLAN_UNKNOWN", `${gate.words} Nothing was sent.`)
    const r = this.deps.book.resolved(t)
    if (!r || r.action.kind !== "command") throw refused("TRIGGER_CHANGED", `"${t.name}" no longer reads as the trade it ran. Nothing was sent.`)
    const fired = this.firedRow(card.trigger.fireId)
    const cause = fired?.cause as { mint?: unknown } | undefined
    const mint = typeof cause?.mint === "string" ? cause.mint : undefined
    const runId = `fire_${randomBytes(9).toString("base64url")}`
    await this.deps.journal.append({ type: "trigger.run_now", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId: runId, from: card.trigger.fireId, cardId: card.cardId, part: card.trigger.part, by })
    const parts = partsOfAction(r.action.command).length
    const ended = this.run(t, r, runId, card.trigger.part, mint)
    ended.catch(() => {})
    const rest = parts - card.trigger.part
    return { runId, said: `"${t.name}": ${rest > 1 ? `its last ${rest} parts` : "its trade"} proposed again at a fresh price.`, ended }
  }

  private firedRow(fireId: string): JournalRow | undefined {
    return this.deps.journal.rows().findLast((row) => row.type === "trigger.fired" && row.fireId === fireId)
  }

  private whenSaid(t: TriggerEntry, cause: FireCause): string {
    const on = "mint" in cause && cause.mint ? ` on ${this.deps.nameOf(cause.mint) ?? short(cause.mint)}` : ""
    return `"${t.name}" fired${on}`
  }

  /** Runs the command's parts from `from` on, each after the one before, as the trigger's own. */
  private async run(t: TriggerEntry, r: ResolvedTrigger, fireId: string, from: number, mint: string | undefined): Promise<FireEnd> {
    if (r.action.kind !== "command") return { kind: "stopped", words: "" }
    const all = partsOfAction(r.action.command)
    const parts: { trade: Trade; part: number }[] = []
    for (const [i, c] of all.entries()) {
      if (i < from) continue
      const trade = withIt(c, mint)
      if (!trade) return this.stopped(t, fireId, "it didn't say which token fired it, so nothing ran")
      parts.push({ trade, part: i })
    }
    const nameOf = (m: string) => this.deps.nameOf(m) ?? short(m)
    const chain: ChainPart[] = parts.map((p) => ({ command: p.trade, text: renderCommand(p.trade, nameOf) }))
    const line = chain.map((p) => p.text).join("; ")
    const end = await this.chains.run(chain, line, (part, at) => this.sendPart(t, fireId, parts[at]!.part, part.command as Trade))
    // A single trade that reached the core is said by its card's and operation's rows (a lost answer among them,
    // read back on its own); a chain says how it ended, and a part refused before anything ran says why.
    if (chain.length > 1 || (end.kind === "stopped" && end.sent === 0)) {
      await this.deps.journal.append({ type: "trigger.ran", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId, outcome: end.kind, words: end.words, sent: end.sent, parts: chain.length })
      if (end.kind === "stopped") this.deps.notify?.({ kind: "stopped", name: t.name, agent: t.agent, words: end.words })
    }
    return { kind: "ran", end }
  }

  private async sendPart(t: TriggerEntry, fireId: string, part: number, trade: Trade): Promise<unknown> {
    const client: FaceClient = { clientId: TRIGGERS_CLIENT, role: "core", agent: t.agent, trigger: { name: t.name, fireId, part, mode: this.deps.book.modeOf(t) } }
    let answer: unknown
    try {
      answer = await this.deps.send(trade, client)
    } catch (error) {
      // The kill switch holds a trigger's buys and swaps; its sells still go.
      if (errorCode(error) === "PAUSED") {
        const words = `the kill switch holds its ${trade.tool === "candle_swap" ? "swap" : "buy"}, so it wasn't sent`
        await this.deps.journal.append({ type: "trigger.held", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId, part, reason: "paused", words })
        this.deps.notify?.({ kind: "held", name: t.name, agent: t.agent, words })
      }
      // Candle's breaker, kept clear of: a failing route, two failed sells of the token, or the key's pace full.
      const breaker = BREAKER_HOLDS[errorCode(error) ?? ""]
      if (breaker) {
        const said = (error as { message?: unknown }).message
        const words = typeof said === "string" ? said : breaker
        await this.deps.journal.append({ type: "trigger.held", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId, part, reason: errorCode(error)!, words })
        this.deps.notify?.({ kind: "held", name: t.name, agent: t.agent, words })
      }
      throw error
    }
    // Over its wallet's figures, or on a wallet that asks every time: a card that waits for the person.
    const a = answer as { cardId?: unknown; state?: unknown; instant?: unknown } | undefined
    if (typeof a?.cardId === "string" && a.state === "awaiting_approval" && a.instant === undefined) {
      const card = this.deps.card(a.cardId)
      const because = card?.display.cardBecause ?? `${card?.display.walletLabel && card.display.walletLabel !== "embedded" ? card.display.walletLabel : "the embedded wallet"} asks every time`
      const words = `${card?.display.headline ?? card?.display.title ?? "its trade"} waits for you: ${because}`
      await this.deps.journal.append({ type: "trigger.waiting", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId, part, cardId: a.cardId, because, words })
      this.deps.notify?.({ kind: "waiting", name: t.name, agent: t.agent, words, cardId: a.cardId })
    }
    return answer
  }

  private async stopped(t: TriggerEntry, fireId: string, words: string): Promise<FireEnd> {
    await this.deps.journal.append({ type: "trigger.ran", mode: this.deps.book.modeOf(t), agent: t.agent, name: t.name, fireId, outcome: "stopped", words, sent: 0 })
    this.deps.notify?.({ kind: "stopped", name: t.name, agent: t.agent, words })
    return { kind: "stopped", words }
  }
}
