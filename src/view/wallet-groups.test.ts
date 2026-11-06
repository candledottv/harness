// Wallet groups in the view: the typed `group` command, the lists' one order, the Wallets
// pane's open group and search, the approvals menu grouped and found by typing, naming several at once,
// and P&L's wallets added up by group. The frames are wallet-groups-frame.test.tsx's.
import { describe, expect, test } from "bun:test"
import type { PnlView } from "../core/pnl"
import { CLOCK } from "../../test/frame-scenes"
import { pnlScene } from "../../test/pnl-scene"
import { fiftyAddress, fiftyWallets } from "../../test/wallets-scene"
import { approvalsEntries, approvalsList, groupLine } from "./approvals"
import { type CommandContext, parseCommand } from "./commands"
import { everyRows, namingAsks, namingRows, sharedStart, togglePick } from "./every-wallet"
import { type Effect, INITIAL_UI, type Key, step, type UiAction, type UiContext, type UiState } from "./keys"
import { textOf } from "./panes/lines"
import { pnlLines } from "./panes/pnl"
import { walletLines, walletsMenuRows } from "./panes/wallets"
import { groupedWallets, groupOfRow, headingId, NO_GROUP, walletRowId } from "./wallet-list"

const F = fiftyWallets(CLOCK - 3_000)
const GROUPS = F.wallets.groups!

describe("group, typed", () => {
  const c: CommandContext = { agents: ["agent-a"], knownTokens: new Map(), wallets: F.wallets }
  test("add, remove, prefix (and none), delete: each the core's op, at once", () => {
    expect(parseCommand("group swing add beta", c)).toEqual({ kind: "group", op: { op: "add", group: "swing", wallets: ["beta"] } })
    expect(parseCommand("group swing add beta scratch", c)).toEqual({ kind: "group", op: { op: "add", group: "swing", wallets: ["beta", "scratch"] } })
    expect(parseCommand("group swing remove beta, scratch", c)).toEqual({ kind: "group", op: { op: "remove", group: "swing", wallets: ["beta", "scratch"] } })
    expect(parseCommand("group bots prefix bot-*", c)).toEqual({ kind: "group", op: { op: "prefix", group: "bots", prefix: "bot-*" } })
    expect(parseCommand("group bots prefix none", c)).toEqual({ kind: "group", op: { op: "prefix", group: "bots", prefix: null } })
    expect(parseCommand("group bots delete", c)).toEqual({ kind: "group", op: { op: "delete", group: "bots" } })
  })
  test("a group line missing its wallets says how, and English about groups goes to the agent", () => {
    expect(parseCommand("group swing add", c)).toMatchObject({ kind: "refused", keepLine: true, message: "Name a wallet: group swing add <wallet>, or several split by commas." })
    expect(parseCommand("group my wallets by agent please", c)).toEqual({ kind: "agent", text: "group my wallets by agent please" })
  })
})

describe("the lists' one order", () => {
  test("the embedded wallet first, then each group in name order, then no group; a search keeps each group's count", () => {
    const of = (w: (typeof F.portfolio.wallets)[number]) => ({ address: w.address, kind: w.kind, name: w.name! })
    const all = groupedWallets(F.portfolio.wallets, GROUPS, of)
    expect(all.top.map((w) => w.name)).toEqual(["main"])
    expect(all.groups.map((g) => [g.name, g.wallets.length])).toEqual([["bots", 24], ["copy", 6], ["lp", 3], ["snipers", 8], ["swing", 5], ["no group", 3]])
    const found = groupedWallets(F.portfolio.wallets, GROUPS, of, "bot-1")
    expect(found.top).toEqual([])
    expect(found.groups.map((g) => [g.name, g.wallets.length, g.total])).toEqual([["bots", 10, 24]])
  })
  test("the embedded wallet in a group sits in it and is counted there, not at the top", () => {
    const of = (w: (typeof F.portfolio.wallets)[number]) => ({ address: w.address, kind: w.kind, name: w.name! })
    const main = F.portfolio.wallets.find((w) => w.kind === "embedded")!
    const beta = F.portfolio.wallets.find((w) => w.name === "beta")!
    const pass = { name: "pass", list: ["main", "beta"], members: [main.address, beta.address], unknown: [] }
    const grouped = groupedWallets(F.portfolio.wallets, [pass], of)
    expect(grouped.top).toEqual([])
    expect(grouped.groups[0]).toMatchObject({ name: "pass", total: 2 })
    expect(grouped.groups[0]!.wallets.map((w) => w.name)).toEqual(["main", "beta"])
  })

  test("a row's id says its group: a heading's own, a wallet's under it, none at the top", () => {
    expect(groupOfRow(headingId("bots"))).toBe("bots")
    expect(groupOfRow(walletRowId("bots", fiftyAddress("bot-01")))).toBe("bots")
    expect(groupOfRow(walletRowId(NO_GROUP, fiftyAddress("beta")))).toBe(NO_GROUP)
    expect(groupOfRow(walletRowId("", "x"))).toBeUndefined()
  })
})

const pane = (open?: string, query?: string) =>
  walletLines(F.portfolio, { mode: "live", now: CLOCK, width: 43, grouping: { groups: GROUPS, ...(open ? { open } : {}), ...(query !== undefined ? { find: { query } } : {}) }, inside: new Map(F.autonomy.wallets.filter((w) => w.setting === "inside").map((w) => [w.wallet, { perDayUsd: 5, usedTodayUsd: 1 }])) }).map(textOf)

describe("the Wallets pane, grouped", () => {
  test("folded: one line a group, with how many, their SOL and ≈$, and how many trade inside limits", () => {
    const t = pane()
    // The embedded wallet's line and the groups' share their columns: name, SOL, ≈$.
    expect(t[0]).toBe("  main         2.184 SOL   ≈$328    ⧉ ")
    expect(t[1]).toBe("▸ bots     24   11.7 SOL ≈$1,755  12 inside")
    expect(t[0]!.indexOf(" SOL")).toBe(t[1]!.indexOf(" SOL"))
    expect(t.some((l) => l.includes("bot-01"))).toBe(false)
    expect(t.at(-1)).toMatch(/^▸ no group {2}3/)
  })
  test("open: its wallets one line each; a search opens every group it finds in, and says how to end it", () => {
    expect(pane("bots").slice(1, 3)).toEqual(["▾ bots     24   11.7 SOL ≈$1,755  12 inside", "  bot-01   0.55 SOL   ≈$82.50  inside    ⧉ "])
    const found = pane(undefined, "lp-0")
    expect(found).toContain("▾ lp  3 of 3 shown")
    expect(found.at(-1)).toBe("esc ends the search")
  })
  test("the menu's rows: every group, every wallet, then each group alone, the choice ticked", () => {
    const rows = walletsMenuRows(GROUPS, "group:bots")
    expect(rows.map((r) => r.label)).toEqual(["all groups", "every wallet", "bots", "copy", "lp", "snipers", "swing"])
    expect(rows.find((r) => r.on)?.value).toBe("group:bots")
  })
})

function ctx(over: Partial<UiContext> = {}): UiContext {
  return { cards: [], seenAt: {}, mode: "live", agents: ["agent-a"], activeAgent: "agent-a", commands: { agents: ["agent-a"], knownTokens: new Map() }, walletGroups: GROUPS, allWallets: F.portfolio.wallets, walletNames: F.names, autonomy: F.autonomy, ...over }
}
function run(actions: UiAction[], c: UiContext = ctx(), start: UiState = INITIAL_UI): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
const key = (name: string, now = 0, extra: Partial<Key> = {}): UiAction => ({ type: "key", key: { name, sequence: name.length === 1 ? name : undefined, ...extra }, now })
const type = (text: string, now = 0): UiAction[] => [...text].map((ch) => ({ type: "key", key: { name: ch, sequence: ch }, now }))

describe("the Wallets pane's keys", () => {
  const picks = { wallets: [{ id: walletRowId("", F.portfolio.wallets[0]!.address), mint: "", line: 0 }, { id: headingId("bots"), mint: "", line: 1 }, { id: headingId("copy"), mint: "", line: 2 }] }
  test("the group the highlight rests on opens once it has rested, and nothing goes to the core as a link", () => {
    const c = ctx({ picks })
    const r = run([{ type: "clickPane", pane: "wallets", now: 0 }, key("down", 0), key("down", 10), { type: "tick", now: 400 }], c)
    expect(r.state.wallets?.open).toBe("bots")
    expect(r.effects.some((e) => e.type === "link")).toBe(false)
  })
  test("a click on a group's line opens it at once, and on the open one folds it", () => {
    const pick = { id: headingId("copy"), mint: "" }
    const once = run([{ type: "clickRow", pane: "wallets", pick, now: 0 }])
    expect(once.state.wallets?.open).toBe("copy")
    expect(run([{ type: "clickRow", pane: "wallets", pick, now: 5 }], ctx(), once.state).state.wallets?.open).toBeUndefined()
  })
  test("⌕ find takes keys as typed, ⏎ keeps it, ↑ from the first row types again, and Esc ends it", () => {
    const typed = run([{ type: "walletsFind", now: 0 }, ...type("bot-1")])
    expect(typed.state.wallets?.find).toEqual({ query: "bot-1", editing: true })
    expect(typed.state.input).toBe("")
    const kept = run([key("return")], ctx(), typed.state)
    expect(kept.state.wallets?.find).toEqual({ query: "bot-1" })
    expect(run([key("escape")], ctx(), kept.state).state.wallets?.find).toBeUndefined()
    // Given back with nothing typed, there's no search.
    expect(run([{ type: "walletsFind", now: 0 }, key("return")]).state.wallets?.find).toBeUndefined()
  })
  test("the group menu's row picked goes to the core as which wallets show", () => {
    const r = run([{ type: "clickWalletsGroups", now: 0 }, key("down"), key("down"), key("return")])
    expect(r.effects).toContainEqual({ type: "walletsShow", show: "group:bots" })
  })
})

describe("the approvals menu, grouped", () => {
  test("its entries are the pane's order; the picked wallet's group is open and the others fold", () => {
    const e = approvalsEntries(F.autonomy, GROUPS)
    expect(e.slice(0, 2).map((x) => [x.wallet.name, x.group])).toEqual([["main", ""], ["bot-01", "bots"]])
    const rows = approvalsList(F.autonomy, GROUPS, { wallet: 3 })
    expect(rows[0]).toEqual({ kind: "head", inside: 13, of: 50 })
    expect(rows.filter((r) => r.kind === "group").map((r) => r.kind === "group" && [r.name, r.open, r.inside, r.of])).toEqual([["bots", true, 12, 24], ["copy", false, 0, 6], ["lp", false, 0, 3], ["snipers", false, 0, 8], ["swing", false, 0, 5], ["no group", false, 0, 3]])
    expect(groupLine(GROUPS, fiftyAddress("bot-03"))).toBe("in bots (bot-*) · its own setting, as every wallet has")
    expect(groupLine(GROUPS, fiftyAddress("beta"))).toBeUndefined()
  })
  test("typing on the list finds a wallet, keeping the pick where it's still found; Esc ends the search first", () => {
    const at = run([key("down"), key("down"), key("down")], ctx(), { ...INITIAL_UI, overlay: { kind: "approvals", wallet: 0, side: "wallets", row: 0 } })
    expect(at.state.overlay).toMatchObject({ wallet: 3 })
    const found = run(type("bot-0"), ctx(), at.state)
    expect(found.state.overlay).toMatchObject({ kind: "approvals", find: "bot-0" })
    const o = found.state.overlay as { wallet: number; find: string }
    expect(approvalsEntries(F.autonomy, GROUPS, o.find)[o.wallet]?.wallet.name).toBe("bot-03")
    const ended = run([key("escape")], ctx(), found.state)
    expect(ended.state.overlay).toMatchObject({ kind: "approvals", wallet: 3 })
    expect((ended.state.overlay as { find?: string }).find).toBeUndefined()
    expect(run([key("escape")], ctx(), ended.state).state.overlay).toBeUndefined()
  })
})

describe("naming several", () => {
  const names = (picked: string[]) => picked.map(fiftyAddress)
  test("⏎ picks a wallet, ⏎ on a group picks all of it, and again unpicks it", () => {
    const rows = everyRows(F.portfolio.wallets, GROUPS, "snipe")
    expect(rows[0]).toMatchObject({ kind: "group", name: "snipers", how: "names starting snipe-" })
    const all = togglePick([], rows[0])
    expect(all).toHaveLength(8)
    expect(togglePick(all, rows[0])).toEqual([])
    expect(togglePick([], rows[1])).toEqual([fiftyAddress("snipe-01")])
  })
  test("the start they share, to the last separator", () => {
    expect(sharedStart(["bot-21", "bot-22", "bot-24"])).toBe("bot-")
    expect(sharedStart(["alpha", "beta"])).toBe("")
    expect(sharedStart(["copy-01"])).toBe("copy-")
  })
  test("a new start for all: each new name, who keeps it, and the prefix group it leaves; only changes go", () => {
    const rows = namingRows(F.portfolio.wallets, names(["bot-21", "bot-22", "alpha"]), { from: "bot-", to: "grid-", each: {}, field: 1 }, F.names, GROUPS)
    expect(rows.map((r) => [r.now, r.next, r.keptBy, r.note])).toEqual([
      ["bot-21", "grid-21", "Candle (TEE)", "leaves bots (bot-*)"],
      ["bot-22", "grid-22", "Candle (TEE)", "leaves bots (bot-*)"],
      ["alpha", "alpha", "Candle (TEE)", undefined],
    ])
    expect(namingAsks(rows)).toEqual([
      { wallet: fiftyAddress("bot-21"), name: "grid-21" },
      { wallet: fiftyAddress("bot-22"), name: "grid-22" },
    ])
  })
  test("a clash shows before anything is asked: the same name twice, or another wallet's", () => {
    const twice = namingRows(F.portfolio.wallets, names(["bot-21", "bot-22"]), { from: "bot-", to: "x", each: { [fiftyAddress("bot-22")]: "x21" }, field: 1 }, F.names, GROUPS)
    expect(twice.map((r) => r.problem)).toEqual(["two would have this name", "two would have this name"])
    const taken = namingRows(F.portfolio.wallets, names(["bot-21"]), { from: "", to: "", each: { [fiftyAddress("bot-21")]: "beta" }, field: 2 }, F.names, GROUPS)
    expect(taken[0]!.problem).toBe("another wallet has this name")
  })
  test("from the keys: picked, → for the naming step, the new start typed, ⏎ sends one wallets.name for the lot", () => {
    const r = run([...type("bot-2"), key("down"), key("down"), key("return"), key("down"), key("return"), key("right"), key("backspace"), key("backspace"), key("backspace"), key("backspace"), ...type("grid-"), key("return")], ctx(), { ...INITIAL_UI, overlay: { kind: "everyWallet", query: "", index: 0, picked: [] } })
    expect(r.effects).toContainEqual({ type: "nameWallets", names: [{ wallet: fiftyAddress("bot-21"), name: "grid-21" }, { wallet: fiftyAddress("bot-22"), name: "grid-22" }] })
    expect(r.state.overlay).toBeUndefined()
  })
})

describe("P&L's wallets by group", () => {
  test("each group's wallets added up, its wallets under it; with no groups, as before", () => {
    const row = (name: string, total: number) => ({ wallet: fiftyAddress(name), payerType: "linked", label: name, realizedNetUsd: total, unrealizedUsd: 0, totalUsd: total, feesUsd: 0, openPositions: 0, agents: ["momentum"] })
    const pnl: PnlView = { ...pnlScene(CLOCK), wallets: [row("bot-01", 1), row("bot-02", 1.5), row("beta", 0.5)] }
    const t = pnlLines(pnl, { width: 70, now: CLOCK, groups: GROUPS }).map(textOf)
    const at = t.findIndex((l) => l.startsWith("bots"))
    expect(at).toBeGreaterThan(0)
    expect(t[at]).toContain("+$2.50")
    expect(t[at + 1]).toMatch(/^ {2}\S/)
    expect(t.some((l) => l.startsWith("no group") && l.includes("+$0.50"))).toBe(true)
    expect(pnlLines(pnl, { width: 70, now: CLOCK }).map(textOf).some((l) => l.startsWith("bots"))).toBe(false)
  })
})
