// Research's panes: one token in depth, the linked one, from the core's
// `research` topic (research-reads.ts). Each reads only while it's on screen.
//   - Check: Candle's whole token check, a line for each flag in words, then the mint, the sell probe, the
//     holders, the dev wallet, liquidity and age, with Hacc's stage and holder figures. Amber only for a flag.
//   - Traders: Hacc's top traders on it over 24 hours, realised and unrealised, with labels and @handles,
//     each address short with ⧉.
//   - Its signals: Hacc's tape for this token, newest first, in Signals' words (signals.tsx).
//   - Mentions: posts on X by the accounts Hacc follows, newest first, each author and age, the text as data.
// Every string arrives cleaned by the core. ctrl-t's questions are the Candle Harness's own words (ask.ts): never a
// label, a handle or a post's text.
import type { CandleCheck, HaccFacts, Mentions, Part, ResearchPart, ResearchView, TraderRow } from "../../core/research-reads"
import type { SignalRow } from "../../core/signal-stream"
import type { PaneId } from "../../shared/panes"
import { askSymbol } from "../ask"
import { compactNumber, compactUsd, shortAddress, wrap } from "../format"
import { C, fit } from "../theme"
import { clock } from "./activity"
import { since } from "./feed"
import { chip, type Line, line } from "./lines"
import { signalLine, WIDE_SIGNALS } from "./signals"

/** Words as a sentence: Hacc's and the core's come with or without their full stop, and "nothing to show It's read again" doesn't read. */
const sentence = (words: string) => (/[.!?]$/.test(words.trim()) ? words.trim() : `${words.trim()}.`)

/** Research's panes, and the part of the `research` topic each shows. */
export const RESEARCH_PANES = { check: "check", traders: "traders", "token-signals": "signals", mentions: "mentions" } as const satisfies Partial<Record<PaneId, ResearchPart>>
export type ResearchPane = keyof typeof RESEARCH_PANES
export const isResearchPane = (id: PaneId): id is ResearchPane => id in RESEARCH_PANES

/** The parts a layout's panes show, for the view's `research` subscription. */
export function researchParts(panes: readonly PaneId[]): ResearchPart[] {
  return [...new Set(panes.filter(isResearchPane).map((p) => RESEARCH_PANES[p]))]
}

const NAMES: Record<ResearchPane, string> = { check: "Check", traders: "Traders", "token-signals": "Its signals", mentions: "Mentions" }

/** The token's name as a title says it. */
const symbolOf = (view: ResearchView | undefined): string | undefined => (view?.token ? askSymbol(view.token.symbol, view.token.mint) : undefined)

/** A pane's title: what it is, and for which token; Traders' span is Hacc's 24 hours. */
export function researchTitle(id: ResearchPane, view: ResearchView | undefined): string {
  const sym = symbolOf(view)
  if (!sym) return NAMES[id]
  if (id === "traders") return `Traders · ${sym} · 24h`
  if (id === "token-signals") {
    const n = view?.signals?.data?.length
    return `Its signals · ${sym}${n ? ` · ${n}` : ""}`
  }
  return `${NAMES[id]} · ${sym}`
}

const say = (text: string, width: number, fg: string = C.dim): Line[] => wrap(text, Math.max(10, width)).map((t) => line(t, fg))

/** Before a token, nothing to read: what the pane will show. */
function noToken(id: ResearchPane, width: number): Line[] {
  const what: Record<ResearchPane, string> = {
    check: "The linked token's whole check shows here: its flags, mint, sell probe, holders, dev wallet, liquidity and age.",
    traders: "Hacc's top traders on the linked token show here, with their P&L.",
    "token-signals": "Hacc's signals on the linked token show here.",
    mentions: "Posts about the linked token on X, by the accounts Hacc follows, show here.",
  }
  return [...say(what[id], width), line(""), ...say("Pick a token in any list, or ask the agent about one.", width)]
}

/**
 * A part's state where it has nothing to draw: why it can't be read, still reading, or failed. Undefined
 * when it has data. A failed read with data from before keeps it, and says so under it (`failedLine`).
 */
function partState<T>(part: Part<T> | undefined, reading: string, width: number): Line[] | undefined {
  if (!part || (part.at === null && !part.cant)) return say(reading, width)
  if (part.cant) return say(part.cant, width)
  if (part.data === null) return say(`${sentence(part.failed?.words ?? "Hacc didn't answer")} It's read again within a minute.`, width, C.look)
  return undefined
}

/** Under a part's rows: a read that failed since, with when the rows were read. */
function failedLine<T>(part: Part<T>, width: number): Line[] {
  return part.failed && part.data !== null ? say(`The last read failed (${part.failed.words}); these are from ${part.at !== null ? clock(new Date(part.at).toISOString()) : "before"}.`, width) : []
}

// ---------------------------------------------------------------------------------------------------------
// Check.

/** Candle's names for its checks, in words. */
const FLAG_WORDS: Readonly<Record<string, string>> = {
  mintAuthority: "mint authority",
  freezeAuthority: "freeze authority",
  tokenExtensions: "token extensions",
  lpLock: "LP lock",
  sellability: "sellability",
  liquidityDrain: "liquidity drain",
}
export const flagWords = (name: string): string => FLAG_WORDS[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()

/** The label column, then its value: a row of Check. */
const LABEL = 17
function row(label: string, segs: Line["segs"], width: number): Line {
  const room = Math.max(1, width - LABEL)
  let left = room
  const cut = segs.map((s) => {
    const text = fit(s.text, Math.max(0, left))
    left -= text.length
    return { ...s, text }
  })
  return { segs: [{ text: fit(label, LABEL - 1).padEnd(LABEL), fg: C.dim }, ...cut.filter((s) => s.text.length > 0)] }
}

/** A token's age: minutes to days, then years past one. */
const age = (at: number, now: number): string => (now - at >= 365 * 86_400_000 ? `${((now - at) / (365 * 86_400_000)).toFixed(1)} years` : since(at, now))

/** Over what span: since a date a day or more back, else the last few minutes or hours. */
const spanWords = (from: number | undefined, now: number): string => (from === undefined ? "" : now - from >= 86_400_000 ? ` since ${new Date(from).toISOString().slice(0, 10)}` : ` in the last ${since(from, now)}`)

const plural = (n: number, one: string, many = `${one}s`) => `${compactNumber(n)} ${n === 1 ? one : many}`

/** Small counts in words, as the token pane says "all six checks clear". */
const COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]

/** The check's headline, wrapped: a narrow pane cut "which isn't clean" off. */
function summaryLines(c: CandleCheck, width: number): Line[] {
  const flagged = c.flags.filter((f) => f.status === "flagged").map((f) => flagWords(f.name))
  const unknown = c.flags.filter((f) => f.status === "unknown").map((f) => flagWords(f.name))
  if (c.summary === "flagged") return say(`⚑ flagged: ${flagged.join(", ")}`, width, C.look)
  if (c.summary === "clear") return say(`✓ no flags: all ${COUNTS[c.flags.length] ?? c.flags.length} checks clear`, width, C.good)
  if (c.summary === "not_applicable") return say("check not applicable (a base asset)", width)
  return say(`${c.summary}${unknown.length ? `: ${unknown.join(", ")} unknown (not clean)` : ""}`, width, C.ink)
}

/** A flag's line: its status, and its value where it adds a word ("sellable"). */
function flagLine(f: CandleCheck["flags"][number], width: number): Line {
  const fg = f.status === "flagged" ? C.look : f.status === "clear" ? C.ink : C.dim
  // A word worth adding ("sellable"), not a bare count Candle keeps for itself.
  const value = f.value && f.value !== f.status && !/^[\d.]+$/.test(f.value) ? ` · ${f.value}` : ""
  return row(flagWords(f.name), [{ text: `${f.status === "flagged" ? "⚑ flagged" : f.status}${value}`, fg }], width)
}

function mintLine(m: NonNullable<CandleCheck["mint"]>, width: number): Line[] {
  const parts: Line["segs"] = []
  if (m.program) parts.push({ text: m.program, fg: C.ink })
  if (m.renounced !== undefined) parts.push({ text: `${parts.length ? " · " : ""}${m.renounced ? "renounced" : "not renounced"}`, fg: C.ink })
  if (m.extensions.length) parts.push({ text: ` · ${m.extensions.join(", ")}`, fg: m.risks.length ? C.look : C.ink })
  const out = parts.length ? [row("mint", parts, width)] : []
  // Who can still mint or freeze: the authority's address, short, which is what the flag means.
  out.push(row("can mint more", [{ text: m.mintAuthority ? `yes: ${shortAddress(m.mintAuthority)}` : "no", fg: m.mintAuthority ? C.look : C.ink }], width))
  out.push(row("can freeze", [{ text: m.freezeAuthority ? `yes: ${shortAddress(m.freezeAuthority)}` : "no", fg: m.freezeAuthority ? C.look : C.ink }], width))
  if (m.risks.length) out.push(row("extension risks", [{ text: m.risks.join(", "), fg: C.look }], width))
  return out
}

function probeLine(p: NonNullable<CandleCheck["sellProbe"]>, width: number, now: number): Line {
  const size = p.usd !== undefined ? `$${compactNumber(p.usd)}` : "a"
  const when = p.at !== undefined ? ` · ${since(p.at, now)} ago` : ""
  if (p.routable === false) return row("sell probe", [{ text: `${size} sell didn't route${p.reason ? `: ${p.reason}` : ""}${when}`, fg: C.look }], width)
  if (p.routable === null) return row("sell probe", [{ text: `not run${when}`, fg: C.dim }], width)
  const cost = p.roundTripBps !== undefined ? ` · round trip ${(p.roundTripBps / 100).toFixed(1)}%` : p.impactBps !== undefined ? ` · impact ${(p.impactBps / 100).toFixed(1)}%` : ""
  return row("sell probe", [{ text: `${size} sell routed${cost}`, fg: C.ink }, { text: when, fg: C.dim }], width)
}

function devLine(d: NonNullable<CandleCheck["dev"]>, width: number, shownInFull: string | undefined): Line[] {
  const record =
    d.verdict === "first_launch" || d.priorLaunches === 0
      ? "first launch"
      : d.priorLaunches !== undefined
        ? `${plural(d.priorLaunches, "launch", "launches")} before${d.graduated !== undefined ? `, ${compactNumber(d.graduated)} graduated` : ""}${d.died !== undefined ? `, ${compactNumber(d.died)} died` : ""}`
        : (d.verdict?.replace(/_/g, " ") ?? "")
  const l = row("dev wallet", [{ text: shortAddress(d.address), fg: C.ink }, { text: " ", fg: C.ink }, chip("⧉", "copy"), { text: record ? ` ${record}` : "", fg: C.dim }], width)
  return [{ ...l, ref: d.address }, ...(shownInFull === d.address ? say(d.address, width, C.hi) : [])]
}

function haccLines(h: HaccFacts, width: number, now: number): Line[] {
  const out: Line[] = []
  if (h.holders !== undefined || h.top10Pct !== undefined) {
    const holders = h.holders !== undefined ? compactNumber(h.holders) : ""
    const top = h.top10Pct !== undefined ? `top 10 hold ${h.top10Pct.toFixed(0)}%` : ""
    out.push(row("holders", [{ text: [holders, top].filter(Boolean).join(" · "), fg: h.top10Pct !== undefined && h.top10Pct >= 50 ? C.hi : C.ink }], width))
  }
  // Hacc's own figure, said as Hacc's: the token pane's "liq" is Candle's market read, and the two can differ widely.
  out.push(row("liquidity", h.liquidityUsd !== undefined ? [{ text: compactUsd(h.liquidityUsd), fg: C.ink }, { text: " on Hacc", fg: C.dim }] : [{ text: h.stage === "bonding_curve" ? "on the curve, no pool yet" : "—", fg: C.ink }], width))
  if (h.createdAt !== undefined) out.push(row("age", [{ text: age(h.createdAt, now), fg: C.ink }], width))
  const stage = h.stage === "bonding_curve" ? `on ${h.launchpad ?? "its launchpad"}'s curve${h.progress !== undefined ? `, ${Math.floor(h.progress * 100)}% along` : ""}` : h.stage === "migrated" ? "graduated" : h.stage?.replace(/_/g, " ")
  if (stage) out.push(row("stage", [{ text: stage, fg: C.ink }], width))
  return out
}

export function checkLines(view: ResearchView | undefined, opts: { width: number; now: number; shownInFull?: string }): Line[] {
  const { width, now } = opts
  if (!view?.token) return noToken("check", width)
  const c = view.check
  const candle = c?.candle
  const out: Line[] = []
  if (!candle || (candle.at === null && candle.data === null)) out.push(...say("Reading Candle's check…", width))
  else if (!candle.data) out.push(...say(`Candle's check didn't load (${candle.failed?.words ?? "no answer"}): unchecked, not clean.`, width, C.look))
  else {
    const d = candle.data
    out.push(...summaryLines(d, width))
    for (const f of d.flags) out.push(flagLine(f, width))
    if (d.mint) out.push(...mintLine(d.mint, width))
    if (d.sellProbe) out.push(probeLine(d.sellProbe, width, now))
    if (d.dev) out.push(...devLine(d.dev, width, opts.shownInFull))
  }
  const h = c?.hacc
  if (h?.data) out.push(...haccLines(h.data, width, now))
  else if (h?.cant) out.push(...say(h.cant, width))
  else if (h?.failed) out.push(...say(`Hacc's holders and age didn't load (${h.failed.words.replace(/\.$/, "")}).`, width))
  else out.push(...say("Reading Hacc's holders and age…", width))
  const unchecked = candle?.data?.unchecked ?? []
  if (unchecked.length) out.push(...say(`Not checked: ${unchecked.map((u) => u.replace(/_/g, " ")).join(", ")}. Unknown, not clean.`, width))
  // Where each figure is from, and when.
  const when = [candle?.data && candle.at !== null ? `Candle ${clock(new Date(candle.at).toISOString())}` : "", h?.data && h.at !== null ? `Hacc ${clock(new Date(h.at).toISOString())}` : ""].filter(Boolean)
  if (when.length) out.push(...say(`read: ${when.join(" · ")}`, width))
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Traders.

/** A P&L figure: signed, and under half a dollar it's $0, unsigned. */
const signedUsd = (n: number | undefined): string => (n === undefined ? "—" : Math.abs(n) < 0.5 ? "$0" : `${n > 0 ? "+" : "-"}${compactUsd(Math.abs(n))}`)
const tone = (n: number | undefined): string => (n === undefined || Math.abs(n) < 0.5 ? C.dim : n > 0 ? C.good : C.bad)

/** The columns: the wallet with its ⧉, realised and unrealised; the name in what's left, from 8 cells. */
const WALLET = 13
const FIGURE = 9

export function traderLines(view: ResearchView | undefined, opts: { width: number; now: number; shownInFull?: string }): Line[] {
  const { width } = opts
  if (!view?.token) return noToken("traders", width)
  const part = view.traders
  const state = partState(part, "Reading Hacc's top traders…", width)
  if (state) return state
  const rows = part!.data as TraderRow[]
  const sym = symbolOf(view)!
  if (rows.length === 0) return [...say(`Hacc has no traders on ${sym} in the last 24 hours.`, width), ...failedLine(part!, width)]
  // Unrealised only where both figures fit beside the wallet.
  const both = width >= WALLET + FIGURE * 2
  const nameRoom = width - WALLET - FIGURE * (both ? 2 : 1) - 2
  const head = `${"wallet".padEnd(WALLET)}${"realised".padStart(FIGURE)}${both ? "unreal.".padStart(FIGURE) : ""}`
  const out: Line[] = [line(fit(head, width), C.dim)]
  for (const t of rows) {
    const name = t.label ?? (t.handle ? `@${t.handle}` : t.tracked ? "tracked" : "")
    const segs: Line["segs"] = [
      { text: shortAddress(t.address), fg: C.ink },
      { text: " ", fg: C.ink },
      chip("⧉", "copy"),
      // No empty segment: drawn, an empty text still takes a cell, and the columns slip.
      ...(shortAddress(t.address).length + 4 < WALLET ? [{ text: " ".repeat(WALLET - shortAddress(t.address).length - 4), fg: C.ink }] : []),
      { text: signedUsd(t.realizedUsd).padStart(FIGURE), fg: tone(t.realizedUsd) },
      ...(both ? [{ text: signedUsd(t.unrealizedUsd).padStart(FIGURE), fg: tone(t.unrealizedUsd) }] : []),
      ...(nameRoom >= 8 && name ? [{ text: `  ${fit(name, nameRoom)}`, fg: C.dim }] : []),
    ]
    // A wallet has no token to pick: ↑/↓ highlight it, and ctrl-t asks about it by its full address, since
    // the agent isn't told a wallet the way it's told a picked token (the Candle Harness's words: no label or handle).
    const trades = t.trades !== undefined ? `, ${plural(t.trades, "trade")}` : ""
    const ask = `What do you make of the wallet ${t.address}, one of ${sym}'s top traders? From Research: ${signedUsd(t.realizedUsd)} realised, ${signedUsd(t.unrealizedUsd)} unrealised${trades} in 24h.`
    out.push({ segs, ref: t.address, pick: { id: t.address, mint: "", ask } })
    if (opts.shownInFull === t.address) out.push(...say(t.address, width, C.hi))
  }
  return [...out, ...failedLine(part!, width)]
}

// ---------------------------------------------------------------------------------------------------------
// Its signals and Mentions.

export function tokenSignalLines(view: ResearchView | undefined, opts: { width: number; now: number }): Line[] {
  const { width, now } = opts
  if (!view?.token) return noToken("token-signals", width)
  const part = view.signals
  const state = partState(part, "Reading Hacc's signals on it…", width)
  if (state) return state
  const rows = part!.data as SignalRow[]
  if (rows.length === 0) return [...say(`No signals on Hacc's tape for ${symbolOf(view)}: none of Hacc's tracked wallets has done anything with it that Hacc flags.`, width), ...failedLine(part!, width)]
  return [...runs(rows.toReversed().map((r) => withoutToken(r, width, now)), width), ...failedLine(part!, width)]
}

/**
 * Rows in a row that say the same thing by the same wallets, one line with how many (30 rows can all be one
 * wallet's "book move", and the pane would say one thing 30 times). The newest's age stands.
 */
function runs(lines: Line[], width: number): Line[] {
  // A row's age is never what makes it the same; the count goes on its wallets, last or just before the age.
  const ageAt = (l: Line) => l.segs.findLastIndex((g) => /^\s*\d+[smhd]\s*$/.test(g.text))
  const same = (l: Line) => l.segs.filter((_, i) => i !== ageAt(l)).map((g) => g.text).join("")
  const out: { line: Line; n: number }[] = []
  for (const l of lines) {
    const last = out.at(-1)
    if (last && l.segs.length > 1 && same(last.line) === same(l)) last.n++
    else out.push({ line: l, n: 1 })
  }
  return out.map(({ line: l, n }) => {
    if (n === 1) return l
    const age = ageAt(l)
    const at = age === l.segs.length - 1 ? age - 1 : l.segs.length - 1
    const seg = l.segs[at]!
    const tag = ` ×${n}`
    const base = seg.text.trimEnd()
    // A padded column keeps its width and a cell before the age after it; the row's last takes what it needs.
    const room = at === l.segs.length - 1 ? width - l.segs.slice(0, -1).reduce((n, g) => n + g.text.length, 0) : seg.text.length - 1
    const text = (base.length + tag.length <= room ? `${base}${tag}` : `${base.slice(0, Math.max(0, room - tag.length - 1))}…${tag}`).padEnd(at === l.segs.length - 1 ? 0 : seg.text.length)
    return { ...l, segs: l.segs.map((g, i) => (i === at ? { ...g, text } : g)) }
  })
}

/**
 * A signal in Signals' words, without its token column: every row here is the same token. The row is drawn
 * that much wider and the column dropped, so the rest keeps Signals' own widths (wide from 80 cells).
 */
function withoutToken(row: SignalRow, width: number, now: number): Line {
  const column = width + WIDE_TOKEN >= WIDE_SIGNALS ? WIDE_TOKEN : NARROW_TOKEN
  const l = signalLine(row, width + column, now)
  return { ...l, segs: l.segs.slice(1) }
}
/** Signals' token column, wide and narrow (signals.tsx). */
const WIDE_TOKEN = 10
const NARROW_TOKEN = 8

const POST_LINES = 3

export function mentionLines(view: ResearchView | undefined, opts: { width: number; now: number }): Line[] {
  const { width, now } = opts
  if (!view?.token) return noToken("mentions", width)
  const part = view.mentions
  const state = partState(part, "Reading who's posting about it…", width)
  if (state) return state
  const m = part!.data as Mentions
  const sym = symbolOf(view)!
  const span = spanWords(m.from, now)
  if (m.rows.length === 0) return [...say(`No posts about ${sym} by the accounts Hacc follows on X${span}.`, width), ...failedLine(part!, width)]
  const latest = m.rows[0]!
  const ask = `What do you make of the posts about ${sym} on X? From Research: ${plural(m.accounts ?? new Set(m.rows.map((r) => r.handle)).size, "account")} Hacc follows posted, the latest ${since(latest.at, now)} ago.`
  const out: Line[] = [...say(`${plural(m.rows.length, "post")} by ${plural(m.accounts ?? new Set(m.rows.map((r) => r.handle)).size, "account")} Hacc follows${span}:`, width)]
  for (const r of m.rows) {
    const id = `${r.handle}:${r.at}`
    const who: Line["segs"] = [
      { text: fit(`@${r.handle}`, Math.max(4, width - 18)), fg: C.hi },
      // The age first, so a narrow pane cuts the following, not when it was posted.
      { text: ` · ${since(r.at, now)}${r.followers !== undefined ? ` · ${compactNumber(r.followers)}` : ""}${r.repost ? " · repost" : ""}`, fg: C.dim },
    ]
    out.push({ segs: who, pick: { id, mint: "", ask } })
    // The post's text is Hacc's data: drawn dim, a few lines at most, never put in a question.
    if (r.text) {
      const lines = wrap(r.text, Math.max(10, width - 2))
      for (const t of lines.slice(0, POST_LINES)) out.push(line(`  ${t}`, C.dim))
      if (lines.length > POST_LINES) out.push(line("  …", C.dim))
    }
  }
  return [...out, ...failedLine(part!, width)]
}
