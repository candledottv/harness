// What a wallet is called: one name for each wallet, kept where the
// wallet is owned, and said the same everywhere (the panes, the cards, the agent, the doctor).
//   - a TEE wallet, or a linked (imported or trusted) wallet: Candle's label, from the portfolio and the
//     owner's `candle wallets --json`. `candle tee rename` changes it on Candle for both (the CLI's source:
//     /agent/linked-wallets/rename renames any linked wallet);
//   - a vault key: the vault's label, from the last `vault list` run in the pane. `vault rename`;
//   - everything else (the embedded wallet, a destination Candle holds no label for, a TEE wallet with
//     none): the Candle Harness's own name, in wallets.toml beside config.toml, by address.
// Names follow Candle's own label rule (`validateLabel`, cli/src/vault/labels.ts: at most 64 UTF-16 code
// units, no control character, no leading "-", no edge whitespace, never trimmed). The Candle Harness adds only what
// keeps the wrong wallet from paying: unique across every wallet (case-insensitive, as drawn), never
// "embedded", an agent's name, or anything shaped like an address or a short address, and no character the
// screen doesn't draw. A name set outside the Candle Harness that breaks those is shown as it is, marked, and taken by
// address only; the doctor names it with the rename that fixes it.
//
// Cards, hashes and the CLI's argv keep passing wallets by address: a name is only ever looked up.
import { addressKey } from "../shared/address-key"
import { terminalText } from "../shared/terminal-text"

/** An address as the screen shortens it: its first and last four characters. The one copy (a test refuses another). */
export function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}

/** Where a wallet's name is kept, and so what changes it. */
export type NameOwner = "candle" | "vault" | "harness"

export type WalletKind = "embedded" | "tee" | "linked" | "vault-key" | "other"

/** One wallet the Candle Harness knows, and what it's called. */
export interface WalletNameEntry {
  address: string
  kind: WalletKind
  /** Its name, as kept; absent when nothing names it. */
  name?: string
  /** Where its name lives: what a rename changes. */
  owner: NameOwner
  /** A kept name that breaks the Candle Harness's rules: why. The name is shown, marked, and never looked up. */
  marked?: string
  /** A Candle Harness name in wallets.toml left unused, since Candle or the vault names the wallet (the doctor says so). */
  shadowed?: string
}

// Address-shaped, as destinations.ts reads one: a label is never 32 to 44 letters and digits.
const SOLANA = /^[0-9A-Za-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/
/** "Wall…1111", "Wall...1111", "0x12…cdef": what a short address looks like on screen or typed. */
const SHORT = /^(0x)?[0-9A-Za-z]{2,6}\s*(…|\.{2,3})\s*[0-9A-Za-z]{2,6}$/

export const isAddressShaped = (word: string): boolean => SOLANA.test(word) || EVM.test(word)
export { addressKey }

/** A name as compared: as the screen draws it, any case. "Hot" and "hot", or a name with an invisible character in it, are one. */
export const fold = (name: string): string => terminalText(name).normalize("NFKC").toLowerCase()

/**
 * Candle's label rule, in its own order and nearly its own words (`validateLabel`, cli/src/vault/labels.ts;
 * the same at 0.12.0 and 0.13.5): what `tee rename` and `vault rename` refuse. Undefined when it's acceptable.
 */
export function candleLabelProblem(label: string): string | undefined {
  if (label.trim().length === 0) return "a wallet's name can't be empty"
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return "a wallet's name can't hold a newline, a tab or a control character"
  }
  if (label.startsWith("-")) return 'a wallet\'s name can\'t begin with "-": it would be read as a flag'
  if (label !== label.trim()) return "a wallet's name can't begin or end with a space"
  if (label.length > 64) return "a wallet's name can't be over 64 characters"
  return undefined
}

/** What the Candle Harness adds to Candle's rule, for a name kept anywhere: why it can't name a wallet here, or undefined. */
function harnessProblem(name: string, agents: readonly string[]): string | undefined {
  const f = fold(name)
  if (f === "embedded") return '"embedded" already means the account\'s embedded wallet'
  const agent = agents.find((a) => fold(a) === f)
  if (agent) return `${agent} is an agent's name`
  if (isAddressShaped(name.trim())) return "it's shaped like an address"
  if (SHORT.test(name.trim())) return "it's shaped like a short address"
  return undefined
}

/**
 * Why `name` can't be given to the wallet at `address`, in words, or undefined when it can. `others` is
 * every wallet the Candle Harness knows, as it will be (a batch's other new names in it, so names can swap).
 */
export function nameProblem(name: string, ctx: { address: string; others: readonly { address: string; name?: string }[]; agents: readonly string[] }): string | undefined {
  const candle = candleLabelProblem(name)
  if (candle) return candle
  if (terminalText(name) !== name) return "it holds a character the screen doesn't draw, so it could look like another name"
  const harness = harnessProblem(name, ctx.agents)
  if (harness) return harness
  const f = fold(name)
  const key = addressKey(ctx.address)
  const clash = ctx.others.find((o) => addressKey(o.address) !== key && o.name !== undefined && fold(o.name) === f)
  if (clash) return `${terminalText(clash.name!, { maxLength: 64 })} already names ${short(clash.address)}${fold(clash.name!) === f && clash.name !== name ? " (names are told apart without case)" : ""}`
  return undefined
}

/** Every wallet the Candle Harness knows, from each place a name is kept. */
export interface NameSources {
  /** The account's embedded wallets (Solana, and Hood's EVM address). */
  embedded: readonly string[]
  /** TEE wallets, with Candle's label (the portfolio, and the core's kept list of stopped ones). */
  tee: readonly { address: string; label?: string }[]
  /** Linked wallets that aren't TEE wallets (imported or trusted), with Candle's label (`candle wallets --json`). */
  linked: readonly { address: string; label?: string }[]
  /** Vault keys, with the vault's label (the last `vault list`). */
  vaultKeys: readonly { address: string; label?: string }[]
  /** Other addresses the Candle Harness knows (a TEE wallet's pinned vault): named only by the Candle Harness. */
  other: readonly string[]
  /** wallets.toml's names, by address. */
  harness: Readonly<Record<string, string>>
  agents: readonly string[]
}

/**
 * Each wallet once, by address, with its name and where it's kept. A wallet in several sources is the most
 * specific (a TEE wallet over a vault key's entry for the same address, which the vault keeps beside it).
 * Names that break the Candle Harness's rules, or that two wallets share, are marked.
 */
export function buildNames(src: NameSources): WalletNameEntry[] {
  const harnessByKey = new Map(Object.entries(src.harness).map(([a, n]) => [addressKey(a), n]))
  const by = new Map<string, WalletNameEntry>()
  const add = (address: string, kind: WalletKind, owner: NameOwner, kept?: string) => {
    const key = addressKey(address)
    if (by.has(key)) {
      // A label the more specific source lacks is taken from the later one (a stopped TEE wallet's kept label).
      const held = by.get(key)!
      if (kept !== undefined && kept.trim() !== "" && owner === held.owner && (held.name === undefined || held.name === harnessByKey.get(key))) {
        if (held.name !== undefined && held.name !== kept) held.shadowed = held.name
        held.name = kept
      }
      return
    }
    const own = harnessByKey.get(key)
    // Owned by Candle or the vault, but with no label there: a name of the Candle Harness's stands in until one is set
    // where it's owned, which is still where a rename goes.
    if (kept !== undefined && kept.trim() !== "") by.set(key, { address, kind, owner, name: kept, ...(own !== undefined && own !== kept ? { shadowed: own } : {}) })
    else by.set(key, { address, kind, owner, ...(own !== undefined ? { name: own } : {}) })
  }
  for (const a of src.embedded) add(a, "embedded", "harness")
  for (const t of src.tee) add(t.address, "tee", "candle", t.label)
  for (const l of src.linked) add(l.address, "linked", "candle", l.label)
  for (const v of src.vaultKeys) add(v.address, "vault-key", "vault", v.label)
  for (const a of src.other) add(a, "other", "harness")
  for (const [address] of harnessByKey) if (!by.has(address)) add(address, "other", "harness")
  const entries = [...by.values()]
  // Marks: the Candle Harness's rules, then a name two wallets share (both marked: neither is looked up).
  const counts = new Map<string, number>()
  for (const e of entries) if (e.name !== undefined) counts.set(fold(e.name), (counts.get(fold(e.name)) ?? 0) + 1)
  for (const e of entries) {
    if (e.name === undefined) continue
    const why = harnessProblem(e.name, src.agents) ?? ((counts.get(fold(e.name)) ?? 0) > 1 ? "another wallet has the same name" : terminalText(e.name) !== e.name ? "it holds a character the screen doesn't draw" : undefined)
    if (why) e.marked = why
  }
  return entries
}

/** A wallet's entry, by address. */
export function entryFor(names: readonly WalletNameEntry[], address: string): WalletNameEntry | undefined {
  const key = addressKey(address)
  return names.find((e) => addressKey(e.address) === key)
}

/**
 * What a wallet is called on screen and in messages: its name, else "embedded" for the embedded wallet, else
 * its short address. A marked name is still what it's called (so it can be found and fixed); `from` never takes it.
 */
export function walletName(names: readonly WalletNameEntry[] | undefined, w: { address: string; kind?: "embedded" | "tee" | WalletKind; label?: string }): string {
  const e = names ? entryFor(names, w.address) : undefined
  const name = e?.name ?? w.label
  if (name !== undefined && name.trim() !== "") return terminalText(name, { maxLength: 64 })
  return (e?.kind ?? w.kind) === "embedded" ? "embedded" : short(w.address)
}

export type WalletLookup =
  | { kind: "found"; entry: WalletNameEntry; by: "address" | "name" }
  | { kind: "marked"; entries: WalletNameEntry[] }
  | { kind: "none" }

/**
 * The wallet a word names: an exact address first, then a name (any case, as drawn). A marked name finds
 * nothing but itself, so the caller can say why it's taken by address only.
 */
export function lookupWallet(names: readonly WalletNameEntry[], word: string): WalletLookup {
  const byAddress = entryFor(names, word)
  if (byAddress) return { kind: "found", entry: byAddress, by: "address" }
  const f = fold(word)
  // "embedded" is always the account's embedded wallet (Solana's first), whatever else is called that.
  const embedded = f === "embedded" ? names.find((e) => e.kind === "embedded") : undefined
  if (embedded) return { kind: "found", entry: embedded, by: "name" }
  const hits = names.filter((e) => e.name !== undefined && fold(e.name) === f)
  if (hits.length === 0) return { kind: "none" }
  if (hits.length === 1 && hits[0]!.marked === undefined) return { kind: "found", entry: hits[0]!, by: "name" }
  return { kind: "marked", entries: hits }
}

/** The rename that fixes a marked name, in Candle's or the vault's own command, or the Candle Harness's. */
export function renameCommand(e: WalletNameEntry): string {
  if (e.owner === "candle") return `candle tee rename ${e.address} <new name>`
  if (e.owner === "vault") return `candle vault rename ${e.address} <new name>`
  return `name ${e.address} <new name>`
}

/** Why a marked name isn't looked up, as a sentence for a refusal. */
export function markedWords(word: string, hits: readonly WalletNameEntry[]): string {
  const shown = terminalText(word, { maxLength: 64 })
  if (hits.length > 1) return `${shown} names more than one wallet (${hits.map((h) => short(h.address)).join(", ")}), so each is taken by address only: name it by address, or rename one.`
  return `${shown} can't pick a wallet here, since ${hits[0]!.marked}, so ${short(hits[0]!.address)} is taken by address only: name it by address, or rename it (${renameCommand(hits[0]!)}).`
}

/**
 * A `--pairs-from` file for `tee rename` or `vault rename`, as the CLI's own `rerunFile` writes one
 * (cli/src/commands/tee-rename.ts): plain `<address> <new name>` lines when every name survives that form,
 * else a `from,to` CSV with each name quoted. Each wallet goes by address, which no label can shadow on Candle.
 */
export function pairsFile(rows: readonly { address: string; name: string }[]): string {
  const lines = rows.every((r) => !/[\s,"]/.test(r.name)) ? rows.map((r) => `${r.address} ${r.name}`) : ["from,to", ...rows.map((r) => `${r.address},"${r.name.replaceAll('"', '""')}"`)]
  return `${lines.join("\n")}\n`
}

/** Candle's batch: `tee rename` and `vault rename` take 1 to 256 rows from one `--pairs-from` file. */
export const MAX_RENAMES = 256

export interface RenameRow {
  address: string
  kind: WalletKind
  owner: NameOwner
  name: string
  /** Its kept name before, for an undo and the journal. */
  was?: string
}

export type RenamePlan = { ok: true; rows: RenameRow[]; unchanged: number } | { ok: false; code: string; message: string }

/**
 * Names for wallets, checked whole before anything is written or run (as Candle checks a pairs file): each
 * wallet by address or name, each new name by Candle's rule and the Candle Harness's against every wallet as it will be,
 * so names can swap. A row that changes nothing is left out; a plan with nothing left is refused.
 */
export function planRenames(asks: readonly { wallet: string; name: string }[], names: readonly WalletNameEntry[], agents: readonly string[]): RenamePlan {
  const no = (code: string, message: string): RenamePlan => ({ ok: false, code, message })
  if (asks.length === 0) return no("NAME_SOMETHING", "Name a wallet and its new name: name <wallet> <new name>.")
  if (asks.length > MAX_RENAMES) return no("TOO_MANY", `At most ${MAX_RENAMES} wallets at once, as Candle's own batch takes. Nothing was changed.`)
  const rows: (RenameRow & { entry: WalletNameEntry })[] = []
  let unchanged = 0
  for (const ask of asks) {
    const shown = terminalText(ask.wallet, { maxLength: 64 })
    const look = lookupWallet(names, ask.wallet.trim())
    if (look.kind === "marked") return no(look.entries.length > 1 ? "WALLET_AMBIGUOUS" : "WALLET_NAME_MARKED", `${markedWords(ask.wallet.trim(), look.entries)} Nothing was changed.`)
    if (look.kind === "none") {
      return no(
        "UNKNOWN_WALLET",
        isAddressShaped(ask.wallet.trim())
          ? `${short(ask.wallet.trim())} isn't a wallet the Candle Harness knows: a vault key is known once you run candle vault list in the pane. Nothing was changed.`
          : `No wallet is called ${shown}: name it by its address, or by its name as the Wallets pane shows it. Nothing was changed.`,
      )
    }
    const e = look.entry
    if (rows.some((r) => addressKey(r.address) === addressKey(e.address))) return no("NAMED_TWICE", `${walletName(names, e)} is named twice in one go. Nothing was changed.`)
    if (e.name === ask.name) {
      unchanged++
      continue
    }
    rows.push({ address: e.address, kind: e.kind, owner: e.owner, name: ask.name, ...(e.name !== undefined ? { was: e.name } : {}), entry: e })
  }
  if (rows.length === 0) return no("UNCHANGED", `${asks.length === 1 ? `It's already called ${terminalText(asks[0]!.name, { maxLength: 64 })}` : "Each is already called that"}. Nothing was changed.`)
  // The book as it will be: every new name in, so a batch can swap two names, and two new names can't clash.
  const future = names.map((e) => {
    const r = rows.find((x) => addressKey(x.address) === addressKey(e.address))
    return r ? { address: e.address, name: r.name } : { address: e.address, ...(e.name !== undefined ? { name: e.name } : {}) }
  })
  for (const r of rows) {
    const why = nameProblem(r.name, { address: r.address, others: future, agents })
    if (why) return no("NAME_REFUSED", `Can't call ${walletName(names, r.entry)} "${terminalText(r.name, { maxLength: 64 })}": ${why}. Nothing was changed.`)
  }
  return { ok: true, rows: rows.map(({ entry: _entry, ...r }) => r), unchanged }
}
