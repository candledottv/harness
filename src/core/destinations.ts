// Where funds may go. Funds go out only by the owner's own
// vault-signed routes (`vault transfer`, `tee sweep`, `external sweep`, and the owner rows `vault
// fund` and `vault demote`), each in the prompt pane, where the CLI asks for the factor itself, prints
// the destination in full and takes a typed `confirm`. `vault transfer` checks no destination list of
// its own, so the Candle Harness's checks here are its only guard:
//   - a destination is known when it's one of the user's own: the embedded wallet and the account's
//     TEE wallets (the portfolio, and `candle wallets --json`), a trusted linked wallet and a TEE
//     wallet's pinned vault (`candle wallets --json`, the owner's profile, read in the background), or
//     a vault key from the last `vault list` the user ran in the pane (kept in state/destinations.json);
//   - a look-alike (the same first and last four characters as a known address, but not it) is refused;
//   - a new address is allowed, shown in full in groups of four, and approved only by a click;
//   - from the agent, the user's own message this turn must name the destination and the amount (or
//     the wallet and "everything", for a sweep), and may not name another asset or another source than
//     the step's. Typed, the line is the ask.
// Addresses and labels only, never a secret. The withdrawal allowlist has no CLI read yet, so an
// allowlisted address counts as new.
import { readFile, rename, writeFile } from "node:fs/promises"
import { addressKey as keyOf } from "../shared/address-key"
import { terminalText } from "../shared/terminal-text"
import { type Fill, positionals } from "./owner-rows"
import { short } from "./wallet-names"
import { EVM_ADDRESS_SOURCE, isEvmAddress, LOOSE_EVM_ADDRESS_SOURCE, LOOSE_SOLANA_ADDRESS_SOURCE, startsAsEvm } from "../shared/chains"

export type DestinationKind = "embedded" | "tee" | "trusted" | "vault-key" | "pinned-vault"

export interface Destination {
  address: string
  label?: string
  kind: DestinationKind
}

/** A wallet or destination as the user may name it: by address, or by label. */
export interface Named {
  address: string
  label?: string
}

const KIND_WORDS: Record<DestinationKind, string> = {
  embedded: "the account's embedded wallet",
  tee: "a TEE wallet",
  trusted: "a trusted linked wallet",
  "vault-key": "a vault key on this machine",
  "pinned-vault": "a TEE wallet's pinned vault",
}
/** When one address comes from several sources, the most specific says what it is. */
const RANK: Record<DestinationKind, number> = { "vault-key": 0, tee: 1, trusted: 2, embedded: 3, "pinned-vault": 4 }

// Address-shaped, not decoded: a label is never 32 to 44 letters and digits, and the scrubbed fixtures'
// made-up addresses aren't strict base58.
const SOLANA = new RegExp(`^${LOOSE_SOLANA_ADDRESS_SOURCE}$`)
const isAddress = (word: string) => SOLANA.test(word) || isEvmAddress(word)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined)

/** How a destination is named on a card: "cold, a vault key on this machine (Vaul…1111)". */
export function destinationWords(d: Destination): string {
  const name = d.label ? terminalText(d.label, { maxLength: 40 }) : undefined
  return name ? `${name}, ${KIND_WORDS[d.kind]} (${short(d.address)})` : `${KIND_WORDS[d.kind]} (${short(d.address)})`
}

/** A new address as the card shows it, and the CLI prints it: in full, in groups of four. */
export function inGroupsOfFour(address: string): string {
  return address.match(/.{1,4}/g)?.join(" ") ?? address
}

/**
 * `candle wallets --json` with the owner's profile, as recorded from Candle's real server: the embedded wallet's
 * addresses, each TEE wallet and its pinned vault, and each trusted linked wallet (`trustedAt`). A
 * linked wallet that isn't trusted is not a destination.
 */
export function fromWalletsRead(body: unknown): Destination[] {
  const out: Destination[] = []
  const b = body as { embedded?: { wallets?: Record<string, { address?: unknown }> }; linked?: { page?: unknown } } | undefined
  for (const w of Object.values(b?.embedded?.wallets ?? {})) {
    const address = str(w?.address)
    if (address && isAddress(address)) out.push({ address, kind: "embedded" })
  }
  const page = Array.isArray(b?.linked?.page) ? (b!.linked!.page as Record<string, unknown>[]) : []
  for (const row of page) {
    const address = str(row.address)
    if (!address || !isAddress(address)) continue
    const label = str(row.label)
    if (row.walletKind === "tee") out.push({ address, ...(label ? { label } : {}), kind: "tee" })
    else if (typeof row.trustedAt === "number" || typeof row.trustedAt === "string") out.push({ address, ...(label ? { label } : {}), kind: "trusted" })
    const vault = str(row.vaultDestination)
    if (vault && isAddress(vault)) out.push({ address: vault, kind: "pinned-vault" })
  }
  return out
}

/** Each TEE wallet's pinned vault from `candle wallets --json` (`vaultDestination`), by the wallet's address. */
export function pinnedVaults(body: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const page = (body as { linked?: { page?: unknown } } | undefined)?.linked?.page
  for (const row of Array.isArray(page) ? (page as Record<string, unknown>[]) : []) {
    const address = str(row.address)
    const vault = str(row.vaultDestination)
    if (address && vault && isAddress(address) && isAddress(vault)) out.set(keyOf(address), vault)
  }
  return out
}

/**
 * Every linked wallet in `candle wallets --json`, trusted or not, TEE or not, with Candle's label: where an
 * imported wallet's name comes from. Names only; only `fromWalletsRead` decides a destination.
 */
export function linkedLabels(body: unknown): { address: string; label?: string; tee: boolean }[] {
  const page = (body as { linked?: { page?: unknown } } | undefined)?.linked?.page
  const out: { address: string; label?: string; tee: boolean }[] = []
  for (const row of Array.isArray(page) ? (page as Record<string, unknown>[]) : []) {
    const address = str(row.address)
    if (!address || !isAddress(address)) continue
    const label = str(row.label)
    out.push({ address, ...(label ? { label: terminalText(label, { maxLength: 64 }) } : {}), tee: row.walletKind === "tee" })
  }
  return out
}

/** `vault list --json`, as recorded from the real CLI: each entry's address and label, by role. Nothing else is kept. */
export function fromVaultList(body: unknown): Destination[] {
  const entries = (body as { entries?: unknown } | undefined)?.entries
  if (!Array.isArray(entries)) return []
  const out: Destination[] = []
  for (const e of entries as Record<string, unknown>[]) {
    const address = str(e?.address)
    if (!address || !isAddress(address)) continue
    const label = str(e.label)
    const kind: DestinationKind | undefined = e.role === "vault" ? "vault-key" : e.role === "tee-wallet" ? "tee" : undefined
    if (kind) out.push({ address, ...(label ? { label } : {}), kind })
  }
  return out
}

/** The vault keys among `list` on one chain family: an EVM key has an 0x address, a Solana key a base58 one. */
export function vaultKeysOn(list: readonly Destination[], family: "solana" | "evm"): Destination[] {
  return list.filter((d) => d.kind === "vault-key" && (family === "evm") === isEvmAddress(d.address))
}

/** The known list, from every source. The vault list survives a restart; the reads are made again. */
export class Destinations {
  private wallets: Destination[] = []
  private vaultList: Destination[] = []
  private pinned = new Map<string, string>()
  private linked: { address: string; label?: string; tee: boolean }[] = []

  constructor(private readonly deps: { file: string; portfolio: () => Destination[] }) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.deps.file, "utf8")) as { vaultList?: unknown }
      this.vaultList = Array.isArray(saved.vaultList) ? fromVaultList({ entries: (saved.vaultList as Destination[]).map((d) => ({ address: d.address, label: d.label, role: d.kind === "vault-key" ? "vault" : "tee-wallet" })) }) : []
    } catch {
      this.vaultList = []
    }
  }

  /** The last `candle wallets --json` read. A failed read keeps the last answer. */
  setWallets(list: Destination[]): void {
    this.wallets = list
  }

  /** A `candle wallets --json` answer: its destinations, and each TEE wallet's pinned vault. */
  readWallets(body: unknown): void {
    this.setWallets(fromWalletsRead(body))
    this.pinned = pinnedVaults(body)
    this.linked = linkedLabels(body)
  }

  /** What the reads name: each linked wallet with Candle's label, the vault keys with the vault's, and the pinned vaults. */
  names(): { embedded: string[]; linked: { address: string; label?: string; tee: boolean }[]; vaultKeys: Destination[]; pinned: string[] } {
    return {
      embedded: this.wallets.filter((d) => d.kind === "embedded").map((d) => d.address),
      linked: this.linked.map((l) => ({ ...l })),
      vaultKeys: this.vaultList.filter((d) => d.kind === "vault-key"),
      pinned: [...new Set(this.pinned.values())],
    }
  }

  /**
   * A rename finished in the pane: the kept vault list follows the new name by address, so funds out
   * and the panes say it at once, before the next `vault list`.
   */
  async renamed(renames: readonly { address: string; name: string }[]): Promise<void> {
    const by = new Map(renames.map((r) => [keyOf(r.address), r.name]))
    const relabel = <T extends { address: string; label?: string }>(d: T): T => (by.has(keyOf(d.address)) ? { ...d, label: by.get(keyOf(d.address))! } : d)
    this.wallets = this.wallets.map(relabel)
    this.linked = this.linked.map(relabel)
    if (this.vaultList.some((d) => by.has(keyOf(d.address)))) await this.setVaultList(this.vaultList.map(relabel))
  }

  /** A TEE wallet's pinned vault, as the last wallets read said. */
  pinnedVault(address: string): string | undefined {
    return this.pinned.get(keyOf(address))
  }

  /** The vault keys from a `vault list` the user ran in the pane: kept, 0600, written whole. */
  async setVaultList(list: Destination[]): Promise<void> {
    this.vaultList = list
    const tmp = `${this.deps.file}.tmp`
    await writeFile(tmp, `${JSON.stringify({ vaultList: list })}\n`, { mode: 0o600 })
    await rename(tmp, this.deps.file)
  }

  all(): Destination[] {
    const by = new Map<string, Destination>()
    for (const d of [...this.deps.portfolio(), ...this.wallets, ...this.vaultList]) {
      const key = keyOf(d.address)
      const held = by.get(key)
      if (!held) by.set(key, { ...d })
      else {
        const kind = RANK[d.kind] < RANK[held.kind] ? d.kind : held.kind
        const label = (RANK[d.kind] < RANK[held.kind] ? d.label : held.label) ?? held.label ?? d.label
        by.set(key, { address: held.address, ...(label ? { label } : {}), kind })
      }
    }
    return [...by.values()]
  }
}

export type DestinationCheck =
  | { kind: "known"; destination: Destination }
  | { kind: "lookalike"; like: Destination }
  | { kind: "new"; address: string }
  | { kind: "unknown-label"; word: string; mistyped?: true }

/**
 * A word that's an address cut short or run long: base58 with digits and both cases, 24 to 60
 * characters, or `0x` and hex of the wrong length. A label is rarely like that, so it's worded as a mistyped address.
 */
const MISTYPED_SOLANA = /^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])[1-9A-HJ-NP-Za-km-z]{24,60}$/
const MISTYPED_EVM = new RegExp(`^${LOOSE_EVM_ADDRESS_SOURCE}{8,60}$`)
const mistyped = (word: string) => MISTYPED_SOLANA.test(word) || MISTYPED_EVM.test(word)

/** A destination as given (an address or a label) against the known list. */
export function checkDestination(word: string, known: readonly Destination[]): DestinationCheck {
  const key = keyOf(word)
  const exact = known.find((d) => keyOf(d.address) === key) ?? known.find((d) => d.label !== undefined && d.label === word)
  if (exact) return { kind: "known", destination: exact }
  // `0x` and hex is never base58 (no 0), so one of the wrong length is a mistyped EVM address, not a new Solana one.
  if (!isAddress(word) || (MISTYPED_EVM.test(word) && !isEvmAddress(word))) return { kind: "unknown-label", word, ...(mistyped(word) ? { mistyped: true as const } : {}) }
  const ends = (a: string) => `${keyOf(a).slice(0, 4)}|${keyOf(a).slice(-4)}`
  const like = known.find((d) => ends(d.address) === ends(word))
  return like ? { kind: "lookalike", like } : { kind: "new", address: word }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Whether the text names it: its address, whole, or its label as a word of its own (any case). */
function names(text: string, what: Named): boolean {
  const address = startsAsEvm(what.address) ? new RegExp(`(?<![0-9A-Za-z])${escape(what.address)}(?![0-9A-Za-z])`, "i") : new RegExp(`(?<![0-9A-Za-z])${escape(what.address)}(?![0-9A-Za-z])`)
  if (address.test(text)) return true
  return what.label !== undefined && new RegExp(`(?<![\\w-])${escape(what.label)}(?![\\w-])`, "i").test(text)
}

const EVERYTHING = /\b(everything|all|sweep|max|entire)\b/i
/** The numbers a message states, as numbers: "0.01", ".010" and "1,000" read as people mean them. Digits inside a word aren't one. */
function amountsIn(text: string): number[] {
  return [...text.matchAll(/(?<![\w.])(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w])/g)].map((m) => Number(m[1]!.replace(/,/g, ""))).filter((n) => Number.isFinite(n))
}

/** The text with these wallets' labels and addresses taken out, so a digit in a name ("tee-1") isn't read as an amount. */
function without(text: string, named: readonly Named[]): string {
  let out = text
  for (const n of named) {
    out = out.replace(new RegExp(`(?<![0-9A-Za-z])${escape(n.address)}(?![0-9A-Za-z])`, "gi"), " ")
    if (n.label !== undefined) out = out.replace(new RegExp(`(?<![\\w-])${escape(n.label)}(?![\\w-])`, "gi"), " ")
  }
  return out
}

/** The assets a person names by word. Anything else they name by its mint, in full. */
const TICKERS = ["SOL", "USDC", "USDG", "USDT", "ETH", "CNDL"]
const ADDRESS_IN_TEXT = new RegExp(`(?<![0-9A-Za-z])(?:${EVM_ADDRESS_SOURCE}|${LOOSE_SOLANA_ADDRESS_SOURCE})(?![0-9A-Za-z])`, "g")

/**
 * Whether the message asks for this asset: by its word (SOL, USDC…) or its mint in full. A message that
 * names no asset and no other address means SOL, the asset people leave unsaid.
 */
function assetAsked(text: string, asset: string, around: readonly Named[]): boolean {
  const said = TICKERS.filter((t) => new RegExp(`(?<![\\w])\\$?${t}(?![\\w])`, "i").test(text))
  const word = asset.toUpperCase()
  if (TICKERS.includes(word)) {
    if (said.includes(word)) return true
    const others = [...without(text, around).matchAll(ADDRESS_IN_TEXT)]
    return word === "SOL" && said.length === 0 && others.length === 0
  }
  return names(text, { address: asset })
}

/**
 * Where a message names two or more assets, whether it says this amount with this asset: each asset
 * goes with the number nearest it ("10 USDC and 1 SOL", "USDC 10, SOL 1"), the one before it on a tie.
 * Naming one asset or none, any stated amount is that asset's.
 */
function amountWithAsset(text: string, amount: number, asset: string): boolean {
  const assetRe = new RegExp(`(?<![\\w])\\$?(${TICKERS.join("|")})(?![\\w])|${ADDRESS_IN_TEXT.source}`, "gi")
  const assets = [...text.matchAll(assetRe)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, name: (m[1] ?? m[0]).toUpperCase() }))
  if (new Set(assets.map((a) => a.name)).size < 2) return true
  const numbers = [...text.matchAll(/(?<![\w.])(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w])/g)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, n: Number(m[1]!.replace(/,/g, "")) }))
  const gap = (a: { at: number; end: number }, n: { at: number; end: number }) => (n.end <= a.at ? a.at - n.end : n.at - a.end)
  const want = asset.toUpperCase()
  return assets.some((a) => {
    if (a.name !== want || numbers.length === 0) return false
    // The nearest number; on a tie, the one before the asset, as "10 USDC" is said.
    const nearest = numbers.reduce((best, n) => (gap(a, n) < gap(a, best) || (gap(a, n) === gap(a, best) && n.at < best.at) ? n : best))
    return nearest.n === amount
  })
}

export type Asked = { ok: true } | { ok: false; missing: "message" | "destination" | "amount" | "pairing" | "wallet" | "everything" | "asset" | "source" }

/**
 * Whether the user's own message this turn asked for it: the destination (its label or its address,
 * or a new address in full) and the amount; for a sweep, the wallet and "everything", "all" or
 * "sweep". The amount `max` is asked by those same words, with no other amount stated. The asset must
 * be the one the message names (unsaid, SOL); and where the message names a wallet it's sent from, it
 * must be the step's source.
 */
export function askedFor(
  text: string | undefined,
  want: { destination?: Named; amount?: string; wallet?: Named; sweep?: boolean; asset?: string; source?: { from: Named; others: readonly Named[] } },
): Asked {
  if (text === undefined || text.trim() === "") return { ok: false, missing: "message" }
  if (want.wallet && !names(text, want.wallet)) return { ok: false, missing: "wallet" }
  if (want.sweep && !EVERYTHING.test(text)) return { ok: false, missing: "everything" }
  if (want.destination && !names(text, want.destination)) return { ok: false, missing: "destination" }
  const around = [want.destination, want.source?.from].filter((n): n is Named => n !== undefined)
  if (want.amount !== undefined) {
    const stated = amountsIn(without(text, around))
    const asked = want.amount.toLowerCase() === "max" ? EVERYTHING.test(text) && stated.length === 0 : stated.includes(Number(want.amount))
    if (!asked) return { ok: false, missing: "amount" }
  }
  if (want.asset !== undefined && !assetAsked(text, want.asset, around)) return { ok: false, missing: "asset" }
  // "Send 10 USDC and 1 SOL": with more than one asset named, the amount must be the one said with this asset.
  if (want.amount !== undefined && want.amount.toLowerCase() !== "max" && want.asset !== undefined && !amountWithAsset(without(text, around), Number(want.amount), want.asset)) {
    return { ok: false, missing: "pairing" }
  }
  if (want.source && !names(text, want.source.from) && want.source.others.some((o) => names(text, o))) return { ok: false, missing: "source" }
  return { ok: true }
}

export type FundsOut =
  | { ok: true; words: string[]; notes: string[]; newAddress?: string; warning?: string; fills?: Fill[] }
  | { ok: false; code: string; message: string }

const flagValue = (words: readonly string[], flag: string): string | undefined => {
  const at = words.indexOf(flag)
  return at >= 0 ? words[at + 1] : undefined
}

/** Why a funds-out step from the agent wasn't asked for, and what to do: the user asks themselves. */
export function notAsked(missing: Exclude<Asked, { ok: true }>["missing"]): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: "ASK_FOR_IT_YOURSELF",
    message: `Funds go out only when the user asks, in their own words this turn, naming where and how much (a sweep: the wallet and "everything"), and ${MISSING[missing]}. Ask the user to ask for the transfer themselves. Nothing was run.`,
  }
}

const MISSING: Record<Exclude<Asked, { ok: true }>["missing"], string> = {
  message: "there's no message from the user this turn",
  destination: "the user's message doesn't name where it goes",
  amount: "the user's message doesn't say how much",
  pairing: "the user's message names more than one asset, and doesn't say this amount with this asset",
  wallet: "the user's message doesn't name the wallet",
  everything: "the user's message doesn't say to move everything",
  asset: "the user's message names another asset, or none where it isn't SOL (name a token by its mint in full)",
  source: "the user's message names another wallet to send it from",
}

/** `vault demote`'s flags that take a value, so a wallet is told from a flag's value. */
const DEMOTE_VALUE_FLAGS = new Set(["--keystore", "-k", "--rpc-url", "--sweep-to", "--from-block", "--token"])

/** `vault transfer`'s usage, as the CLI's help gives it, less what the Candle Harness sets itself (--rpc-url) and the EVM forms. */
export const TRANSFER_USAGE = "candle vault transfer <to> --amount <n|max> --asset SOL|<mint> --from <label>"

/**
 * A funds-out step as the Candle Harness runs it: the destination checked (a label goes on the command line as
 * its address, which the CLI takes), the card's words, and from the agent, "asked for". Pure: the
 * caller reads the known list and the user's message, and passes them in.
 */
export function prepareFundsOut(
  words: readonly string[],
  ctx: {
    known: readonly Destination[]
    /** The user's own message this turn; undefined when there's none (another harness, or no turn). */
    asked: string | undefined
    /** The user typed the line: it's the ask. */
    typed: boolean
    valueFlags: readonly string[]
    /** Whether a TEE wallet is still enabled, from the portfolio; undefined when unknown. */
    teeEnabled?: (address: string) => boolean | undefined
    /** A TEE wallet's pinned vault, from the wallets read. */
    pinnedVault?: (address: string) => string | undefined
    /** A TEE wallet this Candle Harness stopped for good, or swept and retired: never somewhere to send funds. */
    gone?: (address: string) => "stopped" | "retired" | undefined
  },
): FundsOut {
  const fail = (code: string, message: string): FundsOut => ({ ok: false, code, message: `${message} Nothing was run.` })
  const out = [...words]
  const path = `${words[0]} ${words[1]}`
  const [first] = positionals(words, ctx.valueFlags)
  const notes: string[] = []
  let newAddress: string | undefined
  let warning: string | undefined
  let fills: Fill[] | undefined

  /** The destination checked; a known label replaced by its address where the CLI wants an address. */
  const destination = (word: string, at: number, opts: { resolve: boolean; newAllowed: boolean; labelsPass?: boolean }): { ok: true; named: Named; d?: Destination } | { ok: false; why: FundsOut } => {
    const check = checkDestination(word, ctx.known)
    const shown = terminalText(word, { maxLength: 44 })
    // `vault list` still lists a retired TEE wallet as a plain one, so it's easy to fund by mistake.
    const address = check.kind === "known" ? check.destination.address : check.kind === "new" ? check.address : undefined
    const gone = address ? ctx.gone?.(address) : undefined
    if (gone === "stopped") return { ok: false, why: fail("STOPPED_DESTINATION", `${shown} is a TEE wallet stopped for good: anything sent there only waits to be swept home. Send it to a wallet that works.`) }
    if (gone === "retired") return { ok: false, why: fail("RETIRED_DESTINATION", `${shown} is a TEE wallet that was swept home and retired: the CLI says a retired address must never be used again.`) }
    switch (check.kind) {
      case "known":
        if (opts.resolve && at >= 0) out[at] = check.destination.address
        return { ok: true, named: check.destination, d: check.destination }
      case "lookalike":
        return { ok: false, why: fail("LOOKALIKE_DESTINATION", `${shown} looks like ${destinationWords(check.like)}, but isn't it: same first and last four characters. Check the address.`) }
      case "new":
        if (!opts.newAllowed) return { ok: true, named: { address: word } }
        newAddress = inGroupsOfFour(word)
        return { ok: true, named: { address: word } }
      case "unknown-label":
        if (opts.labelsPass) return { ok: true, named: { address: word, label: word } }
        if (check.mistyped) {
          const want = startsAsEvm(word) ? "an EVM address is 0x and 40 more" : "a Solana address is 32 to 44"
          return { ok: false, why: fail("MISTYPED_ADDRESS", `${shown} is ${word.length} characters, and ${want}: it looks cut short or run on. Copy the address again, whole.`) }
        }
        return { ok: false, why: fail("UNKNOWN_DESTINATION", `${shown} isn't a wallet or vault key the Candle Harness knows. Give the address in full, or run candle vault list in the pane first so the Candle Harness knows your vault keys.`) }
    }
  }
  /** The wallet a send leaves from, and the others it could have left from: a vault key or a TEE wallet the Candle Harness knows. */
  const sourceOf = (from: string, to: Named): { from: Named; others: Named[] } => {
    const sources = ctx.known.filter((k) => k.kind === "vault-key" || k.kind === "tee")
    const source = sources.find((k) => keyOf(k.address) === keyOf(from) || k.label === from) ?? { address: from, label: from }
    return { from: source, others: sources.filter((k) => keyOf(k.address) !== keyOf(source.address) && keyOf(k.address) !== keyOf(to.address)) }
  }
  const asked = (want: Parameters<typeof askedFor>[1]): FundsOut | undefined => {
    if (ctx.typed) return undefined
    const r = askedFor(ctx.asked, want)
    return r.ok ? undefined : notAsked(r.missing)
  }

  switch (path) {
    case "vault transfer": {
      if (first === undefined) return fail("NAME_THE_DESTINATION", `Name where it goes: ${TRANSFER_USAGE}.`)
      const from = flagValue(words, "--from")
      const amount = flagValue(words, "--amount")
      const asset = flagValue(words, "--asset")
      // Every missing flag in one refusal, so the agent's next try can be right.
      if (from === undefined || amount === undefined || asset === undefined) {
        const missing = [
          ...(from === undefined ? [{ code: "NAME_THE_SOURCE", what: "the vault key or TEE wallet it's sent from (--from <label>)" }] : []),
          ...(amount === undefined ? [{ code: "NAME_THE_AMOUNT", what: "the amount (--amount <n>, or max for all of it)" }] : []),
          ...(asset === undefined ? [{ code: "NAME_THE_ASSET", what: "the asset (--asset SOL or a mint)" }] : []),
        ]
        const whats = missing.map((m) => m.what)
        const list = whats.length === 1 ? whats[0] : `${whats.slice(0, -1).join(", ")} and ${whats.at(-1)}`
        return fail(missing[0]!.code, `Name ${list}: ${TRANSFER_USAGE}.`)
      }
      const d = destination(first, words.indexOf(first, 2), { resolve: true, newAllowed: true })
      if (!d.ok) return d.why
      const stop = asked({ destination: d.named, amount, asset, source: sourceOf(from, d.named) })
      if (stop) return stop
      // max (CLI 0.13.11) is the whole balance of that asset, less the fee for SOL.
      const sends = amount.toLowerCase() === "max" ? `all of its ${terminalText(asset, { maxLength: 44 })}` : `${terminalText(amount, { maxLength: 24 })} ${terminalText(asset, { maxLength: 44 })}`
      notes.push(`Sends ${sends} from ${terminalText(from, { maxLength: 40 })} to ${d.d ? destinationWords(d.d) : "a new address"}.`)
      break
    }
    case "vault fund": {
      if (first === undefined) return fail("NAME_THE_DESTINATION", "Name the TEE wallet or external key it funds.")
      const amount = flagValue(words, "--amount")
      if (amount === undefined) return fail("NAME_THE_AMOUNT", "Name the amount, with --amount <n>.")
      // An external key goes by its label, which the CLI finds in the vault: it's the user's own.
      const d = destination(first, words.indexOf(first, 2), { resolve: false, newAllowed: true, labelsPass: true })
      if (!d.ok) return d.why
      // The CLI sends SOL when --asset is left out.
      const asset = flagValue(words, "--asset") ?? "SOL"
      const from = flagValue(words, "--from")
      const stop = asked({ destination: d.named, amount, asset, ...(from !== undefined ? { source: sourceOf(from, d.named) } : {}) })
      if (stop) return stop
      notes.push(`Funds ${d.d ? destinationWords(d.d) : newAddress ? "a new address" : terminalText(first, { maxLength: 40 })} with ${terminalText(amount, { maxLength: 24 })} ${terminalText(asset, { maxLength: 44 })} from your vault.`)
      break
    }
    case "tee sweep": {
      if (first === undefined) return fail("NAME_THE_WALLET", "Name the TEE wallet to sweep, by its address.")
      // TEE commands take the address, not the label: a known label goes on as its address.
      const tee = ctx.known.find((d) => d.kind === "tee" && (keyOf(d.address) === keyOf(first) || d.label === first))
      if (tee) out[words.indexOf(first, 2)] = tee.address
      const wallet: Named = tee ?? { address: first }
      const stop = asked({ wallet, sweep: true })
      if (stop) return stop
      const vault = ctx.pinnedVault?.(wallet.address)
      const home = vault ? (ctx.known.find((d) => keyOf(d.address) === keyOf(vault)) ?? { address: vault, kind: "pinned-vault" as const }) : undefined
      notes.push(`Sweeps everything from ${tee ? destinationWords(tee) : terminalText(first, { maxLength: 44 })} to its pinned vault${home ? `, ${destinationWords(home)}` : ""}. The CLI sends nowhere else.`)
      if (ctx.teeEnabled?.(wallet.address) === true) {
        warning = "This TEE wallet is still enabled, and the CLI refuses to sweep an enabled one. Disable it first, then sweep."
        fills = [{ label: "disable it first", line: `candle tee disable ${wallet.address}` }]
      }
      break
    }
    case "external sweep": {
      if (first === undefined) return fail("NAME_THE_WALLET", "Name the external key to sweep.")
      const to = flagValue(words, "--to")
      if (to === undefined) return fail("NAME_THE_DESTINATION", "Name the vault key it all goes to, with --to <label>.")
      // The CLI sends only to a vault key in this same vault, so a label it finds there is home.
      const d = destination(to, words.indexOf(to), { resolve: false, newAllowed: false, labelsPass: true })
      if (!d.ok) return d.why
      const stop = asked({ wallet: { address: first }, sweep: true })
      if (stop) return stop
      notes.push(`Sweeps everything from ${terminalText(first, { maxLength: 40 })} to ${d.d ? destinationWords(d.d) : terminalText(to, { maxLength: 40 })}. The CLI sends only to a vault key in this vault.`)
      break
    }
    case "vault demote": {
      // A way home: disable, then sweep to the pinned vault, or --sweep-to a vault key the CLI checks.
      const to = flagValue(words, "--sweep-to")
      if (to !== undefined) {
        const d = destination(to, -1, { resolve: false, newAllowed: false, labelsPass: true })
        if (!d.ok) return d.why
      }
      // `--all --empty` stops every empty TEE wallet the vault holds, naming none: the card couldn't say which,
      // and the user's words couldn't be checked against them.
      if (words.includes("--all") || words.includes("--empty")) return fail("NAME_EACH_WALLET", "candle vault demote --all --empty names no wallet, so the card couldn't say which it stops for good: name each wallet instead.")
      // Several wallets (CLI 0.13.11) demote one after another under one unlock and one confirm: the card says how many.
      const wallets = words.slice(2).filter((w, i, all) => !w.startsWith("-") && !(i > 0 && DEMOTE_VALUE_FLAGS.has(all[i - 1]!)))
      // It stops each wallet for good: from the agent, the user's own words this turn name every one, as a sweep's do.
      for (const w of wallets) {
        const tee = ctx.known.find((d) => d.kind === "tee" && (keyOf(d.address) === keyOf(w) || d.label === w))
        const stop = asked({ wallet: tee ?? { address: w } })
        if (stop) return stop
      }
      if (wallets.length > 1) notes.push(`Demotes ${wallets.length} TEE wallets, one after another under one unlock and one confirm: each is stopped for good, then swept to ${to !== undefined ? terminalText(to, { maxLength: 40 }) : "its pinned vault"}.`)
      break
    }
  }
  return { ok: true, words: out, notes, ...(newAddress ? { newAddress } : {}), ...(warning ? { warning } : {}), ...(fills ? { fills } : {}) }
}
