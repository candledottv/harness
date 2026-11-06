// The approvals menu, drawn: the wallets on the left, the picked one on the right. At 50 wallets the list is
// the Wallets pane's groups, one line a wallet, and it scrolls; below 100 columns the list takes the width, and
// → opens the picked wallet with a `‹ wallets` chip to come back. The lines are built by pure functions here,
// so a test reads what's drawn; the keys are keys.ts's.
import type { AutonomyTopic, AutonomyWallet } from "../../core/autonomy"
import type { WalletGroup } from "../../core/wallet-groups"
import { type AgentLimits, type ApprovalsListRow, type ApprovalsRow, type ApprovalsState, approvalsEntries, approvalsList, bindsFirst, detailRows, groupLine, LOSS_LIMITS_NOTE, limitRows, settingShort, uncappedLines, dayCapsFirst } from "../approvals"
import { usePointer } from "../chip"
import { wrap } from "../format"
import { C, fit, money, OVERLAY_Z } from "../theme"
import { blank, chip, type Line, Lines, line, type Seg } from "./lines"

/** The wallet list's width, wide, with its rule: names get the room (`agent-a-tee` was cut at 10, and at 13). */
export const LIST_W = 41
/** The longest setting ("asks every time"). */
const SETTING_W = 15
/** Below this the list takes the width, and → opens one wallet. */
export const APPROVALS_WIDE = 100

const pad = (text: string, w: number) => text.padEnd(w)

/** The cells a figure takes, chip or typed, so who holds it lines up on both rows. */
const FIGURE_W = 12

/** The figure on its row: the typed text with a cursor, a chip that types a new one, or one to type it. */
function figureSegs(value: number | undefined, typing: string | undefined, row: ApprovalsRow): Seg[] {
  const segs: Seg[] = typing !== undefined ? [{ text: ` $${typing}`, fg: C.hi, bold: true }, { text: "▏", fg: C.hi }] : [{ ...chip(value !== undefined ? money(value) : "type it", "approvals"), ref: row }]
  const used = segs.reduce((n, s) => n + s.text.length, 0)
  return [...segs, { text: " ".repeat(Math.max(1, FIGURE_W - used)), fg: C.ink }]
}

/**
 * The picked wallet's lines: its name, its setting with the other as a chip, its figures and who holds
 * them, then every limit on its agents with who holds it, and Candle's loss limits. `focus` is the row
 * the highlight is on, when the keys are on this side.
 */
export function approvalsDetail(input: { wallet: AutonomyWallet | undefined; state: ApprovalsState; limits: readonly AgentLimits[]; width: number; read: boolean; groups?: readonly WalletGroup[] }): Line[] {
  const w = input.wallet
  const o = input.state
  if (!input.read) return [blank(), line("Reading which wallets the agents pay from…", C.dim)]
  if (!w) return [blank(), line("No agent here pays from a wallet yet: add an agent's key, and its wallets show here.", C.dim)]
  const rows = detailRows(w, o.draft)
  const focus = o.side === "detail" ? rows[o.row] : undefined
  const mark = (row: ApprovalsRow): Seg => ({ text: focus === row ? "▸ " : "  ", fg: C.ctl })
  const sel = (row: ApprovalsRow): Partial<Line> => (focus === row ? { bg: C.sel } : {})
  const out: Line[] = [blank()]
  const kind = w.kind === "tee" ? " · TEE" : ""
  out.push({ segs: [{ text: w.name, fg: C.hi, bold: true }, { text: `${kind} · ${w.agents.length ? w.agents.join(", ") : "no agent pays from it now"}`, fg: C.dim }] })
  // Its groups: a group never sets anything, so the line says the setting is its own.
  const grouped = groupLine(input.groups ?? [], w.wallet)
  if (grouped) out.push(...wrap(grouped, input.width).map((t) => line(t, C.dim)))
  out.push(blank())
  if (o.draft) out.push(line("Turn on trading inside limits: type its figures, then one click.", C.look))
  else if (w.setting === "inside") out.push({ segs: [mark("ask"), { text: "✓ trades inside limits", fg: C.good, bold: true }, { text: "   ", fg: C.ink }, { ...chip("ask every time", "approvals"), ref: "ask" }], ...sel("ask") })
  else if (w.gone) out.push(line("  asks every time · no agent here pays from it now, so it applies to nothing", C.dim))
  else out.push({ segs: [mark("turnOn"), { text: "✓ asks every time", fg: C.hi, bold: true }, { text: "   ", fg: C.ink }, { ...chip("trade inside limits…", "approvals"), ref: "turnOn" }], ...sel("turnOn") })
  if (o.draft || (w.setting === "inside" && !w.gone)) {
    out.push(blank())
    const trade = o.draft ? o.draft.perTrade : w.perTradeUsd
    const day = o.draft ? o.draft.perDay : w.perDayUsd
    const typingOn = (row: ApprovalsRow) => (focus === row ? o.typing : undefined)
    const who: Seg[] = [{ text: "Harness", fg: C.ink }, { text: " · this core", fg: C.dim }]
    out.push({ segs: [mark("perTrade"), { text: pad("without a card  ", 16), fg: C.dim }, { text: pad("a trade", 9), fg: C.ink }, ...figureSegs(trade, typingOn("perTrade"), "perTrade"), ...who], ...sel("perTrade") })
    const used: Seg[] = !o.draft ? [{ text: `   ${money(w.usedTodayUsd)} used${input.width >= 74 ? " today" : ""}`, fg: C.dim }] : []
    out.push({ segs: [mark("perDay"), { text: pad("", 16), fg: C.dim }, { text: pad("a day", 9), fg: C.ink }, ...figureSegs(day, typingOn("perDay"), "perDay"), ...who, ...used], ...sel("perDay") })
    if (o.draft) out.push({ segs: [mark(focus === "cancel" ? "cancel" : "confirm"), { text: pad("", 24), fg: C.ink }, { ...chip("turn on", "approvals", "primary"), ref: "confirm" }, { text: "  ", fg: C.ink }, { ...chip("cancel", "approvals"), ref: "cancel" }], ...(focus === "confirm" || focus === "cancel" ? { bg: C.sel } : {}) })
    for (const words of bindsFirst(w.agents, input.limits, trade, day)) out.push(line(`  ${words}`, C.dim))
    if (!o.draft) out.push(line("  Inside both figures, trades run with no card. Sells always fit.", C.dim, { key: "hint" }))
  }
  out.push(blank())
  out.push(line("limits on its agents, and who holds them", C.head))
  const agentW = Math.max(9, ...w.agents.map((a) => a.length + 2))
  const limitW = Math.max(18, Math.min(32, input.width - agentW - 9 - 12))
  out.push(line(`${pad("agent", agentW)}${pad("limit", limitW)}${pad("who", 9)}used today`, C.dim))
  for (const r of limitRows(w.agents, input.limits)) {
    out.push({ segs: [{ text: pad(r.agent, agentW), fg: C.hi }, { text: pad(fit(r.limit, limitW - 1), limitW), fg: r.look ? C.look : C.ink }, { text: pad(r.who, 9), fg: C.ink }, { text: r.used ?? "", fg: C.dim }], key: r.look ? "uncapped" : "table" })
  }
  for (const words of uncappedLines(w.agents, input.limits)) for (const t of wrap(words, input.width)) out.push(line(t, C.look))
  for (const words of dayCapsFirst(w.agents, input.limits)) for (const t of wrap(words, input.width)) out.push(line(t, C.dim))
  out.push(blank())
  for (const t of wrap(LOSS_LIMITS_NOTE, input.width)) out.push(line(t, C.dim, { key: "note" }))
  return out
}

/** The hint under the menu, by where the keys are. */
export function approvalsHint(o: ApprovalsState, wide = true): string {
  if (o.typing !== undefined) return "type the figure · ⏎ keeps it · esc stops typing"
  if (o.draft) return "↑/↓ ⏎ or a click · esc leaves it as it was"
  if (o.side === "wallets") return o.find !== undefined ? "↑/↓ a wallet found · esc ends the search" : `↑/↓ a wallet · type to find · → ${wide ? "or ⏎ " : ""}its settings · esc closes`
  return "↑/↓ ⏎ or a click · ← the wallets · esc closes"
}

/** One row of the list, drawn: what it says left and right, and its colours. */
export function listRowSegs(r: ApprovalsListRow, o: ApprovalsState, width: number): { left: Seg[]; right: Seg } {
  const right = (text: string, fg: string): Seg => ({ text, fg })
  switch (r.kind) {
    case "blank":
      return { left: [], right: right("", C.ink) }
    case "head":
      return { left: [{ text: "wallets", fg: C.head }], right: right(`${r.inside} of ${r.of} inside`, C.dim) }
    case "find": {
      const typing = o.side === "wallets"
      if (r.text === "") return { left: [{ text: "⌕ type to find a wallet", fg: C.dim }], right: right("", C.ink) }
      return { left: [{ text: `⌕ ${fit(r.text, Math.max(4, width - 4))}`, fg: C.hi }, ...(typing ? [{ text: "▏", fg: C.focus }] : [])], right: right("", C.ink) }
    }
    case "group":
      return { left: [{ text: `${r.open ? "▾" : "▸"} `, fg: C.dim }, { text: r.name, fg: C.head }, { text: r.how ? ` · ${r.how}` : "", fg: C.dim }], right: right(`${r.inside} of ${String(r.of).padStart(2)} inside`, r.inside ? C.good : C.dim) }
    case "wallet": {
      const on = r.entry === o.wallet
      const name = `${r.indent ? "  " : ""}${r.wallet.name}`
      const inside = r.wallet.setting === "inside" && !r.wallet.gone
      return { left: [{ text: fit(name, Math.max(4, width - SETTING_W - 2)), fg: on ? C.hi : C.ink, ...(on ? { bold: true } : {}) }], right: right(settingShort(r.wallet).padEnd(SETTING_W), inside ? C.good : C.dim) }
    }
  }
}

/** The list's lines held over the rest as it scrolls: how many trade inside limits, the find line and a blank. */
const LIST_HEAD = 3

/** The list rows in view: the head held, the rest from where the picked wallet stays in view; and how many are past each end. */
export function listWindow(rows: readonly ApprovalsListRow[], o: ApprovalsState, room: number): { shown: ApprovalsListRow[]; below: number } {
  const head = rows.slice(0, LIST_HEAD)
  const body = rows.slice(LIST_HEAD)
  const space = Math.max(1, room - head.length)
  if (body.length <= space) return { shown: [...head, ...body], below: 0 }
  const at = body.findIndex((r) => r.kind === "wallet" && r.entry === o.wallet)
  // The picked wallet a third of the way down, its group's line kept above it where there's room.
  const start = Math.max(0, Math.min(body.length - space, (at < 0 ? 0 : at) - Math.floor(space / 3)))
  const shown = body.slice(start, start + space)
  return { shown: [...head, ...shown], below: body.length - start - shown.length }
}

export function ApprovalsMenu(props: { state: ApprovalsState; autonomy: AutonomyTopic | undefined; groups?: readonly WalletGroup[]; limits: readonly AgentLimits[]; width: number; height: number; onPickWallet: (index: number) => void; onPickRow: (row: ApprovalsRow) => void }) {
  const pointer = usePointer()
  const o = props.state
  const groups = props.groups ?? []
  const entries = approvalsEntries(props.autonomy, groups, o.find)
  const picked = entries[o.wallet]
  const wide = props.width >= APPROVALS_WIDE
  const w = Math.min(props.width - 4, 114)
  const listW = wide ? LIST_W : w - 2
  // Inside the border: the list and its rule, then the picked wallet a cell in from each side; narrow, one or the other.
  const detailW = wide ? w - LIST_W - 6 : w - 4
  const showList = wide || o.side === "wallets"
  const showDetail = wide || o.side === "detail"
  const read = (props.autonomy?.wallets.length ?? 0) > 0 || props.autonomy?.read === true
  const back: Line[] = !wide && showDetail ? [{ segs: [{ ...chip("‹ wallets", "approvals"), ref: "wallets" }, { text: picked && picked.group !== "" && groups.length > 0 ? `   ${backWords(entries, o.wallet, groups)}` : "", fg: C.dim }] }] : []
  const detail = [...back, ...approvalsDetail({ wallet: picked?.wallet, state: o, limits: props.limits, width: detailW, read, groups })]
  const rows = approvalsList(props.autonomy, groups, o)
  // At many wallets the box takes the height it has, so it doesn't jump as groups open and fold.
  const tall = entries.length > 12 || (props.autonomy?.wallets.length ?? 0) > 12
  const h = tall ? props.height - 3 : Math.min(props.height - 3, Math.max(showDetail ? detail.length : 0, showList ? rows.length : 0) + 3)
  const room = h - 3
  const list = listWindow(rows, o, room)
  // The picked wallet's row the highlight is on stays in view as its figures are typed.
  const lit = detail.findIndex((l) => l.bg === C.sel)
  const shownDetail = detail.slice(Math.max(0, Math.min(detail.length - room, lit - room + 2)), Math.max(0, Math.min(detail.length - room, lit - room + 2)) + room)
  const left = Math.floor((props.width - w) / 2)
  const top = Math.max(2, Math.min(props.height - h, Math.floor((props.height - h) / 2)))
  const act = (ref: string) => (ref === "wallets" ? props.onPickWallet(o.wallet) : props.onPickRow(ref as ApprovalsRow))
  const more = list.below > 0 && showList ? `↓ ${list.below} more ` : ""
  return (
    <box position="absolute" zIndex={OVERLAY_Z} left={left} top={top} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title=" approvals " flexDirection="column">
      <box flexDirection="row" height={h - 3}>
        {showList ? (
          <box flexDirection="column" width={listW} paddingLeft={1}>
            {list.shown.map((r, i) => {
              const { left: segs, right } = listRowSegs(r, o, listW - 2)
              const used = segs.reduce((n, seg) => n + seg.text.length, 0)
              const lit = r.kind === "wallet" && r.entry === o.wallet && o.side === "wallets"
              const to = r.kind === "wallet" ? r.entry : r.kind === "group" ? r.first : undefined
              return (
                <box key={`${i}:${r.kind}`} flexDirection="row" height={1} backgroundColor={lit ? C.sel : C.term} {...(to !== undefined ? { onMouseDown: () => props.onPickWallet(to), ...pointer } : {})}>
                  {segs.filter((seg) => seg.text !== "").map((seg, j) => (
                    <text key={j} fg={seg.fg}>
                      {seg.text}
                    </text>
                  ))}
                  <text fg={C.ink}>{" ".repeat(Math.max(1, listW - 2 - used - right.text.length))}</text>
                  <text fg={right.fg}>{right.text}</text>
                </box>
              )
            })}
          </box>
        ) : null}
        {wide ? (
          <box flexDirection="column" width={2}>
            {Array.from({ length: h - 3 }, (_, i) => (
              <text key={i} fg={C.edge}>
                │
              </text>
            ))}
          </box>
        ) : null}
        {showDetail ? (
          <box flexDirection="column" paddingLeft={1} width={detailW + 1}>
            <Lines lines={shownDetail} width={detailW} onAct={act} />
          </box>
        ) : null}
      </box>
      <box flexDirection="row" height={1}>
        <text fg={C.dim}>{fit(` ${approvalsHint(o, wide)}`, w - 2 - more.length)}</text>
        <box flexGrow={1} />
        {more ? <text fg={C.dim}>{more}</text> : null}
      </box>
    </box>
  )
}

/** Narrow, over the picked wallet: its group and where it sits in it, "bots · 3 of 24". */
function backWords(entries: readonly { group: string }[], at: number, groups: readonly WalletGroup[]): string {
  const g = entries[at]!.group
  const inGroup = entries.map((e, i) => ({ e, i })).filter((x) => x.e.group === g)
  const name = groups.find((x) => x.name === g)?.name ?? "no group"
  return `${name} · ${inGroup.findIndex((x) => x.i === at) + 1} of ${inGroup.length}`
}
