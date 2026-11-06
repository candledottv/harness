// The wallets pane: one line per wallet where it fits: its name, kind and agents, its SOL and token count,
// and a ⧉ chip that copies its address. The embedded wallet's address is the deposit address, so it has no
// row of its own (it would show twice, once with no name). A copy shows the address in full under its own
// wallet for 20 s, to select by hand where the copy can't land; the pane keeps its order and its balances
// (a copy that moved the wallet to the top pushed the balances out). An agent whose key isn't allowed the
// embedded wallet reads and paper-trades only, and the pane gives the owner's command to allow it
// (docs.candle.tv/developers/agent-wallets).
//
// A TEE wallet shows its label, the agent whose key it's bound to and whether Candle has it stopped. On
// Free, where none can be traded from, the pane says TEE wallets are a Pro or Max feature.
// One this Candle Harness stopped (a stop is final), or one Candle stopped listing (as a stop elsewhere does), is gone from
// Candle's reads, so it shows with what the chain says is still in it and a chip that types its sweep. The read-only agents come after the wallets, one line each with a chip that types
// the owner's command (three rows each, first, they pushed the only wallet out).
//
// Groups: where the person has groups, the embedded wallet stays first and each group is one line, how many
// wallets, their SOL and ≈$, and how many trade inside limits. The group the highlight last rested in is
// open, its wallets one line each; the rest fold. `⌕ find` on the border puts a search line over the rows,
// which finds a wallet across every group.
//
// Empty token accounts: a TEE wallet's, as Candle's preview counted them, on a line of their own ("3 empty
// token accounts · 0.00446 SOL back"), with `close` once the Candle Harness runs the close (cli-table.ts closeEmptyOn).
// One line a wallet keeps a word for them, and the line shows under its address.
import type { WalletsTopic } from "../../core/agent-wallets"
import type { AutonomyTopic } from "../../core/autonomy"
import { isCounted } from "../../core/empty-accounts"
import { type PortfolioView, viewName, viewTitle } from "../../core/portfolio-view"
import type { WalletGroup } from "../../core/wallet-groups"
import { shownGroup, type WalletsShown } from "../../core/wallets-shown"
import { amount, ago, approxUsd, shortAddress, wrap } from "../format"
import { C, money } from "../theme"
import { groupedWallets, headingId, type ListGroup, walletRowId } from "../wallet-list"
import { chip, type Line, line, type Seg } from "./lines"

const cells = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

/** What the shown-wallets choice left out, and so which chips the pane's last line offers. */
export interface HiddenWallets {
  count: number
  choice: WalletsShown
  /** Whether "active" would hide any of the wallets: if not, there's nothing to offer. */
  activeHides: boolean
}

/** A wallet that trades inside limits: its day's figure and what ran without a card today, by address. */
export type InsideWallets = ReadonlyMap<string, { perDayUsd: number; usedTodayUsd: number }>

/** A TEE wallet's empty token accounts: how many, the SOL back net of the fee, and the agent whose key closes them, by address. */
export type EmptyWallets = ReadonlyMap<string, { count: number; netSol: string; agent?: string }>

/** The wallets with empty accounts Candle counted, from the `wallets` topic; none counted is none shown. */
export function emptyWallets(topic: WalletsTopic | undefined): EmptyWallets {
  const out = new Map<string, { count: number; netSol: string; agent?: string }>()
  for (const [address, state] of Object.entries(topic?.empty ?? {})) {
    if (!isCounted(state) || state.count <= 0) continue
    const agent = topic?.boundTo[address]
    out.set(address, { count: state.count, netSol: state.netSol, ...(agent ? { agent } : {}) })
  }
  return out
}

/** "3 empty token accounts · 0.00446 SOL back", and `close` where the Candle Harness runs it and the wallet's agent is known. */
function emptyLine(address: string, empty: EmptyWallets | undefined, closeOn: boolean | undefined): Line[] {
  const e = empty?.get(address)
  if (!e) return []
  const words = `  ${e.count} empty token account${e.count === 1 ? "" : "s"} · ${amount(Number(e.netSol))} SOL back`
  if (!closeOn || !e.agent) return [line(words, C.dim)]
  return [{ segs: [{ text: `${words}  `, fg: C.dim }, chip("close", "closeEmpty")], ref: address }]
}

/** The Wallets pane's search: the words typed, and whether its line takes keys. This view's own. */
export interface WalletsFind {
  query: string
  editing?: true
}

/** How the pane groups: the person's groups, the open one, and a search. */
export interface WalletsGrouping {
  groups: readonly WalletGroup[]
  open?: string
  find?: WalletsFind
}

/** Whether the pane draws its groups: there are some and no one group is chosen, or a search is on. */
export const grouping = (g: WalletsGrouping | undefined, choice: WalletsShown | undefined): boolean =>
  g !== undefined && ((g.groups.length > 0 && (choice === undefined || shownGroup(choice) === undefined)) || g.find !== undefined)

export function walletLines(p: PortfolioView | undefined, opts: { mode: "paper" | "live"; now: number; width: number; shownInFull?: string; rows?: number; hidden?: HiddenWallets; inside?: InsideWallets; empty?: EmptyWallets; closeOn?: boolean; grouping?: WalletsGrouping }): Line[] {
  if (p && p.readAt !== null && opts.grouping && grouping(opts.grouping, opts.hidden?.choice)) return [...groupedLines(p, opts, opts.grouping), ...hiddenLine(p, opts.hidden)]
  const tail = hiddenLine(p, opts.hidden)
  const lines = [...walletLinesIn(p, opts, false), ...tail]
  // More wallets than two lines each can hold: one line each, the name, SOL
  // and ⧉, aligned; agents and token counts are in Positions.
  return opts.rows !== undefined && lines.length > opts.rows ? [...walletLinesIn(p, opts, true), ...tail] : lines
}

/**
 * The pane's last line when the choice hides wallets, or another choice would: nothing leaves the pane
 * silently, and a click changes it. The agent can too (harness_show_wallets).
 */
function hiddenLine(p: PortfolioView | undefined, hidden: HiddenWallets | undefined): Line[] {
  if (!hidden || !p || p.readAt === null) return []
  const segs: Seg[] = []
  if (hidden.count > 0) segs.push({ text: `+${hidden.count} hidden  `, fg: C.dim }, chip("show all", "walletsAll"))
  if (hidden.choice !== "active" && hidden.activeHides) segs.push({ text: segs.length ? "  " : "", fg: C.dim }, chip("active only", "walletsActive"))
  return segs.length ? [{ segs }] : []
}

function walletLinesIn(p: PortfolioView | undefined, opts: { mode: "paper" | "live"; now: number; width: number; shownInFull?: string; inside?: InsideWallets; empty?: EmptyWallets; closeOn?: boolean }, compact: boolean): Line[] {
  const out: Line[] = []
  const full = (address: string) => wrap(address, Math.max(10, opts.width - 2)).map((part) => line(`  ${part}`, C.hi))
  const copy: Seg[] = [{ text: " ", fg: C.ink }, chip("⧉", "copy")]
  // Before the wallets are read, the embedded wallet by the name it'll have, its ⧉ already copying the deposit
  // address: what a new user needs first.
  if (p?.deposit && !p.wallets.some((w) => w.address === p.deposit)) {
    out.push({ segs: [{ text: "embedded", fg: C.hi }, ...copy], ref: p.deposit })
    if (opts.shownInFull === p.deposit) out.push(...full(p.deposit))
  }
  // The chip only types a whole command: with no key prefix read, there's nothing to type.
  // The chip under the words where both don't fit on one line: cut, it read "allo".
  const readOnly: Line[] = (p?.readOnly ?? []).flatMap((r): Line[] => {
    const words = `${r.agent}: read only, no wallet`
    if (r.command.includes("<prefix>")) return [line(words, C.look)]
    const allow = chip("allow", "fill")
    if (words.length + 2 + allow.text.length <= opts.width) return [{ segs: [{ text: `${words}  `, fg: C.look }, allow], ref: r.command }]
    return [line(words, C.look), { segs: [{ text: "  ", fg: C.ink }, allow], ref: r.command }]
  })
  // On Free a TEE wallet is listed but can't pay, so that goes first too.
  if (p?.teeNote && p.wallets.some((w) => w.kind === "tee")) out.push(line(p.teeNote, C.dim))
  if (!p || p.readAt === null) {
    // Paper needs no funds; in live, that line only crowded a short pane.
    if (opts.mode === "paper") out.push(line("Paper trades need no funds.", C.dim))
    else if (p?.failed) out.push(...wrap(`Couldn't read your wallets: ${p.failed}. Trying again every 15 s.`, Math.max(10, opts.width)).map((t) => line(t, C.look)))
    else out.push(line("Reading your wallets…", C.dim))
    return [...out, ...readOnly]
  }
  // Named as everywhere: the core's name, and what kind of wallet where the name doesn't say.
  const nameOf = (w: PortfolioView["wallets"][number]) => viewTitle(w)
  const nameWidth = Math.max(0, ...p.wallets.map((w) => nameOf(w).length))
  const sweep = stoppedFunds
  // Naming a wallet: `name <wallet> ` on the input line, from its row where there's room, and
  // always under its address once ⧉ shows it in full.
  const nameFill = (w: PortfolioView["wallets"][number]) => `name ${w.label !== undefined && !w.marked && !/\s/.test(w.label) ? w.label : w.kind === "embedded" && w.label === undefined ? "embedded" : w.address} `
  const fullNamed = (w: PortfolioView["wallets"][number]): Line[] => [...full(w.address), { segs: [{ text: "  ", fg: C.ink }, { ...chip("name it", "fill"), ref: nameFill(w) }] }]
  for (const w of p.wallets) {
    if (w.stopped) {
      // What's cut to keep the ⧉ chip is the agents, as on any wallet's line.
      const tail: Seg[] = [{ text: w.stoppedOutside ? " · no longer listed by Candle" : " · stopped for good", fg: C.look }, ...copy]
      const about: Seg[] = !compact && w.agents.length ? [{ text: ` · ${w.agents.join(", ")}`, fg: C.dim }] : []
      const head: Seg[] = [{ text: nameOf(w), fg: C.hi }, ...about, ...tail]
      out.push({ segs: cells(head) <= opts.width ? head : [{ text: nameOf(w), fg: C.hi }, ...tail], ref: w.address })
      if (opts.shownInFull === w.address) out.push(...full(w.address))
      out.push(sweep(w))
      continue
    }
    if (compact) {
      const sol: Seg[] = [{ text: w.sol ? `${amount(w.sol.amount)} SOL` : "SOL —", fg: C.hi }, { text: w.sol ? ` ${approxUsd(w.sol.usd)}` : "", fg: C.dim }]
      const stopped: Seg[] = w.active === false ? [{ text: " stopped", fg: C.look }] : []
      // Where it trades inside limits, said in a word when there's room; its use is a line of its own otherwise.
      const segs: Seg[] = [{ text: nameOf(w).padEnd(nameWidth + 2), fg: C.hi }, ...sol, ...stopped]
      const mark: Seg[] = opts.inside?.has(w.address) ? [{ text: " · inside limits", fg: C.good }] : []
      // Empty accounts, in a word where there's room; the whole line shows under its address.
      const empties = opts.empty?.get(w.address)
      const emptyMark: Seg[] = empties ? [{ text: ` · ${empties.count} empty`, fg: C.dim }] : []
      const marks = cells([...segs, ...mark, ...emptyMark, ...copy]) <= opts.width ? [...mark, ...emptyMark] : cells([...segs, ...mark, ...copy]) <= opts.width ? mark : []
      out.push({ segs: [...segs, ...marks, ...copy], ref: w.address })
      if (opts.shownInFull === w.address) out.push(...fullNamed(w), ...emptyLine(w.address, opts.empty, opts.closeOn))
      continue
    }
    const name = viewName(w)
    const kind = viewTitle(w).slice(name.length)
    const about = `${kind}${w.agents.length ? ` · ${w.agents.join(", ")}` : ""}`
    // A name that breaks the Candle Harness's rules is shown as it is, amber: it's taken by address only (the doctor says why).
    const head: Seg[] = [{ text: name, fg: w.marked ? C.look : C.hi }, { text: about, fg: C.dim }, ...(w.active === false ? [{ text: " · stopped", fg: C.look }] : [])]
    const tokens = w.tokens === null ? "tokens unread" : `${w.tokens.length} token${w.tokens.length === 1 ? "" : "s"}`
    const balance: Seg[] = [{ text: w.sol ? `${amount(w.sol.amount)} SOL` : "SOL —", fg: C.hi }, { text: w.sol ? ` ${approxUsd(w.sol.usd)}` : "", fg: C.dim }, { text: ` · ${tokens}`, fg: C.ink }]
    // Naming it: a chip that puts `name <wallet> ` on the input line, where it fits.
    const rename: Seg[] = [{ text: " ", fg: C.ink }, { ...chip("name", "fill"), ref: nameFill(w) }]
    const named: Seg[] = [...head, { text: "  ", fg: C.ink }, ...balance, ...rename, ...copy]
    const one: Seg[] = [...head, { text: "  ", fg: C.ink }, ...balance, ...copy]
    if (cells(named) <= opts.width) out.push({ segs: named, ref: w.address })
    else if (cells(one) <= opts.width) out.push({ segs: one, ref: w.address })
    // Narrow: the balance goes below, and what's cut to keep the chip is the agents, never the control.
    else {
      const room = opts.width - cells(copy) - name.length
      const rest = head.slice(1)
      const fits = cells(rest) <= room ? rest : [{ text: `${rest.map((r) => r.text).join("").slice(0, Math.max(0, room - 1))}…`, fg: C.dim }]
      out.push({ segs: [head[0]!, ...fits, ...copy], ref: w.address }, { segs: [{ text: "  ", fg: C.ink }, ...balance] })
    }
    // Trading inside limits, and today's use without a card.
    const inside = opts.inside?.get(w.address)
    if (inside) out.push(line(`  inside limits · ${money(inside.usedTodayUsd)} of ${money(inside.perDayUsd)} today`, C.good))
    out.push(...emptyLine(w.address, opts.empty, opts.closeOn))
    if (opts.shownInFull === w.address) out.push(...(cells(named) <= opts.width ? full(w.address) : fullNamed(w)))
  }
  return [...out, ...fundLines(p, opts), ...readOnly]
}

/**
 * Wallets read and holding nothing: where funds go, which the embedded wallet's ⧉ copies, and in paper
 * that none are needed. Candle has no paper balance to show yet.
 */
function fundLines(p: PortfolioView, opts: { mode: "paper" | "live"; width: number }): Line[] {
  const empty = p.wallets.every((w) => !w.stopped && (w.sol?.amount ?? 0) === 0 && w.tokens !== null && w.tokens.length === 0)
  if (!empty || !p.deposit) return []
  const say = (text: string) => wrap(text, Math.max(10, opts.width)).map((t) => line(t, C.dim))
  const paper = opts.mode === "paper" ? say("Paper trades need no funds.") : []
  // Candle's read leaves out a wallet no agent's key may use, so it isn't empty: unread ("send SOL" over a
  // wallet that holds SOL would mislead).
  if (!p.wallets.some((w) => w.address === p.deposit) && p.readOnly.length > 0) return [...say("Its balance isn't shown: no agent's key here may use it. allow lets one."), ...paper]
  return [...say("⧉ copies its address: send SOL to trade live."), ...paper]
}

/** The wallets that trade inside limits, by address, from the `autonomy` topic. */
export function insideWallets(topic: AutonomyTopic | undefined): InsideWallets {
  const out = new Map<string, { perDayUsd: number; usedTodayUsd: number }>()
  for (const w of topic?.wallets ?? []) if (w.setting === "inside" && !w.gone && w.perDayUsd !== undefined) out.set(w.wallet, { perDayUsd: w.perDayUsd, usedTodayUsd: w.usedTodayUsd })
  return out
}

/** The pane's title carries the read's age, which was a line of its own in a pane that's always short. */
/** And which wallets show when it isn't the default, "active" (otherwise nothing on screen says). */
export function walletsTitle(p: PortfolioView | undefined, now: number, choice?: WalletsShown): string {
  const group = choice === undefined ? undefined : shownGroup(choice)
  const which = choice === "all" ? " · all" : Array.isArray(choice) ? " · chosen" : group !== undefined ? ` · ${group}` : ""
  return p && p.readAt !== null ? `Wallets${which} · read ${ago(p.readAt, now, 60_000).text}` : `Wallets${which}`
}

type W = PortfolioView["wallets"][number]

/**
 * A stopped wallet's second line: what the chain says is still in it, and the chip that types its sweep;
 * one that's empty on chain needs no sweep. One Candle stopped listing says a stop elsewhere does that.
 */
function stoppedFunds(w: W): Line {
  const why = w.stoppedOutside ? "stopped outside the Candle Harness, most likely · " : ""
  const sweep = { segs: [chip("sweep it home", "fill")], ref: `candle tee sweep ${w.address}${w.agents.length === 1 ? ` as ${w.agents[0]}` : ""}` }
  if (w.sol && w.sol.amount === 0 && w.heldTokens === 0) return { segs: [{ text: `  ${why}empty on chain`, fg: C.dim }] }
  const held = w.sol ? `${amount(w.sol.amount)} SOL${w.sol.usd !== null ? ` ${approxUsd(w.sol.usd)}` : ""}${w.heldTokens ? ` and ${w.heldTokens} token${w.heldTokens === 1 ? "" : "s"}` : ""} still in it${w.heldTokens === undefined && w.balanceError ? ` (tokens not read: ${w.balanceError})` : ""}` : w.balanceError ? `balance not read (${w.balanceError})` : "funds still in it"
  return { segs: [{ text: `  ${why}${held}  `, fg: C.dim }, ...sweep.segs], ref: sweep.ref }
}

/** Whole dollars for a group's total: ≈$1,721. */
const wholeUsd = (n: number | null): string => (n === null ? "" : `≈$${Math.round(n).toLocaleString("en-US")}`)

/** A group's SOL, and its dollars where every wallet's are priced (never a partial sum as the whole). */
function totals(ws: readonly W[]): { sol: number; usd: number | null } {
  const sol = ws.reduce((n, w) => n + (w.sol?.amount ?? 0), 0)
  const priced = ws.every((w) => w.stopped || (w.sol !== null && w.sol.usd !== null))
  return { sol, usd: priced ? ws.reduce((n, w) => n + (w.sol?.usd ?? 0), 0) : null }
}

/** Columns laid out whole while they fit, the optional ones dropped from the end (the narrow pane drops ≈$ and inside). */
function fitColumns(must: readonly Seg[], optional: readonly Seg[][], tail: readonly Seg[], width: number): Seg[] {
  const cellsOf = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)
  for (let k = optional.length; k >= 0; k--) {
    const segs = [...must, ...optional.slice(0, k).flat(), ...tail]
    if (cellsOf(segs) <= width || k === 0) return segs
  }
  return [...must, ...tail]
}

/** The search line over the rows: ⌕ with what's typed and its cursor, then how many it found of how many. */
export function walletsHead(find: WalletsFind | undefined, found: number, of: number, width: number): Line[] {
  if (!find) return []
  const typed = find.query
  const count = typed.trim() ? `   ${found} of ${of}` : "   type a wallet's name"
  const room = Math.max(4, width - 3 - count.length)
  const shown = typed.length + 1 > room ? `…${typed.slice(typed.length + 2 - room)}` : typed
  return [{ segs: [chip("⌕", "walletsFind"), { text: shown, fg: C.hi }, ...(find.editing ? [{ text: "▏", fg: C.focus }] : [{ text: " ", fg: C.ink }]), { text: count, fg: C.dim }] }]
}

/** The grouped pane's lines: the embedded wallet, then each group folded but the open one. */
function groupedLines(p: PortfolioView, opts: { width: number; shownInFull?: string; inside?: InsideWallets; empty?: EmptyWallets; closeOn?: boolean }, g: WalletsGrouping): Line[] {
  const finding = (g.find?.query.trim() ?? "") !== ""
  const list = groupedWallets(p.wallets, g.groups, (w) => ({ address: w.address, kind: w.kind, name: viewName(w) }), finding ? g.find!.query : "")
  const out: Line[] = []
  const copy: Seg[] = [{ text: " ", fg: C.ink }, chip("⧉", "copy")]
  const inside = (w: W) => opts.inside?.has(w.address) === true
  const full = (address: string) => wrap(address, Math.max(10, opts.width - 2)).map((part) => line(`  ${part}`, C.hi))
  const nameFill = (w: W) => `name ${w.label !== undefined && !w.marked && !/\s/.test(w.label) ? w.label : w.kind === "embedded" && w.label === undefined ? "embedded" : w.address} `
  const after = (w: W): Line[] => [
    ...(opts.shownInFull === w.address ? [...full(w.address), { segs: [{ text: "  ", fg: C.ink }, { ...chip("name it", "fill"), ref: nameFill(w) }] }, ...emptyLine(w.address, opts.empty, opts.closeOn)] : []),
    ...(w.stopped ? [stoppedFunds(w)] : []),
  ]
  // One set of columns for the embedded wallet's line and the groups' lines: the name, then (under a
  // group's count) nothing, then SOL and ≈$, so the three line up.
  const sums = list.groups.map((x) => totals(x.wallets))
  const nameW = Math.max(8, ...list.groups.map((x) => x.name.length), ...list.top.map((w) => viewName(w).length))
  const solW = Math.max(0, ...sums.map((t) => amount(t.sol).length), ...list.top.map((w) => (w.sol ? amount(w.sol.amount).length : 1)))
  const usdW = Math.max(0, ...sums.map((t) => wholeUsd(t.usd).length), ...list.top.map((w) => (w.sol ? wholeUsd(w.sol.usd).length : 0)))
  for (const w of list.top) {
    const segs: Seg[] = [{ text: `  ${viewName(w).padEnd(nameW)}`, fg: w.marked ? C.look : C.hi }, { text: "   ", fg: C.ink }, { text: `  ${(w.sol ? amount(w.sol.amount) : "—").padStart(solW)} SOL`, fg: C.hi }]
    const usd: Seg[] = w.sol ? [{ text: ` ${wholeUsd(w.sol.usd).padStart(usdW)}`, fg: C.dim }] : []
    const mark: Seg[] = inside(w) ? [{ text: "  inside limits", fg: C.good }] : []
    const tail: Seg[] = [{ text: "  ", fg: C.ink }, ...copy]
    const cells = (x: readonly Seg[]) => x.reduce((n, seg) => n + seg.text.length, 0)
    // Too narrow for the groups' columns: the line as it reads on its own, its ⧉ kept.
    const fitted =
      cells([...segs, ...tail]) <= opts.width
        ? fitColumns(segs, [usd, mark, [{ text: "  embedded", fg: C.dim }]], tail, opts.width)
        : fitColumns([{ ...segs[0]!, text: viewName(w) }, { text: `  ${w.sol ? amount(w.sol.amount) : "—"} SOL`, fg: C.hi }], [w.sol ? [{ text: ` ${wholeUsd(w.sol.usd)}`, fg: C.dim }] : []], tail, opts.width)
    out.push({ segs: fitted, ref: w.address, pick: { id: walletRowId("", w.address), mint: "" } })
    out.push(...after(w))
  }
  if (finding && list.top.length) out.push(line(""))
  list.groups.forEach((grp, i) => {
    const open = finding || g.open === grp.key || list.groups.length === 1 || grp.name === ""
    if (grp.name !== "") out.push(heading(grp, open, finding, sums[i]!, { nameW, solW, usdW, width: opts.width, inside: grp.wallets.filter(inside).length }))
    if (!open) return
    out.push(...grp.wallets.flatMap((w) => [walletRow(grp, w, grp.wallets, opts.width, inside(w), copy, opts.empty?.get(w.address)?.count), ...after(w)]))
  })
  if (finding) {
    if (list.top.length === 0 && list.groups.length === 0) out.push(line(`No wallet's name holds ${g.find!.query.trim()}.`, C.dim))
    out.push(line(""), line("esc ends the search", C.dim))
  }
  return out
}

/** A group's line: ▸ folded or ▾ open, its name, how many wallets, their SOL and ≈$, and how many trade inside limits. */
function heading(grp: ListGroup<W>, open: boolean, finding: boolean, t: { sol: number; usd: number | null }, c: { nameW: number; solW: number; usdW: number; width: number; inside: number }): Line {
  const pick = { id: headingId(grp.key), mint: "" }
  if (finding) return { segs: [{ text: `▾ ${grp.name}`, fg: C.head }, { text: `  ${grp.wallets.length} of ${grp.total} shown`, fg: C.dim }], pick }
  const must: Seg[] = [{ text: `${open ? "▾" : "▸"} `, fg: C.dim }, { text: grp.name.padEnd(c.nameW), fg: C.head }, { text: String(grp.total).padStart(3), fg: C.ink }, { text: `  ${amount(t.sol).padStart(c.solW)} SOL`, fg: C.hi }]
  const optional: Seg[][] = [[{ text: ` ${wholeUsd(t.usd).padStart(c.usdW)}`, fg: C.dim }], c.inside ? [{ text: `  ${c.inside} inside`, fg: C.good }] : []]
  return { segs: fitColumns(must, optional, [], c.width), pick }
}

/** An open group's wallet, one line: its name, SOL, ≈$, whether it trades inside limits, and ⧉. */
function walletRow(grp: ListGroup<W>, w: W, all: readonly W[], width: number, inside: boolean, copy: readonly Seg[], empty?: number): Line {
  const nameW = Math.max(...all.map((x) => viewName(x).length))
  const solW = Math.max(...all.map((x) => (x.sol ? amount(x.sol.amount).length : 1)))
  const usdW = Math.max(...all.map((x) => (x.sol ? approxUsd(x.sol.usd).length : 0)))
  const name = viewName(w)
  const must: Seg[] = [{ text: `  ${name.padEnd(nameW)}`, fg: w.marked ? C.look : C.hi }]
  if (w.stopped) must.push({ text: "  stopped for good", fg: C.look })
  else must.push({ text: `  ${(w.sol ? amount(w.sol.amount) : "—").padStart(solW)} SOL`, fg: C.hi }, ...(w.active === false ? [{ text: " stopped", fg: C.look }] : []))
  // Empty accounts last, in a word: the column the row gives up first (the whole line is under its address).
  const optional: Seg[][] = w.stopped ? [] : [[{ text: `  ${(w.sol ? approxUsd(w.sol.usd) : "").padStart(usdW)}`, fg: C.dim }], [{ text: inside ? "  inside" : "        ", fg: C.good }], empty ? [{ text: `  ${empty} empty`, fg: C.dim }] : []]
  return { segs: fitColumns(must, optional, [{ text: "  ", fg: C.ink }, ...copy], width), ref: w.address, pick: { id: walletRowId(grp.key, w.address), mint: "" } }
}

/** How many wallets the pane's search found, and of how many, for its line. */
export function walletsFound(p: PortfolioView | undefined, g: WalletsGrouping): { found: number; of: number } {
  const ws = p?.wallets ?? []
  const q = g.find?.query ?? ""
  const list = groupedWallets(ws, g.groups, (w) => ({ address: w.address, kind: w.kind, name: viewName(w) }), q)
  const found = new Set([...list.top, ...list.groups.flatMap((x) => x.wallets)].map((w) => w.address)).size
  return { found, of: ws.length }
}

/**
 * The `all groups ▾` menu's rows: every group, as the panes show by default, and every
 * wallet; then each group alone. A group picked is `[wallets] show = "group:<name>"`, kept by the core.
 */
export function walletsMenuRows(groups: readonly WalletGroup[], choice: WalletsShown | undefined): { value: WalletsShown; label: string; words: string; on: boolean }[] {
  const group = choice === undefined ? undefined : shownGroup(choice)
  return [
    { value: "active", label: "all groups", words: "the wallets an agent here can pay from, grouped", on: choice === undefined || choice === "active" },
    { value: "all", label: "every wallet", words: "every wallet on the account, grouped", on: choice === "all" },
    ...groups.map((g) => ({ value: `group:${g.name}` as const, label: g.name, words: `${g.members.length} wallet${g.members.length === 1 ? "" : "s"}${g.prefix !== undefined ? `, names starting ${g.prefix}` : ""}`, on: group !== undefined && group.toLowerCase() === g.name.toLowerCase() })),
  ]
}

/** The chip's words: which groups the pane shows. */
export const walletsMenuChip = (choice: WalletsShown | undefined): string => {
  const group = choice === undefined ? undefined : shownGroup(choice)
  return `${group ?? "all groups"} ▾`
}
