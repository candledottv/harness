// Hacc's changes. Follows, alert rules, the account's
// own groups and saved strategies are account state on Hacc: they move no funds and can't trade, and
// every key on the account shares them, so another app sees what the agent changed.
//
// - **Adds run at once**, as paper trades do: a follow, a group, a wallet into a group, a strategy saved
//   or a new version. Each is journalled as `hacc.change`, shown in Activity, and carries an undo the
//   person runs with one click (the click is the press). Undoing a strategy's save retires it, since Hacc
//   deletes none.
// - **Removals are a one-press card** titled with what goes: an unfollow, a group deleted, a wallet taken
//   out of a group, a strategy retired. What's removed may be the person's own work from another app.
// - **A rule's add is the card instead** (Hacc has no route that removes or disables a rule): the card says
//   it can't be removed and how many of the 20 it leaves. There's no rule removal until Candle adds a route.
// - **Replays are reads** that save nothing: run at once, polled here, and answered when done, or with
//   their job id once the wait is up. The core goes on polling and says in Activity how it ended.
// - **The kill switch doesn't touch any of it,** since none of it spends.
//
// Every route and shape is as Hacc's real server answered; the caps are Candle's docs
// (docs.candle.tv/developers/data-and-strategy-api).
import { randomUUID } from "node:crypto"
import { canonicalJson } from "../shared/canonical-json"
import { refused } from "../shared/rpc"
import { terminalText } from "../shared/terminal-text"
import type { Mode } from "./classify"
import type { Mapped, Operation } from "./execute"
import type { HaccAnswer, HaccClient } from "./hacc"
import { dataAnswer, pageList, REPLAY_PAGES, type ToolAnswer } from "./hacc-tools"
import type { Journal, JournalRow } from "./journal"
import type { HaccPlan } from "./plan-state"
import type { CardDesk, CardView, FaceClient } from "./tool-face"
import { short } from "./wallet-names"

type Json = Record<string, unknown>
type Method = "POST" | "PATCH" | "DELETE"

/** Candle's docs: follows and groups by plan, 20 rules, 20 saves and 20 replays a day. */
export const CAPS = {
  follows: { pro: 25, max: 100 },
  groups: { pro: 1, max: 5 },
  groupWallets: 25,
  rules: 20,
  savesPerDay: 20,
  replaysPerDay: 20,
} as const

export const RULE_PATTERNS = ["new_ticker", "confluence", "large_move", "dormancy", "distribution"] as const
type RulePattern = (typeof RULE_PATTERNS)[number]
/** What each pattern's `params` takes, and needs (the docs, and Hacc's recorded bodies). */
const RULE_PARAMS: Record<RulePattern, { takes: readonly string[]; needs: readonly string[] }> = {
  new_ticker: { takes: ["min_usd"], needs: [] },
  confluence: { takes: ["wallets", "window_minutes"], needs: ["wallets"] },
  large_move: { takes: ["min_usd"], needs: ["min_usd"] },
  dormancy: { takes: ["days"], needs: ["days"] },
  distribution: { takes: ["min_usd"], needs: [] },
}
const RULE_PARAM_NAMES = ["min_usd", "wallets", "window_minutes", "days"] as const

/** How long a tool call waits for a replay before answering with its id: under Codex's 60 s for an MCP call. */
export const REPLAY_WAIT_MS = 45_000
const REPLAY_POLL_MS = 3_000
/** After the call has answered, the core polls on, until Hacc's own 10-minute stop has passed. */
const REPLAY_WATCH_POLL_MS = 10_000
const REPLAY_WATCH_MS = 11 * 60_000
/** A removal Hacc didn't answer, read back still in place after this, didn't happen. */
const NOT_LANDED_AFTER_MS = 30_000

const name = (v: unknown, max = 60) => terminalText(String(v ?? ""), { maxLength: max })
const usdText = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
const record = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined)
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => record(x) !== undefined) : [])
const dayOf = (iso: string) => iso.slice(0, 10)
const planName = (plan: HaccPlan | undefined) => (plan === "max" ? "Max" : "Pro")

/** What an undo sends, and the words for it. `emptyGroup`: undo only while the group the agent made is still empty. */
export interface Undo {
  method: Method
  route: string
  body?: Json
  words: string
  guard?: "emptyGroup"
}

interface Change {
  changeId: string
  agent: string
  words: string
  undo?: Undo
  undone: boolean
}

/** A Hacc card's params: exactly what runs, and the view, which picks its read-back. */
export interface HaccCardParams {
  method: Method
  route: string
  body?: Json
  view: string
}

export interface HaccChangeDeps {
  hacc: Pick<HaccClient, "get" | "send">
  cards: Pick<CardDesk, "propose">
  journal: Journal
  mode(): Mode
  now(): number
  plan(agent: string): HaccPlan | undefined
  onPlanRefused?(agent: string): void
  /** Timer seam; tests drive the replay's wait. */
  sleep?(ms: number): Promise<void>
  replayWaitMs?: number
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())

export class HaccChanges {
  private readonly changes = new Map<string, Change>()
  /** Replays the core is still polling, so each one's end is said once. */
  private readonly watching = new Set<number>()
  private stopped = false

  constructor(private readonly deps: HaccChangeDeps) {}

  stop(): void {
    this.stopped = true
  }

  /** Undos survive a restart: they're rebuilt from the journal's `hacc.change` rows. */
  rebuild(rows: readonly JournalRow[]): void {
    for (const row of rows) {
      if (row.type !== "hacc.change") continue
      if (typeof row.undoOf === "string") {
        const held = this.changes.get(row.undoOf)
        if (held) held.undone = true
        continue
      }
      if (typeof row.changeId !== "string" || typeof row.agent !== "string") continue
      const undo = record(row.undo) as Undo | undefined
      this.changes.set(row.changeId, { changeId: row.changeId, agent: row.agent, words: String(row.words ?? ""), ...(undo ? { undo } : {}), undone: false })
    }
  }

  /** A change view of `hacc_follows` or `hacc_lab`, its arguments already checked against the view. */
  async call(client: FaceClient, tool: string, view: string, args: Json): Promise<ToolAnswer> {
    const agent = client.agent
    switch (view) {
      case "follow":
        return this.follow(agent, tool, args)
      case "unfollow":
        return this.unfollow(client, tool, args)
      case "add_rule":
        return this.addRule(client, tool, args)
      case "create_group":
        return this.createGroup(agent, tool, args)
      case "delete_group":
        return this.deleteGroup(client, tool, args)
      case "group_add":
        return this.groupAdd(agent, tool, args)
      case "group_remove":
        return this.groupRemove(client, tool, args)
      case "save_strategy":
      case "save_version":
        return this.saveStrategy(agent, tool, view, args)
      case "retire":
        return this.retire(client, tool, args)
      case "run_replay":
        return this.runReplay(agent, tool, args)
      case "cancel_replay":
        return this.cancelReplay(agent, tool, args)
    }
    return fail("UNKNOWN_VIEW", `${view} isn't one of ${tool}'s changes.`)
  }

  // -------------------------------------------------------------------------------------------------------
  // At once, with an undo.

  private async follow(agent: string, tool: string, args: Json): Promise<ToolAnswer> {
    const address = String(args.address)
    const chain = typeof args.chain === "string" ? args.chain : "solana"
    // Hacc answers a second follow of a wallet with the first, and its undo would unfollow what the
    // person already had: so look first.
    const before = await this.deps.hacc.get(agent, "/v1/me/follows")
    if (before.kind === "refused") return this.refusedAnswer(agent, before)
    const follows = list(record(before.body)?.follows)
    const held = follows.find((f) => f.address === address)
    if (held) return dataAnswer(tool, "follow", { already: true, follow: held, words: `Already followed since ${String(held.created_at ?? "before")}; nothing changed.` })
    const got = await this.deps.hacc.send(agent, "POST", "/v1/me/follows", { chain, address })
    if (got.kind === "refused") {
      if (got.code === "HACC_LIMIT") return this.refusedAnswer(agent, got, `${this.followCap(agent, follows.length)}. An unfollow, which the person approves on a card, makes room.`)
      return this.refusedAnswer(agent, got)
    }
    const follow = record(record(got.body)?.follow) ?? {}
    const words = `followed ${short(address)}`
    const undo: Undo | undefined = follow.id !== undefined ? { method: "DELETE", route: `/v1/me/follows/${Number(follow.id)}`, words: `unfollow ${short(address)}` } : undefined
    const changeId = await this.journalChange(agent, tool, "follow", words, undo)
    return dataAnswer(tool, "follow", { follow, changeId, words: `Followed ${short(address)}: done, and the person can undo it from Activity. ${this.followCap(agent, follows.length + 1)}.` })
  }

  private async createGroup(agent: string, tool: string, args: Json): Promise<ToolAnswer> {
    const groupName = name(args.name, 80)
    const before = await this.deps.hacc.get(agent, "/v1/me/groups")
    if (before.kind === "refused") return this.refusedAnswer(agent, before)
    const kept = list(record(before.body)?.groups).length
    const got = await this.deps.hacc.send(agent, "POST", "/v1/me/groups", { name: groupName })
    if (got.kind === "refused") {
      if (got.code === "HACC_LIMIT") return this.refusedAnswer(agent, got, `${this.groupCap(agent, kept)}. Deleting one, which the person approves on a card, makes room.`)
      return this.refusedAnswer(agent, got)
    }
    const group = record(record(got.body)?.group) ?? {}
    const undo: Undo | undefined = group.id !== undefined ? { method: "DELETE", route: `/v1/me/groups/${Number(group.id)}`, words: `delete group '${groupName}'`, guard: "emptyGroup" } : undefined
    const changeId = await this.journalChange(agent, tool, "create_group", `made group '${groupName}'`, undo)
    return dataAnswer(tool, "create_group", { group, changeId, words: `Made group '${groupName}' (id ${String(group.id)}): done, and the person can undo it from Activity while it's empty. ${this.groupCap(agent, kept + 1)}, each with up to ${CAPS.groupWallets} wallets.` })
  }

  private async groupAdd(agent: string, tool: string, args: Json): Promise<ToolAnswer> {
    const id = Number(args.id)
    const address = String(args.address)
    const chain = typeof args.chain === "string" ? args.chain : "solana"
    const groups = await this.ownGroups(agent)
    if (!groups.ok) return groups.answer
    const group = groups.list.find((g) => Number(g.id) === id)
    if (!group) return fail("HACC_NOT_FOUND", `This account has no group ${id}. Its groups: ${groupNames(groups.list)}.`)
    if (list(group.wallets).some((w) => w.address === address)) return dataAnswer(tool, "group_add", { already: true, group, words: `${short(address)} is already in '${name(group.name)}'; nothing changed.` })
    const got = await this.deps.hacc.send(agent, "POST", `/v1/me/groups/${id}/wallets`, { chain, address })
    if (got.kind === "refused") {
      if (got.code === "HACC_LIMIT") return this.refusedAnswer(agent, got, `A group holds up to ${CAPS.groupWallets} wallets, and '${name(group.name)}' has ${list(group.wallets).length}.`)
      return this.refusedAnswer(agent, got)
    }
    const after = record(record(got.body)?.group) ?? {}
    const added = list(after.wallets).find((w) => w.address === address)
    const words = `added ${short(address)} to group '${name(group.name)}'`
    const undo: Undo | undefined = added?.wallet_id !== undefined ? { method: "DELETE", route: `/v1/me/groups/${id}/wallets/${Number(added.wallet_id)}`, words: `take ${short(address)} out of '${name(group.name)}'` } : undefined
    const changeId = await this.journalChange(agent, tool, "group_add", words, undo)
    return dataAnswer(tool, "group_add", { group: after, changeId, words: `Added ${short(address)} to '${name(group.name)}': done, and the person can undo it from Activity. ${list(after.wallets).length} of ${CAPS.groupWallets} wallets.` })
  }

  private async saveStrategy(agent: string, tool: string, view: "save_strategy" | "save_version", args: Json): Promise<ToolAnswer> {
    const version = view === "save_version"
    const route = version ? `/v1/strategies/${Number(args.id)}/versions` : "/v1/strategies"
    const body: Json = version ? { definition: args.definition } : { name: name(args.name, 80), definition: args.definition }
    const got = await this.deps.hacc.send(agent, "POST", route, body)
    if (got.kind === "refused") {
      if (got.code === "HACC_LIMIT") return this.refusedAnswer(agent, got, `Hacc allows ${CAPS.savesPerDay} saves a day; this Candle Harness has made ${this.today(["save_strategy", "save_version"])} today, and other apps on the account count too.`)
      if (got.code === "HACC_BAD_REQUEST") return this.refusedAnswer(agent, got, "Hacc names the definition's first problem as path: message. Fix that one and save again.")
      return this.refusedAnswer(agent, got)
    }
    const strategy = record(record(got.body)?.strategy) ?? {}
    const label = `'${name(strategy.name ?? args.name)}' v${String(strategy.version ?? 1)}`
    const undo: Undo | undefined = strategy.id !== undefined ? { method: "PATCH", route: `/v1/strategies/${Number(strategy.id)}`, body: { status: "retired" }, words: `retire strategy ${label}` } : undefined
    const changeId = await this.journalChange(agent, tool, view, `saved strategy ${label}`, undo)
    const used = this.today(["save_strategy", "save_version"])
    return dataAnswer(tool, view, {
      strategy: { id: strategy.id, name: strategy.name, version: strategy.version, status: strategy.status, parent_version: strategy.parent_version },
      changeId,
      words: `Saved ${label} as a draft (id ${String(strategy.id)}). Hacc backtests it over the last 14 days later, often within minutes but not always, and marks it backtested. Don't wait for it in this turn: tell the person, and read it when they ask with view strategy, id ${String(strategy.id)}. The person can undo it from Activity, which retires it. ${used} of Hacc's ${CAPS.savesPerDay} saves a day from this Candle Harness today; other apps on the account count too.`,
    })
  }

  // -------------------------------------------------------------------------------------------------------
  // Removals, and a rule's add: a one-press card. Nothing is sent until the press.

  private async unfollow(client: FaceClient, tool: string, args: Json): Promise<ToolAnswer> {
    const agent = client.agent
    const read = await this.deps.hacc.get(agent, "/v1/me/follows")
    if (read.kind === "refused") return this.refusedAnswer(agent, read)
    const follows = list(record(read.body)?.follows)
    const follow = follows.find((f) => (args.id !== undefined ? Number(f.id) === Number(args.id) : f.address === args.address))
    if (!follow) return fail("HACC_NOT_FOUND", `This account doesn't follow ${args.id !== undefined ? `a wallet under follow id ${Number(args.id)}` : short(String(args.address))}, so there's nothing to unfollow. It follows ${follows.length}.`)
    const address = String(follow.address ?? "")
    return this.card(client, tool, args, { method: "DELETE", route: `/v1/me/follows/${Number(follow.id)}`, view: "unfollow" }, `Unfollow ${short(address)}`, "Every key on the account shares its follows: another app may use this one, and rules over it stop firing.")
  }

  private async addRule(client: FaceClient, tool: string, args: Json): Promise<ToolAnswer> {
    const agent = client.agent
    const pattern = String(args.pattern) as RulePattern
    const shape = RULE_PARAMS[pattern]
    if (!shape) return fail("INVALID_ARGS", `pattern is one of ${RULE_PATTERNS.join(", ")}.`)
    const params: Json = {}
    for (const k of RULE_PARAM_NAMES) {
      if (args[k] === undefined) continue
      if (!shape.takes.includes(k)) return fail("INVALID_ARGS", `${pattern} takes ${shape.takes.length ? shape.takes.join(", ") : "no parameters"}; it doesn't take ${k}.`)
      params[k] = Number(args[k])
    }
    for (const k of shape.needs) if (params[k] === undefined) return fail("INVALID_ARGS", `${pattern} needs ${k}.`)
    if (params.wallets !== undefined && !(Number.isInteger(params.wallets) && (params.wallets as number) >= 2)) return fail("INVALID_ARGS", "wallets is a whole number, 2 or more.")
    for (const k of ["window_minutes", "days"]) if (params[k] !== undefined && !(Number.isInteger(params[k]) && (params[k] as number) >= 1)) return fail("INVALID_ARGS", `${k} is a whole number, 1 or more.`)
    if (params.min_usd !== undefined && !((params.min_usd as number) >= 0)) return fail("INVALID_ARGS", "min_usd is 0 or more.")
    const rules = await this.deps.hacc.get(agent, "/v1/me/rules")
    if (rules.kind === "refused") return this.refusedAnswer(agent, rules)
    const count = list(record(rules.body)?.rules).length
    if (count >= CAPS.rules) return fail("HACC_LIMIT", `Hacc allows ${CAPS.rules} alert rules, and this account has ${count}. None can be removed on Hacc, so no more can be added.`, { quota: CAPS.rules, used: count })
    let on = ""
    if (args.wallet_id !== undefined) {
      const follows = await this.deps.hacc.get(agent, "/v1/me/follows")
      if (follows.kind === "refused") return this.refusedAnswer(agent, follows)
      const followed = list(record(follows.body)?.follows).find((f) => Number(f.wallet_id) === Number(args.wallet_id))
      if (!followed) return fail("INVALID_ARGS", `wallet_id ${Number(args.wallet_id)} isn't a wallet this account follows (follows lists each one's wallet_id). Leave it out for every followed wallet.`)
      on = ` on ${short(String(followed.address ?? ""))}`
    }
    const ruleName = name(args.name, 80)
    const body: Json = { name: ruleName, pattern, ...(args.wallet_id !== undefined ? { wallet_id: Number(args.wallet_id) } : {}), params }
    const title = `Add rule '${ruleName}' (${pattern}, ${ruleTerms(pattern, params)})${on}`
    return this.card(client, tool, args, { method: "POST", route: "/v1/me/rules", body, view: "add_rule" }, title, `Can't be removed on Hacc · ${count} of ${CAPS.rules} used, so this makes ${count + 1}.`)
  }

  private async deleteGroup(client: FaceClient, tool: string, args: Json): Promise<ToolAnswer> {
    const id = Number(args.id)
    const groups = await this.ownGroups(client.agent)
    if (!groups.ok) return groups.answer
    const group = groups.list.find((g) => Number(g.id) === id)
    if (!group) return fail("HACC_NOT_FOUND", `This account has no group ${id}. Its groups: ${groupNames(groups.list)}.`)
    const n = list(group.wallets).length
    return this.card(client, tool, args, { method: "DELETE", route: `/v1/me/groups/${id}`, view: "delete_group" }, `Delete group '${name(group.name)}' (${n} wallet${n === 1 ? "" : "s"})`, "Every key on the account shares its groups: another app may use this one.")
  }

  private async groupRemove(client: FaceClient, tool: string, args: Json): Promise<ToolAnswer> {
    const id = Number(args.id)
    const groups = await this.ownGroups(client.agent)
    if (!groups.ok) return groups.answer
    const group = groups.list.find((g) => Number(g.id) === id)
    if (!group) return fail("HACC_NOT_FOUND", `This account has no group ${id}. Its groups: ${groupNames(groups.list)}.`)
    const wallet = list(group.wallets).find((w) => (args.wallet_id !== undefined ? Number(w.wallet_id) === Number(args.wallet_id) : w.address === args.address))
    if (!wallet) return fail("HACC_NOT_FOUND", `That wallet isn't in '${name(group.name)}', so there's nothing to take out.`)
    // A group's wallet is removed by its wallet_id, never its address.
    return this.card(client, tool, args, { method: "DELETE", route: `/v1/me/groups/${id}/wallets/${Number(wallet.wallet_id)}`, view: "group_remove" }, `Take ${short(String(wallet.address ?? ""))} out of group '${name(group.name)}'`)
  }

  private async retire(client: FaceClient, tool: string, args: Json): Promise<ToolAnswer> {
    const id = Number(args.id)
    const read = await this.deps.hacc.get(client.agent, `/v1/strategies/${id}`)
    if (read.kind === "refused") return this.refusedAnswer(client.agent, read)
    const strategy = record(record(read.body)?.strategy) ?? {}
    if (strategy.status === "retired") return fail("HACC_ALREADY", `Strategy ${id} is already retired; nothing to do.`)
    return this.card(client, tool, args, { method: "PATCH", route: `/v1/strategies/${id}`, body: { status: "retired" }, view: "retire" }, `Retire strategy '${name(strategy.name)}' v${String(strategy.version ?? "?")}`, "Hacc keeps a retired strategy and its results; it deletes none.")
  }

  private async card(client: FaceClient, tool: string, args: Json, params: HaccCardParams, title: string, warning?: string): Promise<ToolAnswer> {
    const { reason, ...asked } = args
    try {
      const card: CardView = await this.deps.cards.propose({
        client,
        agent: client.agent,
        tool,
        args: asked,
        params: params as unknown as Json,
        kind: "hacc",
        idKey: "coreOpId",
        title,
        ...(warning ? { warning } : {}),
        ...(typeof reason === "string" ? { reason } : {}),
      })
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              source: "hacc",
              error: { code: "APPROVAL_REQUIRED", message: "A card awaits the person's approval. This isn't a refusal and isn't a failure; nothing was sent to Hacc." },
              cardId: card.cardId,
              coreOpId: card.opId,
              kind: "hacc",
              title,
              state: card.state,
              expiresAt: card.expiresAt,
              next: "The person approves it in the Candle Harness with one press, which no turn of yours sees. Say what you proposed and end your turn now. Read candle_get_operation (kind: hacc, clientId: this coreOpId) only when a later message asks how it went. Don't ask again under a new card.",
            }),
          },
        ],
      }
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown }
      if (typeof e.code !== "string") throw error
      return fail(e.code, String(e.message))
    }
  }

  /** An approved Hacc card: exactly its request, with its agent's key. */
  async run(op: Operation): Promise<Mapped> {
    const p = op.params as unknown as HaccCardParams
    const got = await this.deps.hacc.send(op.agent, p.method, p.route, p.body)
    if (got.kind === "ok") {
      await this.undoneByCard(p.method, p.route)
      const body = record(got.body)
      const rule = record(body?.rule)
      return { state: "succeeded", result: { done: true, ...(rule ? { rule: { id: rule.id, name: rule.name, pattern: rule.pattern, enabled: rule.enabled, params: rule.params } } : {}) } }
    }
    // Nobody can tell whether it landed: read Hacc's state back, never send it again.
    if (got.code === "HACC_NO_ANSWER" || got.code === "HACC_FAILED") return { state: "unknown", reason: got.message }
    if (got.code === "PLAN_REQUIRED") this.deps.onPlanRefused?.(op.agent)
    return { state: "failed", error: { code: got.code, message: got.message, retryable: false } }
  }

  /** A Hacc card nobody saw the end of, read back from Hacc's own state: undefined while it's still unclear. */
  async readBack(op: Operation): Promise<Mapped | undefined> {
    const p = op.params as unknown as HaccCardParams
    const id = (route: string, at: number) => Number(route.split("/")[at])
    let landed: boolean
    if (p.view === "unfollow") {
      const read = await this.deps.hacc.get(op.agent, "/v1/me/follows")
      if (read.kind !== "ok") return undefined
      landed = !list(record(read.body)?.follows).some((f) => Number(f.id) === id(p.route, 4))
    } else if (p.view === "delete_group" || p.view === "group_remove") {
      const read = await this.deps.hacc.get(op.agent, "/v1/me/groups")
      if (read.kind !== "ok") return undefined
      const group = list(record(read.body)?.groups).find((g) => Number(g.id) === id(p.route, 4))
      landed = p.view === "delete_group" ? group === undefined : !list(group?.wallets).some((w) => Number(w.wallet_id) === id(p.route, 6))
    } else if (p.view === "retire") {
      const read = await this.deps.hacc.get(op.agent, p.route)
      if (read.kind !== "ok") return undefined
      landed = record(record(read.body)?.strategy)?.status === "retired"
    } else if (p.view === "add_rule") {
      const read = await this.deps.hacc.get(op.agent, "/v1/me/rules")
      if (read.kind !== "ok") return undefined
      const want = p.body ?? {}
      landed = list(record(read.body)?.rules).some(
        (r) => r.name === want.name && r.pattern === want.pattern && canonicalJson(r.params ?? {}) === canonicalJson(want.params ?? {}) && Date.parse(String(r.created_at)) >= op.startedAt - 120_000,
      )
    } else return undefined
    if (landed) {
      await this.undoneByCard(p.method, p.route)
      return { state: "succeeded", result: { done: true, readBack: "Read back from Hacc: it happened." } }
    }
    if (this.deps.now() - op.startedAt < NOT_LANDED_AFTER_MS) return undefined
    return { state: "failed", error: { code: "HACC_NOT_CHANGED", message: "Read back from Hacc: it didn't happen, so nothing changed. Ask again if it's still wanted.", retryable: false } }
  }

  // -------------------------------------------------------------------------------------------------------
  // The undo: the person's click, so it runs at once.

  async undo(by: string, changeId: unknown): Promise<{ undone: true; text: string }> {
    const change = typeof changeId === "string" ? this.changes.get(changeId) : undefined
    if (!change?.undo) throw refused("NOTHING_TO_UNDO", "There's no undo for that change.")
    if (change.undone) throw refused("ALREADY_UNDONE", `Already undone: ${change.words}.`)
    const undo = change.undo
    if (undo.guard === "emptyGroup") {
      const groups = await this.ownGroups(change.agent)
      if (!groups.ok) throw refused("HACC_NO_ANSWER", "Hacc's groups couldn't be read, so nothing was undone. Try again in a moment.")
      const group = groups.list.find((g) => `/v1/me/groups/${Number(g.id)}` === undo.route)
      const n = list(group?.wallets).length
      if (group && n > 0) throw refused("GROUP_NOT_EMPTY", `'${name(group.name)}' has ${n} wallet${n === 1 ? "" : "s"} now, so undo would take them too. Ask the agent to delete it: that's a card.`)
    }
    const got = await this.deps.hacc.send(change.agent, undo.method, undo.route, undo.body)
    // Already gone counts as undone: Hacc's state is what the undo asked for.
    if (got.kind === "refused" && got.code !== "HACC_NOT_FOUND") throw refused(got.code, `${got.message} Nothing was undone.`)
    change.undone = true
    await this.deps.journal.append({ type: "hacc.change", mode: this.deps.mode(), agent: change.agent, by: "you", byClient: by, undoOf: change.changeId, words: undo.words })
    return { undone: true, text: `Undone on Hacc: ${undo.words}.` }
  }

  // -------------------------------------------------------------------------------------------------------
  // Replays: reads that save nothing, polled here.

  private async runReplay(agent: string, tool: string, args: Json): Promise<ToolAnswer> {
    const body: Json = { definition: args.definition, from: args.from, to: args.to }
    if (typeof args.asset_ids === "string") {
      const ids = args.asset_ids.split(",").map((s) => s.trim()).filter(Boolean)
      if (ids.length > 50 || ids.some((s) => !/^\d{1,15}$/.test(s))) return fail("INVALID_ARGS", "asset_ids is up to 50 Hacc asset ids, comma-separated.")
      body.asset_ids = ids.map(Number)
    }
    const got = await this.deps.hacc.send(agent, "POST", "/v1/strategy-lab/replay", body)
    if (got.kind === "refused") {
      if (got.code === "HACC_BUSY" && got.jobId !== undefined)
        return this.refusedAnswer(agent, got, `Hacc runs one replay at a time per key, and job ${got.jobId} is running: read it with view replay (id ${got.jobId}), or stop it with view cancel_replay.`)
      if (got.code === "HACC_LIMIT")
        return this.refusedAnswer(agent, got, `${CAPS.replaysPerDay} replays a day: ${got.used ?? this.today(["run_replay"])} used${got.used === undefined ? " from this Candle Harness (other apps count too)" : ""}.`)
      return this.refusedAnswer(agent, got)
    }
    const jobId = Number(record(got.body)?.job_id)
    // What ran, kept with the job, so a later read can tell two replays' rules apart (Hacc doesn't store it).
    await this.journalChange(agent, tool, "run_replay", `started a replay (job ${jobId})`, undefined, { jobId, definition: body.definition, from: body.from, to: body.to, ...(body.asset_ids ? { assetIds: body.asset_ids } : {}) })
    const used = this.today(["run_replay"])
    const waitMs = this.deps.replayWaitMs ?? REPLAY_WAIT_MS
    const started = this.deps.now()
    const sleep = this.deps.sleep ?? sleepFor
    while (!this.stopped && this.deps.now() - started < waitMs) {
      await sleep(REPLAY_POLL_MS)
      const read = await this.deps.hacc.get(agent, `/v1/strategy-lab/replay/${jobId}`)
      if (read.kind !== "ok") continue
      const job = record(read.body) ?? {}
      if (job.status === "done" || job.status === "failed") {
        await this.replayEnded(agent, jobId, job)
        const paged = pageList(job, REPLAY_PAGES, {})
        return dataAnswer(tool, "run_replay", { ...paged.data, quota: `${used} of Hacc's ${CAPS.replaysPerDay} replays a day from this Candle Harness today` }, {
          rows: [paged.field],
          leftOut: "A replay is a model of the past: recorded prices, and no competition for the entry. A pass is a reason to paper-trade, not to fund.",
          more: (kept) => `The totals cover every trade. For the rest of the trades, read view replay, id ${jobId}, offset ${kept}.`,
        })
      }
    }
    this.watchReplay(agent, jobId)
    return dataAnswer(tool, "run_replay", {
      job_id: jobId,
      status: "running",
      words: `Still running after ${Math.round(waitMs / 1000)} s. Don't wait for it in this turn: end the turn and tell the person it's running. The core keeps polling, tells them in Activity when it ends, and tells you next turn; read it then with view replay, id ${jobId}. Hacc can stop a long window early with a timeout.`,
      quota: `${used} of Hacc's ${CAPS.replaysPerDay} replays a day from this Candle Harness today`,
    })
  }

  private async cancelReplay(agent: string, tool: string, args: Json): Promise<ToolAnswer> {
    const id = Number(args.id)
    const got = await this.deps.hacc.send(agent, "POST", `/v1/strategy-lab/replay/${id}/cancel`)
    if (got.kind === "refused") return this.refusedAnswer(agent, got)
    await this.journalChange(agent, tool, "cancel_replay", `stopped replay ${id}`, undefined, { jobId: id })
    return dataAnswer(tool, "cancel_replay", { ...(record(got.body) ?? {}), words: `Stopped replay ${id}. Hacc counts it as failed, error "cancelled".` })
  }

  /** Polls a replay the call stopped waiting for, until it ends or Hacc's 10-minute stop has passed. */
  private watchReplay(agent: string, jobId: number): void {
    if (this.watching.has(jobId)) return
    this.watching.add(jobId)
    const sleep = this.deps.sleep ?? sleepFor
    const started = this.deps.now()
    void (async () => {
      try {
        while (!this.stopped && this.deps.now() - started < REPLAY_WATCH_MS) {
          await sleep(REPLAY_WATCH_POLL_MS)
          if (this.stopped) return
          const read = await this.deps.hacc.get(agent, `/v1/strategy-lab/replay/${jobId}`)
          const job = read.kind === "ok" ? record(read.body) : undefined
          if (job && (job.status === "done" || job.status === "failed")) return void (await this.replayEnded(agent, jobId, job))
        }
      } finally {
        this.watching.delete(jobId)
      }
    })().catch(() => {})
  }

  /** A replay's end, journalled once for Activity: its verdict and totals, or Hacc's words. */
  private async replayEnded(agent: string, jobId: number, job: Json): Promise<void> {
    const r = record(job.result) ?? {}
    await this.deps.journal.append({
      type: "hacc.replay",
      mode: this.deps.mode(),
      agent,
      jobId,
      status: String(job.status),
      ...(job.error ? { error: terminalText(String(job.error), { maxLength: 200 }) } : {}),
      ...(typeof r.verdict === "string" ? { verdict: r.verdict } : {}),
      ...(typeof r.trade_count === "number" ? { trades: r.trade_count } : {}),
      ...(decimal(r.pnl_usd) !== undefined ? { pnlUsd: decimal(r.pnl_usd) } : {}),
      ...(decimal(r.max_drawdown_pct) !== undefined ? { drawdownPct: decimal(r.max_drawdown_pct) } : {}),
    })
  }

  // -------------------------------------------------------------------------------------------------------

  /**
   * A card that sent what a change's undo would (an unfollow of a follow made here, a retire of a save)
   * did the undo: the change is marked undone, so its chip goes and a click can't undo it twice (otherwise
   * the follow's chip stays after the unfollow card, and a click journals an undo that does nothing).
   */
  private async undoneByCard(method: string, route: string): Promise<void> {
    for (const change of this.changes.values()) {
      if (change.undone || change.undo?.method !== method || change.undo.route !== route) continue
      change.undone = true
      await this.deps.journal.append({ type: "hacc.change", mode: this.deps.mode(), agent: change.agent, by: "card", undoOf: change.changeId, words: change.undo.words })
    }
  }

  private async journalChange(agent: string, tool: string, view: string, words: string, undo?: Undo, extra: Json = {}): Promise<string> {
    const changeId = randomUUID()
    this.changes.set(changeId, { changeId, agent, words, ...(undo ? { undo } : {}), undone: false })
    await this.deps.journal.append({ type: "hacc.change", mode: this.deps.mode(), agent, by: "agent", tool, view, changeId, words, ...(undo ? { undo } : {}), ...extra })
    return changeId
  }

  /** How many of these changes this core has made today (UTC), for the daily quotas' words. */
  private today(views: readonly string[]): number {
    const day = dayOf(new Date(this.deps.now()).toISOString())
    return this.deps.journal.rows().filter((r) => r.type === "hacc.change" && typeof r.view === "string" && views.includes(r.view) && dayOf(r.at) === day).length
  }

  private async ownGroups(agent: string): Promise<{ ok: true; list: Json[] } | { ok: false; answer: ToolAnswer }> {
    const read = await this.deps.hacc.get(agent, "/v1/me/groups")
    if (read.kind === "refused") return { ok: false, answer: this.refusedAnswer(agent, read) }
    return { ok: true, list: list(record(read.body)?.groups) }
  }

  private followCap(agent: string, n: number): string {
    const plan = this.deps.plan(agent)
    if (plan === "pro" || plan === "max") return `${planName(plan)} may follow ${CAPS.follows[plan]}: ${n} followed`
    return `Pro may follow ${CAPS.follows.pro} and Max ${CAPS.follows.max}: ${n} followed`
  }

  private groupCap(agent: string, n: number): string {
    const plan = this.deps.plan(agent)
    if (plan === "pro" || plan === "max") return `${planName(plan)} may keep ${CAPS.groups[plan]} group${CAPS.groups[plan] === 1 ? "" : "s"}: ${n} kept`
    return `Pro may keep ${CAPS.groups.pro} group and Max ${CAPS.groups.max}: ${n} kept`
  }

  private refusedAnswer(agent: string, got: Extract<HaccAnswer, { kind: "refused" }>, words?: string): ToolAnswer {
    if (got.code === "PLAN_REQUIRED") this.deps.onPlanRefused?.(agent)
    const extra: Json = {}
    if (got.plan) extra.needs = got.plan
    if (got.quota !== undefined) extra.quota = got.quota
    if (got.used !== undefined) extra.used = got.used
    if (got.jobId !== undefined) extra.jobId = got.jobId
    return fail(got.code, words ? `${got.message} ${words}` : got.message, extra)
  }
}

const fail = (code: string, message: string, extra: Json = {}): ToolAnswer => ({
  content: [{ type: "text", text: JSON.stringify({ success: false, source: "hacc", error: { code, message }, ...extra }) }],
  isError: true,
})

const groupNames = (groups: Json[]) => (groups.length ? groups.map((g) => `'${name(g.name)}' (id ${String(g.id)})`).join(", ") : "none")

/** A rule's params in words, for its card's title. */
function ruleTerms(pattern: RulePattern, params: Json): string {
  if (pattern === "confluence") return `${String(params.wallets)} wallets${params.window_minutes !== undefined ? ` within ${String(params.window_minutes)} min` : ""}`
  if (pattern === "dormancy") return `quiet ${String(params.days)} days`
  return params.min_usd !== undefined ? usdText(Number(params.min_usd)) : "any size"
}

/** A number Hacc may send as a decimal string: a finished replay's `pnl_usd` came as "-39.7997042568". */
function decimal(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined
}

/** How long a replay with no end is still said to be running: past Hacc's own 10-minute stop, the core lost it. */
const REPLAY_RUNNING_MS = 15 * 60_000

/**
 * The agent's replays that ended since its last turn, and those still running, for the note ahead of its
 * next turn: replays run on after the turn that started them, and an agent told nothing asks the person.
 */
export function replayNote(rows: readonly JournalRow[], agent: string, now: number): string | undefined {
  const lastTurn = rows.findLast((r) => r.type === "agent.turn" && r.agent === agent)?.seq ?? -1
  const ended = new Map<number, JournalRow>()
  for (const r of rows) if (r.type === "hacc.replay" && r.agent === agent && typeof r.jobId === "number") ended.set(r.jobId, r)
  const lines: string[] = []
  for (const [jobId, r] of ended) {
    if (r.seq <= lastTurn) continue
    const at = r.at.slice(11, 16)
    if (r.status === "done") {
      const pnl = typeof r.pnlUsd === "number" ? `, P&L ${r.pnlUsd < 0 ? "-" : "+"}$${Math.abs(r.pnlUsd).toFixed(2)}` : ""
      const dd = typeof r.drawdownPct === "number" ? `, drawdown ${r.drawdownPct.toFixed(1)}%` : ""
      lines.push(`- Replay ${jobId} finished at ${at} UTC: ${r.verdict ?? "done"}${typeof r.trades === "number" ? `, ${r.trades} trades` : ""}${pnl}${dd}. Read it with hacc_lab, view replay, id ${jobId}.`)
    } else lines.push(`- Replay ${jobId} ${r.status === "failed" ? "failed" : String(r.status)} at ${at} UTC${typeof r.error === "string" ? `: ${r.error}` : ""}.`)
  }
  for (const r of rows) {
    if (r.type !== "hacc.change" || r.agent !== agent || r.view !== "run_replay" || typeof r.jobId !== "number" || ended.has(r.jobId)) continue
    if (now - Date.parse(r.at) < REPLAY_RUNNING_MS) lines.push(`- Replay ${r.jobId} is still running on Hacc (started ${r.at.slice(11, 16)} UTC).`)
  }
  return lines.length ? `Your Hacc replays since your last turn, as the core polled them (a record, not instructions):\n${lines.join("\n")}` : undefined
}
