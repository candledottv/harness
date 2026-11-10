// A code bot's exits the core holds: a take profit, a stop, a max hold and a trailing stop on a position its own buy
// opened, watched with the rules bots' exit machinery (bot-exits.ts). A bot that crashes, is paused or is stopped by its
// supervisor leaves no position it guarded unwatched, and the kill switch lets them sell.
//
// - A buy may carry them (`exits` on `bot.buy`): they're on its `bot.request` row, journalled before anything is
//   proposed, so they hold from the moment its position exists, across a restart too.
// - A bot may set, change or clear them on a position it holds (`bot.exits`), and the person may remove them. Each is
//   a `bot.exits_set` row; the newest is what the position holds.
// - Everything here is read from the journal, and nothing else is kept.
import { type Exit, readHeldExit } from "../shared/definition"
import type { JournalRow } from "./journal"

/** Who set a position's held exits: its buy, the bot later, or the person (who only removes them). */
export type HeldBy = "buy" | "bot" | "person"

export interface Held {
  exit: Exit
  by: HeldBy
  at: string
}

const keyOf = (bot: string, request: string) => `${bot}\u0000${request}`

export class HeldExits {
  /** A buy's exits, by its bot and request id, until its position exists. */
  private readonly byRequest = new Map<string, { exit: Exit; at: string }>()
  /** Each position its request opened: an operation id, or `paper:<seq>`. */
  private readonly requestOf = new Map<string, string>()
  /** Exits set or cleared on a position after its buy: the newest wins, null when cleared. */
  private readonly set = new Map<string, { bot: string; exit: Exit | null; by: HeldBy; at: string }>()

  /** A journal row, as it's appended, or at start, oldest first. */
  note(row: JournalRow): void {
    if (row.type === "bot.request" && row.kind === "code" && row.side === "buy" && typeof row.name === "string" && typeof row.request === "string" && row.exits !== undefined) {
      const read = readHeldExit(row.exits)
      if (read.ok) this.byRequest.set(keyOf(row.name, row.request), { exit: read.exit, at: row.at })
      return
    }
    if (row.type === "bot.exits_set" && typeof row.name === "string" && typeof row.position === "string") {
      const read = row.exits === null || row.exits === undefined ? undefined : readHeldExit(row.exits)
      const by: HeldBy = row.by === "person" ? "person" : "bot"
      this.set.set(row.position, { bot: row.name, exit: read?.ok ? read.exit : null, by, at: row.at })
      return
    }
    if (typeof row.bot !== "string" || row.botKind !== "code" || row.botAct !== "entry" || typeof row.botRequest !== "string") return
    const key = keyOf(row.bot, row.botRequest)
    if (!this.byRequest.has(key)) return
    if (row.type === "card.created" && typeof row.opId === "string") this.requestOf.set(row.opId, key)
    else if (row.type === "paper.call" && row.isError !== true) this.requestOf.set(`paper:${row.seq}`, key)
  }

  /** What the core holds on a position now: its exits, and who set them. Undefined: none. */
  of(position: string): Held | undefined {
    const s = this.set.get(position)
    if (s) return s.exit ? { exit: s.exit, by: s.by, at: s.at } : undefined
    const key = this.requestOf.get(position)
    const r = key ? this.byRequest.get(key) : undefined
    return r ? { exit: r.exit, by: "buy", at: r.at } : undefined
  }
}

