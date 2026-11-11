// What going live would find missing, for the question that asks first: an agent whose key isn't allowed
// a wallet to pay from, an agent with no limits of its own here, a wallet with nothing in it. Read from what
// the view already holds, and said without blocking: `y` still switches. A setup that went straight to paper
// skipped the wallet step, and nothing else brings it back before the first live trade is refused.
import type { CoreView } from "./store"
import { shortAddress } from "./format"

export interface LiveGap {
  words: string
  /** A command that fixes it, for a chip that puts it on the input line (it runs in the prompt pane, as the person). */
  fill?: { label: string; line: string }
}

/** At most this many, so the question stays a question. */
const MOST = 4

export function liveGaps(view: Pick<CoreView, "status" | "wallets" | "portfolio">): LiveGap[] {
  const out: LiveGap[] = []
  for (const a of view.status?.agents ?? []) {
    const w = view.wallets?.agents[a.name]
    // Its wallets not read yet: nothing is known to be missing.
    if (w) {
      const tee = w.payable.tier === "free" ? [] : w.payable.tee.filter((t) => (t.chain === "solana" || t.chain === "hood") && t.active)
      // Its SOL is asked of the Solana wallets only: a Hood TEE wallet spends ETH or USDG.
      const pays = [...(w.payable.embedded ? [w.payable.embedded.address] : []), ...tee.filter((t) => t.chain === "solana").map((t) => t.address)]
      if (pays.length === 0 && tee.length === 0 && w.embeddedWallet === "denied") {
        const line = `candle keys update ${w.prefix ?? "<prefix>"} --embedded-wallet allow`
        out.push({ words: `${a.name} can't pay from a wallet yet: its key isn't allowed the embedded wallet. Allow it here, in the pane, as you: ${line}`, ...(w.prefix ? { fill: { label: "allow the embedded wallet", line } } : {}) })
      } else if (pays.length > 0) {
        const held = pays.map((address) => view.portfolio?.wallets.find((p) => p.address === address))
        // Every wallet it pays from read, and each empty: a live buy has nothing to spend.
        if (held.every((p) => p?.sol && p.sol.amount === 0)) {
          const first = held[0]!
          out.push({ words: `${first.name ?? "the embedded wallet"} holds no SOL, so ${a.name}'s live buys have nothing to spend. Its address is on the Wallets pane (${shortAddress(first.address)}).` })
        }
      }
    }
    if (!a.limits) out.push({ words: `${a.name} has no limits of its own set here: only Candle's caps on its key would hold a live trade.` })
  }
  return out.slice(0, MOST)
}
