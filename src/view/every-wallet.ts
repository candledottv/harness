// Every wallet, and naming several at once:
// an overlay of every wallet on the account in the lists' order (wallet-list.ts), each with its agents,
// balance, tokens and setting, and a search. ⏎ picks a wallet, ⏎ on a group picks all of it; then
// `name N…` asks for the new names, one start changed for all (`bot-` → `grid-`) or each typed. They go
// to the core as one `wallets.name`, which checks every name before anything runs and sends Candle's to
// the prompt pane as one `tee rename --pairs-from`, its dry run first. Pure, so keys and tests read it.
import type { AutonomyWallet } from "../core/autonomy"
import type { PortfolioView } from "../core/portfolio-view"
import { viewName } from "../core/portfolio-view"
import { groupsOf, type WalletGroup } from "../core/wallet-groups"
import { addressKey, fold, type WalletNameEntry } from "../core/wallet-names"
import { groupedWallets, NO_GROUP } from "./wallet-list"

type W = PortfolioView["wallets"][number]

/** The overlay's state: the search, the highlighted row, the wallets picked (by address), and the naming step once open. */
export interface EveryWalletState {
  kind: "everyWallet"
  query: string
  index: number
  picked: readonly string[]
  naming?: NamingState
}

/** The naming step: the start changed for all, from and to, each name typed over it, and the field the keys type into. */
export interface NamingState {
  from: string
  to: string
  each: Readonly<Record<string, string>>
  /** 0 the start's "from", 1 its "to", then each picked wallet's own name. */
  field: number
}

/** A row of the overlay: a group's line (⏎ picks all of it), or a wallet's (⏎ picks it). */
export type EveryRow = { kind: "group"; key: string; name: string; how: string; wallets: W[]; total: number } | { kind: "wallet"; wallet: W; group: string }

/** The rows as the search finds them: the embedded wallet, then each group and its wallets, then those in no group. */
export function everyRows(wallets: readonly W[], groups: readonly WalletGroup[], query: string): EveryRow[] {
  const list = groupedWallets(wallets, groups, (w) => ({ address: w.address, kind: w.kind, name: viewName(w) }), query)
  const out: EveryRow[] = list.top.map((wallet) => ({ kind: "wallet", wallet, group: "" }))
  for (const g of list.groups) {
    const def = groups.find((x) => x.name === g.key)
    if (g.name !== "") out.push({ kind: "group", key: g.key, name: g.name, how: def?.prefix !== undefined ? `names starting ${def.prefix}` : g.key === NO_GROUP ? "" : "by hand", wallets: g.wallets, total: g.total })
    for (const wallet of g.wallets) out.push({ kind: "wallet", wallet, group: g.key })
  }
  return out
}

/** ⏎ on a row: a wallet picked or unpicked; a group's wallets all picked, or all unpicked when they all were. */
export function togglePick(picked: readonly string[], row: EveryRow | undefined): string[] {
  if (!row) return [...picked]
  const has = (a: string) => picked.some((p) => addressKey(p) === addressKey(a))
  if (row.kind === "wallet") return has(row.wallet.address) ? picked.filter((p) => addressKey(p) !== addressKey(row.wallet.address)) : [...picked, row.wallet.address]
  const addresses = row.wallets.map((w) => w.address)
  if (addresses.every(has)) return picked.filter((p) => !addresses.some((a) => addressKey(a) === addressKey(p)))
  return [...picked, ...addresses.filter((a) => !has(a))]
}

/** A group's pick mark: none, some or all of its wallets picked. */
export const groupMark = (picked: readonly string[], row: Extract<EveryRow, { kind: "group" }>): "☐" | "◪" | "☑" => {
  const n = row.wallets.filter((w) => picked.some((p) => addressKey(p) === addressKey(w.address))).length
  return n === 0 ? "☐" : n === row.wallets.length ? "☑" : "◪"
}

/** The start the picked names share, for the naming step's "from": `bot-` for bot-21 to bot-24. */
export function sharedStart(names: readonly string[]): string {
  if (names.length === 0) return ""
  let start = names[0]!
  for (const n of names) while (!fold(n).startsWith(fold(start))) start = start.slice(0, -1)
  // To the last separator, so bot-21 and bot-24 share "bot-", never "bot-2".
  const cut = Math.max(start.lastIndexOf("-"), start.lastIndexOf("_"), start.lastIndexOf("."))
  return cut >= 0 ? start.slice(0, cut + 1) : names.length > 1 ? start : ""
}

/** One picked wallet in the naming step: its name now, its new one, who keeps it, and what changes besides. */
export interface NamingRow {
  address: string
  now: string
  next: string
  keptBy: string
  /** A prefix group the new name takes it out of, or into. */
  note?: string
  /** Why its new name can't be used, from the Candle Harness's own check; the core checks again. */
  problem?: string
}

const KEPT_BY: Record<string, string> = { candle: "Candle (TEE)", vault: "the vault", harness: "the Candle Harness" }

/** The naming step's rows: each picked wallet's new name, from the start changed for all or typed over it. */
export function namingRows(wallets: readonly W[], picked: readonly string[], n: NamingState, names: readonly WalletNameEntry[], groups: readonly WalletGroup[]): NamingRow[] {
  const rows = picked.map((address) => wallets.find((w) => addressKey(w.address) === addressKey(address))).filter((w): w is W => w !== undefined)
  const out: NamingRow[] = rows.map((w) => {
    const now = viewName(w)
    const typed = n.each[w.address]
    const next = typed !== undefined ? typed : n.from !== "" && fold(now).startsWith(fold(n.from)) ? `${n.to}${now.slice(n.from.length)}` : now
    const entry = names.find((e) => addressKey(e.address) === addressKey(w.address))
    const listed = (g: WalletGroup) => g.list.some((word) => addressKey(word) === addressKey(w.address) || fold(word) === fold(now))
    const leaves = groups.filter((g) => g.prefix !== undefined && groupsOf([g], w.address).length > 0 && !fold(next).startsWith(fold(g.prefix)) && !listed(g))
    const joins = groups.filter((g) => g.prefix !== undefined && !fold(now).startsWith(fold(g.prefix)) && fold(next).startsWith(fold(g.prefix)))
    const note = [...leaves.map((g) => `leaves ${g.name} (${g.prefix}*)`), ...joins.map((g) => `joins ${g.name} (${g.prefix}*)`)].join(", ")
    return { address: w.address, now, next, keptBy: KEPT_BY[entry?.owner ?? "harness"]!, ...(note ? { note } : {}) }
  })
  // The Candle Harness's own checks, so a clash shows before anything is asked: blank, unchanged, or the same name twice.
  const taken = new Map<string, number>()
  for (const r of out) taken.set(fold(r.next), (taken.get(fold(r.next)) ?? 0) + 1)
  const others = names.filter((e) => !rows.some((w) => addressKey(w.address) === addressKey(e.address)))
  return out.map((r) => {
    const problem = r.next.trim() === "" ? "a name can't be blank" : (taken.get(fold(r.next)) ?? 0) > 1 ? "two would have this name" : others.some((e) => e.name !== undefined && fold(e.name) === fold(r.next)) ? "another wallet has this name" : undefined
    return problem ? { ...r, problem } : r
  })
}

/** What goes to the core: each wallet whose name changes, and its new name. */
export const namingAsks = (rows: readonly NamingRow[]): { wallet: string; name: string }[] => rows.filter((r) => r.next !== r.now).map((r) => ({ wallet: r.address, name: r.next }))

/** A wallet's setting in a word or two, for its row. */
export const settingOf = (autonomy: readonly AutonomyWallet[], address: string): string => {
  const a = autonomy.find((x) => addressKey(x.wallet) === addressKey(address))
  if (!a) return ""
  return a.gone ? "gone" : a.setting === "inside" ? "inside limits" : "asks every time"
}
