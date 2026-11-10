// From outside: `candle-harness cards` lists the cards the running core holds and how each ended, for a script
// or an agent outside the Candle Harness that sent a message with `candle-harness ask` and needs to know what
// became of the card it left waiting. It only reads: it attaches as a view that only reads, asks for the
// list, and with --wait listens until nothing is waiting or running. No option approves, rejects or changes a
// card, and the core refuses an approval from this client whatever it sends: the press stays in the Candle Harness.
//
// Exit codes: 0 listed; 1 the core went away while it waited; 2 usage; 3 no core running; 4 refused.
import { CARDS_CLIENT, connectView, type CoreConnection } from "../core/client"
import type { Paths } from "../paths"
import { EXIT, type OutsideDeps, type OutsideIo, reach, refusal } from "./ask"

const USAGE = `Usage: candle-harness cards [--json] [--wait] [--all] [<card id>]
  Lists the cards the Candle Harness holds, newest last, and how each ended. It only reads: a card is
  approved by a press in the Candle Harness, never from here.
  --wait   wait until no card is waiting for a press or still running (or, with a card id, until that one ended)
  --json   one JSON object on stdout: { cards: [{ cardId, opId, kind, agent, mode, title, state, ended, … }] }
  --all    every card the core holds, rather than the newest 20 and any still open
  Exit codes: 0 listed; 1 the core went away; 2 usage; 3 no core running; 4 refused.
`

/** Where a card stands, in one word a script can switch on. */
export type CardStanding = "waiting" | "running" | "done" | "failed" | "refused" | "unknown" | "abandoned" | "rejected" | "expired" | "withdrawn"

/** A card as `cards` and `ask --json` print it: what it is, where it stands, and how it ended, in words. */
export interface CardRow {
  cardId: string
  opId: string
  kind: string
  agent: string
  mode?: string
  title: string
  state: CardStanding
  /** How it ended, or what it waits on, in words. */
  ended: string
  /** Whether nothing more will happen to it. */
  final: boolean
  /** How it was approved, where it was. */
  approved?: string
  /** Candle's or the core's code, where it failed or was refused. */
  code?: string
  proposedBy?: string
  createdAt?: string
  expiresAt?: string
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

const HOW: Record<string, string> = { enter: "by Enter", click: "by a click", instant: "as typed", typed: "as typed", view: "in the Candle Harness", "inside-limits": "without a card, inside the wallet's limits", "bot-exit": "without a card, as a bot's exit" }

/** One card from the core's list or its `cards` topic, as a row. */
export function cardRow(card: Record<string, unknown>): CardRow {
  const display = record(card.display)
  const op = record(card.operation)
  const origin = record(card.origin)
  const approved = str(card.approvedHow)
  const code = str(record(op?.error)?.code)
  const cardState = String(card.state ?? "")
  let state: CardStanding
  let ended: string
  if (op) {
    const s = String(op.state ?? "")
    if (s === "succeeded") [state, ended] = ["done", op.paper === true ? "done: Candle closed the key's paper position, nothing live was sold" : "done"]
    else if (s === "failed") [state, ended] = ["failed", `failed${code ? `: ${code}` : ""}`]
    else if (s === "refused") [state, ended] = ["refused", `refused${code ? `: ${code}` : ""}`]
    else if (s === "unknown") [state, ended] = ["unknown", "Candle hasn't confirmed it: it's read back in the Candle Harness, and isn't proof that nothing moved"]
    else if (s === "abandoned") [state, ended] = ["abandoned", "left unresolved by the person"]
    else [state, ended] = ["running", "approved and running"]
  } else if (cardState === "awaiting_approval") [state, ended] = ["waiting", `waiting for a press in the Candle Harness${str(card.expiresAt) ? `, until ${new Date(String(card.expiresAt)).toLocaleTimeString([], { hour12: false })}` : ""}`]
  else if (cardState === "approved") [state, ended] = ["running", "approved and running"]
  else if (cardState === "rejected") [state, ended] = ["rejected", "rejected by the person"]
  else if (cardState === "expired") [state, ended] = ["expired", "expired with no press"]
  else [state, ended] = ["withdrawn", "withdrawn"]
  const by = origin?.role === "view" ? "you" : record(origin?.trigger) ? `trigger ${String(record(origin?.trigger)?.name ?? "")}`.trim() : record(origin?.bot) ? `bot ${String(record(origin?.bot)?.name ?? "")}`.trim() : origin?.role === "harness" ? String(card.agent ?? "") : undefined
  return {
    cardId: String(card.cardId ?? ""),
    opId: String(card.opId ?? ""),
    kind: String(card.kind ?? ""),
    agent: String(card.agent ?? ""),
    ...(str(card.mode) ? { mode: String(card.mode) } : {}),
    title: str(display?.headline) ?? str(display?.title) ?? String(card.tool ?? "a card"),
    state,
    ended: approved && state !== "waiting" ? `${ended} · approved ${HOW[approved] ?? approved}` : ended,
    final: state !== "waiting" && state !== "running" && state !== "unknown",
    ...(approved ? { approved } : {}),
    ...(code ? { code } : {}),
    ...(by ? { proposedBy: by } : {}),
    ...(str(card.createdAt) ? { createdAt: String(card.createdAt) } : {}),
    ...(str(card.expiresAt) ? { expiresAt: String(card.expiresAt) } : {}),
  }
}

const open = (r: CardRow) => r.state === "waiting" || r.state === "running"

const realConnect = (p: Paths, clientName: string) => connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName })

/** `candle-harness cards`. */
export async function cardsCommand(args: string[], io: OutsideIo, d: OutsideDeps): Promise<number> {
  let json = false
  let wait = false
  let all = false
  let only: string | undefined
  for (const a of args) {
    if (a === "--json") json = true
    else if (a === "--wait") wait = true
    else if (a === "--all") all = true
    else if (a === "--help" || a === "-h") return io.out(USAGE), EXIT.done
    else if (a.startsWith("-") || only !== undefined) {
      io.err(`${a.startsWith("-") ? `Unknown option ${a.slice(0, 40)}.` : "One card id at most."}\n\n${USAGE}`)
      return EXIT.usage
    } else only = a
  }
  const p = await reach(io, d)
  if (typeof p === "number") return p
  let connection: CoreConnection
  try {
    ;({ connection } = await (d.connect ?? realConnect)(p, CARDS_CLIENT))
  } catch (error) {
    return refusal(io, error)
  }
  try {
    const held = new Map<string, Record<string, unknown>>()
    let wake: (() => void) | undefined
    let gone = false
    connection.onEvent((e) => {
      const data = record(e.data)
      if (e.snapshot || e.topic !== "cards" || typeof data?.cardId !== "string") return
      held.set(data.cardId, data)
      wake?.()
    })
    connection.onClose(() => {
      gone = true
      wake?.()
    })
    try {
      // Listening first, so a card that ends between the list and the wait isn't missed.
      if (wait) await connection.request("subscribe", { topics: ["cards"] })
      const listed = (await connection.request("cards.list", {})) as { cards?: unknown }
      for (const card of Array.isArray(listed.cards) ? listed.cards : []) {
        const c = record(card)
        if (typeof c?.cardId === "string" && !held.has(c.cardId)) held.set(c.cardId, c)
      }
    } catch (error) {
      return refusal(io, error)
    }
    const rows = () => [...held.values()].map(cardRow).filter((r) => only === undefined || r.cardId === only || r.opId === only)
    if (only !== undefined && rows().length === 0) {
      io.err(`No card with the id ${only.slice(0, 80)}: it may be from before this core started. The Journal has it.\n`)
      return EXIT.refused
    }
    if (wait) {
      if (!json && rows().some(open)) io.err("Waiting for the press in the Candle Harness, or the card's expiry. This only reads.\n")
      while (rows().some(open)) {
        if (gone) {
          io.err("The core closed while cards were still open. What was running is read back when it next starts; the Candle Harness shows it.\n")
          return EXIT.failed
        }
        await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
      }
    }
    const sorted = rows().sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    const shown = all || only !== undefined ? sorted : sorted.filter((r, i) => open(r) || i >= sorted.length - 20)
    if (json) io.out(`${JSON.stringify({ cards: shown, ...(shown.length < sorted.length ? { older: sorted.length - shown.length } : {}) })}\n`)
    else if (shown.length === 0) io.out("No cards: nothing is waiting, and none has been proposed since this core started.\n")
    else {
      const width = (pick: (r: CardRow) => string) => Math.max(...shown.map((r) => pick(r).length))
      const [w1, w2, w3] = [width((r) => r.cardId), width((r) => r.kind), width((r) => r.agent)]
      for (const r of shown) io.out(`${r.cardId.padEnd(w1)}  ${r.kind.padEnd(w2)}  ${r.agent.padEnd(w3)}  ${r.title}  ·  ${r.ended}\n`)
      if (shown.length < sorted.length) io.out(`${sorted.length - shown.length} older: --all lists them.\n`)
    }
    return EXIT.done
  } finally {
    connection.close()
  }
}
