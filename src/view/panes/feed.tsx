// Candle's four lists: one component for each, in Feed's look. On Fire is the Feed pane; New, Graduated and
// Final Stretch sit beside it on the Trending tab. The core reads a list while a pane on screen shows it
// (feeds.ts), and On Fire every minute whatever's shown, for the token pane's empty state. Each row's figures
// come before its name, so a narrow pane cuts the name first, then where it was launched; the token and the
// list's own figures always show. A dim heading names the columns, since the lists side by side don't share
// them. Where it was launched ("pump", "candle") takes the per-unit price's place, since the price alone says
// little and where a token came from says more; the price is a pick away, in the token pane.
import { type Bucket, FEED_LIMIT, type FeedList, type FeedRow } from "../../core/feeds"
import type { TokenView } from "../../core/token-watch"
import type { PaneId } from "../../shared/panes"
import { ago, compactUsd, pct, usd, wrap } from "../format"
import { C, fit } from "../theme"
import { askAbout, askPct } from "../ask"
import { type Line, line } from "./lines"

/** A list older than this is marked stale: the core reads them every 15 s to a minute. */
const STALE_MS = 3 * 60_000

/** The panes that show one of Candle's lists, and which. */
export const FEED_PANES = { new: "new", graduated: "graduated", feed: "onfire", "final-stretch": "finalstretch" } as const satisfies Partial<Record<PaneId, Bucket>>
export type FeedPane = keyof typeof FEED_PANES
export const isFeedPane = (id: PaneId): id is FeedPane => id in FEED_PANES

/** The buckets a layout's panes show, for the view's `feeds` subscription. */
export function feedBuckets(panes: readonly PaneId[]): Bucket[] {
  return [...new Set(panes.filter(isFeedPane).map((p) => FEED_PANES[p]))]
}

/**
 * Final Stretch where Candle's server has it off gives its width to the other lists: it's left out
 * of a layout that has another of Candle's lists. Alone, or popped out, it stays and says why.
 */
export function feedPanesLeftOut(panes: readonly PaneId[], feeds: Partial<Record<Bucket, FeedList>> | undefined): PaneId[] {
  if (feeds?.finalstretch?.state !== "off" || !panes.includes("final-stretch")) return []
  return panes.some((p) => p !== "final-stretch" && isFeedPane(p)) ? ["final-stretch"] : []
}

export const NAMES: Record<Bucket, string> = { new: "New", graduated: "Graduated", onfire: "On Fire", finalstretch: "Final Stretch" }
const TITLES: Record<Bucket, string> = { new: "New", graduated: "Graduated", onfire: "Feed · on fire", finalstretch: "Final Stretch" }

/** How long ago, as a row's column has room for: 45s, 4m, 2h, 3d. */
export function since(at: number | undefined, now: number): string {
  if (at === undefined) return "—"
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}

/** The list the pane shows: the core's feeds, or for On Fire, the token view's copy (an older core). */
export function listOf(bucket: Bucket, feeds: Partial<Record<Bucket, FeedList>> | undefined, market: TokenView | undefined): FeedList | undefined {
  const list = feeds?.[bucket]
  if (list || bucket !== "onfire" || !market?.trending) return list
  const t = market.trending
  return { bucket, at: t.at, rows: t.rows.map((r) => ({ mint: r.mint, symbol: r.symbol ?? "?", ...(r.name ? { name: r.name } : {}), marketCap: r.marketCap, priceUsd: r.priceUsd ?? null, change1h: r.change1h ?? null, ...(r.where ? { where: r.where } : {}) })) }
}

/** The pane's title: what the list is, and how old. */
export function feedTitle(bucket: Bucket, list: FeedList | undefined, now: number): string {
  return list?.at !== null && list?.at !== undefined && list.state !== "off" ? `${TITLES[bucket]} · ${ago(list.at, now, STALE_MS).text}` : TITLES[bucket]
}

interface Col {
  head: string
  width: number
  text: (r: FeedRow, now: number) => string
  fg: (r: FeedRow) => string
}

const change: Col = { head: "1h", width: 8, text: (r) => pct(r.change1h), fg: (r) => (r.change1h === null ? C.dim : r.change1h >= 0 ? C.good : C.bad) }
const cap: Col = { head: "mcap", width: 7, text: (r) => compactUsd(r.marketCap), fg: (r) => (r.marketCap === null ? C.dim : C.ink) }
/** Trending's lists' market cap: seven cells, "$11.8K" and one before it, now the change column ends in its own space. */
const wideCap: Col = { ...cap, width: 7 }

/**
 * Each list's own columns after the token: what the list is about, then the hour's change and the market
 * cap. Each takes 27 cells, so four fit side by side from 130 columns, with where it launched from 160.
 */
const COLUMNS: Record<Bucket, Col[]> = {
  onfire: [change, cap],
  new: [{ head: "age", width: 4, text: (r, now) => since(r.createdAt, now), fg: () => C.dim }, change, wideCap],
  graduated: [{ head: "grad", width: 4, text: (r, now) => since(r.graduatedAt, now), fg: () => C.dim }, change, wideCap],
  finalstretch: [
    { head: "curve", width: 6, text: (r) => (r.progress === undefined ? "—" : `${Math.floor(r.progress * 1000) / 10}%`), fg: (r) => (r.progress === undefined ? C.dim : C.ink) },
    { head: "last", width: 6, text: (r, now) => since(r.lastTradeAt, now), fg: () => C.dim },
    wideCap,
  ],
}

/** The question ctrl-t puts on the input line: where the row was seen and what it said, in the Candle Harness's words. */
function askFrom(bucket: Bucket, r: FeedRow, now: number): string {
  switch (bucket) {
    case "onfire":
      return `From On Fire: ${askPct(r.change1h)} in the hour, ${compactUsd(r.marketCap)} market cap.`
    case "new":
      return `From New: made ${r.createdAt === undefined ? "at a time Candle didn't send" : `${since(r.createdAt, now)} ago`}, ${compactUsd(r.marketCap)} market cap.`
    case "graduated":
      return `From Graduated: graduated ${r.graduatedAt === undefined ? "lately" : `${since(r.graduatedAt, now)} ago`}, ${compactUsd(r.marketCap)} market cap.`
    case "finalstretch":
      return `From Final Stretch: ${r.progress === undefined ? "its curve progress not read" : `${Math.floor(r.progress * 100)}% along its bonding curve`}, last traded ${r.lastTradeAt === undefined ? "at a time Candle didn't send" : `${since(r.lastTradeAt, now)} ago`}.`
  }
}

/** The words before a list, or instead of one: off, behind, a failed read, nothing yet. */
function noticeLines(bucket: Bucket, list: FeedList | undefined, width: number, now: number): Line[] {
  const w = Math.max(10, width)
  const say = (text: string, fg: string) => wrap(text, w).map((t) => line(t, fg))
  // Before its first read: what it waits on, and how long that takes.
  if (!list || (list.at === null && !list.failed)) return say(`Waiting on Candle for its ${NAMES[bucket]} list: the first read takes a few seconds.`, C.dim)
  if (list.state === "off") return [...say("Candle's server doesn't have Final Stretch on.", C.ink), ...say("Asked again every 10 minutes.", C.dim)]
  const out: Line[] = []
  if (list.state === "behind") out.push(...say(list.behindS !== undefined ? `Candle's source is ${behind(list.behindS)} behind.` : "Candle says its source is behind.", C.look))
  if (list.failed) {
    out.push(...say(list.at === null ? `Couldn't read it: ${list.failed.words}. Trying again shortly.` : `The last read failed (${list.failed.words}): this is the list from ${ago(list.at, now, Number.POSITIVE_INFINITY).text}.`, C.look))
  }
  return out
}

const behind = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`)

/** Words for a list read and empty. Final Stretch's are trusted only while its source isn't behind. */
function emptyWords(bucket: Bucket, list: FeedList): string {
  if (bucket === "finalstretch") return list.state === "behind" ? "Its list is empty, which may not be everything while it's behind." : "Nothing on the curve's final stretch right now."
  return { new: "No new tokens on Candle right now.", graduated: "Nothing has graduated on Candle lately.", onfire: "Candle's on-fire list is empty right now." }[bucket]
}

/**
 * A list's lines: the notice, the heading, and a row per token, each a pick that ctrl-t asks about.
 * Columns: the symbol and the list's own figures always; where it was launched when 8 cells are left; the
 * name from 22 cells past those.
 */
export function feedLines(bucket: Bucket, list: FeedList | undefined, width: number, now: number): Line[] {
  const notice = noticeLines(bucket, list, width, now)
  if (!list || list.at === null || list.state === "off") return notice
  if (list.rows.length === 0) return [...notice, ...wrap(emptyWords(bucket, list), Math.max(10, width)).map((t) => line(t, C.dim))]
  const cols = COLUMNS[bucket]
  // Each column's width holds its own space before it, as Feed's did.
  const base = 8 + cols.reduce((n, c) => n + c.width, 0)
  // Two cells before it where there's room, one where that's all there is (Trending's four lists at 160).
  const withWhere = width >= base + 7
  const sep = width >= base + 8 ? "  " : " "
  const withName = width >= base + 22
  const heading: Line = { segs: [{ text: "token".padEnd(8), fg: C.dim }, ...cols.map((c) => ({ text: c.head.padStart(c.width), fg: C.dim })), ...(withWhere ? [{ text: `${sep}where`, fg: C.dim }] : [])] }
  const rows = list.rows.map((r): Line => {
    const segs: Line["segs"] = [{ text: fit(r.symbol, 7).padEnd(8), fg: C.hi }, ...cols.map((c) => ({ text: c.text(r, now).padStart(c.width), fg: c.fg(r) })), ...(withWhere ? [{ text: `${sep}${fit(r.where ?? "—", 6)}`, fg: r.where === "candle" ? C.ink : C.dim }] : [])]
    if (withName && r.name && r.name.toLowerCase() !== r.symbol.toLowerCase()) {
      // The name lines up after the launch column, whatever its width.
      if (withWhere) segs[segs.length - 1] = { ...segs.at(-1)!, text: segs.at(-1)!.text.padEnd(sep.length + 6) }
      const used = segs.reduce((n, s) => n + s.text.length, 0)
      if (width - used > 4) segs.push({ text: `  ${fit(r.name, width - used - 2)}`, fg: C.dim })
    }
    return { segs, pick: { id: r.mint, mint: r.mint, ask: askAbout(r.symbol, r.mint, askFrom(bucket, r, now)) } }
  })
  // A short list says it's whole (Candle's Graduated list holds 4 to 7, never 20).
  const whole = list.matched !== undefined && list.matched <= list.rows.length && list.rows.length < FEED_LIMIT ? [line(list.rows.length === 1 ? "That's the only one Candle lists." : `Candle lists just these ${list.rows.length}.`, C.dim)] : []
  return [...notice, heading, ...rows, ...whole]
}
