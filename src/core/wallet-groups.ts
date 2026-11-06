// Wallet groups: a name and its wallets, in wallets.toml beside the names.
// A group organises and filters only: the Wallets pane and the approvals menu group by it, `[wallets] show`
// and P&L can name it, and it never pays and never sets anything (`from <group>` is refused; each wallet
// keeps its own autonomy setting). A group is a list of wallets, a name prefix (Candle's own way of picking
// many wallets, `bot-*`), or both: a prefix takes in every wallet whose name starts with it, now and as more
// are made or renamed, as Candle does.
//
//   [groups.bots]
//   prefix = "bot-"
//   [groups.swing]
//   wallets = ["<address>", "swing-b"]
//
// The Candle Harness writes a list by address, so a rename never drops a wallet from its group; a hand edit may name
// wallets by name. A listed wallet the Candle Harness doesn't know is kept in the file and named, never dropped.
import { addressKey, candleLabelProblem, fold, isAddressShaped, lookupWallet, short, type WalletNameEntry, walletName } from "./wallet-names"
import { terminalText } from "../shared/terminal-text"

export interface GroupDef {
  /** Every wallet whose name starts with this, without case. Kept without Candle's trailing `*`. */
  prefix?: string
  /** Wallets by address (as the Candle Harness writes them) or by name (a hand edit). */
  wallets?: string[]
}

export interface WalletGroup {
  name: string
  prefix?: string
  /** The list as kept, for the file and the undo. */
  list: string[]
  /** The wallets in it, by address, in the name book's order, each once. */
  members: string[]
  /** Listed words that find no wallet (unknown, or a name two wallets share): named, never dropped. */
  unknown: string[]
  /** Why the group's own name is a problem here (a wallet's name, an agent's…): shown, and named by the doctor. */
  marked?: string
}

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const MAX_GROUP_NAME = 32
/** Words a group's name can't be, since the chips and `from` read them. */
const RESERVED = new Set(["all", "embedded", "active", "none"])

/** The static rule for a group's name: one short word, so it can be typed after `group` and read in a chip. */
export function groupNameProblem(name: string): string | undefined {
  if (name === "") return "a group needs a name"
  if (name.length > MAX_GROUP_NAME) return `a group's name is at most ${MAX_GROUP_NAME} characters`
  if (!/^[A-Za-z0-9]/.test(name)) return "a group's name must start with a letter or digit"
  if (!GROUP_NAME.test(name)) return "a group's name is one word of letters, digits, '.', '_' and '-'"
  return undefined
}

/** Candle's `prefix*` written without its star, as the Candle Harness keeps it. */
export const bareprefix = (prefix: string): string => (prefix.endsWith("*") ? prefix.slice(0, -1) : prefix)

/** A prefix is the start of a name, so Candle's label rule holds for it, and a `*` only at its end. */
export function prefixProblem(prefix: string): string | undefined {
  const bare = bareprefix(prefix)
  if (bare === "") return "a prefix can't be empty: it's the start of the wallets' names, such as bot-"
  if (bare.includes("*")) return "a * goes only at a prefix's end, as in bot-*"
  const candle = candleLabelProblem(bare)?.replace("a wallet's name", "a prefix")
  if (candle) return candle
  // As for a name: a character the screen doesn't draw (a lone surrogate among them) can't be told apart, and wallets.toml couldn't be read back.
  if (terminalText(bare) !== bare) return "it holds a character the screen doesn't draw"
  return undefined
}

/** Why a group's name clashes with what's around it: a wallet's name, an agent's, or a reserved word. */
function contextProblem(name: string, names: readonly WalletNameEntry[], agents: readonly string[]): string | undefined {
  const f = fold(name)
  if (RESERVED.has(f)) return `${f} is a word the Candle Harness's chips read`
  if (agents.some((a) => fold(a) === f)) return `${name} is an agent's name`
  if (isAddressShaped(name)) return "it's shaped like an address"
  const wallet = names.find((e) => e.name !== undefined && fold(e.name) === f)
  if (wallet) return `a wallet is called ${terminalText(wallet.name!, { maxLength: 64 })}`
  return undefined
}

/** The group a word names, without case. */
export const groupLookup = (groups: readonly WalletGroup[], word: string): WalletGroup | undefined => groups.find((g) => fold(g.name) === fold(word.trim()))

/** Each group's wallets, read against the book: the prefix's, then the list's, each once, in the book's order. */
export function resolveGroups(defs: Readonly<Record<string, GroupDef>>, names: readonly WalletNameEntry[], agents: readonly string[]): WalletGroup[] {
  const out: WalletGroup[] = []
  for (const [name, def] of Object.entries(defs).sort(([a], [b]) => (fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0))) {
    const list = def.wallets ?? []
    const keys = new Set<string>()
    const unknown: string[] = []
    if (def.prefix !== undefined) {
      const p = fold(def.prefix)
      for (const e of names) if (e.name !== undefined && fold(e.name).startsWith(p)) keys.add(addressKey(e.address))
    }
    for (const word of list) {
      const look = lookupWallet(names, word)
      if (look.kind === "found") keys.add(addressKey(look.entry.address))
      else unknown.push(word)
    }
    const members = names.filter((e) => keys.has(addressKey(e.address))).map((e) => e.address)
    const marked = contextProblem(name, names, agents)
    out.push({ name, ...(def.prefix !== undefined ? { prefix: def.prefix } : {}), list, members, unknown, ...(marked ? { marked } : {}) })
  }
  return out
}

export type GroupOp =
  | { op: "add"; group: string; wallets: string[] }
  | { op: "remove"; group: string; wallets: string[] }
  | { op: "prefix"; group: string; prefix: string | null }
  | { op: "delete"; group: string }

export type GroupPlan = { ok: true; group: string; next: GroupDef | undefined; was: GroupDef | undefined; words: string } | { ok: false; code: string; message: string }

const and = (words: readonly string[]): string => (words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`)

/**
 * One change to one group, checked whole before anything is written: each wallet found as `from` finds it (an
 * address, or a name no other wallet shares), kept by address. A group left with no prefix and no wallets is gone.
 */
export function planGroupChange(op: GroupOp, defs: Readonly<Record<string, GroupDef>>, names: readonly WalletNameEntry[], agents: readonly string[]): GroupPlan {
  const no = (code: string, message: string): GroupPlan => ({ ok: false, code, message: `${message} Nothing was changed.` })
  const asked = op.group.trim()
  const existing = Object.keys(defs).find((k) => fold(k) === fold(asked))
  const group = existing ?? asked
  const was = existing !== undefined ? defs[existing] : undefined
  if (existing === undefined) {
    if (op.op === "delete" || op.op === "remove") return no("UNKNOWN_GROUP", `There's no group called ${terminalText(asked, { maxLength: 40 })}.`)
    if (op.op === "prefix" && op.prefix === null) return no("UNKNOWN_GROUP", `There's no group called ${terminalText(asked, { maxLength: 40 })}.`)
    const why = groupNameProblem(asked) ?? contextProblem(asked, names, agents)
    if (why) return no("GROUP_NAME_REFUSED", `Can't make a group called ${terminalText(asked, { maxLength: 40 })}: ${why}.`)
  }
  const done = (next: GroupDef | undefined, words: string): GroupPlan => ({ ok: true, group, next: next && (next.prefix !== undefined || (next.wallets?.length ?? 0) > 0) ? next : undefined, was, words })
  const resolved = was ? resolveGroups({ [group]: was }, names, agents)[0]! : undefined
  if (op.op === "delete") return done(undefined, `removed the group ${group}`)
  if (op.op === "prefix") {
    if (op.prefix === null) {
      const next = was?.wallets?.length ? { wallets: was.wallets } : undefined
      return done(next, next ? `${group} no longer takes wallets by their names' start` : `removed the group ${group}, which had only its prefix`)
    }
    const why = prefixProblem(op.prefix)
    if (why) return no("PREFIX_REFUSED", `Can't use ${terminalText(op.prefix, { maxLength: 64 })} as a prefix: ${why}.`)
    const prefix = bareprefix(op.prefix)
    const next: GroupDef = { prefix, ...(was?.wallets?.length ? { wallets: was.wallets } : {}) }
    const count = resolveGroups({ [group]: { prefix } }, names, agents)[0]!.members.length
    return done(next, `${was ? `${group} now takes` : `made the group ${group}:`} every wallet whose name starts ${prefix} (${count} now)`)
  }
  // add and remove: each wallet found, by address or a name no other wallet shares.
  const found: WalletNameEntry[] = []
  for (const word of op.wallets) {
    const look = lookupWallet(names, word.trim())
    if (look.kind === "none") return no("UNKNOWN_WALLET", isAddressShaped(word.trim()) ? `${short(word.trim())} isn't a wallet the Candle Harness knows.` : `No wallet is called ${terminalText(word, { maxLength: 64 })}.`)
    if (look.kind === "marked") return no(look.entries.length > 1 ? "WALLET_AMBIGUOUS" : "WALLET_NAME_MARKED", `${terminalText(word, { maxLength: 64 })} names ${look.entries.length > 1 ? "more than one wallet" : "a wallet taken by address only"}: name it by its address.`)
    if (!found.some((e) => addressKey(e.address) === addressKey(look.entry.address))) found.push(look.entry)
  }
  if (found.length === 0) return no("NAME_SOMETHING", "Name a wallet: group <name> add <wallet>.")
  const listed = (e: WalletNameEntry) => (was?.wallets ?? []).some((w) => {
    const l = lookupWallet(names, w)
    return (l.kind === "found" && addressKey(l.entry.address) === addressKey(e.address)) || addressKey(w) === addressKey(e.address)
  })
  const byPrefix = (e: WalletNameEntry) => was?.prefix !== undefined && e.name !== undefined && fold(e.name).startsWith(fold(was.prefix))
  const called = (e: WalletNameEntry) => walletName(names, e)
  if (op.op === "add") {
    const fresh = found.filter((e) => !listed(e) && !byPrefix(e))
    if (fresh.length === 0) {
      const e = found[0]!
      return no("UNCHANGED", byPrefix(e) && resolved ? `${called(e)} is in ${group} already, by its name's start (${was!.prefix}).` : `${found.length === 1 ? `${called(e)} is` : "Each is"} in ${group} already.`)
    }
    const next: GroupDef = { ...(was?.prefix !== undefined ? { prefix: was.prefix } : {}), wallets: [...(was?.wallets ?? []), ...fresh.map((e) => e.address)] }
    return done(next, was ? `added ${and(fresh.map(called))} to ${group}` : `made the group ${group} with ${and(fresh.map(called))}`)
  }
  const inByPrefix = found.find((e) => byPrefix(e) && !listed(e))
  if (inByPrefix) return no("IN_BY_PREFIX", `${called(inByPrefix)} is in ${group} by its name's start (${was!.prefix}), so it can't be taken out by hand: rename it, or change the group's prefix.`)
  const out = found.filter(listed)
  if (out.length === 0) return no("UNCHANGED", `${found.length === 1 ? `${called(found[0]!)} isn't` : "None of them is"} in ${group}.`)
  const keep = (was?.wallets ?? []).filter((w) => {
    const l = lookupWallet(names, w)
    const key = l.kind === "found" ? addressKey(l.entry.address) : addressKey(w)
    return !out.some((e) => addressKey(e.address) === key)
  })
  const next: GroupDef = { ...(was?.prefix !== undefined ? { prefix: was.prefix } : {}), ...(keep.length ? { wallets: keep } : {}) }
  const gone = next.prefix === undefined && keep.length === 0
  return done(next, `took ${and(out.map(called))} out of ${group}${gone ? ", which leaves it empty, so the group is gone" : ""}`)
}

/** The groups a wallet is in, by name, for the panes and the approvals menu. */
export const groupsOf = (groups: readonly WalletGroup[], address: string): string[] => groups.filter((g) => g.members.some((m) => addressKey(m) === addressKey(address))).map((g) => g.name)

