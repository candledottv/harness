// Where the account stands, from the last portfolio read the core already holds: no network call.
// The kill report and the status bar both read it.
import { addressKey, type ChainSlug, chainOf, tokenPriceKey } from "../shared/chains"
import { embeddedName } from "./autonomy"
import { shownWallets } from "./portfolio-wallets"

export interface WalletStanding {
  wallet: string
  /** Which kind of wallet, so the report names it as the panes do: "embedded", or a TEE wallet's label. */
  kind?: "embedded" | "tee"
  label?: string
  /** What it's called, as the panes call it; the embedded wallet on another chain than Solana says which ("embedded on Hood"). */
  name?: string
  /** The wallet's chain, and its native asset's symbol (SOL, ETH), which `solUsd` is the value of. A report kept from before had neither, and was Solana's. */
  chain?: ChainSlug
  nativeSymbol?: string
  /** The agents allowed on this wallet, from their status reads. */
  agents: string[]
  /** The wallet's native balance (SOL, ETH: `nativeSymbol`) in dollars. */
  solUsd: number | null
  /** The priced token holdings' value; null when the wallet's token read failed. */
  tokensUsd: number | null
  unpriced: number
}

/** Each wallet in a portfolio read, on every chain (`embedded`, then `tee`), valued at the price book's prices. */
export function walletStanding(
  portfolio: unknown,
  prices: { usd(key: string | undefined): number | undefined },
  agents: string[],
  /** Every wallet the agent may pay from: the embedded ones (Solana's, the EVM one) and its TEE wallets (without them, those showed no agent). */
  walletsOf: (agent: string) => readonly (string | undefined)[],
  /** What a wallet is called, from the core's one book. */
  nameOf?: (address: string, kind: "embedded" | "tee", label?: string) => string,
  /** The chains the account uses, the core's one answer: a known chain's wallet that couldn't be read is listed, unread. */
  chains?: readonly ChainSlug[],
): WalletStanding[] {
  const byWallet = new Map<string, string[]>()
  for (const agent of agents) {
    for (const wallet of walletsOf(agent)) if (wallet) byWallet.set(addressKey(wallet), [...(byWallet.get(addressKey(wallet)) ?? []), agent])
  }
  const out: WalletStanding[] = []
  for (const w of shownWallets(portfolio, chains)) {
    const chain = chainOf(w.chain)
    const nativePrice = prices.usd(chain.native.priceKey)
    const native = w.nativeRaw === null ? undefined : Number(w.nativeRaw) / 10 ** chain.native.decimals
    let tokensUsd: number | null = w.tokens === null ? null : 0
    let unpriced = 0
    for (const token of w.tokens ?? []) {
      const price = prices.usd(tokenPriceKey(w.chain, token.mint))
      if (price === undefined) {
        unpriced += 1
        continue
      }
      tokensUsd = (tokensUsd ?? 0) + (Number(token.amountRaw) / 10 ** token.decimals) * price
    }
    // With no chain headings in the report, the embedded EVM wallet is named on its chain unless the person named it.
    const named = nameOf?.(w.address, w.kind, w.label)
    const name = w.kind === "embedded" && w.chain !== "solana" && (named ?? "embedded") === "embedded" ? embeddedName(w.chain) : named
    out.push({
      wallet: w.address,
      kind: w.kind,
      ...(w.label !== undefined ? { label: w.label } : {}),
      ...(name !== undefined ? { name } : {}),
      chain: w.chain,
      nativeSymbol: chain.native.symbol,
      agents: byWallet.get(addressKey(w.address)) ?? [],
      solUsd: native !== undefined && nativePrice !== undefined ? native * nativePrice : null,
      tokensUsd,
      unpriced,
    })
  }
  return out
}

/** Open exposure for the status bar: the priced token holdings across wallets, SOL left out. */
export function exposureUsd(wallets: readonly WalletStanding[]): number | null {
  if (wallets.length === 0 || wallets.some((w) => w.tokensUsd === null)) return null
  return wallets.reduce((sum, w) => sum + (w.tokensUsd ?? 0), 0)
}
