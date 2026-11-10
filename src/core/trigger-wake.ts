// Waking an agent for a trigger: a turn treated like the person's message, with the holes that would open
// closed. What wakes it, and how often:
//
// - The woken turn opens with what woke it, in place of the person's words (transcript.ts `wokenPrompt`):
//   the trigger, what fired it, fenced as data, and the person's own words on the trigger. Its trades run as
//   the person's would: inside the wallet's figures with a receipt, over them as a card. It never counts as
//   the person asking (runner.ts `askedIn`), so funds out can't start from it.
// - Caps per woken agent, `[agents.<name>.wake]`: 4 woken turns an hour and 24 a day by default, each over
//   the last hour or 24 hours. A wake past either is skipped, said and notified, and nothing runs.
// - While the agent is busy, wakes wait as one woken turn: each that comes before it starts joins it as one
//   more line, and only the turn counts toward the caps.
// - The kill switch's pause holds wakes: nothing is woken until the person resumes.
//
// What happened is journalled under the firing: `trigger.woke` (the turn, and whether it joined one waiting),
// `trigger.wake_skipped` or `trigger.held`. The caps are read back from `trigger.woke` rows after a restart.
import type { SeenValue } from "../engine/gate"
import type { Wake } from "../engine/runner"
import type { ResolvedTrigger } from "../shared/trigger-grammar"
import type { Mode } from "./classify"
import type { Journal, JournalRow } from "./journal"
import type { TriggerNotice } from "./trigger-fire"
import type { FireCause } from "./triggers"
import type { TriggerEntry } from "./triggers-file"

export const WAKES_PER_HOUR = 4
export const WAKES_PER_DAY = 24
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export interface WakeCaps {
  perHour: number
  perDay: number
}

/** What a wake did, for the firing path and the tests. */
export type WakeEnd = { kind: "woke"; turnId: string; joined: boolean } | { kind: "skipped"; words: string } | { kind: "held"; words: string }

export interface WakerDeps {
  journal: Journal
  mode(): Mode
  now(): number
  runner: {
    wake(agent: string, wake: Wake): { turnId: string; queued: boolean; joined: boolean }
    wakeWaiting(agent: string): boolean
  }
  /** The agent's caps: config's `[agents.<name>.wake]`, else 4 an hour and 24 a day. */
  caps(agent: string): WakeCaps
  paused(): boolean
  notify?(notice: TriggerNotice): void
}

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** The token a firing names, as the source that showed it: Hacc for the tape and personal signals, Candle for the rest. */
function addressesOf(cause: FireCause): SeenValue[] {
  const mint = "mint" in cause ? cause.mint : undefined
  if (!mint) return []
  return [{ value: mint, source: cause.by === "tape" || cause.by === "mine" ? "hacc" : "candle" }]
}

export class Waker {
  /** When each agent's woken turns were started, oldest first: what its caps count. */
  private readonly woke = new Map<string, number[]>()
  /** The firings already counted as their turn started, before their row was written: the row isn't counted again. */
  private readonly counted = new Set<string>()

  constructor(private readonly deps: WakerDeps) {
    for (const row of deps.journal.rows()) this.note(row)
  }

  /** A woken turn started, from its journal row: counted toward its agent's caps. */
  private note(row: JournalRow): void {
    if (row.type !== "trigger.woke" || row.joined === true || typeof row.woke !== "string") return
    if (typeof row.fireId === "string" && this.counted.delete(row.fireId)) return
    const list = this.woke.get(row.woke) ?? []
    list.push(Date.parse(row.at))
    this.woke.set(row.woke, list)
  }

  /** How many woken turns the agent has had in the last hour and the last 24 hours. */
  used(agent: string): { hour: number; day: number } {
    const now = this.deps.now()
    const list = (this.woke.get(agent) ?? []).filter((at) => now - at < DAY_MS)
    this.woke.set(agent, list)
    return { hour: list.filter((at) => now - at < HOUR_MS).length, day: list.length }
  }

  /** The firing path's wake: `t`'s firing `fireId` wakes the agent its line names, or says why it didn't. */
  async wake(t: TriggerEntry, r: ResolvedTrigger, cause: FireCause, fireId: string): Promise<WakeEnd> {
    if (r.action.kind !== "wake") throw new Error("not a wake")
    const agent = r.action.agent
    const base = { mode: this.deps.mode(), agent: t.agent, name: t.name, fireId }
    if (this.deps.paused()) {
      const words = `the kill switch holds its wake of ${agent}, so ${agent} wasn't woken`
      await this.deps.journal.append({ type: "trigger.held", ...base, reason: "paused", words })
      this.deps.notify?.({ kind: "held", name: t.name, agent: t.agent, words })
      return { kind: "held", words }
    }
    // A wake that joins the woken turn already waiting starts nothing, so it isn't counted.
    if (!this.deps.runner.wakeWaiting(agent)) {
      const caps = this.deps.caps(agent)
      const used = this.used(agent)
      const over = used.hour >= caps.perHour ? `${agent} was woken ${times(used.hour)} in the last hour, its most (wake.perHour = ${caps.perHour})` : used.day >= caps.perDay ? `${agent} was woken ${times(used.day)} in the last 24 hours, its most (wake.perDay = ${caps.perDay})` : undefined
      if (over) {
        const words = `${over}, so it wasn't woken`
        await this.deps.journal.append({ type: "trigger.wake_skipped", ...base, woke: agent, words })
        this.deps.notify?.({ kind: "skipped", name: t.name, agent: t.agent, words })
        return { kind: "skipped", words }
      }
    }
    const fired = this.deps.journal.rows().findLast((row) => row.type === "trigger.fired" && row.fireId === fireId)
    const at = fired ? Date.parse(fired.at) : this.deps.now()
    const wake: Wake = {
      trigger: t.name,
      fireId,
      line: t.line,
      fired: typeof fired?.words === "string" ? fired.words : "its condition was met",
      at: hhmm(at),
      ...(r.action.words !== undefined ? { asked: r.action.words } : {}),
      addresses: addressesOf(cause),
      ...("mint" in cause && cause.mint ? { mint: cause.mint } : {}),
    }
    const started = this.deps.runner.wake(agent, wake)
    // Counted as the turn starts, before anything is awaited: two triggers firing together can't both pass the cap
    // on the same count.
    if (!started.joined) {
      const list = this.woke.get(agent) ?? []
      list.push(this.deps.now())
      this.woke.set(agent, list)
      this.counted.add(fireId)
    }
    const row = await this.deps.journal.append({ type: "trigger.woke", ...base, woke: agent, turnId: started.turnId, ...(started.joined ? { joined: true } : {}), words: wake.fired })
    this.note(row)
    return { kind: "woke", turnId: started.turnId, joined: started.joined }
  }
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`)
