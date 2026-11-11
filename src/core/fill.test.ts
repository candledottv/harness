// A fill read from each shape Candle answers a trade in: the embedded wallet's `api.amounts`, a TEE wallet's
// `amounts` at the top, a paper trade's quote, and a read-back that says only what was sent. The shapes are the
// recorded passes', with their ids made up.
import { describe, expect, test } from "bun:test"
import { enableTestChain, TEST_CHAIN } from "../shared/chains"
import { fillOfRow, netAssetRaw, ownHeldFloor, readFill, receivedOf, swapReceived } from "./fill"

const MINT = "MoonFake11111111111111111111111111111111111"
const TEE = "TeeWa11etFake1111111111111111111111111111111"

const embedded = (amounts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  clientTradeId: "op-1",
  resolved: { amountRaw: amounts.amountRaw },
  api: { success: true, status: "executed", chain: "solana", signature: "sig", fee: { bps: 25, feeRaw: "24930" }, amounts: { quoteAsset: "sol", ...amounts }, ...extra },
})

describe("readFill", () => {
  test("an embedded buy: the tokens are what the chain says it received, the spend and the fee in SOL", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "9971953", expectedOutRaw: "554327460", minOutRaw: "548784186", actualOutRaw: "554300000", slippageBps: 0 }) })
    expect(fill).toEqual({ side: "buy", mint: MINT, chain: "solana", wallet: "embedded", asset: "SOL", tokensRaw: "554300000", assetRaw: "9971953", feeRaw: "24930", measured: "chain" })
    // A buy's outflow is the spend plus the fee, on top.
    expect(netAssetRaw(fill!)).toBe(9971953n + 24930n)
  })

  test("an embedded sell: the tokens are what it sold; the proceeds are the swap's, less the fee withheld", () => {
    const fill = readFill({ side: "sell", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "560726141", expectedOutRaw: "9413308", actualOutRaw: "7948460", slippageBps: 1556 }, { fee: { bps: 25, feeRaw: "23592" } }) })
    expect(fill).toMatchObject({ side: "sell", tokensRaw: "560726141", assetRaw: "7948460", feeRaw: "23592", measured: "chain" })
    expect(netAssetRaw(fill!)).toBe(7948460n - 23592n)
  })

  test("a fill Candle couldn't read off the chain stands on the quote, and says so", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1000", expectedOutRaw: "5000" }) })
    expect(fill).toMatchObject({ tokensRaw: "5000", measured: "quote" })
  })

  test("a TEE wallet's answer has its amounts at the top, and the card gives the side and the mint", () => {
    const result = { success: true, status: "executed", chain: "solana", signature: "sig", fee: { bps: 25, feeRaw: "24818" }, amounts: { amountRaw: "9927091", expectedOutRaw: "597746265", actualOutRaw: "597746265", quoteAsset: "sol" }, kind: "trade", wallet: TEE }
    expect(readFill({ side: "buy", mint: MINT, wallet: TEE, result })).toMatchObject({ wallet: TEE, tokensRaw: "597746265", assetRaw: "9927091", feeRaw: "24818", measured: "chain" })
  })

  test("a paper buy and sell are Candle's quote, with the token's decimals", () => {
    const buy = { clientTradeId: "p1", api: { success: true, paper: true, side: "buy", mint: MINT, quoteAsset: "sol", amountRaw: "9992840", expectedOutRaw: "557678983", feeRaw: "24983", tokenDecimals: 11, tokenAmount: 0.00557678983 } }
    expect(readFill({ wallet: "embedded", result: buy, paper: true })).toEqual({
      side: "buy",
      mint: MINT,
      chain: "solana",
      wallet: "paper",
      asset: "SOL",
      tokensRaw: "557678983",
      assetRaw: "9992840",
      feeRaw: "24983",
      measured: "quote",
      tokenDecimals: 11,
      paper: true,
    })
    const sell = { api: { success: true, paper: true, side: "sell", mint: MINT, quoteAsset: "sol", amountRaw: "557678983", expectedOutRaw: "9658687", feeRaw: "24207", tokenDecimals: 11 } }
    expect(readFill({ wallet: "paper", result: sell })).toMatchObject({ side: "sell", tokensRaw: "557678983", assetRaw: "9658687", paper: true })
  })

  test("a buy read back by its id says what was sent, not what it received", () => {
    const job = { clientTradeId: "op-1", chain: "solana", side: "buy", mint: MINT, quoteAsset: "sol", amountRaw: "9961543", status: "confirmed", signature: "sig" }
    const fill = readFill({ wallet: "embedded", result: job })
    expect(fill).toEqual({ side: "buy", mint: MINT, chain: "solana", wallet: "embedded", asset: "SOL", assetRaw: "9961543", measured: "none" })
    expect(readFill({ wallet: "embedded", result: { ...job, side: "sell" } })).toMatchObject({ side: "sell", tokensRaw: "9961543", measured: "none" })
  })

  test("an answer that names no pair asset is read in the card's own, or ETH for a 0x mint: never SOL for a Hood trade", () => {
    const HOOD = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
    const result = { api: { success: true, status: "executed", chain: "hood", fee: { feeRaw: "2500000000000" }, amounts: { amountRaw: "1000000000000000", actualOutRaw: "42000000" } } }
    expect(readFill({ side: "buy", mint: HOOD, wallet: "embedded", result })).toMatchObject({ asset: "ETH", assetRaw: "1000000000000000", tokensRaw: "42000000" })
    expect(readFill({ side: "buy", mint: HOOD, wallet: "embedded", result, fallbackAsset: "USDG" })).toMatchObject({ asset: "USDG" })
    // A Solana trade that settles in USDC, with the asset left off the answer: the card's, not SOL.
    const sol = { api: { success: true, amounts: { amountRaw: "5000000", actualOutRaw: "1" } } }
    expect(readFill({ side: "buy", mint: MINT, wallet: "embedded", result: sol, fallbackAsset: "USDC" })).toMatchObject({ asset: "USDC" })
    expect(readFill({ side: "buy", mint: MINT, wallet: "embedded", result: sol })).toMatchObject({ asset: "SOL" })
  })

  test("not a trade's answer, or no side or mint anywhere: no fill", () => {
    expect(readFill({ wallet: "embedded", result: { success: true, imageUrl: "https://example.com/a.png" } })).toBeUndefined()
    expect(readFill({ wallet: "embedded", result: "text" })).toBeUndefined()
    expect(readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1", quoteAsset: "doge" }) })).toBeUndefined()
  })

  test("a fill on a row reads back only when it has its shape", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1", actualOutRaw: "2" }) })!
    expect(fillOfRow({ fill })).toEqual(fill)
    expect(fillOfRow({ fill: { side: "buy" } })).toBeUndefined()
    expect(fillOfRow({})).toBeUndefined()
  })
})

describe("a fill's chain", () => {
  const HOOD_TOKEN = `0x${"ab".repeat(20)}`
  const answer = { api: { success: true, side: "buy", amounts: { amountRaw: "1000", actualOutRaw: "5" } } }

  test("it's the operation's: a Hood buy that names no pair asset is read in ETH, never SOL", () => {
    expect(readFill({ side: "buy", mint: HOOD_TOKEN, chain: "hood", wallet: "embedded", result: answer })).toMatchObject({ chain: "hood", asset: "ETH" })
  })

  test("with no operation's chain, Candle's answer's wins over the mint's shape", () => {
    expect(readFill({ side: "buy", mint: HOOD_TOKEN, wallet: "embedded", result: { ...answer.api, chain: "hood" } })).toMatchObject({ chain: "hood", asset: "ETH" })
  })

  test("on a chain whose native asset isn't a base asset, an answer naming no pair asset isn't read at all", () => {
    const off = enableTestChain()
    try {
      expect(readFill({ side: "buy", mint: HOOD_TOKEN, chain: TEST_CHAIN, wallet: "embedded", result: answer })).toBeUndefined()
    } finally {
      off()
    }
  })

  test("a row written before fills carried a chain gets its mint's family's as it's read", () => {
    const old = { side: "buy", mint: HOOD_TOKEN, wallet: "embedded", asset: "ETH", measured: "chain" }
    expect(fillOfRow({ fill: old })?.chain).toBe("hood")
    expect(fillOfRow({ fill: { ...old, mint: MINT, asset: "SOL" } })?.chain).toBe("solana")
    expect(fillOfRow({ fill: { ...old, chain: "solana" } })?.chain).toBe("solana")
  })
})

describe("what a fill brought in, for its card's done line", () => {
  const ZOLVA = "0x8e04549484d0612be8373a0263b11928a5f7681f"
  test("a Hood TEE sell's proceeds from Candle's answer (the quote, so ≈), less its fee: never the card's estimate", () => {
    // A live sell's answer from the TEE route: no actualOutRaw, the quote's expected out in wei.
    const fill = readFill({ side: "sell", mint: ZOLVA, chain: "hood", wallet: "0x0c970b643b1493893234Ed59C78502c87A93Ca0F", result: { amounts: { amountRaw: "4525959724091471254011", expectedOutRaw: "164662734570320", minOutRaw: "163839420897468", quoteAsset: "eth" } } })!
    expect(receivedOf(fill)).toBe("≈0.000164663 ETH")
    // Read off the chain, it's exact; Candle's fee comes off what it brought in.
    const measured = readFill({ side: "sell", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "1000000", expectedOutRaw: "2000000000", actualOutRaw: "1990000000", quoteAsset: "sol" }, { fee: { feeRaw: "9950000" } }) })!
    expect(receivedOf(measured)).toBe("1.98005 SOL")
  })

  test("a buy has none: its card names the tokens", () => {
    const fill = readFill({ side: "buy", mint: MINT, wallet: "embedded", result: embedded({ amountRaw: "10000000", expectedOutRaw: "123456789", actualOutRaw: "123456789", quoteAsset: "sol" }) })!
    expect(receivedOf(fill)).toBeUndefined()
  })

  test("a swap's amount measured off the transaction, else its quote's", () => {
    // The live CNDL → SOL swap's answer.
    const settled = { clientSwapId: "op-2", success: true, payload: { hashes: ["h"], expectedOutRaw: "4172528", outDecimals: 9, settlement: { state: "settled", settledOutRaw: "4172528", settledOutSource: "tx_balance_delta" }, receiptStored: true } }
    expect(swapReceived(settled, "SOL")).toBe("0.00417253 SOL")
    expect(swapReceived({ payload: { expectedOutRaw: "126000000000000", outDecimals: 18 } }, "ETH")).toBe("≈0.000126 ETH")
    expect(swapReceived({ payload: {} }, "ETH")).toBeUndefined()
    expect(swapReceived(settled, "MOON")).toBeUndefined()
  })
})

describe("the least a wallet holds by its own fills", () => {
  const W = "0x0c970b643b1493893234Ed59C78502c87A93Ca0F"
  const T = "0x8e04549484d0612be8373a0263b11928a5f7681f"
  const now = Date.parse("2026-11-11T02:48:30.000Z")
  const row = (at: string, side: "buy" | "sell", tokensRaw: string, extra: Record<string, unknown> = {}) => ({ type: "operation.succeeded", at, fill: { side, mint: T, chain: "hood", wallet: W, asset: "ETH", tokensRaw, measured: "quote", ...extra } })

  test("two buys a moment ago add up, whatever the address's letter case; a sell starts it again", () => {
    const rows = [row("2026-11-11T02:48:15.000Z", "buy", "2586"), row("2026-11-11T02:48:21.000Z", "buy", "6465")]
    expect(ownHeldFloor(rows, { wallet: W.toLowerCase(), mint: T.toUpperCase().replace("0X", "0x"), now })).toBe(9051n)
    expect(ownHeldFloor([...rows, row("2026-11-11T02:48:25.000Z", "sell", "4525")], { wallet: W, mint: T, now })).toBeUndefined()
  })

  test("fills older than two minutes, on paper, another wallet's or another token's don't count", () => {
    expect(ownHeldFloor([row("2026-11-11T02:46:00.000Z", "buy", "100")], { wallet: W, mint: T, now })).toBeUndefined()
    expect(ownHeldFloor([row("2026-11-11T02:48:15.000Z", "buy", "100", { paper: true })], { wallet: W, mint: T, now })).toBeUndefined()
    expect(ownHeldFloor([row("2026-11-11T02:48:15.000Z", "buy", "100")], { wallet: "embedded", mint: T, now })).toBeUndefined()
    expect(ownHeldFloor([row("2026-11-11T02:48:15.000Z", "buy", "100")], { wallet: W, mint: MINT, now })).toBeUndefined()
  })
})
