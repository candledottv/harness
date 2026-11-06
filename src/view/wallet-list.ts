// Wallets in groups: the one order the Wallets pane, the approvals menu and the overlay of every wallet
// share, so a wallet sits in the same place in each. The embedded wallet first, then each group with its
// wallets, then the wallets in no group. A wallet in several groups is under each. A group organises only:
// nothing here sets or pays.
import type { WalletGroup } from "../core/wallet-groups"
import { addressKey, fold } from "../core/wallet-names"

/** The key of the wallets in no group: a group's own name is one word with no brackets, so it can't clash. */
export const NO_GROUP = "(none)"

/** A wallet as the lists need it: the pane's PortfolioView wallets and the approvals menu's both map to this. */
export interface ListWallet {
  address: string
  kind?: "embedded" | "tee"
  /** What it's called on screen. */
  name: string
}

export interface ListGroup<W> {
  /** The group's name, or NO_GROUP. */
  key: string
  /** On screen: the group's name, or "no group". */
  name: string
  /** Its name's start, as Candle writes it (`bot-*`), where it takes wallets by one. */
  prefix?: string
  /** Its wallets in the list's order, and how many it has in all before a search. */
  wallets: W[]
  total: number
}

export interface Grouped<W> {
  /** The embedded wallet, first in every list. */
  top: W[]
  groups: ListGroup<W>[]
}

/** A wallet's name or address holds what's typed, without case: "bot-1" finds bot-1 and bot-10 to bot-19. */
export const walletFound = (w: Pick<ListWallet, "address" | "name">, query: string): boolean => {
  const q = fold(query.trim())
  return q === "" || fold(w.name).includes(q) || fold(w.address).startsWith(q)
}

/**
 * The wallets in the lists' order: the embedded wallet first, then each group that has any of them, then
 * the rest under "no group", which shows only when there are groups. With a search, only what it finds, and
 * each group keeps its count before the search, for "10 of 24 shown".
 */
export function groupedWallets<W>(wallets: readonly W[], groups: readonly WalletGroup[], of: (w: W) => ListWallet, query = ""): Grouped<W> {
  const found = (w: W) => walletFound(of(w), query)
  // The embedded wallet sits in a group it's in, counted there; otherwise at the top, before the groups.
  const inGroup = new Set(groups.flatMap((g) => g.members.map(addressKey)))
  const top = wallets.filter((w) => of(w).kind === "embedded" && !inGroup.has(addressKey(of(w).address)))
  const rest = wallets.filter((w) => of(w).kind !== "embedded")
  const out: ListGroup<W>[] = []
  const placed = new Set<string>()
  for (const g of groups) {
    const members = new Set(g.members.map(addressKey))
    const all = wallets.filter((w) => members.has(addressKey(of(w).address)))
    for (const w of all) placed.add(addressKey(of(w).address))
    const shown = all.filter(found)
    if (shown.length) out.push({ key: g.name, name: g.name, ...(g.prefix !== undefined ? { prefix: `${g.prefix}*` } : {}), wallets: shown, total: all.length })
  }
  const loose = rest.filter((w) => !placed.has(addressKey(of(w).address)))
  const looseShown = loose.filter(found)
  if (groups.length > 0 && looseShown.length) out.push({ key: NO_GROUP, name: "no group", wallets: looseShown, total: loose.length })
  // With no groups, every wallet is in one plain list after the embedded one.
  if (groups.length === 0 && looseShown.length) out.push({ key: NO_GROUP, name: "", wallets: looseShown, total: loose.length })
  return { top: top.filter(found), groups: out }
}

/** How a group is described beside its name: by its name's start, by hand, or both. */
export const groupHow = (g: Pick<WalletGroup, "prefix" | "list">): string => (g.prefix !== undefined ? `${g.prefix}*${g.list.length ? " and by hand" : ""}` : "by hand")

/** The ids of a list's rows, for picks: a group's heading, and a wallet under a group or at the top. */
export const headingId = (key: string): string => `g:${key}`
export const walletRowId = (key: string, address: string): string => `w:${key}:${address}`

/** The group a row is in, from its id: a heading's own, or a wallet's under it; undefined at the top. */
export function groupOfRow(id: string): string | undefined {
  if (id.startsWith("g:")) return id.slice(2)
  if (!id.startsWith("w:")) return undefined
  const key = id.slice(2, id.lastIndexOf(":"))
  return key === "" ? undefined : key
}

/** A row's wallet, from its id. */
export const walletOfRow = (id: string): string | undefined => (id.startsWith("w:") ? id.slice(id.lastIndexOf(":") + 1) : undefined)
