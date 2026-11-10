// harness_triggers: the agent's own way to triggers. It reads every trigger (on or off, what holds it, when it
// last fired, its next run, how often a level is checked, and how its command will run now). It proposes a
// trigger as a one-press card that shows the exact line, the trigger in words, its agent and wallet, and
// whether it runs on its own or asks the person each time; nothing is saved before the press. It switches
// triggers off at once, and narrows one at once (a smaller amount, a level harder to reach, a longer cooldown,
// a filter that lets fewer tokens through, `again` dropped); anything else that changes one is a card. It can't
// switch one back on: that's the person's, as approved, from the main window. A turn the person started may
// switch off any agent's trigger ("stop all my triggers" means all). A turn a trigger woke may only read, and
// switch off its own agent's: it's the turn that reads other people's text with nobody watching, and switching
// off a stop removes protection. Narrowing at once is for the agent's own triggers; another agent's is a card.
// Offered on Pro and Max only, as triggers are.
import { canonicalJson } from "../shared/canonical-json"
import { defaultName, durationWords, isOnce, parseTriggerShape, partsOfAction, type ResolvedTrigger, type TapeFilters, type TriggerWhen } from "../shared/trigger-grammar"
import type { Mode } from "./classify"
import type { Mapped, Operation } from "./execute"
import type { FaceClient } from "./tool-face"
import { cooldownOf, type Runs, type TriggerBook, type TriggerCheck } from "./triggers"
import type { TriggerEntry } from "./triggers-file"

export const TRIGGERS_TOOL_NAME = "harness_triggers"

export const TRIGGERS_TOOL = {
  name: TRIGGERS_TOOL_NAME,
  description:
    'The person\'s triggers: "when X, do Y", run by the Candle Harness with no model and no turn, in milliseconds, the same every time. Read the harness-triggers skill with skill_read before you propose one. ' +
    '"read" lists every trigger: on or off, what holds it, when it last fired, its next run, and how its command will run now. ' +
    '"propose" takes the exact line (when JUP < $0.40 sell 50% of JUP, every day 09:00 buy $5 of JUP, when confluence mcap < 500k wake agent-a, with again, cooldown 2h and as "<name>" at the end) and makes a card the person approves with one press: nothing is saved before it. Clarify first whatever the person\'s words leave open: the token (by its mint), the level, the amount, the wallet, once or again. ' +
    'With replace and name (a saved trigger\'s), a smaller amount, a level harder to reach, a longer cooldown or a filter that lets fewer tokens through changes it at once; for a trigger that sells, a smaller amount or a level harder to reach is a card, since it protects less; anything else is a card. ' +
    '"off" switches one off (name) or every one (all), at once; in a turn a trigger woke, only this agent\'s own. Only the person switches one back on. ' +
    "A trigger is paper or live as it was approved, whatever mode the Candle Harness is in later: one proposed now takes the mode now, and read says each one's.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["read", "propose", "off"] },
      line: { type: "string", description: '"propose": the trigger, exactly, in the grammar the harness-triggers skill sets out.' },
      replace: { type: "boolean", description: '"propose": true to change the saved trigger named in name.' },
      name: { type: "string", description: '"off", and "propose" with replace: the trigger\'s name, as "read" gives it.' },
      all: { type: "boolean", description: '"off": true for every trigger that\'s on.' },
      reason: { type: "string", description: '"propose": why, in a sentence; it shows on the card.' },
    },
    required: ["action"],
  },
}

const MAX_LINE = 1000

/** What changes a trigger at once, or what makes it a card. */
export type Narrowing = { narrows: true; what: string[] } | { narrows: false }

const AMOUNTS = new Set(["amountUsd", "amount", "percent"])
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN)

/** A level made harder to reach: lower under `<`, higher over `>`. */
function harder(op: "<" | ">", was: number, now: number): boolean {
  return op === "<" ? now <= was : now >= was
}

/** The condition made harder to meet, or undefined when it's another condition. */
function whenNarrows(was: TriggerWhen, now: TriggerWhen): string[] | undefined {
  if (was.kind !== now.kind) return undefined
  const same = canonicalJson(was) === canonicalJson(now)
  if (same) return []
  switch (was.kind) {
    case "price":
    case "mcap":
    case "pnl": {
      const n = now as typeof was
      if (("token" in was ? was.token : "") !== ("token" in n ? n.token : "") || was.op !== n.op || !harder(was.op, was.usd, n.usd)) return undefined
      // Another window is another figure, not a level harder to reach.
      if (("window" in was ? was.window : undefined) !== ("window" in n ? n.window : undefined)) return undefined
      return [`its level, from ${was.figure} to ${n.figure}`]
    }
    case "entry": {
      const n = now as typeof was
      if (was.token !== n.token || was.dir !== n.dir || n.percent < was.percent) return undefined
      return [`its level, from ${was.dir} ${was.percent}% to ${n.dir} ${n.percent}%`]
    }
    case "tape": {
      const n = now as typeof was
      if (was.pattern !== n.pattern) return undefined
      return filtersNarrow(was.filters, n.filters) ? ["its filters, which let fewer tokens through"] : undefined
    }
    case "mine": {
      const n = now as typeof was
      return was.rule === undefined && n.rule !== undefined ? [`to the rule "${n.rule}" alone`] : undefined
    }
    case "schedule": {
      const n = now as typeof was
      if (was.every.kind !== "interval" || n.every.kind !== "interval" || n.every.ms < was.every.ms) return undefined
      return [`its schedule, from every ${durationWords(was.every.ms)} to every ${durationWords(n.every.ms)}`]
    }
    case "event": {
      const n = now as typeof was
      if (was.event === "bot" || n.event === "bot") return undefined
      return was.event === n.event && was.token === undefined && n.token !== undefined ? ["to one token's fills"] : undefined
    }
  }
}

/** Every filter kept and at least as strict, any added: fewer tokens through. */
function filtersNarrow(was: TapeFilters, now: TapeFilters): boolean {
  if (was.maxMcapUsd !== undefined && !(now.maxMcapUsd !== undefined && now.maxMcapUsd <= was.maxMcapUsd)) return false
  if (was.minMcapUsd !== undefined && !(now.minMcapUsd !== undefined && now.minMcapUsd >= was.minMcapUsd)) return false
  if (was.maxAgeMinutes !== undefined && !(now.maxAgeMinutes !== undefined && now.maxAgeMinutes <= was.maxAgeMinutes)) return false
  if (was.minAgeMinutes !== undefined && !(now.minAgeMinutes !== undefined && now.minAgeMinutes >= was.minAgeMinutes)) return false
  if (was.group !== undefined && now.group !== was.group) return false
  if (was.chain !== undefined && now.chain !== was.chain) return false
  return true
}

/** The action the same but for smaller amounts, part by part, or undefined when it does something else. */
function actionNarrows(was: ResolvedTrigger["action"], now: ResolvedTrigger["action"]): string[] | undefined {
  if (was.kind !== now.kind) return undefined
  if (was.kind !== "command" || now.kind !== "command") return canonicalJson(was) === canonicalJson(now) ? [] : undefined
  const a = partsOfAction(was.command)
  const b = partsOfAction(now.command)
  if (a.length !== b.length) return undefined
  const what: string[] = []
  for (const [i, p] of a.entries()) {
    const q = b[i]!
    if (p.tool !== q.tool || (p.agent ?? "") !== (q.agent ?? "")) return undefined
    const keys = new Set([...Object.keys(p.args), ...Object.keys(q.args)])
    for (const k of keys) {
      const x = p.args[k]
      const y = q.args[k]
      if (!AMOUNTS.has(k)) {
        if (canonicalJson(x ?? null) !== canonicalJson(y ?? null)) return undefined
        continue
      }
      if (x === undefined || y === undefined) return undefined
      const [m, n] = [num(x), num(y)]
      if (!Number.isFinite(m) || !Number.isFinite(n) || n > m) return undefined
      if (n < m) what.push(`${a.length > 1 ? `part ${i + 1}'s amount` : "its amount"}, from ${amountText(k, x)} to ${amountText(k, y)}`)
    }
  }
  return what
}
const amountText = (key: string, v: unknown) => (key === "amountUsd" ? `$${String(v)}` : key === "percent" ? `${String(v)}%` : String(v))

/** Whether an action sells: a sell, or a swap (which sells what it swaps from), alone or as part of a chain. */
function actionSells(action: ResolvedTrigger["action"]): boolean {
  if (action.kind !== "command") return false
  return partsOfAction(action.command).some((p) => p.tool === "candle_swap" || p.args.side !== "buy")
}

/** A condition on a level: a sell's stop or target, where harder to reach means it protects less. */
const LEVEL_KINDS = new Set<TriggerWhen["kind"]>(["price", "mcap", "pnl", "entry"])

/**
 * Whether `next` only narrows the saved trigger `t`: the same agent, condition and action, with a level
 * harder to reach, smaller amounts, a longer cooldown, fewer tokens let through, or `again` dropped. Anything
 * else, a change of wording included, isn't a narrowing, and goes to the person as a card. For a trigger that
 * sells, a smaller amount or a level harder to reach is wider, not narrower: a stop that sells 1% at $0.01 rather
 * than 100% at $0.40 protects far less. Those are cards too.
 */
export function narrowing(t: TriggerEntry, was: ResolvedTrigger, next: ResolvedTrigger): Narrowing {
  if (next.name !== t.name || next.agent !== t.agent) return { narrows: false }
  const when = whenNarrows(was.when, next.when)
  const action = when && actionNarrows(was.action, next.action)
  if (!when || !action) return { narrows: false }
  if (actionSells(was.action) || actionSells(next.action)) {
    if (action.length > 0) return { narrows: false }
    if (when.length > 0 && LEVEL_KINDS.has(was.when.kind)) return { narrows: false }
  }
  const what = [...when, ...action]
  if (next.again && !t.again) return { narrows: false }
  if (t.again && !next.again) what.push("it fires once now, rather than again")
  const before = cooldownOf(t, was.class)
  const after = cooldownOf({ again: next.again, ...(next.shape.cooldownMs !== undefined ? { cooldownMs: next.shape.cooldownMs } : {}) }, next.class)
  if (before !== undefined && after !== undefined) {
    if (after < before) return { narrows: false }
    if (after > before) what.push(`its cooldown, from ${durationWords(before)} to ${durationWords(after)}`)
  }
  return what.length ? { narrows: true, what } : { narrows: false }
}

/** The card's own words: the exact line, the trigger in words, and how it will run. */
export interface TriggerSpec {
  line: string
  words: string
  runs: string
  /** Which kind it is, for the card's box: on its own, a card each time, a notice, a wake. */
  kind?: Runs["runs"]
  /** The agent it belongs to, when another than the one proposing it. */
  agent?: string
  /** It replaces the saved trigger of that name. */
  replaces?: true
  /** Paper or live: what the press binds it to. */
  mode?: Mode
}

/** A wake's caps, said on its card. */
export interface WakeCapsWords {
  perHour: number
  perDay: number
}

/** How it runs, in words, with a wake's caps where it wakes an agent. */
export function runsWords(runs: Runs, caps: WakeCapsWords | undefined): string {
  if (runs.runs !== "wakes" || !caps) return runs.words
  const capped = caps.perHour === 0 || caps.perDay === 0 ? "Its wakes are switched off in config.toml (wake.perHour or wake.perDay is 0), so it never wakes." : `It wakes at most ${caps.perHour} an hour and ${caps.perDay} a day; past either, the wake is skipped and said.`
  return `${runs.words} ${capped}`
}

export interface TriggerCardInput {
  check: TriggerCheck
  spec: TriggerSpec
  /** The wallet that pays, in the card's who line: "embedded", or its name. */
  paysFrom?: string
  /** In amber: it will wait for the person, and a wallet of its own is suggested. */
  warning?: string
  fills?: { label: string; line: string }[]
}

/** A trigger as `read` gives it: in words, with how it will run now. */
export function readOf(book: TriggerBook, runsNow: (t: TriggerEntry) => string | undefined): Record<string, unknown> {
  const topic = book.view()
  return {
    success: true,
    ...(topic.gate ? { gate: `${topic.gate.words}.${topic.gate.fix ? ` The owner upgrades with ${topic.gate.fix}.` : ""}` } : {}),
    triggers: topic.triggers.map((t) => {
      const entry = book.entry(t.name)
      const runs = entry ? runsNow(entry) : undefined
      return {
        name: t.name,
        agent: t.agent,
        line: t.line,
        words: t.words,
        on: t.on,
        mode: t.mode,
        ...(t.held ? { held: t.held.words } : {}),
        ...(t.class === "level" ? { armed: t.armed } : {}),
        ...(t.lastFired ? { lastFired: t.lastFired } : {}),
        ...(t.nextRun ? { nextRun: t.nextRun } : {}),
        ...(t.watching ? { watching: t.watching } : {}),
        ...(runs ? { runs } : {}),
        ...(t.readsNow ? { readsNow: t.readsNow } : {}),
      }
    }),
    ...(topic.problems.length ? { problems: topic.problems } : {}),
    changing:
      'propose makes a card for a new trigger, or a change to one (replace). A narrowing (a smaller amount, a level harder to reach, a longer cooldown) with replace happens at once, except that a trigger that sells with a smaller amount or a level harder to reach is a card. off switches one off at once. Only the person switches one back on, in the main window.',
  }
}

/** What a call comes to: an answer, a card (by its operation id) for the face to answer as every card is, or a refusal. */
export type TriggersOutcome = { ok: true; body: Record<string, unknown> } | { card: string } | { ok: false; code: string; message: string }

export interface TriggersToolDeps {
  book: TriggerBook
  /** Proposes the trigger's card, answering its operation id; throws an RpcError refusal. */
  propose(client: FaceClient, card: TriggerCardInput, reason?: string): Promise<string>
  /** The trigger that woke the turn a harness token was minted for, if one did. */
  wokenBy(tokenId: string): string | undefined
  /** An agent's wake caps, `[agents.<name>.wake]`. */
  caps(agent: string): WakeCapsWords
  /** For a trigger that would ask the person each time: chips toward a wallet of its own (a vault first where there's none). */
  ownWallet(agent: string): { label: string; line: string }[]
}

const refusedBy = (error: unknown): TriggersOutcome => {
  const e = error as { code?: unknown; message?: unknown }
  if (typeof e.code !== "string") throw error
  return { ok: false, code: e.code, message: String(e.message) }
}

/** How a trigger that's off got there, as far as the book says: a once that fired switched itself off; anything else was switched off. */
function offHow(book: TriggerBook, t: TriggerEntry): string {
  const r = book.resolved(t)
  const s = book.stateOf(t.name)
  const once = r !== undefined && ((r.class === "level" && !t.again) || isOnce(r.when))
  return once && s?.lastFired ? "switched itself off when it fired, as it fires once" : "was switched off (by the person or an agent; it doesn't switch itself off)"
}

export class TriggersTool {
  constructor(private readonly deps: TriggersToolDeps) {}

  async call(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<TriggersOutcome> {
    const action = args.action
    if (action !== "read" && action !== "propose" && action !== "off") return { ok: false, code: "MCP_VALIDATION", message: "action is one of read, propose, off." }
    if (action === "read") return { ok: true, body: readOf(this.deps.book, (t) => this.runsNow(t)) }
    const woken = client.role === "harness" && client.tokenId ? this.deps.wokenBy(client.tokenId) : undefined
    if (action === "off") return this.off(client, args, woken)
    if (woken) {
      return { ok: false, code: "WOKEN_TURN", message: `The trigger "${woken}" woke this turn, so it may only read triggers and switch them off. Adding or changing one is the person's: say what you'd propose, and they'll ask for it.` }
    }
    if (typeof args.line !== "string" || args.line.trim() === "" || args.line.length > MAX_LINE) return { ok: false, code: "MCP_VALIDATION", message: `line is the trigger, exactly, up to ${MAX_LINE} characters.` }
    // A change to a saved trigger goes by its name: a line with no name of its own takes it.
    let line = args.line.trim()
    if (args.replace === true && typeof args.name === "string" && args.name !== "") {
      const shape = parseTriggerShape(line)
      if (shape.ok && shape.value.name === undefined) line = `${line} as "${args.name}"`
      else if (shape.ok && shape.value.name !== args.name) return { ok: false, code: "MCP_VALIDATION", message: `The line is named "${shape.value.name}", and name is "${args.name}". A trigger keeps its name: leave as "<name>" out of the line.` }
    }
    return this.propose(client, line, args.replace === true, reason)
  }

  /** How a saved trigger's command will run now, with a wake's caps. */
  runsNow(t: TriggerEntry): string | undefined {
    const runs = this.deps.book.runsNow(t)
    if (!runs) return undefined
    const r = this.deps.book.resolved(t)
    return runsWords(runs, r?.action.kind === "wake" ? this.deps.caps(r.action.agent) : undefined) || undefined
  }

  private async off(client: { clientId: string; agent: string }, args: Record<string, unknown>, woken: string | undefined): Promise<TriggersOutcome> {
    const book = this.deps.book
    let names: string[]
    // A turn a trigger woke reaches its own agent's triggers only; the rest stay as the person left them.
    const reach = (t: TriggerEntry) => woken === undefined || t.agent === client.agent
    const leftOn = args.all === true ? book.entries().filter((t) => book.isOn(t) && !reach(t)) : []
    if (args.all === true) names = book.entries().filter((t) => book.isOn(t) && reach(t)).map((t) => t.name)
    else if (typeof args.name === "string" && args.name.length > 0 && args.name.length <= 64) names = [args.name]
    else return { ok: false, code: "MCP_VALIDATION", message: "off takes name (a trigger's name) or all: true." }
    const others = leftOn.length ? { leftOn: `Left on, since ${leftOn.length === 1 ? "it's" : "they're"} another agent's and a trigger woke this turn: ${leftOn.map((t) => `"${t.name}" (${t.agent})`).join(", ")}. The person switches ${leftOn.length === 1 ? "it" : "them"} off, or asks for it in a message of their own.` } : {}
    if (args.all === true && names.length === 0) return { ok: true, body: { success: true, done: leftOn.length ? `No trigger of ${client.agent}'s is on, so nothing changed.` : "No trigger is on, so nothing changed.", ...others } }
    const named = args.all === true ? undefined : book.entry(names[0]!)
    if (named && !reach(named)) {
      return { ok: false, code: "ANOTHER_AGENTS", message: `"${named.name}" is ${named.agent}'s, and the trigger "${woken}" woke this turn, so it switches off only ${client.agent}'s own. Say why you'd switch it off, and the person will. Nothing changed.` }
    }
    const said: string[] = []
    try {
      for (const name of names) {
        const t = book.entry(name)
        if (t && !book.isOn(t)) {
          said.push(`"${name}" was already off.`)
          continue
        }
        said.push((await book.set(name, false, { clientId: client.clientId, main: false, how: "agent", agent: client.agent, ...(woken ? { woken } : {}) })).said)
      }
    } catch (error) {
      return refusedBy(error)
    }
    // The ones already off, and how, so the agent doesn't guess (it said two schedules had switched themselves off,
    // which schedules never do: the person had).
    const already = args.all === true ? book.entries().filter((t) => !book.isOn(t) && !names.includes(t.name)).map((t) => `"${t.name}" ${offHow(book, t)}`) : []
    return { ok: true, body: { success: true, done: said.join(" "), ...others, ...(already.length ? { alreadyOff: `Already off: ${already.join("; ")}.` } : {}), backOn: "Only the person switches a trigger back on, as it was approved, in the main window." } }
  }

  private async propose(client: FaceClient, line: string, replace: boolean, reason?: string): Promise<TriggersOutcome> {
    const book = this.deps.book
    // The saved trigger this line would change, by the name it gives or would go by: a change keeps the P&L window
    // it was approved with unless the line names another.
    const shape = parseTriggerShape(line)
    const first = replace && shape.ok ? book.entry(shape.value.name ?? defaultName(shape.value.conditionText)) : undefined
    const window = first ? book.windowOf(first) : undefined
    // A narrowing of one that runs as approved (not one changed by hand since) changes it at once: the agent's own
    // only, read in the trigger's own mode, which a narrowing never changes. Another agent's goes to the person.
    const hand = first ? book.heldBy(first) : undefined
    if (first && first.agent === client.agent && hand?.code !== "NOT_APPROVED" && hand?.code !== "CHANGED_OUTSIDE") {
      const was = book.resolved(first)
      let own: TriggerCheck | undefined
      try {
        own = book.check(line, client.agent, { mode: book.modeOf(first), ...(window ? { pnlWindow: window } : {}) })
      } catch {
        // Whatever stops it reading is said by the check below, in the mode a card would be made in.
      }
      const n = own && was && own.trigger.name === first.name ? narrowing(first, was, own.trigger) : undefined
      if (own && n?.narrows) {
        try {
          await book.narrow(first.name, own, { clientId: client.clientId, agent: client.agent, what: n.what })
        } catch (error) {
          return refusedBy(error)
        }
        return { ok: true, body: { success: true, done: `Changed "${first.name}" at once, since it only narrows it: ${n.what.join("; ")}.`, line: own.line, words: own.trigger.words, on: book.isOn(book.entry(first.name)!) } }
      }
    }
    let check: TriggerCheck
    try {
      check = book.check(line, client.agent, window ? { pnlWindow: window } : {})
    } catch (error) {
      return refusedBy(error)
    }
    const t = check.trigger
    const saved = book.entry(t.name)
    if (saved && !replace) {
      return { ok: false, code: "NAME_TAKEN", message: `A trigger named "${t.name}" is saved already (${saved.line}). To change it, propose again with replace: true; for another one, give it a name of its own with as "<name>". Nothing was proposed.` }
    }
    if (!saved && replace) return { ok: false, code: "UNKNOWN_TRIGGER", message: `No saved trigger is named "${t.name}", so there's nothing to replace. Leave replace out to propose a new one.` }
    const runs = check.runs
    const caps = t.action.kind === "wake" ? this.deps.caps(t.action.agent) : undefined
    const spec: TriggerSpec = {
      line: check.line,
      words: t.words,
      runs: runsWords(runs, caps) || "How it runs is said when it fires.",
      kind: runs.runs,
      ...(t.agent !== client.agent ? { agent: t.agent } : {}),
      ...(saved ? { replaces: true as const } : {}),
      mode: check.mode,
    }
    const pays = t.action.kind === "command" ? book.payWalletOf(t) : undefined
    const amber = runs.amber ? `${runs.amber[0]!.toUpperCase()}${runs.amber.slice(1)}.` : undefined
    const warning = runs.runs === "asks" ? [amber, runs.suggestion].filter(Boolean).join(" ") : undefined
    try {
      const opId = await this.deps.propose(
        client,
        {
          check,
          spec,
          ...(pays ? { paysFrom: pays } : {}),
          ...(warning ? { warning } : {}),
          ...(runs.runs === "asks" ? { fills: this.deps.ownWallet(t.agent) } : {}),
        },
        reason,
      )
      return { card: opId }
    } catch (error) {
      return refusedBy(error)
    }
  }
}

/** A trigger's card's params: the line as the card showed it, who proposed it, its expansion, and whether it replaces one. */
export interface TriggerCardParams {
  line: string
  proposer: string
  name: string
  expansion: string
  replace: boolean
  /** Paper or live, as the card was made: what the trigger is saved as. Absent on a card from before triggers kept one. */
  mode?: Mode
}

/**
 * An approved trigger card, saved: checked whole again, refused when the line reads differently now (an alias
 * or a name changed since the card was made) or the name was taken meanwhile.
 */
export async function runTriggerCard(book: TriggerBook, op: Pick<Operation, "params" | "cardId" | "opId">): Promise<Mapped> {
  const p = op.params as unknown as TriggerCardParams
  try {
    const saved = await book.save(p.line, p.proposer, { expansion: p.expansion, replace: p.replace, cardId: op.cardId, opId: op.opId, ...(p.mode ? { mode: p.mode } : {}) })
    const t = book.entry(saved.name)
    return { state: "succeeded", result: { done: true, trigger: saved.name, replaced: saved.replaced, on: t ? book.isOn(t) : true } }
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown }
    return { state: "refused", error: { code: typeof e.code === "string" ? e.code : "NOT_SAVED", message: String(e.message ?? error), retryable: false } }
  }
}

/** A trigger card a restart cut off: saved, if triggers.toml holds it as the card said and it's approved as that. */
export function readTriggerCard(book: TriggerBook, op: Pick<Operation, "params">): Mapped {
  const p = op.params as unknown as TriggerCardParams
  const t = book.entry(p.name)
  if (t && t.expansion === p.expansion && book.heldBy(t)?.code !== "NOT_APPROVED" && book.heldBy(t)?.code !== "CHANGED_OUTSIDE") {
    return { state: "succeeded", result: { done: true, trigger: p.name, readBack: "Read from triggers.toml: it was saved." } }
  }
  return { state: "failed", error: { code: "NOT_SAVED", message: `The core stopped before "${p.name}" was saved. Nothing was saved; ask for it again.`, retryable: false } }
}
