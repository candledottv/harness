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

  test("a swap whose first leg went and second failed is said as part done, with the first leg's hash, never as plainly failed", () => {
    const l = log(created("c1", "momentum", { role: "view", title: "SWAP 0.02 SOL → USDC", side: "swap" }), row("operation.failed", { agent: "momentum", opId: "op-c1", partial: { leg1: "Leg1HashFake1111111111111111111111111111111" }, error: { code: "LEG2_FAILED" } }))
    expect(texts(l).at(-1)).toBe("part done SWAP 0.02 SOL → USDC: the first leg went (Leg1…1111), the second failed: LEG2_FAILED")
    expect(l.activity().at(-1)!.tone).toBe("warn")
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
    expect(texts(l)).toEqual(["paper buy MOON by momentum: ≈2.381 MOON at the quoted price", "paper candle_trade refused for swing"])
  })

  test("a token whose name could pass for another's is named with its short address", () => {
    // A Cyrillic С: "Сoin" beside a real "COIN" reads the same.
    const l = new TradeLog({ symbolOf: (mint) => (mint === PEPE ? "\u0421oin" : "MOON") })
    for (const r of [paperBuy("momentum", PEPE, 2), paperBuy("momentum", MOON, 1)]) l.add(r)
    expect(texts(l)).toEqual(["paper buy \u0421oin (Pepe…1111) by momentum: ≈2 \u0421oin (Pepe…1111) at the quoted price", "paper buy MOON by momentum: ≈1 MOON at the quoted price"])
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
    expect(texts(l)).toEqual(["paper sell MOON by you (as momentum): ≈1.925 MOON for ≈0.005158 SOL at the quoted price"])
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

describe("a trigger's firing", () => {
  test("in Activity's words: never the person's or the agent's, the fill says by which trigger, and an expired card offers run it now", () => {
    const t = { trigger: "dip", fireId: "fire_1", part: 0 }
    const l = log(
      row("trigger.fired", { agent: "momentum", name: "dip", fireId: "fire_1", words: "MOON was $0.39, under $0.40" }),
      created("t1", "momentum", { role: "core", clientId: "core:triggers", ...t, title: "BUY 0.01 SOL → MOON" }),
      row("card.approved", { agent: "momentum", cardId: "t1", opId: "op-t1", how: "inside-limits", ...t, inside: { words: "without a card, inside the embedded wallet's limits ($1.51 of $2.00 a trade, $1.51 of $4.00 today)" } }),
      row("operation.succeeded", { agent: "momentum", opId: "op-t1" }),
      created("t2", "momentum", { role: "core", clientId: "core:triggers", ...t, fireId: "fire_2", title: "BUY 0.02 SOL → MOON" }),
      row("trigger.waiting", { agent: "momentum", name: "dip", fireId: "fire_2", words: "BUY 0.02 SOL → MOON waits for you: the embedded wallet asks every time" }),
      row("card.expired", { agent: "momentum", cardId: "t2", opId: "op-t2", trigger: "dip" }),
      row("trigger.held", { agent: "momentum", name: "dip", reason: "paused", words: "the kill switch holds its buy, so it wasn't sent" }),
      row("trigger.run_now", { agent: "momentum", name: "dip", cardId: "t2" }),
    )
    expect(texts(l)).toEqual([
      'trigger "dip" fired: MOON was $0.39, under $0.40',
      'trigger "dip" proposed BUY 0.01 SOL → MOON',
      "sent BUY 0.01 SOL → MOON without a card, inside the embedded wallet's limits ($1.51 of $2.00 a trade, $1.51 of $4.00 today)",
      'filled BUY 0.01 SOL → MOON · without a card · by trigger "dip"',
      'trigger "dip" proposed BUY 0.02 SOL → MOON',
      'trigger "dip": BUY 0.02 SOL → MOON waits for you: the embedded wallet asks every time',
      "expired BUY 0.02 SOL → MOON: nobody pressed it",
      'trigger "dip": the kill switch holds its buy, so it wasn\'t sent',
      `you ran trigger "dip"'s line again, at a fresh price`,
    ])
    expect(l.activity().find((e) => e.text.startsWith("expired"))?.runNow).toBe("t2")
    // The agent is told the fill was the trigger's, not the person's nor its own.
    const note = sessionNote(l.sessionTrades(), {})!
    expect(note).toContain('fired by the trigger "dip", as momentum · filled BUY 0.01 SOL → MOON')
    expect(note).not.toContain("typed by the person")
  })

  test("is one line in Activity: what it saw, then what came of it, kept up to date; each row keeps its own words", () => {
    const t = (fireId: string) => ({ trigger: "dip", fireId, part: 0 })
    const sent: number[] = []
    const l = new TradeLog({ symbolOf: symbols, onLine: (e) => void sent.push(e.seq) })
    const at = (s: number) => ({ at: new Date(Date.UTC(2026, 9, 26, 14, 0, s)).toISOString() })
    const fired = { ...row("trigger.fired", { agent: "momentum", name: "dip", fireId: "fire_a", words: "MOON was $0.39, under $0.40" }), ...at(0) }
    for (const r of [
      fired,
      { ...created("f1", "momentum", { role: "core", ...t("fire_a"), title: "SELL 50% of MOON" }), ...at(1) },
      { ...row("card.approved", { agent: "momentum", cardId: "f1", opId: "op-f1", how: "inside-limits", ...t("fire_a") }), ...at(1) },
      { ...row("operation.submitting", { agent: "momentum", cardId: "f1", opId: "op-f1" }), ...at(1) },
      { ...row("operation.succeeded", { agent: "momentum", opId: "op-f1" }), ...at(5) },
      { ...row("trigger.ran", { agent: "momentum", name: "dip", fireId: "fire_a", outcome: "done", sent: 1, parts: 1 }), ...at(5) },
    ])
      l.add(r)
    const shown = l.activity().filter((e) => !e.hidden)
    expect(shown.map((e) => e.firing)).toEqual([{ name: "dip", said: "MOON was $0.39, under $0.40 → filled SELL 50% of MOON in 4.0 s, without a card" }])
    expect(shown[0]!.tone).toBe("good")
    // Said again as each row came, in its place: the view puts it where it was.
    expect(sent.filter((s) => s === fired.seq).length).toBeGreaterThan(1)
    // The Journal and the notices still read each row in its own words.
    expect(l.lineFor(fired.seq + 4)?.text).toBe('filled SELL 50% of MOON · without a card · by trigger "dip"')

    // One that waits, then expires with nobody there: amber, with run it now on the firing's line.
    const w = log(
      row("trigger.fired", { agent: "momentum", name: "dip", fireId: "fire_b", words: "MOON was $0.38, under $0.40" }),
      created("f2", "momentum", { role: "core", ...t("fire_b"), title: "BUY $3.00 of MOON" }),
      row("trigger.waiting", { agent: "momentum", name: "dip", fireId: "fire_b", cardId: "f2", words: "BUY $3.00 of MOON waits for you: over the embedded wallet's $1.50 a trade" }),
      row("card.expired", { agent: "momentum", cardId: "f2", opId: "op-f2", trigger: "dip" }),
    )
    const line = w.activity().filter((e) => !e.hidden)
    expect(line.map((e) => e.firing?.said)).toEqual(["MOON was $0.38, under $0.40 → BUY $3.00 of MOON expired, nobody pressed it"])
    expect(line[0]).toMatchObject({ tone: "warn", runNow: "f2" })

    // A notice, and a stop, end the line in their own words.
    const n = log(row("trigger.fired", { agent: "momentum", name: "tape", fireId: "fire_c", words: "a confluence signal on MOON" }), row("trigger.notify", { agent: "momentum", name: "tape", fireId: "fire_c", words: "MOON is moving" }))
    expect(n.activity().filter((e) => !e.hidden).map((e) => e.firing?.said)).toEqual(["a confluence signal on MOON → notified: MOON is moving"])
    // A paper trade makes no card: the line says it's paper's, so the agent pane shows it.
    const p = log(row("trigger.fired", { mode: "paper", agent: "momentum", name: "stop", fireId: "fire_p", words: "MOON was $0.39, under $0.40" }), row("paper.call", { mode: "paper", agent: "momentum", role: "core", trigger: "stop", fireId: "fire_p", tool: "candle_swap", isError: false }))
    expect(p.activity().filter((e) => !e.hidden).map((e) => [e.agent, e.firing?.paper])).toEqual([["momentum", true]])
    expect(n.activity().find((e) => !e.hidden)?.firing?.paper).toBeUndefined()
    const stopped = log(row("trigger.fired", { agent: "momentum", name: "dip", fireId: "fire_d", words: "MOON was $0.39" }), row("trigger.ran", { agent: "momentum", name: "dip", fireId: "fire_d", outcome: "stopped", words: "over momentum's $1.00 a trade", sent: 0 }))
    expect(stopped.activity().filter((e) => !e.hidden).map((e) => [e.firing?.said, e.tone])).toEqual([["MOON was $0.39 → stopped: over momentum's $1.00 a trade", "bad"]])
  })

  test("a run of a notify trigger's firings is one line with a count, until another line comes between", () => {
    let s = 0
    const at = () => ({ at: new Date(Date.UTC(2026, 10, 5, 5, 0, s++ * 10)).toISOString() })
    const fire = (id: string, words: string) => [{ ...row("trigger.fired", { agent: "momentum", name: "tape", fireId: id, words }), ...at() }, { ...row("trigger.notify", { agent: "momentum", name: "tape", fireId: id, words: `New ticker · ${words}` }), ...at() }]
    const l = log(...fire("f1", "a new_ticker signal on AAAA"), ...fire("f2", "a new_ticker signal on BBBB"), ...fire("f3", "a new_ticker signal on CCCC"))
    const shown = l.activity().filter((e) => !e.hidden)
    expect(shown).toHaveLength(1)
    expect(shown[0]!.firing!.said).toMatch(/^a new_ticker signal on CCCC · fired 3 times since \d\d:\d\d → notified: New ticker · a new_ticker signal on CCCC$/)
    // Another line between them starts a new one; a trade's firing is never folded.
    l.add({ ...row("kill.on", { by: "v1" }), ...at() })
    for (const r of fire("f4", "a new_ticker signal on DDDD")) l.add(r)
    expect(l.activity().filter((e) => !e.hidden).map((e) => e.firing?.said ?? e.text).at(-1)).toBe("a new_ticker signal on DDDD → notified: New ticker · a new_ticker signal on DDDD")
  })

  test("a trigger's refusal and paper trade name the trigger", () => {
    const l = log(
      row("card.refused", { agent: "momentum", role: "core", trigger: "dip", tool: "candle_trade", code: "OVER_TRADE_LIMIT", message: "over momentum's $1.00 a trade" }),
      row("paper.call", { mode: "paper", agent: "momentum", role: "core", trigger: "dip", tool: "candle_swap", isError: false }),
    )
    expect(texts(l)).toEqual([`refused trigger "dip"'s trade: over momentum's $1.00 a trade`, `paper candle_swap by trigger "dip" (as momentum)`])
  })
})

test("the clock line: this machine's time with its zone and offset, and that the record is UTC", () => {
  const { clockNote } = require("./trade-log") as typeof import("./trade-log")
  const at = new Date(2026, 10, 5, 0, 5).getTime()
  const line = clockNote(at)
  expect(line).toStartWith("It's 00:05 on Thu, 5 Nov 2026 on this machine (")
  expect(line).toMatch(/\(([A-Z]{2,5}, )?UTC([+−]\d\d:\d\d)?\)\./)
  expect(line).toContain("Schedules, \"today\" and the P&L window use this machine's time; the record's times are UTC.")
})

describe("a rules bot in Activity", () => {
  const BONK = "BonkFake11111111111111111111111111111111111"
  const syms = (mint: string) => ({ [MOON]: "MOON", [PEPE]: "PEPE", [BONK]: "BONK" })[mint]
  const at = (s: number) => ({ at: new Date(Date.UTC(2026, 10, 6, 9, 0, s)).toISOString() })
  /** An entry's rows: the decision, its card run without one, and its fill 4 s after it was sent. */
  const entry = (bot: string, signal: number, mint: string, t: number, mode: "live" | "paper" = "live") => {
    const id = `e${signal}`
    const origin = { bot, botAct: "entry", botSignal: signal }
    return [
      { ...row("bot.entering", { agent: "momentum", name: bot, signalId: signal, mint, usd: 2, botMode: mode, words: `buys $2.00 of ${syms(mint)} on a confluence signal at 09:00` }), ...at(t) },
      { ...created(id, "momentum", { role: "core", clientId: `core:bot:${bot}`, ...origin, params: { mint, side: "buy" }, title: `BUY $2.00 of ${syms(mint)}` }), ...at(t) },
      { ...row("card.approved", { agent: "momentum", cardId: id, opId: `op-${id}`, how: "inside-limits", ...origin }), ...at(t) },
      { ...row("operation.submitting", { agent: "momentum", cardId: id, opId: `op-${id}` }), ...at(t) },
      { ...row("operation.succeeded", { agent: "momentum", opId: `op-${id}` }), ...at(t + 4) },
    ]
  }
  const exit = (bot: string, position: string, mint: string, reason: string, t: number) => {
    const id = `x${position}`
    const origin = { bot, botAct: "exit", botPosition: position, botReason: reason }
    return [
      { ...row("bot.exiting", { agent: "momentum", name: bot, position, mint, reason, botMode: "live", words: `sells 100 ${syms(mint)}: ${reason}` }), ...at(t) },
      { ...created(id, "momentum", { role: "core", ...origin, params: { mint, side: "sell" }, title: `SELL 100 ${syms(mint)}` }), ...at(t) },
      { ...row("card.approved", { agent: "momentum", cardId: id, opId: `op-${id}`, how: "bot-exit", ...origin }), ...at(t) },
      { ...row("operation.submitting", { agent: "momentum", cardId: id, opId: `op-${id}` }), ...at(t) },
      { ...row("operation.succeeded", { agent: "momentum", opId: `op-${id}` }), ...at(t + 3) },
    ]
  }
  const shownOf = (l: TradeLog) => l.activity().filter((e) => !e.hidden)

  test("its entries, exits and skips fold into one line while nothing else comes between; each row keeps its words", () => {
    const sent: number[] = []
    const l = new TradeLog({ symbolOf: syms, onLine: (e) => void sent.push(e.seq) })
    const rows = [
      ...entry("conf", 1, MOON, 0),
      { ...row("bot.skipped", { agent: "momentum", name: "conf", reason: "slot_full", count: 3, words: "3 signals, the last because every slot is full" }), ...at(10) },
      ...entry("conf", 2, BONK, 20),
      ...exit("conf", "op-e1", MOON, "take_profit", 30),
    ]
    for (const r of rows) l.add(r)
    const shown = shownOf(l)
    expect(shown).toHaveLength(1)
    expect(shown[0]!.firing).toEqual({ name: "conf", said: "bought MOON, BONK · took profit on MOON · 3 skipped", bot: true })
    expect(shown[0]!.tone).toBe("good")
    // The line is said again as each row comes, in its place.
    expect(sent.filter((s) => s === rows[0]!.seq).length).toBeGreaterThan(3)
    // The Journal and the notices read each row in its own words, the fill saying by which bot.
    expect(l.lineFor(rows[4]!.seq)?.text).toBe('filled BUY $2.00 of MOON · without a card · by the bot "conf"')
    expect(l.lineFor(rows[0]!.seq)?.text).toBe('the bot "conf" buys $2.00 of MOON on a confluence signal at 09:00')
    // One act alone reads as itself.
    const one = new TradeLog({ symbolOf: syms })
    for (const r of entry("conf", 9, PEPE, 0)) one.add(r)
    expect(shownOf(one).map((e) => e.firing?.said)).toEqual(["bought $2.00 of PEPE in 4.0 s"])
  })

  test("a line between starts another; an exit at a stop and a refusal stand alone", () => {
    const fresh = new TradeLog({ symbolOf: syms })
    for (const r of entry("conf", 1, MOON, 0)) fresh.add(r)
    fresh.add({ ...row("kill.off", { by: "v1" }), ...at(8) })
    for (const r of entry("conf", 2, BONK, 10)) fresh.add(r)
    for (const r of exit("conf", "op-e1", MOON, "stop_loss", 20)) fresh.add(r)
    for (const r of entry("conf", 3, PEPE, 30)) fresh.add(r)
    fresh.add({ ...row("bot.entering", { agent: "momentum", name: "conf", signalId: 4, mint: MOON, usd: 2, botMode: "live", words: "buys $2.00 of MOON" }), ...at(40) })
    fresh.add({ ...row("bot.entry_ended", { agent: "momentum", name: "conf", signalId: 4, mint: MOON, outcome: "refused", words: "MOON: its buy was refused: over momentum's $1.00 a trade" }), ...at(41) })
    expect(shownOf(fresh).map((e) => [e.firing?.said ?? e.text, e.tone])).toEqual([
      ["bought $2.00 of MOON in 4.0 s", "good"],
      ["resumed: buys allowed again", "good"],
      ["bought $2.00 of BONK in 4.0 s", "good"],
      ["sold MOON at its stop in 3.0 s", "good"],
      ["bought $2.00 of PEPE in 4.0 s", "good"],
      ["MOON: its buy was refused: over momentum's $1.00 a trade", "bad"],
    ])
  })

  test("an act that goes wrong inside a line leaves it for one of its own", () => {
    const l = new TradeLog({ symbolOf: syms })
    for (const r of entry("conf", 1, MOON, 0)) l.add(r)
    l.add({ ...row("bot.entering", { agent: "momentum", name: "conf", signalId: 2, mint: BONK, usd: 2, botMode: "live", words: "buys $2.00 of BONK" }), ...at(10) })
    expect(shownOf(l).map((e) => e.firing?.said)).toEqual(["bought MOON · buying BONK"])
    l.add({ ...row("bot.waiting", { agent: "momentum", name: "conf", signalId: 2, mint: BONK, cardId: "w2", words: "its buy of $2.00 of BONK waits for you: the embedded wallet asks every time" }), ...at(11) })
    expect(shownOf(l).map((e) => [e.firing?.said, e.tone])).toEqual([
      ["bought $2.00 of MOON in 4.0 s", "good"],
      ["its buy of $2.00 of BONK waits for you: the embedded wallet asks every time", "warn"],
    ])
    // Nothing joins the line that stands alone.
    for (const r of entry("conf", 3, PEPE, 20)) l.add(r)
    expect(shownOf(l)).toHaveLength(3)
  })

  test("a buy whose card waited for you fills as a buy, never as the bot's exit", () => {
    const l = new TradeLog({ symbolOf: syms })
    const origin = { bot: "conf", botAct: "entry", botSignal: 7 }
    l.add({ ...row("bot.entering", { agent: "momentum", name: "conf", signalId: 7, mint: MOON, usd: 0.5, botMode: "live", words: "buys $0.50 of MOON" }), ...at(0) })
    l.add({ ...created("w7", "momentum", { role: "core", clientId: "core:bot:conf", ...origin, params: { mint: MOON, side: "buy" }, title: "BUY $0.50 of MOON" }), ...at(0) })
    l.add({ ...row("bot.waiting", { agent: "momentum", name: "conf", signalId: 7, mint: MOON, cardId: "w7", words: "its buy of $0.50 of MOON waits for you: the embedded wallet asks every time" }), ...at(1) })
    l.add({ ...row("card.approved", { agent: "momentum", cardId: "w7", opId: "op-w7", how: "enter", ...origin }), ...at(30) })
    l.add({ ...row("operation.submitting", { agent: "momentum", cardId: "w7", opId: "op-w7" }), ...at(30) })
    l.add({ ...row("operation.succeeded", { agent: "momentum", opId: "op-w7" }), ...at(34) })
    expect(shownOf(l).map((e) => [e.firing?.said, e.tone])).toEqual([["bought $0.50 of MOON in 4.0 s", "good"]])
  })

  test("an exit that reverted keeps its own line when the bot sells again", () => {
    const l = new TradeLog({ symbolOf: syms })
    const origin = { bot: "conf", botAct: "exit", botPosition: "op-e1", botReason: "take_profit" }
    l.add({ ...row("bot.exiting", { agent: "momentum", name: "conf", position: "op-e1", mint: MOON, reason: "take_profit", botMode: "live", words: "sells 100 MOON: a take profit" }), ...at(0) })
    l.add({ ...created("xa", "momentum", { role: "core", ...origin, params: { mint: MOON, side: "sell" }, title: "SELL 100 MOON" }), ...at(0) })
    l.add({ ...row("card.approved", { agent: "momentum", cardId: "xa", opId: "op-xa", how: "bot-exit", ...origin }), ...at(0) })
    l.add({ ...row("operation.submitting", { agent: "momentum", cardId: "xa", opId: "op-xa" }), ...at(0) })
    l.add({ ...row("operation.failed", { agent: "momentum", opId: "op-xa", cardId: "xa", result: { api: { success: false, error: { code: "TRADE_REVERTED", message: "The trade transaction landed and reverted on chain. The network fee was spent; nothing else moved." } } } }), ...at(3) })
    l.add({ ...row("bot.exit_ended", { agent: "momentum", name: "conf", position: "op-e1", mint: MOON, botMode: "live", outcome: "failed", words: "MOON: its sell didn't go through: The trade transaction landed and reverted on chain. The network fee was spent; nothing else moved; it's tried again" }), ...at(3) })
    for (const r of exit("conf", "op-e1", MOON, "take_profit", 8)) l.add(r)
    const shown = shownOf(l).map((e) => [e.firing?.said, e.tone])
    expect(shown).toHaveLength(2)
    expect(shown[0]![0]).toContain("The network fee was spent")
    expect(shown[0]![0]).toContain("it's tried again")
    expect(shown[0]![1]).toBe("bad")
    expect(shown[1]).toEqual(["sold MOON at its take profit in 3.0 s", "good"])
  })

  test("a paper bot's fills say paper, so the agent pane shows them; the agent's record says which bot", () => {
    const l = new TradeLog({ symbolOf: syms })
    l.add({ ...row("bot.entering", { agent: "momentum", name: "conf", signalId: 1, mint: MOON, usd: 2, botMode: "paper", words: "buys $2.00 of MOON on a confluence signal at 09:00, on paper" }), ...at(0) })
    l.add({ ...row("paper.call", { mode: "paper", agent: "momentum", role: "core", bot: "conf", botAct: "entry", botSignal: 1, tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: 2 }, isError: false, answer: JSON.stringify({ api: { paper: true, side: "buy", mint: MOON, quoteAsset: "sol", amountRaw: "10000000", tokenAmount: 5 } }) }), ...at(1) })
    const shown = shownOf(l)
    expect(shown.map((e) => [e.agent, e.firing])).toEqual([["momentum", { name: "conf", said: "bought $2.00 of MOON on paper", bot: true, paper: true }]])
    const note = sessionNote(l.sessionTrades(), {})!
    expect(note).toContain('traded by the bot "conf", as momentum · paper buy MOON by the bot "conf" (as momentum)')
  })
})

describe("a code bot in Activity", () => {
  const BONK = "BonkFake11111111111111111111111111111111111"
  const syms = (mint: string) => ({ [MOON]: "MOON", [PEPE]: "PEPE", [BONK]: "BONK" })[mint]
  const at = (s: number) => ({ at: new Date(Date.UTC(2026, 10, 8, 9, 0, s)).toISOString() })
  const shownOf = (l: TradeLog) => l.activity().filter((e) => !e.hidden)
  /** A request by its own id: recorded, its card run without one, its fill. */
  const buy = (bot: string, request: string, mint: string, t: number) => {
    const id = `b${request}`
    const origin = { bot, botAct: "entry", botKind: "code", botRequest: request }
    return [
      { ...row("bot.request", { kind: "code", agent: "momentum", name: bot, request, side: "buy", mint, usd: 1, botMode: "live", wallet: "embedded", words: `buys $1.00 of ${syms(mint)}` }), ...at(t) },
      { ...created(id, "momentum", { role: "core", clientId: `core:bot:${bot}`, ...origin, params: { mint, side: "buy" }, title: `BUY $1.00 of ${syms(mint)}` }), ...at(t) },
      { ...row("card.approved", { agent: "momentum", cardId: id, opId: `op-${id}`, how: "inside-limits", ...origin }), ...at(t) },
      { ...row("operation.submitting", { agent: "momentum", cardId: id, opId: `op-${id}` }), ...at(t) },
      { ...row("operation.succeeded", { agent: "momentum", opId: `op-${id}` }), ...at(t + 2) },
    ]
  }
  const sell = (bot: string, request: string, position: string, mint: string, t: number) => {
    const id = `s${request}`
    const origin = { bot, botAct: "exit", botKind: "code", botRequest: request, botPosition: position, botReason: "bot" }
    return [
      { ...row("bot.request", { kind: "code", agent: "momentum", name: bot, request, side: "sell", mint, position, botMode: "live", wallet: "embedded", words: `sells its ${syms(mint)}` }), ...at(t) },
      { ...created(id, "momentum", { role: "core", ...origin, params: { mint, side: "sell" }, title: `SELL 100% of ${syms(mint)}` }), ...at(t) },
      { ...row("card.approved", { agent: "momentum", cardId: id, opId: `op-${id}`, how: "bot-exit", ...origin }), ...at(t) },
      { ...row("operation.submitting", { agent: "momentum", cardId: id, opId: `op-${id}` }), ...at(t) },
      { ...row("operation.succeeded", { agent: "momentum", opId: `op-${id}` }), ...at(t + 3) },
    ]
  }

  test("its requests fold into one line by their ids, as a rules bot's entries and exits do", () => {
    const l = new TradeLog({ symbolOf: syms })
    for (const r of [...buy("grid", "r1", MOON, 0), ...buy("grid", "r2", BONK, 10), ...sell("grid", "r3", "op-br1", MOON, 20)]) l.add(r)
    const shown = shownOf(l)
    expect(shown).toHaveLength(1)
    expect(shown[0]!.firing).toEqual({ name: "grid", said: "bought MOON, BONK · sold MOON", bot: true })
    // One request alone reads as itself.
    const one = new TradeLog({ symbolOf: syms })
    for (const r of buy("grid", "r9", PEPE, 0)) one.add(r)
    expect(shownOf(one).map((e) => e.firing?.said)).toEqual(["bought $1.00 of PEPE in 2.0 s"])
    const sold = new TradeLog({ symbolOf: syms })
    for (const r of sell("grid", "r8", "op-x", PEPE, 0)) sold.add(r)
    expect(shownOf(sold).map((e) => e.firing?.said)).toEqual(["sold PEPE in 3.0 s"])
  })

  test("a request that waits for you or ends with nothing stands alone", () => {
    const l = new TradeLog({ symbolOf: syms })
    for (const r of buy("grid", "r1", MOON, 0)) l.add(r)
    l.add({ ...row("bot.request", { kind: "code", agent: "momentum", name: "grid", request: "r2", side: "buy", mint: BONK, usd: 1, botMode: "live", words: "buys $1.00 of BONK" }), ...at(10) })
    l.add({ ...row("bot.request_waiting", { kind: "code", agent: "momentum", name: "grid", request: "r2", cardId: "w2", because: "the embedded wallet asks every time", words: "its buy of $1.00 of BONK waits for you: the embedded wallet asks every time" }), ...at(11) })
    l.add({ ...row("bot.request", { kind: "code", agent: "momentum", name: "grid", request: "r3", side: "buy", mint: PEPE, usd: 1, botMode: "live", words: "buys $1.00 of PEPE" }), ...at(20) })
    l.add({ ...row("bot.request_ended", { kind: "code", agent: "momentum", name: "grid", request: "r3", side: "buy", mint: PEPE, outcome: "refused", words: "PEPE: its buy was refused: over momentum's $1.00 a trade" }), ...at(21) })
    expect(shownOf(l).map((e) => [e.firing?.said, e.tone])).toEqual([
      ["bought $1.00 of MOON in 2.0 s", "good"],
      ["its buy of $1.00 of BONK waits for you: the embedded wallet asks every time", "warn"],
      ["PEPE: its buy was refused: over momentum's $1.00 a trade", "bad"],
    ])
  })

  test("a request the core refused before Candle traded it is said once, by its end: not again as the tool's refusal", () => {
    const l = new TradeLog({ symbolOf: syms })
    const origin = { bot: "grid", botAct: "entry", botKind: "code", botRequest: "r5" }
    l.add({ ...row("bot.request", { kind: "code", agent: "momentum", name: "grid", request: "r5", side: "buy", mint: PEPE, usd: 1, botMode: "paper", words: "buys $1.00 of PEPE, on paper" }), ...at(0) })
    l.add({ ...row("tool.refused", { agent: "momentum", clientId: "core:bot:grid", role: "core", tool: "candle_trade", code: "TOKEN_UNKNOWN", message: "Candle doesn't know this token.", ...origin }), ...at(0) })
    l.add({ ...row("bot.request_ended", { kind: "code", agent: "momentum", name: "grid", request: "r5", side: "buy", mint: PEPE, outcome: "refused", code: "TOKEN_UNKNOWN", words: "PEPE: its buy was refused: Candle doesn't know this token" }), ...at(0) })
    expect(shownOf(l).map((e) => [e.firing?.said ?? e.text, e.tone])).toEqual([["on paper · PEPE: its buy was refused: Candle doesn't know this token", "bad"]])
  })

  test("a buy that waited for your card says it filled once you approved it, on its own line", () => {
    const l = new TradeLog({ symbolOf: syms })
    const origin = { bot: "grid", botAct: "entry", botKind: "code", botRequest: "r4" }
    l.add({ ...row("bot.request", { kind: "code", agent: "momentum", name: "grid", request: "r4", side: "buy", mint: BONK, usd: 1, botMode: "live", words: "buys $1.00 of BONK" }), ...at(0) })
    l.add({ ...created("w4", "momentum", { role: "core", clientId: "core:bot:grid", ...origin, params: { mint: BONK, side: "buy" }, title: "BUY $1.00 of BONK" }), ...at(0) })
    l.add({ ...row("bot.request_waiting", { kind: "code", agent: "momentum", name: "grid", request: "r4", cardId: "w4", because: "the embedded wallet asks every time", words: "its buy of $1.00 of BONK waits for you: the embedded wallet asks every time" }), ...at(1) })
    l.add({ ...row("card.approved", { agent: "momentum", cardId: "w4", opId: "op-w4", how: "enter", ...origin }), ...at(20) })
    l.add({ ...row("operation.submitting", { agent: "momentum", cardId: "w4", opId: "op-w4" }), ...at(20) })
    l.add({ ...row("operation.succeeded", { agent: "momentum", opId: "op-w4" }), ...at(24) })
    expect(shownOf(l).map((e) => [e.firing?.said, e.tone])).toEqual([["bought $1.00 of BONK in 4.0 s", "good"]])
  })

  test("the person's own pause, resume and stop each have a line, as the agent's pause does", () => {
    const l = new TradeLog({ symbolOf: syms })
    l.add({ ...row("bot.paused", { kind: "code", agent: "momentum", name: "grid", by: "view-1", how: "view" }), ...at(0) })
    l.add({ ...row("bot.resumed", { kind: "code", agent: "momentum", name: "grid", by: "view-1", how: "view" }), ...at(60) })
    l.add({ ...row("bot.stopped", { kind: "code", agent: "momentum", name: "grid", by: "view-1", how: "view" }), ...at(120) })
    const said = shownOf(l).map((e) => e.text)
    expect(said).toHaveLength(3)
    expect(said[0]).toContain("you paused")
    expect(said[0]).toContain("its buys are refused, its sells still run")
    expect(said[1]).toContain("back on, as it was approved")
    expect(said[2]).toContain("you stopped")
  })

  test("a swap says what it swapped", () => {
    const l = new TradeLog({ symbolOf: syms })
    const origin = { bot: "grid", botAct: "entry", botKind: "code", botRequest: "w1" }
    l.add({ ...row("bot.request", { kind: "code", agent: "momentum", name: "grid", request: "w1", side: "swap", from: "SOL", to: "USDC", amount: "0.1", botMode: "live", words: "swaps 0.1 SOL to USDC" }), ...at(0) })
    l.add({ ...created("sw", "momentum", { role: "core", kind: "swap", ...origin, params: { from: "SOL", to: "USDC" }, title: "SWAP 0.1 SOL → USDC" }), ...at(0) })
    l.add({ ...row("card.approved", { agent: "momentum", cardId: "sw", opId: "op-sw", how: "inside-limits", ...origin }), ...at(0) })
    l.add({ ...row("operation.submitting", { agent: "momentum", cardId: "sw", opId: "op-sw" }), ...at(0) })
    l.add({ ...row("operation.succeeded", { agent: "momentum", opId: "op-sw" }), ...at(2) })
    expect(shownOf(l).map((e) => e.firing?.said)).toEqual(["swapped 0.1 SOL to USDC in 2.0 s"])
    // Its notice says the swap, not a buy of no token.
    expect(l.originOfOp("op-sw")?.bot).toEqual({ name: "grid", act: "swap", token: "0.1 SOL to USDC" })
  })

  test("its process: a crash and giving up stand alone, a start is the Journal's", () => {
    const l = new TradeLog({ symbolOf: syms })
    l.add({ ...row("bot.process", { kind: "code", agent: "momentum", name: "grid", what: "started", pid: 41 }), ...at(0) })
    l.add({ ...row("bot.process", { kind: "code", agent: "momentum", name: "grid", what: "crashed", crashes: 1, words: "crashed (exit 1) at 09:00; it starts again in 2 s" }), ...at(1) })
    l.add({ ...row("bot.process", { kind: "code", agent: "momentum", name: "grid", what: "gave_up", crashes: 5, words: "crashed (exit 1) at 09:05: 5 crashes in 10 min, so it isn't started again until you start it" }), ...at(2) })
    l.add({ ...row("bot.process", { kind: "code", agent: "momentum", name: "grid", what: "stopped", why: "core", words: "the core stopped" }), ...at(3) })
    expect(shownOf(l).map((e) => [e.text, e.tone])).toEqual([
      ['the code bot "grid" crashed (exit 1) at 09:00; it starts again in 2 s', "warn"],
      ['the code bot "grid" crashed (exit 1) at 09:05: 5 crashes in 10 min, so it isn\'t started again until you start it', "bad"],
    ])
  })

  test("what it says with bot.event is a line of its own, in its words", () => {
    const l = new TradeLog({ symbolOf: syms })
    l.add({ ...row("bot.event", { kind: "code", agent: "momentum", name: "grid", word: "needs-a-look", text: "spread above 8%" }), ...at(0) })
    expect(shownOf(l).map((e) => [e.text, e.tone])).toEqual([['the code bot "grid" says "needs-a-look": spread above 8%', "info"]])
  })
})
