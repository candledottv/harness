// A row's chain, as a dim word at its right edge (`sol`, `hood`), only while the list it's in mixes chains: with
// one chain on screen there's nothing to tell apart. Panes that group their rows under a chain's heading (Wallets,
// Positions) say it there instead.
import { cellWidth } from "../format"
import { C } from "../theme"
import type { Seg } from "./lines"

/** The tag's word: `sol` for Solana, else the chain's slug. */
export const chainTagWord = (chain: string): string => (chain === "solana" ? "sol" : chain)

/** The cells a tag takes, with the space before it: the longest word on, `hood`, and one. */
export const TAG_CELLS = 5

/** Whether a list's rows are on more than one chain (rows whose chain isn't known aside). */
export const mixesChains = (chains: readonly (string | undefined)[]): boolean => new Set(chains.filter((c): c is string => !!c)).size > 1

/** `segs` with `chain`'s tag, dim, at the right edge of `width`; nothing added for a row whose chain isn't known. */
export function withChainTag(segs: readonly Seg[], chain: string | undefined, width: number): Seg[] {
  if (!chain) return [...segs]
  const tag = chainTagWord(chain)
  const used = segs.reduce((n, s) => n + cellWidth(s.text), 0)
  return [...segs, { text: " ".repeat(Math.max(1, width - used - tag.length)), fg: C.ink }, { text: tag, fg: C.dim }]
}
