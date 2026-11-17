// Fixed pairs are recorded from the same source as Candle's MCP/SDK launch definition.
// Admission of a new quote is a read; it never enables that quote for a spend card.
import pairs from "./launch-quotes.json"

export function launchSelection(args: Record<string, unknown>):
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; code: string; message: string } {
  if (args.quote === undefined) return { ok: true, args }
  if (args.quoteAsset !== undefined) return { ok: false, code: "VALIDATION_FAILED", message: "Pass quote or quoteAsset, never both." }
  if (typeof args.quote !== "string" || !args.quote.trim() || args.quote.trim().length > 120) {
    return { ok: false, code: "VALIDATION_FAILED", message: "quote needs a symbol or token address." }
  }
  const value = args.quote.trim()
  const pair = pairs.fixedPairs.find((p) => p.id === value.toLowerCase() || p.address === value || (p.chain === "hood" && p.address.toLowerCase() === value.toLowerCase()))
  if (!pair) return { ok: false, code: "QUOTE_LAUNCH_UNAVAILABLE", message: "New-quote execution is unavailable. Use check: true for admission and economics only." }
  if (args.chain !== undefined && args.chain !== pair.chain) return { ok: false, code: "CHAIN_MISMATCH", message: "The quote disagrees with the launch chain." }
  const { quote: _quote, ...rest } = args
  return { ok: true, args: { ...rest, chain: pair.chain, quoteAsset: pair.id } }
}
