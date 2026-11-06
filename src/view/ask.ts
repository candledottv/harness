// ctrl-t on a row: the question it puts on the input line, in the Candle Harness's own words
// for what the row shows. Never Hacc's or Candle's text: a token's symbol is cut to plain letters and
// digits, and a row's labels and handles are left out, so nothing from a feed reaches the agent as if the
// person typed it. The pick carries the mint, which the agent is told with the next turn.
import { shortAddress } from "./format"

/** A token as the question names it: its symbol, kept to letters, digits and `$._-`, at most 12; else its short address. */
export function askSymbol(symbol: string | null | undefined, mint: string): string {
  const plain = (symbol ?? "").replace(/[^A-Za-z0-9$._-]/g, "").slice(0, 12)
  return plain || shortAddress(mint)
}

/** The question: what the person makes of the token, then where it was seen and what the row said. */
export const askAbout = (symbol: string | null | undefined, mint: string, from: string): string => `What do you make of ${askSymbol(symbol, mint)}? ${from}`

/** A change, as a fraction (0.102), as the question says it: "+10.2%", "-3.0%"; "no change read" when there's none. */
export const askPct = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "no change read" : `${n >= 0 ? "+" : "-"}${Math.min(9999, Math.abs(n) * 100).toFixed(1)}%`)
