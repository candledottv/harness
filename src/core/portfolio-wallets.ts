// Every wallet in a candle_get_portfolio answer, on every chain that's on, read in one place. Candle lists
// Solana's wallets at the top (`embedded`, `tee`) and each EVM chain's under its own slug (`hood.embedded`,
// `hood.tee`), each wallet with its native balance (`lamports` on Solana, `wei` on an EVM chain) and its tokens.
// Every reader of the portfolio's wallets goes through here, so a Hood holding is never read and dropped.
import { addressKey, type ChainEntry, type ChainSlug, chainFromCandle, enabledChains, familyOfAddress, sameAddress, storedChain } from "../shared/chains"
import type { Holding } from "./cards"

export type PortfolioWalletKind = "embedded" | "tee"

export interface PortfolioToken {
  mint: string
  amountRaw: string
  decimals: number
  symbol?: string
}

export interface PortfolioWallet {
  chain: ChainSlug
  kind: PortfolioWalletKind
  address: string
  /** Candle's label, as it answered it (the caller makes it safe to show). */
  label?: string
  /** A TEE wallet's id and active flag, as Candle reports them. */
  id?: string
  active?: boolean
  /** The native balance in its smallest unit (lamports, wei); null when Candle couldn't read it. */
  nativeRaw: bigint | null
  /** Null when Candle couldn't read the wallet's tokens. Malformed rows are left out, their mints kept in `unreadMints`. */
  tokens: PortfolioToken[] | null
  /** Tokens Candle listed without a readable amount or decimals: held in some amount not known, never none. */
  unreadMints?: string[]
  /** Candle cut the token list short: a token missing from it may still be held. */
  truncated: boolean
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Where a chain's wallets sit in the answer: Solana's at the top, every other chain's under its slug. */
function section(body: Record<string, unknown> | undefined, chain: ChainEntry): Record<string, unknown> | undefined {
  return chain.slug === "solana" ? body : record(body?.[chain.slug])
}

/** The field a chain's native balance is in. */
const nativeField = (chain: ChainEntry) => (chain.family === "solana" ? "lamports" : "wei")

/** Whether the answer carries a chain's wallets at all: one that's missing (or unreadable) says nothing about what they hold. */
export function chainRead(portfolio: unknown, chain: ChainEntry): boolean {
  const s = section(record(portfolio), chain)
  return Array.isArray(s?.embedded)
}

/** Whether Candle said it failed to read some of a chain's wallets (`hood.unavailable`). */
function chainPartial(portfolio: unknown, chain: ChainEntry): boolean {
  return chain.slug !== "solana" && asArray(section(record(portfolio), chain)?.unavailable).length > 0
}

function tokenOf(entry: unknown): PortfolioToken | undefined {
  const t = record(entry)
  if (typeof t?.mint !== "string" || typeof t.amountRaw !== "string" || !/^\d+$/.test(t.amountRaw) || typeof t.decimals !== "number" || !Number.isInteger(t.decimals) || t.decimals < 0) return undefined
  return { mint: t.mint, amountRaw: t.amountRaw, decimals: t.decimals, ...(typeof t.symbol === "string" ? { symbol: t.symbol } : {}) }
}

/** The mints of the token rows that didn't read, where a row names one. */
function unreadOf(tokens: unknown): { unreadMints?: string[] } {
  if (!Array.isArray(tokens)) return {}
  const unread = tokens.filter((t) => tokenOf(t) === undefined).map((t) => record(t)?.mint).filter((m): m is string => typeof m === "string")
  return unread.length ? { unreadMints: unread } : {}
}

/** Every wallet the answer lists, Solana's first, each chain's embedded wallet before its TEE wallets. */
export function portfolioWallets(portfolio: unknown): PortfolioWallet[] {
  const body = record(portfolio)
  const out: PortfolioWallet[] = []
  for (const chain of enabledChains()) {
    const s = section(body, chain)
    for (const kind of ["embedded", "tee"] as const) {
      for (const entry of asArray(s?.[kind])) {
        const w = record(entry)
        if (typeof w?.address !== "string") continue
        // A row's own chain marker wins where it names a chain that's on; else the section it sits in.
        const own = w.chain === undefined ? undefined : chainFromCandle(w.chain, w)
        const native = w[nativeField(chain)]
        out.push({
          chain: own ?? chain.slug,
          kind,
          address: w.address,
          ...(typeof w.label === "string" ? { label: w.label } : {}),
          ...(typeof w.id === "string" ? { id: w.id } : {}),
          ...(kind === "tee" && typeof w.active === "boolean" ? { active: w.active } : {}),
          nativeRaw: typeof native === "string" && /^\d+$/.test(native) ? BigInt(native) : null,
          tokens: Array.isArray(w.tokens) ? w.tokens.map(tokenOf).filter((t): t is PortfolioToken => t !== undefined) : null,
          ...unreadOf(w.tokens),
          truncated: w.truncated === true,
        })
      }
    }
  }
  return out
}


/**
 * What `wallet` holds of `mint`, on any chain, matched by address key (an EVM address in any case). "none" only
 * when the read truly says none: the wallet's tokens were read whole and the token isn't among them, or the
 * wallet's chain was read whole and doesn't list the wallet. A failed or cut-short read is "unreadable", and so
 * is a row for the token that came without its amount or decimals.
 */
export function holdingFrom(result: unknown, wallet: string, mint: string): Holding {
  const body = record(result)
  if (!Array.isArray(body?.embedded)) return "unreadable"
  const entry = portfolioWallets(result).find((w) => sameAddress(w.address, wallet))
  if (!entry) {
    const chains = enabledChains().filter((c) => c.family === familyOfAddress(wallet))
    // A wallet on a chain whose section is missing or partly failed may hold it: never "none" from that.
    return chains.some((c) => !chainRead(result, c) || chainPartial(result, c)) ? "unreadable" : "none"
  }
  if (entry.tokens === null) return "unreadable" // a failed read is null, never zero
  const token = entry.tokens.find((t) => sameAddress(t.mint, mint))
  if (!token) return entry.truncated || entry.unreadMints?.some((m) => sameAddress(m, mint)) ? "unreadable" : "none"
  return { amountRaw: BigInt(token.amountRaw), decimals: token.decimals }
}

/** A token's decimals in a portfolio read, from any wallet that holds it. */
export function decimalsIn(result: unknown, mint: string): number | undefined {
  for (const w of portfolioWallets(result)) {
    const t = w.tokens?.find((x) => sameAddress(x.mint, mint))
    if (t) return t.decimals
  }
  return undefined
}

/** Every token the portfolio's wallets hold, once each whatever its case. */
export function heldMints(portfolio: unknown): string[] {
  const seen = new Map<string, string>()
  for (const w of portfolioWallets(portfolio)) for (const t of w.tokens ?? []) if (!seen.has(addressKey(t.mint))) seen.set(addressKey(t.mint), t.mint)
  return [...seen.values()]
}


/**
 * What a read says of the account's use of a chain. Solana: always used. Another chain: used once it has a TEE wallet
 * there, or a wallet there holds something (a token Candle listed unreadably included); unused when every wallet there was read whole and holds nothing; unknown
 * when one couldn't be read and nothing read says it's used, or the read lists none there. Every account has an
 * embedded EVM wallet, so an empty one, or one that couldn't be read, leaves a Solana-only account's screens as they were.
 */
export function chainUse(wallets: readonly PortfolioWallet[], chain: ChainSlug): "used" | "unused" | "unknown" {
  if (chain === "solana") return "used"
  const there = wallets.filter((w) => w.chain === chain)
  // A token Candle listed without its amount or decimals is still a token there (held in an amount not known).
  if (there.some((w) => w.kind === "tee" || (w.nativeRaw !== null && w.nativeRaw !== 0n) || (w.tokens?.length ?? 0) > 0 || (w.unreadMints?.length ?? 0) > 0)) return "used"
  return there.length === 0 || there.some((w) => w.nativeRaw === null || w.tokens === null) ? "unknown" : "unused"
}

/** Whether a read alone shows the account using a chain. */
export function chainInUse(wallets: readonly PortfolioWallet[], chain: ChainSlug): boolean {
  return chainUse(wallets, chain) === "used"
}

/**
 * The chains the account uses, in the registry's order: what the read says; a stopped TEE wallet's chain (Candle drops
 * it from its reads, and it may still hold funds); and where the read can't say, what `was` said before, so a chain the
 * account is known to use stays on screen saying its wallet couldn't be read. The one answer the core's lists, its
 * approvals menu and every view go by.
 */
export function chainsInUse(portfolio: unknown, opts: { stopped?: readonly { address: string }[]; was?: readonly ChainSlug[] } = {}): ChainSlug[] {
  const all = portfolioWallets(portfolio)
  const stoppedOn = new Set((opts.stopped ?? []).map((w) => storedChain(undefined, w.address)))
  return enabledChains()
    .map((c) => c.slug)
    .filter((slug) => {
      const use = chainUse(all, slug)
      return use === "used" || stoppedOn.has(slug) || (use === "unknown" && (opts.was ?? []).includes(slug))
    })
}

/** The wallets the screens show: every wallet on a chain the account uses (`chains`, else what the read alone says). */
export function shownWallets(portfolio: unknown, chains?: readonly ChainSlug[]): PortfolioWallet[] {
  const all = portfolioWallets(portfolio)
  return all.filter((w) => (chains ? chains.includes(w.chain) : chainInUse(all, w.chain)))
}
