// The overlay of every wallet, drawn: a
// search and what it found over every wallet in the lists' order, each with its agents, balance, tokens and
// setting, its ⧉ and a `name` chip; picking marks ☐ ☑, a group's ◪ where some are picked. The naming step
// over it: the start changed for all, each wallet's new name, who keeps it, and what group it leaves. The
// lines are built by pure functions here, so a test reads what's drawn; the keys are keys.ts's.
import type { AutonomyWallet } from "../../core/autonomy"
import { type PortfolioView, viewName, viewTitle } from "../../core/portfolio-view"
import type { WalletGroup } from "../../core/wallet-groups"
import { addressKey, type WalletNameEntry } from "../../core/wallet-names"
import { type EveryWalletState, everyRows, groupMark, namingRows, settingOf } from "../every-wallet"
import { amount, approxUsd, wrap } from "../format"
import { C, fit, OVERLAY_Z } from "../theme"
import { chip, type Line, Lines, line, type RowPick, type Seg } from "./lines"

type W = PortfolioView["wallets"][number]

export interface EveryWalletData {
  wallets: readonly W[]
  groups: readonly WalletGroup[]
  names: readonly WalletNameEntry[]
  autonomy: readonly AutonomyWallet[]
}

const wholeUsd = (n: number) => `≈$${Math.round(n).toLocaleString("en-US")}`

/** The account in a line: how many wallets, their SOL and ≈$, and how many trade inside limits. */
function totalsLine(d: EveryWalletData): string {
  const sol = d.wallets.reduce((n, w) => n + (w.sol?.amount ?? 0), 0)
  const priced = d.wallets.every((w) => w.stopped || (w.sol !== null && w.sol.usd !== null))
  const usd = d.wallets.reduce((n, w) => n + (w.sol?.usd ?? 0), 0)
  const inside = d.autonomy.filter((a) => a.setting === "inside" && !a.gone).length
  return `${d.wallets.length} wallets · ${amount(sol)} SOL${priced ? ` ${wholeUsd(usd)}` : ""} · ${inside} inside limits`
}

/** The list's lines: its head (the search, the count or the picked, the columns), then a line a row. */
export function everyLines(o: EveryWalletState, d: EveryWalletData, width: number): { head: Line[]; rows: Line[]; at: number[] } {
  const wide = width >= 90
  const rows = everyRows(d.wallets, d.groups, o.query)
  const picking = o.picked.length > 0
  const search: Seg[] = o.query ? [{ text: `⌕ ${o.query}`, fg: C.hi }, { text: "▏", fg: C.focus }] : [{ text: "⌕ type to find a wallet", fg: C.dim }]
  const right: Seg[] = picking
    ? [{ text: `${o.picked.length} picked   `, fg: C.hi }, { ...chip(`name ${o.picked.length}…`, "fill", "primary"), ref: "name" }, { text: "  ", fg: C.ink }, { ...chip("clear", "fill"), ref: "clear" }]
    : wide
      ? [{ text: totalsLine(d), fg: C.dim }]
      : []
  const used = [...search, ...right].reduce((n, s) => n + s.text.length, 0)
  const head: Line[] = [line(""), { segs: [...search, { text: " ".repeat(Math.max(2, width - used)), fg: C.ink }, ...right] }]
  if (!wide && !picking) head.push(line(totalsLine(d), C.dim))
  head.push(line(""))
  const nameW = 20
  const agentW = wide ? 20 : 0
  const col = (text: string, w: number, fg: string): Seg => ({ text: fit(text, w - 1).padEnd(w), fg })
    const balW = wide ? 24 : 21
  const setW = wide ? 18 : 16
  head.push({ segs: [col("  wallet", nameW + 2, C.dim), ...(wide ? [col("agents", agentW, C.dim)] : []), col("balance", balW, C.dim), ...(wide ? [col("tokens", 10, C.dim)] : []), col("approvals", setW, C.dim)] })
  const out: Line[] = []
  const at: number[] = []
  const has = (a: string) => o.picked.some((p) => addressKey(p) === addressKey(a))
  rows.forEach((r, i) => {
    const pick: RowPick = { id: `ew:${i}`, mint: "" }
    const lit = i === o.index ? { bg: C.sel } : {}
    at.push(out.length)
    if (r.kind === "group") {
      const sol = r.wallets.reduce((n, w) => n + (w.sol?.amount ?? 0), 0)
      const inside = r.wallets.filter((w) => settingOf(d.autonomy, w.address) === "inside limits").length
      const priced = r.wallets.every((w) => w.stopped || (w.sol !== null && w.sol.usd !== null))
      const usd = r.wallets.reduce((n, w) => n + (w.sol?.usd ?? 0), 0)
      const words = [r.how, `${r.total} wallet${r.total === 1 ? "" : "s"}`, `${amount(sol)} SOL${priced ? ` ${wholeUsd(usd)}` : ""}`, ...(inside ? [`${inside} inside limits`] : [])].filter(Boolean).join(" · ")
      out.push(line(""))
      out.push({ segs: [...(picking ? [{ text: `${groupMark(o.picked, r)} `, fg: C.hi }] : []), { text: r.name, fg: C.head }, { text: ` · ${words}`, fg: C.dim }], pick, ...lit })
      return
    }
    const w = r.wallet
    const mark = picking ? (has(w.address) ? "☑ " : "☐ ") : ""
    const name = r.group === "" ? viewTitle(w) : viewName(w)
    const balance = w.stopped ? "stopped for good" : `${(w.sol ? amount(w.sol.amount) : "—").padStart(wide ? 7 : 6)} SOL ${(w.sol ? approxUsd(w.sol.usd) : "").padStart(9)}`
    const tokens = w.tokens === null ? "unread" : `${w.tokens.length} token${w.tokens.length === 1 ? "" : "s"}`
    const setting = settingOf(d.autonomy, w.address)
    const segs: Seg[] = [
      { text: `  ${mark}`, fg: C.hi },
      col(name, nameW - mark.length, w.marked ? C.look : C.hi),
      ...(wide ? [col(w.agents.join(", ") || "no agent", agentW, C.dim)] : []),
      col(balance, balW, C.ink),
      ...(wide ? [col(tokens, 10, C.dim)] : []),
      col(setting, setW, setting === "inside limits" ? C.good : C.dim),
      { ...chip("⧉", "copy"), ref: w.address },
      { text: " ", fg: C.ink },
      { ...chip("name", "fill"), ref: `name ${w.label !== undefined && !w.marked && !/\s/.test(w.label) ? w.label : w.address} ` },
    ]
    out.push({ segs, pick, ...lit })
  })
  if (rows.length === 0) out.push(line(o.query ? `No wallet's name holds ${o.query}.` : "No wallets read yet.", C.dim))
  return { head, rows: out, at }
}

/** The naming step's lines: the start changed for all, then each wallet's now, new name, who keeps it and what changes. */
export function namingLines(o: EveryWalletState, d: EveryWalletData, width: number): Line[] {
  const n = o.naming!
  const rows = namingRows(d.wallets, o.picked, n, d.names, d.groups)
  const field = (text: string, on: boolean, w: number): Seg[] => [{ text: fit(text, w - 1), fg: on ? C.hi : C.ink, ...(on ? { bold: true } : {}) }, { text: on ? "▏" : " ", fg: C.focus }, { text: " ".repeat(Math.max(0, w - 1 - Math.min(text.length, w - 1))), fg: C.ink }]
  const out: Line[] = [line("")]
  const each = "or type each one below"
  const start: Seg[] = [{ text: "change the start of every name  ", fg: C.dim }, ...field(n.from, n.field === 0, 14), { text: "→  ", fg: C.dim }, ...field(n.to, n.field === 1, 14)]
  const fits = start.reduce((k, seg) => k + seg.text.length, 0) + each.length + 2 <= width
  out.push({ segs: [...start, ...(fits ? [{ text: `  ${each}`, fg: C.dim }] : [])] })
  out.push(fits ? line("") : line(each, C.dim))
  const col = (text: string, w: number, fg: string): Seg => ({ text: fit(text, w - 1).padEnd(w), fg })
  out.push({ segs: [col("now", 22, C.dim), col("new name", 24, C.dim), col("kept by", 14, C.dim)] })
  rows.forEach((r, i) => {
    const on = n.field === i + 2
    const typed = n.each[r.address] !== undefined
    out.push({
      segs: [col(r.now, 22, C.ink), ...field(r.next, on, 24), col(r.keptBy, 14, C.dim), { text: r.problem ?? r.note ?? (r.next === r.now && !typed ? "unchanged" : ""), fg: r.problem ? C.bad : C.dim }],
      ...(on ? { bg: C.sel } : {}),
    })
  })
  out.push(line(""))
  for (const t of wrap("Every name is checked before anything runs: Candle's rule, unique, never an address. Candle's go as one tee rename --pairs-from, its dry run first in the prompt pane.", width)) out.push(line(t, C.dim))
  out.push(line(""))
  out.push({ segs: [{ text: " ".repeat(Math.max(0, Math.floor(width / 2) - 14)), fg: C.ink }, { ...chip("preview in the pane", "fill", "primary"), ref: "preview" }, { text: "   ", fg: C.ink }, { ...chip("back", "fill"), ref: "back" }] })
  return out
}

export function EveryWalletOverlay(props: { state: EveryWalletState; data: EveryWalletData; width: number; height: number; onAct: (which: "pick" | "name" | "clear" | "preview" | "back", index?: number) => void; onCopy: (address: string) => void; onFill: (text: string) => void }) {
  const o = props.state
  const w = Math.min(props.width - 4, 114)
  const h = props.height - 3
  const inner = w - 4
  const naming = o.naming !== undefined
  const title = naming ? ` name ${o.picked.length} wallet${o.picked.length === 1 ? "" : "s"} ` : " wallets "
  const narrow = inner < 90
  const hint = naming
    ? "type the new start · ↓ each name · ⏎ previews · esc goes back"
    : o.picked.length
      ? narrow
        ? "↑/↓ · ⏎ picks · on a group, all of it · → names them · esc closes"
        : "↑/↓ a wallet · ⏎ picks or unpicks it · ⏎ on a group picks all of it · → names them · esc closes"
      : narrow
        ? "↑/↓ · type to find · ⏎ picks to name · esc closes"
        : "↑/↓ a wallet · type to find · ⏎ picks it to name with others · esc closes"
  const room = h - 3
  let body: Line[]
  let more = ""
  if (naming) body = namingLines(o, props.data, inner).slice(0, room)
  else {
    const { head, rows, at } = everyLines(o, props.data, inner)
    const space = Math.max(1, room - head.length)
    const lit = at[o.index] ?? 0
    const start = Math.max(0, Math.min(rows.length - space, lit - Math.floor(space / 3)))
    const shown = rows.slice(start, start + space)
    const below = rows.length - start - shown.length
    more = below > 0 ? `↓ ${below} more ` : ""
    body = [...head, ...shown]
  }
  const act = (ref: string, a: string) => {
    if (a === "copy") return props.onCopy(ref)
    if (ref === "name" || ref === "clear" || ref === "preview" || ref === "back") return props.onAct(ref)
    return props.onFill(ref)
  }
  return (
    <box position="absolute" zIndex={OVERLAY_Z} left={Math.floor((props.width - w) / 2)} top={2} width={w} height={h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} titleColor={C.head} title={title} flexDirection="column" paddingLeft={1}>
      <box flexDirection="column" height={h - 3}>
        <Lines lines={body} width={inner} onAct={act} onPick={(pick) => props.onAct("pick", Number(pick.id.slice(3)))} />
      </box>
      <box flexDirection="row" height={1}>
        <text fg={C.dim}>{fit(hint, inner - more.length)}</text>
        <box flexGrow={1} />
        {more ? <text fg={C.dim}>{more}</text> : null}
      </box>
    </box>
  )
}

