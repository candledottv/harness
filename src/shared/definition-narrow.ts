// Whether a change to a bot only narrows it: buys less, buys on less, holds less or sells sooner, with nothing
// it runs as moved. A narrowing takes at once, by the person or the agent; anything wider, or anything this
// can't tell is narrower, is a new card for the person to press.
//
// Narrower is, field by field:
//   - the chain: the same, or one chain where it watched both;
//   - the entry: the same pattern, and each filter as strict or stricter (a floor raised, a ceiling lowered, a
//     filter added, fewer groups or wallets to match, more groups to match all of, more venues left out, a
//     narrower window of hours). An entry a bot can't run must be unchanged;
//   - the exits: a take profit, stop or hold that comes sooner, one added, a trailing exit that arms sooner or
//     sells on a smaller fall. Taking an exit away holds longer, so it's wider. A ladder must be unchanged. An
//     exit moved so near that it sells almost as soon as the bot buys (under 1%, or a hold under 5 minutes) is
//     a card: it would turn every entry into a buy and a sell;
//   - the sizing: a smaller stake, fewer at once, a lower cap, and a skip rule added. Any other change to its
//     rules is a new card;
//   - the run settings: the same agent, wallet and mode, and a slippage bound tightened no further than the
//     route's default. A bound under the default binds its sells too, which may then not fill, so that's a card.
import { canonicalJson } from "./canonical-json"
import type { BotRunSettings, Definition, Exit, Filters, Sizing } from "./definition"
import { dollarWords, durationWords } from "./trigger-grammar"

export type Narrowing = { ok: true; what: string[] } | { ok: false; wider: string }

export interface BotShape {
  definition: Definition
  run: BotRunSettings
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
const trim = (n: number) => String(Number(n.toFixed(2)))
const pct = (n: number) => `${trim(n)}%`
const minutes = (m: number) => durationWords(m * 60_000)
const hours = (h: number) => (h < 1 ? durationWords(h * 3_600_000) : `${trim(h)} hour${h === 1 ? "" : "s"}`)
const listed = (xs: readonly unknown[]) => xs.map(String).join(", ")

class Wider extends Error {}

/** The tightest slippage bound a bot may have: under it almost nothing fills, sells included. */
export const SLIPPAGE_FLOOR_BPS = 10

/** What's wrong with a slippage bound as a figure, in words; undefined when it's one a bot may have. */
export function slippageProblem(bps: unknown): string | undefined {
  if (typeof bps === "number" && Number.isInteger(bps) && bps >= SLIPPAGE_FLOOR_BPS && bps <= 10_000) return undefined
  return `maxSlippageBps is a whole number of basis points, from ${SLIPPAGE_FLOOR_BPS} to 10000: a bound under ${pct(SLIPPAGE_FLOOR_BPS / 100)} fills almost nothing, sells included.`
}

/** Why a bound tightened under the route's default isn't a narrowing: it changes how the bot's sells fill. */
export const underDefaultWords = (bps: number, routeBps: number) => `a slippage bound of ${pct(bps / 100)} is under the route's ${pct(routeBps / 100)}, and a bound that tight can make its sells fail`

/**
 * Whether `now` only narrows `was`. `defaultSlippageBps` is the route's own bound for this wallet, which a
 * bot with none runs at. What narrowed is said field by field, "a stop at -30%, from -40%".
 */
export function narrowing(was: BotShape, now: BotShape, defaultSlippageBps: number): Narrowing {
  const what: string[] = []
  try {
    runSettings(was.run, now.run, defaultSlippageBps, what)
    chain(was.definition, now.definition, what)
    entry(was.definition, now.definition, what)
    exit(was.definition.exit, now.definition.exit, what)
    sizing(was.definition.sizing, now.definition.sizing, what)
  } catch (error) {
    if (error instanceof Wider) return { ok: false, wider: error.message }
    throw error
  }
  return { ok: true, what }
}

function runSettings(was: BotRunSettings, now: BotRunSettings, fallback: number, what: string[]): void {
  if (now.agent !== was.agent) throw new Wider("a bot keeps its agent: one for another agent is a new bot")
  if (now.wallet !== was.wallet) throw new Wider("a bot keeps the wallet it pays from: another wallet is a new card")
  if (now.mode !== was.mode) throw new Wider(now.mode === "live" ? "taking a bot live is a new card" : "a bot keeps its mode: pause it, or ask for a paper bot of its own")
  const a = was.maxSlippageBps ?? fallback
  const b = now.maxSlippageBps ?? fallback
  if (b > a) throw new Wider(`a slippage bound of ${pct(b / 100)} is looser than its ${pct(a / 100)}`)
  if (b < a) {
    if (b < fallback) throw new Wider(underDefaultWords(b, fallback))
    what.push(`slippage ${pct(b / 100)}, from ${pct(a / 100)}`)
  }
}

function chain(was: Definition, now: Definition, what: string[]): void {
  if (now.chain === was.chain) return
  if (was.chain === "any") {
    what.push(`only ${now.chain === "hood" ? "Hood" : "Solana"}, from both chains`)
    return
  }
  throw new Wider(`it watches ${was.chain === "hood" ? "Hood" : "Solana"}: another chain is a new card`)
}

function entry(was: Definition, now: Definition, what: string[]): void {
  if (was.entry.source !== "pattern" || now.entry.source !== "pattern") {
    if (!same(was.entry, now.entry)) throw new Wider("its entry changed")
    return
  }
  if (now.entry.pattern !== was.entry.pattern) throw new Wider(`it enters on ${was.entry.pattern} signals: another pattern is a new card`)
  filters(was.entry.filters ?? {}, now.entry.filters ?? {}, what)
}

/** A figure the change may only lower: a ceiling, a stake, a stop. Taking one away is wider; adding one, narrower. */
function lower(was: number | undefined, now: number | undefined, label: string, show: (n: number) => string, what: string[]): void {
  if (now === was) return
  if (now === undefined) throw new Wider(`it drops ${label}`)
  if (was === undefined) {
    what.push(`${label} ${show(now)}, added`)
    return
  }
  if (now > was) throw new Wider(`${label} ${show(now)} is over its ${show(was)}`)
  what.push(`${label} ${show(now)}, from ${show(was)}`)
}

/** A figure the change may only raise: a floor. */
function higher(was: number | undefined, now: number | undefined, label: string, show: (n: number) => string, what: string[]): void {
  if (now === was) return
  if (now === undefined) throw new Wider(`it drops ${label}`)
  if (was === undefined) {
    what.push(`${label} ${show(now)}, added`)
    return
  }
  if (now < was) throw new Wider(`${label} ${show(now)} is under its ${show(was)}`)
  what.push(`${label} ${show(now)}, from ${show(was)}`)
}

/** An empty list filters nothing, so it's the same as none. */
const some = <T>(xs: readonly T[] | undefined) => (xs?.length ? xs : undefined)

/**
 * A list it matches any of: fewer is stricter, and adding one where there was none is too. Emptying one takes the
 * filter away, which is wider.
 */
function anyOf<T>(wasList: readonly T[] | undefined, nowList: readonly T[] | undefined, label: string, what: string[]): void {
  const was = some(wasList)
  const now = some(nowList)
  if (same(was, now)) return
  if (now === undefined) throw new Wider(`it drops its ${label}`)
  if (was === undefined) {
    what.push(`only ${label} ${listed(now)}`)
    return
  }
  const extra = now.filter((x) => !was.includes(x))
  if (extra.length) throw new Wider(`it adds ${listed(extra)} to its ${label}`)
  what.push(`only ${label} ${listed(now)}, from ${listed(was)}`)
}

/** A list it must match all of, or leave out: more is stricter. */
function allOf<T>(was: readonly T[] | undefined, now: readonly T[] | undefined, label: string, what: string[]): void {
  if (same(was, now)) return
  const gone = (was ?? []).filter((x) => !(now ?? []).includes(x))
  if (gone.length) throw new Wider(`it takes ${listed(gone)} out of its ${label}`)
  what.push(`${label} ${listed(now ?? [])}${was?.length ? `, from ${listed(was)}` : ", added"}`)
}

function filters(was: Filters, now: Filters, what: string[]): void {
  higher(was.min_mcap_usd, now.min_mcap_usd, "a market cap floor of", dollarWords, what)
  lower(was.max_mcap_usd, now.max_mcap_usd, "a market cap ceiling of", dollarWords, what)
  higher(was.min_age_minutes, now.min_age_minutes, "a least age of", minutes, what)
  lower(was.max_age_minutes, now.max_age_minutes, "a greatest age of", minutes, what)
  higher(was.min_usd, now.min_usd, "a least trade of", dollarWords, what)
  higher(was.min_score_1h, now.min_score_1h, "an hour's score of at least", trim, what)
  higher(was.min_group_wallets, now.min_group_wallets, "at least", (n) => `${n} of a group's wallets`, what)
  anyOf(was.groups, now.groups, "groups", what)
  allOf(was.groups_all, now.groups_all, "groups to match all of", what)
  anyOf(was.wallet_ids, now.wallet_ids, "Hacc wallets", what)
  anyOf(was.venues, now.venues, "venues", what)
  allOf(was.exclude_venues, now.exclude_venues, "venues left out", what)
  if (now.direction !== was.direction) {
    if (was.direction !== undefined) throw new Wider(now.direction === undefined ? "it drops its direction" : `it moves its direction to ${now.direction}`)
    what.push(`only tokens moving ${now.direction}`)
  }
  if (!same(was.hours_et, now.hours_et)) {
    if (now.hours_et === undefined) throw new Wider("it drops its hours")
    const [a, b] = now.hours_et
    if (was.hours_et && (a < was.hours_et[0] || b > was.hours_et[1])) throw new Wider(`hours ${a} to ${b} reach outside its ${was.hours_et[0]} to ${was.hours_et[1]}`)
    what.push(`hours ${a} to ${b} US Eastern${was.hours_et ? `, from ${was.hours_et[0]} to ${was.hours_et[1]}` : ", added"}`)
  }
}

/** The nearest an exit may be moved at once: under these it sells almost as soon as the bot buys. */
export const NEAREST_EXIT_PCT = 1
export const SHORTEST_HOLD_HOURS = 5 / 60

/** An exit moved or added under its floor is a card, not a narrowing. One already there stays as it was approved. */
function near(was: number | undefined, now: number | undefined, floor: number, words: (n: number) => string): void {
  if (now !== undefined && now !== was && now < floor) throw new Wider(words(now))
}

function exit(was: Exit | undefined, now: Exit | undefined, what: string[]): void {
  const a = was ?? {}
  const b = now ?? {}
  lower(a.take_profit_pct, b.take_profit_pct, "a take profit at", (n) => `+${pct(n)}`, what)
  lower(a.stop_loss_pct, b.stop_loss_pct, "a stop at", (n) => `-${pct(n)}`, what)
  lower(a.max_hold_hours, b.max_hold_hours, "a hold of at most", hours, what)
  const sellsAtOnce = "it would sell almost as soon as it buys"
  near(a.take_profit_pct, b.take_profit_pct, NEAREST_EXIT_PCT, (n) => `a take profit at +${pct(n)} is under ${pct(NEAREST_EXIT_PCT)}: ${sellsAtOnce}`)
  near(a.stop_loss_pct, b.stop_loss_pct, NEAREST_EXIT_PCT, (n) => `a stop at -${pct(n)} is under ${pct(NEAREST_EXIT_PCT)}: ${sellsAtOnce}`)
  near(a.max_hold_hours, b.max_hold_hours, SHORTEST_HOLD_HOURS, (n) => `a hold of at most ${hours(n)} is under ${hours(SHORTEST_HOLD_HOURS)}: ${sellsAtOnce}`)
  near(a.trailing?.drop_pct, b.trailing?.drop_pct, NEAREST_EXIT_PCT, (n) => `a trailing exit on a ${pct(n)} fall is under ${pct(NEAREST_EXIT_PCT)}: ${sellsAtOnce}`)
  if (!same(a.trailing, b.trailing)) {
    if (!b.trailing) throw new Wider("it drops its trailing exit")
    if (!a.trailing) what.push(`a trailing exit, added`)
    else {
      if (b.trailing.arm_multiple > a.trailing.arm_multiple) throw new Wider(`its trailing exit arms later, at ${trim(b.trailing.arm_multiple)}×`)
      if (b.trailing.drop_pct > a.trailing.drop_pct) throw new Wider(`its trailing exit waits for a ${pct(b.trailing.drop_pct)} fall`)
      what.push(`a trailing exit at ${trim(b.trailing.arm_multiple)}× and a ${pct(b.trailing.drop_pct)} fall, from ${trim(a.trailing.arm_multiple)}× and ${pct(a.trailing.drop_pct)}`)
    }
  }
  if ((a.exit_on_signal === true) !== (b.exit_on_signal === true)) {
    if (a.exit_on_signal === true) throw new Wider("it drops its exit on a signal")
    what.push("an exit on a signal, added")
  }
  if (!same(a.ladder, b.ladder)) throw new Wider("its ladder changed")
}

const stakeOf = (s: Sizing) => s.base_usd ?? s.usd_per_trade

function sizing(was: Sizing, now: Sizing, what: string[]): void {
  const a = stakeOf(was)
  const b = stakeOf(now)
  if (b > a) throw new Wider(`a stake of ${dollarWords(b)} is over its ${dollarWords(a)}`)
  if (b < a) what.push(`a stake of ${dollarWords(b)}, from ${dollarWords(a)}`)
  // The figure Hacc pays without a base stake: a change that hides a larger one behind base_usd is wider too.
  if (now.usd_per_trade > was.usd_per_trade) throw new Wider(`usd_per_trade ${dollarWords(now.usd_per_trade)} is over its ${dollarWords(was.usd_per_trade)}`)
  lower(was.max_concurrent, now.max_concurrent, "at most", (n) => `${n} at once`, what)
  lower(was.max_usd, now.max_usd, "a cap of", (n) => `${dollarWords(n)} a trade`, what)
  const old = was.rules ?? []
  const next = now.rules ?? []
  // Its rules, in order, with skip rules added anywhere between them.
  let i = 0
  const added: number[] = []
  for (const r of next) {
    if (i < old.length && same(r, old[i])) i++
    else if (r.skip === true && r.mult === undefined && r.add === undefined) added.push(1)
    else throw new Wider("its sizing rules changed")
  }
  if (i < old.length) throw new Wider("it drops a sizing rule")
  if (added.length) what.push(added.length === 1 ? "a skip rule, added" : `${added.length} skip rules, added`)
}

/**
 * What a change to a saved bot changes, either way, field by field and short, for its card's face: "a stake of $3,
 * from $2", "a stop at -20%, from -25%". A part this can't say by field is named whole ("its entry changed").
 */
export function changes(was: BotShape, now: BotShape, defaultSlippageBps: number): string[] {
  const out: string[] = []
  const fig = (a: number | undefined, b: number | undefined, label: string, show: (n: number) => string) => {
    if (a === b) return
    out.push(b === undefined ? `${label} ${show(a!)}, dropped` : a === undefined ? `${label} ${show(b)}, added` : `${label} ${show(b)}, from ${show(a)}`)
  }
  if (now.run.mode !== was.run.mode) out.push(now.run.mode === "live" ? "live, from paper" : "paper, from live")
  if (now.run.wallet !== was.run.wallet) out.push("another wallet pays")
  const sa = was.run.maxSlippageBps ?? defaultSlippageBps
  const sb = now.run.maxSlippageBps ?? defaultSlippageBps
  if (sa !== sb) out.push(`slippage ${pct(sb / 100)}, from ${pct(sa / 100)}`)
  if (now.definition.chain !== was.definition.chain) out.push(`${now.definition.chain === "hood" ? "Hood" : now.definition.chain === "solana" ? "Solana" : "both chains"}, from ${was.definition.chain === "hood" ? "Hood" : was.definition.chain === "solana" ? "Solana" : "both chains"}`)
  const ea = was.definition.entry
  const eb = now.definition.entry
  if (ea.source === "pattern" && eb.source === "pattern" && ea.pattern === eb.pattern) {
    const fa: Filters = ea.filters ?? {}
    const fb: Filters = eb.filters ?? {}
    fig(fa.min_mcap_usd, fb.min_mcap_usd, "a market cap floor of", dollarWords)
    fig(fa.max_mcap_usd, fb.max_mcap_usd, "a market cap ceiling of", dollarWords)
    fig(fa.min_age_minutes, fb.min_age_minutes, "a least age of", minutes)
    fig(fa.max_age_minutes, fb.max_age_minutes, "a greatest age of", minutes)
    fig(fa.min_usd, fb.min_usd, "a least trade of", dollarWords)
    const said = new Set(["min_mcap_usd", "max_mcap_usd", "min_age_minutes", "max_age_minutes", "min_usd"])
    const rest = (f: Filters) => Object.fromEntries(Object.entries(f).filter(([k]) => !said.has(k)))
    if (!same(rest(fa), rest(fb))) out.push("its entry's filters changed")
  } else if (!same(ea, eb)) out.push("its entry changed")
  const xa: Exit = was.definition.exit ?? {}
  const xb: Exit = now.definition.exit ?? {}
  fig(xa.take_profit_pct, xb.take_profit_pct, "a take profit at", (n) => `+${pct(n)}`)
  fig(xa.stop_loss_pct, xb.stop_loss_pct, "a stop at", (n) => `-${pct(n)}`)
  fig(xa.max_hold_hours, xb.max_hold_hours, "a hold of at most", hours)
  if (!same(xa.trailing, xb.trailing)) out.push(xb.trailing ? `a trailing exit at ${trim(xb.trailing.arm_multiple)}× and a ${pct(xb.trailing.drop_pct)} fall${xa.trailing ? `, from ${trim(xa.trailing.arm_multiple)}× and ${pct(xa.trailing.drop_pct)}` : ", added"}` : "no trailing exit")
  if ((xa.exit_on_signal === true) !== (xb.exit_on_signal === true)) out.push(xb.exit_on_signal ? "an exit on a signal, added" : "no exit on a signal")
  if (!same(xa.ladder, xb.ladder)) out.push("its ladder changed")
  const za = was.definition.sizing
  const zb = now.definition.sizing
  fig(stakeOf(za), stakeOf(zb), "a stake of", dollarWords)
  fig(za.max_concurrent, zb.max_concurrent, "at most", (n) => `${n} at once`)
  fig(za.max_usd, zb.max_usd, "a cap of", (n) => `${dollarWords(n)} a trade`)
  if (!same(za.rules, zb.rules)) out.push("its sizing rules changed")
  return out
}
