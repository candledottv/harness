// A bot's definition in plain words, as its card and the Bots tab show it: what it buys on, how much, when it
// sells and how many it holds at once. "Buys $2 when several tracked wallets buy the same token, under $500K
// market cap and under 1 hour old. Sells at +100%, at -40%, or after 24 hours. At most 4 at once."
//
// Each figure says what the definition says, as Hacc's replay reads it: a stake's rules add to its multiple, a
// trailing exit arms at a multiple of the entry and sells on a fall from the peak, and a stop is against the
// entry. Where Hacc's backtest fills differently from a live run, `BACKTEST_DIFFERS` says how.
import { type Definition, type EntryPattern, type EntrySource, type Exit, type Feature, type Filters, patternOf, type RuleOp, type Sizing, type SizingRule } from "./definition"
import { dollarWords, durationWords } from "./trigger-grammar"

/** Each pattern a definition enters on, as the clause after "when". */
export const ENTRY_WORDS: Readonly<Record<EntryPattern, string>> = {
  confluence: "several tracked wallets buy the same token",
  new_ticker: "a tracked wallet buys a token for the first time",
  large_move: "a tracked wallet makes a large buy, sell or transfer of a token",
  dormancy: "a tracked wallet moves a token after weeks or months still",
  deployer: "a token's tracked deployer trades it",
  intra_book: "a token moves between wallets Hacc tracks together",
  kol_mention: "a KOL posts about a token",
}

/** The entries a bot can't run, for the card that says so. */
const OTHER_ENTRY_WORDS: Readonly<Record<Exclude<EntrySource, "pattern">, string>> = {
  trade_signal: "Hacc gives a trade signal",
  conviction: "a token's conviction score passes",
  manual: "you buy by hand on Hacc's manual desk",
  levels: "a price level is reached",
  launch_fingerprint: "a launch matches its fingerprint",
  schedule: "its schedule runs",
}

/** How Hacc's backtest differs from a live run, said beside every backtest figure. */
export const BACKTEST_DIFFERS =
  "Hacc's backtest buys at its first price after the signal, often a minute or more later, and fills a stop 5% under its level. A live run buys within seconds of the signal and sells at the market, so the two can differ."
/** The same, short, for a live bot's card under its backtest's figures: the whole of it is in details. */
export const BACKTEST_DIFFERS_SHORT = "a live run buys sooner and sells at the market, so it can differ"

const FEATURE_WORDS: Readonly<Record<Feature, string>> = {
  mcap_at_entry: "its market cap at entry",
  score_15m: "its 15-minute score",
  tracked_buyers_at_trigger: "the count of tracked buyers at the signal",
  proven_follow_present: "a proven wallet following",
  fomo_buyers_at_trigger: "the count of FOMO buyers at the signal",
  momentum_since_first_bar: "its move since its first price",
  minutes_since_first_signal: "the minutes since its first signal",
}

const OP_WORDS: Readonly<Record<RuleOp, string>> = { lt: "under", lte: "at most", gt: "over", gte: "at least" }

const pct = (n: number) => `${trim(n)}%`
const trim = (n: number) => String(Number(n.toFixed(2)))
const andList = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)
const orList = (items: string[]) => (items.length <= 2 ? items.join(" or ") : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`)
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The whole bot, in three or four sentences. */
export function definitionWords(d: Definition): string {
  return [`${stakeWords(d.sizing)} when ${entryWords(d)}.`, exitWords(d.exit), rulesWords(d.sizing), concurrentWords(d.sizing)].filter(Boolean).join(" ")
}

/** What it enters on: the pattern's clause, then its filters. */
export function entryWords(d: Definition): string {
  const pattern = patternOf(d)
  if (!pattern) return OTHER_ENTRY_WORDS[d.entry.source as Exclude<EntrySource, "pattern">]
  const bits = filterWords(d.entry.source === "pattern" ? (d.entry.filters ?? {}) : {})
  // Solana is where most of the tape is, so only the others are said.
  if (d.chain !== "solana") bits.push(d.chain === "hood" ? "on Hood" : "on Solana or Hood")
  return bits.length ? `${ENTRY_WORDS[pattern]}, ${andList(bits)}` : ENTRY_WORDS[pattern]
}

function band(min: number | undefined, max: number | undefined, show: (n: number) => string, what: string): string | undefined {
  if (min !== undefined && max !== undefined) return `between ${show(min)} and ${show(max)} ${what}`
  if (max !== undefined) return `under ${show(max)} ${what}`
  if (min !== undefined) return `over ${show(min)} ${what}`
  return undefined
}

const minutes = (m: number) => durationWords(m * 60_000)

function filterWords(f: Filters): string[] {
  const bits: string[] = []
  const mcap = band(f.min_mcap_usd, f.max_mcap_usd, dollarWords, "market cap")
  if (mcap) bits.push(mcap)
  if (f.min_age_minutes !== undefined && f.max_age_minutes !== undefined) bits.push(`between ${minutes(f.min_age_minutes)} and ${minutes(f.max_age_minutes)} old`)
  else if (f.max_age_minutes !== undefined) bits.push(`under ${minutes(f.max_age_minutes)} old`)
  else if (f.min_age_minutes !== undefined) bits.push(`over ${minutes(f.min_age_minutes)} old`)
  if (f.min_usd !== undefined) bits.push(`a trade of at least ${dollarWords(f.min_usd)}`)
  if (f.direction !== undefined) bits.push(f.direction === "in" ? "tokens moving in" : "tokens moving out")
  if (f.groups?.length) bits.push(f.groups.length === 1 ? `from a wallet in ${f.groups[0]}` : `from a wallet in ${orList(f.groups)}`)
  if (f.groups_all?.length) bits.push(f.groups_all.length === 1 ? `from a wallet in ${f.groups_all[0]}` : `from a wallet in each of ${andList(f.groups_all)}`)
  if (f.min_group_wallets !== undefined) bits.push(`with at least ${f.min_group_wallets} of its wallets in the signal`)
  if (f.wallet_ids?.length) bits.push(f.wallet_ids.length === 1 ? `from Hacc's wallet #${f.wallet_ids[0]}` : `from ${f.wallet_ids.length} of Hacc's wallets (${f.wallet_ids.map((id) => `#${id}`).join(", ")})`)
  if (f.venues?.length) bits.push(`launched on ${orList(f.venues)}`)
  if (f.exclude_venues?.length) bits.push(`not launched on ${orList(f.exclude_venues)}`)
  if (f.hours_et) bits.push(`from hour ${f.hours_et[0]} to hour ${f.hours_et[1]}, US Eastern time`)
  if (f.min_score_1h !== undefined) bits.push(`with an hour's score of at least ${trim(f.min_score_1h)}`)
  return bits
}

/** The stake: `base_usd` where it's given (Hacc pays that, not `usd_per_trade`), else `usd_per_trade`. */
export function stakeWords(s: Sizing): string {
  return `Buys ${dollarWords(s.base_usd ?? s.usd_per_trade)}`
}

function ruleWhen(r: SizingRule): string {
  const parts = Object.entries(r.when).flatMap(([feature, bounds]) => {
    const show = feature === "mcap_at_entry" ? dollarWords : trim
    const ops = Object.entries(bounds ?? {}).map(([op, n]) => `${OP_WORDS[op as RuleOp]} ${show(n)}`)
    return ops.length ? [`${FEATURE_WORDS[feature as Feature]} is ${andList(ops)}`] : []
  })
  return parts.length ? `when ${andList(parts)}` : "always"
}

/** The sizing rules and the cap, in one sentence, or nothing where there are none. */
export function rulesWords(s: Sizing): string {
  const bits = (s.rules ?? []).map((r) => {
    const when = ruleWhen(r)
    if (r.skip) return `skips it ${when}`
    if (r.mult !== undefined) return `${trim(r.mult)}× the stake ${when}`
    return `adds ${trim(r.add!)} to the stake's multiple ${when}`
  })
  if (s.max_usd !== undefined) bits.push(`never more than ${dollarWords(s.max_usd)} a trade`)
  return bits.length ? `${capital(andList(bits))}.` : ""
}

/** A hold in the hours the definition counts in: "24 hours", "1.5 hours", or minutes under an hour. */
const holdWords = (h: number) => (h < 1 ? durationWords(Math.round(h * 60) * 60_000) : `${trim(h)} hour${h === 1 ? "" : "s"}`)

/** When it sells: each exit, then "or". A stop at -100% or lower never fires, so it says so. */
export function exitWords(x: Exit | undefined): string {
  if (!x) return "Takes no exit: Hacc's manual desk."
  const bits: string[] = []
  if (x.take_profit_pct !== undefined) bits.push(`at +${pct(x.take_profit_pct)}`)
  if (x.stop_loss_pct !== undefined && x.stop_loss_pct < 100) bits.push(`at -${pct(x.stop_loss_pct)}`)
  if (x.trailing) bits.push(`on a ${pct(x.trailing.drop_pct)} fall from its peak once it's reached ${trim(x.trailing.arm_multiple)}× what it paid`)
  if (x.max_hold_hours !== undefined) bits.push(`after ${holdWords(x.max_hold_hours)}`)
  if (x.exit_on_signal) bits.push("on a signal")
  if (x.ladder) bits.push("by a ladder")
  const never = x.stop_loss_pct !== undefined && x.stop_loss_pct >= 100 ? ` A stop at -${pct(x.stop_loss_pct)} never fires.` : ""
  return bits.length ? `Sells ${orList(bits)}.${never}` : never.trim()
}

/** How many it holds at once. It holds one position a token, and buys a token again only after it's sold. */
export function concurrentWords(s: Sizing): string {
  return s.max_concurrent === 1 ? "One at a time." : `At most ${s.max_concurrent} at once.`
}
