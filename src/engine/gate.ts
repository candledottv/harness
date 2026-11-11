// The address gate. Before a reply that names a token reaches the
// user, every address in it is checked against the addresses the turn's tool results actually showed.
// Each one passes labelled with the most trusted source that saw it, or is flagged unknown: an agent
// that invents or mistypes an address is caught by the harness, not by hoping the prompt holds.

import { addressKey as keyOf } from "../shared/address-key"
import { terminalText } from "../shared/terminal-text"
import { EVM_ADDRESS_SOURCE, SOLANA_ADDRESS_SOURCE } from "../shared/chains"

/** Where an address was seen. "you": the person's own message this turn, which no tool vouches for. */
export type Source = "candle" | "hacc" | "web" | "shell" | "file" | "you"
export type SeenValue = { value: string; source: Source }
export type GateResult = { ok: boolean; labelled: { address: string; source: Source }[]; unknown: string[] }

/** Most trusted first. */
const RANK: Record<Source, number> = { candle: 0, hacc: 1, web: 2, shell: 3, file: 4, you: 5 }

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const BASE58_WORD = new RegExp(`^${SOLANA_ADDRESS_SOURCE}$`)
// Whole words only: an address glued to letters or digits on either side is part of something else
// (a longer id, a hash), not an address.
const WORD = /[0-9A-Za-z]+/g
const EVM = new RegExp(`(?<![0-9A-Za-z])${EVM_ADDRESS_SOURCE}(?![0-9A-Za-z])`, "g")

/** Bytes a base58 string decodes to: one zero byte per leading "1", then the number's own bytes. */
function base58Length(s: string): number {
  let zeros = 0
  while (s[zeros] === "1") zeros++
  let n = 0n
  for (const ch of s.slice(zeros)) n = n * 58n + BigInt(BASE58.indexOf(ch))
  let bytes = 0
  while (n > 0n) {
    n >>= 8n
    bytes++
  }
  return zeros + bytes
}


/** Every address in `text`, Solana (base58 words that decode to exactly 32 bytes) and EVM, in order of
 *  appearance, each spelling once: an EVM address written in two cases is there twice. */
export function addressSpellings(text: string): string[] {
  const found: { at: number; address: string }[] = []
  for (const m of text.matchAll(EVM)) found.push({ at: m.index, address: m[0] })
  for (const m of text.matchAll(WORD)) {
    const word = m[0]
    if (BASE58_WORD.test(word) && base58Length(word) === 32) found.push({ at: m.index, address: word })
  }
  found.sort((a, b) => a.at - b.at)
  return [...new Set(found.map((f) => f.address))]
}

/** Solana addresses and EVM addresses, deduplicated (an EVM address by any case), in order of appearance. */
export function extractAddresses(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const address of addressSpellings(text)) {
    const key = keyOf(address)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(address)
  }
  return out
}

// A word with Markdown's emphasis or code markers inside it: the pane draws it with them gone.
const MARKED_WORD = /[0-9A-Za-z]+(?:[*`]+[0-9A-Za-z]+)+/g

/**
 * An agent's reply as it's checked, shown and kept: cleaned to draw safely, and with any joiner between two
 * ASCII letters or digits taken out. The cleaner keeps the joiners for emoji and scripts, but inside an
 * address one draws as nothing and splits the word the gate reads, so an address no tool showed would
 * pass unchecked while the screen shows it whole. Markdown's `*` and backtick markers do the same: the
 * pane drops them (`A**B**C` draws as ABC), so a word they split that is an address once they're gone
 * is kept as that address, and the gate reads what's drawn.
 */
export function replyText(s: string): string {
  return terminalText(s, { keepNewlines: true })
    .replace(/(?<=[0-9A-Za-z])[\u200c\u200d]+(?=[0-9A-Za-z])/g, "")
    .replace(MARKED_WORD, (word) => {
      const joined = word.replace(/[*`]/g, "")
      return addressSpellings(joined)[0] === joined ? joined : word
    })
}

export function seenFrom(output: string, source: Source): SeenValue[] {
  return extractAddresses(output).map((value) => ({ value, source }))
}

export function checkAddresses(reply: string, seen: readonly SeenValue[]): GateResult {
  const best = new Map<string, Source>()
  for (const { value, source } of seen) {
    const key = keyOf(value)
    const held = best.get(key)
    if (held === undefined || RANK[source] < RANK[held]) best.set(key, source)
  }
  const labelled: GateResult["labelled"] = []
  const unknown: string[] = []
  const named = new Set<string>()
  // Every spelling of an unknown address is unknown, so each is masked where it stands; a known one is labelled once.
  for (const address of addressSpellings(reply)) {
    const source = best.get(keyOf(address))
    if (!source) unknown.push(address)
    else if (!named.has(keyOf(address))) labelled.push({ address, source })
    named.add(keyOf(address))
  }
  return { ok: unknown.length === 0, labelled, unknown }
}

// The figure gate. A figure the reply states as read data (a price, a market cap, liquidity, volume, a
// balance or a holding) is checked against the numbers this turn's tool results showed, and those the core
// itself showed the agent. One that matches none is marked, never held back: the agent pane dims it with a
// `?` after it, "not read from a tool", for the person to check. The mark is kept for what warrants a check,
// since a mark seen everywhere gets glanced over: a conversion, a sum, a size or an estimate the agent
// worked out isn't stated as read data, so it isn't marked. Percents, counts, dates and times are never
// figures.

/** A figure in a reply: where it starts, its text as written (the `$`, the number and any K, M or B), and its value. */
export type Figure = { at: number; text: string; value: number }
export type FigureResult = { read: Figure[]; marked: Figure[] }

const MULTIPLIER: Record<string, number> = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9, thousand: 1e3, million: 1e6, billion: 1e9 }

// A number standing alone: not glued to a word, a decimal point, a time or a date on either side.
const CANDIDATE = /(?<![\p{L}\p{N}_.,:/]|\d-)(\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(bn|mn|[KMBkmb])?(?![\p{L}\p{N}_]|[.,]\d|[:/-]\d)/gu
const PERCENT = /^\s?(?:%|percent\b|pct\b|bps\b)/i
const WORD_MULTIPLIER = /^\s(thousand|million|billion)\b/i
// What read data is named by. Not "worth" or "valued": a position's worth is the agent's own sum. Nor a
// dollar figure on a balance or holding ("the holding is about $7,778"): Candle shows amounts and prices,
// never a holding's value, so that's the same sum.
const MARKET = String.raw`prices?|priced|mcap|mc|market\s?cap|fdv|liquidity|liq|volume|vol|tvl`
const HOLDING = String.raw`balances?|holdings?|holds?`
const DATA = `${MARKET}|${HOLDING}`
// The data word just before: "price 0.0042", "**Price:** $0.63", "market cap of $812K", "trades at $0.0042", "you hold 1,200 MOON".
const dataBefore = (words: string) => new RegExp(String.raw`\b(?:${words}|trades\s+at|trading\s+at)(?:\s*\*\*|\s*\x60|\s+(?:is|was|of|at|now|still|around|about|near|roughly|sits\s+at|stands\s+at)|\s*[:=~≈])*\s*$`, "i")
// Or just after: "$4.2M market cap", "$100K liquidity", "$1.2M in 24h volume", "812K MC".
const dataAfter = (words: string) => new RegExp(String.raw`^(?:\*\*|\x60)?\s(?:(?:in|of)\s)?(?:24h\s|daily\s)?(?:${words})\b`, "i")
const dataHeader = (words: string) => new RegExp(String.raw`\b(?:${words})\b`, "i")
/** The words that make a figure read data: a dollar figure only by a market word. */
const NAMED = { any: [dataBefore(DATA), dataAfter(DATA), dataHeader(DATA)], dollars: [dataBefore(MARKET), dataAfter(MARKET), dataHeader(MARKET)] } as const

/** The header cell above a figure in a Markdown table, if it sits in one (below its header). */
function tableHeader(text: string, at: number): string | undefined {
  const isRow = (l: string) => l.trim().length > 1 && l.trim().startsWith("|") && l.trim().endsWith("|")
  const lineStart = text.lastIndexOf("\n", at - 1) + 1
  const lineEnd = text.indexOf("\n", at) < 0 ? text.length : text.indexOf("\n", at)
  const lines = text.slice(0, lineEnd).split("\n")
  if (!isRow(lines.at(-1)!)) return undefined
  let first = lines.length - 1
  while (first > 0 && isRow(lines[first - 1]!)) first--
  if (first === lines.length - 1) return undefined
  const column = (text.slice(lineStart, at).match(/\|/g)?.length ?? 0) - 1
  return lines[first]!.trim().slice(1, -1).split("|")[column]
}

/** The figures a reply states as read data, in order. */
export function extractFigures(text: string): Figure[] {
  const out: Figure[] = []
  for (const m of text.matchAll(CANDIDATE)) {
    const [whole, , digits, suffix] = m as unknown as [string, string | undefined, string, string | undefined]
    const after = text.slice(m.index + whole.length, m.index + whole.length + 32)
    if (PERCENT.test(after)) continue
    const word = suffix ? undefined : WORD_MULTIPLIER.exec(after)
    const rest = word ? after.slice(word[0].length) : after
    const header = tableHeader(text, m.index)
    const [before, after_, inHeader] = m[1] ? NAMED.dollars : NAMED.any
    const isData = before.test(text.slice(Math.max(0, m.index - 40), m.index)) || after_.test(rest) || (header !== undefined && inHeader.test(header))
    if (!isData) continue
    const multiplier = MULTIPLIER[(suffix ?? word?.[1] ?? "").toLowerCase()] ?? 1
    out.push({ at: m.index, text: whole, value: Number(digits.replace(/,/g, "")) * multiplier })
  }
  return out
}

// Every number in a tool result, JSON's exponents and Hacc's "812K" included.
const SEEN_NUMBER = /(?<![\p{L}\p{N}_.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?(?:\s?(bn|mn|[KMBkmb]|thousand|million|billion)(?![\p{L}\p{N}_]))?/gu

// A raw amount in base units (Candle's portfolio: `amountRaw` beside `decimals`, SOL as `lamports`, Hood's
// ETH as `wei`) shows the amount in whole tokens too: "you hold 12,345.678901 MOON" is read from
// `"amountRaw":"12345678901","decimals":6` (without it, every held amount was marked).
const OBJECT = /\{[^{}]*\}/g
const RAW_FIELD = /"\w*Raw"\s*:\s*"?(\d+)"?/g
const DECIMALS = /"decimals"\s*:\s*(\d+)/
const NATIVE_FIELD = /"(lamports|wei)"\s*:\s*"?(\d+)"?/g

/** The numbers a tool result (or the core's own words to the agent) shows, as absolute values. */
export function numbersIn(output: string): number[] {
  const out: number[] = []
  for (const m of output.matchAll(SEEN_NUMBER)) {
    const raw = Math.abs(Number(m[0].replace(/,/g, "").replace(/\s?[A-Za-z]+$/, "")))
    if (!Number.isFinite(raw)) continue
    out.push(raw)
    // "5m" may be five minutes as well as five million, so both stand.
    if (m[1]) out.push(raw * MULTIPLIER[m[1].toLowerCase()]!)
  }
  // Grok's meta-tools hand the MCP result back as a JSON string, so its quotes come escaped.
  const unescaped = output.replace(/\\"/g, '"')
  for (const [object] of unescaped.matchAll(OBJECT)) {
    const decimals = DECIMALS.exec(object)?.[1]
    if (decimals !== undefined) for (const m of object.matchAll(RAW_FIELD)) out.push(Number(m[1]) / 10 ** Number(decimals))
  }
  for (const m of unescaped.matchAll(NATIVE_FIELD)) out.push(Number(m[2]) / 10 ** (m[1] === "lamports" ? 9 : 18))
  return out
}

/** How far a stated figure may be from a number and still be read from it: 0.5% of the number, or
 *  rounding at the figure's own last significant digit, so "$0.42" reads 0.4249. A whole number's
 *  trailing zeros are rounding, not digits, and no figure rounds coarser than two significant digits:
 *  "about $3,000" and "$3K" read 3,031 (±50), "$1M" reads 1.04M but not 1.2M (without it,
 *  "$3,000" was marked against Hacc's 3,031). */
function readFrom(figure: Figure, n: number): boolean {
  const diff = Math.abs(figure.value - n)
  if (diff <= 0.005 * n + 1e-12) return true
  if (figure.value <= 0) return false
  const digits = /((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)/.exec(figure.text)![1]!.replace(/,/g, "")
  const significant = (digits.includes(".") ? digits.replace(".", "") : digits.replace(/0+$/, "")).replace(/^0+/, "").length
  const place = Math.floor(Math.log10(figure.value)) - Math.max(significant, 2) + 1
  return diff <= 0.5 * 10 ** place * (1 + 1e-9)
}

// The reply's own words that a figure wasn't read: when a table's header already says "(from memory)", every
// field under it needn't carry a `?`.
const SAID_UNREAD = new RegExp(
  [
    String.raw`\bfrom (?:my )?(?:memory|training|knowledge)\b`,
    String.raw`\btraining data\b`,
    String.raw`\bas I (?:remember|recall)\b`,
    String.raw`\bI (?:remember|recall)\b`,
    String.raw`\bunverified\b`,
    String.raw`\bnot (?:live |fresh )?(?:reads?|read from (?:a|any) tool|checked|verified)\b`,
    String.raw`\b(?:called|used|read) no tools?\b`,
    String.raw`\bwithout (?:calling |using |reading )?(?:a |any )?tools?\b`,
  ].join("|"),
  "i",
)

/** The blank-line block a position sits in (a paragraph, a list or a whole table), with the paragraph above when it's a table: its caption. */
function blockAround(text: string, at: number): string {
  const starts = [0, ...[...text.matchAll(/\n[ \t]*\n/g)].map((m) => m.index + m[0].length)]
  let i = starts.length - 1
  while (i > 0 && starts[i]! > at) i--
  const block = text.slice(starts[i]!, starts[i + 1] ?? text.length)
  return block.trimStart().startsWith("|") && i > 0 ? text.slice(starts[i - 1]!, starts[i + 1] ?? text.length) : block
}

/** Whether the reply says, in a figure's own paragraph or table (or that table's caption), that it wasn't read. */
export const saidUnread = (text: string, at: number): boolean => SAID_UNREAD.test(blockAround(text, at))

/** Figures stated as read data that no number shown matches; one the reply itself says is unread isn't marked. */
export function checkFigures(reply: string, seen: readonly number[]): FigureResult {
  const read: Figure[] = []
  const marked: Figure[] = []
  for (const figure of extractFigures(reply)) (seen.some((n) => readFrom(figure, n)) || saidUnread(reply, figure.at) ? read : marked).push(figure)
  return { read, marked }
}
