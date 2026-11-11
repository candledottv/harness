// The Signals pane: Hacc's tape from the core's one socket (the `signals` topic), or the account's own
// rules' signals (`signals:mine`), newest first, one line each: the token, what happened in words, its
// dollar size, the wallet, and how long ago. Hacc's own summary isn't drawn: it carries emoji and sometimes
// a full mint. Every string arrives cleaned for the terminal by the core. A stretch the core couldn't read
// back is a gap row, drawn as one. When the tape can't show (Hacc off, a refused key, Hacc's stream full),
// it says why in a line.
//
// The Signals tab: at full width a row says more (the pattern in the Candle Harness's words, the
// wallets, the chain). Each tab keeps its own choice (the core's `views` topic): Hacc's tape or your rules,
// one pattern and one chain. A filtered tape is the core's rows that match plus what its read-back from
// Hacc found, and a filter that still matches nothing says over what span.
import { newKeyFix } from "../../shared/fix-words"
import { PATTERNS } from "../../core/hacc-tools"
import { matchesFilter, type ReadBackView, type SignalFilter, type StreamRow } from "../../core/signal-stream"
import type { SignalsChoice } from "../../core/view-state"
import { compactNumber, compactUsd, shortAddress, wrap } from "../format"
import { C, fit, shortDuration } from "../theme"
import { clock } from "./activity"
import { askAbout } from "../ask"
import { chip, type Line, line } from "./lines"
import type { ChainSlug } from "../../shared/chains"

/** The `hacc` topic as the core publishes it (core-main.ts): no keys and no rows. */
export interface HaccTopic {
  enabled: boolean
  agents: Record<string, { plan: string | null; key: "ok" | "refused"; why?: string }>
  stream: { state: string; words?: string; mine: { state: string; words?: string } }
}

/** A signals topic as this view holds it: oldest first, as the core sends them; filtered, its read-back and span. */
export interface SignalsHeld {
  rows: StreamRow[]
  back?: ReadBackView
  /** The oldest signal the core holds from the stream. */
  since?: string
}

/** A pane's choice, without where it is: what the pane draws and the subscription asks for. `folded`: its chain is the status bar's. */
export type SignalsPick = Omit<SignalsChoice, "at"> & { folded?: true }

/**
 * The Signals choice kept for `at` (a tab's name, or a popped pane's): the whole tape when none is. With `fold`, the
 * status bar's chain filter is on screen (the account uses more than one chain), and the pane's chain is its:
 * the chain the tab kept is set aside, and the pane's own chain chip doesn't show.
 */
export function signalsChoiceOf(choices: readonly SignalsChoice[] | undefined, at: string | undefined, fold?: { chain?: ChainSlug }): SignalsPick {
  const { at: _at, ...kept } = choices?.find((c) => c.at === at) ?? { at: "" }
  if (!fold) return kept
  const { chain: _kept, ...pick } = kept
  return { ...pick, ...(fold.chain ? { chain: fold.chain } : {}), folded: true }
}

/** The subscription's filter for a pick on Hacc's tape: undefined for the whole tape and for your rules. */
export function signalsFilter(pick: SignalsPick): SignalFilter | undefined {
  if (pick.mine || (!pick.pattern && !pick.chain)) return undefined
  return { ...(pick.pattern ? { pattern: [pick.pattern] } : {}), ...(pick.chain ? { chain: [pick.chain] } : {}) }
}

/** Each pattern Hacc sends, in the Candle Harness's words: its chip's label, and what the menu says it is. */
export const PATTERN_WORDS: Readonly<Record<(typeof PATTERNS)[number], { label: string; words: string }>> = {
  new_ticker: { label: "first buy", words: "a tracked wallet's first buy of a new ticker" },
  confluence: { label: "wallets together", words: "several tracked wallets buying the same token" },
  large_move: { label: "big move", words: "a large buy, sell or transfer" },
  dormancy: { label: "woke up", words: "a wallet moving after weeks or months still" },
  deployer: { label: "deployer", words: "a tracked deployer launching a token" },
  distribution: { label: "selling", words: "a wallet distributing what it holds" },
  intra_book: { label: "book move", words: "a token moving between tracked wallets" },
  kol_mention: { label: "mention", words: "a KOL posting about a token, and a buy" },
}
export const SIGNAL_PATTERNS: readonly string[] = PATTERNS
export const CHAIN_NAMES = { solana: "Solana", hood: "Hood" } as const

const patternLabel = (p: string): string => PATTERN_WORDS[p as keyof typeof PATTERN_WORDS]?.label ?? p.replace(/_/g, " ")

/** The chips on the pane's top border, in order: the pattern, the chain, and Hacc's tape or your rules. */
export type SignalsChipId = "pattern" | "chain" | "source"

/**
 * The chips on a top border `width` wide. A chip that's set always shows. The pattern and chain chips that
 * aren't show only where the whole title still fits beside them (as registry.ts's paneLines measures it),
 * so a narrow pane (the Cockpit's) keeps its title and rows as they were, and reaches them by the palette.
 * Your rules' signals have no chain or pattern chip: they're your rules already.
 */
export function signalsChips(pick: SignalsPick, width?: number): { id: SignalsChipId; text: string }[] {
  const source = { id: "source" as const, text: pick.mine ? "mine ▾" : "all ▾" }
  if (pick.mine) return [source]
  const pattern = { id: "pattern" as const, text: `${pick.pattern ? patternLabel(pick.pattern) : "pattern"} ▾`, set: !!pick.pattern }
  const chain = { id: "chain" as const, text: `${pick.chain ? CHAIN_NAMES[pick.chain] : "chain"} ▾`, set: !!pick.chain }
  const title = signalsTitle(pick).length
  // With the status bar's chain filter on screen, the chain is its, and the pane has no chain chip.
  let chips = pick.folded ? [pattern] : [pattern, chain]
  const fits = (list: typeof chips) => width === undefined || width - ([...list, source].map((c) => c.text).join("    ").length + 10) >= title
  if (!fits(chips)) chips = chips.filter((c) => c.set || c.id === "pattern")
  if (!fits(chips)) chips = chips.filter((c) => c.set)
  return [...chips.map(({ id, text }) => ({ id, text })), source]
}

/** The menu a chip opens: each row's value (null clears it), label and words, and which is on. */
export function signalsMenuRows(which: "pattern" | "chain", pick: SignalsPick): { value: string | null; label: string; words: string; on: boolean }[] {
  if (which === "chain") {
    return [
      { value: null, label: "both chains", words: "Solana and Hood", on: !pick.chain },
      ...(Object.keys(CHAIN_NAMES) as (keyof typeof CHAIN_NAMES)[]).map((c) => ({ value: c, label: CHAIN_NAMES[c], words: `only ${CHAIN_NAMES[c]}'s tokens`, on: pick.chain === c })),
    ]
  }
  return [
    { value: null, label: "every pattern", words: "the whole tape", on: !pick.pattern },
    ...SIGNAL_PATTERNS.map((p) => ({ value: p, label: patternLabel(p), words: PATTERN_WORDS[p as keyof typeof PATTERN_WORDS]?.words ?? p, on: pick.pattern === p })),
  ]
}

/** How many rows a view keeps of each signals topic: the core's snapshot is 100. */
export const SIGNAL_ROWS = 200

const isGap = (row: StreamRow): row is Extract<StreamRow, { kind: "gap" }> => (row as { kind?: unknown }).kind === "gap"
const keyOf = (row: StreamRow): string => (isGap(row) ? `gap:${row.id}` : String(row.id))

/** A snapshot replaces what's held; an event's rows join it, each once, in time order; a read-back's state and span are kept. */
export function heldSignals(was: SignalsHeld | undefined, data: unknown, snapshot: boolean): SignalsHeld {
  const d = (data ?? {}) as { rows?: unknown; back?: ReadBackView; since?: string }
  const rows = Array.isArray(d.rows) ? (d.rows as StreamRow[]) : []
  const extra = { ...(d.back ? { back: d.back } : {}), ...(typeof d.since === "string" ? { since: d.since } : {}) }
  if (snapshot || !was) return { rows: rows.slice(-SIGNAL_ROWS), ...extra }
  const seen = new Set(was.rows.map(keyOf))
  const fresh = rows.filter((r) => !seen.has(keyOf(r)))
  if (!fresh.length && !d.back) return was
  const all = [...was.rows, ...fresh].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  return { ...was, ...extra, rows: all.slice(-SIGNAL_ROWS) }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/** What happened, in a word or two, from the pattern and its payload (the shapes Hacc's tape was recorded sending). */
export function happened(row: Record<string, unknown>): string {
  const p = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>
  switch (row.pattern) {
    case "new_ticker":
      return "first buy"
    case "confluence": {
      const n = Array.isArray(p.wallets) ? p.wallets.length : undefined
      return n ? `${n} wallets` : "wallets"
    }
    case "large_move":
      return row.event_kind === "swap" ? (p.direction === "out" ? "big sell" : "big buy") : "big move"
    case "dormancy": {
      const days = num(p.dormant_days)
      return days !== undefined ? `woke ${Math.round(days)}d` : "woke up"
    }
    case "distribution":
      return "selling"
    case "deployer":
      return "deployer"
    case "intra_book":
      return "book move"
    case "kol_mention":
      return "mention"
    default:
      return fit(String(row.pattern ?? "signal").replace(/_/g, " "), 9)
  }
}

/** What happened, in a few words, for the wide row: the Candle Harness's own, from the pattern and its payload, never Hacc's summary. */
export function happenedWide(row: Record<string, unknown>): string {
  const p = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>
  switch (row.pattern) {
    case "new_ticker":
      return "first buy of a new ticker"
    case "confluence": {
      const n = Array.isArray(p.wallets) ? p.wallets.length : undefined
      const mins = num(p.window_minutes)
      return `${n ? `${n} wallets` : "wallets"} bought${mins ? ` in ${Math.round(mins)}m` : " together"}`
    }
    case "large_move":
      return row.event_kind === "swap" ? (p.direction === "out" ? "big sell" : "big buy") : "big transfer"
    case "dormancy": {
      const days = num(p.dormant_days)
      return days !== undefined ? `wallet woke after ${Math.round(days)}d` : "dormant wallet woke"
    }
    case "distribution":
      return "wallet distributing"
    case "deployer":
      return "deployer launched"
    case "intra_book":
      return p.direction === "out" ? "out to a tracked wallet" : "in from a tracked wallet"
    case "kol_mention": {
      const lag = num(p.lag_minutes)
      const after = lag !== undefined ? ` ${Math.round(lag)}m later` : ""
      return p.order === "post_then_buy" ? `posted, bought${after}` : p.order === "buy_then_post" ? `bought, posted${after}` : "mentioned on X"
    }
    default:
      return String(row.pattern ?? "signal").replace(/_/g, " ")
  }
}

/** The wallets, for the wide row: a mention's handle and following; several wallets' count and labels; else one wallet. */
function wallets(row: Record<string, unknown>, room: number): string {
  const p = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>
  if (row.pattern === "kol_mention" && str(p.handle)) {
    const followers = num(p.followers)
    return fit(`@${str(p.handle)}${followers !== undefined ? ` · ${compactNumber(followers)} followers` : ""}`, room)
  }
  if (Array.isArray(p.wallets) && p.wallets.length > 1) {
    const names = (p.wallets as Record<string, unknown>[]).map((w) => str(w.label) ?? (str(w.address) ? shortAddress(String(w.address)) : "?"))
    // As many names as fit, then how many more.
    let out = ""
    for (let i = 0; i < names.length; i++) {
      const rest = names.length - i - 1
      const next = `${out ? `${out}, ` : ""}${names[i]}`
      if (next.length + (rest ? ` +${rest}`.length : 0) > room) return fit(out ? `${out} +${names.length - i}` : `${names.length} wallets`, room)
      out = next
    }
    return out
  }
  return fit(who(row), room)
}

/** At least this wide, a signal takes the wide row (the Signals tab's full width). */
export const WIDE_SIGNALS = 80
/** The wide row's columns: the token, what happened, the size, the gap, the chain and the age; the wallets take what's left, up to WALLETS_MAX. */
const WIDE = { token: 10, what: 26, size: 7, gap: 2, chain: 8, age: 4 } as const
const WALLETS_MAX = 44

/** A signal's dollar size; Hacc's 0 on a launch is no size, so it isn't shown as "$0". */
const sizeOf = (r: Record<string, unknown>): number | undefined => {
  const usd = num((r.payload as Record<string, unknown> | undefined)?.usd_value)
  return usd !== undefined && usd > 0 ? usd : undefined
}

/**
 * The wide row: the token, what happened, the size, the wallets, the chain and the age, as a table read
 * left to right. The wallets stop at 44 cells, so the chain and the age stay near what they describe
 * rather than at the far edge of a wide terminal. Hacc's rows carry no token name, so the token is
 * its symbol; the token pane names it once picked.
 */
function wideLine(r: Record<string, unknown>, width: number, now: number): Line["segs"] {
  const symbol = str(r.asset_symbol) ?? (str(r.asset_address) ? `${String(r.asset_address).slice(0, 4)}…` : "?")
  const size = sizeOf(r)
  const chain = r.asset_chain === "hood" || r.wallet_chain === "hood" ? "Hood" : "Solana"
  const age = shortDuration(now - Date.parse(String(r.created_at)))
  const fixed = WIDE.token + WIDE.what + WIDE.size + WIDE.gap * 2 + WIDE.chain + WIDE.age
  // The wallets come last, in what's left, so a short one leaves its blank at the row's end, not before
  // the chain (a wide blank between the wallets and the chain at 172 columns read badly). What's left past
  // the widest the wallets take goes between the other columns, up to three cells each.
  const g = Math.max(0, Math.min(3, Math.floor((width - fixed - WALLETS_MAX) / 4)))
  const room = Math.max(6, width - fixed - g * 4)
  return [
    { text: fit(symbol, WIDE.token - 1).padEnd(WIDE.token + g), fg: C.hi },
    { text: fit(happenedWide(r), WIDE.what - 1).padEnd(WIDE.what + g), fg: C.ink },
    { text: (size !== undefined ? compactUsd(size) : "").padStart(WIDE.size), fg: C.hi },
    { text: `${" ".repeat(WIDE.gap + g)}${chain}`.padEnd(WIDE.chain + WIDE.gap + g), fg: C.dim },
    { text: age.padStart(WIDE.age), fg: C.dim },
    { text: `${" ".repeat(WIDE.gap + g)}${wallets(r, room)}`, fg: C.dim },
  ]
}

/** Who: a mention's handle, else the wallet's label, Hacc's display label, or its short address. */
function who(row: Record<string, unknown>): string {
  const p = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>
  if (row.pattern === "kol_mention" && str(p.handle)) return `@${str(p.handle)}`
  const label = str(row.wallet_label) ?? str(row.display_label)?.replace(/^"(.+)" on .+$/, "$1")
  return label ?? (str(row.wallet_address) ? shortAddress(String(row.wallet_address)) : "")
}

/**
 * One line a signal. The token, what happened and the age always show; the dollar size from 29 cells (room
 * for it, a space and a three-character age: "13s" was cut to "1…" at 27), and the wallet in
 * what's left, when that's 6 cells or more.
 */
export function signalLine(row: StreamRow, width: number, now: number): Line {
  if (isGap(row)) {
    const text = `─ ${clock(row.from)} to ${clock(row.to)} not read back: ${row.words}`
    return { segs: [{ text: fit(text, width), fg: C.dim }], key: keyOf(row) }
  }
  const r = row as Record<string, unknown>
  if (width >= WIDE_SIGNALS) return withPick(r, wideLine(r, width, now), now)
  // No symbol: the mint's first four, which fit the column whole (live: "GTuk…p…" from a cut short address).
  const symbol = str(r.asset_symbol) ?? (str(r.asset_address) ? `${String(r.asset_address).slice(0, 4)}…` : "?")
  const size = sizeOf(r)
  const age = shortDuration(now - Date.parse(row.created_at))
  const segs: Line["segs"] = [
    // Seven cells and a space: an eight-letter symbol ran into what happened ("hypecoindeployer", live).
    { text: fit(symbol, 7).padEnd(8), fg: C.hi },
    { text: happened(r).padEnd(10), fg: C.ink },
    ...(width >= 29 ? [{ text: (size !== undefined ? compactUsd(size) : "").padStart(6), fg: C.hi }] : []),
  ]
  const used = segs.reduce((n, s) => n + s.text.length, 0)
  const room = width - used - age.length - 3
  const wallet = room >= 6 ? fit(who(r), room) : ""
  segs.push({ text: (wallet ? `  ${wallet}` : "").padEnd(Math.max(1, width - used - age.length)), fg: C.dim }, { text: age, fg: C.dim })
  return withPick(r, segs, now)
}

/** A signal's line from its segments: its key, and its token's pick and question. */
function withPick(r: Record<string, unknown>, segs: Line["segs"], now: number): Line {
  const key = keyOf(r as StreamRow)
  const mint = str(r.asset_address)
  if (!mint) return { segs, key }
  const size = sizeOf(r)
  const age = shortDuration(now - Date.parse(String(r.created_at)))
  // The question names what happened in the Candle Harness's own words, never Hacc's summary, labels or handles.
  const ask = askAbout(str(r.asset_symbol), mint, `From Signals: ${happened(r).trim()}${size !== undefined ? `, ${compactUsd(size)}` : ""}, ${age} ago.`)
  return { segs, key, pick: { id: key, mint, chain: r.asset_chain === "hood" ? "hood" : "solana", ask } }
}

/** Why the tape isn't showing, when it isn't: Hacc off, no key it takes, its stream full, or the plan for `mine`. */
function stateLines(hacc: HaccTopic | undefined, mine: boolean, width: number): Line[] {
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width)).map((t) => line(t, fg))
  if (!hacc) return []
  if (!hacc.enabled) return say("Hacc's data is off in this Candle Harness's config ([hacc] enabled = false).")
  const refused = Object.entries(hacc.agents).filter(([, a]) => a.key === "refused")
  if (refused.length > 0 && refused.length === Object.keys(hacc.agents).length) {
    const [agent, a] = refused[0]!
    // The core's words are a sentence already (hacc.ts: who, Hacc's reason, and which keys Hacc takes), then
    // the doctor's own fix, rather than only saying that the doctor knows it.
    return [...say(a.why ?? `Hacc refused ${agent}'s key.`, C.look), ...say(newKeyFix(agent).replaceAll("`", ""))]
  }
  if (mine) {
    const m = hacc.stream.mine
    if (m.state === "needs-plan") return say("Your own rules' signals need Pro or Max on Hacc.")
    if (m.state === "failing" || m.state === "no-key") return say(m.words ?? "Your own rules' signals didn't load. The core tries again every 30 s.")
    return []
  }
  const s = hacc.stream
  if (s.state === "full" || s.state === "no-key") return say(s.words ?? "Hacc's stream isn't open. The core tries again every 30 s.")
  if (s.state === "reconnecting" && s.words) return say(s.words)
  return []
}

/** The filter in words: "dormancy signals on Hood", or undefined for none. */
function filterWords(pick: SignalsPick): string | undefined {
  if (!pick.pattern && !pick.chain) return undefined
  return `${pick.pattern ? `${patternLabel(pick.pattern)} signals` : "signals"}${pick.chain ? ` on ${CHAIN_NAMES[pick.chain]}` : ""}`
}

/** The pane's title: which signals. A filter isn't in it: its chips, which always show once set, say it. */
export function signalsTitle(pick: SignalsPick | boolean): string {
  const mine = typeof pick === "boolean" ? pick : !!pick.mine
  return mine ? "Signals · your rules" : "Signals · Hacc's tape"
}

/** The `clear filters` chip's line: its ref is what app.tsx's act runs. */
export const CLEAR_FILTERS = "clear"

/**
 * A filter that matches nothing says over what span it looked: the core's own rows since the oldest it
 * holds, and Hacc's tape when its read-back answered. With a chip to clear it.
 */
function emptyFilterLines(held: SignalsHeld | undefined, pick: SignalsPick, width: number): Line[] {
  const what = filterWords(pick)!
  const since = held?.since ? ` since ${clock(held.since)}` : ""
  const back = held?.back
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width)).map((t) => line(t, fg))
  // While the read-back is out, the pane says it's looking, not that there are none ("No … signals"
  // showed for the second or two before the rows came).
  const words = !back
    ? `Reading Hacc's tape back for ${what}…`
    : back.ok
      ? back.rows === 0
        ? `No ${what} on Hacc's tape, nor in what the core has heard${since}.`
        : `No ${what}${since}.`
      : `No ${what}${since} in what the core has heard. Hacc's read-back didn't answer (${(back.words ?? "no words").replace(/\.$/, "")}); it's asked again when you pick the filter, at most once a minute.`
  return [...say(words), line(""), { segs: [chip("clear filters", "signals")], ref: CLEAR_FILTERS }]
}

export function signalsLines(held: SignalsHeld | undefined, opts: { hacc: HaccTopic | undefined; mine?: boolean; pick?: SignalsPick; width: number; now: number }): Line[] {
  const pick: SignalsPick = opts.pick ?? (opts.mine ? { mine: true } : {})
  const mine = !!pick.mine
  // Your rules' signals aren't filtered by the tape's pattern and chain, which have no chips there (they're
  // your rules already); the choice keeps them for when it's back on the tape. The tape comes filtered from the core.
  const filter = mine ? undefined : signalsFilter(pick)
  const rows = (held?.rows ?? []).filter((r) => matchesFilter(r, filter))
  const head = stateLines(opts.hacc, mine, opts.width)
  if (rows.length === 0) {
    if (head.length) return head
    if (filter && held) return emptyFilterLines(held, pick, opts.width)
    return [line(held ? (mine ? "None of your rules has fired yet." : "No signals yet: Hacc's tape shows here as it arrives.") : "Reading Hacc's tape…", C.dim)]
  }
  return [...head, ...rows.toReversed().map((r) => signalLine(r, opts.width, opts.now))]
}

/** What `view.signals` is sent for a change to the choice at `at`: the whole choice, each filter kept unless changed. */
export function signalsParams(at: string, was: SignalsPick, change: { mine?: boolean; pattern?: string | null; chain?: ChainSlug | null }): Record<string, unknown> {
  const mine = change.mine ?? !!was.mine
  const pattern = change.pattern === undefined ? (was.pattern ?? null) : change.pattern
  const chain = change.chain === undefined ? (was.chain ?? null) : change.chain
  return { at, mine, pattern, chain }
}
