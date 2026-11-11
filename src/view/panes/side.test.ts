// The right column's panes: token, positions, wallets and activity. Each has an empty state, groups
// by wallet (several agents share one), and shows missing as —, never 0.
import { expect, test } from "bun:test"
import type { PortfolioView } from "../../core/portfolio-view"
import type { TokenView } from "../../core/token-watch"
import type { ActivityEntry } from "../../core/trade-log"
import { activityLines, clock } from "./activity"
import { type Line, textOf } from "./lines"
import { positionLines } from "./positions"
import { tokenLines } from "./token"
import { emptyWallets, walletLines, walletsTitle } from "./wallets"
import { C } from "../theme"
import { PANE_IDS } from "../layout"
import { EMPTY_VIEW } from "../store"
import { paneLines } from "./registry"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const W = "WalletFake111111111111111111111111111111111"
const NOW = 2_000_000_000_000
const join = (lines: Line[]) => lines.map(textOf).join("\n")

const trending: TokenView["trending"] = { bucket: "onfire", at: NOW - 5_000, rows: [{ mint: MOON, symbol: "MOON", name: "Moon Coin", marketCap: 812_000 }, { mint: PEPE, symbol: "PEPE", marketCap: null }] }
const followed = (over: Partial<TokenView> = {}): TokenView => ({
  followed: { mint: MOON, chain: "solana", symbol: "MOON", since: NOW - 120_000 },
  market: { name: "Moon Coin", symbol: "MOON", priceUsd: 0.63, marketCap: 1_000_000, liquidityUsd: 100_000, at: NOW - 12_000 },
  check: { summary: "incomplete", flagged: [], unknown: ["sellability"], at: NOW - 120_000 },
  samples: Array.from({ length: 9 }, (_, i) => ({ at: NOW - (8 - i) * 15_000, usd: 0.6 + i * 0.005 })),
  history: [],
  historyRead: null,
  change1h: null,
  trending,
  ...over,
})

test("token: no price from Candle shows the chart's last, ≈ and said so (a young token read — over a chart of prices)", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ at: NOW - (31 - i) * 60_000, usd: 0.00002 + i * 1e-7 }))
  const lines = tokenLines(followed({ market: { ...followed().market!, priceUsd: null }, samples: [], history, historyRead: { source: "hacc", at: NOW - 60_000 } }), { now: NOW, width: 80, height: 16 })
  const t = join(lines)
  expect(t).toContain("≈$0.0000229")
  expect(t).toContain("no price from Candle, so ≈ the chart's last, 2m ago")
  // A price from Candle is shown as it was.
  expect(join(tokenLines(followed(), { now: NOW, width: 80, height: 16 }))).toContain("$0.63  ")
})

test("token: Hacc's hour, then the samples, with the 1h change from the start; or the samples alone, saying why", () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ at: NOW - (62 - i) * 60_000, usd: 0.5 + i * 0.001 }))
  const t = join(tokenLines(followed({ history, historyRead: { source: "hacc", at: NOW - 120_000 }, change1h: 0.26 }), { now: NOW, width: 80, height: 16 }))
  expect(t).toContain("▲ 26.0% 1h")
  expect(t).toContain("MOON price in USD, last 62m: Hacc's history, then samples every 5s")
  const off = tokenLines(followed({ historyRead: { source: "samples", at: NOW - 120_000, words: "Hacc didn't answer in 5 s." } }), { now: NOW, width: 40, height: 16 })
  const words = join(off)
  expect(words).toContain(`samples since ${new Date(NOW - 120_000).toTimeString().slice(0, 5)}`)
  expect(words.replace(/\n/g, " ")).toContain("No history from Hacc: Hacc didn't answer in 5 s.")
  // The words wrap under the chart; the chart gives up the rows, so the pane keeps its height.
  expect(off.length).toBeLessThanOrEqual(16)
})

test("token: the followed token's figures, each with its time and source, its check, and a chart that says what it plots", () => {
  const t = join(tokenLines(followed(), { now: NOW, width: 60, height: 14 }))
  expect(t).toContain("MOON  Moon Coin")
  expect(t).toContain("$0.63  — 1h   mcap $1M  liq $100K")
  expect(t).toContain("Candle market read, 12s ago")
  expect(t).toContain("check incomplete · unknown: sellability")
  expect(t).toContain(`MOON price in USD, samples since ${new Date(NOW - 120_000).toTimeString().slice(0, 5)}`)
  // The contract address, short, with a ⧉ chip that carries the whole mint.
  const lines = tokenLines(followed(), { now: NOW, width: 60, height: 14 })
  const ca = lines.find((l) => l.ref === MOON)!
  expect(textOf(ca)).toBe("Moon…1111  ⧉ ")
  expect(ca.segs.at(-1)).toMatchObject({ act: "copy" })
  expect(join(tokenLines(followed(), { now: NOW, width: 60, height: 14, shownInFull: MOON }))).toContain(MOON)
  expect(t).toContain("$0.64")
})

test("token: a flagged check is called out; an old read is marked stale", () => {
  const lines = tokenLines(followed({ check: { summary: "flagged", flagged: ["lpLock"], unknown: [], at: NOW }, market: { ...followed().market!, at: NOW - 600_000 } }), { now: NOW, width: 60, height: 14 })
  // A flag is something to read first: amber, not red.
  expect(join(lines)).toContain("⚑ flagged: lpLock")
  expect(lines.find((l) => textOf(l).includes("flagged"))!.segs[0]!.fg).toBe(C.look)
  expect(join(lines)).toContain("10m ago · stale")
})

test("a check that didn't load says so, not that the token is unclean", () => {
  const t = join(tokenLines(followed({ check: { summary: "unavailable", flagged: [], unknown: [], at: NOW, note: "RATE_LIMITED" } }), { now: NOW, width: 80, height: 14 }))
  expect(t).toContain("safety check didn't load (RATE_LIMITED): unchecked, not clean")
})

test("token: before the agent discusses one, Candle's trending list; before that, that it's reading", () => {
  const t = join(tokenLines({ followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null, trending }, { now: NOW, width: 80, height: 14 }))
  expect(t).toContain("Trending on Candle (on fire) · 5s ago")
  // Off the Trending tab On Fire is read a minute apart: 54 s old isn't stale, two minutes is.
  const at = (ms: number) => join(tokenLines({ followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null, trending: { ...trending, at: NOW - ms } }, { now: NOW, width: 80, height: 14 }))
  expect(at(54_000)).not.toContain("stale")
  expect(at(125_000)).toContain("· stale")
  expect(t).toContain("MOON")
  expect(t).toContain("$812K")
  expect(t).toContain("The token the agent discusses, or the one you pick, shows here.")
  expect(join(tokenLines(undefined, { now: NOW, width: 200, height: 14 }))).toContain("Waiting on Candle for its On Fire list: the first read takes a few seconds.")
})

const portfolio = (over: Partial<PortfolioView> = {}): PortfolioView => ({
  readAt: NOW - 4_000,
  wallets: [
    {
      address: W,
      chain: "solana",
      kind: "embedded",
      agents: ["momentum", "swing"],
      nativeSymbol: "SOL", native: { amount: 2, usd: 300 },
      tokens: [
        { mint: MOON, symbol: "MOON", amount: 12345.678901, usd: 7777.78, buyers: ["swing", "momentum"] },
        { mint: PEPE, symbol: "PEPE", amount: 5, usd: null, buyers: [] },
      ],
    },
  ],
  readOnly: [],
  paper: {},
  deposit: W,
  ...over,
})

test("positions: by wallet, once, with every agent on it; each holding with who bought it; unpriced is —", () => {
  const t = join(positionLines(portfolio(), { mode: "live", now: NOW, width: 70, market: undefined }))
  expect(t).toContain("embedded wallet · momentum, swing")
  expect(t.match(/embedded wallet/g)).toHaveLength(1)
  // The wallet heads its holdings (as a footer it read as the next wallet's heading).
  expect(t.indexOf("embedded wallet")).toBeLessThan(t.indexOf("MOON"))
  // Amounts rounded: whole from 1,000.
  expect(t).toMatch(/MOON\s+12,346\s+≈\$7,777\.78\s+swing, momentum/)
  expect(t).toMatch(/PEPE\s+5\s+—/)
})

test("positions: a wallet Candle couldn't read says so, never an empty list", () => {
  const t = join(positionLines(portfolio({ wallets: [{ ...portfolio().wallets[0]!, tokens: null }] }), { mode: "live", now: NOW, width: 70, market: undefined }))
  expect(t).toContain("couldn't read this wallet's tokens")
})

test("positions: before the first trade, trending on Candle with starter prompts", () => {
  const t = join(positionLines(portfolio({ wallets: [{ ...portfolio().wallets[0]!, tokens: [] }] }), { mode: "live", now: NOW, width: 70, market: followed() }))
  expect(t).toContain("No positions yet. Trending on Candle:")
  expect(t).toContain("MOON")
  expect(t).toContain("try: ask the agent")
})

test("positions in paper mode: each agent's paper book, labelled as such, counting only this Candle Harness's paper trades", () => {
  const t = join(positionLines(portfolio({ paper: { momentum: [{ mint: MOON, symbol: "MOON", tokens: 2.380952, buys: 1, sells: 0 }] } }), { mode: "paper", now: NOW, width: 70, market: undefined }))
  expect(t).toContain("paper, at the quoted price · only paper trades made here")
  expect(t).toContain("momentum")
  expect(t).toMatch(/MOON\s+2\.381/)
  expect(join(positionLines(portfolio(), { mode: "paper", now: NOW, width: 70, market: undefined }))).toContain("No open paper positions.\n\ntry: ask the agent \"what's moving on Candle?\"\nor type: buy $1 of <token>")
})

test("wallets: each wallet once on one line, with its agents, balances and a ⧉ chip; an agent without the embedded wallet is read only, with the owner's command", () => {
  const lines = walletLines(portfolio({ readOnly: [{ agent: "watcher", command: "candle keys update ij90kl12 --embedded-wallet allow" }] }), { mode: "live", now: NOW, width: 120 })
  const t = join(lines)
  expect(t).toContain("embedded · momentum, swing  2 SOL ≈$300.00")
  // The embedded wallet's address is the deposit address: its ⧉ chip copies it, and there's no deposit row.
  expect(t).not.toContain("deposit")
  const embedded = lines.find((l) => textOf(l).startsWith("embedded"))!
  expect(embedded.ref).toBe(W)
  expect(embedded.segs.at(-1)).toMatchObject({ act: "copy" })
  // Copied, it shows in full on the line below, for 20 s.
  const copied = walletLines(portfolio(), { mode: "live", now: NOW, width: 120, shownInFull: W }).map(textOf)
  expect(copied[copied.findIndex((l) => l.startsWith("embedded")) + 1]).toBe(`  ${W}`)
  // After the wallets, one line, with a chip that types the owner's command (first, and three rows each,
  // they pushed the only wallet out).
  const ro = lines.findIndex((l) => textOf(l).startsWith("watcher: read only"))
  expect(ro).toBeGreaterThan(lines.findIndex((l) => textOf(l).startsWith("embedded")))
  expect(lines[ro]!.ref).toBe("candle keys update ij90kl12 --embedded-wallet allow")
  expect(lines[ro]!.segs.at(-1)).toMatchObject({ act: "fill" })
})

test("wallets: a TEE wallet this Candle Harness stopped shows with no balance and a chip that types its sweep; the title names a choice that isn't the default", () => {
  const T = "Tee1111111111111111111111111111111111111111"
  const p = portfolio()
  const stopped = { ...p, wallets: [...p.wallets, { address: T, chain: "solana" as const, kind: "tee" as const, label: "desk", agents: ["momentum"], active: false, stopped: true as const, nativeSymbol: "SOL", native: null, tokens: null }] }
  for (const rows of [undefined, 3]) {
    const lines = walletLines(stopped, { mode: "live", now: NOW, width: 120, ...(rows ? { rows } : {}) })
    const at = lines.findIndex((l) => textOf(l).startsWith("desk · TEE"))
    expect(textOf(lines[at]!)).toContain("stopped for good")
    expect(lines[at]!.ref).toBe(T)
    expect(lines[at + 1]!.ref).toBe(`candle tee sweep ${T} as momentum`)
    expect(lines[at + 1]!.segs.at(-1)).toMatchObject({ act: "fill" })
  }
  expect(walletsTitle(p, NOW, "all")).toStartWith("Wallets · all · read")
  expect(walletsTitle(p, NOW, "active")).toStartWith("Wallets · read")
})

test("wallets: a stopped TEE wallet shows what the chain says is still in it; one Candle stopped listing says so; one empty on chain needs no sweep", () => {
  const T = "Tee1111111111111111111111111111111111111111"
  const p = portfolio()
  const base = { address: T, chain: "solana" as const, kind: "tee" as const, label: "desk", agents: ["momentum"], active: false, stopped: true as const, tokens: null }
  const at = (w: Record<string, unknown>) => {
    const lines = walletLines({ ...p, wallets: [...p.wallets, { ...base, nativeSymbol: "SOL", native: null, ...w }] }, { mode: "live", now: NOW, width: 120 })
    const i = lines.findIndex((l) => textOf(l).startsWith("desk · TEE"))
    return [lines[i]!, lines[i + 1]!] as const
  }
  const [head, funds] = at({ nativeSymbol: "SOL", native: { amount: 0.0412, usd: 6.18 }, heldTokens: 2 })
  expect(textOf(head)).toContain("stopped for good")
  expect(textOf(funds)).toContain("0.0412 SOL ≈$6.18 and 2 tokens still in it")
  expect(funds.ref).toBe(`candle tee sweep ${T} as momentum`)
  const [outsideHead, outside] = at({ stoppedOutside: true, nativeSymbol: "SOL", native: { amount: 0.5, usd: null }, heldTokens: 0 })
  expect(textOf(outsideHead)).toContain("no longer listed by Candle")
  expect(textOf(outside)).toContain("stopped outside the Candle Harness, most likely · 0.5 SOL still in it")
  const [, unread] = at({ balanceError: "rpc.example: rate limited" })
  expect(textOf(unread)).toContain("balance not read (rpc.example: rate limited)")
  expect(unread.segs.at(-1)).toMatchObject({ act: "fill" })
  const [, empty] = at({ nativeSymbol: "SOL", native: { amount: 0, usd: 0 }, heldTokens: 0 })
  expect(textOf(empty)).toContain("empty on chain")
  expect(empty.ref).toBeUndefined()
})

test("wallets: before any read, the embedded wallet by name with its ⧉, and a line for the mode, with no deposit row", () => {
  const paper = walletLines(portfolio({ readAt: null, wallets: [] }), { mode: "paper", now: NOW, width: 80 })
  expect(paper[0]).toMatchObject({ ref: W })
  expect(join(paper)).not.toContain("deposit")
  expect(join(paper)).toContain("embedded")
  expect(join(paper)).toContain("Paper trades need no funds.")
  const live = join(walletLines(portfolio({ readAt: null, wallets: [] }), { mode: "live", now: NOW, width: 80 }))
  expect(live).toContain("Reading your wallets…")
  expect(live).not.toContain("Paper trades")
})

test("wallets: read, with no agent's key allowed the embedded wallet, it's unread, not empty: no \"send SOL\"", () => {
  const denied = portfolio({ wallets: [], readOnly: [{ agent: "watcher", command: "candle keys update ij90kl12 --embedded-wallet allow" }] })
  const t = join(walletLines(denied, { mode: "paper", now: NOW, width: 80 }))
  expect(t).not.toContain("send SOL")
  expect(t).toContain("Its balance isn't shown: no agent's key here may use it. allow lets one.")
  expect(t).toContain("Paper trades need no funds.")
  expect(t).toContain("watcher: read only, no wallet")
  // An allowed key's empty wallet still says where to send funds.
  const empty = portfolio({ wallets: [{ ...portfolio().wallets[0]!, nativeSymbol: "SOL", native: { amount: 0, usd: 0 }, tokens: [] }] })
  expect(join(walletLines(empty, { mode: "live", now: NOW, width: 80 }))).toContain("send SOL to trade live")
})

test("activity: newest last, with the time and who; empty says what will show", () => {
  const entries: ActivityEntry[] = [
    { seq: 1, at: new Date(NOW - 60_000).toISOString(), agent: "momentum", text: "momentum proposed BUY 0.1 SOL (≈$15.00) → MOON", tone: "info" },
    { seq: 2, at: new Date(NOW).toISOString(), agent: "momentum", text: "filled BUY 0.1 SOL (≈$15.00) → MOON", tone: "good" },
  ]
  const lines = activityLines(entries, 80).map(textOf)
  expect(lines).toEqual([`${clock(entries[0]!.at)}  momentum proposed BUY 0.1 SOL (≈$15.00) → MOON`, `${clock(entries[1]!.at)}  filled BUY 0.1 SOL (≈$15.00) → MOON`])
  // The outcome word in its colour, the time dim.
  const filled = activityLines(entries, 80)[1]!
  expect(filled.segs.map((s) => s.fg)).toEqual([C.dim, C.good, C.ink])
  expect(activityLines(entries, 80)[0]!.segs.map((s) => s.fg)).toEqual([C.dim, C.ink])
  expect(activityLines([], 80).map(textOf).join(" ")).toContain("Cards, fills, refusals and the kill switch show here")
})

test("every pane in the registry draws a title and a line of words, the newest ones included", () => {
  const view = EMPTY_VIEW
  for (const id of PANE_IDS.filter((p) => p !== "agent")) {
    const drawn = paneLines(id, { view, rect: { x: 0, y: 0, w: 60, h: 12 }, now: 0, only: undefined })
    expect({ id, title: drawn.title.length > 0, words: drawn.lines.some((l) => l.segs.some((s) => s.text.trim().length > 0)) }).toEqual({ id, title: true, words: true })
  }
  // The Perps stub's chips put their questions on the input line.
  const perps = paneLines("perps", { view, rect: { x: 0, y: 0, w: 80, h: 12 }, now: 0, only: undefined })
  expect(perps.lines.filter((l) => l.segs.some((s) => s.act === "fill")).map((l) => l.ref)).toEqual(["show me Hyperliquid's biggest perps markets", "what are my perps positions?"])
})

test("wallets: each called by the core's name, the embedded wallet's own after it, a marked one amber; a name chip types the line", () => {
  const TEE = "TeeA1111111111111111111111111111111111111111"
  const p = portfolio({
    wallets: [
      { ...portfolio().wallets[0]!, label: "main", name: "main" },
      { address: TEE, chain: "solana" as const, kind: "tee" as const, label: "embedded", name: "embedded", marked: "\"embedded\" already means the account's embedded wallet", agents: ["momentum"], active: true, nativeSymbol: "SOL", native: { amount: 1, usd: 150 }, tokens: [] },
    ],
  })
  const wide = walletLines(p, { mode: "live", now: NOW, width: 120 })
  expect(textOf(wide[0]!)).toStartWith("main · embedded · momentum, swing")
  const tee = wide.find((l) => textOf(l).includes("· TEE"))!
  expect(tee.segs[0]).toMatchObject({ text: "embedded", fg: C.look })
  // Wide enough, the row carries it, before ⧉; a marked name is typed by address.
  expect(wide[0]!.segs.find((s) => s.act === "fill")).toMatchObject({ ref: "name main " })
  expect(tee.segs.find((s) => s.act === "fill")).toMatchObject({ ref: `name ${TEE} ` })
  expect(tee.segs.at(-1)).toMatchObject({ act: "copy" })
  // Narrow, it's under the address once ⧉ shows it in full.
  const narrow = walletLines(p, { mode: "live", now: NOW, width: 46, shownInFull: W })
  expect(narrow.flatMap((l) => l.segs).find((s) => s.act === "fill")).toMatchObject({ text: " name it ", ref: "name main " })
})

test("wallets: a TEE wallet's empty token accounts, as Candle's preview counted them, with `close` once the Candle Harness runs it", () => {
  const T = "Tee1111111111111111111111111111111111111111"
  const p = portfolio()
  const withTee = { ...p, wallets: [...p.wallets, { address: T, chain: "solana" as const, kind: "tee" as const, label: "desk", agents: ["momentum"], active: true, nativeSymbol: "SOL", native: { amount: 0.5, usd: 75 }, tokens: [] }] }
  const empty = new Map([[T, { count: 3, netSol: "0.00611284", agent: "momentum" }]])
  const at = (lines: Line[]) => lines.findIndex((l) => textOf(l).includes("empty token accounts"))
  // Held until its live check: the words, under the wallet's line, and nothing to press.
  const held = walletLines(withTee, { mode: "live", now: NOW, width: 120, empty })
  expect(textOf(held[at(held)]!)).toBe("  3 empty token accounts · 0.00611 SOL back")
  expect(textOf(held[at(held) - 1]!)).toStartWith("desk · TEE")
  expect(held[at(held)]!.segs.some((s) => s.act !== undefined)).toBe(false)
  // Switched on: `close`, its line carrying the wallet.
  const on = walletLines(withTee, { mode: "live", now: NOW, width: 120, empty, closeOn: true })
  expect(textOf(on[at(on)]!)).toBe("  3 empty token accounts · 0.00611 SOL back   close ")
  expect(on[at(on)]!.ref).toBe(T)
  expect(on[at(on)]!.segs.at(-1)).toMatchObject({ act: "closeEmpty" })
  // No agent known for it, no chip; none counted, nothing at all.
  const nobody = walletLines(withTee, { mode: "live", now: NOW, width: 120, empty: new Map([[T, { count: 3, netSol: "0.00611284" }]]), closeOn: true })
  expect(nobody[at(nobody)]!.segs.some((s) => s.act !== undefined)).toBe(false)
  expect(join(walletLines(withTee, { mode: "live", now: NOW, width: 120, closeOn: true }))).not.toContain("empty")
  // One line a wallet: a word, where there's room; the whole line under its address once ⧉ shows it.
  const compact = walletLines(withTee, { mode: "live", now: NOW, width: 120, rows: 1, empty, closeOn: true })
  expect(textOf(compact.find((l) => textOf(l).startsWith("desk"))!)).toContain("· 3 empty")
  expect(at(compact)).toBe(-1)
  const shown = walletLines(withTee, { mode: "live", now: NOW, width: 120, rows: 1, empty, closeOn: true, shownInFull: T })
  expect(textOf(shown[at(shown)]!)).toBe("  3 empty token accounts · 0.00611 SOL back   close ")
})

test("wallets: the counts come from the wallets topic, only where Candle counted some", () => {
  const T = "Tee1111111111111111111111111111111111111111"
  const U = "Tee2222222222222222222222222222222222222222"
  const V = "Tee3333333333333333333333333333333333333333"
  const topic = {
    agents: {},
    account: [],
    boundTo: { [T]: "momentum" },
    empty: { [T]: { count: 2, netSol: "0.004", totalSol: "0.004", feeSol: "0", transactions: 1, at: 0 }, [U]: { count: 0, netSol: "0", totalSol: "0", feeSol: "0", transactions: 0, at: 0 }, [V]: { code: "CLOSE_EMPTY_DISABLED", failed: "off", at: 0 } },
  }
  expect([...emptyWallets(topic)]).toEqual([[T, { count: 2, netSol: "0.004", agent: "momentum" }]])
  expect(emptyWallets(undefined).size).toBe(0)
})
