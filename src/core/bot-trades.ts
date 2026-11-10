// The rules for a bot's trades, in one place, for every kind of bot: a rules bot's entries and exits, and a code bot's
// requests. A bot never trades as the person or the agent does. Its trade is the core's own proposal, by its own
// client, with the run settings its card approved:
//
// - Its mode and slippage are its card's, never the Candle Harness's or what the bot asked: `botClient` sets them, and
//   only the core's own client carries a bot (tool-face.ts `modeFor`).
// - Its buys and swaps go through its wallet's figures (a receipt inside them, a card over them or on a wallet that
//   asks), never typed-instant. Its sells of its own positions run with no card on any wallet, approved as
//   `bot-exit` (cards.ts `exitCheck`); it sells only what its own fills bought (bot-book.ts `sellPlan`).
// - The kill switch holds its buys and swaps; its sells go on (cards.ts refuses a paused buy for every client).
// - Candle's breaker is kept clear of (breaker.ts, failed-sells.ts): the pace (sells first), a failing route, and two
//   failed sells of a token holding the third. A trigger's trade keeps to the same pace and holds.
// - Candle stopping a key pauses every bot on it, so none enters when its owner resumes the key.
// - Its notices fold per bot every 5 minutes (notifier.ts), from the bot's name on every row its trade causes.
import { randomBytes } from "node:crypto"
import { refused } from "../shared/rpc"
import { RouteWaits, TradePace } from "./breaker"
import type { Card } from "./cards"
import { classify, type Mode, normaliseForMode } from "./classify"
import { FAILED_SELLS_HOLD, FailedSells } from "./failed-sells"
import type { JournalRow } from "./journal"
import type { Side } from "./limits"
import type { BotOrigin, CardDesk, CardView, FaceClient } from "./tool-face"

/** A bot's own client id: the core's, one per bot. */
export const BOT_CLIENT_PREFIX = "core:bot:"

/** What a bot's card approved, that every trade of its takes: never what the bot asks for. */
export interface BotRun {
  /** A rules bot (a definition the core runs) or a code bot (the person's own code). Absent: a rules bot. */
  kind?: "rules" | "code"
  name: string
  agent: string
  /** Paper or live, approved on its card: its trades go so whatever the Candle Harness's mode is. */
  mode: "paper" | "live"
  /** The slippage bound approved on its card, where it has one. */
  slippageBps?: number
}

/** What one trade of a bot is: an entry or an exit, and what it's about. Never its mode or slippage. */
export type BotAct = Pick<BotOrigin, "act" | "position" | "signal" | "reason" | "outside" | "request" | "partial" | "sellsRaw">

/** A code bot's request id: one per trade it asks for, journalled before the trade is proposed. */
export const botRequestId = (): string => `req_${randomBytes(9).toString("base64url")}`

/** The core's own client for one trade of a bot: its mode and slippage from its run settings, nothing else. */
export function botClient(run: BotRun, act: BotAct): FaceClient {
  const bot: BotOrigin = {
    name: run.name,
    act: act.act,
    ...(act.position !== undefined ? { position: act.position } : {}),
    ...(act.signal !== undefined ? { signal: act.signal } : {}),
    ...(act.reason !== undefined ? { reason: act.reason } : {}),
    ...(act.outside !== undefined ? { outside: act.outside } : {}),
    mode: run.mode,
    ...(run.slippageBps !== undefined ? { slippageBps: run.slippageBps } : {}),
    ...(run.kind === "code" ? { kind: "code" as const } : {}),
    ...(act.request !== undefined ? { request: act.request } : {}),
    ...(act.partial ? { partial: true as const } : {}),
    ...(act.sellsRaw ? { sellsRaw: act.sellsRaw } : {}),
  }
  return { clientId: `${BOT_CLIENT_PREFIX}${run.name}`, role: "core", agent: run.agent, bot }
}

/** What holds the core's own trade on a key now under Candle's breaker. */
export interface BreakerHold {
  why: "pace" | "route"
  until: number
  words: string
}

export interface BotTradesDeps {
  /** The journal's window, read once at start: what the pace, failing routes and failed sells count from. */
  rows: readonly JournalRow[]
  now(): number
  /** Candle stopped an agent's key: every bot on it is paused. */
  pauseKeyBots(agent: string): Promise<unknown>
  /** The tool face, for a paper trade. Read when a trade is sent, so it may be built after this. */
  face(): { call(client: FaceClient, tool: string, args: Record<string, unknown>): Promise<unknown> }
  /** The card desk. Read when a trade is sent, so it may be built after this. */
  cards(): Pick<CardDesk, "propose"> & {
    runWithoutCard(card: CardView, client: FaceClient): Promise<{ card: Card; ran?: unknown }>
    withdraw(clientId: string, cardId: unknown): Promise<unknown>
    get(cardId: string): Card | undefined
  }
  /** Sleeps until a time; a test may hurry it. */
  sleep?(ms: number): Promise<void>
}

const sleepFor = (ms: number) =>
  new Promise<void>((r) => {
    const timer = setTimeout(r, ms)
    timer.unref?.()
  })

export class BotTrades {
  /** Failed sells of one token in a row, per key: the breaker's third. */
  readonly failedSells: FailedSells
  /** Each key's trades in the last minute: the pace bots and triggers keep to. */
  readonly pace: TradePace
  /** The pairs Candle's route breaker refuses on a key now. */
  readonly routes: RouteWaits

  constructor(private readonly deps: BotTradesDeps) {
    this.failedSells = new FailedSells(deps.rows)
    this.pace = new TradePace(deps.rows)
    this.routes = new RouteWaits(deps.rows)
  }

  /** A journal row, as it's appended. */
  note(row: JournalRow): void {
    this.failedSells.note(row)
    this.pace.note(row)
    this.routes.note(row)
    // Paper runs Candle's breaker too: a paper trade it refused for a stopped key pauses the key's bots as a live one does.
    if (row.type === "paper.call" && row.isError === true && typeof row.agent === "string" && /RISK_LIMIT_REACHED/.test(String(row.answer ?? ""))) void this.deps.pauseKeyBots(row.agent).catch(() => {})
  }

  /** An operation's outcome: Candle stopping the key pauses every bot on it, so none enters when the owner resumes it. */
  noteOperation(op: { agent: string; error?: { code?: string } }): void {
    if (op.error?.code === "RISK_LIMIT_REACHED") void this.deps.pauseKeyBots(op.agent).catch(() => {})
  }

  /** Candle's breaker for the core's own trade on a key now: what holds it, or room, with its slot taken. */
  room(agent: string, mint: string | undefined, side: Side, label: string): BreakerHold | undefined {
    const at = this.deps.now()
    const route = mint ? this.routes.held(agent, mint, side, at) : undefined
    if (route !== undefined) return { why: "route", until: route, words: this.routes.words(agent, label, side, route, at) }
    const slot = this.pace.take(agent, at, side)
    return slot.ok ? undefined : { why: "pace", until: slot.until, words: slot.words }
  }

  /** A bot's entry: what holds it, in the entries' words, or room with its slot taken. */
  entryRoom(agent: string, mint: string, label: string): { code: "pace" | "route_failing"; words: string } | undefined {
    const held = this.room(agent, mint, "buy", label)
    return held ? { code: held.why === "route" ? "route_failing" : "pace", words: held.words } : undefined
  }

  /** A bot's exit: what holds it and until when, or room with its slot taken. */
  exitRoom(agent: string, mint: string, label: string): BreakerHold | undefined {
    return this.room(agent, mint, "sell", label)
  }

  /**
   * What holds the core's re-send of a bot's exit lost in a restart, in words, or undefined with its pace slot taken:
   * the failed-sells hold (the re-send itself aside, in flight under its own id), then the breaker's room for a sell.
   */
  resendHold(agent: string, mint: string, opId: string, label: string): string | undefined {
    if (this.failedSells.held(agent, mint, opId)) return this.failedSells.words(agent, label, mint, opId)
    return this.exitRoom(agent, mint, label)?.words
  }

  /** The words the person's own sell carries when one more failed sell of the token would stop the key. */
  sellWarning(agent: string, mint: string, label: string): string | undefined {
    const failed = this.failedSells.count(agent, mint)
    if (failed >= FAILED_SELLS_HOLD) return `Two sells of ${label} in a row failed on ${agent}'s key: if this one fails too, Candle stops the key, sells included, until you resume it in the Agent Console.`
    // Sells still under way may fail too: with them, this one could be the third.
    if (this.failedSells.atRisk(agent, mint)) {
      const flying = this.failedSells.inFlight(agent, mint)
      const so = failed ? `A sell of ${label} failed on ${agent}'s key and ${flying === 1 ? "another is" : `${flying} more are`} still under way` : `${flying} sells of ${label} are still under way on ${agent}'s key`
      return `${so}: if they fail and this one does too, Candle stops the key, sells included, until you resume it in the Agent Console.`
    }
    return undefined
  }

  /**
   * The core's own trade that isn't a bot's (a trigger's): a pair Candle's route breaker refuses, and a sell after two
   * failed sells of its token, are refused in words; past the key's pace a buy or swap is refused and a sell waits for
   * the next slot, and goes in it.
   */
  async waitForRoom(part: { tool: string; args: Record<string, unknown> }, agent: string, label: (mint: string) => string): Promise<void> {
    if (part.tool !== "candle_trade" && part.tool !== "candle_swap") return
    const side: Side = part.tool === "candle_swap" ? "swap" : part.args.side === "sell" ? "sell" : "buy"
    const mint = part.tool === "candle_trade" && typeof part.args.mint === "string" ? part.args.mint : undefined
    const name = mint ? label(mint) : "it"
    if (side === "sell" && mint && this.failedSells.held(agent, mint)) throw refused("FAILED_SELLS", `Its sell waits: ${this.failedSells.words(agent, name, mint)}.`)
    for (;;) {
      const held = this.room(agent, mint, side, name)
      if (!held) return
      if (held.why === "route" || side !== "sell") throw refused(held.why === "route" ? "ROUTE_FAILING" : "BREAKER_PACE", `${held.words[0]!.toUpperCase()}${held.words.slice(1)}. Nothing was sent.`)
      await (this.deps.sleep ?? sleepFor)(Math.max(50, Math.min(60_000, held.until - this.deps.now())))
    }
  }

  /**
   * A bot's trade, as its own, by its own client, in its own mode: a paper trade, or a card proposed and run through
   * its wallet's figures (a buy or swap) or its own exit rule (a sell of its own), never typed-instant. Answers as
   * `cards.propose` does (with `instant` where it ran with no card), or `{ paper }`. A refusal before anything reached
   * Candle throws, and an exit's card it left open is withdrawn, so nobody is asked to press it. `check` sees the card
   * as proposed (valued) before it can run: a refusal it names withdraws the card, and nothing is sent.
   */
  async send(trade: { tool: string; args: Record<string, unknown> }, given: FaceClient, botMode: Mode, reason: string, check?: (card: Card) => { code: string; words: string } | undefined): Promise<unknown> {
    // The bot's own mode, whatever the Candle Harness's: the face and the card desk read it from the client's bot.
    const client: FaceClient = { ...given, ...(given.bot ? { bot: { ...given.bot, mode: botMode } } : {}) }
    const verdict = classify(trade.tool, trade.args, botMode)
    if (verdict.class === "refused") throw refused(verdict.code, verdict.reason)
    if (verdict.class === "paper") return { paper: await this.deps.face().call(client, trade.tool, trade.args) }
    if (verdict.class !== "card") throw refused("NOT_A_CARD", "A bot only buys and sells.")
    const cards = this.deps.cards()
    const card = await cards.propose({ client, agent: client.agent, tool: trade.tool, args: trade.args, params: normaliseForMode(trade.tool, trade.args, botMode), kind: verdict.kind, idKey: verdict.idKey, reason })
    const proposed = cards.get(card.cardId)
    const no = check ? (proposed ? check(proposed) : { code: "CARD_GONE", words: "Its card closed before it could be checked, so nothing was sent." }) : undefined
    if (no) {
      await cards.withdraw(client.clientId, card.cardId).catch(() => {})
      throw refused(no.code, no.words)
    }
    try {
      const alone = await cards.runWithoutCard(card, client)
      if (alone.ran) return { ...alone.card, instant: alone.ran }
    } catch (error) {
      // An exit refused at approval (a key Candle stopped): no card waits for a press that would be refused too.
      if (client.bot?.act === "exit") await cards.withdraw(client.clientId, card.cardId).catch(() => {})
      throw error
    }
    return cards.get(card.cardId) ?? card
  }
}
