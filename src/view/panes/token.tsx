// The token pane: the token the agent last showed from Candle, with its price,
// market cap, liquidity and 1h change, each with when and where it was read; the token check
// (candle_token_forensics: flagged, clear or incomplete, and unknown is never clean); and a chart of
// Hacc's last hour at 1m with this Candle Harness's own price samples on top, or the samples alone, saying why, when
// Hacc's history didn't load. Before any token, Candle's on-fire list, or where a list is already on the
// tab, how to pick one.
import { ONFIRE_MS } from "../../core/feeds"
import type { TokenView } from "../../core/token-watch"
import { priceChart, type Tone } from "../chart"
import { ago, compactUsd, pct, shortAddress, usd, wrap } from "../format"
import { C } from "../theme"
import { askAbout } from "../ask"
import { blank, chip, type Line, line } from "./lines"

/** A market read older than this is marked stale: the core samples every 5 s. */
const STALE_MS = 15_000

function checkLine(check: NonNullable<TokenView["check"]>): Line {
  switch (check.summary) {
    case "clear":
      return line("✓ no flags: all six checks clear", C.good)
    case "flagged":
      // A flag is something to read before trading, not a refusal: amber.
      return line(`⚑ flagged: ${check.flagged.join(", ")}`, C.look)
    case "not_applicable":
      return line("check not applicable (a base asset)", C.dim)
    case "unavailable":
      // "check unavailable: that isn't clean" read as a verdict on the token.
      return line(`safety check didn't load${check.note ? ` (${check.note})` : ""}: unchecked, not clean`, C.look)
    default:
      return line(`check ${check.summary}${check.unknown.length ? ` · unknown: ${check.unknown.join(", ")}` : ""}`, C.look)
  }
}

/**
 * Before any token where a list is already on the tab (the Cockpit's Feed, Trending's lists, Signals) the
 * pane doesn't repeat it: it says how a token gets here, and offers the tokens seen this
 * session that aren't on Candle's on-fire list (held, carded, pinned) as picks.
 */
function pickHereLines(market: TokenView | undefined, seen: readonly { symbol: string; mint: string }[], width: number): Line[] {
  const say = (text: string, fg: string = C.dim) => wrap(text, Math.max(10, width)).map((part) => line(part, fg))
  const trending = new Set((market?.trending?.rows ?? []).map((r) => r.mint))
  const others = seen.filter((t) => !trending.has(t.mint)).slice(0, 5)
  return [
    ...say("Pick a row in a list here to see its token: price, check, chart.", C.ink),
    ...say("ctrl-t on a row asks the agent; what it discusses shows here too."),
    ...(others.length
      ? [blank(), line("Seen this session:", C.dim), ...others.map((t): Line => ({ segs: [{ text: t.symbol, fg: C.hi }], pick: { id: `seen:${t.mint}`, mint: t.mint, ask: askAbout(t.symbol, t.mint, "Seen earlier this session.") } }))]
      : []),
  ]
}

export function tokenLines(market: TokenView | undefined, opts: { now: number; width: number; height: number; shownInFull?: string; listOnTab?: boolean; seen?: readonly { symbol: string; mint: string }[]; trendingFailed?: string }): Line[] {
  if (!market?.followed) {
    if (opts.listOnTab) return pickHereLines(market, opts.seen ?? [], opts.width)
    const t = market?.trending
    if (!t) return wrap(opts.trendingFailed ? `Couldn't read Candle's trending list: ${opts.trendingFailed}. Trying again shortly.` : "Waiting on Candle for its On Fire list: the first read takes a few seconds.", Math.max(10, opts.width)).map((part) => line(part, opts.trendingFailed ? C.look : C.dim))
    return [
      // Stale past two of On Fire's own reads, a minute apart off the Trending tab: at 45 s, a list read on time
      // showed "stale" on Research.
      ...wrap(`Trending on Candle (on fire) · ${ago(t.at, opts.now, 2 * ONFIRE_MS).text}`, Math.max(10, opts.width)).map((part) => line(part, C.dim)),
      // The figure before the name, so a narrow pane cuts the name, not the market cap.
      ...(t.rows.length === 0 ? wrap("Candle's on-fire list is empty right now.", Math.max(10, opts.width)).map((part) => line(part, C.dim)) : []),
      ...t.rows.map((r) => ({
        segs: [
          { text: `${(r.symbol ?? "?").padEnd(8)} `, fg: C.hi },
          { text: compactUsd(r.marketCap).padStart(6), fg: C.ink },
          { text: `  ${r.name && r.name !== r.symbol ? r.name : ""}`.trimEnd(), fg: C.dim },
        ],
        pick: { id: r.mint, mint: r.mint, ask: askAbout(r.symbol, r.mint, `From Candle's trending list: ${compactUsd(r.marketCap)} market cap.`) },
      })),
      blank(),
      ...wrap("The token the agent discusses, or the one you pick, shows here.", Math.max(10, opts.width)).map((part) => line(part, C.dim)),
    ]
  }
  const m = market.market
  const symbol = market.followed.symbol ?? m?.symbol ?? "token"
  const read = m ? ago(m.at, opts.now, STALE_MS) : { text: "never read", stale: true }
  const change = market.change1h
  // An older core sends no history.
  const points = [...(market.history ?? []), ...market.samples]
  // Candle sends no price for some young tokens while Hacc's history has their trades (a young token
  // read "—" over a chart of prices): the chart's last price shows, dim and said as Hacc's.
  const fallback = m?.priceUsd === null || m?.priceUsd === undefined ? points.at(-1) : undefined
  const out: Line[] = [
    { segs: [{ text: symbol, fg: C.hi, bold: true }, { text: m?.name && m.name !== symbol ? `  ${m.name}` : "", fg: C.dim }] },
    // The contract address, copyable like the deposit address.
    ...(opts.shownInFull === market.followed.mint
      ? wrap(market.followed.mint, Math.max(10, opts.width)).map((part) => line(part, C.hi))
      : [{ segs: [{ text: shortAddress(market.followed.mint), fg: C.dim }, { text: " ", fg: C.ink }, chip("⧉", "copy")], ref: market.followed.mint }]),
    {
      segs: [
        fallback ? { text: `≈${usd(fallback.usd)}`, fg: C.ink } : { text: usd(m?.priceUsd), fg: read.stale ? C.dim : C.hi },
        { text: "  ", fg: C.ink },
        { text: pct(change), fg: change === null || change === undefined ? C.dim : change >= 0 ? C.good : C.bad },
        { text: " 1h   mcap ", fg: C.dim },
        { text: compactUsd(m?.marketCap), fg: C.ink },
        { text: "  liq ", fg: C.dim },
        { text: compactUsd(m?.liquidityUsd), fg: C.ink },
      ],
    },
    line(fallback ? `Candle market read, ${read.text}: no price from Candle, so ≈ the chart's last, ${ago(fallback.at, opts.now, STALE_MS).text}` : `Candle market read, ${read.text}`, read.stale ? C.look : C.dim),
  ]
  if (market.check) out.push(checkLine(market.check))
  out.push(blank())
  const hr = market.historyRead
  const history = hr?.source === "hacc" && (market.history ?? []).length > 0 ? { source: "hacc" as const } : hr?.source === "samples" ? { source: "samples" as const, words: hr.words } : undefined
  // Hacc's candles whole, for two-minute candles; an older core sends none.
  const chartOpts = { width: opts.width, symbol, now: opts.now, ...(history ? { history } : {}), candles: history?.source === "hacc" ? (market.candles ?? []) : [], samples: market.samples }
  // The caption and note are measured first, so the chart takes the rows they leave.
  const words = priceChart(points, { ...chartOpts, height: Math.max(1, Math.min(4, opts.height - out.length - 2)) })
  const below = [...wrap(words.caption, Math.max(10, opts.width)), ...(words.note ? wrap(words.note, Math.max(10, opts.width)) : [])]
  const chart = priceChart(points, { ...chartOpts, height: Math.max(1, opts.height - out.length - below.length) })
  if (chart.cells && chart.axis) {
    // Each row's cells in runs of one colour, then its label; the last price's in bright text.
    const fg: Record<Tone, string> = { good: C.good, bad: C.bad, fill: C.edge, flat: C.dim }
    chart.cells.forEach((row, i) => {
      const segs: Line["segs"] = []
      for (const cell of row) {
        const last = segs.at(-1)
        if (last && last.fg === fg[cell.tone]) last.text += cell.text
        else segs.push({ text: cell.text, fg: fg[cell.tone] })
      }
      const label = chart.axis![i] ?? ""
      segs.push({ text: ` ${label}`, fg: label.startsWith("◂") ? C.hi : C.dim })
      out.push({ segs })
    })
    if (chart.time) out.push(line(chart.time, C.dim))
  } else {
    const axisWidth = Math.max(chart.top.length, chart.bottom.length)
    chart.rows.forEach((row, i) => {
      const axis = i === 0 ? chart.top : i === chart.rows.length - 1 ? chart.bottom : ""
      out.push({ segs: [{ text: row, fg: C.ink }, { text: ` ${axis.padEnd(axisWidth)}`, fg: C.dim }] })
    })
  }
  for (const part of below) out.push(line(part, C.dim))
  return out
}
