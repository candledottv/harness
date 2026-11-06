// Which wallets each agent's key may pay from, kept so proposing a card needs no
// network call for it. Three reads, joined:
//   embedded  candle_execution_status, as AgentStatusBook reads it: there only when the owner has
//             allowed this key on the account's embedded wallet;
//   TEE       candle_get_profile_wallets { keyPrefix } on the agent's own MCP child (as recorded: the TEE
//             wallet bound to the key, under walletScope "selected", spendCapable, and none for any
//             other key), joined by linkedWalletId to
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

/** How often the reads are repeated while a view is attached. */
export const WALLETS_REFRESH_MS = 5 * 60_000

export interface TeeWallet {
  id: string
  address: string
  label?: string
  /** "solana", or Hood's: a Hood TEE wallet is listed, and trading from one comes later. */
  chain: string
  /** Candle's active flag from the portfolio, and the profile read's spendCapable: both, to pay from it. */
  active: boolean
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
  pool: { for(agent: string): { call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> } }
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
    rows.push({ id: w.linkedWalletId, address: w.address, ...(l ? { label: l } : {}), chain: typeof w.chain === "string" ? w.chain : "solana", spendCapable: w.spendCapable === true })
  }
  return { scope: body.walletScope, rows }
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
      out.push({ id: w.id, address: w.address, ...(l ? { label: l } : {}), chain: typeof w.chain === "string" ? w.chain : chain, active: w.active !== false })
    }
  }
  return out
}

/**
 * The key's rows, joined to the portfolio. A row that isn't spendCapable stays listed, as not active:
 * what spendCapable says for a stopped wallet was never recorded, and dropping it would have the
 * wallet named as another key's. Once the portfolio is read, a row it doesn't list as a TEE wallet (an
 * imported linked wallet, which the Candle Harness doesn't pay from) is left out.
 */
export function joinTee(rows: readonly ProfileRow[], portfolio: unknown): TeeWallet[] {
  const account = portfolio === undefined ? undefined : new Map(portfolioTee(portfolio).map((w) => [w.id, w]))
  const out: TeeWallet[] = []
  for (const row of rows) {
    const known = account?.get(row.id)
    if (account && !known) continue
    const l = known?.label ?? row.label
    out.push({ id: row.id, address: row.address, ...(l ? { label: l } : {}), chain: known?.chain ?? row.chain, active: (known?.active ?? true) && row.spendCapable })
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
}

/** What the agent can pay from now: the embedded wallet when its key is allowed it, then its active Solana TEE wallets (none on Free). */
export function payableWallets(payable: Payable, names?: readonly WalletNameEntry[]): PayableWallet[] {
  const tee = payable.tier === "free" ? [] : payable.tee.filter((t) => t.chain === "solana" && t.active)
  return [
    ...(payable.embedded ? [{ name: "embedded", word: "embedded", kind: "embedded" as const, address: payable.embedded.address }] : []),
    ...tee.map((t) => ({ name: walletName(names, { ...t, kind: "tee" as const }), word: t.address, kind: "tee" as const, address: t.address })),
  ]
}

/** The wallet a trade pays from, or why not (pure: the core, the doctor and the view's input line all use it). */
export function resolvePayer(ctx: PayerContext, word?: string): PayerResult {
  const { agent, payable } = ctx
  const free = payable.tier === "free"
  const payableTee = free ? [] : payable.tee.filter((t) => t.chain === "solana" && t.active)
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
  const embedded = (): PayerResult | Fail => {
    if (ctx.embeddedWallet === "denied") {
      return {
        code: "EMBEDDED_WALLET_NOT_PERMITTED",
        sentence: `${agent}'s key isn't allowed to trade from the account's embedded wallet. The owner allows it in their own terminal: ${allow}.`,
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
    if (t.chain !== "solana") return { code: "HOOD_TEE_LATER", sentence: `${name} is a Hood TEE wallet: trades from Hood TEE wallets come in a later release.`, clause: "it's a Hood TEE wallet, and trades from those come in a later release" }
    if (!t.active) return { code: "TEE_WALLET_INACTIVE", sentence: `${name} is stopped on Candle's side (inactive), so nothing can trade from it.`, clause: "it's stopped on Candle's side (inactive)" }
    // `label` is what the wallet is called (its name in the book, Candle's label or the Candle Harness's stand-in): what the card says.
    const called = names.find((e) => e.address === t.address)?.name ?? t.label
    return { ok: true, kind: "tee", address: t.address, id: t.id, ...(called ? { label: terminalText(called, { maxLength: 64 }) } : {}), chain: t.chain }
  }
  const named = (raw: string): PayerResult | Fail => {
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
    if ((payable.embedded && address === payable.embedded.address) || (ctx.evm && address.toLowerCase() === ctx.evm.toLowerCase())) return embedded()
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
    const picked = named(ctx.defaultPin ?? ctx.defaultWallet)
    if ("ok" in picked) return picked
    const setting = `agents.${agent}.wallet = "${terminalText(ctx.defaultWallet, { maxLength: 64 })}"`
    return {
      ok: false,
      code: "DEFAULT_WALLET_NOT_PAYABLE",
      message: `${agent}'s default wallet (${setting}) can't pay: ${picked.clause}.${list} Change it in config.toml, or name a wallet.`,
      canPayFrom,
    }
  }
  if (ctx.chain === "hood" || (ctx.embeddedWallet !== "denied" && payable.embedded)) return done(embedded())
  if (payableTee.length === 1) return done(tee(payableTee[0]!))
  if (payableTee.length > 1) {
    return no({ code: "WALLET_NOT_NAMED", sentence: `${agent} can pay from more than one TEE wallet and has no default: name one, or set agents.${agent}.wallet in config.toml.`, clause: "" })
  }
  // Nothing payable: say why from the wallets it does have.
  if (free && payable.tee.length > 0) return done(tee(payable.tee[0]!))
  if (ctx.embeddedWallet === "denied" && payable.tee.length === 0) return done(embedded())
  return no({ code: "NO_PAYABLE_WALLET", sentence: `${agent} has no wallet it can pay from.`, clause: "" })
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
    w.kind === "embedded" ? `the embedded wallet${own(w) ? ` (named ${terminalText(own(w)!, { maxLength: 64 })})` : ""}` : `${w.name}, a TEE wallet (${short(w.address)}) bound to your key alone`
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
      tee: joinTee(read.rows, this.deps.portfolio()),
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
    if (unnamed && picked.ok && defaultWallet !== undefined && defaultPin === undefined && opts.chain !== "hood") this.deps.pins?.set(agent, defaultWallet, picked.address)
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

  async refreshAll(): Promise<void> {
    for (const agent of this.deps.agents()) await this.refresh(agent)
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
    if (parsed.scope === "selected" || parsed.rows.length > 0) return parsed.rows
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
}
