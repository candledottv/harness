// The core's token names: what its topics show, a name for several tokens kept apart, and a bound.
import { expect, test } from "bun:test"
import { TokenNames } from "./token-names"

const MOON = "MoonMint1111111111111111111111111111111111"
const MOON_COPY = "MoonCopy2222222222222222222222222222222222"
const ORE = "OreMint33333333333333333333333333333333333"
const JUP = "JupMint44444444444444444444444444444444444"
const NEW = "NewMint55555555555555555555555555555555555"

test("a card, the portfolio, the token pane and Candle's lists each name their tokens, as the view's store reads them", () => {
  const names = new TokenNames()
  names.learnFrom("cards", { cardId: "c1", display: { mintLabel: "MOON", mint: MOON } })
  names.learnFrom("portfolio", { wallets: [{ tokens: [{ symbol: "ore", mint: ORE }] }], paper: { "agent-a": [{ symbol: "JUP", mint: JUP }] } })
  names.learnFrom("market", { followed: { symbol: "$NEW", mint: NEW }, trending: { rows: [] }, pinned: [] })
  expect(names.known()).toEqual(new Map([["MOON", MOON], ["ORE", ORE], ["JUP", JUP], ["NEW", NEW]]))

  const lists = new TokenNames()
  lists.learnFrom("feeds", { new: { rows: [{ symbol: "NEW", mint: NEW }] }, onfire: { rows: [{ symbol: "JUP", mint: JUP }] } })
  lists.learnFrom("market", { trending: { rows: [{ symbol: "ORE", mint: ORE }] }, pinned: [{ symbol: "MOON", mint: MOON }] })
  expect([...lists.known().keys()].sort()).toEqual(["JUP", "MOON", "NEW", "ORE"])
})

test("other topics, and rows missing a symbol or a mint, name nothing", () => {
  const names = new TokenNames()
  names.learnFrom("signals", { rows: [{ asset_address: MOON }] })
  names.learnFrom("activity", { kind: "line", entry: { text: "MOON" } })
  names.learnFrom("portfolio", { wallets: [{ tokens: [{ symbol: "", mint: MOON }, { symbol: "ORE" }] }] })
  names.learnFrom("feeds", null)
  expect(names.known().size).toBe(0)
})

test("a name read for two tokens is several, newest first, and in neither map's one-mint list", () => {
  const names = new TokenNames()
  names.learn("MOON", MOON)
  names.learn("ORE", ORE)
  names.learn("moon", MOON_COPY)
  expect(names.known()).toEqual(new Map([["ORE", ORE]]))
  expect(names.several()).toEqual(new Map([["MOON", [MOON_COPY, MOON]]]))
  // Seen again, the first is the newest.
  names.learn("MOON", MOON)
  expect(names.several().get("MOON")).toEqual([MOON, MOON_COPY])
})

test("past the bound, the pair seen longest ago goes", () => {
  const names = new TokenNames(3)
  names.learn("A", "MintA")
  names.learn("B", "MintB")
  names.learn("C", "MintC")
  names.learn("A", "MintA")
  names.learn("D", "MintD")
  expect([...names.known().keys()].sort()).toEqual(["A", "C", "D"])
})

test("the base assets' names are reserved: SOL, USDC, ETH, USDG and CNDL are learned only for their real mints", () => {
  const names = new TokenNames()
  // Look-alikes calling themselves by a base asset's name, in any case or with a $.
  for (const symbol of ["USDC", "sol", "$ETH", "USDG", "Cndl"]) names.learnFrom("feeds", { new: { rows: [{ symbol, mint: MOON_COPY }] } })
  expect(names.known().size).toBe(0)
  expect(names.mintsOf("USDC")).toEqual([])
  // The real ones are.
  names.learn("USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  names.learn("CNDL", "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL")
  expect(names.known()).toEqual(new Map([["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], ["CNDL", "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"]]))
})

test("a Hood address in two cases is one token: never a second mint for its name, nor a look-alike of itself", () => {
  const names = new TokenNames()
  names.learn("ZOLVA", "0x8E04549484D0612Be8373A0263B11928a5f7681F")
  names.learn("ZOLVA", "0x8e04549484d0612be8373a0263b11928a5f7681f")
  expect(names.mintsOf("ZOLVA")).toEqual(["0x8E04549484D0612Be8373A0263B11928a5f7681F"])
  expect(names.known().get("ZOLVA")).toBe("0x8E04549484D0612Be8373A0263B11928a5f7681F")
  expect(names.several().has("ZOLVA")).toBe(false)
  // A Solana mint's case is its own: two spellings are two tokens.
  names.learn("MOON", "MoonFake11111111111111111111111111111111111")
  names.learn("MOON", "moonFake11111111111111111111111111111111111")
  expect(names.several().get("MOON")).toHaveLength(2)
})
