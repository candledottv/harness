// Hacc's safety check on an EVM token (its market read, `/v1/market/token/<address>?chain=hood`, `safety`'s 21 fields),
// said in words as Hacc's, beside whatever Candle's own check answers. Candle's forensics doesn't read Hacc on Hood.
//
// A null field is "not said by Hacc", never "no": on a fresh Hood token most or all of them are null. Amber is kept for
// what warrants a look before buying: a honeypot, a token that can't all be sold, a sell tax over 10%, and trading the
// owner can pause. A token whose answered fields are all clear shows no amber.

/** A sell tax above this is amber. */
export const SELL_TAX_AMBER_PCT = 10

export interface HaccCheck {
  /** Each field Hacc answered, in words, in the order they're said. */
  said: string[]
  /** What warrants a look, in words; empty when nothing does. */
  amber: string[]
  /** How many of the fields read here Hacc left unsaid (null). */
  unsaid: number
  /** Hacc said none of them: no check for this token yet. */
  none: boolean
  at: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const pct = (n: number): string => `${Number(n.toFixed(n < 10 ? 1 : 0))}%`

/** The fields this check reads: the 21 less the creator's address and the counts, which aren't a safety word. */
const READ = [
  "honeypot",
  "cannot_buy",
  "cannot_sell_all",
  "buy_tax_pct",
  "sell_tax_pct",
  "transfer_tax_pct",
  "mintable",
  "transfer_pausable",
  "hidden_owner",
  "can_take_back_ownership",
  "blacklisted",
  "is_proxy",
  "open_source",
  "owner_pct",
  "creator_pct",
  "lp_locked_pct",
  "honeypot_with_same_creator",
] as const

/** Hacc's market answer's `safety`, as a check; undefined when the answer has no safety block. */
export function haccSafety(body: unknown, at: number): HaccCheck | undefined {
  const s = record(record(body)?.safety)
  if (!s) return undefined
  const said: string[] = []
  const amber: string[] = []
  const unsaid = READ.filter((k) => s[k] === null || s[k] === undefined).length

  const honeypot = bool(s.honeypot)
  if (honeypot === true) amber.push("a honeypot: it can be bought and not sold")
  else if (honeypot === false) said.push("no honeypot")
  const sellAll = bool(s.cannot_sell_all)
  if (sellAll === true) amber.push("it can't all be sold")
  if (bool(s.cannot_buy) === true) said.push("it can't be bought")

  const buy = num(s.buy_tax_pct)
  const sell = num(s.sell_tax_pct)
  if (buy !== undefined && sell !== undefined && buy === sell) said.push(`${pct(buy)} buy and sell tax`)
  else {
    if (buy !== undefined) said.push(`${pct(buy)} buy tax`)
    if (sell !== undefined && sell <= SELL_TAX_AMBER_PCT) said.push(`${pct(sell)} sell tax`)
  }
  if (sell !== undefined && sell > SELL_TAX_AMBER_PCT) amber.push(`a ${pct(sell)} sell tax`)
  const transfer = num(s.transfer_tax_pct)
  if (transfer !== undefined && transfer > 0) said.push(`${pct(transfer)} transfer tax`)

  if (bool(s.transfer_pausable) === true) amber.push("its owner can pause trading")
  if (bool(s.mintable) === true) said.push("mintable")
  if (bool(s.hidden_owner) === true) said.push("a hidden owner")
  if (bool(s.can_take_back_ownership) === true) said.push("ownership can be taken back")
  if (bool(s.blacklisted) === true) said.push("a blacklist")
  if (bool(s.is_proxy) === true) said.push("upgradeable (a proxy)")
  const open = bool(s.open_source)
  if (open === false) said.push("source not verified")
  const lp = num(s.lp_locked_pct)
  if (lp !== undefined) said.push(`LP locked ${pct(lp)}`)
  const owner = num(s.owner_pct)
  if (owner !== undefined) said.push(owner === 0 ? "owner holds none" : `owner holds ${pct(owner)}`)
  const creator = num(s.creator_pct)
  if (creator !== undefined && creator > 0) said.push(`creator holds ${pct(creator)}`)
  if (bool(s.honeypot_with_same_creator) === true) said.push("its creator made a honeypot before")

  return { said, amber, unsaid, none: unsaid === READ.length, at }
}

/** The check in one line, as Hacc's: "Hacc: no honeypot, 0% buy and sell tax, LP locked 92%". */
export function haccCheckWords(check: HaccCheck): string {
  if (check.none) return "Hacc has no check for this token yet: not checked, not clean"
  const parts = [...check.amber, ...check.said]
  const rest = check.unsaid > 0 ? ` (${check.unsaid} more not said by Hacc)` : ""
  if (parts.length === 0) return `Hacc: nothing flagged in the ${READ.length - check.unsaid} it checked${rest}`
  return `Hacc: ${parts.join(", ")}${rest}`
}
