// The card, inline in the agent pane. An open card is its decision in three lines, and `ctrl-o` holds the
// rest:
//   1. what was asked, then roughly what comes back, and the expiry;
//   2. who, the wallet that pays (a TEE wallet by label and short address), and the mode (and who
//      shares the wallet, on a sell);
//   3. why, on one line;
// then, for Candle's MCP cards, the dry run's preview on one line and whether it's public; the limits line,
// only near a limit, any warning to read first, and the actions as chips. Approving is one key press: ⏎
// with the input line empty, after 300 ms, with no confirm. A card that has ended folds
// to one line saying what happened; an expired one offers a re-quote and never approves.
import { amount, wrap } from "../format"
import { doneWord, PAPER_CLOSED_WORDS } from "../../core/trade-log"
import { tookWords } from "../../core/journal-query"
import { paneNext, paneWords, type ViewCard, type ViewOperation } from "../store"
import { C, fit, money, shortDuration } from "../theme"
import { chip, type Line, type Seg } from "./lines"

// How a card was approved is shown: an Enter pressed by reflex once approved two cards as they arrived, and
// nothing said so.
const APPROVED_HOW: Record<string, string> = { enter: "by Enter", click: "by click", instant: "at once (typed cards run instantly)", typed: "as typed", "inside-limits": "without a card" }

/** The open card's edge: one cell in the look-at-this colour, on every line. */
const GUTTER = "▌ "

const cells = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

/** "≈1,240 MOON · 0.00997 SOL": roughly what comes back, then the other figure, rounded. */
export function cardFigures(card: ViewCard): string {
  const d = card.display
  const fig = (f: { amount: number; asset: string }, approx = true) => `${approx ? "≈" : ""}${amount(f.amount)} ${f.asset}`
  const value = d.valueUsd !== undefined ? `≈${money(d.valueUsd)}` : undefined
  if (card.side === "sell") {
    const flow = [d.sells && fig(d.sells), d.gets && fig(d.gets)].filter(Boolean).join(" → ")
    return [flow, value].filter(Boolean).join(" · ")
  }
  if (card.side === "buy") return [d.gets && fig(d.gets), d.spend ? fig(d.spend, false) : value].filter(Boolean).join(" · ")
  return [d.gets && fig(d.gets), value].filter(Boolean).join(" · ")
}

/**
 * What a card in a short pane gives up first, in order, when its lines are more than `maxRows`: the
 * prompt pane's steps (the pane asks them itself, and details has them), then why (details has it whole).
 * The headline, who, every amber line, the card's own words and the chips always stay (at 80×24 a funds-out
 * card's headline and the start of its new-address line had scrolled off).
 */
const DROP_PANE_STEPS = 1
const DROP_WHY = 2

function openLines(card: ViewCard, opts: { now: number; focused: boolean; width: number; maxRows?: number }): Line[] {
  const d = card.display
  const id = card.cardId
  const bg = opts.focused ? { bg: C.sel } : {}
  const gutter: Seg = { text: GUTTER, fg: C.look }
  const room = Math.max(10, opts.width - GUTTER.length)
  const row = (segs: Seg[]): Line => ({ segs: [gutter, ...segs], cardId: id, ...bg })
  const left = shortDuration(Math.max(0, Date.parse(card.expiresAt) - opts.now))
  const head = d.headline ?? d.title
  const figures = cardFigures(card)
  const out: Line[] = []
  const droppable = new Map<Line, number>()
  const optional = (rank: number, line: Line) => {
    droppable.set(line, rank)
    out.push(line)
  }
  // Line 1: the headline, the figures, and the expiry on the right; the figures drop a line when narrow.
  const first: Seg[] = [{ text: head, fg: C.hi }]
  const together = head.length + 3 + figures.length + 2 + left.length <= room
  if (figures && together) first.push({ text: `   ${figures}`, fg: C.dim })
  const pad = Math.max(2, room - cells(first) - left.length)
  out.push(row([...first, { text: " ".repeat(pad), fg: C.ink }, { text: left, fg: C.look }]))
  if (figures && !together) out.push(row([{ text: fit(figures, room), fg: C.dim }]))
  // Line 2: who, the wallet that pays, the mode.
  // Every wallet is said the same way: "pays from embedded" beside a TEE card's "pays from tee-one (TEE · …)".
  const who = [card.agent, d.paysFrom ?? (d.walletLabel ? `pays from ${d.walletLabel}` : ""), d.modeNote ?? d.mode, card.side === "sell" && d.sharedWith?.length ? `shared with ${d.sharedWith.join(", ")}` : ""].filter(Boolean).join(" · ")
  out.push(row([{ text: fit(who, room), fg: C.dim }]))
  // On a wallet that trades inside limits, which figure sent this one to you: whole, in amber.
  if (d.cardBecause) for (const t of wrap(d.cardBecause, room)) out.push(row([{ text: t, fg: C.look }]))
  // Line 3: why, cut to one line; details has it whole.
  if (d.why) optional(DROP_WHY, row([{ text: "why  ", fg: C.dim }, { text: fit(d.why, room - 5), fg: C.ink }]))
  if (d.risks) out.push(row([{ text: "risks  ", fg: C.dim }, { text: fit(d.risks, room - 7), fg: C.bad }]))
  if (d.preview) out.push(row([{ text: fit(d.preview, room), fg: C.dim }]))
  if (d.publicNote) out.push(row([{ text: fit(d.publicNote, room), fg: C.look }]))
  if (d.nearLimit) out.push(row([{ text: fit(d.nearLimit, room), fg: C.look }]))
  // A slippage bound the agent set: never run unseen. Looser than the default, in amber.
  if (d.slippage) out.push(row([{ text: fit(d.slippage, room), fg: d.slippageLooser ? C.look : C.dim }]))
  // Read before the press (a TEE wallet a revoke would strand): whole, in amber, never cut.
  if (d.warning) for (const t of wrap(d.warning, room)) out.push(row([{ text: t, fg: C.look }]))
  // A ceremony's line: what it shows or takes, read before the press, in amber, whole.
  if (d.paneShows) for (const t of wrap(d.paneShows, room)) out.push(row([{ text: t, fg: C.look }]))
  // Funds out to a new address: said plainly, then the address in full, in groups of four, amber.
  if (d.newAddress) {
    for (const t of wrap("A new address: not one of your wallets or vault keys. Check every group:", room)) out.push(row([{ text: t, fg: C.look }]))
    for (const t of wrap(d.newAddress, room)) out.push(row([{ text: t, fg: C.look }]))
  }
  // An owner card's own words: who a new key makes, what a rebind moves, what a preset drops.
  for (const note of d.paneNotes ?? []) for (const t of wrap(note, room)) out.push(row([{ text: t, fg: C.ink }]))
  // What to do about it, as commands put on the input line ("rebind to …", "change the name").
  for (const f of d.fills ?? []) out.push({ ...row([chip(f.label, "fill")]), ref: f.line })
  // A card that runs in the prompt pane: what the pane will ask, then that the agent can't see it.
  // A card that can't run here yet says only why, and the step that fixes it, in place of approve.
  if (!d.blocked) for (const step of d.paneSteps ?? []) for (const [i, t] of wrap(step, room - 2).entries()) optional(DROP_PANE_STEPS, row([{ text: `${i === 0 ? "· " : "  "}${t}`, fg: C.dim }]))
  if (d.paneNote && !d.blocked) for (const t of wrap(d.paneNote, room)) optional(DROP_PANE_STEPS, row([{ text: t, fg: C.look }]))
  if (d.blocked) {
    for (const t of wrap(d.blocked.why, room)) out.push(row([{ text: t, fg: C.look }]))
    out.push({ ...row([chip(d.blocked.fill.label, "fill", "primary")]), ref: d.blocked.fill.line })
  }
  // The actions, as chips; a card the Candle Harness can't run yet offers only reject.
  // A new address is approved only by a click on its own chip; Enter says so (keys.ts).
  const approveChip = d.newAddress ? chip("yes, a new address", "approve", "primary") : chip("⏎ approve", "approve", "primary")
  const actions = d.supported === false ? [chip("ctrl-n reject", "reject"), chip("ctrl-o details", "details")] : [approveChip, chip("ctrl-n reject", "reject"), chip("ctrl-o details", "details")]
  let line: Seg[] = []
  for (const a of actions) {
    if (line.length && cells(line) + 2 + a.text.length > room) {
      out.push(row(line))
      line = []
    }
    if (line.length) line.push({ text: "  ", fg: C.ink })
    line.push(a)
  }
  out.push(row(line))
  let kept = out
  for (const rank of [DROP_PANE_STEPS, DROP_WHY]) {
    if (opts.maxRows === undefined || kept.length <= opts.maxRows) break
    kept = kept.filter((l) => droppable.get(l) !== rank)
  }
  return kept
}

/** What a buy's receipt's sell chip puts on the input line: all of it, from the wallet that paid. */
export function sellLine(card: ViewCard): string | undefined {
  const symbol = card.display.mintLabel
  if (card.side !== "buy" || !symbol) return undefined
  return `sell 100% of ${symbol} from ${card.display.walletLabel ?? "embedded"}`
}

/** What a trade with no card was checked against, in the core's words, for the line under its receipt. */
export function insideWords(withoutCard: string | undefined): string | undefined {
  if (!withoutCard) return undefined
  const rest = withoutCard.replace(/^without a card[,:]\s*/, "")
  const figures = /^(.*) \((.*)\)$/.exec(rest)
  return figures ? `${figures[1]}: ${figures[2]}` : rest
}

/** What an ended card says, on one line: a mark, the headline, what happened, and the detail. */
function folded(card: ViewCard, op: ViewOperation | undefined, expired: boolean): { mark: Seg; state: Seg; detail?: string; chips?: Seg[] } {
  const how = card.approvedHow ? APPROVED_HOW[card.approvedHow] : undefined
  // Nobody approved a trade the core ran inside its wallet's limits: it says so, not "approved".
  const approved = card.approvedHow === "inside-limits" ? "without a card" : how ? `approved ${how}` : "approved"
  if (expired) return { mark: { text: "◷", fg: C.dim }, state: { text: "expired, never ran", fg: C.dim }, chips: [chip("ctrl-r re-quote", "requote")] }
  switch (card.state) {
    case "rejected":
      return { mark: { text: "✕", fg: C.dim }, state: { text: "rejected, never ran", fg: C.dim } }
    case "withdrawn":
      return { mark: { text: "✕", fg: C.dim }, state: { text: card.replacedBy ? "replaced by a new card, never ran" : "withdrawn, never ran", fg: C.dim } }
    case "approved": {
      const state = op?.state ?? card.operation?.state
      // A pane step: in the pane while it's open, then its outcome in the pane's own words. Never "reading it back".
      if (op?.route === "pane" || card.route === "pane") {
        const said = paneWords(op)
        if (state === "pending" || state === "submitting") return { mark: { text: "◌", fg: C.ink }, state: { text: "in the prompt pane", fg: C.ink }, detail: approved }
        const fg = state === "succeeded" ? C.good : state === "unknown" ? C.look : C.bad
        const mark = state === "succeeded" ? "✓" : state === "unknown" ? "?" : "✕"
        return { mark: { text: mark, fg }, state: { text: said ?? state ?? "ended", fg }, detail: approved }
      }
      const gets = card.display.gets ? `≈${amount(card.display.gets.amount)} ${card.display.gets.asset}` : undefined
      // Nothing live was sold, whatever Candle's success says: no "filled", and no sell chip.
      if (state === "succeeded" && (op?.paper || card.operation?.paper)) return { mark: { text: "✕", fg: C.look }, state: { text: PAPER_CLOSED_WORDS, fg: C.look }, detail: approved }
      // A follow, a rule or a stake is done, not filled: "filled" means a position.
      if (state === "succeeded") {
        // The receipt for a trade with no card: how long it took, and a sell chip for a buy.
        const took = card.approvedHow === "inside-limits" && op?.settledAt !== undefined && op.startedAt !== undefined ? ` in ${tookWords(op.settledAt - op.startedAt)}` : ""
        const sell = card.approvedHow === "inside-limits" ? sellLine(card) : undefined
        return { mark: { text: "✓", fg: C.good }, state: { text: `${doneWord(card.kind)}${took}`, fg: C.good }, detail: [gets, approved].filter(Boolean).join(" · "), ...(sell ? { chips: [{ ...chip("sell", "fill"), ref: sell }] } : {}) }
      }
      if (state === "failed" || state === "refused") {
        // A trade with no card that didn't run says so in its state, not after Candle's words.
        if (card.approvedHow === "inside-limits") return { mark: { text: "✕", fg: C.bad }, state: { text: `${state}, sent without a card`, fg: C.bad }, ...(op?.error?.message ? { detail: op.error.message } : {}) }
        return { mark: { text: "✕", fg: C.bad }, state: { text: state, fg: C.bad }, detail: [op?.error?.message, approved].filter(Boolean).join(" · ") }
      }
      if (state === "unknown") return { mark: { text: "?", fg: C.look }, state: { text: "no answer yet: reading it back", fg: C.look }, detail: approved }
      if (state === "abandoned") return { mark: { text: "–", fg: C.dim }, state: { text: "abandoned: no longer followed", fg: C.dim }, detail: approved }
      return { mark: { text: "◌", fg: C.ink }, state: { text: state ?? "sending", fg: C.ink }, detail: approved }
    }
    default:
      return { mark: { text: "·", fg: C.dim }, state: { text: card.state, fg: C.dim } }
  }
}

export function cardLines(card: ViewCard, opts: { now: number; focused: boolean; width: number; op?: ViewOperation; maxRows?: number }): Line[] {
  const awaiting = card.state === "awaiting_approval"
  const expired = card.state === "expired" || (awaiting && opts.now >= Date.parse(card.expiresAt))
  if (awaiting && !expired) return openLines(card, opts)
  const f = folded(card, opts.op, expired)
  const head = card.display.headline ?? card.display.title
  const chips = f.chips ?? []
  const chipCells = chips.reduce((n, c) => n + 2 + c.text.length, 0)
  const out: Line[] = []
  // A long headline keeps its line, and what happened goes under it whole, never cut off (an owner step's words).
  if (5 + head.length + 2 + f.state.text.length + chipCells > opts.width) {
    out.push({ segs: [{ text: "  ", fg: C.ink }, f.mark, { text: " ", fg: C.ink }, { text: fit(head, Math.max(10, opts.width - 4 - chipCells)), fg: C.hi }, ...chips.flatMap((c) => [{ text: "  ", fg: C.ink }, c])], cardId: card.cardId })
    for (const t of wrap(f.state.text, Math.max(10, opts.width - 4))) out.push({ segs: [{ text: `    ${t}`, fg: f.state.fg }], cardId: card.cardId })
    if (f.detail) for (const t of wrap(f.detail, Math.max(10, opts.width - 4))) out.push({ segs: [{ text: `    ${t}`, fg: C.dim }], cardId: card.cardId })
    for (const n of paneNext(opts.op)) out.push({ segs: [{ text: "    next  ", fg: C.dim }, chip(n.label, "fill")], cardId: card.cardId, ref: n.line })
    return out
  }
  const segs: Seg[] = [{ text: "  ", fg: C.ink }, f.mark, { text: " ", fg: C.ink }, { text: head, fg: C.hi }, { text: "  ", fg: C.ink }, f.state]
  // The detail fills the rest of the line; what doesn't fit wraps under the headline.
  const room = Math.max(0, opts.width - cells(segs) - chipCells)
  const detail = f.detail ? ` · ${f.detail}` : ""
  if (detail.length <= room) {
    if (detail) segs.push({ text: detail, fg: C.dim })
    for (const c of chips) segs.push({ text: "  ", fg: C.ink }, c)
    out.push({ segs, cardId: card.cardId })
  } else {
    for (const c of chips) segs.push({ text: "  ", fg: C.ink }, c)
    out.push({ segs, cardId: card.cardId })
    for (const t of wrap(f.detail!, Math.max(10, opts.width - 4))) out.push({ segs: [{ text: `    ${t}`, fg: C.dim }], cardId: card.cardId })
  }
  // A trade with no card: the figures it was checked against, under it. Not once it failed or was refused:
  // the core hands its spend back, so the figures it was sent at no longer hold.
  const ended = opts.op?.state ?? card.operation?.state
  const inside = card.approvedHow === "inside-limits" && ended !== "failed" && ended !== "refused" ? insideWords(card.withoutCard) : undefined
  if (inside) for (const t of wrap(inside, Math.max(10, opts.width - 4))) out.push({ segs: [{ text: `    ${t}`, fg: C.dim }], cardId: card.cardId })
  // Nobody saw a card, so the receipt says the slippage the agent set, as the card would have.
  if (card.approvedHow === "inside-limits" && card.display.slippage) out.push({ segs: [{ text: `    ${fit(card.display.slippage, Math.max(10, opts.width - 4))}`, fg: card.display.slippageLooser ? C.look : C.dim }], cardId: card.cardId })
  // A pane step's next steps: each a chip that puts its command on the input line.
  for (const n of paneNext(opts.op)) out.push({ segs: [{ text: "    next  ", fg: C.dim }, chip(n.label, "fill")], cardId: card.cardId, ref: n.line })
  return out
}
