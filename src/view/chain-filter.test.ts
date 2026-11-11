import { expect, test } from "bun:test"
import { chainChipLabel, chainMenuRows, chainScoped, chainShown, chainsInUse } from "./chain-filter"
import { paneLines } from "./panes/registry"
import { EMPTY_VIEW } from "./store"

const wallet = (chain: string) => ({ chain }) as never

test("the chains the account uses are its wallets' chains, in the registry's order; one chain means no filter to pick", () => {
  expect(chainsInUse(undefined)).toEqual([])
  expect(chainsInUse({ wallets: [wallet("solana"), wallet("solana")] } as never)).toEqual(["solana"])
  expect(chainsInUse({ wallets: [wallet("hood"), wallet("solana"), wallet("hood")] } as never)).toEqual(["solana", "hood"])
})

test("the chains in use are the core's answer, the one its lists go by, whatever wallets the view was sent", () => {
  expect(chainsInUse({ chains: ["solana"], wallets: [wallet("solana"), wallet("hood")] } as never)).toEqual(["solana"])
  expect(chainsInUse({ chains: ["hood", "solana"], wallets: [wallet("solana")] } as never)).toEqual(["solana", "hood"])
})

test("the chip says the choice: all chains, or the one chain's name", () => {
  expect(chainChipLabel(null)).toBe("all chains")
  expect(chainChipLabel("hood")).toBe("Hood")
  expect(chainChipLabel("solana")).toBe("Solana")
})

test("the menu: all chains, then each chain the account uses, the one on ticked", () => {
  expect(chainMenuRows(null, ["solana", "hood"])).toEqual([
    { value: null, label: "all chains", words: "every pane shows both", on: true },
    { value: "solana", label: "Solana", words: "every pane shows Solana only", on: false },
    { value: "hood", label: "Hood", words: "every pane shows Hood only", on: false },
  ])
  expect(chainMenuRows("hood", ["solana", "hood"]).find((r) => r.on)?.value).toBe("hood")
})

test("what a pane shows: everything with no choice, or with one chain in use; else only the chosen chain's rows", () => {
  expect(chainShown(null, ["solana", "hood"], "hood")).toBe(true)
  expect(chainShown("solana", ["solana", "hood"], "hood")).toBe(false)
  expect(chainShown("solana", ["solana", "hood"], "solana")).toBe(true)
  // A choice kept from when the account used two chains, now using one: nothing is hidden by a chip that isn't shown.
  expect(chainShown("hood", ["solana"], "solana")).toBe(true)
  // A row whose chain isn't known shows.
  expect(chainShown("hood", ["solana", "hood"], undefined)).toBe(true)
})

test("the view the listing panes draw from: each list keeps its rows on the chosen chain, and rows whose chain isn't known", () => {
  const SOL_W = "WalletFake111111111111111111111111111111111"
  const HOOD_W = "0x00000000000000000000000000000000000E1b01"
  const view = {
    views: { link: null, pins: [], signals: [], popped: [], chain: "hood" },
    portfolio: {
      readAt: 1,
      wallets: [{ address: SOL_W, chain: "solana" }, { address: HOOD_W, chain: "hood" }],
      readOnly: [],
      // Paper books carry no chain: each position goes by its token's address.
      paper: { a: [{ mint: "PepeFake11111111111111111111111111111111111", tokens: 1, buys: 1, sells: 0 }, { mint: "0x00000000000000000000000000000000000E1b02", tokens: 2, buys: 1, sells: 0 }], b: [{ mint: "MoonFake11111111111111111111111111111111111", tokens: 3, buys: 1, sells: 0 }] },
    },
    activity: [{ seq: 1, text: "a", chain: "solana" }, { seq: 2, text: "b", chain: "hood" }, { seq: 3, text: "kill" }],
    feeds: { new: { bucket: "new", at: 1, rows: [{ mint: "s", chain: "solana" }, { mint: "h", chain: "hood" }] } },
    signals: { rows: [{ id: 1, asset_chain: "solana" }, { id: 2, asset_chain: "hood" }, { kind: "gap" }] },
    pnl: {
      agents: [{ agent: "a", book: { positions: [{ mint: "s", chain: "solana" }, { mint: "h", chain: "hood" }], wallets: [] } }],
      wallets: [{ wallet: SOL_W }, { wallet: HOOD_W.toLowerCase() }],
      trades: [{ mint: "s", wallet: SOL_W }, { mint: "h", wallet: HOOD_W }, { mint: "x" }],
      swaps: [{ opId: "1", wallet: SOL_W }],
    },
    journal: { key: "", entries: [{ id: "1", chain: "solana" }, { id: "2", chain: "hood" }, { id: "3" }] },
  } as never
  const v = chainScoped(view)
  const ids = (xs: readonly object[] | undefined, k: string) => (xs ?? []).map((x) => (x as Record<string, unknown>)[k])
  expect(ids(v.portfolio?.wallets, "address")).toEqual([HOOD_W])
  // Paper positions follow the chip too; an agent left with none drops out of the list.
  expect(Object.keys(v.portfolio?.paper ?? {})).toEqual(["a"])
  expect(ids(v.portfolio?.paper?.a, "mint")).toEqual(["0x00000000000000000000000000000000000E1b02"])
  expect(ids(v.activity, "seq")).toEqual([2, 3])
  expect(ids(v.feeds?.new?.rows, "mint")).toEqual(["h"])
  expect(ids(v.signals?.rows, "id")).toEqual([2, undefined])
  expect(ids(v.pnl?.agents[0]?.book?.positions, "mint")).toEqual(["h"])
  expect(ids(v.pnl?.wallets, "wallet")).toEqual([HOOD_W.toLowerCase()])
  expect(ids(v.pnl?.trades, "mint")).toEqual(["h", "x"])
  expect(v.pnl?.swaps).toEqual([])
  expect(ids(v.journal?.entries, "id")).toEqual(["2", "3"])
  // All chains, or one chain in use: the view as it is.
  const all = { ...(view as object), views: { link: null, pins: [], signals: [], popped: [], chain: null } } as never
  expect(chainScoped(all)).toBe(all)
})

test("Final Stretch, pump.fun's, says it's Solana's while the account uses two chains, and says so in place of rows with Hood picked", () => {
  const SOL_W = "WalletFake111111111111111111111111111111111"
  const HOOD_W = "0x00000000000000000000000000000000000E1b01"
  const base = { ...EMPTY_VIEW, connected: true, feeds: { finalstretch: { bucket: "finalstretch" as const, at: 1_000, rows: [{ mint: "MoonFake11111111111111111111111111111111111", chain: "solana" as const, symbol: "MOON", marketCap: 1, priceUsd: null, change1h: null, progress: 0.9 }] } } }
  const draw = (wallets: object[], chain: "hood" | null) => paneLines("final-stretch", { view: { ...base, portfolio: { readAt: 1, wallets, readOnly: [], paper: {} }, views: { link: null, pins: [], signals: [], popped: [], chain } } as never, rect: { x: 0, y: 0, w: 60, h: 12 }, now: 2_000, only: undefined })
  const two = [{ address: SOL_W, chain: "solana", agents: [] }, { address: HOOD_W, chain: "hood", agents: [] }]
  const all = draw(two, null)
  expect(all.title).toStartWith("Final Stretch · Solana's")
  expect(all.lines.map((l) => l.segs.map((s) => s.text).join("")).join("\n")).toContain("MOON")
  const hood = draw(two, "hood")
  expect(hood.lines.map((l) => l.segs.map((s) => s.text).join("")).join(" ")).toContain("Final Stretch is pump.fun's, on Solana only")
  // One chain in use: as it was.
  expect(draw([{ address: SOL_W, chain: "solana", agents: [] }], null).title).not.toContain("Solana's")
})
