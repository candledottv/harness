import { expect, test } from "bun:test"
import { CandleScrubber, leftovers, scrubRecording } from "./scrub-candle-rest"

const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const mint = "MadeUpMint111111111111111111111111111111pump"
const SOL = "So11111111111111111111111111111111111111112"

test("an account read: prefixes, wallets, mints and ids become fakes; amounts scale together, clocks move, prices stay", () => {
  const s = new CandleScrubber(["AbCdEfGh", "IjKlMnOp"])
  const out = scrubRecording(s, "pnl-agent-b.json", {
    route: "/api/v1/agent/keys/IjKlMnOp/pnl",
    args: { keyPrefix: "IjKlMnOp" },
    answer: {
      keyPrefix: "IjKlMnOp",
      pnl: {
        closedPositions: [{ agent: "IjKlMnOp", openedBy: "AbCdEfGh", mint, wallet, quantity: 2, costBasisUsd: 10, avgEntryUsd: 5, closedTs: 1_793_000_000_000 }],
        byWallet: [{ wallet, label: "my-tee", payerType: "linked", counted: 4 }],
      },
      board: { profileId: "prof_0123456789abcdef" },
    },
  }) as { route: string; answer: { keyPrefix: string; pnl: { closedPositions: Record<string, unknown>[]; byWallet: Record<string, unknown>[] }; board: Record<string, unknown> } }
  expect(out.route).toBe("/api/v1/agent/keys/FakeKey2/pnl")
  const [p] = out.answer.pnl.closedPositions
  expect(p).toMatchObject({ agent: "FakeKey2", openedBy: "FakeKey1" })
  expect(p!.wallet).toBe(out.answer.pnl.byWallet[0]!.wallet)
  expect(String(p!.wallet).startsWith("WalletFake")).toBe(true)
  expect(String(p!.mint).startsWith("TokenFake")).toBe(true)
  // Quantity and cost scale by one factor, so the price per token is unchanged, and stays as recorded.
  expect(Number(p!.costBasisUsd) / Number(p!.quantity)).toBeCloseTo(5, 9)
  expect(p!.avgEntryUsd).toBe(5)
  expect(p!.quantity).not.toBe(2)
  expect(p!.closedTs).not.toBe(1_793_000_000_000)
  expect(out.answer.pnl.byWallet[0]).toMatchObject({ payerType: "linked", counted: 4 })
  expect(out.answer.pnl.byWallet[0]!.label).not.toBe("my-tee")
  expect(out.answer.board.profileId).not.toBe("prof_0123456789abcdef")
  expect(leftovers(out)).toEqual([])
})

test("a market read keeps its figures and times, Candle's words and the fields asked; tokens, names and links become fakes", () => {
  const s = new CandleScrubber()
  const rows = Array.from({ length: 8 }, (_, i) => ({ chain: "solana", address: i === 0 ? mint : SOL, symbol: "REAL", name: "Real Coin", priceUsd: 0.5, createdAt: 1_793_000_000_000, sourceUrl: `https://birdeye.so/token/${mint}` }))
  const out = scrubRecording(s, "feed-new-fields.json", {
    query: { bucket: "new", fields: "name,priceUsd", since_seq: "rzhx5okw:26516" },
    answer: { success: true, bucket: "new", cursor: "rzhx5okw:26516", tokens: rows, removed: [`solana:${mint}`] },
  }) as { query: Record<string, string>; answer: { cursor: string; tokens: Record<string, unknown>[]; removed: string[] }; truncated: Record<string, number> }
  expect(out.query).toEqual({ bucket: "new", fields: "name,priceUsd", since_seq: "fake:26516" })
  expect(out.answer.cursor).toBe("fake:26516")
  expect(out.answer.tokens).toHaveLength(5)
  expect(out.truncated).toEqual({ "$.tokens": 8 })
  const [first, second] = out.answer.tokens
  expect(first).toMatchObject({ priceUsd: 0.5, createdAt: 1_793_000_000_000, chain: "solana" })
  expect(first!.symbol).not.toBe("REAL")
  expect(second!.address).toBe(SOL)
  expect(out.answer.removed[0]).toBe(`solana:${first!.address}`)
  expect(leftovers(out)).toEqual([])
})

test("anything left that looks like an address or a link is found", () => {
  expect(leftovers({ note: `sent from ${wallet}`, link: "https://example.com/x" })).toHaveLength(2)
})
