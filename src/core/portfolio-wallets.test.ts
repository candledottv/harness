import { afterEach, describe, expect, test } from "bun:test"
import { enableTestChain, TEST_CHAIN } from "../shared/chains"
import { chainInUse, chainsInUse, chainUse, decimalsIn, heldMints, holdingFrom, portfolioWallets, shownWallets } from "./portfolio-wallets"

// Shaped as Candle's candle_get_portfolio answers: Solana's wallets at the top, Hood's under `hood`, each EVM
// token's mint in its checksum case (routes/agent.ts, services/hood-portfolio.ts).
const SOL_EMBEDDED = "SolEmbed11111111111111111111111111111111111"
const SOL_TEE = "SolTee1111111111111111111111111111111111111"
const EVM_EMBEDDED = "0xAbCdEf0000000000000000000000000000000001"
const HOOD_TEE = "0xAbCdEf0000000000000000000000000000000002"
const MOON = "MoonFake11111111111111111111111111111111111"
const KITE = "0x1F8e3bD8000000000000000000000000000000Aa"

function portfolio(hood: Record<string, unknown> | null = {}) {
  return {
    success: true,
    embedded: [{ address: SOL_EMBEDDED, lamports: "2000000000", tokens: [{ mint: MOON, amountRaw: "5000", decimals: 6 }] }],
    tee: [{ id: "t1", address: SOL_TEE, chain: "solana", active: true, lamports: "0", tokens: [] }],
    ...(hood === null
      ? {}
      : {
          hood: {
            embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "50000000000000000", tokens: [{ chain: "hood", mint: KITE, amountRaw: "2150000000000000000000", decimals: 18, symbol: "KITE" }] }],
            tee: [{ id: "h1", address: HOOD_TEE, chain: "hood", active: true, wei: "0", tokens: [{ chain: "hood", mint: KITE, amountRaw: "7", decimals: 18 }] }],
            unavailable: [],
            unpriced: 0,
            unpricedByReason: {},
            ...hood,
          },
        }),
    walletsComplete: true,
  }
}

let off: (() => void) | undefined
afterEach(() => {
  off?.()
  off = undefined
})

describe("every chain's wallets, read in one place", () => {
  test("Solana's at the top and Hood's under its slug, each with its chain, kind and native balance", () => {
    const ws = portfolioWallets(portfolio())
    expect(ws.map((w) => [w.chain, w.kind, w.address, w.nativeRaw])).toEqual([
      ["solana", "embedded", SOL_EMBEDDED, 2_000_000_000n],
      ["solana", "tee", SOL_TEE, 0n],
      ["hood", "embedded", EVM_EMBEDDED, 50_000_000_000_000_000n],
      ["hood", "tee", HOOD_TEE, 0n],
    ])
  })

  test("a native balance Candle couldn't read is null, never zero; a failed token read is null too", () => {
    const ws = portfolioWallets(portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: null, tokens: null }] }))
    const evm = ws.find((w) => w.address === EVM_EMBEDDED)!
    expect(evm.nativeRaw).toBeNull()
    expect(evm.tokens).toBeNull()
  })

  test("a second EVM chain's wallets are read under its own slug, and never taken for Hood's", () => {
    off = enableTestChain()
    const body = { ...portfolio(), testevm: { embedded: [{ address: "0x00000000000000000000000000000000000000e1", chain: "testevm", wei: "1", tokens: [] }], tee: [] } }
    const ws = portfolioWallets(body)
    expect(ws.find((w) => w.address === "0x00000000000000000000000000000000000000e1")?.chain).toBe(TEST_CHAIN)
    expect(ws.filter((w) => w.chain === "hood").map((w) => w.address)).toEqual([EVM_EMBEDDED, HOOD_TEE])
  })
})

describe("what a wallet holds of a token (a percent sell, a bot's exit, a code bot's sell)", () => {
  test("a Hood token in the embedded EVM wallet and in a Hood TEE wallet", () => {
    expect(holdingFrom(portfolio(), EVM_EMBEDDED, KITE)).toEqual({ amountRaw: 2_150_000_000_000_000_000_000n, decimals: 18 })
    expect(holdingFrom(portfolio(), HOOD_TEE, KITE)).toEqual({ amountRaw: 7n, decimals: 18 })
  })

  test("the mint and the wallet in another case are the same ones: an EVM address's case is only its checksum", () => {
    expect(holdingFrom(portfolio(), EVM_EMBEDDED.toLowerCase(), KITE.toLowerCase())).toEqual({ amountRaw: 2_150_000_000_000_000_000_000n, decimals: 18 })
    expect(holdingFrom(portfolio(), HOOD_TEE.toUpperCase().replace("0X", "0x"), KITE)).toEqual({ amountRaw: 7n, decimals: 18 })
    // A Solana address is case-sensitive: another case is another wallet.
    expect(holdingFrom(portfolio(), SOL_EMBEDDED.toLowerCase(), MOON)).toBe("none")
  })

  test("Solana's holdings read as before", () => {
    expect(holdingFrom(portfolio(), SOL_EMBEDDED, MOON)).toEqual({ amountRaw: 5000n, decimals: 6 })
    expect(holdingFrom(portfolio(), SOL_TEE, MOON)).toBe("none")
  })

  test('"holds none" only when the read says so whole', () => {
    // Read whole, and the token isn't there.
    expect(holdingFrom(portfolio(), HOOD_TEE, "0x0000000000000000000000000000000000000bad")).toBe("none")
    // A token list Candle cut short may hold it.
    expect(holdingFrom(portfolio({ tee: [{ id: "h1", address: HOOD_TEE, chain: "hood", wei: "0", tokens: [], truncated: true }] }), HOOD_TEE, KITE)).toBe("unreadable")
    // A failed token read.
    expect(holdingFrom(portfolio({ tee: [{ id: "h1", address: HOOD_TEE, chain: "hood", wei: null, tokens: null }] }), HOOD_TEE, KITE)).toBe("unreadable")
    // No Hood section at all: Hood's wallets weren't read, so nothing is known of them.
    expect(holdingFrom(portfolio(null), HOOD_TEE, KITE)).toBe("unreadable")
    // Hood read with failures: a wallet missing from it may be one that failed.
    expect(holdingFrom(portfolio({ tee: [], unavailable: [{ address: HOOD_TEE }] }), HOOD_TEE, KITE)).toBe("unreadable")
    // Hood read whole and the wallet isn't in it: it holds none.
    expect(holdingFrom(portfolio({ tee: [] }), HOOD_TEE, KITE)).toBe("none")
    // The whole read failed.
    expect(holdingFrom({}, HOOD_TEE, KITE)).toBe("unreadable")
  })

  test("a Solana token row without its decimals or amount is unreadable, never none", () => {
    const solana = (row: Record<string, unknown>) => ({ ...portfolio(), embedded: [{ address: SOL_EMBEDDED, lamports: "2000000000", tokens: [row] }] })
    for (const row of [{ mint: MOON, amountRaw: "5000", decimals: null }, { mint: MOON, amountRaw: null, decimals: 6 }, { mint: MOON, decimals: 6 }, { mint: MOON, amountRaw: "5000" }]) {
      expect(holdingFrom(solana(row), SOL_EMBEDDED, MOON)).toBe("unreadable")
    }
    // Another token's row being unreadable says nothing against this one's absence.
    expect(holdingFrom(solana({ mint: MOON, amountRaw: "5000", decimals: null }), SOL_EMBEDDED, "PepeFake11111111111111111111111111111111111")).toBe("none")
  })

  test("a Hood token row without its decimals or amount is unreadable, never none, in either case", () => {
    const hood = (row: Record<string, unknown>) => portfolio({ tee: [{ id: "h1", address: HOOD_TEE, chain: "hood", active: true, wei: "0", tokens: [row] }] })
    for (const row of [{ chain: "hood", mint: KITE, amountRaw: "7", decimals: null }, { chain: "hood", mint: KITE, amountRaw: null, decimals: 18 }]) {
      expect(holdingFrom(hood(row), HOOD_TEE, KITE)).toBe("unreadable")
      expect(holdingFrom(hood(row), HOOD_TEE, KITE.toLowerCase())).toBe("unreadable")
    }
  })

  test("a token's decimals and the held tokens come from every chain, each token once whatever its case", () => {
    expect(decimalsIn(portfolio(), KITE.toLowerCase())).toBe(18)
    expect(heldMints(portfolio())).toEqual([MOON, KITE])
  })
})

describe("which chains the screens show", () => {
  test("an account whose only Hood wallet is an empty embedded one shows Solana alone, as before", () => {
    const empty = portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "0", tokens: [] }], tee: [] })
    expect(chainInUse(portfolioWallets(empty), "hood")).toBe(false)
    expect(shownWallets(empty).map((w) => w.address)).toEqual([SOL_EMBEDDED, SOL_TEE])
  })

  test("Hood shows once it has a TEE wallet, a balance or a token", () => {
    const embedded = (w: Record<string, unknown>) => portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "0", tokens: [], ...w }], tee: [] })
    expect(chainInUse(portfolioWallets(embedded({ wei: "1" })), "hood")).toBe(true)
    expect(chainInUse(portfolioWallets(embedded({ tokens: [{ mint: KITE, amountRaw: "1", decimals: 18 }] })), "hood")).toBe(true)
    expect(chainInUse(portfolioWallets(portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "0", tokens: [] }] })), "hood")).toBe(true)
    // A TEE wallet there that couldn't be read is still a TEE wallet there.
    expect(chainInUse(portfolioWallets(portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: null, tokens: null }], tee: [{ id: "h1", address: HOOD_TEE, chain: "hood", wei: null, tokens: null }] })), "hood")).toBe(true)
  })

  test("a token Candle lists there without its amount or decimals is a token there: Hood is used, never read as empty", () => {
    const listed = portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "0", tokens: [{ mint: KITE, amountRaw: null, decimals: 18 }] }], tee: [] })
    expect(chainUse(portfolioWallets(listed), "hood")).toBe("used")
    expect(chainsInUse(listed, { was: ["solana", "hood"] })).toEqual(["solana", "hood"])
    expect(shownWallets(listed).map((w) => w.address)).toContain(EVM_EMBEDDED)
  })

  // Candle's answer when its Hood read fails: the embedded EVM wallet with nothing read, and its address under `unavailable`.
  const unread = () => portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: null, tokens: null }], tee: [], unavailable: [EVM_EMBEDDED] })

  test("an embedded Hood wallet Candle couldn't read isn't use: a Solana-only account stays as it was", () => {
    expect(chainInUse(portfolioWallets(unread()), "hood")).toBe(false)
    expect(chainUse(portfolioWallets(unread()), "hood")).toBe("unknown")
    expect(chainsInUse(unread())).toEqual(["solana"])
    expect(shownWallets(unread()).map((w) => w.address)).toEqual([SOL_EMBEDDED, SOL_TEE])
    // Half read is still unread, unless what was read says it holds something.
    const half = (w: Record<string, unknown>) => portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", ...w }], tee: [] })
    expect(chainsInUse(half({ wei: "0", tokens: null }))).toEqual(["solana"])
    expect(chainsInUse(half({ wei: null, tokens: [] }))).toEqual(["solana"])
    expect(chainsInUse(half({ wei: "5", tokens: null }))).toEqual(["solana", "hood"])
  })

  test("a chain the account is known to use stays in use while its read fails, saying its wallet couldn't be read; read whole and empty, it goes", () => {
    expect(chainsInUse(portfolio())).toEqual(["solana", "hood"])
    const known = chainsInUse(unread(), { was: ["solana", "hood"] })
    expect(known).toEqual(["solana", "hood"])
    const shown = shownWallets(unread(), known)
    expect(shown.map((w) => w.address)).toEqual([SOL_EMBEDDED, SOL_TEE, EVM_EMBEDDED])
    expect(shown[2]).toMatchObject({ nativeRaw: null, tokens: null })
    // No Hood section at all says nothing either way.
    expect(chainsInUse(portfolio(null), { was: ["solana", "hood"] })).toEqual(["solana", "hood"])
    expect(chainsInUse(portfolio(null))).toEqual(["solana"])
    // Read whole and empty: it's no longer used.
    expect(chainsInUse(portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "0", tokens: [] }], tee: [] }), { was: ["solana", "hood"] })).toEqual(["solana"])
  })

  test("a stopped TEE wallet keeps its chain in use, though Candle no longer lists it", () => {
    const empty = portfolio({ embedded: [{ address: EVM_EMBEDDED, chain: "hood", wei: "0", tokens: [] }], tee: [] })
    expect(chainsInUse(empty, { stopped: [{ address: HOOD_TEE }] })).toEqual(["solana", "hood"])
    expect(chainsInUse(empty, { stopped: [{ address: SOL_TEE }] })).toEqual(["solana"])
  })
})
