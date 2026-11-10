// A rules bot's definition: Hacc's strategy definition, read by the core before a bot is proposed, saved or run.
// Hacc's lab takes the same JSON for a backtest, so the reader follows Hacc's own schema as Hacc answers it
// (the first problem as "<path>: <message>", in Hacc's words, unknown fields refused at every level), and a
// definition the reader takes is one Hacc's replay takes too.
//
// Then what runs live. A bot enters on Hacc's tape and exits on Candle's market read, so only what those two
// let the core check runs: a pattern entry, with each filter the tape's row or its filtered read carries; the
// take profit, stop, max hold and trailing exits; and sizing on the market cap at entry. Everything else is
// refused live with why, and can still be backtested.
//
// Where Hacc's own bound isn't known (the stop's floor, a trailing drop, a group count), the reader keeps a
// floor of its own in the same words, so nothing meaningless runs. The entry sources a bot can't run, and a
// ladder, are read only as far as Hacc's required fields: their other fields are left for Hacc to check when
// they're replayed.
import { createHash } from "node:crypto"
import { canonicalJson } from "./canonical-json"
import type { TapeFilters, TriggerWhen } from "./trigger-grammar"

export const CHAINS = ["solana", "hood", "any"] as const
export type DefinitionChain = (typeof CHAINS)[number]

export const ENTRY_SOURCES = ["pattern", "trade_signal", "conviction", "manual", "levels", "launch_fingerprint", "schedule"] as const
export type EntrySource = (typeof ENTRY_SOURCES)[number]

/** The tape's patterns a definition enters on: `distribution` is on the tape, but not an entry. */
export const ENTRY_PATTERNS = ["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "kol_mention"] as const
export type EntryPattern = (typeof ENTRY_PATTERNS)[number]

/** What a sizing rule's `when` reads, at the signal or at entry. */
export const FEATURES = ["mcap_at_entry", "score_15m", "tracked_buyers_at_trigger", "proven_follow_present", "fomo_buyers_at_trigger", "momentum_since_first_bar", "minutes_since_first_signal"] as const
export type Feature = (typeof FEATURES)[number]

export const RULE_OPS = ["lt", "lte", "gt", "gte"] as const
export type RuleOp = (typeof RULE_OPS)[number]

export const MAX_WALLET_IDS = 50

export interface Filters {
  min_usd?: number
  min_mcap_usd?: number
  max_mcap_usd?: number
  min_age_minutes?: number
  max_age_minutes?: number
  min_score_1h?: number
  groups?: string[]
  groups_all?: string[]
  min_group_wallets?: number
  wallet_ids?: number[]
  venues?: string[]
  exclude_venues?: string[]
  direction?: "in" | "out"
  hours_et?: [number, number]
}

export interface PatternEntry {
  source: "pattern"
  pattern: EntryPattern
  filters?: Filters
}

/** An entry a bot can't run: its required fields read, the rest kept as written for Hacc's replay. */
export interface OtherEntry {
  source: Exclude<EntrySource, "pattern">
  [field: string]: unknown
}

export type Entry = PatternEntry | OtherEntry

export interface Trailing {
  arm_multiple: number
  drop_pct: number
}

export interface Exit {
  take_profit_pct?: number
  stop_loss_pct?: number
  max_hold_hours?: number
  exit_on_signal?: boolean
  trailing?: Trailing
  /** Read only for its required field; kept as written. */
  ladder?: Record<string, unknown>
}

export type RuleWhen = Partial<Record<Feature, Partial<Record<RuleOp, number>>>>

export interface SizingRule {
  when: RuleWhen
  mult?: number
  add?: number
  skip?: true
}

export interface Sizing {
  usd_per_trade: number
  max_concurrent: number
  base_usd?: number
  max_usd?: number
  rules?: SizingRule[]
}

export interface Definition {
  chain: DefinitionChain
  entry: Entry
  /** Absent only on a manual entry, which takes no exit. */
  exit?: Exit
  sizing: Sizing
}

export type DefinitionRead = { ok: true; definition: Definition } | { ok: false; message: string }

/** Hacc's first problem, as it names one. */
class Problem extends Error {
  constructor(readonly path: string, readonly text: string) {
    super(path ? `${path}: ${text}` : text)
  }
}

export const isEntryPattern = (e: Entry): e is PatternEntry => e.source === "pattern"
export const patternOf = (d: Definition): EntryPattern | undefined => (isEntryPattern(d.entry) ? d.entry.pattern : undefined)

/**
 * Reads a definition as Hacc's lab does: the definition itself, not the `{definition, from, to}` a replay sends.
 * What it takes is a copy, with nothing unknown in it.
 */
export function readDefinition(value: unknown): DefinitionRead {
  try {
    return { ok: true, definition: definition(value) }
  } catch (e) {
    if (e instanceof Problem) return { ok: false, message: e.message }
    throw e
  }
}

/**
 * Reads exits a code bot asks the core to hold on a position: a definition's exit shape, read by the same rules, and
 * only the exits the core runs live (a take profit, a stop, a max hold, a trailing stop). Selling on a signal and a
 * ladder are its own code's to do.
 */
export function readHeldExit(value: unknown): { ok: true; exit: Exit } | { ok: false; message: string } {
  try {
    const x = exitOf(value, false)
    const not = [x.exit_on_signal !== undefined ? "exit_on_signal" : "", x.ladder !== undefined ? "ladder" : ""].filter(Boolean)
    if (not.length) return { ok: false, message: `exit: ${not.join(" and ")} ${not.length === 1 ? "isn't" : "aren't"} held by the core: it holds take_profit_pct, stop_loss_pct, max_hold_hours and trailing. A bot sells on a signal itself.` }
    if (x.take_profit_pct === undefined && x.stop_loss_pct === undefined && x.max_hold_hours === undefined && x.trailing === undefined) return { ok: false, message: "exit must include at least one of take_profit_pct, stop_loss_pct, max_hold_hours or trailing" }
    return { ok: true, exit: x }
  } catch (e) {
    // Hacc's words for an empty exit name the two the core doesn't hold: said with the four it does.
    if (e instanceof Problem && e.text.startsWith("exit must include")) return { ok: false, message: "exit must include at least one of take_profit_pct, stop_loss_pct, max_hold_hours or trailing" }
    if (e instanceof Problem) return { ok: false, message: e.message }
    throw e
  }
}

// ---- Hacc's schema, field by field ----

/** How Hacc names what it received. */
function received(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isNaN(v) ? "nan" : "number"
  return typeof v
}

const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key))
const listed = (values: readonly string[]) => values.map((v) => `'${v}'`).join(" | ")

function object(v: unknown, path: string): Record<string, unknown> {
  if (v === undefined) throw new Problem(path, "Required")
  if (received(v) !== "object") throw new Problem(path, `Expected object, received ${received(v)}`)
  return v as Record<string, unknown>
}

/** Unknown keys, as Hacc refuses them: after the keys it knows have been read. */
function strict(o: Record<string, unknown>, known: readonly string[], path: string) {
  const extra = Object.keys(o).filter((k) => !known.includes(k))
  if (extra.length) throw new Problem(path, `Unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(", ")}`)
}

interface NumberRule {
  int?: boolean
  gt?: number
  gte?: number
  lte?: number
}

function number(v: unknown, path: string, rule: NumberRule = {}): number {
  if (v === undefined) throw new Problem(path, "Required")
  if (received(v) !== "number") throw new Problem(path, `Expected number, received ${received(v)}`)
  const n = v as number
  if (!Number.isFinite(n)) throw new Problem(path, "Number must be finite")
  if (rule.int && !Number.isInteger(n)) throw new Problem(path, "Expected integer, received float")
  if (rule.gt !== undefined && !(n > rule.gt)) throw new Problem(path, `Number must be greater than ${rule.gt}`)
  if (rule.gte !== undefined && !(n >= rule.gte)) throw new Problem(path, `Number must be greater than or equal to ${rule.gte}`)
  if (rule.lte !== undefined && !(n <= rule.lte)) throw new Problem(path, `Number must be less than or equal to ${rule.lte}`)
  return n
}

function optionalNumber(o: Record<string, unknown>, key: string, path: string, rule?: NumberRule): number | undefined {
  return o[key] === undefined ? undefined : number(o[key], join(path, key), rule)
}

function oneOf<T extends string>(v: unknown, values: readonly T[], path: string): T {
  if (v === undefined) throw new Problem(path, "Required")
  if (typeof v !== "string") throw new Problem(path, `Expected ${listed(values)}, received ${received(v)}`)
  if (!(values as readonly string[]).includes(v)) throw new Problem(path, `Invalid enum value. Expected ${listed(values)}, received '${v}'`)
  return v as T
}

function array(v: unknown, path: string, size: { min?: number; max?: number } = {}): unknown[] {
  if (v === undefined) throw new Problem(path, "Required")
  if (!Array.isArray(v)) throw new Problem(path, `Expected array, received ${received(v)}`)
  if (size.min !== undefined && v.length < size.min) throw new Problem(path, `Array must contain at least ${size.min} element(s)`)
  if (size.max !== undefined && v.length > size.max) throw new Problem(path, `Array must contain at most ${size.max} element(s)`)
  return v
}

/** A list of names a filter matches against. An empty one is refused: it would read as a filter and match as none. */
function strings(o: Record<string, unknown>, key: string, path: string): string[] | undefined {
  if (o[key] === undefined) return undefined
  const at = join(path, key)
  return array(o[key], at, { min: 1 }).map((s, i) => {
    if (typeof s !== "string") throw new Problem(join(at, i), `Expected string, received ${received(s)}`)
    return s
  })
}

function boolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new Problem(path, v === undefined ? "Required" : `Expected boolean, received ${received(v)}`)
  return v
}

function definition(v: unknown): Definition {
  const o = object(v, "")
  const chain = oneOf(o.chain, CHAINS, "chain")
  const entry = entryOf(o.entry)
  const manual = entry.source === "manual"
  const exit = manual && o.exit === undefined ? undefined : exitOf(o.exit, manual)
  const sizing = sizingOf(o.sizing)
  strict(o, ["chain", "entry", "exit", "sizing"], "")
  return { chain, entry, ...(exit ? { exit } : {}), sizing }
}

function entryOf(v: unknown): Entry {
  const o = object(v, "entry")
  if (typeof o.source !== "string" || !(ENTRY_SOURCES as readonly string[]).includes(o.source)) {
    throw new Problem("entry.source", `Invalid discriminator value. Expected ${listed(ENTRY_SOURCES)}`)
  }
  const source = o.source as EntrySource
  switch (source) {
    case "pattern": {
      const pattern = oneOf(o.pattern, ENTRY_PATTERNS, "entry.pattern")
      const filters = o.filters === undefined ? undefined : filtersOf(o.filters, pattern)
      strict(o, ["source", "pattern", "filters"], "entry")
      return { source, pattern, ...(filters ? { filters } : {}) }
    }
    // Read as far as Hacc's required fields, as recorded; the rest is Hacc's to check on a replay.
    case "trade_signal":
      number(o.min_confidence, "entry.min_confidence")
      break
    case "conviction":
      number(o.score_window_minutes, "entry.score_window_minutes")
      break
    case "schedule":
      number(o.usd_per_asset, "entry.usd_per_asset")
      break
    case "levels":
      oneOf(o.chain, ["solana", "hood"], "entry.chain")
      break
    case "launch_fingerprint":
      if (o.chain !== "solana") throw new Problem("entry.chain", `Invalid literal value, expected "solana"`)
      break
    case "manual":
      break
  }
  return structuredClone(o) as OtherEntry
}

const FILTER_KEYS = ["min_usd", "min_mcap_usd", "max_mcap_usd", "min_age_minutes", "max_age_minutes", "min_score_1h", "groups", "groups_all", "min_group_wallets", "wallet_ids", "venues", "exclude_venues", "direction", "hours_et"] as const

function filtersOf(v: unknown, pattern: EntryPattern): Filters {
  const path = "entry.filters"
  const o = object(v, path)
  const f: Filters = {}
  const put = <K extends keyof Filters>(k: K, value: Filters[K] | undefined) => {
    if (value !== undefined) f[k] = value
  }
  put("min_usd", optionalNumber(o, "min_usd", path, { gte: 0 }))
  put("min_mcap_usd", optionalNumber(o, "min_mcap_usd", path, { gt: 0 }))
  put("max_mcap_usd", optionalNumber(o, "max_mcap_usd", path, { gt: 0 }))
  put("min_age_minutes", optionalNumber(o, "min_age_minutes", path, { gte: 0 }))
  put("max_age_minutes", optionalNumber(o, "max_age_minutes", path, { gte: 0 }))
  put("min_score_1h", optionalNumber(o, "min_score_1h", path))
  put("groups", strings(o, "groups", path))
  put("groups_all", strings(o, "groups_all", path))
  put("min_group_wallets", optionalNumber(o, "min_group_wallets", path, { int: true, gte: 1 }))
  if (o.wallet_ids !== undefined) {
    const at = join(path, "wallet_ids")
    put("wallet_ids", array(o.wallet_ids, at, { min: 1, max: MAX_WALLET_IDS }).map((id, i) => number(id, join(at, i), { int: true })))
  }
  put("venues", strings(o, "venues", path))
  put("exclude_venues", strings(o, "exclude_venues", path))
  if (o.direction !== undefined) put("direction", oneOf(o.direction, ["in", "out"] as const, join(path, "direction")))
  if (o.hours_et !== undefined) {
    const at = join(path, "hours_et")
    const [start, end] = array(o.hours_et, at, { min: 2, max: 2 }).map((h, i) => number(h, join(at, i), { int: true, gte: 0, lte: 23 }))
    if (start! > end!) throw new Problem(at, "hours_et must be [start, end] with start <= end (no overnight wrap)")
    put("hours_et", [start!, end!])
  }
  strict(o, FILTER_KEYS, path)
  if (f.venues !== undefined && f.exclude_venues !== undefined) throw new Problem(path, "venues and exclude_venues cannot both be set")
  if (f.min_group_wallets !== undefined && f.groups?.length !== 1) throw new Problem(path, "min_group_wallets requires exactly one entry in groups")
  if (f.wallet_ids !== undefined && pattern === "confluence") throw new Problem(path, "wallet_ids cannot be used with pattern confluence")
  return f
}

const EXIT_KEYS = ["take_profit_pct", "stop_loss_pct", "max_hold_hours", "exit_on_signal", "trailing", "ladder"] as const

function exitOf(v: unknown, manual: boolean): Exit {
  const path = "exit"
  const o = object(v, path)
  const x: Exit = {}
  const tp = optionalNumber(o, "take_profit_pct", path, { gt: 0 })
  if (tp !== undefined) x.take_profit_pct = tp
  const sl = optionalNumber(o, "stop_loss_pct", path, { gt: 0 })
  if (sl !== undefined) x.stop_loss_pct = sl
  const hold = optionalNumber(o, "max_hold_hours", path, { gt: 0 })
  if (hold !== undefined) x.max_hold_hours = hold
  if (o.exit_on_signal !== undefined) x.exit_on_signal = boolean(o.exit_on_signal, join(path, "exit_on_signal"))
  if (o.trailing !== undefined) {
    const at = join(path, "trailing")
    const t = object(o.trailing, at)
    const arm = number(t.arm_multiple, join(at, "arm_multiple"), { gte: 1 })
    const drop = number(t.drop_pct, join(at, "drop_pct"), { gt: 0, lte: 100 })
    strict(t, ["arm_multiple", "drop_pct"], at)
    x.trailing = { arm_multiple: arm, drop_pct: drop }
  }
  if (o.ladder !== undefined) {
    const at = join(path, "ladder")
    const l = object(o.ladder, at)
    if (l.sell_aggregate === undefined) throw new Problem(join(at, "sell_aggregate"), "Required")
    x.ladder = structuredClone(l)
  }
  strict(o, EXIT_KEYS, path)
  const any = x.take_profit_pct !== undefined || x.stop_loss_pct !== undefined || x.max_hold_hours !== undefined || x.exit_on_signal === true || x.trailing !== undefined || x.ladder !== undefined
  if (manual && Object.keys(o).length) throw new Problem(path, "a manual desk takes no exit")
  if (!manual && !any) throw new Problem(path, "exit must include at least one of take_profit_pct, stop_loss_pct, max_hold_hours, exit_on_signal: true, ladder, or trailing")
  return x
}

function sizingOf(v: unknown): Sizing {
  const path = "sizing"
  const o = object(v, path)
  const s: Sizing = {
    usd_per_trade: number(o.usd_per_trade, join(path, "usd_per_trade"), { gt: 0 }),
    max_concurrent: number(o.max_concurrent, join(path, "max_concurrent"), { int: true, gte: 1 }),
  }
  const base = optionalNumber(o, "base_usd", path, { gt: 0 })
  if (base !== undefined) s.base_usd = base
  const max = optionalNumber(o, "max_usd", path, { gt: 0 })
  if (max !== undefined) s.max_usd = max
  if (o.rules !== undefined) {
    const at = join(path, "rules")
    s.rules = array(o.rules, at).map((r, i) => ruleOf(r, join(at, i)))
  }
  strict(o, ["usd_per_trade", "max_concurrent", "base_usd", "max_usd", "rules"], path)
  return s
}

function ruleOf(v: unknown, path: string): SizingRule {
  const o = object(v, path)
  const whenAt = join(path, "when")
  const w = object(o.when, whenAt)
  const when: RuleWhen = {}
  for (const [feature, bounds] of Object.entries(w)) {
    const at = join(whenAt, feature)
    if (!(FEATURES as readonly string[]).includes(feature)) throw new Problem(at, `Invalid enum value. Expected ${listed(FEATURES)}, received '${feature}'`)
    const b = object(bounds, at)
    const read: Partial<Record<RuleOp, number>> = {}
    for (const op of RULE_OPS) {
      const n = optionalNumber(b, op, at)
      if (n !== undefined) read[op] = n
    }
    strict(b, RULE_OPS, at)
    when[feature as Feature] = read
  }
  const rule: SizingRule = { when }
  const mult = optionalNumber(o, "mult", path, { gt: 0 })
  if (mult !== undefined) rule.mult = mult
  if (o.add !== undefined) {
    const add = number(o.add, join(path, "add"))
    if (!(add > 0)) throw new Problem(join(path, "add"), "add must be greater than 0")
    rule.add = add
  }
  if (o.skip !== undefined) {
    if (boolean(o.skip, join(path, "skip")) !== true) throw new Problem(join(path, "skip"), "skip must be true (write no rule instead of skip: false)")
    rule.skip = true
  }
  strict(o, ["when", "mult", "add", "skip"], path)
  const actions = [rule.mult, rule.add, rule.skip].filter((a) => a !== undefined).length
  if (actions !== 1) throw new Problem(path, "a sizing rule needs exactly one of mult, add or skip")
  return rule
}

// ---- What runs live ----

/** One field of a definition: whether a bot runs it, and if not, why. */
export interface LiveMark {
  path: string
  runs: boolean
  why?: string
}

/** The patterns whose signal is one wallet's, so its row names the wallet and its groups. */
const ONE_WALLET: readonly EntryPattern[] = ["deployer", "large_move", "dormancy", "intra_book", "new_ticker", "kol_mention"]
/** The patterns whose row says the trade's size in dollars. */
const HAS_USD: readonly EntryPattern[] = ["new_ticker", "large_move", "deployer"]
/** The patterns whose row says which way the tokens moved. */
const HAS_DIRECTION: readonly EntryPattern[] = ["large_move", "deployer", "intra_book"]

const BACKTEST_ONLY = "so this can be backtested, not run"

const SOURCE_WHY: Record<Exclude<EntrySource, "pattern">, string> = {
  trade_signal: `Hacc has no live read of its trade signals yet, ${BACKTEST_ONLY}.`,
  conviction: `Hacc has no live read of its conviction scores yet, ${BACKTEST_ONLY}.`,
  manual: `A manual desk is Hacc's lab's own, ${BACKTEST_ONLY}.`,
  levels: `A bot enters on Hacc's tape, ${BACKTEST_ONLY}. A trigger on a price level does this live.`,
  launch_fingerprint: `Hacc has no live read of launch fingerprints, ${BACKTEST_ONLY}.`,
  schedule: `A bot enters on Hacc's tape, ${BACKTEST_ONLY}. A trigger on a schedule does this live.`,
}

/**
 * Each field the definition sets, marked as run or refused with why. A bot runs only when every mark runs:
 * one that ran without a field it couldn't read would trade differently from its backtest, silently.
 */
export function liveMarks(d: Definition): LiveMark[] {
  const marks: LiveMark[] = []
  const run = (path: string) => marks.push({ path, runs: true })
  const refuse = (path: string, why: string) => marks.push({ path, runs: false, why })
  run("chain")
  if (!isEntryPattern(d.entry)) {
    refuse("entry.source", SOURCE_WHY[d.entry.source])
  } else {
    const { pattern } = d.entry
    run("entry.pattern")
    const f = d.entry.filters ?? {}
    const at = (k: keyof Filters) => `entry.filters.${k}`
    for (const k of ["min_mcap_usd", "max_mcap_usd", "min_age_minutes", "max_age_minutes", "venues", "exclude_venues", "hours_et"] as const) if (f[k] !== undefined) run(at(k))
    if (f.min_mcap_usd !== undefined && f.max_mcap_usd !== undefined && f.min_mcap_usd >= f.max_mcap_usd) refuse(at("max_mcap_usd"), "The market cap filters leave nothing between them, so it would never enter.")
    if (f.min_age_minutes !== undefined && f.max_age_minutes !== undefined && f.min_age_minutes >= f.max_age_minutes) refuse(at("max_age_minutes"), "The age filters leave nothing between them, so it would never enter.")
    if (f.wallet_ids !== undefined) run(at("wallet_ids"))
    for (const k of ["groups", "groups_all"] as const) {
      if (f[k] === undefined) continue
      if (ONE_WALLET.includes(pattern)) run(at(k))
      else refuse(at(k), `A ${pattern} signal's wallets carry no groups on Hacc's tape, so ${k} can't be checked live, ${BACKTEST_ONLY}.`)
    }
    if (f.min_group_wallets !== undefined) refuse(at("min_group_wallets"), `Hacc's tape doesn't say how many of a group's wallets are in a signal, so min_group_wallets can't be checked live, ${BACKTEST_ONLY}.`)
    if (f.min_usd !== undefined) {
      if (HAS_USD.includes(pattern)) run(at("min_usd"))
      else refuse(at("min_usd"), `A ${pattern} signal carries no dollar size on Hacc's tape, so min_usd can't be checked live, ${BACKTEST_ONLY}.`)
    }
    if (f.direction !== undefined) {
      if (HAS_DIRECTION.includes(pattern)) run(at("direction"))
      else refuse(at("direction"), `A ${pattern} signal doesn't say which way the tokens moved on Hacc's tape, so direction can't be checked live, ${BACKTEST_ONLY}.`)
    }
    if (f.min_score_1h !== undefined) refuse(at("min_score_1h"), `Hacc's tape carries no score, so min_score_1h can't be checked live, ${BACKTEST_ONLY}.`)
  }
  const x = d.exit ?? {}
  for (const k of ["take_profit_pct", "stop_loss_pct", "max_hold_hours", "trailing"] as const) if (x[k] !== undefined) run(`exit.${k}`)
  if (x.exit_on_signal === true) refuse("exit.exit_on_signal", `Hacc's replay hasn't shown what this exits on, ${BACKTEST_ONLY}.`)
  if (x.ladder !== undefined) refuse("exit.ladder", `Hacc hasn't documented how a ladder sells, ${BACKTEST_ONLY}.`)
  for (const k of ["usd_per_trade", "max_concurrent", "base_usd", "max_usd"] as const) if (d.sizing[k] !== undefined) run(`sizing.${k}`)
  d.sizing.rules?.forEach((r, i) => {
    const unread = Object.keys(r.when).filter((f) => f !== "mcap_at_entry")
    if (unread.length) refuse(`sizing.rules.${i}`, `There's no live read of ${unread.join(" or ")}, so a rule on it can be backtested, not run.`)
    else run(`sizing.rules.${i}`)
  })
  return marks
}

/** What stops a bot running: each refused field and why. Empty when the whole definition runs live. */
export function refusedLive(d: Definition): LiveMark[] {
  return liveMarks(d).filter((m) => !m.runs)
}

// ---- The hash ----

/** What a bot runs as, beside its definition: the person approves both on one card. */
export interface BotRunSettings {
  agent: string
  /** The paying wallet's address, or `embedded`. */
  wallet: string
  mode: "paper" | "live"
  /** Its own slippage bound, where it has one; the route's default otherwise. */
  maxSlippageBps?: number
}

/**
 * The hash a bot is approved as: canonical JSON of the definition and its run settings. A field written in
 * another order, or a number written another way, hashes the same; anything that changes what the bot does
 * doesn't. Its name isn't in it: renaming a bot changes nothing it does.
 */
export function botHash(d: Definition, run: BotRunSettings): string {
  return createHash("sha256")
    .update(canonicalJson({ definition: d, agent: run.agent, wallet: run.wallet, mode: run.mode, maxSlippageBps: run.maxSlippageBps ?? null }), "utf8")
    .digest("hex")
}

// ---- A tape trigger, promoted ----

export type EntryRead = { ok: true; chain: DefinitionChain; entry: PatternEntry } | { ok: false; message: string }

/**
 * A tape trigger's condition as a definition's chain and entry, so a trigger can become a bot. Its exits and
 * sizing are the bot's own, asked for when it's proposed. A trigger with no chain watches both, so its bot does.
 */
export function entryFromTape(when: TriggerWhen): EntryRead {
  if (when.kind !== "tape") return { ok: false, message: "Only a trigger on Hacc's tape can become a bot: a bot enters on the tape's signals." }
  if (!(ENTRY_PATTERNS as readonly string[]).includes(when.pattern)) {
    return { ok: false, message: `Hacc's lab doesn't enter on ${when.pattern} signals, so this trigger can't become a bot. It can stay a trigger.` }
  }
  const f: TapeFilters = when.filters
  const filters: Filters = {}
  if (f.minMcapUsd !== undefined) filters.min_mcap_usd = f.minMcapUsd
  if (f.maxMcapUsd !== undefined) filters.max_mcap_usd = f.maxMcapUsd
  if (f.minAgeMinutes !== undefined) filters.min_age_minutes = f.minAgeMinutes
  if (f.maxAgeMinutes !== undefined) filters.max_age_minutes = f.maxAgeMinutes
  if (f.group !== undefined) filters.groups = [f.group]
  return { ok: true, chain: f.chain ?? "any", entry: { source: "pattern", pattern: when.pattern as EntryPattern, filters } }
}
