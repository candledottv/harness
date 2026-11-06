// The agent pane: the active agent's conversation, with tool calls as a quiet line and each address labelled
// with the source that showed it. On first open the agent speaks first. After a kill, the kill report is
// pinned at the top until resume.
// An operation Candle didn't answer is pinned under it, with re-send and abandon, until it settles.
// Cards sit at the bottom, inline: every open card, and the active agent's recent closed ones.
import type { KillReport } from "../../core/kill"
import { doneWord, PAPER_CLOSED_WORDS } from "../../core/trade-log"
import { walletName } from "../../core/wallet-names"
import { ago, shortAddress, usd, wrap } from "../format"
import type { Rect } from "../layout"
import { type Exchange, unanswered, type ViewCard, type ViewOperation } from "../store"
import { pnlWords } from "../status-bar"
import { C, fit } from "../theme"
import { cardLines } from "./card"
import { type Act, blank, chip, type Line, line, Lines, type Seg } from "./lines"
import { type PaneEdges, innerCols, innerRows, Pane } from "./pane"
import { MARK, markdownRows, type Run, type Style } from "../markdown"
import type { AwaySummary } from "../../core/away"
import { awayNoteLines } from "./away"
import type { OnboardingView } from "../../setup/onboarding"

const STATE_WORDS: Record<string, string> = { failed: "failed", refused: "refused", unknown: "no answer yet", abandoned: "abandoned", pending: "pending", submitting: "sending" }

/** A labelled line, its value wrapped under the label. */
function labelled(label: string, value: string, width: number, fg: string = C.ink): Line[] {
  const pad = label.padEnd(12)
  return wrap(value, Math.max(10, width - pad.length)).map((part, i) => ({ segs: [{ text: i === 0 ? pad : " ".repeat(pad.length), fg: C.dim }, { text: part, fg }] }))
}

/**
 * The kill report, in at most `maxRows` lines. When it doesn't fit, detail goes in this order: the
 * steps for stopping other apps (shortened to one line), what you stand at, what was spent, what was
 * stopped. What's still open, what's in flight and how to resume always show (at 37 rows the report had
 * run past its slot and `resume` was cut off).
 */
export function killReportLines(report: KillReport, operations: Readonly<Record<string, ViewOperation>>, now: number, width: number, maxRows = Number.POSITIVE_INFINITY): Line[] {
  const at = Date.parse(report.at)
  const head: Line[] = [{ segs: [{ text: "KILL SWITCH ON", fg: C.bad, bold: true }, { text: fit(` · ${ago(at, now, Number.POSITIVE_INFINITY).text} · buys paused, the agent stopped`, Math.max(0, width - 14)), fg: C.dim }] }, blank()]
  const stoppedWhat = [
    ...report.stopped.turns.map((t) => `${t.agent}'s turn`),
    ...report.stopped.cards.map((c) => `withdrew ${c.title} (${c.agent})`),
  ]
  const stopped = labelled("stopped", stoppedWhat.length ? stoppedWhat.join(" · ") : "nothing was running", width)
  const open: Line[] = []
  const count = report.stillOpen.length
  // The open sells, unstakes, claims and post deletes are drawn below as full cards, one press each. An
  // older report names no kind: every card in it is a sell.
  const sells = report.stillOpen.every((c) => c.kind === undefined || c.side === "sell")
  const what = sells ? (count === 1 ? "1 sell" : `${count} sells`) : count === 1 ? "1 card" : `${count} cards`
  if (count) open.push(...labelled("open", `${what}, below: one press to approve, or let ${count === 1 ? "it" : "them"} expire, which is safe`, width))
  const inFlight: Line[] = []
  for (const op of report.inFlight) {
    const state = operations[op.opId]?.state ?? op.state
    // A live sell Candle closed as paper sold nothing live: never "filled".
    const ended = operations[op.opId]?.paper ? PAPER_CLOSED_WORDS : doneWord(operations[op.opId]?.kind)
    // A lost swap or stake is read back by sending it again under its id, so that waits for a resume.
    const held = op.held && state === "unknown" ? "no answer yet; reading it back re-sends it under its id, so that waits until you resume" : undefined
    inFlight.push(...labelled("in flight", `${op.title} (${op.agent}): ${state === "succeeded" ? ended : (held ?? STATE_WORDS[state] ?? state)}`, width))
  }
  const standing: Line[] = []
  const s = report.standing
  const pnl = pnlWords(s.pnl, undefined, now)
  if (s.portfolioAgeMs === null || s.wallets.length === 0) {
    standing.push(...labelled("standing", `— (no portfolio read yet) · ${pnl}`, width))
  } else {
    const age = ago(now - s.portfolioAgeMs, now, 60_000).text
    for (const w of s.wallets) {
      const who = w.agents.length ? ` (${w.agents.join(", ")})` : ""
      const unpriced = w.unpriced ? ` · ${w.unpriced} unpriced` : ""
      standing.push(...labelled("standing", `${w.name ?? walletName(undefined, { address: w.wallet, ...(w.kind ? { kind: w.kind } : {}), ...(w.label ? { label: w.label } : {}) })}${who}: SOL ${usd(w.solUsd)} · tokens ${usd(w.tokensUsd)}${unpriced} · ${pnl} · prices ${age}`, width))
    }
  }
  const spent = s.spentToday.flatMap((sp) => labelled("spent", `${sp.agent} ${usd(sp.usd)} of ${usd(sp.perDayUsd)} today`, width))
  // A wallet that trades inside limits: the pause holds its buys and swaps, and its sells still go. Never dropped.
  // Short, so it fits two lines in a narrow pane (the core's own words ran to three at 80×24).
  const held = (report.insideLimits ?? []).flatMap((w) => labelled("held", `${w.name === "embedded" ? "embedded wallet" : w.name}: inside limits, held by the pause; sells go`, width))
  const candleStopped = report.notStopped.candleStopped.flatMap((c) => labelled("", `Candle has stopped ${c.agent}: ${c.code}`, width, C.look))
  // The steps themselves open from the chip, so the report stays short.
  // A chip that doesn't fit after its words goes on the next line, under them, so a narrow pane never cuts it off.
  const withChip = (label: string, words: string, c: Line["segs"][number], ref?: string): Line[] => {
    const head = { text: label.padEnd(12), fg: C.dim }
    const refed = ref === undefined ? {} : { ref }
    if (12 + words.length + 2 + c.text.length <= width) return [{ segs: [head, { text: `${words}  `, fg: C.ink }, c], ...refed }]
    return [{ segs: [head, { text: words, fg: C.ink }] }, { segs: [{ text: "".padEnd(12), fg: C.dim }, c], ...refed }]
  }
  const notStoppedLines = withChip("not stopped", "other apps on these keys", chip("how to stop them", "stopHelp"))
  // A TEE wallet trades on through its key's other apps: its own stop, put on the input line as the
  // user's, with the key it's bound to. It asks for the vault passphrase.
  const disableTee: Line[] = report.notStopped.steps.flatMap((s) =>
    (s.disableTee ?? []).flatMap((t) => withChip("", `TEE wallet ${t.wallet} (${s.agent})`, chip("stop it for good", "fill"), `${t.command} as ${s.agent}`)),
  )
  const notStopped = [...notStoppedLines, ...disableTee, ...candleStopped]
  const resume = labelled("resume", report.resume, width)

  const sections = { stopped, standing, spent, notStopped }
  const total = () => head.length + sections.stopped.length + open.length + held.length + inFlight.length + sections.standing.length + sections.spent.length + sections.notStopped.length + resume.length
  const drops: (() => void)[] = [
    () => (sections.standing = []),
    () => (sections.spent = []),
    () => (sections.stopped = []),
  ]
  for (const drop of drops) if (total() > maxRows) drop()
  const out = [...head, ...sections.stopped, ...open, ...held, ...inFlight, ...sections.standing, ...sections.spent, ...sections.notStopped]
  // Still too tall: what must show keeps the room, and resume stays last.
  return [...out.slice(0, Math.max(head.length, maxRows - resume.length)), ...resume]
}

/** What an operation was, from its card when the view has it, else from what was sent. */
export function operationTitle(op: ViewOperation, cards: readonly ViewCard[]): string {
  const title = cards.find((c) => c.cardId === op.cardId)?.display.title
  if (title) return title
  const p = op.params ?? {}
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined)
  if (op.kind === "swap") return `SWAP ${str(p.amount) ?? "?"} ${str(p.from) ?? "?"} → ${str(p.to) ?? "?"}`
  if (op.kind === "trade") {
    const size = str(p.amount) ?? (str(p.amountUsd) ? `$${str(p.amountUsd)}` : str(p.percent) ? `${str(p.percent)}%` : "?")
    return `${(str(p.side) ?? "trade").toUpperCase()} ${size} · ${typeof p.mint === "string" ? shortAddress(p.mint) : "?"}`
  }
  return op.tool ?? op.kind ?? "an operation"
}

/** The kinds whose every tool carries an id, and the id fields and CLI flags others may: a re-send under one never runs twice. */
const ID_KINDS = new Set(["trade", "swap", "launch", "stake"])
const ID_PARAMS = ["clientTradeId", "clientSwapId", "clientLaunchId", "clientStakeId", "rewardId"]
const ID_FLAGS = ["--client-trade-id", "--client-stake-id"]

/** Whether a re-send goes under an id Candle or the CLI replays. A post, a fee claim, a profile edit or an upload has none. */
export function resendsUnderId(op: ViewOperation): boolean {
  if (op.kind !== undefined && ID_KINDS.has(op.kind)) return true
  const p = op.params ?? {}
  if (ID_PARAMS.some((k) => typeof p[k] === "string")) return true
  return Array.isArray(p.argv) && p.argv.some((a) => ID_FLAGS.includes(a as string))
}

/** What a re-send came to, as the chip promised it: under its id, or with none, so it may have run twice. */
export function resentWords(op: ViewOperation, r: { state: string; paper?: boolean }): string {
  const came = r.state === "succeeded" ? (r.paper ? PAPER_CLOSED_WORDS : doneWord(op.kind)) : r.state === "unknown" ? "still no answer, reading it back" : r.state
  return resendsUnderId(op) ? `Re-sent under the same id: ${came}.` : `Re-sent with no id, so it may have run twice: ${came}. Check candle.tv.`
}

/**
 * Each operation Candle didn't answer: what it was, that the core is reading it back, and the user's
 * two choices. A re-send under the tool's id never runs twice; one with no id may, and says so.
 */
export function unansweredLines(operations: Readonly<Record<string, ViewOperation>>, cards: readonly ViewCard[], now: number, width: number): Line[] {
  const out: Line[] = []
  for (const op of unanswered({ operations })) {
    const since = op.startedAt ? ` · ${ago(op.startedAt, now, Number.POSITIVE_INFINITY).text}` : ""
    // A Hacc change is read back from Hacc's state and never sent again: abandon only.
    if (op.kind === "hacc") {
      out.push(...wrap(`NO ANSWER FROM HACC · ${operationTitle(op, cards)} · ${op.agent}${since}`, Math.max(10, width)).map((t) => line(t, C.look)))
      out.push(...wrap("The core reads Hacc's state back and settles it here. It's never sent again; if it stays, abandon it and ask again:", Math.max(10, width - 2)).map((t) => line(`  ${t}`, C.dim)))
      out.push(...chipRows([chip("abandon (stop following it)", "abandon")], width).map((l) => ({ ...l, cardId: op.cardId })))
      continue
    }
    out.push(...wrap(`NO ANSWER FROM CANDLE · ${operationTitle(op, cards)} · ${op.agent}${since}`, Math.max(10, width)).map((t) => line(t, C.look)))
    // What Candle did answer, where it answered at all: the person decides from it.
    if (op.error?.message) out.push(...wrap(`Candle said: ${op.error.message}`, Math.max(10, width - 2)).map((t) => line(`  ${t}`, C.ink)))
    // A re-send already out: its answer settles it here, and a second click would only be refused.
    if (op.resending) {
      out.push(...wrap("Re-sending it: its answer settles it here.", Math.max(10, width - 2)).map((t) => line(`  ${t}`, C.dim)))
      continue
    }
    if (resendsUnderId(op)) {
      out.push(...wrap("The core reads it back by its id and settles it here if Candle has it. If it stays, check candle.tv for whether it ran, then click one (or type resend or abandon):", Math.max(10, width - 2)).map((t) => line(`  ${t}`, C.dim)))
      out.push(...chipRows([chip("re-send (same id: never runs twice)", "resend"), chip("abandon (stop following it)", "abandon")], width).map((l) => ({ ...l, cardId: op.cardId })))
      continue
    }
    const note = cards.find((c) => c.cardId === op.cardId)?.display.resendNote
    out.push(...wrap(`It has no id, so nothing can read it back, and a re-send may run it a second time.${note ? ` ${note}` : ""} Check candle.tv for whether it ran, then click one (or type resend or abandon):`, Math.max(10, width - 2)).map((t) => line(`  ${t}`, C.dim)))
    out.push(...chipRows([chip("re-send (no id: may run twice)", "resend"), chip("abandon (stop following it)", "abandon")], width).map((l) => ({ ...l, cardId: op.cardId })))
  }
  return out
}

/** Chips on one row where they fit whole, else one a row: a chip cut short ("abandon (stop follo…") says nothing. */
function chipRows(chips: readonly Seg[], width: number): Line[] {
  const cells = 2 + chips.reduce((n, c) => n + c.text.length, 0) + 3 * (chips.length - 1)
  if (cells <= width) return [{ segs: [{ text: "  ", fg: C.ink }, ...chips.flatMap((c, i) => (i ? [{ text: "   ", fg: C.ink }, c] : [c]))] }]
  return chips.map((c) => ({ segs: [{ text: "  ", fg: C.ink }, c] }))
}

/**
 * The agent speaking first, with the Candle Harness's one risk notice: said once here, so the agent leaves its caveats
 * out of every answer (a disclaimer belongs once, at setup, not on every turn).
 */
export const RISK_NOTICE = "Nothing here is financial advice. Signals, backtests and replays describe the past, and the agent can be wrong: check what matters, and size what you can lose."

/**
 * The welcome in the short agent pane across a tab's foot: its first line and one thing to
 * try on that tab, then the risk notice where the rows hold it, so the pane shows the greeting's top, never its tail.
 */
export function shortGreetingLines(agent: string, width: number, rows: number, tip: string): Line[] {
  const head = [...wrap(`${agent} here. I read Candle and its market data for you, and propose trades you approve with one key.`, width).map((t) => line(t, C.ink)), ...wrap(`Try ${tip}`, width).map((t) => line(t, C.ink))]
  const risk = [blank(), ...wrap(RISK_NOTICE, width).map((t) => line(t, C.dim))]
  return head.length + risk.length <= rows ? [...head, ...risk] : head
}

/** One thing to try on a tab, by what's on it, for the short agent pane's welcome. */
export function tabTip(panes: readonly string[]): string {
  if (panes.includes("perps")) return "a question above, or ask me about perps on Hyperliquid."
  if (panes.includes("pnl")) return 'asking: "how am I doing today?"'
  if (panes.includes("journal")) return 'asking: "what did I trade yesterday?"'
  if (panes.includes("signals") && !panes.some((p) => ["feed", "new", "graduated", "final-stretch"].includes(p))) return "ctrl-t on a signal: it asks me what it means."
  return "ctrl-t on a row: it asks me about that token."
}

/**
 * What setup made, for the welcome after it: the agent, its engine and model, the account,
 * the wallet it pays from and how, its limits with who holds each, and the mode. Each part only once the core says it.
 */
export interface SetUpSummary {
  agent: string
  engine?: string
  profile?: string
  wallet?: string
  limits?: string
  mode?: "paper" | "live"
}

/** The welcome's first lines after setup: what was set up, each part a labelled row, before the agent's own words. */
export function setUpLines(s: SetUpSummary, width: number): Line[] {
  const rows: [string, string | undefined][] = [
    [s.agent, s.engine ? `${s.engine}${s.profile ? `, as ${s.profile}` : ""}` : undefined],
    ["wallet", s.wallet],
    ["limits", s.limits],
    ["mode", s.mode === "paper" ? "paper; go live from the status bar" : s.mode === "live" ? "live: real funds, each trade on a card" : undefined],
  ]
  const label = Math.max(...rows.map(([l]) => l.length)) + 2
  const out: Line[] = [{ segs: [{ text: "✓ ", fg: C.good }, { text: "Set up, and ready", fg: C.head }] }]
  for (const [l, v] of rows) {
    if (!v) continue
    wrap(v, Math.max(10, width - label - 2)).forEach((t, i) => out.push({ segs: [{ text: `  ${i === 0 ? l.padEnd(label) : "".padEnd(label)}`, fg: C.dim }, { text: t, fg: C.ink }] }))
  }
  return [...out, blank()]
}

/** The agent speaking first; after setup in this view, what was set up takes the intro's place. */
export function greetingLines(agent: string, width: number, setUp?: SetUpSummary): Line[] {
  const intro = `${agent} here. I read Candle and its market data for you (the feed, the signal tape, wallets worth watching, markets, token checks, your positions), propose trades as cards you approve with one key, and run any candle command you ask for. Paper trades need no card.`
  return [
    ...(setUp ? setUpLines(setUp, width) : [...wrap(intro, width).map((t) => line(t, C.ink)), blank()]),
    line("Try:", C.dim),
    line("  · what's the tape saying in the last hour?", C.ink),
    line("  · check this token before I buy: <paste a mint>", C.ink),
    line("  · buy $10 of it in paper mode", C.ink),
    blank(),
    // Said plainly, since a person may ask what the Candle Harness is for if the agent can't watch while they're away.
    ...wrap(WHEN_I_ACT, width).map((t) => line(t, C.dim)),
    ...wrap(RISK_NOTICE, width).map((t) => line(t, C.dim)),
  ]
}

/** When the agent acts: from a message, never on its own yet. One row at 80×24, so the welcome after setup still fits. */
export const WHEN_I_ACT = "I act only when you message me, for now."

/**
 * The agent pane with no agent yet. Onboarding's own screen draws every step up to the agent's key and
 * beyond, so this says only that setup is open, for the moment before its first read and for any other
 * window on the same core.
 */
export function setupLines(setup: OnboardingView | undefined, width: number): Line[] {
  const out: Line[] = [...wrap("No agent yet: setup runs full screen in the main window, and each step is read back from where it lives.", width).map((t) => line(t, C.ink)), blank()]
  if (!setup) return [...out, line("Reading where setup stands…", C.dim)]
  const revoke = setup.steps.find((s) => s.id === "key")?.revoke ?? []
  for (const r of revoke) out.push(...wrap(`A key was made but not stored: revoke ${r.prefix} before making another (${r.line}).`, width).map((t) => line(t, C.look)), blank())
  return [...out, ...wrap("Nothing trades until your agent and its limits exist.", width).map((t) => line(t, C.dim))]
}

// The figure gate's mark: a figure no tool showed is dimmed, with a `?`
// after it. `≈` keeps its own meaning, an estimate. The mark rides through the Markdown and the wrapping
// as one private-use character where the `?` will stand (markdown.ts's MARK), so every width counts it;
// the figure is the number (with its `$` and any K, M or B) just before it.
const MARKED_FIGURE = /\$?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:bn|mn|[KMBkmb])?$/
export const FIGURE_LEGEND = "? not read from a tool"

/** The reply with a mark after each figure the gate marked; one that no longer sits where it says is left alone. */
export function markFigures(reply: string, marked: readonly { at: number; text: string }[] | undefined): string {
  let out = reply
  for (const m of [...(marked ?? [])].sort((a, b) => b.at - a.at)) {
    if (out.slice(m.at, m.at + m.text.length) === m.text) out = `${out.slice(0, m.at + m.text.length)}${MARK}${out.slice(m.at + m.text.length)}`
  }
  return out
}

/** A run as segments, in its style's colour (all dim for a turn that didn't finish); each marked figure and its `?` dimmed. */
function runSegs(run: Run, muted: boolean): Seg[] {
  const look: Record<Style, { fg: string; bold?: boolean }> = {
    ink: { fg: C.ink },
    hi: { fg: C.mdBright },
    bold: { fg: C.mdBright, bold: true },
    head: { fg: C.mdHead, bold: true },
    dim: { fg: C.mdDim },
    code: { fg: C.mdCode },
    quote: { fg: C.mdQuote },
  }
  const { fg, bold } = muted ? { fg: C.dim } : look[run.style]
  const seg = (text: string, color = fg): Seg => ({ text, fg: color, ...(bold && color === fg ? { bold } : {}) })
  if (!run.text.includes(MARK)) return [seg(run.text)]
  const segs: Seg[] = []
  const parts = run.text.split(MARK)
  parts.forEach((part, i) => {
    const figure = i < parts.length - 1 ? (MARKED_FIGURE.exec(part)?.[0] ?? "") : ""
    const before = part.slice(0, part.length - figure.length)
    if (before) segs.push(seg(before))
    if (i < parts.length - 1) segs.push(seg(`${figure}?`, C.dim))
  })
  return segs
}

/** A reply's rows as the pane draws them: its Markdown rendered (markdown.ts), wrapped to `width`. */
export function replyRows(text: string, width: number, muted = false): Seg[][] {
  return markdownRows(text, width).map((row) => row.flatMap((run) => runSegs(run, muted)))
}

/**
 * The addresses a reply named, under it: each short, as a chip that opens it in the token pane (it never
 * trades), with the source that showed it and a ⧉ chip that copies it in full (the reply shows them
 * short). A copied one shows in full here for a while, to select by hand where the copy can't land.
 */
export function addressLines(labelled: readonly { address: string; source: string }[], width: number, shownInFull?: string): Line[] {
  if (!labelled.length) return []
  const rows: Seg[][] = [[{ text: "⌖ ", fg: C.dim }]]
  let len = 2
  labelled.forEach((l, i) => {
    const name = l.address === shownInFull ? l.address : shortAddress(l.address)
    const item: Seg[] = [
      ...(i ? [{ text: "· ", fg: C.dim }] : []),
      { ...chip(name, "openToken"), ref: l.address },
      { text: ` from ${l.source} `, fg: C.dim },
      { ...chip("⧉", "copy"), ref: l.address },
      { text: " ", fg: C.dim },
    ]
    const size = item.reduce((n, s) => n + s.text.length, 0)
    if (len > 2 && len + size > width) {
      rows.push([{ text: "  ", fg: C.dim }])
      len = 2
    }
    rows.at(-1)!.push(...item)
    len += size
  })
  return rows.map((segs) => ({ segs: [{ text: "  ", fg: C.dim }, ...segs] }))
}

const YOU = "you › "
const CONTINUED = "      "

/**
 * The conversation: "you ›" dim and your words bright, the agent's in the content colour, a
 * blank line between and around each exchange. Every answer is shown whole (the pane scrolls), and a
 * finished one ends with a ⧉ that copies all of it, as written.
 */
export function conversationLines(exchanges: readonly Exchange[], width: number, opts: { shownInFull?: string } = {}): Line[] {
  const out: Line[] = []
  exchanges.forEach((e, i) => {
    if (i > 0) out.push(blank())
    const you = wrap(e.user, Math.max(10, width - 6))
    you.forEach((t, j) => out.push({ segs: [{ text: j === 0 ? YOU : CONTINUED, fg: C.dim }, { text: t, fg: C.hi }] }))
    if (e.queued) out.push(line("  (waiting for the turn before it · esc stops that one, and this runs)", C.dim))
    out.push(blank())
    if (e.tools.length) out.push(...wrap(`⌁ ${e.tools.map((t) => t.split(" ")[0]).join(" · ")}`, Math.max(10, width - 2)).map((t) => line(`  ${t}`, C.dim)))
    const reply = (e.streaming ? e.reply : markFigures(e.reply, e.marked)) || (e.streaming ? "…" : "")
    const muted = Boolean(e.outcome && e.outcome !== "done")
    const rows = replyRows(reply, Math.max(10, width - 2), muted)
    const lines: Line[] = rows.map((segs) => ({ segs: [{ text: "  ", fg: muted ? C.dim : C.ink }, ...segs] }))
    // The copy chip goes after the answer's last words where it fits, else on a row of its own.
    if (!e.streaming && e.reply.trim() && lines.length) {
      const last = lines.at(-1)!
      const copy = { ...chip("⧉", "copyReply"), ref: e.turnId }
      const used = last.segs.reduce((n, sg) => n + sg.text.length, 0)
      if (used + 1 + copy.text.length <= width) last.segs = [...last.segs, { text: " ", fg: C.dim }, copy]
      else lines.push({ segs: [{ text: "  ", fg: C.dim }, copy] })
    }
    out.push(...lines)
    if (!e.streaming && reply.includes(MARK)) out.push(line(`  ${FIGURE_LEGEND}`, C.dim))
    out.push(...addressLines(e.labelled ?? [], Math.max(10, width - 2), opts.shownInFull))
    // Under a conversation from before the core started, so a figure in it doesn't read as today's.
    if (e.earlier && !exchanges[i + 1]?.earlier) out.push(blank(), earlierLine(e.earlier, width))
  })
  return out
}

/** "── earlier · Sat 31 Oct 22:45 ────": the last restored exchange's day and time, dim, across the pane. */
export function earlierLine(iso: string, width: number): Line {
  const at = new Date(iso)
  const day = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
  const text = `── earlier · ${day} ${at.toTimeString().slice(0, 5)} `
  return line(text.padEnd(Math.max(text.length, width), "─").slice(0, Math.max(10, width)), C.dim)
}

/**
 * The conversation's rows from `start` to `end`. While a turn runs, a long answer streaming in would push
 * what you asked off the top (the prompt must stay on screen while the agent thinks), so the
 * newest "you ›" line, if it's above the window, takes the window's first row.
 */
export function withPrompt(convo: readonly Line[], start: number, end: number, working: boolean): Line[] {
  const shown = convo.slice(start, end)
  if (!working || !shown.length) return shown
  const asked = convo.findLastIndex((l) => l.segs[0]?.text === YOU)
  if (asked < 0 || asked >= start) return shown
  const prompt = convo[asked]!
  const more = convo[asked + 1]?.segs[0]?.text === CONTINUED
  return [more ? { segs: [...prompt.segs.slice(0, -1), { ...prompt.segs.at(-1)!, text: `${prompt.segs.at(-1)!.text} …` }] } : prompt, ...shown.slice(1)]
}

export interface AgentPaneProps {
  rect: Rect
  agent: string
  /** No agent yet: setup's steps in place of the conversation, as the core last read them. */
  setup?: { view?: OnboardingView }
  /** Setup just finished in this view: what it made, first in the welcome. */
  setUp?: SetUpSummary
  exchanges: readonly Exchange[]
  killReport: KillReport | null
  operations: Readonly<Record<string, ViewOperation>>
  /** The cards drawn inline: open ones (any agent), then the active agent's recent closed ones. */
  cards: readonly ViewCard[]
  focusedCardId: string | undefined
  cardsFocused: boolean
  now: number
  /** Rows scrolled up from the newest. */
  scroll: number
  /** An address just copied, shown in full under its reply. */
  shownInFull?: string
  focused: boolean
  working: boolean
  onFocus: () => void
  onScroll: (delta: number) => void
  /** Told, as drawn, the most rows the conversation can scroll up, so the keys and wheel stop there. */
  onReach?: (max: number) => void
  onAct: (cardId: string, act: Act) => void
  /** Its border, dragged, resizes it. */
  edges?: PaneEdges
  /** The agent's change to the screen waiting on a click, under its reply. */
  offer?: AgentOffer
  /** One thing to try on this tab, for the short pane's welcome. */
  tip?: string
  /** While you were away: the note at the top, in the rows the cards leave. Its chips are the `away` act. */
  away?: AwaySummary
}

/** The words and chips of an agent's change to the screen: keep and discard, undo, ✕. A chip's click is the `offer` act, by its label. */
export interface AgentOffer {
  words: string
  chips: readonly string[]
}

/** The offer under the conversation: its words in the attention colour, then its chips, on one line where they fit. */
export function offerLines(offer: AgentOffer, width: number): Line[] {
  const chips = offer.chips.flatMap((label, i) => [...(i ? [{ text: " ", fg: C.dim }] : []), { ...chip(label, "offer"), ref: label }])
  const chipCells = chips.reduce((n, s) => n + s.text.length, 0)
  if (offer.words.length + 2 + chipCells <= width) return [blank(), { segs: [{ text: `${offer.words}  `, fg: C.look }, ...chips] }]
  return [blank(), ...wrap(offer.words, width).map((t) => line(t, C.look)), { segs: chips }]
}

/**
 * The open card Enter acts on (keys.ts, focusedCard: the one picked, else the newest), to shade. With
 * one card it's shaded only while the cards have focus; with several it always is, so "the
 * highlighted one" is on screen from the input line too (two cards had looked the same).
 */
export function highlightedCard(open: readonly { cardId: string }[], focusedCardId: string | undefined, cardsFocused: boolean): string | undefined {
  if (!cardsFocused && open.length < 2) return undefined
  return (open.find((c) => c.cardId === focusedCardId) ?? open.at(-1))?.cardId
}

/** The agent pane's title: the agent, and whether it's working or scrolled up. The engine chip sits right of it. */
export const agentTitle = (agent: string, working: boolean, scroll: number): string => `${agent || "agent"}${working ? " · ● working" : ""}${scroll > 0 ? " · scrolled up" : ""}`

/** Below this many rows inside its border, the agent pane is short (the foot of a tab): cards come before the conversation. */
const SHORT_PANE_ROWS = 8

export function AgentPane(p: AgentPaneProps) {
  const width = innerCols(p.rect) - 1
  const rows = innerRows(p.rect)
  const waiting = unansweredLines(p.operations, p.cards, p.now, width)
  // The re-send and abandon line stays on screen, whatever the kill report takes; a rule ends the
  // report, so the conversation under it never reads as part of it.
  const killRoom = Math.max(0, Math.floor(rows / 2) - waiting.length - 1)
  const kill = p.killReport ? [...killReportLines(p.killReport, p.operations, p.now, width, killRoom), line("─".repeat(Math.max(1, width)), C.bad), blank()] : []
  const held = [...kill, ...(waiting.length ? [...waiting, blank()] : [])]
  const open = p.cards.filter((c) => c.state === "awaiting_approval")
  const cardBlock: Line[] = []
  const shaded = highlightedCard(open, p.focusedCardId, p.cardsFocused)
  // The rows the cards get; a card taller than that gives up its optional lines first (card.tsx), so its headline shows.
  // In the short agent pane across a tab's foot, a card keeps its rows at its compact
  // form, headline, who and chips, and the conversation gets what's left: Enter's card is always on screen.
  const short = rows < SHORT_PANE_ROWS
  const cardRoom = Math.max(0, rows - held.length - (short ? 0 : 2))
  // Cards that ended, a trade's receipt among them, then the header right over what waits.
  const drawCard = (c: ViewCard) => cardBlock.push(...cardLines(c, { now: p.now, focused: c.cardId === shaded, width, op: p.operations[c.opId], maxRows: short ? 1 : Math.max(1, cardRoom - 1) }))
  for (const c of p.cards) if (c.state !== "awaiting_approval") drawCard(c)
  if (open.length) cardBlock.push(line(`${open.length === 1 ? "1 card" : `${open.length} cards`} waiting · ⏎ approves the highlighted one`, p.cardsFocused ? C.look : C.dim))
  for (const c of open) drawCard(c)
  const cardsShown = cardBlock.slice(-cardRoom)
  // While you were away: under the kill report, in the rows the cards leave, so it never covers one.
  // In the short pane across a tab's foot, two rows stay the conversation's.
  const noteRoom = Math.max(0, rows - held.length - cardsShown.length - (cardsShown.length && !short ? 1 : 0) - (short ? 2 : 0))
  const note = p.away ? awayNoteLines(p.away, width, noteRoom, p.now) : []
  const pinned = [...held, ...note]
  const said = p.setup ? setupLines(p.setup.view, width) : p.exchanges.length ? conversationLines(p.exchanges, width, { ...(p.shownInFull ? { shownInFull: p.shownInFull } : {}) }) : short ? shortGreetingLines(p.agent, width, rows - pinned.length - cardsShown.length, p.tip ?? tabTip([])) : greetingLines(p.agent, width, p.setUp)
  const convo = p.offer ? [...said, ...offerLines(p.offer, width)] : said
  // A blank row between the conversation and the cards, where there's a row of conversation to show above it.
  const spacer = cardsShown.length > 0 && rows - pinned.length - cardsShown.length > 1 ? 1 : 0
  const room = Math.max(0, rows - pinned.length - cardsShown.length - spacer)
  p.onReach?.(Math.max(0, convo.length - room))
  const end = Math.max(room, convo.length - Math.max(0, p.scroll))
  const shown = withPrompt(convo, Math.max(0, end - room), end, p.working)
  const lines = [...pinned, ...shown, ...(spacer ? [blank()] : []), ...cardsShown]
  const title = agentTitle(p.agent, p.working, p.scroll)
  return (
    <Pane rect={p.rect} title={title} focused={p.focused} onFocus={p.onFocus} onScroll={p.onScroll} {...(p.edges ? { edges: p.edges } : {})}>
      <Lines lines={lines} width={width} onAct={p.onAct} />
    </Pane>
  )
}
