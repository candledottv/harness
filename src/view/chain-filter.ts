// The chain filter, as a view uses it: which chains the account uses (the core's one answer, sent with the portfolio,
// and only the wallets on those), the status bar chip's words, its menu, and whether a row on a chain shows. The choice itself is the
// core's (view-state.ts), one for every pane of every view. Its chip shows only while the account uses more than one
// chain, and only then does a choice hide anything: a Solana-only account's screens are as they were.
import type { PortfolioView } from "../core/portfolio-view"
import { addressKey, type ChainSlug, chainName, enabledChains, maybeChain, storedChain } from "../shared/chains"
import type { CoreView } from "./store"

/** The chains the account uses, in the registry's order: the core's answer; from an older core, the chains its wallets are on. */
export function chainsInUse(portfolio: Pick<PortfolioView, "wallets" | "chains"> | undefined): ChainSlug[] {
  const used = new Set<string>(portfolio?.chains ?? (portfolio?.wallets ?? []).map((w) => w.chain))
  return enabledChains()
    .map((c) => c.slug)
    .filter((slug) => used.has(slug))
}

/** The chip's words: "all chains", or the chain's name. */
export const chainChipLabel = (chain: ChainSlug | null): string => (chain ? chainName(chain) : "all chains")

/** The chip's menu: all chains, then each chain in use; the one on is ticked. */
export function chainMenuRows(chain: ChainSlug | null, chains: readonly ChainSlug[]): { value: ChainSlug | null; label: string; words: string; on: boolean }[] {
  return [
    { value: null, label: "all chains", words: chains.length === 2 ? "every pane shows both" : "every pane shows every chain", on: chain === null },
    ...chains.map((c) => ({ value: c, label: chainName(c), words: `every pane shows ${chainName(c)} only`, on: chain === c })),
  ]
}

/** Whether the chain filter is in force: a choice, while the account uses more than one chain. */
export const filtering = (chain: ChainSlug | null | undefined, chains: readonly ChainSlug[]): chain is ChainSlug => !!chain && chains.length > 1

/** Whether a row on `rowChain` shows under the filter; a row whose chain isn't known always does. */
export function chainShown(chain: ChainSlug | null | undefined, chains: readonly ChainSlug[], rowChain: string | undefined): boolean {
  return !filtering(chain, chains) || rowChain === undefined || rowChain === chain
}

/** The chain the panes are filtered to, or undefined while nothing is. */
export function chainInForce(view: { views?: { chain?: ChainSlug | null }; portfolio?: Pick<PortfolioView, "wallets" | "chains"> }): ChainSlug | undefined {
  const chain = view.views?.chain ?? null
  return filtering(chain, chainsInUse(view.portfolio)) ? chain : undefined
}

/**
 * The view the listing panes draw from, under the chain filter: Activity, Wallets, Positions, Candle's lists, the
 * Signals tape, the P&L's rows and the Journal keep their rows on the chosen chain, and rows whose chain isn't known.
 * A P&L trade, wallet or swap is on its wallet's chain, read from the account's wallets. The agent's pane and the
 * cards never come through here. P&L's totals stay Candle's, for the whole account.
 */
export function chainScoped(view: CoreView): CoreView {
  const chain = chainInForce(view)
  if (!chain) return view
  const chains = chainsInUse(view.portfolio)
  const keep = (rowChain: string | undefined) => chainShown(chain, chains, rowChain)
  const byWallet = new Map((view.portfolio?.wallets ?? []).map((w) => [addressKey(w.address), w.chain as string]))
  const walletChain = (wallet: string | undefined) => (wallet ? byWallet.get(addressKey(wallet)) : undefined)
  const signalChain = (row: { asset_chain?: unknown; wallet_chain?: unknown; kind?: unknown }) => (row.kind === "gap" ? undefined : maybeChain(row.asset_chain ?? row.wallet_chain)?.slug)
  const feeds = view.feeds ? Object.fromEntries(Object.entries(view.feeds).map(([bucket, list]) => [bucket, list ? { ...list, rows: list.rows.filter((r) => keep(r.chain)) } : list])) : undefined
  return {
    ...view,
    activity: view.activity.filter((e) => keep(e.chain)),
    // The deposit address is the embedded Solana wallet's: on another chain it goes with that wallet.
    // Paper books carry no chain: each position is on its token's, by the address's family.
    ...(view.portfolio ? { portfolio: dropUndefined({ ...view.portfolio, wallets: view.portfolio.wallets.filter((w) => keep(w.chain)), ...(view.portfolio.paper ? { paper: Object.fromEntries(Object.entries(view.portfolio.paper).map(([agent, book]) => [agent, book.filter((p) => keep(storedChain(undefined, p.mint)))] as const).filter(([, book]) => book.length > 0)) } : {}), deposit: view.portfolio.deposit !== undefined && keep(walletChain(view.portfolio.deposit)) ? view.portfolio.deposit : undefined }) } : {}),
    ...(feeds ? { feeds: feeds as CoreView["feeds"] } : {}),
    ...(view.signals ? { signals: { ...view.signals, rows: view.signals.rows.filter((r) => keep(signalChain(r as never))) } } : {}),
    ...(view.pnl
      ? {
          pnl: {
            ...view.pnl,
            agents: view.pnl.agents.map((a) => (a.book ? { ...a, book: { ...a.book, positions: a.book.positions.filter((p) => keep(p.chain)), wallets: a.book.wallets.filter((w) => keep(walletChain(w.wallet))) } } : a)),
            wallets: view.pnl.wallets.filter((w) => keep(walletChain(w.wallet))),
            trades: view.pnl.trades.filter((t) => keep(walletChain(t.wallet))),
            swaps: view.pnl.swaps.filter((s) => keep(walletChain(s.wallet))),
          },
        }
      : {}),
    ...(view.journal ? { journal: { ...view.journal, entries: view.journal.entries.filter((e) => keep(e.chain)) } } : {}),
  }
}

/** Signals' fold: while the chain chip is on screen, the Signals pane's chain is the filter's (undefined, all chains). */
export function signalsFold(view: { views?: { chain?: ChainSlug | null }; portfolio?: Pick<PortfolioView, "wallets" | "chains"> }): { chain?: ChainSlug } | undefined {
  if (chainsInUse(view.portfolio).length < 2) return undefined
  const chain = chainInForce(view)
  return chain ? { chain } : {}
}

const dropUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
