// Where the account stands, from the last portfolio read the core already holds: no network call.
// The kill report and the status bar both read it.
const SOL_MINT = "So11111111111111111111111111111111111111112"

export interface WalletStanding {
  wallet: string
  /** Which kind of wallet, so the report names it as the panes do: "embedded", or a TEE wallet's label. */
  kind?: "embedded" | "tee"
  label?: string
  /** What it's called, as the panes call it. */
  name?: string
  /** The agents allowed on this wallet, from their status reads. */
  agents: string[]
  solUsd: number | null
  /** The priced token holdings' value; null when the wallet's token read failed. */
  tokensUsd: number | null
  unpriced: number
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Each wallet in a portfolio read (`embedded`, then `tee`), valued at the price book's prices. */
export function walletStanding(
  portfolio: unknown,
  prices: { usd(key: string | undefined): number | undefined },
  agents: string[],
  /** Every wallet the agent may pay from: the embedded one, and its TEE wallets (without them, those showed no agent). */
  walletsOf: (agent: string) => readonly (string | undefined)[],
  /** What a wallet is called, from the core's one book. */
  nameOf?: (address: string, kind: "embedded" | "tee", label?: string) => string,
): WalletStanding[] {
  const byWallet = new Map<string, string[]>()
  for (const agent of agents) {
    for (const wallet of walletsOf(agent)) if (wallet) byWallet.set(wallet, [...(byWallet.get(wallet) ?? []), agent])
  }
  const body = portfolio as { embedded?: unknown; tee?: unknown } | undefined
  const out: WalletStanding[] = []
  const tagged = [...asArray(body?.embedded).map((e) => ["embedded", e] as const), ...asArray(body?.tee).map((e) => ["tee", e] as const)]
  for (const [kind, entry] of tagged) {
    const w = entry as { address?: unknown; label?: unknown; lamports?: unknown; tokens?: unknown }
    if (typeof w.address !== "string") continue
    const solPrice = prices.usd(SOL_MINT)
    const sol = typeof w.lamports === "string" && /^\d+$/.test(w.lamports) ? Number(w.lamports) / 1e9 : undefined
    let tokensUsd: number | null = Array.isArray(w.tokens) ? 0 : null
    let unpriced = 0
    for (const t of asArray(w.tokens)) {
      const token = t as { mint?: unknown; amountRaw?: unknown; decimals?: unknown }
      const price = typeof token.mint === "string" ? prices.usd(token.mint) : undefined
      if (price === undefined || typeof token.amountRaw !== "string" || typeof token.decimals !== "number") {
        unpriced += 1
        continue
      }
      tokensUsd = (tokensUsd ?? 0) + (Number(token.amountRaw) / 10 ** token.decimals) * price
    }
    out.push({
      wallet: w.address,
      kind,
      ...(typeof w.label === "string" ? { label: w.label } : {}),
      ...(nameOf ? { name: nameOf(w.address, kind, typeof w.label === "string" ? w.label : undefined) } : {}),
      agents: byWallet.get(w.address) ?? [],
      solUsd: sol !== undefined && solPrice !== undefined ? sol * solPrice : null,
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
