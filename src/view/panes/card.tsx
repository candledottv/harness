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
import { ranWithoutCard } from "../../shared/approved-how"
import { amount, wrap } from "../format"
import { doneWord, notFollowedFurther, PAPER_CLOSED_WORDS } from "../../core/trade-log"
import { tookWords } from "../../core/journal-query"
import { paneNext, paneWords, type ViewCard, type ViewOperation } from "../store"
import { C, fit, money, shortDuration } from "../theme"
import { chip, type Line, type Seg } from "./lines"
import { BACKTEST_DIFFERS_SHORT } from "../../shared/definition-words"
import { short } from "../../core/wallet-names"
import { chainName } from "../../shared/chains"

// How a card was approved is shown: an Enter pressed by reflex once approved two cards as they arrived, and
// nothing said so.
const APPROVED_HOW: Record<string, string> = { enter: "by Enter", click: "by click", instant: "at once (typed cards run instantly)", typed: "as typed", "inside-limits": "without a card", "bot-exit": "without a card" }

/** The open card's edge: one cell in the look-at-this colour, on every line. */
const GUTTER = "▌ "

const cells = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

/** Every line but the first of one wrapped text: a folded card never starts what it shows mid-sentence. */
const CONTINUED = new WeakSet<Line>()
/** Lines a card too tall for its pane gives up before it folds: a live bot's note on its backtest, which details has. */
const FIRST_TO_GO = new WeakSet<Line>()
/** One wrapped text's lines, made by `make`, its later lines marked as carrying on the first. */
function wrapped(lines: readonly string[], make: (l: string, i: number) => Line): Line[] {
  return lines.map((l, i) => {
    const line = make(l, i)
    if (i > 0) CONTINUED.add(line)
    return line
  })
}

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

/**
 * A trigger's card, proposed: its exact line, then how it runs in a box of its own, titled with its kind (amber
 * where each firing will wait for the person), with the way to a wallet of its own inside; then the trigger in words.
 */
function triggerBox(t: NonNullable<ViewCard["display"]["triggerCard"]>, fills: readonly { label: string; line: string }[], room: number, row: (segs: Seg[]) => Line): Line[] {
  const out: Line[] = []
  out.push(...wrapped(wrap(t.line, room), (l) => row([{ text: l, fg: C.hi }])))
  const asks = t.kind === "asks"
  const edge = asks ? C.look : C.edge
  // "Asks you each time: the embedded wallet asks…": the kind is the box's title, the rest its words.
  const split = /^([^:]{3,40}): (.+)$/s.exec(t.runs)
  const title = split ? `${split[1]![0]!.toLowerCase()}${split[1]!.slice(1)}` : t.kind === "own" ? "runs on its own" : "how it runs"
  const body = split ? `${split[2]![0]!.toUpperCase()}${split[2]!.slice(1)}` : t.runs
  const inner = Math.max(6, room - 4)
  const boxRow = (segs: Seg[]): Line => {
    const used = cells(segs)
    return row([{ text: "│ ", fg: edge }, ...segs, { text: " ".repeat(Math.max(0, inner - used)), fg: C.ink }, { text: " │", fg: edge }])
  }
  out.push(row([{ text: "╭─ ", fg: edge }, { text: fit(title, room - 6), fg: asks ? C.look : C.hi }, { text: ` ${"─".repeat(Math.max(0, room - 5 - Math.min(title.length, room - 6)))}╮`, fg: edge }]))
  out.push(...wrapped(wrap(`${t.agent ? `${t.agent}'s trigger. ` : ""}${body}`, inner), (l) => boxRow([{ text: l, fg: C.ink }])))
  if (asks && fills.length) {
    out.push(...wrapped(wrap("For one that runs on its own, a wallet of its own:", inner), (l) => boxRow([{ text: l, fg: C.dim }])))
    for (const f of fills) out.push({ ...boxRow([chip(fit(f.label, inner - 2), "fill")]), ref: f.line })
  }
  out.push(row([{ text: `╰${"─".repeat(Math.max(0, room - 2))}╯`, fg: edge }]))
  out.push(...wrapped(wrap(t.words, room), (l) => row([{ text: l, fg: C.dim }])))
  return out
}

/**
 * A bot's card, proposed: the bot in words (a code bot's command and folder), then how its trades run in a box of its own, titled with its kind
 * (amber where each buy will wait for the person), with its worst case and, where it applies, the way to a wallet of
 * its own inside; then where it came from and its backtest. A flatten card says what it sells.
 */
function botBox(b: NonNullable<ViewCard["display"]["botCard"]>, warning: string | undefined, fills: readonly { label: string; line: string }[], room: number, row: (segs: Seg[]) => Line, tight = false): Line[] {
  const out: Line[] = []
  if (b.flatten) {
    out.push(...wrapped(wrap(b.flatten, room), (l) => row([{ text: l, fg: C.ink }])))
    return out
  }
  // In a pane too short for the whole card, a code bot's command keeps one line (what the press lets run); a rules
  // bot's sentences fold with the middle, since its box says the same in labelled lines.
  if (tight && b.parts && b.code) out.push(row([{ text: fit(b.words, room), fg: C.hi }]))
  else out.push(...wrapped(wrap(b.words, room), (l) => row([{ text: l, fg: C.hi }])))
  if (b.parts) return [...out, ...botParts(b, b.parts, warning, fills, room, row, tight)]
  const asks = b.runs.kind === "asks"
  const edge = asks ? C.look : C.edge
  const title = b.runs.kind === "paper" ? "on paper" : asks ? "its buys ask you each time" : b.runs.kind === "own" ? "runs on its own" : "how it trades"
  const inner = Math.max(6, room - 4)
  const boxRow = (segs: Seg[]): Line => {
    const used = cells(segs)
    return row([{ text: "│ ", fg: edge }, ...segs, { text: " ".repeat(Math.max(0, inner - used)), fg: C.ink }, { text: " │", fg: edge }])
  }
  out.push(row([{ text: "╭─ ", fg: edge }, { text: fit(title, room - 6), fg: asks ? C.look : C.hi }, { text: ` ${"─".repeat(Math.max(0, room - 5 - Math.min(title.length, room - 6)))}╮`, fg: edge }]))
  // The box's title says the kind: the words after it say the rest.
  const entries = b.runs.entries.replace(/^(On paper|Runs on its own|Its buys ask you each time): /, "")
  out.push(...wrapped(wrap(`${entries[0]!.toUpperCase()}${entries.slice(1)}`, inner), (l) => boxRow([{ text: l, fg: C.ink }])))
  if (b.runs.exits) out.push(...wrapped(wrap(b.runs.exits, inner), (l) => boxRow([{ text: l, fg: C.ink }])))
  out.push(...wrapped(wrap(b.worst, inner), (l) => boxRow([{ text: l, fg: C.dim }])))
  if (warning) out.push(...wrapped(wrap(warning, inner), (l) => boxRow([{ text: l, fg: C.look }])))
  for (const f of fills) out.push({ ...boxRow([chip(fit(f.label, inner - 2), "fill")]), ref: f.line })
  out.push(row([{ text: `╰${"─".repeat(Math.max(0, room - 2))}╯`, fg: edge }]))
  if (b.from) out.push(...wrapped(wrap(b.from, room), (l) => row([{ text: l, fg: C.dim }])))
  if (b.backtest) out.push(...wrapped(wrap(b.backtest, room), (l) => row([{ text: l, fg: C.dim }])))
  if (b.mode === "live" && b.differs) out.push(...wrapped(wrap(b.differs, room), (l) => row([{ text: l, fg: C.dim }])))
  return out
}

/** The card's labelled lines inside the box: its buys, its sells and its worst case, short. */
const PART_LABEL = 7

/**
 * A rules bot's box in labelled lines: its title the kind, then buys, sells and worst, each a line, the way to a
 * wallet of its own inside, in amber; under it the backtest's figures on one line. The sentences, the definition
 * and Hacc's caution are under ctrl-o, so the card fits the agent pane with its headline on screen.
 */
function botParts(b: NonNullable<ViewCard["display"]["botCard"]>, parts: { buys: string; sells: string; worst: string; tested: string }, warning: string | undefined, fills: readonly { label: string; line: string }[], room: number, row: (segs: Seg[]) => Line, tight = false): Line[] {
  const out: Line[] = []
  const asks = b.runs.kind === "asks"
  const edge = asks ? C.look : C.edge
  const title = b.runs.kind === "paper" ? "on paper" : asks ? "its buys ask you each time" : b.runs.kind === "own" ? "runs on its own" : "how it trades"
  const inner = Math.max(6, room - 4)
  const boxRow = (segs: Seg[]): Line => {
    const used = cells(segs)
    return row([{ text: "│ ", fg: edge }, ...segs, { text: " ".repeat(Math.max(0, inner - used)), fg: C.ink }, { text: " │", fg: edge }])
  }
  // Tight: each part keeps one line, cut to the row, so the box's title, buys, sells, limits and worst all stay on
  // screen, where the press approves them; details has each whole.
  const labelled = (label: string, text: string) =>
    tight
      ? out.push(boxRow([{ text: label.padEnd(PART_LABEL), fg: C.dim }, { text: fit(text, Math.max(6, inner - PART_LABEL)), fg: C.ink }]))
      : out.push(...wrapped(wrap(text, Math.max(6, inner - PART_LABEL)), (l, i) => boxRow([{ text: (i === 0 ? label : "").padEnd(PART_LABEL), fg: C.dim }, { text: l, fg: C.ink }])))
  out.push(row([{ text: "╭─ ", fg: edge }, { text: fit(title, room - 6), fg: asks ? C.look : C.hi }, { text: ` ${"─".repeat(Math.max(0, room - 5 - Math.min(title.length, room - 6)))}╮`, fg: edge }]))
  labelled("buys", parts.buys)
  labelled("sells", parts.sells)
  // A code bot's figures: what the core holds it to, whatever its code does.
  if (b.code) labelled("limits", b.code.figures)
  labelled("worst", parts.worst)
  // The box's title and its buys line say a wallet that asks: the steer says the rest.
  const said = b.runs.amber ? `${b.runs.amber[0]!.toUpperCase()}${b.runs.amber.slice(1)}. ` : ""
  const steer = warning && said && warning.startsWith(said) ? warning.slice(said.length) : warning
  // The steer's paragraph is the first thing a tight card gives up: its chip, kept, says the same in a row.
  if (steer && !tight) out.push(...wrapped(wrap(steer, inner), (l) => boxRow([{ text: l, fg: C.look }])))
  for (const f of fills) out.push({ ...boxRow([chip(fit(f.label, inner - 2), "fill")]), ref: f.line })
  out.push(row([{ text: `╰${"─".repeat(Math.max(0, room - 2))}╯`, fg: edge }]))
  if (b.from && !tight) out.push(...wrapped(wrap(b.from, room), (l) => row([{ text: l, fg: C.dim }])))
  // A code bot has no backtest: under its box, what the press approves, and what it doesn't.
  if (b.code) return [...out, ...(tight ? [row([{ text: fit(b.code.holds, room), fg: C.dim }])] : wrapped(wrap(b.code.holds, room), (l) => row([{ text: l, fg: C.dim }])))]
  if (tight) return [...out, row([{ text: "backtest".padEnd(10), fg: C.dim }, { text: fit(parts.tested, Math.max(6, room - 10)), fg: C.dim }])]
  out.push(...wrapped(wrap(parts.tested, Math.max(6, room - 10)), (l, i) => row([{ text: (i === 0 ? "backtest" : "").padEnd(10), fg: C.dim }, { text: l, fg: C.dim }])))
  // A live bot's card says, under its backtest, how a live run differs from it, short; a paper bot's keeps it in details.
  if (b.mode === "live" && b.differs)
    for (const l of wrapped(wrap(BACKTEST_DIFFERS_SHORT, Math.max(6, room - 10)), (l) => row([{ text: "".padEnd(10), fg: C.dim }, { text: l, fg: C.dim }]))) {
      FIRST_TO_GO.add(l)
      out.push(l)
    }
  return out
}

function openLines(card: ViewCard, opts: { now: number; focused: boolean; width: number; maxRows?: number; fitRows?: number; tight?: boolean; keysElsewhere?: boolean }): Line[] {
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
  // Too long for the row, the headline's end (the token's name) is cut: the chain and the countdown stay.
  const chain = onChain(card)
  const first: Seg[] = [{ text: fit(head, Math.max(4, room - cells(chain) - 2 - left.length)), fg: C.hi }, ...chain]
  const together = cells(first) + 3 + figures.length + 2 + left.length <= room
  if (figures && together) first.push({ text: `   ${figures}`, fg: C.dim })
  const pad = Math.max(2, room - cells(first) - left.length)
  out.push(row([...first, { text: " ".repeat(pad), fg: C.ink }, { text: left, fg: C.look }]))
  if (figures && !together) out.push(row([{ text: fit(figures, room), fg: C.dim }]))
  // The who line, kept with the headline when the card folds.
  const whoFrom = out.length
  // Line 2: who, the wallet that pays, the mode.
  // Every wallet is said the same way: "pays from embedded" beside a TEE card's "pays from tee-one (TEE · …)".
  const who = [card.agent, d.paysFrom ?? (d.walletLabel ? `pays from ${d.walletLabel}` : ""), d.modeNote ?? d.mode, card.side === "sell" && d.sharedWith?.length ? `shared with ${d.sharedWith.join(", ")}` : ""].filter(Boolean).join(" · ")
  // A trade names its token by its short address too, dim, at the end of this line, where it's never cut or folded:
  // a copy of a ticker reads exactly as the token the person knows. The full address is in details.
  const mintShort = card.kind === "trade" && d.mint ? short(d.mint) : undefined
  // A trigger's card says whose it is where whose always goes: the trigger, after ⚡, never the person. A bot's buy
  // says whose it is the same way: the bot, never the person, where a short pane drops why.
  const mark = d.trigger ? `⚡ ${d.trigger}` : d.bot && !d.botCard ? `bot ${d.bot}` : undefined
  const tail = (mintShort ? 3 + mintShort.length : 0) + (mark ? mark.length + 4 : 0)
  // A bridge says its route where who pays goes, then how it goes and what it costs: its four lines.
  if (d.bridge) {
    // Narrow, both ends stay: the agent's name goes first, then each wallet's kind.
    const kindless = d.bridge.route.replace(/ · TEE \(/g, " (")
    const route = [`${card.agent} · ${d.bridge.route}`, d.bridge.route, kindless].find((t) => t.length <= room) ?? kindless
    out.push(...wrapped(wrap(route, room), (t) => row([{ text: t, fg: C.dim }])))
    out.push(...wrapped(wrap(d.bridge.via, room), (t) => row([{ text: t, fg: C.dim }])))
  } else if (tail === 0) out.push(row([{ text: fit(who, room), fg: C.dim }]))
  else {
    // Narrow: "pays from" goes first, then a TEE wallet's own short address (its label stays), before anything is cut.
    const unsaid = who.replace("pays from ", "")
    const said = who.length + tail <= room ? who : unsaid.length + tail <= room ? unsaid : unsaid.replace(/ \(TEE · [^)]*\)/, " (TEE)")
    out.push(
      row([
        { text: fit(said, Math.max(4, room - tail)), fg: C.dim },
        ...(mintShort ? [{ text: ` · ${mintShort}`, fg: C.dim }] : []),
        ...(mark ? [{ text: " · ", fg: C.dim }, { text: fit(mark, room - 3 - (mintShort ? 3 + mintShort.length : 0)), fg: C.head }] : []),
      ]),
    )
  }
  // Real funds under a paper screen (a live bot's trade while the Candle Harness is on paper): said whole, in amber.
  if (d.modeDiffers) out.push(...wrapped(wrap(d.modeDiffers, room), (t) => row([{ text: t, fg: C.look }])))
  // The same name was read here for another token: which one this is, in amber.
  if (d.otherMint) out.push(...wrapped(wrap(d.otherMint, room), (t) => row([{ text: t, fg: C.look }])))
  // A change to a saved bot says what it changes, on its face: kept with the headline when the card folds.
  const changes = d.botCard?.changes
  if (changes) out.push(...wrapped(wrap(changes, room - 9), (l, i) => row([{ text: (i === 0 ? "changes" : "").padEnd(9), fg: C.dim }, { text: l, fg: C.hi }])))
  // What the trigger saw when it fired, in place of why.
  if (d.trigger && d.fired) out.push(row([{ text: "fired  ", fg: C.dim }, { text: fit(d.fired, room - 7), fg: C.ink }]))
  // On a wallet that trades inside limits, which figure sent this one to you: whole, in amber.
  if (d.cardBecause) out.push(...wrapped(wrap(d.cardBecause, room), (t) => row([{ text: t, fg: C.look }])))
  // Line 3: why, cut to one line; details has it whole. A trigger's proposal shows its exact line instead.
  const boxed = d.triggerCard?.kind !== undefined
  if (d.why && !(d.trigger && d.fired) && !boxed) optional(DROP_WHY, row([{ text: "why  ", fg: C.dim }, { text: fit(d.why, room - 5), fg: C.ink }]))
  if (d.risks) out.push(row([{ text: "risks  ", fg: C.dim }, { text: fit(d.risks, room - 7), fg: C.bad }]))
  if (d.preview) out.push(row([{ text: fit(d.preview, room), fg: C.dim }]))
  // What a launch publishes besides its name: its links by host and the start of its description, on one line.
  if (d.publishes) out.push(row([{ text: fit(d.publishes, room), fg: C.dim }]))
  // A creator fee, a staker share or launch rules the agent set: read before the press, whole, in amber.
  if (d.launchTerms) out.push(...wrapped(wrap(d.launchTerms, room), (t) => row([{ text: t, fg: C.look }])))
  // A rules bot's card: the bot in words, then how it trades, boxed, its warning and chips inside.
  const botBoxed = d.botCard !== undefined && !d.botCard.flatten
  if (d.botCard) out.push(...botBox(d.botCard, botBoxed ? d.warning : undefined, botBoxed ? (d.fills ?? []) : [], room, row, opts.tight))
  // A trigger's card: the exact line it saves, whole, then the trigger in words and how it runs.
  if (d.triggerCard && boxed) out.push(...triggerBox(d.triggerCard, d.fills ?? [], room, row))
  else if (d.triggerCard) {
    out.push(...wrapped(wrap(d.triggerCard.line, room), (t) => row([{ text: t, fg: C.hi }])))
    out.push(...wrapped(wrap(d.triggerCard.words, room), (t) => row([{ text: t, fg: C.ink }])))
    out.push(...wrapped(wrap(`${d.triggerCard.agent ? `${d.triggerCard.agent}'s trigger. ` : ""}${d.triggerCard.runs}`, room), (t) => row([{ text: t, fg: C.ink }])))
  }
  if (d.publicNote) out.push(row([{ text: fit(d.publicNote, room), fg: C.look }]))
  if (d.nearLimit) out.push(row([{ text: fit(d.nearLimit, room), fg: C.look }]))
  // A slippage bound the agent set: never run unseen. Looser than the default, in amber.
  if (d.slippage) out.push(row([{ text: fit(d.slippage, room), fg: d.slippageLooser ? C.look : C.dim }]))
  // Read before the press (a TEE wallet a revoke would strand): whole, in amber, never cut.
  if (d.warning && !boxed && !botBoxed) out.push(...wrapped(wrap(d.warning, room), (t) => row([{ text: t, fg: C.look }])))
  // A ceremony's line: what it shows or takes, read before the press, in amber, whole.
  if (d.paneShows) out.push(...wrapped(wrap(d.paneShows, room), (t) => row([{ text: t, fg: C.look }])))
  // Funds out to a new address: said plainly, then the address in full, in groups of four, amber.
  if (d.newAddress) {
    out.push(...wrapped(wrap("A new address: not one of your wallets or vault keys. Check every group:", room), (t) => row([{ text: t, fg: C.look }])))
    out.push(...wrapped(wrap(d.newAddress, room), (t) => row([{ text: t, fg: C.look }])))
  }
  // An owner card's own words: who a new key makes, what a rebind moves, what a preset drops.
  for (const note of d.paneNotes ?? []) out.push(...wrapped(wrap(note, room), (t) => row([{ text: t, fg: C.ink }])))
  // What to do about it, as commands put on the input line ("rebind to …", "change the name").
  if (!boxed && !botBoxed) for (const f of d.fills ?? []) out.push({ ...row([chip(f.label, "fill")]), ref: f.line })
  // A card that runs in the prompt pane: what the pane will ask, then that the agent can't see it.
  // A card that can't run here yet says only why, and the step that fixes it, in place of approve.
  if (!d.blocked) for (const step of d.paneSteps ?? []) for (const [i, t] of wrap(step, room - 2).entries()) optional(DROP_PANE_STEPS, row([{ text: `${i === 0 ? "· " : "  "}${t}`, fg: C.dim }]))
  if (d.paneNote && !d.blocked) for (const t of wrap(d.paneNote, room)) optional(DROP_PANE_STEPS, row([{ text: t, fg: C.look }]))
  if (d.blocked) {
    out.push(...wrapped(wrap(d.blocked.why, room), (t) => row([{ text: t, fg: C.look }])))
    out.push({ ...row([chip(d.blocked.fill.label, "fill", "primary")]), ref: d.blocked.fill.line })
  }
  // The actions, as chips; a card the Candle Harness can't run yet offers only reject.
  // A new address is approved only by a click on its own chip; Enter says so (keys.ts).
  // Drawn while another pane has the keys, ⏎ isn't this card's: the chip is a click target, and doesn't claim the key.
  const approveChip = d.newAddress ? chip("yes, a new address", "approve", "primary") : chip(opts.keysElsewhere ? "approve" : "⏎ approve", "approve", "primary")
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
  // Still taller than the pane has rows for (a bot's card in a tab's foot, or at 80×24): its headline and who stay on
  // top, then a line saying what's folded, then its foot (the box's end with a wallet of its own, and the chips).
  // The headline's figures, wrapped to a line of their own when narrow, fold with the middle: who pays matters more.
  if (opts.fitRows !== undefined && opts.fitRows >= 4 && kept.length > opts.fitRows) kept = kept.filter((l) => !FIRST_TO_GO.has(l))
  // A bot's card still too tall is drawn again tight: the box's title and its buys, sells, limits and worst each on
  // one line, and a code bot's command, since those are what the press approves; the steer's paragraph (its chip
  // stays), where the bot came from and the backtest's second line go first. Only then does the middle fold.
  if (opts.fitRows !== undefined && opts.fitRows >= 4 && kept.length > opts.fitRows && d.botCard?.parts && !opts.tight) return openLines(card, { ...opts, tight: true })
  if (opts.fitRows !== undefined && opts.fitRows >= 4 && kept.length > opts.fitRows) {
    const head = [out[0]!, out[whoFrom]!, ...(changes && opts.fitRows >= 5 ? [row([{ text: "changes  ", fg: C.dim }, { text: fit(changes, room - 9), fg: C.hi }])] : [])]
    const tail = opts.fitRows - head.length - 1
    // The foot starts on a whole line of its own: never partway through a sentence.
    let from = kept.length - tail
    while (from < kept.length && CONTINUED.has(kept[from]!)) from++
    const hidden = from - head.length - (changes && head.length > 2 ? wrap(changes, room - 9).length - 1 : 0)
    const more = row([{ text: fit(`… ${hidden} ${hidden === 1 ? "line" : "lines"} folded · ctrl-o details`, room), fg: C.dim }])
    kept = [...head, more, ...kept.slice(from)]
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
function folded(card: ViewCard, op: ViewOperation | undefined, expired: boolean, runnable?: ReadonlySet<string>): { mark: Seg; state: Seg; detail?: string; chips?: Seg[] } {
  const how = card.approvedHow ? APPROVED_HOW[card.approvedHow] : undefined
  // Nobody approved a trade the core ran inside its wallet's limits: it says so, not "approved".
  // A trigger's card says whose it was, never the person's; one from a turn a trigger woke says which.
  const by = card.display.trigger ? ` · by trigger "${card.display.trigger}"` : card.display.bot ? ` · by the bot "${card.display.bot}"` : card.display.woken ? ` · woke on trigger "${card.display.woken}"` : ""
  const approved = `${ranWithoutCard(card.approvedHow) ? "without a card" : how ? `approved ${how}` : "approved"}${by}`
  // A trigger's card nobody was there to press: its line again at a fresh price, the rest of a chain with it.
  if (expired && card.display.trigger) return { mark: { text: "◷", fg: C.dim }, state: { text: "expired, nobody pressed it", fg: C.dim }, chips: !runnable || runnable.has(card.cardId) ? [chip("run it now", "runNow")] : [] }
  // A bot's buy nobody pressed is skipped, as its card said: it buys again on its next signal.
  if (expired && card.display.bot) return { mark: { text: "◷", fg: C.dim }, state: { text: `expired, skipped by the bot "${card.display.bot}"`, fg: C.dim } }
  // A card made from its proposer's own words (a trigger's line, a bot's settings) is asked for again, never re-quoted.
  if (expired && card.display.askAgain) return { mark: { text: "◷", fg: C.dim }, state: { text: "expired, never ran: ask for it again", fg: C.dim } }
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
      // A bridge on its way says where the funds are; once there, what arrived and how long it took.
      const bridge = card.display.bridge
      if (bridge && (state === "pending" || (state === "submitting" && op?.waitingFor === undefined))) {
        return { mark: { text: "◌", fg: C.ink }, state: { text: state === "pending" ? bridge.arriving : "sending", fg: C.ink }, detail: approved }
      }
      if (bridge && state === "succeeded") {
        const received = (op?.result as { received?: unknown } | undefined)?.received
        const took = op?.settledAt !== undefined && op.startedAt !== undefined ? ` in ${tookWords(op.settledAt - op.startedAt)}` : ""
        return { mark: { text: "✓", fg: C.good }, state: { text: `${doneWord(card.kind)}${took}`, fg: C.good }, detail: [typeof received === "string" ? received : gets, approved].filter(Boolean).join(" · ") }
      }
      // Nothing live was sold, whatever Candle's success says: no "filled", and no sell chip.
      if (state === "succeeded" && (op?.paper || card.operation?.paper)) return { mark: { text: "✕", fg: C.look }, state: { text: PAPER_CLOSED_WORDS, fg: C.look }, detail: approved }
      // A follow, a rule or a stake is done, not filled: "filled" means a position.
      if (state === "succeeded") {
        // The receipt for a trade with no card: how long it took, and a sell chip for a buy.
        const took = ranWithoutCard(card.approvedHow) && op?.settledAt !== undefined && op.startedAt !== undefined ? ` in ${tookWords(op.settledAt - op.startedAt)}` : ""
        const sell = ranWithoutCard(card.approvedHow) ? sellLine(card) : undefined
        // Nobody saw a card, so the receipt names the token by its short address, as the card would have.
        const mint = ranWithoutCard(card.approvedHow) && card.kind === "trade" && card.display.mint ? short(card.display.mint) : undefined
        // What came back, from Candle's own answer where it says, else the card's estimate.
        const received = (op?.result as { received?: unknown } | undefined)?.received
        return { mark: { text: "✓", fg: C.good }, state: { text: `${doneWord(card.kind)}${took}`, fg: C.good }, detail: [typeof received === "string" ? received : gets, mint, approved].filter(Boolean).join(" · "), ...(sell ? { chips: [{ ...chip("sell", "fill"), ref: sell }] } : {}) }
      }
      // A swap whose first leg landed and whose second failed isn't "failed, nothing moved": what it sent left the wallet.
      const partial = op?.partial ?? card.operation?.partial
      if (state === "failed" && partial) {
        const sent = typeof card.params?.amount === "string" && typeof card.params?.from === "string" ? `${card.params.amount} ${card.params.from}` : "what it sent"
        return { mark: { text: "✕", fg: C.look }, state: { text: "part done: the first leg went, the second failed", fg: C.look }, detail: [`${sent} left the wallet · first leg ${short(partial.leg1)}`, approved].join(" · ") }
      }
      if (state === "failed" || state === "refused") {
        // A trade with no card that didn't run says so in its state, not after Candle's words.
        if (ranWithoutCard(card.approvedHow)) return { mark: { text: "✕", fg: C.bad }, state: { text: `${state} · without a card`, fg: C.bad }, ...(op?.error?.message ? { detail: op.error.message } : {}) }
        return { mark: { text: "✕", fg: C.bad }, state: { text: state, fg: C.bad }, detail: [op?.error?.message, approved].filter(Boolean).join(" · ") }
      }
      // One the core reads no further (a bridge it stopped following, a Hood trade whose job Candle ended) says why and
      // where to look: nothing is reading it back.
      if (state === "unknown" && op?.error && notFollowedFurther({ kind: op.kind ?? card.kind, error: op.error, result: op.result })) {
        return { mark: { text: "?", fg: C.look }, state: { text: "not followed further", fg: C.look }, detail: [op.error.message, approved].join(" · ") }
      }
      if (state === "unknown") return { mark: { text: "?", fg: C.look }, state: { text: "no answer yet: reading it back", fg: C.look }, detail: approved }
      if (state === "abandoned") return { mark: { text: "–", fg: C.dim }, state: { text: "abandoned: no longer followed", fg: C.dim }, detail: approved }
      // A Hood TEE wallet runs one trade at a time: this one is approved and goes once the wallet's last settles.
      if (state === "submitting" && op?.waitingFor !== undefined) return { mark: { text: "◌", fg: C.ink }, state: { text: "waits for the wallet's last trade", fg: C.ink }, detail: approved }
      return { mark: { text: "◌", fg: C.ink }, state: { text: state ?? "sending", fg: C.ink }, detail: approved }
    }
    default:
      return { mark: { text: "·", fg: C.dim }, state: { text: card.state, fg: C.dim } }
  }
}

/**
 * A trigger's card that ended, as one line: ⚡ and the trigger's name, what it saw, then what came of it
 * ("⚡ jupf stop  JUPF was $0.3990, under $0.40 → SELL 50% of JUPF filled in 5.0 s, without a card"). Nobody
 * asked for it in words, so it never reads as the person's; the slippage the agent never set stays under it.
 */
function firingLines(card: ViewCard, f: ReturnType<typeof folded>, head: string, chips: Seg[], opts: { width: number }): Line[] {
  const mark = `⚡ ${card.display.trigger}`
  const how = ranWithoutCard(card.approvedHow) ? ", without a card" : card.approvedHow ? `, approved ${APPROVED_HOW[card.approvedHow] ?? ""}`.trimEnd() : ""
  const failed = f.mark.fg === C.bad
  const ended = `${head} ${f.state.text}${failed || f.mark.text === "◷" ? "" : how}${failed && f.detail ? `: ${f.detail}` : ""}`
  const saw = card.display.fired ? `${card.display.fired} → ` : "→ "
  const chipCells = chips.reduce((n, c) => n + 2 + c.text.length, 0)
  // ⚡ takes two cells, one more than its length. The first line goes after the name, the rest under it; the
  // chips after the last words, or on a line of their own where they don't fit.
  const text = `${saw}${ended}`
  const first = wrap(text, Math.max(10, opts.width - mark.length - 3))[0] ?? ""
  const rest = text.slice(first.length).trim()
  const words = [first, ...(rest ? wrap(rest, Math.max(10, opts.width - 2)) : [])]
  if (chips.length && (words.length === 1 ? mark.length + 3 + first.length : 2 + words.at(-1)!.length) + chipCells > opts.width) words.push("")
  const out: Line[] = []
  words.forEach((t, i) => {
    const arrow = t.indexOf("→ ")
    const segs: Seg[] = i === 0 ? [{ text: mark, fg: C.head }, { text: "  ", fg: C.ink }] : [{ text: "  ", fg: C.ink }]
    if (arrow >= 0) segs.push({ text: t.slice(0, arrow), fg: C.ink }, { text: "→ ", fg: C.dim }, { text: t.slice(arrow + 2), fg: f.state.fg })
    else segs.push({ text: t, fg: i === 0 && card.display.fired ? C.ink : f.state.fg })
    if (i === words.length - 1) for (const c of chips) segs.push({ text: "  ", fg: C.ink }, c)
    out.push({ segs, cardId: card.cardId })
  })
  if (ranWithoutCard(card.approvedHow) && card.display.slippage) out.push({ segs: [{ text: `    ${fit(card.display.slippage, Math.max(10, opts.width - 4))}`, fg: card.display.slippageLooser ? C.look : C.dim }], cardId: card.cardId })
  return out
}

/** " · on Hood", dim, for a card on a chain other than Solana: it says so on its first line, always. Not a bridge, which crosses both. */
function onChain(card: ViewCard): Seg[] {
  if (!card.chain || card.chain === "solana" || card.kind === "bridge") return []
  return [{ text: ` · on ${chainName(card.chain)}`, fg: C.dim }]
}

export function cardLines(card: ViewCard, opts: { now: number; focused: boolean; width: number; op?: ViewOperation; maxRows?: number; fitRows?: number; runnable?: ReadonlySet<string>; /** Another pane has the keys, so ⏎ doesn't approve this card yet: only a click does. */ keysElsewhere?: boolean }): Line[] {
  const awaiting = card.state === "awaiting_approval"
  const expired = card.state === "expired" || (awaiting && opts.now >= Date.parse(card.expiresAt))
  if (awaiting && !expired) return openLines(card, opts)
  const f = folded(card, opts.op, expired, opts.runnable)
  const head = card.display.headline ?? card.display.title
  const chips = f.chips ?? []
  if (card.display.trigger) return firingLines(card, f, head, chips, opts)
  const chipCells = chips.reduce((n, c) => n + 2 + c.text.length, 0)
  const out: Line[] = []
  // A long headline keeps its line, and what happened goes under it whole, never cut off (an owner step's words).
  if (5 + head.length + 2 + f.state.text.length + chipCells > opts.width) {
    out.push({ segs: [{ text: "  ", fg: C.ink }, f.mark, { text: " ", fg: C.ink }, { text: fit(head, Math.max(10, opts.width - 4 - chipCells - cells(onChain(card)))), fg: C.hi }, ...onChain(card), ...chips.flatMap((c) => [{ text: "  ", fg: C.ink }, c])], cardId: card.cardId })
    out.push(...wrapped(wrap(f.state.text, Math.max(10, opts.width - 4)), (t) => ({ segs: [{ text: `    ${t}`, fg: f.state.fg }], cardId: card.cardId })))
    if (f.detail) out.push(...wrapped(wrap(f.detail, Math.max(10, opts.width - 4)), (t) => ({ segs: [{ text: `    ${t}`, fg: C.dim }], cardId: card.cardId })))
    for (const n of paneNext(opts.op).filter((s) => "line" in s)) if ("line" in n) out.push({ segs: [{ text: "    next  ", fg: C.dim }, chip(n.label, "fill")], cardId: card.cardId, ref: n.line })
    return out
  }
  const segs: Seg[] = [{ text: "  ", fg: C.ink }, f.mark, { text: " ", fg: C.ink }, { text: head, fg: C.hi }, ...onChain(card), { text: "  ", fg: C.ink }, f.state]
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
    out.push(...wrapped(wrap(f.detail!, Math.max(10, opts.width - 4)), (t) => ({ segs: [{ text: `    ${t}`, fg: C.dim }], cardId: card.cardId })))
  }
  // A trade with no card: the figures it was checked against, under it. Not once it failed or was refused:
  // the core hands its spend back, so the figures it was sent at no longer hold.
  const ended = opts.op?.state ?? card.operation?.state
  const inside = ranWithoutCard(card.approvedHow) && ended !== "failed" && ended !== "refused" ? insideWords(card.withoutCard) : undefined
  if (inside) out.push(...wrapped(wrap(inside, Math.max(10, opts.width - 4)), (t) => ({ segs: [{ text: `    ${t}`, fg: C.dim }], cardId: card.cardId })))
  // Nobody saw a card, so the receipt says the slippage the agent set, as the card would have.
  if (ranWithoutCard(card.approvedHow) && card.display.slippage) out.push({ segs: [{ text: `    ${fit(card.display.slippage, Math.max(10, opts.width - 4))}`, fg: card.display.slippageLooser ? C.look : C.dim }], cardId: card.cardId })
  // And that the same name was read here for another token, in amber, as its card would have.
  if (ranWithoutCard(card.approvedHow) && card.display.otherMint) out.push(...wrapped(wrap(card.display.otherMint, Math.max(10, opts.width - 4)), (t) => ({ segs: [{ text: `    ${t}`, fg: C.look }], cardId: card.cardId })))
  // A pane step's next steps: each a chip that puts its command on the input line.
  for (const n of paneNext(opts.op).filter((s) => "line" in s)) if ("line" in n) out.push({ segs: [{ text: "    next  ", fg: C.dim }, chip(n.label, "fill")], cardId: card.cardId, ref: n.line })
  return out
}
