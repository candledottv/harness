// Which wallets each agent's key may pay from, kept so proposing a card needs no
// network call for it. Three reads, joined:
//   embedded  candle_execution_status, as AgentStatusBook reads it: there only when the owner has
//             allowed this key on the account's embedded wallet;
//   TEE       candle_get_profile_wallets { keyPrefix } on the agent's own MCP child (as recorded: the TEE
//             wallet bound to the key, under walletScope "selected", spendCapable, and none for any
//             other key), corrected by
//   trading   candle_get_trading_wallets, where the agent's MCP server has it: the key's wallets as its trades
//             see them, each with Candle's `active`. A wallet made by `vault promote --to-key` signs and trades
//             while the profile read still says `spendCapable: false`, under another id than the one the portfolio
//             and `tee status` give it; the trading read's flag and id win. Then all of it is joined by address to
//   portfolio candle_get_portfolio's `tee` (Solana) and `hood.tee` arrays, which list every TEE wallet
//             on the account, whichever key holds it, with its label and active flag.
// Under walletScope "all" an empty list means every wallet (mcp/src/tools.ts:1639-1651), which says
// nothing about which TEE wallets are bound to this key, so each of the portfolio's Solana TEE wallets is
// asked of the CLI instead: `candle tee status <address> --json` under the agent's key answers the bound
// row or TEE_WALLET_NOT_ON_KEY (cli/src/commands/tee-status-wallet.ts:10-26). Never seen live: every
// key Candle makes reports "selected".
//
// Read at core start, every 5 minutes while a view is attached, and after anything that changes keys
// or wallets; never on approve. A failed read keeps the last answer, with when it was read. At run time
// the CLI's own resolution of `--wallet` is the authority (TEE_WALLET_REQUIRED); this is what lets a
// card be refused at proposal, naming the wallets the agent can pay from.
import { terminalText } from "../shared/terminal-text"
import type { AgentStatus } from "./agent-status"
import type { ToolOutcome } from "./candle-mcp"
import type { EmptyState } from "./empty-accounts"
import { groupLookup, type WalletGroup } from "./wallet-groups"
import { buildNames, lookupWallet, markedWords, short, type WalletNameEntry, walletName } from "./wallet-names"
import { addressKey, sameAddress } from "../shared/address-key"

/** How often the reads are repeated while a view is attached. */
export const WALLETS_REFRESH_MS = 5 * 60_000

export interface TeeWallet {
  id: string
  address: string
  label?: string
  /** "solana" or "hood" (Candle's key reads say "evm" for Hood, taken as "hood"): a trade pays from a wallet on its own chain. */
  chain: string
  /** Candle's active flag from the portfolio, and the profile read's spendCapable: both, to pay from it. */
  active: boolean
  /**
   * Bound to the key and not stopped, but Candle doesn't list it as able to sign (spendCapable false): a
   * fresh wallet whose signing policy Candle hasn't recorded. Nothing pays from it, and no owner step here changes that.
   */
  cantSign?: true
}

export interface Payable {
  /** The account's embedded Solana wallet, when this key is allowed it. */
  embedded?: { address: string; chain: "solana" }
  /** The TEE wallets bound to this key. */
  tee: TeeWallet[]
  /** When the TEE wallets were last read; undefined before the first good read. */
  readAt: number | undefined
  /** The reads that failed last time: what they'd say is unknown, not empty. */
  unreadable: string[]
  /** The account's plan, from the status read: TEE wallets need Pro or Max. */
  tier?: string
}

export type PayerResult =
  | { ok: true; kind: "embedded"; address: string; chain: "solana" | "hood" }
  | { ok: true; kind: "tee"; address: string; id: string; label?: string; chain: string }
  | { ok: false; code: string; message: string; canPayFrom: string[] }

export interface WalletDeps {
  /** `tools`, where the client has it, says whether the agent's MCP server lists a tool, so a missing one isn't called. */
  pool: { for(agent: string): { call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>; tools?(): readonly { name: string }[] } }
  status: { get(agent: string): AgentStatus | undefined; refresh(agent: string): Promise<AgentStatus | undefined> }
  agents: () => string[]
  keyPrefix: (agent: string) => string | undefined
  /** The newest candle_get_portfolio result the core holds, or undefined before one. */
  portfolio: () => unknown
  /** Reads the portfolio now, for a scope-"all" read made before the first one. */
  readPortfolio?: () => Promise<void>
  /** `candle tee status <address> --json` under the agent's key, for walletScope "all". */
  teeStatus?: (agent: string, address: string) => Promise<"bound" | "not_on_key" | "unreadable">
  /** The agent's default paying wallet from config. */
  defaultWallet: (agent: string) => string | undefined
  /** Where each default was last found (default-pins.ts), so a rename never leaves it naming no wallet. */
  pins?: { get(agent: string, setting: string | undefined): string | undefined; set(agent: string, setting: string, address: string): void }
  now: () => number
  /** Called after each read, whether it worked or not. */
  onChange?: () => void
  /** Every wallet the Candle Harness knows and its name. */
  names?: () => WalletNameEntry[]
  /** The person's wallet groups: never a payer, so `from <group>` is refused by name. */
  groups?: () => WalletGroup[]
  /** Whether Candle's own wallets read names this address as an imported (not TEE) wallet; undefined when it doesn't say. */
  imported?: (address: string) => boolean | undefined
}

interface ProfileRow {
  id: string
  address: string
  label?: string
  chain: string
  spendCapable: boolean
}

interface Read {
  rows: ProfileRow[]
  readAt: number | undefined
  unreadable: string[]
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
/**
 * A wallet's chain as the Candle Harness names it: Candle's key reads call a Hood wallet "evm" (cli/src/trading.ts
 * rowChain), the portfolio calls it "hood", and one wallet must be on one chain whichever read named it.
 */
export const walletChain = (value: unknown, fallback: string): string => (value === "evm" ? "hood" : typeof value === "string" ? value : fallback)
// Up to Candle's 64: a name is never cut where it's read.
const label = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? terminalText(value, { maxLength: 64 }) : undefined)

/** candle_get_profile_wallets' answer (cli/src/commands/keys-wallets.ts:48-62), or undefined for any other shape. */
export function parseProfileWallets(result: unknown): { scope: "all" | "selected"; rows: ProfileRow[] } | undefined {
  const body = record(result)
  if (!body || (body.walletScope !== "all" && body.walletScope !== "selected") || !Array.isArray(body.wallets)) return undefined
  const rows: ProfileRow[] = []
  for (const entry of body.wallets) {
    const w = record(entry)
    if (typeof w?.linkedWalletId !== "string" || typeof w.address !== "string") continue
    const l = label(w.label)
    rows.push({ id: w.linkedWalletId, address: w.address, ...(l ? { label: l } : {}), chain: walletChain(w.chain, "solana"), spendCapable: w.spendCapable === true })
  }
  return { scope: body.walletScope, rows }
}

/** One of the key's wallets as `candle_get_trading_wallets` reports it: Candle's own id, and whether its trades may run. */
export interface TradingRow {
  id: string
  address: string
  label?: string
  chain: string
  active: boolean
}

/**
 * One page of candle_get_trading_wallets' answer (`page` of the key's wallets, each with `id`, `address`, `chain`,
 * `label`, `active` and `walletKind`), or undefined for any other shape. Only TEE wallets: the embedded wallet is read
 * from the status. `complete` is false while Candle says more pages follow, with the `cursor` that reads the next.
 */
export function parseTradingWallets(result: unknown): { rows: TradingRow[]; complete: boolean; cursor?: string } | undefined {
  const body = record(result)
  if (!body || !Array.isArray(body.page)) return undefined
  const rows: TradingRow[] = []
  for (const entry of body.page) {
    const w = record(entry)
    if (typeof w?.id !== "string" || typeof w.address !== "string") continue
    if (w.walletKind !== undefined && w.walletKind !== "tee") continue
    const chain = walletChain(w.chain, "solana")
    const l = label(w.label)
    rows.push({ id: w.id, address: w.address, ...(l ? { label: l } : {}), chain, active: w.active === true })
  }
  const complete = body.isDone !== false
  return { rows, complete, ...(!complete && typeof body.continueCursor === "string" && body.continueCursor !== "" ? { cursor: body.continueCursor } : {}) }
}

/** Pages of the trading read followed before it's taken as cut short. */
export const TRADING_PAGES_MAX = 10

/**
 * The key's rows with the trading read laid over them: a wallet both name takes the trading read's id and `active` as its
 * `spendCapable`; one only the trading read names is bound to the key too. A complete read is the whole list of what may
 * trade, so a row it leaves out can't pay; one cut short says nothing of the rows it didn't reach. Without a trading
 * read, the rows as they are.
 */
export function withTrading(rows: readonly ProfileRow[], trading: { rows: TradingRow[]; complete: boolean } | undefined): ProfileRow[] {
  if (!trading) return [...rows]
  const out: ProfileRow[] = rows.map((row) => {
    const t = trading.rows.find((w) => sameAddress(w.address, row.address))
    if (!t) return trading.complete ? { ...row, spendCapable: false } : row
    return { ...row, id: t.id, spendCapable: t.active, ...(row.label === undefined && t.label ? { label: t.label } : {}) }
  })
  for (const t of trading.rows) {
    if (!out.some((row) => sameAddress(row.address, t.address))) out.push({ id: t.id, address: t.address, ...(t.label ? { label: t.label } : {}), chain: t.chain, spendCapable: t.active })
  }
  return out
}

/** Every TEE wallet the portfolio lists, Solana's then Hood's, as Candle reports them. */
export function portfolioTee(portfolio: unknown): TeeWallet[] {
  const body = record(portfolio)
  const out: TeeWallet[] = []
  for (const [chain, list] of [["solana", body?.tee], ["hood", record(body?.hood)?.tee]] as const) {
    for (const entry of asArray(list)) {
      const w = record(entry)
      if (typeof w?.id !== "string" || typeof w.address !== "string") continue
      const l = label(w.label)
      out.push({ id: w.id, address: w.address, ...(l ? { label: l } : {}), chain: walletChain(w.chain, chain), active: w.active !== false })
    }
  }
  return out
}

/**
 * The key's rows, joined to the portfolio. A row that isn't spendCapable stays listed, as not active:
 * what spendCapable says for a stopped wallet was never recorded, and dropping it would have the
 * wallet named as another key's. Once the portfolio is read, a row it doesn't list as a TEE wallet is
 * left out when it's an imported linked wallet, which the Candle Harness doesn't pay from. One Candle can't
 * sign for yet (a fresh TEE wallet whose signing policy Candle hasn't recorded) is missing from the
 * portfolio's TEE list too; it stays, marked, so it doesn't vanish from the panes and the approvals menu
 * after each portfolio read, and a refusal can say why.
 */
export function joinTee(rows: readonly ProfileRow[], portfolio: unknown, imported?: (address: string) => boolean | undefined): TeeWallet[] {
  // By address: the key's list can give a wallet another id than the portfolio does.
  const account = portfolio === undefined ? undefined : new Map(portfolioTee(portfolio).map((w) => [addressKey(w.address), w]))
  const out: TeeWallet[] = []
  for (const row of rows) {
    // A Solana row and an entry on an EVM chain are never one wallet, whatever their addresses read as.
    const entry = account?.get(addressKey(row.address))
    const known = entry && (entry.chain === "solana") === (row.chain === "solana") ? entry : undefined
    if (account && !known) {
      if (row.spendCapable || imported?.(row.address) === true) continue
      out.push({ id: row.id, address: row.address, ...(row.label ? { label: row.label } : {}), chain: row.chain, active: false, cantSign: true })
      continue
    }
    const l = known?.label ?? row.label
    const stopped = known?.active === false
    out.push({ id: known?.id ?? row.id, address: row.address, ...(l ? { label: l } : {}), chain: known?.chain ?? row.chain, active: !stopped && row.spendCapable, ...(!stopped && !row.spendCapable ? { cantSign: true as const } : {}) })
  }
  return out
}

export interface PayerContext {
  agent: string
  payable: Payable
  /** Whether the embedded wallet is denied, or undefined before the status read. */
  embeddedWallet: "allowed" | "denied" | undefined
  evm?: string
  prefix?: string
  /** Every TEE wallet on the account, to say whose a named one is. */
  account: TeeWallet[]
  boundTo: (address: string) => string | undefined
  defaultWallet?: string
  /** The address defaultWallet was last found at, while the line is unchanged (default-pins.ts): the default pays from it. */
  defaultPin?: string
  chain?: "solana" | "hood"
  /** Every wallet the Candle Harness knows and its name (wallet-names.ts); without it, the TEE wallets' own labels. */
  names?: readonly WalletNameEntry[]
  /** The wallet groups: a group never pays, and naming one says so. */
  groups?: readonly WalletGroup[]
}

/** The names a context without the core's book goes by: its wallets' own labels. */
function namesOf(ctx: Pick<PayerContext, "agent" | "payable" | "account" | "evm">): WalletNameEntry[] {
  const tee = [...ctx.payable.tee, ...ctx.account.filter((t) => !ctx.payable.tee.some((p) => p.address === t.address))]
  return buildNames({
    embedded: [ctx.payable.embedded?.address, ctx.evm].filter((a): a is string => a !== undefined),
    tee: tee.map((t) => ({ address: t.address, ...(t.label ? { label: t.label } : {}) })),
    linked: [],
    vaultKeys: [],
    other: [],
    harness: {},
    agents: [ctx.agent],
  })
}

type Fail = { code: string; /** The whole sentence, for a word given. */ sentence: string; /** Why, as a clause, for a default that can't pay. */ clause: string }

/** A wallet an agent can pay from: its name in messages, and the word that names it on a card (`embedded`, or the address). */
export interface PayableWallet {
  name: string
  word: string
  kind: "embedded" | "tee"
  address: string
  /** The chain its trades are on: the embedded wallet here is the Solana one. */
  chain: string
}

/** The chains a TEE wallet trades on: `candle swap` runs a Solana TEE wallet's trades, and a Hood one's one leg at a time. */
const TRADING_CHAINS: ReadonlySet<string> = new Set(["solana", "hood"])

/** Its key's TEE wallets that pay now: active, on a chain a trade runs on, and none on Free. */
const payingTee = (payable: Payable): TeeWallet[] => (payable.tier === "free" ? [] : payable.tee.filter((t) => TRADING_CHAINS.has(t.chain) && t.active))

/** What the agent can pay from now: the embedded wallet when its key is allowed it, then its active TEE wallets, Solana's and Hood's (none on Free). */
export function payableWallets(payable: Payable, names?: readonly WalletNameEntry[]): PayableWallet[] {
  return [
    ...(payable.embedded ? [{ name: "embedded", word: "embedded", kind: "embedded" as const, address: payable.embedded.address, chain: "solana" }] : []),
    ...payingTee(payable).map((t) => ({ name: walletName(names, { ...t, kind: "tee" as const }), word: t.address, kind: "tee" as const, address: t.address, chain: t.chain })),
  ]
}

/** The wallet a trade pays from, or why not (pure: the core, the doctor and the view's input line all use it). */
export function resolvePayer(ctx: PayerContext, word?: string): PayerResult {
  const { agent, payable } = ctx
  const free = payable.tier === "free"
  const names = ctx.names ?? namesOf(ctx)
  const wallets = payableWallets(payable, names)
  const canPayFrom = wallets.map((w) => w.name)
  // The embedded wallet by its own name where it has one, so a message names it one way.
  const words = wallets.map((w) => {
    if (w.kind !== "embedded") return w.name
    const own = walletName(names, { address: w.address, kind: "embedded" })
    return own === "embedded" ? own : `${own} (embedded)`
  })
  // Past eight, the first six and a count (at 50 wallets the list ran off the message); the Wallets pane lists them all.
  const listed = words.length > 8 ? `${words.slice(0, 6).join(", ")} and ${words.length - 6} more (the Wallets pane lists them)` : words.join(", ")
  const list = canPayFrom.length ? ` It can pay from: ${listed}.` : " It has no wallet it can pay from."
  const no = (f: Fail): PayerResult => ({ ok: false, code: f.code, message: `${f.sentence}${list}`, canPayFrom })

  if (ctx.embeddedWallet === undefined && payable.readAt === undefined) {
    return { ok: false, code: "WALLETS_UNKNOWN", message: `Couldn't read ${agent}'s wallets from Candle yet, so no card was made. Try again in a moment.`, canPayFrom }
  }
  const allow = `candle keys update ${ctx.prefix ?? "<prefix>"} --embedded-wallet allow`
  const tradeChain = ctx.chain ?? "solana"
  const chainWord = (chain: string): string => (chain === "hood" ? "Hood" : chain === "solana" ? "Solana" : chain)
  const wrongChain = (name: string, chain: string): Fail => ({
    code: "WRONG_CHAIN",
    sentence: `${name} is a ${chainWord(chain)} wallet, and this trade is on ${chainWord(tradeChain)}: a trade pays from a wallet on its own chain.`,
    clause: `it's a ${chainWord(chain)} wallet, and this trade is on ${chainWord(tradeChain)}`,
  })
  const embedded = (): PayerResult | Fail => {
    if (ctx.embeddedWallet === "denied") {
      return {
        code: "EMBEDDED_WALLET_NOT_PERMITTED",
        sentence: `${agent}'s key isn't allowed to trade from the account's embedded wallet. The owner allows it by typing this in the Candle Harness, where it runs in the prompt pane as them: ${allow}.`,
        clause: `its key isn't allowed the embedded wallet (the owner allows it with ${allow})`,
      }
    }
    if (ctx.chain === "hood") {
      if (ctx.evm) return { ok: true, kind: "embedded", address: ctx.evm, chain: "hood" }
      return { code: "AGENT_WALLET_MISSING", sentence: `The account has no embedded Hood wallet for ${agent} to trade from.`, clause: "the account has no embedded Hood wallet" }
    }
    if (!payable.embedded) return { code: "AGENT_WALLET_MISSING", sentence: `The account has no embedded Solana wallet for ${agent} to trade from.`, clause: "the account has no embedded Solana wallet" }
    return { ok: true, kind: "embedded", address: payable.embedded.address, chain: "solana" }
  }
  const tee = (t: TeeWallet): PayerResult | Fail => {
    const name = walletName(names, { ...t, kind: "tee" })
    if (free) return { code: "TEE_TIER_REQUIRED", sentence: `${name} is a TEE wallet, and TEE wallets are a Pro or Max feature: this account is on Free.`, clause: "TEE wallets are a Pro or Max feature, and this account is on Free" }
    // A trade pays from a wallet on its own chain: a Solana wallet never pays for a Hood token, nor a Hood
    // wallet for a Solana one, named or as the default.
    if (tradeChain !== t.chain) return wrongChain(name, t.chain)
    if (t.cantSign) return { code: "TEE_WALLET_CANT_SIGN", sentence: `Candle doesn't list ${name} as able to sign for ${agent}'s key yet, so nothing can trade from it. That's on Candle's side: no owner step here changes it, so it isn't a stopped wallet and needs no enable or rebind.`, clause: "Candle doesn't list it as able to sign yet (on Candle's side; no owner step changes it)" }
    if (!t.active) return { code: "TEE_WALLET_INACTIVE", sentence: `${name} is stopped on Candle's side (inactive), so nothing can trade from it.`, clause: "it's stopped on Candle's side (inactive)" }
    // `label` is what the wallet is called (its name in the book, Candle's label or the Candle Harness's stand-in): what the card says.
    const called = names.find((e) => e.address === t.address)?.name ?? t.label
    return { ok: true, kind: "tee", address: t.address, id: t.id, ...(called ? { label: terminalText(called, { maxLength: 64 }) } : {}), chain: t.chain }
  }
  const named = (raw: string, asDefault = false): PayerResult | Fail => {
    const w = raw.trim()
    const shown = terminalText(w, { maxLength: 64 })
    if (w.toLowerCase() === "embedded") return embedded()
    // The exact address first, then a name: any wallet's, by the Candle Harness's one book. A name
    // that breaks the Candle Harness's rules, or that two wallets share, picks nothing: it's taken by address only.
    const look = lookupWallet(names, w)
    if (look.kind === "marked") {
      const ambiguous = look.entries.length > 1
      return { code: ambiguous ? "WALLET_AMBIGUOUS" : "WALLET_NAME_MARKED", sentence: markedWords(w, look.entries), clause: ambiguous ? "more than one wallet has that name, so name it by address" : "that name breaks the Candle Harness's naming rules, so name it by address" }
    }
    // A group organises only: it never pays, so naming one is refused with a wallet in it to name.
    const group = look.kind === "none" && ctx.groups ? groupLookup(ctx.groups, w) : undefined
    if (group) {
      const first = group.members[0]
      const such = first ? `, such as ${walletName(names, { address: first })}` : ""
      return { code: "WALLET_IS_GROUP", sentence: `${shown} is a group, and a group never pays: name one wallet in it${such}.`, clause: "it's a group, and a group never pays" }
    }
    const address = look.kind === "found" ? look.entry.address : w
    // Each embedded address is on one chain: named for a trade on the other, it's refused, never swapped for its twin.
    const solanaEmbedded = payable.embedded !== undefined && address === payable.embedded.address
    const evmEmbedded = ctx.evm !== undefined && address.toLowerCase() === ctx.evm.toLowerCase()
    // A default that lands on either embedded address (its pin is whichever one it first resolved to) is the embedded wallet on the trade's chain.
    if (!asDefault && solanaEmbedded && tradeChain !== "solana") return wrongChain(`${shown} (the embedded wallet)`, "solana")
    if (!asDefault && evmEmbedded && tradeChain !== "hood") return wrongChain(`${shown} (the embedded wallet)`, "hood")
    if (solanaEmbedded || evmEmbedded) return embedded()
    const byKey = payable.tee.find((t) => t.address === address || t.id === w)
    if (byKey) return tee(byKey)
    // Not this agent's: say whose, where that's known.
    const elsewhere = ctx.account.find((t) => t.address === address || t.id === w)
    let clause = "it isn't one of its wallets"
    if (payable.readAt === undefined) clause = "couldn't read which TEE wallets its key holds, so try again in a moment"
    else if (elsewhere) {
      const other = ctx.boundTo(elsewhere.address)
      // "and only that key": an agent once offered to bind another agent's wallet to its own key "as well".
      clause = `${other && other !== agent ? `it's bound to ${other}'s key` : "it's bound to another key"}, and a TEE wallet is bound to one key only`
    }
    return { code: "WALLET_NOT_PAYABLE", sentence: `${agent} can't pay from ${shown}${clause === "it isn't one of its wallets" ? "" : `: ${clause}`}.`, clause }
  }
  const done = (r: PayerResult | Fail): PayerResult => ("ok" in r ? r : no(r))

  if (word !== undefined && word.trim() !== "") return done(named(word))
  // The agent's default when it's set, never quietly swapped for another wallet. Once found, by
  // its address (default-pins.ts): a rename leaves the line's name on no wallet, or on another one.
  if (ctx.defaultWallet !== undefined) {
    const picked = named(ctx.defaultPin ?? ctx.defaultWallet, true)
    if ("ok" in picked) return picked
    const setting = `agents.${agent}.wallet = "${terminalText(ctx.defaultWallet, { maxLength: 64 })}"`
    return {
      ok: false,
      code: "DEFAULT_WALLET_NOT_PAYABLE",
      message: `${agent}'s default wallet (${setting}) can't pay: ${picked.clause}.${list} Change it in config.toml, or name a wallet.`,
      canPayFrom,
    }
  }
  // No wallet named and no default: the embedded wallet on the trade's chain where the key is allowed it, as
  // `candle swap` picks (cli/src/trading.ts tradingPayer), else the one TEE wallet on that chain.
  const embeddedHere = ctx.embeddedWallet !== "denied" && (tradeChain === "hood" ? ctx.evm !== undefined : payable.embedded !== undefined)
  if (embeddedHere) return done(embedded())
  const onChain = payingTee(payable).filter((t) => t.chain === tradeChain)
  if (onChain.length === 1) return done(tee(onChain[0]!))
  if (onChain.length > 1) {
    return no({ code: "WALLET_NOT_NAMED", sentence: `${agent} can pay from more than one ${chainWord(tradeChain)} TEE wallet and has no default: name one, or set agents.${agent}.wallet in config.toml.`, clause: "" })
  }
  // A Hood trade with neither: the embedded wallet says why (denied, or none on the account).
  if (tradeChain === "hood") return done(embedded())
  // Nothing payable: say why from the wallets it does have.
  if (free && payable.tee.length > 0) return done(tee(payable.tee[0]!))
  // Denied the embedded wallet with no TEE wallet on this chain: the denial and its fix are the reason.
  if (ctx.embeddedWallet === "denied" && !payable.tee.some((t) => t.chain === tradeChain)) return done(embedded())
  // It can pay on the other chain only: said for this one, so the list after it doesn't contradict it.
  return no({ code: "NO_PAYABLE_WALLET", sentence: `${agent} has no ${wallets.length > 0 ? `${chainWord(tradeChain)} ` : ""}wallet it can pay from.`, clause: "" })
}

/**
 * The `wallets` topic: what each agent can pay from, and enough besides for a view to
 * run resolvePayer itself, so a typed `from <wallet>` is refused with the core's own words before
 * anything is sent. The core checks it again when the card is proposed.
 */
export interface WalletsTopic {
  agents: Record<string, AgentWalletsView>
  /** Every TEE wallet on the account, to say whose a named one is. */
  account: TeeWallet[]
  /** TEE wallet address to the agent whose key holds it. */
  boundTo: Record<string, string>
  /** Every wallet the Candle Harness knows and what it's called, so a view's `from <name>` reads as the core's. */
  names?: WalletNameEntry[]
  /** The wallet groups: the panes group by them, and `from <group>` is refused by the core's rule. */
  groups?: WalletGroup[]
  /** The last change to a group, for the undo chip under the agent's reply when it was the agent's. */
  grouped?: { changeId: string; words: string; at: number; agent?: string }
  /** Each TEE wallet's empty token accounts, by address, as Candle's preview last counted them. */
  empty?: Record<string, EmptyState>
}

export interface AgentWalletsView {
  payable: Payable
  /** Whether the key is allowed the embedded wallet, or absent before the status read. */
  embeddedWallet?: "allowed" | "denied"
  evm?: string
  prefix?: string
  /** The agent's default wallet from config. */
  defaultWallet?: string
  /** The address that default was last found at (default-pins.ts). */
  defaultPin?: string
}

/** The PayerContext a view rebuilds from the topic, for resolvePayer. */
export function payerContextFrom(topic: WalletsTopic, agent: string, chain?: "solana" | "hood"): PayerContext | undefined {
  const a = topic.agents[agent]
  if (!a) return undefined
  return {
    agent,
    payable: a.payable,
    embeddedWallet: a.embeddedWallet,
    ...(a.evm ? { evm: a.evm } : {}),
    ...(a.prefix ? { prefix: a.prefix } : {}),
    account: topic.account,
    boundTo: (address) => topic.boundTo[address],
    ...(a.defaultWallet !== undefined ? { defaultWallet: a.defaultWallet } : {}),
    ...(a.defaultPin !== undefined ? { defaultPin: a.defaultPin } : {}),
    ...(chain ? { chain } : {}),
    ...(topic.names ? { names: topic.names } : {}),
    ...(topic.groups ? { groups: topic.groups } : {}),
  }
}

/**
 * The agent's wallets in a sentence or two, ahead of each turn: what a trade naming no wallet pays from,
 * and what else it can name, since an agent once said a buy came from the embedded wallet while its
 * default, a TEE wallet, paid. Undefined before the wallets are read.
 */
export function walletsNote(topic: WalletsTopic, agent: string): string | undefined {
  const ctx = payerContextFrom(topic, agent)
  if (!ctx) return undefined
  const picked = resolvePayer(ctx)
  if (ctx.payable.readAt === undefined || (!picked.ok && picked.code === "WALLETS_UNKNOWN")) return undefined
  const all = payableWallets(ctx.payable, topic.names)
  // Named as the panes name it: the embedded wallet's own name, where the person gave it one.
  const own = (w: PayableWallet) => topic.names?.find((e) => e.address === w.address && e.marked === undefined)?.name
  const named = (w: PayableWallet) =>
    w.kind === "embedded"
      ? `the embedded wallet${own(w) ? ` (named ${terminalText(own(w)!, { maxLength: 64 })})` : ""}`
      : `${w.name}, a ${w.chain === "hood" ? "Hood " : ""}TEE wallet (${short(w.address)}) bound to your key alone${w.chain === "hood" ? ", for Hood tokens" : ""}`
  const paying = picked.ok ? all.find((w) => w.address === picked.address) : undefined
  const head = paying
    ? `A trade or swap that names no wallet pays from ${named(paying)}${ctx.defaultWallet !== undefined ? ", the user's default for you" : ""}.`
    : picked.ok
      ? ""
      : `A trade or swap that names no wallet is refused: ${picked.message}`
  const others = all.filter((w) => w !== paying).map(named)
  const also = others.length ? ` You can also pay from ${others.join(" and ")}, by passing wallet.` : ""
  // An agent once read candle_execution_status, saw only the embedded wallet "ready", and named it
  // on every trade, so its TEE default never paid.
  const tee = all.some((w) => w.kind === "tee")
    ? " candle_execution_status lists only the embedded wallet, but your TEE wallets pay all the same. Leave wallet out unless the user names one."
    : ""
  return `Your wallets (${agent}): ${head}${also}${tee}`.trim()
}

export class AgentWallets {
  private readonly reads = new Map<string, Read>()

  constructor(private readonly deps: WalletDeps) {}

  payable(agent: string): Payable {
    const status = this.deps.status.get(agent)
    const read = this.reads.get(agent) ?? { rows: [], readAt: undefined, unreadable: [] }
    return {
      ...(status?.embeddedWallet === "allowed" && status.wallets.solana ? { embedded: { address: status.wallets.solana, chain: "solana" as const } } : {}),
      tee: joinTee(read.rows, this.deps.portfolio(), this.deps.imported),
      readAt: read.readAt,
      unreadable: [...read.unreadable],
      ...(status?.tier ? { tier: status.tier } : {}),
    }
  }

  /** The wallet `word` names for this agent (a label, address, id or `embedded`), or the default's pick. */
  payer(agent: string, word?: string, opts: { chain?: "solana" | "hood" } = {}): PayerResult {
    const status = this.deps.status.get(agent)
    const defaultWallet = this.deps.defaultWallet(agent)
    const defaultPin = this.deps.pins?.get(agent, defaultWallet)
    const prefix = this.deps.keyPrefix(agent)
    const picked = resolvePayer(
      {
        agent,
        payable: this.payable(agent),
        embeddedWallet: status?.embeddedWallet,
        ...(status?.wallets.evm ? { evm: status.wallets.evm } : {}),
        ...(prefix ? { prefix } : {}),
        account: portfolioTee(this.deps.portfolio()),
        boundTo: (address) => this.boundTo(address),
        ...(defaultWallet !== undefined ? { defaultWallet } : {}),
        ...(defaultPin !== undefined ? { defaultPin } : {}),
        ...(opts.chain ? { chain: opts.chain } : {}),
        ...(this.deps.names ? { names: this.deps.names() } : {}),
        ...(this.deps.groups ? { groups: this.deps.groups() } : {}),
      },
      word,
    )
    // The default found by its line for the first time (or after an edit): kept by address from now on.
    const unnamed = word === undefined || word.trim() === ""
    // A Hood trade's embedded pick is the EVM twin of the Solana default, so only a TEE wallet is pinned from one.
    if (unnamed && picked.ok && defaultWallet !== undefined && defaultPin === undefined && (opts.chain !== "hood" || picked.kind === "tee")) this.deps.pins?.set(agent, defaultWallet, picked.address)
    return picked
  }

  /** Each agent's default found and kept by address now: before a rename, so the rename can't lose it. */
  pinDefaults(): void {
    for (const agent of this.deps.agents()) if (this.deps.defaultWallet(agent) !== undefined) this.payer(agent)
  }

  /** The `wallets` topic's data. */
  view(): WalletsTopic {
    const agents: Record<string, AgentWalletsView> = {}
    for (const agent of this.deps.agents()) {
      const status = this.deps.status.get(agent)
      const prefix = this.deps.keyPrefix(agent)
      const defaultWallet = this.deps.defaultWallet(agent)
      const defaultPin = this.deps.pins?.get(agent, defaultWallet)
      agents[agent] = {
        payable: this.payable(agent),
        ...(status ? { embeddedWallet: status.embeddedWallet } : {}),
        ...(status?.wallets.evm ? { evm: status.wallets.evm } : {}),
        ...(prefix ? { prefix } : {}),
        ...(defaultWallet !== undefined ? { defaultWallet } : {}),
        ...(defaultPin !== undefined ? { defaultPin } : {}),
      }
    }
    const boundTo: Record<string, string> = {}
    for (const [agent, read] of this.reads) for (const r of read.rows) boundTo[r.address] ??= agent
    return { agents, account: portfolioTee(this.deps.portfolio()), boundTo, ...(this.deps.names ? { names: this.deps.names() } : {}), ...(this.deps.groups ? { groups: this.deps.groups() } : {}) }
  }

  /** The agent whose key a TEE wallet is bound to, for the panes; undefined when it's no agent's. */
  boundTo(address: string): string | undefined {
    for (const [agent, read] of this.reads) if (read.rows.some((r) => r.address === address)) return agent
    return undefined
  }

  /** The TEE wallets the key with this prefix holds, when it's one of the agents' keys. */
  teeOnKey(prefix: string): TeeWallet[] {
    const agent = this.deps.agents().find((a) => this.deps.keyPrefix(a) === prefix)
    return agent ? this.payable(agent).tee : []
  }

  /** `readSince`: an agent whose status was read at or after this time is left as read, so one step doesn't read a key twice. */
  async refreshAll(opts: { readSince?: number } = {}): Promise<void> {
    for (const agent of this.deps.agents()) {
      const readAt = this.deps.status.get(agent)?.readAt
      if (opts.readSince !== undefined && readAt !== undefined && readAt >= opts.readSince) continue
      await this.refresh(agent)
    }
  }

  async refresh(agent: string): Promise<Payable> {
    await this.deps.status.refresh(agent).catch(() => undefined)
    const rows = await this.readRows(agent).catch(() => undefined)
    const last = this.reads.get(agent)
    if (rows) this.reads.set(agent, { rows, readAt: this.deps.now(), unreadable: [] })
    else this.reads.set(agent, { rows: last?.rows ?? [], readAt: last?.readAt, unreadable: ["tee wallets"] })
    // Found by its line once the wallets are read, so it's kept by address before anything renames it.
    if (this.deps.defaultWallet(agent) !== undefined) this.payer(agent)
    this.deps.onChange?.()
    return this.payable(agent)
  }

  private async readRows(agent: string): Promise<ProfileRow[] | undefined> {
    const prefix = this.deps.keyPrefix(agent)
    if (!prefix) return undefined
    const outcome = await this.deps.pool.for(agent).call("candle_get_profile_wallets", { keyPrefix: prefix })
    if (outcome.kind !== "ok") return undefined
    const parsed = parseProfileWallets(outcome.result)
    if (!parsed) return undefined
    if (parsed.scope === "selected" || parsed.rows.length > 0) return withTrading(parsed.rows, await this.readTrading(agent))
    // walletScope "all" with an empty list: ask the CLI about each of the account's Solana TEE wallets.
    if (!this.deps.teeStatus) return undefined
    if (this.deps.portfolio() === undefined) await this.deps.readPortfolio?.()
    const portfolio = this.deps.portfolio()
    if (portfolio === undefined) return undefined
    const bound: ProfileRow[] = []
    for (const w of portfolioTee(portfolio).filter((t) => t.chain === "solana")) {
      const answer = await this.deps.teeStatus(agent, w.address)
      if (answer === "unreadable") return undefined
      if (answer === "bound") bound.push({ id: w.id, address: w.address, ...(w.label ? { label: w.label } : {}), chain: w.chain, spendCapable: true })
    }
    return bound
  }

  /**
   * The key's wallets as its trades see them, where the agent's MCP server lists `candle_get_trading_wallets` (CLI
   * 0.13.19 on); undefined where it doesn't, or the read fails, and the profile read stands alone.
   */
  private async readTrading(agent: string): Promise<{ rows: TradingRow[]; complete: boolean } | undefined> {
    const client = this.deps.pool.for(agent)
    const listed = client.tools?.()
    if (listed && listed.length > 0 && !listed.some((t) => t.name === "candle_get_trading_wallets")) return undefined
    // Every page, by its cursor: a page that fails or a cursor past the last allowed leaves the read cut short.
    const rows: TradingRow[] = []
    let cursor: string | undefined
    for (let page = 0; page < TRADING_PAGES_MAX; page++) {
      const outcome = await client.call("candle_get_trading_wallets", cursor === undefined ? {} : { cursor }).catch(() => undefined)
      const read = outcome?.kind === "ok" ? parseTradingWallets(outcome.result) : undefined
      if (!read) return page === 0 ? undefined : { rows, complete: false }
      rows.push(...read.rows)
      if (read.complete) return { rows, complete: true }
      if (read.cursor === undefined) return { rows, complete: false }
      cursor = read.cursor
    }
    return { rows, complete: false }
  }
}
