// The positions and wallets panes' data: the last portfolio read, by wallet, never by agent (several
// agents share the embedded wallet), with each holding's buyers and the agents that can only read.
import { expect, test } from "bun:test"
import { portfolioSymbol, portfolioView } from "./portfolio-view"
import { heldMints } from "./portfolio-wallets"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const SOL = "So11111111111111111111111111111111111111112"
const W = "WalletFake111111111111111111111111111111111"
const portfolio = {
  embedded: [
    {
      chain: "solana",
      address: W,
      lamports: "2000000000",
      tokens: [
        { mint: MOON, amountRaw: "12345678901", decimals: 6, symbol: "MOON" },
        { mint: PEPE, amountRaw: "5000000", decimals: 6, symbol: "PEPE" },
      ],
    },
  ],
  tee: [{ chain: "solana", address: "TeeWallet1111111111111111111111111111111111", label: "tee one", lamports: "0", tokens: null }],
}
const prices = { usd: (k: string | undefined) => ({ [SOL]: 150, [MOON]: 0.63 })[k ?? ""] }
const agents = [
  { name: "momentum", wallet: W, embeddedWallet: "allowed" as const, prefix: "ab12cd34" },
  { name: "swing", wallet: W, embeddedWallet: "allowed" as const, prefix: "ef56gh78" },
  { name: "watcher", wallet: W, embeddedWallet: "denied" as const, prefix: "ij90kl12" },
]

test("each wallet once, with the agents allowed on it, holdings valued where priced and never at zero otherwise", () => {
  const view = portfolioView({ portfolio, readAt: 1_000, prices, agents, buyers: (m) => (m === MOON ? ["swing", "momentum"] : []), paper: {} })
  expect(view.readAt).toBe(1_000)
  expect(view.wallets).toHaveLength(2)
  const embedded = view.wallets[0]!
  expect(embedded).toMatchObject({ address: W, kind: "embedded", chain: "solana", agents: ["momentum", "swing"], nativeSymbol: "SOL", native: { amount: 2, usd: 300 } })
  expect(embedded.tokens).toEqual([
    { mint: MOON, symbol: "MOON", amount: 12345.678901, usd: 12345.678901 * 0.63, buyers: ["swing", "momentum"] },
    { mint: PEPE, symbol: "PEPE", amount: 5, usd: null, buyers: [] },
  ])
  // A wallet whose token read failed says so: null, not an empty list.
  expect(view.wallets[1]).toMatchObject({ kind: "tee", label: "tee one", tokens: null, agents: [] })
})

test("an agent denied the embedded wallet is read only, with the owner's command", () => {
  const view = portfolioView({ portfolio, readAt: 1_000, prices, agents, buyers: () => [], paper: {} })
  expect(view.readOnly).toEqual([{ agent: "watcher", command: "candle keys update ij90kl12 --embedded-wallet allow" }])
})

test("before any read: no wallets, and the deposit address when an agent's status names one", () => {
  const view = portfolioView({ portfolio: undefined, readAt: null, prices, agents, buyers: () => [], paper: {} })
  expect(view).toMatchObject({ readAt: null, wallets: [], deposit: W })
})

test("an unreadable SOL balance is null, not zero", () => {
  const view = portfolioView({ portfolio: { embedded: [{ address: W, tokens: [] }] }, readAt: 1, prices, agents, buyers: () => [], paper: {} })
  expect(view.wallets[0]!.native).toBeNull()
})

test("a token the portfolio gives no symbol is named from Candle's market read", () => {
  const unnamed = { embedded: [{ chain: "solana", address: W, lamports: "0", tokens: [{ mint: PEPE, amountRaw: "5000000", decimals: 6 }] }] }
  const view = portfolioView({ portfolio: unnamed, readAt: 1_000, prices, agents, buyers: () => [], paper: {}, symbolOf: (m) => (m === PEPE ? "PEPE" : undefined) })
  expect(view.wallets[0]!.tokens![0]).toMatchObject({ mint: PEPE, symbol: "PEPE" })
})

test("names from the portfolio's own prices map, and every held mint", () => {
  const portfolio = {
    embedded: [{ address: W, lamports: "0", tokens: [{ mint: PEPE, amountRaw: "1", decimals: 0 }] }],
    tee: [{ address: "TeeFake1111111111111111111111111111111111111", lamports: "0", tokens: [{ mint: MOON, amountRaw: "1", decimals: 0 }, { mint: PEPE, amountRaw: "1", decimals: 0 }] }],
    prices: { [PEPE]: { priceUsd: 1, symbol: "PEPE\u001b[2J" }, [MOON]: { priceUsd: null, symbol: " " } },
  }
  // Cleaned for the terminal: the escape character never reaches the screen.
  expect(portfolioSymbol(portfolio, PEPE)).toStartWith("PEPE")
  expect(portfolioSymbol(portfolio, PEPE)).not.toContain("\u001b")
  expect(portfolioSymbol(portfolio, MOON)).toBeUndefined()
  expect(portfolioSymbol(undefined, PEPE)).toBeUndefined()
  expect(heldMints(portfolio).sort()).toEqual([MOON, PEPE].sort())
})

test("a TEE wallet names the agent whose key it's bound to, and its active flag; a wallet on no agent's key names none", () => {
  const T = "TeeWallet1111111111111111111111111111111111"
  const portfolio = {
    embedded: [{ chain: "solana", address: W, lamports: "0", tokens: [] }],
    tee: [
      { id: "t1", chain: "solana", address: T, label: "bot", active: false, lamports: "0", tokens: [] },
      { id: "t2", chain: "solana", address: "TeeOther111111111111111111111111111111111111", label: "old", active: true, lamports: "0", tokens: [] },
    ],
  }
  const view = portfolioView({ portfolio, readAt: 1, prices, agents, buyers: () => [], paper: {}, boundTo: (a) => (a === T ? "swing" : undefined) })
  expect(view.wallets.map((w) => [w.kind, w.label ?? "", w.agents, w.active])).toEqual([
    ["embedded", "", ["momentum", "swing"], undefined],
    ["tee", "bot", ["swing"], false],
    ["tee", "old", [], true],
  ])
  expect(view.teeNote).toBeUndefined()
})

test("on Free, the TEE wallets carry the note that they're a Pro or Max feature", () => {
  const view = portfolioView({ portfolio, readAt: 1, prices, agents, buyers: () => [], paper: {}, tier: "free" })
  expect(view.teeNote).toBe("TEE wallets are a Pro or Max feature")
  expect(portfolioView({ portfolio, readAt: 1, prices, agents, buyers: () => [], paper: {}, tier: "max" }).teeNote).toBeUndefined()
})

test("a stopped TEE wallet carries its balance read on chain, priced; one Candle stopped listing is marked; an unread one says why", () => {
  const A = "StopA111111111111111111111111111111111111111"
  const B = "StopB222222222222222222222222222222222222222"
  const view = portfolioView({
    portfolio,
    readAt: 1_000,
    prices,
    agents,
    buyers: () => [],
    paper: {},
    stopped: [{ address: A, label: "desk", agent: "momentum", outside: true }, { address: B }],
    stoppedBalance: (address) => (address === A ? { lamports: 500_000_000n, tokens: 1, readAt: 900 } : { error: "rpc.example: rate limited", readAt: 900 }),
  })
  expect(view.wallets.find((w) => w.address === A)).toMatchObject({ stopped: true, stoppedOutside: true, nativeSymbol: "SOL", native: { amount: 0.5, usd: 75 }, heldTokens: 1, agents: ["momentum"] })
  const b = view.wallets.find((w) => w.address === B)!
  expect(b).toMatchObject({ stopped: true, nativeSymbol: "SOL", native: null, balanceError: "rpc.example: rate limited" })
  expect(b.stoppedOutside).toBeUndefined()
})

test("a stopped wallet's balance error is made safe for the terminal; a SOL read with no token read keeps the SOL", () => {
  const A = "StopA111111111111111111111111111111111111111"
  const B = "StopB222222222222222222222222222222222222222"
  const view = portfolioView({
    portfolio,
    readAt: 1_000,
    prices,
    agents,
    buyers: () => [],
    paper: {},
    stopped: [{ address: A }, { address: B }],
    stoppedBalance: (address) =>
      address === A ? { error: "rpc.example: \u001b]0;owned\u0007\u001b[31mrate limited", readAt: 900 } : { lamports: 500_000_000n, tokens: null, tokensError: "rpc.example: HTTP 429", readAt: 900 },
  })
  const a = view.wallets.find((w) => w.address === A)!
  expect(a.balanceError).toContain("rate limited")
  expect(a.balanceError).not.toContain("\u001b")
  expect(a.balanceError).not.toContain("\u0007")
  const b = view.wallets.find((w) => w.address === B)!
  expect(b).toMatchObject({ nativeSymbol: "SOL", native: { amount: 0.5, usd: 75 }, balanceError: "rpc.example: HTTP 429" })
  expect(b.heldTokens).toBeUndefined()
})

// Hood's wallets, as Candle lists them under `hood` (routes/agent.ts): wei, and tokens keyed `hood:<lowercase>` in prices.
const EVM = "0xAbCdEf0000000000000000000000000000000001"
const HOOD_TEE = "0xAbCdEf0000000000000000000000000000000002"
const KITE = "0x1F8e3bD8000000000000000000000000000000Aa"
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
const hoodPrices = { usd: (k: string | undefined) => ({ [SOL]: 150, "hood:native": 3300, [`hood:${KITE.toLowerCase()}`]: 0.004 })[k ?? ""] }
const withHood = (tee: Record<string, unknown>, embedded: Record<string, unknown> = {}) => ({
  ...portfolio,
  hood: {
    embedded: [{ address: EVM, chain: "hood", wei: "50000000000000000", tokens: [{ chain: "hood", mint: KITE, amountRaw: "2150000000000000000000", decimals: 18, symbol: "KITE" }], ...embedded }],
    tee: [{ id: "h1", address: HOOD_TEE, label: "bot-1-h", active: true, chain: "hood", wei: "2000000000000000", tokens: [], ...tee }],
    unavailable: [],
  },
})

test("a Hood TEE wallet is drawn as Hood with its ETH balance, and the embedded EVM wallet with the agents allowed on it", () => {
  const view = portfolioView({ portfolio: withHood({}), readAt: 1, prices: hoodPrices, agents: agents.map((a) => ({ ...a, evmWallet: EVM.toLowerCase() })), buyers: () => [], paper: {}, boundTo: (a) => (a === HOOD_TEE ? "momentum" : undefined) })
  const tee = view.wallets.find((w) => w.address === HOOD_TEE)!
  expect(tee).toMatchObject({ chain: "hood", kind: "tee", nativeSymbol: "ETH", native: { amount: 0.002 }, agents: ["momentum"], active: true })
  expect(tee.native!.usd).toBeCloseTo(6.6)
  const evm = view.wallets.find((w) => w.address === EVM)!
  expect(evm).toMatchObject({ chain: "hood", kind: "embedded", name: "embedded", nativeSymbol: "ETH", agents: ["momentum", "swing"] })
  expect(evm.native!.usd).toBeCloseTo(165)
  // A Hood token is priced under its `hood:` key, never as SOL.
  expect(evm.tokens).toMatchObject([{ mint: KITE, symbol: "KITE", amount: 2150, buyers: [] }])
  expect(evm.tokens![0]!.usd).toBeCloseTo(8.6)
  // Solana's wallets are as they were, first.
  expect(view.wallets.map((w) => w.chain)).toEqual(["solana", "solana", "hood", "hood"])
  expect(view.wallets[0]).toMatchObject({ nativeSymbol: "SOL", native: { amount: 2, usd: 300 } })
})

test("a Hood TEE wallet holding tokens and no ETH needs ETH to trade; one with ETH, or empty, doesn't", () => {
  const held = [{ chain: "hood", mint: USDG, amountRaw: "5000000", decimals: 6, symbol: "USDG" }]
  const at = (tee: Record<string, unknown>) => portfolioView({ portfolio: withHood(tee), readAt: 1, prices: hoodPrices, agents, buyers: () => [], paper: {} }).wallets.find((w) => w.address === HOOD_TEE)!
  expect(at({ wei: "0", tokens: held }).needsNative).toBe(true)
  expect(at({ wei: "1000", tokens: held }).needsNative).toBeUndefined()
  expect(at({ wei: "0", tokens: [] }).needsNative).toBeUndefined()
  // An unread balance isn't said to be empty.
  expect(at({ wei: null, tokens: held }).needsNative).toBeUndefined()
  // The embedded wallet's gas isn't the TEE route's: no note there.
  const embedded = portfolioView({ portfolio: withHood({}, { wei: "0", tokens: held }), readAt: 1, prices: hoodPrices, agents, buyers: () => [], paper: {} }).wallets.find((w) => w.address === EVM)!
  expect(embedded.needsNative).toBeUndefined()
})

test("an account whose only Hood wallet is the empty embedded one sees its wallets as before", () => {
  const empty = { ...portfolio, hood: { embedded: [{ address: EVM, chain: "hood", wei: "0", tokens: [] }], tee: [], unavailable: [] } }
  const view = portfolioView({ portfolio: empty, readAt: 1, prices, agents, buyers: () => [], paper: {} })
  expect(view.wallets.map((w) => w.address)).toEqual([W, "TeeWallet1111111111111111111111111111111111"])
})

test("a stopped Hood TEE wallet is Hood's, in ETH, and the account uses Hood while it's there", () => {
  const view = portfolioView({ portfolio, readAt: 1, prices: hoodPrices, agents, buyers: () => [], paper: {}, stopped: [{ address: HOOD_TEE, label: "bot-1-h" }] })
  expect(view.wallets.find((w) => w.address === HOOD_TEE)).toMatchObject({ chain: "hood", nativeSymbol: "ETH", stopped: true, native: null })
  expect(view.chains).toEqual(["solana", "hood"])
})

test("an embedded Hood wallet Candle couldn't read: no Hood for a Solana-only account; a known Hood account keeps it, unread", () => {
  const unread = { ...portfolio, hood: { embedded: [{ address: EVM, chain: "hood", wei: null, tokens: null }], tee: [], unavailable: [EVM] } }
  const plain = portfolioView({ portfolio: unread, readAt: 1, prices: hoodPrices, agents, buyers: () => [], paper: {} })
  expect(plain.chains).toEqual(["solana"])
  expect(plain.wallets.map((w) => w.chain)).toEqual(["solana", "solana"])
  const known = portfolioView({ portfolio: unread, readAt: 1, prices: hoodPrices, agents, buyers: () => [], paper: {}, chains: ["solana", "hood"] })
  expect(known.chains).toEqual(["solana", "hood"])
  expect(known.wallets.find((w) => w.address === EVM)).toMatchObject({ chain: "hood", native: null, tokens: null })
})
