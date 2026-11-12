// The journal's `perps` entry on a settled perps card (execute.ts), kept apart from the card path it is read beside.
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
/** A perps market's name as Hyperliquid lists it: "BTC", "kPEPE". */
const COIN = /^[A-Za-z0-9]{1,20}$/

/**
 * The journal's `perps` entry on a settled perps card: what was asked (coin, size or percent, cloid, from the argv the
 * card ran) and what the CLI's answer says it did (side, size, fill price), each only where the answer carries it.
 * Never a guess: a field the answer lacks is left out, and the whole answer is in the row's `result` as for any card.
 */
export function perpsJournalEntry(row: string, argv: readonly string[], result: unknown): Record<string, unknown> {
  const body = record(result) ?? {}
  const statuses = record(record(record(body.exchange)?.response)?.data)?.statuses
  // A close submits one order; skip non-fill statuses to find its venue fill.
  const filled = Array.isArray(statuses) ? statuses.map((s) => record(record(s)?.filled)).find((f) => f !== undefined) : undefined
  const filledSize = filled?.totalSz
  const fillPrice = filled?.avgPx
  // Fees come from `perps fills`, not the order answer.
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const positional = argv[row.split(" ").length]
  const pick = (...keys: string[]): string | number | undefined => keys.map((k) => body[k]).find((v) => typeof v === "string" || typeof v === "number") as string | number | undefined
  const entry: Record<string, unknown> = {
    row,
    ...(row === "perps cancel" ? {} : positional !== undefined && COIN.test(positional) ? { coin: positional } : {}),
    ...(flag("--client-id") ?? (row === "perps cancel" ? positional : undefined) ? { cloid: flag("--client-id") ?? positional } : {}),
    ...(flag("--size") ? { size: flag("--size") } : {}),
    ...(flag("--pct") ? { pct: flag("--pct") } : {}),
    ...(pick("coin", "market") !== undefined ? { coin: pick("coin", "market") } : {}),
    ...(pick("side") !== undefined ? { side: pick("side") } : {}),
    ...(typeof filledSize === "string" || typeof filledSize === "number" ? { size: filledSize } : {}),
    ...(pick("cloid", "clientId") !== undefined ? { cloid: pick("cloid", "clientId") } : {}),
    ...(typeof fillPrice === "string" || typeof fillPrice === "number" ? { fill: fillPrice } : {}),
  }
  return entry
}
