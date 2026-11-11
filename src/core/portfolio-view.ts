// The positions and wallets panes' data, from the last portfolio read the core
// holds: each wallet once (the embedded wallet is shared by every agent the owner allowed on it,
// docs.candle.tv/developers/agent-wallets), its SOL and token holdings valued at the price book's prices, and for
// each holding the agents whose buys of it filled. A value that can't be read or priced is null,
// never zero. Sent on the `portfolio` topic after every read.
import { type ChainSlug, chainOf, maybeChain, sameAddress, storedChain, tokenPriceKey } from "../shared/chains"
import { terminalText } from "../shared/terminal-text"
import type { ChainBalance } from "./chain-balance"
import { chainsInUse, type PortfolioToken, shownWallets } from "./portfolio-wallets"
import type { PaperPosition } from "./trade-log"
import { entryFor, type WalletNameEntry, walletName } from "./wallet-names"

export interface TokenRow {
  mint: string
  symbol?: string
  amount: number
  usd: number | null
  buyers: string[]
}

export interface WalletView {
  address: string
  chain: ChainSlug
  kind: "embedded" | "tee"
  /** Its kept name: Candle's label, or the Candle Harness's own from wallets.toml. */
  label?: string
  /** What it's called on screen: its name, else "embedded", else its short address. The core always sets it. */
  name?: string
  /** A name that breaks the Candle Harness's rules: why. It's shown, marked, and taken by address only. */
  marked?: string
  /** The agents allowed to spend from it: for a TEE wallet, the one whose key it's bound to. */
  agents: string[]
  /** A TEE wallet's active flag, as Candle reports it. */
  active?: boolean
  /**
   * Stopped for good by this Candle Harness (Candle never turns one back on), and dropped from Candle's lists: its balance can't be read,
   * and what's left is to sweep it home.
   */
  stopped?: true
  /** Stopped, by what Candle's lists say: it stopped listing a wallet the Candle Harness didn't stop. */
  stoppedOutside?: true
  /** A stopped wallet's token accounts that still hold something, read on chain. */
  heldTokens?: number
  /** Why a stopped wallet's balance (or, with its SOL shown, its token accounts) couldn't be read on chain. */
  balanceError?: string
  /** The chain's native asset (SOL, ETH), which the balance is in. */
  nativeSymbol: string
  /** The native balance and its dollars; null when it couldn't be read. */
  native: { amount: number; usd: number | null } | null
  /** An EVM TEE wallet holding tokens and none of its chain's native asset: every trade there needs some for gas. */
  needsNative?: true
  /** Null when Candle couldn't read the wallet's tokens. */
  tokens: TokenRow[] | null
}

/** What a wallet in the view is called: the core's name for it. */
export const viewName = (w: Pick<WalletView, "address" | "kind" | "label" | "name">): string => w.name ?? walletName(undefined, w)

/**
 * A wallet's line head in the Wallets and Positions panes: its name, then what kind it is where the name
 * doesn't say ("hot · TEE", "main · embedded", or plain "embedded").
 */
export const viewTitle = (w: Pick<WalletView, "address" | "kind" | "label" | "name">): string => {
  const name = viewName(w)
  return w.kind === "tee" ? `${name} · TEE` : name === "embedded" ? name : `${name} · embedded`
}

export interface PortfolioView {
  /** When the portfolio was read; null before the first read. */
  readAt: number | null
  wallets: WalletView[]
  /**
   * The chains the account uses, in the registry's order: the core's one answer (portfolio-wallets.ts chainsInUse),
   * which the chain chip, the panes and Candle's lists all go by. Absent from an older core.
   */
  chains?: ChainSlug[]
  /** Agents whose key isn't allowed the embedded wallet: they read and paper-trade only. */
  readOnly: { agent: string; command: string }[]
  /** Each agent's paper book, from this Candle Harness's own paper trades. */
  paper: Record<string, PaperPosition[]>
  /** Where to deposit: the embedded Solana wallet, from the agents' status reads. */
  deposit?: string
  /** Set on Free, where a TEE wallet can't be traded from. */
  teeNote?: string
  /** Why the last read failed, in Candle's words, until one answers. */
  failed?: string
}

export interface AgentWallet {
  name: string
  /** The account's embedded Solana wallet, from the agent's status read. */
  wallet?: string
  /** The account's embedded EVM wallet, from the same read. */
  evmWallet?: string
  embeddedWallet?: "allowed" | "denied"
  prefix?: string
}

/**
 * A token's symbol from the portfolio's own `prices` map (`{ [mint]: { priceUsd, symbol, name } }`,
 * as recorded from Candle's real server), for a token row that carries none.
 */
export function portfolioSymbol(portfolio: unknown, mint: string): string | undefined {
  const symbol = record(record(record(portfolio)?.prices)?.[mint])?.symbol
  return typeof symbol === "string" && symbol.trim() !== "" ? terminalText(symbol, { maxLength: 16 }) : undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export function portfolioView(input: {
  portfolio: unknown
  readAt: number | null
  prices: { usd(key: string | undefined): number | undefined }
  agents: readonly AgentWallet[]
  buyers: (mint: string) => string[]
  paper: Record<string, PaperPosition[]>
  /** A token's symbol when its row gives none: the market read, the portfolio's prices, a base asset. */
  symbolOf?: (mint: string) => string | undefined
  /** The agent a TEE wallet is bound to (AgentWallets.boundTo); the portfolio itself doesn't say. */
  boundTo?: (address: string) => string | undefined
  /** The account's plan, from the agents' status reads. */
  tier?: string
  /** TEE wallets this Candle Harness stopped and hasn't swept (stopped-wallets.ts). */
  stopped?: readonly { address: string; label?: string; agent?: string; outside?: true }[]
  /** Each stopped wallet's balance, read on chain (chain-balance.ts). */
  stoppedBalance?: (address: string) => ChainBalance | undefined
  /** Why the last read failed, if it did. */
  failed?: string
  /** Every wallet the Candle Harness knows and its name; without it, Candle's labels. */
  names?: readonly WalletNameEntry[]
  /** The chains the account uses, as the core knows them; without it, what this read and the stopped wallets say. */
  chains?: readonly ChainSlug[]
}): PortfolioView {
  /** A wallet's kept name, what it's called, and any mark, from the one book. */
  const naming = (address: string, kind: "embedded" | "tee", kept?: string) => {
    const e = input.names ? entryFor(input.names, address) : undefined
    const label = e ? e.name : kept
    return { ...(label ? { label } : {}), name: walletName(input.names, { address, kind, ...(kept ? { label: kept } : {}) }), ...(e?.marked ? { marked: e.marked } : {}) }
  }
  const allowed = input.agents.filter((a) => a.embeddedWallet !== "denied")
  const wallets: WalletView[] = []
  const chains = [...(input.chains ?? chainsInUse(input.portfolio, { stopped: input.stopped ?? [] }))]
  for (const w of shownWallets(input.portfolio, chains)) {
    const chain = chainOf(w.chain)
    const amount = w.nativeRaw === null ? undefined : Number(w.nativeRaw) / 10 ** chain.native.decimals
    const price = input.prices.usd(chain.native.priceKey)
    const bound = w.kind === "tee" ? input.boundTo?.(w.address) : undefined
    const tokens = w.tokens === null ? null : w.tokens.map((t) => tokenRow(t, w.chain, input))
    wallets.push({
      address: w.address,
      chain: w.chain,
      kind: w.kind,
      ...naming(w.address, w.kind, w.label !== undefined ? terminalText(w.label, { maxLength: 64 }) : undefined),
      agents: w.kind === "tee" ? (bound ? [bound] : []) : allowed.filter((a) => sameAddress(chain.family === "solana" ? a.wallet : a.evmWallet, w.address)).map((a) => a.name),
      ...(w.active !== undefined ? { active: w.active } : {}),
      nativeSymbol: chain.native.symbol,
      native: amount === undefined ? null : { amount, usd: price === undefined ? null : amount * price },
      ...(w.kind === "tee" && chain.family === "evm" && w.nativeRaw === 0n && (tokens?.length ?? 0) > 0 ? { needsNative: true as const } : {}),
      tokens,
    })
  }
  // Candle drops a stopped TEE wallet from its reads, so one still listed is shown as Candle says it is.
  for (const w of input.stopped ?? []) {
    if (wallets.some((v) => sameAddress(v.address, w.address))) continue
    const read = input.stoppedBalance?.(w.address)
    // A stopped wallet is kept from before rows carried a chain: its address's family says which.
    const chain = maybeChain(storedChain(undefined, w.address)) ?? chainOf("solana")
    const price = input.prices.usd(chain.native.priceKey)
    const held = read && "lamports" in read ? Number(read.lamports) / 10 ** chain.native.decimals : undefined
    const onChain = held !== undefined && read && "lamports" in read ? { native: { amount: held, usd: price === undefined ? null : held * price }, ...(read.tokens !== null ? { heldTokens: read.tokens } : { balanceError: terminalText(read.tokensError ?? "the token accounts weren't read", { maxLength: 240 }) }) } : { native: null }
    wallets.push({
      address: w.address,
      chain: chain.slug,
      nativeSymbol: chain.native.symbol,
      kind: "tee",
      ...naming(w.address, "tee", w.label),
      agents: w.agent ? [w.agent] : [],
      active: false,
      stopped: true,
      ...(w.outside ? { stoppedOutside: true as const } : {}),
      ...onChain,
      ...(read && "error" in read ? { balanceError: terminalText(read.error, { maxLength: 240 }) } : {}),
      tokens: null,
    })
  }
  const deposit = input.agents.find((a) => a.wallet)?.wallet
  return {
    readAt: input.readAt,
    wallets,
    chains,
    readOnly: input.agents
      .filter((a) => a.embeddedWallet === "denied")
      .map((a) => ({ agent: a.name, command: `candle keys update ${a.prefix ?? "<prefix>"} --embedded-wallet allow` })),
    paper: input.paper,
    ...(deposit ? { deposit } : {}),
    ...(input.tier === "free" ? { teeNote: "TEE wallets are a Pro or Max feature" } : {}),
    ...(input.failed ? { failed: input.failed } : {}),
  }
}

function tokenRow(t: PortfolioToken, chain: ChainSlug, input: { prices: { usd(key: string | undefined): number | undefined }; buyers: (mint: string) => string[]; symbolOf?: (mint: string) => string | undefined }): TokenRow {
  const amount = Number(t.amountRaw) / 10 ** t.decimals
  const price = input.prices.usd(tokenPriceKey(chain, t.mint))
  return {
    mint: t.mint,
    // Otherwise Positions shows oreo…ybcp where the card, the token pane and activity say ORE.
    ...(t.symbol !== undefined ? { symbol: terminalText(t.symbol, { maxLength: 16 }) } : input.symbolOf?.(t.mint) ? { symbol: input.symbolOf(t.mint)! } : {}),
    amount,
    usd: price === undefined ? null : amount * price,
    buyers: input.buyers(t.mint),
  }
}
