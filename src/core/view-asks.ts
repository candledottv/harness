// The agent's changes to the screen: `harness_view`, answered by a view.
// The layouts, tabs and themes are the view's (layouts.toml, themes/, state/theme.json), so the core asks
// one view to make the change and answers the agent with what that view says.
//
// - Which view: the main view the person last pressed a key or clicked in (`view.active`), among those
//   listening on `asks`; a popped view never listens, since it shows one pane. With none used yet, the
//   newest one attached.
// - The ask goes on `asks` to that view alone, with an id; the view answers `view.answer` with it. No
//   answer within 5 s, or the view closing first, is said to the agent in words: nothing may have changed.
// - Each answer carries the view's short words for Activity ("switched Trade to Cockpit"), journalled as
//   the agent's `view.changed`. A refusal changes nothing and isn't journalled.
import { randomBytes } from "node:crypto"
import { terminalText } from "../shared/terminal-text"

export const ASK_TIMEOUT_MS = 5_000
/** What an answer's text and words may hold: the agent's tool answer budget is 16 KB, and Activity's line is short. */
const TEXT_MAX = 12 * 1024
const WORDS_MAX = 160

export type AskResult = { ok: true; text: string; words?: string } | { ok: false; code: string; message: string }

interface Pending {
  clientId: string
  resolve: (result: AskResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class ViewAsks {
  /** When each view last had a key or a click. */
  private readonly lastUsed = new Map<string, number>()
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly deps: {
      /** The views listening on `asks` now, oldest attached first. */
      listening: () => string[]
      publish: (data: unknown, clientId: string) => void
      now: () => number
      timeoutMs?: number
    },
  ) {}

  /** The person pressed a key or clicked in this view. */
  used(clientId: string): void {
    this.lastUsed.set(clientId, this.deps.now())
  }

  /** The view went: an ask it hadn't answered is answered for it. */
  detached(clientId: string): void {
    this.lastUsed.delete(clientId)
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId) continue
      this.settle(id, { ok: false, code: "VIEW_CLOSED", message: "The Candle Harness view closed before it answered, so the screen may not have changed." })
    }
  }

  /** The view the agent's change goes to, if any is open. */
  target(): string | undefined {
    return this.latest(this.deps.listening())
  }

  /** Of `ids`, the view the person last pressed a key or clicked in; with none used yet, the newest. */
  latest(ids: readonly string[]): string | undefined {
    if (ids.length === 0) return undefined
    let best: string | undefined
    let at = -1
    for (const id of ids) {
      const used = this.lastUsed.get(id) ?? -1
      if (used >= at) {
        best = id
        at = used
      }
    }
    return best
  }

  ask(agent: string, args: Record<string, unknown>): Promise<AskResult> {
    const clientId = this.target()
    if (clientId === undefined) return Promise.resolve({ ok: false, code: "NO_VIEW", message: "No Candle Harness view is open, so there's no screen to change." })
    const id = randomBytes(8).toString("base64url")
    return new Promise<AskResult>((resolve) => {
      const timer = setTimeout(
        () => this.settle(id, { ok: false, code: "VIEW_SLOW", message: `The Candle Harness view didn't answer within ${Math.round((this.deps.timeoutMs ?? ASK_TIMEOUT_MS) / 1000)} s, so the screen may or may not have changed.` }),
        this.deps.timeoutMs ?? ASK_TIMEOUT_MS,
      )
      timer.unref?.()
      this.pending.set(id, { clientId, resolve, timer })
      this.deps.publish({ id, agent, args }, clientId)
    })
  }

  /** A view's answer; only the view asked can give it. False when there's no such ask (late, or another view's). */
  answer(clientId: string, id: unknown, result: unknown): boolean {
    if (typeof id !== "string") return false
    const p = this.pending.get(id)
    if (!p || p.clientId !== clientId) return false
    this.settle(id, readAnswer(result))
    return true
  }

  private settle(id: string, result: AskResult): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(result)
  }
}

/** A view's answer as the agent may be given it: text cut to size and to plain terminal text. */
export function readAnswer(raw: unknown): AskResult {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const text = typeof r.text === "string" ? terminalText(r.text, { maxLength: TEXT_MAX, keepNewlines: true }) : ""
  if (r.ok !== true) {
    const code = typeof r.code === "string" && /^[A-Z_]{2,32}$/.test(r.code) ? r.code : "VIEW_REFUSED"
    return { ok: false, code, message: text || "The view couldn't make that change." }
  }
  const words = typeof r.words === "string" ? terminalText(r.words, { maxLength: WORDS_MAX }) : undefined
  return { ok: true, text: text || "Done.", ...(words ? { words } : {}) }
}
