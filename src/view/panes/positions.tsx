// The positions pane: holdings by wallet, since several agents can share one, each with who bought into it,
// from the journal: the name bright, the amount rounded, the value bright, who bought it dim. In paper mode,
// each agent's paper book as the core recorded it: the portfolio never shows paper (Candle's real answers
// carry none), so it counts only paper trades made in this Candle Harness, at the quoted price
// (docs.candle.tv/developers/agent-trading, "Paper mode").
import { type PortfolioView, viewTitle } from "../../core/portfolio-view"
import type { TokenView } from "../../core/token-watch"
import { amount, approxUsd, compactUsd, shortAddress, wrap } from "../format"
import { C } from "../theme"
import { askAbout } from "../ask"
import { blank, type Line, line, type RowPick, type Seg } from "./lines"
import { byChain, chainHeading } from "./wallets"

/**
 * A holding's row picks its token. Every row does, SOL and USDC too: the core says the token pane doesn't
 * follow what trades spend, rather than the click doing nothing.
 */
const pickOf = (id: string, mint: string, ask?: string): RowPick => ({ id, mint, ...(ask ? { ask } : {}) })

/** A row's symbol, amount and value columns, before who bought in. */
const ROW_COLS = 8 + 1 + 10 + 2 + 10

const row = (symbol: string, qty: string, value: string, rest: string, dim = false, pick?: RowPick): Line => ({
  ...(pick ? { pick } : {}),
  segs: [
    { text: `${symbol.padEnd(8)} `, fg: dim ? C.dim : C.hi },
    { text: qty.padStart(10), fg: C.ink },
    { text: `  ${value.padEnd(10)}`, fg: dim ? C.dim : C.hi },
    ...(rest ? [{ text: ` ${rest}`, fg: C.dim } as Seg] : []),
  ],
})

export interface PositionOpts {
  mode: "paper" | "live"
  now: number
  width: number
  market: TokenView | undefined
  hidden?: number
  /** Another pane on the tab shows Candle's trending list (the token pane before a token, Feed): no second copy here. */
  trendingShown?: boolean
}

export function positionLines(p: PortfolioView | undefined, opts: PositionOpts): Line[] {
  const lines = positionLinesIn(p, opts)
  // The Wallets pane's choice hides wallets here too, and says so.
  return opts.mode === "live" && opts.hidden && p?.readAt !== null ? [...lines, line(`${opts.hidden} hidden wallet${opts.hidden === 1 ? "" : "s"} left out`, C.dim)] : lines
}

/**
 * Before the first trade: Candle's trending list where no other pane on the tab shows it,
 * and what to try. In paper, the trade to type; in live, a question, since a live trade wants funds first.
 */
function noPositionLines(opts: PositionOpts, words: string): Line[] {
  const say = (text: string) => wrap(text, Math.max(10, opts.width)).map((t) => line(t, C.dim))
  const rows = opts.trendingShown ? [] : (opts.market?.trending?.rows.slice(0, 5) ?? [])
  const out: Line[] = say(rows.length ? `${words} Trending on Candle:` : words)
  for (const r of rows) out.push({ segs: [{ text: `${(r.symbol ?? "?").padEnd(8)} `, fg: C.hi }, { text: compactUsd(r.marketCap), fg: C.ink }], pick: { id: `trend:${r.mint}`, mint: r.mint, ask: askAbout(r.symbol, r.mint, `From Candle's trending list: ${compactUsd(r.marketCap)} market cap.`) } })
  out.push(blank(), ...say('try: ask the agent "what\'s moving on Candle?"'))
  if (opts.mode === "paper") out.push(...say("or type: buy $1 of <token>"))
  return out
}

function positionLinesIn(p: PortfolioView | undefined, opts: PositionOpts): Line[] {
  if (opts.mode === "paper") {
    const books = Object.entries(p?.paper ?? {})
    const out: Line[] = wrap("paper, at the quoted price · only paper trades made here", Math.max(10, opts.width)).map((t) => line(t, C.dim))
    // "No paper trades yet" had shown after five paper trades whose book had closed flat.
    if (books.length === 0) return [...out, ...noPositionLines(opts, "No open paper positions.")]
    for (const [agent, book] of books) {
      out.push(line(agent, C.ink))
      for (const pos of book) out.push(row(pos.symbol ?? shortAddress(pos.mint), amount(pos.tokens), "", `${pos.buys} buy${pos.buys === 1 ? "" : "s"} · ${pos.sells} sell${pos.sells === 1 ? "" : "s"}`, false, pickOf(`${agent}:${pos.mint}`, pos.mint, askAbout(pos.symbol, pos.mint, `${agent} holds ${amount(pos.tokens)} in paper.`))))
    }
    return out
  }
  if (!p || p.readAt === null) return p?.failed ? wrap(`Couldn't read your portfolio: ${p.failed}. Trying again every 15 s.`, Math.max(10, opts.width)).map((t) => line(t, C.look)) : [line("Reading your portfolio…", C.dim)]
  const held = p.wallets.some((w) => w.tokens === null || w.tokens.length > 0)
  if (!held) return noPositionLines(opts, "No positions yet.")
  const out: Line[] = []
  // Holdings on more than one chain go under a heading per chain, as the Wallets pane's wallets do.
  const holding = p.wallets.filter((w) => w.tokens === null || w.tokens.length > 0)
  const mixed = new Set(holding.map((w) => w.chain)).size > 1
  let lastChain: string | undefined
  for (const w of mixed ? byChain(holding) : p.wallets) {
    if (w.tokens !== null && w.tokens.length === 0) continue
    if (mixed && w.chain !== lastChain) {
      out.push(chainHeading(w.chain))
      lastChain = w.chain
    }
    if (w.tokens === null) {
      out.push(line("couldn't read this wallet's tokens", C.dim))
      continue
    }
    // Named as the Wallets pane names it (it had read "Wall…1111 wallet" there, "embedded" here; "shared by" one
    // agent), above its holdings (below them, it read as the next wallet's heading, and a short pane cut it).
    const name = viewTitle(w)
    out.push(line(`${name} wallet${w.agents.length ? ` · ${w.agents.join(", ")}` : ""}`, C.dim))
    // Who bought in, where it fits whole: cut, it read as an agent's name ("agent-b…"); the line above names the wallet's agents.
    const fits = (buyers: string) => (ROW_COLS + 1 + buyers.length <= opts.width ? buyers : "")
    for (const t of w.tokens) out.push(row(t.symbol ?? shortAddress(t.mint), amount(t.amount), approxUsd(t.usd), fits(t.buyers.join(", ")), t.usd === null, pickOf(`${w.address}:${t.mint}`, t.mint, askAbout(t.symbol, t.mint, `I hold ${amount(t.amount)}${t.usd !== null ? ` (${approxUsd(t.usd)})` : ""}.`))))
  }
  return out
}
