// The approvals menu: the wallets
// on the left, the picked one on the right with its setting, its figures, and every limit on its agents
// with who holds it. Pure, so the keys, the drawing and the tests read the same rows. Only the person sets
// a wallet, from here; the core refuses `autonomy.set` from anything else.
//
// At 50 wallets the list is the
// Wallets pane's groups: the embedded wallet, then each group, the picked wallet's open and the rest folded,
// one line a wallet. Typing on the list finds a wallet. Each wallet keeps its own setting.
import type { AutonomyTopic, AutonomyWallet } from "../core/autonomy"
import type { LimitLine } from "../core/limits"
import { groupsOf, type WalletGroup } from "../core/wallet-groups"
import { money } from "./theme"
import { groupedWallets, groupHow, NO_GROUP } from "./wallet-list"

/** The picked wallet's rows that act: switch back to asking, start turning it on, a figure, the turn-on and cancel chips. */
export type ApprovalsRow = "ask" | "turnOn" | "perTrade" | "perDay" | "confirm" | "cancel"

/** The figures typed while a wallet that asks is being turned on: nothing changes before the turn-on chip. */
export interface ApprovalsDraft {
  perTrade?: number
  perDay?: number
}

/**
 * `wallet`: the picked one, by its place in the list as `approvalsEntries` gives it; `side`: the wallet list or
 * the picked wallet's rows; `typing`: the figure being typed on the row the highlight is on; `find`: what's
 * typed on the list to find a wallet.
 */
export interface ApprovalsState {
  kind: "approvals"
  wallet: number
  side: "wallets" | "detail"
  row: number
  typing?: string
  draft?: ApprovalsDraft
  find?: string
}

/** What an agent's status carries for the menu: its own Candle Harness limits and every limit line. */
export interface AgentLimits {
  name: string
  limits?: { perTradeUsd: number; perDayUsd: number }
  limitLines?: LimitLine[]
}

export const walletWords = (name: string): string => (name === "embedded" ? "the embedded wallet" : name)

/** The rows that act on the picked wallet, in order. */
export function detailRows(w: AutonomyWallet | undefined, draft: ApprovalsDraft | undefined): ApprovalsRow[] {
  if (!w) return []
  if (draft) return ["perTrade", "perDay", "confirm", "cancel"]
  if (w.setting === "inside") return w.gone ? ["ask"] : ["ask", "perTrade", "perDay"]
  return w.gone ? [] : ["turnOn"]
}

export const MIN_FIGURE = 0.01
export const MAX_FIGURE = 1_000_000

/** A dollar figure as typed: "$1.50", "1.5", "1,000". The core takes $0.01 to $1,000,000, to the cent. */
export function parseFigure(text: string): { ok: true; usd: number } | { ok: false; why: string } {
  const t = text.replace(/[$,\s]/g, "")
  if (!t) return { ok: false, why: "Type a dollar figure, such as 1.50, then ⏎." }
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return { ok: false, why: `"${text}" isn't a dollar figure: type one such as 1.50, to the cent.` }
  const usd = Number(t)
  if (usd < MIN_FIGURE || usd > MAX_FIGURE) return { ok: false, why: `A figure goes from ${money(MIN_FIGURE)} to ${money(MAX_FIGURE)}.` }
  return { ok: true, usd }
}

/** A limit on one of the wallet's agents, as the table shows it: the limit, who holds it, and what's used of it today. */
export interface LimitRow {
  agent: string
  limit: string
  who: "Harness" | "Candle"
  used?: string
  /** A key Candle doesn't cap: amber, since only the Candle Harness's limits hold. */
  look?: boolean
}

/**
 * Every limit on the wallet's agents, from their limit lines: the agent's own Candle Harness limits and Candle's
 * caps on its key. The wallets' own figures are left out: the picked wallet's are above the table.
 * Candle has no read of a key's own cap use with the agent's key yet, so it's left blank.
 */
export function limitRows(agents: readonly string[], status: readonly AgentLimits[]): LimitRow[] {
  const out: LimitRow[] = []
  for (const agent of agents) {
    for (const l of status.find((a) => a.name === agent)?.limitLines ?? []) {
      if (l.what === "wallet-trade" || l.what === "wallet-day") continue
      const parts = l.words.split(" · ").slice(1)
      const used = parts.find((p) => p.endsWith(" used"))
      const limit = l.what === "none" ? "no cap on this key" : parts.filter((p) => p !== used).join(" · ")
      out.push({ agent, limit, who: l.by, ...(used ? { used: used.replace(/ used$/, "") } : {}), ...(l.what === "none" ? { look: true } : {}) })
    }
  }
  return out
}

/** The amber line under the table for each agent whose key Candle doesn't cap. */
export function uncappedLines(agents: readonly string[], status: readonly AgentLimits[]): string[] {
  return agents.filter((a) => status.find((s) => s.name === a)?.limitLines?.some((l) => l.what === "none")).map((a) => `Candle doesn't cap ${a}'s key. Only the Candle Harness's limits hold for it.`)
}

/**
 * Which day's cap stops an agent first, the Candle Harness's or Candle's on its key, said in one place (with $100 in the Candle Harness
 * and $50 on the key, which one wins isn't otherwise clear). Candle's is counted over its own window
 * (a UTC day for a daily cap), and only when it's a dollar volume cap. Nothing when the key has none.
 */
export function dayCapsFirst(agents: readonly string[], status: readonly AgentLimits[], harnessPerDay?: (agent: string) => number | undefined): string[] {
  const out: string[] = []
  for (const agent of agents) {
    const a = status.find((s) => s.name === agent)
    const day = harnessPerDay?.(agent) ?? a?.limits?.perDayUsd
    const volume = a?.limitLines?.find((l) => l.what === "volume" && /a UTC day|a day \(UTC\)/.test(l.words))
    const candle = volume ? Number(/\$([\d,]+(?:\.\d+)?)/.exec(volume.words)?.[1]?.replace(/,/g, "")) : NaN
    if (day === undefined || !Number.isFinite(candle)) continue
    if (candle < day) out.push(`Candle's ${money(candle)} a UTC day on ${agent}'s key is lower than the Candle Harness's ${money(day)}, so Candle stops its buys first.`)
    else if (day < candle) out.push(`The Candle Harness's ${money(day)} a day for ${agent} is lower than Candle's ${money(candle)} on its key, so the Candle Harness stops it first.`)
    else out.push(`The Candle Harness's day and Candle's on ${agent}'s key are both ${money(day)}; the Candle Harness counts from local midnight, Candle from 00:00 UTC.`)
  }
  return out
}

/** Where an agent's own Candle Harness limit is under the wallet's figure, it binds first: said beside the figures, typed or set. */
export function bindsFirst(agents: readonly string[], status: readonly AgentLimits[], perTrade: number | undefined, perDay: number | undefined): string[] {
  const out: string[] = []
  for (const agent of agents) {
    const own = status.find((a) => a.name === agent)?.limits
    if (!own) continue
    if (perTrade !== undefined && own.perTradeUsd < perTrade) out.push(`${agent}'s own limit, ${money(own.perTradeUsd)} a trade, binds first.`)
    else if (perDay !== undefined && own.perDayUsd < perDay) out.push(`${agent}'s own limit, ${money(own.perDayUsd)} a day, binds first.`)
  }
  return out
}

/** The setting in a word or two, for the wallet list. */
export function settingShort(w: AutonomyWallet): string {
  if (w.gone) return "gone"
  return w.setting === "inside" ? "inside limits" : "asks every time"
}

/** The wallets the menu lists: the topic's, in its order. */
export const approvalsWallets = (topic: AutonomyTopic | undefined): readonly AutonomyWallet[] => topic?.wallets ?? []

/** A wallet in the list, and the group it's listed under (NO_GROUP, or "" for the embedded wallet at the top). */
export interface ApprovalsEntry {
  wallet: AutonomyWallet
  group: string
}

/**
 * The list's wallets in the Wallets pane's order: the embedded wallet, then each group's,
 * then those in no group, only what `find` finds. A wallet in two groups is listed under each.
 */
export function approvalsEntries(topic: AutonomyTopic | undefined, groups: readonly WalletGroup[], find?: string): ApprovalsEntry[] {
  const list = groupedWallets(approvalsWallets(topic), groups, (w) => ({ address: w.wallet, kind: w.kind ?? "tee", name: w.name }), find ?? "")
  return [...list.top.map((wallet) => ({ wallet, group: "" })), ...list.groups.flatMap((g) => g.wallets.map((wallet) => ({ wallet, group: g.key })))]
}

/** The picked wallet, if the list has it. */
export const pickedWallet = (topic: AutonomyTopic | undefined, groups: readonly WalletGroup[], o: Pick<ApprovalsState, "wallet" | "find">): AutonomyWallet | undefined => approvalsEntries(topic, groups, o.find)[o.wallet]?.wallet

/** A row of the list: the head, the find line, a group's line, a wallet's, or a blank between. */
export type ApprovalsListRow =
  | { kind: "blank" }
  | { kind: "head"; inside: number; of: number }
  | { kind: "find"; text: string }
  | { kind: "group"; key: string; name: string; how: string; inside: number; of: number; open: boolean; first: number }
  | { kind: "wallet"; entry: number; wallet: AutonomyWallet; indent: boolean }

const insideNow = (w: AutonomyWallet) => w.setting === "inside" && !w.gone

/**
 * The list as drawn: how many of the wallets trade inside limits, the find line, the embedded
 * wallet, then each group's line with how many of its wallets trade inside limits. The picked wallet's group
 * is open, its wallets one line each; with a search, every group that finds one.
 */
export function approvalsList(topic: AutonomyTopic | undefined, groups: readonly WalletGroup[], o: Pick<ApprovalsState, "wallet" | "find">): ApprovalsListRow[] {
  const all = approvalsWallets(topic)
  const finding = (o.find ?? "") !== ""
  const list = groupedWallets(all, groups, (w) => ({ address: w.wallet, kind: w.kind ?? "tee", name: w.name }), o.find ?? "")
  const entries = approvalsEntries(topic, groups, o.find)
  const openGroup = entries[o.wallet]?.group
  const out: ApprovalsListRow[] = [{ kind: "head", inside: all.filter(insideNow).length, of: all.length }, { kind: "find", text: o.find ?? "" }, { kind: "blank" }]
  let at = 0
  for (const wallet of list.top) out.push({ kind: "wallet", entry: at++, wallet, indent: false })
  if (list.top.length) out.push({ kind: "blank" })
  for (const g of list.groups) {
    const def = groups.find((x) => x.name === g.key)
    const open = finding || g.key === openGroup || g.name === ""
    if (g.name !== "") {
      const members = all.filter((w) => g.key === NO_GROUP ? groupsOf(groups, w.wallet).length === 0 && w.kind !== "embedded" : groupsOf(groups, w.wallet).includes(g.key))
      out.push({ kind: "group", key: g.key, name: g.name, how: def ? groupHow(def) : "", inside: members.filter(insideNow).length, of: g.total, open, first: at })
    }
    for (const wallet of g.wallets) {
      if (open) out.push({ kind: "wallet", entry: at, wallet, indent: g.name !== "" })
      at++
    }
  }
  return out
}

/** The picked wallet's groups, in words, for the line under its name: "in bots (bot-*) · its own setting, as every wallet has". */
export function groupLine(groups: readonly WalletGroup[], address: string): string | undefined {
  const named = groups.filter((g) => groupsOf([g], address).length > 0).map((g) => (g.prefix !== undefined ? `${g.name} (${g.prefix}*)` : g.name))
  if (named.length === 0) return undefined
  return `in ${named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`} · its own setting, as every wallet has`
}

/** Candle's loss limits and circuit breaker: they exist, they stop the key, and Candle has no read of them over MCP yet. */
export const LOSS_LIMITS_NOTE = "Candle also has loss limits and a circuit breaker on each key. A breach stops the key, sells included, until you resume it in Candle's Agent Console. The Candle Harness can't read them yet."
