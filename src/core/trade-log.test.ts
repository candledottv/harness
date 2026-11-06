// What the Trade tab reads from the journal: the activity pane's lines, each agent's paper book (the
// portfolio never shows paper), and which agents bought into each holding.
import { describe, expect, test } from "bun:test"
import type { JournalRow } from "./journal"
import { sessionNote, TradeLog } from "./trade-log"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
let seq = 0
const row = (type: string, fields: Record<string, unknown> = {}): JournalRow => ({
  seq: ++seq,
  at: `2026-10-26T14:${String(seq).padStart(2, "0")}:00.000Z`,
  type,
  account: "acct_x",
  mode: "live",
  ...fields,
})
const symbols = (mint: string) => ({ [MOON]: "MOON", [PEPE]: "PEPE" })[mint]
const log = (...rows: JournalRow[]) => {
  const l = new TradeLog({ symbolOf: symbols })
  for (const r of rows) l.add(r)
  return l
}
const texts = (l: TradeLog) => l.activity().map((e) => e.text)

const created = (cardId: string, agent = "momentum", extra: Record<string, unknown> = {}) =>
  row("card.created", { agent, cardId, opId: `op-${cardId}`, role: "harness", kind: "trade", tool: "candle_trade", params: { mint: MOON, side: "buy", amount: "0.1" }, title: "BUY 0.1 SOL (≈$15.00) → MOON", ...extra })
const paperBuy = (agent: string, mint: string, tokenAmount: number) =>
  row("paper.call", {
    mode: "paper",
    agent,
    tool: "candle_trade",
    args: { mint, side: "buy", amount: "0.01", paper: true },
    isError: false,
    answer: JSON.stringify({ api: { paper: true, side: "buy", mint, quoteAsset: "sol", amountRaw: "10000000", expectedOutRaw: "2380952", tokenDecimals: 6, tokenAmount } }),
  })

describe("activity", () => {
  test("a card's life, in words, with who did it", () => {
    const l = log(
      created("c1"),
      row("card.approved", { agent: "momentum", cardId: "c1", opId: "op-c1", side: "buy", usd: 15 }),
      row("operation.submitting", { agent: "momentum", opId: "op-c1" }),
      row("operation.succeeded", { agent: "momentum", opId: "op-c1" }),
      created("c2", "swing"),
      row("card.rejected", { agent: "swing", cardId: "c2", opId: "op-c2" }),
      created("c3", "momentum", { role: "view" }),
      row("card.expired", { agent: "momentum", cardId: "c3", opId: "op-c3", reason: "expired" }),
    )
    expect(texts(l)).toEqual([
      "momentum proposed BUY 0.1 SOL (≈$15.00) → MOON",
      "approved BUY 0.1 SOL (≈$15.00) → MOON",
      "filled BUY 0.1 SOL (≈$15.00) → MOON",
      "swing proposed BUY 0.1 SOL (≈$15.00) → MOON",
      "rejected BUY 0.1 SOL (≈$15.00) → MOON",
      "you proposed BUY 0.1 SOL (≈$15.00) → MOON",
      "expired BUY 0.1 SOL (≈$15.00) → MOON",
    ])
    expect(l.activity()[2]).toMatchObject({ agent: "momentum", tone: "good", at: "2026-10-26T14:04:00.000Z" })
  })

  test("a trade the core ran without a card says so, in the words it was checked with, and its fill says so too", () => {
    const words = "without a card, inside the embedded wallet's limits ($0.90 of $1.00 a trade, $0.90 of $2.00 today)"
    const l = log(
      created("c1"),
      row("card.approved", { agent: "momentum", cardId: "c1", opId: "op-c1", side: "buy", usd: 0.9, how: "inside-limits", inside: { words } }),
      row("operation.succeeded", { agent: "momentum", opId: "op-c1", cardId: "c1" }),
    )
    expect(texts(l)).toEqual(["momentum proposed BUY 0.1 SOL (≈$15.00) → MOON", `sent BUY 0.1 SOL (≈$15.00) → MOON ${words}`, "filled BUY 0.1 SOL (≈$15.00) → MOON · without a card"])
  })

  test("a live sell Candle closed as the key's paper position is never 'filled'", () => {
    const l = log(
      created("c1", "momentum", { params: { mint: MOON, side: "sell", percent: 50 }, title: "SELL 50% of MOON" }),
      row("card.approved", { agent: "momentum", cardId: "c1", opId: "op-c1", side: "sell" }),
      row("operation.succeeded", { agent: "momentum", opId: "op-c1", cardId: "c1", paper: true }),
    )
    const last = l.activity().at(-1)!
    expect(last.text).toBe("SELL 50% of MOON: not sold live: the wallet held none, so Candle closed this key's paper position instead")
    expect(last.tone).toBe("warn")
  })

  test("a card made in place of an open one is a re-proposal, not a second proposal (the kill switch's fresh sells)", () => {
    const l = log(
      created("c1", "momentum", { role: "view", title: "SELL 50% of MOON", side: "sell" }),
      created("c2", "momentum", { role: "view", title: "SELL 50% of MOON", side: "sell", replaces: "c1" }),
      row("card.withdrawn", { agent: "momentum", cardId: "c1", reason: "kill_switch_fresh", replacedBy: "c2" }),
    )
    expect(texts(l)).toEqual([
      "you proposed SELL 50% of MOON",
      "re-proposed SELL 50% of MOON at a fresh price",
      "withdrew SELL 50% of MOON (the kill switch replaced it with a card at a fresh price)",
    ])
  })

  test("failures, unknown outcomes, refusals, the kill switch, modes and typed CLI runs", () => {
    const l = log(
      created("c1"),
      row("operation.failed", { agent: "momentum", opId: "op-c1", error: { code: "SLIPPAGE_EXCEEDED" } }),
      created("c2"),
      row("operation.unknown", { agent: "momentum", opId: "op-c2" }),
      row("card.refused", { agent: "momentum", tool: "candle_trade", code: "LIMIT_PER_TRADE" }),
      row("tool.refused", { agent: "swing", tool: "candle_cli", code: "FLAG_FORBIDDEN" }),
      row("card.refused", { agent: "swing", role: "view", tool: "candle_trade", code: "OVER_TRADE_LIMIT", message: "Over swing's Candle Harness limit: $3.00 is more than $2.00 per trade." }),
      row("operation.refused", { agent: "momentum", opId: "op-c2", error: { code: "SWAP_FAILED", message: "nothing was signed or sent. Retry to build a fresh one." } }),
      row("kill.on", { by: "v1" }),
      row("kill.off", { by: "v1" }),
      row("mode.changed", { mode: "paper" }),
      row("engine.chosen", { agent: "momentum", engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", by: "v1" }),
      row("engine.chosen", { agent: "swing", engine: "codex", model: null, by: "v1" }),
      row("cli.typed", { argv: ["keys", "revoke", "ab12cd34"], rule: "less-access" }),
      row("cli.typed_result", { argv: ["keys", "revoke", "ab12cd34"], exitCode: 0, timedOut: false }),
      row("cli.typed_result", { argv: ["keys", "revoke", "zz99zz99"], exitCode: 1, timedOut: false }),
      row("agent.leftovers", { agent: "momentum", processes: [{ name: "node", pid: 42 }] }),
      row("journal.torn_tail", { skipped: 1 }),
    )
    expect(texts(l)).toEqual([
      "momentum proposed BUY 0.1 SOL (≈$15.00) → MOON",
      "failed BUY 0.1 SOL (≈$15.00) → MOON: SLIPPAGE_EXCEEDED",
      "momentum proposed BUY 0.1 SOL (≈$15.00) → MOON",
      "no answer yet for BUY 0.1 SOL (≈$15.00) → MOON: reading it back",
      "refused momentum's trade: LIMIT_PER_TRADE",
      "refused swing's command: FLAG_FORBIDDEN",
      "refused your trade: Over swing's Candle Harness limit: $3.00 is more than $2.00 per trade.",
      "failed BUY 0.1 SOL (≈$15.00) → MOON: SWAP_FAILED: nothing was signed or sent. Retry to build a fresh one.",
      "kill switch on: buys paused",
      "resumed: buys allowed again",
      "now in paper mode",
      "momentum now on Pi · openrouter/deepseek/deepseek-v4.1-flash",
      "swing now on Codex",
      "you ran candle keys revoke ab12cd34",
      "done candle keys revoke ab12cd34",
      "failed candle keys revoke zz99zz99: exit 1",
      "still running after momentum's turn: node (42)",
    ])
    expect(l.activity().find((e) => e.text.startsWith("failed"))?.tone).toBe("bad")
  })

  test("a revoke or other narrowing is done, not filled", () => {
    const l = log(created("c1", "momentum", { kind: "lessaccess", tool: "candle_cli", title: "LESS ACCESS · candle keys revoke ab12cd34" }), row("operation.succeeded", { agent: "momentum", opId: "op-c1" }))
    expect(texts(l).at(-1)).toBe("done LESS ACCESS · candle keys revoke ab12cd34")
  })

  test("paper trades read as paper, with what the quote said came back", () => {
    const l = log(paperBuy("momentum", MOON, 2.380952), row("paper.call", { mode: "paper", agent: "swing", tool: "candle_trade", args: { mint: PEPE, side: "buy" }, isError: true, answer: "{}" }))
    expect(texts(l)).toEqual(["paper buy MOON by momentum: ≈2.380952 MOON at the quoted price", "paper candle_trade refused for swing"])
  })

  test("keeps the newest lines only", () => {
    const l = new TradeLog({ symbolOf: symbols, keep: 3 })
    for (let i = 0; i < 5; i++) l.add(row("mode.changed", { mode: i % 2 ? "paper" : "live" }))
    expect(l.activity()).toHaveLength(3)
  })

  test("tells a listener about each new line, and only new lines", () => {
    const seen: string[] = []
    const l = new TradeLog({ symbolOf: symbols, onLine: (e) => seen.push(e.text) })
    l.add(row("kill.on"))
    l.add(row("client.attached"))
    expect(seen).toEqual(["kill switch on: buys paused"])
  })
})

describe("paper books, per agent", () => {
  test("buys add what the quote said came back; sells take it away by amount or percent", () => {
    const l = log(
      paperBuy("momentum", MOON, 2),
      paperBuy("momentum", MOON, 3),
      row("paper.call", { mode: "paper", agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", amount: "1" }, isError: false, answer: "{}" }),
      row("paper.call", { mode: "paper", agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 50 }, isError: false, answer: "{}" }),
      paperBuy("swing", PEPE, 7),
    )
    expect(l.paper()).toEqual({
      momentum: [expect.objectContaining({ mint: MOON, symbol: "MOON", tokens: 2, buys: 2, sells: 2 })],
      swing: [expect.objectContaining({ mint: PEPE, symbol: "PEPE", tokens: 7, buys: 1, sells: 0 })],
    })
    // A paper sell says how much.
    expect(texts(l).filter((t) => t.startsWith("paper sell"))).toEqual(["paper sell MOON by momentum: ≈1 MOON at the quoted price", "paper sell MOON by momentum: ≈2 MOON at the quoted price"])
  })

  test("a sell read by itself, as the Journal reads it, says what Candle's quote sold and for how much", () => {
    const answer = JSON.stringify({ api: { tokenAmount: 1.924632, expectedOutRaw: "5158231" } })
    const l = log(row("paper.call", { mode: "paper", agent: "momentum", role: "view", tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 50 }, isError: false, answer }))
    expect(texts(l)).toEqual(["paper sell MOON by you (as momentum): ≈1.92463 MOON for ≈0.005158 SOL at the quoted price"])
  })

  test("each position keeps what it cost at the quotes, and a sell's quoted proceeds less the sold share's cost", () => {
    const sell = (percent: number, outRaw?: string) =>
      row("paper.call", { mode: "paper", agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", percent }, isError: false, answer: JSON.stringify({ api: { paper: true, quoteAsset: "sol", ...(outRaw ? { expectedOutRaw: outRaw } : {}) } }) })
    // Two buys of 0.01 SOL each, then half sold for 0.015 SOL.
    const l = log(paperBuy("momentum", MOON, 2), paperBuy("momentum", MOON, 2), sell(50, "15000000"))
    const [p] = l.paperBooks().momentum!
    expect(p!.cost!.sol).toBeCloseTo(0.01, 12)
    expect(p!.realized!.sol).toBeCloseTo(0.005, 12)
    expect(p!.realizedUnknown).toBeUndefined()
    // A sell whose quote had no proceeds: what was realised isn't known, and says so.
    const unknown = log(paperBuy("momentum", MOON, 2), sell(100))
    expect(unknown.paperBooks().momentum![0]).toMatchObject({ tokens: 0, realizedUnknown: true })
    // A position sold to nothing stays in the books P&L reads, not in the open ones.
    expect(unknown.paper()).toEqual({})
  })

  test("a typed paper trade says it was yours", () => {
    const typed = { ...paperBuy("momentum", MOON, 2), role: "view" }
    expect(texts(log(typed))).toEqual(["paper buy MOON by you (as momentum): ≈2 MOON at the quoted price"])
    // A wallet named on it isn't part of it: paper is the key's own book.
    expect(texts(log({ ...typed, walletNamed: "embedded" }))).toEqual(["paper buy MOON by you (as momentum): ≈2 MOON at the quoted price (paper is the key's own book, not a wallet's)"])
  })

  test("a refused paper trade, or one whose answer can't be read, changes nothing", () => {
    const l = log(row("paper.call", { mode: "paper", agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "buy" }, isError: false, answer: "not json" }))
    expect(l.paper()).toEqual({})
  })

  test("a position sold to nothing leaves the book", () => {
    const l = log(paperBuy("momentum", MOON, 2), row("paper.call", { mode: "paper", agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 100 }, isError: false, answer: "{}" }))
    expect(l.paper()).toEqual({})
  })
})

describe("who bought into a holding", () => {
  test("agents whose live buys of that mint filled, in the order they did", () => {
    const l = log(
      created("c1", "swing"),
      row("operation.succeeded", { agent: "swing", opId: "op-c1" }),
      created("c2", "momentum"),
      row("operation.succeeded", { agent: "momentum", opId: "op-c2" }),
      created("c3", "other"),
      row("operation.failed", { agent: "other", opId: "op-c3" }),
      created("c4", "late", { params: { mint: MOON, side: "sell", percent: 50 } }),
      row("operation.succeeded", { agent: "late", opId: "op-c4" }),
    )
    expect(l.buyers(MOON)).toEqual(["swing", "momentum"])
    expect(l.buyers(PEPE)).toEqual([])
  })
})

describe("what the agent is told", () => {
  test("settled trades with who proposed each, swaps included; nothing to tell is undefined", () => {
    expect(sessionNote([], {})).toBeUndefined()
    const l = log(
      created("c1", "momentum", { role: "view", kind: "swap", tool: "candle_swap", title: "SWAP 0.01 SOL (≈$1.00) → USDC" }),
      row("operation.succeeded", { agent: "momentum", opId: "op-c1", mode: "live" }),
      created("c2", "swing"),
      row("operation.refused", { agent: "swing", opId: "op-c2", mode: "live", error: { code: "MCP_VALIDATION" } }),
    )
    const trades = l.sessionTrades()
    expect(trades.map((t) => [t.by, t.agent, t.text])).toEqual([
      ["you", "momentum", "filled SWAP 0.01 SOL (≈$1.00) → USDC"],
      ["agent", "swing", "failed BUY 0.1 SOL (≈$15.00) → MOON: MCP_VALIDATION"],
    ])
    const note = sessionNote(trades, {})!
    expect(note).toContain("leave out swaps")
    expect(note).toContain("· live · typed by the person, as momentum · filled SWAP 0.01 SOL (≈$1.00) → USDC")
    expect(note).toContain("· live · asked for by swing · failed BUY")
  })

  test("cards that ended without running, and refusals, with who proposed each", () => {
    const l = log(
      created("c1", "momentum"),
      row("card.withdrawn", { cardId: "c1", reason: "kill_switch", mode: "live" }),
      created("c2", "momentum"),
      row("card.rejected", { cardId: "c2", mode: "live" }),
      created("c3", "swing", { role: "view" }),
      row("card.expired", { cardId: "c3", mode: "live" }),
      row("card.refused", { agent: "momentum", role: "view", tool: "candle_trade", code: "OVER_TRADE_LIMIT", message: "Over momentum's Candle Harness limit: $3.01 with Candle's 0.25% fee is more than $2.00 per trade.", mode: "live" }),
      row("card.refused", { agent: "swing", role: "harness", tool: "candle_trade", code: "TOKEN_NOT_TRADABLE", message: "This token isn't tradable on Candle right now.", mode: "live" }),
    )
    expect(l.sessionTrades().map((t) => [t.by, t.agent, t.text])).toEqual([
      ["agent", "momentum", "withdrew BUY 0.1 SOL (≈$15.00) → MOON (kill switch)"],
      ["agent", "momentum", "rejected BUY 0.1 SOL (≈$15.00) → MOON"],
      ["you", "swing", "expired BUY 0.1 SOL (≈$15.00) → MOON"],
      ["you", "momentum", "the Candle Harness refused the trade (nothing reached Candle): Over momentum's Candle Harness limit: $3.01 with Candle's 0.25% fee is more than $2.00 per trade."],
      ["agent", "swing", "the Candle Harness refused the trade (nothing reached Candle): This token isn't tradable on Candle right now."],
    ])
  })

  test("the kill switch going on and off is in the record, said by the Candle Harness (the agent once missed the resume)", () => {
    const l = log(row("kill.on", { by: "v1", mode: "live" }), row("kill.off", { by: "v1", mode: "live" }))
    expect(l.sessionTrades().map((t) => [t.by, t.text])).toEqual([
      ["harness", "kill switch on: buys paused"],
      ["harness", "resumed: buys allowed again"],
    ])
    const note = sessionNote(l.sessionTrades(), {})!
    expect(note).toMatch(/- \d\d:\d\d:\d\d UTC · live · kill switch on: buys paused/)
    expect(note).toMatch(/UTC · live · resumed: buys allowed again/)
  })

  test("a card names the wallet that pays: a TEE wallet's label, or embedded; a post names none", () => {
    const l = log(
      created("c1", "momentum", { wallet: "WalletFake111111111111111111111111111111111" }),
      row("card.rejected", { cardId: "c1", mode: "live" }),
      created("c2", "momentum", { route: "cli", wallet: "TeeOne11111111111111111111111111111111111111", walletLabel: "tee-one" }),
      row("card.rejected", { cardId: "c2", mode: "live" }),
      created("c3", "momentum", { wallet: "none", kind: "public", title: "POST" }),
      row("card.rejected", { cardId: "c3", mode: "live" }),
    )
    expect(l.sessionTrades().map((t) => t.text)).toEqual([
      "rejected BUY 0.1 SOL (≈$15.00) → MOON from embedded",
      "rejected BUY 0.1 SOL (≈$15.00) → MOON from tee-one",
      "rejected POST",
    ])
  })

  test("the record keeps 60 rows and says how many older ones it left out; the wallets come first", () => {
    const rows = []
    for (let i = 0; i < 65; i++) rows.push(created(`c${i}`), row("card.rejected", { cardId: `c${i}`, mode: "live" }))
    const l = log(...rows)
    expect(l.sessionTrades()).toHaveLength(60)
    expect(l.sessionLeftOut()).toBe(5)
    const note = sessionNote(l.sessionTrades(), {}, { leftOut: l.sessionLeftOut(), wallets: "Your wallets (momentum): …" })!
    expect(note.split("\n").slice(0, 3)).toEqual([
      "Your wallets (momentum): …",
      expect.stringMatching(/^What has gone through the Candle Harness lately/),
      "(5 older entries are left out. Say so if asked about them, rather than guessing.)",
    ])
    expect(sessionNote([], {}, { wallets: "Your wallets (momentum): …" })).toBe("Your wallets (momentum): …")
    // A date line where the UTC day changes.
    const days = sessionNote(
      [
        { at: "2026-10-26T23:59:00.000Z", mode: "live", by: "you", text: "filled A" },
        { at: "2026-10-27T00:01:00.000Z", mode: "live", by: "you", text: "filled B" },
      ],
      {},
    )!
    expect(days.split("\n").slice(1)).toEqual([
      "2026-10-26, UTC:",
      "- 23:59:00 UTC · live · typed by the person · filled A",
      "2026-10-27, UTC:",
      "- 00:01:00 UTC · live · typed by the person · filled B",
    ])
  })

  test("a withdrawal says why: the kill switch, in the older row's shape too, or a card paid from another wallet", () => {
    const l = log(
      created("c1", "momentum"),
      row("card.withdrawn", { cardId: "c1", by: "kill_switch", mode: "live" }),
      created("c2", "momentum"),
      row("card.withdrawn", { cardId: "c2", by: "v1", reason: "paid_from_another_wallet", mode: "live" }),
    )
    expect(l.sessionTrades().map((t) => t.text)).toEqual([
      "withdrew BUY 0.1 SOL (≈$15.00) → MOON (kill switch)",
      "withdrew BUY 0.1 SOL (≈$15.00) → MOON (replaced by a card paid from another wallet)",
    ])
  })
})

describe("steps run in the prompt pane", () => {
  const pane = (opId: string, outcome: string, words: string) => ({ opId, result: { pane: { outcome, words } } })
  test("typed: what you ran, the pane opening, and how it ended in the pane's words; no card lines", () => {
    const l = log(
      row("cli.typed", { agent: "momentum", argv: ["tee", "fund", "TeeF", "--amount", "0.001"], rule: "read" }),
      created("p1", "momentum", { role: "view", route: "pane", kind: "read", tool: "candle_cli", headline: "READ · candle tee fund TeeF…1111" }),
      row("card.approved", { agent: "momentum", cardId: "p1", opId: "op-p1", how: "typed" }),
      row("operation.submitting", { agent: "momentum", cardId: "p1", opId: "op-p1", route: "pane" }),
      row("operation.pending", { agent: "momentum", cardId: "p1", opId: "op-p1", reason: "in the prompt pane" }),
      row("operation.succeeded", { agent: "momentum", cardId: "p1", ...pane("op-p1", "finished", "finished in the pane.") }),
    )
    expect(texts(l)).toEqual(["you ran candle tee fund TeeF --amount 0.001", "opened the prompt pane for READ · candle tee fund TeeF…1111", "READ · candle tee fund TeeF…1111: finished in the pane."])
    expect(l.sessionTrades().map((t) => [t.by, t.text])).toEqual([["you", "READ · candle tee fund TeeF…1111: finished in the pane."]])
  })

  test("a refused command says which and why; a refused typed line is the user's; a funds-out card says where funds go", () => {
    const l = log(
      row("tool.refused", { agent: "momentum", role: "harness", tool: "candle_cli", code: "NOT_YET", command: "wallets close-empty", message: "candle wallets close-empty from a TEE wallet is coming: Candle keeps it off. Nothing was run." }),
      row("cli.refused", { agent: "momentum", role: "view", code: "LOOKALIKE_DESTINATION", command: "vault transfer", message: "AUTX2222…cwgJ looks like cold, a vault key on this machine (AUTX…cwgJ), but isn't it. Nothing was run." }),
      created("f1", "momentum", {
        route: "pane",
        kind: "funds-out",
        tool: "candle_cli",
        params: { pane: { rule: "funds-out", row: "vault transfer" } },
        headline: "FUNDS OUT · candle vault transfer AUTX…cwgJ --amount 0.01 --asset SOL --from desk",
        notes: ["Sends 0.01 SOL from desk to cold, a vault key on this machine (AUTX…cwgJ)."],
      }),
      row("card.approved", { agent: "momentum", cardId: "f1", opId: "op-f1", how: "enter" }),
      row("operation.succeeded", { agent: "momentum", cardId: "f1", ...pane("op-f1", "finished", "finished in the pane.") }),
    )
    expect(texts(l)).toEqual([
      "refused momentum's candle wallets close-empty: candle wallets close-empty from a TEE wallet is coming: Candle keeps it off. Nothing was run.",
      "refused your candle vault transfer: AUTX2222…cwgJ looks like cold, a vault key on this machine (AUTX…cwgJ), but isn't it. Nothing was run.",
      "momentum proposed FUNDS OUT · Sends 0.01 SOL from desk to cold, a vault key on this machine (AUTX…cwgJ)",
      "approved FUNDS OUT · Sends 0.01 SOL from desk to cold, a vault key on this machine (AUTX…cwgJ)",
      "FUNDS OUT · Sends 0.01 SOL from desk to cold, a vault key on this machine (AUTX…cwgJ): finished in the pane.",
    ])
    expect(l.sessionTrades().map((t) => [t.by, t.text.slice(0, 40)])).toEqual([
      ["agent", "the Candle Harness refused the candle wa"],
      ["you", "the Candle Harness refused the candle va"],
      ["agent", "FUNDS OUT · Sends 0.01 SOL from desk to "],
    ])
  })

  test("the agent's card: proposed and approved as any card; an unclear end is told to the agent too, never as being read back", () => {
    const l = log(
      created("p2", "momentum", { route: "pane", kind: "lessaccess", tool: "candle_cli", headline: "LESS ACCESS · candle tee disable TeeF…1111" }),
      row("card.approved", { agent: "momentum", cardId: "p2", opId: "op-p2", how: "enter" }),
      row("operation.submitting", { agent: "momentum", cardId: "p2", opId: "op-p2", route: "pane" }),
      row("operation.unknown", { agent: "momentum", cardId: "p2", ...pane("op-p2", "pending", "not confirmed yet (exit 3): it may still land: check the signature before anything else.") }),
    )
    expect(texts(l)).toEqual([
      "momentum proposed LESS ACCESS · candle tee disable TeeF…1111",
      "approved LESS ACCESS · candle tee disable TeeF…1111",
      "opened the prompt pane for LESS ACCESS · candle tee disable TeeF…1111",
      "LESS ACCESS · candle tee disable TeeF…1111: not confirmed yet (exit 3): it may still land: check the signature before anything else.",
    ])
    expect(texts(l).join(" ")).not.toContain("reading it back")
    expect(l.sessionTrades().map((t) => t.by)).toEqual(["agent"])
  })
})

describe("Hacc in activity", () => {
  test("a replay Hacc stopped at its 10-minute limit says so, and what may finish", () => {
    const l = log(
      row("hacc.replay", { agent: "momentum", jobId: 188, status: "failed", error: "hard timeout after 600s" }),
      row("hacc.replay", { agent: "momentum", jobId: 189, status: "failed", error: "no data" }),
      row("hacc.replay", { agent: "momentum", jobId: 190, status: "done", verdict: "fail", trades: 9, pnlUsd: -39.7997042568, drawdownPct: 39.79970425676918 }),
    )
    expect(texts(l).slice(0, 2)).toEqual(["Hacc stopped replay 188 at its 10-minute limit (hard timeout after 600s): a shorter window or a narrower entry may finish", "failed replay 189: no data"])
    // Hacc's figures, unrounded, read as Activity would say them.
    expect(texts(l)[2]).toBe("done replay 190 for momentum: fail, 9 trades, P&L -$39.80, drawdown 39.8%")
  })
  test("Hacc's statement timeout says what may finish (days timed out, hours finished)", () => {
    const l = log(row("hacc.replay", { agent: "momentum", jobId: 191, status: "failed", error: "canceling statement due to statement timeout" }))
    expect(texts(l)).toEqual(["Hacc timed out replay 191 (canceling statement due to statement timeout): a few hours may finish where days didn't"])
  })
})

describe("picking an Activity line", () => {
  test("each line about a token names its mint, for picking the line; a base asset or a line about no token names none", () => {
    const SOL = "So11111111111111111111111111111111111111112"
    const l = log(
      created("m1"),
      row("card.approved", { agent: "momentum", cardId: "m1" }),
      row("operation.succeeded", { agent: "momentum", opId: "op-m1" }),
      paperBuy("momentum", PEPE, 5),
      created("m2", "momentum", { params: { mint: SOL, side: "buy", amount: "0.1" } }),
      row("kill.on", {}),
    )
    expect(l.activity().map((e) => e.mint)).toEqual([MOON, MOON, MOON, PEPE, undefined, undefined])
  })
})
